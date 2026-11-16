/* Home: what to pick up next, what is under way, what just arrived, then one shelf per category. */
import { CATEGORIES } from '../../../shared/taxonomy.js';
import { applySort } from '../../lib/filters.js';
import { state, visibleItems, inboxItems, stage, netVotes } from '../store.js';
import { el, card } from '../card.js';

const LS_INTRO = 'watchlist.introSeen';
const SHELF = 14;

function shelf(title, items, { href, total, context = false, showType = true, note } = {}) {
  if (!items.length) return null;
  return el('section', { class: 'shelf' },
    el('header', { class: 'shelf-head' },
      el('h2', { class: 'shelf-title', text: title }),
      note && el('span', { class: 'shelf-note', text: note }),
      href && el('a', { class: 'shelf-more', href }, `See all ${total ?? ''} →`)),
    el('div', { class: 'shelf-row' }, items.map((it) => card(it, { showType, context }))));
}

function tile(value, label, href) {
  return el(href ? 'a' : 'div', { class: 'tile', href }, el('span', { class: 'tile-value', text: value.toLocaleString() }), el('span', { class: 'tile-label', text: label }));
}

export function renderHome(root) {
  const items = visibleItems();
  const month = new Date().toISOString().slice(0, 7);
  const counts = { backlog: 0, active: 0, finished: 0, skipped: 0 };
  for (const it of items) counts[stage(it)]++;
  const newThisMonth = items.filter((it) => String(it.added || '').startsWith(month)).length;
  const pending = inboxItems().length;

  const parts = [];

  if (!state.owner && localStorage.getItem(LS_INTRO) !== '1') {
    const intro = el('aside', { class: 'intro' },
      el('div', {},
        el('h2', { text: 'Everything on my radar. Browse freely.' }),
        el('p', {}, 'Everything I’m watching, playing, reading and trying, in one place. Vote 👍 on anything you’d recommend and it rises into ', el('a', { href: '/recommended/', text: 'Friends’ picks' }), ', or use ', el('strong', { text: '+ Suggest' }), ' to send me something new.')),
      el('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': 'Dismiss', text: '✕', onclick: () => { localStorage.setItem(LS_INTRO, '1'); intro.remove(); } }));
    parts.push(intro);
  }

  if (state.owner && pending) {
    parts.push(el('a', { class: 'banner', href: '/inbox/' },
      el('span', { class: 'banner-icon', text: '📥' }),
      el('span', {}, el('strong', { text: `${pending} screenshot find${pending === 1 ? '' : 's'} to review` }), el('span', { class: 'banner-sub', text: 'Keep or dismiss them in the inbox' })),
      el('span', { class: 'banner-go', text: 'Review →' })));
  }

  parts.push(el('section', { class: 'tiles', 'aria-label': 'Summary' },
    tile(items.length - counts.skipped, 'on the list', '/all/'),
    tile(counts.backlog, 'in the backlog', '/all/?stage=backlog'),
    tile(counts.active, 'in progress', '/all/?stage=active'),
    tile(counts.finished, 'finished', '/all/?stage=finished'),
    tile(newThisMonth, 'added this month', '/all/?sort=added-desc')));

  const backlog = items.filter((it) => stage(it) === 'backlog');
  const newest = applySort(backlog, 'added-desc');

  parts.push(shelf('Up next', items.filter((it) => it.pinned && stage(it) !== 'finished'), { note: 'pinned by me' }));
  parts.push(shelf('In progress', applySort(items.filter((it) => stage(it) === 'active'), 'added-desc').slice(0, SHELF), { href: '/all/?stage=active', total: counts.active }));
  /* bulk library imports all share one date, so "recent" means individually found things */
  parts.push(shelf('Recently added', newest.filter((it) => it.source !== 'steam' && it.source !== 'kindle').slice(0, SHELF), { href: '/all/?sort=added-desc', total: '', context: true }));
  const recs = items.filter((it) => netVotes(it) > 0).sort((a, b) => netVotes(b) - netVotes(a));
  parts.push(shelf('Friends’ picks', recs.slice(0, SHELF), { href: '/recommended/', total: recs.length }));

  for (const c of CATEGORIES) {
    const mine = newest.filter((it) => it.type === c.key);
    const all = items.filter((it) => it.type === c.key && stage(it) !== 'skipped').length;
    parts.push(shelf(`${c.glyph} ${c.label}`, mine.slice(0, SHELF), { href: `/${c.slug}/`, total: all, showType: false, note: `${mine.length} ${c.verbs[0]}` }));
  }

  root.replaceChildren(...parts.filter(Boolean));
  document.getElementById('count').textContent = `${(items.length - counts.skipped).toLocaleString()} items`;
}
