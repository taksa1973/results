#!/usr/bin/env python3
"""
Рисует иконки приложения для установки на телефон: синий квадрат с «PT»,
теми же цветами, что и логотип в шапке (Apple blue #0071E3).

maskable-версия — с запасом по краям: Android обрезает иконку под свою
форму, и без полей буквы срезало бы.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BLUE = (0, 113, 227)


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "seguisb.ttf"):
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def icon(size, pad_ratio=0.0, radius_ratio=0.22):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    if pad_ratio:                      # maskable: фон во весь квадрат
        dr.rectangle([0, 0, size, size], fill=BLUE)
    else:
        r = int(size * radius_ratio)
        dr.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BLUE)
    f = font(int(size * (0.44 if pad_ratio else 0.52)))
    box = dr.textbbox((0, 0), "PT", font=f)
    dr.text(((size - box[2] - box[0]) / 2, (size - box[3] - box[1]) / 2),
            "PT", font=f, fill="white")
    return im


for name, size, pad in [("cartoes-icon-192.png", 192, 0.0),
                        ("cartoes-icon-512.png", 512, 0.0),
                        ("cartoes-icon-maskable.png", 512, 0.2)]:
    p = os.path.join(OUT, name)
    icon(size, pad).save(p)
    print(f"{name}: {os.path.getsize(p) / 1024:.1f} КБ")
