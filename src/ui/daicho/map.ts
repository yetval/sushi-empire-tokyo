// Daichō map pane — washi ward map. Empire altitude: areas of one region as stamps with restaurant pin clusters.
// City altitude (store.area set): a street-grid lot plan of one area. SVG is built once per view key and patched per tick.
import { AREAS, AreaDef, CONCEPTS, CONCEPT_IDS, PROPERTIES, Region } from '../../core/data';
import { RestKPI } from '../../core/empire';
import { short, yen } from '../../core/format';
import * as A from '../../core/actions';
import { esc, run } from '../dom';
import { icon } from '../icons';
import { coinBurst, punch } from '../fx';
import { BAND_MARK, Band, CONCEPT_SHAPE, Ctx, Overlay, Part, Snap, conceptGlyph, health, overlayBand, shapePath } from './shared';
import './map.css';

const W = 100, H = 62; // viewBox
const CAP = 8; // max pins per area cluster at Empire altitude (rest go behind a "+k" badge)
const REGIONS: [Region, string, string][] = [['tokyo', '東京', 'Tokyo'], ['japan', '日本', 'Japan'], ['world', '世界', 'World']];
const OVERLAYS: [Overlay, string, string][] = [['profit', 'Profit', 'Profit'], ['load', 'Load', 'Kitchen load'], ['stars', `${icon('star', 14)} Stars`, 'Rating'], ['staff', 'Staff', 'Staff']];
const SIZE = [1.25, 1.55, 1.85]; // pin radius per revenue band (Empire altitude)
const RING = 4.8; // cluster ring radius around an area stamp
const RING_W = 2 * (RING + SIZE[2]) + 1.5; // footprint width of a full pin ring

/** Region backdrops drawn in a 100-wide frame. `shapes` are stretched horizontally to the fitted viewBox width;
 *  `geo(sx, ls)` places the sea/river names at stretched x with unstretched, screen-scaled text. */
const backdrop: Record<Region, { shapes: string; geo: (sx: number, ls: number) => string }> = {
  tokyo: {
    shapes: `<path class="sea" d="M48,62 C54,58 60,57 65,58 C71,59 75,55 81,54 C87,53 93,49 100,46 V62 Z"/>
    <path class="river" d="M71,0 C68,10 73,18 69,27 C66,35 71,42 66,50 C64,54 66,57 63,60"/>
    <ellipse class="rail" cx="47" cy="24" rx="16" ry="11"/>
    <rect class="park" x="44" y="26" width="8" height="5" rx="1.6"/>`,
    geo: (sx, ls) => `<text class="geo" x="${99 * sx}" y="51.9" style="text-anchor:end">東京湾<tspan class="en" x="${99 * sx}" dy="${(2.1 * ls).toFixed(2)}">Tokyo Bay</tspan></text>
    <text class="geo" x="${73 * sx}" y="8" transform="rotate(-78 ${73 * sx} 8)">隅田川</text>`,
  },
  japan: {
    shapes: `<path class="land" d="M62,8 C66,3 74,3 78,6 C82,9 80,14 76,16 C72,19 66,18 63,15 C60,13 60,10 62,8 Z"/>
    <path class="land" d="M30,44 C36,40 42,40 48,38 C54,36 58,33 62,28 C65,24 68,21 72,20 C75,20 76,23 74,26 C72,30 70,34 66,38 C62,42 56,44 50,46 C44,48 36,49 31,48 C29,47 29,45 30,44 Z"/>
    <path class="land" d="M40,49 C44,48 50,48 52,50 C52,52 46,53 42,52 C40,52 39,50 40,49 Z"/>
    <path class="land" d="M22,48 C26,47 29,49 29,53 C29,57 26,60 23,59 C20,58 19,54 20,51 C20,49 21,48 22,48 Z"/>`,
    geo: (sx) => `<text class="geo" x="${22 * sx}" y="20">日本海 Sea of Japan</text><text class="geo" x="${84 * sx}" y="50">太平洋 Pacific</text>`,
  },
  world: {
    shapes: `<path class="land" d="M6,10 C14,6 26,8 30,14 C32,20 28,26 24,30 C20,34 16,36 14,40 C10,36 6,30 5,22 C4,16 4,12 6,10 Z"/>
    <path class="land" d="M22,40 C26,40 30,44 29,50 C28,56 24,60 22,61 C20,56 19,50 19,45 C19,42 20,40 22,40 Z"/>
    <path class="land" d="M42,14 C46,10 54,10 56,14 C57,18 54,22 52,26 C49,28 45,27 43,24 C41,21 40,17 42,14 Z"/>
    <path class="land" d="M44,30 C50,28 56,30 58,35 C60,40 56,48 52,54 C49,56 47,52 46,46 C44,40 42,34 44,30 Z"/>
    <path class="land" d="M57,12 C64,8 80,8 90,12 C94,16 92,22 86,26 C82,30 78,32 74,34 C70,36 64,34 60,30 C57,26 55,18 57,12 Z"/>
    <path class="land" d="M78,46 C84,44 90,46 91,50 C91,54 86,56 82,55 C78,54 76,50 78,46 Z"/>
    <path class="land" d="M88,20 c1.4,-1 2.4,.4 1.6,2.4 c-.6,1.8 -2.2,2.8 -2.8,1.8 Z"/>`,
    geo: (sx) => `<text class="geo" x="${34 * sx}" y="44">大西洋 Atlantic</text><text class="geo" x="${92.5 * sx}" y="40">太平洋 Pacific</text>`,
  },
};

/** Label type metrics in viewBox units for label scale `ls` (ls keeps the 1.85-unit sum line at >= 12 CSS px).
 *  top = how far the stamp/ring reaches below the area centre; returns the two baselines and the block's bottom. */
const NAME = 2.1, SUM = 1.85, MIN_PX = 12;
const lines = (top: number, ls: number) => {
  const nm = top + 0.5 + 0.8 * NAME * ls, sm = nm + 0.25 * NAME * ls + 0.85 * SUM * ls;
  return { nm, sm, bottom: sm + 0.3 * SUM * ls };
};
const RING_TOP = RING + SIZE[2];

/** Rendered text width in viewBox units (canvas measure with the body font; falls back to a char estimate). */
let meas: CanvasRenderingContext2D | null | undefined;
function textW(s: string, size: number): number {
  if (meas === undefined) meas = document.createElement('canvas').getContext('2d');
  if (!meas) return s.length * size * 0.62;
  meas.font = `700 100px ${getComputedStyle(document.documentElement).getPropertyValue('--body') || 'sans-serif'}`;
  return (meas.measureText(s).width / 100) * size;
}
/** Width of an area's label block: the name line (jp tspan + short name) or the sum line, whichever is wider. */
const labelW = (a: AreaDef, ls: number) => {
  const jp = a.jp.length > 3 ? '' : a.jp;
  return Math.max(textW(jp, 1.9 * ls) + textW(` ${shortName(a)}`, NAME * ls), textW('-¥888.8K/day', SUM * ls));
};

/** Region-space (0..100) → viewBox (stretched to width vw), packed into rows so footprints never overlap
 *  (deterministic, memoised per region + fit). A footprint is the stamp + pin ring + label block; its width is the
 *  wider of the ring and that area's label, so long names (Shimokitazawa) claim more room instead of running into a
 *  neighbour. Each area joins the row nearest its geographic y; a row that is too wide spills its farthest member
 *  into the next row; inside a row areas keep their x order and are pushed apart in 1D.
 *  If the two-line labels can't fit (small pane), the layout goes `tight`: the sum line is dropped (it is in the
 *  ledger's city headers too) so the names stay at full, readable size. */
interface Fit { pos: Map<string, { x: number; y: number }>; tight: boolean }
const layoutMemo = new Map<string, Fit>();
function layout(region: Region, vw: number, ls: number): Fit {
  const mk = `${region}|${vw}|${ls}`;
  const hit = layoutMemo.get(mk);
  if (hit) return hit;
  const ids = Object.values(AREAS).filter((a) => a.region === region).map((a) => a.id);
  const sx = vw / W, n = ids.length;
  const w = ids.map((id) => Math.max(RING_W, labelW(AREAS[id], ls) + 1.2 + 1.4 * ls)); // + a word-space of air
  const geo = ids.map((id) => ({ x: (4 + AREAS[id].map.x * 0.92) * sx, y: 5 + AREAS[id].map.y * 0.6 }));
  const y0 = RING_TOP + 1.5, total = w.reduce((t, v) => t + v, 0);
  const plan = (tight: boolean) => {
    const L = lines(RING_TOP, ls), bottom = tight ? L.nm + 0.3 * NAME * ls : L.bottom;
    const BH = RING_TOP + bottom + 0.8, y1 = H - bottom - 1.5;
    const rows = Math.max(1, Math.min(n, Math.floor((y1 - y0) / BH) + 1));
    return { rows, y1, BH, ok: total <= rows * vw * 0.92 };
  };
  let tight = false, P = plan(false);
  if (!P.ok) { tight = true; P = plan(true); }
  const { rows, y1, BH } = P;
  const rowY = (r: number) => (rows === 1 ? Math.min(y1, Math.max(y0, (y0 + y1) / 2)) : y0 + ((y1 - y0) * r) / (rows - 1));
  const slack = rows === 1 ? 0 : Math.max(0, ((y1 - y0) / (rows - 1) - BH) / 2); // spare row height keeps some geographic y
  // nearest row by geography, then spill over-wide rows (farthest-from-row member first) to the neighbour with room
  const row = geo.map((g) => { let best = 0; for (let r = 1; r < rows; r++) if (Math.abs(g.y - rowY(r)) < Math.abs(g.y - rowY(best))) best = r; return best; });
  const width = (r: number) => row.reduce((t, rr, i) => t + (rr === r ? w[i] : 0), 0);
  for (let guard = 0; guard < n * rows; guard++) {
    const r = [...Array(rows).keys()].find((k) => width(k) > vw - 1);
    if (r === undefined) break;
    const members = row.map((rr, i) => (rr === r ? i : -1)).filter((i) => i >= 0);
    const order = [r + 1, r - 1].filter((k) => k >= 0 && k < rows).sort((a, b) => width(a) - width(b));
    if (!order.length) break;
    const to = order[0];
    const mv = members.sort((a, b) => Math.abs(geo[b].y - rowY(to)) - Math.abs(geo[a].y - rowY(to)))[members.length - 1];
    row[mv] = to;
  }
  const p = geo.map((g, i) => ({ x: g.x, y: Math.min(rowY(row[i]) + slack, Math.max(rowY(row[i]) - slack, g.y)) }));
  for (let r = 0; r < rows; r++) {
    const m = row.map((rr, i) => (rr === r ? i : -1)).filter((i) => i >= 0).sort((a, b) => p[a].x - p[b].x);
    for (let k = 0; k < m.length; k++) { // push right, keeping the left edge in frame
      const i = m[k], lo = k ? p[m[k - 1]].x + (w[m[k - 1]] + w[i]) / 2 : w[i] / 2 + 0.5;
      p[i].x = Math.max(lo, p[i].x);
    }
    for (let k = m.length - 1; k >= 0; k--) { // then pull back from the right edge
      const i = m[k], hi = k < m.length - 1 ? p[m[k + 1]].x - (w[m[k + 1]] + w[i]) / 2 : vw - w[i] / 2 - 0.5;
      p[i].x = Math.min(hi, p[i].x);
    }
  }
  for (const q of p) if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) { q.x = vw / 2; q.y = H / 2; }
  const fit: Fit = { pos: new Map(ids.map((id, i) => [id, p[i]])), tight };
  layoutMemo.set(mk, fit);
  return fit;
}

/** Inner washi mark so band never relies on fill colour: ring / triangle / cross. */
function markPath(b: Band, r: number): string {
  const k = r * 0.42;
  if (b === 'good') return `M${-k},0 a${k},${k} 0 1,0 ${2 * k},0 a${k},${k} 0 1,0 ${-2 * k},0 Z`;
  if (b === 'watch') return `M0,${-k} L${k * 0.95},${k * 0.7} L${-k * 0.95},${k * 0.7} Z`;
  return `M${-k},${-k} L${k},${k} M${k},${-k} L${-k},${k}`;
}

const shortName = (a: AreaDef) => { const n = a.name.split(' · ')[0]; return n.length > 13 ? n.split(' ')[0] : n; };
const areaPnl = (ks: RestKPI[]) => ks.reduce((t, k) => t + (k.profitYesterday ?? k.revToday), 0);
const rev = (k: RestKPI) => k.rev7.length ? k.rev7[k.rev7.length - 1] : k.revToday;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const SEV: Record<Band, number> = { act: 0, watch: 1, good: 2 };

interface PinRef { g: SVGGElement; body: SVGPathElement; sh: SVGPathElement; mark: SVGPathElement; ring: SVGCircleElement; label?: SVGTextElement; rid: string | null }

export class MapView implements Part {
  readonly el = document.createElement('div');
  private readonly head: HTMLElement;
  private readonly wrap: HTMLElement;
  private svg!: SVGSVGElement;
  private key = '';
  private vw = W; // viewBox width fitted to the pane's aspect (height stays H)
  private ls = 1; // label scale so map text never renders under MIN_PX
  private pins = new Map<string, PinRef[]>(); // area id (Empire) or 'city' → pin slots
  private sums = new Map<string, SVGTextElement>();
  private badges = new Map<string, SVGGElement>();
  private labels: { x: number; t: SVGTextElement[] }[] = []; // Empire area labels, kept inside the viewBox
  private lots: { g: SVGGElement; price: number }[] = [];
  private pop: HTMLElement | null = null;
  private crumbSum: HTMLElement | null = null;
  private readonly offs: (() => void)[] = [];
  private readonly ro = new ResizeObserver(() => { if (this.svg) this.render(this.ctx.snap()); }); // first visible frame / resize → refit

  constructor(private ctx: Ctx) {
    this.el.className = 'dc-map';
    this.head = document.createElement('div');
    this.head.className = 'dc-map-head';
    this.wrap = document.createElement('div');
    this.wrap.className = 'dc-map-wrap';
    this.el.append(this.head, this.wrap);
    this.ro.observe(this.wrap);
    const { store } = ctx;
    this.offs.push(
      store.on(['region', 'area'], (ch) => {
        const a = store.st.area;
        if (ch.includes('area') && a && AREAS[a] && AREAS[a].region !== store.st.region) store.set({ region: AREAS[a].region });
        this.render(ctx.snap());
      }),
      store.on(['overlay'], () => { this.header(); this.patch(ctx.snap()); }),
      store.on(['hover'], () => this.highlight()),
    );
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    const hov = (e: Event, on: boolean) => {
      const g = (e.target as Element).closest?.<SVGGElement>('[data-rid]');
      if (!g?.dataset.rid) return;
      if (on) store.set({ hover: g.dataset.rid });
      else if (store.st.hover === g.dataset.rid) store.set({ hover: null });
    };
    this.el.addEventListener('pointerover', (e) => hov(e, true));
    this.el.addEventListener('pointerout', (e) => hov(e, false));
    this.el.addEventListener('focusin', (e) => hov(e, true));
    this.el.addEventListener('focusout', (e) => hov(e, false));
  }

  private get s() { return this.ctx.host.s; }

  render(snap: Snap): void {
    const { area, region } = this.ctx.store.st;
    const s = this.s;
    this.fit();
    const key = `${this.vw}|${this.ls}|` + (area
      ? `C|${area}|${s.districts.includes(area)}|${snap.kpis.filter((k) => k.area === area).map((k) => k.id).join()}`
      : `E|${region}|${Object.values(AREAS).filter((a) => a.region === region).map((a) => `${a.id}:${s.districts.includes(a.id) ? snap.kpis.filter((k) => k.area === a.id).length : 'x'}`).join()}`);
    if (key !== this.key) { this.key = key; this.header(); area ? this.buildCity(area, snap) : this.buildEmpire(region, snap); this.highlight(); }
    this.patch(snap);
  }

  /** Fit the viewBox to the pane (no letterbox: wider panes get a wider map, up to 1.5x) and pick the label scale
   *  that keeps the smallest map text at MIN_PX. Quantised so a resize only rebuilds when it matters. */
  private fit(): void {
    const r = this.wrap.getBoundingClientRect();
    if (!(r.width >= 50 && r.height >= 50)) return; // hidden / not laid out yet (or NaN): never fit to a zero box
    const vw = Math.round(Math.min(W * 1.5, Math.max(W, (H * r.width) / r.height)) / 2) * 2;
    const ppu = Math.min(r.width / vw, r.height / H);
    this.vw = vw;
    this.ls = Math.round(Math.min(1.7, Math.max(1, MIN_PX / (SUM * ppu))) * 20) / 20;
  }

  // ---------------------------------------------------------------- header
  private header(): void {
    const { area, region, overlay } = this.ctx.store.st;
    const a = area ? AREAS[area] : null;
    const seal = icon('map', 26, { variant: 'seal' });
    const crumb = a
      ? `${seal}<button class="dc-map-crumb" data-act="up" title="Back to the empire (Esc)">本社 Empire</button><span class="sep" aria-hidden="true">›</span><b>${esc(a.jp)} ${esc(a.name)}</b><span class="dc-map-csum"></span>`
      : `${seal}<b>本社 Empire</b>`;
    const tabs = a ? '' : `<div class="dc-map-tabs tabs" role="tablist" aria-label="Region">${REGIONS.map(([id, jp, en]) =>
      `<button class="tab${id === region ? ' on' : ''}" role="tab" aria-selected="${id === region}" data-act="region" data-arg="${id}"><span class="jp">${jp}</span> ${en}</button>`).join('')}</div>`;
    const seg = `<div class="dc-map-seg tabs" role="group" aria-label="Map overlay">${OVERLAYS.map(([id, txt, lbl]) =>
      `<button class="tab${id === overlay ? ' on' : ''}" aria-pressed="${id === overlay}" data-act="overlay" data-arg="${id}" aria-label="${lbl}" title="${lbl}">${txt}</button>`).join('')}</div>`;
    const legend = `<details class="dc-map-legend"><summary aria-label="Map legend"><b>Key</b><span class="gl">${CONCEPT_IDS.map((c) => conceptGlyph(c, 12)).join('')}</span><span class="marks">${(['good', 'watch', 'act'] as Band[]).map((b) => `<span class="dc-band ${b}">${BAND_MARK[b].glyph}</span>`).join('')}</span></summary>
      <div class="dc-map-legend-p"><h4>Format</h4><div class="cols">${CONCEPT_IDS.map((c) => `<div>${conceptGlyph(c, 16)} ${CONCEPTS[c].name}</div>`).join('')}</div>
      <h4>Overlay band</h4><div class="cols">${(['good', 'watch', 'act'] as Band[]).map((b) => `<div><span class="dc-band ${b}">${BAND_MARK[b].glyph}</span> ${BAND_MARK[b].word}</div>`).join('')}</div>
      <p class="sub">Bigger pin = more revenue · red ring = needs action · dashed = locked or for sale</p></div></details>`;
    const open = this.head.querySelector('details')?.open;
    const f = this.head.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null;
    this.head.innerHTML = `<div class="dc-map-row"><nav class="dc-map-bc" aria-label="Altitude">${crumb}</nav>${tabs}</div><div class="dc-map-row">${seg}${legend}</div>`;
    if (open) this.head.querySelector('details')!.open = true;
    if (f?.act) this.head.querySelector<HTMLElement>(`[data-act="${f.act}"][data-arg="${f.arg ?? ''}"]`)?.focus(); // rebuild keeps keyboard focus
    this.crumbSum = this.head.querySelector('.dc-map-csum');
  }

  // ---------------------------------------------------------------- build (once per view)
  private reset(inner: string, label: string): void {
    this.closePop();
    this.pins.clear(); this.sums.clear(); this.badges.clear(); this.lots = []; this.labels = [];
    this.wrap.innerHTML = `<svg class="dc-map-svg" viewBox="0 0 ${this.vw} ${H}" preserveAspectRatio="xMidYMid meet" style="--ls:${this.ls}" role="group" aria-label="${esc(label)}">
      <defs><filter id="dc-ink" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale=".9"/></filter></defs>
      ${inner}</svg>`;
    this.svg = this.wrap.firstElementChild as unknown as SVGSVGElement;
  }

  private pinSvg(r: number, cls = ''): string {
    return `<g class="dc-pin ${cls}" role="button" tabindex="0"><g class="in"><circle class="ring" r="${r + 0.9}"/><path class="sh"/><path class="body"/><path class="mark"/></g></g>`;
  }

  private ref(g: SVGGElement): PinRef {
    return { g, body: g.querySelector('.body')!, sh: g.querySelector('.sh')!, mark: g.querySelector('.mark')!, ring: g.querySelector('.ring')!, label: g.querySelector<SVGTextElement>('.ol') ?? undefined, rid: null };
  }

  private buildEmpire(region: Region, snap: Snap): void {
    const s = this.s, ls = this.ls, sx = this.vw / W, { pos, tight } = layout(region, this.vw, ls);
    const Lr = lines(RING_TOP, ls), Le = lines(3.4, ls); // label baselines under a pin ring / a bare stamp or lock
    const nodes = [...pos].map(([id, p]) => {
      const a = AREAS[id], n = snap.kpis.filter((k) => k.area === id).length;
      const name = (y: number) => `<text class="nm" y="${y.toFixed(2)}"><tspan class="jp">${esc(a.jp.length > 3 ? '' : a.jp)}</tspan> ${esc(shortName(a))}</text>`;
      if (!s.districts.includes(id)) {
        const ch2 = a.unlock.chapter2 && !s.flags.chapter2;
        const req = ch2 ? 'Chapter 2' : `${short(a.unlock.pieces)} pcs · ${yen(a.unlock.cost)}`; // SVG text: no icon markup, keep it short
        const reqWords = ch2 ? 'Chapter 2' : `${short(a.unlock.pieces)} pieces sold and ${yen(a.unlock.cost)}`;
        return `<g class="dc-area locked" data-x="${p.x.toFixed(2)}" transform="translate(${p.x.toFixed(2)},${p.y.toFixed(2)})" role="button" tabindex="0" data-act="locked" data-arg="${id}"
          aria-label="${esc(a.name)} — locked, needs ${esc(reqWords)}"><circle class="hit" r="5"/><circle class="lk-sh" r="3.4" cy=".5"/><circle class="lk" r="3.4"/><text class="lkc" y=".9">${esc(a.jp[0])}</text>${name(Le.nm)}<text class="sm" y="${Le.sm.toFixed(2)}">${esc(req)}</text></g>`;
      }
      const vis = n > CAP ? CAP - 1 : n, R = RING;
      const slots = Array.from({ length: vis }, (_, i) => {
        const t = -Math.PI / 2 + (i / Math.max(vis, n > CAP ? CAP : 1)) * Math.PI * 2;
        return `<g transform="translate(${(Math.cos(t) * R).toFixed(2)},${(Math.sin(t) * R).toFixed(2)})">${this.pinSvg(SIZE[2])}</g>`;
      }).join('');
      const tb = -Math.PI / 2 + ((CAP - 1) / CAP) * Math.PI * 2;
      const badge = n > CAP ? `<g class="more" transform="translate(${(Math.cos(tb) * R).toFixed(2)},${(Math.sin(tb) * R).toFixed(2)})"><g class="mi"><rect class="sh" x="-2.3" y="-1.45" width="4.6" height="2.9" rx="1.45"/><rect x="-2.3" y="-1.45" width="4.6" height="2.9" rx="1.45"/><text y=".72">+${n - vis}</text></g></g>` : '';
      return `<g class="dc-area${n ? '' : ' empty'}" data-area="${id}" data-x="${p.x.toFixed(2)}" transform="translate(${p.x.toFixed(2)},${p.y.toFixed(2)})">
        <g class="stamp" role="button" tabindex="0" data-act="area" data-arg="${id}" aria-label="${esc(a.name)} — ${n} restaurant${n === 1 ? '' : 's'}, open city"><circle class="hit" r="3.2"/>
          <rect class="sh" x="-2.7" y="-2.7" width="5.4" height="5.4" rx=".9" transform="rotate(-6)"/><rect class="face" x="-2.7" y="-2.7" width="5.4" height="5.4" rx=".9" transform="rotate(-6)"/><text class="cnt" y="1">${n || '+'}</text></g>
        ${slots}${badge}${name((n ? Lr : Le).nm)}<text class="sm sum" y="${(n ? Lr : Le).sm.toFixed(2)}"></text></g>`;
    }).join('');
    this.reset(`<g class="bg"><g filter="url(#dc-ink)" transform="scale(${sx.toFixed(3)},1)">${backdrop[region].shapes}</g>${backdrop[region].geo(sx, ls)}</g>${nodes}`, `${REGIONS.find((r) => r[0] === region)![2]} map — areas and restaurants`);
    this.svg.classList.toggle('tight', tight);
    this.labels = [...this.svg.querySelectorAll<SVGGElement>('.dc-area')].map((g) => ({ x: +g.dataset.x!, t: [...g.querySelectorAll<SVGTextElement>('.nm, .sm')] }));
    for (const g of this.svg.querySelectorAll<SVGGElement>('.dc-area[data-area]')) {
      const id = g.dataset.area!;
      this.pins.set(id, [...g.querySelectorAll<SVGGElement>('.dc-pin')].map((p) => this.ref(p)));
      this.sums.set(id, g.querySelector<SVGTextElement>('.sum')!);
      const b = g.querySelector<SVGGElement>('.more');
      if (b) this.badges.set(id, b);
    }
  }

  private buildCity(area: string, snap: Snap): void {
    const s = this.s, a = AREAS[area];
    const lots = Object.values(PROPERTIES).filter((p) => p.district === area).sort((x, y) => x.price - y.price || x.id.localeCompare(y.id));
    const extra = snap.kpis.filter((k) => k.area === area && !PROPERTIES[k.id]).map((k) => k.id); // defensive: restaurants not on a known lot
    const ids = [...lots.map((p) => p.id), ...extra];
    const n = Math.max(1, ids.length), cols = Math.min(n, Math.ceil(Math.sqrt(n * 1.7))), rows = Math.ceil(n / cols);
    const VW = this.vw, ls = this.ls, cw = (VW - 8) / cols, ch = (H - 6) / rows, unlocked = s.districts.includes(area);
    const streets = [
      ...Array.from({ length: cols + 1 }, (_, i) => `<line class="st" x1="${4 + i * cw}" y1="0" x2="${4 + i * cw}" y2="${H}"/>`),
      ...Array.from({ length: rows + 1 }, (_, i) => `<line class="st" x1="0" y1="${3 + i * ch}" x2="${VW}" y2="${3 + i * ch}"/>`),
    ].join('');
    const maxCh = Math.floor((cw - 2) / (1.05 * ls)); // ~1.05 units per char at the 1.9-2.1 label sizes
    const cells = ids.map((id, i) => {
      const cx = 4 + (i % cols + 0.5) * cw, cy = 3 + (Math.floor(i / cols) + 0.5) * ch;
      const block = `<rect class="blk" x="${(cx - cw / 2 + 1.6).toFixed(2)}" y="${(cy - ch / 2 + 1.6).toFixed(2)}" width="${(cw - 3.2).toFixed(2)}" height="${(ch - 3.2).toFixed(2)}" rx="1"/>`;
      const r = s.restaurants[id];
      if (r) {
        const pr = Math.min(4, ch / 5);
        return `${block}<g transform="translate(${cx.toFixed(2)},${(cy - pr * 0.6).toFixed(2)})">${this.pinSvg(pr, 'big').replace('</g></g>', `</g><text class="nm" y="${(pr + 0.9 + 2.1 * ls).toFixed(2)}">${esc(clip(r.name, maxCh))}</text><text class="ol" y="${(pr + 0.9 + 4.6 * ls).toFixed(2)}"></text></g>`)}</g>`;
      }
      const p = PROPERTIES[id], lw = Math.min(cw - 6, 16 * ls), lh = Math.min(ch - 6 - 3 * ls, 7.6 * ls);
      return `${block}<g class="dc-lot" transform="translate(${cx.toFixed(2)},${(cy - 1.5).toFixed(2)})" role="button" tabindex="0" data-act="${unlocked ? 'buy' : 'locked'}" data-arg="${unlocked ? id : area}"
        aria-label="${esc(p.name)} — for sale, ${yen(p.price)}"><rect class="lot" x="${-lw / 2}" y="${-lh / 2}" width="${lw}" height="${lh}" rx=".6"/>
        <text class="fs" y="${(-0.5 * ls).toFixed(2)}">売 For sale</text><text class="pr" y="${(2.3 * ls).toFixed(2)}">${p.price ? yen(p.price) : 'free'}</text><text class="nm" y="${(lh / 2 + 2.4 * ls).toFixed(2)}">${esc(clip(p.name, maxCh))}</text></g>`;
    }).join('');
    this.reset(`<g class="bg">${streets}</g>${cells}`, `${a.name} lot plan`);
    this.pins.set('city', [...this.svg.querySelectorAll<SVGGElement>('.dc-pin')].map((g, i) => {
      const ref = this.ref(g);
      ref.rid = ids.filter((id) => s.restaurants[id])[i];
      g.dataset.rid = ref.rid;
      return ref;
    }));
    this.lots = [...this.svg.querySelectorAll<SVGGElement>('.dc-lot[data-act="buy"]')].map((g) => ({ g, price: PROPERTIES[g.dataset.arg!].price }));
  }

  // ---------------------------------------------------------------- per-tick patch
  private patch(snap: Snap): void {
    if (!this.svg) return;
    const ov = this.ctx.store.st.overlay, city = !!this.ctx.store.st.area;
    const revs = snap.kpis.map(rev).sort((a, b) => a - b);
    const q1 = revs[Math.floor(revs.length / 3)] ?? 0, q2 = revs[Math.floor((revs.length * 2) / 3)] ?? 0;
    const ovName = OVERLAYS.find((o) => o[0] === ov)![2].toLowerCase();
    const setPin = (p: PinRef, k: RestKPI, r: number) => {
      const o = overlayBand(k, ov), h = health(k);
      if (p.rid !== k.id) { p.rid = k.id; p.g.dataset.rid = k.id; }
      const d = shapePath(CONCEPT_SHAPE[k.concept], r);
      if (p.body.getAttribute('d') !== d) { p.body.setAttribute('d', d); p.sh.setAttribute('d', d); }
      const md = markPath(o.band, r);
      if (p.mark.getAttribute('d') !== md) p.mark.setAttribute('d', md);
      p.ring.setAttribute('r', String(r + 0.9));
      p.g.setAttribute('class', `dc-pin b-${o.band}${h.band === 'act' ? ' is-act' : ''}${city ? ' big' : ''}${this.ctx.store.st.hover === k.id ? ' is-hover' : ''}`);
      p.g.setAttribute('aria-label', `${k.name} — ${CONCEPTS[k.concept].name.toLowerCase()}, ${ovName} ${o.label} (${BAND_MARK[o.band].word}), ${BAND_MARK[h.band].word}: ${h.why.toLowerCase()}`);
      if (p.label) { const t = o.label; if (p.label.textContent !== t) p.label.textContent = t; p.label.setAttribute('class', `ol b-${o.band}`); }
    };
    if (city) {
      for (const p of this.pins.get('city') ?? []) {
        const k = p.rid ? snap.byId.get(p.rid) : undefined;
        if (k) setPin(p, k, parseFloat(p.ring.getAttribute('r') ?? '4.9') - 0.9);
      }
      for (const l of this.lots) l.g.classList.toggle('poor', this.s.cash < l.price);
      const ks = snap.kpis.filter((k) => k.area === this.ctx.store.st.area);
      if (this.crumbSum) this.crumbSum.textContent = ks.length ? `${yen(areaPnl(ks))}/day · ${ks.length} open` : 'no restaurants yet';
      return;
    }
    for (const [id, slots] of this.pins) {
      const ks = snap.kpis.filter((k) => k.area === id).sort((a, b) => SEV[health(a).band] - SEV[health(b).band] || a.id.localeCompare(b.id));
      slots.forEach((p, i) => { const k = ks[i]; if (k) setPin(p, k, SIZE[rev(k) >= q2 ? 2 : rev(k) >= q1 ? 1 : 0]); });
      const hidden = ks.slice(slots.length), badge = this.badges.get(id);
      if (badge) badge.classList.toggle('has-act', hidden.some((k) => health(k).band === 'act'));
      const sum = this.sums.get(id)!;
      const cheapest = Object.values(PROPERTIES).filter((p) => p.district === id && !this.s.restaurants[p.id]).reduce((m, p) => Math.min(m, p.price), Infinity);
      const t = ks.length ? `${yen(areaPnl(ks))}/day` : Number.isFinite(cheapest) ? `lots from ${yen(cheapest)}` : 'no lots';
      if (sum.textContent !== t) sum.textContent = t;
    }
    // Shift each area's labels so they stay inside the viewBox (text width is only known once rendered, so re-check per tick).
    for (const l of this.labels) {
      let lo = Infinity, hi = -Infinity;
      for (const t of l.t) {
        const b = t.getBBox(), cur = +(t.getAttribute('x') ?? 0);
        if (b.width) { lo = Math.min(lo, b.x - cur); hi = Math.max(hi, b.x + b.width - cur); }
      }
      if (lo === Infinity) continue; // not rendered yet (pane hidden)
      const dx = (l.x + lo < 1 ? 1 - (l.x + lo) : l.x + hi > this.vw - 1 ? this.vw - 1 - (l.x + hi) : 0).toFixed(2);
      for (const t of l.t) if (t.getAttribute('x') !== dx) t.setAttribute('x', dx);
    }
    // Decorative sea/river names step aside (hide) wherever an area label lands on them.
    const geo = this.svg.querySelectorAll<SVGTextElement>('.bg .geo');
    if (geo.length) {
      const rs = [...this.labels.flatMap((l) => l.t), ...this.svg.querySelectorAll('.dc-area .stamp, .dc-area .lk, .dc-pin .body')].map((t) => t.getBoundingClientRect()).filter((r) => r.width);
      for (const g of geo) {
        const r = g.getBoundingClientRect();
        const hit = rs.some((q) => q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top);
        g.style.visibility = hit ? 'hidden' : '';
      }
    }
  }

  /** Cross-highlight from store.hover (set by this map or the ledger). Hidden pins light their area stamp instead. */
  private highlight(): void {
    if (!this.svg) return;
    const id = this.ctx.store.st.hover;
    for (const e of this.svg.querySelectorAll('.is-hover')) e.classList.remove('is-hover');
    if (!id) return;
    const pin = this.svg.querySelector(`.dc-pin[data-rid="${CSS.escape(id)}"]`);
    if (pin) { pin.classList.add('is-hover'); return; }
    const k = this.ctx.snap().byId.get(id);
    if (k) this.svg.querySelector(`.dc-area[data-area="${CSS.escape(k.area)}"] .stamp`)?.classList.add('is-hover');
  }

  // ---------------------------------------------------------------- interaction
  private onClick(e: MouseEvent): void {
    const t = e.target as Element;
    const pin = t.closest<SVGGElement>('.dc-pin[data-rid]');
    if (pin) { this.ctx.opts.openRestaurant(pin.dataset.rid!); return; }
    const a = t.closest<HTMLElement | SVGElement>('[data-act]');
    if (!a || !this.el.contains(a) || (a as HTMLButtonElement).disabled) { if (this.pop && !t.closest('.dc-map-pop')) this.closePop(); return; }
    const arg = a.dataset.arg ?? '', st = this.ctx.store;
    switch (a.dataset.act) {
      case 'up': st.set({ area: null }); break;
      case 'region': st.set({ region: arg as Region }); break;
      case 'overlay': st.set({ overlay: arg as Overlay }); break;
      case 'area': st.set({ area: arg }); break;
      case 'buy': this.ctx.opts.buyLot(arg); break;
      case 'locked': this.openPop(arg, a as Element); break;
      case 'unlock':
        if (a.classList.contains('done')) break; // already unlocked, popover closing
        if (run(a, A.unlockDistrict(this.s, arg), 'purchase')) {
          const btn = a as HTMLButtonElement;
          btn.classList.add('done'); btn.setAttribute('aria-disabled', 'true'); punch(btn); coinBurst(btn, 14);
          setTimeout(() => { // let the punch land, then rebuild the map with the area open and pop its stamp
            if (this.pop?.contains(btn)) this.closePop();
            this.ctx.refresh();
            const st = this.svg?.querySelector<SVGGElement>(`.dc-area[data-area="${CSS.escape(arg)}"] .stamp`);
            if (st) { punch(st as unknown as HTMLElement); st.focus(); }
          }, 300);
        }
        break;
      case 'close': this.closePop(); break;
    }
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as Element;
    if (e.key === 'Escape' && this.pop) { e.preventDefault(); e.stopPropagation(); this.closePop(); return; }
    if (!(t instanceof SVGElement) || t.getAttribute('role') !== 'button') return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
    // arrow roving: nearest focusable in the pressed direction
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (!dir) return;
    e.preventDefault();
    const c = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
    const [x0, y0] = c(t);
    let best: SVGElement | null = null, bd = Infinity;
    for (const o of this.svg.querySelectorAll<SVGElement>('[role="button"]')) {
      if (o === t) continue;
      const [x, y] = c(o), dx = x - x0, dy = y - y0, along = dx * dir[0] + dy * dir[1];
      if (along <= 0) continue;
      const d = along + Math.abs(dx * dir[1] + dy * dir[0]) * 2;
      if (d < bd) { bd = d; best = o; }
    }
    best?.focus();
  }

  private openPop(areaId: string, anchor: Element): void {
    this.closePop();
    const a = AREAS[areaId], s = this.s, u = a.unlock;
    const ch2 = !u.chapter2 || !!s.flags.chapter2, pcs = s.lifetime.pieces >= u.pieces, cash = s.cash >= u.cost;
    const ok = (b: boolean) => `<span class="dc-band ${b ? 'good' : 'act'}" aria-label="${b ? 'met' : 'not met'}">${BAND_MARK[b ? 'good' : 'act'].glyph}</span>`;
    const pop = document.createElement('div');
    pop.className = 'dc-map-pop pop-in';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Unlock ${a.name}`);
    const can = ch2 && pcs && cash;
    pop.innerHTML = `<div class="hd">${icon('lock', 28, { variant: 'seal' })}<b><span class="jp">${esc(a.jp)}</span> ${esc(a.name)}</b>
      <button class="x" data-act="close" aria-label="Close">${icon('close', 14)}</button></div><p>${esc(a.blurb)}</p>
      <ul>${u.chapter2 ? `<li class="${ch2 ? 'met' : ''}">${ok(ch2)} Chapter 2 (1M pieces)</li>` : ''}<li class="${pcs ? 'met' : ''}">${ok(pcs)} ${short(u.pieces)} pieces sold</li><li class="${cash ? 'met' : ''}">${ok(cash)} Permit ${yen(u.cost)}</li></ul>
      <button class="btn primary" data-act="unlock" data-arg="${areaId}" ${can ? '' : 'disabled'}>${icon(can ? 'check' : 'lock', 16)} ${can ? 'Unlock' : 'Locked'} · ${yen(u.cost)}</button>`;
    this.wrap.append(pop);
    const wr = this.wrap.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    const x = ar.left - wr.left + ar.width / 2, y = ar.bottom - wr.top + 4;
    pop.style.left = `${Math.max(4, Math.min(wr.width - pop.offsetWidth - 4, x - pop.offsetWidth / 2))}px`;
    pop.style.top = `${y + pop.offsetHeight > wr.height ? Math.max(4, ar.top - wr.top - pop.offsetHeight - 4) : y}px`;
    this.pop = pop;
    (pop.querySelector<HTMLButtonElement>('[data-act="unlock"]:not(:disabled)') ?? pop.querySelector<HTMLButtonElement>('.x'))!.focus();
    (pop as HTMLElement & { _back?: Element })._back = anchor;
  }

  private closePop(): void {
    if (!this.pop) return;
    const back = (this.pop as HTMLElement & { _back?: Element })._back as SVGElement | undefined;
    const had = this.pop.contains(document.activeElement);
    this.pop.remove(); this.pop = null;
    if (had && back?.isConnected) back.focus();
  }

  destroy(): void {
    this.ro.disconnect();
    for (const off of this.offs) off();
    this.el.remove();
  }
}
