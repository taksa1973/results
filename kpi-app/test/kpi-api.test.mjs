// Проверка API модели времени на живой базе.
//
// База поднимается в памяти на встроенном node:sqlite по schema.sql.
// Отдельная проверка гоняет миграцию 003 на схеме из git — так, как она
// пойдёт на боевую базу. Обёртка повторяет интерфейс D1, как в server.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Statement(this.db, this.sql, args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)));
  }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true }; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}
class D1Like {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
}

const sha256 = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Описание таблицы: имена и типы колонок, без порядка. */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .map((c) => `${c.name}:${c.type}`).sort();
}

test('миграция 003 приводит старую базу к новой схеме', () => {
  // Схема до модели времени — из последнего коммита перед миграцией.
  // Именно такая база стояла на сервере, когда миграцию применяли.
  let oldSchema;
  try {
    oldSchema = execSync('git show a82d706:kpi-app/schema.sql', { cwd: root, encoding: 'utf8' });
  } catch {
    return; // без git сравнивать не с чем
  }
  const migrated = new DatabaseSync(':memory:');
  migrated.exec(oldSchema);
  migrated.exec(fs.readFileSync(path.join(root, 'migrations', '003_time_kpi.sql'), 'utf8'));
  migrated.exec(fs.readFileSync(path.join(root, 'migrations', '004_month_scores.sql'), 'utf8'));
  migrated.exec(fs.readFileSync(path.join(root, 'migrations', '005_task_links.sql'), 'utf8'));

  const clean = new DatabaseSync(':memory:');
  clean.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

  migrated.exec(fs.readFileSync(path.join(root, 'migrations', '006_acked.sql'), 'utf8'));
  migrated.exec(fs.readFileSync(path.join(root, 'migrations', '007_review.sql'), 'utf8'));
  for (const t of ['users', 'tasks', 'sla', 'bonus_matrix', 'reviews', 'quarter_results', 'month_scores']) {
    assert.deepEqual(columnsOf(migrated, t), columnsOf(clean, t), `таблица ${t}`);
  }
  const cnt = (db, sql) => db.prepare(sql).get().n;
  assert.equal(cnt(migrated, 'SELECT count(*) AS n FROM bonus_matrix'), 42);
  assert.equal(cnt(migrated, 'SELECT count(*) AS n FROM sla'), 5, 'принятие, старт и три уровня работы');
  assert.equal(cnt(clean, 'SELECT count(*) AS n FROM bonus_matrix'), 42);
  assert.equal(cnt(clean, 'SELECT count(*) AS n FROM sla'), 5);
  assert.deepEqual(
    migrated.prepare('SELECT metric, level, hours FROM sla ORDER BY metric, level').all(),
    clean.prepare('SELECT metric, level, hours FROM sla ORDER BY metric, level').all()
  );
  assert.equal(
    migrated.prepare("SELECT value FROM settings WHERE key = 'overplan_percent'").get().value, '120'
  );
  assert.equal(
    migrated.prepare("SELECT value FROM settings WHERE key = 'lead_kpi_max'").get().value, '50000'
  );
});

async function freshEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  // модель в тестах не нужна
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm_enabled', '0')").run();
  // ожидания ниже считались для окна 10–18
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('task_day_start', '10:00')").run();
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('task_day_end', '18:00')").run();

  const add = async (id, name, role, gradeNum, salary) => {
    sqlite
      .prepare(`INSERT INTO users (id, name, role, grade, grade_num, salary, key_hash) VALUES (?,?,?,?,?,?,?)`)
      .run(id, name, role, 'A2', gradeNum, salary, await sha256(`key-${id}`));
  };
  await add('lead', 'Ярослав', 'lead', 4, 100000);
  await add('chief', 'Алекс', 'chief', 3, 0);
  await add('kate', 'Екатерина', 'assistant', 3, 60000);
  await add('ksu', 'Ксения', 'assistant', 5, 80000);

  // Задачи августа 2026. Понедельник 10.08 10:00 МСК = 07:00Z.
  const base = Date.parse('2026-08-10T07:00:00Z');
  const at = (h) => new Date(base + h * 3600e3).toISOString();
  let n = 0;
  const task = (who, level, t2sH, t2fH, extra = {}) => {
    n += 1;
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, number, assignee_id, size, level, level_src, created_at,
         taken_at, done_at, status, is_zaeb, period)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(`t${n}`, extra.title || `Задача ${n}`, `ID-${n}`, who, level === 3 ? 3 : level, level,
           'sticker', at(0), t2sH === null ? null : at(t2sH), t2fH === null ? null : at(t2fH),
           extra.status || 'accepted', extra.is_zaeb || 0, '2026-08');
  };
  // Катя: уровень 1 — быстро, уровень 2 — медленно
  task('kate', 1, 1, 2);
  task('kate', 1, 1, 4);         // t2s1 = 1, t2f1 = 3
  task('kate', 2, 4, 28);        // t2s2 = 4, t2f2 = 8 (в работе с пн 14:00 до вт 14:00)
  // Ксюша: уровень 2 — быстро, уровень 3 — одна незакрытая
  task('ksu', 2, 1, 3);          // t2s2 = 1, t2f2 = 2
  task('ksu', 3, 2, null, { status: 'in_progress' });  // t2s3 = 2, t2f3 нет
  task('ksu', 1, 0.5, 1, { is_zaeb: 1 });               // заёб — не считается
  // руководитель сам закрыл две простых задачи ровно в план
  task('lead', 1, 2, 4);
  task('lead', 1, 2, 4);

  const env = { DB: new D1Like(sqlite), TG_SECRET: 'x', HOOK_SECRET: 'x' };
  const call = async (who, method, p, body) => {
    const req = new Request(`http://kpi.local/api${p}`, {
      method,
      headers: { 'x-access-key': `key-${who}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await worker.fetch(req, env);
    return { status: res.status, body: await res.json() };
  };
  return { sqlite, env, call };
}

test('KPI руководителя за месяц: среднее оценок отдела вместе с ним', async () => {
  const { call } = await freshEnv();
  await call('lead', 'POST', '/kpi/sla', {
    quarter: '2026-Q3',
    values: { t2a: 1, t2s: 4, t2f1: 4, t2f2: 16, t2f3: 40 },
  });

  const { status, body } = await call('chief', 'GET', '/kpi/board?period=2026-08');
  assert.equal(status, 200);
  assert.equal(body.period, '2026-08');
  assert.equal(body.quarter, '2026-Q3');
  assert.equal(body.lead.max, 50000);

  // руководитель: две задачи ровно в план → 100 % → 10
  assert.equal(body.lead.own.auto, 10);
  assert.equal(body.lead.own.score, 10);

  // Катя: t2s1 200, t2f1 133, t2s2 100, t2f2 133 → 141 % → кап 10
  const kate = body.people.find((p) => p.name === 'Екатерина');
  assert.equal(kate.auto, 10);
  assert.equal(kate.manual, null);
  // Ксюша: t2s2 400, t2f2 533→200 кап, t2s3 400→200 → 200 → 10
  const ksu = body.people.find((p) => p.name === 'Ксения');
  assert.equal(ksu.auto, 10);

  assert.equal(body.lead.score, 10);
  assert.equal(body.lead.bonus, 50000, 'все на десять — максимум');
  assert.equal(body.lead.counted, 3);

  // принято / взято / сдано за месяц — прямо в строке
  assert.equal(kate.acked, 3, 'сразу в работу — принята в момент взятия');
  assert.equal(kate.taken, 3);
  assert.equal(kate.done, 3);
  assert.equal(body.lead.own.taken, 2);
  assert.equal(ksu.taken, 2, 'взяла две, одна ещё в работе');
  assert.equal(ksu.done, 1);

  // срезы для графиков остались
  assert.ok(Array.isArray(kate.months) && kate.months.length === 3);
  assert.ok(Array.isArray(body.lead.months) && body.lead.months.length === 3);
});

test('оценка руками перебивает автоматическую: он на 10, сотрудник на 5 — семь с половиной', async () => {
  const { call } = await freshEnv();
  // оставляем в отделе одну Катю: Ксюшу выключаем
  await call('chief', 'POST', '/admin/users', { id: 'ksu', name: 'Ксения', role: 'assistant', salary: 80000, active: false });

  const denied = await call('kate', 'POST', '/kpi/score', { user_id: 'kate', period: '2026-08', manual: 10 });
  assert.equal(denied.status, 403, 'себе оценку ассистент не ставит');

  const r = await call('lead', 'POST', '/kpi/score', { user_id: 'kate', period: '2026-08', manual: 5, note: 'много переделок' });
  assert.equal(r.status, 200);
  assert.equal(r.body.leadScore, 7.5, '(10 + 5) / 2');
  assert.equal(r.body.leadBonus, 37500, '50 000 × 7,5 / 10');

  const { body } = await call('lead', 'GET', '/kpi/board?period=2026-08');
  const kate = body.people.find((p) => p.name === 'Екатерина');
  assert.equal(kate.manual, 5);
  assert.equal(kate.auto, 10, 'автоматическая видна рядом');
  assert.equal(kate.score, 5);
  assert.equal(kate.note, 'много переделок');
  assert.equal(body.lead.score, 7.5);
  assert.equal(body.lead.bonus, 37500);

  // Катя на 6 — как в реальной оценке
  await call('lead', 'POST', '/kpi/score', { user_id: 'kate', period: '2026-08', manual: 6 });
  const b2 = await call('lead', 'GET', '/kpi/board?period=2026-08');
  assert.equal(b2.body.lead.score, 8);
  assert.equal(b2.body.lead.bonus, 40000);

  // снять ручную — снова автоматическая
  await call('lead', 'POST', '/kpi/score', { user_id: 'kate', period: '2026-08', manual: null });
  const b3 = await call('lead', 'GET', '/kpi/board?period=2026-08');
  assert.equal(b3.body.people.find((p) => p.name === 'Екатерина').score, 10);
});

test('оценку руководителю ставит только владелец', async () => {
  const { call } = await freshEnv();
  const byLead = await call('lead', 'POST', '/kpi/score', { user_id: 'lead', period: '2026-08', manual: 10 });
  assert.equal(byLead.status, 403);

  const byChief = await call('chief', 'POST', '/kpi/score', { user_id: 'lead', period: '2026-08', manual: 7, note: 'сроки плыли' });
  assert.equal(byChief.status, 200);
  const { body } = await call('chief', 'GET', '/kpi/board?period=2026-08');
  assert.equal(body.lead.own.manual, 7);
  assert.equal(body.lead.own.score, 7);
  assert.equal(body.lead.score, 9, '(7 + 10 + 10) / 3');
  assert.equal(body.lead.bonus, 45000);

  const bad = await call('chief', 'POST', '/kpi/score', { user_id: 'lead', period: '2026-08', manual: 11 });
  assert.equal(bad.status, 400);
});

test('месяц без задач и без ручной оценки в среднее не входит', async () => {
  const { call } = await freshEnv();
  const { body } = await call('chief', 'GET', '/kpi/board?period=2026-07');
  assert.equal(body.lead.own.auto, null);
  assert.equal(body.lead.score, null);
  assert.equal(body.lead.bonus, 0);
  assert.equal(body.lead.counted, 0);

  await call('chief', 'POST', '/kpi/score', { user_id: 'lead', period: '2026-07', manual: 8 });
  const b2 = await call('chief', 'GET', '/kpi/board?period=2026-07');
  assert.equal(b2.body.lead.score, 8, 'только одна оценка — она и среднее');
  assert.equal(b2.body.lead.counted, 1);
});

test('ассистенту доска закрыта, отзыв о руководителе — открыт', async () => {
  const { call } = await freshEnv();
  const denied = await call('kate', 'GET', '/kpi/board?period=2026-08');
  assert.equal(denied.status, 403);

  const mine = await call('kate', 'GET', '/kpi/my-review?quarter=2026-Q3');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.lead.name, 'Ярослав');
  assert.equal(mine.body.review, null);

  const sent = await call('kate', 'POST', '/kpi/reviews', { quarter: '2026-Q3', text: 'Всегда на связи', mark: 'plus2' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.kind, 'peer', 'вид отзыва следует из роли');

  const again = await call('kate', 'GET', '/kpi/my-review?quarter=2026-Q3');
  assert.equal(again.body.review.text, 'Всегда на связи');
});

test('нормы нельзя менять ассистенту, и они действуют с нужного квартала', async () => {
  const { call } = await freshEnv();
  const denied = await call('kate', 'POST', '/kpi/sla', { quarter: '2026-Q3', values: { t2s: 1 } });
  assert.equal(denied.status, 403);

  await call('lead', 'POST', '/kpi/sla', { quarter: '2026-Q3', values: { t2s: 2 } });
  await call('lead', 'POST', '/kpi/sla', { quarter: '2026-Q4', values: { t2s: 1, t2f2: 20 } });

  const q3 = await call('lead', 'GET', '/kpi/sla?quarter=2026-Q3');
  const q4 = await call('lead', 'GET', '/kpi/sla?quarter=2026-Q4');
  assert.equal(q3.body.current.t2s, 2, 'третий квартал считается по старой норме');
  assert.equal(q4.body.current.t2s, 1, 'четвёртый — по новой');
  assert.equal(q4.body.current.t2f2, 20, 'уровневая норма — со своим ключом');
  assert.equal(q4.body.current.t2a, 1, 'стартовая норма принятия на месте');
});

test('отзывы о руководителе: три источника, вид по роли', async () => {
  const { call } = await freshEnv();
  const q = '2026-Q3';

  const self = await call('lead', 'POST', '/kpi/reviews', { quarter: q, text: 'Квартал тяжёлый, но вытянули', mark: 'plus' });
  assert.equal(self.body.kind, 'self');
  const peer = await call('ksu', 'POST', '/kpi/reviews', { quarter: q, text: 'Помогает, когда горит' });
  assert.equal(peer.body.kind, 'peer');
  const chief = await call('chief', 'POST', '/kpi/reviews', { quarter: q, text: 'Отдел стал быстрее', mark: 'plus2' });
  assert.equal(chief.body.kind, 'chief');

  // повторная отправка обновляет, а не плодит
  const again = await call('lead', 'POST', '/kpi/reviews', { quarter: q, text: 'Дополнил', mark: 'plus2' });
  assert.equal(again.body.updated, true);

  const { body } = await call('chief', 'GET', `/kpi/board?period=2026-08`);
  assert.equal(body.lead.reviews.length, 3);
  assert.deepEqual(body.lead.reviews.map((r) => r.kind).sort(), ['chief', 'peer', 'self']);
  assert.equal(body.lead.reviews.find((r) => r.kind === 'self').text, 'Дополнил');

  // чужой отзыв удаляет только владелец
  const peerId = body.lead.reviews.find((r) => r.kind === 'peer').id;
  const denied = await call('lead', 'DELETE', `/kpi/reviews/${peerId}`);
  assert.equal(denied.status, 403);
  const ok = await call('chief', 'DELETE', `/kpi/reviews/${peerId}`);
  assert.equal(ok.status, 200);
});

test('квартал закрывает владелец — аттестация без денег', async () => {
  const { call } = await freshEnv();
  const q = '2026-Q3';
  const byLead = await call('lead', 'POST', '/kpi/quarter/close', { quarter: q, mark: 'plus4' });
  assert.equal(byLead.status, 403, 'сам себе квартал не закрывает');

  const closed = await call('chief', 'POST', '/kpi/quarter/close', { quarter: q, mark: 'plus3', note: 'хороший квартал' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.bonus, undefined, 'денег за квартал нет — премия месячная');

  const { body } = await call('lead', 'GET', `/kpi/board?period=2026-08`);
  assert.equal(body.lead.result.mark, 'plus3');
  assert.equal(body.lead.result.bonus_sum, null);
  assert.ok(body.lead.result.closed_at);

  await call('chief', 'POST', '/kpi/quarter/reopen', { quarter: q });
  const after = await call('chief', 'GET', `/kpi/board?period=2026-08`);
  assert.equal(after.body.lead.result, null);
});

test('матрицу можно актуализировать по грейду', async () => {
  const { call } = await freshEnv();
  const before = await call('lead', 'GET', '/kpi/matrix');
  assert.equal(before.body.matrix[7].plus4, 36, 'стартовые значения из миграции');
  assert.equal(before.body.matrix[3].plus, 10);

  const bad = await call('lead', 'POST', '/kpi/matrix', { grade: 9, cells: { plus: 1 } });
  assert.equal(bad.status, 400);

  await call('lead', 'POST', '/kpi/matrix', { grade: 3, cells: { plus: 11, plus4: 22 } });
  const after = await call('lead', 'GET', '/kpi/matrix');
  assert.equal(after.body.matrix[3].plus, 11);
  assert.equal(after.body.matrix[3].plus4, 22);
  assert.equal(after.body.matrix[3].plus2, 12, 'нетронутые ячейки остались');
});

test('уровень задачи можно поправить руками', async () => {
  const { call, sqlite } = await freshEnv();
  const denied = await call('kate', 'POST', '/kpi/task/t1/level', { level: 3 });
  assert.equal(denied.status, 403);

  const ok = await call('lead', 'POST', '/kpi/task/t1/level', { level: 3 });
  assert.equal(ok.status, 200);
  const row = sqlite.prepare('SELECT level, level_src FROM tasks WHERE id = ?').get('t1');
  assert.equal(row.level, 3);
  assert.equal(row.level_src, 'manual');

  const { body } = await call('lead', 'GET', '/kpi/board?period=2026-08');
  const kate = body.people.find((p) => p.name === 'Екатерина');
  const aug = kate.months.find((m) => m.period === '2026-08');
  assert.equal(aug.metrics.t2f3, 1, 'задача ушла на третий уровень: час в работе');
  assert.equal(aug.metrics.t2f1, 3, 'на первом осталась одна: три часа');
});

test('ассистенту сверх оклада — только заёбы и экономия', async () => {
  const { call } = await freshEnv();
  const { status, body } = await call('kate', 'GET', '/me?period=2026-08');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.money).sort(), ['salary', 'savingPay', 'savingSum', 'total', 'zaeb']);
  assert.equal(body.money.total, body.money.zaeb + body.money.savingPay);
  assert.equal(body.help, undefined, 'коэффициента помощи больше нет');

  const team = await call('chief', 'GET', '/team?period=2026-08');
  assert.equal(team.status, 200);
  assert.equal(team.body.people.length, 2);
  assert.equal(team.body.people[0].kef, undefined, 'кэфов нет');
  assert.equal(team.body.lead.name, 'Ярослав');
  assert.ok('shareZaeb' in team.body.lead && 'shareSaving' in team.body.lead);
});

test('месячная сводка в личку строится по модели времени', async () => {
  const { env, sqlite } = await freshEnv();
  sqlite.prepare("UPDATE users SET tg_user_id = '292525734' WHERE id = 'lead'").run();
  env.TG_TOKEN = 'test';

  // перехватываем отправку в Telegram
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const { __ops } = await import('../src/worker.js');
    const settings = await __ops.loadSettings(env.DB);
    // сводка берёт текущий месяц; подменяем часы так, чтобы «сейчас» был август 2026
    const RealDate = Date;
    const fixed = RealDate.parse('2026-08-31T15:00:00Z');
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fixed])); }
      static now() { return fixed; }
    };
    let r;
    try { r = await __ops.sendMonthlyDigest(env, settings); }
    finally { globalThis.Date = RealDate; }

    assert.equal(r.ok, true);
    assert.equal(r.period, '2026-08');
    assert.equal(sent.length, 1, 'одно сообщение');
    const text = sent[0].text;
    assert.match(text, /Итоги 2026-08/);
    assert.match(text, /KPI руководителя/);
    assert.match(text, /из 50.000/);
    assert.match(text, /Отдел/);
    assert.match(text, /Екатерина/);
    assert.match(text, /до принятия:/);
    assert.match(text, /в работе:/);
    assert.match(text, /квартал: план/);
    assert.match(text, /вкладка «KPI»/);
    assert.equal(sent[0].chat_id, '292525734');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('вебхук YouGile принимается с секретом в пути и отвечает сразу', async () => {
  const { call, env, sqlite } = await freshEnv();
  env.HOOK_SECRET = 'hooksecret';
  const send = async (p, body) => worker.fetch(new Request(`http://kpi.local/api${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env);

  const wrong = await send('/yougile/nope', { id: 'x' });
  assert.equal(wrong.status, 403);

  const t = { id: 'hook-1', title: 'Заказать такси', idTaskCommon: 'ID-900', idTaskProject: 'VSE-777',
    columnId: 'c-open', timestamp: Date.parse('2026-08-10T07:00:00Z'), assigned: [] };
  const ok = await send('/yougile/hooksecret', { event: 'task-created', payload: t });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).received, 1);
  // разбор идёт после ответа — даём ему завершиться
  await new Promise((r) => setTimeout(r, 50));
  const row = sqlite.prepare('SELECT number, project_no, url FROM tasks WHERE id = ?').get('hook-1');
  assert.equal(row.number, 'ID-900');
  assert.equal(row.project_no, 'VSE-777');
  assert.equal(row.url, 'https://ru.yougile.com/team/ed881f3af637/#VSE-777', 'ссылка по проектному номеру');
});

test('таймер стоит на проверке и идёт снова после возврата в работу', async () => {
  const { env, sqlite } = await freshEnv();
  env.HOOK_SECRET = 'hooksecret';
  // колонки из настроек тестовой базы
  const col = (key) => sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key).value.split(',')[0];
  const send = (t) => worker.fetch(new Request('http://kpi.local/api/hook/yougile', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hook-secret': 'hooksecret' },
    body: JSON.stringify({ payload: t }),
  }), env);

  const RealDate = Date;
  const at = async (iso, columnKey, extra = {}) => {
    const fixed = RealDate.parse(iso);
    globalThis.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [fixed])); }
      static now() { return fixed; }
    };
    try {
      await send({ id: 'pause-1', title: 'Задача с паузой', idTaskCommon: 'ID-1', columnId: col(columnKey),
        timestamp: RealDate.parse('2026-08-10T07:00:00Z'), assigned: ['yg-lead'], ...extra });
      await new Promise((r) => setTimeout(r, 30));
    } finally { globalThis.Date = RealDate; }
  };
  sqlite.prepare("UPDATE users SET yougile_id = 'yg-lead' WHERE id = 'lead'").run();

  await at('2026-08-10T07:00:00Z', 'column_backlog');        // пн 10:00 поставлена
  await at('2026-08-10T08:00:00Z', 'column_in_progress');    // 11:00 взята
  await at('2026-08-10T10:00:00Z', 'column_review');         // 13:00 сдана на проверку — таймер стоит
  await at('2026-08-11T09:00:00Z', 'column_in_progress');    // вт 12:00 вернули в работу (на проверке 5+2=7 ч)
  await at('2026-08-11T11:00:00Z', 'column_review');         // вт 14:00 сдана снова

  const get = () => sqlite.prepare('SELECT taken_at, work_done_at, paused_min, paused_since, returns, t2a_hours, t2s_hours, t2f_hours FROM tasks WHERE id = ?').get('pause-1');
  let row = get();
  assert.equal(row.paused_min, 7 * 60, 'семь часов на проверке — не в счёт');
  assert.equal(row.returns, 1);
  assert.equal(row.t2a_hours, 1, 'сразу в работу: час ожидания — в «до принятия»');
  assert.equal(row.t2s_hours, 0);
  // в работе: 11:00–13:00 в пн (2 ч) и 12:00–14:00 во вт (2 ч) = 4 ч
  assert.equal(row.t2f_hours, 4, 'считается только время в «В работе»');
  assert.ok(row.paused_since, 'сейчас снова на проверке — таймер стоит');

  // второй возврат: на проверке вт 14:00 → ср 10:00 (4 ч), в работе ещё час
  await at('2026-08-12T07:00:00Z', 'column_in_progress');    // ср 10:00 вернули снова
  await at('2026-08-12T08:00:00Z', 'column_review');         // ср 11:00 сдана в третий раз
  row = get();
  assert.equal(row.returns, 2, 'оба возврата посчитаны');
  assert.equal(row.paused_min, 11 * 60, 'паузы складываются: 7 + 4');
  assert.equal(row.t2f_hours, 5, 'таймер продолжил с четырёх часов и дошёл до пяти');

  // приняли — время на последней проверке к работе не относится
  await at('2026-08-13T07:00:00Z', 'column_done', { completed: true, completedTimestamp: RealDate.parse('2026-08-13T07:00:00Z') });
  row = get();
  assert.equal(row.t2f_hours, 5, 'приёмка ничего не добавила');
  assert.equal(row.paused_since, null);
});
