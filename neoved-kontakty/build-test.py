# Собирает тестовую страницу: свежая копия https://neoved.io/kontakty + строка подключения карты.
# Попап записи на странице уже стоит (widget.js в HEAD сайта): кнопки «Zoom» и «Google Meet»
# в карточке контактов открывают его с выбранным форматом, когда выложен новый widget.js.
#
#   python neoved-kontakty/build-test.py            — те же строки, что на сайте (после выкладки на сервер)
#   python neoved-kontakty/build-test.py --github   — до выкладки: карта и новый widget.js с GitHub Pages
#   python neoved-kontakty/build-test.py --local    — проверка на своей машине: python -m http.server из корня репозитория
#
# Запуск из корня репозитория.
import re
import sys
import urllib.request
from importlib import import_module
from pathlib import Path

sys.dont_write_bytecode = True  # без __pycache__ рядом с кодом
sys.path.insert(0, str(Path(__file__).resolve().parent))
embed = import_module('build-embed')

ROOT = Path(__file__).resolve().parent.parent
SRC_URL = 'https://neoved.io/kontakty'
OUT = ROOT / 'neoved-kontakty-test.html'
CONTACTS_REC = 'rec4713202201'  # Zero-блок контактов с плейсхолдером под карту
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

PROD_WIDGET = '<script src="https://hooks.neoved.io/amo/amo-booking/widget.js" defer></script>'
API = 'https://hooks.neoved.io/amo/amo-booking'   # слоты и картинки попапа — с боевого воркера
PAGES = 'https://taksa1973.github.io/results'

MODES = {
    'prod': (embed.EMBED_LINE, PROD_WIDGET),
    'github': (f'<script src="{PAGES}/neoved-kontakty/kontakty.js" defer></script>',
               f'<script src="{PAGES}/neoved-kontakty/test-widget.js" data-api="{API}" defer></script>'),
    'local': ('<script src="neoved-kontakty/kontakty.js" defer></script>',
              f'<script src="amo-booking-worker/widget.js" data-api="{API}" defer></script>'),
}


def fetch():
    # Без браузерного User-Agent Tilda отвечает 403.
    req = urllib.request.Request(SRC_URL, headers={'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9'})
    return urllib.request.urlopen(req, timeout=60).read().decode('utf-8')


def main():
    mode = 'github' if '--github' in sys.argv else 'local' if '--local' in sys.argv else 'prod'
    map_line, widget_line = MODES[mode]
    html = fetch()
    embed.build()  # kontakty.js из block.html — на тестовой странице стоит та же одна строка, что и на сайте
    if mode == 'github':
        # Копия нового widget.js для теста до выкладки на сервер; после выкладки файл не нужен.
        (ROOT / 'neoved-kontakty' / 'test-widget.js').write_text(
            (ROOT / 'amo-booking-worker' / 'widget.js').read_text(encoding='utf-8'), encoding='utf-8', newline='\n')

    # 1. Аналитика сайта не должна считать визиты тестовой копии.
    n0 = len(html)
    html = re.sub(r'<script[^>]*data-tilda-cookie-type="analytics"[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<script[^>]*>(?:(?!</script>).)*tildastatcookie.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<noscript>\s*<div>\s*<img[^>]*mc\.yandex[^>]*>\s*</div>\s*</noscript>', '', html, flags=re.S)
    assert 'gtagTrackerID' not in html and 'mc.yandex.ru/metrika' not in html, 'аналитика осталась'

    # 2. Внутренние ссылки сайта — на боевой домен (страница живёт на другом хосте).
    html = re.sub(r'(\s(?:href|src|action)=")/(?!/)', r'\1https://neoved.io/', html)

    # 3. Закрыть от индексации + пометить вкладку.
    html = re.sub(r'<meta name="robots"[^>]*>\s*', '', html)
    html, k = re.subn(r'<title>([^<]*)</title>',
                      lambda m: f'<title>Тест · {m.group(1)}</title>\n'
                                '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">\n'
                                '<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet">', html, count=1)
    assert k == 1 and 'noindex' in html, 'нет тега noindex'

    # 4. Попап: до выкладки — новый widget.js вместо боевого (слоты и картинки всё равно с боевого воркера).
    if widget_line != PROD_WIDGET:
        assert html.count(PROD_WIDGET) == 1, 'строка widget.js в HEAD сайта не найдена или не одна'
        html = html.replace(PROD_WIDGET, widget_line)

    # 5. Карта: блок T123 с одной строкой сразу после Zero-блока контактов.
    #    Если строка уже стоит на сайте — тест повторяет боевую страницу как есть, вторую копию не вставляем.
    assert f'<div id="{CONTACTS_REC}"' in html, 'на странице нет блока контактов'
    if 'neoved-kontakty/kontakty.js' not in html:
        s = html.index(f'<div id="{CONTACTS_REC}"')
        e = html.index('<div id="rec', s + 10)
        # Ровно как Tilda оборачивает блок T123 «HTML-код», внутри — одна строка подключения.
        rec = ('<div id="rec-nvk-map" class="r t-rec" data-record-type="131" data-test-insert="karta-kontakty">'
               ' <!-- T123 --> <div class="t123"> <div class="t-container_100 t123__centeredContainer"> <div class="t-width t-width_100 ">'
               ' <!-- nominify begin --> ' + map_line + ' <!-- nominify end --> </div> </div> </div> </div>\n')
        html = html[:e] + rec + html[e:]

    OUT.write_text(html, encoding='utf-8')
    print(f'{OUT.name} [{mode}]: {len(html)//1024} КБ (исходник {n0//1024} КБ)')


if __name__ == '__main__':
    sys.exit(main())
