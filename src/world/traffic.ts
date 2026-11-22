// Street traffic: procedural scale-model vehicles (one InstancedMesh per model, shared wheel meshes), signal-controlled
// lanes with stop lines and crosswalks, bus stops, working traffic/pedestrian signals and cheap night headlight throw.
// Local vehicle frame: front faces +x, y up, ground at y=0; Japan drives on the left.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DistrictId } from '../core/data';
import { painterly } from '../engine/geo';
import { Builder, G, rng } from './kit';
import { PALETTE, mat } from './materials';

export type TrafficQuality = 'low' | 'medium' | 'high';
type Axis = 'x' | 'z';
type V2 = [number, number];
type V3 = [number, number, number];
export type VType = 'kei' | 'sedan' | 'taxi' | 'van' | 'bus' | 'truck' | 'scooter' | 'bicycle';

// ---------------------------------------------------------------- model kit
/** Per-vertex part kinds, read by the vehicle shader. */
const K = { fixed: 0, paint: 1, paint2: 2, head: 3, tail: 4, glass: 5, lamp: 6, chrome: 7, rubber: 8, plastic: 9 } as const;
const TRIM = '#2a2c30', RUBBER = '#1d1e21', GLASS = '#1c2733', CHROME = '#c9cdd1', LENS = '#f4f1e8', TAIL = '#a3150f', INNER = '#141518';
const SKIN = '#dcb79a';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

class Mk {
  parts: THREE.BufferGeometry[] = [];
  add(g: THREE.BufferGeometry, color: string, kind: number = K.fixed, at?: V3, rot?: V3, scale?: V3): this {
    if (at || rot || scale) {
      g.applyMatrix4(_m.compose(_v.set(...(at ?? [0, 0, 0])), _q.setFromEuler(_e.set(...(rot ?? [0, 0, 0]))), _s.set(...(scale ?? [1, 1, 1]))));
    }
    if (g.index) { const n = g.toNonIndexed(); g.dispose(); g = n; }
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
    const n = g.attributes.position.count, c = new THREE.Color(color);
    const col = new Float32Array(n * 3), kk = new Float32Array(n).fill(kind);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aKind', new THREE.BufferAttribute(kk, 1));
    this.parts.push(g);
    return this;
  }
  /** Rounded box centred at (x,y,z). */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, kind: number = K.fixed, r = 0.02, rz = 0, ry = 0): this {
    return this.add(chamfer(w, h, d, r), color, kind, [x, y, z], [0, ry, rz]);
  }
  /** Same box mirrored on both sides (z and -z). */
  pair(x: number, y: number, z: number, w: number, h: number, d: number, color: string, kind: number = K.fixed, r = 0.02, rz = 0): this {
    return this.box(x, y, z, w, h, d, color, kind, r, rz).box(x, y, -z, w, h, d, color, kind, r, rz);
  }
  /** Bar in the xy plane from a to b (at depth z), cross-section w (in-plane) x t (along z). */
  strut(a: V2, b: V2, z: number, w: number, t: number, color: string, kind: number = K.fixed): this {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return this.box((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z, L, w, t, color, kind, Math.min(w, t) * 0.35, Math.atan2(b[1] - a[1], b[0] - a[0]));
  }
  /** Capsule limb between two 3D points. */
  limb(a: V3, b: V3, r: number, color: string, kind: number = K.fixed, scale?: V3): this {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.001, A.distanceTo(B)), 2, 8);
    if (scale) g.scale(...scale);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    return this.add(g, color, kind);
  }
  /** Cylinder whose axis runs along x (lamps facing forward/back), centred. */
  disc(x: number, y: number, z: number, r: number, depth: number, color: string, kind: number = K.fixed, seg = 14): this {
    return this.add(new THREE.CylinderGeometry(r, r, depth, seg), color, kind, [x, y, z], [0, 0, Math.PI / 2]);
  }
  /** Cylinder whose axis runs along z (side marks, axles), centred. */
  zdisc(x: number, y: number, z: number, r: number, depth: number, color: string, kind: number = K.fixed, seg = 16): this {
    return this.add(new THREE.CylinderGeometry(r, r, depth, seg), color, kind, [x, y, z], [Math.PI / 2, 0, 0]);
  }
  merge(): THREE.BufferGeometry { const g = mergeGeometries(this.parts)!; for (const p of this.parts) p.dispose(); this.parts = []; return g; }
}

/** Box with one-segment chamfered edges (crisp CAD look, ~108 tris); tiny parts stay plain boxes (12 tris). */
function chamfer(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const m = Math.min(w, h, d);
  if (r < 0.012 || m < 0.04) return new THREE.BoxGeometry(w, h, d);
  return new RoundedBoxGeometry(w, h, d, 1, Math.min(r, m / 2 - 1e-3));
}
/** Side profile (x forward, y up) extruded across the width, with crisp chamfered edges. */
function side(pts: V2[], width: number, bevel = 0.05): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.002, width - 2 * bevel);
  return new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 4 })
    .translate(0, 0, -depth / 2);
}
/** Wheel-arch cut along the bottom edge: arc over a wheel centred (cx, cy), from rear to front. */
function arch(cx: number, cy: number, r: number, yb: number, n = 8): V2[] {
  const s = Math.asin(THREE.MathUtils.clamp((yb - cy) / r, -1, 1));
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) { const a = Math.PI - s + (2 * s - Math.PI) * (i / n); out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
/** Japanese number plate facing +x (face=1) or -x: white private, green commercial, yellow kei. */
function plate(k: Mk, x: number, y: number, face: 1 | -1, style: 'w' | 'g' | 'y', s = 1): void {
  const [bg, fg] = style === 'g' ? ['#2f6a4c', '#e9efe9'] : style === 'y' ? ['#ecc94a', '#25272b'] : ['#f2f1ea', '#2f6a4c'];
  k.box(x, y, 0, 0.022, 0.165 * s, 0.33 * s, bg, K.fixed, 0.008);
  k.box(x + face * 0.012, y - 0.025 * s, 0, 0.004, 0.06 * s, 0.22 * s, fg, K.fixed, 0.002); // number
  k.box(x + face * 0.012, y + 0.045 * s, 0.05 * s, 0.004, 0.03 * s, 0.12 * s, fg, K.fixed, 0.002); // region
}
function doorMirror(k: Mk, x: number, y: number, zOut: number, color: string, kind: number): void {
  for (const s of [1, -1]) {
    k.box(x, y, s * (zOut - 0.06), 0.05, 0.03, 0.1, TRIM, K.plastic, 0.01);
    k.box(x - 0.02, y + 0.02, s * zOut, 0.09, 0.08, 0.13, color, kind, 0.03);
  }
}
function liners(k: Mk, axles: number[], r: number, inner: number): void {
  for (const ax of axles) k.box(ax, r + 0.02, 0, r * 2.1, r * 1.3, inner, INNER, K.plastic, 0.04);
}
/** Thin seam lines (door gaps) on both flanks. */
function seams(k: Mk, xs: number[], y0: number, y1: number, zHalf: number): void {
  for (const x of xs) k.pair(x, (y0 + y1) / 2, zHalf + 0.001, 0.012, y1 - y0, 0.006, '#1a1b1e', K.plastic, 0.002);
}

// ---------------------------------------------------------------- the eight models
interface Spec {
  len: number; wid: number; vmax: number; acc: number;
  wheels: [number, number, number, number][]; // x, z, radius, width
  bike?: boolean; build: (k: Mk) => void;
}

function sedan(k: Mk, taxi: boolean): void {
  const W = taxi ? 1.7 : 1.76, r = 0.32, yb = 0.24, axF = 1.38, axR = -1.36, Wg = W - 0.2;
  const body: V2[] = taxi
    ? [[-2.28, 0.3], [-2.05, yb], ...arch(axR, r, r + 0.07, yb), ...arch(axF, r, r + 0.07, yb), [2.08, yb], [2.28, 0.3],
       [2.32, 0.6], [2.3, 0.78], [2.12, 0.86], [0.85, 0.91], [0.72, 0.94], [-1.5, 0.96], [-1.6, 0.98], [-2.24, 0.97], [-2.31, 0.9], [-2.33, 0.56]]
    : [[-2.28, 0.3], [-2.05, yb], ...arch(axR, r, r + 0.07, yb), ...arch(axF, r, r + 0.07, yb), [2.08, yb], [2.28, 0.32],
       [2.33, 0.56], [2.28, 0.72], [2.02, 0.83], [0.95, 0.91], [0.72, 0.94], [-1.55, 0.97], [-1.7, 0.99], [-2.18, 0.96], [-2.3, 0.86], [-2.34, 0.58]];
  const gh: V2[] = taxi ? [[0.76, 0.9], [0.08, 1.46], [-1.02, 1.48], [-1.52, 0.94]] : [[0.78, 0.9], [-0.04, 1.4], [-0.96, 1.42], [-1.64, 0.95]];
  k.add(side(body, W, 0.07), '#ffffff', K.paint);
  k.add(side(gh, Wg, 0.05), GLASS, K.glass);
  const top = Math.max(gh[1][1], gh[2][1]);
  k.box((gh[1][0] + gh[2][0]) / 2, top + 0.005, 0, gh[1][0] - gh[2][0] + 0.06, 0.07, Wg + 0.03, '#ffffff', taxi ? K.paint2 : K.paint, 0.03);
  for (const s of [1, -1]) {
    const z = s * (Wg / 2 + 0.004);
    k.strut(gh[0], gh[1], z, 0.07, 0.03, '#ffffff', taxi ? K.paint2 : K.paint);
    k.strut(gh[2], gh[3], z, taxi ? 0.12 : 0.16, 0.03, '#ffffff', taxi ? K.paint2 : K.paint);
    const bx = (gh[1][0] + gh[2][0]) / 2 - 0.06;
    k.strut([bx, 0.95], [bx + 0.02, top], z, 0.08, 0.03, TRIM, K.plastic);
  }
  // beltline chrome / taxi livery stripe
  if (taxi) k.pair(0, 0.8, W / 2 + 0.003, 4.4, 0.09, 0.008, '#ffffff', K.paint2, 0.004);
  else k.pair(-0.4, 0.955, Wg / 2 + 0.03, 2.3, 0.025, 0.012, CHROME, K.chrome, 0.006);
  // nose & tail
  k.box(2.3, 0.6, 0, 0.05, 0.14, 0.66, '#33363b', K.plastic, 0.02); // grille
  k.box(2.335, 0.6, 0, 0.012, 0.02, 0.66, CHROME, K.chrome, 0.004);
  k.box(2.26, 0.3, 0, 0.12, 0.1, W - 0.16, TRIM, K.plastic, 0.03); // lower lip
  k.pair(taxi ? 2.28 : 2.26, 0.7, 0.58, 0.16, 0.13, 0.4, TRIM, K.plastic, 0.03, -0.3);
  k.pair(taxi ? 2.31 : 2.295, 0.705, 0.58, 0.13, 0.085, 0.34, LENS, K.head, 0.03, -0.3);
  k.pair(2.27, 0.5, 0.66, 0.05, 0.05, 0.16, '#e7a23c', K.fixed, 0.01); // indicators
  k.pair(-2.31, 0.8, 0.6, 0.06, 0.13, 0.42, TAIL, K.tail, 0.02);
  k.box(-2.32, 0.42, 0, 0.08, 0.1, W - 0.2, TRIM, K.plastic, 0.03); // rear diffuser
  plate(k, 2.34, 0.42, 1, taxi ? 'g' : 'w'); plate(k, -2.35, 0.6, -1, taxi ? 'g' : 'w');
  liners(k, [axF, axR], r, W - 0.5);
  k.box(0, 0.2, 0, 3.6, 0.08, W - 0.3, INNER, K.plastic, 0.02);
  seams(k, [0.66, -0.36, -1.4], 0.32, 0.93, W / 2);
  for (const x of [0.05, -0.95]) k.pair(x, 0.83, W / 2 + 0.006, 0.13, 0.025, 0.012, CHROME, K.chrome, 0.006);
  if (taxi) {
    // fender mirrors, roof andon, door crest, vacancy sign
    for (const s of [1, -1]) {
      k.add(new THREE.CylinderGeometry(0.008, 0.008, 0.14, 6), TRIM, K.plastic, [1.72, 0.92, s * 0.68]);
      k.box(1.73, 1.01, s * 0.7, 0.05, 0.07, 0.1, TRIM, K.plastic, 0.02);
    }
    k.box(-0.45, top + 0.1, 0, 0.18, 0.04, 0.3, TRIM, K.plastic, 0.01);
    k.box(-0.45, top + 0.19, 0, 0.16, 0.15, 0.42, '#f1e4b8', K.lamp, 0.06);
    for (const s of [1, -1]) {
      k.zdisc(0.05, 0.6, s * (W / 2 + 0.004), 0.13, 0.008, '#ffffff', K.paint2, 16);
      k.zdisc(0.05, 0.6, s * (W / 2 + 0.008), 0.08, 0.008, '#ffffff', K.paint, 16);
    }
    const t = 0.14, px = gh[0][0] + (gh[1][0] - gh[0][0]) * t, py = gh[0][1] + (gh[1][1] - gh[0][1]) * t;
    k.box(px + 0.03, py, -0.42, 0.02, 0.08, 0.24, '#d8392c', K.lamp, 0.01, Math.atan2(gh[1][1] - gh[0][1], gh[1][0] - gh[0][0]) - Math.PI / 2);
  } else doorMirror(k, 0.64, 1.0, W / 2 + 0.08, '#ffffff', K.paint);
}

function kei(k: Mk): void {
  const W = 1.47, r = 0.27, yb = 0.22, axF = 1.2, axR = -1.22, Wg = W - 0.14;
  const body: V2[] = [[-1.68, 0.3], [-1.6, yb], ...arch(axR, r, r + 0.06, yb), ...arch(axF, r, r + 0.06, yb), [1.6, yb], [1.68, 0.3],
    [1.7, 0.58], [1.66, 0.76], [1.44, 0.88], [1.12, 0.95], [-1.6, 1.0], [-1.67, 0.98], [-1.7, 0.55]];
  const gh: V2[] = [[1.12, 0.92], [0.4, 1.58], [-1.5, 1.62], [-1.64, 0.97]];
  k.add(side(body, W, 0.07), '#ffffff', K.paint);
  k.add(side(gh, Wg, 0.06), GLASS, K.glass);
  k.box(-0.55, 1.66, 0, 2.05, 0.08, Wg + 0.04, '#ffffff', K.paint2, 0.04); // two-tone roof
  for (const s of [1, -1]) {
    const z = s * (Wg / 2 + 0.004);
    k.strut(gh[0], gh[1], z, 0.08, 0.03, '#ffffff', K.paint);
    k.strut([-0.14, 0.98], [-0.14, 1.6], z, 0.08, 0.03, TRIM, K.plastic);
    k.strut([-1.02, 0.99], [-1.02, 1.61], z, 0.12, 0.03, '#ffffff', K.paint);
    k.strut(gh[2], gh[3], z, 0.1, 0.03, '#ffffff', K.paint);
  }
  k.box(-1.66, 1.3, 0, 0.03, 0.5, Wg - 0.1, GLASS, K.glass, 0.03); // tailgate glass
  // round "cute" headlamps with chrome bezels
  for (const s of [1, -1]) { k.disc(1.66, 0.72, s * 0.5, 0.115, 0.05, CHROME, K.chrome, 24); k.disc(1.69, 0.72, s * 0.5, 0.095, 0.03, LENS, K.head, 24); }
  k.box(1.7, 0.6, 0, 0.02, 0.06, 0.5, '#33363b', K.plastic, 0.01);
  k.box(1.63, 0.32, 0, 0.12, 0.16, W - 0.06, '#d7d3cb', K.plastic, 0.04);
  k.box(-1.66, 0.32, 0, 0.1, 0.16, W - 0.06, '#d7d3cb', K.plastic, 0.04);
  k.pair(-1.7, 0.78, 0.62, 0.05, 0.3, 0.1, TAIL, K.tail, 0.02);
  plate(k, 1.71, 0.42, 1, 'y'); plate(k, -1.72, 0.55, -1, 'y');
  liners(k, [axF, axR], r, W - 0.45);
  k.box(0, 0.18, 0, 2.6, 0.08, W - 0.3, INNER, K.plastic, 0.02);
  seams(k, [1.02, -0.16, -1.04], 0.3, 0.97, W / 2);
  for (const x of [0.25, -0.62]) k.pair(x, 0.84, W / 2 + 0.006, 0.12, 0.025, 0.012, CHROME, K.chrome, 0.006);
  doorMirror(k, 1.0, 1.02, W / 2 + 0.07, '#ffffff', K.paint);
}

function van(k: Mk): void {
  const W = 1.69, r = 0.31, yb = 0.26, axF = 1.42, axR = -1.18;
  const body: V2[] = [[-2.33, 0.32], [-2.1, yb], ...arch(axR, r, r + 0.07, yb), ...arch(axF, r, r + 0.07, yb), [2.08, yb], [2.3, 0.34],
    [2.35, 0.66], [2.31, 0.98], [2.13, 1.06], [1.73, 1.86], [1.56, 1.97], [-2.22, 1.98], [-2.34, 1.88]];
  k.add(side(body, W, 0.08), '#ffffff', K.paint);
  // glazing: windscreen, cab windows, rear door windows
  const a: V2 = [2.13, 1.06], b: V2 = [1.73, 1.86], n = [0.894, 0.447];
  k.strut([a[0] + n[0] * 0.012 - 0.02, a[1] + n[1] * 0.012 + 0.04], [b[0] + n[0] * 0.012 + 0.02, b[1] + n[1] * 0.012 - 0.04], 0, 0.02, W - 0.16, GLASS, K.glass);
  k.pair(1.38, 1.46, W / 2 + 0.004, 0.62, 0.5, 0.02, GLASS, K.glass, 0.03);
  k.pair(-2.345, 1.5, 0.4, 0.02, 0.42, 0.6, GLASS, K.glass, 0.02);
  // livery: stripe and an invented wordless mark
  k.pair(0, 0.92, W / 2 + 0.004, 4.5, 0.12, 0.008, '#ffffff', K.paint2, 0.004);
  for (const s of [1, -1]) {
    k.zdisc(-0.55, 1.38, s * (W / 2 + 0.004), 0.26, 0.008, '#ffffff', K.paint2, 20);
    k.zdisc(-0.47, 1.43, s * (W / 2 + 0.008), 0.2, 0.008, '#ffffff', K.paint, 20);
  }
  k.box(2.335, 0.74, 0, 0.03, 0.13, 0.72, '#33363b', K.plastic, 0.01);
  k.pair(2.33, 0.84, 0.6, 0.06, 0.18, 0.36, TRIM, K.plastic, 0.03);
  k.pair(2.35, 0.84, 0.6, 0.04, 0.14, 0.32, LENS, K.head, 0.03);
  k.box(2.3, 0.38, 0, 0.12, 0.18, W + 0.02, '#4a4c50', K.plastic, 0.04);
  k.box(-2.32, 0.38, 0, 0.1, 0.16, W + 0.02, '#4a4c50', K.plastic, 0.04);
  k.pair(-2.35, 0.72, 0.74, 0.05, 0.36, 0.12, TAIL, K.tail, 0.02);
  k.box(-2.345, 1.15, 0, 0.012, 1.4, 0.012, '#1a1b1e', K.plastic, 0.003); // rear door split
  plate(k, 2.32, 0.5, 1, 'w'); plate(k, -2.36, 0.56, -1, 'w');
  liners(k, [axF, axR], r, W - 0.5);
  k.box(0, 0.22, 0, 3.8, 0.08, W - 0.3, INNER, K.plastic, 0.02);
  seams(k, [1.02, 0.95, -0.42], 0.34, 1.9, W / 2);
  for (const s of [1, -1]) {
    k.box(1.78, 1.45, s * (W / 2 + 0.05), 0.04, 0.03, 0.12, TRIM, K.plastic, 0.01);
    k.box(1.76, 1.45, s * (W / 2 + 0.13), 0.06, 0.2, 0.11, TRIM, K.plastic, 0.02);
  }
}

function bus(k: Mk): void {
  const W = 2.49, r = 0.48, yb = 0.33, axF = 3.05, axR = -2.3, hz = W / 2;
  const body: V2[] = [[-5.22, 0.4], [-5.0, yb], ...arch(axR, r, r + 0.08, yb), ...arch(axF, r, r + 0.08, yb), [5.0, yb], [5.22, 0.42],
    [5.25, 1.0], [5.2, 2.75], [5.06, 3.02], [-5.06, 3.05], [-5.23, 2.86]];
  k.add(side(body, W, 0.12), '#ffffff', K.paint);
  k.pair(0, 0.5, hz + 0.004, 10.2, 0.26, 0.01, '#ffffff', K.paint2, 0.004); // skirt band
  k.pair(0, 2.82, hz + 0.004, 10.2, 0.06, 0.01, '#ffffff', K.paint2, 0.004); // roof line
  // window band with black mullions
  k.pair(-0.65, 1.97, hz + 0.006, 8.5, 1.3, 0.02, GLASS, K.glass, 0.03);
  for (let x = -4.85; x <= 3.6; x += 1.21) k.pair(x, 1.97, hz + 0.018, 0.07, 1.3, 0.008, TRIM, K.plastic, 0.003);
  // doors on the kerb side (left = -z): front and middle
  for (const [x0, x1] of [[4.12, 4.96], [0.02, 1.26]]) {
    const cx = (x0 + x1) / 2, w = x1 - x0;
    k.box(cx, 1.5, -hz - 0.012, w, 2.3, 0.02, TRIM, K.plastic, 0.02);
    k.box(cx, 1.55, -hz - 0.026, w - 0.12, 2.1, 0.012, GLASS, K.glass, 0.02);
    k.box(cx, 1.55, -hz - 0.034, 0.02, 2.1, 0.006, TRIM, K.plastic, 0.002);
  }
  // front: windscreen, destination sign, lamps
  const tilt = Math.atan2(0.05, 1.75);
  k.box(5.25, 1.8, 0, 0.03, 1.5, W - 0.22, GLASS, K.glass, 0.03, tilt);
  k.box(5.25, 2.75, 0, 0.03, 0.24, 1.7, '#ffb53d', K.lamp, 0.01, tilt);
  k.box(5.23, 2.75, 0, 0.02, 0.3, 1.86, TRIM, K.plastic, 0.01, tilt);
  k.box(-5.0, 2.4, -hz - 0.012, 1.0, 0.18, 0.01, '#ffb53d', K.lamp, 0.01); // side destination sign (rear, kerb side)
  k.pair(5.25, 0.78, 0.95, 0.05, 0.18, 0.38, LENS, K.head, 0.03);
  k.box(5.25, 0.45, 0, 0.12, 0.22, W - 0.02, TRIM, K.plastic, 0.04);
  k.box(-5.24, 0.45, 0, 0.1, 0.22, W - 0.02, TRIM, K.plastic, 0.04);
  k.box(-5.24, 2.2, 0, 0.03, 0.8, 1.5, GLASS, K.glass, 0.03);
  k.box(-5.24, 1.2, 0, 0.02, 0.45, 1.3, '#3a3c40', K.plastic, 0.02); // engine grille
  k.pair(-5.25, 1.15, 1.06, 0.04, 0.6, 0.14, TAIL, K.tail, 0.02);
  k.box(0.6, 3.15, 0, 2.6, 0.22, 1.6, '#e4e2dc', K.fixed, 0.08); // roof AC pod
  for (const s of [1, -1]) {
    k.add(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 8), TRIM, K.plastic, [5.38, 2.6, s * 1.2], [0, 0, Math.PI / 2 - 0.5]);
    k.box(5.6, 2.35, s * 1.24, 0.05, 0.32, 0.16, TRIM, K.plastic, 0.03);
  }
  plate(k, 5.27, 0.62, 1, 'g'); plate(k, -5.26, 0.7, -1, 'g');
  liners(k, [axF, axR], r, W - 1.0);
  k.box(0, 0.3, 0, 9.4, 0.1, W - 0.4, INNER, K.plastic, 0.02);
}

function truck(k: Mk): void {
  const W = 1.69, r = 0.33, yb = 0.3, axF = 1.55, axR = -1.05;
  const cab: V2[] = [[0.98, yb], ...arch(axF, r, r + 0.08, yb), [2.25, yb], [2.33, 0.38], [2.36, 0.95], [2.31, 1.12], [2.24, 1.84], [2.12, 1.95], [1.08, 1.96], [0.98, 1.86]];
  k.add(side(cab, W, 0.07), '#ffffff', K.paint);
  k.box(2.29, 1.48, 0, 0.03, 0.66, W - 0.16, GLASS, K.glass, 0.03, Math.atan2(0.72, -0.07) - Math.PI / 2);
  k.pair(1.68, 1.47, W / 2 + 0.004, 0.72, 0.56, 0.02, GLASS, K.glass, 0.03);
  seams(k, [1.22], 0.34, 1.9, W / 2);
  k.box(2.35, 0.72, 0, 0.03, 0.14, 0.7, '#33363b', K.plastic, 0.01);
  k.pair(2.35, 0.72, 0.62, 0.05, 0.16, 0.3, TRIM, K.plastic, 0.03);
  k.pair(2.37, 0.72, 0.62, 0.04, 0.12, 0.26, LENS, K.head, 0.03);
  k.box(2.32, 0.38, 0, 0.12, 0.16, W + 0.02, '#4a4c50', K.plastic, 0.04);
  plate(k, 2.36, 0.5, 1, 'w');
  for (const s of [1, -1]) {
    k.box(2.2, 1.55, s * (W / 2 + 0.06), 0.04, 0.03, 0.14, TRIM, K.plastic, 0.01);
    k.box(2.18, 1.5, s * (W / 2 + 0.14), 0.06, 0.24, 0.1, TRIM, K.plastic, 0.02);
  }
  // chassis, deck, aluminium gates, headboard
  k.box(-0.65, 0.52, 0, 3.3, 0.2, 0.9, TRIM, K.plastic, 0.02);
  k.box(-0.68, 0.76, 0, 3.32, 0.08, W, '#bfc3c7', K.chrome, 0.02);
  k.pair(-0.68, 1.02, W / 2 - 0.02, 3.32, 0.44, 0.04, '#c7cace', K.chrome, 0.015);
  k.box(-2.32, 1.02, 0, 0.04, 0.44, W, '#c7cace', K.chrome, 0.015);
  for (const y of [0.9, 1.06]) k.pair(-0.68, y, W / 2 + 0.002, 3.3, 0.02, 0.01, '#9da1a6', K.chrome, 0.004);
  k.box(0.94, 1.35, 0, 0.05, 1.1, W - 0.08, '#55595f', K.plastic, 0.02);
  for (const z of [-0.5, 0, 0.5]) k.box(0.97, 1.35, z, 0.03, 1.05, 0.04, '#43464b', K.plastic, 0.01);
  // load: crates and a tarp-covered bundle
  k.box(-0.2, 1.06, 0.35, 0.7, 0.5, 0.6, '#c6a578', K.fixed, 0.02);
  k.box(-0.2, 1.42, 0.35, 0.56, 0.22, 0.5, '#d2b388', K.fixed, 0.02);
  k.box(-1.3, 1.1, -0.1, 1.5, 0.6, 1.2, '#5f7386', K.fixed, 0.18);
  for (const x of [-1.8, -0.8]) k.box(x, 1.1, -0.1, 0.03, 0.62, 1.24, '#e1b84c', K.fixed, 0.01);
  k.pair(-2.3, 0.55, 0.7, 0.05, 0.12, 0.18, TAIL, K.tail, 0.02);
  plate(k, -2.32, 0.5, -1, 'w');
  k.pair(axR, 0.72, 0.55, 0.8, 0.04, 0.5, TRIM, K.plastic, 0.01); // rear mud guards
  liners(k, [axF], r, W - 0.5);
}

/** Seated arch-viz figure; hands at the grips (gx, gy, ±gz), feet at (fx, fy). */
function rider(k: Mk, hip: V2, sh: V2, grip: V3, foot: V2, knee: V2, helmet: boolean, top: number, topColor = '#ffffff'): void {
  const [hx, hy] = hip, [sx, sy] = sh;
  k.limb([hx, hy + 0.05, 0], [sx, sy - 0.1, 0], 0.13, topColor, top, [0.85, 1, 1.45]); // torso
  k.limb([sx + 0.02, sy - 0.02, 0], [sx + 0.05, sy + 0.12, 0], 0.05, SKIN); // neck
  const hd: V3 = [sx + 0.06, sy + 0.24, 0];
  if (helmet) {
    k.add(new THREE.SphereGeometry(0.145, 12, 8), '#ffffff', K.paint2, hd, undefined, [1.1, 1, 0.95]);
    k.box(hd[0] + 0.12, hd[1] - 0.01, 0, 0.04, 0.08, 0.2, GLASS, K.glass, 0.02, -0.2);
  } else {
    k.add(new THREE.SphereGeometry(0.11, 12, 8), SKIN, K.fixed, hd, undefined, [1, 1.12, 0.92]);
    k.add(new THREE.SphereGeometry(0.118, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), '#2b2420', K.fixed, [hd[0] - 0.02, hd[1] + 0.01, 0], [0, 0, 0.35]);
  }
  for (const s of [1, -1]) {
    const shp: V3 = [sx, sy - 0.04, s * 0.19], el: V3 = [(sx + grip[0]) / 2 - 0.02, (sy + grip[1]) / 2 - 0.08, s * (0.19 + grip[2]) / 2];
    k.limb(shp, el, 0.048, topColor, top).limb(el, [grip[0], grip[1], s * grip[2]], 0.042, topColor, top);
    k.add(new THREE.SphereGeometry(0.045, 6, 4), TRIM, K.plastic, [grip[0], grip[1], s * grip[2]]);
    const kn: V3 = [knee[0], knee[1], s * 0.14], ft: V3 = [foot[0], foot[1], s * 0.13];
    k.limb([hx, hy, s * 0.1], kn, 0.066, '#4b4f57').limb(kn, ft, 0.052, '#4b4f57');
    k.box(ft[0] + 0.05, ft[1] - 0.03, ft[2], 0.22, 0.07, 0.1, '#2c2a28', K.fixed, 0.03);
  }
}

function scooter(k: Mk): void {
  const prof: V2[] = [[-0.9, 0.45], [-0.86, 0.66], [-0.72, 0.74], [-0.12, 0.72], [0.02, 0.42], [0.34, 0.38], [0.44, 0.58], [0.47, 0.98],
    [0.58, 1.02], [0.64, 0.6], [0.58, 0.46], [0.36, 0.27], [0.0, 0.27], [-0.3, 0.3], [-0.6, 0.44]];
  k.add(side(prof, 0.36, 0.06), '#ffffff', K.paint);
  k.box(-0.45, 0.79, 0, 0.66, 0.1, 0.3, '#2b2b2e', K.plastic, 0.045); // seat
  k.strut([0.62, 0.2], [0.52, 0.92], 0.06, 0.04, 0.03, '#55585e', K.chrome).strut([0.62, 0.2], [0.52, 0.92], -0.06, 0.04, 0.03, '#55585e', K.chrome);
  k.add(new THREE.TorusGeometry(0.235, 0.025, 6, 16, Math.PI * 0.75), '#ffffff', K.paint, [0.6, 0.2, 0], [0, 0, Math.PI * 0.15]); // front fender
  k.add(new THREE.CylinderGeometry(0.014, 0.014, 0.6, 8), '#3a3c40', K.plastic, [0.52, 1.06, 0], [Math.PI / 2, 0, 0]);
  k.box(0.56, 1.04, 0, 0.12, 0.08, 0.22, '#ffffff', K.paint, 0.03);
  k.disc(0.62, 1.0, 0, 0.055, 0.04, LENS, K.head);
  k.box(-0.9, 0.62, 0, 0.04, 0.06, 0.16, TAIL, K.tail, 0.015);
  for (const s of [1, -1]) {
    k.add(new THREE.CylinderGeometry(0.006, 0.006, 0.2, 6), TRIM, K.plastic, [0.5, 1.15, s * 0.22], [s * 0.2, 0, 0]);
    k.disc(0.5, 1.25, s * 0.24, 0.04, 0.015, TRIM, K.plastic, 12);
  }
  plate(k, -0.93, 0.48, -1, 'w', 0.6);
  k.box(-0.85, 0.75, 0, 0.32, 0.22, 0.3, '#ffffff', K.paint2, 0.05); // top box
  rider(k, [-0.4, 0.88], [-0.28, 1.4], [0.48, 1.08, 0.28], [0.22, 0.47], [0.12, 0.9], true, K.fixed, '#3c4656');
}

function bicycle(k: Mk): void {
  const t = 0.019, f = '#ffffff';
  const tubes: [V2, V2][] = [[[0.38, 0.88], [0.4, 0.66]], [[0.39, 0.7], [0.1, 0.36]], [[0.1, 0.36], [-0.02, 0.3]], [[-0.02, 0.3], [-0.18, 0.86]], [[-0.15, 0.76], [-0.52, 0.33]]];
  for (const [a, b] of tubes) k.strut(a, b, 0, t * 2, t * 2, f, K.paint);
  for (const s of [1, -1]) { k.strut([-0.02, 0.3], [-0.52, 0.33], s * 0.06, t * 1.6, t * 1.6, f, K.paint); k.strut([0.4, 0.66], [0.52, 0.33], s * 0.05, t * 1.6, t * 1.6, f, K.paint); }
  k.strut([0.38, 0.88], [0.32, 1.0], 0, 0.03, 0.03, CHROME, K.chrome);
  k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.56, 8), CHROME, K.chrome, [0.28, 1.0, 0], [Math.PI / 2, 0, 0]);
  k.box(-0.2, 0.9, 0, 0.24, 0.07, 0.15, '#2b2b2e', K.plastic, 0.03);
  k.strut([-0.2, 0.86], [-0.19, 0.78], 0, 0.025, 0.025, CHROME, K.chrome);
  // mamachari details: chain guard, basket, carrier, fenders, lamp
  k.box(-0.27, 0.33, 0.075, 0.52, 0.11, 0.015, f, K.paint, 0.03);
  k.zdisc(-0.02, 0.3, 0.06, 0.1, 0.02, '#4a4c50', K.chrome, 16);
  k.strut([-0.02, 0.3], [0.1, 0.42], 0.09, 0.025, 0.02, '#4a4c50', K.chrome).strut([-0.02, 0.3], [-0.14, 0.18], -0.09, 0.025, 0.02, '#4a4c50', K.chrome);
  k.box(0.1, 0.42, 0.13, 0.1, 0.02, 0.08, TRIM, K.plastic, 0.005).box(-0.14, 0.18, -0.13, 0.1, 0.02, 0.08, TRIM, K.plastic, 0.005);
  const bx = 0.62, by = 0.92, bw = 0.3, bh = 0.24, bd = 0.36, wire = '#9aa0a6';
  k.box(bx, by - bh / 2, 0, bw, 0.015, bd, wire, K.chrome, 0.005);
  k.pair(bx, by, bd / 2, bw, bh, 0.012, wire, K.chrome, 0.004);
  k.box(bx + bw / 2, by, 0, 0.012, bh, bd, wire, K.chrome, 0.004).box(bx - bw / 2, by, 0, 0.012, bh, bd, wire, K.chrome, 0.004);
  k.box(-0.42, 0.8, 0, 0.32, 0.02, 0.16, '#55585e', K.chrome, 0.006);
  for (const x of [0.52, -0.52]) k.add(new THREE.TorusGeometry(0.36, 0.012, 4, 18, Math.PI * 0.62), CHROME, K.chrome, [x, 0.33, 0], [0, 0, Math.PI * 0.19 + (x < 0 ? 0.18 : 0)]);
  k.disc(0.5, 0.74, 0, 0.035, 0.05, LENS, K.head);
  k.box(-0.6, 0.76, 0, 0.02, 0.04, 0.06, TAIL, K.tail, 0.01);
  rider(k, [-0.21, 0.97], [-0.13, 1.5], [0.22, 1.0, 0.27], [0.06, 0.38], [0.12, 0.86], false, K.paint2);
}

const SPECS: Record<VType, Spec> = {
  kei: { len: 3.4, wid: 1.47, vmax: 8.5, acc: 2.2, wheels: wheels4(1.2, -1.22, 0.27, 0.17, 1.47), build: kei },
  sedan: { len: 4.68, wid: 1.76, vmax: 9.6, acc: 2.8, wheels: wheels4(1.38, -1.36, 0.32, 0.2, 1.76), build: (k) => sedan(k, false) },
  taxi: { len: 4.66, wid: 1.7, vmax: 9.2, acc: 2.6, wheels: wheels4(1.38, -1.36, 0.32, 0.19, 1.7), build: (k) => sedan(k, true) },
  van: { len: 4.7, wid: 1.69, vmax: 8.6, acc: 2.0, wheels: wheels4(1.42, -1.18, 0.31, 0.2, 1.69), build: van },
  bus: { len: 10.5, wid: 2.49, vmax: 7.2, acc: 1.3, wheels: [[3.05, 0.95, 0.48, 0.28], [3.05, -0.95, 0.48, 0.28], [-2.3, 0.88, 0.48, 0.46], [-2.3, -0.88, 0.48, 0.46]], build: bus },
  truck: { len: 4.72, wid: 1.69, vmax: 8.2, acc: 1.8, wheels: wheels4(1.55, -1.05, 0.33, 0.2, 1.69), build: truck },
  scooter: { len: 1.85, wid: 0.66, vmax: 8.2, acc: 2.8, wheels: [[0.62, 0, 0.2, 0.1], [-0.6, 0, 0.2, 0.11]], build: scooter },
  bicycle: { len: 1.75, wid: 0.6, vmax: 4.3, acc: 1.2, wheels: [[0.52, 0, 0.33, 0.035], [-0.52, 0, 0.33, 0.035]], bike: true, build: bicycle },
};
function wheels4(f: number, r: number, rad: number, w: number, W: number): [number, number, number, number][] {
  const z = W / 2 - w / 2 - 0.03;
  return [[f, z, rad, w], [f, -z, rad, w], [r, z, rad, w], [r, -z, rad, w]];
}

/** Car wheel at unit radius and unit width (axle along z): lathed tyre plus a five-spoke rim on both faces. */
function carWheel(): THREE.BufferGeometry {
  const k = new Mk();
  const prof: THREE.Vector2[] = [];
  const pr = (r: number, y: number) => prof.push(new THREE.Vector2(r, y));
  pr(0.66, -0.42); pr(0.9, -0.5); pr(0.97, -0.46); pr(1.0, -0.36); pr(1.0, 0.36); pr(0.97, 0.46); pr(0.9, 0.5); pr(0.66, 0.42);
  k.add(new THREE.LatheGeometry(prof, 20), RUBBER, K.rubber, undefined, [Math.PI / 2, 0, 0]);
  k.add(new THREE.CylinderGeometry(0.66, 0.66, 0.7, 20, 1, true), '#3b3d41', K.plastic, undefined, [Math.PI / 2, 0, 0]);
  for (const s of [1, -1]) {
    k.add(new THREE.CylinderGeometry(0.62, 0.66, 0.06, 20), CHROME, K.chrome, [0, 0, s * 0.37], [Math.PI / 2, 0, 0]);
    k.add(new THREE.CylinderGeometry(0.16, 0.18, 0.08, 10), '#9ea3a9', K.chrome, [0, 0, s * 0.42], [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + (s > 0 ? 0 : Math.PI / 5);
      k.add(new THREE.BoxGeometry(0.44, 0.13, 0.06), '#e2e5e8', K.chrome, [Math.cos(a) * 0.38, Math.sin(a) * 0.38, s * 0.41], [0, 0, a]);
    }
  }
  return k.merge();
}
/** Bicycle / thin wheel at unit radius: tyre ring, rim, hub and spokes. */
function bikeWheel(): THREE.BufferGeometry {
  const k = new Mk();
  k.add(new THREE.TorusGeometry(0.95, 0.05, 8, 32), RUBBER, K.rubber);
  k.add(new THREE.TorusGeometry(0.87, 0.025, 6, 32), CHROME, K.chrome);
  k.add(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 10), '#9ea3a9', K.chrome, undefined, [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; k.add(new THREE.CylinderGeometry(0.008, 0.008, 0.86, 4), '#b9bdc2', K.chrome, [Math.cos(a) * 0.43, Math.sin(a) * 0.43, i % 2 ? 0.08 : -0.08], [0, 0, a - Math.PI / 2]); }
  return k.merge();
}

// ---------------------------------------------------------------- palettes (muted, harmonious; a few accents)
const PAINT = {
  car: ['#cfccc5', '#cfccc5', '#c2c5c8', '#8f949a', '#4b4f56', '#26282c', '#2f3a4c', '#8ea197', '#c9bc9e', '#7e93a6', '#a9483b', '#d2a64c'],
  lux: ['#1f2125', '#1f2125', '#cfccc5', '#2b2f36', '#6b6f75', '#c2c5c8', '#3a2f31', '#2c3a35'],
  kei: ['#ece3cf', '#b3cdc1', '#b3c4d5', '#e3c0b6', '#e7d9a6', '#d3d0c8', '#9fb0a2', '#d6a77d'],
  taxi: [['#2f5d4e', '#efe6cf'], ['#26344d', '#efe8d8'], ['#1f2024', '#c8a65c'], ['#d6a63e', '#36383d'], ['#6b2f36', '#eee3cc'], ['#d3d0c8', '#3c6e8f']] as [string, string][],
  van: [['#d0cec7', '#3d6a8f'], ['#d0cec7', '#4f7f5f'], ['#d0cec7', '#c8743a'], ['#c5c8cb', '#2f3a4c'], ['#d0cec7', '#a9483b']] as [string, string][],
  bus: [['#d2cec4', '#3f7a74'], ['#d2cec4', '#2f4d73'], ['#d9d3c3', '#6a8a4f']] as [string, string][],
  truck: ['#d0cec7', '#d0cec7', '#b9c9d4', '#c9c4b6', '#7e93a6'],
  scooter: ['#d9d3c3', '#a9483b', '#8ea197', '#26282c', '#7e93a6', '#d2a64c'],
  helmet: ['#d3d0c8', '#26282c', '#a9483b', '#c2c5c8', '#2f3a4c'],
  bike: ['#c2c5c8', '#d3d0c8', '#26282c', '#8ea197', '#e3c0b6', '#7e93a6'],
  shirt: ['#d9d4c7', '#6f8aa3', '#3c4656', '#b5a48a', '#8b6f78', '#d3d0c8'],
};

// ---------------------------------------------------------------- shared vehicle material
function vehicleMaterial(night: { value: number }): THREE.MeshStandardMaterial {
  const m = mat('paintGloss').clone(); // keeps the studio env reflection
  m.vertexColors = true; m.color.set('#ffffff');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aKind; attribute vec3 iPaint1; attribute vec3 iPaint2; attribute float iBrake;
varying float vKind; varying vec3 vP1; varying vec3 vP2; varying float vBrake;`)
      .replace('#include <color_vertex>', '#include <color_vertex>\nvKind = aKind; vP1 = iPaint1; vP2 = iPaint2; vBrake = iBrake;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight; varying float vKind; varying vec3 vP1; varying vec3 vP2; varying float vBrake;
bool isK(float k) { return abs(vKind - k) < 0.5; }`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (isK(1.0)) diffuseColor.rgb *= vP1; else if (isK(2.0)) diffuseColor.rgb *= vP2;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = (isK(1.0) || isK(2.0)) ? 0.3 : isK(5.0) ? 0.05 : isK(7.0) ? 0.22 : isK(8.0) ? 0.92 : isK(9.0) ? 0.7 : (isK(3.0) || isK(4.0) || isK(6.0)) ? 0.15 : 0.6;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = (isK(1.0) || isK(2.0)) ? 0.18 : isK(7.0) ? 0.85 : isK(5.0) ? 0.25 : 0.0;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float em = isK(3.0) ? 0.1 + 2.8 * uNight : isK(4.0) ? 0.05 + 0.9 * uNight + 2.6 * vBrake : isK(6.0) ? 0.04 + 1.7 * uNight : 0.0;
totalEmissiveRadiance += diffuseColor.rgb * em;`);
  };
  m.customProgramCacheKey = () => 'traffic-vehicle';
  return painterly(m);
}

/** Soft fan of light thrown ahead of a headlamp: bright at u=0, widening and fading with distance. */
function beamTexture(): THREE.Texture {
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = i / (N - 1), v = j / (N - 1), w = 0.1 + 0.32 * u;
    const a = Math.pow(1 - u, 1.4) * Math.exp(-(((v - 0.5) / w) ** 2) * 2.2) * Math.min(1, u / 0.06);
    const o = (j * N + i) * 4; data[o] = data[o + 1] = data[o + 2] = 255; data[o + 3] = Math.round(255 * Math.min(1, a * 1.3));
  }
  const t = new THREE.DataTexture(data, N, N); t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- road network per district
interface Stop { at: number; cw: number; signal: boolean } // front halts at `at`; crosswalk centre `cw` along the lane axis
interface Lane { axis: Axis; c: number; dir: 1 | -1; a0: number; a1: number; stops: Stop[]; bus: number[]; bike: boolean; link?: Lane }
interface Phase { dur: number; green: Axis[]; clear?: boolean }
/** A zebra crossing: centre, the road axis it crosses, half length across the road, signalised or not. */
export interface Crossing { x: number; z: number; road: Axis; half: number; signal: boolean }
interface Vehicle {
  type: VType; spec: Spec; slot: number; wheel0: number; lane: Lane; pos: number; v: number; a: number;
  pitch: number; pv: number; dist: number; brake: number; vmax: number; dwell: number; nextBus: number; waiting: boolean; active: boolean;
  pin?: { x: number; z: number; yaw: number };
}
type LampRole = { veh: Axis; c: 'g' | 'y' | 'r' } | { ped: Axis; c: 'g' | 'r' };

// Road half-widths mirror district.ts (Asakusa's single street, then each city avenue's R).
const ROAD: Record<string, number> = { asakusa: 3.5, shibuya: 7, shinjuku: 8, ginza: 6 };
const AMBER = 3;
const FLEET: Record<string, Partial<Record<VType, number>>> = {
  asakusa: { taxi: 3, kei: 3, sedan: 2, van: 1, truck: 1, bus: 1, scooter: 2, bicycle: 3 },
  shibuya: { taxi: 7, sedan: 6, kei: 4, van: 3, truck: 2, bus: 2, scooter: 4, bicycle: 4 },
  shinjuku: { taxi: 8, sedan: 6, kei: 3, van: 3, truck: 3, bus: 2, scooter: 3, bicycle: 3 },
  ginza: { taxi: 8, sedan: 9, kei: 2, van: 2, truck: 1, bus: 2, scooter: 2, bicycle: 3 },
};
const CAP: Record<TrafficQuality, number> = { high: 1, medium: 0.7, low: 0.45 };

export class Traffic {
  readonly group = new THREE.Group();
  readonly vehicles: Vehicle[] = [];
  readonly crossings: Crossing[] = [];
  /** Pedestrians currently on the carriageway (fed each frame by the crowd system); vehicles yield to them like to the player. */
  walkers: { x: number; z: number }[] = [];
  private night = { value: 0 };
  private vmat: THREE.MeshStandardMaterial;
  private meshes = new Map<VType, { mesh: THREE.InstancedMesh; p1: THREE.InstancedBufferAttribute; p2: THREE.InstancedBufferAttribute; br: THREE.InstancedBufferAttribute }>();
  private wheels: THREE.InstancedMesh; private bikeWheels: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh; private poolMat: THREE.MeshBasicMaterial;
  private lamps: THREE.InstancedMesh; private lampRoles: LampRole[] = [];
  private lanes: Lane[] = [];
  private phases: Phase[]; private cycle: number; private t = 0;
  private r: () => number;
  private quality: TrafficQuality;

  constructor(b: Builder, readonly id: DistrictId, quality: TrafficQuality = 'high') {
    this.group.name = 'traffic';
    this.group.userData.traffic = this;
    this.quality = quality;
    this.r = rng(id.length * 31 + 7);
    const R = ROAD[id] ?? 7;
    this.phases = id === 'asakusa' ? [{ dur: 18, green: ['x'] }, { dur: 2, green: [], clear: true }, { dur: 10, green: [] }, { dur: 1, green: [], clear: true }]
      : id === 'shibuya' ? [{ dur: 13, green: ['x'] }, { dur: 2, green: [], clear: true }, { dur: 11, green: ['z'] }, { dur: 2, green: [], clear: true }, { dur: 13, green: [] }, { dur: 1, green: [], clear: true }]
        : [{ dur: 18, green: ['x'] }, { dur: 2, green: [], clear: true }, { dur: 11, green: ['z'] }, { dur: 2, green: [], clear: true }];
    this.cycle = this.phases.reduce((a, p) => a + p.dur, 0);
    this.t = this.r() * this.cycle;
    const lampAt: { p: THREE.Vector3; yaw: number; role: LampRole; s: number }[] = [];
    if (id === 'asakusa') this.layoutAsakusa(b, lampAt); else this.layoutCity(b, R, lampAt);

    // vehicles
    this.vmat = vehicleMaterial(this.night);
    const fleet = FLEET[id] ?? FLEET.shibuya;
    const order: VType[] = [];
    for (const [t, n] of Object.entries(fleet) as [VType, number][]) for (let i = 0; i < n; i++) order.push(t);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const busIdx = order.indexOf('bus'); if (busIdx > 0) [order[0], order[busIdx]] = [order[busIdx], order[0]]; // a bus survives Low
    const counts = new Map<VType, number>();
    let nWheels = 0, nBike = 0;
    for (const type of order) {
      const spec = SPECS[type];
      const slot = counts.get(type) ?? 0; counts.set(type, slot + 1);
      const lane = this.pickLane(type);
      const wheel0 = spec.bike ? nBike : nWheels;
      if (spec.bike) nBike += spec.wheels.length; else nWheels += spec.wheels.length;
      this.vehicles.push({ type, spec, slot, wheel0, lane, pos: 0, v: 0, a: 0, pitch: 0, pv: 0, dist: 0, brake: 0, vmax: spec.vmax * (0.9 + this.r() * 0.2), dwell: 0, nextBus: 0, waiting: false, active: true });
    }
    for (const [type, n] of counts) {
      const g = new Mk(); SPECS[type].build(g);
      const geo = g.merge();
      const p1 = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3), p2 = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      const br = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      geo.setAttribute('iPaint1', p1); geo.setAttribute('iPaint2', p2); geo.setAttribute('iBrake', br);
      const mesh = new THREE.InstancedMesh(geo, this.vmat, n);
      mesh.name = `traffic-${type}`; mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.set(type, { mesh, p1, p2, br });
      this.group.add(mesh);
    }
    const wheelMesh = (geo: THREE.BufferGeometry, n: number) => {
      geo.setAttribute('iPaint1', new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3));
      geo.setAttribute('iPaint2', new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3));
      geo.setAttribute('iBrake', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
      const m = new THREE.InstancedMesh(geo, this.vmat, Math.max(1, n));
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.count = n;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    this.wheels = wheelMesh(carWheel(), nWheels);
    this.bikeWheels = wheelMesh(bikeWheel(), nBike);

    this.poolMat = new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, this.vehicles.length * 2);
    this.pools.frustumCulled = false; this.pools.renderOrder = 1; this.pools.visible = false;
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < this.vehicles.length; i++) { this.pools.setColorAt(i * 2, new THREE.Color('#ffe6b8')); this.pools.setColorAt(i * 2 + 1, new THREE.Color('#ff3a2a')); }
    this.group.add(this.pools);

    // signal lenses
    this.lamps = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 0.03, 20), new THREE.MeshBasicMaterial(), Math.max(1, lampAt.length));
    this.lamps.count = lampAt.length; this.lamps.frustumCulled = false;
    lampAt.forEach((l, i) => {
      this.lamps.setMatrixAt(i, _m.compose(l.p, _q.setFromEuler(_e.set(0, l.yaw, -Math.PI / 2)), _s.set(l.s, 1, l.s)));
      this.lamps.setColorAt(i, new THREE.Color(0));
      this.lampRoles.push(l.role);
    });
    this.group.add(this.lamps);

    this.applyQuality(quality);
    for (const lane of this.lanes) this.seed(lane);
  }

  // ---------------------------------------------------------------- layout
  private layoutAsakusa(b: Builder, lampAt: { p: THREE.Vector3; yaw: number; role: LampRole; s: number }[]): void {
    const east: Lane = { axis: 'x', c: -1.6, dir: 1, a0: -85, a1: 85, stops: [{ at: -32.6, cw: -30, signal: false }, { at: -2.6, cw: 0, signal: true }], bus: [-13], bike: false };
    const west: Lane = { axis: 'x', c: 1.6, dir: -1, a0: 85, a1: -85, stops: [{ at: 2.6, cw: 0, signal: true }, { at: -27.4, cw: -30, signal: false }], bus: [13.5], bike: false };
    const be: Lane = { ...east, c: -3.0, bus: [], bike: true, link: east }, bw: Lane = { ...west, c: 3.0, bus: [], bike: true, link: west };
    east.link = be; west.link = bw;
    this.lanes.push(east, west, be, bw);
    this.crossings.push({ x: 0, z: 0, road: 'x', half: 3.5, signal: true }, { x: -30, z: 0, road: 'x', half: 3.5, signal: false });
    this.signalPole(b, lampAt, 2.45, -4.2, [0, 1], 4.2 - 1.6 + 0.55, { F: [-1, 0], axis: 'x' }, [{ F: [0, 1], road: 'x' }]);
    this.signalPole(b, lampAt, -2.45, 4.2, [0, -1], 4.2 - 1.6 + 0.55, { F: [1, 0], axis: 'x' }, [{ F: [0, -1], road: 'x' }]);
    this.busStop(b, -14, -4.05, 'x'); this.busStop(b, 14.5, 4.05, 'x');
  }

  private layoutCity(b: Builder, R: number, lampAt: { p: THREE.Vector3; yaw: number; role: LampRole; s: number }[]): void {
    const S = R + 2, N = R - 1; // crosswalk centre offset; N-S street half width
    const ew = (c: number, dir: 1 | -1, bus: number[], bike = false): Lane => ({
      axis: 'x', c, dir, a0: -85 * dir, a1: 85 * dir, bus, bike,
      stops: [{ at: -dir * (S + 2.6), cw: -dir * S, signal: true }, { at: dir * (S - 2.6), cw: dir * S, signal: false }],
    });
    const ns = (c: number, dir: 1 | -1, bike = false): Lane => ({
      axis: 'z', c, dir, a0: -85 * dir, a1: 85 * dir, bus: [], bike,
      stops: [{ at: -dir * (S + 2.6), cw: -dir * S, signal: true }, { at: dir * (S - 2.6), cw: dir * S, signal: false }],
    });
    const eOut = ew(-0.75 * R, 1, [-37]), wOut = ew(0.75 * R, -1, [26]);
    const eBike = ew(-(R - 0.45), 1, [], true), wBike = ew(R - 0.45, -1, [], true);
    eOut.link = eBike; eBike.link = eOut; wOut.link = wBike; wBike.link = wOut;
    this.lanes.push(ew(-0.25 * R, 1, []), eOut, ew(0.25 * R, -1, []), wOut, eBike, wBike, ns(N / 2, 1), ns(-N / 2, -1), ns(N - 0.45, 1, true), ns(-(N - 0.45), -1, true));
    for (const s of [-1, 1]) {
      this.crossings.push({ x: s * S, z: 0, road: 'x', half: R, signal: true }, { x: 0, z: s * S, road: 'z', half: N, signal: true });
    }
    const P = R + 0.6;
    // far-side, left-kerb vehicle heads; every corner also shows pedestrians both of its crossings
    this.signalPole(b, lampAt, P, -P, [0, 1], R / 2 + 1.15, { F: [-1, 0], axis: 'x' }, [{ F: [0, 1], road: 'x' }, { F: [-1, 0], road: 'z' }]);
    this.signalPole(b, lampAt, -P, P, [0, -1], R / 2 + 1.15, { F: [1, 0], axis: 'x' }, [{ F: [0, -1], road: 'x' }, { F: [1, 0], road: 'z' }]);
    this.signalPole(b, lampAt, P, P, [-1, 0], P - N / 2 + 0.55, { F: [0, -1], axis: 'z' }, [{ F: [0, -1], road: 'x' }, { F: [-1, 0], road: 'z' }]);
    this.signalPole(b, lampAt, -P, -P, [1, 0], P - N / 2 + 0.55, { F: [0, 1], axis: 'z' }, [{ F: [0, 1], road: 'x' }, { F: [1, 0], road: 'z' }]);
    this.busStop(b, -38, -(R + 0.45), 'x'); this.busStop(b, 27, R + 0.45, 'x');
  }

  /** Signal pole at (x,z): an arm along A carrying a horizontal vehicle head facing F, plus pedestrian heads. */
  private signalPole(b: Builder, lampAt: { p: THREE.Vector3; yaw: number; role: LampRole; s: number }[], x: number, z: number, A: V2, arm: number,
    veh: { F: V2; axis: Axis } | null, peds: { F: V2; road: Axis }[]): void {
    const POLE = '#a7abaf', HEAD = '#53585e', yawOf = (d: V2) => Math.atan2(-d[1], d[0]);
    b.add(G.cyl(0.075, 0.095, 5.4, 16), POLE, { at: [x, 0, z] });
    b.add(G.cyl(0.17, 0.19, 0.1, 16), '#8d9196', { at: [x, 0, z] });
    b.add(G.cyl(0.1, 0.1, 0.06, 16), POLE, { at: [x, 5.4, z] });
    b.collide(x, z, 0.35, 0.35, 4, false);
    if (veh) {
      const [ax, az] = A, [fx, fz] = veh.F, Rr: V2 = [fz, -fx];
      b.add(G.cyl(0.05, 0.05, arm, 10), POLE, { at: [x, 5.1, z], rot: [0, yawOf(A), -Math.PI / 2] });
      b.add(G.cyl(0.02, 0.02, 1.6, 8), POLE, { at: [x, 4.35, z], rot: [0, yawOf(A), -Math.PI / 4] }); // brace
      const hx = x + ax * (arm - 0.6), hz = z + az * (arm - 0.6), hy = 4.85;
      b.add(G.cyl(0.02, 0.02, 0.25, 6), POLE, { at: [hx, hy + 0.0, hz] });
      b.add(G.rbox(1.32, 0.42, 0.24, 0.06), HEAD, { at: [hx, hy - 0.21, hz], rot: [0, yawOf(Rr), 0] });
      b.add(G.rbox(1.46, 0.54, 0.03, 0.03), '#3e4247', { at: [hx - fx * 0.14, hy - 0.27, hz - fz * 0.14], rot: [0, yawOf(Rr), 0] });
      const cols: ['g' | 'y' | 'r', number][] = [['g', -0.42], ['y', 0], ['r', 0.42]];
      for (const [c, o] of cols) {
        const lx = hx + Rr[0] * o + fx * 0.125, lz = hz + Rr[1] * o + fz * 0.125;
        lampAt.push({ p: new THREE.Vector3(lx, hy, lz), yaw: yawOf(veh.F), role: { veh: veh.axis, c }, s: 0.125 });
        b.add(G.rbox(0.3, 0.02, 0.17, 0.008), HEAD, { at: [lx + fx * 0.07, hy + 0.15, lz + fz * 0.07], rot: [0, yawOf(Rr), 0] });
      }
    }
    for (const p of peds) {
      const [fx, fz] = p.F, Rr: V2 = [fz, -fx];
      const cx = x + fx * 0.2, cz = z + fz * 0.2, cy = 2.75;
      b.add(G.rbox(0.32, 0.66, 0.2, 0.04), HEAD, { at: [cx, cy - 0.33, cz], rot: [0, yawOf(Rr), 0] });
      b.add(G.box(0.06, 0.06, 0.12), POLE, { at: [x + fx * 0.09, cy - 0.03, z + fz * 0.09], rot: [0, yawOf(p.F), 0] });
      lampAt.push({ p: new THREE.Vector3(cx + fx * 0.105, cy + 0.15, cz + fz * 0.105), yaw: yawOf(p.F), role: { ped: p.road, c: 'r' }, s: 0.11 });
      lampAt.push({ p: new THREE.Vector3(cx + fx * 0.105, cy - 0.15, cz + fz * 0.105), yaw: yawOf(p.F), role: { ped: p.road, c: 'g' }, s: 0.11 });
    }
  }

  /** Tokyo-style bus stop: round sign on a post with a timetable panel, facing along the road. */
  private busStop(b: Builder, x: number, z: number, axis: Axis): void {
    const rot: [number, number, number] = axis === 'x' ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0];
    b.add(G.cyl(0.24, 0.26, 0.12, 18), '#b9b6ae', { at: [x, 0, z] });
    b.add(G.cyl(0.035, 0.035, 2.45, 10), '#8e9297', { at: [x, 0.1, z] });
    b.add(G.cyl(0.27, 0.27, 0.05, 28), PALETTE.roofCopper, { at: [x, 2.32, z], rot });
    b.add(G.cyl(0.21, 0.21, 0.07, 28), '#f3f0e8', { at: [x, 2.32, z], rot });
    b.add(G.cyl(0.07, 0.07, 0.08, 18), '#3f6f6a', { at: [x, 2.32, z], rot });
    b.add(G.rbox(axis === 'x' ? 0.06 : 0.42, 0.56, axis === 'x' ? 0.42 : 0.06, 0.02), '#f1efe9', { at: [x, 1.15, z] });
    b.add(G.rbox(axis === 'x' ? 0.07 : 0.44, 0.08, axis === 'x' ? 0.44 : 0.07, 0.02), '#3f6f6a', { at: [x, 1.7, z] });
    b.collide(x, z, 0.5, 0.5, 2.5, false);
  }

  private pickLane(type: VType): Lane {
    const cands = type === 'bicycle' ? this.lanes.filter((l) => l.bike)
      : type === 'bus' ? this.lanes.filter((l) => l.bus.length)
        : this.lanes.filter((l) => !l.bike);
    // spread evenly: the least-loaded candidate (ties broken randomly)
    let best = cands[0], bestN = Infinity;
    for (const l of cands) { const n = this.vehicles.filter((v) => v.lane === l).length + this.r() * 0.5 + (l.axis === 'z' ? 0.6 : 0); if (n < bestN) { bestN = n; best = l; } }
    return best;
  }

  private seed(lane: Lane): void {
    const vs = this.vehicles.filter((v) => v.lane === lane && v.active);
    let p = lane.a0 + lane.dir * (2 + this.r() * 12);
    for (const v of vs) {
      v.pos = p + lane.dir * (v.spec.len / 2);
      p += lane.dir * (v.spec.len + 9 + this.r() * 26);
      v.v = v.vmax * 0.8;
      v.waiting = (v.pos - lane.a1) * lane.dir > 0;
      this.repaint(v);
    }
  }

  private repaint(v: Vehicle): void {
    const r = this.r, pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const lux = this.id === 'ginza';
    let c1: string, c2: string;
    switch (v.type) {
      case 'taxi': case 'van': case 'bus': [c1, c2] = pick(v.type === 'taxi' ? PAINT.taxi : v.type === 'van' ? PAINT.van : PAINT.bus); break;
      case 'kei': c1 = pick(PAINT.kei); c2 = r() < 0.45 ? '#f1efea' : c1; break;
      case 'truck': c1 = c2 = pick(PAINT.truck); break;
      case 'scooter': c1 = pick(PAINT.scooter); c2 = pick(PAINT.helmet); break;
      case 'bicycle': c1 = pick(PAINT.bike); c2 = pick(PAINT.shirt); break;
      default: c1 = c2 = pick(lux ? PAINT.lux : PAINT.car);
    }
    const m = this.meshes.get(v.type)!, a = new THREE.Color(c1), b = new THREE.Color(c2);
    m.p1.setXYZ(v.slot, a.r, a.g, a.b); m.p2.setXYZ(v.slot, b.r, b.g, b.b);
    m.p1.needsUpdate = m.p2.needsUpdate = true;
  }

  private applyQuality(q: TrafficQuality): void {
    this.quality = q;
    const cap = Math.ceil(this.vehicles.length * CAP[q]);
    this.vehicles.forEach((v, i) => { v.active = i < cap; });
  }

  // ---------------------------------------------------------------- signals
  private phase(): { p: Phase; i: number; rem: number } {
    let t = ((this.t % this.cycle) + this.cycle) % this.cycle;
    for (let i = 0; i < this.phases.length; i++) { const p = this.phases[i]; if (t < p.dur) return { p, i, rem: p.dur - t }; t -= p.dur; }
    return { p: this.phases[0], i: 0, rem: this.phases[0].dur };
  }
  /** Vehicle signal for traffic moving along `axis`: green, yellow (amber) or red. */
  signal(axis: Axis): 'g' | 'y' | 'r' {
    const { p, rem } = this.phase();
    return !p.green.includes(axis) ? 'r' : rem < AMBER ? 'y' : 'g';
  }
  /** Pedestrian signal for crossing the road that runs along `road`: green, flashing (finish crossing) or red. */
  pedSignal(road: Axis): 'g' | 'f' | 'r' {
    const { p, i, rem } = this.phase();
    if (p.clear || p.green.includes(road)) return 'r';
    const next = this.phases[(i + 1) % this.phases.length];
    return rem < 4 && (next.clear || next.green.includes(road)) ? 'f' : 'g';
  }
  /** True when a pedestrian may step onto this crossing now (signal green, or an unsignalised zebra). */
  canCross(c: Crossing): boolean { return !c.signal || this.pedSignal(c.road) === 'g'; }

  // ---------------------------------------------------------------- simulation
  private blockedAt(L: Lane, along: number, lateral: number, player: THREE.Vector3): boolean {
    const hit = (x: number, z: number) => {
      const a = L.axis === 'x' ? x : z, l = L.axis === 'x' ? z : x;
      return Math.abs(a - along) < 2.4 && Math.abs(l - L.c) < lateral;
    };
    if (player.y < 2 && hit(player.x, player.z)) return true;
    for (const w of this.walkers) if (hit(w.x, w.z)) return true;
    return false;
  }

  update(dt: number, night: number, player: THREE.Vector3, quality?: TrafficQuality): void {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    if (quality && quality !== this.quality) this.applyQuality(quality);
    this.night.value = night;
    this.vmat.envMapIntensity = 1 - 0.75 * night;
    const B = 3.2, sv = (d: number) => (d <= 0 ? 0 : Math.sqrt(2 * B * d));
    const sig = { x: this.signal('x'), z: this.signal('z') };

    for (const c of this.vehicles) {
      if (!c.active || c.pin) continue;
      const L = c.lane, dir = L.dir, len = c.spec.len;
      if (c.waiting) {
        // respawn at the lane start once there is room
        let clear = true;
        for (const o of this.vehicles) if (o !== c && o.active && !o.waiting && o.lane === L && ((o.pos - (dir * o.spec.len) / 2) - L.a0) * dir < len + 6) { clear = false; break; }
        if (!clear) continue;
        c.waiting = false; c.pos = L.a0 + (dir * len) / 2; c.v = c.vmax * 0.7; c.nextBus = 0; c.dwell = 0; this.repaint(c);
      }
      const front = c.pos + (dir * len) / 2;
      let want = c.vmax;
      // stop lines: red/amber lights, people on the crossing
      for (const s of L.stops) {
        const d = (s.at - front) * dir;
        if (d < -2.5 || d > 45) continue; // a crawling overshoot still counts as before the line
        let halt = false;
        if (s.signal) { const st = sig[L.axis]; halt = (st === 'r' && (c.v < 4 || d > (c.v * c.v) / 16 - 0.3)) || (st === 'y' && d > (c.v * c.v) / 10 + 0.5); } // past the point of no return: clear the junction
        if (!halt) halt = this.blockedAt(L, s.cw, L.bike ? 2.5 : 4, player);
        if (halt) want = Math.min(want, sv(d - 0.4));
      }
      // bus stops: pull up, dwell, go
      if (c.type === 'bus' && c.nextBus < L.bus.length) {
        const d = (L.bus[c.nextBus] - front) * dir;
        if (d < -1) c.nextBus++;
        else if (d < 50) {
          want = Math.min(want, sv(d));
          if (d < 0.8 && c.v < 0.15) { c.dwell += dt; if (c.dwell > 6) { c.nextBus++; c.dwell = 0; } }
        }
      }
      // car following (bikes and wide buses also see each other across the linked kerb lane)
      let lead: Vehicle | null = null, gap = Infinity;
      for (const o of this.vehicles) {
        if (o === c || !o.active || o.waiting || o.pin) continue;
        if (o.lane !== L && !(o.lane === L.link && (c.spec.wid > 2 || o.spec.wid > 2))) continue;
        const g = (o.pos - c.pos) * dir - (len + o.spec.len) / 2;
        if (g > -0.5 && g < gap) { gap = g; lead = o; }
      }
      if (lead) { const s0 = L.bike ? 1.0 : 2.0; want = Math.min(want, Math.sqrt(lead.v * lead.v + 2 * B * Math.max(0, gap - s0 - c.v * 0.5))); if (gap < s0) want = 0; }
      // never run into the player (or a walker) standing in the lane
      const lat = c.spec.wid / 2 + 0.8;
      const pa = L.axis === 'x' ? player.x : player.z, pl = L.axis === 'x' ? player.z : player.x;
      const yieldTo = (a: number, l: number) => {
        if (Math.abs(l - L.c) > lat) return;
        const d = (a - front) * dir;
        if (d > -len - 0.5 && d < 14) want = Math.min(want, d < 0 ? 0 : sv(d - 1.6));
      };
      if (player.y < 2) yieldTo(pa, pl);
      for (const w of this.walkers) yieldTo(L.axis === 'x' ? w.x : w.z, L.axis === 'x' ? w.z : w.x);

      const a = THREE.MathUtils.clamp((want - c.v) * 4, -8, c.spec.acc);
      c.v = Math.max(0, c.v + a * dt);
      c.a = a;
      c.pos += c.v * dir * dt;
      c.dist += c.v * dt;
      if ((front - L.a1) * dir > 0) c.waiting = true;
    }
    this.draw(dt);
  }

  private draw(dt: number): void {
    const base = new THREE.Matrix4(), body = new THREE.Matrix4(), pm = new THREE.Matrix4(), wm = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const wsc = new THREE.Vector3();
    const night = this.night.value;
    for (let i = 0; i < this.vehicles.length; i++) {
      const c = this.vehicles[i], m = this.meshes.get(c.type)!, wmesh = c.spec.bike ? this.bikeWheels : this.wheels;
      if (!c.active || c.waiting) {
        m.mesh.setMatrixAt(c.slot, zero);
        for (let w = 0; w < c.spec.wheels.length; w++) wmesh.setMatrixAt(c.wheel0 + w, zero);
        this.pools.setMatrixAt(i * 2, zero); this.pools.setMatrixAt(i * 2 + 1, zero);
        continue;
      }
      let x: number, z: number, yaw: number;
      if (c.pin) { ({ x, z, yaw } = c.pin); }
      else {
        const L = c.lane;
        x = L.axis === 'x' ? c.pos : L.c; z = L.axis === 'x' ? L.c : c.pos;
        yaw = L.axis === 'x' ? (L.dir > 0 ? 0 : Math.PI) : (L.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
      // brake lights (also held while standing) and a sprung suspension pitch
      const braking = c.a < -0.7 || c.v < 0.3 ? 1 : 0;
      c.brake += (braking - c.brake) * Math.min(1, dt * 14);
      m.br.setX(c.slot, c.brake);
      const target = THREE.MathUtils.clamp(c.a * (c.spec.bike ? 0 : c.type === 'bus' ? 0.003 : 0.0055), -0.035, 0.02);
      c.pv += ((target - c.pitch) * 90 - c.pv * 11) * dt;
      c.pitch += c.pv * dt;
      base.makeRotationY(yaw).setPosition(x, 0.02, z);
      const ph = 0.45;
      pm.makeRotationZ(c.pitch).setPosition(ph * Math.sin(c.pitch), ph * (1 - Math.cos(c.pitch)), 0);
      body.multiplyMatrices(base, pm);
      m.mesh.setMatrixAt(c.slot, body);
      c.spec.wheels.forEach(([wx, wz, wr, ww], w) => {
        wm.makeRotationZ(-c.dist / wr).scale(wsc.set(wr, wr, ww)).setPosition(wx, wr, wz);
        wmesh.setMatrixAt(c.wheel0 + w, wm.premultiply(base));
      });
      if (night > 0.04) {
        const len = c.spec.len, small = c.spec.wid < 1;
        wm.makeScale(small ? 3.5 : 7, 1, small ? 1.6 : Math.min(3.6, c.spec.wid * 2)).setPosition(len / 2 + (small ? 1.7 : 3.4), 0.035, 0);
        this.pools.setMatrixAt(i * 2, wm.premultiply(base));
        wm.makeRotationY(Math.PI).scale(wsc.set(small ? 1 : 2.2, 1, small ? 0.6 : c.spec.wid * 1.1)).setPosition(-len / 2 - (small ? 0.5 : 1.0), 0.034, 0);
        this.pools.setMatrixAt(i * 2 + 1, wm.premultiply(base));
        this.pools.setColorAt(i * 2 + 1, _c.setRGB(1, 0.16, 0.1).multiplyScalar(0.25 + c.brake * 0.55));
      }
    }
    for (const m of this.meshes.values()) { m.mesh.instanceMatrix.needsUpdate = true; m.br.needsUpdate = true; }
    this.wheels.instanceMatrix.needsUpdate = true; this.bikeWheels.instanceMatrix.needsUpdate = true;
    this.pools.visible = night > 0.04;
    if (this.pools.visible) { this.pools.instanceMatrix.needsUpdate = true; this.pools.instanceColor!.needsUpdate = true; this.poolMat.opacity = Math.min(1, night) * 0.5; }
    // signal lenses
    const blink = Math.floor(this.t * 2.5) % 2 === 0;
    const sx = this.signal('x'), sz = this.signal('z');
    this.lampRoles.forEach((r, i) => {
      let on: boolean, col: string;
      if ('veh' in r) { on = (r.veh === 'x' ? sx : sz) === r.c; col = r.c; }
      else { const p = this.pedSignal(r.ped); on = r.c === 'r' ? p === 'r' : p === 'g' || (p === 'f' && blink); col = r.c === 'r' ? 'pr' : 'pg'; }
      this.lamps.setColorAt(i, _c.copy(LAMP[col]).multiplyScalar(on ? 1 : 0.06));
    });
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  /** Debug/showcase: park the first active vehicle of a type at (x,z) facing yaw (pass null to release). */
  pin(type: VType, x: number | null, z = 0, yaw = 0): void {
    const v = this.vehicles.find((o) => o.type === type && o.active);
    if (!v) return;
    if (x === null) { v.pin = undefined; return; }
    v.pin = { x, z, yaw }; v.waiting = false; v.v = 0; v.a = 0;
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.mesh.dispose();
    this.wheels.dispose(); this.bikeWheels.dispose(); this.pools.dispose(); this.lamps.dispose();
    this.vmat.dispose(); this.poolMat.map?.dispose(); this.poolMat.dispose();
  }
}
const _c = new THREE.Color();
const LAMP: Record<string, THREE.Color> = {
  g: new THREE.Color(0.12, 1.5, 0.95), y: new THREE.Color(1.7, 0.95, 0.08), r: new THREE.Color(1.9, 0.1, 0.06),
  pg: new THREE.Color(0.2, 1.4, 1.0), pr: new THREE.Color(1.8, 0.12, 0.08),
};
