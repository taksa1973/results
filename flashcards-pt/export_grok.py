#!/usr/bin/env python3
"""
Документ для Grok: инструкция «разговор как по телефону» + все слова колоды.
Его прикрепляют к чату в Grok (grok.com / приложение) и говорят голосом.
Приложение syferpu.top/portu при этом не меняется.

    python export_grok.py   → ../Португальский для Grok.docx и ../Португальский для Grok.txt
"""
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(ROOT, ".."))
NAME = "Португальский для Grok"
POS = [("nouns", "Существительные"), ("verbs", "Глаголы и формы глаголов"), ("adjectives", "Прилагательные"),
       ("adverbs", "Наречия"), ("function words", "Служебные слова"), ("phrases", "Выражения")]


def instruction(n):
    return [
        "Инструкция для Grok — выполняй её сразу, как получишь этот документ.",
        "Представь, что мы созваниваемся по телефону. Ты — дружелюбный бразилец из Рио-де-Жанейро. "
        f"Я учу бразильский португальский, ниже в документе — {n} слов, которые я учу "
        "(португальский — русский — английский).",
        "1. Говори по-португальски, как говорят в Рио, коротко: 1–2 фразы, и задавай вопрос, чтобы разговор шёл.",
        "2. Используй слова из списка ниже и подталкивай меня их употреблять.",
        "3. Если я спрашиваю по-русски или говорю, что не понял, — объясни по-русски, переведи ключевые слова "
        "и повтори фразу по-португальски проще.",
        "4. Если я ошибся — коротко поправь: правильная фраза по-португальски и одно предложение по-русски, почему. "
        "Потом продолжай разговор.",
        "5. Уровень A2: простые фразы. Если скажу «сложнее» или «проще» — подстрой.",
        "6. По команде «проверь меня» — спроси 10 слов из списка: ты по-русски, я по-португальски; в конце скажи счёт.",
        "Начни с приветствия, как будто я взял трубку.",
    ]


def groups(cards):
    known = dict(POS)
    out = []
    for key, title in POS + [(None, "Прочее")]:
        g = [c for c in cards if (c.get("pos") == key if key else c.get("pos") not in known)]
        if g:
            out.append((title, sorted(g, key=lambda c: c["pt"].lower())))
    return out


def line_parts(c):
    note = f" · {c['note']}" if c.get("note") else ""
    return c["pt"], f" — {c['ru']} ({c['en']}){note}"


def write_txt(cards, path):
    lines = instruction(len(cards)) + ["", f"Слова ({len(cards)}). Формат: португальский — русский (английский); "
                                           "после « · » — пояснение.", ""]
    for title, g in groups(cards):
        lines.append(f"## {title} ({len(g)})")
        lines += ["".join(line_parts(c)) for c in g]
        lines.append("")
    open(path, "w", encoding="utf-8").write("\n".join(lines))


def write_docx(cards, path):
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    st = doc.styles["Normal"]
    st.font.name, st.font.size = "Calibri", Pt(11)
    doc.add_heading("Бразильский португальский — разговор с Grok", level=0)
    ins = instruction(len(cards))
    doc.add_heading(ins[0], level=1)
    for t in ins[1:]:
        doc.add_paragraph(t)
    doc.add_heading(f"Слова ({len(cards)})", level=1)
    doc.add_paragraph("Формат: португальский — русский (английский); после « · » — пояснение.")
    for title, g in groups(cards):
        doc.add_heading(f"{title} ({len(g)})", level=2)
        for c in g:
            pt, rest = line_parts(c)
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(0)
            p.add_run(pt).bold = True
            p.add_run(rest)
    doc.save(path)


def main():
    cards = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))
    txt, docx = os.path.join(OUT_DIR, NAME + ".txt"), os.path.join(OUT_DIR, NAME + ".docx")
    write_txt(cards, txt)
    write_docx(cards, docx)
    for p in (docx, txt):
        print(f"✓ {p} — {len(cards)} слов, {os.path.getsize(p) // 1024} КБ")


if __name__ == "__main__":
    main()
