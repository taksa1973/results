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
  assert.equal(d.t2s, 2);
  assert.equal(d.t2f, 8, 'в работе с 12:00 пн до 12:00 вт: шесть часов плюс два');
});

test('ночь и выходные не идут в счёт', () => {
  const night = {
    created_at: '2026-08-10T14:00:00Z',  // пн 17:00, остался час
    taken_at: '2026-08-11T07:30:00Z',    // вт 10:30, полчаса
    paused_min: 0,
  };
  assert.equal(taskDurations(night, S).t2s, 1.5);

  const weekend = {
    created_at: '2026-08-14T14:00:00Z',  // пт 17:00
    taken_at: '2026-08-17T07:30:00Z',    // пн 10:30
    paused_min: 0,
  };
  assert.equal(
    taskDurations(weekend, S).t2s, 1.5,
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
  assert.equal(d.t2f, 6, 'восемь часов в работе минус два часа блокера');
});

test('незавершённая стадия не портит метрику', () => {
  const open = { created_at: '2026-08-10T07:00:00Z', paused_min: 0 };
  const d = taskDurations(open, S);
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
  assert.equal(taskDurations(t, S).t2f, 3, 'ждать приёмку исполнитель не может: с 11:00 до 14:00');
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
  assert.equal(metrics.t2s1, 2, 'среднее из одного и трёх часов');
  assert.equal(metrics.t2f1, 1, 'в работе по часу каждая');
  assert.equal(metrics.t2s2, 2);
  assert.equal(metrics.t2f2, 3);
  assert.equal(metrics.t2s3, null, 'без задач третьего уровня метрики нет');
  assert.equal(detail.t2s1.count, 2);
  assert.equal(detail.t2s3.count, 0);
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
  assert.equal(metrics.t2s1, 2, 'посчитана только одна рабочая задача');
});

test('процент плана: чем быстрее, тем выше', () => {
  assert.equal(planPercent(8, 8), 100, 'ровно в план');
  assert.equal(planPercent(4, 8), 200, 'вдвое быстрее');
  assert.equal(planPercent(16, 8), 50, 'вдвое дольше');
  assert.equal(planPercent(0.1, 8), 200, 'выше двухсот процент не поднимается');
  assert.equal(planPercent(null, 8), null, 'без факта процента нет');
  assert.equal(planPercent(5, null), null, 'без плана процента нет');
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

  // в работе: ср 14:11–18:00, чт, пт по 8 ч, пн 10:00–11:15 → 21,1 ч; блокер не в счёт
  const d = taskDurations({ created_at: st.assignedAt['yg-kate'], taken_at: st.taken, work_done_at: st.workDoneAt, done_at: st.done, paused_min: st.pausedMin }, S2);
  assert.equal(d.t2f, 21.07);
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
  assert.equal(metrics.t2s1, 2);
  assert.equal(detail.t2s1.count, 2);

  // список исключаемых приоритетов — настройка
  const { metrics: m2 } = timeMetrics([t({ priority: 1 }), t({ priority: 7, taken_at: '2026-08-10T13:00:00Z' })], { ...S, skip_priority: '7,30' });
  assert.equal(m2.t2s1, 2, 'семёрка тоже выключена настройкой');
  assert.deepEqual([...__test.skipPriorities({})], [30], 'по умолчанию — только тридцать');
});
