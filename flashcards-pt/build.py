#!/usr/bin/env python3
"""
Собирает index.html: подставляет карточки из data/words.json прямо в HTML.

Данные встраиваются в файл (а не грузятся через fetch), чтобы страница
открывалась двойным кликом с диска и работала без интернета.

    python3 build.py
"""
import json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(ROOT, "app_template.html")
OUT = os.path.join(ROOT, "index.html")
WORDS = os.path.join(ROOT, "data", "words.json")

META = {
    "sources": [
        {"name": "speakingbrazilian.com — 100 most used words",
         "url": "https://www.speakingbrazilian.com/100-most-used-words/"},
    ]
}


def main():
    cards = json.load(open(WORDS, encoding="utf-8"))
    html = open(TPL, encoding="utf-8").read()

    # в карточках оставляем только то, что нужно приложению
    keep = ("id", "pt", "en", "ru", "pos", "examples", "image", "credit", "icon", "note")
    slim = [{k: c[k] for k in keep if c.get(k) is not None} for c in cards]

    def inject(marker, value, s):
        pat = re.compile(r"/\*__" + marker + r"__\*/.*?/\*__END__\*/", re.S)
        if not pat.search(s):
            raise SystemExit(f"В шаблоне нет метки __{marker}__")
        return pat.sub(lambda _: json.dumps(value, ensure_ascii=False), s, count=1)

    html = inject("CARDS", slim, html)
    html = inject("META", META, html)

    # GitHub-версия: плашка «переехало на syferpu.top/portu» с переносом прогресса
    snippet = open(os.path.join(ROOT, "migrate_snippet.html"), encoding="utf-8").read()
    html = html.replace("<!--__EXTRA__-->", snippet)

    open(OUT, "w", encoding="utf-8").write(html)

    withimg = sum(1 for c in cards if c.get("image"))
    size = os.path.getsize(OUT) / 1024
    print(f"✓ index.html собран — {len(cards)} карточек, {withimg} с фото, {size:.0f} КБ")
    missing = [c["pt"] for c in cards if c.get("imgQuery") and not c.get("image")]
    if missing:
        print(f"  без фото (искали, но не нашли): {', '.join(missing)}")


if __name__ == "__main__":
    main()
