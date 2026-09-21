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

  const clean = new DatabaseSync(':memory:');
  clean.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

  for (const t of ['users', 'tasks', 'sla', 'bonus_matrix', 'reviews', 'quarter_results']) {
    assert.deepEqual(columnsOf(migrated, t), columnsOf(clean, t), `таблица ${t}`);
  }
  const cnt = (db, sql) => db.prepare(sql).get().n;
  assert.equal(cnt(migrated, 'SELECT count(*) AS n FROM bonus_matrix'), 42);
  assert.equal(cnt(migrated, 'SELECT count(*) AS n FROM sla'), 6);
  assert.equal(cnt(clean, 'SELECT count(*) AS n FROM bonus_matrix'), 42);
  assert.equal(cnt(clean, 'SELECT count(*) AS n FROM sla'), 6);
  assert.equal(
    migrated.prepare("SELECT value FROM settings WHERE key = 'overplan_percent'").get().value, '120'
  );
});

async function freshEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  // модель в тестах не нужна
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm_enabled', '0')").run();

  const add = async (id, name, role, gradeNum, salary) => {
    sqlite
      .prepare(`INSERT INTO users (id, name, role, grade, grade_num, salary, key_hash) VALUES (?,?,?,?,?,?,?)`)
      .run(id, name, role, 'A2', gradeNum, salary, await sha256(`key-${id}`));
  };
  await add('lead', 'Ярослав', 'lead', 3, 0);
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
  task('kate', 2, 4, 28);        // t2s2 = 4, t2f2 = 12 (вторник 14:00: 8 в пн + 4 во вт)
  // Ксюша: уровень 2 — быстро, уровень 3 — одна незакрытая
  task('ksu', 2, 1, 3);          // t2s2 = 1, t2f2 = 3
  task('ksu', 3, 2, null, { status: 'in_progress' });  // t2s3 = 2, t2f3 нет
  task('ksu', 1, 0.5, 1, { is_zaeb: 1 });               // заёб — не считается

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

test('доска: руководитель видит всех, метрики сходятся', async () => {
  const { call } = await freshEnv();
  await call('lead', 'POST', '/kpi/sla', {
    quarter: '2026-Q3',
    values: { t2s1: 2, t2s2: 4, t2s3: 8, t2f1: 4, t2f2: 16, t2f3: 40 },
  });

  const { status, body } = await call('lead', 'GET', '/kpi/board?quarter=2026-Q3');
  assert.equal(status, 200);
  assert.deepEqual(body.months, ['2026-07', '2026-08', '2026-09']);
  assert.equal(body.people.length, 2);

  const kate = body.people.find((p) => p.name === 'Екатерина');
  assert.equal(kate.grade, 3);
  assert.equal(kate.salaryQuarter, 180000);
  const aug = kate.months.find((m) => m.period === '2026-08');
  assert.equal(aug.metrics.t2s1, 1);
  assert.equal(aug.metrics.t2f1, 3);
  assert.equal(aug.metrics.t2s2, 4);
  assert.equal(aug.metrics.t2f2, 12);
  assert.equal(aug.metrics.t2s3, null, 'сложных задач у Кати не было');
  assert.equal(aug.count, 3);
  assert.equal(aug.tasks.length, 3);
  assert.equal(aug.tasks[0].level, 1);

  // проценты: t2s1 план 2 / факт 1 → 200; t2f2 план 16 / факт 12 → 133
  assert.equal(aug.percents.t2s1, 200);
  assert.equal(aug.percents.t2f2, 133);

  // квартал: июль и сентябрь пусты, значит квартал равен августу
  assert.equal(kate.quarter.metrics.t2f2, 12);
  assert.equal(kate.quarter.avgPercent, aug.avgPercent);
  assert.ok(kate.quarter.markAuto, 'система предложила оценку');
  assert.ok(kate.bonus.percent >= 0);

  const ksu = body.people.find((p) => p.name === 'Ксения');
  const kAug = ksu.months.find((m) => m.period === '2026-08');
  assert.equal(kAug.metrics.t2s3, 2, 'взятие в работу засчитано, хотя задача открыта');
  assert.equal(kAug.metrics.t2f3, null, 'незакрытая задача не портит завершение');
  assert.equal(kAug.count, 2, 'заёб в отчёт не попал');

  // срез отдела: уровень 2 по всем — Катя 4 ч и Ксюша 1 ч → 2.5
  const teamAug = body.team.months.find((m) => m.period === '2026-08');
  assert.equal(teamAug.metrics.t2s2, 2.5);
  assert.equal(teamAug.metrics.t2f2, 7.5);
});

test('ассистент видит только себя и срез отдела', async () => {
  const { call } = await freshEnv();
  const { body } = await call('kate', 'GET', '/kpi/board?quarter=2026-Q3');
  assert.equal(body.people.length, 1);
  assert.equal(body.people[0].name, 'Екатерина');
  assert.ok(body.team.months.length === 3, 'срез отдела доступен');
});

test('нормы нельзя менять ассистенту, и они действуют с нужного квартала', async () => {
  const { call } = await freshEnv();
  const denied = await call('kate', 'POST', '/kpi/sla', { quarter: '2026-Q3', values: { t2s1: 1 } });
  assert.equal(denied.status, 403);

  await call('lead', 'POST', '/kpi/sla', { quarter: '2026-Q3', values: { t2s1: 2 } });
  await call('lead', 'POST', '/kpi/sla', { quarter: '2026-Q4', values: { t2s1: 1 } });

  const q3 = await call('lead', 'GET', '/kpi/sla?quarter=2026-Q3');
  const q4 = await call('lead', 'GET', '/kpi/sla?quarter=2026-Q4');
  assert.equal(q3.body.current.t2s1, 2, 'третий квартал считается по старой норме');
  assert.equal(q4.body.current.t2s1, 1, 'четвёртый — по новой');
});

test('отзывы: кто о ком может писать', async () => {
  const { call } = await freshEnv();
  const q = '2026-Q3';

  const self = await call('kate', 'POST', '/kpi/reviews', { kind: 'self', quarter: q, text: 'Старалась', mark: 'plus' });
  assert.equal(self.status, 200);

  const selfOther = await call('kate', 'POST', '/kpi/reviews', { kind: 'self', quarter: q, user_id: 'ksu', text: 'x' });
  assert.equal(selfOther.status, 403, 'самооценку о другом писать нельзя');

  const peer = await call('ksu', 'POST', '/kpi/reviews', { kind: 'peer', quarter: q, user_id: 'kate', text: 'Помогала' });
  assert.equal(peer.status, 200);

  const peerSelf = await call('kate', 'POST', '/kpi/reviews', { kind: 'peer', quarter: q, user_id: 'kate', text: 'x' });
  assert.equal(peerSelf.status, 403, 'отзыв коллеги о себе — нет');

  const leadByAssistant = await call('kate', 'POST', '/kpi/reviews', { kind: 'lead', quarter: q, user_id: 'ksu', text: 'x' });
  assert.equal(leadByAssistant.status, 403);

  const lead = await call('lead', 'POST', '/kpi/reviews', { kind: 'lead', quarter: q, user_id: 'kate', text: 'Растёт', mark: 'plus2' });
  assert.equal(lead.status, 200);

  // повторная отправка обновляет, а не плодит
  const again = await call('kate', 'POST', '/kpi/reviews', { kind: 'self', quarter: q, text: 'Очень старалась', mark: 'plus2' });
  assert.equal(again.body.updated, true);

  const { body } = await call('lead', 'GET', `/kpi/board?quarter=${q}`);
  const kate = body.people.find((p) => p.name === 'Екатерина');
  assert.equal(kate.reviews.length, 3);
  assert.deepEqual(kate.reviews.map((r) => r.kind).sort(), ['lead', 'peer', 'self']);
  assert.equal(kate.reviews.find((r) => r.kind === 'self').text, 'Очень старалась');

  // Ксюша чужие отзывы читать не может: только факт их наличия
  const ksuView = await call('ksu', 'GET', `/kpi/board?quarter=${q}`);
  assert.equal(ksuView.body.people.length, 1, 'в списке только она сама');
});

test('закрытие квартала: премия по матрице от квартальной зарплаты', async () => {
  const { call } = await freshEnv();
  const q = '2026-Q3';
  await call('lead', 'POST', '/kpi/sla', {
    quarter: q, values: { t2s1: 2, t2s2: 4, t2s3: 8, t2f1: 4, t2f2: 16, t2f3: 40 },
  });

  const denied = await call('kate', 'POST', '/kpi/quarter/close', { user_id: 'kate', quarter: q, mark: 'plus4' });
  assert.equal(denied.status, 403);

  // Ксюша: грейд 5, оклад 80 000 → квартал 240 000; «+++» у грейда 5 = 20 %
  const closed = await call('lead', 'POST', '/kpi/quarter/close', { user_id: 'ksu', quarter: q, mark: 'plus3', note: 'молодец' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.bonus.percent, 20);
  assert.equal(closed.body.bonus.sum, 48000);

  const { body } = await call('lead', 'GET', `/kpi/board?quarter=${q}`);
  const ksu = body.people.find((p) => p.name === 'Ксения');
  assert.equal(ksu.result.mark, 'plus3');
  assert.equal(ksu.result.bonus_sum, 48000);
  assert.equal(ksu.mark, 'plus3', 'после закрытия доска показывает итоговую оценку');
  assert.ok(ksu.result.closed_at);

  // грейд 2 премии не даёт вовсе
  await call('lead', 'POST', '/admin/users', { id: 'kate', name: 'Екатерина', role: 'assistant', grade_num: 2, salary: 60000 });
  const kate = await call('lead', 'POST', '/kpi/quarter/close', { user_id: 'kate', quarter: q, mark: 'plus4' });
  assert.equal(kate.body.bonus.percent, 0);
  assert.equal(kate.body.bonus.sum, 0);

  // переоткрыть — итог исчезает
  await call('lead', 'POST', '/kpi/quarter/reopen', { user_id: 'ksu', quarter: q });
  const after = await call('lead', 'GET', `/kpi/board?quarter=${q}`);
  assert.equal(after.body.people.find((p) => p.name === 'Ксения').result, null);
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

  const { body } = await call('lead', 'GET', '/kpi/board?quarter=2026-Q3');
  const kate = body.people.find((p) => p.name === 'Екатерина');
  const aug = kate.months.find((m) => m.period === '2026-08');
  assert.equal(aug.metrics.t2s3, 1, 'задача ушла на третий уровень');
  assert.equal(aug.metrics.t2s1, 1, 'на первом осталась одна');
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
    assert.match(text, /Екатерина/);
    assert.match(text, /до старта:/);
    assert.match(text, /до сдачи:/);
    assert.match(text, /квартал: план/);
    assert.match(text, /вкладка «KPI»/);
    assert.equal(sent[0].chat_id, '292525734');
  } finally {
    globalThis.fetch = realFetch;
  }
});
