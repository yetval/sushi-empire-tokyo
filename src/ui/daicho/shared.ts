// Daichō 台帳 — shared contract between the shell (daicho.ts) and its parts (strip, map, ledger, alerts).
// Parts never call core/empire directly for reads: the shell builds one Snap per tick and hands it to every part.
import { Alert, EmpireTotals, RestKPI, alerts, empireTotals, restaurantKPIs } from '../../core/empire';
import { ConceptId, Region } from '../../core/data';
import { GameState } from '../../core/state';
import { UIHost } from '../host';

export type Overlay = 'profit' | 'load' | 'stock' | 'stars' | 'staff';
export type Band = 'good' | 'watch' | 'act';

/** One consistent read of the empire, rebuilt by the shell every SNAP_EVERY seconds (not per frame). */
export interface Snap {
  t: number; // performance.now() when built
  kpis: RestKPI[];
  byId: Map<string, RestKPI>;
  totals: EmpireTotals;
  alerts: Alert[];
}
export const SNAP_EVERY = 0.5;

export function buildSnap(s: GameState): Snap {
  const kpis = restaurantKPIs(s);
  return { t: performance.now(), kpis, byId: new Map(kpis.map((k) => [k.id, k])), totals: empireTotals(s), alerts: alerts(s) };
}

/** UI state shared by all parts. Mutate only via set(); parts subscribe with on(). */
export interface StoreState {
  region: Region; // map tab at Empire altitude
  area: string | null; // null = Empire altitude; an area id = City altitude (map zoomed, ledger filtered)
  overlay: Overlay;
  hover: string | null; // restaurant id under pointer/focus (cross-highlight map ⇄ ledger)
  selected: Set<string>; // ledger bulk selection
}
export type StoreKey = keyof StoreState;

export class Store {
  st: StoreState = { region: 'tokyo', area: null, overlay: 'profit', hover: null, selected: new Set() };
  private subs: { keys: StoreKey[] | null; fn: (changed: StoreKey[]) => void }[] = [];
  set(p: Partial<StoreState>): void {
    const changed = (Object.keys(p) as StoreKey[]).filter((k) => p[k] !== this.st[k]);
    if (!changed.length) return;
    Object.assign(this.st, p);
    for (const s of this.subs) if (!s.keys || s.keys.some((k) => changed.includes(k))) s.fn(changed);
  }
  /** Selection is a Set: call this after mutating st.selected in place. */
  touchSelected(): void { for (const s of this.subs) if (!s.keys || s.keys.includes('selected')) s.fn(['selected']); }
  on(keys: StoreKey[] | null, fn: (changed: StoreKey[]) => void): () => void {
    const sub = { keys, fn };
    this.subs.push(sub);
    return () => { this.subs = this.subs.filter((x) => x !== sub); };
  }
}

/** Everything a part gets. */
export interface Ctx {
  host: UIHost;
  store: Store;
  opts: { openRestaurant(restId: string): void; buyLot(propId: string): void };
  /** Ask the shell to rebuild the snapshot now (after an action changed state) and re-render all parts. */
  refresh(): void;
  /** Latest snapshot (for store-driven re-renders between ticks, e.g. hover/selection). */
  snap(): Snap;
}

/** Every part implements this. render() must PATCH existing DOM (no full innerHTML rebuild of lists per tick). */
export interface Part {
  readonly el: HTMLElement;
  render(snap: Snap): void;
  destroy(): void;
}

// ---------------------------------------------------------------- shared visual language (map + ledger MUST agree)
/** Concept → pin shape. Shape carries the format so it never depends on colour. */
export const CONCEPT_SHAPE: Record<ConceptId, 'circle' | 'square' | 'triangle' | 'hex' | 'diamond' | 'pent'> = {
  kaiten: 'circle', omakase: 'square', kiosk: 'triangle', ghost: 'hex', bar: 'diamond', stand: 'pent',
};

/** SVG path for a shape centred on 0,0 with radius r (use inside <g transform="translate(x,y)">). */
export function shapePath(shape: (typeof CONCEPT_SHAPE)[ConceptId], r: number): string {
  const poly = (n: number, rot: number) => Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2;
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  }).join(' L');
  switch (shape) {
    case 'circle': return `M${-r},0 a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`;
    case 'square': return `M${-r * 0.85},${-r * 0.85} H${r * 0.85} V${r * 0.85} H${-r * 0.85} Z`;
    case 'triangle': return `M${poly(3, -Math.PI / 2)} Z`;
    case 'hex': return `M${poly(6, 0)} Z`;
    case 'diamond': return `M${poly(4, -Math.PI / 2)} Z`;
    case 'pent': return `M${poly(5, -Math.PI / 2)} Z`;
  }
}

/** Inline SVG glyph for a concept (ledger rows, legends). */
export function conceptGlyph(c: ConceptId, size = 14, cls = ''): string {
  const r = size / 2 - 1.5;
  return `<svg class="dc-glyph ${cls}" width="${size}" height="${size}" viewBox="${-size / 2} ${-size / 2} ${size} ${size}" aria-hidden="true"><path d="${shapePath(CONCEPT_SHAPE[c], r)}"/></svg>`;
}

/** Health band of one restaurant — the single source of truth for "is this ok?" (map fill, ledger mark, sort). */
export function health(k: RestKPI): { band: Band; why: string } {
  const missingChef = k.staff.chef[0] === 0;
  if (missingChef) return { band: 'act', why: 'No chef' };
  if (k.stockDays < 0.5) return { band: 'act', why: 'Out of stock soon' };
  if (k.load > 1.05) return { band: 'act', why: 'Turning guests away' };
  if (k.profitYesterday !== null && k.profitYesterday < 0) return { band: 'act', why: 'Losing money' };
  if (k.stockDays < 1.5) return { band: 'watch', why: 'Stock low' };
  if (k.load > 0.9) return { band: 'watch', why: 'Kitchen near capacity' };
  if (k.stars < 2.5) return { band: 'watch', why: 'Low rating' };
  if (k.load < 0.35) return { band: 'watch', why: 'Kitchen idle' };
  return { band: 'good', why: 'Running well' };
}

/** Band + short label for a map overlay. */
export function overlayBand(k: RestKPI, o: Overlay): { band: Band; label: string } {
  switch (o) {
    case 'profit': {
      const p = k.profitYesterday ?? k.revToday;
      return { band: p < 0 ? 'act' : p < 5_000 ? 'watch' : 'good', label: k.profitYesterday === null ? 'new' : `${p < 0 ? '-' : ''}¥${Math.round(Math.abs(p)).toLocaleString('en-US')}` };
    }
    case 'load': return { band: k.load > 1.05 ? 'act' : k.load > 0.9 || k.load < 0.35 ? 'watch' : 'good', label: `${Math.round(k.load * 100)}%` };
    case 'stock': return { band: k.stockDays < 0.5 ? 'act' : k.stockDays < 1.5 ? 'watch' : 'good', label: Number.isFinite(k.stockDays) ? `${k.stockDays.toFixed(1)}d` : '—' };
    case 'stars': return { band: k.stars < 2 ? 'act' : k.stars < 3 ? 'watch' : 'good', label: `★${k.stars.toFixed(1)}` };
    case 'staff': {
      const roles = Object.values(k.staff);
      const have = roles.reduce((a, r) => a + r[0], 0), slots = roles.reduce((a, r) => a + r[1], 0);
      return { band: k.staff.chef[0] === 0 ? 'act' : have < slots * 0.6 ? 'watch' : 'good', label: `${have}/${slots}` };
    }
  }
}

/** Band marks: text glyph + accessible word, so state never relies on colour alone. */
export const BAND_MARK: Record<Band, { glyph: string; word: string }> = {
  good: { glyph: '◎', word: 'good' }, watch: { glyph: '△', word: 'watch' }, act: { glyph: '✕', word: 'act now' },
};

/** Tiny SVG sparkline (values oldest→newest). Returns '' for < 2 points. Draws a zero line when the series crosses 0. */
export function spark(values: number[], w = 64, h = 18, cls = ''): string {
  if (values.length < 2) return `<svg class="dc-spark ${cls}" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const lo = Math.min(0, ...values), hi = Math.max(...values, lo + 1e-9);
  const x = (i: number) => (i / (values.length - 1)) * (w - 2) + 1;
  const y = (v: number) => h - 1 - ((v - lo) / (hi - lo)) * (h - 2);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const zero = lo < 0 ? `<line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="z"/>` : '';
  const last = values[values.length - 1];
  return `<svg class="dc-spark ${cls}" width="${w}" height="${h}" aria-hidden="true">${zero}<path d="${d}"/><circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="1.8"/></svg>`;
}

/** Inject a part's CSS once (alternative to importing a .css file). */
export function injectCss(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const st = document.createElement('style');
  st.id = id; st.textContent = css;
  document.head.append(st);
}
