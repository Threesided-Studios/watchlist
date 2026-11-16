#!/usr/bin/env node
/* Applies the owner's edits (queued by the site at the Worker's /edit) to data.json.
 *
 *   node apply-edits.mjs            fetch pending edits, apply, write data.json
 *   node apply-edits.mjs --dry-run  report only
 *
 * Runs in the ingest workflow before the screenshot parse. The edits are acked
 * (by `run.mjs --ack`) only after the commit is pushed, so a failed run retries them.
 *
 * env: WATCHLIST_QUEUE_URL, WATCHLIST_QUEUE_KEY
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleKey, family, uniqueId } from './lib.mjs';
import { canonicalType, normalizeTags } from '../../shared/taxonomy.js';

/* Fields an edit may set on an existing item, and the extra ones a new item may arrive with. */
export const SET_FIELDS = ['title', 'blurb', 'notes', 'status', 'verdict', 'type', 'tags', 'pinned', 'year', 'link', 'author', 'format'];
const ADD_FIELDS = [...SET_FIELDS, 'summary', 'added', 'source', 'tmdb_id', 'steam_appid'];
const STATUSES = new Set(['todo', 'active', 'done', 'inbox']);
const VERDICTS = new Set(['love', 'up', 'down', 'played', 'skip']);

function cleanField(k, v) {
  if (k === 'type') return canonicalType(v);
  if (k === 'tags') return normalizeTags(v).slice(0, 12);
  if (k === 'status') return STATUSES.has(v) ? v : undefined;
  if (k === 'verdict') return v === null || v === '' ? null : VERDICTS.has(v) ? v : undefined;
  if (k === 'pinned') return !!v;
  if (k === 'year' || k === 'tmdb_id' || k === 'steam_appid') return v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : undefined;
  if (k === 'link') return v === '' || /^https?:\/\//i.test(String(v)) ? String(v).slice(0, 500) : undefined;
  return typeof v === 'string' ? v.slice(0, k === 'notes' || k === 'summary' ? 4000 : 500) : undefined;
}

/* Pure: returns the edited list plus what happened. Edits apply in order; later ones win. */
export function applyEdits(items, edits, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = items.map((it) => ({ ...it }));
  const byId = new Map(out.map((it) => [it.id, it]));
  const taken = new Set(byId.keys());
  const log = [];
  const dismissed = [];     // family:title keys the screenshot ingest must not re-add
  const posters = [];       // [{id, url}] cover art to download for new items
  const removed = [];       // items deleted (the caller removes their poster files)

  for (const e of edits) {
    const it = byId.get(e.id);
    if (e.op === 'set') {
      if (!it) { log.push(`skip set ${e.id}: no such item`); continue; }
      const changed = [];
      for (const k of SET_FIELDS) {
        if (!(k in (e.fields || {}))) continue;
        const v = cleanField(k, e.fields[k]);
        if (v === undefined || JSON.stringify(v) === JSON.stringify(it[k] ?? null)) continue;
        if (k === 'title' && !String(v).trim()) continue;
        if (k === 'pinned' && !v) delete it.pinned; else it[k] = v;
        changed.push(k);
      }
      if (changed.length) { it.updated = today; log.push(`set ${e.id}: ${changed.join(', ')}`); }
    } else if (e.op === 'add') {
      const f = e.fields || {};
      const title = String(f.title || '').trim().slice(0, 300);
      if (!title) { log.push(`skip add ${e.id}: no title`); continue; }
      if (it) { log.push(`skip add ${e.id}: already on the list`); continue; }
      const id = taken.has(e.id) ? uniqueId(title, taken, f.year) : e.id;
      const item = { id, title, type: 'other', year: null, blurb: '', summary: '', poster: '', link: '', status: 'todo', tags: [], rating: null, notes: '', added: today, source: 'manual' };
      for (const k of ADD_FIELDS) {
        if (k === 'title' || !(k in f)) continue;
        const v = cleanField(k, f[k]);
        if (v !== undefined && v !== null) item[k] = v;
      }
      if (typeof f.poster_url === 'string' && /^https:\/\//.test(f.poster_url)) posters.push({ id, url: f.poster_url });
      out.push(item); byId.set(id, item); taken.add(id);
      log.push(`add ${id}: ${title} [${item.type}]`);
    } else if (e.op === 'delete') {
      if (!it) { log.push(`skip delete ${e.id}: no such item`); continue; }
      out.splice(out.indexOf(it), 1); byId.delete(e.id);
      dismissed.push(`${family(it.type)}:${titleKey(it.title)}`);
      removed.push(it);
      log.push(`delete ${e.id}: ${it.title}`);
    }
  }
  return { items: out, log, dismissed, posters, removed, changed: log.some((l) => !l.startsWith('skip')) };
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = resolve(HERE, '../..');
  const DATA = join(ROOT, 'data.json');
  const LEDGER = join(HERE, 'ledger.json');
  const PENDING = join(HERE, '.pending-edits.json');
  const DRY = process.argv.includes('--dry-run');
  const QURL = (process.env.WATCHLIST_QUEUE_URL || 'https://watchlist-ingest.threesided.workers.dev').replace(/\/$/, '');
  const QKEY = process.env.WATCHLIST_QUEUE_KEY || '';
  if (!QKEY) { console.error('WATCHLIST_QUEUE_KEY missing'); process.exit(1); }

  const r = await fetch(`${QURL}/edits`, { headers: { 'X-Queue-Key': QKEY } });
  /* a Worker that predates /edits answers 404: nothing to do, not an error */
  const edits = r.ok ? await r.json() : [];
  if (!r.ok && r.status !== 404) { console.error('edits fetch failed', r.status); process.exit(1); }
  if (!edits.length) { console.log('no edits'); process.exit(0); }

  const res = applyEdits(JSON.parse(readFileSync(DATA, 'utf8')), edits);
  for (const l of res.log) console.log(' -', l);
  if (DRY) process.exit(0);

  if (res.posters.length) {
    const { default: sharp } = await import('sharp');
    for (const p of res.posters) {
      try {
        const img = await fetch(p.url, { signal: AbortSignal.timeout(15000) });
        if (!img.ok) continue;
        const buf = await sharp(Buffer.from(await img.arrayBuffer())).flatten({ background: '#ffffff' }).rotate().resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        writeFileSync(join(ROOT, 'posters', `${p.id}.jpg`), buf);
        const it = res.items.find((x) => x.id === p.id);
        if (it) it.poster = `posters/${p.id}.jpg`;
      } catch (e) { console.warn('poster failed', p.id, String(e).slice(0, 100)); }
    }
  }
  for (const it of res.removed) {
    const f = it.poster && join(ROOT, it.poster);
    if (f && existsSync(f) && (it.source === 'screenshot' || it.source === 'manual')) unlinkSync(f);
  }
  if (res.dismissed.length && existsSync(LEDGER)) {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
    ledger.dismissed = [...new Set([...(ledger.dismissed || []), ...res.dismissed])];
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
  }
  if (res.changed) writeFileSync(DATA, JSON.stringify(res.items, null, 2));
  writeFileSync(PENDING, JSON.stringify({ upto: Math.max(...edits.map((e) => e.seq)) }));
  console.log(`applied ${edits.length} edit(s)`);
}
