-- KPI отдела ассистентов. Cloudflare D1.
-- Применить: npx wrangler d1 execute kpi --file=schema.sql --remote

DROP TABLE IF EXISTS quarter_results;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS bonus_matrix;
DROP TABLE IF EXISTS sla;
DROP TABLE IF EXISTS chat_replies;
DROP TABLE IF EXISTS awards;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS settings;

-- ── Люди ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('assistant','lead','chief')),
  grade        TEXT NOT NULL DEFAULT 'A2',   -- A1 / A2 / A3
  key_hash     TEXT,                          -- sha256 ключа доступа
  yougile_id   TEXT,                          -- id пользователя в YouGile
  tg_user_id   TEXT,                          -- id в Telegram, для замера ответов
  tg_username  TEXT,                          -- ник: по нему человека заводят
                                              -- до первого сообщения, id придёт позже
  salary       INTEGER NOT NULL DEFAULT 0,    -- оклад, для итоговой сводки
  grade_num    INTEGER NOT NULL DEFAULT 3,    -- грейд 1..7, от него процент премии
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_key ON users(key_hash);
CREATE INDEX idx_users_yg  ON users(yougile_id);
CREATE INDEX idx_users_tg  ON users(tg_user_id);
CREATE INDEX idx_users_nick ON users(tg_username);

-- ── Задачи ──────────────────────────────────────────────────────────────────
-- Тайминги хранятся как ISO-строки UTC. Всё, что можно вывести, выводится
-- на лету — в базе только факты с отметками времени.
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,          -- id задачи в YouGile
  title             TEXT NOT NULL,
  number            TEXT,                      -- человекочитаемый номер, ID-236
  url               TEXT,
  board_id          TEXT,
  column_id         TEXT,
  keywords          TEXT,                      -- поисковый индекс: считается один раз
                                               -- при появлении задачи, дальше не трогается
  assignee_id       TEXT REFERENCES users(id),
  author_id         TEXT,                      -- кто завёл: если ассистент — инициатива
  -- Вес со стикера «Размер задачи»: S=1, M=2, L=3, XL=5
  size              INTEGER NOT NULL DEFAULT 1 CHECK (size IN (1,2,3,5)),
  night             INTEGER NOT NULL DEFAULT 0,-- ночь/выходной/форс-мажор → размер ×1.5

  created_at        TEXT,                      -- поставлена
  taken_at          TEXT,                      -- взята в работу (первый переход в «В работе»)
  submitted_at      TEXT,                      -- отправлена на проверку
  done_at           TEXT,                      -- принята окончательно
  deadline          TEXT,

  -- Момент, когда ассистент сделал свою часть. Отличается от done_at там,
  -- где результат приходит извне: заказ уехал в США, работа сдана, а карточка
  -- закроется через месяцы, когда посылка доедет. Срок меряется по этой дате.
  work_done_at      TEXT,
  work_done_kind    TEXT,                      -- submitted | handed_off | accepted
  priority          INTEGER,                   -- снимок приоритета на момент назначения

  -- Время в «Блокере» и «В ожидании» не идёт против ассистента:
  -- он не виноват, что ждали ответа третьей стороны.
  paused_min        INTEGER NOT NULL DEFAULT 0,
  paused_since      TEXT,

  returns           INTEGER NOT NULL DEFAULT 0,-- сколько раз вернули из «На проверке»
  chief_touched     INTEGER NOT NULL DEFAULT 0,-- руководитель писал в карточке до закрытия
  is_initiative     INTEGER NOT NULL DEFAULT 0,
  -- Задача из колонки «Заёб». В KPI не участвует вообще: ни время,
  -- ни качество, ни автономность. Приносит только приз тому, кто закрыл.
  is_zaeb           INTEGER NOT NULL DEFAULT 0,
  zaeb_awarded      INTEGER NOT NULL DEFAULT 0,
  initiative_useful INTEGER,                   -- NULL — не отвечено, 1/0 — ответ руководителя

  status            TEXT NOT NULL DEFAULT 'open',
                    -- open | in_progress | review | accepted | returned | failed
  disputed          INTEGER NOT NULL DEFAULT 0,-- лид списал признак как «вопрос по делу»
  dispute_note      TEXT,
  period            TEXT,                      -- YYYY-MM, проставляется при закрытии

  -- Модель времени. Уровень сложности 1/2/3: со стикера размера, от модели
  -- по заголовку или поправленный руками. Часы считаются при синхронизации.
  level             INTEGER,
  level_src         TEXT,                      -- sticker | model | manual | default
  t2s_hours         REAL,                      -- Time to start: до взятия в работу
  t2f_hours         REAL,                      -- Time to fill: до сдачи работы
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_user   ON tasks(assignee_id);
CREATE INDEX idx_tasks_period ON tasks(period);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ── Модель времени: нормы, матрица премий, отзывы, итоги кварталов ─────────
-- Плановые значения. Пересматриваются раз в квартал, история сохраняется:
-- старые кварталы считаются по нормам, действовавшим тогда.
CREATE TABLE sla (
  metric     TEXT NOT NULL,          -- t2s | t2f
  level      INTEGER NOT NULL,       -- 1 | 2 | 3
  hours      REAL NOT NULL,          -- рабочих часов
  valid_from TEXT NOT NULL,          -- квартал: 2026-Q3
  note       TEXT,
  PRIMARY KEY (metric, level, valid_from)
);

-- Процент премии от квартальной зарплаты: грейд × итоговая оценка.
CREATE TABLE bonus_matrix (
  grade   INTEGER NOT NULL,          -- 1..7
  mark    TEXT NOT NULL,             -- minus | plusminus | plus | plus2 | plus3 | plus4
  percent REAL NOT NULL,
  PRIMARY KEY (grade, mark)
);

-- Отзывы за квартал: сам о себе, коллега по желанию, руководитель.
CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id),
  author_id  TEXT REFERENCES users(id),
  kind       TEXT NOT NULL,          -- self | peer | lead
  quarter    TEXT NOT NULL,
  mark       TEXT,
  text       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reviews_user ON reviews(user_id, quarter);

-- Итог квартала: оценка руководителя и посчитанная премия. После закрытия
-- цифры заморожены.
CREATE TABLE quarter_results (
  user_id        TEXT NOT NULL REFERENCES users(id),
  quarter        TEXT NOT NULL,
  plan_percent   REAL,
  mark           TEXT,
  mark_auto      TEXT,
  grade          INTEGER,
  salary_quarter INTEGER,
  bonus_percent  REAL,
  bonus_sum      INTEGER,
  note           TEXT,
  closed_at      TEXT,
  PRIMARY KEY (user_id, quarter)
);

-- ── Лог событий: на нём держится вся прозрачность ────────────────────────────
-- Любую цифру в отчёте можно развернуть до списка событий с временем и автором.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT,
  user_id  TEXT,
  type     TEXT NOT NULL,   -- created|taken|submitted|returned|accepted|chief_message|initiative_answer|manual
  actor    TEXT,            -- кто вызвал событие
  at       TEXT NOT NULL,
  note     TEXT,
  source   TEXT NOT NULL DEFAULT 'yougile' -- yougile | telegram | manual
);
CREATE INDEX idx_events_task ON events(task_id);
CREATE INDEX idx_events_user ON events(user_id, at);

-- ── Скорость ответа в общем чате Telegram ───────────────────────────────────
CREATE TABLE chat_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT REFERENCES users(id),
  chat_id      TEXT,
  request_msg  TEXT,     -- id сообщения-запроса
  reply_msg    TEXT,
  asked_by     TEXT,     -- кто спросил: id руководителя или лида
  asked_role   TEXT,     -- chief | lead — от этого зависит, кто может ответить
  asked_at     TEXT NOT NULL,
  replied_at   TEXT,
  seconds      INTEGER,  -- NULL — остался без ответа
  in_hours     INTEGER NOT NULL DEFAULT 1, -- попало ли в рабочее окно
  urgent       INTEGER NOT NULL DEFAULT 0, -- помечено как срочное
  escalated    INTEGER NOT NULL DEFAULT 0, -- бот уже напоминал
  mention_id   TEXT,     -- если обращались к конкретному человеку
  mention_raw  TEXT,     -- кого тегнули в тексте, даже если его нет в системе:
                         -- такой вопрос не должен штрафовать посторонних
  no_reply_needed INTEGER NOT NULL DEFAULT 0, -- «понял, спасибо» — таймер не в счёт
  period       TEXT NOT NULL
);
CREATE INDEX idx_chat_user ON chat_replies(user_id, period);

-- Состояние переписки: нужно, чтобы отличить новый вопрос от продолжения
-- разговора. Пока диалог идёт, новые таймеры не открываются — иначе за одну
-- живую беседу можно набрать десяток «быстрых ответов».
CREATE TABLE chat_state (
  chat_id     TEXT PRIMARY KEY,
  last_msg_at TEXT,
  last_from   TEXT
);

-- ── Призы за заёбы и экономия ───────────────────────────────────────────────
CREATE TABLE awards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT REFERENCES users(id),
  kind         TEXT NOT NULL,       -- zaeb | saving
  title        TEXT NOT NULL,
  tier         TEXT,                -- S | M | L | XL, для заёбов
  amount       INTEGER NOT NULL DEFAULT 0, -- сотруднику
  lead_amount  INTEGER NOT NULL DEFAULT 0, -- доля лида
  base_price   INTEGER,             -- для экономии: цена до переговоров
  final_price  INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | half_paid | confirmed | rejected
  period       TEXT NOT NULL,
  proof_url    TEXT,                -- скриншот базовой цены
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  confirm_due  TEXT,                -- когда спросить «не всплывало?»
  confirmed_at TEXT
);
CREATE INDEX idx_awards_user ON awards(user_id, period);

-- ── Коэффициент за помощь ───────────────────────────────────────────────────
-- Ставится вручную владельцем: кнопками по шагу или прямым вводом.
-- Умножает всю премию человека и работает в обе стороны — меньше единицы
-- тоже допустимо. Одна запись на человека за период.
CREATE TABLE help_marks (
  user_id TEXT NOT NULL REFERENCES users(id),
  period  TEXT NOT NULL,
  value   REAL NOT NULL DEFAULT 1,
  note    TEXT,
  actor   TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, period)
);

-- ── Настройки: всё, что можно подкрутить без правки кода ────────────────────
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  -- Премия ассистента — 30 000. Проактивность убрана: все задачи заводит
  -- руководитель отдела, поэтому «инициативу ассистента» нечем измерить.
  --
  -- Приоритет расставлен так: главное — сделать хорошо, второе — сделать
  -- самому, и только третье — быстро. Скорость намеренно самая маленькая:
  -- она про отзывчивость в чате, а не про результат работы.
  ('bonus_pool',        '30000'),
  ('purse_quality',     '17500'),   -- 58 %
  ('purse_autonomy',    '10000'),   -- 33 %
  ('purse_speed',       '2500'),    --  9 %
  -- Премия руководителя отдела — 50 000. Считается от результата команды,
  -- поэтому чужая просрочка бьёт и по его доходу тоже.
  ('lead_pool',           '50000'),
  ('lead_purse_team',     '20000'), -- средний результат ассистентов
  ('lead_purse_quality',  '15000'), -- качество его собственных задач
  ('lead_purse_autonomy', '8000'),  -- самостоятельность его задач
  ('lead_purse_speed',    '7000'),  -- своя скорость 0.4 + командная 0.6
  ('lead_share_zaeb',   '0.10'),
  ('lead_share_saving', '0.05'),
  ('saving_rate_1',     '0.30'),
  ('saving_rate_2',     '0.20'),
  ('saving_rate_3',     '0.10'),
  ('reply_target_min',  '15'),
  -- Доля задач со сроком, начиная с которой срок вообще учитывается.
  -- Если сроки почти не проставляют, скорость меряется по одной реакции:
  -- иначе человек теряет полкошелька за то, как оформлены чужие задачи.
  ('sla_min_coverage',  '0.3'),
  ('work_start',        '09:00'),
  ('work_end',          '22:00'),
  ('tz_offset',         '3'),
  -- Баллы за ответы. Своевременный ответ — норма, поэтому даёт немного;
  -- молчание стоит восьми таких ответов. Оценка считается как доля
  -- от максимально возможного, потолок 10, ниже нуля не опускается.
  ('pt_fast',           '0.5'),  -- ответил в срок: это ожидаемое поведение
  ('pt_slow',           '-2'),   -- ответил, но позже нормы
  ('pt_offhours',       '1'),    -- ответ в выходной или после работы: не был обязан
  ('pt_miss',           '-4'),   -- не ответил вовсе
  ('miss_after_min',    '60'),   -- запрос без ответа дольше этого = пропуск
  ('miss_night_hours',  '12'),   -- ночной запрос, не разгребённый к утру
  ('escalate_after_min','30'),   -- через сколько бот напомнит в чат
  ('streak_bonus',      '2000'), -- месяц без единого пропуска
  ('urgent_target_min', '5'),    -- норма ответа на срочное
  ('urgent_words',      'срочно,asap,горит,срочное'),
  -- Сообщения, на которые отвечать не нужно: таймер не открывается
  ('no_reply_words',    'спасибо,спс,благодарю,понял,поняла,понятно,ясно,ок,окей,ok,хорошо,отлично,супер,класс,круто,принято,ага,угу,да,нет,плюс'),
  ('min_request_len',   '25'),   -- короткая реплика без вопроса — не запрос
  -- Дата запуска. Всё, что закрыто раньше, в расчёт не идёт: по старым
  -- задачам нет ни признаков приёмки, ни переписки. Проставляется один раз.
  ('start_from',        ''),
  -- Живой диалог не должен превращаться в десяток «быстрых ответов»:
  -- пока переписка идёт, новый таймер не открывается
  ('dialog_window_min', '20'),
  -- Распознавание задачи по сообщению
  ('llm_enabled',       '1'),
  ('llm_url',           'http://127.0.0.1:11434/api/generate'),
  ('llm_model',         'qwen3:8b'),
  ('llm_timeout_ms',    '45000'),
  ('llm_confidence',    '1.35'), -- отрыв лидера, при котором модель не нужна
  -- Скорость руководителя отдела: своя и командная
  ('lead_speed_personal','0.4'),
  ('lead_speed_team',    '0.6'),
  ('duty_user_id',      ''),     -- кто на дежурстве вне рабочего окна
  ('duty_shift_pay',    '1500'), -- доплата за смену выходного дня
  ('norm_autonomy_A1',  '0.60'),
  ('norm_autonomy_A2',  '0.85'),
  ('norm_autonomy_A3',  '0.95'),
  ('norm_proactivity',  '4'),
  ('cut_threshold',     '5'),
  ('cut_factor',        '0.85'),
  -- Отметки помощи от владельца. Каждая поднимает премию на help_step,
  -- но не выше help_max. Ставятся в течение месяца, а не одной оценкой
  -- в конце: так видно, за что именно человек получил надбавку.
  -- Коэффициент помощи: шаг кнопок и границы ручного ввода
  ('help_step',         '0.1'),
  ('help_min',          '0.5'),
  ('help_max',          '2'),
  ('yougile_key',       ''),     -- задаётся секретом, в базу не пишется
  ('yougile_base',      'https://yougile.com/api-v2'),
  -- Колонки обеих рабочих досок: «Задачи ассистентов» и «Задачи Дмитрия».
  -- Списки через запятую — пайплайн у досок одинаковый.
  ('column_backlog',    '3b698e71-7a66-4806-a376-92c9890d5d9b,d79b6ea6-4a90-4f4f-b13b-df6fa0407e5d'),
  ('column_in_progress','2c8c024a-c0c5-4a6b-b092-7cb284e6427a,c45a6d3a-00e8-4a4b-8408-3fe0f90a5e0b'),
  ('column_review',     '8f532219-77c1-46f1-9700-f00be782255d,1589ae19-d477-490b-be8d-02320753a45b'),
  -- Закрыта по-настоящему: только «Завершена». Задача считается сделанной
  -- лишь тогда, когда она решена, а не отложена.
  ('column_done',       '1e0a69b2-b008-419b-89dd-0b0a3ccb6730,f0c8d7f5-82bd-43bd-a570-d0b7d8ecae27'),
  -- «Блокер»: работа стоит не по вине исполнителя. Часы на паузе,
  -- но задача НЕ считается сданной — иначе блокером можно было бы
  -- останавливать срок, не сделав ничего.
  ('column_blocked',    '6402f460-bf23-4ed5-a0d9-ce618332af2e'),
  -- «В ожидании» и «Гаджеты»: работа ассистента сделана, ждём внешний
  -- результат — доставку, ответ поставщика, согласование. Часы стоят
  -- И задача засчитывается сданной: заказ гаджета оценивается в месяц
  -- заказа, а не когда посылка доехала.
  ('column_waiting',    '906ca640-b92e-4458-864c-b1e2fc596b4f,0a9692b2-d12d-4923-9208-e2b044be5a88,c5952427-f95b-4b20-87a1-3dbd800f051a'),
  -- Оба списка вместе — для обратной совместимости расчёта паузы
  ('column_paused',     '6402f460-bf23-4ed5-a0d9-ce618332af2e,906ca640-b92e-4458-864c-b1e2fc596b4f,0a9692b2-d12d-4923-9208-e2b044be5a88,c5952427-f95b-4b20-87a1-3dbd800f051a'),
  -- Отложена: «На контроле» и «На потом». Из расчёта выпадает целиком,
  -- пока не будет решена и переведена в «Завершена».
  ('column_shelved',    '66b5d0b0-fa13-4026-8c30-0749a01fe3f5,958095f6-790b-49c8-9f35-a6368017b0af,a481b53b-fa5b-4596-b43b-0fd10a04c075'),
  -- Задача снята совсем
  ('column_cancelled',  '8462a7c2-4af8-4003-99be-113f0a4bf91a'),
  -- Реестр заёбов уже существует отдельной колонкой
  ('column_zaeb',       'c6a58d41-8ef3-4146-bac8-0478c2c6a0ed'),

  -- Стикеры YouGile. Оба уже заведены на доске, их значения читаются
  -- напрямую — заводить ничего не нужно.
  --
  -- «Приоритет» — это срок в РАБОЧИХ днях от постановки задачи:
  --   1  — в течение дня или в первый рабочий день после выходных
  --   3  — в течение двух-трёх рабочих дней
  --   7  — в течение недели
  --   30 — в течение месяца
  ('sticker_priority',  '0681807e-900b-47b6-8880-624802294bb0'),
  ('priority_states',   'ffd115a98702=1,e0051cdabb08=3,e6257641af72=7,4a0515f61bb0=30'),
  -- Срок по умолчанию, если приоритет не проставлен
  ('priority_default',  '7'),

  -- «Размер задачи» — вес в оценке качества
  ('sticker_size',      '19000680-c793-45ee-9061-4d8251343c4a'),
  ('size_states',       '9dd99e96c71c=1,0b2e97716e0e=2,b6e9a764ce20=3,d036c20324cb=5'),
  ('size_default',      '1'),
  ('tg_chat_id',        '');

-- ── Стартовые данные модели времени ─────────────────────────────────────────
-- С какого процента закрытия плана начинается «сверхплан» (оценка ++++).
INSERT INTO settings (key, value) VALUES ('overplan_percent', '120');

-- Матрица премий. Грейды 1 и 2 премии не дают.
INSERT INTO bonus_matrix (grade, mark, percent) VALUES
  (7,'minus',0), (7,'plusminus',9), (7,'plus',18), (7,'plus2',20), (7,'plus3',27), (7,'plus4',36),
  (6,'minus',0), (6,'plusminus',8), (6,'plus',16), (6,'plus2',18), (6,'plus3',24), (6,'plus4',32),
  (5,'minus',0), (5,'plusminus',7), (5,'plus',14), (5,'plus2',16), (5,'plus3',20), (5,'plus4',28),
  (4,'minus',0), (4,'plusminus',6), (4,'plus',12), (4,'plus2',14), (4,'plus3',18), (4,'plus4',24),
  (3,'minus',0), (3,'plusminus',5), (3,'plus',10), (3,'plus2',12), (3,'plus3',15), (3,'plus4',20),
  (2,'minus',0), (2,'plusminus',0), (2,'plus',0),  (2,'plus2',0),  (2,'plus3',0),  (2,'plus4',0),
  (1,'minus',0), (1,'plusminus',0), (1,'plus',0),  (1,'plus2',0),  (1,'plus3',0),  (1,'plus4',0);

-- Стартовые нормы в рабочих часах (день — восемь). Отправная точка,
-- руководитель правит их в приложении.
INSERT INTO sla (metric, level, hours, valid_from, note) VALUES
  ('t2s', 1, 2,  '2026-Q3', 'стартовая норма'),
  ('t2s', 2, 4,  '2026-Q3', 'стартовая норма'),
  ('t2s', 3, 8,  '2026-Q3', 'стартовая норма'),
  ('t2f', 1, 8,  '2026-Q3', 'стартовая норма'),
  ('t2f', 2, 24, '2026-Q3', 'стартовая норма'),
  ('t2f', 3, 80, '2026-Q3', 'стартовая норма');
