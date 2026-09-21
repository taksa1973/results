// Применение миграции 005 на сервере (sqlite3-клиента там нет).
//   cd /opt/kpi-app && node migrations/005_apply.cjs
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kpi.db'));
const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
if (cols.includes('project_no')) {
  console.log('project_no уже есть — пропускаю');
} else {
  db.exec(fs.readFileSync(path.join(__dirname, '005_task_links.sql'), 'utf8'));
  console.log('миграция 005 применена');
}
console.log('yougile_team:', db.prepare("SELECT value FROM settings WHERE key='yougile_team'").get());
db.close();
