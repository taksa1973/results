// Привязка сообщений из чата к задачам: бот не должен дёргать людей наугад.
//
// Оба случая взяты из жизни: реплика «в районе 36 долларов» уехала в задачу про
// инженеров, а постановка «#Задача: закинуть список девайсов» — в задачу про
// автодома. Правило простое: не уверен — молчим.
//
// Поиск идёт по полю keywords («слова заголовка|слова описания»), которое
// считается при синхронизации: слова от трёх букв, обрезанные до пяти.

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/worker.js';

const { needsReply, detectTask } = __test;

// findTaskCandidates ходит в базу один раз: db.prepare(...).all() → { results }
const mockDb = (tasks) => ({
  prepare: () => ({ all: async () => ({ results: tasks }) }),
});
const task = (id, keywords, assignee = 'u1') => ({
  id, keywords, assignee_id: assignee, title: id, number: 1, status: 'in_progress', deadline: null,
});

const S = { llm_enabled: '0', no_reply_words: 'спасибо,понял,ок,принял' };

test('постановка задачи — не вопрос: таймер ответа не открывается', () => {
  assert.equal(
    needsReply({ text: '#Задача: Закинуть список девайсов и приблуд с этих фото. Отдельно по каждому фото.' }, S),
    false,
    'сообщение с #Задача — команда руководителя, а не вопрос'
  );
  assert.equal(needsReply({ text: '#задачи собрать список ссылок на поставщиков оборудования' }, S), false);
  assert.equal(needsReply({ text: '#task check the supplier list and prices' }, S), false);
});

test('обычный вопрос по-прежнему требует ответа', () => {
  assert.equal(needsReply({ text: 'Когда будут билеты?' }, S), true, 'вопросительный знак');
  assert.equal(needsReply({ text: 'Посмотри пожалуйста статус по отелю в Белграде' }, S), true, 'длинная просьба');
  assert.equal(needsReply({ text: 'спасибо' }, S), false, 'подтверждение таймер не открывает');
  assert.equal(needsReply({ text: 'ок' }, S), false);
});

test('нет общих слов — задача не привязывается', async () => {
  // «Рынок аренды автодомов в Бразилии» против сообщения про девайсы на фото
  const db = mockDb([task('автодома', 'рынок аренд автод брази изучи оффер цены сьеме заран|')]);
  const r = await detectTask(db, 'Закинуть список девайсов и приблуд с этих фото, отдельно по каждому', S);
  assert.equal(r.task, null, 'у сообщения и задачи нет общего смысла — привязывать нельзя');
});

test('одно общее слово — тоже не повод привязать', async () => {
  const db = mockDb([
    task('поставщики', 'соста списо поста|'),
    task('клиники', 'списо клини белгр|', 'u2'),
  ]);
  const r = await detectTask(db, 'скинь список пожалуйста', S);
  assert.equal(r.task, null, 'одно частое слово не значит, что речь об этой задаче');
});

test('явное совпадение по двум словам — привязываем', async () => {
  const db = mockDb([
    task('отель', 'забро отель белгр недел|'),
    task('билеты', 'купит билет стамб|', 'u2'),
  ]);
  const r = await detectTask(db, 'что там с отелем в Белграде, забронировали?', S);
  assert.equal(r.task?.id, 'отель', 'два значимых слова указывают на задачу однозначно');
});

test('модель не выбрала — не подставляем первого попавшегося', async () => {
  // два равных кандидата по одному общему слову: раньше брался candidates[0]
  const db = mockDb([
    task('отель-1', 'забро отель белгр недел|'),
    task('отель-2', 'забро отель стамб авгус|', 'u2'),
  ]);
  const r = await detectTask(db, 'забронировали отель уже?', { ...S, llm_enabled: '0' });
  assert.equal(r.task, null, 'кандидаты равны, модель выключена — привязывать наугад нельзя');
});
