import test from 'node:test';
import assert from 'node:assert/strict';
import { searchQuery, previewable, tileFor, ogImage } from './find-images.mjs';

test('search query names the kind of image wanted', () => {
  assert.equal(searchQuery({ title: 'Rance VI', type: 'game', year: 2004 }), 'Rance VI 2004 game cover art');
  assert.equal(searchQuery({ title: 'Thrice Forged', type: 'book', author: 'A. Writer', year: 2020 }), 'Thrice Forged A. Writer book cover');
  assert.equal(searchQuery({ title: 'Ton Shou', type: 'place', location: 'Las Vegas' }), 'Ton Shou Las Vegas exterior');
});

test('our own search-fallback links are not read for a preview image', () => {
  assert.equal(previewable('https://apps.apple.com/us/app/x/id1'), true);
  assert.equal(previewable('https://duckduckgo.com/?q=chili'), false);
  assert.equal(previewable('https://www.google.com/maps/search/Ton%20Shou'), false);
  assert.equal(previewable(''), false);
});

test('tileFor locates a coordinate inside its map tile', () => {
  const t = tileFor(36.1263, -115.1935, 16);
  /* the tile the rendered map for this spot (Spring Mountain Rd, Las Vegas) was checked against */
  assert.deepEqual([t.x, t.y], [11797, 25706]);
  assert.ok(t.fx >= 0 && t.fx < 1 && t.fy >= 0 && t.fy < 1);
});

test('ogImage reads either attribute order and resolves relative urls', () => {
  assert.equal(ogImage('<meta property="og:image" content="/a.png">', 'https://x.com/p'), 'https://x.com/a.png');
  assert.equal(ogImage('<meta content="https://y.com/b.jpg?a=1&amp;b=2" name="twitter:image">', 'https://x.com'), 'https://y.com/b.jpg?a=1&b=2');
  assert.equal(ogImage('<p>none</p>', 'https://x.com'), null);
});
