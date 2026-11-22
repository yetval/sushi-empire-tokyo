// Procedural cartoon character: chibi proportions built from lathe-turned, tapered parts, baked into
// 7 vertex-colored meshes (head, eyes, torso, 2 arms, 2 legs). Each avatar gets a stable "personality"
// (eye shape, brows, mouth, shoes, blush) derived from its fields, plus idle life (blinks, look-around,
// weight shifts) and smooth pose blending.
import * as THREE from 'three';
import { Avatar } from '../core/state';
import { VC_MAT, at, merge, paint, shade } from './geo';

export type Anim = 'idle' | 'walk' | 'run' | 'jump' | 'cook' | 'carry' | 'sit' | 'wave' | 'eat' | 'interact' | 'cheer' | 'angry';

export interface Outfit { apron?: boolean; tie?: string; bag?: string; vest?: string }

/** Hair style names for 0..8 (UI can show these). */
export const HAIR_STYLE_NAMES = ['Short', 'Messy', 'Long', 'Bun', 'Bald', 'Bob', 'Ponytail', 'Twin tails', 'Side part'];

const MAT = VC_MAT;
const HIP = 0.5; // hip pivot height: feet rest exactly on y = 0

// Segment counts scale with the LOD being built (Q = 0.72 near, 0.42 far); FAR also drops tiny details.
let Q = 1, FAR = false;
const sg = (n: number, min = 3) => Math.max(min, Math.round(n * Q));
const sphere = (r: number, w = 8, h = 6) => new THREE.SphereGeometry(r, sg(w), sg(h, 2));
const capsule = (r: number, len: number, cap = 2, rad = 8) => new THREE.CapsuleGeometry(r, len, Math.max(1, Math.round(cap * Q)), sg(rad));
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, sg(seg));
const torus = (r: number, t: number, arc = Math.PI * 2) => new THREE.TorusGeometry(r, t, sg(4), sg(12), arc);
const lathe = (pts: [number, number][], seg = 10) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), sg(seg));

// ---------------------------------------------------------------- personality
interface Persona { eye: 0 | 1 | 2; mouth: 0 | 1 | 2 | 3; brow: number; blush: boolean; shoe: string; sole: string; eyeSize: number }

function persona(a: Avatar): Persona {
  let h = 2166136261;
  for (const ch of `${a.skin}${a.hair}${a.hairStyle}${a.shirt}${a.pants}${a.headwear}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  const shoes: [string, string][] = [['#3b2a20', '#1f1612'], ['#1e1e24', '#111'], ['#f4f1ea', '#d94b3d'], ['#f4f1ea', '#2b5aa8'], ['#7a4a2a', '#2a1a10']];
  const s = shoes[Math.floor(r() * shoes.length)];
  return { eye: Math.floor(r() * 3) as Persona['eye'], mouth: Math.floor(r() * 4) as Persona['mouth'], brow: (r() - 0.5) * 0.6, blush: r() < 0.6, shoe: s[0], sole: s[1], eyeSize: 0.9 + r() * 0.25 };
}

// ---------------------------------------------------------------- head (face looks toward +z)
function capHair(h: string, r = 0.318, theta = 0.5, tilt = -0.28): THREE.BufferGeometry {
  return paint(at(new THREE.SphereGeometry(r, sg(14), sg(7, 2), 0, Math.PI * 2, 0, Math.PI * theta), 0, 0.02, -0.015, tilt, 0, 0), h);
}

function buildHead(a: Avatar, p: Persona): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const skin = a.skin, h = a.hair;
  parts.push(paint(at(sphere(0.3, 22, 17), 0, 0, 0, 0, 0, 0, 1, 0.94, 0.96), skin)); // head keeps more segments: it carries the silhouette
  for (const sx of [-1, 1]) {
    parts.push(paint(at(sphere(0.125, 7, 6), sx * 0.115, -0.1, 0.15), skin)); // soft cheeks / jaw
    parts.push(paint(at(sphere(0.065, 6, 5), sx * 0.29, -0.02, 0, 0, 0, 0, 0.55, 1, 0.9), skin)); // ears
    if (!FAR) parts.push(paint(at(sphere(0.03, 5, 4), sx * 0.305, -0.02, 0.01, 0, 0, 0, 0.5, 0.7, 0.7), shade(skin, 0.82)));
    if (p.blush) parts.push(paint(at(sphere(0.045, 6, 4), sx * 0.165, -0.075, 0.245, 0, sx * 0.5, 0, 1, 0.55, 0.3), '#ff9b94'));
    // eyebrows (bald heads get skin-toned brows so the face still reads)
    const browC = a.hairStyle === 4 ? shade(skin, 0.62) : shade(h, 0.85);
    parts.push(paint(at(capsule(0.013, 0.055, 2, 4), sx * 0.105, 0.095, 0.268, 0, sx * 0.35, Math.PI / 2 + sx * p.brow), browC));
  }
  parts.push(paint(at(sphere(0.032, 6, 5), 0, -0.04, 0.29, 0, 0, 0, 1, 0.85, 0.8), shade(skin, 0.94))); // nose bump
  // mouth
  const lip = '#8a3b33';
  switch (p.mouth) {
    case 0: parts.push(paint(at(torus(0.038, 0.01, Math.PI), 0, -0.1, 0.268, Math.PI, 0, 0), lip)); break; // smile
    case 1: // open happy mouth
      parts.push(paint(at(new THREE.CircleGeometry(0.042, sg(9), Math.PI, Math.PI), 0, -0.085, 0.279, -0.25, 0, 0), '#5b1f1f'));
      parts.push(paint(at(new THREE.CircleGeometry(0.022, sg(8), Math.PI, Math.PI), 0, -0.108, 0.281, -0.25, 0, 0), '#ff8a8a'));
      break;
    case 2: parts.push(paint(at(sphere(0.017, 5, 4), 0, -0.105, 0.272, 0, 0, 0, 1.2, 1, 0.5), lip)); break; // small "o"
    default: parts.push(paint(at(capsule(0.008, 0.04, 2, 4), 0, -0.1, 0.273, 0, 0, Math.PI / 2), lip)); // calm line
  }
  // hair
  switch (a.hairStyle) {
    case 0: // short with fringe
      parts.push(capHair(h));
      for (const x of [-0.13, -0.04, 0.06, 0.14]) parts.push(paint(at(sphere(0.085, 6, 5), x, 0.17, 0.2, 0.3, 0, x, 1, 0.55, 0.7), h));
      break;
    case 1: // messy student
      parts.push(capHair(h, 0.312, 0.47));
      for (let i = 0; i < 11; i++) {
        const ang = i * 2.4, rr = 0.1 + (i % 3) * 0.06;
        parts.push(paint(at(new THREE.ConeGeometry(0.07, 0.2, sg(5)), Math.cos(ang) * rr, 0.27 - (i % 3) * 0.03, Math.sin(ang) * rr - 0.02, Math.sin(ang) * 0.7, ang, -Math.cos(ang) * 0.7), h));
      }
      for (const x of [-0.1, 0.02, 0.12]) parts.push(paint(at(new THREE.ConeGeometry(0.06, 0.17, sg(5)), x, 0.18, 0.24, 2.2, 0, x * 2), h));
      break;
    case 2: // long straight
      parts.push(capHair(h, 0.325, 0.55));
      parts.push(paint(at(capsule(0.2, 0.32, 2, 9), 0, -0.2, -0.14, 0, 0, 0, 1.35, 1, 0.55), h));
      for (const sx of [-1, 1]) parts.push(paint(at(capsule(0.06, 0.3, 2, 6), sx * 0.26, -0.15, 0.06, 0, 0, sx * 0.06), h));
      for (const x of [-0.11, 0, 0.11]) parts.push(paint(at(sphere(0.08, 6, 5), x, 0.17, 0.21, 0.3, 0, 0, 1, 0.5, 0.7), h));
      break;
    case 3: // bun
      parts.push(capHair(h));
      parts.push(paint(at(sphere(0.12, 9, 6), 0, 0.31, -0.1), h));
      parts.push(paint(at(torus(0.085, 0.022), 0, 0.24, -0.08, Math.PI / 2 - 0.4, 0, 0), '#c0392b'));
      break;
    case 4: break; // bald
    case 5: { // bob: shell open at the face + straight bangs
      parts.push(paint(at(new THREE.SphereGeometry(0.335, sg(14), sg(7, 2), Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.68), 0, 0.01, -0.01), h));
      parts.push(capHair(h, 0.33, 0.36, -0.1));
      parts.push(paint(at(capsule(0.05, 0.34, 2, 6), 0, 0.165, 0.245, 0, 0, Math.PI / 2, 1, 1, 0.7), h));
      break;
    }
    case 6: // ponytail
      parts.push(capHair(h));
      parts.push(paint(at(sphere(0.045), 0, 0.1, -0.31), '#e84393'));
      parts.push(paint(at(capsule(0.075, 0.3, 2, 8), 0, -0.08, -0.38, 0.45, 0, 0, 1, 1, 0.85), h));
      for (const x of [-0.12, 0.0, 0.12]) parts.push(paint(at(sphere(0.08, 6, 5), x, 0.17, 0.21, 0.3, 0, 0, 1, 0.5, 0.7), h));
      break;
    case 7: // twin tails
      parts.push(capHair(h));
      for (const sx of [-1, 1]) {
        parts.push(paint(at(sphere(0.04), sx * 0.27, 0.12, -0.1), '#ffd23f'));
        parts.push(paint(at(capsule(0.07, 0.32, 2, 8), sx * 0.36, -0.08, -0.12, 0.15, 0, sx * 0.35), h));
      }
      for (const x of [-0.1, 0.02, 0.13]) parts.push(paint(at(sphere(0.08, 6, 5), x, 0.17, 0.21, 0.3, 0, 0, 1, 0.5, 0.7), h));
      break;
    default: // 8: side-part salaryman
      parts.push(capHair(h, 0.316, 0.48, -0.2));
      parts.push(paint(at(sphere(0.16, 9, 6), 0.07, 0.2, 0.13, 0.3, 0, -0.35, 1.25, 0.42, 0.95), h));
      parts.push(paint(at(sphere(0.1, 7, 5), -0.17, 0.15, 0.12, 0, 0, 0.5, 0.8, 0.5, 1), h));
  }
  // headwear
  const capC = a.shirt === '#ffffff' ? '#e63946' : a.shirt;
  switch (a.headwear) {
    case 1: // chef hat
      parts.push(paint(at(cyl(0.25, 0.26, 0.17, 13), 0, 0.29, 0), '#ffffff'));
      for (const [x, z] of [[0, 0], [0.11, 0.06], [-0.11, 0.06], [0, -0.11]]) parts.push(paint(at(sphere(0.17, 7, 6), x, 0.48, z), '#fbfbf7'));
      break;
    case 2: // hachimaki headband with a red rising-sun dot and knotted tails
      parts.push(paint(at(cyl(0.308, 0.308, 0.07, 16), 0, 0.12, 0), '#ffffff'));
      parts.push(paint(at(new THREE.CircleGeometry(0.035, sg(10)), 0, 0.12, 0.309), '#d62828'));
      parts.push(paint(at(sphere(0.04), 0, 0.12, -0.31), '#ffffff'));
      for (const sx of [-1, 1]) parts.push(paint(at(box(0.035, 0.15, 0.015), sx * 0.04, 0.05, -0.32, 0.2, 0, sx * 0.45), '#ffffff'));
      break;
    case 3: // baseball cap
      parts.push(paint(at(new THREE.SphereGeometry(0.325, sg(11), sg(6, 2), 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 0.06, 0), capC));
      parts.push(paint(at(cyl(0.21, 0.21, 0.025, 12), 0, 0.085, 0.24, 0.12, 0, 0, 1, 1, 0.75), shade(capC, 0.8)));
      parts.push(paint(at(sphere(0.03), 0, 0.38, 0), shade(capC, 0.8)));
      break;
  }
  return merge(parts);
}

function buildEyes(p: Persona): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const k = p.eyeSize;
  for (const sx of [-1, 1]) {
    const x = sx * 0.105, ry = sx * 0.33;
    if (p.eye === 2) { // content closed arcs ^^
      parts.push(paint(at(torus(0.032, 0.009, Math.PI), x, 0.005, 0.27, 0, ry, 0), '#2a1f24'));
      continue;
    }
    const tall = p.eye === 1;
    parts.push(paint(at(sphere(0.045 * k, 13, 9), x, 0.005, 0.262, 0, ry, 0, tall ? 0.85 : 1, tall ? 1.55 : 1.25, 0.55), '#1f1a24'));
    parts.push(paint(at(sphere(0.017 * k, 5, 4), x + 0.016, 0.03, 0.285), '#ffffff'));
    if (!FAR) parts.push(paint(at(sphere(0.008 * k, 4, 2), x - 0.012, -0.018, 0.287), '#ffffff'));
  }
  return merge(parts);
}

// ---------------------------------------------------------------- body
function buildTorso(a: Avatar, o: Outfit): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const z = 0.78; // depth squash: bodies are a little flatter than round
  // pants / hips (tapered lathe), belt, shirt (waist → chest → shoulders)
  parts.push(paint(at(lathe([[0.001, -0.04], [0.17, -0.03], [0.195, 0.04], [0.185, 0.16]]), 0, 0, 0, 0, 0, 0, 1, 1, z), a.pants));
  parts.push(paint(at(torus(0.183, 0.022), 0, 0.15, 0, Math.PI / 2, 0, 0, 1, z, 1), '#2b2220'));
  parts.push(paint(at(box(0.06, 0.045, 0.02), 0, 0.15, 0.148), '#d4a017'));
  parts.push(paint(at(lathe([[0.18, 0.15], [0.17, 0.24], [0.19, 0.36], [0.205, 0.45], [0.16, 0.52], [0.06, 0.55], [0.001, 0.555]]), 0, 0, 0, 0, 0, 0, 1, 1, z), a.shirt));
  parts.push(paint(at(cyl(0.062, 0.07, 0.1, 6), 0, 0.58, 0), a.skin)); // neck
  // collar points + buttons + chest pocket
  const trim = shade(a.shirt, a.shirt === '#ffffff' ? 0.92 : 0.8);
  for (const sx of [-1, 1]) parts.push(paint(at(box(0.08, 0.05, 0.02), sx * 0.045, 0.52, 0.115, -0.5, 0, sx * 0.6), trim));
  if (!o.apron && !o.vest) {
    if (!FAR) for (const y of [0.25, 0.33, 0.41]) parts.push(paint(at(sphere(0.011, 4, 2), 0, y, 0.152 - (0.41 - y) * 0.02), shade(a.shirt, 0.7)));
    if (!FAR) parts.push(paint(at(box(0.07, 0.07, 0.012), -0.09, 0.38, 0.152, -0.12, 0, 0), trim));
  }
  if (o.vest) {
    parts.push(paint(at(lathe([[0.19, 0.17], [0.178, 0.25], [0.198, 0.36], [0.21, 0.45], [0.17, 0.5]]), 0, 0, 0, 0, 0, 0, 1.02, 1, z * 1.03), o.vest));
    parts.push(paint(at(box(0.07, 0.3, 0.02), 0, 0.33, 0.152), a.shirt)); // shirt placket between lapels
    if (!FAR) for (const y of [0.24, 0.31]) parts.push(paint(at(sphere(0.012, 4, 2), 0.045, y, 0.16), '#d4af37'));
  }
  if (o.tie) {
    parts.push(paint(at(box(0.05, 0.05, 0.02), 0, 0.49, 0.135), o.tie));
    parts.push(paint(at(new THREE.ConeGeometry(0.04, 0.26, sg(4)), 0, 0.33, 0.158, Math.PI, Math.PI / 4, 0, 1, 1, 0.35), o.tie));
  }
  if (o.apron) {
    parts.push(paint(at(new THREE.BoxGeometry(0.3, 0.5, 0.025), 0, 0.12, 0.158), '#f6f3ec'));
    parts.push(paint(at(box(0.3, 0.012, 0.03), 0, 0.37, 0.16), '#d9d2c3'));
    if (!FAR) parts.push(paint(at(box(0.08, 0.06, 0.012), 0.07, 0.1, 0.173), '#e6dfd0')); // apron pocket
    for (const sx of [-1, 1]) parts.push(paint(at(box(0.025, 0.2, 0.02), sx * 0.12, 0.45, 0.1, -0.35, 0, -sx * 0.25), '#f6f3ec'));
    parts.push(paint(at(torus(0.186, 0.012), 0, 0.2, 0, Math.PI / 2, 0, 0, 1, z, 1), '#f6f3ec'));
    for (const sx of [-1, 1]) parts.push(paint(at(sphere(0.035, 5, 4), sx * 0.035, 0.2, -0.15, 0, 0, 0, 1, 0.6, 0.6), '#f6f3ec')); // bow
  }
  if (o.bag) {
    parts.push(paint(at(capsule(0.13, 0.12, 2, 8), 0, 0.3, -0.2, 0, 0, 0, 1.1, 1, 0.55), o.bag));
    parts.push(paint(at(box(0.16, 0.08, 0.04), 0, 0.22, -0.27), shade(o.bag, 0.8)));
    for (const sx of [-1, 1]) parts.push(paint(at(torus(0.15, 0.014, Math.PI), sx * 0.11, 0.38, -0.03, 0, Math.PI / 2, 0, 1, 1.05, 1), shade(o.bag, 0.7)));
  }
  return merge(parts);
}

function buildArm(a: Avatar, side: 1 | -1): THREE.BufferGeometry {
  // pivot at the shoulder; hangs down -y. Tapered sleeve, cuff, mitten hand with a thumb nub.
  return merge([
    paint(sphere(0.078, 6, 5), a.shirt),
    paint(at(lathe([[0.075, 0], [0.068, -0.15], [0.058, -0.3], [0.001, -0.31]], 8), 0, 0, 0), a.shirt),
    paint(at(torus(0.057, 0.014), 0, -0.3, 0, Math.PI / 2, 0, 0), shade(a.shirt, 0.82)),
    paint(at(sphere(0.066, 7, 6), 0, -0.37, 0.005, 0, 0, 0, 0.9, 1.05, 0.8), a.skin),
    paint(at(sphere(0.027, 5, 4), -side * 0.045, -0.35, 0.035), a.skin),
  ]);
}

function buildLeg(a: Avatar, p: Persona): THREE.BufferGeometry {
  return merge([
    paint(at(lathe([[0.088, 0.02], [0.084, -0.12], [0.07, -0.33], [0.066, -0.4], [0.001, -0.41]], 8), 0, 0, 0), a.pants),
    paint(at(sphere(0.075, 7, 6), 0, -0.455, 0.045, 0, 0, 0, 0.95, 0.62, 1.55), p.shoe),
    paint(at(box(0.13, 0.022, 0.23), 0, -0.489, 0.045), p.sole),
  ]);
}

interface Pose {
  bodyY: number; lean: number; roll: number; twist: number; headX: number; headY: number;
  armL: [number, number]; armR: [number, number]; legL: number; legR: number;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Bones (rigid skinning: every vertex follows exactly one bone). Bind pose has no rotation. */
const enum B { Body, Chest, Head, Eyes, ArmL, ArmR, LegL, LegR }
const BIND: [number, number, number][] = [ // model-space bind position of each bone
  [0, HIP, 0], [0, HIP, 0], [0, HIP + 0.88, 0], [0, HIP + 0.88, 0],
  [-0.235, HIP + 0.465, 0], [0.235, HIP + 0.465, 0], [-0.1, HIP, 0], [0.1, HIP, 0],
];

/** Whole character as ONE indexed geometry with skinIndex/skinWeight (1 draw call, 1 shadow call). */
function buildCharacter(a: Avatar, o: Outfit, far: boolean): THREE.BufferGeometry {
  Q = far ? 0.42 : 0.72; FAR = far;
  const p = persona(a);
  const parts: [THREE.BufferGeometry, B][] = [
    [buildHead(a, p), B.Head], [buildEyes(p), B.Eyes], [buildTorso(a, o), B.Chest],
    [buildArm(a, -1), B.ArmL], [buildArm(a, 1), B.ArmR], [buildLeg(a, p), B.LegL], [buildLeg(a, p), B.LegR],
  ];
  Q = 1; FAR = false;
  const geo = merge(parts.map(([g, b]) => {
    g.translate(...BIND[b]);
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

export class Character {
  root = new THREE.Group();
  private mesh: THREE.SkinnedMesh;
  private bones: THREE.Bone[];
  private near: THREE.BufferGeometry;
  private far: THREE.BufferGeometry | null = null;
  private isFar = false;
  private pose: Pose = { bodyY: 0, lean: 0, roll: 0, twist: 0, headX: 0, headY: 0, armL: [0, 0], armR: [0, 0], legL: 0, legR: 0 };
  private phase = Math.random() * 10;
  private t = Math.random() * 10;
  private blinkIn = 1 + Math.random() * 3;
  private look = { yaw: 0, pitch: 0, next: 1 + Math.random() * 3 };
  anim: Anim = 'idle';
  speed = 0; // m/s, drives the walk cycle
  /** Attach props here: they ride in front of the chest at hand height (plates, trays). */
  readonly hands = new THREE.Group();
  readonly headSlot = new THREE.Group();

  constructor(public avatar: Avatar, public outfit: Outfit = {}, scale = 1) {
    this.bones = BIND.map(() => new THREE.Bone());
    const [body, chest, head, eyes, armL, armR, legL, legR] = this.bones;
    const parentOf = [-1, B.Body, B.Body, B.Head, B.Body, B.Body, B.Body, B.Body];
    this.bones.forEach((bone, i) => {
      const par = parentOf[i];
      const [x, y, z] = BIND[i];
      if (par < 0) bone.position.set(x, y, z);
      else { const [px, py, pz] = BIND[par]; bone.position.set(x - px, y - py, z - pz); this.bones[par].add(bone); }
    });
    void chest; void eyes; void armL; void armR; void legL; void legR;
    this.near = buildCharacter(avatar, outfit, false);
    this.mesh = new THREE.SkinnedMesh(this.near, MAT);
    this.mesh.castShadow = true;
    this.mesh.add(body);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones)); // bind at the origin, unscaled: root transforms apply on top
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.85, 0), 1.15); // skip per-vertex skinned bounds
    head.add(this.headSlot); this.headSlot.position.y = 0.55;
    body.add(this.hands); this.hands.position.set(0, 0.42, 0.34);
    this.root.add(this.mesh);
    this.root.scale.setScalar(scale);
  }

  setAvatar(a: Avatar, o: Outfit = this.outfit): void {
    this.avatar = a; this.outfit = o;
    this.near.dispose(); this.far?.dispose(); this.far = null;
    this.near = buildCharacter(a, o, false);
    if (this.isFar) this.far = buildCharacter(a, o, true);
    this.mesh.geometry = this.isFar ? this.far! : this.near;
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
    this.phase += dt * (run ? 11.5 : 4 + sp * 2.2);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const tgt: Pose = { bodyY: 0, lean: 0, roll: 0, twist: 0, headX: 0, headY: 0, armL: [0, 0.07], armR: [0, -0.07], legL: 0, legR: 0 };
    const breathe = Math.sin(this.t * 2.1) * 0.01;
    const moving = sp > 0.15;

    // idle life: look around and blink
    this.look.next -= dt;
    if (this.look.next <= 0) { this.look.next = 1.5 + Math.random() * 3.5; this.look.yaw = (Math.random() - 0.5) * 0.9; this.look.pitch = (Math.random() - 0.6) * 0.25; }
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) this.blinkIn = 2 + Math.random() * 3.5;
    this.bones[B.Eyes].scale.y = this.blinkIn < 0.12 ? 0.12 : 1;

    switch (this.anim) {
      case 'idle': case 'interact': {
        const shift = Math.sin(this.t * 0.7);
        tgt.bodyY = breathe; tgt.roll = shift * 0.035; tgt.twist = shift * 0.04;
        tgt.headY = this.look.yaw; tgt.headX = this.look.pitch;
        tgt.armL = [Math.sin(this.t * 1.3) * 0.05, 0.08 + shift * 0.02]; tgt.armR = [-Math.sin(this.t * 1.3) * 0.05, -0.08 + shift * 0.02];
        tgt.legL = shift * 0.03; tgt.legR = -shift * 0.03;
        if (this.anim === 'interact') { tgt.armR = [-1.25, -0.12]; tgt.headY = 0; tgt.headX = 0.1; }
        break;
      }
      case 'walk': case 'run': case 'carry': {
        const k = moving ? 1 : 0;
        const amp = run ? 0.95 : Math.min(0.65, 0.25 + sp * 0.18);
        tgt.legL = s * amp * k; tgt.legR = -s * amp * k;
        // arms swing in an arc: forward and slightly across the body
        tgt.armL = [-s * amp * 0.85 * k, 0.1 + Math.max(0, -s) * 0.12 * k]; tgt.armR = [s * amp * 0.85 * k, -0.1 - Math.max(0, s) * 0.12 * k];
        tgt.bodyY = (Math.abs(c) * (run ? 0.07 : 0.045) - 0.015) * k + breathe; // heel-toe bounce, twice per stride
        tgt.lean = run ? 0.2 : 0.05 * k;
        tgt.roll = s * 0.035 * k; tgt.twist = -s * (run ? 0.12 : 0.08) * k;
        tgt.headY = s * 0.05 * k; tgt.headX = run ? -0.12 : 0;
        if (this.anim === 'carry') { tgt.armL = [-1.25, 0.28]; tgt.armR = [-1.25, -0.28]; tgt.twist *= 0.3; }
        break;
      }
      case 'jump':
        tgt.legL = -0.7; tgt.legR = 0.35; tgt.armL = [-2.5, 0.4]; tgt.armR = [-2.5, -0.4]; tgt.lean = -0.05; tgt.headX = -0.15;
        break;
      case 'cook': {
        const chop = Math.sin(this.t * 14);
        tgt.armL = [-1.1, 0.38]; tgt.armR = [-1.0 + chop * 0.35, -0.3]; tgt.headX = 0.3; tgt.lean = 0.1; tgt.bodyY = breathe + Math.abs(chop) * 0.006;
        tgt.roll = Math.sin(this.t * 1.5) * 0.02;
        break;
      }
      case 'sit': case 'eat':
        tgt.legL = -1.5; tgt.legR = -1.5; tgt.bodyY = -0.06; tgt.armL = [-0.5, 0.1]; tgt.armR = [-0.5, -0.1];
        tgt.headY = this.look.yaw * 0.6; tgt.headX = this.look.pitch;
        if (this.anim === 'eat') { const b = (Math.sin(this.t * 3) + 1) / 2; tgt.armR = [-1.4 - b * 0.9, -0.5 + b * 0.2]; tgt.headX = 0.12 - b * 0.12; tgt.headY = 0; }
        break;
      case 'wave':
        tgt.armR = [-2.7, -0.4 + Math.sin(this.t * 10) * 0.35]; tgt.bodyY = breathe; tgt.roll = -0.05; tgt.headX = -0.08;
        break;
      case 'cheer':
        tgt.armL = [-2.8, 0.5]; tgt.armR = [-2.8, -0.5]; tgt.bodyY = Math.abs(Math.sin(this.t * 8)) * 0.12; tgt.headX = -0.2;
        break;
      case 'angry':
        tgt.armL = [-0.3, 0.6]; tgt.armR = [-0.3, -0.6]; tgt.headX = 0.12; tgt.bodyY = Math.abs(Math.sin(this.t * 12)) * 0.025; tgt.lean = 0.06;
        break;
    }
    const k = 1 - Math.exp(-dt * 14);
    const p = this.pose;
    p.bodyY = lerp(p.bodyY, tgt.bodyY, k); p.lean = lerp(p.lean, tgt.lean, k);
    p.roll = lerp(p.roll, tgt.roll, k); p.twist = lerp(p.twist, tgt.twist, k);
    const kh = 1 - Math.exp(-dt * 5); // heads turn more lazily than limbs
    p.headX = lerp(p.headX, tgt.headX, kh); p.headY = lerp(p.headY, tgt.headY, kh);
    p.armL = [lerp(p.armL[0], tgt.armL[0], k), lerp(p.armL[1], tgt.armL[1], k)];
    p.armR = [lerp(p.armR[0], tgt.armR[0], k), lerp(p.armR[1], tgt.armR[1], k)];
    p.legL = lerp(p.legL, tgt.legL, k); p.legR = lerp(p.legR, tgt.legR, k);
    const [body, chest, head, , armL, armR, legL, legR] = this.bones;
    body.position.y = HIP + p.bodyY;
    body.rotation.set(p.lean, p.twist, p.roll);
    head.rotation.set(p.headX, p.headY - p.twist * 0.8, -p.roll * 0.6);
    chest.scale.set(1, 1 + breathe * 1.2, 1);
    armL.rotation.set(p.armL[0], 0, p.armL[1]);
    armR.rotation.set(p.armR[0], 0, p.armR[1]);
    legL.rotation.x = p.legL; legR.rotation.x = p.legR;
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
