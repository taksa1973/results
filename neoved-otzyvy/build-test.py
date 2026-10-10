# Собирает тестовую страницу: свежая копия https://neoved.io/keysy-i-otzyvy
# + блок «Отзывы без редакции» (block.html) между заголовком и подписью блока.
# Запуск из корня репозитория: python neoved-otzyvy/build-test.py
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_URL = 'https://neoved.io/keysy-i-otzyvy'
OUT = ROOT / 'neoved-otzyvy-test.html'
TITLE_REC = 'rec4646825601'     # Zero-блок «Отзывы без редакции» + дескриптор
CAPTION_REC = 'rec4652418501'   # Zero-блок «Личные данные скрываем…»
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'


def fetch():
    # Без браузерного User-Agent Tilda отвечает 403.
    req = urllib.request.Request(SRC_URL, headers={'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9'})
    return urllib.request.urlopen(req, timeout=60).read().decode('utf-8')


def main():
    html = fetch()
    block = (ROOT / 'neoved-otzyvy' / 'block.html').read_text(encoding='utf-8')

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
    html = html.replace('<title>Кейсы и отзывы neoved</title>',
                        '<title>Тест · Кейсы и отзывы neoved</title>\n'
                        '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">\n'
                        '<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet">', 1)
    assert 'noindex' in html, 'нет тега noindex'

    # 4. Вставить галерею: после отступа под заголовком, прямо перед подписью.
    t = html.index(f'<div id="{TITLE_REC}"')
    c = html.index(f'<div id="{CAPTION_REC}"', t)
    rec = ('<div id="rec-nvr-otzyvy" class="r t-rec" data-record-type="131" data-test-insert="otzyvy-bez-redaktsii">\n'
           + block + '\n</div>\n')
    html = html[:c] + rec + html[c:]

    # 5. Плашка тестовой копии со ссылкой к новому блоку.
    badge = '''
<style>
.nvr-test{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);white-space:nowrap;z-index:2147482000;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:30px;background:#110000;color:#fff;font:500 13px/16px 'Onest',Arial,sans-serif;box-shadow:0 10px 30px -12px rgba(0,0,0,.5)}
.nvr-test button{border:0;font:inherit;cursor:pointer;display:inline-block;padding:7px 12px;border-radius:20px;background:#EE0000;color:#fff;text-decoration:none}
.nvr-test button:hover{background:#c40000}
.nvr-test button:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (max-width:639px){.nvr-test{bottom:10px;padding:6px 6px 6px 12px;font-size:12px}.nvr-test button{padding:6px 10px}}
</style>
<div class="nvr-test" role="note">Тестовая копия<button type="button" data-nvr-jump>К блоку отзывов ↓</button></div>
<script>
(function(){
  function jump(smooth){var el=document.getElementById('__TITLE_REC__');if(!el)return;var y=el.getBoundingClientRect().top+window.pageYOffset-20;window.scrollTo({top:y,behavior:smooth?'smooth':'auto'});}
  document.querySelector('[data-nvr-jump]').addEventListener('click',function(){jump(true);});
  if(location.hash==='#otzyvy'){window.addEventListener('load',function(){setTimeout(function(){jump(false);},400);});}
})();
</script>
'''.replace('__TITLE_REC__', TITLE_REC)
    html = html.replace('</body>', badge + '</body>', 1)

    OUT.write_text(html, encoding='utf-8')
    print(f'{OUT.name}: {len(html)//1024} КБ (исходник {n0//1024} КБ)')


if __name__ == '__main__':
    sys.exit(main())
