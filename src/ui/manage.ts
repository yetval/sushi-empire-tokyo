// Business management window (Tab): restaurants, staff, marketing, research, expansion, empire, finances, awards.
import { AREAS } from '../core/data';
import { audio } from '../audio/audio';
import * as A from '../core/actions';
import {
  CAMPAIGNS, CITIES, CITY_IDS, DAY_SECONDS, DistrictId, FACILITIES, FacilityId, HQ_MAX,
  MAX_SKILL, PROPERTIES, RESEARCH, ROLES, hqCost, milestone, trainCost,
} from '../core/data';
import { clockStr, duration, exact, short, yen, yenExact } from '../core/format';
import * as sim from '../core/sim';
import { on } from '../core/bus';
import { ACHIEVEMENTS, AchCategory, isUnlocked, rewardText } from '../core/achievements';
import { claimQuest, streakBonus, STREAK_CAP } from '../core/quests';
import { delegate, el, esc, fail, healthSeal, patch, run, stars } from './dom';
import * as E from '../core/empire';
import { ledgerHtml, statsPanel } from './stats';
import { UIHost } from './host';
import { icon } from './icons';
import { coinBurst, floatText, punch, rollNumber } from './fx';

// The Daichō dashboard is built in parallel (src/ui/daicho/); eager glob keeps this compiling if it's absent.
type DaichoT = new (host: UIHost, nav: { openRestaurant(id: string): void; buyLot(propId: string): void }) => { el: HTMLElement; update(dt: number): void; destroy(): void };
// Lazy + error-tolerant: a half-built daicho/ must never break the rest of the game; the fallback list is shown instead.
const daichoLoader = Object.values(import.meta.glob('./daicho/daicho.ts'))[0] as (() => Promise<{ Daicho?: DaichoT }>) | undefined;
let DaichoCtor: DaichoT | null = null, daichoTried = false;
function loadDaicho(then: () => void): void {
  if (daichoTried || !daichoLoader) return;
  daichoTried = true;
  daichoLoader().then((m) => { DaichoCtor = m.Daicho ?? null; then(); }).catch((e) => console.warn('Daichō unavailable, using fallback', e));
}

export const TABS = [
  ['daicho', '帳', 'Empire'], ['staff', '人', 'Staff pool'], ['marketing', '宣', 'Marketing'],
  ['research', '研', 'Research'], ['empire', '世', 'World'], ['finances', '金', 'Finances'], ['stats', '統', 'Statistics'],
  ['quests', '依', 'Quests'], ['awards', '賞', 'Awards'],
] as const;
export type Tab = (typeof TABS)[number][0];

const CAT: Record<AchCategory, string> = { quality: 'Quality 品質', speed: 'Speed 速', expansion: 'Expansion 出店', staff: 'Staff 人材', wealth: 'Wealth 富', collection: 'Collection 収集', secrets: 'Secrets 秘', million: 'Million 百万' };
const TIER = { bronze: '銅', silver: '銀', gold: '金' } as const;

export class Manage {
  el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  tab: Tab = 'daicho';
  private dc: { el: HTMLElement; update(dt: number): void; destroy(): void } | null = null;
  private sel: string | null = null;
  private confirmFire: number | null = null;
  private armedAt = 0;
  private hireTo: Record<number, string> = {};
  private st: { last?: string } = {};
  private ledgerSt: { last?: string } = {};
  private refreshT = 0;

  constructor(private host: UIHost, close: () => void, private nav: { openRestaurant(id: string): void; buyLot(propId: string): void }) {
    this.el = el('div', 'modal manage');
    this.el.innerHTML = `<div class="panel"><div class="modal-head"><h2><span id="mg-co"></span> <span class="ja">経営帳</span></h2>
      <span class="mg-cash" title="Cash on hand">${icon('yen', 20)}<b class="num gold" id="mg-cash"></b></span><button class="x" aria-label="Close">${icon('close')}</button></div>
      <div class="manage-wrap"><nav class="tabs" aria-label="Management sections"></nav><div class="tab-body" tabindex="0"><div id="mg-content"></div></div></div></div>`;
    this.body = this.el.querySelector('#mg-content')!;
    this.tabsEl = this.el.querySelector('.tabs')!;
    this.el.querySelector('.x')!.addEventListener('click', close);
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) close(); });
    this.tabsEl.innerHTML = `<i class="tab-ind" aria-hidden="true"></i>` + TABS.map(([id, em, nm]) => `<button class="tab" data-tab="${id}" title="${nm}"><span class="em" aria-hidden="true">${em}</span>${nm}</button>`).join('') +
      `<div class="mg-esc"><span class="kbd">Esc</span> to close</div>`;
    // the sliding key follows the active tab; re-place it whenever the rail resizes (first open, window resize)
    new ResizeObserver(() => this.placeInd()).observe(this.tabsEl);
    this.tabsEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) { audio.sfx('click'); this.show(b.dataset.tab as Tab); }
    });
    this.wire();
    on('dayEnd', () => { if (this.st.last === '#stats') this.st.last = undefined; });
  }

  private get s() { return this.host.s; }

  show(tab?: Tab): void {
    if (tab && tab !== this.tab && this.tab === 'daicho') this.leave();
    if (tab) this.tab = tab;
    this.sel = this.sel && this.s.restaurants[this.sel] ? this.sel : this.host.currentSite() ?? Object.keys(this.s.restaurants)[0];
    this.tabsEl.querySelectorAll<HTMLElement>('.tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === this.tab);
      if (b.dataset.tab === this.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    this.st.last = undefined;
    const tb = this.el.querySelector('.tab-body') as HTMLElement; tb.scrollTop = 0;
    this.placeInd();
    this.render();
  }

  /** Slide the paper key under the active tab (CSS transitions the transform; instant under reduced motion). */
  private placeInd(): void {
    const b = this.tabsEl.querySelector<HTMLElement>('.tab.on'), ind = this.tabsEl.querySelector<HTMLElement>('.tab-ind')!;
    if (!b || !b.offsetHeight) return; // not laid out yet: the ResizeObserver calls back once it is
    ind.style.width = `${b.offsetWidth}px`; ind.style.height = `${b.offsetHeight}px`;
    ind.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
    this.tabsEl.classList.add('ind-ready');
  }

  /** Called when the window closes or the tab changes away from the dashboard. */
  leave(): void { this.dc?.destroy(); this.dc = null; if (this.st.last === '#daicho') this.st.last = undefined; }

  update(dt: number): void {
    this.dc?.update(dt);
    this.refreshT += dt;
    if (this.refreshT < 0.5) return;
    this.refreshT = 0;
    this.render();
  }

  render(): void {
    const s = this.s;
    (this.el.querySelector('#mg-co') as HTMLElement).textContent = s.player.company;
    rollNumber(this.el.querySelector<HTMLElement>('#mg-cash')!, Math.floor(s.cash), (n) => `¥${exact(n)}`, 450);
    if (this.tab === 'daicho' && !DaichoCtor) loadDaicho(() => { this.st.last = undefined; if (this.tab === 'daicho') this.render(); });
    (this.el.querySelector('.tab-body') as HTMLElement).classList.toggle('dc-host', this.tab === 'daicho' && !!DaichoCtor);
    if (this.tab === 'daicho' && DaichoCtor) {
      if (this.st.last !== '#daicho') {
        this.dc = new DaichoCtor(this.host, { openRestaurant: (id: string) => this.nav.openRestaurant(id), buyLot: (id: string) => this.nav.buyLot(id) });
        this.body.replaceChildren(this.dc!.el); this.st.last = '#daicho';
      }
      return;
    }
    if (this.tab === 'stats') {
      if (this.st.last !== '#stats') { this.body.replaceChildren(statsPanel(s)); this.st.last = '#stats'; this.ledgerSt.last = undefined; }
      else { const lg = this.body.querySelector<HTMLElement>('.ledger'); if (lg) patch(lg, ledgerHtml(s), this.ledgerSt); }
      return;
    }
    const html = (this as any)['r_' + this.tab]() as string;
    patch(this.body, html, this.st);
  }

  // ------------------------------------------------------------ wiring
  private wire(): void {
    const s = () => this.s;
    const after = () => { this.st.last = undefined; this.render(); };
    /** Purchase: run the action; on success re-render, then punch the re-rendered button, burst coins and float the cash spent. */
    const buy = (b: HTMLElement, act: () => string | null, sfx: Parameters<typeof run>[2]): void => {
      const cash0 = s().cash, r = b.getBoundingClientRect(), at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (!run(b, act(), sfx)) return;
      after();
      const key = `[data-act="${b.dataset.act}"]${b.dataset.arg ? `[data-arg="${CSS.escape(b.dataset.arg)}"]` : ''}`;
      const nb = this.body.querySelector<HTMLElement>(key);
      if (nb) punch(nb);
      coinBurst(at, 12);
      const spent = cash0 - s().cash;
      if (spent > 0) floatText(at, `−${yen(spent)}`, 'bad');
    };
    delegate(this.body, {
      sel: (id) => { audio.sfx('click'); this.nav.openRestaurant(id); },
      lot: (id) => { audio.sfx('click'); this.nav.buyLot(id); },
      tab: (t) => this.show(t as Tab),
      claim: (id, b) => { if (run(b, claimQuest(s().quests, s(), id), 'success')) { coinBurst(b, 14); after(); } },
      hire: (id, b) => {
        const to = this.hireTo[Number(id)] ?? '';
        buy(b, () => A.hire(s(), Number(id), to || null), 'hire');
      },
      train: (id, b) => buy(b, () => A.train(s(), Number(id)), 'upgrade'),
      keep: () => { this.confirmFire = null; audio.sfx('click'); after(); },
      fire: (id, b) => {
        if (this.confirmFire !== Number(id)) { this.confirmFire = Number(id); this.armedAt = performance.now(); audio.sfx('click'); after(); return; }
        if (performance.now() - this.armedAt < 400) return; // a double-click must not confirm
        this.confirmFire = null; run(b, A.fire(s(), Number(id)), 'whoosh'); after();
      },
      camp: (id, b) => buy(b, () => A.launchCampaign(s(), id), 'purchase'),
      res: (id, b) => buy(b, () => A.doResearch(s(), id), 'levelup'),
      unlock: (d, b) => buy(b, () => A.unlockDistrict(s(), d as DistrictId), 'fanfare'),
      travel: (d) => { this.host.travel(d as DistrictId); (this.el.querySelector('.x') as HTMLElement).click(); },
      city: (id, b) => buy(b, () => A.openCity(s(), id), 'fanfare'),
      fran: (id, b) => buy(b, () => A.buyFranchise(s(), id), 'purchase'),
      hq: (_, b) => buy(b, () => A.buyHQ(s()), 'purchase'),
      fac: (id, b) => buy(b, () => A.buyFacility(s(), id as FacilityId), 'upgrade'),
    }, {
      hireto: (v, e) => { this.hireTo[Number(e.dataset.id)] = v; },
      assign: (v, e) => { const err = A.assign(s(), Number(e.dataset.id), v || null); if (err) fail(e, err); else audio.sfx('pop'); after(); },
    });
  }

  // ------------------------------------------------------------ staff
  r_staff(): string {
    const s = this.s;
    const owned = Object.keys(s.restaurants);
    const who = (role: keyof typeof ROLES, name: string, sub: string, chip: string) => `<div class="mg-who">${icon(ROLES[role].icon, 30, { variant: 'seal' })}
      <div class="mg-nm"><b>${esc(name)}</b><span>${sub}</span></div>${chip}</div>`;
    const cands = s.candidates.map((c) => {
      const locked = s.lifetime.pieces < ROLES[c.role].unlockPieces;
      const opts = owned.filter((rid) => sim.staffAt(s, rid, c.role).length < sim.slotsFor(s, rid, c.role));
      if (this.hireTo[c.id] === undefined || (this.hireTo[c.id] && !opts.includes(this.hireTo[c.id]))) this.hireTo[c.id] = opts.includes(this.host.currentSite() ?? '') ? this.host.currentSite()! : opts[0] ?? '';
      const cost = sim.hireCost(c);
      return `<div class="card mg-card mg-cand ${locked ? 'locked' : 'p-staff'}">
        ${who(c.role, c.name, `${ROLES[c.role].name} · ${yen(c.wage)}/day`, `<span class="chip p-staff" title="Skill ${c.skill}">${icon('star', 13)} ${c.skill}</span>`)}
        ${locked ? `<div class="mg-lock">${icon('lock', 14)} Unlocks at ${exact(ROLES[c.role].unlockPieces)} pieces sold</div>` : `
        <div class="mg-act"><select data-in="hireto" data-id="${c.id}" aria-label="Where ${esc(c.name)} will work">${opts.map((o) => `<option value="${o}" ${this.hireTo[c.id] === o ? 'selected' : ''}>${esc(s.restaurants[o].name)}</option>`).join('')}<option value="" ${this.hireTo[c.id] === '' ? 'selected' : ''}>Reserve (half wage)</option></select>
        <button class="btn small primary ${s.cash >= cost ? '' : 'poor'}" data-act="hire" data-arg="${c.id}">Hire ${yen(cost)}</button></div>`}</div>`;
    }).join('') || '<div class="mg-empty">No applicants today. New ones arrive every morning.</div>';
    const roster = s.staff.map((e) => {
      const need = 20 * e.skill * e.skill, max = e.skill >= MAX_SKILL;
      const tc = Math.round(trainCost(e.role, e.skill) * sim.mods(s).trainCost);
      const opts = owned.map((o) => `<option value="${o}" ${e.restaurant === o ? 'selected' : ''}>${esc(s.restaurants[o].name)}</option>`).join('');
      return `<div class="card mg-card mg-staff">
        ${who(e.role, e.name, `${ROLES[e.role].name} · ${yen(e.wage)}/day${e.restaurant ? '' : ' · reserve'}`, `<span class="chip p-staff" title="Skill ${e.skill} of ${MAX_SKILL}">${icon('star', 13)} ${e.skill}/${MAX_SKILL}</span>`)}
        <div class="mg-xp">XP <div class="meter sm p-staff"><i style="width:${(max ? 1 : Math.min(1, e.xp / need)) * 100}%"></i></div></div>
        <div class="mg-act"><select data-in="assign" data-id="${e.id}" aria-label="Where ${esc(e.name)} works">${opts}<option value="" ${!e.restaurant ? 'selected' : ''}>Reserve</option></select>
        <button class="btn small primary ${max || s.cash >= tc ? '' : 'poor'}" data-act="train" data-arg="${e.id}" aria-label="Train ${esc(e.name)}" ${max ? 'disabled' : ''}>${icon('cap', 14)} ${max ? 'Master' : yen(tc)}</button>
        ${this.confirmFire === e.id ? `<button class="btn small ghost" data-act="keep">Keep</button>` : ''}<button class="btn small danger" data-act="fire" data-arg="${e.id}" aria-label="${this.confirmFire === e.id ? 'Confirm: fire' : 'Fire'} ${esc(e.name)}">${icon('warn', 14)} ${this.confirmFire === e.id ? 'Yes, fire' : 'Fire'}</button></div></div>`;
    }).join('') || '<div class="mg-empty">You work alone, for now. Hire a chef and a server and your stand runs itself.</div>';
    const { wages } = sim.dailyCosts(s);
    return `<div class="pg-head">${icon('team', 36, { variant: 'seal' })}<h2>Staff <span class="ja">人材</span></h2>
        <span class="pg-stat">Wages<b class="num ink">${yen(wages)}</b><span>/day</span></span></div>
      <p class="mg-note">A <b>chef</b> cooks orders. A <b>server</b> takes orders and serves. A chef plus a server and the restaurant runs itself, even while you're in another district. A <b>manager</b> hires and sets prices for you and keeps earning while you're offline.</p>
      <div class="section"><div class="seal-h">${icon('clipboard', 28, { variant: 'seal' })}<h3>Today's applicants</h3><span class="chip p-staff">${s.candidates.length}</span></div><div class="grid g3">${cands}</div></div>
      <div class="section"><div class="seal-h">${icon('chef', 28, { variant: 'seal' })}<h3>Your team</h3><span class="chip p-staff">${s.staff.length}</span></div><div class="grid g3">${roster}</div></div>`;
  }

  // ------------------------------------------------------------ marketing
  r_marketing(): string {
    const s = this.s;
    const camps = Object.values(CAMPAIGNS).map((c) => {
      const locked = c.requires && !s.research.includes(c.requires) && !s.flags[c.requires];
      const active = s.campaigns.find((x) => x.id === c.id && (c.scope !== 'district' || x.district === s.player.district));
      const left = active ? ((active.endsDay - s.day) * 1440 + active.endsMinute - s.minute) * DAY_SECONDS / 1440 : 0;
      return `<div class="card mg-card mg-camp ${locked ? 'locked' : active ? 'p-money done' : 'p-money'}">
        <div class="mg-who">${icon(c.icon, 30, { variant: 'seal' })}<div class="mg-nm"><b>${c.name}</b><span>Runs ${c.days} day${c.days > 1 ? 's' : ''}</span></div><span class="chip">${c.scope}</span></div>
        <p class="mg-desc">${c.desc}</p>
        <div class="mg-tags"><span class="chip p-money">${icon('sparkle', 13)} Brand +${c.brand}</span></div>
        <div class="mg-act">${locked ? `<span class="mg-lock">${icon('lock', 14)} Requires ${c.requires === 'chapter2' ? '1,000,000 pieces' : RESEARCH[c.requires!].name}</span>`
          : active ? `<span class="mg-run">Running · ${duration(left)} left</span>`
          : `<button class="btn primary wide ${s.cash >= c.cost ? '' : 'poor'}" data-act="camp" data-arg="${c.id}">${icon('megaphone', 16)} Launch ${yen(c.cost)}</button>`}</div></div>`;
    }).join('');
    return `<div class="pg-head">${icon('megaphone', 36, { variant: 'seal' })}<h2>Marketing <span class="ja">宣伝</span></h2>
        <span class="pg-stat">Brand<b class="num gold">${Math.round(s.brand)}</b><span>/100</span></span></div>
      <div class="pg-sub"><span>Brand grows with reputation, restaurant count and campaigns. New restaurants open with a better reputation, and every guest count gets +${Math.round(s.brand / 1.5)}%.</span>
        <div class="meter p-money"><i style="width:${Math.min(100, s.brand)}%"></i></div></div>
      <div class="section"><div class="seal-h">${icon('newspaper', 28, { variant: 'seal' })}<h3>Campaigns</h3><span class="chip p-money">${s.campaigns.length} running</span></div><div class="grid g3">${camps}</div></div>`;
  }

  // ------------------------------------------------------------ research
  r_research(): string {
    const s = this.s;
    const BR = {
      cooking: ['knife', 'Cooking', '調理'], supply: ['box', 'Supply', '仕入'], staff: ['team', 'Staff', '人材'],
      marketing: ['megaphone', 'Marketing', '宣伝'], recipes: ['roll', 'Recipes', '献立'], empire: ['globe', 'Empire', '帝国'],
    } as const;
    const all = Object.values(RESEARCH), doneN = all.filter((r) => s.research.includes(r.id)).length;
    const lanes = (Object.keys(BR) as (keyof typeof BR)[]).map((br) => {
      // done → can buy → short of RP → locked, so each lane reads left to right as a progression
      const rank = (st: string) => ['done', 'avail', 'poor', 'locked'].indexOf(st);
      const nodes = all.filter((r) => r.branch === br).map((r) => {
        const err = A.canResearch(s, r.id), st = s.research.includes(r.id) ? 'done' : !err ? 'avail' : err.startsWith('Need') ? 'poor' : 'locked';
        return { r, err, st };
      }).sort((a, b) => rank(a.st) - rank(b.st));
      const got = nodes.filter((n) => n.st === 'done').length;
      const cards = nodes.map(({ r, err, st }, i) => `<div class="card node ${st}${st === 'avail' || st === 'poor' ? ' p-upgrade' : ''}${r.requires.length === 1 && r.requires[0] === nodes[i - 1]?.r.id ? ' chain' : ''}">
        <div class="nd-h">${icon(r.icon, 30, { variant: 'seal' })}<b class="nm">${esc(r.name)}</b></div>
        <div class="nd-d">${esc(r.desc)}</div>
        <div class="nd-f">${st === 'done' ? `<span class="nd-ok">${icon('check', 14)} Researched</span>`
          : st === 'locked' ? `<span class="nd-lock">${icon('lock', 13)} ${esc(err!)}</span>`
          : `<button class="btn small ${st === 'avail' ? 'primary' : 'poor'}" data-act="res" data-arg="${r.id}"${err ? ` title="${esc(err)}"` : ''}>${icon('bulb', 14)}<b>${exact(r.cost)}</b> RP</button>`}</div></div>`).join('');
      return `<section class="rs-lane"><header class="rs-br">${icon(BR[br][0], 34, { variant: 'seal' })}<b>${BR[br][1]}</b><span class="ja">${BR[br][2]}</span>
        <span class="rs-ct">${got}/${nodes.length}</span></header><div class="rs-track">${cards}</div></section>`;
    }).join('');
    return `<div class="pg-head">${icon('flask', 36, { variant: 'seal' })}<h2>Research <span class="ja">研究開発</span></h2>
        <span class="pg-stat">${icon('bulb', 18)}<b class="num gold">${exact(s.rp)}</b><span>RP</span></span></div>
      <div class="pg-sub"><span>Every piece sold earns 0.1 RP, and milestones and quests pay more.</span>
        <div class="meter"><i style="width:${(doneN / all.length) * 100}%"></i><b>${doneN} / ${all.length} researched</b></div></div>
      <div class="rs-lanes">${lanes}</div>`;
  }

  // ------------------------------------------------------------ dashboard fallback (until the Daichō module loads)
  r_daicho(): string {
    const s = this.s, health = Object.fromEntries(E.restaurantKPIs(s).map((k) => [k.id, k.health]));
    const rest = Object.values(s.restaurants).map((r) => `<button class="card" style="text-align:left;cursor:pointer" data-act="sel" data-arg="${r.id}">
      <div class="spread"><b>${healthSeal(health[r.id])} ${esc(r.name)}</b><span class="tag">${r.concept}</span></div><div class="tiny muted">${esc(AREAS[PROPERTIES[r.id].district].name)} · today ${yen(r.day.rev)} · ${stars(r.reputation)}</div></button>`).join('');
    const areas = Object.values(AREAS).map((a) => {
      const open = s.districts.includes(a.id);
      const lots = Object.values(PROPERTIES).filter((p) => p.district === a.id && !s.restaurants[p.id]).map((p) => `<button class="btn small ghost" data-act="lot" data-arg="${p.id}">${esc(p.name)} · ${yen(p.price)}</button>`).join(' ');
      return `<div class="card ${open ? '' : 'locked'} small"><div class="spread"><b>${a.jp} ${esc(a.name)}</b>${open ? '' : `<button class="btn small primary" data-act="unlock" data-arg="${a.id}">Unlock ${yen(a.unlock.cost)}</button>`}</div>
        ${open ? `<div class="row wrap" style="margin-top:6px">${lots || '<span class="muted">Every lot here is yours.</span>'}</div>` : `<div class="tiny">${exact(a.unlock.pieces)} pieces · ${esc(a.blurb)}</div>`}</div>`;
    }).join('');
    return `<h2>Empire 帳</h2><div class="grid g3">${rest}</div><div class="section"><h3>Areas & lots</h3><div class="grid g2">${areas}</div></div>`;
  }

  // ------------------------------------------------------------ empire
  r_empire(): string {
    const s = this.s;
    if (!s.flags.chapter2) {
      const p = s.lifetime.pieces;
      return `<div class="locked-tease">${icon('globe', 80, { variant: 'seal' })}<h2>Chapter 2: The Empire</h2>
        <p>Sell <b>1,000,000</b> pieces of sushi to become the Sushi Emperor and unlock franchising, international cities, a company headquarters and central kitchens.</p>
        <div class="meter lg p-money"><i style="width:${Math.min(1, p / 1e6) * 100}%"></i><b>${exact(p)} / 1,000,000</b></div></div>`;
    }
    const pps = sim.franchisePPS(s), roy = sim.franchiseRoyaltyPerPiece(s);
    const totalFr = Object.values(s.cities).reduce((a, c) => a + c.franchises, 0);
    const cities = CITY_IDS.map((cid) => {
      const c = CITIES[cid], st = s.cities[cid];
      if (!st?.open) {
        const locked = s.lifetime.pieces < c.minPieces;
        return `<div class="card mg-card mg-city ${locked ? 'locked' : 'p-expand'}">
          <div class="mg-who">${icon(c.icon, 30, { variant: 'seal' })}<div class="mg-nm"><b>${c.name}</b><span>${locked ? 'Not yet' : 'Ready to expand'}</span></div><span class="chip">×${c.mult}</span></div>
          <div class="mg-act">${locked ? `<span class="mg-lock">${icon('lock', 14)} Sell ${short(c.minPieces)} pieces</span>`
            : `<button class="btn small gold wide ${s.cash >= c.openCost ? '' : 'poor'}" data-act="city" data-arg="${cid}">${icon('plane', 16)} Expand ${yen(c.openCost)}</button>`}</div></div>`;
      }
      const cost = A.franchisePrice(s, cid), full = st.franchises >= c.maxFranchises;
      return `<div class="card mg-card mg-city p-expand">
        <div class="mg-who">${icon(c.icon, 30, { variant: 'seal' })}<div class="mg-nm"><b>${c.name}</b><span>${st.franchises} of ${c.maxFranchises} franchises</span></div><span class="chip">×${c.mult}</span></div>
        <div class="meter sm p-expand"><i style="width:${(st.franchises / c.maxFranchises) * 100}%"></i></div>
        <div class="mg-act"><button class="btn small gold wide ${full || s.cash >= cost ? '' : 'poor'}" data-act="fran" data-arg="${cid}" ${full ? 'disabled' : ''}>${full ? 'Saturated' : `${icon('shop', 16)} Franchise ${yen(cost)}`}</button></div></div>`;
    }).join('');
    const facs = (Object.keys(FACILITIES) as FacilityId[]).map((f) => {
      const d = FACILITIES[f], lvl = s.facilities[f], cost = A.facilityPrice(s, f), max = lvl >= d.max;
      return `<div class="card mg-card p-upgrade">
        <div class="mg-who">${icon(d.icon, 30, { variant: 'seal' })}<div class="mg-nm"><b>${d.name}</b><span>Level ${lvl} of ${d.max}</span></div><span class="chip p-upgrade">Lv ${lvl}</span></div>
        <p class="mg-desc">${d.desc}</p>
        <div class="meter sm p-upgrade"><i style="width:${(lvl / d.max) * 100}%"></i></div>
        <div class="mg-act"><button class="btn small primary wide ${max || s.cash >= cost ? '' : 'poor'}" data-act="fac" data-arg="${f}" ${max ? 'disabled' : ''}>${max ? 'Max level' : `${icon('tools', 16)} Build ${yen(cost)}`}</button></div></div>`;
    }).join('');
    const hqMax = s.hq >= HQ_MAX, hqC = hqCost(s.hq);
    const kpi = (k: string, v: string, unit = '') => `<div class="mg-kpi"><span>${k}</span><b class="num ink">${v}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
    return `<div class="pg-head">${icon('globe', 36, { variant: 'seal' })}<h2>World <span class="ja">世界</span></h2>
        <span class="pg-stat">${icon('crown', 18)}${esc(s.player.title ?? 'Sushi Emperor')}</span></div>
      <div class="mg-kpis">${kpi('Franchises', exact(totalFr))}${kpi('Franchise sales', pps.toFixed(1), 'pcs/s')}${kpi('Royalties', yen(pps * roy), '/s')}${kpi('HQ floors', String(s.hq * 5))}${kpi('Brand', String(Math.round(s.brand)))}</div>
      <div class="panel p-money mg-hq section"><div class="seal-h">${icon('office', 28, { variant: 'seal' })}<h3>Headquarters</h3><span class="chip">Lv ${s.hq}/${HQ_MAX}</span></div>
        <div class="mg-hq-b"><p>Each level adds +8% guests everywhere, +10% franchise output, +15% research and +1,000 storage. Visit the tower in Shinjuku!</p>
          <button class="btn big gold ${hqMax || s.cash >= hqC ? '' : 'poor'}" data-act="hq" ${hqMax ? 'disabled' : ''}>${hqMax ? 'Complete' : `Expand ${yen(hqC)}`}</button>
          <div class="meter p-money"><i style="width:${(s.hq / HQ_MAX) * 100}%"></i></div></div></div>
      <div class="section"><div class="seal-h">${icon('factory', 28, { variant: 'seal' })}<h3>Production & logistics</h3></div><div class="grid g2">${facs}</div></div>
      <div class="section"><div class="seal-h">${icon('plane', 28, { variant: 'seal' })}<h3>Franchises & international cities</h3><span class="chip p-expand">${exact(totalFr)} franchises</span></div><div class="grid g3">${cities}</div></div>`;
  }

  // ------------------------------------------------------------ finances
  r_finances(): string {
    const s = this.s, t = s.today, inv = t.invested ?? 0;
    const { wages, rent } = sim.dailyCosts(s);
    const op = t.revenue - t.expenses, proj = op - wages - rent;
    const sign = (n: number) => (n > 0 ? 'good' : n < 0 ? 'bad' : '');
    const rows = Object.values(s.restaurants).map((r) => {
      const w = sim.staffAt(s, r.id).reduce((a, e) => a + e.wage, 0), rr = sim.restaurantRent(s, r.id);
      return { name: r.name, w, rr };
    });
    const reserve = wages - rows.reduce((a, r) => a + r.w, 0); // unassigned staff (half pay, or full if they worked today)
    const tr = (name: string, w: number, rr: number) => `<tr><td>${name}</td><td>${yenExact(w)}</td><td>${yenExact(rr)}</td><td>-${yenExact(w + rr)}</td></tr>`;
    const ln = (k: string, v: string, cls = '', row = '') => `<div class="ln ${row}"><span>${k}</span><b class="${cls}">${v}</b></div>`;
    return `<div class="pg-head">${icon('receipt', 36, { variant: 'seal' })}<h2>Finances <span class="ja">会計</span></h2></div>
      <div class="fin-grid">
        <div class="receipt"><div class="shop">${esc(s.player.company)}</div><div class="meta">DAY ${s.day} · ${clockStr(s.minute)} · 本日の売上</div><hr>
          ${ln('Sales today', yenExact(t.revenue), 'good')}
          ${ln('Ingredients & running costs', '-' + yenExact(t.expenses), t.expenses ? 'bad' : '')}
          ${ln('Guests · pieces', `${exact(t.customers)} · ${exact(t.pieces)}`)}<hr>
          <div class="ln tot"><span>Operating profit so far</span><b class="num ${sign(op) || 'ink'}">${yenExact(op)}</b></div>
          ${ln('Wages due at midnight', '-' + yenExact(wages), 'bad')}
          ${ln('Rent due at midnight', '-' + yenExact(rent), rent ? 'bad' : '')}
          <div class="ln tot"><span>Projected day</span><b class="num ${sign(proj) || 'ink'}">${yenExact(proj)}</b></div><hr>
          ${ln('Invested today <i>hires, upgrades, lots, research</i>', inv ? '-' + yenExact(inv) : '¥0', '', 'inv')}
          <div class="stamp ${proj >= 0 ? 'black' : ''}">${proj >= 0 ? '黒字' : '赤字'}</div></div>
        <div class="fin-up"><div class="seal-h">${icon('shop', 28, { variant: 'seal' })}<h3>Daily upkeep by location</h3>
            <button class="btn small brand" data-act="tab" data-arg="stats">${icon('chart', 14)} Charts</button></div>
          <table class="fin-tbl"><thead><tr><th>Location</th><th>Wages</th><th>Rent</th><th>Per day</th></tr></thead><tbody>
            ${rows.map((r) => tr(esc(r.name), r.w, r.rr)).join('')}${reserve > 0 ? tr('Reserve staff', reserve, 0) : ''}</tbody>
            <tfoot><tr><td>Total at midnight</td><td>${yenExact(wages)}</td><td>${yenExact(rent)}</td><td>-${yenExact(wages + rent)}</td></tr></tfoot></table></div>
      </div>`;
  }

  // ------------------------------------------------------------ awards
  r_awards(): string {
    const s = this.s, L = s.lifetime;
    const list: string[] = [];
    for (let i = 0; i < s.milestoneIndex + 4; i++) {
      const m = milestone(i), done = i < s.milestoneIndex, cur = i === s.milestoneIndex;
      const prev = i ? milestone(i - 1).pieces : 0, frac = Math.max(0, Math.min(1, (L.pieces - prev) / (m.pieces - prev)));
      list.push(`<li class="ms ${done ? 'done' : cur ? 'cur' : 'locked'}"><span class="ms-seal">${icon(done ? 'medal' : cur ? 'target' : 'lock', 30, { variant: 'seal' })}</span>
        <div class="ms-b"><div class="ms-t"><b>${esc(m.title)}</b><span class="ms-n">${short(m.pieces)} ${icon('nigiri', 14, { title: 'pieces' })}</span></div>
        <div class="ms-r">${esc(m.reward.text)}</div>${cur ? `<div class="meter sm"><i style="width:${frac * 100}%"></i></div>` : ''}</div></li>`);
    }
    const got = ACHIEVEMENTS.filter((a) => isUnlocked(s, a)).length;
    const TIER_N = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' } as const;
    const cats = (Object.keys(CAT) as AchCategory[]).map((c) => {
      const items = ACHIEVEMENTS.filter((a) => a.category === c);
      if (!items.length) return '';
      const n = items.filter((a) => isUnlocked(s, a)).length;
      const tiles = items.map((a) => {
        const u = isUnlocked(s, a), hide = !u && c === 'secrets';
        return `<div class="aw ${a.tier} ${u ? 'got' : 'locked'}" title="${hide ? 'A secret achievement' : esc(a.desc)}">
          <span class="aw-tier">${TIER[a.tier]} ${TIER_N[a.tier]}</span>
          <span class="aw-seal">${icon(hide ? 'lock' : a.icon, 46, { variant: 'seal' })}${u ? '' : `<i class="aw-lock">${icon('lock', 13)}</i>`}</span>
          <b class="aw-t">${hide ? '???' : esc(a.title)}</b><span class="aw-d">${hide ? 'Keep playing to discover it.' : esc(a.desc)}</span>
          <span class="aw-r">${hide ? '' : esc(rewardText(a))}</span></div>`;
      }).join('');
      return `<section class="aw-cat"><div class="aw-ch"><h3>${CAT[c]}</h3><span class="aw-n"><b>${n}</b>/${items.length}</span></div><div class="aw-grid">${tiles}</div></section>`;
    }).join('');
    return `<div class="pg-head">${icon('trophy', 36, { variant: 'seal' })}<h2>Awards <span class="ja">表彰</span></h2>
        <span class="pg-stat"><b class="num gold">${got}</b><span>/ ${ACHIEVEMENTS.length} achievements</span></span></div>
      <div class="aw-wrap">
        <aside class="ms-col"><h3>Milestones</h3><ol class="ms-track">${list.join('')}</ol>
          <p class="tiny muted">Milestones never end. Past one billion the empire keeps growing. Lifetime totals live in Statistics 統.</p></aside>
        <div class="aw-cats">${cats}</div></div>`;
  }

  // ------------------------------------------------------------ quests
  r_quests(): string {
    const s = this.s, q = s.quests;
    const b = streakBonus(q, s), streak = q?.streak ?? 0;
    const cards = (q?.list ?? []).map((x) => {
      const failed = !!x.meta?.failed && !x.done;
      const frac = Math.min(1, x.progress / x.target);
      const nums = Number.isInteger(x.target) ? `${exact(Math.min(x.progress, x.target))} / ${exact(x.target)}` : `${Math.min(x.progress, x.target).toFixed(1)} / ${x.target}`;
      const st = x.claimed ? 'claimed' : x.done ? 'done' : failed ? 'failed' : '';
      return `<div class="card qc ${st}${x.done && !x.claimed ? ' p-money' : ''}">
        <div class="qc-h"><b>${esc(x.title)}</b>${x.claimed ? '<i class="mini-stamp">済</i>' : ''}</div><div class="qc-d">${esc(x.desc)}</div>
        ${failed ? '<div class="qc-miss">Missed today. A new set arrives tomorrow.</div>' : `<div class="meter${x.done ? '' : ' p-money'}"><i style="width:${frac * 100}%"></i><b>${nums}</b></div>`}
        <div class="qc-rw"><span class="chip p-money">+${yen(x.reward.cash)}</span><span class="chip">${icon('bulb', 13)} +${x.reward.rp} RP</span></div>
        ${x.done && !x.claimed ? `<button class="btn gold" data-act="claim" data-arg="${esc(x.id)}">${icon('yen', 16)} Claim reward</button>` : ''}</div>`;
    }).join('');
    return `<div class="pg-head">${icon('scroll', 36, { variant: 'seal' })}<h2>Quests <span class="ja">依頼</span></h2></div>
      <p class="pg-sub">Three fresh requests from the neighbourhood every day. Claim all three for a streak bonus that grows for ${STREAK_CAP} days.</p>
      <div class="q-grid">${cards || '<div class="card muted">New requests arrive with the morning.</div>'}</div>
      <div class="card q-streak"><div class="q-sl"><span class="q-sk">Streak <span class="ja">連続</span></span><b class="num lg gold">${streak}</b><span class="q-days">day${streak === 1 ? '' : 's'}</span>
          <span class="q-pips">${Array.from({ length: STREAK_CAP }, (_, i) => `<i class="${i < streak ? 'on' : ''}"></i>`).join('')}</span></div>
        <div class="q-sb"><span class="tiny muted">Today's full-set bonus</span><span><span class="chip p-money">+${yen(b.cash)}</span> <span class="chip">${icon('bulb', 13)} +${b.rp} RP</span></span></div></div>`;
  }
}
