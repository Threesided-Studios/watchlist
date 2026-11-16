#!/usr/bin/env node
/* Builds the deployable site from the repo.
 *
 *   node scripts/build-site.mjs [--out _site] [--no-posters]
 *
 *   - one HTML page per view, all from templates/page.html (home, every
 *     category in shared/taxonomy.js, /recommended/, /inbox/)
 *   - data.min.json: data.json in the current shape, minified, empty fields dropped
 *   - assets/ and shared/ with a content hash stamped on every script and
 *     stylesheet URL, and into sw.js, so a deploy never serves stale code
 *   - version.json: the commit that is live (the ingest job reads it)
 *
 * The generators are exported for scripts/dev-server.mjs, which serves the
 * same output straight from the working tree.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, canonicalType } from '../shared/taxonomy.js';
import { normalizeItems } from '../shared/normalize.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const HIDDEN = new Set(['inbox', 'dismissed']);

/* ---------- data ---------- */
export function loadItems() {
  return normalizeItems(JSON.parse(read('data.json'))).items;
}

/* Drop what the client treats as absent anyway; a summary that only repeats the blurb is noise. */
export function slimItem(it) {
  const out = {};
  for (const [k, v] of Object.entries(it)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (k === 'summary' && v === it.blurb) continue;
    out[k] = v;
  }
  return out;
}
export const buildData = (items = loadItems()) => JSON.stringify(items.map(slimItem));

/* Subscribable calendar (/upcoming.ics) of next episodes and releases for what is on the list. */
export function buildCalendar(items, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const day = (d) => d.replace(/-/g, '');
  const next = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  const text = (s) => String(s || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//threesided//Watchlist//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Watchlist: coming up'];
  for (const it of items) {
    if (!it.next_air || it.next_air < today || HIDDEN.has(it.status) || it.adult || it.verdict === 'skip') continue;
    lines.push('BEGIN:VEVENT', `UID:${it.id}-${it.next_air}@watch.threesided.com`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(it.next_air)}`, `DTEND;VALUE=DATE:${day(next(it.next_air))}`,
      `SUMMARY:${text(it.title)}${it.type === 'movie' ? ' (release)' : ' (new episode)'}`,
      `DESCRIPTION:${text([(it.providers || []).join(', '), it.blurb].filter(Boolean).join(' — '))}`,
      `URL:https://watch.threesided.com/all/#item=${encodeURIComponent(it.id)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* ---------- pages ---------- */
export function listPages(items = loadItems()) {
  const counts = {};
  for (const it of items) {
    if (HIDDEN.has(it.status) || it.adult) continue;
    const t = canonicalType(it.type);
    counts[t] = (counts[t] || 0) + 1;
  }
  const pages = [{ path: '', view: 'home', title: 'Watchlist — threesided', subtitle: 'a threesided list',
    description: 'A personal watchlist. Movies, shows, games, books and more, kept in one place.' },
  { path: 'all/', view: 'all', title: 'Watchlist — Everything', subtitle: 'everything', description: 'Every item on the list, searchable and filterable.' }];
  for (const c of CATEGORIES) {
    pages.push({ path: `${c.slug}/`, view: 'type', type: c.key, title: `Watchlist — ${c.label}`, subtitle: c.label,
      description: `A personal list: ${c.label.toLowerCase()}.`, count: counts[c.key] || 0, label: c.label });
  }
  pages.push({ path: 'recommended/', view: 'recommended', title: 'Watchlist — Recommended by Friends', subtitle: 'recommended by friends',
    description: 'What friends recommend from the list.' });
  pages.push({ path: 'how-it-works/', view: 'how', title: 'Watchlist — How it works', subtitle: 'how it works',
    description: 'How a screenshot becomes an entry on the list, and what you can do here.' });
  pages.push({ path: 'pipeline/', view: 'pipeline', title: 'Watchlist — Under the hood', subtitle: 'under the hood',
    description: 'The phone shortcut, queue, vision model and static site behind the Watchlist.', facts: pipelineFacts() });
  pages.push({ path: 'stats/', view: 'stats', title: 'Watchlist — Stats', subtitle: 'stats', description: 'The list in numbers.' });
  pages.push({ path: 'year/', view: 'year', title: 'Watchlist — Year in review', subtitle: 'year in review', description: 'What was added and finished, year by year.' });
  pages.push({ path: 'map/', view: 'map', title: 'Watchlist — Map', subtitle: 'map', description: 'Saved places on a map.', count: items.filter((it) => it.type === 'place' && !HIDDEN.has(it.status)).length });
  pages.push({ path: 'inbox/', view: 'inbox', title: 'Watchlist — Screenshot inbox', subtitle: 'screenshot inbox',
    description: 'Screenshot finds awaiting review.', noindex: true });
  return pages;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* The last screenshots the pipeline read and what became of each, for the inbox log.
   Only the outcome and the kind of screenshot: never a description of it. */
export function recentShots(limit = 40) {
  try {
    const shots = JSON.parse(read('scripts/ingest/ledger.json')).shots || {};
    return Object.entries(shots).map(([sha, s]) => ({ at: s.at, outcome: s.outcome, kind: s.kind || '', ids: s.ids || [], shot: sha.slice(0, 12) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  } catch { return []; }
}

/* Totals from the ingest ledger, shown on /pipeline/. */
function pipelineFacts() {
  try {
    const t = JSON.parse(read('scripts/ingest/ledger.json')).totals || {};
    return { shots: t.shots || 0, media: t.media || 0 };   // counts only: no cost figures go to the public site
  } catch { return {}; }
}

const navLink = (current) => (href, label, cls = '') =>
  `        <a href="${href}"${cls ? ` class="${cls}"` : ''}${href === `/${current.path}` ? ' aria-current="page"' : ''}>${label}</a>`;

/* Primary nav: the pages. Categories live in their own collapsible strip (catNavHtml). */
function navHtml(pages, current) {
  const link = navLink(current);
  const onCategory = current.view === 'type';
  return [
    link('/', 'Home'), link('/all/', 'Browse'),
    `        <button type="button" id="cat-toggle" class="nav-toggle" aria-expanded="${onCategory}" aria-controls="catnav"${onCategory ? ' data-current' : ''}>Categories <span aria-hidden="true">▾</span></button>`,
    link('/recommended/', '★ Friends'), link('/how-it-works/', 'How it works'), link('/pipeline/', 'Under the hood'), link('/stats/', 'Stats'), link('/year/', 'Year'),
    ...(pages.some((p) => p.view === 'map' && p.count > 0) ? [link('/map/', '📍 Map')] : []),
    link('/inbox/', '📥 Inbox', 'owner-only'),
  ].join('\n');
}

/* Only categories that have something in them, so new ones appear as they fill up. */
function catNavHtml(pages, current) {
  const link = navLink(current);
  return pages.filter((p) => p.view === 'type' && (p.count > 0 || p === current)).map((p) => link(`/${p.path}`, `${esc(p.label)} <span class="nav-n">${p.count}</span>`)).join('\n');
}

export function renderPage(page, pages, version, template = read('templates/page.html')) {
  const slots = {
    TITLE: esc(page.title), DESCRIPTION: esc(page.description), SUBTITLE: esc(page.subtitle),
    ROBOTS: page.noindex ? '\n  <meta name="robots" content="noindex" />' : '',
    NAV: navHtml(pages, page), CATNAV: catNavHtml(pages, page), CATNAV_HIDDEN: page.view === 'type' ? '' : ' hidden', V: version,
    PAGE: JSON.stringify({ view: page.view, ...(page.type ? { type: page.type } : {}), ...(page.facts ? { facts: page.facts } : {}) }),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in slots ? slots[k] : m));
}

/* ---------- assets ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const CODE = /\.(js|css|html)$/;
const isTest = (p) => /\.test\.js$/.test(p) || /package\.json$/.test(p);

/* One hash over everything the browser runs. It changes only when code changes,
   never on a data-only deploy, so poster and shell caches survive new titles. */
export function assetVersion() {
  const h = createHash('sha256');
  const files = [...walk(join(ROOT, 'assets')), ...walk(join(ROOT, 'shared')), join(ROOT, 'templates/page.html'), join(ROOT, 'sw.js')]
    .filter((p) => CODE.test(p) && !isTest(p)).sort();
  for (const f of files) { h.update(relative(ROOT, f).replace(/\\/g, '/')); h.update(readFileSync(f)); }
  return h.digest('hex').slice(0, 10);
}

/* import './x.js' -> import './x.js?v=HASH' so module URLs change with the code */
export const stampImports = (src, version) =>
  src.replace(/(\bfrom\s+|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"?]+\.js)(\?[^'"]*)?\2/g, (m, pre, q, path) => `${pre}${q}${path}?v=${version}${q}`);

export function renderServiceWorker(pages, version, src = read('sw.js')) {
  const shell = ['/', ...pages.filter((p) => p.path && (p.view !== 'type' || p.count > 0)).map((p) => `/${p.path}`),
    `/assets/styles.css?v=${version}`, `/assets/app.js?v=${version}`, '/manifest.webmanifest',
    '/assets/icons/icon-192.png', '/assets/icons/apple-touch-icon.png'];
  return src.replace("'__ASSET_VERSION__'", JSON.stringify(version)).replace(/\/\*__SHELL_URLS__\*\/\s*\[[^\]]*\]/, JSON.stringify(shell));
}

function gitSha() {
  try { return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

/* ---------- build ---------- */
export function build({ out = join(ROOT, '_site'), posters = true } = {}) {
  const items = loadItems();
  const pages = listPages(items);
  const version = assetVersion();
  const template = read('templates/page.html');

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const dir of ['assets', 'shared']) {
    for (const f of walk(join(ROOT, dir))) {
      if (isTest(f)) continue;
      const dest = join(out, relative(ROOT, f));
      mkdirSync(dirname(dest), { recursive: true });
      if (/\.js$/.test(f)) writeFileSync(dest, stampImports(readFileSync(f, 'utf8'), version));
      else copyFileSync(f, dest);
    }
  }
  for (const f of ['404.html', 'CNAME', 'manifest.webmanifest', 'data.json']) if (existsSync(join(ROOT, f))) copyFileSync(join(ROOT, f), join(out, f));
  if (posters) cpSync(join(ROOT, 'posters'), join(out, 'posters'), { recursive: true });

  for (const p of pages) {
    mkdirSync(join(out, p.path), { recursive: true });
    writeFileSync(join(out, p.path, 'index.html'), renderPage(p, pages, version, template));
  }
  const data = buildData(items);
  writeFileSync(join(out, 'data.min.json'), data);
  writeFileSync(join(out, 'upcoming.ics'), buildCalendar(items));
  writeFileSync(join(out, 'ingest.json'), JSON.stringify(recentShots()));
  writeFileSync(join(out, 'sw.js'), renderServiceWorker(pages, version));
  writeFileSync(join(out, 'version.json'), JSON.stringify({ sha: gitSha(), assets: version, items: items.length, deployed_at: new Date().toISOString() }) + '\n');
  writeFileSync(join(out, '.nojekyll'), '');
  return { out, pages: pages.length, items: items.length, version, dataBytes: Buffer.byteLength(data) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
  const r = build({ out: resolve(arg('--out', join(ROOT, '_site'))), posters: !process.argv.includes('--no-posters') });
  console.log(JSON.stringify(r));
}
