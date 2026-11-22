// World juice: coin bursts, sparkles, confetti, puffs, steam. Everything pooled with fixed capacity:
// no per-frame allocation, nothing to leak. Driven by bus events; game.ts sets `focus` to the player.
import * as THREE from 'three';
import { on } from '../core/bus';

const VERT = /* glsl */ `
attribute float psize; attribute float palpha; attribute vec3 pcolor;
uniform float uScale; varying float vA; varying vec3 vC;
void main() {
  vA = palpha; vC = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = psize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FRAG = /* glsl */ `
varying float vA; varying vec3 vC;
void main() {
  vec2 p = gl_PointCoord - 0.5; float d = length(p);
  float core = smoothstep(0.5, 0.0, d);
  float star = max(0., 1. - abs(p.x) * 14.) * max(0., 1. - abs(p.y) * 2.2) + max(0., 1. - abs(p.y) * 14.) * max(0., 1. - abs(p.x) * 2.2);
  float a = (core * core + star) * vA;
  gl_FragColor = vec4(vC * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const SMOKE_FRAG = /* glsl */ `
varying float vA; varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Ring buffer of shader points: position, color, alpha, size, with simple physics. */
class PointPool {
  readonly points: THREE.Points;
  private pos: Float32Array; private vel: Float32Array; private col: Float32Array; private alpha: Float32Array; private size: Float32Array;
  private age: Float32Array; private life: Float32Array; private amax: Float32Array; private s0: Float32Array; private s1: Float32Array;
  private grav: Float32Array; private drag: Float32Array;
  private head = 0;
  private mat: THREE.ShaderMaterial;
  constructor(private cap: number, additive: boolean) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3); this.col = new Float32Array(cap * 3);
    this.alpha = new Float32Array(cap); this.size = new Float32Array(cap);
    this.age = new Float32Array(cap); this.life = new Float32Array(cap).fill(1); this.amax = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap); this.grav = new Float32Array(cap); this.drag = new Float32Array(cap);
    this.age.fill(99);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never frustum-culled
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: additive ? GLOW_FRAG : SMOKE_FRAG, uniforms: { uScale: { value: 400 } },
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: THREE.Color, size0: number, size1: number, life: number, alpha = 1, grav = 0, drag = 0): void {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    this.age[i] = 0; this.life[i] = life; this.amax[i] = alpha; this.s0[i] = size0; this.s1[i] = size1;
    this.grav[i] = grav; this.drag[i] = drag;
  }

  update(dt: number, scale: number): void {
    this.mat.uniforms.uScale.value = scale;
    for (let i = 0; i < this.cap; i++) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) { this.alpha[i] = 0; continue; }
      const k = a / this.life[i];
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= dr; this.vel[i * 3 + 2] *= dr;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dr - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = this.amax[i] * Math.min(1, k * 10) * Math.pow(1 - k, 1.4);
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
    }
    const at = this.points.geometry.attributes;
    at.position.needsUpdate = true; at.palpha.needsUpdate = true; at.psize.needsUpdate = true; at.pcolor.needsUpdate = true;
  }
}

/** Ring buffer of instanced meshes (coins / confetti) with tumbling physics. */
class MeshPool {
  readonly mesh: THREE.InstancedMesh;
  private pos: Float32Array; private vel: Float32Array; private rot: Float32Array; private spin: Float32Array;
  private age: Float32Array; private life: Float32Array; private sc: Float32Array; private flutter: Float32Array;
  private head = 0;
  private static m = new THREE.Matrix4(); private static q = new THREE.Quaternion(); private static e = new THREE.Euler();
  private static p = new THREE.Vector3(); private static s = new THREE.Vector3();
  constructor(private cap: number, geo: THREE.BufferGeometry, mat: THREE.Material, private bounce: boolean, private gravity: number, private airDrag: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.pos = new Float32Array(cap * 3); this.vel = new Float32Array(cap * 3); this.rot = new Float32Array(cap * 3); this.spin = new Float32Array(cap * 3);
    this.age = new Float32Array(cap).fill(99); this.life = new Float32Array(cap).fill(1); this.sc = new Float32Array(cap); this.flutter = new Float32Array(cap);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) this.mesh.setMatrixAt(i, zero);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, scale: number, color?: THREE.Color): void {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.rot.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
    this.spin.set([(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14], i * 3);
    this.age[i] = 0; this.life[i] = life; this.sc[i] = scale; this.flutter[i] = Math.random() * 6;
    if (color) this.mesh.setColorAt(i, color);
  }

  update(dt: number): void {
    const { m, q, e, p, s } = MeshPool;
    for (let i = 0; i < this.cap; i++) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        if (a - dt < this.life[i]) { m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, m); }
        continue;
      }
      const j = i * 3;
      const dr = Math.exp(-this.airDrag * dt);
      this.vel[j] *= dr; this.vel[j + 2] *= dr;
      this.vel[j + 1] = Math.max(-2.2 / Math.max(0.2, this.airDrag), this.vel[j + 1] * (this.airDrag > 1 ? dr : 1) - this.gravity * dt);
      if (this.airDrag > 1) { this.pos[j] += Math.sin(a * 5 + this.flutter[i]) * 0.6 * dt; } // paper sways
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.bounce && this.pos[j + 1] < 0.04 && this.vel[j + 1] < 0) {
        this.pos[j + 1] = 0.04; this.vel[j + 1] *= -0.38; this.vel[j] *= 0.6; this.vel[j + 2] *= 0.6;
        this.spin[j] *= 0.5; this.spin[j + 2] *= 0.5;
      }
      for (let k = 0; k < 3; k++) this.rot[j + k] += this.spin[j + k] * dt;
      const k = a / this.life[i];
      const sc = this.sc[i] * Math.min(1, k * 12) * (k > 0.8 ? (1 - k) / 0.2 : 1);
      m.compose(p.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]), q.setFromEuler(e.set(this.rot[j], this.rot[j + 1], this.rot[j + 2])), s.set(sc, sc, sc));
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// Palette matches world/materials.ts: paper whites, brand vermilion, muted gold, drafting teal, pale pastels.
const WHITE = new THREE.Color('#f4f3ef'), GREY = new THREE.Color('#b4b3b0'), DUST = new THREE.Color('#d2cec6');
const CONFETTI = ['#b82d25', '#f3f1ec', '#d9ae4f', '#3f97a3', '#a9c6dc', '#e4b9ae', '#a3b796'].map((c) => new THREE.Color(c));
const SPARK = ['#ffe2a6', '#fff7e8', '#a8ecf6'].map((c) => new THREE.Color(c));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export class Fx {
  /** World position effects without their own position (upgrades, milestones) center on. Set to the player each frame. */
  readonly focus = new THREE.Vector3();
  /** Optional resolver for where a customer left from (bus event has no position). */
  locate: ((restaurant: string, customerId: number | null) => THREE.Vector3 | null) | null = null;
  private glow = new PointPool(500, true);
  private smoke = new PointPool(260, false);
  private coins: MeshPool;
  private confetti: MeshPool;
  private group = new THREE.Group();
  private off: (() => void)[] = [];
  private shower = 0; // seconds of confetti shower left
  private showerAcc = 0;

  constructor(scene: THREE.Scene, private camera: THREE.Camera) {
    const coinGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.022, 18);
    coinGeo.rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({ color: '#e2b54c', metalness: 0.45, roughness: 0.32, emissive: '#7a5410', emissiveIntensity: 0.55 });
    this.coins = new MeshPool(120, coinGeo, coinMat, true, 11, 0.2);
    const confGeo = new THREE.PlaneGeometry(0.09, 0.055);
    const confMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.75 }); // lit paper, not flat stickers
    this.confetti = new MeshPool(360, confGeo, confMat, false, 3.2, 2.4);
    for (let i = 0; i < 360; i++) this.confetti.mesh.setColorAt(i, WHITE);
    this.group.add(this.glow.points, this.smoke.points, this.coins.mesh, this.confetti.mesh);
    scene.add(this.group);

    this.off.push(
      on('money', (e) => this.coinBurst(e.x ?? this.focus.x, e.y ?? this.focus.y + 1.8, e.z ?? this.focus.z, e.amount)),
      on('upgrade', () => this.sparkleRing(this.focus)),
      on('purchase', () => this.sparkleRing(this.focus)),
      on('milestone', () => { this.shower = 1.8; }),
      on('million', () => { this.shower = 6; }),
      on('customerLeft', (e) => { const p = this.locate?.(e.restaurant, e.customerId); if (p) this.puffAt(p.x, p.y, p.z, GREY, 10, 0.5); }),
    );
  }

  /** Arcing gold coins + sparkle. Bigger sales throw more coins. */
  coinBurst(x: number, y: number, z: number, amount = 100): void {
    const n = Math.min(14, 4 + Math.floor(Math.log10(Math.max(10, amount)) * 2));
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(0.8, 2);
      this.coins.spawn(x, y, z, Math.cos(a) * sp, rnd(3.2, 5.2), Math.sin(a) * sp, rnd(1.1, 1.5), rnd(0.8, 1.15));
    }
    for (let i = 0; i < 12; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(0.6, 2.2);
      this.glow.spawn(x, y, z, Math.cos(a) * sp, rnd(0.5, 2.5), Math.sin(a) * sp, pick(SPARK), rnd(0.2, 0.32), 0, rnd(0.4, 0.8), 1, 1.5, 2);
    }
  }

  /** Ring of rising sparkles + confetti puff (upgrades / purchases). */
  sparkleRing(c: THREE.Vector3): void {
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      this.glow.spawn(c.x + Math.cos(a) * 0.7, c.y + 0.2, c.z + Math.sin(a) * 0.7, Math.cos(a) * 0.6, rnd(1.5, 2.8), Math.sin(a) * 0.6, pick(SPARK), rnd(0.22, 0.34), 0.03, rnd(0.8, 1.3), 1, -0.3, 1.5);
    }
    for (let i = 0; i < 40; i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(1, 3);
      this.confetti.spawn(c.x, c.y + 1.9, c.z, Math.cos(a) * sp, rnd(2.5, 5), Math.sin(a) * sp, rnd(2, 3), rnd(0.8, 1.2), pick(CONFETTI));
    }
  }

  /** Dust ring at the feet (landing, sprint start). */
  puff(pos: THREE.Vector3): void {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rnd(0, 0.5);
      this.smoke.spawn(pos.x + Math.cos(a) * 0.15, pos.y + 0.06, pos.z + Math.sin(a) * 0.15, Math.cos(a) * 1.4, rnd(0.2, 0.5), Math.sin(a) * 1.4, DUST, 0.18, 0.5, rnd(0.45, 0.7), 0.55, 0, 4);
    }
  }

  /** A soft steam wisp. Call every ~0.3s per busy prep board. */
  steam(pos: THREE.Vector3): void {
    this.smoke.spawn(pos.x + rnd(-0.08, 0.08), pos.y, pos.z + rnd(-0.08, 0.08), rnd(-0.05, 0.05), rnd(0.35, 0.55), rnd(-0.05, 0.05), WHITE, 0.12, 0.6, rnd(1.4, 2), 0.28, -0.05, 0.6);
  }

  private puffAt(x: number, y: number, z: number, c: THREE.Color, n: number, alpha: number): void {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      this.smoke.spawn(x, y, z, Math.cos(a) * rnd(0.4, 1), rnd(0.2, 0.8), Math.sin(a) * rnd(0.4, 1), c, 0.25, 0.7, rnd(0.6, 0.9), alpha, 0, 2.5);
    }
  }

  update(dt: number): void {
    if (this.shower > 0) {
      this.shower -= dt;
      this.showerAcc += dt * 110;
      while (this.showerAcc >= 1) {
        this.showerAcc--;
        const a = rnd(0, Math.PI * 2), r = rnd(0.3, 4);
        this.confetti.spawn(this.focus.x + Math.cos(a) * r, this.focus.y + rnd(4, 6), this.focus.z + Math.sin(a) * r, rnd(-0.4, 0.4), rnd(-0.5, 0.5), rnd(-0.4, 0.4), rnd(3, 4.5), rnd(0.9, 1.3), pick(CONFETTI));
      }
    }
    const cam = this.camera as THREE.PerspectiveCamera;
    const scale = (innerHeight * Math.min(devicePixelRatio, 2)) / (2 * Math.tan(THREE.MathUtils.degToRad((cam.fov ?? 55) / 2)));
    this.glow.update(dt, scale);
    this.smoke.update(dt, scale);
    this.coins.update(dt);
    this.confetti.update(dt);
  }

  dispose(): void {
    for (const f of this.off) f();
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
  }
}
