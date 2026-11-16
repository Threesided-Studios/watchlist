import test from 'node:test';
import assert from 'node:assert/strict';
import { screenFacts, repoFacts, applyFacts } from './refresh.mjs';
import { starsToItems } from './import-github-stars.mjs';
import { seriesOf } from '../shared/series.js';

test('tv: providers deduped, next episode only when still ahead', () => {
  const d = { episode_run_time: [45], in_production: true, next_episode_to_air: { air_date: '2026-12-01' },
    'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'Netflix Standard with Ads' }, { provider_name: 'Max' }] } } } };
  assert.deepEqual(screenFacts('tv', d, '2026-11-16'), { providers: ['Netflix', 'Max'], runtime: 45, next_air: '2026-12-01', airing: true });
  assert.equal(screenFacts('tv', { next_episode_to_air: { air_date: '2026-01-01' } }, '2026-11-16').next_air, null);
});

test('movie: a release date counts as upcoming only while it is in the future', () => {
  assert.equal(screenFacts('movie', { runtime: 120, release_date: '2027-03-01' }, '2026-11-16').next_air, '2027-03-01');
  assert.equal(screenFacts('movie', { runtime: 120, release_date: '1999-03-31' }, '2026-11-16').next_air, null);
});

test('repo: a new release is stamped, the first sighting is not', () => {
  const r = { stargazers_count: 10, pushed_at: '2026-11-10T00:00:00Z', archived: false, language: 'Swift' };
  assert.equal(repoFacts(r, 'v2', { release: 'v1' }, '2026-11-16').release_at, '2026-11-16');
  assert.equal(repoFacts(r, 'v1', {}, '2026-11-16').release_at, null);
  assert.equal(repoFacts(r, 'v1', { release: 'v1', release_at: '2026-10-01' }, '2026-11-16').release_at, '2026-10-01');
});

test('applyFacts sets, clears and reports change', () => {
  const it = { id: 'a', providers: ['Hulu'], next_air: '2026-01-01' };
  assert.equal(applyFacts(it, { providers: ['Hulu'], next_air: null, runtime: 50 }), true);
  assert.deepEqual(it, { id: 'a', providers: ['Hulu'], runtime: 50 });
  assert.equal(applyFacts(it, { providers: ['Hulu'], runtime: 50, airing: null }), false);
});

test('stars import skips what is already on the list, by url or name', () => {
  const rows = [
    { starred_at: '2026-05-01T00:00:00Z', repo: { full_name: 'a/ice', name: 'Ice', html_url: 'https://github.com/a/Ice', stargazers_count: 5, owner: { login: 'a' }, topics: ['macos'] } },
    { repo: { full_name: 'b/new-thing', name: 'new-thing', html_url: 'https://github.com/b/new-thing', stargazers_count: 9, language: 'Go', owner: { login: 'b' }, description: 'x' } },
    { repo: { full_name: 'c/known', name: 'known', html_url: 'https://github.com/c/known', owner: { login: 'c' } } },
  ];
  const have = [{ id: 'ice', title: 'Ice', type: 'software' }, { id: 'k', title: 'Other', type: 'repo', repo_url: 'https://github.com/c/known/' }];
  const out = starsToItems(rows, have);
  assert.deepEqual(out.map((x) => [x.id, x.type, x.source, x.stars, x.language]), [['new-thing', 'repo', 'github-stars', 9, 'Go']]);
});

test('seriesOf reads explicit markers only', () => {
  assert.deepEqual(seriesOf("Knife of Dreams: Book Eleven of 'The Wheel of Time'"), { name: 'Wheel of Time', key: 'wheel-of-time', n: 11 });
  assert.deepEqual(seriesOf('A Dance of Cloaks (Shadowdance Series Book 1)'), { name: 'Shadowdance', key: 'shadowdance', n: 1 });
  assert.equal(seriesOf('Aboxageddon (Everybody Loves Large Chests Vol.13)').n, 13);
  assert.equal(seriesOf('Dune'), null);
  assert.equal(seriesOf('The Book of Three'), null);
});
