-- Переход на модель Time to start / Time to fill.
--
-- Метрик шесть: две скорости × три уровня сложности. Считаются помесячно,
-- сводятся поквартально, сравниваются с планом (SLA). Дальше квартальная
-- оценка с учётом отзывов и премия по матрице «грейд × оценка».
--
-- Применять только этим файлом: schema.sql начинается с DROP TABLE.
--   sqlite3 /opt/kpi-app/data/kpi.db < migrations/003_time_kpi.sql

-- ── Уровень сложности задачи ────────────────────────────────────────────────
-- 1 — простая, 2 — обычная, 3 — сложная. Берётся со стикера «Размер задачи»,
-- а где стикера нет — определяется по заголовку локальной моделью.
ALTER TABLE tasks ADD COLUMN level INTEGER;
ALTER TABLE tasks ADD COLUMN level_src TEXT;     -- sticker | model | default

-- Сколько часов заняли обе стадии. Считаются при синхронизации и хранятся
-- готовыми: иначе каждый отчёт пересчитывал бы рабочий календарь заново.
ALTER TABLE tasks ADD COLUMN t2s_hours REAL;     -- от постановки до взятия в работу
ALTER TABLE tasks ADD COLUMN t2f_hours REAL;     -- от постановки до завершения

-- ── Плановые значения (SLA) ─────────────────────────────────────────────────
-- Пересматриваются раз в квартал. История сохраняется: старые кварталы
-- должны считаться по тем нормам, которые действовали тогда.
CREATE TABLE IF NOT EXISTS sla (
  metric     TEXT NOT NULL,          -- t2s | t2f
  level      INTEGER NOT NULL,       -- 1 | 2 | 3
  hours      REAL NOT NULL,          -- плановое значение в рабочих часах
  valid_from TEXT NOT NULL,          -- квартал, с которого действует: 2026-Q3
  note       TEXT,
  PRIMARY KEY (metric, level, valid_from)
);

-- ── Матрица премирования: грейд × итоговая оценка ───────────────────────────
-- Процент от квартальной зарплаты. Значения взяты из проверенной схемы,
-- меняться почти не должны.
CREATE TABLE IF NOT EXISTS bonus_matrix (
  grade   INTEGER NOT NULL,          -- 1..7
  mark    TEXT NOT NULL,             -- minus | plusminus | plus | plus2 | plus3 | plus4
  percent REAL NOT NULL,
  PRIMARY KEY (grade, mark)
);

INSERT OR REPLACE INTO bonus_matrix (grade, mark, percent) VALUES
  (7,'minus',0), (7,'plusminus',9), (7,'plus',18), (7,'plus2',20), (7,'plus3',27), (7,'plus4',36),
  (6,'minus',0), (6,'plusminus',8), (6,'plus',16), (6,'plus2',18), (6,'plus3',24), (6,'plus4',32),
  (5,'minus',0), (5,'plusminus',7), (5,'plus',14), (5,'plus2',16), (5,'plus3',20), (5,'plus4',28),
  (4,'minus',0), (4,'plusminus',6), (4,'plus',12), (4,'plus2',14), (4,'plus3',18), (4,'plus4',24),
  (3,'minus',0), (3,'plusminus',5), (3,'plus',10), (3,'plus2',12), (3,'plus3',15), (3,'plus4',20),
  (2,'minus',0), (2,'plusminus',0), (2,'plus',0),  (2,'plus2',0),  (2,'plus3',0),  (2,'plus4',0),
  (1,'minus',0), (1,'plusminus',0), (1,'plus',0),  (1,'plus2',0),  (1,'plus3',0),  (1,'plus4',0);

-- ── Отзывы за квартал ───────────────────────────────────────────────────────
-- Три источника: сам сотрудник, коллега (по желанию) и руководитель.
CREATE TABLE IF NOT EXISTS reviews (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL REFERENCES users(id),   -- о ком отзыв
  author_id TEXT REFERENCES users(id),            -- кто написал
  kind      TEXT NOT NULL,                        -- self | peer | lead
  quarter   TEXT NOT NULL,                        -- 2026-Q3
  mark      TEXT,                                 -- предлагаемая оценка
  text      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, quarter);

-- ── Итог квартала ───────────────────────────────────────────────────────────
-- Оценку ставит руководитель, система предлагает её по проценту плана.
CREATE TABLE IF NOT EXISTS quarter_results (
  user_id       TEXT NOT NULL REFERENCES users(id),
  quarter       TEXT NOT NULL,
  plan_percent  REAL,        -- среднее закрытие плана по шести метрикам
  mark          TEXT,        -- итоговая оценка
  mark_auto     TEXT,        -- что предложила система
  grade         INTEGER,     -- грейд на момент расчёта
  salary_quarter INTEGER,    -- квартальная зарплата, от неё считается премия
  bonus_percent REAL,
  bonus_sum     INTEGER,
  note          TEXT,
  closed_at     TEXT,        -- когда квартал закрыт: после этого цифры не меняются
  PRIMARY KEY (user_id, quarter)
);

-- ── Грейд как число ─────────────────────────────────────────────────────────
-- Было A1/A2/A3, стало 1..7: матрица премирования завязана на числовой грейд.
ALTER TABLE users ADD COLUMN grade_num INTEGER NOT NULL DEFAULT 3;
UPDATE users SET grade_num = CASE grade
  WHEN 'A1' THEN 3
  WHEN 'A2' THEN 4
  WHEN 'A3' THEN 5
  ELSE 3 END;

-- ── Стартовые нормы ─────────────────────────────────────────────────────────
-- Рабочие часы (день — восемь). Это отправная точка, а не истина:
-- руководитель правит их в приложении, и с нового квартала действуют новые.
--   Time to start: простая — до обеда, обычная — полдня, сложная — день.
--   Time to fill:  простая — день, обычная — три дня, сложная — две недели.
INSERT OR IGNORE INTO sla (metric, level, hours, valid_from, note) VALUES
  ('t2s', 1, 2,  '2026-Q3', 'стартовая норма'),
  ('t2s', 2, 4,  '2026-Q3', 'стартовая норма'),
  ('t2s', 3, 8,  '2026-Q3', 'стартовая норма'),
  ('t2f', 1, 8,  '2026-Q3', 'стартовая норма'),
  ('t2f', 2, 24, '2026-Q3', 'стартовая норма'),
  ('t2f', 3, 80, '2026-Q3', 'стартовая норма');

-- С какого процента закрытия плана начинается «сверхплан» (оценка ++++).
INSERT INTO settings (key, value) VALUES ('overplan_percent', '120')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
