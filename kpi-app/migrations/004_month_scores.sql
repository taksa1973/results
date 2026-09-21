-- Ежемесячная оценка работы 0–10 и KPI руководителя отдела за месяц.
--
-- Оценка каждого считается автоматически из модели времени (процент плана
-- за месяц), а руководитель может поправить её руками: «Катя — 6, не больше».
-- KPI руководителя — среднее оценок всего отдела вместе с его собственной,
-- премия — доля от максимума (50 000 ₽ по умолчанию).
--
--   node migrations/004_apply.cjs   (sqlite3-клиента на сервере нет)

CREATE TABLE IF NOT EXISTS month_scores (
  user_id  TEXT NOT NULL REFERENCES users(id),
  period   TEXT NOT NULL,          -- 2026-09
  manual   REAL,                   -- оценка руками, 0–10; NULL — берётся автоматическая
  note     TEXT,                   -- за что
  actor    TEXT,                   -- кто поставил
  at       TEXT,
  PRIMARY KEY (user_id, period)
);

-- Максимальная месячная премия руководителя отдела, ₽
INSERT INTO settings (key, value) VALUES ('lead_kpi_max', '50000')
  ON CONFLICT(key) DO NOTHING;
