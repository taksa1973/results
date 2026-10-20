/* neoved · чёрно-белая Яндекс Карта на странице «Контакты».
   Подключение одной строкой на странице /kontakty (в Tilda — блок T123 «HTML-код», место не важно):
   <script src="https://hooks.neoved.io/amo/neoved-kontakty/kontakty.js" defer></script>
   Карта встаёт в плейсхолдер Zero Block контактов; если его нет — на место этой строки.
   Файл собран из neoved-kontakty/block.html скриптом build-embed.py — правки вносить в block.html. */
(function () {
  var me = document.currentScript;
  if (document.getElementById('nvk')) return; // карта уже есть на странице
  var style = document.createElement('style');
  style.textContent = ".nvk{position:absolute;top:0;left:0;right:0;bottom:0;display:block;box-sizing:border-box;border-radius:inherit;overflow:hidden;background:#f7f7f7;cursor:pointer;-webkit-tap-highlight-color:transparent}\n.nvk--px{position:relative;width:100%}\n.nvk--own{position:relative;width:100%;height:auto;aspect-ratio:570/535;max-width:570px;margin:0 auto;border-radius:30px;border:1px solid #eeeeee}\n@media (max-width:640px){.nvk--own{aspect-ratio:320/443;max-width:none;border-radius:25px}}\n.nvk__map{position:absolute;top:0;left:0;width:100%;height:100%;border:0;display:block;filter:grayscale(1);-webkit-filter:grayscale(1);pointer-events:none;opacity:0;transition:opacity .6s ease}\n.nvk.is-ready .nvk__map{opacity:1}\n.nvk.is-on{cursor:default}\n.nvk.is-on .nvk__map{pointer-events:auto}\n.nvk__hint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(17,0,0,.72);color:#fff;font:400 12px/1.2 'Onest',Arial,sans-serif;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s ease}\n@media (hover:hover){.nvk:not(.is-on):hover .nvk__hint{opacity:1}}\n@media (prefers-reduced-motion:reduce){.nvk__map,.nvk__hint{transition:none}}";
  document.head.appendChild(style);
  var box = document.createElement('div');
  box.innerHTML = "<div class=\"nvk\" id=\"nvk\">\n  <iframe class=\"nvk__map\" src=\"https://yandex.ru/map-widget/v1/org/neoved_/175160083981/?indoorLevel=1&amp;ll=37.601412%2C55.763372&amp;z=17\" title=\"Neoved на Яндекс Картах\" loading=\"lazy\" allowfullscreen referrerpolicy=\"strict-origin-when-cross-origin\"></iframe>\n  <span class=\"nvk__hint\" aria-hidden=\"true\">Нажмите, чтобы управлять картой</span>\n</div>";
  var map = box.firstElementChild;
  if (me && me.parentNode) me.parentNode.insertBefore(map, me); else document.body.appendChild(map);
})();
(function () {
  'use strict';
  var box = document.getElementById('nvk');
  if (!box || box.dataset.ready) return;
  box.dataset.ready = '1';
  var map = box.querySelector('.nvk__map');
  var SLOT = '#rec4713202201 .tn-elem[data-elem-id="1792177730811000001"] .tn-atom';

  // Куда ставить: в плейсхолдер Zero Block, если он есть и карта ещё не внутри него.
  function place() {
    if (box.closest('.tn-elem')) return true;                 // уже внутри Zero Block (HTML-элемент или плейсхолдер)
    var slot = document.querySelector(SLOT);
    if (!slot) return false;
    slot.style.position = 'relative';
    slot.style.overflow = 'hidden';
    slot.appendChild(box);
    return true;
  }

  // Высота. Карта растянута по плейсхолдеру абсолютным позиционированием; если браузер высоты
  // не дал (Safari, ячейка таблицы) — ставим её в пикселях по плейсхолдеру и держим при ресайзе.
  function fit() {
    var slot = box.parentNode;
    if (box.classList.contains('nvk--own') || !slot || !slot.clientHeight) return;
    if (!box.classList.contains('nvk--px') && box.offsetHeight >= 40) return;
    box.classList.add('nvk--px');
    box.style.height = slot.clientHeight + 'px';
  }
  function watch() {
    fit();
    var slot = box.parentNode;
    if ('ResizeObserver' in window && slot) new ResizeObserver(fit).observe(slot);
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    window.addEventListener('load', fit);
    setTimeout(fit, 1000);
    setTimeout(fit, 3000);
  }

  // Кнопки «Zoom» / «Google Meet» в карточке контактов: без ссылки, поэтому помечаем их для попапа
  // записи (widget.js ловит [data-neoved-meeting], формат — zoom|meet) и делаем кликабельными
  // с клавиатуры; cursor:pointer нужен ещё и iPhone, иначе Safari не шлёт click по div.
  function hookButtons() {
    var groups = document.querySelectorAll('#rec4713202201 .cardzm');
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.hasAttribute('data-neoved-meeting') || g.querySelector('[data-neoved-meeting]')) continue;
      var t = (g.textContent || '').toLowerCase();
      var zoom = t.indexOf('zoom') >= 0, meet = t.indexOf('meet') >= 0;
      g.setAttribute('data-neoved-meeting', zoom && !meet ? 'zoom' : meet && !zoom ? 'meet' : '');
      g.style.cursor = 'pointer';
      if (g.tagName !== 'A' && !g.hasAttribute('tabindex')) {
        g.setAttribute('role', 'button');
        g.tabIndex = 0;
        g.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); }
        });
      }
    }
  }

  function init() {
    if (!place()) box.classList.add('nvk--own');             // плейсхолдера нет — карта сама по себе
    watch();
    hookButtons();
  }
  if (document.readyState === 'loading') {
    // Строка стоит выше блока контактов: плейсхолдер ещё не разобран — ждём конца разметки.
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Карта «спит», пока по ней не кликнули: колесо над ней прокручивает страницу, а не масштабирует карту.
  function on() { box.classList.add('is-on'); }
  function off() { box.classList.remove('is-on'); }
  box.addEventListener('click', function () { if (!box.classList.contains('is-on')) on(); });
  box.addEventListener('mouseleave', off);

  // Палец: включаем только по тапу — пролистывание страницы над картой её не включает.
  var t0 = null;
  box.addEventListener('touchstart', function (e) { var t = e.touches[0]; t0 = t ? [t.clientX, t.clientY] : null; }, { passive: true });
  box.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    if (t0 && t && Math.abs(t.clientX - t0[0]) < 10 && Math.abs(t.clientY - t0[1]) < 10) on();
    t0 = null;
  }, { passive: true });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (!en.isIntersecting) off(); });
    }).observe(box);
  }

  // Плавное появление. Виджет после load ещё около секунды доводит карту до точки (это выглядело
  // как «прыжок» в начале), поэтому показываем её через 2 с после загрузки; если load не пришёл —
  // показать всё равно.
  var shown = false;
  function ready() { if (!shown) { shown = true; box.classList.add('is-ready'); } }
  map.addEventListener('load', function () { setTimeout(ready, 2000); });
  setTimeout(ready, 9000);
})();
