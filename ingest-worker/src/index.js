/* Watchlist screenshot inbox.
 *
 *   POST /i/<INGEST_KEY>            raw image body (iOS Shortcut). Optional ?name=IMG_123.PNG&taken=<date taken>
 *                                   (name+taken also dedupes re-encoded copies)
 *   POST /ingest                    same, auth via X-Ingest-Key or X-Owner-Pass (web upload)
 *   GET  /status                    public counts {queued, queued_mb, processed, reviews, received_last_hour}
 *   POST /review                    owner review decision {id, action: approve|dismiss, title, pass}
 *
 *   -- GitHub Action only (X-Queue-Key) --
 *   GET  /queue                     list queued screenshots
 *   GET  /queue/<sha>               image bytes
 *   POST /queue/<sha>/done          drop the image, keep the sha as "seen"
 *   GET  /reviews                   pending review decisions
 *   GET  /queue-attempts            recent upload attempts (accepted / duplicate / rejected)
 *   POST /reviews/ack               {ids:[...]} clear applied decisions
 *
 * Every image is keyed by its SHA-256, so re-sending the same screenshot (the
 * Shortcut looks back a little over a day each run) is a cheap no-op.
 */
import { DurableObject } from 'cloudflare:workers';

const CHUNK = 1_500_000;          // DO SQLite rows max out at 2 MB
const MAX_BYTES = 20_000_000;
const QUEUE_SOFT_CAP = 3_500_000_000;   // free-plan DO storage is 5 GB; above this, ask the phone to retry later

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
    // Stable photo identity from the Shortcut (file name + date taken), so a
    // re-encoded copy of an already-sent screenshot is still recognised.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seen_keys (k TEXT PRIMARY KEY, sha TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS shots_status_received ON shots (status, received)`);
    // Every upload attempt (accepted, duplicate or rejected), so "my screenshots never showed up"
    // can be told apart from "the Shortcut never ran". Trimmed to the newest 2000 rows.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS attempts (at TEXT, result TEXT, code INTEGER, ctype TEXT, size INTEGER, via TEXT)`);
  }

  logAttempt(result, code, ctype, size, via) {
    this.sql.exec('INSERT INTO attempts (at, result, code, ctype, size, via) VALUES (?, ?, ?, ?, ?, ?)',
      new Date().toISOString(), result, code, String(ctype || '').slice(0, 80), size || 0, via || '');
    this.sql.exec('DELETE FROM attempts WHERE rowid NOT IN (SELECT rowid FROM attempts ORDER BY at DESC LIMIT 2000)');
    return { ok: true };
  }

  attempts(limit = 50) {
    return this.sql.exec('SELECT at, result, code, ctype, size, via FROM attempts ORDER BY at DESC LIMIT ?', limit).toArray();
  }

  put(sha, name, ctype, bytes, key) {
    if (key && this.sql.exec('SELECT 1 FROM seen_keys WHERE k = ?', key).toArray().length) return { status: 'duplicate', sha };
    const seen = this.sql.exec('SELECT status FROM shots WHERE sha = ?', sha).toArray();
    if (seen.length) {
      if (key) this.sql.exec('INSERT OR IGNORE INTO seen_keys (k, sha) VALUES (?, ?)', key, sha);
      return { status: 'duplicate', sha };
    }
    const queuedBytes = this.sql.exec(`SELECT COALESCE(SUM(size), 0) AS b FROM shots WHERE status = 'queued'`).toArray()[0].b;
    if (queuedBytes + bytes.byteLength > QUEUE_SOFT_CAP) return { status: 'busy', sha };
    const u8 = new Uint8Array(bytes);
    const parts = Math.max(1, Math.ceil(u8.byteLength / CHUNK));
    for (let i = 0; i < parts; i++) {
      this.sql.exec('INSERT INTO parts (sha, idx, data) VALUES (?, ?, ?)', sha, i, u8.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    this.sql.exec('INSERT INTO shots (sha, name, ctype, size, parts, received) VALUES (?, ?, ?, ?, ?, ?)',
      sha, name, ctype, u8.byteLength, parts, new Date().toISOString());
    if (key) this.sql.exec('INSERT OR IGNORE INTO seen_keys (k, sha) VALUES (?, ?)', key, sha);
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
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    return {
      queued: c(`SELECT COUNT(*) AS n FROM shots WHERE status = 'queued'`),
      queued_mb: Math.round(this.sql.exec(`SELECT COALESCE(SUM(size), 0) AS b FROM shots WHERE status = 'queued'`).toArray()[0].b / 1e6),
      received_last_hour: this.sql.exec('SELECT COUNT(*) AS n FROM shots WHERE received > ?', hourAgo).toArray()[0].n,
      last_received: this.sql.exec('SELECT MAX(received) AS m FROM shots').toArray()[0].m,
      processed: c(`SELECT COUNT(*) AS n FROM shots WHERE status = 'done'`),
      reviews: c('SELECT COUNT(*) AS n FROM reviews'),
      attempts_last_day: this.sql.exec('SELECT result, COUNT(*) AS n FROM attempts WHERE at > ? GROUP BY result', new Date(Date.now() - 86400_000).toISOString())
        .toArray().reduce((o, r) => ({ ...o, [r.result]: r.n }), {}),
      last_attempt: this.sql.exec('SELECT at, result, code FROM attempts ORDER BY at DESC LIMIT 1').toArray()[0] || null,
      last_rejected: this.sql.exec(`SELECT at, result, code, ctype FROM attempts WHERE code >= 400 ORDER BY at DESC LIMIT 1`).toArray()[0] || null,
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
    // ALLOW_ORIGIN may list several origins, comma-separated (custom domain + the old github.io host).
    const allowed = String(env.ALLOW_ORIGIN || '*').split(',').map((o) => o.trim()).filter(Boolean);
    const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': allow,
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
        const via = keyInPath !== null ? 'shortcut' : (req.headers.get('X-Owner-Pass') ? 'web' : 'header-key');
        let ctype = (req.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        const reject = async (result, code, body, size = 0) => { await q.logAttempt(result, code, ctype, size, via); return json(body, code); };
        const authed = (env.INGEST_KEY && safeEqual(key, env.INGEST_KEY)) || (await ownerOk());
        if (!authed) return reject('forbidden', 403, { error: 'forbidden' });
        let bytes; let partName = '';
        if (ctype === 'multipart/form-data') {
          // Shortcut set to "Request Body: Form" instead of "File": take the first file field.
          const form = await req.formData();
          const file = [...form.values()].find((v) => typeof v === 'object' && v && 'arrayBuffer' in v);
          if (!file) return reject('no-file-in-form', 400, { error: 'form had no file; set Request Body to File' });
          bytes = await file.arrayBuffer(); ctype = (file.type || 'application/octet-stream').toLowerCase(); partName = file.name || '';
        } else if (!/^(image\/|application\/octet-stream|binary\/)/.test(ctype)) {
          // Some clients label raw image bodies oddly (e.g. x-www-form-urlencoded). Accept if the bytes look like an image.
          bytes = await req.arrayBuffer();
          const b = new Uint8Array(bytes.slice(0, 12));
          const isImg = (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70);
          if (!isImg) return reject('bad-type', 415, { error: 'send the image as the raw request body' }, bytes.byteLength);
          ctype = b[0] === 0xff ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : 'image/heic';
        }
        if (!bytes) bytes = await req.arrayBuffer();
        if (!bytes.byteLength) return reject('empty', 400, { error: 'empty body' });
        if (bytes.byteLength > MAX_BYTES) return reject('too-large', 413, { error: 'too large' }, bytes.byteLength);
        const name = (url.searchParams.get('name') || req.headers.get('X-File-Name') || partName || '').slice(0, 120);
        const taken = (url.searchParams.get('taken') || '').slice(0, 64);
        const photoKey = name && taken ? `${name}|${taken}` : null;
        const sha = await sha256(bytes);
        const r = await q.put(sha, name, ctype, bytes, photoKey);
        await q.logAttempt(r.status, r.status === 'busy' ? 503 : r.status === 'queued' ? 201 : 200, ctype, bytes.byteLength, via);
        if (r.status === 'busy') return json({ ...r, message: 'inbox is full right now; send again later (already-sent ones are skipped)' }, 503);
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
        if (path === '/queue-attempts' && req.method === 'GET') return json(await q.attempts(Number(url.searchParams.get('limit')) || 50));
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
