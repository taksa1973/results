/**
 * neoved-chat-worker — виджет обратной связи на сайте ↔ amoCRM.
 *
 * Как это работает:
 *   Посетитель заполняет короткую форму (имя, рабочая почта, по желанию ИНН)
 *   и пишет вопрос → воркер ищет контакт по почте, при необходимости заводит
 *   компанию по ИНН и создаёт сделку в воронке «Чат на сайте». Текст падает
 *   примечанием в ленту сделки.
 *
 *   Менеджер отвечает прямо в карточке — обычным примечанием. amoCRM шлёт
 *   вебхук `note_lead`, воркер складывает текст в очередь сделки, виджет
 *   забирает её опросом /api/poll и показывает в чате.
 *
 *   По ходу разговора виджет досылает то, что человек не указал сразу:
 *   /api/inn — ИНН (создаётся компания), /api/phone — телефон.
 *
 * Почему примечания, а не Chats API:
 *   Двусторонний чат amoCRM (amojo) требует канала, зарегистрированного через
 *   партнёрский аккаунт в amoMarket, — у обычной интеграции его нет. Примечания
 *   доступны любому долгосрочному токену и работают в обе стороны: этим же
 *   способом живёт соседний tg-amo-worker.
 *
 * Секреты (задаются при деплое):
 *   AMO_SUBDOMAIN — поддомен аккаунта amoCRM без .amocrm.ru
 *   AMO_TOKEN     — долгосрочный токен интеграции amoCRM
 *   HOOK_SECRET   — произвольная строка: часть URL вебхука и адреса /debug
 *   CAPTCHA_KEY   — серверный ключ Яндекс SmartCaptcha (пусто — проверка выключена)
 *   WIDGET_KEY    — ключ кнопки в карточке amoCRM (см. amo-widget/)
 * Переменные — см. DEFAULTS ниже.
 * KV binding: S (сессии, очередь ответов, отладочный лог).
 *
 * Текст виджета лежит рядом в widget.js и заливается текстовым модулем.
 */

import WIDGET from './widget.js';
import { chatsEnabled, ensureChat, sendFromClient, parseWebhook } from './amojo.js';

const DEFAULTS = {
  // Воронка «Чат на сайте» и её этап «Первичный контакт».
  PIPELINE_ID: '11212054',
  STATUS_ID: '87966922',
  // На этот этап возвращаем сделку, если человек написал повторно.
  NEW_STATUS_NAME: 'Первичный контакт',
  TAG_NAME: 'site_chat',
  // Название сделки: «site chat: Иван | uslugi/ved».
  LEAD_NAME_PREFIX: 'site chat',
  // Домен сайта — из адреса страницы вырезается всё до него, остаток идёт
  // в название сделки.
  SITE_HOST: 'neoved.io',

  // Поля контакта и компании в этом аккаунте.
  EMAIL_FIELD: '629257',        // EMAIL, multitext — пишем с enum WORK («Email раб.»)
  PHONE_FIELD: '629255',        // PHONE, multitext — enum WORK («Раб. тел.»)
  COMPANY_INN_FIELD: '630037',  // «ИНН» у компании, numeric
  LEAD_URL_FIELD: '980989',     // «Источник» у сделки, url — полный адрес страницы

  // Пусто — виджет можно ставить на любой домен. Иначе список origin через запятую.
  ALLOW_ORIGINS: '',

  // Пусто — клиенту уходит ЛЮБОЕ обычное примечание, написанное человеком
  // (примечания интеграций отсеиваются по created_by). Если поставить сюда,
  // например, «+», уходить будут только примечания, начатые с этого знака.
  REPLY_PREFIX: '',
  // Пометки, которыми соседние интеграции начинают исходящие сообщения, —
  // в чате клиенту они не нужны.
  STRIP_PREFIXES: 'Ответ:',

  // Что делать, если оставленный телефон уже числится за другим контактом
  // (человек написал с новой почты, а номер у него прежний):
  //   attach — прежний контакт прикрепляется к сделке, плюс примечание и тег;
  //   notify — только примечание со ссылкой на старую карточку и тег;
  //   off    — не проверять.
  // Объединять карточки автоматически нельзя: в API v4 метода слияния нет,
  // а перепривязка сделки оставила бы висеть контакт-дубль.
  PHONE_DUP_MODE: 'attach',
  PHONE_DUP_TAG: 'phone_dup',

  // Команды менеджера. Написанные в ленте сделки, они не уходят клиенту
  // сообщением, а открывают у него в чате нужное окно ввода: человек мог
  // отказаться указывать ИНН сразу, а после разговора согласиться.
  // Текст после команды доедет до клиента обычной репликой.
  INN_COMMANDS: '/инн,/inn',
  PHONE_COMMANDS: '/телефон,/тел,/phone',

  // Воронки партнёров: «База партнёров», «Продажи партнёрам», «Продажи
  // клиентам партнёров», «Реанимация партнёров». В переписке по таким сделкам
  // ответ уходит без подписи менеджера — партнёр общается с компанией,
  // а не с конкретным сотрудником.
  PARTNER_PIPELINES: '9647638,9522274,9622366,9652634',

  // Антиспам: сколько заявок принимаем с одного адреса в час и сколько
  // сообщений — в рамках одной сессии.
  START_LIMIT: '5',
  MSG_LIMIT: '60',
};

// note_type обычного примечания в вебхуке приходит числом.
const COMMON_NOTE_TYPE = '4';

// Успех и отказ — эти ID одинаковы во всех воронках amoCRM.
const CLOSED_STATUS_IDS = new Set([142, 143]);

const SESSION_TTL = 60 * 60 * 24 * 30;   // месяц: столько живёт переписка
const MAX_QUEUE = 100;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = { ...DEFAULTS, ...pick(env, Object.keys(DEFAULTS)) };
    const secret = env.HOOK_SECRET || '';
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, cfg) });
    }

    if (url.pathname === '/widget.js') {
      return new Response(WIDGET, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'neoved-chat-worker', captcha: Boolean(env.CAPTCHA_KEY) }, origin, cfg);
    }

    // Последние решения воркера — что прилетело и что с этим стало.
    if (secret && url.pathname === `/debug/${secret}`) {
      const entries = await readLog(env);
      return json({ ok: true, count: entries.length, log: entries }, origin, cfg);
    }

    // Вебхук amoCRM: примечание в сделке → ответ клиенту в виджет.
    // amoCRM ретраит хук, если не ответить быстро, — разбор уходит в фон.
    if (secret && request.method === 'POST' && url.pathname === `/amo/${secret}`) {
      const raw = await request.text();
      ctx.waitUntil(
        handleAmoHook(raw, env, cfg).catch(async (e) => {
          console.error('handleAmoHook failed', e);
          await writeLog(env, { verdict: 'ошибка amo-хука', error: String(e).slice(0, 400) });
        }),
      );
      return json({ ok: true }, origin, cfg);
    }

    // Вебхук чатов amoCRM: менеджер ответил в переписке карточки.
    // Адрес зарегистрирован при создании канала и заканчивается на scope_id.
    if (env.SCOPE_ID && request.method === 'POST' && url.pathname === `/amojo/${env.SCOPE_ID}`) {
      const raw = await request.text();
      ctx.waitUntil(
        handleChatHook(raw, env).catch(async (e) => {
          console.error('handleChatHook failed', e);
          await writeLog(env, { verdict: 'ошибка хука чатов', error: String(e).slice(0, 400) });
        }),
      );
      return json({ ok: true }, origin, cfg);
    }

    if (url.pathname.startsWith('/api/')) {
      if (!originAllowed(origin, cfg)) {
        return json({ ok: false, error: 'origin не разрешён' }, origin, cfg, 403);
      }
      try {
        if (url.pathname === '/api/start' && request.method === 'POST') {
          return json(await apiStart(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/send' && request.method === 'POST') {
          return json(await apiSend(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/inn' && request.method === 'POST') {
          return json(await apiInn(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/phone' && request.method === 'POST') {
          return json(await apiPhone(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/ask' && request.method === 'POST') {
          return json(await apiAsk(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/thread' && request.method === 'GET') {
          return json(await apiThread(url, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/reply' && request.method === 'POST') {
          return json(await apiReply(request, env, cfg), origin, cfg);
        }
        if (url.pathname === '/api/poll' && request.method === 'GET') {
          return json(await apiPoll(url, env), origin, cfg);
        }
      } catch (e) {
        const bad = e instanceof HttpError;
        if (!bad) {
          console.error('api failed', e);
          await writeLog(env, { verdict: 'ошибка api', path: url.pathname, error: String(e).slice(0, 400) });
        }
        return json({ ok: false, error: bad ? e.message : 'Внутренняя ошибка, попробуйте ещё раз' },
          origin, cfg, bad ? e.status : 500);
      }
      return json({ ok: false, error: 'не найдено' }, origin, cfg, 404);
    }

    return new Response('neoved-chat-worker', { status: 200 });
  },
};

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ─────────────────────────── приём заявки ───────────────────────────

async function apiStart(request, env, cfg) {
  const body = await readJson(request);
  const person = {
    name: str(body.name, 128),
    email: str(body.email, 128).toLowerCase(),
    inn: digits(str(body.inn, 20)),
    // Формой телефон не спрашивается — он приходит позже, через /api/phone.
    // Но если однажды придёт сразу, поиск клиента им воспользуется.
    phone: digits(str(body.phone, 32)).length === 11 ? formatRuPhone(str(body.phone, 32)) : '',
    ads: Boolean(body.ads),                 // согласие на рекламные сообщения
    page: str(body.page, 300),
  };
  const text = str(body.message, 4000);

  if (person.name.length < 2) throw new HttpError('Укажите имя');
  if (!/^[^\s@]+@[^\s@]+\.[a-zа-я]{2,}$/i.test(person.email)) throw new HttpError('Проверьте адрес почты');
  if (person.inn && !isInn(person.inn)) throw new HttpError('ИНН — 10 цифр у компании или 12 у ИП');
  if (!body.consent) throw new HttpError('Без согласия на обработку персональных данных начать чат нельзя');
  if (text.length < 2) throw new HttpError('Напишите сообщение');

  await checkCaptcha(str(body.captcha, 4000), request, env);
  await rateLimit(env, `start:${clientIp(request)}`, Number(cfg.START_LIMIT) || 5,
    'Слишком много обращений с этого адреса. Напишите на sales@neoved.io');

  const result = await syncToAmo(person, text, env, cfg);

  // Организация уже была в базе — покажем менеджеру её историю.
  if (result.company?.existed) {
    await reportCompanyTwin(result.company, { leadId: result.leadId }, env);
  }

  const sid = crypto.randomUUID();
  await env.S.put(`sid:${sid}`, JSON.stringify({
    leadId: result.leadId,
    contactId: result.contactId,
    companyId: result.companyId,
    inn: person.inn,
    name: person.name,
    email: person.email,
    at: Date.now(),
  }), { expirationTtl: SESSION_TTL });

  // Связка «контакт → сделка»: вебхук чатов знает только контакт, а воронку
  // сделки нужно проверять, чтобы понять, подписывать ли ответ менеджера.
  if (result.contactId && result.leadId) {
    await env.S.put(`lead-of:${result.contactId}`, String(result.leadId), { expirationTtl: SESSION_TTL });
  }

  // Первое сообщение — уже в переписку карточки. Сводка с ИНН, согласиями и
  // страницей остаётся примечанием: это данные заявки, а не реплика клиента.
  await deliverToManager(result.contactId, person, text, env, result.leadId);

  await writeLog(env, {
    verdict: result.verdict, lead_id: result.leadId, contact_id: result.contactId,
    company_id: result.companyId, name: person.name, sid,
  });
  return { ok: true, sid, lead_id: result.leadId, has_inn: Boolean(person.inn) };
}

async function apiSend(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const text = str(body.text, 4000);
  if (!text) throw new HttpError('Пустое сообщение');

  const session = await getSession(env, sid);
  await rateLimit(env, `msg:${sid}`, Number(cfg.MSG_LIMIT) || 60, 'Слишком много сообщений подряд');

  await deliverToManager(session.contactId, session, text, env, session.leadId);
  await writeLog(env, {
    verdict: `сообщение клиента → сделка ${session.leadId}`,
    lead_id: session.leadId, text: text.slice(0, 200),
  });
  return { ok: true };
}

/**
 * Реплика клиента менеджеру. Пока канал чатов настроен — она уходит в
 * переписку карточки и выглядит там пузырём; без канала (или если amojo
 * ответил ошибкой) остаётся прежний путь — примечание в ленте сделки.
 * Терять сообщение из-за сбоя чата нельзя, поэтому примечание работает
 * запасным вариантом, а не заменой.
 */
async function deliverToManager(contactId, person, text, env, leadId) {
  if (chatsEnabled(env) && contactId) {
    try {
      await ensureChat(contactId, person, env);
      await sendFromClient(contactId, person, text, env);
      return;
    } catch (e) {
      console.error('чат amoCRM не принял сообщение', e);
      await writeLog(env, { verdict: 'чат недоступен, ушло примечанием', error: String(e).slice(0, 300) });
    }
  }
  await addNote(leadId, text, env);
}

/** ИНН, названный уже в разговоре: заводим компанию и подшиваем её к сделке. */
async function apiInn(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const inn = digits(str(body.inn, 20));
  if (!isInn(inn)) throw new HttpError('ИНН — 10 цифр у компании или 12 у ИП');

  const session = await getSession(env, sid);
  const company = await ensureCompany({ inn, email: session.email, phone: session.phone }, env, cfg);

  // Тот же ИНН прислали второй раз — сообщать не о чем.
  if (String(session.companyId || '') === String(company.id)) {
    return { ok: true, unchanged: true };
  }

  // ИНН исправляют: в первый раз человек мог ошибиться цифрой, и менеджер
  // просит прислать заново. Прежнюю компанию отцепляем от сделки и контакта —
  // иначе в карточке останутся две организации, и непонятно, какая настоящая.
  // Саму карточку компании не трогаем: вдруг это живой клиент, просто не этот.
  const previous = session.companyId;
  if (previous) {
    await unlink('leads', session.leadId, 'companies', previous, env);
    if (session.contactId) await unlink('contacts', session.contactId, 'companies', previous, env);
  }

  await linkCompany(company.id, session, env);

  // Телефон мог быть оставлен до того, как назвали ИНН: тогда компании ещё не
  // существовало, и номер попал только к контакту. Дописываем.
  if (session.phone) await addPhone('companies', company.id, session.phone, env, cfg);

  await addNote(session.leadId, previous
    ? `Клиент исправил ИНН: было ${session.inn || previous}, стало ${inn}`
    : `Клиент указал ИНН: ${inn}`, env);
  if (company.existed) await reportCompanyTwin(company, session, env);

  session.companyId = company.id;
  session.inn = inn;
  await env.S.put(`sid:${sid}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });

  await writeLog(env, {
    verdict: `ИНН из чата → компания ${company.id} (сделка ${session.leadId})`,
    lead_id: session.leadId, company_id: company.id, inn,
  });
  return { ok: true };
}

/** Телефон, оставленный по ходу разговора: пишем контакту и компании. */
async function apiPhone(request, env, cfg) {
  const body = await readJson(request);
  const sid = str(body.sid, 64);
  const phone = str(body.phone, 32);
  if (digits(phone).length !== 11 || !/^[78]/.test(digits(phone))) {
    throw new HttpError('Нужен российский номер: +7 999 123-45-67');
  }

  const session = await getSession(env, sid);
  const pretty = formatRuPhone(phone);

  // Ищем прежнего владельца номера ДО записи: иначе найдём сами себя.
  const twin = cfg.PHONE_DUP_MODE === 'off' ? null : await findContactByPhone(pretty, session, env, cfg);

  if (session.contactId) await addPhone('contacts', session.contactId, pretty, env, cfg);
  if (session.companyId) await addPhone('companies', session.companyId, pretty, env, cfg);
  await rememberPhone(pretty, session.contactId, env);
  await addNote(session.leadId, `Клиент оставил телефон: ${pretty}`, env);

  // Запоминаем номер в сессии: ИНН могут назвать позже, и тогда телефон нужно
  // будет продублировать в карточку компании — иначе он останется только у
  // контакта, а у организации поле «Раб. тел.» будет пустым.
  session.phone = pretty;
  await env.S.put(`sid:${sid}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });

  if (twin) await reportPhoneTwin(twin, pretty, session, env, cfg);

  await writeLog(env, {
    verdict: twin
      ? `телефон из чата → контакт ${session.contactId}; номер уже был у контакта ${twin.contact.id}`
      : `телефон из чата → контакт ${session.contactId} (сделка ${session.leadId})`,
    lead_id: session.leadId, contact_id: session.contactId, phone: pretty,
    twin_contact_id: twin?.contact?.id,
  });
  return { ok: true, duplicate: Boolean(twin) };
}

/**
 * Контакт, за которым этот номер уже числится. Человек мог прийти с личной
 * почты, но телефон оставить рабочий — по нему и находится его прошлая
 * карточка. Себя самого в результат не берём.
 */
async function findContactByPhone(phone, session, env, cfg) {
  const tail = digits(phone).slice(-10);
  if (tail.length !== 10) return null;

  const found = await query('contacts', tail, env, 'with=leads');
  const contact = found.find((c) => String(c.id) !== String(session.contactId)
    && fieldValues(c, cfg.PHONE_FIELD).some((v) => digits(v).endsWith(tail)));
  if (!contact) return null;

  return { contact, leads: await openLeadsOf(contact, session.leadId, env) };
}

/** Незакрытые сделки найденного контакта, кроме текущей. */
async function openLeadsOf(contact, exceptId, env) {
  const ids = (contact._embedded?.leads || []).map((l) => l.id)
    .filter((id) => id && String(id) !== String(exceptId));
  if (!ids.length) return [];

  const q = ids.slice(-50).map((id) => `filter[id][]=${id}`).join('&');
  const res = await amo(`/api/v4/leads?limit=50&${q}`, env);
  return (res?._embedded?.leads || []).filter((l) => !CLOSED_STATUS_IDS.has(Number(l.status_id)));
}

/**
 * ИНН привёл к карточке, которая в базе уже была: показываем менеджеру, что у
 * этой организации есть своя история — возможно, клиента уже ведёт коллега.
 */
async function reportCompanyTwin(company, session, env) {
  const leads = await openLeadsOf(company, session.leadId, env);
  if (!leads.length) return;

  const base = `https://${env.AMO_SUBDOMAIN}.amocrm.ru`;
  const lines = [
    `Компания с этим ИНН уже была в базе: «${company.name || 'без имени'}»`,
    `${base}/companies/detail/${company.id}`,
    '',
    'Её открытые сделки:',
  ];
  for (const lead of leads.slice(0, 5)) {
    lines.push(`• ${lead.name || 'без названия'} — ${base}/leads/detail/${lead.id}`);
  }
  await addNote(session.leadId, lines.join('\n'), env);
}

/**
 * Сообщаем менеджеру про совпадение: примечание со ссылкой на старую карточку,
 * тег на сделке и — если включён режим attach — прежний контакт прикрепляется
 * к сделке вторым. Решение объединять карточки остаётся за человеком.
 */
async function reportPhoneTwin(twin, phone, session, env, cfg) {
  const base = `https://${env.AMO_SUBDOMAIN}.amocrm.ru`;
  const attach = cfg.PHONE_DUP_MODE === 'attach';
  const lines = [
    'Внимание: этот телефон уже есть в базе',
    '',
    `${phone} — контакт «${twin.contact.name || 'без имени'}»`,
    `${base}/contacts/detail/${twin.contact.id}`,
  ];

  if (twin.leads.length) {
    lines.push('', 'Его открытые сделки:');
    for (const lead of twin.leads.slice(0, 5)) {
      lines.push(`• ${lead.name || 'без названия'} — ${base}/leads/detail/${lead.id}`);
    }
  } else {
    lines.push('', 'Открытых сделок у этого контакта нет.');
  }

  lines.push('', `Сейчас человек пишет с почты ${session.email || '—'}. Похоже на того же клиента: возможно, карточки стоит объединить.`);
  if (attach) lines.push('Прежний контакт прикреплён к этой сделке — вся история рядом.');

  await addNote(session.leadId, lines.join('\n'), env);
  await amo(`/api/v4/leads/${session.leadId}`, env, {
    method: 'PATCH',
    body: { tags_to_add: [{ name: cfg.PHONE_DUP_TAG }] },
  });

  // Сделка в amoCRM держит несколько контактов: старая карточка встаёт рядом
  // с новой. Связи ставятся только методом link — PATCH их не меняет.
  if (attach) await link('leads', session.leadId, 'contacts', twin.contact.id, env);
}

/**
 * Кнопка менеджера из карточки amoCRM: открыть у клиента окно ввода.
 *
 * Сюда стучится виджет `amo-widget/`, установленный в аккаунт. Ключ лежит в
 * настройках виджета, а не в его коде, и даёт право ровно на одно действие —
 * показать человеку поле ввода. Само событие цепляется к примечанию: его id
 * растёт вместе с остальной лентой, поэтому порядок сообщений в чате не
 * ломается (виджет забирает всё, что новее последнего показанного id).
 */
async function apiAsk(request, env, cfg) {
  const body = await readJson(request);
  if (!env.WIDGET_KEY) throw new HttpError('Кнопка не настроена: воркеру не задан WIDGET_KEY', 503);
  if (str(body.key, 200) !== env.WIDGET_KEY) throw new HttpError('Неверный ключ доступа', 403);

  const leadId = digits(str(body.lead_id, 20));
  if (!leadId) throw new HttpError('Не указана сделка');
  const ask = str(body.ask, 10) === 'phone' ? 'phone' : 'inn';
  const text = str(body.text, 1000);

  const what = ask === 'inn' ? 'ИНН' : 'телефон';
  const noteId = await addNote(leadId, text
    ? `Менеджер запросил у клиента ${what}: «${text}»`
    : `Менеджер запросил у клиента ${what}`, env);
  if (!noteId) throw new HttpError('amoCRM не принял примечание — проверьте номер сделки', 502);

  // Идентификатор события — время, а не номер примечания. Виджет отбрасывает
  // всё, что не новее последнего показанного, а номера примечаний (сотни
  // миллионов) меньше миллисекунд эпохи: после первого же ответа из чата
  // событие кнопки выглядело старым и терялось.
  const at = Date.now();
  await env.S.put(msgKey(leadId, at), text, {
    expirationTtl: SESSION_TTL,
    metadata: { at, ask, note_id: noteId },
  });

  await writeLog(env, {
    verdict: `кнопка в карточке: у клиента открыто окно ввода (${what})`,
    lead_id: leadId, note_id: noteId, text: text.slice(0, 200),
  });
  return { ok: true, note_id: noteId };
}

/**
 * Переписка сделки для чата в карточке amoCRM.
 *
 * Отдельного хранилища сообщений нет и не нужно: вся переписка и так лежит
 * примечаниями в ленте сделки. Здесь она только раскладывается по сторонам —
 * примечания, созданные по API (created_by = 0), написал клиент через виджет,
 * остальные — менеджеры в интерфейсе. Служебные строки («Клиент указал ИНН»,
 * сводка заявки) помечаются как системные, чтобы в чате они выглядели
 * заметками, а не репликами.
 */
async function apiThread(url, env, cfg) {
  if (!env.WIDGET_KEY) throw new HttpError('Чат не настроен: воркеру не задан WIDGET_KEY', 503);
  if (str(url.searchParams.get('key'), 200) !== env.WIDGET_KEY) throw new HttpError('Неверный ключ доступа', 403);

  const leadId = digits(str(url.searchParams.get('lead_id'), 20));
  if (!leadId) throw new HttpError('Не указана сделка');

  const res = await amo(`/api/v4/leads/${leadId}/notes?limit=250&order[id]=asc`, env);
  const notes = (res?._embedded?.notes || []).filter((n) => String(n.note_type) === 'common');

  const messages = [];
  for (const note of notes) {
    const text = String(note.params?.text || '').trim();
    if (!text) continue;
    const byManager = Boolean(Number(note.created_by || 0));
    messages.push({
      id: note.id,
      at: note.created_at,
      side: byManager ? 'manager' : (isServiceNote(text) ? 'system' : 'client'),
      user_id: note.created_by || null,
      text,
    });
  }
  return { ok: true, lead_id: Number(leadId), messages };
}

/** Служебные строки, которые воркер пишет сам от лица интеграции. */
const SERVICE_NOTE_RE = /^(Чат на сайте \(виджет\)|Клиент указал ИНН|Клиент оставил телефон|Менеджер запросил|Внимание: этот телефон|Компания с этим ИНН|К сделке добавлен новый контакт)/;
const isServiceNote = (text) => SERVICE_NOTE_RE.test(text);

/**
 * Ответ менеджера, написанный в чате виджета. Примечание создаётся от имени
 * самого менеджера (created_by), поэтому дальше всё идёт обычным путём: хук
 * note_lead → очередь → чат на сайте. Метку «своё примечание» не ставим —
 * иначе воркер сам же его и отфильтрует.
 */
async function apiReply(request, env, cfg) {
  const body = await readJson(request);
  if (!env.WIDGET_KEY) throw new HttpError('Чат не настроен: воркеру не задан WIDGET_KEY', 503);
  if (str(body.key, 200) !== env.WIDGET_KEY) throw new HttpError('Неверный ключ доступа', 403);

  const leadId = digits(str(body.lead_id, 20));
  const userId = digits(str(body.user_id, 20));
  const text = str(body.text, 4000);
  if (!leadId) throw new HttpError('Не указана сделка');
  if (!text) throw new HttpError('Пустое сообщение');
  if (!userId) throw new HttpError('Не удалось определить менеджера');

  const res = await amo(`/api/v4/leads/${leadId}/notes`, env, {
    method: 'POST',
    body: [{ note_type: 'common', created_by: Number(userId), params: { text } }],
  });
  const noteId = res?._embedded?.notes?.[0]?.id;

  await writeLog(env, {
    verdict: `ответ менеджера из карточки → клиенту (сделка ${leadId})`,
    lead_id: leadId, note_id: noteId, user_id: userId, text: text.slice(0, 200),
  });
  return { ok: true, note_id: noteId };
}

async function apiPoll(url, env) {
  const sid = str(url.searchParams.get('sid'), 64);
  const after = Number(url.searchParams.get('after')) || 0;
  const session = await getSession(env, sid);   // чужой/протухший sid — 404

  // Очередей две: ответы из переписки карточки лежат на контакте (чат живёт
  // на нём и переживает смену сделок), примечания — на сделке. Читаем обе:
  // менеджер может ответить и в чате, и примечанием.
  const since = Number(session.at) || 0;
  const [fromChat, fromNotes] = await Promise.all([
    session.contactId ? readQueue(env, `c${session.contactId}`, after, since) : [],
    readQueue(env, session.leadId, after, since),
  ]);

  const messages = [...fromChat, ...fromNotes].sort((a, b) => a.at - b.at);
  return { ok: true, messages };
}

async function getSession(env, sid) {
  if (!sid) throw new HttpError('Нет идентификатора сессии');
  const raw = await env.S.get(`sid:${sid}`);
  if (!raw) throw new HttpError('Сессия устарела — обновите страницу и напишите снова', 404);
  return JSON.parse(raw);
}

// ─────────────────────────── amoCRM ───────────────────────────

/**
 * Порядок склейки повторяет логику самой amoCRM: всё сходится на организации.
 *
 *   ИНН → компания → её открытая сделка в воронке чата.
 *   Нет ИНН (или у компании нет живой сделки) → сделка по контакту.
 *
 * Поэтому коллега, написавший с другой почты, попадает не в новую сделку, а в
 * ту, где уже идёт разговор с его компанией: заводится второй контакт и
 * подшивается и к сделке, и к карточке организации.
 */
async function syncToAmo(person, text, env, cfg) {
  const company = person.inn ? await ensureCompany(person, env, cfg) : null;
  const contact = await ensureContact(person, company, env, cfg);
  const summary = firstNote(person, text);

  let lead = company ? await openLeadOf('companies', company.id, env, cfg) : null;
  let via = lead ? 'по компании' : null;
  if (!lead) {
    lead = await openLeadOf('contacts', contact.id, env, cfg);
    via = lead ? 'по контакту' : null;
  }

  if (!lead) {
    const leadId = await createLead(person, contact.id, company, env, cfg);
    await addNote(leadId, summary, env);
    return {
      leadId, contactId: contact.id, company, companyId: company?.id || null,
      verdict: contact.created
        ? 'создана сделка с новым контактом'
        : 'контакт был, открытой сделки в воронке чата не было — создана новая',
    };
  }

  const statusId = await resolveStatus(lead.pipeline_id, env, cfg);
  const patch = { tags_to_add: [{ name: cfg.TAG_NAME }] };
  if (statusId && lead.status_id !== statusId) {
    patch.status_id = statusId;
    patch.pipeline_id = lead.pipeline_id;
  }
  if (person.page) patch.custom_fields_values = [field(cfg.LEAD_URL_FIELD, person.page)];
  await amo(`/api/v4/leads/${lead.id}`, env, { method: 'PATCH', body: patch });

  // Связи между сущностями PATCH не меняет — для них отдельный метод link.
  const linked = (lead._embedded?.contacts || []).map((c) => String(c.id));
  if (!linked.includes(String(contact.id))) {
    await link('leads', lead.id, 'contacts', contact.id, env);
  }
  if (company) await link('leads', lead.id, 'companies', company.id, env);

  // Новый человек в старой сделке — менеджеру стоит об этом сказать явно.
  if (contact.created) {
    await addNote(lead.id, `К сделке добавлен новый контакт: ${person.name}, ${person.email}`, env);
  }
  await addNote(lead.id, summary, env);

  return {
    leadId: lead.id, contactId: contact.id, company, companyId: company?.id || null,
    verdict: `сделка ${lead.id} найдена ${via} → «${cfg.NEW_STATUS_NAME}» + тег`
      + (contact.created ? ', добавлен новый контакт' : ''),
  };
}

/**
 * Контакт по рабочей почте: нашли — дозаполняем и подшиваем к компании,
 * не нашли — заводим новый. Новая почта у знакомой организации даёт именно
 * новый контакт внутри неё, а не отдельную «параллельную» карточку клиента.
 */
async function ensureContact(person, company, env, cfg) {
  const found = await findContact(person, env, cfg);
  if (found) {
    await fillEmptyFields(found, person, env, cfg);
    if (company) await attachToCompany(found, company.id, env);
    return { id: found.id, created: false };
  }

  const fields = [multitext(cfg.EMAIL_FIELD, person.email)];
  if (person.phone) fields.push(multitext(cfg.PHONE_FIELD, person.phone));

  const body = [{
    name: person.name,
    custom_fields_values: fields,
    ...(company ? { _embedded: { companies: [{ id: company.id }] } } : {}),
  }];
  const res = await amo('/api/v4/contacts', env, { method: 'POST', body });
  const id = res?._embedded?.contacts?.[0]?.id;
  if (person.phone) await rememberPhone(person.phone, id, env);
  return { id, created: true };
}

/**
 * Запоминает, за каким контактом закреплён номер. Нужно только чтобы пережить
 * отставание поиска amoCRM: клиент оставил телефон и через минуту вернулся с
 * другой почтой — по индексу его ещё не найти, а по этой записи найдётся.
 */
async function rememberPhone(phone, contactId, env) {
  const tail = digits(phone).slice(-10);
  if (tail.length !== 10 || !contactId) return;
  await env.S.put(`phone:${tail}`, String(contactId), { expirationTtl: SESSION_TTL });
}

async function recallPhone(phone, env) {
  const tail = digits(phone).slice(-10);
  if (tail.length !== 10) return null;
  return env.S.get(`phone:${tail}`);
}

/** Привязывает контакт к компании, если он ещё не её. */
async function attachToCompany(contact, companyId, env) {
  const current = contact._embedded?.companies || [];
  if (current.some((c) => String(c.id) === String(companyId))) return;
  await link('contacts', contact.id, 'companies', companyId, env);
}

/**
 * Связывает две сущности (сделку с контактом, контакт с компанией и т. д.).
 * В API v4 связи живут отдельно от полей: PATCH их не меняет, нужен /link.
 * Повторная привязка уже связанных сущностей возвращает ошибку — она
 * безобидна, поэтому глушится.
 */
async function link(entity, id, toType, toId, env) {
  if (!id || !toId) return;
  try {
    await amo(`/api/v4/${entity}/${id}/link`, env, {
      method: 'POST',
      body: [{ to_entity_id: Number(toId), to_entity_type: toType }],
    });
  } catch (e) {
    console.error(`link ${entity}/${id} → ${toType}/${toId}`, e);
  }
}

/** Обратная операция: снять связь. Ошибка «связи и не было» безобидна. */
async function unlink(entity, id, toType, toId, env) {
  if (!id || !toId) return;
  try {
    await amo(`/api/v4/${entity}/${id}/unlink`, env, {
      method: 'POST',
      body: [{ to_entity_id: Number(toId), to_entity_type: toType }],
    });
  } catch (e) {
    console.error(`unlink ${entity}/${id} → ${toType}/${toId}`, e);
  }
}

/**
 * Контакт ищем по рабочей почте, а если не нашли — по телефону: человек мог
 * завести новый ящик, но номер обычно остаётся прежним.
 *
 * Ищем через ?query=, а не через filter[custom_fields_values][...]: этот
 * аккаунт фильтр по дополнительным полям не принимает — проверено на соседнем
 * tg-amo-worker, обе формы записи отдают 400 «Invalid filter for current
 * account». query ищет подстроку по всем заполненным полям, поэтому совпадение
 * обязательно перепроверяется по нужному полю.
 *
 * Телефон ищем цифрами: «+7 (926) 571-72-19» amoCRM не находит, а
 * «79265717219» и «9265717219» — находят один и тот же контакт.
 */
async function findContact(person, env, cfg) {
  // Телефон, записанный минуту назад, поиск amoCRM ещё не видит: индекс
  // догоняет за пару минут (проверено 20.08.2026 — сразу после записи query
  // отдавал пусто, через две минуты находил). Поэтому свои же номера воркер
  // помнит сам.
  const remembered = await recallPhone(person.phone, env);
  if (remembered) {
    const contact = await amo(`/api/v4/contacts/${remembered}?with=leads,companies`, env);
    if (contact?.id) return contact;
  }

  if (person.email) {
    const byEmail = (await query('contacts', person.email, env, 'with=leads,companies'))
      .find((c) => fieldValues(c, cfg.EMAIL_FIELD).some((v) => v.toLowerCase() === person.email));
    if (byEmail) return byEmail;
  }

  const tail = digits(person.phone).slice(-10);
  if (tail.length === 10) {
    const byPhone = (await query('contacts', tail, env, 'with=leads,companies'))
      .find((c) => fieldValues(c, cfg.PHONE_FIELD).some((v) => digits(v).endsWith(tail)));
    if (byPhone) return byPhone;
  }

  return null;
}

/** Компания по ИНН: нашли — берём, нет — заводим с названием по ИНН. */
async function ensureCompany(person, env, cfg) {
  const found = await query('companies', person.inn, env, 'with=leads');
  const hit = found.find((c) => fieldValues(c, cfg.COMPANY_INN_FIELD).some((v) => digits(v) === person.inn));
  if (hit) {
    if (person.email && !fieldValues(hit, cfg.EMAIL_FIELD).length) {
      await amo(`/api/v4/companies/${hit.id}`, env, {
        method: 'PATCH',
        body: { custom_fields_values: [multitext(cfg.EMAIL_FIELD, person.email)] },
      });
    }
    hit.existed = true;
    return hit;
  }

  // Названия компании виджет не спрашивает, поэтому в имя идёт ИНН —
  // менеджер переименует карточку, когда узнает организацию.
  const fields = [field(cfg.COMPANY_INN_FIELD, person.inn)];
  if (person.email) fields.push(multitext(cfg.EMAIL_FIELD, person.email));
  if (person.phone) fields.push(multitext(cfg.PHONE_FIELD, person.phone));
  const res = await amo('/api/v4/companies', env, {
    method: 'POST',
    body: [{ name: person.inn, custom_fields_values: fields }],
  });
  return res?._embedded?.companies?.[0];
}

/** Компанию видно и в сделке, и в карточке контакта. */
async function linkCompany(companyId, session, env) {
  if (!companyId) return;
  await link('leads', session.leadId, 'companies', companyId, env);
  if (session.contactId) await link('contacts', session.contactId, 'companies', companyId, env);
}

/** Дописывает телефон, не затирая уже записанные номера. */
async function addPhone(entity, id, phone, env, cfg) {
  const card = await amo(`/api/v4/${entity}/${id}`, env);
  const existing = fieldValues(card, cfg.PHONE_FIELD);
  if (existing.some((v) => digits(v).slice(-10) === digits(phone).slice(-10))) return;

  const values = existing.map((v) => ({ value: v })).concat([{ value: phone, enum_code: 'WORK' }]);
  await amo(`/api/v4/${entity}/${id}`, env, {
    method: 'PATCH',
    body: { custom_fields_values: [{ field_id: Number(cfg.PHONE_FIELD), values }] },
  });
}

async function query(entity, value, env, extra = '') {
  const q = String(value || '').trim();
  if (q.length < 3) return [];
  const res = await amo(`/api/v4/${entity}?limit=50&${extra ? extra + '&' : ''}query=${encodeURIComponent(q)}`, env);
  return res?._embedded?.[entity] || [];      // ничего не нашлось → 204 → null
}

/** Значения одного поля карточки, пустые отброшены. */
function fieldValues(card, fieldId) {
  const f = (card?.custom_fields_values || []).find((x) => String(x.field_id) === String(fieldId));
  return (f?.values || []).map((v) => String(v.value ?? '').trim()).filter(Boolean);
}

/**
 * Дописываем в карточку то, чего в ней ещё нет: клиент мог прийти год назад
 * без почты. Заполненные поля не трогаем — PATCH заменяет значения поля
 * целиком, и чужой адрес затёрся бы.
 */
async function fillEmptyFields(contact, person, env, cfg) {
  if (!person.email || fieldValues(contact, cfg.EMAIL_FIELD).length) return;
  await amo(`/api/v4/contacts/${contact.id}`, env, {
    method: 'PATCH',
    body: { custom_fields_values: [multitext(cfg.EMAIL_FIELD, person.email)] },
  });
}

/**
 * Последняя незакрытая сделка контакта или компании в воронке чата.
 * Возвращает её вместе со списком уже привязанных контактов — при PATCH связи
 * перезаписываются целиком, и потерять коллег по сделке нельзя.
 */
async function openLeadOf(entity, id, env, cfg) {
  if (!id) return null;
  const card = await amo(`/api/v4/${entity}/${id}?with=leads`, env);
  const ids = (card?._embedded?.leads || []).map((l) => l.id).filter(Boolean);
  if (!ids.length) return null;

  const q = ids.slice(-50).map((leadId) => `filter[id][]=${leadId}`).join('&');
  const res = await amo(`/api/v4/leads?limit=50&with=contacts&${q}`, env);
  const open = (res?._embedded?.leads || [])
    .filter((l) => String(l.pipeline_id) === String(cfg.PIPELINE_ID))
    .filter((l) => !CLOSED_STATUS_IDS.has(Number(l.status_id)));

  if (!open.length) return null;
  open.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
  return open[open.length - 1];
}

/**
 * ID нужного этапа внутри той же воронки, где лежит сделка. Карта воронок
 * кешируется на 10 минут.
 */
let pipelinesCache = { at: 0, map: null };
async function resolveStatus(pipelineId, env, cfg) {
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

async function createLead(person, contactId, company, env, cfg) {
  const body = [{
    ...leadBody(person, company, cfg),
    _embedded: {
      contacts: [{ id: contactId }],
      ...(company ? { companies: [{ id: company.id }] } : {}),
    },
  }];
  const res = await amo('/api/v4/leads', env, { method: 'POST', body });
  return res?._embedded?.leads?.[0]?.id;
}

function leadBody(person, company, cfg) {
  const body = {
    name: leadName(person, cfg),
    pipeline_id: Number(cfg.PIPELINE_ID),
    status_id: Number(cfg.STATUS_ID),
    tags_to_add: [{ name: cfg.TAG_NAME }],
  };
  if (person.page) body.custom_fields_values = [field(cfg.LEAD_URL_FIELD, person.page)];
  return body;
}

/**
 * Пишет примечание и запоминает его id: на каждое примечание amoCRM пришлёт
 * вебхук, и метка помогает не принять собственную запись за ответ менеджера.
 */
async function addNote(leadId, text, env) {
  if (!leadId) return null;
  const res = await amo(`/api/v4/leads/${leadId}/notes`, env, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text } }],
  });
  const noteId = res?._embedded?.notes?.[0]?.id;
  if (noteId) await env.S.put(`note:${noteId}`, '1', { expirationTtl: 86400 });
  return noteId;
}

/** Первое примечание: контакты рядом с вопросом, чтобы менеджер видел всё сразу. */
function firstNote(person, text) {
  const lines = [
    'Чат на сайте (виджет)',
    `Имя: ${person.name}`,
    `Рабочая почта: ${person.email}`,
  ];
  if (person.phone) lines.push(`Телефон: ${person.phone}`);
  if (person.inn) lines.push(`ИНН: ${person.inn}`);
  lines.push(`Согласие на рекламные сообщения: ${person.ads ? 'да' : 'нет'}`);
  if (person.page) lines.push(`Страница: ${person.page}`);
  lines.push('', 'Сообщение:', text);
  return lines.join('\n');
}

/** «site chat: Иван | uslugi/ved» — по названию видно, с какой страницы пришли. */
function leadName(person, cfg) {
  return `${cfg.LEAD_NAME_PREFIX}: ${person.name} | ${pagePath(person.page, cfg)}`;
}

/** Из «https://neoved.io/uslugi/ved?x=1» получается «uslugi/ved». */
function pagePath(page, cfg) {
  if (!page) return '—';
  try {
    const path = new URL(page).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || '/';
  } catch {
    const cut = String(page).split(cfg.SITE_HOST).pop() || '';
    return cut.replace(/^\/+/, '').replace(/[?#].*$/, '') || '/';
  }
}

// ─────────────────── ответ клиенту: amoCRM → виджет ───────────────────

/**
 * Вебхук amoCRM о добавлении примечания (событие note_lead).
 *
 * Формат в документации не описан; ключи сняты с живого хука 17.08.2026 —
 * `leads[note][0][note][…]` с полями id, element_id, element_type, note_type
 * (числом: 4 — обычное), text, created_by. То же самое разбирают соседние
 * tg-amo-worker и amo-phone-worker.
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
    return writeLog(env, { verdict: 'скип: в хуке amo нет примечаний', keys: [...params.keys()].slice(0, 30) });
  }
  for (const note of notes) await onAmoNote(note, env, cfg);
}

async function onAmoNote(note, env, cfg) {
  const noteId = String(note.id ?? '');
  const leadId = String(note.element_id ?? '');
  const type = String(note.note_type ?? '');

  // Звонки, системные сообщения и прочее в чат не показываем.
  if (type !== COMMON_NOTE_TYPE) return;

  // Кто написал. Примечания, созданные по API (наши собственные и чужих
  // интеграций), приходят с created_by = 0; у реплики живого менеджера тут
  // стоит его id. Это и есть защита от эха: KV-метка своего примечания
  // ненадёжна — вебхук успевает прийти раньше, чем запись разойдётся по
  // регионам, и сообщение клиента возвращалось ему же ответом.
  if (!Number(note.created_by ?? 0)) return;

  // Подстраховка на случай, если однажды у примечания появится ненулевой автор:
  // свои примечания воркер помечает в KV сразу после создания.
  if (noteId && await env.S.get(`note:${noteId}`)) {
    return writeLog(env, { verdict: 'скип: примечание создано воркером', note_id: noteId });
  }

  // Обслуживается ли эта сделка виджетом — спрашиваем у самой amoCRM, а не у
  // KV: свежезаписанный признак расходится по регионам до минуты, и вебхук об
  // ответе менеджера успевал прийти раньше. Тег на сделке виден сразу.
  if (!await taggedByWidget(leadId, env, cfg)) return;

  let text = String(note.text ?? '').trim();
  if (cfg.REPLY_PREFIX) {
    if (!text.startsWith(cfg.REPLY_PREFIX)) {
      return writeLog(env, { verdict: `скип: примечание без префикса «${cfg.REPLY_PREFIX}»`, note_id: noteId });
    }
    text = text.slice(cfg.REPLY_PREFIX.length).trim();
  }
  // Пометки соседних интеграций («Ответ: …» от tg-amo-worker) клиенту не нужны.
  for (const p of list(cfg.STRIP_PREFIXES)) {
    if (p && text.startsWith(p)) { text = text.slice(p.length).trim(); break; }
  }

  // Команда менеджера вместо реплики: «/инн» открывает у клиента окно ввода
  // ИНН, «/телефон» — окно телефона. Всё, что написано после команды, доедет
  // клиенту обычным сообщением, так что можно объяснить, зачем это нужно.
  let ask = null;
  const firstWord = text.split(/\s+/)[0].toLowerCase();
  if (list(cfg.INN_COMMANDS).some((c) => c.toLowerCase() === firstWord)) ask = 'inn';
  else if (list(cfg.PHONE_COMMANDS).some((c) => c.toLowerCase() === firstWord)) ask = 'phone';
  if (ask) text = text.slice(firstWord.length).trim();

  if (!text && !ask) return;

  // Пока работает канал чатов, ответы доезжают до клиента через него. Реплика
  // менеджера порождает и примечание — если пропустить его дальше, клиент
  // увидит один и тот же ответ дважды. Команды («/инн») пропускаем: их пишут
  // именно примечанием, и через чат они не приходят.
  if (!ask && chatsEnabled(env)) {
    return writeLog(env, {
      verdict: 'скип: ответ уже ушёл клиенту через чат',
      lead_id: leadId, note_id: noteId,
    });
  }

  // Каждый ответ — отдельный ключ, а не элемент общего списка: два примечания
  // подряд иначе могли бы прочитать одну и ту же версию списка и затереть друг
  // друга. В имени ключа — время: оно же служит идентификатором сообщения,
  // общим для очередей чата и примечаний, и ключи сортируются хронологически.
  const at = Date.now();
  await env.S.put(msgKey(leadId, at), text, {
    expirationTtl: SESSION_TTL,
    metadata: ask ? { at, ask, note_id: noteId } : { at, note_id: noteId },
  });

  await writeLog(env, {
    verdict: ask
      ? `менеджер просит у клиента ${ask === 'inn' ? 'ИНН' : 'телефон'} (сделка ${leadId})`
      : `ответ менеджера → виджет (сделка ${leadId})`,
    lead_id: leadId, note_id: noteId, user_id: note.created_by, text: text.slice(0, 200),
  });
}

const msgKey = (leadId, noteId) => `m:${leadId}:${String(noteId).padStart(14, '0')}`;

/**
 * Идёт ли переписка по партнёрской сделке. Партнёр общается с компанией,
 * а не с конкретным сотрудником, поэтому подпись менеджера там лишняя.
 *
 * Вебхук чатов знает только контакт, поэтому сделку берём из связки, которую
 * оставил приём заявки. Сделку могли перенести в другую воронку уже после
 * первого сообщения, поэтому воронку спрашиваем у amoCRM каждый раз, а не
 * запоминаем.
 */
async function partnerLead(contactId, env, cfg) {
  const partners = list(cfg.PARTNER_PIPELINES);
  if (!partners.length) return false;

  const leadId = await env.S.get(`lead-of:${contactId}`);
  if (!leadId) return false;

  try {
    const lead = await amo(`/api/v4/leads/${leadId}`, env);
    return partners.includes(String(lead?.pipeline_id ?? ''));
  } catch (e) {
    console.error('не удалось определить воронку сделки', e);
    return false;
  }
}

/** Дерево ключей объекта без значений — чтобы в журнале был виден формат. */
function shapeOf(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return typeof value;
  if (Array.isArray(value)) return `[${shapeOf(value[0], depth + 1)}]`;
  return `{${Object.entries(value).map(([k, v]) => `${k}:${shapeOf(v, depth + 1)}`).join(',')}}`;
}

/**
 * Вебхук чатов: менеджер ответил в переписке карточки.
 *
 * Кладём ответ в ту же очередь, откуда виджет забирает сообщения, только
 * ключ считается от контакта: чат живёт на контакте, а не на сделке, и одна
 * переписка переживает несколько сделок.
 */
async function handleChatHook(raw, env) {
  let body;
  try { body = JSON.parse(raw); } catch { return; }

  const parsed = parseWebhook(body);
  if (!parsed) return;

  // «site-123» — переписка виджета на сайте, «tg-123» — Telegram-канал: канал
  // чатов один на аккаунт, и по префиксу видно, куда доставлять ответ.
  const match = String(parsed.conversationId).match(/^(site|tg)-(\d+)$/);
  if (!match) {
    return writeLog(env, { verdict: 'скип: чужой чат', conversation: parsed.conversationId });
  }
  const [, source, contactId] = match;

  // Переписку Telegram-канала ведёт соседний воркер: у него ветки монофорума и
  // токен бота. Канал чатов один на аккаунт, вебхук приходит только сюда,
  // поэтому чужие ответы просто передаём дальше.
  if (source === 'tg') {
    if (!env.TG_FORWARD_URL) {
      return writeLog(env, { verdict: 'скип: некуда переслать ответ для Telegram', contact_id: contactId });
    }
    const res = await fetch(env.TG_FORWARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_id: contactId, text: parsed.text, author: parsed.author || '' }),
    });
    return writeLog(env, {
      verdict: `ответ менеджера → Telegram (контакт ${contactId}), ${res.status}`,
      contact_id: contactId, text: parsed.text.slice(0, 200),
    });
  }

  const author = await partnerLead(contactId, env, cfg) ? '' : parsed.author;

  const at = Date.now();
  await env.S.put(msgKey(`c${contactId}`, at), parsed.text, {
    expirationTtl: SESSION_TTL,
    metadata: author ? { at, author } : { at },
  });

  await writeLog(env, {
    verdict: `ответ менеджера из чата → виджет (контакт ${contactId})`,
    contact_id: contactId, author: parsed.author || '—', text: parsed.text.slice(0, 200),
    // Пока не подтверждено, где именно amojo кладёт имя автора: держим срез
    // структуры вебхука под рукой, чтобы поправить разбор без переписки.
    shape: shapeOf(body).slice(0, 300),
  });
}

/** Тег виджета на сделке — признак того, что клиент ждёт ответа в чате. */
async function taggedByWidget(leadId, env, cfg) {
  const lead = await amo(`/api/v4/leads/${leadId}`, env);
  const tags = (lead?._embedded?.tags || []).map((t) => norm(t.name));
  return tags.includes(norm(cfg.TAG_NAME));
}

/**
 * Ответы менеджера по сделке: новее `after` (id примечания) и не старше начала
 * сессии. Значения читаются только у подходящих ключей — на обычном опросе,
 * когда нового нет, обходимся одним list.
 */
async function readQueue(env, leadId, after, since) {
  const listed = await env.S.list({ prefix: `m:${leadId}:`, limit: MAX_QUEUE });
  const fresh = listed.keys
    .map((k) => ({
      key: k.name,
      id: Number(k.name.split(':').pop()),
      at: Number(k.metadata?.at) || 0,
      ask: k.metadata?.ask || null,
      author: k.metadata?.author || '',
    }))
    .filter((k) => k.id > after && k.at >= since);

  const out = [];
  for (const k of fresh) {
    const text = await env.S.get(k.key);
    // У команды менеджера («/инн») текста может не быть вовсе — она сама
    // по себе событие для виджета.
    if (text || k.ask) out.push({ id: k.id, text: text || '', at: k.at, ask: k.ask, author: k.author });
  }
  return out;
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

// ─────────────────────────── защита от спама ───────────────────────────

/**
 * Яндекс SmartCaptcha. Пока серверный ключ не задан, проверка выключена и
 * работают только лимиты по IP: виджет тоже рисует капчу лишь при наличии
 * клиентского ключа.
 * https://yandex.cloud/ru/docs/smartcaptcha/concepts/validation
 */
async function checkCaptcha(token, request, env) {
  if (!env.CAPTCHA_KEY) return;
  if (!token) throw new HttpError('Подтвердите, что вы не робот');

  const params = new URLSearchParams({
    secret: env.CAPTCHA_KEY,
    token,
    ip: clientIp(request),
  });
  const res = await fetch(`https://smartcaptcha.yandexcloud.net/validate?${params}`, { method: 'POST' });
  if (!res.ok) {
    // Сервис капчи недоступен — пропускаем: лучше принять заявку, чем потерять.
    console.error('smartcaptcha validate failed', res.status);
    return;
  }
  const data = await res.json();
  if (data.status !== 'ok') throw new HttpError('Проверка «я не робот» не пройдена, попробуйте ещё раз');
}

/**
 * Грубый счётчик на час: KV не атомарен, при одновременных запросах пара
 * попыток проскочит сверх лимита. Для отсечения спама этого достаточно.
 */
async function rateLimit(env, key, limit, message) {
  const bucket = `rate:${key}:${Math.floor(Date.now() / 3_600_000)}`;
  const used = Number(await env.S.get(bucket)) || 0;
  if (used >= limit) throw new HttpError(message, 429);
  await env.S.put(bucket, String(used + 1), { expirationTtl: 7200 });
}

// ─────────────────────────── утилиты ───────────────────────────

const field = (id, value) => ({ field_id: Number(id), values: [{ value: String(value) }] });
const multitext = (id, value) => ({ field_id: Number(id), values: [{ value: String(value), enum_code: 'WORK' }] });

async function amo(path, env, opts = {}) {
  const res = await fetch(`https://${env.AMO_SUBDOMAIN}.amocrm.ru${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.AMO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;             // «ничего не нашлось»
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`amo ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError('Ожидался JSON'); }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function originAllowed(origin, cfg) {
  const allowed = list(cfg.ALLOW_ORIGINS);
  return !allowed.length || !origin || allowed.includes(origin);
}

function corsHeaders(origin, cfg) {
  const allowed = list(cfg.ALLOW_ORIGINS);
  return {
    'Access-Control-Allow-Origin': !allowed.length ? (origin || '*') : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** 10 цифр у организации, 12 у ИП — длиннее или короче не бывает. */
const isInn = (v) => /^(\d{10}|\d{12})$/.test(String(v || ''));

/** «79991234567» → «+7 999 123-45-67» */
function formatRuPhone(value) {
  const d = digits(value).replace(/^8/, '7');
  if (d.length !== 11) return String(value);
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

const digits = (v) => String(v || '').replace(/\D/g, '');
const norm = (s) => String(s || '').trim().toLowerCase();
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function json(obj, origin, cfg, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin, cfg) },
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

// Кольцевой лог последних решений — единственный способ понять,
// что именно прилетело от amoCRM.
async function readLog(env) {
  try { return JSON.parse((await env.S.get('log')) || '[]'); } catch { return []; }
}

async function writeLog(env, entry) {
  const entries = await readLog(env);
  entries.unshift({ at: new Date().toISOString(), ...entry });
  await env.S.put('log', JSON.stringify(entries.slice(0, 50)));
}
