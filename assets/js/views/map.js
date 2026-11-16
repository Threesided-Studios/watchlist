/* Map of saved places. Places with coordinates get a pin; the rest are listed
 * underneath so nothing is hidden just because it has no address yet.
 * Leaflet is loaded on demand, only on this page. */
import { visibleItems, stage } from '../store.js';
import { el, emptyState } from '../card.js';

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';
let loading;
function loadLeaflet() {
  loading ||= new Promise((resolve, reject) => {
    document.head.append(el('link', { rel: 'stylesheet', href: `${LEAFLET}/leaflet.min.css` }));
    const s = el('script', { src: `${LEAFLET}/leaflet.min.js` });
    s.onload = () => resolve(window.L); s.onerror = reject;
    document.head.append(s);
  });
  return loading;
}

export function renderMap(root) {
  const places = visibleItems().filter((it) => it.type === 'place' && stage(it) !== 'skipped');
  const pinned = places.filter((it) => it.lat && it.lon);
  const loose = places.filter((it) => !(it.lat && it.lon));

  const head = el('header', { class: 'list-head' },
    el('h1', { class: 'list-title' }, '📍 Map', el('span', { class: 'pill', text: String(pinned.length) })),
    el('p', { class: 'lede', text: pinned.length ? `${pinned.length} of ${places.length} saved places have a confirmed address. Tap a pin for details.` : 'Places appear here once they have a confirmed address.' }));
  const box = el('div', { class: 'map', role: 'application', 'aria-label': 'Map of saved places' });
  const rest = loose.length ? el('section', { class: 'shelf' },
    el('header', { class: 'shelf-head' }, el('h2', { class: 'shelf-title', text: 'No address yet' }), el('span', { class: 'shelf-note', text: `${loose.length} places` })),
    el('ul', { class: 'log' }, loose.map((it) => el('li', { class: 'log-row' }, el('time', { text: it.location || 'location unknown' }), el('span', { class: 'log-what' }, el('a', { href: `#item=${encodeURIComponent(it.id)}`, text: it.title })))))) : null;

  root.replaceChildren(...[head, pinned.length ? box : emptyState('📍', 'No pins yet.', 'Places get a pin when their address is found.'), rest].filter(Boolean));
  document.getElementById('count').textContent = `${places.length} places`;
  if (!pinned.length) return;

  loadLeaflet().then((L) => {
    if (!box.isConnected) return;
    const map = L.map(box, { scrollWheelZoom: false, attributionControl: true });
    /* standard OpenStreetMap tiles, darkened in CSS (.map .leaflet-tile-pane) to sit with the site */
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const pts = [];
    for (const it of pinned) {
      const done = stage(it) === 'finished';
      const m = L.circleMarker([it.lat, it.lon], { radius: 9, weight: 2, color: '#f0f0ff', fillColor: done ? '#00d9ff' : '#ff006e', fillOpacity: 0.95 }).addTo(map);
      /* built as nodes, not an HTML string: titles come from screenshots */
      const pop = el('div', { class: 'map-pop' },
        el('strong', { text: it.title }), el('span', { text: it.address || it.location || '' }),
        el('a', { href: `#item=${encodeURIComponent(it.id)}`, text: 'Details' }), it.map_url && el('a', { href: it.map_url, target: '_blank', rel: 'noopener noreferrer', text: 'Directions ↗' }));
      m.bindPopup(pop);
      pts.push([it.lat, it.lon]);
    }
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
    map.on('click', () => map.scrollWheelZoom.enable());   // zoom by wheel only after the map is clicked, so the page still scrolls
  }).catch(() => box.replaceWith(emptyState('🗺', 'The map could not load.', 'Check the connection and reload.')));
}
