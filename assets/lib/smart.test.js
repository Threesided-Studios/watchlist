import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, matchesParsed } from './smart.js';

const P = { providers: ['Netflix', 'Amazon Prime Video', 'Crunchyroll', 'Max'] };

test('lifts kind, service, length, era and state out of a sentence', () => {
  const r = parseQuery("short anime on crunchyroll from the 2010s i haven't watched", P);
  assert.deepEqual([r.type, r.on, r.maxRuntime, r.yearFrom, r.yearTo, r.stage, r.text], ['anime', 'Crunchyroll', 100, 2010, 2019, 'backlog', '']);
});

test('keeps real search words as text', () => {
  const r = parseQuery('heist movies under 2 hours', P);
  assert.deepEqual([r.type, r.maxRuntime, r.text], ['movie', 120, 'heist']);
  assert.equal(parseQuery('dune', P).text, 'dune');
  assert.deepEqual(parseQuery('dune', P).notes, []);
});

test('service names with and without "on", including short forms', () => {
  assert.equal(parseQuery('something funny on netflix', P).on, 'Netflix');
  assert.equal(parseQuery('prime thrillers', P).on, 'Amazon Prime Video');
  assert.equal(parseQuery('max', P).on, 'Max');
  assert.equal(parseQuery('maximum overdrive', P).on, undefined);
});

test('years and decades', () => {
  assert.deepEqual([parseQuery('80s movies').yearFrom, parseQuery('80s movies').yearTo], [1980, 1989]);
  assert.equal(parseQuery('games after 2015').yearFrom, 2016);
  assert.equal(parseQuery('books before 1990').yearTo, 1989);
  assert.deepEqual([parseQuery('movies from 1999').yearFrom, parseQuery('movies from 1999').yearTo], [1999, 1999]);
});

test('state words', () => {
  assert.equal(parseQuery('finished games').stage, 'finished');
  assert.equal(parseQuery('loved books').verdict, 'love');
  assert.equal(parseQuery('what am i watching').stage, 'active');
});

test('matchesParsed needs the fact to be known', () => {
  assert.equal(matchesParsed({ runtime: 90, year: 2012 }, { maxRuntime: 100, yearFrom: 2010, yearTo: 2019 }), true);
  assert.equal(matchesParsed({ year: 2012 }, { maxRuntime: 100 }), false, 'unknown runtime is not "short"');
  assert.equal(matchesParsed({ runtime: 90 }, { yearFrom: 2010 }), false);
});
