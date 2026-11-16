/* Browsable list: one category, everything (/all/), or friends' picks.
 * Filters live in the URL so any view can be bookmarked or shared. */
import { CATEGORIES, category } from '../../../shared/taxonomy.js';
import { applyFilters, applySort, facetCounts } from '../../lib/filters.js';
import { state, visibleItems, stage, netVotes } from '../store.js';
import { el, card, row, emptyState } from '../card.js';

const BATCH = 60;
const LS_LAYOUT = 'watchlist.layout';
const PARAMS = ['q', 'stage', 'tag', 'sort', 'verdict', 'source', 'decade', 'type'];

export function readParams() {
  const sp = new URLSearchParams(location.search);
  const out = {};
  for (const k of PARAMS) out[k] = sp.get(k) || '';
  return out;
}
export function writeParams(p) {
  const sp = new URLSearchParams();
  for (const k of PARAMS) if (p[k]) sp.set(k, p[k]);
  const qs = sp.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
}

const select = (label, value, options, onchange) => el('label', { class: 'facet' },
  el('span', { class: 'facet-label', text: label }),
  el('select', { onchange: (e) => onchange(e.target.value) },
    options.map(([v, text]) => el('option', { value: v, selected: v === value, text }))));

/* page: {view: 'type'|'all'|'recommended', type?}. Returns a function that re-renders in place. */
export function renderList(root, page) {
  const fixedType = page.view === 'type' ? page.type : '';
  const cat = fixedType ? category(fixedType) : null;
  let observer = null;

  function draw() {
    observer?.disconnect();
    const p = readParams();
    const type = fixedType || p.type;
    let base = visibleItems();
    if (page.view === 'recommended') base = base.filter((it) => netVotes(it) > 0);
    if (type) base = base.filter((it) => it.type === type);

    /* stage tabs count within the category, before the other filters narrow things */
    const counts = { backlog: 0, active: 0, finished: 0, skipped: 0 };
    for (const it of base) counts[stage(it)]++;
    const verbs = (cat || category(type || 'other')).verbs;
    const generic = !type;
    const tabs = [
      ['', 'All', base.length - (state.owner ? 0 : counts.skipped)],
      ['backlog', generic ? 'Backlog' : verbs[0], counts.backlog],
      ['active', generic ? 'In progress' : verbs[1], counts.active],
      ['finished', generic ? 'Finished' : verbs[2], counts.finished],
      ...(state.owner && counts.skipped ? [['skipped', 'Not interested', counts.skipped]] : []),
    ];
    const set = (patch) => { writeParams({ ...readParams(), ...patch }); draw(); };

    const scoped = base.filter((it) => (p.stage ? stage(it) === p.stage : state.owner || stage(it) !== 'skipped'));
    const filtered = applyFilters(scoped, { q: p.q, tag: p.tag, verdict: p.verdict, source: p.source, decade: p.decade });
    const sortKey = p.sort || (page.view === 'recommended' ? 'votes' : 'added-desc');
    const sorted = sortKey === 'votes' ? [...filtered].sort((a, b) => netVotes(b) - netVotes(a)) : applySort(filtered, sortKey);

    const tagFacets = facetCounts(scoped, (it) => it.tags, 14);
    const decades = facetCounts(scoped, (it) => (it.year ? Math.floor(it.year / 10) * 10 : null)).map(([d]) => d).sort((a, b) => b - a);
    const sources = facetCounts(scoped, (it) => it.source || 'manual');
    const layout = localStorage.getItem(LS_LAYOUT) === 'rows' ? 'rows' : 'grid';
    const active = PARAMS.filter((k) => k !== 'sort' && k !== 'stage' && !(k === 'type' && fixedType) && p[k]);

    const head = el('header', { class: 'list-head' },
      el('h1', { class: 'list-title' },
        page.view === 'recommended' ? '★ Recommended by friends' : cat ? `${cat.glyph} ${cat.label}` : 'Everything',
        el('span', { class: 'pill', text: String(sorted.length) })),
      el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label, n]) =>
        el('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(p.stage === k), onclick: () => set({ stage: k }) },
          label, el('span', { class: 'tab-n', text: String(n) })))),
    );

    const facets = el('div', { class: 'facets' },
      !fixedType && page.view !== 'recommended' && select('category', p.type, [['', 'all'], ...CATEGORIES.filter((c) => visibleItems().some((it) => it.type === c.key)).map((c) => [c.key, c.label.toLowerCase()])], (v) => set({ type: v })),
      select('sort', sortKey, [
        ...(page.view === 'recommended' ? [['votes', 'most recommended']] : []),
        ['added-desc', 'newest added'], ['added-asc', 'oldest added'], ['title-asc', 'title a–z'], ['title-desc', 'title z–a'],
        ['year-desc', 'year, newest'], ['year-asc', 'year, oldest'],
        ...(scoped.some((it) => it.hours) ? [['hours-desc', 'most played']] : []),
      ], (v) => set({ sort: v })),
      decades.length > 1 && select('decade', p.decade, [['', 'any'], ...decades.map((d) => [String(d), `${d}s`])], (v) => set({ decade: v })),
      p.stage === 'finished' && select('verdict', p.verdict, [['', 'any'], ['love', 'loved'], ['up', 'liked'], ['down', 'not for me'], ['played', 'played']], (v) => set({ verdict: v })),
      sources.length > 1 && select('source', p.source, [['', 'any'], ...sources.map(([s, n]) => [s, `${s} (${n})`])], (v) => set({ source: v })),
      el('div', { class: 'layout-toggle', role: 'group', 'aria-label': 'Layout' },
        el('button', { type: 'button', 'aria-pressed': String(layout === 'grid'), title: 'Grid', text: '▦', onclick: () => { localStorage.setItem(LS_LAYOUT, 'grid'); draw(); } }),
        el('button', { type: 'button', 'aria-pressed': String(layout === 'rows'), title: 'Compact list', text: '☰', onclick: () => { localStorage.setItem(LS_LAYOUT, 'rows'); draw(); } })),
    );

    const chips = el('div', { class: 'chips', 'aria-label': 'Genres' },
      tagFacets.map(([t, n]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(p.tag.toLowerCase() === t.toLowerCase()), onclick: () => set({ tag: p.tag.toLowerCase() === t.toLowerCase() ? '' : t }) },
        t, el('span', { class: 'chip-n', text: String(n) }))),
      p.tag && !tagFacets.some(([t]) => t.toLowerCase() === p.tag.toLowerCase()) && el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onclick: () => set({ tag: '' }), text: p.tag }),
      active.length > 0 && el('button', { type: 'button', class: 'chip chip-clear', text: '✕ clear filters', onclick: () => { document.getElementById('q').value = ''; set(Object.fromEntries(active.map((k) => [k, '']))); } }),
    );

    const grid = el('div', { class: layout === 'rows' ? 'rows' : 'grid' });
    const sentinel = el('div', { class: 'sentinel', 'aria-hidden': 'true' });
    let shown = 0;
    const more = () => {
      const next = sorted.slice(shown, shown + BATCH);
      const opts = { showType: !type };
      grid.append(...next.map((it) => (layout === 'rows' ? row(it, opts) : card(it, opts))));
      shown += next.length;
      if (shown >= sorted.length) { observer?.disconnect(); sentinel.remove(); }
    };

    root.replaceChildren(head, facets, chips, grid, sentinel);
    if (!sorted.length) {
      grid.replaceWith(emptyState(active.length || p.stage ? '🔍' : '🎞️', active.length || p.stage ? 'Nothing matches those filters.' : 'Nothing here yet.',
        active.length || p.stage ? 'Try clearing a filter or the search.' : 'New finds land here as they are added.'));
      sentinel.remove();
    } else {
      more();
      observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: '900px' });
      if (shown < sorted.length) observer.observe(sentinel);
    }
    document.getElementById('count').textContent = `${sorted.length} of ${base.length} shown`;
  }

  draw();
  return draw;
}
