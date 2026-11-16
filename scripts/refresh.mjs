#!/usr/bin/env node
/* Weekly refresh of facts that change after an item is added.
 *
 *   node scripts/refresh.mjs [--dry-run] [--limit N] [--only screen|repo]
 *
 *   movies, shows, anime (with a tmdb_id):
 *     providers   where it streams in the US (subscription services only)
 *     runtime     minutes (a film's length, or a typical episode)
 *     next_air    date of the next episode, or of a release still to come
 *     airing      true while a series is still being made
 *   repos (with a GitHub repo_url):
 *     stars, pushed, archived, release; release_at is stamped when a new
 *     release appears, so the site can flag it for a couple of weeks
 *
 * env: TMDB_READ_TOKEN (screen items are skipped without it), GITHUB_TOKEN (optional, raises the rate limit)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { family, tmdbKind } from '../shared/taxonomy.js';

const today = () => new Date().toISOString().slice(0, 10);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ---------- pure: turn API answers into item fields ---------- */
export function screenFacts(kind, d, now = today()) {
  const out = {};
  const us = d?.['watch/providers']?.results?.US;
  out.providers = [...new Set((us?.flatrate || []).map((p) => p.provider_name.replace(/ (with Ads|Standard with Ads|Amazon Channel|Apple TV Channel)$/i, '')))].slice(0, 5);
  if (kind === 'movie') {
    out.runtime = d.runtime || null;
    out.next_air = d.release_date && d.release_date > now ? d.release_date : null;
    out.airing = null;
  } else {
    out.runtime = d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null;
    out.next_air = d.next_episode_to_air?.air_date && d.next_episode_to_air.air_date >= now ? d.next_episode_to_air.air_date : null;
    out.airing = d.in_production ? true : null;
  }
  return out;
}

export function repoFacts(r, latestTag, prev = {}, now = today()) {
  const out = {
    stars: r.stargazers_count, pushed: (r.pushed_at || '').slice(0, 10), archived: r.archived ? true : null,
    language: r.language || prev.language || null, release: latestTag || prev.release || null,
  };
  /* a release we had not seen before (and not the first time we look) */
  out.release_at = latestTag && prev.release && latestTag !== prev.release ? now : prev.release_at || null;
  return out;
}

/* Apply facts to an item; null removes a field. Returns true if anything changed. */
export function applyFacts(item, facts) {
  let changed = false;
  for (const [k, v] of Object.entries(facts)) {
    const empty = v === null || v === undefined || (Array.isArray(v) && !v.length);
    if (empty) { if (k in item) { delete item[k]; changed = true; } continue; }
    if (!same(item[k], v)) { item[k] = v; changed = true; }
  }
  return changed;
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const DATA = join(ROOT, 'data.json');
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const DRY = argv.includes('--dry-run');
  const LIMIT = Number(opt('--limit', 0)) || Infinity;
  const ONLY = opt('--only', '');
  const TMDB = process.env.TMDB_READ_TOKEN || '';
  const GH = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

  const get = async (url, headers) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { headers: { 'user-agent': 'watchlist-refresh/1.0', ...headers }, signal: AbortSignal.timeout(15000) });
        if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
        return r.ok ? await r.json() : null;
      } catch { /* retry */ }
    }
    return null;
  };

  const items = JSON.parse(readFileSync(DATA, 'utf8'));
  const jobs = [];
  if (ONLY !== 'repo') {
    if (!TMDB) console.warn('TMDB_READ_TOKEN missing: skipping movies, shows and anime');
    else for (const it of items) {
      if (family(it.type) !== 'screen' || !it.tmdb_id || it.status === 'dismissed') continue;
      jobs.push(async () => {
        const kind = tmdbKind(it);
        const d = await get(`https://api.themoviedb.org/3/${kind}/${it.tmdb_id}?append_to_response=watch/providers`, { Authorization: `Bearer ${TMDB}` });
        return d ? applyFacts(it, screenFacts(kind, d)) : false;
      });
    }
  }
  if (ONLY !== 'screen') {
    for (const it of items) {
      const m = String(it.repo_url || '').match(/github\.com\/([^/]+\/[^/#?]+)/i);
      if (it.type !== 'repo' || !m) continue;
      jobs.push(async () => {
        const slug = m[1].replace(/\.git$/, '');
        const r = await get(`https://api.github.com/repos/${slug}`, { Accept: 'application/vnd.github+json', ...GH });
        if (!r) return false;
        const rel = await get(`https://api.github.com/repos/${slug}/releases/latest`, { Accept: 'application/vnd.github+json', ...GH });
        return applyFacts(it, repoFacts(r, rel?.tag_name || '', it));
      });
    }
  }

  const todo = jobs.slice(0, LIMIT);
  let next = 0, changed = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < todo.length) { if (await todo[next++]()) changed++; }
  }));
  console.log(JSON.stringify({ checked: todo.length, changed, upcoming: items.filter((it) => it.next_air).length, streaming: items.filter((it) => it.providers?.length).length }));
  if (changed && !DRY) writeFileSync(DATA, JSON.stringify(items, null, 2));
}
