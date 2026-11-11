#!/bin/bash
# Перерисовать всех персонажей из фото (например, после смены схемы сборки кадра).
# Ничего не удаляет: пока Grok рисует, у персонажа остаётся прежняя картинка.
docker exec portu python -c "
import sqlite3, time, uuid
c = sqlite3.connect('/data/portu.sqlite3')
rows = c.execute(\"SELECT id, name FROM characters WHERE kind='photo'\").fetchall()
for cid, name in rows:
    c.execute(\"DELETE FROM jobs WHERE char_id=? AND status IN ('pending','taken')\", (cid,))
    c.execute(\"INSERT INTO jobs(id,char_id,status,created_at) VALUES(?,?, 'pending', ?)\", (uuid.uuid4().hex, cid, int(time.time())))
    c.execute(\"UPDATE characters SET status='cartoon_pending', note=NULL WHERE id=?\", (cid,))
    print('в очереди:', name)
c.commit()
print('всего:', len(rows))
"
