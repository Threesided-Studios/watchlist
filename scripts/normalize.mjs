#!/usr/bin/env node
/* Rewrite data.json in the current data shape (see shared/normalize.js).
 *
 *   node scripts/normalize.mjs            apply; prints what changed
 *   node scripts/normalize.mjs --dry-run  report only
 *
 * Idempotent. The ingest workflow runs it before every commit, so items added
 * by any path end up in the same shape.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeItems } from '../shared/normalize.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data.json');
const PROV = join(ROOT, 'data', 'provenance.json');
const DRY = process.argv.includes('--dry-run');

const tally = (items) => items.reduce((o, it) => ({ ...o, [it.type || '(none)']: (o[it.type || '(none)'] || 0) + 1 }), {});

const before = JSON.parse(readFileSync(DATA, 'utf8'));
const { items, provenance, changed, counts } = normalizeItems(before);

if (items.length !== before.length) throw new Error(`item count changed: ${before.length} -> ${items.length}`);
if (items.some((it, i) => it.id !== before[i].id)) throw new Error('an item id or the item order changed');

console.log(JSON.stringify({ items: items.length, changed, before: tally(before), after: tally(items), changes: counts }, null, 1));

if (!DRY && changed) {
  writeFileSync(DATA, JSON.stringify(items, null, 2));
  if (Object.keys(provenance).length) {
    const prev = existsSync(PROV) ? JSON.parse(readFileSync(PROV, 'utf8')) : {};
    for (const [id, p] of Object.entries(provenance)) prev[id] = { ...(prev[id] || {}), ...p };
    mkdirSync(dirname(PROV), { recursive: true });
    writeFileSync(PROV, JSON.stringify(prev, null, 1));
  }
  console.log('data.json rewritten');
} else {
  console.log(DRY ? 'dry run: nothing written' : 'already normalised');
}
