import { QA_MODEL } from './models.mjs';
/* Poster QA for movies/shows: make sure the poster belongs to the right work when several
 * works share the title (remake vs original, same-name films, movie-vs-series mislabels).
 *   1. TMDB search (movie + tv) for the title / aka; keep exact-title hits.
 *   2. One exact hit -> fine (record tmdb_id if missing and the year agrees).
 *   3. Several exact hits (a "collision") -> gpt-6-luna picks one from the item's evidence
 *      (year, screenshot text/context, blurb, Wikipedia link, language/cast hints).
 *      If the current poster's source is unknown (no tmdb_id), a cheap low-detail vision call
 *      tells which candidate the current poster shows.
 *   4. Result: ok | fix (different work than the poster shows -> caller swaps poster) | ambiguous.
 */
import { titleKey } from './lib.mjs';

const norm = (t) => titleKey(String(t || '').replace(/[®™©]/g, '').replace(/\s*\((19|20)\d{2}\)\s*$/, ''));
const yr = (s) => Number(String(s || '').slice(0, 4)) || null;

async function tmdb(path, token) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://api.themoviedb.org/3/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000)); continue; }
      return r.ok ? r.json() : null;
    } catch { /* retry */ }
  }
  return null;
}

export async function screenCandidates(item, token) {
  const names = [...new Set([item.title, ...(item.aka || [])].map((t) => String(t).replace(/\s*\((19|20)\d{2}\)\s*$/, '')))];
  const keys = new Set(names.map(norm));
  const out = new Map();
  for (const n of names) {
    for (const kind of ['movie', 'tv']) {
      const j = await tmdb(`search/${kind}?query=${encodeURIComponent(n)}&include_adult=false`, token);
      for (const h of j?.results || []) {
        if (!keys.has(norm(h.title || h.name)) && !keys.has(norm(h.original_title || h.original_name))) continue;
        out.set(`${kind}:${h.id}`, { key: `${kind}:${h.id}`, kind, id: h.id, title: h.title || h.name, original: h.original_title || h.original_name,
          year: yr(h.release_date || h.first_air_date), lang: h.original_language, overview: (h.overview || '').slice(0, 220),
          votes: h.vote_count || 0, poster_path: h.poster_path, anime: (h.genre_ids || []).includes(16) && h.original_language === 'ja' });
      }
    }
  }
  return [...out.values()].filter((c) => c.poster_path).sort((a, b) => b.votes - a.votes).slice(0, 8);
}

const PICK = { type: 'object', additionalProperties: false, required: ['index', 'confidence', 'reason'], properties: {
  index: { type: 'integer' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } } };
const SEE = { type: 'object', additionalProperties: false, required: ['index'], properties: { index: { type: 'integer' } } };

function evidence(item, extra = {}) {
  return { title: item.title, aka: item.aka || [], listed_type: item.type, year: item.year || null, tags: item.tags || [],
    blurb: (item.blurb || '').slice(0, 200), summary: (item.summary || '').slice(0, 300), link: item.link || '',
    screenshot_text: (item.ocr_excerpt || extra.ocr || '').slice(0, 400), context: (item.source_context || extra.context || '').slice(0, 200),
    hint: item.qa_hint || '' };
}

/* returns { verdict, pick, current, cands, cost, reason } ; pick/current are candidates or null */
export async function qaScreen(item, { openai, token, posterBytes = null, extra = {} }) {
  let cost = 0;
  const cands = await screenCandidates(item, token);
  if (!cands.length) return { verdict: 'nomatch', cands, cost, reason: 'no exact-title work on TMDB' };
  const wantKind = item.type === 'show' ? 'tv' : 'movie';
  const byId = item.tmdb_id ? cands.find((c) => c.id === item.tmdb_id && c.kind === wantKind) || cands.find((c) => c.id === item.tmdb_id) : null;
  if (cands.length === 1 && cands[0].kind === wantKind && (!item.tmdb_id || byId)) {
    /* the only work with this title and the right type: fine even if the listed year is the source manga/novel year */
    return { verdict: 'ok', pick: cands[0], current: byId || null, cands, cost, reason: 'single same-title work' };
  }
  if (cands.length === 1) {
    const c = cands[0];
    const yearOk = !item.year || !c.year || Math.abs(c.year - item.year) <= 1;
    if (byId || (!item.tmdb_id && yearOk)) return { verdict: 'ok', pick: c, current: byId || null, cands, cost, reason: 'single same-title work' };
  }
  /* collision (or a lone candidate that disagrees): let the evidence decide */
  const list = cands.map((c, i) => ({ i, kind: c.kind === 'tv' ? 'TV series' : 'movie', title: c.title, original_title: c.original, year: c.year, language: c.lang, overview: c.overview, tmdb_votes: c.votes }));
  const sys = 'Several films/series share this title. Pick the candidate the watchlist item refers to, using all evidence: the year, the screenshot text and context (cast, director, platform, language, era), the blurb/summary and the Wikipedia link (e.g. "_(2008_film)"). Listed type can be wrong (movie vs series). If the item has no distinguishing evidence at all, prefer the clearly most notable work only with confidence "medium". Use -1 if none fits. confidence high = the evidence clearly singles one out.';
  const { out, cost: c1 } = await openai(QA_MODEL, [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ item: evidence(item, extra), candidates: list }) }], PICK, 200);
  cost += c1;
  const pick = out.index >= 0 && out.index < cands.length ? cands[out.index] : null;
  /* which work does the current poster show? */
  let current = byId;
  if (!current && posterBytes && cands.length > 1) {
    try {
      const content = [{ type: 'text', text: 'Image 0 is a poster on a watchlist. Images 1..N are official posters of different works with the same title. Which numbered official poster shows the SAME work as image 0 (same artwork, cast or design; language variants count)? Answer the number only when the artwork clearly matches; answer -1 if none matches or you are unsure.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${posterBytes.toString('base64')}`, detail: 'low' } }];
      for (const c of cands) content.push({ type: 'image_url', image_url: { url: `https://image.tmdb.org/t/p/w185${c.poster_path}`, detail: 'low' } });
      const { out: v, cost: c2 } = await openai(QA_MODEL, [{ role: 'user', content }], SEE, 20);
      cost += c2;
      if (v.index >= 1 && v.index <= cands.length) current = cands[v.index - 1];
    } catch { /* vision is best-effort */ }
  }
  /* none of the same-title works fits the evidence: the poster probably came from elsewhere (e.g. Wikipedia under a variant title); leave it */
  if (!pick) return { verdict: 'ok-unverified', pick: null, current, cands, cost, reason: out.reason };
  if (current && current.key === pick.key) return { verdict: 'ok', pick, current, cands, cost, reason: out.reason };
  if (out.confidence === 'high') return { verdict: 'fix', pick, current, cands, cost, reason: out.reason };
  /* not sure which work is meant: fine if the poster already shows the likely one, else ambiguous */
  if (!current && cands.length === 1) return { verdict: 'ok', pick, current, cands, cost, reason: out.reason };
  return { verdict: out.confidence === 'medium' && !current ? 'ok-unverified' : 'ambiguous', pick, current, cands, cost, reason: out.reason };
}

export const tmdbPosterUrl = (c) => `https://image.tmdb.org/t/p/w500${c.poster_path}`;
