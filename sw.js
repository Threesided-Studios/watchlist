/* Watchlist service worker. Bump VERSION to roll caches. */
const VERSION = 'v2';
const SHELL = `wl-shell-${VERSION}`;
const DATA = `wl-data-${VERSION}`;
const POSTERS = `wl-posters-${VERSION}`;
const KEEP = [SHELL, DATA, POSTERS];
const B = '/';
const SHELL_URLS = [
  B, B + 'movies/', B + 'shows/', B + 'games/', B + 'books/', B + 'software/', B + 'recommended/', B + 'inbox/',
  B + 'assets/styles.css?v=28', B + 'assets/app.js?v=26', B + 'manifest.webmanifest',
  B + 'assets/icons/icon-192.png', B + 'assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(SHELL_URLS.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('wl-') && !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: cacheName === DATA });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, SHELL)); return;
  }
  if (url.origin !== location.origin || !url.pathname.startsWith(B)) return; // APIs pass through

  const p = url.pathname;
  if (p.endsWith('/data.json')) { e.respondWith(networkFirst(req, DATA)); return; }
  if (p.startsWith(B + 'posters/')) { e.respondWith(cacheFirst(req, POSTERS)); return; }
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, SHELL).catch(() => caches.match(B))); return; }
  if (p.endsWith('/sw.js')) return;
  e.respondWith(staleWhileRevalidate(req, SHELL));
});
