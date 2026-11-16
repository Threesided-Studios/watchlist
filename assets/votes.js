/* Guest voting via the Cloudflare Worker (token never reaches the browser).
 * One vote per browser per item, tracked in localStorage with the Airtable
 * record id so a change PATCHes and a retract DELETEs — keeping tallies clean. */
import { AIRTABLE } from './airtable-config.js';

const LSV = 'watchlist.votes';
const api = () => (AIRTABLE.WORKER_URL || '').replace(/\/$/, '');
const enabled = () => !!api();

function localVotes() { try { return JSON.parse(localStorage.getItem(LSV) || '{}'); } catch { return {}; } }
function saveLocal(v) { localStorage.setItem(LSV, JSON.stringify(v)); }
function post(body) {
  return fetch(`${api()}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export function isVotingEnabled() { return enabled(); }
export function myVote(id) { return (localVotes()[id] || {}).vote || null; }

/* vote: 'up' | 'down' | null (retract). Returns the new vote state. */
export async function castVote(item, vote) {
  if (!enabled()) return null;
  const lv = localVotes();
  const cur = lv[item.id];
  try {
    if (cur && cur.recordId) {
      if (vote === null || vote === cur.vote) {          // same click -> retract
        await post({ op: 'delete', recordId: cur.recordId });
        delete lv[item.id]; saveLocal(lv); return null;
      }
      await post({ op: 'update', recordId: cur.recordId, vote });
      lv[item.id] = { vote, recordId: cur.recordId }; saveLocal(lv); return vote;
    }
    if (vote) {
      const r = await post({ op: 'create', item_id: item.id, title: item.title, vote });
      const j = await r.json();
      if (j && j.id) { lv[item.id] = { vote, recordId: j.id }; saveLocal(lv); return vote; }
    }
  } catch (e) { /* network — leave local state as-is */ }
  return myVote(item.id);
}

/* Returns { item_id: {up, down, net} } across all vote records. */
export async function fetchTallies() {
  if (!enabled()) return {};
  try {
    const r = await fetch(`${api()}/tallies`);
    if (!r.ok) return {};
    return await r.json();
  } catch (e) { return {}; }
}
