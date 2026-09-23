// Применение миграции 010 на сервере (sqlite3-клиента там нет).
//   cd /opt/kpi-app && node migrations/010_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db'));
const before = db.prepare('SELECT count(*) AS n FROM tasks').get().n;
db.exec(fs.readFileSync(path.join(__dirname, '010_board_cap.sql'), 'utf8'));
const after = db.prepare('SELECT count(*) AS n FROM tasks').get().n;
console.log(`задач было ${before}, стало ${after} — удалено чужих: ${before - after}`);
console.log(db.prepare("SELECT key, value FROM settings WHERE key IN ('percent_cap','metric_weights','column_review','column_backlog')").all());
db.close();
