/* Explainer pages: /how-it-works/ (for visitors) and /pipeline/ (how it is built).
 * The numbers are live: item counts come from the loaded list, pipeline totals
 * from the ingest ledger (stamped into the page by scripts/build-site.mjs). */
import { CATEGORIES } from '../../../shared/taxonomy.js';
import { visibleItems, stage } from '../store.js';
import { el } from '../card.js';

const n = (v) => Number(v || 0).toLocaleString();

const hero = (kicker, title, lede, actions) => el('header', { class: 'hero' },
  el('p', { class: 'kicker', text: kicker }),
  el('h1', { class: 'hero-title' }, title),
  el('p', { class: 'hero-lede', text: lede }),
  el('div', { class: 'hero-actions' }, actions));

const section = (kicker, title, ...kids) => el('section', { class: 'about-section' },
  el('p', { class: 'kicker', text: kicker }), el('h2', { class: 'about-h', text: title }), ...kids);

const steps = (list) => el('ol', { class: 'steps' }, list.map(([title, body], i) =>
  el('li', { class: 'step' }, el('span', { class: 'step-n', text: String(i + 1).padStart(2, '0') }), el('h3', { text: title }), el('p', { text: body }))));

const cards = (list) => el('div', { class: 'feature-grid' }, list.map(([glyph, title, body]) =>
  el('article', { class: 'feature' }, el('span', { class: 'feature-glyph', 'aria-hidden': 'true', text: glyph }), el('h3', { text: title }), el('p', { text: body }))));

const stat = (value, label) => el('div', { class: 'tile' }, el('span', { class: 'tile-value', text: value }), el('span', { class: 'tile-label', text: label }));

export function renderHow(root, { openAdd }) {
  const items = visibleItems().filter((it) => stage(it) !== 'skipped');
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, items.filter((it) => it.type === c.key).length]));
  const live = CATEGORIES.filter((c) => counts[c.key]);
  const soon = CATEGORIES.filter((c) => !counts[c.key] && c.key !== 'other');

  root.replaceChildren(
    hero('how it works', ['One list for everything ', el('span', { class: 'grad', text: 'worth my time.' })],
      'Movies, shows, anime, books, games, apps and repos, collected from wherever I run into them. Most of it gets here from a screenshot, with no typing at all.',
      [el('a', { class: 'btn btn-primary', href: '/all/', text: 'Browse the list' }), el('button', { type: 'button', class: 'btn', text: '+ Suggest something', onclick: openAdd })]),

    el('section', { class: 'tiles' }, stat(n(items.length), 'things tracked'), stat(String(live.length), 'categories in use'),
      stat(n(items.filter((it) => stage(it) === 'backlog').length), 'still to get to'), stat(n(items.filter((it) => it.source === 'screenshot').length), 'found in screenshots')),

    section('the loop', 'From “that looks good” to on the list',
      steps([
        ['Spot it', 'A recommendation in a Reddit thread, a poster in a feed, a friend’s text, a store page. I take a screenshot and move on.'],
        ['It gets read', 'The screenshot is sent off automatically. An AI model reads it and pulls out every title it names, what kind of thing each one is, and who recommended it.'],
        ['It gets matched', 'Each title is looked up in the right database for its type, so it arrives with a year, a summary, a link and cover art.'],
        ['It lands here', 'Confident matches go straight onto the list. Anything uncertain waits in a review inbox for a quick keep or dismiss.'],
      ])),

    section('what’s on it', 'Every category, one place',
      el('div', { class: 'cat-grid' }, live.map((c) => el('a', { class: 'cat', href: `/${c.slug}/` },
        el('span', { class: 'cat-glyph', 'aria-hidden': 'true', text: c.glyph }), el('span', { class: 'cat-name', text: c.label }), el('span', { class: 'cat-n', text: n(counts[c.key]) })))),
      soon.length ? el('p', { class: 'about-note', text: `Ready and waiting for their first entries: ${soon.map((c) => c.label.toLowerCase()).join(', ')}.` }) : null),

    section('for visitors', 'What you can do here',
      cards([
        ['🔎', 'Browse and filter', 'Search everything at once, or open a category and narrow it by genre, decade, status or where it came from. Any filtered view has its own link you can share.'],
        ['👍', 'Recommend', 'Open anything and vote for it. What friends back rises into Friends’ picks, which is where I look when I can’t decide.'],
        ['＋', 'Suggest', 'Know something that belongs here? Send it with a note. It reaches me directly.'],
        ['🎲', 'Surprise', 'Stuck choosing? The dice picks something at random from the backlog of whatever you’re looking at.'],
      ])),

    section('for me', 'What keeps it useful',
      cards([
        ['▲', 'Up next', 'Anything can be pinned to the top of the home page, so the short list stays short.'],
        ['◐', 'Honest status', 'Each item moves from backlog to in progress to finished, with a verdict: loved it, liked it, or not for me.'],
        ['⇄', 'Edits that travel', 'A rating made on my phone shows up on my laptop. Changes sync in the background and are saved for good within minutes.'],
        ['🧾', 'Why it’s here', 'Every screenshot find remembers where it came from and who recommended it, so a title never shows up as a mystery six months later.'],
      ])),

    el('section', { class: 'cta' },
      el('h2', { text: 'Curious how it’s built?' }),
      el('p', { text: 'A phone shortcut, a small queue, a vision model and a static site. No app, no servers to babysit.' }),
      el('a', { class: 'btn btn-primary', href: '/pipeline/', text: 'See under the hood →' })),
  );
  document.getElementById('count').textContent = `${n(items.length)} items`;
}

export function renderPipeline(root, facts = {}) {
  const items = visibleItems();

  root.replaceChildren(
    hero('under the hood', ['A screenshot goes in. ', el('span', { class: 'grad', text: 'A list comes out.' })],
      'A phone shortcut, a small queue, a vision model and a static site. Here is each piece and what it does.',
      [el('a', { class: 'btn btn-primary', href: 'https://github.com/Threesided-Studios/watchlist', target: '_blank', rel: 'noopener noreferrer', text: 'Source on GitHub ↗' }), el('a', { class: 'btn', href: '/how-it-works/', text: 'The short version' })]),

    el('section', { class: 'tiles' },
      stat(n(facts.shots), 'screenshots read'), stat(n(facts.media), 'had something worth saving'),
      stat(n(items.length), 'items on the list')),

    section('the path', 'Five hops, no hands',
      steps([
        ['Phone', 'An iOS Shortcut runs on a schedule, finds recent screenshots and uploads them. Nothing to tap.'],
        ['Queue', 'A Cloudflare Worker receives each image and holds it in a Durable Object, keyed by its hash so the same screenshot is never read twice.'],
        ['Reader', 'A GitHub Action wakes up minutes later. A quick vision pass asks “is anything here worth saving?”, then a closer pass extracts every title with its type, year, source and a confidence score.'],
        ['Matcher', 'Each title is checked against the database for its kind and deduplicated against the list. Same-name collisions (a remake, a film versus a series) get a second look before the art is trusted.'],
        ['Site', 'The result is committed to the repository as plain JSON and the static site rebuilds. Screenshots are deleted after 30 days.'],
      ])),

    section('the parts', 'What each layer is made of',
      cards([
        ['📱', 'Capture', 'iOS Shortcuts automation, plus a drag-and-drop uploader in the inbox for anything from a desktop.'],
        ['☁️', 'Queue and sync', 'One Cloudflare Worker with a SQLite-backed Durable Object. It also receives my edits and tells GitHub when there is work to do.'],
        ['👁', 'Reading', 'OpenAI vision models with strict JSON schemas and a ledger so no image is read twice.'],
        ['🗂', 'Matching', 'TMDB for film and TV, AniList for anime and manga, Steam for games, Open Library for books, the App Store, Homebrew and GitHub for software, Wikipedia as a fallback.'],
        ['🧱', 'Storage', 'A single data.json in git. Every change is a commit, so the full history of the list is the repository history.'],
        ['⚡', 'Site', 'Hand-written HTML, CSS and JavaScript modules on GitHub Pages. No framework, installable as an app, works offline.'],
      ])),

    section('the rules', 'Decisions that keep it trustworthy',
      cards([
        ['✓', 'Art or inbox', 'A find only goes straight onto the public list when it has a verified match and cover art. Everything else waits for review.'],
        ['🔒', 'Private by default', 'Full names from personal messages are reduced to first names, adult titles stay owner-only, and screenshots never enter the public repository.'],
        ['↺', 'Self-healing', 'Each run checks that the live site matches the repository and redeploys if it has fallen behind.'],
        ['⏱', 'Two looks, not one', 'A quick first pass sets aside the screenshots that have nothing worth saving, so the careful read is spent only where it matters.'],
      ])),

    el('section', { class: 'cta' },
      el('h2', { text: 'Built by threesided' }),
      el('p', { text: 'A small studio that designs and ships web products, interactive experiences and AI-native tools.' }),
      el('a', { class: 'btn btn-primary', href: 'https://threesided.com/', target: '_blank', rel: 'noopener noreferrer', text: 'threesided.com ↗' })),
  );
  document.getElementById('count').textContent = `${n(items.length)} items`;
}
