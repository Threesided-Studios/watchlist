#!/usr/bin/env node
/* Local preview: serves the working tree the way the built site is served,
 * generating pages and data.min.json on each request so edits show on reload.
 *
 *   node scripts/dev-server.mjs [--port 8765]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT, loadItems, listPages, renderPage, buildData, renderServiceWorker, recentShots, buildCalendar } from './build-site.mjs';

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8765;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SERVED = /^\/(assets|shared|posters)\//;

createServer((req, res) => {
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/data.min.json') return send(200, buildData(), TYPES['.json']);
    if (path === '/ingest.json') return send(200, JSON.stringify(recentShots()), TYPES['.json']);
    if (path === '/upcoming.ics') return send(200, buildCalendar(loadItems()), 'text/calendar');
    if (path === '/version.json') return send(200, JSON.stringify({ sha: 'dev', assets: 'dev' }), TYPES['.json']);
    const items = loadItems();
    const pages = listPages(items);
    if (path === '/sw.js') return send(200, renderServiceWorker(pages, 'dev'), TYPES['.js']);
    const page = pages.find((p) => `/${p.path}` === (path.endsWith('/') ? path : `${path}/`));
    if (page) return send(200, renderPage(page, pages, 'dev'), TYPES['.html']);
    const file = join(ROOT, normalize(path));
    const allowed = SERVED.test(path) || ['/manifest.webmanifest', '/data.json', '/404.html'].includes(path);
    if (allowed && file.startsWith(ROOT) && existsSync(file) && statSync(file).isFile()) {
      return send(200, readFileSync(file), TYPES[extname(file)] || 'application/octet-stream');
    }
    send(404, readFileSync(join(ROOT, '404.html')), TYPES['.html']);
  } catch (e) { send(500, String(e?.stack || e), 'text/plain'); }
}).listen(PORT, () => console.log(`watchlist dev server: http://localhost:${PORT}`));
