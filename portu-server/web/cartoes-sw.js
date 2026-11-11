/* Service worker карточек на syferpu.top/portu.
 *
 * Область — только /portu/. API (/portu/api/…) не трогаем никогда: вход,
 * синхронизация и звонки должны идти в сеть. Страница и скрипты — сначала
 * сеть (чтобы обновления доходили сразу), без сети — из кеша. Картинки слов,
 * иконки и шрифт — сначала кеш: они не меняются.
 */
const VERSION = 'v1';
const SHELL = 'portu-shell-' + VERSION;
const IMAGES = 'cartoes-img-v1';             // это имя использует кнопка «Скачать картинки»
const FONTS = 'portu-fonts-' + VERSION;

const scopePath = new URL(self.registration.scope).pathname;     // /portu/
const isPage = p => p === scopePath || p === scopePath + 'index.html' || p === scopePath + 'cartoes-pt.html';
const isCode = p => /\/(portu\.js|portu\.css|cartoes-pt\.webmanifest)$/.test(p);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll([scopePath, 'portu.js', 'portu.css', 'cartoes-pt.webmanifest']).catch(() => {}))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, IMAGES, FONTS];
    for(const k of await caches.keys()){
      if((k.startsWith('portu-') || k.startsWith('cartoes-')) && !keep.includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if(!font && (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath))) return;
  if(url.pathname.startsWith(scopePath + 'api/')) return;            // API — всегда сеть

  if(isPage(url.pathname) || isCode(url.pathname)){
    e.respondWith((async () => {
      try{
        const net = await fetch(req);
        if(net.ok) (await caches.open(SHELL)).put(isPage(url.pathname) ? scopePath : req, net.clone());
        return net;
      }catch(err){
        return (await caches.match(isPage(url.pathname) ? scopePath : req)) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreVary: true });
    if(hit) return hit;
    try{
      const net = await fetch(req);
      const box = font ? FONTS : url.pathname.includes('/cartoes-img/') ? IMAGES : SHELL;
      if(net.ok || net.type === 'opaque') (await caches.open(box)).put(req, net.clone());
      return net;
    }catch(err){
      return Response.error();
    }
  })());
});
