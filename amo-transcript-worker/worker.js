/**
 * amo-transcript-worker — кладёт расшифровку звонка текстом в примечание сделки.
 *
 * Телфин по окончании разговора прикрепляет к карточке контакта файл
 * «Перевод звонка в текст.txt» (штатная функция интеграции Телфин.Офис ↔
 * amoCRM, инструкция amocrm_telphin_office.pdf, стр. 35–36). Менеджеру, чтобы
 * узнать содержание разговора, приходится файл скачивать и открывать. Воркер
 * убирает этот шаг: берёт готовый текст — за распознавание уже заплачено — и
 * пишет его примечанием в ленту сделки.
 *
 * Поток:
 *   вебхук note_contact (вложение) → примечание догружается по id → если это
 *   «Перевод звонка в текст.txt», файл скачивается через Drive API → рядом
 *   ищется примечание-звонок (нужны длительность, направление, номер) →
 *   текст уходит примечанием в сделку контакта.
 *
 * Про Drive API: адрес сервиса файлов берётся из GET /api/v4/account?with=drive_url,
 * дальше GET {drive_url}/v1.0/files/{uuid} отдаёт метаданные со ссылкой
 * _links.download.href. Токену нужен scope «Доступ к файлам»:
 * https://www.amocrm.ru/developers/content/files/files-api
 * Долгосрочный токен наших остальных воркеров выпущен только со scope `crm`
 * и на файлах отвечает 403 «Invalid scope» — этому воркеру нужен свой.
 *
 * Лимит примечания — 20 000 символов (проверено на живом аккаунте:
 * 20 001 → 400 TooLong). Расшифровка занимает примерно 1 300 символов на
 * минуту речи, то есть в одно примечание помещается ~15 минут разговора.
 * Что длиннее — режется по строкам на несколько примечаний с пометкой
 * «часть N из M», чтобы реплика не рвалась посередине.
 *
 * Формат вебхука примечаний в документации amoCRM отсутствует, снят с живого
 * хука (см. README amo-phone-worker): contacts[note][0][note][…] с полями id,
 * element_id, element_type (1 контакт, 2 сделка), note_type числом.
 * Числовой код вложения неизвестен, поэтому тип проверяется не по хуку, а по
 * API — там он приходит строкой `attachment`.
 *
 * Секреты (.env рядом с воркером):
 *   AMO_SUBDOMAIN   — поддомен аккаунта без .amocrm.ru
 *   AMO_TOKEN       — долгосрочный токен со scope crm: примечания, сделки
 *   AMO_FILES_TOKEN — токен со scope files: только скачивание расшифровки.
 *                     Пусто — для файлов берётся AMO_TOKEN (если у него есть
 *                     оба права). amoCRM выдаёт права поштучно, и отдельный
 *                     токен «только файлы» — нормальный расклад.
 *   HOOK_SECRET     — произвольная строка, она же часть URL вебхука
 *
 * После записи текста файл удаляется (DELETE_FILE): дублировать расшифровку
 * в хранилище незачем. Удаление идёт только по факту успешной записи, а сам
 * файл попадает в корзину amoCRM — не в небытие.
 * Остальное — см. DEFAULTS.
 * KV binding: S (дедупликация + кольцевой лог для /debug).
 */

const DEFAULTS = {
  // Имя файла, который считаем расшифровкой. Регулярка, регистр не важен.
  TRANSCRIPT_NAME_RE: 'перевод звонка в текст',
  // Куда писать примечание: lead — в сделку, contact — в карточку контакта,
  // both — в обе. По умолчанию в сделку: именно её открывает менеджер.
  TARGET: 'lead',
  // Если сделки у контакта нет — писать в контакт, чтобы текст не пропал.
  FALLBACK_TO_CONTACT: 'true',
  // Разговоры короче этого не пишем: в расшифровке «Алло. Да. До свидания».
  // 0 — писать все.
  MIN_DURATION_SEC: '20',
  // Лимит текста примечания в amoCRM.
  MAX_NOTE_CHARS: '20000',
  // Окно назад от файла, в котором ищем примечание-звонок (файл приходит
  // через секунду после звонка, запас — на случай задержек).
  CALL_WINDOW_SEC: '900',
  // Шапка с направлением, длительностью и номером перед текстом.
  HEADER: 'true',
  // Дата примечания: file — на секунду позже файла, чтобы в ленте текст
  // стоял сразу за ним, даже если воркер сработал с задержкой или разбирает
  // историю; now — текущее время.
  NOTE_AT: 'file',
  // Сделку ищем среди созданных не позже, чем файл + столько секунд. Сделка
  // «Входящий +7…» появляется в начале разговора, файл — в конце, но менеджер
  // мог завести сделку руками уже после. Сделки, созданные сильно позже
  // звонка, — другое обращение, туда старый разговор не кладём.
  LEAD_GRACE_SEC: '300',
  // Удалять файл после того, как текст записан в примечание: он больше не
  // нужен, а место в хранилище аккаунта занимает. Удаляется только после
  // успешной записи — если запись не прошла, исключение случится раньше.
  // Файл уходит в корзину amoCRM, откуда его можно вернуть (restore).
  DELETE_FILE: 'true',
};

const ENTITY_BY_TYPE = { 1: 'contacts', 2: 'leads' };
const CALL_TYPES = ['call_in', 'call_out'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = { ...DEFAULTS, ...pick(env, Object.keys(DEFAULTS)) };
    const secret = env.HOOK_SECRET || '';

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'amo-transcript-worker', target: cfg.TARGET });
    }

    // Последние решения воркера: что прилетело и что с этим стало.
    if (secret && url.pathname === `/debug/${secret}`) {
      return json({ ok: true, log: await readLog(env) });
    }

    // Разовый прогон по конкретному примечанию — для проверки без звонка:
    // /replay/<секрет>?note_id=123&entity=contacts
    if (secret && url.pathname === `/replay/${secret}`) {
      const noteId = Number(url.searchParams.get('note_id'));
      const entity = url.searchParams.get('entity') || 'contacts';
      if (!noteId) return json({ ok: false, error: 'нужен note_id' }, 400);
      // dry=1 — только план: куда и с какой датой легло бы, без записи и удаления.
      const dry = url.searchParams.get('dry') === '1';
      try {
        const verdict = await onAttachment({ entity, noteId, dry }, env, cfg);
        return json({ ok: true, verdict });
      } catch (e) {
        return json({ ok: false, error: String(e).slice(0, 500) }, 500);
      }
    }

    if (request.method !== 'POST') {
      return new Response('amo-transcript-worker', { status: 200 });
    }
    if (secret && url.pathname !== `/amo/${secret}`) {
      return new Response('not found', { status: 404 });
    }

    const raw = await request.text();

    // amoCRM ретраит хук, если не ответить быстро, — разбор уходит в фон.
    ctx.waitUntil(
      handle(raw, env, cfg).catch(async (e) => {
        console.error('handle failed', e);
        await writeLog(env, { verdict: 'ошибка', error: String(e).slice(0, 400) });
      }),
    );
    return json({ ok: true });
  },
};

async function handle(raw, env, cfg) {
  const root = parseNested(new URLSearchParams(raw));

  const events = [];
  for (const [entity, bucket] of [
    ['contacts', root.contacts?.note],
    ['leads', root.leads?.note],
  ]) {
    for (const item of values(bucket)) {
      const note = item?.note || item;
      if (!note || typeof note !== 'object') continue;
      const where = ENTITY_BY_TYPE[String(note.element_type ?? '')] || entity;
      if (note.id) events.push({ entity: where, noteId: Number(note.id) });
    }
  }

  if (!events.length) {
    return log(env, {
      verdict: 'скип: в хуке нет примечаний',
      keys: [...new URLSearchParams(raw).keys()].slice(0, 40),
    });
  }

  for (const event of events) {
    const verdict = await onAttachment(event, env, cfg);
    await log(env, { verdict, ...event });
  }
}

/** Пришло примечание. Расшифровка ли это и что с ней делать. */
async function onAttachment({ entity, noteId, dry = false }, env, cfg) {
  // Тип берём из API: в хуке он числом, и кода вложения мы не знаем.
  const note = await oneNote(entity, noteId, env);
  if (!note) return 'скип: примечание не нашлось в API';
  if (note.note_type !== 'attachment') return `скип: примечание типа ${note.note_type}`;

  const name = note.params?.original_name || note.params?.text || '';
  let re;
  try {
    re = new RegExp(cfg.TRANSCRIPT_NAME_RE, 'i');
  } catch {
    return 'ошибка: TRANSCRIPT_NAME_RE не компилируется';
  }
  if (!re.test(name)) return `скип: файл «${name.slice(0, 60)}» — не расшифровка`;

  const uuid = note.params?.file_uuid;
  if (!uuid) return 'скип: у вложения нет file_uuid';

  const doneKey = `done:${uuid}`;
  if (!dry && env.S && (await env.S.get(doneKey))) return 'скип: этот файл уже разобран';

  // Звонок нужен для шапки и для отсечки коротких разговоров.
  const call = await findCall(entity, note.entity_id, note.created_at, env, cfg);
  const minDuration = Number(cfg.MIN_DURATION_SEC) || 0;
  if (call && minDuration && Number(call.params?.duration || 0) < minDuration) {
    if (!dry && env.S) await env.S.put(doneKey, '1', { expirationTtl: 2592000 });
    return `скип: звонок ${call.params?.duration} с, короче ${minDuration} с`;
  }

  const text = (await downloadFile(uuid, env)).trim();
  if (!text) return 'скип: файл пустой';

  const fileAt = Number(note.created_at) || nowSec();
  const targets = await resolveTargets(entity, note.entity_id, fileAt, env, cfg);
  if (!targets.length) return 'скип: некуда писать — у контакта нет сделок';

  // Примечание встаёт на секунду позже файла — прямо за ним в ленте.
  const noteAt = cfg.NOTE_AT === 'now' ? nowSec() : fileAt + 1;
  const head = header(call, cfg);
  const parts = splitText(text, head, Number(cfg.MAX_NOTE_CHARS) || 20000);

  if (dry) {
    return `план: ${targets.map((t) => `${t.entity}/${t.id}`).join(', ')} · дата ${new Date(noteAt * 1000).toISOString()} · ${parts.length} прим., ${text.length} симв. · ${head || 'без шапки'}`;
  }

  const written = [];
  for (const { entity: target, id } of targets) {
    // Страховка от повторов помимо KV: тот же текст в той же карточке
    // (например, когда историю разбирали ещё до появления отметок).
    if (await alreadyThere(target, id, parts[0], env)) {
      written.push(`${target}/${id} (уже было)`);
      continue;
    }
    for (let i = 0; i < parts.length; i++) {
      await amo(`/api/v4/${target}/${id}/notes`, env, {
        method: 'POST',
        // Части идут с шагом в секунду, чтобы порядок в ленте совпадал с номером.
        body: [{ note_type: 'common', created_at: noteAt + i, params: { text: parts[i] } }],
      });
    }
    written.push(`${target}/${id}`);
  }

  if (env.S) await env.S.put(doneKey, '1', { expirationTtl: 2592000 });

  let removed = '';
  if (cfg.DELETE_FILE === 'true') {
    try {
      await removeFile(entity, note.entity_id, uuid, env);
      removed = ', файл удалён';
    } catch (e) {
      // Текст уже в сделке — ради неудавшейся уборки задачу не заваливаем.
      removed = `, файл остался (${String(e.message || e).slice(0, 120)})`;
    }
  }

  return `записано в ${written.join(', ')}: ${parts.length} прим., ${text.length} симв.${removed}`;
}

/**
 * Убираем файл: сначала открепляем от карточки, потом удаляем из хранилища.
 * Порядок важен — открепление у уже удалённого файла смысла не имеет.
 * Оба метода требуют scope files (удаление — ещё и «Удаление файлов»).
 * https://www.amocrm.ru/developers/content/files/files-api
 *
 * Примечание-вложение в ленте останется: удаления примечаний в API v4 нет
 * (DELETE /api/v4/{entity}/notes → 405).
 */
async function removeFile(entity, entityId, uuid, env) {
  const token = env.AMO_FILES_TOKEN || env.AMO_TOKEN;

  await amo(`/api/v4/${entity}/${entityId}/files`, env, {
    method: 'DELETE',
    body: [{ file_uuid: uuid }],
    token,
  });

  const drive = await driveUrl(env);
  const res = await fetch(`${drive}/v1.0/files`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ uuid }]),
  });
  if (!res.ok) {
    throw new Error(`удаление ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Куда класть текст: сделка контакта, сам контакт или и то и другое. */
async function resolveTargets(entity, entityId, fileAt, env, cfg) {
  const want = String(cfg.TARGET || 'lead').toLowerCase();

  if (entity === 'leads') return [{ entity: 'leads', id: entityId }];

  const out = [];
  if (want === 'contact' || want === 'both') out.push({ entity: 'contacts', id: entityId });

  if (want === 'lead' || want === 'both') {
    const leadId = await leadForCall(entityId, fileAt, env, cfg);
    if (leadId) out.push({ entity: 'leads', id: leadId });
    else if (cfg.FALLBACK_TO_CONTACT === 'true' && !out.length) {
      out.push({ entity: 'contacts', id: entityId });
    }
  }
  return out;
}

/**
 * Сделка, к которой относится звонок: последняя из существовавших на момент
 * файла (с запасом LEAD_GRACE_SEC на сделку, заведённую сразу после
 * разговора). Для живого звонка это просто последняя сделка контакта; для
 * истории — та, что была текущей тогда, а не заведённая неделю спустя.
 * Если все сделки моложе звонка — берём самую раннюю: скорее всего, её
 * завели по итогам этого разговора.
 */
async function leadForCall(contactId, fileAt, env, cfg) {
  const contact = await amo(`/api/v4/contacts/${contactId}?with=leads`, env);
  const ids = (contact?._embedded?.leads || []).map((l) => l.id).filter(Boolean);
  if (!ids.length) return null;

  const query = ids.map((id) => `filter[id][]=${id}`).join('&');
  const res = await amo(`/api/v4/leads?${query}&limit=250`, env);
  const leads = (res?._embedded?.leads || [])
    .map((l) => ({ id: l.id, at: Number(l.created_at) || 0 }))
    .sort((a, b) => a.at - b.at);
  if (!leads.length) return ids[ids.length - 1];

  const grace = Number(cfg.LEAD_GRACE_SEC) || 0;
  const before = leads.filter((l) => l.at <= fileAt + grace);
  return before.length ? before[before.length - 1].id : leads[0].id;
}

/** Есть ли уже в карточке примечание с этим текстом. */
async function alreadyThere(entity, id, firstPart, env) {
  const res = await amo(`/api/v4/${entity}/${id}/notes?filter[note_type]=common&limit=250`, env);
  const probe = firstPart.slice(0, 300);
  return (res?._embedded?.notes || []).some((n) => String(n.params?.text || '').startsWith(probe));
}

/** Примечание-звонок рядом с файлом: направление, длительность, номер. */
async function findCall(entity, entityId, fileAt, env, cfg) {
  const window = Number(cfg.CALL_WINDOW_SEC) || 900;
  const res = await amo(`/api/v4/${entity}/${entityId}/notes?limit=50`, env);
  const notes = res?._embedded?.notes || [];
  let best = null;
  for (const n of notes) {
    if (!CALL_TYPES.includes(n.note_type)) continue;
    const delta = Number(fileAt) - Number(n.created_at);
    if (delta < -60 || delta > window) continue;
    if (!best || Number(n.created_at) > Number(best.created_at)) best = n;
  }
  return best;
}

function header(call, cfg) {
  if (cfg.HEADER !== 'true') return '';
  const bits = ['Расшифровка звонка'];
  if (call) {
    bits.push(call.note_type === 'call_in' ? 'входящий' : 'исходящий');
    const d = Number(call.params?.duration || 0);
    if (d) bits.push(`${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`);
    if (call.params?.phone) bits.push(call.params.phone);
  }
  return bits.join(' · ');
}

/**
 * Режем по строкам, а не по символам: реплика «[01:07 → 01:14] Менеджер: …»
 * разорванная посередине читается хуже, чем лишняя часть.
 */
function splitText(text, head, limit) {
  const reserve = head ? head.length + 24 : 0;     // шапка + « (часть 1 из 9)»
  const room = Math.max(500, limit - reserve);
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const piece = line.length > room ? line.slice(0, room) : line;
    if (cur && cur.length + piece.length + 1 > room) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);

  return chunks.map((chunk, i) => {
    if (!head) return chunk;
    const label = chunks.length > 1 ? `${head} (часть ${i + 1} из ${chunks.length})` : head;
    return `${label}\n\n${chunk}`;
  });
}

// ─────────────────────────── amoCRM ───────────────────────────

/** Примечание по id: тип и параметры, которых нет в хуке. */
async function oneNote(entity, noteId, env) {
  const res = await amo(`/api/v4/${entity}/notes?filter[id]=${noteId}`, env);
  return res?._embedded?.notes?.[0] || null;
}

/**
 * Скачивание файла из хранилища amoCRM. Два шага: метаданные с временной
 * ссылкой, затем сама ссылка. Адрес хранилища у каждого аккаунта свой,
 * поэтому берётся из настроек аккаунта и кешируется на сутки.
 */
async function downloadFile(uuid, env) {
  const token = env.AMO_FILES_TOKEN || env.AMO_TOKEN;
  const drive = await driveUrl(env);
  const meta = await fetchJson(`${drive}/v1.0/files/${uuid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const href = meta?._links?.download?.href;
  if (!href) throw new Error(`нет ссылки на скачивание: ${JSON.stringify(meta).slice(0, 200)}`);

  const res = await fetch(href, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`скачивание ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.text();
}

async function driveUrl(env) {
  const cached = env.S ? await env.S.get('drive_url') : null;
  if (cached) return cached;
  const account = await amo('/api/v4/account?with=drive_url', env);
  const url = String(account?.drive_url || '').replace(/\/+$/, '');
  if (!url) throw new Error('в аккаунте нет drive_url');
  if (env.S) await env.S.put('drive_url', url, { expirationTtl: 86400 });
  return url;
}

async function amo(path, env, opts = {}) {
  const res = await fetch(`https://${env.AMO_SUBDOMAIN}.amocrm.ru${path}`, {
    method: opts.method || 'GET',
    headers: {
      // Методы файлов живут на том же домене, но требуют токен с правом
      // на файлы — его передаёт вызывающий.
      Authorization: `Bearer ${opts.token || env.AMO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`amo ${opts.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;      // 204 «ничего не найдено» → null
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ─────────────────────────── мелочи ───────────────────────────

/** `contacts[note][0][note][id]=…` → вложенный объект. */
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

async function readLog(env) {
  if (!env.S) return [];
  try { return JSON.parse((await env.S.get('log')) || '[]'); } catch { return []; }
}
async function writeLog(env, entry) {
  if (!env.S) return;
  const log = await readLog(env);
  log.push({ ts: new Date().toISOString(), ...entry });
  await env.S.put('log', JSON.stringify(log.slice(-40)));
}
async function log(env, entry) {
  console.log(JSON.stringify(entry));
  await writeLog(env, entry);
}

const nowSec = () => Math.floor(Date.now() / 1000);
const values = (obj) => (obj && typeof obj === 'object' ? Object.values(obj) : []);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k]) out[k] = obj[k];
  return out;
}
