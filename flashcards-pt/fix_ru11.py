#!/usr/bin/env python3
"""
Два слова из одиннадцатой партии уже были в колоде, но пришли с другим
значением — дополняем перевод, картинку не трогаем.

  conselho  «совет (рекомендация)» + board = совет как орган, правление
  quente    «горячий» + warm = тёплый
"""
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
D = lambda *p: os.path.join(ROOT, *p)

EDITS = {
    "conselho": ("совет (рекомендация); правление, совет (орган)", "advice; board"),
    "quente":   ("горячий, тёплый", "hot, warm"),
}

cards = json.load(open(D("data", "words.json"), encoding="utf-8"))
for c in cards:
    if c["pt"] in EDITS:
        ru, en = EDITS[c["pt"]]
        print(f'{c["pt"]}: {c["ru"]!r} → {ru!r}')
        c["ru"], c["en"] = ru, en

json.dump(cards, open(D("data", "words.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("готово — имена файлов у этих двух сменятся, лишние снимет clean_orphans")
