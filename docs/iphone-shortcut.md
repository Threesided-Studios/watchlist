# iPhone → Watchlist: the one-time Shortcut setup

iOS has no "a screenshot was just taken" trigger, so the phone side is a small
Shortcut that runs on a schedule (no tapping once it's set up) and sends recent
screenshots to the Watchlist inbox. Everything after that is automatic: an hourly
job reads them, adds the titles it's sure of, and parks the rest in
`/watchlist/inbox/` for a quick ✓ / ✕.

The upload URL (with its key) is in the vault under
**"Watchlist screenshot ingest"** → *Shortcut upload URL*. Below it's written as
`UPLOAD_URL`.

## 1. Build the Shortcut (Shortcuts app → + → name it "Send to Watchlist")

1. **Find Photos** where
   - *Is a Screenshot* **is true**
   - *Date Taken* **is in the last** `2` **days**
   - Sort by *Date Taken*, *Latest First*, **Limit** on, `60`
2. **Repeat with Each** item in *Photos*
   1. **Get Details of Images** → *Name* (of *Repeat Item*)
   2. **Get Details of Images** → *Date Taken* (of *Repeat Item*)
   3. **Format Date** → *Date Taken* → Date Format **ISO 8601** (include time)
   4. **Convert** *Repeat Item* to **JPEG** (quality ~0.8). (Keeps uploads ~0.5 MB.)
   5. **Get Contents of URL**
      - URL: `UPLOAD_URL?name=`*Name*`&taken=`*Formatted Date*
      - Method: **POST**
      - Request Body: **File** → *Converted Image*
3. **End Repeat**

The name + date let the server recognise a screenshot it has already received,
even if iOS re-encodes it slightly differently, so overlapping runs are free.
(Steps 2.1–2.3 are optional; without them the server still dedupes identical
files.)

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

## 3. Backfill (send older screenshots once)

Duplicate the Shortcut (long-press → Duplicate) and name it **"Watchlist
Backfill"**. In the copy, change step 1:

- *Date Taken* **is in the last** `6` **months** (or whatever range you want)
- Sort *Oldest First*, turn **Limit off**

Then run it by hand **on Wi-Fi, plugged in, with the Shortcuts app open and
the screen on** (Settings → Display → Auto-Lock → Never for the duration helps).
It sends one screenshot at a time; a few thousand can take 30–60+ minutes.
Leave the daily automation pointed at the original (2-day) Shortcut.

Safe to stop and re-run at any time: anything already received is skipped in
well under a second. The hourly job reads the backlog in batches of up to ~600
per hour; titles show up on the list (or in the inbox) as each batch finishes.

### If the big run stops or times out

iOS sometimes kills very long Shortcut runs or runs out of memory on huge
photo lists. Send it in monthly chunks instead — edit step 1 to:

- *Date Taken* **is between** `Apr 1` **and** `Apr 30` (Limit off)

Run it, then change the dates to the next month and run again, until you reach
today. Re-running an overlapping month costs nothing (duplicates are skipped).

If a chunk is still too big, use half-months (1st–15th, 16th–end).

If the server ever answers *"inbox is full right now"* (it holds ~3.5 GB of
unread screenshots), just wait an hour or two for the hourly job to catch up
and run the same chunk again.

## Backlog alternative (Mac)

Drop files on the **⬆ Add screenshots** button on `/watchlist/inbox/` (owner
mode), e.g. after exporting screenshots from Photos on a Mac.
