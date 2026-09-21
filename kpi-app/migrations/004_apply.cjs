// Применение миграции 004 на сервере: sqlite3-клиента там нет,
// поэтому через better-sqlite3 из node_modules приложения.
//   cd /opt/kpi-app && node migrations/004_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db');
const db = new Database(dbPath);

const has = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='month_scores'").get().n;
if (has) {
  console.log('month_scores уже есть — пропускаю');
} else {
  db.exec(fs.readFileSync(path.join(__dirname, '004_month_scores.sql'), 'utf8'));
  console.log('миграция 004 применена');
}
console.log('lead_kpi_max:', db.prepare("SELECT value FROM settings WHERE key='lead_kpi_max'").get());
db.close();
