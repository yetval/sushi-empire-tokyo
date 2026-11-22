// Empire layer for the tycoon UI: per-restaurant KPI snapshots, de-duplicated alerts with one-click fixes,
// and the "house rules" policy engine (auto-hire, smart pricing). Pure logic on GameState.
import * as A from './actions';
import { toast } from './bus';
import { AREAS, CONCEPTS, ConceptId, DAY_SECONDS, INGREDIENTS, INGREDIENT_IDS, IngredientId, PROPERTIES, RECIPES, ROLES, Region, Role } from './data';
import { yen } from './format';
import * as sim from './sim';
import { GameState, RestDay } from './state';

const PIECES_PER_GUEST = 3;

// ---------------------------------------------------------------- KPIs
export interface RestKPI {
  id: string; name: string; area: string; areaName: string; region: Region; walkable: boolean;
  concept: ConceptId; kind: string;
  revToday: number; profitYesterday: number | null;
  rev7: number[]; profit7: number[]; // last 7 closed days (oldest first), may be shorter for new restaurants
  load: number; // demand ÷ kitchen capacity at a typical busy hour (>1 = losing guests, <0.5 = idle)
  stockDays: number; // days of ingredients left for this menu at current demand (Infinity if not consuming)
  stars: number; satisfaction: number; cleanliness: number;
  staff: Record<Role, [number, number]>; // [have, slots]
  automated: boolean; lostToday: number; guestsToday: number;
  policy: { autoHire: boolean; autoPrice: boolean }; policiesAvailable: boolean;
  log: string[];
}

const profit = (d: RestDay) => d.rev - d.cost;

/** Pieces per real second a restaurant sells at a typical busy hour (capped by its kitchen when automated). */
export function demandPPS(s: GameState, id: string): number {
  return (sim.demandPerMin(s, id, 12 * 60) / 1.5) / 60 * PIECES_PER_GUEST;
}
function capacityPPS(s: GameState, id: string): number {
  const r = s.restaurants[id];
  const menu = r.menu.filter((m) => RECIPES[m]);
  const prep = menu.length ? menu.reduce((a, m) => a + RECIPES[m].prep / 3.5, 0) / menu.length : 1;
  return sim.kitchenRate(s, id) / prep;
}

/** Real-second ingredient use across the empire at current demand (automated restaurants only). */
export function ingredientUsePerSec(s: GameState): Record<IngredientId, number> {
  const use = Object.fromEntries(INGREDIENT_IDS.map((k) => [k, 0])) as Record<IngredientId, number>;
  for (const id of Object.keys(s.restaurants)) {
    if (!sim.isAutomated(s, id)) continue;
    const menu = s.restaurants[id].menu.filter((m) => RECIPES[m]);
    if (!menu.length) continue;
    const pps = Math.min(demandPPS(s, id), capacityPPS(s, id)) * 0.85;
    for (const m of menu) for (const [k, n] of Object.entries(RECIPES[m].ingredients)) use[k as IngredientId] += (pps / menu.length) * (n ?? 0);
  }
  return use;
}

export function restaurantKPIs(s: GameState): RestKPI[] {
  const use = ingredientUsePerSec(s);
  return Object.values(s.restaurants).map((r) => {
    const p = PROPERTIES[r.id], area = AREAS[p.district];
    const cap = capacityPPS(s, r.id);
    const load = cap > 0 ? demandPPS(s, r.id) / cap : (sim.isAutomated(s, r.id) ? 0 : 1);
    let stockDays = Infinity;
    for (const m of r.menu) for (const k of Object.keys(RECIPES[m]?.ingredients ?? {})) {
      const u = use[k as IngredientId];
      if (u > 0) stockDays = Math.min(stockDays, s.inventory[k as IngredientId] / (u * DAY_SECONDS));
    }
    const last7 = r.hist.slice(-7);
    const staff = {} as Record<Role, [number, number]>;
    for (const role of ['chef', 'server', 'cleaner', 'manager'] as Role[]) staff[role] = [sim.staffAt(s, r.id, role).length, sim.slotsFor(s, r.id, role)];
    return {
      id: r.id, name: r.name, area: p.district, areaName: area.name, region: area.region, walkable: area.walkable,
      concept: r.concept, kind: p.kind,
      revToday: r.day.rev, profitYesterday: last7.length ? profit(last7[last7.length - 1]) : null,
      rev7: last7.map((d) => d.rev), profit7: last7.map(profit),
      load, stockDays, stars: r.reputation, satisfaction: r.satisfaction, cleanliness: r.cleanliness,
      staff, automated: sim.isAutomated(s, r.id), lostToday: r.day.lost, guestsToday: r.day.guests,
      policy: { ...r.policy }, policiesAvailable: A.canUsePolicies(s, r.id), log: [...r.log],
    };
  });
}

export interface EmpireTotals {
  cash: number; restaurants: number; staff: number; revToday: number; profitYesterday: number;
  rev7: number[]; profit7: number[]; pieces7: number[]; // empire-wide daily series (from s.history)
  piecesPerSec: number; avgStars: number; areas: number;
}
export function empireTotals(s: GameState): EmpireTotals {
  const rs = Object.values(s.restaurants);
  const h = s.history.slice(-7);
  let pps = sim.franchisePPS(s);
  for (const r of rs) if (sim.isAutomated(s, r.id)) pps += Math.min(demandPPS(s, r.id), capacityPPS(s, r.id)) * 0.85;
  return {
    cash: s.cash, restaurants: rs.length, staff: s.staff.length, revToday: s.today.revenue,
    profitYesterday: h.length ? h[h.length - 1].revenue - h[h.length - 1].expenses : 0,
    rev7: h.map((d) => d.revenue), profit7: h.map((d) => d.revenue - d.expenses), pieces7: h.map((d) => d.pieces),
    piecesPerSec: pps, avgStars: rs.reduce((a, r) => a + r.reputation, 0) / Math.max(1, rs.length),
    areas: new Set(rs.map((r) => PROPERTIES[r.id].district)).size,
  };
}

// ---------------------------------------------------------------- alerts
export type Severity = 'critical' | 'warning' | 'opportunity';
export type FixId = 'hireMissing' | 'hireChef' | 'hireCleaner' | 'restock' | 'priceUp' | 'priceDown';
export interface Alert {
  id: string; severity: Severity; kind: string; restIds: string[]; text: string;
  fix?: { id: FixId; label: string; cost: number };
  rule?: 'autoHire' | 'autoPrice' | 'autoRestock'; // the house rule that would prevent this
}

const names = (s: GameState, ids: string[]) => ids.length === 1 ? s.restaurants[ids[0]].name : `${ids.length} restaurants`;

function bestCandidateCost(s: GameState, role: Role): number {
  const c = s.candidates.filter((e) => e.role === role).sort((a, b) => b.skill - a.skill)[0];
  return c ? sim.hireCost(c) : ROLES[role].hireCost;
}

/** Current alerts, grouped so 20 restaurants with the same problem become one slip. Sorted by severity. */
export function alerts(s: GameState): Alert[] {
  const k = restaurantKPIs(s);
  const out: Alert[] = [];
  const group = (pred: (x: RestKPI) => boolean) => k.filter(pred).map((x) => x.id);
  const playerHere = (id: string) => id === 'asakusa_stand' && s.lifetime.pieces < 200; // the starter stand is meant to be hand-run at first

  const unstaffed = group((x) => !x.automated && !playerHere(x.id));
  if (unstaffed.length) {
    const cost = unstaffed.reduce((a, id) => a + (sim.staffAt(s, id, 'chef').length ? 0 : bestCandidateCost(s, 'chef')) + (sim.conceptOf(s, id).needsServer && !sim.staffAt(s, id, 'server').length && !sim.staffAt(s, id, 'manager').length ? bestCandidateCost(s, 'server') : 0), 0);
    out.push({ id: 'unstaffed', severity: 'critical', kind: 'staff', restIds: unstaffed, text: `${names(s, unstaffed)} ${unstaffed.length === 1 ? 'has' : 'have'} no kitchen crew and earn nothing.`, fix: { id: 'hireMissing', label: 'Hire crew', cost }, rule: 'autoHire' });
  }
  const use = ingredientUsePerSec(s);
  const low = INGREDIENT_IDS.filter((i) => use[i] > 0 && s.inventory[i] / (use[i] * DAY_SECONDS) < 0.35);
  if (low.length && !sim.autoRestockOn(s)) {
    const cost = Math.round(low.reduce((a, i) => a + use[i] * DAY_SECONDS * sim.ingredientPrice(s, i), 0));
    out.push({ id: 'stock', severity: low.some((i) => s.inventory[i] < 5) ? 'critical' : 'warning', kind: 'stock', restIds: group((x) => x.stockDays < 0.35), text: `Low on ${low.map((i) => INGREDIENTS[i].name.toLowerCase()).slice(0, 3).join(', ')}${low.length > 3 ? '…' : ''}: kitchens will stall.`, fix: { id: 'restock', label: 'Restock 1 day', cost }, rule: 'autoRestock' });
  }
  const overloaded = group((x) => x.automated && x.load > 1.25);
  if (overloaded.length) {
    const canHire = overloaded.filter((id) => sim.staffAt(s, id, 'chef').length < sim.slotsFor(s, id, 'chef'));
    out.push(canHire.length
      ? { id: 'overload', severity: 'warning', kind: 'load', restIds: overloaded, text: `${names(s, overloaded)}: kitchen overloaded, guests walk away.`, fix: { id: 'hireChef', label: 'Hire a chef each', cost: canHire.length * bestCandidateCost(s, 'chef') }, rule: 'autoHire' }
      : { id: 'overload', severity: 'opportunity', kind: 'load', restIds: overloaded, text: `${names(s, overloaded)}: full kitchen and still turning guests away. Raise prices.`, fix: { id: 'priceUp', label: 'Prices +10%', cost: 0 }, rule: 'autoPrice' });
  }
  const idle = group((x) => x.automated && x.load < 0.45 && s.restaurants[x.id].priceMult > 0.85);
  if (idle.length) out.push({ id: 'idle', severity: 'opportunity', kind: 'load', restIds: idle, text: `${names(s, idle)}: kitchens mostly idle. Lower prices or market to fill seats.`, fix: { id: 'priceDown', label: 'Prices −10%', cost: 0 }, rule: 'autoPrice' });
  const dirty = group((x) => x.cleanliness < 0.5 && sim.staffAt(s, x.id, 'cleaner').length === 0);
  if (dirty.length) out.push({ id: 'dirty', severity: 'warning', kind: 'clean', restIds: dirty, text: `${names(s, dirty)} ${dirty.length === 1 ? 'is' : 'are'} getting grubby. Guests notice.`, fix: { id: 'hireCleaner', label: 'Hire cleaners', cost: dirty.length * bestCandidateCost(s, 'cleaner') }, rule: 'autoHire' });
  const losing = group((x) => x.profitYesterday !== null && x.profitYesterday < 0);
  if (losing.length) out.push({ id: 'loss', severity: 'warning', kind: 'money', restIds: losing, text: `${names(s, losing)} lost money yesterday. Check staffing, prices and format.` });
  const lots = Object.values(PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district)).sort((a, b) => a.price - b.price);
  if (lots[0] && s.cash > lots[0].price * 2.5) out.push({ id: 'expand', severity: 'opportunity', kind: 'expand', restIds: [], text: `You can afford a new restaurant: ${lots[0].name} (${yen(lots[0].price)}).` });
  const areas = Object.values(AREAS).filter((a) => !s.districts.includes(a.id) && s.lifetime.pieces >= a.unlock.pieces && (!a.unlock.chapter2 || s.flags.chapter2) && s.cash > a.unlock.cost * 1.5);
  if (areas[0]) out.push({ id: 'area', severity: 'opportunity', kind: 'expand', restIds: [], text: `New market available: ${areas[0].name} (${yen(areas[0].unlock.cost)} permit).` });
  const rank: Record<Severity, number> = { critical: 0, warning: 1, opportunity: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------- fixes & hiring
/** Hire the best available candidate of a role into a restaurant (creates a fresh candidate if none). */
export function hireBest(s: GameState, restId: string, role: Role): string | null {
  if (sim.staffAt(s, restId, role).length >= sim.slotsFor(s, restId, role)) return 'No free slot';
  let c = s.candidates.filter((e) => e.role === role).sort((a, b) => b.skill - a.skill)[0];
  if (!c) { c = sim.makeCandidate(s, role); s.candidates.push(c); }
  return A.hire(s, c.id, restId);
}

/** Apply an alert's one-click fix. Returns an error string or null. */
export function applyFix(s: GameState, a: Alert): string | null {
  if (!a.fix) return 'Nothing to fix automatically';
  if (s.cash < a.fix.cost) return `Need ${yen(a.fix.cost)}`;
  let err: string | null = null;
  for (const id of a.restIds.length ? a.restIds : []) {
    if (!s.restaurants[id]) continue;
    switch (a.fix.id) {
      case 'hireMissing':
        if (!sim.staffAt(s, id, 'chef').length) err = hireBest(s, id, 'chef') ?? err;
        if (sim.conceptOf(s, id).needsServer && !sim.staffAt(s, id, 'server').length && !sim.staffAt(s, id, 'manager').length) err = hireBest(s, id, 'server') ?? err;
        break;
      case 'hireChef': err = hireBest(s, id, 'chef') ?? err; break;
      case 'hireCleaner': err = hireBest(s, id, 'cleaner') ?? err; break;
      case 'priceUp': A.setPrice(s, id, s.restaurants[id].priceMult * 1.1); break;
      case 'priceDown': A.setPrice(s, id, s.restaurants[id].priceMult / 1.1); break;
    }
  }
  if (a.fix.id === 'restock') {
    const use = ingredientUsePerSec(s);
    for (const i of INGREDIENT_IDS) if (use[i] > 0) sim.buyIngredient(s, i, Math.ceil(use[i] * DAY_SECONDS) - s.inventory[i], true);
  }
  return err;
}

// ---------------------------------------------------------------- house rules (policies)
let lastHour = -1;
const receipt = (s: GameState, id: string, text: string) => {
  const r = s.restaurants[id];
  r.log.push(text);
  if (r.log.length > 8) r.log.shift();
};

/** Run house rules once per in-game hour. Call every frame after sim.tick. */
export function tickEmpire(s: GameState): void {
  const hour = Math.floor(s.minute / 60);
  if (hour === lastHour) return;
  lastHour = hour;
  for (const r of Object.values(s.restaurants)) {
    if (!A.canUsePolicies(s, r.id)) continue;
    if (r.policy.autoHire) autoHire(s, r.id);
    if (r.policy.autoPrice) autoPrice(s, r.id);
  }
}

function affordable(s: GameState, role: Role): boolean {
  // keep a cushion of three days of wages + rent before hiring automatically
  const { wages, rent } = sim.dailyCosts(s);
  return s.cash > bestCandidateCost(s, role) + 3 * (wages + rent) / 4;
}

function autoHire(s: GameState, id: string): void {
  const c = sim.conceptOf(s, id);
  const chefs = sim.staffAt(s, id, 'chef').length, slots = sim.slotsFor(s, id, 'chef');
  const cap = capacityPPS(s, id), dem = demandPPS(s, id);
  const wants: Role[] = [];
  if (chefs === 0 || (dem > cap * 0.95 && chefs < slots)) wants.push('chef');
  if (c.needsServer) {
    const servers = sim.staffAt(s, id, 'server').length;
    if ((servers === 0 && !sim.staffAt(s, id, 'manager').length) || (servers < Math.min(sim.slotsFor(s, id, 'server'), Math.ceil((chefs + 1) / 3)))) wants.push('server');
  }
  if (s.restaurants[id].cleanliness < 0.7 && sim.staffAt(s, id, 'cleaner').length === 0) wants.push('cleaner');
  for (const role of wants) {
    if (!affordable(s, role)) { receipt(s, id, `Wanted a ${role} but kept a cash cushion`); continue; }
    if (hireBest(s, id, role) === null) receipt(s, id, `Hired a ${role}`);
  }
}

function autoPrice(s: GameState, id: string): void {
  const r = s.restaurants[id];
  const cap = capacityPPS(s, id);
  if (cap <= 0) return;
  const load = demandPPS(s, id) / cap;
  const before = r.priceMult;
  if (load > 1.1 && r.priceMult < 2) A.setPrice(s, id, r.priceMult + 0.05);
  else if (load < 0.65 && r.priceMult > 0.8) A.setPrice(s, id, r.priceMult - 0.05);
  if (r.priceMult !== before) receipt(s, id, `Prices ${r.priceMult > before ? 'up' : 'down'} to ${Math.round(r.priceMult * 100)}%`);
}

/** Turn a house rule on for many restaurants at once (from an alert's "make it a rule"). */
export function applyRule(s: GameState, rule: 'autoHire' | 'autoPrice', restIds: string[]): string | null {
  let ok = 0;
  for (const id of restIds) if (A.setPolicy(s, id, rule, true) === null) ok++;
  if (!ok) return 'Needs a manager at those restaurants, or research Operations Center';
  toast(`掟 House rule on at ${ok} restaurant${ok === 1 ? '' : 's'}`, 'good');
  return null;
}

export const conceptName = (c: ConceptId) => CONCEPTS[c].name;
