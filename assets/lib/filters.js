/* Pure filtering and sorting (unit-tested in filters.test.js; no DOM, no storage). */

const text = (it) => [it.title, it.blurb, it.summary, Array.isArray(it.tags) ? it.tags.join(' ') : '', it.notes, it.author,
  it.recommended_by, it.source_context, it.year].filter(Boolean).join(' ').toLowerCase();

/* q: every word must appear somewhere. type/status/verdict/source: exact. tag: has it.
   decade: 1990 matches 1990-1999. stage: computed by the caller-supplied stageOf. */
export function applyFilters(items, { q = '', type = '', status = '', verdict = '', source = '', tag = '', decade = '', stage = '', on = '', series = '' } = {}, stageOf = null) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const dec = Number(decade) || 0;
  const tagLow = tag.toLowerCase();
  return items.filter((it) => {
    if (type && it.type !== type) return false;
    if (status && it.status !== status) return false;
    if (verdict && it.verdict !== verdict) return false;
    if (source && (it.source || 'manual') !== source) return false;
    if (stage && stageOf && stageOf(it) !== stage) return false;
    if (tagLow && !(it.tags || []).some((t) => String(t).toLowerCase() === tagLow)) return false;
    if (dec && !(it.year >= dec && it.year < dec + 10)) return false;
    if (on && !(it.providers || []).includes(on)) return false;
    if (series && it.series !== series) return false;
    if (words.length) {
      const hay = text(it);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const str = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
const SORTS = {
  'added-desc': (a, b) => str(b.added, a.added),
  'added-asc': (a, b) => str(a.added, b.added),
  'title-asc': (a, b) => str(a.title, b.title),
  'title-desc': (a, b) => str(b.title, a.title),
  /* undated items last in both directions */
  'year-desc': (a, b) => (b.year || -Infinity) - (a.year || -Infinity),
  'year-asc': (a, b) => (a.year || Infinity) - (b.year || Infinity),
  'hours-desc': (a, b) => (b.hours || 0) - (a.hours || 0),
  'stars-desc': (a, b) => (b.stars || 0) - (a.stars || 0),
  'series': (a, b) => (a.series_n ?? Infinity) - (b.series_n ?? Infinity),
  'soonest': (a, b) => str(a.next_air || '9999', b.next_air || '9999'),
};
export const SORT_KEYS = Object.keys(SORTS);

export function applySort(items, key = 'added-desc') {
  const fn = SORTS[key] || SORTS['added-desc'];
  /* index tiebreak keeps the order stable and deterministic */
  return items.map((it, i) => [it, i]).sort((x, y) => fn(x[0], y[0]) || x[1] - y[1]).map((x) => x[0]);
}

/* Most common values of a field (or of tags) with counts, for facet menus. */
export function facetCounts(items, pick, limit = 0) {
  const counts = new Map();
  for (const it of items) {
    const v = pick(it);
    for (const k of Array.isArray(v) ? v : [v]) if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [...counts].sort((a, b) => b[1] - a[1] || str(a[0], b[0]));
  return limit ? out.slice(0, limit) : out;
}
