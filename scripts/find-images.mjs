#!/usr/bin/env node
/* Last-resort image finder for items the normal lookups left without art.
 *
 *   node scripts/find-images.mjs [--dry-run] [--limit N] [--only <type>] [--ids a,b] [--candidates]
 *
 * Runs after the database lookups and the cover-art hunt in the ingest
 * (scripts/ingest/art.mjs) have already failed. Sources, by kind of item:
 *
 *   places with coordinates   a street map of the spot (OpenStreetMap tiles); no judgement needed
 *   games                     VNDB, the visual-novel database (covers what Steam does not carry)
 *   anything with a real link the page's own preview image (og:image)
 *   everything                web image search: Google Programmable Search when
 *                             GOOGLE_SEARCH_KEY + GOOGLE_SEARCH_CX are set, otherwise
 *                             DuckDuckGo (no key, best effort) and Wikimedia Commons
 *
 * Nothing from the web is trusted on its say-so: the vision model is shown the
 * candidates and picks the one that is this item's cover, logo or photo, or
 * none. --candidates lists what each source returned without judging or
 * saving (needs no OpenAI key).
 *
 * env: OPENAI_API_KEY (for the check), optional GOOGLE_SEARCH_KEY + GOOGLE_SEARCH_CX
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { category } from '../shared/taxonomy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const UA = { 'user-agent': 'Mozilla/5.0 (watchlist image lookup; github.com/Threesided-Studios/watchlist)' };

async function get(url, { headers = {}, as = 'json', method = 'GET', body } = {}) {
  try {
    const r = await fetch(url, { method, body, headers: { ...UA, ...headers }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return as === 'text' ? await r.text() : as === 'buffer' ? Buffer.from(await r.arrayBuffer()) : await r.json();
  } catch { return null; }
}

/* ---------- pure helpers ---------- */
/* What to type into an image search for this item. */
export function searchQuery(it) {
  const noun = { movie: 'movie poster', show: 'TV series poster', anime: 'anime key visual', manga: 'manga cover', book: 'book cover', game: 'game cover art',
    boardgame: 'board game box', software: 'app logo', repo: 'github logo', podcast: 'podcast cover', music: 'album cover', video: 'video thumbnail',
    place: 'exterior', recipe: 'dish', product: 'product photo', article: '' }[it.type] || '';
  return [it.title, it.author, it.type === 'place' ? it.location : '', it.year && ['movie', 'show', 'anime', 'game'].includes(it.type) ? it.year : '', noun].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
/* A link worth reading for a preview image: a real page, not one of our own search fallbacks. */
export function previewable(link) {
  return /^https?:\/\//.test(link || '') && !/duckduckgo\.com\/\?q=|google\.com\/maps\/search|youtube\.com\/results|open\.spotify\.com\/search|github\.com\/search/.test(link);
}
/* slippy-map tile containing a coordinate, plus where in that tile the point falls (0..1) */
export function tileFor(lat, lon, z) {
  const n = 2 ** z, x = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180, y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
}
export function ogImage(html, base) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (!m) return null;
  try { return new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch { return null; }
}

/* ---------- sources: each returns [{image, source, label}] ---------- */
async function vndb(it) {
  if (it.type !== 'game') return [];
  const j = await get('https://api.vndb.org/kana/vn', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: ['search', '=', it.title], fields: 'title, alttitle, released, image.url', results: 4 }) });
  return (j?.results || []).filter((v) => v.image?.url).map((v) => ({ image: v.image.url, source: 'VNDB', label: `${v.title}${v.released ? ` (${String(v.released).slice(0, 4)})` : ''}`, link: `https://vndb.org/${v.id}` }));
}
async function pagePreview(it) {
  if (!previewable(it.link)) return [];
  const html = await get(it.link, { as: 'text', headers: { accept: 'text/html' } });
  const img = html && ogImage(html, it.link);
  return img ? [{ image: img, source: 'page preview', label: new URL(it.link).hostname }] : [];
}
async function googleImages(it) {
  const key = process.env.GOOGLE_SEARCH_KEY, cx = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) return [];
  const j = await get(`https://www.googleapis.com/customsearch/v1?${new URLSearchParams({ key, cx, q: searchQuery(it), searchType: 'image', num: '6', safe: it.adult ? 'off' : 'active' })}`);
  return (j?.items || []).map((x) => ({ image: x.link, thumb: x.image?.thumbnailLink, source: 'Google Images', label: `${x.title} — ${x.displayLink}` }));
}
async function duckImages(it) {
  const q = searchQuery(it);
  const html = await get(`https://duckduckgo.com/?${new URLSearchParams({ q, iax: 'images', ia: 'images' })}`, { as: 'text' });
  const vqd = html && (html.match(/vqd=["']?([\d-]+)["']?/) || [])[1];
  if (!vqd) return [];
  const j = await get(`https://duckduckgo.com/i.js?${new URLSearchParams({ l: 'us-en', o: 'json', q, vqd, f: ',,,,,', p: it.adult ? '-1' : '1' })}`, { headers: { referer: 'https://duckduckgo.com/' } });
  return (j?.results || []).slice(0, 6).map((x) => ({ image: x.image, thumb: x.thumbnail, source: 'DuckDuckGo Images', label: `${x.title} — ${(() => { try { return new URL(x.url).hostname; } catch { return ''; } })()}` }));
}
async function commons(it) {
  const j = await get(`https://commons.wikimedia.org/w/api.php?${new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${it.title} ${it.author || ''}`.trim(), gsrnamespace: '6', gsrlimit: '4', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '600' })}`);
  return Object.values(j?.query?.pages || {}).filter((p) => /\.(jpe?g|png|webp)$/i.test(p.title || '')).map((p) => ({ image: p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url, source: 'Wikimedia Commons', label: String(p.title).replace(/^File:/, '') })).filter((c) => c.image);
}
export async function candidatesFor(it) {
  const out = [];
  for (const src of [vndb, pagePreview, googleImages]) out.push(...await src(it));
  if (out.length < 3) out.push(...await duckImages(it));
  if (out.length < 3) out.push(...await commons(it));
  const seen = new Set();
  return out.filter((c) => c.image && !seen.has(c.image) && seen.add(c.image)).slice(0, 6);
}

/* ---------- places: a map of the spot ---------- */
async function mapImage(it, sharp) {
  const z = 16, t = tileFor(it.lat, it.lon, z);
  /* 3x3 tiles around the point, then crop a 2:3 portrait centred on it */
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const buf = await get(`https://tile.openstreetmap.org/${z}/${t.x + dx}/${t.y + dy}.png`, { as: 'buffer', headers: { 'user-agent': 'watchlist/1.0 (+https://github.com/Threesided-Studios/watchlist)' } });
    if (!buf) return null;
    tiles.push({ input: buf, left: (dx + 1) * 256, top: (dy + 1) * 256 });
  }
  const px = Math.round(256 + t.fx * 256), py = Math.round(256 + t.fy * 256);
  const W = 400, H = 600, left = Math.max(0, Math.min(768 - W, px - W / 2)), top = Math.max(0, Math.min(768 - H, py - H / 2));
  const pin = Buffer.from(`<svg width="768" height="768" xmlns="http://www.w3.org/2000/svg"><circle cx="${px}" cy="${py}" r="26" fill="#ff006e" fill-opacity=".22"/><circle cx="${px}" cy="${py}" r="10" fill="#ff006e" stroke="#fff" stroke-width="3"/></svg>`);
  const base = await sharp({ create: { width: 768, height: 768, channels: 3, background: '#0d0a1e' } }).composite([...tiles, { input: pin, left: 0, top: 0 }]).png().toBuffer();
  /* night-mode tint so it sits with the rest of the site */
  return sharp(base).extract({ left: Math.round(left), top: Math.round(top), width: W, height: H }).negate({ alpha: false }).modulate({ hue: 180, saturation: 0.7, brightness: 0.95 }).jpeg({ quality: 82 }).toBuffer();
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const DRY = flag('--dry-run'), LIST = flag('--candidates');
  const LIMIT = Number(opt('--limit', 0)) || Infinity, ONLY = opt('--only', ''), IDS = opt('--ids', '') ? new Set(opt('--ids', '').split(',')) : null;
  const DATA = join(ROOT, 'data.json');
  const items = JSON.parse(readFileSync(DATA, 'utf8'));
  const missing = items.filter((it) => it.status !== 'dismissed' && !it.poster_url && !(it.poster && existsSync(join(ROOT, it.poster)))
    && (!ONLY || it.type === ONLY) && (!IDS || IDS.has(it.id))).slice(0, LIMIT);
  console.log(`${missing.length} item(s) without an image`);

  if (LIST) {
    for (const it of missing) {
      const c = it.type === 'place' && it.lat ? [{ source: 'map', label: `${it.lat},${it.lon}`, image: '(map tile)' }] : await candidatesFor(it);
      console.log(`\n${it.title} [${it.type}]  q="${searchQuery(it)}"`);
      for (const x of c) console.log(`   ${x.source}: ${String(x.label).slice(0, 70)}`);
      if (!c.length) console.log('   (nothing)');
    }
    process.exit(0);
  }

  /* sharp is installed for the ingest (scripts/ingest/node_modules) */
  const sharp = createRequire(join(HERE, 'ingest', 'package.json'))('sharp');
  const { completionBody } = await import('./ingest/openai-request.mjs');
  const { ART_VERIFY_MODEL } = await import('./ingest/models.mjs');
  const { costOf } = await import('./ingest/lib.mjs');
  const KEY = process.env.OPENAI_API_KEY || '';
  const PICK = { type: 'object', additionalProperties: false, required: ['index', 'reason'], properties: { index: { type: 'integer' }, reason: { type: 'string' } } };
  let usd = 0;

  async function choose(it, cands, thumbs) {
    const content = [{ type: 'text', text: `Item on a personal list: ${JSON.stringify({ title: it.title, type: category(it.type).singular, year: it.year || null, by: it.author || null, about: (it.blurb || it.source_context || '').slice(0, 200) })}\n`
      + `Candidates, in order: ${JSON.stringify(cands.map((c, i) => ({ i, from: c.source, caption: String(c.label).slice(0, 90) })))}\n`
      + 'Which image is the official cover, poster, key art, logo or a clear photo of THIS item? Answer its index, or -1. Answer -1 if you are not confident it is this exact item (a different work with a similar name, a fan edit, a meme, a generic stock image, a screenshot of unrelated text, or an image of something else all count as -1).' }];
    for (const b of thumbs) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}`, detail: 'low' } });
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(completionBody(ART_VERIFY_MODEL, [{ role: 'user', content }], PICK, 120)) });
    const j = await r.json();
    if (!r.ok) throw new Error(`openai ${r.status}`);
    usd += costOf(ART_VERIFY_MODEL, j.usage);
    return JSON.parse(j.choices[0].message.content);
  }
  const save = async (it, buf, via) => {
    const out = await sharp(buf).flatten({ background: '#ffffff' }).rotate().resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    if (!DRY) writeFileSync(join(ROOT, 'posters', `${it.id}.jpg`), out);
    it.poster = `posters/${it.id}.jpg`; it.art_via = via;
    /* "has art" is what keeps a title out of the inbox; an ambiguous match still waits for a look */
    if (it.status === 'inbox' && it.type !== 'article' && !String(it.qa || '').startsWith('ambiguous')) it.status = 'todo';
  };

  let found = 0;
  for (const it of missing) {
    try {
      if (it.type === 'place' && it.lat && it.lon) {
        const m = await mapImage(it, sharp);
        if (m) { await save(it, m, 'map'); found++; console.log(` + ${it.title} <- map`); continue; }
      }
      if (!KEY) { console.log(` - ${it.title} (no OPENAI_API_KEY to check candidates)`); continue; }
      const cands = await candidatesFor(it);
      const usable = [], thumbs = [], raws = [];
      for (const c of cands) {
        const raw = await get(c.thumb || c.image, { as: 'buffer' }) || (c.thumb ? await get(c.image, { as: 'buffer' }) : null);
        if (!raw) continue;
        try {
          const meta = await sharp(raw).metadata();
          if ((meta.width || 0) < 120 || (meta.height || 0) < 120) continue;
          thumbs.push(await sharp(raw).rotate().resize({ width: 256, height: 256, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()); usable.push(c); raws.push(raw);
        } catch { /* not an image */ }
      }
      if (!usable.length) { console.log(` - ${it.title} [${it.type}] (no candidates)`); continue; }
      const pick = await choose(it, usable, thumbs);
      const hit = pick.index >= 0 && pick.index < usable.length ? usable[pick.index] : null;
      if (!hit) { console.log(` - ${it.title} [${it.type}] (${usable.length} candidates, none accepted: ${String(pick.reason).slice(0, 70)})`); continue; }
      /* some hosts refuse the full-size download; the thumbnail the model approved is good enough then */
      const full = await get(hit.image, { as: 'buffer' }) || raws[pick.index];
      if (!full) { console.log(` - ${it.title} (download failed)`); continue; }
      await save(it, full, hit.source); found++;
      if (hit.link && !it.link) it.link = hit.link;
      console.log(` + ${it.title} [${it.type}] <- ${hit.source}: ${String(hit.label).slice(0, 60)}`);
    } catch (e) { console.log(` ! ${it.title}: ${String(e.message || e).slice(0, 80)}`); }
  }
  console.log(JSON.stringify({ checked: missing.length, found, usd: Math.round(usd * 1e4) / 1e4 }));
  if (found && !DRY) writeFileSync(DATA, JSON.stringify(items, null, 2));
}
