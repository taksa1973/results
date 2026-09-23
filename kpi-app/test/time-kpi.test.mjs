// Проверка ядра модели Time to start / Time to fill.
//
// Даты в тестах взяты от понедельника 10 августа 2026 года.
// Часовой пояс МСК (+3), рабочее окно 10:00–18:00, поэтому
// 07:00 UTC — это ровно начало рабочего дня.

import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/worker.js';

const {
  timeMetrics, taskDurations, levelOfTask, planPercent, autoMark,
  quarterOf, monthsOfQuarter,
} = __test;

// окно 10–18 задано явно: ожидания ниже считались для него
const S = { tz_offset: '3', overplan_percent: '120', task_day_start: '10:00', task_day_end: '18:00' };

test('месяц сводится в нужный квартал', () => {
  assert.equal(quarterOf('2026-08'), '2026-Q3');
  assert.equal(quarterOf('2026-01'), '2026-Q1');
  assert.equal(quarterOf('2026-12'), '2026-Q4');
  assert.deepEqual(monthsOfQuarter('2026-Q3'), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(monthsOfQuarter('2026-Q1'), ['2026-01', '2026-02', '2026-03']);
});

test('уровень сложности берётся со стикера размера', () => {
  assert.equal(levelOfTask({ size: 1 }), 1);   // S
  assert.equal(levelOfTask({ size: 2 }), 2);   // M
  assert.equal(levelOfTask({ size: 3 }), 3);   // L
  assert.equal(levelOfTask({ size: 5 }), 3);   // XL
  assert.equal(levelOfTask({ size: 1, level: 3 }), 3, 'явно проставленный уровень важнее размера');
});

test('время считается в рабочих часах', () => {
  const t = {
    created_at: '2026-08-10T07:00:00Z',  // пн 10:00
    taken_at: '2026-08-10T09:00:00Z',    // пн 12:00
    done_at: '2026-08-11T09:00:00Z',     // вт 12:00
    paused_min: 0,
  };
  const d = taskDurations(t, S);
  assert.equal(d.t2s, 2, 'от постановки до взятия в работу');
  assert.equal(d.t2f, 10, 'от постановки до сдачи: восемь часов понедельника плюс два вторника');
  assert.equal(d.t2a, 2, 'сразу в работу — принята в момент взятия');
});

test('ночь и выходные не идут в счёт', () => {
  const night = {
    created_at: '2026-08-10T14:00:00Z',  // пн 17:00, остался час
    taken_at: '2026-08-11T07:30:00Z',    // вт 10:30, полчаса
    paused_min: 0,
  };
  assert.equal(taskDurations(night, S).t2a, 1.5);

  const weekend = {
    created_at: '2026-08-14T14:00:00Z',  // пт 17:00
    taken_at: '2026-08-17T07:30:00Z',    // пн 10:30
    paused_min: 0,
  };
  assert.equal(
    taskDurations(weekend, S).t2a, 1.5,
    'задача, поставленная вечером пятницы, не должна показывать двое суток простоя'
  );
});

test('пауза вычитается только из времени завершения', () => {
  const t = {
    created_at: '2026-08-10T07:00:00Z',
    taken_at: '2026-08-10T09:00:00Z',
    done_at: '2026-08-11T09:00:00Z',
    paused_min: 120,                     // два часа в блокере
  };
  const d = taskDurations(t, S);
  assert.equal(d.t2s, 2, 'взять задачу в работу блокер не мешал');
  assert.equal(d.t2f, 8, 'десять часов от постановки минус два часа блокера');
});

test('незавершённая стадия не портит метрику', () => {
  const open = { created_at: '2026-08-10T07:00:00Z', paused_min: 0 };
  const d = taskDurations(open, S);
  assert.equal(d.t2a, null);
  assert.equal(d.t2s, null);
  assert.equal(d.t2f, null);
});

test('время сдачи работы важнее времени приёмки', () => {
  const t = {
    created_at: '2026-08-10T07:00:00Z',
    taken_at: '2026-08-10T08:00:00Z',
    work_done_at: '2026-08-10T11:00:00Z', // сдал в 14:00
    done_at: '2026-08-12T09:00:00Z',      // приняли только в четверг
    paused_min: 0,
  };
  assert.equal(taskDurations(t, S).t2f, 4, 'от постановки до сдачи: с 10:00 до 14:00');
});

test('шесть метрик считаются по своим уровням', () => {
  const base = Date.parse('2026-08-10T07:00:00Z');
  const mk = (level, t2sH, t2fH) => ({
    size: level === 3 ? 5 : level,
    paused_min: 0,
    status: 'accepted',
    is_zaeb: 0,
    created_at: '2026-08-10T07:00:00Z',
    taken_at: new Date(base + t2sH * 3600e3).toISOString(),
    done_at: new Date(base + t2fH * 3600e3).toISOString(),
  });

  const { metrics, detail } = timeMetrics([mk(1, 1, 2), mk(1, 3, 4), mk(2, 2, 5)], S);
  assert.equal(metrics.t2s, 2, 'до старта от постановки: среднее из 1, 3 и 2');
  assert.equal(metrics.t2f1, 3, 'решение от постановки: 2 и 4 часа');
  assert.equal(metrics.t2f2, 5);
  assert.equal(metrics.t2f3, null, 'без задач третьего уровня метрики нет');
  assert.equal(detail.t2s.count, 3);
  assert.equal(detail.t2f3.count, 0);
  assert.equal(metrics.quality, 100, 'возвратов не было');
});

test('заёбы и отменённые задачи в метрики не идут', () => {
  const t = (extra) => ({
    size: 1, paused_min: 0, status: 'accepted', is_zaeb: 0,
    created_at: '2026-08-10T07:00:00Z',
    taken_at: '2026-08-10T09:00:00Z',
    done_at: '2026-08-10T11:00:00Z',
    ...extra,
  });
  const { metrics } = timeMetrics([t({}), t({ is_zaeb: 1 }), t({ status: 'cancelled' })], S);
  assert.equal(metrics.t2s, 2, 'посчитана только одна рабочая задача');
});

test('процент нормы: обгон ограничен потолком', () => {
  assert.equal(planPercent(8, 8), 100, 'ровно в норму');
  assert.equal(planPercent(4, 8), 120, 'вдвое быстрее — но потолок 120');
  assert.equal(planPercent(16, 8), 50, 'вдвое дольше');
  assert.equal(planPercent(0.1, 8), 120, 'мгновенно — тот же потолок');
  assert.equal(planPercent(null, 8), null, 'без факта процента нет');
  assert.equal(planPercent(5, null), null, 'без нормы процента нет');
  // потолок настраивается: он и держит баланс между обгоном и провалом
  assert.equal(planPercent(4, 8, { percent_cap: '100' }), 100);
  assert.equal(planPercent(4, 8, { percent_cap: '200' }), 200);
});

test('оценка предлагается по проценту плана', () => {
  assert.equal(autoMark(50, S), 'minus');
  assert.equal(autoMark(80, S), 'plusminus');
  assert.equal(autoMark(100, S), 'plus');
  assert.equal(autoMark(115, S), 'plus2');
  assert.equal(autoMark(130, S), 'plus3');
  assert.equal(autoMark(145, S), 'plus4');
  assert.equal(autoMark(null, S), null, 'без данных оценку не предлагаем');
});

test('порог сверхплана переносится настройкой', () => {
  const strict = { ...S, overplan_percent: '150' };
  assert.equal(autoMark(130, strict), 'plus2', 'при пороге сто пятьдесят сто тридцать это ещё не сверхплан');
  assert.equal(autoMark(160, strict), 'plus3');
  assert.equal(autoMark(175, strict), 'plus4');
});

test('срок по приоритету — полные рабочие дни в рабочих часах', () => {
  const { deadlineByPriority } = __test;
  const msk = (iso) => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const S9 = { tz_offset: '3' }; // окно по умолчанию 9–18, день 9 часов

  // пятница 14.08 23:00 МСК, приоритет 3 → понедельник 9:00 + 27 ч = среда 18:00
  assert.equal(msk(deadlineByPriority('2026-08-14T20:00:00Z', 3, S9)), '2026-08-19 18:00');
  // понедельник 25.08 17:26 МСК, приоритет 3 → 34 мин + 9 + 9 + 8 ч 26 мин = четверг 17:26
  assert.equal(msk(deadlineByPriority('2026-08-25T14:26:00Z', 3, S9)), '2026-08-28 17:26');
  // приоритет 1 — рабочий день: понедельник 13:00 → вторник 13:00
  assert.equal(msk(deadlineByPriority('2026-08-10T10:00:00Z', 1, S9)), '2026-08-11 13:00');
  // суббота, приоритет 3 → с понедельника 9:00 → среда 18:00
  assert.equal(msk(deadlineByPriority('2026-08-15T09:00:00Z', 3, S9)), '2026-08-19 18:00');
  // приоритет 7 — неделя: понедельник 9:00 → следующий вторник 18:00
  assert.equal(msk(deadlineByPriority('2026-08-10T06:00:00Z', 7, S9)), '2026-08-18 18:00');
});

test('рабочий день по умолчанию — с 9:00: пятница 23:00 → понедельник 9:13 это 13 минут', () => {
  const { workMinutesBetween, workWindow } = __test;
  assert.deepEqual(workWindow({}), { from: 9 * 60, to: 18 * 60, dayMin: 9 * 60 });
  // пятница 14.08.2026 23:00 МСК = 20:00Z; понедельник 17.08 9:13 МСК = 06:13Z
  assert.equal(workMinutesBetween('2026-08-14T20:00:00Z', '2026-08-17T06:13:00Z', {}), 13);
  // окно из настроек чата подхватывается, если своё не задано
  assert.equal(workMinutesBetween('2026-08-14T20:00:00Z', '2026-08-17T06:13:00Z', { work_start: '08:00' }), 73);
  // внутри окна — минута в минуту
  assert.equal(workMinutesBetween('2026-08-17T06:13:00Z', '2026-08-17T07:00:00Z', {}), 47);
});

test('таймлайн задачи проигрывается из лога YouGile (VSE-312)', () => {
  const { replayLog, taskDurations } = __test;
  const S2 = { ...S, column_backlog: 'c-backlog', column_in_progress: 'c-work', column_blocked: 'c-block', column_done: 'c-done' };
  // события как в логе трекера: назначения, переходы, закрытие
  const log = [
    { at: '2026-08-04T14:30:41.709Z', kind: 'assigned', user: 'yg-lead' },
    { at: '2026-08-04T14:37:28.304Z', kind: 'assigned', user: 'yg-kate' },
    { at: '2026-08-05T11:11:02.706Z', kind: 'move', from: 'c-backlog', to: 'c-work', by: 'yg-kate' },   // 14:11 МСК
    { at: '2026-08-10T08:15:25.290Z', kind: 'move', from: 'c-work', to: 'c-block', by: 'yg-kate' },    // 11:15 МСК
    { at: '2026-09-15T08:10:42.413Z', kind: 'completed', by: 'yg-kate' },
    { at: '2026-09-15T08:10:42.800Z', kind: 'move', from: 'c-block', to: 'c-done', by: 'yg-kate' },
  ];
  const st = replayLog(log, S2);
  assert.equal(st.taken, '2026-08-05T11:11:02.706Z', 'взята в момент переноса в «В работе»');
  assert.equal(st.takenBy, 'yg-kate', 'кто перетащил — тот и делает');
  assert.equal(st.status, 'accepted');
  assert.equal(st.done, '2026-09-15T08:10:42.413Z');
  assert.equal(st.assignedAt['yg-kate'], '2026-08-04T14:37:28.304Z', 'поставлена Кате, когда назначили');
  assert.ok(st.pausedMin > 0, 'месяц в блокере — пауза');

  // решение от постановки: 4,57 ч до взятия плюс 21,07 ч работы; блокер не в счёт
  const d = taskDurations({ created_at: st.assignedAt['yg-kate'], taken_at: st.taken, work_done_at: st.workDoneAt, done_at: st.done, paused_min: st.pausedMin }, S2);
  assert.equal(d.t2f, 25.63);
  // до старта: назначена 4 авг 17:37 → взята 5 авг 14:11 = 23 мин + 4 ч 11 мин
  assert.equal(d.t2s, 4.57);
});

test('задачи с приоритетом 30 в расчёт не идут', () => {
  const t = (extra) => ({
    size: 1, paused_min: 0, status: 'accepted', is_zaeb: 0,
    created_at: '2026-08-10T07:00:00Z',
    taken_at: '2026-08-10T09:00:00Z',
    done_at: '2026-08-10T11:00:00Z',
    ...extra,
  });
  // месячная задача взята через 6 часов — среднее должна не трогать
  const monthly = t({ priority: 30, taken_at: '2026-08-10T13:00:00Z' });
  const { metrics, detail } = timeMetrics([t({ priority: 1 }), t({ priority: 7 }), monthly], S);
  assert.equal(metrics.t2s, 2);
  assert.equal(detail.t2s.count, 2);

  // список исключаемых приоритетов — настройка
  const { metrics: m2 } = timeMetrics([t({ priority: 1 }), t({ priority: 7, taken_at: '2026-08-10T13:00:00Z' })], { ...S, skip_priority: '7,30' });
  assert.equal(m2.t2s, 2, 'семёрка тоже выключена настройкой');
  assert.deepEqual([...__test.skipPriorities({})], [30], 'по умолчанию — только тридцать');
});

test('переоткрытая задача — новый цикл; созданная сразу в «В работе» — взята при постановке (VSE-325)', () => {
  const { replayLog, taskDurations } = __test;
  const S2 = { tz_offset: '3', column_in_progress: 'c-work', column_blocked: 'c-block', column_done: 'c-done' };
  const log = [
    { at: '2026-08-07T11:23:39.454Z', kind: 'assigned', user: 'yg-lead' },                       // создана сразу в «В работе»
    { at: '2026-08-10T11:54:10.030Z', kind: 'move', from: 'c-work', to: 'c-block', by: 'yg-lead' },
    { at: '2026-08-17T05:42:52.141Z', kind: 'completed', by: 'yg-lead' },
    { at: '2026-08-17T05:42:52.149Z', kind: 'move', from: 'c-block', to: 'c-done', by: 'yg-lead' },
    { at: '2026-09-02T12:40:03.889Z', kind: 'reopened', by: 'yg-lead' },                         // сняли галочку
    { at: '2026-09-02T12:40:16.057Z', kind: 'move', from: 'c-done', to: 'c-work', by: 'yg-lead' }, // 15:40 МСК
    { at: '2026-09-02T15:48:06.392Z', kind: 'move', from: 'c-work', to: 'c-block', by: 'yg-lead' }, // 18:48 МСК
    { at: '2026-09-03T13:54:32.297Z', kind: 'move', from: 'c-block', to: 'c-work', by: 'yg-lead' }, // 16:54 МСК
    { at: '2026-09-04T06:21:37.133Z', kind: 'move', from: 'c-work', to: 'c-block', by: 'yg-lead' }, // 09:21 МСК
  ];

  // первый цикл, до переоткрытия: взята при постановке, закрыта 17 августа
  const first = replayLog(log.slice(0, 4), S2);
  assert.equal(first.taken, '2026-08-07T11:23:39.454Z', 'создана в «В работе» — взята при постановке');
  assert.equal(first.status, 'accepted');
  assert.equal(first.done, '2026-08-17T05:42:52.141Z');

  // после переоткрытия — всё заново
  const st = replayLog(log, S2);
  assert.equal(st.cycleStart, '2026-09-02T12:40:03.889Z', 'поставлена заново в момент переоткрытия');
  assert.equal(st.taken, '2026-09-02T12:40:16.057Z', 'взята через 13 секунд');
  assert.equal(st.done, null, 'старое закрытие к новому циклу не относится');
  assert.equal(st.status, 'blocked');
  assert.ok(st.pausedSince, 'сейчас в блокере — таймер стоит');

  const d = taskDurations({ created_at: st.cycleStart, taken_at: st.taken, work_done_at: st.workDoneAt, done_at: st.done, paused_min: st.pausedMin }, S2);
  assert.equal(d.t2s, 0, 'до старта — ноль: взята через 13 секунд');
  assert.equal(d.t2f, null, 'ещё не сдана');
  // в работе: 15:40–18:00 (2 ч 20) и 16:54–18:00 + 9:00–9:21 (1 ч 27) = 3 ч 47
  const inWork = __test.workMinutesBetween(st.taken, '2026-09-04T06:21:37.133Z', S2) - st.pausedMin;
  assert.equal(Math.round(inWork), 227);
});

test('всё считается от постановки, «Принята» не останавливает счётчик', () => {
  const S9 = { tz_offset: '3' };
  // пятница 14.08 23:00 МСК поставлена, понедельник 9:13 принята, 11:13 взята, 14:13 сдана
  const t = {
    created_at: '2026-08-14T20:00:00Z',
    acked_at: '2026-08-17T06:13:00Z',
    taken_at: '2026-08-17T08:13:00Z',
    work_done_at: '2026-08-17T11:13:00Z',
    paused_min: 0,
  };
  const d = taskDurations(t, S9);
  assert.equal(d.t2a, 0.22, 'принята через 13 минут рабочего времени — справочно');
  assert.equal(d.t2s, 2.22, 'до старта считается от постановки, а не от принятия');
  assert.equal(d.t2f, 5.22, 'решение — от постановки до сдачи');

  // «Принята» пропустили — обе метрики те же
  const d2 = taskDurations({ ...t, acked_at: null }, S9);
  assert.equal(d2.t2s, 2.22, 'перенос в «Принята» ничего не меняет');
  assert.equal(d2.t2f, 5.22);

  // в KPI время до принятия не входит
  assert.deepEqual(__test.METRIC_KEYS, ['t2s', 't2f1', 't2f2', 't2f3']);
});

test('таймлайн: стадия «Принята» из лога, вернули в «Принята» из работы — таймер стоит', () => {
  const { replayLog } = __test;
  const S2 = { tz_offset: '3', column_backlog: 'c-new', column_acked: 'c-ack', column_in_progress: 'c-work', column_review: 'c-rev' };
  const st = replayLog([
    { at: '2026-08-10T07:00:00Z', kind: 'assigned', user: 'yg-kate' },
    { at: '2026-08-10T07:30:00Z', kind: 'move', from: 'c-new', to: 'c-ack', by: 'yg-kate' },
    { at: '2026-08-10T09:00:00Z', kind: 'move', from: 'c-ack', to: 'c-work', by: 'yg-kate' },
    { at: '2026-08-10T10:00:00Z', kind: 'move', from: 'c-work', to: 'c-ack', by: 'yg-kate' },   // передумала — пауза
    { at: '2026-08-10T11:00:00Z', kind: 'move', from: 'c-ack', to: 'c-work', by: 'yg-kate' },
    { at: '2026-08-10T12:00:00Z', kind: 'move', from: 'c-work', to: 'c-rev', by: 'yg-kate' },
  ], S2);
  assert.equal(st.acked, '2026-08-10T07:30:00Z');
  assert.equal(st.taken, '2026-08-10T09:00:00Z');
  assert.equal(st.pausedMin, 60, 'час в «Принята» после взятия — пауза');
  assert.equal(st.workDoneAt, '2026-08-10T12:00:00Z');

  // карточка уехала из «Принята», а записи о приёмке нет — принята при постановке
  const st2 = replayLog([
    { at: '2026-08-10T07:00:00Z', kind: 'assigned', user: 'yg-kate' },
    { at: '2026-08-10T09:00:00Z', kind: 'move', from: 'c-ack', to: 'c-work', by: 'yg-kate' },
  ], S2);
  assert.equal(st2.acked, '2026-08-10T07:00:00Z');
});

test('время на проверке копится отдельно и не входит в оценку исполнителя', () => {
  const { replayLog, taskDurations } = __test;
  const S2 = { tz_offset: '3', column_in_progress: 'c-work', column_review: 'c-rev', column_done: 'c-done' };
  const st = replayLog([
    { at: '2026-08-10T07:00:00Z', kind: 'assigned', user: 'yg-kate' },
    { at: '2026-08-10T07:00:00Z', kind: 'move', from: 'c-new', to: 'c-work', by: 'yg-kate' },  // пн 10:00 взята
    { at: '2026-08-10T09:00:00Z', kind: 'move', from: 'c-work', to: 'c-rev', by: 'yg-kate' },  // 12:00 сдана
    { at: '2026-08-12T09:00:00Z', kind: 'move', from: 'c-rev', to: 'c-work', by: 'yg-lead' },  // ср 12:00 вернули
    { at: '2026-08-12T10:00:00Z', kind: 'move', from: 'c-work', to: 'c-rev', by: 'yg-kate' },  // 13:00 сдана снова
    { at: '2026-08-14T07:00:00Z', kind: 'move', from: 'c-rev', to: 'c-done', by: 'yg-lead' }, // пт 10:00 принята
  ], S2);

  // на проверке: пн 12:00 → ср 12:00 (6 + 9 + 3 = 18 ч) и ср 13:00 → пт 10:00 (5 + 9 + 1 = 15 ч)
  assert.equal(st.reviewMin, 33 * 60, 'проверка считается отдельно');
  assert.equal(__test.qualityPercent(st.returns), 90, 'один возврат — минус десять процентов');
  assert.equal(st.reviewSince, null, 'принята — счётчик закрыт');
  assert.equal(st.returns, 1);

  // в работе: пн 10:00–12:00 и ср 12:00–13:00 = 3 часа, проверка не в счёт
  const d = taskDurations({ created_at: '2026-08-10T07:00:00Z', taken_at: st.taken, work_done_at: st.workDoneAt, done_at: st.done, paused_min: st.pausedMin }, S2);
  assert.equal(d.t2f, 3, 'тридцать три часа проверки в оценку исполнителя не идут');
});

test('итог взвешен: решение важнее всего, принятие в KPI не входит', () => {
  const { weightedPercent, metricWeights, qualityPercent } = __test;
  const S0 = {};
  assert.deepEqual(metricWeights(S0), { work: 50, done: 20, t2s: 20, quality: 10 });

  // качество по возвратам
  assert.equal(qualityPercent(0), 100);
  assert.equal(qualityPercent(1), 90, 'первый возврат — уточнение, почти бесплатно');
  assert.equal(qualityPercent(2), 70);
  assert.equal(qualityPercent(3), 50);
  assert.equal(qualityPercent(6), 0);

  // взял мгновенно (потолок 120), но сдал одну из десяти и решал вдвое дольше нормы
  const fast = weightedPercent(
    { done: 10, quality: 100 }, { t2a: 120, t2s: 120, t2f1: 50 }, { t2f1: { count: 5 } }, S0
  );
  // (2500 + 200 + 2400 + 1000) / 100 = 61
  assert.equal(fast, 61);

  // всё сдал, уложился, без возвратов
  const solid = weightedPercent(
    { done: 100, quality: 100 }, { t2a: 50, t2s: 80, t2f1: 110 }, { t2f1: { count: 5 } }, S0
  );
  // (5500 + 2000 + 1600 + 1000) / 100 = 101
  assert.equal(solid, 101);
  assert.ok(solid > fast, 'обгон по взятию больше не перекрывает провал по решению');

  // время до принятия в расчёт не входит вовсе
  const withAck = weightedPercent(
    { done: 100, quality: 100 }, { t2a: 120, t2s: 80, t2f1: 110 }, { t2f1: { count: 5 } }, S0
  );
  assert.equal(withAck, solid, 'сколько бы ни было «до принятия», итог тот же');

  // возвраты бьют по итогу
  const returned = weightedPercent(
    { done: 100, quality: qualityPercent(3) }, { t2s: 80, t2f1: 110 }, { t2f1: { count: 5 } }, S0
  );
  assert.ok(returned < solid, 'три возврата снимают проценты');
});

test('взятая и зависшая дольше нормы задача портит метрику сразу', () => {
  const now = '2026-09-23T07:00:00Z'; // ср 10:00 МСК
  const S2 = { tz_offset: '3' };
  const sla = { t2f1: 8, t2f2: 24, t2f3: 80 };
  const mk = (extra) => ({
    size: 1, level: 1, status: 'in_progress', is_zaeb: 0, paused_min: 0,
    created_at: '2026-09-21T06:00:00Z', acked_at: '2026-09-21T06:00:00Z',
    taken_at: '2026-09-21T06:00:00Z', ...extra,
  });

  // взял в понедельник 9:00 и держит до среды 10:00 — это 19 раб. ч при норме 8
  const hanging = mk({});
  const { metrics, detail } = timeMetrics([hanging], S2, '2026-09', { sla, now });
  assert.equal(metrics.t2f1, 19, 'считается по текущему моменту');
  assert.equal(metrics.quality, null, 'ничего не сдано — качество не считается');
  assert.equal(detail.t2f1.hanging, 1);
  assert.equal(metrics.done, 0, 'взял одну, сдал ноль');

  // поставлена час назад и уже в работе — в норме, метрику не трогает
  const fresh = mk({ created_at: '2026-09-23T06:00:00Z', acked_at: '2026-09-23T06:00:00Z', taken_at: '2026-09-23T06:30:00Z' });
  const r2 = timeMetrics([fresh], S2, '2026-09', { sla, now });
  assert.equal(r2.metrics.t2f1, null, 'пока в норме — не мешаем работать');

  // в прошлых месяцах зависшие не учитываются: они висят «сейчас»
  const r3 = timeMetrics([hanging], S2, '2026-08', { sla, now });
  assert.equal(r3.metrics.t2f1, null);

  // сданная задача считается как раньше
  const done = mk({ status: 'accepted', work_done_at: '2026-09-21T10:00:00Z', returns: 2 });
  const r4 = timeMetrics([done], S2, '2026-09', { sla, now });
  assert.equal(r4.metrics.t2f1, 4);
  assert.equal(r4.metrics.quality, 70, 'два возврата с проверки');
  assert.equal(r4.metrics.done, 100, 'взял одну, сдал одну');
});
