/* The background scene: a field of drifting points and wireframe solids in the
 * three signal colours, with a large nested tetrahedron (three sides, the
 * threesided mark) that turns toward the pointer. Loaded lazily by fx.js, only
 * when motion is welcome; it pauses whenever the tab is hidden. */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';

const COLORS = [0xff006e, 0x00d9ff, 0xfff95b];

export function startScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(0, 0, 26);

  /* points */
  const N = innerWidth < 760 ? 500 : 1100;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 90;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 60;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    c.setHex(COLORS[i % 3]).multiplyScalar(0.5 + Math.random() * 0.5);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.13, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(points);

  /* wireframe solids */
  const wire = (geo, color, opacity = 0.7) => new THREE.LineSegments(new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));

  /* the mark: nested tetrahedra, upper right, like the hero on threesided.com */
  const mark = new THREE.Group();
  mark.add(wire(new THREE.TetrahedronGeometry(7.5), COLORS[0], 0.9), wire(new THREE.TetrahedronGeometry(4.8), COLORS[1], 0.85), wire(new THREE.TetrahedronGeometry(2.6), COLORS[2], 0.8));
  mark.children[1].rotation.set(0.6, 1.1, 0.2);
  mark.children[2].rotation.set(1.2, 0.3, 0.9);
  scene.add(mark);

  const drifters = [];
  const shapes = [() => new THREE.TetrahedronGeometry(1), () => new THREE.OctahedronGeometry(1), () => new THREE.IcosahedronGeometry(1)];
  for (let i = 0; i < 14; i++) {
    const m = wire(shapes[i % 3](), COLORS[i % 3], 0.35 + Math.random() * 0.3);
    m.scale.setScalar(0.5 + Math.random() * 1.6);
    m.position.set((Math.random() - 0.5) * 70, (Math.random() - 0.5) * 44, -6 - Math.random() * 34);
    m.userData = { spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.5), bob: Math.random() * 6.28, y: m.position.y };
    drifters.push(m); scene.add(m);
  }

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    /* keep the mark in the upper right whatever the aspect */
    const wide = w / h;
    mark.position.set(Math.min(16, 9 * wide), 5, -4);
    mark.scale.setScalar(w < 760 ? 0.55 : 1);
  }
  resize();
  addEventListener('resize', resize);

  const pointer = { x: 0, y: 0 }, eased = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => { pointer.x = e.clientX / innerWidth - 0.5; pointer.y = e.clientY / innerHeight - 0.5; }, { passive: true });

  let raf = 0, last = performance.now(), t = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    eased.x += (pointer.x - eased.x) * 0.04; eased.y += (pointer.y - eased.y) * 0.04;
    const scroll = scrollY / Math.max(1, innerHeight);

    points.rotation.y = t * 0.012 + eased.x * 0.25;
    points.rotation.x = eased.y * 0.18;
    points.position.y = scroll * 3;

    mark.rotation.y = t * 0.16 + eased.x * 1.1;
    mark.rotation.x = 0.35 + eased.y * 0.8 + scroll * 0.5;
    mark.children[1].rotation.y -= dt * 0.35;
    mark.children[2].rotation.x += dt * 0.6;
    mark.position.y = 5 + scroll * 7;          /* drifts up and away as you scroll */

    for (const d of drifters) {
      d.rotation.x += d.userData.spin.x * dt; d.rotation.y += d.userData.spin.y * dt; d.rotation.z += d.userData.spin.z * dt;
      d.position.y = d.userData.y + Math.sin(t * 0.4 + d.userData.bob) * 1.4 + scroll * 2;
    }
    camera.position.x = eased.x * 2.4; camera.position.y = -eased.y * 1.6;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  const play = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  const pause = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
  play();
  canvas.classList.add('is-live');
}
