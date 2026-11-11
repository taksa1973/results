#!/bin/bash
# Обработчик фото → мультяшный персонаж прямо на сервере (без ПК anton).
# Работает под отдельным пользователем portugrok без sudo: агент Grok в режиме --yolo
# может выполнять команды, root ему не нужен.
# Сам Grok CLI ставится отдельно, официальным установщиком xAI от имени portugrok,
# и вход — тоже отдельно: grok login --device-auth.
# Запуск: ssh serv_raboch bash /opt/portu/deploy/setup_grok_worker.sh
set -e
U=portugrok
id -u $U >/dev/null 2>&1 || useradd --create-home --shell /bin/bash $U
H=/home/$U

# Python для склейки рта (Pillow + numpy) — в своём venv
if [ ! -x $H/venv/bin/python ]; then
  su - $U -c 'python3 -m venv $HOME/venv && $HOME/venv/bin/pip install -q pillow numpy'
fi

# настройки обработчика: ходит в API напрямую, мимо Caddy
TOKEN=$(grep '^WORKER_TOKEN=' /opt/portu/.env | cut -d= -f2-)
cat > $H/worker.env <<EOF
PORTU_URL=http://127.0.0.1:8095/portu
WORKER_TOKEN=$TOKEN
PORTU_WORK=$H/portu-work
GROK_BIN=$H/.grok/bin/grok
EOF
chown $U:$U $H/worker.env && chmod 600 $H/worker.env

cat > /etc/systemd/system/portu-grok-worker.service <<EOF
[Unit]
Description=Portu: мультяшные персонажи из фото через Grok CLI
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$U
WorkingDirectory=$H
Environment=PORTU_ENV=$H/worker.env
Environment=PYTHONIOENCODING=utf-8
ExecStart=$H/venv/bin/python /opt/portu/worker/grok_worker.py
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

if [ -x $H/.grok/bin/grok ]; then
  su - $U -c '$HOME/.grok/bin/grok --version'
else
  echo "Grok CLI для $U ещё не установлен"
fi
echo "служба portu-grok-worker записана; включается после установки Grok и входа"
