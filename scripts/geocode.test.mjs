import test from 'node:test';
import assert from 'node:assert/strict';
import { sameName, cityOf, hintWords, streetAddress, pickPlace, placeFields } from './geocode-places.mjs';

test('location parsing: city, cross-street hints, street address', () => {
  assert.equal(cityOf('7905 W Sahara Ave, Las Vegas, Nevada'), 'las vegas');
  assert.equal(cityOf('Henderson, NV; 366 Milan St.'), 'henderson');
  assert.deepEqual(hintWords('Tropicana and Eastern, Las Vegas'), ['tropicana', 'eastern']);
  assert.equal(streetAddress('Henderson, NV; 366 Milan St.'), '366 Milan St, Henderson, NV');
  assert.equal(streetAddress('Tropicana and Eastern, Las Vegas'), null);
  assert.equal(cityOf(''), '');
});

test('names match loosely but not across different places', () => {
  assert.ok(sameName('Fat Boys', 'Fat Boys Burgers'));
  assert.ok(sameName('The Habit Burger Grill', 'The Habit'));
  assert.ok(!sameName('The Hat', 'The Habit Burger Grill'));
});

test('a match must be in the stated city and agree with stated cross streets', () => {
  const item = { title: 'Dispensary Lounge', location: 'Tropicana and Eastern, Las Vegas' };
  const elsewhere = { name: 'Dispensary Lounge', address: '823 South 3rd Street, Las Vegas, Nevada', city: 'Las Vegas', lat: 1, lon: 2 };
  const right = { name: 'Dispensary Lounge', address: '2451 East Tropicana Avenue, Las Vegas, Nevada', city: 'Las Vegas', lat: 3, lon: 4 };
  assert.equal(pickPlace(item, [elsewhere]), null);
  assert.equal(pickPlace(item, [elsewhere, right]), right);
  assert.equal(pickPlace({ title: 'Dispensary Lounge', location: 'Reno' }, [right]), null);
  assert.equal(pickPlace({ title: 'Dispensary Lounge' }, [right]), null, 'no stated location: never guess');
});

test('placeFields builds a maps link from name and address', () => {
  const f = placeFields({ name: 'Ton Shou', address: '4049 Spring Mountain Rd, Las Vegas, NV 89102', lat: '36.1263219', lon: '-115.1935001' });
  assert.equal(f.lat, 36.126322);
  assert.match(f.map_url, /google\.com\/maps\/search\/\?api=1&query=Ton%20Shou/);
});
