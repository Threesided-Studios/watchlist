import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from './apply-edits.mjs';

const ITEMS = [
  { id: 'dune', title: 'Dune', type: 'movie', status: 'todo', tags: ['Sci-Fi'], year: 2021 },
  { id: 'hades', title: 'Hades', type: 'game', status: 'todo', tags: [], poster: 'posters/hades.jpg', source: 'steam' },
];
const opts = { today: '2026-11-16' };

test('set changes only whitelisted, valid fields and stamps updated', () => {
  const r = applyEdits(ITEMS, [{ id: 'dune', op: 'set', fields: { verdict: 'love', status: 'done', tags: ['sci-fi', 'epic'], id: 'hacked', poster: 'x', status_bogus: 1 } }], opts);
  const d = r.items[0];
  assert.deepEqual([d.id, d.verdict, d.status, d.tags, d.updated, d.poster], ['dune', 'love', 'done', ['Sci-Fi', 'Epic'], '2026-11-16', undefined]);
  assert.equal(r.changed, true);
  assert.equal(ITEMS[0].verdict, undefined, 'input is not mutated');
});

test('invalid values are ignored; clearing a verdict works', () => {
  const r = applyEdits([{ ...ITEMS[0], verdict: 'up' }], [{ id: 'dune', op: 'set', fields: { status: 'nonsense', link: 'javascript:alert(1)', verdict: null, title: '  ' } }], opts);
  assert.deepEqual([r.items[0].status, r.items[0].link, r.items[0].verdict, r.items[0].title], ['todo', undefined, null, 'Dune']);
});

test('an edit that changes nothing does not mark the data changed', () => {
  const r = applyEdits(ITEMS, [{ id: 'dune', op: 'set', fields: { status: 'todo' } }, { id: 'ghost', op: 'set', fields: { status: 'done' } }], opts);
  assert.equal(r.changed, false);
  assert.equal(r.items[0].updated, undefined);
});

test('add creates a full item, keeps the client id, queues its cover', () => {
  const r = applyEdits(ITEMS, [{ id: 'severance', op: 'add', fields: { title: 'Severance', type: 'show', year: '2022', link: 'https://www.themoviedb.org/tv/95396', poster_url: 'https://image.tmdb.org/t/p/w500/x.jpg', tmdb_id: 95396 } }], opts);
  const s = r.items.at(-1);
  assert.deepEqual([s.id, s.type, s.year, s.status, s.added, s.source, s.tmdb_id], ['severance', 'show', 2022, 'todo', '2026-11-16', 'manual', 95396]);
  assert.deepEqual(r.posters, [{ id: 'severance', url: 'https://image.tmdb.org/t/p/w500/x.jpg' }]);
});

test('add then set in the same batch; re-sent add is skipped', () => {
  const add = { id: 'andor', op: 'add', fields: { title: 'Andor', type: 'show' } };
  const r = applyEdits(ITEMS, [add, { id: 'andor', op: 'set', fields: { status: 'active' } }, add], opts);
  assert.equal(r.items.filter((x) => x.id === 'andor').length, 1);
  assert.equal(r.items.at(-1).status, 'active');
});

test('delete removes the item and records it so ingest will not re-add it', () => {
  const r = applyEdits(ITEMS, [{ id: 'hades', op: 'delete' }], opts);
  assert.deepEqual(r.items.map((x) => x.id), ['dune']);
  assert.deepEqual(r.dismissed, ['game:hades']);
  assert.equal(r.removed[0].id, 'hades');
});
