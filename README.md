# Watchlist

A stylish, editable, image-rich media to-do list. Sourced from iPhone screenshots; deployed free as a static site (GitHub Pages).

Live at **https://watch.threesided.com** (GitHub Pages custom domain; the old threesided-studios.github.io/watchlist/ URL redirects there).

## Automatic screenshot ingest (current)

```
iPhone Shortcut (daily automation / share sheet)
   └─ POST image ─▶ watchlist-ingest Worker (ingest-worker/, Durable Object queue, keyed by SHA-256)
                        └─ hourly GitHub Action (.github/workflows/screenshot-ingest.yml → scripts/ingest/run.mjs)
                             1. gpt-6-luna on a 384px thumbnail: "any movie/show/anime/book/game here?"
                             2. gpt-6-luna on a 1024px image: titles, type, year, source context, who recommended, confidence
                             3. enrich: TMDB (if TMDB_API_KEY secret is set) → Wikipedia; Steam for games; Open Library for books
                             4. dedupe against data.json; confident + matched → list, otherwise status "inbox"
                             5. commit data.json + posters/ + scripts/ingest/ledger.json, then ack (image deleted from the queue)
```

- Review unsure finds at **/inbox/** (owner mode). ✓ Keep / ✕ Dismiss are applied on the next hourly run.
- Phone setup: [`docs/iphone-shortcut.md`](docs/iphone-shortcut.md).
- Local test: `cd scripts/ingest && npm i && OPENAI_API_KEY=… node run.mjs --local ~/some-screenshots --dry-run`.
- Secrets: repo `OPENAI_API_KEY`, `WATCHLIST_QUEUE_KEY`, optional `TMDB_API_KEY`; Worker `INGEST_KEY`, `QUEUE_KEY`, optional `GH_DISPATCH_TOKEN`, `TMDB_READ_TOKEN`.

The older Mac-only pipeline below (`pipeline/`, osxphotos + Vision OCR) still works for one-off bulk runs.

## Run the site locally

```bash
node scripts/dev-server.mjs        # http://localhost:8765
```

The dev server renders every page from `templates/page.html` and serves `data.min.json` straight from the working tree, so edits show on reload. To produce exactly what gets deployed:

```bash
node scripts/build-site.mjs --out _site
```

## Owner edits sync automatically

Ratings, status, notes, pins, category changes, adds and removals made in owner mode are posted to the ingest Worker (`POST /edit`, passphrase checked server-side) and committed to `data.json` by the next ingest run (`scripts/ingest/apply-edits.mjs`). The edit shows on the device immediately; other devices see it after that run deploys. The footer shows the sync state. **Export** remains as a manual backup.

The Worker starts the ingest workflow itself about two minutes after a screenshot or edit arrives (`repository_dispatch`), so nothing waits for the cron. This needs one Worker secret:

```bash
cd ingest-worker
npx wrangler secret put GH_DISPATCH_TOKEN   # fine-grained token, this repo only, Contents: read and write
npx wrangler deploy
```

Without the secret everything still works on the scheduled runs. `/status` reports `last_dispatch`.

Optional: `npx wrangler secret put TMDB_READ_TOKEN` enables movie/show search in the Add form (books, games, repos and everything else search without a key).

Screenshots that produced an item are kept at the Worker for 30 days, viewable only in owner mode from the item's detail sheet. Nothing is added to this repo.

Local Worker for development: `npx wrangler dev --local --var INGEST_KEY:test --var QUEUE_KEY:test --var OWNER_HASH:<sha256 of a test phrase>`, then in the browser console on localhost set `localStorage['watchlist.ingestUrl'] = 'http://127.0.0.1:8787'`.

## Categories and data shape

`shared/taxonomy.js` is the single definition of what the list tracks (movies, shows, anime, manga, books, games, board games, software, repos, podcasts, music, videos, places, recipes, products, articles). The site, the site build and the ingest all import it, so adding a category there adds its page, nav entry, card styling and dedupe family.

`shared/normalize.js` keeps `data.json` in the current shape (anime and repo types, one spelling per tag). It is idempotent; the ingest workflow runs `node scripts/normalize.mjs` before each commit, and the site build applies it again when writing `data.min.json`.

Tests: `node --test` in `shared/`, `assets/lib/` and `scripts/ingest/`.

## Run the ingest pipeline (test batch)

Prerequisites — see [`pipeline/README.md`](pipeline/README.md) for one-time setup (`osxphotos` install + Full Disk Access on Terminal).

```bash
pipeline/run.sh --limit 50
# optional, if the `claude` CLI is on PATH:
pipeline/run.sh --limit 50 --use-llm
```

Outputs: `data.json` + `posters/`. Review `pipeline/skipped.json` for what was excluded by the classifier.

## Deploy to GitHub Pages

**Gated.** No remote push happens without explicit approval. To deploy:

```bash
gh repo create watchlist --public --source=. --remote=origin --push
gh repo edit --enable-pages --pages-branch=main --pages-path=/
```

Then visit the Pages URL `gh` prints.

## Architecture

Two independent halves:

1. **Ingest pipeline** (`pipeline/`): `osxphotos` → Swift+Vision OCR → deterministic classifier (optional LLM second opinion) → dedup → Wikipedia enrichment (blurb, year, link, poster) → merged into `data.json`.
2. **Static site**: vanilla HTML/CSS/JS in `assets/`, one page template in `templates/page.html`, built by `scripts/build-site.mjs` (run by `.github/workflows/pages.yml`). Reads `data.min.json`, renders a poster-grid card UI with filter/search/inline-edit/drag-reorder/export/import.
