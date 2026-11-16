/* What the vision models are asked, and the shapes they must answer in.
 *
 * Two passes per screenshot:
 *   triage  cheap model, 384px:  is anything here worth saving, and what kind of screenshot is it?
 *   parse   strong model, 1536px: everything it names, typed against shared/taxonomy.js
 *
 * The triage answer is kept in the ledger even for skips, so "why was this
 * screenshot ignored?" always has an answer.
 */
import { CATEGORIES } from '../../shared/taxonomy.js';

export const TRIAGE_WIDTH = 512;
export const PARSE_WIDTH = 1280;

/* Which model reads a screenshot. The cheap model is confidently wrong often enough that its
   own confidence cannot be the only signal, so the rules below do not rely on it alone.

   1. Text-dense screenshots (threads, lists, chats, articles) go straight to the strong model:
      small text and many names are exactly where the cheap one misses things.
   2. Everything else is read by the cheap model first, and re-read by the strong one when
        - it kept nothing, although triage said there was something to save, or
        - it is unsure of something it would keep (low confidence, or marked ambiguous). */
export const DENSE_KINDS = new Set(['recommendation_thread', 'list_or_ranking', 'private_chat', 'article_or_post']);
export const strongFirst = (triageKind) => DENSE_KINDS.has(triageKind);
export const ESCALATE_BELOW = 0.75;

const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/* The cheap model sometimes lists the site a screenshot is from as the thing to save
   ("Goodreads" on a Goodreads book page). Drop an item that is just the app's own name,
   unless the page really is about that app (a store or repo page for it). */
export function dropSelfNamed(out) {
  const app = nameKey(out?.app);
  if (!app || !Array.isArray(out?.items)) return out;
  const aboutTheApp = out.kind === 'software_or_repo' || out.kind === 'store_or_product_page';
  return { ...out, items: out.items.filter((t) => !(nameKey(t.title) === app && !(aboutTheApp && out.items.length === 1))) };
}
export const keptItems = (out) => (out?.items || []).filter((t) => t.is_thing && KEPT_ROLES.has(t.role));
export function needsSecondRead(out) {
  const kept = keptItems(out);
  if (!kept.length) return true;
  return kept.some((t) => (t.confidence ?? 0) < ESCALATE_BELOW || t.evidence === 'ambiguous');
}

export const SHOT_KINDS = ['media_page_or_poster', 'recommendation_thread', 'list_or_ranking', 'store_or_product_page', 'software_or_repo', 'audio', 'video',
  'place_or_map', 'food_or_recipe', 'article_or_post', 'private_chat', 'receipt_or_finance', 'personal_photo', 'meme_or_joke', 'system_or_app_ui', 'other'];

export const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['worth_saving', 'kind', 'note'],
  properties: {
    worth_saving: { type: 'boolean' },
    kind: { type: 'string', enum: SHOT_KINDS },
    note: { type: 'string', description: 'Five to twelve words on what the screenshot shows. No names of private people.' },
  },
};

export const TRIAGE_SYSTEM = 'You triage iPhone screenshots for one person\'s "things to check out" list.';
export const TRIAGE_PROMPT = [
  'Does this screenshot name or show at least one specific thing a person would save to check out later?',
  'That means a named: movie, TV show, anime, manga or comic, book, video game, board game, app or AI tool, code repository, podcast, album/artist/song, YouTube video or channel, restaurant/bar/shop/venue/travel spot, recipe, product to buy, or article to read.',
  'It can appear as a poster or cover, a store, streaming or map page, a list, or a post, thread or chat recommending it.',
  'Answer worth_saving=false for: receipts, banking, settings and system screens, calendars, navigation in progress, personal photos, memes with no named thing, and chats that name nothing specific.',
  'Text is small at this size. A discussion thread, comment section, list, search results or group chat that could plausibly contain recommendations counts as worth saving even when you cannot read the names: answer true and let the closer read decide.',
  'If unsure, answer true.',
].join(' ');

const TYPE_KEYS = CATEGORIES.map((c) => c.key).filter((k) => k !== 'other');
const str = (description) => ({ type: 'string', description });
const nullable = (description) => ({ type: ['string', 'null'], description });

export const PARSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'app', 'description', 'source_context', 'intent', 'items'],
  properties: {
    kind: { type: 'string', enum: SHOT_KINDS },
    app: str('App or site the screenshot is from, e.g. "Reddit", "Netflix", "Google Maps", "Instagram". Empty if unclear.'),
    description: str('One sentence on what the screenshot shows.'),
    source_context: str('Where this came from, short, e.g. \'Reddit r/MovieSuggestions: "Best slow-burn horror?"\' or \'Netflix title page\'. Never full names of private people (first names or usernames only). Empty if unclear.'),
    intent: { type: 'string', enum: ['recommendation', 'wishlist', 'reference', 'in_progress', 'unclear'], description: 'Why it was probably screenshotted.' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'type', 'is_thing', 'role', 'format', 'year', 'creator', 'recommended_by', 'why', 'quote', 'genres', 'season_episode', 'availability', 'price', 'location', 'url', 'evidence', 'adult', 'confidence'],
        properties: {
          title: str('Canonical name as listed on its main database or store, properly capitalised, no year. Expand obvious abbreviations ("TLOU" => "The Last of Us").'),
          type: { type: 'string', enum: TYPE_KEYS, description: 'movie | show | anime (Japanese animation, film or series) | manga (manga, manhwa, comics, light novels) | book | game (video game) | boardgame | software (apps, utilities, AI tools you install or sign up for) | repo (source repositories, libraries, CLIs, self-hosted projects) | podcast | music (album, artist or song) | video (YouTube/online video or channel) | place (restaurant, bar, shop, venue, park, travel spot) | recipe | product (a physical thing to buy) | article (article, essay, blog post, newsletter to read)' },
          is_thing: { type: 'boolean', description: 'true only if this is a specific named thing of that type. false for people, usernames, generic words, brands with no specific product, or anything merely sharing a name.' },
          role: { type: 'string', enum: ['subject', 'recommended', 'part_of_subject', 'incidental', 'advertisement'], description: 'subject = what the screenshot is about (the page, poster or listing it shows). recommended = one of several things a list, ranking, thread, post or chat recommends or discusses. part_of_subject = a track, episode, trailer, chapter, season, cast member or edition of the subject. incidental = merely visible (a nearby label on a map, a "related" or "you might also like" rail, navigation, another tab). advertisement = an ad, sponsored banner or promoted post.' },
          format: { type: ['string', 'null'], enum: ['film', 'series', null], description: 'For anime only: film or series. null otherwise.' },
          year: { type: ['integer', 'null'] },
          creator: nullable('Author, director, studio, developer, artist, host or brand when visible. null otherwise.'),
          recommended_by: nullable('Who recommends it: an online username, or ONLY the first name of a private person. Never a full name. null if none.'),
          why: str('Very short reason it was mentioned (e.g. "top-voted reply: like Arrival but darker"). Empty if none.'),
          quote: str('Up to 20 words quoted from the screenshot: a sentence of recommendation, review or description of this thing. Not metadata (format, status, dates, counts, ratings, button labels) and not just its title. Empty if there is no such sentence.'),
          genres: { type: 'array', items: { type: 'string' }, description: 'Up to 3 genres or tags.' },
          season_episode: nullable('For shows, anime and podcasts when a specific season or episode is shown, e.g. "S2E5". null otherwise.'),
          availability: nullable('Where it is shown as available, e.g. "Netflix", "Steam", "Game Pass", "in theaters". null if not shown.'),
          price: nullable('Price exactly as shown, e.g. "$19.99", "Free". null if not shown.'),
          location: nullable('For places: neighbourhood, city or address as shown. null otherwise.'),
          url: nullable('A URL or domain visible on screen for this item (e.g. "github.com/owner/name"). For repos, the owner/name slug if visible. null if none.'),
          evidence: { type: 'string', enum: ['recommended_or_discussed', 'poster_or_cover', 'store_or_listing_page', 'being_watched_or_used', 'ambiguous'] },
          adult: { type: 'boolean', description: 'true for pornographic/hentai/explicitly sexual works or ones promoted mainly for sexual content' },
          confidence: { type: 'number', description: '0-1: certainty that this exact thing is named or shown AND that its title and type are right.' },
        },
      },
    },
  },
};

export const PARSE_SYSTEM = [
  'You extract things worth checking out from iPhone screenshots for one person\'s personal list.',
  'List every distinct, specific, named thing the screenshot presents as something to watch, read, play, listen to, use, visit, cook, buy or read later (max 25), including ones recommended in comments or replies.',
  'Give every item a role. A page about one thing (an album, a podcast, a show, a book, one place on a map) has ONE subject: its tracks, episodes, trailers, chapters and editions are part_of_subject, and other labels on the map or in a related rail are incidental. In a list, ranking or thread recommending several things, each of those is recommended. Ads, sponsored banners and promoted posts are advertisement even when they name a real title.',
  'Only list what is actually on screen. Never invent a title, year, creator, price or location that is not visible or certain.',
  'Pick the type from context: "on Netflix", "season", "episodes" => show; "read", "author", "novel" => book; "play", "Steam", "Switch" => game; "listen", "episode", "hosted by" => podcast; a GitHub page, an owner/name slug or stars/forks => repo; an App Store page or "download the app" => software; a map pin, address, hours or star rating with a neighbourhood => place.',
  'For anime and manga, use the official English title when one exists ("Attack on Titan", not "Shingeki no Kyojin"); for a repository, the title is the repository name without the owner, and the owner/name slug goes in url.',
  'Japanese animation is type anime (set format film or series), never show or movie. Manga, manhwa, comics and light novels are type manga, not book.',
  'A game must be a video game you play, not an app used for work. A tool you clone or self-host is a repo; one you install from a store or sign up for is software.',
  'A tagline or description is not a name: "The After Effects killer", "the best budgeting app" or "a Notion alternative" are not things (is_thing=false) unless the real product name is also on screen, in which case list that name. For AI models and tools named in a benchmark or comparison chart, list each product once by its base name ("Kling", "Kimi"), not once per version or tier, and use confidence below 0.8 unless the screenshot is clearly recommending it.',
  'People, usernames, game-lobby player names, companies and brands with no specific product, and words that merely match a title are not things: set is_thing=false.',
  'Use low confidence and evidence=ambiguous when unsure.',
].join(' ');
export const PARSE_PROMPT = 'Extract everything worth saving from this screenshot.';

/* Only what the screenshot is about, or what it recommends, is kept. */
export const KEPT_ROLES = new Set(['subject', 'recommended']);

/* Types that are worth keeping without cover art: there is often none to find. */
export const ARTLESS_OK = new Set(['place', 'recipe', 'product', 'article', 'video', 'podcast', 'music', 'repo']);

/* Straight onto the list, or wait in the inbox for a look? Art is the bar for media; for
   types that rarely have art, a confident, unambiguous read is enough. Adult titles follow
   the same rules as everything else (the `adult` flag only hides them from guests on the site). */
export function decideStatusV2(cand, { poster = '', matched = false } = {}) {
  /* almost any screenshot of a post or thread can be read as "an article": always ask */
  if (cand.type === 'article') return 'inbox';
  if (poster) return 'todo';
  if (ARTLESS_OK.has(cand.type) && (cand.confidence ?? 0) >= 0.85 && cand.evidence !== 'ambiguous' && (matched || !!cand.url || cand.type !== 'repo')) return 'todo';
  return 'inbox';
}
