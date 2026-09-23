-- Только доска отдела, низкий потолок перевыполнения, новые веса.
--
-- Три правки одной причины — KPI показывал 104 % там, где задачи висят
-- неделями:
--   1. Потолок процента снижен с 200 до 120: обгон нормы вдвое перекрывал
--      провал в 3 % от нормы.
--   2. Выполнение считается по когорте месяца (из взятых в этом месяце
--      сколько сдано), иначе «взял одну, сдал три старых» давало 200 %.
--   3. Задачи с чужих досок в расчёт не идут: YouGile отдаёт задачи всей
--      команды, доска узнаётся по колонке.
--   node migrations/010_apply.cjs

INSERT INTO settings (key, value) VALUES ('percent_cap', '120')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
INSERT INTO settings (key, value) VALUES ('metric_weights', 'work:50,done:20,t2s:20,quality:10')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- колонки доски «Задачи ассистентов»
INSERT INTO settings (key, value) VALUES ('board_columns',
  '3b698e71-7a66-4806-a376-92c9890d5d9b,1a5a5ef8-cae1-47a0-84f3-581bc10a79f3,2c8c024a-c0c5-4a6b-b092-7cb284e6427a,6402f460-bf23-4ed5-a0d9-ce618332af2e,c5952427-f95b-4b20-87a1-3dbd800f051a,906ca640-b92e-4458-864c-b1e2fc596b4f,8f532219-77c1-46f1-9700-f00be782255d,66b5d0b0-fa13-4026-8c30-0749a01fe3f5,a481b53b-fa5b-4596-b43b-0fd10a04c075,1e0a69b2-b008-419b-89dd-0b0a3ccb6730,c6a58d41-8ef3-4146-bac8-0478c2c6a0ed')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- колонки чужой доски убираем из стадий
INSERT INTO settings (key, value) VALUES ('column_backlog', '3b698e71-7a66-4806-a376-92c9890d5d9b')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
INSERT INTO settings (key, value) VALUES ('column_review', '8f532219-77c1-46f1-9700-f00be782255d')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- и вычищаем уже сохранённые чужие задачи
DELETE FROM tasks WHERE column_id IS NOT NULL AND column_id NOT IN (
  '3b698e71-7a66-4806-a376-92c9890d5d9b','1a5a5ef8-cae1-47a0-84f3-581bc10a79f3',
  '2c8c024a-c0c5-4a6b-b092-7cb284e6427a','6402f460-bf23-4ed5-a0d9-ce618332af2e',
  'c5952427-f95b-4b20-87a1-3dbd800f051a','906ca640-b92e-4458-864c-b1e2fc596b4f',
  '8f532219-77c1-46f1-9700-f00be782255d','66b5d0b0-fa13-4026-8c30-0749a01fe3f5',
  'a481b53b-fa5b-4596-b43b-0fd10a04c075','1e0a69b2-b008-419b-89dd-0b0a3ccb6730',
  'c6a58d41-8ef3-4146-bac8-0478c2c6a0ed');
