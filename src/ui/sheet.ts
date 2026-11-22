// Restaurant altitude: a side sheet for one location (overview, staff, menu & price, house rules, books, format,
// upgrades & look) plus the shared format (concept) cards used by the buy-lot dialog.
import { audio } from '../audio/audio';
import * as A from '../core/actions';
import { unlockedCosmetics } from '../core/achievements';
import {
  AREAS, CONCEPTS, CONCEPT_IDS, ConceptId, MAX_SKILL, PROPERTIES, RECIPES, RESEARCH, ROLES, Role, UPGRADES, recipeCost, trainCost,
} from '../core/data';
import * as E from '../core/empire';
import { exact, short, yen, yenExact } from '../core/format';
import { averageStars } from '../core/reviews';
import { SEASONAL_RECIPES, season, seasonalRecipes } from '../core/seasons';
import * as sim from '../core/sim';
import { GameState, RestDay } from '../core/state';
import { bar, delegate, el, esc, fail, ingIcon, patch, pips, run, stars } from './dom';
import { UIHost } from './host';

// ---------------------------------------------------------------- shared: formats
export const CONCEPT_INK: Record<ConceptId, string> = { stand: '#b82d25', kiosk: '#a8741c', bar: '#23385c', kaiten: '#46702f', omakase: '#1f1b17', ghost: '#5a3f7a' };
const KANJI: Record<ConceptId, string> = { stand: '屋', kiosk: '持', bar: '寿', kaiten: '回', omakase: '任', ghost: '配' };

/** Plain-language trade-offs, derived from the numbers (the Sushi Bar is the 1.0 baseline). */
export function conceptTraits(c: (typeof CONCEPTS)[ConceptId]): { pro: string[]; con: string[] } {
  const pro: string[] = [], con: string[] = [];
  const pct = (v: number) => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}%`;
  if (c.traffic > 1.05) pro.push(`${pct(c.traffic)} guests`); else if (c.traffic < 0.95) con.push(`${pct(c.traffic)} guests`);
  if (c.price > 1.05) pro.push(`Bills ×${c.price}`); else if (c.price < 0.95) con.push(`Bills ×${c.price}`);
  if (c.elasticity < 0.9) pro.push('Guests shrug at prices'); else if (c.elasticity > 1.1) con.push('Price-sensitive guests');
  if (c.cook > 1.05) pro.push(`${pct(c.cook)} kitchen speed`); else if (c.cook < 0.95) con.push(`${pct(c.cook)} kitchen speed`);
  if (c.quality > 0.01) pro.push(`+${Math.round(c.quality * 100)} quality`); else if (c.quality < -0.01) con.push(`${Math.round(c.quality * 100)} quality`);
  if (c.rent < 0.95) pro.push(`Rent ${pct(c.rent)}`); else if (c.rent > 1.05) con.push(`Rent ${pct(c.rent)}`);
  if (c.staff > 1.05) pro.push(`Chef slots ×${c.staff}`); else if (c.staff < 0.95) con.push(`Chef slots ×${c.staff}`);
  if (!c.needsServer) pro.push('No servers needed');
  if (!c.walkIn) con.push('Delivery only: no walk-ins');
  return { pro, con };
}

const meter = (label: string, v: number, lo: number, hi: number, invert = false) => {
  const f = Math.max(0.06, Math.min(1, (v - lo) / (hi - lo)));
  return `<div class="cm"><span>${label}</span><i><b style="width:${(invert ? 1.06 - f : f) * 100}%"></b></i></div>`;
};

/** Format cards. mode 'buy' shows lot price + fit-out; 'switch' shows fit-out only and marks the current format. */
export function conceptCards(s: GameState, propId: string, selected: ConceptId | null, mode: 'buy' | 'switch'): string {
  const lot = PROPERTIES[propId];
  const current = s.restaurants[propId]?.concept;
  return CONCEPT_IDS.map((id) => {
    const c = CONCEPTS[id];
    const why = A.conceptAllowed(s, propId, id);
    const fit = A.fitoutCost(propId, id);
    const total = (mode === 'buy' ? lot.price : 0) + fit;
    const { pro, con } = conceptTraits(c);
    const isCur = mode === 'switch' && current === id;
    const fitsLot = (lot.kind === 'stand') === (id === 'stand');
    if (!fitsLot) return '';
    return `<button class="concept ${selected === id ? 'sel' : ''} ${why ? 'locked' : ''} ${isCur ? 'cur' : ''}" style="--ink:${CONCEPT_INK[id]}" data-act="pickc" data-arg="${id}" aria-pressed="${selected === id}" ${why && !isCur ? 'aria-disabled="true"' : ''}>
      <span class="c-seal" aria-hidden="true">${KANJI[id]}</span>
      <span class="c-name"><b>${c.name}</b><small>${c.jp}</small></span>
      <span class="c-desc">${esc(c.desc)}</span>
      <span class="c-meters">${meter('Guests', c.traffic, 0.3, 1.8)}${meter('Price level', c.price, 0.6, 2.7)}${meter('Kitchen', c.cook, 0.6, 1.5)}${meter('Quality', c.quality, -0.1, 0.14)}${meter('Rent', c.rent, 0.4, 1.3, true)}${meter('Chef slots', c.staff, 0.6, 1.6)}</span>
      <span class="c-traits">${pro.map((p) => `<i class="pro">${p}</i>`).join('')}${con.map((p) => `<i class="con">${p}</i>`).join('')}</span>
      <span class="c-cost">${isCur ? '<em>Current format</em>' : why ? `<em class="lock">${esc(why)}</em>` : `<b>${yen(total)}</b>${mode === 'buy' && fit ? `<small>lot ${yen(lot.price)} + fit-out ${yen(fit)}</small>` : mode === 'buy' ? '<small>no fit-out</small>' : '<small>fit-out</small>'}`}</span>
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
    return `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${y(d.rev).toFixed(1)}" width="${(bw * 0.36).toFixed(1)}" height="${Math.max(0, y(0) - y(d.rev)).toFixed(1)}" fill="#23385c"/>
      <rect x="${(x + bw * 0.5).toFixed(1)}" y="${y(d.cost).toFixed(1)}" width="${(bw * 0.36).toFixed(1)}" height="${Math.max(0, y(0) - y(d.cost)).toFixed(1)}" fill="#b82d25"/>
      ${labels[i] ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="12" fill="#5b5047">${labels[i]}</text>` : ''}`;
  }).join('');
  const line = prof.map((p, i) => `${(pad + i * bw + bw / 2).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  return `<svg class="pnl" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Revenue, cost and profit for ${n} days">
    <line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#1f1b17" stroke-width="1"/>${bars}
    <polyline points="${line}" fill="none" stroke="#c99a3c" stroke-width="3" stroke-linejoin="round"/></svg>`;
}

// ---------------------------------------------------------------- the sheet
export type SheetTab = 'overview' | 'staff' | 'menu' | 'rules' | 'books' | 'format' | 'look';
const TABS: [SheetTab, string, string][] = [
  ['overview', '概', 'Overview'], ['staff', '人', 'Staff'], ['menu', '品', 'Menu & price'], ['rules', '掟', 'House rules'],
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
const ROLE_LIST: Role[] = ['chef', 'server', 'cleaner', 'manager'];

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
      <nav class="sheet-tabs" aria-label="Restaurant sections">${TABS.map(([t, k, n]) => `<button class="stab" data-tab="${t}"><b aria-hidden="true">${k}</b>${n}</button>`).join('')}</nav>
      <div class="sheet-body" tabindex="0"><div class="sh-content"></div></div></aside>`;
    this.body = this.el.querySelector('.sh-content')!;
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) close(); });
    this.el.querySelector('.sheet-tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) { audio.sfx('click'); this.show(b.dataset.tab as SheetTab); }
    });
    this.wire();
    this.show('overview');
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
    (this.el.querySelector('.sheet-body') as HTMLElement).scrollTop = 0;
    this.render();
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
    const auto = sim.isAutomated(s, this.id);
    patch(this.el.querySelector('.sheet-head') as HTMLElement, `
      <span class="big-seal" style="--ink:${CONCEPT_INK[r.concept]}" aria-hidden="true">${KANJI[r.concept]}</span>
      <div class="sh-title"><h2 id="sheet-title" title="${esc(r.name)}">${esc(r.name)}</h2><div>${a.jp} ${esc(a.name)} · ${c.name} ${c.jp} · ${p.kind}</div></div>
      <span class="sh-status ${auto ? 'ok' : 'no'}">${auto ? '自動 · runs itself' : '手 · needs crew'}</span>
      <div class="sh-nav">${ids.length > 1 ? `<button class="sq" data-act="prev" data-arg="p" data-nav="${ids[(i - 1 + ids.length) % ids.length]}" aria-label="Previous restaurant">‹</button><span class="tiny">${i + 1}/${ids.length}</span><button class="sq" data-act="next" data-arg="n" data-nav="${ids[(i + 1) % ids.length]}" aria-label="Next restaurant">›</button>` : ''}
      <button class="x" data-act="close" data-arg="x" aria-label="Close">✕</button></div>`, this.headSt);
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
        if (run(b, f.apply(), 'coin')) after();
      },
      lots: () => { this.close(); this.browseLots(); },
      hirebest: (role, b) => { if (run(b, E.hireBest(s(), id(), role as Role), 'coin')) after(); },
      train: (eid, b) => { if (run(b, A.train(s(), Number(eid)), 'upgrade')) after(); },
      fire: (eid, b) => {
        if (this.confirmFire !== Number(eid)) { this.confirmFire = Number(eid); this.armedAt = performance.now(); audio.sfx('click'); return after(); }
        if (performance.now() - this.armedAt < 400) return; // a double-click must not confirm
        this.confirmFire = null; run(b, A.fire(s(), Number(eid)), 'whoosh'); after();
      },
      menu: (rc, b) => { if (run(b, A.toggleMenu(s(), id(), rc), 'pop')) after(); },
      rule: (k, b) => {
        const key = k as 'autoHire' | 'autoPrice';
        if (run(b, A.setPolicy(s(), id(), key, !this.r.policy[key]), 'pop')) after();
      },
      pickc: (cid) => { this.pickC = cid as ConceptId; audio.sfx('pop'); after(); },
      convert: (_, b) => { if (this.pickC && run(b, A.setConcept(s(), id(), this.pickC), 'fanfare')) { this.pickC = null; after(); } },
      upg: (u, b) => { if (run(b, A.buyUpgrade(s(), id(), u), 'upgrade')) after(); },
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

  /** What an alert's fix does for THIS restaurant: true cost and action. Restock is empire-wide by nature. */
  private localFix(a: E.Alert): { label: string; cost: number; apply: () => string | null } | null {
    if (!a.fix) return null;
    const s = this.s, id = this.id;
    const best = (role: Role) => { const c = s.candidates.filter((e) => e.role === role).sort((x, y) => y.skill - x.skill)[0]; return c ? sim.hireCost(c) : ROLES[role].hireCost; };
    switch (a.fix.id) {
      case 'restock': return { label: `${a.fix.label} for all kitchens`, cost: a.fix.cost, apply: () => E.applyFix(s, a) };
      case 'hireMissing': {
        const roles: Role[] = [];
        if (!sim.staffAt(s, id, 'chef').length) roles.push('chef');
        if (CONCEPTS[this.r.concept].needsServer && !sim.staffAt(s, id, 'server').length && !sim.staffAt(s, id, 'manager').length) roles.push('server');
        return { label: `Hire ${roles.join(' + ') || 'crew'}`, cost: roles.reduce((t, r) => t + best(r), 0), apply: () => roles.map((r) => E.hireBest(s, id, r)).find(Boolean) ?? null };
      }
      case 'hireChef': return { label: 'Hire a chef', cost: best('chef'), apply: () => E.hireBest(s, id, 'chef') };
      case 'hireCleaner': return { label: 'Hire a cleaner', cost: best('cleaner'), apply: () => E.hireBest(s, id, 'cleaner') };
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
    return `<div class="ov-top">
        <div class="ov-dial">${dial(k.load, k.automated)}<div class="tiny muted">Kitchen load at the lunch peak</div></div>
        <div class="ov-kpis">
          <div><span>Today</span><b>${yen(r.day.rev)}</b><small>${exact(r.day.guests)} guests · ${exact(r.day.pieces)} pcs</small></div>
          <div><span>Yesterday</span><b class="${(k.profitYesterday ?? 0) < 0 ? 'bad' : ''}">${k.profitYesterday === null ? '—' : yen(k.profitYesterday)}</b><small>profit</small></div>
          <div><span>Stars</span><b>${r.reputation.toFixed(1)}</b><small>${stars(r.reputation)}</small></div>
          <div><span>Turned away</span><b class="${r.day.lost ? 'bad' : ''}">${exact(r.day.lost)}</b><small>today</small></div>
          <div><span>Clean</span><b>${Math.round(r.cleanliness * 100)}%</b><small>${bar(r.cleanliness, r.cleanliness < 0.5 ? '' : 'green')}</small></div>
          <div><span>Stock</span><b>${Number.isFinite(k.stockDays) ? `${k.stockDays.toFixed(1)}d` : '—'}</b><small>of ingredients</small></div>
        </div></div>
      ${al.length ? `<div class="section slips">${al.map((a) => `<div class="slip ${a.severity}"><span class="sev">${a.severity === 'critical' ? '急' : a.severity === 'warning' ? '注' : '機'}</span><span class="txt">${esc(a.text)}</span>
        ${(() => { const f = this.localFix(a); return f ? `<button class="btn small" data-act="fix" data-arg="${a.id}">${esc(f.label)}${f.cost ? ` · ${yen(f.cost)}` : ''}</button>` : ''; })()}
        ${a.rule && a.rule !== 'autoRestock' ? `<button class="btn small ghost" data-act="go" data-arg="rules">Make it a rule</button>` : ''}</div>`).join('')}</div>`
        : '<div class="section slip calm"><span class="sev">安</span><span class="txt">All quiet here. Nothing needs you.</span></div>'}
      <div class="section"><h3>Last 7 days <span class="tiny muted">revenue · cost · profit line</span></h3>${pnlChart(days, 110, days.map((d) => 'D' + d.day))}</div>
      ${here ? `<div class="section"><button class="btn blue" data-act="travel">Ride the metro to ${esc(AREAS[p.district].name)} and walk in</button></div>` : ''}
      <div class="section"><h3>Reviews 口コミ</h3><div class="reviews">
        <div class="score"><div class="num">${rv.length ? averageStars(rv).toFixed(2) : '—'}</div>${stars(averageStars(rv))}<div class="tiny muted">${rv.length} review${rv.length === 1 ? '' : 's'}</div></div>
        <div class="rv-list">${rv.length ? rv.slice(0, 3).map((x) => `<div class="rv"><div class="spread"><b>${esc(x.author)}</b><span>${stars(x.stars)} <span class="tiny muted">Day ${x.day}</span></span></div><p>${esc(x.text)}</p></div>`).join('')
          : '<div class="muted small">No reviews yet.</div>'}</div></div></div>`;
  }

  // ------------------------------------------------------------ staff
  r_staff(): string {
    const s = this.s, m = sim.mods(s);
    const rows = ROLE_LIST.map((role) => {
      const team = sim.staffAt(s, this.id, role), slots = sim.slotsFor(s, this.id, role);
      if (!slots && !team.length) return `<div class="role-row none"><span class="role-k">${ROLES[role].emoji}</span><b>${ROLES[role].name}</b><span class="muted small">Not needed in this format</span></div>`;
      const locked = s.lifetime.pieces < ROLES[role].unlockPieces;
      const best = s.candidates.filter((e) => e.role === role).sort((a, b) => b.skill - a.skill)[0];
      const owned = Object.keys(s.restaurants);
      const people = team.map((e) => {
        const tc = Math.round(trainCost(e.role, e.skill) * m.trainCost);
        return `<div class="person"><b>${esc(e.name)}</b><span class="lvl">★${e.skill}</span>${bar(e.skill >= MAX_SKILL ? 1 : e.xp / (20 * e.skill * e.skill), 'blue')}
          <span class="tiny muted">${yen(e.wage)}/day</span>
          <span class="acts"><button class="btn small blue" data-act="train" data-arg="${e.id}" ${e.skill >= MAX_SKILL ? 'disabled' : ''}>${e.skill >= MAX_SKILL ? 'Master' : 'Train ' + yen(tc)}</button>
          <select data-in="move" data-id="${e.id}" aria-label="Move ${esc(e.name)}">${owned.map((o) => `<option value="${o}" ${o === this.id ? 'selected' : ''}>${o === this.id ? 'Stays here' : 'Move → ' + esc(s.restaurants[o].name)}</option>`).join('')}<option value="">Send to reserve</option></select>
          <button class="btn small ${this.confirmFire === e.id ? 'danger' : 'ghost'}" data-act="fire" data-arg="${e.id}">${this.confirmFire === e.id ? 'Sure?' : 'Fire'}</button></span></div>`;
      }).join('');
      const empty = Math.max(0, slots - team.length);
      const hireBtn = locked ? `<span class="small muted">🔒 at ${exact(ROLES[role].unlockPieces)} pieces</span>`
        : `<button class="btn small" data-act="hirebest" data-arg="${role}">Hire best${best ? ` ★${best.skill} · ${yen(sim.hireCost(best))}` : ''}</button>`;
      return `<div class="role-row"><span class="role-k">${ROLES[role].emoji}</span><b>${ROLES[role].name}</b><span class="slots">${'<i class="f"></i>'.repeat(team.length)}${'<i></i>'.repeat(empty)} <small>${team.length}/${slots}</small></span>
        ${empty ? hireBtn : ''}<div class="people">${people || '<span class="muted small">Nobody yet.</span>'}</div></div>`;
    }).join('');
    return `<p class="small muted">${CONCEPTS[this.r.concept].needsServer ? 'A chef cooks; a server (or manager) takes orders. With both, this place runs itself.' : 'Ghost kitchens only need chefs.'} Managers unlock house rules and offline earnings.</p>${rows}
      <div class="section"><button class="btn small ghost" data-act="go" data-arg="rules">House rules can hire for you →</button></div>`;
  }

  // ------------------------------------------------------------ menu & price
  private priceRead(): string {
    const s = this.s, r = this.r, k = this.kpi();
    const dem = E.demandPPS(s, this.id), cap = k.load > 0 ? dem / k.load : 0;
    const el2 = AREAS[PROPERTIES[this.id].district].elasticity * CONCEPTS[r.concept].elasticity;
    return `<div class="pr-read"><div><span>Price</span><b>×${r.priceMult.toFixed(2)}</b></div><div><span>Demand</span><b>${dem.toFixed(1)}<small> pcs/s</small></b></div>
      <div><span>Kitchen</span><b>${cap.toFixed(1)}<small> pcs/s</small></b></div><div class="${k.load > 1 ? 'bad' : 'good'}"><span>Verdict</span><b>${!k.automated ? 'No crew' : k.load > 1.1 ? 'Turning guests away' : k.load < 0.6 ? 'Seats to spare' : 'Well balanced'}</b></div></div>
      <div class="tiny muted">Guests here are ${el2 < 0.9 ? 'barely' : el2 > 1.4 ? 'very' : 'fairly'} price-sensitive. Bills also include the format's ×${CONCEPTS[r.concept].price} price level.</div>`;
  }

  r_menu(): string {
    const s = this.s, r = this.r, m = sim.mods(s), lvl = CONCEPTS[r.concept].price;
    const card = (id: string, tag = '') => {
      const rc = RECIPES[id], on = r.menu.includes(id), price = rc.price * r.priceMult * lvl, cost = recipeCost(rc, m.ingredientCost);
      return `<button class="mi ${on ? 'on' : ''} ${tag}" data-act="menu" data-arg="${id}" aria-pressed="${on}"><span class="tick">${on ? '✓' : ''}</span>
        <b>${esc(rc.name)}</b><small>${rc.jp} · ${Object.keys(rc.ingredients).map((k) => ingIcon(k)).join('')}</small>
        <span class="mg">${yen(price)} <i>−${yen(cost)}</i> <em class="${price - cost > 0 ? 'good' : 'bad'}">+${yen(price - cost)}</em></span></button>`;
    };
    const perm = Object.keys(RECIPES).filter((x) => !(x in SEASONAL_RECIPES));
    const have = perm.filter((x) => s.recipes.includes(x)).map((x) => card(x)).join('');
    const locked = perm.filter((x) => !s.recipes.includes(x)).map((x) => {
      const res = Object.values(RESEARCH).find((q) => q.unlockRecipe === x);
      return `<div class="mi locked"><b>🔒 ${esc(RECIPES[x].name)}</b><small>${res ? 'Research: ' + res.name : 'Milestone reward'}</small></div>`;
    }).join('');
    const ins = seasonalRecipes(s), se = season(s);
    const lim = Object.keys(SEASONAL_RECIPES).map((x) => ins.includes(x) ? card(x, 'limited') : `<div class="mi locked"><b>${esc(RECIPES[x].name)}</b><small>${RECIPES[x].jp} · out of season</small></div>`).join('');
    return `<div class="card"><h3>Price 値段</h3><input type="range" min="0.6" max="2.5" step="0.05" value="${r.priceMult}" data-in="price" aria-label="Price multiplier" aria-valuetext="price ×${r.priceMult.toFixed(2)}">
        <div id="sh-price">${this.priceRead()}</div></div>
      <div class="section"><h3>Menu 品書き <span class="tiny muted">tap to put on / take off · price − ingredient cost = margin per piece</span></h3><div class="mgrid">${have}</div></div>
      <div class="section"><h3>Limited 限定 <span class="tiny muted">${se.emoji} ${se.name}</span></h3><div class="mgrid">${lim}</div></div>
      ${locked ? `<div class="section"><h3 class="muted">Not yet</h3><div class="mgrid">${locked}</div></div>` : ''}`;
  }

  // ------------------------------------------------------------ house rules
  r_rules(): string {
    const s = this.s, r = this.r, ok = A.canUsePolicies(s, this.id);
    const rule = (key: 'autoHire' | 'autoPrice', k: string, title: string, desc: string) => `
      <button class="rule ${r.policy[key] ? 'on' : ''} ${ok ? '' : 'locked'}" data-act="rule" data-arg="${key}" role="switch" aria-checked="${r.policy[key]}" ${ok ? '' : 'aria-disabled="true"'}>
        <span class="rk" aria-hidden="true">${k}</span><span class="rt"><b>${title}</b><small>${desc}</small></span><span class="sw" aria-hidden="true"><i></i></span></button>`;
    const log = r.log.length ? r.log.slice().reverse().map((l) => `<div class="ln"><span>${esc(l)}</span></div>`).join('') : '<div class="ln muted"><span>No receipts yet today.</span></div>';
    return `${ok ? '' : `<div class="slip warning"><span class="sev">鍵</span><span class="txt">House rules need a <b>manager</b> at this restaurant, or the <b>${esc(RESEARCH.ops_center?.name ?? 'Operations Center')}</b> research.</span><button class="btn small" data-act="go" data-arg="staff">Hire a manager</button></div>`}
      <div class="rules">${rule('autoHire', '雇', 'Auto-hire', 'Fills empty chef/server slots and adds chefs when the kitchen is swamped. Keeps a 3-day cash cushion.')}
        ${rule('autoPrice', '値', 'Smart pricing', 'Nudges prices ±5% each hour: up when guests are turned away, down when the kitchen idles.')}</div>
      <div class="section"><h3>Today's receipts 本日の記録</h3><div class="receipt small-r"><div class="shop">${esc(r.name)}</div><div class="meta">DAY ${s.day} · house rule log</div><hr>${log}</div></div>`;
  }

  // ------------------------------------------------------------ books
  r_books(): string {
    const r = this.r;
    const rows = [...r.hist, r.day];
    const tot = rows.reduce((a, d) => ({ rev: a.rev + d.rev, cost: a.cost + d.cost, g: a.g + d.guests }), { rev: 0, cost: 0, g: 0 });
    const tr = (d: RestDay, today = false) => `<tr class="${today ? 'today' : ''}"><td>${today ? 'Today' : 'Day ' + d.day}</td><td>${exact(d.guests)}</td><td>${exact(d.pieces)}</td><td class="${d.lost ? 'bad' : ''}">${exact(d.lost)}</td><td>${yenExact(d.rev)}</td><td>−${yenExact(d.cost)}</td><td class="${d.rev - d.cost < 0 ? 'bad' : 'good'}">${yenExact(d.rev - d.cost)}</td></tr>`;
    return `${pnlChart(r.hist, 150, r.hist.map((d) => 'D' + d.day))}
      <div class="section"><table class="books"><thead><tr><th>Day</th><th>Guests</th><th>Pieces</th><th>Lost</th><th>Revenue</th><th>Cost</th><th>Profit</th></tr></thead>
      <tbody>${tr(r.day, true)}${r.hist.slice().reverse().map((d) => tr(d)).join('')}</tbody>
      <tfoot><tr><td>${rows.length} days</td><td>${exact(tot.g)}</td><td></td><td></td><td>${yenExact(tot.rev)}</td><td>−${yenExact(tot.cost)}</td><td class="${tot.rev - tot.cost < 0 ? 'bad' : 'good'}">${yenExact(tot.rev - tot.cost)}</td></tr></tfoot></table></div>
      <div class="tiny muted">Cost = ingredients used + this location's wages + rent. Lifetime here: ${exact(r.served)} guests, ${yen(r.revenue)} revenue.</div>`;
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
    return `<p class="small muted">Switching format refits the place: staff, upgrades and reputation stay. ${pick ? `As a ${c!.name}, rent would be <b>${yen(Math.round(PROPERTIES[this.id].rent * c!.rent))}/day</b>${bumped.length ? `; <b>${bumped.join(', ')}</b>` : '; nobody is moved'}.` : `Rent today: ${yen(sim.restaurantRent(s, this.id))}/day.`}</p>
      <div class="concepts">${conceptCards(s, this.id, pick ?? r.concept, 'switch')}</div>
      <div class="buybar">${pick ? `<span>Convert to <b>${CONCEPTS[pick].name}</b> for <b>${yen(cost)}</b></span><button class="btn big" data-act="convert" ${why ? 'disabled' : ''}>${why ? esc(why) : 'Refit 改装'}</button>` : '<span class="muted">Pick a format above to compare.</span>'}</div>`;
  }

  // ------------------------------------------------------------ upgrades & look
  r_look(): string {
    const s = this.s, r = this.r, id = this.id;
    const upg = Object.values(UPGRADES).map((u) => {
      const lvl = r.upgrades[u.id] ?? 0, mx = A.upgradeMax(id, u.id), maxed = lvl >= mx, cost = A.upgradePrice(s, id, u.id);
      return `<div class="card upg ${maxed ? 'done' : ''}"><div class="spread"><span class="em">${u.emoji}</span>${pips(lvl, mx)}</div>
        <b>${u.name}</b><div class="tiny muted">${u.desc}</div><div style="flex:1"></div>
        ${maxed ? `<button class="btn small" disabled>MAX</button>` : `<button class="btn small ${s.cash >= cost ? '' : 'poor'}" data-act="upg" data-arg="${u.id}">Upgrade ${yen(cost)}</button>`}</div>`;
    }).join('');
    const owned = unlockedCosmetics(s);
    const extras = Object.entries(COSMETICS).map(([cid, c]) => owned.includes(cid)
      ? `<button class="cos" data-act="cos" data-arg="${cid}"><i style="background:${c.swatch}"></i>${esc(c.name)}</button>`
      : `<span class="cos locked" title="Unlock through an achievement"><i></i>???</span>`).join('');
    return `<div class="grid g3">${upg}</div>
      <div class="section"><h3>Look 装い</h3><div class="card row wrap" style="gap:16px">
        <label class="field">Restaurant name<input type="text" maxlength="30" value="${esc(r.name)}" data-in="rname"></label>
        <label class="field">Sign color<input type="color" value="${r.signColor}" data-in="sign"></label>
        <label class="field">Uniforms<input type="color" value="${r.uniform}" data-in="uniform"></label>
        <label class="field">Interior theme<select data-in="theme">${THEMES.map((t, i) => `<option value="${i}" ${r.theme === i ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
      <div class="card section"><b>Unlocked extras</b> <span class="tiny muted">from achievements</span><div class="cos-row">${extras}</div></div></div>
      <p class="tiny muted">${AREAS[PROPERTIES[id].district].walkable ? 'Changes show up in the 3D street.' : 'This area is run from the books; its look lives in your guests\' imagination.'} Lifetime: ${short(r.served)} guests.</p>`;
  }
}
