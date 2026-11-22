// Sky: soft gradient dome, sun/moon, stars, day-night lighting keyframes, fog, rain and fireworks.
import * as THREE from 'three';
import { RADIAL } from './kit';
import { initMaterials, setMaterialNight } from './materials';
import { weather } from './weather';

interface Key { h: number; top: string; hor: string; sun: string; sunI: number; sky: string; gnd: string; hemiI: number; night: number }
// Studio-light palette for an architectural model: a warm key, a cool clean fill, pale hazy skies by day,
// a dark warm navy-charcoal by night with low ambient, so street lamps, lit windows and neon carry the scene (materials.ts).
const NIGHT = { top: '#0a0d18', hor: '#24232f', sun: '#bdb3c4', sunI: 0.38, sky: '#484a62', gnd: '#2f2824', hemiI: 1.35, night: 1 };
const KEYS: Key[] = [
  { h: 0, ...NIGHT },
  { h: 4.6, ...NIGHT },
  { h: 5.4, top: '#241f45', hor: '#7a6584', sun: '#c2adc8', sunI: 0.5, sky: '#6a5f80', gnd: '#332b31', hemiI: 0.95, night: 0.8 }, // dawn: violet-plum
  { h: 6.2, top: '#6c84b4', hor: '#f3c8a8', sun: '#ffb88a', sunI: 1.6, sky: '#e3cfc0', gnd: '#9c8a74', hemiI: 0.95, night: 0.3 },
  { h: 7.6, top: '#86b0d8', hor: '#efeae0', sun: '#fff0da', sunI: 2.7, sky: '#dfe3e8', gnd: '#d3c5aa', hemiI: 1.0, night: 0 },
  { h: 12, top: '#80aed8', hor: '#f1ede4', sun: '#fff3e0', sunI: 3.0, sky: '#e0e5ea', gnd: '#d6c8ac', hemiI: 1.05, night: 0 },
  { h: 16.3, top: '#86afd6', hor: '#f4eadb', sun: '#ffe6c2', sunI: 2.8, sky: '#e4e2e0', gnd: '#d4c3a3', hemiI: 1.0, night: 0 },
  { h: 17.5, top: '#8fa6cc', hor: '#fbd9ad', sun: '#ffc581', sunI: 2.5, sky: '#eadacb', gnd: '#b39878', hemiI: 0.95, night: 0 }, // golden hour
  { h: 18.35, top: '#5d6aa0', hor: '#f2ad84', sun: '#ff9a5c', sunI: 1.4, sky: '#c9b6b4', gnd: '#64545a', hemiI: 0.95, night: 0.35 },
  { h: 19.1, top: '#231f48', hor: '#6b5679', sun: '#b8a4c6', sunI: 0.5, sky: '#625a7e', gnd: '#2f2830', hemiI: 1.0, night: 0.85 }, // blue hour: violet-plum, a hint of blue
  { h: 20.5, ...NIGHT },
  { h: 24, ...NIGHT },
];

const DOME_VS = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const DOME_FS = `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vDir;
void main(){ float y = vDir.y;
 // long, soft falloff from a hazy horizon: a clean studio backdrop rather than a painted sky
 vec3 c = mix(hor, top, pow(smoothstep(-0.02, 0.7, y), 0.75)); c = mix(c, hor * 0.92, smoothstep(0.0, -0.25, y));
 float s = max(dot(normalize(vDir), sunDir), 0.0); c += sunCol * (pow(s, 6.0) * 0.12 + pow(s, 48.0) * 0.18);
 gl_FragColor = vec4(c, 1.0);
#include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

const SHADOW_EXT = 30; // half-size of the shadow box (m): ~34 texels/m at 2048
// fireworks: a curated hanabi palette (gold, vermilion, warm white, sakura, pale cyan) instead of random hues
const FW = ['#ffc65a', '#ff5a3c', '#fff1d6', '#ff8fb8', '#8fe3ff', '#ffd98a'].map((c) => new THREE.Color(c));

export class Sky {
  sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  hemi = new THREE.HemisphereLight('#cfe8ff', '#d4c3a0', 1.2);
  private dome: THREE.Mesh;
  private uni = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() } };
  private stars: THREE.Points;
  private sunDisc: THREE.Mesh;
  private moonDisc: THREE.Mesh;
  private fog = new THREE.Fog('#c6e6ff', 70, 230);
  private rain: THREE.LineSegments;
  private rainOn = 0; private rainTarget = 0;
  private fw: THREE.Points;
  private fwData: { p: Float32Array; v: Float32Array; c: Float32Array; base: Float32Array; life: Float32Array; kind: Uint8Array };
  private fwTimer = 0; private fwNext = 0;
  private center = new THREE.Vector3();
  private night = 0;
  private tmpB = new THREE.Color();

  constructor(private scene: THREE.Scene, _renderer: THREE.WebGLRenderer) {
    initMaterials(_renderer); // shared studio env for glass / metal (materials.ts)
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // tight box around the player (follows in update), soft penumbra: PCF kernel radius + a lifted shadow floor
    const c = this.sun.shadow.camera; c.left = -SHADOW_EXT; c.right = SHADOW_EXT; c.top = SHADOW_EXT; c.bottom = -SHADOW_EXT; c.near = 1; c.far = 160;
    this.sun.shadow.bias = -0.0003; this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
    this.sun.shadow.intensity = 0.9;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    scene.background = new THREE.Color('#c6e6ff');

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(320, 32, 16), new THREE.ShaderMaterial({ uniforms: this.uni, vertexShader: DOME_VS, fragmentShader: DOME_FS, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.dome.renderOrder = -10; this.dome.frustumCulled = false;
    scene.add(this.dome);

    const sp = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const v = new THREE.Vector3().randomDirection(); v.y = Math.abs(v.y) * 0.9 + 0.05; v.normalize().multiplyScalar(300);
      sp.set([v.x, v.y, v.z], i * 3);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.dome.add(this.stars);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(12, 32), new THREE.MeshBasicMaterial({ color: '#fff6d8', fog: false, transparent: true, toneMapped: false }));
    this.moonDisc = new THREE.Mesh(new THREE.CircleGeometry(8, 32), new THREE.MeshBasicMaterial({ color: '#f2ecdc', fog: false, transparent: true, toneMapped: false }));
    this.dome.add(this.sunDisc, this.moonDisc);

    // rain: streaks in a box around the player
    const N = 1800;
    const rp = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) { const x = (Math.random() - 0.5) * 50, y = Math.random() * 25, z = (Math.random() - 0.5) * 50; rp.set([x, y, z, x + 0.05, y + 0.7, z], i * 6); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#cfe3ff', transparent: true, opacity: 0, depthWrite: false }));
    this.rain.frustumCulled = false; rg.setDrawRange(0, 0); // always rendered → program compiled up front, no hitch when rain starts
    scene.add(this.rain);

    // fireworks particle pool
    const F = 5000;
    this.fwData = { p: new Float32Array(F * 3), v: new Float32Array(F * 3), c: new Float32Array(F * 3), base: new Float32Array(F * 3), life: new Float32Array(F), kind: new Uint8Array(F) };
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(this.fwData.p, 3));
    fg.setAttribute('color', new THREE.BufferAttribute(this.fwData.c, 3));
    this.fw = new THREE.Points(fg, new THREE.PointsMaterial({ size: 0.9, vertexColors: true, map: RADIAL, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false }));
    this.fw.frustumCulled = false; fg.setDrawRange(0, 0);
    scene.add(this.fw);
  }

  /** Returns night amount 0..1 and applies lighting for the time of day. */
  setTime(minute: number): number {
    const h = ((minute / 60) % 24 + 24) % 24;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = THREE.MathUtils.smoothstep(h, a.h, b.h);
    const mix = (x: string, y: string, out: THREE.Color) => out.set(x).lerp(this.tmpB.set(y), t);
    const rain = weather.overcast * 0.85; // greys the dome, hemi and horizon
    const grey = this.grey.set('#8d97a3');
    mix(a.top, b.top, this.uni.top.value).lerp(grey.clone().multiplyScalar(1 - 0.6 * this.night), rain * 0.7);
    mix(a.hor, b.hor, this.uni.hor.value).lerp(grey, rain * 0.6);
    mix(a.sun, b.sun, this.uni.sunCol.value);
    this.sun.color.copy(this.uni.sunCol.value);
    this.sun.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, t) * weather.lightFactor;
    this.sun.shadow.intensity = 0.9 * weather.lightFactor;
    mix(a.sky, b.sky, this.hemi.color);
    mix(a.gnd, b.gnd, this.hemi.groundColor);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemiI, b.hemiI, t) * (1 - rain * 0.2);
    this.night = THREE.MathUtils.lerp(a.night, b.night, t);
    setMaterialNight(this.night);
    // sun arc 6:00 → 18:30; moon opposite
    const ang = ((h - 6) / 12.5) * Math.PI;
    // peak elevation ~52 deg: raking studio light that models the facades, never a flat top-down noon
    const sunDir = new THREE.Vector3(-Math.cos(ang), Math.sin(ang) * 0.78, 0.6).normalize();
    this.uni.sunDir.value.copy(sunDir);
    this.sunDisc.position.copy(sunDir).multiplyScalar(290); this.sunDisc.lookAt(0, 0, 0);
    (this.sunDisc.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(sunDir.y * 6 + 0.3, 0, 1) * (1 - rain);
    const moonDir = new THREE.Vector3(Math.cos(ang) * 0.7, -Math.sin(ang) * 0.9 + 0.15, -0.5).normalize();
    this.moonDisc.position.copy(moonDir).multiplyScalar(285); this.moonDisc.lookAt(0, 0, 0);
    (this.moonDisc.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(moonDir.y * 5, 0, 1) * this.night * (1 - rain);
    // light direction: sun by day, moon by night (keep it fairly high so shadows stay readable)
    const L = this.night > 0.6 ? moonDir : sunDir;
    this.lightDir.set(L.x, Math.max(0.35, L.y), L.z).normalize();
    (this.stars.material as THREE.PointsMaterial).opacity = this.night * (1 - rain);
    this.fog.color.copy(this.uni.hor.value).lerp(this.uni.top.value, 0.25);
    this.fog.near = THREE.MathUtils.lerp(120, 14, weather.fogDensity); this.fog.far = THREE.MathUtils.lerp(380, 120, weather.fogDensity); // light aerial haze only: overviews stay crisp
    (this.scene.background as THREE.Color).copy(this.fog.color);
    return this.night;
  }
  private lightDir = new THREE.Vector3(0.3, 1, 0.4);
  private grey = new THREE.Color();

  setRain(on: boolean): void { this.rainTarget = on ? 1 : 0; }

  fireworks(seconds: number): void { this.fwTimer = Math.max(this.fwTimer, seconds); this.fw.geometry.setDrawRange(0, Infinity); }

  setQuality(q: 'low' | 'medium' | 'high'): void {
    const size = q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null as any;
    }
    this.sun.castShadow = q !== 'low';
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    this.center.copy(playerPos);
    this.dome.position.copy(playerPos);
    // shadow camera follows the player, snapped to texels to avoid shimmering
    const step = (2 * SHADOW_EXT) / this.sun.shadow.mapSize.x;
    const cx = Math.round(playerPos.x / step) * step, cz = Math.round(playerPos.z / step) * step;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx, 0, cz).addScaledVector(this.lightDir, 70);
    // rain
    this.rainOn += (this.rainTarget - this.rainOn) * Math.min(1, dt * 0.5);
    const raining = this.rainOn > 0.02;
    this.rain.geometry.setDrawRange(0, raining ? Infinity : 0);
    if (raining) {
      (this.rain.material as THREE.LineBasicMaterial).opacity = 0.55 * this.rainOn;
      this.rain.position.set(playerPos.x, 0, playerPos.z);
      const a = this.rain.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < a.length; i += 6) {
        a[i + 1] -= 24 * dt; a[i + 4] -= 24 * dt;
        if (a[i + 1] < 0) { a[i + 1] += 25; a[i + 4] += 25; }
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    this.updateFireworks(dt);
  }

  private fwIdle = true;
  private updateFireworks(dt: number): void {
    if (this.fwIdle && this.fwTimer <= 0) return; // nothing alive: skip the 5000-particle loop
    this.fwIdle = false;
    const d = this.fwData;
    if (this.fwTimer > 0) {
      this.fwTimer -= dt; this.fwNext -= dt;
      if (this.fwNext <= 0) { this.fwNext = 0.25 + Math.random() * 0.45; this.launch(); }
    }
    let alive = 0;
    for (let i = 0; i < d.life.length; i++) {
      if (d.life[i] <= 0) continue;
      alive++;
      d.life[i] -= dt;
      const k = i * 3;
      if (d.kind[i] === 1) {
        // rocket: explode when it runs out of fuel
        d.v[k + 1] -= 4 * dt;
        if (d.life[i] <= 0) this.burst(d.p[k], d.p[k + 1], d.p[k + 2]);
      } else {
        d.v[k] *= 1 - dt * 1.2; d.v[k + 2] *= 1 - dt * 1.2; d.v[k + 1] = d.v[k + 1] * (1 - dt * 1.2) - 5 * dt;
      }
      d.p[k] += d.v[k] * dt; d.p[k + 1] += d.v[k + 1] * dt; d.p[k + 2] += d.v[k + 2] * dt;
      const f = d.kind[i] === 1 ? 1 : Math.min(1, d.life[i] / 1.2) * (0.7 + Math.random() * 0.3);
      d.c[k] = d.base[k] * f; d.c[k + 1] = d.base[k + 1] * f; d.c[k + 2] = d.base[k + 2] * f;
      if (d.life[i] <= 0) { d.c[k] = d.c[k + 1] = d.c[k + 2] = 0; }
    }
    this.fw.geometry.attributes.position.needsUpdate = true;
    this.fw.geometry.attributes.color.needsUpdate = true;
    if (!alive && this.fwTimer <= 0) { this.fw.geometry.setDrawRange(0, 0); this.fwIdle = true; }
  }

  private alloc(): number { const L = this.fwData.life; for (let i = 0; i < L.length; i++) if (L[i] <= 0) return i; return -1; }

  private launch(): void {
    const i = this.alloc(); if (i < 0) return;
    const d = this.fwData, k = i * 3;
    const ang = Math.random() * Math.PI * 2, rad = 12 + Math.random() * 22;
    d.p.set([this.center.x + Math.cos(ang) * rad, 2, this.center.z + Math.sin(ang) * rad], k);
    d.v.set([(Math.random() - 0.5) * 3, 24 + Math.random() * 8, (Math.random() - 0.5) * 3], k);
    d.base.set([1, 0.85, 0.6], k);
    d.life[i] = 1.0 + Math.random() * 0.4; d.kind[i] = 1;
  }

  private burst(x: number, y: number, z: number): void {
    const d = this.fwData;
    const col = FW[Math.floor(Math.random() * FW.length)], col2 = FW[Math.floor(Math.random() * FW.length)];
    const n = 140 + Math.floor(Math.random() * 90), sp = 9 + Math.random() * 6;
    for (let j = 0; j < n; j++) {
      const i = this.alloc(); if (i < 0) return;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(sp * (0.85 + Math.random() * 0.15));
      const k = i * 3;
      d.p.set([x, y, z], k); d.v.set([v.x, v.y, v.z], k);
      const c = j % 3 === 0 ? col2 : col;
      d.base.set([c.r * 2, c.g * 2, c.b * 2], k);
      d.life[i] = 1.6 + Math.random() * 0.9; d.kind[i] = 0;
    }
  }
}
