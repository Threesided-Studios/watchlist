#!/usr/bin/env node
/* One-off: give movies/shows a TMDB poster where the current one is missing,
 * small (< 300 px wide) or landscape (usually a still, not a poster).
 * Only replaces on an exact title match whose year agrees (±1); if the item has
 * no year, only when exactly one exact-title match exists. Records tmdb_id.
 *   TMDB_READ_TOKEN=… node tmdb-posters.mjs [--dry-run] [--all]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { titleKey } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');
const TOKEN = process.env.TMDB_READ_TOKEN;
if (!TOKEN) { console.error('TMDB_READ_TOKEN missing'); process.exit(1); }

const items = JSON.parse(readFileSync(join(ROOT, 'data.json'), 'utf8'));
const norm = (t) => titleKey(String(t || '').replace(/[®™©]/g, '').replace(/\s*\((19|20)\d{2}\)\s*$/, ''));

async function search(kind, title) {
  const r = await fetch(`https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(title)}&include_adult=false`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.ok ? (await r.json()).results || [] : [];
}

async function needs(it) {
  if (ALL) return 'all';
  const p = join(ROOT, it.poster || '');
  if (!it.poster || !existsSync(p)) return 'missing';
  try {
    const m = await sharp(p).metadata();
    if (m.width < 300) return 'small';
    if (m.width > m.height * 0.9) return 'landscape';
  } catch { return 'broken'; }
  return null;
}

const out = { checked: 0, replaced: 0, noMatch: 0, ambiguous: 0, reasons: {} , samples: [] };
const targets = items.filter((it) => (it.type === 'movie' || it.type === 'show') && it.status !== 'dismissed');
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < targets.length) {
    const it = targets[next++];
    try {
    const why = await needs(it);
    if (!why) continue;
    out.checked++;
    const kind = it.type === 'show' ? 'tv' : 'movie';
    const title = String(it.title).replace(/\s*\((19|20)\d{2}\)\s*$/, '');
    const yearInTitle = Number((String(it.title).match(/\(((19|20)\d{2})\)\s*$/) || [])[1]) || null;
    const year = it.year || yearInTitle;
    const hits = (await search(kind, title)).filter((h) => norm(h.title || h.name) === norm(title) || norm(h.original_title || h.original_name) === norm(title));
    let hit = null;
    if (year) hit = hits.find((h) => Math.abs(Number((h.release_date || h.first_air_date || '').slice(0, 4)) - year) <= 1);
    else if (hits.length === 1) hit = hits[0];
    else if (hits.length > 1) { out.ambiguous++; continue; }
    if (!hit || !hit.poster_path) { out.noMatch++; continue; }
    const r = await fetch(`https://image.tmdb.org/t/p/w500${hit.poster_path}`);
    if (!r.ok) { out.noMatch++; continue; }
    const buf = await sharp(Buffer.from(await r.arrayBuffer())).resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const rel = `posters/${it.id}.jpg`;
    if (!DRY) writeFileSync(join(ROOT, rel), buf);
    it.poster = rel;
    it.tmdb_id = hit.id;
    if (!it.year) it.year = Number((hit.release_date || hit.first_air_date || '').slice(0, 4)) || null;
    out.replaced++;
    out.reasons[why] = (out.reasons[why] || 0) + 1;
    if (out.samples.length < 12) out.samples.push(`${it.title} (${why})`);
    } catch (e) { out.errors = (out.errors || 0) + 1; console.error(it.title, e.message); }
  }
}));
if (!DRY) writeFileSync(join(ROOT, 'data.json'), JSON.stringify(items, null, 2));
console.log(JSON.stringify(out, null, 1));
