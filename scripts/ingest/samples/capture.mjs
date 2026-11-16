// Captures phone-sized screenshots of public pages as test input for the ingest prompts.
//   node capture.mjs <out-dir>
// Used by .github/workflows/ingest-prompt-test.yml; nothing is committed.
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const PAGES = [
  ['hn-podcasts', 'https://hn.algolia.com/?q=podcast+recommendations&type=comment'],
  ['hn-books', 'https://news.ycombinator.com/item?id=38708627'],
  ['github-repo', 'https://github.com/jordanbaird/Ice'],
  ['github-trending', 'https://github.com/trending'],
  ['spotify-album', 'https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv'],
  ['spotify-podcast', 'https://open.spotify.com/show/2hmkzUtix0qTqvtpPcMzEL'],
  ['bgg-game', 'https://boardgamegeek.com/boardgame/174430/gloomhaven'],
  ['letterboxd', 'https://letterboxd.com/film/past-lives/'],
  ['anilist-manga', 'https://anilist.co/manga/30002/Berserk/'],
  ['anilist-anime', 'https://anilist.co/anime/154587/Frieren-Beyond-Journeys-End/'],
  ['steam', 'https://store.steampowered.com/app/1145350/Hades_II/'],
  ['recipe', 'https://www.seriouseats.com/the-best-chili-recipe'],
  ['eater-list', 'https://sf.eater.com/maps/best-restaurants-san-francisco-38'],
  ['osm-place', 'https://www.openstreetmap.org/search?query=Tartine%20Bakery%20San%20Francisco'],
  ['youtube', 'https://www.youtube.com/watch?v=aircAruvnKk'],
  ['article', 'https://www.theverge.com/tech'],
  ['product', 'https://www.rei.com/product/176033/patagonia-nano-puff-jacket-mens'],
  ['goodreads', 'https://www.goodreads.com/book/show/44767458-dune'],
  ['wiki-settings-like', 'https://en.wikipedia.org/wiki/Special:Preferences'],
  ['weather', 'https://wttr.in/San+Francisco'],
];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 14'], locale: 'en-US' });
  for (const [name, url] of PAGES) {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      console.log('ok  ', name, (await page.title()).slice(0, 60));
    } catch (e) { console.log('FAIL', name, String(e).slice(0, 80)); }
    await page.close();
  }
  await browser.close();
})();
