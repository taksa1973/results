#!/usr/bin/env python3
"""
Заливка воркера neoved-chat на рабочий сервер neoved.

    python deploy_vps.py                залить, пересобрать образ, проверить
    python deploy_vps.py --no-build     только положить файлы на сервер

Код и .env лежат ВНУТРИ образа, поэтому правка файлов на сервере сама по себе
ничего не меняет: чтобы изменения заработали, образ нужно пересобрать.

Почему paramiko, а не ssh/scp: ключ закрыт пассфразой, а BatchMode с ней не
проходит — агента на этой машине нет. Пассфраза лежит в SSH_PASSPHRASE или
спрашивается при запуске.

Про widget.js. На Cloudflare он заливался текстовым модулем (`type=text/plain`)
и приходил в воркер строкой. В Node такого типа модуля нет, поэтому при заливке
исходник оборачивается в `export default "<текст>"` — worker.js этого не
замечает, для него это по-прежнему строка.
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
WORKER = "neoved-chat"
REMOTE_DIR = posixpath.join(APP_DIR, "workers", WORKER)
BASE_URL = "https://hooks.neoved.io/amo"

HERE = Path(__file__).resolve().parent
# widget.js кладётся отдельно — он оборачивается в модуль, а не копируется как есть.
FILES = ["worker.js", "amojo.js", ".env"]

no_build = "--no-build" in sys.argv


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
    _, out, err = client.exec_command(command, timeout=900)
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

    for name in FILES + ["widget.js"]:
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

    # Текстовый модуль: строка в JSON-виде — так экранирование берёт на себя
    # стандартная библиотека, а не мы вручную.
    widget = (HERE / "widget.js").read_text(encoding="utf-8")
    wrapped = "export default " + json.dumps(widget) + ";\n"
    with sftp.open(posixpath.join(REMOTE_DIR, "widget.js"), "w") as fh:
        fh.write(wrapped)
    print("   widget.js (обёрнут в export default)")

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
        _, text = run(client, f"curl -s -m 15 {BASE_URL}/{WORKER}/health", quiet=True)
        print(f"   {text.strip()}")

    client.close()

    print("\nГотово.")
    print(f"  здоровье : {BASE_URL}/{WORKER}/health")
    print(f"  журнал   : {BASE_URL}/{WORKER}/debug/{env['HOOK_SECRET']}")
    print(f"  виджет   : {BASE_URL}/{WORKER}/widget.js")
    if env.get("SCOPE_ID"):
        print(f"  чаты     : {BASE_URL}/{WORKER}/amojo/{env['SCOPE_ID']}")


if __name__ == "__main__":
    main()
