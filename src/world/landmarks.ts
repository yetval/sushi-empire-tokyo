// Hero landmarks: one or two instantly recognisable set pieces per district, built as original, respectful
// interpretations (no replicas, no real brands). Everything static is merged into the district's Builders
// (main builder near the street, the no-shadow far builder for skyline pieces), so the cost is a handful of
// extra draw calls: the giant lantern, the LED screens and nothing else get their own meshes.
//
// Hook (district.ts, buildDistrict): landmarks(id, ctx) right after the layout is built.
import * as THREE from 'three';
import { DistrictId } from '../core/data';
import { short } from '../core/format';
import { GameState } from '../core/state';
import { Builder, FONT, G, glow } from './kit';
import { PALETTE as P, bevelBox } from './materials';

interface Hook { b: Builder; group: THREE.Group; extras: ((dt: number, s: GameState | null) => void)[]; far?: Builder }

export function landmarks(id: DistrictId, ctx: Hook): void {
  ({ asakusa, shibuya, shinjuku, ginza } as Record<DistrictId, (c: Hook) => void>)[id]?.(ctx);
}

// ---------------------------------------------------------------- shared helpers
const MINCHO = "'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP',serif";
const GOLD = '#c99a3c', BRONZE = '#7a6243';

/** Bottom-centred bevelled box (own copy: Builder bakes transforms into it). */
const bb = (w: number, h: number, d: number, r?: number) => bevelBox(w, h, d, r).clone().translate(0, h / 2, 0);
function box(b: Builder, x: number, y: number, z: number, w: number, h: number, d: number, color: string, o: { glow?: string; ry?: number; roof?: boolean; r?: number } = {}): void {
  b.add(bb(w, h, d, o.r), color, { at: [x, y, z], rot: [0, o.ry ?? 0, 0], glow: o.glow, roof: o.roof });
}

/** Prism with chamfered corners (footprint w×d, corner cut c), bottom at y=0. */
function prism(w: number, d: number, c: number, h: number): THREE.BufferGeometry {
  const x = w / 2, z = d / 2;
  const pts = [[-x + c, -z], [x - c, -z], [x, -z + c], [x, z - c], [x - c, z], [-x + c, z], [-x, z - c], [-x, -z + c]];
  return new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, q]) => new THREE.Vector2(a, q))), { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2);
}

/** Closed curved hip roof: concave slopes, upswept corners, base at y=0, eave half-sizes rx/rz. */
function curvedRoof(rx: number, rz: number, H: number, lift: number, thick: number, n = 12): THREE.BufferGeometry {
  const pos: number[] = [];
  const top = (u: number, v: number): THREE.Vector3 => {
    const d = Math.max(Math.abs(u), Math.abs(v));
    const corner = Math.pow(Math.abs(u * v), 3);
    const flare = 1 + 0.06 * corner;
    return new THREE.Vector3(u * rx * flare, H * Math.pow(1 - d, 1.25) + lift * corner * Math.pow(d, 4), v * rz * flare);
  };
  const bot = (u: number, v: number) => top(u, v).setY(top(u, v).y - thick);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, want: THREE.Vector3) => {
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nrm.dot(want) < 0) [b, c] = [c, b];
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const up = new THREE.Vector3(0, 1, 0), down = new THREE.Vector3(0, -1, 0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const u0 = -1 + (2 * i) / n, u1 = -1 + (2 * (i + 1)) / n, v0 = -1 + (2 * j) / n, v1 = -1 + (2 * (j + 1)) / n;
    tri(top(u0, v0), top(u0, v1), top(u1, v1), up); tri(top(u0, v0), top(u1, v1), top(u1, v0), up);
    tri(bot(u0, v0), bot(u0, v1), bot(u1, v1), down); tri(bot(u0, v0), bot(u1, v1), bot(u1, v0), down);
  }
  // fascia skirt around the eave
  for (let i = 0; i < n; i++) {
    const a = -1 + (2 * i) / n, c = -1 + (2 * (i + 1)) / n;
    for (const [p, q, out] of [[[a, -1], [c, -1], [0, 0, -1]], [[a, 1], [c, 1], [0, 0, 1]], [[-1, a], [-1, c], [-1, 0, 0]], [[1, a], [1, c], [1, 0, 0]]] as [number[], number[], number[]][]) {
      const w = new THREE.Vector3(...out);
      const t0 = top(p[0], p[1]), t1 = top(q[0], q[1]), b0 = bot(p[0], p[1]), b1 = bot(q[0], q[1]);
      tri(t0, t1, b1, w); tri(t0, b1, b0, w);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const lathe = (pts: [number, number][], seg = 32) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
const seeded = (seed: number) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

// ================================================================ ASAKUSA
function asakusa({ b, group, extras }: Hook): void {
  giantLantern(group, extras, 0, -9.5);
  pagoda(b, 21, -62);
}

/** The gate's great paper lantern: a ribbed chochin with brushed (invented) characters, glowing at night.
 *  Sized to fully sheath the gate's original lantern primitive. */
function giantLantern(group: THREE.Group, extras: Hook['extras'], x: number, z: number): void {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 384;
  const g = c.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, 0, 384);
  bg.addColorStop(0, '#8e2318'); bg.addColorStop(0.12, '#c4321f'); bg.addColorStop(0.5, '#d23a24'); bg.addColorStop(0.88, '#c4321f'); bg.addColorStop(1, '#8e2318');
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 384);
  for (let y = 6; y < 384; y += 13) { g.fillStyle = 'rgba(60,10,6,0.22)'; g.fillRect(0, y, 1024, 2); g.fillStyle = 'rgba(255,190,150,0.10)'; g.fillRect(0, y + 2, 1024, 1); }
  const glyphs = (cx: number, a: string, bq: string, px: number) => {
    g.font = `900 ${px}px ${MINCHO}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#17100e';
    for (const ox of [0, 1024, -1024]) { g.fillText(a, cx + ox, 172); g.fillText(bq, cx + ox, 296); }
  };
  glyphs(0, '雲', '門', 122); // front (u=0 faces the road)
  glyphs(512, '福', '寿', 116); // back
  g.font = `700 46px ${MINCHO}`; g.fillStyle = '#1b1210'; g.textAlign = 'center';
  for (const cx of [256, 768]) { g.fillText('奉', cx, 200); g.fillText('納', cx, 256); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.1, roughness: 0.75 });
  const paper = new THREE.Mesh(lathe([[1.16, 0], [1.3, 0.2], [1.41, 0.5], [1.47, 0.95], [1.49, 1.6], [1.47, 2.25], [1.41, 2.7], [1.3, 3.05]], 40), m);
  paper.position.set(x, 2.15, z);
  paper.castShadow = true;
  // lacquered caps with gold trim
  const cap = new THREE.Mesh(
    mergeAll([
      lathe([[0, 0], [1.06, 0], [1.12, 0.06], [1.12, 0.26], [1.18, 0.3], [0, 0.3]], 32).translate(0, -0.12, 0),
      lathe([[0, 0], [1.33, 0], [1.33, 0.06], [1.24, 0.27], [0, 0.27]], 32).translate(0, 3.03, 0),
    ]),
    new THREE.MeshStandardMaterial({ color: '#1f1714', roughness: 0.35, metalness: 0.2 }));
  cap.position.set(x, 2.15, z);
  const trim = new THREE.Mesh(mergeAll([
    new THREE.TorusGeometry(1.14, 0.035, 6, 40).rotateX(Math.PI / 2).translate(0, 0.17, 0),
    new THREE.TorusGeometry(1.33, 0.035, 6, 40).rotateX(Math.PI / 2).translate(0, 3.05, 0),
  ]), new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.8 }));
  trim.position.set(x, 2.15, z);
  group.add(paper, cap, trim);
  extras.push(() => { m.emissiveIntensity = 0.08 + glow.value * 1.15; });
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = gs.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of out) { if (g.attributes.uv) g.deleteAttribute('uv'); }
  const pos: number[] = [], nrm: number[] = [];
  for (const g of out) { pos.push(...(g.attributes.position.array as Float32Array)); nrm.push(...(g.attributes.normal.array as Float32Array)); }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return m;
}

/** Five-storey pagoda: plastered bodies with vermilion posts, floodlit bracket bands, swept roofs and a bronze
 *  finial with nine rings. Sheaths the courtyard's earlier block pagoda at the same spot. Front faces -x. */
function pagoda(b: Builder, x: number, z: number): void {
  b.push(x, 0, z, -Math.PI / 2);
  box(b, 0, 0, 0, 8.2, 0.5, 8.2, '#c9c2b4', { r: 0.08 });
  box(b, 0, 0.5, 0, 7.3, 0.5, 7.3, '#d8d1c3', { r: 0.06 });
  for (let i = 0; i < 3; i++) box(b, 0, i * 0.33, 4.35 + (2 - i) * 0.35, 2.4, 0.33, 0.36, '#d8d1c3', { r: 0.03 }); // steps (front)
  const VER = '#b8301f', VERD = '#8f2418', WALL = '#efe4cf', TIMB = '#4a3226';
  for (let f = 0; f < 5; f++) {
    const W = 5.0 - 0.5 * f, Y = 0.8 + 3.2 * f, y0 = Math.max(Y, 1.0), bh = Y + 2.05 - y0;
    if (f > 0) {
      box(b, 0, Y - 0.05, 0, W + 1.0, 0.12, W + 1.0, TIMB); // balcony deck
      for (const s of [-1, 1]) {
        box(b, 0, Y + 0.62, s * (W / 2 + 0.42), W + 0.9, 0.07, 0.07, VER); box(b, s * (W / 2 + 0.42), Y + 0.62, 0, 0.07, 0.07, W + 0.9, VER);
        for (const t of [-1, 0, 1]) { box(b, t * (W / 2 + 0.42), Y, s * (W / 2 + 0.42), 0.08, 0.66, 0.08, VER); box(b, s * (W / 2 + 0.42), Y, t * (W / 2 + 0.42), 0.08, 0.66, 0.08, VER); }
      }
    }
    box(b, 0, y0, 0, W, bh, W, WALL, { r: 0.04 });
    // posts, sill and head beams
    for (const px of [-1, -1 / 3, 1 / 3, 1]) for (const s of [-1, 1]) {
      b.cyl(px * W / 2, y0, s * W / 2, 0.13, 0.13, bh, VER, 8); b.cyl(s * W / 2, y0, px * W / 2, 0.13, 0.13, bh, VER, 8);
    }
    for (const yy of [y0 + 0.05, Y + 1.72]) for (const s of [-1, 1]) { box(b, 0, yy, s * (W / 2 + 0.02), W + 0.1, 0.18, 0.12, VER); box(b, s * (W / 2 + 0.02), yy, 0, 0.12, 0.18, W + 0.1, VER); }
    // doors (centre bay) and lattice windows (side bays) on all four faces
    for (let k = 0; k < 4; k++) {
      b.push(0, 0, 0, (k * Math.PI) / 2);
      box(b, 0, y0 + 0.25, W / 2 + 0.01, W / 3 - 0.35, 1.35, 0.08, VERD, { glow: '#ffb36b' });
      for (const dx of [-0.17, 0.17]) for (let r = 0; r < 3; r++) b.sphere(dx * (W / 3 - 0.35) * 2.2, y0 + 0.55 + r * 0.38, W / 2 + 0.06, 0.035, GOLD);
      for (const s of [-1, 1]) {
        box(b, s * W / 3, y0 + 0.55, W / 2 + 0.01, W / 3 - 0.55, 0.9, 0.06, '#3a2a22');
        for (let i = 0; i < 5; i++) box(b, s * W / 3 + (i - 2) * ((W / 3 - 0.65) / 4), y0 + 0.55, W / 2 + 0.05, 0.05, 0.9, 0.05, '#d9cdb5');
      }
      // bracket clusters under the eave
      for (let i = 0; i < 5; i++) box(b, (i - 2) * (W / 4.4), Y + 1.9, W / 2 + 0.28, 0.28, 0.2, 0.42, VER);
      b.pop();
    }
    // floodlit bracket band and the swept roof
    box(b, 0, Y + 2.02, 0, W + 0.9, 0.26, W + 0.9, TIMB, { glow: '#ffb070' });
    const R = (8.6 - 0.6 * f) / 2;
    b.add(curvedRoof(R, R, 1.8, 0.6, 0.26), P.roofSlate, { at: [0, Y + 2.25, 0], roof: true });
    // corner bells
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const k = R * 1.04;
      b.cyl(sx * k, Y + 2.25 + 0.05, sz * k, 0.02, 0.02, 0.5, BRONZE, 4);
      b.add(G.cone(0.13, 0.26, 8), GOLD, { at: [sx * k, Y + 2.05, sz * k], glow: '#ffcc66' });
    }
  }
  // sorin: bronze finial with nine rings, water-flame and jewel
  const T = 17.15;
  box(b, 0, T, 0, 1.1, 0.55, 1.1, BRONZE);
  b.add(G.sphere(0.6, 16, 8), BRONZE, { at: [0, T + 0.75, 0], scale: [1, 0.55, 1] });
  b.cyl(0, T + 0.5, 0, 0.42, 0.42, 5.2, BRONZE, 12);
  for (let i = 0; i < 9; i++) b.add(new THREE.TorusGeometry(0.62, 0.075, 6, 20).rotateX(Math.PI / 2), GOLD, { at: [0, T + 1.0 + i * 0.5, 0] });
  b.cyl(0, T + 5.6, 0, 0.16, 0.18, 2.8, GOLD, 8);
  for (const ry of [0, Math.PI / 2]) b.add(G.box(1.0, 1.2, 0.05), GOLD, { at: [0, T + 6.0, 0], rot: [0, ry, 0] });
  b.add(G.sphere(0.26, 12, 8), GOLD, { at: [0, T + 7.55, 0] });
  b.add(G.cone(0.2, 0.55, 10), GOLD, { at: [0, T + 7.7, 0] });
  b.collide(0, 0, 8.2, 8.2, 3);
  b.pop();
}

// ================================================================ SHIBUYA
function shibuya({ b, group, extras }: Hook): void {
  // four screen towers on the corner blocks behind the frontage, every screen turned to the scramble
  const towers: [number, number, number, string, number][] = [
    [34, -34, -Math.PI / 4, '#ddd3c4', 0], [-34, -34, Math.PI / 4, '#d2c9d8', 1],
    [-34, 34, (3 * Math.PI) / 4, '#d8b8a2', 2], [34, 34, (-3 * Math.PI) / 4, '#c9cdc8', 3],
  ];
  const screens: LedScreen[] = [];
  for (const [x, z, ry, col, k] of towers) {
    const sy = [74, 62, 60, 66][k], H = sy + 13 + (k % 2) * 4;
    screenTower(b, x, z, ry, H, col, k, sy);
    const sc = new LedScreen(15, 8.4, k);
    const fwd = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
    sc.mesh.position.set(x, sy + 4.2, z).addScaledVector(fwd, 5.55);
    sc.mesh.rotation.y = ry;
    group.add(sc.mesh); screens.push(sc);
  }
  extras.push((dt, s) => { for (const sc of screens) sc.update(dt, s); });
}

/** 10×10 tower turned to face the crossing: banded floors, lit window strips, corner LED fin, screen frame. */
function screenTower(b: Builder, x: number, z: number, ry: number, H: number, col: string, k: number, sy: number): void {
  const r = seeded(77 + k * 13);
  b.push(x, 0, z, ry);
  b.add(prism(10, 10, 0.9, H), col);
  for (let f = 0; f * 3.6 + 4 < H - 2; f++) {
    const y = 4 + f * 3.6;
    for (let s = 0; s < 4; s++) {
      b.push(0, 0, 0, (s * Math.PI) / 2);
      if (!(s === 0 && y > sy - 2 && y < sy + 9)) b.add(G.box(8.0, 1.7, 0.08), '#4d5b68', { at: [0, y + 0.9, 5.0], glow: r() < 0.5 ? ['#ffcf8a', '#ffe2b0', '#f2c98e'][Math.floor(r() * 3)] : '#000000' });
      b.add(G.box(8.4, 0.22, 0.2), '#efe9df', { at: [0, y, 5.02] });
      b.pop();
    }
  }
  // corner LED fin on the facing edge + rooftop crown
  const fin = ['#ff6b3d', '#ffb347', '#ff5aa8', '#46dcff'][k];
  b.add(G.box(0.35, H - 8, 0.35), '#2b2a30', { at: [-4.75, 4, 4.75], rot: [0, Math.PI / 4, 0], glow: fin });
  b.add(prism(10.4, 10.4, 1.0, 0.6), '#efe9df', { at: [0, H, 0] });
  box(b, 1.5, H + 0.6, -1.5, 4, 2.6, 4, '#bdb8b0');
  b.add(G.sphere(0.3, 8, 6), '#ff3b3b', { at: [1.5, H + 3.5, -1.5], glow: '#ff2020' });
  // screen frame
  box(b, 0, sy - 0.45, 5.25, 16.0, 9.3, 0.5, '#1d1d22', { r: 0.12 });
  for (const sx of [-7.2, 7.2]) b.add(G.box(0.3, 1.2, 0.8), '#3b3e44', { at: [sx, sy - 1.5, 5.2] });
  b.pop();
}

/** Animated LED billboard with original content: the player's sushi brand, waves, a live counter, ribbons. */
class LedScreen {
  canvas = document.createElement('canvas');
  tex: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private t: number;
  private acc = 1;
  constructor(w: number, h: number, private seed: number) {
    this.canvas.width = 512; this.canvas.height = 288;
    this.t = seed * 7.3;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat);
  }
  update(dt: number, s: GameState | null): void {
    this.t += dt; this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    const x = this.canvas.getContext('2d')!, W = 512, H = 288, t = this.t;
    const SLIDE = 6, idx = Math.floor(t / SLIDE + this.seed) % 4, lt = t % SLIDE;
    const company = s?.player.company || 'Sushi Empire';
    x.save();
    if (idx === 0) brandSlide(x, W, H, lt, company);
    else if (idx === 1) waveSlide(x, W, H, t);
    else if (idx === 2) countSlide(x, W, H, lt, company, s?.lifetime.pieces ?? 0);
    else ribbonSlide(x, W, H, t);
    x.restore();
    // wipe-in transition + LED scanlines
    if (lt < 0.35) { x.fillStyle = '#b82d25'; x.fillRect(0, 0, W * (1 - lt / 0.35), H); }
    x.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
    this.mat.color.setScalar(0.82 + Math.min(1, glow.value) * 0.18);
    this.tex.needsUpdate = true;
  }
}

function nigiri(x: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  x.save(); x.translate(cx, cy); x.scale(s, s);
  x.fillStyle = 'rgba(0,0,0,0.25)'; x.beginPath(); x.ellipse(0, 46, 112, 14, 0, 0, 7); x.fill();
  x.fillStyle = '#f7f1e3'; x.beginPath(); x.roundRect(-92, -4, 184, 52, 26); x.fill(); // rice
  x.fillStyle = '#e6dcc6'; for (let i = 0; i < 14; i++) { x.beginPath(); x.ellipse(-78 + i * 12, 22 + (i % 3) * 6, 5, 3, 0.4, 0, 7); x.fill(); }
  const gr = x.createLinearGradient(0, -40, 0, 10); gr.addColorStop(0, '#ff9a62'); gr.addColorStop(1, '#f0643a');
  x.fillStyle = gr; x.beginPath(); x.moveTo(-112, 4); x.bezierCurveTo(-90, -46, 80, -50, 116, -6); x.bezierCurveTo(70, 14, -60, 16, -112, 4); x.fill(); // salmon
  x.strokeStyle = 'rgba(255,240,225,0.85)'; x.lineWidth = 5;
  for (let i = 0; i < 6; i++) { const px = -70 + i * 30; x.beginPath(); x.moveTo(px, -24 + Math.abs(i - 2.5) * 3); x.quadraticCurveTo(px + 12, -8, px + 4, 8); x.stroke(); }
  x.restore();
}
function brandSlide(x: CanvasRenderingContext2D, W: number, H: number, lt: number, company: string): void {
  const gr = x.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#1e2a3d'); gr.addColorStop(1, '#2d1d2a');
  x.fillStyle = gr; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(201,154,60,0.18)'; x.beginPath(); x.arc(W * 0.72, H * 0.45, 120 + Math.sin(lt * 2) * 6, 0, 7); x.fill();
  const e = 1 - Math.pow(1 - Math.min(1, lt / 1.1), 3);
  nigiri(x, W * 0.72 + (1 - e) * 300, H * 0.5, 0.95);
  x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.fillStyle = '#f3ead8';
  let px = 54; x.font = `700 ${px}px ${FONT}`;
  while (x.measureText(company).width > W * 0.52 && px > 22) { px -= 2; x.font = `700 ${px}px ${FONT}`; }
  x.globalAlpha = Math.min(1, lt / 0.6); x.fillText(company, 28, 120);
  x.font = `600 22px ${FONT}`; x.fillStyle = '#e8c27a'; x.fillText('Hand-pressed. Tokyo fresh.', 30, 158);
  x.fillStyle = '#b82d25'; x.fillRect(30, 186, 56, 56); x.strokeStyle = '#f3ead8'; x.lineWidth = 3; x.strokeRect(35, 191, 46, 46);
  x.fillStyle = '#f3ead8'; x.font = `900 34px ${MINCHO}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('寿', 58, 215);
  x.globalAlpha = 1;
}
function waveSlide(x: CanvasRenderingContext2D, W: number, H: number, t: number): void {
  x.fillStyle = '#183a44'; x.fillRect(0, 0, W, H);
  const R = 34, off = (t * 18) % (R * 2);
  x.lineWidth = 3;
  for (let row = -1; row < H / (R * 0.5) + 2; row++) for (let col = -1; col < W / (R * 2) + 2; col++) {
    const cx = col * R * 2 + (row % 2 ? R : 0) - off, cy = row * R * 0.5;
    for (let k = 4; k > 0; k--) { x.strokeStyle = k % 2 ? 'rgba(201,154,60,0.85)' : 'rgba(243,234,216,0.55)'; x.fillStyle = '#183a44'; x.beginPath(); x.arc(cx, cy, (R * k) / 4, Math.PI, 0); x.fill(); x.stroke(); }
  }
  x.fillStyle = 'rgba(16,30,36,0.72)'; x.fillRect(0, H / 2 - 62, W, 124);
  x.fillStyle = '#f3ead8'; x.font = `900 86px ${MINCHO}`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('海の幸', W / 2, H / 2 + 2 + Math.sin(t * 1.5) * 3);
}
function countSlide(x: CanvasRenderingContext2D, W: number, H: number, lt: number, company: string, pieces: number): void {
  x.fillStyle = '#b82d25'; x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,0.07)';
  for (let i = 0; i < 10; i++) x.fillRect(((i * 70 + lt * 40) % (W + 80)) - 80, 0, 26, H);
  const shown = Math.round(pieces * Math.min(1, lt / 1.4));
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#fff6e6';
  x.font = `700 96px ${FONT}`; x.fillText(short(shown), W / 2, H / 2 - 18);
  x.font = `600 26px ${FONT}`; x.fillStyle = '#ffe2b0'; x.fillText(`pieces served by ${company}`, W / 2, H / 2 + 56);
  x.font = `700 22px ${MINCHO}`; x.fillStyle = '#fff6e6'; x.fillText('本日のおすすめ', W / 2, 34);
}
function ribbonSlide(x: CanvasRenderingContext2D, W: number, H: number, t: number): void {
  x.fillStyle = '#1c1a20'; x.fillRect(0, 0, W, H);
  const cols = ['#b82d25', '#c99a3c', '#e2c5bb', '#8fae9f', '#f3ead8'];
  x.lineCap = 'round';
  cols.forEach((c, i) => {
    x.strokeStyle = c; x.lineWidth = 16 - i * 2; x.beginPath();
    for (let px = -10; px <= W + 10; px += 8) { const y = H / 2 + Math.sin(px * 0.012 + t * (0.9 + i * 0.2) + i) * (60 - i * 6) + (i - 2) * 16; px < 0 ? x.moveTo(px, y) : x.lineTo(px, y); }
    x.stroke();
  });
  x.fillStyle = '#ffc6dc';
  for (let i = 0; i < 28; i++) { const px = (i * 97 + t * 30) % W, py = (i * 53 + t * (24 + (i % 5) * 6)) % H; x.beginPath(); x.ellipse(px, py, 4, 2.4, t + i, 0, 7); x.fill(); }
  x.fillStyle = '#f3ead8'; x.font = `600 24px ${FONT}`; x.textAlign = 'right'; x.textBaseline = 'alphabetic'; x.fillText('TOKYO  東京', W - 22, H - 22);
}

// ================================================================ SHINJUKU
function shinjuku(ctx: Hook): void {
  const f = (ctx.far ??= new Builder(null, 4000));
  steppedTower(f, -14, -128);
  twinTowers(f, 66, -112);
  ringTower(f, -84, -92);
  slantTower(f, 122, 4);
}

/** Lit window strips on one face (local +z at distance dz), floors every fh. */
function windows(b: Builder, w: number, y0: number, y1: number, dz: number, r: () => number, fh = 3.6, lit = 0.42): void {
  for (let y = y0 + 1; y + 2 < y1; y += fh) b.add(G.box(w, 1.9, 0.1), '#56677a', { at: [0, y, dz], glow: r() < lit ? ['#ffcf8a', '#ffe2b0', '#f6d9a8', '#d9e8ff'][Math.floor(r() * 4)] : '#000000' });
}
function finsAround(b: Builder, w: number, y0: number, h: number, step: number, color: string): void {
  for (let s = 0; s < 4; s++) {
    b.push(0, 0, 0, (s * Math.PI) / 2);
    for (let x = -w / 2 + step; x < w / 2 - step / 2; x += step) b.add(G.box(0.3, h, 0.35), color, { at: [x, y0, w / 2] });
    b.pop();
  }
}

/** Hero: three setback tiers in warm stone and dark glass, each tier crowned by a lit band, then a lantern crown
 *  between four pinnacles and a mast. */
function steppedTower(b: Builder, x: number, z: number): void {
  const r = seeded(4242);
  const tiers: [number, number, number][] = [[36, 0, 104], [27, 104, 164], [19, 164, 206]];
  b.push(x, 0, z, 0.12);
  for (const [w, y0, y1] of tiers) {
    b.add(prism(w, w, w * 0.12, y1 - y0), '#d6cbb8', { at: [0, y0, 0] });
    for (let s = 0; s < 4; s++) { b.push(0, 0, 0, (s * Math.PI) / 2); windows(b, w * 0.7, y0, y1 - 2.5, w / 2 + 0.02, r); b.pop(); }
    finsAround(b, w * 0.72, y0, y1 - y0 - 2.5, 2.4, '#e9e1d2');
    b.add(prism(w + 0.8, w + 0.8, w * 0.12 + 0.3, 1.2), '#efe9df', { at: [0, y1 - 2.5, 0] });
    b.add(prism(w + 0.3, w + 0.3, w * 0.12 + 0.1, 1.6), '#efe9df', { at: [0, y1 - 1.9, 0], glow: '#ffd89a' });
    b.add(prism(w + 0.8, w + 0.8, w * 0.12 + 0.3, 0.3), '#efe9df', { at: [0, y1 - 0.3, 0] });
  }
  // crown: lit lantern between four pinnacles
  b.add(prism(12, 12, 1.6, 15), '#9db3c4', { at: [0, 206, 0], glow: '#ffe0a8' });
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) b.add(G.box(12.2, 0.4, 0.3), '#efe9df', { at: [0, 208 + i * 3.4, 6.05], rot: [0, (k * Math.PI) / 2, 0] });
  b.add(G.cone(6.4, 6, 4), '#d6cbb8', { at: [0, 221, 0], rot: [0, Math.PI / 4, 0] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.add(prism(3, 3, 0.5, 20), '#d6cbb8', { at: [sx * 8, 206, sz * 8] });
    b.add(G.cone(1.6, 7, 4), '#efe9df', { at: [sx * 8, 226, sz * 8], rot: [0, Math.PI / 4, 0], glow: '#ffe0a8' });
    b.add(G.sphere(0.5, 6, 4), '#ff3b3b', { at: [sx * 8, 233.4, sz * 8], glow: '#ff2020' });
  }
  b.cyl(0, 227, 0, 0.3, 0.7, 22, '#cfd3d6', 6);
  b.add(G.sphere(0.7, 6, 4), '#ff3b3b', { at: [0, 249.5, 0], glow: '#ff2020' });
  b.pop();
}

/** Two glass slabs joined by a sky bridge; each crowned by a lit notch. */
function twinTowers(b: Builder, x: number, z: number): void {
  const r = seeded(919);
  b.push(x, 0, z, -0.2);
  for (const [sx, H] of [[-14, 168], [14, 150]] as const) {
    b.push(sx, 0, 0, 0);
    b.add(prism(18, 26, 2.5, H), '#9fb0bd');
    for (let s = 0; s < 4; s++) { b.push(0, 0, 0, (s * Math.PI) / 2); windows(b, s % 2 ? 22 : 14, 0, H - 6, s % 2 ? 9.02 : 13.02, r, 3.6, 0.36); b.pop(); }
    b.add(G.box(18.6, 6, 26.6), '#e6e0d6', { at: [0, H - 6, 0] });
    for (const dz of [-6, 0, 6]) b.add(G.box(18.8, 4.2, 1.2), '#2b3440', { at: [0, H - 5, dz], glow: '#ffd89a' });
    b.add(G.sphere(0.5, 6, 4), '#ff3b3b', { at: [0, H + 0.5, 0], glow: '#ff2020' });
    b.pop();
  }
  b.add(G.box(10.5, 7, 9), '#e6e0d6', { at: [0, 112, 0] });
  b.add(G.box(10.6, 3.2, 9.1), '#3b4652', { at: [0, 113.8, 0], glow: '#ffd89a' });
  b.pop();
}

/** Cylindrical tower with ring bands and a glowing halo crown. */
function ringTower(b: Builder, x: number, z: number): void {
  b.push(x, 0, z, 0);
  b.cyl(0, 0, 0, 11, 11, 184, '#b7c0c6', 28);
  const r = seeded(31);
  for (let y = 5; y < 178; y += 3.6) b.add(G.cyl(11.08, 11.08, 1.9, 28), '#56677a', { at: [0, y, 0], glow: r() < 0.4 ? '#ffd9a0' : '#000000' });
  b.cyl(0, 184, 0, 9.5, 11.4, 3, '#e8e3da', 28);
  b.add(new THREE.TorusGeometry(9.6, 0.55, 8, 40).rotateX(Math.PI / 2), '#efe9df', { at: [0, 192, 0], glow: '#ffe6b8' });
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.add(G.box(0.4, 8, 0.4), '#d6d1c8', { at: [Math.cos(a) * 9.6, 186.5, Math.sin(a) * 9.6] }); }
  b.cyl(0, 187, 0, 0.25, 0.6, 20, '#cfd3d6', 6);
  b.add(G.sphere(0.6, 6, 4), '#ff3b3b', { at: [0, 207.5, 0], glow: '#ff2020' });
  b.pop();
}

/** Tower with a sloped crown terminating the avenue vista; the slope edge is lit at night. */
function slantTower(b: Builder, x: number, z: number): void {
  b.push(x, 0, z, 0);
  const w = 26, d = 24, lo = 128, hi = 160;
  const s = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(w / 2, hi), new THREE.Vector2(-w / 2, lo)]);
  b.add(new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }).translate(0, 0, -d / 2).rotateY(Math.PI / 2), '#c9c1b2');
  const r = seeded(5);
  b.push(0, 0, 0, -Math.PI / 2); windows(b, 20, 0, lo - 4, w / 2 + 0.02, r, 3.6, 0.4); b.pop();
  for (const sz of [-1, 1]) { b.push(0, 0, 0, sz < 0 ? Math.PI : 0); windows(b, 18, 0, lo - 4, d / 2 + 0.02, r, 3.6, 0.35); b.pop(); }
  // lit edges along the slope (local x after the rotation runs along world z)
  const len = Math.hypot(w, hi - lo), ang = Math.atan2(hi - lo, w);
  for (const sz of [-1, 1]) b.add(G.box(0.8, 0.8, len), '#efe9df', { at: [sz * (d / 2 + 0.2), (lo + hi) / 2 - 0.4, 0], rot: [ang, 0, 0], glow: '#ffd89a' });
  b.add(G.sphere(0.6, 6, 4), '#ff3b3b', { at: [0, hi + 0.6, w / 2 - 1], glow: '#ff2020' });
  b.pop();
}

// ================================================================ GINZA
function ginza(ctx: Hook): void {
  const { b } = ctx;
  clockTowerDress(b, 13.4, -13.4);
  storeTrim(b);
  latticeTower((ctx.far ??= new Builder(null, 4000)), -6, -205, 128);
}

/** Dresses the corner store's clock tower: rusticated stone base, pilasters and floor cornices, gold bands and a
 *  verdigris ribbed dome with lantern and finial (the clock face itself belongs to the district). */
function clockTowerDress(b: Builder, x: number, z: number): void {
  const STONE = '#e6dccb', STONED = '#cfc4b1';
  b.push(x, 0, z, 0);
  b.cyl(0, 0, 0, 3.36, 3.42, 4.2, STONE, 40);
  for (let y = 0.6; y < 4.1; y += 0.6) b.cyl(0, y, 0, 3.43, 3.43, 0.05, STONED, 40);
  b.cyl(0, 4.2, 0, 3.44, 3.44, 0.22, GOLD, 40);
  for (const y of [6.6, 9.7, 12.8, 15.9]) b.cyl(0, y - 0.1, 0, 3.32, 3.32, 0.2, STONED, 40);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    b.add(G.box(0.34, 13.9, 0.2), STONE, { at: [Math.sin(a) * 3.22, 4.42, Math.cos(a) * 3.22], rot: [0, a, 0] });
  }
  b.cyl(0, 17.9, 0, 3.55, 3.3, 0.6, STONE, 40);
  // the original gold ring sits at 18.5..18.9; crown above the clock drum
  b.cyl(0, 22.05, 0, 3.05, 2.85, 0.32, STONE, 40);
  b.cyl(0, 22.37, 0, 3.0, 3.0, 0.1, GOLD, 40, '#ffd9a0');
  b.add(lathe([[2.84, 0], [2.8, 0.35], [2.66, 1.0], [2.36, 1.62], [1.86, 2.18], [1.2, 2.6], [0.66, 2.8]], 32), '#7fa594', { at: [0, 22.47, 0] });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add(G.box(0.12, 1.6, 0.12), GOLD, { at: [Math.sin(a) * 2.55, 22.75, Math.cos(a) * 2.55], rot: [0, a, -0.0] });
  }
  b.add(new THREE.TorusGeometry(2.45, 0.06, 6, 32).rotateX(Math.PI / 2), GOLD, { at: [0, 23.8, 0] });
  // lantern cupola + finial
  b.cyl(0, 25.1, 0, 0.75, 0.75, 0.15, STONE, 16);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.cyl(Math.sin(a) * 0.6, 25.25, Math.cos(a) * 0.6, 0.06, 0.06, 0.9, STONE, 6); }
  b.cyl(0, 25.25, 0, 0.45, 0.45, 0.9, '#f3e6c8', 12, '#ffd9a0');
  b.add(lathe([[0.82, 0], [0.7, 0.3], [0.35, 0.6], [0.08, 0.75]], 16), '#7fa594', { at: [0, 26.15, 0] });
  b.cyl(0, 26.8, 0, 0.05, 0.09, 1.6, GOLD, 6);
  b.add(G.sphere(0.14, 10, 8), GOLD, { at: [0, 27.4, 0] });
  b.collide(0, 0, 6.9, 6.9, 5);
  b.pop();
}

/** Gold-sheathed cornice with dentils and a gold string course on the corner store's two street faces.
 *  Heights follow the district's 5-floor Ginza stone building (gh 4.4, fh 3.3: cornice at h - fh - 0.2). */
function storeTrim(b: Builder): void {
  const faces: [number, number, number, number][] = [[21.25, -11, 9.5, 0], [11, -20.75, 8.5, -Math.PI / 2]];
  for (const [x, z, len, ry] of faces) {
    b.push(x, 0, z, ry);
    b.add(G.box(len, 0.28, 0.7), GOLD, { at: [0, 14.08, 0], glow: '#ffcf80' });
    b.add(G.box(len, 0.12, 0.16), GOLD, { at: [0, 4.02, 0.06] });
    for (let i = 0; i < Math.floor(len / 0.6); i++) b.add(G.box(0.18, 0.2, 0.22), '#e8dcc0', { at: [-len / 2 + 0.3 + i * 0.6, 13.86, 0.12] });
    b.pop();
  }
}

/** Distant red-and-white lattice tower with two observation decks (original design, skyline only). */
function latticeTower(b: Builder, x: number, z: number, H: number): void {
  b.push(x, 0, z, 0.3);
  const RED = '#c8462e', WHITE = '#efe9df';
  const legs = 18;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const t0 = k / 6, t1 = (k + 1) / 6, h = H * 0.55;
      const p0 = new THREE.Vector3(sx * legs * (1 - t0 * 0.82), t0 * h, sz * legs * (1 - t0 * 0.82));
      const p1 = new THREE.Vector3(sx * legs * (1 - t1 * 0.82), t1 * h, sz * legs * (1 - t1 * 0.82));
      const len = p0.distanceTo(p1), mid = p0.clone().add(p1).multiplyScalar(0.5);
      const g = G.box(1.6 - t0, len, 1.6 - t0).translate(0, -len / 2, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize())));
      b.add(g, k % 2 ? WHITE : RED, { at: [mid.x, mid.y, mid.z] });
    }
  }
  for (const [y, w] of [[H * 0.12, 30], [H * 0.3, 21], [H * 0.45, 14]] as const) b.add(prism(w, w, 1, 1.2), RED, { at: [0, y, 0] });
  b.add(prism(12, 12, 2, 5), WHITE, { at: [0, H * 0.48, 0] });
  b.add(prism(12.4, 12.4, 2, 2), '#3b4652', { at: [0, H * 0.48 + 1.5, 0], glow: '#ffd89a' });
  for (let k = 0; k < 6; k++) b.add(G.box(5 - k * 0.5, H * 0.07, 5 - k * 0.5), k % 2 ? WHITE : RED, { at: [0, H * 0.53 + k * H * 0.07, 0] });
  b.add(prism(6, 6, 1, 3), WHITE, { at: [0, H * 0.75, 0] });
  b.add(prism(6.3, 6.3, 1, 1.2), '#3b4652', { at: [0, H * 0.75 + 0.9, 0], glow: '#ffd89a' });
  for (let k = 0; k < 4; k++) b.add(G.box(1.2 - k * 0.2, H * 0.06, 1.2 - k * 0.2), k % 2 ? WHITE : RED, { at: [0, H * 0.95 + k * H * 0.06 - H * 0.2, 0] });
  b.add(G.sphere(0.7, 6, 4), '#ff3b3b', { at: [0, H * 1.0, 0], glow: '#ff2020' });
  b.pop();
}
