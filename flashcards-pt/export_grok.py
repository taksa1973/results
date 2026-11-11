#!/usr/bin/env python3
"""
Выгрузка всех слов колоды одним текстовым файлом для Grok (grok.com / приложение):
файл прикрепляют к чату или к проекту, а разговор ведут с Grok напрямую.
Приложение syferpu.top/portu при этом не меняется.

    python export_grok.py            → ../grok-slova-pt.txt
"""
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(ROOT, "..", "grok-slova-pt.txt"))
POS = [("nouns", "Существительные"), ("verbs", "Глаголы и формы глаголов"), ("adjectives", "Прилагательные"),
       ("adverbs", "Наречия"), ("function words", "Служебные слова"), ("phrases", "Выражения")]


def main():
    cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
    lines = [f"Слова бразильского португальского, которые я учу — {len(cards)} шт.",
             "Формат строки: португальский — русский (английский); после « · » — пояснение.", ""]
    for key, title in POS:
        group = sorted((c for c in cards if c.get("pos") == key), key=lambda c: c["pt"].lower())
        if not group:
            continue
        lines += [f"## {title} ({len(group)})"]
        for c in group:
            note = f" · {c['note']}" if c.get("note") else ""
            lines.append(f"{c['pt']} — {c['ru']} ({c['en']}){note}")
        lines.append("")
    other = [c for c in cards if c.get("pos") not in dict(POS)]
    if other:
        lines += [f"## Прочее ({len(other)})"] + [f"{c['pt']} — {c['ru']} ({c['en']})" for c in other] + [""]
    open(OUT, "w", encoding="utf-8").write("\n".join(lines))
    print(f"✓ {OUT} — {len(cards)} слов, {os.path.getsize(OUT) // 1024} КБ")


if __name__ == "__main__":
    main()
