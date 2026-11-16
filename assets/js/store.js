/* Data store: canonical items from /data.min.json with the owner's local edits
 * laid on top.
 *
 * Local edits are kept as small per-item patches (not a copy of the whole
 * list, which used to put ~2.5 MB in localStorage). A patch is dropped as
 * soon as the canonical data agrees with it.
 */
import { canonicalType, normalizeTags } from '../../shared/taxonomy.js';
import { isVotingEnabled, fetchTallies } from '../votes.js';

const LS_PATCHES = 'watchlist.patches.v1';
const LS_ADDED = 'watchlist.added.v1';
const LS_OUTBOX = 'watchlist.outbox.v1';
const LS_SEEDED = 'watchlist.outbox.seeded';
const LS_LEGACY = 'watchlist.v9';
const LS_OWNER = 'watchlist.owner';
const LS_PASS = 'watchlist.ownerPass';
/* On localhost the Worker can be pointed at `wrangler dev` with localStorage['watchlist.ingestUrl']. */
export const INGEST_URL = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('watchlist.ingestUrl')) || 'https://watchlist-ingest.threesided.workers.dev';
/* sha256 of the owner passphrase. A deterrent only: the Worker re-checks it for anything that writes. */
const OWNER_HASH = '73ed39e720cb63bd270d9610e8617f8f2fef3ef1ab5deb62832feb9b7ce929b5';

/* Keep in step with SET_FIELDS in scripts/ingest/apply-edits.mjs. */
export const EDITABLE = ['title', 'blurb', 'notes', 'status', 'verdict', 'type', 'tags', 'pinned', 'year', 'link', 'author', 'format'];

const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const state = {
  items: [],
  byId: new Map(),
  tallies: {},
  owner: localStorage.getItem(LS_OWNER) === '1',
  loaded: false,
  offline: false,
};
let canonical = new Map();
let patches = readJSON(LS_PATCHES, {});
let added = readJSON(LS_ADDED, []);
let outbox = readJSON(LS_OUTBOX, []);   // edits not yet accepted by the Worker
const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => { for (const fn of listeners) fn(what); };

function prepare(it) {
  it.type = canonicalType(it.type);
  it.tags = Array.isArray(it.tags) ? it.tags : [];
  it.status = it.status || 'todo';
  return it;
}

/* One-time move from the old "whole list in localStorage" format: keep only what differed. */
function migrateLegacy() {
  const old = readJSON(LS_LEGACY, null);
  if (!Array.isArray(old)) return;
  for (const p of old) {
    if (!p || !p.id) continue;
    const c = canonical.get(p.id);
    if (!c) { if (String(p.id).startsWith('m-')) added.push(p); continue; }
    const patch = {};
    for (const f of ['verdict', 'status', 'title', 'blurb']) {
      if (f === 'status' && (p.status === 'inbox' || c.status === 'inbox')) continue;
      if ((f === 'title' || f === 'blurb') && !String(p[f] || '').trim()) continue;
      if (!same(p[f], c[f])) patch[f] = p[f] ?? null;
    }
    if (Object.keys(patch).length) patches[p.id] = { ...patch, ...(patches[p.id] || {}) };
  }
  writeJSON(LS_PATCHES, patches); writeJSON(LS_ADDED, added);
  localStorage.removeItem(LS_LEGACY);
}

function rebuild() {
  /* drop patch fields the canonical data has caught up with */
  for (const [id, patch] of Object.entries(patches)) {
    const c = canonical.get(id);
    if (!c) continue;
    for (const f of Object.keys(patch)) if (same(patch[f], c[f])) delete patch[f];
    if (!Object.keys(patch).length) delete patches[id];
  }
  added = added.filter((a) => !canonical.has(a.id));
  /* an item removed here and now gone from the committed data needs no patch any more */
  if (canonical.size) for (const id of Object.keys(patches)) if (!canonical.has(id) && !added.some((a) => a.id === id)) delete patches[id];
  const items = [];
  for (const c of canonical.values()) items.push(prepare({ ...c, ...(patches[c.id] || {}) }));
  for (const a of added) items.unshift(prepare({ ...a, ...(patches[a.id] || {}), local: true }));
  state.items = items;
  state.byId = new Map(items.map((it) => [it.id, it]));
}

export async function load() {
  let rows = [];
  try {
    const r = await fetch('/data.min.json', { cache: 'no-store' });
    if (r.ok) rows = await r.json();
  } catch { /* offline: the service worker answers when it has a copy */ }
  state.offline = !rows.length;
  canonical = new Map(rows.map((it) => [it.id, it]));
  migrateLegacy();
  rebuild();
  writeJSON(LS_PATCHES, patches); writeJSON(LS_ADDED, added);
  /* edits made before syncing existed: send them once */
  if (!localStorage.getItem(LS_SEEDED)) {
    for (const [id, fields] of Object.entries(patches)) if (canonical.has(id)) enqueue({ id, op: 'set', fields });
    for (const a of added) enqueue({ id: a.id, op: 'add', fields: { ...a, ...(patches[a.id] || {}) } });
    localStorage.setItem(LS_SEEDED, '1');
  }
  state.loaded = true;
  emit('load');
  flush();
  if (isVotingEnabled()) fetchTallies().then((t) => { state.tallies = t || {}; emit('tallies'); });
}

/* ---------- sync ----------
   Every edit goes into an outbox and is posted to the ingest Worker, which
   queues it for the next ingest run to commit into data.json. Until the
   committed data catches up, the local patch keeps showing the edit here. */
export const sync = { state: 'idle', error: '' };   // idle | sending | waiting | error
let flushTimer;
function enqueue(edit) {
  outbox.push(edit);
  writeJSON(LS_OUTBOX, outbox);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 1500);
}
export async function flush() {
  if (!outbox.length || sync.state === 'sending') return;
  const pass = ownerPass();
  if (!pass) { sync.state = 'error'; sync.error = 'Unlock owner mode to sync edits.'; emit('sync'); return; }
  const batch = outbox.slice(0, 200);
  sync.state = 'sending'; emit('sync');
  try {
    const r = await fetch(`${INGEST_URL}/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Owner-Pass': pass }, body: JSON.stringify({ edits: batch }) });
    if (!r.ok) throw new Error(r.status === 403 ? 'Passphrase not accepted. Lock and unlock again.' : r.status === 404 ? 'Sync service not updated yet. Edits are kept on this device.' : `Sync failed (${r.status}).`);
    outbox = outbox.slice(batch.length);
    writeJSON(LS_OUTBOX, outbox);
    sync.state = 'idle'; sync.error = '';
    if (outbox.length) flushTimer = setTimeout(flush, 200);
  } catch (e) {
    sync.state = 'error'; sync.error = e.message.includes('fetch') ? 'Offline. Edits will sync when you are back online.' : e.message;
  }
  emit('sync');
}
addEventListener('online', flush);
export const unsent = () => outbox.length;

/* ---------- edits ---------- */
/* opts.sync === false: the caller reports this change to the Worker itself (inbox Keep / Dismiss). */
export function update(id, fields, opts = {}) {
  const it = state.byId.get(id);
  if (!it) return;
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!EDITABLE.includes(k)) continue;
    clean[k] = k === 'tags' ? normalizeTags(v) : k === 'type' ? canonicalType(v) : v;
  }
  patches[id] = { ...(patches[id] || {}), ...clean };
  Object.assign(it, clean);
  writeJSON(LS_PATCHES, patches);
  if (opts.sync !== false && Object.keys(clean).length) enqueue({ id, op: 'set', fields: clean });
  emit('edit');
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function addItem(fields) {
  /* a readable id, unique against everything known here; the ingest job keeps it */
  let id = slug(fields.title) || 'item';
  if (state.byId.has(id) && fields.year) id = `${id}-${fields.year}`;
  for (let n = 2; state.byId.has(id); n++) id = `${slug(fields.title) || 'item'}-${n}`;
  const item = { id, status: 'todo', tags: [], added: new Date().toISOString().slice(0, 10), source: 'manual', ...fields, type: canonicalType(fields.type) };
  added.unshift(item);
  writeJSON(LS_ADDED, added);
  enqueue({ id, op: 'add', fields: item });
  rebuild();
  emit('edit');
  return item;
}

/* Take an item off the list for good (the ingest job also stops re-adding it). */
export function removeItem(id) {
  const it = state.byId.get(id);
  if (!it) return;
  added = added.filter((a) => a.id !== id);
  patches[id] = { ...(patches[id] || {}), status: 'dismissed' };
  writeJSON(LS_ADDED, added); writeJSON(LS_PATCHES, patches);
  enqueue({ id, op: 'delete' });
  rebuild();
  emit('edit');
}

export const pendingEdits = () => Object.keys(patches).length + added.length;

/* Full list with local edits applied, in data.json's shape, for the Export backup. */
export function exportItems() {
  return state.items.map(({ local, ...it }) => it);
}
export function importItems(rows) {
  if (!Array.isArray(rows)) throw new Error('not a list');
  canonical = new Map(rows.filter((r) => r && r.id).map((it) => [it.id, it]));
  patches = {}; added = [];
  writeJSON(LS_PATCHES, patches); writeJSON(LS_ADDED, added);
  rebuild(); emit('load');
}

/* ---------- owner ---------- */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function unlock(phrase) {
  if (await sha256(phrase) !== OWNER_HASH) return false;
  state.owner = true;
  localStorage.setItem(LS_OWNER, '1'); localStorage.setItem(LS_PASS, phrase);
  emit('owner');
  return true;
}
export function lock() {
  state.owner = false;
  localStorage.removeItem(LS_OWNER); localStorage.removeItem(LS_PASS);
  emit('owner');
}
export const ownerPass = () => localStorage.getItem(LS_PASS) || '';

/* ---------- views of the data ---------- */
const HIDDEN = new Set(['inbox', 'dismissed']);
/* What a visitor may see: nothing awaiting review, nothing adult unless owner. */
export const visible = (it) => !HIDDEN.has(it.status) && (state.owner || !it.adult);
export const visibleItems = () => state.items.filter(visible);
export const inboxItems = () => state.items.filter((it) => it.status === 'inbox' && (state.owner || !it.adult));

/* Where an item sits in its life: one of backlog | active | finished | skipped. */
export function stage(it) {
  if (it.verdict === 'skip') return 'skipped';
  if (it.verdict || it.status === 'done') return 'finished';
  if (it.status === 'active') return 'active';
  return 'backlog';
}
export const netVotes = (it) => state.tallies[it.id]?.net || 0;
