/* ════════════════════════════════════════════════════════════════════════
   syferpu.top/portu — серверная надстройка над карточками:
   вход по паролю, синхронизация прогресса между устройствами, перенос
   прогресса со старой страницы на GitHub и видеозвонки с ИИ-персонажами.

   Подключается после основного скрипта страницы и пользуется его глобальными
   S, save(), go(), views, CARDS, BY_ID, renderHome() и т. д.
   ════════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';
const API = 'api';
const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let M = null;   // motion (подгружается с CDN; без него всё работает, просто без анимаций)
import('https://cdn.jsdelivr.net/npm/motion@11/+esm').then(m => { M = m; }).catch(() => {});
const anim = (el, kf, opt) => { if(M && !reduced && el) try{ return M.animate(el, kf, opt); }catch(e){} };

/* ── иконки (stroke 1.9, как в шапке страницы) ── */
const I = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  replay: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  slow: '<path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z"/><path d="M12 7v5l3 2"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  cc: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3"/>',
  kb: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};

/* ── сеть ── */
async function api(path, opt = {}){
  const o = { credentials: 'same-origin', ...opt, headers: { ...(opt.headers || {}) } };
  if(opt.json !== undefined){ o.body = JSON.stringify(opt.json); o.headers['content-type'] = 'application/json'; delete o.json; }
  const r = await fetch(`${API}/${path}`, o);
  if(r.status === 401){ const e = new Error('нужен вход'); e.status = 401; throw e; }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if(!r.ok){ const e = new Error((data && data.error) || `Ошибка ${r.status}`); e.status = r.status; throw e; }
  return data;
}

/* ── всплывающее сообщение ── */
function toast(text, ms = 3500){
  let box = $('#pt-toast');
  if(!box){ box = h('<div id="pt-toast" class="pt-toast" role="status" aria-live="polite"></div>'); document.body.appendChild(box); }
  box.textContent = text; box.classList.add('show');
  clearTimeout(box._t); box._t = setTimeout(() => box.classList.remove('show'), ms);
}

/* ════════════════ СЛИЯНИЕ ПРОГРЕССА (как app/merge.py) ════════════════ */
function newer(a, b, key){
  const ta = a.t || 0, tb = b.t || 0;
  return ta !== tb ? ta > tb : (a[key] || 0) > (b[key] || 0);
}
function mergeState(base, inc){
  base = base || {}; inc = inc || {};
  const resetAt = Math.max(base.resetAt || 0, inc.resetAt || 0);
  const out = { resetAt };
  for(const [name, key] of [['cards', 'seen'], ['log', 'n']]){
    const a = base[name] || {}, b = inc[name] || {}, m = {};
    for(const k of new Set([...Object.keys(a), ...Object.keys(b)])){
      let va = a[k] && typeof a[k] === 'object' ? a[k] : null;
      let vb = b[k] && typeof b[k] === 'object' ? b[k] : null;
      if(resetAt){ if(va && (va.t || 0) <= resetAt) va = null; if(vb && (vb.t || 0) <= resetAt) vb = null; }
      if(!va && !vb) continue;
      m[k] = !va ? vb : !vb ? va : (newer(vb, va, key) ? vb : va);
    }
    out[name] = m;
  }
  const days = new Set([...(base.days || []), ...(inc.days || [])]);
  out.days = [...days].filter(d => typeof d === 'string' && ((out.log[d] || { n: 1 }).n || 0) > 0
                                   && (!resetAt || d in out.log)).sort();
  const sa = base.sessionTs || 0, sb = inc.sessionTs || 0;
  if(sb > sa){ out.session = inc.session ?? null; out.sessionTs = sb; }
  else { out.session = base.session ?? null; out.sessionTs = sa; }
  if(resetAt && out.sessionTs <= resetAt) out.session = null;
  return out;
}

/* ════════════════ СИНХРОНИЗАЦИЯ ════════════════
   Каждое сохранение уходит на сервер через секунду (пачкой). Отправляются
   только изменённые карточки и дни — по метке t. При открытии страницы и
   возвращении во вкладку прогресс подтягивается с сервера. */
const SY_KEY = 'portu-sync';
const sy = (() => { try{ return JSON.parse(localStorage.getItem(SY_KEY) || '{}'); }catch(e){ return {}; } })();
const sySave = () => { try{ localStorage.setItem(SY_KEY, JSON.stringify(sy)); }catch(e){} };
let me = null, pushTimer = null, pushing = false, lastSessionJSON = JSON.stringify(S.session ?? null);

function wipeLocal(){
  S = { cards: {}, log: {}, days: [], theme: S.theme, session: null, sessionTs: 0, resetAt: 0 };
  try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){}
}

window.__onSave = () => {
  const sj = JSON.stringify(S.session ?? null);
  if(sj !== lastSessionJSON){ lastSessionJSON = sj; S.sessionTs = Date.now();
    try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){} }
  if(!me) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 1200);
  setSyncBadge('wait');
};

function changes(all){
  const since = all ? -1 : (sy.pushedT || 0);
  const pick = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => (v.t || 0) > since));
  return { cards: pick(S.cards), log: pick(S.log), days: S.days, session: S.session ?? null,
           sessionTs: S.sessionTs || 0, resetAt: S.resetAt || 0 };
}
function maxT(){
  let m = sy.pushedT || 0;
  for(const v of Object.values(S.cards)) if((v.t || 0) > m) m = v.t;
  for(const v of Object.values(S.log)) if((v.t || 0) > m) m = v.t;
  return m;
}
async function push(all = false){
  if(!me) return;
  if(pushing){ clearTimeout(pushTimer); pushTimer = setTimeout(push, 800); return; }
  pushing = true;
  const upto = maxT();
  try{
    const r = await api('state', { method: 'PUT', json: changes(all) });
    sy.pushedT = upto;
    if(sy.rev && r.rev > sy.rev + 1) await pull(true);   // за это время писало другое устройство
    sy.rev = r.rev; sySave();
    setSyncBadge('ok');
  }catch(e){
    setSyncBadge(e.status === 401 ? 'out' : 'off');
    if(e.status === 401) showLogin();
  }finally{ pushing = false; }
}
async function pull(quiet){
  if(!me) return;
  try{
    const { state, rev } = await api('state');
    const studying = !$('#v-study').hidden && S.session;
    if((state.resetAt || 0) > (S.resetAt || 0)){        // на другом устройстве нажали «Обнулить всё»
      const theme = S.theme; S = { ...mergeState({}, state), theme };
    }else{
      const merged = mergeState(S, state);
      if(studying){ merged.session = S.session; merged.sessionTs = Math.max(S.sessionTs || 0, state.sessionTs || 0) + 1; }
      merged.theme = S.theme;
      S = merged;
    }
    lastSessionJSON = JSON.stringify(S.session ?? null);
    try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){}
    sy.rev = rev; sySave();
    setSyncBadge('ok');
    refreshViews();
    if((maxT() > (sy.pushedT || 0))) push();             // у нас есть то, чего нет на сервере
  }catch(e){
    setSyncBadge(e.status === 401 ? 'out' : 'off');
    if(e.status === 401) showLogin();
    else if(!quiet) console.warn('pull', e);
  }
}
function refreshViews(){
  if(!$('#v-home').hidden) renderHome();
  if(!$('#v-stats').hidden) renderStats();
  if(!$('#v-words').hidden) renderWords();
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible') pull(true);
  else if(me && maxT() > (sy.pushedT || 0)){
    // уходим со страницы — отправляем немедленно (keepalive переживёт закрытие вкладки)
    fetch(`${API}/state`, { method: 'PUT', keepalive: true, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes(false)) }).catch(() => {});
  }
});
addEventListener('online', () => { if(me) push(); });

function setSyncBadge(st){
  const b = $('#pt-sync'); if(!b) return;
  const map = { ok: ['Синхронизировано', 'ok'], wait: ['Сохраняю…', 'wait'], off: ['Нет связи — сохранено на устройстве', 'off'], out: ['Нужен вход', 'off'] };
  const [t, c] = map[st] || map.ok;
  b.dataset.st = c; b.title = t; b.setAttribute('aria-label', t);
}

/* ════════════════ ПЕРЕНОС СО СТАРОЙ СТРАНИЦЫ ════════════════
   cartoes-pt.html на GitHub открывает нас с #import=z.<deflate-raw base64url>
   (или j.<json base64url>). Данные лежат во фрагменте — на сервер он не уходит. */
const IMPORT_KEY = 'portu-import';
async function readImportHash(){
  const m = location.hash.match(/import=([zj])\.([A-Za-z0-9_-]+)/);
  if(!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try{
    const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
    const bin = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
    let text;
    if(m[1] === 'z'){
      const ds = new DecompressionStream('deflate-raw');
      text = await new Response(new Blob([bin]).stream().pipeThrough(ds)).text();
    }else text = new TextDecoder().decode(bin);
    const data = JSON.parse(text);
    if(data && data.cards){ localStorage.setItem(IMPORT_KEY, JSON.stringify(data)); }
  }catch(e){ toast('Не удалось прочитать перенесённый прогресс: ' + e.message, 6000); }
}
async function applyImport(){
  let data; try{ data = JSON.parse(localStorage.getItem(IMPORT_KEY) || 'null'); }catch(e){}
  if(!data) return;
  const n = Object.keys(data.cards || {}).length;
  S = { ...mergeState(S, { cards: data.cards, log: data.log, days: data.days,
                           session: data.session, sessionTs: data.session ? 1 : 0 }), theme: S.theme };
  try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){}
  localStorage.removeItem(IMPORT_KEY);
  await push(true);
  refreshViews();
  toast(`Прогресс перенесён: ${n} ${plural(n, 'слово', 'слова', 'слов').replace(/^\d+ /, '')}. Он уже на сервере и виден на всех устройствах.`, 7000);
}

// ссылка с #import открыта в уже загруженной вкладке — страница не перезагружается, ловим смену фрагмента
addEventListener('hashchange', async () => { await readImportHash(); if(me) applyImport(); });

/* ════════════════ ВХОД ════════════════ */
function showLogin(){
  if($('#pt-login')) return;
  const box = h(`<div class="pt-login" id="pt-login" role="dialog" aria-modal="true" aria-labelledby="pt-login-h">
    <form class="pt-login-card" novalidate>
      <div class="logo-mark pt-login-mark">PT</div>
      <h1 id="pt-login-h">Вход</h1>
      <p class="pt-login-sub">Пароль — это ваш профиль. Введите его один раз на каждом устройстве,
        и прогресс будет общим на телефоне и компьютере.</p>
      <label class="pt-field"><span>Пароль</span>
        <div class="pt-pass"><input id="pt-pw" type="password" autocomplete="current-password" minlength="4" required
            enterkeyhint="go" aria-describedby="pt-login-err">
          <button type="button" class="pt-eye" aria-label="Показать пароль">${I(IC.eye, 19)}</button></div></label>
      <p class="pt-err" id="pt-login-err" role="alert"></p>
      <div class="pt-new" hidden>
        <p>Профиля с таким паролем ещё нет. Создать новый? Прогресс начнётся с нуля,
          а если вы ошиблись в пароле — введите его заново.</p>
        <div class="pt-row"><button type="button" class="btn btn-primary" id="pt-create">Создать профиль</button>
          <button type="button" class="btn btn-ghost" id="pt-retry">Ввести другой</button></div>
      </div>
      <button class="btn btn-primary pt-go" type="submit">Войти</button>
    </form></div>`);
  document.body.appendChild(box);
  document.documentElement.classList.add('pt-locked');
  const pw = $('#pt-pw', box), errEl = $('#pt-login-err', box), go = $('.pt-go', box), nw = $('.pt-new', box);
  setTimeout(() => pw.focus(), 50);
  $('.pt-eye', box).onclick = () => { pw.type = pw.type === 'password' ? 'text' : 'password'; };
  anim($('.pt-login-card', box), { opacity: [0, 1], transform: ['translateY(16px) scale(.98)', 'translateY(0px) scale(1)'] }, { duration: .35 });
  const attempt = async (create) => {
    errEl.textContent = '';
    const password = pw.value.trim();
    if(password.length < 4){ errEl.textContent = 'Пароль — минимум 4 символа.'; pw.focus(); return; }
    go.disabled = true; go.textContent = 'Проверяю…';
    try{
      const r = await api('login', { method: 'POST', json: { password, create } });
      if(r.exists === false){ nw.hidden = false; go.hidden = true; $('#pt-create', box).focus(); return; }
      await onLoggedIn(r.user, r.created);
      document.documentElement.classList.remove('pt-locked');
      box.remove();
    }catch(e){
      errEl.textContent = e.status === 429 ? e.message : (navigator.onLine ? e.message : 'Нет интернета — войти можно только онлайн.');
    }finally{ go.disabled = false; go.textContent = 'Войти'; }
  };
  $('form', box).onsubmit = e => { e.preventDefault(); attempt(false); };
  $('#pt-create', box).onclick = () => attempt(true);
  $('#pt-retry', box).onclick = () => { nw.hidden = true; go.hidden = false; pw.value = ''; pw.focus(); };
}

async function onLoggedIn(user, created){
  me = user;
  if(sy.owner && sy.owner !== user.id){ wipeLocal(); sy.pushedT = 0; sy.rev = 0; }   // устройство сменило хозяина
  if(!sy.owner && !created){ sy.pushedT = 0; }
  sy.owner = user.id; sySave();
  await pull(true);
  await applyImport();
  if(created && Object.keys(S.cards).length) await push(true);
  toast(created ? 'Профиль создан. Теперь войдите этим паролем на других устройствах.' : 'Вход выполнен — прогресс синхронизирован.');
  mountUserBits();
  loadMeta().then(() => { if(!$('#v-call').hidden) renderCallHome(); }).catch(() => {});
}

async function boot(){
  await readImportHash();
  try{
    const u = await api('me');
    me = { id: u.id, level: u.level };
    if(sy.owner && sy.owner !== u.id){ wipeLocal(); sy.pushedT = 0; sy.rev = 0; }
    sy.owner = u.id; sySave();
    await pull(true);
    await applyImport();
    mountUserBits();
  }catch(e){
    if(e.status === 401 || !sy.owner) showLogin();
    else { mountUserBits(); setSyncBadge('off'); }          // офлайн, но устройство уже вошло
  }
}

/* ── то, что появляется после входа: значок синхронизации, «Выйти», обнуление через сервер ── */
let userBitsMounted = false;
function mountUserBits(){
  if(userBitsMounted) return; userBitsMounted = true;
  const hd = $('.hd');
  const badge = h(`<span id="pt-sync" class="pt-sync" data-st="ok" role="img" aria-label="Синхронизировано" title="Синхронизировано"></span>`);
  hd.insertBefore(badge, $('#theme-btn'));
  const data = $('#export').parentElement;
  const hint = data.querySelector('.hint');
  if(hint) hint.textContent = 'Прогресс сохраняется автоматически и синхронизируется между всеми устройствами, где вы вошли этим паролем.';
  const out = h(`<button class="btn btn-ghost" id="pt-logout">${I(IC.out, 17)} Выйти на этом устройстве</button>`);
  data.insertBefore(out, hint);
  out.onclick = async () => {
    if(!confirm('Выйти из профиля на этом устройстве?\n\nПрогресс останется на сервере, вернуться можно тем же паролем.')) return;
    try{ await push(); await api('logout', { method: 'POST' }); }catch(e){}
    wipeLocal(); localStorage.removeItem(SY_KEY); location.reload();
  };
  $('#reset').onclick = async () => {
    if(!confirm('Обнулить весь прогресс?\n\nСотрутся отметки «знаю / не знаю», интервалы, статистика и серия дней — на всех устройствах. Вернуть будет нельзя.')) return;
    try{
      const r = await api('state/reset', { method: 'POST' });
      S = { cards: {}, log: {}, days: [], theme: S.theme, session: null, sessionTs: r.resetAt, resetAt: r.resetAt };
      lastSessionJSON = 'null';
      try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){}
      sy.pushedT = r.resetAt; sy.rev = r.rev; sySave();
      renderStats(); renderHome(); toast('Прогресс обнулён на всех устройствах.');
    }catch(e){ alert('Не получилось: ' + e.message); }
  };
  const foot = $('#foot-img')?.parentElement;
  if(foot) foot.lastChild.textContent = '. Прогресс синхронизируется между устройствами.';
}

/* ════════════════ ЗВОНКИ: ЭКРАН ВЫБОРА ════════════════ */
let META = null, CHARS = [], selChar = null;
const voicePref = id => { try{ return localStorage.getItem('portu-voice-' + id); }catch(e){ return null; } };
const setVoicePref = (id, v) => { try{ localStorage.setItem('portu-voice-' + id, v); }catch(e){} };
let topic = (() => { try{ return localStorage.getItem('portu-topic') || 'livre'; }catch(e){ return 'livre'; } })();
const TOPIC_RU = { livre: 'Свободная тема', deck: 'Слова из колоды', comida: 'Еда и кафе', cidade: 'Город',
                   familia: 'Семья и друзья', trabalho: 'Работа и учёба', viagem: 'Путешествия', compras: 'Покупки' };

function mountCallView(){
  // кнопка в шапке
  const nav = $('.nav');
  nav.appendChild(h(`<button data-go="call">Звонки</button>`));
  views.call = 'v-call';
  // раздел
  $('main').appendChild(h(`<section class="view wrap" id="v-call" hidden>
    <h1>Звонки</h1>
    <p class="lead">Поговорите голосом с персонажем по-португальски. Не поняли — спросите по-русски,
      он объяснит и повторит. После звонка — разбор с подсказками.</p>
    <div class="sec-h"><h2>С кем говорим</h2><span class="hint" id="pt-level"></span></div>
    <div class="pt-chars" id="pt-chars" role="radiogroup" aria-label="Персонаж"></div>
    <div class="card pt-setup" id="pt-setup"></div>
    <div class="sec-h"><h2>Недавние звонки</h2></div>
    <div class="pt-recents" id="pt-recents"></div>
  </section>`));
  document.addEventListener('click', e => {
    if(e.target.closest('[data-go="call"]')) renderCallHome();
  });
  // карточка на главной
  const home = $('#v-home');
  const lead = home.querySelector('.lead') || home.querySelector('h1');
  const card = h(`<button class="card pt-homecall" data-go="call" aria-label="Открыть звонки с персонажами">
      <div class="pt-homecall-av" id="pt-homecall-av" aria-hidden="true"></div>
      <div class="pt-homecall-tx"><b>Поговорить с персонажем</b>
        <span>Видеозвонок по-португальски с Биа, Каю, Пеппой, Стичем, Лунтиком или вашим персонажем</span></div>
      <span class="pt-homecall-go" aria-hidden="true">${I(IC.phone, 20)}</span></button>`);
  lead.after(card);
}

async function loadMeta(){
  if(!META) META = await api('meta');
  const r = await api('characters');
  CHARS = r.characters;
  const av = $('#pt-homecall-av');
  if(av) av.innerHTML = CHARS.filter(c => c.av).slice(0, 3).map(c => `<img src="${c.av}" alt="">`).join('');
}

async function renderCallHome(){
  if(!me) return;
  try{ await loadMeta(); }catch(e){ $('#pt-chars').innerHTML = `<p class="hint">Не загрузилось: ${esc(e.message)}</p>`; return; }
  $('#pt-level').textContent = `уровень ${me.level || 'A2'} · меняется по вашим оценкам звонков`;
  if(!selChar || !CHARS.find(c => c.id === selChar)) selChar = (() => { try{ return localStorage.getItem('portu-char'); }catch(e){ return null; } })();
  if(!CHARS.find(c => c.id === selChar)) selChar = CHARS[0]?.id;
  const grid = $('#pt-chars');
  grid.innerHTML = CHARS.map(c => `
    <button class="pt-char" role="radio" aria-checked="${c.id === selChar}" data-id="${esc(c.id)}">
      <span class="pt-char-img">${c.img ? `<img src="${c.img}" alt="" loading="lazy">` : `<span class="pt-char-noimg">${esc(c.name[0] || '?')}</span>`}
        ${c.status === 'cartoon_pending' ? `<span class="pt-badge">${I(IC.spark, 13)} Grok рисует</span>` : ''}</span>
      <span class="pt-char-name">${esc(c.name)}</span>
      <span class="pt-char-sub">${c.mine ? 'ваш' : 'встроенный'} · ${esc(voiceLabel(c.voice))}</span>
      ${c.mine ? `<span class="pt-char-edit" role="button" tabindex="0" data-edit="${esc(c.id)}" aria-label="Изменить ${esc(c.name)}">${I(IC.edit, 15)}</span>` : ''}
    </button>`).join('') + `
    <button class="pt-char pt-char-add" id="pt-add">
      <span class="pt-char-img">${I(IC.plus, 30)}</span>
      <span class="pt-char-name">Добавить</span><span class="pt-char-sub">из фото — станет мультяшным</span></button>`;
  grid.onclick = e => {
    const ed = e.target.closest('[data-edit]');
    if(ed){ e.stopPropagation(); openCharSheet(CHARS.find(c => c.id === ed.dataset.edit)); return; }
    if(e.target.closest('#pt-add')){ openCharSheet(null); return; }
    const b = e.target.closest('.pt-char[data-id]');
    if(b){ selChar = b.dataset.id; try{ localStorage.setItem('portu-char', selChar); }catch(_){}
      grid.querySelectorAll('.pt-char[data-id]').forEach(x => x.setAttribute('aria-checked', x.dataset.id === selChar));
      renderSetup(); }
  };
  renderSetup();
  renderRecents();
  if(CHARS.some(c => c.status === 'cartoon_pending')) pollPending();
}
let pollTimer = null;
function pollPending(){
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if($('#v-call').hidden) return;
    const before = CHARS.filter(c => c.status === 'cartoon_pending').map(c => c.id);
    await loadMeta().catch(() => {});
    const ready = CHARS.filter(c => before.includes(c.id) && c.status !== 'cartoon_pending');
    if(ready.length){ renderCallHome(); ready.forEach(c => toast(c.note ? `${c.name}: ${c.note}` : `${c.name} теперь мультяшный — готово!`)); }
    else pollPending();
  }, 20000);
}
const voiceLabel = id => (META?.voices.find(v => v.id === id) || {}).label || id;

function renderSetup(){
  const c = CHARS.find(x => x.id === selChar);
  const box = $('#pt-setup');
  if(!c){ box.innerHTML = '<p class="hint">Выберите персонажа.</p>'; return; }
  const voice = voicePref(c.id) || c.voice;
  box.innerHTML = `
    <div class="pt-setup-row"><span class="pt-lbl" id="pt-v-l">Голос</span>
      <div class="pt-voices" role="radiogroup" aria-labelledby="pt-v-l">${META.voices.map(v => `
        <button class="chip" role="radio" aria-pressed="${v.id === voice}" aria-checked="${v.id === voice}" data-v="${v.id}">${esc(v.label)}</button>`).join('')}</div>
      <button class="btn btn-ghost pt-listen" id="pt-listen">${I(IC.play, 15)} Послушать</button></div>
    <div class="pt-setup-row"><span class="pt-lbl" id="pt-t-l">Тема</span>
      <div class="pt-voices" role="radiogroup" aria-labelledby="pt-t-l">${META.topics.map(t => `
        <button class="chip" role="radio" aria-pressed="${t === topic}" aria-checked="${t === topic}" data-t="${t}">${TOPIC_RU[t] || t}</button>`).join('')}</div></div>
    <button class="btn btn-primary pt-callbtn" id="pt-call">${I(IC.phone, 19)} Позвонить: ${esc(c.name)}</button>
    ${c.note ? `<p class="hint">${esc(c.note)}</p>` : ''}`;
  box.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
    setVoicePref(c.id, b.dataset.v);
    box.querySelectorAll('[data-v]').forEach(x => { x.setAttribute('aria-pressed', x === b); x.setAttribute('aria-checked', x === b); });
  });
  box.querySelectorAll('[data-t]').forEach(b => b.onclick = () => {
    topic = b.dataset.t; try{ localStorage.setItem('portu-topic', topic); }catch(_){}
    box.querySelectorAll('[data-t]').forEach(x => { x.setAttribute('aria-pressed', x === b); x.setAttribute('aria-checked', x === b); });
  });
  $('#pt-listen').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try{
      const blob = await api('tts', { method: 'POST', json: { voice: voicePref(c.id) || c.voice,
        segments: [{ lang: 'pt', text: 'Oi! Tudo bem? Vamos conversar um pouco em português?' },
                   { lang: 'ru', text: 'А если что-то непонятно — спросите по-русски.' }] } });
      const a = new Audio(URL.createObjectURL(blob)); a.onended = () => URL.revokeObjectURL(a.src); await a.play();
    }catch(err){ toast('Не получилось: ' + err.message); }
    btn.disabled = false;
  };
  $('#pt-call').onclick = () => startCall(c, voicePref(c.id) || c.voice, topic);
}

async function renderRecents(){
  const box = $('#pt-recents');
  try{
    const { calls } = await api('calls');
    if(!calls.length){ box.innerHTML = `<div class="card"><p class="hint" style="margin:0">Здесь появятся ваши звонки — их можно будет перечитать целиком.</p></div>`; return; }
    const img = id => CHARS.find(c => c.id === id)?.av;
    box.innerHTML = `<div class="card pt-rec-list">` + calls.map(c => `
      <button class="pt-rec" data-call="${c.id}">
        <span class="pt-rec-av">${img(c.char_id) ? `<img src="${img(c.char_id)}" alt="">` : ''}</span>
        <span class="pt-rec-tx"><b>${esc(c.title)}</b><span>${esc(c.char_name)} · ${fmtDate(c.started_at)} · ${plural(Math.floor(c.turns / 2), 'реплика', 'реплики', 'реплик')}</span></span>
        <span class="pt-rec-go" aria-hidden="true">›</span></button>`).join('') + `</div>`;
    box.onclick = e => { const b = e.target.closest('[data-call]'); if(b) openTranscript(b.dataset.call); };
  }catch(e){ box.innerHTML = `<p class="hint">История не загрузилась: ${esc(e.message)}</p>`; }
}
const fmtDate = s => {
  const d = new Date(s * 1000), t = new Date();
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if(d.toDateString() === t.toDateString()) return 'сегодня, ' + hm;
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if(d.toDateString() === y.toDateString()) return 'вчера, ' + hm;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ', ' + hm;
};

/* ── добавить / изменить своего персонажа ── */
function openCharSheet(ch){
  const isNew = !ch;
  const presets = META.presets || [];
  const sheet = h(`<div class="pt-sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="pt-sh-h">
    <div class="pt-sheet">
      <div class="pt-sheet-hd"><h2 id="pt-sh-h">${isNew ? 'Новый персонаж' : 'Персонаж: ' + esc(ch.name)}</h2>
        <button class="icon-btn" data-close aria-label="Закрыть">${I(IC.x, 20)}</button></div>
      ${isNew ? `
      <label class="pt-photo" id="pt-photo">
        <input type="file" accept="image/*" id="pt-file" hidden>
        <span class="pt-photo-ph">${I(IC.camera, 30)}<b>Выбрать фото</b><span>Лицо крупно и при хорошем свете. Grok сделает из фото мультяшного персонажа — это займёт пару минут.</span></span>
        <img id="pt-prev" alt="Выбранное фото" hidden></label>` : `
      <div class="pt-photo pt-photo-have"><img src="${ch.av || ch.img}" alt="${esc(ch.name)}"></div>`}
      ${isNew && presets.length ? `<div class="pt-field"><span>Готовый характер</span><div class="pt-voices">${presets.map(p => `
        <button type="button" class="chip" data-preset="${p.id}" aria-pressed="false">${esc(p.name)}</button>`).join('')}</div></div>` : ''}
      <label class="pt-field"><span>Имя</span><input id="pt-name" maxlength="40" value="${esc(ch?.name || '')}" placeholder="Например, Марина" autocomplete="off"></label>
      <label class="pt-field"><span>Голос</span><select id="pt-voice">${META.voices.map(v => `
        <option value="${v.id}" ${v.id === (ch?.voice || 'francisca') ? 'selected' : ''}>${esc(v.label)} — ${esc(v.kind)}</option>`).join('')}</select></label>
      <label class="pt-field"><span>Характер и о чём говорить <i>(необязательно)</i></span>
        <textarea id="pt-persona" rows="3" maxlength="800" placeholder="Например: жена моего руководителя, любит йогу и путешествия, живёт в Рио">${esc(ch?.persona || '')}</textarea></label>
      ${isNew ? `<label class="pt-check"><input type="checkbox" id="pt-cartoon" checked> Сделать мультяшным через Grok</label>` : ''}
      <p class="pt-err" id="pt-sh-err" role="alert"></p>
      <div class="pt-row pt-sheet-ft">
        ${isNew ? '' : `<button class="btn btn-ghost pt-danger" id="pt-del">${I(IC.trash, 16)} Удалить</button>
          <button class="btn btn-ghost" id="pt-recart">${I(IC.spark, 16)} Перерисовать</button>`}
        <button class="btn btn-primary" id="pt-save">${isNew ? 'Добавить' : 'Сохранить'}</button></div>
    </div></div>`);
  document.body.appendChild(sheet);
  document.documentElement.classList.add('pt-locked');
  anim($('.pt-sheet', sheet), { transform: ['translateY(40px)', 'translateY(0px)'], opacity: [0, 1] }, { duration: .3 });
  const close = () => { sheet.remove(); document.documentElement.classList.remove('pt-locked'); };
  sheet.addEventListener('click', e => { if(e.target === sheet || e.target.closest('[data-close]')) close(); });
  sheet.addEventListener('keydown', e => { if(e.key === 'Escape') close(); });
  const errEl = $('#pt-sh-err', sheet);
  let file = null;
  if(isNew){
    $('#pt-file', sheet).onchange = async e => {
      file = e.target.files[0]; if(!file) return;
      const img = $('#pt-prev', sheet); img.src = URL.createObjectURL(file); img.hidden = false;
      $('.pt-photo-ph', sheet).hidden = true;
    };
    sheet.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      const p = presets.find(x => x.id === b.dataset.preset);
      sheet.querySelectorAll('[data-preset]').forEach(x => x.setAttribute('aria-pressed', x === b));
      $('#pt-name', sheet).value = p.name; $('#pt-voice', sheet).value = p.voice; $('#pt-persona', sheet).value = p.persona;
    });
  }
  $('#pt-save', sheet).onclick = async e => {
    const btn = e.currentTarget; errEl.textContent = '';
    const name = $('#pt-name', sheet).value.trim();
    if(isNew && !file){ errEl.textContent = 'Выберите фото.'; return; }
    if(!name){ errEl.textContent = 'Напишите имя.'; $('#pt-name', sheet).focus(); return; }
    btn.disabled = true; btn.textContent = 'Сохраняю…';
    try{
      if(isNew){
        const fd = new FormData();
        fd.append('photo', await shrink(file), 'photo.jpg');
        fd.append('name', name); fd.append('voice', $('#pt-voice', sheet).value);
        fd.append('persona', $('#pt-persona', sheet).value);
        fd.append('cartoon', $('#pt-cartoon', sheet).checked ? '1' : '0');
        const r = await api('characters', { method: 'POST', body: fd });
        selChar = r.character.id; try{ localStorage.setItem('portu-char', selChar); }catch(_){}
        toast(r.character.status === 'cartoon_pending'
          ? 'Персонаж добавлен. Пока он с вашим фото — мультяшная версия появится, когда её нарисует Grok.' : 'Персонаж добавлен.', 6000);
      }else{
        await api('characters/' + ch.id, { method: 'PATCH', json: { name, voice: $('#pt-voice', sheet).value,
          persona: $('#pt-persona', sheet).value } });
        setVoicePref(ch.id, $('#pt-voice', sheet).value);
      }
      close(); renderCallHome();
    }catch(err){ errEl.textContent = err.message; btn.disabled = false; btn.textContent = isNew ? 'Добавить' : 'Сохранить'; }
  };
  if(!isNew){
    $('#pt-del', sheet).onclick = async () => {
      if(!confirm(`Удалить персонажа «${ch.name}»? Фото удалится с сервера, история звонков останется.`)) return;
      try{ await api('characters/' + ch.id, { method: 'DELETE' }); close(); renderCallHome(); }catch(err){ errEl.textContent = err.message; }
    };
    $('#pt-recart', sheet).onclick = async () => {
      try{ await api('characters/' + ch.id, { method: 'PATCH', json: { recartoon: true } }); close(); renderCallHome();
        toast('Отправил в Grok — новая версия появится через пару минут.'); }catch(err){ errEl.textContent = err.message; }
    };
  }
}
/* фото с телефона весят 3–10 МБ — ужимаем до 1600 px перед отправкой */
async function shrink(file){
  try{
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise(r => cv.toBlob(b => r(b || file), 'image/jpeg', .9));
  }catch(e){ return file; }
}

/* ════════════════ ЗВОНОК ════════════════ */
const GOAL = 8;                     // реплик ученика до вопроса «продлить?»
let C = null;                       // текущий звонок

function pickTargets(){
  // слова в работе, которые чаще путает; если таких мало — добавляем новые
  const inWork = CARDS.filter(c => { const x = S.cards[c.id]; return x && x.seen && !(x.rep >= 3 && x.iv >= 21) && c.pos !== 'function words'; })
    .sort((a, b) => (S.cards[b.id].miss || 0) - (S.cards[a.id].miss || 0));
  const pool = inWork.slice(0, 12).concat(shuffle(CARDS.filter(c => !S.cards[c.id] && ['nouns', 'verbs', 'adjectives'].includes(c.pos))).slice(0, 6));
  const pick = shuffle(pool.slice(0, 10)).slice(0, 3);
  return pick.map(c => ({ pt: c.pt, ru: c.ru.split(/[;,(]/)[0].trim() }));
}

async function startCall(ch, voice, topicId){
  // всё, что требует жеста пользователя (звук и микрофон на iPhone), — прямо в обработчике нажатия.
  // Звук играем через WebAudio: контекст, разблокированный этим нажатием, дальше играет без ограничений.
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(() => {});
  // Микрофон: только спрашиваем разрешение и сразу закрываем. Пока он открыт, iPhone выводит
  // звук в разговорный динамик (тихо), поэтому открываем его лишь на время записи.
  let mic = false;
  try{ const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach(t => t.stop()); mic = true; }
  catch(e){ toast('Нет доступа к микрофону — можно отвечать текстом (кнопка с клавиатурой).', 6000); }

  C = { ch, voice, topic: topicId, ctx, mic, id: null, userTurns: 0, goal: GOAL, targets: pickTargets(),
        lastReply: null, lastBuf: null, src: null, cc: (() => { try{ return localStorage.getItem('portu-cc') !== '0'; }catch(e){ return true; } })(),
        rec: null, state: 'connecting', ended: false };
  buildCallUI();
  setState('connecting');
  if(!mic){ $('#pt-type', C.el).hidden = false; $('#pt-kb', C.el).setAttribute('aria-pressed', true); }
  try{
    const r = await api('calls', { method: 'POST', json: { char_id: ch.id, voice, topic: topicId, targets: C.targets } });
    if(C.ended) return;
    C.id = r.call.id;
    $('.pt-dial', C.el).remove();
    anim($('.pt-stage', C.el), { opacity: [0, 1], transform: ['scale(1.04)', 'scale(1)'] }, { duration: .5 });
    await playReply(r.reply);
  }catch(e){
    if(C && !C.ended){ toast('Не удалось дозвониться: ' + e.message, 6000); closeCall(); }
  }
}

function buildCallUI(){
  const ch = C.ch;
  const el = h(`<div class="pt-call" role="dialog" aria-modal="true" aria-label="Звонок: ${esc(ch.name)}">
    <div class="pt-stage">
      <div class="pt-bgblur" style="background-image:url('${ch.img || ''}')"></div>
      <div class="pt-hero">
        <img class="pt-hero-base" src="${ch.img || ''}" alt="${esc(ch.name)}">
        ${ch.talk ? `<img class="pt-hero-talk" src="${ch.talk}" alt="" aria-hidden="true">` : ''}
      </div>
      <div class="pt-shade"></div>
    </div>
    <div class="pt-top">
      <button class="pt-round" id="pt-end" aria-label="Завершить звонок">${I(IC.x, 22)}</button>
      <div class="pt-prog" role="progressbar" aria-label="Ход звонка" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <button class="pt-round pt-round-sm" id="pt-kb" aria-label="Ответить текстом" aria-pressed="false">${I(IC.kb, 19)}</button>
      <button class="pt-round pt-round-sm" id="pt-cc" aria-label="Субтитры" aria-pressed="${C.cc}">${I(IC.cc, 19)}</button>
    </div>
    <div class="pt-goals" id="pt-goals" aria-label="Слова, которые стоит сказать">${C.targets.map(t => `
      <span class="pt-goal" data-w="${esc(t.pt)}" title="${esc(t.ru)}">${esc(t.pt)}</span>`).join('')}</div>
    <div class="pt-caps" id="pt-caps" aria-live="polite"></div>
    <div class="pt-extend" id="pt-extend" hidden><b>Продлить звонок?</b>
      <button class="btn btn-primary" id="pt-ext-yes">Да</button><button class="btn pt-btn-dark" id="pt-ext-no">Нет, закончить</button></div>
    <form class="pt-type" id="pt-type" hidden><input id="pt-type-in" placeholder="Напишите по-португальски или по-русски" autocomplete="off" enterkeyhint="send">
      <button class="pt-round pt-round-blue" aria-label="Отправить">${I(IC.send, 19)}</button></form>
    <div class="pt-bar">
      <button class="pt-round" id="pt-replay" aria-label="Повторить последнюю фразу">${I(IC.replay, 21)}</button>
      <button class="pt-round" id="pt-slow" aria-label="Повторить медленно">${I(IC.slow, 21)}</button>
      <button class="pt-talk" id="pt-talk"><span class="pt-talk-ic">${I(IC.mic, 20)}</span><span class="pt-talk-tx">Нажмите и говорите</span><span class="pt-meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></button>
      <button class="pt-round" id="pt-help" aria-label="Не понял — объясни по-русски">${I(IC.help, 21)}</button>
    </div>
    <div class="pt-dial"><div class="pt-dial-av">${ch.av ? `<img src="${ch.av}" alt="">` : ''}</div>
      <p>Звоним: ${esc(ch.name)}…</p>
      <button class="pt-hang" id="pt-hang" aria-label="Отменить звонок">${I(IC.phone, 26)}</button></div>
  </div>`);
  document.body.appendChild(el);
  document.documentElement.classList.add('pt-locked');
  C.el = el;
  anim(el, { opacity: [0, 1] }, { duration: .25 });
  anim($('.pt-dial-av', el), { transform: ['scale(1)', 'scale(1.06)', 'scale(1)'] }, { duration: 1.6, repeat: Infinity });
  $('#pt-hang', el).onclick = () => closeCall();
  $('#pt-end', el).onclick = () => endCall();
  $('#pt-talk', el).onclick = () => talkButton();
  $('#pt-replay', el).onclick = () => replay(false);
  $('#pt-slow', el).onclick = () => replay(true);
  $('#pt-help', el).onclick = () => sendText('Я не понял, что ты сказал. Объясни по-русски, пожалуйста.');
  $('#pt-cc', el).onclick = e => { C.cc = !C.cc; e.currentTarget.setAttribute('aria-pressed', C.cc);
    try{ localStorage.setItem('portu-cc', C.cc ? '1' : '0'); }catch(_){} el.classList.toggle('pt-nocc', !C.cc); };
  el.classList.toggle('pt-nocc', !C.cc);
  $('#pt-kb', el).onclick = e => { const f = $('#pt-type', el); f.hidden = !f.hidden; e.currentTarget.setAttribute('aria-pressed', !f.hidden); if(!f.hidden) $('#pt-type-in', el).focus(); };
  $('#pt-type', el).onsubmit = e => { e.preventDefault(); const i = $('#pt-type-in', el); const t = i.value.trim(); if(t){ i.value = ''; sendText(t); } };
  $('#pt-ext-yes', el).onclick = () => { C.goal += 4; $('#pt-extend', el).hidden = true; progress(); setState('idle'); };
  $('#pt-ext-no', el).onclick = () => endCall();
  el.addEventListener('keydown', e => { if(e.key === 'Escape') endCall(); });
  progress();
}

function setState(st){
  if(!C) return;
  C.state = st;
  const el = C.el; el.dataset.state = st;
  const t = $('#pt-talk', el), tx = $('.pt-talk-tx', el);
  t.disabled = st === 'connecting' || st === 'busy';
  tx.textContent = { connecting: 'Соединяю…', ai: 'Говорит… (нажмите, чтобы перебить)', idle: 'Нажмите и говорите',
                     rec: 'Нажмите, чтобы отправить', busy: 'Думает…' }[st] || '';
  ['pt-replay', 'pt-slow', 'pt-help'].forEach(id => { $('#' + id, el).disabled = st === 'connecting' || st === 'busy' || st === 'rec'; });
}

function progress(){
  const p = Math.min(100, Math.round(C.userTurns / C.goal * 100));
  const bar = $('.pt-prog', C.el); bar.setAttribute('aria-valuenow', p);
  $('.pt-prog span', C.el).style.width = Math.max(4, p) + '%';
}

function caption(role, text, sub){
  const caps = $('#pt-caps', C.el);
  const b = h(`<div class="pt-cap pt-cap-${role}"><span>${esc(text)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`);
  caps.appendChild(b);
  while(caps.children.length > 2) caps.firstElementChild.remove();
  anim(b, { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0px)'] }, { duration: .25 });
  if(role === 'ai' && sub) b.onclick = () => b.classList.toggle('pt-cap-open');
  return b;
}

async function playReply(reply){
  C.lastReply = reply;
  const text = reply.segments.map(s => s.text).join(' ');
  caption('ai', text, reply.tr);
  C.lastBuf = reply.audio ? b64buf(reply.audio) : null;
  await speakNow(C.lastBuf, reply.segments);
}
const b64buf = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

/* Воспроизведение через WebAudio + «губы»: громкость звука переключает кадр с открытым ртом */
let analyser = null;
function lipLoop(){
  const talk = $('.pt-hero-talk', C.el), hero = $('.pt-hero', C.el);
  const buf = new Uint8Array(256);
  let open = false, lastSwitch = 0;
  const step = (ts) => {
    if(!C || C.state !== 'ai'){ if(talk) talk.style.opacity = 0; return; }
    let amp = 0;
    if(analyser && C.src){ analyser.getByteTimeDomainData(buf); let s = 0; for(const v of buf){ const d = (v - 128) / 128; s += d * d; } amp = Math.sqrt(s / buf.length); }
    else amp = (Math.sin(ts / 90) + 1) / 8;           // голос браузера не анализируется — просто ритм
    const want = amp > 0.045;
    if(want !== open && ts - lastSwitch > 70){ open = want; lastSwitch = ts; if(talk) talk.style.opacity = open ? 1 : 0; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
async function playBuffer(arrayBuf){
  const buf = await C.ctx.decodeAudioData(arrayBuf.slice(0));   // decode «съедает» буфер — отдаём копию
  if(!C) return;
  if(!analyser){ analyser = C.ctx.createAnalyser(); analyser.fftSize = 512; analyser.connect(C.ctx.destination); }
  const src = C.ctx.createBufferSource(); src.buffer = buf; src.connect(analyser);
  C.src = src;
  await new Promise(res => { src.onended = res; src.start(); });
  if(C && C.src === src) C.src = null;
}
function stopVoice(){
  if(!C) return;
  try{ C.src?.stop(); }catch(e){}
  C.src = null;
  try{ speechSynthesis.cancel(); }catch(e){}
}
async function speakNow(arrayBuf, segments, slowRate){
  setState('ai');
  try{ await C.ctx.resume(); }catch(e){}
  lipLoop();
  let ok = false;
  if(arrayBuf){ try{ await playBuffer(arrayBuf); ok = true; }catch(e){ console.warn('звук', e); } }
  if(!ok && C && C.state === 'ai') await browserSpeak(segments, slowRate);   // сервер не смог озвучить — читает браузер
  if(C && C.state === 'ai') setState('idle');
}
function browserSpeak(segments, slow){
  return new Promise(res => {
    if(!('speechSynthesis' in window)) return res();
    const vs = speechSynthesis.getVoices();
    let left = segments.length;
    segments.forEach(s => {
      const u = new SpeechSynthesisUtterance(s.text);
      u.lang = s.lang === 'ru' ? 'ru-RU' : 'pt-BR';
      u.voice = vs.find(v => v.lang.replace('_', '-') === u.lang) || null;
      u.rate = slow ? .7 : 1;
      u.onend = u.onerror = () => { if(--left <= 0) res(); };
      speechSynthesis.speak(u);
    });
    if(!left) res();
  });
}
async function replay(slow){
  if(!C?.lastReply || C.state === 'rec' || C.state === 'busy') return;
  stopVoice();
  if(!slow) return speakNow(C.lastBuf, C.lastReply.segments);
  const btn = $('#pt-slow', C.el); btn.disabled = true;
  let buf = null;
  try{
    const blob = await api('tts', { method: 'POST', json: { segments: C.lastReply.segments, voice: C.voice, slow: true } });
    buf = await blob.arrayBuffer();
  }catch(e){}
  btn.disabled = false;
  if(C) await speakNow(buf, C.lastReply.segments, true);
}

/* ── запись голоса: «нажал — говоришь — нажал ещё раз», плюс автоотправка после паузы ── */
function talkButton(){
  if(!C) return;
  if(C.state === 'ai'){ stopVoice(); setState('idle'); return startRec(); }
  if(C.state === 'idle') return startRec();
  if(C.state === 'rec') return stopRec(true);
}
function pickMime(){
  for(const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'])
    if(window.MediaRecorder && MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}
async function startRec(){
  if(!C.mic){ $('#pt-kb', C.el).click(); toast('Микрофон недоступен — напишите ответ.'); return; }
  setState('busy');
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch(e){ toast('Микрофон недоступен — напишите ответ.'); setState('idle'); return; }
  if(!C || C.ended){ stream.getTracks().forEach(t => t.stop()); return; }
  const mime = pickMime();
  let rec;
  try{ rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch(e){ stream.getTracks().forEach(t => t.stop()); toast('Запись не поддерживается в этом браузере — напишите ответ.'); setState('idle'); return; }
  const chunks = [];
  rec.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());             // микрофон закрыт — звук снова в громкий динамик
    const send = rec._send; if(C) C.rec = null; stopMeter();
    if(!C || C.ended) return;
    if(!send){ setState('idle'); return; }
    const type = rec.mimeType || mime || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    sendAudio(new Blob(chunks, { type }), ext, rec._spoke);
  };
  rec.start(250);
  C.rec = rec; rec._t0 = performance.now(); rec._spoke = false; rec._stream = stream;
  setState('rec');
  startMeter(rec);
  navigator.vibrate?.(15);
}
function stopRec(send){
  const r = C?.rec; if(!r) return;
  r._send = send;
  try{ r.stop(); }catch(e){}
}
let meterRAF = 0;
function startMeter(rec){
  const bars = [...C.el.querySelectorAll('.pt-meter i')];
  let an; try{ const src = C.ctx.createMediaStreamSource(rec._stream); an = C.ctx.createAnalyser(); an.fftSize = 512; src.connect(an); }catch(e){}
  const buf = new Uint8Array(256);
  let silentSince = 0;
  const step = () => {
    if(!C?.rec) return;
    let amp = 0;
    if(an){ an.getByteTimeDomainData(buf); let s = 0; for(const v of buf){ const d = (v - 128) / 128; s += d * d; } amp = Math.sqrt(s / buf.length); }
    bars.forEach((b, i) => b.style.transform = `scaleY(${Math.min(1, .15 + amp * (6 + i * 2.2))})`);
    const t = performance.now();
    if(amp > 0.035){ rec._spoke = true; silentSince = 0; }
    else if(rec._spoke){ silentSince ||= t; if(t - silentSince > 1700) return stopRec(true); }   // замолчал — отправляем
    if(t - rec._t0 > 45000) return stopRec(true);
    meterRAF = requestAnimationFrame(step);
  };
  meterRAF = requestAnimationFrame(step);
}
function stopMeter(){ cancelAnimationFrame(meterRAF); C?.el.querySelectorAll('.pt-meter i').forEach(b => b.style.transform = ''); }

async function sendAudio(blob, ext, spoke){
  if(blob.size < 800 || spoke === false){ toast('Ничего не расслышал — попробуйте ещё раз.'); setState('idle'); return; }
  const fd = new FormData(); fd.append('audio', blob, 'speech.' + ext);
  await turn(fd);
}
async function sendText(text){
  if(!C || C.state === 'busy' || C.state === 'connecting') return;
  if(C.state === 'ai') stopVoice();
  if(C.state === 'rec') stopRec(false);
  const fd = new FormData(); fd.append('text', text);
  await turn(fd, text);
}
async function turn(fd, typed){
  setState('busy');
  const mine = typed ? caption('me', typed) : caption('me', '…');
  try{
    const r = await api(`calls/${C.id}/turn`, { method: 'POST', body: fd });
    if(!C || C.ended) return;
    if(!r.heard){ mine.remove(); toast('Не расслышал — скажите ещё раз, чуть громче.'); setState('idle'); return; }
    mine.querySelector('span').textContent = r.heard.text;
    if(r.heard.lang === 'pt') C.userTurns++;
    markGoals(r.heard);
    progress();
    await playReply(r.reply);
    if(C && C.userTurns >= C.goal && $('#pt-extend', C.el).hidden){ $('#pt-extend', C.el).hidden = false; anim($('#pt-extend', C.el), { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)'] }, { duration: .3 }); }
  }catch(e){
    mine.remove();
    toast(e.status === 401 ? 'Сессия истекла — войдите снова.' : 'Не получилось: ' + e.message, 5000);
    if(C) setState('idle');
  }
}
function markGoals(heard){
  const said = (heard.text || '').toLowerCase();
  const used = (heard.used || []).map(w => String(w).toLowerCase());
  C.el.querySelectorAll('.pt-goal:not(.done)').forEach(g => {
    const w = g.dataset.w.toLowerCase();
    if(used.includes(w) || new RegExp(`(^|[^\\p{L}])${escRe(w)}([^\\p{L}]|$)`, 'u').test(said)){
      g.classList.add('done'); g.insertAdjacentHTML('afterbegin', I(IC.check, 13));
      anim(g, { transform: ['scale(1)', 'scale(1.18)', 'scale(1)'] }, { duration: .45 });
      navigator.vibrate?.([10, 40, 10]);
    }
  });
}

function stopMedia(){
  if(!C) return;
  stopVoice();
  if(C.rec){ C.rec._send = false; try{ C.rec.stop(); }catch(e){} C.rec._stream?.getTracks().forEach(t => t.stop()); }
  try{ C.ctx?.close(); }catch(e){}
  analyser = null;
  C.breath?.cancel?.();
}
function closeCall(){
  if(!C) return;
  C.ended = true; stopMedia();
  C.el.remove(); C = null;
  document.documentElement.classList.remove('pt-locked');
}
async function endCall(){
  if(!C || C.ended) return;
  const had = C.userTurns > 0 || C.el.querySelector('.pt-cap-me');
  if(!C.id || !had){ closeCall(); return; }
  C.ended = true; stopMedia();
  const el = C.el, callId = C.id, ch = C.ch;
  el.classList.add('pt-after');
  el.innerHTML = `<div class="pt-panel">
    <h2>Как прошёл звонок?</h2>
    <div class="pt-rate" role="radiogroup" aria-label="Оценка звонка">
      <button class="pt-opt" role="radio" aria-checked="false" data-r="easy">Слишком легко</button>
      <button class="pt-opt" role="radio" aria-checked="false" data-r="ok">В самый раз</button>
      <button class="pt-opt" role="radio" aria-checked="false" data-r="hard">Слишком сложно</button></div>
    <p class="hint">По оценке подстроится сложность следующих звонков.</p>
    <button class="btn btn-primary pt-wide" id="pt-rate-go" disabled>Продолжить</button></div>`;
  anim($('.pt-panel', el), { opacity: [0, 1], transform: ['translateY(20px)', 'translateY(0px)'] }, { duration: .35 });
  let rating = null;
  el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    rating = b.dataset.r;
    el.querySelectorAll('[data-r]').forEach(x => x.setAttribute('aria-checked', x === b));
    $('#pt-rate-go', el).disabled = false;
  });
  $('#pt-rate-go', el).onclick = async e => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'Готовлю разбор…';
    try{
      const r = await api(`calls/${callId}/end`, { method: 'POST', json: { rating } });
      if(me) me.level = r.level;
      showReview(el, { title: r.title, takeaway: r.takeaway, turns: r.turns, char: ch, voice: C?.voice });
    }catch(err){ toast('Разбор не загрузился: ' + err.message); closeCall(); }
  };
}

/* ── разбор разговора (после звонка и из истории) ── */
function showReview(el, { title, takeaway, turns, char, voice }){
  const av = char?.av ? `<img src="${char.av}" alt="">` : '';
  el.classList.add('pt-after');
  el.innerHTML = `<div class="pt-panel pt-review">
    <div class="pt-rv-hd"><h2>Разбор разговора</h2>
      <button class="icon-btn" data-close aria-label="Закрыть">${I(IC.x, 20)}</button></div>
    ${title ? `<p class="pt-rv-title">${esc(title)}</p>` : ''}
    ${takeaway ? `<div class="pt-take"><span class="pt-take-h">${I(IC.spark, 15)} Главное</span><p>${esc(takeaway)}</p></div>` : ''}
    <div class="pt-chat">${turns.map(t => t.role === 'ai' ? `
      <div class="pt-msg pt-msg-ai"><span class="pt-msg-av">${av}</span>
        <div class="pt-bub" ${t.tr ? 'role="button" tabindex="0" aria-expanded="false"' : ''}>
          <span>${esc(t.text)}</span>${t.tr ? `<small class="pt-tr">${esc(t.tr)}</small>` : ''}
          <button class="pt-say" data-say="${t.idx}" aria-label="Послушать">${I(IC.play, 13)}</button></div></div>` : `
      <div class="pt-msg pt-msg-me"><div class="pt-bub"><span>${esc(t.text)}</span>
        ${t.tip ? `<div class="pt-tip"><b>Совет</b>${esc(t.tip)}</div>` : ''}</div></div>`).join('')}</div>
    ${turns.some(t => t.tr) ? '<p class="hint">Нажмите на реплику персонажа — появится перевод.</p>' : ''}
    <button class="btn btn-primary pt-wide" data-close>Готово</button></div>`;
  anim($('.pt-panel', el), { opacity: [0, 1] }, { duration: .3 });
  if(M && !reduced) el.querySelectorAll('.pt-msg').forEach((m, i) => anim(m, { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)'] }, { duration: .3, delay: Math.min(i, 12) * .04 }));
  el.addEventListener('click', async e => {
    if(e.target.closest('[data-close]')){ el.remove(); C = null; document.documentElement.classList.remove('pt-locked'); renderCallHome(); return; }
    const say = e.target.closest('[data-say]');
    if(say){
      e.stopPropagation();
      const t = turns.find(x => String(x.idx) === say.dataset.say);
      try{ const blob = await api('tts', { method: 'POST', json: { segments: t.segments || [{ lang: t.lang, text: t.text }], voice: voice || char?.voice } });
        const a = new Audio(URL.createObjectURL(blob)); a.onended = () => URL.revokeObjectURL(a.src); a.play(); }catch(err){ toast(err.message); }
      return;
    }
    const bub = e.target.closest('.pt-msg-ai .pt-bub[role="button"]');
    if(bub){ bub.classList.toggle('open'); bub.setAttribute('aria-expanded', bub.classList.contains('open')); }
  });
}
async function openTranscript(id){
  try{
    const r = await api('calls/' + id);
    const el = h(`<div class="pt-call pt-after" role="dialog" aria-modal="true" aria-label="Разговор"></div>`);
    document.body.appendChild(el); document.documentElement.classList.add('pt-locked');
    showReview(el, { title: r.call.title, takeaway: r.call.takeaway, turns: r.turns, char: r.call.char, voice: r.call.voice });
  }catch(e){ toast('Не открылось: ' + e.message); }
}

/* ════════════════ СТАРТ ════════════════ */
mountCallView();
boot().then(() => { if(me) loadMeta().catch(() => {}); });
})();
