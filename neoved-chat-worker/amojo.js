/**
 * Чаты amoCRM (amojo) — переписка в карточке вместо примечаний.
 *
 * Канал регистрирует поддержка amoCRM и присылает channel_id и secret_key,
 * подключение к аккаунту делает amojo-connect.mjs и возвращает scope_id.
 * Дальше всё общение идёт сюда: https://amojo.amocrm.ru
 *
 * Порядок важен. Если отправить сообщение в чат, не привязанный к контакту,
 * amoCRM заведёт своё «Неразобранное» и собственный контакт — проверено
 * 09.09.2026, чат прилип к чужой карточке, и перепривязать его уже нельзя
 * («Chat already linked to another entity»). Поэтому сначала наша логика
 * (контакт и сделка), затем чат, привязка и только потом сообщения.
 *
 * Каждый запрос подписывается: строка из метода, MD5 тела, Content-Type, даты
 * и пути шифруется HMAC-SHA1 на секрете канала, подпись живёт 15 минут.
 * https://www.amocrm.ru/developers/content/chats/chat-start
 */

const AMOJO = 'https://amojo.amocrm.ru';

/** Настроен ли канал: без ключей воркер продолжает работать на примечаниях. */
export const chatsEnabled = (env) => Boolean(env.SCOPE_ID && env.CHANNEL_SECRET);

/**
 * Чат клиента. Один контакт — один чат, поэтому conversation_id собирается из
 * id контакта: переписка не рвётся между обращениями.
 */
export async function ensureChat(contactId, person, env) {
  const known = await env.S.get(`chat:${contactId}`);
  if (known) return known;

  const created = await call('POST', `/v2/origin/custom/${env.SCOPE_ID}/chats`, {
    conversation_id: `contact-${contactId}`,
    user: {
      id: `contact-${contactId}`,
      name: person.name || `Клиент ${contactId}`,
      profile: {
        ...(person.email ? { email: person.email } : {}),
        ...(person.phone ? { phone: person.phone } : {}),
      },
    },
  }, env);

  const chatId = created?.id;
  if (!chatId) throw new Error(`amojo не вернул id чата: ${JSON.stringify(created).slice(0, 200)}`);

  // Привязка к контакту — то, что удерживает переписку в нужной карточке.
  const link = await fetch(`https://${env.AMO_SUBDOMAIN}.amocrm.ru/api/v4/contacts/chats`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AMO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ contact_id: Number(contactId), chat_id: chatId }]),
  });
  if (!link.ok) {
    const text = await link.text();
    // Повторная привязка того же чата к тому же контакту безобидна.
    if (!text.includes('AlreadyExists')) {
      throw new Error(`привязка чата к контакту ${contactId} → ${link.status}: ${text.slice(0, 200)}`);
    }
  }

  await env.S.put(`chat:${contactId}`, chatId, { expirationTtl: 60 * 60 * 24 * 365 });
  return chatId;
}

/** Сообщение клиента → в чат карточки. */
export async function sendFromClient(contactId, person, text, env) {
  return call('POST', `/v2/origin/custom/${env.SCOPE_ID}`, {
    event_type: 'new_message',
    payload: {
      timestamp: Math.floor(Date.now() / 1000),
      msec_timestamp: Date.now(),
      msgid: crypto.randomUUID(),
      conversation_id: `contact-${contactId}`,
      sender: {
        id: `contact-${contactId}`,
        name: person.name || `Клиент ${contactId}`,
        profile: {
          ...(person.email ? { email: person.email } : {}),
          ...(person.phone ? { phone: person.phone } : {}),
        },
      },
      message: { type: 'text', text },
      silent: false,
    },
  }, env);
}

/**
 * Разбирает вебхук amoCRM: менеджер ответил в чате карточки.
 * Возвращает { conversationId, text, msgid } или null, если это не сообщение
 * от менеджера (amojo шлёт сюда же статусы доставки и служебные события).
 */
export function parseWebhook(body) {
  const message = body?.message?.message || body?.message;
  if (!message || body?.event_type === 'delivery_status') return null;

  const text = String(message.text || '').trim();
  const conversationId = String(
    message.conversation_id || body?.message?.conversation?.client_id || '',
  );
  if (!text || !conversationId) return null;

  return { conversationId, text, msgid: message.id || message.msgid || null };
}

/** Общий вызов к amojo с подписью. */
async function call(method, path, payload, env) {
  const body = JSON.stringify(payload);
  const contentType = 'application/json';
  const date = rfc2822(new Date());
  const md5 = await md5hex(body);
  const signature = await hmacSha1Hex(
    [method.toUpperCase(), md5, contentType, date, path].join('\n'),
    env.CHANNEL_SECRET,
  );

  const res = await fetch(AMOJO + path, {
    method,
    headers: {
      Date: date,
      'Content-Type': contentType,
      'Content-MD5': md5,
      'X-Signature': signature,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`amojo ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * MD5 нет в WebCrypto, поэтому считаем вручную — реализация короткая и от
 * платформы не зависит: воркер живёт и в Cloudflare, и в Node на сервере.
 */
async function md5hex(input) {
  const bytes = new TextEncoder().encode(input);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const len = bytes.length;
  const withPadding = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  withPadding.set(bytes);
  withPadding[len] = 0x80;
  new DataView(withPadding.buffer).setUint32(withPadding.length - 8, len << 3, true);

  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const view = new DataView(withPadding.buffer);

  for (let chunk = 0; chunk < withPadding.length; chunk += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(chunk + i * 4, true);

    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  return [a0, b0, c0, d0].map((n) => {
    let hex = '';
    for (let i = 0; i < 4; i++) hex += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return hex;
  }).join('');
}

async function hmacSha1Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** «Tue, 09 Sep 2026 12:00:00 +0000» — формат из примеров документации. */
function rfc2822(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}
