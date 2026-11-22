// Business management window (Tab): restaurants, staff, inventory, marketing, research, expansion, empire, finances, awards.
import { AREAS } from '../core/data';
import { audio } from '../audio/audio';
import * as A from '../core/actions';
import {
  CAMPAIGNS, CITIES, CITY_IDS, DAY_SECONDS, DISTRICTS, DISTRICT_IDS, DistrictId, FACILITIES, FacilityId, HQ_MAX, INGREDIENTS,
  INGREDIENT_IDS, IngredientId, MAX_SKILL, PROPERTIES, PROPERTY_IDS, RECIPES, RESEARCH, RIVALS, ROLES, Role, UPGRADES,
  hqCost, milestone, recipeCost, trainCost,
} from '../core/data';
import { clockStr, duration, exact, short, yen, yenExact } from '../core/format';
import * as sim from '../core/sim';
import { on } from '../core/bus';
import { ACHIEVEMENTS, AchCategory, isUnlocked, rewardText, unlockedCosmetics } from '../core/achievements';
import { CLIENTS, MAX_ACTIVE, acceptContract, contracts } from '../core/contracts';
import { claimQuest, streakBonus, STREAK_CAP } from '../core/quests';
import { averageStars } from '../core/reviews';
import { SEASONAL_RECIPES, season, seasonalRecipes } from '../core/seasons';
import { bar, delegate, el, esc, fail, ingIcon, patch, pips, run, stars } from './dom';
import { ledgerHtml, statsPanel } from './stats';
import { UIHost } from './host';

export const TABS = [
  ['restaurants', '店', 'Restaurants'], ['staff', '人', 'Staff'], ['inventory', '蔵', 'Inventory'], ['marketing', '宣', 'Marketing'],
  ['research', '研', 'Research'], ['expansion', '出', 'Expansion'], ['empire', '帝', 'Empire'], ['finances', '金', 'Finances'], ['stats', '統', 'Statistics'],
  ['quests', '依', 'Quests'], ['catering', '宴', 'Catering'], ['awards', '賞', 'Awards'],
] as const;
export type Tab = (typeof TABS)[number][0];

const THEMES = ['Classic Wood', 'Sakura Pink', 'Midnight Neon', 'Imperial Gold'];
/** Achievement cosmetics that map onto existing restaurant fields. Others are keepsakes (shown, not applied). */
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
const CAT: Record<AchCategory, string> = { quality: 'Quality 品質', speed: 'Speed 速', expansion: 'Expansion 出店', staff: 'Staff 人材', wealth: 'Wealth 富', collection: 'Collection 収集', rivals: 'Rivals 好敵手', secrets: 'Secrets 秘', million: 'Million 百万' };
const TIER = { bronze: '銅', silver: '銀', gold: '金' } as const;
const KIND_EMOJI = { stand: '🛖', shop: '🏠', restaurant: '🏯', flagship: '🏙️' } as const;

export class Manage {
  el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  tab: Tab = 'restaurants';
  private sel: string | null = null;
  private confirmFire: number | null = null;
  private hireTo: Record<number, string> = {};
  private st: { last?: string } = {};
  private ledgerSt: { last?: string } = {};
  private refreshT = 0;

  constructor(private host: UIHost, close: () => void) {
    this.el = el('div', 'modal manage');
    this.el.innerHTML = `<div class="panel"><div class="modal-head"><h2><span id="mg-co"></span> <span class="ja">経営帳</span></h2>
      <span class="chip gold" id="mg-cash"></span><button class="x" aria-label="Close">✕</button></div>
      <div class="manage-wrap"><nav class="tabs"></nav><div class="tab-body" tabindex="0"><div id="mg-content"></div></div></div></div>`;
    this.body = this.el.querySelector('#mg-content')!;
    this.tabsEl = this.el.querySelector('.tabs')!;
    this.el.querySelector('.x')!.addEventListener('click', close);
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) close(); });
    this.tabsEl.innerHTML = TABS.map(([id, em, nm]) => `<button class="tab" data-tab="${id}"><span class="em">${em}</span>${nm}</button>`).join('') +
      `<div style="flex:1"></div><div class="tiny muted" style="padding:4px"><span class="key sm">Esc</span> to close</div>`;
    this.tabsEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) { audio.sfx('click'); this.show(b.dataset.tab as Tab); }
    });
    this.wire();
    on('dayEnd', () => { if (this.st.last === '#stats') this.st.last = undefined; });
  }

  private get s() { return this.host.s; }

  show(tab?: Tab): void {
    if (tab) this.tab = tab;
    this.sel = this.sel && this.s.restaurants[this.sel] ? this.sel : this.host.currentSite() ?? Object.keys(this.s.restaurants)[0];
    this.tabsEl.querySelectorAll<HTMLElement>('.tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === this.tab);
      if (b.dataset.tab === this.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    this.st.last = undefined;
    const tb = this.el.querySelector('.tab-body') as HTMLElement; tb.scrollTop = 0;
    this.render();
  }

  update(dt: number): void {
    this.refreshT += dt;
    if (this.refreshT < 0.5) return;
    this.refreshT = 0;
    this.render();
  }

  render(): void {
    const s = this.s;
    (this.el.querySelector('#mg-co') as HTMLElement).textContent = s.player.company;
    (this.el.querySelector('#mg-cash') as HTMLElement).textContent = `¥ ${exact(s.cash)}`;
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
    const refreshSoon = (() => { let t = 0; return () => { clearTimeout(t); t = window.setTimeout(() => this.host.refreshWorld(), 350); }; })();
    const after = () => { this.st.last = undefined; this.render(); };
    delegate(this.body, {
      sel: (id) => { this.sel = id; this.tab = 'restaurants'; audio.sfx('click'); this.show(); },
      menu: (r, b) => { if (run(b, A.toggleMenu(s(), this.sel!, r), 'pop')) after(); },
      upg: (u, b) => { if (run(b, A.buyUpgrade(s(), this.sel!, u), 'upgrade')) after(); },
      tab: (t) => this.show(t as Tab),
      claim: (id, b) => { if (run(b, claimQuest(s().quests, s(), id), 'coin')) after(); },
      accept: (id, b) => {
        const res = acceptContract(s(), Number(id));
        if (typeof res === 'string') return fail(b, res);
        audio.sfx('fanfare'); after();
      },
      cos: (id) => {
        const c = COSMETICS[id], r = s().restaurants[this.sel!];
        if (!c?.apply || !unlockedCosmetics(s()).includes(id)) return;
        Object.assign(r, c.apply);
        this.host.refreshWorld(); audio.sfx('pop'); after();
      },
      hire: (id, b) => {
        const to = this.hireTo[Number(id)] ?? '';
        if (run(b, A.hire(s(), Number(id), to || null), 'coin')) after();
      },
      train: (id, b) => { if (run(b, A.train(s(), Number(id)), 'upgrade')) after(); },
      fire: (id, b) => {
        if (this.confirmFire !== Number(id)) { this.confirmFire = Number(id); audio.sfx('click'); after(); return; }
        this.confirmFire = null; run(b, A.fire(s(), Number(id)), 'whoosh'); after();
      },
      buy: (arg, b) => {
        const [id, q] = arg.split(':') as [IngredientId, string];
        const st = s(), delivery = !this.host.atSupplier();
        const unit = sim.ingredientPrice(st, id) * (delivery ? 1.08 : 1);
        const room = sim.mods(st).storage - sim.storageUsed(st);
        const qty = q === 'max' ? Math.min(room, Math.floor(Math.max(0, st.cash) / unit)) : Number(q);
        if (room <= 0) return fail(b, 'Storage is full! Research Cold Chain or expand.');
        const got = sim.buyIngredient(st, id, qty, delivery);
        if (!got) return fail(b, `Can't afford ${INGREDIENTS[id].name}`);
        audio.sfx('coin'); after();
      },
      autotoggle: () => { s().flags.autoRestockOff = !s().flags.autoRestockOff; audio.sfx('click'); after(); },
      autoset: () => { const st = s(); for (const k of sim.neededIngredients(st)) st.restock[k] = Math.max(st.restock[k], 1); audio.sfx('pop'); after(); },
      rtoggle: (id) => { const st = s(); st.restock[id as IngredientId] = st.restock[id as IngredientId] > 0 ? 0 : 1; audio.sfx('click'); after(); },
      camp: (id, b) => { if (run(b, A.launchCampaign(s(), id), 'fanfare')) after(); },
      res: (id, b) => { if (run(b, A.doResearch(s(), id), 'upgrade')) after(); },
      unlock: (d, b) => { if (run(b, A.unlockDistrict(s(), d as DistrictId), 'fanfare')) after(); },
      travel: (d) => { this.host.travel(d as DistrictId); (this.el.querySelector('.x') as HTMLElement).click(); },
      prop: (id, b) => { if (run(b, A.buyProperty(s(), id), 'fanfare')) after(); },
      city: (id, b) => { if (run(b, A.openCity(s(), id), 'fanfare')) after(); },
      fran: (id, b) => { if (run(b, A.buyFranchise(s(), id), 'coin')) after(); },
      hq: (_, b) => { if (run(b, A.buyHQ(s()), 'fanfare')) after(); },
      fac: (id, b) => { if (run(b, A.buyFacility(s(), id as FacilityId), 'upgrade')) after(); },
      buyout: (arg, b) => { const [rid, d] = arg.split(':'); if (run(b, A.buyout(s(), rid, d as DistrictId), 'fanfare')) after(); },
    }, {
      price: (v, e) => {
        A.setPrice(s(), this.sel!, Number(v));
        e.setAttribute('aria-valuetext', `price ×${Number(v).toFixed(2)}`);
        const lbl = this.body.querySelector('#price-lbl'); if (lbl) lbl.innerHTML = this.priceLabel();
      },
      rname: (v) => { const r = s().restaurants[this.sel!]; r.name = v.slice(0, 30) || PROPERTIES[r.id].name; refreshSoon(); },
      sign: (v) => { s().restaurants[this.sel!].signColor = v; refreshSoon(); },
      uniform: (v) => { s().restaurants[this.sel!].uniform = v; refreshSoon(); },
      theme: (v) => { s().restaurants[this.sel!].theme = Number(v); this.host.refreshWorld(); audio.sfx('pop'); after(); },
      hireto: (v, e) => { this.hireTo[Number(e.dataset.id)] = v; },
      assign: (v, e) => { const err = A.assign(s(), Number(e.dataset.id), v || null); if (err) fail(e, err); else audio.sfx('pop'); after(); },
    });
  }

  // ------------------------------------------------------------ restaurants
  private priceLabel(): string {
    const r = this.s.restaurants[this.sel!], d = AREAS[PROPERTIES[r.id].district];
    const dem = sim.priceDemand(r.priceMult, d.elasticity);
    return `Price ×${r.priceMult.toFixed(2)} → demand <b class="${dem >= 1 ? 'good' : 'bad'}">${Math.round(dem * 100)}%</b> of normal · ${d.name} guests are ${d.elasticity < 1 ? 'not very' : d.elasticity > 1.4 ? 'very' : 'fairly'} price-sensitive`;
  }

  r_restaurants(): string {
    const s = this.s;
    const ids = Object.keys(s.restaurants);
    const id = this.sel!, r = s.restaurants[id], p = PROPERTIES[id];
    const m = sim.mods(s);
    const auto = sim.isAutomated(s, id);
    const chips = `<div class="row wrap">${ids.map((x) => `<button class="opt ${x === id ? 'on' : ''}" data-act="sel" data-arg="${x}">${KIND_EMOJI[PROPERTIES[x].kind]} ${esc(s.restaurants[x].name)}</button>`).join('')}</div>`;
    const stats = `<div class="statgrid section">
      <div class="stat"><div class="k">Reputation</div><div class="v">${stars(r.reputation)} <span class="small">${r.reputation.toFixed(1)}</span></div></div>
      <div class="stat"><div class="k">Satisfaction</div><div class="v">${Math.round(r.satisfaction * 100)}%</div></div>
      <div class="stat"><div class="k">Cleanliness</div><div class="v ${r.cleanliness < 0.5 ? 'bad' : ''}">${Math.round(r.cleanliness * 100)}%</div></div>
      <div class="stat"><div class="k">Demand now</div><div class="v">${sim.demandPerMin(s, id).toFixed(1)} <span class="small">guests/min</span></div></div>
      <div class="stat"><div class="k">Kitchen</div><div class="v">${sim.kitchenRate(s, id).toFixed(2)} <span class="small">pcs/s</span></div></div>
      <div class="stat"><div class="k">Open orders</div><div class="v">${r.orders.length} <span class="small">/ ${r.ready.length} ready</span></div></div>
      <div class="stat"><div class="k">Guests served</div><div class="v">${short(r.served)}</div></div>
      <div class="stat"><div class="k">Revenue</div><div class="v">${yen(r.revenue)}</div></div>
    </div>`;
    const inSeason = seasonalRecipes(s);
    const menuCard = (rc: (typeof RECIPES)[string], tag = '') => {
      const on = r.menu.includes(rc.id);
      const price = rc.price * r.priceMult, cost = recipeCost(rc, m.ingredientCost);
      return `<button class="card ${on ? 'on' : ''} ${tag}" style="text-align:left;cursor:pointer" data-act="menu" data-arg="${rc.id}" aria-pressed="${on}">
        <div class="spread"><b>${esc(rc.name)}</b><span class="tick">${on ? '✓' : ''}</span></div>
        <div class="tiny muted">${rc.jp} · ${Object.keys(rc.ingredients).map((k) => ingIcon(k)).join('')}</div>
        <div class="small">${yen(price)}/pc · cost ${yen(cost)} · <span class="good">+${yen(price - cost)}</span></div></button>`;
    };
    const se = season(s);
    const limited = Object.values(SEASONAL_RECIPES).map((rc) => inSeason.includes(rc.id) ? menuCard(RECIPES[rc.id], 'limited')
      : `<div class="card locked small"><b>${esc(rc.name)}</b><div class="tiny">${rc.jp} · out of season${r.menu.includes(rc.id) ? ' · paused on your menu' : ''}</div></div>`).join('');
    const menu = Object.values(RECIPES).filter((rc) => !(rc.id in SEASONAL_RECIPES)).map((rc) => {
      if (s.recipes.includes(rc.id)) return menuCard(rc);
      const res = Object.values(RESEARCH).find((x) => x.unlockRecipe === rc.id);
      return `<div class="card locked small"><b>🔒 ${esc(rc.name)}</b><div class="tiny">${res ? `Research: ${res.name}` : 'Milestone reward'}</div></div>`;
    }).join('');
    // reviews (Tabelog-style)
    const rv = s.reviews?.[id] ?? [];
    const avg = averageStars(rv);
    const reviews = `<div class="section"><h3>Reviews 口コミ</h3><div class="reviews">
      <div class="score"><div class="num">${rv.length ? avg.toFixed(2) : '—'}</div>${stars(avg)}<div class="tiny muted">${rv.length} review${rv.length === 1 ? '' : 's'}</div></div>
      <div class="rv-list">${rv.length ? rv.slice(0, 4).map((x) => `<div class="rv"><div class="spread"><b>${esc(x.author)}</b><span>${stars(x.stars)} <span class="tiny muted">Day ${x.day}</span></span></div><p>${esc(x.text)}</p></div>`).join('')
        : '<div class="muted small">No reviews yet. Serve a few happy guests and the food bloggers will come.</div>'}</div></div></div>`;
    // achievement cosmetics
    const owned = unlockedCosmetics(s);
    const extras = Object.entries(COSMETICS).map(([cid, c]) => owned.includes(cid)
      ? `<button class="cos" data-act="cos" data-arg="${cid}" title="Apply: ${esc(c.name)}"><i style="background:${c.swatch}"></i>${esc(c.name)}</button>`
      : `<span class="cos locked" title="Unlock through an achievement"><i></i>???</span>`).join('');
    const keepsakes = owned.filter((x) => !COSMETICS[x]);
    const upg = Object.values(UPGRADES).map((u) => {
      const lvl = r.upgrades[u.id] ?? 0, mx = A.upgradeMax(id, u.id), maxed = lvl >= mx;
      const cost = A.upgradePrice(s, id, u.id);
      return `<div class="card upg ${maxed ? 'done' : ''}"><div class="spread"><span class="em">${u.emoji}</span>${pips(lvl, mx)}</div>
        <b>${u.name}</b><div class="tiny muted">${u.desc}</div><div style="flex:1"></div>
        ${maxed ? `<button class="btn small" disabled>MAX</button>` : `<button class="btn small ${s.cash >= cost ? '' : 'poor'}" data-act="upg" data-arg="${u.id}">Upgrade ${yen(cost)}</button>`}</div>`;
    }).join('');
    const roles = (Object.keys(ROLES) as Role[]).map((ro) => {
      const st = sim.staffAt(s, id, ro);
      return `<div class="card small"><b>${ROLES[ro].emoji} ${ROLES[ro].name}</b> <span class="chip">${st.length}/${sim.slotsFor(s, id, ro)}</span>
        <div class="tiny muted">${st.map((e) => esc(e.name) + ' ★' + e.skill).join(', ') || 'Nobody yet'}</div></div>`;
    }).join('');
    return `${chips}
      <div class="section spread"><div><h2>${esc(r.name)}</h2><div class="muted">${AREAS[p.district].name} · ${p.kind} · rent ${yen(p.rent)}/day · ${p.seatsMax} seats max</div></div>
        <span class="chip ${auto ? 'green' : 'red'}">${auto ? '⚙️ Fully automated' : s.lifetime.pieces < 50 ? '🧑‍🍳 You run this stand' : '🧑‍🍳 Needs you (hire chef + server)'}</span></div>
      ${stats}
      <div class="section"><h3>💴 Pricing</h3><div class="card"><input type="range" min="0.6" max="2.5" step="0.05" value="${r.priceMult}" data-in="price" aria-label="Price multiplier" aria-valuetext="price ×${r.priceMult.toFixed(2)}">
        <div class="small" id="price-lbl">${this.priceLabel()}</div></div></div>
      <div class="section"><h3>📜 Menu <span class="tiny muted">click to toggle</span></h3><div class="grid g4">${menu}</div></div>
      <div class="section"><h3>Limited 限定 <span class="tiny muted">${se.emoji} ${se.name} specials — on the menu only while in season</span></h3><div class="grid g4">${limited}</div></div>
      ${reviews}
      <div class="section"><h3>🛠️ Upgrades</h3><div class="grid g3">${upg}</div></div>
      <div class="section"><h3>👥 Staff <button class="btn small blue" data-act="tab" data-arg="staff">Hire / manage</button></h3><div class="grid g4">${roles}</div></div>
      <div class="section"><h3>🎨 Customize</h3><div class="card row wrap" style="gap:16px">
        <label class="field">Restaurant name<input type="text" maxlength="30" value="${esc(r.name)}" data-in="rname"></label>
        <label class="field">Sign color<input type="color" value="${r.signColor}" data-in="sign"></label>
        <label class="field">Uniforms<input type="color" value="${r.uniform}" data-in="uniform"></label>
        <label class="field">Interior theme<select data-in="theme">${THEMES.map((t, i) => `<option value="${i}" ${r.theme === i ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <div class="card section"><b>Unlocked extras</b> <span class="tiny muted">earned from achievements — click to apply here</span><div class="cos-row">${extras}</div>
        ${keepsakes.length ? `<div class="tiny muted" style="margin-top:6px">Also collected: ${keepsakes.map((k) => esc(k.replace(/_/g, ' '))).join(', ')}</div>` : ''}</div></div>`;
  }

  // ------------------------------------------------------------ staff
  r_staff(): string {
    const s = this.s;
    const owned = Object.keys(s.restaurants);
    const cands = s.candidates.map((c) => {
      const locked = s.lifetime.pieces < ROLES[c.role].unlockPieces;
      const opts = owned.filter((rid) => sim.staffAt(s, rid, c.role).length < sim.slotsFor(s, rid, c.role));
      if (this.hireTo[c.id] === undefined || (this.hireTo[c.id] && !opts.includes(this.hireTo[c.id]))) this.hireTo[c.id] = opts.includes(this.host.currentSite() ?? '') ? this.host.currentSite()! : opts[0] ?? '';
      const cost = sim.hireCost(c);
      return `<div class="card ${locked ? 'locked' : ''}"><div class="spread"><b>${ROLES[c.role].emoji} ${esc(c.name)}</b><span class="chip">★ ${c.skill}</span></div>
        <div class="tiny muted">${ROLES[c.role].name} · wage ${yen(c.wage)}/day</div>
        ${locked ? `<div class="small">🔒 Unlocks at ${exact(ROLES[c.role].unlockPieces)} pieces sold</div>` : `
        <div class="row" style="margin-top:6px"><select data-in="hireto" data-id="${c.id}" style="flex:1;min-width:0">${opts.map((o) => `<option value="${o}" ${this.hireTo[c.id] === o ? 'selected' : ''}>${esc(s.restaurants[o].name)}</option>`).join('')}<option value="" ${this.hireTo[c.id] === '' ? 'selected' : ''}>Reserve (half wage)</option></select>
        <button class="btn small ${s.cash >= cost ? '' : 'poor'}" data-act="hire" data-arg="${c.id}">Hire ${yen(cost)}</button></div>`}</div>`;
    }).join('') || '<div class="muted">No candidates today — new applicants arrive every morning.</div>';
    const roster = s.staff.map((e) => {
      const need = 20 * e.skill * e.skill;
      const tc = Math.round(trainCost(e.role, e.skill) * sim.mods(s).trainCost);
      const opts = owned.map((o) => `<option value="${o}" ${e.restaurant === o ? 'selected' : ''}>${esc(s.restaurants[o].name)}</option>`).join('');
      return `<div class="card"><div class="spread"><b>${ROLES[e.role].emoji} ${esc(e.name)}</b><span class="chip">★ ${e.skill}/${MAX_SKILL}</span></div>
        <div class="tiny muted">${ROLES[e.role].name} · ${yen(e.wage)}/day${e.restaurant ? '' : ' (reserve: half wage)'}</div>
        <div class="tiny">XP</div>${bar(e.skill >= MAX_SKILL ? 1 : e.xp / need, 'blue')}
        <div class="row wrap" style="margin-top:6px"><select data-in="assign" data-id="${e.id}" style="flex:1;min-width:0">${opts}<option value="" ${!e.restaurant ? 'selected' : ''}>Reserve</option></select>
        <button class="btn small blue" data-act="train" data-arg="${e.id}" ${e.skill >= MAX_SKILL ? 'disabled' : ''}>🎓 ${e.skill >= MAX_SKILL ? 'Master' : yen(tc)}</button>
        <button class="btn small ${this.confirmFire === e.id ? 'danger' : 'ghost'}" data-act="fire" data-arg="${e.id}">${this.confirmFire === e.id ? 'Confirm?' : 'Fire'}</button></div></div>`;
    }).join('') || '<div class="muted">You work alone... for now. Hire a chef and a server to automate your stand!</div>';
    const { wages } = sim.dailyCosts(s);
    return `<div class="spread"><h2>👥 Staff</h2><span class="chip">Daily wages: ${yen(wages)}</span></div>
      <div class="muted small">A <b>chef</b> cooks orders. A <b>server</b> takes orders and serves. Chef + server = the restaurant runs itself (even when you're away in another district). <b>Managers</b> enable offline earnings and auto-restock.</div>
      <div class="section"><h3>📋 Today's applicants</h3><div class="grid g3">${cands}</div></div>
      <div class="section"><h3>🧑‍🍳 Your team (${s.staff.length})</h3><div class="grid g3">${roster}</div></div>`;
  }

  // ------------------------------------------------------------ inventory
  r_inventory(): string {
    const s = this.s, m = sim.mods(s);
    const atSup = this.host.atSupplier(), phone = s.research.includes('phone_orders'), canBuy = atSup || phone;
    const need = new Set(sim.neededIngredients(s));
    const used = sim.storageUsed(s);
    const capable = s.research.includes('auto_restock') || s.staff.some((e) => e.role === 'manager' && e.restaurant);
    // mirrors sim.autoRestock: enabled ingredients that a menu uses split 90% of storage equally
    const share = Math.floor(m.storage * 0.9 / Math.max(1, [...need].length));
    const cards = INGREDIENT_IDS.map((id) => {
      const d = INGREDIENTS[id], price = sim.ingredientPrice(s, id) * (atSup ? 1 : 1.08);
      const short_ = s.event && (s.event.id === 'shortage_' + id);
      return `<div class="card ${need.has(id) ? 'hl' : ''} ${s.inventory[id] === 0 && need.has(id) ? 'shake' : ''}">
        <div class="spread"><b>${ingIcon(id)} ${d.name}</b><span class="chip ${s.inventory[id] < 10 && need.has(id) ? 'red' : ''}">${exact(s.inventory[id])}</span></div>
        <div class="tiny muted">${yen(Math.round(price))}/unit ${short_ ? '<span class="tag" style="background:var(--red)">SHORTAGE</span>' : ''} ${need.has(id) ? '· on your menu' : ''}</div>
        ${canBuy ? `<div class="row" style="margin-top:6px"><button class="btn small" data-act="buy" data-arg="${id}:10">+10</button><button class="btn small" data-act="buy" data-arg="${id}:50">+50</button><button class="btn small gold" data-act="buy" data-arg="${id}:max">Max</button></div>` : ''}
        ${capable ? `<button class="restock ${s.restock[id] > 0 ? 'on' : ''}" data-act="rtoggle" data-arg="${id}" aria-pressed="${s.restock[id] > 0}" aria-label="${d.name} auto-restock">Auto-restock ${s.restock[id] > 0 ? (need.has(id) ? `on · keeps ~${exact(share)}` : 'on · not on any menu') : 'off'}</button>` : ''}</div>`;
    }).join('');
    return `<div class="spread"><h2>📦 Inventory</h2><span class="chip">Storage ${exact(used)} / ${exact(m.storage)}</span></div>
      ${bar(used / m.storage, used / m.storage > 0.9 ? '' : 'green')}
      <div class="card section small">${atSup ? "🐟 You're at Mika's shop — buying at shop prices." : phone ? '☎️ Supplier Hotline: orders are delivered (+8% delivery fee).' : "🚶 Walk to <b>Mika's Fresh Fish</b> in Asakusa to buy ingredients — or research <b>Supplier Hotline</b> to order from anywhere."}</div>
      <div class="card section small">${capable ? `<div class="spread"><span>🚚 <b>Auto-restock</b> is ${s.flags.autoRestockOff ? '<span class="bad">OFF</span>' : '<span class="good">ON</span>'} — switched-on ingredients your menus use are kept at an equal share of storage (+8% delivery).</span>
        <span class="row"><button class="btn small ghost" data-act="autoset">Switch on all menu ingredients</button><button class="btn small ${s.flags.autoRestockOff ? 'green' : ''}" data-act="autotoggle">${s.flags.autoRestockOff ? 'Turn on' : 'Turn off'}</button></span></div>`
        : '🔒 Auto-restock: research <b>Scheduled Deliveries</b> or hire a <b>Manager</b>.'}</div>
      <div class="grid g4 section">${cards}</div>`;
  }

  // ------------------------------------------------------------ marketing
  r_marketing(): string {
    const s = this.s;
    const camps = Object.values(CAMPAIGNS).map((c) => {
      const locked = c.requires && !s.research.includes(c.requires) && !s.flags[c.requires];
      const active = s.campaigns.find((x) => x.id === c.id && (c.scope !== 'district' || x.district === s.player.district));
      const left = active ? ((active.endsDay - s.day) * 1440 + active.endsMinute - s.minute) * DAY_SECONDS / 1440 : 0;
      return `<div class="card ${locked ? 'locked' : active ? 'done' : ''}"><div class="spread"><b>${c.emoji} ${c.name}</b><span class="chip">${c.scope}</span></div>
        <div class="small muted">${c.desc}</div><div class="tiny">Brand +${c.brand} · lasts ${c.days} day${c.days > 1 ? 's' : ''}</div>
        ${locked ? `<div class="small">🔒 Requires ${c.requires === 'chapter2' ? '1,000,000 pieces' : RESEARCH[c.requires!].name}</div>`
          : active ? `<div class="small good">⏱ Running — ${duration(left)} left</div>`
          : `<button class="btn small ${s.cash >= c.cost ? '' : 'poor'}" style="margin-top:6px" data-act="camp" data-arg="${c.id}">Launch ${yen(c.cost)}</button>`}</div>`;
    }).join('');
    const rivals = DISTRICT_IDS.map((d) => {
      const rows = Object.entries(s.rivals).filter(([, sh]) => sh[d] !== undefined).map(([rid, sh]) =>
        `<div class="row small"><span style="width:130px;color:${RIVALS[rid].color};font-weight:700">${RIVALS[rid].name}</span><div style="flex:1">${bar((sh[d] ?? 0) / 0.6)}</div><span style="width:40px;text-align:right">${Math.round((sh[d] ?? 0) * 100)}%</span></div>`).join('');
      return `<div class="card"><div class="spread"><b>${DISTRICTS[d].name}</b><span class="tiny muted">You lose ${Math.round(sim.rivalShare(s, d) * 100)}% of guests to rivals</span></div>${rows || '<div class="small good">No rivals here! 🎉</div>'}</div>`;
    }).join('');
    return `<div class="spread"><h2>📣 Marketing</h2><span class="chip">Brand ${Math.round(s.brand)}/100</span></div>
      ${bar(s.brand / 100, 'gold')}<div class="tiny muted">Brand grows with reputation, number of restaurants and campaigns. New restaurants start with better reputation; all guests +${Math.round(s.brand / 1.5)}%.</div>
      <div class="section"><h3>Campaigns</h3><div class="grid g3">${camps}</div></div>
      <div class="section"><h3>⚔️ Rival market share</h3><div class="muted small">Rivals grow where you're weak. High reputation, more locations and marketing push them out.${s.flags.chapter2 ? ' Buy them out in the Empire tab!' : ' After 1M pieces you can buy them out.'}</div><div class="grid g2" style="margin-top:8px">${rivals}</div></div>`;
  }

  // ------------------------------------------------------------ research
  r_research(): string {
    const s = this.s;
    const branches = ['cooking', 'supply', 'staff', 'marketing', 'recipes', 'empire'] as const;
    const cols = branches.map((br) => `<div class="col"><h4>${br}</h4>${Object.values(RESEARCH).filter((r) => r.branch === br).map((r) => {
      const done = s.research.includes(r.id), err = A.canResearch(s, r.id);
      const needRP = err?.startsWith('Need');
      const cls = done ? 'done' : !err || needRP ? 'avail' : 'locked';
      return `<div class="card node ${cls}"><div class="nm">${r.emoji} ${r.name}</div><div class="muted">${r.desc}</div>
        ${done ? '<div class="good bold">✓ Researched</div>' : !err || needRP ? `<button class="btn small ${err ? '' : 'green'}" style="margin-top:4px" data-act="res" data-arg="${r.id}" ${err ? 'disabled' : ''}>🔬 ${exact(r.cost)} RP</button>` : `<div class="tiny">🔒 ${esc(err!)}</div>`}</div>`;
    }).join('')}</div>`).join('');
    return `<div class="spread"><h2>🔬 Research & Development</h2><span class="chip gold">🧪 ${exact(s.rp)} RP</span></div>
      <div class="muted small">Earn research points from every piece sold (+0.1 RP each) and milestones. Unlock recipes, faster kitchens, cheaper supplies and empire tech.</div>
      <div style="overflow-x:auto" class="section"><div class="research-cols">${cols}</div></div>`;
  }

  // ------------------------------------------------------------ expansion
  r_expansion(): string {
    const s = this.s;
    const dists = DISTRICT_IDS.map((d) => {
      const def = DISTRICTS[d], open = s.districts.includes(d), here = s.player.district === d;
      const props = PROPERTY_IDS.filter((p) => PROPERTIES[p].district === d).map((pid) => {
        const p = PROPERTIES[pid], owned = !!s.restaurants[pid];
        return `<div class="card ${owned ? 'done' : ''} small"><div class="spread"><b>${KIND_EMOJI[p.kind]} ${esc(owned ? s.restaurants[pid].name : p.name)}</b><span class="tag">${p.kind}</span></div>
          <div class="tiny muted">Traffic ×${p.size} · ${p.seatsMax} seats · ${p.chefSlots} chefs · rent ${yen(p.rent)}/day</div>
          ${owned ? `<button class="btn small blue" style="margin-top:4px" data-act="sel" data-arg="${pid}">Manage</button>` : `<button class="btn small ${open && s.cash >= p.price ? '' : 'poor'}" style="margin-top:4px" data-act="prop" data-arg="${pid}" ${open ? '' : 'disabled'}>Buy ${yen(p.price)}</button>`}</div>`;
      }).join('');
      return `<div class="card ${open ? '' : 'locked'}"><div class="spread"><h3>${def.jp} ${def.name} ${here ? '<span class="chip red">📍 You are here</span>' : ''}</h3>
        ${open ? (here ? '' : `<button class="btn small blue" data-act="travel" data-arg="${d}">🚇 Travel</button>`) : `<button class="btn small gold" data-act="unlock" data-arg="${d}">Unlock ${yen(def.unlock.cost)}</button>`}</div>
        <div class="small muted">${def.blurb}</div>
        ${open ? '' : `<div class="small">Requires ${exact(def.unlock.pieces)} pieces sold (${exact(Math.min(s.lifetime.pieces, def.unlock.pieces))}) + business permit ${yen(def.unlock.cost)}</div>`}
        <div class="tiny" style="margin:4px 0">Base traffic ${def.traffic}/min · price sensitivity ${def.elasticity}</div>
        <div class="grid g2">${props}</div></div>`;
    }).join('');
    return `<h2>🗾 Expansion</h2><div class="muted small">Unlock districts, buy new locations and grow across Tokyo. Each restaurant needs its own staff to run without you.</div><div class="grid g2 section">${dists}</div>`;
  }

  // ------------------------------------------------------------ empire
  r_empire(): string {
    const s = this.s;
    if (!s.flags.chapter2) {
      const p = s.lifetime.pieces;
      return `<div class="locked-tease"><div class="big">🌏</div><h2>Chapter 2: The Empire</h2>
        <p class="muted">Sell <b>1,000,000</b> pieces of sushi to become the Sushi Emperor and unlock franchising, international cities, a company headquarters, central kitchens and rival buyouts.</p>
        <div style="max-width:500px;margin:0 auto">${bar(p / 1e6, 'gold')}<div class="small" style="margin-top:4px">${exact(p)} / 1,000,000</div></div></div>`;
    }
    const pps = sim.franchisePPS(s), roy = sim.franchiseRoyaltyPerPiece(s);
    const totalFr = Object.values(s.cities).reduce((a, c) => a + c.franchises, 0);
    const cities = CITY_IDS.map((cid) => {
      const c = CITIES[cid], st = s.cities[cid];
      if (!st?.open) {
        const locked = s.lifetime.pieces < c.minPieces;
        return `<div class="card ${locked ? 'locked' : ''}"><div class="spread"><b>${c.flag} ${c.name}</b><span class="chip">×${c.mult}</span></div>
          ${locked ? `<div class="small">🔒 ${short(c.minPieces)} pieces</div>` : `<button class="btn small gold" style="margin-top:4px" data-act="city" data-arg="${cid}">Expand ${yen(c.openCost)}</button>`}</div>`;
      }
      const cost = A.franchisePrice(s, cid), full = st.franchises >= c.maxFranchises;
      return `<div class="card done"><div class="spread"><b>${c.flag} ${c.name}</b><span class="chip">×${c.mult}</span></div>
        <div class="small">🏪 ${st.franchises}/${c.maxFranchises} franchises</div>${bar(st.franchises / c.maxFranchises, 'green')}
        <button class="btn small ${s.cash >= cost && !full ? 'green' : ''}" style="margin-top:6px" data-act="fran" data-arg="${cid}" ${full ? 'disabled' : ''}>${full ? 'Saturated' : 'Franchise ' + yen(cost)}</button></div>`;
    }).join('');
    const facs = (Object.keys(FACILITIES) as FacilityId[]).map((f) => {
      const d = FACILITIES[f], lvl = s.facilities[f], cost = A.facilityPrice(s, f);
      return `<div class="card"><div class="spread"><b>${d.emoji} ${d.name}</b><span class="chip">Lv ${lvl}/${d.max}</span></div><div class="small muted">${d.desc}</div>
        <button class="btn small ${s.cash >= cost ? '' : 'poor'}" style="margin-top:6px" data-act="fac" data-arg="${f}" ${lvl >= d.max ? 'disabled' : ''}>${lvl >= d.max ? 'MAX' : 'Build ' + yen(cost)}</button></div>`;
    }).join('');
    const buyouts = Object.entries(s.rivals).flatMap(([rid, sh]) => (Object.keys(sh) as DistrictId[]).map((d) => {
      const cost = sim.buyoutCost(s, rid, d);
      return `<div class="card small"><b style="color:${RIVALS[rid].color}">${RIVALS[rid].name}</b> in ${DISTRICTS[d].name} — ${Math.round((sh[d] ?? 0) * 100)}% share
        <div class="tiny muted">Owner: ${RIVALS[rid].owner} · ${RIVALS[rid].style}</div>
        <button class="btn small ${s.cash >= cost ? 'gold' : ''}" style="margin-top:4px" data-act="buyout" data-arg="${rid}:${d}">Buy out ${yen(cost)}</button></div>`;
    })).join('') || '<div class="good">You have bought out every rival. Tokyo is yours! 👑</div>';
    return `<div class="spread"><h2>🌏 ${esc(s.player.company)} Empire</h2><span class="chip gold">👑 ${esc(s.player.title ?? 'Sushi Emperor')}</span></div>
      <div class="statgrid section">
        <div class="stat"><div class="k">Franchises</div><div class="v">${totalFr}</div></div>
        <div class="stat"><div class="k">Franchise sales</div><div class="v">${pps.toFixed(1)} <span class="small">pcs/s</span></div></div>
        <div class="stat"><div class="k">Royalties</div><div class="v">${yen(pps * roy)}<span class="small">/s</span></div></div>
        <div class="stat"><div class="k">HQ floors</div><div class="v">${s.hq * 5}</div></div>
        <div class="stat"><div class="k">Brand</div><div class="v">${Math.round(s.brand)}</div></div></div>
      <div class="section"><h3>🏢 Headquarters <span class="chip">Lv ${s.hq}/${HQ_MAX}</span></h3><div class="card spread"><span class="small">Each level: +8% guests everywhere, +10% franchise output, +15% research, +1,000 storage. Visit the tower in Shinjuku!</span>
        <button class="btn ${s.hq < HQ_MAX && s.cash >= hqCost(s.hq) ? 'green' : ''}" data-act="hq" ${s.hq >= HQ_MAX ? 'disabled' : ''}>${s.hq >= HQ_MAX ? 'Complete' : 'Expand ' + yen(hqCost(s.hq))}</button></div></div>
      <div class="section"><h3>🏭 Production & logistics</h3><div class="grid g2">${facs}</div></div>
      <div class="section"><h3>🏪 Franchises & international cities</h3><div class="grid g3">${cities}</div></div>
      <div class="section"><h3>🤝 Rival buyouts</h3><div class="grid g3">${buyouts}</div></div>`;
  }

  // ------------------------------------------------------------ finances
  r_finances(): string {
    const s = this.s;
    const { wages, rent } = sim.dailyCosts(s);
    const upkeep = Object.values(s.restaurants).map((r) => {
      const w = sim.staffAt(s, r.id).reduce((a, e) => a + e.wage, 0), rent = PROPERTIES[r.id].rent;
      return `<tr><td>${esc(r.name)} <span class="tiny muted">wages ${yen(w)} · rent ${yen(rent)}</span></td><td>-${yenExact(w + rent)}</td></tr>`;
    }).join('') + (s.staff.some((e) => !e.restaurant) ? `<tr><td>Reserve staff (half pay)</td><td>-${yenExact(s.staff.filter((e) => !e.restaurant).reduce((a, e) => a + e.wage * 0.5, 0))}</td></tr>` : '');
    const t = s.today;
    const profit = t.revenue - t.expenses, after = profit - wages - rent;
    return `<h2>Finances</h2>
      <div class="receipt"><div class="shop">${esc(s.player.company)}</div><div class="meta">DAY ${s.day} · ${clockStr(s.minute)} · 本日の売上</div><hr>
        <div class="ln"><span>Sales today</span><span>${yenExact(t.revenue)}</span></div>
        <div class="ln"><span>Spending (ingredients, upgrades, property)</span><span>-${yenExact(t.expenses)}</span></div>
        <div class="ln"><span>Guests · pieces</span><span>${exact(t.customers)} · ${exact(t.pieces)}</span></div><hr>
        <div class="ln tot"><span>So far today</span><span>${yen(profit)}</span></div>
        <div class="ln"><span>Wages due at midnight</span><span>-${yenExact(wages)}</span></div>
        <div class="ln"><span>Rent due at midnight</span><span>-${yenExact(rent)}</span></div>
        <div class="ln"><span>Projected day</span><span>${yen(after)}</span></div><hr>
        <div class="ln"><span>Cash on hand</span><span>${yenExact(s.cash)}</span></div>
        <div class="stamp ${after >= 0 ? 'black' : ''}">${after >= 0 ? '黒字' : '赤字'}</div></div>
      <div class="section"><h3>Daily upkeep by location <button class="btn small ghost" data-act="tab" data-arg="stats">Charts & history 統</button></h3>
        <div class="card"><table class="kv">${upkeep}</table></div></div>`;
  }

  // ------------------------------------------------------------ awards
  r_awards(): string {
    const s = this.s, L = s.lifetime;
    const list: string[] = [];
    for (let i = 0; i < s.milestoneIndex + 4; i++) {
      const m = milestone(i), done = i < s.milestoneIndex, cur = i === s.milestoneIndex;
      const prev = i ? milestone(i - 1).pieces : 0;
      list.push(`<div class="card ms ${done ? 'done' : cur ? 'avail' : 'locked'}"><span class="medal">${done ? '🏅' : cur ? '🎯' : '🔒'}</span>
        <div style="flex:1"><div class="spread"><b>${esc(m.title)}</b><span class="small">${short(m.pieces)} 🍣</span></div><div class="tiny muted">${esc(m.reward.text)}</div>
        ${cur ? bar((L.pieces - prev) / (m.pieces - prev), 'gold') : ''}</div></div>`);
    }
    const got = ACHIEVEMENTS.filter((a) => isUnlocked(s, a)).length;
    const cats = (Object.keys(CAT) as AchCategory[]).map((c) => {
      const items = ACHIEVEMENTS.filter((a) => a.category === c);
      if (!items.length) return '';
      const cards = items.map((a) => {
        const u = isUnlocked(s, a), hide = !u && c === 'secrets';
        return `<div class="ach ${u ? 'got' : ''}" title="${hide ? 'A secret achievement' : esc(a.desc)}">
          <span class="ach-e">${hide ? '？' : a.emoji}</span><div class="ach-t"><b>${hide ? '???' : esc(a.title)}</b>
          <div class="tiny">${hide ? 'Keep playing to discover it.' : esc(a.desc)}</div><div class="tiny ach-r">${hide ? '' : esc(rewardText(a))}</div></div>
          <span class="tier ${a.tier}" title="${a.tier}">${TIER[a.tier]}</span></div>`;
      }).join('');
      return `<div class="section"><h3>${CAT[c]} <span class="tiny muted">${items.filter((a) => isUnlocked(s, a)).length}/${items.length}</span></h3><div class="ach-grid">${cards}</div></div>`;
    }).join('');
    return `<div class="spread"><h2>Awards 表彰</h2><span class="chip on">${got} / ${ACHIEVEMENTS.length} achievements</span></div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:22px;align-items:start">
        <div><h3>Milestones</h3><div class="grid">${list.join('')}</div><div class="tiny muted" style="margin-top:6px">Milestones never end — beyond one billion the empire keeps growing. Exact lifetime totals live in Statistics 統.</div></div>
        <div>${cats}</div></div>`;
  }

  // ------------------------------------------------------------ quests
  r_quests(): string {
    const s = this.s, q = s.quests;
    const b = streakBonus(q, s);
    const cards = (q?.list ?? []).map((x) => {
      const failed = !!x.meta?.failed && !x.done;
      const frac = Math.min(1, x.progress / x.target);
      return `<div class="card quest ${x.claimed ? 'claimed' : x.done ? 'done' : failed ? 'failed' : ''}">
        <div class="spread"><b>${esc(x.title)}</b>${x.claimed ? '<i class="mini-stamp">済</i>' : ''}</div><div class="small muted">${esc(x.desc)}</div>
        ${failed ? '<div class="small bad">Missed today — a new set arrives tomorrow.</div>' : bar(frac, 'gold')}
        <div class="spread small"><span>${Number.isInteger(x.target) ? `${exact(Math.min(x.progress, x.target))} / ${exact(x.target)}` : `${Math.min(x.progress, x.target).toFixed(1)} / ${x.target}`}</span><span>+${yen(x.reward.cash)} · +${x.reward.rp} RP</span></div>
        ${x.done && !x.claimed ? `<button class="btn" data-act="claim" data-arg="${esc(x.id)}">Claim reward</button>` : ''}</div>`;
    }).join('');
    return `<h2>Quests 依頼</h2>
      <p class="small muted">Three fresh requests from the neighborhood every day. Claim all three for a streak bonus that grows for ${STREAK_CAP} days.</p>
      <div class="grid g3">${cards || '<div class="card muted">New requests arrive with the morning.</div>'}</div>
      <div class="card section spread"><span><b>Streak 連続 ${q?.streak ?? 0}</b> <span class="small muted">days in a row with every request claimed</span></span>
        <span class="small">Today's full-set bonus: <b>+${yen(b.cash)} · +${b.rp} RP</b></span></div>`;
  }

  // ------------------------------------------------------------ catering
  r_catering(): string {
    const s = this.s, cs = contracts(s);
    const when = (d: { day: number; minute: number }) => `Day ${d.day} ${clockStr(d.minute)}`;
    const missing = (recipe: string) => Object.entries(RECIPES[recipe].ingredients).filter(([k, n]) => s.inventory[k as IngredientId] < (n ?? 0)).map(([k]) => INGREDIENTS[k as IngredientId].name);
    const full = cs.active.length >= MAX_ACTIVE;
    const slip = (c: (typeof cs.offers)[number], body: string) => {
      const cl = CLIENTS[c.client];
      return `<div class="banquet"><div class="bq-head"><span class="bq-e">${cl.emoji}</span><div><b>${esc(cl.name)}</b><div class="tiny">${esc(cl.desc)}</div></div></div>
        <div class="bq-order"><span class="qty">${c.qty}×</span> ${esc(RECIPES[c.recipe].name)} <span class="tiny muted">${RECIPES[c.recipe].jp}</span></div>
        <div class="ln"><span>Kitchen</span><span>${esc(s.restaurants[c.restaurant]?.name ?? PROPERTIES[c.restaurant].name)}</span></div>
        <div class="ln"><span>Deliver by</span><span>${when(c.deadline)}</span></div>
        <div class="ln"><span>Payout</span><b>${yenExact(c.payout)}</b></div>
        <div class="ln bad"><span>If missed</span><span>−${c.repPenalty.toFixed(2)}★</span></div>${body}</div>`;
    };
    const offers = cs.offers.map((o) => slip(o, full ? `<button class="btn" disabled>Kitchen full (${cs.active.length}/${MAX_ACTIVE})</button>` : `<button class="btn" data-act="accept" data-arg="${o.id}">Accept 承る</button>`)).join('');
    const active = cs.active.map((c) => {
      const miss = missing(c.recipe);
      return slip(c, `${bar(c.done / c.qty, 'gold')}<div class="small">${exact(c.done)} / ${exact(c.qty)} delivered</div>
        ${miss.length ? `<div class="small bad">Out of ${miss.join(', ')} — the kitchen can't cook this order!</div>` : ''}`);
    }).join('');
    return `<div class="spread"><h2>Catering 宴</h2><span class="small">Completed <b>${cs.completed}</b> · Failed <b class="${cs.failed ? 'bad' : ''}">${cs.failed}</b></span></div>
      <p class="small muted">Big banquet orders. While one is active, that restaurant's kitchen sets aside part of its output for it. Deliver on time for a fat payout and reputation; miss it and the stars drop.</p>
      <div class="section"><h3>In the kitchen</h3><div class="grid g3">${active || '<div class="card muted small">No active banquets. Accept an offer below.</div>'}</div></div>
      <div class="section"><h3>Offers</h3><div class="grid g3">${offers || '<div class="card muted small">No offers today — new clients call tomorrow.</div>'}</div></div>`;
  }
}
