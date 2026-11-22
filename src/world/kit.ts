// World-building kit: a Builder that bakes transformed, vertex-colored primitives into a few merged
// meshes (chunked by area for culling), a night-glow material, a text-sign atlas and light pools.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Collider } from '../engine/collision';
import { painterly } from '../engine/geo';
import { Spot } from './types';

// ---------------------------------------------------------------- materials
/** Night glow strength (0 day … ~1.2 night). Shared by every glow mesh. */
export const glow = { value: 0.08 };

/** Vertex-colored material whose emission comes from a per-vertex `ecolor` attribute × glow. */
export const GLOW_MAT = painterly(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 }));
GLOW_MAT.onBeforeCompile = (sh) => {
  sh.uniforms.uGlow = glow;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 ecolor;\nvarying vec3 vEColor;')
    .replace('#include <color_vertex>', '#include <color_vertex>\nvEColor = ecolor;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uGlow;\nvarying vec3 vEColor;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEColor * uGlow;');
};
GLOW_MAT.customProgramCacheKey = () => 'glow-vc';

// ---------------------------------------------------------------- hand-painted procedural textures
/** Tileable value noise in [0,1]. */
function vnoise(period: number, seed: number): (x: number, y: number) => number {
  const h = (i: number, j: number) => { i = ((i % period) + period) % period; j = ((j % period) + period) % period; let n = i * 374761393 + j * 668265263 + seed * 144269; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v) + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  };
}

/** R: wall mottling + rain streaks, G: ground/top stains, B: fine grain. 0.5 ≈ neutral. */
function grimeTexture(): THREE.DataTexture {
  const N = 256, data = new Uint8Array(N * N * 4);
  const n1 = vnoise(8, 1), n2 = vnoise(16, 2), n3 = vnoise(32, 3), n4 = vnoise(64, 4);
  const streak = new Float32Array(N);
  for (let x = 0; x < N; x++) streak[x] = Math.random() < 0.08 ? 0.25 + Math.random() * 0.5 : 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x / N), v = (y / N);
    const f = 0.5 * n1(u * 8, v * 8) + 0.3 * n2(u * 16, v * 16) + 0.2 * n3(u * 32, v * 32);
    // vertical streaks that fade downward from random heights
    const st = streak[x] * Math.max(0, Math.sin(v * Math.PI * 2 + x)) * 0.6;
    const wall = 0.62 + (f - 0.5) * 0.7 - st * 0.5;
    const top = 0.6 + (0.6 * n2(u * 16 + 3, v * 16) + 0.4 * n4(u * 64, v * 64) - 0.5) * 0.8 - (n1(u * 8 + 5, v * 8) > 0.72 ? 0.15 : 0);
    const fine = n4(u * 64 + 7, v * 64 + 7);
    const i = (y * N + x) * 4;
    data[i] = Math.max(0, Math.min(255, wall * 255)); data[i + 1] = Math.max(0, Math.min(255, top * 255)); data[i + 2] = fine * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Kawara roof-tile luminance pattern: rounded tile columns with dark row overlaps. */
function tileTexture(): THREE.DataTexture {
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    const col = 0.72 + 0.38 * Math.sin(u * Math.PI); // rounded column
    const row = v < 0.12 ? 0.55 + v * 2 : 1 - (v - 0.12) * 0.25; // shadowed overlap at row top
    const val = Math.max(0, Math.min(1, col * row));
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = val * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const GRIME = grimeTexture(), TILE = tileTexture();

/** World-space painted wear: mottled walls, rain streaks, darker plinths, stained pavements; optional roof tiles. */
function worldMat(roof: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: roof ? 0.55 : 0.85, metalness: 0.0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGrime = { value: GRIME };
    sh.uniforms.uTile = { value: TILE };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uGrime;\nuniform sampler2D uTile;\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 an = abs(normalize(vWN));
        float topF = smoothstep(0.55, 0.85, an.y);
        vec2 uvV = vec2(vWPos.x * an.z + vWPos.z * an.x, vWPos.y);
        vec4 gV = texture2D(uGrime, uvV * 0.16);
        vec4 gT = texture2D(uGrime, vWPos.xz * 0.11);
        float wear = mix(gV.r, gT.g, topF);
        float grain = mix(gV.b, gT.b, topF);
        float shade = 0.88 + 0.24 * wear + 0.08 * (grain - 0.5);
        shade *= mix(mix(0.85, 1.0, smoothstep(0.0, 1.5, vWPos.y)), 1.0, topF);
        shade *= mix(1.0, 0.97, smoothstep(0.0, 1.0, fract(vWPos.y / 3.1)) * (1.0 - topF));
        ${roof ? `vec2 hn = normalize(vWN.xz + vec2(1e-4));
        vec2 ruv = vec2(dot(vWPos.xz, vec2(-hn.y, hn.x)) * 3.2, vWPos.y * 3.4);
        shade *= mix(texture2D(uTile, ruv).r, 1.0, smoothstep(0.92, 0.99, an.y)) * 1.12;` : ''}
        diffuseColor.rgb *= shade;`);
  };
  m.customProgramCacheKey = () => (roof ? 'world-roof' : 'world');
  return m;
}
export const WORLD_MAT = worldMat(false);
export const ROOF_MAT = worldMat(true);
/** Interiors: clean vertex colors, no street wear. */
export const CLEAN_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.0 });
/** Warm "lamp bounce" for interiors: emissive lift that grows at night (no extra lights, no recompiles). */
export const interiorWarm = { value: 0 };
CLEAN_MAT.onBeforeCompile = (sh) => {
  sh.uniforms.uWarm = interiorWarm;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uWarm;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.78, 0.55) * uWarm;');
};
CLEAN_MAT.customProgramCacheKey = () => 'clean-warm';
/** Display-case glass. */
export const GLASS_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.1, metalness: 0.1 });

// THREE.Color(hex) already converts sRGB → linear working space.
const lin = (hex: string) => new THREE.Color(hex);

function colorize(g: THREE.BufferGeometry, color: string, ecolor?: string, vary = 0): THREE.BufferGeometry {
  // keep (or create) an index: flat per-part colors don't need split vertices, and merge needs uniformity
  if (!g.index) { const n0 = g.attributes.position.count; const idx = new (n0 > 65535 ? Uint32Array : Uint16Array)(n0); for (let i = 0; i < n0; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  const n = g.attributes.position.count;
  const c = lin(color);
  if (vary) c.multiplyScalar(1 + (Math.random() - 0.5) * vary);
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (ecolor !== undefined) {
    const e = lin(ecolor);
    const b = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { b[i * 3] = e.r; b[i * 3 + 1] = e.g; b[i * 3 + 2] = e.b; }
    g.setAttribute('ecolor', new THREE.BufferAttribute(b, 3));
  }
  return g;
}

// ---------------------------------------------------------------- primitive factories (local, bottom-centered)
export const G = {
  box: (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0),
  rbox: (w: number, h: number, d: number, r = 0.08) => new RoundedBoxGeometry(w, h, d, r > 0.1 ? 2 : 1, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)).translate(0, h / 2, 0),
  cyl: (rt: number, rb: number, h: number, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(0, h / 2, 0),
  sphere: (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h),
  ico: (r: number, d = 1) => new THREE.IcosahedronGeometry(r, d),
  cone: (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg).translate(0, h / 2, 0),
  plane: (w: number, h: number) => new THREE.PlaneGeometry(w, h),
};

// ---------------------------------------------------------------- text atlas
interface SignOpts { bg?: string; fg?: string; font?: string; vertical?: boolean; border?: string; size?: number; sub?: string }
const JP_FONT = "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP','Meiryo',sans-serif";
export const FONT = `'Fredoka', ${JP_FONT}`;

/** Draw a sign into a 2D context region. */
export function drawSign(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, o: SignOpts = {}): void {
  ctx.save();
  ctx.fillStyle = o.bg ?? '#7a1f1f';
  ctx.fillRect(x, y, w, h);
  if (o.border) { ctx.strokeStyle = o.border; ctx.lineWidth = Math.max(3, Math.min(w, h) * 0.06); ctx.strokeRect(x + ctx.lineWidth / 2 + 2, y + ctx.lineWidth / 2 + 2, w - ctx.lineWidth - 4, h - ctx.lineWidth - 4); }
  ctx.fillStyle = o.fg ?? '#fff6dc';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const font = o.font ?? FONT;
  if (o.vertical) {
    const chars = [...text];
    const fs = Math.min(w * 0.72, (h * 0.9) / chars.length);
    ctx.font = `700 ${fs}px ${font}`;
    chars.forEach((ch, i) => ctx.fillText(ch, x + w / 2, y + h / 2 + (i - (chars.length - 1) / 2) * fs * 1.02));
  } else {
    let fs = (o.size ?? 0.62) * h * (o.sub ? 0.8 : 1);
    ctx.font = `700 ${fs}px ${font}`;
    const tw = ctx.measureText(text).width;
    const cy = y + h / 2 - (o.sub ? h * 0.13 : 0);
    if (tw > w * 0.9 && (w * 0.9) / tw < 0.62 && text.length > 6) {
      // too long for one line: wrap at the space nearest the middle (or mid-character for CJK)
      const mid = text.length / 2;
      let cut = -1;
      for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
      const a = cut > 0 ? text.slice(0, cut) : text.slice(0, Math.ceil(mid)), c = cut > 0 ? text.slice(cut + 1) : text.slice(Math.ceil(mid));
      const hb = o.sub ? h * 0.62 : h * 0.9; // vertical room for the 2-line block
      fs = Math.min(fs * 0.62, hb / 2.2);
      ctx.font = `700 ${fs}px ${font}`;
      const mw = Math.max(ctx.measureText(a).width, ctx.measureText(c).width);
      if (mw > w * 0.92) { fs *= (w * 0.92) / mw; ctx.font = `700 ${fs}px ${font}`; }
      const by = o.sub ? y + h * 0.04 + hb / 2 : y + h / 2;
      ctx.fillText(a, x + w / 2, by - fs * 0.56); ctx.fillText(c, x + w / 2, by + fs * 0.56);
    } else {
      if (tw > w * 0.9) { fs *= (w * 0.9) / tw; ctx.font = `700 ${fs}px ${font}`; }
      ctx.fillText(text, x + w / 2, cy);
    }
    if (o.sub) { ctx.font = `600 ${h * 0.2}px ${font}`; ctx.fillText(o.sub, x + w / 2, y + h * 0.8); }
  }
  ctx.restore();
}

export class Atlas {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  mat: THREE.MeshStandardMaterial;
  decalMat: THREE.MeshStandardMaterial;
  private x = 0; private y = 0; private row = 0;
  private ops: (() => void)[] = [];

  constructor(public size = 2048) {
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, emissiveMap: this.tex, emissive: '#ffffff', emissiveIntensity: 0.25, roughness: 0.6 });
    this.decalMat = new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2 });
    // re-render once web fonts are ready (signs drawn earlier used fallback fonts)
    document.fonts?.ready.then(() => this.redraw());
  }

  /** Reserve a w×h pixel region and draw a sign there; returns UV rect. */
  sign(text: string, w: number, h: number, o: SignOpts = {}): [number, number, number, number] {
    if (this.x + w > this.size) { this.x = 0; this.y += this.row + 2; this.row = 0; }
    if (this.y + h > this.size) { this.x = 0; this.y = 0; this.row = 0; } // ponytail: overflow wraps (overwrites); atlas sized generously
    const x = this.x, y = this.y;
    this.x += w + 2; this.row = Math.max(this.row, h);
    const op = () => drawSign(this.ctx, x, y, w, h, text, o);
    op(); this.ops.push(op);
    this.tex.needsUpdate = true;
    const S = this.size;
    return [x / S, 1 - (y + h) / S, (x + w) / S, 1 - y / S];
  }

  /** Reserve a region and paint it with a custom function (decals, emblems). */
  custom(w: number, h: number, draw: (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void): [number, number, number, number] {
    if (this.x + w > this.size) { this.x = 0; this.y += this.row + 2; this.row = 0; }
    const x = this.x, y = this.y;
    this.x += w + 2; this.row = Math.max(this.row, h);
    const op = () => { this.ctx.save(); draw(this.ctx, x, y, w, h); this.ctx.restore(); };
    op(); this.ops.push(op);
    this.tex.needsUpdate = true;
    const S = this.size;
    return [x / S, 1 - (y + h) / S, (x + w) / S, 1 - y / S];
  }

  redraw(): void { for (const op of this.ops) op(); this.tex.needsUpdate = true; }
}

/** Remap a geometry's 0..1 UVs into an atlas rect. */
function remapUV(g: THREE.BufferGeometry, r: [number, number, number, number]): THREE.BufferGeometry {
  g = g.index ? g.toNonIndexed() : g;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  return g;
}

// ---------------------------------------------------------------- builder
type Layer = 'vc' | 'glow' | 'roof' | 'clean' | 'glass';

/**
 * Accumulates geometry in a local frame stack and merges it into a few meshes.
 * Coordinates: bottom-centered primitives, y up. push(x,y,z,ry) enters a rotated sub-frame.
 */
export class Builder {
  private m = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  private ry = 0; private ryStack: number[] = [];
  private cells = new Map<string, { vc: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[]; roof: THREE.BufferGeometry[]; clean: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[] }>();
  private signs: THREE.BufferGeometry[] = [];
  private decals: THREE.BufferGeometry[] = [];
  private pools: THREE.BufferGeometry[] = [];
  colliders: Collider[] = [];
  /** When true, opaque parts use the clean (no-wear) interior material. */
  clean = false;

  constructor(public atlas: Atlas | null = null, private cell = 40) {}

  push(x: number, y: number, z: number, ry = 0): this {
    this.stack.push(this.m.clone()); this.ryStack.push(this.ry);
    this.m.multiply(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z));
    this.ry += ry;
    return this;
  }
  pop(): this { this.m = this.stack.pop()!; this.ry = this.ryStack.pop()!; return this; }

  /** Local point → world. */
  world(x: number, y: number, z: number): THREE.Vector3 { return new THREE.Vector3(x, y, z).applyMatrix4(this.m); }
  spot(x: number, z: number, yaw = 0): Spot { const p = this.world(x, 0, z); return { x: p.x, z: p.z, yaw: yaw + this.ry }; }

  /** Add a geometry already positioned in local space. */
  add(g: THREE.BufferGeometry, color: string, o: { at?: [number, number, number]; rot?: [number, number, number]; scale?: [number, number, number]; glow?: string; roof?: boolean; vary?: number; glass?: boolean } = {}): this {
    if (o.at || o.rot || o.scale) {
      const t = new THREE.Matrix4().compose(
        new THREE.Vector3(...(o.at ?? [0, 0, 0])),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))),
        new THREE.Vector3(...(o.scale ?? [1, 1, 1])));
      g.applyMatrix4(t);
    }
    g.applyMatrix4(this.m);
    const layer: Layer = o.glass ? 'glass' : o.glow !== undefined ? 'glow' : o.roof ? 'roof' : this.clean ? 'clean' : 'vc';
    g = colorize(g, color, o.glow, o.vary ?? (layer === 'glow' ? 0 : 0.07));
    g.computeBoundingBox();
    const c = g.boundingBox!.getCenter(new THREE.Vector3());
    const key = `${Math.floor(c.x / this.cell)},${Math.floor(c.z / this.cell)}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = { vc: [], glow: [], roof: [], clean: [], glass: [] }));
    cell[layer].push(g);
    return this;
  }

  // shorthands (x,y,z = bottom center in local frame)
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, glowC?: string, ry = 0): this {
    return this.add(G.box(w, h, d), color, { at: [x, y, z], rot: [0, ry, 0], glow: glowC });
  }
  rbox(x: number, y: number, z: number, w: number, h: number, d: number, color: string, r = 0.08, glowC?: string, ry = 0): this {
    return this.add(G.rbox(w, h, d, r), color, { at: [x, y, z], rot: [0, ry, 0], glow: glowC });
  }
  cyl(x: number, y: number, z: number, rt: number, rb: number, h: number, color: string, seg = 12, glowC?: string): this {
    return this.add(G.cyl(rt, rb, h, seg), color, { at: [x, y, z], glow: glowC });
  }
  sphere(x: number, y: number, z: number, r: number, color: string, sy = 1, glowC?: string): this {
    return this.add(G.sphere(r), color, { at: [x, y, z], scale: [1, sy, 1], glow: glowC });
  }

  /** Text sign: a vertical plane facing local +z, center at (x,y,z), size w×h meters. */
  sign(x: number, y: number, z: number, w: number, h: number, text: string, o: SignOpts & { ry?: number; px?: number } = {}): this {
    if (!this.atlas) return this;
    const ppm = o.px ?? 64;
    const rect = this.atlas.sign(text, Math.round(w * ppm), Math.round(h * ppm), o);
    const g = remapUV(G.plane(w, h), rect);
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(o.ry ?? 0).setPosition(x, y, z)).applyMatrix4(this.m);
    this.signs.push(g);
    return this;
  }

  /** Glowing light pool decal on the ground at night (under lamps, lanterns, windows). */
  pool(x: number, z: number, r: number, color = '#ffcf7a'): this {
    const g = colorize(G.plane(r * 2, r * 2).rotateX(-Math.PI / 2).translate(x, 0.045, z), color);
    const uvg = G.plane(1, 1);
    g.setAttribute('uv', uvg.attributes.uv);
    g.applyMatrix4(this.m);
    this.pools.push(g);
    return this;
  }

  /** Vertical panel (facing local +z) showing an atlas region, e.g. a painted menu board. */
  panel(x: number, y: number, z: number, w: number, h: number, rect: [number, number, number, number], ry = 0, rx = 0): this {
    const g = remapUV(G.plane(w, h), rect);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, 0)).setPosition(x, y, z)).applyMatrix4(this.m);
    this.signs.push(g);
    return this;
  }

  /** Flat decal lying on the ground (atlas-drawn), e.g. manhole covers. */
  decal(x: number, z: number, w: number, d: number, rect: [number, number, number, number], y = 0.03, round = false): this {
    const g = remapUV(round ? new THREE.CircleGeometry(0.5, 24) : G.plane(1, 1), rect);
    g.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).applyMatrix4(new THREE.Matrix4().makeScale(w, 1, d)).applyMatrix4(new THREE.Matrix4().setPosition(x, y, z)).applyMatrix4(this.m);
    this.decals.push(g);
    return this;
  }

  /** Collider spanning y0..y1 (overhangs like awnings that should block the camera but not the player). */
  collideY(x: number, z: number, w: number, d: number, y0: number, y1: number, camera = true): this {
    this.collide(x, z, w, d, y1 - y0, camera);
    const c = this.colliders[this.colliders.length - 1];
    c.minY += y0; c.maxY += y0;
    c.player = false; // overhangs block the camera only
    return this;
  }

  /** Axis-aligned collider from a local rect (frame rotations should be multiples of 90°). */
  collide(x: number, z: number, w: number, d: number, h = 3, camera?: boolean): this {
    const p = this.world(x, 0, z);
    const rot = Math.abs(Math.round(this.ry / (Math.PI / 2))) % 2 === 1;
    const W = rot ? d : w, D = rot ? w : d;
    this.colliders.push({ minX: p.x - W / 2, maxX: p.x + W / 2, minY: p.y, maxY: p.y + h, minZ: p.z - D / 2, maxZ: p.z + D / 2, camera: camera ?? h > 1.6 });
    return this;
  }

  /** Bake everything into a Group of merged meshes. */
  build(shadows = true): THREE.Group {
    const out = new THREE.Group();
    for (const cell of this.cells.values()) {
      for (const layer of ['vc', 'glow', 'roof', 'clean', 'glass'] as Layer[]) {
        const parts = cell[layer];
        if (!parts.length) continue;
        const g = mergeGeometries(parts);
        if (!g) continue;
        const mesh = new THREE.Mesh(g, layer === 'vc' ? WORLD_MAT : layer === 'roof' ? ROOF_MAT : layer === 'clean' ? CLEAN_MAT : layer === 'glass' ? GLASS_MAT : GLOW_MAT);
        if (layer === 'glass') { mesh.castShadow = false; mesh.renderOrder = 2; }
        mesh.castShadow = shadows; mesh.receiveShadow = true;
        out.add(mesh);
        for (const p of parts) p.dispose();
      }
    }
    if (this.signs.length && this.atlas) {
      const m = new THREE.Mesh(mergeGeometries(this.signs)!, this.atlas.mat);
      m.receiveShadow = true;
      out.add(m);
    }
    if (this.decals.length && this.atlas) {
      const m = new THREE.Mesh(mergeGeometries(this.decals)!, this.atlas.decalMat);
      m.receiveShadow = true;
      out.add(m);
    }
    if (this.pools.length) {
      const m = new THREE.Mesh(mergeGeometries(this.pools)!, POOL_MAT);
      m.renderOrder = 1;
      out.add(m);
    }
    this.cells.clear(); this.signs = []; this.pools = []; this.decals = [];
    return out;
  }
}

// ---------------------------------------------------------------- light pools
function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); return t;
}
export const RADIAL = radialTexture();
export const POOL_MAT = new THREE.MeshBasicMaterial({ map: RADIAL, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });

/** Seeded RNG so districts look the same every visit. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
