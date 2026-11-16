/* Boot and wiring. Which view this page shows ({view, type}) is stamped into
 * the HTML by scripts/build-site.mjs; the views live in assets/js/views/. */
import { CATEGORIES, category } from '../shared/taxonomy.js';
import { state, load, subscribe, unlock, lock, addItem, exportItems, importItems, pendingEdits, visibleItems, inboxItems, stage } from './js/store.js';
import { el, cover, toast } from './js/card.js';
import { renderHome } from './js/views/home.js';
import { renderList, readParams, writeParams } from './js/views/list.js';
import { renderInbox } from './js/views/inbox.js';
import { renderStats } from './js/views/stats.js';
import { initDetail } from './js/views/detail.js';

const PAGE = window.WL_PAGE || { view: 'home' };
const $ = (s) => document.querySelector(s);
const app = $('#app');
const q = $('#q');
const modal = $('#modal');
const SUGGEST_ENDPOINT = 'https://formsubmit.co/ajax/adam@threesided.com';

/* ---------- render ---------- */
let redrawList = null;
function render() {
  if (!state.loaded) return;
  redrawList = null;
  const searching = q.value.trim();
  if (PAGE.view === 'inbox') renderInbox(app, { requestUnlock });
  else if (PAGE.view === 'stats') renderStats(app);
  else if (PAGE.view === 'home' && !searching) renderHome(app);
  /* searching from home searches everything */
  else redrawList = renderList(app, PAGE.view === 'home' ? { view: 'all' } : PAGE);
}

function chrome() {
  document.body.dataset.owner = String(state.owner);
  for (const n of document.querySelectorAll('.add-label')) n.textContent = state.owner ? 'Add' : 'Suggest';
  $('#menu-btn').textContent = state.owner ? '🔓' : '🔒';
  $('#lock').textContent = state.owner ? 'Lock owner mode' : 'Unlock owner mode';
  const n = inboxItems().length;
  for (const a of document.querySelectorAll('a[href="/inbox/"]')) {
    a.querySelector('.nav-badge')?.remove();
    if (n && state.owner) a.append(el('span', { class: 'nav-badge', text: String(n) }));
  }
  const edits = pendingEdits();
  $('#sync').textContent = edits ? `${edits} local edit${edits === 1 ? '' : 's'} on this device (Export to back up)` : '';
  const tab = PAGE.view === 'type' ? 'all' : PAGE.view;
  for (const a of document.querySelectorAll('.tabbar [data-tab]')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

/* ---------- modal helpers ---------- */
function openModal(...kids) {
  modal.replaceChildren(...kids);
  if (!modal.open) modal.showModal();
}
const closeModal = () => { if (modal.open) modal.close(); };
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function requestUnlock() {
  const input = el('input', { type: 'password', placeholder: 'Owner passphrase', autocomplete: 'current-password' });
  const msg = el('p', { class: 'modal-msg', 'aria-live': 'polite' });
  const go = async () => {
    if (await unlock(input.value)) { closeModal(); toast('Owner mode on'); } else { msg.textContent = 'That passphrase is not right.'; input.select(); }
  };
  openModal(el('form', { class: 'modal-card', onsubmit: (e) => { e.preventDefault(); go(); } },
    el('h3', { text: 'Owner mode' }),
    el('p', { class: 'modal-sub', text: 'Unlocks rating, editing and the screenshot inbox on this device.' }),
    input, msg,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }), el('button', { type: 'submit', class: 'btn btn-primary', text: 'Unlock' }))));
  input.focus();
}

function openAdd() {
  const owner = state.owner;
  const title = el('input', { type: 'text', placeholder: 'Title', required: true, autocomplete: 'off' });
  const type = el('select', {}, CATEGORIES.filter((c) => c.key !== 'other').map((c) => el('option', { value: c.key, selected: c.key === (PAGE.type || 'movie'), text: c.label })));
  const year = el('input', { type: 'number', placeholder: 'Year (optional)', inputmode: 'numeric', min: '1800', max: '2100' });
  const link = el('input', { type: 'url', placeholder: 'Link (optional)' });
  const note = el('textarea', { rows: '2', placeholder: owner ? 'Note (optional)' : 'Why, or where to find it (optional)' });
  const msg = el('p', { class: 'modal-msg', 'aria-live': 'polite' });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: owner ? 'Add' : 'Send' });
  const go = async () => {
    const t = title.value.trim();
    if (!t) return;
    if (owner) {
      const it = addItem({ title: t, type: type.value, year: Number(year.value) || null, link: link.value.trim(), notes: note.value.trim() });
      closeModal(); toast(`Added “${t}”`); location.hash = `item=${it.id}`;
      return;
    }
    submit.disabled = true; msg.textContent = 'Sending…';
    try {
      const r = await fetch(SUGGEST_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _subject: `Watchlist suggestion: ${t}`, title: t, category: category(type.value).label, year: year.value || '(none)', link: link.value || '(none)', note: note.value.trim() || '(none)', _captcha: 'false' }),
      });
      if (r.ok) { msg.textContent = '✓ Sent — thanks!'; setTimeout(closeModal, 1100); } else { msg.textContent = 'Could not send. Try again later.'; submit.disabled = false; }
    } catch { msg.textContent = 'Network error. Try again later.'; submit.disabled = false; }
  };
  openModal(el('form', { class: 'modal-card', onsubmit: (e) => { e.preventDefault(); go(); } },
    el('h3', { text: owner ? 'Add to the list' : 'Suggest something' }),
    el('p', { class: 'modal-sub', text: owner ? 'Saved on this device.' : 'Send a movie, show, book, game, app, place or anything else worth a look.' }),
    title, type, year, link, note, msg,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }), submit)));
  title.focus();
}

/* Random pick from the backlog of whatever is on screen (this category, or everything). */
function openSurprise() {
  const pool = visibleItems().filter((it) => stage(it) === 'backlog' && (!PAGE.type || it.type === PAGE.type));
  if (!pool.length) { toast('Nothing in the backlog here.'); return; }
  const roll = () => {
    const it = pool[Math.floor(Math.random() * pool.length)];
    const cat = category(it.type);
    openModal(el('div', { class: 'modal-card surprise' },
      el('h3', { text: `🎲 How about this ${cat.singular}?` }),
      el('div', { class: 'surprise-pick' },
        el('div', { class: `surprise-art sheet-art-${cat.cover}` }, cover(it, { eager: true })),
        el('div', {}, el('div', { class: 'sheet-title', text: it.title }), el('p', { class: 'sheet-sub', text: [it.year, it.author].filter(Boolean).join(' · ') }), el('p', { class: 'surprise-blurb', text: it.blurb || it.summary || '' }))),
      el('div', { class: 'modal-actions' },
        el('button', { type: 'button', class: 'btn btn-ghost', text: '🎲 Roll again', onclick: roll }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Open', onclick: () => { closeModal(); location.hash = `item=${encodeURIComponent(it.id)}`; } }))));
  };
  roll();
}

/* ---------- wiring ---------- */
let typing;
q.value = readParams().q;
q.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    writeParams({ ...readParams(), q: q.value.trim() });
    /* on home, clearing the search returns to the dashboard, so re-pick the view */
    if (redrawList && PAGE.view !== 'home') redrawList(); else render();
  }, 140);
});
addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea, select') && !document.querySelector('dialog[open]')) { e.preventDefault(); q.focus(); q.select(); }
});

$('#add').addEventListener('click', openAdd);
$('#tab-add').addEventListener('click', openAdd);
$('#surprise').addEventListener('click', openSurprise);

const menu = $('#menu'), menuBtn = $('#menu-btn');
const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
$('#lock').addEventListener('click', () => { setMenu(false); if (state.owner) { lock(); toast('Owner mode off'); } else requestUnlock(); });
$('#export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportItems(), null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: 'data.json' }).click();
  URL.revokeObjectURL(url); setMenu(false);
});
$('#import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { importItems(JSON.parse(await f.text())); toast('Imported'); } catch { toast('Import failed: not a valid data.json'); }
  setMenu(false);
});

/* the detail sheet edits items in place; refresh what is behind it once it closes */
let dirty = false;
subscribe((what) => {
  chrome();
  if (what === 'edit' && $('#sheet').open) { dirty = true; return; }
  if (what === 'edit' && PAGE.view === 'inbox') return;   // the inbox removes rows itself
  /* leaving search on the home page goes back to the dashboard, so always re-pick the view */
  render();
});

chrome();
await load();
initDetail(() => { if (dirty) { dirty = false; render(); } });
