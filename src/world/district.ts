// District scenes: Asakusa (start), Shibuya, Shinjuku, Ginza. Static scenery is baked into a few merged
// meshes; restaurants/rivals/HQ are views rebuilt from state; cars, petals and screens animate.
import * as THREE from 'three';
import { DISTRICTS, DistrictId } from '../core/data';
import { short } from '../core/format';
import { GameState } from '../core/state';
import { Collider } from '../engine/collision';
import { VC_MAT } from '../engine/geo';
import { Atlas, Builder, FONT, G, GLOW_MAT, POOL_MAT, RADIAL, WORLD_MAT, glow, interiorWarm, rng } from './kit';
import {
  C, bench, bike, bin, building, bush, car, cone, crates, frontage, gable, greenTree, hip, lamp, lantern, nobori,
  pine, planter, powerPole, sakura, scooter, trafficLight, vending, wires, vendingCluster, manhole, tactile, ShopKind, farField, broadcastTower,
} from './props';
import { HQView, RivalView, SiteDef, SiteView } from './sites';
import { DistrictScene, Spot, StoryNpc } from './types';

const S = (x: number, z: number, yaw = 0): Spot => ({ x, z, yaw });

/** Bake transforms of static objects once; objects tagged userData.dynamic keep auto-updating. */
function freeze(o: THREE.Object3D): void {
  if (o.userData.dynamic) return;
  o.matrixAutoUpdate = false;
  o.updateMatrix();
  for (const c of o.children) freeze(c);
}
const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const loop = (pts: [number, number][]) => pts.map(([x, z]) => V(x, z));

// ---------------------------------------------------------------- shared street kit
function ground(color: string): THREE.Mesh {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d')!;
  x.fillStyle = color; x.fillRect(0, 0, 256, 256);
  const r = rng(7);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const k = 0.9 + r() * 0.12;
    const col = new THREE.Color(color).multiplyScalar(k);
    x.fillStyle = '#' + col.getHexString(); x.fillRect(i * 64 + 2, j * 64 + 2, 60, 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(110, 110); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(440, 440), new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2; m.receiveShadow = true;
  return m;
}

function roadX(b: Builder, x0: number, x1: number, z0: number, z1: number, lanes: number): void {
  b.box((x0 + x1) / 2, 0, (z0 + z1) / 2, x1 - x0, 0.02, z1 - z0, C.asphalt);
  const zc = (z0 + z1) / 2;
  for (let x = x0; x < x1; x += 6) b.box(x + 1.5, 0.02, zc, 3, 0.006, 0.15, '#f2f2f2');
  for (const z of [z0 + 0.3, z1 - 0.3]) b.box((x0 + x1) / 2, 0.02, z, x1 - x0, 0.006, 0.12, '#e8e8e8');
  if (lanes >= 4) for (const z of [zc - (z1 - z0) / 4, zc + (z1 - z0) / 4]) for (let x = x0; x < x1; x += 8) b.box(x + 2, 0.02, z, 4, 0.006, 0.1, '#d8d8d8');
  for (const z of [z0 - 0.08, z1 + 0.08]) b.box((x0 + x1) / 2, 0, z, x1 - x0, 0.09, 0.18, C.curb);
}
function roadZ(b: Builder, z0: number, z1: number, x0: number, x1: number, lanes: number): void {
  b.box((x0 + x1) / 2, 0.001, (z0 + z1) / 2, x1 - x0, 0.02, z1 - z0, C.asphalt);
  const xc = (x0 + x1) / 2;
  for (let z = z0; z < z1; z += 6) b.box(xc, 0.021, z + 1.5, 0.15, 0.006, 3, '#f2f2f2');
  for (const x of [x0 + 0.3, x1 - 0.3]) b.box(x, 0.021, (z0 + z1) / 2, 0.12, 0.006, z1 - z0, '#e8e8e8');
  if (lanes >= 4) for (const x of [xc - (x1 - x0) / 4, xc + (x1 - x0) / 4]) for (let z = z0; z < z1; z += 8) b.box(x, 0.021, z + 2, 0.1, 0.006, 4, '#d8d8d8');
  for (const x of [x0 - 0.08, x1 + 0.08]) b.box(x, 0, (z0 + z1) / 2, 0.18, 0.09, z1 - z0, C.curb);
}
/** Crossing over an E-W road at x=xc (pedestrians walk along z). */
function zebraX(b: Builder, xc: number, z0: number, z1: number, w = 4): void {
  b.box(xc, 0.019, (z0 + z1) / 2, w + 0.2, 0.004, z1 - z0, C.asphalt);
  for (let z = z0 + 0.4; z < z1 - 0.2; z += 0.9) b.box(xc, 0.023, z, w, 0.006, 0.45, '#ffffff');
}
function zebraZ(b: Builder, zc: number, x0: number, x1: number, w = 4): void {
  b.box((x0 + x1) / 2, 0.019, zc, x1 - x0, 0.004, w + 0.2, C.asphalt);
  for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.9) b.box(x, 0.023, zc, 0.45, 0.006, w, '#ffffff');
}
/** Big invisible + visible boundary blocks (rect in world coords). */
function block(b: Builder, x0: number, x1: number, z0: number, z1: number): void {
  b.colliders.push({ minX: x0, maxX: x1, minY: 0, maxY: 40, minZ: z0, maxZ: z1, camera: true });
}

// ---------------------------------------------------------------- traffic
interface Lane { axis: 'x' | 'z'; c: number; dir: 1 | -1; a0: number; a1: number; stops: number[]; phase: number }
interface Car { obj: THREE.Object3D; lane: Lane; pos: number; v: number; len: number; vmax: number }
const carCache = new Map<string, THREE.Group>();
function carMesh(kind: Parameters<typeof car>[1], color: string): THREE.Group {
  const key = kind + color;
  let g = carCache.get(key);
  if (!g) {
    const b = new Builder(null, 1000); car(b, kind, color); g = b.build();
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material === WORLD_MAT) m.material = VC_MAT; }); // clean paint, no wall grime
    carCache.set(key, g);
  }
  return g.clone();
}

class Traffic {
  cars: Car[] = [];
  t = 0;
  constructor(public group: THREE.Group, private phases: { dur: number; green: ('x' | 'z')[] }[]) {}
  add(lane: Lane, kind: Parameters<typeof car>[1], color: string, pos: number): void {
    const obj = carMesh(kind, color);
    const len = kind === 'bus' ? 9 : kind === 'scooter' ? 1.6 : kind === 'kei' ? 3.3 : 4.4;
    obj.userData.dynamic = true;
    this.group.add(obj);
    this.cars.push({ obj, lane, pos, v: 6, len, vmax: kind === 'bus' ? 6.5 : kind === 'scooter' ? 7 : 8.5 });
  }
  green(axis: 'x' | 'z'): boolean {
    const total = this.phases.reduce((a, p) => a + p.dur, 0);
    let t = this.t % total;
    for (const p of this.phases) { if (t < p.dur) return p.green.includes(axis) && t < p.dur - 2.5; t -= p.dur; }
    return true;
  }
  update(dt: number, player: THREE.Vector3): void {
    this.t += dt;
    for (const c of this.cars) {
      const L = c.lane;
      const front = c.pos + (L.dir * c.len) / 2;
      let want = c.vmax;
      if (!this.green(L.axis)) for (const s of L.stops) {
        const dist = (s - front) * L.dir;
        if (dist > -0.5 && dist < 16) want = Math.min(want, Math.max(0, dist - 0.8) * 1.1);
      }
      for (const o of this.cars) {
        if (o === c || o.lane !== L) continue;
        const gap = (o.pos - c.pos) * L.dir - (c.len + o.len) / 2;
        if (gap > -1 && gap < 14) want = Math.min(want, Math.max(0, gap - 2.5) * 1.3);
      }
      const pa = L.axis === 'x' ? player.x : player.z, pp = L.axis === 'x' ? player.z : player.x;
      if (Math.abs(pp - L.c) < 2.2 && player.y < 2) { const d = (pa - front) * L.dir; if (d > -1 && d < 9) want = Math.min(want, Math.max(0, d - 1.5) * 1.2); }
      c.v += Math.max(-12 * dt, Math.min(4 * dt, want - c.v));
      c.pos += c.v * L.dir * dt;
      if ((c.pos - L.a1) * L.dir > 0) c.pos = L.a0;
      if (L.axis === 'x') { c.obj.position.set(c.pos, 0.02, L.c); c.obj.rotation.y = L.dir > 0 ? 0 : Math.PI; }
      else { c.obj.position.set(L.c, 0.02, c.pos); c.obj.rotation.y = L.dir > 0 ? -Math.PI / 2 : Math.PI / 2; }
    }
  }
}

// ---------------------------------------------------------------- falling petals
class Petals {
  points: THREE.Points;
  private v: Float32Array;
  constructor(private trees: THREE.Vector3[], n: number) {
    const pos = new Float32Array(n * 3);
    this.v = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { this.reset(pos, i, true); this.v[i * 2] = Math.random() * 6; this.v[i * 2 + 1] = 0.35 + Math.random() * 0.35; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffc6dc', size: 0.13, map: RADIAL, transparent: true, depthWrite: false, alphaTest: 0.05 }));
    this.points.frustumCulled = false;
  }
  private reset(p: Float32Array, i: number, any = false): void {
    const t = this.trees[Math.floor(Math.random() * this.trees.length)] ?? V(0, 0);
    p[i * 3] = t.x + (Math.random() - 0.5) * 3.4; p[i * 3 + 1] = any ? Math.random() * t.y : t.y + Math.random() * 0.6; p[i * 3 + 2] = t.z + (Math.random() - 0.5) * 3.4;
  }
  update(dt: number): void {
    const p = this.points.geometry.attributes.position as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    for (let i = 0; i < p.count; i++) {
      this.v[i * 2] += dt * 2;
      a[i * 3] += Math.sin(this.v[i * 2]) * dt * 0.5 + dt * 0.25;
      a[i * 3 + 1] -= this.v[i * 2 + 1] * dt;
      a[i * 3 + 2] += Math.cos(this.v[i * 2] * 0.7) * dt * 0.4;
      if (a[i * 3 + 1] < 0.05) this.reset(a, i);
    }
    p.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- animated billboard screens
class Screen {
  canvas = document.createElement('canvas');
  tex: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  private t = Math.random() * 10;
  private acc = 0;
  constructor(w: number, h: number, private seed: number) {
    this.canvas.width = 512; this.canvas.height = 288;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
  }
  update(dt: number, s: GameState | null): void {
    this.t += dt; this.acc += dt;
    if (this.acc < 0.12) return;
    this.acc = 0;
    const x = this.canvas.getContext('2d')!;
    const W = 512, H = 288, t = this.t;
    const slide = Math.floor(t / 4 + this.seed) % 4;
    const hue = (t * 25 + this.seed * 90) % 360;
    const gr = x.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, `hsl(${hue},80%,55%)`); gr.addColorStop(1, `hsl(${(hue + 60) % 360},85%,45%)`);
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    x.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 6; i++) { x.beginPath(); x.arc((i * 120 + t * 60) % (W + 100) - 50, H / 2 + Math.sin(t + i) * 60, 40 + i * 6, 0, 7); x.fill(); }
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#fff';
    x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 8;
    const company = s?.player.company ?? 'Sushi Empire';
    if (slide === 0) { x.font = `700 64px ${FONT}`; x.fillText(company, W / 2, H / 2 - 20); x.font = `600 30px ${FONT}`; x.fillText('🍣 Tokyo\'s favourite sushi', W / 2, H / 2 + 45); }
    else if (slide === 1) { x.font = `700 120px ${FONT}`; x.fillText('🍣', W / 2 + Math.sin(t * 3) * 20, H / 2 - 10); x.font = `700 34px ${FONT}`; x.fillText(`${short(s?.lifetime.pieces ?? 0)} pieces sold!`, W / 2, H - 40); }
    else if (slide === 2) { x.font = `700 110px ${FONT}`; x.fillText('渋谷', W / 2, H / 2); }
    else { x.font = `700 56px ${FONT}`; x.fillText('SUMMER SALE', W / 2, H / 2 - 25); x.font = `600 32px ${FONT}`; x.fillText('ラーメン · カラオケ · 寿司', W / 2, H / 2 + 40); }
    x.shadowBlur = 0;
    x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(0, H - 22, W, 22);
    x.fillStyle = '#ffe066'; x.font = `600 16px ${FONT}`; x.textAlign = 'left';
    x.fillText('★ BREAKING: sushi demand at record high ★ 本日のおすすめ ★ Shibuya scramble ★ ', W - ((t * 90) % (W * 2)), H - 11);
    this.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- scene assembly
interface Ctx {
  b: Builder; group: THREE.Group; r: () => number;
  sites: SiteDef[]; rivals: RivalView[]; hq: HQView | null;
  sakuras: THREE.Vector3[]; screens: Screen[];
  traffic: Traffic; extras: ((dt: number, s: GameState | null) => void)[];
  atlas: Atlas;
  far?: Builder;
}

export function buildDistrict(id: DistrictId, s: GameState): DistrictScene {
  const group = new THREE.Group();
  const atlas = new Atlas(2048);
  const b = new Builder(atlas, 64);
  const ctx: Ctx = {
    b, group, r: rng(id.length * 101 + id.charCodeAt(0)), sites: [], rivals: [], hq: null, sakuras: [], screens: [],
    traffic: new Traffic(group, id === 'shibuya' ? [{ dur: 12, green: ['x'] }, { dur: 12, green: ['z'] }, { dur: 9, green: [] }] : [{ dur: 16, green: ['x'] }, { dur: 9, green: ['z'] }]),
    extras: [], atlas,
  };
  group.add(ground(({ asakusa: '#d9c7a7', shibuya: '#b9b4ad', shinjuku: '#bdb8b0', ginza: '#ddd5c7' } as const)[id] ?? DISTRICTS[id].palette.ground));
  const layout = LAYOUTS[id](ctx);

  const views = ctx.sites.map((d) => new SiteView(d));
  for (const v of views) group.add(v.group);
  for (const rv of ctx.rivals) group.add(rv.group);
  if (ctx.hq) group.add(ctx.hq.group);
  group.add(b.build());
  // distant city ring so the horizon is never empty (no shadows, ~3 draw calls)
  const far = ctx.far ?? new Builder(null, 4000);
  const skip = id === 'asakusa'
    ? [{ x0: -95, x1: 95, z0: -24, z1: 16 }, { x0: -38, x1: -22, z0: 8, z1: 21 }, { x0: -24, x1: 6, z0: 8, z1: 18 }, { x0: 7, x1: 17, z0: 8, z1: 16 }, { x0: 24, x1: 31, z0: 8, z1: 22 },
       { x0: -11, x1: 11, z0: -50, z1: -24 }, { x0: -30, x1: 30, z0: -85, z1: -44 }]
    : [{ x0: -95, x1: 95, z0: -28, z1: 28 }, { x0: -28, x1: 28, z0: -95, z1: 95 }];
  farField(far, skip, id === 'asakusa' ? 'wood' : id === 'ginza' ? 'lux' : 'modern', rng(id.length * 7 + 3));
  group.add(far.build(false));
  let petals: Petals | null = null;
  if (ctx.sakuras.length) { petals = new Petals(ctx.sakuras, Math.min(420, ctx.sakuras.length * 40)); group.add(petals.points); }
  for (const sc of ctx.screens) group.add(sc.mesh);

  const colliders: Collider[] = [...b.colliders];
  const owned = new Map<object, Collider[]>();
  const swap = (key: object, cols: Collider[]) => {
    const old = owned.get(key);
    if (old) for (const c of old) { const i = colliders.indexOf(c); if (i >= 0) colliders.splice(i, 1); }
    colliders.push(...cols); owned.set(key, cols);
  };
  let state: GameState | null = s;
  freeze(group);

  return {
    id, group, colliders,
    spawn: layout.spawn, metro: layout.metro, supplier: layout.supplier ?? null, hq: layout.hq ?? null,
    sites: views.map((v) => v.site),
    walkPaths: layout.walk, edges: layout.edges, storyNpcs: layout.npcs,
    update(dt, night, p) {
      glow.value = 0.05 + night * 0.9;
      interiorWarm.value = 0.06 + night * 0.42;
      atlas.mat.emissiveIntensity = 0.22 + night * 0.85;
      POOL_MAT.opacity = night * 0.6;
      for (const v of views) v.updateRoof(p);
      ctx.traffic.update(dt, p);
      petals?.update(dt);
      for (const sc of ctx.screens) sc.update(dt, state);
      for (const e of ctx.extras) e(dt, state);
    },
    refresh(st) {
      state = st;
      for (const v of views) if (v.refresh(st)) { swap(v, v.colliders); freeze(v.group); }
      for (const rv of ctx.rivals) if (rv.refresh(st)) { swap(rv, rv.colliders); freeze(rv.group); }
      if (ctx.hq?.refresh(st)) { swap(ctx.hq, ctx.hq.colliders); freeze(ctx.hq.group); }
    },
    dispose() {
      group.removeFromParent();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh && !(o as THREE.Points).isPoints) return;
        if (!carCacheHas(m.geometry)) m.geometry.dispose();
        const mat = m.material as THREE.Material & { map?: THREE.Texture };
        if (mat && mat !== GLOW_MAT && mat !== POOL_MAT && !(mat as any).vertexColors) { mat.map?.dispose(); mat.dispose(); }
      });
      atlas.tex.dispose();
    },
  };
}

function carCacheHas(g: THREE.BufferGeometry): boolean {
  for (const c of carCache.values()) { let hit = false; c.traverse((o) => { if ((o as THREE.Mesh).geometry === g) hit = true; }); if (hit) return true; }
  return false;
}

interface Layout { spawn: Spot; metro: Spot; supplier?: Spot; hq?: Spot; walk: THREE.Vector3[][]; edges: Spot[]; npcs: StoryNpc[] }

const SHOPS_JP = ['ラーメン', '茶屋', '人形焼', '雷おこし', '天ぷら', 'たこ焼き', '団子', '和菓子', 'おでん', 'うどん', 'そば', '居酒屋', '書店', '薬局', '酒', '焼鳥', 'カフェ', '扇子'];

/** Metro entrance kiosk, front facing local +z. */
function metroEntrance(b: Builder, x: number, z: number, ry: number, name: string, color: string): void {
  b.push(x, 0, z, ry);
  b.box(0, 0, -2.5, 4.4, 0.1, 5, '#8c8c8c');
  b.box(-2.1, 0, -2.5, 0.2, 1.2, 5, '#d6d6d6'); b.box(2.1, 0, -2.5, 0.2, 1.2, 5, '#d6d6d6');
  b.box(0, 0, -5, 4.4, 2.8, 0.2, '#d6d6d6');
  for (let i = 0; i < 8; i++) b.box(0, -0.02, -0.6 - i * 0.55, 3.6, 0.08, 0.3, '#3b3d45'); // stair hint (dark)
  b.box(0, 0.05, -2.7, 3.8, 0.02, 4.0, '#2a2b32');
  for (const sx of [-2.1, 2.1]) b.box(sx, 0, -0.1, 0.12, 2.9, 0.12, '#bfc6cf');
  b.add(G.box(4.8, 0.15, 5.6), '#e3edf5', { at: [0, 2.9, -2.5], rot: [-0.08, 0, 0] });
  b.box(0, 2.6, 0.05, 4.2, 0.7, 0.15, color);
  b.sign(0, 2.95, 0.14, 4.0, 0.62, name, { bg: color, fg: '#ffffff', px: 90 });
  b.add(G.cyl(0.4, 0.4, 0.08, 20), '#ffffff', { at: [1.6, 3.35, 0.1], rot: [Math.PI / 2, 0, 0], glow: '#ffffff' });
  b.collide(0, -2.8, 4.8, 5.6, 3.6);
  b.pop();
}

// ================================================================ ASAKUSA
function asakusa(ctx: Ctx): Layout {
  const { b, r } = ctx;
  const STALL_C = ['#e63946', '#2a9d8f', '#f4a261', '#457b9d', '#e76f51', '#8d5a97'];
  roadX(b, -90, 90, -3.5, 3.5, 2);
  zebraX(b, 0, -3.5, 3.5); zebraX(b, -30, -3.5, 3.5);
  // sidewalk edging strips (subtle)
  b.box(0, 0, -7.45, 180, 0.012, 0.1, '#bfae8f'); b.box(0, 0, 7.45, 180, 0.012, 0.1, '#bfae8f');

  // ----- sites
  ctx.sites.push({ id: 'asakusa_stand', x: -11, z: 10.6, ry: Math.PI, w: 5, d: 2.8, style: 'wood', color: C.wood });
  ctx.sites.push({ id: 'asakusa_shop', x: -16.5, z: -7.5, ry: 0, w: 11, d: 10, style: 'wood', color: '#e9dcc3' });
  ctx.sites.push({ id: 'asakusa_house', x: -30, z: 7.5, ry: Math.PI, w: 13, d: 12, style: 'wood', color: '#efe2c9' });
  ctx.rivals.push(new RivalView('kaiten', 'asakusa', 16.5, -7.5, 0, 10, 'wood', ctx.atlas));

  // ----- north frontage (front z=-7.5, faces road)
  b.push(0, 0, -7.5, 0);
  frontage(b, -90, 90, [[-22, -11], [-11, 11], [11.5, 21.5]], 'wood', r, [], ['#efe2c9', '#e6d5b8', '#f3e9d6', '#d9c3a0', '#c9b08a'], { depth: 13.5, minF: 2, maxF: 3, kinds: ['souvenir', 'souvenir', 'souvenir', 'ramen', 'izakaya', 'kissaten', 'soba', 'pharmacy', 'books', 'grocer', 'florist', 'generic'] as ShopKind[] });
  // narrow fillers beside the gate, shallow so the market street behind stays open
  building(b, { x: -8.75, w: 3.5, d: 5, floors: 2, style: 'wood', r, color: '#e6d5b8', kind: 'souvenir', shop: '扇子', clutter: false });
  building(b, { x: 9.25, w: 3.5, d: 5, floors: 2, style: 'wood', r, color: '#efe2c9', kind: 'souvenir', shop: '団子', clutter: false });
  b.pop();

  // ----- Kumonmon: the great cloud gate with its giant lantern
  b.push(0, 0, -9.5, 0);
  for (const sx of [-1, 1]) {
    for (const dz of [-1.1, 1.1]) { b.cyl(sx * 4.3, 0, dz, 0.3, 0.32, 6.2, C.red, 14); b.collide(sx * 4.3, dz, 0.65, 0.65, 6); }
    b.box(sx * 5.6, 0, 0, 2.2, 5.0, 2.8, C.redD); // guardian alcoves
    b.box(sx * 5.6, 0.6, 1.45, 1.6, 3.6, 0.1, '#2a1d1a');
    b.sign(sx * 5.6, 2.4, 1.52, 1.3, 2.8, sx < 0 ? '風神' : '雷神', { bg: '#2a1d1a', fg: '#ffd166', vertical: true, px: 60 });
    b.collide(sx * 5.6, 0, 2.2, 2.8, 5);
  }
  b.box(0, 5.4, 0, 13.6, 0.5, 3.4, C.red);
  b.box(0, 5.9, 0, 14.4, 0.3, 4.2, C.woodD);
  b.add(hip(16, 6.2, 2.4), C.tile, { at: [0, 6.2, 0], roof: true });
  b.add(hip(8, 3, 1.2), C.tileD, { at: [0, 8.0, 0], roof: true });
  b.sign(0, 4.9, 1.75, 4.2, 0.9, '雲門', { bg: '#2a1d1a', fg: '#ffd166', px: 70 });
  // the giant lantern
  b.add(G.cyl(1.25, 1.25, 3.0, 20), '#d62828', { at: [0, 2.35, 0], glow: '#ff5a2a' });
  b.add(G.sphere(1.25, 20, 10), '#d62828', { at: [0, 3.85, 0], scale: [1, 0.25, 1], glow: '#ff5a2a' });
  b.add(G.sphere(1.25, 20, 10), '#d62828', { at: [0, 2.35, 0], scale: [1, 0.25, 1], glow: '#ff5a2a' });
  b.cyl(0, 2.15, 0, 1.0, 1.0, 0.25, '#2a1d1a', 20);
  b.cyl(0, 4.05, 0, 1.0, 1.0, 0.3, '#2a1d1a', 20);
  b.sign(0, 3.1, 1.27, 1.4, 1.9, '雲', { bg: '#d62828', fg: '#1a1210', px: 80 });
  b.sign(0, 3.1, -1.27, 1.4, 1.9, '門', { bg: '#d62828', fg: '#1a1210', px: 80, ry: Math.PI });
  b.pool(0, 0, 6, '#ff8a5a');
  b.pop();

  // ----- Nakamise market street: stall rows facing the lane
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const z = -13.2 - i * 3.4;
      b.push(side * 8.2, 0, z - 1.6, side < 0 ? Math.PI / 2 : -Math.PI / 2);
      const col = STALL_C[(i + (side > 0 ? 3 : 0)) % STALL_C.length];
      b.box(0, 0, -1.4, 3.3, 3.4, 2.6, '#f3e9d6');
      b.box(0, 0, -0.05, 3.2, 0.95, 0.6, C.woodL);
      for (let k = 0; k < 5; k++) b.rbox(-1.2 + k * 0.6, 0.95, -0.05, 0.42, 0.18 + r() * 0.25, 0.4, ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#ffffff', '#f4a261'][Math.floor(r() * 6)], 0.05);
      b.add(G.box(3.4, 0.08, 1.4), col, { at: [0, 2.75, 0.45], rot: [0.3, 0, 0] });
      b.box(0, 2.3, 1.05, 3.4, 0.3, 0.05, col);
      b.sign(0, 3.05, 0.03, 2.6, 0.5, SHOPS_JP[(i * 3 + (side > 0 ? 5 : 0)) % SHOPS_JP.length], { bg: '#2a1d1a', fg: '#ffe7b3', px: 80 });
      lantern(b, 1.35, 2.0, 0.9, i % 2 ? C.red : '#fff0d0', 0.6);
      b.pop();
    }
    b.colliders.push({ minX: side < 0 ? -11 : 6.25, maxX: side < 0 ? -6.25 : 11, minY: 0, maxY: 4, minZ: -44, maxZ: -12, camera: true });
    b.box(side * 10.8, 0, -28, 0.4, 3.6, 32, '#d9c3a0');
  }
  // lantern strings across the lane
  for (let z = -15; z > -44; z -= 6) {
    for (const sx of [-6.1, 6.1]) b.cyl(sx, 0, z, 0.06, 0.06, 4.3, C.woodD, 6);
    b.add(G.cyl(0.015, 0.015, 12.2, 4), '#222', { at: [-6.1, 4.2, z], rot: [0, 0, -Math.PI / 2] });
    for (let i = 0; i < 10; i++) lantern(b, -5.0 + i * 1.11, 3.45 - Math.sin((i / 9) * Math.PI) * 0.25, z, i % 2 ? '#fff0d0' : C.red, 0.55);
    b.pool(0, z, 4, '#ff9a5a');
  }
  b.box(0, 0.001, -28, 12, 0.012, 34, '#e6d8bd'); // paved lane
  for (let z = -11; z > -46; z -= 1.6) b.box(0, 0.013, z, 2.2, 0.006, 1.4, '#d4c3a3');

  // ----- inner gate & temple courtyard
  b.push(0, 0, -47, 0);
  for (const sx of [-3.4, 3.4]) { b.cyl(sx, 0, 0, 0.28, 0.3, 4.8, C.red, 12); b.collide(sx, 0, 0.6, 0.6, 5); }
  b.box(0, 4.6, 0, 8.4, 0.35, 1.4, C.red);
  b.add(hip(10, 3.4, 1.4), C.tile, { at: [0, 4.95, 0], roof: true });
  for (const sx of [-1, 1]) { b.box(sx * 8, 0, 0, 9, 2.6, 0.8, C.red); b.box(sx * 8, 2.6, 0, 9.4, 0.25, 1.2, C.tile); b.collide(sx * 8, 0, 9, 0.8, 3); }
  b.pop();
  b.box(0, 0.002, -64, 56, 0.012, 34, '#d8d0c0'); // courtyard gravel
  // main hall
  b.push(0, 0, -68, 0);
  b.box(0, 0, -6, 26, 0.9, 13, '#bfb6a6');
  for (let i = 0; i < 6; i++) b.box(0, 0, 0.6 + i * 0.35 - 0.2, 8, 0.9 - i * 0.15, 0.35, '#cfc6b6');
  b.box(0, 0.9, -6, 22, 4.6, 10, C.red);
  for (let i = 0; i < 9; i++) b.cyl(-10 + i * 2.5, 0.9, -0.6, 0.25, 0.25, 4.6, C.redD, 10);
  b.box(0, 1.2, -0.95, 8, 3.6, 0.1, '#2a1d1a');
  b.box(0, 5.5, -6, 27, 0.4, 15, C.woodD);
  b.add(hip(30, 17, 4.5), C.tile, { at: [0, 5.9, -6], roof: true });
  b.add(hip(14, 8, 2.5), C.tileD, { at: [0, 9.5, -6], roof: true });
  lantern(b, -2.6, 3.0, -0.2, C.red, 1.6); lantern(b, 2.6, 3.0, -0.2, C.red, 1.6);
  b.sign(0, 4.7, -0.85, 5, 0.9, '雲隠寺', { bg: '#2a1d1a', fg: '#ffd166', px: 70 });
  b.collide(0, -6, 26, 13, 10);
  b.pop();
  // incense burner
  b.cyl(0, 0, -57, 1.1, 0.8, 1.0, '#6b6b6b', 12); b.cyl(0, 1.0, -57, 0.9, 1.0, 0.25, '#5a5a5a', 12);
  b.add(hip(2.2, 2.2, 0.8), '#555', { at: [0, 1.9, -57], roof: true }); for (const sx of [-0.8, 0.8]) b.cyl(sx, 1.25, -57, 0.08, 0.08, 0.7, '#555', 6);
  b.collide(0, -57, 2.2, 2.2, 2);
  // five-storey pagoda
  b.push(21, 0, -62, 0);
  b.box(0, 0, 0, 6, 0.8, 6, '#bfb6a6');
  for (let f = 0; f < 5; f++) {
    const sz = 4.2 - f * 0.45, y = 0.8 + f * 3.2;
    b.box(0, y, 0, sz, 2.4, sz, C.red);
    b.add(hip(sz + 2.4, sz + 2.4, 0.9), C.tile, { at: [0, y + 2.4, 0], roof: true });
  }
  b.cyl(0, 17.5, 0, 0.12, 0.15, 6, C.gold, 8);
  for (let i = 0; i < 8; i++) b.cyl(0, 18 + i * 0.6, 0, 0.35, 0.35, 0.1, C.gold, 10);
  b.collide(0, 0, 6, 6, 18);
  b.pop();
  // stone lanterns
  for (const [x, z] of [[-6, -52], [6, -52], [-6, -60], [6, -60]]) {
    b.box(x, 0, z, 0.7, 0.3, 0.7, C.stoneD); b.cyl(x, 0.3, z, 0.12, 0.15, 1.0, C.stone, 8);
    b.add(G.box(0.55, 0.45, 0.55), '#e8e0d0', { at: [x, 1.3, z], glow: '#ffcf70' });
    b.add(hip(0.9, 0.9, 0.5), C.stoneD, { at: [x, 1.75, z], roof: true }); b.pool(x, z, 2.5);
    b.collide(x, z, 0.7, 0.7, 2.2, false);
  }
  ctx.sakuras.push(sakura(b, -17, -52, 1.2, r), sakura(b, 17.5, -49.5, 1.1, r), sakura(b, -20, -71, 1.3, r), sakura(b, 13, -76, 1.0, r));
  pine(b, -24, -60, 1.3); pine(b, 25, -75, 1.2); pine(b, -11, -78, 1.1);
  vending(b, -26, -48.5, 0, '#2a6fdb'); vending(b, -24.8, -48.5, 0, '#e94e3c');
  bench(b, -12, -52, 0); bench(b, 12, -52, 0);
  // courtyard walls & enclosure
  for (const sx of [-1, 1]) { b.box(sx * 28.5, 0, -63, 1, 2.8, 38, C.red); b.box(sx * 28.5, 2.8, -63, 1.4, 0.3, 38, C.tile); }
  b.box(0, 0, -82.5, 58, 2.8, 1, C.red); b.box(0, 2.8, -82.5, 58.4, 0.3, 1.4, C.tile);
  block(b, -90, -28, -95, -44); block(b, 28, 90, -95, -44); block(b, -90, 90, -100, -82);
  block(b, -90, -11, -44, -21); block(b, 11, 90, -44, -21);
  // skyline silhouettes: a distant temple hall, a second pagoda and the broadcast tower
  const sky = new Builder(null, 4000);
  sky.push(-78, 0, -132, 0.3);
  sky.box(0, 0, 0, 30, 10, 18, '#8a2f24'); sky.add(hip(36, 24, 8), '#3b4252', { at: [0, 10, 0], roof: true }); sky.add(hip(16, 10, 4), '#3b4252', { at: [0, 16, 0], roof: true });
  sky.pop();
  sky.push(-118, 0, -70, 0);
  for (let f = 0; f < 5; f++) { const sz = 6 - f * 0.7; sky.box(0, f * 4.4, 0, sz, 3.4, sz, '#a8321f'); sky.add(hip(sz + 3.4, sz + 3.4, 1.2), '#3b4252', { at: [0, f * 4.4 + 3.4, 0], roof: true }); }
  sky.cyl(0, 22, 0, 0.2, 0.25, 8, C.gold, 8);
  sky.pop();
  broadcastTower(sky, 72, -122, 160);
  ctx.far = sky;

  // ----- south side: Grandpa's plaza, metro, Mika's fish shop, alley
  b.box(-11.5, 0.001, 12.3, 21, 0.012, 9.6, '#e8dcc6'); // plaza paving
  for (let x = -21; x < -1; x += 1.5) b.box(x + 0.75, 0.014, 12.3, 0.04, 0.004, 9.6, '#d6c8ae');
  b.box(-12.25, 0, 17.6, 22.5, 1.8, 0.6, '#c9b08a'); b.box(-12.25, 1.8, 17.6, 22.9, 0.15, 0.9, C.tile); // back wall
  b.collide(-12.25, 17.6, 22.5, 0.6, 2.2);
  for (let x = -21; x < -2; x += 2.2) bush(b, x, 16.9, 1, C.greens[r() < 0.5 ? 3 : 1]);
  ctx.sakuras.push(sakura(b, -20, 14.8, 1.1, r), sakura(b, -2.8, 15.2, 1.0, r), sakura(b, -14.5, 15.6, 0.9, r));
  bench(b, -17.5, 15.4, 0); bench(b, -6.5, 15.4, 0);
  vending(b, -1.2, 16.6, Math.PI, '#e94e3c'); vending(b, -2.3, 16.6, Math.PI, '#2a6fdb');
  nobori(b, -4.9, 8.4, '寿司', '#e63946'); nobori(b, -16.6, 8.4, '新鮮', '#2a6fdb');
  // string of lanterns over the plaza
  for (const x of [-21.6, -1.4]) b.cyl(x, 0, 9.6, 0.07, 0.07, 4.0, C.woodD, 6);
  wires(b, new THREE.Vector3(-21.6, 4.0, 9.6), new THREE.Vector3(-1.4, 4.0, 9.6), 1);
  for (let i = 0; i < 14; i++) lantern(b, -20.7 + i * 1.4, 3.3 - Math.sin((i / 13) * Math.PI) * 0.5, 9.6, i % 2 ? '#fff0d0' : C.red, 0.5);
  b.pool(-11, 10, 7, '#ffb070');

  metroEntrance(b, 3, 9.0, Math.PI, '浅草駅 Asakusa Sta.', '#f28c28');
  // open corner between plaza and station (keeps the stand visible from the metro exit)
  b.box(2.1, 0, 17.6, 6.6, 1.8, 0.6, '#c9b08a'); b.box(2.1, 1.8, 17.6, 7.0, 0.15, 0.9, C.tile); b.collide(2.1, 17.6, 6.6, 0.6, 2.2);
  vendingCluster(b, -0.1, 16.7, Math.PI, 2, r); bench(b, 3, 15.6, Math.PI); planter(b, 5.0, 15.4, '#ffd23f');
  // low houses behind the plaza wall (seen from above / over the wall)
  for (let x = -21; x < 6; x += 5.6) {
    const hh = 4.4 + r() * 2.6;
    b.box(x, 0, 24.2, 5.2, hh, 11, ['#e3d6bd', '#d8c8aa', '#cdb995'][Math.floor(r() * 3)]);
    b.box(x, 1.6, 18.66, 3.6, 1.2, 0.06, '#e8d9b8', r() < 0.5 ? '#e8a04a' : '#000000');
    b.add(hip(5.8, 11.6, 1.8), [C.tile, '#5a5f6b', '#6b5a4e'][Math.floor(r() * 3)], { at: [x, hh, 24.2], roof: true });
  }
  // Mika's Fresh Fish: open-fronted fish shop
  b.push(12, 0, 8, Math.PI);
  b.box(0, 0, -3.5, 8, 0.05, 7, '#cfd8dc');
  b.box(-4, 0, -3.5, 0.2, 3.6, 7, '#e9e2d0'); b.box(4, 0, -3.5, 0.2, 3.6, 7, '#e9e2d0'); b.box(0, 0, -7, 8, 3.6, 0.2, '#e9e2d0');
  b.collide(-4, -3.5, 0.3, 7, 7); b.collide(4, -3.5, 0.3, 7, 7); b.collide(0, -7, 8, 0.3, 7);
  b.box(0, 3.6, -3.5, 8.2, 3.4, 7.2, '#dcd2bc');
  for (let i = 0; i < 3; i++) b.box(-2.6 + i * 2.6, 4.4, 0.02, 1.6, 1.6, 0.06, '#f4e6c8', '#ffd58a');
  b.add(gable(7.8, 2.0, 8.6), C.tile, { at: [0, 7.0, -3.5], roof: true });
  b.add(G.box(8.4, 0.1, 1.4), '#2a6fdb', { at: [0, 3.2, 0.5], rot: [0.3, 0, 0] });
  b.sign(0, 3.65, 0.13, 6.4, 0.75, "魚 Mika's Fresh Fish", { bg: '#1d4e89', fg: '#ffffff', px: 80 });
  // display counter: tilted ice bed with fish
  b.rbox(0, 0, -1.2, 6.4, 0.9, 1.0, '#5c6b7a', 0.05);
  b.add(G.box(6.2, 0.12, 1.0), '#e8f4fb', { at: [0, 0.95, -1.2], rot: [0.25, 0, 0] });
  const fishC = ['#ff8a5c', '#d9364a', '#9fb3c8', '#ffb199', '#7a4a24', '#c0c9d1'];
  for (let i = 0; i < 12; i++) {
    const fx = -2.8 + (i % 6) * 1.1, fz = -1.45 + Math.floor(i / 6) * 0.45;
    b.add(G.sphere(0.2), fishC[i % 6], { at: [fx, 1.08 + Math.floor(i / 6) * 0.1, fz], scale: [2, 0.6, 0.9], rot: [0.25, 0.2, 0] });
    b.add(G.cone(0.12, 0.2, 4), fishC[i % 6], { at: [fx - 0.45, 1.05, fz], rot: [0, 0, Math.PI / 2] });
  }
  b.collide(0, -1.2, 6.4, 1.0, 1.0, false);
  // back: tanks & crates & price tags
  b.box(-2, 0, -6.4, 3, 1.6, 1, '#7fa7c9', '#5fb0e8'); b.box(-2, 0.1, -5.88, 2.8, 1.3, 0.04, '#bfe6ff', '#4fb4ff');
  crates(b, 2.3, -6.2, 5, r);
  for (let i = 0; i < 5; i++) b.sign(-2.6 + i * 1.3, 0.55, -0.68, 0.6, 0.3, ['¥35', '¥45', '¥30', '¥70', '¥160'][i], { bg: '#fff8e1', fg: '#d62828', px: 100 });
  lantern(b, -3.6, 2.4, 0.3, '#fff0d0'); lantern(b, 3.6, 2.4, 0.3, '#fff0d0');
  b.pop();
  scooter(b, 17.2, 9.5, Math.PI / 2, '#2a6fdb'); crates(b, 7.4, 8.6, 3, r);

  // south frontage (front z=7.5, faces road). local x = -world x
  b.push(0, 0, 7.5, Math.PI);
  // reserved (local = -world): alley 26..29, Mika 8..16, metro 0.6..5.4, plaza -22..-1.2, house -36.5..-23.5
  frontage(b, -90, 90, [[-29, -26], [-16, -8], [-5.4, 1.2], [1.2, 22], [23.5, 36.5]], 'wood', r, [], ['#efe2c9', '#e6d5b8', '#f3e9d6', '#d9c3a0'], { depth: 14, minF: 2, maxF: 3, kinds: ['souvenir', 'souvenir', 'souvenir', 'ramen', 'izakaya', 'kissaten', 'soba', 'pharmacy', 'books', 'grocer', 'florist', 'generic'] as ShopKind[] });
  b.pop();
  // the yokocho alley
  b.box(27.5, 0.001, 14, 3, 0.012, 13, '#b9ad99');
  b.box(27.5, 0, 20.5, 3.2, 4, 0.4, '#a99f91'); b.collide(27.5, 20.5, 3.2, 0.4, 4);
  bin(b, 26.5, 12); bin(b, 26.5, 12.7); acUnit2(b, 28.8, 14); bike(b, 28.4, 16.5, Math.PI / 2 + 0.2, '#ffd23f');
  for (let i = 0; i < 3; i++) lantern(b, 27.5, 3.2, 10 + i * 3, '#fff0d0', 0.5);
  b.sign(27.5, 3.5, 8.0, 2.6, 0.5, '横丁 Yokocho', { bg: '#2a1d1a', fg: '#ffd166', px: 80, ry: Math.PI });
  block(b, -90, 90, 21.5, 100);

  // ----- street furniture along the road
  for (let x = -57; x <= 57; x += 12) { lamp(b, x, -4.2, 'classic'); lamp(b, x + 6, 4.2, 'classic'); }
  const poles: THREE.Vector3[] = [];
  for (let x = -51; x <= 60; x += 16) poles.push(powerPole(b, x, -3.95));
  for (let i = 0; i < poles.length - 1; i++) wires(b, poles[i], poles[i + 1], 5);
  tactile(b, -60, 60, -5.6); tactile(b, -60, 60, 5.65);
  for (const x of [0, -30]) for (const z of [-3.95, 3.95]) for (let k = -2; k < 2; k++) tactile(b, x + k * 0.96, x + (k + 1) * 0.96, z, true);
  for (let x = -55; x < 60; x += 23) { manhole(b, x, 1.6, 'sakura'); manhole(b, x + 11, -1.7, 'wave'); }
  for (const [x, z] of [[-40, -6.5], [8, 6.5], [-18, 5.0], [44, 5.2]]) manhole(b, x, z, 'kanji');
  vendingCluster(b, 23.6, 6.95, Math.PI, 3, r); vendingCluster(b, -45, -6.95, 0, 2, r);
  trafficLight(b, -2.6, -4.0, 0); trafficLight(b, 2.6, 4.0, Math.PI);
  for (const x of [-48, -38, 24, 36, 47]) ctx.sakuras.push(sakura(b, x, -6.9, 0.85, r));
  for (let i = 0; i < 5; i++) bike(b, 30 + i * 0.7, -7.0, Math.PI / 2 + 0.1, ['#3a86ff', '#ff006e', '#8ac926', '#ffbe0b', '#fb5607'][i]);
  for (const x of [-44, 40]) { bench(b, x, 6.9, Math.PI); planter(b, x + 2, 6.9); planter(b, x - 2, 6.9, '#ffd23f'); }
  bin(b, 6.6, 7.0); bin(b, -24, -7.0);
  b.collide(6.6, 7.6, 0.5, 1.2, 0.9, false); b.collide(-24, -7.6, 0.5, 1.2, 0.9, false); // no wedge gap to the wall
  scooter(b, -5.6, -7.0, 0.1, '#e63946');
  // boundary fences at the street ends
  for (const sx of [-1, 1]) {
    for (const z of [-5.5, 5.5]) { for (let i = 0; i < 3; i++) cone(b, sx * 61, z - 1 + i); }
    b.colliders.push({ minX: sx > 0 ? 61 : -62, maxX: sx > 0 ? 62 : -61, minY: 0, maxY: 6, minZ: -21, maxZ: 21.5, camera: false });
  }

  // ----- traffic (left-hand driving: eastbound on the north lane)
  const T = ctx.traffic;
  const east: Lane = { axis: 'x', c: -1.75, dir: 1, a0: -85, a1: 85, stops: [-2.6, -32.6], phase: 0 };
  const west: Lane = { axis: 'x', c: 1.75, dir: -1, a0: 85, a1: -85, stops: [2.6, -27.4], phase: 0 };
  T.add(east, 'taxi', '#2d6a4f', -60); T.add(east, 'kei', '#ffffff', -20); T.add(east, 'scooter', '#ff8fab', 30);
  T.add(west, 'sedan', '#e63946', 50); T.add(west, 'bus', '#f1faee', 0); T.add(west, 'scooter', '#3a86ff', -45);

  return {
    spawn: S(2.5, 5.0, -Math.PI / 2), metro: S(3, 7.9, Math.PI), supplier: S(12, 7.4, Math.PI),
    walk: [
      loop([[-58, -5.0], [58, -5.0], [58, -6.2], [-58, -6.2]]),
      loop([[-58, 4.9], [58, 4.9], [58, 6.0], [-58, 6.0]]),
      loop([[-1.8, -5.6], [-1.8, -55], [1.8, -55], [1.8, -5.6]]),
      loop([[-15, -51], [15, -51], [15, -63], [-15, -63]]),
    ],
    edges: [S(-60, -5.6, Math.PI / 2), S(60, -5.6, -Math.PI / 2), S(-60, 5.7, Math.PI / 2), S(60, 5.7, -Math.PI / 2), S(0, -62, 0)],
    npcs: [
      { id: 'kenji', name: 'Grandpa Kenji', spot: S(-15.4, 9.2, Math.PI / 2) },
      { id: 'mika', name: 'Mika', spot: S(16.9, 6.35, Math.PI) },
      { id: 'aoki', name: 'Madame Aoki', spot: S(-4.0, -40.0, Math.PI / 2) },
    ],
  };
}

function acUnit2(b: Builder, x: number, z: number): void {
  b.rbox(x, 0, z, 0.8, 0.6, 0.4, '#e6e8ea', 0.04);
  b.collide(x, z, 0.8, 0.4, 0.6, false);
}

// ================================================================ modern city kit (Shibuya / Shinjuku / Ginza)
interface CityOpts {
  road: number; side: number; // half widths: road half-width, sidewalk width
  style: 'modern' | 'lux'; shops: string[]; colors: string[]; minF: number; maxF: number;
  reservedEW: { north: [number, number][]; south: [number, number][] };
  kinds: ShopKind[];
  northCornerDepth?: { west?: number; east?: number };
  lanes: number; lampStyle: 'modern' | 'lux'; neon?: boolean;
}

/** Cross-shaped city: an E-W avenue and a N-S street meeting at the origin. Returns frontage line coordinate. */
function crossCity(ctx: Ctx, o: CityOpts): number {
  const { b, r } = ctx;
  const R = o.road, F = R + o.side;
  roadX(b, -90, 90, -R, R, o.lanes);
  roadZ(b, -90, -R - 4, -R + 1, R - 1, 2);
  roadZ(b, R + 4, 90, -R + 1, R - 1, 2);
  b.box(0, 0.0015, 0, 2 * R - 2, 0.02, 2 * R + 8, C.asphalt);
  // crossings
  zebraX(b, -R - 2, -R, R); zebraX(b, R + 2, -R, R);
  zebraZ(b, -R - 2, -R + 1, R - 1); zebraZ(b, R + 2, -R + 1, R - 1);
  // frontages
  b.push(0, 0, -F, 0);
  frontage(b, -90, -F, o.reservedEW.north.filter(([a]) => a < 0), o.style, r, o.shops, o.colors, { depth: 14, minF: o.minF, maxF: o.maxF, kinds: o.kinds, neon: o.neon });
  frontage(b, F, 90, o.reservedEW.north.filter(([a]) => a > 0), o.style, r, o.shops, o.colors, { depth: 14, minF: o.minF, maxF: o.maxF, kinds: o.kinds, neon: o.neon });
  b.pop();
  b.push(0, 0, F, Math.PI); // local x = -world x
  const southRes = o.reservedEW.south.map(([a, c]) => [-c, -a] as [number, number]);
  frontage(b, -90, -F, southRes.filter(([a]) => a < 0), o.style, r, o.shops, o.colors, { depth: 14, minF: o.minF, maxF: o.maxF, kinds: o.kinds, neon: o.neon });
  frontage(b, F, 90, southRes.filter(([a]) => a > 0), o.style, r, o.shops, o.colors, { depth: 14, minF: o.minF, maxF: o.maxF, kinds: o.kinds, neon: o.neon });
  b.pop();
  // Keep side-street buildings and the hidden city boundary behind deeper corner properties.
  const B = F + 14;
  const northWest = F + (o.northCornerDepth?.west ?? 14);
  const northEast = F + (o.northCornerDepth?.east ?? 14);
  const sideFrontage = { depth: 14, minF: o.minF, maxF: o.maxF, kinds: o.kinds, neon: o.neon };
  b.push(-F, 0, 0, Math.PI / 2);
  frontage(b, northWest, 90, [], o.style, r, o.shops, o.colors, sideFrontage);
  frontage(b, -90, -B, [], o.style, r, o.shops, o.colors, sideFrontage);
  b.pop();
  b.push(F, 0, 0, -Math.PI / 2);
  frontage(b, B, 90, [], o.style, r, o.shops, o.colors, sideFrontage);
  frontage(b, -90, -northEast, [], o.style, r, o.shops, o.colors, sideFrontage);
  b.pop();
  block(b, -100, -B, -100, -northWest);
  block(b, -100, -B, B, 100);
  block(b, B, 100, -100, -northEast);
  block(b, B, 100, B, 100);
  // ends of the streets
  for (const sx of [-1, 1]) {
    b.colliders.push({ minX: sx > 0 ? 64 : -65, maxX: sx > 0 ? 65 : -64, minY: 0, maxY: 6, minZ: sx > 0 ? -northEast : -northWest, maxZ: B, camera: false });
    b.colliders.push({ minX: -B, maxX: B, minY: 0, maxY: 6, minZ: sx > 0 ? 64 : -65, maxZ: sx > 0 ? 65 : -64, camera: false });
    for (let i = -2; i <= 2; i++) { cone(b, sx * 63, (R + o.side / 2) + i * 0.8); cone(b, sx * 63, -(R + o.side / 2) + i * 0.8); }
  }
  // lamps & trees along the avenue
  for (let x = -58; x <= 58; x += 13) {
    if (Math.abs(x) < F + 2) continue;
    lamp(b, x, -R - 0.7, o.lampStyle); lamp(b, x + 6, R + 0.7, o.lampStyle);
  }
  for (let z = -58; z <= 58; z += 13) { if (Math.abs(z) < F + 2) continue; lamp(b, -R - 0.7, z, o.lampStyle); lamp(b, R + 0.7, z + 6, o.lampStyle); }
  for (const sz of [-1, 1]) { tactile(b, -62, -F - 1, sz * (R + o.side * 0.55)); tactile(b, F + 1, 62, sz * (R + o.side * 0.55)); }
  b.push(0, 0, 0, Math.PI / 2); for (const sz of [-1, 1]) { tactile(b, -62, -F - 1, sz * (R + o.side * 0.55)); tactile(b, F + 1, 62, sz * (R + o.side * 0.55)); } b.pop();
  for (let x = -55; x < 60; x += 19) { manhole(b, x, R / 2, 'wave'); manhole(b, x + 8, -(R + o.side * 0.3), 'kanji'); }
  vendingCluster(b, -F - 17, -F + 0.55, 0, 3, r); vendingCluster(b, F + 9, F - 0.55, Math.PI, 2, r);
  trafficLight(b, -R - 0.6, -R - 0.6, 0); trafficLight(b, R + 0.6, R + 0.6, Math.PI);
  trafficLight(b, R + 0.6, -R - 0.6, -Math.PI / 2); trafficLight(b, -R - 0.6, R + 0.6, Math.PI / 2);
  return F;
}

function cityTraffic(ctx: Ctx, R: number, kinds: [Parameters<typeof car>[1], string][]): void {
  const T = ctx.traffic;
  const ew: Lane[] = [
    { axis: 'x', c: -R / 2 - 0.5, dir: 1, a0: -85, a1: 85, stops: [-R - 4.3], phase: 0 },
    { axis: 'x', c: R / 2 + 0.5, dir: -1, a0: 85, a1: -85, stops: [R + 4.3], phase: 0 },
  ];
  const ns: Lane[] = [
    { axis: 'z', c: (R - 1) / 2, dir: 1, a0: -85, a1: 85, stops: [-R - 4.3], phase: 1 },
    { axis: 'z', c: -(R - 1) / 2, dir: -1, a0: 85, a1: -85, stops: [R + 4.3], phase: 1 },
  ];
  kinds.forEach(([k, c], i) => {
    const lane = i % 3 === 2 ? ns[i % 2] : ew[i % 2];
    T.add(lane, k, c, lane.a0 + lane.dir * (15 + ((i * 37) % 140)));
  });
}

function cityWalk(F: number): THREE.Vector3[][] {
  const a = F - 2.2, b = F - 1.2, L = 58;
  return [
    loop([[-L, -a], [L, -a], [L, -b], [-L, -b]]),
    loop([[-L, a], [L, a], [L, b], [-L, b]]),
    loop([[-a, -L], [-a, L], [-b, L], [-b, -L]]),
    loop([[a, -L], [a, L], [b, L], [b, -L]]),
  ];
}
const cityEdges = (F: number): Spot[] => [S(-60, -F + 1.7, Math.PI / 2), S(60, F - 1.7, -Math.PI / 2), S(-F + 1.7, 60, Math.PI), S(F - 1.7, -60, 0)];

// ================================================================ SHIBUYA
function shibuya(ctx: Ctx): Layout {
  const { b, r } = ctx;
  const R = 7;
  ctx.sites.push({ id: 'shibuya_crossing', x: -24, z: 11, ry: Math.PI, w: 11, d: 10, style: 'modern', color: '#ff8fab' });
  ctx.sites.push({ id: 'shibuya_center', x: 26, z: 11, ry: Math.PI, w: 16, d: 14, style: 'modern', color: '#5e60ce' });
  ctx.rivals.push(new RivalView('kaiten', 'shibuya', -40, -11, 0, 10, 'modern', ctx.atlas));
  ctx.rivals.push(new RivalView('maguro', 'shibuya', 40, -11, 0, 10, 'modern', ctx.atlas));
  const F = crossCity(ctx, {
    road: R, side: 4, style: 'modern', shops: [], kinds: ['ramen', 'karaoke', 'pachinko', 'konbini', 'izakaya', 'pharmacy', 'generic', 'kissaten', 'books', 'salon', 'realestate', 'ramen'], colors: ['#e8e3da', '#c9d1db', '#f2c6c2', '#b8c4d9', '#ffe1a8', '#d7c4e8', '#9aa5b1', '#d8c3a5', '#bfa58a'],
    minF: 4, maxF: 8, lanes: 4, lampStyle: 'modern', neon: true,
    reservedEW: { north: [[-29.5, -11], [-45, -35], [35, 45], [11, 29]], south: [[-29.5, -18.5], [18, 34]] },
  });
  // diagonal scramble stripes
  for (const d of [-1, 1]) for (let i = -8; i <= 8; i++) {
    const t = i * 0.9;
    b.add(G.box(0.45, 0.006, 3.6), '#ffffff', { at: [t * Math.SQRT1_2, 0.024, d * t * Math.SQRT1_2], rot: [0, d * Math.PI / 4 + Math.PI / 2, 0] });
  }
  // NW plaza: dog statue, trees, metro
  b.box(-20, 0.002, -18, 19, 0.012, 14, '#c9c2b6');
  b.push(-15, 0, -16, 0.6);
  b.box(0, 0, 0, 1.6, 1.2, 1.0, '#7d7468');
  b.add(G.sphere(0.45), '#8a6a3c', { at: [0, 1.65, 0], scale: [1.4, 0.9, 0.8] });
  b.add(G.sphere(0.3), '#8a6a3c', { at: [0.6, 2.15, 0] });
  b.add(G.cone(0.1, 0.2, 4), '#8a6a3c', { at: [0.55, 2.35, 0.12] }); b.add(G.cone(0.1, 0.2, 4), '#8a6a3c', { at: [0.55, 2.35, -0.12] });
  for (const dx of [-0.4, 0.4]) b.cyl(dx, 1.2, 0, 0.1, 0.1, 0.4, '#8a6a3c', 6);
  b.pop();
  b.collide(-15, -16, 1.8, 1.8, 2.4, false);
  metroEntrance(b, -24, -18, 0.0, '渋谷駅 Shibuya Sta.', '#2a9d8f');
  greenTree(b, -12.5, -22, 1.1, r); greenTree(b, -29, -23, 1, r); greenTree(b, -19, -12.6, 0.9, r);
  bench(b, -18, -21.5, 0); bench(b, -12, -13, Math.PI);
  b.collide(-30, -18, 0.5, 14, 3); // plaza west edge (behind rival lies block)
  // NE screen tower
  b.push(20, 0, -F, 0);
  building(b, { x: 0, w: 18, d: 14, floors: 10, style: 'modern', r, color: '#c9d3dd', shop: 'Q-FRONT', shopColor: '#111', plain: true, kind: 'generic', sideWindows: true });
  b.box(0, 14, 0.15, 13, 7.6, 0.3, '#14141f');
  b.pop();
  const sc1 = new Screen(12, 6.75, 0); sc1.mesh.position.set(20, 16, -F + 0.4); ctx.screens.push(sc1);
  const sc2 = new Screen(7, 4, 1); sc2.mesh.position.set(11 - 0.2, 24, -F - 6); sc2.mesh.rotation.y = -Math.PI / 2; ctx.screens.push(sc2);
  // SW tower screen facing the crossing (over the shibuya_crossing neighbour)
  b.push(-14.25, 0, F, Math.PI);
  building(b, { x: 0, w: 5.5, d: 14, floors: 9, style: 'modern', r, color: '#8d99ae', plain: true, sideWindows: true });
  b.pop();
  const sc3 = new Screen(8, 4.5, 2); sc3.mesh.position.set(-11 + 0.3, 20, F + 6); sc3.mesh.rotation.y = Math.PI / 2; ctx.screens.push(sc3);
  // neon vertical signs on corners
  for (const [x, z, ry, t, c] of [[F + 0.4, -F - 20, -Math.PI / 2, 'カラオケ', '#ff006e'], [-F - 0.4, F + 20, Math.PI / 2, 'ゲーム', '#3a86ff'], [F + 0.4, F + 22, -Math.PI / 2, 'ラーメン', '#ffbe0b']] as const) {
    b.sign(x as number, 9, z as number, 1.4, 6, t as string, { bg: '#14141f', fg: c as string, vertical: true, ry: ry as number, px: 60, border: c as string });
  }
  for (const x of [-50, 52]) { vending(b, x, -F + 0.6, 0, '#ff006e'); vending(b, x + 1.1, -F + 0.6, 0, '#3a86ff'); }
  for (let i = 0; i < 6; i++) bike(b, -56 + i * 0.7, F - 0.7, Math.PI / 2, ['#3a86ff', '#ff006e', '#8ac926'][i % 3]);
  cityTraffic(ctx, R, [['taxi', '#1d3557'], ['bus', '#e9f5db'], ['sedan', '#ffffff'], ['kei', '#ffbe0b'], ['scooter', '#ff006e'], ['taxi', '#ffd23f'], ['van', '#c9d1db'], ['sedan', '#e63946'], ['scooter', '#3a86ff']]);
  return {
    spawn: S(-24, -14.2, Math.PI / 2), metro: S(-24, -15.5, Math.PI),
    walk: cityWalk(F), edges: cityEdges(F),
    npcs: [{ id: 'ryo', name: 'Ryo Tanaka', spot: S(-36.5, -F + 1.2, 0) }],
  };
}

// ================================================================ SHINJUKU
function shinjuku(ctx: Ctx): Layout {
  const { b, r } = ctx;
  const R = 8;
  ctx.sites.push({ id: 'shinjuku_lunch', x: -26, z: 13, ry: Math.PI, w: 12, d: 10, style: 'modern', color: '#cfd8dc' });
  ctx.sites.push({ id: 'shinjuku_tower', x: 28, z: -13, ry: 0, w: 18, d: 16, style: 'modern', color: '#90a4ae' });
  ctx.rivals.push(new RivalView('kaiten', 'shinjuku', -26, -13, 0, 10, 'modern', ctx.atlas));
  ctx.rivals.push(new RivalView('maguro', 'shinjuku', -42, -13, 0, 10, 'modern', ctx.atlas));
  ctx.rivals.push(new RivalView('golden', 'shinjuku', -46, 13, Math.PI, 10, 'modern', ctx.atlas));
  ctx.hq = new HQView(28, 13, Math.PI);
  const F = crossCity(ctx, {
    road: R, side: 5, style: 'modern', shops: [], kinds: ['ramen', 'izakaya', 'konbini', 'pharmacy', 'soba', 'realestate', 'karaoke', 'generic', 'kissaten', 'izakaya'], colors: ['#cfd8dc', '#b0bec5', '#eceff1', '#a7b6c2', '#dfe6e9', '#d8c3a5', '#c9b18f'],
    minF: 5, maxF: 9, lanes: 4, lampStyle: 'modern', neon: true,
    reservedEW: { north: [[-31, -21], [-47, -37], [19, 37], [-21, -13]], south: [[-32, -20], [-51, -41], [17, 39]] },
    northCornerDepth: { east: 17 },
  });
  // NW plaza with metro
  b.box(-17, 0.002, -19.5, 8, 0.012, 13, '#c5c9cf');
  metroEntrance(b, -17, -18.5, 0, '新宿駅 Shinjuku Sta.', '#43a047');
  greenTree(b, -14.2, -22.5, 1, r); greenTree(b, -19.8, -22.5, 1, r);
  b.collide(-21, -19.5, 0.6, 13, 3);
  // HQ forecourt fountain
  b.cyl(14.5, 0, 22, 1.8, 1.9, 0.5, '#bfc6cf', 20); b.add(G.cyl(1.6, 1.6, 0.05, 20), '#7fc8f8', { at: [14.5, 0.46, 22], glow: '#2a7fbf' });
  b.cyl(14.5, 0.5, 22, 0.2, 0.25, 1.2, '#bfc6cf', 10); b.collide(14.5, 22, 3.6, 3.6, 1, false);
  // skyscraper skyline
  for (const [x, z, w, h, c] of [[-35, -48, 22, 110, '#7f93a8'], [5, -52, 18, 140, '#5f7488'], [40, -46, 20, 95, '#8aa0b5'], [-30, 52, 20, 120, '#6c8197'], [30, 55, 24, 100, '#7a8ea3'], [65, -10, 16, 85, '#9db0c2'], [-65, 10, 16, 90, '#5d6f82']] as const) {
    b.push(x, 0, z + w / 2, 0);
    building(b, { x: 0, w, d: w, floors: Math.floor(h / 3.6), style: 'tower', r, color: c, collide: false, noFront: true });
    b.pop();
  }
  for (let x = -58; x <= 58; x += 9) if (Math.abs(x) > F + 3) { if (Math.abs(x + 3 + 17) > 5) greenTree(b, x + 3, -R - 2.2, 0.9, r); greenTree(b, x - 2, R + 2.2, 0.9, r); }
  for (const x of [-55, 50]) { vending(b, x, -F + 0.6, 0, '#43a047'); vending(b, x + 1.1, -F + 0.6, 0, '#e94e3c'); }
  cityTraffic(ctx, R, [['taxi', '#1d3557'], ['bus', '#e9f5db'], ['sedan', '#2b2d42'], ['van', '#ffffff'], ['taxi', '#ffd23f'], ['sedan', '#8d99ae'], ['kei', '#ffffff'], ['bus', '#a8dadc'], ['scooter', '#ff9f1c']]);
  return {
    spawn: S(-17, -15, 0), metro: S(-17, -17.2, Math.PI), hq: S(28, F - 0.8, Math.PI),
    walk: cityWalk(F), edges: cityEdges(F),
    npcs: [{ id: 'sato', name: 'Mr. Sato', spot: S(22, F - 1.4, Math.PI) }],
  };
}

// ================================================================ GINZA
function ginza(ctx: Ctx): Layout {
  const { b, r } = ctx;
  const R = 6;
  ctx.sites.push({ id: 'ginza_omakase', x: -24, z: 11, ry: Math.PI, w: 12, d: 10, style: 'lux', color: '#f5f1e8' });
  ctx.sites.push({ id: 'ginza_flagship', x: -28, z: -11, ry: 0, w: 18, d: 16, style: 'lux', color: '#efe8da' });
  ctx.rivals.push(new RivalView('golden', 'ginza', 26, 11, Math.PI, 12, 'lux', ctx.atlas));
  const F = crossCity(ctx, {
    road: R, side: 5, style: 'lux', shops: [], kinds: ['boutique', 'boutique', 'boutique', 'kissaten', 'florist', 'boutique', 'generic'], colors: ['#f5f1e8', '#ece4d4', '#e8e0d0', '#d9d2c5', '#f8f4ec', '#c9bfae'],
    minF: 4, maxF: 7, lanes: 4, lampStyle: 'lux',
    reservedEW: { north: [[-37, -19], [11, 26], [-17.2, -11]], south: [[-30, -18], [20, 32]] },
    northCornerDepth: { west: 17 },
  });
  // clock tower corner building
  b.push(18.5, 0, -F, 0);
  building(b, { x: 0, w: 15, d: 14, floors: 5, style: 'lux', r, color: '#d9d2c5', shop: 'WAKO-YA', shopColor: '#2d2d33' });
  b.pop();
  b.cyl(F + 2.4, 0, -F - 2.4, 3.2, 3.2, 18.5, '#e9e2d3', 24);
  b.cyl(F + 2.4, 18.5, -F - 2.4, 3.4, 3.4, 0.4, C.gold, 24);
  b.cyl(F + 2.4, 18.9, -F - 2.4, 2.6, 2.8, 3.2, '#e9e2d3', 24);
  b.add(G.sphere(2.2, 20, 12), '#4f6f52', { at: [F + 2.4, 22, -F - 2.4], scale: [1, 0.7, 1] });
  b.cyl(F + 2.4, 23.4, -F - 2.4, 0.08, 0.08, 2, C.gold, 6);
  b.collide(F + 2.4, -F - 2.4, 6.4, 6.4, 22);
  // clock face (diagonal toward the crossing) with live hands
  const clock = new THREE.Group();
  const face = new THREE.Mesh(new THREE.CircleGeometry(1.3, 32), new THREE.MeshStandardMaterial({ color: '#fffaf0', emissive: '#fff3d6', emissiveIntensity: 0.4 }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.08, 8, 32), new THREE.MeshStandardMaterial({ color: C.gold, metalness: 0.6, roughness: 0.3 }));
  const hm = new THREE.MeshStandardMaterial({ color: '#1d1d1d' });
  const hour = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.03).translate(0, 0.33, 0.03), hm);
  const min = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.05, 0.03).translate(0, 0.5, 0.05), hm);
  clock.add(face, ring, hour, min);
  hour.userData.dynamic = min.userData.dynamic = true;
  const dir = new THREE.Vector3(-1, 0, 1).normalize();
  clock.position.set(F + 2.4, 20.4, -F - 2.4).addScaledVector(dir, 2.75);
  clock.rotation.y = -Math.PI / 4;
  ctx.group.add(clock);
  ctx.extras.push((_dt, s) => { const m = s?.minute ?? 0; min.rotation.z = -((m % 60) / 60) * Math.PI * 2; hour.rotation.z = -((m / 60) % 12 / 12) * Math.PI * 2; });
  // metro entrance on the NW corner
  metroEntrance(b, -14.1, -F - 0.4, 0, '銀座駅 Ginza Sta.', '#f39c12');
  b.box(-14.1, 0, -F - 9, 6, 8, 9, '#ece4d4'); b.collide(-14.1, -F - 9, 6, 9, 8);
  // trimmed trees, flower beds, benches
  for (let x = -58; x <= 58; x += 10) if (Math.abs(x) > F + 3) {
    greenTree(b, x, -R - 1.3, 0.95, r); greenTree(b, x + 5, R + 1.3, 0.95, r);
  }
  for (const x of [-48, 44]) { bench(b, x, F - 0.8, Math.PI); planter(b, x + 2, F - 0.8, '#ffffff'); planter(b, x - 2, F - 0.8, '#ff7aa8'); }
  ctx.sakuras.push(sakura(b, -45, -F + 1.4, 0.8, r), sakura(b, 46, -F + 1.4, 0.8, r));
  cityTraffic(ctx, R, [['sedan', '#111111'], ['taxi', '#1d3557'], ['sedan', '#ffffff'], ['van', '#2d2d33'], ['sedan', '#7d1d3f'], ['taxi', '#ffd23f'], ['sedan', '#c0c0c0']]);
  return {
    spawn: S(-14.1, -F + 1.6, Math.PI / 2), metro: S(-14.1, -F + 0.6, Math.PI),
    walk: cityWalk(F), edges: cityEdges(F),
    npcs: [{ id: 'aoki', name: 'Madame Aoki', spot: S(-34, F - 1.3, Math.PI) }],
  };
}

const LAYOUTS: Record<DistrictId, (c: Ctx) => Layout> = { asakusa, shibuya, shinjuku, ginza };
