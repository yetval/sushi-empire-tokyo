// NPCs: walk-in customers (full lifecycle), staff, pedestrians and story characters.
// All money/pieces flow through core/sim (acceptOrder / settle / customerLeft) — this file only animates.
import * as THREE from 'three';
import { audio } from '../audio/audio';
import { emit, on } from '../core/bus';
import { CUSTOMERS, CustomerType, DISTRICTS, PROPERTIES, RECIPES } from '../core/data';
import * as sim from '../core/sim';
import { Avatar, Employee, GameState } from '../core/state';
import { Anim, Character, FACE_STYLE_NAMES, Outfit } from '../engine/character';
import { World } from '../engine/collision';
import { makePlate } from '../world/sushi';
import { DistrictScene, RestaurantSite, Spot, StreetStop } from '../world/types';
import { Bubble } from './bubble';


const MAX_CHARS = 96;
const PED_MIN = 20, PED_MAX = 48; // sidewalk walkers per district (× quality); tuned with scripts/perf.mjs
const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const vs = (sp: Spot) => V(sp.x, sp.z);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const SKINS = ['#f1c27d', '#e0ac69', '#ffdbac', '#c68642', '#8d5524', '#f5d0b0'];
const HAIRS = ['#1b1b1b', '#2b1d14', '#5a3825', '#a0522d', '#d4a373', '#7b7b7b', '#3d2b56', '#c0392b'];
const STREET_COLORS = ['#b75e50', '#367876', '#c2a466', '#5e658e', '#9a5971', '#78937a', '#6686a1', '#b88670'];
const PANTS = ['#2d3142', '#3d405b', '#5c4b51', '#283845', '#6d6875', '#1e3d59', '#7f8c8d'];
const STORY_HEIGHT: Record<string, number> = { kenji: 0.9, mika: 0.96, sato: 1.07, ryo: 1.04, aoki: 0.99 };
const STREET_POSES: Record<StreetStop['kind'], Anim> = { photo: 'photo', phone: 'phone', bench: 'sip', vending: 'vending', browse: 'idle' };

let nextCustomerId = Math.floor(Date.now() % 1e9) * 10; // unique across reloads; never collides with old tickets

function baseAvatar(): Avatar {
  return { skin: pick(SKINS), hair: pick(HAIRS), hairStyle: Math.floor(Math.random() * 9), shirt: pick(STREET_COLORS), pants: pick(PANTS), headwear: 0, faceStyle: Math.floor(Math.random() * FACE_STYLE_NAMES.length) };
}

// ---------------------------------------------------------------- props held in hands / on heads
// Props share geometry + materials (module-level caches) so spawning customers never leaks GPU memory.
const matCache = new Map<string, THREE.MeshStandardMaterial>();
const propMat = (c: string, extra: THREE.MeshStandardMaterialParameters = {}) => {
  const k = c + JSON.stringify(extra);
  let m = matCache.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, ...extra }); matCache.set(k, m); }
  return m;
};
const geoCache = new Map<string, THREE.BufferGeometry>();
const geo = (k: string, make: () => THREE.BufferGeometry) => { let g = geoCache.get(k); if (!g) { g = make(); geoCache.set(k, g); } return g; };
function accessory(key: string, color: string, dimensions: [number, number, number], position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geo(key, () => new THREE.BoxGeometry(...dimensions)), propMat(color));
  mesh.position.set(...position);
  return mesh;
}

function phone(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(accessory('phone', '#8d5e57', [0.084, 0.15, 0.015], [0, 0, 0]),
    accessory('phone-screen', '#2e363e', [0.073, 0.124, 0.004], [0, 0, 0.008]));
  group.position.set(0.1, 0.2, 0.05);
  return group;
}

function notepad(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(accessory('pad-cover', '#6c5546', [0.164, 0.21, 0.018], [0, 0, 0]),
    accessory('pad-paper', '#e8dcc5', [0.149, 0.194, 0.007], [0, -0.003, 0.010]));
  for (const y of [-0.054, -0.027, 0, 0.027]) {
    group.add(accessory('pad-rule', '#9c9c8b', [0.113, 0.003, 0.002], [0, y, 0.014]));
  }
  group.add(accessory('pad-binding', '#847052', [0.154, 0.019, 0.008], [0, 0.086, 0.014]));
  group.rotation.x = -0.55;
  return group;
}

function clipboard(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(accessory('clip-board', '#8b694e', [0.20, 0.26, 0.02], [0, 0, 0]),
    accessory('clip-paper', '#e4d8bc', [0.174, 0.215, 0.006], [0, -0.01, 0.012]),
    accessory('clip-metal', '#ad9467', [0.087, 0.035, 0.012], [0, 0.104, 0.017]));
  group.rotation.x = -0.5;
  return group;
}

function camera(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(accessory('camera', '#353537', [0.16, 0.10, 0.075], [0, 0.018, 0]),
    accessory('camera-viewfinder', '#b29772', [0.036, 0.026, 0.009], [0.053, 0.048, 0.039]),
    accessory('camera-grip', '#55443d', [0.037, 0.087, 0.009], [-0.061, 0.016, 0.039]));
  const lens = new THREE.Mesh(geo('camera-lens', () => new THREE.CylinderGeometry(0.037, 0.041, 0.041, 12)), propMat('#997e61'));
  lens.rotation.x = Math.PI / 2; lens.position.set(-0.005, 0.013, 0.051);
  const glass = new THREE.Mesh(geo('camera-glass', () => new THREE.SphereGeometry(0.030, 10, 5)), propMat('#394c51', { roughness: 0.2 }));
  glass.scale.z = 0.17; glass.position.set(-0.005, 0.013, 0.073);
  group.add(lens, glass);
  return group;
}

function drinkCan(): THREE.Object3D {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(geo('drink-can', () => new THREE.CylinderGeometry(0.032, 0.032, 0.105, 10)), propMat('#507061'));
  const rim = new THREE.Mesh(geo('drink-rim', () => new THREE.CylinderGeometry(0.032, 0.032, 0.007, 10)), propMat('#d3cfc0'));
  rim.position.y = 0.054;
  g.add(shell, rim);
  g.rotation.x = Math.PI / 2;
  return g;
}

function chopsticks(): THREE.Object3D {
  const g = new THREE.Group();
  for (const dir of [-1, 1]) {
    const stick = accessory('held-chopstick', '#b39062', [0.009, 0.19, 0.009], [dir * 0.012, -0.048, 0.045]);
    stick.rotation.z = dir * 0.045;
    g.add(stick);
  }
  return g;
}
function umbrella(color: string): THREE.Object3D {
  const g = new THREE.Group();
  const canopy = new THREE.Mesh(geo('canopy', () => new THREE.ConeGeometry(0.62, 0.3, 8, 1, true)), propMat(color, { roughness: 0.5, side: THREE.DoubleSide }));
  canopy.position.y = 0.35;
  const pole = new THREE.Mesh(geo('pole', () => new THREE.CylinderGeometry(0.012, 0.012, 0.9)), propMat('#444'));
  pole.position.y = -0.05;
  g.add(canopy, pole);
  return g;
}

/** Looks per customer type. Returns avatar, outfit and props. */
const LONG_HAIR = [2, 3, 5, 6];
function customerLook(type: CustomerType): { a: Avatar; o: Outfit; hand?: THREE.Object3D } {
  const a = baseAvatar();
  const fem = Math.random() < 0.5;
  if (fem) a.hairStyle = pick(LONG_HAIR); else a.hairStyle = pick([0, 1, 4, 8, 8]);
  switch (type) {
    case 'office': // salaryman / office lady: dark suit, white or pale shirt
      a.shirt = pick(['#ece8df', '#dfe5e8', '#e9e0d8']);
      a.pants = pick(['#2e333b', '#3a3f47', '#2b2f38']);
      return { a, o: { cut: 'blazer', vest: pick(['#2f3742', '#3d3a39', '#353b47', '#23272f']), tie: fem ? undefined : pick(['#7d3f3b', '#3f5f5a', '#6e5a3e', '#3a4867']), skirt: fem && Math.random() < 0.6 ? a.pants : undefined, glasses: pick(['square', undefined, undefined]) } };
    case 'student': // school uniform: gakuran or blouse + pleated skirt and ribbon, school bag
      a.pants = '#262b38';
      if (fem) { a.shirt = '#f1eee6'; return { a, o: { skirt: '#2c3550', tie: '#9a3f3a', bag: pick(['#3b3330', '#55493c']) } }; }
      a.shirt = '#ece8df'; a.hairStyle = pick([0, 1, 1, 8]);
      return { a, o: { cut: 'workwear', vest: '#252a36', trim: '#b4975a', bag: pick(['#3b3330', '#55493c', '#3e4a5a']) } };
    case 'tourist': // backpack, cap, camera
      a.headwear = pick([0, 3, 3]);
      a.shirt = pick(['#8fa6a0', '#d7b98d', '#a9b6c9', '#c99b86', '#e4dccb']);
      a.pants = pick(['#a8957a', '#6f7c87', '#8a8676']);
      return { a, o: { bag: pick(['#5a473a', '#4e5d55', '#6a5444']) }, hand: camera() };
    case 'family':
      a.shirt = pick(['#b8a88e', '#c9a79b', '#9fb0a3', '#c8c1b3']);
      return { a, o: { cut: 'knit', skirt: fem && Math.random() < 0.5 ? pick(['#6d5a4f', '#4f5866']) : undefined } };
    case 'foodie':
      a.shirt = pick(['#7f6a55', '#4f6e6c', '#6f5a6b', '#a28e6b']);
      return { a, o: { cut: Math.random() < 0.5 ? 'knit' : undefined, detail: pick(['stubble', 'earrings', undefined]), glasses: pick(['round', undefined]) } };
    case 'wealthy': // long camel or charcoal overcoat
      a.shirt = '#ebe5da';
      a.pants = '#2b2d33';
      return { a, o: { cut: 'longcoat', vest: pick(['#a88a66', '#3b3d44', '#5b4a42', '#2f3b38']), glasses: pick(['round', undefined]), detail: fem ? 'earrings' : undefined, skirt: fem && Math.random() < 0.5 ? '#2b2d33' : undefined } };
    case 'influencer':
      a.shirt = pick(['#d9b3ac', '#b8a3c4', '#a7bccb', '#efe6d8']);
      a.hair = pick(['#c9936c', '#74405a', '#231e21']);
      return { a, o: { skirt: fem ? pick(['#2f2c33', '#8a7a6c']) : undefined, detail: 'earrings' }, hand: phone() };
    case 'critic':
      a.shirt = '#d9d2c6';
      a.pants = '#383449';
      a.hairStyle = 3;
      a.hair = '#78716d';
      a.faceStyle = 1;
      return { a, o: { cut: 'blazer', vest: '#4a4357', glasses: 'square', detail: 'earrings', skirt: '#383449' }, hand: notepad() };
    case 'vip':
      a.shirt = '#efe9de';
      a.pants = '#262832';
      a.hairStyle = 8;
      return { a, o: { cut: 'longcoat', vest: '#1f232b', tie: '#8c6b3e', glasses: 'round' } };
  }
}

// ---------------------------------------------------------------- types
type CState = 'arrive' | 'queue' | 'toSpot' | 'waiting' | 'eating' | 'leave';

interface Cust {
  id: number; type: CustomerType; siteId: string; char: Character; bubble: Bubble; child?: Character;
  order: { recipe: string; pieces: number }; vip: boolean;
  state: CState; path: THREE.Vector3[]; exit: THREE.Vector3[]; speed: number;
  joinT: number; patience: number; ticketId: number | null;
  seat: number; stand: number; orderTimer: number; eatT: number; reactT: number; reactText: string | null;
  claimed: boolean; fade: number; scale: number; faceYaw: number | null; plate: THREE.Object3D | null;
  meal: { sticks: THREE.Object3D; food: THREE.Object3D[]; bite: number; interval: number; stack: number } | null;
  carryProp?: THREE.Object3D;
}

interface SiteRT {
  site: RestaurantSite; queue: Cust[]; seats: (Cust | null)[]; stand: (Cust | null)[]; standSpots: Spot[];
  spawnAcc: number; plates: Map<number, THREE.Object3D>; plateKey: string;
}

interface Staff {
  e: Employee; key: string; siteId: string; char: Character; home: Spot;
  path: THREE.Vector3[]; target: Cust | null; ticketId: number | null; plate: THREE.Object3D | null; timer: number; anim: Anim;
  enter?: THREE.Vector3[]; // new hire / transfer: walking in from the street to the station
}

interface Rider {
  siteId: string; char: Character; scooter: THREE.Group; state: 'ride' | 'walkIn' | 'wait' | 'walkOut' | 'leave';
  path: THREE.Vector3[]; exit: THREE.Vector3[]; park: THREE.Vector3; pickup: Spot; t: number;
}

interface StreetRoutine {
  stop: StreetStop;
  laneIndex: number;
  phase: 'walking' | 'headingBack' | 'approach' | 'stopped' | 'return';
  path: THREE.Vector3[];
  time: number;
  prop: THREE.Object3D | null;
}
interface Ped {
  char: Character; lane: THREE.Vector3[]; t: number; dir: number; speed: number;
  umbrella: THREE.Object3D | null; wantsUmbrella: boolean; routine: StreetRoutine | null;
  cur: number; // speed actually walked this step (followers match it)
  jit: number; slot: number; // lateral place on the sidewalk: personal jitter + side-by-side slot in a group
  lead: Ped | null; lag: number; // group member: walks beside its leader, lag metres behind
  pause: number; stopT: number; stopAnim: Anim; phone: THREE.Object3D | null; // solo walkers stop now and then
}
/** Japan walks on the left: each direction keeps to its own band of the sidewalk, so oncoming walkers pass cleanly. */
const BAND = 0.3;
interface Story { char: Character; spot: Spot; wave: number; near: boolean }

// ---------------------------------------------------------------- manager
export class NPCManager {
  private group = new THREE.Group();
  private customers: Cust[] = [];
  private sites = new Map<string, SiteRT>();
  private staff: Staff[] = [];
  private peds: Ped[] = [];
  private story: Story[] = [];
  private lanes: THREE.Vector3[][] = [];
  private unsub: (() => void)[] = [];
  private lastClock = -1;
  private frameNo = 0;
  private chopT = 0;
  private playerPos = new THREE.Vector3();
  private posted = new Set<string>(); // `${employee id}:${restaurant}` already on screen (district load = everyone)
  private live = false; // set after the constructor's first refresh: later newcomers walk in

  constructor(scene: THREE.Scene, private d: DistrictScene, s: GameState) {
    scene.add(this.group);
    this.lanes = d.walkPaths.filter((p) => p.length > 1).map((p) => densify(p, 1));
    for (const site of d.sites) this.sites.set(site.id, {
      site, queue: [], seats: site.seats.map(() => null), standSpots: standSpots(site), stand: [], spawnAcc: rnd(0.75, 1),
      plates: new Map(), plateKey: '',
    });
    for (const rt of this.sites.values()) rt.stand = rt.standSpots.map(() => null);
    this.spawnPeds(s);
    for (const n of d.storyNpcs) {
      const ch = new Character(storyAvatar(n.id), storyOutfit(n.id), STORY_HEIGHT[n.id]);
      if (n.id === 'aoki') ch.hands.add(notepad());
      ch.root.position.set(n.spot.x, 0, n.spot.z); ch.root.rotation.y = n.spot.yaw;
      this.group.add(ch.root);
      this.story.push({ char: ch, spot: n.spot, wave: 0, near: false });
    }
    this.unsub.push(on('customerLeft', (e) => {
      const c = this.customers.find((x) => x.id === e.customerId);
      if (c && c.state !== 'leave') {
        const line = e.reason === 'patience' ? 'I have to go.' : 'I’ll come back tomorrow.';
        this.leave(c, line);
      }
    }));
    this.refresh(s);
    this.live = true;
  }

  private charCount(): number { return this.customers.length + this.customers.filter((c) => c.child).length + this.peds.length + this.staff.length + this.story.length + this.riders.length; }

  // ------------------------------------------------------------ pedestrians
  private spawnPeds(s: GameState): void {
    if (!this.lanes.length) return;
    const q = s.settings.quality === 'low' ? 0.5 : s.settings.quality === 'medium' ? 0.75 : 1;
    const n = Math.round(Math.max(PED_MIN, Math.min(PED_MAX, 14 + DISTRICTS[this.d.id].traffic * 4.5)) * q);
    const world = new World();
    world.colliders = this.d.colliders;
    for (let i = 0; i < n; i++) {
      const stop = this.d.streetStops[i];
      const route = stop && streetAccess(this.lanes, stop, world);
      const lane = route?.lane ?? pick(this.lanes);
      const type = stop?.kind === 'photo' ? 'tourist' : pick(['office', 'student', 'family', 'foodie', 'wealthy'] as CustomerType[]);
      const look = customerLook(type);
      const ch = new Character(look.a, look.o, rnd(0.91, 1.07));
      const prop = stop?.kind === 'photo' ? look.hand ?? camera()
        : stop?.kind === 'phone' ? phone() : stop?.kind === 'bench' ? drinkCan() : null;
      if (prop) {
        if (stop.kind === 'phone') { prop.position.set(0, -0.018, 0.015); prop.rotation.x = 0.9; }
        if (stop.kind === 'photo') prop.rotation.x = 2.38;
        ch.rightGrip.add(prop);
      }
      const routine: StreetRoutine | null = stop && route ? {
        stop, laneIndex: route.i, phase: 'stopped', path: [], time: rnd(6, 15), prop,
      } : null;
      if (routine) {
        ch.root.position.copy(vs(stop.spot));
        ch.root.rotation.y = stop.spot.yaw;
      } else if (prop) prop.visible = false;
      this.group.add(ch.root);
      const t = routine ? routine.laneIndex : Math.random() * lane.length;
      // a quarter of the walkers come in pairs, a few in threes (families more often); groups stroll slower
      const size = stop || i + 1 >= n ? 1 : type === 'family' ? (Math.random() < 0.5 ? 3 : 2) : Math.random() < 0.08 ? 3 : Math.random() < 0.27 ? 2 : 1;
      const lead: Ped = {
        char: ch, lane, t, dir: Math.random() < 0.5 ? 1 : -1, speed: size > 1 ? rnd(0.85, 1.2) : rnd(1.0, 1.7),
        umbrella: null, wantsUmbrella: Math.random() < 0.7, routine, cur: 0, jit: routine ? 0 : rnd(-0.12, 0.12), // routine walkers must pass within ~0.45 m of their lane point
        slot: size === 2 ? -0.26 : 0, lead: null, lag: 0, pause: routine || size > 1 ? Infinity : rnd(8, 50), stopT: 0, stopAnim: 'idle', phone: null,
      };
      if (lead.pause < Infinity && Math.random() < 0.4) { lead.phone = phone(); lead.phone.position.set(0, -0.018, 0.015); lead.phone.rotation.x = 0.9; lead.phone.visible = false; ch.rightGrip.add(lead.phone); }
      this.peds.push(lead);
      for (let k = 1; k < size; k++, i++) {
        const lk = customerLook(type);
        const fc = new Character(lk.a, lk.o, rnd(0.91, 1.07));
        this.group.add(fc.root);
        this.peds.push({ ...lead, char: fc, umbrella: null, wantsUmbrella: lead.wantsUmbrella, routine: null, lead, lag: rnd(-0.1, 0.35),
          slot: size === 2 ? 0.26 : k === 1 ? 0.5 : -0.5, pause: Infinity, phone: null });
      }
    }
  }

  private updatePeds(dt: number, rain: boolean, animate: (ch: Character, dt: number) => void): void {
    // walkers on the lanes, bucketed per lane: spacing checks only look at people on the same lane
    const onLane = new Map<THREE.Vector3[], Ped[]>();
    for (const p of this.peds) {
      if (p.routine && p.routine.phase !== 'walking' && p.routine.phase !== 'headingBack') continue;
      const l = onLane.get(p.lane); if (l) l.push(p); else onLane.set(p.lane, [p]);
    }
    for (const p of this.peds) {
      const stopped = p.routine && this.updateStreetStop(p, p.routine, dt, rain);
      if (!stopped) this.walkPed(p, dt, onLane.get(p.lane) ?? []);
      const want = rain && p.wantsUmbrella;
      if (want && !p.umbrella) { p.umbrella = umbrella(pick(STREET_COLORS)); p.char.headSlot.add(p.umbrella); }
      if (p.umbrella) p.umbrella.visible = want;
      animate(p.char, dt);
    }
  }

  private walkPed(p: Ped, dt: number, mates: Ped[]): void {
    const L = p.lane.length, ch = p.char;
    let speed = p.speed;
    if (p.lead) { // group member: matches the leader's pace, beside it
      p.dir = p.lead.dir; speed = p.lead.cur;
      p.t = (p.lead.t - p.dir * p.lag + L) % L;
    } else {
      if (p.stopT > 0) { // a short stop: look in a window, check the phone
        p.stopT -= dt; speed = 0;
        if (p.stopT <= 0) { p.pause = rnd(20, 60); if (p.phone) p.phone.visible = false; }
      } else if ((p.pause -= dt) <= 0) {
        p.stopT = rnd(3, 7); speed = 0;
        p.stopAnim = p.phone && Math.random() < 0.7 ? 'phone' : 'idle';
        if (p.phone) p.phone.visible = p.stopAnim === 'phone';
      }
      // keep a gap behind a slower walker ahead in the same band (same lane only: ~a dozen checks, not n²)
      for (const o of mates) {
        if (speed === 0) break;
        if (o === p || o.lead === p || o.dir !== p.dir) continue;
        const gap = (((o.t - p.t) * p.dir) % L + L) % L;
        if (gap > 0.05 && gap < 1.4 && Math.abs(o.jit + o.slot - p.jit - p.slot) < 0.45) speed = Math.min(speed, gap < 0.9 ? o.cur * 0.6 : o.cur);
      }
      p.t = (p.t + p.dir * speed * dt + L) % L;
    }
    p.cur = speed;
    const i = Math.floor(p.t), f = p.t - i;
    const a = p.lane[i], b = p.lane[(i + 1) % L];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const side = p.dir * BAND + p.jit + p.slot * p.dir; // left of the walker: (uz, -ux) × dir
    ch.root.position.set(a.x + (b.x - a.x) * f + uz * side, 0, a.z + (b.z - a.z) * f - ux * side);
    let yaw = Math.atan2(ux * p.dir, uz * p.dir);
    if (speed < 0.05) yaw = p.lead ? Math.atan2(p.lead.char.root.position.x - ch.root.position.x, p.lead.char.root.position.z - ch.root.position.z)
      : Math.atan2(uz * p.dir, -ux * p.dir); // stopped: turn toward the shopfronts on the walker's side
    ch.root.rotation.y = turn(ch.root.rotation.y, yaw, dt * 8);
    ch.anim = speed >= 0.05 ? 'walk' : p.lead ? 'idle' : p.stopAnim; ch.speed = speed;
  }

  private updateStreetStop(p: Ped, r: StreetRoutine, dt: number, rain: boolean): boolean {
    const { spot, approach, kind } = r.stop;
    const ch = p.char;
    const shelterNeeded = rain && (kind === 'photo' || kind === 'bench');
    const onLane = p.lane[r.laneIndex];
    if (r.phase === 'walking') {
      r.time -= dt;
      if (r.time <= 0) { p.dir *= -1; r.phase = 'headingBack'; }
      return false;
    }
    if (r.phase === 'headingBack') {
      if (ch.root.position.distanceToSquared(onLane) > 0.20) return false;
      if (shelterNeeded) { r.phase = 'walking'; r.time = rnd(12, 20); return false; }
      r.phase = 'approach';
      r.path = [vs(approach), vs(spot)];
    }
    if (r.phase === 'stopped') {
      r.time -= dt;
      if (r.time > 0 && !shelterNeeded) {
        ch.root.rotation.y = turn(ch.root.rotation.y, spot.yaw, dt * 8);
        ch.speed = 0;
        ch.anim = kind === 'photo' && r.time % 4 > 2.7 ? 'idle' : STREET_POSES[kind];
        if (r.prop) r.prop.visible = ch.anim !== 'idle';
        return true;
      }
      r.phase = 'return';
      r.path = [vs(approach), onLane];
    }
    if (r.prop) r.prop.visible = false;
    ch.anim = 'walk';
    ch.speed = p.speed;
    if (walk(ch.root, r.path, p.speed, dt)) {
      if (r.phase === 'approach') {
        r.phase = 'stopped';
        r.time = rnd(8, 16);
      } else {
        p.t = r.laneIndex;
        p.dir *= -1;
        r.phase = 'walking';
        r.time = rnd(12, 20);
      }
    }
    return true;
  }

  // ------------------------------------------------------------ staff
  refresh(s: GameState): void {
    const want = s.staff.filter((e) => e.restaurant && this.sites.has(e.restaurant) && s.restaurants[e.restaurant]);
    const keyOf = (e: Employee) => `${e.id}:${e.restaurant}:${s.restaurants[e.restaurant!].uniform}:${e.role}:${s.restaurants[e.restaurant!].concept}`;
    const keys = new Set(want.map(keyOf));
    for (const st of this.staff.filter((x) => !keys.has(x.key))) { if (st.target) st.target.claimed = false; st.char.dispose(); }
    this.staff = this.staff.filter((x) => keys.has(x.key));
    const have = new Set(this.staff.map((x) => x.key));
    for (const e of want) {
      const key = keyOf(e);
      if (have.has(key)) continue;
      const site = this.sites.get(e.restaurant!)!.site;
      const r = s.restaurants[e.restaurant!];
      const a: Avatar = { ...e.look, faceStyle: e.look.faceStyle ?? e.id % FACE_STYLE_NAMES.length };
      let o: Outfit = {};
      if (e.role === 'chef') { a.shirt = r.uniform; a.headwear = 1; o = { cut: 'coat', apron: '#344654', trim: '#b9ad91' }; }
      else if (e.role === 'server') { a.shirt = r.uniform; a.headwear = 0; o = { vest: '#4d4339', apron: '#6e503f', trim: '#ac8d6b' }; }
      else { a.shirt = '#e9dfce'; a.pants = '#3e4149'; o = { cut: 'blazer', vest: '#393f4c', tie: '#944e42', glasses: 'square' }; }
      const ch = new Character(a, o);
      if (e.role === 'manager') ch.hands.add(clipboard());
      this.group.add(ch.root);
      const fresh = this.live && !this.posted.has(`${e.id}:${e.restaurant}`); // hire/transfer, not a uniform/concept rebuild
      this.staff.push({ e, key, siteId: e.restaurant!, char: ch, home: site.cleaner, path: [], target: null, ticketId: null, plate: null, timer: rnd(0, 3), anim: 'idle', enter: fresh ? [] : undefined });
    }
    this.posted = new Set(want.map((e) => `${e.id}:${e.restaurant}`));
    // home spots by index within role
    for (const rt of this.sites.values()) {
      const at = this.staff.filter((x) => x.siteId === rt.site.id);
      const chefs = at.filter((x) => x.e.role === 'chef'), srv = at.filter((x) => x.e.role === 'server');
      // more staff than work spots: extras still count in the sim but aren't rendered (no stacking)
      let spots = rt.site.chefs;
      if (s.restaurants[rt.site.id]?.concept === 'omakase' && rt.site.queue[0]) {
        // omakase: chefs work at the counter facing the guests
        const q = rt.site.queue[0];
        spots = [...spots].sort((a, b) => Math.hypot(a.x - q.x, a.z - q.z) - Math.hypot(b.x - q.x, b.z - q.z))
          .map((sp) => ({ x: sp.x, z: sp.z, yaw: Math.atan2(q.x - sp.x, q.z - sp.z) }));
      }
      chefs.forEach((x, i) => { x.home = spots[i % spots.length]; x.char.root.userData.hidden = i >= spots.length; });
      srv.forEach((x, i) => { x.home = rt.site.servers[i % rt.site.servers.length]; x.char.root.userData.hidden = i >= rt.site.servers.length; });
      for (const x of at) {
        if (x.e.role === 'manager') x.home = rt.site.manager;
        if (x.enter && !x.enter.length) { // newcomer: from the sidewalk, through the door, down the aisle to the station
          if (x.char.root.userData.hidden) x.enter = undefined;
          else {
            const door = vs(rt.site.door);
            x.enter = [...this.routes(door, 6).inR, ...(rt.site.queue[0] ? [vs(rt.site.queue[0])] : []), vs(x.home)];
            x.char.root.position.copy(x.enter.shift()!);
          }
        }
        if (!x.path.length && !x.target && !x.enter) { x.char.root.position.set(x.home.x, 0, x.home.z); x.char.root.rotation.y = x.home.yaw; }
      }
    }
  }

  private foh(siteId: string): Staff[] { return this.staff.filter((x) => x.siteId === siteId && (x.e.role === 'server' || x.e.role === 'manager')); }

  private updateStaff(dt: number, s: GameState, animate: (ch: Character, dt: number) => void): void {
    for (const st of this.staff) {
      const r = s.restaurants[st.siteId];
      if (!r) continue;
      const root = st.char.root;
      if (st.enter) {
        if (!walk(root, st.enter, 1.6, dt)) { st.char.anim = 'walk'; st.char.speed = 1.6; animate(st.char, dt); continue; }
        st.enter = undefined; // arrived: normal duties from this frame on
      }
      let anim: Anim = 'idle';
      if (st.e.role === 'chef') {
        root.position.set(st.home.x, 0, st.home.z);
        root.rotation.y = turn(root.rotation.y, st.home.yaw, dt * 6);
        if (r.orders.length) {
          anim = 'cook';
          if (root.position.distanceTo(this.playerPos) < 5) { this.chopT -= dt; if (this.chopT <= 0) { this.chopT = rnd(0.3, 0.5); audio.sfx('chop', 0.25); } }
        }
      } else {
        // server / manager: deliver ready food to waiting customers
        if (st.target) {
          const c = st.target;
          const gone = c.state === 'leave' || !r.ready.some((t) => t.id === st.ticketId);
          if (gone) { this.dropDelivery(st); }
          else {
            const cp = c.char.root.position;
            const dest = V(cp.x + Math.sin(c.char.root.rotation.y) * 0.75, cp.z + Math.cos(c.char.root.rotation.y) * 0.75);
            st.path = [dest];
            anim = 'carry';
            if (walk(root, st.path, 2.2, dt) || root.position.distanceTo(cp) < 0.95) {
              this.serve(s, c);
              this.dropDelivery(st);
            }
          }
        } else {
          const job = this.customers.find((c) => c.siteId === st.siteId && !c.claimed && c.state === 'waiting' && c.ticketId !== null && r.ready.some((t) => t.id === c.ticketId));
          if (job) {
            const t = r.ready.find((x) => x.id === job.ticketId)!;
            st.target = job; st.ticketId = job.ticketId; job.claimed = true;
            st.plate = makePlate(t.recipe, t.pieces); st.plate.scale.setScalar(1.3); st.char.hands.add(st.plate);
            anim = 'carry';
          } else {
            const home = vs(st.home);
            if (root.position.distanceTo(home) > 0.15) { st.path = [home]; walk(root, st.path, 2, dt); anim = 'walk'; }
            else root.rotation.y = turn(root.rotation.y, st.home.yaw, dt * 6);
            const rt = this.sites.get(st.siteId)!;
            const front = rt.queue[0];
            if (front && !front.path.length && front.orderTimer > 0.2) {
              anim = 'interact';
              const fp = front.char.root.position;
              root.rotation.y = turn(root.rotation.y, Math.atan2(fp.x - root.position.x, fp.z - root.position.z), dt * 6);
            }
          }
        }
      }
      st.char.anim = anim; st.char.speed = anim === 'walk' || anim === 'carry' ? 1.8 : 0;
      animate(st.char, dt);
    }
  }

  private dropDelivery(st: Staff): void {
    if (st.target) st.target.claimed = false;
    st.target = null; st.ticketId = null; st.path = [];
    if (st.plate) { st.plate.removeFromParent(); st.plate = null; }
  }

  // ------------------------------------------------------------ customers
  private activeSeats(s: GameState, siteId: string): number {
    const p = PROPERTIES[siteId];
    return Math.min(this.sites.get(siteId)!.site.seats.length, (p.kind === 'stand' ? 1 : 2) + 2 * (s.restaurants[siteId]?.upgrades.seats ?? 0));
  }

  private patienceFor(s: GameState, siteId: string, type: CustomerType): number {
    const u = s.restaurants[siteId].upgrades;
    return CUSTOMERS[type].patience * (1 + 0.15 * (u.register ?? 0) + 0.08 * (u.seats ?? 0));
  }

  /** Route along the nearest sidewalk lane into the door, and the matching exit route. */
  private routes(door: THREE.Vector3, approach: number): { inR: THREE.Vector3[]; outR: THREE.Vector3[] } {
    if (!this.lanes.length) {
      const e = this.d.edges.length ? vs(pick(this.d.edges)) : door.clone().add(V(20, 0));
      const e2 = this.d.edges.length ? vs(pick(this.d.edges)) : e;
      return { inR: [e, door.clone()], outR: [door.clone(), e2] };
    }
    let best = { lane: this.lanes[0], i: 0, d: Infinity };
    for (const lane of this.lanes) lane.forEach((p, i) => { const dd = p.distanceToSquared(door); if (dd < best.d) best = { lane, i, d: dd }; });
    const L = best.lane.length, dir = Math.random() < 0.5 ? 1 : -1;
    const seg = (from: number, n: number, dr: number) => Array.from({ length: n + 1 }, (_, k) => best.lane[((from + dr * k) % L + L) % L].clone());
    const inR = seg(best.i - dir * approach, approach, dir);
    inR.push(door.clone());
    const outR = [door.clone(), ...seg(best.i, 18, Math.random() < 0.5 ? 1 : -1)];
    return { inR, outR };
  }

  private spawnCustomer(s: GameState, rt: SiteRT): void {
    const siteId = rt.site.id;
    const type = sim.pickCustomerType(s, PROPERTIES[siteId].district, s.minute, siteId);
    const doorV = vs(rt.site.door);
    const order = sim.makeOrder(s, siteId, type);
    if (!order) return;
    const look = customerLook(type);
    const ch = new Character(look.a, look.o, rnd(0.93, 1.06));
    if (look.hand) ch.hands.add(look.hand);
    const bubble = new Bubble();
    ch.root.add(bubble.group);
    const { inR, outR } = this.routes(doorV, 11);
    ch.root.position.copy(inR[0]);
    this.group.add(ch.root);
    const c: Cust = {
      id: nextCustomerId++, type, siteId, char: ch, bubble, order, vip: type === 'vip',
      state: 'arrive', path: inR.slice(1), exit: outR, speed: rnd(1.3, 1.7),
      joinT: 0, patience: this.patienceFor(s, siteId, type), ticketId: null,
      seat: -1, stand: -1, orderTimer: 0, eatT: 0, reactT: 0, reactText: null, claimed: false, fade: 0,
      scale: ch.root.scale.x, faceYaw: null, plate: null, meal: null, carryProp: look.hand,
    };
    if (type === 'family') {
      const ca = baseAvatar(); ca.hairStyle = pick([0, 3]);
      c.child = new Character({ ...ca, faceStyle: 4 }, { cut: 'knit', bag: pick(STREET_COLORS), trim: '#e0cba3', child: true });
      c.child.root.position.copy(inR[0]).add(V(0.6, 0.4));
      this.group.add(c.child.root);
    }
    this.customers.push(c);
  }

  private takeOrder(s: GameState, rt: SiteRT, c: Cust): 'took' | 'none' {
    const ns = this.activeSeats(s, rt.site.id);
    const seat = concept(s, rt.site.id) === 'kiosk' ? -1 : rt.seats.findIndex((x, i) => i < ns && x === null);
    const stand = seat < 0 ? rt.stand.indexOf(null) : -1;
    if (seat < 0 && stand < 0) return 'none';
    c.ticketId = sim.acceptOrder(s, rt.site.id, { ...c.order, type: c.type, customerId: c.id }).id;
    rt.queue = rt.queue.filter((x) => x !== c);
    this.reflowQueue(rt);
    if (seat >= 0) {
      rt.seats[seat] = c;
      c.seat = seat;
      const sp = rt.site.seats[seat], { approach } = rt.site.dining[seat];
      c.path = [aisle(rt.site, approach), approach, vs(sp)];
      c.faceYaw = sp.yaw;
    } else {
      rt.stand[stand] = c;
      c.stand = stand;
      const sp = rt.standSpots[stand];
      c.path = [vs(sp)]; c.faceYaw = sp.yaw;
    }
    c.state = 'toSpot';
    return 'took';
  }

  private reflowQueue(rt: SiteRT): void {
    rt.queue.forEach((c, i) => {
      const spot = rt.site.queue[i];
      const target = vs(spot);
      const previous = c.path[c.path.length - 1] ?? c.char.root.position;
      if (previous.distanceToSquared(target) > 0.001) {
        c.path = [target];
        c.orderTimer = 0;
      }
      c.faceYaw = spot.yaw;
    });
  }

  private freeSlots(c: Cust): void {
    const rt = this.sites.get(c.siteId);
    if (!rt) return;
    if (rt.queue.includes(c)) { rt.queue = rt.queue.filter((x) => x !== c); this.reflowQueue(rt); }
    if (c.seat >= 0 && rt.seats[c.seat] === c) rt.seats[c.seat] = null;
    if (c.stand >= 0 && rt.stand[c.stand] === c) rt.stand[c.stand] = null;
    c.seat = -1; c.stand = -1;
  }

  private leave(c: Cust, reaction: string | null): void {
    const rt = this.sites.get(c.siteId);
    const here = c.char.root.position;
    const approach = c.seat >= 0 && rt?.site.dining[c.seat].approach;
    const exitAisle = approach && (c.state !== 'toSpot' || c.path.length === 1) ? approach : here;
    this.freeSlots(c);
    c.state = 'leave'; c.faceYaw = null;
    c.path = rt ? [...(exitAisle !== here ? [exitAisle] : []), aisle(rt.site, exitAisle), ...c.exit] : [...c.exit];
    if (reaction) { c.reactText = reaction; c.reactT = 2.5; }
  }

  private serve(s: GameState, c: Cust): boolean {
    if (c.ticketId === null) return false;
    const rt = this.sites.get(c.siteId)!;
    const res = sim.settle(s, c.siteId, c.ticketId, s.clock - c.joinT);
    if (!res) return false;
    const p = c.char.root.position;
    emit('money', { amount: res.paid + res.tip, x: p.x, y: 2.2, z: p.z });
    c.reactText = res.satisfaction > 0.82 ? 'This looks wonderful.' : res.satisfaction > 0.62 ? 'Thank you!' : 'Thanks.';
    c.reactT = 2.5;
    c.ticketId = null;
    if (c.seat >= 0) {
      const plate = makePlate(c.order.recipe, c.order.pieces);
      plate.scale.setScalar(0.72);
      c.plate = plate;
      if (c.state === 'waiting') this.startMeal(c, rt, concept(s, c.siteId));
    } else {
      c.plate = takeoutBag();
      if (c.carryProp) c.carryProp.visible = false;
      c.char.hands.add(c.plate);
      this.leave(c, null);
    }
    return true;
  }

  private startMeal(c: Cust, rt: SiteRT, format: string): void {
    const plate = c.plate!;
    plate.position.copy(rt.site.dining[c.seat].plate);
    plate.rotation.y = rt.site.seats[c.seat].yaw;
    c.char.eatingAtCounter = plate.position.y > 1;
    this.group.add(plate);
    const sticks = chopsticks();
    c.char.rightGrip.add(sticks);
    if (c.carryProp) c.carryProp.visible = false;
    const food = plate.children.slice(1);
    const interval = format === 'omakase' ? Math.max(2.3, 16 / food.length) : rnd(1.6, 2.0);
    c.meal = { sticks, food, bite: interval * 0.72, interval, stack: 0 };
    c.eatT = interval * food.length + 3;
    c.state = 'eating';
  }

  private eat(c: Cust, dt: number, kaiten: boolean): void {
    const meal = c.meal!;
    meal.bite -= dt;
    if (meal.food.length && meal.bite <= 0) {
      meal.food.shift()!.visible = false;
      meal.bite += meal.interval;
      if (kaiten && meal.food.length > 0 && meal.food.length % 2 === 0) {
        // Empty plates stay on the table alongside the remaining food.
        const empty = new THREE.Mesh(EMPTY_PLATE, propMat(pick(['#a63f46', '#426481', '#4a7c70'])));
        empty.position.set(0.37, 0.018 + meal.stack++ * 0.027, 0);
        c.plate!.add(empty);
      }
    }
    c.char.bite = Math.max(0, 1 - Math.abs(meal.bite - meal.interval + 0.18) / 0.44);
    c.eatT -= dt;
    if (c.eatT > 0) return;
    meal.sticks.removeFromParent();
    c.meal = null;
    c.plate!.removeFromParent();
    c.plate = null;
    this.leave(c, null);
  }

  private updateCustomers(dt: number, s: GameState, running: boolean, animate: (ch: Character, dt: number) => void): void {
    for (const c of [...this.customers]) {
      const root = c.char.root;
      const rt = this.sites.get(c.siteId)!;
      const r = s.restaurants[c.siteId];
      // fade in / out
      c.fade = Math.min(1, c.fade + dt * 2.5);
      let moving = false;
      if (c.path.length) { moving = !walk(root, c.path, c.speed, dt); }
      if (!c.path.length && c.faceYaw !== null) root.rotation.y = turn(root.rotation.y, c.faceYaw, dt * 8);

      if (running && r && !c.plate && c.state !== 'leave' && c.state !== 'eating' && c.state !== 'arrive') {
        if (s.clock - c.joinT > c.patience) sim.customerLeft(s, c.siteId, c.type, c.id, 'patience');
        else if (c.ticketId !== null && !r.orders.some((t) => t.id === c.ticketId) && !r.ready.some((t) => t.id === c.ticketId)) this.leave(c, 'I’ll try again next time.');
      }
      if (c.state === 'arrive' && !c.path.length) {
        if (!r || !sim.isOpen(s.minute) || rt.queue.length >= rt.site.queue.length) this.leave(c, null);
        else { rt.queue.push(c); c.state = 'queue'; c.joinT = s.clock; this.reflowQueue(rt); }
      }
      if (c.state === 'queue' && rt.queue[0] === c && !c.path.length && running && r) {
        c.orderTimer += dt;
        // no server or manager: a chef steps over from the kitchen, slower
        const delay = 2.5 / (1 + 0.3 * (r.upgrades.register ?? 0)) * (this.foh(c.siteId).length ? 1 : 2);
        if (sim.isAutomated(s, c.siteId) && c.orderTimer > delay) this.takeOrder(s, rt, c);
      }
      if (c.state === 'queue' && running && !sim.isOpen(s.minute)) sim.customerLeft(s, c.siteId, c.type, c.id, 'closed');
      // no front-of-house to carry it over: the chef hands the food across the counter
      if (c.state === 'waiting' && running && r && c.ticketId !== null && !this.foh(c.siteId).length && r.ready.some((t) => t.id === c.ticketId)) this.serve(s, c);
      if (c.state === 'toSpot' && !c.path.length) {
        c.state = 'waiting';
        if (c.carryProp && c.seat >= 0) c.carryProp.visible = false;
        if (c.plate) this.startMeal(c, rt, concept(s, c.siteId));
      }
      if (c.state === 'eating') this.eat(c, dt, concept(s, c.siteId) === 'kaiten');
      // animation
      let anim: Anim = moving ? 'walk' : 'idle';
      if (!moving && c.seat >= 0 && (c.state === 'waiting' || c.state === 'eating')) anim = c.state === 'eating' && c.eatT > 2.8 ? 'eat' : 'sit';
      if (c.plate && moving && c.state === 'leave') anim = 'carry';
      c.char.anim = anim; c.char.speed = moving ? c.speed : 0;
      // bubble
      c.reactT -= dt;
      const near = root.position.distanceToSquared(this.playerPos) < 28 * 28;
      if (!near) c.bubble.set(null);
      else if (c.reactT > 0 && c.reactText) c.bubble.set(c.reactText, null, '#ffd23f');
      else if (c.state === 'queue' && rt.queue[0] === c && !c.path.length) {
        c.bubble.set(`${c.order.pieces} × ${RECIPES[c.order.recipe].name}, please.`, 1 - (s.clock - c.joinT) / c.patience, c.vip ? '#c9a227' : '#ff6b6b');
      } else if (c.state === 'waiting' && c.ticketId !== null && r?.ready.some((t) => t.id === c.ticketId)) {
        c.bubble.set('Order ready', 1 - (s.clock - c.joinT) / c.patience, '#5ad16b');
      } else c.bubble.set(null);
      // despawn
      if (c.state === 'leave' && !c.path.length) { c.fade = -1; }
      const sc = c.fade < 0 ? 0 : Math.min(1, c.fade);
      root.scale.setScalar(c.scale * Math.max(0.001, sc));
      if (c.fade < 0) { this.remove(c); continue; }
      animate(c.char, dt);
      if (c.child) {
        const ch = c.child.root;
        const behind = root.position.clone().add(V(Math.cos(root.rotation.y) * 0.6 - Math.sin(root.rotation.y) * 0.5, -Math.sin(root.rotation.y) * 0.6 - Math.cos(root.rotation.y) * 0.5));
        const dd = ch.position.distanceTo(behind);
        const cm = dd > 0.12;
        if (cm) walk(ch, [behind], Math.max(c.speed, dd * 2), dt);
        ch.rotation.y = cm ? ch.rotation.y : turn(ch.rotation.y, root.rotation.y, dt * 6);
        ch.scale.setScalar(0.62 * Math.max(0.001, sc));
        c.child.anim = cm ? 'walk' : 'idle';
        c.child.speed = cm ? 1.5 : 0;
        animate(c.child, dt);
      }
    }
  }

  private remove(c: Cust): void {
    this.freeSlots(c);
    c.plate?.removeFromParent();
    c.bubble.dispose(); c.char.dispose(); c.child?.dispose();
    this.customers = this.customers.filter((x) => x !== c);
  }

  private updateSpawns(dt: number, s: GameState): void {
    const open = sim.isOpen(s.minute);
    for (const rt of this.sites.values()) {
      const id = rt.site.id;
      if (!s.restaurants[id] || !open) continue;
      const here = this.customers.filter((c) => c.siteId === id && c.state !== 'leave');
      rt.spawnAcc += sim.visibleSpawnPerMin(s, id) * dt / 60;
      if (rt.spawnAcc < 1) continue;
      rt.spawnAcc -= 1;
      const cap = rt.site.queue.length + this.activeSeats(s, id) + 3;
      if (here.length >= cap || this.charCount() - this.staff.length >= MAX_CHARS) continue; // staff don't crowd out customers
      this.spawnCustomer(s, rt);
    }
  }

  private updatePlates(s: GameState): void {
    for (const rt of this.sites.values()) {
      const r = s.restaurants[rt.site.id];
      if (!r) continue;
      const hasFoh = this.foh(rt.site.id).length > 0;
      const playerFar = this.playerPos.distanceTo(vs(rt.site.counter)) > 6;
      const show = r.ready.filter((t) => {
        if (t.customerId === null) return false;
        const c = this.customers.find((x) => x.id === t.customerId);
        return c && !c.claimed && (hasFoh || playerFar);
      }).slice(0, 4);
      const key = show.map((t) => t.id).join(',');
      if (key === rt.plateKey) continue;
      rt.plateKey = key;
      for (const p of rt.plates.values()) p.removeFromParent();
      rt.plates.clear();
      const y = rt.site.counter.yaw, ax = Math.cos(y), az = -Math.sin(y);
      show.forEach((t, i) => {
        const p = makePlate(t.recipe, t.pieces);
        const off = (i - (show.length - 1) / 2) * 0.5;
        p.position.copy(rt.site.counterTop).add(new THREE.Vector3(ax * off, 0, az * off));
        p.rotation.y = y;
        this.group.add(p);
        rt.plates.set(t.id, p);
      });
    }
  }

  // ------------------------------------------------------------ ghost-kitchen delivery riders (visual only)
  private riders: Rider[] = [];
  private riderAcc = new Map<string, { last: number; acc: number }>();

  private updateRiders(dt: number, s: GameState, running: boolean, animate: (ch: Character, dt: number) => void): void {
    if (running) for (const rt of this.sites.values()) {
      const r = s.restaurants[rt.site.id];
      if (!r || r.concept !== 'ghost') continue;
      const st = this.riderAcc.get(rt.site.id) ?? { last: r.day.pieces, acc: 0 };
      st.acc += Math.max(0, r.day.pieces - st.last); // day rollover resets pieces → negative delta ignored
      st.last = r.day.pieces;
      this.riderAcc.set(rt.site.id, st);
      // one rider per ~6 pieces delivered, at most 3 waiting per kitchen
      if (st.acc >= 6 && this.riders.filter((x) => x.siteId === rt.site.id).length < 3 && this.charCount() < MAX_CHARS) {
        st.acc -= 6;
        this.spawnRider(rt);
      }
      if (st.acc > 30) st.acc = 30; // don't build an endless backlog of riders
    }
    for (const rd of [...this.riders]) {
      const root = rd.char.root;
      rd.t -= dt;
      if (rd.state === 'ride' || rd.state === 'leave') {
        const done = walk(rd.scooter, rd.path, 6, dt);
        root.position.copy(rd.scooter.position); root.rotation.y = rd.scooter.rotation.y;
        rd.char.anim = 'sit'; rd.char.speed = 0;
        if (done && rd.state === 'ride') { rd.state = 'walkIn'; rd.path = [vs(rd.pickup)]; }
        else if (done) { this.removeRider(rd); continue; }
      } else if (rd.state === 'walkIn' || rd.state === 'walkOut') {
        const done = walk(root, rd.path, 1.8, dt);
        rd.char.anim = rd.state === 'walkOut' ? 'carry' : 'walk'; rd.char.speed = 1.8;
        if (done && rd.state === 'walkIn') { rd.state = 'wait'; rd.t = rnd(1.5, 3.5); }
        else if (done) { rd.state = 'leave'; rd.path = rd.exit.slice(); }
      } else {
        rd.char.anim = 'idle'; rd.char.speed = 0;
        root.rotation.y = turn(root.rotation.y, rd.pickup.yaw, dt * 6);
        if (rd.t <= 0) { rd.char.hands.add(takeoutBag()); rd.state = 'walkOut'; rd.path = [rd.park.clone()]; }
      }
      animate(rd.char, dt);
    }
  }

  private spawnRider(rt: SiteRT): void {
    const door = vs(rt.site.door);
    const { inR, outR } = this.routes(door, 24);
    const a = baseAvatar(); a.headwear = 3; a.shirt = pick(['#2a9d8f', '#e76f51', '#f4a261', '#264653']);
    const ch = new Character(a, { bag: '#e63946' });
    const scooter = makeScooter();
    scooter.position.copy(inR[0]);
    this.group.add(ch.root, scooter);
    const pickup = rt.site.queue[0] ?? rt.site.door;
    this.riders.push({ siteId: rt.site.id, char: ch, scooter, state: 'ride', path: inR.slice(1), exit: outR.slice(1), park: door, pickup, t: 0 });
  }

  private removeRider(rd: Rider): void {
    rd.char.dispose(); rd.scooter.removeFromParent();
    this.riders = this.riders.filter((x) => x !== rd);
  }

  // ------------------------------------------------------------ public API
  /** Spawn/move pedestrians, customers (using sim.visibleSpawnPerMin), staff and story NPCs. */
  update(dt: number, s: GameState, playerPos: THREE.Vector3, _night: number): void {
    this.playerPos.copy(playerPos);
    this.frameNo++;
    const running = s.clock !== this.lastClock; // sim is ticking (not on title screen)
    this.lastClock = s.clock;
    const fn = this.frameNo;
    // LOD: far characters animate at 1/4 rate
    const animate = (ch: Character, d: number) => {
      const d2 = ch.root.position.distanceToSquared(playerPos);
      ch.setShadow(d2 < 22 * 22); // distant characters skip the shadow pass (big draw-call saving)
      ch.setLod(d2 > 20 * 20); // low-poly model beyond 20 m
      ch.root.visible = d2 < 55 * 55 && !ch.root.userData.hidden; // far (fog) or overflow staff: skip render + projection
      const far = d2 > 45 * 45;
      if (!far) ch.update(d);
      else if ((fn + (ch.root.id & 3)) % 4 === 0) ch.update(d * 4);
    };
    // time speed (up to 4×) can hand us large dt: sub-step movement/state, animate once with the full dt
    const steps = Math.max(1, Math.ceil(dt / 0.06)), h = dt / steps;
    const noop = () => {};
    for (let i = 0; i < steps; i++) {
      const an = i === steps - 1 ? (ch: Character) => animate(ch, dt) : noop;
      if (running) this.updateSpawns(h, s);
      this.updateCustomers(h, s, running, an);
      this.updateStaff(h, s, an);
      this.updatePeds(h, s.event?.id === 'rain', an);
      this.updateRiders(h, s, running, an);
    }
    this.updatePlates(s);
    for (const st of this.story) {
      const root = st.char.root;
      const dd = root.position.distanceTo(playerPos);
      const near = dd < 4;
      if (near && !st.near) st.wave = 2;
      st.near = near;
      st.wave -= dt;
      const yaw = near ? Math.atan2(playerPos.x - root.position.x, playerPos.z - root.position.z) : st.spot.yaw;
      root.rotation.y = turn(root.rotation.y, yaw, dt * 5);
      st.char.anim = st.wave > 0 ? 'wave' : 'idle';
      animate(st.char, dt);
    }
  }

  dispose(): void {
    this.unsub.forEach((u) => u());
    for (const c of this.customers) { c.bubble.dispose(); c.char.dispose(); c.child?.dispose(); }
    for (const x of [...this.staff, ...this.peds, ...this.story]) x.char.dispose();
    for (const rd of this.riders) rd.char.dispose();
    this.riders = [];
    this.group.removeFromParent();
    this.customers = []; this.staff = []; this.peds = []; this.story = [];
  }
}

// ---------------------------------------------------------------- helpers
const concept = (s: GameState, id: string) => s.restaurants[id]?.concept ?? 'bar';
const EMPTY_PLATE = new THREE.CylinderGeometry(0.17, 0.14, 0.025, 16);
const BAG_GEO = new THREE.BoxGeometry(0.26, 0.22, 0.16);
const BAG_MAT = new THREE.MeshStandardMaterial({ color: '#c8a27a', roughness: 0.9 });
function takeoutBag(): THREE.Object3D { const m = new THREE.Mesh(BAG_GEO, BAG_MAT); m.position.y = -0.05; return m; }

const SCOOTER_MATS = { body: new THREE.MeshStandardMaterial({ color: '#e63946', roughness: 0.5 }), dark: new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.8 }), box: new THREE.MeshStandardMaterial({ color: '#ffd166', roughness: 0.6 }) };
const SCOOTER_GEO = { body: new THREE.BoxGeometry(0.32, 0.25, 1.1), wheel: new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), box: new THREE.BoxGeometry(0.42, 0.38, 0.42), bar: new THREE.BoxGeometry(0.05, 0.6, 0.05) };
/** Delivery scooter facing +z; the rider sits at ~0.45m. Shared geometry → cheap. */
function makeScooter(): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.z = rz; m.castShadow = true; g.add(m); };
  add(SCOOTER_GEO.body, SCOOTER_MATS.body, 0, 0.3, 0);
  add(SCOOTER_GEO.wheel, SCOOTER_MATS.dark, 0, 0.2, 0.45, Math.PI / 2);
  add(SCOOTER_GEO.wheel, SCOOTER_MATS.dark, 0, 0.2, -0.45, Math.PI / 2);
  add(SCOOTER_GEO.bar, SCOOTER_MATS.dark, 0, 0.7, 0.48);
  add(SCOOTER_GEO.box, SCOOTER_MATS.box, 0, 0.72, -0.42);
  return g;
}
/** Closest point on the door→queue aisle line (keeps guests from walking through front walls). */
function aisle(site: RestaurantSite, p: THREE.Vector3): THREE.Vector3 {
  const a = vs(site.door), b = site.queue[0] ? vs(site.queue[0]) : a;
  const ab = b.clone().sub(a), L2 = ab.lengthSq();
  if (L2 < 1e-6) return a;
  const t = Math.max(0, Math.min(1.3, p.clone().sub(a).dot(ab) / L2));
  return a.add(ab.multiplyScalar(t));
}
function turn(cur: number, target: number, k: number): number {
  let d = target - cur; d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + d * Math.min(1, k);
}

/** Move root along path; returns true when the path is finished. */
function walk(root: THREE.Object3D, path: THREE.Vector3[], speed: number, dt: number): boolean {
  let step = speed * dt;
  while (path.length && step > 0) {
    const p = path[0];
    const dx = p.x - root.position.x, dz = p.z - root.position.z, dist = Math.hypot(dx, dz);
    if (dist <= step) { root.position.x = p.x; root.position.z = p.z; step -= dist; path.shift(); continue; }
    root.position.x += (dx / dist) * step; root.position.z += (dz / dist) * step;
    root.rotation.y = turn(root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 10));
    step = 0;
  }
  root.position.y = 0;
  return path.length === 0;
}

function streetAccess(lanes: THREE.Vector3[][], stop: StreetStop, world: World): { lane: THREE.Vector3[]; i: number } | undefined {
  const approach = vs(stop.approach);
  const sample = new THREE.Vector3();
  let best = 22 * 22;
  let route: { lane: THREE.Vector3[]; i: number } | undefined;
  for (const lane of lanes) lane.forEach((from, i) => {
    const d2 = approach.distanceToSquared(from);
    if (d2 >= best) return;
    const steps = Math.max(1, Math.ceil(Math.sqrt(d2) / 0.3));
    for (let j = 0; j <= steps; j++) {
      if (world.overlaps(sample.lerpVectors(from, approach, j / steps), 0.18)) return;
    }
    best = d2;
    route = { lane, i };
  });
  return route;
}

function densify(loop: THREE.Vector3[], spacing: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const n = Math.max(1, Math.round(a.distanceTo(b) / spacing));
    for (let k = 0; k < n; k++) out.push(new THREE.Vector3(a.x + (b.x - a.x) * (k / n), 0, a.z + (b.z - a.z) * (k / n)));
  }
  return out;
}

/** Standing wait spots beside the front of the queue (guests without a seat wait here). */
function standSpots(site: RestaurantSite): Spot[] {
  const q = site.queue[0];
  if (!q) return [];
  const fx = Math.sin(q.yaw), fz = Math.cos(q.yaw), rx = Math.cos(q.yaw), rz = -Math.sin(q.yaw);
  return [1.3, -1.3, 2.0, -2.0, 2.7, -2.7].map((o) => ({ x: q.x + rx * o - fx * 0.5, z: q.z + rz * o - fz * 0.5, yaw: q.yaw }));
}

function storyAvatar(id: string): Avatar {
  switch (id) {
    case 'kenji': return { skin: '#d5a47a', hair: '#ccc1ad', hairStyle: 4, shirt: '#5a6e78', pants: '#393b42', headwear: 2, faceStyle: 4 };
    case 'mika': return { skin: '#e5b292', hair: '#432b2a', hairStyle: 6, shirt: '#507d7b', pants: '#465359', headwear: 0, faceStyle: 3 };
    case 'sato': return { skin: '#c49370', hair: '#2e2b30', hairStyle: 8, shirt: '#ddd5c4', pants: '#373e48', headwear: 0, faceStyle: 1 };
    case 'ryo': return { skin: '#b88159', hair: '#292226', hairStyle: 3, shirt: '#93463b', pants: '#3e3637', headwear: 0, faceStyle: 2 };
    default: return { skin: '#ead2b5', hair: '#67626a', hairStyle: 5, shirt: '#cdb392', pants: '#38313d', headwear: 0, faceStyle: 0 };
  }
}

function storyOutfit(id: string): Outfit {
  switch (id) {
    case 'kenji': return { cut: 'coat', apron: '#394956', trim: '#a7a18d', detail: 'moustache' };
    case 'mika': return { cut: 'workwear', vest: '#5b7876', apron: '#b87848', trim: '#ce9b67', detail: 'freckles' };
    case 'sato': return { cut: 'blazer', vest: '#3e4d59', tie: '#86976f', glasses: 'square' };
    case 'ryo': return { cut: 'coat', apron: '#54403a', trim: '#c87f56', detail: 'stubble' };
    default: return { cut: 'blazer', vest: '#584456', trim: '#ba936e', glasses: 'round', detail: 'earrings' };
  }
}
