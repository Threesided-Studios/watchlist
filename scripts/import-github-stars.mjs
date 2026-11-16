#!/usr/bin/env node
/* Import a GitHub user's starred repositories as `repo` items.
 *
 *   node scripts/import-github-stars.mjs <github-user> [--dry-run] [--limit N]
 *
 * Starred lists are public, so no token is needed (GITHUB_TOKEN raises the
 * rate limit). Safe to re-run: repositories already on the list are skipped,
 * matched by URL or by name. Cover art is GitHub's own social card, linked
 * rather than downloaded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleKey, family, uniqueId } from './ingest/lib.mjs';
import { normalizeItem } from '../shared/normalize.js';

const repoKey = (url) => String(url || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');

/* Pure: starred API rows -> new items (existing ones skipped). */
export function starsToItems(rows, items) {
  const urls = new Set(items.map((it) => repoKey(it.repo_url || it.link)).filter((u) => u.startsWith('github.com/')));
  const names = new Set(items.filter((it) => family(it.type) === 'tool').map((it) => titleKey(it.title)));
  const taken = new Set(items.map((it) => it.id));
  const out = [];
  for (const row of rows) {
    const r = row.repo || row;
    if (!r?.full_name || r.private) continue;
    if (urls.has(repoKey(r.html_url)) || names.has(titleKey(r.name))) continue;
    const id = uniqueId(r.name, taken, null);
    taken.add(id); urls.add(repoKey(r.html_url)); names.add(titleKey(r.name));
    out.push(normalizeItem({
      id, title: r.name, type: 'repo', year: Number((r.created_at || '').slice(0, 4)) || null,
      blurb: String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 300), summary: '', poster: '',
      poster_url: `https://opengraph.githubassets.com/1/${r.full_name}`,
      link: r.homepage && /^https?:\/\//.test(r.homepage) ? r.homepage : r.html_url, repo_url: r.html_url,
      status: 'todo', tags: (r.topics || []).slice(0, 4), rating: null, notes: '',
      added: (row.starred_at || new Date().toISOString()).slice(0, 10), source: 'github-stars', author: r.owner?.login || '',
      stars: r.stargazers_count, ...(r.language ? { language: r.language } : {}),
      ...(r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? { license: r.license.spdx_id } : {}),
      pushed: (r.pushed_at || '').slice(0, 10), ...(r.archived ? { archived: true } : {}),
    }).item);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const user = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!user) { console.error('usage: import-github-stars.mjs <github-user> [--dry-run] [--limit N]'); process.exit(1); }
  const DRY = argv.includes('--dry-run');
  const li = argv.indexOf('--limit');
  const LIMIT = li >= 0 ? Number(argv[li + 1]) : Infinity;
  const DATA = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'data.json');
  const headers = { Accept: 'application/vnd.github.star+json', 'user-agent': 'watchlist-import', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

  const rows = [];
  for (let page = 1; page <= 30 && rows.length < LIMIT; page++) {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/starred?per_page=100&page=${page}`, { headers });
    if (!r.ok) { console.error('GitHub answered', r.status); process.exit(1); }
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  const items = JSON.parse(readFileSync(DATA, 'utf8'));
  const fresh = starsToItems(rows.slice(0, LIMIT), items);
  console.log(JSON.stringify({ user, starred: rows.length, new: fresh.length, already: Math.min(rows.length, LIMIT) - fresh.length }));
  for (const it of fresh.slice(0, 12)) console.log(' +', it.title, `★${it.stars}`, it.language || '', '-', it.blurb.slice(0, 70));
  if (fresh.length && !DRY) writeFileSync(DATA, JSON.stringify([...items, ...fresh], null, 2));
}
