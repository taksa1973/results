-- Стадия «Принята»: три метрики вместо двух.
--
-- До принятия (норма — рабочий час), до старта (от принятия, 12 рабочих
-- часов) и в работе по уровням. Первые две без уровня: в sla они лежат
-- с level = 0. Старые нормы t2s по уровням больше не читаются.
--   node migrations/006_apply.cjs

ALTER TABLE tasks ADD COLUMN acked_at TEXT;
ALTER TABLE tasks ADD COLUMN t2a_hours REAL;

INSERT INTO settings (key, value) VALUES ('column_acked', '1a5a5ef8-cae1-47a0-84f3-581bc10a79f3')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

DELETE FROM sla WHERE metric = 't2s';
INSERT OR REPLACE INTO sla (metric, level, hours, valid_from, note) VALUES
  ('t2a', 0, 1,  '2026-Q3', 'принять в течение рабочего часа'),
  ('t2s', 0, 12, '2026-Q3', 'взять в работу в течение 12 рабочих часов');
