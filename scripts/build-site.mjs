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

/* ---------- pages ---------- */
export function listPages(items = loadItems()) {
  const counts = {};
  for (const it of items) {
    if (HIDDEN.has(it.status) || it.adult) continue;
    const t = canonicalType(it.type);
    counts[t] = (counts[t] || 0) + 1;
  }
  const pages = [{ path: '', view: 'all', title: 'Watchlist — a private marquee', subtitle: 'a private marquee',
    description: 'A personal watchlist. Movies, shows, games, books and more, kept in one place.' }];
  for (const c of CATEGORIES) {
    pages.push({ path: `${c.slug}/`, view: 'type', type: c.key, title: `Watchlist — ${c.label}`, subtitle: c.label,
      description: `A personal list: ${c.label.toLowerCase()}.`, count: counts[c.key] || 0, label: c.label });
  }
  pages.push({ path: 'recommended/', view: 'recommended', title: 'Watchlist — Recommended by Friends', subtitle: 'recommended by friends',
    description: 'What friends recommend from the list.' });
  pages.push({ path: 'inbox/', view: 'inbox', title: 'Watchlist — Screenshot inbox', subtitle: 'screenshot inbox',
    description: 'Screenshot finds awaiting review.', noindex: true });
  return pages;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* Nav lists only categories that have something in them, so new ones appear as they fill up. */
function navHtml(pages, current) {
  const link = (href, label, cls = '') => `        <a href="${href}"${cls ? ` class="${cls}"` : ''}${href === `/${current.path}` ? ' aria-current="page"' : ''}>${label}</a>`;
  const out = [link('/', 'All')];
  for (const p of pages) if (p.view === 'type' && (p.count > 0 || p === current)) out.push(link(`/${p.path}`, esc(p.label)));
  out.push(link('/recommended/', '★ Friends'), link('/inbox/', '📥 Inbox', 'owner-only'));
  return out.join('\n');
}

export function renderPage(page, pages, version, template = read('templates/page.html')) {
  const slots = {
    TITLE: esc(page.title), DESCRIPTION: esc(page.description), SUBTITLE: esc(page.subtitle),
    ROBOTS: page.noindex ? '\n  <meta name="robots" content="noindex" />' : '',
    NAV: navHtml(pages, page), V: version,
    PAGE: JSON.stringify({ view: page.view, ...(page.type ? { type: page.type } : {}) }),
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
