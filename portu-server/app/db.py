"""SQLite: один файл в /data, один глобальный замок — нагрузка у нас в единицы запросов."""
import json, os, sqlite3, threading, time
from . import config

_lock = threading.RLock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, pkey TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'A2');
CREATE TABLE IF NOT EXISTS sessions(
  th TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, ua TEXT);
CREATE TABLE IF NOT EXISTS state(
  user_id INTEGER PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS characters(
  id TEXT PRIMARY KEY, user_id INTEGER, name TEXT NOT NULL, kind TEXT NOT NULL,
  voice TEXT NOT NULL, persona TEXT NOT NULL DEFAULT '', img TEXT, img_talk TEXT,
  status TEXT NOT NULL DEFAULT 'ready', note TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 100);
CREATE TABLE IF NOT EXISTS calls(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, char_id TEXT NOT NULL, char_name TEXT NOT NULL,
  voice TEXT NOT NULL, topic TEXT NOT NULL, targets TEXT NOT NULL DEFAULT '[]',
  level TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  title TEXT, takeaway TEXT, rating TEXT, turns_n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS turns(
  id INTEGER PRIMARY KEY, call_id TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT NOT NULL,
  lang TEXT NOT NULL, text TEXT NOT NULL, segs TEXT, tr TEXT, tip TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS turns_call ON turns(call_id, idx);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, char_id TEXT NOT NULL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, taken_at INTEGER, done_at INTEGER, error TEXT);
"""


def conn():
    global _conn
    if _conn is None:
        os.makedirs(config.DATA, exist_ok=True)
        _conn = sqlite3.connect(os.path.join(config.DATA, "portu.sqlite3"), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        cols = {r[1] for r in _conn.execute("PRAGMA table_info(characters)")}
        if "img_av" not in cols:   # портрет для кружков (персонаж в звонке теперь в полный рост)
            _conn.execute("ALTER TABLE characters ADD COLUMN img_av TEXT")
            _conn.commit()
    return _conn


def q(sql, args=(), one=False):
    with _lock:
        cur = conn().execute(sql, args)
        rows = cur.fetchall()
    return (rows[0] if rows else None) if one else rows


def x(sql, args=()):
    with _lock:
        c = conn()
        cur = c.execute(sql, args)
        c.commit()
        return cur.lastrowid


def now():
    return int(time.time())


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))
