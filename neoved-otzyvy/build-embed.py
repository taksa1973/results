# Собирает otzyvy.js из block.html: стили + разметка + скрипт в одном файле, который вставляет галерею
# прямо на место своей строки. В Tilda тогда нужна одна строка:
#   <script src="https://hooks.neoved.io/amo/neoved-otzyvy/otzyvy.js" defer></script>
# Запуск из корня репозитория: python neoved-otzyvy/build-embed.py
import json
import re
from pathlib import Path

DIR = Path(__file__).resolve().parent
EMBED_URL = 'https://hooks.neoved.io/amo/neoved-otzyvy/otzyvy.js'
EMBED_LINE = f'<script src="{EMBED_URL}" defer></script>'


def build():
    src = (DIR / 'block.html').read_text(encoding='utf-8')
    css = re.search(r'<style>\s*(.*?)\s*</style>', src, re.S).group(1)
    markup = re.search(r'(<div class="nvr" id="nvr".*?</div>)\s*<script>', src, re.S).group(1)
    logic = re.search(r'<script>\s*(.*?)\s*</script>', src, re.S).group(1)
    js = f"""/* neoved · «Отзывы клиентов»: галерея скриншотов + lightbox.
   Подключение одной строкой там, где должна стоять галерея (в Tilda — блок T123 «HTML-код»):
   {EMBED_LINE}
   Файл собран из neoved-otzyvy/block.html скриптом build-embed.py — правки вносить в block.html. */
(function () {{
  var me = document.currentScript;
  if (document.getElementById('nvr')) return; // галерея уже есть на странице
  var style = document.createElement('style');
  style.textContent = {json.dumps(css, ensure_ascii=False)};
  document.head.appendChild(style);
  var box = document.createElement('div');
  box.innerHTML = {json.dumps(markup, ensure_ascii=False)};
  var gallery = box.firstElementChild;
  if (me && me.parentNode) me.parentNode.insertBefore(gallery, me); else document.body.appendChild(gallery);
}})();
{logic}
"""
    out = DIR / 'otzyvy.js'
    out.write_text(js, encoding='utf-8')
    return out, len(js.encode('utf-8'))


if __name__ == '__main__':
    out, size = build()
    print(f'{out.name}: {size // 1024} КБ')
    print(EMBED_LINE)
