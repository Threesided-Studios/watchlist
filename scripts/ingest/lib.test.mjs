import test from 'node:test';
import assert from 'node:assert/strict';
import { placeKey, titleKey, buildIndex, findDuplicate, uniqueId, decideStatus, costOf, lookupType, setScreenKind, tmdbKind } from './lib.mjs';

test('titleKey normalises articles, years and punctuation', () => {
  assert.equal(titleKey('The Killing'), 'killing');
  assert.equal(titleKey('Status Update (2018)'), 'status-update');
  assert.equal(titleKey('Mr. & Mrs. Smith'), 'mr-and-mrs-smith');
});

test('dedupe treats movie/show as one family, books separately', () => {
  const idx = buildIndex([{ id: 'x', title: 'Shrinking', type: 'show' }, { id: 'y', title: 'Dune', type: 'book' }]);
  assert.equal(findDuplicate(idx, { title: 'shrinking', type: 'movie' }), 'x');
  assert.equal(findDuplicate(idx, { title: 'Dune', type: 'movie' }), null);
  assert.equal(findDuplicate(idx, { title: 'Dune', type: 'book' }), 'y');
});

test('anime dedupes against show/movie, and repo against software', () => {
  const idx = buildIndex([{ id: 'a', title: 'Frieren', type: 'anime', format: 'series' }, { id: 'r', title: 'Ice', type: 'repo' }]);
  assert.equal(findDuplicate(idx, { title: 'Frieren', type: 'show' }), 'a');
  assert.equal(findDuplicate(idx, { title: 'Frieren', type: 'movie' }), 'a');
  assert.equal(findDuplicate(idx, { title: 'Ice', type: 'software' }), 'r');
  assert.equal(findDuplicate(idx, { title: 'Ice', type: 'game' }), null);
});

test('anime keeps its type when a TMDB kind is recorded', () => {
  const film = { type: 'anime', format: 'series' };
  setScreenKind(film, 'movie');
  assert.deepEqual(film, { type: 'anime', format: 'film' });
  assert.equal(tmdbKind(film), 'movie');
  assert.equal(lookupType(film), 'movie');
  assert.equal(lookupType({ type: 'anime' }), 'show');
  assert.equal(lookupType({ type: 'repo' }), 'software');
  const show = { type: 'movie' };
  setScreenKind(show, 'tv');
  assert.equal(show.type, 'show');
});

test('placeKey joins loose spellings of one place and refuses thin names', () => {
  assert.equal(placeKey('Black Label Burgers'), placeKey('Black Label Burger Company'));
  assert.equal(placeKey('Wigglin Out Indoor Playground'), placeKey('Wigglin’ Out'));
  assert.notEqual(placeKey('The Hat'), placeKey('The Habit Burger Grill'));
  assert.equal(placeKey('The Bar'), null);
});

test('dismissed items do not block nor match', () => {
  const idx = buildIndex([{ id: 'x', title: 'Foo', type: 'movie', status: 'dismissed' }]);
  assert.equal(findDuplicate(idx, { title: 'Foo', type: 'movie' }), null);
});

test('uniqueId adds year then counter', () => {
  const taken = new Set(['dune', 'dune-2021']);
  assert.equal(uniqueId('Dune', taken, 2021), 'dune-2');
  assert.equal(uniqueId('Dune', new Set(['dune']), 1984), 'dune-1984');
});

test('decideStatus', () => {
  assert.equal(decideStatus({ confidence: 0.9 }, { enriched: true }), 'todo');
  assert.equal(decideStatus({ confidence: 0.9 }, { enriched: false }), 'inbox');
  assert.equal(decideStatus({ confidence: 0.5 }, { enriched: true }), 'inbox');
});

test('costOf', () => {
  assert.ok(Math.abs(costOf('gpt-4.1-mini', { prompt_tokens: 1e6, completion_tokens: 0 }) - 0.4) < 1e-9);
});
