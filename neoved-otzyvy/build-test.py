# Собирает тестовую страницу: свежая копия главной https://neoved.io/
# + раздел «Отзывы клиентов» (block.html) после «На чем основано доверие клиентов?», перед «Наши партнеры».
# Запуск из корня репозитория: python neoved-otzyvy/build-test.py
import re
import sys
import urllib.request
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
embed = import_module('build-embed')

ROOT = Path(__file__).resolve().parent.parent
SRC_URL = 'https://neoved.io/'
OUT = ROOT / 'neoved-otzyvy-test.html'
PARTNERS_REC = 'rec1591802201'  # Zero-блок «Наши партнеры»
SPACER_REC = 'rec1190539581'    # блок-отступ между разделами сайта (120 px, на телефоне 60)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'


def fetch():
    # Без браузерного User-Agent Tilda отвечает 403.
    req = urllib.request.Request(SRC_URL, headers={'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9'})
    return urllib.request.urlopen(req, timeout=60).read().decode('utf-8')


def main():
    html = fetch()
    embed.build()  # otzyvy.js из block.html — на тестовой странице стоит та же одна строка, что и на сайте

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

    # 4. Раздел «Отзывы клиентов»: отступ между разделами (копия блока сайта) + заголовок и галерея.
    #    Встаёт перед отступом, который стоит над «Наши партнеры».
    p = html.index(f'<div id="{PARTNERS_REC}"')
    s = html.rindex(f'<div id="{SPACER_REC}"', 0, p)
    e = html.index('<div id="rec', s + 10)
    spacer = html[s:e]
    # Ровно как Tilda оборачивает блок T123 «HTML-код», внутри — одна строка подключения.
    rec = ('<div id="rec-nvr-otzyvy" class="r t-rec" data-record-type="131" data-test-insert="otzyvy-klientov">'
           ' <!-- T123 --> <div class="t123"> <div class="t-container_100 t123__centeredContainer"> <div class="t-width t-width_100 ">'
           ' <!-- nominify begin --> ' + embed.EMBED_LINE + ' <!-- nominify end --> </div> </div> </div> </div>\n')
    html = html[:s] + spacer + rec + html[s:]

    # 5. По ссылке с #otzyvy — сразу к новому разделу: как только появился текст, и ещё раз после полной загрузки
    #    (Zero-блоки Tilda достраиваются скриптом и сдвигают высоты), если человек сам ещё не листал.
    jump = '''<script>
if(location.hash==='#otzyvy'){(function(){var moved=false;
function jump(){var el=document.getElementById('nvr');if(!el||moved)return;window.scrollTo(0,el.getBoundingClientRect().top+window.pageYOffset-100);}
['wheel','touchstart','keydown'].forEach(function(t){window.addEventListener(t,function(){moved=true;},{passive:true,once:true});});
document.addEventListener('DOMContentLoaded',function(){setTimeout(jump,300);setTimeout(jump,1200);});
window.addEventListener('load',function(){setTimeout(jump,300);});})();}
</script>
'''
    html = html.replace('</body>', jump + '</body>', 1)

    OUT.write_text(html, encoding='utf-8')
    print(f'{OUT.name}: {len(html)//1024} КБ (исходник {n0//1024} КБ)')


if __name__ == '__main__':
    sys.exit(main())
