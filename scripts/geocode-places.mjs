#!/usr/bin/env node
/* Find a street address and coordinates for saved places that have none.
 *
 *   node scripts/geocode-places.mjs [--dry-run] [--all]
 *
 * A place read from a screenshot arrives as a name plus whatever location the
 * screenshot showed. Three cases, in order:
 *
 *   1. The location already is a street address ("7905 W Sahara Ave, Las Vegas"):
 *      geocode that address directly. Reliable.
 *   2. GOOGLE_PLACES_KEY is set: Google Places text search for "name, location".
 *      Best coverage of small businesses. Optional; costs per request.
 *   3. Otherwise two free services built on OpenStreetMap (Nominatim, then
 *      Photon). Coverage of small businesses is patchy, so a result is accepted
 *      only when its name agrees with ours, it lies in the city the screenshot
 *      named, and, if the screenshot gave cross streets or a neighbourhood, the
 *      address mentions one of them.
 *
 * A place with no stated location is left alone: a name alone matches
 * somewhere in the world.
 *
 * --all re-checks places that already have coordinates.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeKey } from './ingest/lib.mjs';

const UA = { 'user-agent': 'watchlist-geocode/1.0 (+https://github.com/Threesided-Studios/watchlist)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/* Same place? Their name keys are equal, or every word of the shorter one appears in the longer. */
export function sameName(ours, theirs) {
  const a = placeKey(ours) || norm(ours).replace(/ /g, '-'), b = placeKey(theirs) || norm(theirs).replace(/ /g, '-');
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a.split('-'), new Set(b.split('-'))] : [b.split('-'), new Set(a.split('-'))];
  return s.length >= 1 && s.join('').length >= 4 && s.every((w) => l.has(w));
}

/* The city-ish words of the stated location: the last comma part that is not a state or country. */
const REGION = new Set(['nevada', 'nv', 'california', 'ca', 'usa', 'us', 'united states', 'arizona', 'az', 'utah', 'ut', 'texas', 'tx', 'new york', 'ny']);
const HAS_NUMBER = /[0-9]/;
export function cityOf(location) {
  /* comma or semicolon parts; drop states/countries and anything with a street number in it */
  const parts = String(location || '').split(/[,;]/).map((p) => norm(p)).filter(Boolean).filter((p) => !REGION.has(p) && !HAS_NUMBER.test(p));
  return parts.length ? parts[parts.length - 1] : '';
}
export const inCity = (city, haystack) => !!city && norm(haystack).includes(city);

/* Words of the stated location beyond the city: cross streets, a neighbourhood, a venue. */
const FILLER = new Set(['and', 'at', 'near', 'the', 'of', 'in', 'on', 'st', 'street', 'ave', 'avenue', 'rd', 'road', 'blvd', 'dr', 'n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);
export function hintWords(location) {
  const city = cityOf(location);
  return norm(location).split(' ').filter((w) => w.length > 2 && !FILLER.has(w) && !REGION.has(w) && !city.split(' ').includes(w) && !/^\d+$/.test(w));
}
/* "7905 W Sahara Ave, Las Vegas, NV" -> a one-line address; null when the location has no street number */
const STREET = /[0-9]{2,6} +[A-Za-z0-9.]+( +[A-Za-z.]+){1,4}/;
export function streetAddress(location) {
  const parts = String(location || '').split(/[,;]/).map((x) => x.trim().replace(/[.]$/, '')).filter(Boolean);
  const i = parts.findIndex((x) => STREET.test(x));
  if (i < 0) return null;
  /* street first, then the rest in their original order */
  return [parts[i], ...parts.filter((_, j) => j !== i)].join(', ');
}

/* Pure: pick the candidate that is this place, or null. cand: {name, address, city, lat, lon, kind, website} */
export function pickPlace(item, cands) {
  const city = cityOf(item.location);
  if (!city) return null;
  const hints = hintWords(item.location);
  return cands.find((c) => c.name && sameName(item.title, c.name) && inCity(city, `${c.city} ${c.address}`)
    && (!hints.length || hints.some((h) => norm(c.address).includes(h)))) || null;
}

export function placeFields(c) {
  const out = { lat: Number(Number(c.lat).toFixed(6)), lon: Number(Number(c.lon).toFixed(6)) };
  if (c.address) out.address = c.address;
  out.map_url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([c.name, c.address].filter(Boolean).join(', '))}`;
  if (c.website) out.website = c.website;
  if (c.kind) out.place_kind = c.kind;
  return out;
}

async function get(url) {
  try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) }); return r.ok ? await r.json() : null; } catch { return null; }
}
const street = (a) => [[a.house_number || a.housenumber, a.road || a.street].filter(Boolean).join(' '), a.city || a.town || a.village, a.state, a.postcode].filter(Boolean).join(', ');

async function nominatim(item) {
  const j = await get(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: `${item.title}, ${item.location}`, format: 'jsonv2', limit: '5', addressdetails: '1', extratags: '1' })}`);
  return (j || []).map((p) => ({ name: p.name, address: street(p.address || {}), city: `${p.address?.city || p.address?.town || ''} ${p.display_name}`, lat: p.lat, lon: p.lon,
    kind: String(p.type || '').replace(/_/g, ' '), website: p.extratags?.website || p.extratags?.['contact:website'] || '' }));
}
async function photon(item) {
  const j = await get(`https://photon.komoot.io/api/?${new URLSearchParams({ q: `${item.title} ${cityOf(item.location)}`, limit: '6', lang: 'en' })}`);
  return (j?.features || []).map((f) => { const p = f.properties || {}; return { name: p.name, address: street(p), city: `${p.city || ''} ${p.county || ''} ${p.district || ''}`,
    lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], kind: String(p.osm_value || '').replace(/_/g, ' '), website: '' }; });
}

/* Case 1: the screenshot showed a street address. The US Census geocoder resolves house
   numbers (free, no key, US only); OpenStreetMap often only knows the street. */
async function byAddress(item) {
  const addr = streetAddress(item.location);
  if (!addr) return null;
  const j = await get(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({ address: addr, benchmark: 'Public_AR_Current', format: 'json' })}`);
  const m = j?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  const tidy = String(m.matchedAddress || addr).toLowerCase().replace(/(^|[ ,])([a-z])/g, (x, pre, ch) => pre + ch.toUpperCase()).replace(/, ([A-Za-z]{2}), /, (x, st) => `, ${st.toUpperCase()} `);
  return { name: item.title, address: tidy, lat: m.coordinates.y, lon: m.coordinates.x };
}

/* Case 2: Google Places (New) text search. Only with a key. */
async function googlePlaces(item) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.websiteUri,places.googleMapsUri,places.primaryTypeDisplayName' },
      body: JSON.stringify({ textQuery: `${item.title}, ${item.location}`, maxResultCount: 3 }),
    });
    if (!r.ok) return null;
    const cands = ((await r.json()).places || []).map((p) => ({ name: p.displayName?.text, address: p.formattedAddress || '', city: p.formattedAddress || '', lat: p.location?.latitude, lon: p.location?.longitude,
      kind: p.primaryTypeDisplayName?.text || '', website: p.websiteUri || '', maps: p.googleMapsUri || '' }));
    const hit = cands.find((c) => c.name && sameName(item.title, c.name) && inCity(cityOf(item.location), c.address));
    return hit || null;
  } catch { return null; }
}

/* Used by the ingest too: returns the fields to add to a place, or null. */
export async function geocode(item) {
  if (!cityOf(item.location)) return null;
  const direct = await byAddress(item);
  if (direct) return { ...placeFields(direct), geocoded_via: 'address' };
  await sleep(1100);
  const g = await googlePlaces(item);
  if (g) return { ...placeFields(g), ...(g.maps ? { map_url: g.maps } : {}), geocoded_via: 'google' };
  for (const source of [nominatim, photon]) {
    const hit = pickPlace(item, await source(item));
    if (hit && hit.lat && hit.lon) return { ...placeFields(hit), geocoded_via: source.name };
    await sleep(1100);   // both services ask for about one request a second
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const DATA = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'data.json');
  const DRY = process.argv.includes('--dry-run'), ALL = process.argv.includes('--all');
  const items = JSON.parse(readFileSync(DATA, 'utf8'));
  const todo = items.filter((it) => it.type === 'place' && it.status !== 'dismissed' && (ALL || !it.lat));
  let found = 0;
  for (const it of todo) {
    const g = await geocode(it);
    if (g) { found++; Object.assign(it, g); console.log(` + ${it.title} -> ${g.address || '(coordinates only)'} [${g.geocoded_via}]`); }
    else console.log(` - ${it.title} (${it.location || 'no location'})`);
  }
  console.log(JSON.stringify({ places: todo.length, found }));
  if (found && !DRY) writeFileSync(DATA, JSON.stringify(items, null, 2));
}
