/**
 * Подключает канал чатов amoCRM (amojo) к аккаунту и печатает scope_id.
 *
 * Канал регистрирует поддержка amoCRM и присылает channel_id и secret_key;
 * подключение к конкретному аккаунту делается уже самостоятельно — этим
 * запросом. В ответ приходит scope_id вида «<channel_id>_<amojo_id>»: именно он
 * подставляется в адрес вебхука и в отправку сообщений.
 *
 * Все запросы к amojo подписываются: строка из метода, MD5 тела, Content-Type,
 * даты и пути шифруется HMAC-SHA1 на секрете канала. Подпись живёт 15 минут.
 * https://www.amocrm.ru/developers/content/chats/chat-start
 *
 * Запуск: node amojo-connect.mjs
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AMOJO = 'https://amojo.amocrm.ru';

const raw = await readFile(join(HERE, '.env'), 'utf8');
const cfg = Object.fromEntries(raw.split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

for (const key of ['CHANNEL_ID', 'CHANNEL_SECRET', 'AMOJO_ID']) {
  if (!cfg[key]) {
    console.error(`В .env не заполнен ${key}`);
    process.exit(1);
  }
}

const path = `/v2/origin/custom/${cfg.CHANNEL_ID}/connect`;
const body = JSON.stringify({
  account_id: cfg.AMOJO_ID,
  title: cfg.CHANNEL_TITLE || 'neoved чат',
  hook_api_version: 'v2',
});

const res = await fetch(AMOJO + path, {
  method: 'POST',
  headers: sign('POST', path, body, cfg.CHANNEL_SECRET),
  body,
});

const text = await res.text();
console.log('HTTP', res.status);
console.log(text);

if (res.ok) {
  try {
    const data = JSON.parse(text);
    if (data.scope_id) {
      console.log('\nscope_id:', data.scope_id);
      console.log('Впиши его в .env как SCOPE_ID и укажи в вебхуке канала.');
    }
  } catch { /* ответ не JSON — печатать нечего, он уже выведен выше */ }
}

/** Заголовки с подписью запроса к amojo. */
function sign(method, urlPath, payload, secret) {
  const contentType = 'application/json';
  const date = rfc2822(new Date());
  const contentMd5 = createHash('md5').update(payload).digest('hex').toLowerCase();

  const str = [method.toUpperCase(), contentMd5, contentType, date, urlPath].join('\n');
  const signature = createHmac('sha1', secret).update(str).digest('hex').toLowerCase();

  return {
    Date: date,
    'Content-Type': contentType,
    'Content-MD5': contentMd5,
    'X-Signature': signature,
  };
}

/** «Tue, 09 Sep 2026 12:00:00 +0000» — формат из примеров документации. */
function rfc2822(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}
