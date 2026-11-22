// Daichō map pane — washi ward map. Empire altitude: areas of one region as stamps with restaurant pin clusters.
// City altitude (store.area set): a street-grid lot plan of one area. SVG is built once per view key and patched per tick.
import { AREAS, AreaDef, CONCEPTS, CONCEPT_IDS, PROPERTIES, Region } from '../../core/data';
import { RestKPI } from '../../core/empire';
import { short, yen } from '../../core/format';
import * as A from '../../core/actions';
import { esc, run } from '../dom';
import { BAND_MARK, Band, CONCEPT_SHAPE, Ctx, Overlay, Part, Snap, conceptGlyph, health, overlayBand, shapePath } from './shared';
import './map.css';

const W = 100, H = 62; // viewBox
const CAP = 8; // max pins per area cluster at Empire altitude (rest go behind a "+k" badge)
const REGIONS: [Region, string, string][] = [['tokyo', '東京', 'Tokyo'], ['japan', '日本', 'Japan'], ['world', '世界', 'World']];
const OVERLAYS: [Overlay, string, string][] = [['profit', 'Profit', 'Profit'], ['load', 'Load', 'Kitchen load'], ['stock', 'Stock', 'Stock days'], ['stars', '★', 'Rating'], ['staff', 'Staff', 'Staff']];
const SIZE = [1.15, 1.45, 1.8]; // pin radius per revenue band (Empire altitude)

const backdrop: Record<Region, string> = {
  tokyo: `<path class="sea" d="M48,62 C54,58 60,57 65,58 C71,59 75,55 81,54 C87,53 93,49 100,46 V62 Z"/>
    <path class="river" d="M71,0 C68,10 73,18 69,27 C66,35 71,42 66,50 C64,54 66,57 63,60"/>
    <ellipse class="rail" cx="47" cy="24" rx="16" ry="11"/>
    <rect class="park" x="44" y="26" width="8" height="5" rx="1.6"/>
    <text class="geo" x="91.5" y="60.6">東京湾 Tokyo Bay</text><text class="geo" x="73" y="8" transform="rotate(-78 73 8)">隅田川</text>`,
  japan: `<path class="land" d="M62,8 C66,3 74,3 78,6 C82,9 80,14 76,16 C72,19 66,18 63,15 C60,13 60,10 62,8 Z"/>
    <path class="land" d="M30,44 C36,40 42,40 48,38 C54,36 58,33 62,28 C65,24 68,21 72,20 C75,20 76,23 74,26 C72,30 70,34 66,38 C62,42 56,44 50,46 C44,48 36,49 31,48 C29,47 29,45 30,44 Z"/>
    <path class="land" d="M40,49 C44,48 50,48 52,50 C52,52 46,53 42,52 C40,52 39,50 40,49 Z"/>
    <path class="land" d="M22,48 C26,47 29,49 29,53 C29,57 26,60 23,59 C20,58 19,54 20,51 C20,49 21,48 22,48 Z"/>
    <text class="geo" x="22" y="20">日本海 Sea of Japan</text><text class="geo" x="84" y="50">太平洋 Pacific</text>`,
  world: `<path class="land" d="M6,10 C14,6 26,8 30,14 C32,20 28,26 24,30 C20,34 16,36 14,40 C10,36 6,30 5,22 C4,16 4,12 6,10 Z"/>
    <path class="land" d="M22,40 C26,40 30,44 29,50 C28,56 24,60 22,61 C20,56 19,50 19,45 C19,42 20,40 22,40 Z"/>
    <path class="land" d="M42,14 C46,10 54,10 56,14 C57,18 54,22 52,26 C49,28 45,27 43,24 C41,21 40,17 42,14 Z"/>
    <path class="land" d="M44,30 C50,28 56,30 58,35 C60,40 56,48 52,54 C49,56 47,52 46,46 C44,40 42,34 44,30 Z"/>
    <path class="land" d="M57,12 C64,8 80,8 90,12 C94,16 92,22 86,26 C82,30 78,32 74,34 C70,36 64,34 60,30 C57,26 55,18 57,12 Z"/>
    <path class="land" d="M78,46 C84,44 90,46 91,50 C91,54 86,56 82,55 C78,54 76,50 78,46 Z"/>
    <path class="land" d="M88,20 c1.4,-1 2.4,.4 1.6,2.4 c-.6,1.8 -2.2,2.8 -2.8,1.8 Z"/>
    <text class="geo" x="34" y="44">大西洋 Atlantic</text><text class="geo" x="92.5" y="40">太平洋 Pacific</text>`,
};

/** Region-space (0..100) → viewBox, then push overlapping label boxes apart (deterministic, memoised per region). */
const layoutMemo = new Map<Region, Map<string, { x: number; y: number }>>();
function layout(region: Region): Map<string, { x: number; y: number }> {
  let m = layoutMemo.get(region);
  if (m) return m;
  const ids = Object.values(AREAS).filter((a) => a.region === region).map((a) => a.id);
  const p = ids.map((id) => ({ x: 4 + AREAS[id].map.x * 0.92, y: 5 + AREAS[id].map.y * 0.6 }));
  const BW = 17, BH = 19; // footprint of stamp + pin ring + 2-line label
  for (let it = 0; it < 200; it++) {
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      const dx = p[j].x - p[i].x || 0.01, dy = p[j].y - p[i].y || 0.01, ox = BW - Math.abs(dx), oy = BH - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      if (ox / BW < oy / BH) { const s = Math.sign(dx) * ox * 0.26; p[i].x -= s; p[j].x += s; }
      else { const s = Math.sign(dy) * oy * 0.26; p[i].y -= s; p[j].y += s; }
    }
    for (const q of p) { q.x = Math.min(91, Math.max(9, q.x)); q.y = Math.min(49, Math.max(7.5, q.y)); }
  }
  m = new Map(ids.map((id, i) => [id, p[i]]));
  layoutMemo.set(region, m);
  return m;
}

/** Inner washi mark so band never relies on fill colour: ◎ ring / △ / ✕. */
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

interface PinRef { g: SVGGElement; body: SVGPathElement; mark: SVGPathElement; ring: SVGCircleElement; label?: SVGTextElement; rid: string | null }

export class MapView implements Part {
  readonly el = document.createElement('div');
  private readonly head: HTMLElement;
  private readonly wrap: HTMLElement;
  private svg!: SVGSVGElement;
  private key = '';
  private pins = new Map<string, PinRef[]>(); // area id (Empire) or 'city' → pin slots
  private sums = new Map<string, SVGTextElement>();
  private badges = new Map<string, SVGTextElement>();
  private labels: { x: number; t: SVGTextElement[] }[] = []; // Empire area labels, kept inside the viewBox
  private lots: { g: SVGGElement; price: number }[] = [];
  private pop: HTMLElement | null = null;
  private crumbSum: HTMLElement | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private ctx: Ctx) {
    this.el.className = 'dc-map';
    this.head = document.createElement('div');
    this.head.className = 'dc-map-head';
    this.wrap = document.createElement('div');
    this.wrap.className = 'dc-map-wrap';
    this.el.append(this.head, this.wrap);
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
    const key = area
      ? `C|${area}|${s.districts.includes(area)}|${snap.kpis.filter((k) => k.area === area).map((k) => k.id).join()}`
      : `E|${region}|${Object.values(AREAS).filter((a) => a.region === region).map((a) => `${a.id}:${s.districts.includes(a.id) ? snap.kpis.filter((k) => k.area === a.id).length : 'x'}`).join()}`;
    if (key !== this.key) { this.key = key; this.header(); area ? this.buildCity(area, snap) : this.buildEmpire(region, snap); this.highlight(); }
    this.patch(snap);
  }

  // ---------------------------------------------------------------- header
  private header(): void {
    const { area, region, overlay } = this.ctx.store.st;
    const a = area ? AREAS[area] : null;
    const crumb = a
      ? `<button class="dc-map-crumb" data-act="up" title="Back to the empire (Esc)">本社 Empire</button><span aria-hidden="true">›</span><b>${esc(a.jp)} ${esc(a.name)}</b><span class="dc-map-csum"></span>`
      : `<b>本社 Empire</b>`;
    const tabs = a ? '' : `<div class="dc-map-tabs" role="tablist" aria-label="Region">${REGIONS.map(([id, jp, en]) =>
      `<button role="tab" aria-selected="${id === region}" data-act="region" data-arg="${id}"><span class="jp">${jp}</span> ${en}</button>`).join('')}</div>`;
    const seg = `<div class="dc-map-seg" role="group" aria-label="Map overlay">${OVERLAYS.map(([id, txt, lbl]) =>
      `<button aria-pressed="${id === overlay}" data-act="overlay" data-arg="${id}" aria-label="${lbl}" title="${lbl}">${txt}</button>`).join('')}</div>`;
    const legend = `<details class="dc-map-legend"><summary aria-label="Map legend">${CONCEPT_IDS.map((c) => conceptGlyph(c, 11)).join('')}<span class="marks">◎△✕</span></summary>
      <div class="dc-map-legend-p">${CONCEPT_IDS.map((c) => `<div>${conceptGlyph(c, 13)} ${CONCEPTS[c].name}</div>`).join('')}
      <hr>${(['good', 'watch', 'act'] as Band[]).map((b) => `<div><span class="dc-band ${b}">${BAND_MARK[b].glyph}</span> ${BAND_MARK[b].word}</div>`).join('')}
      <div class="sub">Size = revenue · ring = needs action · dashed = locked / for sale</div></div></details>`;
    const open = this.head.querySelector('details')?.open;
    this.head.innerHTML = `<div class="dc-map-row"><nav class="dc-map-bc" aria-label="Altitude">${crumb}</nav>${tabs}</div><div class="dc-map-row">${seg}${legend}</div>`;
    if (open) this.head.querySelector('details')!.open = true;
    this.crumbSum = this.head.querySelector('.dc-map-csum');
  }

  // ---------------------------------------------------------------- build (once per view)
  private reset(inner: string, label: string): void {
    this.closePop();
    this.pins.clear(); this.sums.clear(); this.badges.clear(); this.lots = []; this.labels = [];
    this.wrap.innerHTML = `<svg class="dc-map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="${esc(label)}">
      <defs><filter id="dc-ink" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale=".9"/></filter></defs>
      ${inner}</svg>`;
    this.svg = this.wrap.firstElementChild as unknown as SVGSVGElement;
  }

  private pinSvg(r: number, cls = ''): string {
    return `<g class="dc-pin ${cls}" role="button" tabindex="0"><g class="in"><circle class="ring" r="${r + 0.9}"/><path class="body"/><path class="mark"/></g></g>`;
  }

  private ref(g: SVGGElement): PinRef {
    return { g, body: g.querySelector('.body')!, mark: g.querySelector('.mark')!, ring: g.querySelector('.ring')!, label: g.querySelector<SVGTextElement>('.ol') ?? undefined, rid: null };
  }

  private buildEmpire(region: Region, snap: Snap): void {
    const s = this.s, pos = layout(region);
    const nodes = [...pos].map(([id, p]) => {
      const a = AREAS[id], n = snap.kpis.filter((k) => k.area === id).length;
      const name = (y: number) => `<text class="nm" y="${y}"><tspan class="jp">${esc(a.jp.length > 3 ? '' : a.jp)}</tspan> ${esc(shortName(a))}</text>`;
      if (!s.districts.includes(id)) {
        const req = a.unlock.chapter2 && !s.flags.chapter2 ? 'Chapter 2' : `${short(a.unlock.pieces)} 🍣 · ${yen(a.unlock.cost)}`;
        return `<g class="dc-area locked" data-x="${p.x.toFixed(2)}" transform="translate(${p.x.toFixed(2)},${p.y.toFixed(2)})" role="button" tabindex="0" data-act="locked" data-arg="${id}"
          aria-label="${esc(a.name)} — locked, needs ${esc(req)}"><circle class="hit" r="5"/><circle class="lk" r="2.8"/><text class="lkc" y=".75">${esc(a.jp[0])}</text>${name(5.4)}<text class="sm" y="7.7">${esc(req)}</text></g>`;
      }
      const vis = n > CAP ? CAP - 1 : n, R = 4.6;
      const slots = Array.from({ length: vis }, (_, i) => {
        const t = -Math.PI / 2 + (i / Math.max(vis, n > CAP ? CAP : 1)) * Math.PI * 2;
        return `<g transform="translate(${(Math.cos(t) * R).toFixed(2)},${(Math.sin(t) * R).toFixed(2)})">${this.pinSvg(SIZE[2])}</g>`;
      }).join('');
      const tb = -Math.PI / 2 + ((CAP - 1) / CAP) * Math.PI * 2;
      const badge = n > CAP ? `<text class="more" x="${(Math.cos(tb) * R).toFixed(2)}" y="${(Math.sin(tb) * R + 0.7).toFixed(2)}">+${n - vis}</text>` : '';
      return `<g class="dc-area${n ? '' : ' empty'}" data-area="${id}" data-x="${p.x.toFixed(2)}" transform="translate(${p.x.toFixed(2)},${p.y.toFixed(2)})">
        <g class="stamp" role="button" tabindex="0" data-act="area" data-arg="${id}" aria-label="${esc(a.name)} — ${n} restaurant${n === 1 ? '' : 's'}, open city"><circle class="hit" r="3.2"/>
          <rect x="-2.4" y="-2.4" width="4.8" height="4.8" rx=".7" transform="rotate(-6)"/><text class="cnt" y=".8">${n || '+'}</text></g>
        ${slots}${badge}${name(n ? 8.9 : 5.4)}<text class="sm sum" y="${n ? 11.2 : 7.7}"></text></g>`;
    }).join('');
    this.reset(`<g class="bg" filter="url(#dc-ink)">${backdrop[region]}</g>${nodes}`, `${REGIONS.find((r) => r[0] === region)![2]} map — areas and restaurants`);
    this.labels = [...this.svg.querySelectorAll<SVGGElement>('.dc-area')].map((g) => ({ x: +g.dataset.x!, t: [...g.querySelectorAll<SVGTextElement>('.nm, .sm')] }));
    for (const g of this.svg.querySelectorAll<SVGGElement>('.dc-area[data-area]')) {
      const id = g.dataset.area!;
      this.pins.set(id, [...g.querySelectorAll<SVGGElement>('.dc-pin')].map((p) => this.ref(p)));
      this.sums.set(id, g.querySelector<SVGTextElement>('.sum')!);
      const b = g.querySelector<SVGTextElement>('.more');
      if (b) this.badges.set(id, b);
    }
  }

  private buildCity(area: string, snap: Snap): void {
    const s = this.s, a = AREAS[area];
    const lots = Object.values(PROPERTIES).filter((p) => p.district === area).sort((x, y) => x.price - y.price || x.id.localeCompare(y.id));
    const extra = snap.kpis.filter((k) => k.area === area && !PROPERTIES[k.id]).map((k) => k.id); // defensive: restaurants not on a known lot
    const ids = [...lots.map((p) => p.id), ...extra];
    const n = Math.max(1, ids.length), cols = Math.min(n, Math.ceil(Math.sqrt(n * 1.7))), rows = Math.ceil(n / cols);
    const cw = (W - 8) / cols, ch = (H - 6) / rows, unlocked = s.districts.includes(area);
    const streets = [
      ...Array.from({ length: cols + 1 }, (_, i) => `<line class="st" x1="${4 + i * cw}" y1="0" x2="${4 + i * cw}" y2="${H}"/>`),
      ...Array.from({ length: rows + 1 }, (_, i) => `<line class="st" x1="0" y1="${3 + i * ch}" x2="${W}" y2="${3 + i * ch}"/>`),
    ].join('');
    const maxCh = Math.floor(cw / 1.15);
    const cells = ids.map((id, i) => {
      const cx = 4 + (i % cols + 0.5) * cw, cy = 3 + (Math.floor(i / cols) + 0.5) * ch;
      const block = `<rect class="blk" x="${(cx - cw / 2 + 1.6).toFixed(2)}" y="${(cy - ch / 2 + 1.6).toFixed(2)}" width="${(cw - 3.2).toFixed(2)}" height="${(ch - 3.2).toFixed(2)}" rx="1"/>`;
      const r = s.restaurants[id];
      if (r) {
        const pr = Math.min(4, ch / 5);
        return `${block}<g transform="translate(${cx.toFixed(2)},${(cy - pr * 0.6).toFixed(2)})">${this.pinSvg(pr, 'big').replace('</g></g>', `</g><text class="nm" y="${(pr + 2.6).toFixed(2)}">${esc(clip(r.name, maxCh))}</text><text class="ol" y="${(pr + 5).toFixed(2)}"></text></g>`)}</g>`;
      }
      const p = PROPERTIES[id], lw = Math.min(cw - 8, 16), lh = Math.min(ch - 10, 9);
      return `${block}<g class="dc-lot" transform="translate(${cx.toFixed(2)},${(cy - 1.5).toFixed(2)})" role="button" tabindex="0" data-act="${unlocked ? 'buy' : 'locked'}" data-arg="${unlocked ? id : area}"
        aria-label="${esc(p.name)} — for sale, ${yen(p.price)}"><rect class="lot" x="${-lw / 2}" y="${-lh / 2}" width="${lw}" height="${lh}" rx=".6"/>
        <text class="fs" y="-.3">売 For sale</text><text class="pr" y="2.4">${p.price ? yen(p.price) : 'free'}</text><text class="nm" y="${(lh / 2 + 2.6).toFixed(2)}">${esc(clip(p.name, maxCh))}</text></g>`;
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
      if (p.body.getAttribute('d') !== d) p.body.setAttribute('d', d);
      const md = markPath(o.band, r);
      if (p.mark.getAttribute('d') !== md) p.mark.setAttribute('d', md);
      p.ring.setAttribute('r', String(r + 0.9));
      p.g.setAttribute('class', `dc-pin b-${o.band}${h.band === 'act' ? ' is-act' : ''}${city ? ' big' : ''}${this.ctx.store.st.hover === k.id ? ' is-hover' : ''}`);
      p.g.setAttribute('aria-label', `${k.name} — ${CONCEPTS[k.concept].name.toLowerCase()}, ${ovName} ${o.label} (${BAND_MARK[o.band].word}), ${BAND_MARK[h.band].word}: ${h.why.toLowerCase()}`);
      if (p.label) { const t = `${BAND_MARK[o.band].glyph} ${o.label}`; if (p.label.textContent !== t) p.label.textContent = t; p.label.setAttribute('class', `ol b-${o.band}`); }
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
      const dx = (l.x + lo < 1 ? 1 - (l.x + lo) : l.x + hi > W - 1 ? W - 1 - (l.x + hi) : 0).toFixed(2);
      for (const t of l.t) if (t.getAttribute('x') !== dx) t.setAttribute('x', dx);
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
      case 'unlock': if (run(a, A.unlockDistrict(this.s, arg), 'fanfare')) { this.closePop(); this.ctx.refresh(); } break;
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
    const ok = (b: boolean) => `<span class="dc-band ${b ? 'good' : 'act'}" aria-label="${b ? 'met' : 'not met'}">${b ? '◎' : '✕'}</span>`;
    const pop = document.createElement('div');
    pop.className = 'dc-map-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Unlock ${a.name}`);
    pop.innerHTML = `<button class="x" data-act="close" aria-label="Close">×</button><b><span class="jp">${esc(a.jp)}</span> ${esc(a.name)}</b><p>${esc(a.blurb)}</p>
      <ul>${u.chapter2 ? `<li>${ok(ch2)} Chapter 2 (1M pieces)</li>` : ''}<li>${ok(pcs)} ${short(u.pieces)} pieces sold</li><li>${ok(cash)} Permit ${yen(u.cost)}</li></ul>
      <button class="btn small gold" data-act="unlock" data-arg="${areaId}" ${ch2 && pcs && cash ? '' : 'disabled'}>Unlock — ${yen(u.cost)}</button>`;
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
    for (const off of this.offs) off();
    this.el.remove();
  }
}
