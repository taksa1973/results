/**
 * KPI отдела ассистентов — Cloudflare Worker + D1.
 *
 * Роли:
 *   assistant — видит только себя
 *   lead      — видит весь отдел, правит настройки, выдаёт ключи
 *   chief     — руководитель: принимает работу одним «да/нет», видит сводку
 *
 * Никаких субъективных оценок в базе нет. Хранятся только события с временем,
 * а все цифры выводятся из них на лету — поэтому любую можно развернуть
 * до списка задач, из которых она сложилась.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

// ── утилиты ──────────────────────────────────────────────────────────────────

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const bad = (msg, status = 400) => json({ error: msg }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
}

const nowIso = () => new Date().toISOString();

function currentPeriod(offsetHours = 3) {
  const d = new Date(Date.now() + offsetHours * 3600e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Разница в минутах между двумя ISO-отметками. */
function minutesBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
}

/** Квартал по месяцу: 2026-08 → 2026-Q3. */
function quarterOf(period) {
  const [y, m] = String(period).split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/** Три месяца квартала: 2026-Q3 → ['2026-07','2026-08','2026-09']. */
function monthsOfQuarter(quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const first = (q - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${y}-${String(first + i).padStart(2, '0')}`);
}

const MARKS = ['minus', 'plusminus', 'plus', 'plus2', 'plus3', 'plus4'];
const MARK_LABEL = {
  minus: '−', plusminus: '+−', plus: '+', plus2: '++', plus3: '+++', plus4: '++++',
};

/** Человекочитаемая длительность: 95 → «1 ч 35 мин». */
function humanMinutes(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} д ${h % 24} ч`;
}

/** Рабочие минуты словами: день здесь — восемь часов, а не двадцать четыре. */
function humanWorkMinutes(m, settings = {}) {
  if (m === null || m === undefined) return '—';
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const dayH = Math.round(workWindow(settings).dayMin / 60);
  if (h < dayH) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  const d = Math.floor(h / dayH);
  const hh = h % dayH;
  return `${d} раб. дн${hh ? ` ${hh} ч` : ''}`;
}

// ── настройки ────────────────────────────────────────────────────────────────

async function loadSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const row of results) s[row.key] = row.value;
  return s;
}

const num = (s, key, fallback = 0) => {
  const v = parseFloat(s[key]);
  return Number.isFinite(v) ? v : fallback;
};

// ── аутентификация ───────────────────────────────────────────────────────────

async function authenticate(request, db) {
  const key =
    request.headers.get('x-access-key') ||
    new URL(request.url).searchParams.get('key');
  if (!key) return null;
  const hash = await sha256(key);
  const user = await db
    .prepare('SELECT id, name, role, grade, salary FROM users WHERE key_hash = ? AND active = 1')
    .bind(hash)
    .first();
  return user || null;
}

// ── расчёт метрик ────────────────────────────────────────────────────────────

/**
 * Оценка одной задачи. Ничего не спрашивает у человека:
 * три признака снимаются с событий, четвёртый — ответ руководителя
 * по инициативе (и только по ней).
 */
// Цена переделок. Первая дешевле остальных: один раз вернуть на доработку —
// обычное дело, а вот кружить по одной задаче раз за разом — нет.
//   0 → 10   1 → 9   2 → 7   3 → 5   4 → 3   5 → 1   6 и больше → 0
const RETURN_FIRST_COST = 1;
const RETURN_NEXT_COST = 2;

/**
 * Оценка одной задачи по трём признакам, которые система снимает сама.
 *
 * Признака «инициатива» больше нет: все задачи заводит руководитель отдела,
 * измерять там нечего. Поэтому три признака и есть максимум — десятка
 * означает «сделал то, о чём договорились, вовремя и никого не отвлекая».
 */
function scoreTask(task) {
  if (task.status === 'failed') {
    return { score: 0, flags: { inTime: false, noReturns: false, noChief: false }, reason: 'сорвана' };
  }

  // Время в блокере и ожидании не идёт против исполнителя, но у поблажки
  // есть потолок: иначе задачу можно было бы держать в паузе месяцами
  // ради бесконечного сдвига срока.
  const dayMin = workWindow(task.settings || {}).dayMin;
  const pauseCap = Math.max(
    (task.priority || 7) * dayMin,  // столько же рабочих минут, сколько дано на задачу
    3 * dayMin                      // но не меньше трёх рабочих дней
  );
  const pauseCredit = Math.min(task.paused_min || 0, pauseCap);
  const effectiveDeadline = task.deadline
    ? new Date(pauseCredit > 0 ? addWorkMinutes(task.deadline, pauseCredit) : task.deadline)
    : null;

  // Срок меряется по моменту, когда ассистент сдал работу, а не когда
  // карточка закрылась: заказ гаджета оценивается в день заказа,
  // а не когда посылка доехала из США.
  const finishedAt = task.work_done_at || task.done_at;

  const inTime = effectiveDeadline && finishedAt
    ? new Date(finishedAt) <= effectiveDeadline
    : !task.deadline; // без дедлайна признак не снимается — считается выполненным
  const noReturns = (task.returns || 0) === 0;
  const noChief = !task.chief_touched || task.disputed === 1;

  // Качество отвечает только за одно: сколько раз пришлось переделывать.
  // Срок целиком ушёл в «Скорость», вопросы к руководителю — целиком
  // в «Самостоятельность». Раньше один и тот же промах бил дважды:
  // просрочка резала и качество, и скорость.
  //
  // Первая правка почти не штрафуется: уточнить и доделать — нормальный
  // рабочий ход. А вот каждая следующая дороже, и на шестой задача
  // обнуляется: двадцать кругов по одной задаче — это уже не работа.
  const returns = task.returns || 0;
  const score = returns === 0
    ? 10
    : Math.max(0, 10 - RETURN_FIRST_COST - (returns - 1) * RETURN_NEXT_COST);

  return { score, flags: { inTime, noReturns, noChief }, reason: null };
}

/** Эффективный размер задачи с поправкой на ночь и выходные. */
const taskWeight = (t) => (t.size || 1) * (t.night ? 1.5 : 1);

/**
 * Все четыре оценки человека за период.
 * Возвращает и сами цифры, и «из чего они сложились» — вторая часть
 * важнее первой: без неё цифру нельзя аргументировать.
 */
function computeMetrics({ tasks, replies, settings, grade }) {
  // В зачёт идут задачи, где ассистент закончил свою часть, — даже если
  // карточка ещё открыта. Заказ гаджета оценивается в месяц заказа,
  // а не когда посылка доехала.
  const closed = tasks.filter(
    (t) => ['accepted', 'failed'].includes(t.status) || (t.work_done_at && t.status === 'waiting')
  );

  // Месяц без единого закрытого дела и без единого ответа в чате — это не
  // «нет данных, начислим по умолчанию», а отсутствие работы. Иначе человек,
  // который весь месяц молчал, получал бы часть бонуса просто за тишину.
  // Задачи «в работе» сами по себе не заслуга: пока ничего не закрыто
  // и ни на один вопрос не отвечено, начислять нечего. Иначе в первый же
  // месяц все получили бы часть бонуса просто за наличие задач в трекере.
  const idle = closed.length === 0 && replies.length === 0;

  // Качество — средневзвешенная оценка задач
  let points = 0;
  let weight = 0;
  const scored = closed.map((t) => {
    const s = scoreTask(t);
    const w = taskWeight(t);
    points += s.score * w;
    weight += w;
    return { ...t, ...s, weight: w };
  });
  const quality = weight > 0 ? points / weight : 0;

  // Реакция в чате — балльная. Один пропуск стоит трёх быстрых ответов,
  // поэтому провал начала месяца отыгрывается, а не ставит крест.
  // Ответ в нерабочее время ценнее рабочего: отвечать было не обязательно.
  const chat = scoreChat(replies, settings);

  const withDeadline = closed.filter((t) => t.deadline);
  const inTimeCount = withDeadline.filter((t) => scoreTask(t).flags.inTime).length;
  const slaRate = withDeadline.length ? inTimeCount / withDeadline.length : 0;
  const slaScore = slaRate * 10;

  // Срок учитывается только если его вообще проставляют.
  //
  // По умолчанию скорость — это 4 балла за реакцию и 6 за попадание в срок.
  // Но если сроков нет почти нигде, вторую часть некому набрать, и человек
  // терял бы больше половины кошелька за то, что задачи ставят без дат.
  // В таком месяце скорость меряется по одной реакции — по тому, что есть.
  const coverage = closed.length ? withDeadline.length / closed.length : 0;
  const minCoverage = num(settings, 'sla_min_coverage', 0.3);
  const slaCounts = withDeadline.length > 0 && coverage >= minCoverage;

  const speed = slaCounts
    ? Math.max(0, Math.min(10, 0.4 * chat.score + 0.6 * slaScore))
    : chat.score;

  // Автономность — доля задач без вовлечения руководителя, отнесённая к норме
  const normAut = num(settings, `norm_autonomy_${grade}`, 0.85);
  const soloCount = closed.filter((t) => scoreTask(t).flags.noChief).length;
  const soloRate = closed.length ? soloCount / closed.length : 0;
  const autonomy = Math.min(10, normAut > 0 ? (soloRate / normAut) * 10 : 0);

  return {
    // Пустой месяц не приносит денег: без задач и без ответов метрика
    // не «нет данных», а ноль. Иначе тишина оплачивалась бы наравне с работой.
    quality: idle ? 0 : round2(quality),
    speed: idle ? 0 : round2(speed),
    autonomy: idle ? 0 : round2(autonomy),
    idle,

    // По каким метрикам вообще была база. Метрика без базы не платится
    // и не наказывает: её кошелёк расходится по остальным.
    usable: {
      quality: closed.length > 0,
      autonomy: closed.length > 0,
      // скорость меряется по чату: нет вопросов — нечего мерить
      speed: chat.reference > 0 || chat.off > 0 || withDeadline.length > 0,
    },
    breakdown: {
      idle: idle ? 'за период нет ни задач, ни ответов в чате — бонус не начисляется' : null,
      quality: {
        tasks: closed.length,
        weight: round2(weight),
        points: round2(points),
        formula: `${round2(points)} баллов ÷ ${round2(weight)} размеров`,
      },
      speed: {
        chatScore: chat.score,
        chatPoints: chat.points,
        requests: chat.reference,
        repliesFast: chat.fast,
        repliesSlow: chat.slow,
        offHoursAnswered: chat.off,
        misses: chat.miss,
        medianReply: chat.median,
        chatFormula: chat.formula,
        detail: chat.detail,
        withDeadline: withDeadline.length,
        inTime: inTimeCount,
        slaRate: pct(slaRate),
        slaScore: round2(slaScore),
        slaCounts,
        slaCoverage: pct(coverage),
        formula: slaCounts
          ? `реакция ${chat.score} × 0.4 + срок ${round2(slaScore)} × 0.6`
          : `только реакция ${chat.score}: срок проставлен у ${withDeadline.length} из ${closed.length} задач`,
      },
      autonomy: {
        solo: soloCount,
        of: closed.length,
        rate: pct(soloRate),
        norm: pct(normAut),
        formula: `${pct(soloRate)} ÷ ${pct(normAut)} × 10`,
      },
    },
    scored,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Метрики времени: Time to start и Time to fill по трём уровням сложности
//
// Time to start — от постановки задачи до момента, когда её взяли в работу.
// Time to fill  — сколько задача была в работе: от переноса в «В работе»
//                 до сдачи, без блокера и ожидания.
//
// Обе в рабочих часах: ночь и выходные не идут в счёт, иначе задача,
// поставленная в пятницу вечером, показывала бы двое суток простоя.
// Метрики независимы: поздний старт бьёт только по первой, долгая работа —
// только по второй. Задача, не побывавшая в «В работе», во вторую не входит.
// ─────────────────────────────────────────────────────────────────────────────

const LEVELS = [1, 2, 3];
const TIME_METRICS = ['t2s', 't2f'];

/** Размер со стикера в уровень сложности: S → 1, M → 2, L и XL → 3. */
function sizeToLevel(size) {
  const s = Number(size) || 1;
  return s <= 1 ? 1 : s === 2 ? 2 : 3;
}

/**
 * Приоритеты, которые в модель времени не входят. По умолчанию — «30»,
 * задачи на месяц: у них нет ни срочности старта, ни осмысленного времени
 * сдачи, они только размывают среднее.
 */
function skipPriorities(settings = {}) {
  return new Set(
    String(settings.skip_priority ?? '30').split(',').map((v) => Number(v.trim())).filter((v) => v > 0)
  );
}

/** Уровень сложности задачи: проставленный при синхронизации, иначе по размеру. */
function levelOfTask(task) {
  if (task.level) return task.level;
  return sizeToLevel(task.size);
}

/** Часы обеих стадий для одной задачи. null, если стадия ещё не наступила. */
function taskDurations(task, settings) {
  const from = task.created_at;
  const toStart = task.taken_at;
  const toFill = task.work_done_at || task.done_at;

  // Пауза в блокере и ожидании не идёт против исполнителя
  const pause = task.paused_min || 0;
  const hours = (a, b, subtractPause) => {
    if (!a || !b) return null;
    const mins = workMinutesBetween(a, b, settings) - (subtractPause ? pause : 0);
    return Math.max(0, Math.round((mins / 60) * 100) / 100);
  };

  return { t2s: hours(from, toStart, false), t2f: hours(toStart, toFill, true) };
}

/** Попадает ли момент в месяц вида 2026-09. */
const inPeriod = (iso, period) => Boolean(iso) && String(iso).slice(0, 7) === period;

/**
 * Шесть метрик человека за период: среднее время по каждому уровню.
 *
 * Задача относится к месяцу по событию, а не по постановке: «до старта» —
 * к месяцу, когда её взяли, «в работе» — когда сдали. Так сентябрьская
 * работа над августовской задачей считается в сентябре. Без периода
 * (в тестах) берётся всё подряд.
 */
function timeMetrics(tasks, settings, period = null) {
  const out = {};
  const detail = {};
  const skip = skipPriorities(settings);
  const eventOf = { t2s: (t) => t.taken_at, t2f: (t) => t.work_done_at || t.done_at };

  for (const metric of TIME_METRICS) {
    for (const level of LEVELS) {
      const key = `${metric}${level}`;
      const vals = tasks
        .filter((t) => levelOfTask(t) === level && !t.is_zaeb && t.status !== 'cancelled' && !skip.has(Number(t.priority)))
        .filter((t) => !period || inPeriod(eventOf[metric](t), period))
        .map((t) => taskDurations(t, settings)[metric])
        .filter((v) => v !== null);

      out[key] = vals.length
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
        : null;
      detail[key] = { count: vals.length, values: vals };
    }
  }
  return { metrics: out, detail };
}

/**
 * Процент закрытия плана. Для времени меньше — лучше, поэтому берётся
 * отношение плана к факту: уложился вдвое быстрее — двести процентов.
 */
function planPercent(fact, plan) {
  if (fact === null || fact === undefined || !plan) return null;
  if (fact <= 0) return 200; // мгновенно — считаем верхней границей, а не бесконечностью
  return Math.round(Math.min(200, (plan / fact) * 100));
}

/** Оценка, которую система предлагает по проценту закрытия плана. */
function autoMark(percent, settings = {}) {
  if (percent === null || percent === undefined) return null;
  const over = num(settings, 'overplan_percent', 120);
  if (percent < 70) return 'minus';
  if (percent < 90) return 'plusminus';
  if (percent < 110) return 'plus';
  if (percent < over) return 'plus2';
  if (percent < over + 20) return 'plus3';
  return 'plus4';
}

/** Плановые значения на квартал: берём последние, что действуют не позже него. */
async function loadSla(db, quarter) {
  const { results } = await db
    .prepare('SELECT metric, level, hours, valid_from FROM sla WHERE valid_from <= ? ORDER BY valid_from')
    .bind(quarter)
    .all();
  const map = {};
  for (const r of results) map[`${r.metric}${r.level}`] = r.hours; // поздние перекрывают ранние
  return map;
}

/** Метрики человека за один месяц вместе с процентом закрытия плана. */
async function monthMetrics(db, userId, period, settings, sla) {
  // Без userId — весь отдел: так строится срез «как все закрывают уровень N».
  const who = userId
    ? { sql: 'assignee_id = ?', args: [userId] }
    : { sql: "assignee_id IN (SELECT id FROM users WHERE role = 'assistant' AND active = 1)", args: [] };

  // Задачи месяца — взятые в работу или сданные в нём. Поставленные, но
  // не тронутые, сюда не попадают: по ним ещё нечего мерить.
  const skip = [...skipPriorities(settings)];
  const from = `${period}-01`, to = `${period}-32`;
  const { results: tasks } = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${who.sql} AND is_zaeb = 0
         AND status NOT IN ('cancelled','historical')
         AND ((taken_at >= ? AND taken_at < ?)
           OR (COALESCE(work_done_at, done_at) >= ? AND COALESCE(work_done_at, done_at) < ?))
         ${skip.length ? `AND (priority IS NULL OR priority NOT IN (${skip.map(() => '?').join(',')}))` : ''}
       ORDER BY COALESCE(taken_at, created_at)`
    )
    .bind(...who.args, from, to, from, to, ...skip)
    .all();

  const { metrics, detail } = timeMetrics(tasks, settings, period);
  const takenHere = tasks.filter((t) => inPeriod(t.taken_at, period)).length;
  const doneHere = tasks.filter((t) => inPeriod(t.work_done_at || t.done_at, period)).length;
  const percents = {};
  for (const key of Object.keys(metrics)) {
    percents[key] = planPercent(metrics[key], sla[key]);
  }

  const live = Object.values(percents).filter((v) => v !== null);
  return {
    period,
    metrics,
    percents,
    detail,
    count: tasks.length,
    taken: takenHere,
    done: doneHere,
    // Список задач с часами — для раскрытого месяца: видно, какая именно
    // задача тянет среднее вверх. У каждой помечено, какой из двух метрик
    // она принадлежит в этом месяце.
    tasks: tasks.map((t) => {
      const d = taskDurations(t, settings);
      const inStart = inPeriod(t.taken_at, period);
      const inFill = inPeriod(t.work_done_at || t.done_at, period);
      return {
        id: t.id, number: t.project_no || t.number, title: t.title, url: t.url, assignee_id: t.assignee_id,
        level: levelOfTask(t), level_src: t.level_src || 'default',
        status: t.status, created_at: t.created_at, taken_at: t.taken_at,
        done_at: t.work_done_at || t.done_at, priority: t.priority,
        t2s: inStart ? d.t2s : null, t2f: inFill ? d.t2f : null,
        t2s_all: d.t2s, t2f_all: d.t2f,
      };
    }),
    // Среднее закрытие плана по тем метрикам, где были задачи.
    // Метрика без задач в среднее не входит: месяц без сложных задач
    // не должен ни портить результат, ни улучшать его.
    avgPercent: live.length ? Math.round(live.reduce((a, b) => a + b, 0) / live.length) : null,
  };
}

/** Квартал: три месяца, среднее по каждой метрике и итоговый процент. */
async function quarterMetrics(db, userId, quarter, settings) {
  const sla = await loadSla(db, quarter);
  const months = [];
  for (const period of monthsOfQuarter(quarter)) {
    months.push(await monthMetrics(db, userId, period, settings, sla));
  }

  const metrics = {};
  const percents = {};
  for (const metric of TIME_METRICS) {
    for (const level of LEVELS) {
      const key = `${metric}${level}`;
      const vals = months.map((m) => m.metrics[key]).filter((v) => v !== null);
      metrics[key] = vals.length
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
        : null;
      percents[key] = planPercent(metrics[key], sla[key]);
    }
  }

  const live = Object.values(percents).filter((v) => v !== null);
  const avgPercent = live.length
    ? Math.round(live.reduce((a, b) => a + b, 0) / live.length)
    : null;

  return { quarter, months, metrics, percents, sla, avgPercent, markAuto: autoMark(avgPercent, settings) };
}

/** Премия за квартал по матрице «грейд × оценка». */
async function quarterBonus(db, grade, mark, salaryQuarter) {
  if (!mark || !grade) return { percent: 0, sum: 0 };
  const row = await db
    .prepare('SELECT percent FROM bonus_matrix WHERE grade = ? AND mark = ?')
    .bind(grade, mark)
    .first();
  const percent = row ? row.percent : 0;
  return { percent, sum: Math.round(((salaryQuarter || 0) * percent) / 100) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ежемесячная оценка 0–10 и KPI руководителя отдела.
//
// Оценка каждого выводится из модели времени — процент плана за месяц.
// Руководитель может поправить её руками, и ручная важнее: «Катя — шесть,
// не больше». KPI руководителя — среднее оценок отдела вместе с его
// собственной: он на десять, сотрудник на пять — итого семь с половиной.
// Премия месяца — доля от максимума (50 000 ₽), заёбы и экономия отдельно.
// ─────────────────────────────────────────────────────────────────────────────

/** Процент плана в оценку: 60 % → 6, 100 % и выше → 10. */
function scoreFromPercent(percent) {
  if (percent === null || percent === undefined) return null;
  return Math.round(Math.min(10, Math.max(0, percent / 10)) * 10) / 10;
}

/** Оценка человека за месяц: автоматическая, а поставленная руками — важнее. */
async function monthScore(db, user, period, settings, sla) {
  const month = await monthMetrics(db, user.id, period, settings, sla);
  const auto = scoreFromPercent(month.avgPercent);
  const row = await db
    .prepare('SELECT manual, note, actor, at FROM month_scores WHERE user_id = ? AND period = ?')
    .bind(user.id, period)
    .first();
  const manual = row && row.manual !== null && row.manual !== undefined ? Number(row.manual) : null;
  return {
    auto,
    manual,
    score: manual ?? auto,
    note: row?.note || null,
    actor: row?.actor || null,
    at: row?.at || null,
    month,
  };
}

/**
 * KPI руководителя за месяц. Человек без оценки — ни задач, ни ручной —
 * в среднее не входит: месяц без работы не должен ни тянуть вниз, ни дарить.
 */
async function leadKpi(db, lead, period, settings) {
  const sla = await loadSla(db, quarterOf(period));
  const { results: people } = await db
    .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
    .all();

  // Сколько задач висит на человеке прямо сейчас — независимо от месяца.
  // Без этого «0 задач за месяц» читается как «нечего делать», хотя может
  // значить обратное: ничего нового не взято, а старое не сдано.
  const openCount = async (id) => (await db
    .prepare(`SELECT count(*) AS n FROM tasks WHERE assignee_id = ? AND is_zaeb = 0
              AND status IN ('open','in_progress','review','blocked','waiting')`)
    .bind(id).first()).n;

  const rows = [];
  for (const p of people) {
    const sc = await monthScore(db, p, period, settings, sla);
    rows.push({ id: p.id, name: p.name, ...sc, open: await openCount(p.id) });
  }
  const own = { ...(await monthScore(db, lead, period, settings, sla)), open: await openCount(lead.id) };

  const scores = [own.score, ...rows.map((r) => r.score)].filter((v) => v !== null && v !== undefined);
  const score = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null;
  const max = num(settings, 'lead_kpi_max', 50000);

  return {
    period,
    own,
    people: rows,
    score,
    counted: scores.length,
    max,
    bonus: score === null ? 0 : Math.round((max * score) / 10),
    sla,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n) => `${Math.round(n * 1000) / 10} %`;

/**
 * Реакция в чате в баллах.
 *
 * Один пропуск стоит ровно трёх быстрых ответов, поэтому провал в начале
 * месяца отыгрывается — до десятки дойти можно всегда. Выше десятки нельзя.
 * Ответ в нерабочее время ценнее рабочего: отвечать было не обязательно.
 *
 * Ориентир для нормировки — количество вопросов рабочего времени:
 * ответить быстро на все и есть «десятка».
 */
function scoreChat(replies, settings) {
  const target = num(settings, 'reply_target_min', 15);
  const urgentTarget = num(settings, 'urgent_target_min', 5);
  const ptFast = num(settings, 'pt_fast', 0.5);
  const ptSlow = num(settings, 'pt_slow', -2);
  const ptOff = num(settings, 'pt_offhours', 1);
  const ptMiss = num(settings, 'pt_miss', -4);

  // вопросы, помеченные как «отвечать было не нужно», из расчёта выпадают
  const counted = replies.filter((r) => !r.no_reply_needed);

  const detail = [];
  let points = 0;
  let fast = 0, slow = 0, off = 0, miss = 0;

  for (const r of counted) {
    const limit = (r.urgent ? urgentTarget : target) * 60;
    const answered = r.seconds !== null && r.seconds !== undefined;

    if (!answered) {
      if (isMiss(r, settings)) {
        miss += 1; points += ptMiss;
        detail.push({ ...r, kind: 'miss', delta: ptMiss, why: 'остался без ответа' });
      }
      continue;
    }
    if (r.in_hours === 0) {
      off += 1; points += ptOff;
      detail.push({ ...r, kind: 'offhours', delta: ptOff, why: 'ответил в нерабочее время' });
    } else if (r.seconds <= limit) {
      fast += 1; points += ptFast;
      detail.push({ ...r, kind: 'fast', delta: ptFast, why: `ответил за ${Math.round(r.seconds / 60)} мин` });
    } else {
      slow += 1; points += ptSlow;
      detail.push({ ...r, kind: 'slow', delta: ptSlow, why: `ответил за ${Math.round(r.seconds / 60)} мин, норма ${r.urgent ? urgentTarget : target}` });
    }
  }

  // Оценка — доля от максимума: если на все рабочие вопросы ответили
  // вовремя, это ровно десятка. Ответы в нерабочее время идут сверх
  // максимума и могут вытянуть провал, но выше десяти не поднимают.
  //
  // Вопросов не было — отвечать было не на что, метрику не занижаем:
  // случай «человек вообще ничего не делал» отсекается уровнем выше.
  const requests = counted.filter((r) => r.in_hours === 1).length;
  const best = requests * ptFast;
  const score = requests === 0 || best <= 0
    ? (requests === 0 ? 10 : 0)
    : Math.max(0, Math.min(10, (10 * points) / best));

  return {
    score: round2(score),
    points: round2(points),
    reference: requests,
    best: round2(best),
    fast, slow, off, miss,
    median: medianSeconds(counted.filter((r) => r.seconds !== null && r.in_hours === 1)),
    unanswered: counted.filter((r) => r.seconds === null && !isMiss(r, settings)).length,
    detail,
    formula: requests === 0
      ? 'вопросов не было — метрика не снижается'
      : `${round2(points)} из ${round2(best)} возможных баллов`,
  };
}

/**
 * Не всякое сообщение требует ответа. «Понял, спасибо» таймер не открывает.
 *
 * Правила намеренно простые и проверяемые глазами: вопросительный знак,
 * список коротких подтверждений и длина. Любую ошибку можно поправить
 * вручную — в приложении вопрос помечается как не требовавший ответа.
 */
function needsReply(msg, settings) {
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return false;                       // стикер, картинка, голосовое без подписи
  if (text.includes('?')) return true;           // прямой вопрос — всегда

  const lower = text.toLowerCase();
  const stops = (settings.no_reply_words || '')
    .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

  // сообщение целиком состоит из подтверждения: «спасибо», «понял», «ок»
  const stripped = lower.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => stops.includes(w))) return false;

  // короткая реплика без вопроса — это реакция, а не задача
  if (text.length < num(settings, 'min_request_len', 25)) return false;

  return true;
}

/**
 * Пропуск — это молчание, а не медленный ответ.
 *
 * В рабочее время: не ответили дольше miss_after_min.
 * Вне рабочего времени отвечать никто не обязан, но сообщение,
 * которое провисело всю ночь и утро, тоже становится пропуском:
 * увидеть его к началу дня — часть работы.
 */
function isMiss(reply, settings, now = Date.now()) {
  if (reply.replied_at || reply.seconds !== null) return false;
  const waited = (now - new Date(reply.asked_at)) / 60000;
  if (reply.in_hours === 1) return waited > num(settings, 'miss_after_min', 60);
  return waited > num(settings, 'miss_night_hours', 12) * 60;
}

function medianSeconds(replies) {
  const vals = replies.map((r) => r.seconds).filter((v) => v !== null).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
}


/** Комиссия с экономии по регрессивной шкале. */
function savingCommission(sum, settings) {
  if (!(sum > 0)) return 0;
  const r1 = num(settings, 'saving_rate_1', 0.3);
  const r2 = num(settings, 'saving_rate_2', 0.2);
  const r3 = num(settings, 'saving_rate_3', 0.1);
  let c = Math.min(sum, 50000) * r1;
  if (sum > 50000) c += Math.min(sum - 50000, 100000) * r2;
  if (sum > 150000) c += (sum - 150000) * r3;
  return Math.round(c);
}

// ── выборка данных ───────────────────────────────────────────────────────────

async function fetchUserData(db, userId, period, role = 'assistant', startFrom = null) {
  // Задачи, закрытые до запуска системы, в расчёт не идут: по ним нет
  // ни признаков приёмки, ни истории переписки — считать по ним KPI
  // означало бы оценивать людей по данным, которых никто не собирал.
  const tasks = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE assignee_id = ?
         AND (period = ? OR period IS NULL)
         AND (done_at IS NULL OR ? IS NULL OR done_at >= ?)
         AND is_zaeb = 0
         AND status NOT IN ('shelved','cancelled','historical')
       ORDER BY created_at DESC`
    )
    .bind(userId, period, startFrom, startFrom)
    .all();

  // Ответы этого человека, плюс адресованные лично ему вопросы (в том числе
  // оставшиеся без ответа). Лиду вдобавок достаются «ничейные» пропуски:
  // если вопрос руководителя не подобрал никто, отвечает руководитель отдела.
  const replies = await db
    .prepare(
      `SELECT * FROM chat_replies
       WHERE period = ? AND (
         user_id = ?
         OR (mention_id = ? AND replied_at IS NULL)
         OR (? = 'lead' AND mention_id IS NULL AND mention_raw IS NULL
             AND replied_at IS NULL AND asked_role = 'chief')
       )`
    )
    .bind(period, userId, userId, role)
    .all();
  const awards = await db
    .prepare('SELECT * FROM awards WHERE user_id = ? AND period = ?')
    .bind(userId, period)
    .all();
  return { tasks: tasks.results, replies: replies.results, awards: awards.results };
}


/** Полная карточка человека: метрики, деньги, задачи с таймингами. */
async function buildProfile(db, user, period, settings) {
  const { tasks, replies, awards } = await fetchUserData(
    db, user.id, period, user.role, settings.start_from || null
  );

  // Метрики по задачам и чату по-прежнему считаются: по ним строится
  // список задач и справка о реакции, но денег за них больше нет.
  const metrics = computeMetrics({ tasks, replies, settings, grade: user.grade });

  const zaebSum = awards
    .filter((a) => a.kind === 'zaeb' && a.status !== 'rejected')
    .reduce((acc, a) => acc + a.amount, 0);
  const savingSum = awards
    .filter((a) => a.kind === 'saving' && a.status !== 'rejected')
    .reduce((acc, a) => acc + Math.max(0, (a.base_price || 0) - (a.final_price || 0)), 0);
  const savingPay = savingCommission(savingSum, settings);

  return {
    user: { id: user.id, name: user.name, role: user.role, grade: user.grade },
    period,
    metrics,
    // Сверх оклада ассистент получает только призы за заёбы и комиссию
    // с экономии. Кошельков за качество, скорость и самостоятельность нет.
    money: {
      zaeb: zaebSum,
      savingSum,
      savingPay,
      salary: user.salary || 0,
      total: zaebSum + savingPay,
    },
    awards,
    tasks: metrics.scored.map((t) => decorateTask(t, settings)),
    openTasks: tasks
      .filter((t) => !['accepted', 'failed', 'cancelled'].includes(t.status))
      .map((t) => decorateTask(t, settings)),
  };
}

/** Проставляет ссылки на сообщения в расшифровке баллов. */
function withChatLinks(profile, settings) {
  const chatId = settings.tg_chat_id;
  const d = profile.metrics?.breakdown?.speed?.detail;
  if (!chatId || !d) return profile;
  const base = String(chatId).replace('-100', '');
  for (const item of d) {
    if (item.request_msg) item.link = `https://t.me/c/${base}/${item.request_msg}`;
  }
  return profile;
}

/** Тайминги задачи — то, ради чего лид сюда заходит. */
function decorateTask(t, settings = {}) {
  const now = nowIso();
  // работа закончена — сдана на проверку, отдана в ожидание или принята
  const doneMark = t.work_done_at || t.submitted_at || t.done_at || null;
  const closed = ['accepted', 'cancelled', 'historical'].includes(t.status);
  // Незаконченная задача измеряется до текущего момента: иначе у висящей
  // месяц задачи «делалась —» и «в срок», хотя срок давно прошёл.
  // Всё в рабочих минутах, как в модели времени: календарные «18 ч 52 мин»
  // за вечер и утро выглядели как почти сутки.
  const wm = (a, b) => (a && b ? workMinutesBetween(a, b, settings) : null);
  const toTake = wm(t.created_at, t.taken_at);
  const doEnd = doneMark || (t.taken_at && !closed ? now : null);
  const toDo = t.taken_at && doEnd ? Math.max(0, wm(t.taken_at, doEnd) - (t.paused_min || 0)) : null;
  const total = t.done_at ? Math.max(0, wm(t.created_at, t.done_at) - (t.paused_min || 0)) : null;
  const deadlineRef = doneMark || (closed ? null : now);
  // просрочка без времени в блокере/ожидании
  const overdue = t.deadline && deadlineRef
    ? wm(t.deadline, deadlineRef) - (t.paused_min || 0)
    : null;

  // то же в рабочих часах — как в модели времени
  const dur = taskDurations(t, settings);
  const inWorkH = !doneMark && t.taken_at && !closed
    ? Math.round((workMinutesBetween(t.taken_at, now, settings) / 60) * 10) / 10
    : null;
  const waitingH = !t.taken_at && !closed
    ? Math.round((workMinutesBetween(t.created_at, now, settings) / 60) * 10) / 10
    : null;

  return {
    open: !doneMark && !closed,          // работа ещё не сдана
    waitingHours: waitingH,              // лежит не взятой, рабочих часов
    inWorkHours: inWorkH,                // в работе, рабочих часов
    id: t.id,
    title: t.title,
    number: t.project_no || t.number,
    url: t.url,
    size: t.size,
    level: t.level || null,
    levelSrc: t.level_src || null,
    priority: t.priority || null,
    t2sHours: dur.t2s,
    t2fHours: dur.t2f,
    night: !!t.night,
    status: t.status,
    createdAt: t.created_at,
    takenAt: t.taken_at,
    submittedAt: t.submitted_at,
    doneAt: t.done_at,
    deadline: t.deadline,
    returns: t.returns,
    chiefTouched: !!t.chief_touched,
    disputed: !!t.disputed,
    isInitiative: !!t.is_initiative,
    initiativeUseful: t.initiative_useful,
    score: t.score ?? null,
    flags: t.flags ?? null,
    timing: {
      toTakeMin: toTake,
      toTakeHuman: humanWorkMinutes(toTake, settings),
      toDoMin: toDo,
      toDoHuman: humanWorkMinutes(toDo, settings),
      totalMin: total,
      totalHuman: humanWorkMinutes(total, settings),
      overdueMin: overdue && overdue > 0 ? overdue : null,
      overdueHuman: overdue && overdue > 0 ? humanWorkMinutes(overdue, settings) : null,
      // срок ещё впереди — сколько рабочих часов осталось
      leftHuman: !doneMark && !closed && t.deadline && overdue !== null && overdue <= 0
        ? humanWorkMinutes(wm(now, t.deadline), settings) : null,
    },
  };
}

// ── маршруты ─────────────────────────────────────────────────────────────────

async function handleApi(request, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/^\/api/, '');
  const settings = await loadSettings(db);
  const period = url.searchParams.get('period') || currentPeriod(num(settings, 'tz_offset', 3));

  // вход по ключу
  if (path === '/login' && request.method === 'POST') {
    const { key } = await request.json().catch(() => ({}));
    if (!key) return bad('нужен ключ доступа');
    const hash = await sha256(key);
    const user = await db
      .prepare('SELECT id, name, role, grade FROM users WHERE key_hash = ? AND active = 1')
      .bind(hash)
      .first();
    if (!user) return bad('ключ не подошёл', 401);
    return json({ ok: true, user });
  }

  // первичная инициализация: создаёт руководителя отдела, пока в базе никого нет
  if (path === '/bootstrap' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!env.BOOTSTRAP_SECRET || b.secret !== env.BOOTSTRAP_SECRET) return bad('нет доступа', 403);
    const existing = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (existing.n > 0) return bad('пользователи уже есть, используйте админку', 409);

    const key = newKey();
    await db
      .prepare("INSERT INTO users (id, name, role, grade, key_hash) VALUES (?,?,'lead','A3',?)")
      .bind(crypto.randomUUID(), b.name || 'Руководитель отдела', await sha256(key))
      .run();
    return json({ ok: true, key });
  }

  // вебхук YouGile — принимается без ключа доступа, поэтому проверяется секрет:
  // в заголовке (свой вызов) или в пути (так зарегистрировано в YouGile,
  // заголовков он не шлёт)
  if (path === '/hook/yougile' && request.method === 'POST') {
    return handleYougileHook(request, env, settings);
  }
  if (path.startsWith('/yougile/') && request.method === 'POST') {
    if (!env.HOOK_SECRET || path.slice(9) !== env.HOOK_SECRET) return bad('нет доступа', 403);
    return handleYougileHook(request, env, settings, { trusted: true });
  }
  // готовый замер от внешнего бота
  if (path === '/hook/tg' && request.method === 'POST') {
    return handleTgHook(request, env, settings);
  }
  // сам Telegram: путь содержит секрет, поэтому ключ доступа не нужен
  if (path.startsWith('/tg/') && request.method === 'POST') {
    if (path.slice(4) !== (env.TG_SECRET || '')) return bad('нет доступа', 403);
    return handleTelegramUpdate(request, env, settings);
  }

  const me = await authenticate(request, db);
  if (!me) return bad('нужен ключ доступа', 401);

  // свой профиль — доступен всем ролям
  if (path === '/me') {
    const full = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    return json(withChatLinks(await buildProfile(db, full, period, settings), settings));
  }

  // ── Модель времени: Time to start / Time to fill ─────────────────────────
  if (path.startsWith('/kpi/')) {
    return handleKpiApi(request, db, path.slice(4), url, me, settings);
  }

  // Сводка по отделу — только лид и владелец.
  // Ассистентам платится только за заёбы и экономию; руководитель отдела
  // получает долю с того и другого. Его собственный KPI — модель времени,
  // он живёт в /kpi/board.
  if (path === '/team') {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const { results: people } = await db
      .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
      .all();

    const profiles = [];
    for (const p of people) profiles.push(await buildProfile(db, p, period, settings));

    const leadShareZaeb = num(settings, 'lead_share_zaeb', 0.17);
    const leadShareSaving = num(settings, 'lead_share_saving', 0.05);
    const teamZaeb = profiles.reduce((a, p) => a + p.money.zaeb, 0);
    const teamSaving = profiles.reduce((a, p) => a + p.money.savingSum, 0);

    // У руководителя свои задачи тоже есть — считаем их так же
    const leadUser = await db
      .prepare("SELECT * FROM users WHERE role = 'lead' AND active = 1 ORDER BY created_at LIMIT 1")
      .first();
    const leadOwn = leadUser ? await buildProfile(db, leadUser, period, settings) : null;

    return json({
      period,
      people: profiles.map((p) => ({
        id: p.user.id,
        name: p.user.name,
        zaeb: p.money.zaeb,
        savingSum: p.money.savingSum,
        savingPay: p.money.savingPay,
        total: p.money.total,
        tasksClosed: p.tasks.length,
        tasksOpen: p.openTasks.length,
        medianReply: p.metrics.breakdown.speed.medianReply,
      })),
      lead: {
        id: leadUser?.id || null,
        name: leadUser?.name || null,
        tasksClosed: leadOwn ? leadOwn.tasks.length : null,
        tasksOpen: leadOwn ? leadOwn.openTasks.length : null,
        medianReply: leadOwn ? leadOwn.metrics.breakdown.speed.medianReply : null,
        shareZaeb: Math.round(teamZaeb * leadShareZaeb),
        shareSaving: Math.round(teamSaving * leadShareSaving),
        shares: { zaeb: leadShareZaeb, saving: leadShareSaving },
      },
      teamZaeb,
      teamSaving,
    });
  }

  // карточка конкретного человека — лид и руководитель
  if (path.startsWith('/person/')) {
    const id = path.split('/')[2];
    if (!['lead', 'chief'].includes(me.role) && me.id !== id) return bad('нет доступа', 403);
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!user) return bad('не найден', 404);
    return json(withChatLinks(await buildProfile(db, user, period, settings), settings));
  }

  // Раздражители: список закрытых с подтверждением выплаты.
  // Владельцу и руководителю отдела — полный список, ассистенту — свои.
  if (path === '/zaeby') {
    const mine = !['lead', 'chief'].includes(me.role);
    const { results } = await db
      .prepare(
        `SELECT a.*, u.name AS user_name FROM awards a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.kind = 'zaeb' ${mine ? 'AND a.user_id = ?' : ''}
         ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'half_paid' THEN 1 ELSE 2 END,
                  a.created_at DESC`
      )
      .bind(...(mine ? [me.id] : []))
      .all();

    const paid = results.reduce((sum, a) => {
      if (a.status === 'confirmed') return sum + a.amount;
      if (a.status === 'half_paid') return sum + Math.round(a.amount / 2);
      return sum;
    }, 0);

    return json({
      paid,
      items: results.map((a) => ({
        id: a.id,
        title: a.title,
        tier: a.tier,
        amount: a.amount,
        leadAmount: a.lead_amount,
        status: a.status,
        userName: a.user_name,
        confirmDue: a.confirm_due,
        createdAt: a.created_at,
      })),
    });
  }

  // подтверждение и отклонение приза за раздражитель
  if (path.startsWith('/zaeb/')) {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const [, , id, action] = path.split('/');
    const award = await db.prepare('SELECT * FROM awards WHERE id = ?').bind(id).first();
    if (!award) return bad('не найден', 404);

    if (action === 'confirm') {
      // первое подтверждение — половина, второе через 30 дней — остаток
      const next = award.status === 'pending' ? 'half_paid' : 'confirmed';
      await db
        .prepare('UPDATE awards SET status = ?, confirmed_at = ? WHERE id = ?')
        .bind(next, next === 'confirmed' ? nowIso() : null, id)
        .run();
      await logEvent(db, {
        userId: award.user_id, type: 'manual', actor: me.name, source: 'manual',
        note: next === 'half_paid'
          ? `подтверждено закрытие: ${award.title}`
          : `через 30 дней не всплывало, доплата: ${award.title}`,
      });
      return json({ ok: true, status: next });
    }

    if (action === 'reject') {
      await db.prepare("UPDATE awards SET status = 'rejected' WHERE id = ?").bind(id).run();
      await logEvent(db, {
        userId: award.user_id, type: 'manual', actor: me.name, source: 'manual',
        note: `проблема вернулась, приз не доплачен: ${award.title}`,
      });
      return json({ ok: true, status: 'rejected' });
    }
  }

  // очередь приёмки для руководителя
  if (path === '/inbox') {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const { results } = await db
      .prepare(
        `SELECT t.*, u.name AS assignee_name FROM tasks t
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.status = 'review' ORDER BY t.submitted_at`
      )
      .all();
    return json({ tasks: results.map((t) => ({ ...decorateTask(t, settings), assignee: t.assignee_name })) });
  }

  // приёмка: «принято» или «вернуть» — единственное решение руководителя
  if (path.startsWith('/task/') && request.method === 'POST') {
    const [, , id, action] = path.split('/');
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const body = await request.json().catch(() => ({}));

    if (action === 'accept') {
      await db
        .prepare(
          `UPDATE tasks SET status='accepted', done_at=?, period=?, updated_at=?
           WHERE id=?`
        )
        .bind(nowIso(), period, nowIso(), id)
        .run();
      await logEvent(db, { taskId: id, type: 'accepted', actor: me.name, source: 'manual' });
      return json({ ok: true });
    }
    if (action === 'return') {
      await db
        .prepare(
          `UPDATE tasks SET status='in_progress', returns = returns + 1, updated_at=?
           WHERE id=?`
        )
        .bind(nowIso(), id)
        .run();
      await logEvent(db, {
        taskId: id, type: 'returned', actor: me.name, note: body.note || null, source: 'manual',
      });
      return json({ ok: true });
    }
    if (action === 'dispute') {
      // списание вовлечения: «вопрос был по делу, а не от беспомощности»
      if (!['lead', 'chief'].includes(me.role)) return bad('только руководитель', 403);
      await db
        .prepare('UPDATE tasks SET disputed = 1, dispute_note = ?, updated_at = ? WHERE id = ?')
        .bind(body.note || null, nowIso(), id)
        .run();
      await logEvent(db, {
        taskId: id, type: 'manual', actor: me.name,
        note: `списано вовлечение: ${body.note || 'без комментария'}`, source: 'manual',
      });
      return json({ ok: true });
    }
    if (action === 'size') {
      if (me.role === 'assistant') return bad('нет доступа', 403);
      await db
        .prepare('UPDATE tasks SET size = ?, night = ?, updated_at = ? WHERE id = ?')
        .bind(Math.min(3, Math.max(1, body.size | 0)), body.night ? 1 : 0, nowIso(), id)
        .run();
      return json({ ok: true });
    }
    return bad('неизвестное действие');
  }

  // события задачи — основа прозрачности: откуда взялась каждая цифра
  if (path.startsWith('/events/')) {
    const taskId = path.split('/')[2];
    const task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    if (!task) return bad('не найдена', 404);
    if (me.role === 'assistant' && task.assignee_id !== me.id) return bad('нет доступа', 403);
    const { results } = await db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY at')
      .bind(taskId)
      .all();
    return json({ task: decorateTask(task, settings), events: results, score: scoreTask(task) });
  }

  // ── настройки: доступны руководителю отдела и владельцу ────────────────────
  if (path.startsWith('/admin/')) {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);

    if (path === '/admin/users' && request.method === 'GET') {
      const { results } = await db
        .prepare(
          `SELECT id, name, role, grade, grade_num, salary, active, yougile_id, tg_user_id, tg_username
           FROM users ORDER BY role, name`
        )
        .all();
      return json({ users: results });
    }

    if (path.startsWith('/admin/users/') && request.method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop());
      // задачи и переписку не трогаем: история должна пережить любую чистку
      await db.prepare('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?').bind(id).run();
      await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    if (path === '/admin/users' && request.method === 'POST') {
      const b = await request.json();
      const id = b.id || crypto.randomUUID();
      const key = b.rotateKey || !b.id ? newKey() : null;
      const hash = key ? await sha256(key) : null;

      const nick = (b.tg_username || '').replace('@', '').toLowerCase() || null;
      // Грейд 1–7: от него зависит процент премии. Вне диапазона — не трогаем.
      const gradeNum = Number.isInteger(Number(b.grade_num)) && b.grade_num >= 1 && b.grade_num <= 7
        ? Number(b.grade_num) : null;

      if (b.id) {
        // Грейд приходит не всегда: у руководителей поле скрыто, и форма
        // его не присылает. Пустое значение не должно затирать сохранённое —
        // иначе любое переименование падало бы на ограничении NOT NULL.
        await db
          .prepare(
            `UPDATE users SET name=?, role=?, grade=COALESCE(?, grade),
             grade_num=COALESCE(?, grade_num), salary=?,
             yougile_id=?, tg_user_id=?, tg_username=?, active=?
             ${hash ? ', key_hash=?' : ''} WHERE id=?`
          )
          .bind(...[
            b.name, b.role, b.grade || null, gradeNum, b.salary | 0,
            b.yougile_id || null, b.tg_user_id || null,
            nick, b.active === false ? 0 : 1,
            ...(hash ? [hash] : []),
            b.id,
          ])
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO users (id, name, role, grade, grade_num, salary, yougile_id, tg_user_id, tg_username, key_hash)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(id, b.name, b.role || 'assistant',
                // у руководителей грейд не спрашивают: ставим строгую норму
                b.grade || (b.role === 'assistant' ? 'A2' : 'A3'),
                gradeNum || 3,
                b.salary | 0, b.yougile_id || null, b.tg_user_id || null, nick, hash)
          .run();
      }
      // ключ показывается ровно один раз — в базе только его хэш
      return json({ ok: true, id, key });
    }

    if (path === '/admin/settings' && request.method === 'GET') return json({ settings });

    if (path === '/admin/settings' && request.method === 'POST') {
      const b = await request.json();
      const stmts = Object.entries(b).map(([k, v]) =>
        db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .bind(k, String(v))
      );
      if (stmts.length) await db.batch(stmts);
      return json({ ok: true });
    }

    if (path === '/admin/award' && request.method === 'POST') {
      const b = await request.json();
      const leadShare = b.kind === 'zaeb'
        ? Math.round((b.amount | 0) * num(settings, 'lead_share_zaeb', 0.17))
        : 0;
      await db
        .prepare(
          `INSERT INTO awards (user_id, kind, title, tier, amount, lead_amount, base_price, final_price, period, proof_url, confirm_due)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(b.user_id, b.kind, b.title, b.tier || null, b.amount | 0, leadShare,
              b.base_price | 0, b.final_price | 0, period, b.proof_url || null,
              b.kind === 'zaeb' ? new Date(Date.now() + 30 * 864e5).toISOString() : null)
        .run();
      return json({ ok: true });
    }

    if (path === '/admin/sync' && request.method === 'POST') {
      const report = await syncYougile(env, settings);
      return json(report);
    }
  }

  return bad('маршрут не найден', 404);
}

// ─────────────────────────────────────────────────────────────────────────────
// API модели времени — KPI руководителя отдела.
//
// Метрики считаются по задачам всего отдела: результат руководителя — это
// результат его людей. Оценку ставит владелец, премия — руководителю.
// Ассистенты премии по этой модели не получают; им доступен только отзыв
// о руководителе. Срезы по людям — диагностика: где узкое место.
// ─────────────────────────────────────────────────────────────────────────────
async function handleKpiApi(request, db, path, url, me, settings) {
  const isBoss = ['lead', 'chief'].includes(me.role);
  const tz = num(settings, 'tz_offset', 3);
  // KPI считается по месяцам; квартал — для отзывов и аттестации
  const period = url.searchParams.get('period') || currentPeriod(tz);
  if (!/^\d{4}-\d{2}$/.test(period)) return bad('месяц в виде 2026-09');
  const quarter = url.searchParams.get('quarter') || quarterOf(period);
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) return bad('квартал в виде 2026-Q3');

  // Руководитель отдела — тот, о ком вся модель. Один активный.
  const lead = await db
    .prepare("SELECT * FROM users WHERE role = 'lead' AND active = 1 ORDER BY created_at LIMIT 1")
    .first();
  if (!lead) return bad('руководитель отдела не заведён', 409);

  // ── Отзыв о руководителе: сам о себе, ассистент по желанию, владелец ────
  // Единственный маршрут модели, открытый ассистенту.
  if (path === '/reviews' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const q = b.quarter || quarter;
    if (!/^\d{4}-Q[1-4]$/.test(q)) return bad('квартал в виде 2026-Q3');
    if (b.mark && !MARKS.includes(b.mark)) return bad('такой оценки нет');

    // вид отзыва следует из роли, выбирать его нельзя
    const kind = me.role === 'lead' ? 'self' : me.role === 'chief' ? 'chief' : 'peer';
    const text = String(b.text || '').trim();
    if (!text && !b.mark) return bad('нужен текст или оценка');

    const existing = await db
      .prepare('SELECT id FROM reviews WHERE user_id = ? AND author_id = ? AND kind = ? AND quarter = ?')
      .bind(lead.id, me.id, kind, q)
      .first();
    if (existing) {
      await db
        .prepare('UPDATE reviews SET mark = ?, text = ?, created_at = ? WHERE id = ?')
        .bind(b.mark || null, text, nowIso(), existing.id)
        .run();
      return json({ ok: true, id: existing.id, updated: true, kind });
    }
    const r = await db
      .prepare('INSERT INTO reviews (user_id, author_id, kind, quarter, mark, text, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(lead.id, me.id, kind, q, b.mark || null, text, nowIso())
      .run();
    return json({ ok: true, id: r.meta?.last_row_id, kind });
  }

  if (path.startsWith('/reviews/') && request.method === 'DELETE') {
    const id = Number(path.split('/').pop());
    const r = await db.prepare('SELECT * FROM reviews WHERE id = ?').bind(id).first();
    if (!r) return bad('отзыва нет', 404);
    if (r.author_id !== me.id && me.role !== 'chief') return bad('нет доступа', 403);
    await db.prepare('DELETE FROM reviews WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // свой отзыв за квартал — чтобы ассистент видел, что уже написал
  if (path === '/my-review' && request.method === 'GET') {
    const r = await db
      .prepare('SELECT id, kind, mark, text, created_at FROM reviews WHERE user_id = ? AND author_id = ? AND quarter = ?')
      .bind(lead.id, me.id, quarter)
      .first();
    return json({ quarter, lead: { id: lead.id, name: lead.name }, review: r || null, marks: MARKS.map((m) => ({ id: m, label: MARK_LABEL[m] })) });
  }

  if (!isBoss) return bad('нет доступа', 403);

  // ── Доска: KPI руководителя за месяц, оценки людей, срезы ───────────────
  if (path === '/board' && request.method === 'GET') {
    const kpi = await leadKpi(db, lead, period, settings);

    // Графики и раскрываемые месяцы — по кварталу, в который входит месяц
    const team = await quarterMetrics(db, null, quarter, settings);
    const { results: assistants } = await db
      .prepare("SELECT id, name, yougile_id, tg_username FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
      .all();
    const slices = [];
    for (const p of assistants) {
      const q = await quarterMetrics(db, p.id, quarter, settings);
      slices.push({ id: p.id, name: p.name, quarter: { metrics: q.metrics, percents: q.percents, avgPercent: q.avgPercent }, months: q.months });
    }
    const ownQ = await quarterMetrics(db, lead.id, quarter, settings);

    // Аттестация за квартал: отзывы и оценка владельца. Денег здесь нет —
    // премия месячная.
    const result = await db
      .prepare('SELECT * FROM quarter_results WHERE user_id = ? AND quarter = ?')
      .bind(lead.id, quarter)
      .first();
    const { results: reviews } = await db
      .prepare(
        `SELECT r.id, r.kind, r.mark, r.text, r.created_at, r.author_id, u.name AS author
         FROM reviews r LEFT JOIN users u ON u.id = r.author_id
         WHERE r.user_id = ? AND r.quarter = ? ORDER BY r.created_at`
      )
      .bind(lead.id, quarter)
      .all();

    const strip = (sc) => ({
      auto: sc.auto, manual: sc.manual, score: sc.score, note: sc.note, actor: sc.actor, at: sc.at,
      avgPercent: sc.month.avgPercent, tasks: sc.month.count, open: sc.open,
      metrics: sc.month.metrics, percents: sc.month.percents,
    });

    return json({
      period,
      quarter,
      months: monthsOfQuarter(quarter),
      sla: kpi.sla,
      overplan: num(settings, 'overplan_percent', 120),
      marks: MARKS.map((m) => ({ id: m, label: MARK_LABEL[m] })),
      lead: {
        id: lead.id, name: lead.name,
        own: strip(kpi.own),
        score: kpi.score, counted: kpi.counted, max: kpi.max, bonus: kpi.bonus,
        quarter: { metrics: team.metrics, percents: team.percents, avgPercent: team.avgPercent, markAuto: team.markAuto },
        months: team.months,
        ownQuarter: { metrics: ownQ.metrics, percents: ownQ.percents, avgPercent: ownQ.avgPercent },
        ownMonths: ownQ.months,
        result: result || null,
        reviews,
      },
      people: kpi.people.map((r) => ({
        id: r.id, name: r.name, ...strip(r),
        ...(slices.find((x) => x.id === r.id) || {}),
      })),
      me: { id: me.id, role: me.role },
    });
  }

  // ── Оценка руками ──────────────────────────────────────────────────────────
  // Руководитель отдела ставит ассистентам, владелец — всем, включая
  // руководителя. Сам себе руководитель оценку не ставит.
  if (path === '/score' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const p = b.period || period;
    if (!/^\d{4}-\d{2}$/.test(p)) return bad('месяц в виде 2026-09');
    const target = await db.prepare('SELECT id, name, role FROM users WHERE id = ? AND active = 1').bind(b.user_id).first();
    if (!target) return bad('человек не найден', 404);
    if (target.role === 'chief') return bad('владельцу оценка не ставится');
    if (target.role === 'lead' && me.role !== 'chief') return bad('оценку руководителю ставит владелец', 403);
    if (target.role === 'assistant' && !isBoss) return bad('нет доступа', 403);

    const manual = b.manual === null || b.manual === undefined || b.manual === '' ? null : Number(b.manual);
    if (manual !== null && !(manual >= 0 && manual <= 10)) return bad('оценка от 0 до 10');

    await db
      .prepare(
        `INSERT INTO month_scores (user_id, period, manual, note, actor, at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id, period) DO UPDATE SET
           manual = excluded.manual, note = excluded.note, actor = excluded.actor, at = excluded.at`
      )
      .bind(target.id, p, manual, b.note || null, me.name, nowIso())
      .run();
    await logEvent(db, {
      userId: target.id, type: 'manual', actor: me.name, source: 'manual',
      note: manual === null ? `оценка за ${p} снята, снова автоматическая` : `оценка за ${p}: ${manual}${b.note ? ` — ${b.note}` : ''}`,
    });
    const kpi = await leadKpi(db, lead, p, settings);
    return json({ ok: true, manual, leadScore: kpi.score, leadBonus: kpi.bonus });
  }

  // ── Нормы (SLA) ────────────────────────────────────────────────────────────
  if (path === '/sla' && request.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM sla ORDER BY valid_from, metric, level').all();
    return json({ sla: results, current: await loadSla(db, quarter) });
  }

  if (path === '/sla' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const from = b.quarter || quarter;
    if (!/^\d{4}-Q[1-4]$/.test(from)) return bad('квартал в виде 2026-Q3');
    const values = b.values || {};
    let saved = 0;
    for (const metric of TIME_METRICS) {
      for (const level of LEVELS) {
        const v = Number(values[`${metric}${level}`]);
        if (!(v > 0)) continue;
        await db
          .prepare('INSERT OR REPLACE INTO sla (metric, level, hours, valid_from, note) VALUES (?,?,?,?,?)')
          .bind(metric, level, v, from, b.note || null)
          .run();
        saved += 1;
      }
    }
    return json({ ok: true, saved, current: await loadSla(db, from) });
  }

  // ── Матрица премий: грейд × оценка ────────────────────────────────────────
  if (path === '/matrix' && request.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM bonus_matrix ORDER BY grade DESC').all();
    const matrix = {};
    for (const r of results) (matrix[r.grade] ||= {})[r.mark] = r.percent;
    return json({ matrix, marks: MARKS });
  }

  if (path === '/matrix' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const grade = Number(b.grade);
    if (!(grade >= 1 && grade <= 7)) return bad('грейд от 1 до 7');
    const cells = b.cells || {};
    for (const mark of MARKS) {
      if (cells[mark] === undefined) continue;
      const percent = Number(cells[mark]);
      if (!(percent >= 0 && percent <= 100)) return bad(`процент для ${MARK_LABEL[mark]} вне 0–100`);
      await db
        .prepare('INSERT OR REPLACE INTO bonus_matrix (grade, mark, percent) VALUES (?,?,?)')
        .bind(grade, mark, percent)
        .run();
    }
    return json({ ok: true });
  }

  // ── Итог квартала — аттестация, ставит владелец ────────────────────────────
  // Оценка −…++++ по проценту плана и отзывам. Денег за ней нет — премия
  // считается помесячно; это ориентир для пересмотра норм и грейда.
  if (path === '/quarter/close' && request.method === 'POST') {
    if (me.role !== 'chief') return bad('квартал закрывает владелец', 403);
    const b = await request.json().catch(() => ({}));
    const q = b.quarter || quarter;
    if (!/^\d{4}-Q[1-4]$/.test(q)) return bad('квартал в виде 2026-Q3');
    if (!MARKS.includes(b.mark)) return bad('нужна итоговая оценка');

    const m = await quarterMetrics(db, null, q, settings);
    await db
      .prepare(
        `INSERT OR REPLACE INTO quarter_results
         (user_id, quarter, plan_percent, mark, mark_auto, grade, salary_quarter,
          bonus_percent, bonus_sum, note, closed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(lead.id, q, m.avgPercent, b.mark, m.markAuto, lead.grade_num, null, null, null,
            b.note || null, nowIso())
      .run();
    return json({ ok: true, mark: b.mark, markAuto: m.markAuto, planPercent: m.avgPercent });
  }

  if (path === '/quarter/reopen' && request.method === 'POST') {
    if (me.role !== 'chief') return bad('квартал открывает владелец', 403);
    const b = await request.json().catch(() => ({}));
    await db
      .prepare('DELETE FROM quarter_results WHERE user_id = ? AND quarter = ?')
      .bind(lead.id, b.quarter || quarter)
      .run();
    return json({ ok: true });
  }

  // ── Уровень задачи руками ──────────────────────────────────────────────────
  // Модель ошиблась или стикера нет — руководитель правит уровень сам.
  if (path.startsWith('/task/') && path.endsWith('/level') && request.method === 'POST') {
    const id = decodeURIComponent(path.split('/')[2]);
    const b = await request.json().catch(() => ({}));
    const level = Number(b.level);
    if (!LEVELS.includes(level)) return bad('уровень 1, 2 или 3');
    await db
      .prepare("UPDATE tasks SET level = ?, level_src = 'manual' WHERE id = ?")
      .bind(level, id)
      .run();
    return json({ ok: true });
  }

  return bad('маршрут не найден', 404);
}

async function logEvent(db, { taskId, userId, type, actor, at, note, source }) {
  await db
    .prepare('INSERT INTO events (task_id, user_id, type, actor, at, note, source) VALUES (?,?,?,?,?,?,?)')
    .bind(taskId || null, userId || null, type, actor || null, at || nowIso(), note || null, source || 'yougile')
    .run();
}

// ── интеграция с YouGile ─────────────────────────────────────────────────────

/**
 * Вебхук YouGile. Задачи и их перемещения по колонкам — единственный
 * источник таймингов: когда взята в работу, когда ушла на проверку,
 * сколько раз возвращалась.
 */
async function handleYougileHook(request, env, settings, { trusted = false } = {}) {
  const db = env.DB;
  const secret = env.HOOK_SECRET;
  if (!trusted && secret && request.headers.get('x-hook-secret') !== secret) return bad('нет доступа', 403);

  const payload = await request.json().catch(() => null);
  if (!payload) return bad('пустое тело');

  const items = Array.isArray(payload) ? payload : [payload];

  // Отвечаем сразу, разбираем следом: у новой задачи уровень определяет
  // модель, на двух ядрах это десять-пятнадцать секунд, а после простоя —
  // до минуты. Держать вебхук столько нельзя — YouGile сочтёт его упавшим
  // и пришлёт повтор. Повтор, впрочем, безвреден: разбор идемпотентен.
  const work = (async () => {
    for (const ev of items) {
      const task = ev.payload || ev.task || ev;
      const id = task.id || ev.id;
      if (!id) continue;
      try {
        await upsertTaskFromYougile(env, task, settings);
      } catch (e) {
        console.error('Вебхук YouGile, задача', id, String(e).slice(0, 300));
      }
    }
  })();
  if (env.waitUntil) env.waitUntil(work); // на Cloudflare промис надо удержать явно

  return json({ ok: true, received: items.length });
}

/**
 * Периодическая синхронизация: подстраховка, если вебхук что-то потерял.
 *
 * /task-list отдаёт задачи целиком, поэтому хватает одного обхода с пагинацией.
 * Ключ берётся из секретов; настройка в базе оставлена как запасной путь.
 */
async function syncYougile(env, settings, { limit = 1000, rebuild = false, quiet = false } = {}) {
  const db = env.DB;
  const key = env.YOUGILE_KEY || settings.yougile_key;
  if (!key) return { ok: false, error: 'не задан ключ YouGile' };

  const base = settings.yougile_base || 'https://yougile.com/api-v2';
  let offset = 0;
  let touched = 0;
  let guard = 0;
  const failed = [];

  while (guard++ < 50) {
    const res = await fetch(`${base}/task-list?limit=100&offset=${offset}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { ok: false, error: `YouGile ответил ${res.status}`, synced: touched, failed };

    const data = await res.json().catch(() => ({}));
    const list = data.content || [];
    for (const t of list) {
      // Одна сбойная задача не должна обрывать синхронизацию на середине:
      // остальные важнее, а причина уходит в лог.
      try {
        await upsertTaskFromYougile(env, t, settings, { rebuild, quiet });
        touched += 1;
      } catch (e) {
        failed.push({ id: t.id, title: t.title, error: String(e).slice(0, 200) });
      }
      if (touched >= limit) return { ok: true, synced: touched, failed, truncated: true };
    }
    if (!data.paging?.next) break;
    offset += list.length || 100;
  }
  return { ok: true, synced: touched, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Поиск задачи по сообщению в чате
//
// Руководитель пишет «заказали ракетку?» и не указывает, кому. Бот должен сам
// понять, о какой задаче речь, и спросить с её исполнителя.
//
// Чтобы не перебирать все задачи на каждое сообщение, у каждой задачи есть
// поисковый индекс. Он считается один раз — когда задача появляется — и лежит
// в базе рядом с ней. Дальше сравнение это пересечение двух коротких списков.
// ─────────────────────────────────────────────────────────────────────────────

/** Служебные слова, которые совпадают у всех задач и только мешают. */
const STOP_WORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты',
  'к','у','же','вы','за','бы','по','ее','мне','было','вот','от','меня','еще','нет','о','из','ему','теперь',
  'для','мы','тебя','их','чем','была','сам','чтоб','без','будто','чего','раз','тоже','себе','под','будет',
  'ж','тогда','кто','этот','того','потому','этого','какой','совсем','ним','здесь','этом','один','почти',
  'мой','тем','чтобы','нее','были','куда','зачем','всех','никогда','можно','при','наконец','два','об',
  'другой','хоть','после','над','больше','тот','через','эти','нас','про','всего','них','какая','много',
  'разве','三','эту','моя','впрочем','хорошо','свою','этой','перед','иногда','лучше','чуть','том','нельзя',
  'такой','им','более','всегда','конечно','всю','между','надо','нужно','сделать','сделай','пожалуйста',
  'есть','быть','этих','либо','или','также','такие','когда','где','уже','ещё','его','который','которая',
]);

/**
 * Слова сообщения или заголовка в сравнимом виде.
 *
 * Русские окончания режутся грубо — до основы в пять букв. «Ракетку», «ракетка»
 * и «ракетки» превращаются в «ракет» и совпадают между собой. Это заметно проще
 * настоящей морфологии и для коротких заголовков задач работает не хуже.
 */
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}

/**
 * Индекс задачи. Слова заголовка и описания хранятся раздельно: совпадение
 * в заголовке значит куда больше, чем случайное слово в теле описания.
 */
function taskKeywords(task) {
  const plain = String(task.description || '').replace(/<[^>]*>/g, ' ');
  const head = [...new Set(words(task.title))];
  // описание берём целиком: детали вроде фирмы или модели живут именно там,
  // и спрашивают в чате часто именно про них
  const body = [...new Set(words(plain))].filter((w) => !head.includes(w));
  return `${head.join(' ')}|${body.join(' ')}`;
}

const splitKeywords = (kw) => {
  const [head = '', body = ''] = String(kw || '').split('|');
  return { head: head.split(' ').filter(Boolean), body: body.split(' ').filter(Boolean) };
};

/**
 * Кандидаты на вопрос из чата.
 *
 * Редкое слово весит больше частого: «ракет» встречается в двух задачах и почти
 * наверняка указывает на нужную, а «заказ» есть в полусотне и не значит ничего.
 * Без этой поправки вопрос «заказали ракетку?» уводит на первую попавшуюся
 * задачу со словом «заказать» — проверено на реальных задачах.
 */
async function findTaskCandidates(db, text, { limit = 6 } = {}) {
  const asked = [...new Set(words(text))];
  if (!asked.length) return [];

  // только живые задачи: про закрытые и снятые не спрашивают
  const { results } = await db
    .prepare(
      `SELECT id, title, number, keywords, assignee_id, status, deadline
       FROM tasks
       WHERE status NOT IN ('accepted','cancelled','failed')
       ORDER BY updated_at DESC LIMIT 400`
    )
    .all();

  const parsed = results.map((t) => ({ t, ...splitKeywords(t.keywords) }));

  // в скольких задачах встречается каждое слово вопроса
  const df = new Map();
  for (const w of asked) {
    let n = 0;
    for (const p of parsed) if (p.head.includes(w) || p.body.includes(w)) n += 1;
    df.set(w, n);
  }

  const total = parsed.length || 1;
  const scored = [];
  for (const p of parsed) {
    let score = 0;
    let hits = 0;
    const matched = [];
    for (const w of asked) {
      const inHead = p.head.includes(w);
      const inBody = !inHead && p.body.includes(w);
      if (!inHead && !inBody) continue;
      // редкое слово — сильный сигнал, частое почти ничего не значит
      const idf = Math.log((total + 1) / (df.get(w) + 1)) + 0.1;
      score += idf * (inHead ? 2.5 : 1);
      hits += 1;
      matched.push(w);
    }
    if (hits) scored.push({ ...p.t, hits, score: round2(score), matched });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Уверенность в лидере: во сколько раз он оторвался от второго места.
 * Если оторвался заметно — нейросеть звать незачем.
 */
function candidateConfidence(list) {
  if (!list.length) return 0;
  if (list.length === 1) return list[0].score >= 1.5 ? 1 : 0.5;
  const [first, second] = list;
  if (!second.score) return 1;
  return first.score / second.score;
}

/**
 * Выбор задачи нейросетью — только когда список слов не дал явного лидера.
 *
 * Модель получает не все задачи, а короткий список кандидатов от предфильтра:
 * несколько строк вместо сотни. Поэтому даже на процессорном сервере ответ
 * приходит за секунды, а не за минуты.
 *
 * Ответ ждём строго одним числом — так его нельзя перепутать с рассуждением.
 */
async function pickTaskWithModel(candidates, question, settings) {
  const url = settings.llm_url || 'http://127.0.0.1:11434/api/generate';
  const model = settings.llm_model || 'qwen3:8b';
  const timeout = num(settings, 'llm_timeout_ms', 45000);
  if (!candidates.length) return null;

  const list = candidates
    .map((c, i) => `${i + 1}. ${c.title.replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n');

  const prompt =
    `Есть список задач:\n${list}\n\n` +
    `Руководитель спросил в чате: "${question}"\n\n` +
    `О какой задаче он спрашивает? Ответь только номером из списка. ` +
    `Если ни одна не подходит, ответь 0. Никаких пояснений, только цифра.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,          // рассуждения вслух здесь только тратят время
        options: { temperature: 0, num_predict: 8 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const n = parseInt(String(data.response || '').replace(/[^0-9]/g, ''), 10);
    if (!n || n < 1 || n > candidates.length) return null;
    return candidates[n - 1];
  } catch {
    return null; // модель недоступна или думает слишком долго — работаем без неё
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Уровень сложности по заголовку — для задач без стикера размера.
 *
 * Два вопроса той же локальной модели. Первый делит на 1/2/3 по главному
 * глаголу; на нём простые и обычные определяются надёжно, а сложные
 * половину времени уходят в «обычные». Поэтому на ответ «2» задаётся второй,
 * бинарный вопрос: «подобрать из готовых» или «сначала разобраться, как».
 * Откалибровано на 42 заголовках с доски: 39 верных, сложные — все.
 *
 * Не ответила или ответила чепухой — null: подставлять выдуманный уровень
 * хуже, чем взять размер.
 */
async function askModelDigit(prompt, settings) {
  const url = settings.llm_url || 'http://127.0.0.1:11434/api/generate';
  const model = settings.llm_model || 'qwen3:8b';
  const timeout = num(settings, 'llm_timeout_ms', 45000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think: false,
        keep_alive: settings.llm_keep_alive || '2h',
        options: { temperature: 0, num_predict: 4 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const n = parseInt(String(data.response || '').replace(/[^0-9]/g, '').slice(0, 1), 10);
    return n >= 1 && n <= 3 ? n : null;
  } catch {
    return null; // модель недоступна — уровень возьмётся со стикера размера
  } finally {
    clearTimeout(timer);
  }
}

async function guessLevelWithModel(title, settings) {
  if (!title || settings.llm_enabled === '0') return null;
  const t = String(title).replace(/\s+/g, ' ').slice(0, 200);

  const first =
    `Оцени сложность задачи для личного ассистента одной цифрой.\n\n` +
    `1 — простая: одно конкретное действие, результат за час-два.\n` +
    `2 — обычная: подобрать из нескольких вариантов или пройти несколько шагов, результат за день-два.\n` +
    `3 — сложная: исследование, план или система на несколько дней, много неизвестных.\n\n` +
    `Как решать — по главному глаголу задачи:\n` +
    `— купить, заказать, скачать, оформить, пополнить, записать, продлить одну конкретную вещь → 1\n` +
    `— найти, подобрать, уточнить, сравнить, записаться на просмотр (есть из чего выбирать) → 2\n` +
    `— понять как, изучить рынок, спланировать, разобраться в законах или визах, настроить мониторинг или слежение, разработать → 3\n` +
    `«Найти конкретную вещь в магазине» — это 1, «найти лучший вариант из многих» — 2, «найти как вообще это сделать» — 3.\n\n` +
    `Примеры:\n` +
    `«Оформить гемини» — 1\n` +
    `«Заказать антишпион стекло на iphone» — 1\n` +
    `«Найти дермапен на mercado livre» — 1\n` +
    `«Подобрать авиабилет Батуми-Алматы на 20.09» — 2\n` +
    `«Найти квартиру для руководителя с женой в КЗ» — 2\n` +
    `«Найти мини беговую дорожку без стоек для работы» — 2\n` +
    `«Найти психолога, хорошие отзывы, цена до 2к» — 2\n` +
    `«Рынок аренды автодомов в Бразилии изучить» — 3\n` +
    `«Как получить визу в Германию до августа» — 3\n` +
    `«Поставить на мониторинг все чартерные компании Турции» — 3\n\n` +
    `Задача: "${t}"\n` +
    `Ответ — только цифра 1, 2 или 3:`;

  const level = await askModelDigit(first, settings);
  if (level !== 2) return level;

  const refine =
    `Задача для личного ассистента: "${t}"\n\n` +
    `Какого она типа?\n` +
    `2 — подобрать или найти из существующих вариантов: билеты, жильё, товары, специалисты, клиники, курсы. ` +
    `Понятно, где искать; результат — один вариант или короткий список.\n` +
    `3 — сначала нужно разобраться, как это вообще делается, или выстроить процесс: законы, визы, пошлины, ` +
    `редкие услуги, которых может и не быть, постоянное слежение за изменениями, план на месяцы, разработка системы.\n\n` +
    `Примеры:\n` +
    `«Найти квартиру для руководителя с женой в КЗ» — 2\n` +
    `«Найти мини беговую дорожку без стоек» — 2\n` +
    `«Найти психолога, хорошие отзывы, цена до 2к» — 2\n` +
    `«Как привезти кислородную камеру в Чили без пошлины» — 3\n` +
    `«Мониторить слоты на регистрацию ВНЖ» — 3\n` +
    `«В Грузии найти тест на паттерны метилирования ДНК» — 3\n\n` +
    `Ответ — только цифра 2 или 3:`;

  const second = await askModelDigit(refine, settings);
  return second === 3 ? 3 : 2;
}

/**
 * Кому адресован вопрос: сначала слова, при равных кандидатах — модель.
 * Возвращает саму задачу и то, как она была выбрана: это попадает в отчёт,
 * чтобы любое решение бота можно было объяснить.
 */
async function detectTask(db, text, settings) {
  const candidates = await findTaskCandidates(db, text);
  if (!candidates.length) return { task: null, how: 'ничего не нашлось' };

  const confidence = candidateConfidence(candidates);
  const threshold = num(settings, 'llm_confidence', 1.35);

  if (confidence >= threshold) {
    return { task: candidates[0], how: `по словам, отрыв ×${round2(confidence)}`, candidates };
  }
  if (settings.llm_enabled === '0') {
    return { task: candidates[0], how: 'по словам, кандидаты равны', candidates };
  }

  const picked = await pickTaskWithModel(candidates, text, settings);
  return picked
    ? { task: picked, how: 'выбрала модель из равных кандидатов', candidates }
    : { task: candidates[0], how: 'по словам, модель не ответила', candidates };
}

/**
 * Разбор настройки вида «id1=значение1,id2=значение2» в таблицу соответствий.
 * Так хранятся состояния стикеров YouGile: у каждого состояния свой id.
 */
function stateMap(settings, key) {
  const map = new Map();
  for (const pair of String(settings[key] || '').split(',')) {
    const [id, val] = pair.split('=').map((s) => s.trim());
    if (id && val) map.set(id, val);
  }
  return map;
}

/** Значение стикера на задаче: из объекта stickers достаём id состояния. */
function stickerValue(task, stickerId, map, fallback) {
  const stateId = task?.stickers?.[stickerId];
  if (!stateId) return fallback;
  const v = map.get(stateId);
  return v === undefined ? fallback : v;
}

/**
 * Прибавляет рабочие дни к дате, пропуская субботы и воскресенья.
 *
 * Приоритет «1» означает «сегодня или в первый рабочий день после выходных»,
 * поэтому задача, поставленная в пятницу вечером, ждёт понедельника,
 * а не оказывается просроченной за выходные.
 */
/** Срок по приоритету: N полных рабочих дней от постановки, в рабочих часах. */
function deadlineByPriority(fromIso, days, settings = {}) {
  return addWorkMinutes(fromIso, Math.max(0, Math.round(days)) * workWindow(settings).dayMin, settings);
}

function addWorkdays(from, days, tzOffset = 3, settings = {}) {
  // Считаем в местном времени: иначе суббота 01:00 по Москве выглядит
  // как пятница по UTC, и выходной день ошибочно засчитывается рабочим.
  const shift = tzOffset * 3600000;
  const d = new Date(new Date(from).getTime() + shift);
  const isWeekend = (x) => x.getUTCDay() === 0 || x.getUTCDay() === 6;

  // Поставлена после конца рабочего дня — считается поставленной утром
  // следующего: пятница вечером с приоритетом 3 — это среда, а не вторник.
  if (d.getUTCHours() * 60 + d.getUTCMinutes() >= workWindow(settings).to) {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(0, 0, 0, 0);
  }
  // задача, поставленная в выходной, считается поставленной в понедельник
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);

  // Приоритет 1 означает «сегодня до конца дня», а не «завтра»,
  // поэтому прибавляем на день меньше.
  let left = Math.max(0, Math.round(days) - 1);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) left -= 1;
  }
  d.setUTCHours(21, 0, 0, 0); // конец рабочего дня по местному времени
  return new Date(d.getTime() - shift).toISOString();
}

// Рабочий день для расчёта сроков и часов задач. Отдельно от окна ответов
// в чате (work_start/work_end — там до 22:00): задачи делаются днём.
// Задача, поставленная в пятницу в 23:00 и взятая в понедельник в 9:13,
// ждала 13 минут — с начала рабочего дня.
function workWindow(settings = {}) {
  const parse = (v, fallback) => {
    const [h, m] = String(v || fallback).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const from = parse(settings.task_day_start || settings.work_start, '09:00');
  const to = parse(settings.task_day_end, '18:00');
  return { from, to: Math.max(from + 60, to), dayMin: Math.max(60, to - from) };
}

const isWeekendLocal = (ms) => {
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
};
/** Границы рабочего окна для дня, в котором лежит момент. */
function dayWindow(ms, win) {
  const d = new Date(ms);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: base + win.from * 60000, end: base + win.to * 60000, base };
}

/**
 * Рабочие минуты между двумя моментами.
 *
 * Считается только время внутри рабочего окна будних дней. Иначе задача,
 * пролежавшая в блокере с вечера пятницы до утра понедельника, получала бы
 * пятнадцать часов поблажки, хотя работать в это время всё равно было нельзя.
 */
function workMinutesBetween(fromIso, toIso, settings = {}) {
  const tz = num(settings, 'tz_offset', 3) * 3600000;
  const win = workWindow(settings);
  let cur = new Date(fromIso).getTime() + tz;
  const to = new Date(toIso).getTime() + tz;
  if (!(to > cur)) return 0;

  let minutes = 0;
  let guard = 0;
  while (cur < to && guard++ < 4000) {
    const w = dayWindow(cur, win);
    if (!isWeekendLocal(cur)) {
      const from = Math.max(cur, w.start);
      const till = Math.min(to, w.end);
      if (till > from) minutes += Math.round((till - from) / 60000);
    }
    cur = w.base + 86400000 + win.from * 60000; // утро следующего дня
  }
  return minutes;
}

/**
 * Прибавляет рабочие минуты к моменту, перешагивая вечера и выходные.
 * Нужно для сдвига срока на время паузы: три рабочих дня ожидания
 * должны сдвинуть дедлайн на три рабочих дня, а не на 24 часа подряд.
 */
function addWorkMinutes(fromIso, minutes, settings = {}) {
  const tz = num(settings, 'tz_offset', 3) * 3600000;
  const win = workWindow(settings);
  let cur = new Date(fromIso).getTime() + tz;
  let left = Math.max(0, Math.round(minutes));
  let guard = 0;

  while (left > 0 && guard++ < 4000) {
    const w = dayWindow(cur, win);
    if (isWeekendLocal(cur) || cur >= w.end) {
      cur = w.base + 86400000 + win.from * 60000;
      continue;
    }
    const from = Math.max(cur, w.start);
    const available = Math.round((w.end - from) / 60000);
    if (available >= left) {
      cur = from + left * 60000;
      left = 0;
    } else {
      left -= available;
      cur = w.base + 86400000 + win.from * 60000;
    }
  }
  return new Date(cur - tz).toISOString();
}

/** Настройка со списком id колонок: «a,b,c» → Set. */
const colSet = (settings, key) =>
  new Set((settings[key] || '').split(',').map((s) => s.trim()).filter(Boolean));

/** В какой стадии находится задача, судя по её колонке. */
function stageOfColumn(columnId, settings) {
  if (!columnId) return null;
  if (colSet(settings, 'column_in_progress').has(columnId)) return 'in_progress';
  if (colSet(settings, 'column_review').has(columnId)) return 'review';
  if (colSet(settings, 'column_done').has(columnId)) return 'accepted';
  // «Блокер» — работа стоит не по вине исполнителя, но и не сдана
  if (colSet(settings, 'column_blocked').has(columnId)) return 'blocked';
  // «В ожидании» и «Гаджеты» — работа сделана, ждём внешний результат
  if (colSet(settings, 'column_waiting').has(columnId)) return 'waiting';
  // общий список на случай неразмеченных настроек
  if (colSet(settings, 'column_paused').has(columnId)) return 'blocked';
  // «На контроле» и «На потом» — задача ещё не решена, только отложена
  if (colSet(settings, 'column_shelved').has(columnId)) return 'shelved';
  if (colSet(settings, 'column_cancelled').has(columnId)) return 'cancelled';
  if (colSet(settings, 'column_backlog').has(columnId)) return 'open';
  return null;
}

// ── таймлайн задачи ─────────────────────────────────────────────────────────
//
// Источник истины — системный лог карточки в YouGile: каждое перемещение
// между колонками с точным временем и автором. Синхронизация раз в час
// такие переходы пропускала (взяли и вернули между опросами — и следа нет),
// а по логу таймлайн восстанавливается целиком, в том числе у задач,
// закрытых до запуска системы.

function freshTimeline() {
  return {
    status: 'open', taken: null, submitted: null, done: null,
    workDoneAt: null, workDoneKind: null, returns: 0, pausedMin: 0, pausedSince: null,
  };
}

/**
 * Один переход карточки в стадию. Таймер выполнения идёт только в «В работе»:
 * на проверке, в блокере, в ожидании, «на потом» и «на контроле» он стоит
 * и продолжается, когда карточка возвращается в работу. Пауза копится
 * в рабочих минутах: календарные дарили бы сутки за каждые выходные.
 */
function applyStage(st, stage, at, settings) {
  const pausedHere = st.pausedSince ? workMinutesBetween(st.pausedSince, at, settings) : 0;

  if (stage === 'in_progress') {
    if (st.status === 'review') st.returns += 1; // вернулась с проверки
    st.status = 'in_progress';
    st.taken = st.taken || at;
    if (st.pausedSince) { st.pausedMin += pausedHere; st.pausedSince = null; }
    // вернулись к работе — значит она не была закончена
    st.workDoneAt = null;
    st.workDoneKind = null;
  } else if (stage === 'review') {
    st.status = 'review';
    st.submitted = st.submitted || at;
    if (!st.workDoneAt) { st.workDoneAt = at; st.workDoneKind = 'submitted'; }
    if (st.taken) st.pausedSince = st.pausedSince || at;
  } else if (stage === 'accepted') {
    st.status = 'accepted';
    st.done = st.done || at;
    // приняли прямо из паузы без сдачи (блокер → завершена): стоявшее время не в счёт
    if (st.pausedSince && !st.workDoneAt) st.pausedMin += pausedHere;
    st.pausedSince = null;
    if (!st.workDoneAt) { st.workDoneAt = st.done; st.workDoneKind = 'accepted'; }
  } else if (stage === 'blocked') {
    st.status = 'blocked';
    if (st.taken) st.pausedSince = st.pausedSince || at;
  } else if (stage === 'waiting') {
    // работа сдана, ждём внешний результат
    st.status = 'waiting';
    if (st.taken) st.pausedSince = st.pausedSince || at;
    if (!st.workDoneAt) { st.workDoneAt = at; st.workDoneKind = 'handed_off'; }
  } else if (stage === 'shelved') {
    st.status = 'shelved';
    if (st.taken) st.pausedSince = st.pausedSince || at;
  } else if (stage === 'cancelled') {
    st.status = 'cancelled';
    st.pausedSince = null;
  } else if (stage === 'open') {
    // вернули в «Добавлена»: как будто и не брали — если ещё не сдана
    if (!st.workDoneAt) { st.status = 'open'; st.pausedSince = null; }
  }
  return st;
}

/** Системные события карточки из YouGile, по времени. null — лог недоступен. */
async function fetchTaskLog(env, taskId, settings) {
  const key = env.YOUGILE_KEY || settings.yougile_key;
  if (!key) return null;
  const base = settings.yougile_base || 'https://yougile.com/api-v2';
  const events = [];
  try {
    for (let offset = 0, guard = 0; guard < 20; guard += 1) {
      const res = await fetch(
        `${base}/chats/${taskId}/messages?limit=100&offset=${offset}&includeSystem=true`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      for (const m of data.content || []) {
        const p = m.properties || {};
        const at = Number(m.id) > 0 ? new Date(Number(m.id)).toISOString() : null; // id сообщения — его время
        if (!at) continue;
        const reason = String(p.reason || '');
        if (p.move && p.to) events.push({ at, kind: 'move', from: p.from || null, to: p.to, by: p.actionBy || null });
        else if (p.assigned) events.push({ at, kind: 'assigned', user: p.assigned, by: p.actionBy || null });
        // галочка «выполнена»: снята — «-> !isCompleted», поставлена — «-> isCompleted»
        else if (p.after === 'undone' || p.after === 'notDone' || /->\s*!isCompleted/.test(reason)) events.push({ at, kind: 'reopened', by: p.actionBy || null });
        else if (p.after === 'done' || /->\s*isCompleted/.test(reason)) events.push({ at, kind: 'completed', by: p.actionBy || null });
      }
      if (!data.paging?.next) break;
      offset += (data.content || []).length || 100;
    }
  } catch {
    return null;
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return events;
}

/** Проигрывает лог с нуля: получается таймлайн, каким его видел трекер. */
function replayLog(events, settings) {
  let st = freshTimeline();
  st.assignedAt = {}; // когда кого назначили: для исполнителя «поставлена» — это его назначение
  st.cycleStart = null; // переоткрыли — задача поставлена заново с этого момента
  const firstAt = events.length ? events[0].at : null;
  for (const e of events) {
    if (e.kind === 'move') {
      const stage = stageOfColumn(e.to, settings);
      // Карточка уезжает из «В работе», а взятия в логе не было — значит,
      // её создали прямо в этой колонке: взята в момент постановки.
      if (stageOfColumn(e.from, settings) === 'in_progress' && !st.taken) {
        st.taken = st.cycleStart || firstAt;
        st.status = 'in_progress';
        st.takenBy = st.takenBy || e.by;
      }
      if (stage === 'in_progress' && !st.taken && e.by) st.takenBy = e.by; // кто взял — тот и делает
      applyStage(st, stage, e.at, settings);
    } else if (e.kind === 'assigned') {
      st.assignedAt[e.user] = st.assignedAt[e.user] || e.at;
    } else if (e.kind === 'completed') {
      applyStage(st, 'accepted', e.at, settings);
    } else if (e.kind === 'reopened') {
      // Сняли галочку «выполнена»: это новый цикл. Всё, что было до —
      // отработано и посчитано; с этого момента задача поставлена заново.
      st = { ...freshTimeline(), assignedAt: st.assignedAt, cycleStart: e.at };
    }
  }
  return st;
}

async function upsertTaskFromYougile(env, t, settings, opts = {}) {
  const db = env.DB;
  const existing = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(t.id).first();
  const now = nowIso();
  const assigned = Array.isArray(t.assigned) ? t.assigned : t.assigned ? [t.assigned] : [];

  // Кто из назначенных известен приложению — исполнитель выбирается ниже,
  // когда прочитан лог: важно, кто на самом деле взял карточку в работу.
  let known = [];
  if (assigned.length) {
    const marks = assigned.map(() => '?').join(',');
    known = (await db
      .prepare(`SELECT id, yougile_id, role FROM users WHERE active = 1 AND yougile_id IN (${marks})`)
      .bind(...assigned)
      .all()).results;
  }

  const title = t.title || existing?.title || 'Без названия';
  const stage = stageOfColumn(t.columnId, settings);
  const completedAt = t.completedTimestamp ? new Date(t.completedTimestamp).toISOString() : null;

  // Карточка сдвинулась (или её просят пересчитать) — берём лог из трекера
  // и проигрываем заново. Не сдвинулась — оставляем как есть. Лог недоступен —
  // считаем по текущему переходу, как раньше.
  const moved = !existing
    || existing.column_id !== (t.columnId || null)
    || Boolean(t.completed) !== (existing.status === 'accepted' || existing.status === 'historical');
  let st = existing ? {
    status: existing.status, taken: existing.taken_at, submitted: existing.submitted_at,
    done: existing.done_at, workDoneAt: existing.work_done_at, workDoneKind: existing.work_done_kind,
    returns: existing.returns || 0, pausedMin: existing.paused_min || 0, pausedSince: existing.paused_since,
  } : freshTimeline();
  let fromLog = false;
  if (moved || opts.rebuild) {
    const log = await fetchTaskLog(env, t.id, settings);
    if (log) {
      st = replayLog(log, settings);
      fromLog = true;
      // Карточку могли только что перетащить, а лог ещё не дописан —
      // текущая колонка важнее последней записи. Пустой лог у новой карточки
      // в «В работе» — её так и создали: взята при постановке.
      const at = !log.length && !existing && t.timestamp ? new Date(t.timestamp).toISOString() : now;
      if (stage && stage !== st.status && stage !== 'open') applyStage(st, stage, at, settings);
    } else if (moved) {
      applyStage(st, stage, now, settings);
    }
  }

  // Исполнитель. На карточке может стоять несколько человек из отдела —
  // руководитель тоже делает задачи как ассистент. Делает тот, кто перетащил
  // карточку в «В работе»; если её ещё не брали — назначенный последним;
  // один человек — он и есть. Никого из отдела — задача ничья.
  let user = null;
  if (known.length === 1) {
    user = known[0];
  } else if (known.length > 1) {
    const byTaken = st.takenBy ? known.find((u) => u.yougile_id === st.takenBy) : null;
    const byAssigned = st.assignedAt
      ? [...known].sort((a, b) => String(st.assignedAt[b.yougile_id] || '').localeCompare(String(st.assignedAt[a.yougile_id] || '')))[0]
      : null;
    user = byTaken || (existing && known.find((u) => u.id === existing.assignee_id)) || byAssigned || known[0];
  }
  const assignee = user ? user.yougile_id : assigned[0] || null;

  // «Поставлена» для исполнителя — когда его назначили, а не когда карточку
  // завели: руководитель нередко заводит задачу себе и отдаёт позже.
  const assignedAt = fromLog && assignee && st.assignedAt ? st.assignedAt[assignee] || null : null;
  const cycleStart = fromLog ? st.cycleStart || null : null;
  const createdAt = [assignedAt, cycleStart].filter(Boolean).sort().pop()
    || (!fromLog && existing?.created_at)
    || (t.timestamp ? new Date(t.timestamp).toISOString() : now);

  // Ссылка в YouGile строится по проектному номеру (VSE-370), а не по общему
  // (ID-452): именно его показывает адресная строка трекера.
  const projectNo = t.idTaskProject || existing?.project_no || null;
  const url = settings.yougile_team && projectNo
    ? `https://ru.yougile.com/team/${settings.yougile_team}/#${projectNo}`
    : existing?.url || null;

  // Размер задачи берём со стикера, а не выдумываем
  const size = Number(
    stickerValue(t, settings.sticker_size, stateMap(settings, 'size_states'),
                 settings.size_default || '1')
  ) || 1;

  // Уровень сложности — то, по чему разложены все шесть метрик времени.
  // Стикер размера ставит человек, поэтому он главнее всего. Где стикера нет,
  // уровень один раз угадывает локальная модель по заголовку и остаётся
  // записанным: заголовок почти не меняется, гонять модель заново незачем.
  const hasSizeSticker = Boolean(settings.sticker_size && t?.stickers?.[settings.sticker_size]);
  let level = existing?.level || null;
  let levelSrc = existing?.level_src || null;
  if (levelSrc === 'manual') {
    // руководитель поправил руками — ни стикер, ни модель это не перебивают
  } else if (hasSizeSticker) {
    level = sizeToLevel(size);
    levelSrc = 'sticker';
  } else if (!level || levelSrc === 'default') {
    // Исторические и отменённые в метрики не идут — модель на них не тратим:
    // на двух ядрах каждая задача стоит секунды.
    const skipModel = existing?.status === 'historical' || existing?.status === 'cancelled'
      || (!existing && t.completed) || t.archived || t.deleted;
    const guessed = skipModel ? null : await guessLevelWithModel(title, settings);
    level = guessed || sizeToLevel(size);
    levelSrc = guessed ? 'model' : 'default';
  }

  // Срок вычисляется из стикера «Приоритет»: это рабочие дни от постановки.
  // Явная дата в карточке, если она есть, важнее — её ставили руками.
  // Приоритет фиксируется снимком при первой синхронизации: смена стикера
  // задним числом не должна отматывать уже накопленную просрочку.
  const priorityDays = existing?.priority || Number(
    stickerValue(t, settings.sticker_priority, stateMap(settings, 'priority_states'),
                 settings.priority_default || '7')
  );
  // Срок — полные рабочие дни в рабочих часах от постановки: приоритет 3 —
  // это 27 рабочих часов. Иначе задача, поставленная в 17:26, теряла бы
  // почти целый день: он засчитывался первым из трёх.
  const deadline = t.deadline?.deadline
    ? new Date(t.deadline.deadline).toISOString()
    : (priorityDays ? deadlineByPriority(createdAt, priorityDays, settings) : existing?.deadline || null);

  let { status, taken, submitted, done, returns, pausedMin, pausedSince, workDoneAt, workDoneKind } = st;
  // взята раньше, чем назначена этому исполнителю (переназначили в ходе работы) —
  // до старта у него ноль, а не отрицательное
  if (taken && taken < createdAt) taken = createdAt;

  // YouGile сам отмечает завершённость — это надёжнее, чем угадывать по колонке
  if (t.completed && status !== 'accepted' && status !== 'cancelled') {
    status = 'accepted';
    done = done || completedAt || now;
    if (!workDoneAt) { workDoneAt = done; workDoneKind = 'accepted'; }
  }
  // Точное время закрытия из трекера
  if (completedAt && status === 'accepted' && (!done || done > completedAt)) {
    done = completedAt;
    if (workDoneKind === 'accepted' || !workDoneAt) { workDoneAt = completedAt; workDoneKind = 'accepted'; }
  }
  if (!t.completed && status === 'accepted' && stage && stage !== 'accepted') {
    // сняли галочку и вернули на доску
    status = stage;
    done = null;
  }

  // Историческая — закрытая до запуска, когда реальных дат не было. С логом
  // даты есть, и такая задача возвращается в расчёт при пересчёте.
  if (existing?.status === 'historical' && !fromLog && (status === 'accepted' || stage === null)) {
    status = 'historical';
    done = null;
  }
  if (fromLog && status === 'accepted' && !taken) {
    // закрыта, но в «В работе» не была: метрик по ней нет, но и не историческая
  }
  if (t.archived || t.deleted) status = 'cancelled';

  // Часы обеих стадий считаем сразу и храним готовыми: иначе каждый отчёт
  // заново разбирал бы рабочий календарь по всем задачам квартала.
  const dur = taskDurations(
    { created_at: createdAt, taken_at: taken, work_done_at: workDoneAt, done_at: done,
      paused_min: pausedMin },
    settings
  );

  // Месяц закрытия — им пользуются деньги и заёбы. Метрики времени
  // привязаны к дате постановки и берут её отдельно, из created_at.
  const period = done ? done.slice(0, 7) : existing?.period || null;

  if (existing) {
    // индекс пересчитываем, только если поменялся заголовок — обычно он лежит нетронутым
    const keywords = existing.keywords && title === existing.title
      ? existing.keywords
      : taskKeywords({ ...t, title });

    await db
      .prepare(
        `UPDATE tasks SET title=?, number=?, project_no=?, url=?, board_id=?, column_id=?, keywords=?, assignee_id=?,
         size=?, level=?, level_src=?, priority=?, created_at=?, deadline=?, status=?, taken_at=?,
         submitted_at=?, done_at=?, work_done_at=?, work_done_kind=?, returns=?,
         paused_min=?, paused_since=?, t2s_hours=?, t2f_hours=?,
         period=?, updated_at=? WHERE id=?`
      )
      .bind(title, t.idTaskCommon || existing.number, projectNo, url, t.boardId || existing.board_id,
            t.columnId || existing.column_id, keywords,
            user?.id || (assigned.length ? null : existing.assignee_id), size, level, levelSrc,
            priorityDays, createdAt, deadline, status, taken,
            submitted, done, workDoneAt, workDoneKind,
            returns, pausedMin, pausedSince, dur.t2s, dur.t2f, period, now, t.id)
      .run();
  } else {
    // задачу завёл сам исполнитель — это инициатива
    const isInitiative = assignee && t.createdBy && t.createdBy === assignee ? 1 : 0;

    // Задача, которая попала в базу уже закрытой и без лога, — историческая:
    // подставлять сегодняшнюю дату закрытия нечестно. С логом даты настоящие.
    if (status === 'accepted' && !fromLog) {
      status = 'historical';
      done = null;
    }
    await db
      .prepare(
        `INSERT INTO tasks (id, title, number, project_no, url, board_id, column_id, keywords, assignee_id,
         author_id, size, level, level_src, priority, created_at, deadline, status,
         taken_at, submitted_at, done_at, work_done_at, work_done_kind, returns,
         paused_min, paused_since, t2s_hours, t2f_hours,
         is_initiative, is_zaeb, period)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(t.id, title, t.idTaskCommon || null, projectNo, url, t.boardId || null, t.columnId || null,
            taskKeywords({ ...t, title }),
            user?.id || null, t.createdBy || null, size, level, levelSrc,
            priorityDays, createdAt, deadline,
            status, taken, submitted, done, workDoneAt, workDoneKind,
            returns, pausedMin, pausedSince, dur.t2s, dur.t2f, isInitiative,
            colSet(settings, 'column_zaeb').has(t.columnId || '') ? 1 : 0, period)
      .run();
    await logEvent(db, { taskId: t.id, type: 'created', at: createdAt });
  }

  // Заёб закрыт: приз получает тот, кто его закрыл, а не тот, на кого
  // задача была назначена — в колонке «Заёб» она висит на всех сразу.
  const wasZaeb = colSet(settings, 'column_zaeb').has(existing?.column_id || '')
    || existing?.is_zaeb === 1;
  const isZaebNow = colSet(settings, 'column_zaeb').has(t.columnId || '');
  if ((wasZaeb || isZaebNow) && status === 'accepted' && !existing?.zaeb_awarded && !opts.quiet) {
    await db.prepare('UPDATE tasks SET is_zaeb = 1, zaeb_awarded = 1 WHERE id = ?').bind(t.id).run();

    // Кто передвинул карточку в «Завершена» — тот и закрыл заёб.
    // Назначение здесь не подходит: задача висит сразу на всех.
    const movedBy = await whoMovedTask(env, t.id, colSet(settings, 'column_done'), settings);
    const closer = movedBy
      ? await db.prepare('SELECT id, name, role FROM users WHERE yougile_id = ? AND active = 1')
          .bind(movedBy).first()
      : null;

    if (closer) {
      await askZaebTier(env, { id: t.id, title }, closer);
    } else {
      // автора действия определить не удалось — спрашиваем
      await askWhoClosedZaeb(env, { id: t.id, title });
    }
  } else if (isZaebNow && !existing?.is_zaeb) {
    await db.prepare('UPDATE tasks SET is_zaeb = 1 WHERE id = ?').bind(t.id).run();
  }

  if (stage === 'in_progress' && !existing?.taken_at) await logEvent(db, { taskId: t.id, type: 'taken', at: taken || now });
  if (stage === 'review' && existing?.status !== 'review') await logEvent(db, { taskId: t.id, type: 'submitted', at: submitted || now });
  if (stage === 'paused' && existing?.status !== 'paused') {
    await logEvent(db, { taskId: t.id, type: 'manual', note: 'ушла в ожидание или блокер' });
  }
}

// ── интеграция с телеграм-ботом ──────────────────────────────────────────────

/**
 * Бот в общем чате присылает сюда замеры: кто и через сколько ответил.
 * Сам замер живёт в боте — Worker только хранит и агрегирует.
 */
async function handleTgHook(request, env, settings) {
  const db = env.DB;
  const secret = env.HOOK_SECRET;
  if (secret && request.headers.get('x-hook-secret') !== secret) return bad('нет доступа', 403);

  const b = await request.json().catch(() => null);
  if (!b) return bad('пустое тело');

  const user = b.tg_user_id
    ? await db.prepare('SELECT id FROM users WHERE tg_user_id = ?').bind(String(b.tg_user_id)).first()
    : null;

  await db
    .prepare(
      `INSERT INTO chat_replies (user_id, chat_id, request_msg, reply_msg, asked_at, replied_at, seconds, in_hours, period)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .bind(user?.id || null, String(b.chat_id || ''), String(b.request_msg || ''),
          String(b.reply_msg || ''), b.asked_at, b.replied_at || null,
          b.seconds ?? null, b.in_hours === false ? 0 : 1,
          b.period || currentPeriod(num(settings, 'tz_offset', 3)))
    .run();

  return json({ ok: true });
}

/**
 * Обработка сообщений общего чата.
 *
 * Логика замера намеренно простая, иначе её нельзя объяснить команде:
 *   сообщение руководителя или лида  → открытый запрос
 *   первое сообщение ассистента после → ответ, разница и есть скорость
 *
 * Ответ через reply привязывается к конкретному запросу — это точный случай.
 * Без reply берётся последний открытый запрос в чате.
 * Сообщения вне рабочего окна помечаются и в оценку скорости не идут.
 */
async function handleTelegramUpdate(request, env, settings) {
  const db = env.DB;
  const update = await request.json().catch(() => null);

  // Реакция на сообщение — тоже ответ. Поставить смайлик под просьбой
  // означает «увидел, принял»; требовать сверх этого текст было бы придиркой.
  if (update?.message_reaction) return handleReaction(update.message_reaction, env, settings);
  if (update?.callback_query) return handleCallback(update.callback_query, env, settings);

  const msg = update?.message || update?.edited_message;
  if (!msg || !msg.from || msg.from.is_bot) return json({ ok: true });

  // личка — панель управления составом
  if (msg.chat.type === 'private') return handleBotCommand(msg, env, settings);

  const wanted = settings.tg_chat_id;
  if (wanted && String(msg.chat.id) !== String(wanted)) return json({ ok: true });

  let user = await db
    .prepare('SELECT id, role, name FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(String(msg.from.id))
    .first();

  // Привязка по нику: лид заранее прислал «@ник», а id становится известен
  // только когда человек напишет в чат — Telegram не отдаёт id по нику.
  if (!user && msg.from.username) {
    const pending = await db
      .prepare('SELECT id, role, name FROM users WHERE lower(tg_username) = ? AND tg_user_id IS NULL AND active = 1')
      .bind(msg.from.username.toLowerCase())
      .first();
    if (pending) {
      await db.prepare('UPDATE users SET tg_user_id = ? WHERE id = ?')
        .bind(String(msg.from.id), pending.id).run();
      user = pending;
    }
  }
  if (!user) return json({ ok: true, skipped: 'неизвестный отправитель' });

  const at = new Date(msg.date * 1000).toISOString();
  const tz = num(settings, 'tz_offset', 3);
  const period = currentPeriod(tz);
  const inHours = isWorkTime(msg.date * 1000, settings) ? 1 : 0;

  // отметка активности: по ней отличаем новый вопрос от продолжения разговора
  const prevState = await db
    .prepare('SELECT last_msg_at, last_from FROM chat_state WHERE chat_id = ?')
    .bind(String(msg.chat.id))
    .first();
  await db
    .prepare(
      `INSERT INTO chat_state (chat_id, last_msg_at, last_from) VALUES (?,?,?)
       ON CONFLICT(chat_id) DO UPDATE SET last_msg_at = excluded.last_msg_at,
       last_from = excluded.last_from`
    )
    .bind(String(msg.chat.id), at, user.id)
    .run();

  // запрос от руководителя или лида
  if (user.role === 'chief' || user.role === 'lead') {
    // «понял, спасибо» таймер не открывает
    if (!needsReply(msg, settings)) return json({ ok: true, skipped: 'ответ не требуется' });

    // Идёт живая переписка — это продолжение разговора, а не новый вопрос.
    // Иначе за одну беседу ассистент набрал бы десяток «быстрых ответов».
    const windowMin = num(settings, 'dialog_window_min', 20);
    const quiet = prevState?.last_msg_at
      ? (new Date(at) - new Date(prevState.last_msg_at)) / 60000
      : Infinity;
    if (quiet < windowMin) {
      return json({ ok: true, skipped: `продолжение разговора, тишины было ${Math.round(quiet)} мин` });
    }

    const text = (msg.text || msg.caption || '').toLowerCase();
    const words = (settings.urgent_words || '').split(',').map((w) => w.trim()).filter(Boolean);
    const urgent = words.some((w) => text.includes(w)) ? 1 : 0;

    // Кому адресовано. Явный тег — самый надёжный сигнал. Если тега нет,
    // ищем задачу по смыслу сообщения и спрашиваем с её исполнителя:
    // руководитель в YouGile не пишет и адресата не указывает.
    const mention = await resolveMention(db, msg);
    let mentionId = mention.id;
    let matchedTask = null;
    let matchHow = null;

    // Задачу по смыслу ищем, только если адресата не назвали. Если человека
    // тегнули явно — вопрос его, и никого другого он не касается,
    // даже когда текст похож на чужую задачу.
    if (!mention.raw) {
      const found = await detectTask(db, msg.text || msg.caption || '', settings);
      matchHow = found.how;
      if (found.task?.assignee_id) {
        mentionId = found.task.assignee_id;
        matchedTask = found.task;
      }
    } else if (!mentionId) {
      // тег есть, но человека нет в системе — вопрос не штрафует никого
      matchHow = `тегнут ${mention.raw}, но такого человека нет в системе`;
    }

    // Лид всегда тегает, когда ставит задачу. Значит сообщение лида без тега,
    // когда висит вопрос руководителя, — это его собственный ответ, а не запрос.
    if (user.role === 'lead' && !mention.raw && !mentionId) {
      const openForLead = await db
        .prepare(
          `SELECT * FROM chat_replies WHERE chat_id = ? AND replied_at IS NULL
           AND asked_role = 'chief' AND (mention_id IS NULL OR mention_id = ?)
           ORDER BY asked_at DESC LIMIT 1`
        )
        .bind(String(msg.chat.id), user.id)
        .first();

      if (openForLead) {
        const seconds = Math.max(0, Math.round((new Date(at) - new Date(openForLead.asked_at)) / 1000));
        await db
          .prepare('UPDATE chat_replies SET user_id = ?, reply_msg = ?, replied_at = ?, seconds = ? WHERE id = ?')
          .bind(user.id, String(msg.message_id), at, seconds, openForLead.id)
          .run();
        return json({ ok: true, tracked: 'reply', by: 'lead', seconds });
      }
    }

    await db
      .prepare(
        `INSERT INTO chat_replies (user_id, chat_id, request_msg, asked_by, asked_role, asked_at,
         in_hours, urgent, mention_id, mention_raw, period)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(String(msg.chat.id), String(msg.message_id), user.id, user.role, at, inHours, urgent,
            mentionId, mention.raw, period)
      .run();

    // Бот подсказывает в чат, кого ждут: сообщение руководителя без адресата
    // иначе висит, пока каждый думает, что спросили не у него.
    if (matchedTask && mentionId) {
      const who = await db
        .prepare('SELECT name, tg_username FROM users WHERE id = ?')
        .bind(mentionId)
        .first();
      if (who) {
        const nick = who.tg_username ? `@${who.tg_username}` : who.name;
        await sendTelegram(
          env,
          msg.chat.id,
          `${nick}, вопрос к вам — задача «${matchedTask.title.slice(0, 90)}»`,
          { reply_to: msg.message_id }
        );
        await logEvent(db, {
          taskId: matchedTask.id,
          userId: mentionId,
          type: 'manual',
          at,
          note: `бот связал вопрос с задачей: ${matchHow}`,
          source: 'telegram',
        });
      }
    }

    return json({ ok: true, tracked: 'request', urgent: !!urgent, task: matchedTask?.title, how: matchHow });
  }

  // Ассистент пишет сам. Это либо ответ на висящий вопрос, либо его
  // собственный вопрос — и тогда он бьёт по автономности: владелец
  // в YouGile не пишет, поэтому вовлечённость меряется здесь, в чате.
  let open = null;
  if (msg.reply_to_message) {
    open = await db
      .prepare(
        `SELECT * FROM chat_replies WHERE chat_id = ? AND request_msg = ? AND replied_at IS NULL`
      )
      .bind(String(msg.chat.id), String(msg.reply_to_message.message_id))
      .first();
  }
  if (!open) {
    // сначала ищем запрос, адресованный лично этому человеку
    open = await db
      .prepare(
        `SELECT * FROM chat_replies WHERE chat_id = ? AND replied_at IS NULL AND mention_id = ?
         ORDER BY asked_at LIMIT 1`
      )
      .bind(String(msg.chat.id), user.id)
      .first();
  }
  if (!open) {
    // иначе закрываем последний общий запрос: засчитывается первому ответившему
    open = await db
      .prepare(
        `SELECT * FROM chat_replies WHERE chat_id = ? AND replied_at IS NULL
         AND (mention_id IS NULL OR mention_id = ?)
         ORDER BY asked_at DESC LIMIT 1`
      )
      .bind(String(msg.chat.id), user.id)
      .first();
  }
  // Открытого вопроса нет — значит ассистент написал сам. Если это вопрос,
  // он отнимает автономность: именно так меряется «сколько раз пришлось
  // отвлечь руководителя», раз в YouGile тот не пишет.
  if (!open) {
    const text = msg.text || msg.caption || '';
    if (!text.includes('?')) return json({ ok: true, skipped: 'не вопрос' });

    const found = await detectTask(db, text, settings);
    if (!found.task) return json({ ok: true, skipped: 'вопрос без привязки к задаче' });

    await db
      .prepare('UPDATE tasks SET chief_touched = 1 WHERE id = ?')
      .bind(found.task.id)
      .run();
    await logEvent(db, {
      taskId: found.task.id,
      userId: user.id,
      type: 'chief_message',
      at,
      note: `вопрос в чате: ${text.slice(0, 120)}`,
      source: 'telegram',
    });
    return json({ ok: true, tracked: 'question', task: found.task.title, how: found.how });
  }

  const seconds = Math.max(0, Math.round((new Date(at) - new Date(open.asked_at)) / 1000));
  await db
    .prepare(
      `UPDATE chat_replies SET user_id = ?, reply_msg = ?, replied_at = ?, seconds = ? WHERE id = ?`
    )
    .bind(user.id, String(msg.message_id), at, seconds, open.id)
    .run();

  return json({ ok: true, tracked: 'reply', seconds });
}

/**
 * Заёб закрыт — спрашиваем, кто именно его закрыл.
 *
 * Задача из колонки «Заёб» висит на всех сразу, поэтому исполнителя
 * из назначения не вывести, а YouGile не сообщает, кто двигал карточку.
 * Один тап руководителя отдела решает это однозначно и оставляет след.
 */
/**
 * Кто передвинул карточку в нужную колонку.
 *
 * YouGile пишет это в чат задачи системными сообщениями: у них
 * properties.move = true, а в properties.actionBy лежит автор действия.
 * Обычные сообщения такие события не показывают — нужен includeSystem.
 */
async function whoMovedTask(env, taskId, toColumnIds, settings) {
  const key = env.YOUGILE_KEY || settings.yougile_key;
  if (!key) return null;
  const base = settings.yougile_base || 'https://yougile.com/api-v2';

  try {
    const res = await fetch(
      `${base}/chats/${taskId}/messages?limit=100&includeSystem=true`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));

    // идём с конца: интересует последнее перемещение
    const moves = (data.content || []).filter((m) => m.properties?.move && m.properties?.actionBy);
    for (let i = moves.length - 1; i >= 0; i -= 1) {
      const p = moves[i].properties;
      if (!toColumnIds || toColumnIds.has(p.to)) return p.actionBy;
    }
    // задачу могли закрыть галочкой, не двигая карточку
    const completed = (data.content || [])
      .filter((m) => m.properties?.actionBy && m.properties?.after === 'done');
    return completed.length ? completed[completed.length - 1].properties.actionBy : null;
  } catch {
    return null;
  }
}

async function askWhoClosedZaeb(env, task) {
  const db = env.DB;
  const lead = await db
    .prepare("SELECT tg_user_id FROM users WHERE role = 'lead' AND active = 1 AND tg_user_id IS NOT NULL")
    .first();
  if (!lead) return;

  const { results: people } = await db
    .prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('assistant','lead') ORDER BY role DESC, name")
    .all();

  const rows = people.map((u) => [{ text: u.name, callback_data: `zw:${task.id}:${u.id}` }]);
  rows.push([{ text: 'Не начислять', callback_data: `zw:${task.id}:skip` }]);

  await sendTelegram(
    env,
    lead.tg_user_id,
    `<b>Заёб закрыт</b>\n${task.title.slice(0, 150)}\n\nКто закрыл? Определить по логу не вышло.`,
    { keyboard: rows }
  );
}

/**
 * Закрывшего уже знаем — остаётся тариф. Размер заёба задаётся при
 * заведении карточки, но в YouGile его негде хранить единообразно,
 * поэтому подтверждается одним тапом.
 */
async function askZaebTier(env, task, closer) {
  const db = env.DB;
  const lead = await db
    .prepare("SELECT tg_user_id FROM users WHERE role = 'lead' AND active = 1 AND tg_user_id IS NOT NULL")
    .first();
  if (!lead) return;

  const tiers = [
    ['S', 3000, 'бесит редко, решается один раз'],
    ['M', 5000, 'бесит каждую неделю'],
    ['L', 10000, 'бесит ежедневно или бьёт по работоспособности'],
    ['XL', 15000, 'бьёт по здоровью, нужен внедрённый процесс'],
  ];

  await sendTelegram(
    env,
    lead.tg_user_id,
    `<b>Заёб закрыт</b>\n${task.title.slice(0, 150)}\n\n` +
      `Закрыл: <b>${closer.name}</b> — по логу YouGile.\n\nКакой размер?\n` +
      tiers.map(([n, a, d]) => `${n} · ${a.toLocaleString('ru-RU')} ₽ — ${d}`).join('\n'),
    {
      keyboard: [tiers.map(([n, a]) =>
        ({ text: `${n} · ${a.toLocaleString('ru-RU')} ₽`, callback_data: `zt:${task.id}:${closer.id}:${n}:${a}` }))],
    }
  );
}

/**
 * Ответы на кнопки: кто закрыл заёб и по какому тарифу.
 * Приз идёт закрывшему, руководителю отдела — доля сверху,
 * но только если закрыл не он сам.
 */
async function handleCallback(cq, env, settings) {
  const db = env.DB;
  const data = String(cq.data || '');
  const answer = (text) => tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });

  // выбор человека → спрашиваем тариф
  if (data.startsWith('zw:')) {
    const [, taskId, userId] = data.split(':');
    if (userId === 'skip') {
      await db.prepare('UPDATE tasks SET zaeb_awarded = 1 WHERE id = ?').bind(taskId).run();
      await tgApi(env, 'editMessageText', {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: 'Приз за этот заёб не начисляем.',
      });
      return answer('Хорошо');
    }
    const tiers = [['S', 3000], ['M', 5000], ['L', 10000], ['XL', 15000]];
    await tgApi(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text: `${cq.message.text}\n\nТариф?`,
      reply_markup: {
        inline_keyboard: [tiers.map(([n, a]) =>
          ({ text: `${n} · ${a.toLocaleString('ru-RU')} ₽`, callback_data: `zt:${taskId}:${userId}:${n}:${a}` }))],
      },
    });
    return answer('Выберите тариф');
  }

  // выбор тарифа → начисляем
  if (data.startsWith('zt:')) {
    const [, taskId, userId, tier, amountRaw] = data.split(':');
    const amount = parseInt(amountRaw, 10) || 0;

    const task = await db.prepare('SELECT title FROM tasks WHERE id = ?').bind(taskId).first();
    const who = await db.prepare('SELECT name, role FROM users WHERE id = ?').bind(userId).first();
    const lead = await db.prepare("SELECT id, name FROM users WHERE role='lead' AND active=1").first();

    // доля руководителя отдела — только если закрыл кто-то из команды
    const share = who?.role === 'lead' ? 0 : Math.round(amount * num(settings, 'lead_share_zaeb', 0.1));
    const period = currentPeriod(num(settings, 'tz_offset', 3));

    await db
      .prepare(
        `INSERT INTO awards (user_id, kind, title, tier, amount, lead_amount, status, period, confirm_due)
         VALUES (?,'zaeb',?,?,?,?,'half_paid',?,?)`
      )
      .bind(userId, task?.title || 'Заёб', tier, amount, share, period,
            new Date(Date.now() + 30 * 864e5).toISOString())
      .run();

    await db.prepare('UPDATE tasks SET zaeb_awarded = 1, is_zaeb = 1 WHERE id = ?').bind(taskId).run();
    await logEvent(db, {
      taskId, userId, type: 'manual', source: 'telegram',
      note: `заёб закрыт, тариф ${tier}, приз ${amount} ₽${share ? `, доля лида ${share} ₽` : ''}`,
    });

    await tgApi(env, 'editMessageText', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
      text:
        `<b>Заёб закрыт</b>\n${(task?.title || '').slice(0, 150)}\n\n` +
        `Закрыл: <b>${who?.name}</b>\nТариф ${tier} — <b>${amount.toLocaleString('ru-RU')} ₽</b>\n` +
        (share ? `Вам как руководителю: <b>${share.toLocaleString('ru-RU')} ₽</b>\n` : '') +
        `\nПоловина выплачивается сейчас, вторая — через 30 дней, если не всплывёт снова.`,
      parse_mode: 'HTML',
    });
    return answer('Начислено');
  }

  return answer('');
}

/**
 * Реакция на сообщение засчитывается как ответ.
 *
 * Telegram присылает такие события отдельным типом и только если он явно
 * указан в allowed_updates при установке вебхука — по умолчанию их нет.
 * Учитывается лишь появление реакции: снятие смайлика ответ не отменяет.
 */
async function handleReaction(reaction, env, settings) {
  const db = env.DB;
  const from = reaction.user;
  if (!from || from.is_bot) return json({ ok: true });

  const added = (reaction.new_reaction || []).length > (reaction.old_reaction || []).length;
  if (!added) return json({ ok: true, skipped: 'реакцию сняли' });

  const user = await db
    .prepare('SELECT id, role FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(String(from.id))
    .first();
  if (!user || user.role === 'chief') return json({ ok: true });

  // ищем открытый вопрос именно на это сообщение
  const open = await db
    .prepare(
      `SELECT * FROM chat_replies
       WHERE chat_id = ? AND request_msg = ? AND replied_at IS NULL
       AND (mention_id IS NULL OR mention_id = ?)
       LIMIT 1`
    )
    .bind(String(reaction.chat.id), String(reaction.message_id), user.id)
    .first();
  if (!open) return json({ ok: true, skipped: 'нет открытого вопроса на это сообщение' });

  const at = new Date((reaction.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const seconds = Math.max(0, Math.round((new Date(at) - new Date(open.asked_at)) / 1000));

  await db
    .prepare('UPDATE chat_replies SET user_id = ?, replied_at = ?, seconds = ? WHERE id = ?')
    .bind(user.id, at, seconds, open.id)
    .run();

  return json({ ok: true, tracked: 'reaction', seconds });
}

/**
 * Панель управления в личке бота.
 *
 * Telegram не отдаёт id пользователя по нику, поэтому человек заводится
 * по нику и «оживает», когда впервые напишет в общий чат. До этого момента
 * он числится ожидающим — это видно в /team.
 */
async function handleBotCommand(msg, env, settings) {
  const db = env.DB;
  const from = String(msg.from.id);
  const text = (msg.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const reply = (t) => sendTelegram(env, from, t).then(() => json({ ok: true }));

  const me = await db
    .prepare('SELECT id, name, role FROM users WHERE tg_user_id = ? AND active = 1')
    .bind(from)
    .first();

  // первичная активация: назначает отправителя руководителем отдела
  if (cmd === '/init') {
    if (me) return reply(`Вы уже в системе: ${me.name}.`);
    const secret = rest.join(' ').trim();
    if (!env.BOOTSTRAP_SECRET || secret !== env.BOOTSTRAP_SECRET) {
      return reply('Неверный секрет. Формат: /init <секрет>');
    }
    const key = newKey();
    await db
      .prepare(
        `INSERT INTO users (id, name, role, grade, key_hash, tg_user_id, tg_username)
         VALUES (?,?,'lead','A3',?,?,?)`
      )
      .bind(crypto.randomUUID(), msg.from.first_name || 'Руководитель отдела',
            await sha256(key), from, (msg.from.username || '').toLowerCase() || null)
      .run();
    return reply(
      `Готово, вы руководитель отдела.\n\nКлюч для входа в приложение (показывается один раз):\n<code>${key}</code>\n\n` +
      `Дальше: /assist @ник Имя — добавить ассистента, /help — все команды.`
    );
  }

  if (!me) return reply('Вас нет в системе. Обратитесь к руководителю отдела.');
  if (me.role !== 'lead' && cmd !== '/help' && cmd !== '/me') {
    return reply('Эта команда доступна только руководителю отдела.');
  }

  if (cmd === '/help' || cmd === '/start') {
    return reply(
      '<b>Команды</b>\n' +
      '/assist @ник Имя — добавить ассистента\n' +
      '/chief @ник Имя — добавить руководителя\n' +
      '/team — состав отдела\n' +
      '/key @ник — выдать новый ключ в приложение\n' +
      '/off @ник — отключить человека\n' +
      '/chat — привязать этот чат как рабочий\n' +
      '/me — мои результаты за месяц'
    );
  }

  if (cmd === '/assist' || cmd === '/chief') {
    const nick = (rest[0] || '').replace('@', '').toLowerCase();
    const name = rest.slice(1).join(' ').trim();
    if (!nick || !name) return reply(`Формат: ${cmd} @ник Имя Фамилия`);

    const role = cmd === '/assist' ? 'assistant' : 'chief';

    // Человек может уже быть заведён — из YouGile или руками. Ищем сначала
    // по нику, потом по имени, и только если совпадений нет, создаём нового.
    // Иначе одна команда плодит двойников с пустыми id.
    let exists = await db
      .prepare('SELECT id, name FROM users WHERE lower(tg_username) = ?')
      .bind(nick).first();
    if (!exists) {
      exists = await db
        .prepare('SELECT id, name FROM users WHERE lower(name) = lower(?) OR lower(name) LIKE lower(?)')
        .bind(name, name.split(' ')[0] + '%').first();
    }

    if (exists) {
      await db
        .prepare('UPDATE users SET name = ?, role = ?, tg_username = ?, active = 1 WHERE id = ?')
        .bind(name, role, nick, exists.id).run();
      return reply(
        `Обновил уже заведённого: <b>${name}</b> — ${role === 'assistant' ? 'ассистент' : 'руководитель'}, ник @${nick}.\n\n` +
        `Новую запись не создавал, чтобы не было двойников.`
      );
    }

    const key = newKey();
    await db
      .prepare(
        `INSERT INTO users (id, name, role, grade, key_hash, tg_username)
         VALUES (?,?,?,'A2',?,?)`
      )
      .bind(crypto.randomUUID(), name, role, await sha256(key), nick)
      .run();
    return reply(
      `Добавлен: <b>${name}</b> (@${nick}) — ${role === 'assistant' ? 'ассистент' : 'руководитель'}.\n\n` +
      `Ключ для входа в приложение:\n<code>${key}</code>\n\n` +
      `Замер начнётся, как только он напишет в рабочем чате: Telegram не отдаёт id по нику.`
    );
  }

  if (cmd === '/team') {
    const { results } = await db
      .prepare('SELECT name, role, grade, tg_username, tg_user_id, active FROM users ORDER BY role, name')
      .all();
    const label = { assistant: 'ассистент', lead: 'рук. отдела', chief: 'руководитель' };
    const lines = results.map((u) =>
      `${u.active ? '' : '⛔ '}<b>${u.name}</b> — ${label[u.role]}` +
      `${u.tg_username ? ` @${u.tg_username}` : ''}` +
      `${u.tg_user_id ? ' ✅' : ' ⏳ ждёт первого сообщения'}`
    );
    return reply(`<b>Состав отдела</b>\n\n${lines.join('\n') || 'пусто'}`);
  }

  if (cmd === '/key') {
    const nick = (rest[0] || '').replace('@', '').toLowerCase();
    const u = await db.prepare('SELECT id, name FROM users WHERE lower(tg_username) = ?').bind(nick).first();
    if (!u) return reply('Не нашёл такого ника. /team — список.');
    const key = newKey();
    await db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').bind(await sha256(key), u.id).run();
    return reply(`Новый ключ для ${u.name} (старый больше не работает):\n<code>${key}</code>`);
  }

  if (cmd === '/off') {
    const nick = (rest[0] || '').replace('@', '').toLowerCase();
    const u = await db.prepare('SELECT id, name FROM users WHERE lower(tg_username) = ?').bind(nick).first();
    if (!u) return reply('Не нашёл такого ника.');
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(u.id).run();
    return reply(`${u.name} отключён. История сохранена.`);
  }

  if (cmd === '/chat') {
    return reply('Перешлите сюда любое сообщение из рабочего чата или отправьте /chat <id>. ' +
      'Проще всего: напишите что-нибудь в рабочем чате — бот привяжет его сам, если он там единственный.');
  }

  if (cmd === '/me') {
    const period = currentPeriod(num(settings, 'tz_offset', 3));
    const full = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    const p = await buildProfile(db, full, period, settings);
    return reply(
      `<b>${p.user.name}</b>, ${period}\n\n` +
      `Кэф: <b>${p.money.kef}</b>\n` +
      `Качество ${p.metrics.quality} · Скорость ${p.metrics.speed}\n` +
      `Самостоятельность ${p.metrics.autonomy}\n\n` +
      `К выплате сверх оклада: <b>${p.money.total.toLocaleString('ru-RU')} ₽</b>`
    );
  }

  return reply('Не понял команду. /help — список.');
}

/**
 * Кому адресовано сообщение. Telegram даёт два вида упоминаний:
 * text_mention с готовым id (для тех, у кого нет ника) и обычный @ник.
 */
async function resolveMention(db, msg) {
  const entities = msg.entities || msg.caption_entities || [];
  const text = msg.text || msg.caption || '';

  let raw = null; // кого тегнули, даже если в базе такого нет
  for (const e of entities) {
    if (e.type === 'text_mention' && e.user?.id) {
      raw = raw || String(e.user.id);
      const u = await db.prepare('SELECT id FROM users WHERE tg_user_id = ?')
        .bind(String(e.user.id)).first();
      if (u) return { id: u.id, raw };
    }
    if (e.type === 'mention') {
      const nick = text.substr(e.offset + 1, e.length - 1).toLowerCase();
      raw = raw || `@${nick}`;
      const u = await db.prepare('SELECT id FROM users WHERE lower(tg_username) = ?')
        .bind(nick).first();
      if (u) return { id: u.id, raw };
    }
  }
  // raw заполнен, а id нет — тег был, но человека нет в системе.
  // Такой вопрос не должен штрафовать никого: адресат назван,
  // просто он неизвестен боту.
  return { id: null, raw };
}

/** Отправка сообщения в Telegram. Токен лежит в секретах, не в коде. */
async function sendTelegram(env, chatId, text, extra = {}) {
  if (!env.TG_TOKEN || !chatId) return null;
  const { keyboard, reply_to, ...rest } = extra;
  return tgApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(reply_to ? { reply_to_message_id: reply_to } : {}),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    ...rest,
  });
}

/** Любой метод Telegram Bot API. Токен живёт в секретах, не в коде. */
async function tgApi(env, method, payload) {
  if (!env.TG_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => null);
}

/**
 * Напоминание о висящем вопросе. Задача не наказать, а не дать
 * сообщению потеряться: половина пропусков случается не из-за лени,
 * а потому что вопрос уехал вверх за десятком других.
 */
async function runEscalation(env, settings) {
  const db = env.DB;
  const after = num(settings, 'escalate_after_min', 30);
  const chatId = settings.tg_chat_id;
  if (!chatId) return { ok: false, error: 'не задан чат' };

  const cutoff = new Date(Date.now() - after * 60000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM chat_replies
       WHERE replied_at IS NULL AND escalated = 0 AND in_hours = 1 AND asked_at <= ?`
    )
    .bind(cutoff)
    .all();

  let sent = 0;
  for (const r of results) {
    if (!isWorkTime(Date.now(), settings)) continue; // ночью не будим
    const mins = Math.round((Date.now() - new Date(r.asked_at)) / 60000);
    await sendTelegram(
      env, chatId,
      `⏳ Вопрос висит без ответа ${mins} мин.`,
      { reply_to_message_id: Number(r.request_msg) || undefined }
    );
    await db.prepare('UPDATE chat_replies SET escalated = 1 WHERE id = ?').bind(r.id).run();
    sent += 1;
  }
  return { ok: true, escalated: sent };
}

/** Сегодня последний день месяца? Сводка уходит именно в этот день. */
function isLastDayOfMonth(tzOffset = 3) {
  const now = new Date(Date.now() + tzOffset * 3600e3);
  const tomorrow = new Date(now.getTime() + 86400e3);
  return tomorrow.getUTCDate() === 1;
}

/**
 * Месячная сводка руководителю отдела в личку — в последний день месяца.
 * Не «31 числа»: в коротких месяцах такого дня нет, а сводка нужна всегда.
 *
 * Показывает не только цифры, но и за что именно сняты и добавлены баллы,
 * со ссылками на конкретные сообщения в чате.
 */
async function sendMonthlyDigest(env, settings) {
  const db = env.DB;
  const tz = num(settings, 'tz_offset', 3);
  const now = new Date(Date.now() + tz * 3600e3);
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const lead = await db
    .prepare("SELECT * FROM users WHERE role = 'lead' AND tg_user_id IS NOT NULL AND active = 1")
    .first();
  if (!lead) return { ok: false, error: 'у руководителя отдела не указан Telegram' };

  const { results: people } = await db
    .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
    .all();

  const chatId = settings.tg_chat_id;
  const quarter = quarterOf(period);
  const sla = await loadSla(db, quarter);
  const fmtH = (h) => (h === null || h === undefined ? '—' : `${Math.round(h * 10) / 10} ч`);
  const fmtP = (v) => (v === null || v === undefined ? '—' : `${v} %`);
  const six = (m) => [
    `  до старта:  1 — ${fmtH(m.metrics.t2s1)} (${fmtP(m.percents.t2s1)}) · ` +
      `2 — ${fmtH(m.metrics.t2s2)} (${fmtP(m.percents.t2s2)}) · ` +
      `3 — ${fmtH(m.metrics.t2s3)} (${fmtP(m.percents.t2s3)})`,
    `  до сдачи:   1 — ${fmtH(m.metrics.t2f1)} (${fmtP(m.percents.t2f1)}) · ` +
      `2 — ${fmtH(m.metrics.t2f2)} (${fmtP(m.percents.t2f2)}) · ` +
      `3 — ${fmtH(m.metrics.t2f3)} (${fmtP(m.percents.t2f3)})`,
  ];
  // где узкое место: метрика с худшим процентом
  const worstLine = (m) => {
    const worst = Object.entries(m.percents)
      .filter(([, v]) => v !== null)
      .sort((a, b) => a[1] - b[1])[0];
    if (!worst || worst[1] >= 100) return null;
    const [k, v] = worst;
    return `  ⚠ слабее всего: ${k.startsWith('t2s') ? 'до старта' : 'до сдачи'}, уровень ${k.slice(3)} — ${v} % плана`;
  };

  // Сначала KPI руководителя: оценки каждого и премия месяца
  const kpi = await leadKpi(db, lead, period, settings);
  const fmtS = (v) => (v === null || v === undefined ? '—' : String(v));
  const scoreLine = (name, sc) =>
    `  ${name}: <b>${fmtS(sc.score)}</b>${sc.manual !== null ? ` (руками${sc.note ? `: ${sc.note}` : ''}, авто ${fmtS(sc.auto)})` : ' (авто)'}`;
  const lines = [
    `<b>Итоги ${period}</b> · квартал ${quarter}`,
    '',
    `<b>KPI руководителя: ${fmtS(kpi.score)} из 10 → ${kpi.bonus.toLocaleString('ru-RU')} ₽ из ${kpi.max.toLocaleString('ru-RU')}</b>`,
    scoreLine(lead.name, kpi.own),
    ...kpi.people.map((r) => scoreLine(r.name, r)),
    '',
  ];

  // Потом результат отдела целиком по шести метрикам
  const teamMonth = await monthMetrics(db, null, period, settings, sla);
  const teamQ = await quarterMetrics(db, null, quarter, settings);
  lines.push(
    `<b>Отдел</b> — план за месяц <b>${fmtP(teamMonth.avgPercent)}</b>, задач ${teamMonth.count}`,
    ...six(teamMonth),
    `  квартал: план ${fmtP(teamQ.avgPercent)}, система предлагает ${teamQ.markAuto ? MARK_LABEL[teamQ.markAuto] : '—'}`
  );
  const tw = worstLine(teamMonth);
  if (tw) lines.push(tw);
  lines.push('');

  // Потом по людям — чтобы видеть, кто тянет отдел вниз
  for (const p of people) {
    const month = await monthMetrics(db, p.id, period, settings, sla);
    lines.push(`<b>${p.name}</b> — план за месяц <b>${fmtP(month.avgPercent)}</b>, задач ${month.count}`, ...six(month));
    const w = worstLine(month);
    if (w) lines.push(w);
    lines.push('');
  }

  // реакция в чате — по-прежнему считается, но премии не определяет
  for (const p of people) {
    const { tasks, replies } = await fetchUserData(db, p.id, period, p.role);
    const m = computeMetrics({ tasks, replies, settings, grade: p.grade });
    const s = m.breakdown.speed;
    if (!s || !s.requests) continue;
    lines.push(`<b>${p.name}</b>, чат: медиана ответа ${s.medianReply === null ? '—' : humanSeconds(s.medianReply)}, ` +
      `пропусков ${s.misses}, вне часов ${s.offHoursAnswered}`);
    const bad = (s.detail || []).filter((d) => d.delta < 0).slice(0, 3);
    for (const d of bad) lines.push(`    ${d.why} ${msgLink(chatId, d.request_msg)}`);
  }

  lines.push('', `Графики, месяцы и отзывы — в приложении, вкладка «KPI».`);

  // Telegram не принимает сообщения длиннее 4096 символов
  const text = lines.join('\n');
  for (let i = 0; i < text.length; i += 3900) {
    await sendTelegram(env, lead.tg_user_id, text.slice(i, i + 3900));
  }
  return { ok: true, period, people: people.length };
}

/** Ссылка на сообщение в супергруппе: t.me/c/<id без -100>/<message_id>. */
function msgLink(chatId, messageId) {
  if (!chatId || !messageId) return '';
  const id = String(chatId).replace('-100', '');
  return `<a href="https://t.me/c/${id}/${messageId}">→</a>`;
}

const humanSeconds = (s) =>
  s < 60 ? `${s} сек` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;

/** Попадает ли момент в рабочее окно (с учётом часового пояса и выходных). */
function isWorkTime(ms, settings) {
  const tz = num(settings, 'tz_offset', 3);
  const d = new Date(ms + tz * 3600e3);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const [sh, sm] = (settings.work_start || '10:00').split(':').map(Number);
  const [eh, em] = (settings.work_end || '20:00').split(':').map(Number);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= sh * 60 + sm && minutes <= eh * 60 + em;
}

// ── точка входа ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: 'сбой на сервере', detail: String(err) }, 500);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Фронтенд не подключён', { status: 404 });
  },

  async scheduled(event, env) {
    const settings = await loadSettings(env.DB);
    const tz = num(settings, 'tz_offset', 3);

    // вечер последнего дня месяца — итоговая сводка
    if (event.cron === '0 18 * * *') {
      if (isLastDayOfMonth(tz)) await sendMonthlyDigest(env, settings);
      return;
    }

    // каждые 15 минут — напоминание о висящих вопросах
    await runEscalation(env, settings);

    // раз в час — подстраховочная синхронизация задач
    if (new Date().getUTCMinutes() < 15) {
      await syncYougile(env, settings);
    }
  },
};

// Открыто для тестов: чистые функции расчёта, без обращений к базе.
export const __test = {
  quarterOf, monthsOfQuarter, MARKS, MARK_LABEL,
  levelOfTask, taskDurations, timeMetrics, planPercent, autoMark,
  workMinutesBetween, addWorkMinutes, addWorkdays, deadlineByPriority, workWindow, applyStage, replayLog, freshTimeline,
  scoreTask, scoreChat, computeMetrics, scoreFromPercent, skipPriorities,
};

// Для служебных скриптов на сервере: полная пересинхронизация без ключа доступа.
export const __ops = { syncYougile, loadSettings, sendMonthlyDigest };
