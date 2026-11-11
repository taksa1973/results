#!/bin/bash
# Обновление на сервере: архив upd.tgz (app stock public Dockerfile …) уже лежит в /opt/portu.
# Запуск: ssh serv_raboch bash /opt/portu/deploy/update.sh
set -e
cd /opt/portu
tar -xzf upd.tgz
rm -f upd.tgz
docker compose up -d --build 2>&1 | tail -3
sleep 4
docker logs --tail 4 portu 2>&1
curl -s -o /dev/null -w "local /portu/: %{http_code}\n" http://127.0.0.1:8095/portu/
curl -s -o /dev/null -w "public /portu/: %{http_code}\n" https://syferpu.top/portu/
