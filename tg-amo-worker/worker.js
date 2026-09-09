/**
 * tg-amo-worker — тащит прямые сообщения Telegram-канала (Direct Messages)
 * в amoCRM.
 *
 * Как это работает:
 *   Подписчик пишет каналу через «Прямые сообщения» → Telegram кладёт сообщение
 *   в монофорум-супергруппу канала → бот-админ получает вебхук `message` →
 *   воркер находит контакт по Telegram ID и либо двигает его сделку на
 *   «Новую заявку», либо заводит новую сделку с контактом. В обоих случаях
 *   вешает тег и пишет текст сообщения примечанием.
 *
 * Почему автора берём из direct_messages_topic.user, а не из from:
 *   Bot API 9.2 (15.08.2025) добавил класс DirectMessagesTopic с полем `user` —
 *   «Information about the user that created the topic. Currently, it is always
 *   present». Каждый топик монофорума привязан ровно к одному пользователю
 *   (core.telegram.org/api/monoforum), так что это и есть автор обращения.
 *   MTProto-метод channels.getMessageAuthor ботам недоступен («users only, not
 *   bots»), но он и не нужен.
 *
 * Секреты (задаются при деплое):
 *   BOT_TOKEN       — токен бота, он же админ канала
 *   AMO_SUBDOMAIN   — поддомен аккаунта amoCRM без .amocrm.ru
 *   AMO_TOKEN       — долгосрочный токен интеграции amoCRM
 *   WEBHOOK_SECRET  — произвольная строка: часть URL вебхука и secret_token
 * Переменные — см. DEFAULTS ниже.
 * KV binding: S (дедупликация update_id + отладочный лог).
 */

import { chatsEnabled, ensureChat, sendFromClient } from './amojo.js';

const DEFAULTS = {
  // Поле контакта «Telegram ID» — по нему сверяем, знаком ли нам автор.
  TG_ID_FIELD: '996479',
  // Куда писать ник. В аккаунте таких полей четыре, пишем в это.
  TG_USERNAME_FIELD: '996481',
  // По этим полям дополнительно ищем контакт, если Telegram ID ещё не проставлен:
  // 977339 и 996481 «Telegram username», 997749 «Telegram логин», 999219 «Telegram».
  TG_USERNAME_LOOKUP: '977339,996481,997749,999219',
  // Куда падает сделка, если контакта в amoCRM ещё нет.
  DEFAULT_PIPELINE_ID: '9018718',   // «Продажи клиентам»
  DEFAULT_STATUS_ID: '72669522',    // «Новая заявка»
  // Название этапа, на который двигаем уже существующую сделку. Ищется внутри
  // её собственной воронки — сделка не переезжает между воронками.
  NEW_STATUS_NAME: 'Новая заявка',
  TAG_NAME: 'telegram_channel',
  LEAD_NAME_PREFIX: 'telegram channel',
  // Пусто — принимаем любой монофорум, куда добавлен бот. Иначе список ID через запятую.
  ALLOWED_CHAT_IDS: '',
  // Искать контакт по нику, если по Telegram ID не нашёлся.
  MATCH_BY_USERNAME: 'true',

  // ── ответы клиенту ──
  // Пусто — клиенту уходит ЛЮБОЕ обычное примечание, написанное человеком
  // (свои примечания воркер узнаёт и обратно не шлёт). Если поставить сюда,
  // например, «+», уходить будут только примечания, начатые с этого знака,
  // а остальные останутся внутренними.
  REPLY_PREFIX: '',
  // Ответ, отправленный менеджером вручную из Telegram, записывать в сделку.
  MANUAL_REPLY_NOTE: 'true',
  // Пометка в начале примечания для исходящих — чтобы в ленте было видно,
  // где реплика клиента, а где ответ ему.
  OUTGOING_NOTE_PREFIX: 'Ответ: ',
};

// note_type обычного примечания в вебхуке приходит числом.
const COMMON_NOTE_TYPE = '4';

// Успех и отказ — эти ID одинаковы во всех воронках amoCRM.
const CLOSED_STATUS_IDS = new Set([142, 143]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = { ...DEFAULTS, ...pick(env, Object.keys(DEFAULTS)) };
    const secret = env.WEBHOOK_SECRET || '';

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'tg-amo-worker' });
    }

    // Последние решения воркера — чтобы видеть, что прилетело и что с этим стало.
    if (secret && url.pathname === `/debug/${secret}`) {
      const log = await readLog(env);
      return json({ ok: true, count: log.length, log });
    }

    if (request.method !== 'POST') {
      return new Response('tg-amo-worker', { status: 200 });
    }

    // Ответ менеджера из переписки карточки. Вебхук чатов приходит на
    // neoved-chat — канал у аккаунта один, адрес тоже, — и тот пересылает сюда
    // всё, что адресовано Telegram.
    if (secret && url.pathname === `/chat-reply/${secret}`) {
      const body = await request.json().catch(() => null);
      ctx.waitUntil(
        onChatReply(body, env).catch(async (e) => {
          console.error('onChatReply failed', e);
          await writeLog(env, { verdict: 'ошибка доставки ответа из чата', error: String(e).slice(0, 400) });
        }),
      );
      return json({ ok: true });
    }

    // Вебхук amoCRM: примечание в сделке → сообщение клиенту в Telegram.
    // amoCRM ретраит хук, если не ответить быстро, — разбор уходит в фон.
    if (secret && url.pathname === `/amo/${secret}`) {
      const raw = await request.text();
      ctx.waitUntil(
        handleAmoHook(raw, env, cfg).catch(async (e) => {
          console.error('handleAmoHook failed', e);
          await writeLog(env, { verdict: 'ошибка amo-хука', error: String(e).slice(0, 400) });
        }),
      );
      return json({ ok: true });
    }

    // Секрет и в пути, и в заголовке: setWebhook умеет слать secret_token.
    const header = request.headers.get('x-telegram-bot-api-secret-token');
    if (secret && url.pathname !== `/tg/${secret}` && header !== secret) {
      return new Response('not found', { status: 404 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: true, skip: 'не JSON' });
    }

    // Telegram ретраит апдейт, если не ответить быстро, — разбор уходит в фон.
    ctx.waitUntil(
      handleUpdate(update, env, cfg).catch(async (e) => {
        console.error('handleUpdate failed', e);
        await writeLog(env, { verdict: 'ошибка', error: String(e).slice(0, 400) });
      }),
    );
    return json({ ok: true });
  },
};

async function handleUpdate(update, env, cfg) {
  const msg = update.message || update.edited_message;
  const topic = msg?.direct_messages_topic;
  const author = topic?.user;

  // Всё, что не прямое сообщение каналу, воркеру неинтересно: посты, служебные
  // апдейты, обычные группы. Пишем в лог — так видно, что бот вообще получает.
  if (!msg) return log(env, { verdict: 'скип: в апдейте нет message', keys: Object.keys(update) });
  if (!topic) {
    return log(env, {
      verdict: 'скип: не прямое сообщение каналу',
      chat_id: msg.chat?.id,
      chat_type: msg.chat?.type,
      is_direct_messages: msg.chat?.is_direct_messages ?? null,
    });
  }
  if (!author) return log(env, { verdict: 'скип: в топике нет автора', chat_id: msg.chat?.id });

  // Ответ менеджера уходит от имени канала. Раньше он просто отбрасывался,
  // теперь попадает в сделку примечанием — чтобы в CRM была вся переписка,
  // даже если отвечали руками из Telegram, минуя карточку.
  if (msg.sender_chat) return onManagerReply(msg, topic, env, cfg);
  if (!msg.from || msg.from.id !== author.id) {
    return log(env, { verdict: 'скип: пишет не владелец топика', from: msg.from?.id, topic_user: author.id });
  }
  if (msg.from.is_bot) return log(env, { verdict: 'скип: автор — бот', from: msg.from.id });

  const allowed = list(cfg.ALLOWED_CHAT_IDS);
  if (allowed.length && !allowed.includes(String(msg.chat?.id))) {
    return log(env, { verdict: 'скип: чат не в ALLOWED_CHAT_IDS', chat_id: msg.chat?.id });
  }

  // Один и тот же update_id прилетает повторно, если Telegram не дождался 200.
  if (update.update_id != null && env.S) {
    const key = `upd:${update.update_id}`;
    if (await env.S.get(key)) {
      return log(env, { verdict: 'скип: дубль update_id', update_id: update.update_id });
    }
    await env.S.put(key, '1', { expirationTtl: 86400 });
  }

  const text = messageText(msg);
  const person = {
    tgId: String(author.id),
    username: author.username ? String(author.username).replace(/^@/, '') : '',
    name: [author.first_name, author.last_name].filter(Boolean).join(' ').trim(),
  };
  // Обратный адрес: чтобы ответить, нужны chat_id монофорума и topic_id ветки
  // этого клиента — у каждого написавшего она своя.
  const route = { chat_id: msg.chat?.id, topic_id: topic.topic_id, tg_id: person.tgId };

  const result = await syncToAmo(person, text, env, cfg);

  // Три индекса: по сделке — куда отвечать, по ветке — в какую сделку писать
  // ручной ответ менеджера, по контакту — куда доставить ответ из переписки
  // карточки (вебхук чатов знает только контакт).
  if (result.leadId && env.S) {
    await env.S.put(`lead:${result.leadId}`, JSON.stringify(route));
    await env.S.put(`route:${route.chat_id}:${route.topic_id}`, String(result.leadId));
  }
  if (result.contactId && env.S) {
    await env.S.put(`contact:${result.contactId}`, JSON.stringify(route));
  }
  await log(env, {
    verdict: result.verdict, chat_id: route.chat_id, topic_id: route.topic_id,
    tg: person, lead_id: result.leadId, text: text.slice(0, 200),
  });
}

/**
 * Находим контакт → двигаем его сделку либо заводим новую.
 * В примечание кладём голый текст сообщения: кто написал, и так видно
 * в карточке контакта — Telegram ID и ник туда проставляются.
 */
async function syncToAmo(person, text, env, cfg) {
  const contact = await findContact(person, env, cfg);

  if (!contact) {
    const created = await createLeadWithContact(person, env, cfg);
    await deliverToManager(created.contactId, person, text, env, created.leadId);
    return { verdict: 'создана сделка с новым контактом', leadId: created.leadId, contactId: created.contactId };
  }

  // Telegram ID мог быть пустым — контакт нашёлся по нику. Проставим, чтобы
  // следующее сообщение матчилось сразу по ID.
  if (!hasField(contact, cfg.TG_ID_FIELD)) {
    await amo(`/api/v4/contacts/${contact.id}`, env, {
      method: 'PATCH',
      body: { custom_fields_values: [field(cfg.TG_ID_FIELD, person.tgId)] },
    });
  }

  const lead = await findOpenLead(contact, env);
  if (!lead) {
    const leadId = await createLead(person, contact.id, env, cfg);
    await deliverToManager(contact.id, person, text, env, leadId);
    return { verdict: 'контакт был, открытых сделок не было — создана новая', leadId, contactId: contact.id };
  }

  const statusId = await resolveNewStatus(lead.pipeline_id, env, cfg);
  // tags_to_add дописывает тег, не затирая уже висящие на сделке.
  const body = { tags_to_add: [{ name: cfg.TAG_NAME }] };
  if (statusId && lead.status_id !== statusId) {
    body.status_id = statusId;
    body.pipeline_id = lead.pipeline_id;
  }
  await amo(`/api/v4/leads/${lead.id}`, env, { method: 'PATCH', body });
  await deliverToManager(contact.id, person, text, env, lead.id);

  return {
    verdict: statusId
      ? `сделка ${lead.id} → «${cfg.NEW_STATUS_NAME}» + тег`
      : `сделка ${lead.id}: этап «${cfg.NEW_STATUS_NAME}» в воронке не найден, поставлен только тег`,
    leadId: lead.id,
    contactId: contact.id,
  };
}

/**
 * Сообщение подписчика менеджеру. Пока канал чатов настроен — оно уходит в
 * переписку карточки и выглядит там пузырём, как сообщения с сайта; без канала
 * (или если amojo ответил ошибкой) остаётся прежний путь — примечание.
 * Терять сообщение из-за сбоя чата нельзя, поэтому примечание работает
 * запасным вариантом, а не заменой.
 */
async function deliverToManager(contactId, person, text, env, leadId) {
  if (chatsEnabled(env) && contactId) {
    try {
      await ensureChat(contactId, chatProfile(person), env, 'tg');
      await sendFromClient(contactId, chatProfile(person), text, env, 'tg');
      // Метка «по этой сделке переписка идёт чатом»: без неё нельзя отличить
      // сделку с живым чатом от старой, где менеджер отвечает примечанием.
      if (leadId && env.S) await env.S.put(`chatlead:${leadId}`, '1', { expirationTtl: 60 * 60 * 24 * 90 });
      return;
    } catch (e) {
      console.error('чат amoCRM не принял сообщение', e);
      await log(env, { verdict: 'чат недоступен, ушло примечанием', error: String(e).slice(0, 300) });
    }
  }
  await addNote(leadId, text, env);
}

/** Как подписчик выглядит в переписке карточки. */
function chatProfile(person) {
  return {
    name: person.name || (person.username ? `@${person.username}` : `TG ${person.tgId}`),
  };
}

/**
 * Сначала по Telegram ID, затем — по нику во всех «телеграмных» полях.
 *
 * Ищем через ?query=, а не через filter[custom_fields_values][...]: этот
 * аккаунт фильтр по дополнительным полям не принимает — проверено 17.08.2026,
 * обе формы записи отдают 400 «Invalid filter for current account».
 * query помечен в документации как «в ближайшее время будет признан
 * устаревшим», так что если однажды отвалится — смотреть в эту сторону.
 *
 * query ищет подстроку по всем заполненным полям, поэтому совпадение
 * обязательно перепроверяется по нужному полю: иначе Telegram ID мог бы
 * совпасть с куском телефона чужого контакта.
 */
async function findContact(person, env, cfg) {
  const byId = (await queryContacts(person.tgId, env))
    .find((c) => fieldValues(c, cfg.TG_ID_FIELD).includes(person.tgId));
  if (byId) return byId;

  if (cfg.MATCH_BY_USERNAME !== 'true' || !person.username) return null;

  const lookup = list(cfg.TG_USERNAME_LOOKUP);
  const nick = person.username.toLowerCase();
  return (await queryContacts(person.username, env))
    .find((c) => lookup.some((id) => fieldValues(c, id).some((v) => nickOf(v) === nick))) || null;
}

async function queryContacts(value, env) {
  const q = String(value || '').trim();
  if (q.length < 3) return [];
  const res = await amo(`/api/v4/contacts?limit=50&with=leads&query=${encodeURIComponent(q)}`, env);
  return res?._embedded?.contacts || [];      // ничего не нашлось → 204 → null
}

/** Значения одного поля контакта, пустые отброшены. */
function fieldValues(contact, fieldId) {
  const f = (contact.custom_fields_values || []).find((x) => String(x.field_id) === String(fieldId));
  return (f?.values || []).map((v) => String(v.value ?? '').trim()).filter(Boolean);
}

/** «https://t.me/ivanov», «@ivanov», «ivanov» → «ivanov» */
const nickOf = (v) => String(v).trim().toLowerCase()
  .replace(/^https?:\/\/(t\.me|telegram\.me)\//, '')
  .replace(/^@/, '')
  .replace(/\/+$/, '');

/** Последняя сделка контакта, которая ещё не в «Успешно»/«Отказ». */
async function findOpenLead(contact, env) {
  const ids = (contact._embedded?.leads || []).map((l) => l.id).filter(Boolean);
  if (!ids.length) return null;

  const query = ids.slice(-50).map((id) => `filter[id][]=${id}`).join('&');
  const res = await amo(`/api/v4/leads?limit=50&${query}`, env);
  const leads = res?._embedded?.leads || [];

  const open = leads.filter((l) => !CLOSED_STATUS_IDS.has(Number(l.status_id)));
  if (!open.length) return null;
  open.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
  return open[open.length - 1];
}

/**
 * ID этапа «Новая заявка» внутри той же воронки, где лежит сделка, — чтобы
 * не перетаскивать её между воронками. Карта воронок кешируется на 10 минут.
 */
let pipelinesCache = { at: 0, map: null };
async function resolveNewStatus(pipelineId, env, cfg) {
  if (!pipelineId) return null;
  const fresh = Date.now() - pipelinesCache.at < 600_000;
  if (!fresh || !pipelinesCache.map) {
    const res = await amo('/api/v4/leads/pipelines', env);
    const map = {};
    for (const p of res?._embedded?.pipelines || []) {
      map[p.id] = {};
      for (const s of p._embedded?.statuses || []) map[p.id][norm(s.name)] = s.id;
    }
    pipelinesCache = { at: Date.now(), map };
  }
  return pipelinesCache.map?.[pipelineId]?.[norm(cfg.NEW_STATUS_NAME)] || null;
}

async function createLeadWithContact(person, env, cfg) {
  const fields = [field(cfg.TG_ID_FIELD, person.tgId)];
  if (person.username) fields.push(field(cfg.TG_USERNAME_FIELD, `@${person.username}`));

  const body = [{
    name: leadName(person, cfg),
    pipeline_id: Number(cfg.DEFAULT_PIPELINE_ID),
    status_id: Number(cfg.DEFAULT_STATUS_ID),
    tags_to_add: [{ name: cfg.TAG_NAME }],
    _embedded: {
      contacts: [{
        name: person.name || (person.username ? `@${person.username}` : `TG ${person.tgId}`),
        custom_fields_values: fields,
      }],
    },
  }];
  // complex прогоняет контакт через контроль дублей и возвращает id сделки
  // и id контакта прямо в объекте ответа: [{ id, contact_id, … }].
  const res = await amo('/api/v4/leads/complex', env, { method: 'POST', body });
  return { leadId: res?.[0]?.id, contactId: res?.[0]?.contact_id || null };
}

async function createLead(person, contactId, env, cfg) {
  const body = [{
    name: leadName(person, cfg),
    pipeline_id: Number(cfg.DEFAULT_PIPELINE_ID),
    status_id: Number(cfg.DEFAULT_STATUS_ID),
    tags_to_add: [{ name: cfg.TAG_NAME }],
    _embedded: { contacts: [{ id: contactId }] },
  }];
  const res = await amo('/api/v4/leads', env, { method: 'POST', body });
  return res?._embedded?.leads?.[0]?.id;
}

/**
 * Пишет примечание и запоминает его id: на каждое примечание amoCRM пришлёт
 * вебхук, и без этой метки воркер отправил бы клиенту его же собственное
 * сообщение — переписка зациклилась бы.
 */
async function addNote(leadId, text, env) {
  if (!leadId) return null;
  const res = await amo(`/api/v4/leads/${leadId}/notes`, env, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text } }],
  });
  const noteId = res?._embedded?.notes?.[0]?.id;
  if (noteId && env.S) await env.S.put(`note:${noteId}`, '1', { expirationTtl: 86400 });
  return noteId;
}

// ─────────────────── ответ клиенту: amoCRM → Telegram ───────────────────

/**
 * Вебхук amoCRM о добавлении примечания (событие note_lead).
 *
 * Формат в документации не описан; ключи сняты с живого хука 17.08.2026 —
 * `leads[note][0][note][…]` с полями id, element_id, element_type, note_type
 * (числом: 4 — обычное), text. То же самое разбирает соседний amo-phone-worker.
 */
async function handleAmoHook(raw, env, cfg) {
  const params = new URLSearchParams(raw);
  const root = parseNested(params);

  const notes = [];
  for (const bucket of [root.leads?.note, root.notes?.add, root.note?.add]) {
    for (const item of values(bucket)) {
      const note = item?.note || item;
      if (note && typeof note === 'object') notes.push(note);
    }
  }
  if (!notes.length) {
    return log(env, { verdict: 'скип: в хуке amo нет примечаний', keys: [...params.keys()].slice(0, 30) });
  }
  for (const note of notes) await onAmoNote(note, env, cfg);
}

async function onAmoNote(note, env, cfg) {
  const noteId = String(note.id ?? '');
  const leadId = String(note.element_id ?? '');
  const type = String(note.note_type ?? '');

  // Звонки, системные сообщения и прочее клиенту не пересылаем.
  if (type !== COMMON_NOTE_TYPE) {
    return log(env, { verdict: `скип: примечание типа ${type || '?'}, не обычное`, note_id: noteId });
  }
  // Своё же примечание — иначе входящее сообщение улетело бы обратно клиенту.
  if (noteId && env.S && await env.S.get(`note:${noteId}`)) {
    return log(env, { verdict: 'скип: примечание создано воркером', note_id: noteId });
  }

  let text = String(note.text ?? '').trim();
  if (cfg.REPLY_PREFIX) {
    if (!text.startsWith(cfg.REPLY_PREFIX)) {
      return log(env, { verdict: `скип: примечание без префикса «${cfg.REPLY_PREFIX}»`, note_id: noteId });
    }
    text = text.slice(cfg.REPLY_PREFIX.length).trim();
  }
  if (!text) return log(env, { verdict: 'скип: пустой текст примечания', note_id: noteId });

  // Реплика в переписке карточки порождает и примечание — если пропустить его
  // дальше, подписчик получит ответ дважды. Но только для сделок, где чат
  // действительно ведётся: в старых переписках менеджер отвечает примечанием,
  // и оно остаётся единственным способом до него достучаться.
  if (chatsEnabled(env) && env.S && await env.S.get(`chatlead:${leadId}`)) {
    return log(env, { verdict: 'скип: ответ уже ушёл через чат', lead_id: leadId, note_id: noteId });
  }

  const route = await routeByLead(leadId, env);
  if (!route) {
    return log(env, {
      verdict: 'скип: неизвестно, куда отвечать — клиент не писал в канал после запуска воркера',
      lead_id: leadId, note_id: noteId,
    });
  }

  const sent = await sendToTelegram(route, text, env);
  await log(env, {
    verdict: `ответ отправлен клиенту (сделка ${leadId})`,
    lead_id: leadId, note_id: noteId, message_id: sent?.message_id, text: text.slice(0, 200),
  });
}

/**
 * Ответ, написанный менеджером в переписке карточки: neoved-chat переслал его
 * сюда, а мы знаем, в какую ветку монофорума писать этому контакту.
 */
async function onChatReply(body, env) {
  const contactId = String(body?.contact_id ?? '').trim();
  const author = String(body?.author ?? '').trim();
  let text = String(body?.text ?? '').trim();
  if (!contactId || !text) return;

  // Подписываем ответ именем менеджера из amoCRM: в Telegram нет отдельного
  // поля автора, поэтому имя идёт первой строкой сообщения.
  if (author) text = `${author}:\n${text}`;

  const raw = env.S ? await env.S.get(`contact:${contactId}`) : null;
  if (!raw) {
    return log(env, {
      verdict: 'скип: не знаю ветку этого контакта — он не писал в канал после запуска воркера',
      contact_id: contactId,
    });
  }

  const route = JSON.parse(raw);
  const sent = await sendToTelegram(route, text, env);
  await log(env, {
    verdict: `ответ из карточки → Telegram (контакт ${contactId})`,
    contact_id: contactId, message_id: sent?.message_id, text: text.slice(0, 200),
  });
}

/**
 * Шлём в ветку клиента внутри монофорума: без direct_messages_topic_id
 * Telegram не знает, кому именно из написавших адресовано сообщение.
 * message_id запоминаем — этим же сообщением бот получит свой же апдейт,
 * и по метке он его узнает.
 */
async function sendToTelegram(route, text, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      chat_id: route.chat_id,
      direct_messages_topic_id: route.topic_id,
      text,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`telegram sendMessage → ${data.error_code}: ${data.description}`);
  }
  const messageId = data.result?.message_id;
  if (messageId && env.S) {
    await env.S.put(`sent:${route.chat_id}:${messageId}`, '1', { expirationTtl: 86400 });
  }
  return data.result;
}

/** Ответ, написанный менеджером руками из Telegram, → примечанием в сделку. */
async function onManagerReply(msg, topic, env, cfg) {
  if (cfg.MANUAL_REPLY_NOTE !== 'true') {
    return log(env, { verdict: 'скип: сообщение от имени канала', chat_id: msg.chat?.id });
  }
  // Эхо собственной отправки: этот же message_id воркер только что записал.
  if (env.S && await env.S.get(`sent:${msg.chat?.id}:${msg.message_id}`)) {
    return log(env, { verdict: 'скип: это ответ, отправленный из amoCRM', message_id: msg.message_id });
  }

  const leadId = env.S ? await env.S.get(`route:${msg.chat?.id}:${topic.topic_id}`) : null;
  if (!leadId) {
    return log(env, {
      verdict: 'скип: не знаю сделку этой ветки — клиент не писал после запуска воркера',
      chat_id: msg.chat?.id, topic_id: topic.topic_id,
    });
  }

  const text = messageText(msg);
  await addNote(leadId, `${cfg.OUTGOING_NOTE_PREFIX}${text}`, env);
  await log(env, {
    verdict: `ручной ответ записан в сделку ${leadId}`,
    lead_id: leadId, topic_id: topic.topic_id, text: text.slice(0, 200),
  });
}

async function routeByLead(leadId, env) {
  if (!leadId || !env.S) return null;
  try { return JSON.parse((await env.S.get(`lead:${leadId}`)) || 'null'); } catch { return null; }
}

/** leads[note][0][note][text]=… → { leads: { note: { 0: { note: { text } } } } } */
function parseNested(params) {
  const root = {};
  for (const [key, value] of params.entries()) {
    const path = key.replace(/\]/g, '').split('[');
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[path[path.length - 1]] = value;
  }
  return root;
}

const values = (obj) => (obj && typeof obj === 'object' ? Object.values(obj) : []);

// ─────────────────────────── мелочи ───────────────────────────

/** У медиа текста нет — подписываем, что именно прислали. */
function messageText(msg) {
  if (msg.text) return msg.text;
  if (msg.caption) return msg.caption;
  const kinds = {
    photo: '📷 фото', video: '🎬 видео', voice: '🎤 голосовое', audio: '🎵 аудио',
    document: '📎 файл', sticker: '🙂 стикер', video_note: '⭕ кружок',
    animation: '🎞 гифка', contact: '👤 контакт', location: '📍 геопозиция',
    poll: '📊 опрос', story: '📖 история',
  };
  for (const [key, label] of Object.entries(kinds)) if (msg[key]) return `[${label} без текста]`;
  return '[сообщение без текста]';
}

function leadName(person, cfg) {
  const who = person.name || (person.username ? `@${person.username}` : `TG ${person.tgId}`);
  return `${cfg.LEAD_NAME_PREFIX}: ${who}`;
}

const field = (id, value) => ({ field_id: Number(id), values: [{ value: String(value) }] });

function hasField(contact, fieldId) {
  const f = (contact.custom_fields_values || []).find((x) => String(x.field_id) === String(fieldId));
  return Boolean(f?.values?.[0]?.value);
}

async function amo(path, env, opts = {}) {
  const res = await fetch(`https://${env.AMO_SUBDOMAIN}.amocrm.ru${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.AMO_TOKEN}`,
      // charset явно: имена и текст сообщений почти всегда кириллица.
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`amo ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;   // 204 «ничего не найдено» → null
}

// Кольцевой лог на 30 записей — единственный способ увидеть, что происходит,
// не имея доступа к живому каналу.
async function readLog(env) {
  if (!env.S) return [];
  try { return JSON.parse((await env.S.get('log')) || '[]'); } catch { return []; }
}
async function writeLog(env, entry) {
  if (!env.S) return;
  const log = await readLog(env);
  log.push({ ts: new Date().toISOString(), ...entry });
  await env.S.put('log', JSON.stringify(log.slice(-30)));
}
async function log(env, entry) {
  console.log(JSON.stringify(entry));
  await writeLog(env, entry);
}

const norm = (s) => String(s || '').trim().toLowerCase();
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const json = (obj) => new Response(JSON.stringify(obj), {
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k]) out[k] = obj[k];
  return out;
}
