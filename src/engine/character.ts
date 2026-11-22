// Procedural cartoon character: chibi proportions built from lathe-turned, tapered parts, baked into
// 7 vertex-colored meshes (head, eyes, torso, 2 arms, 2 legs). Each avatar gets a stable "personality"
// (eye shape, brows, mouth, shoes, blush) derived from its fields, plus idle life (blinks, look-around,
// weight shifts) and smooth pose blending.
import * as THREE from 'three';
import { Avatar } from '../core/state';
import { VC_MAT, at, merge, paint, shade } from './geo';

export type Anim = 'idle' | 'walk' | 'run' | 'jump' | 'cook' | 'carry' | 'sit' | 'wave' | 'eat' | 'interact' | 'cheer' | 'angry';

export interface Outfit {
  apron?: boolean | string;
  tie?: string; bag?: string; vest?: string; trim?: string;
  cut?: 'coat' | 'blazer' | 'workwear' | 'knit';
  glasses?: 'round' | 'square';
  detail?: 'freckles' | 'stubble' | 'moustache' | 'earrings';
}

/** Hair style names for 0..8 (UI can show these). */
export const HAIR_STYLE_NAMES = ['Short', 'Messy', 'Long', 'Bun', 'Bald', 'Bob', 'Ponytail', 'Twin tails', 'Side part'];
export const FACE_STYLE_NAMES = ['Soft', 'Long', 'Square', 'Tapered', 'Round'];
export const UNIFORM_STYLE_NAMES = ['Indigo apron', 'Brick apron', 'Canvas apron'];
const UNIFORMS = ['#344654', '#803c36', '#cbb386'];

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
const FACE = [
  { width: 0.95, height: 0.96, jaw: 0.91, eyes: 1, brow: 0.15, nose: 1, mouth: 0 },
  { width: 0.88, height: 1.07, jaw: 0.98, eyes: 0.84, brow: -0.02, nose: 1.25, mouth: 3 },
  { width: 1.01, height: 0.95, jaw: 1.15, eyes: 0.81, brow: -0.14, nose: 1.12, mouth: 3 },
  { width: 0.98, height: 1.01, jaw: 0.76, eyes: 1.12, brow: 0.24, nose: 0.83, mouth: 1 },
  { width: 1.07, height: 0.91, jaw: 1.02, eyes: 1.17, brow: 0.11, nose: 0.91, mouth: 0 },
] as const;

interface Persona {
  face: typeof FACE[number]; shoe: string; sole: string; iris: string;
}

function persona(a: Avatar): Persona {
  let h = 2166136261;
  for (const ch of a.skin + a.hair) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const ordinal = h >>> 0;
  const shoes: [string, string][] = [['#3b2a20', '#1f1612'], ['#1e1e24', '#111'], ['#f4f1ea', '#d94b3d'], ['#f4f1ea', '#2b5aa8'], ['#7a4a2a', '#2a1a10']];
  const s = shoes[ordinal % shoes.length];
  const iris = ['#51362c', '#76523a', '#393038', '#48534c'][(ordinal >>> 8) % 4];
  return { face: FACE[a.faceStyle ?? 0] ?? FACE[0], shoe: s[0], sole: s[1], iris };
}

// ---------------------------------------------------------------- head (face looks toward +z)
function capHair(h: string, r = 0.318, theta = 0.5, tilt = -0.28): THREE.BufferGeometry {
  return paint(at(new THREE.SphereGeometry(r, sg(14), sg(7, 2), 0, Math.PI * 2, 0, Math.PI * theta), 0, 0.02, -0.015, tilt, 0, 0), h);
}

function buildHead(a: Avatar, p: Persona, outfit: Outfit): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const skin = a.skin, h = a.hair, face = p.face;
  const skull = sphere(0.3, 25, 19);
  const vertices = skull.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const y = vertices.getY(i);
    const jaw = THREE.MathUtils.smoothstep(-y, 0.035, 0.205);
    const x = vertices.getX(i) * (1 + (face.jaw - 1) * jaw);
    const z = vertices.getZ(i);
    vertices.setXYZ(i, x, y * 0.94, z > 0 ? z * 0.96 + jaw * 0.009 : z * 0.96);
  }
  skull.computeVertexNormals();
  parts.push(paint(skull, skin));
  for (const side of [-1, 1]) {
    const ear = side * 0.284;
    parts.push(paint(at(sphere(0.064, 8, 6), ear, -0.042, -0.009, 0, 0, side * -0.17, 0.55, 1, 0.8), skin));
    if (!FAR) {
      parts.push(paint(at(sphere(0.03, 6, 4), ear + side * 0.014, -0.04, 0.027, 0, 0, 0, 0.55, 0.8, 0.27), shade(skin, 0.8)));
      if (outfit.detail === 'earrings') parts.push(paint(at(torus(0.025, 0.006), ear + side * 0.021, -0.1, 0.020, 0, side * 0.35), '#bf9650'));
    }
    const brow = a.hairStyle === 4 && outfit.detail !== 'moustache' ? shade(skin, 0.52) : shade(h, 0.8);
    parts.push(paint(at(capsule(0.010, 0.056, 2, 5), side * 0.109, 0.083, 0.269, 0, side * 0.35, Math.PI / 2 - side * face.brow), brow));
    if (!FAR && outfit.detail === 'freckles') {
      for (let i = 0; i < 4; i++) {
        const x = 0.119 + i * 0.021, y = -0.045 - (i % 2) * 0.016;
        const z = Math.sqrt(0.3 ** 2 - x * x - y * y) * 0.96 + 0.004;
        parts.push(paint(at(sphere(0.007, 5, 4), x * side, y, z, 0, side * 0.35, 0, 1, 0.8, 0.35), shade(skin, 0.62)));
      }
    }
  }
  parts.push(paint(at(sphere(0.034, 9, 7), 0, -0.042, 0.285, -0.25, 0, 0, 0.85, 0.87, face.nose), shade(skin, 0.94)));

  const lip = new THREE.Color(skin).lerp(new THREE.Color('#5d2d2a'), 0.57).getStyle();
  if (face.mouth === 0) {
    parts.push(paint(at(torus(0.037, 0.007, Math.PI), 0, -0.096, 0.273, Math.PI, 0, 0, 1.22, 0.58, 1), lip));
  } else if (face.mouth === 1) {
    parts.push(paint(at(sphere(0.034, 9, 6), 0, -0.118, 0.274, -0.15, 0, 0.14, 1.22, 0.49, 0.22), lip));
  } else {
    parts.push(paint(at(capsule(0.006, 0.045, 2, 5), 0, -0.113, 0.277, 0, 0, Math.PI / 2 - 0.12), lip));
  }

  if (outfit.detail === 'moustache') {
    for (const side of [-1, 1]) {
      const curve = capsule(0.016, 0.050, 2, 6);
      parts.push(paint(at(curve, side * 0.034, -0.077, 0.295, 0, side * 0.28, Math.PI / 2 + side * 0.24), h));
      parts.push(paint(at(capsule(0.024, 0.048, 2, 5), side * 0.27, -0.003, -0.047, 0.4, 0, side * 0.36), h));
    }
  } else if (outfit.detail === 'stubble' && !FAR) {
    for (let i = 0; i < 12; i++) {
      const x = (i % 6 - 2.5) * 0.025, y = -0.155 - Math.floor(i / 6) * 0.029;
      const z = Math.sqrt(0.3 ** 2 - x * x - (y / 0.94) ** 2) * 0.96 + 0.014;
      parts.push(paint(at(sphere(0.005, 4, 3), x, y, z, 0, 0, 0, 1, 1, 0.5), shade(skin, 0.59)));
    }
  }

  if (outfit.glasses) {
    const tint = outfit.glasses === 'round' ? '#9a794e' : '#3d3435';
    for (const side of [-1, 1]) {
      const x = side * 0.109;
      if (outfit.glasses === 'round') {
        parts.push(paint(at(torus(0.068, 0.007), x, 0.007, 0.309, 0, side * 0.13, 0, 1, 0.87, 1), tint));
      } else {
        for (const y of [-0.041, 0.055]) parts.push(paint(at(capsule(0.007, 0.116, 2, 5), x, y, 0.310, 0, side * 0.1, Math.PI / 2), tint));
        for (const offset of [-0.062, 0.062]) parts.push(paint(at(capsule(0.007, 0.085, 2, 5), x + offset, 0.007, 0.309 - side * offset * 0.1), tint));
      }
      parts.push(paint(at(box(0.010, 0.012, 0.125), side * 0.181, 0.028, 0.247, 0, side * -0.54, 0), tint));
    }
    parts.push(paint(at(box(0.079, 0.011, 0.012), 0, 0.021, 0.317), tint));
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
    case 1: // folded kitchen cap with a flat, sewn crown
      parts.push(paint(at(lathe([[0.239, 0.225], [0.265, 0.249], [0.273, 0.295], [0.269, 0.35], [0.239, 0.398], [0.185, 0.417], [0, 0.422]], 20), 0, 0, 0.006, -0.07), '#eae2d1'));
      parts.push(paint(at(lathe([[0.252, 0.243], [0.267, 0.257], [0.271, 0.275]], 18), 0, 0, 0.007, -0.07), '#d1c4ae'));
      if (!FAR) for (const x of [-0.112, -0.056, 0, 0.056, 0.112]) {
        parts.push(paint(at(capsule(0.004, 0.061, 2, 5), x, 0.333, Math.sqrt(0.26 ** 2 - x * x) - 0.006, -0.19, 0, -x * 0.6), '#cbbda8'));
      }
      break;
    case 2: // hachimaki headband with a red rising-sun dot and knotted tails
      parts.push(paint(lathe([[0.314, 0.095], [0.322, 0.103], [0.321, 0.143], [0.313, 0.15]], 22), '#ebe0c9'));
      parts.push(paint(at(new THREE.CircleGeometry(0.021, sg(10)), 0, 0.121, 0.324), '#a4443b'));
      parts.push(paint(at(sphere(0.033), -0.037, 0.122, -0.323), '#ebe0c9'));
      for (const side of [-1, 1]) parts.push(paint(at(capsule(0.018, 0.122, 2, 6), -0.042 + side * 0.027, 0.043, -0.333, 0.23, 0, side * 0.49, 1, 1, 0.33), '#dfd5c0'));
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
  for (const side of [-1, 1]) {
    const x = side * 0.110, yaw = side * 0.26;
    const height = p.face.eyes;
    parts.push(paint(at(sphere(0.047, 11, 8), x, 0.010, 0.263, 0, yaw, 0, 1.07, height, 0.44), '#f8eee3'));
    parts.push(paint(at(sphere(0.032, 9, 7), x + 0.002, 0.011, 0.283, 0, yaw, 0, 0.91, height, 0.48), p.iris));
    parts.push(paint(at(sphere(0.019, 8, 6), x + 0.003, 0.012, 0.296, 0, yaw, 0, 0.85, height, 0.54), '#221d20'));
    parts.push(paint(at(sphere(0.008, 5, 4), x - 0.006, 0.023, 0.305), '#fff9ef'));
    if (!FAR) parts.push(paint(at(torus(0.042, 0.004, Math.PI), x, 0.011, 0.280, 0, yaw, 0, 1.13, height, 1), '#4c322e'));
  }
  return merge(parts);
}

// ---------------------------------------------------------------- body
function clothPanel(points: [number, number][], z: number, color: string): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
  shape.closePath();
  return paint(at(new THREE.ExtrudeGeometry(shape, {
    depth: 0.007, bevelEnabled: !FAR, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1,
  }), 0, 0, z), color);
}

function workCut(o: Outfit): NonNullable<Outfit['cut']> | undefined { return o.cut ?? (o.apron === true ? 'coat' : undefined); }

function buildTorso(a: Avatar, o: Outfit): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const z = 0.78; // depth squash: bodies are a little flatter than round
  const cut = workCut(o);
  const jacket = o.vest ?? a.shirt;
  const trimColor = o.trim ?? shade(jacket, 1.27);
  // pants / hips (tapered lathe), belt, shirt (waist → chest → shoulders)
  parts.push(paint(at(lathe([[0.001, -0.04], [0.17, -0.03], [0.195, 0.04], [0.185, 0.16]]), 0, 0, 0, 0, 0, 0, 1, 1, z), a.pants));
  parts.push(paint(at(torus(0.183, 0.022), 0, 0.15, 0, Math.PI / 2, 0, 0, 1, z, 1), '#2b2220'));
  parts.push(paint(at(box(0.06, 0.045, 0.02), 0, 0.15, 0.148), '#d4a017'));
  parts.push(paint(at(lathe([[0.18, 0.15], [0.17, 0.24], [0.19, 0.36], [0.205, 0.45], [0.16, 0.52], [0.06, 0.55], [0.001, 0.555]]), 0, 0, 0, 0, 0, 0, 1, 1, z), a.shirt));
  parts.push(paint(at(cyl(0.062, 0.07, 0.1, 6), 0, 0.58, 0), a.skin)); // neck
  // collar points + buttons + chest pocket
  const trim = shade(a.shirt, a.shirt === '#ffffff' ? 0.92 : 0.8);
  for (const sx of [-1, 1]) parts.push(paint(at(box(0.08, 0.05, 0.02), sx * 0.045, 0.52, 0.115, -0.5, 0, sx * 0.6), trim));
  if (!o.apron && !o.vest && !cut) {
    if (!FAR) for (const y of [0.25, 0.33, 0.41]) parts.push(paint(at(sphere(0.011, 4, 2), 0, y, 0.152 - (0.41 - y) * 0.02), shade(a.shirt, 0.7)));
    if (!FAR) parts.push(paint(at(box(0.07, 0.07, 0.012), -0.09, 0.38, 0.152, -0.12, 0, 0), trim));
  }
  if (cut === 'coat') {
    parts.push(clothPanel([[-0.11, 0.517], [-0.04, 0.532], [0.111, 0.369], [0.071, 0.326]], 0.141, trimColor));
    parts.push(clothPanel([[0.091, 0.525], [0.138, 0.500], [-0.045, 0.354], [-0.068, 0.385]], 0.158, shade(a.shirt, 0.88)));
    for (const y of [0.401, 0.453]) parts.push(paint(at(sphere(0.011, 5, 4), 0.105, y, 0.152), shade(a.shirt, 0.72)));
  } else if (cut === 'blazer' || cut === 'workwear') {
    parts.push(paint(at(lathe([[0.193, 0.16], [0.184, 0.24], [0.202, 0.36], [0.21, 0.445], [0.169, 0.502]]), 0, 0, 0, 0, 0, 0, 1.03, 1, 0.82), jacket));
    parts.push(clothPanel([[-0.095, 0.501], [0.095, 0.501], [0.047, 0.261], [-0.047, 0.261]], 0.153, a.shirt));
    for (const side of [-1, 1]) {
      if (cut === 'blazer') {
        parts.push(clothPanel([[side * 0.11, 0.505], [side * 0.145, 0.447], [side * 0.107, 0.429], [side * 0.122, 0.396], [side * 0.032, 0.31]], 0.171, shade(jacket, 1.19)));
      } else {
        parts.push(clothPanel([[side * 0.045, 0.505], [side * 0.14, 0.485], [side * 0.103, 0.421], [side * 0.066, 0.451]], 0.169, trimColor));
        parts.push(clothPanel([[side * 0.117, 0.373], [side * 0.174, 0.373], [side * 0.176, 0.299], [side * 0.12, 0.290]], 0.153, shade(jacket, 1.35)));
      }
    }
    if (!FAR) {
      parts.push(paint(at(box(0.067, 0.013, 0.017), -0.116, 0.284, 0.159), trimColor));
      for (const y of [0.217, 0.274]) parts.push(paint(at(sphere(0.008, 5, 4), 0.024, y, 0.173), '#ac8a60'));
    }
  } else if (cut === 'knit') {
    for (const [y, width] of [[0.198, 0.177], [0.252, 0.178], [0.32, 0.19], [0.394, 0.201]]) {
      parts.push(paint(at(lathe([[width, y], [width + 0.005, y + 0.024]]), 0, 0, 0, 0, 0, 0, 1, 1, 0.80), trimColor));
    }
    parts.push(paint(at(torus(0.071, 0.011), 0, 0.546, 0, Math.PI / 2, 0, 0, 1, 0.83), trimColor));
  } else if (o.vest) {
    parts.push(paint(at(lathe([[0.19, 0.17], [0.178, 0.25], [0.198, 0.36], [0.21, 0.45], [0.17, 0.5]]), 0, 0, 0, 0, 0, 0, 1.02, 1, z * 1.03), o.vest));
    parts.push(paint(at(box(0.07, 0.3, 0.02), 0, 0.33, 0.152), a.shirt)); // shirt placket between lapels
    if (!FAR) for (const y of [0.24, 0.31]) parts.push(paint(at(sphere(0.012, 4, 2), 0.045, y, 0.16), '#d4af37'));
  }
  if (o.tie) {
    parts.push(clothPanel([[-0.025, 0.496], [0.025, 0.496], [0.014, 0.451], [-0.015, 0.451]], 0.18, o.tie));
    parts.push(clothPanel([[-0.013, 0.45], [0.013, 0.45], [0.027, 0.298], [0, 0.271], [-0.025, 0.298]], 0.182, shade(o.tie, 0.94)));
  }
  if (o.apron) {
    const apron = typeof o.apron === 'string' ? o.apron : UNIFORMS[a.uniformStyle ?? 0] ?? UNIFORMS[0];
    const seam = o.trim ?? shade(apron, 1.48);
    parts.push(clothPanel([[-0.085, 0.374], [0.085, 0.374], [0.106, 0.254], [0.155, 0.209], [0.152, -0.106], [0.113, -0.125], [-0.131, -0.116], [-0.157, -0.094], [-0.154, 0.209], [-0.104, 0.26]], 0.176, apron));
    parts.push(clothPanel([[-0.151, 0.221], [0.151, 0.221], [0.15, 0.202], [-0.15, 0.202]], 0.191, seam));
    for (const side of [-1, 1]) {
      parts.push(paint(at(capsule(0.013, 0.138, 2, 5), side * 0.106, 0.441, 0.136, -0.29, 0, side * -0.55, 1.02, 1, 0.51), apron));
      parts.push(paint(at(capsule(0.008, 0.19, 2, 5), side * 0.159, 0.214, 0.05, Math.PI / 2, 0, 0), seam));
    }
    if (!FAR) {
      parts.push(clothPanel([[0.015, 0.119], [0.117, 0.119], [0.116, 0.056], [0.097, 0.033], [0.033, 0.033], [0.016, 0.055]], 0.190, shade(apron, 0.79)));
      parts.push(clothPanel([[0.017, 0.117], [0.116, 0.117], [0.115, 0.107], [0.018, 0.107]], 0.201, seam));
      parts.push(clothPanel([[-0.062, 0.335], [-0.034, 0.335], [-0.034, 0.304], [-0.062, 0.304]], 0.191, '#b59a68'));
    }
  }
  if (o.bag) {
    parts.push(paint(at(capsule(0.13, 0.12, 2, 8), 0, 0.3, -0.2, 0, 0, 0, 1.1, 1, 0.55), o.bag));
    parts.push(paint(at(box(0.16, 0.08, 0.04), 0, 0.22, -0.27), shade(o.bag, 0.8)));
    for (const sx of [-1, 1]) parts.push(paint(at(torus(0.15, 0.014, Math.PI), sx * 0.11, 0.38, -0.03, 0, Math.PI / 2, 0, 1, 1.05, 1), shade(o.bag, 0.7)));
  }
  return merge(parts);
}

function buildArm(a: Avatar, o: Outfit, side: 1 | -1): THREE.BufferGeometry {
  // pivot at the shoulder; hangs down -y. Tapered sleeve, cuff, mitten hand with a thumb nub.
  const cut = workCut(o);
  const sleeve = cut === 'blazer' || cut === 'workwear' ? o.vest ?? a.shirt : a.shirt;
  const cuff = cut === 'blazer' ? a.shirt : o.trim ?? shade(sleeve, 0.80);
  const parts = [
    paint(sphere(0.078, 8, 6), sleeve),
    paint(at(lathe([[0.001, -0.31], [0.059, -0.3], [0.069, -0.15], [0.075, 0]], 10), 0, 0, 0), sleeve),
    paint(at(torus(0.056, 0.012), 0, -0.305, 0, Math.PI / 2, 0, 0), cuff),
    paint(at(sphere(0.066, 7, 6), 0, -0.37, 0.005, 0, 0, 0, 0.9, 1.05, 0.8), a.skin),
    paint(at(sphere(0.027, 5, 4), -side * 0.045, -0.35, 0.035), a.skin),
  ];
  if (cut === 'knit') {
    for (const [y, width] of [[-0.24, 0.064], [-0.175, 0.069], [-0.11, 0.072]]) {
      parts.push(paint(lathe([[width, y], [width + 0.003, y + 0.021]], 10), cuff));
    }
  }
  return merge(parts);
}

function buildLeg(a: Avatar, p: Persona, o: Outfit): THREE.BufferGeometry {
  const cut = workCut(o);
  const shoe = cut === 'blazer' ? '#4c382f' : cut === 'coat' ? '#413a34' : p.shoe;
  const sole = cut === 'blazer' || cut === 'coat' ? '#2c2727' : p.sole;
  return merge([
    paint(lathe([[0.001, -0.41], [0.066, -0.4], [0.07, -0.33], [0.084, -0.12], [0.088, 0.02]], 10), a.pants),
    paint(at(sphere(0.075, 10, 7), 0, -0.458, 0.03, 0, 0, 0, 0.91, 0.62, 1.58), shoe),
    paint(at(lathe([[0, -0.502], [0.07, -0.502], [0.074, -0.489], [0.069, -0.477]], 10), 0, 0, 0.035, 0, 0, 0, 0.97, 1, 1.56), sole),
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
    [buildHead(a, p, o).scale(p.face.width, p.face.height, 1), B.Head],
    [buildEyes(p).scale(p.face.width, p.face.height, 1), B.Eyes], [buildTorso(a, o), B.Chest],
    [buildArm(a, o, -1), B.ArmL], [buildArm(a, o, 1), B.ArmR], [buildLeg(a, p, o), B.LegL], [buildLeg(a, p, o), B.LegR],
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
