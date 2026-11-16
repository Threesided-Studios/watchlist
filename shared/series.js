/* Works out which series a title belongs to from the title alone, so fourteen
 * Wheel of Time books can be shown as one stack.
 *
 *   "A Crown of Swords: Book Seven of The Wheel of Time"      -> Wheel of Time, 7
 *   "A Dance of Cloaks (Shadowdance Series Book 1)"           -> Shadowdance, 1
 *   "Aboxageddon (Everybody Loves Large Chests Vol.13)"       -> Everybody Loves Large Chests, 13
 *   "All the Skills: Book 2: A Deck-Building LitRPG"          -> All the Skills, 2
 *
 * Returns { name, key, n } or null. Deliberately conservative: a title with no
 * explicit "Book N" / "Vol N" / "#N" marker is never guessed into a series.
 */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16 };
const num = (s) => { const v = String(s || '').toLowerCase().replace(/\.$/, ''); return WORDS[v] || (/^\d+(\.\d+)?$/.test(v) ? Number(v) : null); };
const MARK = '(?:book|bk\\.?|vol\\.?|volume|part|#)';
const NUM = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)';

function tidy(name) {
  return String(name || '')
    .replace(/^[\s:,\-–—'"‘’“”]+|[\s:,\-–—'"‘’“”]+$/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+(series|saga|trilogy|cycle|quartet|quintet|novels?|books?)$/i, '')
    .replace(/\s+/g, ' ').trim();
}
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const PATTERNS = [
  /* "... (Series Name, Book 3)" / "(Series Name Vol.13)" / "(Series Name #2)" */
  [new RegExp(`\\(([^()]{3,}?)[,:]?\\s*${MARK}\\s*${NUM}\\)\\s*$`, 'i'), (m) => [m[1], m[2]]],
  /* "...: Book Seven of The Wheel of Time" / "Book Three in the Accidental Traveler ..." */
  [new RegExp(`\\b${MARK}\\s*${NUM}\\s+(?:of|in)\\s+(?:the\\s+)?(.+)$`, 'i'), (m) => [m[2].replace(/\s*\(.*$/, ''), m[1]]],
  /* "Series Name: Book 2: subtitle" / "Series Name, Volume 4" */
  [new RegExp(`^(.{3,}?)[,:]?\\s+${MARK}\\s*${NUM}\\b`, 'i'), (m) => [m[1], m[2]]],
];

export function seriesOf(title) {
  const t = String(title || '');
  for (const [rx, pick] of PATTERNS) {
    const m = t.match(rx);
    if (!m) continue;
    const [rawName, rawN] = pick(m);
    const name = tidy(rawName), n = num(rawN);
    if (name.length < 3 || n === null) continue;
    return { name, key: keyOf(name), n };
  }
  return null;
}
