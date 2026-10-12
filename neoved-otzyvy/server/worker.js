/**
 * neoved · раздача галереи «Отзывы клиентов» с hooks.neoved.io.
 *
 *   /amo/neoved-otzyvy/otzyvy.js          — скрипт галереи (подключается одной строкой в Tilda)
 *   /amo/neoved-otzyvy/img/otzyv-N-W.webp — скриншоты, W = 480 | 720 | 1080
 *   /amo/neoved-otzyvy/health             — проверка
 *
 * Только раздача файлов, лежащих рядом. Воркер для Node (amo-server), не для Cloudflare: читает диск.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.js': 'application/javascript; charset=utf-8', '.webp': 'image/webp' };
// Скрипт кэшируется ненадолго, чтобы правки доезжали до сайта сами; картинки — на сутки (в ссылках есть ?v=N).
const MAX_AGE = { '.js': 600, '.webp': 86400 };
const files = new Map();

function read(rel) {
  if (!files.has(rel)) {
    const p = path.join(HERE, rel);
    files.set(rel, fs.existsSync(p) ? fs.readFileSync(p) : null);
  }
  return files.get(rel);
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (pathname === '/health') return Response.json({ ok: true, worker: 'neoved-otzyvy' });

    let rel = null;
    if (pathname === '/otzyvy.js') rel = 'otzyvy.js';
    const img = pathname.match(/^\/img\/(otzyv-[1-9]-(?:480|720|1080)\.webp)$/);
    if (img) rel = `img/${img[1]}`;

    const body = rel && read(rel);
    if (!body) return new Response('Not Found', { status: 404 });

    const ext = path.extname(rel);
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'Content-Type': TYPES[ext],
        'Content-Length': String(body.length),
        'Cache-Control': `public, max-age=${MAX_AGE[ext]}`,
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
