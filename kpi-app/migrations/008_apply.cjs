// Применение миграции 008 на сервере (sqlite3-клиента там нет).
//   cd /opt/kpi-app && node migrations/008_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db'));
db.exec(fs.readFileSync(path.join(__dirname, '008_weights.sql'), 'utf8'));
console.log('weights:', db.prepare("SELECT value FROM settings WHERE key='metric_weights'").get());
db.close();
