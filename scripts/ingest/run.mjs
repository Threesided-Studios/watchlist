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
 *      [CLASSIFY_MODEL=gpt-6-luna] [PARSE_MODEL=gpt-6-luna] [MAX_RUN_USD=2]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CLASSIFY_MODEL, PARSE_MODEL } from './models.mjs';
import { completionBody } from './openai-request.mjs';
import { titleKey, family, tmdbKind, lookupType, setScreenKind, buildIndex, findDuplicate, uniqueId, costOf, decideStatus } from './lib.mjs';
import { normalizeItem } from '../../shared/normalize.js';
import { canonicalType } from '../../shared/taxonomy.js';
import { TRIAGE_WIDTH, PARSE_WIDTH, TRIAGE_SCHEMA, TRIAGE_SYSTEM, TRIAGE_PROMPT, PARSE_SCHEMA, PARSE_SYSTEM, PARSE_PROMPT, KEPT_ROLES, decideStatusV2 } from './vision.mjs';
import { EXTRA_CHAINS, EXTRA_FIELDS, pageUrl, fallbackLink } from './enrich-extra.mjs';

/* types the original enrichment chain (TMDB / Steam / Open Library / app stores) handles */
const LEGACY_TYPES = new Set(['movie', 'show', 'book', 'game', 'software']);
import { huntArt } from './art.mjs';
import { qaScreen, tmdbPosterUrl } from './qa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DATA = join(ROOT, 'data.json');
const LEDGER = join(HERE, 'ledger.json');
const PENDING = join(HERE, '.pending-acks.json');
const PENDING_EDITS = join(HERE, '.pending-edits.json');   // written by apply-edits.mjs
const POSTERS = join(ROOT, 'posters');
const PROVENANCE = join(ROOT, 'data', 'provenance.json');

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
const MAX_RUN_USD = Number(process.env.MAX_RUN_USD || 2);
const UA = { 'user-agent': 'watchlist-ingest/1.0 (+https://github.com/Threesided-Studios/watchlist)' };
const today = () => new Date().toISOString().slice(0, 10);

const qfetch = (p, init = {}) => fetch(`${QURL}${p}`, { ...init, headers: { 'X-Queue-Key': QKEY, ...(init.headers || {}) } });

/* ---------------- ack mode ---------------- */
if (flag('--ack')) {
  if (existsSync(PENDING_EDITS)) {
    const { upto } = JSON.parse(readFileSync(PENDING_EDITS, 'utf8'));
    const r = await qfetch('/edits/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upto }) });
    if (r.ok) { unlinkSync(PENDING_EDITS); console.log(`acked edits up to ${upto}`); } else console.warn('edit ack failed', r.status);
  }
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
      body: JSON.stringify(completionBody(model, messages, schema, maxTokens)),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(`openai ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    if (j.choices[0].finish_reason === 'length' && maxTokens < 6000) {   // long lists: retry once with room to finish
      const more = await openai(model, messages, schema, Math.min(6000, maxTokens * 3));
      return { ...more, cost: more.cost + costOf(model, j.usage) };
    }
    return { out: JSON.parse(j.choices[0].message.content), cost: costOf(model, j.usage), usage: j.usage };
  }
  throw new Error('openai: retries exhausted');
}

const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

/* Pass 1: is anything here worth saving, and what kind of screenshot is it? (prompts and schemas: vision.mjs) */
async function triageShot(img) {
  const small = await sharp(img).rotate().resize({ width: TRIAGE_WIDTH, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
  const { out, cost } = await openai(CLASSIFY_MODEL, [
    { role: 'system', content: TRIAGE_SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: TRIAGE_PROMPT },
      { type: 'image_url', image_url: { url: dataUrl(small), detail: 'low' } },
    ] },
  ], TRIAGE_SCHEMA, 80);
  return { ...out, cost };
}

/* Pass 2: everything the screenshot names, typed against the taxonomy. */
async function parseShot(img) {
  const big = await sharp(img).rotate().resize({ width: PARSE_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  const res = await openai(PARSE_MODEL, [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: PARSE_PROMPT },
      { type: 'image_url', image_url: { url: dataUrl(big), detail: 'high' } },
    ] },
  ], PARSE_SCHEMA, 2400);
  /* the kept copy is smaller than what the model read: it only has to be legible to a person */
  const keep = await sharp(img).rotate().resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  return { ...res, image: keep };
}

/* Keep the downsized screenshot at the Worker for 30 days (owner-only) so an item can show where it came from. */
async function keepShot(sha, jpeg) {
  if (LOCAL || DRY) return;
  try {
    const r = await qfetch(`/shots/${sha}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg });
    if (!r.ok && r.status !== 404) console.warn('keep screenshot failed', sha.slice(0, 12), r.status);   // 404: Worker not updated yet
  } catch (e) { console.warn('keep screenshot failed', sha.slice(0, 12), String(e).slice(0, 80)); }
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

const TMDB_GENRES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10765: 'Sci-Fi & Fantasy', 10768: 'War & Politics' };
async function tmdbSearch(kind, title, year) {
  const auth = process.env.TMDB_READ_TOKEN ? { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` } : {};
  const keyQ = process.env.TMDB_READ_TOKEN ? '' : `&api_key=${TMDB}`;
  const yq = year ? (kind === 'tv' ? `&first_air_date_year=${year}` : `&year=${year}`) : '';
  const url = (y) => `https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(title)}&include_adult=false${y}${keyQ}`;
  let j = await getJSON(url(yq), auth);
  if (yq && !(j?.results || []).length) j = await getJSON(url(''), auth);   // the screenshot's year may be off
  return j?.results || [];
}
async function viaTMDB(c) {
  if (!TMDB && !process.env.TMDB_READ_TOKEN) return null;
  const kind = c.type === 'show' ? 'tv' : 'movie';
  const hits = await tmdbSearch(kind, c.title, c.year);
  const exact = hits.filter((h) => exactTitle(h.title || h.name, c.title) || exactTitle(h.original_title || h.original_name || '', c.title));
  const hit = exact[0] || hits.find((h) => sameTitle(h.title || h.name, c.title));
  if (!hit) return null;
  const date = hit.release_date || hit.first_air_date || '';
  return {
    typeOk: !!exact.length && (!c.is_anime || (hit.genre_ids || []).includes(16) || hit.original_language === 'ja'),
    title: hit.title || hit.name, year: Number(date.slice(0, 4)) || c.year || null,
    blurb: (hit.overview || '').split(/(?<=\.)\s/)[0] || '', summary: hit.overview || '',
    link: `https://www.themoviedb.org/${kind}/${hit.id}`, tmdb_id: hit.id,
    genres: (hit.genre_ids || []).map((g) => TMDB_GENRES[g]).filter(Boolean),
    posterUrl: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
  };
}

const WIKI_HINT = { movie: 'film', show: 'TV series', book: 'novel', game: 'video game' };
/* Does the Wikipedia page describe a work of the expected type (not a person, company, app...)? */
const WIKI_TYPE_RX = {
  movie: /\b(film|movie|animated feature)\b/i,
  show: /\b(television|tv) (series|show|programme|program|special)|\banime\b|\b(web|animated|anthology|drama|streaming) series\b|\bsitcom\b|\btalk show\b|\bminiseries\b|\bmanga\b|\blight novel\b/i,
  game: /\bvideo games?\b|\b(role-playing|adventure|puzzle|platform|strategy|survival|visual novel|fighting|shooter|roguelike|simulation) (video )?game\b|\bgame (developed|published) by\b/i,
  book: /\b(novel|book|novella|memoir|short stor(y|ies)|manga|light novel|graphic novel|comic|poetry collection|non-fiction)\b/i,
};
const WIKI_BAD_RX = /\b(software|application|app\b|company|corporation|website|platform|programming|operating system|startup|actor|actress|singer|musician|politician|footballer|restaurant|brand|chatbot|language model)\b/i;
function wikiTypeOk(w, c) {
  const head = `${w.description || ''}. ${(w.extract || '').split(/(?<=\.)\s/)[0]}`;
  const rx = c.is_anime && c.type !== 'game' ? new RegExp(`${WIKI_TYPE_RX[c.type].source}|\\banime\\b|\\bmanga\\b`, 'i') : WIKI_TYPE_RX[c.type];
  if (!rx || !rx.test(head)) return false;
  return !WIKI_BAD_RX.test(w.description || '');
}

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
      typeOk: wikiTypeOk(w, c),
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
  const SOFTWARE = /utilit|software|design|illustration|video production|audio production|animation|modeling|photo editing|web publishing|education|game development|accounting/i;
  const typeOk = !!d && d.type === 'game' && !(d.genres || []).some((g) => SOFTWARE.test(g.description));
  return {
    typeOk,
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
    typeOk: !!hit.author_name?.length,
    title: hit.title, year: hit.first_publish_year || c.year || null, author: hit.author_name?.[0] || c.creator || '',
    blurb: '', summary: '', link: `https://openlibrary.org${hit.key}`,
    posterUrl: hit.cover_i ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg` : null,
  };
}

/* Software: Apple App Store / Mac App Store (iTunes Search API), then GitHub. */
async function viaAppStore(c) {
  for (const entity of ['macSoftware', 'software']) {
    const j = await getJSON(`https://itunes.apple.com/search?${new URLSearchParams({ term: c.title, entity, limit: '8', country: 'us' })}`);
    const hit = (j?.results || []).find((r) => exactTitle(r.trackName.split(/\s[-–—:|]\s/)[0], c.title) || exactTitle(r.trackName, c.title));
    if (!hit) continue;
    return {
      typeOk: true, title: clean(hit.trackName.split(/\s[-–—:|]\s/)[0]),
      year: Number((hit.releaseDate || '').slice(0, 4)) || null,
      blurb: (hit.description || '').split(/(?<=[.!?])\s/)[0].slice(0, 220), summary: '',
      link: hit.trackViewUrl, author: hit.artistName || '',
      posterUrl: (hit.artworkUrl512 || hit.artworkUrl100 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.') || null,
      posterFallback: hit.screenshotUrls?.[0] || null,
    };
  }
  return null;
}
/* Homebrew cask = the app's official homepage + description (covers direct-download Mac utilities). */
async function viaHomebrew(c) {
  const slug = titleKey(c.title);
  for (const tok of [slug, `${slug}-app`]) {
    const j = await getJSON(`https://formulae.brew.sh/api/cask/${tok}.json`);
    if (!j || !(j.name || []).some((n) => exactTitle(n, c.title))) continue;
    const host = (() => { try { return new URL(j.homepage).hostname; } catch { return ''; } })();
    return {
      typeOk: true, title: c.title, year: null, blurb: j.desc || '', summary: '', link: j.homepage, author: '',
      posterUrl: host ? `https://www.google.com/s2/favicons?domain=${host}&sz=256` : null, posterFallback: null,
    };
  }
  return null;
}
async function viaGitHub(c) {
  const tok = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const j = await getJSON(`https://api.github.com/search/repositories?${new URLSearchParams({ q: `${c.title} in:name`, sort: 'stars', per_page: '5' })}`, { Accept: 'application/vnd.github+json', ...tok });
  const hit = (j?.items || []).find((r) => exactTitle(r.name.replace(/[-_]/g, ' '), c.title) && r.stargazers_count >= 100);
  if (!hit) return null;
  return {
    typeOk: true, title: c.title, year: Number((hit.created_at || '').slice(0, 4)) || null,
    blurb: hit.description || '', summary: '', link: hit.homepage || hit.html_url, author: hit.owner?.login || '',
    posterUrl: `https://opengraph.githubassets.com/1/${hit.full_name}`, posterFallback: hit.owner?.avatar_url || null,
  };
}

/* Software names are generic ("Ice", "Flow"): confirm the store/repo hit is the thing the screenshot meant. */
const SAME_SCHEMA = { type: 'object', additionalProperties: false, required: ['same'], properties: { same: { type: 'boolean' } } };
async function sameSoftware(c, r) {
  if (!c.context) return true;
  try {
    const { out } = await openai(CLASSIFY_MODEL, [{ role: 'user', content:
      `A screenshot mentioned the software "${c.title}" in this context: ${c.context}\nCandidate match: "${r.title}" — ${r.blurb || '(no description)'} — ${r.link}\nIs the candidate very likely the same product? Answer false if it is a different product that merely shares the name.` }], SAME_SCHEMA, 10);
    return !!out.same;
  } catch { return false; }
}

/* The chain above predates the anime and repo types: it knows movie/show/book/game/software
   and an is_anime flag. v2 candidates carry taxonomy types, so translate on the way in. */
async function enrichLegacy(c) {
  let fallback = null;
  const chain = c.type === 'software' ? [viaHomebrew, viaAppStore, viaGitHub]
    : c.type === 'game' ? [viaSteam, viaWikipedia]
    : c.type === 'book' ? [viaOpenLibrary, viaWikipedia]
    : [viaTMDB, viaWikipedia];
  for (const fn of chain) {
    try { const r = await fn(c); if (r?.typeOk && c.type === 'software' && !(await sameSoftware(c, r))) continue; if (r?.typeOk) return { ...r, via: fn.name.replace('via', '') }; if (r && !fallback) fallback = { ...r, via: fn.name.replace('via', '') }; } catch { /* next */ }
  }
  return fallback;
}

async function enrich(c) {
  const chain = EXTRA_CHAINS[c.type];
  if (chain) {
    let fallback = null;
    for (const fn of chain) {
      try { const r = await fn(c); if (r?.typeOk) return { ...r, via: fn.name.replace('via', '') }; if (r && !fallback) fallback = { ...r, via: fn.name.replace('via', '') }; } catch { /* next */ }
    }
    /* a repo the model named but GitHub search could not pin down may still be an app */
    return fallback;
  }
  if (!LEGACY_TYPES.has(c.type) && c.type !== 'anime') return null;
  return enrichLegacy({ ...c, type: lookupType(c), is_anime: c.type === 'anime' || !!c.is_anime });
}

async function savePoster(urls, id) {
  for (const url of urls.filter(Boolean)) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const meta = await sharp(buf).metadata();
      if ((meta.width || 0) < 96 || (meta.height || 0) < 96) continue;   // favicon-sized or broken: not cover art
      const out = await sharp(buf).flatten({ background: '#ffffff' }).rotate().resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
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

/* --qa-posters: verify every movie/show poster is the right work (same-title collisions). */
if (flag('--qa-posters')) {
  const TOKEN = process.env.TMDB_READ_TOKEN;
  if (!TOKEN) { console.error('TMDB_READ_TOKEN missing'); process.exit(1); }
  const only = opt('--ids', '') ? new Set(opt('--ids', '').split(',')) : null;
  const prov = existsSync(PROVENANCE) ? JSON.parse(readFileSync(PROVENANCE, 'utf8')) : {};   // OCR text from the retired pipeline
  const targets = items.filter((it) => family(it.type) === 'screen' && !it.qa_lock && (!only || only.has(it.id)));   // qa_lock: hand-verified, skip
  let usd = 0; const res = { ok: 0, okUnverified: 0, nomatch: 0, fixed: [], ambiguous: [], typeFixed: [], idAdded: 0 };
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < targets.length) {
      const it = targets[next++];
      try {
        const pth = it.poster && join(ROOT, it.poster);
        const posterBytes = pth && existsSync(pth) ? await sharp(pth).resize({ width: 256, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer() : null;
        const q = await qaScreen(it, { openai, token: TOKEN, posterBytes, extra: { ocr: prov[it.id]?.ocr_excerpt || '' } });
        usd += q.cost;
        const fmt = (c) => c ? `${c.title} (${c.year || '?'}, ${c.kind}${c.lang && c.lang !== 'en' ? `, ${c.lang}` : ''})` : 'unknown';
        if (q.verdict === 'fix') {
          const poster = await savePoster([tmdbPosterUrl(q.pick)], it.id);
          if (!poster) { res.ambiguous.push(`${it.title}: poster download failed`); continue; }
          res.fixed.push(`${it.title}${it.year ? ` [${it.year}]` : ''}: ${fmt(q.current)} -> ${fmt(q.pick)}`);
          it.poster = poster; it.tmdb_id = q.pick.id;
          if (!it.year || Math.abs(it.year - (q.pick.year || it.year)) > 1) it.year = q.pick.year || it.year;
          if (q.pick.kind !== tmdbKind(it)) { res.typeFixed.push(`${it.title}: ${tmdbKind(it)} -> ${q.pick.kind}`); setScreenKind(it, q.pick.kind); }
          it.qa = 'fixed';
        } else if (q.verdict === 'ambiguous') {
          res.ambiguous.push(`${it.title}${it.year ? ` [${it.year}]` : ''}: ${q.cands.length} same-title works (poster shows ${fmt(q.current)}; best guess ${fmt(q.pick)})`);
          if (it.status === 'todo') it.status = 'inbox';
          it.qa = `ambiguous: ${q.cands.length} same-title works`;
        } else if (q.verdict === 'nomatch') res.nomatch++;
        else {
          q.verdict === 'ok' ? res.ok++ : res.okUnverified++;
          if (!it.tmdb_id && q.pick && q.verdict === 'ok') { it.tmdb_id = q.pick.id; res.idAdded++; }
        }
      } catch (e) { console.warn('qa error', it.title, String(e).slice(0, 120)); }
      if (++done % 100 === 0) console.error(`qa ${done}/${targets.length} $${usd.toFixed(3)}`);
    }
  }));
  for (const it of targets) delete it.qa_hint;
  ledger.totals.usd = Math.round((ledger.totals.usd + usd) * 1e6) / 1e6;
  if (!DRY) { writeFileSync(DATA, JSON.stringify(items, null, 2)); writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); }
  console.log(JSON.stringify({ checked: targets.length, ok: res.ok, okUnverified: res.okUnverified, nomatch: res.nomatch, fixed: res.fixed.length, ambiguous: res.ambiguous.length, typeFixed: res.typeFixed.length, tmdbIdsAdded: res.idAdded, usd: Math.round(usd * 1e4) / 1e4 }));
  console.log('FIXED:\n  ' + res.fixed.join('\n  '));
  console.log('TYPE FIXED:\n  ' + res.typeFixed.join('\n  '));
  console.log('AMBIGUOUS -> inbox:\n  ' + res.ambiguous.join('\n  '));
  process.exit(0);
}

/* --art-hunt: deeper cover-art search for Inbox items that still have no art (adult stays hidden). */
if (flag('--art-hunt')) {
  // every item still missing art, public or Inbox; adult ones get art but stay hidden in the Inbox
  const targets = items.filter((it) => !(it.poster && existsSync(join(ROOT, it.poster))));
  let usd = 0; const found = [], missed = [];
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < targets.length) {
      const it = targets[next++];
      const c = { title: it.title, type: lookupType(it), year: it.year, author: it.author, tags: it.tags, is_anime: it.type === 'anime', context: it.source_context || '' };
      const h = await huntArt(c, openai);
      usd += h.cost;
      const poster = h.found ? await savePoster([h.found.image, h.found.image2, h.found.image3], it.id) : '';
      if (poster && h.found.adult) {   // database flags it 18+: keep hidden in the Inbox
        Object.assign(it, { poster, adult: true, art_via: h.found.source });
        missed.push(`${it.title} [${it.type}] — art found but ${h.found.source} marks it adult, kept hidden`);
      } else if (poster) {
        Object.assign(it, { poster, status: it.adult ? 'inbox' : 'todo', art_via: h.found.source });
        if (!it.link) it.link = h.found.link;
        if (h.found.tmdb_id && !it.tmdb_id) it.tmdb_id = h.found.tmdb_id;
        if (!it.year && h.found.year) it.year = h.found.year;
        found.push(`${it.title} [${it.type}] <- ${h.found.source}: ${h.found.titles[0]}${h.found.year ? ` (${h.found.year})` : ''}`);
      } else missed.push(`${it.title} [${it.type}] — ${h.found ? 'image unusable' : h.reason} (${h.tried} candidates)`);
    }
  }));
  ledger.totals.usd = Math.round((ledger.totals.usd + usd) * 1e6) / 1e6;
  if (!DRY) { writeFileSync(DATA, JSON.stringify(items, null, 2)); writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); }
  console.log(JSON.stringify({ checked: targets.length, found: found.length, missed: missed.length, usd: Math.round(usd * 1e4) / 1e4 }));
  console.log('FOUND:\n  ' + found.join('\n  '));
  console.log('MISSED:\n  ' + missed.join('\n  '));
  process.exit(0);
}

/* --audit: re-check every screenshot-sourced item with the current rules (text-only, no images). */
if (flag('--audit')) {
  const AUDIT_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['verdicts'],
    properties: { verdicts: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'verdict', 'adult'],
      properties: {
        id: { type: 'string' },
        verdict: { type: 'string', enum: ['media', 'software', 'doubtful', 'not_media'] },
        adult: { type: 'boolean' },
      } } } },
  };
  const targets = items.filter((it) => it.source === 'screenshot');
  const verdicts = new Map();
  let auditUsd = 0;
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i, i + 20).map((it) => ({ id: it.id, title: it.title, type: it.type, tags: it.tags, context: it.source_context, matched_page: it.link, blurb: (it.blurb || '').slice(0, 160) }));
    const { out, cost } = await openai(PARSE_MODEL, [
      { role: 'system', content: 'You audit entries auto-extracted from phone screenshots into a movie/TV/anime/book/video-game watchlist. For each entry decide: "media" = a real movie, TV show, anime, book or video game that the context presents as something to watch/read/play, with the stated type plausible; "software" = an app, utility, AI tool or developer tool (Mac/iOS/web/open source) that was recommended or shown; "not_media" = player names/usernames, people, restaurants, physical products, brands, websites that are not apps, or anything else that is neither a creative work nor software; "doubtful" = might be media but the title, type or match looks wrong or unverifiable. Mark adult=true for pornographic/hentai/explicitly sexual works or ones promoted mainly for sexual content.' },
      { role: 'user', content: JSON.stringify(batch) },
    ], AUDIT_SCHEMA, 3000);
    auditUsd += cost;
    for (const v of out.verdicts) verdicts.set(v.id, v);
  }
  const counts = { removed: [], toInbox: [], adult: [], software: [], kept: 0 };
  for (const it of targets) {
    const v = verdicts.get(it.id) || { verdict: 'doubtful', adult: false };
    if (v.verdict === 'not_media') {
      ledger.dismissed.push(`${family(it.type)}:${titleKey(it.title)}`);
      if (it.poster && existsSync(join(ROOT, it.poster)) && !DRY) unlinkSync(join(ROOT, it.poster));
      items.splice(items.indexOf(it), 1);
      counts.removed.push(it.title);
      continue;
    }
    let reEnriched = false;
    if (it.type !== 'repo' && (v.verdict === 'software' || it.type === 'software')) {
      it.type = 'software'; delete it.format; reEnriched = true;
    }
    const cand = { title: it.title, type: lookupType(it), is_anime: it.type === 'anime', year: it.year, creator: it.author || null, context: it.source_context || '' };
    const e = await enrich(cand);
    if (reEnriched) {
      if (it.poster && existsSync(join(ROOT, it.poster)) && !DRY) unlinkSync(join(ROOT, it.poster));
      Object.assign(it, { year: e?.year || null, blurb: e?.blurb || '', summary: '', link: e?.link || '', enriched_via: e?.via || '', poster: '' });
      if (e?.author) it.author = e.author; else delete it.author;
      delete it.steam_appid;
      if (e) it.poster = await savePoster([e.posterUrl, e.posterFallback], it.id);
      counts.software.push(it.title);
    }
    const ok = !!e && e.typeOk && exactTitle(e.title, it.title);
    it.match_ok = ok;
    if (v.adult) { it.adult = true; counts.adult.push(it.title); }
    if (it.status === 'todo' && (v.adult || v.verdict === 'doubtful' || !ok)) { it.status = 'inbox'; counts.toInbox.push(it.title); }
    else if (reEnriched && it.status === 'inbox' && ok && !v.adult) { it.status = 'todo'; counts.kept++; }   // software with a real store/GitHub match
    else counts.kept++;
  }
  ledger.dismissed = [...new Set(ledger.dismissed)];
  ledger.totals.usd = Math.round((ledger.totals.usd + auditUsd) * 1e6) / 1e6;
  if (!DRY) { writeFileSync(DATA, JSON.stringify(items, null, 2)); writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); }
  console.log(JSON.stringify({ audited: targets.length, removed: counts.removed.length, movedToInbox: counts.toInbox.length, adult: counts.adult.length, software: counts.software.length, auditUsd: Math.round(auditUsd * 1e4) / 1e4 }));
  console.log('REMOVED:', counts.removed.join(' | '));
  console.log('TO INBOX:', counts.toInbox.join(' | '));
  console.log('ADULT:', counts.adult.join(' | '));
  console.log('SOFTWARE:', counts.software.map((t) => `${t}${items.find((x) => x.title === t)?.status === 'todo' ? ' ✓' : ' (inbox)'}`).join(' | '));
  process.exit(0);
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
/* Second dedupe pass after enrichment: the same work can arrive under another name
   (e.g. "Final Fantasy Tactics" -> Steam's "FINAL FANTASY TACTICS - The Ivalice Chronicles"),
   so also match on store/database identity and on the enriched title. */
const workKeys = (it) => {
  const k = [];
  const link = String(it.link || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  if (/store\.steampowered\.com\/app\/\d+|themoviedb\.org\/(movie|tv)\/\d+|openlibrary\.org\/works\/|apps\.apple\.com\/.*\/id\d+|anilist\.co\/|myanimelist\.net\//.test(link)) k.push(`link:${link.replace(/^https?:\/\/(www\.)?/, '')}`);
  if (it.tmdb_id) k.push(`tmdb:${tmdbKind(it)}:${it.tmdb_id}`);
  if (it.spotify_id) k.push(`spotify:${it.spotify_id}`);
  if (it.repo_url) k.push(`repo:${String(it.repo_url).toLowerCase().replace(/\/+$/, '')}`);
  if (it.steam_appid) k.push(`steam:${it.steam_appid}`);
  if (it.title) k.push(`${family(it.type)}:${titleKey(it.title)}`);
  return k;
};
const workIndex = new Map();
for (const it of items) for (const k of workKeys(it)) if (!workIndex.has(k)) workIndex.set(k, it.id);
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
    const tri = await triageShot(bytes);
    entry.usd += tri.cost;
    entry.kind = tri.kind; entry.note = clean(tri.note).slice(0, 140);   // why a skipped screenshot was skipped
    if (tri.worth_saving) {
      const p = await parseShot(bytes);
      entry.usd += p.cost;
      const shot = p.out;
      const named = (shot.items || []).filter((t) => t.is_thing);
      const found = named.filter((t) => KEPT_ROLES.has(t.role));
      for (const t of named) if (!KEPT_ROLES.has(t.role)) report.push({ name: s.name, title: clean(t.title), outcome: `skipped (${t.role})` });
      entry.outcome = found.length ? 'parsed' : 'no-titles';
      entry.kind = shot.kind; entry.note = clean(shot.description).slice(0, 140);
      for (const t of found) {
        const cand = { ...t, title: clean(t.title), type: canonicalType(t.type) };
        if (cand.title.length < 2 || (cand.confidence ?? 0) < 0.3) continue;   // model itself says "not a title"
        if (cand.type !== 'anime') cand.format = null;
        const famKey = `${family(cand.type)}:${titleKey(cand.title)}`;
        if (dismissed.has(famKey)) { report.push({ name: s.name, title: cand.title, outcome: 'previously-dismissed' }); continue; }
        const dup = findDuplicate(index, cand);
        if (dup) { report.push({ name: s.name, title: cand.title, outcome: `duplicate of ${dup}` }); entry.ids.push(dup); continue; }
        cand.context = [shot.source_context, cand.why].filter(Boolean).join(' — ');
        index.set(famKey, '(pending)');   // reserve before any await so parallel shots can't add the same title twice
        const e = await enrich(cand);
        const exact = !!e && e.typeOk && exactTitle(e.title, cand.title);
        const matched = !!e && e.typeOk;
        const title = e?.title && exact ? clean(e.title) : cand.title;
        const id = uniqueId(title, taken, e?.year || cand.year);
        taken.add(id);   // claim the id before the poster download await
        let poster = e ? await savePoster([e.posterUrl, e.posterFallback], id) : '';
        let art = null;
        if (!poster && (LEGACY_TYPES.has(cand.type) || cand.type === 'anime' || cand.type === 'manga')) {
          /* deeper hunt (adult titles too: the art is stored, but they stay hidden in the Inbox): AniList/MAL/alt titles, book & web-novel sites, itch, official sites */
          const h = await huntArt({ ...cand, type: cand.type === 'manga' ? 'book' : lookupType(cand), is_anime: cand.type === 'anime', tags: cand.genres }, openai);
          entry.usd += h.cost;
          if (h.found) { poster = await savePoster([h.found.image, h.found.image2, h.found.image3], id); if (poster) art = h.found; }
          if (art?.adult) cand.adult = true;   // AniList/MAL 18+ flag: keep hidden
        }
        const status = decideStatusV2(cand, { poster, matched });
        const tags = [...new Set([...((e?.genres?.length ? e.genres : cand.genres) || [])])].slice(0, 4);
        const { who, ctx } = privacyScrub(cand, [shot.source_context, cand.why].filter(Boolean).join(' — '));
        const extra = {};
        for (const k of EXTRA_FIELDS) if (e && e[k] !== undefined && e[k] !== '' && e[k] !== null && e[k] !== false) extra[k] = e[k];
        const item = normalizeItem({
          id, title, type: cand.type, year: e?.year || cand.year || null,
          blurb: e?.blurb || '', summary: e?.summary || '', poster, link: e?.link || pageUrl(cand) || fallbackLink(cand, shot.app),
          status, tags, rating: null, notes: '', added: today(),
          source: 'screenshot', source_context: ctx, recommended_by: who,
          ai_confidence: Math.round((cand.confidence || 0) * 100) / 100,
          enriched_via: e?.via || '', match_ok: exact, screenshot: s.sha.slice(0, 12),
          ...(cand.adult ? { adult: true } : {}),
          ...(cand.type === 'anime' ? { format: cand.format || e?.format || 'series' } : e?.format ? { format: e.format } : {}),
          ...(e?.author || cand.creator ? { author: e?.author || cand.creator } : {}),
          ...(e?.tmdb_id || art?.tmdb_id ? { tmdb_id: e?.tmdb_id || art.tmdb_id } : {}),
          ...(art ? { art_via: art.source, ...(e?.link ? {} : { link: art.link }) } : {}),
          ...(e?.steam_appid ? { steam_appid: e.steam_appid } : {}),
          /* what the screenshot itself said */
          ...(clean(cand.quote) ? { quote: clean(cand.quote).slice(0, 240) } : {}),
          ...(cand.availability ? { availability: clean(cand.availability).slice(0, 80) } : {}),
          ...(cand.price ? { price: clean(cand.price).slice(0, 40) } : {}),
          ...(e?.location || cand.location ? { location: clean(e?.location || cand.location).slice(0, 160) } : {}),
          ...(cand.season_episode ? { season_episode: clean(cand.season_episode).slice(0, 20) } : {}),
          ...(shot.intent && shot.intent !== 'unclear' ? { intent: shot.intent } : {}),
          ...extra,
        }).item;   // current data shape: one spelling per tag
        /* poster QA: same-title collisions (remake vs original, same-name films, movie vs series).
           The screenshot's year/context decides; unclear cases wait in the Inbox. */
        if (family(item.type) === 'screen' && process.env.TMDB_READ_TOKEN) {
          try {
            const q = await qaScreen(item, { openai, token: process.env.TMDB_READ_TOKEN, extra: { context: cand.context } });
            entry.usd += q.cost;
            if (q.cands.length > 1) item.same_title_works = q.cands.length;
            if (q.verdict === 'fix') {
              const p2 = await savePoster([tmdbPosterUrl(q.pick)], id);
              if (p2) {
                Object.assign(item, { poster: p2, tmdb_id: q.pick.id, qa: 'fixed' });
                setScreenKind(item, q.pick.kind);
                if (!item.year || Math.abs(item.year - (q.pick.year || item.year)) > 1) item.year = q.pick.year || item.year;
                if (!cand.adult) item.status = 'todo';
              }
            } else if (q.verdict === 'ambiguous') { item.status = 'inbox'; item.qa = `ambiguous: ${q.cands.length} same-title works`; }
            else if (q.verdict === 'ok' && q.pick && !item.tmdb_id) item.tmdb_id = q.pick.id;
          } catch (err) { console.warn('qa failed', title, String(err).slice(0, 100)); }
        }
        const dup2 = workKeys(item).map((k) => workIndex.get(k)).find((v) => v && v !== id);
        if (dup2) {
          if (item.poster && existsSync(join(ROOT, item.poster)) && !DRY) unlinkSync(join(ROOT, item.poster));
          index.set(famKey, dup2); entry.ids.push(dup2);
          report.push({ name: s.name, title, outcome: `duplicate of ${dup2} (same work after lookup)` });
          continue;
        }
        items.push(item); taken.add(id); index.set(famKey, id); changed = true;
        for (const k of workKeys(item)) if (!workIndex.has(k)) workIndex.set(k, id);
        entry.ids.push(id);
        ledger.totals[item.status === 'todo' ? 'added' : 'inbox']++;
        report.push({ name: s.name, title, type: item.type, year: item.year, outcome: item.status + (item.qa ? ` (qa ${item.qa})` : ''), conf: item.ai_confidence, via: item.enriched_via || 'none', poster: !!poster, context: ctx, item });
      }
      ledger.totals.media++;
      if (entry.ids.length) await keepShot(s.sha, p.image);
    } else {
      report.push({ name: s.name, outcome: 'not-media', kind: tri.kind, note: entry.note });
    }
  } catch (err) {
    console.warn('error on', s.name || s.sha.slice(0, 12), String(err).slice(0, 200));
    entry.outcome = 'error';
    report.push({ name: s.name, outcome: 'error', error: String(err).slice(0, 120) });
    ledger.errors = ledger.errors || {};
    ledger.errors[s.sha] = (ledger.errors[s.sha] || 0) + 1;
    changed = true;
    if (ledger.errors[s.sha] < 3) return;   // not ledgered, not acked -> retried next run
    entry.usd = 0; ledger.shots[s.sha] = entry; ledger.totals.shots++; pending.shots.push(s.sha);   // poison: give up after 3 tries
    return;
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
for (const r of report) console.log(' -', r.outcome.padEnd(18), r.title ? `${r.title} (${r.type || ''} ${r.year || ''}) conf=${r.conf ?? ''} via=${r.via ?? ''}` : `${r.name || ''}${r.kind ? `  [${r.kind}] ${r.note || ''}` : ''}`);
