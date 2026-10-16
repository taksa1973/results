/* Service worker карточек.
 *
 * Репозиторий results отдаёт десятки страниц с одного адреса, а область
 * видимости воркера — вся папка /results/. Поэтому отвечаем строго за свои
 * адреса: саму страницу, картинки карточек и шрифт. Всё остальное уходит
 * в сеть нетронутым, как будто воркера нет.
 */
const VERSION = 'v1';
const SHELL = 'cartoes-shell-' + VERSION;   // страница, манифест, иконки
const IMAGES = 'cartoes-img-' + VERSION;    // 740 картинок, кладёт страница
const FONTS = 'cartoes-fonts-' + VERSION;   // Inter с Google Fonts

const PAGE = 'cartoes-pt.html';

const mine = (url) => {
  const u = new URL(url);
  if (u.origin === self.location.origin) {
    const p = u.pathname;
    return p.endsWith('/' + PAGE)
        || p.endsWith('/cartoes-pt.webmanifest')
        || p.includes('/cartoes-img/')
        || p.includes('/cartoes-icon-');
  }
  return u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
};

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll([PAGE, 'cartoes-pt.webmanifest']).catch(() => {}))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, IMAGES, FONTS];
    for (const k of await caches.keys()) {
      if (k.startsWith('cartoes-') && !keep.includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !mine(req.url)) return;   // чужое не трогаем

  const url = new URL(req.url);
  const isPage = url.origin === self.location.origin && url.pathname.endsWith('/' + PAGE);

  if (isPage) {
    // страница: свежая, если сеть есть; из кеша, если нет
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        (await caches.open(SHELL)).put(req, net.clone());
        return net;
      } catch (err) {
        return (await caches.match(req)) || (await caches.match(PAGE)) || Response.error();
      }
    })());
    return;
  }

  // картинки, шрифты, иконки: сначала кеш — он не меняется и экономит трафик
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreVary: true });
    if (hit) return hit;
    try {
      const net = await fetch(req);
      const box = url.hostname.startsWith('fonts.') ? FONTS
                : url.pathname.includes('/cartoes-img/') ? IMAGES : SHELL;
      if (net.ok || net.type === 'opaque') (await caches.open(box)).put(req, net.clone());
      return net;
    } catch (err) {
      return Response.error();
    }
  })());
});

// страница просит посчитать, сколько картинок уже лежит офлайн
self.addEventListener('message', async (e) => {
  if (e.data && e.data.type === 'count') {
    const c = await caches.open(IMAGES);
    e.source.postMessage({ type: 'count', n: (await c.keys()).length });
  }
  if (e.data && e.data.type === 'wipe') {
    await caches.delete(IMAGES);
    e.source.postMessage({ type: 'count', n: 0 });
  }
});
