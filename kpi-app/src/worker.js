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
  const pauseCap = Math.max(
    (task.priority || 7) * WORK_DAY_MIN,  // столько же рабочих минут, сколько дано на задачу
    3 * WORK_DAY_MIN                      // но не меньше трёх рабочих дней
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
// Time to fill  — от постановки до завершения.
//
// Обе в рабочих часах: ночь и выходные не идут в счёт, иначе задача,
// поставленная в пятницу вечером, показывала бы двое суток простоя.
// ─────────────────────────────────────────────────────────────────────────────

const LEVELS = [1, 2, 3];
const TIME_METRICS = ['t2s', 't2f'];

/** Размер со стикера в уровень сложности: S → 1, M → 2, L и XL → 3. */
function sizeToLevel(size) {
  const s = Number(size) || 1;
  return s <= 1 ? 1 : s === 2 ? 2 : 3;
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

  return { t2s: hours(from, toStart, false), t2f: hours(from, toFill, true) };
}

/**
 * Шесть метрик человека за период: среднее время по каждому уровню.
 *
 * Считается только по задачам, где стадия действительно наступила:
 * незакрытая задача не портит Time to fill, пока её не закрыли.
 */
function timeMetrics(tasks, settings) {
  const out = {};
  const detail = {};

  for (const metric of TIME_METRICS) {
    for (const level of LEVELS) {
      const key = `${metric}${level}`;
      const vals = tasks
        .filter((t) => levelOfTask(t) === level && !t.is_zaeb && t.status !== 'cancelled')
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

  const { results: tasks } = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE ${who.sql} AND is_zaeb = 0
         AND status NOT IN ('cancelled','historical')
         AND (created_at >= ? AND created_at < ?)
       ORDER BY created_at`
    )
    .bind(...who.args, `${period}-01`, `${period}-32`)
    .all();

  const { metrics, detail } = timeMetrics(tasks, settings);
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
    // Список задач с часами — для раскрытого месяца: видно, какая именно
    // задача тянет среднее вверх.
    tasks: tasks.map((t) => {
      const d = taskDurations(t, settings);
      return {
        id: t.id, number: t.number, title: t.title, assignee_id: t.assignee_id,
        level: levelOfTask(t), level_src: t.level_src || 'default',
        status: t.status, created_at: t.created_at,
        t2s: d.t2s, t2f: d.t2f,
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

/** Деньги: сколько забрано из каждого кошелька. */
function computeMoney(metrics, settings, extra = {}) {
  const basePurses = {
    quality: num(settings, 'purse_quality', 17500),
    autonomy: num(settings, 'purse_autonomy', 10000),
    speed: num(settings, 'purse_speed', 2500),
  };
  const values = {
    quality: metrics.quality,
    speed: metrics.speed,
    autonomy: metrics.autonomy,
  };

  // Метрика без данных — это не ноль и не десятка, это «нечем мерить».
  //
  // Если за месяц не было ни одного вопроса в чате, «скорость 10» ничего
  // не доказывает: сигнала не было. Платить за это нельзя, но и наказывать
  // человека за чужое молчание несправедливо. Поэтому такой кошелёк
  // не выплачивается и не сгорает — он расходится по остальным метрикам,
  // и человек зарабатывает те же деньги, но только за измеренное.
  const usable = metrics.usable || {};
  const skipped = Object.keys(basePurses).filter((k) => usable[k] === false);
  const live = Object.keys(basePurses).filter((k) => !skipped.includes(k));

  const purses = { ...basePurses };
  if (skipped.length && live.length) {
    const freed = skipped.reduce((a, k) => a + basePurses[k], 0);
    const liveSum = live.reduce((a, k) => a + basePurses[k], 0) || 1;
    for (const k of skipped) purses[k] = 0;
    for (const k of live) {
      purses[k] = Math.round(basePurses[k] + freed * (basePurses[k] / liveSum));
    }
  }

  const threshold = num(settings, 'cut_threshold', 5);
  const cutFactor = num(settings, 'cut_factor', 0.85);
  const low = live.some((k) => values[k] < threshold);
  const cut = low ? cutFactor : 1;
  const mult = extra.chiefMultiplier ?? 1;

  // Какие метрики просели ниже порога — из-за них режется весь итог.
  // Без этого пояснения оценка «10 из 10» рядом с неполной суммой
  // выглядит ошибкой расчёта, хотя это сработавшая отсечка.
  const NAMES = { quality: 'качество', speed: 'скорость', autonomy: 'самостоятельность' };
  // отсечка смотрит только на метрики, у которых была база
  const lowNames = live
    .filter((k) => values[k] < threshold)
    .map((k) => `${NAMES[k]} ${round2(values[k])}`);

  const wallets = {};
  let bonus = 0;
  for (const k of Object.keys(purses)) {
    const earned = purses[k] * (values[k] / 10); // до поправок
    // Безупречная метрика отсечкой не режется: если человек всегда на связи
    // и отвечает вовремя, он забирает эту часть целиком, чем бы ни закончились
    // остальные направления. Наказывать за чужую метрику здесь не за что.
    const perfect = values[k] >= 10;
    const got = earned * mult * (perfect ? 1 : cut);
    wallets[k] = {
      pool: purses[k],
      score: values[k],
      earned: Math.round(earned),
      got: Math.round(got),
      perfect,
      // почему из кошелька пришло меньше, чем набрано по оценке
      reductions: [
        cut !== 1 && !perfect && {
          kind: 'отсечка',
          factor: cut,
          amount: Math.round(earned * mult * (1 - cut)),
          why: `есть метрика ниже ${threshold}: ${lowNames.join(', ')}`,
        },
        mult !== 1 && {
          kind: mult > 1 ? 'надбавка за оценку месяца' : 'оценка месяца',
          factor: mult,
          amount: Math.round(earned * (mult - 1)),
          why: 'множитель от руководителя',
        },
      ].filter(Boolean),
    };
    bonus += got;
  }

  const pool = num(settings, 'bonus_pool', 30000);
  return {
    wallets,
    bonus: Math.round(bonus),
    kef: round2((bonus / mult / cut / pool) * 10),
    cutApplied: low,
    cutFactor: cut,
    cutReason: low ? `сработала отсечка ×${cut}: ${lowNames.join(', ')}` : null,
    multiplier: mult,
  };
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

/** Коэффициент помощи держим в разумных пределах и с шагом настройки. */
function clampHelp(value, settings) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 1;
  const min = num(settings, 'help_min', 0.5);
  const max = num(settings, 'help_max', 2);
  return Math.min(max, Math.max(min, Math.round(v * 100) / 100));
}

/** Полная карточка человека: метрики, деньги, задачи с таймингами. */
async function buildProfile(db, user, period, settings) {
  const { tasks, replies, awards } = await fetchUserData(
    db, user.id, period, user.role, settings.start_from || null
  );

  // Коэффициент за помощь. Владелец ставит его вручную: плюс и минус
  // двигают на шаг, число можно вписать напрямую. Значение меньше единицы
  // тоже допустимо — коэффициент работает в обе стороны.
  const helpRow = await db
    .prepare('SELECT value, note FROM help_marks WHERE user_id = ? AND period = ?')
    .bind(user.id, period)
    .first();
  const helpMult = clampHelp(helpRow ? helpRow.value : 1, settings);
  const metrics = computeMetrics({ tasks, replies, settings, grade: user.grade });
  const money = computeMoney(metrics, settings, { chiefMultiplier: helpMult });

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
    money: {
      ...money,
      zaeb: zaebSum,
      savingSum,
      savingPay,
      salary: user.salary || 0,
      total: money.bonus + zaebSum + savingPay,
    },
    help: {
      multiplier: round2(helpMult),
      note: helpRow?.note || null,
      step: num(settings, 'help_step', 0.1),
      min: num(settings, 'help_min', 0.5),
      max: num(settings, 'help_max', 2),
      // сколько рублей добавил или отнял коэффициент
      delta: Math.round(money.bonus - money.bonus / helpMult),
    },
    awards,
    tasks: metrics.scored.map(decorateTask),
    openTasks: tasks
      .filter((t) => !['accepted', 'failed', 'cancelled'].includes(t.status))
      .map(decorateTask),
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
function decorateTask(t) {
  const toTake = minutesBetween(t.created_at, t.taken_at);
  const toDo = minutesBetween(t.taken_at, t.submitted_at || t.done_at);
  const total = minutesBetween(t.created_at, t.done_at);
  const overdue =
    t.deadline && t.done_at ? minutesBetween(t.deadline, t.done_at) : null;

  return {
    id: t.id,
    title: t.title,
    url: t.url,
    size: t.size,
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
      toTakeHuman: humanMinutes(toTake),
      toDoMin: toDo,
      toDoHuman: humanMinutes(toDo),
      totalMin: total,
      totalHuman: humanMinutes(total),
      overdueMin: overdue && overdue > 0 ? overdue : null,
      overdueHuman: overdue && overdue > 0 ? humanMinutes(overdue) : null,
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

  // вебхук YouGile — принимается без ключа доступа, поэтому проверяется секрет
  if (path === '/hook/yougile' && request.method === 'POST') {
    return handleYougileHook(request, env, settings);
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

  // сводка по отделу — только лид и руководитель
  if (path === '/team') {
    if (!['lead', 'chief'].includes(me.role)) return bad('нет доступа', 403);
    const { results: people } = await db
      .prepare("SELECT * FROM users WHERE role = 'assistant' AND active = 1 ORDER BY name")
      .all();

    const profiles = [];
    for (const p of people) profiles.push(await buildProfile(db, p, period, settings));

    const avgKef = profiles.length
      ? round2(profiles.reduce((a, p) => a + p.money.kef, 0) / profiles.length)
      : 0;

    // метрики лида
    const allClosed = profiles.flatMap((p) => p.tasks);
    const acceptedFirstTry = allClosed.filter((t) => t.returns === 0).length;
    const filterRate = allClosed.length ? acceptedFirstTry / allClosed.length : 0;
    const solo = allClosed.filter((t) => !t.chiefTouched).length;
    const unloadRate = allClosed.length ? solo / allClosed.length : 0;

    const leadShareZaeb = num(settings, 'lead_share_zaeb', 0.17);
    const leadShareSaving = num(settings, 'lead_share_saving', 0.05);
    const teamZaeb = profiles.reduce((a, p) => a + p.money.zaeb, 0);
    const teamSaving = profiles.reduce((a, p) => a + p.money.savingSum, 0);

    // Скорость лида: своя реакция на вопросы руководителя плюс скорость
    // команды. Одной командной мало — молчать самому тоже нельзя, а одной
    // своей мало тем более: если ассистент систематически просрачивает
    // ответы, это должно бить и по доходу того, кто им руководит.
    //
    // Профиль лида считается всегда, а не только когда он сам смотрит:
    // владельцу нужно видеть и его цифры тоже.
    const leadUser = await db
      .prepare("SELECT * FROM users WHERE role = 'lead' AND active = 1 ORDER BY created_at LIMIT 1")
      .first();
    const leadOwn = leadUser ? await buildProfile(db, leadUser, period, settings) : null;
    const teamSpeed = profiles.length
      ? round2(profiles.reduce((a, p) => a + p.metrics.speed, 0) / profiles.length)
      : 0;
    const wPersonal = num(settings, 'lead_speed_personal', 0.4);
    const wTeam = num(settings, 'lead_speed_team', 0.6);
    const leadSpeed = leadOwn
      ? round2(wPersonal * leadOwn.metrics.speed + wTeam * teamSpeed)
      : teamSpeed;

    // Кошельки лида. «Фильтр» и «Разгрузка» убраны: они мерили возвраты
    // от владельца и его вовлечение в карточки, а владелец в трекер
    // не заходит вовсе. Обе всегда показывали 100 % и просто дарили деньги.
    // Вместо них — собственные задачи лида, по тем же правилам,
    // что у ассистентов, плюс результат команды.
    const leadPools = {
      team: num(settings, 'lead_purse_team', 20000),
      quality: num(settings, 'lead_purse_quality', 15000),
      autonomy: num(settings, 'lead_purse_autonomy', 8000),
      speed: num(settings, 'lead_purse_speed', 7000),
    };
    const leadWallets = {
      team: Math.round(leadPools.team * (avgKef / 10)),
      quality: Math.round(leadPools.quality * ((leadOwn?.metrics.quality || 0) / 10)),
      autonomy: Math.round(leadPools.autonomy * ((leadOwn?.metrics.autonomy || 0) / 10)),
      speed: Math.round(leadPools.speed * (leadSpeed / 10)),
    };

    return json({
      period,
      avgKef,
      people: profiles.map((p) => ({
        id: p.user.id,
        name: p.user.name,
        grade: p.user.grade,
        kef: p.money.kef,
        metrics: {
          quality: p.metrics.quality,
          speed: p.metrics.speed,
          autonomy: p.metrics.autonomy,
        },
        tasksClosed: p.tasks.length,
        tasksOpen: p.openTasks.length,
        medianReply: p.metrics.breakdown.speed.medianReply,
        help: p.help,
        bonus: p.money.bonus,
        total: p.money.total,
      })),
      lead: {
        avgKef,
        id: leadUser?.id || null,
        name: leadUser?.name || null,
        // Владельцу нужны те же подробности, что и по ассистентам,
        // поэтому отдаём полный разбор, а не только итоговые цифры.
        own: leadOwn ? {
          quality: leadOwn.metrics.quality,
          autonomy: leadOwn.metrics.autonomy,
          speed: leadOwn.metrics.speed,
          tasks: leadOwn.tasks.length,
          openTasks: leadOwn.openTasks.length,
          breakdown: leadOwn.metrics.breakdown,
          money: leadOwn.money,
          help: leadOwn.help,
        } : null,
        wallets: leadWallets,
        speed: {
          total: leadSpeed,
          personal: leadOwn ? leadOwn.metrics.speed : null,
          team: teamSpeed,
          weights: { personal: wPersonal, team: wTeam },
          formula: `своя ${leadOwn ? leadOwn.metrics.speed : '—'} × ${wPersonal} + команда ${teamSpeed} × ${wTeam}`,
          ownDetail: leadOwn ? leadOwn.metrics.breakdown.speed : null,
        },
        shareZaeb: Math.round(teamZaeb * leadShareZaeb),
        shareSaving: Math.round(teamSaving * leadShareSaving),
        bonus:
          leadWallets.team + leadWallets.quality + leadWallets.autonomy + leadWallets.speed,
      },
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

  // Коэффициент за помощь. Ставит владелец: кнопками по шагу или вписав
  // число напрямую. Меньше единицы тоже можно — коэффициент работает
  // в обе стороны и умножает всю премию человека.
  if (path.startsWith('/help/')) {
    if (!['chief', 'lead'].includes(me.role)) return bad('только руководитель', 403);
    const [, , userId, action] = path.split('/');
    const target = await db.prepare('SELECT id, name FROM users WHERE id = ?').bind(userId).first();
    if (!target) return bad('не найден', 404);

    const body = await request.json().catch(() => ({}));
    const cur = await db
      .prepare('SELECT value FROM help_marks WHERE user_id = ? AND period = ?')
      .bind(userId, period)
      .first();
    const step = num(settings, 'help_step', 0.1);
    const was = cur ? Number(cur.value) : 1;

    let next = was;
    if (action === 'add') next = was + step;
    else if (action === 'sub') next = was - step;
    else if (action === 'set') next = Number(body.value);
    else if (action === 'reset') next = 1;
    next = clampHelp(next, settings);

    await db
      .prepare(
        `INSERT INTO help_marks (user_id, period, value, note, actor, at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(user_id, period) DO UPDATE SET
           value = excluded.value, note = excluded.note,
           actor = excluded.actor, at = excluded.at`
      )
      .bind(userId, period, next, body.note || null, me.name, nowIso())
      .run();

    if (round2(next) !== round2(was)) {
      await logEvent(db, {
        userId, type: 'manual', actor: me.name, source: 'manual',
        note: `коэффициент помощи ${round2(was)} → ${round2(next)}${body.note ? `: ${body.note}` : ''}`,
      });
    }

    return json({ ok: true, multiplier: round2(next), step });
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
    return json({ tasks: results.map((t) => ({ ...decorateTask(t), assignee: t.assignee_name })) });
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
    return json({ task: decorateTask(task), events: results, score: scoreTask(task) });
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
// API модели времени.
//
// Ассистент видит себя и обезличенный срез отдела. Руководитель отдела и
// владелец — всех. Нормы, грейды, матрица премий и закрытие квартала —
// только руководителю и владельцу.
// ─────────────────────────────────────────────────────────────────────────────
async function handleKpiApi(request, db, path, url, me, settings) {
  const isBoss = ['lead', 'chief'].includes(me.role);
  const tz = num(settings, 'tz_offset', 3);
  const quarter = url.searchParams.get('quarter') || quarterOf(currentPeriod(tz));
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) return bad('квартал в виде 2026-Q3');

  // Вся доска одним запросом: люди, их месяцы, квартал, нормы, срез отдела.
  // Данных немного — несколько человек на три месяца — и клиенту удобнее
  // строить графики и раскрывать месяцы, не бегая за каждым кусочком.
  if (path === '/board' && request.method === 'GET') {
    const sla = await loadSla(db, quarter);
    const { results: people } = await db
      .prepare(
        `SELECT id, name, role, grade_num, salary, yougile_id, tg_username, active
         FROM users WHERE role = 'assistant' AND active = 1 ${isBoss ? '' : 'AND id = ?'}
         ORDER BY name`
      )
      .bind(...(isBoss ? [] : [me.id]))
      .all();

    const rows = [];
    for (const p of people) {
      const q = await quarterMetrics(db, p.id, quarter, settings);
      const result = await db
        .prepare('SELECT * FROM quarter_results WHERE user_id = ? AND quarter = ?')
        .bind(p.id, quarter)
        .first();
      const { results: reviews } = await db
        .prepare(
          `SELECT r.id, r.kind, r.mark, r.text, r.created_at, r.author_id, u.name AS author
           FROM reviews r LEFT JOIN users u ON u.id = r.author_id
           WHERE r.user_id = ? AND r.quarter = ? ORDER BY r.created_at`
        )
        .bind(p.id, quarter)
        .all();

      // Премия «как есть»: по итоговой оценке, если квартал закрыт,
      // иначе по той, что предлагает система.
      const mark = result?.mark || q.markAuto;
      const salaryQuarter = (p.salary || 0) * 3;
      const bonus = await quarterBonus(db, p.grade_num, mark, salaryQuarter);

      rows.push({
        id: p.id, name: p.name, role: p.role, grade: p.grade_num,
        salary: p.salary, salaryQuarter,
        access: { yougile: Boolean(p.yougile_id), telegram: Boolean(p.tg_username) },
        quarter: { metrics: q.metrics, percents: q.percents, avgPercent: q.avgPercent, markAuto: q.markAuto },
        months: q.months,
        mark, bonus,
        result: result || null,
        // текст отзывов только тому, кто имеет право их читать
        reviews: isBoss || p.id === me.id
          ? reviews
          : reviews.map((r) => ({ id: r.id, kind: r.kind, created_at: r.created_at })),
      });
    }

    // Срез отдела — по тем же правилам, но по всем задачам разом.
    const team = await quarterMetrics(db, null, quarter, settings);

    // Коллеги ассистента — только имена: чтобы было о ком написать отзыв.
    // Чужие цифры ему не показываются.
    const { results: peers } = await db
      .prepare("SELECT id, name FROM users WHERE role = 'assistant' AND active = 1 AND id != ? ORDER BY name")
      .bind(me.id)
      .all();
    // и что он уже написал о коллегах в этом квартале
    const { results: myPeerReviews } = await db
      .prepare(
        `SELECT r.id, r.user_id, r.mark, r.text, r.created_at, u.name
         FROM reviews r JOIN users u ON u.id = r.user_id
         WHERE r.author_id = ? AND r.kind = 'peer' AND r.quarter = ?`
      )
      .bind(me.id, quarter)
      .all();

    return json({
      quarter,
      months: monthsOfQuarter(quarter),
      sla,
      overplan: num(settings, 'overplan_percent', 120),
      marks: MARKS.map((m) => ({ id: m, label: MARK_LABEL[m] })),
      people: rows,
      team: { metrics: team.metrics, percents: team.percents, avgPercent: team.avgPercent, months: team.months },
      me: { id: me.id, role: me.role },
      peers: me.role === 'assistant' ? peers : [],
      myPeerReviews: me.role === 'assistant' ? myPeerReviews : [],
    });
  }

  // ── Нормы (SLA) ────────────────────────────────────────────────────────────
  if (path === '/sla' && request.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM sla ORDER BY valid_from, metric, level').all();
    return json({ sla: results, current: await loadSla(db, quarter) });
  }

  if (path === '/sla' && request.method === 'POST') {
    if (!isBoss) return bad('нет доступа', 403);
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
    if (!isBoss) return bad('нет доступа', 403);
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

  // ── Отзывы: сам о себе, коллега по желанию, руководитель ──────────────────
  if (path === '/reviews' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const kind = b.kind;
    const about = b.user_id || me.id;
    const q = b.quarter || quarter;
    if (!['self', 'peer', 'lead'].includes(kind)) return bad('вид отзыва: self, peer или lead');
    if (!/^\d{4}-Q[1-4]$/.test(q)) return bad('квартал в виде 2026-Q3');
    if (b.mark && !MARKS.includes(b.mark)) return bad('такой оценки нет');

    // Кто о ком может писать. Самооценка — только о себе; отзыв коллеги —
    // ассистент о другом ассистенте; отзыв руководителя — только руководитель.
    if (kind === 'self' && about !== me.id) return bad('самооценку пишут о себе', 403);
    if (kind === 'peer' && (about === me.id || isBoss)) return bad('отзыв коллеги пишет ассистент о коллеге', 403);
    if (kind === 'lead' && !isBoss) return bad('отзыв руководителя пишет руководитель', 403);

    const text = String(b.text || '').trim();
    if (!text && !b.mark) return bad('нужен текст или оценка');

    // Один отзыв от одного автора на квартал: повторная отправка обновляет
    const existing = await db
      .prepare('SELECT id FROM reviews WHERE user_id = ? AND author_id = ? AND kind = ? AND quarter = ?')
      .bind(about, me.id, kind, q)
      .first();
    if (existing) {
      await db
        .prepare('UPDATE reviews SET mark = ?, text = ?, created_at = ? WHERE id = ?')
        .bind(b.mark || null, text, nowIso(), existing.id)
        .run();
      return json({ ok: true, id: existing.id, updated: true });
    }
    const r = await db
      .prepare('INSERT INTO reviews (user_id, author_id, kind, quarter, mark, text, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(about, me.id, kind, q, b.mark || null, text, nowIso())
      .run();
    return json({ ok: true, id: r.meta?.last_row_id });
  }

  if (path.startsWith('/reviews/') && request.method === 'DELETE') {
    const id = Number(path.split('/').pop());
    const r = await db.prepare('SELECT * FROM reviews WHERE id = ?').bind(id).first();
    if (!r) return bad('отзыва нет', 404);
    if (r.author_id !== me.id && !isBoss) return bad('нет доступа', 403);
    await db.prepare('DELETE FROM reviews WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // ── Итог квартала ──────────────────────────────────────────────────────────
  // Руководитель смотрит на процент плана и отзывы и ставит оценку.
  // После закрытия цифры замораживаются: пересинхронизация задач их не тронет.
  if (path === '/quarter/close' && request.method === 'POST') {
    if (!isBoss) return bad('нет доступа', 403);
    const b = await request.json().catch(() => ({}));
    const q = b.quarter || quarter;
    if (!/^\d{4}-Q[1-4]$/.test(q)) return bad('квартал в виде 2026-Q3');
    if (!MARKS.includes(b.mark)) return bad('нужна итоговая оценка');

    const user = await db
      .prepare("SELECT * FROM users WHERE id = ? AND role = 'assistant'")
      .bind(b.user_id)
      .first();
    if (!user) return bad('сотрудник не найден', 404);

    const m = await quarterMetrics(db, user.id, q, settings);
    const salaryQuarter = (user.salary || 0) * 3;
    const bonus = await quarterBonus(db, user.grade_num, b.mark, salaryQuarter);

    await db
      .prepare(
        `INSERT OR REPLACE INTO quarter_results
         (user_id, quarter, plan_percent, mark, mark_auto, grade, salary_quarter,
          bonus_percent, bonus_sum, note, closed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(user.id, q, m.avgPercent, b.mark, m.markAuto, user.grade_num, salaryQuarter,
            bonus.percent, bonus.sum, b.note || null, nowIso())
      .run();
    return json({ ok: true, mark: b.mark, markAuto: m.markAuto, planPercent: m.avgPercent, bonus });
  }

  if (path === '/quarter/reopen' && request.method === 'POST') {
    if (!isBoss) return bad('нет доступа', 403);
    const b = await request.json().catch(() => ({}));
    await db
      .prepare('DELETE FROM quarter_results WHERE user_id = ? AND quarter = ?')
      .bind(b.user_id, b.quarter || quarter)
      .run();
    return json({ ok: true });
  }

  // ── Уровень задачи руками ──────────────────────────────────────────────────
  // Модель ошиблась или стикера нет — руководитель правит уровень сам.
  if (path.startsWith('/task/') && path.endsWith('/level') && request.method === 'POST') {
    if (!isBoss) return bad('нет доступа', 403);
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
async function handleYougileHook(request, env, settings) {
  const db = env.DB;
  const secret = env.HOOK_SECRET;
  if (secret && request.headers.get('x-hook-secret') !== secret) return bad('нет доступа', 403);

  const payload = await request.json().catch(() => null);
  if (!payload) return bad('пустое тело');

  const items = Array.isArray(payload) ? payload : [payload];
  for (const ev of items) {
    const task = ev.payload || ev.task || ev;
    const id = task.id || ev.id;
    if (!id) continue;
    await upsertTaskFromYougile(env, task, settings);
  }
  return json({ ok: true, received: items.length });
}

/**
 * Периодическая синхронизация: подстраховка, если вебхук что-то потерял.
 *
 * /task-list отдаёт задачи целиком, поэтому хватает одного обхода с пагинацией.
 * Ключ берётся из секретов; настройка в базе оставлена как запасной путь.
 */
async function syncYougile(env, settings, { limit = 1000 } = {}) {
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
        await upsertTaskFromYougile(env, t, settings);
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
 * Спрашиваем ту же локальную модель. Не ответила или ответила чепухой —
 * возвращаем null: подставлять выдуманный уровень хуже, чем взять размер.
 */
async function guessLevelWithModel(title, settings) {
  if (!title || settings.llm_enabled === '0') return null;
  const url = settings.llm_url || 'http://127.0.0.1:11434/api/generate';
  const model = settings.llm_model || 'qwen3:8b';
  const timeout = num(settings, 'llm_timeout_ms', 45000);

  // Примеры взяты с реальной доски: без них модель почти всё называла
  // «обычным» и простые задачи теряли свой уровень.
  const prompt =
    `Оцени сложность задачи для личного ассистента одной цифрой.\n\n` +
    `1 — простая: одно действие, понятно что делать, результат за час-два. ` +
    `Купить конкретную вещь, оформить подписку или аккаунт, пополнить симкарту, ` +
    `записать к врачу, найти конкретный товар на маркетплейсе, скачать книгу.\n` +
    `2 — обычная: сравнить несколько вариантов или пройти несколько шагов. ` +
    `Подобрать авиабилет, найти квартиру, найти специалиста по отзывам, ` +
    `разобраться в условиях, договориться о встрече.\n` +
    `3 — сложная: исследование или проект на дни, много неизвестных, несколько источников или стран. ` +
    `Изучить рынок, спланировать поездку или переезд, разобраться в законах и визах, настроить мониторинг.\n\n` +
    `Примеры:\n` +
    `«Оформить гемини» — 1\n` +
    `«Купить пероральный амброксол» — 1\n` +
    `«Найти дермапен на mercado livre» — 1\n` +
    `«Подобрать авиабилет Батуми-Алматы на 20.09» — 2\n` +
    `«Найти квартиру для руководителя с женой в КЗ» — 2\n` +
    `«Найти психолога, хорошие отзывы, цена до 2к» — 2\n` +
    `«Рынок аренды автодомов в Бразилии изучить» — 3\n` +
    `«Спланировать суррогатное материнство, выбор гео» — 3\n\n` +
    `Задача: "${String(title).replace(/\s+/g, ' ').slice(0, 200)}"\n` +
    `Ответ — только цифра 1, 2 или 3:`;

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
function addWorkdays(from, days, tzOffset = 3) {
  // Считаем в местном времени: иначе суббота 01:00 по Москве выглядит
  // как пятница по UTC, и выходной день ошибочно засчитывается рабочим.
  const shift = tzOffset * 3600000;
  const d = new Date(new Date(from).getTime() + shift);
  const isWeekend = (x) => x.getUTCDay() === 0 || x.getUTCDay() === 6;

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

// Рабочий день для расчёта сроков: с какого по какой час идут часы.
const WORK_FROM_H = 10;
const WORK_TO_H = 18;
const WORK_DAY_MIN = (WORK_TO_H - WORK_FROM_H) * 60;

const isWeekendLocal = (ms) => {
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
};
/** Границы рабочего окна для дня, в котором лежит момент. */
function dayWindow(ms) {
  const d = new Date(ms);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: base + WORK_FROM_H * 3600000, end: base + WORK_TO_H * 3600000, base };
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
  let cur = new Date(fromIso).getTime() + tz;
  const to = new Date(toIso).getTime() + tz;
  if (!(to > cur)) return 0;

  let minutes = 0;
  let guard = 0;
  while (cur < to && guard++ < 4000) {
    const w = dayWindow(cur);
    if (!isWeekendLocal(cur)) {
      const from = Math.max(cur, w.start);
      const till = Math.min(to, w.end);
      if (till > from) minutes += Math.round((till - from) / 60000);
    }
    cur = w.base + 86400000 + WORK_FROM_H * 3600000; // утро следующего дня
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
  let cur = new Date(fromIso).getTime() + tz;
  let left = Math.max(0, Math.round(minutes));
  let guard = 0;

  while (left > 0 && guard++ < 4000) {
    const w = dayWindow(cur);
    if (isWeekendLocal(cur) || cur >= w.end) {
      cur = w.base + 86400000 + WORK_FROM_H * 3600000;
      continue;
    }
    const from = Math.max(cur, w.start);
    const available = Math.round((w.end - from) / 60000);
    if (available >= left) {
      cur = from + left * 60000;
      left = 0;
    } else {
      left -= available;
      cur = w.base + 86400000 + WORK_FROM_H * 3600000;
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

async function upsertTaskFromYougile(env, t, settings) {
  const db = env.DB;
  const existing = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(t.id).first();
  const now = nowIso();

  const assignee = Array.isArray(t.assigned) ? t.assigned[0] : t.assigned || null;
  const user = assignee
    ? await db.prepare('SELECT id FROM users WHERE yougile_id = ?').bind(assignee).first()
    : null;

  const title = t.title || existing?.title || 'Без названия';
  const createdAt = existing?.created_at
    || (t.timestamp ? new Date(t.timestamp).toISOString() : now);

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
  const tz = num(settings, 'tz_offset', 3);
  const deadline = t.deadline?.deadline
    ? new Date(t.deadline.deadline).toISOString()
    : (priorityDays ? addWorkdays(createdAt, priorityDays, tz) : existing?.deadline || null);

  let status = existing?.status || 'open';
  let taken = existing?.taken_at || null;
  let submitted = existing?.submitted_at || null;
  let done = existing?.done_at || null;
  let returns = existing?.returns || 0;
  let pausedMin = existing?.paused_min || 0;
  let pausedSince = existing?.paused_since || null;
  let workDoneAt = existing?.work_done_at || null;
  let workDoneKind = existing?.work_done_kind || null;

  const stage = stageOfColumn(t.columnId, settings);

  // Выход из паузы — копим её длительность. Считаем в рабочих минутах:
  // календарные дарили бы сутки за каждые выходные, проведённые в блокере.
  if (pausedSince && stage !== 'blocked' && stage !== 'waiting') {
    pausedMin += workMinutesBetween(pausedSince, now, settings);
    pausedSince = null;
  }

  if (stage === 'in_progress') {
    if (status === 'review') returns += 1; // вернулась с проверки — признак «без правок» гаснет
    status = 'in_progress';
    taken = taken || now;
    // Вернулись к работе — значит она не была закончена. Отметка сдачи
    // аннулируется, часы идут дальше: иначе «сдал пустышку» останавливало бы срок.
    workDoneAt = null;
    workDoneKind = null;
  } else if (stage === 'review') {
    status = 'review';
    submitted = submitted || now;
    // сдал на проверку — работа с его стороны закончена
    if (!workDoneAt) { workDoneAt = now; workDoneKind = 'submitted'; }
  } else if (stage === 'accepted') {
    status = 'accepted';
    done = done || now;
    if (!workDoneAt) { workDoneAt = done; workDoneKind = 'accepted'; }
  } else if (stage === 'blocked') {
    // Часы на паузе, но работа не сдана: блокером нельзя остановить срок,
    // ничего не сделав.
    status = 'blocked';
    pausedSince = pausedSince || now;
  } else if (stage === 'waiting') {
    // Работа ассистента закончена, ждём внешний результат. Часы стоят,
    // и задача засчитывается сданной — по этой дате и меряется срок.
    status = 'waiting';
    pausedSince = pausedSince || now;
    if (!workDoneAt) {
      workDoneAt = now;
      workDoneKind = 'handed_off';
    }
  } else if (stage === 'shelved') {
    // Отложена: в зачёт пойдёт только после того, как будет решена.
    status = 'shelved';
  } else if (stage === 'cancelled') {
    status = 'cancelled';
  }

  // YouGile сам отмечает завершённость — это надёжнее, чем угадывать по колонке
  if (t.completed && status !== 'accepted' && status !== 'cancelled') {
    status = 'accepted';
    done = done || now;
  }

  // Задача, закрытая до запуска системы, остаётся исторической навсегда:
  // иначе очередная синхронизация снова проставит ей сегодняшнюю дату
  // закрытия и она вернётся в расчёт.
  if (existing?.status === 'historical' && (status === 'accepted' || stage === null)) {
    status = 'historical';
    done = null;
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
        `UPDATE tasks SET title=?, number=?, board_id=?, column_id=?, keywords=?, assignee_id=?,
         size=?, level=?, level_src=?, priority=?, deadline=?, status=?, taken_at=?,
         submitted_at=?, done_at=?, work_done_at=?, work_done_kind=?, returns=?,
         paused_min=?, paused_since=?, t2s_hours=?, t2f_hours=?,
         period=?, updated_at=? WHERE id=?`
      )
      .bind(title, t.idTaskCommon || existing.number, t.boardId || existing.board_id,
            t.columnId || existing.column_id, keywords,
            user?.id || existing.assignee_id, size, level, levelSrc,
            priorityDays, deadline, status, taken,
            submitted, done, workDoneAt, workDoneKind,
            returns, pausedMin, pausedSince, dur.t2s, dur.t2f, period, now, t.id)
      .run();
  } else {
    // задачу завёл сам исполнитель — это инициатива
    const isInitiative = assignee && t.createdBy && t.createdBy === assignee ? 1 : 0;

    // Задача, которая попала в базу уже закрытой, закрыта до запуска системы.
    // Реальной даты закрытия YouGile не отдаёт, а подставлять сегодняшнюю
    // нечестно: человек получил бы оценку за работу, которой никто не мерил.
    if (status === 'accepted') {
      status = 'historical';
      done = null;
    }
    await db
      .prepare(
        `INSERT INTO tasks (id, title, number, board_id, column_id, keywords, assignee_id,
         author_id, size, level, level_src, priority, created_at, deadline, status,
         taken_at, submitted_at, done_at, work_done_at, work_done_kind, returns,
         paused_min, paused_since, t2s_hours, t2f_hours,
         is_initiative, is_zaeb, period)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(t.id, title, t.idTaskCommon || null, t.boardId || null, t.columnId || null,
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
  if ((wasZaeb || isZaebNow) && status === 'accepted' && !existing?.zaeb_awarded) {
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

  if (stage === 'in_progress' && !existing?.taken_at) await logEvent(db, { taskId: t.id, type: 'taken' });
  if (stage === 'review' && existing?.status !== 'review') await logEvent(db, { taskId: t.id, type: 'submitted' });
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
  const lines = [`<b>Итоги ${period}</b> · квартал ${quarter}`, ''];

  for (const p of people) {
    const month = await monthMetrics(db, p.id, period, settings, sla);
    const q = await quarterMetrics(db, p.id, quarter, settings);

    lines.push(
      `<b>${p.name}</b> — план за месяц <b>${fmtP(month.avgPercent)}</b>, задач ${month.count}`,
      `  до старта:  1 — ${fmtH(month.metrics.t2s1)} (${fmtP(month.percents.t2s1)}) · ` +
        `2 — ${fmtH(month.metrics.t2s2)} (${fmtP(month.percents.t2s2)}) · ` +
        `3 — ${fmtH(month.metrics.t2s3)} (${fmtP(month.percents.t2s3)})`,
      `  до сдачи:   1 — ${fmtH(month.metrics.t2f1)} (${fmtP(month.percents.t2f1)}) · ` +
        `2 — ${fmtH(month.metrics.t2f2)} (${fmtP(month.percents.t2f2)}) · ` +
        `3 — ${fmtH(month.metrics.t2f3)} (${fmtP(month.percents.t2f3)})`,
      `  квартал: план ${fmtP(q.avgPercent)}, система предлагает ${q.markAuto ? MARK_LABEL[q.markAuto] : '—'}`
    );

    // где узкое место: метрика с худшим процентом
    const worst = Object.entries(month.percents)
      .filter(([, v]) => v !== null)
      .sort((a, b) => a[1] - b[1])[0];
    if (worst && worst[1] < 100) {
      const [k, v] = worst;
      const name = k.startsWith('t2s') ? 'до старта' : 'до сдачи';
      lines.push(`  ⚠ слабее всего: ${name}, уровень ${k.slice(3)} — ${v} % плана`);
    }
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
  workMinutesBetween, addWorkMinutes, addWorkdays,
  scoreTask, scoreChat, computeMetrics, computeMoney,
};

// Для служебных скриптов на сервере: полная пересинхронизация без ключа доступа.
export const __ops = { syncYougile, loadSettings, sendMonthlyDigest };
