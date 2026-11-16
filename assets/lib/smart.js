/* Plain-language search: pulls the parts of a query that are really filters
 * ("short anime on crunchyroll from the 2010s i haven't watched") out of it,
 * and leaves the rest as ordinary text to match. Pure; no network, no model.
 *
 *   parseQuery(q, { providers: ['Netflix', ...] })
 *     -> { type, stage, verdict, on, maxRuntime, minRuntime, yearFrom, yearTo, text, notes: [...] }
 *
 * `notes` says what was understood, so the UI can show it and the user can see
 * why results were narrowed.
 */
const TYPES = [
  [/\b(movies?|films?)\b/, 'movie', 'movies'], [/\b(tv shows?|shows?|series)\b/, 'show', 'shows'], [/\banime\b/, 'anime', 'anime'],
  [/\b(manga|comics?|manhwa|light novels?)\b/, 'manga', 'manga & comics'], [/\b(books?|novels?)\b/, 'book', 'books'],
  [/\b(board ?games?)\b/, 'boardgame', 'board games'], [/\b(video ?games?|games?)\b/, 'game', 'games'],
  [/\b(repos?|repositories|github)\b/, 'repo', 'repos'], [/\b(apps?|software|tools?)\b/, 'software', 'software'],
  [/\b(podcasts?)\b/, 'podcast', 'podcasts'], [/\b(albums?|music|songs?)\b/, 'music', 'music'], [/\b(videos?|youtube)\b/, 'video', 'videos'],
  [/\b(places?|restaurants?|bars?|spots?)\b/, 'place', 'places'], [/\b(recipes?)\b/, 'recipe', 'recipes'], [/\b(articles?|reads?)\b/, 'article', 'articles'],
];
const STAGES = [
  [/\b(i (have not|haven'?t) (watched|seen|read|played|tried|started)( yet)?|unwatched|unread|unplayed|not started|backlog|to (watch|read|play))\b/, 'backlog', 'not started'],
  [/\b(in progress|watching|reading|playing|started|currently)\b/, 'active', 'in progress'],
  [/\b(finished|watched|completed|done|read already|already (seen|watched|read|played))\b/, 'finished', 'finished'],
];
const NUM = '(\\d+(?:\\.\\d+)?)';

export function parseQuery(q, { providers = [] } = {}) {
  let rest = ` ${String(q || '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out = { notes: [] };
  const take = (rx, fn) => { const m = rest.match(rx); if (!m) return false; if (fn(m) === false) return false; rest = rest.replace(m[0], ' '); return true; };

  /* where it streams: "on netflix", or just the service name */
  for (const p of [...providers].sort((a, b) => b.length - a.length)) {
    const name = p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const short = name.replace(/^amazon /, '').replace(/ video$/, '').replace(/\+$/, '\\+?');
    if (take(new RegExp(`\\b(?:on |streaming on )?(?:${name}|${short})(?= |$)`), () => { out.on = p; out.notes.push(`on ${p}`); })) break;
  }

  /* length */
  take(new RegExp(`\\b(?:under|less than|shorter than|max) ${NUM} ?(hours?|hrs?|h|minutes?|mins?|m)\\b`), (m) => { out.maxRuntime = Math.round(Number(m[1]) * (m[2].startsWith('h') ? 60 : 1)); out.notes.push(`under ${out.maxRuntime} min`); });
  take(new RegExp(`\\b(?:over|more than|longer than) ${NUM} ?(hours?|hrs?|h|minutes?|mins?|m)\\b`), (m) => { out.minRuntime = Math.round(Number(m[1]) * (m[2].startsWith('h') ? 60 : 1)); out.notes.push(`over ${out.minRuntime} min`); });
  if (!out.maxRuntime) take(/\b(short|quick)\b/, () => { out.maxRuntime = 100; out.notes.push('under 100 min'); });
  if (!out.minRuntime) take(/\b(long|epic length)\b/, () => { out.minRuntime = 150; out.notes.push('over 150 min'); });

  /* when */
  take(/\b(?:from |in )?(?:the )?((?:19|20)\d0)s\b/, (m) => { out.yearFrom = Number(m[1]); out.yearTo = out.yearFrom + 9; out.notes.push(`${m[1]}s`); });
  take(/\b(?:from |in )?(?:the )?'?(\d0)s\b/, (m) => { const d = Number(m[1]); out.yearFrom = (d <= 20 ? 2000 : 1900) + d; out.yearTo = out.yearFrom + 9; out.notes.push(`${out.yearFrom}s`); });
  take(/\b(?:before|older than|pre) ((?:19|20)\d{2})\b/, (m) => { out.yearTo = Number(m[1]) - 1; out.notes.push(`before ${m[1]}`); });
  take(/\b(?:after|since|newer than|post) ((?:19|20)\d{2})\b/, (m) => { out.yearFrom = Number(m[1]) + (/(since)/.test(m[0]) ? 0 : 1); out.notes.push(`${/(since)/.test(m[0]) ? 'since' : 'after'} ${m[1]}`); });
  take(/\b(?:from|in) ((?:19|20)\d{2})\b/, (m) => { out.yearFrom = out.yearTo = Number(m[1]); out.notes.push(m[1]); });
  take(/\b(new|recent|latest)\b/, () => { out.yearFrom = new Date().getFullYear() - 2; out.notes.push(`since ${out.yearFrom}`); });
  take(/\b(old|classic|classics|vintage)\b/, () => { out.yearTo = 1999; out.notes.push('before 2000'); });

  /* where it is in its life */
  take(/\b(loved|favou?rites?|best)\b/, () => { out.verdict = 'love'; out.notes.push('loved'); });
  for (const [rx, stage, label] of STAGES) if (take(rx, () => { out.stage = stage; out.notes.push(label); })) break;

  /* what kind of thing (last, so "anime" in "anime movies" resolves to the more specific word first seen) */
  for (const [rx, type, label] of TYPES) if (take(rx, () => { out.type = type; out.notes.push(label); })) break;

  /* filler left behind once the filters are lifted out */
  out.text = rest.replace(/\b(something|anything|stuff|things?|that|which|is|are|i|me|my|a|an|the|to|for|with|and|some|any|show me|find|give me|want|good)\b/g, ' ').replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  return out;
}

/* Does an item pass the parts of a parsed query that plain filters do not cover? */
export function matchesParsed(it, p) {
  if (p.maxRuntime && !(it.runtime && it.runtime <= p.maxRuntime)) return false;
  if (p.minRuntime && !(it.runtime && it.runtime >= p.minRuntime)) return false;
  if (p.yearFrom && !(it.year && it.year >= p.yearFrom)) return false;
  if (p.yearTo && !(it.year && it.year <= p.yearTo)) return false;
  return true;
}
