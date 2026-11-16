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
const LS_LEGACY = 'watchlist.v9';
const LS_OWNER = 'watchlist.owner';
const LS_PASS = 'watchlist.ownerPass';
export const INGEST_URL = 'https://watchlist-ingest.threesided.workers.dev';
/* sha256 of the owner passphrase. A deterrent only: the Worker re-checks it for anything that writes. */
const OWNER_HASH = '73ed39e720cb63bd270d9610e8617f8f2fef3ef1ab5deb62832feb9b7ce929b5';

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
  state.loaded = true;
  emit('load');
  if (isVotingEnabled()) fetchTallies().then((t) => { state.tallies = t || {}; emit('tallies'); });
}

/* ---------- edits ---------- */
export function update(id, fields) {
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
  emit('edit');
}

export function addItem(fields) {
  const item = {
    id: 'm-' + Date.now().toString(36), status: 'todo', tags: [], added: new Date().toISOString().slice(0, 10), source: 'manual',
    ...fields, type: canonicalType(fields.type),
  };
  added.unshift(item);
  writeJSON(LS_ADDED, added);
  rebuild();
  emit('edit');
  return item;
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
