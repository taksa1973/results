#!/bin/bash
# Включить и проверить службу обработчика фото на сервере.
systemctl enable --now portu-grok-worker 2>&1 | tail -1
sleep 5
systemctl is-active portu-grok-worker
journalctl -u portu-grok-worker -n 5 --no-pager -o cat
tail -3 /home/portugrok/portu-work/worker.log 2>/dev/null
rm -rf /home/portugrok/portu-work/test
