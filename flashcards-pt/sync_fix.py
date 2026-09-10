#!/usr/bin/env python3
"""
Переносит сцены из data/scenes_fix.json в основные наборы
(data/scenes_v2_*.json) и в imgQuery карточек.

Без этого правка живёт только в scenes_fix, и полный прогон regen_all.py
вернул бы прежнюю сцену.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)
PARTS = ["scenes_v2_nouns.json", "scenes_v2_adj.json",
         "scenes_v2_verbs.json", "scenes_v2_rest.json"]

fixes = json.load(open(D("data", "scenes_fix.json"), encoding="utf-8"))
fixes.pop("_comment", None)
cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
by_pt = {c["pt"]: c for c in cards}

left = dict(fixes)
for part in PARTS:
    p = D("data", part)
    d = json.load(open(p, encoding="utf-8"))
    touched = False
    for pt in list(left):
        if pt in d:
            d[pt] = left.pop(pt)
            touched = True
            print(f"  {pt} → {part}")
    if touched:
        json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

if left:
    print("не нашлось ни в одном наборе:", ", ".join(left))

for pt, scene in fixes.items():
    c = by_pt.get(pt)
    if c:
        c["imgQuery"] = scene

json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(f"\nперенесено сцен: {len(fixes) - len(left)} из {len(fixes)}")
