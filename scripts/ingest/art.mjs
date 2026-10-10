/* Deeper cover-art hunt, used when the normal enrichment chain found no poster/icon.
 * Gathers candidates from several free sources, then one LLM call picks the candidate
 * that is the same work (title incl. alt/romaji/native names + type + year/author agree), or none.
 *   anime/show/movie: AniList, Jikan (MyAnimeList), TMDB (incl. alt-title re-search)
 *   book/manga/novel: AniList (manga/novels), Open Library, Google Books, Royal Road
 *   game:             Steam, itch.io
 *   software:         App Store / Mac App Store, GitHub org avatar, official site icon (apple-touch-icon / manifest / og:image)
 * Not used: NovelUpdates (Cloudflare challenge), IGDB (needs Twitch app credentials), Webnovel (bot wall).
 */
const UA = { 'User-Agent': 'Mozilla/5.0 (watchlist art lookup; github.com/Threesided-Studios/watchlist)' };
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
/* per-host spacing so parallel callers stay under public rate limits (AniList ~30/min, Jikan 3/s) */
const gates = new Map();
async function gate(host, gapMs) {
  const prev = gates.get(host) || Promise.resolve();
  const mine = prev.then(() => sleep(gapMs));
  gates.set(host, mine);
  await prev;
}

async function get(url, { json = true, headers = {}, timeoutMs = 12000, method = 'GET', body } = {}) {
  const host = new URL(url).host;
  const gap = host === 'graphql.anilist.co' ? 2100 : host === 'api.jikan.moe' ? 1100 : host.endsWith('steampowered.com') ? 700 : host === 'itunes.apple.com' ? 1000 : 0;
  for (let a = 0; a < 3; a++) {
    if (gap) await gate(host, gap);
    try {
      const r = await fetch(url, { method, body, headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (r.status === 429) { await sleep(Number(r.headers.get('retry-after')) * 1000 || 5000 * (a + 1)); continue; }
      if (!r.ok) return null;
      return json ? await r.json() : { html: await r.text(), url: r.url };
    } catch { if (a === 2) return null; }
  }
  return null;
}
const yr = (s) => Number(String(s || '').slice(0, 4)) || null;
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const abs = (u, base) => { try { return new URL(decode(u), base).href; } catch { return null; } };

/* ---------- anime / manga / novels ---------- */
const ANILIST_Q = `query($s:String,$t:MediaType){Page(perPage:6){media(search:$s,type:$t,sort:SEARCH_MATCH){id type format isAdult startDate{year} title{romaji english native} synonyms staff(perPage:2){nodes{name{full}}} coverImage{extraLarge large} siteUrl}}}`;
async function anilist(q, type) {
  const j = await get('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query: ANILIST_Q, variables: { s: q, t: type } }) });
  return (j?.data?.Page?.media || []).map((m) => ({
    source: 'AniList', kind: `${m.type} ${m.format || ''}`.trim(),
    titles: [m.title.english, m.title.romaji, m.title.native, ...(m.synonyms || []).slice(0, 4)].filter(Boolean),
    year: m.startDate?.year || null, author: type === 'MANGA' ? (m.staff?.nodes || []).map((n) => n.name.full).join(', ') : '',
    image: m.coverImage?.extraLarge || m.coverImage?.large, link: m.siteUrl, adult: !!m.isAdult,
  }));
}
async function jikan(q, kind) {
  const j = await get(`https://api.jikan.moe/v4/${kind}?q=${encodeURIComponent(q)}&limit=5&sfw=true`);
  return (j?.data || []).map((m) => ({
    source: 'MyAnimeList', kind: `${kind.toUpperCase()} ${m.type || ''}`.trim(),
    titles: [m.title_english, m.title, m.title_japanese, ...(m.titles || []).map((t) => t.title)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 7),
    year: m.year || yr(m.aired?.from || m.published?.from), author: (m.authors || []).map((a) => a.name).join(', '),
    image: m.images?.jpg?.large_image_url || m.images?.jpg?.image_url, link: m.url, adult: /^Rx/.test(m.rating || ''),
  }));
}
async function tmdb(q, kind) {
  const tok = process.env.TMDB_READ_TOKEN; const key = process.env.TMDB_API_KEY;
  if (!tok && !key) return [];
  const j = await get(`https://api.themoviedb.org/3/search/${kind}?query=${encodeURIComponent(q)}&include_adult=false${tok ? '' : `&api_key=${key}`}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  return (j?.results || []).filter((m) => m.poster_path).slice(0, 5).map((m) => ({
    source: 'TMDB', kind: kind === 'tv' ? 'TV series' : 'movie', tmdb_id: m.id,
    titles: [m.title || m.name, m.original_title || m.original_name].filter(Boolean),
    year: yr(m.release_date || m.first_air_date), image: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
    link: `https://www.themoviedb.org/${kind}/${m.id}`, blurb: (m.overview || '').slice(0, 160),
  }));
}
async function openLibrary(q) {
  const j = await get(`https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&limit=5&fields=key,title,author_name,first_publish_year,cover_i`);
  return (j?.docs || []).filter((d) => d.cover_i).map((d) => ({
    source: 'Open Library', kind: 'book', titles: [d.title], year: d.first_publish_year || null, author: (d.author_name || []).slice(0, 2).join(', '),
    image: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`, link: `https://openlibrary.org${d.key}`,
  }));
}
async function googleBooks(q) {
  const j = await get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:${q}`)}&maxResults=5&printType=books`);
  return (j?.items || []).filter((v) => v.volumeInfo?.imageLinks?.thumbnail).map((v) => ({
    source: 'Google Books', kind: 'book', titles: [[v.volumeInfo.title, v.volumeInfo.subtitle].filter(Boolean).join(': ')],
    year: yr(v.volumeInfo.publishedDate), author: (v.volumeInfo.authors || []).slice(0, 2).join(', '),
    image: v.volumeInfo.imageLinks.thumbnail.replace(/^http:/, 'https:').replace(/&edge=curl/, '') + '&fife=w600', link: v.volumeInfo.infoLink,
  }));
}
async function royalRoad(q) {
  const r = await get(`https://www.royalroad.com/fictions/search?title=${encodeURIComponent(q)}`, { json: false });
  if (!r) return [];
  const out = [];
  for (const m of r.html.matchAll(/<a href="(\/fiction\/\d+\/[^"]+)"[^>]*>\s*<img[^>]*alt="([^"]+)"[^>]*src="([^"]+)"/g)) {
    if (/nocover/.test(m[3])) continue;
    out.push({ source: 'Royal Road', kind: 'web novel', titles: [decode(m[2])], year: null, image: decode(m[3]), link: `https://www.royalroad.com${m[1]}` });
    if (out.length >= 5) break;
  }
  return out;
}

/* ---------- games ---------- */
async function steam(q) {
  const j = await get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=us&l=en`);
  return (j?.items || []).filter((i) => i.type === 'app').slice(0, 5).map((i) => ({
    source: 'Steam', kind: 'game', titles: [i.name], year: null, steam_appid: i.id,
    image: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${i.id}/library_600x900.jpg`,
    image2: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${i.id}/header.jpg`,
    link: `https://store.steampowered.com/app/${i.id}/`,
  }));
}
async function itch(q) {
  const r = await get(`https://itch.io/search?q=${encodeURIComponent(q)}`, { json: false });
  if (!r) return [];
  const out = [];
  for (const cell of r.html.split('class="game_cell').slice(1, 7)) {
    const link = (cell.match(/href="(https:\/\/[^"]+\.itch\.io\/[^"]+)"/) || [])[1];
    const title = (cell.match(/class="title game_link"[^>]*>([^<]+)/) || [])[1];
    const img = (cell.match(/data-lazy_src="([^"]+)"/) || [])[1];
    if (link && title && img) out.push({ source: 'itch.io', kind: 'game', titles: [decode(title)], year: null, image: decode(img).replace(/\/\d+x\d+%23c\//, '/original/'), link });
  }
  return out;
}

/* ---------- software ---------- */
async function appStore(q) {
  const out = [];
  for (const entity of ['software', 'macSoftware']) {
    const j = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=${entity}&limit=4&country=us`);
    for (const a of j?.results || []) out.push({ source: entity === 'software' ? 'App Store' : 'Mac App Store', kind: 'app', titles: [a.trackName], author: a.sellerName || a.artistName, year: yr(a.releaseDate), image: a.artworkUrl512 || a.artworkUrl100, link: a.trackViewUrl, blurb: (a.description || '').slice(0, 140) });
  }
  return out;
}
async function githubOrg(q) {
  const tok = process.env.GITHUB_TOKEN;
  const j = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} in:name`)}&sort=stars&per_page=4`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  return (j?.items || []).filter((r) => r.stargazers_count >= 50).map((r) => ({
    source: 'GitHub', kind: 'open-source repo', titles: [r.full_name], author: r.owner.login, year: yr(r.created_at),
    image: `${r.owner.avatar_url}${r.owner.avatar_url.includes('?') ? '&' : '?'}s=400`, link: r.html_url, blurb: (r.description || '').slice(0, 140),
  }));
}
function domainGuesses(name) {
  const base = String(name).replace(/\bAI\b/gi, ' ai').trim();
  const slug = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set();
  for (const tld of ['com', 'ai', 'io', 'app', 'dev']) set.add(`${slug}.${tld}`);
  if (parts.length === 2) { set.add(`${parts[0]}.${parts[1]}`); set.add(`${parts[0]}.com`); set.add(`${parts[0]}.ai`); }
  return [...set].slice(0, 9);
}
function iconFromHtml(html, base) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag, a) => (tag.match(new RegExp(`${a}\\s*=\\s*["']([^"']+)["']`, 'i')) || [])[1] || '';
  const touch = links.find((l) => /rel=["'][^"']*apple-touch-icon/i.test(l));
  const icons = links.filter((l) => /rel=["'][^"']*\bicon\b/i.test(l) && !/mask-icon/i.test(l))
    .map((l) => ({ href: attr(l, 'href'), size: Number((attr(l, 'sizes').match(/(\d+)x/) || [])[1]) || 0, svg: /\.svg|svg\+xml/i.test(l) }))
    .filter((i) => !i.svg).sort((a, b) => b.size - a.size);
  const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i) || [])[1];
  /* square icons first (posters for software are icons); og:image (usually a wide social card) last */
  return [touch && attr(touch, 'href'), icons[0]?.size >= 128 && icons[0].href, '/apple-touch-icon.png', og].filter(Boolean).map((u) => abs(u, base)).filter(Boolean);
}
async function officialSite(q) {
  const out = [];
  await Promise.all(domainGuesses(q).map(async (d) => {
    const r = await get(`https://${d}/`, { json: false, timeoutMs: 9000 });
    if (!r || r.html.length < 500) return;
    const title = decode((r.html.match(/<title[^>]*>([^<]{1,160})/i) || [])[1]);
    const site = decode((r.html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)/i) || [])[1]);
    const desc = decode((r.html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)/i) || [])[1]).slice(0, 140);
    const imgs = iconFromHtml(r.html, r.url);
    if (imgs.length) out.push({ source: 'official site', kind: 'website/app', titles: [site, title].filter(Boolean), year: null, image: imgs[0], image2: imgs[1], image3: imgs[2], link: r.url, blurb: desc });
  }));
  return out;
}

/* ---------- gather + verify ---------- */
async function gather(c) {
  const q = String(c.title).replace(/\s*\((19|20)\d{2}\)\s*$/, '');
  const noParen = q.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[!?.]+$/, '').trim();
  const short = noParen.split(/[:—–]|\s-\s/)[0].trim();
  const qs = [...new Set([q, noParen, noParen.includes('&') ? noParen.replace(/\s*&\s*/g, ' and ') : null, short.length >= 4 ? short : null].filter(Boolean))];
  const lists = [];
  for (const s of qs) {
    if (c.type === 'show' || c.type === 'movie') {
      const ani = c.is_anime || /anime/i.test((c.tags || []).join(' '));
      const al = ani ? await anilist(s, 'ANIME') : [];
      lists.push(al, ani && !al.length ? await jikan(s, 'anime') : [], await tmdb(s, c.type === 'show' ? 'tv' : 'movie'));
      for (const alt of al.slice(0, 2).flatMap((m) => m.titles.slice(0, 2))) if (alt && alt !== s) lists.push(await tmdb(alt, c.type === 'show' ? 'tv' : 'movie'));
    } else if (c.type === 'book') {
      const al = await anilist(s, 'MANGA');
      lists.push(al, !al.length ? await jikan(s, 'manga') : [], await openLibrary(s), await googleBooks(s), await royalRoad(s));
    } else if (c.type === 'game') {
      lists.push(await steam(s), await itch(s));
    } else if (c.type === 'software') {
      lists.push(await appStore(s), await githubOrg(s), qs.indexOf(s) === 0 ? await officialSite(s) : []);
    }
    if (lists.flat().length >= 6) break;
  }
  const seen = new Set();
  return lists.flat().filter((x) => x.image && !seen.has(x.link) && seen.add(x.link)).slice(0, 14);
}

const PICK_SCHEMA = { type: 'object', additionalProperties: false, required: ['index', 'reason'], properties: { index: { type: 'integer' }, reason: { type: 'string' } } };
const PICK_RULES = `You verify cover-art matches for a personal watchlist. Pick the ONE candidate that is the same work/product as the item, or -1.
Rules: the title must clearly refer to the same work (official English, romaji, native or alternate titles are fine; a different season/sequel/spin-off/remake is NOT the same unless the item is that one).
Type must agree: show/movie <-> anime TV/ONA/OVA/movie or a TV series/movie; book <-> book/manga/light novel/web novel; game <-> game (a mod list or mod is fine only if the candidate is that mod); software <-> the product's own app, its own official website or its maker's official GitHub org. A third-party app or site that merely uses the name in its title (e.g. "X: GPT Image Generator" by another company) is NOT a match; the maker must be the product's company. For software also check the item context: the candidate's description must match what the context says the product does (e.g. a Web3 agent builder is not "an AI model that passes a video Turing test"). If the name is a model/feature of a big company (GPT…, DALL·E, Claude, Gemini, Sora, Veo…), only that company's own app/site counts; domains like gpt-image.ai or claude-x.com are third-party wrappers.
If both years are known they must be within 1 (for long-running series the start year). If both authors are known they must agree.
For software, when the product's own company has an App Store / Mac App Store entry, prefer it over the website (its icon makes the better poster).
If the item title is short or partial and several candidates could fit it (e.g. multiple different series whose titles contain "Reincarnated as an Aristocrat"), return -1 unless the context singles one out.
Return -1 when unsure, when the item looks like a joke/parody/made-up title, an AI model name, or a generic phrase rather than a real work, or when no candidate fits.`;

export async function huntArt(c, openai, model = process.env.ART_VERIFY_MODEL || 'gpt-4.1') {
  const cands = await gather(c);
  if (!cands.length) return { found: null, cost: 0, reason: 'no candidates in any source', tried: 0 };
  const item = { title: c.title, type: c.type, year: c.year || null, author: c.author || c.creator || null, tags: c.tags || [], context: (c.context || '').slice(0, 200) };
  const list = cands.map((x, i) => ({ i, source: x.source, kind: x.kind, titles: x.titles.slice(0, 6), year: x.year, author: x.author || undefined, blurb: x.blurb || undefined, link: x.link }));
  try {
    const { out, cost } = await openai(model, [{ role: 'system', content: PICK_RULES }, { role: 'user', content: JSON.stringify({ item, candidates: list }) }], PICK_SCHEMA, 200);
    const hit = out.index >= 0 && out.index < cands.length ? cands[out.index] : null;
    return { found: hit, cost, reason: out.reason, tried: cands.length };
  } catch (e) { return { found: null, cost: 0, reason: `verify failed: ${String(e).slice(0, 80)}`, tried: cands.length }; }
}
