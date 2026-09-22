// Применение миграции 007 на сервере (sqlite3-клиента там нет).
//   cd /opt/kpi-app && node migrations/007_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db'));
const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
if (cols.includes('review_min')) {
  console.log('review_min уже есть — пропускаю');
} else {
  db.exec(fs.readFileSync(path.join(__dirname, '007_review.sql'), 'utf8'));
  console.log('миграция 007 применена');
}
console.log('norm:', db.prepare("SELECT value FROM settings WHERE key='review_norm_hours'").get());
db.close();
