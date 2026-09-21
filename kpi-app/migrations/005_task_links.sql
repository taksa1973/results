-- Ссылки на задачи в YouGile.
--
-- В адресной строке трекера — номер задачи в проекте (VSE-370), а в базе
-- хранился только общий (ID-452). Добавляем проектный номер и ссылку;
-- заполняются при следующей синхронизации.
--   node migrations/005_apply.cjs

ALTER TABLE tasks ADD COLUMN project_no TEXT;

INSERT INTO settings (key, value) VALUES ('yougile_team', 'ed881f3af637')
  ON CONFLICT(key) DO NOTHING;
