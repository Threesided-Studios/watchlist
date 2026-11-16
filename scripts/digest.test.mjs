import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from './digest.mjs';

const now = new Date('2026-11-16T12:00:00Z');
const items = [
  { id: 'a', title: 'New Movie', type: 'movie', status: 'todo', added: '2026-11-14', poster: 'p.jpg', blurb: 'A film.' },
  { id: 'b', title: 'Old Movie', type: 'movie', status: 'todo', added: '2026-06-01', poster: 'p.jpg' },
  { id: 'c', title: 'Secret', type: 'anime', status: 'todo', added: '2026-11-15', adult: true },
  { id: 'd', title: 'Unreviewed', type: 'book', status: 'inbox', added: '2026-11-15' },
  { id: 'e', title: 'Airing Show', type: 'show', status: 'todo', added: '2026-01-01', next_air: '2026-11-18', providers: ['Hulu'] },
];

test('names new items by category, counts the inbox, lists what is coming', () => {
  const md = buildDigest(items, { now, pick: (xs) => xs[0] });
  assert.match(md, /\*\*1\*\* added in the last 7 days\. \*\*1\*\* waiting/);
  assert.match(md, /\*\*Movies\*\* \(1\): \[New Movie\]/);
  assert.match(md, /2026-11-18: \[Airing Show\].* on Hulu/);
  assert.match(md, /## One from the backlog/);
});

test('adult and inbox titles are never named (the repository is public)', () => {
  const md = buildDigest(items, { now });
  assert.ok(!md.includes('Secret'));
  assert.ok(!md.includes('Unreviewed'));
});
