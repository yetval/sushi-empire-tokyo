// Architectural finishes and printed matter for the walkable neighborhoods.
import type { DistrictId } from '../core/data';
import { Atlas, Builder, G } from './kit';

type Finish = 'cedar' | 'glaze' | 'brick' | 'enamel' | 'stone';

interface Place {
  nameplate: string;
  ink: string;
  trim: string;
  floor: string;
  finish: Finish;
  print: string;
  caption: string;
}

const PLACES: Record<string, Place> = {
  asakusa_stand: { nameplate: '屋台', ink: '#454b49', trim: '#a79370', floor: '#a38e6f', finish: 'cedar', print: '仕込み', caption: 'Prep list' },
  asakusa_shop: { nameplate: '浅草 · すし処', ink: '#344d53', trim: '#9f8764', floor: '#a6855d', finish: 'cedar', print: '浅草', caption: 'Morning at the market' },
  asakusa_house: { nameplate: '浅草 · 寿司の家', ink: '#644b3c', trim: '#aa795b', floor: '#bb9c70', finish: 'cedar', print: '雲門', caption: 'The cloud gate' },
  asakusa_market: { nameplate: '仲見世 · 鮨', ink: '#6c463a', trim: '#c78e59', floor: '#a58a67', finish: 'brick', print: '朝市', caption: 'Market deliveries' },
  asakusa_alley: { nameplate: '横丁 · すし', ink: '#4f5d4b', trim: '#a79b69', floor: '#b59a72', finish: 'glaze', print: '横丁', caption: 'The alley after rain' },
  shibuya_crossing: { nameplate: '渋谷 · 交差点', ink: '#46636b', trim: '#a6a69f', floor: '#aeb9b1', finish: 'glaze', print: '交差点', caption: 'At the crossing' },
  shibuya_center: { nameplate: 'センター街 · 寿司', ink: '#524e66', trim: '#a88d9c', floor: '#b5adb4', finish: 'enamel', print: '渋谷', caption: 'Center Street after dark' },
  shibuya_scramble: { nameplate: '渋谷 · 寿司', ink: '#785740', trim: '#bd965a', floor: '#bca891', finish: 'enamel', print: '渋谷駅', caption: 'Last train' },
  shibuya_alley: { nameplate: 'のんべい横丁 · すし', ink: '#694a47', trim: '#ab7966', floor: '#a68a7f', finish: 'brick', print: '横丁', caption: 'The back lane' },
  shinjuku_lunch: { nameplate: '新宿 · 昼の鮨', ink: '#645347', trim: '#ae977a', floor: '#a19482', finish: 'glaze', print: '昼席', caption: 'Counter seats' },
  shinjuku_tower: { nameplate: '新宿 · 鮨', ink: '#4f626a', trim: '#96a29f', floor: '#a8aeab', finish: 'enamel', print: '新宿', caption: 'The skyline from the west' },
  shinjuku_omoide: { nameplate: '思い出横丁 · 寿司', ink: '#695246', trim: '#a8805c', floor: '#9e886f', finish: 'brick', print: '思い出横丁', caption: 'Under the railway' },
  shinjuku_station: { nameplate: '西口 · 寿司', ink: '#435c55', trim: '#879985', floor: '#a7ac99', finish: 'enamel', print: '西口', caption: 'West Exit' },
  ginza_omakase: { nameplate: '銀座 · 鮨', ink: '#514b40', trim: '#b19668', floor: '#b7a38c', finish: 'stone', print: '余白', caption: 'Pine in winter' },
  ginza_flagship: { nameplate: '銀座 · 金鯉', ink: '#57563e', trim: '#a58b5a', floor: '#c6b495', finish: 'stone', print: '金鯉', caption: 'Koi study' },
  ginza_corner: { nameplate: '中央通り · 鮨', ink: '#565465', trim: '#9c8e85', floor: '#bdb1a6', finish: 'stone', print: '中央通り', caption: 'Chuo-dori at dusk' },
  ginza_tower: { nameplate: '銀座 · 鮨処', ink: '#4a5c58', trim: '#a79971', floor: '#c2b39d', finish: 'stone', print: '銀座', caption: 'The clock at six' },
};

export function placeArt(id: string): Place | undefined { return PLACES[id]; }

const grout: Record<Finish, string> = { cedar: '#524639', glaze: '#d0c7ad', brick: '#8b715f', enamel: '#d9cfc0', stone: '#d8caba' };

/** Architectural details sit on the established facade and keep the doorway clear. */
export function trimStorefront(b: Builder, id: string, spans: [number, number][], ext: string): void {
  const p = placeArt(id);
  if (!p) return;
  for (const [left, right] of spans) {
    const width = right - left;
    if (width < 0.45) continue;
    const x = (left + right) / 2;
    b.box(x, 0.045, 0.082, width, 0.50, 0.095, p.ink);
    b.box(x, 0.54, 0.097, width, 0.043, 0.11, p.trim);
    if (p.finish === 'cedar') {
      for (let x = left + 0.21; x < right - 0.1; x += 0.22) b.box(x, 0.08, 0.135, 0.018, 0.44, 0.01, '#877962');
    } else if (p.finish === 'enamel') {
      for (let x = left + 0.9; x < right - 0.16; x += 0.90) b.box(x, 0.09, 0.135, 0.017, 0.41, 0.01, p.trim);
    } else {
      const rows = p.finish === 'stone' ? 2 : p.finish === 'brick' ? 4 : 3;
      const interval = p.finish === 'stone' ? 0.84 : 0.40;
      for (let row = 0; row < rows; row++) {
        const y = 0.07 + row * (0.45 / rows);
        if (row > 0) b.box(x, y, 0.135, width - 0.09, 0.009, 0.01, grout[p.finish]);
        for (let at = left + 0.11 + (row % 2 ? 0.5 : 1) * interval; at < right - 0.07; at += interval) {
          b.box(at, y, 0.137, 0.009, 0.45 / rows, 0.01, grout[p.finish]);
        }
      }
    }
    // A header band reads as a continuous material under the upper floor.
    b.box(x, 2.67, 0.108, width, 0.062, 0.09, p.trim);
    b.box(x, 2.73, 0.092, width, 0.24, 0.085, ext);
  }
}

export function thresholds(b: Builder, id: string, doorX: number): void {
  const p = placeArt(id);
  if (!p) return;
  b.box(doorX, 0.018, 0.15, 2.22, 0.023, 0.48, p.floor);
  for (const z of [-0.035, 0.365]) b.box(doorX, 0.042, z, 2.22, 0.009, 0.023, p.trim);
  for (const dx of [-0.74, 0, 0.74]) b.box(doorX + dx, 0.042, 0.15, 0.012, 0.006, 0.43, p.ink);
}

export function roomFloor(b: Builder, id: string, floor: string, width: number, depth: number): void {
  const finish = placeArt(id)?.finish;
  const tile = finish === 'glaze' || finish === 'enamel';
  const stride = tile ? 0.80 : finish === 'stone' ? 1.42 : 0.34;
  const color = finish === 'stone' ? '#8e7c69' : finish === 'cedar' ? '#967c5c' : '#90928a';
  for (let x = -width / 2 + stride; x < width / 2 - 0.08; x += stride) {
    b.box(x, 0.050, -depth / 2, tile ? 0.013 : 0.010, 0.003, depth - 0.2, color);
  }
  if (tile) for (let z = -0.80; z > -depth + 0.08; z -= 0.80) {
    b.box(0, 0.051, z, width - 0.16, 0.003, 0.013, color);
  }
  if (finish === 'stone') {
    for (const x of [-width / 2 + 0.38, width / 2 - 0.38]) b.box(x, 0.051, -depth / 2, 0.032, 0.003, depth - 0.55, floor);
  }
}

function paintPrint(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, p: Place): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#e5d6b7';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = p.trim;
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.fillStyle = p.ink;
  ctx.fillRect(18, 18, w - 36, h * 0.64);
  ctx.strokeStyle = '#dfcdb1';
  if (p.print === '余白') {
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(w * 0.30, h * 0.70);
    ctx.bezierCurveTo(w * 0.42, h * 0.55, w * 0.38, h * 0.25, w * 0.55, h * 0.19);
    ctx.stroke();
    for (const [dx, dy] of [[0.40, 0.49], [0.44, 0.36], [0.50, 0.27]]) {
      ctx.beginPath(); ctx.moveTo(w * (dx - 0.02), h * (dy + 0.06));
      ctx.quadraticCurveTo(w * (dx + 0.13), h * (dy - 0.04), w * (dx + 0.20), h * dy); ctx.stroke();
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 7; i++) {
        ctx.beginPath(); ctx.moveTo(w * (dx + 0.056 + i * 0.018), h * dy);
        ctx.lineTo(w * (dx + 0.043 + i * 0.019), h * (dy - 0.069 + Math.cos(i) * 0.016)); ctx.stroke();
      }
      ctx.lineWidth = 2.5;
    }
  } else if (p.print === '金鯉') {
    ctx.save(); ctx.translate(w * 0.53, h * 0.39); ctx.rotate(-0.53);
    ctx.fillStyle = '#c49a70';
    ctx.beginPath(); ctx.ellipse(0, 0, w * 0.16, h * 0.067, 0, 0, 2 * Math.PI); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-w * 0.115, 0);
    ctx.quadraticCurveTo(-w * 0.20, -h * 0.02, -w * 0.24, -h * 0.079);
    ctx.quadraticCurveTo(-w * 0.29, 0, -w * 0.24, h * 0.068);
    ctx.quadraticCurveTo(-w * 0.18, h * 0.02, -w * 0.115, 0); ctx.fill();
    ctx.fillStyle = '#8b5548';
    for (const [x, y, r] of [[0.082, 0.01, 0.035], [0.018, -0.025, 0.034], [-0.064, 0.022, 0.038]]) {
      ctx.beginPath(); ctx.ellipse(w * x, h * y, w * r, h * r, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  } else if (p.finish === 'stone') {
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.ellipse(w * 0.55, h * 0.33, w * 0.12 + i * 11, h * 0.09 + i * 7, -0.23, 0.2, Math.PI * 1.75);
      ctx.stroke();
    }
    ctx.fillStyle = '#b78161';
    ctx.beginPath(); ctx.arc(w * 0.55, h * 0.33, h * 0.05, 0, 2 * Math.PI); ctx.fill();
  } else if (p.finish === 'cedar' || p.finish === 'brick') {
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 5; i++) {
      const level = 24 + i * h * 0.096;
      ctx.beginPath();
      ctx.moveTo(25, level + h * 0.27);
      ctx.bezierCurveTo(w * 0.32, level - 23, w * 0.55, level + h * 0.35, w - 27, level + h * 0.03);
      ctx.stroke();
    }
  } else {
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const up = 39 + i * 13;
      ctx.beginPath();
      ctx.moveTo(27, h * 0.58 - i * 5);
      ctx.lineTo(w * 0.4, up);
      ctx.lineTo(w * 0.64, up);
      ctx.lineTo(w - 29, h * 0.49 + i * 4);
      ctx.stroke();
    }
  }
  ctx.fillStyle = p.ink;
  ctx.textBaseline = 'middle';
  ctx.font = '700 23px "Hiragino Sans", "Yu Gothic", sans-serif';
  ctx.fillText(p.print, 19, h * 0.77);
  ctx.font = '14px Georgia, serif';
  ctx.fillText(p.caption, 19, h * 0.88);
  ctx.restore();
}

/** A wall vignette visible from both the chef and guest sides of the counter. */
export function dressRoom(b: Builder, atlas: Atlas, id: string, width: number, depth: number): void {
  const p = placeArt(id);
  if (!p) return;
  const x = -width / 2 + 0.145;
  const z = -depth * 0.30;
  const rect = atlas.custom(228, 176, (c, x, y, w, h) => paintPrint(c, x, y, w, h, p));
  b.box(x, 1.30, z, 0.10, 1.08, 1.53, p.ink);
  b.panel(x + 0.057, 1.84, z, 1.43, 1.00, rect, Math.PI / 2);

  // Wainscot and a thin display rail give each room a material and scale.
  b.box(x, 0.06, -depth * 0.5, 0.037, 0.22, depth - 0.5, p.ink);
  b.box(x, 0.96, -depth * 0.5, 0.055, 0.045, depth - 0.5, p.trim);
  if (p.finish === 'cedar' || p.finish === 'brick') {
    const shelf = -depth * 0.55;
    b.box(x + 0.13, 1.56, shelf, 0.26, 0.054, 1.04, p.trim);
    for (let i = 0; i < 3; i++) {
      const at = shelf + (i - 1) * 0.32;
      b.cyl(x + 0.13, 1.614, at, 0.106, 0.055, 0.098, i % 2 ? '#d5c0a0' : '#788980', 12);
      b.cyl(x + 0.13, 1.70, at, 0.109, 0.103, 0.012, '#cbb797', 12);
    }
  } else if (p.finish === 'stone') {
    const shelf = -depth * 0.69;
    b.box(x + 0.105, 1.48, shelf, 0.21, 0.043, 0.63, p.trim);
    b.add(G.sphere(0.131, 12, 8), '#8a9990', { at: [x + 0.11, 1.63, shelf], scale: [0.74, 1.05, 0.78] });
    b.cyl(x + 0.11, 1.714, shelf, 0.052, 0.06, 0.08, '#889790', 12);
    for (let i = 0; i < 3; i++) b.add(G.cyl(0.008, 0.008, 0.37 + i * 0.06, 5), '#695c48',
      { at: [x + 0.11, 1.77, shelf + i * 0.020], rot: [(i - 1) * 0.24, 0, -0.13] });
  }
}

function teaCup(b: Builder, x: number, y: number, z: number, ceramic: string): void {
  b.cyl(x, y, z, 0.060, 0.041, 0.074, ceramic, 12);
  b.cyl(x, y + 0.069, z, 0.047, 0.045, 0.004, '#7e7453', 12);
}

/** Guest-side millwork, place settings, and the shelves the chef uses during service. */
export function dressCounter(b: Builder, id: string, width: number, depth: number, left: number, right: number, z: number, concept: string, accent?: string): void {
  const p = placeArt(id);
  if (!p) return;
  const x = (left + right) / 2;
  const span = right - left;
  b.box(x, 0.17, z + 0.353, span - 0.09, 0.55, 0.021, accent ?? p.ink);
  b.box(x, 0.72, z + 0.369, span - 0.08, 0.017, 0.018, p.trim);
  const spacing = p.finish === 'cedar' ? 0.17 : p.finish === 'brick' ? 0.34 : p.finish === 'stone' ? 1.02 : 0.64;
  for (let x = left + spacing; x < right - 0.12; x += spacing) {
    b.box(x, 0.188, z + 0.367, 0.016, 0.51, 0.012, p.trim);
  }
  if (concept === 'bar' || concept === 'omakase') {
    const height = id.startsWith('ginza') ? 1.125 : 1.085;
    for (let i = 0; i < 4; i++) {
      const sx = left + (i + 0.55) * span / 4.4;
      b.rbox(sx, height, z + 0.315, 0.38, 0.025, 0.15, '#766053', 0.015);
      teaCup(b, sx + 0.099, height + 0.024, z + 0.317, i % 2 ? '#c2b194' : '#79938b');
      for (const dz of [-0.022, 0.02]) b.box(sx - 0.043, height + 0.026, z + 0.318 + dz, 0.128, 0.008, 0.008, '#d4b689');
    }
  }
  const shelfZ = -depth + 0.33;
  const wallX = width * 0.23;
  const shelfW = Math.min(2.62, width * 0.26);
  const base = p.finish === 'enamel' ? '#dbd2bb' : p.ink;
  b.box(wallX, 1.48, shelfZ - 0.17, shelfW, 1.10, 0.054, base);
  for (const y of [1.56, 2.08]) {
    b.box(wallX, y, shelfZ + 0.047, shelfW + 0.12, 0.046, 0.41, p.trim);
    b.box(wallX, y + 0.013, shelfZ + 0.255, shelfW + 0.10, 0.068, 0.018, p.ink);
  }
  for (let i = 0; i < 5; i++) {
    const sx = wallX + (i - 2) * (shelfW * 0.18);
    if (i < 3) {
      const glaze = ['#d2c09e', '#7a9290', '#a6856e'][i];
      for (let layer = 0; layer < i + 2; layer++) b.cyl(sx, 1.61 + layer * 0.049, shelfZ + 0.02, 0.135, 0.077, 0.043, glaze, 12);
    } else {
      b.rbox(sx, 1.606, shelfZ + 0.01, 0.20, 0.23, 0.20, '#9d775c', 0.028);
      b.box(sx, 1.823, shelfZ + 0.012, 0.216, 0.027, 0.215, p.ink);
      b.box(sx, 1.65, shelfZ + 0.114, 0.10, 0.076, 0.005, '#e2ccaa');
    }
    teaCup(b, sx, 2.13, shelfZ, i % 2 === 0 ? '#dfd2b7' : '#8b9b8f');
  }
  b.box(wallX, 2.535, shelfZ + 0.053, shelfW + 0.12, 0.044, 0.36, p.trim);
  b.add(G.box(shelfW - 0.25, 0.027, 0.04), '#f1dbb5', { at: [wallX, 2.51, shelfZ + 0.14], glow: '#f3b970' });
}

const STREET: Record<DistrictId, { ink: string; paper: string; jp: string; label: string; local: string; band: string }> = {
  asakusa: { ink: '#4d564b', paper: '#e4d4b1', jp: '浅草', label: 'Asakusa', local: 'Temple gate · Nakamise', band: '#ab886b' },
  shibuya: { ink: '#304e5a', paper: '#e0ded1', jp: '渋谷', label: 'Shibuya', local: 'Station square · Crossing', band: '#85949a' },
  shinjuku: { ink: '#40564d', paper: '#e2dac3', jp: '新宿', label: 'Shinjuku', local: 'West Exit · Business district', band: '#849785' },
  ginza: { ink: '#514a40', paper: '#e8dcc4', jp: '銀座', label: 'Ginza', local: 'Chuo-dori · Clock tower', band: '#ba9f76' },
};

export function dressStation(b: Builder, id: DistrictId): void {
  const p = STREET[id];
  // The street maps are mounted on the existing railing. The tiled apron sits flush in front.
  b.box(-1.76, 0.90, 0.089, 0.62, 1.38, 0.038, p.ink);
  b.sign(-1.76, 1.75, 0.114, 0.52, 0.50, p.jp, { bg: p.paper, fg: p.ink, px: 104 });
  b.sign(-1.76, 1.26, 0.114, 0.51, 0.33, p.label, { bg: p.ink, fg: p.paper, px: 104 });
  b.box(0, 0.018, 0.46, 3.48, 0.013, 0.78, p.paper);
  for (const z of [0.14, 0.76]) b.box(0, 0.032, z, 3.48, 0.005, 0.025, p.band);
  for (const x of [-1.15, -0.58, 0, 0.58, 1.15]) b.box(x, 0.032, 0.45, 0.014, 0.004, 0.61, p.band);
  b.sign(0, 2.48, 0.122, 3.48, 0.30, p.local, { bg: p.ink, fg: p.paper, px: 110 });
}

export function dressStreet(b: Builder, atlas: Atlas, id: DistrictId, x: number, z: number): void {
  const p = STREET[id];
  const plaque = atlas.custom(196, 132, (c, x, y, w, h) => {
    c.fillStyle = p.paper; c.fillRect(x, y, w, h);
    c.strokeStyle = p.band; c.lineWidth = 3; c.strokeRect(x + 6, y + 6, w - 12, h - 12);
    c.fillStyle = p.ink; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 43px "Hiragino Sans", "Yu Gothic", sans-serif';
    c.fillText(p.jp, x + w / 2, y + h * 0.42);
    c.font = 'bold 14px Georgia, serif'; c.fillText(p.label, x + w / 2, y + h * 0.73);
  });
  const dx = id === 'ginza' ? 2.05 : id === 'asakusa' ? -1.75 : 1.65;
  const dz = id === 'asakusa' ? -0.35 : 0.50;
  b.decal(x + dx, z + dz, 1.05, 0.70, plaque, 0.049);
  for (const offset of [-0.48, 0.48]) b.box(x + dx + offset, 0.038, z + dz, 0.022, 0.006, 0.63, p.band);
}

export function bronzeStationDog(b: Builder, x: number, z: number, yaw: number): void {
  const bronze = '#7a664d', shoulder = '#887051', dark = '#594d40', patina = '#626b58';
  b.push(x, 0, z, yaw);
  b.rbox(0, 0, 0, 1.64, 0.21, 1.15, '#81776a', 0.044);
  b.rbox(0, 0.20, 0, 1.49, 0.94, 1.05, '#a0927d', 0.05);
  b.rbox(0, 1.13, 0, 1.60, 0.10, 1.13, '#5c5650', 0.04);
  b.box(0, 0.54, 0.54, 0.92, 0.35, 0.022, dark);
  b.sign(0, 0.71, 0.557, 0.85, 0.30, '待ち合わせ', { bg: '#655648', fg: '#dfccaa', sub: 'Meeting point', px: 120 });

  b.add(G.sphere(0.42, 16, 11), bronze, { at: [0, 1.48, -0.12], scale: [0.77, 0.59, 0.86] });
  b.add(G.sphere(0.37, 16, 11), shoulder, { at: [0, 1.78, 0.10], rot: [-0.14, 0, 0], scale: [0.70, 1.16, 0.73] });
  b.add(G.sphere(0.24, 16, 12), bronze, { at: [0, 2.12, 0.17], scale: [0.94, 1.0, 1.06] });
  b.add(G.sphere(0.16, 13, 9), shoulder, { at: [0, 2.04, 0.342], scale: [0.89, 0.66, 1.16] });
  b.add(G.sphere(0.070, 10, 8), dark, { at: [0, 2.083, 0.496], scale: [1.15, 0.60, 0.66] });
  for (const side of [-1, 1]) {
    b.add(G.cone(0.133, 0.245, 4), bronze, { at: [side * 0.135, 2.248, 0.076], rot: [0.08, 0.3, -side * 0.28], scale: [0.9, 1, 0.65] });
    b.add(G.sphere(0.035, 8, 6), dark, { at: [side * 0.108, 2.118, 0.366], scale: [1.1, 0.58, 0.65] });
    const frontLeg = G.cyl(0.082, 0.072, 0.44, 10);
    b.add(frontLeg, shoulder, { at: [side * 0.149, 1.275, 0.22], rot: [0.07, 0, side * 0.053] });
    b.add(G.sphere(0.099, 11, 8), bronze, { at: [side * 0.149, 1.283, 0.306], scale: [0.82, 0.58, 1.35] });
    b.add(G.sphere(0.179, 12, 8), patina, { at: [side * 0.216, 1.41, -0.145], scale: [0.66, 0.85, 1.10] });
  }
  b.add(G.sphere(0.08), dark, { at: [0, 1.94, 0.314] });
  b.add(G.cyl(0.173, 0.171, 0.028, 14), dark, { at: [0, 1.943, 0.15], rot: [0.07, 0, 0] });
  b.add(G.sphere(0.03), '#b0986c', { at: [0, 1.929, 0.332] });
  b.add(G.sphere(0.04), patina, { at: [-0.197, 1.45, -0.399] });
  b.add(G.sphere(0.044), bronze, { at: [-0.153, 1.51, -0.449] });
  b.add(G.sphere(0.060), bronze, { at: [-0.091, 1.58, -0.474] });
  b.add(G.sphere(0.067), bronze, { at: [-0.032, 1.654, -0.455] });
  b.add(G.sphere(0.067), shoulder, { at: [-0.023, 1.716, -0.386] });
  b.add(G.sphere(0.058), shoulder, { at: [-0.066, 1.743, -0.323] });
  b.pop();
}

export function asakusaNoticeboard(b: Builder): void {
  b.push(-9.2, 0, 17.275, Math.PI);
  b.rbox(0, 0.67, 0, 2.08, 1.44, 0.105, '#78634d', 0.045);
  b.box(0, 0.75, 0.061, 1.87, 1.28, 0.015, '#c4a984');
  b.sign(0, 1.84, 0.073, 1.64, 0.27, '町内掲示板 · Neighborhood notices', { bg: '#4d5140', fg: '#ede2bc', px: 105 });
  b.sign(-0.43, 1.25, 0.075, 0.64, 0.68, '朝市', { bg: '#dbc8a6', fg: '#7c4738', sub: 'Morning market', px: 90 });
  b.sign(0.37, 1.28, 0.075, 0.59, 0.58, '町内清掃', { bg: '#dfd8bb', fg: '#4c5944', sub: 'Street clean-up', px: 90 });
  b.pop();
}
