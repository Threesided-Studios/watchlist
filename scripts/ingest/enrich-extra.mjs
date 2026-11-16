/* Enrichment for the categories added in ingest v2. Each function takes a
 * candidate ({title, type, year, creator, url, location, ...}) and returns
 * { typeOk, title, year, blurb, summary, link, posterUrl, ...extra } or null.
 * `typeOk` means "this is confidently the same thing", as in run.mjs.
 *
 *   music, podcast  Spotify Web API (client-credentials: SPOTIFY_CLIENT_ID / _SECRET)
 *   repo            GitHub (exact owner/name when the screenshot shows it, else search)
 *   manga           AniList
 *   boardgame       BoardGameGeek
 *   place           OpenStreetMap Nominatim
 *   video           YouTube oEmbed (when a URL is visible)
 *   article, product, recipe   the page's own OpenGraph tags (when a URL is visible)
 */
import { titleKey } from './lib.mjs';

const UA = { 'user-agent': 'watchlist-ingest/2.0 (+https://github.com/Threesided-Studios/watchlist)' };
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const first = (s, n = 240) => clean(s).split(/(?<=[.!?])\s/)[0].slice(0, n);
const sameTitle = (a, b) => { const x = titleKey(a), y = titleKey(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(`${y}-`) || y.startsWith(`${x}-`)))); };

async function get(url, headers = {}, as = 'json', timeoutMs = 10000) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return as === 'text' ? await r.text() : await r.json();
  } catch { return null; }
}

/* When nothing matched and no URL was on screen, a search that will find it beats no link at all. */
export function fallbackLink(c, app = '') {
  const q = encodeURIComponent([c.title, c.creator].filter(Boolean).join(' '));
  if (c.type === 'video') return `https://www.youtube.com/results?search_query=${q}`;
  if (c.type === 'music' || c.type === 'podcast') return `https://open.spotify.com/search/${q}`;
  if (c.type === 'place') return `https://www.google.com/maps/search/${encodeURIComponent([c.title, c.location].filter(Boolean).join(', '))}`;
  if (['article', 'recipe', 'product'].includes(c.type)) return `https://duckduckgo.com/?q=${encodeURIComponent([c.title, c.creator, app].filter(Boolean).join(' '))}`;
  return '';
}
/* exact after normalising; the looser prefix match is wrong for short song and show names */
const exactName = (a, b) => !!titleKey(a) && titleKey(a) === titleKey(b);

/* ---------- Spotify ---------- */
let spotifyToken = null;
async function spotifyAuth() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (spotifyToken && spotifyToken.until > Date.now()) return spotifyToken.value;
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    spotifyToken = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return spotifyToken.value;
  } catch { return null; }
}
/* Without credentials, still give the item somewhere useful to go. */
export const spotifySearchLink = (c) => `https://open.spotify.com/search/${encodeURIComponent([c.title, c.creator].filter(Boolean).join(' '))}`;

export async function viaSpotify(c) {
  const token = await spotifyAuth();
  if (!token) return { typeOk: false, title: c.title, year: c.year || null, blurb: '', summary: '', link: spotifySearchLink(c), posterUrl: null };
  const kinds = c.type === 'podcast' ? ['show'] : ['album', 'artist', 'track'];
  const q = encodeURIComponent([c.title, c.type !== 'podcast' && c.creator].filter(Boolean).join(' '));
  const j = await get(`https://api.spotify.com/v1/search?q=${q}&type=${kinds.join(',')}&limit=5&market=US`, { Authorization: `Bearer ${token}` });
  if (!j) return null;
  const img = (x) => x?.images?.[0]?.url || x?.album?.images?.[0]?.url || null;
  for (const kind of kinds) {
    const hit = (j[`${kind}s`]?.items || []).filter(Boolean).find((h) => exactName(h.name, c.title)
      && (!c.creator || kind === 'show' || kind === 'artist' || (h.artists || []).some((a) => exactName(a.name, c.creator) || titleKey(c.creator).includes(titleKey(a.name)))));
    if (!hit) continue;
    const by = kind === 'show' ? hit.publisher : (hit.artists || []).map((a) => a.name).join(', ');
    return {
      typeOk: true, title: hit.name, author: by || '',
      year: Number((hit.release_date || hit.album?.release_date || '').slice(0, 4)) || c.year || null,
      blurb: kind === 'show' ? first(hit.description) : kind === 'artist' ? (hit.genres || []).slice(0, 3).join(', ') : `${kind === 'track' ? 'Song' : 'Album'}${by ? ` by ${by}` : ''}`,
      summary: kind === 'show' ? clean(hit.description) : '',
      link: hit.external_urls?.spotify || spotifySearchLink(c), spotify_id: hit.id, format: kind === 'show' ? undefined : kind,
      genres: hit.genres || [], posterUrl: img(hit),
    };
  }
  return null;
}

/* ---------- GitHub ---------- */
const SLUG = /(?:github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})/;
export function repoSlug(c) {
  const m = String(c.url || '').match(SLUG) || (/^[\w.-]+\/[\w.-]+$/.test(c.title || '') ? String(c.title).match(SLUG) : null);
  return m && !/\.(com|org|io|dev|net)$/i.test(m[1]) ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : null;
}
export async function viaGitHubRepo(c) {
  const auth = { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const slug = repoSlug(c);
  let r = slug ? await get(`https://api.github.com/repos/${slug}`, auth) : null;
  const exact = !!r;
  if (!r) {
    const name = String(c.title).split('/').pop();
    const j = await get(`https://api.github.com/search/repositories?${new URLSearchParams({ q: `${name} in:name`, sort: 'stars', per_page: '5' })}`, auth);
    r = (j?.items || []).find((x) => titleKey(x.name.replace(/[-_.]/g, ' ')) === titleKey(name.replace(/[-_.]/g, ' ')) && x.stargazers_count >= 50) || null;
  }
  if (!r) return null;
  const rel = await get(`https://api.github.com/repos/${r.full_name}/releases/latest`, auth);
  return {
    typeOk: exact || r.stargazers_count >= 500, title: r.name, author: r.owner?.login || '',
    year: Number((r.created_at || '').slice(0, 4)) || null, blurb: clean(r.description), summary: '',
    link: r.homepage && /^https?:\/\//.test(r.homepage) ? r.homepage : r.html_url, repo_url: r.html_url,
    stars: r.stargazers_count, language: r.language || '', license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '',
    pushed: (r.pushed_at || '').slice(0, 10), archived: !!r.archived, release: rel?.tag_name || '',
    genres: (r.topics || []).slice(0, 4), posterUrl: `https://opengraph.githubassets.com/1/${r.full_name}`, posterFallback: r.owner?.avatar_url || null,
  };
}

/* ---------- AniList (manga, light novels) ---------- */
export async function viaAniListManga(c) {
  /* adult titles are only searched when the screenshot flagged the item as adult */
  const query = `query($s:String){Page(perPage:5){media(search:$s,type:MANGA${c.adult ? '' : ',isAdult:false'}){` + 'id title{romaji english native} format startDate{year} description(asHtml:false) genres siteUrl coverImage{extraLarge} staff(perPage:1){nodes{name{full}}}}}}';
  try {
    const r = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...UA }, body: JSON.stringify({ query, variables: { s: c.title } }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const hit = ((await r.json()).data?.Page?.media || []).find((m) => [m.title.english, m.title.romaji, m.title.native].some((t) => t && sameTitle(t, c.title)));
    if (!hit) return null;
    const desc = clean(String(hit.description || '').replace(/<[^>]+>/g, ' ').replace(/\(Source:.*$/i, ''));
    return { typeOk: true, title: hit.title.english || hit.title.romaji, author: hit.staff?.nodes?.[0]?.name?.full || '', year: hit.startDate?.year || c.year || null,
      blurb: first(desc), summary: desc, link: hit.siteUrl, genres: hit.genres || [], posterUrl: hit.coverImage?.extraLarge || null };
  } catch { return null; }
}

/* ---------- BoardGameGeek ---------- */
const xmlAttr = (xml, tag, attr = 'value') => (xml.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"`)) || [])[1] || '';
const xmlText = (xml, tag) => (xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
const unescape = (s) => s.replace(/&#10;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&[a-z]+;/g, ' ');
export async function viaBGG(c) {
  const s = await get(`https://boardgamegeek.com/xmlapi2/search?type=boardgame&query=${encodeURIComponent(c.title)}`, {}, 'text');
  if (!s) return null;
  const items = [...s.matchAll(/<item type="boardgame" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => ({ id: m[1], name: unescape(xmlAttr(m[2], 'name')), year: Number(xmlAttr(m[2], 'yearpublished')) || null }));
  const hit = items.find((i) => titleKey(i.name) === titleKey(c.title)) || null;
  if (!hit) return null;
  const d = await get(`https://boardgamegeek.com/xmlapi2/thing?id=${hit.id}`, {}, 'text') || '';
  const desc = clean(unescape(xmlText(d, 'description')));
  const players = [xmlAttr(d, 'minplayers'), xmlAttr(d, 'maxplayers')].filter(Boolean).join('–');
  return { typeOk: true, title: hit.name, year: hit.year || c.year || null, blurb: first(desc), summary: desc.slice(0, 1200),
    link: `https://boardgamegeek.com/boardgame/${hit.id}`, posterUrl: xmlText(d, 'image').trim() || null,
    genres: [players && `${players} players`, xmlAttr(d, 'playingtime') && `${xmlAttr(d, 'playingtime')} min`].filter(Boolean) };
}

/* ---------- places ---------- */
export async function viaNominatim(c) {
  const q = [c.title, c.location].filter(Boolean).join(', ');
  const j = await get(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '3', addressdetails: '1', extratags: '1' })}`);
  const hit = (j || []).find((p) => sameTitle(p.name || '', c.title));
  const maps = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
  if (!hit) return { typeOk: false, title: c.title, year: null, blurb: c.location || '', summary: '', link: maps, posterUrl: null };
  const a = hit.address || {};
  const where = [a.road && [a.house_number, a.road].filter(Boolean).join(' '), a.neighbourhood || a.suburb, a.city || a.town || a.village, a.state].filter(Boolean).join(', ');
  /* a name alone matches a place somewhere in the world; only trust the address when the screenshot said where */
  if (!clean(c.location)) return { typeOk: false, title: c.title, year: null, blurb: String(hit.type || '').replace(/_/g, ' '), summary: '', link: maps, posterUrl: null };
  return { typeOk: true, title: hit.name, year: null, blurb: [String(hit.type || '').replace(/_/g, ' '), where].filter(Boolean).join(' · '), summary: '',
    link: hit.extratags?.website || maps, map_url: maps, lat: Number(hit.lat), lon: Number(hit.lon), location: where || c.location || '', posterUrl: null };
}

/* ---------- anything with a URL on screen ---------- */
const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return m ? unescape(m[1]) : '';
};
export function pageUrl(c) {
  const u = clean(c.url);
  if (!u || /\s/.test(u) || !/\.[a-z]{2,}/i.test(u)) return null;
  try { const p = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); return /^[\w.-]+$/.test(p.hostname) ? p.href : null; } catch { return null; }
}
export async function viaYouTube(c) {
  const url = pageUrl(c);
  if (!url || !/youtu\.?be/.test(url)) return null;
  const j = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  if (!j) return null;
  return { typeOk: true, title: j.title, author: j.author_name || '', year: null, blurb: j.author_name ? `Video by ${j.author_name}` : '', summary: '', link: url, posterUrl: j.thumbnail_url || null };
}
export async function viaOpenGraph(c) {
  const url = pageUrl(c);
  if (!url) return null;
  const html = await get(url, { accept: 'text/html' }, 'text', 12000);
  if (!html) return null;
  const title = meta(html, 'og:title') || clean((html.match(/<title[^>]*>([^<]*)</i) || [])[1]);
  if (!title) return null;
  const desc = meta(html, 'og:description') || meta(html, 'description');
  return { typeOk: sameTitle(title.split(/\s[|–—-]\s/)[0], c.title), title: c.title, year: null, blurb: first(desc), summary: clean(desc).slice(0, 800),
    link: meta(html, 'og:url') || url, author: meta(html, 'og:site_name') || meta(html, 'author'), posterUrl: meta(html, 'og:image') || null };
}

/* Which enrichers to try for each v2 type, in order. Types not listed use the existing chain in run.mjs. */
export const EXTRA_CHAINS = {
  music: [viaSpotify], podcast: [viaSpotify], repo: [viaGitHubRepo], manga: [viaAniListManga], boardgame: [viaBGG],
  place: [viaNominatim], video: [viaYouTube, viaOpenGraph], article: [viaOpenGraph], product: [viaOpenGraph], recipe: [viaOpenGraph],
};
/* Fields from an enrichment result that are copied onto the item as they are. */
export const EXTRA_FIELDS = ['repo_url', 'stars', 'language', 'license', 'pushed', 'archived', 'release', 'spotify_id', 'map_url', 'lat', 'lon'];
