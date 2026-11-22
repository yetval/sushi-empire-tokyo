// Street signage for the "architect's model of Tokyo" look: crafted shop boards, neon, lanterns, banners and
// street-level clutter, all from one shared canvas atlas and merged into one mesh per city block.
//
// ---------------------------------------------------------------------------------------------- API
//   fitText(ctx, text, w, h, o) / drawFitted(ctx, fitted, cx, cy, paint)
//       Text layout that never clips: measures the real glyphs, picks 1 or 2 lines (or 1-2 vertical columns),
//       and returns the largest font size that fits the box. Handles '\n', vertical kana/kanji and rotated 'ー'.
//   class SignKit (local frame stack like kit.Builder: facade at local z=0 faces +z, y up)
//       verticalBoard, fascia, neonSign, blade, chochin, lanternString, nobori, aFrame, standSign, vending,
//       ticker, tenantBoard, lampBanner ... then build() -> THREE.Group (one draw call per ~56 m cell + 1 for tickers).
//   dressStreet(group, id, colliders)
//       Finds street facades from the building colliders and dresses them per district (Shibuya/Shinjuku dense
//       neon, Asakusa warm wood and lanterns, Ginza restrained). Pushes a few small colliders (vending, stands).
//
// Night: emission is driven by materials.nightGlow (no per-frame JS); flicker, banner flutter and ticker scroll run
// in the vertex shader from one time uniform. All shop names are invented.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DistrictId } from '../core/data';
import type { Collider } from '../engine/collision';
import { PALETTE, bevelBox, nightGlow } from './materials';

// ================================================================ fonts & colour helpers
export const GOTHIC = "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','Noto Sans JP',sans-serif";
export const MINCHO = "'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP',serif";
export const MARU = "'Hiragino Maru Gothic ProN','Hiragino Sans','Noto Sans JP',sans-serif";
const CHALK = "'Klee','Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif";

const shade = (hex: string, f: number) => '#' + new THREE.Color(hex).multiplyScalar(f).getHexString();
const mix = (a: string, b: string, t: number) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
function seeded(seed: number): () => number { // same mulberry32 as kit.rng (not imported: kit may import this file)
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)];

// ================================================================ text that never clips
export interface FitOpts { font?: string; weight?: number | string; vertical?: boolean; maxLines?: number; lh?: number; maxSize?: number }
export interface Fitted { size: number; lines: string[]; vertical: boolean; font: string; weight: number | string; lh: number }
/** Glyphs turned 90° when set vertically. */
const ROT = new Set([...'ー－−〜～…‥()（）「」『』-—=＝']);
const NO_START = new Set([...'ーゃゅょっャュョッァィゥェォ、。・」』）)']);

function split2(text: string): string[] | null {
  const t = text.trim();
  let cut = -1;
  const half = t.length / 2;
  for (let i = 1; i < t.length - 1; i++) if (t[i] === ' ' && (cut < 0 || Math.abs(i - half) < Math.abs(cut - half))) cut = i;
  if (cut > 0) return [t.slice(0, cut).trim(), t.slice(cut + 1).trim()];
  const chars = [...t];
  if (chars.length < 3) return null;
  let k = Math.ceil(chars.length / 2);
  while (k < chars.length - 1 && NO_START.has(chars[k])) k++;
  return [chars.slice(0, k).join(''), chars.slice(k).join('')];
}

/** Largest layout of `text` inside a w x h px box: one line, or two lines when that is clearly bigger. */
export function fitText(c: CanvasRenderingContext2D, text: string, w: number, h: number, o: FitOpts = {}): Fitted {
  const font = o.font ?? GOTHIC, weight = o.weight ?? 700, vertical = !!o.vertical, lh = o.lh ?? (vertical ? 1.06 : 1.18);
  c.font = `${weight} 100px ${font}`;
  const em = (s: string) => c.measureText(s).width / 100;
  const forced = text.split('\n').filter((l) => l.length);
  const cands: string[][] = forced.length > 1 ? [forced] : [[text.trim()]];
  if (forced.length <= 1 && (o.maxLines ?? 2) > 1) { const s = split2(text); if (s) cands.push(s); }
  let best: Fitted | null = null;
  for (const lines of cands) {
    let size: number;
    if (vertical) {
      const cols = lines.map((l) => [...l.replace(/\s+/g, '')]);
      const rows = Math.max(...cols.map((l) => l.length));
      const cw = Math.max(0.6, ...cols.flat().map((ch) => (ROT.has(ch) ? 1 : em(ch))));
      size = Math.min(w / (cols.length * cw * 1.1), h / (rows * lh));
    } else {
      size = Math.min(w / Math.max(0.01, ...lines.map(em)), h / (lines.length * lh));
    }
    if (o.maxSize) size = Math.min(size, o.maxSize);
    if (!best || size > best.size * 1.15) best = { size, lines, vertical, font, weight, lh };
  }
  return best!;
}

/** Draw a fitted layout centred at (cx, cy). `paint` draws one run at (0,0) (fillText/strokeText, any passes). */
export function drawFitted(c: CanvasRenderingContext2D, f: Fitted, cx: number, cy: number, paint: (s: string) => void, align: 'center' | 'left' = 'center', left = 0): void {
  c.font = `${f.weight} ${f.size}px ${f.font}`;
  c.textAlign = align; c.textBaseline = 'middle';
  const n = f.lines.length;
  if (!f.vertical) {
    f.lines.forEach((l, i) => { c.save(); c.translate(align === 'left' ? left : cx, cy + (i - (n - 1) / 2) * f.size * f.lh); paint(l); c.restore(); });
    return;
  }
  c.textAlign = 'center';
  f.lines.forEach((l, i) => {
    const chars = [...l.replace(/\s+/g, '')];
    const x = cx + ((n - 1) / 2 - i) * f.size * 1.12; // columns read right to left
    chars.forEach((ch, j) => {
      c.save();
      c.translate(x, cy + (j - (chars.length - 1) / 2) * f.size * f.lh);
      if (ROT.has(ch)) c.rotate(Math.PI / 2);
      paint(ch);
      c.restore();
    });
  });
}

// ================================================================ shared atlas
type Rect = [number, number, number, number]; // u0 v0 u1 v1
type Paint = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;
const PAD = 4; // gutter filled with the sign's background, so mipmaps never bleed a neighbour in

class SignAtlas {
  readonly size = 2048;
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  private shelves: { y: number; h: number; x: number }[] = [];
  private bottom = 0;
  private cache = new Map<string, Rect>();
  white: [number, number] = [0, 0];
  constructor() {
    this.canvas.width = this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.reset();
  }
  /** Only one district lives at a time: start a fresh page for it. */
  reset(): void {
    this.ctx.clearRect(0, 0, this.size, this.size);
    this.shelves = []; this.bottom = 0;
    this.cache.clear();
    const r = this.region('white', 8, 8, (c, x, y, w, h) => { c.fillStyle = '#ffffff'; c.fillRect(x - PAD, y - PAD, w + PAD * 2, h + PAD * 2); });
    this.white = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  }
  /** Reserve (or reuse, by key) a w x h px region, paint it, return its UV rect. */
  region(key: string, w: number, h: number, paint: Paint): Rect {
    const hit = this.cache.get(key);
    if (hit) return hit;
    w = Math.max(4, Math.ceil(w)); h = Math.max(4, Math.ceil(h));
    const W = w + PAD * 2, H = h + PAD * 2;
    // shelf packing with height buckets: a 40 px tag never opens (and wastes) a 500 px row
    let sh = this.shelves.find((q) => q.h >= H && q.h <= H * 1.35 + 8 && q.x + W <= this.size);
    if (!sh) {
      if (this.bottom + H > this.size || W > this.size) { console.warn('[signage] atlas full, sign skipped:', key); const [u, v] = this.white; return [u, v, u, v]; }
      sh = { y: this.bottom, h: H, x: 0 };
      this.shelves.push(sh); this.bottom += H;
    }
    const px = sh.x + PAD, py = sh.y + PAD, S = this.size;
    this.ctx.save(); paint(this.ctx, px, py, w, h); this.ctx.restore();
    sh.x += W;
    const r: Rect = [px / S, 1 - (py + h) / S, (px + w) / S, 1 - py / S];
    this.cache.set(key, r);
    this.tex.needsUpdate = true;
    return r;
  }
}

// ================================================================ painters (canvas artwork)
const fillPad = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, style: string | CanvasGradient) => {
  c.fillStyle = style; c.fillRect(x - PAD, y - PAD, w + PAD * 2, h + PAD * 2);
};

interface BoardArt { text: string; bg: string; fg: string; font?: string; weight?: number; vertical?: boolean; sub?: string; keyline?: string; maxLines?: number }
/** Backlit shop board: soft centre glow (the tubes behind the acrylic), keyline, embossed lettering, optional sub-line. */
function paintBoard(o: BoardArt): Paint {
  return (c, x, y, w, h) => {
    fillPad(c, x, y, w, h, o.bg);
    const g = o.vertical ? c.createLinearGradient(x, 0, x + w, 0) : c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(o.bg, 0.9)); g.addColorStop(0.5, shade(o.bg, 1.08)); g.addColorStop(1, shade(o.bg, 0.9));
    c.fillStyle = g; c.fillRect(x, y, w, h);
    const m = Math.min(w, h);
    if (o.keyline) { c.strokeStyle = o.keyline; c.lineWidth = Math.max(1.5, m * 0.035); const k = m * 0.07; c.strokeRect(x + k, y + k, w - 2 * k, h - 2 * k); }
    const inset = m * (o.keyline ? 0.16 : 0.1);
    const subH = o.sub ? (o.vertical ? 0 : h * 0.24) : 0;
    const subW = o.sub && o.vertical ? w * 0.3 : 0;
    const f = fitText(c, o.text, w - inset * 2 - subW, h - inset * 2 - subH, { font: o.font, weight: o.weight ?? 800, vertical: o.vertical, maxLines: o.maxLines });
    const cx = x + (w - subW) / 2 + (o.vertical && subW ? subW : 0), cy = y + (h - subH) / 2;
    drawFitted(c, f, cx, cy, (s) => { c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillText(s, f.size * 0.025, f.size * 0.035); c.fillStyle = o.fg; c.fillText(s, 0, 0); });
    if (o.sub) {
      const sf = o.vertical
        ? fitText(c, o.sub, subW * 0.8, h - inset * 2, { font: o.font, weight: 600, vertical: true, maxLines: 1 })
        : fitText(c, o.sub, w - inset * 2.4, subH * 0.8, { font: o.font, weight: 600, maxLines: 1 });
      const sx = o.vertical ? x + subW * 0.62 : x + w / 2, sy = o.vertical ? y + h / 2 : y + h - inset * 0.7 - subH / 2;
      drawFitted(c, sf, sx, sy, (s) => { c.fillStyle = o.fg; c.globalAlpha = 0.85; c.fillText(s, 0, 0); c.globalAlpha = 1; });
    }
  };
}

/** Neon on a dark backing: wide coloured halo, tube body, hot near-white core (reads as bent glass tubes). */
function paintNeon(text: string, color: string, vertical = false, font = GOTHIC): Paint {
  return (c, x, y, w, h) => {
    fillPad(c, x, y, w, h, '#120f16');
    const v = c.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
    v.addColorStop(0, mix('#120f16', color, 0.1)); v.addColorStop(1, '#0d0b10');
    c.fillStyle = v; c.fillRect(x, y, w, h);
    const m = Math.min(w, h), inset = m * 0.16;
    const f = fitText(c, text, w - inset * 2, h - inset * 2, { font, weight: 500, vertical });
    c.lineJoin = 'round'; c.lineCap = 'round';
    drawFitted(c, f, x + w / 2, y + h / 2, (s) => {
      c.shadowColor = color; c.shadowBlur = f.size * 0.32;
      c.strokeStyle = mix(color, '#000000', 0.25); c.lineWidth = f.size * 0.1; c.globalAlpha = 0.38; c.strokeText(s, 0, 0);
      c.globalAlpha = 1; c.shadowBlur = f.size * 0.14;
      c.strokeStyle = color; c.lineWidth = f.size * 0.075; c.strokeText(s, 0, 0);
      c.shadowBlur = 0;
      c.strokeStyle = mix(color, '#ffffff', 0.45); c.lineWidth = f.size * 0.028; c.strokeText(s, 0, 0);
    });
  };
}

/** Slate A-board: chalk title, items with prices, smudges and dry-chalk breakup. */
function paintChalk(title: string, items: string[], seed: number): Paint {
  return (c, x, y, w, h) => {
    const r = seeded(seed);
    fillPad(c, x, y, w, h, '#26302b');
    for (let i = 0; i < 26; i++) { c.fillStyle = `rgba(235,240,230,${0.015 + r() * 0.03})`; c.beginPath(); c.ellipse(x + r() * w, y + r() * h, w * (0.1 + r() * 0.3), h * (0.03 + r() * 0.08), r() * 3, 0, 7); c.fill(); }
    const m = w * 0.1;
    const tf = fitText(c, title, w - m * 2, h * 0.17, { font: CHALK, weight: 600, maxLines: 1 });
    drawFitted(c, tf, x + w / 2, y + h * 0.15, (s) => { c.fillStyle = '#f6f0df'; c.fillText(s, 0, 0); });
    c.strokeStyle = 'rgba(246,240,223,0.7)'; c.lineWidth = Math.max(1.5, w * 0.012);
    c.beginPath(); c.moveTo(x + m, y + h * 0.27); c.quadraticCurveTo(x + w / 2, y + h * 0.25, x + w - m, y + h * 0.27); c.stroke();
    const cols = ['#f6f0df', '#ffd98a', '#f6f0df', '#ffb3a6'];
    const rowH = (h * 0.66) / Math.max(3, items.length);
    items.forEach((it, i) => {
      const f = fitText(c, it, w - m * 2, rowH * 0.62, { font: CHALK, weight: 600, maxLines: 1 });
      drawFitted(c, f, x + w / 2, y + h * 0.33 + rowH * (i + 0.5), (s) => { c.fillStyle = cols[i % cols.length]; c.fillText(s, 0, 0); });
    });
    // dry chalk: knock random flecks out of the strokes
    c.fillStyle = '#26302b';
    for (let i = 0; i < w * h * 0.004; i++) c.fillRect(x + r() * w, y + r() * h, 1 + r() * 1.5, 1);
    c.strokeStyle = '#5a4a3a'; c.lineWidth = Math.max(2, w * 0.03); c.strokeRect(x, y, w, h);
  };
}

/** Nobori banner: pole-side hem with loops (chichi), top hem, big vertical text. */
function paintBanner(text: string, bg: string, fg: string): Paint {
  return (c, x, y, w, h) => {
    fillPad(c, x, y, w, h, bg);
    const hem = w * 0.12;
    c.fillStyle = shade(bg, 0.78); c.fillRect(x, y, hem, h); c.fillRect(x, y, w, h * 0.035);
    c.fillStyle = mix(bg, '#ffffff', 0.55);
    for (let k = 0; k < 7; k++) c.fillRect(x, y + h * (0.06 + k * 0.14), hem * 0.6, h * 0.03);
    c.fillRect(x + hem, y + h * 0.05, w - hem, h * 0.008); c.fillRect(x + hem, y + h * 0.95, w - hem, h * 0.008);
    const f = fitText(c, text, w - hem - w * 0.14, h * 0.82, { vertical: true, weight: 800, font: GOTHIC, maxLines: 1 });
    drawFitted(c, f, x + hem + (w - hem) / 2, y + h * 0.5, (s) => { c.fillStyle = fg; c.fillText(s, 0, 0); });
  };
}

/** Chochin paper: ribs, dark ends, a character on the front and the back (u = 0.25 and 0.75). */
function paintChochin(text: string, bg: string, ink: string): Paint {
  return (c, x, y, w, h) => {
    fillPad(c, x, y, w, h, bg);
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(bg, 0.7)); g.addColorStop(0.5, shade(bg, 1.12)); g.addColorStop(1, shade(bg, 0.7));
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(40,20,10,0.22)';
    for (let k = 1; k < 16; k++) c.fillRect(x, y + (k / 16) * h - 0.6, w, 1.2);
    if (!text) return;
    for (const u of [0.25, 0.75]) {
      const f = fitText(c, text, w * 0.3, h * 0.7, { vertical: true, font: MINCHO, weight: 800, maxLines: 1 });
      drawFitted(c, f, x + w * u, y + h / 2, (s) => { c.fillStyle = ink; c.fillText(s, 0, 0); });
    }
  };
}

/** Vending machine front: lit sample window with three rows of cans, price strips, brand band, slot and outlet. */
function paintVending(brand: string, body: string, seed: number): Paint {
  return (c, x, y, w, h) => {
    const r = seeded(seed);
    fillPad(c, x, y, w, h, body);
    const wx = x + w * 0.07, ww = w * 0.86, wy = y + h * 0.05, wh = h * 0.55;
    const g = c.createLinearGradient(0, wy, 0, wy + wh); g.addColorStop(0, '#f8fbfc'); g.addColorStop(1, '#dfe8ec');
    c.fillStyle = g; c.fillRect(wx, wy, ww, wh);
    const cans = ['#d9362b', '#2f6fd1', '#f0c23a', '#3f9a57', '#f08a3c', '#ffffff', '#8a4fb5', '#e8e2d0', '#1d1d24'];
    for (let row = 0; row < 3; row++) {
      const ry = wy + row * (wh / 3);
      const n = 6, cw = ww / n;
      for (let k = 0; k < n; k++) {
        const col = pick(r, cans), cx = wx + k * cw + cw * 0.2, cy = ry + wh / 3 * 0.12, chh = wh / 3 * 0.58, cww = cw * 0.6;
        c.fillStyle = col; c.beginPath(); c.roundRect(cx, cy, cww, chh, cww * 0.25); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(cx, cy + chh * 0.42, cww, chh * 0.18);
        c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(cx + cww * 0.15, cy + chh * 0.05, cww * 0.12, chh * 0.85);
        c.fillStyle = '#1b1d22'; c.fillRect(wx + k * cw + cw * 0.12, ry + wh / 3 * 0.76, cw * 0.76, wh / 3 * 0.13);
        c.fillStyle = '#6dff8a'; c.fillRect(wx + k * cw + cw * 0.18, ry + wh / 3 * 0.79, cw * 0.18, wh / 3 * 0.07);
      }
    }
    c.fillStyle = shade(body, 0.8); c.fillRect(x, y + h * 0.62, w, h * 0.1);
    const f = fitText(c, brand, w * 0.8, h * 0.07, { font: GOTHIC, weight: 800, maxLines: 1 });
    drawFitted(c, f, x + w / 2, y + h * 0.67, (s) => { c.fillStyle = '#ffffff'; c.fillText(s, 0, 0); });
    c.fillStyle = '#2a2c31'; c.fillRect(x + w * 0.62, y + h * 0.75, w * 0.22, h * 0.06);
    c.fillStyle = '#c9ced4'; c.fillRect(x + w * 0.68, y + h * 0.765, w * 0.1, h * 0.012);
    c.fillStyle = '#17181c'; c.fillRect(x + w * 0.12, y + h * 0.84, w * 0.76, h * 0.1);
  };
}

/** Building tenant directory: stacked lit panels, one bar/clinic per floor. */
function paintTenants(names: string[], bgs: string[], fgs: string[], font: string): Paint {
  return (c, x, y, w, h) => {
    fillPad(c, x, y, w, h, '#2b2c30');
    const ph = h / names.length;
    names.forEach((n, i) => {
      const py = y + i * ph;
      c.fillStyle = bgs[i % bgs.length]; c.fillRect(x + w * 0.06, py + ph * 0.08, w * 0.88, ph * 0.84);
      const f = fitText(c, n, w * 0.74, ph * 0.58, { font, weight: 700, maxLines: 1 });
      drawFitted(c, f, x + w / 2, py + ph / 2, (s) => { c.fillStyle = fgs[i % fgs.length]; c.fillText(s, 0, 0); });
    });
  };
}

// ================================================================ LED ticker strip (its own scrolling texture)
const TROW_H = 48, TW = 1024, DOT = 3;
const TICKS = [
  '本日 生ビール半額 17:00-19:00 ・ 全席禁煙 ・ ご予約承ります ・ ',
  'ようこそ ・ WELCOME ・ 空室あり 1H ¥600 ・ 学生割引 ・ ',
  'ランチ営業中 11:30-14:00 ・ 日替わり定食 ¥880 ・ ',
  '新装開店 ・ 本日のおすすめ 焼き餃子 ・ 深夜2時まで営業 ・ ',
  'カラオケ 30分 ¥300 ・ フリータイム ・ 飲み放題 ・ ',
  'OPEN 24H ・ お薬 ・ 化粧品 ・ ポイント5倍デー ・ ',
  '銀座 秋の夜長 ・ ワインと季節の料理 ・ ',
  'いらっしゃいませ ・ 焼きたて ・ 毎日11時から ・ ',
];
const TCOLS = ['#ff9a2e', '#ff5a3c', '#7dff7a', '#ffc94a', '#ff9a2e', '#5ad1ff', '#ffd9a0', '#ff9a2e'];
let tickerTex: THREE.CanvasTexture | null = null;
function tickerTexture(): THREE.CanvasTexture {
  if (tickerTex) return tickerTex;
  const cv = document.createElement('canvas'); cv.width = TW; cv.height = 512;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#0e0d10'; c.fillRect(0, 0, TW, 512);
  const cols = Math.floor(TW / DOT), rows = TROW_H / DOT;
  const small = document.createElement('canvas'); small.width = cols; small.height = rows;
  const s = small.getContext('2d')!;
  TICKS.forEach((msg, i) => {
    s.fillStyle = '#000'; s.fillRect(0, 0, cols, rows);
    s.fillStyle = '#fff'; s.textBaseline = 'middle'; s.font = `700 ${rows - 2}px ${GOTHIC}`;
    s.fillText(msg + msg, 2, rows / 2 + 1);
    const d = s.getImageData(0, 0, cols, rows).data;
    const on = new THREE.Color(TCOLS[i]), off = '#24181a';
    for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) {
      const a = d[(yy * cols + xx) * 4] / 255;
      c.fillStyle = a > 0.35 ? '#' + on.clone().multiplyScalar(0.6 + 0.4 * a).getHexString() : off;
      c.fillRect(xx * DOT, i * TROW_H + yy * DOT, DOT - 1, DOT - 1);
    }
  });
  tickerTex = new THREE.CanvasTexture(cv);
  tickerTex.colorSpace = THREE.SRGBColorSpace;
  tickerTex.wrapS = THREE.RepeatWrapping;
  tickerTex.anisotropy = 4;
  return tickerTex;
}

// ================================================================ material
const uTime = { value: 0 };
function signMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.5, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = nightGlow; sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nattribute vec3 aAnim;\nuniform float uTime;\nvarying vec3 vGlow;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv.x += uTime * aAnim.z;\n#endif')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{ // cloth flutter (aAnim.y = signed weight: 0 at the pole, 1 at the free edge)
  float fw = aAnim.y;
  if (fw != 0.0) {
    float ph = uTime * 2.4 + dot(position.xz, vec2(1.7, 1.3)) + position.y * 0.9;
    transformed += objectNormal * fw * (0.06 * sin(ph) + 0.025 * sin(ph * 2.3 + 1.7));
  }
}
vGlow = aGlow;
if (aAnim.x > 0.0) { // tired neon: short stuttering bursts, otherwise steady
  float s = aAnim.x * 17.0;
  float burst = step(0.88, fract(uTime * 0.09 + s));
  float n = fract(sin(floor(uTime * 15.0) * 12.9898 + s * 78.233) * 43758.5453);
  vGlow *= mix(1.0, n < 0.5 ? 0.06 : 1.0, burst);
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * diffuseColor.rgb * (0.08 + uNight);');
  };
  m.customProgramCacheKey = () => 'signage';
  return m;
}

let ATLAS: SignAtlas | null = null;
let SIGN_MAT: THREE.MeshStandardMaterial | null = null;
let TICK_MAT: THREE.MeshStandardMaterial | null = null;
function shared(): { atlas: SignAtlas; sign: THREE.MeshStandardMaterial; tick: THREE.MeshStandardMaterial } {
  if (!ATLAS) { ATLAS = new SignAtlas(); SIGN_MAT = signMaterial(ATLAS.tex); TICK_MAT = signMaterial(tickerTexture()); }
  return { atlas: ATLAS, sign: SIGN_MAT!, tick: TICK_MAT! };
}

// ================================================================ geometry kit
interface Part {
  color?: string; rect?: Rect; flipU?: boolean;
  /** Emission at night (x texel x vertex colour). ~0.9 lit board (no bloom), 1.5+ blooms (neon, LEDs). */
  glow?: number; flick?: number;
  /** Flutter weight from the source uv (0 = held edge). Sign flips it for back faces. */
  flutter?: (u: number, v: number) => number;
  scroll?: number; ticker?: boolean;
  at?: [number, number, number]; rot?: [number, number, number]; scale?: [number, number, number];
}
const _c = new THREE.Color(), _t = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const DARK = PALETTE.metalDark, STEEL = '#5b5f66', BRASS = '#b8913f';

function roundRectPts(w: number, h: number, r: number, seg = 4): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const cs: [number, number, number][] = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI], [w / 2 - r, -h / 2 + r, Math.PI * 1.5]];
  for (const [cx, cy, a0] of cs) for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * (Math.PI / 2); pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0)); }
  return pts;
}
/** Chochin body: a lathe swelling from both rims (unit height, radius 0.5 at the waist). */
const LATHE = new THREE.LatheGeometry(Array.from({ length: 9 }, (_, i) => { const t = i / 8; return new THREE.Vector2(0.5 * (0.62 + 0.38 * Math.sin(t * Math.PI)), t); }), 14);

export class SignKit {
  private cells = new Map<string, THREE.BufferGeometry[]>();
  private ticks: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  readonly atlas: SignAtlas;
  constructor(private cell = 56) { this.atlas = shared().atlas; }

  push(x: number, y: number, z: number, ry = 0): this { this.stack.push(this.m.clone()); this.m.multiply(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z)); return this; }
  pop(): this { this.m = this.stack.pop()!; return this; }
  world(x: number, y: number, z: number): THREE.Vector3 { return new THREE.Vector3(x, y, z).applyMatrix4(this.m); }

  /** Add an owned geometry (fresh or cloned) in the current frame. */
  add(g: THREE.BufferGeometry, o: Part = {}): this {
    if (!g.index) { const n0 = g.attributes.position.count; g.setIndex(Array.from({ length: n0 }, (_, i) => i)); }
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const anim = new Float32Array(n * 3), col = new Float32Array(n * 3), glow = new Float32Array(n * 3);
    _c.set(o.color ?? '#ffffff');
    const gl = o.glow ?? 0;
    const [wu, wv] = this.atlas.white;
    for (let i = 0; i < n; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      anim[i * 3] = o.flick ?? 0; anim[i * 3 + 1] = o.flutter ? o.flutter(u, v) : 0; anim[i * 3 + 2] = o.scroll ?? 0;
      if (o.ticker) { /* caller set ticker uvs */ }
      else if (o.rect) { const uu = o.flipU ? 1 - u : u; uv.setXY(i, o.rect[0] + uu * (o.rect[2] - o.rect[0]), o.rect[1] + v * (o.rect[3] - o.rect[1])); }
      else uv.setXY(i, wu, wv);
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      glow[i * 3] = glow[i * 3 + 1] = glow[i * 3 + 2] = gl;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 3));
    g.setAttribute('aAnim', new THREE.BufferAttribute(anim, 3));
    if (o.at || o.rot || o.scale) g.applyMatrix4(_t.compose(_p.set(...(o.at ?? [0, 0, 0])), _q.setFromEuler(_e.set(...(o.rot ?? [0, 0, 0]))), _s.set(...(o.scale ?? [1, 1, 1]))));
    g.applyMatrix4(this.m);
    if (o.ticker) { this.ticks.push(g); return this; }
    g.computeBoundingBox();
    const ctr = g.boundingBox!.getCenter(_p);
    const key = `${Math.floor(ctr.x / this.cell)},${Math.floor(ctr.z / this.cell)}`;
    let L = this.cells.get(key);
    if (!L) this.cells.set(key, (L = []));
    L.push(g);
    return this;
  }

  // ---------------------------------------------------------------- primitives (centred unless noted)
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, glow = 0): this {
    return this.add(bevelBox(w, h, d).clone(), { color, glow, at: [x, y, z] });
  }
  cyl(x: number, y: number, z: number, r: number, h: number, color: string, o: Part = {}): this {
    return this.add(new THREE.CylinderGeometry(r, r, h, 8), { color, at: [x, y, z], ...o });
  }
  /** Textured face facing local +z (or rotated by ry), centred. */
  face(x: number, y: number, z: number, w: number, h: number, rect: Rect, glow: number, ry = 0, o: Part = {}): this {
    return this.add(new THREE.PlaneGeometry(w, h), { rect, glow, at: [x, y, z], rot: [0, ry, 0], ...o });
  }
  bolts(x: number, y: number, z: number, w: number, h: number, inset: number): this {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) this.add(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 6), { color: '#9a9ea4', at: [x + sx * (w / 2 - inset), y + sy * (h / 2 - inset), z], rot: [Math.PI / 2, 0, 0] });
    return this;
  }
  /** Emissive glass tube along a rounded rectangle (neon border). */
  tubeRect(x: number, y: number, z: number, w: number, h: number, color: string, glow = 2.2, flick = 0, rad = 0.022): this {
    const curve = new THREE.CatmullRomCurve3(roundRectPts(w, h, Math.min(w, h) * 0.12), true, 'catmullrom', 0.1);
    return this.add(new THREE.TubeGeometry(curve, 40, rad, 5, true), { color: mix(color, '#ffffff', 0.15), glow, flick, at: [x, y, z] });
  }
  private px(wm: number, hm: number, ppm: number, max = 384): [number, number] {
    const k = Math.min(ppm, max / Math.max(wm, hm));
    return [wm * k, hm * k];
  }

  // ---------------------------------------------------------------- signs (local frame: facade z=0, +z out)
  /** Tate-kanban: tall framed lightbox with bolts, flush on standoffs. (x, y) = bottom centre. */
  verticalBoard(x: number, y: number, z: number, w: number, h: number, text: string, o: { bg: string; fg: string; frame?: string; font?: string; sub?: string; glow?: number; keyline?: string; ppm?: number } = { bg: '#fff', fg: '#000' }): this {
    const fr = o.frame ?? DARK, t = Math.min(0.07, w * 0.08), d = 0.16;
    const [pw, ph] = this.px(w - 2 * t, h - 2 * t, o.ppm ?? 110);
    const rect = this.atlas.region(`vb|${text}|${o.bg}|${o.fg}|${o.font}|${o.sub}|${o.keyline}|${pw | 0}x${ph | 0}`, pw, ph, paintBoard({ text, bg: o.bg, fg: o.fg, font: o.font, vertical: true, sub: o.sub, keyline: o.keyline }));
    const cy = y + h / 2;
    this.box(x, cy, z + d / 2, w, h, d, fr);
    this.face(x, cy, z + d + 0.004, w - 2 * t, h - 2 * t, rect, o.glow ?? 0.85);
    this.bolts(x, cy, z + d + 0.01, w, h, t / 2);
    for (const sy of [-1, 1]) this.box(x, cy + sy * h * 0.35, z + 0.02, w * 0.5, 0.06, 0.06, STEEL); // standoff rails
    return this;
  }
  /** Horizontal storefront fascia: bevelled box, lit face, thin top cap. (x, y) = bottom centre. */
  fascia(x: number, y: number, z: number, w: number, h: number, text: string, o: { bg: string; fg: string; frame?: string; font?: string; sub?: string; glow?: number; keyline?: string; ppm?: number }): this {
    const fr = o.frame ?? DARK, t = Math.min(0.05, h * 0.08), d = 0.14;
    const [pw, ph] = this.px(w - 2 * t, h - 2 * t, o.ppm ?? 110);
    const rect = this.atlas.region(`fa|${text}|${o.bg}|${o.fg}|${o.font}|${o.sub}|${o.keyline}|${pw | 0}x${ph | 0}`, pw, ph, paintBoard({ text, bg: o.bg, fg: o.fg, font: o.font, sub: o.sub, keyline: o.keyline }));
    const cy = y + h / 2;
    this.box(x, cy, z + d / 2, w, h, d, fr);
    this.face(x, cy, z + d + 0.004, w - 2 * t, h - 2 * t, rect, o.glow ?? 0.8);
    this.box(x, y + h + 0.02, z + d / 2 + 0.02, w + 0.06, 0.04, d + 0.06, fr);
    return this;
  }
  /** Neon sign: dark backing box on brackets, neon artwork, glass tube border. (x, y) = bottom centre. */
  neonSign(x: number, y: number, z: number, w: number, h: number, text: string, o: { color: string; vertical?: boolean; flick?: number; font?: string; border?: boolean }): this {
    const d = 0.1, [pw, ph] = this.px(w, h, 100);
    const rect = this.atlas.region(`ne|${text}|${o.color}|${o.vertical}|${o.font}|${pw | 0}x${ph | 0}`, pw, ph, paintNeon(text, o.color, o.vertical, o.font));
    const cy = y + h / 2;
    this.box(x, cy, z + 0.12 + d / 2, w + 0.08, h + 0.08, d, '#16141a');
    this.face(x, cy, z + 0.12 + d + 0.004, w, h, rect, 1.6, 0, { flick: o.flick });
    if (o.border !== false) this.tubeRect(x, cy, z + 0.12 + d + 0.035, w - 0.06, h - 0.06, o.color, 1.9, o.flick);
    for (const sx of [-1, 1]) this.box(x + sx * w * 0.32, cy, z + 0.06, 0.05, h * 0.7, 0.12, STEEL);
    return this;
  }
  /** Projecting blade sign: lettered on both faces, bracket arms back to the wall. Facade at z=0, sign spans z0..z0+w. */
  blade(x: number, y: number, z0: number, w: number, h: number, text: string, o: { bg: string; fg: string; neon?: string; font?: string; glow?: number; frame?: string; vertical?: boolean; flick?: number }): this {
    const th = 0.16, fr = o.frame ?? DARK, zc = z0 + w / 2, cy = y + h / 2;
    const [pw, ph] = this.px(w - 0.08, h - 0.08, 90);
    const vertical = o.vertical ?? h > w * 1.4;
    const rect = o.neon
      ? this.atlas.region(`bn|${text}|${o.neon}|${vertical}|${pw | 0}x${ph | 0}`, pw, ph, paintNeon(text, o.neon, vertical, o.font))
      : this.atlas.region(`bl|${text}|${o.bg}|${o.fg}|${o.font}|${vertical}|${pw | 0}x${ph | 0}`, pw, ph, paintBoard({ text, bg: o.bg, fg: o.fg, font: o.font, vertical, keyline: mix(o.bg, o.fg, 0.5) }));
    this.box(x, cy, zc, th, h, w, o.neon ? '#16141a' : fr);
    const gl = o.neon ? 1.6 : o.glow ?? 0.85;
    this.face(x + th / 2 + 0.004, cy, zc, w - 0.08, h - 0.08, rect, gl, Math.PI / 2, { flick: o.flick });
    this.face(x - th / 2 - 0.004, cy, zc, w - 0.08, h - 0.08, rect, gl, -Math.PI / 2, { flick: o.flick });
    if (o.neon) for (const sx of [-1, 1]) this.push(x + sx * (th / 2 + 0.03), cy, zc, Math.PI / 2).tubeRect(0, 0, 0, w - 0.14, h - 0.14, o.neon, 1.9, o.flick).pop();
    for (const fy of [h * 0.38, -h * 0.38]) { this.box(x, cy + fy, z0 / 2, 0.05, 0.05, z0 + 0.02, STEEL); this.box(x, cy + fy, 0.02, 0.18, 0.12, 0.04, STEEL); }
    return this;
  }
  /** Hanging chochin, (x, y) = bottom of the lantern. */
  chochin(x: number, y: number, z: number, size: number, text: string, bg: string = PALETTE.lanternRed, ink = '#1b1210', ry = 0, glow = 1.35): this {
    const rect = this.atlas.region(`ch|${text}|${bg}|${ink}`, 96, 96, paintChochin(text, bg, ink));
    const hh = size * 1.3;
    this.add(LATHE.clone(), { rect, glow, at: [x, y + size * 0.08, z], rot: [0, ry, 0], scale: [size, hh, size] });
    for (const yy of [y + size * 0.04, y + hh + size * 0.12]) this.add(new THREE.CylinderGeometry(size * 0.33, size * 0.33, size * 0.09, 10), { color: '#1c1714', at: [x, yy, z] });
    return this;
  }
  /** Catenary string of chochin between two world points (current frame ignored). */
  lanternString(a: THREE.Vector3, b: THREE.Vector3, o: { n: number; sag: number; size?: number; colors?: string[]; texts?: string[] }): this {
    const k = 1.6, ck = Math.cosh(k);
    const at = (t: number) => { const p = a.clone().lerp(b, t); p.y -= o.sag * (ck - Math.cosh(k * (2 * t - 1))) / (ck - 1); return p; };
    const pts = Array.from({ length: 17 }, (_, i) => at(i / 16));
    this.stack.push(this.m.clone()); this.m.identity();
    this.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.009, 4, false), { color: '#24201c' });
    const dir = b.clone().sub(a); const ry = Math.atan2(dir.x, dir.z) + Math.PI / 2;
    const cols = o.colors ?? [PALETTE.lanternRed, '#f3e7cf'];
    const size = o.size ?? 0.34;
    for (let i = 0; i < o.n; i++) {
      const p = at((i + 0.5) / o.n);
      const col = cols[i % cols.length];
      const txt = o.texts ? o.texts[i % o.texts.length] : '';
      const drop = size * 1.6 + 0.07;
      this.add(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 3), { color: '#24201c', at: [p.x, p.y - 0.04, p.z] });
      this.chochin(p.x, p.y - drop, p.z, size, txt, col, col === PALETTE.lanternRed ? '#1b1210' : PALETTE.vermilion, ry, col === PALETTE.lanternRed ? 1.35 : 1.0);
    }
    this.m = this.stack.pop()!;
    return this;
  }
  /** Nobori flag on a pole: pole at (x, z), cloth hangs toward local +x of its own yaw, flutters. */
  nobori(x: number, z: number, ry: number, text: string, bg: string, fg = '#ffffff'): this {
    const w = 0.48, h = 1.75, y0 = 0.55;
    const rect = this.atlas.region(`nb|${text}|${bg}|${fg}`, 72, 260, paintBanner(text, bg, fg));
    this.push(x, 0, z, ry);
    this.add(new THREE.CylinderGeometry(0.018, 0.022, y0 + h + 0.15, 6), { color: '#d9d6cf', at: [0, (y0 + h + 0.15) / 2, 0] });
    this.add(new THREE.CylinderGeometry(0.1, 0.12, 0.08, 10), { color: '#4a4a4a', at: [0, 0.04, 0] });
    this.add(new THREE.CylinderGeometry(0.01, 0.01, w + 0.04, 4), { color: '#d9d6cf', at: [w / 2, y0 + h + 0.01, 0], rot: [0, 0, Math.PI / 2] });
    const flut = (s: number) => (u: number, v: number) => s * u * (0.35 + 0.65 * (1 - v));
    this.add(new THREE.PlaneGeometry(w, h, 3, 8), { rect, glow: 0.12, flutter: flut(1), at: [w / 2 + 0.02, y0 + h / 2, 0] });
    const back = new THREE.PlaneGeometry(w, h, 3, 8).rotateY(Math.PI);
    this.add(back, { rect, glow: 0.12, flipU: true, flutter: flut(-1), at: [w / 2 + 0.02, y0 + h / 2, 0] });
    this.pop();
    return this;
  }
  /** Chalk A-board facing +z of its yaw; (x, z) = footprint centre. */
  aFrame(x: number, z: number, ry: number, title: string, items: string[], seed: number): this {
    const w = 0.56, h = 0.82, tilt = 0.2, legH = 0.98;
    const rect = this.atlas.region(`af|${title}|${items.join('/')}`, 140, 205, paintChalk(title, items, seed));
    this.push(x, 0, z, ry);
    for (const s of [1, -1]) {
      const rx = -s * tilt, zc = s * Math.sin(tilt) * legH / 2;
      this.add(bevelBox(w + 0.08, legH, 0.035).clone(), { color: PALETTE.timber, at: [0, legH / 2 * Math.cos(tilt), zc], rot: [rx, 0, 0] });
      const back = s < 0;
      this.add(new THREE.PlaneGeometry(w, h).rotateY(back ? Math.PI : 0), { rect, glow: 0.05, at: [0, legH / 2 * Math.cos(tilt) + 0.04, zc + s * 0.019 * Math.cos(tilt)], rot: [rx, 0, 0] });
    }
    this.add(bevelBox(w + 0.1, 0.05, 0.05).clone(), { color: PALETTE.timberDark, at: [0, legH * Math.cos(tilt), 0] });
    this.pop();
    return this;
  }
  /** Floor-standing lightbox (oki-kanban) with vertical text on both faces; optional LED ticker on top. */
  standSign(x: number, z: number, ry: number, text: string, o: { bg: string; fg: string; font?: string; tick?: number }): this {
    const w = 0.46, h = 1.15, d = 0.26, y0 = 0.12;
    const rect = this.atlas.region(`ss|${text}|${o.bg}|${o.fg}|${o.font}`, 60, 150, paintBoard({ text, bg: o.bg, fg: o.fg, font: o.font, vertical: true }));
    this.push(x, 0, z, ry);
    this.box(0, y0 / 2, 0, w + 0.08, y0, d + 0.08, '#2b2b30');
    this.box(0, y0 + h / 2, 0, w, h, d, shade(o.bg, 0.7));
    this.face(0, y0 + h / 2, d / 2 + 0.004, w - 0.06, h - 0.06, rect, 0.95);
    this.face(0, y0 + h / 2, -d / 2 - 0.004, w - 0.06, h - 0.06, rect, 0.95, Math.PI);
    if (o.tick !== undefined) this.ticker(0, y0 + h + 0.1, 0, w + 0.04, 0.14, o.tick, true);
    this.pop();
    return this;
  }
  /** Vending machine with a painted, lit front. (x, z) = footprint centre, faces +z of its yaw. */
  vending(x: number, z: number, ry: number, brand: string, body: string, seed: number): this {
    const w = 0.98, h = 1.84, d = 0.74;
    const rect = this.atlas.region(`vm|${brand}|${body}|${seed % 4}`, 150, 280, paintVending(brand, body, seed % 4));
    this.push(x, 0, z, ry);
    this.box(0, h / 2, 0, w, h, d, body);
    this.face(0, h / 2 + 0.02, d / 2 + 0.006, w - 0.08, h - 0.12, rect, 0.9);
    this.box(0, 0.04, d / 2 - 0.1, w - 0.04, 0.08, 0.2, '#2a2b30');
    this.pop();
    return this;
  }
  /** Dot-matrix LED ticker in a slim housing (centre at x,y). Row = message index. */
  ticker(x: number, y: number, z: number, w: number, h: number, row: number, twoSided = false): this {
    this.box(x, y, z, w + 0.06, h + 0.06, 0.08, '#1a1a1e');
    const r = ((row % TICKS.length) + TICKS.length) % TICKS.length;
    const v0 = 1 - ((r + 1) * TROW_H - DOT * 0.5) / 512, v1 = 1 - (r * TROW_H + DOT * 0.5) / 512;
    const uw = (w / h) * ((TROW_H - DOT) / TW);
    for (const s of twoSided ? [1, -1] : [1]) {
      const g = new THREE.PlaneGeometry(w, h).rotateY(s < 0 ? Math.PI : 0);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const u0 = (r * 0.137) % 1;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * uw, v0 + uv.getY(i) * (v1 - v0));
      this.add(g, { ticker: true, glow: 2.0, scroll: 0.07, at: [x, y, z + s * 0.045] });
    }
    return this;
  }
  /** Tenant directory: a slim stack of lit panels, one name per floor. (x, y) = bottom centre. */
  tenantBoard(x: number, y: number, z: number, w: number, names: string[], o: { bgs: string[]; fgs: string[]; font?: string; panelH?: number }): this {
    const ph = o.panelH ?? 0.42, h = names.length * ph;
    const rect = this.atlas.region(`tb|${names.join('/')}|${o.bgs.join()}|${o.font}`, w * 100, h * 100, paintTenants(names, o.bgs, o.fgs, o.font ?? GOTHIC));
    const cy = y + h / 2;
    this.box(x, cy, z + 0.09, w + 0.06, h + 0.08, 0.14, '#2b2c30');
    this.face(x, cy, z + 0.164, w, h, rect, 0.8);
    this.box(x, y + h + 0.05, z + 0.11, w + 0.12, 0.05, 0.2, '#2b2c30');
    return this;
  }
  /** Pair of street-lamp banners (both sides of a pole at local x=0), planes facing +-x... (seen along the street). */
  lampBanner(x: number, z: number, ry: number, y0: number, text: string, bg: string, fg: string): this {
    const w = 0.5, h = 1.5;
    const rect = this.atlas.region(`lb|${text}|${bg}|${fg}`, 72, 216, paintBanner(text, bg, fg));
    this.push(x, 0, z, ry);
    for (const s of [1, -1]) {
      const cz = s * (w / 2 + 0.08);
      for (const yy of [y0, y0 + h]) this.add(new THREE.CylinderGeometry(0.012, 0.012, w + 0.1, 4), { color: '#3a3d44', at: [0, yy, cz], rot: [Math.PI / 2, 0, 0] });
      const flut = (u: number, v: number) => 0.4 * Math.sin(v * Math.PI) * (s > 0 ? u : 1 - u);
      this.add(new THREE.PlaneGeometry(w, h, 3, 6).rotateY(Math.PI / 2), { rect, glow: 0.4, flutter: flut, at: [0.004, y0 + h / 2, cz] });
      this.add(new THREE.PlaneGeometry(w, h, 3, 6).rotateY(-Math.PI / 2), { rect, glow: 0.4, flutter: (u, v) => -flut(1 - u, v), at: [-0.004, y0 + h / 2, cz] });
    }
    this.pop();
    return this;
  }

  /** One mesh per cell for everything, plus one for the tickers. */
  build(): THREE.Group {
    const { sign, tick } = shared();
    const out = new THREE.Group();
    out.name = 'signage';
    const tickTime = () => { uTime.value = performance.now() / 1000; };
    for (const parts of this.cells.values()) {
      const g = mergeGeometries(parts);
      for (const p of parts) p.dispose();
      if (!g) continue;
      const mesh = new THREE.Mesh(g, sign);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.onBeforeRender = tickTime;
      out.add(mesh);
    }
    if (this.ticks.length) {
      const g = mergeGeometries(this.ticks);
      for (const p of this.ticks) p.dispose();
      if (g) { const mesh = new THREE.Mesh(g, tick); mesh.onBeforeRender = tickTime; out.add(mesh); }
    }
    this.cells.clear(); this.ticks = [];
    return out;
  }
}

// ================================================================ invented shop names (no real brands)
const N = {
  izakaya: ['居酒屋 とり吉', '酒処 ほたる', '炉端 かがり', '大衆酒場 ゆうげ', '呑み処 つばめ', '居酒屋 千鳥足', '立呑み 角松'],
  ramen: ['麺屋 こはく', 'らぁめん 灯花', '中華そば 汐見', '麺処 くろ兵衛', '担々麺 朱雀', '煮干そば 凪浜'],
  karaoke: ['カラオケ うたげ', 'カラオケ ルナ', 'カラオケ 星屑', '歌声 ひびき'],
  pharmacy: ['みどり堂薬局', 'ひかり薬局', 'ドラッグ さくら丸'],
  books: ['古書 しおり堂', '本と珈琲 ふみ', '文林堂書店', '漫画 月光堂'],
  kissa: ['喫茶 つむぎ', '珈琲 灯台', '純喫茶 ミモザ', '珈琲館 かもめ'],
  grill: ['焼肉 ほむら', '炭火焼 はる', '焼鳥 炭はる', '餃子 福々', 'ホルモン 丸八', 'もつ焼 ごん太'],
  night: ['BAR 月影', 'スナック 小夜', 'BAR Lantana', 'Bar Komorebi', '酒場 夜半', 'ダーツ 蜂鳥', '雀荘 あがり', 'ゲーム 蒼天', 'ネットカフェ 夜鷹'],
  upper: ['整体 ほぐし庵', '英会話 ブリッジ', '質 まるいち', '鍼灸 たんぽぽ', 'ネイル Lumi', '学習塾 一歩', '歯科 しらかば'],
  asakusa: ['天ぷら 衣笠', '手打そば 松葉', '人形焼 とよ田', '雷おこし 三好', '甘味処 ゆず', '和菓子 花かご', '扇子 風雅堂', '手ぬぐい 藍染屋', 'もんじゃ 千代', 'うなぎ 川瀬', '団子 まるや', '佃煮 汐屋', '提灯 灯屋'],
  ginza: ['鮨 さわ乃', '時計 桐生堂', '画廊 さざなみ', '和紙 白鷺', '香 みやび', '割烹 葵', '天ぷら 銀杏', '洋菓子 ルミエール'],
  ginzaBars: ['クラブ 綾', 'Bar 琥珀', 'ラウンジ 雅', 'Bar Nocturne', 'ワイン 樽', '倶楽部 椿', '割烹 葵', 'Salon Kiriu'],
};
const NOBORI_ASA = ['だんご', '天ぷら', '抹茶', '人形焼', '甘味処', '営業中', 'かき氷', 'もんじゃ', 'あげまん', '手焼せんべい'];
const NOBORI_CITY = ['ラーメン', '生ビール', '営業中', '餃子', '飲み放題', 'ランチ', 'からあげ'];
const CLOTH = ['#2c3e6b', PALETTE.vermilion, '#2f5d4a', '#c9962c', '#f3eee2', '#6b2f3a'];
const NEON = [PALETTE.neonPink, PALETTE.neonCyan, PALETTE.neonAmber, '#9dff6a', '#b77bff', '#ff4a3d', '#fff1d6'];
const BOARD_CITY: [string, string][] = [['#f4f1ea', '#b82d25'], ['#b82d25', '#fff4e0'], ['#1d2a44', '#ffe3a3'], ['#f2c230', '#1b1b1f'], ['#ffffff', '#1d4e89'], ['#2f5d4a', '#fff4e0'], ['#141418', '#f4f1ea'], ['#e9e2d0', '#2b2b30']];
const MENUS: [string, string[]][] = [
  ['本日のおすすめ', ['焼魚定食 ¥880', '親子丼 ¥780', '生ビール ¥500']],
  ['LUNCH', ['日替わり定食 ¥850', '唐揚げ定食 ¥900', '大盛り無料']],
  ['珈琲と甘いもの', ['ブレンド ¥480', 'ナポリタン ¥850', '固めプリン ¥420']],
  ['お品書き', ['もり蕎麦 ¥750', '天ざる ¥1,380', '鴨南蛮 ¥1,500']],
  ['今夜の一品', ['刺身盛合せ ¥1,280', '牛すじ煮込み ¥580', 'ハイボール ¥400']],
  ['甘味処', ['抹茶ぜんざい ¥680', 'あんみつ ¥620', '焼き団子 ¥150']],
];
const VEND: [string, string][] = [['AOZORA', '#2f6fd1'], ['Mizutama', '#f2f2ee'], ['HOSHI TEA', '#1f7a4d'], ['KUMO SODA', '#d9362b'], ['Hidamari', '#e9ddc6']];

// ================================================================ street dressing
interface Line { axis: 'x' | 'z'; c: number; n: 1 | -1; a0: number; a1: number }
interface Plan { lines: Line[]; dense: number; mode: 'neon' | 'warm' | 'elegant'; lamps?: [number, number][]; lampY?: number }
function cityLines(F: number): Line[] {
  return [{ axis: 'x', c: -F, n: 1, a0: -62, a1: 62 }, { axis: 'x', c: F, n: -1, a0: -62, a1: 62 }, { axis: 'z', c: -F, n: 1, a0: -62, a1: 62 }, { axis: 'z', c: F, n: -1, a0: -62, a1: 62 }];
}
/** Street lamp positions as laid out by district.crossCity (avenue and cross street). */
function cityLamps(R: number, F: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = -58; x <= 58; x += 13) { if (Math.abs(x) < F + 2) continue; out.push([x, -R - 0.7], [x + 6, R + 0.7]); }
  for (let z = -58; z <= 58; z += 13) { if (Math.abs(z) < F + 2) continue; out.push([-R - 0.7, z], [R + 0.7, z + 6]); }
  return out;
}
const PLANS: Record<DistrictId, Plan> = {
  asakusa: { lines: [{ axis: 'x', c: -7.5, n: 1, a0: -60, a1: 60 }, { axis: 'x', c: 7.5, n: -1, a0: -60, a1: 60 }], dense: 0.9, mode: 'warm' },
  shibuya: { lines: cityLines(11), dense: 1, mode: 'neon', lamps: cityLamps(7, 11), lampY: 2.7 },
  shinjuku: { lines: cityLines(13), dense: 1, mode: 'neon', lamps: cityLamps(8, 13), lampY: 2.7 },
  ginza: { lines: cityLines(11), dense: 0.5, mode: 'elegant' },
};

interface Box3 { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
interface Facade { u0: number; u1: number; h: number }

/** Dress a district's streets with signage. Call once while building the district, before colliders are copied. */
export function dressStreet(group: THREE.Group, id: DistrictId, colliders: Collider[]): void {
  const plan = PLANS[id];
  if (!plan) return;
  const kit = new SignKit();
  kit.atlas.reset();
  const r = seeded(id.length * 7919 + id.charCodeAt(1) * 31);
  const added: Collider[] = [];

  for (const L of plan.lines) {
    // local frame: origin on the facade line, +z = into the street, x along the line
    const ry = L.axis === 'x' ? (L.n > 0 ? 0 : Math.PI) : (L.n > 0 ? Math.PI / 2 : -Math.PI / 2);
    const ox = L.axis === 'x' ? 0 : L.c, oz = L.axis === 'x' ? L.c : 0;
    const frame = new THREE.Matrix4().makeRotationY(ry).setPosition(ox, 0, oz);
    const inv = frame.clone().invert();
    const toLocal = (c: Collider): Box3 => {
      const a = new THREE.Vector3(c.minX, c.minY, c.minZ).applyMatrix4(inv), b = new THREE.Vector3(c.maxX, c.maxY, c.maxZ).applyMatrix4(inv);
      return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: c.minY, y1: c.maxY, z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
    };
    const locals = colliders.map(toLocal);
    const facades: Facade[] = [];
    const obstacles: Box3[] = [];
    for (const b of locals) {
      const isBuilding = b.y0 < 0.2 && b.y1 > 4.5 && Math.abs(b.z1) < 0.8 && b.z1 - b.z0 > 4 && b.x1 - b.x0 > 2.8 && b.x0 > L.a0 - 5 && b.x1 < L.a1 + 5;
      if (isBuilding) facades.push({ u0: b.x0, u1: b.x1, h: b.y1 - 1 });
      else if (b.z1 > -0.5 && b.z0 < 3) obstacles.push(b);
    }
    facades.sort((a, b) => a.u0 - b.u0);
    const free = (bx: Box3, m = 0.15) => !obstacles.some((o) => bx.x0 < o.x1 + m && bx.x1 > o.x0 - m && bx.y0 < o.y1 + m && bx.y1 > o.y0 - m && bx.z0 < o.z1 + m && bx.z1 > o.z0 - m);
    const claim = (bx: Box3) => obstacles.push(bx);
    const tryPlace = (bx: Box3, fn: () => void, m?: number): boolean => { if (!free(bx, m)) return false; claim(bx); fn(); return true; };
    const solid = (x: number, z: number, w: number, d: number, h: number) => {
      const p = new THREE.Vector3(x, 0, z).applyMatrix4(frame);
      const rot = L.axis === 'z';
      added.push({ minX: p.x - (rot ? d : w) / 2, maxX: p.x + (rot ? d : w) / 2, minY: 0, maxY: h, minZ: p.z - (rot ? w : d) / 2, maxZ: p.z + (rot ? w : d) / 2, camera: false });
    };

    kit.push(ox, 0, oz, ry);
    for (const f of facades) {
      const w = f.u1 - f.u0, mid = (f.u0 + f.u1) / 2;
      const side = r() < 0.5 ? -1 : 1, edge = side < 0 ? f.u0 + 0.35 : f.u1 - 0.35, edge2 = side < 0 ? f.u1 - 0.35 : f.u0 + 0.35;
      if (plan.mode === 'neon') dressNeon(kit, r, f, w, mid, edge, edge2, tryPlace, solid, id);
      else if (plan.mode === 'warm') dressWarm(kit, r, f, w, mid, edge, edge2, tryPlace, solid);
      else dressElegant(kit, r, f, w, mid, edge, edge2, tryPlace, solid);
    }
    kit.pop();
  }

  // Asakusa: chochin strings between the classic street lamps (district.asakusa: x -57..57 step 12, z -4.2 / +4.2 offset 6)
  if (id === 'asakusa') {
    const texts = ['祭', '浅', '雲', '灯', '縁'];
    for (const [z, off] of [[-4.2, 0], [4.2, 6]] as const) for (let x = -57; x < 57; x += 12) {
      const a = new THREE.Vector3(x + off + 0.12, 3.3, z), b = new THREE.Vector3(x + off + 11.88, 3.3, z);
      kit.lanternString(a, b, { n: 10, sag: 0.42, size: 0.3, texts: texts.slice((x / 12 + 5) % 3) });
    }
  }
  // neon districts: shotengai banners on the modern street lamps, alternating colours
  if (plan.lamps) {
    const T = id === 'shibuya' ? [['渋谷 夜市', PALETTE.vermilion], ['SHIBUYA', '#1d2a44'], ['坂の街', '#c9962c']] : [['新宿 横丁', '#6b2f3a'], ['SHINJUKU', '#1d2a44'], ['夜の街', '#2f5d4a']];
    plan.lamps.forEach(([x, z], i) => {
      const alongX = Math.abs(z) < Math.abs(x) ? false : true; // lamp on the avenue (|z| small) -> banners face along x
      const [t, bg] = T[i % T.length];
      kit.lampBanner(x, z, alongX ? Math.PI / 2 : 0, plan.lampY!, t, bg, '#fff6e6');
    });
  }

  colliders.push(...added);
  group.add(kit.build());
}

type Try = (bx: Box3, fn: () => void, m?: number) => boolean;
type Solid = (x: number, z: number, w: number, d: number, h: number) => void;

/** Shibuya / Shinjuku: projecting neon and lightbox blades, flush neon boards, tenant stacks, stand signs and tickers. */
function dressNeon(k: SignKit, r: () => number, f: Facade, w: number, mid: number, edge: number, edge2: number, tryPlace: Try, solid: Solid, id: DistrictId): void {
  const tall = f.h > 12;
  // 1. big projecting vertical sign at an edge (neon or lightbox), from above the shop band
  if (r() < 0.85) {
    const y = 4.6 + r() * 0.8, h = Math.floor(Math.min(f.h - y - 0.5, 3 + r() * (tall ? 5 : 2.5)) * 2) / 2, dw = r() < 0.5 ? 0.9 : 1.15;
    const neon = r() < 0.55, [bg, fg] = pick(r, BOARD_CITY);
    const name = pick(r, [...N.karaoke, ...N.night, ...N.grill, ...N.izakaya, ...N.ramen]);
    for (const x of [edge, edge2]) if (h > 2 && tryPlace({ x0: x - 0.2, x1: x + 0.2, y0: y, y1: y + h, z0: 0, z1: 0.35 + dw }, () =>
      k.blade(x, y, 0.35, dw, h, name.replace(/ /g, ''), neon ? { bg, fg, neon: pick(r, NEON), flick: r() < 0.25 ? 0.1 + r() * 0.9 : 0 } : { bg, fg }))) break;
  }
  // 2. flush neon board on an upper floor, sometimes with an LED ticker under it
  if (w < 11 && r() < 0.7) {
    const nw = Math.min(w - 1.4, 2.2 + r() * 2.2), y = 6.6 + Math.floor(r() * 3) * 3, nh = 0.9 + r() * 0.5, x = mid + (r() - 0.5) * (w - nw - 1.4);
    const tick = r() < 0.4;
    if (y + nh < f.h - 0.4) tryPlace({ x0: x - nw / 2, x1: x + nw / 2, y0: y - (tick ? 0.4 : 0), y1: y + nh, z0: 0, z1: 0.45 }, () => {
      k.neonSign(x, y, 0.12, nw, nh, pick(r, [...N.karaoke, ...N.night, 'BAR', 'CLUB', 'ホテル', '麻雀', 'カラオケ', 'ダーツ', '餃子']), { color: pick(r, NEON), flick: r() < 0.2 ? r() : 0 });
      if (tick) k.ticker(x, y - 0.22, 0.32, nw - 0.2, 0.2, Math.floor(r() * 8));
    });
  }
  // 3. Shinjuku tenant stack beside the door
  if (id === 'shinjuku' && r() < 0.45) {
    const n = 4 + Math.floor(r() * 3), names = Array.from({ length: n }, () => pick(r, [...N.night, ...N.upper, ...N.izakaya]));
    const x = edge2 + (edge2 > mid ? -0.1 : 0.1), y = 4.4;
    if (y + n * 0.42 < f.h) tryPlace({ x0: x - 0.4, x1: x + 0.4, y0: y, y1: y + n * 0.42 + 0.1, z0: 0, z1: 0.35 }, () =>
      k.tenantBoard(x, y, 0.1, 0.72, names, { bgs: ['#f4f1ea', '#fff7e0', '#1d2a44', '#f4f1ea', '#b82d25'], fgs: ['#2b2b30', '#b82d25', '#ffe3a3', '#1d4e89', '#fff4e0'] }));
  }
  // 4. street level: stand sign (often with a ticker), A-board, nobori, vending
  const sx = edge + (edge < mid ? 0.45 : -0.45);
  const roll = r();
  if (roll < 0.42) {
    const [bg, fg] = pick(r, BOARD_CITY);
    tryPlace({ x0: sx - 0.35, x1: sx + 0.35, y0: 0, y1: 1.5, z0: 0.4, z1: 1.05 }, () => { k.standSign(sx, 0.75, (r() - 0.5) * 0.5, pick(r, [...N.ramen, ...N.izakaya, ...N.grill, ...N.karaoke]).split(' ').pop()!, { bg, fg, tick: r() < 0.35 ? Math.floor(r() * 8) : undefined }); solid(sx, 0.75, 0.5, 0.4, 1.3); }, 0.05);
  } else if (roll < 0.58) {
    const [t, items] = pick(r, MENUS);
    tryPlace({ x0: sx - 0.4, x1: sx + 0.4, y0: 0, y1: 1.1, z0: 0.35, z1: 1.1 }, () => k.aFrame(sx, 0.75, (r() - 0.5) * 0.4, t, items, Math.floor(r() * 1e6)), 0.05);
  } else if (roll < 0.7) {
    tryPlace({ x0: sx - 0.35, x1: sx + 0.35, y0: 0, y1: 2.5, z0: 0.5, z1: 1.0 }, () => k.nobori(sx, 0.75, -Math.PI / 2 + (r() - 0.5) * 0.3, pick(r, NOBORI_CITY), pick(r, CLOTH), '#ffffff'), 0.05);
  } else if (roll < 0.8) {
    const [brand, body] = pick(r, VEND);
    tryPlace({ x0: sx - 0.55, x1: sx + 0.55, y0: 0, y1: 1.9, z0: 0, z1: 0.85 }, () => { k.vending(sx, 0.42, 0, brand, body, Math.floor(r() * 1e6)); solid(sx, 0.42, 1.0, 0.76, 1.9); }, 0.05);
  }
}

/** Asakusa: wooden kanban, chochin at the eaves, nobori pairs, chalk boards, paper-lantern stand signs. */
function dressWarm(k: SignKit, r: () => number, f: Facade, w: number, mid: number, edge: number, edge2: number, tryPlace: Try, solid: Solid): void {
  const name = pick(r, N.asakusa);
  // 1. vertical wooden kanban on the upper floor, beside the windows
  if (r() < 0.6 && f.h > 5.4) {
    const h = Math.min(2.2, f.h - 4.0), x = edge + (edge < mid ? 0.15 : -0.15);
    const lacquer = r() < 0.5;
    tryPlace({ x0: x - 0.35, x1: x + 0.35, y0: 3.7, y1: 3.7 + h, z0: 0, z1: 0.35 }, () =>
      k.verticalBoard(x, 3.7, 0.12, 0.62, h, name.split(' ').pop()!, lacquer
        ? { bg: '#2a1d17', fg: '#e6c27a', frame: PALETTE.timberDark, font: MINCHO, glow: 0.35 }
        : { bg: '#efe4cc', fg: '#2a1d17', frame: PALETTE.timberDark, font: MINCHO, glow: 0.6, sub: name.split(' ')[0] }));
  }
  // 2. projecting wooden blade at the eave line
  if (r() < 0.45) {
    const x = edge2, y = 3.55;
    tryPlace({ x0: x - 0.15, x1: x + 0.15, y0: y, y1: y + 1.3, z0: 0, z1: 1.2 }, () =>
      k.blade(x, y, 0.3, 0.72, 1.25, name.split(' ').pop()!, { bg: r() < 0.5 ? '#f3ead6' : '#2a1d17', fg: r() < 0.5 ? '#9b231c' : '#2a1d17', font: MINCHO, frame: PALETTE.timberDark, glow: 0.5 }));
  }
  // 3. a big chochin either side of the shop under the eaves
  if (r() < 0.55) for (const x of [f.u0 + 0.7, f.u1 - 0.7]) {
    const txt = pick(r, ['御食事', name.split(' ').pop()!.slice(0, 2), '酒', '御休処', '天']);
    tryPlace({ x0: x - 0.3, x1: x + 0.3, y0: 2.0, y1: 3.0, z0: 0.3, z1: 0.95 }, () => {
      k.cyl(x, 2.95, 0.6, 0.01, 0.12, '#24201c');
      k.chochin(x, 2.1, 0.6, 0.42, txt, r() < 0.7 ? PALETTE.lanternRed : '#f3e7cf', r() < 0.7 ? '#1b1210' : PALETTE.vermilion);
    }, 0.02);
  }
  // 4. street level
  const sx = edge + (edge < mid ? 0.4 : -0.4), roll = r();
  if (roll < 0.4) {
    const t = pick(r, NOBORI_ASA), bg = pick(r, CLOTH), fg = bg === '#f3eee2' ? PALETTE.vermilion : '#ffffff';
    for (const dx of [0, edge < mid ? 0.62 : -0.62]) tryPlace({ x0: sx + dx - 0.3, x1: sx + dx + 0.3, y0: 0, y1: 2.5, z0: 0.5, z1: 1.0 }, () => k.nobori(sx + dx, 0.75, -Math.PI / 2 + (r() - 0.5) * 0.3, t, bg, fg), 0.02);
  } else if (roll < 0.6) {
    const [t, items] = pick(r, MENUS.slice(3));
    tryPlace({ x0: sx - 0.4, x1: sx + 0.4, y0: 0, y1: 1.1, z0: 0.35, z1: 1.1 }, () => k.aFrame(sx, 0.75, (r() - 0.5) * 0.4, t, items, Math.floor(r() * 1e6)), 0.05);
  } else if (roll < 0.78) {
    tryPlace({ x0: sx - 0.35, x1: sx + 0.35, y0: 0, y1: 1.5, z0: 0.4, z1: 1.05 }, () => { k.standSign(sx, 0.75, (r() - 0.5) * 0.4, name.split(' ').pop()!, { bg: '#f3ead6', fg: '#2a1d17', font: MINCHO }); solid(sx, 0.75, 0.5, 0.4, 1.3); }, 0.05);
  }
}

/** Ginza: a few slim brass plaques, ivory tenant directories in mincho, an occasional chalk board. Never neon. */
function dressElegant(k: SignKit, r: () => number, f: Facade, w: number, mid: number, edge: number, edge2: number, tryPlace: Try, solid: Solid): void {
  if (r() < 0.65) {
    const x = edge, y = 4.8 + r() * 1.5;
    tryPlace({ x0: x - 0.15, x1: x + 0.15, y0: y, y1: y + 1.5, z0: 0, z1: 1.0 }, () =>
      k.blade(x, y, 0.3, 0.6, 1.4, pick(r, N.ginza).split(' ').pop()!, { bg: r() < 0.5 ? '#f6f1e6' : '#1f2a24', fg: r() < 0.5 ? '#1f2a24' : '#d8b24a', font: MINCHO, frame: BRASS, glow: 0.55 }));
  }
  if (r() < 0.35) {
    const n = 4 + Math.floor(r() * 3), names = Array.from({ length: n }, () => pick(r, N.ginzaBars));
    const x = edge2 + (edge2 > mid ? -0.1 : 0.1), y = 1.0;
    tryPlace({ x0: x - 0.36, x1: x + 0.36, y0: y, y1: y + n * 0.32 + 0.1, z0: 0, z1: 0.35 }, () =>
      k.tenantBoard(x, y, 0.08, 0.6, names, { bgs: ['#f7f2e7'], fgs: ['#2b2620', '#7d1d3f'], font: MINCHO, panelH: 0.32 }), 0.02);
  }
  if (r() < 0.18) {
    const sx = edge + (edge < mid ? 0.5 : -0.5);
    tryPlace({ x0: sx - 0.4, x1: sx + 0.4, y0: 0, y1: 1.1, z0: 0.35, z1: 1.1 }, () => k.aFrame(sx, 0.75, (r() - 0.5) * 0.3, pick(r, ['本日のコース', 'Today']), pick(r, [['季節の前菜', '甘鯛の松笠焼', 'Wine pairing ¥6,800'], ['Café crème ¥900', 'Tarte aux figues', 'Mille-feuille ¥1,100']]), Math.floor(r() * 1e6)), 0.05);
  }
}
