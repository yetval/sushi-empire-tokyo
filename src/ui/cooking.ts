// Cooking minigame — a tactile little toy on a hinoki board. Knead rice in circles, pull the knife along
// the dotted line, drop the topping, roll the mat, chop on the marks, spoon the roe. Every step has a
// mouse gesture AND a keyboard alternative. A short result and streak count keep score without obscuring the board.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { audio, Sfx } from '../audio/audio';
import { toast } from '../core/bus';
import { INGREDIENTS, IngredientId, RECIPES, RecipeDef } from '../core/data';
import { canMake, PERFECT_SCORE, playerCookSpeed } from '../core/sim';
import { GameState, Ticket } from '../core/state';
import { makePlate, makeSushi } from '../world/sushi';
import { el, esc } from './dom';
import './prep-ticket.css';

const BY = 0.02; // cutting-board surface height
const RICE = '#fbf8f0', NORI = '#1e3326';
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const backOut = (k: number) => 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);

// ---------------------------------------------------------------- shared resources (built once)
let renderer: THREE.WebGLRenderer | null = null;
let shared: { scene: THREE.Scene; knife: THREE.Group; sheen: THREE.Mesh; bowlGeo: THREE.BufferGeometry } | null = null;
const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, o: { metalness?: number; roughness?: number; emissive?: string; transparent?: boolean; opacity?: number; side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
  const k = color + JSON.stringify(o);
  let m = mats.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o }); mats.set(k, m); }
  return m;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Hand-drawn wood grain: wavy growth lines, a few knots, plank seams. */
function woodTex(base: string, dark: string, planks: number): THREE.CanvasTexture {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = base; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 170; i++) {
      const y = Math.random() * 512, ph = Math.random() * 9;
      g.strokeStyle = dark; g.globalAlpha = 0.04 + Math.random() * 0.12; g.lineWidth = 0.5 + Math.random() * 2;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin(x * 0.011 + ph) * 5 + Math.sin(x * 0.037 + ph * 2) * 1.6);
      g.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      for (let r = 3; r < 16; r += 3) { g.globalAlpha = 0.18; g.beginPath(); g.ellipse(x, y, r * 2.2, r * 0.8, 0, 0, Math.PI * 2); g.stroke(); }
    }
    g.globalAlpha = 0.4; g.lineWidth = 2;
    for (let p = 1; p < planks; p++) { const y = (p * 512) / planks; g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
    g.globalAlpha = 1;
  });
}

const fishTexCache = new Map<string, THREE.CanvasTexture>();
/** Fish flesh with fat lines (salmon/toro), grill marks (eel) or stripes (shrimp). */
function fishTex(r: RecipeDef): THREE.CanvasTexture {
  let t = fishTexCache.get(r.id);
  if (t) return t;
  const top = new THREE.Color(r.topColor);
  const light = '#' + top.clone().lerp(new THREE.Color('#ffffff'), 0.55).getHexString();
  const dark = '#' + top.clone().multiplyScalar(0.7).getHexString();
  t = canvasTex(256, 128, (g) => {
    g.fillStyle = r.topColor; g.fillRect(0, 0, 256, 128);
    const grad = g.createLinearGradient(0, 0, 0, 128); grad.addColorStop(0, 'rgba(255,255,255,.18)'); grad.addColorStop(1, 'rgba(0,0,0,.12)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 128);
    if (r.id.includes('eel')) {
      g.strokeStyle = '#3a1f0c'; g.lineWidth = 6; g.globalAlpha = 0.5;
      for (let x = 10; x < 256; x += 36) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 30, 128); g.stroke(); }
    } else {
      const n = r.id.includes('toro') ? 16 : r.id.includes('salmon') ? 9 : 6;
      g.strokeStyle = r.id.includes('tuna') && !r.id.includes('toro') ? dark : light;
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * (256 / n) + rnd(-6, 6);
        g.lineWidth = r.id.includes('toro') ? rnd(2, 5) : rnd(3, 7); g.globalAlpha = rnd(0.55, 0.9);
        g.beginPath(); g.moveTo(x, -4); g.bezierCurveTo(x + 22, 40, x - 18, 90, x + 10, 132); g.stroke();
      }
    }
    g.globalAlpha = 1;
  });
  fishTexCache.set(r.id, t);
  return t;
}
const fishMats = new Map<string, THREE.MeshStandardMaterial>();
const fishMat = (r: RecipeDef) => {
  let m = fishMats.get(r.id);
  if (!m) { m = new THREE.MeshStandardMaterial({ map: fishTex(r), roughness: 0.32, metalness: 0.02 }); fishMats.set(r.id, m); }
  return m;
};

function buildKnife(): { knife: THREE.Group; sheen: THREE.Mesh } {
  const knife = new THREE.Group();
  const inner = new THREE.Group(); inner.position.x = -0.2; knife.add(inner); // origin = middle of the edge
  const sh = new THREE.Shape();
  sh.moveTo(0, 0); sh.lineTo(0.33, 0); sh.quadraticCurveTo(0.41, 0.002, 0.43, 0.03); sh.lineTo(0.02, 0.044); sh.quadraticCurveTo(0, 0.044, 0, 0.03); sh.lineTo(0, 0);
  const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.003, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 10 }), mat('#e6e9ee', { metalness: 1, roughness: 0.16 }));
  blade.position.z = -0.0015;
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12), mat('#1b1b1b', { roughness: 0.35 }));
  ferrule.rotation.z = Math.PI / 2; ferrule.position.set(-0.01, 0.025, 0);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.13, 8), mat('#d9c4a0', { roughness: 0.75 }));
  handle.rotation.z = Math.PI / 2; handle.position.set(-0.085, 0.025, 0);
  // the chef's hand gripping the handle (+ white coat cuff)
  const skin = mat('#f1c27d', { roughness: 0.55 });
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 12), skin);
  palm.scale.set(1.3, 0.8, 0.95); palm.position.set(-0.09, 0.05, 0.006);
  const fingerGeo = new THREE.CapsuleGeometry(0.0095, 0.022, 4, 8);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(fingerGeo, skin);
    f.position.set(-0.058 - i * 0.017, 0.022, 0.017); f.rotation.x = 1.25; inner.add(f);
  }
  const thumb = new THREE.Mesh(fingerGeo, skin); thumb.position.set(-0.045, 0.04, -0.008); thumb.rotation.z = 1.3; inner.add(thumb);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.07, 16), mat('#ffffff', { roughness: 0.8 }));
  cuff.rotation.z = Math.PI / 2 + 0.25; cuff.position.set(-0.16, 0.07, 0.006);
  const sheen = new THREE.Mesh(new THREE.PlaneGeometry(0.022, 0.05), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  sheen.position.set(0.1, 0.022, 0.0035); sheen.rotation.z = -0.35;
  inner.add(blade, ferrule, handle, palm, cuff, sheen);
  knife.traverse((o) => { o.castShadow = true; });
  sheen.castShadow = false;
  return { knife, sheen };
}

function getShared(rr: THREE.WebGLRenderer) {
  if (shared) return shared;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#24160e');
  const pm = new THREE.PMREMGenerator(rr);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.28;
  pm.dispose();
  scene.add(new THREE.HemisphereLight('#ffe9cc', '#4a2e1a', 0.35));
  const key = new THREE.DirectionalLight('#ffe2bd', 1.7); key.position.set(-0.7, 2.2, 1.1); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 1.2, bottom: -1.2, near: 0.1, far: 6 });
  key.shadow.bias = -0.0005; key.shadow.radius = 4;
  const rim = new THREE.DirectionalLight('#9fc6ff', 0.55); rim.position.set(1.4, 1, -1.5);
  scene.add(key, rim);
  // counter + board
  const counterTex = woodTex('#c79a6a', '#7a5233', 6); counterTex.wrapS = counterTex.wrapT = THREE.RepeatWrapping; counterTex.repeat.set(3, 2);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 4), new THREE.MeshStandardMaterial({ map: counterTex, roughness: 0.7 }));
  counter.position.y = -0.08; counter.receiveShadow = true;
  const board = new THREE.Mesh(new RoundedBoxGeometry(1.22, 0.05, 0.66, 3, 0.018), new THREE.MeshStandardMaterial({ map: woodTex('#efcf9f', '#c08f5c', 1), roughness: 0.6 }));
  board.position.y = BY - 0.025; board.receiveShadow = true; board.castShadow = true;
  scene.add(counter, board);
  // hand-placed details: soy dish, wasabi on a leaf, pickled ginger, chopsticks, folded towel
  const soy = new THREE.Group();
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.022, 24), mat('#f6f2ea', { roughness: 0.25 }));
  const sauce = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.004, 24), mat('#2a1206', { roughness: 0.05 }));
  sauce.position.y = 0.009; soy.add(dish, sauce); soy.position.set(-0.76, -0.02, 0.26);
  const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20), mat('#4c9a3a', { roughness: 0.5 }));
  leaf.scale.set(1.6, 0.7, 1); leaf.rotation.x = -Math.PI / 2; leaf.rotation.z = 0.5; leaf.position.set(-0.78, -0.028, -0.02);
  const wasabi = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 2), mat('#8cc63f', { roughness: 0.9 }));
  wasabi.scale.set(1, 0.6, 1.2); wasabi.position.set(-0.8, -0.012, -0.03);
  const gari = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.CircleGeometry(0.035, 14), mat('#f7b6b0', { roughness: 0.4, transparent: true, opacity: 0.92 }));
    s.rotation.set(-Math.PI / 2 + rnd(-0.4, 0.4), 0, rnd(0, 6)); s.position.set(rnd(-0.02, 0.02), 0.004 + i * 0.006, rnd(-0.02, 0.02)); gari.add(s);
  }
  gari.position.set(-0.72, -0.028, 0.06);
  const sticks = new THREE.Group();
  for (const dz of [-0.012, 0.012]) {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.36, 8), mat('#5a3420', { roughness: 0.5 }));
    st.rotation.z = Math.PI / 2; st.position.set(0, 0.015, dz); sticks.add(st);
  }
  const rest = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.03, 4, 8), mat('#d9e4ec', { roughness: 0.3 }));
  rest.rotation.x = Math.PI / 2; rest.position.set(0.1, 0.006, 0); sticks.add(rest);
  sticks.rotation.y = -0.5; sticks.position.set(0.82, -0.03, 0.22);
  const towel = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.04, 0.12, 2, 0.015), mat('#f1f4f7', { roughness: 0.95 }));
  towel.position.set(0.8, -0.01, -0.22); towel.rotation.y = 0.2;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.041, 0.012), mat('#3a6ea5', { roughness: 0.9 }));
  stripe.position.copy(towel.position); stripe.rotation.y = 0.2;
  for (const o of [soy, leaf, wasabi, gari, sticks, towel, stripe]) { o.traverse((m) => { m.castShadow = true; m.receiveShadow = true; }); scene.add(o); }
  const { knife, sheen } = buildKnife();
  scene.add(knife);
  const profile = [[0, 0], [0.042, 0], [0.052, 0.009], [0.082, 0.028], [0.098, 0.062],
    [0.094, 0.066], [0.089, 0.061], [0.072, 0.032], [0.045, 0.018], [0, 0.018]];
  const bowlGeo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 32);
  shared = { scene, knife, sheen, bowlGeo };
  return shared;
}

const flat = new Map<string, THREE.MeshBasicMaterial>();
const basic = (color: string) => { let m = flat.get(color); if (!m) { m = new THREE.MeshBasicMaterial({ color }); flat.set(color, m); } return m; };
let getaMat: THREE.MeshStandardMaterial | null = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The board currently owning the shared renderer canvas. A finished board must not tear down a newer one. */
let activeBoard: object | null = null;

// ---------------------------------------------------------------- board (per session)
interface Spring { base: THREE.Vector3; x: number; v: number }
interface Tween { t: number; d: number; f: (k: number) => void; done?: () => void }

class Board {
  scene: THREE.Scene; cam = new THREE.PerspectiveCamera(36, 2.2, 0.05, 20);
  work = new THREE.Group();
  canvas: HTMLCanvasElement;
  knife: THREE.Group; private sheen: THREE.Mesh;
  knifeTarget = new THREE.Vector3(0.5, BY + 0.004, 0.27);
  knifeYaw = 0; knifeTilt = 0.1; knifeHold = 0; knifeHoldTarget = 0; knifeDip = 0; glint = 0;
  camPos = new THREE.Vector3(0, 0.8, 0.8); camLook = new THREE.Vector3(0, 0, -0.03);
  onFrame: ((dt: number) => void) | null = null;
  spin: THREE.Object3D[] = [];
  private springs = new Map<THREE.Object3D, Spring>();
  private tweens: Tween[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private shakeA = 0; private sheenT = -1;
  private raf = 0; private last = performance.now(); private t = 0;
  private rc = new THREE.Raycaster(); private ndc = new THREE.Vector2(); private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private qRest = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0.55));
  private qHold = new THREE.Quaternion(); private eHold = new THREE.Euler(0, 0, 0, "YXZ");
  private look = new THREE.Vector3();
  private insts = new Set<THREE.InstancedMesh>();
  /** prefers-reduced-motion: no shake, spin, squash or pop; camera snaps instead of pushing in. */
  readonly calm = reducedMotion();

  constructor(private host: HTMLElement) {
    // hand-over: tear down the previous board NOW (its raf, objects and camera), not after its delayed dispose
    (activeBoard as Board | null)?.dispose();
    activeBoard = this;
    // every InstancedMesh that enters the work group gets its GPU buffers freed on dispose (even if removed earlier)
    this.work.addEventListener('childadded', (e: any) => e.child.traverse((o: THREE.Object3D) => { if ((o as THREE.InstancedMesh).isInstancedMesh) this.insts.add(o as THREE.InstancedMesh); }));
    renderer ??= new THREE.WebGLRenderer({ antialias: true });
    const rr = renderer;
    rr.setPixelRatio(Math.min(devicePixelRatio, 2));
    rr.outputColorSpace = THREE.SRGBColorSpace; rr.toneMapping = THREE.ACESFilmicToneMapping; rr.toneMappingExposure = 0.92;
    rr.shadowMap.enabled = true; rr.shadowMap.type = THREE.PCFShadowMap;
    const sh = getShared(rr);
    this.scene = sh.scene; this.knife = sh.knife; this.sheen = sh.sheen;
    this.scene.add(this.work);
    this.canvas = rr.domElement;
    host.prepend(this.canvas);
    this.knife.position.copy(this.knifeTarget); this.knife.quaternion.copy(this.qRest);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
      this.step(dt);
      const dpr = Math.min(devicePixelRatio, 2);
      if (rr.getPixelRatio() !== dpr) rr.setPixelRatio(dpr); // moved to another monitor / zoomed
      const w = host.clientWidth, h = host.clientHeight;
      if (w && h && (rr.domElement.width !== Math.floor(w * rr.getPixelRatio()) || rr.domElement.height !== Math.floor(h * rr.getPixelRatio()))) {
        rr.setSize(w, h); this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      }
      rr.render(this.scene, this.cam);
    };
    loop();
  }

  private step(dt: number): void {
    // tweens
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i]; tw.t += dt;
      const k = Math.min(1, tw.t / tw.d); tw.f(k);
      if (k >= 1) { this.tweens.splice(i, 1); tw.done?.(); }
    }
    // squash & stretch springs (volume-preserving-ish)
    for (const [o, s] of this.springs) {
      s.v += (-340 * s.x - 13 * s.v) * dt; s.x += s.v * dt;
      o.scale.set(s.base.x * (1 + s.x * 0.6), s.base.y * (1 - s.x), s.base.z * (1 + s.x * 0.6));
      if (Math.abs(s.x) < 0.001 && Math.abs(s.v) < 0.01) { o.scale.copy(s.base); this.springs.delete(o); }
    }
    if (!this.calm) for (const o of this.spin) o.rotation.y += dt * 0.6;
    this.onFrame?.(dt);
    // knife: eased follow, blend between resting flat and held upright
    const kf = 1 - Math.exp(-dt * 22);
    this.knifeHold += (this.knifeHoldTarget - this.knifeHold) * (1 - Math.exp(-dt * 12));
    this.knife.position.lerp(this.knifeTarget, kf);
    this.knife.position.y += this.knifeDip;
    this.eHold.set(this.knifeTilt, this.knifeYaw, 0); this.qHold.setFromEuler(this.eHold);
    this.knife.quaternion.slerpQuaternions(this.qRest, this.qHold, easeInOut(clamp(this.knifeHold, 0, 1)));
    // blade glint (periodic pulse = keyboard timing cue) + sweep sheen after a cut
    const sm = this.sheen.material as THREE.MeshBasicMaterial;
    if (this.sheenT >= 0) {
      this.sheenT += dt * 2.6;
      this.sheen.position.x = 0.02 + this.sheenT * 0.4; sm.opacity = Math.sin(Math.min(1, this.sheenT) * Math.PI) * 0.9;
      if (this.sheenT >= 1) this.sheenT = -1;
    } else { this.sheen.position.x = 0.24; sm.opacity = this.glint * 0.85; }
    // camera (+ shake on the canvas)
    this.cam.position.copy(this.camPos);
    this.look.copy(this.camLook); this.cam.lookAt(this.look);
    this.shakeA *= Math.exp(-dt * 9);
    const sx = (Math.random() - 0.5) * this.shakeA, sy = (Math.random() - 0.5) * this.shakeA;
    this.canvas.style.transform = this.shakeA > 0.3 ? `translate(${sx}px,${sy}px)` : '';
  }

  /** Track a geometry to dispose with the session. */
  g<T extends THREE.BufferGeometry>(geo: T): T { this.geos.push(geo); return geo; }
  mesh(geo: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
    const o = new THREE.Mesh(this.g(geo), m); o.castShadow = true; o.receiveShadow = true; return o;
  }
  add<T extends THREE.Object3D>(o: T, pop = true, delay = 0): T {
    o.traverse((m) => { if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    this.work.add(o);
    if (pop && !this.calm) {
      const s = o.scale.clone(); o.scale.setScalar(0.0001);
      this.tween(0.32, (k) => o.scale.copy(s).multiplyScalar(Math.max(0.0001, backOut(k))), undefined, delay);
    }
    return o;
  }
  remove(o: THREE.Object3D, anim = true): void {
    this.springs.delete(o);
    if (!anim) { o.removeFromParent(); return; }
    const s = o.scale.clone();
    this.tween(0.18, (k) => o.scale.copy(s).multiplyScalar(Math.max(0.0001, 1 - k)), () => o.removeFromParent());
  }
  tween(d: number, f: (k: number) => void, done?: () => void, delay = 0): void {
    if (delay > 0) { this.tweens.push({ t: 0, d: delay, f: () => {}, done: () => this.tween(d, f, done) }); return; }
    this.tweens.push({ t: 0, d, f, done });
  }
  /** Squash (amt > 0) or stretch (amt < 0) with springy recovery. */
  squash(o: THREE.Object3D, amt = 0.35): void {
    if (this.calm) return;
    const s = this.springs.get(o);
    if (s) s.x += amt; else this.springs.set(o, { base: o.scale.clone(), x: amt, v: 0 });
  }
  shake(px: number): void { if (!this.calm) this.shakeA = Math.max(this.shakeA, px); }
  sheenSweep(): void { this.sheenT = 0; }

  /** Pointer → point on a horizontal plane at height y. */
  toBoard(cx: number, cy: number, y: number, out: THREE.Vector3): boolean {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.rc.setFromCamera(this.ndc, this.cam);
    this.plane.constant = -y;
    return this.rc.ray.intersectPlane(this.plane, out) !== null;
  }
  pick(cx: number, cy: number, objs: THREE.Object3D[]): number {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.rc.setFromCamera(this.ndc, this.cam);
    const hit = this.rc.intersectObjects(objs, true)[0];
    if (!hit) return -1;
    return objs.findIndex((o) => { let p: THREE.Object3D | null = hit.object; while (p) { if (p === o) return true; p = p.parent; } return false; });
  }
  /** World → pixel position inside the host element. */
  project(v: THREE.Vector3): { x: number; y: number } {
    const p = v.clone().project(this.cam);
    return { x: ((p.x + 1) / 2) * this.host.clientWidth, y: ((1 - p.y) / 2) * this.host.clientHeight };
  }
  clear(): void {
    for (const o of [...this.work.children]) this.remove(o, false);
    this.spin = [];
  }
  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const m of this.insts) m.dispose();
    this.insts.clear();
    this.work.clear(); this.work.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.geos = [];
    this.springs.clear(); this.tweens = []; this.onFrame = null;
    // the canvas, knife and sheen are shared: only reset them if no newer board has taken over
    if (activeBoard === this) {
      activeBoard = null;
      this.canvas.style.transform = '';
      if (this.canvas.parentElement === this.host) this.canvas.remove();
      (this.sheen.material as THREE.MeshBasicMaterial).opacity = 0;
    }
  }
}

// ---------------------------------------------------------------- session context
interface Ctx {
  b: Board; ui: HTMLElement; view: HTMLElement; ease: number; pace: number; n: number; r: RecipeDef;
  cleanups: (() => void)[];
  cancelled: boolean;
  combo: number; bestCombo: number;
  result(s: number, label?: string): void;
  stamp(text: string, cls: string): void;
  hint(html: string | null): void;
  on(t: EventTarget, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void;
  keys(down: (e: KeyboardEvent) => void, up?: (e: KeyboardEvent) => void): void;
  timeout(sec: number, fn: () => void): () => void;
}

function grade(s: number): [string, Sfx, string, number] {
  if (s > PERFECT_SCORE) return ['Excellent', 'perfect', 'perfect', 14];
  if (s >= 0.72) return ['Very good', 'success', 'great', 7];
  if (s >= 0.45) return ['Good', 'pop', 'good', 2];
  return ['Off the mark', 'fail', 'miss', 0];
}

const isKey = (e: KeyboardEvent, ...codes: string[]) => codes.includes(e.code);
const TAG_LIFT = new THREE.Vector3(0, 0.1, 0);
const fitBox = new THREE.Box3(), fitSize = new THREE.Vector3();
/** A sushi piece scaled so its longest horizontal side is `width` (robust to model changes in world/sushi.ts). */
function fitSushi(id: string, width: number): THREE.Mesh {
  const p = makeSushi(id);
  fitBox.setFromObject(p).getSize(fitSize);
  p.scale.multiplyScalar(width / Math.max(0.01, fitSize.x, fitSize.z));
  return p;
}
const v3 = () => new THREE.Vector3();

// ---------------------------------------------------------------- steps
/** Knead: hold the mouse and circle it (or press W/D/S/A around the clock, or tap SPACE). */
function knead(ctx: Ctx, objs: THREE.Object3D[], turns: number, title: string, onProgress: (f: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    ctx.ui.innerHTML = `<div class="cook-instr">${title}</div><div class="ck-meter"><i></i></div>`;
    const fill = ctx.ui.querySelector<HTMLElement>('.ck-meter > i')!;
    ctx.hint('Hold and circle the rice, or tap <kbd>Space</kbd>.');
    const centerW = new THREE.Vector3(0, BY + 0.05, 0.05);
    let acc = 0, lastA: number | null = null, down = false, done = false, nextQuarter = 0.25;
    const t0 = performance.now();
    const ideal = (1.15 * turns) / ctx.pace;
    const advance = (rad: number) => {
      if (done) return;
      acc += rad;
      const f = clamp(acc / (turns * Math.PI * 2), 0, 1);
      fill.style.width = `${f * 100}%`;
      onProgress(f);
      if (f >= nextQuarter) { nextQuarter += 0.25 / turns; for (const o of objs) b.squash(o, 0.28); audio.sfx('pop', 0.35); }
      if (f >= 1) finish();
    };
    const finish = () => {
      done = true; stop(); ctx.hint(null);
      const t = (performance.now() - t0) / 1000;
      const s = clamp(1.12 - Math.max(0, t / ideal - 1) * 0.38, 0.4, 1); // idle timeout lands at the 0.4 floor
      ctx.result(s); resolve(s);
    };
    ctx.on(b.canvas, 'pointerdown', (e: PointerEvent) => { down = true; lastA = null; b.canvas.setPointerCapture(e.pointerId); b.canvas.style.cursor = 'grabbing'; });
    ctx.on(b.canvas, 'pointerup', () => { down = false; b.canvas.style.cursor = ''; });
    ctx.on(b.canvas, 'pointermove', (e: PointerEvent) => {
      if (!down) return;
      const r = b.canvas.getBoundingClientRect();
      const center = b.project(centerW); // per move: stays right after a resize
      const a = Math.atan2(e.clientY - r.top - center.y, e.clientX - r.left - center.x);
      if (lastA !== null) { let d = a - lastA; d = Math.atan2(Math.sin(d), Math.cos(d)); if (Math.abs(d) < 1.2) advance(Math.abs(d)); }
      lastA = a;
    });
    const ring = ['KeyW', 'KeyD', 'KeyS', 'KeyA'], arrows = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'];
    let lastIdx = -1;
    ctx.keys((e) => {
      const i = Math.max(ring.indexOf(e.code), arrows.indexOf(e.code));
      if (i >= 0) {
        if (lastIdx < 0 || i === (lastIdx + 1) % 4 || i === (lastIdx + 3) % 4) advance(Math.PI / 2);
        lastIdx = i;
      } else if (isKey(e, 'Space', 'Enter')) advance(Math.PI / 3.2);
    });
    const stop = ctx.timeout(10 / Math.sqrt(ctx.pace), () => advance(99));
  });
}

/** Pull the knife along the dotted line (or press SPACE when the blade gleams). */
function slice(ctx: Ctx, fish: THREE.Mesh, cuts: number, onCut: (i: number, x: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    let i = 0, total = 0;
    ctx.ui.innerHTML = `<div class="cook-instr">Slice the fish</div><div class="ck-chips">${Array.from({ length: cuts }, (_, k) => `<span>cut ${k + 1}</span>`).join('')}</div>`;
    ctx.hint('Follow the dotted line, or press <kbd>Space</kbd> when the blade glints.');
    b.knifeHoldTarget = 1; b.knifeTilt = 0.8; // sogi-giri: blade angled so its face catches the light
    const topY = BY + 0.065;
    const dots: THREE.Mesh[] = [];
    const dotGeo = b.g(new THREE.CylinderGeometry(0.0065, 0.0065, 0.004, 12));
    const dotMat = basic('#2b2440');
    const startMat = basic('#ffd23f');
    const A = v3(), B = v3(), P = v3(), D = v3();
    let samples: { t: number; dev: number }[] = [];
    let dragging = false, busy = false, timedOut = false;
    const glintP = 1.05 / ctx.pace;
    let gt = 0;
    const layout = () => {
      for (const d of dots) d.removeFromParent();
      dots.length = 0;
      const x = 0.14 - i * 0.09;
      A.set(x + 0.025, topY, 0.11); B.set(x - 0.025, topY, 0.29);
      D.copy(B).sub(A);
      for (let k = 0; k <= 14; k++) {
        const d = new THREE.Mesh(dotGeo, k === 0 ? startMat : dotMat);
        d.position.copy(A).lerp(B, k / 14); d.position.y += 0.002;
        if (k === 0) d.scale.setScalar(2.2);
        b.work.add(d); dots.push(d);
      }
      b.knifeYaw = Math.atan2(-D.z, D.x);
      b.knifeTarget.set(A.x, topY + 0.05, A.z);
    };
    const chips = () => ctx.ui.querySelectorAll('.ck-chips span').forEach((s, k) => { s.className = k < i ? 'done' : k === i ? 'next' : ''; });
    layout(); chips();
    const doCut = (s: number) => {
      busy = true;
      total += s;
      audio.sfx('chop'); b.sheenSweep();
      b.knifeTarget.copy(B); b.knifeTarget.y = BY + 0.002;
      b.squash(fish, 0.3);
      onCut(i, (A.x + B.x) / 2);
      ctx.result(s);
      i++; chips();
      setTimeout(() => {
        busy = false;
        if (i >= cuts) { for (const d of dots) d.removeFromParent(); stop(); ctx.hint(null); b.knifeHoldTarget = 0; b.knifeTilt = 0.1; b.knifeTarget.set(0.5, BY + 0.004, 0.27); b.onFrame = null; resolve(total / cuts); }
        else { layout(); if (timedOut) doCut(0.35); } // idle player: keep auto-cutting until done
      }, 380);
    };
    const sample = (cx: number, cy: number) => {
      if (!b.toBoard(cx, cy, topY, P)) return;
      const t = ((P.x - A.x) * D.x + (P.z - A.z) * D.z) / (D.x * D.x + D.z * D.z);
      const cxp = A.x + D.x * t, czp = A.z + D.z * t;
      const dev = Math.hypot(P.x - cxp, P.z - czp);
      b.knifeTarget.set(P.x, BY + 0.01 + (dragging ? 0 : 0.05), P.z);
      if (dragging && t > -0.15 && t < 1.15) samples.push({ t, dev });
      if (dragging && t >= 1) release();
    };
    const release = () => {
      if (!dragging) return;
      dragging = false; b.canvas.style.cursor = '';
      if (busy) return;
      const ts = samples.map((s) => s.t);
      const cover = ts.length ? Math.min(1, Math.max(...ts)) - Math.max(0, Math.min(...ts)) : 0;
      if (cover < 0.65) { if (samples.length > 3) ctx.stamp('Finish the stroke', 'info'); samples = []; return; }
      const avg = samples.reduce((a, s) => a + s.dev, 0) / samples.length;
      doCut(avg <= 0.008 ? 1 : avg <= 0.03 ? 1 - ((avg - 0.008) / 0.022) * 0.42 : Math.max(0.35, 0.58 - (avg - 0.03) * 6));
      samples = [];
    };
    ctx.on(b.canvas, 'pointerdown', (e: PointerEvent) => { if (busy) return; dragging = true; samples = []; b.canvas.setPointerCapture(e.pointerId); b.canvas.style.cursor = 'grabbing'; sample(e.clientX, e.clientY); });
    ctx.on(b.canvas, 'pointermove', (e: PointerEvent) => { if (!busy) sample(e.clientX, e.clientY); });
    ctx.on(b.canvas, 'pointerup', release);
    b.onFrame = (dt) => { gt += dt; const ph = (gt % glintP) / glintP; b.glint = Math.pow(Math.max(0, 1 - Math.abs(ph - 0.5) * 4), 2); };
    ctx.keys((e) => {
      if (!isKey(e, 'Space', 'Enter', 'KeyE') || busy) return;
      const ph = (gt % glintP) / glintP;
      doCut(clamp(1.05 - Math.abs(ph - 0.5) * 2 * 1.3, 0.35, 1));
    });
    const stop = ctx.timeout(9 * cuts / Math.sqrt(ctx.pace), () => { timedOut = true; if (!busy && i < cuts) doCut(0.35); });
  });
}

/** Drag an object onto a glowing target (or SPACE to drop it while it swings). */
function dragTo(ctx: Ctx, obj: THREE.Object3D, target: THREE.Vector3, swingX: [number, number], title: string, landY: number): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    ctx.ui.innerHTML = `<div class="cook-instr">${title}</div>`;
    ctx.hint('Drag to the ring, or press <kbd>Space</kbd> to drop.');
    const ring = b.mesh(new THREE.TorusGeometry(0.06, 0.006, 8, 36), basic('#ffd23f'));
    ring.rotation.x = Math.PI / 2; ring.position.copy(target); ring.position.y += 0.004;
    b.work.add(ring);
    const P = v3(), hoverY = landY + 0.11;
    let held = false, done = false, kt = 0, auto = true;
    const home = obj.position.clone();
    b.onFrame = (dt) => {
      kt += dt;
      ring.scale.setScalar(1 + Math.sin(kt * 7) * 0.12);
      if (auto && !held && !done) { // keyboard mode: piece swings across the row
        const x = swingX[0] + (swingX[1] - swingX[0]) * (0.5 + 0.5 * Math.sin(kt * 2.2 * ctx.pace));
        obj.position.lerp(P.set(x, hoverY, target.z), 1 - Math.exp(-dt * 10));
        obj.rotation.z = Math.sin(kt * 6) * 0.08;
      }
    };
    const drop = () => {
      if (done) return;
      done = true; held = false; stop(); ctx.hint(null); b.canvas.style.cursor = '';
      const d = Math.hypot(obj.position.x - target.x, obj.position.z - target.z);
      const s = d < 0.012 ? 1 : d < 0.06 ? 1 - ((d - 0.012) / 0.048) * 0.42 : Math.max(0.35, 0.56 - (d - 0.06) * 3);
      const from = obj.position.clone(), rot = obj.rotation.z;
      const to = d < 0.09 ? new THREE.Vector3(target.x, landY, target.z) : new THREE.Vector3(obj.position.x, landY - 0.03, obj.position.z);
      b.tween(0.16, (k) => { obj.position.lerpVectors(from, to, k * k); obj.rotation.z = rot * (1 - k); }, () => {
        b.squash(obj, 0.45); audio.sfx('pop'); b.onFrame = null; b.remove(ring);
        ctx.result(s); setTimeout(() => resolve(s), 260);
      });
    };
    ctx.on(b.canvas, 'pointerdown', (e: PointerEvent) => { if (done) return; held = true; auto = false; b.canvas.setPointerCapture(e.pointerId); b.canvas.style.cursor = 'grabbing'; b.squash(obj, -0.3); audio.sfx('click', 0.5); });
    ctx.on(b.canvas, 'pointermove', (e: PointerEvent) => {
      if (!held || !b.toBoard(e.clientX, e.clientY, hoverY, P)) return;
      obj.position.set(clamp(P.x, -0.58, 0.58), hoverY, clamp(P.z, -0.3, 0.32));
    });
    ctx.on(b.canvas, 'pointerup', () => { if (held) drop(); });
    ctx.keys((e) => { if (isKey(e, 'Space', 'Enter', 'KeyE')) { auto = true; drop(); } });
    const stop = ctx.timeout(9 / Math.sqrt(ctx.pace), () => { obj.position.copy(home); drop(); });
  });
}

/** Pick ingredients from the bowls in order: click a bowl or press its number. memory=true hides the order. */
function pickOrder(ctx: Ctx, title: string, bowls: THREE.Object3D[], labels: string[], order: number[], memory: number, onPick: (k: number, bowlIdx: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    let step = 0, mistakes = 0, ready = memory === 0;
    const t0 = performance.now();
    const chips = (hide: boolean) => order.map((bi, k) => `<span class="${k < step ? 'done' : k === step && !hide ? 'next' : ''}">${hide && k >= step ? '?' : esc(labels[bi])}</span>`).join('<span style="border:0;background:none">→</span>');
    ctx.ui.innerHTML = `<div class="cook-instr">${title}</div><div class="ck-chips"></div>`;
    const chipEl = ctx.ui.querySelector<HTMLElement>('.ck-chips')!;
    chipEl.innerHTML = chips(false);
    // number tags over bowls
    const tags = bowls.map((_, k) => { const tg = el('div', 'ck-tag', `<kbd>${k + 1}</kbd>${esc(labels[k])}`); ctx.view.append(tg); return tg; });
    const tagW = v3();
    const placeTags = () => bowls.forEach((bw, k) => {
      const p = b.project(bw.getWorldPosition(tagW).add(TAG_LIFT));
      tags[k].style.left = `${p.x}px`; tags[k].style.top = `${p.y}px`;
    });
    placeTags();
    b.onFrame = placeTags; // follow bowls through pop-in and resizes
    ctx.cleanups.push(() => { tags.forEach((t) => t.remove()); if (b.onFrame === placeTags) b.onFrame = null; });
    ctx.hint('Select bowls in order with the mouse or <kbd>1</kbd>–<kbd>' + bowls.length + '</kbd>');
    if (memory) {
      tags.forEach((t) => { t.style.opacity = '.35'; });
      const tm = setTimeout(() => { ready = true; tags.forEach((t) => { t.style.opacity = '1'; }); chipEl.innerHTML = chips(true); ctx.stamp('Arrange the pieces', 'info'); }, memory * 1000);
      ctx.cleanups.push(() => clearTimeout(tm));
    }
    const choose = (bi: number) => {
      if (!ready || bi < 0 || step >= order.length) return;
      const bowl = bowls[bi];
      if (bi === order[step]) {
        audio.sfx('pop'); b.squash(bowl, 0.3);
        onPick(step, bi); step++;
        chipEl.innerHTML = chips(memory > 0);
        if (step >= order.length) {
          stop(); ctx.hint(null);
          const per = (performance.now() - t0 - memory * 1000) / 1000 / order.length;
          const speedF = per < 1.1 / ctx.pace ? 1 : Math.max(0.78, 1 - (per - 1.1 / ctx.pace) * 0.1);
          const s = Math.max(0.35, 1 - 0.2 * mistakes) * speedF;
          ctx.result(s); setTimeout(() => resolve(s), 300);
        }
      } else {
        mistakes++; audio.sfx('error'); b.squash(bowl, -0.35); b.shake(5);
        ctx.stamp('Check the order', 'miss');
      }
    };
    ctx.on(b.canvas, 'pointerdown', (e: PointerEvent) => choose(b.pick(e.clientX, e.clientY, bowls)));
    ctx.on(b.canvas, 'pointermove', (e: PointerEvent) => { b.canvas.style.cursor = b.pick(e.clientX, e.clientY, bowls) >= 0 ? 'pointer' : ''; });
    ctx.keys((e) => { const k = Number(e.key); if (k >= 1 && k <= bowls.length) choose(k - 1); });
    const stop = ctx.timeout(memory + 14 / Math.sqrt(ctx.pace), () => { ready = true; while (step < order.length) { mistakes++; choose(order[step]); } });
  });
}

/** Roll the bamboo mat: drag upward (or tap W / ↑ / SPACE). */
function rollMat(ctx: Ctx, onProgress: (f: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    ctx.ui.innerHTML = `<div class="cook-instr">Roll the bamboo mat away from you</div><div class="ck-meter"><i></i></div>`;
    const fill = ctx.ui.querySelector<HTMLElement>('.ck-meter > i')!;
    ctx.hint('Drag up in short strokes, or tap <kbd>W</kbd> or <kbd>Space</kbd>.');
    const need = 320;
    let acc = 0, down = false, lastY = 0, done = false, nextWhoosh = 70;
    const t0 = performance.now(), ideal = 1.7 / ctx.pace;
    const add = (px: number) => {
      if (done || px <= 0) return;
      acc += px;
      const f = clamp(acc / need, 0, 1);
      fill.style.width = `${f * 100}%`; onProgress(f);
      if (acc > nextWhoosh) { nextWhoosh += 90; audio.sfx('whoosh', 0.45); }
      if (f >= 1) {
        done = true; stop(); ctx.hint(null);
        const t = (performance.now() - t0) / 1000;
        const s = clamp(1.12 - Math.max(0, t / ideal - 1) * 0.35, 0.4, 1);
        ctx.result(s); setTimeout(() => resolve(s), 280);
      }
    };
    ctx.on(b.canvas, 'pointerdown', (e: PointerEvent) => { down = true; lastY = e.clientY; b.canvas.setPointerCapture(e.pointerId); b.canvas.style.cursor = 'grabbing'; });
    ctx.on(b.canvas, 'pointerup', () => { down = false; b.canvas.style.cursor = ''; });
    ctx.on(b.canvas, 'pointermove', (e: PointerEvent) => { if (down) { add(lastY - e.clientY); lastY = e.clientY; } });
    ctx.keys((e) => { if (isKey(e, 'KeyW', 'ArrowUp', 'Space', 'Enter')) add(need / 7); });
    const stop = ctx.timeout(9 / Math.sqrt(ctx.pace), () => { add(need); });
  });
}

/** The knife sweeps over the roll; click / SPACE to chop on the glowing marks. Off-mark cuts make uneven pieces. */
function chopRoll(ctx: Ctx, roll: { segs: { x0: number; x1: number; m: THREE.Mesh }[]; radius: number; z: number; mat: THREE.Material }, cuts: number): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    ctx.ui.innerHTML = `<div class="cook-instr">Cut the roll at the marks</div><div class="ck-chips">${Array.from({ length: cuts }, (_, k) => `<span>cut ${k + 1}</span>`).join('')}</div>`;
    ctx.hint('Click or press <kbd>Space</kbd> when the blade reaches a mark.');
    const len = roll.segs[0].x1 - roll.segs[0].x0;
    const marks = Array.from({ length: cuts }, (_, k) => roll.segs[0].x0 + (len * (k + 1)) / (cuts + 1));
    const used = marks.map(() => false);
    const markGeo = b.g(new THREE.BoxGeometry(0.004, 0.003, roll.radius * 2.3));
    const markMat = basic('#ffd23f');
    const markMeshes = marks.map((x) => { const m = new THREE.Mesh(markGeo, markMat); m.position.set(x, BY + roll.radius * 2 + 0.006, roll.z); b.work.add(m); return m; });
    let i = 0, total = 0, kt = 0, chopping = false;
    b.knifeHoldTarget = 1; b.knifeYaw = Math.PI / 2 + 0.55; b.knifeTilt = 0.3; // angled so the hand does not block the roll
    const span = len / 2 + 0.06;
    const xNow = () => Math.sin(kt * 1.6 * Math.sqrt(ctx.pace)) * span;
    b.onFrame = (dt) => {
      if (!chopping) kt += dt;
      b.knifeTarget.set(xNow(), BY + roll.radius * 2 + 0.05, roll.z);
      for (const m of markMeshes) m.scale.y = 1 + Math.sin(kt * 9) * 0.4;
    };
    const chips = () => ctx.ui.querySelectorAll('.ck-chips span').forEach((s, k) => { s.className = k < i ? 'done' : k === i ? 'next' : ''; });
    chips();
    const split = (x: number) => {
      const seg = roll.segs.find((s) => x > s.x0 + 0.01 && x < s.x1 - 0.01);
      if (!seg) return;
      const mk = (x0: number, x1: number) => {
        const m = b.mesh(new THREE.CylinderGeometry(roll.radius, roll.radius, x1 - x0, 24), roll.mat);
        m.rotation.z = Math.PI / 2; m.position.set((x0 + x1) / 2, BY + roll.radius, roll.z);
        b.work.add(m); return { x0, x1, m };
      };
      seg.m.removeFromParent();
      const a = mk(seg.x0, x - 0.002), c = mk(x + 0.002, seg.x1);
      roll.segs.splice(roll.segs.indexOf(seg), 1, a, c);
      for (const s of roll.segs) { const dx = s.x0 + s.x1 < 2 * x ? -0.006 : 0.006; const p0 = s.m.position.x; b.tween(0.15, (k) => { s.m.position.x = p0 + dx * easeOut(k); }); s.x0 += dx; s.x1 += dx; }
      b.squash(a.m, 0.25); b.squash(c.m, 0.25);
    };
    const chop = () => {
      if (chopping || i >= cuts) return;
      chopping = true;
      const x = xNow();
      let best = -1, bd = Infinity;
      marks.forEach((m, k) => { if (!used[k] && Math.abs(m - x) < bd) { bd = Math.abs(m - x); best = k; } });
      used[best] = true; markMeshes[best].visible = false;
      const s = bd < 0.008 ? 1 : bd < 0.04 ? 1 - ((bd - 0.008) / 0.032) * 0.45 : Math.max(0.35, 0.55 - (bd - 0.04) * 5);
      b.tween(0.09, (k) => { b.knifeDip = -k * 0.055; }, () => {
        audio.sfx('chop'); split(x); b.sheenSweep();
        total += s; ctx.result(s); i++; chips();
        b.tween(0.14, (k) => { b.knifeDip = -0.055 * (1 - k); }, () => {
          chopping = false;
          if (i >= cuts) { stop(); ctx.hint(null); b.onFrame = null; b.knifeHoldTarget = 0; b.knifeTarget.set(0.5, BY + 0.004, 0.27); setTimeout(() => resolve(total / cuts), 250); }
        });
      });
    };
    ctx.on(b.canvas, 'pointerdown', chop);
    ctx.keys((e) => { if (isKey(e, 'Space', 'Enter', 'KeyE')) chop(); });
    const stop = ctx.timeout(10 / Math.sqrt(ctx.pace), () => { const iv = setInterval(() => { if (i >= cuts) clearInterval(iv); else chop(); }, 260); ctx.cleanups.push(() => clearInterval(iv)); });
  });
}

/** Hold to spoon roe; release on the line. */
function spoon(ctx: Ctx, onFill: (v: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const { b } = ctx;
    const target = rnd(0.62, 0.8), band = 0.055 * Math.pow(ctx.ease, 0.4);
    ctx.ui.innerHTML = `<div class="cook-instr">Spoon the roe</div>
      <div class="ck-meter"><u style="left:${(target - band) * 100}%;width:${band * 200}%"></u><i></i><b style="left:${target * 100}%"></b></div>`;
    const fill = ctx.ui.querySelector<HTMLElement>('.ck-meter > i')!;
    ctx.hint('Hold the mouse or <kbd>Space</kbd>. Release at the line.');
    let v = 0, holding = false, done = false, plop = 0;
    const rate = 0.45 / Math.pow(ctx.ease, 0.3);
    const finish = (s: number, label?: string) => { done = true; holding = false; stop(); ctx.hint(null); b.onFrame = null; ctx.result(s, label); setTimeout(() => resolve(s), 300); };
    b.onFrame = (dt) => {
      if (!holding || done) return;
      v += rate * dt; plop += dt;
      if (plop > 0.09) { plop = 0; audio.sfx('pop', 0.18); }
      fill.style.width = `${Math.min(1, v) * 100}%`; onFill(Math.min(1, v));
      if (v >= 1) finish(0.3, 'Too much roe');
    };
    const release = () => {
      if (!holding || done) return;
      const d = Math.abs(v - target);
      finish(d <= band * 0.35 ? 1 : d <= band ? 1 - 0.3 * (d / band) : Math.max(0.3, 0.7 - (d - band) * 3));
    };
    ctx.on(b.canvas, 'pointerdown', () => { if (!done) holding = true; });
    ctx.on(window, 'pointerup', release);
    ctx.keys((e) => { if (isKey(e, 'Space', 'Enter') && !done) holding = true; }, (e) => { if (isKey(e, 'Space', 'Enter')) release(); });
    const stop = ctx.timeout(9, () => { if (!done) finish(0.35); });
  });
}

/** The single-topping nigiri/gunkan matching each non-rice, non-nori ingredient of a platter recipe. */
function platterPieces(r: RecipeDef): string[] {
  const single = (x: RecipeDef) => Object.keys(x.ingredients).filter((k) => k !== 'rice' && k !== 'nori');
  const out: string[] = [];
  for (const ing of single(r)) {
    const hit = Object.values(RECIPES).find((x) => (x.kind === 'nigiri' || x.kind === 'gunkan') && single(x).length === 1 && single(x)[0] === ing);
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return out.length >= 2 ? out : ['salmon_nigiri', 'tuna_nigiri', 'roe_gunkan'];
}

// ---------------------------------------------------------------- main
export interface CookSession { el: HTMLElement; promise: Promise<number | null>; cancel(): void }

export function startCooking(s: GameState, t: Ticket, restId: string): CookSession | null {
  const r = RECIPES[t.recipe];
  if (!canMake(s, t.recipe, t.pieces)) {
    const missing = Object.entries(r.ingredients).filter(([k, n]) => s.inventory[k as IngredientId] < (n ?? 0) * t.pieces).map(([k]) => INGREDIENTS[k as IngredientId].name);
    toast(`Out of ${missing.join(', ')}. Restock at the supplier.`, 'bad', '📦');
    audio.sfx('error');
    return null;
  }
  const ease = clamp(playerCookSpeed(s, restId), 1, 2.2);
  const root = el('div', 'cook');
  const steps = r.kind === 'platter' ? 2 : 3;
  root.innerHTML = `<section class="panel cook-panel" aria-label="Prep station">
      <div class="cook-top">
        <div><div class="cook-kicker">${t.manualOnly ? 'Special order' : 'Prep ticket'} <span lang="ja">仕込み</span></div><h2>${esc(r.name)}</h2></div>
        <div class="cook-count">${t.pieces}<span>${t.pieces === 1 ? 'piece' : 'pieces'}</span></div>
      </div>
      <div class="cook-view"><div class="ck-vig"></div><div class="ck-combo"></div><div class="cook-grade"></div></div>
      <div class="cook-ui"></div>
      <div class="cook-foot"><div class="cook-step-wrap"><span></span><div class="cook-steps" aria-hidden="true">${Array.from({ length: steps }, () => '<i></i>').join('')}</div></div><button type="button" class="ck-cancel" aria-label="Cancel cooking"><kbd class="key sm">Esc</kbd> Cancel</button></div>
    </section>`;
  const view = root.querySelector<HTMLElement>('.cook-view')!;
  const ui = root.querySelector<HTMLElement>('.cook-ui')!;
  const gradeEl = root.querySelector<HTMLElement>('.cook-grade')!;
  const comboEl = root.querySelector<HTMLElement>('.ck-combo')!;
  const stepEls = [...root.querySelectorAll<HTMLElement>('.cook-steps i')];
  const stepLabel = root.querySelector<HTMLElement>('.cook-step-wrap > span')!;
  let hintEl: HTMLElement | null = null;
  let resolveOuter: (v: number | null) => void = () => {};
  const promise = new Promise<number | null>((res) => { resolveOuter = res; });

  const ctx: Ctx = {
    b: null as unknown as Board, ui, view, ease, pace: Math.pow(ease, 0.4), n: t.pieces, r,
    cleanups: [], cancelled: false, combo: 0, bestCombo: 0,
    stamp(text, cls) {
      const st = el('div', `ck-stamp ${cls}`, esc(text));
      view.append(st); setTimeout(() => st.remove(), 950);
    },
    result(sc, label) {
      const [g, sfx, cls, sh] = grade(sc);
      ctx.stamp(label ?? g, cls);
      audio.sfx(sfx);
      ctx.b.shake(sh);
      if (sc >= 0.72) {
        ctx.combo++; ctx.bestCombo = Math.max(ctx.bestCombo, ctx.combo);
        if (ctx.combo >= 2) {
          comboEl.textContent = `${ctx.combo} strong steps in a row`;
          comboEl.classList.add('on');
          if (ctx.combo >= 3) audio.sfx('coin', 0.5);
        }
      } else { ctx.combo = 0; comboEl.classList.remove('on'); }
    },
    hint(html) {
      hintEl?.remove(); hintEl = null;
      if (html) { hintEl = el('div', 'ck-hint', html); view.append(hintEl); }
    },
    on(target, type, fn, opts) { target.addEventListener(type, fn, opts); ctx.cleanups.push(() => target.removeEventListener(type, fn, opts)); },
    keys(down, up) {
      const d = (e: KeyboardEvent) => { if (!e.repeat) down(e); };
      addEventListener('keydown', d); if (up) addEventListener('keyup', up);
      ctx.cleanups.push(() => { removeEventListener('keydown', d); if (up) removeEventListener('keyup', up); });
    },
    timeout(sec, fn) {
      const h = setTimeout(fn, sec * 1000); const stop = () => clearTimeout(h);
      ctx.cleanups.push(stop); return stop;
    },
  };
  const cleanupStep = () => { for (const c of ctx.cleanups.splice(0)) c(); ctx.hint(null); if (ctx.b) ctx.b.canvas.style.cursor = ''; };
  const cancel = () => { if (ctx.cancelled) return; ctx.cancelled = true; cleanupStep(); ctx.b?.dispose(); resolveOuter(null); };
  root.querySelector<HTMLButtonElement>('.ck-cancel')!.addEventListener('click', () => { audio.sfx('click'); cancel(); });
  const setStep = (i: number) => {
    stepLabel.textContent = i === steps ? 'Ticket complete' : `Step ${i + 1} of ${steps}`;
    stepEls.forEach((e, k) => { e.className = k < i ? 'done' : k === i ? 'on' : ''; });
  };
  const run = async (i: number, p: Promise<number>) => { setStep(i); const v = await p; cleanupStep(); return v; };

  const play = async () => {
    await new Promise((r2) => requestAnimationFrame(r2));
    if (ctx.cancelled) return;
    const b = new Board(view);
    ctx.b = b;
    const n = Math.min(t.pieces, 6);
    const rowX = (i: number) => (i - (n - 1) / 2) * 0.16;
    const scores: number[] = [];
    const ings = Object.keys(r.ingredients) as IngredientId[];
    const riceMat = mat(RICE, { roughness: 0.85 }), noriMat = mat(NORI, { roughness: 0.75 });

    // ingredient bowls along the back of the counter (clickable in pick steps)
    const bowlFor = (color: string, x: number, ingredient?: IngredientId, sample?: string) => {
      const sh = shared!;
      const g = new THREE.Group();
      const bowl = new THREE.Mesh(sh.bowlGeo, mat('#f3efe6', { roughness: 0.3 }));
      const rim = new THREE.Mesh(b.g(new THREE.TorusGeometry(0.097, 0.004, 6, 28)), mat('#2b5aa8', { roughness: 0.3 }));
      rim.rotation.x = Math.PI / 2; rim.position.y = 0.064;
      g.add(bowl, rim);
      if (sample) {
        const piece = makeSushi(sample);
        piece.scale.setScalar(0.62); piece.position.y = 0.029; piece.rotation.y = -0.28;
        g.add(piece);
      } else if (ingredient === 'nori') {
        const sheet = b.g(new RoundedBoxGeometry(0.099, 0.005, 0.076, 1, 0.002));
        for (let i = 0; i < 5; i++) {
          const layer = new THREE.Mesh(sheet, noriMat);
          layer.position.set((i - 2) * 0.003, 0.037 + i * 0.006, 0);
          layer.rotation.y = 0.28 - i * 0.11;
          g.add(layer);
        }
      } else {
        const rice = ingredient === 'rice';
        const cucumber = ingredient === 'cucumber';
        const pieceGeo = b.g(cucumber ? new THREE.CylinderGeometry(1, 1, 1, 12) : new THREE.SphereGeometry(1, 8, 5));
        const colors = cucumber ? ['#729752', '#a9bc75', '#8faa61']
          : rice ? ['#f9ecd4', '#e8dac0', '#fff5e4'] : [color, '#' + new THREE.Color(color).multiplyScalar(0.78).getHexString()];
        const count = rice ? 52 : 13;
        const contents = new THREE.InstancedMesh(pieceGeo, mat('#ffffff', { roughness: 0.76 }), count);
        const piece = new THREE.Object3D();
        for (let i = 0; i < count; i++) {
          const angle = i * 2.39996;
          const radius = 0.069 * Math.sqrt((i + 0.5) / count);
          piece.position.set(Math.cos(angle) * radius, 0.063 - radius * 0.32 + (i % 3) * 0.003, Math.sin(angle) * radius);
          piece.scale.set(rice ? 0.014 : 0.023, rice ? 0.007 : 0.014, rice ? 0.008 : 0.021);
          piece.rotation.set(cucumber ? 0.25 * Math.sin(angle) : 0, angle, cucumber ? 0.28 * Math.cos(angle) : 0);
          piece.updateMatrix();
          contents.setMatrixAt(i, piece.matrix);
          contents.setColorAt(i, new THREE.Color(colors[i % colors.length]));
        }
        g.add(contents);
      }
      g.position.set(x, -0.03, -0.45);
      return b.add(g, true, 0.04 * Math.abs(x) * 10);
    };

    // loose rice grains scattered around — the board is in use
    const grains = new THREE.InstancedMesh(b.g(new THREE.CapsuleGeometry(0.0035, 0.007, 2, 6)), riceMat, 70);
    const gm = new THREE.Matrix4(), gq = new THREE.Quaternion(), ge = new THREE.Euler();
    for (let i = 0; i < 70; i++) {
      const a = rnd(0, Math.PI * 2), rr = rnd(0.12, 0.5);
      gm.compose(new THREE.Vector3(Math.cos(a) * rr * 1.1, BY + 0.003, 0.05 + Math.sin(a) * rr * 0.45), gq.setFromEuler(ge.set(Math.PI / 2, 0, rnd(0, 6))), new THREE.Vector3(1, 1, 1));
      grains.setMatrixAt(i, gm);
    }
    grains.count = 0; grains.frustumCulled = false; b.work.add(grains); // count starts at 0: never cull on a stale empty bound
    const addGrains = (k: number) => { grains.count = Math.min(70, grains.count + k); grains.instanceMatrix.needsUpdate = true; };

    const riceHeap = () => {
      const heap = new THREE.Group();
      const pile = new THREE.Group();
      const base = b.mesh(new THREE.SphereGeometry(1, 20, 12), riceMat);
      base.scale.set(0.093, 0.051, 0.075);
      pile.add(base);
      const grainsOnTop = new THREE.InstancedMesh(
        b.g(new THREE.CapsuleGeometry(0.0037, 0.007, 2, 6)), riceMat, 88,
      );
      const grainScale = new THREE.Vector3();
      const grainPosition = new THREE.Vector3();
      for (let i = 0; i < grainsOnTop.count; i++) {
        const angle = i * 2.39996;
        const y = (i + 0.5) / grainsOnTop.count;
        const spread = Math.sqrt(1 - y * y);
        grainPosition.set(Math.cos(angle) * spread * 0.094, y * 0.051, Math.sin(angle) * spread * 0.076);
        grainScale.set(1, 0.87 + (i % 5) * 0.12, 1);
        gq.setFromEuler(ge.set(Math.PI / 2 + Math.sin(angle) * 0.4, 0, angle));
        gm.compose(grainPosition, gq, grainScale);
        grainsOnTop.setMatrixAt(i, gm);
        grainsOnTop.setColorAt(i, new THREE.Color(i % 4 === 0 ? '#ebe0c7' : '#ffffff'));
      }
      grainsOnTop.instanceMatrix.needsUpdate = true;
      pile.add(grainsOnTop);
      heap.add(pile);
      heap.position.set(0, BY + 0.039, 0.05);
      b.add(heap);
      const morph = (f: number) => {
        pile.scale.set(1 - f * 0.19, 1 + f * 0.07, 1 - f * 0.14);
        heap.rotation.y = f * 9;
      };
      return { heap, morph };
    };
    const riceRow = (shape: 'nigiri' | 'oval') => Array.from({ length: n }, (_, i) => {
      const m = shape === 'nigiri' ? b.mesh(new THREE.CapsuleGeometry(0.042, 0.075, 6, 14), riceMat) : b.mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.06, 20), riceMat);
      if (shape === 'nigiri') { m.rotation.z = Math.PI / 2; m.scale.set(1, 1, 0.82); m.position.set(rowX(i), BY + 0.04, 0.02); }
      else { m.scale.set(1.3, 1, 1); m.position.set(rowX(i), BY + 0.03, 0.02); }
      return b.add(m, true, i * 0.06);
    });
    const finalPieces = (z = 0.02) => Array.from({ length: n }, (_, i) => {
      const p = fitSushi(r.id, 0.14); p.position.set(rowX(i), BY, z); p.rotation.y = Math.PI / 2 + rnd(-0.08, 0.08);
      b.add(p, true, i * 0.07); setTimeout(() => !ctx.cancelled && b.squash(p, 0.35), 320 + i * 70);
      return p;
    });

    if (r.kind === 'nigiri' || r.kind === 'gunkan') {
      // 1) knead the rice
      const { heap, morph } = riceHeap();
      scores.push(await run(0, knead(ctx, [heap], r.kind === 'nigiri' ? 2.2 : 1.8, 'Shape the rice', (f) => { morph(f); if (Math.random() < 0.3) addGrains(1); })));
      if (ctx.cancelled) return;
      b.remove(heap);
      const rice = riceRow(r.kind === 'nigiri' ? 'nigiri' : 'oval');
      await new Promise((r2) => setTimeout(r2, 250));
      if (r.kind === 'nigiri') {
        // 2) slice the fish
        const fish = b.mesh(new RoundedBoxGeometry(0.46, 0.06, 0.15, 2, 0.016), fishMat(r));
        fish.position.set(0, BY + 0.031, 0.2); b.add(fish);
        const sliceMesh: THREE.Mesh[] = [];
        let right = 0.23;
        scores.push(await run(1, slice(ctx, fish, 2, (_i, x) => {
          const w = right - x; right = x;
          fish.geometry = b.g(new RoundedBoxGeometry(Math.max(0.05, right + 0.23), 0.06, 0.15, 2, 0.016));
          fish.position.x = (right - 0.23) / 2;
          const sl = b.mesh(new RoundedBoxGeometry(Math.max(0.03, w), 0.06, 0.15, 2, 0.012), fishMat(r));
          sl.position.set(x + w / 2, BY + 0.031, 0.2); b.add(sl, false);
          const k0 = sliceMesh.length; sliceMesh.push(sl);
          const from = sl.position.clone(), to = new THREE.Vector3(0.44, BY + 0.012 + k0 * 0.022, 0.2);
          b.tween(0.35, (k) => { sl.position.lerpVectors(from, to, easeOut(k)); sl.position.y += Math.sin(k * Math.PI) * 0.06; sl.rotation.z = -k * Math.PI / 2; sl.scale.set(1, 1, 1); },
            () => { sl.rotation.set(0, 0, 0); sl.geometry = b.g(new RoundedBoxGeometry(0.17, 0.018, 0.085, 2, 0.008)); b.squash(sl, 0.4); });
        })));
        if (ctx.cancelled) return;
        b.remove(fish);
        // 3) drape the topping on the middle rice
        const top = sliceMesh[sliceMesh.length - 1];
        const mid = rice[Math.floor((n - 1) / 2)];
        scores.push(await run(2, dragTo(ctx, top, mid.position.clone(), [rowX(0), rowX(n - 1)], 'Place the topping on the rice', BY + 0.085)));
        if (ctx.cancelled) return;
        for (const o of [...rice, ...sliceMesh]) b.remove(o);
        await new Promise((r2) => setTimeout(r2, 180));
        finalPieces();
      } else {
        // 2) wrap the nori band
        const bands = rice.map((rm) => {
          const band = b.mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.075, 22, 1, true), mat(NORI, { roughness: 0.75, side: THREE.DoubleSide }));
          band.scale.set(1.3, 0.001, 1); band.position.copy(rm.position); band.position.y = BY + 0.0375;
          b.work.add(band); return band;
        });
        scores.push(await run(1, knead(ctx, bands, 1.2, 'Wrap each piece in nori', (f) => bands.forEach((bd) => { bd.scale.y = Math.max(0.001, f); }))));
        if (ctx.cancelled) return;
        // 3) spoon roe
        const per = 14;
        const roe = new THREE.InstancedMesh(b.g(new THREE.SphereGeometry(0.011, 8, 6)), mat(r.topColor, { roughness: 0.12, transparent: true, opacity: 0.92 }), per * n);
        const m4 = new THREE.Matrix4();
        for (let i = 0; i < n; i++) for (let k = 0; k < per; k++) {
          const a = rnd(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * 0.036;
          m4.makeTranslation(rowX(i) + Math.cos(a) * rr * 1.3, BY + 0.07 + rnd(0, 0.012) + (k / per) * 0.012, 0.02 + Math.sin(a) * rr);
          roe.setMatrixAt(k * n + i, m4);
        }
        roe.count = 0; roe.frustumCulled = false; b.work.add(roe);
        scores.push(await run(2, spoon(ctx, (v) => { roe.count = Math.floor(v * per * n); })));
        if (ctx.cancelled) return;
        for (const o of [...rice, ...bands, roe]) b.remove(o);
        await new Promise((r2) => setTimeout(r2, 180));
        finalPieces();
      }
    } else if (r.kind === 'maki' || r.kind === 'roll') {
      // 1) lay out ingredients from the bowls in order
      const decoys: { c: string; n: string }[] = [{ c: '#f7e14b', n: 'Lemon' }, { c: '#ffd59e', n: 'Cheese' }, { c: '#e84a5f', n: 'Strawberry' }];
      const decoy = decoys[Math.floor(Math.random() * decoys.length)];
      const cols = [...ings.map((id) => INGREDIENTS[id].color), decoy.c];
      const labels = [...ings.map((id) => INGREDIENTS[id].name), decoy.n];
      const perm = cols.map((_, i) => i).sort(() => Math.random() - 0.5);
      const bowls = perm.map((ci, k) => bowlFor(cols[ci], (k - (perm.length - 1) / 2) * 0.24, ings[ci]));
      const bowlLabels = perm.map((ci) => labels[ci]);
      const idxOf = (ing: IngredientId) => perm.indexOf(ings.indexOf(ing));
      const rank = (id: IngredientId) => (r.kind === 'roll' ? (id === 'rice' ? 0 : id === 'nori' ? 1 : 2) : id === 'nori' ? 0 : id === 'rice' ? 1 : 2); // inside-out: rice first
      const orderIng = [...ings].sort((a, c) => rank(a) - rank(c));
      const order = orderIng.map(idxOf);
      const mat0 = new THREE.Group();
      for (let i = 0; i < 16; i++) { const sl = new THREE.Mesh(b.g(new THREE.CylinderGeometry(0.007, 0.007, 0.58, 6)), mat(i % 2 ? '#cdb46e' : '#b89a55', { roughness: 0.8 })); sl.rotation.z = Math.PI / 2; sl.position.set(0, BY + 0.007, -0.12 + i * 0.024); mat0.add(sl); }
      b.add(mat0, false);
      const layers: THREE.Mesh[] = [];
      let fillings = 0;
      scores.push(await run(0, pickOrder(ctx, `Layer the ${r.kind === 'roll' ? 'inside-out roll' : 'maki'}`, bowls, bowlLabels, order, 0, (k, bi) => {
        const id = orderIng[k];
        const y = BY + 0.016 + layers.length * 0.01;
        let m: THREE.Mesh;
        if (id === 'nori') m = b.mesh(new THREE.BoxGeometry(0.5, 0.005, 0.32), noriMat);
        else if (id === 'rice') { m = b.mesh(new THREE.BoxGeometry(0.47, 0.018, 0.29), riceMat); addGrains(10); }
        else { m = b.mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 10), mat(INGREDIENTS[id].color, { roughness: 0.45 })); m.rotation.z = Math.PI / 2; fillings++; }
        const to = new THREE.Vector3(0, y + (id === 'nori' || id === 'rice' ? 0 : 0.012), id === 'nori' || id === 'rice' ? 0.06 : 0.08 - (fillings - 1) * 0.035);
        const from = bowls[bi].position.clone().add(new THREE.Vector3(0, 0.12, 0));
        m.position.copy(from); b.add(m, false); layers.push(m);
        b.tween(0.3, (kk) => { m.position.lerpVectors(from, to, easeOut(kk)); m.position.y += Math.sin(kk * Math.PI) * 0.12; }, () => { b.squash(m, 0.45); });
      })));
      if (ctx.cancelled) return;
      for (const bw of bowls) b.remove(bw);
      // 2) roll the mat
      const radius = 0.062;
      const rollMatl = r.kind === 'roll' ? riceMat : noriMat;
      const rollMesh = b.mesh(new THREE.CylinderGeometry(radius, radius, 0.5, 24), rollMatl);
      rollMesh.rotation.z = Math.PI / 2; rollMesh.visible = false; b.add(rollMesh, false);
      scores.push(await run(1, rollMat(ctx, (f) => {
        layers.forEach((l, i) => { l.scale.z = Math.max(0.05, 1 - f * 1.05); l.position.z = 0.06 - f * 0.14 + (i % 2) * 0.002; });
        if (f > 0.25) {
          rollMesh.visible = true;
          const k = (f - 0.25) / 0.75;
          rollMesh.scale.set(0.4 + k * 0.6, 1, 0.4 + k * 0.6);
          rollMesh.position.set(0, BY + radius * (0.4 + k * 0.6), 0.2 - f * 0.16);
          rollMesh.rotation.x = -f * 14;
        }
        mat0.rotation.x = -Math.sin(f * Math.PI) * 0.15;
      })));
      if (ctx.cancelled) return;
      for (const l of layers) b.remove(l, false);
      rollMesh.scale.set(1, 1, 1); rollMesh.rotation.x = 0; rollMesh.position.set(0, BY + radius, 0.05);
      b.tween(0.2, (k) => { mat0.rotation.x = 0; mat0.position.z = -k * 0.5; mat0.scale.setScalar(1 - k * 0.999); }, () => mat0.removeFromParent());
      b.squash(rollMesh, 0.5); audio.sfx('pop');
      // 3) chop on the marks
      const segs = [{ x0: -0.25, x1: 0.25, m: rollMesh }];
      scores.push(await run(2, chopRoll(ctx, { segs, radius, z: 0.05, mat: rollMatl }, 3)));
      if (ctx.cancelled) return;
      for (const sg of segs) b.remove(sg.m);
      await new Promise((r2) => setTimeout(r2, 180));
      finalPieces();
    } else {
      // platter: memorize the chef's arrangement on a geta, then garnish
      const geta = new THREE.Group();
      const plank = b.mesh(new RoundedBoxGeometry(0.78, 0.035, 0.26, 2, 0.01), getaMat ??= new THREE.MeshStandardMaterial({ map: woodTex('#e8c48f', '#b98a56', 1), roughness: 0.6 }));
      plank.position.y = 0.045;
      for (const x of [-0.28, 0.28]) { const f = b.mesh(new THREE.BoxGeometry(0.04, 0.03, 0.24), mat('#b98a56')); f.position.set(x, 0.015, 0); geta.add(f); }
      geta.add(plank); geta.position.set(0, BY, 0.04); b.add(geta);
      const pool = platterPieces(r);
      const order = pool.map((_, k) => k).sort(() => Math.random() - 0.5);
      const slotX = (k: number) => (k - (pool.length - 1) / 2) * 0.15;
      const preview = order.map((pi, k) => { const p = fitSushi(pool[pi], 0.13); p.position.set(slotX(k), BY + 0.065, 0.04); p.rotation.y = Math.PI / 2; b.add(p, true, 0.35 * k / ctx.pace); return p; });
      const memo = 0.35 * pool.length / ctx.pace + 1.2;
      setTimeout(() => !ctx.cancelled && preview.forEach((p) => b.remove(p)), memo * 1000 - 200);
      const bowls = pool.map((id, k) => bowlFor(RECIPES[id].topColor, (k - (pool.length - 1) / 2) * 0.2, undefined, id));
      const labels = pool.map((id) => RECIPES[id].name.replace(' Nigiri', '').replace('Ikura ', ''));
      scores.push(await run(0, pickOrder(ctx, 'Remember the order, then arrange the pieces', bowls, labels, order, memo, (k, bi) => {
        const p = fitSushi(pool[bi], 0.13); p.rotation.y = Math.PI / 2;
        const from = bowls[bi].position.clone().add(new THREE.Vector3(0, 0.12, 0)), to = new THREE.Vector3(slotX(k), BY + 0.065, 0.04);
        p.position.copy(from); b.add(p, false);
        b.tween(0.3, (kk) => { p.position.lerpVectors(from, to, easeOut(kk)); p.position.y += Math.sin(kk * Math.PI) * 0.1; }, () => b.squash(p, 0.4));
      })));
      if (ctx.cancelled) return;
      for (const bw of bowls) b.remove(bw);
      const leaf = b.mesh(new THREE.CircleGeometry(0.05, 16), mat('#3f8f3a', { roughness: 0.5 }));
      leaf.geometry.rotateX(-Math.PI / 2); leaf.scale.set(1.7, 1, 0.8); leaf.position.set(0.5, BY + 0.01, 0.26); b.add(leaf);
      scores.push(await run(1, dragTo(ctx, leaf, new THREE.Vector3(0.33, BY, 0.04), [-0.35, 0.35], 'Set the shiso leaf at the end of the platter', BY + 0.066)));
      if (ctx.cancelled) return;
    }

    // ---- final reveal: plate it, push the camera in, stamp the grade
    setStep(steps);
    const avg = scores.reduce((a, c) => a + c, 0) / scores.length;
    const bonus = Math.min(0.08, 0.02 * Math.max(0, ctx.bestCombo - 1));
    const score = clamp(avg + bonus, 0.35, 1);
    await new Promise((r2) => setTimeout(r2, 380));
    if (ctx.cancelled) return;
    let hero: THREE.Object3D;
    if (r.kind !== 'platter') {
      for (const o of [...b.work.children]) if (o !== grains) b.remove(o);
      hero = makePlate(r.id, t.pieces); hero.scale.setScalar(1.75); hero.position.set(0, BY, 0.06);
      b.add(hero); b.spin.push(hero);
      setTimeout(() => !ctx.cancelled && b.squash(hero, 0.3), 330);
    } else hero = b.work.children[b.work.children.length - 1];
    const c0 = b.camPos.clone(), l0 = b.camLook.clone();
    const l1 = new THREE.Vector3(0, BY + 0.06, 0.05);
    const frameDistance = Math.max(1, 1.75 / b.cam.aspect);
    const c1 = new THREE.Vector3(0.14, 0.51, 0.69).multiplyScalar(frameDistance).add(l1);
    if (b.calm) { b.camPos.copy(c1); b.camLook.copy(l1); }
    else b.tween(1.5, (k) => { const e = easeInOut(k); b.camPos.lerpVectors(c0, c1, e); b.camLook.lerpVectors(l0, l1, e); });
    gradeEl.innerHTML = `<div class="cook-result">Quality <strong>${Math.round(score * 100)}%</strong></div>`;
    ui.innerHTML = `<div class="cook-instr">Order ready. Serve it at the counter.</div>`;
    audio.sfx(score > PERFECT_SCORE ? 'perfect' : 'success');
    await new Promise((r2) => setTimeout(r2, 1700));
    if (ctx.cancelled) return;
    cleanupStep();
    resolveOuter(score);
    setTimeout(() => b.dispose(), 500); // after the modal fades, so the view never flashes empty
  };
  play();
  return { el: root, promise, cancel };
}
