// Restaurant sites (player stand, enterable buildings), rival storefronts and the HQ tower.
// Each view rebuilds its meshes only when its state hash changes.
import * as THREE from 'three';
import { PROPERTIES, RECIPES, RIVALS } from '../core/data';
import { yen } from '../core/format';
import { GameState, RestaurantState } from '../core/state';
import { Collider } from '../engine/collision';
import { Atlas, Builder, FONT, G, drawSign, rng } from './kit';
import { C, Style, awning, bonsai, building, gable, hip, lantern, noren, nobori, planter, scooter } from './props';
import { makePlate, makeSushi } from './sushi';
import { RestaurantSite, Spot } from './types';

/** Default interior palettes per district style (theme 0); themes 1–3 are player choices. */
const STYLE_PAL: Record<string, typeof THEMES[number]> = {
  wood: { wall: '#efe2c6', floor: '#b58a5e', accent: '#7a4a2a', counter: '#e9cf9f' },
  modern: { wall: '#f7f4ef', floor: '#d3d7dc', accent: '#d62839', counter: '#ffffff' },
  lux: { wall: '#c99c6b', floor: '#5e4a3a', accent: '#3b2a20', counter: '#f2dcae' },
  salary: { wall: '#6b5240', floor: '#45454b', accent: '#7d8590', counter: '#b98a5a' }, // Shinjuku lunch counter
};
/** Format palettes override the district look so each concept reads instantly. */
const CONCEPT_PAL: Record<string, typeof THEMES[number]> = {
  kaiten: { wall: '#fbf6ee', floor: '#e2ddd6', accent: '#d62839', counter: '#ffffff' },
  omakase: { wall: '#4d3c31', floor: '#5a4738', accent: '#2a1f1a', counter: '#f0d9a8' },
  kiosk: { wall: '#f4f1ea', floor: '#cfcac2', accent: '#2a9d8f', counter: '#ffffff' },
  ghost: { wall: '#a3a9b0', floor: '#6b7078', accent: '#5c6470', counter: '#c9ced4' },
};
const PLATE_COLORS = ['#ffffff', '#ffd23f', '#e63946', '#3a86ff', '#1d1d1d', '#7cc46a'].map((c) => new THREE.Color(c));
const THEMES = [
  { wall: '#f3e6cf', floor: '#c49a6c', accent: '#8a5a3c', counter: '#e9cf9f' },
  { wall: '#33425f', floor: '#5b4636', accent: '#1f2a40', counter: '#d8b98a' },
  { wall: '#ffe3ec', floor: '#eadbc8', accent: '#f29bb8', counter: '#fff4e6' },
  { wall: '#232329', floor: '#2f2f35', accent: '#d8b24a', counter: '#3b2f2a' },
];

/** Must match the NPC system: visible seats = min(spots, base + 2 per seats level). */
export const activeSeats = (kind: string, lvl: number, n: number) => Math.min(n, (kind === 'stand' ? 1 : 2) + 2 * lvl);

export interface SiteDef { id: string; x: number; z: number; ry: number; w: number; d: number; style: Style; color: string }

/** A canvas texture for one site's name board / for-sale plaque. */
class Plaque {
  canvas = document.createElement('canvas');
  tex: THREE.CanvasTexture;
  mat: THREE.MeshStandardMaterial;
  constructor() {
    this.canvas.width = 512; this.canvas.height = 160;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, emissiveMap: this.tex, emissive: '#ffffff', emissiveIntensity: 0.3 });
  }
  draw(text: string, bg: string, fg: string, sub?: string): void {
    const x = this.canvas.getContext('2d')!;
    x.clearRect(0, 0, 512, 160);
    drawSign(x, 0, 0, 512, 160, text, { bg, fg, sub, border: fg, size: 0.5 });
    this.tex.needsUpdate = true;
  }
  mesh(w: number, h: number): THREE.Mesh { return new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat); }
}

// ================================================================ restaurant sites
export class SiteView {
  site: RestaurantSite;
  group = new THREE.Group();
  roof = new THREE.Group();
  colliders: Collider[] = [];
  private hash = '';
  private plaque = new Plaque();
  private kind: string;
  private L: ReturnType<typeof buildingLayout> | null = null;
  private atlas: Atlas | null = null;
  private baseSeats: Spot[] = [];
  private belt: { plates: THREE.InstancedMesh; sushi: THREE.InstancedMesh; x0: number; x1: number; zf: number; zb: number; t: number } | null = null;

  constructor(public def: SiteDef) {
    this.kind = PROPERTIES[def.id].kind;
    const f = new Builder().push(def.x, 0, def.z, def.ry);
    if (this.kind === 'stand') this.site = standSpots(f, def.id);
    else { this.L = buildingLayout(def.w, def.d, 12); this.site = toSite(f, def, this.L); }
    this.baseSeats = this.site.seats.map((sp) => ({ ...sp }));
    this.group.add(this.roof);
  }

  /** Seat spots follow the format: counter stools (omakase), wall & window ledges (kiosk), tables otherwise.
   *  Mutated in place so the NPC system (which keeps references) sees the new layout. */
  private applySeats(concept: string): void {
    if (!this.L) return;
    const f = new Builder().push(this.def.x, 0, this.def.z, this.def.ry);
    const L = this.L, w = this.def.w;
    const pts: [number, number, number][] = [];
    if (concept === 'omakase') { for (let x = L.counterX0 + 0.45; x < L.counterX1 - 0.3; x += 0.62) if (Math.abs(x - L.qx) > 0.85) pts.push([x, L.cz + 0.72, Math.PI]); }
    else if (concept === 'kiosk') {
      for (let z = -1.5; z > L.cz + 2.0; z -= 0.7) pts.push([-w / 2 + 0.65, z, -Math.PI / 2]);
      for (let x = -w / 2 + 0.7; x < w / 2 - 1.6; x += 0.7) if (Math.abs(x - L.doorX) > 1.5) pts.push([x, -0.68, 0]);
    }
    this.site.seats.forEach((sp, i) => {
      const src = pts.length ? f.spot(pts[i % pts.length][0], pts[i % pts.length][1], pts[i % pts.length][2]) : this.baseSeats[i];
      sp.x = src.x; sp.z = src.z; sp.yaw = src.yaw;
    });
  }

  /** Per-frame: kaiten plates ride the belt. */
  animate(dt: number): void {
    const B = this.belt;
    if (!B) return;
    B.t += dt * 0.32;
    const lenX = B.x1 - B.x0, lenZ = B.zf - B.zb, P = 2 * lenX + 2 * lenZ, n = B.plates.count;
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      let u = (((i / n) * P + B.t) % P + P) % P, x: number, z: number;
      if (u < lenX) { x = B.x0 + u; z = B.zf; } else if ((u -= lenX) < lenZ) { x = B.x1; z = B.zf - u; } else if ((u -= lenZ) < lenX) { x = B.x1 - u; z = B.zb; } else { u -= lenX; x = B.x0; z = B.zb + u; }
      m.makeTranslation(x, 1.14, z); B.plates.setMatrixAt(i, m);
      m.makeRotationY(Math.PI / 2).setPosition(x, 1.16, z); B.sushi.setMatrixAt(i, m);
    }
    B.plates.instanceMatrix.needsUpdate = true; B.sushi.instanceMatrix.needsUpdate = true;
  }

  refresh(s: GameState): boolean {
    const r = s.restaurants[this.def.id];
    const h = JSON.stringify([!!r, r?.concept, r?.upgrades, r?.name, r?.signColor, r?.theme, r?.menu, r?.priceMult, s.recipes.length, s.flags.chapter2, s.player.company]);
    if (h === this.hash) return false;
    this.hash = h;
    for (const c of [...this.group.children]) if (c !== this.roof) { this.group.remove(c); disposeTree(c); }
    for (const c of [...this.roof.children]) { this.roof.remove(c); disposeTree(c); }
    if (this.atlas) { this.atlas.tex.dispose(); this.atlas.mat.dispose(); this.atlas.decalMat.dispose(); }
    this.belt = null;
    this.applySeats(r?.concept ?? 'bar');
    this.atlas = new Atlas(1024);
    const b = new Builder(this.atlas, 1000).push(this.def.x, 0, this.def.z, this.def.ry);
    const rb = new Builder(this.atlas, 1000).push(this.def.x, 0, this.def.z, this.def.ry);
    if (this.kind === 'stand') this.buildStand(b, rb, s, r!);
    else this.buildHouse(b, rb, s, r);
    this.group.add(b.build());
    const roofMesh = rb.build();
    roofMesh.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
    this.roof.add(roofMesh);
    this.colliders = b.colliders;
    return true;
  }

  updateRoof(p: THREE.Vector3): void {
    const I = this.site.interior;
    this.roof.visible = !(p.x > I.minX - 0.3 && p.x < I.maxX + 0.3 && p.z > I.minZ - 0.3 && p.z < I.maxZ + 0.3);
  }

  /** Place a plaque mesh in the site's local frame. */
  private addPlaque(lx: number, y: number, lz: number, w: number, h: number, lry = 0): void {
    const m = this.plaque.mesh(w, h);
    const f = new THREE.Object3D(); f.position.set(this.def.x, 0, this.def.z); f.rotation.y = this.def.ry;
    m.position.set(lx, y, lz); m.rotation.y = lry;
    f.add(m); this.group.add(f);
  }

  // ------------------------------------------------------------ the starting yatai stand
  private buildStand(b: Builder, rb: Builder, s: GameState, r: RestaurantState): void {
    const u = r.upgrades, th = THEMES[r.theme] ?? THEMES[0];
    const W = 5, D = 2.8;
    // platform & cart body
    b.box(0, 0, -D / 2, W + 0.4, 0.08, D + 0.4, '#b08a63');
    // counter (front), facing +z
    b.rbox(-0.25, 0, -0.4, 3.9, 1.0, 0.7, th.accent === '#d8b24a' ? '#3b2f2a' : C.wood, 0.05);
    b.rbox(-0.25, 1.0, -0.38, 4.1, 0.08, 0.86, th.counter, 0.03);
    for (let i = 0; i < 5; i++) b.box(-2.0 + i * 0.88, 0.15, -0.04, 0.06, 0.7, 0.04, C.woodD);
    b.collide(-0.25, -0.4, 3.9, 0.7, 1.05, false);
    // wooden wheels on the left side (yatai cart)
    b.add(new THREE.TorusGeometry(0.42, 0.08, 8, 16), C.woodD, { at: [-2.62, 0.45, -0.8], rot: [0, Math.PI / 2, 0] });
    b.add(new THREE.TorusGeometry(0.42, 0.08, 8, 16), C.woodD, { at: [-2.62, 0.45, -2.0], rot: [0, Math.PI / 2, 0] });
    // back prep counter along back
    b.rbox(0, 0, -D + 0.3, W - 0.2, 0.95, 0.6, C.woodL, 0.04);
    b.box(0, 0.95, -D + 0.3, W - 0.1, 0.05, 0.66, th.counter);
    b.collide(0, -D + 0.3, W - 0.2, 0.6, 0.95, false);
    // left panel + back rail kept low (1.45 m) so the counter camera always sees player, counter and guest
    b.box(-W / 2, 0, -D / 2, 0.1, 1.45, D, C.wood);
    b.collide(-W / 2, -D / 2, 0.15, D, 1.45, false);
    b.box(0, 0.95, -D - 0.02, W, 0.5, 0.08, th.wall);
    b.box(0, 1.43, -D - 0.02, W + 0.1, 0.06, 0.14, C.woodD);
    b.collide(0, -D, W, 0.15, 1.45, false);
    // A-frame menu board for passers-by
    b.push(-3.6, 0, 0.25, 0.25);
    b.add(G.box(0.7, 1.15, 0.05), C.woodD, { at: [0, 0, -0.12], rot: [0.2, 0, 0] });
    b.add(G.box(0.7, 1.15, 0.05), C.woodD, { at: [0, 0, 0.12], rot: [-0.2, 0, 0] });
    b.panel(0, 0.6, 0.04, 0.58, 0.84, this.menuRect(s, r), 0, -0.2);
    b.collide(0, 0, 0.75, 0.5, 1.1, false);
    b.pop();
    // posts
    for (const [x, z] of [[-W / 2, 0.1], [W / 2, 0.1], [-W / 2, -D], [W / 2, -D]]) { b.box(x, 0, z, 0.14, 2.6, 0.14, C.woodD); b.collide(x, z, 0.18, 0.18, 2.6, false); }
    // prep station (upgrade: station)
    this.prepGear(b, 0.6, 0.98, -D + 0.3, u.station ?? 0, false);
    for (let i = 0; i < (u.extra_station ?? 0); i++) this.prepGear(b, -1.9 + i * 0.75 + (i > 1 ? 2.9 : 0), 0.98, -D + 0.3, 0, true);
    // fridge: glass neta case on the counter
    if (u.fridge) this.netaCase(b, 0.9, 1.08, -0.4, 0.9 + 0.5 * u.fridge);
    // register / cleaning
    if (u.register) { b.rbox(-1.75, 1.08, -0.5, 0.35, 0.22, 0.3, u.register >= 3 ? C.gold : '#4a4e58', 0.04); b.box(-1.75, 1.3, -0.6, 0.3, 0.18, 0.04, '#9fd3ff', '#9fd3ff'); }
    if (u.cleaning) { b.cyl(2.2, 0.08, -2.0, 0.2, 0.17, 0.35, '#3fa7ff', 10); b.add(G.cyl(0.02, 0.02, 1.3, 5), C.woodL, { at: [2.3, 0.1, -1.8], rot: [0.2, 0, 0.1] }); }
    // roof (hides when inside): pitched with eaves overhanging the counter
    rb.add(gable(D + 1.6, 0.9, W + 0.6), C.redD, { at: [0, 2.6, -D / 2 + 0.15], roof: true });
    rb.box(0, 2.5, -D / 2 + 0.15, W + 0.7, 0.12, D + 1.7, C.woodD);
    rb.box(0, 3.45, -D / 2 + 0.15, W + 0.8, 0.1, 0.2, C.woodD);
    // signboard on roof front
    const sl = u.sign ?? 0;
    const name = r.name;
    this.plaque.draw(name, r.signColor, '#fff5dc', sl >= 2 ? '寿司 · SUSHI' : 'すし');
    this.plaque.mat.emissiveIntensity = 0.25 + sl * 0.25;
    this.addPlaque(0, 3.15 + sl * 0.1, 0.72, 2.6 + sl * 0.35, 0.8 + sl * 0.1);
    if (sl >= 3) {
      rb.box(0, 3.55, -0.6, 1.7, 0.95, 0.12, '#1a1a2a');
      rb.add(G.box(1.62, 0.87, 0.04), '#ff3e6c', { at: [0, 3.59, -0.53], glow: '#ff3e6c' });
      rb.sign(0, 4.02, -0.49, 1.45, 0.72, '寿司', { bg: '#1a1a2a', fg: '#ff6a9a', px: 90, border: '#ff3e6c' });
    }
    // noren curtain across the front eave
    noren(b, -0.25, 2.45, 0.35, 3.6, r.signColor === '#c0392b' ? '#24345c' : r.signColor, 'すし');
    // red lantern(s)
    lantern(b, 2.35, 1.55, 0.25, C.red, 1.1);
    b.pool(2.35, 0.9, 3, '#ff9a5a');
    const ll = u.lanterns ?? 0;
    const nl = [0, 2, 4, 4][Math.min(3, ll)];
    for (let i = 0; i < nl; i++) lantern(b, -2.2 + i * (4.2 / Math.max(1, nl - 1)), 1.75, 0.5, i % 2 ? '#fff0d0' : C.red, 0.7);
    if (ll >= 3) { lantern(b, -2.75, 1.45, 0.75, C.red, 1.25); b.pool(-2.75, 1.4, 3, '#ff9a5a'); } // big paired chōchin
    // plants
    const pl = u.plants ?? 0;
    if (pl >= 1) { planter(b, -2.95, 0.6, '#ff7aa8'); planter(b, 2.95, 0.6, '#ffd23f'); }
    if (pl >= 2) bonsai(b, -1.8, 1.08, -0.35);
    if (pl >= 3) for (let i = 0; i < 4; i++) b.add(G.cyl(0.04, 0.05, 2.2, 6), '#7fb069', { at: [-2.85 + (i % 2) * 0.15, 0, -1.2 - i * 0.35] });
    // seats: small tables with stools on the customer side
    const seats = this.site.seats;
    const na = activeSeats('stand', u.seats ?? 0, seats.length);
    for (let t = 0; t < seats.length / 2; t++) {
      const a = 2 * t;
      if (a >= na) continue;
      const tx = (localOf(this.def, seats[a]).x + localOf(this.def, seats[a + 1]).x) / 2, tz = localOf(this.def, seats[a]).z;
      b.cyl(tx, 0, tz, 0.06, 0.08, 0.72, C.woodD, 8);
      b.cyl(tx, 0.72, tz, 0.4, 0.4, 0.05, C.woodL, 16);
      b.collide(tx, tz, 0.6, 0.6, 0.75, false);
      for (const k of [a, a + 1]) if (k < na) { const sp = localOf(this.def, seats[k]); b.cyl(sp.x, 0, sp.z, 0.17, 0.14, 0.45, C.red, 10); }
      if (u.seats >= 2) { b.add(G.cyl(0.03, 0.03, 2.4, 6), C.woodD, { at: [tx, 0, tz] }); b.add(G.cone(1.1, 0.5, 10), t % 2 ? '#e63946' : '#ffffff', { at: [tx, 2.2, tz] }); }
    }
    // delivery scooters
    for (let i = 0; i < (u.delivery ?? 0); i++) scooter(b, 3.4 + i * 0.95, -1.4, Math.PI / 2, '#ff8fab');
    // expand: grander stall
    const ex = u.expand ?? 0;
    if (ex >= 1) {
      nobori(b, 2.9, 0.7, '新鮮', '#e63946'); nobori(b, -3.0, 0.7, '寿司', '#2a6fdb');
      // covered seating terrace beside the stall
      for (const [px, pz] of [[-3.5, 1.0], [-7.5, 1.0], [-3.5, 4.5], [-7.5, 4.5]]) { b.box(px, 0, pz, 0.14, 2.55, 0.14, C.woodD); b.collide(px, pz, 0.2, 0.2, 2.5, false); }
      for (let i = 0; i < 8; i++) b.add(G.box(0.5, 0.06, 3.9), i % 2 ? '#ffffff' : r.signColor, { at: [-7.25 + i * 0.5, 2.55, 2.75], rot: [0, 0, (i % 2 ? 1 : -1) * 0.04] });
      b.box(-5.5, 2.45, 1.0, 4.2, 0.12, 0.1, C.woodD); b.box(-5.5, 2.45, 4.5, 4.2, 0.12, 0.1, C.woodD);
      b.collideY(-5.5, 2.75, 4.2, 3.7, 2.45, 2.7);
    }
    if (ex >= 2) {
      for (let i = 0; i < 7; i++) b.box(-2.7 + i * 0.9, 0, 1.9, 0.12, 0.35, 0.12, C.woodL); b.box(0, 0.25, 1.9, 6.0, 0.06, 0.06, C.woodL);
      for (let i = 0; i < 5; i++) lantern(b, -7.3 + i * 0.95, 1.95, 1.0, i % 2 ? '#fff0d0' : C.red, 0.55);
      rb.add(hip(W - 1.2, D * 0.6, 0.9), C.redD, { at: [0, 3.5, -D / 2 + 0.15], roof: true }); // second roof tier
      rb.box(0, 3.45, -D / 2 + 0.15, W - 1.0, 0.1, D * 0.62, C.woodD);
    }
    if (ex >= 3) {
      rb.add(hip(1.4, 1.4, 0.8), C.gold, { at: [0, 4.4, -D / 2], roof: true });
      b.add(G.box(5.2, 0.12, 0.12), C.gold, { at: [0, 2.48, 0.2] });
      // tall roof kanban with the shop name, and a side prep cart
      rb.box(-1.9, 2.6, -D + 0.2, 0.12, 3.2, 0.12, C.woodD);
      rb.sign(-1.9, 4.2, -D + 0.28, 0.75, 2.6, '寿司処', { bg: C.woodD, fg: '#ffd166', vertical: true, px: 70, border: C.gold });
      b.rbox(3.4, 0, -0.6, 1.1, 1.0, 0.7, C.wood, 0.05); b.box(3.4, 1.0, -0.6, 1.2, 0.06, 0.8, th.counter);
      b.add(G.box(1.3, 0.06, 1.0), r.signColor, { at: [3.4, 2.2, -0.6], rot: [0.15, 0, 0] });
      b.box(3.0, 0, -0.95, 0.06, 2.2, 0.06, C.woodD); b.box(3.8, 0, -0.95, 0.06, 2.2, 0.06, C.woodD);
      b.collide(3.4, -0.6, 1.1, 0.7, 1.05, false);
    }
    // golden maneki-neko after one million
    if (s.flags.chapter2) maneki(b, -1.85, 1.08, -0.3, 0.5);
    // ambient props: rice cooker steam pot, sake bottles
    b.cyl(-2.0, 0.98, -D + 0.3, 0.22, 0.2, 0.35, '#c7ccd3', 12);
    for (let i = 0; i < 3; i++) b.cyl(1.9 + i * 0.14, 0.98, -D + 0.25, 0.05, 0.05, 0.3, ['#2d6a4f', '#6a4c93', '#e9c46a'][i], 8);
  }

  // ------------------------------------------------------------ enterable buildings
  private buildHouse(b: Builder, rb: Builder, s: GameState, r: RestaurantState | undefined): void {
    const { w, d, style } = this.def;
    const L = this.L!;
    const owned = !!r;
    const u = r?.upgrades ?? {};
    const th = THEMES[r?.theme ?? 0] ?? THEMES[0];
    const ex = u.expand ?? 0;
    const p = PROPERTIES[this.def.id];
    const gh = 3.6;
    const floors = ({ shop: 2, restaurant: 3, flagship: 4 } as Record<string, number>)[p.kind] + (ex >= 2 ? 1 : 0);
    const ext = this.def.color;
    const pw = Math.min(w - 1.2, 3.4 + (p.kind === 'flagship' ? 1.2 : p.kind === 'restaurant' ? 0.6 : 0)); // name plaque width
    const rand = rng(this.def.id.length * 977 + w);
    this.lastUpgrades = u;
    const concept = r?.concept ?? 'bar';
    const pal = r && r.theme !== 0 ? th : CONCEPT_PAL[concept] ?? STYLE_PAL[this.def.id.startsWith('shinjuku') ? 'salary' : style] ?? th;
    // floor (clean interior material)
    b.clean = true;
    b.box(0, 0, -d / 2, w, 0.05, d, owned ? pal.floor : '#8b8580');
    if (owned && style !== 'modern') for (let i = 1; i < w / 1.2; i++) b.box(-w / 2 + i * 1.2, 0.05, -d / 2, 0.03, 0.005, d - 0.2, '#' + new THREE.Color(pal.floor).multiplyScalar(0.85).getHexString());
    if (owned && style === 'modern') for (let i = 1; i < w / 0.8; i++) b.box(-w / 2 + i * 0.8, 0.05, -d / 2, 0.02, 0.004, d - 0.2, '#c2c6cc');
    const wallIn = owned ? pal.wall : '#d9d3c7';
    b.clean = false;
    // walls: outer (exterior, weathered) + inner (clean)
    const sideWall = (x: number) => { b.box(x, 0, -d / 2, 0.2, gh, d, ext); b.clean = true; b.box(x - Math.sign(x) * 0.12, 0.05, -d / 2, 0.04, gh - 0.1, d - 0.2, wallIn); b.clean = false; b.collide(x, -d / 2, 0.3, d, gh + 6); };
    sideWall(-w / 2); sideWall(w / 2);
    b.box(0, 0, -d, w, gh, 0.2, ext); b.clean = true; b.box(0, 0.05, -d + 0.12, w - 0.3, gh - 0.1, 0.04, wallIn); b.clean = false; b.collide(0, -d, w, 0.3, gh + 6);
    // front wall with door and windows
    const dx = L.doorX, dw = 2.2;
    const segs: [number, number][] = [[-w / 2, dx - dw / 2], [dx + dw / 2, w / 2]];
    const frameC = style === 'wood' ? C.woodD : style === 'lux' ? '#f5f1e8' : '#3a3f4b';
    for (const [a, c] of segs) {
      const sw = c - a, sx = (a + c) / 2;
      if (sw < 0.05) continue;
      b.box(sx, 0, 0, sw, 0.6, 0.2, frameC); // sill
      b.box(sx, 2.6, 0, sw, gh - 2.6, 0.2, ext); // lintel
      if (sw > 0.8) {
        if (owned && concept !== 'ghost') b.box(sx, 0.6, 0, sw - 0.2, 2.0, 0.06, style === 'wood' ? '#f4e6c8' : '#bcd8e8', style === 'wood' ? '#ffd28a' : '#fff0c8');
        else if (owned) { b.box(sx, 0.6, 0.04, sw - 0.2, 2.0, 0.08, '#8d949c'); for (let k = 0; k < 8; k++) b.box(sx, 0.7 + k * 0.24, 0.09, sw - 0.2, 0.03, 0.02, '#767c85'); }
        else b.box(sx, 0.6, 0.04, sw - 0.2, 2.0, 0.08, '#9aa0a8'); // shutters
        if (style === 'wood') for (let k = 1; k < sw / 0.5; k++) b.box(a + k * 0.5, 0.6, 0.05, 0.05, 2.0, 0.05, C.woodD);
        else b.box(sx, 1.6, 0.05, sw - 0.2, 0.06, 0.05, frameC);
      }
      b.box(a + 0.05, 0, 0, 0.12, gh, 0.25, frameC); b.box(c - 0.05, 0, 0, 0.12, gh, 0.25, frameC);
      b.collide(sx, 0, sw, 0.3, gh + 6);
    }
    b.box(dx, 2.6, 0.02, dw + 0.3, 0.15, 0.3, frameC); // door header
    if (!owned) {
      // closed shutter + for-sale plaque on a stand
      b.box(dx, 0, 0.06, dw, 2.6, 0.08, '#8a9099');
      for (let k = 0; k < 10; k++) b.box(dx, 0.25 * k + 0.1, 0.11, dw, 0.03, 0.02, '#767c85');
      b.collide(dx, 0.05, dw, 0.25, 3);
      const sp = localOf(this.def, this.site.sign);
      b.box(sp.x - 0.7, 0, sp.z, 0.08, 1.2, 0.08, C.woodD); b.box(sp.x + 0.7, 0, sp.z, 0.08, 1.2, 0.08, C.woodD);
      b.collide(sp.x, sp.z, 1.6, 0.3, 1.9, false);
      this.plaque.draw('売物件  FOR SALE', '#ffffff', '#c0392b', `${p.name} · ${yen(p.price)}`);
      this.addPlaque(sp.x, 1.55, sp.z + 0.05, 1.7, 0.55);
    } else {
      // door: noren for wood, glass doors otherwise
      if (style === 'wood' || concept === 'omakase') noren(b, dx, 2.55, 0.1, dw - 0.1, concept === 'omakase' ? '#f3ead8' : r!.signColor === '#c0392b' ? '#24345c' : r!.signColor, concept === 'omakase' ? '鮨' : 'すし');
      else { b.box(dx - dw / 2 + 0.05, 0, 0.0, 0.06, 2.6, 0.12, frameC); b.box(dx + dw / 2 - 0.05, 0, 0, 0.06, 2.6, 0.12, frameC); }
      // name board above door
      if (concept === 'omakase') this.plaque.draw(r!.name, '#2a1d1a', '#e9d3a8', '鮨 · おまかせ');
      else this.plaque.draw(r!.name, r!.signColor, '#fff5dc', concept === 'kaiten' ? '回転寿司 · KAITEN' : concept === 'kiosk' ? '持ち帰り · TAKEOUT' : concept === 'ghost' ? 'デリバリー · DELIVERY' : style === 'lux' ? '鮨 · OMAKASE' : '寿司 · SUSHI');
      this.plaque.mat.emissiveIntensity = 0.3 + (u.sign ?? 0) * 0.2;
      const ppw = concept === 'omakase' ? Math.min(pw, 2.4) : pw;
      this.addPlaque(dx, style === 'wood' ? 3.1 : 3.28, 0.16, ppw, Math.min(1.15, ppw / 3.2)); // keep the 512×160 canvas aspect
      b.clean = true;
      this.interior(b, s, r!, pal, L);
      b.clean = false;
      const cb = new Builder(null, 1000).push(this.def.x, 0, this.def.z, this.def.ry);
      cb.clean = true;
      cb.add(G.plane(w - 0.2, d - 0.2).rotateX(Math.PI / 2), style === 'lux' ? '#3b2a20' : '#' + new THREE.Color(pal.wall).multiplyScalar(0.8).getHexString(), { at: [0, gh - 0.12, -d / 2] });
      for (let z = -1.2; z > -d + 0.5; z -= 1.6) cb.box(0, gh - 0.42, z, w - 0.3, 0.22, 0.16, style === 'modern' ? '#d9dde2' : C.woodD);
      this.group.add(cb.build(false));
    }
    // ---------- upper floors (roof group)
    const h = gh + (floors - 1) * 3.4;
    rb.box(0, gh, -d / 2, w, h - gh, d, ext);
    for (let f = 1; f < floors; f++) {
      const y = gh + (f - 1) * 3.4 + 0.8;
      const n = Math.max(1, Math.floor((w - 0.8) / 2.2));
      for (let i = 0; i < n; i++) {
        const wx = -(w - 0.8) / 2 + ((i + 0.5) * (w - 0.8)) / n;
        rb.box(wx, y, 0.01, 1.5, 1.7, 0.06, style === 'wood' ? '#f4e6c8' : '#a8cbe0', owned && rand() < 0.7 ? '#e8a04a' : '#000000');
        rb.box(wx, y - 0.1, 0.04, 1.7, 0.1, 0.12, style === 'lux' ? C.gold : style === 'wood' ? C.woodD : '#d8dde3');
        if (style === 'wood') for (let k = 1; k < 4; k++) rb.box(wx - 0.75 + k * 0.375, y, 0.05, 0.05, 1.7, 0.04, C.woodD);
      }
    }
    if (style === 'wood') {
      rb.add(G.box(w + 0.4, 0.12, 1.3), C.tile, { at: [0, gh - 0.1, 0.55], rot: [0.35, 0, 0], roof: true });
      b.collideY(0, 0.6, w, 1.3, gh - 0.45, gh + 0.4);
      rb.box(0, h, -d / 2, w + 0.6, 0.15, d + 0.6, C.tileD);
      rb.add(gable(d + 0.8, Math.min(2.4, d * 0.3), w + 0.4), C.tile, { at: [0, h + 0.15, -d / 2], roof: true });
    } else rb.box(0, h, -d / 2, w + 0.1, 0.4, d + 0.1, style === 'lux' ? '#efe9dc' : '#9aa1ab');
    if (!owned) return;
    // ---------- street presence: canopy/noren, vertical kanban, rooftop, all scaled by kind
    const big = p.kind === 'flagship' ? 2 : p.kind === 'restaurant' ? 1 : 0;
    const sc = r!.signColor;
    this.formatFront(b, rb, s, r!, concept, h, gh);
    if (concept === 'omakase') return; // minimal signage: noren, small plaque, wooden sign only
    if (style !== 'wood') {
      awning(b, dx, 2.74, 0.14, dw + 1.4 + big * 0.8, 1.1, concept === 'kaiten' ? '#d62839' : sc, style === 'lux' ? '#1f2a24' : '#ffffff');
      if (style === 'lux') b.box(dx, 2.42, 1.22, dw + 1.6 + big * 0.8, 0.08, 0.08, C.gold);
    }
    const kh = Math.min(h - gh - 0.6, [3.2, 5.0, 7.4][big]);
    const kx = -w / 2 + 0.6;
    rb.box(kx, gh + 0.25, 0.42, 1.0 + big * 0.2, kh + 0.2, 0.22, '#1d1d24');
    rb.add(G.box(0.92 + big * 0.2, kh + 0.08, 0.04), sc, { at: [kx, gh + 0.31, 0.54], glow: (u.sign ?? 0) >= 1 ? sc : '#000000' });
    rb.sign(kx, gh + 0.35 + kh / 2, 0.57, 0.8 + big * 0.18, kh - 0.25, concept === 'kaiten' ? '回転寿司' : concept === 'kiosk' ? '持ち帰り寿司' : concept === 'ghost' ? 'デリバリー' : ['寿司処', '江戸前寿司', '本格江戸前鮨'][big], { bg: '#fff8e8', fg: sc, vertical: true, px: 60 });
    rb.box(kx, gh + 0.9, 0.2, 0.08, 0.08, 0.5, C.metalD); rb.box(kx, gh + kh - 0.2, 0.2, 0.08, 0.08, 0.5, C.metalD);
    if (style !== 'wood') {
      // parapet + rooftop dressing
      for (const [px, pz, pw, pd] of [[0, -0.1, w, 0.2], [0, -d + 0.1, w, 0.2], [-w / 2 + 0.1, -d / 2, 0.2, d], [w / 2 - 0.1, -d / 2, 0.2, d]] as const) rb.box(px, h + 0.4, pz, pw, 0.9, pd, style === 'lux' ? '#efe9dc' : '#b9c0c8');
      if (big === 0) { rb.add(G.cyl(0.9, 0.9, 1.5, 12), '#dfe6ee', { at: [w / 4, h + 1.6, -d / 2] }); for (const [a, c] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) rb.box(w / 4 + a, h + 0.4, -d / 2 + c, 0.1, 1.2, 0.1, '#6b7280'); }
    }
    if (big >= 1 || (u.sign ?? 0) >= 3) {
      // rooftop name billboard (flagship: huge and lit)
      const bw = Math.min(w - 1, big === 2 ? 12 : 8), bh = big === 2 ? 3.0 : 2.0, by = h + (style === 'wood' ? 2.6 : 0.9);
      for (const sx of [-bw / 2 + 0.6, bw / 2 - 0.6]) rb.box(sx, h + 0.2, -1.3, 0.16, by - h + 0.2, 0.16, C.metalD);
      rb.box(0, by, -1.3, bw + 0.3, bh + 0.3, 0.25, '#1b1b22');
      rb.add(G.box(bw + 0.1, bh + 0.1, 0.04), (u.sign ?? 0) >= 3 ? '#ffd23f' : sc, { at: [0, by + 0.1, -1.16], glow: (u.sign ?? 0) >= 2 || big === 2 ? '#ffcf3f' : '#000000' });
      rb.sign(0, by + 0.15 + bh / 2, -1.12, bw - 0.3, bh - 0.2, r!.name, { bg: '#1b1b22', fg: '#ffffff', sub: '寿司 · SUSHI', px: 50 });
    }
    if (big === 2) for (const sx of [-w / 2 + 0.8, w / 2 - 0.8]) { rb.cyl(sx, h + 0.4, -0.6, 0.05, 0.05, 5, '#d9d9d9', 6); rb.sign(sx + 0.45, h + 4.0, -0.6, 0.8, 1.8, '大漁', { bg: sc, fg: '#ffffff', vertical: true, px: 60 }); }
    const sl = u.sign ?? 0;
    const nx = Math.min(w / 2 - 0.9, dx + pw / 2 + 0.85);
    if (sl >= 1) { b.box(nx, 2.9, 0.2, 1.3, 0.6, 0.15, '#1a1a2a'); b.add(G.box(1.22, 0.52, 0.04), sc, { at: [nx, 2.94, 0.28], glow: '#ff6b8a' }); b.sign(nx, 3.2, 0.31, 1.1, 0.42, '寿司', { bg: '#1a1a2a', fg: '#ff8fb0', px: 90 }); }
    if (sl >= 2) { rb.box(w / 2 - 0.6, gh + 0.3, 0.45, 0.9, Math.min(5, h - gh - 0.6), 0.2, '#1a1a2a'); rb.add(G.box(0.74, Math.min(4.6, h - gh - 1) + 0.04, 0.04), '#ff3e6c', { at: [w / 2 - 0.6, gh + 0.48, 0.56], glow: '#ff5a8a' }); rb.sign(w / 2 - 0.6, gh + 0.5 + Math.min(4.6, h - gh - 1) / 2, 0.59, 0.62, Math.min(4.6, h - gh - 1) - 0.1, '寿司', { bg: '#1a1a2a', fg: '#ff8fb0', vertical: true, px: 60 }); }
    if (sl >= 3) for (let i = 0; i < 3; i++) rb.add(makeSushiGeo(), '#ff8a5c', { at: [-1.5 + i * 1.5, h + (style === 'wood' ? 5.8 : 4.3) + big, -1.3], scale: [6, 6, 6], glow: '#ff7a4a' });
    const ll = u.lanterns ?? 0;
    if (ll >= 1) { lantern(b, dx - dw / 2 - 0.45, 2.2, 0.45); lantern(b, dx + dw / 2 + 0.45, 2.2, 0.45); b.pool(dx, 1.5, 4, '#ff9a5a'); }
    if (ll >= 2) for (let i = 0; i < Math.floor(w / 1.1); i++) lantern(b, -w / 2 + 0.6 + i * 1.1, gh + 0.35 - Math.sin((i / Math.floor(w / 1.1)) * Math.PI) * 0.2, 0.6, i % 2 ? '#fff0d0' : C.red, 0.65);
    if (ll >= 3) for (let i = 0; i < 4; i++) lantern(b, L.qx - 3 + i * 2, 2.6, -d * 0.45, i % 2 ? '#ffd27a' : C.red, 0.8);
    const pl = u.plants ?? 0;
    if (pl >= 1) { planter(b, dx - dw / 2 - 0.7, 0.75); planter(b, dx + dw / 2 + 0.7, 0.75, '#ffd23f'); }
    if (pl >= 2) for (let i = 0; i < 3; i++) bonsai(b, L.counterX0 + 0.5 + i * 1.6, 1.12, L.cz + 0.15);
    if (pl >= 3) for (const x of [-w / 2 + 0.5, w / 2 - 0.5]) for (let i = 0; i < 3; i++) b.add(G.cyl(0.05, 0.06, 2.8, 6), '#7fb069', { at: [x, 0.05, -1 - i * 0.3] });
    if (concept !== 'ghost') for (let i = 0; i < (u.delivery ?? 0); i++) scooter(b, dx - 2.4 - i * 1.55, 0.6, 0, ['#ff8fab', '#ffd23f', '#5fd068', '#3fa7ff'][i]);
    if (ex >= 1) awning(b, (dx + (-w / 2)) / 2, 2.45, 0.15, Math.max(1, dx - dw / 2 + w / 2 - 0.6), 0.9, r!.signColor);
    if (ex >= 1) for (let i = 0; i < 2; i++) planter(b, -w / 2 + 0.6 + i * 1.0, 1.1);
    if (ex >= 3) { nobori(b, w / 2 - 0.4, 1.0, '本格寿司', '#c9a227'); nobori(b, w / 2 + 0.4, 1.4, '大人気', '#e63946'); rb.box(0, h - 0.3, 0.12, w + 0.1, 0.25, 0.1, C.gold); b.box(0, gh - 0.25, 0.15, w, 0.12, 0.1, C.gold); }
    if (s.flags.chapter2 && p.kind === 'flagship') maneki(b, dx + dw / 2 + 1.6, 0, 0.9, 1.2);
  }

  /** Street-side identity of each format. */
  private formatFront(b: Builder, rb: Builder, s: GameState, r: RestaurantState, concept: string, h: number, gh: number): void {
    const { w } = this.def, L = this.L!, dx = L.doorX, dw = 2.2;
    if (concept === 'kaiten') {
      const sw = Math.min(w - 2.6, 7);
      rb.box(0.4, gh + 0.6, 0.3, sw + 0.3, 1.5, 0.2, '#1b1b22');
      rb.add(G.box(sw + 0.12, 1.32, 0.04), '#ffd23f', { at: [0.4, gh + 0.69, 0.41], glow: '#ffcf3f' });
      rb.sign(0.4, gh + 1.35, 0.44, sw - 0.2, 1.1, '回転寿司', { bg: '#d62839', fg: '#ffffff', px: 70, sub: 'KAITEN SUSHI · 1皿110円' });
      for (let i = 0; i < 3; i++) rb.add(G.cyl(0.32, 0.32, 0.05, 18), ['#ffd23f', '#3a86ff', '#e63946'][i], { at: [0.4 - sw / 2 - 0.5 + (i === 2 ? sw + 1 : 0), gh + 1.0 + (i === 1 ? 0.7 : 0), 0.45], rot: [Math.PI / 2, 0, 0], glow: '#553311' });
      nobori(b, w / 2 - 0.4, 1.0, '一皿百円', '#d62839'); nobori(b, -w / 2 + 0.4, 1.0, 'ファミリー', '#3a86ff');
    } else if (concept === 'omakase') {
      b.box(dx + dw / 2 + 0.7, 0, 0.35, 0.1, 1.7, 0.1, C.woodD);
      b.sign(dx + dw / 2 + 0.7, 1.15, 0.42, 0.42, 1.0, '鮨', { bg: '#2a1d1a', fg: '#e9d3a8', vertical: true, px: 90 });
      for (const sx of [-1, 1]) for (let k = 0; k < 8; k++) b.box(dx + sx * (dw / 2 + 1.6) + (k - 3.5) * 0.12, 0, 0.18, 0.06, 1.6, 0.06, '#7a9a4a'); // bamboo screen
      b.box(dx, 0.01, 0.9, dw + 2.4, 0.03, 1.1, '#cfc8bc');
      for (let k = 0; k < 3; k++) b.cyl(dx + (k - 1) * 0.6, 0.02, 0.9, 0.22, 0.24, 0.05, '#8e8a84', 10);
      b.box(dx - dw / 2 - 1.1, 0, 0.6, 0.3, 0.25, 0.3, '#a99f91'); b.add(G.box(0.25, 0.25, 0.25), '#e8e0d0', { at: [dx - dw / 2 - 1.1, 0.25, 0.6], glow: '#ffcf70' }); b.add(hip(0.45, 0.45, 0.22), '#8e8a84', { at: [dx - dw / 2 - 1.1, 0.5, 0.6] });
      b.collide(dx - dw / 2 - 1.1, 0.6, 0.35, 0.35, 0.75, false);
    } else if (concept === 'kiosk') {
      // takeout window with a pack chiller and a menu lightbox
      const wx = dx + dw / 2 + Math.min(1.9, (w / 2 - dx - dw / 2) / 2 + 0.2);
      b.box(wx, 1.0, 0.25, 2.2, 0.07, 0.5, '#ffffff'); b.box(wx, 0, 0.05, 2.2, 1.0, 0.12, '#2a9d8f'); b.collide(wx, 0.25, 2.2, 0.5, 1.05, false);
      for (let i = 0; i < 6; i++) b.rbox(wx - 0.8 + (i % 3) * 0.8, 1.07, 0.18 + Math.floor(i / 3) * 0.18, 0.32, 0.07, 0.16, ['#ff8a5c', '#d9364a', '#5fae4b'][i % 3], 0.02);
      const rect = this.atlas!.custom(384, 160, (c, x, y, ww, hh) => {
        c.fillStyle = '#fffdf6'; c.fillRect(x, y, ww, hh); c.fillStyle = '#2a9d8f'; c.fillRect(x, y, ww, 30);
        c.fillStyle = '#fff'; c.font = `700 22px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('持ち帰り TAKEOUT', x + ww / 2, y + 16);
        const packs = [['にぎり', '#ff8a5c', 480], ['巻き', '#5fae4b', 320], ['特上', '#d9364a', 880]] as const;
        packs.forEach(([n, col, pr], i) => {
          const px = x + 20 + i * 122;
          c.fillStyle = '#1d1d1d'; c.fillRect(px, y + 44, 100, 60); c.fillStyle = '#fff'; c.fillRect(px + 6, y + 50, 88, 48);
          for (let k = 0; k < 4; k++) { c.fillStyle = col; c.beginPath(); c.ellipse(px + 18 + k * 21, y + 74, 9, 6, 0, 0, 7); c.fill(); }
          c.fillStyle = '#1d1d1d'; c.font = `700 20px ${FONT}`; c.fillText(`${n} ¥${Math.round(pr * r.priceMult)}`, px + 50, y + 128);
        });
      });
      b.box(wx, 2.35, 0.18, 2.5, 1.05, 0.12, '#1d1d24', '#3a3020');
      b.panel(wx, 2.87, 0.25, 2.4, 1.0, rect);
    } else if (concept === 'ghost') {
      b.box(0, 2.62, 0.16, Math.min(w - 1, 6), 0.5, 0.06, '#1d1d24');
      b.sign(0, 2.87, 0.2, Math.min(w - 1.2, 5.6), 0.44, 'DELIVERY ONLY · デリバリー専用', { bg: '#1d1d24', fg: '#7cff6b', px: 80 });
      const n = Math.min(5, 3 + (r.upgrades.delivery ?? 0));
      for (let i = 0; i < n; i++) scooter(b, dx - 2.2 - i * 1.55, 0.6, 0, ['#ff8fab', '#ffd23f', '#5fd068', '#3fa7ff', '#ff6b35'][i]);
      b.box(dx - 2.2 - (n - 1) * 0.78, 0, 1.15, n * 1.55, 0.05, 0.08, '#9aa3ad'); // rack rail
      // order-ready shelf at the pickup hatch
      const sx = dx + dw / 2 + 0.9;
      b.box(sx, 0, 0.35, 1.2, 1.7, 0.4, '#5c6470'); for (const y of [0.55, 1.1]) b.box(sx, y, 0.35, 1.25, 0.04, 0.42, '#c9ced4');
      for (let i = 0; i < 4; i++) b.rbox(sx - 0.4 + (i % 3) * 0.4, i < 3 ? 0.59 : 1.14, 0.35, 0.3, 0.32, 0.25, i % 2 ? '#d9b48a' : '#ffffff', 0.03);
      b.sign(sx, 1.85, 0.56, 1.2, 0.3, '受取 PICK-UP', { bg: '#7cff6b', fg: '#1d1d24', px: 100 });
      b.collide(sx, 0.35, 1.2, 0.4, 1.7, false);
    }
  }

  /** Interiors that are not the classic bar. */
  private formatInterior(b: Builder, s: GameState, r: RestaurantState, th: typeof THEMES[number], L: ReturnType<typeof buildingLayout>, concept: string): void {
    const { w, d } = this.def, u = r.upgrades;
    const cw = L.counterX1 - L.counterX0;
    const na = activeSeats(PROPERTIES[this.def.id].kind, u.seats ?? 0, this.site.seats.length);
    const clearOfMenu = (x: number) => Math.abs(x - L.qx) > 1.2;
    const stool = (i: number, h = 0.45, c = '#3b2a20') => { const sp = localOf(this.def, this.site.seats[i]); b.cyl(sp.x, 0, sp.z, 0.17, 0.15, h, c, 10); };
    if (concept === 'kaiten') {
      // belt loop on the counter + moving plates (instanced, animated in animate())
      const x0 = L.counterX0 + 0.35, x1 = L.counterX1 - 0.35, zf = L.cz + 0.3, zb = L.cz - 0.12;
      for (const z of [zf, zb]) b.box((x0 + x1) / 2, 1.08, z, x1 - x0 + 0.26, 0.05, 0.26, '#c9d1d9');
      for (const x of [x0, x1]) b.box(x, 1.08, (zf + zb) / 2, 0.26, 0.05, zf - zb + 0.26, '#c9d1d9');
      b.box((x0 + x1) / 2, 1.08, (zf + zb) / 2, x1 - x0 - 0.26, 0.06, zf - zb - 0.26, '#8d96a3');
      const n = Math.max(8, Math.floor(((x1 - x0) * 2 + (zf - zb) * 2) / 0.5));
      const plates = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.09, 0.025, 14), new THREE.MeshStandardMaterial({ roughness: 0.4 }), n);
      const sg = (makeSushi('salmon_nigiri').geometry as THREE.BufferGeometry).clone();
      const sushi = new THREE.InstancedMesh(sg, (makeSushi('salmon_nigiri').material as THREE.Material), n);
      for (let i = 0; i < n; i++) plates.setColorAt(i, PLATE_COLORS[i % PLATE_COLORS.length]);
      plates.frustumCulled = sushi.frustumCulled = false;
      const frame = new THREE.Group(); frame.position.set(this.def.x, 0, this.def.z); frame.rotation.y = this.def.ry;
      frame.add(plates, sushi); this.group.add(frame);
      this.belt = { plates, sushi, x0, x1, zf, zb, t: 0 };
      this.animate(0);
      b.box(w / 2 - 0.15, 1.6, -d * 0.45, 0.06, 0.9, 2.6, '#14141f', '#2a0f20');
      b.sign(w / 2 - 0.19, 2.05, -d * 0.45, 2.4, 0.75, '回転寿司', { bg: '#14141f', fg: '#ff4f9a', px: 80, ry: -Math.PI / 2 });
      for (let x = -w / 2 + 1.5; x < w / 2 - 1; x += 2.5) for (let z = -1.5; z > -d + 3.5; z -= 2.8) if (clearOfMenu(x)) { b.add(G.cyl(0.01, 0.01, 0.7, 4), '#222', { at: [x, 2.9, z] }); b.add(G.cyl(0.24, 0.24, 0.12, 14), '#ffffff', { at: [x, 2.8, z], glow: '#fff6e6' }); }
      for (let i = 0; i < 5; i++) b.cyl(L.counterX0 + 0.3 + i * 0.16, 1.11, L.cz - 0.32, 0.11, 0.11, 0.1 + i * 0.03, PLATE_COLORS[i % 6].getStyle() === 'rgb(255,255,255)' ? '#ffffff' : '#e9ecef', 12);
      this.tables(b, th, true, '#d62839');
    } else if (concept === 'omakase') {
      for (let k = 0; k < Math.floor(w / 0.35); k++) b.box(-w / 2 + 0.2 + k * 0.35, 0.05, -d + 0.15, 0.12, 3.3, 0.04, '#8a6a4a');
      b.box(-w / 2 + 0.16, 0.9, -d * 0.55, 0.03, 1.9, 0.75, '#f6efe0');
      b.sign(-w / 2 + 0.19, 1.85, -d * 0.55, 0.62, 1.6, '一期一会', { bg: '#f6efe0', fg: '#1d1d1d', vertical: true, px: 80, ry: Math.PI / 2 });
      b.cyl(w / 2 - 0.8, 0, -1.2, 0.22, 0.18, 0.6, '#2d2d33', 12);
      for (let i = 0; i < 5; i++) b.add(G.cyl(0.015, 0.015, 0.9 + i * 0.12, 4), '#5c7a3a', { at: [w / 2 - 0.8 + (i - 2) * 0.06, 0.6, -1.2], rot: [0, 0, (i - 2) * 0.15] });
      b.box((L.counterX0 + L.counterX1) / 2, 3.18, L.cz - 0.1, cw, 0.06, 0.1, '#1d1d1d');
      for (let x = L.counterX0 + 0.8; x < L.counterX1; x += 1.2) if (clearOfMenu(x)) { b.box(x, 3.0, L.cz - 0.1, 0.03, 0.18, 0.03, '#1d1d1d'); b.add(G.cone(0.1, 0.2, 10), '#1d1d1d', { at: [x, 3.0, L.cz - 0.1], rot: [Math.PI, 0, 0], glow: '#ffe2b0' }); }
      noren(b, -w / 2 + 1.6, 2.3, -d + 0.2, 1.2, '#2a1d1a', '厨');
      b.box(-w / 2 + 1.6, 0.05, -d + 0.14, 1.2, 2.3, 0.04, '#1d1612');
      for (let i = 0; i < Math.min(na, this.site.seats.length); i++) stool(i, 0.5, '#2a1f1a');
      for (let x = L.counterX0 + 0.6; x < L.counterX1; x += 1.4) b.box(x, 1.13, L.cz + 0.3, 0.26, 0.015, 0.2, '#7aa35a'); // leaf plates per guest
      b.pool(L.qx, L.cz + 0.6, 2.6, '#ffcf8a');
    } else if (concept === 'kiosk') {
      b.box(-w / 2 + 0.3, 0, (-1.2 + L.cz + 2.0) / 2, 0.35, 0.78, -1.2 - L.cz - 2.0 + 0.6, '#d9d2c3'); // wall ledge
      b.collide(-w / 2 + 0.3, (-1.2 + L.cz + 2.0) / 2, 0.35, -1.2 - L.cz - 2.0 + 0.6, 0.8, false);
      for (const [a, c] of [[-w / 2 + 0.4, L.doorX - 1.2], [L.doorX + 1.2, w / 2 - 1.4]]) if (c - a > 0.5) { b.box((a + c) / 2, 0, -0.3, c - a, 0.78, 0.3, '#d9d2c3'); b.collide((a + c) / 2, -0.3, c - a, 0.3, 0.8, false); }
      for (let i = 0; i < Math.min(na, this.site.seats.length); i++) stool(i, 0.45, '#2a9d8f');
      b.box(w / 2 - 0.35, 0, -2.4, 0.5, 1.9, 1.8, '#d9dde2'); b.add(G.box(0.04, 1.6, 1.6), '#dff3ff', { at: [w / 2 - 0.6, 0.15, -2.4], glass: true });
      for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) b.rbox(w / 2 - 0.4, 0.25 + k * 0.4, -3.0 + j * 0.4, 0.3, 0.08, 0.3, ['#ff8a5c', '#5fae4b', '#d9364a', '#ffd23f'][(k + j) % 4], 0.02);
      b.collide(w / 2 - 0.35, -2.4, 0.5, 1.8, 1.9, false);
      for (let x = -w / 2 + 1.5; x < w / 2 - 1; x += 2.5) if (clearOfMenu(x)) b.box(x, 3.38, -d * 0.4, 1.4, 0.05, 0.5, '#ffffff', '#fff6e6'); // flush ceiling panels
    } else if (concept === 'ghost') {
      // kitchen only: steel racks of delivery bags, order tablets, stacked boxes
      for (const sx of [-1, 1]) {
        const x = sx * (w / 2 - 0.4);
        for (const zz of [-1.15, 1.15]) for (const xx of [-0.22, 0.22]) b.box(x + xx, 0, -d * 0.45 + zz, 0.04, 1.9, 0.04, '#8d96a3'); // open rack
        for (const y of [0.1, 0.62, 1.14, 1.66]) b.box(x, y, -d * 0.45, 0.5, 0.03, 2.4, '#b8c0ca');
        for (const y of [0.13, 0.65, 1.17]) for (let k = 0; k < 4; k++) b.rbox(x, y, -d * 0.45 - 0.9 + k * 0.6, 0.34, 0.32, 0.4, k % 2 ? '#d9b48a' : '#ffffff', 0.03);
        b.collide(x, -d * 0.45, 0.5, 2.4, 1.9, false);
      }
      for (let i = 0; i < 3; i++) b.box(L.counterX0 + 0.6 + i * 0.45, 1.08, L.cz + 0.1, 0.32, 0.22, 0.03, '#1d1d24', i === 1 ? '#7cff6b' : '#3a86ff');
      b.box(w / 2 - 0.14, 2.2, -d * 0.2, 0.06, 0.6, 2.6, '#1d1d24');
      b.sign(w / 2 - 0.18, 2.5, -d * 0.2, 2.4, 0.5, '注文 ORDERS · 出前', { bg: '#1d1d24', fg: '#7cff6b', px: 80, ry: -Math.PI / 2 });
      for (let x = -w / 2 + 1.5; x < w / 2 - 1; x += 2.5) if (clearOfMenu(x)) b.box(x, 3.38, -d * 0.45, 1.6, 0.05, 0.4, '#ffffff', '#eef6ff'); // flush ceiling panels
    }
  }

  /** Tables & stools for active seats (classic bar / kaiten). */
  private tables(b: Builder, th: typeof THEMES[number], tablets: boolean, stoolColor: string): void {
    const seats = this.site.seats;
    const na = activeSeats(PROPERTIES[this.def.id].kind, this.lastUpgrades.seats ?? 0, seats.length);
    for (let t = 0; t * 2 < seats.length; t++) {
      if (2 * t >= na) continue;
      const a = localOf(this.def, seats[2 * t]), c = localOf(this.def, seats[2 * t + 1]);
      const tx = (a.x + c.x) / 2, tz = (a.z + c.z) / 2;
      b.rbox(tx, 0, tz, 0.15, 0.7, 0.15, th.accent, 0.03);
      b.rbox(tx, 0.7, tz, 0.8, 0.06, 0.75, th.counter, 0.03);
      b.collide(tx, tz, 0.8, 0.75, 0.76, false);
      b.cyl(tx, 0.76, tz, 0.04, 0.04, 0.1, '#c0392b', 6);
      if (tablets) b.box(tx + 0.25, 0.76, tz - 0.25, 0.22, 0.16, 0.03, '#1d1d24', '#3a86ff');
      for (const sp of [a, c]) b.cyl(sp.x, 0, sp.z, 0.19, 0.16, 0.45, stoolColor, 10);
    }
  }
  private lastUpgrades: Record<string, number> = {};

  /** Chalkboard / wooden menu with Japanese item names and live prices. */
  private menuRect(s: GameState, r: RestaurantState): [number, number, number, number] {
    const items = r.menu.filter((m) => s.recipes.includes(m) && RECIPES[m]).slice(0, 7);
    const pm = r.priceMult;
    return this.atlas!.custom(320, 400, (c, x, y, w, h) => {
      c.fillStyle = '#6b4330'; c.fillRect(x, y, w, h);
      c.fillStyle = '#25221f'; c.fillRect(x + 12, y + 12, w - 24, h - 24);
      c.fillStyle = '#ffe7b3'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `700 44px ${FONT}`; c.fillText('お品書き', x + w / 2, y + 48);
      c.fillStyle = '#d6452c'; c.fillRect(x + 40, y + 78, w - 80, 3);
      c.font = `600 26px ${FONT}`;
      items.forEach((m, i) => {
        const yy = y + 112 + i * 38;
        c.textAlign = 'left'; c.fillStyle = '#ffffff'; c.fillText(RECIPES[m].jp, x + 30, yy);
        c.textAlign = 'right'; c.fillStyle = '#ffd166'; c.fillText('¥' + Math.round(RECIPES[m].price * pm).toLocaleString(), x + w - 30, yy);
      });
      c.textAlign = 'center'; c.fillStyle = '#bbbbbb'; c.font = `500 18px ${FONT}`; c.fillText('一貫の価格 · per piece', x + w / 2, y + h - 30);
    });
  }

  private interior(b: Builder, s: GameState, r: RestaurantState, th: typeof THEMES[number], L: ReturnType<typeof buildingLayout>): void {
    const { w, d, style } = this.def;
    const u = r.upgrades;
    const cw = L.counterX1 - L.counterX0, cx = (L.counterX0 + L.counterX1) / 2;
    const salary = this.def.id.startsWith('shinjuku');
    const lux = style === 'lux', modern = style === 'modern' && !salary;
    const clearOfMenu = (x: number) => Math.abs(x - L.qx) > 1.2;
    // sushi counter: thick hinoki slab for Ginza, white laminate for the city, warm wood in Asakusa
    b.rbox(cx, 0, L.cz, cw, 1.0, 0.7, th.accent, 0.04);
    b.rbox(cx, 1.0, L.cz + 0.05, cw + 0.1, lux ? 0.12 : 0.08, lux ? 1.0 : 0.9, th.counter, 0.03);
    b.collide(cx, L.cz, cw, 0.7, 1.05, false);
    // back counter (stainless kitchen)
    b.rbox(0, 0, -d + 0.4, w - 0.5, 0.95, 0.6, lux ? '#8a6a4a' : '#c9ccd2', 0.03);
    b.box(0, 0.95, -d + 0.4, w - 0.45, 0.05, 0.66, lux ? '#e9d3a8' : '#e9ecef');
    b.collide(0, -d + 0.4, w - 0.5, 0.6, 0.95, false);
    this.prepGear(b, L.prepX, 0.98, -d + 0.4, u.station ?? 0, false);
    for (let i = 0; i < (u.extra_station ?? 0) + Math.min(2, u.expand ?? 0); i++) {
      const x = L.prepX - 2.2 - i * 1.7;
      this.prepGear(b, x > -w / 2 + 0.8 ? x : L.prepX + 2.2 + (i - 1) * 1.7, 0.98, -d + 0.4, 0, true);
    }
    const concept = r.concept ?? 'bar';
    if ((u.fridge || lux || concept === 'omakase') && concept !== 'kaiten') this.netaCase(b, L.qx + 1.3, lux || concept === 'omakase' ? 1.12 : 1.08, L.cz - 0.05, Math.min(cw - 3, (lux || concept === 'omakase' ? 2.4 : 1.2) + (u.fridge ?? 0) * 1.0));
    if (concept !== 'kaiten' && u.register) b.rbox(L.counterX1 - 0.4, 1.08, L.cz + 0.1, 0.4, 0.25, 0.32, u.register >= 3 ? C.gold : '#4a4e58', 0.04);
    // painted menu board with live prices
    b.box(L.qx, 1.45, -d + 0.15, 1.75, 2.15, 0.05, C.woodD);
    b.panel(L.qx, 2.52, -d + 0.19, 1.6, 2.0, this.menuRect(s, r));
    if (concept !== 'bar') { this.formatInterior(b, s, r, th, L, concept); return; }
    // per-district character (classic bar)
    if (style === 'wood') {
      // noren over the kitchen doorway, hanging wooden menu tags, paper lanterns, kamidana, sake barrels
      b.box(-w / 2 + 1.6, 0.05, -d + 0.14, 1.2, 2.3, 0.04, '#3a2a22');
      noren(b, -w / 2 + 1.6, 2.3, -d + 0.2, 1.2, '#24345c', '厨');
      const tags = r.menu.filter((m) => RECIPES[m]).slice(0, 6);
      b.box(cx, 2.58, L.cz - 0.6, cw, 0.06, 0.06, C.woodD);
      tags.forEach((m, i) => b.sign(L.counterX0 + 0.6 + i * Math.min(0.55, (cw - 1) / Math.max(1, tags.length)), 2.2, L.cz - 0.6, 0.38, 0.7, RECIPES[m].jp.slice(0, 5), { bg: '#f3e6c8', fg: '#2a1d1a', vertical: true, px: 80 }));
      for (let i = 0; i < 3; i++) lantern(b, L.qx - 2 + i * 2.5, 2.3, -d * 0.45, i % 2 ? '#fff0d0' : C.red, 0.7);
      b.box(w / 2 - 1.4, 2.6, -d + 0.3, 1.2, 0.08, 0.4, C.woodL); b.add(hip(0.6, 0.35, 0.3), C.woodD, { at: [w / 2 - 1.4, 2.68, -d + 0.3] }); // kamidana
      for (let i = 0; i < 3; i++) b.cyl(-w / 2 + 0.6, i < 2 ? 0 : 0.62, -2.0 - (i % 2) * 0.65, 0.3, 0.3, 0.6, '#f4efe2', 12);
      for (let k = 0; k < Math.floor(d / 0.5); k++) b.box(w / 2 - 0.16, 0.05, -0.4 - k * 0.5, 0.03, 1.0, 0.06, '#8a5a3c'); // lattice wainscot
    } else if (salary) {
      // Shinjuku salaryman lunch counter: steel & dark wood, ticket machine, set-menu boards, a TV, bare bulbs
      b.box(cx, 0.15, L.cz + 0.36, cw, 0.06, 0.06, '#9aa3ad'); // foot rail
      b.push(w / 2 - 0.45, 0, -1.2, -Math.PI / 2);
      b.rbox(0, 0, 0, 0.8, 1.75, 0.6, '#d9dde2', 0.04);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) b.box(-0.27 + j * 0.27, 0.85 + i * 0.17, 0.31, 0.22, 0.12, 0.02, ['#ffd23f', '#ff8a5c', '#7cc46a', '#9ec5fe'][i], '#5a4a20');
      b.box(0, 0.35, 0.31, 0.5, 0.2, 0.03, '#2b2b30');
      b.sign(0, 1.6, 0.32, 0.62, 0.22, '食券 TICKETS', { bg: '#c1121f', fg: '#ffffff', px: 120 });
      b.collide(0, 0, 0.8, 0.6, 1.75, false);
      b.pop();
      const sets = r.menu.filter((m) => RECIPES[m]).slice(0, 4);
      sets.forEach((m, i) => {
        const rect = this.atlas!.custom(240, 160, (c, x, y, ww, hh) => {
          c.fillStyle = '#ffd23f'; c.fillRect(x, y, ww, hh); c.fillStyle = '#c1121f'; c.fillRect(x, y, ww, 34);
          c.fillStyle = '#fff'; c.font = `700 24px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('定食セット', x + ww / 2, y + 18);
          c.fillStyle = '#1d1d1d'; c.font = `700 30px ${FONT}`; c.fillText(RECIPES[m].jp.slice(0, 6) + '定食', x + ww / 2, y + 75);
          c.fillStyle = '#c1121f'; c.font = `700 32px ${FONT}`; c.fillText('¥' + Math.round(RECIPES[m].price * 6 * r.priceMult).toLocaleString(), x + ww / 2, y + 125);
        });
        b.panel(-w / 2 + 0.2, 2.1, -1.4 - i * 1.25, 1.05, 0.7, rect, Math.PI / 2);
      });
      b.box(-w / 2 + 0.35, 1.05, -d / 2, 0.4, 0.05, d * 0.5, '#b98a5a'); // stand-up ledge
      b.box(w / 2 - 0.2, 2.3, -d * 0.55, 0.1, 0.75, 1.25, '#1d1d24');
      b.box(w / 2 - 0.26, 2.36, -d * 0.55, 0.02, 0.63, 1.12, '#4a7ab8', '#3a6aa8'); // TV
      for (let x = -w / 2 + 1.5; x < w / 2 - 1; x += 1.8) if (clearOfMenu(x)) for (const z of [L.cz + 0.15, -d * 0.4]) { b.add(G.cyl(0.008, 0.008, 0.8, 4), '#222', { at: [x, 2.65, z] }); b.add(G.sphere(0.09, 8, 6), '#fff3d0', { at: [x, 2.6, z], glow: '#ffd27a' }); }
      for (let i = 0; i < 2; i++) b.cyl(L.counterX0 + 0.5 + i * 0.4, 1.08, L.cz + 0.1, 0.11, 0.11, 0.38, '#c0c6cc', 12); // tea urns
    } else if (modern) {
      // bright city sushi bar: wall neon, panel pendants, order tablets
      b.box(w / 2 - 0.15, 1.6, -d * 0.45, 0.06, 0.9, 2.6, '#14141f', '#2a0f20');
      b.sign(w / 2 - 0.19, 2.05, -d * 0.45, 2.4, 0.75, '寿司 SUSHI', { bg: '#14141f', fg: '#ff4f9a', px: 80, ry: -Math.PI / 2 });
      for (let x = -w / 2 + 1.5; x < w / 2 - 1; x += 2.5) for (let z = -1.5; z > -d + 3.5; z -= 2.8) if (clearOfMenu(x)) { b.add(G.cyl(0.01, 0.01, 0.7, 4), '#222', { at: [x, 2.9, z] }); b.add(G.cyl(0.22, 0.22, 0.12, 14), '#ffffff', { at: [x, 2.8, z], glow: '#fff6e6' }); }
      for (let i = 0; i < 4; i++) b.cyl(L.counterX0 + 0.4 + i * 0.15, 1.08, L.cz - 0.15, 0.12, 0.12, 0.12 + i * 0.02, '#e9ecef', 12); // plate stack
    } else {
      // Ginza: warm wood slats, calligraphy scroll, ikebana, spotlights, stone tiles
      for (let k = 0; k < Math.floor(w / 0.35); k++) b.box(-w / 2 + 0.2 + k * 0.35, 0.05, -d + 0.15, 0.12, 3.3, 0.04, '#a77b4f');
      b.box(-w / 2 + 0.16, 0.9, -d * 0.55, 0.03, 1.9, 0.75, '#f6efe0');
      b.sign(-w / 2 + 0.19, 1.85, -d * 0.55, 0.62, 1.6, '一期一会', { bg: '#f6efe0', fg: '#1d1d1d', vertical: true, px: 80, ry: Math.PI / 2 });
      b.cyl(w / 2 - 0.8, 0, -1.2, 0.22, 0.18, 0.6, '#2d2d33', 12);
      for (let i = 0; i < 5; i++) b.add(G.cyl(0.015, 0.015, 0.9 + i * 0.12, 4), '#5c7a3a', { at: [w / 2 - 0.8 + (i - 2) * 0.06, 0.6, -1.2], rot: [0, 0, (i - 2) * 0.15] });
      b.sphere(w / 2 - 0.85, 1.5, -1.2, 0.09, '#e63946'); b.sphere(w / 2 - 0.72, 1.62, -1.2, 0.08, '#ffffff');
      b.box((L.counterX0 + L.counterX1) / 2, 3.18, L.cz - 0.1, cw, 0.06, 0.1, '#1d1d1d'); // ceiling track
      for (let x = L.counterX0 + 0.8; x < L.counterX1; x += 1.4) if (clearOfMenu(x)) { b.box(x, 3.0, L.cz - 0.1, 0.03, 0.18, 0.03, '#1d1d1d'); b.add(G.cone(0.11, 0.22, 10), '#1d1d1d', { at: [x, 3.0, L.cz - 0.1], rot: [Math.PI, 0, 0], glow: '#fff0c8' }); }
      for (let i = 1; i < d / 1.0; i++) b.box(0, 0.05, -i * 1.0, w - 0.3, 0.004, 0.02, '#4e3d30');
      b.box(L.counterX0 + 1, 1.12, L.cz + 0.25, 0.25, 0.02, 0.18, '#7aa35a'); // bamboo leaf garnish plate
    }
    // ceiling lamps
    if (!modern) for (let x = -w / 2 + 2; x < w / 2 - 1; x += 3) for (const z of [L.cz + 0.1, -d * 0.35]) if (clearOfMenu(x)) {
      b.add(G.cyl(0.01, 0.01, 0.6, 4), '#222', { at: [x, 2.95, z] });
      b.add(G.cyl(0.12, 0.3, 0.3, 10), th.accent === '#d8b24a' || lux ? C.gold : '#f5e6c8', { at: [x, 2.65, z], glow: '#ffd89a' });
    }
    // tables & stools for active seats
    const seats = this.site.seats;
    const na = activeSeats(PROPERTIES[this.def.id].kind, u.seats ?? 0, seats.length);
    for (let t = 0; t * 2 < seats.length; t++) {
      if (2 * t >= na) continue;
      const a = localOf(this.def, seats[2 * t]), c = localOf(this.def, seats[2 * t + 1]);
      const tx = (a.x + c.x) / 2, tz = (a.z + c.z) / 2;
      b.rbox(tx, 0, tz, 0.15, 0.7, 0.15, th.accent, 0.03);
      b.rbox(tx, 0.7, tz, 0.8, 0.06, 0.75, th.counter, 0.03);
      b.collide(tx, tz, 0.8, 0.75, 0.76, false);
      b.cyl(tx, 0.76, tz, 0.04, 0.04, 0.1, '#c0392b', 6); // soy bottle
      if (modern) b.box(tx + 0.25, 0.76, tz - 0.25, 0.22, 0.16, 0.03, '#1d1d24', '#3a86ff'); // order tablet
      for (const sp of [a, c]) b.cyl(sp.x, 0, sp.z, 0.19, 0.16, 0.45, lux ? '#3b2a20' : th.accent === '#d8b24a' ? C.gold : modern ? '#e63946' : C.red, 10);
    }
    if (r.theme === 3) b.box(0, 3.3, -d / 2, w - 0.4, 0.06, 0.06, C.gold);
    b.pool(L.qx, -d * 0.4, Math.min(w, d) * 0.45, lux ? '#ffcf8a' : '#ffd9a0');
  }

  /** Cutting board & tools; level adds knives, rice tub, hood… */
  private prepGear(b: Builder, x: number, y: number, z: number, lvl: number, extra: boolean): void {
    b.rbox(x, y, z, 0.8, 0.05, 0.42, '#f3efe6', 0.02);
    b.add(makeSushiGeo(), '#ff8a5c', { at: [x - 0.15, y + 0.05, z], scale: [1, 1, 1] });
    if (extra) return;
    b.rbox(x + 0.55, y, z - 0.1, 0.3, 0.2, 0.3, '#d9d2c3', 0.06); // rice tub (hangiri)
    if (lvl >= 1) for (let i = 0; i < 3; i++) b.box(x - 0.5 + i * 0.07, y, z - 0.2, 0.03, 0.32, 0.02, '#cfd6df');
    if (lvl >= 2) b.cyl(x - 0.75, y, z, 0.17, 0.16, 0.3, '#ffffff', 12);
    if (lvl >= 3) for (let i = 0; i < 4; i++) b.cyl(x + 0.25 + i * 0.12, y, z + 0.12, 0.05, 0.04, 0.05, '#1d3557', 8);
    if (lvl >= 4) { b.box(x, y + 1.25, z, 1.8, 0.35, 0.7, '#b8c0ca'); }
    if (lvl >= 5) b.box(x - 0.5, y + 0.33, z - 0.2, 0.25, 0.04, 0.03, C.gold);
  }

  /** Glass refrigerated display case with fish slabs. */
  private netaCase(b: Builder, x: number, y: number, z: number, len: number): void {
    // low refrigerated case: base, fish on ice, frame and real (transparent) glass
    b.box(x, y, z, len, 0.05, 0.36, '#c9ced4');
    b.box(x, y + 0.05, z, len - 0.04, 0.02, 0.32, '#eef6fa');
    const fish = ['#ff8a5c', '#d9364a', '#ffb199', '#f48fb1', '#7a4a24'];
    for (let i = 0; i < Math.floor(len / 0.3); i++) b.rbox(x - len / 2 + 0.18 + i * 0.3, y + 0.07, z, 0.24, 0.05, 0.16, fish[i % 5], 0.02);
    for (const sx of [-len / 2 + 0.02, len / 2 - 0.02]) b.box(x + sx, y + 0.05, z, 0.03, 0.17, 0.34, '#9aa3ad');
    b.box(x, y + 0.21, z, len, 0.015, 0.34, '#9aa3ad');
    b.add(G.box(len - 0.04, 0.16, 0.33), '#dff3ff', { at: [x, y + 0.05, z], glass: true });
    b.add(G.box(len - 0.08, 0.012, 0.012), '#ffffff', { at: [x, y + 0.2, z - 0.1], glow: '#e8f6ff' }); // strip light
  }
}

// ================================================================ layouts
function buildingLayout(w: number, d: number, minSeats: number) {
  const doorX = -w / 2 + Math.max(2.6, w * 0.32);
  const qx = doorX;
  const cz = -d + 3.0;
  const counterX0 = -w / 2 + 0.3, counterX1 = w / 2 - 1.9;
  const prepX = qx + 1.3;
  const queue: [number, number, number][] = [];
  for (let i = 0; i < 6; i++) { const z = cz + 0.95 + i * 0.9; if (z > -0.9) break; queue.push([qx, z, Math.PI]); }
  const chefs: [number, number, number][] = [];
  for (const row of [-d + 1.15, -d + 1.85]) for (let x = -w / 2 + 0.8; x < w / 2 - 0.6; x += 0.9) {
    if (Math.abs(x - prepX) < 0.75 && row < -d + 1.5) continue;
    if (Math.abs(x - qx) < 0.9 && row > -d + 1.5) continue;
    chefs.push([x, row, Math.PI]);
  }
  chefs.sort((a, c) => (a[1] - c[1]) * 100 + Math.abs(a[0] - prepX) - Math.abs(c[0] - prepX));
  const servers: [number, number, number][] = [0, 1, 2, 3, 4].map((k) => [w / 2 - 0.9, cz + 1.0 + k * 0.9, Math.PI]);
  // seats: pairs of stools around 2-seat tables in two zones either side of the queue aisle
  const tables: [number, number][] = [];
  for (let z = cz + 2.7; z < -1.2; z += 1.75) {
    for (const [z0, z1] of [[-w / 2 + 0.45, qx - 1.1], [qx + 1.1, w / 2 - 1.8]]) {
      for (let x = z0 + 0.95; x + 0.95 <= z1 + 0.01; x += 1.95) tables.push([x, z]);
    }
  }
  tables.sort((a, c) => Math.hypot(a[0] - qx, a[1] - cz) - Math.hypot(c[0] - qx, c[1] - cz));
  const seats: [number, number, number][] = [];
  for (const [x, z] of tables) seats.push([x - 0.58, z, Math.PI / 2], [x + 0.58, z, -Math.PI / 2]);
  if (seats.length < minSeats) console.warn('site has only', seats.length, 'seats');
  return { doorX, qx, cz, counterX0, counterX1, prepX, queue, chefs, servers, seats };
}

function toSite(f: Builder, def: SiteDef, L: ReturnType<typeof buildingLayout>): RestaurantSite {
  const sp = ([x, z, y]: [number, number, number]) => f.spot(x, z, y);
  const { w, d } = def;
  const c1 = f.world(-w / 2, 0, -d), c2 = f.world(w / 2, 0, 0);
  return {
    id: def.id,
    door: f.spot(L.doorX, 1.4, Math.PI),
    counter: f.spot(L.qx, L.cz - 0.8, 0),
    prep: f.spot(L.prepX, -d + 1.1, Math.PI),
    queue: L.queue.map(sp), seats: L.seats.map(sp), chefs: L.chefs.map(sp), servers: L.servers.map(sp),
    cleaner: f.spot(L.qx - 1.7, -1.0, Math.PI), manager: f.spot(L.qx + 1.1, -0.6, 0),
    interior: { minX: Math.min(c1.x, c2.x), maxX: Math.max(c1.x, c2.x), minZ: Math.min(c1.z, c2.z), maxZ: Math.max(c1.z, c2.z) },
    sign: f.spot(L.doorX + 2.4, 1.1, Math.PI),
    counterTop: f.world(L.qx - 1.1, 1.08, L.cz + 0.05),
  };
}

function standSpots(f: Builder, id: string): RestaurantSite {
  const D = 2.8;
  const c1 = f.world(-2.6, 0, -D - 0.1), c2 = f.world(2.6, 0, 0.3);
  const queue = [0, 1, 2, 3, 4].map((i) => f.spot(-0.25, 0.95 + i * 0.95, Math.PI));
  // stools: 2 tables to the customer-left, beyond the standing area
  const seats = [[-4.6, 1.9], [-4.6, 3.6], [-6.4, 1.9], [-6.4, 3.6]].flatMap(([x, z]) => [f.spot(x - 0.55, z, Math.PI / 2), f.spot(x + 0.55, z, -Math.PI / 2)]);
  return {
    id,
    door: f.spot(-0.25, 5.9, Math.PI),
    counter: f.spot(-0.25, -1.15, 0),
    prep: f.spot(0.6, -D + 0.95, Math.PI),
    queue, seats,
    chefs: [[-0.6], [1.6], [-1.7], [2.0], [-1.2], [1.1], [-2.0], [0.0]].map(([x], i) => f.spot(x, i < 4 ? -D + 0.95 : -1.85, Math.PI)),
    servers: [f.spot(1.9, -1.2, 0), f.spot(-2.0, -1.2, 0), f.spot(2.0, -1.8, 0)],
    cleaner: f.spot(3.2, 1.2, Math.PI), manager: f.spot(-1.9, -1.9, 0),
    interior: { minX: Math.min(c1.x, c2.x), maxX: Math.max(c1.x, c2.x), minZ: Math.min(c1.z, c2.z), maxZ: Math.max(c1.z, c2.z) },
    sign: f.spot(3.2, 0.6, Math.PI),
    counterTop: f.world(-1.0, 1.08, -0.35),
  };
}

/** World spot → site-local coordinates. */
function localOf(def: SiteDef, sp: Spot): { x: number; z: number } {
  const dx = sp.x - def.x, dz = sp.z - def.z, c = Math.cos(-def.ry), s = Math.sin(-def.ry);
  return { x: dx * c + dz * s, z: -dx * s + dz * c };
}

let sushiGeo: THREE.BufferGeometry | null = null;
function makeSushiGeo(): THREE.BufferGeometry {
  sushiGeo ??= (makeSushi('salmon_nigiri').geometry as THREE.BufferGeometry);
  const g = sushiGeo.clone();
  g.deleteAttribute('color');
  return g;
}
void makePlate;

/** Beckoning cat statue (gold). */
export function maneki(b: Builder, x: number, y: number, z: number, s: number): void {
  const gold = C.gold;
  b.box(x, y, z, 0.5 * s, 0.12 * s, 0.4 * s, '#c0392b');
  b.add(G.sphere(0.2 * s), gold, { at: [x, y + 0.33 * s, z], scale: [1, 1.15, 0.9], glow: '#6b5210' });
  b.add(G.sphere(0.17 * s), gold, { at: [x, y + 0.66 * s, z], glow: '#6b5210' });
  for (const sx of [-1, 1]) b.add(G.cone(0.06 * s, 0.1 * s, 4), gold, { at: [x + sx * 0.1 * s, y + 0.78 * s, z] });
  b.add(G.sphere(0.06 * s), gold, { at: [x + 0.18 * s, y + 0.75 * s, z + 0.03 * s], scale: [1, 1.6, 1], glow: '#6b5210' });
  b.box(x, y + 0.48 * s, z + 0.14 * s, 0.14 * s, 0.03 * s, 0.03 * s, '#c0392b');
  b.sphere(x, y + 0.45 * s, z + 0.17 * s, 0.035 * s, '#ffd23f');
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
}

// ================================================================ rival storefronts & HQ
export class RivalView {
  group = new THREE.Group();
  colliders: Collider[] = [];
  private hash = '';
  constructor(public rid: string, public district: string, private x: number, private z: number, private ry: number, private w: number, private style: Style, private atlas: Atlas) {}

  refresh(s: GameState): boolean {
    const gone = s.rivals[this.rid]?.[this.district as keyof (typeof s.rivals)[string]] === undefined;
    const h = `${gone}|${s.player.company}`;
    if (h === this.hash) return false;
    this.hash = h;
    for (const c of [...this.group.children]) { this.group.remove(c); disposeTree(c); }
    const def = RIVALS[this.rid];
    const b = new Builder(this.atlas, 1000).push(this.x, 0, this.z, this.ry);
    const r = rng(this.rid.length * 31 + this.x);
    building(b, {
      x: 0, w: this.w, d: 9, floors: this.style === 'modern' ? 4 : 2, style: this.style, r, color: gone ? '#c9c4ba' : def.color,
      shop: gone ? `${s.player.company}` : def.name, sub: gone ? 'ACQUIRED · 買収済み' : '回転寿司 · conveyor sushi', shopColor: gone ? '#c9a227' : def.color,
      vertical: gone ? undefined : def.name.slice(0, 6), verticalColor: def.color, awning: gone ? undefined : def.color,
    });
    if (!gone) {
      // conveyor belt with plates visible in the window
      b.box(0, 0.8, -0.8, this.w - 1.4, 0.12, 0.4, '#b8c0ca');
      for (let i = 0; i < 8; i++) b.cyl(-this.w / 2 + 1 + i * ((this.w - 2) / 8), 0.92, -0.8, 0.13, 0.11, 0.03, ['#ffffff', '#ffd23f', '#e63946'][i % 3], 10);
      nobori(b, this.w / 2 - 0.3, 1.1, 'SALE', def.color);
    } else b.box(0, 0.2, 0.06, this.w - 1, 2.4, 0.06, '#9aa0a8');
    this.group.add(b.build());
    this.colliders = b.colliders;
    return true;
  }
}

export class HQView {
  group = new THREE.Group();
  colliders: Collider[] = [];
  private hash = '';
  private plaque = new Plaque();
  constructor(private x: number, private z: number, private ry: number) {}

  refresh(s: GameState): boolean {
    const h = `${!!s.flags.chapter2}|${s.hq}|${s.player.company}`;
    if (h === this.hash) return false;
    this.hash = h;
    for (const c of [...this.group.children]) { this.group.remove(c); disposeTree(c); }
    const b = new Builder(null, 1000).push(this.x, 0, this.z, this.ry);
    const W = 18, D = 16;
    if (!s.flags.chapter2) {
      // construction site: fence, crane, dirt, cones
      b.box(0, 0, -D / 2, W, 0.06, D, '#a68a64');
      for (let i = 0; i <= 9; i++) b.box(-W / 2 + i * 2, 0, 0, 0.1, 2.2, 0.1, '#cfd4da');
      b.box(-W / 4 - 1, 0.2, 0, W / 2 - 2, 1.8, 0.05, '#f4f1ea'); b.box(W / 4 + 1, 0.2, 0, W / 2 - 2, 1.8, 0.05, '#f4f1ea');
      for (const sx of [-1, 1]) b.box(sx * W / 2, 0.2, -D / 2, 0.05, 1.8, D, '#f4f1ea');
      b.box(0, 0.2, -D, W, 1.8, 0.05, '#f4f1ea');
      b.collide(0, 0, W, 0.4, 2.2); b.collide(-W / 2, -D / 2, 0.4, D, 2.2); b.collide(W / 2, -D / 2, 0.4, D, 2.2); b.collide(0, -D, W, 0.4, 2.2);
      b.box(3, 0, -9, 0.9, 26, 0.9, '#f2b134');
      for (let k = 0; k < 13; k++) b.box(3, k * 2, -9, 1.0, 0.08, 1.0, '#c98a17');
      b.box(-2, 26, -9, 16, 0.8, 0.8, '#f2b134');
      b.box(-9.5, 20, -9, 0.08, 6, 0.08, '#333');
      b.box(-2, 0, -7, 6, 1.4, 4, '#8a8f98'); b.box(-2, 1.4, -7, 3, 0.8, 2.5, '#a7adb5');
      this.plaque.draw('COMING SOON · 本社建設予定地', '#ffd23f', '#1d3557', 'Future Headquarters');
      const m = this.plaque.mesh(4, 1.25); m.position.set(0, 1.5, 0.08);
      const g = new THREE.Group(); g.position.set(this.x, 0, this.z); g.rotation.y = this.ry; g.add(m); this.group.add(g);
    } else {
      const floors = 2 + s.hq * 2;
      const h = 4.5 + floors * 3.6;
      b.box(0, 0, -D / 2, W + 4, 0.1, D + 4, '#d6d2ca');
      b.box(0, 0, -D / 2 - 1, W, h, D - 2, '#2e3a4f');
      for (let f = 0; f < floors; f++) b.box(0, 4.5 + f * 3.6 + 0.6, 0.02 - 1, W - 0.4, 2.4, 0.06, '#7fb2d6', f % 3 === 1 ? '#000000' : '#ffe2a6');
      for (let i = 0; i <= 6; i++) b.box(-W / 2 + i * (W / 6), 4.5, 0.05 - 1, 0.2, h - 4.5, 0.15, '#dfe6ee');
      b.box(0, 0, 0.1 - 1, 8, 3.8, 0.1, '#b9d8ea', '#fff3cf');
      b.box(0, 3.9, 0.5 - 1, 10, 0.3, 2.6, '#dfe6ee');
      b.box(0, h, -D / 2 - 1, W - 2, 3, D - 6, '#3b4a63');
      b.cyl(0, h + 3, -D / 2 - 1, 0.15, 0.15, 6, '#ccc', 6);
      b.add(G.sphere(0.25), '#ff3b3b', { at: [0, h + 9.1, -D / 2 - 1], glow: '#ff2a2a' });
      b.collide(0, -D / 2 - 1, W, D - 2, h);
      for (const x of [-6, 6]) nobori(b, x, 1.2, '本社', '#c9a227');
      maneki(b, -5, 0.1, 0.5, 1.4);
      this.plaque.draw(s.player.company, '#c9a227', '#1d1d1d', `HEADQUARTERS · ${s.hq} / 10`);
      this.plaque.mat.emissiveIntensity = 0.6;
      const g = new THREE.Group(); g.position.set(this.x, 0, this.z); g.rotation.y = this.ry;
      const m1 = this.plaque.mesh(9, 2.8); m1.position.set(0, h + 1.5, -1 - 2.95); g.add(m1);
      const m2 = this.plaque.mesh(5, 1.5); m2.position.set(0, 4.8, -0.85); g.add(m2);
      this.group.add(g);
    }
    this.group.add(b.build());
    this.colliders = b.colliders;
    return true;
  }
}

export { FONT, hip };
