# Watchlist

A stylish, editable, image-rich media to-do list. Sourced from iPhone screenshots; deployed free as a static site (GitHub Pages).

Live at **https://watch.threesided.com** (GitHub Pages custom domain; the old threesided-studios.github.io/watchlist/ URL redirects there).

## Automatic screenshot ingest (current)

```
iPhone Shortcut (daily automation / share sheet)
   └─ POST image ─▶ watchlist-ingest Worker (ingest-worker/, Durable Object queue, keyed by SHA-256)
                        └─ hourly GitHub Action (.github/workflows/screenshot-ingest.yml → scripts/ingest/run.mjs)
                             1. gpt-4.1-nano on a 384px thumbnail: "any movie/show/anime/book/game here?"  (~$0.0001)
                             2. gpt-4.1-mini on a 1024px image: titles, type, year, source context, who recommended, confidence (~$0.002)
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
python3 -m http.server 8765
# open http://localhost:8765
```

All edits persist in `localStorage`. Use **Export** to download a fresh `data.json` and commit it back to the repo.

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
2. **Static site** (root): vanilla HTML/CSS/JS. Reads `data.json`, renders a poster-grid card UI with filter/search/inline-edit/drag-reorder/export/import.
