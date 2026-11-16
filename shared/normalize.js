/* Brings items up to the current data shape. Pure and idempotent: running it
 * on already-normalised data changes nothing, so it is safe to run on every
 * ingest and on every site build.
 *
 *   - type aliases (venue -> place, purchase -> product)
 *   - anime gets its own type (was: show/movie tagged "Anime"), keeping film vs series in `format`
 *   - software that was matched to a GitHub repository becomes type repo
 *   - tags: one spelling per genre, compound TMDB genres split
 *   - provenance left by the retired OCR pipeline moves out of the item
 */
import { canonicalType, normalizeTags } from './taxonomy.js';

export const LEGACY_FIELDS = ['ocr_excerpt', 'source_screenshot', 'confidence', 'recovered'];
const GITHUB_REPO = /^https?:\/\/(www\.)?(github\.com|gitlab\.com|codeberg\.org)\/[^/]+\/[^/]+/i;

export function normalizeItem(item) {
  const it = { ...item };
  const changes = [];
  const provenance = {};

  let type = canonicalType(it.type);
  const hadAnimeTag = (it.tags || []).some((t) => String(t).toLowerCase() === 'anime');
  if (hadAnimeTag && (type === 'show' || type === 'movie')) {
    it.format = type === 'movie' ? 'film' : 'series';
    type = 'anime';
  }
  if (type === 'software' && (it.enriched_via === 'GitHub' || it.art_via === 'GitHub' || GITHUB_REPO.test(it.link || ''))) {
    type = 'repo';
  }
  if (type === 'repo' && !it.repo_url && GITHUB_REPO.test(it.link || '')) it.repo_url = it.link;
  if (type !== it.type) { changes.push(`type ${it.type || '(none)'} -> ${type}`); it.type = type; }

  let tags = normalizeTags(it.tags);
  if (type === 'anime') tags = tags.filter((t) => t !== 'Anime');   // the type says it now
  if (JSON.stringify(tags) !== JSON.stringify(it.tags || [])) { changes.push('tags'); it.tags = tags; }

  for (const f of LEGACY_FIELDS) {
    if (f in it) { provenance[f] = it[f]; delete it[f]; }
  }
  if (Object.keys(provenance).length) changes.push('provenance');

  return { item: it, changes, provenance };
}

export function normalizeItems(items) {
  const out = [];
  const provenance = {};
  const counts = {};
  let changed = 0;
  for (const raw of items) {
    const r = normalizeItem(raw);
    out.push(r.item);
    if (r.changes.length) changed++;
    for (const c of r.changes) { const k = c.startsWith('type ') ? c : c; counts[k] = (counts[k] || 0) + 1; }
    if (Object.keys(r.provenance).length) provenance[raw.id] = r.provenance;
  }
  return { items: out, provenance, changed, counts };
}
