#!/usr/bin/env python3
"""
Собирает серверную версию карточек для syferpu.top/portu.

Та же страница, что и cartoes-pt.html, но вместо плашки «переехало» в неё
подключаются portu.js / portu.css (вход, синхронизация, звонки). Результат —
в ../portu-server/public: index.html, скрипты, манифест, иконки.
Картинки слов (cartoes-img) на сервер копируются отдельно — 45 МБ.

    python build_portu.py
"""
import hashlib, json, os, re, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(ROOT, ".."))
SRV = os.path.join(REPO, "portu-server")
WEB = os.path.join(SRV, "web")
OUT = os.path.join(SRV, "public")

import build   # тот же отбор полей и META, что и для GitHub-версии


def main():
    os.makedirs(OUT, exist_ok=True)
    cards = json.load(open(build.WORDS, encoding="utf-8"))
    html = open(build.TPL, encoding="utf-8").read()
    keep = ("id", "pt", "en", "ru", "pos", "examples", "image", "credit", "icon", "note")
    slim = [{k: c[k] for k in keep if c.get(k) is not None} for c in cards]

    def inject(marker, value, s):
        pat = re.compile(r"/\*__" + marker + r"__\*/.*?/\*__END__\*/", re.S)
        return pat.sub(lambda _: json.dumps(value, ensure_ascii=False), s, count=1)

    html = inject("CARDS", slim, html)
    html = inject("META", build.META, html)

    # статика: копируем и подписываем версией по содержимому, чтобы браузер не держал старую
    ver = {}
    for name in ("portu.js", "portu.css", "cartoes-sw.js", "cartoes-pt.webmanifest"):
        src = os.path.join(WEB, name)
        shutil.copyfile(src, os.path.join(OUT, name))
        ver[name] = hashlib.sha1(open(src, "rb").read()).hexdigest()[:8]
    for name in ("cartoes-icon-192.png", "cartoes-icon-512.png", "cartoes-icon-maskable.png"):
        shutil.copyfile(os.path.join(REPO, name), os.path.join(OUT, name))

    extra = (f'<link rel="stylesheet" href="portu.css?v={ver["portu.css"]}">\n'
             f'<script src="portu.js?v={ver["portu.js"]}"></script>')
    if "<!--__EXTRA__-->" not in html:
        raise SystemExit("В шаблоне нет метки <!--__EXTRA__-->")
    html = html.replace("<!--__EXTRA__-->", extra)
    html = html.replace('<title>Cartões — португальский по карточкам</title>',
                        '<title>Cartões — португальский: карточки и звонки</title>')

    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(html)
    size = os.path.getsize(os.path.join(OUT, "index.html")) / 1024
    print(f"✓ portu-server/public собран — {len(cards)} карточек, {size:.0f} КБ, portu.js v{ver['portu.js']}")


if __name__ == "__main__":
    main()
