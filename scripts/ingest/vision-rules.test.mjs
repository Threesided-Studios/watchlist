import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStatusV2, KEPT_ROLES, PARSE_SCHEMA } from './vision.mjs';
import { pickForReprocess } from './reprocess.mjs';
import { repoSlug, pageUrl, fallbackLink } from './enrich-extra.mjs';

test('status: art puts media on the list; adult and articles always wait', () => {
  assert.equal(decideStatusV2({ type: 'movie', confidence: 0.9 }, { poster: 'p.jpg' }), 'todo');
  assert.equal(decideStatusV2({ type: 'movie', confidence: 0.99 }, {}), 'inbox');
  assert.equal(decideStatusV2({ type: 'movie', adult: true }, { poster: 'p.jpg' }), 'inbox');
  assert.equal(decideStatusV2({ type: 'article', confidence: 0.99 }, { poster: 'p.jpg' }), 'inbox');
});

test('status: artless types need a confident, unambiguous read', () => {
  assert.equal(decideStatusV2({ type: 'place', confidence: 0.9, evidence: 'store_or_listing_page' }, {}), 'todo');
  assert.equal(decideStatusV2({ type: 'place', confidence: 0.7 }, {}), 'inbox');
  assert.equal(decideStatusV2({ type: 'recipe', confidence: 0.95, evidence: 'ambiguous' }, {}), 'inbox');
  assert.equal(decideStatusV2({ type: 'repo', confidence: 0.95 }, {}), 'inbox', 'an unmatched repo with no URL is a guess');
  assert.equal(decideStatusV2({ type: 'repo', confidence: 0.95 }, { matched: true }), 'todo');
});

test('only subjects and recommendations are kept', () => {
  assert.deepEqual([...KEPT_ROLES].sort(), ['recommended', 'subject']);
  assert.ok(PARSE_SCHEMA.properties.items.items.required.includes('role'));
});

test('repo slug and page url parsing', () => {
  assert.equal(repoSlug({ url: 'github.com/jordanbaird/Ice' }), 'jordanbaird/Ice');
  assert.equal(repoSlug({ title: 'dream-num/univer' }), 'dream-num/univer');
  assert.equal(repoSlug({ title: 'Ice' }), null);
  assert.equal(pageUrl({ url: 'seriouseats.com/the-best-chili-recipe' }), 'https://seriouseats.com/the-best-chili-recipe');
  assert.equal(pageUrl({ url: 'not a url' }), null);
  assert.match(fallbackLink({ type: 'podcast', title: 'Radiolab' }), /open\.spotify\.com\/search/);
});

test('reprocess picks only recent screenshots that added nothing', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  const ledger = { shots: {
    a: { at: '2026-11-10T00:00:00Z', outcome: 'not-media', ids: [] },
    b: { at: '2026-11-10T00:00:00Z', outcome: 'parsed', ids: ['dune'] },
    c: { at: '2026-09-01T00:00:00Z', outcome: 'not-media', ids: [] },
    d: { at: '2026-11-12T00:00:00Z', outcome: 'no-titles', ids: [] },
  } };
  assert.deepEqual(pickForReprocess(ledger, 16, now), ['a', 'd']);
});
