// Restaurant interiors: the kitchen line, counter, seating, lighting and printed matter of every owned site,
// per format (stand, bar, kaiten, omakase, kiosk, ghost kitchen). Everything is procedural.
//
// Hooked from SiteView.refresh() in sites.ts with ONE call:  buildInterior(group, builder, ctx).
// - Matte parts (wood, cloth, plaster, food) go into the site's Builder (clean interior material, night warmth).
// - Stainless steel, glazed ceramics/bottles, glass and printed boards are merged here into one mesh per material.
// - The kaiten belt is instanced (plates, colour-coded rims, sushi) and animates itself in onBeforeRender.
// Gameplay anchors (seats, queue, chef/server spots, counter footprint and heights) are read, never moved.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONCEPTS, PROPERTIES, RECIPES } from '../core/data';
import type { GameState, RestaurantState } from '../core/state';
import { VC_MAT } from '../engine/geo';
import { Builder, FONT, G, rng } from './kit';
import { mat } from './materials';
import { placeArt } from './place-art';
import { activeSeats } from './sites';
import { makeSushi } from './sushi';
import type { RestaurantSite, Spot } from './types';

/** The parts of the site layout an interior needs (sites.ts buildingLayout()). */
interface Layout { doorX: number; qx: number; cz: number; counterX0: number; counterX1: number; prepX: number }
export interface InteriorCtx {
  def: { id: string; x: number; z: number; ry: number; w: number; d: number; style: string };
  kind: string;
  L: Layout | null;
  site: RestaurantSite;
  s: GameState;
  r: RestaurantState;
}

// ---------------------------------------------------------------- warm palette (sRGB)
const INK = '#2b2724', WASHI = '#f3ead7', VERM = '#b82d25', GOLD = '#c99a3c';
const HINOKI = '#e8d3ac', TIMBER = '#c9a682', TIMBER_D = '#7d5d43', WALNUT = '#5a4232', CHAR = '#3a302a';
const TILE = '#efebe3', GROUT = '#cfc8bb', RICE = '#f6f0e2';
const FISH = ['#c23a3e', '#ef8a5a', '#e9d6bd', '#f2a27e', '#7a4a2c', '#f0ebe0', '#d9534f'];
const RIMS = ['#f1ece2', GOLD, VERM, '#2f4a6b', '#3a3431', '#7d9a6a'];
const THEME_ACC = [null, '#33405a', '#c98f9e', '#2a2622'];

// ---------------------------------------------------------------- printed matter: one canvas atlas per site
class Paper {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mat: THREE.MeshStandardMaterial;
  lit: THREE.MeshBasicMaterial;
  private x = 0; private y = 0; private row = 0;
  private ops: (() => void)[] = [];
  constructor() {
    this.canvas.width = this.canvas.height = 1024;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, emissiveMap: this.tex, emissive: '#ffffff', emissiveIntensity: 0.16, roughness: 0.8 });
    this.lit = new THREE.MeshBasicMaterial({ map: this.tex });
    document.fonts?.ready.then(() => { for (const op of this.ops) op(); this.tex.needsUpdate = true; });
  }
  reset(): void { this.ctx.clearRect(0, 0, 1024, 1024); this.x = this.y = this.row = 0; this.ops = []; }
  /** Reserve w×h px and paint it; returns the UV rect. ponytail: no overflow check, interiors use well under 1024². */
  rect(w: number, h: number, draw: (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void): [number, number, number, number] {
    if (this.x + w > 1024) { this.x = 0; this.y += this.row + 2; this.row = 0; }
    const x = this.x, y = this.y;
    this.x += w + 2; this.row = Math.max(this.row, h);
    const op = () => { const c = this.ctx; c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); draw(c, x, y, w, h); c.restore(); };
    op(); this.ops.push(op);
    this.tex.needsUpdate = true;
    return [x / 1024, 1 - (y + h) / 1024, (x + w) / 1024, 1 - y / 1024];
  }
}
const PAPERS = new Map<string, Paper>(); // ponytail: one per site id, reused across rebuilds (bounded by site count)

// ---------------------------------------------------------------- merged non-Builder layers
type Layer = 'steel' | 'gloss' | 'glass' | 'paper' | 'lit';
class Kit {
  parts: Record<Layer, THREE.BufferGeometry[]> = { steel: [], gloss: [], glass: [], paper: [], lit: [] };
  extra: THREE.Object3D[] = [];
  constructor(public paper: Paper) {}
  put(layer: Layer, g: THREE.BufferGeometry, at: [number, number, number], o: { rot?: [number, number, number]; scale?: [number, number, number]; color?: string } = {}): this {
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))), new THREE.Vector3(...(o.scale ?? [1, 1, 1]))));
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(k === 'uv' && (layer === 'paper' || layer === 'lit'))) g.deleteAttribute(k);
    if (layer === 'gloss') {
      const c = new THREE.Color(o.color ?? '#ffffff'), n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    this.parts[layer].push(g);
    return this;
  }
  steel(g: THREE.BufferGeometry, x: number, y: number, z: number, rot?: [number, number, number]): this { return this.put('steel', g, [x, y, z], { rot }); }
  gloss(g: THREE.BufferGeometry, color: string, x: number, y: number, z: number, rot?: [number, number, number], scale?: [number, number, number]): this { return this.put('gloss', g, [x, y, z], { rot, scale, color }); }
  glass(g: THREE.BufferGeometry, x: number, y: number, z: number, rot?: [number, number, number]): this { return this.put('glass', g, [x, y, z], { rot }); }
  /** Printed panel (plane facing local +z after ry) showing a Paper rect. */
  panel(x: number, y: number, z: number, w: number, h: number, r: [number, number, number, number], ry = 0, lit = false): this {
    const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
    return this.put(lit ? 'lit' : 'paper', g, [x, y, z], { rot: [0, ry, 0] });
  }
  finish(group: THREE.Group, def: InteriorCtx['def']): void {
    const frame = new THREE.Group();
    frame.position.set(def.x, 0, def.z); frame.rotation.y = def.ry;
    const M: Record<Layer, THREE.Material> = { steel: mat('metalBrushed'), gloss: mat('paintGloss'), glass: mat('glassClear'), paper: this.paper.mat, lit: this.paper.lit };
    for (const k of Object.keys(this.parts) as Layer[]) {
      if (!this.parts[k].length) continue;
      const m = new THREE.Mesh(mergeGeometries(this.parts[k])!, M[k]);
      for (const p of this.parts[k]) p.dispose();
      m.castShadow = k === 'steel' || k === 'gloss'; m.receiveShadow = k !== 'glass';
      if (k === 'glass') m.renderOrder = 2;
      m.name = 'interior:' + k;
      frame.add(m);
    }
    for (const o of this.extra) frame.add(o);
    group.add(frame);
  }
}

// ---------------------------------------------------------------- geometry helpers
const lathe = (pts: number[][], seg = 16) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
const rod = (len: number, r: number, seg = 6) => new THREE.CylinderGeometry(r, r, len, seg);
/** Horizontal rod along local x, centred at (x,y,z). */
const rodX = (len: number, r = 0.012) => rod(len, r).rotateZ(Math.PI / 2);
const P = {
  isshobin: lathe([[0, 0], [0.052, 0], [0.054, 0.01], [0.054, 0.25], [0.046, 0.29], [0.022, 0.33], [0.016, 0.37], [0.017, 0.4], [0, 0.4]], 14),
  tokkuri: lathe([[0, 0], [0.04, 0], [0.05, 0.03], [0.052, 0.07], [0.04, 0.11], [0.016, 0.145], [0.014, 0.17], [0.022, 0.18], [0, 0.18]], 14),
  ochoko: lathe([[0, 0], [0.022, 0], [0.024, 0.006], [0.033, 0.04], [0.03, 0.04], [0.02, 0.008], [0, 0.008]], 12),
  yunomi: lathe([[0, 0], [0.032, 0], [0.036, 0.01], [0.04, 0.09], [0.036, 0.09], [0.033, 0.012], [0, 0.012]], 14),
  bowl: lathe([[0, 0], [0.04, 0], [0.05, 0.008], [0.085, 0.05], [0.08, 0.052], [0.045, 0.014], [0, 0.014]], 16),
  plate: lathe([[0, 0], [0.08, 0], [0.085, 0.006], [0.12, 0.016], [0.122, 0.022], [0.115, 0.022], [0.085, 0.012], [0, 0.012]], 18),
  rim: lathe([[0.116, 0.0195], [0.123, 0.0225], [0.123, 0.025], [0.114, 0.0225]], 18),
  shoyu: lathe([[0, 0], [0.026, 0], [0.03, 0.01], [0.03, 0.06], [0.018, 0.085], [0.008, 0.1], [0.01, 0.11], [0, 0.11]], 10),
  vase: lathe([[0, 0], [0.07, 0], [0.09, 0.05], [0.085, 0.16], [0.05, 0.24], [0.04, 0.3], [0.05, 0.32], [0, 0.32]], 16),
  jar: lathe([[0, 0], [0.06, 0], [0.065, 0.01], [0.065, 0.15], [0.055, 0.17], [0.0, 0.17]], 12),
  cooker: lathe([[0, 0], [0.16, 0], [0.175, 0.03], [0.18, 0.2], [0.17, 0.22], [0, 0.22]], 20),
  cookerLid: lathe([[0, 0], [0.175, 0], [0.16, 0.05], [0.1, 0.08], [0, 0.085]], 20),
  pot: lathe([[0, 0], [0.15, 0], [0.155, 0.01], [0.155, 0.24], [0.162, 0.25], [0.15, 0.25], [0.145, 0.02], [0, 0.02]], 18),
  ladle: lathe([[0, -0.05], [0.04, -0.04], [0.055, -0.01], [0.056, 0], [0.05, 0], [0.04, -0.03], [0, -0.042]], 12),
  shade: lathe([[0.02, 0.16], [0.05, 0.15], [0.14, 0.04], [0.16, 0], [0.155, -0.004], [0.13, 0.03], [0.045, 0.14], [0.02, 0.15]], 20),
};

/** Seat spots in the site's local frame, with local yaw (faces +z of a pushed frame). */
function localSeat(def: InteriorCtx['def'], sp: Spot): { x: number; z: number; yaw: number } {
  const dx = sp.x - def.x, dz = sp.z - def.z, c = Math.cos(-def.ry), s = Math.sin(-def.ry);
  return { x: dx * c + dz * s, z: -dx * s + dz * c, yaw: sp.yaw - def.ry };
}

const yen = (n: number) => '¥' + Math.round(n).toLocaleString();

// ================================================================ entry
export function buildInterior(group: THREE.Group, b: Builder, c: InteriorCtx): void {
  let paper = PAPERS.get(c.def.id);
  if (!paper) PAPERS.set(c.def.id, (paper = new Paper()));
  paper.reset();
  const K = new Kit(paper);
  const was = b.clean;
  b.clean = true;
  if (c.kind === 'stand') standKitchen(b, K, c);
  else if (c.L) house(b, K, c, c.L);
  b.clean = was;
  K.finish(group, c.def);
}

// ================================================================ the yatai stand: gear only (the cart is sites.ts)
function standKitchen(b: Builder, K: Kit, c: InteriorCtx): void {
  const u = c.r.upgrades, D = 2.8, top = 1.0, bz = -D + 0.3;
  prepStation(b, K, 0.6, top, bz, u.station ?? 0, 'wood', c.def.id);
  for (let i = 0; i < (u.extra_station ?? 0); i++) miniStation(b, K, -1.25 + i * 0.75 + (i > 1 ? 2.9 : 0), top, bz);
  riceCooker(b, K, -2.0, top, bz - 0.02, true);
  // condiment row and sake on the right end of the back counter
  for (let i = 0; i < 3; i++) K.gloss(P.isshobin.clone(), ['#3f5a44', '#6b4a2e', '#e9e2d0'][i], 1.75 + i * 0.13, top, bz - 0.12);
  for (let i = 0; i < 3; i++) b.cyl(1.75 + i * 0.13, top + 0.14, bz - 0.12, 0.056, 0.056, 0.09, '#efe6d2', 12);
  jarRow(b, K, 2.05, top, bz + 0.12, 3, rng(7));
  // knife magnet on the back rail panel, ladles hung from a rail between the back posts
  knifeBar(b, K, -0.55, 1.22, -D + 0.035, 4);
  b.add(rodX(4.7, 0.015), '#6b5a48', { at: [0, 2.05, -D + 0.05] });
  hangTools(b, K, -1.3, 2.05, -D + 0.05, 4);
  // neta case on the serving counter
  if (u.fridge) netaCase(b, K, 0.9, 1.08, -0.4, 0.9 + 0.5 * u.fridge, false, rng(11));
  // hanging wooden price tags along the rail (menu)
  const items = menuItems(c, 5);
  const tags = items.map((it) => K.paper.rect(72, 210, (cx, x, y, w, h) => fuda(cx, x, y, w, h, it.jp, it.price)));
  tags.forEach((r, i) => {
    const x = 0.35 + i * 0.36;
    b.add(rod(0.2, 0.003), '#4a3a2c', { at: [x, 1.95, -D + 0.06] });
    K.panel(x, 1.68, -D + 0.07, 0.24, 0.7, r);
  });
}

// ================================================================ enterable buildings
interface Pal { body: string; top: string; topT: number; trim: string; slats: string | null; band: string | null; seat: string; cushion: string; table: string; leg: string; woodKitchen: boolean; noren: string }

function palette(c: InteriorCtx, concept: string): Pal {
  const { style, id } = c.def;
  const salary = id.startsWith('shinjuku'), lux = style === 'lux';
  const acc = THEME_ACC[c.r.theme] ?? null;
  const ink = placeArt(id)?.ink;
  let p: Pal;
  if (concept === 'omakase') p = { body: '#3e3029', top: HINOKI, topT: 0.12, trim: '#2b211c', slats: '#4d3c31', band: null, seat: TIMBER, cushion: '#6d5a48', table: HINOKI, leg: WALNUT, woodKitchen: true, noren: '#f1e8d6' };
  else if (concept === 'kaiten') p = { body: '#f1ece2', top: '#f6f2ea', topT: 0.08, trim: '#d9d2c5', slats: null, band: VERM, seat: VERM, cushion: '#c9473a', table: '#f4efe6', leg: '#b9b2a6', woodKitchen: false, noren: VERM };
  else if (concept === 'kiosk') p = { body: '#d9d2c3', top: '#f4f0e8', topT: 0.06, trim: '#b9ae99', slats: null, band: '#8aa287', seat: '#8aa287', cushion: '#8aa287', table: TIMBER, leg: '#57534d', woodKitchen: false, noren: '#5e7a60' };
  else if (concept === 'ghost') p = { body: '#b9bcc0', top: '#d8dadc', topT: 0.05, trim: '#8e9297', slats: null, band: null, seat: '#8e9297', cushion: '#8e9297', table: '#d8dadc', leg: '#6f7378', woodKitchen: false, noren: '#3d4a52' };
  else if (salary) p = { body: '#5b4636', top: '#c49a6c', topT: 0.07, trim: '#3f3027', slats: '#6a5241', band: null, seat: '#9a2f28', cushion: '#a8362c', table: '#c49a6c', leg: '#45403b', woodKitchen: false, noren: '#2f3d55' };
  else if (lux) p = { body: '#4a3a30', top: HINOKI, topT: 0.12, trim: GOLD, slats: '#5a4739', band: null, seat: WALNUT, cushion: '#5c4a3c', table: HINOKI, leg: WALNUT, woodKitchen: true, noren: '#efe6d4' };
  else if (style === 'modern') p = { body: '#e6dfd3', top: '#dcc6a3', topT: 0.07, trim: '#c9bfae', slats: null, band: ink ?? '#46636b', seat: '#d9a48f', cushion: '#d9a48f', table: '#dcc6a3', leg: '#3a3633', woodKitchen: false, noren: ink ?? '#46636b' };
  else p = { body: '#6e4f37', top: '#e3c99a', topT: 0.08, trim: '#4a3527', slats: TIMBER_D, band: null, seat: TIMBER_D, cushion: '#34465e', table: '#c9a682', leg: '#4a3527', woodKitchen: true, noren: ink ?? '#2f3d55' };
  if (acc && concept !== 'ghost') { p.body = acc; p.seat = acc; if (c.r.theme === 3) p.trim = GOLD; }
  return p;
}

function house(b: Builder, K: Kit, c: InteriorCtx, L: Layout): void {
  const { def, r } = c;
  const { w, d, style, id } = def;
  const u = r.upgrades, concept = r.concept ?? 'bar';
  const pal = palette(c, concept);
  const salary = id.startsWith('shinjuku') && concept === 'bar';
  const rnd = rng(id.length * 131 + w * 7);
  const cx = (L.counterX0 + L.counterX1) / 2, cw = L.counterX1 - L.counterX0;
  const topY = concept === 'omakase' ? (style === 'lux' ? 1.12 : 1.08) : style === 'lux' && concept === 'bar' ? 1.12 : 1.08;
  const hx1 = w / 2 - 0.3, hx0 = hx1 - (concept === 'ghost' ? 2.6 : 1.9); // stove + hood zone (back right)
  const clearOfBoard = (x: number, m = 1.05) => Math.abs(x - L.qx) > m;

  // ---------------- front counter (footprint and height unchanged)
  frontCounter(b, K, cx, L.cz, cw, topY, pal, concept);
  if (concept !== 'ghost' && concept !== 'omakase') b.sign(L.qx, 0.9, L.cz + 0.372, 0.9, 0.19, concept === 'kiosk' ? 'ご注文・お受け取り' : 'ご注文はこちら', { bg: '#efe4cc', fg: INK, px: 110 });
  // pass-through post + short noren where staff cross between kitchen and floor
  const px0 = L.counterX1, px1 = w / 2 - 0.14;
  b.add(G.bbox(0.12, 3.4 - topY, 0.12, 0.02), pal.trim, { at: [px0 + 0.02, topY, L.cz] });
  b.add(G.bbox(px1 - px0, 0.1, 0.1, 0.02), pal.trim, { at: [(px0 + px1) / 2, 2.32, L.cz] });
  norenCloth(b, (px0 + px1) / 2 + 0.03, 2.32, L.cz + 0.06, px1 - px0 - 0.2, 0.42, pal.noren, concept === 'omakase' ? null : '厨', 2);

  // ---------------- back line: cabinets, worktop, splash, shelves, hood
  const bx0 = -w / 2 + 0.25, bx1 = w / 2 - 0.25, bz = -d + 0.4;
  backCounter(b, K, bx0, bx1, bz, pal, concept);
  if (concept !== 'omakase') splash(b, bx0, bx1, -d + 0.15, 1.0, 1.42);
  else for (let k = 0; k < Math.floor((w - 0.4) / 0.12); k++) b.box(-w / 2 + 0.26 + k * 0.12, 1.0, -d + 0.155, 0.1, 2.3, 0.025, k % 2 ? '#d9c29a' : '#e3cda6'); // hinoki slat wall
  if (concept !== 'omakase') hood(b, K, hx0, hx1, -d, concept === 'ghost' || (u.station ?? 0) >= 3);
  stove(b, K, (hx0 + hx1) / 2, 1.0, bz, concept === 'omakase' ? 0 : concept === 'ghost' ? 3 : 2);
  shelves(b, K, -w / 2 + 0.4, hx0 - 0.25, -d, clearOfBoard, concept, pal, rnd);
  // prep station + extra stations (same x rule as before: left of prep, else to the right of it)
  prepStation(b, K, L.prepX, 1.0, bz, u.station ?? 0, pal.woodKitchen ? 'wood' : 'steel', id);
  for (let i = 0; i < (u.extra_station ?? 0) + Math.min(2, u.expand ?? 0); i++) {
    let x = L.prepX - 2.2 - i * 1.7;
    if (x <= -w / 2 + 0.8) x = L.prepX + 2.2 + (i - 1) * 1.7;
    if (x > hx0 - 0.5 || Math.abs(x - L.prepX) < 1) continue;
    miniStation(b, K, x, 1.0, bz);
  }
  riceCooker(b, K, L.prepX + 0.95, 1.0, bz - 0.04, false);
  if ((u.station ?? 0) >= 2) riceCooker(b, K, L.prepX + 1.36, 1.0, bz - 0.04, false);
  knifeBar(b, K, L.prepX - 0.45, 1.2, -d + 0.17, 3 + Math.min(3, u.station ?? 0));
  b.add(rodX(1.2, 0.01), '#6a6e73', { at: [hx0 - 0.85, 1.62, -d + 0.2] });
  hangTools(b, K, hx0 - 1.3, 1.62, -d + 0.2, 4);
  // side-wall doorway to the back room, noren across it (in the kitchen aisle)
  backDoor(b, -w / 2, -d + 1.55, pal.noren, concept === 'omakase' ? '鮨' : '厨');

  // anti-fatigue mats along the chef line
  if (concept !== 'omakase') for (let x = bx0 + 0.9; x < bx1 - 0.6; x += 1.9) b.add(G.bbox(1.7, 0.014, 0.62, 0.006), '#3a3532', { at: [x, 0.05, -d + 1.35] });
  // ---------------- menu board (back wall, same place as before)
  menuBoard(b, K, c, L.qx, -d, concept);

  // ---------------- counter-top service
  const fridge = u.fridge ?? 0;
  if (concept === 'bar' || concept === 'omakase') {
    const big = concept === 'omakase' || style === 'lux';
    netaCase(b, K, L.qx + 1.3, topY, L.cz - 0.06, Math.min(cw - 3, (big ? 1.8 : 1.2) + fridge * 0.7), big, rnd);
  }
  if (concept !== 'kaiten' && concept !== 'ghost' && u.register) register(b, K, L.counterX1 - 0.4, topY, L.cz + 0.1, u.register >= 3);

  // ---------------- per-format room
  if (concept === 'kaiten') kaiten(b, K, c, L, pal, topY);
  else if (concept === 'omakase') omakase(b, K, c, L, pal, topY);
  else if (concept === 'kiosk') kiosk(b, K, c, L, pal);
  else if (concept === 'ghost') ghost(b, K, c, L, hx0);
  else bar(b, K, c, L, pal, topY, salary);

  // ---------------- night: warm spill on the sidewalk in front of every window
  if (concept !== 'ghost') {
    const dw = 2.2;
    for (const [a, e] of [[-w / 2, L.doorX - dw / 2], [L.doorX + dw / 2, w / 2]]) {
      for (let x = a + 1.1; x < e - 0.5; x += 2.4) b.pool(x, 1.0, 1.5, '#ffc583');
    }
    b.pool(L.doorX, 0.9, 1.7, '#ffcf96');
  }
}

// ---------------------------------------------------------------- counters
function frontCounter(b: Builder, K: Kit, cx: number, cz: number, cw: number, topY: number, p: Pal, concept: string): void {
  const steelTop = concept === 'ghost';
  b.add(G.bbox(cw - 0.08, 0.12, 0.6, 0.015), CHAR, { at: [cx, 0, cz - 0.03] }); // recessed kick
  b.add(G.bbox(cw, topY - p.topT - 0.12, 0.7, 0.02), p.body, { at: [cx, 0.12, cz] });
  b.collide(cx, cz, cw, 0.7, 1.05, false);
  const fz = cz + 0.352;
  if (p.slats) for (let x = cx - cw / 2 + 0.06; x < cx + cw / 2 - 0.04; x += 0.085) b.box(x, 0.14, fz, 0.05, topY - p.topT - 0.2, 0.02, p.slats);
  if (p.band) b.box(cx, topY - p.topT - 0.2, fz, cw - 0.02, 0.07, 0.02, p.band);
  if (concept === 'kiosk' || concept === 'ghost' || concept === 'kaiten') for (let x = cx - cw / 2 + 1.2; x < cx + cw / 2 - 0.3; x += 1.2) b.box(x, 0.14, fz, 0.012, topY - p.topT - 0.22, 0.016, p.trim);
  b.box(cx, 0.12, fz + 0.005, cw, 0.025, 0.02, p.trim);
  if (steelTop) K.steel(G.rbox(cw + 0.1, p.topT, 0.9, 0.012), cx, topY - p.topT, cz + 0.05);
  else {
    b.add(G.rbox(cw + 0.1, p.topT, 0.9, Math.min(0.03, p.topT / 2 - 0.002)), p.top, { at: [cx, topY - p.topT, cz + 0.05], vary: 0.03 });
    // grain lines on the slab (hinoki / oak)
    if (p.top === HINOKI || p.top === '#e3c99a' || p.top === '#dcc6a3') for (let i = 0; i < 5; i++) b.box(cx, topY + 0.0005, cz - 0.3 + i * 0.17 + (i % 2) * 0.03, cw + 0.06, 0.001, 0.006, '#cfb487');
  }
  if (concept === 'bar' || concept === 'omakase') K.steel(rodX(cw - 0.2, 0.018), cx, 0.2, cz + 0.52); // foot rail
  if (concept === 'bar' || concept === 'omakase') for (let x = cx - cw / 2 + 0.4; x < cx + cw / 2; x += 1.6) K.steel(new THREE.BoxGeometry(0.025, 0.12, 0.17), x, 0.2, cz + 0.44);
}

function backCounter(b: Builder, K: Kit, x0: number, x1: number, z: number, p: Pal, concept: string): void {
  const w = x1 - x0, cx = (x0 + x1) / 2;
  b.add(G.bbox(w - 0.06, 0.1, 0.5, 0.01), CHAR, { at: [cx, 0, z - 0.03] });
  if (p.woodKitchen) {
    b.add(G.bbox(w, 0.85, 0.6, 0.02), concept === 'omakase' ? '#5a4535' : TIMBER, { at: [cx, 0.1, z] });
    for (let x = x0 + 0.6; x < x1 - 0.1; x += 0.6) b.box(x, 0.14, z + 0.302, 0.012, 0.76, 0.01, concept === 'omakase' ? '#3f3026' : TIMBER_D);
    for (let x = x0 + 0.3; x < x1; x += 0.6) b.box(x, 0.8, z + 0.31, 0.16, 0.022, 0.02, '#3b2f27');
  } else {
    K.steel(G.rbox(w, 0.85, 0.6, 0.01), cx, 0.1, z);
    for (let x = x0 + 0.6; x < x1 - 0.1; x += 0.6) b.box(x, 0.14, z + 0.302, 0.01, 0.76, 0.01, '#55595e');
    for (let x = x0 + 0.3; x < x1; x += 0.6) K.steel(rodX(0.3, 0.009), x, 0.82, z + 0.33);
  }
  K.steel(G.rbox(w + 0.04, 0.05, 0.66, 0.012), cx, 0.95, z); // stainless worktop on every format
  K.steel(new THREE.BoxGeometry(w + 0.04, 0.06, 0.02), cx, 1.0, z - 0.32);
  b.collide(cx, z, w, 0.6, 0.95, false);
}

function splash(b: Builder, x0: number, x1: number, z: number, y0: number, y1: number): void {
  b.box((x0 + x1) / 2, y0, z, x1 - x0, y1 - y0, 0.02, TILE, undefined);
  const tw = 0.15, th = 0.075;
  for (let y = y0 + th; y < y1 - 0.01; y += th) b.box((x0 + x1) / 2, y, z + 0.011, x1 - x0, 0.005, 0.003, GROUT);
  let row = 0;
  for (let y = y0; y < y1 - 0.01; y += th, row++) for (let x = x0 + (row % 2 ? tw / 2 : tw); x < x1 - 0.02; x += tw) b.box(x, y, z + 0.011, 0.005, th, 0.003, GROUT);
}

function hood(b: Builder, K: Kit, x0: number, x1: number, wallZ: number, lit: boolean): void {
  const w = x1 - x0, cx = (x0 + x1) / 2, z = wallZ + 0.52;
  // tapered canopy: a 4-sided frustum, scaled to a rectangle
  const g = new THREE.CylinderGeometry(Math.SQRT1_2 * 0.62, Math.SQRT1_2, 0.42, 4, 1, true).rotateY(Math.PI / 4);
  g.scale(w, 1, 0.78);
  K.steel(g, cx, 2.18, z);
  K.steel(new THREE.BoxGeometry(w, 0.06, 0.78), cx, 1.94, z);
  K.steel(new THREE.BoxGeometry(w * 0.62, 0.02, 0.48), cx, 2.385, z - 0.02);
  K.steel(new THREE.BoxGeometry(0.42, 1.1, 0.34), cx, 2.95, wallZ + 0.33); // duct to the ceiling
  for (let i = 0; i < 4; i++) b.box(cx - w / 2 + 0.25 + i * (w - 0.5) / 3, 1.92, z, 0.012, 0.02, 0.7, '#4a4e53');
  for (let i = 0; i < 2; i++) b.add(G.box(0.36, 0.015, 0.08), '#fff6e0', { at: [cx + (i - 0.5) * w * 0.45, 1.905, z + 0.2], glow: lit ? '#fff1d6' : '#d9c4a0' });
  b.pool(cx, wallZ + 1.0, 1.2, '#ffe6bf');
}

function stove(b: Builder, K: Kit, x: number, y: number, z: number, n: number): void {
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const bx = x + (i - (n - 1) / 2) * 0.55;
    b.add(G.bbox(0.48, 0.06, 0.46, 0.01), '#2e2b29', { at: [bx, y, z] });
    b.add(new THREE.TorusGeometry(0.1, 0.012, 6, 16).rotateX(Math.PI / 2), '#4c4845', { at: [bx, y + 0.07, z] });
    if (i === 0) { K.steel(P.pot.clone(), bx, y + 0.075, z); b.cyl(bx, y + 0.27, z, 0.145, 0.145, 0.004, '#c9b89a', 16); }
    else if (i === 1) { K.steel(new THREE.CylinderGeometry(0.16, 0.13, 0.06, 18, 1, true), bx, y + 0.11, z); K.steel(rodX(0.3, 0.012), bx + 0.28, y + 0.13, z); }
    else b.add(G.bbox(0.4, 0.05, 0.32, 0.01), '#3b3733', { at: [bx, y + 0.07, z] }); // griddle
  }
}

// ---------------------------------------------------------------- kitchen details
function prepStation(b: Builder, K: Kit, x: number, y: number, z: number, lvl: number, kind: 'wood' | 'steel', seedId: string): void {
  // thick hinoki board, a saku of fish, the yanagiba resting on a cloth, hangiri with paddle, tezu bowl
  b.add(G.rbox(0.78, 0.045, 0.4, 0.015), HINOKI, { at: [x - 0.1, y, z + 0.05], vary: 0.02 });
  b.add(G.rbox(0.22, 0.04, 0.08, 0.012), '#ef8a5a', { at: [x - 0.25, y + 0.045, z + 0.0] });
  for (let i = 0; i < 3; i++) b.box(x - 0.25 + (i - 1) * 0.06, y + 0.085, z, 0.008, 0.002, 0.075, '#f9d9c4');
  b.add(G.rbox(0.2, 0.04, 0.08, 0.012), '#c23a3e', { at: [x - 0.25, y + 0.045, z + 0.12] });
  for (let i = 0; i < 3; i++) b.add(makeSushiGeo(), '#ef8a5a', { at: [x + 0.05 + i * 0.09, y + 0.045, z + 0.12], scale: [0.5, 0.5, 0.5], rot: [0, Math.PI / 2, 0] });
  b.box(x + 0.0, y + 0.045, z - 0.06, 0.26, 0.006, 0.12, '#f4f1ea'); // folded cloth
  K.steel(new THREE.BoxGeometry(0.26, 0.004, 0.035), x + 0.02, y + 0.055, z - 0.06);
  b.box(x - 0.15, y + 0.052, z - 0.06, 0.1, 0.018, 0.024, WALNUT);
  // hangiri (rice tub)
  const hx = x + 0.55, hz = z + 0.02;
  b.add(lathe([[0, 0], [0.17, 0], [0.18, 0.01], [0.18, 0.09], [0.165, 0.09], [0.165, 0.012], [0, 0.012]], 20), '#d8b98a', { at: [hx, y, hz] });
  for (const yy of [0.02, 0.065]) b.add(new THREE.TorusGeometry(0.182, 0.006, 4, 24).rotateX(Math.PI / 2), '#b07a45', { at: [hx, y + yy, hz] });
  b.add(G.sphere(0.155, 16, 8), RICE, { at: [hx, y + 0.06, hz], scale: [1, 0.18, 1] });
  b.add(G.rbox(0.07, 0.012, 0.22, 0.005), '#e6d2a8', { at: [hx + 0.05, y + 0.1, hz], rot: [0.35, 0.5, 0] });
  K.gloss(P.bowl.clone(), '#d9d2c4', x + 0.32, y, z - 0.16, undefined, [0.7, 0.9, 0.7]);
  if (lvl >= 3) for (let i = 0; i < 3; i++) K.gloss(P.shoyu.clone(), ['#3a2a22', '#f2e9d8', '#c9472f'][i], x - 0.52 + i * 0.07, y, z - 0.18);
  if (lvl >= 4) { b.box(x - 0.15, y + 0.06, z + 0.2, 0.3, 0.012, 0.03, GOLD); K.steel(new THREE.BoxGeometry(0.3, 0.004, 0.03), x + 0.15, y + 0.064, z + 0.2); }
  void kind; void seedId;
}

function miniStation(b: Builder, K: Kit, x: number, y: number, z: number): void {
  b.add(G.rbox(0.62, 0.04, 0.36, 0.014), HINOKI, { at: [x, y, z + 0.05], vary: 0.02 });
  b.add(G.rbox(0.18, 0.035, 0.07, 0.01), FISH[(Math.abs(Math.round(x * 7)) % 3)], { at: [x - 0.15, y + 0.04, z + 0.05] });
  K.steel(new THREE.BoxGeometry(0.24, 0.004, 0.032), x + 0.1, y + 0.045, z + 0.1);
  b.box(x - 0.06, y + 0.042, z + 0.1, 0.09, 0.016, 0.022, WALNUT);
  K.gloss(P.bowl.clone(), '#e9e2d4', x + 0.42, y, z - 0.05, undefined, [0.75, 1, 0.75]);
}

function riceCooker(b: Builder, K: Kit, x: number, y: number, z: number, small: boolean): void {
  const s = small ? 0.85 : 1;
  K.gloss(P.cooker.clone(), '#f2efe8', x, y, z, undefined, [s, s, s]);
  K.steel(new THREE.CylinderGeometry(0.182 * s, 0.182 * s, 0.03 * s, 20, 1, true), x, y + 0.2 * s, z);
  K.gloss(P.cookerLid.clone(), '#e9e5dc', x, y + 0.215 * s, z, undefined, [s, s, s]);
  b.add(G.rbox(0.1, 0.03, 0.05, 0.008), '#4b4f55', { at: [x, y + 0.29 * s, z], rot: [0, 0, 0] });
  b.add(G.box(0.07, 0.035, 0.01), '#2f3a3a', { at: [x, y + 0.08 * s, z + 0.18 * s], glow: '#ffb35a' });
  b.add(G.sphere(0.012, 6, 4), '#d34a2a', { at: [x - 0.06, y + 0.1 * s, z + 0.178 * s], glow: '#ff6a3a' });
}

function knifeBar(b: Builder, K: Kit, x: number, y: number, z: number, n: number): void {
  b.add(G.rbox(0.12 * n + 0.1, 0.035, 0.022, 0.008), '#2d2a28', { at: [x, y, z] });
  for (let i = 0; i < n; i++) {
    const kx = x - (0.12 * n) / 2 + 0.06 + i * 0.12, len = 0.2 + (i % 3) * 0.05;
    K.steel(new THREE.BoxGeometry(i % 3 === 2 ? 0.05 : 0.032, len, 0.004), kx, y + 0.0175 - len / 2 + 0.02, z + 0.014);
    b.add(G.rbox(0.026, 0.12, 0.022, 0.008), i === 0 ? '#c9a27a' : WALNUT, { at: [kx, y + 0.03, z + 0.015] });
  }
}

function hangTools(b: Builder, K: Kit, x: number, y: number, z: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const tx = x + i * 0.22, len = 0.26 + (i % 2) * 0.08;
    K.steel(rod(len, 0.006), tx, y - len / 2 - 0.02, z + 0.02);
    if (i % 3 === 1) K.steel(new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), tx, y - len - 0.02, z + 0.02); // strainer
    else K.steel(P.ladle.clone(), tx, y - len - 0.0, z + 0.02);
    b.add(new THREE.TorusGeometry(0.012, 0.003, 4, 8), '#55595e', { at: [tx, y - 0.012, z + 0.02] });
  }
}

function jarRow(b: Builder, K: Kit, x: number, y: number, z: number, n: number, rnd: () => number): void {
  const fill = ['#f2b6a8', '#b8423a', '#e6d7b0', '#7a8a4a', '#d9a441', '#5b3a26'];
  for (let i = 0; i < n; i++) {
    const jx = x + i * 0.15, s = 0.75 + rnd() * 0.35;
    b.cyl(jx, y + 0.005, z, 0.055 * s, 0.055 * s, 0.12 * s, fill[Math.floor(rnd() * fill.length)], 10);
    K.glass(P.jar.clone().scale(s, s, s), jx, y, z);
    b.cyl(jx, y + 0.165 * s, z, 0.05 * s, 0.05 * s, 0.025, i % 2 ? TIMBER : '#c9c3b6', 10);
  }
}

function shelves(b: Builder, K: Kit, x0: number, x1: number, wallZ: number, clear: (x: number) => boolean, concept: string, p: Pal, rnd: () => number): void {
  // shelf runs, broken around the menu board
  const runs: [number, number][] = [];
  let a: number | null = null;
  for (let x = x0; x <= x1 + 1e-6; x += 0.05) {
    if (clear(x) && x < x1) { if (a === null) a = x; } else if (a !== null) { if (x - a > 0.6) runs.push([a, x - 0.05]); a = null; }
  }
  const z = wallZ + 0.3;
  const wood = p.woodKitchen;
  for (const [s, e] of runs) for (const [k, y] of [[0, 1.78], [1, 2.3]] as const) {
    const w = e - s, cx = (s + e) / 2;
    if (wood) b.add(G.bbox(w, 0.04, 0.3, 0.008), concept === 'omakase' ? '#cdb489' : TIMBER, { at: [cx, y, z] });
    else K.steel(G.rbox(w, 0.03, 0.3, 0.008), cx, y, z);
    for (let x = s + 0.1; x < e; x += Math.max(0.6, w / Math.ceil(w / 1.2))) b.box(x, y - 0.16, wallZ + 0.17, 0.02, 0.16, 0.24, wood ? TIMBER_D : '#7c8086');
    // dress the shelf: alternating groups of bowls, plates, bottles, jars, tea tins
    let x = s + 0.12;
    while (x < e - 0.18) {
      const pick = Math.floor(rnd() * 5);
      const yy = y + (wood ? 0.04 : 0.03);
      if (pick === 0) { for (let j = 0; j < 4; j++) K.gloss(P.bowl.clone(), ['#e9e2d4', '#7f978c', '#a5806a'][(k + j) % 3], x + 0.05, yy + j * 0.026, z, undefined, [0.85, 1, 0.85]); x += 0.24; }
      else if (pick === 1) { for (let j = 0; j < 6; j++) K.gloss(P.plate.clone(), j % 2 ? '#efe9dc' : '#e4ddd0', x + 0.08, yy + j * 0.014, z, undefined, [0.9, 1, 0.9]); x += 0.28; }
      else if (pick === 2 && concept !== 'ghost') { for (let j = 0; j < 3; j++) { K.gloss(P.isshobin.clone(), ['#3f5a44', '#6b4a2e', '#d9d3c6', '#2c3e50'][(j + k) % 4], x + j * 0.11, yy, z, undefined, [0.85, 0.85, 0.85]); b.cyl(x + j * 0.11, yy + 0.12, z, 0.047, 0.047, 0.075, j % 2 ? '#efe6d2' : '#e6d5b8', 12); } x += 0.36; }
      else if (pick === 3) { jarRow(b, K, x + 0.04, yy, z, 2, rnd); x += 0.32; }
      else { for (let j = 0; j < 2; j++) { b.cyl(x + j * 0.11, yy, z, 0.045, 0.045, 0.14, ['#3d4f45', VERM, '#5a4232'][(j + k) % 3], 12); b.cyl(x + j * 0.11, yy + 0.14, z, 0.047, 0.047, 0.02, '#c9c3b6', 12); } x += 0.26; }
      x += 0.06;
    }
  }
}

function backDoor(b: Builder, wallX: number, z: number, cloth: string, glyph: string): void {
  b.push(wallX + 0.16, 0, z, Math.PI / 2);
  b.box(0, 0.05, 0, 1.0, 2.05, 0.02, '#2a231e');
  for (const sx of [-0.54, 0.54]) b.add(G.bbox(0.08, 2.2, 0.06, 0.01), TIMBER_D, { at: [sx, 0.05, 0.02] });
  b.add(G.bbox(1.2, 0.09, 0.07, 0.01), TIMBER_D, { at: [0, 2.2, 0.02] });
  norenCloth(b, 0, 2.12, 0.07, 1.0, 0.9, cloth, glyph, 2);
  b.pop();
}

/** Split noren: n cloth panels from a timber rod; panel tops shaded, an optional big glyph across the middle. */
function norenCloth(b: Builder, x: number, y: number, z: number, w: number, h: number, color: string, glyph: string | null, n = 3): void {
  b.add(rodX(w + 0.16, 0.018), TIMBER, { at: [x, y + 0.02, z] });
  const pw = w / n;
  for (let i = 0; i < n; i++) {
    const px = x - w / 2 + (i + 0.5) * pw;
    b.add(G.bbox(pw - 0.035, h, 0.014, 0.004), color, { at: [px, y - h, z], rot: [0.015 * (i - 1), 0, 0], vary: 0.02 });
    b.box(px, y - 0.05, z + 0.008, pw - 0.035, 0.05, 0.004, shadeHex(color, 0.82)); // folded sleeve over the rod
  }
  if (glyph) b.sign(x, y - h * 0.5, z + 0.012, Math.min(w * 0.42, h * 0.75), Math.min(w * 0.42, h * 0.75), glyph, { bg: color, fg: lum(color) > 0.6 ? INK : '#f6efe0', px: 110 });
}

function netaCase(b: Builder, K: Kit, x: number, y: number, z: number, len: number, wood: boolean, rnd: () => number): void {
  if (len < 0.6) return;
  const D = 0.38;
  if (wood) b.add(G.bbox(len + 0.04, 0.06, D + 0.02, 0.01), '#d9c29a', { at: [x, y, z] });
  else K.steel(G.rbox(len + 0.04, 0.06, D + 0.02, 0.01), x, y, z);
  b.box(x, y + 0.06, z, len - 0.04, 0.018, D - 0.04, '#eef3f2'); // ice bed
  for (let i = 0; i < Math.floor(len / 0.18); i++) b.add(G.sphere(0.04, 6, 4), '#f6fafa', { at: [x - len / 2 + 0.1 + i * 0.18, y + 0.075, z - 0.1 + (i % 2) * 0.2], scale: [1.4, 0.35, 1] });
  // saku blocks with fat lines, shiso leaves between
  let px = x - len / 2 + 0.1;
  let i = 0;
  while (px < x + len / 2 - 0.12) {
    const col = FISH[Math.floor(rnd() * FISH.length)], bw = 0.12 + rnd() * 0.05;
    b.add(G.rbox(bw, 0.04, 0.1, 0.012), col, { at: [px + bw / 2, y + 0.078, z + 0.02], vary: 0.04 });
    if (col === FISH[0] || col === FISH[1]) for (let k = 0; k < 3; k++) b.box(px + 0.03 + k * (bw / 3), y + 0.1235, z + 0.02, 0.006, 0.001, 0.11, '#fbe1d0');
    if (i++ % 2 === 0) b.add(G.box(0.07, 0.004, 0.05), '#5c8a3e', { at: [px + bw + 0.02, y + 0.08, z - 0.07], rot: [0, 0.6, 0] });
    px += bw + 0.09;
  }
  // frame posts, sloped front glass, flat top glass, LED strip
  for (const sx of [-len / 2, len / 2]) { if (wood) b.box(x + sx, y + 0.06, z, 0.03, 0.22, D, '#cdb489'); else K.steel(new THREE.BoxGeometry(0.03, 0.22, D), x + sx, y + 0.17, z); }
  K.glass(new THREE.BoxGeometry(len - 0.03, 0.2, 0.008), x, y + 0.17, z + D / 2 - 0.05, [-0.42, 0, 0]);
  K.glass(new THREE.BoxGeometry(len - 0.03, 0.008, D - 0.12), x, y + 0.27, z - 0.04);
  b.add(G.box(len - 0.1, 0.012, 0.02), '#fff8ea', { at: [x, y + 0.255, z - 0.12], glow: '#eaf6ff' });
  if (wood) b.box(x, y + 0.27, z - 0.04, len + 0.04, 0.018, 0.08, '#d9c29a');
}

function register(b: Builder, K: Kit, x: number, y: number, z: number, gold: boolean): void {
  b.add(G.rbox(0.36, 0.08, 0.3, 0.02), gold ? GOLD : '#3d3a37', { at: [x, y, z] });
  b.add(G.rbox(0.3, 0.2, 0.02, 0.008), '#2a2826', { at: [x, y + 0.08, z - 0.05], rot: [-0.3, 0, 0] });
  b.add(G.box(0.26, 0.15, 0.004), '#1e2a2a', { at: [x, y + 0.1, z - 0.035], rot: [-0.3, 0, 0], glow: '#9fd8c8' });
  K.steel(new THREE.BoxGeometry(0.12, 0.05, 0.1), x + 0.1, y + 0.08, z + 0.07);
}

// ---------------------------------------------------------------- printed matter
interface Item { jp: string; en: string; price: number; tier: number }
function menuItems(c: InteriorCtx, n: number): Item[] {
  const pm = c.r.priceMult * (CONCEPTS[c.r.concept ?? 'bar']?.price ?? 1);
  const ids = c.r.menu.filter((m) => RECIPES[m] && c.s.recipes.includes(m));
  const list = (ids.length ? ids : c.r.menu.filter((m) => RECIPES[m])).slice(0, n);
  return list.map((m) => { const p = RECIPES[m].price * pm; return { jp: RECIPES[m].jp, en: RECIPES[m].name, price: p, tier: Math.min(5, Math.floor(RECIPES[m].price / 70)) }; });
}

function washi(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bg = WASHI, seed = 3): void {
  c.fillStyle = bg; c.fillRect(x, y, w, h);
  const r = rng(seed);
  c.globalAlpha = 0.07; c.strokeStyle = '#8a7a5c'; c.lineWidth = 1;
  for (let i = 0; i < (w * h) / 900; i++) { const px = x + r() * w, py = y + r() * h, a = r() * 6.3, l = 4 + r() * 10; c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); c.stroke(); }
  c.globalAlpha = 1;
}
function hanko(c: CanvasRenderingContext2D, x: number, y: number, s: number, glyph: string): void {
  c.fillStyle = VERM; c.beginPath(); c.roundRect(x, y, s, s, s * 0.12); c.fill();
  c.strokeStyle = '#f6e9d8'; c.lineWidth = Math.max(1.5, s * 0.05); c.strokeRect(x + s * 0.12, y + s * 0.12, s * 0.76, s * 0.76);
  c.fillStyle = '#f6e9d8'; c.font = `700 ${s * 0.56}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(glyph, x + s / 2, y + s * 0.53);
}
function fitText(c: CanvasRenderingContext2D, t: string, max: number, size: number, weight = 700): number {
  c.font = `${weight} ${size}px ${FONT}`;
  const w = c.measureText(t).width;
  if (w > max) { size *= max / w; c.font = `${weight} ${size}px ${FONT}`; }
  return size;
}
/** Hanging wooden price tag (fuda): vertical name, price at the foot. */
function fuda(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, jp: string, price: number): void {
  const g = c.createLinearGradient(x, 0, x + w, 0); g.addColorStop(0, '#e7cf9f'); g.addColorStop(0.5, '#efdcb2'); g.addColorStop(1, '#ddc292');
  c.fillStyle = g; c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(120,90,50,0.25)'; c.lineWidth = 1;
  for (let i = 0; i < 6; i++) { c.beginPath(); c.moveTo(x + 8 + i * 11, y); c.bezierCurveTo(x + 4 + i * 11, y + h * 0.4, x + 14 + i * 11, y + h * 0.6, x + 8 + i * 11, y + h); c.stroke(); }
  c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
  const chars = [...jp].slice(0, 6), fs = Math.min(w * 0.62, (h * 0.66) / Math.max(3, chars.length));
  c.font = `700 ${fs}px ${FONT}`;
  chars.forEach((ch, i) => c.fillText(ch, x + w / 2, y + 14 + fs / 2 + i * fs * 1.02));
  c.fillStyle = VERM; fitText(c, yen(price), w - 8, 17); c.fillText(yen(price), x + w / 2, y + h - 18);
  c.fillStyle = '#5a4232'; c.beginPath(); c.arc(x + w / 2, y + 6, 3, 0, 7); c.fill();
}

function menuBoard(b: Builder, K: Kit, c: InteriorCtx, x: number, wallZ: number, concept: string): void {
  if (concept === 'ghost') return;
  const z = wallZ + 0.16;
  if (concept === 'omakase') {
    // a hinoki plaque, brushed vertical columns: no price list
    const r = K.paper.rect(260, 420, (cx, px, py, w, h) => {
      washi(cx, px, py, w, h, '#efe1c2', 5);
      cx.fillStyle = INK; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      const col = (t: string, colX: number, fs: number, y0: number) => { cx.font = `700 ${fs}px ${FONT}`; [...t].forEach((ch, i) => cx.fillText(ch, colX, y0 + i * fs * 1.08)); };
      col('おまかせ', px + w * 0.68, 54, py + 70);
      cx.fillStyle = '#5a4a3c'; col('本日の握り', px + w * 0.36, 30, py + 64);
      cx.fillStyle = VERM; col('時価', px + w * 0.36, 30, py + 260);
      hanko(cx, px + 26, py + h - 70, 44, '鮨');
    });
    b.add(G.bbox(1.2, 1.9, 0.05, 0.015), '#cdb489', { at: [x, 1.55, z - 0.02] });
    K.panel(x, 2.5, z + 0.01, 1.08, 1.75, r);
    return;
  }
  const items = menuItems(c, 7);
  const r = K.paper.rect(384, 480, (cx, px, py, w, h) => {
    washi(cx, px, py, w, h, WASHI, 9);
    cx.strokeStyle = INK; cx.lineWidth = 2; cx.strokeRect(px + 12, py + 12, w - 24, h - 24);
    cx.lineWidth = 1; cx.strokeRect(px + 18, py + 18, w - 36, h - 36);
    cx.fillStyle = INK; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    if (concept === 'kaiten') {
      cx.font = `700 40px ${FONT}`; cx.fillText('お皿の色', px + w / 2, py + 54);
      cx.font = `600 14px ${FONT}`; cx.fillStyle = '#6a5d4c'; cx.fillText('PLATE  COLOURS  ·  PRICE  PER  PLATE', px + w / 2, py + 86);
      cx.fillStyle = VERM; cx.fillRect(px + 60, py + 100, w - 120, 2);
      const pm = c.r.priceMult * (CONCEPTS.kaiten?.price ?? 1);
      RIMS.forEach((col, i) => {
        const yy = py + 140 + i * 50;
        cx.fillStyle = '#ffffff'; cx.beginPath(); cx.ellipse(px + 74, yy, 26, 13, 0, 0, 7); cx.fill();
        cx.strokeStyle = col; cx.lineWidth = 6; cx.beginPath(); cx.ellipse(px + 74, yy, 23, 11, 0, 0, 7); cx.stroke();
        cx.strokeStyle = 'rgba(43,39,36,0.35)'; cx.lineWidth = 1; cx.beginPath(); cx.ellipse(px + 74, yy, 27, 14, 0, 0, 7); cx.stroke();
        cx.fillStyle = INK; cx.textAlign = 'left'; cx.font = `600 22px ${FONT}`; cx.fillText(['白', '金', '朱', '藍', '墨', '若竹'][i] + ' 皿', px + 120, yy);
        cx.textAlign = 'right'; cx.fillStyle = VERM; cx.font = `700 26px ${FONT}`; cx.fillText(yen((60 + i * 70) * pm), px + w - 40, yy);
        cx.textAlign = 'center';
      });
    } else {
      cx.font = `700 44px ${FONT}`; cx.fillText('お品書き', px + w / 2, py + 56);
      cx.font = `600 14px ${FONT}`; cx.fillStyle = '#6a5d4c'; cx.fillText(concept === 'kiosk' ? 'TAKEOUT  ·  PER  PIECE' : 'TODAY’S  MENU  ·  PER  PIECE', px + w / 2, py + 90);
      cx.fillStyle = VERM; cx.fillRect(px + 60, py + 104, w - 120, 2);
      items.forEach((it, i) => {
        const yy = py + 140 + i * 44;
        cx.textAlign = 'left'; cx.fillStyle = INK; fitText(cx, it.jp, 180, 25); cx.fillText(it.jp, px + 34, yy - 4);
        cx.font = `500 11px ${FONT}`; cx.fillStyle = '#7a6d5a'; cx.fillText(it.en.toUpperCase(), px + 35, yy + 15);
        cx.textAlign = 'right'; cx.fillStyle = VERM; cx.font = `700 24px ${FONT}`; cx.fillText(yen(it.price), px + w - 34, yy);
        cx.strokeStyle = 'rgba(43,39,36,0.3)'; cx.setLineDash([2, 5]); cx.beginPath(); cx.moveTo(px + 34, yy + 24); cx.lineTo(px + w - 34, yy + 24); cx.stroke(); cx.setLineDash([]);
      });
    }
    hanko(cx, px + w - 74, py + h - 72, 42, '寿');
    cx.textAlign = 'left'; cx.fillStyle = '#6a5d4c'; cx.font = `600 13px ${FONT}`; cx.fillText(concept === 'kaiten' ? '税込 · 一皿' : '税込 · 一貫', px + 34, py + h - 50);
  });
  b.add(G.bbox(1.75, 2.15, 0.06, 0.02), TIMBER_D, { at: [x, 1.45, z - 0.02] });
  b.add(G.bbox(1.62, 0.04, 0.08, 0.01), TIMBER, { at: [x, 1.45, z] });
  K.panel(x, 2.52, z + 0.015, 1.6, 2.0, r);
  b.pool(x, wallZ + 0.9, 1.0, '#ffe2b0');
}

// ---------------------------------------------------------------- lights
function pendant(b: Builder, K: Kit, x: number, y: number, z: number, kind: 'washi' | 'dome' | 'brass' | 'bulb', pool = true): void {
  const top = 3.47;
  b.add(rod(top - y, 0.004, 4), '#2a2624', { at: [x, (top + y) / 2, z] });
  if (kind === 'washi') {
    b.add(G.cyl(0.17, 0.17, 0.34, 18), '#f6ead2', { at: [x, y - 0.34, z], glow: '#ffcf8a' });
    for (const yy of [-0.34, -0.005]) b.add(new THREE.TorusGeometry(0.17, 0.008, 4, 18).rotateX(Math.PI / 2), TIMBER_D, { at: [x, y + yy, z] });
  } else if (kind === 'dome' || kind === 'brass') {
    if (kind === 'brass') K.gloss(P.shade.clone(), GOLD, x, y - 0.16, z);
    else b.add(P.shade.clone(), '#2f2c2a', { at: [x, y - 0.16, z] });
    b.add(G.sphere(0.06, 10, 6), '#fff4dc', { at: [x, y - 0.15, z], glow: '#ffd08a' });
    b.add(new THREE.CircleGeometry(0.13, 18).rotateX(Math.PI / 2), '#ffe9c4', { at: [x, y - 0.14, z], glow: '#ffbf70' });
  } else {
    b.add(G.sphere(0.065, 10, 8), '#fff2d0', { at: [x, y - 0.06, z], scale: [1, 1.2, 1], glow: '#ffc874' });
  }
  if (pool) b.pool(x, z, 1.4, '#ffd59a');
}

function chochin(b: Builder, x: number, y: number, z: number, color: string, s = 1, text?: string): void {
  b.add(rod(0.2 * s, 0.004, 4), '#2a2624', { at: [x, y + 0.66 * s, z] });
  b.add(G.sphere(0.2 * s, 16, 12), color, { at: [x, y + 0.31 * s, z], scale: [1, 1.35, 1], glow: color === '#f3e6c8' ? '#ffd78a' : '#ff6a3a' });
  for (const k of [0.12, 0.31, 0.5]) { const rr = 0.2 * s * Math.sin(Math.acos((k - 0.31) / (0.27 * 1.0))) * 1.0; b.add(new THREE.TorusGeometry(Math.max(0.05, rr), 0.004 * s, 4, 18).rotateX(Math.PI / 2), shadeHex(color, 0.7), { at: [x, y + k * s, z] }); }
  b.cyl(x, y, z, 0.11 * s, 0.11 * s, 0.05 * s, CHAR, 12);
  b.cyl(x, y + 0.57 * s, z, 0.1 * s, 0.1 * s, 0.05 * s, CHAR, 12);
  if (text) b.sign(x, y + 0.31 * s, z + 0.205 * s, 0.16 * s, 0.3 * s, text, { bg: color, fg: color === '#f3e6c8' ? INK : '#fff3dc', vertical: true, px: 160 });
}

// ---------------------------------------------------------------- seating
function chair(b: Builder, p: Pal, kind: 'chair' | 'stool' | 'booth' | 'counter' | 'kiosk'): void {
  // frame already pushed at the seat, facing +z; seat top ≈ 0.45 m (the NPC sit pose)
  if (kind === 'chair') {
    for (const [sx, sz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) b.add(G.cyl(0.018, 0.016, 0.41, 6), p.leg, { at: [sx, 0, sz] });
    b.add(G.bbox(0.42, 0.035, 0.42, 0.01), p.seat, { at: [0, 0.385, 0] });
    b.add(G.rbox(0.4, 0.04, 0.4, 0.02), p.cushion, { at: [0, 0.42, 0.01] });
    for (const sx of [-0.18, 0.18]) b.add(G.cyl(0.016, 0.016, 0.42, 6), p.leg, { at: [sx, 0.42, -0.19] });
    b.add(G.bbox(0.42, 0.09, 0.03, 0.01), p.seat, { at: [0, 0.72, -0.19] });
    b.add(G.bbox(0.4, 0.03, 0.02, 0.008), p.seat, { at: [0, 0.56, -0.19] });
  } else if (kind === 'stool') {
    b.add(G.cyl(0.13, 0.16, 0.025, 14), '#3a3633', { at: [0, 0, 0] });
    b.add(G.cyl(0.025, 0.025, 0.36, 8), '#5a5550', { at: [0, 0.02, 0] });
    b.add(new THREE.TorusGeometry(0.13, 0.008, 4, 16).rotateX(Math.PI / 2), '#5a5550', { at: [0, 0.18, 0] });
    b.add(G.cyl(0.18, 0.17, 0.07, 18), p.cushion, { at: [0, 0.38, 0] });
  } else if (kind === 'booth') {
    b.add(G.bbox(0.72, 0.34, 0.46, 0.02), shadeHex(p.cushion, 0.75), { at: [0, 0, -0.02] });
    b.add(G.rbox(0.7, 0.1, 0.46, 0.04), p.cushion, { at: [0, 0.34, 0] });
    b.add(G.bbox(0.74, 1.1, 0.1, 0.02), shadeHex(p.cushion, 0.7), { at: [0, 0, -0.3] });
    b.add(G.rbox(0.7, 0.58, 0.1, 0.04), p.cushion, { at: [0, 0.48, -0.22], rot: [-0.08, 0, 0] });
    for (const sx of [-0.18, 0, 0.18]) b.box(sx, 0.52, -0.17, 0.008, 0.5, 0.008, shadeHex(p.cushion, 0.8));
    b.add(G.bbox(0.76, 0.04, 0.14, 0.01), '#f1ece2', { at: [0, 1.1, -0.3] });
  } else if (kind === 'counter') {
    for (const [sx, sz] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]) b.add(G.bbox(0.035, 0.42, 0.035, 0.008), p.seat, { at: [sx, 0, sz] });
    for (const sz of [-0.16, 0.16]) b.box(0, 0.16, sz, 0.32, 0.025, 0.025, p.seat);
    b.add(G.bbox(0.4, 0.035, 0.4, 0.01), p.seat, { at: [0, 0.4, 0] });
    b.add(G.rbox(0.36, 0.035, 0.34, 0.015), p.cushion, { at: [0, 0.435, 0.01] });
    b.add(G.bbox(0.38, 0.22, 0.03, 0.01), p.seat, { at: [0, 0.6, -0.18] });
    for (const sx of [-0.16, 0.16]) b.box(sx, 0.43, -0.18, 0.03, 0.2, 0.03, p.seat);
  } else {
    for (const a of [0, 2.1, 4.2]) b.add(G.cyl(0.012, 0.012, 0.44, 5), '#4a4744', { at: [Math.sin(a) * 0.13, 0, Math.cos(a) * 0.13], rot: [Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12] });
    b.add(G.cyl(0.16, 0.16, 0.04, 16), TIMBER, { at: [0, 0.42, 0] });
  }
}

interface Pair { a: { x: number; z: number; yaw: number }; b: { x: number; z: number; yaw: number }; tx: number; tz: number }
function seatPairs(c: InteriorCtx): { pairs: Pair[]; singles: { x: number; z: number; yaw: number }[] } {
  const seats = c.site.seats, n = activeSeats(PROPERTIES[c.def.id].kind, c.r.upgrades.seats ?? 0, seats.length);
  const pairs: Pair[] = [], singles: { x: number; z: number; yaw: number }[] = [];
  for (let i = 0; i < n; i++) singles.push(localSeat(c.def, seats[i]));
  for (let t = 0; 2 * t < seats.length; t++) {
    if (2 * t >= n || !seats[2 * t + 1]) continue;
    const a = localSeat(c.def, seats[2 * t]), e = localSeat(c.def, seats[2 * t + 1]);
    pairs.push({ a, b: e, tx: (a.x + e.x) / 2, tz: (a.z + e.z) / 2 });
  }
  return { pairs, singles };
}

function table(b: Builder, K: Kit, p: Pal, tx: number, tz: number, style: 'wood' | 'pedestal' | 'kaiten', rnd: () => number): void {
  if (style === 'wood') {
    for (const [sx, sz] of [[-0.33, -0.3], [0.33, -0.3], [-0.33, 0.3], [0.33, 0.3]]) b.add(G.bbox(0.05, 0.67, 0.05, 0.01), p.leg, { at: [tx + sx, 0, tz + sz] });
    b.box(tx, 0.58, tz - 0.3, 0.62, 0.05, 0.03, p.leg); b.box(tx, 0.58, tz + 0.3, 0.62, 0.05, 0.03, p.leg);
  } else {
    b.add(G.bbox(0.5, 0.03, 0.5, 0.01), '#3a3633', { at: [tx, 0, tz] });
    b.add(G.cyl(0.04, 0.05, 0.68, 10), '#3a3633', { at: [tx, 0.02, tz] });
  }
  b.add(G.bbox(0.82, 0.05, 0.76, 0.015), p.table, { at: [tx, 0.69, tz], vary: 0.03 });
  b.collide(tx, tz, 0.8, 0.75, 0.76, false);
  // setting: soy cruet, chopstick box, tea cups
  K.gloss(P.shoyu.clone(), '#ece5d6', tx - 0.02, 0.74, tz - 0.27);
  b.cyl(tx - 0.02, 0.83, tz - 0.27, 0.011, 0.011, 0.02, VERM, 6);
  b.add(G.rbox(0.2, 0.06, 0.07, 0.01), style === 'kaiten' ? '#f1ece2' : TIMBER_D, { at: [tx + 0.12, 0.74, tz - 0.29] });
  for (let i = 0; i < 5; i++) b.box(tx + 0.06 + i * 0.03, 0.8, tz - 0.29, 0.008, 0.004, 0.06, '#d9bf8f');
  for (const s of [-1, 1]) K.gloss(P.yunomi.clone(), rnd() < 0.5 ? '#8fa59a' : '#d9cfbf', tx + s * 0.25, 0.74, tz + 0.12, undefined, [0.85, 0.85, 0.85]);
  if (style === 'kaiten') {
    // order tablet on a stand + the hot-water tap and matcha tin of a conveyor table
    b.add(G.rbox(0.2, 0.14, 0.012, 0.008), '#2a2826', { at: [tx - 0.3, 0.75, tz - 0.3], rot: [-0.35, 0, 0] });
    b.add(G.box(0.18, 0.11, 0.003), '#1a2626', { at: [tx - 0.3, 0.765, tz - 0.293], rot: [-0.35, 0, 0], glow: '#ffd9a0' });
    K.steel(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 10), tx + 0.33, 0.74, tz - 0.3);
    K.steel(rodX(0.06, 0.008), tx + 0.33, 0.85, tz - 0.27);
    b.cyl(tx + 0.25, 0.74, tz - 0.31, 0.03, 0.03, 0.08, '#4f6b3a', 10);
    b.add(G.rbox(0.12, 0.05, 0.08, 0.01), '#e8b4a0', { at: [tx + 0.0, 0.74, tz - 0.3] }); // gari box
  }
}

// ---------------------------------------------------------------- formats
function bar(b: Builder, K: Kit, c: InteriorCtx, L: Layout, p: Pal, topY: number, salary: boolean): void {
  const { w, d, style } = c.def, u = c.r.upgrades, rnd = rng(c.def.id.length * 17 + 3);
  const lux = style === 'lux', wood = style === 'wood' && !salary;
  const cx = (L.counterX0 + L.counterX1) / 2, cw = L.counterX1 - L.counterX0;
  const { pairs } = seatPairs(c);
  for (const pr of pairs) {
    table(b, K, p, pr.tx, pr.tz, wood || lux ? 'wood' : 'pedestal', rnd);
    for (const s of [pr.a, pr.b]) { b.push(s.x, 0, s.z, s.yaw); chair(b, p, wood || lux ? 'chair' : 'stool'); b.pop(); }
  }
  // counter place settings for the guests in the queue line
  for (let x = L.counterX0 + 0.5; x < L.counterX1 - 0.3; x += 0.75) if (Math.abs(x - L.qx - 1.3) > 0.9 + (u.fridge ?? 0) * 0.5) {
    b.add(G.rbox(0.3, 0.02, 0.12, 0.008), lux ? '#7a9a5a' : WALNUT, { at: [x, topY, L.cz + 0.34] });
    K.gloss(P.ochoko.clone(), '#d9cfbf', x + 0.2, topY, L.cz + 0.34, undefined, [1.4, 1.4, 1.4]);
  }
  // bottles & lanterns: a back-bar of sake above the pass, chochin over the counter
  const bx = w / 2 - 0.95;
  b.add(G.bbox(1.5, 0.04, 0.26, 0.01), TIMBER, { at: [bx - 0.05, 2.62, -d + 0.3] });
  for (let i = 0; i < 6; i++) { K.gloss(P.isshobin.clone(), ['#3f5a44', '#6b4a2e', '#d9d3c6', '#2c3e50', '#7a3b2a', '#3f5a44'][i], bx - 0.68 + i * 0.25, 2.66, -d + 0.3, undefined, [0.9, 0.9, 0.9]); b.cyl(bx - 0.68 + i * 0.25, 2.78, -d + 0.3, 0.05, 0.05, 0.1, i % 2 ? '#f1e7d3' : '#e8d6b6', 12); }
  const ll = u.lanterns ?? 0;
  const nLan = wood ? 3 + ll * 2 : lux ? 0 : ll;
  for (let i = 0; i < nLan; i++) {
    const lx = cx - cw / 2 + 0.6 + (i + 0.5) * ((cw - 1.2) / nLan);
    if (Math.abs(lx - L.qx) < 0.35) continue;
    chochin(b, lx, 2.25, L.cz + 0.3, i % 2 ? '#f3e6c8' : '#cf3a2c', 0.85, i % 3 === 0 ? 'すし' : undefined);
  }
  if (wood) {
    // hanging wooden price tags over the counter
    const tags = menuItems(c, 8);
    b.add(rodX(cw - 0.4, 0.014), TIMBER_D, { at: [cx, 2.75, L.cz - 0.55] });
    tags.forEach((it, i) => {
      const r = K.paper.rect(72, 210, (cc, x, y, ww, hh) => fuda(cc, x, y, ww, hh, it.jp, it.price));
      const tx = L.counterX0 + 0.5 + i * Math.min(0.42, (cw - 1) / tags.length);
      K.panel(tx, 2.38, L.cz - 0.54, 0.22, 0.64, r);
    });
    // kamidana in the corner
    b.add(G.bbox(1.0, 0.05, 0.34, 0.01), TIMBER, { at: [-w / 2 + 0.9, 2.78, -d + 0.32] });
    b.add(hipRoof(0.5, 0.26, 0.2), TIMBER_D, { at: [-w / 2 + 0.9, 3.04, -d + 0.3] });
    b.add(G.bbox(0.36, 0.22, 0.22, 0.01), '#d9c29a', { at: [-w / 2 + 0.9, 2.83, -d + 0.3] });
    for (const sx of [-0.32, 0.32]) b.add(G.cyl(0.03, 0.03, 0.12, 8), '#f3efe6', { at: [-w / 2 + 0.9 + sx, 2.83, -d + 0.3] });
  }
  if (salary) {
    // meal-ticket machine by the door + a stand-up ledge along the left wall
    b.push(w / 2 - 0.45, 0, -1.2, -Math.PI / 2);
    b.add(G.rbox(0.8, 1.7, 0.55, 0.04), '#e6dfd3', { at: [0, 0, 0] });
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) b.add(G.box(0.2, 0.11, 0.02), ['#e3c46a', '#e39a6a', '#a9c08a', '#c9d3de'][i], { at: [-0.24 + j * 0.24, 0.85 + i * 0.15, 0.28], glow: '#6a5a30' });
    b.add(G.box(0.5, 0.2, 0.03), '#2b2826', { at: [0, 0.3, 0.28] });
    b.sign(0, 1.55, 0.29, 0.62, 0.2, '食券 · Tickets', { bg: VERM, fg: '#fff6e6', px: 120 });
    b.collide(0, 0, 0.8, 0.55, 1.7, false);
    b.pop();
    b.add(G.bbox(0.38, 0.05, d * 0.5, 0.01), '#c49a6c', { at: [-w / 2 + 0.36, 1.05, -d / 2] });
  }
  // lights
  const kind = wood ? 'washi' : lux ? 'brass' : salary ? 'bulb' : 'dome';
  for (const pr of pairs) pendant(b, K, pr.tx, kind === 'bulb' ? 2.5 : 2.35, pr.tz, kind);
  for (let x = L.counterX0 + 0.9; x < L.counterX1 - 0.4; x += 1.5) if (Math.abs(x - L.qx) > 0.6) pendant(b, K, x, 2.55, -d + 1.5, lux ? 'brass' : 'dome', false);
  plants(b, K, c, w, d);
}

function kaiten(b: Builder, K: Kit, c: InteriorCtx, L: Layout, p: Pal, topY: number): void {
  const { w, d } = c.def, rnd = rng(c.def.id.length * 29 + 5);
  const { pairs } = seatPairs(c);
  for (const pr of pairs) {
    table(b, K, p, pr.tx, pr.tz, 'kaiten', rnd);
    for (const s of [pr.a, pr.b]) { b.push(s.x, 0, s.z, s.yaw); chair(b, p, 'booth'); b.pop(); }
    pendant(b, K, pr.tx, 2.3, pr.tz, 'dome');
  }
  belt(b, K, L, topY);
  // plate towers at the counter end and a lit lane sign on the side wall
  for (let i = 0; i < 4; i++) for (let j = 0; j < 7 + (i % 2) * 3; j++) K.gloss(P.plate.clone(), j % 3 === 2 ? RIMS[(i + 1) % RIMS.length] : '#f3eee4', L.counterX1 - 0.25 - (i % 2) * 0.26, topY + j * 0.023, L.cz - 0.25 + Math.floor(i / 2) * 0.0, undefined, [0.95, 1, 0.95]);
  b.add(G.bbox(0.08, 0.95, 2.7, 0.02), '#2b2724', { at: [w / 2 - 0.18, 1.6, -d * 0.45] });
  b.sign(w / 2 - 0.23, 2.07, -d * 0.45, 2.45, 0.78, '回転寿司', { bg: '#2b2724', fg: '#ffb38a', px: 80, ry: -Math.PI / 2, border: GOLD });
  // linear light over the belt
  const cx = (L.counterX0 + L.counterX1) / 2, cw = L.counterX1 - L.counterX0;
  b.add(G.bbox(cw - 0.6, 0.06, 0.2, 0.02), '#e9e4da', { at: [cx, 2.75, L.cz + 0.1] });
  b.add(G.box(cw - 0.7, 0.01, 0.14), '#fff8ea', { at: [cx, 2.745, L.cz + 0.1], glow: '#ffe7c0' });
  for (const sx of [-0.4, 0.4]) b.add(rod(0.7, 0.004, 4), '#3a3633', { at: [cx + sx * (cw - 1), 3.12, L.cz + 0.1] });
  b.pool(cx, L.cz + 0.6, 2.4, '#ffe0b0');
  plants(b, K, c, w, d);
}

/** The conveyor: a stadium loop on the counter; plates (colour-coded rims) and sushi ride it via instancing. */
function belt(b: Builder, K: Kit, L: Layout, topY: number): void {
  const x0 = L.counterX0 + 0.45, x1 = L.counterX1 - 0.5, zc = L.cz + 0.06, R = 0.2, y = topY;
  const stadium = (hw: number) => {
    const s = new THREE.Shape(), cy = -zc;
    s.moveTo(x0, cy - hw); s.lineTo(x1, cy - hw); s.absarc(x1, cy, hw, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(x0, cy + hw); s.absarc(x0, cy, hw, Math.PI / 2, Math.PI * 1.5, false);
    return s;
  };
  const ring = (outer: number, inner: number, h: number) => {
    const s = stadium(outer); s.holes.push(stadium(inner));
    return new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2);
  };
  b.add(ring(R + 0.15, R - 0.13, 0.03), '#ece6da', { at: [0, y, 0], vary: 0 }); // belt band (ivory crescent slats)
  K.steel(ring(R + 0.17, R + 0.145, 0.06), 0, y, 0); // outer guard lip
  K.steel(new THREE.ExtrudeGeometry(stadium(R - 0.12), { depth: 0.075, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2), 0, y, 0); // centre spine
  // slat seams across the straights
  for (let x = x0; x < x1; x += 0.09) for (const zz of [zc + R, zc - R]) b.box(x, y + 0.03, zz, 0.006, 0.002, 0.26, '#cfc7b8');

  const S = x1 - x0, A = Math.PI * R, PER = 2 * S + 2 * A, n = Math.floor(PER / 0.34);
  const recipes = ['salmon_nigiri', 'tuna_nigiri', 'shrimp_nigiri', 'eel_nigiri', 'tuna_maki', 'roe_gunkan'];
  const tier = [0, 1, 2, 3, 4, 5];
  const body = new THREE.InstancedMesh(withColor(P.plate.clone(), '#f5f1e8'), mat('paintGloss'), n);
  const rim = new THREE.InstancedMesh(withColor(P.rim.clone(), '#ffffff'), mat('paintGloss'), n);
  const groups = recipes.map((id) => new THREE.InstancedMesh(pieceGeo(id), VC_MAT, n));
  const slot: [number, number][] = []; // plate i -> [recipe, index]
  const counts = recipes.map(() => 0);
  const rc = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const k = (i * 7 + (i >> 2)) % recipes.length;
    slot.push(i % 9 === 8 ? [-1, 0] : [k, counts[k]++]); // an empty plate now and then: someone just took it
    rim.setColorAt(i, rc.set(RIMS[tier[k]]));
  }
  groups.forEach((g, k) => { g.count = counts[k]; });
  const all = [body, rim, ...groups];
  const bs = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, y, zc), S / 2 + R + 0.4);
  for (const m of all) { m.castShadow = false; m.receiveShadow = true; m.boundingSphere = bs.clone(); m.frustumCulled = true; }
  body.castShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(0.82, 0.82, 0.82);
  let last = -1;
  const place = (t: number) => {
    for (let i = 0; i < n; i++) {
      let u = ((i * PER) / n + t) % PER, x: number, z: number, h: number;
      if (u < S) { x = x0 + u; z = zc + R; h = Math.PI / 2; }
      else if ((u -= S) < A) { const a = u / R; x = x1 + Math.sin(a) * R; z = zc + Math.cos(a) * R; h = Math.PI / 2 + a; }
      else if ((u -= A) < S) { x = x1 - u; z = zc - R; h = -Math.PI / 2; }
      else { u -= S; const a = u / R; x = x0 - Math.sin(a) * R; z = zc - Math.cos(a) * R; h = -Math.PI / 2 + a; }
      v.set(x, y + 0.032, z); q.setFromAxisAngle(up, h);
      m4.compose(v, q, one); body.setMatrixAt(i, m4); rim.setMatrixAt(i, m4);
      v.y += 0.012; q.setFromAxisAngle(up, h + Math.PI / 2);
      m4.compose(v, q, sc);
      const [k, j] = slot[i]; if (k >= 0) groups[k].setMatrixAt(j, m4);
    }
    for (const m of all) m.instanceMatrix.needsUpdate = true;
  };
  place(0);
  // ponytail: animated in onBeforeRender (one frame of lag, no hook in SiteView.animate); time-based so extra passes are free
  body.onBeforeRender = () => {
    const t = performance.now() / 1000;
    if (t === last) return;
    last = t;
    place((t * 0.11) % PER);
  };
  K.extra.push(...all);
}

function omakase(b: Builder, K: Kit, c: InteriorCtx, L: Layout, p: Pal, topY: number): void {
  const { w, d } = c.def, rnd = rng(c.def.id.length * 41 + 9);
  const { singles } = seatPairs(c);
  const glazes = ['#a9bfae', '#e6dfd0', '#6f5a48', '#c7b79b', '#3f4a48'];
  singles.forEach((s, i) => {
    b.push(s.x, 0, s.z, s.yaw); chair(b, p, 'counter'); b.pop();
    // place setting in front of the guest: geta board / ceramic plate, hashi-oki + chopsticks, soy dish, ochoko
    const sx = s.x, z = L.cz + 0.3;
    if (i % 2 === 0) b.add(G.rbox(0.3, 0.025, 0.16, 0.01), '#e0c79c', { at: [sx - 0.02, topY, z - 0.02] });
    else K.gloss(P.plate.clone(), glazes[i % glazes.length], sx - 0.02, topY, z - 0.02, undefined, [1.1, 1, 0.75]);
    b.add(G.rbox(0.04, 0.015, 0.025, 0.006), '#5a4a3c', { at: [sx + 0.2, topY, z + 0.08] });
    for (const dz of [-0.008, 0.008]) b.add(G.box(0.22, 0.007, 0.007), '#e8d6b0', { at: [sx + 0.12, topY + 0.016, z + 0.08 + dz], rot: [0, 0.03, 0] });
    K.gloss(P.ochoko.clone(), glazes[(i + 2) % glazes.length], sx + 0.18, topY, z - 0.08, undefined, [1.2, 1.2, 1.2]);
    if (i % 3 === 1) K.gloss(P.tokkuri.clone(), '#d8d0c0', sx + 0.27, topY, z - 0.12);
    if (i % 2 === 0) for (let k = 0; k < 2; k++) b.add(makeSushiGeo(), '#ef8a5a', { at: [sx - 0.07 + k * 0.1, topY + 0.025, z - 0.02], scale: [0.5, 0.5, 0.5], rot: [0, Math.PI / 2, 0] });
  });
  // warm pendants over the counter, one per guest pair
  for (let x = L.counterX0 + 0.7; x < L.counterX1 - 0.3; x += 1.25) pendant(b, K, x, 2.25, L.cz + 0.25, 'washi');
  // scroll + ikebana alcove on the left wall, sake display on the back shelf
  b.push(-w / 2 + 0.16, 0, -d * 0.55, Math.PI / 2);
  b.add(G.bbox(1.2, 0.08, 0.42, 0.01), '#c9ad84', { at: [0, 0.32, 0.21] });
  b.add(G.bbox(0.05, 0.32, 0.4, 0.01), '#5a4535', { at: [-0.55, 0, 0.21] }); b.add(G.bbox(0.05, 0.32, 0.4, 0.01), '#5a4535', { at: [0.55, 0, 0.21] });
  b.add(G.box(0.62, 1.55, 0.012), '#efe6d2', { at: [-0.25, 0.75, 0.01] });
  b.add(rodX(0.72, 0.014), '#3b2f27', { at: [-0.25, 2.31, 0.02] }); b.add(rodX(0.72, 0.014), '#3b2f27', { at: [-0.25, 0.75, 0.02] });
  b.sign(-0.25, 1.6, 0.02, 0.4, 1.2, '一期一会', { bg: '#efe6d2', fg: INK, vertical: true, px: 90 });
  ikebana(b, K, 0.3, 0.4, 0.22, rnd);
  b.pop();
  K.gloss(P.isshobin.clone(), '#3f5a44', w / 2 - 1.1, 1.0, -d + 0.3);
  b.cyl(w / 2 - 1.1, 1.12, -d + 0.3, 0.056, 0.056, 0.12, '#f1e7d3', 12);
  for (let i = 0; i < 3; i++) b.add(G.bbox(0.12, 0.08, 0.12, 0.004), '#e2c99c', { at: [w / 2 - 0.8 + i * 0.15, 1.0, -d + 0.35] }); // masu
  // the room: a low wood rail at dado height, and spot pools on the counter
  b.box(0, 0.9, -0.2, w - 0.4, 0.03, 0.03, '#5a4535');
  b.pool(L.qx, L.cz + 0.5, 3.0, '#ffcf8a');
  plants(b, K, c, w, d);
}

function ikebana(b: Builder, K: Kit, x: number, y: number, z: number, rnd: () => number): void {
  K.gloss(P.vase.clone(), '#3f4a48', x, y, z, undefined, [0.8, 0.9, 0.8]);
  for (let i = 0; i < 5; i++) {
    const a = -0.7 + i * 0.35 + rnd() * 0.2, len = 0.45 + rnd() * 0.45;
    b.add(G.cyl(0.006, 0.009, len, 4), '#5a4a32', { at: [x, y + 0.26, z], rot: [Math.sin(i) * 0.25, 0, a * 0.6] });
    const tx = x - Math.sin(a * 0.6) * len, ty = y + 0.26 + Math.cos(a * 0.6) * len;
    b.add(G.sphere(0.035, 8, 6), i % 2 ? '#f2c6cf' : '#ffffff', { at: [tx, ty, z + Math.sin(i) * 0.25 * len] });
    if (i % 2 === 0) b.add(G.box(0.08, 0.004, 0.035), '#5f7d43', { at: [x - Math.sin(a * 0.6) * len * 0.6, y + 0.26 + Math.cos(a * 0.6) * len * 0.6, z], rot: [0, i, 0.4] });
  }
}

function kiosk(b: Builder, K: Kit, c: InteriorCtx, L: Layout, p: Pal): void {
  const { w, d } = c.def, rnd = rng(c.def.id.length * 53 + 1);
  const { singles } = seatPairs(c);
  // ledges (left wall + front window) and stools on the guest spots
  const lz0 = -1.2, lz1 = L.cz + 2.0;
  b.add(G.bbox(0.36, 0.05, lz0 - lz1 + 0.6, 0.01), TIMBER, { at: [-w / 2 + 0.32, 0.86, (lz0 + lz1) / 2], vary: 0.02 });
  for (let z = lz1; z < lz0; z += 1.2) b.box(-w / 2 + 0.22, 0.6, z, 0.03, 0.26, 0.03, '#57534d');
  b.collide(-w / 2 + 0.3, (lz0 + lz1) / 2, 0.36, lz0 - lz1 + 0.6, 0.9, false);
  for (const [a, e] of [[-w / 2 + 0.4, L.doorX - 1.2], [L.doorX + 1.2, w / 2 - 1.4]]) if (e - a > 0.5) {
    b.add(G.bbox(e - a, 0.05, 0.34, 0.01), TIMBER, { at: [(a + e) / 2, 0.86, -0.32], vary: 0.02 });
    b.collide((a + e) / 2, -0.3, e - a, 0.3, 0.9, false);
  }
  singles.forEach((s) => { b.push(s.x, 0, s.z, s.yaw); chair(b, p, 'kiosk'); b.pop(); });
  // open multi-deck chiller of packed bento on the right wall
  const chx = w / 2 - 0.4, chz = -2.4;
  b.push(chx, 0, chz, -Math.PI / 2);
  b.add(G.bbox(1.9, 2.0, 0.55, 0.02), '#e6e1d8', { at: [0, 0, 0] });
  b.box(0, 0.1, 0.0, 1.76, 1.7, 0.5, '#2d2b29');
  for (let k = 0; k < 4; k++) {
    const yy = 0.32 + k * 0.4;
    K.steel(new THREE.BoxGeometry(1.76, 0.02, 0.44), 0, yy, 0.03);
    for (let j = 0; j < 5; j++) bento(b, K, -0.7 + j * 0.35, yy + 0.01, 0.06, (k + j) % 4, rnd);
    b.add(G.box(1.7, 0.012, 0.02), '#fff7ea', { at: [0, yy + 0.37, 0.2], glow: '#fff0d6' });
  }
  b.add(G.box(1.8, 0.2, 0.02), '#8aa287', { at: [0, 1.82, 0.28] });
  b.sign(0, 1.92, 0.295, 1.2, 0.17, 'お弁当 · Bento', { bg: '#8aa287', fg: '#fbf7ee', px: 120 });
  b.collide(0, 0, 1.9, 0.55, 2.0, false);
  b.pop();
  // packed bento + bags on the counter for pickup
  for (let i = 0; i < 6; i++) bento(b, K, L.counterX1 - 0.4 - (i % 3) * 0.36, 1.08 + Math.floor(i / 3) * 0.06, L.cz + 0.1, i % 4, rnd);
  for (let i = 0; i < 3; i++) { b.add(G.bbox(0.26, 0.32, 0.15, 0.01), '#cdb08a', { at: [L.counterX0 + 0.4 + i * 0.32, 1.08, L.cz + 0.05] }); b.box(L.counterX0 + 0.4 + i * 0.32, 1.4, L.cz + 0.05, 0.12, 0.05, 0.004, '#a88b66'); }
  // lightbox menu over the takeout counter
  const r = K.paper.rect(512, 180, (cx, x, y, ww, hh) => {
    washi(cx, x, y, ww, hh, '#fbf6ea', 21);
    cx.fillStyle = '#5e7a60'; cx.fillRect(x, y, ww, 34);
    cx.fillStyle = '#fbf6ea'; cx.font = `700 22px ${FONT}`; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText('持ち帰り · TAKEOUT PACKS', x + ww / 2, y + 18);
    const items = menuItems(c, 3);
    items.forEach((it, i) => {
      const px = x + 22 + i * 164;
      cx.fillStyle = '#2b2724'; cx.beginPath(); cx.roundRect(px, y + 48, 140, 70, 8); cx.fill();
      cx.fillStyle = '#f6f0e2'; cx.beginPath(); cx.roundRect(px + 6, y + 54, 128, 58, 5); cx.fill();
      for (let k = 0; k < 4; k++) { cx.fillStyle = '#f4ede0'; cx.beginPath(); cx.ellipse(px + 24 + k * 31, y + 86, 12, 8, 0, 0, 7); cx.fill(); cx.fillStyle = FISH[(i + k) % 5]; cx.beginPath(); cx.ellipse(px + 24 + k * 31, y + 82, 12, 6, 0, 0, 7); cx.fill(); }
      cx.fillStyle = INK; fitText(cx, it.jp, 130, 18); cx.fillText(it.jp, px + 70, y + 138);
      cx.fillStyle = VERM; cx.font = `700 18px ${FONT}`; cx.fillText(yen(it.price * 6) + ' / 6', px + 70, y + 162);
    });
  });
  const lx = (L.counterX0 + L.counterX1) / 2;
  b.add(G.bbox(2.9, 1.06, 0.1, 0.02), '#2d2b29', { at: [lx, 2.35, L.cz - 0.2] });
  K.panel(lx, 2.88, L.cz - 0.145, 2.8, 0.98, r, 0, true);
  for (const sx of [-1.2, 1.2]) b.add(rod(0.08, 0.006, 4), '#3a3633', { at: [lx + sx, 3.43, L.cz - 0.2] });
  // flush light panels
  for (let x = -w / 2 + 1.5; x < w / 2 - 1; x += 2.5) if (Math.abs(x - L.qx) > 1.2) for (const z of [-1.4, -d * 0.45]) { b.add(G.bbox(1.3, 0.05, 0.5, 0.01), '#f4f1ea', { at: [x, 3.4, z] }); b.add(G.box(1.2, 0.005, 0.4), '#fffaf0', { at: [x, 3.395, z], glow: '#fff1d8' }); b.pool(x, z, 1.6, '#fff0d0'); }
  plants(b, K, c, w, d);
}

function bento(b: Builder, K: Kit, x: number, y: number, z: number, kind: number, rnd: () => number): void {
  b.add(G.rbox(0.3, 0.05, 0.2, 0.01), kind === 3 ? '#2b2724' : '#3a3431', { at: [x, y, z] });
  b.box(x, y + 0.035, z, 0.27, 0.012, 0.17, '#f1ebdd');
  for (let k = 0; k < 4; k++) b.add(G.rbox(0.052, 0.028, 0.09, 0.01), FISH[Math.floor(rnd() * 5)], { at: [x - 0.1 + k * 0.066, y + 0.045, z - 0.02] });
  b.box(x + 0.08, y + 0.045, z + 0.06, 0.07, 0.01, 0.04, '#e8b4a0');
  b.box(x - 0.08, y + 0.045, z + 0.06, 0.06, 0.008, 0.05, '#6d9a4a');
  K.glass(new THREE.BoxGeometry(0.3, 0.07, 0.2), x, y + 0.036, z); // clear lid
  b.box(x, y + 0.03, z + 0.101, 0.3, 0.028, 0.002, ['#b82d25', '#c99a3c', '#5e7a60', '#2f4a6b'][kind]); // band label
}

function ghost(b: Builder, K: Kit, c: InteriorCtx, L: Layout, hx0: number): void {
  const { w, d } = c.def, u = c.r.upgrades, rnd = rng(c.def.id.length * 67 + 2);
  // racks of insulated delivery bags along both side walls
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.42), zc = -d * 0.45;
    for (const zz of [-1.15, 1.15]) for (const xx of [-0.22, 0.22]) K.steel(rod(1.9, 0.016, 6), x + xx, 0.95, zc + zz);
    for (const y of [0.1, 0.62, 1.14, 1.66]) K.steel(new THREE.BoxGeometry(0.5, 0.025, 2.4), x, y, zc);
    for (const y of [0.13, 0.65, 1.17]) for (let k = 0; k < 4; k++) {
      const bagC = ['#b82d25', '#c99a3c', '#2f4a6b', '#3d4a52'][(k + Math.round(y * 3)) % 4];
      b.add(G.rbox(0.36, 0.34, 0.42, 0.05), bagC, { at: [x, y, zc - 0.9 + k * 0.6] });
      b.box(x + sx * -0.181, y + 0.2, zc - 0.9 + k * 0.6, 0.004, 0.08, 0.2, '#f4efe6');
      b.add(rodX(0.2, 0.01), '#2b2724', { at: [x, y + 0.36, zc - 0.9 + k * 0.6], rot: [0, Math.PI / 2, 0] });
    }
    b.collide(x, zc, 0.5, 2.4, 1.9, false);
  }
  // packing island with bags being filled, a heat-lamp pass on the counter
  const iz = -d * 0.42;
  for (const [ia, ie] of [[-w / 2 + 0.9, L.qx - 1.1], [L.qx + 1.2, w / 2 - 1.6]]) if (ie - ia > 1.8) {
    const ix = (ia + ie) / 2;
    K.steel(G.rbox(1.6, 0.05, 0.8, 0.01), ix, 0.86, iz);
    K.steel(new THREE.BoxGeometry(1.5, 0.02, 0.7), ix, 0.2, iz);
    for (const [sx, sz] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, 0.35], [0.75, 0.35]]) K.steel(rod(0.86, 0.018), ix + sx, 0.43, iz + sz);
    for (let i = 0; i < 4; i++) bento(b, K, ix - 0.55 + i * 0.36, 0.91, iz + 0.15, i % 4, rnd);
    for (let i = 0; i < 2; i++) b.add(G.rbox(0.42, 0.36, 0.3, 0.05), '#b82d25', { at: [ix - 0.35 + i * 0.7, 0.91, iz - 0.2] });
    b.collide(ix, iz, 1.6, 0.8, 0.9, false);
    b.add(G.rbox(0.25, 0.1, 0.18, 0.02), '#e9e5dc', { at: [ix + 0.6, 0.91, iz - 0.25] }); // ticket printer
    b.box(ix + 0.6, 0.98, iz - 0.15, 0.08, 0.2, 0.003, '#fbf8f0');
  }
  const pcx = (L.counterX0 + L.counterX1) / 2, pcw = L.counterX1 - L.counterX0;
  K.steel(new THREE.BoxGeometry(pcw - 0.4, 0.04, 0.4), pcx, 1.62, L.cz);
  for (const sx of [-0.5, 0.5]) K.steel(rod(0.56, 0.015), pcx + sx * (pcw - 0.6), 1.34, L.cz);
  for (let x = pcx - pcw / 2 + 0.5; x < pcx + pcw / 2 - 0.3; x += 0.7) b.add(G.box(0.4, 0.012, 0.1), '#ffb47a', { at: [x, 1.6, L.cz], glow: '#ff9a4a' });
  for (let i = 0; i < Math.min(8, Math.floor(pcw / 0.5)); i++) {
    const x = pcx - pcw / 2 + 0.4 + i * 0.5;
    if (i % 2) b.add(G.rbox(0.3, 0.24, 0.24, 0.03), '#cdb08a', { at: [x, 1.08, L.cz + 0.05] });
    else bento(b, K, x, 1.08, L.cz + 0.05, i % 4, rnd);
  }
  b.pool(pcx, L.cz, 2.2, '#ffc890');
  // order screens: above the back line and over the pass
  const tickets = (n: number) => K.paper.rect(320, 180, (cx, x, y, ww, hh) => {
    cx.fillStyle = '#1e2422'; cx.fillRect(x, y, ww, hh);
    cx.fillStyle = '#2c3532'; cx.fillRect(x, y, ww, 26);
    cx.fillStyle = '#e9e2d0'; cx.font = `700 15px ${FONT}`; cx.textAlign = 'left'; cx.textBaseline = 'middle'; cx.fillText('注文 · ORDERS', x + 10, y + 13);
    cx.textAlign = 'right'; cx.fillStyle = '#c99a3c'; cx.fillText(`${12 + n * 3} 件`, x + ww - 10, y + 13);
    const items = menuItems(c, 6);
    for (let i = 0; i < 3; i++) {
      const tx = x + 8 + i * 104, st = (i + n) % 3;
      cx.fillStyle = '#f3ecdc'; cx.fillRect(tx, y + 34, 96, 136);
      cx.fillStyle = ['#7d9a6a', '#c99a3c', '#b82d25'][st]; cx.fillRect(tx, y + 34, 96, 18);
      cx.fillStyle = '#fbf7ee'; cx.font = `700 12px ${FONT}`; cx.textAlign = 'left'; cx.fillText(`#${1040 + n * 7 + i}`, tx + 5, y + 43);
      cx.textAlign = 'right'; cx.fillText(['新規', '調理中', '受取待'][st], tx + 91, y + 43);
      cx.fillStyle = INK; cx.textAlign = 'left';
      for (let k = 0; k < 4; k++) { const it = items[(i * 2 + k + n) % Math.max(1, items.length)]; if (!it) break; cx.font = `600 12px ${FONT}`; cx.fillText(`${1 + ((k + i) % 3)} × ${it.jp.slice(0, 6)}`, tx + 6, y + 66 + k * 20); }
      cx.fillStyle = '#d9cfbb'; cx.fillRect(tx + 6, y + 152, 84, 6);
      cx.fillStyle = ['#7d9a6a', '#c99a3c', '#b82d25'][st]; cx.fillRect(tx + 6, y + 152, 84 * (0.3 + st * 0.3), 6);
    }
  });
  const scr = (x: number, y: number, z: number, n: number, ry = 0) => {
    b.push(x, 0, z, ry);
    b.add(G.rbox(1.1, 0.66, 0.05, 0.015), '#1a1a1a', { at: [0, y - 0.33, 0] });
    K.panel(x, y, z + 0.03, 1.02, 0.58, tickets(n), ry, true);
    b.pop();
  };
  scr(L.qx - 1.6, 2.05, -d + 0.16, 0);
  scr(L.qx + 1.6, 2.05, -d + 0.16, 1);
  if ((u.delivery ?? 0) >= 1 || (u.station ?? 0) >= 2) scr(L.qx + 2.9, 2.05, -d + 0.16, 2);
  scr(pcx, 2.25, L.cz - 0.2, 3);
  // bright, even light: LED panel grid
  for (let x = -w / 2 + 1.4; x < w / 2 - 0.8; x += 2.2) for (let z = -1.0; z > -d + 0.6; z -= 2.0) {
    b.add(G.bbox(1.2, 0.04, 0.3, 0.008), '#e9eaeb', { at: [x, 3.42, z] });
    b.add(G.box(1.12, 0.004, 0.24), '#ffffff', { at: [x, 3.418, z], glow: '#fff9ee' });
    b.pool(x, z, 1.5, '#fff4e2');
  }
  void hx0;
}

function plants(b: Builder, K: Kit, c: InteriorCtx, w: number, d: number): void {
  const pl = c.r.upgrades.plants ?? 0;
  if (!pl) return;
  const spots: [number, number][] = [[w / 2 - 0.45, -0.5], [-w / 2 + 0.45, -d + 3.6]];
  if (c.r.concept === 'kiosk') spots[0] = [w / 2 - 0.45, -d + 3.6];
  spots.slice(0, pl >= 2 ? 2 : 1).forEach(([x, z], i) => {
    K.gloss(lathe([[0, 0], [0.16, 0], [0.2, 0.36], [0.21, 0.4], [0, 0.4]], 16), i ? '#c9bfae' : '#3f4a48', x, 0, z);
    b.cyl(x, 0.37, z, 0.19, 0.19, 0.02, '#5a4632', 14);
    for (let k = 0; k < 9; k++) {
      const a = k * 2.4, h = 0.6 + (k % 3) * 0.25;
      b.add(G.cyl(0.008, 0.01, h, 4), '#6d7f4a', { at: [x, 0.38, z], rot: [Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3] });
      b.add(G.sphere(0.09, 6, 4), k % 2 ? '#7f9a63' : '#6a8a55', { at: [x - Math.sin(a) * 0.3 * h * 0.95, 0.38 + h * 0.96, z + Math.cos(a) * 0.3 * h * 0.95], scale: [1.4, 0.35, 0.7] });
    }
    b.collide(x, z, 0.42, 0.42, 1.2, false);
  });
}

// ---------------------------------------------------------------- small utilities
function shadeHex(hex: string, f: number): string { return '#' + new THREE.Color(hex).multiplyScalar(f).getHexString(); }
function lum(hex: string): number { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function withColor(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const hipRoof = (w: number, d: number, h: number) => new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0).scale(w, h, d);
function pieceGeo(id: string): THREE.BufferGeometry { return (makeSushi(id).geometry as THREE.BufferGeometry).clone(); }
function makeSushiGeo(): THREE.BufferGeometry { const g = pieceGeo('salmon_nigiri'); g.deleteAttribute('color'); return g; }
