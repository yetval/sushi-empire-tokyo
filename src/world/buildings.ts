// Parametric street buildings for the "architect's model of Tokyo" look. Every building is assembled from a seeded
// generator per archetype (machiya, kanban-front shop, shotengai shop, mixed-use, walk-up apartments, pencil
// building, glass office, Ginza stone): a bevelled mass, then repeated detail (window bays, railings, AC units,
// tanks, doors, stairs) as instanced prototypes so streets can be dense without merging tens of thousands of parts.
// Facade at local z=0 faces +z, the body runs to z=-d. Ground floor shopfronts come from props.groundFloor().
import { Builder, G, Proto, proto } from './kit';
import { BuildingOpts, ShopKind, Style, TENANTS, gable, groundFloor, hip, pickOf, shadeHex } from './props';

// ================================================================ looks per district
export type Arch = 'machiya' | 'kanban' | 'shotengai' | 'mixed' | 'walkup' | 'pencil' | 'office' | 'stone';
export interface Look {
  mix: [Arch, number][];
  floors: Partial<Record<Arch, [number, number]>>;
  walls: Partial<Record<Arch, string[]>>;
  neon: boolean;
  /** Probability that a window is lit at night, and the lamp colours used. */
  lit: number; lamps: string[];
}
const WARM = ['#e8a85e', '#f0b870', '#dc9a52', '#f2c48a'];
const MIXED_LAMPS = ['#e8a85e', '#f0b870', '#c9d3e0', '#dc9a52', '#bcc8d8'];
const OFFICE_LAMPS = ['#b9c4d2', '#aebbcb', '#cbbfa6', '#c2cad6'];
const TILES = ['#e6e0d4', '#d9d3c8', '#cdcac3', '#e2c5bb', '#b6c8d5', '#e3d3b6', '#c2d7cb', '#c8c1d5', '#ebdfae', '#d3aa91', '#b8c4ab', '#ddd6ca'];
export const LOOKS: Record<'asakusa' | 'shibuya' | 'shinjuku' | 'ginza', Look> = {
  asakusa: {
    mix: [['machiya', 0.5], ['kanban', 0.18], ['shotengai', 0.27], ['mixed', 0.05]],
    floors: { machiya: [2, 3], kanban: [2, 3], shotengai: [3, 4], mixed: [4, 5] },
    walls: { machiya: ['#efe6d4', '#e8dcc6', '#f3ecdf', '#e4d6bd'], kanban: ['#8fae9f', '#9cb7aa', '#d8d0c2', '#cfc6b5', '#a7bcb0'], shotengai: ['#e6dccb', '#d9cfbd', '#e9e1d2', '#d3aa91', '#e3d3b6', '#c9c4b9'], mixed: ['#ddd6ca', '#e3d3b6', '#cdcac3'] },
    neon: false, lit: 0.5, lamps: WARM,
  },
  shibuya: {
    mix: [['pencil', 0.3], ['mixed', 0.36], ['walkup', 0.1], ['shotengai', 0.1], ['office', 0.14]],
    floors: { pencil: [6, 9], mixed: [5, 8], walkup: [5, 7], shotengai: [3, 4], office: [7, 10] },
    walls: { pencil: TILES, mixed: TILES, walkup: ['#e9e5dc', '#dcd8cf', '#e6dccb', '#cfd6d8'], shotengai: TILES },
    neon: true, lit: 0.55, lamps: MIXED_LAMPS,
  },
  shinjuku: {
    mix: [['office', 0.34], ['mixed', 0.26], ['pencil', 0.2], ['walkup', 0.1], ['shotengai', 0.1]],
    floors: { office: [8, 13], mixed: [6, 9], pencil: [7, 10], walkup: [6, 8], shotengai: [3, 4] },
    walls: { pencil: ['#cdcac3', '#b6c8d5', '#d9d3c8', '#c8c1d5', '#a8b3ba', '#e2c5bb'], mixed: ['#cfd3d4', '#d9d3c8', '#c2cbd0', '#e3d3b6', '#b8c0c4', '#d3aa91'], walkup: ['#dcd8cf', '#cfd6d8', '#e2ddd3'], shotengai: ['#d9d3c8', '#c9c4b9', '#d3aa91'] },
    neon: true, lit: 0.55, lamps: MIXED_LAMPS,
  },
  ginza: {
    mix: [['stone', 0.5], ['office', 0.34], ['mixed', 0.16]],
    floors: { stone: [5, 8], office: [7, 10], mixed: [5, 7] },
    walls: { stone: ['#ebe4d6', '#ded5c3', '#f1ece2', '#d8cdb8', '#e6dccb'], mixed: ['#efe8da', '#e3d9c7', '#d9d2c5'] },
    neon: false, lit: 0.5, lamps: ['#e8b878', '#f0c890', '#e0b070', '#d8c8a8'],
  },
};
const LOOK_BY_STYLE: Record<Style, Look> = { wood: LOOKS.asakusa, modern: LOOKS.shibuya, lux: LOOKS.ginza, tower: LOOKS.shinjuku };
const ARCH_BY_STYLE: Record<Style, Arch> = { wood: 'machiya', modern: 'mixed', lux: 'stone', tower: 'office' };
const WIDTH: Record<Arch, [number, number]> = {
  machiya: [4.5, 7.5], kanban: [4.6, 6.8], shotengai: [5, 8.5], mixed: [6.5, 10.5], walkup: [9.5, 14], pencil: [3.8, 5.2], office: [10, 16], stone: [8.5, 14],
};

export type BOpts = BuildingOpts & { arch?: Arch; look?: Look };
const pickW = <T>(r: () => number, mix: [T, number][]): T => { let t = r() * mix.reduce((a, m) => a + m[1], 0); for (const [v, w] of mix) if ((t -= w) <= 0) return v; return mix[0][0]; };

// ================================================================ prototypes (defined once, instanced everywhere)
// Unit size 1×1 unless noted; instances scale to the real bay. Glass/lit parts are added with a glow colour so
// they carry emask=1: instance colour tints them by day, the instance glow lights them at night.
const GL = '#ffffff';
/** A flat pane (2 triangles) facing +z, bottom-centred at (x,y,z). Glass never needs a back or sides. */
const pane = (b: Builder, x: number, y: number, z: number, w: number, h: number, color = '#ffffff', glow: string | undefined = GL) =>
  b.add(G.plane(w, h).translate(0, h / 2, 0), color, { at: [x, y, z], glow });
function sashProto(name: string, frame: string, sill: string): Proto {
  return proto(name, (b) => {
    pane(b, 0, 0.04, 0.01, 0.93, 0.92);
    b.box(0, 0, 0, 1, 0.05, 0.07, frame); b.box(0, 0.95, 0, 1, 0.05, 0.07, frame);
    b.box(-0.475, 0, 0, 0.05, 1, 0.07, frame); b.box(0.475, 0, 0, 0.05, 1, 0.07, frame);
    b.box(0.0, 0.04, 0.02, 0.035, 0.92, 0.05, frame); // meeting rail of the sliding sashes
    b.box(0, -0.055, 0.01, 1.1, 0.055, 0.15, sill);
  });
}
export const P = {
  sash: () => sashProto('win-sash', '#c3c7cb', '#d6d2ca'),
  sashDark: () => sashProto('win-sash-dark', '#4a4b4e', '#c9c4ba'),
  sashWhite: () => sashProto('win-sash-white', '#eeece8', '#dcd8d0'),
  wood: () => proto('win-wood', (b) => {
    const t = '#5b4334';
    pane(b, 0, 0.04, 0.01, 0.92, 0.92);
    b.box(0, 0, 0, 1, 0.06, 0.08, t); b.box(0, 0.94, 0, 1, 0.06, 0.08, t);
    b.box(-0.47, 0, 0, 0.06, 1, 0.08, t); b.box(0.47, 0, 0, 0.06, 1, 0.08, t);
    for (let k = 1; k < 6; k++) b.box(-0.47 + k * 0.157, 0.05, 0.035, 0.022, 0.9, 0.03, t); // koshi lattice
    b.box(0, 0.5, 0.035, 0.92, 0.022, 0.03, t);
    b.box(0, -0.06, 0.01, 1.12, 0.06, 0.13, '#6b5141');
  }),
  lux: () => proto('win-lux', (b) => {
    const st = '#efe8da', br = '#5e5040';
    pane(b, 0, 0.05, 0.01, 0.84, 0.9);
    b.box(-0.47, 0, 0, 0.1, 1, 0.06, st); b.box(0.47, 0, 0, 0.1, 1, 0.06, st); // stone surround
    b.box(0, 0.95, 0, 1.04, 0.07, 0.07, st);
    b.box(0, 0.02, 0.02, 0.86, 0.03, 0.04, br); b.box(0, 0.93, 0.02, 0.86, 0.03, 0.04, br);
    b.box(-0.41, 0.02, 0.02, 0.025, 0.92, 0.04, br); b.box(0.41, 0.02, 0.02, 0.025, 0.92, 0.04, br);
    b.box(0, 0.76, 0.02, 0.84, 0.025, 0.04, br); b.box(0, 0.05, 0.02, 0.02, 0.71, 0.04, br); // transom + mullion
    b.add(G.bbox(1.16, 0.07, 0.16, 0.02), st, { at: [0, 1.02, 0.02] }); // cornice ledge
    b.add(G.bbox(1.1, 0.06, 0.16, 0.02), st, { at: [0, -0.06, 0.02] });
  }),
  /** Curtain-wall bay: vision glass over a spandrel, mullion on the left edge (tile left to right, close the run). */
  office: () => proto('win-office', (b) => {
    pane(b, 0, 0.3, 0.0, 1, 0.7);
    pane(b, 0, 0, 0.0, 1, 0.3, '#59626b', undefined);
    b.box(-0.49, 0, 0, 0.035, 1, 0.1, '#c9cdd1');
    b.box(0, 0.975, 0, 1, 0.025, 0.06, '#c9cdd1');
  }),
  officeDark: () => proto('win-office-dark', (b) => {
    pane(b, 0, 0.26, 0.0, 1, 0.74);
    pane(b, 0, 0, 0.0, 1, 0.26, '#2f3338', undefined);
    b.box(-0.49, 0, 0, 0.03, 1, 0.12, '#3b3e44');
    b.box(0, 0.98, 0, 1, 0.02, 0.05, '#3b3e44');
  }),
  /** Distant tower bay: four planes (glass, spandrel, mullion and transom lines drawn slightly proud). */
  officeFar: () => proto('win-office-far', (b) => {
    pane(b, 0, 0.28, 0.0, 1, 0.72);
    pane(b, 0, 0, 0.0, 1, 0.28, '#4f575f', undefined);
    pane(b, -0.485, 0, 0.04, 0.04, 1, '#c9cdd1', undefined);
    pane(b, 0, 0.97, 0.04, 1, 0.03, '#c9cdd1', undefined);
  }),
  /** Balcony sliding doors, 1×1 (scale ~1.7×2.0). */
  slide: () => proto('win-slide', (b) => {
    const f = '#c3c7cb';
    pane(b, 0, 0.03, -0.01, 0.96, 0.94);
    b.box(0, 0, 0, 1, 0.03, 0.08, f); b.box(0, 0.97, 0, 1, 0.03, 0.06, f);
    b.box(-0.485, 0, 0, 0.03, 1, 0.06, f); b.box(0.485, 0, 0, 0.03, 1, 0.06, f);
    b.box(0.02, 0.03, 0.0, 0.04, 0.94, 0.06, f);
  }),
  /** Apartment door (0.9×2.05 real size) with its porch lamp (lit part). Tint: door leaf. */
  door: () => proto('door-apt', (b) => {
    b.box(0, 0, 0, 1.0, 2.15, 0.04, '#8a8d90');
    b.box(0, 0, 0.02, 0.86, 2.02, 0.04, '#ffffff');
    b.box(0.32, 0.95, 0.06, 0.04, 0.16, 0.04, '#5a5c60');
    b.box(0.0, 1.6, 0.05, 0.22, 0.08, 0.01, '#2f3136');
    b.add(G.bbox(0.18, 0.12, 0.1, 0.02), '#fff6e6', { at: [-0.62, 2.0, 0.05], glow: '#ffffff' });
  }, { tint: 'body' }),
  ac: () => proto('ac-unit', (b) => {
    b.add(G.bbox(0.8, 0.55, 0.28, 0.03), '#ffffff', { at: [0, 0, 0.14] });
    b.add(G.cyl(0.19, 0.19, 0.02, 16), '#7f858c', { at: [-0.12, 0.275, 0.285], rot: [Math.PI / 2, 0, 0] });
    b.add(G.cyl(0.05, 0.05, 0.025, 10), '#5c6168', { at: [-0.12, 0.275, 0.29], rot: [Math.PI / 2, 0, 0] });
    for (let k = 0; k < 5; k++) b.box(0.24, 0.08 + k * 0.08, 0.285, 0.18, 0.012, 0.01, '#9aa0a6');
    b.box(0.34, 0.15, -0.02, 0.05, 0.05, 0.08, '#d9d5cf'); // pipe cover to the wall
  }, { shadow: true, tint: 'body' }),
  /** Railing bay (1 wide × 1 tall): top & bottom rails and balusters. Tint: metal. */
  rail: () => proto('rail-bay', (b) => {
    b.add(G.bbox(1, 0.045, 0.06, 0.012), '#ffffff', { at: [0, 0.955, 0] });
    b.box(0, 0.07, 0, 1, 0.03, 0.04, '#ffffff');
    for (let k = 0; k < 9; k++) b.box(-0.45 + k * 0.1125, 0.07, 0, 0.018, 0.89, 0.018, '#ffffff');
    b.box(-0.49, 0, 0, 0.035, 0.96, 0.035, '#ffffff');
  }, { tint: 'body' }),
  /** Balcony panel: frosted/solid sheet with a cap rail. Tint: panel. */
  panel: () => proto('rail-panel', (b) => {
    b.box(0, 0.06, 0, 0.98, 0.84, 0.03, '#ffffff');
    b.add(G.bbox(1, 0.06, 0.08, 0.015), '#c9ccd0', { at: [0, 0.9, 0] });
    b.box(-0.49, 0, 0, 0.03, 0.9, 0.04, '#c9ccd0');
  }, { tint: 'body' }),
  tankBox: () => proto('tank-frp', (b) => {
    for (const [x, z] of [[-0.85, -0.65], [0.85, -0.65], [-0.85, 0.65], [0.85, 0.65]]) b.box(x, 0, z, 0.08, 0.7, 0.08, '#7b8087');
    b.box(0, 0.62, 0, 1.9, 0.06, 1.5, '#7b8087');
    b.add(G.bbox(2.0, 1.4, 1.6, 0.05), '#ffffff', { at: [0, 0.68, 0] });
    for (let k = 1; k < 4; k++) b.box(-1 + k * 0.5, 0.7, 0.805, 0.025, 1.36, 0.01, '#c4cacf');
    b.box(0, 1.15, 0.805, 2.0, 0.025, 0.01, '#c4cacf');
    b.add(G.cyl(0.18, 0.18, 0.08, 12), '#c4cacf', { at: [0.5, 2.08, 0.2] });
    for (const x of [1.04, 1.24]) b.box(x, 0, 0.3, 0.03, 2.1, 0.03, '#7b8087');
    for (let k = 0; k < 7; k++) b.box(1.14, 0.25 + k * 0.28, 0.3, 0.22, 0.025, 0.025, '#7b8087');
  }, { shadow: true, tint: 'body' }),
  tankCyl: () => proto('tank-cyl', (b) => {
    for (const [x, z] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) b.box(x, 0, z, 0.08, 0.9, 0.08, '#7b8087');
    b.add(G.cyl(0.85, 0.85, 1.5, 20), '#ffffff', { at: [0, 0.9, 0] });
    b.add(G.cone(0.88, 0.28, 20), '#ffffff', { at: [0, 2.4, 0] });
    b.add(G.cyl(0.87, 0.87, 0.05, 20), '#c4cacf', { at: [0, 1.55, 0] });
  }, { shadow: true, tint: 'body' }),
  antenna: () => proto('antenna', (b) => {
    b.cyl(0, 0, 0, 0.03, 0.035, 3.2, '#8d9298', 6);
    for (const [y, L, n] of [[2.9, 1.3, 7], [2.3, 0.9, 5]] as const) {
      b.box(0, y, 0, 0.025, 0.025, L, '#8d9298');
      for (let k = 0; k < n; k++) b.box(0, y, -L / 2 + 0.08 + k * (L - 0.16) / (n - 1), 0.5 - k * 0.04, 0.012, 0.012, '#8d9298');
    }
    for (const a of [0, 2.1, 4.2]) b.add(G.cyl(0.006, 0.006, 2.2, 3), '#6b7076', { at: [Math.sin(a) * 0.8, 0, Math.cos(a) * 0.8], rot: [Math.cos(a) * -0.35, 0, Math.sin(a) * 0.35] });
  }),
  condenser: () => proto('condenser', (b) => {
    b.add(G.bbox(1.7, 1.0, 0.9, 0.04), '#ffffff', { at: [0, 0.08, 0] });
    b.box(0, 0, 0, 1.6, 0.08, 0.8, '#6b7076');
    for (const x of [-0.42, 0.42]) { b.add(G.cyl(0.33, 0.33, 0.04, 16), '#5f656c', { at: [x, 1.08, 0] }); b.add(G.cyl(0.08, 0.08, 0.06, 8), '#3d4146', { at: [x, 1.1, 0] }); }
    for (let k = 0; k < 7; k++) b.box(-0.8 + 0.05, 0.2 + k * 0.1, 0.455, 1.55, 0.015, 0.01, '#b7bcc1');
  }, { shadow: true, tint: 'body' }),
  /** Drain pipe, 1 m tall (scale y), with a bracket. */
  pipe: () => proto('drainpipe', (b) => {
    b.add(G.cyl(0.045, 0.045, 1, 8), '#ffffff', { at: [0, 0, 0.09] });
    b.box(0, 0.45, 0.045, 0.1, 0.03, 0.09, '#ffffff');
  }, { tint: 'body' }),
  /** One storey of exterior steel stair (1 tall, scale y): two flights and a landing, seen side-on along x. */
  stair: () => proto('ext-stair', (b) => {
    const c = '#ffffff';
    b.add(G.box(1.1, 0.06, 1.0), c, { at: [0, 0, -0.5], rot: [0, 0, 0] });
    b.add(G.box(1.4, 0.07, 0.95), c, { at: [-0.1, 0.25, 0.5], rot: [0, 0, 0.62] });
    b.add(G.box(1.4, 0.07, 0.95), c, { at: [0.1, 0.25, -0.48], rot: [0, 0, -0.62] });
    b.box(0, 0.5, 0, 1.2, 0.05, 2.0, c);
    b.box(-0.58, 0.5, 0, 0.04, 0.5, 2.0, c); b.box(0, 0.98, 0.98, 1.2, 0.04, 0.04, c); b.box(0, 0.98, -0.98, 1.2, 0.04, 0.04, c);
    for (const z of [-0.98, 0.98]) b.box(0.58, 0, z, 0.06, 1.0, 0.06, c);
  }, { shadow: true, tint: 'body' }),
  /** Small vertical sign box (1 wide x 1 tall) with a lit face; the atlas lettering sits in front. */
  shutter: () => proto('shutter', (b) => {
    b.box(0, 0, 0, 1, 1, 0.03, '#ffffff');
    for (let k = 0; k < 14; k++) b.box(0, 0.04 + k * 0.068, 0.017, 1, 0.012, 0.012, '#c2c6ca');
    b.box(0, 0.98, 0.0, 1.04, 0.06, 0.12, '#9aa0a6');
  }, { tint: 'body' }),
  laundry: () => proto('laundry', (b) => {
    b.add(G.cyl(0.012, 0.012, 1, 4), '#c9ccd0', { at: [-0.5, 1.0, 0], rot: [0, 0, -Math.PI / 2] });
    const cols = ['#ffffff', '#b9cde3', '#f1d9d2', '#e8e0c8', '#d4dcc8', '#ffffff'];
    for (let k = 0; k < 5; k++) b.box(-0.42 + k * 0.2, 0.5 + (k % 2) * 0.1, 0, 0.15, 0.48 - (k % 2) * 0.1, 0.02, cols[k]);
  }),
};

// ================================================================ shared facade pieces
const lit = (r: () => number, L: Look, p = L.lit): string | undefined => (r() < p ? pickOf(r, L.lamps) : undefined);
const GLASS_DAY = ['#93a6b6', '#a3b4c2', '#8a9cad', '#b2bfca', '#9fb0bd', '#d8cfbf', '#cfc7b6'];
export const glassTint = (r: () => number) => pickOf(r, GLASS_DAY);

/** Bevelled main mass from y0 to y1 (facade plane at z=z0, body back to -d). */
function mass(b: Builder, x: number, w: number, y0: number, y1: number, z0: number, d: number, color: string): void {
  b.add(G.bbox(w, y1 - y0, d + z0, 0.07), color, { at: [x, y0, (z0 - d) / 2] });
}
/** Window bays across a facade row (instanced), centred in [x-w/2+m, x+w/2-m]. Returns bay centres. */
function bays(w: number, pitch: number, margin: number): number[] {
  const n = Math.max(1, Math.round((w - margin * 2) / pitch));
  const span = w - margin * 2;
  return Array.from({ length: n }, (_, i) => -span / 2 + (i + 0.5) * (span / n));
}
function windows(b: Builder, p: Proto, x: number, w: number, y: number, ww: number, wh: number, pitch: number, margin: number, r: () => number, L: Look, z = 0): void {
  for (const bx of bays(w, pitch, margin)) b.inst(p, x + bx, y, z, { s: [ww, wh, 1], color: glassTint(r), glow: lit(r, L) });
}
/** Flat roof: parapet ring with a bevelled coping, membrane, and roof clutter (tank, penthouse, condensers, antenna). */
export function flatRoof(b: Builder, x: number, w: number, d: number, h: number, wall: string, r: () => number, o: { tank?: number; rail?: boolean; plant?: boolean } = {}): void {
  const cop = shadeHex(wall, 1.06), pw = 0.18, ph = o.rail ? 0.25 : 0.75;
  b.box(x, h, -d / 2, w - 0.3, 0.03, d - 0.3, '#a6a8a3');
  for (const [px, pz, sw, sd] of [[x, -pw / 2, w, pw], [x, -d + pw / 2, w, pw], [x - w / 2 + pw / 2, -d / 2, pw, d], [x + w / 2 - pw / 2, -d / 2, pw, d]] as const)
    b.add(G.bbox(sw, ph, sd, 0.03), wall, { at: [px, h, pz] });
  for (const [px, pz, sw, sd] of [[x, -pw / 2, w + 0.08, pw + 0.08], [x, -d + pw / 2, w + 0.08, pw + 0.08]] as const) b.add(G.bbox(sw, 0.08, sd, 0.02), cop, { at: [px, h + ph, pz] });
  if (o.rail) for (const bx of bays(w, 1.4, 0.3)) b.inst(P.rail(), x + bx, h + ph, -0.12, { s: [w / Math.max(1, Math.round((w - 0.6) / 1.4)), 1.05, 1], color: '#d9dcdf' });
  // stair / lift penthouse
  if (w > 5 && r() < 0.75) {
    const pw2 = Math.min(3.2, w * 0.35), px = x + (r() < 0.5 ? -1 : 1) * (w / 2 - pw2 / 2 - 0.6), pz = -d + 2.4;
    b.add(G.bbox(pw2, 2.6, 3.0, 0.05), shadeHex(wall, 0.96), { at: [px, h, pz] });
    b.box(px, h + 2.6, pz, pw2 + 0.12, 0.08, 3.12, cop);
    b.box(px, h, pz + 1.51, 0.9, 2.0, 0.04, '#8a8f94');
  }
  const tank = o.tank ?? 0.6;
  if (r() < tank) {
    const tx = x + (r() - 0.5) * Math.max(0, w - 3), tz = -d / 2 - r() * 2;
    b.inst(r() < 0.6 ? P.tankBox() : P.tankCyl(), tx, h, tz, { ry: r() < 0.5 ? 0 : Math.PI / 2, color: pickOf(r, ['#eef1f2', '#e3ecf2', '#d6e3ea', '#f2efe7']) });
  }
  if (o.plant !== false) for (let k = 0; k < Math.floor(r() * 3); k++) b.inst(P.condenser(), x + (r() - 0.5) * (w - 2.2), h, -d + 1.2 + r() * (d - 3), { ry: r() < 0.5 ? 0 : Math.PI / 2, color: '#eceae5' });
  if (r() < 0.35) b.inst(P.antenna(), x + (r() - 0.5) * (w - 1.5), h, -d * 0.6, { ry: r() * 3 });
}
/** Windows on the two side walls (seen at corners and gaps; hidden ones sit inside the neighbour's mass). */
function sideWindows({ b, o, L, r, x, w, d }: Ctx, p: Proto, gh: number, fh: number, floors: number, z0 = 0): void {
  if (!o.sideWindows) return;
  for (const sx of [-1, 1]) for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh + 0.7;
    for (let zc = z0 - 1.6; zc > -d + 1.2; zc -= 3.2) b.inst(p, x + sx * w / 2, y, zc, { ry: sx * Math.PI / 2, s: [1.2, 1.4, 1], color: glassTint(r), glow: lit(r, L, L.lit * 0.7) });
  }
}
function drainpipes(b: Builder, x: number, w: number, h: number, c: string, r: () => number): void {
  const sx = r() < 0.5 ? -1 : 1;
  b.inst(P.pipe(), x + sx * (w / 2 - 0.16), 0, 0, { s: [1, h, 1], color: c });
}
/** A storey line: a slim projecting slab band. */
function band(b: Builder, x: number, w: number, y: number, c: string, depth = 0.08, hh = 0.14): void {
  b.add(G.bbox(w + 0.02, hh, depth * 2, 0.02), c, { at: [x, y, 0] });
}

// ---------------------------------------------------------------- signage on upper floors
const NEON = ['#ff3f9e', '#2fd6ff', '#ffd23a', '#7cff6b', '#b46bff', '#ff8a2a'];
const BLADE = ['#c1121f', '#7b2cbf', '#0b6e99', '#2b9348', '#e0115f', '#d9730d', '#1d1d1d', '#ffffff', '#1d3557'];
/** Projecting vertical sign boxes (one per tenant floor), lettered both sides, lit at night. */
function bladeStack(b: Builder, x: number, gh: number, fh: number, floors: number, r: () => number, first?: string, firstColor?: string, neon = false): void {
  const n = Math.min(floors - 1, 2 + Math.floor(r() * 4));
  for (let k = 0; k < n; k++) {
    const name = k === 0 && first ? first : pickOf(r, [...TENANTS, 'カラオケ', 'BAR', 'ラーメン', '居酒屋', '焼肉', '麻雀']);
    const col = k === 0 && firstColor ? firstColor : pickOf(r, BLADE);
    const fg = col === '#ffffff' ? '#c1121f' : '#ffffff';
    const sy = gh + 0.25 + k * fh, sh = fh * 0.86;
    b.push(x, sy, 0.62, 0);
    b.add(G.bbox(0.16, sh, 0.92, 0.03), '#2a2b30', { at: [0, 0, 0] });
    b.box(0, 0.04, 0, 0.18, sh - 0.08, 0.84, col, neon || r() < 0.6 ? col : undefined);
    b.sign(0.095, sh / 2, 0, 0.78, sh - 0.14, name.slice(0, 5), { bg: col, fg, vertical: true, px: 56, ry: Math.PI / 2 });
    b.sign(-0.095, sh / 2, 0, 0.78, sh - 0.14, name.slice(0, 5), { bg: col, fg, vertical: true, px: 56, ry: -Math.PI / 2 });
    b.box(0, sh * 0.2, -0.5, 0.05, 0.05, 0.12, '#5c6470'); b.box(0, sh * 0.8, -0.5, 0.05, 0.05, 0.12, '#5c6470');
    b.pop();
  }
  b.collideY(x, 0.62, 0.2, 0.92, gh + 0.25, gh + 0.25 + n * fh);
}
/** Neon signboards fixed flat to the facade, framed by an emissive tube. */
function neonBoards(b: Builder, x: number, w: number, gh: number, fh: number, floors: number, r: () => number): void {
  for (let k = 0; k < 1 + Math.floor(r() * 2); k++) {
    const fy = gh + Math.floor(r() * (floors - 1)) * fh + 0.25;
    const nw = Math.min(w - 1.2, 1.6 + r() * 2.4), nx = x + (r() - 0.5) * (w - nw - 0.8);
    const c = pickOf(r, NEON);
    b.add(G.bbox(nw + 0.2, 0.95, 0.12, 0.03), '#16161d', { at: [nx, fy, 0.1] });
    b.sign(nx, fy + 0.475, 0.165, nw, 0.75, pickOf(r, ['カラオケ', 'BAR', '焼肉', 'ラーメン', '居酒屋', 'GAME', 'スナック', '麻雀', 'CLUB', 'ホテル', '漫画喫茶', '牛丼', 'ダーツ', '餃子']), { bg: '#14141f', fg: c, px: 64 });
    for (const [tx, ty, tw, th] of [[0, 0.02, nw + 0.12, 0.03], [0, 0.9, nw + 0.12, 0.03], [-(nw + 0.09) / 2, 0.02, 0.03, 0.91], [(nw + 0.09) / 2, 0.02, 0.03, 0.91]] as const) b.box(nx + tx, fy + ty, 0.17, tw, th, 0.03, c, c);
  }
}
function tenantLettering(b: Builder, x: number, y: number, ww: number, r: () => number): void {
  b.sign(x, y, 0.075, ww * 0.78, 0.36, pickOf(r, TENANTS), { bg: '#ffffff', fg: pickOf(r, ['#c1121f', '#1d4e89', '#2b9348', '#7b2cbf']), px: 64 });
}

// ================================================================ generators
interface Ctx { b: Builder; o: BOpts; L: Look; r: () => number; x: number; w: number; d: number; floors: number; wall: string }

/** 2–3 storey timber townhouse: koshi lattice shopfront, tiled pent eave, plaster upper floors framed in timber, kawara roof. */
function machiya({ b, o, L, r, x, w, d, floors, wall }: Ctx): number {
  const gh = 3.3, fh = 2.75, h = gh + (floors - 1) * fh;
  const timber = pickOf(r, ['#5b4334', '#6b4f3c', '#4d3a2e']);
  mass(b, x, w, 0, h, 0, d, wall);
  groundFloor(b, { ...o, style: 'wood' }, o.kind ?? 'souvenir', gh, true);
  // timber frame on the plaster: corner posts, floor beam, half-timber rail
  for (const sx of [-1, 1]) b.add(G.bbox(0.18, h - gh + 0.1, 0.12, 0.02), timber, { at: [x + sx * (w / 2 - 0.09), gh - 0.05, 0.03] });
  for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh;
    b.add(G.bbox(w, 0.16, 0.14, 0.02), timber, { at: [x, y, 0.03] });
    // windows: a lattice pair, or a long mushiko slit band on low 2F rooms
    if (f === 1 && floors === 2 && r() < 0.45) {
      const sw = w - 1.2;
      b.add(G.bbox(sw + 0.16, 0.95, 0.1, 0.02), '#f6efe2', { at: [x, y + 0.75, 0.02] });
      for (let k = 0; k < Math.floor(sw / 0.22); k++) b.box(x - sw / 2 + 0.11 + k * 0.22, y + 0.8, 0.08, 0.1, 0.85, 0.06, timber);
    } else {
      windows(b, P.wood(), x, w, y + 0.65, 1.25, 1.25, 1.9, 0.55, r, L);
      if (r() < 0.45) for (const bx of bays(w, 1.9, 0.55)) b.inst(P.rail(), x + bx, y + 0.45, 0.22, { s: [1.5, 0.75, 1], color: timber });
    }
  }
  // eaves board and roof: gable or hip with a ridge cap and tile overhang
  b.add(G.bbox(w + 0.5, 0.16, d + 0.6, 0.03), shadeHex(timber, 1.1), { at: [x, h, -d / 2] });
  const rh = Math.min(2.2, d * 0.24), tile = pickOf(r, ['#545a63', '#4d535c', '#5a5753', '#60656d']);
  if (r() < 0.55) {
    b.add(gable(d + 1.0, rh, w + 0.4), tile, { at: [x, h + 0.16, -d / 2], roof: true });
    b.add(G.bbox(w + 0.5, 0.18, 0.3, 0.05), shadeHex(tile, 0.8), { at: [x, h + 0.12 + rh, -d / 2] });
    for (const sx of [-1, 1]) b.add(G.bbox(0.2, 0.35, 0.36, 0.05), shadeHex(tile, 0.75), { at: [x + sx * (w / 2 + 0.2), h + rh - 0.05, -d / 2] });
  } else {
    b.add(hip(w + 0.9, d + 1.0, rh), tile, { at: [x, h + 0.16, -d / 2], roof: true });
  }
  if (r() < 0.3) b.inst(P.antenna(), x + (r() - 0.5) * w * 0.5, h + rh * 0.7, -d / 2, { ry: r() * 3 });
  return h + rh;
}

/** "Kanban kenchiku": a 1920s shop with a flat copper or mortar false front hiding a pitched roof. */
function kanban({ b, o, L, r, x, w, d, floors, wall }: Ctx): number {
  const gh = 3.4, fh = 2.9, h = gh + (floors - 1) * fh, top = h + 1.1;
  const copper = wall.startsWith('#8') || wall.startsWith('#9') || wall.startsWith('#a');
  const trim = copper ? '#6f8c80' : shadeHex(wall, 0.86);
  mass(b, x, w, 0, h, 0.0, d, shadeHex(wall, copper ? 1.25 : 1));
  b.add(G.bbox(w, top - gh, 0.22, 0.03), wall, { at: [x, gh, -0.05] }); // the false front plate
  groundFloor(b, { ...o, style: r() < 0.5 ? 'wood' : 'modern' }, o.kind ?? 'souvenir', gh, r() < 0.5);
  for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh;
    band(b, x, w, y, trim, 0.1, 0.18);
    windows(b, copper ? P.sashDark() : P.sashWhite(), x, w, y + 0.7, 1.15, 1.35, 1.7, 0.6, r, L, 0.06);
    if (copper) for (let k = 1; k < 4; k++) b.box(x, y + k * (fh / 4), 0.07, w - 0.2, 0.02, 0.02, trim); // seam lines of the copper sheets
  }
  // stepped decorative cornice and a pediment
  b.add(G.bbox(w + 0.24, 0.18, 0.42, 0.03), trim, { at: [x, top - 0.36, 0.0] });
  b.add(G.bbox(w * 0.5, 0.42, 0.24, 0.03), wall, { at: [x, top, -0.05] });
  b.add(G.bbox(w * 0.5 + 0.18, 0.1, 0.34, 0.02), trim, { at: [x, top + 0.42, -0.05] });
  b.add(gable(d - 0.6, 1.6, w - 0.2), pickOf(r, ['#545a63', '#5a5753']), { at: [x, h, -d / 2 - 0.3], roof: true });
  drainpipes(b, x, w, h, '#9aa0a6', r);
  return top + 0.5;
}

/** Low shotengai building: tiled/mortar front, shop below, aluminium windows with AC units on brackets, flat roof. */
function shotengai(c: Ctx): number {
  const { b, o, L, r, x, w, d, floors, wall } = c;
  const gh = 3.5, fh = 2.95, h = gh + (floors - 1) * fh;
  mass(b, x, w, 0, h, 0, d, wall);
  groundFloor(b, { ...o, style: 'modern' }, o.kind ?? 'generic', gh, false);
  closedShutter(c, gh);
  const trim = shadeHex(wall, 0.88);
  const frame = r() < 0.5 ? P.sash() : P.sashDark();
  for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh;
    band(b, x, w, y - 0.08, trim);
    windows(b, frame, x, w, y + 0.75, 1.3, 1.3, 2.0, 0.55, r, L);
    if (f === 1 && r() < 0.4) tenantLettering(b, x + (r() - 0.5) * (w - 2), y + 1.4, 1.4, r);
    for (const bx of bays(w, 2.0, 0.55)) if (r() < 0.35) b.inst(P.ac(), x + bx + 0.95, y + 0.25, 0, { color: pickOf(r, ['#f2f0ec', '#e6e4df', '#f6f4ef']) });
  }
  if (r() < 0.5) bladeStack(b, x + (r() < 0.5 ? -1 : 1) * (w / 2 - 0.3), gh, fh, floors, r);
  sideWindows(c, frame, gh, fh, floors);
  flatRoof(b, x, w, d, h, wall, r, { tank: 0.55 });
  drainpipes(b, x, w, h, '#a9aeb3', r);
  return h + 0.8;
}

/** 4–8 storey zakkyo / mixed-use: shop podium, then either tenant floors (lettered glass) or balconied flats. */
function mixed(c: Ctx): number {
  const { b, o, L, r, x, w, d, floors, wall } = c;
  const lux = o.style === 'lux';
  const gh = 3.6, fh = 3.05, h = gh + (floors - 1) * fh;
  const flats = !lux && r() < 0.5;
  const trim = shadeHex(wall, 0.86);
  mass(b, x, w, 0, h, 0, d, wall);
  groundFloor(b, { ...o, style: lux ? 'lux' : 'modern' }, o.kind ?? 'generic', gh, false);
  closedShutter(c, gh);
  if (flats) {
    // balconied flats: projecting slab, railing or frosted panels, sliding doors, AC unit and laundry
    const rail = r() < 0.5;
    const pc = pickOf(r, ['#dfe3e6', '#cfd5d9', '#e7e1d6', '#b8c4cc']);
    const units = Math.max(1, Math.round(w / 3.6)), uw = w / units;
    for (let f = 1; f < floors; f++) {
      const y = gh + (f - 1) * fh;
      b.add(G.bbox(w - 0.1, 0.16, 1.1, 0.03), shadeHex(wall, 1.04), { at: [x, y - 0.16, 0.55] });
      for (let u = 0; u < units; u++) {
        const ux = x - w / 2 + (u + 0.5) * uw;
        b.inst(P.slide(), ux - 0.25, y, 0.0, { s: [Math.min(2.2, uw - 1.2), 2.05, 1], color: glassTint(r), glow: lit(r, L) });
        if (r() < 0.75) b.inst(P.ac(), ux + uw / 2 - 0.62, y, 0.62, { ry: 0, color: '#f2f0ec' });
        if (r() < 0.35) b.inst(P.laundry(), ux - 0.6, y + 0.9, 0.72);
        if (u > 0) b.box(ux - uw / 2, y, 0.55, 0.05, 1.9, 1.0, '#d8d6d0'); // fire-escape divider panel
        const bw = uw - 0.04, nb = Math.max(1, Math.round(bw / 1.3));
        for (let k = 0; k < nb; k++) b.inst(rail ? P.rail() : P.panel(), ux - bw / 2 + (k + 0.5) * (bw / nb), y, 1.05, { s: [bw / nb, 1.1, 1], color: rail ? '#dde0e3' : pc });
      }
      b.collideY(x, 0.55, w, 1.1, y - 0.16, y + 1.1);
    }
  } else {
    const frame = lux ? P.lux() : pickOf(r, [P.sash(), P.sashDark(), P.sashWhite()]);
    const ww = lux ? 1.3 : 1.55, pitch = lux ? 2.0 : 2.15;
    for (let f = 1; f < floors; f++) {
      const y = gh + (f - 1) * fh;
      if (!lux) band(b, x, w, y - 0.08, trim);
      windows(b, frame, x, w, y + 0.7, ww, lux ? 1.8 : 1.55, pitch, 0.6, r, L);
      for (const bx of bays(w, pitch, 0.6)) {
        if (!lux && f <= 4 && r() < 0.3) tenantLettering(b, x + bx, y + 1.5, ww, r);
        if (!lux && r() < 0.18) b.inst(P.ac(), x + bx + ww / 2 + 0.5, y + 0.2, 0, { color: '#f2f0ec' });
      }
    }
  }
  sideWindows(c, lux ? P.lux() : P.sash(), gh, fh, floors);
  if (!lux && (o.vertical || r() < 0.6)) bladeStack(b, x + (r() < 0.5 ? -1 : 1) * (w / 2 - 0.35), gh, fh, floors, r, o.vertical, o.verticalColor, L.neon);
  if (L.neon && !o.plain && floors > 3) neonBoards(b, x, w, gh, fh, floors, r);
  if (L.neon && r() < 0.45) { const nc = pickOf(r, NEON); for (const sx of [-1, 1]) b.box(x + sx * (w / 2 - 0.04), gh, 0.04, 0.07, h - gh, 0.07, nc, nc); }
  flatRoof(b, x, w, d, h, wall, r, { tank: 0.55, rail: r() < 0.3 });
  drainpipes(b, x, w, h, '#a9aeb3', r);
  roofSign(c, h);
  return h + 1;
}

/** Apartment block with external walkways: shop podium, upper floors set back behind open corridors, steel stair. */
function walkup(c: Ctx): number {
  const { b, o, L, r, x, w, d, floors, wall } = c;
  const gh = 3.6, fh = 2.9, h = gh + (floors - 1) * fh, sb = 1.6;
  mass(b, x, w, 0, gh, 0, d, shadeHex(wall, 0.95));
  mass(b, x, w, gh, h, -sb, d, wall);
  groundFloor(b, { ...o, style: 'modern' }, o.kind ?? 'konbini', gh, false);
  const stairX = x + (r() < 0.5 ? -1 : 1) * (w / 2 - 0.75);
  const doorC = pickOf(r, ['#7d8a96', '#8d7b6a', '#6f7f74', '#9a8f84']);
  const parapet = shadeHex(wall, 1.03);
  for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh;
    b.add(G.bbox(w, 0.2, sb + 0.02, 0.03), parapet, { at: [x, y - 0.2, -sb / 2] }); // corridor slab
    b.add(G.bbox(w, 1.05, 0.14, 0.03), parapet, { at: [x, y, -0.07] }); // solid parapet
    b.box(x, y + 1.05, -0.07, w, 0.04, 0.18, '#b9bdc1');
    b.box(x, y - 0.24, -0.4, w - 0.4, 0.03, 0.12, '#fff2d6', '#ffd9a0'); // corridor ceiling light strip
    for (const ux of bays(w - 1.6, 3.2, 0.2)) {
      const dx = x + ux + (stairX < x ? 0.8 : -0.8);
      b.inst(P.door(), dx - 0.6, y, -sb, { color: doorC });
      b.inst(P.sashWhite(), dx + 0.65, y + 1.0, -sb, { s: [1.0, 0.9, 1], color: '#d8d6cf', glow: lit(r, L, L.lit * 0.6) });
    }
    if (r() < 0.25) b.inst(P.laundry(), x + (r() - 0.5) * (w - 3), y + 0.95, -0.2);
    b.collideY(x, -sb / 2, w, sb, y - 0.2, y + 1.1);
  }
  // steel stair: one proto per storey, on the corridor end
  for (let f = 1; f < floors; f++) b.inst(P.stair(), stairX, gh + (f - 2) * fh, -sb / 2, { s: [1, fh, 0.75], color: '#e8e6e1', ry: 0 });
  // end wall with the building name
  sideWindows(c, P.sashWhite(), gh, fh, floors, -1.6);
  b.sign(x, gh + 0.55, 0.2, Math.min(3, w - 2), 0.45, pickOf(r, ['メゾン桜', 'コーポ青葉', 'ハイツ緑町', 'グランドール', 'サンハイム', 'パレス若松']), { bg: '#f3efe6', fg: '#3c4454', px: 70 });
  flatRoof(b, x, w, d - sb, h, wall, r, { tank: 0.8, rail: false });
  drainpipes(b, x, w, h, '#a9aeb3', r);
  return h + 1;
}

/** Slim 6–10 storey pencil building: ribbon windows, a tall vertical sign stack and a rooftop billboard frame. */
function pencil(c: Ctx): number {
  const { b, o, L, r, x, w, d, floors, wall } = c;
  const gh = 3.5, fh = 3.0, h = gh + (floors - 1) * fh;
  const trim = shadeHex(wall, 0.82);
  mass(b, x, w, 0, h, 0, d, wall);
  if (!o.noFront) groundFloor(b, { ...o, style: 'modern' }, o.kind ?? 'generic', gh, false);
  const frame = pickOf(r, [P.sashDark(), P.sash()]);
  for (let f = 1; f < floors; f++) {
    const y = gh + (f - 1) * fh;
    b.add(G.bbox(w + 0.04, 0.3, 0.16, 0.03), trim, { at: [x, y - 0.05, 0.0] });
    const ww = w - 1.0;
    b.inst(frame, x, y + 0.6, 0, { s: [ww, 1.9, 1], color: glassTint(r), glow: lit(r, L) });
    if (!o.plain && r() < 0.45) tenantLettering(b, x, y + 1.6, Math.min(2.4, ww), r);
    if (r() < 0.4) b.inst(P.ac(), x + (r() < 0.5 ? -1 : 1) * (w / 2 + 0.05), y + 0.3, -1.2, { ry: Math.PI / 2 * (r() < 0.5 ? 1 : -1), color: '#f2f0ec' });
  }
  if (!o.plain || o.vertical) bladeStack(b, x + (r() < 0.5 ? -1 : 1) * (w / 2 - 0.25), gh, fh, floors, r, o.vertical, o.verticalColor, L.neon);
  sideWindows(c, frame, gh, fh, floors);
  flatRoof(b, x, w, d, h, wall, r, { tank: 0.4, plant: false });
  if (!o.plain && r() < 0.5) {
    for (const sx of [-1, 1]) b.box(x + sx * (w / 2 - 0.5), h, -1.4, 0.1, 3.2, 0.1, '#5c6470');
    b.add(G.bbox(w - 0.4, 1.8, 0.14, 0.03), '#1b1b22', { at: [x, h + 1.3, -1.4] });
    const c2 = pickOf(r, BLADE);
    b.sign(x, h + 2.2, -1.32, w - 0.6, 1.6, pickOf(r, ['質', 'カラオケ', '英会話', 'ホテル', 'BAR', '歯科', '整体']), { bg: c2, fg: c2 === '#ffffff' ? '#c1121f' : '#ffffff', px: 50, border: '#ffffff' });
  }
  drainpipes(b, x, w, h, '#a9aeb3', r);
  return h + 1;
}

/** Glass office: stone podium, curtain wall tiled with instanced bays, corner fins, a set-back crown with plant screen. */
function office(c: Ctx): number {
  const { b, o, L, r, x, w, d, floors } = c;
  const tower = o.style === 'tower';
  const gh = tower ? 4.6 : 4.2, fh = tower ? 3.6 : 3.4, h = gh + (floors - 1) * fh;
  const dark = r() < 0.4;
  const bay = tower ? P.officeFar() : dark ? P.officeDark() : P.office();
  const frameC = dark ? '#3b3e44' : '#c9cdd1';
  const podium = pickOf(r, ['#d9d4ca', '#cdc8bd', '#e3ddd1', '#bdb9b1']);
  const lamps = { ...L, lamps: OFFICE_LAMPS, lit: tower ? 0.35 : 0.42 };
  b.add(G.bbox(w - 0.3, h - 0.2, d - 0.3, 0.05), dark ? '#3a4048' : '#8796a3', { at: [x, 0.1, -d / 2 - 0.05] }); // core behind the glass
  // podium
  mass(b, x, w, 0, gh, 0, d, podium);
  if (!o.noFront) {
    groundFloor(b, { ...o, style: o.style === 'lux' ? 'lux' : 'modern' }, o.kind ?? 'generic', gh - 0.6, false);
    b.add(G.bbox(w + 0.1, 0.6, 0.5, 0.04), podium, { at: [x, gh - 0.6, 0.05] });
  }
  b.add(G.bbox(w + 0.2, 0.2, 0.7, 0.04), shadeHex(podium, 0.92), { at: [x, gh, 0.0] });
  // curtain wall on the front (and sides for towers / corners)
  const faces: [number, number, number, number][] = [[0, 0, 0, w]]; // [ry, cx, cz, width]
  if (tower || o.sideWindows) faces.push([Math.PI / 2, x + w / 2, -d / 2, d], [-Math.PI / 2, x - w / 2, -d / 2, d]);
  if (tower) faces.push([Math.PI, x, -d, w]);
  const pitch = tower ? 3.0 : 1.6;
  for (const [ry, cx, cz, fw] of faces) {
    b.push(ry === 0 ? 0 : cx, 0, ry === 0 ? 0 : cz, ry);
    const ox = ry === 0 ? x : 0;
    const n = Math.max(1, Math.round((fw - 0.4) / pitch)), bw = (fw - 0.4) / n;
    for (let f = 1; f < floors; f++) {
      const y = gh + 0.2 + (f - 1) * fh;
      for (let i = 0; i < n; i++) b.inst(bay, ox - (fw - 0.4) / 2 + (i + 0.5) * bw, y, 0.01, { s: [bw, fh, 1], color: pickOf(r, ['#7f93a6', '#8ea1b2', '#6f8396', '#9aabba']), glow: lit(r, lamps) });
    }
    b.box(ox + (fw - 0.4) / 2, gh + 0.2, 0.01, 0.04, h - gh - 0.2, 0.1, frameC); // closing mullion
    b.pop();
  }
  // corner fins and crown
  for (const sx of [-1, 1]) b.add(G.bbox(0.32, h - gh, 0.32, 0.04), frameC === '#3b3e44' ? '#2f3338' : '#e4e6e8', { at: [x + sx * (w / 2 - 0.1), gh, -0.1] });
  b.add(G.bbox(w + 0.1, 0.5, d + 0.1, 0.05), frameC === '#3b3e44' ? '#2f3338' : '#e4e6e8', { at: [x, h, -d / 2] });
  const cw = w - 2.4, cd = d - 3.2;
  if (cw > 2 && cd > 2) {
    b.add(G.bbox(cw, 2.6, cd, 0.05), dark ? '#3a3f46' : '#dfe2e4', { at: [x, h + 0.5, -d / 2 - 0.4] });
    for (let k = 0; k < Math.floor(cw / 0.45); k++) b.box(x - cw / 2 + 0.22 + k * 0.45, h + 0.6, -d / 2 - 0.4 + cd / 2 + 0.06, 0.08, 2.3, 0.12, dark ? '#2b2f34' : '#c7cbcf'); // louvres
  }
  if (tower && h > 40) {
    b.cyl(x + w * 0.2, h + 3.1, -d / 2, 0.08, 0.12, 7, '#c4c8cc', 6);
    b.add(G.sphere(0.3, 8, 6), '#ff3b3b', { at: [x + w * 0.2, h + 10.2, -d / 2], glow: '#ff2020' });
  } else if (r() < 0.4) b.inst(P.antenna(), x + w * 0.3, h + 0.5, -d * 0.7);
  if (!tower && L.neon && r() < 0.4) roofSign(c, h + 0.5, true);
  return h + 3;
}

/** Ginza stone building: limestone pilasters, bronze-framed tall windows, deep cornice, a glass penthouse. */
function stone(c: Ctx): number {
  const { b, o, L, r, x, w, d, floors, wall } = c;
  const gh = 4.4, fh = 3.3, h = gh + (floors - 1) * fh;
  const trim = shadeHex(wall, 0.9);
  mass(b, x, w, 0, h, 0, d, wall);
  groundFloor(b, { ...o, style: 'lux' }, o.kind ?? 'boutique', gh - 0.4, false);
  b.add(G.bbox(w + 0.14, 0.4, 0.3, 0.04), trim, { at: [x, gh - 0.4, 0.0] });
  const pitch = 2.1, xs = bays(w, pitch, 0.5);
  const span = (w - 1.0) / xs.length;
  for (let i = 0; i <= xs.length; i++) b.add(G.bbox(0.32, h - gh - 0.4, 0.2, 0.03), shadeHex(wall, 1.03), { at: [x - (w - 1.0) / 2 + i * span, gh, 0.0] }); // pilasters
  for (let f = 1; f < floors - 1; f++) {
    const y = gh + (f - 1) * fh;
    b.add(G.bbox(w - 0.6, 0.12, 0.1, 0.02), trim, { at: [x, y, 0.0] });
    for (const bx of xs) b.inst(P.lux(), x + bx, y + 0.6, 0.02, { s: [Math.min(1.3, span - 0.6), 2.0, 1], color: glassTint(r), glow: lit(r, L) });
  }
  sideWindows(c, P.lux(), gh, fh, floors - 1);
  // cornice and penthouse
  b.add(G.bbox(w + 0.4, 0.22, 0.6, 0.04), trim, { at: [x, h - fh - 0.2, 0.0] });
  b.add(G.bbox(w + 0.3, 0.14, 0.5, 0.03), wall, { at: [x, h - fh, 0.0] });
  const pyl = h - fh + 0.14;
  b.add(G.bbox(w - 1.6, fh - 0.2, d - 2.2, 0.05), '#6f7a84', { at: [x, pyl, -d / 2 - 0.4] });
  const n = Math.max(1, Math.round((w - 1.6) / 1.5));
  for (let i = 0; i < n; i++) b.inst(P.officeDark(), x - (w - 1.6) / 2 + (i + 0.5) * ((w - 1.6) / n), pyl, -1.19 + 0.0, { s: [(w - 1.6) / n, fh - 0.2, 1], color: '#9db0bf', glow: lit(r, L) });
  b.add(G.bbox(w - 1.4, 0.18, d - 2.0, 0.04), '#e9e4da', { at: [x, h - 0.06, -d / 2 - 0.4] });
  for (const bx of bays(w, 1.2, 0.2)) b.inst(P.rail(), x + bx, pyl, -0.25, { s: [(w - 0.4) / Math.max(1, Math.round((w - 0.4) / 1.2)), 1.0, 1], color: '#6b5a45' });
  if (r() < 0.35) { b.cyl(x + w / 2 - 0.8, h + 0.1, -1.5, 0.04, 0.05, 6, '#c9c4ba', 6); }
  return h + 1;
}

function closedShutter({ b, x, w, r, o }: Ctx, gh: number): void {
  if (o.shop || o.kind === 'konbini' || r() > 0.14) return;
  b.inst(P.shutter(), x, 0, 0.22, { s: [w - 0.5, gh - 0.7, 1], color: pickOf(r, ['#c9cdd1', '#b9bec3', '#d6d2c9']) });
  if (r() < 0.6) b.sign(x, gh * 0.45, 0.26, Math.min(2.4, w - 1.2), 0.5, pickOf(r, ['本日定休日', '準備中', 'テナント募集', '貸店舗']), { bg: '#f4f1ea', fg: '#3c4454', px: 60 });
}
function roofSign({ b, o, r, x, w }: Ctx, h: number, force = false): void {
  const text = o.roofSign ?? (force ? pickOf(r, ['寿司', 'カラオケ', 'ビール', '英会話', '質屋', 'ゲーム', 'ホテル']) : undefined);
  if (!text) return;
  const sw = Math.min(w - 0.5, 7);
  b.box(x - sw / 2 + 0.6, h + 0.5, -1.2, 0.12, 2.0, 0.12, '#5c6470'); b.box(x + sw / 2 - 0.6, h + 0.5, -1.2, 0.12, 2.0, 0.12, '#5c6470');
  b.add(G.bbox(sw + 0.3, 2.3, 0.14, 0.03), '#1b1b22', { at: [x, h + 1.8, -1.25] });
  b.sign(x, h + 2.95, -1.17, sw, 2.0, text, { bg: o.verticalColor ?? '#1d3557', fg: '#ffffff', px: 56, border: '#ffd23f' });
}

const GEN: Record<Arch, (c: Ctx) => number> = { machiya, kanban, shotengai, mixed, walkup, pencil, office, stone };

/** One street building (facade at local z=0, facing +z). Returns its height. Adds its own collider. */
export function building(b: Builder, o: BOpts): number {
  const sb = o.setback ?? 0;
  b.push(0, 0, -sb, 0);
  const L = o.look ?? LOOK_BY_STYLE[o.style];
  const arch = o.arch ?? (o.style === 'modern' && o.plain && o.w < 7 ? 'pencil' : o.style === 'modern' && o.plain ? 'office' : ARCH_BY_STYLE[o.style]);
  const c: Ctx = { b, o, L, r: o.r, x: o.x, w: o.w, d: o.d - sb, floors: Math.max(arch === 'machiya' ? 2 : 1, o.floors), wall: o.color };
  const h = GEN[arch](c);
  if (o.collide !== false) b.collide(o.x, -c.d / 2, o.w, c.d, h + 1);
  b.pop();
  return h;
}

/** Fill a frontage (local x range, facade on z=0) with a seeded mix of archetypes from the district look. */
export function frontage(b: Builder, x0: number, x1: number, reserved: [number, number][], style: Style, r: () => number, _shops: string[], colors: string[],
  opts: Partial<BuildingOpts> & { minF?: number; maxF?: number; depth?: number; kinds?: ShopKind[]; look?: Look } = {}): void {
  const L = opts.look ?? LOOK_BY_STYLE[style];
  const res = [...reserved].sort((a, c) => a[0] - c[0]);
  const gaps: [number, number][] = [];
  let cur = x0;
  for (const [a, c] of res) { if (a > cur) gaps.push([cur, a]); cur = Math.max(cur, c); }
  if (cur < x1) gaps.push([cur, x1]);
  const kinds = opts.kinds ?? (['generic'] as ShopKind[]);
  for (const [a, c] of gaps) {
    let x = a;
    while (c - x > 0.5) {
      let arch = pickW(r, L.mix);
      const [w0, w1] = WIDTH[arch];
      let w = w0 + r() * (w1 - w0);
      if (c - x - w < 3.4) w = c - x;
      if (w < 3.6 && arch !== 'machiya') arch = L === LOOKS.asakusa ? 'machiya' : 'pencil';
      if (w > 9 && arch === 'pencil') arch = 'mixed';
      // occasional narrow service gap between buildings (dark slot)
      const gap = w > 5.5 && r() < 0.25 ? 0.4 : 0;
      if (gap) { b.box(x + w - gap / 2, 0, -1.6, gap, 6, 0.2, '#3a3b40'); b.collide(x + w - gap / 2, -0.8, gap + 0.05, 1.6, 6); }
      const bw = w - gap;
      const [f0, f1] = L.floors[arch] ?? [opts.minF ?? 2, opts.maxF ?? 4];
      const floors = f0 + Math.floor(r() * (f1 - f0 + 1));
      const walls = L.walls[arch] ?? colors;
      building(b, {
        x: x + bw / 2, w: bw, d: opts.depth ?? 12 + r() * 3, floors, style, r, color: pickOf(r, walls), kind: pickOf(r, kinds),
        setback: arch === 'office' || arch === 'stone' || r() > 0.3 ? 0 : r() * 0.4,
        awning: r() < 0.3 ? pickOf(r, ['#b84a3e', '#3f7f75', '#c98a4a', '#2f4858', '#7a4a2a']) : undefined,
        roofSign: (arch === 'mixed' || arch === 'pencil') && floors >= 5 && r() < (L.neon ? 0.35 : 0.15) ? pickOf(r, ['寿司', 'カラオケ', 'SALE', 'ビール', '英会話', '質屋', 'ゲーム']) : undefined,
        verticalColor: pickOf(r, BLADE), sideWindows: style !== 'wood',
        ...opts, arch, look: L,
      });
      x += w;
    }
  }
}
