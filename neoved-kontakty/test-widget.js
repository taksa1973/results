/**
 * Попап «Запишитесь на онлайн-встречу» для neoved.io.
 *
 * Подключение — одна строка перед </body> или в HEAD сайта:
 *   <script src="https://hooks.neoved.io/amo/amo-booking/widget.js" defer></script>
 *
 * Попап открывается по клику на:
 *   • любой элемент с атрибутом data-neoved-meeting;
 *   • ссылку, которая заканчивается на #neoved-meeting;
 *   • прежнюю кнопку со ссылкой на app.simplymeet.me/neoved — её не нужно
 *     переделывать в Tilda, скрипт перехватывает клик сам
 *     (отключается атрибутом data-intercept="off").
 * Из кода: window.NeovedMeeting.open().
 *
 * Формат встречи можно задать заранее — попап откроется сразу с Zoom или
 * Google Meet в поле «Выберите формат встречи» (поменять его можно):
 *   • data-neoved-meeting="zoom" или "meet";
 *   • ссылка #neoved-meeting-zoom или #neoved-meeting-meet;
 *   • NeovedMeeting.open('zoom') / NeovedMeeting.open('meet');
 *   • у перехваченной ссылки на SimplyMeet — по её тексту: «Zoom» — Zoom,
 *     «Google Meet» — Meet, «Zoom / Meet» — без предвыбора (страница /kontakty:
 *     кнопки «Zoom» и «Google Meet» в карточке контактов).
 *
 * Атрибуты тега <script>:
 *   data-api        — адрес воркера, если скрипт лежит не рядом с ним
 *   data-legal      — что стоит под кнопкой. По умолчанию "both": строка
 *                     с галочкой согласия на рекламную рассылку (из макета)
 *                     и текст согласия на обработку персональных данных
 *                     (из ТЗ). "ads" или "personal" — только одно из двух
 *   data-consent    — ссылка на «Согласие на получение рекламной рассылки»
 *   data-personal, data-terms — ссылки в тексте про персональные данные
 *   data-autoclose  — через сколько миллисекунд закрыть попап после успешной
 *                     записи (по ТЗ — 2000); 0 — не закрывать
 *
 * Вёрстка живёт в Shadow DOM: стили сайта (у Tilda их много и они общие)
 * не дотягиваются до попапа, а стили попапа — до сайта.
 */
(function () {
  'use strict';
  if (window.NeovedMeeting) return;

  var script = document.currentScript;
  var BASE = ((script && script.dataset.api) || (script && script.src ? script.src.replace(/\/widget\.js.*$/, '') : '')).replace(/\/+$/, '');
  var CONSENT_URL = (script && script.dataset.consent) || 'https://neoved.io/personal';
  var LEGAL = script && (script.dataset.legal === 'personal' || script.dataset.legal === 'ads') ? script.dataset.legal : 'both';
  var PERSONAL_URL = (script && script.dataset.personal) || 'https://neoved.io/personal';
  var TERMS_URL = (script && script.dataset.terms) || 'https://neoved.io/terms';
  var AUTOCLOSE = script && script.dataset.autoclose !== undefined ? Number(script.dataset.autoclose) || 0 : 2000;
  var INTERCEPT = !(script && script.dataset.intercept === 'off');
  var TRIGGERS = '[data-neoved-meeting], a[href*="#neoved-meeting"]' + (INTERCEPT ? ', a[href*="simplymeet.me/neoved"]' : '');

  var FORMATS = [
    { id: 'zoom', title: 'Zoom' },
    { id: 'meet', title: 'Google Meet' },
  ];

  /** 'zoom' | 'meet' | '' — по любой подписи: «Zoom», «Google Meet», «google_meet»; «Zoom / Meet» — пусто. */
  function normFormat(v) {
    v = String(v == null ? '' : v).toLowerCase();
    var zoom = v.indexOf('zoom') >= 0, meet = v.indexOf('meet') >= 0;
    return zoom && !meet ? 'zoom' : meet && !zoom ? 'meet' : '';
  }

  /** Формат, заданный кнопкой: атрибут, хэш ссылки, aria-label, иначе — её текст. */
  function formatOf(trigger) {
    if (!trigger || !trigger.getAttribute) return '';
    var v = trigger.getAttribute('data-neoved-meeting') || '';
    if (!v) {
      var hash = (trigger.getAttribute('href') || '').match(/#neoved-meeting[-=:]?([a-z_]*)/i);
      if (hash) v = hash[1];
    }
    if (!v) v = trigger.getAttribute('aria-label') || '';
    if (!v) v = trigger.textContent || '';
    return normFormat(v);
  }

  // Быстрый список — порядок задан заказчиком (02.10.2026). У города хранится
  // только пояс IANA: смещение UTC, подпись «UTC+3» и место в группе считаются
  // на дату встречи, поэтому Тель-Авив летом стоит в UTC+3, а с 25 октября —
  // в UTC+2, и так для всех городов с переводом часов.
  var QUICK = [
    ['Europe/Moscow', 'Москва, Россия'],
    ['Europe/Istanbul', 'Стамбул, Турция'],
    ['Europe/Minsk', 'Минск, Беларусь'],
    ['Asia/Jerusalem', 'Тель-Авив, Израиль'],
    ['Asia/Riyadh', 'Эр-Рияд, Саудовская Аравия'],
    ['Asia/Qatar', 'Доха, Катар'],
    ['Asia/Tehran', 'Тегеран, Иран'],
    ['Europe/Samara', 'Самара, Россия'],
    ['Asia/Dubai', 'Дубай, ОАЭ'],
    ['Asia/Tbilisi', 'Тбилиси, Грузия'],
    ['Asia/Yerevan', 'Ереван, Армения'],
    ['Asia/Baku', 'Баку, Азербайджан'],
    ['Asia/Muscat', 'Маскат, Оман'],
    ['Asia/Kabul', 'Кабул, Афганистан'],
    ['Asia/Yekaterinburg', 'Екатеринбург, Россия'],
    ['Asia/Tashkent', 'Ташкент, Узбекистан'],
    ['Asia/Almaty', 'Астана, Казахстан'],
    ['Asia/Dushanbe', 'Душанбе, Таджикистан'],
    ['Indian/Maldives', 'Мале, Мальдивы'],
    ['Asia/Kolkata', 'Нью-Дели, Индия'],
    ['Asia/Kolkata', 'Мумбаи, Индия'],
    ['Asia/Colombo', 'Коломбо, Шри-Ланка'],
    ['Asia/Kathmandu', 'Катманду, Непал'],
    ['Asia/Omsk', 'Омск, Россия'],
    ['Asia/Bishkek', 'Бишкек, Кыргызстан'],
    ['Asia/Dhaka', 'Дакка, Бангладеш'],
    ['Asia/Thimphu', 'Тхимпху, Бутан'],
    ['Asia/Yangon', 'Янгон, Мьянма'],
    ['Asia/Novosibirsk', 'Новосибирск, Россия'],
    ['Asia/Bangkok', 'Бангкок, Таиланд'],
    ['Asia/Jakarta', 'Джакарта, Индонезия'],
    ['Asia/Ho_Chi_Minh', 'Ханой, Вьетнам'],
    ['Asia/Phnom_Penh', 'Пномпень, Камбоджа'],
    ['Asia/Irkutsk', 'Иркутск, Россия'],
    ['Asia/Shanghai', 'Пекин, Китай'],
    ['Asia/Shanghai', 'Шанхай, Китай'],
    ['Asia/Hong_Kong', 'Гонконг, Гонконг'],
    ['Asia/Ulaanbaatar', 'Улан-Батор, Монголия'],
    ['Asia/Singapore', 'Сингапур, Сингапур'],
    ['Asia/Kuala_Lumpur', 'Куала-Лумпур, Малайзия'],
    ['Asia/Makassar', 'Денпасар (Бали), Индонезия'],
    ['Asia/Yakutsk', 'Якутск, Россия'],
    ['Asia/Tokyo', 'Токио, Япония'],
    ['Asia/Seoul', 'Сеул, Южная Корея'],
    ['Asia/Dili', 'Дили, Восточный Тимор'],
    ['Australia/Adelaide', 'Аделаида, Австралия'],
    ['Australia/Darwin', 'Дарвин, Австралия'],
    ['Asia/Vladivostok', 'Хабаровск, Россия'],
    ['Australia/Brisbane', 'Брисбен, Австралия'],
    ['Australia/Sydney', 'Сидней, Австралия'],
    ['Australia/Melbourne', 'Мельбурн, Австралия'],
    ['Pacific/Port_Moresby', 'Порт-Морсби, Папуа — Новая Гвинея'],
    ['Asia/Magadan', 'Магадан, Россия'],
    ['Pacific/Noumea', 'Нумеа, Новая Каледония'],
    ['Pacific/Guadalcanal', 'Хониара, Соломоновы Острова'],
    ['Pacific/Efate', 'Порт-Вила, Вануату'],
    ['Asia/Kamchatka', 'Петропавловск-Камчатский, Россия'],
    ['Pacific/Auckland', 'Окленд, Новая Зеландия'],
    ['Pacific/Auckland', 'Веллингтон, Новая Зеландия'],
    ['Pacific/Fiji', 'Сува, Фиджи'],
    ['Pacific/Apia', 'Апиа, Самоа'],
    ['Pacific/Tongatapu', 'Нукуалофа, Тонга'],
    ['Pacific/Kiritimati', 'Киритимати, Кирибати'],
    ['Pacific/Pago_Pago', 'Паго-Паго, Американское Самоа'],
    ['Pacific/Honolulu', 'Гонолулу, США'],
    ['America/Anchorage', 'Анкоридж, США'],
    ['America/Los_Angeles', 'Лос-Анджелес, США'],
    ['America/Vancouver', 'Ванкувер, Канада'],
    ['America/Phoenix', 'Финикс, США'],
    ['America/Edmonton', 'Калгари, Канада'],
    ['America/Mexico_City', 'Мехико, Мексика'],
    ['America/Chicago', 'Чикаго, США'],
    ['America/Costa_Rica', 'Сан-Хосе, Коста-Рика'],
    ['America/Guatemala', 'Гватемала, Гватемала'],
    ['America/Tegucigalpa', 'Тегусигальпа, Гондурас'],
    ['America/New_York', 'Нью-Йорк, США'],
    ['America/Toronto', 'Торонто, Канада'],
    ['America/Lima', 'Лима, Перу'],
    ['America/Bogota', 'Богота, Колумбия'],
    ['America/Panama', 'Панама, Панама'],
    ['America/Santo_Domingo', 'Санто-Доминго, Доминиканская Республика'],
    ['America/Caracas', 'Каракас, Венесуэла'],
    ['America/La_Paz', 'Ла-Пас, Боливия'],
    ['America/Puerto_Rico', 'Сан-Хуан, Пуэрто-Рико'],
    ['America/Santiago', 'Сантьяго, Чили'],
    ['America/Argentina/Buenos_Aires', 'Буэнос-Айрес, Аргентина'],
    ['America/Sao_Paulo', 'Сан-Паулу, Бразилия'],
    ['America/Montevideo', 'Монтевидео, Уругвай'],
    ['America/Noronha', 'Фернанду-ди-Норонья, Бразилия'],
    ['Atlantic/Cape_Verde', 'Прая, Кабо-Верде'],
    ['Atlantic/Azores', 'Понта-Делгада, Португалия'],
    ['Europe/London', 'Лондон, Великобритания'],
    ['Europe/Lisbon', 'Лиссабон, Португалия'],
    ['Europe/Dublin', 'Дублин, Ирландия'],
    ['Atlantic/Reykjavik', 'Рейкьявик, Исландия'],
    ['Africa/Accra', 'Аккра, Гана'],
    ['Europe/Paris', 'Париж, Франция'],
    ['Europe/Berlin', 'Берлин, Германия'],
    ['Europe/Rome', 'Рим, Италия'],
    ['Europe/Madrid', 'Мадрид, Испания'],
    ['Europe/Vienna', 'Вена, Австрия'],
    ['Europe/Belgrade', 'Белград, Сербия'],
    ['Europe/Zurich', 'Цюрих, Швейцария'],
    ['Europe/Budapest', 'Будапешт, Венгрия'],
    ['Europe/Athens', 'Афины, Греция'],
    ['Europe/Helsinki', 'Хельсинки, Финляндия'],
    ['Europe/Bucharest', 'Бухарест, Румыния'],
    ['Asia/Nicosia', 'Никосия, Кипр'],
    ['Africa/Cairo', 'Каир, Египет'],
    ['Africa/Johannesburg', 'Йоханнесбург, ЮАР'],
  ];

  // Остальные города — после быстрого списка, по алфавиту. Тоже только IANA.
  var ZONES = [
    ['Europe/Kaliningrad', 'Калининград, Россия'],
    ['Europe/Simferopol', 'Симферополь, Россия'],
    ['Europe/Volgograd', 'Волгоград, Россия'],
    ['Europe/Kirov', 'Киров, Россия'],
    ['Europe/Saratov', 'Саратов, Россия'],
    ['Europe/Astrakhan', 'Астрахань, Россия'],
    ['Europe/Ulyanovsk', 'Ульяновск, Россия'],
    ['Asia/Barnaul', 'Барнаул, Россия'],
    ['Asia/Tomsk', 'Томск, Россия'],
    ['Asia/Novokuznetsk', 'Новокузнецк, Россия'],
    ['Asia/Krasnoyarsk', 'Красноярск, Россия'],
    ['Asia/Chita', 'Чита, Россия'],
    ['Asia/Vladivostok', 'Владивосток, Россия'],
    ['Asia/Sakhalin', 'Южно-Сахалинск, Россия'],
    ['Asia/Anadyr', 'Анадырь, Россия'],
    ['Europe/Kyiv', 'Киев, Украина'],
    ['Europe/Chisinau', 'Кишинёв, Молдавия'],
    ['Asia/Almaty', 'Алматы, Казахстан'],
    ['Asia/Qostanay', 'Костанай, Казахстан'],
    ['Asia/Qyzylorda', 'Кызылорда, Казахстан'],
    ['Asia/Aqtobe', 'Актобе, Казахстан'],
    ['Asia/Atyrau', 'Атырау, Казахстан'],
    ['Asia/Aqtau', 'Актау, Казахстан'],
    ['Asia/Oral', 'Уральск, Казахстан'],
    ['Asia/Bishkek', 'Бишкек, Киргизия'],
    ['Asia/Ashgabat', 'Ашхабад, Туркмения'],
    ['Asia/Kuwait', 'Эль-Кувейт, Кувейт'],
    ['Asia/Bahrain', 'Манама, Бахрейн'],
    ['Asia/Amman', 'Амман, Иордания'],
    ['Asia/Beirut', 'Бейрут, Ливан'],
    ['Asia/Baghdad', 'Багдад, Ирак'],
    ['Europe/Amsterdam', 'Амстердам, Нидерланды'],
    ['Europe/Prague', 'Прага, Чехия'],
    ['Europe/Warsaw', 'Варшава, Польша'],
    ['Asia/Nicosia', 'Лимассол, Кипр'],
    ['Europe/Riga', 'Рига, Латвия'],
    ['Europe/Vilnius', 'Вильнюс, Литва'],
    ['Europe/Tallinn', 'Таллин, Эстония'],
    ['Europe/Brussels', 'Брюссель, Бельгия'],
    ['Europe/Luxembourg', 'Люксембург'],
    ['Europe/Copenhagen', 'Копенгаген, Дания'],
    ['Europe/Stockholm', 'Стокгольм, Швеция'],
    ['Europe/Oslo', 'Осло, Норвегия'],
    ['Europe/Bratislava', 'Братислава, Словакия'],
    ['Europe/Ljubljana', 'Любляна, Словения'],
    ['Europe/Zagreb', 'Загреб, Хорватия'],
    ['Europe/Podgorica', 'Подгорица, Черногория'],
    ['Europe/Sofia', 'София, Болгария'],
    ['Europe/Malta', 'Валлетта, Мальта'],
    ['Asia/Ho_Chi_Minh', 'Хошимин, Вьетнам'],
    ['Asia/Manila', 'Манила, Филиппины'],
    ['Asia/Karachi', 'Карачи, Пакистан'],
    ['Asia/Taipei', 'Тайбэй, Тайвань'],
    ['Asia/Singapore', 'Сингапур'],
    ['Asia/Hong_Kong', 'Гонконг'],
    ['Australia/Perth', 'Перт, Австралия'],
    ['Africa/Casablanca', 'Касабланка, Марокко'],
    ['Africa/Tunis', 'Тунис'],
    ['Africa/Lagos', 'Лагос, Нигерия'],
    ['Africa/Nairobi', 'Найроби, Кения'],
    ['America/Denver', 'Денвер, США'],
    ['America/Panama', 'Панама'],
  ];

  // Браузеры постарше знают эти пояса под прежними именами — и отдают их же
  // как пояс посетителя.
  var LEGACY = {
    'Europe/Kyiv': 'Europe/Kiev',
    'Asia/Kolkata': 'Asia/Calcutta',
    'Asia/Ho_Chi_Minh': 'Asia/Saigon',
    'America/Argentina/Buenos_Aires': 'America/Buenos_Aires',
  };

  var MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  var WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  var TEXT = {
    required: 'Обязательное поле',
    // Неразрывные пробелы — после коротких предлогов, союзов и частиц:
    // строка не должна заканчиваться на «на», «и», «не».
    taken: 'Это время уже занято.<br>Выберите другой свободный слот.',
    failed: 'Не&nbsp;удалось завершить запись.<br>Попробуйте еще раз<br>или выберите другое время.',
    // Этих двух случаев в ТЗ нет: совет «выберите другое время» тут не помог бы.
    many: 'На&nbsp;этот адрес уже записаны встречи.<br>Отмените одну из&nbsp;них<br>по&nbsp;ссылке из&nbsp;письма.',
    rate: 'Слишком много попыток.<br>Попробуйте записаться позже.',
  };

  var ICON = {
    // Логотипы Zoom и Google Meet сняты с макета: синяя «подушка» с градиентом
    // #1766FD→#0847C4 и буквами zm, жёлтая камера #FED30C с оранжевым
    // объективом #F9AB01 и белой точкой.
    // Градиент подложки — CSS на обёртке, а не SVG-градиент по id: ссылки url(#id)
    // внутри Shadow DOM Safari разрешает не всегда, и значок остался бы пустым.
    zoom: '<svg class="ic" viewBox="0 0 19 19" fill="none" aria-hidden="true"><path d="M19 9.5C19 10.5071 18.9241 11.5142 18.753 12.4827C18.2398 15.6938 15.6938 18.2398 12.4827 18.753C11.5136 18.9241 10.5065 19 9.5 19C8.49354 19 7.48579 18.9241 6.51726 18.753C3.30622 18.2398 0.760156 15.6938 0.246955 12.4827C0.0758885 11.5136 0 10.5065 0 9.5C0 8.49353 0.0758885 7.48578 0.246955 6.51726C0.760156 3.30622 3.30622 0.760154 6.51726 0.246953C7.48643 0.0758866 8.49354 0 9.5 0C10.5065 0 11.5142 0.0758866 12.4827 0.246953C15.6938 0.760154 18.2398 3.30622 18.753 6.51726C18.9241 7.48643 19 8.49353 19 9.5Z" fill="url(#nm-zoom)"/><path d="M8.00092 12.5072H3.13001C2.80782 12.5072 2.50234 12.338 2.35378 12.0493C2.18464 11.7194 2.24638 11.3232 2.5062 11.0634L5.89538 7.67743C4.80531 7.55074 2.28818 8.23758 2.2586 6.46903H6.74557C7.06777 6.46903 7.37324 6.63817 7.5218 6.92693C7.69094 7.25684 7.6292 7.653 7.36939 7.91281L3.9802 11.2988H6.79123C7.46006 11.2988 8.00092 11.839 8.00092 12.5072Z" fill="white"/><path d="M14.3478 6.42402C13.65 6.42402 13.0223 6.72499 12.5934 7.20732C11.2441 5.58926 8.41572 6.70763 8.48582 8.82024V12.5528C10.2846 12.5181 9.55595 9.91931 9.69551 8.80802C9.71351 7.28064 11.9541 7.25491 11.9908 8.77908V11.3444C11.9908 12.0126 12.5316 12.5528 13.2004 12.5528V8.80802C13.2191 7.27999 15.459 7.25556 15.4957 8.77908V11.3444C15.4957 12.0126 16.0366 12.5528 16.7047 12.5528C16.5858 10.5245 17.4964 6.50505 14.3478 6.42402Z" fill="white"/><defs><linearGradient id="nm-zoom" x1="4.45353" y1="18.1292" x2="14.4963" y2="0.842473" gradientUnits="userSpaceOnUse"><stop stop-color="#0845BF"/><stop offset="0.19" stop-color="#0950DE"/><stop offset="0.38" stop-color="#0B59F6"/><stop offset="0.5" stop-color="#0B5CFF"/><stop offset="0.67" stop-color="#0E5EFE"/><stop offset="0.78" stop-color="#1665FC"/><stop offset="0.86" stop-color="#246FF9"/><stop offset="0.94" stop-color="#387FF4"/><stop offset="1" stop-color="#4F90EE"/></linearGradient></defs></svg>',
    meet: '<svg class="ic" viewBox="0 0 19 15" fill="none" aria-hidden="true"><path d="M11.013 8.9C10.2758 8.38717 10.2658 7.2937 10.9937 6.76739L16.9489 2.4612C17.806 1.84152 19 2.45707 19 3.51957V11.9712C19 13.0228 17.8275 13.6407 16.9682 13.0428L11.013 8.9Z" fill="url(#nm-meet-a)"/><path d="M0 4.78261C0 2.1413 2.1267 0 4.75 0H11.6591C12.8516 0 13.8182 0.973261 13.8182 2.17391V12.8261C13.8182 14.0267 12.8516 15 11.6591 15H2.15909C0.966625 15 0 14.0267 0 12.8261V4.78261Z" fill="url(#nm-meet-b)"/><path d="M3.23864 13.2609C4.07334 13.2609 4.75 12.5796 4.75 11.7391C4.75 10.8987 4.07334 10.2174 3.23864 10.2174C2.40393 10.2174 1.72727 10.8987 1.72727 11.7391C1.72727 12.5796 2.40393 13.2609 3.23864 13.2609Z" fill="white"/><defs><linearGradient id="nm-meet-a" x1="13.0409" y1="8.4174" x2="23.6636" y2="8.4174" gradientUnits="userSpaceOnUse"><stop stop-color="#F6A100"/><stop offset="1" stop-color="#FFBE00"/></linearGradient><radialGradient id="nm-meet-b" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(16.4442 7.5) rotate(180) scale(17.243 14.7665)"><stop offset="0.15" stop-color="#FFE921"/><stop offset="1" stop-color="#FEC700"/></radialGradient></defs></svg>',
    // Стрелка поля — толстая светлая галочка из макета, без скруглений
    chev: '<svg class="chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    prev: '<svg viewBox="0 0 6 10" width="6" height="10" aria-hidden="true"><path d="M5 1L1 5l4 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    next: '<svg viewBox="0 0 6 10" width="6" height="10" aria-hidden="true"><path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    check: '<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#EE0000"/><path d="M14.5 24.6l6.4 6.4L33.8 18" fill="none" stroke="#fff" stroke-width="4.6"/></svg>',
    box: '<svg class="box" viewBox="0 0 12 12" aria-hidden="true"><rect x=".75" y=".75" width="10.5" height="10.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path class="tick" d="M3 6.2l2.1 2.1 4-4.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    // Крестик — тот же, что в попапе калькулятора на сайте
    close: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M0 1.4355L14.5645 16L16 14.5645L1.4355 0Z"/><path d="M16 1.4355L1.4355 16L0 14.5645L14.5645 0Z"/></svg>',
  };

  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    // Размеры и цвета — как у попапа «Обратный звонок» в калькуляторе на сайте:
    // затемнение rgba(0,0,0,.5) (с 12.10 — 50 %, в lightbox отзывов 70 %), карточка 420/330 со скруглением 40/30,
    // поля 45/40 с рамкой #E5E5E5, заголовок 40/25 с межбуквенным −2%.
    '.ov{--font:"NeovedOnest","Onest",Arial,sans-serif;--ink:#110000;--red:#EE0000;--mute:#AAAAAA;--line:#E5E5E5;--row:#EEEEEE;--h:45px;--gap:10px;--r:20px;--rf:35px;',
    'position:fixed;inset:0;z-index:2147483000;display:flex;overflow-y:auto;overscroll-behavior:contain;',
    'padding:28px 15px;background:rgba(0,0,0,.5);font-family:var(--font);color:var(--ink);-webkit-font-smoothing:antialiased;',
    'opacity:0;transition:opacity .22s ease-out}',
    '.ov.on{opacity:1}',
    // Сдвиг при появлении — у карточки, а не у .dlg: внутри .dlg лежит крестик с position:fixed,
    // и transform на предке считал бы его от себя, пока идёт анимация.
    '.dlg{position:relative;margin:auto;width:420px;max-width:100%;opacity:0;transition:opacity .32s cubic-bezier(.22,1,.36,1)}',
    '.ov.on .dlg{opacity:1}',
    '.ov.js .dlg,.ov.js .card{transition:none}',
    '.dlg:focus{outline:none}',
    '.card{position:relative;border-radius:40px;background:#EEEEEE;padding:30px 35px 26px;text-align:center;isolation:isolate;',
    'transform:translateY(18px) scale(.97);transition:transform .32s cubic-bezier(.22,1,.36,1)}',
    '.ov.on .card{transform:none}',
    '.bg{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;background:var(--shape) center/cover no-repeat}',
    '.in{position:relative}',
    'h2{margin:0 0 14px;font:500 40px/40px var(--font);letter-spacing:-.02em;color:var(--ink);white-space:nowrap}',
    '.sub{margin:0 0 22px;font:400 17px/22px var(--font);white-space:nowrap}',
    'form{display:flex;flex-direction:column;gap:var(--gap);margin:0}',
    '.f{position:relative;height:var(--h)}',
    '.f.open{z-index:6}',
    '.f[hidden],.notice[hidden],.done[hidden],form[hidden]{display:none}',
    '.ctl{display:flex;align-items:center;gap:10px;width:100%;height:var(--h);margin:0;border:1px solid var(--line);border-radius:var(--rf);background:#fff;',
    'padding:0 44px 0 19px;font:400 17px/1.2 var(--font);color:var(--ink);text-align:left;',
    'outline:none;cursor:pointer;-webkit-appearance:none;appearance:none;transition:border-color .18s ease-out;white-space:nowrap;overflow:hidden}',
    'input.ctl{cursor:text;padding-right:19px;text-overflow:ellipsis}',
    'input.ctl::placeholder{color:var(--mute);opacity:1}',
    '.ctl .ph{color:var(--mute)}',
    '.ctl .val{overflow:hidden;text-overflow:ellipsis}',
    '.ctl .tzv{display:flex;min-width:0}',
    '.ctl .tzv .nm{overflow:hidden;text-overflow:ellipsis}',
    '.ctl .tzv .utc{flex:none}',
    '.ctl:hover{border-color:#D9D9D9}',
    // Фокус без чёрной рамки (как в калькуляторе): только чуть темнее линия.
    '.ctl:focus-visible{border-color:#C9C9C9}',
    '.f.err .ctl{border-color:var(--red);color:var(--red)}',
    '.f.err input.ctl::placeholder,.f.err .ph{color:var(--red)}',
    '.ic{flex:none;width:22px;height:22px}',
    '.chev{position:absolute;right:20px;top:calc(var(--h)/2 - 3px);width:10px;height:6px;color:#E5E5E5;pointer-events:none}',
    '.f.open>.chev{opacity:0}',
    '.pop{position:absolute;left:0;right:0;top:0;background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:hidden;',
    'box-shadow:0 8px 24px rgba(17,0,0,.12)}',
    '.list{max-height:calc(var(--h)*5);overflow-y:auto;overscroll-behavior:contain}',
    '.hd{display:flex;align-items:center;height:28px;padding:0 19px;border-top:1px solid var(--row);background:#FAFAFA;font:500 12px/1 var(--font);color:var(--mute);letter-spacing:.02em}',
    '.grp:first-child .hd{border-top:0}',
    '.hd+.opt{border-top:0}',
    '.opt{position:relative;display:flex;align-items:center;gap:10px;width:100%;height:var(--h);margin:0;padding:0 19px;border:0;border-top:1px solid var(--row);',
    'background:transparent;font:400 17px/1.2 var(--font);color:var(--ink);text-align:left;cursor:pointer;outline:none;white-space:nowrap}',
    '.opt:first-child{border-top:0}',
    '.opt:hover,.opt:focus-visible,.opt[aria-selected="true"]{background:#F5F5F5}',
    '.opt .utc{color:var(--mute)}',
    '.opt .nm{overflow:hidden;text-overflow:ellipsis}',
    '.opt.bad,.opt.bad:disabled{color:var(--red)}',
    '.opt:disabled{cursor:default;color:var(--mute);background:transparent}',
    '.opt .chev{opacity:1;top:calc(50% - 3px);right:19px}',
    '.find{position:relative;border-bottom:1px solid var(--line)}',
    '.find input{display:block;width:100%;height:var(--h);margin:0;border:0;background:transparent;padding:0 44px 0 19px;font:400 17px/1.2 var(--font);color:var(--ink);outline:none}',
    '.find input::placeholder{color:var(--mute);opacity:1}',
    '.empty{padding:0 19px;height:var(--h);display:flex;align-items:center;color:var(--mute);font:400 17px/1.2 var(--font);text-align:left}',
    '.pop.need{border-color:var(--red);height:var(--h);border-radius:var(--rf)}',
    '.pop.need .empty{color:var(--red);height:100%}',
    // Календарь: шапка 46 с линией, строки по 31, стрелки — толстые тёмные из макета
    '.cal-h{display:flex;align-items:center;justify-content:space-between;height:var(--h);padding:0 12px;border-bottom:1px solid var(--line);font:500 17px/1 var(--font)}',
    '.nav{display:grid;place-items:center;width:34px;height:34px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ink);cursor:pointer;outline:none;transition:background .18s}',
    '.nav:hover:not(:disabled),.nav:focus-visible{background:#F5F5F5}',
    '.nav:disabled{color:#D2D2D2;cursor:default}',
    '.cal-g{display:grid;grid-template-columns:repeat(7,1fr);padding:0 13px 14px}',
    '.wd{height:37px;display:grid;place-items:center;color:var(--mute);font:400 14px/1 var(--font)}',
    '.day{height:31px;margin:0;padding:0;border:0;background:transparent;display:grid;place-items:center;cursor:pointer;outline:none;font:500 15px/1 var(--font);color:var(--ink)}',
    '.day span{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;transition:background .15s,color .15s}',
    '.day:disabled{cursor:default;color:var(--mute);font-weight:400}',
    '.day.today span{background:#EEEEEE}',
    '.day:not(:disabled):hover span,.day:focus-visible span{background:#F5F5F5}',
    '.day.sel span,.day.sel:hover span{background:var(--red);color:#fff}',
    '.notice{height:calc(var(--h)*2 + var(--gap));border:1px solid var(--red);border-radius:var(--r);background:#fff;color:var(--red);cursor:pointer;',
    'display:grid;place-items:center;padding:0 14px;font:400 17px/22px var(--font)}',
    '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}',
    '.go{height:var(--h);margin:0;border:0;border-radius:var(--rf);background:var(--red);color:#fff;font:500 17px/1 var(--font);cursor:pointer;outline:none;',
    'transition:background .18s ease-out,transform .12s ease-out;-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    '.go:hover{background:#D60000}',
    '.go:active{transform:scale(.985)}',
    '.go:focus-visible{box-shadow:0 0 0 3px #D6D6D6}',
    '.go:disabled{opacity:.72;cursor:progress}',
    '.go .spin{display:inline-block;width:14px;height:14px;margin-right:9px;vertical-align:-2px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}',
    '@keyframes spin{to{transform:rotate(360deg)}}',
    '.done{position:relative;height:calc(var(--h)*7 + var(--gap)*6);border:1px solid var(--line);border-radius:var(--r);background:#fff;overflow:hidden;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center}',
    '.done .mark{position:absolute;left:50%;top:50%;width:250px;height:250px;margin:-150px 0 0 -95px;color:#F7F7F7}',
    '.done>*:not(.mark){position:relative}',
    '.done h3{margin:20px 0 14px;font:500 40px/44px var(--font);letter-spacing:-.02em}',
    '.done p{margin:0;font:400 17px/22px var(--font)}',
    // Текст под кнопкой: 13/17, ссылки тем же серым и только с подчёркиванием
    '.consent{margin:16px -8px 0;font:400 13px/16px var(--font);color:#999999}',
    '.consent a{color:inherit;text-decoration:underline;text-underline-offset:2px;outline:none}',
    '.consent a:hover{text-decoration:none}',
    '.box{width:11px;height:11px;margin-right:5px;vertical-align:-1px}',
    // Согласие на рассылку — настоящая галочка: её можно снять. Сам флажок
    // спрятан, рисуется значок из макета.
    '.adsrow{position:relative}',
    '.ads{cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.cb:disabled+.box{opacity:.55}',
    '.cb{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;opacity:0}',
    '.tick{transition:opacity .15s ease-out}',
    '.cb:not(:checked)+.box .tick{opacity:0}',
    '.cb:focus-visible+.box{outline:2px solid #C9C9C9;outline-offset:2px}',
    '.consent.pd{margin-top:8px}',
    // Крестик — в правом верхнем углу всего окна, как в калькуляторе
    '.x{position:fixed;top:38px;right:38px;display:grid;place-items:center;width:40px;height:40px;margin:0;padding:0;border:0;border-radius:50%;',
    'background:transparent;color:#999999;cursor:pointer;outline:none;transition:opacity .2s ease}',
    '.x:hover{opacity:.75}',
    '.x:focus-visible{outline:2px solid #C9C9C9;outline-offset:2px}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '@media (max-width:634px){.x{top:8px;right:8px}}',
    '@media (max-width:480px){',
    '.ov{--h:40px;--gap:10px;--r:15px}',
    '.dlg{width:330px}',
    '.card{border-radius:30px;padding:22px 20px 20px}',
    'h2{margin:0 0 13px;font-size:25px;line-height:25px}',
    '.sub{margin:0 0 16px;font-size:15px;line-height:19px}',
    '.ctl,.opt,.find input,.notice,.empty{font-size:15px}',
    '.go{font-size:15px}',
    '.done h3{font-size:25px;line-height:28px;margin:14px 0 10px}',
    '.done p{font-size:13px;line-height:17px}',
    '.done svg:not(.mark){width:38px;height:38px}',
    '.notice{line-height:19px}',
    '.cal-g{padding:0 8px 12px}',
    '.bg{--shape:var(--shape-m)}',
    '.consent{margin:16px 0 0;font-size:12px;line-height:15px}',
    '.consent.pd{margin-top:6px}',
    '}',
    // iOS увеличивает страницу, если шрифт поля меньше 16px в момент фокуса:
    // на время ввода кегль 16, в покое — 15, как в макете.
    '@media (pointer:coarse){input.ctl:focus,.find input:focus{font-size:16px}}',
    '@media (prefers-reduced-motion:reduce){.ov,.dlg,.card,.done,.go,.ctl{transition:none!important;animation:none!important}.ov .card{transform:none}}',
  ].join('');

  // ─────────────── время и пояса ───────────────

  var formatters = {};
  function formatter(tz) {
    if (!formatters[tz]) {
      formatters[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    }
    return formatters[tz];
  }

  /** Календарные части мгновения в поясе. */
  function parts(ms, tz) {
    var out = {};
    formatter(tz).formatToParts(new Date(ms)).forEach(function (p) { out[p.type] = p.value; });
    return { y: +out.year, m: +out.month, d: +out.day, hh: +out.hour, mm: +out.minute };
  }

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var dayKey = function (ms, tz) { var p = parts(ms, tz); return p.y + '-' + pad(p.m) + '-' + pad(p.d); };
  var timeOf = function (ms, tz) { var p = parts(ms, tz); return pad(p.hh) + ':' + pad(p.mm); };

  /** Смещение пояса от UTC в минутах на заданное мгновение — единственный источник для подписей и групп. */
  function offsetMin(ms, tz) {
    var p = parts(ms, tz);
    return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - Math.floor(ms / 60000) * 60000) / 60000);
  }

  /** «UTC+03:00», «UTC−07:00» — минус типографский, как просил заказчик. */
  function offsetLabel(off) {
    var abs = Math.abs(off);
    return 'UTC' + (off < 0 ? '\u2212' : '+') + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  }

  var utcLabel = function (ms, tz) { return offsetLabel(offsetMin(ms, tz)); };

  function zoneOk(tz) {
    try { formatter(tz); return true; } catch (e) { return false; }
  }

  // Пояс посетителя берётся из браузера и подставляется в поле сам (п. 6 ТЗ).
  // Не определился — поле остаётся пустым и обязательным.
  var detectedZone = (function () {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return zoneOk(tz) ? tz : '';
    } catch (e) { return ''; }
  })();
  var browserZone = detectedZone || 'Europe/Moscow';

  var sameZone = function (a, b) { return a === b || LEGACY[a] === b || LEGACY[b] === a; };

  /** Подпись для пояса, которого нет в списке: «Центральная Европа», а если браузер так не умеет — имя города из самого пояса. */
  function regionName(tz) {
    try {
      var name = '';
      new Intl.DateTimeFormat('ru', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date())
        .forEach(function (part) { if (part.type === 'timeZoneName') name = part.value; });
      if (name && !/^(GMT|UTC)/.test(name)) return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) { /* старый браузер: longGeneric не поддержан */ }
    return tz.split('/').pop().replace(/_/g, ' ');
  }

  /**
   * Список поясов: быстрый список заказчика и остальные города по алфавиту.
   * Если пояса посетителя нет ни там, ни там, он добавляется отдельной строкой
   * с подписью из самого пояса («Центральная Европа»).
   */
  function zoneList() {
    var fix = function (z) {
      if (zoneOk(z[0])) return z;
      return LEGACY[z[0]] && zoneOk(LEGACY[z[0]]) ? [LEGACY[z[0]], z[1]] : null;
    };
    var city = function (label) { return label.split(',')[0].trim(); };
    var quick = QUICK.map(fix).filter(Boolean);
    var others = ZONES.map(fix).filter(Boolean)
      // тот же город в быстром списке под чуть другой подписью («Гонконг» и «Гонконг, Гонконг») — не повторяем
      .filter(function (z) { return !quick.some(function (q) { return q[0] === z[0] && city(q[1]) === city(z[1]); }); })
      .sort(function (a, b) { return a[1].localeCompare(b[1], 'ru'); });
    var all = quick.concat(others);
    var extra = detectedZone && !all.some(function (z) { return sameZone(z[0], detectedZone); })
      ? [[detectedZone, regionName(detectedZone)]] : [];
    return { quick: quick, others: others, extra: extra, all: extra.concat(all) };
  }

  /** Подпись пояса по его имени; у браузера имя может быть прежним (Asia/Calcutta) — сверяем через LEGACY. */
  function zoneName(id) {
    var hit = zones.filter(function (z) { return sameZone(z[0], id); })[0];
    return hit ? hit[1] : id;
  }

  /**
   * Группы быстрого списка на заданное мгновение: города раскладываются по
   * фактическому смещению UTC. Порядок групп — как у заказчика: от UTC+3
   * на восток до UTC+14, затем от UTC−11 до UTC+2.
   */
  function quickGroups(at) {
    var groups = [];
    var byOff = {};
    zoneData.quick.forEach(function (z) {
      var off = offsetMin(at, z[0]);
      if (!byOff[off]) { byOff[off] = []; groups.push(off); }
      byOff[off].push(z);
    });
    var key = function (off) { return off >= 180 ? off : off + 100000; };
    groups.sort(function (a, b) { return key(a) - key(b); });
    return groups.map(function (off) { return { off: off, label: offsetLabel(off), zones: byOff[off] }; });
  }

  // ─────────────── состояние ───────────────

  var S = fresh();
  function fresh() {
    return {
      name: '', email: '', format: '', date: '', tz: detectedZone, time: 0, ads: true,
      open: '', errors: {}, notice: '', badTime: 0,
      slots: null, loadedAt: 0, loading: false, sending: false, done: false,
      month: null, query: '',
    };
  }

  var host, root, el = {}, lastFocus, zoneData, zones, closeTimer;

  /** Пояс, в котором сейчас считаются дни и часы: выбранный, а до выбора — пояс браузера. */
  var zone = function () { return S.tz || browserZone; };
  var freeSlots = function () { return (S.slots || []).filter(function (s) { return s[1]; }).map(function (s) { return s[0] * 1000; }); };

  /** дата 'ГГГГ-ММ-ДД' → свободные слоты этого дня в текущем поясе */
  function freeByDay() {
    var map = {};
    freeSlots().forEach(function (t) { (map[dayKey(t, zone())] = map[dayKey(t, zone())] || []).push(t); });
    return map;
  }

  /** Момент, на который считать смещение поясов в списке: выбранное время, иначе выбранный день, иначе сейчас. */
  function refMoment() {
    if (S.time) return S.time;
    if (S.date) {
      // Первый свободный слот этого дня у клиента — ближе всего к самой
      // встрече; без расписания берём полдень по UTC этой даты.
      var first = (freeByDay()[S.date] || [])[0];
      if (first) return first;
      var d = S.date.split('-');
      return Date.UTC(+d[0], +d[1] - 1, +d[2], 12);
    }
    return Date.now();
  }

  // ─────────────── вёрстка ───────────────

  function h(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function ensureFont() {
    if (document.getElementById('neoved-meeting-font')) return;
    var style = document.createElement('style');
    style.id = 'neoved-meeting-font';
    // @font-face из Shadow DOM не действует — шрифт объявляется на уровне документа.
    style.textContent =
      '@font-face{font-family:"NeovedOnest";font-weight:400 500;font-display:swap;src:url("' + BASE + '/assets/onest-cyrillic.woff2") format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}' +
      '@font-face{font-family:"NeovedOnest";font-weight:400 500;font-display:swap;src:url("' + BASE + '/assets/onest-latin.woff2") format("woff2");unicode-range:U+0000-00FF,U+2000-206F,U+20AC,U+2212}';
    document.head.appendChild(style);
  }

  /** Тексты под кнопкой: строка с галочкой про рассылку — из макета, текст про персональные данные — из ТЗ. */
  function legalHtml() {
    var ads = 'Нажимая «Записаться на&nbsp;встречу», вы&nbsp;подтверждаете <a href="' + esc(CONSENT_URL) + '" target="_blank" rel="noopener">Согласие на&nbsp;получение рекламной рассылки</a>';
    var pd = 'Отправляя данную форму, вы&nbsp;подтверждаете <a href="' + esc(PERSONAL_URL) + '" target="_blank" rel="noopener">Согласие на&nbsp;обработку персональных данных</a> в&nbsp;соответствии с&nbsp;<a href="' + esc(TERMS_URL) + '" target="_blank" rel="noopener">Условиями использования</a>';
    if (LEGAL === 'personal') return '<p class="consent">' + pd + '</p>';
    if (LEGAL === 'ads') return '<p class="consent">' + ICON.box + ads + '</p>';
    // Ссылка стоит вне подписи галочки. Внутри <label> на сенсорном экране
    // нажатие по тексту рядом со ссылкой уходило в ссылку: вместо снятия
    // галочки открывалась страница согласия.
    var cut = ads.indexOf('<a ');
    return '<p class="consent adsrow"><label class="ads"><input class="cb" type="checkbox" checked>' + ICON.box + ads.slice(0, cut) + '</label>' + ads.slice(cut) + '</p>' +
      '<p class="consent pd">' + pd + '</p>';
  }

  function build() {
    ensureFont();
    zoneData = zoneList();
    zones = zoneData.all;
    host = document.createElement('div');
    host.id = 'neoved-meeting';
    root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var ov = h(
      '<div class="ov" style="--shape:url(\'' + BASE + '/assets/bg.webp\');--shape-m:url(\'' + BASE + '/assets/bg-mobile.webp\')">' +
        '<div class="dlg" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="nm-title" aria-describedby="nm-sub">' +
          '<button class="x" type="button" aria-label="Закрыть окно записи">' + ICON.close + '</button>' +
          '<div class="card"><div class="bg"></div><div class="in">' +
            '<h2 id="nm-title">Запишитесь<br>на&nbsp;онлайн-встречу</h2>' +
            '<p class="sub" id="nm-sub">Выберите удобные дату и&nbsp;время<br>для встречи в&nbsp;Zoom или Google Meet</p>' +
            '<form novalidate>' +
              '<div class="f" data-f="name"><input class="ctl" name="name" type="text" autocomplete="name" maxlength="80" placeholder="Как к Вам обращаться?" aria-label="Как к Вам обращаться?"></div>' +
              '<div class="f" data-f="email"><input class="ctl" name="email" type="email" inputmode="email" autocomplete="email" maxlength="120" placeholder="Email" aria-label="Email"></div>' +
              '<div class="f" data-f="format"></div>' +
              '<div class="notice" role="alert" hidden></div>' +
              '<div class="f" data-f="date"></div>' +
              '<div class="f tz" data-f="tz"></div>' +
              '<div class="f" data-f="time"></div>' +
              '<button class="go" type="submit">Записаться на встречу</button>' +
            '</form>' +
            // Приманка для роботов. Стоит вне формы и названа нейтрально: поле
            // с именем company рядом с именем и почтой Chrome заполнял
            // автозаполнением, и запись живого человека молча отбрасывалась.
            '<input class="hp" type="text" name="nm_hp_7c" tabindex="-1" autocomplete="off" aria-hidden="true">' +
            '<div class="done" hidden role="status">' +
              '<svg class="mark" viewBox="0 0 250 250" aria-hidden="true"><path d="M20 128l70 70L232 52" fill="none" stroke="currentColor" stroke-width="58"/></svg>' +
              ICON.check +
              '<h3>Вы&nbsp;записаны<br>на&nbsp;встречу</h3>' +
              '<p>Ссылка на&nbsp;событие отправлена<br>на&nbsp;указанный Email</p>' +
            '</div>' +
            legalHtml() +
          '</div></div>' +
        '</div>' +
      '</div>'
    );
    // До открытия слой не должен перехватывать клики по сайту.
    ov.style.display = 'none';
    root.appendChild(ov);

    el.ov = ov;
    el.dlg = ov.querySelector('.dlg');
    el.form = ov.querySelector('form');
    el.notice = ov.querySelector('.notice');
    el.done = ov.querySelector('.done');
    el.go = ov.querySelector('.go');
    el.hp = ov.querySelector('.hp');
    el.cb = ov.querySelector('.cb');
    if (el.cb) el.cb.addEventListener('change', function () { S.ads = el.cb.checked; });
    el.f = {};
    ov.querySelectorAll('.f').forEach(function (node) { el.f[node.dataset.f] = node; });
    el.name = el.f.name.querySelector('input');
    el.email = el.f.email.querySelector('input');

    // ── события ──
    ov.addEventListener('mousedown', function (e) {
      // Только левая кнопка и только по затемнению: когда попап выше окна,
      // у слоя появляется своя полоса прокрутки, и нажатие на неё — не «мимо».
      if (e.target === ov && e.button === 0 && e.clientX < ov.clientWidth) close();
    });
    el.notice.addEventListener('click', function () {
      S.notice = '';
      S.badTime = 0;
      S.open = '';
      render();
      focusCtl('date');
    });
    ov.querySelector('.x').addEventListener('click', close);
    el.dlg.addEventListener('mousedown', function (e) {
      // Клик мимо раскрытого списка закрывает его, а не весь попап.
      if (S.open && !e.target.closest('.f.open')) setOpen('');
    });
    ov.addEventListener('keydown', onKey);

    el.name.addEventListener('input', function () { S.name = el.name.value; clearError('name'); });
    el.email.addEventListener('input', function () { S.email = el.email.value; clearError('email'); });
    [el.name, el.email].forEach(function (input) {
      input.addEventListener('focus', function () { if (S.open) setOpen(''); });
    });

    el.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    el.form.addEventListener('click', onFormClick);
    el.form.addEventListener('input', function (e) {
      if (e.target.classList.contains('q')) {
        S.query = e.target.value;
        el.f.tz.querySelector('.list').innerHTML = zoneOptions();
      }
    });

    document.body.appendChild(host);
    render();
  }

  // ─────────────── отрисовка полей ───────────────

  function render() {
    renderInputs();
    renderSelect('format');
    renderSelect('date');
    renderSelect('tz');
    renderSelect('time');

    var hasNotice = !!S.notice;
    el.notice.hidden = !hasNotice;
    if (hasNotice) el.notice.innerHTML = TEXT[S.notice];
    // По макету сообщение встаёт на место даты и пояса, а список времени раскрыт под ним.
    el.f.date.hidden = hasNotice;
    el.f.tz.hidden = hasNotice;

    el.form.hidden = S.done;
    el.done.hidden = !S.done;
    el.go.disabled = S.sending;
    // Состояние галочки уже ушло на сервер — снять её «задним числом» нельзя,
    // иначе на экране согласия нет, а в amoCRM оно записано.
    if (el.cb) el.cb.disabled = S.sending || S.done;
    el.go.innerHTML = S.sending ? '<span class="spin"></span>Записываем…' : 'Записаться на встречу';
  }

  function renderInputs() {
    [['name', 'Как к Вам обращаться?'], ['email', 'Email']].forEach(function (pair) {
      var key = pair[0];
      var input = el[key];
      var bad = S.errors[key];
      el.f[key].classList.toggle('err', !!bad);
      input.placeholder = bad === 'required' ? TEXT.required : pair[1];
      input.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (bad === 'invalid') input.title = 'Проверьте адрес почты';
      else input.removeAttribute('title');
    });
  }

  var LABEL = { format: 'Выберите формат встречи', date: 'Выберите дату', tz: 'Выберите часовой пояс', time: 'Выберите время' };

  function valueHtml(key) {
    if (key === 'format' && S.format) {
      var f = FORMATS.filter(function (x) { return x.id === S.format; })[0];
      return ICON[f.id] + '<span class="val">' + f.title + '</span>';
    }
    if (key === 'date' && S.date) {
      var d = S.date.split('-');
      return '<span class="val">' + d[2] + '.' + d[1] + '.' + d[0] + '</span>';
    }
    if (key === 'tz' && S.tz) {
      // Город может не влезть в узкое поле — тогда режется он, а смещение видно всегда.
      return '<span class="val tzv"><span class="nm">' + esc(zoneName(S.tz)) + '</span><span class="utc">\u00a0— ' + utcLabel(refMoment(), S.tz) + '</span></span>';
    }
    if (key === 'time' && S.time) {
      return '<span class="val">' + timeOf(S.time, zone()) + '</span>';
    }
    return '<span class="ph">' + (S.errors[key] ? TEXT.required : LABEL[key]) + '</span>';
  }

  function renderSelect(key) {
    var node = el.f[key];
    var open = S.open === key;
    node.classList.toggle('open', open);
    node.classList.toggle('err', !!S.errors[key]);
    node.innerHTML =
      '<button class="ctl" type="button" data-toggle="' + key + '" aria-haspopup="' + (key === 'date' ? 'dialog' : 'listbox') + '" aria-expanded="' + open + '"' +
        ' aria-label="' + LABEL[key] + (S.errors[key] ? '. ' + TEXT.required : '') + '">' + valueHtml(key) + '</button>' +
      ICON.chev +
      (open ? popHtml(key) : '');
  }

  function popHtml(key) {
    if (key === 'format') {
      return '<div class="pop" role="listbox" aria-label="Формат встречи">' + FORMATS.map(function (f, i) {
        return '<button class="opt" type="button" role="option" data-pick="format" data-v="' + f.id + '" aria-selected="' + (S.format === f.id) + '">' +
          ICON[f.id] + '<span class="nm">' + f.title + '</span>' + (i === 0 ? ICON.chev : '') + '</button>';
      }).join('') + '</div>';
    }
    if (key === 'tz') {
      return '<div class="pop">' +
        '<div class="find"><input class="q" type="text" placeholder="Поиск…" aria-label="Поиск часового пояса" autocomplete="off" value="' + esc(S.query) + '">' + ICON.chev + '</div>' +
        '<div class="list" role="listbox" aria-label="Часовой пояс">' + zoneOptions() + '</div></div>';
    }
    if (key === 'time') {
      // Без выбранной даты — не выпадающий список, а красная подсказка в высоту поля.
      if (!S.date) return '<div class="pop need"><div class="empty">Сначала выберите дату</div></div>';
      return '<div class="pop"><div class="list" role="listbox" aria-label="Время встречи">' + timeOptions() + '</div></div>';
    }
    return calendarHtml();
  }

  function zoneOptions() {
    var q = S.query.trim().toLowerCase();
    var at = refMoment();   // дата встречи, если выбрана, — смещения считаются на неё
    var opt = function (z) {
      var utc = utcLabel(at, z[0]);
      return '<button class="opt" type="button" role="option" data-pick="tz" data-v="' + esc(z[0]) + '" aria-selected="' + sameZone(S.tz, z[0]) + '">' +
        '<span class="nm">' + esc(z[1]) + '</span><span class="utc">' + utc + '</span></button>';
    };

    if (q) {
      // Поиск идёт по всем городам разом, подписи смещений — на ту же дату.
      var hits = zones.filter(function (z) { return (z[1] + ' ' + utcLabel(at, z[0]) + ' ' + z[0]).toLowerCase().indexOf(q) >= 0; });
      return hits.length ? hits.map(opt).join('') : '<div class="empty">Ничего не&nbsp;нашлось</div>';
    }

    var group = function (label, items) {
      return '<div class="grp" role="group" aria-label="' + esc(label) + '"><div class="hd" aria-hidden="true">' + esc(label) + '</div>' + items.map(opt).join('') + '</div>';
    };
    var html = zoneData.extra.map(opt).join('');
    quickGroups(at).forEach(function (g) { html += group(g.label, g.zones); });
    html += group('Все города\u00a0— по\u00a0алфавиту', zoneData.others);
    return html;
  }

  function timeOptions() {
    if (S.loading && !S.slots) return '<div class="empty">Загружаем свободное время…</div>';
    if (!S.slots) return '<div class="empty">Не&nbsp;удалось загрузить расписание</div>';
    if (!S.date) return '<div class="empty">Сначала выберите дату</div>';

    var times = (freeByDay()[S.date] || []).slice();
    // Слот, который увели из-под рук, остаётся в списке красным — как в макете:
    // видно, какое время не получилось, и рядом — что свободно.
    if (S.badTime && dayKey(S.badTime, zone()) === S.date && times.indexOf(S.badTime) < 0) times.push(S.badTime);
    times.sort(function (a, b) { return a - b; });

    if (!times.length) return '<div class="empty">На&nbsp;этот день свободного времени нет</div>';
    return times.map(function (t, i) {
      var bad = t === S.badTime;
      var taken = bad && S.notice === 'taken';
      return '<button class="opt' + (bad ? ' bad' : '') + '" type="button" role="option" data-pick="time" data-v="' + t + '"' +
        ' aria-selected="' + (S.time === t) + '"' + (taken ? ' disabled aria-label="' + timeOf(t, zone()) + ' — занято"' : '') + '>' +
        '<span class="nm">' + timeOf(t, zone()) + '</span>' + (i === 0 ? ICON.chev : '') + '</button>';
    }).join('');
  }

  function calendarHtml() {
    var tz = zone();
    var byDay = freeByDay();
    var days = Object.keys(byDay).sort();
    var todayKey = dayKey(Date.now(), tz);
    var first = (days[0] || todayKey).slice(0, 7);
    var last = (days[days.length - 1] || todayKey).slice(0, 7);
    if (!S.month) S.month = (S.date || days[0] || todayKey).slice(0, 7);
    if (S.month < todayKey.slice(0, 7)) S.month = todayKey.slice(0, 7);

    var y = +S.month.slice(0, 4);
    var m = +S.month.slice(5, 7);
    var lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // сколько пустых клеток до 1-го числа
    var count = new Date(Date.UTC(y, m, 0)).getUTCDate();

    var cells = WEEKDAYS.map(function (w) { return '<div class="wd">' + w + '</div>'; }).join('');
    for (var i = 0; i < lead; i++) cells += '<div></div>';
    for (var d = 1; d <= count; d++) {
      var key = S.month + '-' + pad(d);
      var free = !!byDay[key];
      cells += '<button class="day' + (key === todayKey ? ' today' : '') + (key === S.date ? ' sel' : '') + '" type="button" data-pick="date" data-v="' + key + '"' +
        (free ? '' : ' disabled') + ' aria-label="' + d + ' ' + MONTHS[m - 1] + (free ? '' : ' — нет свободного времени') + '"' +
        (key === S.date ? ' aria-current="date"' : '') + '><span>' + d + '</span></button>';
    }

    var status = S.loading && !S.slots ? '<div class="empty">Загружаем свободные дни…</div>'
      : !S.slots ? '<div class="empty">Не&nbsp;удалось загрузить расписание</div>' : '';

    return '<div class="pop" role="dialog" aria-label="Выбор даты">' +
      '<div class="cal-h">' +
        '<button class="nav" type="button" data-month="-1" aria-label="Предыдущий месяц"' + (S.month <= first || S.month <= todayKey.slice(0, 7) ? ' disabled' : '') + '>' + ICON.prev + '</button>' +
        '<span aria-live="polite">' + MONTHS[m - 1] + ' ' + y + '</span>' +
        '<button class="nav" type="button" data-month="1" aria-label="Следующий месяц"' + (S.month >= last ? ' disabled' : '') + '>' + ICON.next + '</button>' +
      '</div>' +
      (status || '<div class="cal-g">' + cells + '</div>') +
    '</div>';
  }

  // ─────────────── поведение ───────────────

  function focusCtl(key) {
    var ctl = el.f[key] && el.f[key].querySelector('.ctl');
    if (ctl) ctl.focus({ preventScroll: true });
  }

  function setOpen(key) {
    var was = S.open;
    // Расписание не загрузилось при открытии попапа (моргнула сеть) —
    // пробуем ещё раз, когда человек дошёл до даты или времени.
    if ((key === 'date' || key === 'time') && !S.slots && !S.loading) loadSlots();
    S.open = key;
    if (key !== 'tz') S.query = '';
    if (key === 'date') S.month = S.date ? S.date.slice(0, 7) : null;
    if (S.notice && key !== 'time') {
      // Список времени закрыли, не выбрав слот: сообщение убираем, иначе дата
      // и пояс остались бы спрятаны под ним и поменять день было бы нечем.
      S.notice = '';
      S.badTime = 0;
      render();
    } else {
      [was, key].forEach(function (k) { if (k) renderSelect(k); });
    }

    if (!key) {
      // Перерисовка поля уничтожает кнопку, на которой стоял фокус. Без фокуса
      // внутри попапа перестают работать Esc и удержание Tab — возвращаем его.
      if (was && !root.activeElement) focusCtl(was);
      return;
    }
    var node = el.f[key];
    // На телефоне фокус в поле поиска сразу поднял бы клавиатуру поверх списка.
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var target = key === 'tz' && !coarse ? node.querySelector('.q')
      : node.querySelector('[aria-selected="true"], .day.sel') || node.querySelector('.opt:not(:disabled), .day:not(:disabled)');
    if (target) target.focus({ preventScroll: true });
    else focusCtl(key);
    // Выбранный пункт — первой строкой списка, а не последней видимой.
    var list = node.querySelector('.list');
    var picked = list && list.querySelector('[aria-selected="true"]');
    if (picked) list.scrollTop = picked.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    // Список может уйти за нижний край экрана — подводим его в поле зрения
    // (без плавной прокрутки: она шла в фоне и после закрытия списка
    // оставляла на экране его остатки).
    var pop = node.querySelector('.pop');
    if (pop && pop.scrollIntoView) pop.scrollIntoView({ block: 'nearest' });
  }

  function onFormClick(e) {
    var toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      var key = toggle.dataset.toggle;
      setOpen(S.open === key ? '' : key);
      return;
    }
    var nav = e.target.closest('[data-month]');
    if (nav && !nav.disabled) {
      var y = +S.month.slice(0, 4);
      var m = +S.month.slice(5, 7) + Number(nav.dataset.month);
      var next = new Date(Date.UTC(y, m - 1, 1));
      S.month = next.getUTCFullYear() + '-' + pad(next.getUTCMonth() + 1);
      renderSelect('date');
      var again = el.f.date.querySelector('[data-month="' + nav.dataset.month + '"]:not(:disabled)') || el.f.date.querySelector('.day:not(:disabled)');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    var pick = e.target.closest('[data-pick]');
    if (pick && !pick.disabled) choose(pick.dataset.pick, pick.dataset.v);
  }

  function choose(key, value) {
    if (key === 'format') S.format = value;
    if (key === 'date') {
      if (S.date !== value) S.time = 0;
      S.date = value;
    }
    if (key === 'tz') {
      S.tz = value;
      reconcile();
    }
    if (key === 'time') {
      S.time = Number(value);
      S.notice = '';
      S.badTime = 0;
    }
    clearError(key, true);
    S.open = '';
    S.query = '';
    render();
    var ctl = el.f[key].querySelector('.ctl');
    if (ctl) ctl.focus({ preventScroll: true });
  }

  /**
   * После смены пояса те же слоты ложатся на другие дни и часы. Выбранное время —
   * это мгновение, оно остаётся; дата подстраивается под него. Если времени ещё
   * нет, а на выбранный день в новом поясе ничего не выпадает — день сбрасывается.
   */
  function reconcile() {
    var free = freeSlots();
    if (S.time && free.indexOf(S.time) >= 0) {
      S.date = dayKey(S.time, zone());
      return;
    }
    S.time = 0;
    if (S.date && !freeByDay()[S.date]) S.date = '';
  }

  function clearError(key, silent) {
    if (!S.errors[key]) return;
    delete S.errors[key];
    if (!silent) renderInputs();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (S.open) {
        var key = S.open;
        setOpen('');
        focusCtl(key);
      } else if (S.notice) {
        S.notice = '';
        S.badTime = 0;
        render();
        focusCtl('date');
      } else close();
      return;
    }

    var active = root.activeElement;
    if (S.open && active && /^Arrow|^Home$|^End$/.test(e.key)) {
      var node = el.f[S.open];
      var items = Array.prototype.slice.call(node.querySelectorAll('.opt:not(:disabled), .day:not(:disabled)'));
      if (!items.length) return;
      var i = items.indexOf(active);
      var step = { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (S.open === 'date' && i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        // По вертикали — на неделю: ищем свободный день ровно через 7 суток.
        var want = shiftDay(active.dataset.v, e.key === 'ArrowDown' ? 7 : -7);
        var hit = items.filter(function (b) { return b.dataset.v === want; })[0];
        if (hit) { e.preventDefault(); hit.focus(); }
        return;
      }
      var next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : i < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, i + step));
      // Из поля поиска стрелки влево-вправо двигают курсор, а не выбор.
      if (active.classList.contains('q') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) return;
      e.preventDefault();
      items[next].focus();
      return;
    }

    if (e.key === 'Enter' && active && active.classList.contains('q')) {
      e.preventDefault();
      var firstOpt = el.f.tz.querySelector('.opt');
      if (firstOpt) choose('tz', firstOpt.dataset.v);
      return;
    }

    if (e.key === 'Tab') {
      var focusable = Array.prototype.slice.call(el.dlg.querySelectorAll('button:not(:disabled), input:not(.hp), a[href]'))
        .filter(function (n) { return n.offsetParent !== null; });
      if (!focusable.length) return;
      var firstEl = focusable[0];
      var lastEl = focusable[focusable.length - 1];
      // Сразу после открытия фокус стоит на самом окне — Shift+Tab оттуда ушёл бы на страницу под попапом.
      if (e.shiftKey && (active === firstEl || active === el.dlg || active === el.done || !active)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
    }
  }

  function shiftDay(key, delta) {
    var d = key.split('-');
    var t = new Date(Date.UTC(+d[0], +d[1] - 1, +d[2] + delta));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }

  // ─────────────── сеть ───────────────

  function loadSlots() {
    S.loading = true;
    return fetch(BASE + '/api/slots', { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error('slots');
        S.slots = data.slots;
        S.loadedAt = Date.now();
      })
      .catch(function () { S.slots = S.slots || null; })
      .then(function () {
        S.loading = false;
        var changed = false;
        if (S.time && freeSlots().indexOf(S.time) < 0 && S.time !== S.badTime) { S.time = 0; changed = true; }
        if (S.date && !freeByDay()[S.date] && !S.badTime) { S.date = ''; changed = true; }
        // Выбранное время могли занять, пока попап был закрыт: поле не должно
        // показывать то, чего в состоянии уже нет.
        if (changed) render();
        else if (S.open === 'date' || S.open === 'time') renderSelect(S.open);
        if (el.ov.classList.contains('on') && !root.activeElement) {
          var target = S.open ? el.f[S.open].querySelector('.opt:not(:disabled), .day:not(:disabled), .ctl') : el.dlg;
          if (target) target.focus({ preventScroll: true });
        }
      });
  }

  function validate() {
    var errors = {};
    S.name = el.name.value.trim();
    S.email = el.email.value.trim();
    if (!S.name) errors.name = 'required';
    if (!S.email) errors.email = 'required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(S.email)) errors.email = 'invalid';
    if (!S.format) errors.format = 'required';
    if (!S.date) errors.date = 'required';
    if (!S.tz) errors.tz = 'required';
    if (!S.time) errors.time = 'required';
    return errors;
  }

  function submit() {
    if (S.sending) return;
    S.open = '';
    S.notice = '';
    S.badTime = 0;
    S.errors = validate();
    var bad = ['name', 'email', 'format', 'date', 'tz', 'time'].filter(function (k) { return S.errors[k]; });
    if (bad.length) {
      render();
      var first = el.f[bad[0]].querySelector('.ctl');
      if (first) first.focus({ preventScroll: true });
      return;
    }

    S.sending = true;
    render();

    fetch(BASE + '/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: S.name, email: S.email, format: S.format,
        start: Math.round(S.time / 1000), tz: S.tz, tzLabel: zoneName(S.tz),
        page: location.href, consent: LEGAL, ads: LEGAL === 'both' ? !!S.ads : LEGAL === 'ads', hp: el.hp.value,
      }),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; }); })
      .then(function (r) {
        S.sending = false;
        if (r.data && r.data.ok) {
          S.done = true;
          render();
          el.done.setAttribute('tabindex', '-1');
          el.done.focus({ preventScroll: true });
          if (AUTOCLOSE > 0) closeTimer = setTimeout(close, AUTOCLOSE);
          return;
        }
        if (r.status === 422 && r.data.fields) {
          S.errors = r.data.fields;
          render();
          return;
        }
        if (r.status === 429) {
          refuse(r.data.code === 'too_many' ? 'many' : 'rate');
          return;
        }
        fail(r.status === 409 ? 'taken' : 'failed');
      })
      .catch(function () {
        S.sending = false;
        fail('failed');
      });
  }

  /** Сообщение встаёт на место даты и пояса, список времени раскрывается — выбрать другой слот можно сразу. */
  function fail(kind) {
    S.notice = kind;
    S.badTime = S.time;
    if (kind === 'taken') S.time = 0;
    var show = function () {
      S.open = 'time';
      render();
      var target = el.f.time.querySelector('.opt:not(:disabled)') || el.f.time.querySelector('.ctl');
      if (target) target.focus({ preventScroll: true });
      el.notice.scrollIntoView({ block: 'nearest' });
    };
    if (kind === 'taken') loadSlots().then(show);
    else show();
  }

  /** Отказ, при котором другой слот не поможет: сообщение без раскрытого списка времени. Убирается нажатием или Esc. */
  function refuse(kind) {
    S.notice = kind;
    S.badTime = 0;
    S.open = '';
    render();
    focusCtl('email');
    el.notice.scrollIntoView({ block: 'nearest' });
  }

  // ─────────────── открытие и закрытие ───────────────

  var reduced = function () { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

  function open(trigger, format) {
    if (!host) build();
    if (el.ov.classList.contains('on')) return;
    clearTimeout(closeTimer);
    lastFocus = trigger || document.activeElement;
    // Формат из кнопки («Zoom», «Google Meet») или из NeovedMeeting.open('zoom').
    var want = normFormat(format !== undefined && format !== null ? format : formatOf(trigger));

    // После успешной записи повторное открытие начинает с чистой формы.
    if (S.done) {
      var keep = { slots: S.slots, loadedAt: S.loadedAt };
      S = fresh();
      S.slots = keep.slots;
      S.loadedAt = keep.loadedAt;
      el.name.value = '';
      el.email.value = '';
      if (el.cb) el.cb.checked = true;
    }
    if (want) {
      S.format = want;
      delete S.errors.format;
    }
    S.open = '';
    S.notice = '';
    S.badTime = 0;
    el.hp.value = '';
    render();

    host.style.display = '';
    el.ov.style.display = 'flex';
    document.documentElement.style.setProperty('overflow', 'hidden');

    // Страница может подключить motion (Framer Motion) и передать его сюда —
    // тогда карточка выезжает пружиной; без него работает обычный CSS-переход.
    var motion = window.NeovedMeetingMotion;
    el.ov.classList.toggle('js', !!motion && !reduced());
    requestAnimationFrame(function () {
      el.ov.classList.add('on');
      if (motion && !reduced()) {
        motion.animate(el.dlg, { opacity: [0, 1], y: [22, 0], scale: [0.96, 1] }, { type: 'spring', stiffness: 320, damping: 30 });
      }
      el.dlg.focus({ preventScroll: true });
    });

    // Слоты освежаем при каждом открытии, если им больше минуты: расписание живое.
    if (!S.slots || Date.now() - S.loadedAt > 60000) loadSlots();
  }

  function close() {
    // Пока запись уходит на сервер, попап не закрываем: человек не увидел бы
    // результата и записался бы второй раз.
    if (S.sending) return;
    clearTimeout(closeTimer);
    if (!host || !el.ov.classList.contains('on')) return;
    el.ov.classList.remove('on');
    el.ov.classList.remove('js');
    el.dlg.style.cssText = '';
    document.documentElement.style.removeProperty('overflow');
    setTimeout(function () {
      if (!el.ov.classList.contains('on')) el.ov.style.display = 'none';
    }, reduced() ? 0 : 240);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  // Перехват на фазе погружения: у Tilda на ссылках свои обработчики, и до
  // всплытия клик по старой кнопке успел бы увести на страницу SimplyMeet.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey) return;
    var trigger = e.target && e.target.closest ? e.target.closest(TRIGGERS) : null;
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    open(trigger);
  }, true);

  window.NeovedMeeting = {
    open: function (format) { open(null, format && typeof format === 'object' ? format.format : format); },
    close: close,
    // Раскладка быстрого списка на заданное мгновение — для проверки без клика по попапу.
    zoneGroups: function (ms) {
      if (!host) build();
      return quickGroups(ms || Date.now()).map(function (g) { return { label: g.label, cities: g.zones.map(function (z) { return z[1]; }) }; });
    },
  };
})();
