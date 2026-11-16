/* Motion layer. Everything here is decoration: the site works the same with
 * it off, and it stays off for anyone who asks for reduced motion.
 *
 *   - three.js background scene (scene.js), loaded lazily
 *   - pointer spotlight and holographic tilt on cards
 *   - numbers that count up, sections that reveal as they scroll in
 *   - Lottie slots: lottieSlot('loader' | 'radar' | 'burst') plays
 *     assets/lottie/<name>.json. Replace a file to change the animation.
 */
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const motionOK = !calm;

/* ---------- three.js scene ---------- */
function initScene() {
  if (calm) return;
  const canvas = document.getElementById('scene');
  if (!canvas || !window.WebGLRenderingContext) return;
  /* after first paint, so it never delays the list */
  const go = () => import('./scene.js').then((m) => m.startScene(canvas)).catch(() => canvas.remove());
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(go);
}

/* ---------- pointer: spotlight + card tilt ---------- */
function initPointer() {
  if (calm || !matchMedia('(hover: hover)').matches) return;
  const root = document.documentElement;
  let x = 0, y = 0, queued = false, tilted = null;
  addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      root.style.setProperty('--px', `${x}px`);
      root.style.setProperty('--py', `${y}px`);
      const art = document.elementFromPoint(x, y)?.closest?.('.card-art');
      if (tilted && tilted !== art) { tilted.style.removeProperty('--rx'); tilted.style.removeProperty('--ry'); tilted.classList.remove('is-tilting'); }
      tilted = art || null;
      if (!art) return;
      const r = art.getBoundingClientRect();
      const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
      art.classList.add('is-tilting');
      art.style.setProperty('--ry', `${(fx - 0.5) * 16}deg`);
      art.style.setProperty('--rx', `${(0.5 - fy) * 14}deg`);
      art.style.setProperty('--gx', `${fx * 100}%`);
      art.style.setProperty('--gy', `${fy * 100}%`);
    });
  }, { passive: true });
}

/* ---------- count up ---------- */
export function countUp(node) {
  const raw = node.textContent;
  const m = raw.match(/^(\D*)([\d,]+(?:\.\d+)?)(.*)$/);
  if (calm || !m) return;
  const target = Number(m[2].replace(/,/g, ''));
  const decimals = (m[2].split('.')[1] || '').length;
  if (!target) return;
  const t0 = performance.now(), dur = 900 + Math.min(700, target / 4);
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    node.textContent = m[1] + (target * e).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + m[3];
    if (k < 1) requestAnimationFrame(tick); else node.textContent = raw;
  };
  requestAnimationFrame(tick);
}

/* ---------- reveal on scroll ---------- */
const REVEAL = '.shelf, .tile, .step, .feature, .cat, .chart, .cta, .review, .about-section > .about-h, .hero > *';
let io;
const show = (n) => {
  if (n.classList.contains('is-in')) return;
  n.classList.add('is-in');
  for (const v of n.matches('.tile') ? n.querySelectorAll('.tile-value') : []) countUp(v);
};
/* Call after a view renders: sections rise in as they enter the viewport, numbers count up.
   Content must never stay hidden waiting on this: anything already on screen is shown at
   once, and a timer shows whatever the observer has not reached (observers do not fire in
   background tabs). */
export function enliven(root = document) {
  if (calm) return;
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -6% 0px' });
  const fresh = [];
  let i = 0;
  for (const n of root.querySelectorAll(REVEAL)) {
    if (n.classList.contains('fx')) continue;
    n.classList.add('fx');
    n.style.setProperty('--d', `${Math.min(i++ % 8, 7) * 55}ms`);
    fresh.push(n);
  }
  if (!fresh.length) return;
  void root.offsetWidth;                       // commit the hidden state so the first reveal animates
  for (const n of fresh) {
    if (n.getBoundingClientRect().top < innerHeight) show(n); else io.observe(n);
  }
  setTimeout(() => { if (document.hidden) fresh.forEach(show); }, 1200);
  addEventListener('visibilitychange', () => { if (document.hidden) fresh.forEach(show); }, { once: true });
}

/* ---------- Lottie ---------- */
let lottieLoading;
function loadLottie() {
  lottieLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js';
    s.onload = () => resolve(window.lottie); s.onerror = reject;
    document.head.append(s);
  });
  return lottieLoading;
}
/* A box that plays assets/lottie/<name>.json. With reduced motion (or if the
   player cannot load) it stays an empty box and the caller's own content shows. */
export function lottieSlot(name, { loop = true, size = 120 } = {}) {
  const box = document.createElement('div');
  box.className = `lottie lottie-${name}`;
  box.style.width = box.style.height = `${size}px`;
  box.setAttribute('aria-hidden', 'true');
  if (!calm) {
    loadLottie().then((lottie) => {
      const a = lottie.loadAnimation({ container: box, renderer: 'svg', loop, autoplay: true, path: `/assets/lottie/${name}.json` });
      if (!loop) a.addEventListener('complete', () => box.remove());
    }).catch(() => {});
  }
  return box;
}
/* One-shot celebration over the page centre (kept, added, pinned). */
export function burst() {
  if (calm) return;
  const b = lottieSlot('burst', { loop: false, size: 220 });
  b.classList.add('lottie-overlay');
  document.body.append(b);
  setTimeout(() => b.remove(), 1500);
}

export function initFx() { initScene(); initPointer(); }
