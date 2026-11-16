/* Stats: headline tiles, then ranked bars. Every chart here is one series of
 * magnitudes, so each uses a single hue and its own labels (no legend needed);
 * the numbers are printed beside every bar, so nothing depends on colour. */
import { CATEGORIES } from '../../../shared/taxonomy.js';
import { facetCounts } from '../../lib/filters.js';
import { visibleItems, stage } from '../store.js';
import { el } from '../card.js';

function bars(title, rows, { href, note } = {}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r[1]));
  return el('section', { class: 'chart' },
    el('h2', { class: 'chart-title', text: title }),
    note && el('p', { class: 'chart-note', text: note }),
    el('ul', { class: 'bars' }, rows.map(([label, n]) => {
      const inner = [el('span', { class: 'bar-label', text: label }),
        el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${Math.max(1, (n / max) * 100)}%` })),
        el('span', { class: 'bar-value', text: n.toLocaleString() })];
      const link = href?.(label);
      return el('li', { title: `${label}: ${n.toLocaleString()}` }, link ? el('a', { class: 'bar', href: link }, inner) : el('div', { class: 'bar' }, inner));
    })));
}

function columns(title, rows, note) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r[1]));
  return el('section', { class: 'chart chart-wide' },
    el('h2', { class: 'chart-title', text: title }),
    note && el('p', { class: 'chart-note', text: note }),
    el('ol', { class: 'cols' }, rows.map(([label, n]) => el('li', { class: 'col', title: `${label}: ${n.toLocaleString()} added` },
      el('span', { class: 'col-value', text: n ? n.toLocaleString() : '' }),
      el('span', { class: 'col-bar', style: `height:${n ? Math.max(2, (n / max) * 100) : 0}%` }),
      el('span', { class: 'col-label', text: label })))));
}

const tile = (value, label) => el('div', { class: 'tile' }, el('span', { class: 'tile-value', text: value.toLocaleString() }), el('span', { class: 'tile-label', text: label }));

export function renderStats(root) {
  const items = visibleItems().filter((it) => stage(it) !== 'skipped');
  const counts = { backlog: 0, active: 0, finished: 0 };
  for (const it of items) counts[stage(it)]++;
  const loved = items.filter((it) => it.verdict === 'love').length;
  const hours = Math.round(items.reduce((n, it) => n + (it.hours || 0), 0));

  /* last 12 months, oldest first, including empty months */
  const byMonth = new Map(facetCounts(items, (it) => String(it.added || '').slice(0, 7)));
  const months = [];
  const d = new Date(); d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    months.push([m.toLocaleString([], { month: 'short' }), byMonth.get(key) || 0]);
  }

  const slugOf = Object.fromEntries(CATEGORIES.map((c) => [c.label, c.slug]));
  const byCat = CATEGORIES.map((c) => [c.label, items.filter((it) => it.type === c.key).length]).filter((r) => r[1]).sort((a, b) => b[1] - a[1]);
  const finishedByCat = CATEGORIES.map((c) => [c.label, items.filter((it) => it.type === c.key && stage(it) === 'finished').length]).filter((r) => r[1]).sort((a, b) => b[1] - a[1]);
  const decades = facetCounts(items, (it) => (it.year ? `${Math.floor(it.year / 10) * 10}s` : null)).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10);
  const enc = encodeURIComponent;

  root.replaceChildren(
    el('header', { class: 'list-head' }, el('h1', { class: 'list-title', text: '◔ Stats' })),
    el('section', { class: 'tiles' }, [tile(items.length, 'on the list'), tile(counts.backlog, 'in the backlog'), tile(counts.active, 'in progress'),
      tile(counts.finished, 'finished'), loved ? tile(loved, 'loved') : null, hours ? tile(hours, 'hours played') : null]),
    el('div', { class: 'charts' }, [
      columns('Added per month', months, 'Last 12 months. Bulk library imports land in a single month.'),
      bars('By category', byCat, { href: (l) => `/${slugOf[l]}/` }),
      bars('Finished, by category', finishedByCat, { href: (l) => `/${slugOf[l]}/?stage=finished` }),
      bars('Top genres', facetCounts(items, (it) => it.tags, 12), { href: (l) => `/all/?tag=${enc(l)}` }),
      bars('Where items came from', facetCounts(items, (it) => it.source || 'manual'), { href: (l) => `/all/?source=${enc(l)}` }),
      bars('Recommended by', facetCounts(items, (it) => it.recommended_by, 10), { href: (l) => `/all/?q=${enc(l)}` }),
      bars('By decade', decades, { href: (l) => `/all/?decade=${l.slice(0, 4)}` })]),
  );
  document.getElementById('count').textContent = `${items.length.toLocaleString()} items`;
}
