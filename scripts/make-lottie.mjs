#!/usr/bin/env node
/* Generates the small Lottie animations the site ships with, in the site palette.
 *
 *   node scripts/make-lottie.mjs      writes assets/lottie/{loader,radar,burst}.json
 *
 * They fill named slots (see assets/js/fx.js: lottieSlot). To use a designed
 * animation instead, drop a Lottie JSON with the same file name into
 * assets/lottie/ and it is picked up as is.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'assets', 'lottie');
const MAGENTA = [1, 0, 0.431, 1], CYAN = [0, 0.851, 1, 1], YELLOW = [1, 0.976, 0.357, 1];
const FR = 60;

const fixed = (k) => ({ a: 0, k });
const ease = { i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } };
const linear = { i: { x: [1], y: [1] }, o: { x: [0], y: [0] } };
/* keys: [[frame, value], ...]; value is a number or an array */
const anim = (keys, curve = linear) => ({ a: 1, k: keys.map(([t, s], i) => ({ t, s: [].concat(s), ...(i < keys.length - 1 ? curve : {}) })) });

const transform = ({ o = fixed(100), r = fixed(0), p = fixed([100, 100, 0]), s = fixed([100, 100, 100]) } = {}) => ({ o, r, p, a: fixed([0, 0, 0]), s });
const groupTr = { ty: 'tr', p: fixed([0, 0]), a: fixed([0, 0]), s: fixed([100, 100]), r: fixed(0), o: fixed(100) };
const stroke = (c, w) => ({ ty: 'st', c: fixed(c), o: fixed(100), w: fixed(w), lc: 2, lj: 2 });
const polygon = (points, radius) => ({ ty: 'sr', sy: 2, d: 1, pt: fixed(points), p: fixed([0, 0]), r: fixed(0), or: fixed(radius), os: fixed(0) });
const circle = (size) => ({ ty: 'el', d: 1, s: fixed([size, size]), p: fixed([0, 0]) });
const line = (x1, y1, x2, y2) => ({ ty: 'sh', ks: fixed({ i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], v: [[x1, y1], [x2, y2]], c: false }) });

const layer = (ind, nm, shapes, ks, op) => ({ ddd: 0, ind, ty: 4, nm, sr: 1, ks: transform(ks), ao: 0, shapes: [{ ty: 'gr', nm, it: [...shapes, groupTr] }], ip: 0, op, st: 0, bm: 0 });
const doc = (nm, op, layers) => ({ v: '5.7.4', fr: FR, ip: 0, op, w: 200, h: 200, nm, ddd: 0, assets: [], layers });

/* loader: three nested triangles counter-rotating, breathing */
const loader = doc('loader', 180, [
  layer(1, 'inner', [polygon(3, 26), stroke(YELLOW, 5)], { r: anim([[0, 0], [180, 360]]), s: anim([[0, [100, 100, 100]], [90, [70, 70, 100]], [180, [100, 100, 100]]], ease) }, 180),
  layer(2, 'mid', [polygon(3, 52), stroke(CYAN, 5)], { r: anim([[0, 0], [180, -240]]) }, 180),
  layer(3, 'outer', [polygon(3, 80), stroke(MAGENTA, 5)], { r: anim([[0, 0], [180, 120]]), s: anim([[0, [100, 100, 100]], [90, [108, 108, 100]], [180, [100, 100, 100]]], ease) }, 180),
]);

/* radar: rings pulse outward while a sweep turns; for empty states */
const ring = (ind, delay, color) => layer(ind, `ring${ind}`, [circle(160), stroke(color, 3)], {
  s: anim([[delay, [10, 10, 100]], [delay + 120, [100, 100, 100]]], { i: { x: [0.2], y: [1] }, o: { x: [0.3], y: [0] } }),
  o: anim([[delay, 100], [delay + 120, 0]]),
}, 240);
const radar = doc('radar', 240, [
  layer(1, 'sweep', [line(0, 0, 0, -80), stroke(YELLOW, 4)], { r: anim([[0, 0], [240, 720]]) }, 240),
  layer(2, 'core', [polygon(3, 12), stroke(YELLOW, 4)], { r: anim([[0, 0], [240, -360]]) }, 240),
  ring(3, 0, CYAN), ring(4, 60, MAGENTA), ring(5, 120, CYAN),
]);

/* burst: one-shot confirmation; plays once when something is kept or added */
const spoke = (ind, angle, color) => layer(ind, `spoke${ind}`, [line(0, -30, 0, -44), stroke(color, 5)], {
  r: fixed(angle), s: anim([[0, [40, 40, 100]], [36, [210, 210, 100]]], { i: { x: [0.1], y: [1] }, o: { x: [0.2], y: [0] } }), o: anim([[0, 100], [24, 100], [42, 0]]),
}, 48);
const burst = doc('burst', 48, [
  layer(1, 'tri', [polygon(3, 30), stroke(CYAN, 6)], { r: anim([[0, -60], [30, 0]], ease), s: anim([[0, [0, 0, 100]], [20, [125, 125, 100]], [32, [100, 100, 100]]], ease), o: anim([[0, 100], [36, 100], [48, 0]]) }, 48),
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => spoke(i + 2, a, [MAGENTA, YELLOW, CYAN][i % 3])),
]);

mkdirSync(OUT, { recursive: true });
for (const [name, d] of Object.entries({ loader, radar, burst })) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(d));
  console.log(`assets/lottie/${name}.json  ${d.layers.length} layers, ${(d.op / FR).toFixed(1)}s`);
}
