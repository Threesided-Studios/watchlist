#!/usr/bin/env node
/* Weekly digest of the list, as Markdown on stdout.
 *
 *   node scripts/digest.mjs [--days 7]
 *
 * The digest workflow posts it as a GitHub issue, which GitHub emails to
 * anyone watching the repository: no mail service or extra credentials.
 * The repository is public, so adult and unreviewed (inbox) titles are counted
 * but never named.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, category } from '../shared/taxonomy.js';

const SITE = 'https://watch.threesided.com';
const link = (it) => `[${String(it.title).replace(/[[\]]/g, '')}](${SITE}/all/#item=${encodeURIComponent(it.id)})`;

/* Pure: items + "today" -> markdown */
export function buildDigest(items, { days = 7, now = new Date(), pick = (xs) => xs[Math.floor(Math.random() * xs.length)] } = {}) {
  const day = (d) => d.toISOString().slice(0, 10);
  const today = day(now), since = day(new Date(now - days * 86400000)), until = day(new Date(+now + days * 86400000));
  const open = items.filter((it) => !it.adult && it.status !== 'inbox' && it.status !== 'dismissed');
  const added = open.filter((it) => (it.added || '') > since && (it.added || '') <= today);
  const inbox = items.filter((it) => it.status === 'inbox').length;
  const coming = open.filter((it) => it.next_air && it.next_air >= today && it.next_air <= until).sort((a, b) => a.next_air.localeCompare(b.next_air));
  const released = open.filter((it) => it.release_at && it.release_at > since);
  const backlog = open.filter((it) => !it.verdict && it.status === 'todo' && it.poster);
  const out = [`# Watchlist digest, ${today}`, ''];

  out.push(`**${added.length}** added in the last ${days} days. **${inbox}** waiting in the [inbox](${SITE}/inbox/).`, '');
  if (added.length) {
    out.push('## New this week');
    for (const c of CATEGORIES) {
      const xs = added.filter((it) => it.type === c.key);
      if (!xs.length) continue;
      out.push(`- **${c.label}** (${xs.length}): ${xs.slice(0, 12).map(link).join(', ')}${xs.length > 12 ? `, and ${xs.length - 12} more` : ''}`);
    }
    out.push('');
  }
  if (coming.length) {
    out.push('## Coming up');
    for (const it of coming.slice(0, 15)) out.push(`- ${it.next_air}: ${link(it)}${(it.providers || [])[0] ? ` on ${it.providers[0]}` : ''}`);
    out.push('');
  }
  if (released.length) {
    out.push('## Repos that shipped a release');
    for (const it of released.slice(0, 10)) out.push(`- ${link(it)} ${it.release || ''}`);
    out.push('');
  }
  if (backlog.length) {
    const it = pick(backlog);
    out.push('## One from the backlog', `${link(it)} (${category(it.type).singular}${it.year ? `, ${it.year}` : ''})${it.blurb ? `: ${it.blurb}` : ''}`, '');
  }
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--days');
  const items = JSON.parse(readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'data.json'), 'utf8'));
  process.stdout.write(buildDigest(items, { days: i >= 0 ? Number(process.argv[i + 1]) : 7 }) + '\n');
}
