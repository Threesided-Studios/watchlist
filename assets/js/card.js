/* Small DOM helpers and the card every view is built from. */
import { category } from '../../shared/taxonomy.js';
import { state, stage, netVotes } from './store.js';

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

export const VERDICTS = {
  love: { glyph: '♥', label: 'Loved it' },
  up: { glyph: '👍', label: 'Liked it' },
  down: { glyph: '👎', label: 'Not for me' },
  played: { glyph: '✓', label: 'Played' },
  skip: { glyph: '⊘', label: 'Not interested' },
};

const SOURCE_LABEL = { screenshot: 'from a screenshot', reddit: 'from a Reddit thread', steam: 'Steam library', kindle: 'Kindle library', airtable: 'added by hand', manual: 'added by hand' };
export const sourceLabel = (it) => SOURCE_LABEL[it.source] || '';

/* Art, or a tinted tile with the title when there is none. */
export function cover(it, { eager = false } = {}) {
  const cat = category(it.type);
  const box = el('div', { class: `cover cover-${cat.cover}`, dataset: { type: it.type } });
  box.style.setProperty('--g1', cat.grad[0]);
  box.style.setProperty('--g2', cat.grad[1]);
  if (it.poster || it.poster_url) {
    const img = el('img', { src: it.poster ? `/${it.poster}` : it.poster_url, referrerpolicy: 'no-referrer', alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async' });
    img.addEventListener('error', () => { img.remove(); box.append(placeholder(it, cat)); }, { once: true });
    box.append(img);
  } else {
    box.append(placeholder(it, cat));
  }
  return box;
}
const placeholder = (it, cat) => el('div', { class: 'cover-blank', 'aria-hidden': 'true' }, el('span', { class: 'cover-glyph', text: cat.glyph }), el('span', { class: 'cover-title', text: it.title }));

/* opts.showType: label the category (mixed lists); opts.context: show where it came from */
export function card(it, opts = {}) {
  const cat = category(it.type);
  const st = stage(it);
  const votes = netVotes(it);
  const badges = el('div', { class: 'card-badges' },
    opts.showType && el('span', { class: 'badge badge-type', text: cat.singular }),
    it.pinned && el('span', { class: 'badge badge-pin', title: 'Up next', text: '▲ next' }),
    st === 'active' && el('span', { class: 'badge badge-active', text: cat.verbs[1] }),
    it.verdict && VERDICTS[it.verdict] && el('span', { class: 'badge badge-verdict', title: VERDICTS[it.verdict].label, text: VERDICTS[it.verdict].glyph }),
    votes > 0 && el('span', { class: 'badge badge-rec', title: `${votes} friend recommendation${votes === 1 ? '' : 's'}`, text: `★ ${votes}` }),
    it.adult && state.owner && el('span', { class: 'badge', text: '18+' }),
  );
  const sub = [it.year, it.author, it.hours ? `${it.hours}h played` : ''].filter(Boolean).join(' · ');
  const context = opts.context && (it.recommended_by ? `via ${it.recommended_by}` : sourceLabel(it));
  return el('a', { class: `card card-${cat.cover}`, href: `#item=${encodeURIComponent(it.id)}`, dataset: { id: it.id, type: it.type, stage: st } },
    el('div', { class: 'card-art' }, cover(it), badges),
    el('div', { class: 'card-meta' },
      el('span', { class: 'card-title', text: it.title }),
      sub && el('span', { class: 'card-sub', text: sub }),
      context && el('span', { class: 'card-context', text: context }),
    ),
  );
}

/* Compact row for the list layout. */
export function row(it, opts = {}) {
  const cat = category(it.type);
  return el('a', { class: 'row', href: `#item=${encodeURIComponent(it.id)}`, dataset: { id: it.id, type: it.type, stage: stage(it) } },
    el('div', { class: 'row-art' }, cover(it)),
    el('div', { class: 'row-main' },
      el('span', { class: 'row-title', text: it.title }),
      el('span', { class: 'row-sub', text: [opts.showType && cat.singular, it.year, it.author, (it.tags || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ') }),
    ),
    el('span', { class: 'row-state', text: it.verdict && VERDICTS[it.verdict] ? VERDICTS[it.verdict].glyph : stage(it) === 'active' ? '●' : '' }),
  );
}

export function emptyState(glyph, msg, hint) {
  return el('div', { class: 'empty' }, el('div', { class: 'empty-glyph', text: glyph }), el('p', { class: 'empty-msg', text: msg }), hint && el('p', { class: 'empty-hint', text: hint }));
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
