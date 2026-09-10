#!/usr/bin/env python3
"""
Правит две сцены одиннадцатой партии до генерации.

normal — круглый циферблат со стрелкой слишком похож на весы (igual, quanto),
         берём панель с зелёной лампой: «всё в норме».
neles  — указующий палец уже занят (esta/este, você), содержимое банок
         и так читается: показываем, что лежит внутри них.
"""
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)

EDITS = {
    "scenes_v2_adj.json": {
        "normal": "a machine control panel with one single green indicator lamp lit and "
                  "no red or amber lights anywhere, everything running normally",
    },
    "scenes_v2_rest.json": {
        "neles": "three open glass jars standing in a row on a shelf, each one clearly "
                 "full of coins, the contents inside them plainly visible through the glass",
    },
}

cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
by_pt = {c["pt"]: c for c in cards}

for fname, changes in EDITS.items():
    p = D("data", fname)
    d = json.load(open(p, encoding="utf-8"))
    for word, scene in changes.items():
        print(f"{word}:\n  было:  {d.get(word)}\n  стало: {scene}")
        d[word] = scene
        c = by_pt.get(word)
        if c:
            c["imgQuery"] = scene
        else:
            print("  ! слова нет в колоде")
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\nготово")
