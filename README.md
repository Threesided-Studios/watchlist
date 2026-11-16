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
- Secrets: repo `OPENAI_API_KEY`, `WATCHLIST_QUEUE_KEY`, optional `TMDB_API_KEY`; Worker `INGEST_KEY`, `QUEUE_KEY`.

The older Mac-only pipeline below (`pipeline/`, osxphotos + Vision OCR) still works for one-off bulk runs.

## Run the site locally

```bash
node scripts/dev-server.mjs        # http://localhost:8765
```

The dev server renders every page from `templates/page.html` and serves `data.min.json` straight from the working tree, so edits show on reload. To produce exactly what gets deployed:

```bash
node scripts/build-site.mjs --out _site
```

All edits persist in `localStorage`. Use **Export** to download a fresh `data.json` and commit it back to the repo.

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
