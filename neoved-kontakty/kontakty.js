/* neoved · чёрно-белая Яндекс Карта на странице «Контакты».
   Подключение одной строкой на странице /kontakty (в Tilda — блок T123 «HTML-код», место не важно):
   <script src="https://hooks.neoved.io/amo/neoved-kontakty/kontakty.js" defer></script>
   Карта встаёт в плейсхолдер Zero Block контактов; если его нет — на место этой строки.
   Файл собран из neoved-kontakty/block.html скриптом build-embed.py — правки вносить в block.html. */
(function () {
  var me = document.currentScript;
  if (document.getElementById('nvk')) return; // карта уже есть на странице
  var style = document.createElement('style');
  style.textContent = ".nvk{position:absolute;top:0;left:0;right:0;bottom:0;display:block;box-sizing:border-box;border-radius:inherit;overflow:hidden;background:#f7f7f7;cursor:pointer;-webkit-tap-highlight-color:transparent}\n.nvk--px{position:relative;width:100%}\n.nvk--own{position:relative;width:100%;height:auto;aspect-ratio:570/535;max-width:570px;margin:0 auto;border-radius:30px;border:1px solid #eeeeee}\n@media (max-width:640px){.nvk--own{aspect-ratio:320/443;max-width:none;border-radius:25px}}\n.nvk__map{position:absolute;top:0;left:0;width:100%;height:100%;border:0;display:block;pointer-events:none;opacity:0;transition:opacity .6s ease}\niframe.nvk__map{filter:grayscale(1);-webkit-filter:grayscale(1)}\n.nvk.is-ready .nvk__map{opacity:1}\n.nvk.is-on{cursor:default}\n.nvk.is-on .nvk__map{pointer-events:auto}\n.nvk__card{position:absolute;top:16px;left:16px;z-index:2;max-width:292px;box-sizing:border-box;padding:14px 16px 13px;border-radius:18px;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.10);font-family:'Onest',Arial,sans-serif;color:#000;cursor:default;opacity:0;transition:opacity .4s ease}\n.nvk.is-api .nvk__card{opacity:1}\n.nvk:not(.is-api) .nvk__card{visibility:hidden}\n.nvk__label{display:block;margin:0 0 4px;font-size:12px;line-height:1.2;color:rgba(0,0,0,.45)}\n.nvk__addr{display:block;margin:0;font-size:15px;line-height:1.35;font-weight:500}\n.nvk__metro{display:block;margin:6px 0 0;font-size:13px;line-height:1.35;color:rgba(0,0,0,.6)}\n.nvk__link{display:inline-block;margin:10px 0 0;font-size:13px;line-height:1.2;color:#000;text-decoration:none;border-bottom:1px solid rgba(0,0,0,.25);transition:color .2s ease,border-color .2s ease}\n.nvk__link:hover{color:#ee0000;border-color:rgba(238,0,0,.4)}\n.nvk__link:focus-visible{outline:2px solid #ee0000;outline-offset:3px;border-radius:2px}\n@media (max-width:640px){.nvk__card{top:12px;left:12px;right:12px;max-width:none;padding:12px 14px 11px;border-radius:16px}.nvk__addr{font-size:14px}}\n.nvk__hint{position:absolute;left:50%;bottom:16px;z-index:3;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(17,0,0,.72);color:#fff;font:400 12px/1.2 'Onest',Arial,sans-serif;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s ease}\n.nvk.is-api .nvk__hint{bottom:44px}\n@media (hover:hover){.nvk:not(.is-on):hover .nvk__hint{opacity:1}}\n@media (prefers-reduced-motion:reduce){.nvk__map,.nvk__hint,.nvk__card,.nvk__link{transition:none}}\n/* Кнопки видеовстреч (.cardzm: Zoom, Google Meet, Zoho Meeting): текст не меняется, значок серый и при наведении\n   на кнопку — на значок или на название — загорается своими цветами (решение anton 26.11.2026; красное наведение,\n   как у мессенджеров, отменено). Это CSS дизайнера в Tilda; здесь то же правило на случай, если его там не будет. */\n#rec4713202201 .cardzm .tn-atom__vector-wrapper,#rec4713202201 .cardzm svg{filter:grayscale(100%);transition:filter .3s}\n#rec4713202201 .cardzm:hover .tn-atom__vector-wrapper,#rec4713202201 .cardzm:hover svg{filter:none}\n@media (prefers-reduced-motion:reduce){#rec4713202201 .cardzm .tn-atom__vector-wrapper,#rec4713202201 .cardzm svg{transition:none}}";
  document.head.appendChild(style);
  var box = document.createElement('div');
  box.innerHTML = "<div class=\"nvk\" id=\"nvk\">\n  <div class=\"nvk__map\" role=\"region\" aria-label=\"Офис neoved на карте\"></div>\n  <div class=\"nvk__card\">\n    <span class=\"nvk__label\">Адрес</span>\n    <span class=\"nvk__addr\">Москва, Большая Бронная улица, 23, стр.&nbsp;1</span>\n    <span class=\"nvk__metro\">м.&nbsp;Тверская, Пушкинская, Чеховская</span>\n    <a class=\"nvk__link\" href=\"https://yandex.ru/maps/org/neoved_/175160083981/\" target=\"_blank\" rel=\"noopener\">Открыть на Яндекс Картах ↗</a>\n  </div>\n  <span class=\"nvk__hint\" aria-hidden=\"true\">Нажмите, чтобы управлять картой</span>\n</div>";
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

  // Ключ JavaScript API Яндекс Карт (бесплатный: developer.tech.yandex.ru → «JavaScript API и HTTP Геокодер»,
  // в ограничениях ключа — HTTP Referer neoved.io). Пустой — на месте карты прежний виджет-iframe с рекламой.
  var KEY = '';
  var POINT = [55.763371, 37.601412];   // офис: Москва, Большая Бронная, 23, стр. 1 (координаты организации в Яндексе)
  var WIDGET = 'https://yandex.ru/map-widget/v1/org/neoved_/175160083981/?indoorLevel=1&ll=37.601412%2C55.763372&z=17';

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

  // Кнопки «Zoom» / «Google Meet» / «Zoho Meeting» в карточке контактов: без ссылки, поэтому
  // помечаем их для попапа записи (widget.js ловит [data-neoved-meeting], формат — zoom|meet|zoho)
  // и делаем кликабельными с клавиатуры; cursor:pointer нужен ещё и iPhone, иначе Safari не шлёт
  // click по div. В «Zoho Meeting» есть «meet» — Google Meet узнаём по «google» или «meet» без «ing».
  function formatOf(text) {
    var t = (text || '').toLowerCase();
    var zoho = t.indexOf('zoho') >= 0, zoom = t.indexOf('zoom') >= 0;
    var meet = t.indexOf('google') >= 0 || /(^|[^a-z])meet(?!ing)/.test(t);
    if (zoho + zoom + meet !== 1) return '';
    return zoho ? 'zoho' : zoom ? 'zoom' : 'meet';
  }
  function hookButtons() {
    var groups = document.querySelectorAll('#rec4713202201 .cardzm');
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (g.hasAttribute('data-neoved-meeting') || g.querySelector('[data-neoved-meeting]')) continue;
      g.setAttribute('data-neoved-meeting', formatOf(g.textContent));
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

  var shown = false;
  function ready() { if (!shown) { shown = true; box.classList.add('is-ready'); } }

  // Запасной путь — прежний виджет-iframe: ключа нет, API не загрузился или упал.
  // Плавное появление: виджет после load ещё около секунды доводит карту до точки (это выглядело
  // как «прыжок» в начале), поэтому показываем его через 2 с после загрузки; если load не пришёл —
  // показать всё равно.
  var fellBack = false;
  function widget() {
    if (fellBack) return;
    fellBack = true;
    box.classList.remove('is-api');
    var f = document.createElement('iframe');
    f.className = 'nvk__map';
    f.src = WIDGET;
    f.title = 'neoved на Яндекс Картах';
    f.setAttribute('allowfullscreen', '');
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.addEventListener('load', function () { setTimeout(ready, 2000); });
    box.replaceChild(f, map);
    map = f;
    setTimeout(ready, 9000);
  }

  // Карта на JS API 2.1. Своё пространство имён (ns), чтобы не столкнуться с другой копией API на странице.
  var NS = 'nvkYmaps';
  function draw() {
    var ym = window[NS];
    var m = new ym.Map(map, {
      center: POINT,
      zoom: 17,
      controls: []
    }, {
      autoFitToViewport: 'always',              // плейсхолдер меняет размер на брейкпоинтах Tilda
      yandexMapDisablePoiInteractivity: true    // клики по кафе и магазинам вокруг не открывают их карточки
    });
    m.controls.add(new ym.control.ZoomControl({ options: { size: 'small', position: { right: 12, bottom: 48 } } }));
    m.geoObjects.add(new ym.Placemark(POINT, { hintContent: 'neoved' }, { preset: 'islands#dotIcon', iconColor: '#ee0000' }));
    // Серая только подложка: метка остаётся красной, логотип и кнопки Яндекса — как есть.
    var ground = m.panes.get('ground');
    if (ground && ground.getElement) ground.getElement().style.filter = 'grayscale(1)';
    // Метку чуть ниже центра: сверху карточка с адресом.
    var px = m.getGlobalPixelCenter();
    m.setGlobalPixelCenter([px[0], px[1] - Math.round(map.clientHeight * 0.08)]);
    box.classList.add('is-api');
    // Проявить, когда догрузились тайлы (или через 2,5 с, если событие не пришло).
    var layer = m.layers.get(0) && m.layers.get(0).get(0);
    if (layer && layer.events) {
      layer.events.add('tileloadchange', function (e) {
        if (e.get('readyTileNumber') >= e.get('totalTileNumber')) ready();
      });
    }
    setTimeout(ready, 2500);
  }
  function api() {
    if (!KEY) { widget(); return; }
    var done = false;
    var s = document.createElement('script');
    s.src = 'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(KEY) + '&lang=ru_RU&ns=' + NS + '&load=package.standard';
    s.async = true;
    s.onload = function () {
      var ym = window[NS];
      if (!ym || !ym.ready) { widget(); return; }
      ym.ready(function () {
        if (fellBack) return;
        try { draw(); done = true; } catch (err) { widget(); }
      }, widget);
    };
    s.onerror = widget;
    document.head.appendChild(s);
    setTimeout(function () { if (!done) widget(); }, 15000);
  }

  // Загружаем карту после загрузки страницы и когда блок рядом с экраном: на телефоне карта под
  // карточкой контактов, и API не должен тормозить первый экран.
  var started = false, watching = false;
  function start() {
    if (started) return;
    started = true;
    api();
  }
  function whenNear() {
    if (watching) return;
    watching = true;
    if (!('IntersectionObserver' in window)) { start(); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (en) { return en.isIntersecting; })) { io.disconnect(); start(); }
    }, { rootMargin: '300px 0px' });
    io.observe(box);
  }
  if (document.readyState === 'complete') whenNear();
  else window.addEventListener('load', whenNear);
  setTimeout(function () { if (!started && document.readyState !== 'complete') whenNear(); }, 6000);
})();
