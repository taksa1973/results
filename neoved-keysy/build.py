# Собирает блок «Кейсы» (аккордеон, 6 кейсов) для страницы https://neoved.io/o-nas/keysy-i-otzyvy
# по макету Zero-блока rec4163341301 на странице /mezhdunarodnyy-platezh-v-kriptovalyute
# (anton 03.11.2026: макет обновлён — отступы и скругления; стрелки и свёрнутые карточки
# с макета убраны, но в блоке остаются как были; галочка — с сайта; порядок и номера кейсов —
# как на странице кейсов; блок ставится на страницу кейсов) и тестовую копию страницы кейсов,
# где шесть Zero-блоков с кейсами заменены этим блоком.
#
# Запуск из корня репозитория:  python neoved-keysy/build.py            (block.html + тест)
#                                python neoved-keysy/build.py --no-test  (только block.html)
#
# Код для Tilda (block.html) собирается БЕЗ одинарных и двойных кавычек, без «--» и «...»:
# при копировании в Tilda через телефон/мессенджер кавычки превращаются в типографские
# и ломают скрипт (так было с попапом на /naznacheniya-oplaty 27.10.2026).
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
OUT_BLOCK = HERE / 'block.html'
OUT_TEST = ROOT / 'neoved-keysy-test.html'
SRC_URL = 'https://neoved.io/o-nas/keysy-i-otzyvy'
MOCK_URL = 'https://neoved.io/mezhdunarodnyy-platezh-v-kriptovalyute'  # макет: Zero-блок rec4163341301
# Zero-блоки «Кейс 1» … «Кейс 6» на странице кейсов — в тестовой копии на их месте стоит наш блок
CASE_RECS = ['rec3704438401', 'rec3747679601', 'rec3747729401', 'rec3747798901', 'rec3748110201', 'rec3748693601']
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

# ───────────────────────── данные кейсов (со страницы /o-nas/keysy-i-otzyvy) ─────────────────────────
# Порядок и номера — как на странице кейсов («Кейс 1» … «Кейс 6»), anton 03.11.2026.
CASES = [
    dict(
        title='Как ИП оплатил разработку ПО в Европе, когда три банка отказали',
        tags=['ИП, ИТ-консалтинг и разработка ПО'],
        kind='международный платеж в криптовалюте',
        task='оплатить европейскому контрагенту разработку ПО для Android. До обращения три российских банка '
             'отказали в проведении платежа в USD.',
        steps=['Проверили договор, назначение платежа и требования получателя;',
               'Подготовили документы по операции;',
               'Согласовали расчет в USDC ERC-20;',
               'Клиент перечислил рубли со счета ИП, после чего USDC были отправлены на биржевой кошелек контрагента;',
               'После проверки транзакции площадкой средства были зачислены получателю.'],
        stats=[('2 208 747 ₽', 'сумма сделки'), ('1 рабочий день', 'исполнение'), ('1,5%', 'комиссия')],
        changed='вместо повторных попыток провести платеж в USD клиент получил рабочую цепочку — '
                'счет ИП в России → RUB → USDC ERC-20 → кошелек контрагента в ЕС.',
        quote='«Основная проблема — невозможность нормально заплатить зарубежным контрагентам. Душат с той '
              'и с другой стороны: наши банки падают в обморок при слове «доллар», а зарубежные — на фразе '
              '«перевод из России». Теперь мой контрагент может купить себе покушать. Спасибо neoved»',
        author='ИП, ИТ-консалтинг и разработка ПО',
    ),
    dict(
        title='Как IT-компания перевела оплату OpenRouter на 25 000 $ в месяц с личной карты директора на карту компании',
        tags=['российская IT-компания, средний бизнес, автоматизация бизнес-процессов с AI'],
        kind='международная бизнес-карта',
        task='компания тратит около 25 000 $ в месяц на API и токены через OpenRouter. До обращения расходы '
             'оплачивались личной зарубежной картой директора — требовалось перевести платежи в корпоративный '
             'контур и пополнять карту рублями с расчетного счета ООО.',
        steps=['Подобрали иностранного эмитента и карту под AI- и SaaS-сервисы;',
               'Согласовали договорную модель пополнения;',
               'Предоставили доступ к карте через web-кабинет;',
               'Приняли рубли с расчетного счета ООО и пополнили карту в USD;',
               'Проверили оплату OpenRouter и выстроили регулярный процесс.'],
        stats=[('25 000 $', 'первое пополнение'), ('20 $', 'выпуск карты'), ('0 $', 'обслуживание'),
               ('7%', 'комиссия первого пополнения'), ('3 рабочих дня', 'согласование и договор'),
               ('до 1 дня', 'выпуск и повторное пополнение после подписания')],
        changed='расходы на AI-инфраструктуру переведены из личной карты директора в прозрачный процесс — '
                'счет ООО → RUB → бизнес-карта в USD → OpenRouter.',
        verified='Проверено: Ольга Юркина, эксперт по НДС neoved',
    ),
    dict(
        title='Как производственная компания сформировала валютный резерв в USDT на 15 млн ₽',
        tags=['производитель промышленного электрооборудования, средний бизнес'],
        kind='операция с криптовалютой',
        task='из-за сезонности закупок у компании образовался временно свободный рублевый остаток. Следующая '
             'крупная закупка импортных компонентов планировалась через несколько месяцев, поэтому клиент хотел '
             'заранее сформировать часть корпоративного резерва в USDT под будущие международные расходы.',
        steps=['Провели видеоконференцию с руководителем и финансовой службой;',
               'Разобрали порядок сделки, документы и отражение операции в учете;',
               'Обсудили требования к корпоративному криптокошельку;',
               'Зафиксировали адрес кошелька в документах;',
               'Обеспечили перевод 15 млн ₽ со счета ООО зарубежному провайдеру для покупки USDT TRC-20;',
               'Передали документы и данные блокчейн-транзакции.'],
        stats=[('15 000 000 ₽', 'сумма'), ('6 часов', 'исполнение'), ('1%', 'комиссия')],
        changed='компания получила корпоративный резерв под будущие закупки — '
                'счет ООО → RUB → USDT TRC-20 → корпоративный кошелек.',
        verified='Проверено: Марина Инзелис, финтех-юрист neoved',
    ),
    dict(
        title='Как оптовая компания оплачивает зарубежного поставщика в USDT TRC-20 с расчетного счета ООО',
        tags=['ООО «Капибара», малый бизнес, оптовая торговля бытовыми электротоварами'],
        kind='международный платеж в криптовалюте',
        task='регулярно оплачивать зарубежного поставщика в USDT TRC-20 напрямую со счета российского ООО, '
             'не организуя каждый платеж заново через отдельные обменные площадки.',
        steps=['Разобрали текущую схему расчетов и согласовали USDT TRC-20;',
               'Определили договорную и платежную модель;',
               'Начали с тестовой операции примерно на 300 000 ₽;',
               'После успешного теста перешли к более крупным суммам;',
               'Выстроили регулярный процесс нескольких траншей в месяц.'],
        stats=[('810 399 ₽', 'средняя операция'), ('около 6 часов', 'срок'), ('2,5%', 'комиссия')],
        changed='компания использует повторяемый маршрут — счет ООО → RUB → USDT TRC-20 → кошелек зарубежного поставщика.',
        quote='«Все в рамках закона и все проверено, все работает. Я даже в ФНС и ЦБ вопросы отправлял, все ли '
              'законно с нашей стороны и не будет ли претензий — сказали, все нормально. Качество криптовалюты '
              'позволяет поставщику без проблем использовать ее дальше для своих хозяйственных нужд. Сначала '
              'затестировал на небольшой сумме — около 300 тысяч рублей, насколько помню. Все ок. Потом пошли '
              'суммы больше — все так же, полет нормальный. Теперь рекомендую neoved друзьям и точно буду работать дальше»',
        author='Сергей, директор ООО «Капибара»',
    ),
    dict(
        title='Как студия 3D-анимации оплачивает Google Ads и TikTok Ads за рубежом с бизнес-картой neoved',
        tags=['студия 3D-графики и анимации, малый бизнес'],
        kind='международная бизнес-карта',
        task='для выхода на рынки MENA и LATAM студии требовалось регулярно оплачивать Google Ads и TikTok Ads. '
             'Использование личных иностранных карт и пополнений через криптовалюту стало неудобным при росте '
             'рекламного бюджета.',
        steps=['Определили рекламные площадки, географию и объем расходов;',
               'Подобрали эмитента под рекламные платежи;',
               'Предоставили доступ к бизнес-карте через web-кабинет;',
               'Провели тестовое пополнение на 3 000 $;',
               'После теста провели второе пополнение на 10 000 $ и выстроили регулярный процесс.'],
        stats=[('3 000 $', 'тест'), ('10 000 $', 'второе пополнение'), ('около 8 часов', 'срок второго пополнения')],
        changed='компания получила корпоративный платежный процесс — счет ООО → RUB → бизнес-карта в USD → Google Ads / TikTok Ads.',
        quote='«Обратились к команде по рекомендации коллег. Все прошло профессионально. Не знали, что такие '
              'инструменты существуют для решения наших задач. Успеха в развитии!»',
        author='Студия 3D-графики и анимации',
    ),
    dict(
        title='Как дистрибьютор оборудования для фитнес-клубов платит поставщику в Китае',
        tags=['ИП, малый бизнес, дистрибуция оборудования для фитнес-клубов'],
        kind='международный платеж',
        task='предыдущий платежный агент не смог обеспечить зачисление средств китайскому поставщику. '
             'Возник риск переноса отгрузки и дефицита оборудования на складе в России. '
             'Требовался повторяемый маршрут: рубли в России → юани поставщику в Китае.',
        steps=['Проверили контракт, инвойс, реквизиты и банк получателя;',
               'Определили подходящий корреспондентский маршрут для CNY;',
               'Подобрали договорную модель;',
               'Рекомендовали подходящий счет клиента для проведения платежа;',
               'Провели первый платеж и затем повторили операцию по уже согласованной схеме.'],
        stats=[('11 500 000 ₽', 'первый платеж'), ('5 рабочих дней', 'первая операция'), ('2 рабочих дня', 'повторная')],
        changed='клиент получил рабочий маршрут для регулярных закупок в Китае и смог точнее планировать '
                'сроки отгрузки и складские остатки.',
        quote='«Спасибо, за спокойствие. Одной проблемой меньше»',
        author='ИП, дистрибуция оборудования для фитнес-клубов',
    ),
]

# ───────────────────────── типограф: неразрывные пробелы ─────────────────────────
NB = ' '
# предлоги и союзы, которые не отрываются от следующего слова
PREP = r'(?:в|во|на|с|со|и|а|но|к|ко|о|об|от|по|за|из|у|до|не|ни|для|при|под|над|без|про|или|что|как|да|чем|из-за)'
# частицы и сокращения, которые не отрываются от предыдущего слова
TAIL = r'(?:же|ли|бы|б|ИП|ПО|ООО|АО|ЕС|РФ|ЦБ|ФНС|AI|API|USD|CNY)'
# слова, к которым прилипает идущее следом число
NUMHEAD = r'(?:около|примерно|всего|более|менее|свыше|через|от|до|на|в|за)'


def typo(s):
    s = s.replace('&nbsp;', NB)
    s = re.sub(r'(^|[\s(«])(' + PREP + r') (?=\S)', lambda m: m.group(1) + m.group(2) + NB, s, flags=re.I)
    s = re.sub(r'(^|[\s(«])(' + PREP + r') (?=\S)', lambda m: m.group(1) + m.group(2) + NB, s, flags=re.I)  # «и с другой»
    s = re.sub(r' (' + TAIL + r')(?=[\s,.;:!?»)]|$)', NB + r'\1', s)
    s = re.sub(r'(^|\s)(ООО|ИП|АО|PT) (?=[«\w])', lambda m: m.group(1) + m.group(2) + NB, s)
    s = re.sub(r' — ', NB + '— ', s)
    s = re.sub(r' → ', NB + '→ ', s)
    for _ in range(3):
        s = re.sub(r'(\d) (\d{3})(?!\d)', r'\1' + NB + r'\2', s)  # 11 500 000
    s = re.sub(r'(\d) (?=[₽$%€])', r'\1' + NB, s)                   # 25 000 $
    s = re.sub(r'(\d\.?) (?=[А-Яа-яЁёA-Za-z])', r'\1' + NB, s)       # 5 рабочих, 1. Проверили
    s = re.sub(r'(млн|млрд|тыс\.?) (?=[₽$€])', r'\1' + NB, s)      # 15 млн ₽
    s = re.sub(r'(^|\s)(' + NUMHEAD + r') (?=\d)', lambda m: m.group(1) + m.group(2) + NB, s, flags=re.I)
    s = re.sub(r'\b(USDT|USDC) (?=(?:TRC|ERC)-)', r'\1' + NB, s)
    s = re.sub(r'\b(Google|TikTok) (?=Ads)', r'\1' + NB, s)
    s = re.sub(r'\b(Google Ads|TikTok Ads) / ', lambda m: m.group(1) + NB + '/ ', s)
    return s.replace(NB, '&nbsp;')


# ───────────────────────── иконки без кавычек (data-URI в CSS) ─────────────────────────
ARROW_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 19 12">'
             '<path fill="#dddddd" d="M12.034 9.4709C8.868 6.3139 5.702 3.1569 2.536 -0.0001C1.6907 0.8429 0.8453 1.6858 0 2.5288'
             'C3.1659 5.6858 6.3319 8.8428 9.4978 11.9997C10.3432 11.1568 11.1886 10.3138 12.034 9.4709Z"/>'
             '<path fill="#dddddd" d="M16.4675 0.002C13.3008 3.1598 10.134 6.3175 6.9673 9.4753C7.8108 10.3168 8.6543 11.1583 '
             '9.4978 11.9997C12.6651 8.8421 15.8324 5.6846 18.9997 2.527C18.1556 1.6853 17.3116 0.8437 16.4675 0.002Z"/></svg>')
# Галочка — та же, что на странице кейсов (static.tildacdn.com/tild3032-3133-4532-a166-663866316536/check.svg)
CHECK_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
             '<path fill="#EE0000" d="M11.7 24C9.41133 23.9971 7.362 23.5066 5.60777 22.5427C3.84873 21.577 2.45977 20.1763 '
             '1.4774 18.3754C0.511369 16.6051 0.0144183 14.4605 0 11.9981C0.0144183 9.53952 0.51233 7.39392 1.4774 5.62368'
             'C2.45977 3.82368 3.84873 2.42112 5.60777 1.45632C7.362 0.49344 9.41133 0.00288 11.7 0C13.9887 0.00288 16.038 '
             '0.49344 17.7922 1.45728C19.5513 2.42208 20.9412 3.82464 21.9216 5.62464C22.8877 7.39392 23.3846 9.53952 23.4 '
             '12.001C23.3856 14.4605 22.8877 16.6051 21.9216 18.3744C20.9402 20.1744 19.5503 21.577 17.7922 22.5427C16.039 '
             '23.5066 13.9887 23.9971 11.7 24Z"/>'
             '<rect x="4.23279" y="12" width="2.64006" height="7.92018" transform="rotate(-45 4.23279 12)" fill="white"/>'
             '<rect x="9.83322" y="17.6004" width="2.64006" height="13.2003" transform="rotate(-135 9.83322 17.6004)" fill="white"/></svg>')


def data_uri(svg):
    return 'url(data:image/svg+xml,' + urllib.parse.quote(svg, safe='') + ')'


# ───────────────────────── CSS ─────────────────────────
CSS = '''
.nk{margin:0 auto;padding:0;max-width:800px;text-align:left;font-family:Onest,Arial,sans-serif;color:#110000;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.nk,.nk *{box-sizing:border-box}
.nk-c{position:relative;margin:0;padding:25px 30px;border-radius:25px;background:#eeeeee}
.nk-c+.nk-c{margin-top:20px}
.nk-bg{position:absolute;top:0;right:0;bottom:0;left:0;border-radius:inherit;background:linear-gradient(180deg,#eeeeee 0%,#f7f7f7 100%);opacity:0;transition:opacity .3s ease;pointer-events:none}
.nk-c[data-open]>.nk-bg{opacity:1}
.nk-hd{position:relative;z-index:1;margin:0;padding:0}
.nk-h{display:flex;align-items:flex-start;gap:10px;width:calc(100% + 60px);margin:-25px -30px;padding:25px 30px;border:0;border-radius:25px;background:none;color:#110000;font:inherit;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
.nk-h:focus-visible{outline:2px solid #C9C9C9;outline-offset:-8px}
.nk-t{flex:1 1 auto;min-width:0;min-height:56px;font-size:25px;line-height:1.1;font-weight:500;letter-spacing:-.5px;color:#110000}
.nk-red{color:#EE0000}
.nk-a{flex:none;width:19px;height:12px;margin-top:10px;background:ARROW center/contain no-repeat;transition:transform .3s ease}
.nk-c[data-open] .nk-a{transform:rotate(180deg)}
.nk-b{position:relative;z-index:1;display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows .3s ease,visibility 0s linear .3s}
.nk-c[data-open]>.nk-b{grid-template-rows:1fr;visibility:visible;transition-delay:0s,0s}
.nk-bi{overflow:hidden;min-height:0}
.nk-bw{display:flex;flex-direction:column;align-items:flex-start;gap:5px;padding:10px 0 5px}
.nk-p[data-m],.nk-q,.nk-v{margin-top:5px}
.nk-tg{display:flex;flex-wrap:wrap;align-items:center;gap:5px;max-width:100%}
.nk-tag,.nk-tagr{display:inline-block;max-width:100%;padding:7px 13px;border:1px solid #e5e5e5;border-radius:30px;background:#f7f7f7;color:#999999;font-size:13px;line-height:1;font-weight:500;white-space:nowrap}
.nk-tagr{border-color:#eddede;background:#fff0f0;color:#EE0000}
.nk-p{margin:0;font-size:15px;line-height:1.4;color:#999999}
.nk-i{color:#110000}
.nk-r{display:flex;flex-direction:column;align-items:flex-start;gap:5px;max-width:100%}
.nk-l{font-size:15px;line-height:1.4;color:#110000}
.nk-s{display:flex;flex-wrap:wrap;align-items:flex-start;gap:5px;max-width:100%}
.nk-st{display:flex;flex-direction:column;max-width:100%;padding:10px 15px;border:1px solid #eeeeee;border-radius:15px;background:#ffffff}
.nk-n{font-size:20px;line-height:1.25;font-weight:500;letter-spacing:-.25px;color:#EE0000;white-space:nowrap}
.nk-cap{font-size:15px;line-height:1.4;color:#110000}
.nk-q{display:flex;flex-direction:column;gap:5px;align-self:stretch;margin:5px 0 0;padding:13px 18px;border:1px solid #eeeeee;border-radius:15px;background:#ffffff}
.nk-qt{margin:0;font-size:15px;line-height:1.4;color:#110000}
.nk-qa{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:15px;line-height:1.4;color:#999999}
.nk-v{display:flex;align-items:center;justify-content:space-between;gap:10px;align-self:stretch;font-size:15px;line-height:1.4;color:#999999}
.nk-ck{flex:none;width:24px;height:24px;margin:-2px 0;background:CHECK center/contain no-repeat}
@media screen and (max-width:1199px){
.nk{max-width:640px}
.nk-t{min-height:0}
.nk-tg{flex-direction:column;align-items:flex-start}
}
@media screen and (max-width:639px){
.nk{max-width:none;padding:0 20px}
.nk-c{padding:20px;border-radius:20px}
.nk-c+.nk-c{margin-top:10px}
.nk-h{width:calc(100% + 40px);margin:-20px;padding:20px;border-radius:20px}
.nk-t{font-size:20px;line-height:1.15}
.nk-a{width:15px;height:10px;margin-top:7px}
.nk-tag,.nk-tagr{padding:5px 12px;font-size:12px;line-height:1.1}
.nk-tag{white-space:normal}
.nk-p,.nk-l,.nk-cap,.nk-v{font-size:14px}
.nk-st{padding:9px 12px;border-radius:12px}
.nk-n{font-size:17px}
.nk-q{padding:11px 15px;border-radius:12px}
.nk-qt,.nk-qa{font-size:12px;line-height:1.4}
.nk-bw{padding-bottom:0}
.nk-v{align-items:flex-end}
.nk-ck{width:17px;height:17px;margin:0}
}
@media (prefers-reduced-motion:reduce){
.nk-bg,.nk-a,.nk-b{transition:none}
}
'''.strip()

# ───────────────────────── JS (строки только в обратных апострофах) ─────────────────────────
JS = '''
(function(){
var roots=document.querySelectorAll(`.nk`);
Array.prototype.forEach.call(roots,function(root){
var cards=Array.prototype.slice.call(root.querySelectorAll(`.nk-c`));
function set(card,open){
if(open){card.setAttribute(`data-open`,``);}else{card.removeAttribute(`data-open`);}
var b=card.querySelector(`.nk-h`);
if(b){b.setAttribute(`aria-expanded`,open?`true`:`false`);}
}
cards.forEach(function(card){
var b=card.querySelector(`.nk-h`);
if(!b){return;}
b.addEventListener(`click`,function(){
var open=!card.hasAttribute(`data-open`);
cards.forEach(function(c){set(c,c===card&&open);});
if(!open){return;}
setTimeout(function(){
var top=card.getBoundingClientRect().top;
if(top<100){window.scrollBy({top:top-100,behavior:`smooth`});}
},320);
});
});
});
})();
'''.strip()


def esc(s):
    # кавычек в текстах быть не должно: проверяется ниже для всего блока
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('&amp;nbsp;', '&nbsp;')


def card_html(i, c, is_open):
    n = i + 1
    check = '<i class=nk-ck aria-hidden=true></i>'
    parts = []
    parts.append(f'<div class=nk-tg><span class=nk-tag>{esc(typo(c["tags"][0]))}</span>'
                 f'<span class=nk-tagr>{esc(typo(c["kind"]))}</span></div>')
    # data-m — абзацы с отступом 10px сверху (остальные стоят через 5px), как в макете
    parts.append(f'<p class=nk-p data-m><span class=nk-i>Задача:</span> {esc(typo(c["task"]))}</p>')
    steps = '<br>'.join(esc(typo(f'{k}. {s}')) for k, s in enumerate(c['steps'], 1))
    parts.append(f'<p class=nk-p><span class=nk-i>Что сделала команда neoved:</span><br>{steps}</p>')
    stats = ''.join(f'<div class=nk-st><span class=nk-n>{esc(typo(v))}</span><span class=nk-cap>{esc(typo(cap))}</span></div>'
                    for v, cap in c['stats'])
    parts.append(f'<div class=nk-r><div class=nk-l>Результат:</div><div class=nk-s>{stats}</div></div>')
    parts.append(f'<p class=nk-p data-m><span class=nk-i>Что изменилось:</span> {esc(typo(c["changed"]))}</p>')
    # Галочка с сайта стоит справа в строке автора цитаты и в строке «Проверено: …» — как на странице кейсов
    if c.get('quote'):
        parts.append(f'<blockquote class=nk-q><p class=nk-qt>{esc(typo(c["quote"]))}</p>'
                     f'<footer class=nk-qa><span>{esc(typo(c["author"]))}</span>{check}</footer></blockquote>')
    elif c.get('verified'):
        parts.append(f'<div class=nk-v><span>{esc(typo(c["verified"]))}</span>{check}</div>')
    body = ''.join(parts)
    opn = ' data-open' if is_open else ''
    exp = 'true' if is_open else 'false'
    return (f'<div class=nk-c{opn}><i class=nk-bg aria-hidden=true></i>'
            f'<div class=nk-hd role=heading aria-level=3>'
            f'<button type=button class=nk-h id=nk-t{n} aria-expanded={exp} aria-controls=nk-b{n}>'
            f'<span class=nk-t><span class=nk-red>Кейс&nbsp;{n}.</span> {esc(typo(c["title"]))}</span><i class=nk-a aria-hidden=true></i></button></div>'
            f'<div class=nk-b id=nk-b{n} role=region aria-labelledby=nk-t{n}><div class=nk-bi><div class=nk-bw>{body}</div></div></div></div>')


def build_block():
    css = CSS.replace('ARROW', data_uri(ARROW_SVG)).replace('CHECK', data_uri(CHECK_SVG))
    cards = '\n'.join(card_html(i, c, i == 0) for i, c in enumerate(CASES))
    html = f'<style>\n{css}\n</style>\n<div class=nk>\n{cards}\n</div>\n<script>\n{JS}\n</script>\n'
    bad = [ch for ch in ('"', "'", '--', '...') if ch in html]
    assert not bad, f'в коде для Tilda есть {bad}'
    return html


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'ru-RU,ru;q=0.9'})
    return urllib.request.urlopen(req, timeout=60).read().decode('utf-8')


def build_test(block):
    html = fetch(SRC_URL)
    n0 = len(html)
    # аналитика сайта не должна считать визиты тестовой копии
    html = re.sub(r'<script[^>]*data-tilda-cookie-type="analytics"[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<script[^>]*>(?:(?!</script>).)*tildastatcookie.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<noscript>\s*<div>\s*<img[^>]*mc\.yandex[^>]*>\s*</div>\s*</noscript>', '', html, flags=re.S)
    assert 'gtagTrackerID' not in html and 'mc.yandex.ru/metrika' not in html, 'аналитика осталась'
    # внутренние ссылки — на боевой домен
    html = re.sub(r'(\s(?:href|src|action)=")/(?!/)', r'\1https://neoved.io/', html)
    # закрыть от индексации
    html = re.sub(r'<meta name="robots"[^>]*>\s*', '', html)
    html, k = re.subn(r'<title>([^<]*)</title>',
                      lambda m: f'<title>Тест · {m.group(1)}</title>\n'
                                '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">\n'
                                '<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet">', html, count=1)
    assert k == 1 and 'noindex' in html, 'нет тега noindex'
    # шрифт Onest сайт отдаёт с нэовэд.рф без заголовка CORS, с другого хоста он не грузится:
    # на тестовой копии берём тот же Onest с Google Fonts (на самом сайте строка не нужна)
    html = html.replace('</head>', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
                        '<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500&display=swap" rel="stylesheet">\n</head>', 1)
    # шесть Zero-блоков «Кейс 1» … «Кейс 6» заменяем одним блоком T123 с нашим кодом
    s = html.index(f'<div id="{CASE_RECS[0]}"')
    last = html.index(f'<div id="{CASE_RECS[-1]}"')
    assert s < last, 'блоки кейсов идут не по порядку'
    e = html.index('<div id="rec', last + 10)
    for rec in CASE_RECS[1:]:
        assert s < html.index(f'<div id="{rec}"') < e, f'{rec} вне заменяемого участка'
    rec = (f'<div id="{CASE_RECS[0]}" class="r t-rec" data-record-type="131" data-test-insert="neoved-keysy">'
           ' <!-- T123 --> <div class="t123"> <div class="t-container_100 t123__centeredContainer"> <div class="t-width t-width_100 ">'
           ' <!-- nominify begin -->\n' + block + '<!-- nominify end --> </div> </div> </div> </div>\n')
    html = html[:s] + rec + html[e:]
    OUT_TEST.write_text(html, encoding='utf-8')
    print(f'{OUT_TEST.name}: {len(html)//1024} КБ (исходник {n0//1024} КБ)')


def main():
    block = build_block()
    OUT_BLOCK.write_text(block, encoding='utf-8')
    print(f'{OUT_BLOCK.name}: {len(block.encode("utf-8"))//1024} КБ, кейсов {len(CASES)}, nbsp {block.count("&nbsp;")}')
    if '--no-test' not in sys.argv:
        build_test(block)


if __name__ == '__main__':
    sys.exit(main())
