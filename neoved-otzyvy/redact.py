# Затирает на чистых скриншотах (версия 1) то, что отмечено крестами на версии 2.
# Приём: мозаика + размытие поверх зоны. Мозаика уничтожает буквы (восстановить нельзя),
# размытие делает пятно мягким — интерфейс остаётся узнаваемым, ничего не перерисовано.
from PIL import Image, ImageDraw, ImageFilter
import os, sys

# ('c', cx, cy, r) — круг (аватары, эмодзи-статусы); ('r', x0, y0, x1, y1) — прямоугольник (текст).
REGIONS = {
    1: [
        ('c', 215, 225, 57),            # аватар в шапке
        ('r', 400, 174, 682, 238),      # фамилия клиента в шапке
        ('c', 377, 702, 30),            # аватар в реакции
    ],
    2: [
        ('r', 690, 176, 876, 234),      # часть названия чата
        ('r', 244, 737, 821, 1139),     # вложенный скриншот WhatsApp (контакт, телефон, письмо)
        ('c', 319, 1597, 26),           # эмодзи-статус у Artem
    ],
    3: [
        ('r', 283, 120, 832, 174),      # номер ВБК в закреплённом
        ('c', 215, 225, 57),            # аватар в шапке
        ('r', 438, 170, 560, 242),      # «L.» + эмодзи-статус в шапке
        ('r', 198, 564, 244, 610),      # «L.» в цитате
        ('c', 586, 1440, 30),           # аватар в реакции
        ('r', 150, 1580, 354, 1634),    # название ИП в тексте сообщения
        ('r', 253, 1780, 1027, 1830),   # хэш, строка 1 (после «Хэш:»)
        ('r', 150, 1828, 877, 1878),    # хэш, строка 2
    ],
    4: [
        ('c', 214, 227, 57),            # аватар в шапке
        ('r', 216, 1330, 1024, 1382),   # хэш, строка 1 (после «e0»)
        ('r', 166, 1384, 777, 1433),    # хэш, строка 2
        ('c', 277, 1484, 30),           # аватар в реакции
        ('r', 330, 1738, 976, 1789),    # имя файла акта, строка 1 (после «Akt-»)
        ('r', 249, 1786, 734, 1834),    # имя файла акта, строка 2
    ],
    5: [
        ('r', 480, 176, 786, 234),      # продолжение названия группы
        ('c', 58, 491, 39),             # аватары Vladislav
        ('c', 58, 806, 39),
        ('c', 58, 1255, 39),
        ('c', 58, 1574, 39),
        ('r', 606, 466, 880, 510),      # телефоны
        ('r', 559, 781, 832, 828),
        ('r', 614, 1230, 887, 1277),
        ('r', 604, 1550, 877, 1596),
    ],
}

def smudge(im, box, block, blur):
    """Мозаика + размытие для области box (с запасом, чтобы края пятна были мягкими)."""
    x0, y0, x1, y1 = box
    pad = blur * 3
    X0, Y0, X1, Y1 = max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)
    c = im.crop((X0, Y0, X1, Y1))
    w, h = c.size
    c = c.resize((max(1, w // block), max(1, h // block)), Image.BILINEAR).resize((w, h), Image.NEAREST)
    c = c.filter(ImageFilter.GaussianBlur(blur))
    return c, (X0, Y0)

def redact(k, src, out):
    im = Image.open(src).convert('RGB')
    for reg in REGIONS[k]:
        mask = Image.new('L', im.size, 0)
        d = ImageDraw.Draw(mask)
        if reg[0] == 'c':
            _, cx, cy, r = reg
            box = (cx - r, cy - r, cx + r, cy + r)
            d.ellipse(box, fill=255)
            block, blur = 16, 8
        else:
            _, *box = reg
            h = box[3] - box[1]
            d.rounded_rectangle(box, radius=min(14, h // 3), fill=255)
            block, blur = 20, 9
        mask = mask.filter(ImageFilter.GaussianBlur(1.5))
        patch, at = smudge(im, box, block, blur)
        layer = im.copy()
        layer.paste(patch, at)
        im = Image.composite(layer, im, mask)
    im.save(out)
    return im

if __name__ == '__main__':
    os.makedirs('out', exist_ok=True)
    for k in range(1, 6):
        im = redact(k, f'v1-{k}.png', f'out/{k}.png')
        im.save(f'out/{k}.webp', 'WEBP', quality=86, method=6)
        im.resize((720, round(720 * im.height / im.width)), Image.LANCZOS).save(f'out/{k}-720.webp', 'WEBP', quality=84, method=6)
        print(k, os.path.getsize(f'out/{k}.webp') // 1024, 'KB /', os.path.getsize(f'out/{k}-720.webp') // 1024, 'KB')
