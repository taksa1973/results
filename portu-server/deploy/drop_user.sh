#!/bin/bash
# Удалить профиль целиком (прогресс, звонки, своих персонажей). Использование: bash drop_user.sh <id>
set -e
ID="$1"
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "нужен числовой id"; exit 1; }
docker exec portu python -c "
import sqlite3, os, glob
c = sqlite3.connect('/data/portu.sqlite3')
uid = $ID
chars = [r[0] for r in c.execute('SELECT id FROM characters WHERE user_id=?', (uid,))]
for cid in chars:
    for f in glob.glob('/data/chars/' + cid + '*'): os.remove(f)
    c.execute('DELETE FROM jobs WHERE char_id=?', (cid,))
c.execute('DELETE FROM characters WHERE user_id=?', (uid,))
calls = [r[0] for r in c.execute('SELECT id FROM calls WHERE user_id=?', (uid,))]
for k in calls: c.execute('DELETE FROM turns WHERE call_id=?', (k,))
c.execute('DELETE FROM calls WHERE user_id=?', (uid,))
for t in ('sessions', 'state'): c.execute('DELETE FROM ' + t + ' WHERE user_id=?', (uid,))
c.execute('DELETE FROM users WHERE id=?', (uid,))
c.commit()
print('удалён профиль', uid, '| персонажей', len(chars), '| звонков', len(calls))
print('осталось профилей:', c.execute('SELECT COUNT(*) FROM users').fetchone()[0])
"
