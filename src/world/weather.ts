// Weather and atmosphere (visual only, no gameplay effect): clear / overcast / light rain / heavy rain / evening mist,
// picked per in-game day from a deterministic seed and eased in over real seconds. Everything heavy runs on the GPU:
// rain streaks, splash ripples, wet-road sheen with sky-reflecting puddles, kitchen steam, yakitori smoke, street-end
// haze and golden-hour dust motes. CPU cost per frame is a handful of uniform writes.
//
// ---------------------------------------------------------------------------------------------- API
//   weather.current: WeatherKind          today's state (or the forced one)
//   weather.isRaining: boolean            for umbrellas / audio
//   weather.rain, overcast, wetness: 0..1 eased intensities
//   weather.lightFactor: 0.45..1          multiply sun intensity by this (sky.ts)
//   weather.fogDensity: 0..1              0 = sky.ts default haze, 1 = thick mist (sky.ts maps it to fog near/far)
//   weather.setWeather(kind | null, instant?)  debug override; null returns to the daily schedule
//   weather.attach(group, district, views) / weather.update(dt, night, playerPos, state)   called by district.ts
import * as THREE from 'three';
import { audio } from '../audio/audio';
import { setMaterialWet } from './materials';
import type { DistrictId } from '../core/data';
import type { GameState } from '../core/state';
import type { SiteDef } from './sites';
import type { RestaurantSite } from './types';

export type WeatherKind = 'clear' | 'overcast' | 'lightRain' | 'heavyRain' | 'mist';
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'overcast', 'lightRain', 'heavyRain', 'mist'];

interface Look { rain: number; overcast: number; fog: number }
const LOOK: Record<WeatherKind, Look> = {
  clear: { rain: 0, overcast: 0, fog: 0 },
  overcast: { rain: 0, overcast: 0.85, fog: 0.25 },
  lightRain: { rain: 0.4, overcast: 1, fog: 0.4 },
  heavyRain: { rain: 1, overcast: 1, fog: 0.7 },
  mist: { rain: 0, overcast: 0.45, fog: 1 },
};
// daily odds; 40% of days simply keep yesterday's roll so spells of weather last a few days
const ODDS: [WeatherKind, number][] = [['clear', 0.4], ['overcast', 0.22], ['lightRain', 0.16], ['heavyRain', 0.08], ['mist', 0.14]];
const hash = (n: number): number => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const roll = (day: number): WeatherKind => { let u = hash(day * 2 + 1); for (const [k, p] of ODDS) if ((u -= p) < 0) return k; return 'clear'; };
export function weatherForDay(day: number): WeatherKind { return hash(day * 2) < 0.4 ? roll(day - 1) : roll(day); }

/** Roads + sidewalks per district (world xz rects) for the wet sheen and puddles. Mirrors the layouts in district.ts. */
// ponytail: hand-copied from district.ts road sizes; export the rects from the layouts if streets start moving.
type R4 = [number, number, number, number]; // x0 x1 z0 z1
const cross = (F: number): R4[] => [[-90, 90, -F, F], [-F, F, -90, -F], [-F, F, F, 90]];
const STREETS: Record<DistrictId, R4[]> = {
  asakusa: [[-90, 90, -7.4, 7.4], [-6.2, 6.2, -46, -7.4]],
  shibuya: cross(11), shinjuku: cross(13), ginza: cross(11),
} as Record<DistrictId, R4[]>;
// yakitori grills: three of the Nakamise stalls (district.ts: stalls at x=±8.2, z=-13.2-i*3.4-1.6, counter facing the lane)
const GRILLS: Partial<Record<DistrictId, [number, number, number][]>> = {
  asakusa: [[-7.85, 1.15, -16.4], [7.85, 1.15, -23.2], [-7.85, 1.15, -36.8]],
};

const CHUNK_OUT = '#include <tonemapping_fragment>\n#include <colorspace_fragment>';
const NOISE = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }`;

// ---------------------------------------------------------------- rain streaks (camera-relative box, fully on the GPU)
const RAIN_VS = `
attribute vec4 aSeed; uniform float uTime; uniform vec3 uBox; uniform vec2 uWind; uniform float uLen, uWidth;
varying float vT; varying float vA;
void main(){
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 c = cameraPosition + fwd * uBox.x * 0.35;            // the box sits in front of the camera, wherever it looks
  float speed = 15.0 + 7.0 * aSeed.w;
  float y = mod(aSeed.y * uBox.y - uTime * speed, uBox.y);
  vec3 p = vec3(c.x + mod(aSeed.x * uBox.x - c.x, uBox.x) - uBox.x * 0.5, c.y - uBox.y * 0.5 + y, c.z + mod(aSeed.z * uBox.z - c.z, uBox.z) - uBox.z * 0.5);
  p.xz += uWind * (uBox.y - y) / speed;                     // slanted fall
  vec3 up = normalize(vec3(-uWind.x, speed, -uWind.y));
  vec3 side = normalize(cross(up, normalize(cameraPosition - p)));
  vec3 wp = p + side * position.x * uWidth + up * position.y * uLen * (0.7 + 0.6 * aSeed.w);
  float d = distance(cameraPosition, p);
  vA = step(0.0, p.y) * smoothstep(2.5, 8.0, d) * (1.0 - smoothstep(uBox.x * 0.45, uBox.x * 0.6, d));
  vT = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RAIN_FS = `uniform vec3 uColor; uniform float uOpacity; varying float vT; varying float vA;
void main(){ float a = uOpacity * vA * smoothstep(0.0, 0.7, vT) * (1.0 - smoothstep(0.85, 1.0, vT)); if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
${CHUNK_OUT}
}`;

// ---------------------------------------------------------------- splash ripples around the player
const RIP_VS = `
attribute vec4 aSeed; uniform float uTime; uniform vec3 uFocus; uniform float uRadius;
varying vec2 vUv; varying float vPh;
float h(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float per = 0.7 + aSeed.w * 0.6;
  float k = uTime / per + aSeed.z;
  float cyc = floor(k); vPh = fract(k);
  vec2 off = (vec2(h(cyc * 12.9 + aSeed.x * 78.2), h(cyc * 39.3 + aSeed.y * 11.7)) - 0.5) * 2.0 * uRadius;
  float s = 0.18 + 0.16 * aSeed.x;
  vec3 wp = vec3(uFocus.x + off.x + position.x * s, 0.036, uFocus.z + off.y + position.y * s);
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const RIP_FS = `uniform float uOpacity; uniform vec3 uColor; varying vec2 vUv; varying float vPh;
void main(){ float r = length(vUv);
  float ring = smoothstep(0.09, 0.0, abs(r - vPh)) * (1.0 - vPh);
  float ring2 = smoothstep(0.07, 0.0, abs(r - vPh * 0.6)) * (1.0 - vPh) * 0.5;
  float a = (ring + ring2) * uOpacity * step(r, 1.0); if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
${CHUNK_OUT}
}`;

// ---------------------------------------------------------------- wet streets: sheen + puddles reflecting the sky
const WET_VS = `varying vec3 vW;
#include <fog_pars_vertex>
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`;
const WET_FS = `uniform float uWet, uNight, uTime, uRain; uniform vec3 top, hor; varying vec3 vW;
#include <fog_pars_fragment>
${NOISE}
void main(){
  vec2 q = vW.xz;
  // puddles: small, irregular, gathered along low spots; they grow as the street soaks
  float n = vnoise(q * 0.55) * 0.6 + vnoise(q * 1.7 + 7.1) * 0.3 + vnoise(q * 5.0) * 0.1;
  float t = mix(0.9, 0.7, uWet);
  float pud = smoothstep(t, t + 0.025, n);
  float rim = smoothstep(t - 0.05, t, n) * (1.0 - pud);               // darker soaked rim around each puddle
  vec3 V = normalize(vW - cameraPosition);
  vec2 jit = (vec2(vnoise(q * 9.0 + uTime * 2.3), vnoise(q * 9.0 - uTime * 2.1)) - 0.5) * 0.06 * uRain;
  vec3 R = reflect(V, normalize(vec3(jit.x, 1.0, jit.y)));
  vec3 sky = mix(hor, top, pow(smoothstep(-0.02, 0.7, R.y), 0.75));
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(-V.y, 0.0, 1.0), 5.0);
  // night: lit signs smear into thin warm streaks inside the puddles
  float streak = vnoise(vec2(q.x * 3.0, q.y * 0.35)) * vnoise(vec2(q.x * 0.5 + 3.0, q.y * 0.08));
  vec3 city = mix(vec3(1.0, 0.64, 0.32), vec3(1.0, 0.45, 0.4), vnoise(q * 0.1)) * smoothstep(0.35, 0.65, streak) * uNight * 0.35;
  vec3 dark = vec3(0.03, 0.033, 0.038);
  vec3 cP = mix(dark, sky, 0.22 + 0.7 * fres) + city;
  vec3 cS = mix(dark, sky, 0.08 + 0.5 * fres);
  float aS = uWet * (0.16 + 0.22 * fres + 0.2 * rim);
  float aP = uWet * 0.7;
  vec3 col = mix(cS, cP, pud);
  float a = mix(aS, aP, pud);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
${CHUNK_OUT}
#include <fog_fragment>
}`;

// ---------------------------------------------------------------- steam / smoke plumes (looping soft billboards)
const PLUME_VS = `
attribute vec4 aSrc; attribute vec4 aSeed; attribute float aStr; uniform float uTime; uniform vec2 uWind;
varying vec2 vUv; varying float vA; varying float vKind;
void main(){
  float smoke = aSrc.w; vKind = smoke;
  float life = fract(uTime * (smoke > 0.5 ? 0.22 : 0.32) * (0.8 + 0.4 * aSeed.w) + aSeed.z);
  float rise = smoke > 0.5 ? 3.0 : 3.6;
  vec3 p = aSrc.xyz + vec3(0.0, life * rise, 0.0);
  p.xz += uWind * pow(life, 1.4) * (smoke > 0.5 ? 2.2 : 1.4) + (aSeed.xy - 0.5) * 0.35 * (0.3 + life);
  p.x += sin(uTime * 1.3 + aSeed.x * 20.0 + life * 5.0) * 0.12 * life;
  float size = mix(0.35, smoke > 0.5 ? 1.9 : 1.7, sqrt(life));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = p + (right * position.x + up * position.y) * size;
  vA = aStr * smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.45, 1.0, life));
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const PLUME_FS = `uniform vec3 uSteam, uSmoke; uniform float uOpacity; varying vec2 vUv; varying float vA; varying float vKind;
void main(){ float r = dot(vUv, vUv); float a = exp(-r * 3.2) * vA * uOpacity * (vKind > 0.5 ? 0.6 : 0.5); if (a < 0.003) discard;
  gl_FragColor = vec4(vKind > 0.5 ? uSmoke : uSteam, a);
${CHUNK_OUT}
}`;

// ---------------------------------------------------------------- street-end haze (soft vertical veils for depth)
const HAZE_VS = `varying vec2 vUv; varying float vD; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vD = distance(w.xyz, cameraPosition); gl_Position = projectionMatrix * viewMatrix * w; }`;
const HAZE_FS = `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv; varying float vD;
void main(){ float a = uOpacity * pow(1.0 - vUv.y, 1.6) * smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x) * smoothstep(10.0, 30.0, vD);
  if (a < 0.003) discard; gl_FragColor = vec4(uColor, a);
${CHUNK_OUT}
}`;

// ---------------------------------------------------------------- golden-hour dust motes
const MOTE_VS = `attribute vec4 aSeed; uniform float uTime; uniform vec3 uFocus; varying float vA;
void main(){
  vec3 box = vec3(22.0, 6.0, 22.0);
  vec3 p = aSeed.xyz * box + vec3(sin(uTime * 0.21 + aSeed.w * 30.0), sin(uTime * 0.13 + aSeed.x * 40.0) * 0.4, cos(uTime * 0.17 + aSeed.y * 30.0)) * 0.6 + vec3(uTime * 0.12, 0.0, uTime * 0.05);
  p.xz = uFocus.xz + mod(p.xz - uFocus.xz, box.xz) - box.xz * 0.5; p.y = 0.4 + mod(p.y, box.y);
  vA = 0.5 + 0.5 * sin(uTime * (1.0 + aSeed.w * 2.0) + aSeed.z * 50.0);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(26.0 / -mv.z, 1.0, 4.0);
  gl_Position = projectionMatrix * mv;
}`;
const MOTE_FS = `uniform float uOpacity; varying float vA;
void main(){ vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.25, 0.0, dot(c, c)) * vA * uOpacity; if (a < 0.003) discard;
  gl_FragColor = vec4(1.0, 0.86, 0.6, a);
${CHUNK_OUT}
}`;

type Uni = Record<string, THREE.IUniform>;
const shader = (vs: string, fs: string, u: Uni, extra: THREE.ShaderMaterialParameters = {}) =>
  new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: u, transparent: true, depthWrite: false, ...extra });

function seeds(n: number, seed: number): THREE.InstancedBufferAttribute {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = hash(seed * 100003 + i);
  return new THREE.InstancedBufferAttribute(a, 4);
}
function quads(base: THREE.BufferGeometry, n: number, seed: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
  g.setAttribute('aSeed', seeds(n, seed)); g.instanceCount = n;
  return g;
}
const QUAD = new THREE.PlaneGeometry(1, 1); // centred, xy in -0.5..0.5
const STREAK = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0); // y 0..1
const live = (m: THREE.Object3D, order: number) => { m.frustumCulled = false; m.renderOrder = order; return m; };

const MAX_RAIN = 7000, MAX_RIP = 260, PUFFS = 18, MOTES = 260;

interface Vent { v: { def: SiteDef; site: RestaurantSite; group: THREE.Object3D }; key: string; i: number }

class Weather {
  current: WeatherKind = 'clear';
  rain = 0; overcast = 0; fog = 0; wetness = 0;
  private forced: WeatherKind | null = null;
  private scheduled: WeatherKind = 'clear';
  private t = 0;
  private wind = new THREE.Vector2(1.2, 0.5);
  private u = {
    time: { value: 0 }, focus: { value: new THREE.Vector3() }, wind: { value: new THREE.Vector2() },
    top: { value: new THREE.Color('#80aed8') }, hor: { value: new THREE.Color('#f1ede4') },
  };
  private rainMat!: THREE.ShaderMaterial; private rainGeo!: THREE.InstancedBufferGeometry;
  private ripMat!: THREE.ShaderMaterial; private ripGeo!: THREE.InstancedBufferGeometry;
  private wetMat!: THREE.ShaderMaterial;
  private plumeMat!: THREE.ShaderMaterial; private plumeStr!: THREE.InstancedBufferAttribute; private plumeSrc!: THREE.InstancedBufferAttribute;
  private hazeMat!: THREE.ShaderMaterial;
  private moteMat!: THREE.ShaderMaterial; private motes!: THREE.Points;
  private group: THREE.Group | null = null;
  private vents: Vent[] = [];
  private views: { def: SiteDef; site: RestaurantSite; group: THREE.Object3D }[] = [];
  private ventTimer = 0;
  private skyLinked = false;
  private ray = new THREE.Raycaster();

  get isRaining(): boolean { return this.rain > 0.12; }
  get lightFactor(): number { return 1 - 0.3 * this.overcast - 0.25 * this.rain - 0.1 * this.fog; }
  get fogDensity(): number { return this.fog; }

  setWeather(k: WeatherKind | null, instant = false): void {
    this.forced = k;
    if (instant) { const L = LOOK[k ?? this.scheduled]; this.rain = L.rain; this.overcast = L.overcast; this.fog = L.fog; this.wetness = L.rain > 0 ? 0.6 + 0.4 * L.rain : 0; }
  }

  /** Build this district's atmosphere into its scene group (disposed with it). */
  attach(parent: THREE.Group, id: DistrictId, views: { def: SiteDef; site: RestaurantSite; group: THREE.Object3D }[]): void {
    const g = this.group = new THREE.Group(); g.name = 'weather';
    this.views = views; this.skyLinked = false;
    const u = this.u;
    // rain
    this.rainMat = shader(RAIN_VS, RAIN_FS, { uTime: u.time, uWind: u.wind, uBox: { value: new THREE.Vector3(40, 26, 40) }, uLen: { value: 0.5 }, uWidth: { value: 0.016 }, uColor: { value: new THREE.Color('#e6edf5') }, uOpacity: { value: 0 } });
    this.rainGeo = quads(STREAK, MAX_RAIN, 11);
    g.add(live(new THREE.Mesh(this.rainGeo, this.rainMat), 20));
    // ripples
    this.ripMat = shader(RIP_VS, RIP_FS, { uTime: u.time, uFocus: u.focus, uRadius: { value: 16 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color('#eef3f8') } });
    this.ripGeo = quads(QUAD, MAX_RIP, 23);
    g.add(live(new THREE.Mesh(this.ripGeo, this.ripMat), 3));
    // wet streets
    const planes = (STREETS[id] ?? []).map(([x0, x1, z0, z1]) => new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0.032, (z0 + z1) / 2));
    this.wetMat = shader(WET_VS, WET_FS, { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uWet: { value: 0 }, uNight: { value: 0 }, uRain: { value: 0 }, uTime: u.time, top: u.top, hor: u.hor },
      { fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const p of planes) { const m = new THREE.Mesh(p, this.wetMat); m.renderOrder = 2; g.add(m); }
    // steam (restaurant roof vents, positioned lazily once their buildings exist) + yakitori smoke
    const grills = GRILLS[id] ?? [];
    this.vents = views.filter((v) => !v.site.id.endsWith('_stand')).map((v, i) => ({ v, key: '', i }));
    const emitters = this.vents.length + grills.length, n = emitters * PUFFS;
    const pg = quads(QUAD, Math.max(1, n), 37);
    this.plumeSrc = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 4), 4);
    this.plumeStr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
    grills.forEach(([x, y, z], j) => { for (let k = 0; k < PUFFS; k++) { const i = (this.vents.length + j) * PUFFS + k; this.plumeSrc.setXYZW(i, x, y, z, 1); this.plumeStr.setX(i, 1); } });
    pg.setAttribute('aSrc', this.plumeSrc); pg.setAttribute('aStr', this.plumeStr); pg.instanceCount = n;
    this.plumeMat = shader(PLUME_VS, PLUME_FS, { uTime: u.time, uWind: u.wind, uOpacity: { value: 1 }, uSteam: { value: new THREE.Color('#f4f1ec') }, uSmoke: { value: new THREE.Color('#a39a91') } });
    g.add(live(new THREE.Mesh(pg, this.plumeMat), 15));
    // street-end haze: veils at three depths at every street end
    this.hazeMat = shader(HAZE_VS, HAZE_FS, { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 } }, { side: THREE.DoubleSide, fog: false });
    const ends: [number, number, number][] = []; // x, z, yaw
    for (const d of [42, 60, 80]) { ends.push([d, 0, Math.PI / 2], [-d, 0, Math.PI / 2]); if (id !== 'asakusa') ends.push([0, d, 0], [0, -d, 0]); }
    for (const [x, z, yaw] of ends) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 22).translate(0, 11, 0), this.hazeMat);
      m.position.set(x, 0, z); m.rotation.y = yaw; m.renderOrder = 25; g.add(m);
    }
    // dust motes
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOTES * 3), 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(seeds(MOTES, 51).array, 4));
    this.moteMat = shader(MOTE_VS, MOTE_FS, { uTime: u.time, uFocus: u.focus, uOpacity: { value: 0 } }, { blending: THREE.AdditiveBlending });
    this.motes = live(new THREE.Points(mg, this.moteMat), 22) as THREE.Points;
    g.add(this.motes);
    parent.add(g);
  }

  update(dt: number, night: number, p: THREE.Vector3, s: GameState | null): void {
    if (!this.group) return;
    this.t += dt;
    const u = this.u;
    u.time.value = this.t % 3600; u.focus.value.copy(p);
    if (!this.skyLinked) this.linkSky();
    // schedule (day + evening mist curve), eased toward over ~15 s
    const h = s ? s.minute / 60 : 12;
    if (s) this.scheduled = weatherForDay(s.day);
    this.current = this.forced ?? this.scheduled;
    const L = LOOK[this.current];
    const mistCurve = this.current === 'mist' ? Math.max(THREE.MathUtils.smoothstep(h, 15.5, 18.5), 1 - THREE.MathUtils.smoothstep(h, 5.5, 8.5)) : 1;
    const k = Math.min(1, dt * 0.08);
    this.rain += (L.rain - this.rain) * k;
    this.overcast += (L.overcast - this.overcast) * k;
    this.fog += (L.fog * (0.35 + 0.65 * mistCurve) - this.fog) * k;
    this.wetness = THREE.MathUtils.clamp(this.wetness + (this.rain > 0.05 ? dt * 0.05 * (0.4 + this.rain) : -dt * 0.006), 0, Math.min(1, 0.55 + this.rain));
    const q = s?.settings.quality ?? 'high';
    const gust = 1 + 0.35 * Math.sin(this.t * 0.37) * Math.sin(this.t * 0.11);
    u.wind.value.copy(this.wind).multiplyScalar((0.4 + this.rain * 1.6) * gust);

    // rain: hidden indoors (roofs are lifted when the player is inside)
    const inside = this.views.some(({ site: { interior: r } }) => p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ);
    const amt = q === 'low' || inside ? 0 : this.rain;
    audio.setRain(this.rain);
    setMaterialWet(this.wetness);
    const cap = q === 'high' ? MAX_RAIN : MAX_RAIN / 2;
    this.rainGeo.instanceCount = Math.round(cap * Math.min(1, amt * 1.25));
    this.rainMat.uniforms.uOpacity.value = (0.26 + 0.22 * amt) * (1 - 0.4 * night);
    (this.rainMat.uniforms.uColor.value as THREE.Color).set(night > 0.5 ? '#b8c6dc' : '#e6edf5');
    this.ripGeo.instanceCount = q === 'low' ? 0 : Math.round((q === 'high' ? MAX_RIP : MAX_RIP / 2) * amt);
    this.ripMat.uniforms.uOpacity.value = 0.55 * (1 - 0.4 * night);
    this.wetMat.uniforms.uWet.value = this.wetness;
    this.wetMat.uniforms.uNight.value = night;
    this.wetMat.uniforms.uRain.value = this.rain;
    // steam and smoke read stronger in damp, cool air
    this.plumeMat.uniforms.uOpacity.value = 0.75 + 0.35 * this.overcast + 0.3 * this.rain - 0.2 * night;
    (this.plumeMat.uniforms.uSteam.value as THREE.Color).set(night > 0.5 ? '#c9c4c4' : '#f4f1ec');
    if ((this.ventTimer -= dt) <= 0) { this.ventTimer = 2; this.placeVents(s); }
    // haze tracks the fog colour
    const fogCol = (this.group.parent?.parent as THREE.Scene | null)?.fog?.color;
    if (fogCol) (this.hazeMat.uniforms.uColor.value as THREE.Color).copy(fogCol);
    this.hazeMat.uniforms.uOpacity.value = 0.1 + 0.12 * this.overcast + 0.38 * this.fog;
    // golden hour motes: clear-ish evenings and early mornings
    const golden = Math.max(THREE.MathUtils.smoothstep(h, 16.2, 17.2) * (1 - THREE.MathUtils.smoothstep(h, 18.2, 18.8)), THREE.MathUtils.smoothstep(h, 6.0, 6.6) * (1 - THREE.MathUtils.smoothstep(h, 7.4, 8.2)));
    const mo = q === 'low' ? 0 : golden * (1 - this.overcast) * (1 - this.rain) * 0.9;
    this.moteMat.uniforms.uOpacity.value = mo; this.motes.visible = mo > 0.01;
  }

  /** Puddles reflect the actual sky: share the dome's colour uniforms (sky.ts). Falls back to the defaults. */
  private linkSky(): void {
    const scene = this.group?.parent?.parent;
    if (!scene) return;
    this.skyLinked = true;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m?.uniforms?.top && m.uniforms.hor && m !== this.wetMat) { this.wetMat.uniforms.top = m.uniforms.top; this.wetMat.uniforms.hor = m.uniforms.hor; }
    });
  }

  /** Kitchen vents on the roofs of owned restaurants. Re-found only when a site's view is rebuilt. */
  private placeVents(s: GameState | null): void {
    let dirty = false;
    for (const vent of this.vents) {
      const { def, group } = vent.v;
      const owned = !!s?.restaurants[def.id];
      const key = `${owned}|${group.children.length}|${group.children[1]?.uuid ?? ''}`;
      if (key === vent.key) continue;
      vent.key = key; dirty = true;
      let y = -1;
      // back corner of the kitchen, away from the street (local +z faces the road)
      const lx = def.w * 0.28, lz = -def.d * 0.3, c = Math.cos(def.ry), sn = Math.sin(def.ry);
      const x = def.x + lx * c + lz * sn, z = def.z - lx * sn + lz * c;
      if (owned) {
        group.updateMatrixWorld(true);
        this.ray.set(new THREE.Vector3(x, 60, z), new THREE.Vector3(0, -1, 0));
        const hit = this.ray.intersectObject(group, true).find((i) => i.object.visible || i.object.parent?.visible);
        if (hit && hit.point.y > 2.2) y = hit.point.y + 0.25;
      }
      for (let k = 0; k < PUFFS; k++) { const i = vent.i * PUFFS + k; this.plumeSrc.setXYZW(i, x, y, z, 0); this.plumeStr.setX(i, y > 0 ? 1 : 0); }
    }
    if (dirty) { this.plumeSrc.needsUpdate = true; this.plumeStr.needsUpdate = true; }
  }
}

export const weather = new Weather();
if (typeof window !== 'undefined' && import.meta.env?.DEV) (window as any).weather = weather; // debug: weather.setWeather('heavyRain', true)
