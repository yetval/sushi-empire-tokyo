// Procedural people: properly proportioned figures (~7.5 heads, 1.72 m), like the scale figures in an
// architect's model, but fully modelled: neck, shaped torso, shoulders, upper/lower arms with elbows, hands,
// thighs/shins with knees, shoes, hair meshes and tailored clothing (suits, coats, aprons, skirts, bags).
// Every person is ONE skinned, vertex-coloured mesh (1 draw call + 1 shadow call) with 12 rigid bones,
// built in model space (feet on y = 0, facing +z). A low-poly LOD is built lazily for distant figures.
import * as THREE from 'three';
import { Avatar } from '../core/state';
import { VC_MAT, at, merge, paint, shade } from './geo';

export type Anim = 'idle' | 'walk' | 'run' | 'jump' | 'cook' | 'carry' | 'sit' | 'wave' | 'eat' | 'interact' | 'cheer' | 'angry' | 'photo' | 'phone' | 'sip' | 'vending';

export interface Outfit {
  apron?: boolean | string;
  tie?: string; bag?: string; vest?: string; trim?: string;
  /** coat = chef whites / work coat, blazer = suit jacket, workwear = zip jacket / school jacket, knit = sweater, longcoat = knee-length overcoat */
  cut?: 'coat' | 'blazer' | 'workwear' | 'knit' | 'longcoat';
  skirt?: string; // skirt colour (replaces trousers; legs show tights)
  glasses?: 'round' | 'square';
  detail?: 'freckles' | 'stubble' | 'moustache' | 'earrings';
  /** child proportions: larger head, shorter legs (combine with a small Character scale) */
  child?: boolean;
}

/** Hair style names for 0..8 (UI can show these). */
export const HAIR_STYLE_NAMES = ['Short', 'Messy', 'Long', 'Bun', 'Bald', 'Bob', 'Ponytail', 'Twin tails', 'Side part'];
export const FACE_STYLE_NAMES = ['Soft', 'Long', 'Square', 'Tapered', 'Round'];
export const UNIFORM_STYLE_NAMES = ['Indigo apron', 'Brick apron', 'Canvas apron'];
const UNIFORMS = ['#344654', '#803c36', '#cbb386'];

const MAT = VC_MAT;

// ---------------------------------------------------------------- skeleton (model space, metres)
const HIP = 0.92; // pelvis pivot; feet rest exactly on y = 0
const KNEE = 0.49;
const SHO_X = 0.17, SHO_Y = 1.41;
const ELB_Y = 1.13;
const NECK = 1.465;
const HEAD_C = 1.615; // centre of the skull
const EYE_Y = HEAD_C + 0.008;
const LEG_X = 0.088;
const SIT_DROP = 0.42; // seated, the pelvis rests on a ~0.45 m stool

/** Bones (rigid skinning: every vertex follows exactly one bone). Bind pose has no rotation. */
const enum B { Body, Chest, Head, Eyes, ArmL, ArmR, LegL, LegR, KneeL, KneeR, ElbowL, ElbowR }
const BIND: [number, number, number][] = [ // model-space bind position of each bone
  [0, HIP, 0], [0, 1.04, 0], [0, NECK, 0], [0, EYE_Y, 0.08],
  [-SHO_X, SHO_Y, 0], [SHO_X, SHO_Y, 0], [-LEG_X, HIP, 0], [LEG_X, HIP, 0],
  [-LEG_X, KNEE, 0.004], [LEG_X, KNEE, 0.004], [-SHO_X - 0.012, ELB_Y, -0.01], [SHO_X + 0.012, ELB_Y, -0.01],
];
const PARENT = [-1, B.Body, B.Chest, B.Head, B.Chest, B.Chest, B.Body, B.Body, B.LegL, B.LegR, B.ArmL, B.ArmR];

// Segment counts scale with the LOD being built (Q = 1 near, 0.5 far); FAR also drops tiny details.
let Q = 1, FAR = false;
const sg = (n: number, min = 3) => Math.max(min, Math.round(n * Q));
const sphere = (r: number, w = 12, h = 8) => new THREE.SphereGeometry(r, sg(w), sg(h, 2));
const capsule = (r: number, len: number, cap = 3, rad = 10) => new THREE.CapsuleGeometry(r, len, Math.max(1, Math.round(cap * Q)), sg(rad));
const cyl = (rt: number, rb: number, h: number, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, sg(seg));
const torus = (r: number, t: number, arc = Math.PI * 2, seg = 16) => new THREE.TorusGeometry(r, t, sg(5), sg(seg), arc);
/** Lathe of [radius, y] points listed bottom → top (outward normals); optional arc for open garments. */
const lathe = (pts: [number, number][], seg = 14, phi0 = 0, phiLen = Math.PI * 2) =>
  new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)), sg(seg, 5), phi0, phiLen);
/** Same lathe, faces flipped: the lining of an open garment (seen through the opening). */
const lining = (pts: [number, number][], seg = 14, phi0 = 0, phiLen = Math.PI * 2) =>
  lathe(pts.map(([r, y]) => [r - 0.004, y] as [number, number]).reverse(), seg, phi0, phiLen);
/** A rounded slab between two points in the xz-plane is overkill here: rounded boxes are capsules squashed. */
const pill = (w: number, h: number, d: number) => {
  const r = Math.min(w, d) / 2;
  return at(capsule(r, Math.max(0.001, h - 2 * r), 2, 10), 0, 0, 0, 0, 0, 0, w / (2 * r), 1, d / (2 * r));
};

/** A flat garment panel (lapel, tie, apron bib), extruded a hair thick with a soft bevel, facing +z at depth z. */
function panel(points: [number, number][], z: number, color: string, depth = 0.006): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
  shape.closePath();
  return paint(at(new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: !FAR, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1, curveSegments: 2,
  }), 0, 0, z), color);
}

// ---------------------------------------------------------------- personality
const FACE = [
  { width: 1, jaw: 0.86, chin: 0, nose: 1, height: 1 },
  { width: 0.94, jaw: 0.82, chin: 0.006, nose: 1.15, height: 1.05 },
  { width: 1.04, jaw: 0.97, chin: -0.002, nose: 1.05, height: 0.98 },
  { width: 0.97, jaw: 0.74, chin: 0.01, nose: 0.9, height: 1.01 },
  { width: 1.06, jaw: 0.92, chin: -0.004, nose: 0.92, height: 0.95 },
] as const;

interface Persona { face: typeof FACE[number]; shoe: string; sole: string; build: number }

function persona(a: Avatar): Persona {
  let h = 2166136261;
  for (const ch of a.skin + a.hair + a.shirt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const o = h >>> 0;
  const shoes: [string, string][] = [['#3b2c24', '#211915'], ['#26262b', '#151517'], ['#ece8df', '#b9b3a8'], ['#6d4a33', '#2b1d15'], ['#43454d', '#1d1e22']];
  const s = shoes[o % shoes.length];
  return { face: FACE[a.faceStyle ?? 0] ?? FACE[0], shoe: s[0], sole: s[1], build: 0.95 + ((o >>> 8) % 100) / 1000 };
}

type Part = [THREE.BufferGeometry, B];

// ---------------------------------------------------------------- head (model space)
function skull(skin: string, p: Persona): THREE.BufferGeometry {
  const g = sphere(0.1, 22, 16);
  const v = g.getAttribute('position');
  const f = p.face;
  for (let i = 0; i < v.count; i++) {
    let x = v.getX(i), y = v.getY(i), z = v.getZ(i);
    const low = THREE.MathUtils.smoothstep(-y, 0.0, 0.1); // 0 above the cheekbones → 1 at the chin
    x *= 0.78 * f.width * (1 - (1 - f.jaw) * low);
    z *= 0.97 * (1 - 0.12 * low * (z < 0 ? 1 : 0)); // the jaw tucks in behind
    if (z > 0) z += 0.006 * low; // chin forward a touch
    y = y * 1.1 * f.height - f.chin * low;
    v.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return paint(at(g, 0, HEAD_C, 0), skin);
}

/** Hair shell: a slice of a slightly larger skull. theta = how far down from the crown it reaches. */
function shell(hair: string, p: Persona, theta: number, opts: { phi0?: number; phiLen?: number; grow?: number; dy?: number; dz?: number; tilt?: number } = {}): THREE.BufferGeometry {
  const grow = (opts.grow ?? 1.08) + 0.03;
  const g = new THREE.SphereGeometry(0.1, sg(20), sg(10, 3), opts.phi0 ?? 0, opts.phiLen ?? Math.PI * 2, 0, Math.PI * theta);
  return paint(at(g, 0, HEAD_C + (opts.dy ?? 0.004), opts.dz ?? -0.006, opts.tilt ?? -0.22, 0, 0, 0.8 * p.face.width * grow, 1.1 * p.face.height * grow, 0.99 * grow), hair);
}

function buildHead(a: Avatar, p: Persona, o: Outfit): Part[] {
  const g: THREE.BufferGeometry[] = [];
  const skin = a.skin, hair = a.hair, w = p.face.width;
  g.push(skull(skin, p));
  // neck (rides the head bone; its base hides inside the collar)
  g.push(paint(lathe([[0.05, NECK - 0.035], [0.047, NECK + 0.02], [0.044, NECK + 0.07], [0.05, NECK + 0.1]], 12), skin));
  // ears
  for (const sd of [-1, 1]) g.push(paint(at(sphere(0.02, 8, 6), sd * 0.078 * w, HEAD_C - 0.005, -0.006, 0, sd * 0.3, 0, 0.45, 1.3, 0.9), shade(skin, 0.95)));
  // nose: a soft wedge with a shaded underside, so it reads from a few metres away
  g.push(paint(at(new THREE.ConeGeometry(0.014, 0.04 * p.face.nose, sg(8)), 0, HEAD_C - 0.012, 0.096, -0.32, 0, 0, 1, 1, 0.75), shade(skin, 0.97)));
  g.push(paint(at(sphere(0.011, 8, 6), 0, HEAD_C - 0.03, 0.1, 0, 0, 0, 1.3, 0.6, 0.8), shade(skin, 0.88)));
  // cheek/eye-socket shading: a slightly darker band just above the cheekbones gives the face structure
  if (!FAR) for (const sd of [-1, 1]) g.push(paint(at(sphere(0.019, 10, 6), sd * 0.031 * w, EYE_Y + 0.006, 0.079, 0, sd * 0.25, 0, 1.25, 0.8, 0.45), shade(skin, 0.9)));
  {
    // brows + mouth: clean and understated, like a fine scale figure
    const brow = a.hairStyle === 4 ? shade(skin, 0.55) : shade(hair, 0.85);
    for (const sd of [-1, 1]) g.push(paint(at(capsule(0.0055, 0.026, 2, 5), sd * 0.032 * w, HEAD_C + 0.036, 0.091, 0.15, sd * 0.32, Math.PI / 2 - sd * 0.14, 1, 1, 0.7), brow));
    const lip = new THREE.Color(skin).lerp(new THREE.Color('#6e3530'), 0.55).getStyle();
    g.push(paint(at(capsule(0.005, 0.024, 2, 6), 0, HEAD_C - 0.051, 0.088, 0, 0, Math.PI / 2, 1, 1, 0.7), lip));
  }
  if (!FAR) {
    if (o.detail === 'earrings') for (const sd of [-1, 1]) g.push(paint(at(sphere(0.006, 6, 4), sd * 0.08 * w, HEAD_C - 0.034, 0.002), '#c9a45c'));
  }
  if (o.detail === 'moustache') g.push(paint(at(capsule(0.007, 0.03, 2, 6), 0, HEAD_C - 0.038, 0.091, 0, 0, Math.PI / 2, 1, 1, 0.7), shade(hair, 0.9)));
  if (o.detail === 'stubble' && !FAR) g.push(paint(at(new THREE.SphereGeometry(0.1, sg(18), sg(8), Math.PI * 1.25, Math.PI * 1.5, Math.PI * 0.55, Math.PI * 0.4), 0, HEAD_C + 0.002, 0.002, 0, 0, 0, 0.8 * w * 0.99, 1.1, 1.0), shade(skin, 0.86)));
  if (o.glasses && !FAR) {
    const c = o.glasses === 'round' ? '#8a6c45' : '#2d2a2b';
    for (const sd of [-1, 1]) {
      g.push(paint(at(torus(0.017, 0.0022, Math.PI * 2, 12), sd * 0.031, EYE_Y, 0.099, 0, 0, 0, 1, o.glasses === 'round' ? 1 : 0.78, 1), c));
      g.push(paint(at(cyl(0.0018, 0.0018, 0.085, 4), sd * 0.074 * w, EYE_Y + 0.004, 0.055, Math.PI / 2, 0, 0), c));
    }
    g.push(paint(at(cyl(0.0018, 0.0018, 0.028, 4), 0, EYE_Y + 0.004, 0.1, 0, 0, Math.PI / 2), c));
  }
  hairMesh(g, a, p);
  headwear(g, a, p);
  return [[merge(g), B.Head]];
}

function hairMesh(g: THREE.BufferGeometry[], a: Avatar, p: Persona): void {
  const h = a.hair, w = p.face.width;
  const v = p.build * 1000 % 7; // stable per-person variation 0..7
  // a soft volume on the crown so short cuts don't sit like a helmet
  const crown = (dy = 0.0) => g.push(paint(at(sphere(0.07, 12, 8), (v - 3.5) * 0.002, HEAD_C + 0.075 + dy, -0.02, -0.3, 0, 0, 1.15 * w, 0.55, 1.25), h));
  const fringe = (y: number, z: number, n: number, span: number, len = 0.05) => {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1) - 0.5;
      g.push(paint(at(capsule(0.016, len, 2, 6), t * span * w, y, z - Math.abs(t) * 0.03, 1.25, 0, t * 0.9, 1, 1, 0.55), h));
    }
  };
  switch (a.hairStyle) {
    case 0: // short, tidy, swept fringe
      g.push(shell(h, p, 0.5));
      crown();
      fringe(HEAD_C + 0.062, 0.084, 3 + (v > 3 ? 1 : 0), 0.1 + v * 0.004, 0.032 + v * 0.002);
      break;
    case 1: // messy: tufts over a cap
      g.push(shell(h, p, 0.5, { grow: 1.1 }));
      for (let i = 0; i < (FAR ? 4 : 10); i++) {
        const ang = i * 2.4, rr = 0.03 + (i % 3) * 0.022;
        g.push(paint(at(new THREE.ConeGeometry(0.022, 0.06, sg(5)), Math.cos(ang) * rr * w, HEAD_C + 0.105 - (i % 3) * 0.01, Math.sin(ang) * rr - 0.01, Math.sin(ang) * 0.8, ang, -Math.cos(ang) * 0.8), h));
      }
      fringe(HEAD_C + 0.06, 0.085, 4, 0.12, 0.045);
      break;
    case 2: // long, straight, past the shoulders
      g.push(shell(h, p, 0.52, { grow: 1.1 }));
      g.push(paint(lathe([[0.075, HEAD_C - 0.2], [0.09, HEAD_C - 0.12], [0.098, HEAD_C - 0.02], [0.094, HEAD_C + 0.04]], 14, Math.PI * 0.62, Math.PI * 0.76), h));
      g.push(paint(lining([[0.075, HEAD_C - 0.2], [0.09, HEAD_C - 0.12], [0.098, HEAD_C - 0.02], [0.094, HEAD_C + 0.04]], 14, Math.PI * 0.62, Math.PI * 0.76), shade(h, 0.7)));
      for (const sd of [-1, 1]) g.push(paint(at(pill(0.03, 0.16, 0.05), sd * 0.083 * w, HEAD_C - 0.06, 0.03, 0, 0, sd * 0.05), h));
      fringe(HEAD_C + 0.065, 0.084, 3, 0.09, 0.04);
      break;
    case 3: // bun
      g.push(shell(h, p, 0.52));
      crown(-0.005);
      g.push(paint(at(sphere(0.04, 10, 8), 0, HEAD_C + 0.085, -0.075), h));
      fringe(HEAD_C + 0.062, 0.084, 2, 0.08, 0.03);
      break;
    case 4: // bald on top: a short horseshoe of hair round the back and sides
      g.push(paint(at(torus(0.081, 0.016, Math.PI * 1.25, 16), 0, HEAD_C + 0.005, -0.004, Math.PI / 2, 0, -Math.PI * 0.125 - Math.PI / 2, w, 1.12, 1), h));
      break;
    case 5: // bob: a shell to the jaw, open at the face, with straight bangs
      g.push(shell(h, p, 0.78, { phi0: Math.PI * 0.27, phiLen: Math.PI * 1.46, grow: 1.12, tilt: -0.05 }));
      g.push(shell(h, p, 0.36, { grow: 1.12, tilt: -0.05 }));
      g.push(paint(at(pill(0.13 * w, 0.03, 0.03), 0, HEAD_C + 0.06, 0.08, 0, 0, Math.PI / 2), h));
      break;
    case 6: // ponytail
      g.push(shell(h, p, 0.52));
      g.push(paint(at(torus(0.012, 0.005), 0, HEAD_C + 0.04, -0.108, 0.3, 0, 0), '#7c4a5a'));
      g.push(paint(at(capsule(0.024, 0.13, 3, 8), 0, HEAD_C - 0.04, -0.125, 0.25, 0, 0, 1, 1, 0.85), h));
      fringe(HEAD_C + 0.064, 0.084, 3, 0.09, 0.035);
      break;
    case 7: // twin tails
      g.push(shell(h, p, 0.52));
      for (const sd of [-1, 1]) g.push(paint(at(capsule(0.022, 0.12, 3, 8), sd * 0.1 * w, HEAD_C - 0.04, -0.045, 0.15, 0, sd * 0.3), h));
      fringe(HEAD_C + 0.064, 0.084, 3, 0.1, 0.035);
      break;
    default: // 8: side part, combed over with a lifted front
      g.push(shell(h, p, 0.5, { tilt: -0.18 }));
      crown(0.005);
      g.push(paint(at(sphere(0.06, 12, 8), (v > 3 ? 1 : -1) * 0.02 * w, HEAD_C + 0.078, 0.045, 0.35, 0, (v > 3 ? -1 : 1) * 0.3, 1.3, 0.5, 1.1), h));
  }
}

function headwear(g: THREE.BufferGeometry[], a: Avatar, p: Persona): void {
  const w = p.face.width;
  switch (a.headwear) {
    case 1: { // chef's toque: a fitted band and a soft, pleated crown
      const band = '#f1ede4';
      g.push(paint(at(lathe([[0.096, 0], [0.099, 0.035], [0.098, 0.045]], 20), 0, HEAD_C + 0.045, -0.006, -0.12, 0, 0, w * 0.84, 1, 1), band));
      g.push(paint(at(lathe([[0.096, 0.04], [0.108, 0.09], [0.112, 0.13], [0.104, 0.16], [0.07, 0.172], [0, 0.175]], 20), 0, HEAD_C + 0.045, -0.006, -0.12, 0, 0, w * 0.86, 1, 1), '#faf8f3'));
      break;
    }
    case 2: // hachimaki headband with knotted tails
      g.push(paint(at(lathe([[0.1, 0], [0.102, 0.01], [0.1, 0.022]], 20), 0, HEAD_C + 0.03, -0.006, -0.2, 0, 0, 0.8 * w * 1.04, 1, 1.02), '#ebe3d2'));
      g.push(paint(at(new THREE.CircleGeometry(0.007, sg(10)), 0, HEAD_C + 0.055, 0.103, -0.2), '#a8483d'));
      for (const sd of [-1, 1]) g.push(paint(at(pill(0.012, 0.05, 0.004), sd * 0.01, HEAD_C + 0.0, -0.104, 0.3, 0, sd * 0.4), '#ddd3bf'));
      break;
    case 3: { // baseball cap
      const c = a.shirt === '#ffffff' ? '#a8483d' : shade(a.shirt, 0.85);
      g.push(shell(c, p, 0.47, { grow: 1.14, tilt: -0.05, dy: 0.01 }));
      g.push(paint(at(cyl(0.065, 0.068, 0.006, 16), 0, HEAD_C + 0.05, 0.085, 0.18, 0, 0, w, 1, 0.9), shade(c, 0.85)));
      break;
    }
  }
}

function buildEyes(): Part[] {
  const g: THREE.BufferGeometry[] = [];
  for (const sd of [-1, 1]) {
    g.push(paint(at(sphere(0.012, 10, 8), sd * 0.031, EYE_Y, 0.083, 0, sd * 0.25, 0, 1.3, 0.72, 0.5), '#efe8de'));
    g.push(paint(at(sphere(0.0085, 8, 6), sd * 0.031, EYE_Y - 0.001, 0.0875, 0, sd * 0.25, 0, 1, 1.05, 0.5), '#241c1a'));
    g.push(paint(at(capsule(0.0022, 0.022, 2, 5), sd * 0.031, EYE_Y + 0.0085, 0.089, 0.1, sd * 0.25, Math.PI / 2, 1, 1, 0.6), '#3a2c28')); // upper lash line
  }
  return [[merge(g), B.Eyes]];
}
// (the far LOD keeps the eyes too: they are what makes a face read at street distance)

// ---------------------------------------------------------------- torso & garments
// Body cross-sections are ellipses: lathe profiles scaled in depth. Garment layers sit a few mm outside each other.
const D_CHEST = 0.64, D_HIP = 0.74;
const SHIRT: [number, number][] = [[0.132, 1.0], [0.134, 1.06], [0.146, 1.16], [0.163, 1.26], [0.172, 1.325], [0.17, 1.365], [0.158, 1.398], [0.136, 1.424], [0.104, 1.443], [0.068, 1.457], [0.05, 1.462]];
const JACKET: [number, number][] = [[0.146, 1.0], [0.148, 1.07], [0.158, 1.16], [0.174, 1.26], [0.184, 1.33], [0.182, 1.37], [0.17, 1.402], [0.148, 1.428], [0.114, 1.447], [0.078, 1.461], [0.058, 1.466]];
const PANTS: [number, number][] = [[0.0005, 0.86], [0.1, 0.862], [0.145, 0.885], [0.16, 0.93], [0.152, 0.99], [0.137, 1.045]];
const JACKET_SKIRT: [number, number][] = [[0.162, 0.83], [0.166, 0.9], [0.158, 0.98], [0.15, 1.045]];

function el(pts: [number, number][], depth: number, color: string, seg = 22, scaleX = 1): THREE.BufferGeometry {
  return paint(at(lathe(pts, seg), 0, 0, 0, 0, 0, 0, scaleX, 1, depth), color);
}
const frontZ = (r: number, depth: number) => r * depth; // front surface depth of an elliptical layer

function buildTorso(a: Avatar, o: Outfit, p: Persona): Part[] {
  const chest: THREE.BufferGeometry[] = [], hips: THREE.BufferGeometry[] = [];
  const cut = o.cut ?? (o.apron === true ? 'coat' : undefined);
  const bx = p.build;
  const outer = cut === 'blazer' || cut === 'workwear' || cut === 'longcoat' ? o.vest ?? shade(a.shirt, 0.7) : a.shirt;
  const trim = o.trim ?? shade(outer, 1.25);
  // trousers seat (a skirt replaces it below)
  if (o.skirt) {
    hips.push(paint(at(lathe([[0.0005, 0.6], [0.2, 0.6], [0.205, 0.63], [0.17, 0.82], [0.152, 0.95], [0.137, 1.045]], 18), 0, 0, 0, 0, 0, 0, bx, 1, D_HIP + 0.04), o.skirt));
    hips.push(paint(at(lathe([[0.199, 0.598], [0.2, 0.612]], 18), 0, 0, 0, 0, 0, 0, bx, 1, D_HIP + 0.05), shade(o.skirt, 0.8)));
  } else hips.push(el(PANTS, D_HIP, a.pants, 16, bx));
  // belt (only shows over a tucked-in shirt)
  if (!FAR && (!cut || cut === undefined) && !o.skirt) hips.push(paint(at(torus(0.139, 0.008, Math.PI * 2, 18), 0, 1.01, 0, Math.PI / 2, 0, 0, bx, D_HIP + 0.03, 1), '#2a2321'));

  if (cut === 'blazer' || cut === 'longcoat') {
    chest.push(el(JACKET, D_CHEST + 0.02, outer, 16, bx));
    // the V opening: shirt, tie, lapels
    const z = frontZ(0.178, D_CHEST + 0.02);
    chest.push(panel([[-0.05, 1.44], [0.05, 1.44], [0.0, 1.2]], z - 0.004, a.shirt));
    if (o.tie) {
      chest.push(panel([[-0.012, 1.43], [0.012, 1.43], [0.008, 1.41], [-0.008, 1.41]], z, shade(o.tie, 0.9)));
      chest.push(panel([[-0.008, 1.41], [0.008, 1.41], [0.019, 1.22], [0, 1.2], [-0.019, 1.22]], z, o.tie));
    }
    for (const sd of [-1, 1]) {
      chest.push(panel([[sd * 0.052, 1.445], [sd * 0.088, 1.42], [sd * 0.082, 1.36], [sd * 0.1, 1.34], [sd * 0.004, 1.185]].map(([x, y]) => [x, y]) as [number, number][], z + 0.001, shade(outer, 1.1)));
    }
    if (!FAR) for (const y of [1.14, 1.08]) chest.push(paint(at(sphere(0.007, 6, 4), 0.01, y, frontZ(0.15, D_CHEST + 0.02) + 0.004), shade(outer, 0.6)));
    if (cut === 'blazer') hips.push(el(JACKET_SKIRT, D_HIP + 0.03, outer, 16, bx));
    else {
      // knee-length overcoat, buttoned, with a centre-front seam
      const pts: [number, number][] = [[0.0005, 0.555], [0.196, 0.555], [0.2, 0.57], [0.19, 0.7], [0.172, 0.86], [0.163, 0.96], [0.152, 1.045]];
      hips.push(paint(at(lathe(pts, 18), 0, 0, 0, 0, 0, 0, bx, 1, D_HIP + 0.05), outer));
      hips.push(panel([[-0.003, 1.0], [0.003, 1.0], [0.003, 0.57], [-0.003, 0.57]], frontZ(0.19, D_HIP + 0.05) - 0.004, shade(outer, 0.7), 0.003));
      if (!FAR) chest.push(paint(at(torus(0.135, 0.012, Math.PI * 2, 18), 0, 1.06, 0, Math.PI / 2, 0, 0, bx, D_CHEST + 0.1, 1), shade(outer, 0.85))); // belt tie
    }
  } else if (cut === 'coat') {
    // chef whites / work coat: double-breasted, stand collar, to the hip
    chest.push(el(JACKET, D_CHEST + 0.02, a.shirt, 16, bx));
    hips.push(el(JACKET_SKIRT, D_HIP + 0.03, a.shirt, 16, bx));
    const z = frontZ(0.17, D_CHEST + 0.02);
    chest.push(panel([[-0.02, 1.43], [0.12, 1.36], [0.115, 1.06], [0.0, 1.06]], z, shade(a.shirt, 0.97)));
    chest.push(paint(at(lathe([[0.062, 1.452], [0.06, 1.485]], 16), 0, 0, 0, 0, 0, 0, 1, 1, 0.85), shade(a.shirt, 0.94)));
    if (!FAR) for (const y of [1.33, 1.24, 1.15]) for (const x of [0.03, 0.095]) chest.push(paint(at(sphere(0.0075, 6, 4), x, y, z + 0.007), trim));
  } else if (cut === 'workwear') {
    // zip jacket / school jacket: closed, stand collar, zip or button line
    chest.push(el(JACKET, D_CHEST + 0.02, outer, 16, bx));
    hips.push(el([[0.152, 0.94], [0.155, 0.99], [0.148, 1.045]], D_HIP + 0.03, outer, 16, bx));
    chest.push(paint(at(lathe([[0.066, 1.45], [0.064, 1.49]], 16), 0, 0, 0, 0, 0, 0, 1, 1, 0.85), shade(outer, 0.9)));
    const z = frontZ(0.176, D_CHEST + 0.02);
    chest.push(panel([[-0.004, 1.45], [0.004, 1.45], [0.004, 1.0], [-0.004, 1.0]], z, trim, 0.003));
    if (!FAR) for (const sd of [-1, 1]) chest.push(panel([[sd * 0.06, 1.17], [sd * 0.12, 1.17], [sd * 0.12, 1.12], [sd * 0.06, 1.12]], frontZ(0.15, D_CHEST + 0.02), shade(outer, 0.85), 0.003));
  } else if (cut === 'knit') {
    const knit = a.shirt;
    chest.push(el(JACKET, D_CHEST + 0.015, knit, 16, bx));
    hips.push(el([[0.15, 0.95], [0.153, 0.99], [0.147, 1.045]], D_HIP + 0.025, knit, 16, bx));
    chest.push(paint(at(torus(0.062, 0.01, Math.PI * 2, 16), 0, 1.452, 0, Math.PI / 2, 0, 0, 1, 0.85, 1), o.trim ?? shade(knit, 0.85)));
    hips.push(paint(at(lathe([[0.154, 0.94], [0.156, 0.965]], 16), 0, 0, 0, 0, 0, 0, bx, 1, D_HIP + 0.035), o.trim ?? shade(knit, 0.85)));
    if (o.trim && !FAR) chest.push(paint(at(lathe([[0.168, 1.25], [0.172, 1.28]], 16), 0, 0, 0, 0, 0, 0, bx, 1, D_CHEST + 0.03), o.trim));
  } else {
    // plain shirt, tucked in, with collar points and a button placket
    chest.push(el(SHIRT, D_CHEST, a.shirt, 16, bx));
    const z = frontZ(0.17, D_CHEST);
    for (const sd of [-1, 1]) chest.push(panel([[sd * 0.012, 1.455], [sd * 0.062, 1.445], [sd * 0.042, 1.405]], z - 0.006, shade(a.shirt, 0.94)));
    if (!FAR) for (const y of [1.36, 1.27, 1.18, 1.09]) chest.push(paint(at(sphere(0.005, 5, 4), 0, y, frontZ(y > 1.2 ? 0.168 : 0.145, D_CHEST) + 0.003), shade(a.shirt, 0.75)));
    if (o.vest) {
      // waistcoat over the shirt
      chest.push(el([[0.142, 1.0], [0.144, 1.07], [0.155, 1.16], [0.169, 1.26], [0.174, 1.32], [0.15, 1.38]], D_CHEST + 0.03, o.vest, 16, bx));
      chest.push(panel([[-0.03, 1.39], [0.03, 1.39], [0.0, 1.22]], frontZ(0.168, D_CHEST + 0.03), a.shirt));
      if (o.tie) chest.push(panel([[-0.008, 1.43], [0.008, 1.43], [0.016, 1.24], [0, 1.22], [-0.016, 1.24]], frontZ(0.168, D_CHEST + 0.03) + 0.002, o.tie));
      if (!FAR) for (const y of [1.18, 1.12, 1.06]) chest.push(paint(at(sphere(0.006, 5, 4), 0, y, frontZ(0.15, D_CHEST + 0.03) + 0.004), '#b89656'));
    } else if (o.tie) chest.push(panel([[-0.008, 1.44], [0.008, 1.44], [0.017, 1.22], [0, 1.2], [-0.017, 1.22]], z + 0.001, o.tie));
  }
  if (o.apron) {
    // bib apron: bib on the chest, skirt from the waist to the knee (curved, so legs swing behind it)
    const ap = typeof o.apron === 'string' ? o.apron : UNIFORMS[a.uniformStyle ?? 0] ?? UNIFORMS[0];
    const seam = o.trim ?? shade(ap, 1.4);
    const zb = frontZ(0.17, D_CHEST + 0.03);
    chest.push(panel([[-0.075, 1.33], [0.075, 1.33], [0.095, 1.2], [0.12, 1.04], [-0.12, 1.04], [-0.095, 1.2]], zb, ap));
    for (const sd of [-1, 1]) chest.push(paint(at(pill(0.012, 0.13, 0.004), sd * 0.065, 1.4, frontZ(0.16, D_CHEST + 0.03) - 0.01, -0.35, 0, sd * -0.12), ap));
    const skirt: [number, number][] = [[0.205, 0.56], [0.19, 0.7], [0.172, 0.86], [0.16, 0.98], [0.157, 1.04]];
    hips.push(paint(at(lathe(skirt, 14, -1.05, 2.1), 0, 0, 0, 0, 0, 0, bx, 1, D_HIP + 0.1), ap));
    hips.push(paint(at(lining(skirt, 14, -1.05, 2.1), 0, 0, 0, 0, 0, 0, bx, 1, D_HIP + 0.1), shade(ap, 0.7)));
    hips.push(paint(at(torus(0.16, 0.007, Math.PI * 2, 18), 0, 1.03, 0, Math.PI / 2, 0, 0, bx, D_HIP + 0.1, 1), seam)); // waist tie
    if (!FAR) chest.push(panel([[-0.045, 1.24], [0.045, 1.24], [0.045, 1.17], [-0.045, 1.17]], zb + 0.006, shade(ap, 0.85), 0.003));
  }
  if (o.bag) {
    // backpack with shoulder straps
    chest.push(paint(at(pill(0.25, 0.32, 0.12), 0, 1.22, -frontZ(0.17, D_CHEST) - 0.055), o.bag));
    if (!FAR) chest.push(paint(at(pill(0.17, 0.12, 0.05), 0, 1.13, -frontZ(0.17, D_CHEST) - 0.12), shade(o.bag, 0.85)));
    // straps come over the shoulders and run down the front of the chest
    for (const sd of [-1, 1]) {
      chest.push(paint(at(pill(0.026, 0.25, 0.008), sd * 0.082, 1.3, frontZ(0.17, D_CHEST + 0.04), -0.08, 0, sd * 0.1), shade(o.bag, 0.7)));
      chest.push(paint(at(pill(0.026, 0.16, 0.008), sd * 0.09, 1.44, 0.0, Math.PI / 2, 0, 0), shade(o.bag, 0.7)));
    }
  }
  return [[merge(chest), B.Chest], [merge(hips), B.Body]];
}

function sleeveColor(a: Avatar, o: Outfit): string {
  const cut = o.cut ?? (o.apron === true ? 'coat' : undefined);
  return cut === 'blazer' || cut === 'workwear' || cut === 'longcoat' ? o.vest ?? shade(a.shirt, 0.7) : a.shirt;
}

function buildArm(a: Avatar, o: Outfit, sd: 1 | -1): Part[] {
  const x = sd * SHO_X, ex = sd * (SHO_X + 0.012);
  const sleeve = sleeveColor(a, o);
  const cut = o.cut;
  const upper = [
    // rounded deltoid that melts into the sloping shoulder line, then a tapered upper arm
    paint(at(sphere(0.05, 16, 12), x - sd * 0.008, SHO_Y - 0.012, 0, 0, 0, sd * 0.35, 0.95, 1.05, 0.98), sleeve),
    paint(at(lathe([[0.036, ELB_Y - 0.02], [0.039, ELB_Y + 0.05], [0.044, SHO_Y - 0.15], [0.047, SHO_Y - 0.07], [0.045, SHO_Y - 0.02]], 16), x, 0, -0.004), sleeve),
  ];
  const wrist = 0.88;
  const lower = [
    paint(at(sphere(0.038, 12, 10), ex, ELB_Y, -0.01), sleeve), // elbow
    paint(at(lathe([[0.029, wrist], [0.032, wrist + 0.05], [0.038, ELB_Y - 0.09], [0.039, ELB_Y - 0.02], [0.037, ELB_Y + 0.01]], 16), ex, 0, -0.01), sleeve),
  ];
  // shirt cuff peeking out of a jacket sleeve
  if (cut === 'blazer' || cut === 'longcoat') lower.push(paint(at(lathe([[0.031, wrist - 0.012], [0.033, wrist + 0.004]], 12), ex, 0, -0.01), a.shirt));
  else if (cut === 'knit' || cut === 'workwear') lower.push(paint(at(lathe([[0.035, wrist - 0.004], [0.037, wrist + 0.025]], 12), ex, 0, -0.01), o.trim ?? shade(sleeve, 0.85)));
  // hand: a tapered mitten (palm faces the thigh) with a separate thumb angled forward and in
  const hx = ex, hy = wrist - 0.045;
  const mitt = lathe([[0.004, -0.105], [0.017, -0.098], [0.026, -0.075], [0.031, -0.04], [0.031, -0.005], [0.024, 0.02]], 12);
  lower.push(paint(at(mitt, hx, wrist - 0.01, 0.004, 0.1, 0, 0, 0.6, 1, 1.15), a.skin));
  lower.push(paint(at(capsule(0.0105, 0.032, 2, 8), hx - sd * 0.013, hy - 0.012, 0.03, 0.55, 0, -sd * 0.35), shade(a.skin, 0.97)));
  lower.push(paint(at(cyl(0.025, 0.028, 0.03, 12), hx, wrist + 0.005, -0.004, 0, 0, 0, 0.8, 1, 1), a.skin)); // wrist
  return [[merge(upper), sd < 0 ? B.ArmL : B.ArmR], [merge(lower), sd < 0 ? B.ElbowL : B.ElbowR]];
}

function buildLeg(a: Avatar, o: Outfit, p: Persona, sd: 1 | -1): Part[] {
  const x = sd * LEG_X;
  const fabric = o.skirt ? shade(a.skin, 0.93) : a.pants;
  const tights = o.skirt ? '#3a3437' : a.pants;
  const thigh = [
    paint(at(lathe([[0.058, KNEE - 0.01], [0.064, KNEE + 0.08], [0.076, 0.74], [0.087, 0.86], [0.088, HIP + 0.02]], 12), x, 0, 0, 0, 0, 0, 1, 1, 1.02), o.skirt ? tights : fabric),
  ];
  const shin: THREE.BufferGeometry[] = [
    paint(at(sphere(0.058, 10, 8), x, KNEE, 0.004), o.skirt ? tights : fabric), // knee
    paint(at(lathe(o.skirt
      ? [[0.034, 0.08], [0.038, 0.14], [0.05, 0.3], [0.053, 0.38], [0.052, KNEE]]
      : [[0.055, 0.085], [0.054, 0.12], [0.056, 0.3], [0.058, KNEE]], 12), x, 0, 0.004), tights),
  ];
  // shoe: rounded upper on a thin sole, toe forward
  const cut = o.cut;
  const shoe = cut === 'blazer' || cut === 'longcoat' ? '#2d2522' : p.shoe;
  const sole = cut === 'blazer' || cut === 'longcoat' ? '#18120f' : p.sole;
  shin.push(paint(at(capsule(0.042, 0.15, 3, 10), x, 0.055, 0.045, Math.PI / 2, 0, 0, 1.1, 1, 0.78), shoe));
  shin.push(paint(at(pill(0.092, 0.024, 0.255), x, 0.012, 0.046, Math.PI / 2, 0, 0, 1, 1, 1), sole));
  return [[merge(thigh), sd < 0 ? B.LegL : B.LegR], [merge(shin), sd < 0 ? B.KneeL : B.KneeR]];
}

/** Whole person as ONE indexed geometry with skinIndex/skinWeight (1 draw call, 1 shadow call). */
/** Skin tones are pulled a quarter of the way toward a soft neutral: natural under the warm grade, never orange. */
const naturalSkin = (hex: string) => '#' + new THREE.Color(hex).lerp(new THREE.Color('#c9b5a6'), 0.28).getHexString();

function buildCharacter(a: Avatar, o: Outfit, far: boolean): THREE.BufferGeometry {
  Q = far ? 0.5 : 1; FAR = far;
  a = { ...a, skin: naturalSkin(a.skin) };
  const p = persona(a);
  const parts: Part[] = [
    ...buildHead(a, p, o), ...buildEyes(), ...buildTorso(a, o, p),
    ...buildArm(a, o, -1), ...buildArm(a, o, 1), ...buildLeg(a, o, p, -1), ...buildLeg(a, o, p, 1),
  ];
  Q = 1; FAR = false;
  const geo = merge(parts.map(([g, b]) => {
    const n = g.attributes.position.count;
    const idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { idx[i * 4] = b; w[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    return g;
  }));
  for (const [g] of parts) g.dispose();
  return geo;
}

// ---------------------------------------------------------------- animation
interface Pose {
  bodyY: number; lean: number; roll: number; twist: number; spine: number; headX: number; headY: number;
  /** shoulder [forward swing (−), abduction (+ = away from the body)] */
  armL: [number, number]; armR: [number, number];
  elbowL: number; elbowR: number; // − bends the forearm forward
  legL: number; legR: number; // − swings the thigh forward
  kneeL: number; kneeR: number; // + bends the shin back
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rest = (): Pose => ({ bodyY: 0, lean: 0, roll: 0, twist: 0, spine: 0, headX: 0, headY: 0, armL: [0, 0.06], armR: [0, 0.06], elbowL: -0.14, elbowR: -0.14, legL: 0, legR: 0, kneeL: 0.02, kneeR: 0.02 });

export class Character {
  root = new THREE.Group();
  private mesh: THREE.SkinnedMesh;
  private bones: THREE.Bone[];
  private near: THREE.BufferGeometry;
  private far: THREE.BufferGeometry | null = null;
  private isFar = false;
  private pose: Pose = rest();
  private phase = Math.random() * 10;
  private t = Math.random() * 10;
  private blinkIn = 1 + Math.random() * 3;
  private look = { yaw: 0, pitch: 0, next: 1 + Math.random() * 3 };
  anim: Anim = 'idle';
  speed = 0; // m/s, drives the walk cycle
  /** Attach props here: they ride in front of the body at carrying height (plates, trays, bags). */
  readonly hands = new THREE.Group();
  readonly headSlot = new THREE.Group();
  /** Rides the right hand (chopsticks, phone, camera). */
  readonly rightGrip = new THREE.Group();
  bite = 0; // 0 reaches toward the plate, 1 brings the chopsticks to the mouth
  eatingAtCounter = false;
  private legK = 1; // leg length factor (children have shorter legs)
  private relax = Math.random(); // per-person idle stance (how bent the elbows are, how far forward the hands hang)

  constructor(public avatar: Avatar, public outfit: Outfit = {}, scale = 1) {
    this.bones = BIND.map(() => new THREE.Bone());
    this.bones.forEach((bone, i) => {
      const par = PARENT[i];
      const [x, y, z] = BIND[i];
      if (par < 0) bone.position.set(x, y, z);
      else { const [px, py, pz] = BIND[par]; bone.position.set(x - px, y - py, z - pz); this.bones[par].add(bone); }
    });
    this.near = buildCharacter(avatar, outfit, false);
    this.mesh = new THREE.SkinnedMesh(this.near, MAT);
    this.mesh.castShadow = true;
    this.mesh.add(this.bones[B.Body]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones)); // bind at the origin, unscaled: root transforms apply on top
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.15); // skip per-vertex skinned bounds
    this.bones[B.Head].add(this.headSlot); this.headSlot.position.y = 0.3;
    this.bones[B.Body].add(this.hands); this.hands.position.set(0, 0.2, 0.36);
    this.bones[B.ElbowR].add(this.rightGrip); this.rightGrip.position.set(-0.012, -0.3, 0.03);
    this.root.add(this.mesh);
    this.root.scale.setScalar(scale);
    this.proportions();
  }

  private proportions(): void {
    const kid = !!this.outfit.child;
    this.legK = kid ? 0.84 : 1;
    this.bones[B.Head].scale.setScalar(kid ? 1.32 : 1);
    for (const b of [B.LegL, B.LegR]) this.bones[b].scale.set(1, this.legK, 1);
  }

  setAvatar(a: Avatar, o: Outfit = this.outfit): void {
    this.avatar = a; this.outfit = o;
    this.near.dispose(); this.far?.dispose(); this.far = null;
    this.near = buildCharacter(a, o, false);
    if (this.isFar) this.far = buildCharacter(a, o, true);
    this.mesh.geometry = this.isFar ? this.far! : this.near;
    this.proportions();
  }

  /** Swap to the low-poly LOD (built lazily on first use). */
  setLod(far: boolean): void {
    if (far === this.isFar) return;
    this.isFar = far;
    if (far && !this.far) this.far = buildCharacter(this.avatar, this.outfit, true);
    this.mesh.geometry = far ? this.far! : this.near;
  }

  update(dt: number): void {
    this.t += dt;
    const sp = this.speed;
    const run = this.anim === 'run';
    // stride frequency follows speed (≈1.8 strides/s at a 1.4 m/s walk)
    this.phase += dt * (run ? 10.5 : 3.2 + sp * 2.6);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const tgt = rest();
    const breathe = Math.sin(this.t * 1.9) * 0.004;
    const moving = sp > 0.15;

    // idle life: look around and blink
    this.look.next -= dt;
    if (this.look.next <= 0) { this.look.next = 1.5 + Math.random() * 3.5; this.look.yaw = (Math.random() - 0.5) * 0.9; this.look.pitch = (Math.random() - 0.6) * 0.2; }
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) this.blinkIn = 2 + Math.random() * 3.5;
    this.bones[B.Eyes].scale.y = this.blinkIn < 0.12 ? 0.15 : 1;

    switch (this.anim) {
      case 'idle': case 'interact': {
        // contrapposto: weight drifts from foot to foot, hips and shoulders counter-rotate
        const shift = Math.sin(this.t * 0.55);
        tgt.bodyY = breathe - Math.abs(shift) * 0.006; tgt.roll = shift * 0.025; tgt.twist = shift * 0.03; tgt.spine = -shift * 0.03;
        tgt.headY = this.look.yaw; tgt.headX = this.look.pitch;
        const sway = Math.sin(this.t * 1.9) * 0.02; // breathing lifts the shoulders a touch
        tgt.armL = [-0.08 - this.relax * 0.1 + Math.sin(this.t * 1.1) * 0.025 - sway, 0.07 + this.relax * 0.04];
        tgt.armR = [-0.08 - this.relax * 0.1 - Math.sin(this.t * 1.1) * 0.025 - sway, 0.07 + this.relax * 0.04];
        tgt.elbowL = -0.28 - this.relax * 0.3; tgt.elbowR = -0.3 - this.relax * 0.25;
        tgt.kneeL = 0.03 + Math.max(0, shift) * 0.08; tgt.kneeR = 0.03 + Math.max(0, -shift) * 0.08;
        if (this.anim === 'interact') { tgt.armR = [-0.9, 0.05]; tgt.elbowR = -0.7; tgt.headY = 0; tgt.headX = 0.12; }
        break;
      }
      case 'walk': case 'run': case 'carry': {
        const k = moving ? 1 : 0;
        const amp = run ? 0.72 : Math.min(0.46, 0.2 + sp * 0.16);
        tgt.legL = s * amp * k; tgt.legR = -s * amp * k;
        // the knee folds while the leg swings through, and stays soft at heel strike
        tgt.kneeL = (0.08 + Math.max(0, c) * (run ? 1.5 : 0.95) * amp * 1.4) * k + (1 - k) * 0.03;
        tgt.kneeR = (0.08 + Math.max(0, -c) * (run ? 1.5 : 0.95) * amp * 1.4) * k + (1 - k) * 0.03;
        // arms counter-swing, forearms trail and swing a little further forward
        tgt.armL = [-s * amp * 0.75 * k, 0.07]; tgt.armR = [s * amp * 0.75 * k, 0.07];
        tgt.elbowL = -(run ? 1.4 : 0.18 + Math.max(0, -s) * 0.35 * k); tgt.elbowR = -(run ? 1.4 : 0.18 + Math.max(0, s) * 0.35 * k);
        tgt.bodyY = (Math.abs(c) * (run ? 0.05 : 0.022) - (run ? 0.04 : 0.014)) * k + breathe; // two bobs per stride
        tgt.lean = run ? 0.16 : 0.04 * k;
        tgt.roll = s * 0.02 * k; tgt.twist = -s * (run ? 0.1 : 0.07) * k; tgt.spine = s * (run ? 0.14 : 0.1) * k;
        tgt.headY = 0; tgt.headX = run ? -0.08 : 0;
        if (this.anim === 'carry') { tgt.armL = [-0.42, 0.12]; tgt.armR = [-0.42, 0.12]; tgt.elbowL = tgt.elbowR = -1.15; tgt.spine *= 0.3; }
        break;
      }
      case 'jump':
        tgt.legL = -0.6; tgt.legR = 0.2; tgt.kneeL = 1.0; tgt.kneeR = 0.5; tgt.armL = [-1.6, 0.3]; tgt.armR = [-1.6, 0.3]; tgt.elbowL = tgt.elbowR = -0.5;
        tgt.lean = -0.04; tgt.headX = -0.12;
        break;
      case 'cook': {
        const chop = Math.sin(this.t * 13);
        tgt.armL = [-0.55, 0.12]; tgt.elbowL = -1.0; tgt.armR = [-0.5, 0.1]; tgt.elbowR = -1.05 + chop * 0.28;
        tgt.headX = 0.42; tgt.lean = 0.12; tgt.bodyY = breathe + Math.abs(chop) * 0.003;
        tgt.roll = Math.sin(this.t * 1.3) * 0.015; tgt.kneeL = tgt.kneeR = 0.06;
        break;
      }
      case 'sit': case 'eat': case 'sip':
        tgt.bodyY = -SIT_DROP + breathe;
        tgt.legL = -1.5; tgt.legR = -1.46; tgt.kneeL = 1.5; tgt.kneeR = 1.42;
        tgt.armL = [-0.35, 0.1]; tgt.armR = [-0.38, 0.1]; tgt.elbowL = -0.95; tgt.elbowR = -0.9;
        tgt.headY = this.look.yaw * 0.6; tgt.headX = this.look.pitch;
        if (this.anim === 'eat' || this.anim === 'sip') {
          const lift = this.anim === 'eat' ? this.bite : Math.pow((Math.sin(this.t * 1.8) + 1) / 2, 4);
          const high = this.anim === 'eat' && this.eatingAtCounter;
          tgt.armR = [lerp(high ? -0.75 : -0.5, -0.55, lift), lerp(0.12, 0.3, lift)];
          tgt.elbowR = lerp(high ? -1.2 : -1.0, -2.25, lift);
          tgt.armL = [high ? -0.7 : -0.45, 0.12]; tgt.elbowL = high ? -1.2 : -1.0;
          tgt.lean = lerp(high ? 0.18 : 0.14, 0.08, lift); tgt.headX = lerp(0.3, 0.12, lift); tgt.headY = 0;
        }
        break;
      case 'photo':
        tgt.armR = [-0.75, 0.05]; tgt.elbowR = -1.75; tgt.armL = [-0.7, -0.15]; tgt.elbowL = -1.7; tgt.headX = 0.02;
        break;
      case 'phone':
        tgt.armR = [-0.35, 0.08]; tgt.elbowR = -1.95; tgt.armL = [-0.05, 0.05]; tgt.headX = 0.36; tgt.headY = 0.08; tgt.lean = 0.04;
        break;
      case 'vending':
        tgt.armR = [-1.15 + Math.sin(this.t * 4) * 0.08, 0.05]; tgt.elbowR = -0.25; tgt.headX = 0.1;
        break;
      case 'wave':
        tgt.armR = [-0.2, 1.25]; tgt.elbowR = -1.4 + Math.sin(this.t * 9) * 0.35; tgt.roll = -0.03; tgt.headX = -0.06; tgt.bodyY = breathe;
        break;
      case 'cheer':
        tgt.armL = [-2.7, 0.35]; tgt.armR = [-2.7, 0.35]; tgt.elbowL = tgt.elbowR = -0.25;
        tgt.bodyY = Math.abs(Math.sin(this.t * 8)) * 0.07; tgt.kneeL = tgt.kneeR = 0.15; tgt.headX = -0.18;
        break;
      case 'angry': // arms folded, impatient weight shifts
        tgt.armL = [-0.45, -0.05]; tgt.armR = [-0.5, -0.05]; tgt.elbowL = -1.95; tgt.elbowR = -1.85;
        tgt.headX = 0.1; tgt.roll = Math.sin(this.t * 3) * 0.02; tgt.lean = -0.03;
        break;
    }
    const k = 1 - Math.exp(-dt * 14);
    const p = this.pose;
    for (const key of ['bodyY', 'lean', 'roll', 'twist', 'spine', 'elbowL', 'elbowR', 'legL', 'legR', 'kneeL', 'kneeR'] as const) p[key] = lerp(p[key], tgt[key], k);
    const kh = 1 - Math.exp(-dt * 5); // heads turn more lazily than limbs
    p.headX = lerp(p.headX, tgt.headX, kh); p.headY = lerp(p.headY, tgt.headY, kh);
    p.armL = [lerp(p.armL[0], tgt.armL[0], k), lerp(p.armL[1], tgt.armL[1], k)];
    p.armR = [lerp(p.armR[0], tgt.armR[0], k), lerp(p.armR[1], tgt.armR[1], k)];
    const bn = this.bones;
    bn[B.Body].position.y = HIP * this.legK + p.bodyY * (this.anim === 'sit' || this.anim === 'eat' || this.anim === 'sip' ? 1 : this.legK);
    bn[B.Body].rotation.set(0, p.twist, p.roll);
    bn[B.Chest].rotation.set(p.lean, p.spine, -p.roll * 0.6);
    bn[B.Head].rotation.set(p.headX - p.lean * 0.6, p.headY - p.spine * 0.7 - p.twist * 0.5, 0);
    bn[B.Chest].scale.set(1, 1 + breathe * 0.8, 1);
    bn[B.ArmL].rotation.set(p.armL[0], 0, -p.armL[1]);
    bn[B.ArmR].rotation.set(p.armR[0], 0, p.armR[1]);
    bn[B.ElbowL].rotation.x = p.elbowL; bn[B.ElbowR].rotation.x = p.elbowR;
    bn[B.LegL].rotation.x = p.legL; bn[B.LegR].rotation.x = p.legR;
    bn[B.KneeL].rotation.x = p.kneeL; bn[B.KneeR].rotation.x = p.kneeR;
    this.hands.visible = this.hands.children.length > 0;
  }

  private shadowOn = true;
  /** Toggle shadow casting (cheap no-op when unchanged). */
  setShadow(on: boolean): void {
    if (on === this.shadowOn) return;
    this.shadowOn = on;
    this.mesh.castShadow = on;
  }

  dispose(): void {
    this.near.dispose(); this.far?.dispose();
    this.mesh.skeleton.dispose();
    this.root.removeFromParent();
  }
}
