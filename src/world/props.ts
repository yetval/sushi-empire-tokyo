// Street props & buildings. All functions draw into a Builder in its current local frame
// (front faces +z, ground y=0). They add their own colliders.
import * as THREE from 'three';
import { Builder, G, proto } from './kit';

export const C = {
  wood: '#6b4330', woodL: '#9a6b47', woodD: '#4a2c1f', red: '#d6452c', redD: '#a8321f', plaster: '#f4ecdc', paper: '#fff3d6',
  tile: '#4d5566', tileD: '#3b4252', stone: '#cfc6b8', stoneD: '#a99f91', asphalt: '#4a4d57', curb: '#bdb6a8', white: '#f7f5f0',
  metal: '#8d96a3', metalD: '#5c6470', black: '#2a2b30', glass: '#a8cbe0', lit: '#ffd58a', pinks: ['#ffc4dc', '#ffb0cf', '#ffd9e8', '#f7a3c6', '#ffe4ee'],
  greens: ['#7cc46a', '#5fae5b', '#8fd17a', '#4f9e50'], gold: '#d8b24a',
};

export const gable = (w: number, h: number, len: number) => {
  const sh = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
  return new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2).rotateY(Math.PI / 2);
};
/** Hip roof (pyramid) of base w×d and height h, bottom at y=0. */
export const hip = (w: number, d: number, h: number) => new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).translate(0, 0.5, 0).scale(w, h, d);

// ---------------------------------------------------------------- nature
export function sakura(b: Builder, x: number, z: number, s = 1, r = Math.random): THREE.Vector3 {
  b.add(G.cyl(0.14 * s, 0.22 * s, 2.2 * s, 8), C.woodD, { at: [x, 0, z], rot: [0, 0, (r() - 0.5) * 0.15] });
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + r();
    b.add(G.cyl(0.05 * s, 0.1 * s, 1.4 * s, 6), C.woodD, { at: [x + Math.cos(a) * 0.2 * s, 1.9 * s, z + Math.sin(a) * 0.2 * s], rot: [Math.sin(a) * 0.8, 0, -Math.cos(a) * 0.8] });
  }
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.5, rad = (0.6 + r() * 0.9) * s;
    const cr = (0.75 + r() * 0.45) * s;
    b.add(G.ico(cr, 1), C.pinks[i % C.pinks.length], { at: [x + Math.cos(a) * rad, (2.9 + r() * 0.9) * s, z + Math.sin(a) * rad], scale: [1, 0.8, 1] });
  }
  b.add(G.ico(1.1 * s, 1), C.pinks[0], { at: [x, 3.7 * s, z], scale: [1, 0.75, 1] });
  // fallen petals ring
  b.add(G.cyl(1.7 * s, 1.7 * s, 0.01, 16), '#f9cfe0', { at: [x, 0.035, z] });
  b.collide(x, z, 0.5 * s, 0.5 * s, 3, false);
  b.collideY(x, z, 2.8 * s, 2.8 * s, 2.9 * s, 4.6 * s); // canopy blocks the camera
  return b.world(x, 3.3 * s, z);
}

export function greenTree(b: Builder, x: number, z: number, s = 1, r = Math.random, planter = true): void {
  if (planter) b.box(x, 0, z, 1.3, 0.12, 1.3, '#8a8072');
  b.add(G.cyl(0.11 * s, 0.17 * s, 2.4 * s, 8), C.woodD, { at: [x, 0, z] });
  for (let i = 0; i < 5; i++) {
    const a = i * 1.3 + r();
    b.add(G.ico((0.7 + r() * 0.35) * s, 1), C.greens[i % 4], { at: [x + Math.cos(a) * 0.55 * s, (2.7 + r() * 0.8) * s, z + Math.sin(a) * 0.55 * s] });
  }
  b.add(G.ico(0.85 * s, 1), C.greens[1], { at: [x, 3.6 * s, z] });
  b.collide(x, z, 0.4, 0.4, 3, false);
  b.collideY(x, z, 2.0 * s, 2.0 * s, 2.6 * s, 4.4 * s);
}

export function pine(b: Builder, x: number, z: number, s = 1): void {
  b.add(G.cyl(0.15 * s, 0.25 * s, 2 * s, 7), C.woodD, { at: [x, 0, z], rot: [0, 0, 0.15] });
  for (const [dx, y, r] of [[0.3, 2.0, 1.1], [-0.6, 2.6, 0.9], [0.5, 3.2, 0.8], [0, 3.8, 0.6]] as const)
    b.add(G.sphere(r * s), '#3f7d4a', { at: [x + dx * s, y * s, z], scale: [1.4, 0.45, 1.1] });
  b.collide(x, z, 0.5, 0.5, 3, false);
  b.collideY(x, z, 2.4 * s, 1.8 * s, 2.0 * s, 4.2 * s);
}

export function bush(b: Builder, x: number, z: number, s = 1, color = C.greens[3]): void {
  b.add(G.ico(0.55 * s, 1), color, { at: [x, 0.35 * s, z], scale: [1.2, 0.8, 1] });
}

export function planter(b: Builder, x: number, z: number, flower = '#ff7aa8'): void {
  b.rbox(x, 0, z, 0.6, 0.45, 0.6, '#b9764e', 0.06);
  b.add(G.ico(0.32, 1), C.greens[0], { at: [x, 0.62, z] });
  for (let i = 0; i < 4; i++) b.sphere(x + Math.cos(i * 1.6) * 0.2, 0.8, z + Math.sin(i * 1.6) * 0.2, 0.08, flower);
  b.collide(x, z, 0.6, 0.6, 0.8, false);
}

export function bonsai(b: Builder, x: number, y: number, z: number): void {
  b.rbox(x, y, z, 0.36, 0.12, 0.22, '#3c4a63', 0.03);
  b.add(G.cyl(0.03, 0.05, 0.22, 6), C.woodD, { at: [x, y + 0.12, z], rot: [0, 0, 0.4] });
  b.add(G.ico(0.14, 1), '#4f8a4a', { at: [x - 0.08, y + 0.32, z], scale: [1.4, 0.6, 1] });
  b.add(G.ico(0.1, 1), '#5fa055', { at: [x + 0.1, y + 0.28, z], scale: [1.4, 0.6, 1] });
}

// ---------------------------------------------------------------- street furniture
export function lamp(b: Builder, x: number, z: number, style: 'classic' | 'modern' | 'lux' = 'classic'): void {
  if (style === 'modern') {
    b.cyl(x, 0, z, 0.07, 0.09, 5.2, C.metalD, 8);
    b.box(x, 5.1, z + 0.5, 0.12, 0.1, 1.1, C.metalD);
    b.rbox(x, 4.95, z + 1.0, 0.35, 0.15, 0.55, '#ffffff', 0.05, '#fff1c2');
    b.pool(x, z + 1.0, 4.5, '#ffe2a8');
  } else if (style === 'lux') {
    b.cyl(x, 0, z, 0.1, 0.14, 0.5, C.black, 10);
    b.cyl(x, 0.5, z, 0.06, 0.07, 3.4, C.black, 8);
    for (const dx of [-0.45, 0.45]) {
      b.box(x + dx / 2, 3.7, z, 0.5, 0.05, 0.05, C.gold);
      b.add(G.sphere(0.2), '#fff8e6', { at: [x + dx, 3.65, z], glow: '#ffe7b0' });
    }
    b.add(G.sphere(0.22), '#fff8e6', { at: [x, 4.05, z], glow: '#ffe7b0' });
    b.pool(x, z, 4.2, '#ffe0a0');
    b.box(x, 3.15, z + 0.1, 0.03, 0.03, 0.55, C.black); b.box(x, 1.95, z + 0.1, 0.03, 0.03, 0.55, C.black);
    const gold = Math.abs(Math.round(x + z)) % 2 === 0;
    b.sign(x + 0.02, 2.55, z + 0.38, 0.5, 1.15, gold ? 'GINZA' : '銀座', { bg: gold ? '#c9a227' : '#7d1d3f', fg: '#ffffff', vertical: true, px: 70, ry: Math.PI / 2 });
    b.sign(x - 0.02, 2.55, z + 0.38, 0.5, 1.15, gold ? 'GINZA' : '銀座', { bg: gold ? '#c9a227' : '#7d1d3f', fg: '#ffffff', vertical: true, px: 70, ry: -Math.PI / 2 });
  } else {
    b.cyl(x, 0, z, 0.07, 0.1, 3.6, '#3d3f4a', 8);
    b.add(G.cyl(0.22, 0.12, 0.4, 6), '#fff2cc', { at: [x, 3.6, z], glow: '#ffd27a' });
    b.add(G.cone(0.3, 0.22, 6), '#3d3f4a', { at: [x, 4.0, z] });
    b.pool(x, z, 4, '#ffcb70');
  }
  b.collide(x, z, 0.25, 0.25, 4, false);
}

/** Red paper lantern hanging with its bottom at y. */
export function lantern(b: Builder, x: number, y: number, z: number, color = C.red, s = 1): void {
  b.add(G.sphere(0.24 * s, 12, 10), color, { at: [x, y + 0.3 * s, z], scale: [1, 1.3, 1], glow: color === C.red ? '#ff6a3a' : '#ffd27a' });
  b.cyl(x, y, z, 0.13 * s, 0.13 * s, 0.05 * s, C.black, 10);
  b.cyl(x, y + 0.58 * s, z, 0.13 * s, 0.13 * s, 0.05 * s, C.black, 10);
}

export function vending(b: Builder, x: number, z: number, ry = 0, color = '#e94e3c'): void {
  b.push(x, 0, z, ry);
  b.rbox(0, 0, 0, 1.0, 1.9, 0.75, color, 0.06);
  b.box(0, 0.9, 0.36, 0.84, 0.8, 0.04, '#e9f4ff', '#cfe6ff');
  const drinks = ['#ff5b5b', '#3fa7ff', '#ffd23f', '#5fd068', '#ff9f43', '#ffffff'];
  for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) b.add(G.cyl(0.045, 0.045, 0.16, 6), drinks[(i + r * 2) % 6], { at: [-0.33 + i * 0.13, 0.98 + r * 0.25, 0.39] });
  b.box(0, 0.25, 0.36, 0.7, 0.18, 0.05, C.black);
  b.box(0.3, 0.55, 0.37, 0.12, 0.25, 0.03, '#cfd6df');
  // dressed back: maker panel, vents, service plate
  b.box(0, 0.25, -0.385, 0.86, 1.5, 0.02, shadeHex(color, 0.82));
  b.box(0, 1.45, -0.39, 0.86, 0.22, 0.02, '#f4f4f4');
  for (let i = 0; i < 6; i++) b.box(0, 0.35 + i * 0.08, -0.395, 0.6, 0.03, 0.01, '#3a3d44');
  b.box(-0.28, 1.0, -0.395, 0.18, 0.12, 0.01, '#e9e9e9');
  b.pop();
  b.push(x, 0, z, ry).collide(0, 0, 1.0, 0.75, 1.9, true).pop();
}

export function bench(b: Builder, x: number, z: number, ry = 0): void {
  b.push(x, 0, z, ry);
  for (const dx of [-0.65, 0.65]) b.box(dx, 0, 0, 0.08, 0.42, 0.45, C.metalD);
  b.rbox(0, 0.42, 0, 1.6, 0.07, 0.48, C.woodL, 0.03);
  b.rbox(0, 0.5, -0.24, 1.6, 0.4, 0.06, C.woodL, 0.03);
  b.collide(0, 0, 1.6, 0.5, 0.6, false);
  b.pop();
}

export function bin(b: Builder, x: number, z: number): void {
  b.cyl(x, 0, z, 0.25, 0.22, 0.85, '#5f8f6a', 10);
  b.cyl(x, 0.85, z, 0.27, 0.27, 0.06, '#486d51', 10);
  b.collide(x, z, 0.5, 0.5, 0.9, false);
}

export function bike(b: Builder, x: number, z: number, ry = 0, color = '#3a86ff'): void {
  b.push(x, 0, z, ry);
  for (const dx of [-0.48, 0.48]) b.add(new THREE.TorusGeometry(0.3, 0.035, 6, 16), C.black, { at: [dx, 0.33, 0] });
  b.add(G.cyl(0.025, 0.025, 0.9, 5), color, { at: [0, 0.35, 0], rot: [0, 0, Math.PI / 2 - 0.2] });
  b.add(G.cyl(0.025, 0.025, 0.55, 5), color, { at: [-0.15, 0.33, 0], rot: [0, 0, 0.5] });
  b.add(G.cyl(0.025, 0.025, 0.55, 5), color, { at: [0.38, 0.33, 0], rot: [0, 0, -0.3] });
  b.box(-0.22, 0.85, 0, 0.22, 0.05, 0.1, C.black);
  b.box(0.47, 0.95, 0, 0.05, 0.05, 0.5, C.metalD);
  b.rbox(0.62, 0.62, 0, 0.25, 0.18, 0.3, '#c9c3b5', 0.03); // basket
  b.pop();
}

export function scooter(b: Builder, x: number, z: number, ry = 0, color = '#ff8fab'): void {
  b.push(x, 0, z, ry);
  for (const dx of [-0.5, 0.5]) b.add(new THREE.TorusGeometry(0.2, 0.08, 6, 14), C.black, { at: [dx, 0.24, 0] });
  b.rbox(-0.2, 0.3, 0, 0.8, 0.4, 0.42, color, 0.15);
  b.rbox(-0.25, 0.7, 0, 0.55, 0.12, 0.34, C.black, 0.05);
  b.rbox(0.45, 0.25, 0, 0.18, 0.75, 0.3, color, 0.08);
  b.box(0.5, 1.0, 0, 0.06, 0.06, 0.6, C.metalD);
  b.rbox(-0.6, 0.85, 0, 0.35, 0.3, 0.36, '#ffffff', 0.05); // delivery box
  b.pop();
  b.push(x, 0, z, ry).collide(0, 0, 1.4, 0.5, 1, false).pop();
}

export function crates(b: Builder, x: number, z: number, n = 3, r = Math.random): void {
  for (let i = 0; i < n; i++) b.box(x + (i % 2) * 0.55 - 0.25, Math.floor(i / 2) * 0.4, z + (r() - 0.5) * 0.1, 0.5, 0.38, 0.5, i % 2 ? '#7fa7c9' : '#e8eef3', undefined, (r() - 0.5) * 0.3);
  b.collide(x, z, 1.1, 0.6, 1, false);
}

export function acUnit(b: Builder, x: number, y: number, z: number): void {
  b.rbox(x, y, z, 0.8, 0.55, 0.3, '#e6e8ea', 0.04);
  b.add(G.cyl(0.18, 0.18, 0.02, 14), '#8d96a3', { at: [x - 0.1, y + 0.28, z + 0.15], rot: [Math.PI / 2, 0, 0] });
}

export function powerPole(b: Builder, x: number, z: number, transformer = true): THREE.Vector3 {
  b.cyl(x, 0, z, 0.12, 0.17, 9, '#a8a397', 10);
  for (let i = 0; i < 6; i++) b.box(x, 0.4 + i * 0.25, z, 0.36, 0.12, 0.36, i % 2 ? '#ffd23f' : '#222222'); // hazard band
  b.box(x, 1.9, z + 0.18, 0.22, 0.32, 0.02, '#1d4e89'); // address plate
  for (const [y, w] of [[8.2, 1.8], [7.6, 1.4], [6.9, 1.0]] as const) {
    b.box(x, y, z, w, 0.1, 0.12, '#5c5852');
    for (const sx of [-w / 2 + 0.1, 0, w / 2 - 0.1]) b.cyl(x + sx, y + 0.1, z, 0.04, 0.05, 0.14, '#e8e6e0', 6);
  }
  if (transformer) {
    for (const sx of [-0.28, 0.28]) b.add(G.cyl(0.2, 0.2, 0.7, 10), '#8a9099', { at: [x + sx, 5.6, z + 0.28] });
    b.box(x, 5.5, z + 0.2, 0.8, 0.08, 0.2, '#5c5852');
  }
  b.add(new THREE.TorusGeometry(0.22, 0.05, 6, 12), '#1f1f22', { at: [x + 0.15, 4.6, z + 0.15], rot: [0, 0.6, 0] }); // coiled spare cable
  b.cyl(x - 0.2, 0.2, z + 0.1, 0.03, 0.03, 6.2, '#2b2b2b', 4); // drop conduit
  b.collide(x, z, 0.35, 0.35, 8, false);
  return b.world(x, 7.8, z);
}

/** Sagging wires between two world points (call outside any pushed frame). */
/** Wires strung between two world points (call outside any pushed frame) as true catenaries: power lines on the
 *  cross-arms, then the heavier telecom cable lower down with more sag. */
export function wires(b: Builder, p: THREE.Vector3, q: THREE.Vector3, n = 3): void {
  const dir = q.clone().sub(p); dir.y = 0; dir.normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);
  const span = p.distanceTo(q);
  // [perpendicular offset, height offset, sag per metre of span, radius]
  const LINES: [number, number, number, number][] = [[-0.8, 0.4, 0.022, 0.014], [0.8, 0.4, 0.022, 0.014], [0, 0.4, 0.024, 0.014], [-0.6, -0.2, 0.028, 0.016], [0.6, -0.2, 0.028, 0.016], [0.15, -1.5, 0.045, 0.045], [-0.2, -2.0, 0.05, 0.03]];
  const pick = n > 3 ? LINES.slice(0, n) : n === 1 ? [[0, 0, 0.03, 0.015] as [number, number, number, number]] : LINES.slice(2, 2 + n);
  const K = 1.4, ck = Math.cosh(K), SEG = 14;
  for (const [o, dy, sagPm, rad] of pick) {
    const sag = sagPm * span;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const f = (Math.cosh(K * (2 * t - 1)) - ck) / (ck - 1); // 0 at the poles, -1 mid-span
      pts.push(new THREE.Vector3().lerpVectors(p, q, t).addScaledVector(perp, o).add(new THREE.Vector3(0, dy + f * sag, 0)));
    }
    for (let i = 0; i < SEG; i++) {
      const a = pts[i], c = pts[i + 1];
      const g = new THREE.CylinderGeometry(rad, rad, a.distanceTo(c) + rad, 4).rotateX(Math.PI / 2);
      g.applyMatrix4(new THREE.Matrix4().lookAt(a, c, new THREE.Vector3(0, 1, 0)).setPosition(a.clone().add(c).multiplyScalar(0.5)));
      b.add(g, '#2a2b2f', { vary: 0 });
    }
  }
}

export function nobori(b: Builder, x: number, z: number, text: string, color = '#e63946', ry = 0): void {
  b.cyl(x, 0, z, 0.03, 0.03, 2.8, '#d9d9d9', 6);
  b.sign(x + 0.24 * Math.cos(ry), 1.75, z - 0.24 * Math.sin(ry), 0.45, 1.6, text, { bg: color, fg: '#ffffff', vertical: true, ry, px: 80 });
  b.sign(x + 0.24 * Math.cos(ry), 1.75, z - 0.24 * Math.sin(ry), 0.45, 1.6, text, { bg: color, fg: '#ffffff', vertical: true, ry: ry + Math.PI, px: 80 });
}

export function cone(b: Builder, x: number, z: number): void {
  b.add(G.cone(0.18, 0.6, 10), '#ff7b2e', { at: [x, 0.04, z] });
  b.box(x, 0, z, 0.4, 0.05, 0.4, '#30323a');
  b.box(x, 0.3, z, 0.2, 0.08, 0.2, '#ffffff');
}

/** Striped awning projecting from a facade: front edge at local z=depth. */
export function awning(b: Builder, x: number, y: number, z: number, w: number, depth: number, c1: string, c2 = '#ffffff'): void {
  const n = Math.max(2, Math.round(w / 0.5));
  for (let i = 0; i < n; i++) {
    b.add(G.box(w / n, 0.06, depth + 0.1), i % 2 ? c2 : c1, { at: [x - w / 2 + (i + 0.5) * (w / n), y, z + depth / 2], rot: [0.32, 0, 0] });
  }
  for (let i = 0; i < n; i++) b.add(G.box(w / n, 0.22, 0.04), i % 2 ? c2 : c1, { at: [x - w / 2 + (i + 0.5) * (w / n), y - 0.36, z + depth * 0.95 + 0.05] });
  b.collideY(x, z + depth / 2, w, depth, y + 0.1, y + 0.5); // keep the camera out from under it
}

/** Noren: split fabric curtain hanging in a doorway, top at y. */
export function noren(b: Builder, x: number, y: number, z: number, w: number, color = '#24345c', text?: string): void {
  const n = 3;
  for (let i = 0; i < n; i++) b.box(x - w / 2 + (i + 0.5) * (w / n), y - 0.75, z, w / n - 0.05, 0.75, 0.03, color);
  b.cyl(x, y, z, 0.03, 0.03, 0.01, C.woodD);
  b.add(G.cyl(0.025, 0.025, w + 0.3, 6), C.woodL, { at: [x - w / 2 - 0.15, y + 0.02, z], rot: [0, 0, -Math.PI / 2] });
  if (text) b.sign(x, y - 0.4, z + 0.025, w * 0.6, 0.35, text, { bg: color, fg: '#ffffff', px: 100 });
}

// ---------------------------------------------------------------- buildings
export type Style = 'wood' | 'modern' | 'lux' | 'tower';

export type ShopKind = 'ramen' | 'izakaya' | 'kissaten' | 'pharmacy' | 'karaoke' | 'pachinko' | 'konbini' | 'soba' | 'florist' | 'grocer' | 'books' | 'realestate' | 'salon' | 'souvenir' | 'boutique' | 'generic';
interface ShopDef { kind: ShopKind; names: string[]; bg: string; fg: string; noren?: string }
export const SHOP: Record<ShopKind, ShopDef> = {
  ramen: { kind: 'ramen', names: ['ラーメン', '中華そば', 'らーめん大吉', '博多ラーメン', 'つけ麺'], bg: '#c1121f', fg: '#fff6d6', noren: '#c1121f' },
  izakaya: { kind: 'izakaya', names: ['居酒屋 たぬき', '酒処 まる', '焼鳥 鳥よし', '大衆酒場', 'もつ焼'], bg: '#2b1d14', fg: '#ffd166', noren: '#24345c' },
  kissaten: { kind: 'kissaten', names: ['喫茶 珈琲', '純喫茶 ルナ', '珈琲館', '喫茶 ひまわり'], bg: '#5a3825', fg: '#f6e3b4' },
  pharmacy: { kind: 'pharmacy', names: ['ドラッグ 薬', '薬局', 'くすり'], bg: '#ffd23f', fg: '#1d3557' },
  karaoke: { kind: 'karaoke', names: ['カラオケ', 'カラオケ館', 'うたひろば'], bg: '#ff006e', fg: '#ffffff' },
  pachinko: { kind: 'pachinko', names: ['パチンコ', 'パチンコ 大当り', 'スロット'], bg: '#7b2cbf', fg: '#ffd23f' },
  konbini: { kind: 'konbini', names: ['ハッピーマート', 'デイリー24', 'まいにちマート'], bg: '#ffffff', fg: '#0a8f4e' },
  soba: { kind: 'soba', names: ['手打ちそば', 'そば うどん', '立ち食いそば', '天ぷら'], bg: '#24345c', fg: '#ffffff', noren: '#24345c' },
  florist: { kind: 'florist', names: ['花屋', 'フラワー', '花のまつ'], bg: '#2f5d50', fg: '#ffffff' },
  grocer: { kind: 'grocer', names: ['八百屋', '青果', 'やおや'], bg: '#e76f51', fg: '#ffffff' },
  books: { kind: 'books', names: ['古本', '書店', 'まんが'], bg: '#3d405b', fg: '#ffe8a3' },
  realestate: { kind: 'realestate', names: ['不動産', '賃貸 物件', 'アパマン'], bg: '#1d4e89', fg: '#ffffff' },
  salon: { kind: 'salon', names: ['美容室', 'HAIR', '理容'], bg: '#ffffff', fg: '#e63946' },
  souvenir: { kind: 'souvenir', names: ['人形焼', '雷おこし', '扇子', '団子', '和菓子', '煎餅', '手ぬぐい', '甘味処'], bg: '#2a1d1a', fg: '#ffe7b3', noren: '#7a1f1f' },
  boutique: { kind: 'boutique', names: ['MAISON', 'BIJOUX', 'Atelier', 'Parfum', 'MONTRES', 'Couture', '真珠', 'GALERIE', 'Pâtisserie'], bg: '#2d2d33', fg: '#d8b24a' },
  generic: { kind: 'generic', names: ['洋品店', 'クリーニング', '時計', 'メガネ', '靴'], bg: '#3c4454', fg: '#ffffff' },
};
export const TENANTS = ['歯科', '英会話', '雀荘', '整体', 'スナック', '税理士', '学習塾', 'ネイル', 'マッサージ', '司法書士', 'ヨガ', '鍼灸', 'BAR', '事務所'];
export const pickOf = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)];

export interface BuildingOpts {
  x: number; w: number; d: number; floors: number; style: Style; color: string; r: () => number;
  shop?: string; shopColor?: string; sub?: string; noFront?: boolean; awning?: string; vertical?: string; verticalColor?: string;
  roofSign?: string; collide?: boolean; kind?: ShopKind; clutter?: boolean; setback?: number; sideWindows?: boolean; plain?: boolean; neon?: boolean;
}

const LIT = (r: () => number, p = 0.55) => (r() < p ? ['#e8a04a', '#f0b860', '#d98c3a', '#f5c878', '#cfe3ff'][Math.floor(r() * 5)] : '#000000');
const TILE_COLS = ['#d8c3a5', '#c9b18f', '#bfa58a', '#e2d5c0', '#a89b8c', '#cbbfae', '#b5876a', '#9c7b6a', '#d4c9b8'];

/** Decorative building with facade at local z=0 facing +z and body to z=-d. Returns height. */
export function building(b: Builder, o: BuildingOpts): number {
  const { x, w, floors, style, r } = o;
  const sb = o.setback ?? 0;
  b.push(0, 0, -sb, 0);
  const d = o.d - sb;
  const wooden = style === 'wood';
  const fh = style === 'tower' ? 3.6 : wooden ? 3.0 : 3.1;
  const gh = style === 'tower' ? 4.5 : wooden ? 3.4 : 3.5;
  const h = gh + (floors - 1) * fh;
  const body = o.color;
  b.box(x, 0, -d / 2, w, h, d, body);
  // plinth & cornice bands
  b.box(x, 0, 0.01, w, 0.3, 0.06, shadeHex(body, 0.7));
  if (!wooden && style !== 'tower') b.box(x, h - 0.25, 0.02, w + 0.04, 0.25, 0.12, shadeHex(body, 0.85));
  const kind = o.kind ?? 'generic';
  if (!o.noFront) groundFloor(b, o, kind, gh, wooden);
  // ---- upper floors
  const win = wooden ? '#f4e6c8' : style === 'lux' ? '#cfe0ea' : '#a9c7da';
  const residential = !o.plain && !wooden && style === 'modern' && r() < 0.45;
  const bladeSide = r() < 0.5 ? -1 : 1;
  for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh + 0.6;
    if (style === 'tower') { b.box(x, y - 0.3, 0.01, w - 0.3, fh - 0.9, 0.05, '#8fb3cc', LIT(r, 0.6)); continue; }
    const n = Math.max(1, Math.floor((w - 0.8) / (wooden ? 1.9 : 2.1)));
    const winH = wooden ? 1.4 : 1.6;
    for (let i = 0; i < n; i++) {
      const wx = x - (w - 0.8) / 2 + ((i + 0.5) * (w - 0.8)) / n;
      const ww = Math.min(1.6, (w - 0.8) / n - 0.45);
      b.box(wx, y, 0.01, ww, winH, 0.06, win, LIT(r));
      b.box(wx, y - 0.08, 0.04, ww + 0.16, 0.08, 0.14, wooden ? C.woodD : '#d8dde3');
      if (wooden) { for (let k = 1; k < 5; k++) b.box(wx - ww / 2 + (k * ww) / 5, y, 0.05, 0.04, winH, 0.04, C.woodD); }
      else if (style === 'lux') { b.box(wx, y + winH, 0.04, ww + 0.2, 0.1, 0.08, C.gold); b.box(wx, y - 0.15, 0.06, ww + 0.3, 0.1, 0.25, '#f5f1e8'); }
      else {
        if (r() < 0.3) acUnit(b, wx + ww / 2 + 0.05, y - 0.55, 0.2);
        if (r() < 0.2) b.box(wx, y + 0.2, 0.05, ww * 0.6, 0.5, 0.02, '#ffffff'); // curtain / blind
        // tenant lettering on 2F/3F glass
        if (!residential && f <= 3 && r() < 0.35) b.sign(wx, y + winH / 2, 0.07, ww * 0.8, 0.42, pickOf(r, TENANTS), { bg: '#ffffff', fg: pickOf(r, ['#c1121f', '#1d4e89', '#2b9348', '#7b2cbf']), px: 70 });
      }
    }
    // balconies with laundry on residential floors
    if ((residential && f >= 2) || (wooden && f === floors - 1 && r() < 0.3)) {
      b.box(x, y - 0.75, 0.45, w - 0.3, 0.12, 0.9, shadeHex(body, 0.9));
      b.box(x, y - 0.63, 0.88, w - 0.3, 0.9, 0.05, wooden ? C.woodD : '#c9ced6');
      b.collideY(x, 0.45, w - 0.3, 0.9, y - 0.75, y + 0.3);
      if (r() < 0.75) {
        b.add(G.cyl(0.015, 0.015, w - 0.6, 4), '#bbbbbb', { at: [x - (w - 0.6) / 2, y + 1.0, 0.55], rot: [0, 0, -Math.PI / 2] });
        for (let k = 0; k < Math.floor(w * 1.1); k++) {
          if (r() < 0.3) continue;
          const lx = x - (w - 0.8) / 2 + k * 0.9 + r() * 0.2;
          if (lx > x + (w - 0.8) / 2) break;
          b.add(G.box(0.4 + r() * 0.3, 0.45 + r() * 0.35, 0.03), pickOf(r, ['#ffffff', '#9ec5fe', '#ffd6e0', '#bde0fe', '#fef3c7', '#e63946', '#2a9d8f', '#ffbe0b']), { at: [lx, y + 0.55, 0.55], rot: [0, 0, (r() - 0.5) * 0.08] });
        }
      }
      if (r() < 0.6) acUnit(b, x + w / 2 - 0.7, y - 0.63, 0.5);
      if (r() < 0.5) for (let k = 0; k < 3; k++) b.add(G.ico(0.18, 0), C.greens[k % 4], { at: [x - w / 2 + 0.5 + k * 0.4, y - 0.4, 0.55] });
    }
    if (!wooden && style !== 'lux') b.box(x, gh + (f - 1) * fh - 0.02, 0.02, w, 0.12, 0.08, shadeHex(body, 0.82));
  }
  if (style === 'tower') for (let i = 0; i <= Math.floor(w / 3); i++) b.box(x - w / 2 + (i * w) / Math.floor(w / 3), gh, 0.05, 0.12, h - gh, 0.1, '#e8edf2');
  // side windows (visible on corners)
  if (o.sideWindows && style !== 'wood') for (const sx of [-1, 1]) for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh + 0.6;
    for (let k = 0; k < Math.floor(d / 3.2); k++) b.box(x + sx * (w / 2 + 0.01), y, -1.6 - k * 3.2, 0.06, 1.5, 1.4, win, LIT(r, 0.5));
  }
  // vertical blade sign stack bolted at an angle
  if ((style === 'modern' && !o.plain && r() < 0.65) || o.vertical) {
    const bx = x + bladeSide * (w / 2 - 0.35);
    const n = Math.min(floors - 1, 2 + Math.floor(r() * 3));
    for (let k = 0; k < n; k++) {
      const name = k === 0 && o.vertical ? o.vertical : pickOf(r, [...TENANTS, 'カラオケ', 'BAR', 'ラーメン', '居酒屋']);
      const col = o.verticalColor && k === 0 ? o.verticalColor : pickOf(r, ['#c1121f', '#7b2cbf', '#0077b6', '#2b9348', '#ff006e', '#f77f00', '#1d1d1d', '#ffffff']);
      const fg = col === '#ffffff' ? '#c1121f' : '#ffffff';
      const sy = gh + 0.3 + k * (fh * 0.9);
      const sh = fh * 0.85;
      b.push(bx, sy, 0.55, (r() - 0.5) * 0.04);
      b.box(0, 0, 0, 0.12, sh, 0.85, '#2a2b30');
      b.sign(0.065, sh / 2, 0, 0.8, sh - 0.1, name.slice(0, 5), { bg: col, fg, vertical: true, px: 60, ry: Math.PI / 2 });
      b.sign(-0.065, sh / 2, 0, 0.8, sh - 0.1, name.slice(0, 5), { bg: col, fg, vertical: true, px: 60, ry: -Math.PI / 2 });
      b.box(0, sh * 0.5, -0.45, 0.05, 0.05, 0.12, C.metalD);
      b.pop();
    }
  }
  // neon signboards + LED edge strips (Shibuya / Shinjuku nights)
  if (o.neon && !o.plain && floors > 2) {
    const NEON = ['#ff2e88', '#29e3ff', '#ffe03a', '#7cff6b', '#b46bff', '#ff8a2a'];
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
      const fy = gh + Math.floor(r() * (floors - 1)) * fh + 0.3;
      const nw = 1.4 + r() * Math.min(3, w - 2.5), nx = x + (r() - 0.5) * (w - nw - 0.6);
      const c = pickOf(r, NEON);
      b.box(nx, fy, 0.6, nw + 0.16, 0.9, 0.08, '#111', c);
      b.sign(nx, fy + 0.45, 0.65, nw, 0.74, pickOf(r, ['カラオケ', 'BAR', '焼肉', 'ラーメン', '居酒屋', 'GAME', 'スナック', '麻雀', 'CLUB', 'ホテル', '漫画喫茶', '牛丼']), { bg: '#14141f', fg: c, px: 70 });
      b.collideY(nx, 0.6, nw, 0.2, fy, fy + 0.9);
    }
    if (r() < 0.6) { const c = pickOf(r, NEON); for (const sx of [-1, 1]) b.box(x + sx * (w / 2 - 0.03), gh, 0.03, 0.08, h - gh, 0.08, c, c); }
  }
  // roof
  if (wooden) {
    b.box(x, h, -d / 2, w + 0.5, 0.15, d + 0.5, C.tileD);
    const rh = Math.min(2.0, d * 0.28);
    if (r() < 0.5) b.add(gable(d + 0.8, rh, w + 0.3), pickOf(r, [C.tile, '#5a5f6b', '#6b5a4e']), { at: [x, h + 0.15, -d / 2], roof: true });
    else b.add(hip(w + 0.6, d + 0.8, rh), pickOf(r, [C.tile, '#5a5f6b']), { at: [x, h + 0.15, -d / 2], roof: true });
  } else if (style !== 'tower') {
    b.box(x, h, -d / 2, w + 0.1, 0.5, d + 0.1, style === 'lux' ? '#efe9dc' : shadeHex(body, 0.8));
    b.box(x, h + 0.5, -d / 2, w - 0.3, 0.2, d - 0.3, '#8d939b');
    if (style === 'modern') {
      for (let k = 0; k < Math.floor(w / 1.2); k++) b.box(x - w / 2 + 0.3 + k * 1.2, h + 0.5, -0.15, 0.05, 0.9, 0.05, '#9aa3ad');
      b.box(x, h + 1.35, -0.15, w - 0.4, 0.05, 0.05, '#9aa3ad');
      if (r() < 0.5) { // water tank on stilts
        const tx = x + (r() - 0.5) * (w - 3), tz = -d / 2 - r() * 2;
        for (const [a, c] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) b.box(tx + a, h + 0.5, tz + c, 0.1, 1.4, 0.1, '#6b7280');
        b.add(G.cyl(1.0, 1.0, 1.6, 14), pickOf(r, ['#dfe6ee', '#a8c5da', '#cfd8dc']), { at: [tx, h + 1.9, tz] });
        b.add(G.cone(1.05, 0.3, 14), '#b0bec5', { at: [tx, h + 3.5, tz] });
      }
      if (r() < 0.5) { b.box(x - w / 4, h + 0.5, -d + 2.2, 2.4, 2.4, 2.2, shadeHex(body, 0.9)); b.box(x - w / 4, h + 0.5, -d + 1.05, 0.9, 2.0, 0.05, '#6b7280'); }
      for (let k = 0; k < Math.floor(r() * 3); k++) acUnit(b, x + w / 4 - k * 0.9, h + 0.7, -d / 2 + 1);
      if (r() < 0.25) b.cyl(x + w / 2 - 1, h + 0.5, -d / 2, 0.04, 0.04, 4, '#cccccc', 4);
    }
  }
  if (o.roofSign) {
    b.box(x - 2, h + 0.5, -1.2, 0.12, 2.0, 0.12, C.metalD); b.box(x + 2, h + 0.5, -1.2, 0.12, 2.0, 0.12, C.metalD);
    b.box(x, h + 1.8, -1.25, Math.min(w - 0.5, 7) + 0.3, 2.3, 0.1, '#1b1b22', o.neon ? '#3a2a10' : undefined);
    b.sign(x, h + 2.9, -1.1, Math.min(w - 0.5, 7), 2.0, o.roofSign, { bg: o.verticalColor ?? '#1d3557', fg: '#ffffff', px: 60, border: '#ffd23f' });
  }
  if (o.collide !== false) b.collide(x, -d / 2, w, d, h + 1);
  b.pop();
  return h;
}

export function shadeHex(hex: string, f: number): string { return '#' + new THREE.Color(hex).multiplyScalar(f).getHexString(); }

/** Ground-floor shopfront by shop kind: frame, glass, sign band, noren, lanterns, food display, clutter. */
export function groundFloor(b: Builder, o: BuildingOpts, kind: ShopKind, gh: number, wooden: boolean): void {
  const { x, w, r } = o;
  const def = SHOP[kind];
  const name = o.shop ?? pickOf(r, def.names);
  const bg = o.shopColor ?? def.bg, fg = def.fg;
  const style = o.style;
  const doorX = x + (r() - 0.5) * (w - 3.2) * 0.6;
  // frame
  const frame = wooden ? C.woodD : style === 'lux' ? '#f5f1e8' : '#3a3f4b';
  b.box(x - w / 2 + 0.12, 0, 0.04, 0.24, gh, 0.16, frame); b.box(x + w / 2 - 0.12, 0, 0.04, 0.24, gh, 0.16, frame);
  if (kind === 'konbini') {
    b.box(x, 0.0, 0.02, w - 0.4, gh - 0.8, 0.06, '#eef6ff', '#f2f8ff');
    for (const [k, c] of ['#0a8f4e', '#2a6fdb', '#f77f00'].entries()) b.box(x, gh - 0.8 + k * 0.22, 0.06, w, 0.22, 0.1, c);
    b.sign(x, gh + 0.0, 0.13, Math.min(w - 0.6, 4.5), 0.42, name, { bg: '#ffffff', fg: '#0a8f4e', px: 90 });
    for (let k = 0; k < 4; k++) b.box(x - w / 2 + 1 + k * 1.2, 0.05, -0.9, 0.9, 1.4, 0.5, pickOf(r, ['#ffd166', '#06d6a0', '#ef476f', '#118ab2']));
  } else if (kind === 'pachinko') {
    b.box(x, 0, 0.02, w - 0.4, gh - 0.6, 0.06, '#ffe8a3', '#ffcf5a');
    b.box(x, gh - 0.6, 0.04, w, 1.4, 0.2, '#4a148c');
    b.sign(x, gh + 0.1, 0.16, w - 0.8, 1.0, name, { bg: '#4a148c', fg: '#ffd23f', px: 70, border: '#ff4fd8' });
    for (let k = 0; k < Math.floor(w * 2); k++) b.add(G.sphere(0.06, 6, 4), '#fff3b0', { at: [x - w / 2 + 0.25 + k * 0.5, gh + 0.78, 0.25], glow: k % 2 ? '#ffd23f' : '#ff4fd8' });
  } else if (style === 'lux') {
    // boutique: tall display windows, spot-lit products, gold door frame, dark awning
    b.box(x, 0, 0.02, w - 0.5, gh - 0.5, 0.06, '#e7eef2', '#f6e3c0');
    b.box(doorX, 0, 0.08, 1.9, 2.8, 0.1, C.gold); b.box(doorX, 0, 0.1, 1.6, 2.6, 0.06, '#2a2c33', '#3a3020');
    for (let k = 0; k < 4; k++) {
      const px = x - w / 2 + 0.9 + k * ((w - 1.8) / 3);
      if (Math.abs(px - doorX) < 1.3) continue;
      b.box(px, 0, -0.45, 0.7, 0.35, 0.5, '#f5f1e8');
      if (k % 2) { b.add(G.cyl(0.12, 0.16, 0.9, 8), pickOf(r, ['#8e2c48', '#2d3142', '#c9a227', '#f1faee']), { at: [px, 0.35, -0.45] }); b.sphere(px, 1.4, -0.45, 0.13, '#e9e2d3'); }
      else b.rbox(px, 0.35, -0.45, 0.45, 0.32, 0.22, pickOf(r, ['#c9a227', '#8e2c48', '#1d3557', '#e9c46a']), 0.06);
      b.add(G.cone(0.12, 0.2, 8), '#222', { at: [px, gh - 0.9, -0.3], rot: [Math.PI, 0, 0], glow: '#fff0c8' });
    }
    b.box(x, gh - 0.5, 0.04, w, 0.5, 0.16, '#1f2a24');
    b.sign(x, gh - 0.25, 0.13, Math.min(w - 1, 3.8), 0.38, name, { bg: '#1f2a24', fg: '#d8b24a', px: 100, font: "Georgia, 'Times New Roman', serif" });
    b.box(x, gh - 0.02, 0.05, w, 0.06, 0.14, C.gold);
    if (r() < 0.5) awning(b, doorX, gh - 0.8, 0.12, 2.4, 0.9, pickOf(r, ['#1f2a24', '#3c1f2e', '#1d3557']), pickOf(r, ['#1f2a24', '#3c1f2e', '#1d3557']));
  } else {
    // glazing / shopfront
    const lit = kind === 'izakaya' || kind === 'ramen' || kind === 'souvenir' ? '#c97a30' : '#c9a066';
    b.box(x, 0.3, 0.02, w - 0.5, gh - 0.95, 0.06, wooden ? '#3a2a22' : '#b7d3e3', lit);
    if (wooden) for (let i = 1; i < Math.floor(w / 0.6); i++) b.box(x - w / 2 + i * 0.6, 0.3, 0.06, 0.05, gh - 0.95, 0.05, C.woodD);
    else b.box(x, 1.2, 0.06, w - 0.5, 0.05, 0.05, frame);
    // sign band
    b.box(x, gh - 0.65, 0.04, w, 0.65, 0.14, wooden ? C.woodD : bg);
    b.sign(x, gh - 0.33, 0.12, Math.min(w - 0.5, 4.6), 0.5, name, { bg: wooden ? C.woodD : bg, fg: wooden ? '#f6e3b4' : fg, sub: o.sub, px: 90 });
    // A real door leaf breaks up the display frontage on narrow shops.
    const doorW = Math.min(w * 0.30, 1.31);
    b.box(doorX, 0.03, 0.092, doorW, 2.31, 0.12, wooden ? '#5f4a37' : '#596168');
    b.box(doorX, 0.72, 0.155, doorW - 0.16, 1.38, 0.023, wooden ? '#b7a17a' : '#aec4c2', lit);
    b.box(doorX, 0.065, 0.157, doorW - 0.15, 0.53, 0.031, wooden ? '#85684c' : '#768583');
    b.box(doorX, 1.39, 0.172, doorW - 0.14, 0.04, 0.031, frame);
    b.rbox(doorX + doorW * 0.32, 0.95, 0.194, 0.028, 0.20, 0.04, '#b29869', 0.008);
  }
  // eaves: tiled pent roof (wood) or awning
  if (wooden) {
    b.add(G.box(w + 0.2, 0.1, 1.25), C.tile, { at: [x, gh - 0.05, 0.55], rot: [0.36, 0, 0], roof: true });
    b.collideY(x, 0.6, w, 1.25, gh - 0.4, gh + 0.4);
  } else if (o.awning || kind === 'kissaten' || kind === 'florist' || kind === 'grocer') {
    const ac = o.awning ?? (kind === 'kissaten' ? '#7a4a2a' : kind === 'florist' ? '#2f5d50' : '#e76f51');
    awning(b, x, gh - 0.75, 0.05, w - 0.4, 1.1, ac);
  }
  // per-kind dressing at the door
  const nr = def.noren ?? (wooden ? pickOf(r, ['#24345c', '#7a1f1f', '#2f5d50', '#5b3a7a']) : undefined);
  if (nr && kind !== 'konbini' && kind !== 'pachinko') noren(b, doorX, gh - 0.75, 0.14, Math.min(1.8, w * 0.35), nr, name.slice(0, 1));
  if (kind === 'izakaya' || (wooden && r() < 0.4)) { lantern(b, doorX - 1.15, 1.75, 0.35, C.red, 0.9); lantern(b, doorX + 1.15, 1.75, 0.35, C.red, 0.9); b.pool(doorX, 0.9, 2.6, '#ff9a5a'); }
  if (kind === 'ramen' || kind === 'soba' || kind === 'izakaya' || kind === 'kissaten') foodDisplay(b, doorX + (doorX > x ? -1.9 : 1.9), 0.3, r, kind);
  if (kind === 'karaoke') b.sign(x + w / 2 - 0.5, gh + 2.6, 0.5, 0.9, 4.2, name, { bg: '#ff006e', fg: '#fff', vertical: true, px: 60, border: '#ffe066' });
  if (kind === 'salon') for (let k = 0; k < 6; k++) b.add(G.cyl(0.11, 0.11, 0.18, 10), k % 3 === 0 ? '#e63946' : k % 3 === 1 ? '#ffffff' : '#1d4e89', { at: [doorX + 1.0, 1.1 + k * 0.18, 0.3], glow: '#552222' });
  if (kind === 'realestate') for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) b.box(x - w / 2 + 0.8 + i * 0.55, 0.6 + j * 0.65, 0.07, 0.45, 0.55, 0.01, '#ffffff');
  if (o.clutter !== false) shopClutter(b, x, w, doorX, kind, r);
}

/** Glass case of plastic food samples (shokuhin sampuru). */
function foodDisplay(b: Builder, x: number, z: number, r: () => number, kind: ShopKind): void {
  const mat = kind === 'kissaten' ? '#554136' : '#735a46';
  b.rbox(x, 0, z, 1.1, 0.73, 0.45, mat, 0.03);
  b.box(x, 0.11, z + 0.224, 1.06, 0.16, 0.021, '#82755b');
  b.box(x, 0.72, z, 1.09, 0.026, 0.45, '#aea496');
  b.box(x, 1.20, z, 1.11, 0.046, 0.46, mat);
  for (const dx of [-0.528, 0.528]) for (const dz of [-0.209, 0.209]) b.box(x + dx, 0.737, z + dz, 0.027, 0.47, 0.027, '#817662');
  b.add(G.box(1.04, 0.442, 0.41), '#d9e8e0', { at: [x, 0.747, z], glass: true });
  for (let i = 0; i < 3; i++) {
    const fx = x - 0.35 + i * 0.35;
    if (kind === 'kissaten') {
      const cake = pickOf(r, ['#e5c180', '#eee3c8', '#b87961']);
      b.cyl(fx, 0.751, z, 0.108, 0.087, 0.014, '#d5d1bb', 14);
      b.rbox(fx, 0.769, z, 0.142, 0.081, 0.122, cake, 0.018);
      b.box(fx, 0.812, z + 0.064, 0.122, 0.015, 0.014, '#e4cfab');
      b.sphere(fx + 0.013, 0.856, z + 0.008, 0.017, '#a85043');
    } else {
      const glaze = pickOf(r, ['#a75143', '#4b5452', '#d6c8ac']);
      const broth = pickOf(r, ['#bc9357', '#c4a171', '#986c48', '#daaa55']);
      b.cyl(fx, 0.75, z, 0.121, 0.058, 0.096, glaze, 14);
      b.cyl(fx, 0.839, z, 0.102, 0.091, 0.008, broth, 14);
      b.add(G.sphere(0.034), '#e2d09e', { at: [fx + 0.036, 0.851, z - 0.014], scale: [1, 0.19, 0.69] });
      b.add(G.sphere(0.014), '#c9a251', { at: [fx + 0.037, 0.860, z - 0.012], scale: [1, 0.23, 0.89] });
      for (const dx of [-0.034, -0.014, 0.009]) b.sphere(fx + dx, 0.848, z + 0.033, 0.010, '#75915d');
    }
  }
  b.collide(x, z, 1.1, 0.45, 1.25, false);
}

/** Doorstep clutter: plant pots, bikes, crates, A-frame boards, vending machines. */
function shopClutter(b: Builder, x: number, w: number, doorX: number, kind: ShopKind, r: () => number): void {
  const spots: number[] = [];
  for (let s = x - w / 2 + 0.6; s < x + w / 2 - 0.5; s += 0.9) if (Math.abs(s - doorX) > 1.2) spots.push(s);
  for (const s of spots) {
    const roll = r();
    const z = 0.4;
    if (kind === 'florist' && roll < 0.8) { b.cyl(s, 0, z, 0.2, 0.16, 0.35, '#5c6b7a', 8); for (let k = 0; k < 5; k++) b.sphere(s + (r() - 0.5) * 0.3, 0.5 + r() * 0.2, z + (r() - 0.5) * 0.2, 0.08, pickOf(r, ['#ff7aa8', '#ffd23f', '#ffffff', '#e63946', '#c77dff'])); continue; }
    if (kind === 'grocer' && roll < 0.8) { b.box(s, 0, z, 0.8, 0.55, 0.5, '#c08552'); for (let k = 0; k < 6; k++) b.sphere(s - 0.25 + (k % 3) * 0.25, 0.62, z - 0.1 + Math.floor(k / 3) * 0.2, 0.1, pickOf(r, ['#e63946', '#f77f00', '#8ac926', '#ffd23f'])); continue; }
    if (kind === 'pharmacy' && roll < 0.8) { for (let k = 0; k < 3; k++) b.box(s, k * 0.35, z, 0.7, 0.33, 0.45, pickOf(r, ['#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#ffffff'])); continue; }
    if (kind === 'books' && roll < 0.7) { b.box(s, 0, z, 0.8, 0.8, 0.45, C.woodL); for (let k = 0; k < 8; k++) b.box(s - 0.32 + k * 0.09, 0.8, z, 0.07, 0.25, 0.3, pickOf(r, ['#e63946', '#1d3557', '#f1faee', '#a8dadc', '#ffbe0b'])); continue; }
    if (roll < 0.16) { for (let k = 0; k < 3; k++) b.add(G.cyl(0.13, 0.1, 0.25, 8), pickOf(r, ['#b9764e', '#6c757d', '#8d99ae']), { at: [s - 0.25 + k * 0.25, 0, z] }), b.add(G.ico(0.17, 0), pickOf(r, C.greens), { at: [s - 0.25 + k * 0.25, 0.38, z] }); }
    else if (roll < 0.24) { b.add(G.box(0.5, 0.8, 0.04), '#2b2b2b', { at: [s, 0, z], rot: [0.2, 0, 0] }); b.sign(s, 0.5, z + 0.1, 0.42, 0.55, pickOf(r, ['本日', 'ランチ', '営業中', 'OPEN', '定食']), { bg: '#2b2b2b', fg: '#ffffff', px: 80 }); }
    else if (roll < 0.3) bike(b, s, z + 0.1, (r() - 0.5) * 0.4, pickOf(r, ['#3a86ff', '#ff006e', '#8ac926', '#ffbe0b', '#e8e8e8']));
    else if (roll < 0.34) { vending(b, s, z, 0, pickOf(r, ['#e94e3c', '#2a6fdb', '#ffffff', '#0a8f4e'])); }
    else if (roll < 0.4) bin(b, s, z);
    else if (roll < 0.44) crates(b, s, z, 2, r);
  }
}

/** Fill a frontage (local x range) with buildings: setbacks, narrow gaps, varied heights and shop types. */
export function frontage(b: Builder, x0: number, x1: number, reserved: [number, number][], style: Style, r: () => number, shops: string[], colors: string[], opts: Partial<BuildingOpts> & { minF?: number; maxF?: number; depth?: number; kinds?: ShopKind[]; mixModern?: number } = {}): void {
  const res = [...reserved].sort((a, c) => a[0] - c[0]);
  const gaps: [number, number][] = [];
  let cur = x0;
  for (const [a, c] of res) { if (a > cur) gaps.push([cur, a]); cur = Math.max(cur, c); }
  if (cur < x1) gaps.push([cur, x1]);
  const kinds = opts.kinds ?? (['generic'] as ShopKind[]);
  for (const [a, c] of gaps) {
    let x = a;
    while (c - x > 0.5) {
      let w = (style === 'wood' ? 4.5 : 5.5) + r() * 5;
      if (c - x - w < 3.5) w = c - x;
      // occasional narrow dark gap between buildings
      const gap = w > 5 && r() < 0.3 ? 0.35 : 0;
      if (gap) { b.box(x + w - gap / 2, 0, -1.6, gap, 6, 0.2, '#2a2b30'); b.collide(x + w - gap / 2, -0.8, gap + 0.05, 1.6, 6); }
      const bw = w - gap;
      const modern = style === 'wood' && r() < (opts.mixModern ?? 0.35);
      const st: Style = modern ? 'modern' : style;
      const minF = modern ? 3 : opts.minF ?? 2, maxF = modern ? 5 : opts.maxF ?? 3;
      const floors = minF + Math.floor(r() * (maxF - minF + 1));
      const kind = pickOf(r, kinds);
      const pal = modern ? TILE_COLS : colors;
      building(b, {
        x: x + bw / 2, w: bw, d: opts.depth ?? 10 + r() * 4, floors, style: st, r, color: pickOf(r, pal),
        kind, shop: shops.length && r() < 0.3 ? pickOf(r, shops) : undefined, setback: r() < 0.35 ? r() * 0.5 : 0,
        awning: st === 'modern' && r() < 0.3 ? pickOf(r, ['#e63946', '#2a9d8f', '#f4a261', '#264653']) : undefined,
        roofSign: st === 'modern' && floors >= 5 && r() < (opts.neon ? 0.45 : 0.25) ? pickOf(r, ['寿司', 'カラオケ', 'SALE', 'ビール', '英会話', '質屋', 'ゲーム']) : undefined,
        verticalColor: pickOf(r, ['#c1121f', '#7b2cbf', '#0077b6', '#2b9348', '#ff006e']),
        sideWindows: style !== 'wood',
        ...opts,
      });
      x += w;
    }
  }
}

/** Sky-filling background towers on a line (local), no colliders needed if behind walls. */
export function skyline(b: Builder, x0: number, x1: number, z: number, r: () => number, minH: number, maxH: number, palette: string[]): void {
  let x = x0;
  while (x < x1) {
    const w = 8 + r() * 10, d = 8 + r() * 10, h = minH + r() * (maxH - minH);
    const col = palette[Math.floor(r() * palette.length)];
    b.box(x + w / 2, 0, z - d / 2, w, h, d, col);
    const floors = Math.floor(h / 3.6);
    for (let f = 1; f < floors; f++) b.box(x + w / 2, f * 3.6, z + 0.02, w - 0.6, 1.6, 0.05, '#7f9fb8', LIT(r, 0.45));
    if (r() < 0.3) b.box(x + w / 2, h, z - d / 2, 0.15, 4, 0.15, '#ddd');
    x += w + r() * 2;
  }
}

/** A cluster of vending machines with recycling bins — a fixture of every Tokyo corner. */
export function vendingCluster(b: Builder, x: number, z: number, ry: number, n: number, r: () => number): void {
  b.push(x, 0, z, ry);
  for (let i = 0; i < n; i++) vending(b, -((n - 1) * 0.52) + i * 1.04, 0, 0, pickOf(r, ['#e94e3c', '#2a6fdb', '#ffffff', '#0a8f4e', '#f4a261', '#1d1d1d']));
  for (let i = 0; i < 2; i++) { b.cyl((n * 0.52) + 0.25 + i * 0.42, 0, 0.1, 0.18, 0.18, 0.85, i ? '#2a6fdb' : '#f1faee', 10); b.cyl((n * 0.52) + 0.25 + i * 0.42, 0.85, 0.1, 0.19, 0.19, 0.05, '#555', 10); }
  b.collide(0.3, -0.35, n * 1.04 + 1.0, 1.5, 1.9, true); // extends behind to the wall: no wedge gap
  b.pop();
}

/** Manhole cover decal: painted emblem (sakura / wave / city kanji). */
export function manhole(b: Builder, x: number, z: number, motif: 'sakura' | 'wave' | 'kanji' = 'sakura'): void {
  if (!b.atlas) return;
  const key = 'mh-' + motif;
  const at = b.atlas as unknown as Record<string, [number, number, number, number]>;
  at[key] ??= b.atlas.custom(128, 128, (c, x0, y0) => {
    const cx = x0 + 64, cy = y0 + 64;
    c.fillStyle = '#5b5e66'; c.beginPath(); c.arc(cx, cy, 63, 0, 7); c.fill();
    c.strokeStyle = '#3a3c42'; c.lineWidth = 6; c.beginPath(); c.arc(cx, cy, 58, 0, 7); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, 46, 0, 7); c.stroke();
    c.fillStyle = '#7a7e88';
    if (motif === 'sakura') for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; c.beginPath(); c.ellipse(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20, 16, 10, a, 0, 7); c.fill(); }
    else if (motif === 'wave') for (let k = 0; k < 4; k++) { c.beginPath(); c.arc(cx - 30 + k * 20, cy + 10, 16, Math.PI, 0); c.stroke(); c.lineWidth = 5; }
    else { c.font = `700 52px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('下水', cx, cy); }
    c.fillStyle = '#4a4d55'; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; c.fillRect(cx + Math.cos(a) * 52 - 2, cy + Math.sin(a) * 52 - 2, 4, 4); }
  });
  b.decal(x, z, 0.9, 0.9, at[key], 0.028, true);
}

/** Yellow tactile guide strip (ribbed) along local x from x0 to x1 at z. */
export function tactile(b: Builder, x0: number, x1: number, z: number, dots = false): void {
  if (!b.atlas) return;
  const at = b.atlas as unknown as Record<string, [number, number, number, number]>;
  const key = dots ? 'tac-dot' : 'tac-line';
  at[key] ??= b.atlas.custom(64, 64, (c, x, y) => {
    c.fillStyle = '#e8b923'; c.fillRect(x, y, 64, 64);
    c.fillStyle = '#c99a10';
    if (dots) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { c.beginPath(); c.arc(x + 8 + i * 16, y + 8 + j * 16, 5, 0, 7); c.fill(); }
    else for (let i = 0; i < 4; i++) c.fillRect(x + 6 + i * 16, y + 2, 5, 60);
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x, y, 64, 2); c.fillRect(x, y, 2, 64);
  });
  for (let x = x0; x < x1 - 0.01; x += 0.32) b.decal(x + 0.16, z, 0.32, 0.32, at[key], 0.03);
}

/** Distant city: a ring of low-detail buildings outside the playable area so the horizon is never a void. */
export function farField(b: Builder, skip: { x0: number; x1: number; z0: number; z1: number }[], style: Style, r: () => number): void {
  const R = 215;
  for (let gx = -R; gx < R; gx += 15) for (let gz = -R; gz < R; gz += 15) {
    const x = gx + r() * 4, z = gz + r() * 4;
    if (skip.some((p) => x > p.x0 - 7 && x < p.x1 + 7 && z > p.z0 - 7 && z < p.z1 + 7)) continue;
    if (Math.hypot(x, z) > R) continue;
    const w = 9 + r() * 5, d = 9 + r() * 5;
    const far = Math.min(1, Math.hypot(x, z) / R);
    const wood = style === 'wood' && r() < 0.8;
    const h = wood ? 5 + r() * 6 : style === 'wood' ? 10 + r() * 14 : style === 'lux' ? 12 + r() * 22 : 14 + r() * (30 + far * 55);
    const col = wood ? pickOf(r, ['#d8c8aa', '#cdb995', '#e3d6bd', '#b9a684']) : pickOf(r, ['#a9b2bd', '#c4c9cf', '#8e98a5', '#d2cbc0', '#b7aea2', '#7d8a99']);
    b.add(G.bbox(w, h, d, 0.12), col, { at: [x, 0, z] });
    if (!wood) b.add(G.bbox(w + 0.2, 0.3, d + 0.2, 0.06), shadeHex(col, 1.08), { at: [x, h, z] }); // coping line reads at distance
    // lit windows on the two faces looking toward the play area
    const fx = -Math.sign(x), fz = -Math.sign(z);
    for (let f = 0; f * 3.4 + 2.2 < h - 1; f++) {
      const y = f * 3.4 + 1.6;
      const wc = wood ? '#e8d9b8' : '#9fb4c6';
      b.add(G.plane(w - 1.2, 1.3), wc, { at: [x, y + 0.65, z + fz * (d / 2 + 0.03)], rot: [0, fz < 0 ? Math.PI : 0, 0], glow: r() < 0.45 ? pickOf(r, ['#e8a04a', '#f0c070', '#cfe3ff']) : '#000000' });
      b.add(G.plane(d - 1.2, 1.3), wc, { at: [x + fx * (w / 2 + 0.03), y + 0.65, z], rot: [0, fx * Math.PI / 2, 0], glow: r() < 0.4 ? pickOf(r, ['#e8a04a', '#f0c070']) : '#000000' });
    }
    if (wood) b.add(r() < 0.5 ? hip(w + 1, d + 1, 2.2) : gable(d + 1, 2.0, w + 0.6), pickOf(r, [C.tile, '#5a5f6b', '#6b5a4e', '#4a5568']), { at: [x, h, z], roof: true });
    else if (r() < 0.5) { b.box(x + (r() - 0.5) * 3, h, z + (r() - 0.5) * 3, 2.5, 2.2, 2.5, shadeHex(col, 0.85)); if (r() < 0.3) b.add(G.cyl(0.9, 0.9, 1.4, 10), '#cfd8dc', { at: [x - 2, h, z + 2] }); }
    if (!wood && h > 45 && r() < 0.5) b.add(G.sphere(0.35, 6, 4), '#ff3b3b', { at: [x, h + 0.4, z], glow: '#ff2020' });
  }
}

/** Tall lattice broadcast tower (original design) with two lit observation decks. */
export function broadcastTower(b: Builder, x: number, z: number, H = 150): void {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.add(G.cyl(0.6, 1.6, H * 0.62, 6), '#e9eef3', { at: [x + Math.cos(a) * 4, 0, z + Math.sin(a) * 4], rot: [Math.sin(a) * 0.05, 0, -Math.cos(a) * 0.05] });
  }
  b.add(G.cyl(2.2, 3.4, H * 0.62, 12), '#dfe6ee', { at: [x, 0, z] });
  for (let k = 1; k < 9; k++) b.add(G.cyl(3.6 - k * 0.18, 3.6 - k * 0.18, 0.4, 12), '#c9d2dc', { at: [x, k * H * 0.07, z] });
  for (const [y, rr] of [[H * 0.48, 6.5], [H * 0.66, 4.2]] as const) {
    b.add(G.cyl(rr, rr * 0.9, 4, 18), '#f4f7fa', { at: [x, y, z] });
    b.add(G.cyl(rr + 0.05, rr + 0.05, 1.4, 18), '#9fc1dc', { at: [x, y + 1.3, z], glow: '#9fd0ff' });
  }
  b.add(G.cyl(1.6, 2.2, H * 0.3, 10), '#e9eef3', { at: [x, H * 0.62, z] });
  b.add(G.cyl(0.25, 0.6, H * 0.12, 6), '#dfe6ee', { at: [x, H * 0.92, z] });
  b.add(G.sphere(0.6, 6, 4), '#ff3b3b', { at: [x, H * 1.04, z], glow: '#ff2020' });
}

// ---------------------------------------------------------------- street furniture (instanced where repeated)
const PP = {
  bollard: () => proto('bollard', (b) => {
    b.add(G.cyl(0.07, 0.08, 0.82, 12), '#ffffff', { at: [0, 0, 0] });
    b.add(G.sphere(0.07, 12, 6), '#ffffff', { at: [0, 0.82, 0], scale: [1, 0.5, 1] });
    b.add(G.cyl(0.075, 0.075, 0.07, 12), '#e8b923', { at: [0, 0.62, 0], glow: '#ffd23f' });
    b.add(G.cyl(0.11, 0.11, 0.03, 12), '#6b7076', { at: [0, 0, 0] });
  }, { shadow: true, tint: 'body' }),
  bike: () => proto('bicycle', (b) => {
    for (const dx of [-0.5, 0.5]) { b.add(new THREE.TorusGeometry(0.31, 0.03, 6, 18), '#26272b', { at: [dx, 0.33, 0] }); b.add(G.cyl(0.04, 0.04, 0.06, 8), '#9aa0a6', { at: [dx, 0.33, -0.03], rot: [Math.PI / 2, 0, 0] }); }
    b.add(G.cyl(0.022, 0.022, 0.62, 6), '#ffffff', { at: [-0.25, 0.33, 0], rot: [0, 0, -0.95] }); // seat tube stays
    b.add(G.cyl(0.022, 0.022, 0.62, 6), '#ffffff', { at: [0.02, 0.36, 0], rot: [0, 0, -1.45] }); // down tube (step-through mamachari)
    b.add(G.cyl(0.022, 0.022, 0.55, 6), '#ffffff', { at: [-0.18, 0.36, 0], rot: [0, 0, 0.22] });
    b.add(G.cyl(0.022, 0.022, 0.62, 6), '#ffffff', { at: [0.5, 0.33, 0], rot: [0, 0, 0.3] }); // fork + stem
    b.add(G.bbox(0.24, 0.06, 0.12, 0.02), '#26272b', { at: [-0.27, 0.88, 0] });
    b.box(0.32, 0.96, 0, 0.03, 0.03, 0.56, '#9aa0a6');
    b.add(G.bbox(0.3, 0.22, 0.34, 0.02), '#b9bec3', { at: [0.62, 0.62, 0] }); // basket
    b.box(-0.5, 0.66, 0, 0.32, 0.02, 0.16, '#9aa0a6'); // rear carrier
    b.add(G.bbox(0.07, 0.07, 0.06, 0.015), '#fff6d8', { at: [0.53, 0.78, 0], glow: '#ffffff' });
  }, { shadow: true, tint: 'body' }),
  railPost: () => proto('guardrail-post', (b) => {
    b.add(G.cyl(0.045, 0.045, 0.85, 8), '#ffffff', { at: [0, 0, 0] });
    b.add(G.sphere(0.05, 8, 4), '#ffffff', { at: [0, 0.85, 0], scale: [1, 0.5, 1] });
  }, { shadow: true, tint: 'body' }),
};
const BIKE_COLS = ['#d9dcdf', '#3e5f8a', '#a33b3b', '#e4ddcf', '#2f4f46', '#c9a227', '#6b6f75', '#efe9df'];

/** Bicycle rack against a wall or kerb: a low rail along local x with bikes parked nose-in (bikes face local +z). */
export function bikeRack(b: Builder, x: number, z: number, n: number, ry = 0, r: () => number = Math.random): void {
  b.push(x, 0, z, ry);
  const L = n * 0.62;
  b.add(G.bbox(L + 0.3, 0.05, 0.12, 0.015), '#8d9298', { at: [0, 0.3, 0.1] });
  for (const sx of [-1, 1]) b.box(sx * (L / 2 + 0.1), 0, 0.1, 0.05, 0.32, 0.05, '#8d9298');
  b.box(0, 0.002, 0.45, L + 0.6, 0.006, 1.9, '#c9c5bc');
  for (let i = 0; i < n; i++) {
    if (r() < 0.18) continue;
    b.inst(PP.bike(), -L / 2 + 0.31 + i * 0.62, 0, 0.55 + (r() - 0.5) * 0.12, { ry: Math.PI / 2 + (r() - 0.5) * 0.12, color: pickOf(r, BIKE_COLS) });
  }
  b.collide(0, 0.55, L + 0.4, 1.9, 1.0, false);
  b.pop();
}

/** Bollards along local x (instanced). */
export function bollards(b: Builder, x0: number, x1: number, z: number, step = 1.2): void {
  for (let x = x0; x <= x1 + 1e-3; x += step) { b.inst(PP.bollard(), x, 0, z, { color: '#4d5157' }); b.collide(x, z, 0.18, 0.18, 0.85, false); }
}

/** White steel guard rail along local x from x0 to x1 at z: posts every 2 m, two pipe rails (visual only, no collider). */
export function guardRail(b: Builder, x0: number, x1: number, z: number): void {
  const L = x1 - x0;
  if (L < 1) return;
  for (let x = x0; x <= x1 + 1e-3; x += 2) b.inst(PP.railPost(), x, 0, z, { color: '#eef0f0' });
  for (const y of [0.42, 0.78]) b.add(G.cyl(0.03, 0.03, L, 8), '#eef0f0', { at: [x0, y, z], rot: [0, 0, -Math.PI / 2], vary: 0 });
}

/** Street sign on a pole: round regulatory disc (atlas-painted) plus an optional blue street-name plate. */
export function streetSign(b: Builder, x: number, z: number, ry: number, kind: 'noParking' | 'crossing' | 'oneWay' | 'slow', plate?: string): void {
  if (!b.atlas) return;
  const at = b.atlas as unknown as Record<string, [number, number, number, number]>;
  const key = 'rs-' + kind;
  at[key] ??= b.atlas.custom(128, 128, (c, x0, y0) => {
    const cx = x0 + 64, cy = y0 + 64;
    c.fillStyle = '#e9ecef'; c.fillRect(x0, y0, 128, 128);
    if (kind === 'crossing') {
      c.fillStyle = '#1f5fbf'; c.fillRect(x0 + 6, y0 + 6, 116, 116);
      c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(cx, y0 + 18); c.lineTo(x0 + 112, y0 + 104); c.lineTo(x0 + 16, y0 + 104); c.closePath(); c.fill();
      c.fillStyle = '#1d1d1d'; c.beginPath(); c.arc(cx + 2, y0 + 50, 7, 0, 7); c.fill(); c.fillRect(cx - 4, y0 + 58, 9, 22); c.fillRect(cx - 14, y0 + 92, 30, 4);
      for (let i = 0; i < 4; i++) c.fillRect(x0 + 34 + i * 16, y0 + 96, 9, 4);
      return;
    }
    if (kind === 'slow') {
      c.fillStyle = '#ffffff'; c.beginPath(); c.moveTo(x0 + 6, y0 + 14); c.lineTo(x0 + 122, y0 + 14); c.lineTo(cx, y0 + 122); c.closePath(); c.fill();
      c.strokeStyle = '#d62828'; c.lineWidth = 10; c.stroke();
      c.fillStyle = '#1f5fbf'; c.font = '700 26px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('徐行', cx, y0 + 48);
      return;
    }
    c.fillStyle = kind === 'oneWay' ? '#1f5fbf' : '#1f5fbf'; c.beginPath(); c.arc(cx, cy, 60, 0, 7); c.fill();
    if (kind === 'noParking') { c.strokeStyle = '#d62828'; c.lineWidth = 12; c.beginPath(); c.arc(cx, cy, 54, 0, 7); c.stroke(); c.beginPath(); c.moveTo(cx - 38, cy - 38); c.lineTo(cx + 38, cy + 38); c.stroke(); }
    else { c.fillStyle = '#ffffff'; c.fillRect(cx - 34, cy - 8, 50, 16); c.beginPath(); c.moveTo(cx + 40, cy); c.lineTo(cx + 12, cy - 24); c.lineTo(cx + 12, cy + 24); c.closePath(); c.fill(); }
  });
  b.push(x, 0, z, ry);
  b.add(G.cyl(0.035, 0.04, 2.9, 8), '#b9bec3', { at: [0, 0, 0] });
  b.add(G.cyl(0.3, 0.3, 0.02, 20), '#9aa0a6', { at: [0, 2.6, -0.02], rot: [Math.PI / 2, 0, 0] });
  b.panel(0, 2.6, 0.0, 0.58, 0.58, at[key]);
  if (plate) {
    b.box(0, 1.95, 0.0, 0.9, 0.3, 0.02, '#1f4f99');
    b.sign(0, 2.1, 0.015, 0.86, 0.26, plate, { bg: '#1f4f99', fg: '#ffffff', px: 120 });
  }
  b.collide(0, 0, 0.12, 0.12, 2.9, false);
  b.pop();
}

/** Bus stop: slim shelter with a glass roof, bench, lit advert panel and the round timetable sign. Faces local +z (the road). */
export function busStop(b: Builder, x: number, z: number, ry: number, name: string): void {
  b.push(x, 0, z, ry);
  for (const sx of [-1.6, 1.6]) b.add(G.bbox(0.1, 2.5, 0.1, 0.02), '#5c6168', { at: [sx, 0, -0.55] });
  b.add(G.bbox(3.6, 0.08, 1.5, 0.02), '#5c6168', { at: [0, 2.5, -0.2] });
  b.add(G.box(3.4, 0.03, 1.36), '#cfe0ea', { at: [0, 2.585, -0.2], glass: true });
  b.add(G.box(3.2, 1.9, 0.03), '#d9e6ee', { at: [0, 0.35, -0.6], glass: true });
  b.add(G.bbox(2.2, 0.06, 0.4, 0.02), '#b08a63', { at: [-0.4, 0.45, -0.35] });
  for (const sx of [-1.3, 0.5]) b.box(sx, 0, -0.35, 0.05, 0.45, 0.3, '#5c6168');
  b.add(G.bbox(1.0, 1.7, 0.16, 0.03), '#3b3e44', { at: [1.15, 0.3, -0.62] });
  b.box(1.15, 0.38, -0.53, 0.86, 1.54, 0.02, '#f1ece2', '#e8eef8');
  b.sign(1.15, 1.15, -0.515, 0.8, 1.4, name, { bg: '#f1ece2', fg: '#2f4858', px: 64, sub: 'BUS' });
  b.collide(0, -0.45, 3.4, 0.4, 2.5, false);
  b.pop();
  b.push(x, 0, z, ry);
  b.add(G.cyl(0.04, 0.05, 2.4, 8), '#b9bec3', { at: [-2.2, 0, 0.1] });
  b.add(G.cyl(0.28, 0.28, 0.06, 20), '#1f5fbf', { at: [-2.2, 2.3, 0.1], rot: [Math.PI / 2, 0, 0] });
  b.sign(-2.2, 2.3, 0.14, 0.42, 0.24, 'バス', { bg: '#1f5fbf', fg: '#ffffff', px: 120 });
  b.box(-2.2, 1.2, 0.08, 0.36, 0.6, 0.06, '#e9ecef');
  b.collide(-2.2, 0.1, 0.15, 0.15, 2.4, false);
  b.pop();
}
