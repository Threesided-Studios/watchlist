/* Home: what to pick up next, what is under way, what just arrived, then one shelf per category. */
import { CATEGORIES } from '../../../shared/taxonomy.js';
import { applySort } from '../../lib/filters.js';
import { state, visibleItems, inboxItems, stage, netVotes } from '../store.js';
import { el, card } from '../card.js';

const SHELF = 14;

function shelf(title, items, { href, total, context = false, showType = true, note, when = false } = {}) {
  if (!items.length) return null;
  return el('section', { class: 'shelf' },
    el('header', { class: 'shelf-head' },
      el('h2', { class: 'shelf-title', text: title }),
      note && el('span', { class: 'shelf-note', text: note }),
      href && el('a', { class: 'shelf-more', href }, `See all ${total ?? ''} →`)),
    el('div', { class: 'shelf-row' }, items.map((it) => card(it, { showType, context, when }))));
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

  const glitch = 'on my radar.';
  parts.push(el('header', { class: 'hero hero-home' },
    el('p', { class: 'kicker', text: state.owner ? 'welcome back' : 'a threesided list' }),
    el('h1', { class: 'hero-title' }, 'Everything ', el('span', { class: 'grad glitch', dataset: { text: glitch }, text: glitch })),
    el('p', { class: 'hero-lede', text: 'What I’m watching, playing, reading and trying. Most of it gets here from a screenshot, with no typing at all.' }),
    el('div', { class: 'hero-actions' },
      el('a', { class: 'btn btn-primary', href: '/all/', text: 'Browse everything' }),
      el('button', { type: 'button', class: 'btn', text: '🎲 Surprise me', onclick: () => document.getElementById('surprise').click() }),
      el('a', { class: 'btn btn-ghost', href: '/how-it-works/', text: 'How it works →' }))));

  /* a moving strip of what arrived most recently */
  const fresh = applySort(items.filter((it) => it.source !== 'steam' && it.source !== 'kindle'), 'added-desc').slice(0, 18);
  if (fresh.length > 6) {
    const run = () => el('div', { class: 'ticker-run', 'aria-hidden': 'true' }, fresh.map((it) => el('span', { class: 'ticker-item' }, el('i', { text: '▲' }), it.title)));
    parts.push(el('div', { class: 'ticker', role: 'presentation', title: 'Recently added' }, el('span', { class: 'ticker-label', text: 'just in' }), el('div', { class: 'ticker-track' }, run(), run())));
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
  const todayStr = new Date().toISOString().slice(0, 10);
  const coming = applySort(items.filter((it) => it.next_air && it.next_air >= todayStr && stage(it) !== 'skipped'), 'soonest');
  parts.push(shelf('Coming up', coming.slice(0, SHELF), { when: true, note: 'new episodes and releases', href: '/all/?sort=soonest', total: '' }));
  parts.push(shelf('Fresh releases', items.filter((it) => it.release_at && (Date.now() - new Date(it.release_at)) < 14 * 86400000), { note: 'repos that just shipped' }));
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
