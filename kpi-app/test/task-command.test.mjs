// Постановка задачи из Telegram: /task @ник срочность Название.
//
// YouGile и Telegram подменены: проверяем, что уходит в трекер и что
// возвращается в чат, не трогая ни того, ни другого.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker, { __test } from '../src/worker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseTaskCommand } = __test;

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

test('разбор команды: ник, срочность, название, описание', () => {
  assert.deepEqual(parseTaskCommand('/task @xenyav 3 тестовая задача'), {
    nick: 'xenyav', priority: 3, title: 'тестовая задача', description: '',
  });
  // адресовано боту явно, ник без @, срочность не указана
  assert.deepEqual(parseTaskCommand('/task@Hotassist_bot xenyav Купить билет'), {
    nick: 'xenyav', priority: null, title: 'Купить билет', description: '',
  });
  // задача уходит в название целиком, переносы строк — пробелами
  assert.deepEqual(parseTaskCommand('/task @Xenyav 7 Заказать ракетку\nМодель Head Speed, ручка 3'), {
    nick: 'xenyav', priority: 7, title: 'Заказать ракетку Модель Head Speed, ручка 3', description: '',
  });
  // старое разнесение остаётся за настройкой task_full_title = 0
  assert.deepEqual(parseTaskCommand('/task @Xenyav 7 Заказать ракетку\nМодель Head Speed, ручка 3', { fullTitle: false }), {
    nick: 'xenyav', priority: 7, title: 'Заказать ракетку', description: 'Модель Head Speed, ручка 3',
  });
  assert.deepEqual(parseTaskCommand('/task'), { error: 'empty' });
  assert.deepEqual(parseTaskCommand('/task @xenyav 3'), { error: 'title' });
  assert.equal(parseTaskCommand('/tasks что-то'), null);
  assert.equal(parseTaskCommand('просто текст'), null);
});

async function freshEnv() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
  const set = (k, v) => sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  set('tg_chat_id', '-100500');
  set('yougile_key', 'yg-test');

  const add = (id, name, role, nick, tgId, ygId) => sqlite
    .prepare('INSERT INTO users (id, name, role, grade, key_hash, tg_username, tg_user_id, yougile_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, role, 'A2', `hash-${id}`, nick, tgId, ygId);
  add('lead', 'Ярослав', 'lead', 'yaroslav', '1', 'yg-lead');
  add('ksu', 'Kseniia', 'assistant', 'xenyav', '2', 'yg-ksu');
  add('kate', 'Екатерина', 'assistant', 'katya', '3', null);

  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const u = String(url);
    if (u.endsWith('/api-v2/tasks') && init.method === 'POST') {
      return new Response(JSON.stringify({ id: 'task-1' }), { status: 201 });
    }
    if (u.endsWith('/api-v2/tasks/task-1')) {
      return new Response(JSON.stringify({ id: 'task-1', idTaskProject: 'VSE-999' }), { status: 200 });
    }
    if (u.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response('{}', { status: 404 });
  };

  const env = { DB: new D1Like(sqlite), TG_SECRET: 'x', TG_TOKEN: 'tg-test' };
  const send = async (update) => {
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const res = await worker.fetch(new Request('http://kpi.local/api/tg/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      }), env);
      return { status: res.status, body: await res.json() };
    } finally {
      globalThis.fetch = orig;
    }
  };
  const msg = (fromId, text, extra = {}) => ({
    message: {
      message_id: 42, date: 1_790_000_000, text,
      chat: { id: -100500, type: 'supergroup' },
      from: { id: Number(fromId), is_bot: false, username: fromId === '1' ? 'yaroslav' : 'someone' },
      ...extra,
    },
  });
  return { sqlite, env, calls, send, msg };
}

test('руководитель ставит задачу в чате: колонка «Добавлена», исполнитель, стикер', async () => {
  const { calls, send, msg, sqlite } = await freshEnv();
  const { status, body } = await send(msg('1', '/task @xenyav 3 тестовая задача'));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.task, 'task-1');

  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks'));
  assert.ok(create, 'задача ушла в YouGile');
  assert.deepEqual(create.body, {
    title: 'тестовая задача',
    columnId: '3b698e71-7a66-4806-a376-92c9890d5d9b',
    assigned: ['yg-ksu'],
    stickers: { '0681807e-900b-47b6-8880-624802294bb0': 'e0051cdabb08' },
  });

  const reply = calls.find((c) => c.url.includes('sendMessage'));
  assert.ok(reply, 'подтверждение ушло в чат');
  assert.equal(reply.body.chat_id, -100500);
  assert.equal(reply.body.reply_to_message_id, 42);
  assert.match(reply.body.text, /VSE-999/);
  assert.match(reply.body.text, /Kseniia/);
  assert.match(reply.body.text, /Срочность 3/);
  assert.equal(reply.body.reply_markup.inline_keyboard[0][0].url, 'https://ru.yougile.com/team/ed881f3af637/#VSE-999');

  // вопрос руководителя не открывался — это команда, а не запрос
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM chat_replies').get().n, 0);
});

test('без срочности ставится 3 по умолчанию, задача уходит в название целиком', async () => {
  const { calls, send, msg } = await freshEnv();
  const { body } = await send(msg('1', '/task xenyav Заказать ракетку\nHead Speed, ручка 3'));
  assert.equal(body.ok, true);
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks'));
  assert.equal(create.body.title, 'Заказать ракетку Head Speed, ручка 3', 'перенос строки стал пробелом');
  assert.equal(create.body.description, undefined, 'описание не заполняем — вся задача в названии');
  assert.deepEqual(create.body.stickers, { '0681807e-900b-47b6-8880-624802294bb0': 'e0051cdabb08' });
  assert.match(calls.find((c) => c.url.includes('sendMessage')).body.text, /Срочность 3 \(по умолчанию\)/);
});

test('/task работает из любой группы, /chat привязывает рабочий чат', async () => {
  const { calls, send, msg, sqlite } = await freshEnv();
  // id рабочего чата в настройках записан с ошибкой — как это бывает руками
  sqlite.prepare("UPDATE settings SET value = '3832901696' WHERE key = 'tg_chat_id'").run();
  const inOther = (text) => msg('1', text, { chat: { id: -1003832901696, type: 'supergroup', title: 'Ассистенты' } });

  const { body } = await send(inOther('/task @xenyav 1 срочная'));
  assert.equal(body.ok, true, 'команда принята, хотя чат не совпал с настройкой');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks')).length, 1);

  // обычное сообщение из этого чата пока не замеряется
  const plain = await send(inOther('когда будет готово?'));
  assert.match(plain.body.skipped, /чужой чат/);

  // ассистент привязать чат не может
  const byAssistant = await send({ ...inOther('/chat'), message: { ...inOther('/chat').message, from: { id: 2, is_bot: false, username: 'xenyav' } } });
  assert.equal(byAssistant.body.skipped, 'не руководитель');

  const bound = await send(inOther('/chat@Hotassist_bot'));
  assert.equal(bound.body.bound, '-1003832901696');
  assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key = 'tg_chat_id'").get().value, '-1003832901696');
  assert.match(calls.filter((c) => c.url.includes('sendMessage')).pop().body.text, /Рабочий чат привязан: <b>Ассистенты<\/b>/);

  // теперь вопрос руководителя открывает таймер
  const tracked = await send(inOther('когда будет готово?'));
  assert.equal(tracked.body.tracked, 'request');
});

test('срочность по умолчанию берётся из настройки', async () => {
  const { calls, send, msg, sqlite } = await freshEnv();
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('task_default_priority', '7')").run();
  await send(msg('1', '/task @xenyav Купить билет'));
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks'));
  assert.deepEqual(create.body.stickers, { '0681807e-900b-47b6-8880-624802294bb0': 'e6257641af72' });
  assert.match(calls.find((c) => c.url.includes('sendMessage')).body.text, /Срочность 7 \(по умолчанию\) — неделя/);
});

test('многострочная задача целиком уходит в название, переносы — пробелами', async () => {
  const { calls, send, msg } = await freshEnv();
  // реальный случай: руководитель пишет задачу одним сообщением в несколько строк
  const text = '/task @xenyav 3 Подобрать рестораны рядом с местом жительства в Алматы\n' +
    'Собрать их в коллекцию мест на гугл картах, скинуть коллекцию ссылкой сюда\n' +
    'В описаниях мест подписать что за кухня';
  await send(msg('1', text));

  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks'));
  assert.equal(
    create.body.title,
    'Подобрать рестораны рядом с местом жительства в Алматы ' +
    'Собрать их в коллекцию мест на гугл картах, скинуть коллекцию ссылкой сюда ' +
    'В описаниях мест подписать что за кухня',
    'весь текст задачи в названии, одной строкой'
  );
  assert.equal(create.body.description, undefined, 'описание не заполняем');
});

test('настройкой можно вернуть разнесение: название + описание с кликабельной ссылкой', async () => {
  const { calls, send, msg, sqlite } = await freshEnv();
  sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('task_full_title', '0')").run();
  await send(msg('1', '/task @xenyav 3 Проверить прайс\nсмотри https://example.com/prices там всё'));
  const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks'));
  assert.equal(create.body.title, 'Проверить прайс');
  assert.match(create.body.description, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/example\.com\/prices">/);
  assert.match(calls.find((c) => c.url.includes('sendMessage')).body.text, /В описание: 1 стр/);
});

test('ошибки: чужая срочность, неизвестный ник, нет ID YouGile, не руководитель', async () => {
  const { calls, send, msg, sqlite } = await freshEnv();
  const created = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api-v2/tasks')).length;
  const lastReply = () => calls.filter((c) => c.url.includes('sendMessage')).pop().body.text;

  await send(msg('1', '/task @xenyav 5 задача'));
  assert.equal(created(), 0);
  assert.match(lastReply(), /Срочность 5 не из списка: 1, 3, 7, 30/);

  await send(msg('1', '/task @nobody 3 задача'));
  assert.equal(created(), 0);
  assert.match(lastReply(), /Не знаю ника @nobody/);
  assert.match(lastReply(), /@xenyav — Kseniia/);

  await send(msg('1', '/task @katya 3 задача'));
  assert.equal(created(), 0);
  assert.match(lastReply(), /не указан ID в YouGile/);

  await send(msg('2', '/task @xenyav 3 задача'));
  assert.equal(created(), 0);
  assert.match(lastReply(), /Задачи ставит руководитель/);

  // правка сообщения команду не повторяет
  const edited = { edited_message: msg('1', '/task @xenyav 3 задача').message };
  const { body } = await send(edited);
  assert.equal(body.skipped, 'правка команды');
  assert.equal(created(), 0);

  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM chat_replies').get().n, 0, 'таймер ответа не открывался');
});
