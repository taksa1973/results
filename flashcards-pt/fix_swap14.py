#!/usr/bin/env python3
"""
14-я партия: в двух пачках Grok разложил готовые картинки не по тем файлам
(все восемь файлов пачки записаны в одну секунду — копировал скопом).
Сцены верные, снимки хорошие — переставляем файлы по тому, что на них видно.

Ключ — слово, чей файл сейчас открыт; значение — слово, которое на нём изображено.
"""
import json, os, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)

SEEN = {
    # пачка 747–754
    "vestido": "prato", "pesos": "vôlei", "esqui": "pesos", "vôlei": "esqui",
    "descanso": "vestido", "prato": "vizinho", "vizinho": "descanso",
    # пачка 755–762
    "inverno": "exercício", "podcast": "biblioteca", "avô": "podcast",
    "avó": "literatura", "literatura": "inverno", "exercício": "avô",
    "biblioteca": "avó",
}

assert sorted(SEEN) == sorted(SEEN.values()), "перестановка должна быть взаимно-однозначной"

ids = {c["pt"]: c["id"] for c in json.load(open(D("data", "words.json"), encoding="utf-8"))}
tmp = {}
for holder in SEEN:                                   # сначала всё во временные копии
    src = D("img", f"gen_{ids[holder]}.png")
    tmp[holder] = src + ".swap"
    shutil.copy2(src, tmp[holder])
for holder, shown in SEEN.items():                    # потом раскладываем по местам
    os.replace(tmp[holder], D("img", f"gen_{ids[shown]}.png"))
    print(f"{holder:>11} ({ids[holder]}) → {shown} ({ids[shown]})")
print(f"переставлено: {len(SEEN)}")
