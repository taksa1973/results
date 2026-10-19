#!/usr/bin/env python3
"""
Выкладка карты страницы «Контакты» на сервер neoved (hooks.neoved.io/amo/neoved-kontakty/).

    SSH_PASSPHRASE=… python neoved-kontakty/deploy.py

Собирает kontakty.js из block.html, кладёт в /srv/amo/app/workers/neoved-kontakty/ воркер и скрипт,
пересобирает образ amo-server и поднимает контейнер (все воркеры перезапускаются на несколько
секунд), потом проверяет, что поднялись все прежние воркеры и новые адреса отвечают.
"""

import getpass
import json
import os
import posixpath
import sys
import time
import urllib.request
from pathlib import Path

import paramiko

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from importlib import import_module  # noqa: E402

embed = import_module('build-embed')

HOST, USER = '37.151.92.8', 'd-yarost'
KEY = str(Path.home() / '.ssh' / 'id_ed25519')
APP_DIR = '/srv/amo/app'
WORKER = 'neoved-kontakty'
REMOTE = posixpath.join(APP_DIR, 'workers', WORKER)
BASE = f'https://hooks.neoved.io/amo/{WORKER}'


def run(client, cmd, timeout=900):
    _, out, err = client.exec_command(cmd, timeout=timeout)
    text = out.read().decode('utf-8', 'replace') + err.read().decode('utf-8', 'replace')
    return out.channel.recv_exit_status(), text


def health(client):
    _, text = run(client, 'curl -s -m 10 http://127.0.0.1:8090/health', 30)
    try:
        return json.loads(text).get('workers', [])
    except ValueError:
        return []


def main():
    js, size = embed.build()
    print(f'Собран {js.name}: {size} байт')

    passphrase = os.environ.get('SSH_PASSPHRASE') or getpass.getpass('Пассфраза ключа: ')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=KEY, passphrase=passphrase, timeout=30)

    before = health(client)
    print('Воркеры до выкладки:', ', '.join(before) or '—')

    run(client, f'mkdir -p {REMOTE}')
    sftp = client.open_sftp()
    sftp.put(str(HERE / 'server' / 'worker.js'), f'{REMOTE}/worker.js')
    sftp.put(str(js), f'{REMOTE}/kontakty.js')
    sftp.close()
    print(f'Положено в {REMOTE}: worker.js, kontakty.js')

    print('Пересобираю образ и поднимаю контейнер…')
    code, text = run(client, f'cd {APP_DIR} && docker compose build && docker compose up -d')
    if code != 0:
        print(text[-3000:])
        sys.exit('docker compose завершился с ошибкой')

    after = []
    for _ in range(30):
        time.sleep(2)
        after = health(client)
        if after:
            break
    client.close()
    print('Воркеры после выкладки:', ', '.join(after) or '—')
    lost = [w for w in before if w not in after]
    if lost or WORKER not in after:
        sys.exit(f'Не поднялись: {", ".join(lost + ([] if WORKER in after else [WORKER]))}')

    for path in ('/health', '/kontakty.js'):
        req = urllib.request.Request(BASE + path, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f'   {r.status} {r.headers.get("Content-Type")} {len(r.read())} байт  {BASE + path}')

    print('\nГотово. Строка для Tilda (страница /kontakty, блок T123 «HTML-код»):')
    print(embed.EMBED_LINE)


if __name__ == '__main__':
    main()
