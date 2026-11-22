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

function colorize(g: THREE.BufferGeometry, color: string, ecolor?: string, vary = 0, rnd: () => number = Math.random): THREE.BufferGeometry {
  // keep (or create) an index: flat per-part colors don't need split vertices, and merge needs uniformity
  if (!g.index) { const n0 = g.attributes.position.count; const idx = new (n0 > 65535 ? Uint32Array : Uint16Array)(n0); for (let i = 0; i < n0; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  const n = g.attributes.position.count;
  const c = lin(color);
  if (vary) c.multiplyScalar(1 + (rnd() - 0.5) * vary);
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
/** Box with 45° chamfered edges and corners (26 faces, flat normals): bottom-centered. */
function chamferBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const X = w / 2, Y = h / 2, Z = d / 2;
  const pos: number[] = [];
  // the 24 corner points of the chamfered hull, grouped by (sx,sy,sz) corner and axis of truncation
  const P = (sx: number, sy: number, sz: number, ax: number) => [sx * (ax === 0 ? X : X - r), sy * (ax === 1 ? Y : Y - r), sz * (ax === 2 ? Z : Z - r)];
  const quad = (a: number[], b: number[], c: number[], e: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...e);
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  for (const ax of [0, 1, 2]) for (const s of [-1, 1]) { // 6 main faces
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    const pt = (su: number, sv: number) => { const c = [0, 0, 0]; c[ax] = s; c[u] = su; c[v] = sv; return P(c[0], c[1], c[2], ax); };
    if (s > 0) quad(pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)); else quad(pt(-1, -1), pt(-1, 1), pt(1, 1), pt(1, -1));
  }
  for (const ax of [0, 1, 2]) for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) { // 12 edge chamfers (edge runs along ax)
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    const pt = (sa: number, axis: number) => { const c = [0, 0, 0]; c[ax] = sa; c[u] = s1; c[v] = s2; return P(c[0], c[1], c[2], axis); };
    const a = pt(-1, u), b = pt(1, u), c = pt(1, v), e = pt(-1, v);
    if (s1 * s2 > 0) quad(a, e, c, b); else quad(a, b, c, e);
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { // 8 corner triangles
    const a = P(sx, sy, sz, 0), b = P(sx, sy, sz, 1), c = P(sx, sy, sz, 2);
    if (sx * sy * sz > 0) tri(a, b, c); else tri(a, c, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g.translate(0, Y, 0);
}

export const G = {
  box: (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0),
  rbox: (w: number, h: number, d: number, r = 0.08) => new RoundedBoxGeometry(w, h, d, r > 0.1 ? 2 : 1, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)).translate(0, h / 2, 0),
  /** Chamfered box (one bevel segment, softened normals): crisp model-like edges for masses, slabs and kerbs. */
  bbox: (w: number, h: number, d: number, r = 0.05) => chamferBox(w, h, d, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)),
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
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (o.vertical) {
    const chars = [...text];
    const fs = Math.min(w * 0.72, (h * 0.9) / chars.length);
    ctx.font = `700 ${fs}px ${font}`;
    chars.forEach((ch, i) => ctx.fillText(ch, x + w / 2, y + h / 2 + (i - (chars.length - 1) / 2) * fs * 1.02));
  } else {
    // Fit inside the border (or a small margin) and clip to the region: glyphs never bleed into atlas neighbours.
    const inset = o.border ? Math.max(3, Math.min(w, h) * 0.06) + 4 : Math.max(2, Math.min(w, h) * 0.05);
    const iw = w - inset * 2, subH = o.sub ? h * 0.26 : 0;
    const top = y + inset, ih = h - inset * 2 - subH, mid = top + ih / 2, cx = x + w / 2;
    const base = Math.min((o.size ?? 0.62) * h * (o.sub ? 0.8 : 1), ih * 0.86);
    const widthAt = (t: string, f: number) => { ctx.font = `700 ${f}px ${font}`; return ctx.measureText(t).width; };
    const fs1 = Math.min(base, base * iw / Math.max(1, widthAt(text, base)));
    // two lines: split at the space nearest the middle (or mid-string for CJK)
    let cut = -1;
    const half = text.length / 2;
    for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (cut < 0 || Math.abs(i - half) < Math.abs(cut - half))) cut = i;
    const l1 = cut > 0 ? text.slice(0, cut) : text.slice(0, Math.ceil(half)), l2 = cut > 0 ? text.slice(cut + 1) : text.slice(Math.ceil(half));
    let fs2 = Math.min(base, ih / 2.3);
    fs2 = Math.min(fs2, fs2 * iw / Math.max(1, widthAt(l1, fs2), widthAt(l2, fs2)));
    if (text.length > 6 && fs1 < base * 0.62 && fs2 > fs1 * 1.15) {
      ctx.font = `700 ${fs2}px ${font}`;
      ctx.fillText(l1, cx, mid - fs2 * 0.58); ctx.fillText(l2, cx, mid + fs2 * 0.58);
    } else {
      ctx.font = `700 ${fs1}px ${font}`;
      ctx.fillText(text, cx, mid);
    }
    if (o.sub) {
      let sf = Math.min(h * 0.2, subH * 0.78);
      sf = Math.min(sf, sf * iw / Math.max(1, (ctx.font = `600 ${sf}px ${font}`, ctx.measureText(o.sub).width)));
      ctx.font = `600 ${sf}px ${font}`;
      ctx.fillText(o.sub, cx, y + h - inset - subH / 2);
    }
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

// ---------------------------------------------------------------- instanced detail parts
/** A reusable detail part (window bay, AC unit, railing bay…) drawn as one InstancedMesh per Builder.build().
 *  Its geometry carries baked vertex colors plus `emask` (1 = glass / lit parts, which take the per-instance glow). */
export interface Proto { name: string; geo: THREE.BufferGeometry; shadow: boolean; tint: 'mask' | 'body' }
const PROTOS = new Map<string, Proto>();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1), _black = new THREE.Color(0, 0, 0);
/** Define (once, cached by name) a prototype from Builder calls in its local frame. tint: what instance colors recolor. */
export function proto(name: string, build: (b: Builder) => void, o: { shadow?: boolean; tint?: 'mask' | 'body' } = {}): Proto {
  let p = PROTOS.get(name);
  if (!p) {
    const b = new Builder(null, 1e6);
    build(b);
    p = { name, geo: b.bake(), shadow: o.shadow ?? false, tint: o.tint ?? 'mask' };
    PROTOS.set(name, p);
  }
  return p;
}
function instMat(tint: 'mask' | 'body'): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float emask;\nattribute vec3 iglow;\nvarying float vEm;\nvarying vec3 vIG;')
      .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, ${tint === 'mask' ? 'emask' : '1.0 - emask'});
#endif
vEm = emask; vIG = iglow;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;\nvarying float vEm;\nvarying vec3 vIG;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.1, vEm * step(dot(vIG, vIG), 1e-6));')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vIG * vEm * uGlow;
{ // glass: a soft sky-gradient reflection by day so panes read as glass without an env map per material
  float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.5);
  float day = saturate(1.0 - uGlow * 1.2);
  totalEmissiveRadiance += vEm * step(dot(vIG, vIG), 1e-6) * vec3(0.42, 0.52, 0.62) * (0.05 + 0.4 * fres) * day;
}`);
  };
  m.customProgramCacheKey = () => 'inst-' + tint;
  return m;
}
/** Instanced parts whose instance colour tints the glass/lit panes (windows) or the body (AC units, bikes, vending). */
export const INST_MAT = instMat('mask');
export const INST_BODY_MAT = instMat('body');

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
  /** Instances grouped per (proto, coarse area cell) so each InstancedMesh gets a tight bounding sphere and frustum-culls. */
  private insts = new Map<string, { p: Proto; m: number[]; c: number[]; g: number[] }>();
  colliders: Collider[] = [];
  /** When true, opaque parts use the clean (no-wear) interior material. */
  clean = false;
  /** Seeded so per-part color variation (and therefore every district) is identical on every visit. */
  rnd = rng(9137);

  constructor(public atlas: Atlas | null = null, private cell = 40) {}

  /** Place one instance of a prototype part (bottom-centered, facing local +z) in the current frame.
   *  color tints the proto's tint target (glass or body), glow is the night emission of its masked (lit) parts. */
  inst(p: Proto, x: number, y: number, z: number, o: { ry?: number; rx?: number; rz?: number; s?: [number, number, number]; color?: string; glow?: string } = {}): this {
    _q.setFromEuler(_e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0));
    _v.set(x, y, z);
    _s.set(...(o.s ?? [1, 1, 1]));
    _m.compose(_v, _q, _s).premultiply(this.m);
    const IC = Math.max(this.cell, 48);
    const key = `${p.name}|${Math.floor(_m.elements[12] / IC)},${Math.floor(_m.elements[14] / IC)}`;
    let L = this.insts.get(key);
    if (!L) this.insts.set(key, (L = { p, m: [], c: [], g: [] }));
    L.m.push(..._m.elements);
    const c = o.color ? lin(o.color) : _white;
    L.c.push(c.r, c.g, c.b);
    const g = o.glow ? lin(o.glow) : _black;
    L.g.push(g.r, g.g, g.b);
    return this;
  }

  /** Merge everything added so far into ONE geometry with an `emask` attribute (1 = glow/glass parts). Used for protos. */
  bake(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    for (const cell of this.cells.values()) for (const layer of ['vc', 'glow', 'roof', 'clean', 'glass'] as Layer[]) for (const g of cell[layer]) {
      const n = g.attributes.position.count;
      g.setAttribute('emask', new THREE.BufferAttribute(new Float32Array(n).fill(layer === 'glow' || layer === 'glass' ? 1 : 0), 1));
      if (g.attributes.ecolor) g.deleteAttribute('ecolor');
      parts.push(g);
    }
    const out = mergeGeometries(parts)!;
    for (const g of parts) g.dispose();
    this.cells.clear();
    out.computeBoundingSphere();
    return out;
  }

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
    g = colorize(g, color, o.glow, o.vary ?? (layer === 'glow' ? 0 : 0.07), this.rnd);
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
    for (const L of this.insts.values()) {
      const p = L.p;
      const n = L.c.length / 3;
      const geo = p.geo.clone(); // own copy per mesh: the instanced glow attribute lives on the geometry
      geo.setAttribute('iglow', new THREE.InstancedBufferAttribute(new Float32Array(L.g), 3));
      const mesh = new THREE.InstancedMesh(geo, p.tint === 'body' ? INST_BODY_MAT : INST_MAT, n);
      (mesh.instanceMatrix.array as Float32Array).set(L.m);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(L.c), 3);
      mesh.castShadow = shadows && p.shadow; mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      mesh.name = 'inst:' + p.name;
      out.add(mesh);
    }
    this.insts.clear();
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
