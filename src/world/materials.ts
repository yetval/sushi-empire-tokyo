// Shared material palette for the "architect's model" look: matte, warm off-white surfaces, restrained pastels,
// saturated colour only on signage, lanterns and the brand red. Every material is a cached shared instance.
//
// ---------------------------------------------------------------------------------------------- API (stable)
//   mat(name: MatName): THREE.MeshStandardMaterial
//       Shared, cached instance. Never mutate or dispose it; clone() if a one-off tweak is really needed.
//   PALETTE: Record<MatName, string>
//       sRGB hex base colour of every material, for vertex-colour baking (Builder / paint()) or instance colours.
//   bevelBox(w, h, d, r?): THREE.BufferGeometry
//       Cached RoundedBoxGeometry, centred at the origin like BoxGeometry (drop-in replacement).
//       r defaults to ~6% of the smallest side (clamped 0.01..0.08). SHARED: clone() before applyMatrix4/translate/merge.
//   nightGlow: { value: number }
//       Uniform-shaped night factor for custom shaders (0 by day ... ~1.05 at night). 'paintGlow' already uses it.
//   setMaterialNight(n: number): void
//       Drives emissive strength of neon / lanterns / lit windows. Called every frame by Sky.setTime(); don't call it yourself.
//   setMaterialWet(w: number): void
//       0 dry .. 1 soaked: lowers roughness of the street materials (asphalt, paving, concrete, curb, road lines). For weather.ts.
//   initMaterials(renderer): void
//       Builds the one shared PMREM studio environment for glass/metal/gloss. Called by the Sky constructor.
//
// Names (see PALETTE for colours):
//   surfaces  plaster, plasterWarm, concrete, concreteDark, paving, timber, timberDark, roofSlate, roofCopper
//   pastels   pastelSage, pastelSky, pastelBlush, pastelSand, pastelMint, pastelLilac, pastelButter, pastelClay
//   glass     glass (opaque tinted pane with soft sky/studio reflection), glassClear (transparent, for shopfronts)
//   metal     metalDark, metalBrushed
//   street    asphalt, roadLine, roadLineYellow, curb
//   nature    foliage, foliageDark, water
//   accents   vermilion (#b82d25 brand), lanternRed, neonPink, neonCyan, neonAmber, windowLit  (all emissive at night)
//   vertex    paint (matte, vertexColors), paintGloss (car-body clearcoat-ish, vertexColors),
//             paintGlow (vertexColors + per-vertex `ecolor` attribute emission x nightGlow)
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export const PALETTE = {
  plaster: '#f1ece2', plasterWarm: '#e9dfcf', concrete: '#cdcac3', concreteDark: '#a19e98', paving: '#d9d4ca',
  timber: '#c9a682', timberDark: '#7d5d43', roofSlate: '#545a63', roofCopper: '#8fae9f',
  pastelSage: '#b8c4ab', pastelSky: '#b6c8d5', pastelBlush: '#e2c5bb', pastelSand: '#e3d3b6',
  pastelMint: '#c2d7cb', pastelLilac: '#c8c1d5', pastelButter: '#ebdfae', pastelClay: '#d3aa91',
  glass: '#46586a', glassClear: '#c9dbe6',
  metalDark: '#3b3e44', metalBrushed: '#aeb2b7',
  asphalt: '#5f6267', roadLine: '#f3f0e8', roadLineYellow: '#ddb244', curb: '#bdb9b1',
  foliage: '#8fa47b', foliageDark: '#687f5d', water: '#4f6c79',
  vermilion: '#b82d25', lanternRed: '#cf3a2c', neonPink: '#ff5aa8', neonCyan: '#46dcff', neonAmber: '#ffb347', windowLit: '#3a4450',
  paint: '#ffffff', paintGloss: '#ffffff', paintGlow: '#ffffff',
} as const;
export type MatName = keyof typeof PALETTE;

type Spec = { r: number; m?: number; env?: number; e?: string; day?: number; night?: number; vc?: boolean; t?: number };
// r roughness, m metalness, env envMapIntensity, e emissive colour with intensity day..night, t opacity
const SPEC: Record<MatName, Spec> = {
  plaster: { r: 0.9 }, plasterWarm: { r: 0.9 }, concrete: { r: 0.93 }, concreteDark: { r: 0.93 }, paving: { r: 0.95 },
  timber: { r: 0.78 }, timberDark: { r: 0.78 }, roofSlate: { r: 0.72 }, roofCopper: { r: 0.7 },
  pastelSage: { r: 0.88 }, pastelSky: { r: 0.88 }, pastelBlush: { r: 0.88 }, pastelSand: { r: 0.88 },
  pastelMint: { r: 0.88 }, pastelLilac: { r: 0.88 }, pastelButter: { r: 0.88 }, pastelClay: { r: 0.88 },
  glass: { r: 0.08, m: 0.2, env: 1.1 }, glassClear: { r: 0.05, m: 0.1, env: 1.0, t: 0.3 },
  metalDark: { r: 0.45, m: 0.75, env: 0.8 }, metalBrushed: { r: 0.32, m: 0.9, env: 1.0 },
  asphalt: { r: 0.97 }, roadLine: { r: 0.75 }, roadLineYellow: { r: 0.75 }, curb: { r: 0.92 },
  foliage: { r: 0.95 }, foliageDark: { r: 0.95 }, water: { r: 0.12, m: 0.1, env: 0.9 },
  vermilion: { r: 0.6 },
  lanternRed: { r: 0.55, e: '#ff5a32', day: 0.12, night: 1.9 },
  neonPink: { r: 0.4, e: '#ff3f9e', day: 0.35, night: 2.8 },
  neonCyan: { r: 0.4, e: '#2fd6ff', day: 0.35, night: 2.8 },
  neonAmber: { r: 0.4, e: '#ffa53a', day: 0.3, night: 2.6 },
  windowLit: { r: 0.15, m: 0.2, env: 0.9, e: '#ffc27e', day: 0.0, night: 1.35 },
  paint: { r: 0.88, vc: true }, paintGloss: { r: 0.32, m: 0.25, env: 1.0, vc: true }, paintGlow: { r: 0.6, vc: true },
};

const cache = new Map<MatName, THREE.MeshStandardMaterial>();
let env: THREE.Texture | null = null;
let night = 0;

export const nightGlow = { value: 0.05 };

export function mat(name: MatName): THREE.MeshStandardMaterial {
  let m = cache.get(name);
  if (m) return m;
  const s = SPEC[name];
  m = new THREE.MeshStandardMaterial({ color: s.vc ? '#ffffff' : PALETTE[name], vertexColors: !!s.vc, roughness: wetR(name), metalness: s.m ?? 0 });
  m.name = `mat:${name}`;
  if (s.env) { m.envMap = env; m.envMapIntensity = s.env; }
  if (s.t !== undefined) { m.transparent = true; m.opacity = s.t; m.depthWrite = false; }
  if (s.e) { m.emissive.set(s.e); m.emissiveIntensity = THREE.MathUtils.lerp(s.day!, s.night!, night); }
  if (name === 'paintGlow') {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uGlow = nightGlow;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 ecolor;\nvarying vec3 vEColor;')
        .replace('#include <color_vertex>', '#include <color_vertex>\nvEColor = ecolor;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlow;\nvarying vec3 vEColor;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEColor * uGlow;');
    };
    m.customProgramCacheKey = () => 'mat-paintGlow';
  }
  cache.set(name, m);
  return m;
}

export function setMaterialNight(n: number): void {
  night = n;
  nightGlow.value = 0.05 + n;
  for (const [name, m] of cache) {
    const s = SPEC[name];
    if (s.e) m.emissiveIntensity = THREE.MathUtils.lerp(s.day!, s.night!, n);
    if (s.env) m.envMapIntensity = s.env * (1 - 0.75 * n); // the studio env is a daylight reflection: dim it at night
  }
}

const WET: MatName[] = ['asphalt', 'paving', 'concrete', 'concreteDark', 'curb', 'roadLine', 'roadLineYellow'];
let wet = 0;
const wetR = (name: MatName) => SPEC[name].r * (WET.includes(name) ? 1 - 0.5 * wet : 1);
export function setMaterialWet(w: number): void {
  wet = THREE.MathUtils.clamp(w, 0, 1);
  for (const name of WET) { const m = cache.get(name); if (m) m.roughness = wetR(name); }
}

export function initMaterials(renderer: THREE.WebGLRenderer): void {
  if (env) return;
  const pm = new THREE.PMREMGenerator(renderer);
  env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  for (const [name, m] of cache) if (SPEC[name].env) { m.envMap = env; m.needsUpdate = true; }
}

const boxes = new Map<string, THREE.BufferGeometry>();
export function bevelBox(w: number, h: number, d: number, r?: number): THREE.BufferGeometry {
  const rr = Math.min(r ?? THREE.MathUtils.clamp(Math.min(w, h, d) * 0.06, 0.01, 0.08), w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${rr.toFixed(3)}`;
  let g = boxes.get(key);
  if (!g) { g = new RoundedBoxGeometry(w, h, d, 2, Math.max(1e-3, rr)); boxes.set(key, g); }
  return g;
}
