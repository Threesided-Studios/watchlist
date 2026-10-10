/* Watchlist screenshot inbox.
 *
 *   POST /i/<INGEST_KEY>            raw image body (iOS Shortcut). ?name=IMG_123.PNG optional
 *   POST /ingest                    same, auth via X-Ingest-Key or X-Owner-Pass (web upload)
 *   GET  /status                    public counts {queued, processed, reviews}
 *   POST /review                    owner review decision {id, action: approve|dismiss, title, pass}
 *
 *   -- GitHub Action only (X-Queue-Key) --
 *   GET  /queue                     list queued screenshots
 *   GET  /queue/<sha>               image bytes
 *   POST /queue/<sha>/done          drop the image, keep the sha as "seen"
 *   GET  /reviews                   pending review decisions
 *   POST /reviews/ack               {ids:[...]} clear applied decisions
 *
 * Every image is keyed by its SHA-256, so re-sending the same screenshot (the
 * Shortcut looks back a little over a day each run) is a cheap no-op.
 */
import { DurableObject } from 'cloudflare:workers';

const CHUNK = 1_500_000;          // DO SQLite rows max out at 2 MB
const MAX_BYTES = 20_000_000;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', data));

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export class ShotQueue extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS shots (
      sha TEXT PRIMARY KEY, name TEXT, ctype TEXT, size INTEGER, parts INTEGER,
      received TEXT, status TEXT NOT NULL DEFAULT 'queued', done_at TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS parts (sha TEXT, idx INTEGER, data BLOB, PRIMARY KEY (sha, idx))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, action TEXT, title TEXT, at TEXT)`);
  }

  put(sha, name, ctype, bytes) {
    const seen = this.sql.exec('SELECT status FROM shots WHERE sha = ?', sha).toArray();
    if (seen.length) return { status: 'duplicate', sha };
    const u8 = new Uint8Array(bytes);
    const parts = Math.max(1, Math.ceil(u8.byteLength / CHUNK));
    for (let i = 0; i < parts; i++) {
      this.sql.exec('INSERT INTO parts (sha, idx, data) VALUES (?, ?, ?)', sha, i, u8.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    this.sql.exec('INSERT INTO shots (sha, name, ctype, size, parts, received) VALUES (?, ?, ?, ?, ?, ?)',
      sha, name, ctype, u8.byteLength, parts, new Date().toISOString());
    return { status: 'queued', sha };
  }

  list(limit = 100) {
    return this.sql.exec(`SELECT sha, name, ctype, size, received FROM shots WHERE status = 'queued'
      ORDER BY received LIMIT ?`, limit).toArray();
  }

  get(sha) {
    const meta = this.sql.exec(`SELECT ctype FROM shots WHERE sha = ? AND status = 'queued'`, sha).toArray()[0];
    if (!meta) return null;
    const rows = this.sql.exec('SELECT data FROM parts WHERE sha = ? ORDER BY idx', sha).toArray();
    const total = rows.reduce((n, r) => n + r.data.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const r of rows) { out.set(new Uint8Array(r.data), off); off += r.data.byteLength; }
    return { ctype: meta.ctype, bytes: out.buffer };
  }

  done(sha) {
    this.sql.exec('DELETE FROM parts WHERE sha = ?', sha);
    this.sql.exec(`UPDATE shots SET status = 'done', done_at = ? WHERE sha = ?`, new Date().toISOString(), sha);
    return { ok: true };
  }

  status() {
    const c = (q) => this.sql.exec(q).toArray()[0].n;
    return {
      queued: c(`SELECT COUNT(*) AS n FROM shots WHERE status = 'queued'`),
      processed: c(`SELECT COUNT(*) AS n FROM shots WHERE status = 'done'`),
      reviews: c('SELECT COUNT(*) AS n FROM reviews'),
    };
  }

  review(id, action, title) {
    this.sql.exec(`INSERT INTO reviews (id, action, title, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET action = excluded.action, at = excluded.at`, id, action, title, new Date().toISOString());
    return { ok: true };
  }

  reviews() { return this.sql.exec('SELECT id, action, title, at FROM reviews ORDER BY at').toArray(); }

  ackReviews(ids) {
    for (const id of ids) this.sql.exec('DELETE FROM reviews WHERE id = ?', id);
    return { ok: true };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allow = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin === allow ? allow : allow,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Ingest-Key,X-Owner-Pass,X-Queue-Key,X-File-Name',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const q = env.QUEUE.get(env.QUEUE.idFromName('main'));
    const ownerOk = async () => {
      const pass = req.headers.get('X-Owner-Pass') || '';
      return !!pass && safeEqual(await sha256(new TextEncoder().encode(pass)), env.OWNER_HASH || '');
    };
    const queueOk = () => !!env.QUEUE_KEY && safeEqual(req.headers.get('X-Queue-Key') || '', env.QUEUE_KEY);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' && req.method === 'GET') {
        return new Response('Watchlist screenshot inbox. POST a screenshot to /i/<key>.\n', { headers: cors });
      }
      if (path === '/status' && req.method === 'GET') return json(await q.status());

      /* ---- ingest ---- */
      const keyInPath = path.startsWith('/i/') ? decodeURIComponent(path.slice(3)) : null;
      if ((keyInPath !== null || path === '/ingest') && req.method === 'POST') {
        const key = keyInPath ?? req.headers.get('X-Ingest-Key') ?? '';
        const authed = (env.INGEST_KEY && safeEqual(key, env.INGEST_KEY)) || (await ownerOk());
        if (!authed) return json({ error: 'forbidden' }, 403);
        const ctype = (req.headers.get('Content-Type') || 'application/octet-stream').split(';')[0];
        if (!/^(image\/|application\/octet-stream)/.test(ctype)) return json({ error: 'send the image as the raw request body' }, 415);
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength) return json({ error: 'empty body' }, 400);
        if (bytes.byteLength > MAX_BYTES) return json({ error: 'too large' }, 413);
        const name = (url.searchParams.get('name') || req.headers.get('X-File-Name') || '').slice(0, 120);
        const sha = await sha256(bytes);
        const r = await q.put(sha, name, ctype, bytes);
        return json(r, r.status === 'queued' ? 201 : 200);
      }

      /* ---- owner review decisions (browser) ---- */
      if (path === '/review' && req.method === 'POST') {
        if (!(await ownerOk())) return json({ error: 'forbidden' }, 403);
        const b = await req.json();
        if (!b || typeof b.id !== 'string' || !['approve', 'dismiss'].includes(b.action)) return json({ error: 'bad request' }, 400);
        return json(await q.review(b.id.slice(0, 200), b.action, String(b.title || '').slice(0, 200)));
      }
      if (path === '/owner-check' && req.method === 'POST') return json({ ok: await ownerOk() }, 200);

      /* ---- GitHub Action ---- */
      if (path.startsWith('/queue') || path.startsWith('/reviews')) {
        if (!queueOk()) return json({ error: 'forbidden' }, 403);
        if (path === '/queue' && req.method === 'GET') return json(await q.list(Number(url.searchParams.get('limit')) || 100));
        let m = path.match(/^\/queue\/([0-9a-f]{64})$/);
        if (m && req.method === 'GET') {
          const r = await q.get(m[1]);
          if (!r) return json({ error: 'not found' }, 404);
          return new Response(r.bytes, { headers: { 'Content-Type': r.ctype } });
        }
        m = path.match(/^\/queue\/([0-9a-f]{64})\/done$/);
        if (m && req.method === 'POST') return json(await q.done(m[1]));
        if (path === '/reviews' && req.method === 'GET') return json(await q.reviews());
        if (path === '/reviews/ack' && req.method === 'POST') {
          const b = await req.json();
          return json(await q.ackReviews(Array.isArray(b?.ids) ? b.ids.map(String) : []));
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
