import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, applySort, facetCounts } from './filters.js';

const ITEMS = [
  { id: 'a', title: 'Severance', type: 'show', status: 'todo', blurb: 'office split memory', tags: ['Drama', 'Sci-Fi'], year: 2022, added: '2026-01-02' },
  { id: 'b', title: 'Hades II', type: 'game', status: 'done', blurb: 'roguelite', tags: ['Indie'], year: 2025, added: '2026-03-01', verdict: 'love', source: 'steam', hours: 40 },
  { id: 'c', title: 'Dune Pt 2', type: 'movie', status: 'todo', blurb: 'sand worms', tags: ['Sci-Fi'], year: 2024, added: '2026-02-01', recommended_by: 'Gabi' },
  { id: 'd', title: 'Untitled', type: 'movie', status: 'todo', tags: [] },
];
const ids = (xs) => xs.map((x) => x.id);

test('search matches title, blurb, tags and recommender; all words required', () => {
  assert.deepEqual(ids(applyFilters(ITEMS, { q: 'worm' })), ['c']);
  assert.deepEqual(ids(applyFilters(ITEMS, { q: 'sever' })), ['a']);
  assert.deepEqual(ids(applyFilters(ITEMS, { q: 'gabi' })), ['c']);
  assert.deepEqual(ids(applyFilters(ITEMS, { q: 'sci-fi office' })), ['a']);
});

test('a missing field never matches the word "undefined"', () => {
  assert.deepEqual(ids(applyFilters(ITEMS, { q: 'undefined' })), []);
});

test('type, status, verdict, source, tag, decade', () => {
  assert.deepEqual(ids(applyFilters(ITEMS, { type: 'game' })), ['b']);
  assert.deepEqual(ids(applyFilters(ITEMS, { status: 'todo' })), ['a', 'c', 'd']);
  assert.deepEqual(ids(applyFilters(ITEMS, { verdict: 'love' })), ['b']);
  assert.deepEqual(ids(applyFilters(ITEMS, { source: 'steam' })), ['b']);
  assert.deepEqual(ids(applyFilters(ITEMS, { tag: 'sci-fi' })), ['a', 'c']);
  assert.deepEqual(ids(applyFilters(ITEMS, { decade: '2020' })), ['a', 'b', 'c']);
});

test('stage uses the supplied function', () => {
  const stageOf = (it) => (it.verdict ? 'finished' : 'backlog');
  assert.deepEqual(ids(applyFilters(ITEMS, { stage: 'finished' }, stageOf)), ['b']);
});

test('sort: newest first by default, undated years last both ways', () => {
  assert.deepEqual(ids(applySort(ITEMS)), ['b', 'c', 'a', 'd']);
  assert.deepEqual(ids(applySort(ITEMS, 'year-desc')), ['b', 'c', 'a', 'd']);
  assert.deepEqual(ids(applySort(ITEMS, 'year-asc')), ['a', 'c', 'b', 'd']);
  assert.deepEqual(ids(applySort(ITEMS, 'title-asc')), ['c', 'b', 'a', 'd']);
});

test('facetCounts ranks by count then name', () => {
  assert.deepEqual(facetCounts(ITEMS, (it) => it.tags), [['Sci-Fi', 2], ['Drama', 1], ['Indie', 1]]);
  assert.deepEqual(facetCounts(ITEMS, (it) => it.type, 1), [['movie', 2]]);
});
