// Применение миграции 006 на сервере (sqlite3-клиента там нет).
//   cd /opt/kpi-app && node migrations/006_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db'));
const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
if (cols.includes('acked_at')) {
  console.log('acked_at уже есть — пропускаю');
} else {
  db.exec(fs.readFileSync(path.join(__dirname, '006_acked.sql'), 'utf8'));
  console.log('миграция 006 применена');
}
console.log('sla:', db.prepare('SELECT metric, level, hours FROM sla ORDER BY metric, level').all());
console.log('column_acked:', db.prepare("SELECT value FROM settings WHERE key='column_acked'").get());
db.close();
