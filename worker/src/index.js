/* Watchlist Worker — keeps the Airtable token server-side.
 *   - Guest voting:  GET /tallies, POST /vote   (browser never sees the token)
 *   - Daily backup:  cron trigger (+ gated POST /backup) upserts data.json -> Watchlist
 *
 * Secrets (wrangler secret put): AIRTABLE_PAT, CRON_KEY
 * Vars (wrangler.toml): AIRTABLE_BASE, VOTES_TABLE, WATCHLIST_TABLE, DATA_URL, ALLOW_ORIGIN
 */
const API = 'https://api.airtable.com/v0';

const cors = (o) => ({
  'Access-Control-Allow-Origin': o,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
const json = (obj, status, o) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(o) } });
const auth = (env) => ({ Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' });
const votesUrl = (env) => `${API}/${env.AIRTABLE_BASE}/${encodeURIComponent(env.VOTES_TABLE || 'Votes')}`;

async function tallies(env) {
  const out = {}; let offset = '';
  do {
    const r = await fetch(`${votesUrl(env)}?pageSize=100${offset ? `&offset=${offset}` : ''}`, { headers: auth(env) });
    if (!r.ok) break;
    const j = await r.json();
    for (const rec of j.records || []) {
      const f = rec.fields || {}; const id = f.item_id; if (!id) continue;
      (out[id] = out[id] || { up: 0, down: 0 });
      if (f.Vote === 'up') out[id].up++; else if (f.Vote === 'down') out[id].down++;
    }
    offset = j.offset || '';
  } while (offset);
  for (const k in out) out[k].net = out[k].up - out[k].down;
  return out;
}

async function backup(env) {
  const url = `${API}/${env.AIRTABLE_BASE}/${encodeURIComponent(env.WATCHLIST_TABLE || 'Watchlist')}`;
  const data = await (await fetch(env.DATA_URL, { cf: { cacheTtl: 0 } })).json();
  const map = (it) => ({
    id: it.id || '', Title: it.title || '', Type: it.type || '', Year: it.year ?? null,
    Author: it.author || '', Genres: (it.tags || []).join(', '), Summary: it.summary || '',
    Blurb: it.blurb || '', Poster: it.poster || '', Verdict: it.verdict || '',
    Status: it.status || '', Source: it.source || '',
  });
  let done = 0;
  for (let i = 0; i < data.length; i += 10) {
    const recs = data.slice(i, i + 10).map((it) => ({ fields: map(it) }));
    const r = await fetch(url, {
      method: 'PATCH', headers: auth(env),
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['id'] }, records: recs, typecast: true }),
    });
    if (!r.ok) return { ok: false, done, status: r.status, error: (await r.text()).slice(0, 300) };
    done += recs.length;
  }
  return { ok: true, done };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // ALLOW_ORIGIN may list several origins, comma-separated (custom domain + the old github.io host).
    const allowed = String(env.ALLOW_ORIGIN || '*').split(',').map((x) => x.trim()).filter(Boolean);
    const reqO = req.headers.get('Origin');
    const o = allowed.includes('*') ? '*' : (allowed.includes(reqO) ? reqO : allowed[0]);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(o) });
    try {
      if (url.pathname === '/tallies' && req.method === 'GET') return json(await tallies(env), 200, o);

      if (url.pathname === '/vote' && req.method === 'POST') {
        const b = await req.json(); const base = votesUrl(env);
        if (b.op === 'create') {
          const r = await fetch(base, { method: 'POST', headers: auth(env),
            body: JSON.stringify({ fields: { item_id: String(b.item_id), Title: String(b.title || ''), Vote: b.vote } }) });
          const j = await r.json(); return json({ id: j.id || null }, r.ok ? 200 : 502, o);
        }
        if (b.op === 'update' && b.recordId) {
          const r = await fetch(`${base}/${b.recordId}`, { method: 'PATCH', headers: auth(env), body: JSON.stringify({ fields: { Vote: b.vote } }) });
          return json({ ok: r.ok }, r.ok ? 200 : 502, o);
        }
        if (b.op === 'delete' && b.recordId) {
          const r = await fetch(`${base}/${b.recordId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
          return json({ ok: r.ok }, r.ok ? 200 : 502, o);
        }
        return json({ error: 'bad op' }, 400, o);
      }

      if (url.pathname === '/backup' && req.method === 'POST') {
        if (!env.CRON_KEY || url.searchParams.get('key') !== env.CRON_KEY) return json({ error: 'forbidden' }, 403, o);
        return json(await backup(env), 200, o);
      }

      return json({ error: 'not found' }, 404, o);
    } catch (e) {
      return json({ error: String(e) }, 500, o);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(backup(env).then((r) => console.log('cron backup:', JSON.stringify(r))));
  },
};
