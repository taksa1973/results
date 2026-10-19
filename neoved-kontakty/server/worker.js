/**
 * neoved · раздача карты страницы «Контакты» с hooks.neoved.io.
 *
 *   /amo/neoved-kontakty/kontakty.js — скрипт карты (подключается одной строкой в Tilda)
 *   /amo/neoved-kontakty/health      — проверка
 *
 * Только раздача файла, лежащего рядом. Воркер для Node (amo-server), не для Cloudflare: читает диск.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let script = null;

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (pathname === '/health') return Response.json({ ok: true, worker: 'neoved-kontakty' });
    if (pathname !== '/kontakty.js') return new Response('Not Found', { status: 404 });

    if (!script) {
      const p = path.join(HERE, 'kontakty.js');
      script = fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    if (!script) return new Response('Not Found', { status: 404 });

    // Кэш короткий, чтобы правки доезжали до сайта сами.
    return new Response(request.method === 'HEAD' ? null : script, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': String(script.length),
        'Cache-Control': 'public, max-age=600',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
