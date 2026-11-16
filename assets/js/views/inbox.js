/* Screenshot inbox (owner review). Finds the pipeline was unsure about wait here.
 * Keep / Dismiss go to the ingest Worker, which checks the owner passphrase;
 * the ingest job applies them to data.json on its next run. The choice also
 * sticks locally right away.
 *
 * Keys: J / K or arrows move, A keeps, X dismisses, Enter opens the details. */
import { CATEGORIES, category } from '../../../shared/taxonomy.js';
import { applySort } from '../../lib/filters.js';
import { state, inboxItems, update, ownerPass, INGEST_URL } from '../store.js';
import { el, cover, card, emptyState, toast } from '../card.js';
import { burst } from '../fx.js';

async function sendReview(it, action) {
  const pass = ownerPass();
  if (!pass) { toast('Unlock owner mode first.'); return false; }
  try {
    const r = await fetch(`${INGEST_URL}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Owner-Pass': pass },
      body: JSON.stringify({ id: it.id, action, title: it.title }),
    });
    if (r.status === 403) { toast('Passphrase not accepted. Lock and unlock again.'); return false; }
    return r.ok;
  } catch { toast('Could not reach the inbox service. Try again in a minute.'); return false; }
}

async function uploadShots(files, msg) {
  const pass = ownerPass();
  if (!pass) return;
  let ok = 0, dup = 0, bad = 0;
  for (const f of files) {
    msg.textContent = `Uploading ${ok + dup + bad + 1} of ${files.length}…`;
    try {
      const r = await fetch(`${INGEST_URL}/ingest?name=${encodeURIComponent(f.name)}`, {
        method: 'POST', headers: { 'X-Owner-Pass': pass, 'Content-Type': f.type || 'application/octet-stream' }, body: f,
      });
      if (r.status === 201) ok++; else if (r.ok) dup++; else bad++;
    } catch { bad++; }
  }
  msg.textContent = `Sent ${ok} new${dup ? `, ${dup} already seen` : ''}${bad ? `, ${bad} failed` : ''}. They are read on the next ingest run.`;
}

async function queueStatus(node) {
  try {
    const s = await (await fetch(`${INGEST_URL}/status`, { cache: 'no-store' })).json();
    const last = s.last_received ? new Date(s.last_received).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
    node.textContent = `${s.queued} screenshot${s.queued === 1 ? '' : 's'} waiting to be read · ${s.processed} read so far · ${s.reviews} decision${s.reviews === 1 ? '' : 's'} syncing · last upload ${last}`;
  } catch { node.textContent = 'Inbox service unreachable.'; }
}

export function renderInbox(root, { requestUnlock }) {
  const pending = applySort(inboxItems(), 'added-desc');
  const selected = new Set();
  let cursor = 0;

  const status = el('p', { class: 'inbox-status' });
  const uploadMsg = el('p', { class: 'inbox-status', 'aria-live': 'polite' });
  const file = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  file.addEventListener('change', () => { if (file.files.length) uploadShots([...file.files], uploadMsg); });

  const head = el('header', { class: 'list-head' },
    el('h1', { class: 'list-title' }, '📥 Screenshot inbox', el('span', { class: 'pill', text: String(pending.length) })),
    el('p', { class: 'lede', text: 'Screenshots from your phone are read automatically. Finds with a confident match go straight onto the list; anything unsure waits here.' }),
    status,
    state.owner
      ? el('div', { class: 'inbox-tools' }, el('label', { class: 'btn btn-ghost' }, '⬆ Add screenshots', file), uploadMsg)
      : el('button', { type: 'button', class: 'btn btn-primary', text: '🔒 Unlock to review', onclick: requestUnlock }));
  queueStatus(status);

  const list = el('div', { class: 'review-list' });
  const bulk = el('div', { class: 'bulk', hidden: true });
  const rows = new Map();

  const focusRow = (i) => {
    cursor = Math.max(0, Math.min(i, list.children.length - 1));
    [...list.children].forEach((n, j) => n.classList.toggle('is-current', j === cursor));
    list.children[cursor]?.scrollIntoView({ block: 'nearest' });
  };
  const refreshBulk = () => {
    bulk.hidden = !selected.size;
    bulk.replaceChildren(
      el('span', { text: `${selected.size} selected` }),
      el('button', { type: 'button', class: 'btn btn-primary', text: '✓ Keep selected', onclick: () => decideMany('approve') }),
      el('button', { type: 'button', class: 'btn btn-ghost', text: '✕ Dismiss selected', onclick: () => decideMany('dismiss') }));
  };
  async function decide(it, action) {
    const node = rows.get(it.id);
    if (!node || node.classList.contains('is-busy')) return;
    if (!state.owner) { requestUnlock(); return; }
    node.classList.add('is-busy');
    if (await sendReview(it, action)) {
      update(it.id, { status: action === 'approve' ? 'todo' : 'dismissed' }, { sync: false });   // /review already told the Worker
      selected.delete(it.id); rows.delete(it.id);
      node.remove(); refreshBulk(); focusRow(cursor);
      toast(action === 'approve' ? `Kept “${it.title}”` : `Dismissed “${it.title}”`);
      if (action === 'approve') burst();
      if (!list.children.length) list.replaceWith(emptyState('✨', 'Nothing left to review.', 'New screenshot finds show up here.'));
    } else node.classList.remove('is-busy');
  }
  async function decideMany(action) {
    for (const id of [...selected]) { const it = state.byId.get(id); if (it) await decide(it, action); }
  }

  for (const it of pending) {
    const cat = category(it.type);
    const pick = el('input', { type: 'checkbox', 'aria-label': `Select ${it.title}` });
    pick.addEventListener('change', () => { pick.checked ? selected.add(it.id) : selected.delete(it.id); refreshBulk(); });
    const type = el('select', { 'aria-label': 'Category', onchange: (e) => update(it.id, { type: e.target.value }) },
      CATEGORIES.map((c) => el('option', { value: c.key, selected: c.key === it.type, text: c.label })));
    const title = el('input', { type: 'text', class: 'review-title', value: it.title, 'aria-label': 'Title' });
    title.addEventListener('change', () => { if (title.value.trim()) update(it.id, { title: title.value.trim() }); });
    const conf = typeof it.ai_confidence === 'number' ? `${Math.round(it.ai_confidence * 100)}% sure` : '';
    const match = it.enriched_via ? `matched on ${it.enriched_via}${it.match_ok === false ? ' (unverified)' : ''}` : 'no database match';
    const node = el('article', { class: 'review', dataset: { id: it.id } },
      state.owner && pick,
      el('a', { class: `review-art review-art-${cat.cover}`, href: `#item=${encodeURIComponent(it.id)}`, 'aria-label': `Details for ${it.title}` }, cover(it)),
      el('div', { class: 'review-main' },
        state.owner ? title : el('h3', { class: 'review-title', text: it.title }),
        el('p', { class: 'review-sub', text: [it.year, it.author, it.blurb].filter(Boolean).join(' · ') }),
        it.source_context && el('p', { class: 'review-context', text: it.source_context + (it.recommended_by ? ` · via ${it.recommended_by}` : '') }),
        el('p', { class: 'review-meta', text: [it.adult && '18+ stays owner-only', conf, match, it.qa, it.added].filter(Boolean).join(' · ') }),
        state.owner && el('div', { class: 'review-actions' },
          type,
          el('button', { type: 'button', class: 'btn btn-primary', text: '✓ Keep', onclick: () => decide(it, 'approve') }),
          el('button', { type: 'button', class: 'btn btn-ghost', text: '✕ Dismiss', onclick: () => decide(it, 'dismiss') }))));
    rows.set(it.id, node);
    list.append(node);
  }

  const recent = applySort(state.items.filter((it) => it.source === 'screenshot' && it.status !== 'inbox' && it.status !== 'dismissed' && (state.owner || !it.adult)), 'added-desc').slice(0, 24);
  root.replaceChildren(head, bulk,
    pending.length ? list : emptyState('✨', 'Nothing to review.', 'New screenshot finds show up here.'),
    recent.length ? el('section', { class: 'shelf' }, el('header', { class: 'shelf-head' }, el('h2', { class: 'shelf-title', text: 'Recently added from screenshots' })),
      el('div', { class: 'shelf-row' }, recent.map((it) => card(it, { showType: true, context: true })))) : null);
  if (pending.length) focusRow(0);
  document.getElementById('count').textContent = `${pending.length} to review`;

  const onKey = (e) => {
    if (!list.isConnected) { removeEventListener('keydown', onKey); return; }
    if (e.target.closest('input, select, textarea, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const it = state.byId.get(list.children[cursor]?.dataset.id);
    const k = e.key.toLowerCase();
    if (k === 'j' || k === 'arrowdown') { e.preventDefault(); focusRow(cursor + 1); }
    else if (k === 'k' || k === 'arrowup') { e.preventDefault(); focusRow(cursor - 1); }
    else if (it && k === 'a') decide(it, 'approve');
    else if (it && k === 'x') decide(it, 'dismiss');
    else if (it && k === 'enter') location.hash = `item=${encodeURIComponent(it.id)}`;
  };
  addEventListener('keydown', onKey);
}
