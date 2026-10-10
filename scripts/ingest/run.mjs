#!/usr/bin/env node
/* Screenshot ingest: queue (Worker) -> cheap media check -> vision parse ->
 * enrich (TMDB if keyed, else Wikipedia; Steam for games; Open Library for books)
 * -> dedupe -> data.json (+ posters/), with a ledger so nothing is parsed twice.
 *
 *   node run.mjs                 process the Worker queue (GitHub Action)
 *   node run.mjs --ack           after the commit is pushed: ack processed shots + reviews
 *   node run.mjs --local DIR     process image files in DIR (testing; no queue, no ack)
 *   flags: --limit N  --dry-run
 *
 * env: OPENAI_API_KEY, WATCHLIST_QUEUE_URL, WATCHLIST_QUEUE_KEY, [TMDB_API_KEY],
 *      [CLASSIFY_MODEL=gpt-4.1-nano] [PARSE_MODEL=gpt-4.1-mini] [MAX_RUN_USD=2]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { titleKey, family, buildIndex, findDuplicate, uniqueId, costOf, decideStatus } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DATA = join(ROOT, 'data.json');
const LEDGER = join(HERE, 'ledger.json');
const PENDING = join(HERE, '.pending-acks.json');
const POSTERS = join(ROOT, 'posters');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = Number(opt('--limit', process.env.INGEST_LIMIT || 40));
const DRY = flag('--dry-run');
const LOCAL = opt('--local', null);

const QURL = (process.env.WATCHLIST_QUEUE_URL || 'https://watchlist-ingest.threesided.workers.dev').replace(/\/$/, '');
const QKEY = process.env.WATCHLIST_QUEUE_KEY || '';
const OPENAI = process.env.OPENAI_API_KEY || '';
const TMDB = process.env.TMDB_API_KEY || '';
const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || 'gpt-4.1-nano';
const PARSE_MODEL = process.env.PARSE_MODEL || 'gpt-4.1-mini';
const MAX_RUN_USD = Number(process.env.MAX_RUN_USD || 2);
const UA = { 'user-agent': 'watchlist-ingest/1.0 (+https://github.com/Threesided-Studios/watchlist)' };
const today = () => new Date().toISOString().slice(0, 10);

const qfetch = (p, init = {}) => fetch(`${QURL}${p}`, { ...init, headers: { 'X-Queue-Key': QKEY, ...(init.headers || {}) } });

/* ---------------- ack mode ---------------- */
if (flag('--ack')) {
  if (!existsSync(PENDING)) { console.log('nothing to ack'); process.exit(0); }
  const p = JSON.parse(readFileSync(PENDING, 'utf8'));
  for (const sha of p.shots || []) {
    const r = await qfetch(`/queue/${sha}/done`, { method: 'POST' });
    if (!r.ok) console.warn('ack failed', sha.slice(0, 12), r.status);
  }
  if ((p.reviews || []).length) {
    await qfetch('/reviews/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: p.reviews }) });
  }
  unlinkSync(PENDING);
  console.log(`acked ${p.shots?.length || 0} screenshots, ${p.reviews?.length || 0} reviews`);
  process.exit(0);
}

/* ---------------- helpers ---------------- */
async function getJSON(url, headers = {}, timeoutMs = 10000) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function openai(model, messages, schema, maxTokens = 900) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, temperature: 0, max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } },
      }),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(`openai ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return { out: JSON.parse(j.choices[0].message.content), cost: costOf(model, j.usage), usage: j.usage };
  }
  throw new Error('openai: retries exhausted');
}

const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

const CLASSIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['media'],
  properties: { media: { type: 'boolean' } },
};

async function isMediaShot(img) {
  const small = await sharp(img).rotate().resize({ width: 384, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
  const { out, cost } = await openai(CLASSIFY_MODEL, [
    { role: 'system', content: 'You triage iPhone screenshots for a personal watch/read/play list.' },
    { role: 'user', content: [
      { type: 'text', text: 'Does this screenshot show or name at least one specific movie, TV show, anime, book, or video game (e.g. a poster or cover, a streaming/store/Goodreads/Letterboxd/IMDb page, a list, or a Reddit/social post or chat recommending titles)? Generic apps, maps, receipts, memes without a named title, music, and chats with no title => false. If unsure, answer true.' },
      { type: 'image_url', image_url: { url: dataUrl(small), detail: 'low' } },
    ] },
  ], CLASSIFY_SCHEMA, 20);
  return { media: out.media, cost };
}

const PARSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['screenshot_kind', 'source_context', 'titles'],
  properties: {
    screenshot_kind: { type: 'string', description: 'e.g. reddit thread, streaming app page, poster, book cover, store page, text message, social post, list' },
    source_context: { type: 'string', description: 'Where this came from, short. e.g. \'Reddit r/MovieSuggestions: "Best slow-burn horror?"\' or \'Netflix title page\' or \'Facebook post by a friend\'. Never include full names of private people (first names or usernames only). Empty if unclear.' },
    titles: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'type', 'is_anime', 'year', 'creator', 'recommended_by', 'why', 'genres', 'evidence', 'confidence'],
        properties: {
          title: { type: 'string', description: 'Canonical title, properly capitalised, no year' },
          type: { type: 'string', enum: ['movie', 'show', 'book', 'game'] },
          is_anime: { type: 'boolean' },
          year: { type: ['integer', 'null'] },
          creator: { type: ['string', 'null'], description: 'Author for books, director/studio if visible; null otherwise' },
          recommended_by: { type: ['string', 'null'], description: 'Who recommends it: a Reddit/online username, or ONLY the first name of a private person. Never a full name. null if none.' },
          why: { type: 'string', description: 'Very short reason it was mentioned (e.g. "top-voted reply: like Arrival but darker"). Empty if none.' },
          genres: { type: 'array', items: { type: 'string' }, description: 'Up to 3 genres' },
          evidence: { type: 'string', enum: ['recommended_or_discussed', 'poster_or_cover', 'store_or_streaming_page', 'ambiguous'], description: 'How the screenshot presents it as a work. ambiguous = could be a brand, product, phrase or unrelated word.' },
          confidence: { type: 'number', description: '0-1: certainty that this exact title is named/shown as a creative work AND correctly identified (title and type)' },
        },
      },
    },
  },
};

async function parseShot(img) {
  const big = await sharp(img).rotate().resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return openai(PARSE_MODEL, [
    { role: 'system', content: [
      'You extract media titles from iPhone screenshots for a personal watch/read/play list.',
      'Only list titles that are explicitly named or clearly shown (poster/cover/title card) AS a movie, TV show, anime, book, or video game. Never invent titles that are not on screen.',
      'Brand names, product names, companies, logos on merchandise, song/album names, YouTube videos, podcasts and people are NOT titles. A word that merely matches a book or game name is not enough: there must be a sign it is the work (recommended, discussed, being watched/read/played, a poster/cover/store page).',
      'Pick the type from context: "on Netflix", "watch", "season", "episodes" => show or movie even if a game or book shares the name; "read", "author", "novel" => book; "play", "Steam", "Switch" => game.',
      'Use the title as it is commonly listed on Wikipedia/TMDB/Steam/Goodreads, with correct capitalisation and punctuation; expand obvious abbreviations ("TLOU" => "The Last of Us").',
      'Include every distinct qualifying title (max 25), including ones recommended in comments. Use low confidence and evidence=ambiguous when unsure.',
    ].join(' ') },
    { role: 'user', content: [
      { type: 'text', text: 'Extract the titles in this screenshot.' },
      { type: 'image_url', image_url: { url: dataUrl(big), detail: 'high' } },
    ] },
  ], PARSE_SCHEMA, 1800);
}

/* ---------------- enrichment ---------------- */
function sameTitle(a, b) {
  const x = titleKey(a), y = titleKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  return s.length >= 4 && (l.startsWith(s + '-') || l.endsWith('-' + s) || l === s);
}
const YEAR = /\b(18|19|20)\d{2}\b/;
const clean = (t) => String(t || '').replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
const stripParen = (t) => clean(t).replace(/\s*\([^)]*\)\s*$/, '');
/* exact = same title after normalising (optionally ignoring a ": subtitle" on either side) */
function exactTitle(a, b) {
  return titleKey(stripParen(a)) === titleKey(stripParen(b));
}
/* "Foo (2003 video game)" is only acceptable when the disambiguator fits the type */
function parenFits(pageTitle, rx) {
  const m = pageTitle.match(/\(([^)]*)\)\s*$/);
  return !m || rx.test(m[1]);
}
/* Keep friends' full names out of a public repo: first names / usernames only. */
function privacyScrub(cand, ctx) {
  let who = clean(cand.recommended_by || '');
  const personal = /facebook|instagram|threads|imessage|text message|messages|whatsapp|messenger|group chat|discord|snapchat|email/i.test(ctx);
  const looksLikePerson = (n) => /^[A-Z][a-z'’-]+(\s+[A-Z][A-Za-z'’.-]+){1,3}$/.test(n);
  if (personal && who && looksLikePerson(who)) {
    const first = who.split(/\s+/)[0];
    ctx = ctx.split(who).join(first);
    who = first;
  }
  if (personal) {
    ctx = ctx.replace(/\b(post|comment|message|text|story|reply|chat)\s+(by|from)\s+([A-Z][a-z'’-]+)((?:\s+[A-Z][A-Za-z'’.-]+){1,3})/g,
      (m, what, prep, first) => `${what} ${prep} ${first}`);
  }
  return { who, ctx };
}

async function viaTMDB(c) {
  if (!TMDB) return null;
  const kind = c.type === 'show' ? 'tv' : 'movie';
  const auth = TMDB.length > 40 ? { Authorization: `Bearer ${TMDB}` } : {};
  const keyQ = TMDB.length > 40 ? '' : `&api_key=${TMDB}`;
  const yq = c.year ? (kind === 'tv' ? `&first_air_date_year=${c.year}` : `&year=${c.year}`) : '';
  const j = await getJSON(`https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(c.title)}${yq}${keyQ}`, auth);
  const hits = j?.results || [];
  const hit = hits.find((h) => exactTitle(h.title || h.name, c.title)) || hits.find((h) => sameTitle(h.title || h.name, c.title));
  if (!hit) return null;
  const date = hit.release_date || hit.first_air_date || '';
  return {
    title: hit.title || hit.name, year: Number(date.slice(0, 4)) || c.year || null,
    blurb: (hit.overview || '').split(/(?<=\.)\s/)[0] || '', summary: hit.overview || '',
    link: `https://www.themoviedb.org/${kind}/${hit.id}`, tmdb_id: hit.id,
    posterUrl: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
  };
}

const WIKI_HINT = { movie: 'film', show: 'TV series', book: 'novel', game: 'video game' };
async function viaWikipedia(c) {
  const hint = c.is_anime ? (c.type === 'movie' ? 'anime film' : 'anime') : WIKI_HINT[c.type];
  const s = await getJSON(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: `${c.title} ${hint}`, format: 'json', srlimit: '5' })}`);
  const hits = s?.query?.search || [];
  const rx = new RegExp({ film: 'film|movie', series: 'series|show|anime', anime: 'anime|series|film|manga', novel: 'novel|book|series', game: 'game' }[hint.split(' ').pop()] || hint, 'i');
  const ok = hits.filter((h) => parenFits(h.title, rx));
  const ordered = [
    ...ok.filter((h) => exactTitle(h.title, c.title) && rx.test(h.snippet + h.title)),
    ...ok.filter((h) => exactTitle(h.title, c.title)),
    ...ok.filter((h) => sameTitle(stripParen(h.title), c.title) && rx.test(h.snippet + h.title)),
  ];
  for (const h of ordered.slice(0, 2)) {
    const w = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`);
    if (!w || w.type === 'disambiguation') continue;
    const y = (w.description || '').match(YEAR) || (w.extract || '').match(YEAR);
    return {
      title: stripParen(w.title || c.title), year: c.year || (y ? Number(y[0]) : null),
      blurb: (w.extract || '').split(/(?<=\.)\s/)[0] || '', summary: w.extract || '',
      link: w.content_urls?.desktop?.page || '',
      posterUrl: w.originalimage?.source || w.thumbnail?.source || null,
    };
  }
  return null;
}

async function viaSteam(c) {
  const j = await getJSON(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(c.title)}&cc=us&l=en`);
  const hit = (j?.items || []).find((h) => exactTitle(h.name, c.title)) || (j?.items || []).find((h) => sameTitle(h.name, c.title));
  if (!hit) return null;
  const d = (await getJSON(`https://store.steampowered.com/api/appdetails?appids=${hit.id}&cc=us&l=en`))?.[hit.id]?.data;
  const y = (d?.release_date?.date || '').match(YEAR);
  return {
    title: clean(hit.name), year: y ? Number(y[0]) : c.year || null,
    blurb: d?.short_description || '', summary: '',
    link: `https://store.steampowered.com/app/${hit.id}/`, steam_appid: hit.id,
    posterUrl: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${hit.id}/library_600x900_2x.jpg`,
    posterFallback: d?.header_image || null,
  };
}

async function viaOpenLibrary(c) {
  const q = new URLSearchParams({ title: c.title, limit: '5', fields: 'key,title,author_name,first_publish_year,cover_i' });
  if (c.creator) q.set('author', c.creator);
  let j = await getJSON(`https://openlibrary.org/search.json?${q}`);
  if (!j?.docs?.length && c.creator) { q.delete('author'); j = await getJSON(`https://openlibrary.org/search.json?${q}`); }
  const hit = (j?.docs || []).find((d) => sameTitle(d.title, c.title) && d.cover_i) || (j?.docs || []).find((d) => sameTitle(d.title, c.title));
  if (!hit) return null;
  return {
    title: hit.title, year: hit.first_publish_year || c.year || null, author: hit.author_name?.[0] || c.creator || '',
    blurb: '', summary: '', link: `https://openlibrary.org${hit.key}`,
    posterUrl: hit.cover_i ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg` : null,
  };
}

async function enrich(c) {
  const chain = c.type === 'game' ? [viaSteam, viaWikipedia]
    : c.type === 'book' ? [viaOpenLibrary, viaWikipedia]
    : [viaTMDB, viaWikipedia];
  for (const fn of chain) {
    try { const r = await fn(c); if (r) return { ...r, via: fn.name.replace('via', '') }; } catch { /* next */ }
  }
  return null;
}

async function savePoster(urls, id) {
  for (const url of urls.filter(Boolean)) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const out = await sharp(buf).rotate().resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      if (!DRY) writeFileSync(join(POSTERS, `${id}.jpg`), out);
      return `posters/${id}.jpg`;
    } catch { /* try next */ }
  }
  return '';
}

/* ---------------- main ---------------- */
if (!OPENAI) { console.error('OPENAI_API_KEY missing'); process.exit(1); }
if (!LOCAL && !QKEY) { console.error('WATCHLIST_QUEUE_KEY missing'); process.exit(1); }

const items = JSON.parse(readFileSync(DATA, 'utf8'));
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { shots: {}, dismissed: [], totals: { shots: 0, media: 0, added: 0, inbox: 0, usd: 0 } };
const pending = { shots: [], reviews: [] };
let changed = false;

/* 1) apply owner review decisions from the web app */
if (!LOCAL) {
  const r = await qfetch('/reviews');
  const reviews = r.ok ? await r.json() : [];
  for (const rv of reviews) {
    const i = items.findIndex((it) => it.id === rv.id);
    if (i >= 0) {
      const it = items[i];
      if (rv.action === 'approve' && it.status === 'inbox') { it.status = 'todo'; changed = true; }
      if (rv.action === 'dismiss') {
        ledger.dismissed.push(`${family(it.type)}:${titleKey(it.title)}`);
        if (it.source === 'screenshot' && it.poster && existsSync(join(ROOT, it.poster)) && !DRY) unlinkSync(join(ROOT, it.poster));
        items.splice(i, 1); changed = true;
      }
    }
    pending.reviews.push(rv.id);
  }
  if (reviews.length) console.log(`applied ${reviews.length} review decision(s)`);
}

/* 2) collect screenshots */
let shots = [];
if (LOCAL) {
  shots = readdirSync(LOCAL).filter((f) => /\.(png|jpe?g|heic|webp)$/i.test(f)).sort().map((f) => {
    const bytes = readFileSync(join(LOCAL, f));
    return { sha: createHash('sha256').update(bytes).digest('hex'), name: f, bytes };
  });
} else {
  const r = await qfetch(`/queue?limit=${LIMIT}`);
  if (!r.ok) { console.error('queue list failed', r.status); process.exit(1); }
  shots = await r.json();
}
shots = shots.slice(0, LIMIT);
console.log(`${shots.length} screenshot(s) to process`);

const index = buildIndex(items);
const dismissed = new Set(ledger.dismissed);
const taken = new Set(items.map((i) => i.id));
let runUsd = 0;
const report = [];

let budgetHit = false;
async function processShot(s) {
  if (runUsd >= MAX_RUN_USD) { budgetHit = true; return; }
  if (ledger.shots[s.sha]) { pending.shots.push(s.sha); report.push({ name: s.name, outcome: 'already-processed' }); return; }
  let bytes = s.bytes;
  if (!bytes) {
    const r = await qfetch(`/queue/${s.sha}`);
    if (!r.ok) { console.warn('fetch failed', s.sha.slice(0, 12)); return; }
    bytes = Buffer.from(await r.arrayBuffer());
  }
  const entry = { at: new Date().toISOString(), outcome: 'not-media', ids: [], usd: 0 };
  try {
    const c1 = await isMediaShot(bytes);
    entry.usd += c1.cost;
    if (c1.media) {
      const p = await parseShot(bytes);
      entry.usd += p.cost;
      const titles = p.out.titles || [];
      entry.outcome = titles.length ? 'parsed' : 'no-titles';
      for (const t of titles) {
        const cand = { ...t, title: clean(t.title) };
        if (cand.title.length < 2 || (cand.confidence ?? 0) < 0.3) continue;   // model itself says "not a title"
        const famKey = `${family(cand.type)}:${titleKey(cand.title)}`;
        if (dismissed.has(famKey)) { report.push({ name: s.name, title: cand.title, outcome: 'previously-dismissed' }); continue; }
        const dup = findDuplicate(index, cand);
        if (dup) { report.push({ name: s.name, title: cand.title, outcome: `duplicate of ${dup}` }); entry.ids.push(dup); continue; }
        index.set(famKey, '(pending)');   // reserve before any await so parallel shots can't add the same title twice
        const e = await enrich(cand);
        const exact = !!e && exactTitle(e.title, cand.title);
        const title = e?.title && exact ? clean(e.title) : cand.title;
        const id = uniqueId(title, taken, e?.year || cand.year);
        taken.add(id);   // claim the id before the poster download await
        const status = cand.evidence === 'ambiguous' ? 'inbox' : decideStatus(cand, { enriched: exact, threshold: 0.85 });
        const poster = e ? await savePoster([e.posterUrl, e.posterFallback], id) : '';
        const tags = [...(cand.is_anime ? ['Anime'] : []), ...(cand.genres || [])].slice(0, 4);
        const { who, ctx } = privacyScrub(cand, [p.out.source_context, cand.why].filter(Boolean).join(' — '));
        const item = {
          id, title, type: cand.type, year: e?.year || cand.year || null,
          blurb: e?.blurb || '', summary: e?.summary || '', poster, link: e?.link || '',
          status, tags, rating: null, notes: '', added: today(),
          source: 'screenshot', source_context: ctx, recommended_by: who,
          ai_confidence: Math.round((cand.confidence || 0) * 100) / 100,
          enriched_via: e?.via || '', screenshot: s.sha.slice(0, 12),
          ...(e?.author || cand.creator && cand.type === 'book' ? { author: e?.author || cand.creator } : {}),
          ...(e?.tmdb_id ? { tmdb_id: e.tmdb_id } : {}),
          ...(e?.steam_appid ? { steam_appid: e.steam_appid } : {}),
        };
        items.push(item); taken.add(id); index.set(famKey, id); changed = true;
        entry.ids.push(id);
        ledger.totals[status === 'todo' ? 'added' : 'inbox']++;
        report.push({ name: s.name, title, type: cand.type, year: item.year, outcome: status, conf: item.ai_confidence, via: item.enriched_via || 'none', poster: !!poster, context: ctx });
      }
      ledger.totals.media++;
    } else {
      report.push({ name: s.name, outcome: 'not-media' });
    }
  } catch (err) {
    console.warn('error on', s.name || s.sha.slice(0, 12), String(err).slice(0, 200));
    entry.outcome = 'error';
    report.push({ name: s.name, outcome: 'error', error: String(err).slice(0, 120) });
    return;   // not ledgered, not acked -> retried next run
  }
  entry.usd = Math.round(entry.usd * 1e6) / 1e6;
  runUsd += entry.usd;
  ledger.shots[s.sha] = entry;
  ledger.totals.shots++;
  ledger.totals.usd = Math.round((ledger.totals.usd + entry.usd) * 1e6) / 1e6;
  pending.shots.push(s.sha);
  changed = true;
}

/* small worker pool: screenshots are independent; shared state is only touched synchronously */
const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || 4);
const DEADLINE = Date.now() + Number(process.env.INGEST_MAX_MINUTES || 40) * 60_000;
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < shots.length && !budgetHit && Date.now() < DEADLINE) {
    const s = shots[next++];
    await processShot(s);
  }
}));
if (budgetHit) console.warn(`stopped early: run budget $${MAX_RUN_USD} reached`);
if (Date.now() >= DEADLINE) console.warn('stopped early: time budget reached (rest stays queued)');

if (!DRY) {
  if (changed) {
    writeFileSync(DATA, JSON.stringify(items, null, 2));
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
  }
  if (!LOCAL && (pending.shots.length || pending.reviews.length)) writeFileSync(PENDING, JSON.stringify(pending));
}
writeFileSync(join(HERE, '.last-report.json'), JSON.stringify({ runUsd, report }, null, 2));
const n = shots.length || 1;
console.log(JSON.stringify({ processed: shots.length, runUsd: Math.round(runUsd * 1e5) / 1e5, perShotUsd: Math.round((runUsd / n) * 1e5) / 1e5 }));
for (const r of report) console.log(' -', r.outcome.padEnd(18), r.title ? `${r.title} (${r.type || ''} ${r.year || ''}) conf=${r.conf ?? ''} via=${r.via ?? ''}` : (r.name || ''));
