// Restaurant altitude: a side sheet for one location (overview, staff, menu & price, books, format,
// upgrades & look) plus the shared format (concept) cards used by the buy-lot dialog.
import { audio } from '../audio/audio';
import * as A from '../core/actions';
import { unlockedCosmetics } from '../core/achievements';
import {
  AREAS, CONCEPTS, CONCEPT_IDS, ConceptId, MAX_SKILL, PROPERTIES, RECIPES, RESEARCH, ROLES, Role, UPGRADES, milestone, recipeCost, trainCost,
} from '../core/data';
import * as E from '../core/empire';
import { exact, short, yen, yenExact } from '../core/format';
import { averageStars } from '../core/reviews';
import * as sim from '../core/sim';
import { GameState, RestDay } from '../core/state';
import { delegate, el, esc, fail, healthSeal, ingIcon, patch, pips, run, stars } from './dom';
import { UIHost } from './host';
import { coinBurst, punch } from './fx';
import { icon } from './icons';

// ---------------------------------------------------------------- shared: formats
export const CONCEPT_INK: Record<ConceptId, string> = { stand: '#b82d25', kiosk: '#8f6a1f', bar: '#7b4d2c', kaiten: '#46702f', omakase: '#1f1b17', ghost: '#5b5047' };
const KANJI: Record<ConceptId, string> = { stand: '屋', kiosk: '持', bar: '寿', kaiten: '回', omakase: '任', ghost: '配' };

/** Plain-language trade-offs, derived from the numbers (the Sushi Bar is the 1.0 baseline). */
export function conceptTraits(c: (typeof CONCEPTS)[ConceptId]): { pro: string[]; con: string[] } {
  const pro: string[] = [], con: string[] = [];
  const pct = (v: number) => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}%`;
  if (c.traffic > 1.05) pro.push(`${pct(c.traffic)} guests`); else if (c.traffic < 0.95) con.push(`${pct(c.traffic)} guests`);
  if (c.price > 1.05) pro.push(`Bills ×${c.price}`); else if (c.price < 0.95) con.push(`Bills ×${c.price}`);
  if (c.elasticity < 0.9) pro.push('Price-proof guests'); else if (c.elasticity > 1.1) con.push('Price-sensitive');
  if (c.cook > 1.05) pro.push(`${pct(c.cook)} kitchen`); else if (c.cook < 0.95) con.push(`${pct(c.cook)} kitchen`);
  if (c.quality > 0.01) pro.push(`+${Math.round(c.quality * 100)} quality`); else if (c.quality < -0.01) con.push(`−${Math.round(-c.quality * 100)} quality`);
  if (c.rent < 0.95) pro.push(`Rent ${pct(c.rent)}`); else if (c.rent > 1.05) con.push(`Rent ${pct(c.rent)}`);
  if (c.staff > 1.05) pro.push(`Chef slots ×${c.staff}`); else if (c.staff < 0.95) con.push(`Chef slots ×${c.staff}`);
  if (!c.needsServer) pro.push('No servers');
  if (!c.walkIn) con.push('Delivery only');
  return { pro, con };
}

/** Format cards. mode 'buy' shows lot price + fit-out; 'switch' shows the refit cost and stamps the current format.
 *  The head is a 3-cell grid (seal · name · stamp), so the 現 stamp can never sit on the name. */
export function conceptCards(s: GameState, propId: string, selected: ConceptId | null, mode: 'buy' | 'switch'): string {
  const lot = PROPERTIES[propId];
  const current = s.restaurants[propId]?.concept;
  return CONCEPT_IDS.map((id) => {
    const c = CONCEPTS[id];
    const why = A.conceptAllowed(s, propId, id);
    const fit = A.fitoutCost(propId, id);
    const total = (mode === 'buy' ? lot.price : 0) + fit;
    const { pro, con } = conceptTraits(c);
    const isCur = mode === 'switch' && current === id, sel = selected === id;
    const mark = isCur ? '<span class="c-stamp" title="Current format">現</span>' : sel ? `<span class="c-tick">${icon('check', 16)}</span>` : '';
    const chips = pro.map((p) => `<i class="chip pro">${p}</i>`).join('') + con.map((p) => `<i class="chip con">${p}</i>`).join('');
    const cost = isCur ? `<em class="here">${icon('home', 16)} Running here now</em>`
      : why ? `<em class="lock">${icon('lock', 16)} ${esc(why)}</em>`
      : `<b class="num ink">${yen(total)}</b><small>${mode === 'buy' ? (fit ? `lot ${yen(lot.price)} + fit-out ${yen(fit)}` : 'lot only, no fit-out') : 'refit cost'}</small>`;
    return `<button class="concept ${sel ? 'sel' : ''} ${why ? 'locked' : ''} ${isCur ? 'cur' : ''}" style="--ink:${CONCEPT_INK[id]}" title="${esc(c.desc)}" data-act="pickc" data-arg="${id}" aria-pressed="${sel}" ${why && !isCur ? 'aria-disabled="true"' : ''}>
      <span class="c-head"><span class="c-seal" aria-hidden="true">${KANJI[id]}</span><span class="c-name"><b>${c.name}</b><small>${c.jp}</small></span>${mark}</span>
      <span class="c-traits">${chips || '<i class="chip base">Balanced: no big pluses or minuses</i>'}</span>
      <span class="c-cost">${cost}</span>
    </button>`;
  }).join('');
}

// ---------------------------------------------------------------- tiny SVG charts
function dial(load: number, automated: boolean): string {
  const a = (v: number) => Math.PI * (1 - Math.min(2, Math.max(0, v)) / 2);
  const arc = (v0: number, v1: number, col: string) => {
    const r = 58, x0 = 70 + r * Math.cos(a(v0)), y0 = 70 - r * Math.sin(a(v0)), x1 = 70 + r * Math.cos(a(v1)), y1 = 70 - r * Math.sin(a(v1));
    return `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}" stroke="${col}" stroke-width="14" fill="none"/>`;
  };
  const n = a(load), nx = 70 + 50 * Math.cos(n), ny = 70 - 50 * Math.sin(n);
  const label = !automated ? 'NO CREW' : load > 1.25 ? 'OVERLOADED' : load > 1 ? 'BUSY' : load < 0.45 ? 'IDLE' : 'HUMMING';
  return `<svg class="dial" viewBox="0 0 140 92" role="img" aria-label="Kitchen load ${Math.round(load * 100)}%: ${label.toLowerCase()}">
    ${arc(0, 0.45, '#b9c4d6')}${arc(0.45, 1, '#46702f')}${arc(1, 1.25, '#c99a3c')}${arc(1.25, 2, '#b82d25')}
    <line x1="70" y1="70" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#1f1b17" stroke-width="4" stroke-linecap="round"/>
    <circle cx="70" cy="70" r="7" fill="#1f1b17"/><text x="70" y="90" text-anchor="middle" font-size="12" font-weight="900" fill="#1f1b17">${label} · ${Math.round(load * 100)}%</text></svg>`;
}

function pnlChart(days: { rev: number; cost: number }[], h = 120, labels: string[] = []): string {
  if (!days.length) return '<div class="muted small chart-empty">The books open after the first full day.</div>';
  const w = 520, pad = 6, n = days.length, bw = (w - pad * 2) / n;
  const mx = Math.max(1, ...days.map((d) => Math.max(d.rev, d.cost)));
  const prof = days.map((d) => d.rev - d.cost);
  const lo = Math.min(0, ...prof), hi = mx, y = (v: number) => pad + (h - 26) * (1 - (v - lo) / (hi - lo || 1));
  const bars = days.map((d, i) => {
    const x = pad + i * bw;
    return `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${y(d.rev).toFixed(1)}" width="${(bw * 0.36).toFixed(1)}" height="${Math.max(0, y(0) - y(d.rev)).toFixed(1)}" fill="#4d7d33" stroke="#1f1b17" stroke-width="2"/>
      <rect x="${(x + bw * 0.5).toFixed(1)}" y="${y(d.cost).toFixed(1)}" width="${(bw * 0.36).toFixed(1)}" height="${Math.max(0, y(0) - y(d.cost)).toFixed(1)}" fill="#ea9a8f" stroke="#1f1b17" stroke-width="2"/>
      ${labels[i] ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="12" fill="#5b5047">${labels[i]}</text>` : ''}`;
  }).join('');
  const line = prof.map((p, i) => `${(pad + i * bw + bw / 2).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  return `<svg class="pnl" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Revenue, cost and profit for ${n} days">
    <line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#1f1b17" stroke-width="1"/>${bars}
    <polyline points="${line}" fill="none" stroke="#fcf7ec" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/><polyline points="${line}" fill="none" stroke="#8f6a1f" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ---------------------------------------------------------------- the sheet
export type SheetTab = 'overview' | 'staff' | 'menu' | 'books' | 'format' | 'look';
const TABS: [SheetTab, string, string][] = [
  ['overview', '概', 'Overview'], ['staff', '人', 'Staff'], ['menu', '品', 'Menu & price'],
  ['books', '帳', 'Books'], ['format', '業', 'Format'], ['look', '改', 'Upgrades & look'],
];
const THEMES = ['Classic Wood', 'Sakura Pink', 'Midnight Neon', 'Imperial Gold'];
const COSMETICS: Record<string, { name: string; apply?: { signColor?: string; theme?: number; uniform?: string }; swatch: string }> = {
  sign_gold: { name: 'Gold sign', apply: { signColor: '#c99a3c' }, swatch: '#c99a3c' },
  sign_gold_star: { name: 'Gold-star sign', apply: { signColor: '#ffd23f' }, swatch: '#ffd23f' },
  sign_neon_pink: { name: 'Neon pink sign', apply: { signColor: '#ff3e9a' }, swatch: '#ff3e9a' },
  sign_neon_red: { name: 'Neon red sign', apply: { signColor: '#ff2a2a' }, swatch: '#ff2a2a' },
  sign_neon_rainbow: { name: 'Neon violet sign', apply: { signColor: '#7b5cff' }, swatch: 'linear-gradient(90deg,#ff3e9a,#ffd23f,#3fa7ff,#7b5cff)' },
  sign_diamond: { name: 'Diamond sign', apply: { signColor: '#9fe8ff' }, swatch: '#9fe8ff' },
  sign_laurel: { name: 'Laurel sign', apply: { signColor: '#4f7a35' }, swatch: '#4f7a35' },
  theme_gold_leaf: { name: 'Gold-leaf interior', apply: { theme: 3 }, swatch: 'linear-gradient(135deg,#f3d48a,#c99a3c)' },
  uniform_black: { name: 'Black uniforms', apply: { uniform: '#1f1b17' }, swatch: '#1f1b17' },
  apron_indigo: { name: 'Indigo aprons', apply: { uniform: '#23385c' }, swatch: '#23385c' },
};
const ROLE_LIST: Role[] = ['chef', 'server', 'manager'];
const HEALTH_LABEL = { good: 'Healthy', warn: 'Needs a look', bad: 'In trouble' } as const;

export class Sheet {
  el: HTMLElement;
  id: string;
  tab: SheetTab = 'overview';
  private body: HTMLElement;
  private st: { last?: string } = {};
  private t = 0;
  private pickC: ConceptId | null = null;
  private confirmFire: number | null = null;

  private headSt: { last?: string } = {};
  private armedAt = 0;

  constructor(private host: UIHost, id: string, private close: () => void, private browseLots: () => void = () => {}) {
    this.id = id;
    this.el = el('div', 'modal sheet-wrap');
    this.el.innerHTML = `<aside class="panel sheet"><header class="sheet-head"></header>
      <nav class="sheet-tabs" aria-label="Restaurant sections"><i class="stab-ink" aria-hidden="true"></i>${TABS.map(([t, k, n]) => `<button class="stab" data-tab="${t}"><b aria-hidden="true">${k}</b>${n}</button>`).join('')}</nav>
      <div class="sheet-body" tabindex="0"><div class="sh-content"></div></div></aside>`;
    this.body = this.el.querySelector('.sh-content')!;
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) close(); });
    const nav = this.el.querySelector<HTMLElement>('.sheet-tabs')!;
    nav.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) { audio.sfx('click'); this.show(b.dataset.tab as SheetTab); }
    });
    // the sliding paper key follows the active tab; re-placed whenever a tab's size changes (fonts load, sheet attaches)
    const ro = new ResizeObserver(() => this.placeInk());
    nav.querySelectorAll('.stab').forEach((b) => ro.observe(b));
    this.wire();
    this.show('overview');
  }

  private placeInk(): void {
    const nav = this.el.querySelector<HTMLElement>('.sheet-tabs')!, on = nav.querySelector<HTMLElement>('.stab.on');
    const ink = nav.querySelector<HTMLElement>('.stab-ink')!;
    if (!on || !on.offsetWidth) return;
    ink.style.transform = `translateX(${on.offsetLeft}px)`;
    ink.style.width = `${on.offsetWidth}px`;
    if (!nav.classList.contains('ink-ready')) requestAnimationFrame(() => nav.classList.add('ink-ready')); // no slide on first placement
  }

  private get s() { return this.host.s; }
  private get r() { return this.s.restaurants[this.id]; }

  setRestaurant(id: string, tab?: SheetTab): void { this.id = id; this.pickC = null; this.show(tab ?? this.tab); }

  show(tab: SheetTab): void {
    this.tab = tab;
    this.el.querySelectorAll<HTMLElement>('.stab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    this.st.last = undefined;
    this.confirmFire = null;
    (this.el.querySelector('.sheet-body') as HTMLElement).scrollTop = 0;
    this.render();
    this.placeInk();
    this.body.classList.remove('slide-in'); void this.body.offsetWidth; this.body.classList.add('slide-in');
  }

  update(dt: number): void {
    if (!this.r) { this.close(); return; }
    if ((this.t += dt) < 0.5) return;
    this.t = 0;
    this.render();
  }

  private render(): void {
    const s = this.s, r = this.r;
    if (!r) return;
    const p = PROPERTIES[this.id], a = AREAS[p.district], c = CONCEPTS[r.concept];
    const ids = Object.keys(s.restaurants);
    const i = ids.indexOf(this.id);
    const auto = sim.isAutomated(s, this.id), k = this.kpi();
    const head = this.el.querySelector('.sheet-head') as HTMLElement;
    head.style.setProperty('--fmt', CONCEPT_INK[r.concept]);
    const hl = HEALTH_LABEL[k.health];
    patch(head, `
      <span class="big-seal" aria-hidden="true">${KANJI[r.concept]}</span>
      <div class="sh-title"><h2 id="sheet-title" title="${esc(r.name)}">${esc(r.name)}</h2><div><span class="sh-fmt">${c.name} ${c.jp}</span> ${a.jp} ${esc(a.name)} · ${p.kind}</div></div>
      <div class="sh-badges"><span class="sh-health ${k.health}">${healthSeal(k.health)}<b>${hl}</b></span><span class="sh-status ${auto ? 'ok' : 'no'}">${auto ? '自動 · runs itself' : '手 · needs crew'}</span></div>
      <div class="sh-nav">${ids.length > 1 ? `<button class="sq" data-act="prev" data-arg="p" data-nav="${ids[(i - 1 + ids.length) % ids.length]}" aria-label="Previous restaurant">‹</button><span class="sh-count">${i + 1}<small>/${ids.length}</small></span><button class="sq" data-act="next" data-arg="n" data-nav="${ids[(i + 1) % ids.length]}" aria-label="Next restaurant">›</button>` : ''}
      <button class="x" data-act="close" data-arg="x" aria-label="Close">${icon('close')}</button></div>`, this.headSt);
    const html = (this as any)['r_' + this.tab]() as string;
    patch(this.body, html, this.st);
  }

  private wire(): void {
    const head = this.el.querySelector('.sheet-head') as HTMLElement;
    head.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.x')) { audio.sfx('click'); this.close(); return; }
      const n = t.closest<HTMLElement>('[data-nav]');
      if (n) { audio.sfx('pop'); this.setRestaurant(n.dataset.nav!); }
    });
    const s = () => this.s, id = () => this.id;
    const after = () => { this.st.last = undefined; this.render(); };
    const refreshSoon = (() => { let t = 0; return () => { clearTimeout(t); t = window.setTimeout(() => this.host.refreshWorld(), 350); }; })();
    delegate(this.body, {
      go: (t) => this.show(t as SheetTab),
      fix: (aid, b) => {
        const a = E.alerts(s()).find((x) => x.id === aid);
        const f = a && this.localFix(a);
        if (!f) return after();
        if (s().cash < f.cost) return fail(b, `Need ${yen(f.cost)}`);
        const j = this.juice(b, f.cost ? 12 : 0);
        if (run(b, f.apply(), 'coin')) { after(); j(); }
      },
      lots: () => { this.close(); this.browseLots(); },
      hirebest: (role, b) => { const j = this.juice(b, 14); if (run(b, E.hireBest(s(), id(), role as Role), 'hire')) { after(); j(); } },
      train: (eid, b) => { const j = this.juice(b, 8); if (run(b, A.train(s(), Number(eid)), 'upgrade')) { after(); j(); } },
      fire: (eid, b) => {
        if (this.confirmFire !== Number(eid)) { this.confirmFire = Number(eid); this.armedAt = performance.now(); audio.sfx('click'); return after(); }
        if (performance.now() - this.armedAt < 400) return; // a double-click must not confirm
        this.confirmFire = null; run(b, A.fire(s(), Number(eid)), 'whoosh'); after();
      },
      keep: () => { this.confirmFire = null; audio.sfx('click'); after(); },
      menu: (rc, b) => { if (run(b, A.toggleMenu(s(), id(), rc), 'pop')) after(); },
      pickc: (cid) => { this.pickC = cid as ConceptId; audio.sfx('pop'); after(); },
      convert: (_, b) => {
        if (!this.pickC) return;
        const at = b.getBoundingClientRect();
        if (!run(b, A.setConcept(s(), id(), this.pickC), 'purchase')) return;
        this.pickC = null; after();
        const cur = this.body.querySelector<HTMLElement>('.concept.cur');
        if (cur) punch(cur);
        coinBurst({ x: at.left + at.width / 2, y: at.top + at.height / 2 }, 16);
      },
      upg: (u, b) => {
        const at = b.getBoundingClientRect();
        if (!run(b, A.buyUpgrade(s(), id(), u), 'purchase')) return;
        after(); // re-render first, then punch whatever now stands there (the next level's button, or the maxed card)
        const card = this.body.querySelector<HTMLElement>(`[data-upg="${u}"]`);
        const nb = card?.querySelector<HTMLElement>('[data-act="upg"]') ?? card;
        if (nb) punch(nb);
        coinBurst({ x: at.left + at.width / 2, y: at.top + at.height / 2 }, 12);
      },
      cos: (cid) => {
        const c = COSMETICS[cid];
        if (!c?.apply || !unlockedCosmetics(s()).includes(cid)) return;
        Object.assign(this.r, c.apply); this.host.refreshWorld(); audio.sfx('pop'); after();
      },
      travel: () => { this.close(); this.host.travel(PROPERTIES[id()].district as never); },
    }, {
      price: (v, e) => {
        A.setPrice(s(), id(), Number(v));
        e.setAttribute('aria-valuetext', `price ×${Number(v).toFixed(2)}`);
        const lbl = this.body.querySelector('#sh-price'); if (lbl) lbl.innerHTML = this.priceRead();
      },
      move: (v, e) => { const err = A.assign(s(), Number(e.dataset.id), v || null); if (err) fail(e, err); else audio.sfx('pop'); after(); },
      rname: (v) => { this.r.name = v.slice(0, 30) || PROPERTIES[this.id].name; refreshSoon(); },
      sign: (v) => { this.r.signColor = v; refreshSoon(); },
      uniform: (v) => { this.r.uniform = v; refreshSoon(); },
      theme: (v) => { this.r.theme = Number(v); this.host.refreshWorld(); audio.sfx('pop'); after(); },
    });
  }

  /** Purchase press feedback: remember where the button was, and after the re-render punch whatever now carries the
   *  same action (the patch replaced the element) and burst coins from the old spot. n = 0: punch only. */
  private juice(b: HTMLElement, n: number): () => void {
    const at = b.getBoundingClientRect(), key = `[data-act="${b.dataset.act}"][data-arg="${CSS.escape(b.dataset.arg ?? '')}"]`;
    return () => {
      const nb = this.body.querySelector<HTMLElement>(key);
      if (nb) punch(nb);
      if (n) coinBurst({ x: at.left + at.width / 2, y: at.top + at.height / 2 }, n);
    };
  }

  private best(role: Role) { return this.s.candidates.filter((e) => e.role === role).sort((x, y) => y.skill - x.skill)[0]; }

  /** What hireBest will charge for this role: the best applicant, else a fresh walk-in of random skill, so the
   *  worst case (skill 5 = ×2.2, as empire.ts prices it). */
  private bestCost(role: Role): number {
    const c = this.best(role);
    return c ? sim.hireCost(c) : Math.round(ROLES[role].hireCost * 2.2);
  }

  /** Honest hire label: "★3 · ¥4,800" for the applicant hireBest takes, "up to ¥X" when it must hire a walk-in. */
  private hireLabel(role: Role): string {
    const c = this.best(role);
    return c ? `${icon('star', 14)}${c.skill} · ${yen(sim.hireCost(c))}` : `up to ${yen(this.bestCost(role))}`;
  }

  /** What an alert's fix does for THIS restaurant: true cost and action. */
  private localFix(a: E.Alert): { label: string; cost: number; apply: () => string | null } | null {
    if (!a.fix) return null;
    const s = this.s, id = this.id, best = (role: Role) => this.bestCost(role);
    switch (a.fix.id) {
      case 'hireMissing': {
        const roles: Role[] = [];
        if (!sim.staffAt(s, id, 'chef').length) roles.push('chef');
        if (CONCEPTS[this.r.concept].needsServer && !sim.staffAt(s, id, 'server').length && !sim.staffAt(s, id, 'manager').length) roles.push('server');
        return { label: `Hire best ${roles.join(' + ') || 'crew'}`, cost: roles.reduce((t, r) => t + best(r), 0), apply: () => roles.map((r) => E.hireBest(s, id, r)).find(Boolean) ?? null };
      }
      case 'hireChef': return { label: 'Hire best chef', cost: best('chef'), apply: () => E.hireBest(s, id, 'chef') };
      case 'priceUp': return { label: 'Prices +10%', cost: 0, apply: () => { A.setPrice(s, id, this.r.priceMult * 1.1); return null; } };
      case 'priceDown': return { label: 'Prices −10%', cost: 0, apply: () => { A.setPrice(s, id, this.r.priceMult / 1.1); return null; } };
    }
    return null;
  }

  private kpi() { return E.restaurantKPIs(this.s).find((k) => k.id === this.id)!; }

  // ------------------------------------------------------------ overview
  r_overview(): string {
    const s = this.s, r = this.r, k = this.kpi(), p = PROPERTIES[this.id];
    const al = E.alerts(s).filter((a) => a.restIds.includes(this.id));
    const days = r.hist.slice(-7);
    const rv = s.reviews?.[this.id] ?? [];
    const here = AREAS[p.district].walkable && s.player.district !== p.district;
    const py = k.profitYesterday;
    const kpi = (cls: string, label: string, val: string, sub: string) => `<div class="ov-kpi ${cls}"><span>${label}</span>${val}<small>${sub}</small></div>`;
    return `<div class="ov-top">
        <div class="ov-dial">${dial(k.load, k.automated)}<div class="tiny muted">Kitchen load at the lunch peak</div></div>
        <div class="ov-kpis">
          ${kpi('p-money', 'Today', `<b class="num">${yen(r.day.rev)}</b>`, `${exact(r.day.guests)} guests · ${exact(r.day.pieces)} pcs`)}
          ${kpi('p-money', 'Yesterday', `<b class="num ${py === null ? '' : py < 0 ? 'bad' : 'good'}">${py === null ? '—' : `${py < 0 ? '−' : '+'}${yen(Math.abs(py))}`}</b>`, py === null ? 'opens after the first close' : 'operating profit')}
          ${kpi('p-info', 'Stars', `<b class="num gold">${r.reputation.toFixed(1)}</b>`, stars(r.reputation))}
          ${kpi(r.day.lost ? 'p-danger' : 'p-info', 'Turned away', `<b class="num ${r.day.lost ? 'bad' : ''}">${exact(r.day.lost)}</b>`, 'guests today')}
        </div></div>
      ${k.managed ? `<div class="section slip calm"><span class="sev">${icon('check')}</span><span class="txt">Managed: auto-hires &amp; sets prices.</span></div>`
        : `<div class="section slip"><span class="sev">${icon('team')}</span><span class="txt">You hire and set prices here. Hire a manager and this place runs itself.</span><button class="btn small brand" data-act="go" data-arg="staff">${icon('team', 16)} Staff</button></div>`}
      ${al.length ? `<div class="section slips">${al.map((a) => `<div class="slip ${a.severity}"><span class="sev">${a.severity === 'critical' ? '急' : a.severity === 'warning' ? '注' : '機'}</span><span class="txt">${esc(a.text)}</span>
        ${(() => { const f = this.localFix(a); return f ? `<button class="btn small ${f.cost ? 'primary' : ''}" data-act="fix" data-arg="${a.id}">${esc(f.label)}${f.cost ? ` · ${yen(f.cost)}` : ''}</button>` : ''; })()}
</div>`).join('')}</div>`
        : '<div class="section slip calm"><span class="sev">安</span><span class="txt">All quiet here. Nothing needs you.</span></div>'}
      <section class="section panel p-money ov-panel"><div class="seal-h">${icon('chart', 28, { variant: 'seal' })}<h3>Last 7 days</h3><span class="ov-legend"><span><i class="rev"></i>Revenue</span><span><i class="cost"></i>Cost</span><span><i class="prof"></i>Profit</span></span></div>
        <div class="ov-chart">${pnlChart(days, 110, days.map((d) => 'D' + d.day))}</div></section>
      ${here ? `<div class="section"><button class="btn brand" data-act="travel">${icon('train', 16)} Ride the metro to ${esc(AREAS[p.district].name)} and walk in</button></div>` : ''}
      <section class="section panel p-info ov-panel"><div class="seal-h">${icon('note', 28, { variant: 'seal' })}<h3>Reviews <span class="ja">口コミ</span></h3><span class="chip">${rv.length} review${rv.length === 1 ? '' : 's'}</span></div>
        <div class="reviews">
        <div class="score"><b class="num lg gold">${rv.length ? averageStars(rv).toFixed(2) : '—'}</b>${stars(averageStars(rv))}</div>
        <div class="rv-list">${rv.length ? rv.slice(0, 3).map((x) => `<div class="rv"><div class="spread"><b>${esc(x.author)}</b><span>${stars(x.stars)} <span class="tiny muted">Day ${x.day}</span></span></div><p>${esc(x.text)}</p></div>`).join('')
          : '<div class="muted small">No reviews yet.</div>'}</div></div></section>`;
  }

  // ------------------------------------------------------------ staff
  r_staff(): string {
    const s = this.s, m = sim.mods(s);
    const rows = ROLE_LIST.map((role) => {
      const team = sim.staffAt(s, this.id, role), slots = sim.slotsFor(s, this.id, role);
      if (!slots && !team.length) return `<div class="role-row none">${icon(ROLES[role].icon, 24)}<b>${ROLES[role].name}</b><span class="muted small">Not needed in this format</span></div>`;
      const locked = s.lifetime.pieces < ROLES[role].unlockPieces;
      const owned = Object.keys(s.restaurants);
      const people = team.map((e) => {
        const tc = Math.round(trainCost(e.role, e.skill) * m.trainCost), armed = this.confirmFire === e.id, master = e.skill >= MAX_SKILL;
        const xp = master ? 1 : Math.min(1, e.xp / (20 * e.skill * e.skill));
        return `<div class="person ${armed ? 'armed' : ''}"><b class="p-name">${esc(e.name)}</b><span class="lvl" title="Skill ${e.skill} of ${MAX_SKILL}">${icon('star', 14)}${e.skill}</span>
          <span class="meter sm" title="${master ? 'Master' : `Experience ${Math.round(xp * 100)}%`}"><i style="width:${(xp * 100).toFixed(0)}%"></i></span>
          <span class="chip wage">${yen(e.wage)}/day</span>
          <span class="acts">${armed ? `<span class="fire-q" role="alert">Fire ${esc(e.name.split(' ')[0])}? They leave the company for good.</span>
            <button class="btn small ghost" data-act="keep" data-arg="${e.id}">Keep</button>
            <button class="btn small danger confirm fire armed" data-act="fire" data-arg="${e.id}" aria-label="Confirm: fire ${esc(e.name)}">${icon('warn', 14)} Yes, fire</button>`
          : `<button class="btn small primary ${!master && this.s.cash < tc ? 'poor' : ''}" data-act="train" data-arg="${e.id}" ${master ? 'disabled' : ''}>${master ? 'Master' : `${icon('up', 14)} Train · ${yen(tc)}`}</button>
          <select data-in="move" data-id="${e.id}" aria-label="Move ${esc(e.name)}">${owned.map((o) => `<option value="${o}" ${o === this.id ? 'selected' : ''}>${o === this.id ? 'Stays here' : 'Move → ' + esc(s.restaurants[o].name)}</option>`).join('')}<option value="">Send to reserve</option></select>
          <button class="btn small danger fire" data-act="fire" data-arg="${e.id}" aria-label="Fire ${esc(e.name)}">${icon('warn', 14)} Fire</button>`}</span></div>`;
      }).join('');
      const empty = Math.max(0, slots - team.length);
      const hireBtn = locked ? `<span class="chip">${icon('lock', 14)} at ${exact(ROLES[role].unlockPieces)} pieces</span>`
        : `<button class="btn small primary" data-act="hirebest" data-arg="${role}" aria-label="Hire the best ${ROLES[role].name.toLowerCase()} applicant">Hire best ${this.hireLabel(role)}</button>`;
      return `<section class="role-row panel p-staff"><div class="seal-h">${icon(ROLES[role].icon, 28, { variant: 'seal' })}<h3>${ROLES[role].name}</h3>
          <span class="slots" title="${team.length} of ${slots} slots filled">${'<i class="f"></i>'.repeat(team.length)}${'<i></i>'.repeat(empty)}<small>${team.length}/${slots}</small></span>${empty ? hireBtn : ''}</div>
        <div class="people">${people || '<span class="muted small">Nobody yet.</span>'}</div></section>`;
    }).join('');
    // the one obvious next hire: a chef (nothing sells without one), then a server if the chef is cooking alone.
    // hireBest takes the most skilled applicant (not the cheapest), so the label says "best" and shows that applicant's fee
    const next: Role | null = !sim.staffAt(s, this.id, 'chef').length ? 'chef' : sim.understaffed(s, this.id) ? 'server' : null;
    const hero = next && s.lifetime.pieces >= ROLES[next].unlockPieces ? `<div class="hire-next panel p-staff">${icon(next, 40, { variant: 'seal' })}<span class="txt"><b>${next === 'chef' ? 'You need a chef' : 'You need a server'}</b>
        <small>${next === 'chef' ? 'Nothing sells without a chef. Once one is on shift, guests start buying.' : 'Your chef is taking orders alone and cooks at half pace. A server fixes that.'}</small></span>
        <button class="btn big primary" data-act="hirebest" data-arg="${next}">Hire best ${next} · ${this.best(next) ? yen(this.bestCost(next)) : `up to ${yen(this.bestCost(next))}`}</button></div>` : '';
    return `${hero}<p class="small muted st-intro">${CONCEPTS[this.r.concept].needsServer ? 'A chef cooks; a server takes orders.' : 'Ghost kitchens only need chefs.'} A manager runs the place for you: hires staff and sets prices.</p>${rows}`;
  }

  // ------------------------------------------------------------ menu & price
  private priceRead(): string {
    const s = this.s, r = this.r, k = this.kpi();
    const dem = E.demandPPS(s, this.id), cap = k.load > 0 ? dem / k.load : 0;
    const el2 = AREAS[PROPERTIES[this.id].district].elasticity * CONCEPTS[r.concept].elasticity;
    return `<div class="pr-read"><div><span>Price</span><b class="num">×${r.priceMult.toFixed(2)}</b></div><div><span>Demand</span><b class="num">${dem.toFixed(1)}<small> pcs/s</small></b></div>
      <div><span>Kitchen</span><b class="num">${cap.toFixed(1)}<small> pcs/s</small></b></div><div class="verdict ${k.load > 1 || !k.automated ? 'bad' : 'good'}"><span>Verdict</span><b>${!k.automated ? 'No crew' : k.load > 1.1 ? 'Turning guests away' : k.load < 0.6 ? 'Seats to spare' : 'Well balanced'}</b></div></div>
      <div class="tiny muted">Guests here are ${el2 < 0.9 ? 'barely' : el2 > 1.4 ? 'very' : 'fairly'} price-sensitive. Bills also include the format's ×${CONCEPTS[r.concept].price} price level.</div>`;
  }

  r_menu(): string {
    const s = this.s, r = this.r, m = sim.mods(s), lvl = CONCEPTS[r.concept].price;
    const card = (id: string) => {
      const rc = RECIPES[id], on = r.menu.includes(id), price = rc.price * r.priceMult * lvl, cost = recipeCost(rc, m.ingredientCost);
      return `<button class="mi ${on ? 'on' : ''}" data-act="menu" data-arg="${id}" aria-pressed="${on}"><span class="tick">${on ? icon('check', 14) : ''}</span>
        <b>${esc(rc.name)}</b><small>${rc.jp} · ${Object.keys(rc.ingredients).map((k) => ingIcon(k)).join('')}</small>
        <span class="mg">${yen(price)} <i>−${yen(cost)}</i> <em class="${price - cost > 0 ? 'good' : 'bad'}">${price - cost < 0 ? '−' : '+'}${yen(Math.abs(price - cost))}</em></span></button>`;
    };
    // legacy limited-time recipes stay in RECIPES so old saves load: list only what the player has or can still earn
    const earnable = new Set([...Array.from({ length: 20 }, (_, i) => milestone(i).reward.recipe), ...Object.values(RESEARCH).map((q) => q.unlockRecipe)]);
    const perm = Object.keys(RECIPES).filter((x) => s.recipes.includes(x) || earnable.has(x));
    const have = perm.filter((x) => s.recipes.includes(x)).map((x) => card(x)).join('');
    const locked = perm.filter((x) => !s.recipes.includes(x)).map((x) => {
      const res = Object.values(RESEARCH).find((q) => q.unlockRecipe === x);
      return `<div class="mi locked"><b>${icon('lock', 13)} ${esc(RECIPES[x].name)}</b><small>${res ? 'Research: ' + res.name : 'Milestone reward'}</small></div>`;
    }).join('');
    return `<section class="panel p-money mn-panel"><div class="seal-h">${icon('yen', 28, { variant: 'seal' })}<h3>Price <span class="ja">値段</span></h3></div>
        <div class="mn-in"><input type="range" min="0.6" max="2.5" step="0.05" value="${r.priceMult}" data-in="price" aria-label="Price multiplier" aria-valuetext="price ×${r.priceMult.toFixed(2)}">
        <div id="sh-price">${this.priceRead()}</div></div></section>
      <section class="section panel p-upgrade mn-panel"><div class="seal-h">${icon('nigiri', 28, { variant: 'seal' })}<h3>Menu <span class="ja">品書き</span></h3><span class="chip">${r.menu.length} on the menu</span></div>
        <div class="mn-in"><p class="tiny muted mn-hint">Tap a dish to put it on or take it off. Price − ingredient cost = margin per piece.</p><div class="mgrid">${have}</div></div></section>
      ${locked ? `<div class="section"><h3 class="muted">Not yet</h3><div class="mgrid">${locked}</div></div>` : ''}`;
  }

  // ------------------------------------------------------------ books
  // Operating books only (ingredients + wages + rent). Wages and rent are charged at closing (sim.endDay), so the
  // open day adds tonight's bill up front; otherwise "Today" looks wildly profitable and then drops at midnight.
  // Every figure is floored once per row and totals are sums of the shown rows, so the columns always add up.
  r_books(): string {
    const s = this.s, r = this.r;
    const due = sim.staffAt(s, this.id).reduce((a, e) => a + e.wage, 0) + sim.restaurantRent(s, this.id);
    const row = (d: RestDay, extra = 0) => { const rev = Math.floor(d.rev), cost = Math.floor(d.cost + extra); return { d, rev, cost, p: rev - cost }; };
    const today = row(r.day, due), past = r.hist.map((d) => row(d));
    const tot = past.reduce((a, x) => ({ g: a.g + x.d.guests, pcs: a.pcs + x.d.pieces, lost: a.lost + x.d.lost, rev: a.rev + x.rev, cost: a.cost + x.cost, p: a.p + x.p }), { g: 0, pcs: 0, lost: 0, rev: 0, cost: 0, p: 0 });
    const signed = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}¥${exact(Math.abs(v))}`;
    const pc = (v: number) => (v < 0 ? 'bad' : 'good');
    const cells = (x: { rev: number; cost: number; p: number }) => `<td class="m">¥${exact(x.rev)}</td><td class="m cost">−¥${exact(x.cost)}</td><td class="m ${pc(x.p)}">${signed(x.p)}</td>`;
    const tr = (x: ReturnType<typeof row>, label: string, cls = '') => `<tr class="${cls}"><td>${label}</td><td>${exact(x.d.guests)}</td><td>${exact(x.d.pieces)}</td><td class="${x.d.lost ? 'bad' : ''}">${exact(x.d.lost)}</td>${cells(x)}</tr>`;
    const last = past[past.length - 1];
    const kpi = (label: string, v: number | null, sub: string) => `<div><span>${label}</span><b class="num ${v === null ? 'ink' : pc(v)}">${v === null ? '—' : signed(v)}</b><small>${sub}</small></div>`;
    return `<section class="panel p-money books-panel"><div class="seal-h">${icon('receipt', 28, { variant: 'seal' })}<h3>Books 帳簿</h3><span class="chip">operating profit</span></div>
      <div class="bk-kpis">${kpi('Today so far', today.p, `after ¥${exact(due)} wages + rent due tonight`)}${kpi('Last closed day', last ? last.p : null, last ? `Day ${last.d.day}` : 'no closed day yet')}${kpi(`${past.length}-day total`, past.length ? tot.p : null, past.length ? `${exact(tot.g)} guests` : 'opens after closing')}</div>
      <div class="bk-chart">${pnlChart(r.hist, 130, r.hist.map((d) => 'D' + d.day))}${r.hist.length ? '<div class="bk-legend"><span><i style="background:#4d7d33"></i>Revenue</span><span><i style="background:#ea9a8f"></i>Operating cost</span><span><i style="background:#8f6a1f"></i>Profit</span></div>' : ''}</div>
      <div class="bk-table"><table class="books"><thead><tr><th>Day</th><th>Guests</th><th>Pieces</th><th>Lost</th><th>Revenue</th><th>Op. cost</th><th>Op. profit</th></tr></thead>
      <tbody>${tr(today, `Today<small>so far, incl. tonight's ¥${exact(due)}</small>`, 'today')}${past.slice().reverse().map((x) => tr(x, 'Day ' + x.d.day)).join('')}</tbody>
      ${past.length ? `<tfoot><tr><td>${past.length} closed day${past.length === 1 ? '' : 's'}</td><td>${exact(tot.g)}</td><td>${exact(tot.pcs)}</td><td class="${tot.lost ? 'bad' : ''}">${exact(tot.lost)}</td>${cells(tot)}</tr></tfoot>` : ''}</table>
      <p class="bk-note"><b>Op. cost</b> = ingredients used + this location's wages + rent (billed at closing). One-off spending such as hires, training, upgrades and refits is <b>investment</b>, not cost: it's tracked empire-wide in Manage → Finances. Totals and the chart cover closed days only. Lifetime here: ${exact(r.served)} guests, ${yen(r.revenue)} revenue.</p></div></section>`;
  }

  // ------------------------------------------------------------ format
  r_format(): string {
    const s = this.s, r = this.r, pick = this.pickC && this.pickC !== r.concept ? this.pickC : null;
    const why = pick ? A.conceptAllowed(s, this.id, pick) : null, cost = pick ? A.fitoutCost(this.id, pick) : 0;
    if (PROPERTIES[this.id].kind === 'stand') return `<div class="slip opportunity"><span class="sev">屋</span><span class="txt">Stands stay stands: a street-stand lot only fits a yatai. To run a kiosk, kaiten belt, omakase room or ghost kitchen, buy a proper lot and pick its format there.</span><button class="btn small" data-act="lots">Browse lots</button></div>
      <div class="concepts section">${conceptCards(s, this.id, r.concept, 'switch')}</div>`;
    const c = pick ? CONCEPTS[pick] : null;
    const bumped = pick ? (['chef', 'server'] as Role[]).map((role) => {
      const have = sim.staffAt(s, this.id, role).length;
      const slots = role === 'chef' ? Math.max(1, Math.round(sim.chefSlots(s, this.id) * c!.staff)) : c!.needsServer ? PROPERTIES[this.id].serverSlots : 0;
      return have > slots ? `${have - slots} ${role}${have - slots > 1 ? 's' : ''} → reserve at half wage` : '';
    }).filter(Boolean) : [];
    return `<p class="fmt-note">Switching format refits the place: staff, upgrades and reputation stay. ${pick ? `As a ${c!.name}, rent would be <b>${yen(Math.round(PROPERTIES[this.id].rent * c!.rent))}/day</b>${bumped.length ? `; <b>${bumped.join(', ')}</b>` : '; nobody is moved'}.` : `Rent today: <b>${yen(sim.restaurantRent(s, this.id))}/day</b>. Pick a format to compare.`}</p>
      <div class="concepts">${conceptCards(s, this.id, pick ?? r.concept, 'switch')}</div>
      ${pick ? `<div class="buybar"><span>Convert to <b>${CONCEPTS[pick].name}</b> for <b>${yen(cost)}</b><small>${esc(CONCEPTS[pick].desc)}</small></span><button class="btn big primary ${!why && s.cash < cost ? 'poor' : ''}" data-act="convert" ${why ? 'disabled' : ''}>${why ? esc(why) : 'Refit 改装'}</button></div>` : ''}`;
  }

  // ------------------------------------------------------------ upgrades & look
  r_look(): string {
    const s = this.s, r = this.r, id = this.id;
    const upg = Object.values(UPGRADES).map((u) => {
      const lvl = r.upgrades[u.id] ?? 0, mx = A.upgradeMax(id, u.id), maxed = lvl >= mx, cost = A.upgradePrice(s, id, u.id);
      return `<div class="card p-upgrade upg ${maxed ? 'done' : ''}" data-upg="${u.id}"><div class="upg-h">${icon(u.icon, 30, { variant: 'seal' })}<b>${u.name}</b></div>
        <div class="upg-lv">${pips(lvl, mx)}<span>Lv ${lvl}/${mx}</span></div>
        <p class="upg-d">${u.desc}</p>
        ${maxed ? `<span class="chip p-upgrade max">${icon('check', 14)} Maxed out</span>` : `<button class="btn primary small ${s.cash >= cost ? '' : 'poor'}" data-act="upg" data-arg="${u.id}">${icon('up', 16)} Upgrade · ${cost < 1e5 ? yenExact(cost) : yen(cost)}</button>`}</div>`;
    }).join('');
    const owned = unlockedCosmetics(s);
    const extras = Object.entries(COSMETICS).map(([cid, c]) => owned.includes(cid)
      ? `<button class="cos" data-act="cos" data-arg="${cid}"><i style="background:${c.swatch}"></i>${esc(c.name)}</button>`
      : `<span class="cos locked" title="Unlock through an achievement"><i></i>???</span>`).join('');
    return `<div class="upg-grid">${upg}</div>
      <section class="section panel p-info look-panel"><div class="seal-h">${icon('pencil', 28, { variant: 'seal' })}<h3>Look <span class="ja">装い</span></h3><span class="chip">${short(r.served)} guests served</span></div>
        <div class="look-in"><div class="look-fields">
        <label class="field look-name">Restaurant name<input type="text" maxlength="30" value="${esc(r.name)}" data-in="rname"></label>
        <label class="field">Sign colour<input type="color" value="${r.signColor}" data-in="sign"></label>
        <label class="field">Uniforms<input type="color" value="${r.uniform}" data-in="uniform"></label>
        <label class="field">Interior theme<select data-in="theme">${THEMES.map((t, i) => `<option value="${i}" ${r.theme === i ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
        <div class="look-extras"><b>Unlocked extras</b> <span class="tiny muted">earned from achievements</span><div class="cos-row">${extras}</div></div>
        <p class="tiny muted look-note">${AREAS[PROPERTIES[id].district].walkable ? 'Changes show up in the 3D street.' : 'This area is run from the books; its look lives in your guests\' imagination.'}</p></div></section>`;
  }
}
