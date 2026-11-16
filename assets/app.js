/* Boot and wiring. Which view this page shows ({view, type}) is stamped into
 * the HTML by scripts/build-site.mjs; the views live in assets/js/views/. */
import { CATEGORIES, category } from '../shared/taxonomy.js';
import { state, load, subscribe, unlock, lock, addItem, exportItems, importItems, pendingEdits, visibleItems, inboxItems, stage, sync, unsent, flush, ownerPass, INGEST_URL } from './js/store.js';
import { el, cover, toast } from './js/card.js';
import { renderHome } from './js/views/home.js';
import { renderList, readParams, writeParams } from './js/views/list.js';
import { renderInbox } from './js/views/inbox.js';
import { renderStats } from './js/views/stats.js';
import { initDetail } from './js/views/detail.js';
import { renderHow, renderPipeline } from './js/views/about.js';
import { renderMap } from './js/views/map.js';
import { renderYear } from './js/views/year.js';
import { initFx, enliven, burst } from './js/fx.js';

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
  else if (PAGE.view === 'how') renderHow(app, { openAdd });
  else if (PAGE.view === 'pipeline') renderPipeline(app, PAGE.facts);
  else if (PAGE.view === 'map') renderMap(app);
  else if (PAGE.view === 'year') renderYear(app);
  else if (PAGE.view === 'home' && !searching) renderHome(app);
  /* searching from home searches everything */
  else redrawList = renderList(app, PAGE.view === 'home' ? { view: 'all' } : PAGE);
  enliven(app);
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
  const waiting = unsent(), edits = pendingEdits();
  $('#sync').textContent = sync.state === 'sending' ? 'Syncing…'
    : waiting ? `${waiting} edit${waiting === 1 ? '' : 's'} not synced yet. ${sync.error}`
    : edits ? `${edits} edit${edits === 1 ? '' : 's'} synced, waiting for the next list update`
    : state.owner ? 'All edits synced' : '';
  const tab = PAGE.view === 'type' ? 'all' : PAGE.view === 'pipeline' ? 'how' : PAGE.view;
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
    if (await unlock(input.value)) { closeModal(); toast('Owner mode on'); flush(); } else { msg.textContent = 'That passphrase is not right.'; input.select(); }
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
  /* owner: look the title up as it is typed; picking a match fills in year, link, blurb and cover */
  const matches = el('div', { class: 'matches', hidden: true });
  let picked = null, lookupTimer, lookupSeq = 0;
  const runLookup = async () => {
    const seq = ++lookupSeq;
    const term = title.value.trim();
    if (!owner || term.length < 2) { matches.hidden = true; return; }
    try {
      const r = await fetch(`${INGEST_URL}/lookup?type=${encodeURIComponent(type.value)}&q=${encodeURIComponent(term)}`, { headers: { 'X-Owner-Pass': ownerPass() } });
      const list = r.ok ? await r.json() : [];
      if (seq !== lookupSeq) return;   // a newer search finished first
      matches.hidden = !list.length;
      matches.replaceChildren(...list.map((m) => el('button', { type: 'button', class: 'match', onclick: () => {
        picked = m; title.value = m.title; year.value = m.year || ''; link.value = m.link || ''; matches.hidden = true;
        msg.textContent = `Matched: ${m.title}${m.year ? ` (${m.year})` : ''}`;
      } },
        m.poster_url ? el('img', { src: m.poster_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'match-blank' }),
        el('span', {}, el('strong', { text: m.title }), el('span', { class: 'match-sub', text: [m.year, m.author, m.blurb].filter(Boolean).join(' · ') })))));
    } catch { matches.hidden = true; }
  };
  const queueLookup = () => { picked = null; clearTimeout(lookupTimer); lookupTimer = setTimeout(runLookup, 350); };
  title.addEventListener('input', queueLookup);
  type.addEventListener('change', queueLookup);
  const go = async () => {
    const t = title.value.trim();
    if (!t) return;
    if (owner) {
      const extra = picked && picked.title === t ? { blurb: picked.blurb || '', summary: picked.summary || '', author: picked.author || '', poster_url: picked.poster_url || '', tmdb_id: picked.tmdb_id, steam_appid: picked.steam_appid, format: picked.format } : {};
      for (const k of Object.keys(extra)) if (extra[k] === undefined || extra[k] === '') delete extra[k];
      const it = addItem({ title: t, type: type.value, year: Number(year.value) || null, link: link.value.trim(), notes: note.value.trim(), ...extra });
      closeModal(); toast(`Added “${t}”`); burst(); location.hash = `item=${it.id}`;
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
    el('p', { class: 'modal-sub', text: owner ? 'Pick a category, then type a title to look it up.' : 'Send a movie, show, book, game, app, place or anything else worth a look.' }),
    type, title, matches, year, link, note, msg,
    el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }), submit)));
  title.focus();
}

/* Tonight picker: narrow the backlog by category, genre, where it streams and
   how much time there is, then roll. Opens on whatever category is on screen. */
function openSurprise() {
  const backlog = visibleItems().filter((it) => stage(it) === 'backlog');
  if (!backlog.length) { toast('Nothing in the backlog.'); return; }
  const pick = { type: PAGE.type || '', tag: '', on: '', max: '', friends: false };
  const present = CATEGORIES.filter((c) => backlog.some((it) => it.type === c.key));
  const result = el('div', { class: 'surprise-result' });
  const controls = el('div', { class: 'picker' });

  const pool = () => backlog.filter((it) => (!pick.type || it.type === pick.type) && (!pick.tag || (it.tags || []).includes(pick.tag))
    && (!pick.on || (it.providers || []).includes(pick.on)) && (!pick.max || (it.runtime && it.runtime <= Number(pick.max)))
    && (!pick.friends || (state.tallies[it.id]?.net || 0) > 0));

  function roll() {
    const p = pool();
    if (!p.length) { result.replaceChildren(el('p', { class: 'modal-msg', text: 'Nothing matches. Loosen a filter.' })); return; }
    const it = p[Math.floor(Math.random() * p.length)];
    const cat = category(it.type);
    result.replaceChildren(
      el('div', { class: 'surprise-pick' },
        el('div', { class: `surprise-art sheet-art-${cat.cover}` }, cover(it, { eager: true })),
        el('div', {},
          el('div', { class: 'sheet-title', text: it.title }),
          el('p', { class: 'sheet-sub', text: [cat.singular, it.year, it.author, it.runtime && `${it.runtime} min`, (it.providers || [])[0]].filter(Boolean).join(' · ') }),
          el('p', { class: 'surprise-blurb', text: it.blurb || it.summary || '' }))),
      el('div', { class: 'modal-actions' },
        el('span', { class: 'modal-msg', text: `1 of ${p.length.toLocaleString()}` }),
        el('button', { type: 'button', class: 'btn btn-ghost', text: '🎲 Roll again', onclick: roll }),
        el('button', { type: 'button', class: 'btn btn-primary', text: 'Open', onclick: () => { closeModal(); location.hash = `item=${encodeURIComponent(it.id)}`; } })));
  }
  function drawControls() {
    const scoped = backlog.filter((it) => !pick.type || it.type === pick.type);
    const count = (get) => { const m = new Map(); for (const it of scoped) for (const v of [].concat(get(it) || [])) m.set(v, (m.get(v) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1]); };
    const tags = count((it) => it.tags).slice(0, 14), on = count((it) => it.providers).slice(0, 10);
    const hasRuntime = scoped.some((it) => it.runtime);
    const sel = (label, key, options) => el('label', { class: 'facet' }, el('span', { class: 'facet-label', text: label }),
      el('select', { onchange: (e) => { pick[key] = e.target.value; if (key === 'type') { pick.tag = ''; pick.on = ''; pick.max = ''; drawControls(); } roll(); } },
        options.map(([v, t]) => el('option', { value: v, selected: v === pick[key], text: t }))));
    controls.replaceChildren(...[
      sel('what', 'type', [['', 'anything'], ...present.map((c) => [c.key, c.label.toLowerCase()])]),
      tags.length > 0 && sel('mood', 'tag', [['', 'any'], ...tags.map(([t]) => [t, t.toLowerCase()])]),
      on.length > 0 && sel('streaming on', 'on', [['', 'anywhere'], ...on.map(([t]) => [t, t])]),
      hasRuntime && sel('time', 'max', [['', 'any length'], ['30', 'under 30 min'], ['60', 'under an hour'], ['100', 'under 100 min'], ['130', 'under 2h 10']]),
      Object.keys(state.tallies).length > 0 && el('label', { class: 'picker-check' }, el('input', { type: 'checkbox', onchange: (e) => { pick.friends = e.target.checked; roll(); } }), 'friends’ picks only'),
    ].filter(Boolean));
  }
  drawControls();
  openModal(el('div', { class: 'modal-card surprise' }, el('h3', { text: '🎲 What tonight?' }), controls, result));
  roll();
}

/* ---------- wiring ---------- */
let typing;
q.value = readParams().q;
/* pages with no list of their own: searching from them goes to Browse */
const STATIC_VIEWS = new Set(['how', 'pipeline', 'stats', 'inbox', 'map', 'year']);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && STATIC_VIEWS.has(PAGE.view) && q.value.trim()) location.href = `/all/?q=${encodeURIComponent(q.value.trim())}`;
});
q.addEventListener('input', () => {
  if (STATIC_VIEWS.has(PAGE.view)) return;
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

/* category strip: open on category pages, otherwise as last left */
const catnav = $('#catnav'), catToggle = $('#cat-toggle');
const setCats = (open) => { catnav.hidden = !open; catToggle.setAttribute('aria-expanded', String(open)); };
if (PAGE.view !== 'type') setCats(localStorage.getItem('watchlist.catnav') === '1');
catToggle.addEventListener('click', () => { const open = catnav.hidden; setCats(open); localStorage.setItem('watchlist.catnav', open ? '1' : '0'); });

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
  if (what === 'sync') return;
  if (what === 'edit' && $('#sheet').open) { dirty = true; return; }
  if (what === 'edit' && PAGE.view === 'inbox') return;   // the inbox removes rows itself
  /* leaving search on the home page goes back to the dashboard, so always re-pick the view */
  render();
});

initFx();
chrome();
await load();
initDetail(() => { if (dirty) { dirty = false; render(); } });
