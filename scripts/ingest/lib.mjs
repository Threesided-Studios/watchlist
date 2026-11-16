/* Pure helpers for the screenshot ingest (unit-tested in lib.test.mjs). */
import { family, canonicalType, tmdbKind } from '../../shared/taxonomy.js';

/* Which types may collide on the same title is decided in shared/taxonomy.js:
   movie/show/anime are one family (people mislabel them), as are software/repo. */
export { family, tmdbKind };

/* The enrichment and cover-art code predates the anime and repo types and only
   knows movie/show/book/game/software. This maps an item back to those. */
export function lookupType(item) {
  const t = canonicalType(item?.type);
  if (t === 'anime') return item.format === 'film' ? 'movie' : 'show';
  if (t === 'repo') return 'software';
  return t;
}
/* Record a TMDB kind ('tv' | 'movie') on an item without turning anime back into show/movie. */
export function setScreenKind(item, kind) {
  if (canonicalType(item.type) === 'anime') { item.format = kind === 'tv' ? 'series' : 'film'; return; }
  item.type = kind === 'tv' ? 'show' : 'movie';
}

export function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* Dedupe key: drop "(2018)", subtitles after a colon are kept, leading articles dropped. */
export function titleKey(title) {
  let t = String(title || '').replace(/\s*\((19|20)\d{2}\)\s*$/, '');
  t = t.replace(/^\s*(the|a|an)\s+/i, '');
  return slugify(t);
}

/* Places get named loosely ("Black Label Burgers" / "Black Label Burger Company",
   "Wigglin Out Indoor Playground" / "Wigglin' Out"). This key drops the generic words
   and plurals so those meet. Null when too little is left to be a safe match. */
const PLACE_NOISE = new Set(['the', 'a', 'and', 'company', 'co', 'inc', 'llc', 'restaurant', 'cafe', 'grill', 'bar', 'lounge', 'kitchen', 'eatery', 'indoor', 'playground', 'shop', 'store']);
export function placeKey(title) {
  const words = String(title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !PLACE_NOISE.has(w)).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  const key = words.join('-');
  return words.length >= 2 || key.length >= 6 ? key : null;
}

export function buildIndex(items) {
  const idx = new Map();
  for (const it of items) {
    if (it.status === 'dismissed') continue;
    idx.set(`${family(it.type)}:${titleKey(it.title)}`, it.id);
  }
  return idx;
}

export function findDuplicate(index, cand) {
  return index.get(`${family(cand.type)}:${titleKey(cand.title)}`) || null;
}

export function uniqueId(base, taken, year) {
  let id = slugify(base) || 'item';
  if (!taken.has(id)) return id;
  if (year && !taken.has(`${id}-${year}`)) return `${id}-${year}`;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

/* Standard USD per 1M tokens (input, output); verified 2026-10-22. */
export const PRICES = {
  'gpt-6-luna': [0.10, 0.50],
  'gpt-6-sol': [2.00, 10.00],
  'gpt-4.1-nano': [0.10, 0.40],
  'gpt-4.1-mini': [0.40, 1.60],
  'gpt-4.1': [2.00, 8.00],
  'gpt-4o-mini': [0.15, 0.60],
};
export function costOf(model, usage) {
  const p = PRICES[model] || PRICES['gpt-4.1-mini'];
  const i = usage?.prompt_tokens || 0, o = usage?.completion_tokens || 0;
  return (i * p[0] + o * p[1]) / 1e6;
}

/* Decide whether a parsed title goes straight onto the list or to the review inbox. */
export function decideStatus(cand, { enriched, threshold = 0.8 }) {
  if ((cand.confidence ?? 0) >= threshold && enriched) return 'todo';
  return 'inbox';
}
