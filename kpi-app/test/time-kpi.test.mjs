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

const S = { tz_offset: '3', overplan_percent: '120' };

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
  assert.equal(d.t2f, 10, 'полный рабочий день восемь часов плюс два часа вторника');
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
  assert.equal(d.t2f, 8, 'простой не по вине исполнителя снят');
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
  assert.equal(taskDurations(t, S).t2f, 4, 'ждать приёмку исполнитель не может');
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
  assert.equal(metrics.t2f1, 3);
  assert.equal(metrics.t2s2, 2);
  assert.equal(metrics.t2f2, 5);
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

test('срок по приоритету считается рабочими днями', () => {
  const { addWorkdays } = __test;
  const local = (iso) => new Date(new Date(iso).getTime() + 3 * 3600e3); // МСК
  const day = (iso) => ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][local(iso).getUTCDay()];

  // пятница 14.08.2026 вечером, приоритет 3 → среда
  const fridayEvening = '2026-08-14T16:30:00Z'; // 19:30 МСК
  assert.equal(day(addWorkdays(fridayEvening, 3)), 'ср');

  // пятница днём, приоритет 3 → пятница, понедельник, вторник
  const fridayNoon = '2026-08-14T10:00:00Z'; // 13:00 МСК
  assert.equal(day(addWorkdays(fridayNoon, 3)), 'вт');

  // пятница вечером, приоритет 1 → понедельник
  assert.equal(day(addWorkdays(fridayEvening, 1)), 'пн');

  // среда вечером, приоритет 1 → четверг; днём — сама среда
  assert.equal(day(addWorkdays('2026-08-12T16:00:00Z', 1)), 'чт');
  assert.equal(day(addWorkdays('2026-08-12T09:00:00Z', 1)), 'ср');

  // суббота, приоритет 3 → пн, вт, ср
  assert.equal(day(addWorkdays('2026-08-15T09:00:00Z', 3)), 'ср');
});
