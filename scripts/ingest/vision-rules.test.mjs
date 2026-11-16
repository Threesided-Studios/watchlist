import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStatusV2, KEPT_ROLES, PARSE_SCHEMA, needsSecondRead, strongFirst, dropSelfNamed } from './vision.mjs';
import { pickForReprocess } from './reprocess.mjs';
import { repoSlug, pageUrl, fallbackLink } from './enrich-extra.mjs';

test('status: art puts media on the list, adult included; articles always wait', () => {
  assert.equal(decideStatusV2({ type: 'movie', confidence: 0.9 }, { poster: 'p.jpg' }), 'todo');
  assert.equal(decideStatusV2({ type: 'movie', confidence: 0.99 }, {}), 'inbox');
  assert.equal(decideStatusV2({ type: 'movie', adult: true }, { poster: 'p.jpg' }), 'todo');
  assert.equal(decideStatusV2({ type: 'anime', adult: true, confidence: 0.99 }, {}), 'inbox', 'no art yet: same rule as any title');
  assert.equal(decideStatusV2({ type: 'article', confidence: 0.99 }, { poster: 'p.jpg' }), 'inbox');
});

test('status: artless types need a confident, unambiguous read', () => {
  assert.equal(decideStatusV2({ type: 'place', confidence: 0.9, evidence: 'store_or_listing_page' }, {}), 'todo');
  assert.equal(decideStatusV2({ type: 'place', confidence: 0.7 }, {}), 'inbox');
  assert.equal(decideStatusV2({ type: 'recipe', confidence: 0.95, evidence: 'ambiguous' }, {}), 'inbox');
  assert.equal(decideStatusV2({ type: 'repo', confidence: 0.95 }, {}), 'inbox', 'an unmatched repo with no URL is a guess');
  assert.equal(decideStatusV2({ type: 'repo', confidence: 0.95 }, { matched: true }), 'todo');
});

test('a second, stronger read happens only when the first is unsure about something it would keep', () => {
  const item = (o) => ({ is_thing: true, role: 'subject', confidence: 0.95, evidence: 'poster_or_cover', ...o });
  assert.equal(needsSecondRead({ items: [item()] }), false);
  assert.equal(needsSecondRead({ items: [] }), true, 'triage said there was something; a blank read is not trusted');
  assert.equal(needsSecondRead({ items: [item({ confidence: 0.6 })] }), true);
  assert.equal(needsSecondRead({ items: [item({ evidence: 'ambiguous' })] }), true);
  assert.equal(needsSecondRead({ items: [item(), item({ confidence: 0.2, role: 'advertisement' })] }), false, 'unsure only about something it would not keep');
});

test('text-dense screenshots skip the cheap read', () => {
  assert.equal(strongFirst('recommendation_thread'), true);
  assert.equal(strongFirst('list_or_ranking'), true);
  assert.equal(strongFirst('media_page_or_poster'), false);
  assert.equal(strongFirst(''), false);
});

test('the site a screenshot is from is not the thing to save', () => {
  const page = { app: 'Goodreads', kind: 'media_page_or_poster', items: [{ title: 'Goodreads' }, { title: 'Dune' }] };
  assert.deepEqual(dropSelfNamed(page).items.map((t) => t.title), ['Dune']);
  const store = { app: 'Ice', kind: 'software_or_repo', items: [{ title: 'Ice' }] };
  assert.deepEqual(dropSelfNamed(store).items.map((t) => t.title), ['Ice'], 'a page about the app itself keeps it');
  assert.deepEqual(dropSelfNamed({ app: '', items: [{ title: 'X' }] }).items.length, 1);
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
