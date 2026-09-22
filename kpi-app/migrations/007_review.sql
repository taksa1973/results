-- Время на проверке — метрика проверяющего.
--
-- Копится отдельно от паузы и НЕ входит ни в одну оценку исполнителя:
-- на проверке работает руководитель. Нужно, чтобы очередь была видна:
-- сейчас задачи висят там неделями, и в метриках это никак не отражается.
--   node migrations/007_apply.cjs

ALTER TABLE tasks ADD COLUMN review_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN review_since TEXT;

INSERT INTO settings (key, value) VALUES ('review_norm_hours', '8')
  ON CONFLICT(key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('review_digest_hour', '10')
  ON CONFLICT(key) DO NOTHING;
