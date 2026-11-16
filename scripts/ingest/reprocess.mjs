#!/usr/bin/env node
/* Let screenshots that produced nothing be read again.
 *
 *   node reprocess.mjs [--days 16] [--dry-run]
 *
 * The images themselves were deleted after they were first read, so they have
 * to come from the phone again. This clears the two places that would stop
 * that: the Worker's "already seen" record (so the upload is accepted) and the
 * ledger entry (so the reader does not skip it). Then re-send from the phone:
 * run the Backfill Shortcut over the same number of days.
 *
 * env: WATCHLIST_QUEUE_URL, WATCHLIST_QUEUE_KEY
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Pure: which ledger entries to forget. Only screenshots that added nothing. */
export function pickForReprocess(ledger, days, now = Date.now()) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  return Object.entries(ledger.shots || {}).filter(([, s]) => s.at >= cutoff && !(s.ids || []).length && s.outcome !== 'parsed').map(([sha]) => sha);
}

if (process.argv[1] && process.argv[1].endsWith('reprocess.mjs')) {
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--days');
  const days = di >= 0 ? Number(argv[di + 1]) : 16;
  const DRY = argv.includes('--dry-run');
  const LEDGER = join(dirname(fileURLToPath(import.meta.url)), 'ledger.json');
  const QURL = (process.env.WATCHLIST_QUEUE_URL || 'https://watchlist-ingest.threesided.workers.dev').replace(/\/$/, '');
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const shas = pickForReprocess(ledger, days);
  console.log(`${shas.length} screenshot(s) from the last ${days} days produced nothing and can be read again`);
  if (DRY || !shas.length) process.exit(0);
  if (!process.env.WATCHLIST_QUEUE_KEY) { console.error('WATCHLIST_QUEUE_KEY missing'); process.exit(1); }
  const r = await fetch(`${QURL}/queue/forget`, { method: 'POST', headers: { 'X-Queue-Key': process.env.WATCHLIST_QUEUE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ shas }) });
  if (!r.ok) { console.error('forget failed', r.status); process.exit(1); }
  console.log('worker:', JSON.stringify(await r.json()));
  for (const sha of shas) { delete ledger.shots[sha]; if (ledger.errors) delete ledger.errors[sha]; }
  ledger.totals.shots = Math.max(0, (ledger.totals.shots || 0) - shas.length);
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
}
