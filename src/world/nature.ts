// Nature and small life for the architect's-model city: sculpted sakura, ginkgo street trees in cast-iron grates,
// cloud-pruned pines, clipped hedges, potted plants at doors, temple moss and grass, drifting petals, pigeons and crows
// that flock away from the player, cats on walls and benches, and daytime butterflies.
//
// API
//   buildNature(id, group, colliders) -> { update(dt, playerPos) }   one call per district build
//   potAt(x, z, ry?)  queue a potted plant (world coords) from any builder that runs before buildNature (e.g. shop doors)
//
// Everything is InstancedMesh. Vegetation shares one flat-shaded material whose vertex shader sways it in the wind
// (per-vertex `flex` = sway amplitude in metres, phase from the instance position), so wind costs no CPU.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DistrictId } from '../core/data';
import { Collider } from '../engine/collision';
import { rng } from './kit';
import { PALETTE, bevelBox, mat, nightGlow } from './materials';

type V3 = THREE.Vector3;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), ONE = V(1, 1, 1);
const TAU = Math.PI * 2;
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)];

// ---------------------------------------------------------------- materials (vertex-coloured: district dispose skips them)
const wind = { value: 0 };
const WIND_MAT = (() => {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = wind;
    sh.uniforms.uNight = nightGlow;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * clamp(uNight - 0.05, 0.0, 1.0) * 0.09;');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;\nattribute float flex;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 wp = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
#else
  vec2 wp = vec2(0.0);
#endif
  float ph = dot(wp, vec2(0.37, 0.23));
  float gust = 0.6 + 0.4 * sin(uWind * 0.29 + ph * 0.13);
  float flut = sin(uWind * 5.7 + dot(position, vec3(7.1, 3.3, 5.7))) * 0.22;
  transformed.x += flex * (sin(uWind * 1.6 + ph) * gust + flut);
  transformed.z += flex * (cos(uWind * 1.25 + ph * 1.7) * 0.6 * gust + flut);`);
  };
  m.customProgramCacheKey = () => 'nature-wind';
  return m;
})();
/** Thin double-sided parts (wings, petals). */
const THIN_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });

// ---------------------------------------------------------------- geometry assembly
type Fn = (x: number, y: number, z: number) => number;
interface PartOpts { flex?: Fn; shade?: Fn; jitter?: number }
/** Collects parts into one non-indexed geometry with `color` and `flex` attributes (per-face colour jitter = papercraft facets). */
class Geo {
  parts: THREE.BufferGeometry[] = [];
  constructor(private r: () => number) {}
  add(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4, o: PartOpts = {}): this {
    const g = src.index ? src.toNonIndexed() : src.clone();
    src.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.applyMatrix4(m);
    const p = g.attributes.position, n = p.count, base = new THREE.Color(color), jit = o.jitter ?? 0.07;
    const col = new Float32Array(n * 3), fx = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      const k = 1 + (this.r() - 0.5) * 2 * jit;
      for (let j = i; j < i + 3 && j < n; j++) {
        const x = p.getX(j), y = p.getY(j), z = p.getZ(j), s = k * (o.shade ? o.shade(x, y, z) : 1);
        col[j * 3] = base.r * s; col[j * 3 + 1] = base.g * s; col[j * 3 + 2] = base.b * s;
        fx[j] = o.flex ? o.flex(x, y, z) : 0;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('flex', new THREE.BufferAttribute(fx, 1));
    this.parts.push(g);
    return this;
  }
  at(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, pos: V3, o: PartOpts & { rot?: THREE.Euler | THREE.Quaternion; scale?: V3 } = {}): this {
    const q = o.rot instanceof THREE.Euler ? new THREE.Quaternion().setFromEuler(o.rot) : o.rot ?? new THREE.Quaternion();
    return this.add(src, color, new THREE.Matrix4().compose(pos, q, o.scale ?? ONE), o);
  }
  /** Tapered branch from a to b (open-ended; joints are hidden by knots, parents or foliage). */
  limb(a: V3, b: V3, r0: number, r1: number, color: THREE.ColorRepresentation, o: PartOpts = {}, seg = 6): this {
    const d = b.clone().sub(a), len = d.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).translate(0, len / 2, 0);
    return this.add(g, color, new THREE.Matrix4().compose(a, new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), ONE), { jitter: 0.05, ...o });
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts)!;
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}
const rot = (r: () => number) => new THREE.Euler(r() * TAU, r() * TAU, r() * TAU);
const hiLo = (y0: number, y1: number, lo = 0.8, hi = 1.1): Fn => (_x, y) => lo + (hi - lo) * THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1);
const woodFlex = (k: number): Fn => (_x, y) => k * Math.pow(Math.max(0, y - 0.35), 1.6);
/** Fallen petals / needles: tiny flat triangles scattered on the ground (density peaks at the trunk). */
function groundScatter(G: Geo, r: () => number, n: number, rad: number, colors: readonly string[], size = 0.05): void {
  for (let i = 0; i < n; i++) {
    const a = r() * TAU, d = rad * Math.pow(r(), 0.75), s = size * (0.6 + r() * 0.8);
    const t = new THREE.BufferGeometry();
    t.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -s, s * 0.8, 0, s * 0.5, -s * 0.8, 0, s * 0.5], 3));
    t.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    G.at(t, pick(r, colors), V(Math.cos(a) * d, 0.022 + r() * 0.008, Math.sin(a) * d), { rot: new THREE.Euler(0, r() * TAU, 0), jitter: 0.1 });
  }
}

// ---------------------------------------------------------------- vegetation models (unit scale, trunk at origin)
const BARK = '#5a4337', BARK_PINE = '#6b5244';
const PINKS = ['#f2bfd0', '#eeb3c6', '#f5cad8', '#e8a5bb', '#f7d3de', '#eaaec2'] as const;
const GINKGO = ['#b7c174', '#a6b465', '#c6cc88', '#98aa5c', '#bfc77d'] as const;
const PINE = ['#4d6a47', '#587650', '#44603f', '#62805a'] as const;
const LEAF = [PALETTE.foliage, PALETTE.foliageDark, '#7d9668', '#71895f'] as const;

/** Sakura: S-leaning trunk with a root flare, 4-5 spreading limbs that fork twice, blossom clouds of small facets at every tip. */
function sakuraGeo(seed: number): THREE.BufferGeometry {
  const r = rng(seed), G = new Geo(r), wf = woodFlex(0.011);
  const lean = V((r() - 0.5) * 0.7, 0, (r() - 0.5) * 0.7);
  const p1 = V(lean.x * 0.35, 1.0, lean.z * 0.35), p2 = V(lean.x, 1.85, lean.z);
  G.limb(V(0, -0.05, 0), p1, 0.25, 0.19, BARK, { flex: wf }, 8).limb(p1, p2, 0.19, 0.15, BARK, { flex: wf }, 8);
  G.at(new THREE.IcosahedronGeometry(0.19, 0), BARK, p1, { flex: wf }).at(new THREE.IcosahedronGeometry(0.17, 0), BARK, p2, { flex: wf });
  for (let i = 0; i < 5; i++) { // root flare
    const a = (i / 5) * TAU + r() * 0.5;
    G.limb(V(Math.cos(a) * 0.06, 0.45, Math.sin(a) * 0.06), V(Math.cos(a) * 0.42, -0.02, Math.sin(a) * 0.42), 0.1, 0.03, BARK, {}, 5);
  }
  const tips: V3[] = [];
  const nL = 4 + (r() < 0.5 ? 1 : 0);
  for (let i = 0; i < nL; i++) {
    const a = (i / nL) * TAU + r() * 0.7, el = 0.42 + r() * 0.4, len = 1.5 + r() * 0.7;
    const dir = V(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const m1 = p2.clone().addScaledVector(dir, len * 0.55);
    const d2 = dir.clone().setY(dir.y * 0.55).normalize();
    const e1 = m1.clone().addScaledVector(d2, len * 0.45);
    G.limb(p2, m1, 0.12, 0.085, BARK, { flex: wf }).limb(m1, e1, 0.085, 0.05, BARK, { flex: wf });
    G.at(new THREE.IcosahedronGeometry(0.085, 0), BARK, m1, { flex: wf });
    tips.push(e1, m1.clone().add(V(0, 0.35, 0)));
    for (const s of [-1, 1]) {
      const ya = a + s * (0.45 + r() * 0.4), ce = 0.35 + r() * 0.5, cl = 0.7 + r() * 0.5;
      const cd = V(Math.cos(ya) * Math.cos(ce), Math.sin(ce), Math.sin(ya) * Math.cos(ce));
      const from = s < 0 ? e1 : m1.clone().lerp(e1, 0.6);
      const t = from.clone().addScaledVector(cd, cl);
      G.limb(from, t, 0.045, 0.02, BARK, { flex: wf }, 5);
      tips.push(t);
    }
  }
  // blossom clouds: many small flattened facets around each tip, lighter toward the crown
  const top = Math.max(...tips.map((t) => t.y)) + 0.5;
  // each tip carries a soft core cloud with small facets studding its surface: cohesive masses, crafted texture
  const bloom: PartOpts = { flex: (x, y, z) => wf(x, y, z) + 0.02, shade: hiLo(1.6, top, 0.8, 1.04), jitter: 0.05 };
  for (const tip of tips) {
    const R = 0.34 + r() * 0.2, c0 = tip.clone().add(V((r() - 0.5) * 0.2, 0.18, (r() - 0.5) * 0.2));
    G.at(new THREE.IcosahedronGeometry(R, 1), pick(r, PINKS), c0, { ...bloom, rot: rot(r), scale: V(1.15, 0.72, 1.15) });
    const n = 12 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const d = V(r() - 0.5, r() * 0.9 - 0.25, r() - 0.5).normalize();
      const c = c0.clone().add(d.multiply(V(R * 1.1, R * 0.7, R * 1.1)));
      G.at(new THREE.IcosahedronGeometry(0.1 + r() * 0.1, 0), pick(r, PINKS), c, { ...bloom, rot: rot(r), scale: V(1, 0.8, 1) });
    }
  }
  groundScatter(G, r, 240, 2.6, ['#f2c3d2', '#f6d4de', '#eab2c4', '#f9e3ea'], 0.07);
  return G.build();
}

/** Ginkgo street tree: straight trunk, short climbing branches, a narrow faceted crown. */
function ginkgoGeo(seed: number): THREE.BufferGeometry {
  const r = rng(seed), G = new Geo(r), wf = woodFlex(0.008);
  const top = V((r() - 0.5) * 0.15, 4.7, (r() - 0.5) * 0.15);
  G.limb(V(0, -0.05, 0), V(0, 2.2, 0), 0.15, 0.115, BARK, { flex: wf }, 7).limb(V(0, 2.2, 0), top, 0.115, 0.04, BARK, { flex: wf }, 6);
  for (let i = 0; i < 8; i++) {
    const y = 2.0 + i * 0.3, a = i * 2.4 + r() * 0.4, el = 0.9 + r() * 0.25, len = 1.0 * (1 - i / 11);
    const from = V(top.x * (y / 4.7), y, top.z * (y / 4.7));
    G.limb(from, from.clone().add(V(Math.cos(a) * Math.cos(el) * len, Math.sin(el) * len, Math.sin(a) * Math.cos(el) * len)), 0.04, 0.015, BARK, { flex: wf }, 5);
  }
  const leaf: PartOpts = { flex: (x, y, z) => wf(x, y, z) + 0.02, shade: hiLo(2.0, 5.6, 0.8, 1.1), jitter: 0.05 };
  for (let k = 0; k < 9; k++) { // stacked crown masses tapering to a point, studded with small facets
    const t = k / 8, R = 0.95 * Math.pow(1 - t, 0.7) + 0.25, a = k * 2.4 + r(), off = (1 - t) * 0.35;
    const c0 = V(Math.cos(a) * off, 2.3 + t * 2.9, Math.sin(a) * off);
    G.at(new THREE.IcosahedronGeometry(R * 0.8, 1), pick(r, GINKGO), c0, { ...leaf, rot: rot(r), scale: V(1, 0.9, 1) });
    for (let j = 0; j < 7 + R * 6; j++) {
      const d = V(r() - 0.5, r() - 0.45, r() - 0.5).normalize().multiplyScalar(R * 0.82);
      G.at(new THREE.IcosahedronGeometry(0.12 + r() * 0.1, 0), pick(r, GINKGO), c0.clone().add(d), { ...leaf, rot: rot(r) });
    }
  }
  return G.build();
}

/** Cast-iron tree grate (concentric square rings and radial bars) over a soil bed. Static. */
function grateGeo(): THREE.BufferGeometry {
  const G = new Geo(rng(5)), iron = '#45474b';
  G.at(new THREE.BoxGeometry(1.5, 0.02, 1.5), '#6d5a49', V(0, 0.01, 0), { jitter: 0 });
  for (const [h, w] of [[0.75, 0.09], [0.5, 0.05], [0.3, 0.045]] as const)
    for (const s of [-1, 1]) {
      G.at(new THREE.BoxGeometry(h * 2 + w, 0.035, w), iron, V(0, 0.035, s * h), { jitter: 0.02 });
      G.at(new THREE.BoxGeometry(w, 0.035, h * 2 + w), iron, V(s * h, 0.035, 0), { jitter: 0.02 });
    }
  for (let i = 0; i < 16; i++) { // radial bars between the inner and outer rings
    const a = (i / 16) * TAU, c = V(Math.cos(a), 0, Math.sin(a));
    const sq = 1 / Math.max(Math.abs(c.x), Math.abs(c.z)); // ray length to a unit square
    const a0 = 0.3 * sq, a1 = 0.75 * sq, mid = (a0 + a1) / 2;
    G.at(new THREE.BoxGeometry(0.025, 0.03, a1 - a0), iron, V(c.x * mid, 0.035, c.z * mid), { rot: new THREE.Euler(0, Math.atan2(c.x, c.z), 0), jitter: 0 });
  }
  return G.build();
}

/** Niwaki pine: S-curved trunk, near-horizontal limbs, each ending in a flat cloud pad. */
function pineGeo(seed: number): THREE.BufferGeometry {
  const r = rng(seed), G = new Geo(r), wf = woodFlex(0.005);
  const s = r() < 0.5 ? 1 : -1;
  const P = [V(0, -0.05, 0), V(0.35 * s, 0.8, 0.1), V(0.2 * s, 1.6, -0.15), V(-0.2 * s, 2.4, 0), V(-0.1 * s, 3.05, 0.1)];
  const rad = [0.24, 0.19, 0.15, 0.11, 0.07];
  for (let i = 0; i < 4; i++) { G.limb(P[i], P[i + 1], rad[i], rad[i + 1], BARK_PINE, { flex: wf }, 7); G.at(new THREE.IcosahedronGeometry(rad[i + 1] * 1.05, 0), BARK_PINE, P[i + 1], { flex: wf }); }
  const pads: [V3, V3, number][] = [
    [P[1], V(1.4 * s, 1.15, 0.45), 0.95], [P[2], V(-1.3 * s, 1.85, -0.55), 0.85], [P[3], V(1.0 * s, 2.65, -0.5), 0.72],
    [P[3], V(-0.9 * s, 2.85, 0.65), 0.58], [P[4], P[4].clone().add(V(0, 0.25, 0)), 0.7],
  ];
  for (const [from, c, R] of pads) {
    if (from !== P[4]) G.limb(from, c, 0.07, 0.035, BARK_PINE, { flex: wf }, 5);
    const n = 9 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const a = r() * TAU, d = R * Math.sqrt(r());
      const pos = c.clone().add(V(Math.cos(a) * d, 0.12 * (1 - d / R) + r() * 0.05, Math.sin(a) * d));
      G.at(new THREE.IcosahedronGeometry(0.3 + r() * 0.12, 0), pick(r, PINE), pos, {
        rot: new THREE.Euler(r() * 0.4, r() * TAU, r() * 0.4), scale: V(1.25, 0.5, 1.25), flex: (x, y, z) => wf(x, y, z) + 0.008, shade: (_x, y) => (y > c.y + 0.02 ? 1.1 : 0.78),
      });
    }
  }
  groundScatter(G, r, 50, 1.8, ['#8b7a5c', '#9a8866', '#7c6c52'], 0.05);
  return G.build();
}

/** Potted plants: 0 glazed pot + boxwood ball, 1 timber planter + bamboo, 2 terracotta basin + flowering azalea, 3 ceramic pot + mini pine. */
function potGeo(kind: number): THREE.BufferGeometry {
  const r = rng(90 + kind), G = new Geo(r);
  const lathe = (pts: [number, number][], color: string) =>
    G.add(new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 12), color, new THREE.Matrix4(), { shade: hiLo(0, pts[pts.length - 1][1], 0.85, 1.05), jitter: 0.03 });
  const soil = (rr: number, y: number) => G.at(new THREE.CylinderGeometry(rr, rr, 0.02, 12), '#5b4a3c', V(0, y, 0), { jitter: 0 });
  const ball = (c: V3, R: number, n: number, colors: readonly string[], fl = 0.012) => {
    for (let k = 0; k < n; k++) {
      const u = V(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(R * (0.4 + r() * 0.6));
      G.at(new THREE.IcosahedronGeometry(R * (0.42 + r() * 0.2), 0), pick(r, colors), c.clone().add(u), { rot: rot(r), flex: () => fl, shade: hiLo(c.y - R, c.y + R, 0.8, 1.1) });
    }
  };
  if (kind === 0) {
    lathe([[0, 0], [0.17, 0], [0.24, 0.08], [0.27, 0.3], [0.25, 0.42], [0.27, 0.44], [0.26, 0.46], [0, 0.46]], '#3f5872');
    soil(0.24, 0.45);
    G.limb(V(0, 0.45, 0), V(0, 0.62, 0), 0.03, 0.025, BARK, {}, 5);
    ball(V(0, 0.85, 0), 0.34, 16, LEAF);
  } else if (kind === 1) {
    G.at(bevelBox(0.55, 0.5, 0.55, 0.03).clone(), PALETTE.timberDark, V(0, 0.25, 0), { jitter: 0.04 });
    G.at(bevelBox(0.6, 0.04, 0.6, 0.015).clone(), PALETTE.timber, V(0, 0.5, 0), { jitter: 0 });
    soil(0.24, 0.5);
    for (let i = 0; i < 6; i++) {
      const a = r() * TAU, d = 0.05 + r() * 0.12, h = 1.25 + r() * 0.6, base = V(Math.cos(a) * d, 0.5, Math.sin(a) * d);
      const tip = base.clone().add(V((r() - 0.5) * 0.25, h, (r() - 0.5) * 0.25));
      G.limb(base, tip, 0.018, 0.012, '#8a9a52', { flex: (_x, y) => 0.02 * Math.max(0, y - 0.5) }, 5);
      for (let k = 0; k < 5; k++) {
        const c = base.clone().lerp(tip, 0.45 + k * 0.13).add(V((r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3));
        G.at(new THREE.IcosahedronGeometry(0.11 + r() * 0.05, 0), pick(r, ['#86a35f', '#769552', '#93ad6b']), c, { rot: rot(r), scale: V(1.3, 0.45, 1.3), flex: (_x, y) => 0.02 * Math.max(0, y - 0.5) + 0.01 });
      }
    }
  } else if (kind === 2) {
    lathe([[0, 0], [0.26, 0], [0.33, 0.06], [0.36, 0.22], [0.38, 0.25], [0, 0.25]], '#a86b4b');
    soil(0.34, 0.24);
    ball(V(0, 0.42, 0), 0.36, 14, LEAF, 0.008);
    for (let k = 0; k < 26; k++) {
      const a = r() * TAU, e = r() * 1.2, c = V(Math.cos(a) * Math.cos(e) * 0.4, 0.42 + Math.sin(e) * 0.3, Math.sin(a) * Math.cos(e) * 0.4);
      G.at(new THREE.IcosahedronGeometry(0.055, 0), pick(r, ['#e58fa8', '#f2b8c8', '#fbf4ee', '#d9718f']), c, { rot: rot(r), flex: () => 0.01 });
    }
  } else {
    lathe([[0, 0], [0.2, 0], [0.22, 0.04], [0.22, 0.3], [0.24, 0.32], [0, 0.32]], '#8d8f8a');
    soil(0.21, 0.31);
    const P = [V(0, 0.3, 0), V(0.08, 0.5, 0), V(-0.04, 0.72, 0.03), V(0.03, 0.9, 0)];
    for (let i = 0; i < 3; i++) G.limb(P[i], P[i + 1], 0.045 - i * 0.01, 0.035 - i * 0.01, BARK_PINE, {}, 5);
    for (const [c, R] of [[V(0.3, 0.62, 0.05), 0.24], [V(-0.25, 0.8, -0.05), 0.2], [V(0.05, 1.0, 0), 0.22]] as const)
      for (let k = 0; k < 6; k++) {
        const a = r() * TAU, d = R * Math.sqrt(r());
        G.at(new THREE.IcosahedronGeometry(0.1, 0), pick(r, PINE), c.clone().add(V(Math.cos(a) * d, 0, Math.sin(a) * d)), { scale: V(1.3, 0.5, 1.3), rot: new THREE.Euler(0, r() * TAU, 0), flex: () => 0.006, shade: () => 1.05 });
      }
  }
  return G.build();
}

/** Moss island: a low domed fan with a ragged rim (white base, tinted per instance). */
function mossGeo(): THREE.BufferGeometry {
  const r = rng(21), n = 14, rim: V3[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU, d = 0.75 + r() * 0.35; rim.push(V(Math.cos(a) * d, 0.0, Math.sin(a) * d)); }
  const mid = rim.map((p, i) => p.clone().lerp(rim[(i + 1) % n], 0.5).multiplyScalar(0.55).setY(0.05));
  const top = V(0, 0.07, 0), pos: number[] = [];
  const tri = (a: V3, b: V3, c: V3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, mi = mid[i], mp = mid[(i + n - 1) % n];
    tri(top, mi, mp); tri(mp, mi, rim[i]); tri(mi, rim[j], rim[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const G = new Geo(r);
  G.add(g, '#ffffff', new THREE.Matrix4(), { shade: (_x, y) => 0.82 + y * 3, jitter: 0.08 });
  return G.build();
}

/** Grass tuft: a fan of thin blades (both windings), darker at the root. */
function grassGeo(): THREE.BufferGeometry {
  const r = rng(33), pos: number[] = [];
  for (let i = 0; i < 9; i++) {
    const a = r() * TAU, h = 0.16 + r() * 0.2, w = 0.022, lean = 0.05 + r() * 0.1;
    const c = Math.cos(a), s = Math.sin(a), px = -s * w, pz = c * w;
    const tip = [c * lean, h, s * lean];
    pos.push(-px, 0, -pz, px, 0, pz, ...tip, px, 0, pz, -px, 0, -pz, ...tip);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const G = new Geo(r);
  G.add(g, '#8ea567', new THREE.Matrix4(), { shade: hiLo(0, 0.3, 0.55, 1.15), flex: (_x, y) => 0.18 * y, jitter: 0.12 });
  return G.build();
}

// ---------------------------------------------------------------- small life models (face +z)
function birdGeo(crow: boolean): { body: THREE.BufferGeometry; wing: THREE.BufferGeometry } {
  const G = new Geo(rng(crow ? 7 : 8));
  const c = crow ? { body: '#2a2b30', head: '#232428', wing: '#1f2024', neck: '#2f3440', tail: '#1b1c20', beak: '#1a1a1d', leg: '#2a2a2a' }
    : { body: '#a3a7ae', head: '#7d828c', wing: '#90959e', neck: '#6f8f86', tail: '#4f535b', beak: '#3b3b3e', leg: '#c06a5c' };
  const sph = () => new THREE.SphereGeometry(1, 9, 7);
  G.at(sph(), c.body, V(0, 0.13, 0), { scale: V(0.085, 0.08, 0.15), jitter: 0.03 });
  G.at(sph(), c.neck, V(0, 0.19, 0.08), { scale: V(0.055, 0.06, 0.06), jitter: 0.03 });
  G.at(sph(), c.head, V(0, 0.235, 0.115), { scale: V(0.045, 0.045, 0.05), jitter: 0.03 });
  G.at(new THREE.ConeGeometry(crow ? 0.017 : 0.011, crow ? 0.06 : 0.035, 5), c.beak, V(0, crow ? 0.228 : 0.232, crow ? 0.185 : 0.17), { rot: new THREE.Euler(Math.PI / 2, 0, 0) });
  for (const s of [-1, 1]) {
    G.at(sph(), c.wing, V(s * 0.06, 0.15, -0.03), { scale: V(0.03, 0.055, 0.12), jitter: 0.03 }); // folded wing
    G.at(new THREE.CylinderGeometry(0.007, 0.007, 0.08, 4), c.leg, V(s * 0.03, 0.04, 0.01));
    G.at(sph(), '#1c1c1c', V(s * 0.035, 0.245, 0.135), { scale: V(0.008, 0.008, 0.008), jitter: 0 }); // eyes
  }
  G.at(new THREE.BoxGeometry(0.08, 0.016, 0.12), c.tail, V(0, 0.13, -0.18), { rot: new THREE.Euler(-0.35, 0, 0) });
  const body = G.build();
  if (crow) body.scale(1.35, 1.35, 1.35);
  // wing: spread to +x from the shoulder hinge, dark primaries at the tip
  const sh = new THREE.Shape([new THREE.Vector2(0, 0.06), new THREE.Vector2(0.12, 0.05), new THREE.Vector2(0.23, -0.01), new THREE.Vector2(0.2, -0.07), new THREE.Vector2(0.1, -0.06), new THREE.Vector2(0, -0.06)]);
  const W = new Geo(rng(9));
  W.add(new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).rotateY(Math.PI).scale(-1, 1, 1), c.wing, new THREE.Matrix4(), { shade: (x) => (x > 0.15 ? (crow ? 0.8 : 0.55) : 1), jitter: 0.02 });
  const wing = W.build();
  if (crow) wing.scale(1.35, 1.35, 1.35);
  return { body, wing };
}

function catGeo(): { sit: THREE.BufferGeometry; head: THREE.BufferGeometry; sleep: THREE.BufferGeometry } {
  const coat = '#e6e6e6', pale = '#ffffff', dark = '#8a8a8a', sph = () => new THREE.SphereGeometry(1, 10, 8);
  const S = new Geo(rng(41));
  S.at(sph(), coat, V(0, 0.1, -0.03), { scale: V(0.11, 0.1, 0.13), jitter: 0.03 });
  S.at(sph(), pale, V(0, 0.19, 0.05), { scale: V(0.08, 0.13, 0.075), rot: new THREE.Euler(-0.25, 0, 0), jitter: 0.03 });
  for (const s of [-1, 1]) {
    S.at(new THREE.CylinderGeometry(0.02, 0.022, 0.16, 6), coat, V(s * 0.035, 0.08, 0.085));
    S.at(sph(), pale, V(s * 0.035, 0.012, 0.1), { scale: V(0.024, 0.014, 0.03) });
  }
  S.at(new THREE.TorusGeometry(0.13, 0.02, 5, 12, Math.PI * 1.1), coat, V(0, 0.02, 0), { rot: new THREE.Euler(Math.PI / 2, 0, -0.4), jitter: 0.03 });
  const H = new Geo(rng(42)); // head, pivot at the neck
  H.at(sph(), coat, V(0, 0.04, 0.01), { scale: V(0.068, 0.06, 0.062), jitter: 0.03 });
  H.at(sph(), pale, V(0, 0.02, 0.055), { scale: V(0.035, 0.025, 0.025), jitter: 0.02 });
  for (const s of [-1, 1]) {
    H.at(new THREE.ConeGeometry(0.026, 0.055, 4), coat, V(s * 0.038, 0.1, 0.0), { rot: new THREE.Euler(0, 0, -s * 0.25), jitter: 0.03 });
    H.at(sph(), '#2b2b22', V(s * 0.026, 0.05, 0.062), { scale: V(0.01, 0.012, 0.006), jitter: 0 });
  }
  H.at(sph(), '#d9a0a0', V(0, 0.028, 0.08), { scale: V(0.008, 0.006, 0.005), jitter: 0 });
  const L = new Geo(rng(43)); // curled up asleep
  L.at(sph(), coat, V(0, 0.075, 0), { scale: V(0.17, 0.085, 0.125), jitter: 0.03 });
  L.at(sph(), coat, V(0.13, 0.07, 0.06), { scale: V(0.065, 0.055, 0.06), jitter: 0.03 });
  for (const s of [-1, 1]) L.at(new THREE.ConeGeometry(0.024, 0.05, 4), coat, V(0.15 + s * 0.03, 0.12, 0.04), { rot: new THREE.Euler(s * 0.3, 0, -0.5), jitter: 0.03 });
  L.at(new THREE.TorusGeometry(0.14, 0.022, 5, 12, Math.PI * 0.9), dark, V(0, 0.035, 0.02), { rot: new THREE.Euler(Math.PI / 2, 0, 0.2), jitter: 0.03 });
  return { sit: S.build(), head: H.build(), sleep: L.build() };
}

function butterflyWing(): THREE.BufferGeometry {
  const sh = new THREE.Shape([new THREE.Vector2(0, 0.03), new THREE.Vector2(0.045, 0.05), new THREE.Vector2(0.065, 0.02), new THREE.Vector2(0.045, -0.005),
    new THREE.Vector2(0.05, -0.035), new THREE.Vector2(0.025, -0.05), new THREE.Vector2(0, -0.02)]);
  const G = new Geo(rng(51));
  G.add(new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2).scale(1.3, 1, 1.3), '#ffffff', new THREE.Matrix4(), { shade: (x) => (x > 0.065 ? 0.55 : 1), jitter: 0 });
  return G.build();
}

function petalGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.03, 0.022, 0.006, 0, 0, 0, 0.03, 0, 0, -0.03, 0, 0, 0.03, -0.022, 0.006, 0], 3));
  g.computeVertexNormals();
  const G = new Geo(rng(61));
  G.add(g, '#f7cbd8', new THREE.Matrix4(), { jitter: 0 });
  return G.build();
}

// ---------------------------------------------------------------- placements
interface Tree { x: number; z: number; s: number; y?: number }
interface Plan {
  sakura: Tree[]; ginkgo: Tree[]; pine: Tree[]; pots: [number, number][];
  hedges: [number, number, number, number][]; // x0, x1 (or z0, z1 when axis z), fixed coord, axis 0=x 1=z
  temple?: { x0: number; x1: number; z0: number; z1: number; avoid: [number, number, number, number][] };
  pigeons: [number, number, number][]; // flock centre x, z, count
  crows: [number, number, number][]; // x, y, z (perched or on the ground)
  cats: [number, number, number, number, 0 | 1][]; // x, y, z, yaw, 0 sit 1 sleep
  butterflies: [number, number][];
}
const row = (xs: number[], z: number, s: number): Tree[] => xs.map((x) => ({ x, z, s }));

function plan(id: DistrictId): Plan {
  if (id === 'asakusa') return {
    sakura: [
      { x: -17, z: -52, s: 1.2 }, { x: 17.5, z: -49.5, s: 1.1 }, { x: -20, z: -71, s: 1.3 }, { x: 13, z: -76, s: 1.0 },
      { x: -20, z: 14.8, s: 1.1 }, { x: -2.8, z: 15.2, s: 1.0 }, { x: -14.5, z: 15.6, s: 0.9 }, ...row([-48, -38, 24, 36, 47], -6.9, 0.85),
    ],
    ginkgo: [],
    pine: [{ x: -24, z: -60, s: 1.3 }, { x: 25, z: -75, s: 1.2 }, { x: -11, z: -78, s: 1.1 }],
    pots: [[5.0, 15.4], [-42, 6.9], [-46, 6.9], [54, 6.9], [50, 6.9]],
    hedges: [[-21.6, -11.2, 16.9, 0], [-7.2, -2.9, 16.9, 0], [-80, -50.5, -27.45, 1], [-80, -50.5, 27.45, 1]],
    temple: { x0: -27, x1: 27, z0: -81, z1: -49, avoid: [[-5, 5, -82, -48], [-14, 14, -82, -66], [16, 26.5, -67, -57], [-8, -4, -62, -50], [4, 8, -62, -50], [-13.5, -10.5, -53, -51], [10.5, 13.5, -53, -51], [-27.5, -23.5, -50, -47]] },
    pigeons: [[0, -53.5, 7], [-18.5, 12.8, 5], [-30, -5.2, 4]],
    crows: [[-35, 9.05, -3.95], [13, 9.05, -3.95], [29.2, 8.4, -3.95], [-28.5, 3.1, -58], [7.8, 0.015, 6.4]],
    cats: [[-5.5, 1.95, 17.6, Math.PI, 0], [2.4, 1.95, 17.6, Math.PI / 2, 1], [8.5, 0.9, -68.1, 0.3, 1], [28.5, 3.1, -62, -Math.PI / 2, 0], [9.0, 0.015, 6.7, 0.2, 0]],
    butterflies: [[-12, 15.5], [-5, 15.8], [48, 6.5], [-16, -55], [15, -54], [-20, -66], [10, -72]],
  };
  if (id === 'shibuya') return {
    sakura: [], pine: [], hedges: [],
    ginkgo: [{ x: -12.5, z: -22, s: 1.1 }, { x: -29, z: -23, s: 1 }, { x: -19, z: -12.6, s: 0.9 }],
    pots: [[-21.4, -13.0], [-26.6, -13.0]],
    pigeons: [[-17.5, -17.5, 8], [-55, 9.6, 4]],
    crows: [[-13.5, 0.015, -20.5], [30, 0.015, -9.8]],
    cats: [[-12.3, 0.49, -13.05, Math.PI, 1], [-48.6, 0.015, -9.9, 0.4, 0]],
    butterflies: [[-13, -21], [-19, -13.5], [-28, -22]],
  };
  if (id === 'shinjuku') {
    const F = 13, R = 8, g: Tree[] = [{ x: -14.2, z: -22.5, s: 1 }, { x: -19.8, z: -22.5, s: 1 }];
    for (let x = -58; x <= 58; x += 9) if (Math.abs(x) > F + 3) { if (Math.abs(x + 3 + 17) > 5) g.push({ x: x + 3, z: -R - 2.2, s: 0.9 }); g.push({ x: x - 2, z: R + 2.2, s: 0.9 }); }
    return {
      sakura: [], pine: [], hedges: [], ginkgo: g,
      pots: [[12.2, 22], [16.8, 22]],
      pigeons: [[-15.5, -20.8, 6], [14.5, 19.6, 5]],
      crows: [[-56.5, 0.015, -11.2], [-53.2, 0.015, -11.6]],
      cats: [[-14.0, 0.49, -17.35, 0, 1], [14.5, 0.5, 20.2, Math.PI, 0]],
      butterflies: [[14.5, 22], [-17, -22.5]],
    };
  }
  const F = 11, R = 6, g: Tree[] = [];
  for (let x = -58; x <= 58; x += 10) if (Math.abs(x) > F + 3) g.push({ x, z: -R - 1.3, s: 0.95 }, { x: x + 5, z: R + 1.3, s: 0.95 });
  return {
    sakura: [{ x: -45, z: -F + 1.4, s: 0.8 }, { x: 46, z: -F + 1.4, s: 0.8 }], pine: [], hedges: [], ginkgo: g,
    pots: [[-46, F - 0.8], [-50, F - 0.8], [57, F - 0.8], [53, F - 0.8]],
    pigeons: [[-46.5, F - 2.2, 5], [8.6, -14.6, 4]],
    crows: [[30, 0.015, -F + 1.6], [33, 0.015, -F + 1.2]],
    cats: [[-47.6, 0.49, F - 0.8, Math.PI, 1], [55, 0.015, F - 1.9, Math.PI + 0.3, 0]],
    butterflies: [[-48, F - 1], [55, F - 1], [-45, -F + 2]],
  };
}

// ---------------------------------------------------------------- build
const queued: [number, number, number][] = [];
/** Queue a potted plant at a world position (e.g. beside a shop door); consumed by the next buildNature(). */
export function potAt(x: number, z: number, ry = 0): void { queued.push([x, z, ry]); }

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), SC = new THREE.Vector3(), E = new THREE.Euler();
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
function placed(geo: THREE.BufferGeometry, material: THREE.Material, list: { x: number; y?: number; z: number; ry: number; s: number; sy?: number }[], shadow = true, tint?: THREE.Color[]): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, material, Math.max(1, list.length));
  m.count = list.length;
  list.forEach((o, i) => {
    M.compose(P.set(o.x, o.y ?? 0, o.z), Q.setFromAxisAngle(UP, o.ry), SC.set(o.s, o.sy ?? o.s, o.s));
    m.setMatrixAt(i, M);
    if (tint) m.setColorAt(i, tint[i]);
  });
  m.castShadow = shadow; m.receiveShadow = true;
  m.computeBoundingSphere();
  return m;
}
const box = (x: number, z: number, w: number, d: number, y0: number, y1: number, camera: boolean, player = true): Collider =>
  ({ minX: x - w / 2, maxX: x + w / 2, minY: y0, maxY: y1, minZ: z - d / 2, maxZ: z + d / 2, camera, player });

interface Bird { home: V3; p: V3; yaw: number; pitch: number; st: 0 | 1 | 2 | 3; t: number; act: number; at: number; from: V3; to: V3; v: V3; flock: number; crow: boolean; perch: boolean; flap: number }
interface Cat { x: number; y: number; z: number; yaw: number; head: number; ph: number }

export interface Nature { update(dt: number, playerPos: THREE.Vector3): void }

export function buildNature(id: DistrictId, group: THREE.Group, colliders: Collider[]): Nature {
  const r = rng(id.length * 977 + id.charCodeAt(1));
  const pl = plan(id);
  const root = new THREE.Group();
  root.name = 'nature';
  group.add(root);

  // --- trees (3 sculpted variants each, random yaw)
  const trees = (list: Tree[], geos: THREE.BufferGeometry[], trunk: number, canopy: [number, number, number]) => {
    const by = geos.map(() => [] as { x: number; z: number; ry: number; s: number; y?: number }[]);
    list.forEach((t, i) => by[(i + Math.floor(r() * 3)) % geos.length].push({ x: t.x, y: t.y, z: t.z, ry: r() * TAU, s: t.s * (0.95 + r() * 0.1) }));
    geos.forEach((g, i) => { if (by[i].length) root.add(placed(g, WIND_MAT, by[i])); else g.dispose(); });
    for (const t of list) {
      colliders.push(box(t.x, t.z, trunk * t.s, trunk * t.s, 0, 3, false));
      colliders.push(box(t.x, t.z, canopy[0] * t.s, canopy[0] * t.s, canopy[1] * t.s, canopy[2] * t.s, true, false)); // canopy keeps the camera out
    }
  };
  if (pl.sakura.length) trees(pl.sakura, [sakuraGeo(1), sakuraGeo(2), sakuraGeo(3)], 0.5, [2.8, 2.9, 4.6]);
  if (pl.pine.length) trees(pl.pine, [pineGeo(4), pineGeo(5)], 0.5, [2.4, 2.0, 4.0]);
  if (pl.ginkgo.length) {
    trees(pl.ginkgo, [ginkgoGeo(6), ginkgoGeo(7), ginkgoGeo(8)], 0.4, [1.8, 2.6, 5.2]);
    root.add(placed(grateGeo(), mat('paint'), pl.ginkgo.map((t) => ({ x: t.x, z: t.z, ry: 0, s: 1 })), false));
  }

  // --- hedges: one rounded box per run, merged into a single mesh (no module seams)
  if (pl.hedges.length) {
    const G = new Geo(rng(11));
    for (const [a0, a1, c, axis] of pl.hedges) {
      const len = a1 - a0, mid = (a0 + a1) / 2;
      G.at(bevelBox(len, 0.85, 0.7, 0.16).clone(), '#5f7d50', axis === 0 ? V(mid, 0.425, c) : V(c, 0.425, mid), { rot: new THREE.Euler(0, axis === 0 ? 0 : Math.PI / 2, 0), shade: hiLo(0, 0.85, 0.62, 1.08), jitter: 0.04 });
      colliders.push(axis === 0 ? box(mid, c, len, 0.7, 0, 0.9, false) : box(c, mid, 0.7, len, 0, 0.9, false));
    }
    const hm = new THREE.Mesh(G.build(), mat('paint'));
    hm.castShadow = hm.receiveShadow = true;
    // clipped-leaf texture: small flat facets studding the top and faces, flat-shaded on the wind material
    const L = new Geo(rng(12));
    for (const [a0, a1, c, axis] of pl.hedges) for (let a = a0 + 0.2; a < a1 - 0.2; a += 0.22) for (let k = 0; k < 3; k++) {
      const side = k === 0 ? 0 : k === 1 ? -1 : 1, y = side ? 0.25 + r() * 0.5 : 0.84, o = side * 0.34 + (side ? 0 : (r() - 0.5) * 0.5);
      const p = axis === 0 ? V(a + (r() - 0.5) * 0.15, y, c + o) : V(c + o, y, a + (r() - 0.5) * 0.15);
      L.at(new THREE.IcosahedronGeometry(0.07 + r() * 0.05, 0), pick(r, ['#5f7d50', '#6a8858', '#557247']), p, { rot: rot(r), scale: side ? V(0.6, 1, 0.6) : V(1, 0.45, 1), flex: () => 0.004, shade: () => (side ? 0.85 : 1.05) });
    }
    const lm = new THREE.Mesh(L.build(), WIND_MAT);
    lm.receiveShadow = true;
    root.add(hm, lm);
  }

  // --- potted plants
  const pots = [...pl.pots.map(([x, z]) => [x, z, r() * TAU] as [number, number, number]), ...queued.splice(0)];
  if (pots.length) {
    const kinds = id === 'asakusa' ? [0, 1, 2, 3] : id === 'ginza' ? [0, 1, 3] : [0, 1, 2];
    const by = [0, 1, 2, 3].map(() => [] as { x: number; z: number; ry: number; s: number }[]);
    pots.forEach(([x, z, ry], i) => { by[kinds[(i + Math.floor(r() * 2)) % kinds.length]].push({ x, z, ry, s: 0.95 + r() * 0.15 }); colliders.push(box(x, z, 0.65, 0.65, 0, 0.9, false)); });
    by.forEach((l, k) => { if (l.length) root.add(placed(potGeo(k), WIND_MAT, l)); });
  }

  // --- temple moss islands and grass tufts
  if (pl.temple) {
    const T = pl.temple;
    const free = (x: number, z: number, pad = 0) => !T.avoid.some(([x0, x1, z0, z1]) => x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad);
    const moss: { x: number; y: number; z: number; ry: number; s: number; sy: number }[] = [], tint: THREE.Color[] = [];
    const grass: { x: number; z: number; ry: number; s: number }[] = [];
    const seedPts = [...pl.sakura, ...pl.pine].filter((t) => t.z < T.z1 && t.z > T.z0);
    const addMoss = (x: number, z: number, s: number) => {
      if (!free(x, z, s * 0.9) || x < T.x0 || x > T.x1 || z < T.z0 || z > T.z1) return;
      moss.push({ x, y: 0.004, z, ry: r() * TAU, s, sy: 1.4 + r() * 1.2 });
      tint.push(new THREE.Color(pick(r, ['#5d6b3d', '#56683f', '#667444', '#4f6339'])));
      for (let k = 0; k < 2 + s * 5; k++) { // tufts around the rim
        const a = r() * TAU, d = s * (0.7 + r() * 0.4);
        grass.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, ry: r() * TAU, s: 0.8 + r() * 0.6 });
      }
    };
    for (const t of seedPts) for (let k = 0; k < 9; k++) { const a = r() * TAU, d = 0.5 + r() * 2.0 * t.s; addMoss(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.35 + r() * 0.5); }
    for (let k = 0; k < 14; k++) { const x = T.x0 + r() * (T.x1 - T.x0), z = T.z0 + r() * (T.z1 - T.z0); for (let j = 0; j < 3; j++) addMoss(x + (r() - 0.5) * 1.2, z + (r() - 0.5) * 1.2, 0.3 + r() * 0.45); }
    for (let z = T.z0 + 1; z < T.z1 - 1; z += 0.9) for (const x of [T.x0 + 0.3, T.x1 - 0.3]) if (r() < 0.75) grass.push({ x: x + (r() - 0.5) * 0.3, z, ry: r() * TAU, s: 0.9 + r() * 0.7 }); // wall foot
    if (moss.length) root.add(placed(mossGeo(), mat('paint'), moss, false, tint));
    if (grass.length) root.add(placed(grassGeo(), WIND_MAT, grass, false));
  }

  // --- drifting petals from every sakura canopy
  const sak = pl.sakura;
  const NP = Math.min(320, sak.length * 26);
  const petals = NP ? new THREE.InstancedMesh(petalGeo(), THIN_MAT, NP) : null;
  const pst = new Float32Array(NP * 8); // x y z, phase, fall speed, spin axis seed, spin, spin rate
  const respawn = (i: number, any: boolean) => {
    const t = sak[Math.floor(Math.random() * sak.length)], a = Math.random() * TAU, d = Math.random() * 2.4 * t.s, top = 3.6 * t.s;
    const o = i * 8;
    pst[o] = t.x + Math.cos(a) * d; pst[o + 1] = any ? Math.random() * top : top - Math.random() * 0.8; pst[o + 2] = t.z + Math.sin(a) * d;
    pst[o + 3] = Math.random() * TAU; pst[o + 4] = 0.3 + Math.random() * 0.3; pst[o + 5] = Math.random() * TAU; pst[o + 6] = Math.random() * TAU; pst[o + 7] = 2 + Math.random() * 4;
  };
  if (petals) { for (let i = 0; i < NP; i++) respawn(i, true); petals.frustumCulled = false; root.add(petals); }

  // --- birds
  const pig = birdGeo(false), crw = birdGeo(true);
  const birds: Bird[] = [];
  let flock = 0;
  for (const [x, z, n] of pl.pigeons) {
    for (let i = 0; i < n; i++) {
      const a = r() * TAU, d = 0.3 + r() * 1.4, p = V(x + Math.cos(a) * d, 0.015, z + Math.sin(a) * d);
      birds.push({ home: p.clone(), p, yaw: r() * TAU, pitch: 0, st: 0, t: r() * 2, act: 0, at: 0, from: V(0, 0, 0), to: V(0, 0, 0), v: V(0, 0, 0), flock, crow: false, perch: false, flap: 0 });
    }
    flock++;
  }
  for (const [x, y, z] of pl.crows) {
    const p = V(x, y, z);
    birds.push({ home: p.clone(), p, yaw: r() * TAU, pitch: 0, st: 0, t: r() * 2, act: 0, at: 0, from: V(0, 0, 0), to: V(0, 0, 0), v: V(0, 0, 0), flock: flock++, crow: true, perch: y > 0.5, flap: 0 });
  }
  const pigs = birds.filter((b) => !b.crow), crows = birds.filter((b) => b.crow);
  const pigShade = ['#ffffff', '#e8e2d8', '#cfcac4', '#f4efe6', '#b9b6b2'].map((c) => new THREE.Color(c));
  const mk = (geo: THREE.BufferGeometry, n: number, m: THREE.Material, shadow: boolean) => { const im = new THREE.InstancedMesh(geo, m, Math.max(1, n)); im.count = n; im.frustumCulled = false; im.castShadow = shadow; root.add(im); return im; };
  const pigBody = mk(pig.body, pigs.length, mat('paint'), true), pigWing = mk(pig.wing, pigs.length * 2, THIN_MAT, true);
  const crowBody = mk(crw.body, crows.length, mat('paint'), true), crowWing = mk(crw.wing, crows.length * 2, THIN_MAT, true);
  pigs.forEach((_, i) => pigBody.setColorAt(i, pigShade[i % pigShade.length]));
  for (let i = 0; i < pigs.length * 2; i++) pigWing.setColorAt(i, pigShade[(i >> 1) % pigShade.length]);
  if (!pigs.length) { pig.body.dispose(); pig.wing.dispose(); }

  // --- cats
  const cg = catGeo();
  const coats = ['#d9944e', '#3a3a3e', '#9a958e', '#eee3cf', '#8a6a4c'].map((c) => new THREE.Color(c));
  const sit: Cat[] = [], sleep: Cat[] = [];
  pl.cats.forEach(([x, y, z, yaw, k]) => (k ? sleep : sit).push({ x, y, z, yaw, head: 0, ph: r() * TAU }));
  const catTint = (n: number, off: number) => Array.from({ length: n }, (_, i) => coats[(i + off) % coats.length]);
  const sitBody = placed(cg.sit, mat('paint'), sit.map((c) => ({ x: c.x, y: c.y, z: c.z, ry: c.yaw, s: 1 })), true, catTint(sit.length, 0));
  const sitHead = placed(cg.head, mat('paint'), sit.map((c) => ({ x: c.x, y: c.y + 0.29, z: c.z, ry: c.yaw, s: 1 })), true, catTint(sit.length, 0));
  const sleeper = placed(cg.sleep, mat('paint'), sleep.map((c) => ({ x: c.x, y: c.y, z: c.z, ry: c.yaw, s: 1 })), true, catTint(sleep.length, 2));
  sitHead.frustumCulled = sleeper.frustumCulled = false;
  root.add(sitBody, sitHead, sleeper);
  const neck = V(0, 0.29, 0.07);

  // --- butterflies (daytime only)
  const NB = pl.butterflies.length * 2;
  const bfl = Array.from({ length: NB }, (_, i) => ({ a: pl.butterflies[i >> 1], ph: r() * 100, sp: 0.7 + r() * 0.5, last: V(0, 0, 0) }));
  const bwing = mk(butterflyWing(), NB * 2, THIN_MAT, false);
  const wingC = ['#f7f4ea', '#f2dc7a', '#f7f4ea', '#dfe6f2', '#f5e6b8'].map((c) => new THREE.Color(c));
  for (let i = 0; i < NB * 2; i++) bwing.setColorAt(i, wingC[(i >> 1) % wingC.length]);

  // ------------------------------------------------------------ animation
  const wingM = new THREE.Matrix4(), hinge = new THREE.Matrix4(), flip = new THREE.Matrix4().makeScale(-1, 1, 1);
  let time = 0;
  const setWings = (im: THREE.InstancedMesh, i: number, body: THREE.Matrix4, sx: number, y: number, z: number, ang: number) => {
    for (const s of [1, -1]) {
      hinge.makeRotationZ(s * ang).setPosition(s * sx, y, z);
      wingM.multiplyMatrices(body, hinge);
      if (s < 0) wingM.multiply(flip);
      im.setMatrixAt(i * 2 + (s < 0 ? 1 : 0), wingM);
    }
  };

  const updateBirds = (dt: number, pp: V3) => {
    for (const b of birds) {
      const fear = b.crow ? 4.5 : 3.2;
      const near = Math.hypot(pp.x - b.p.x, pp.z - b.p.z) < fear && Math.abs(pp.y - b.p.y) < 2.5;
      if ((b.st === 0 || b.st === 3) && near) {
        for (const o of birds) if (o.flock === b.flock && (o.st === 0 || o.st === 3)) {
          const away = V(o.p.x - pp.x, 0, o.p.z - pp.z).normalize();
          away.applyAxisAngle(UP, (Math.random() - 0.5) * 1.2);
          o.v.copy(away).multiplyScalar(2 + Math.random()).setY(2.6 + Math.random() * 1.2);
          o.st = 1; o.t = 0; o.flap = Math.random() * TAU;
        }
      }
      if (b.st === 0) {
        b.t -= dt; b.at += dt;
        if (b.t <= 0) {
          const roll = Math.random();
          b.act = roll < (b.crow ? 0.3 : 0.5) ? 1 : roll < 0.78 && !b.perch ? 2 : 3;
          b.at = 0; b.t = b.act === 1 ? 0.7 : b.act === 2 ? 0.32 : 0.5 + Math.random() * 1.6;
          if (b.act === 2) {
            b.from.copy(b.p);
            b.yaw += (Math.random() - 0.5) * 1.4;
            b.to.set(b.p.x + Math.sin(b.yaw) * 0.22, b.p.y, b.p.z + Math.cos(b.yaw) * 0.22);
            if (b.to.distanceTo(b.home) > 1.6) { b.yaw = Math.atan2(b.home.x - b.p.x, b.home.z - b.p.z); b.to.set(b.p.x + Math.sin(b.yaw) * 0.22, b.p.y, b.p.z + Math.cos(b.yaw) * 0.22); }
          } else if (b.act === 3) b.yaw += (Math.random() - 0.5) * 1.2;
        }
        b.pitch = b.act === 1 ? Math.max(0, Math.sin(b.at * 9)) * 0.5 : 0; // two quick pecks
        if (b.act === 2) { const u = Math.min(1, b.at / 0.32); b.p.lerpVectors(b.from, b.to, u); b.p.y = b.home.y + Math.sin(u * Math.PI) * 0.07; }
      } else if (b.st === 1) {
        b.t += dt;
        const h = V(b.v.x, 0, b.v.z), sp = h.length();
        if (sp < 7) h.multiplyScalar((sp + 5 * dt) / Math.max(sp, 1e-3));
        b.v.set(h.x, Math.min(b.v.y + 0.6 * dt, 4.5), h.z);
        b.p.addScaledVector(b.v, dt);
        b.yaw = Math.atan2(b.v.x, b.v.z); b.pitch = -0.35;
        b.flap += dt * (b.crow ? 20 : 26);
        if (b.t > 4.5) { b.st = 2; b.t = 8 + Math.random() * 8; }
      } else if (b.st === 2) {
        b.t -= dt;
        if (b.t <= 0) {
          if (Math.hypot(pp.x - b.home.x, pp.z - b.home.z) < fear * 2.5) b.t = 2;
          else {
            const a = Math.random() * TAU;
            b.from.set(b.home.x + Math.cos(a) * 16, b.home.y + 9, b.home.z + Math.sin(a) * 16); b.p.copy(b.from);
            b.st = 3; b.t = 0;
          }
        }
      } else {
        b.t += dt;
        const u = Math.min(1, b.t / 3.2), e = 1 - (1 - u) * (1 - u);
        b.p.set(THREE.MathUtils.lerp(b.from.x, b.home.x, e), THREE.MathUtils.lerp(b.from.y, b.home.y, 1 - Math.pow(1 - u, 3)), THREE.MathUtils.lerp(b.from.z, b.home.z, e));
        b.yaw = Math.atan2(b.home.x - b.from.x, b.home.z - b.from.z); b.pitch = 0.15 - u * 0.3;
        b.flap += dt * (u < 0.6 ? 10 : 22);
        if (u >= 1) { b.st = 0; b.t = 0.5; b.p.copy(b.home); b.pitch = 0; }
      }
    }
    const write = (list: Bird[], body: THREE.InstancedMesh, wing: THREE.InstancedMesh, sc: number) => {
      list.forEach((b, i) => {
        if (b.st === 2) { body.setMatrixAt(i, HIDE); wing.setMatrixAt(i * 2, HIDE); wing.setMatrixAt(i * 2 + 1, HIDE); return; }
        M.compose(b.p, Q.setFromEuler(E.set(b.pitch, b.yaw, 0, 'YXZ')), ONE);
        body.setMatrixAt(i, M);
        if (b.st === 0) { wing.setMatrixAt(i * 2, HIDE); wing.setMatrixAt(i * 2 + 1, HIDE); }
        else setWings(wing, i, M, 0.05 * sc, 0.17 * sc, 0.0, Math.sin(b.flap) * 0.9 + 0.1);
      });
      body.instanceMatrix.needsUpdate = true; wing.instanceMatrix.needsUpdate = true;
    };
    write(pigs, pigBody, pigWing, 1); write(crows, crowBody, crowWing, 1.35);
  };

  const updateCats = (pp: V3) => {
    sit.forEach((c, i) => {
      const dx = pp.x - c.x, dz = pp.z - c.z, d = Math.hypot(dx, dz);
      let want = Math.sin(time * 0.4 + c.ph) * 0.35; // idle glance around
      if (d < 6) { want = Math.atan2(dx, dz) - c.yaw; want = Math.atan2(Math.sin(want), Math.cos(want)); want = THREE.MathUtils.clamp(want, -1.2, 1.2); }
      c.head += (want - c.head) * 0.08;
      M.compose(P.copy(neck).applyAxisAngle(UP, c.yaw).add(SC.set(c.x, c.y, c.z)), Q.setFromAxisAngle(UP, c.yaw + c.head), ONE);
      sitHead.setMatrixAt(i, M);
    });
    sitHead.instanceMatrix.needsUpdate = true;
    sleep.forEach((c, i) => {
      const br = 1 + Math.sin(time * 1.6 + c.ph) * 0.035;
      M.compose(P.set(c.x, c.y, c.z), Q.setFromAxisAngle(UP, c.yaw), SC.set(1, br, 1 + (br - 1) * 0.5));
      sleeper.setMatrixAt(i, M);
    });
    sleeper.instanceMatrix.needsUpdate = true;
  };

  const updatePetals = (dt: number) => {
    if (!petals) return;
    for (let i = 0; i < NP; i++) {
      const o = i * 8;
      pst[o + 3] += dt * 1.7;
      pst[o] += (Math.sin(pst[o + 3]) * 0.45 + 0.3) * dt;
      pst[o + 1] -= pst[o + 4] * (0.75 + 0.25 * Math.sin(pst[o + 3] * 1.3)) * dt;
      pst[o + 2] += Math.cos(pst[o + 3] * 0.7) * 0.35 * dt;
      pst[o + 6] += pst[o + 7] * dt;
      if (pst[o + 1] < 0.03) respawn(i, false);
      const a = pst[o + 5];
      M.compose(P.set(pst[o], pst[o + 1], pst[o + 2]), Q.setFromAxisAngle(SC.set(Math.cos(a), 0.5, Math.sin(a)).normalize(), pst[o + 6]), ONE);
      petals.setMatrixAt(i, M);
    }
    petals.instanceMatrix.needsUpdate = true;
  };

  const updateButterflies = (dt: number) => {
    const day = nightGlow.value < 0.45;
    bwing.visible = day && NB > 0;
    if (!bwing.visible) return;
    bfl.forEach((f, i) => {
      const t = time * f.sp + f.ph;
      P.set(f.a[0] + Math.sin(t * 0.7) * 1.6 + Math.sin(t * 1.9) * 0.4, 0.75 + Math.sin(t * 1.3) * 0.35 + Math.abs(Math.sin(t * 4.1)) * 0.18, f.a[1] + Math.cos(t * 0.53) * 1.4);
      const yaw = Math.atan2(P.x - f.last.x, P.z - f.last.z);
      f.last.copy(P);
      M.compose(P, Q.setFromEuler(E.set(-0.3, yaw, 0, 'YXZ')), ONE);
      setWings(bwing, i, M, 0.004, 0, 0, 0.15 + Math.abs(Math.sin(time * 15 + f.ph)) * 1.2);
    });
    bwing.instanceMatrix.needsUpdate = true;
    void dt;
  };

  return {
    update(dt, pp) {
      time += dt;
      wind.value += dt;
      updateBirds(dt, pp);
      updateCats(pp);
      updatePetals(dt);
      updateButterflies(dt);
    },
  };
}
