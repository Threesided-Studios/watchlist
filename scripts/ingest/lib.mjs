/* Pure helpers for the screenshot ingest (unit-tested in lib.test.mjs). */

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

/* Families that may collide: an anime "show" is still a show; movies and shows
   share a family because people mislabel them; books/games are distinct. */
export const family = (type) => (type === 'movie' || type === 'show') ? 'screen' : (type || 'other');

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
