#!/usr/bin/env python3
"""
Заливка воркера amo-transcript на рабочий сервер neoved.

    python deploy.py                 залить, пересобрать образ, подписать вебхук
    python deploy.py --no-build      только положить файлы на сервер
    python deploy.py --skip-hook     без подписки на вебхук amoCRM

Код и .env лежат ВНУТРИ образа, поэтому правка файлов на сервере сама по себе
ничего не меняет: чтобы изменения заработали, образ нужно пересобрать. Так что
--no-build годится только для «положить и собрать потом».

Почему paramiko, а не ssh/scp: ключ закрыт пассфразой, а BatchMode с ней не
проходит — агента на этой машине нет. Пассфраза лежит в SSH_PASSPHRASE или
спрашивается при запуске.

Что происходит на сервере: файлы кладутся в /srv/amo/app/workers/amo-transcript/,
после чего пересобирается образ amo-server (код внутри образа, не в bind-mount
— docker там rootless) и контейнер поднимается заново. Данные KV лежат в
именованном томе и пересборку переживают.
"""

import getpass
import json
import os
import posixpath
import sys
import urllib.error
import urllib.request
from pathlib import Path

import paramiko

HOST = "37.151.92.8"
USER = "d-yarost"
KEY = str(Path.home() / ".ssh" / "id_ed25519")

APP_DIR = "/srv/amo/app"
WORKER = "amo-transcript"
REMOTE_DIR = posixpath.join(APP_DIR, "workers", WORKER)
BASE_URL = "https://hooks.neoved.io/amo"

HERE = Path(__file__).resolve().parent
FILES = ["worker.js", ".env", "README.md"]

no_build = "--no-build" in sys.argv
skip_hook = "--skip-hook" in sys.argv


def read_env(path: Path) -> dict:
    """.env пишется руками: с комментариями, пустыми строками и кавычками."""
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not key or not key[0].isalpha():
            continue
        if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def run(client, command, quiet=False):
    _, out, err = client.exec_command(command, timeout=600)
    text = out.read().decode("utf-8", "replace")
    code = out.channel.recv_exit_status()
    error = err.read().decode("utf-8", "replace")
    if not quiet:
        for line in (text + error).splitlines():
            print(f"   {line}")
    return code, text + error


def main():
    env = read_env(HERE / ".env")
    if not env:
        sys.exit("Нет .env — скопируй .env.example и заполни")

    missing = [k for k in ("AMO_SUBDOMAIN", "AMO_TOKEN", "HOOK_SECRET") if not env.get(k)]
    if missing:
        sys.exit(f"В .env не заполнено: {', '.join(missing)}")

    for name in FILES:
        if not (HERE / name).exists():
            sys.exit(f"Нет файла {name}")

    passphrase = os.environ.get("SSH_PASSPHRASE") or getpass.getpass("Пассфраза ключа: ")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Подключаюсь к {USER}@{HOST}…")
    client.connect(HOST, username=USER, key_filename=KEY, passphrase=passphrase, timeout=30)

    print(f"Кладу файлы в {REMOTE_DIR}")
    run(client, f"mkdir -p {REMOTE_DIR}", quiet=True)
    sftp = client.open_sftp()
    for name in FILES:
        sftp.put(str(HERE / name), posixpath.join(REMOTE_DIR, name))
        print(f"   {name}")
    # .env виден всей группе проекта — снимаем лишние права.
    sftp.chmod(posixpath.join(REMOTE_DIR, ".env"), 0o640)
    sftp.close()

    if no_build:
        print("Образ не трогаю (--no-build): файлы лежат на сервере, но контейнер")
        print("работает со старым кодом — изменения войдут в силу после пересборки.")
    else:
        print("Пересобираю образ и поднимаю контейнер…")
        code, _ = run(client, f"cd {APP_DIR} && docker compose build && docker compose up -d")
        if code != 0:
            client.close()
            sys.exit("docker compose завершился с ошибкой")

        print("Проверяю, что воркер поднялся…")
        code, text = run(client, f"curl -s -m 15 {BASE_URL}/{WORKER}/health", quiet=True)
        print(f"   {text.strip()}")
        code, text = run(client, f"curl -s -m 15 {BASE_URL}/", quiet=True)
        print(f"   {text.strip()}")

    client.close()

    if not skip_hook:
        subscribe_webhook(env)

    hook = f"{BASE_URL}/{WORKER}/amo/{env['HOOK_SECRET']}"
    print("\nГотово.")
    print(f"  здоровье : {BASE_URL}/{WORKER}/health")
    print(f"  журнал   : {BASE_URL}/{WORKER}/debug/{env['HOOK_SECRET']}")
    print(f"  прогон   : {BASE_URL}/{WORKER}/replay/{env['HOOK_SECRET']}?note_id=<id>&entity=contacts")
    print(f"  вебхук   : {hook}")


def subscribe_webhook(env):
    """
    Подписка на note_contact + note_lead: файл с расшифровкой Телфин кладёт
    на контакт, но на случай смены поведения слушаем и сделки.

    Вопреки документации («вебхук с тем же адресом будет обновлён»), этот
    аккаунт на повторный POST того же destination отвечает 400 «Invalid URL».
    Поэтому сначала смотрим список и подписываемся, только если нашего там нет.
    """
    hook = f"{BASE_URL}/{WORKER}/amo/{env['HOOK_SECRET']}"
    api = f"https://{env['AMO_SUBDOMAIN']}.amocrm.ru/api/v4/webhooks"
    headers = {
        "Authorization": f"Bearer {env['AMO_TOKEN']}",
        "Content-Type": "application/json",
    }

    print("\nПроверяю вебхук в amoCRM…")
    try:
        req = urllib.request.Request(api, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as res:
            body = json.loads(res.read().decode("utf-8") or "{}")
        existing = [w for w in body.get("_embedded", {}).get("webhooks", [])
                    if w.get("destination") == hook]
    except urllib.error.HTTPError as e:
        print(f"   список вебхуков не отдался ({e.code}) — проверь вручную")
        return
    except Exception as e:                                   # сеть, TLS, таймаут
        print(f"   не дозвонился до amoCRM ({e}) — проверь вручную")
        return

    if existing:
        print(f"   уже подписан: {', '.join(existing[0].get('settings', []))}")
        return

    payload = json.dumps({"destination": hook, "settings": ["note_contact", "note_lead"]}).encode("utf-8")
    try:
        req = urllib.request.Request(api, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as res:
            res.read()
        print(f"   подписан на note_contact, note_lead: {hook}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        print(f"   amoCRM ответила {e.code}: {detail}")
        print("   бывает ложный «400 Invalid URL» — повтори запуск через минуту")


if __name__ == "__main__":
    main()
