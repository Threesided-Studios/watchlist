/* Detail sheet: everything about one item, and (for the owner) every edit. Opened by #item=<id>. */
import { CATEGORIES, category, STATUSES } from '../../../shared/taxonomy.js';
import { state, update, netVotes, stage } from '../store.js';
import { isVotingEnabled, myVote, castVote } from '../../votes.js';
import { el, cover, VERDICTS, sourceLabel, toast } from '../card.js';

const sheet = () => document.getElementById('sheet');
const enc = encodeURIComponent;

const HOSTS = [
  [/themoviedb\.org/, 'TMDB'], [/store\.steampowered\.com/, 'Steam'], [/openlibrary\.org/, 'Open Library'], [/wikipedia\.org/, 'Wikipedia'],
  [/anilist\.co/, 'AniList'], [/myanimelist\.net/, 'MyAnimeList'], [/github\.com/, 'GitHub'], [/apps\.apple\.com/, 'App Store'],
  [/open\.spotify\.com/, 'Spotify'], [/youtube\.com|youtu\.be/, 'YouTube'], [/amazon\./, 'Amazon'], [/goodreads\.com/, 'Goodreads'],
  [/royalroad\.com/, 'Royal Road'], [/itch\.io/, 'itch.io'], [/reddit\.com/, 'Reddit'],
];
function hostLabel(url) {
  for (const [rx, name] of HOSTS) if (rx.test(url)) return name;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Link'; }
}

/* Useful places to look an item up, by category. Search links, so they work without any API. */
function lookups(it) {
  const q = enc(it.title + (it.year && ['movie', 'show', 'anime'].includes(it.type) ? ` ${it.year}` : ''));
  const t = enc(it.title);
  switch (it.type) {
    case 'movie': case 'show': case 'anime':
      return [['Where to watch', `https://www.justwatch.com/us/search?q=${t}`], ['Trailer', `https://www.youtube.com/results?search_query=${q}+trailer`]];
    case 'book': case 'manga':
      return [['Goodreads', `https://www.goodreads.com/search?q=${enc(`${it.title} ${it.author || ''}`.trim())}`], ['Library', `https://www.worldcat.org/search?q=${t}`]];
    case 'game': return [['How long to beat', `https://howlongtobeat.com/?q=${t}`], ['Steam', `https://store.steampowered.com/search/?term=${t}`]];
    case 'boardgame': return [['BoardGameGeek', `https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${t}`]];
    case 'music': case 'podcast': return [['Spotify', `https://open.spotify.com/search/${t}`]];
    case 'video': return [['YouTube', `https://www.youtube.com/results?search_query=${t}`]];
    case 'place': return [['Map', `https://www.google.com/maps/search/${t}`]];
    case 'repo': case 'software': return [['GitHub', `https://github.com/search?q=${t}&type=repositories`]];
    default: return [['Search', `https://duckduckgo.com/?q=${t}`]];
  }
}

function field(label, control) { return el('label', { class: 'form-field' }, el('span', { class: 'facet-label', text: label }), control); }

function ownerPanel(it, redraw) {
  const cat = category(it.type);
  const set = (fields, msg) => { update(it.id, fields); if (msg) toast(msg); redraw(); };
  const notes = el('textarea', { rows: '3', placeholder: 'Notes to self…' });
  notes.value = it.notes || '';
  notes.addEventListener('change', () => update(it.id, { notes: notes.value.trim() }));
  const title = el('input', { type: 'text', value: it.title });
  title.addEventListener('change', () => { if (title.value.trim()) set({ title: title.value.trim() }); });
  const tags = el('input', { type: 'text', value: (it.tags || []).join(', '), placeholder: 'comma, separated' });
  tags.addEventListener('change', () => set({ tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean) }));
  const year = el('input', { type: 'number', inputmode: 'numeric', value: it.year || '', min: '1800', max: '2100' });
  year.addEventListener('change', () => set({ year: Number(year.value) || null }));
  const link = el('input', { type: 'url', value: it.link || '', placeholder: 'https://…' });
  link.addEventListener('change', () => set({ link: link.value.trim() }));

  return el('section', { class: 'owner-panel' },
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, STATUSES.map((s, i) =>
      el('button', { type: 'button', 'aria-pressed': String(it.status === s && !it.verdict), text: cat.verbs[i], onclick: () => set({ status: s, ...(s !== 'done' ? { verdict: null } : {}) }) }))),
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Verdict' }, Object.entries(VERDICTS).filter(([k]) => k !== 'played' || it.type === 'game').map(([k, v]) =>
      el('button', { type: 'button', 'aria-pressed': String(it.verdict === k), title: v.label, onclick: () => set({ verdict: it.verdict === k ? null : k, ...(k !== 'skip' && it.verdict !== k ? { status: 'done' } : {}) }) }, `${v.glyph} ${v.label}`))),
    el('button', { type: 'button', class: 'btn btn-ghost', 'aria-pressed': String(!!it.pinned), text: it.pinned ? '▲ Pinned to Up next' : '△ Pin to Up next', onclick: () => set({ pinned: !it.pinned }, it.pinned ? 'Unpinned' : 'Pinned to Up next') }),
    field('notes', notes),
    el('details', { class: 'edit-more' },
      el('summary', { text: 'Edit details' }),
      field('title', title),
      field('category', el('select', { onchange: (e) => set({ type: e.target.value }, 'Category changed') }, CATEGORIES.map((c) => el('option', { value: c.key, selected: c.key === it.type, text: c.label })))),
      field('year', year), field('tags', tags), field('link', link)),
  );
}

function votePanel(it, redraw) {
  if (!isVotingEnabled() || state.owner) return null;
  const mine = myVote(it.id);
  const vote = async (v) => {
    const prev = myVote(it.id);
    const next = await castVote(it, v);
    const t = state.tallies[it.id] || { up: 0, down: 0, net: 0 };
    if (prev === 'up') t.up--; if (prev === 'down') t.down--;
    if (next === 'up') t.up++; if (next === 'down') t.down++;
    t.net = t.up - t.down; state.tallies[it.id] = t;
    redraw();
  };
  return el('div', { class: 'seg', role: 'group', 'aria-label': 'Your recommendation' },
    el('button', { type: 'button', 'aria-pressed': String(mine === 'up'), text: '👍 Recommend', onclick: () => vote('up') }),
    el('button', { type: 'button', 'aria-pressed': String(mine === 'down'), text: '👎 Skip it', onclick: () => vote('down') }));
}

function draw(it) {
  const cat = category(it.type);
  const redraw = () => draw(it);
  const votes = netVotes(it);
  const st = stage(it);
  const stateText = it.verdict && VERDICTS[it.verdict] ? VERDICTS[it.verdict].label : cat.verbs[STATUSES.indexOf(it.status)] || '';
  const why = [
    it.source_context,
    it.recommended_by && `Recommended by ${it.recommended_by}`,
    [sourceLabel(it), it.added && `added ${it.added}`].filter(Boolean).join(' · '),
    state.owner && typeof it.ai_confidence === 'number' && `AI ${Math.round(it.ai_confidence * 100)}% sure${it.enriched_via ? ` · matched on ${it.enriched_via}${it.match_ok === false ? ' (unverified)' : ''}` : ''}`,
  ].filter(Boolean);
  const body = it.summary && it.summary !== it.blurb ? it.summary : it.blurb;
  const primary = [...(it.link ? [[hostLabel(it.link), it.link, true]] : []), ...(it.repo_url && it.repo_url !== it.link ? [['Repository', it.repo_url, true]] : [])];
  /* no "Steam" search next to a direct Steam link */
  const links = [...primary, ...lookups(it).filter(([label]) => !primary.some(([l]) => l === label))];

  sheet().replaceChildren(...[
    el('button', { type: 'button', class: 'sheet-close', 'aria-label': 'Close', text: '✕', onclick: close }),
    el('div', { class: 'sheet-top' },
      el('div', { class: `sheet-art sheet-art-${cat.cover}` }, cover(it, { eager: true })),
      el('div', { class: 'sheet-head' },
        el('span', { class: 'badge badge-type', text: `${cat.glyph} ${cat.singular}${it.format ? ` · ${it.format}` : ''}` }),
        el('h2', { class: 'sheet-title', text: it.title }),
        el('p', { class: 'sheet-sub', text: [it.year, it.author, it.hours && `${it.hours}h played`].filter(Boolean).join(' · ') }),
        el('p', { class: 'sheet-state', dataset: { stage: st } }, stateText, it.pinned && ' · ▲ up next', votes > 0 && ` · ★ ${votes} from friends`),
        (it.tags || []).length > 0 && el('div', { class: 'chips' }, it.tags.map((t) => el('a', { class: 'chip', href: `/${cat.slug}/?tag=${enc(t)}`, text: t }))))),
    body && el('p', { class: 'sheet-body', text: body }),
    el('div', { class: 'sheet-links' }, links.map(([label, href, primary]) => el('a', { class: primary ? 'btn btn-primary' : 'btn btn-ghost', href, target: '_blank', rel: 'noopener noreferrer' }, `${label} ↗`))),
    votePanel(it, redraw),
    why.length > 0 && el('section', { class: 'why' }, el('h3', { text: 'Why it’s here' }), why.map((w) => el('p', { text: w }))),
    it.notes && !state.owner && el('section', { class: 'why' }, el('h3', { text: 'Notes' }), el('p', { text: it.notes })),
    state.owner && ownerPanel(it, redraw),
  ].filter(Boolean));
}

export function openItem(id) {
  const it = state.byId.get(id);
  if (!it || (it.adult && !state.owner)) return false;
  draw(it);
  const s = sheet();
  if (!s.open) s.showModal();
  s.scrollTop = 0;
  return true;
}
export function close() {
  const s = sheet();
  if (s.open) s.close();
}

/* Keep the URL and the sheet in step: the hash opens it, closing clears the hash. */
export function initDetail(onClose) {
  const s = sheet();
  const sync = () => {
    const m = location.hash.match(/^#item=(.+)$/);
    if (m) { if (!openItem(decodeURIComponent(m[1]))) history.replaceState(null, '', location.pathname + location.search); } else close();
  };
  addEventListener('hashchange', sync);
  s.addEventListener('close', () => {
    if (location.hash.startsWith('#item=')) history.replaceState(null, '', location.pathname + location.search);
    onClose?.();
  });
  s.addEventListener('click', (e) => { if (e.target === s) close(); });   // click on the backdrop
  sync();
}
