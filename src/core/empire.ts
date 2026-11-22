// Empire layer for the tycoon UI: per-restaurant KPI snapshots with a health light, de-duplicated alerts with
// one-click fixes, and managed restaurants that run themselves (auto-hire, auto-price). Pure logic on GameState.
import * as A from './actions';
import { toast } from './bus';
import { AREAS, CONCEPTS, ConceptId, PROPERTIES, RECIPES, ROLES, Region, Role } from './data';
import { yen } from './format';
import * as sim from './sim';
import { GameState, RestDay } from './state';

const PIECES_PER_GUEST = 3;
const PRICE_MIN = 0.9, PRICE_MAX = 1.6; // auto-pricing band of a managed restaurant

// ---------------------------------------------------------------- KPIs
export interface RestKPI {
  id: string; name: string; area: string; areaName: string; region: Region; walkable: boolean;
  concept: ConceptId; kind: string;
  revToday: number; profitYesterday: number | null;
  rev7: number[]; profit7: number[]; // last 7 closed days (oldest first), may be shorter for new restaurants
  load: number; // demand ÷ kitchen capacity at a typical busy hour (>1 = losing guests, <0.5 = idle)
  stars: number; satisfaction: number;
  staff: Record<Role, [number, number]>; // [have, slots]
  automated: boolean; // has a chef
  managed: boolean; // a manager on staff or ops_center research: auto-hires and auto-prices
  health: 'good' | 'warn' | 'bad';
  lostToday: number; guestsToday: number;
  log: string[];
}

const profit = (d: RestDay) => d.rev - d.cost;
const managed = (s: GameState, id: string) => s.research.includes('ops_center') || sim.staffAt(s, id, 'manager').length > 0;

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

export function restaurantKPIs(s: GameState): RestKPI[] {
  return Object.values(s.restaurants).map((r) => {
    const p = PROPERTIES[r.id], area = AREAS[p.district];
    const cap = capacityPPS(s, r.id);
    const load = cap > 0 ? demandPPS(s, r.id) / cap : (sim.isAutomated(s, r.id) ? 0 : 1);
    const last7 = r.hist.slice(-7);
    const staff = {} as Record<Role, [number, number]>;
    for (const role of Object.keys(ROLES) as Role[]) staff[role] = [sim.staffAt(s, r.id, role).length, sim.slotsFor(s, r.id, role)];
    const automated = sim.isAutomated(s, r.id), profitYesterday = last7.length ? profit(last7[last7.length - 1]) : null;
    const health = !automated || (profitYesterday ?? 0) < 0 ? 'bad'
      : load > 1.25 || load < 0.45 || r.day.lost > 0.25 * r.day.guests || sim.understaffed(s, r.id) ? 'warn' : 'good';
    return {
      id: r.id, name: r.name, area: p.district, areaName: area.name, region: area.region, walkable: area.walkable,
      concept: r.concept, kind: p.kind,
      revToday: r.day.rev, profitYesterday,
      rev7: last7.map((d) => d.rev), profit7: last7.map(profit),
      load, stars: r.reputation, satisfaction: r.satisfaction,
      staff, automated, managed: managed(s, r.id), health, lostToday: r.day.lost, guestsToday: r.day.guests, log: [...r.log],
    };
  });
}

export interface EmpireTotals {
  cash: number; restaurants: number; staff: number; revToday: number; profitYesterday: number;
  rev7: number[]; profit7: number[]; pieces7: number[]; // empire-wide daily series (from s.history)
  piecesPerSec: number; avgStars: number; areas: number;
  stars7: number[]; // empire average rating at each recent day end
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
    stars7: h.filter((d) => d.avgStars !== undefined).map((d) => d.avgStars!), // old saves lack ratings: skip, don't fake 0
  };
}

// ---------------------------------------------------------------- alerts
export type Severity = 'critical' | 'warning' | 'opportunity';
export type FixId = 'hireMissing' | 'hireChef' | 'priceUp' | 'priceDown';
export interface Alert {
  id: string; severity: Severity; kind: string; restIds: string[]; text: string;
  fix?: { id: FixId; label: string; cost: number };
  propId?: string; // opportunity: the lot to buy (UI opens the buy dialog)
  areaId?: string; // opportunity: the area to unlock (UI opens the map there)
}

const names = (s: GameState, ids: string[]) => ids.length === 1 ? s.restaurants[ids[0]].name : `${ids.length} restaurants`;

/** Cost of hiring n people of a role the way hireBest will: best candidates first, then fresh ones (priced at max skill). */
function hireCostFor(s: GameState, role: Role, n: number): number {
  const pool = s.candidates.filter((e) => e.role === role).sort((a, b) => b.skill - a.skill);
  let cost = 0;
  for (let i = 0; i < n; i++) cost += pool[i] ? sim.hireCost(pool[i]) : Math.round(ROLES[role].hireCost * 2.2);
  return cost;
}
const bestCandidateCost = (s: GameState, role: Role) => hireCostFor(s, role, 1);

/** Current alerts, grouped so 20 restaurants with the same problem become one slip. Sorted by severity. */
export function alerts(s: GameState): Alert[] {
  const k = restaurantKPIs(s);
  const out: Alert[] = [];
  const group = (pred: (x: RestKPI) => boolean) => k.filter(pred).map((x) => x.id);

  const unstaffed = group((x) => !x.automated);
  if (unstaffed.length) {
    const cost = hireCostFor(s, 'chef', unstaffed.length) + hireCostFor(s, 'server', unstaffed.filter((id) => sim.understaffed(s, id)).length);
    out.push({ id: 'unstaffed', severity: 'critical', kind: 'staff', restIds: unstaffed, text: `${names(s, unstaffed)} ${unstaffed.length === 1 ? 'has' : 'have'} no chef and ${unstaffed.length === 1 ? 'sells' : 'sell'} nothing.`, fix: { id: 'hireMissing', label: 'Hire crew', cost } });
  }
  const understaffed = group((x) => x.automated && sim.understaffed(s, x.id));
  if (understaffed.length) out.push({ id: 'understaffed', severity: 'warning', kind: 'staff', restIds: understaffed, text: `${names(s, understaffed)}: no server, so the chef also works the counter and cooks slower.`, fix: { id: 'hireMissing', label: understaffed.length === 1 ? 'Hire a server' : 'Hire a server each', cost: hireCostFor(s, 'server', understaffed.length) } });
  const overloaded = group((x) => x.automated && x.load > 1.25);
  if (overloaded.length) {
    const canHire = overloaded.filter((id) => sim.staffAt(s, id, 'chef').length < sim.slotsFor(s, id, 'chef'));
    out.push(canHire.length
      ? { id: 'overload', severity: 'warning', kind: 'load', restIds: overloaded, text: `${names(s, overloaded)}: kitchen overloaded, guests walk away.`, fix: { id: 'hireChef', label: 'Hire a chef each', cost: hireCostFor(s, 'chef', canHire.length) } }
      : { id: 'overload', severity: 'opportunity', kind: 'load', restIds: overloaded, text: `${names(s, overloaded)}: full kitchen and still turning guests away. Raise prices.`,
          ...(overloaded.some((id) => s.restaurants[id].priceMult < 2.45) ? { fix: { id: 'priceUp' as FixId, label: 'Prices +10%', cost: 0 } } : {}) });
  }
  const idle = group((x) => x.automated && x.load < 0.45 && s.restaurants[x.id].priceMult > PRICE_MIN + 0.01); // auto-pricing can clear it
  if (idle.length) out.push({ id: 'idle', severity: 'opportunity', kind: 'load', restIds: idle, text: `${names(s, idle)}: kitchens mostly idle. Lower prices or market to fill seats.`, fix: { id: 'priceDown', label: 'Prices −10%', cost: 0 } });
  const losing = group((x) => x.profitYesterday !== null && x.profitYesterday < 0);
  if (losing.length) out.push({ id: 'loss', severity: 'warning', kind: 'money', restIds: losing, text: `${names(s, losing)} lost money yesterday. Check staffing, prices and format.` });
  const lots = Object.values(PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district)).sort((a, b) => a.price - b.price);
  if (lots[0] && s.cash > lots[0].price * 2.5) out.push({ id: 'expand', severity: 'opportunity', kind: 'expand', restIds: [], text: `You can afford a new restaurant: ${lots[0].name} (${yen(lots[0].price)}).`, propId: lots[0].id });
  const areas = Object.values(AREAS).filter((a) => !s.districts.includes(a.id) && s.lifetime.pieces >= a.unlock.pieces && (!a.unlock.chapter2 || s.flags.chapter2) && s.cash > a.unlock.cost * 1.5);
  if (areas[0]) out.push({ id: 'area', severity: 'opportunity', kind: 'expand', restIds: [], text: `New market available: ${areas[0].name} (${yen(areas[0].unlock.cost)} permit).`, areaId: areas[0].id });
  const rank: Record<Severity, number> = { critical: 0, warning: 1, opportunity: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------- fixes & hiring
/** Hire the best available candidate of a role into a restaurant (creates a fresh candidate if none). */
export function hireBest(s: GameState, restId: string, role: Role, quiet = false): string | null {
  if (sim.staffAt(s, restId, role).length >= sim.slotsFor(s, restId, role)) return 'No free slot';
  let c = s.candidates.filter((e) => e.role === role).sort((a, b) => b.skill - a.skill)[0];
  if (!c) { c = sim.makeCandidate(s, role); s.candidates.push(c); }
  return A.hire(s, c.id, restId, quiet);
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
        if (!sim.staffAt(s, id, 'chef').length) err = hireBest(s, id, 'chef', true) ?? err;
        if (sim.understaffed(s, id)) err = hireBest(s, id, 'server', true) ?? err;
        break;
      case 'hireChef': if (sim.staffAt(s, id, 'chef').length < sim.slotsFor(s, id, 'chef')) err = hireBest(s, id, 'chef', true) ?? err; break;
      case 'priceUp': A.setPrice(s, id, s.restaurants[id].priceMult * 1.1); break;
      case 'priceDown': A.setPrice(s, id, s.restaurants[id].priceMult / 1.1); break;
    }
  }
  if (!err) toast(`${a.fix.label}: done at ${Math.max(1, a.restIds.length)} restaurant${a.restIds.length === 1 ? '' : 's'}`, 'good', 'check');
  return err;
}

// ---------------------------------------------------------------- managed restaurants
const lastHour = new WeakMap<GameState, number>(); // per save: a new game/load never skips an hour
const receipt = (s: GameState, id: string, text: string) => {
  const r = s.restaurants[id];
  r.log.push(text);
  if (r.log.length > 8) r.log.shift();
};

/** Managed restaurants auto-hire and auto-price once per in-game hour. Call every frame after sim.tick. */
export function tickEmpire(s: GameState): void {
  const hour = Math.floor(s.minute / 60);
  if (hour === lastHour.get(s)) return;
  lastHour.set(s, hour);
  for (const r of Object.values(s.restaurants)) {
    if (!managed(s, r.id)) continue;
    autoHire(s, r.id);
    autoPrice(s, r.id);
  }
}

function affordable(s: GameState, role: Role): boolean {
  // keep a cushion of one full day of wages + rent before hiring automatically
  const { wages, rent } = sim.dailyCosts(s);
  return s.cash > bestCandidateCost(s, role) + (wages + rent);
}

function autoHire(s: GameState, id: string): void {
  const c = sim.conceptOf(s, id);
  const chefs = sim.staffAt(s, id, 'chef').length, slots = sim.slotsFor(s, id, 'chef');
  const cap = capacityPPS(s, id), dem = demandPPS(s, id);
  const wants: Role[] = [];
  // deliberately a bit conservative (hire only once clearly overloaded): a watchful owner does better
  if (chefs === 0 || (dem > cap * 1.2 && chefs < slots)) wants.push('chef');
  if (c.needsServer) {
    const servers = sim.staffAt(s, id, 'server').length;
    if ((servers === 0 && !sim.staffAt(s, id, 'manager').length) || (servers < Math.min(sim.slotsFor(s, id, 'server'), Math.ceil((chefs + 1) / 3)))) wants.push('server');
  }
  for (const role of wants) {
    if (!affordable(s, role)) { receipt(s, id, `Wanted a ${role} but kept a cash cushion`); continue; }
    if (hireBest(s, id, role, true) === null) receipt(s, id, `Hired a ${role}`);
  }
}

function autoPrice(s: GameState, id: string): void {
  const r = s.restaurants[id];
  const cap = capacityPPS(s, id);
  if (cap <= 0) return;
  const load = demandPPS(s, id) / cap;
  const before = r.priceMult;
  // conservative band: never prices below 90% or above 160% on its own
  if (load > 1.15 && r.priceMult < PRICE_MAX) A.setPrice(s, id, r.priceMult + 0.05);
  else if (load < 0.6 && r.priceMult > PRICE_MIN) A.setPrice(s, id, r.priceMult - 0.05);
  if (r.priceMult !== before) receipt(s, id, `Prices ${r.priceMult > before ? 'up' : 'down'} to ${Math.round(r.priceMult * 100)}%`);
}

export const conceptName = (c: ConceptId) => CONCEPTS[c].name;
