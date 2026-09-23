// Применение миграции 009 на сервере (sqlite3-клиента там нет).
//   cd /opt/kpi-app && node migrations/009_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db'));
db.exec(fs.readFileSync(path.join(__dirname, '009_from_created.sql'), 'utf8'));
console.log('weights:', db.prepare("SELECT value FROM settings WHERE key='metric_weights'").get());
console.log('sla:', db.prepare('SELECT metric, level, hours FROM sla ORDER BY metric, level').all());
db.close();
