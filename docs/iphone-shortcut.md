# iPhone → Watchlist: the one-time Shortcut setup

iOS has no "a screenshot was just taken" trigger, so the phone side is a small
Shortcut that runs on a schedule (no tapping once it's set up) and sends recent
screenshots to the Watchlist inbox. Everything after that is automatic: an hourly
job reads them, adds the titles it's sure of, and parks the rest in
`/watchlist/inbox/` for a quick ✓ / ✕.

The upload URL (with its key) is in the vault under
**"Watchlist screenshot ingest"** → *Shortcut upload URL*.

## 1. Build the Shortcut (Shortcuts app → + → name it "Send to Watchlist")

1. **Find Photos** where
   - *Is a Screenshot* **is true**
   - *Date Taken* **is in the last** `2` **days**
   - Sort by *Date Taken*, *Latest First*, **Limit** on, `60`
2. **Repeat with Each** item in *Photos*
   1. **Convert** *Repeat Item* to **JPEG** (quality ~0.8). (Keeps uploads ~0.5 MB.)
   2. **Get Contents of URL**
      - URL: *the Shortcut upload URL from the vault*
      - Method: **POST**
      - Request Body: **File** → *Converted Image*
3. **End Repeat**

The server ignores anything it has already seen, so the 2-day overlap is free.

**Optional share-sheet use:** in the Shortcut's settings (ⓘ) turn on *Show in
Share Sheet* (accept Images). Then at the top add **If** *Shortcut Input* **has
any value** → *Repeat with each item in Shortcut Input* → same Convert + Get
Contents of URL → **Stop this Shortcut**. Now any screenshot can be sent instantly
from Photos → Share → Send to Watchlist.

## 2. Make it automatic (Shortcuts → Automation → + → Personal Automation)

- **Time of Day** → e.g. **11:00 PM**, **Daily** → **Run Immediately** (turn off
  *Notify When Run*) → action: **Run Shortcut** → *Send to Watchlist*.
- Optional faster trigger: **App** → *Reddit* (and/or *Photos*) → **Is Closed**
  → Run Immediately → *Send to Watchlist*. Screenshots from a Reddit session
  are then sent as soon as you leave the app.

First run: iOS asks once to allow the Shortcut to access Photos and to connect
to `watchlist-ingest.threesided.workers.dev`; choose **Always Allow**.

## Backlog

To send older screenshots once, temporarily change step 1 to *Date Taken is in
the last 365 days* (or remove the date filter), raise the limit, and run the
Shortcut by hand with the phone on Wi-Fi. Or drop files on the **⬆ Add
screenshots** button on `/watchlist/inbox/` (owner mode) from a Mac.
