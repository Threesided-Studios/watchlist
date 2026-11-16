/* The one definition of what the Watchlist tracks. Imported by the site
 * (assets/), the site build (scripts/build-site.mjs) and the screenshot ingest
 * (scripts/ingest/), so a category added here shows up everywhere.
 *
 *   key     value stored in item.type
 *   slug    URL of the category page (/movies/)
 *   cover   shape of the art: poster (2:3), square (1:1) or wide (16:9)
 *   verbs   status wording for todo / active / done
 *   family  dedupe family: types in one family are treated as the same work
 *           when the title matches (people mislabel a film as a show, an app as a repo)
 *   accent  badge colour; grad is the placeholder background when there is no art
 */

export const CATEGORIES = [
  { key: 'movie',     slug: 'movies',     label: 'Movies',      singular: 'movie',      glyph: '🎬', cover: 'poster', family: 'screen',    accent: '#b8b0ff', grad: ['#2a1f5e', '#4a2d8c'], verbs: ['to watch', 'watching', 'watched'] },
  { key: 'show',      slug: 'shows',      label: 'Shows',       singular: 'show',       glyph: '📺', cover: 'poster', family: 'screen',    accent: '#7dddd5', grad: ['#0f3040', '#1b6b7a'], verbs: ['to watch', 'watching', 'watched'] },
  { key: 'anime',     slug: 'anime',      label: 'Anime',       singular: 'anime',      glyph: '🌸', cover: 'poster', family: 'screen',    accent: '#ff9ec4', grad: ['#3d1030', '#7a2460'], verbs: ['to watch', 'watching', 'watched'] },
  { key: 'manga',     slug: 'manga',      label: 'Manga & Comics', singular: 'manga',   glyph: '🗯️', cover: 'poster', family: 'manga',     accent: '#f0b0a0', grad: ['#3a1814', '#70302a'], verbs: ['to read', 'reading', 'read'] },
  { key: 'book',      slug: 'books',      label: 'Books',       singular: 'book',       glyph: '📖', cover: 'poster', family: 'book',      accent: '#e0c97a', grad: ['#2d2010', '#5c4020'], verbs: ['to read', 'reading', 'read'] },
  { key: 'game',      slug: 'games',      label: 'Games',       singular: 'game',       glyph: '🎮', cover: 'poster', family: 'game',      accent: '#ffab80', grad: ['#3d1608', '#7a3518'], verbs: ['to play', 'playing', 'played'] },
  { key: 'boardgame', slug: 'board-games', label: 'Board Games', singular: 'board game', glyph: '🎲', cover: 'square', family: 'boardgame', accent: '#d8c090', grad: ['#2c2412', '#5a4a24'], verbs: ['to play', 'playing', 'played'] },
  { key: 'software',  slug: 'software',   label: 'Software',    singular: 'app',        glyph: '💻', cover: 'square', family: 'tool',      accent: '#7fd6cf', grad: ['#0c2a2a', '#16524f'], verbs: ['to try', 'trying', 'using'] },
  { key: 'repo',      slug: 'repos',      label: 'Repos',       singular: 'repo',       glyph: '🧰', cover: 'wide',   family: 'tool',      accent: '#9fc0e8', grad: ['#101c2c', '#213a5c'], verbs: ['to try', 'trying', 'using'] },
  { key: 'podcast',   slug: 'podcasts',   label: 'Podcasts',    singular: 'podcast',    glyph: '🎙️', cover: 'square', family: 'podcast',   accent: '#c8a8f0', grad: ['#22123a', '#472678'], verbs: ['to hear', 'listening', 'heard'] },
  { key: 'music',     slug: 'music',      label: 'Music',       singular: 'music',      glyph: '🎵', cover: 'square', family: 'music',     accent: '#f0a0c8', grad: ['#3a0a25', '#7a1850'], verbs: ['to hear', 'listening', 'heard'] },
  { key: 'video',     slug: 'videos',     label: 'Videos',      singular: 'video',      glyph: '▶️', cover: 'wide',   family: 'video',     accent: '#f09090', grad: ['#3a0e0e', '#701c1c'], verbs: ['to watch', 'watching', 'watched'] },
  { key: 'place',     slug: 'places',     label: 'Places',      singular: 'place',      glyph: '📍', cover: 'wide',   family: 'place',     accent: '#94ccf0', grad: ['#0a1e35', '#14406e'], verbs: ['to visit', 'planned', 'visited'] },
  { key: 'recipe',    slug: 'recipes',    label: 'Recipes',     singular: 'recipe',     glyph: '🍽️', cover: 'wide',   family: 'recipe',    accent: '#90dda0', grad: ['#0f2d14', '#1f5e2a'], verbs: ['to cook', 'cooking', 'cooked'] },
  { key: 'product',   slug: 'products',   label: 'Products',    singular: 'product',    glyph: '🛍️', cover: 'square', family: 'product',   accent: '#d0a8f0', grad: ['#28103d', '#562080'], verbs: ['to buy', 'considering', 'bought'] },
  { key: 'article',   slug: 'reading',    label: 'Reading List', singular: 'article',   glyph: '📰', cover: 'wide',   family: 'article',   accent: '#c8c8b8', grad: ['#20201a', '#3e3e32'], verbs: ['to read', 'reading', 'read'] },
  { key: 'other',     slug: 'other',      label: 'Other',       singular: 'other',      glyph: '◈',  cover: 'poster', family: 'other',     accent: '#b0a8c0', grad: ['#1a1520', '#302540'], verbs: ['to do', 'in progress', 'done'] },
];

/* Type names used by older data and by hand-made items. */
export const TYPE_ALIASES = { venue: 'place', purchase: 'product', project: 'other', tv: 'show', film: 'movie', app: 'software', comic: 'manga' };

const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
const BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

export const TYPE_KEYS = CATEGORIES.map((c) => c.key);
export const canonicalType = (type) => {
  const t = String(type || '').toLowerCase();
  if (BY_KEY.has(t)) return t;
  return TYPE_ALIASES[t] || 'other';
};
export const category = (type) => BY_KEY.get(canonicalType(type));
export const categoryBySlug = (slug) => BY_SLUG.get(slug) || null;
export const family = (type) => category(type).family;

/* TMDB splits everything into movie and tv. Anime keeps which one it is in `format`. */
export const tmdbKind = (item) => {
  const t = canonicalType(item?.type);
  if (t === 'show') return 'tv';
  if (t === 'anime') return item.format === 'film' ? 'movie' : 'tv';
  return 'movie';
};
export const isScreen = (type) => family(type) === 'screen';

export const STATUSES = ['todo', 'active', 'done'];
export const statusLabel = (type, status) => {
  const i = STATUSES.indexOf(status);
  return i < 0 ? status : category(type).verbs[i];
};

/* ---- tags ---------------------------------------------------------------
 * Tags arrive from TMDB, Steam, the vision model and hand edits, so the same
 * genre shows up as "Fantasy", "fantasy" and inside "Sci-Fi & Fantasy". */
const TAG_SPLIT = { 'action & adventure': ['Action', 'Adventure'], 'sci-fi & fantasy': ['Sci-Fi', 'Fantasy'], 'war & politics': ['War', 'Politics'] };
const TAG_FIXED = {
  'sci-fi': 'Sci-Fi', 'scifi': 'Sci-Fi', 'science fiction': 'Sci-Fi', 'science-fiction': 'Sci-Fi',
  rpg: 'RPG', jrpg: 'JRPG', crpg: 'CRPG', arpg: 'ARPG', mmo: 'MMO', mmorpg: 'MMORPG', fps: 'FPS', rts: 'RTS', vr: 'VR', pc: 'PC',
  litrpg: 'LitRPG', gamelit: 'GameLit', ya: 'YA', ai: 'AI', cli: 'CLI', macos: 'macOS', ios: 'iOS',
  'point-and-click': 'Point-and-Click', 'point & click': 'Point-and-Click', 'point and click': 'Point-and-Click',
  'slice of life': 'Slice of Life', 'coming of age': 'Coming of Age', 'martial arts': 'Martial Arts',
  'non-fiction': 'Non-Fiction', nonfiction: 'Non-Fiction', 'sci fi': 'Sci-Fi',
};
const SMALL = new Set(['of', 'and', 'the', 'a', 'an', 'in', 'on', 'for', 'to']);
const titleCase = (s) => s.split(' ').map((w, i) => (i && SMALL.has(w) ? w : w.replace(/(^|[-/])([a-z])/g, (m, p, c) => p + c.toUpperCase()))).join(' ');

export function normalizeTag(tag) {
  const raw = String(tag || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const low = raw.toLowerCase();
  if (TAG_SPLIT[low]) return TAG_SPLIT[low];
  if (TAG_FIXED[low]) return [TAG_FIXED[low]];
  /* only all-lowercase tags are re-cased; "LitRPG", "iOS", "PS3" and "OVA" are deliberate */
  if (raw !== low) return [raw];
  return [titleCase(low)];
}

export function normalizeTags(tags) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    for (const n of normalizeTag(t)) {
      const k = n.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
  }
  return out;
}
