/* Year in review: what was added and what was finished in a year.
 * "Finished" uses the date recorded when a verdict or done status was set; items
 * finished before that was tracked have no date and are not counted in any year.
 * Charts are single-series bars with the value printed on each (see stats.js). */
import { CATEGORIES } from '../../../shared/taxonomy.js';
import { facetCounts } from '../../lib/filters.js';
import { visibleItems, stage } from '../store.js';
import { el, card, emptyState } from '../card.js';

const tile = (value, label) => el('div', { class: 'tile' }, el('span', { class: 'tile-value', text: value.toLocaleString() }), el('span', { class: 'tile-label', text: label }));
function bars(title, rows, note) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r[1]));
  return el('section', { class: 'chart' }, el('h2', { class: 'chart-title', text: title }), note && el('p', { class: 'chart-note', text: note }),
    el('ul', { class: 'bars' }, rows.map(([label, n]) => el('li', { title: `${label}: ${n.toLocaleString()}` }, el('div', { class: 'bar' },
      el('span', { class: 'bar-label', text: label }), el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, (n / max) * 100)}%` })), el('span', { class: 'bar-value', text: n.toLocaleString() }))))));
}

export function renderYear(root) {
  const items = visibleItems().filter((it) => stage(it) !== 'skipped');
  const years = [...new Set(items.flatMap((it) => [String(it.added || '').slice(0, 4), String(it.finished || '').slice(0, 4)]).filter((y) => /^\d{4}$/.test(y)))].sort().reverse();
  const sp = new URLSearchParams(location.search);
  const year = years.includes(sp.get('y')) ? sp.get('y') : years[0];
  if (!year) { root.replaceChildren(emptyState('🗓', 'Nothing dated yet.')); return; }

  const added = items.filter((it) => String(it.added || '').startsWith(year));
  const finished = items.filter((it) => String(it.finished || '').startsWith(year));
  const loved = finished.filter((it) => it.verdict === 'love');
  const label = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
  const months = Array.from({ length: 12 }, (_, m) => {
    const key = `${year}-${String(m + 1).padStart(2, '0')}`;
    return [new Date(Number(year), m, 1).toLocaleString([], { month: 'short' }), added.filter((it) => String(it.added).startsWith(key)).length];
  });
  const maxMonth = Math.max(1, ...months.map((m) => m[1]));
  /* bulk library imports land on one day and would drown everything else out */
  const discovered = added.filter((it) => it.source !== 'steam' && it.source !== 'kindle' && it.source !== 'github-stars');

  root.replaceChildren(...[
    el('header', { class: 'list-head' },
      el('h1', { class: 'list-title', text: `${year} in review` }),
      years.length > 1 && el('div', { class: 'tabs', role: 'tablist' }, years.map((y) => el('a', { class: 'tab', role: 'tab', 'aria-selected': String(y === year), href: `?y=${y}`, text: y })))),
    el('section', { class: 'tiles' }, [tile(added.length, 'added'), tile(discovered.length, 'found one by one'), tile(finished.length, 'finished'), loved.length ? tile(loved.length, 'loved') : null,
      tile(new Set(added.map((it) => it.recommended_by).filter(Boolean)).size, 'people recommended something')]),
    el('div', { class: 'charts' }, [
      el('section', { class: 'chart chart-wide' }, el('h2', { class: 'chart-title', text: 'Added by month' }),
        el('ol', { class: 'cols' }, months.map(([m, n]) => el('li', { class: 'col', title: `${m}: ${n.toLocaleString()} added` },
          el('span', { class: 'col-value', text: n ? n.toLocaleString() : '' }), el('span', { class: 'col-bar', style: `height:${n ? Math.max(2, (n / maxMonth) * 100) : 0}%` }), el('span', { class: 'col-label', text: m }))))),
      bars('Added, by category', facetCounts(added, (it) => label[it.type] || it.type)),
      bars('Finished, by category', facetCounts(finished, (it) => label[it.type] || it.type), 'Counts things finished since finish dates started being recorded.'),
      bars('Genres that came up most', facetCounts(discovered, (it) => it.tags, 10)),
      bars('Who recommended the most', facetCounts(added, (it) => it.recommended_by, 8)),
      bars('Where finds came from', facetCounts(added, (it) => it.source || 'manual')),
    ]),
    loved.length ? el('section', { class: 'shelf' }, el('header', { class: 'shelf-head' }, el('h2', { class: 'shelf-title', text: `Loved in ${year}` })), el('div', { class: 'shelf-row' }, loved.slice(0, 30).map((it) => card(it, { showType: true })))) : null,
    finished.length ? el('section', { class: 'shelf' }, el('header', { class: 'shelf-head' }, el('h2', { class: 'shelf-title', text: `Finished in ${year}` })), el('div', { class: 'shelf-row' }, finished.slice(0, 40).map((it) => card(it, { showType: true })))) : null,
  ].filter(Boolean));
  document.getElementById('count').textContent = `${added.length.toLocaleString()} added in ${year}`;
}
