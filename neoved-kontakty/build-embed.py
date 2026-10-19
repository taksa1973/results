# Собирает kontakty.js из block.html: стили + разметка карты + скрипт в одном файле.
# В Tilda на странице /kontakty нужна одна строка (блок T123 «HTML-код» в любом месте страницы):
#   <script src="https://hooks.neoved.io/amo/neoved-kontakty/kontakty.js" defer></script>
# Карта сама встаёт в плейсхолдер Zero Block контактов (см. block.html).
# Запуск из корня репозитория: python neoved-kontakty/build-embed.py
import json
import re
from pathlib import Path

DIR = Path(__file__).resolve().parent
EMBED_URL = 'https://hooks.neoved.io/amo/neoved-kontakty/kontakty.js'
EMBED_LINE = f'<script src="{EMBED_URL}" defer></script>'


def build():
    src = (DIR / 'block.html').read_text(encoding='utf-8')
    css = re.search(r'<style>\s*(.*?)\s*</style>', src, re.S).group(1)
    markup = re.search(r'(<div class="nvk" id="nvk".*?</div>)\s*<script>', src, re.S).group(1)
    logic = re.search(r'<script>\s*(.*?)\s*</script>', src, re.S).group(1)
    js = f"""/* neoved · чёрно-белая Яндекс Карта на странице «Контакты».
   Подключение одной строкой на странице /kontakty (в Tilda — блок T123 «HTML-код», место не важно):
   {EMBED_LINE}
   Карта встаёт в плейсхолдер Zero Block контактов; если его нет — на место этой строки.
   Файл собран из neoved-kontakty/block.html скриптом build-embed.py — правки вносить в block.html. */
(function () {{
  var me = document.currentScript;
  if (document.getElementById('nvk')) return; // карта уже есть на странице
  var style = document.createElement('style');
  style.textContent = {json.dumps(css, ensure_ascii=False)};
  document.head.appendChild(style);
  var box = document.createElement('div');
  box.innerHTML = {json.dumps(markup, ensure_ascii=False)};
  var map = box.firstElementChild;
  if (me && me.parentNode) me.parentNode.insertBefore(map, me); else document.body.appendChild(map);
}})();
{logic}
"""
    out = DIR / 'kontakty.js'
    out.write_text(js, encoding='utf-8', newline='\n')
    return out, len(js.encode('utf-8'))


if __name__ == '__main__':
    out, size = build()
    print(f'{out.name}: {size} байт')
    print(EMBED_LINE)
