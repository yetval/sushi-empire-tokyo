// NPCs: walk-in customers (full lifecycle), staff, pedestrians and story characters.
// All money/pieces flow through core/sim (acceptOrder / settle / customerLeft) — this file only animates.
import * as THREE from 'three';
import { audio } from '../audio/audio';
import { emit, on } from '../core/bus';
import { CUSTOMERS, CustomerType, DISTRICTS, PROPERTIES, RECIPES } from '../core/data';
import * as sim from '../core/sim';
import { Avatar, Employee, GameState } from '../core/state';
import { Anim, Character, FACE_STYLE_NAMES, Outfit } from '../engine/character';
import { makePlate } from '../world/sushi';
import { DistrictScene, RestaurantSite, Spot } from '../world/types';
import { Bubble } from './bubble';

export interface OrderView { emoji: string; recipe: string; pieces: number; status: 'ordering' | 'waiting' | 'ready'; patience: number; vip: boolean }

const MAX_CHARS = 70;
const V = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const vs = (sp: Spot) => V(sp.x, sp.z);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const SKINS = ['#f1c27d', '#e0ac69', '#ffdbac', '#c68642', '#8d5524', '#f5d0b0'];
const HAIRS = ['#1b1b1b', '#2b1d14', '#5a3825', '#a0522d', '#d4a373', '#7b7b7b', '#3d2b56', '#c0392b'];
const STREET_COLORS = ['#b75e50', '#367876', '#c2a466', '#5e658e', '#9a5971', '#78937a', '#6686a1', '#b88670'];
const PANTS = ['#2d3142', '#3d405b', '#5c4b51', '#283845', '#6d6875', '#1e3d59', '#7f8c8d'];
const STORY_HEIGHT: Record<string, number> = { kenji: 0.9, mika: 0.96, sato: 1.07, ryo: 1.04, aoki: 0.99 };

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
function customerLook(type: CustomerType): { a: Avatar; o: Outfit; hand?: THREE.Object3D } {
  const a = baseAvatar();
  switch (type) {
    case 'office':
      a.shirt = pick(['#e6dccb', '#c2ccd0', '#e0c9c2']);
      a.pants = '#3a4149';
      a.hairStyle = pick([0, 5, 8]);
      return { a, o: { cut: 'blazer', vest: pick(['#344354', '#534b47', '#424650']), tie: pick(['#934b48', '#537670', '#826b4b']), glasses: pick(['square', undefined, undefined]) } };
    case 'student':
      a.shirt = '#dfd8bd';
      a.pants = '#323a4c';
      a.hairStyle = pick([1, 5, 6, 7]);
      return { a, o: { cut: 'workwear', vest: pick(['#41556b', '#496457', '#685457']), trim: '#aaa388', bag: pick(['#a1664b', '#54677c', '#796e4c']) } };
    case 'tourist':
      a.headwear = pick([0, 3, 3]);
      a.pants = '#ae9676';
      return { a, o: { cut: 'workwear', vest: pick(['#586f5d', '#aa7551', '#585476']), trim: '#c2aa78', bag: '#5a473a', detail: 'freckles' }, hand: camera() };
    case 'family':
      return { a, o: { cut: 'knit', trim: pick(['#bab18b', '#d2af94', '#c8c4b0']) } };
    case 'foodie':
      a.shirt = pick(['#927350', '#437473', '#795675']);
      return { a, o: { cut: 'knit', trim: '#d3a67b', detail: pick(['freckles', 'earrings', 'stubble']) } };
    case 'wealthy':
      a.shirt = '#e9dfd2';
      a.pants = '#32343d';
      a.hairStyle = pick([3, 5, 8]);
      return { a, o: { cut: 'blazer', vest: pick(['#38453d', '#524252', '#263948']), tie: '#ba8d56', glasses: pick(['round', undefined]), detail: 'earrings' } };
    case 'influencer':
      a.shirt = pick(['#c77d83', '#9d6e8a', '#708092']);
      a.hairStyle = pick([2, 5, 6]);
      a.hair = pick(['#c9936c', '#74405a', '#231e21']);
      return { a, o: { cut: 'knit', trim: '#e7cabd', detail: 'earrings' }, hand: phone() };
    case 'critic':
      a.shirt = '#d7c2ac';
      a.pants = '#383449';
      a.hairStyle = 3;
      a.hair = '#78716d';
      a.faceStyle = 1;
      return { a, o: { cut: 'blazer', vest: '#48405b', glasses: 'square', detail: 'earrings' }, hand: notepad() };
    case 'vip':
      a.shirt = '#e8dbc4';
      a.pants = '#3d3c51';
      a.hairStyle = 8;
      return { a, o: { cut: 'blazer', vest: '#422e3e', tie: '#b98a51', glasses: 'round', trim: '#cead70' } };
  }
}

// ---------------------------------------------------------------- types
type CState = 'arrive' | 'queue' | 'toSpot' | 'waiting' | 'eating' | 'leave';

interface Cust {
  id: number; type: CustomerType; siteId: string; char: Character; bubble: Bubble; child?: Character;
  order: { recipe: string; pieces: number }; vip: boolean; tutorial: boolean;
  state: CState; path: THREE.Vector3[]; exit: THREE.Vector3[]; speed: number;
  joinT: number; patience: number; ticketId: number | null;
  seat: number; stand: number; orderTimer: number; eatT: number; reactT: number; reactText: string | null;
  claimed: boolean; fade: number; faceYaw: number | null; sitting: boolean; plate: THREE.Object3D | null;
  stack: number; stackT: number; // kaiten: empty plates piling up while eating
}

interface SiteRT {
  site: RestaurantSite; queue: Cust[]; seats: (Cust | null)[]; stand: (Cust | null)[]; standSpots: Spot[];
  spawnAcc: number; tutorialCd: number; plates: Map<number, THREE.Object3D>; plateKey: string;
}

interface Staff {
  e: Employee; key: string; siteId: string; char: Character; home: Spot;
  path: THREE.Vector3[]; target: Cust | null; ticketId: number | null; plate: THREE.Object3D | null; timer: number; anim: Anim;
}

interface Rider {
  siteId: string; char: Character; scooter: THREE.Group; state: 'ride' | 'walkIn' | 'wait' | 'walkOut' | 'leave';
  path: THREE.Vector3[]; exit: THREE.Vector3[]; park: THREE.Vector3; pickup: Spot; t: number;
}

interface Ped { char: Character; lane: THREE.Vector3[]; t: number; dir: number; speed: number; umbrella: THREE.Object3D | null; wantsUmbrella: boolean }
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

  constructor(scene: THREE.Scene, private d: DistrictScene, s: GameState) {
    scene.add(this.group);
    this.lanes = d.walkPaths.filter((p) => p.length > 1).map((p) => densify(p, 1));
    for (const site of d.sites) this.sites.set(site.id, {
      site, queue: [], seats: site.seats.map(() => null), standSpots: standSpots(site), stand: [], spawnAcc: Math.random(),
      tutorialCd: 1.5, plates: new Map(), plateKey: '',
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
      if (c && c.state !== 'leave') this.leave(c, e.reason === 'patience' ? '💢' : e.reason === 'nostock' ? '😞 Sold out!' : '🌙');
    }));
    this.refresh(s);
  }

  private charCount(): number { return this.customers.length + this.customers.filter((c) => c.child).length + this.peds.length + this.staff.length + this.story.length + this.riders.length; }

  // ------------------------------------------------------------ pedestrians
  private spawnPeds(s: GameState): void {
    if (!this.lanes.length) return;
    const q = s.settings.quality === 'low' ? 0.5 : s.settings.quality === 'medium' ? 0.75 : 1;
    const n = Math.round(Math.max(12, Math.min(30, 10 + DISTRICTS[this.d.id].traffic * 3.5)) * q);
    for (let i = 0; i < n; i++) {
      const lane = pick(this.lanes);
      const type = pick(['office', 'student', 'tourist', 'family', 'foodie', 'wealthy'] as CustomerType[]);
      const look = customerLook(type);
      const ch = new Character(look.a, look.o, rnd(0.91, 1.07));
      if (look.hand) ch.hands.add(look.hand);
      this.group.add(ch.root);
      this.peds.push({ char: ch, lane, t: Math.random() * lane.length, dir: Math.random() < 0.5 ? 1 : -1, speed: rnd(0.9, 1.6), umbrella: null, wantsUmbrella: Math.random() < 0.7 });
    }
  }

  private updatePeds(dt: number, rain: boolean, animate: (ch: Character, dt: number) => void): void {
    for (const p of this.peds) {
      const L = p.lane.length;
      p.t = (p.t + p.dir * p.speed * dt + L) % L;
      const i = Math.floor(p.t), f = p.t - i;
      const a = p.lane[i], b = p.lane[(i + 1) % L];
      p.char.root.position.set(a.x + (b.x - a.x) * f, 0, a.z + (b.z - a.z) * f);
      const dx = (b.x - a.x) * p.dir, dz = (b.z - a.z) * p.dir;
      if (dx * dx + dz * dz > 1e-6) p.char.root.rotation.y = turn(p.char.root.rotation.y, Math.atan2(dx, dz), dt * 8);
      p.char.anim = 'walk'; p.char.speed = p.speed;
      const want = rain && p.wantsUmbrella;
      if (want && !p.umbrella) { p.umbrella = umbrella(pick(STREET_COLORS)); p.char.headSlot.add(p.umbrella); }
      if (p.umbrella) p.umbrella.visible = want;
      animate(p.char, dt);
    }
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
      else if (e.role === 'cleaner') { a.shirt = '#799b91'; a.headwear = 3; o = { cut: 'workwear', vest: '#49685d', trim: '#92ab90' }; }
      else { a.shirt = '#e9dfce'; a.pants = '#3e4149'; o = { cut: 'blazer', vest: '#393f4c', tie: '#944e42', glasses: 'square' }; }
      const ch = new Character(a, o);
      if (e.role === 'manager') ch.hands.add(clipboard());
      this.group.add(ch.root);
      this.staff.push({ e, key, siteId: e.restaurant!, char: ch, home: site.cleaner, path: [], target: null, ticketId: null, plate: null, timer: rnd(0, 3), anim: 'idle' });
    }
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
        if (x.e.role === 'cleaner') x.home = rt.site.cleaner;
        if (!x.path.length && !x.target) { x.char.root.position.set(x.home.x, 0, x.home.z); x.char.root.rotation.y = x.home.yaw; }
      }
    }
  }

  private foh(siteId: string): Staff[] { return this.staff.filter((x) => x.siteId === siteId && (x.e.role === 'server' || x.e.role === 'manager')); }

  private updateStaff(dt: number, s: GameState, animate: (ch: Character, dt: number) => void): void {
    for (const st of this.staff) {
      const r = s.restaurants[st.siteId];
      if (!r) continue;
      const root = st.char.root;
      let anim: Anim = 'idle';
      if (st.e.role === 'chef') {
        root.position.set(st.home.x, 0, st.home.z);
        root.rotation.y = turn(root.rotation.y, st.home.yaw, dt * 6);
        if (r.orders.some((t) => t.cook === 'kitchen')) {
          anim = 'cook';
          if (root.position.distanceTo(this.playerPos) < 5) { this.chopT -= dt; if (this.chopT <= 0) { this.chopT = rnd(0.3, 0.5); audio.sfx('chop', 0.25); } }
        }
      } else if (st.e.role === 'cleaner') {
        st.timer -= dt;
        if (st.path.length) { anim = 'walk'; if (walk(root, st.path, 0.9, dt)) st.timer = rnd(2, 4); }
        else if (st.timer <= 0) {
          const I = this.sites.get(st.siteId)!.site.interior;
          st.path = [V(rnd(I.minX + 0.7, I.maxX - 0.7), rnd(I.minZ + 0.7, I.maxZ - 0.7))];
        } else anim = 'interact';
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
          const job = this.customers.find((c) => c.siteId === st.siteId && !c.claimed && (c.state === 'waiting' || c.state === 'toSpot') && c.ticketId !== null && r.ready.some((t) => t.id === c.ticketId));
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

  private spawnCustomer(s: GameState, rt: SiteRT, playerPos: THREE.Vector3, near = false): void {
    const siteId = rt.site.id;
    const tutorial = siteId === 'asakusa_stand' && s.tutorial < 4;
    let type: CustomerType = tutorial ? 'office' : sim.pickCustomerType(s, PROPERTIES[siteId].district, s.minute, siteId);
    const doorV = vs(rt.site.door);
    if (type === 'vip' && doorV.distanceTo(playerPos) > 30) type = 'tourist';
    let order = sim.makeOrder(s, siteId, type);
    if (tutorial) order = { recipe: sim.canMake(s, 'salmon_nigiri', 2) || !s.recipes.includes('cucumber_maki') ? 'salmon_nigiri' : 'cucumber_maki', pieces: 2 };
    if (!order) return;
    const look = customerLook(type);
    const ch = new Character(look.a, look.o, rnd(0.93, 1.06));
    if (look.hand) ch.hands.add(look.hand);
    const bubble = new Bubble();
    ch.root.add(bubble.group);
    const { inR, outR } = this.routes(doorV, near ? 5 : 22);
    ch.root.position.copy(inR[0]);
    this.group.add(ch.root);
    const c: Cust = {
      id: nextCustomerId++, type, siteId, char: ch, bubble, order, vip: type === 'vip', tutorial,
      state: 'arrive', path: inR.slice(1), exit: outR, speed: rnd(1.3, 1.7),
      joinT: 0, patience: this.patienceFor(s, siteId, type) * (tutorial ? 4 : 1), ticketId: null,
      seat: -1, stand: -1, orderTimer: 0, eatT: 0, reactT: 0, reactText: null, claimed: false, fade: 0, faceYaw: null, sitting: false, plate: null, stack: 0, stackT: 0,
    };
    if (type === 'family') {
      const ca = baseAvatar(); ca.hairStyle = pick([0, 3]);
      c.child = new Character({ ...ca, faceStyle: 4 }, { cut: 'knit', bag: pick(STREET_COLORS), trim: '#e0cba3' }, 0.62);
      c.child.root.position.copy(inR[0]).add(V(0.6, 0.4));
      this.group.add(c.child.root);
    }
    if (type === 'influencer') c.reactText = '🤳';
    this.customers.push(c);
  }

  private takeOrder(s: GameState, rt: SiteRT, c: Cust): 'took' | 'nostock' {
    const res = sim.acceptOrder(s, rt.site.id, { ...c.order, type: c.type, customerId: c.id, manualOnly: c.vip || undefined });
    if (res === 'nostock') {
      sim.customerLeft(s, rt.site.id, c.type, c.id, 'nostock'); // → bus → this.leave()
      return 'nostock';
    }
    c.ticketId = res.id;
    rt.queue = rt.queue.filter((x) => x !== c);
    this.reflowQueue(rt);
    const ns = this.activeSeats(s, rt.site.id);
    const seat = concept(s, rt.site.id) === 'kiosk' ? -1 : rt.seats.findIndex((x, i) => i < ns && x === null);
    if (seat >= 0) { rt.seats[seat] = c; c.seat = seat; const sv = vs(rt.site.seats[seat]); c.path = [aisle(rt.site, sv), sv]; c.faceYaw = rt.site.seats[seat].yaw; }
    else {
      let st = rt.stand.findIndex((x) => x === null);
      if (st < 0) st = Math.floor(Math.random() * rt.stand.length);
      else rt.stand[st] = c;
      c.stand = st;
      const sp = rt.standSpots[st] ?? rt.site.queue[0];
      c.path = [vs(sp)]; c.faceYaw = sp.yaw;
    }
    c.state = 'toSpot';
    return 'took';
  }

  private reflowQueue(rt: SiteRT): void {
    rt.queue.forEach((c, i) => { c.path = [vs(rt.site.queue[i])]; c.faceYaw = rt.site.queue[i].yaw; c.orderTimer = 0; });
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
    this.freeSlots(c);
    c.state = 'leave'; c.sitting = false; c.faceYaw = null;
    const here = c.char.root.position.clone();
    const rt = this.sites.get(c.siteId);
    c.path = rt ? [aisle(rt.site, here), ...c.exit] : [...c.exit];
    if (reaction) { c.reactText = reaction; c.reactT = 2.5; }
  }

  private serve(s: GameState, c: Cust): boolean {
    if (c.ticketId === null) return false;
    const rt = this.sites.get(c.siteId)!;
    const res = sim.settle(s, c.siteId, c.ticketId, s.clock - c.joinT);
    if (!res) return false;
    const p = c.char.root.position;
    emit('money', { amount: res.paid + res.tip, x: p.x, y: 2.2, z: p.z });
    c.reactText = res.satisfaction > 0.85 ? '😍' : res.satisfaction > 0.7 ? '😊' : res.satisfaction > 0.5 ? '🙂' : '😐';
    if (res.tip > 1) c.reactText += ' 💰 tip!';
    c.reactT = 2.5;
    c.ticketId = null;
    const cc = concept(s, c.siteId);
    const plate = cc === 'kiosk' ? takeoutBag() : makePlate(c.order.recipe, c.order.pieces);
    if (cc !== 'kiosk') plate.scale.setScalar(1.3);
    c.char.hands.add(plate); c.plate = plate;
    if (c.seat >= 0) {
      c.state = 'eating'; c.sitting = true;
      if (cc === 'kaiten') { c.stack = 0; c.stackT = 0; c.eatT = 2 + 1.6 * Math.ceil(c.order.pieces / 2); }
      else c.eatT = cc === 'omakase' ? rnd(14, 20) : rnd(4, 8);
    }
    else { if (c.stand >= 0 && rt.stand[c.stand] === c) rt.stand[c.stand] = null; this.leave(c, null); c.reactT = 2.5; }
    return true;
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

      if (running && r && c.state !== 'leave' && c.state !== 'eating' && c.state !== 'arrive') {
        // a guest whose order the player is cooking right now waits patiently (patience clock frozen)
        if (c.ticketId !== null && c.ticketId === sim.cookingTicketId) c.joinT += dt;
        if (s.clock - c.joinT > c.patience) sim.customerLeft(s, c.siteId, c.type, c.id, 'patience');
        else if (c.ticketId !== null && !r.orders.some((t) => t.id === c.ticketId) && !r.ready.some((t) => t.id === c.ticketId)) this.leave(c, '🤷');
      }
      if (c.state === 'arrive' && !c.path.length) {
        if (!r || !sim.isOpen(s.minute) || rt.queue.length >= rt.site.queue.length) this.leave(c, null);
        else { rt.queue.push(c); c.state = 'queue'; c.joinT = s.clock; this.reflowQueue(rt); }
      }
      if (c.state === 'queue' && rt.queue[0] === c && !c.path.length && running) {
        c.orderTimer += dt;
        const foh = this.foh(c.siteId);
        const delay = 2.5 / (1 + 0.3 * (r.upgrades.register ?? 0));
        if (foh.length && c.orderTimer > delay) this.takeOrder(s, rt, c); // VIP tickets are manualOnly: the player still cooks them
      }
      if (c.state === 'queue' && running && !sim.isOpen(s.minute)) sim.customerLeft(s, c.siteId, c.type, c.id, 'closed');
      if (c.state === 'toSpot' && !c.path.length) { c.state = 'waiting'; c.sitting = c.seat >= 0; }
      if (c.state === 'eating') {
        c.eatT -= dt;
        if (c.stackT >= 0 && concept(s, c.siteId) === 'kaiten') {
          c.stackT += dt;
          if (c.stackT > 1.6 && c.stack < Math.ceil(c.order.pieces / 2) - 1 && c.plate) {
            c.stackT = 0; c.stack++;
            const e = new THREE.Mesh(EMPTY_PLATE, propMat(pick(['#e63946', '#2b5aa8', '#f4a261', '#2a9d8f'])));
            e.position.y = -0.03 - c.stack * 0.03; c.plate.add(e); // pile grows under the current plate
          }
        }
        if (c.eatT <= 0) { c.plate?.removeFromParent(); c.plate = null; this.leave(c, null); }
      }
      // animation
      let anim: Anim = moving ? 'walk' : 'idle';
      if (!moving && c.sitting && (c.state === 'waiting' || c.state === 'eating')) anim = c.state === 'eating' ? 'eat' : 'sit';
      else if (c.state === 'leave' && c.reactT > 0 && c.reactText === '💢') anim = moving ? 'walk' : 'angry';
      else if (!moving && c.type === 'influencer' && c.state === 'waiting') anim = 'wave';
      if (c.plate && moving && c.state === 'leave') anim = 'carry';
      c.char.anim = anim; c.char.speed = moving ? c.speed : 0;
      // bubble
      c.reactT -= dt;
      const near = root.position.distanceToSquared(this.playerPos) < 28 * 28;
      if (!near) c.bubble.set(null);
      else if (c.reactT > 0 && c.reactText) c.bubble.set(c.reactText, null, '#ffd23f');
      else if (c.state === 'queue' && rt.queue[0] === c && !c.path.length) {
        c.bubble.set(`${c.vip ? '👑' : '🍣'} ${c.order.pieces}× ${RECIPES[c.order.recipe].name}`, 1 - (s.clock - c.joinT) / c.patience, c.vip ? '#c9a227' : '#ff6b6b');
      } else if ((c.state === 'waiting' || c.state === 'toSpot' || c.state === 'queue') && r) {
        const ready = c.ticketId !== null && r.ready.some((t) => t.id === c.ticketId);
        c.bubble.set(ready ? '🔔 Ready!' : c.state === 'queue' ? '…' : `⏳ ${c.order.pieces}× ${RECIPES[c.order.recipe].name}`, 1 - (s.clock - c.joinT) / c.patience, ready ? '#5ad16b' : '#9aa0ad');
      } else c.bubble.set(null);
      // despawn
      if (c.state === 'leave' && !c.path.length) { c.fade = -1; }
      const sc = c.fade < 0 ? 0 : Math.min(1, c.fade);
      root.scale.setScalar(Math.max(0.001, sc));
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
        c.child.anim = cm ? 'walk' : anim === 'eat' || anim === 'sit' ? 'idle' : anim === 'angry' ? 'angry' : 'idle';
        c.child.speed = cm ? 1.5 : 0;
        animate(c.child, dt);
      }
    }
  }

  private remove(c: Cust): void {
    this.freeSlots(c);
    c.bubble.dispose(); c.char.dispose(); c.child?.dispose();
    this.customers = this.customers.filter((x) => x !== c);
  }

  private updateSpawns(dt: number, s: GameState, playerPos: THREE.Vector3): void {
    const open = sim.isOpen(s.minute);
    for (const rt of this.sites.values()) {
      const id = rt.site.id;
      if (!s.restaurants[id] || !open) continue;
      const here = this.customers.filter((c) => c.siteId === id && c.state !== 'leave');
      if (id === 'asakusa_stand' && s.tutorial < 4) {
        if (s.tutorial === 0 || here.length) continue;
        rt.tutorialCd -= dt;
        if (rt.tutorialCd <= 0) { rt.tutorialCd = 3; this.spawnCustomer(s, rt, playerPos, true); }
        continue;
      }
      rt.spawnAcc += sim.visibleSpawnPerMin(s, id) * dt / 60;
      if (rt.spawnAcc < 1) continue;
      rt.spawnAcc -= 1;
      const cap = rt.site.queue.length + this.activeSeats(s, id) + 3;
      if (here.length >= cap || this.charCount() - this.staff.length >= MAX_CHARS) continue; // staff don't crowd out customers
      this.spawnCustomer(s, rt, playerPos);
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
      if (running) this.updateSpawns(h, s, playerPos);
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

  /** Prompt text for E at this owned site's counter, or null if nothing to do. */
  counterPrompt(s: GameState, siteId: string): string | null {
    const r = s.restaurants[siteId], rt = this.sites.get(siteId);
    if (!r || !rt) return null;
    const ready = this.readyCustomers(s, siteId);
    if (ready.length) return `Serve ${ready.length} order${ready.length > 1 ? 's' : ''}`;
    const f = rt.queue[0];
    if (f && !f.path.length) return `Take order: ${f.vip ? '👑 ' : ''}${f.order.pieces}× ${RECIPES[f.order.recipe].name}`;
    return null;
  }

  private readyCustomers(s: GameState, siteId: string): Cust[] {
    const r = s.restaurants[siteId];
    return this.customers.filter((c) => c.siteId === siteId && c.ticketId !== null && (c.state === 'waiting' || c.state === 'toSpot') && r.ready.some((t) => t.id === c.ticketId));
  }

  /** Player pressed E at the counter: serve ready food first, else take the front customer's order. */
  counterAction(s: GameState, siteId: string): 'served' | 'took' | 'nostock' | 'none' {
    const rt = this.sites.get(siteId);
    if (!rt || !s.restaurants[siteId]) return 'none';
    let served = false;
    for (const c of this.readyCustomers(s, siteId)) {
      for (const st of this.staff) if (st.target === c) this.dropDelivery(st);
      served = this.serve(s, c) || served;
    }
    if (served) return 'served';
    const f = rt.queue[0];
    if (f && !f.path.length) return this.takeOrder(s, rt, f);
    return 'none';
  }

  /** Visible orders at a site for the HUD ticket rail. */
  ordersView(s: GameState, siteId: string): OrderView[] {
    const r = s.restaurants[siteId];
    if (!r) return [];
    return this.customers.filter((c) => c.siteId === siteId && (c.state === 'queue' || c.state === 'toSpot' || c.state === 'waiting')).map((c) => ({
      emoji: CUSTOMERS[c.type].emoji, recipe: c.order.recipe, pieces: c.order.pieces,
      status: c.ticketId === null ? 'ordering' : r.ready.some((t) => t.id === c.ticketId) ? 'ready' : 'waiting',
      patience: Math.max(0, 1 - (s.clock - c.joinT) / c.patience), vip: c.vip,
    }));
  }

  /** Force the next customer at this site to arrive quickly (tutorial). */
  hurryCustomer(siteId: string): void { const rt = this.sites.get(siteId); if (rt) { rt.tutorialCd = 0; rt.spawnAcc = Math.max(rt.spawnAcc, 1); } }

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
