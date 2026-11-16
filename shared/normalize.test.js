import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, normalizeItems } from './normalize.js';
import { normalizeTags, canonicalType, category, statusLabel } from './taxonomy.js';

test('anime-tagged shows and movies become type anime and keep film vs series', () => {
  const s = normalizeItem({ id: 'a', type: 'show', tags: ['Anime', 'fantasy'] }).item;
  assert.deepEqual([s.type, s.format, s.tags], ['anime', 'series', ['Fantasy']]);
  const m = normalizeItem({ id: 'b', type: 'movie', tags: ['anime'] }).item;
  assert.deepEqual([m.type, m.format, m.tags], ['anime', 'film', []]);
  assert.equal(normalizeItem({ id: 'g', type: 'game', tags: ['Anime'] }).item.type, 'game');
});

test('software matched to a repository becomes a repo', () => {
  const r = normalizeItem({ id: 'x', type: 'software', enriched_via: 'GitHub', link: 'https://github.com/jordanbaird/Ice', tags: [] }).item;
  assert.equal(r.type, 'repo');
  assert.equal(r.repo_url, 'https://github.com/jordanbaird/Ice');
  assert.equal(normalizeItem({ id: 'y', type: 'software', enriched_via: 'AppStore', tags: [] }).item.type, 'software');
});

test('tags: one spelling, compounds split, acronyms kept', () => {
  assert.deepEqual(normalizeTags(['fantasy', 'Fantasy', 'Sci-Fi & Fantasy', 'PS3', 'LitRPG', 'slice of life', 'sci-fi']),
    ['Fantasy', 'Sci-Fi', 'PS3', 'LitRPG', 'Slice of Life']);
});

test('legacy OCR fields move to provenance', () => {
  const { items, provenance } = normalizeItems([{ id: 'a', type: 'movie', tags: [], ocr_excerpt: 'raw', confidence: 0.4 }]);
  assert.deepEqual(items[0], { id: 'a', type: 'movie', tags: [] });
  assert.deepEqual(provenance, { a: { ocr_excerpt: 'raw', confidence: 0.4 } });
});

test('idempotent', () => {
  const once = normalizeItems([{ id: 'a', type: 'show', tags: ['Anime', 'action & adventure'] }, { id: 'b', type: 'venue', tags: [] }]);
  const twice = normalizeItems(once.items);
  assert.equal(twice.changed, 0);
  assert.deepEqual(twice.items, once.items);
});

test('taxonomy lookups', () => {
  assert.equal(canonicalType('venue'), 'place');
  assert.equal(canonicalType('nonsense'), 'other');
  assert.equal(category('repo').slug, 'repos');
  assert.equal(statusLabel('book', 'todo'), 'to read');
  assert.equal(statusLabel('place', 'done'), 'visited');
});
