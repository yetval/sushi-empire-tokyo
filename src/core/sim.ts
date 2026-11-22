// Economy simulation. Pure logic on GameState: no three.js, no DOM. Unit-tested.
//
// Accounting model (one model for every restaurant, visible or not):
//   demand (customers/min) = traffic × size × reputation × price × hour × marketing × event × brand × (1 - rivals)
//   In the active district part of that demand spawns as visible NPC customers (up to visibleCapPerMin);
//   the remainder arrives as off-screen "takeout" tickets — but only if the restaurant is automated.
//   Every ticket (visible or takeout) is cooked by the same kitchen budget and settled by settle().
//   So switching scenes never duplicates or drops sales.
import { emit, toast } from './bus';
import { seasonDemand, seasonMix, seasonalRecipes } from './seasons';
import { reservedShare } from './contracts';
import {
  AREAS, CAMPAIGNS, CITIES, CLOSE_MIN, CONCEPTS, CUSTOMERS, CustomerType, DAY_SECONDS, DISTRICTS, DistrictId, EVENTS, FACILITIES,
  FRANCHISE_PPS, FRANCHISE_ROYALTY, INGREDIENTS, INGREDIENT_IDS, IngredientId, MAX_SKILL, OPEN_MIN, PROPERTIES,
  RECIPES, RIVALS, recipeCost, ROLES, Role, UPGRADES, milestone, wageFor,
} from './data';
import { Avatar, Employee, GameState, RestaurantState, Ticket, emptyDay } from './state';

/** Minigame score counted as a 'perfect' cook everywhere (sfx, quests, awards). */
export const PERFECT_SCORE = 0.9;

/** Ticket whose cooking minigame is open right now (transient, never saved). Guests waiting on it keep their patience. */
export let cookingTicketId: number | null = null;
export function setCookingTicket(id: number | null) { cookingTicketId = id; }

export let rand = Math.random;
export function setRandom(f: () => number) { rand = f; }
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- modifiers
export interface Mods {
  cook: number; quality: number; ingredientCost: number; demand: number; satisfaction: number;
  xp: number; trainCost: number; offlineEff: number; offlineCapH: number; franchise: number; franchiseCost: number; storage: number;
}

export function mods(s: GameState): Mods {
  const has = (id: string) => s.research.includes(id);
  let cook = 1 + 0.15 * s.facilities.kitchen;
  if (has('knife_skills')) cook += 0.15;
  if (has('conveyor')) cook += 0.3;
  if (has('robot_assist')) cook += 0.5;
  let ic = 1;
  if (has('bulk_buying')) ic -= 0.1;
  if (has('cold_chain')) ic -= 0.1;
  if (has('supply_contracts')) ic -= 0.15;
  ic *= Math.pow(0.94, s.facilities.logistics);
  let demand = 1 + 0.08 * s.hq;
  if (has('loyalty_cards')) demand += 0.1;
  if (has('sushi_ai')) demand += 0.3;
  let fr = 1 + 0.1 * s.facilities.kitchen + 0.1 * s.facilities.logistics + 0.1 * s.hq;
  if (has('regional_offices')) fr += 0.25;
  if (has('global_logistics')) fr += 0.25;
  if (has('sushi_ai')) fr += 0.3;
  const mgrAcademy = has('manager_academy');
  return {
    cook, quality: has('rice_science') ? 0.08 : 0, ingredientCost: Math.max(0.3, ic), demand,
    satisfaction: has('uniforms') ? 0.05 : 0, xp: has('career_ladder') ? 2 : 1, trainCost: has('training_program') ? 0.7 : 1,
    offlineEff: mgrAcademy ? 0.75 : 0.5, offlineCapH: mgrAcademy ? 12 : 8, franchise: fr,
    franchiseCost: has('franchise_manual') ? 0.85 : 1,
    storage: 500 + 600 * (Object.keys(s.restaurants).length - 1) + (has('cold_chain') ? 1000 : 0) + 2000 * s.facilities.logistics + 1000 * s.hq,
  };
}

export const storageUsed = (s: GameState) => INGREDIENT_IDS.reduce((a, k) => a + s.inventory[k], 0);

// ---------------------------------------------------------------- time
export function isOpen(minute: number): boolean { return minute >= OPEN_MIN || minute < CLOSE_MIN; }

/** Demand multiplier by time of day: lunch and dinner rushes. */
export function hourFactor(minute: number): number {
  if (!isOpen(minute)) return 0;
  const h = minute / 60;
  if (h < 2) return 0.5;
  if (h < 10) return 0.55;
  if (h < 11) return 0.9;
  if (h < 14) return 1.5; // lunch rush
  if (h < 17) return 0.85;
  if (h < 21) return 1.4; // dinner rush
  return 0.75;
}

// ---------------------------------------------------------------- staff helpers
/** The restaurant's format (concept). */
export const conceptOf = (s: GameState, restId: string) => CONCEPTS[s.restaurants[restId]?.concept ?? 'bar'] ?? CONCEPTS.bar;

export const staffAt = (s: GameState, restId: string, role?: Role) =>
  s.staff.filter((e) => e.restaurant === restId && (!role || e.role === role));

export function chefSlots(s: GameState, restId: string): number {
  const u = s.restaurants[restId]?.upgrades;
  return PROPERTIES[restId].chefSlots + (u?.extra_station ?? 0) + 2 * (u?.expand ?? 0);
}
export function slotsFor(s: GameState, restId: string, role: Role): number {
  const p = PROPERTIES[restId];
  if (role === 'chef') return Math.max(1, Math.round(chefSlots(s, restId) * conceptOf(s, restId).staff));
  if (role === 'server') return conceptOf(s, restId).needsServer ? p.serverSlots : 0;
  return 1; // cleaner, manager
}

export function isAutomated(s: GameState, restId: string): boolean {
  const st = staffAt(s, restId);
  return st.some((e) => e.role === 'chef') && (!conceptOf(s, restId).needsServer || st.some((e) => e.role === 'server' || e.role === 'manager'));
}
export const hasManager = (s: GameState, restId: string) => staffAt(s, restId, 'manager').length > 0;

/** Kitchen throughput in pieces per real second (chefs only; the player cooks via minigame). */
export function kitchenRate(s: GameState, restId: string): number {
  const r = s.restaurants[restId];
  const chefs = staffAt(s, restId, 'chef');
  const station = 1 + 0.2 * (r.upgrades.station ?? 0);
  let rate = 0;
  for (const c of chefs) rate += 0.36 * (1 + 0.22 * (c.skill - 1));
  return rate * station * mods(s).cook * conceptOf(s, restId).cook * (eventActive(s, 'festival') ? 1.1 : 1);
}

export function kitchenQuality(s: GameState, restId: string): number {
  const r = s.restaurants[restId];
  const chefs = staffAt(s, restId, 'chef');
  const avg = chefs.length ? chefs.reduce((a, c) => a + c.skill, 0) / chefs.length : 1;
  return clamp(0.42 + 0.05 * avg + 0.06 * (r.upgrades.fridge ?? 0) + mods(s).quality + conceptOf(s, restId).quality, 0, 1);
}

/** Effective quality of a manual minigame score (equipment helps the player too). */
export function manualQuality(s: GameState, restId: string, score: number): number {
  const r = s.restaurants[restId];
  return clamp(score * 0.85 + 0.15 + 0.04 * (r.upgrades.fridge ?? 0) + mods(s).quality, 0, 1);
}

/** Seconds per piece when the player cooks (used by UI to set minigame pace). */
export function playerCookSpeed(s: GameState, restId: string): number {
  return (1 + 0.2 * (s.restaurants[restId].upgrades.station ?? 0)) * mods(s).cook;
}

// ---------------------------------------------------------------- demand
export function rivalShare(s: GameState, d: string): number {
  let t = 0;
  for (const rv of Object.values(s.rivals)) t += (rv as Record<string, number>)[d] ?? 0;
  return clamp(t, 0, 0.6);
}

export function campaignBoost(s: GameState, d: string | null): number {
  let b = 0;
  for (const c of s.campaigns) {
    const def = CAMPAIGNS[c.id];
    if (def.scope === 'district' && c.district !== d) continue;
    if (d === null && def.scope !== 'global') continue; // franchises only get global campaigns
    b += def.boost;
  }
  return 1 + Math.min(1.5, b); // stacking campaigns caps at +150%
}

export const eventActive = (s: GameState, id: string) => s.event?.id === id;
export function eventDemand(s: GameState): number { return s.event ? EVENTS[s.event.id].demand : 1; }

export function priceDemand(priceMult: number, elasticity: number): number {
  return Math.pow(priceMult, -elasticity);
}

/** Customers per (real) minute this restaurant attracts right now. */
export function demandPerMin(s: GameState, restId: string, minute = s.minute): number {
  const r = s.restaurants[restId], p = PROPERTIES[restId], d = AREAS[p.district], c = conceptOf(s, restId);
  const rep = 0.4 + 0.25 * r.reputation;
  const sign = (1 + 0.15 * (r.upgrades.sign ?? 0)) * (1 + 0.15 * (r.upgrades.delivery ?? 0));
  const dirty = r.cleanliness < 0.4 ? 0.7 + 0.75 * r.cleanliness : 1;
  return d.traffic * c.traffic * p.size * (1 + 0.25 * (r.upgrades.expand ?? 0)) * rep * sign * dirty * priceDemand(r.priceMult, d.elasticity * c.elasticity) * hourFactor(minute)
    * campaignBoost(s, p.district) * Math.min(2.2, eventDemand(s) * seasonDemand(s)) * (1 + s.brand / 300) * (1 - rivalShare(s, p.district)) * mods(s).demand;
}

/** Max visible (walk-in NPC) customers per minute — limited by how many NPCs we render. */
export function visibleCapPerMin(s: GameState, restId: string): number {
  const p = PROPERTIES[restId];
  const seats = s.restaurants[restId].upgrades.seats ?? 0;
  return ({ stand: 3.5, shop: 5, restaurant: 6.5, flagship: 8 } as const)[p.kind] + seats * 0.4;
}

export function visibleSpawnPerMin(s: GameState, restId: string): number {
  if (!conceptOf(s, restId).walkIn) return 0; // ghost kitchens: delivery only
  return Math.min(demandPerMin(s, restId), visibleCapPerMin(s, restId));
}

export function pickCustomerType(s: GameState, d: string, minute = s.minute, restId?: string): CustomerType {
  const mix = { ...AREAS[d].mix };
  if (restId) for (const [k, w] of Object.entries(conceptOf(s, restId).mix ?? {})) mix[k as CustomerType] = (mix[k as CustomerType] ?? 0) + (w ?? 0);
  for (const [k, w] of Object.entries(seasonMix(s))) mix[k as CustomerType] = (mix[k as CustomerType] ?? 0) + (w ?? 0);
  const h = minute / 60;
  if (s.event?.id === 'tourists') mix.tourist = (mix.tourist ?? 0) * 3;
  if (s.event?.id === 'critic' || rand() < 0.01) mix.critic = (mix.critic ?? 0) + 0.5;
  if (s.campaigns.some((c) => c.id === 'influencer')) mix.influencer = (mix.influencer ?? 0) + 1.5;
  if (s.campaigns.some((c) => c.id === 'social')) mix.student = (mix.student ?? 0) + 2;
  if (s.lifetime.pieces > 5_000 && s.flags.vipEnabled !== false) mix.vip = 0.12;
  const entries = Object.entries(mix).map(([k, w]) => {
    const def = CUSTOMERS[k as CustomerType];
    const inHours = def.hours.some(([a, b]) => h >= a && h < b);
    return [k, (w ?? 0) * (inHours ? 1.6 : 0.6)] as const;
  });
  let t = entries.reduce((a, [, w]) => a + w, 0) * rand();
  for (const [k, w] of entries) { t -= w; if (t <= 0) return k as CustomerType; }
  return 'office';
}

/** Choose what a customer of this type orders from the restaurant's menu. */
export function makeOrder(s: GameState, restId: string, type: CustomerType): { recipe: string; pieces: number } | null {
  const r = s.restaurants[restId];
  const avail = [...s.recipes, ...seasonalRecipes(s)];
  const menu = r.menu.filter((m) => avail.includes(m));
  if (!menu.length) return null;
  const def = CUSTOMERS[type];
  const weights = menu.map((m) => (def.prefers.includes(m) ? 3 : 1) * (RECIPES[m].premium && def.priceTolerance < 1.5 ? 0.3 : 1));
  let t = weights.reduce((a, b) => a + b, 0) * rand();
  let recipe = menu[0];
  for (let i = 0; i < menu.length; i++) { t -= weights[i]; if (t <= 0) { recipe = menu[i]; break; } }
  const pieces = def.orderMin + Math.floor(rand() * (def.orderMax - def.orderMin + 1));
  return { recipe, pieces };
}

// ---------------------------------------------------------------- inventory
export function ingredientPrice(s: GameState, id: IngredientId): number {
  const ev = s.event ? EVENTS[s.event.id] : null;
  let m = ev?.ingredient === id ? ev.ingredientMult ?? 1 : 1;
  if (m > 1 && s.research.includes('supply_contracts')) m = 1 + (m - 1) / 2;
  return INGREDIENTS[id].cost * mods(s).ingredientCost * m;
}

export function canMake(s: GameState, recipe: string, pieces: number): boolean {
  for (const [k, n] of Object.entries(RECIPES[recipe].ingredients)) if (s.inventory[k as IngredientId] < (n ?? 0) * pieces) return false;
  return true;
}

function consume(s: GameState, recipe: string, pieces: number): boolean {
  if (!canMake(s, recipe, pieces)) return false;
  for (const [k, n] of Object.entries(RECIPES[recipe].ingredients)) s.inventory[k as IngredientId] -= (n ?? 0) * pieces;
  return true;
}

/** Buy ingredients. Returns quantity actually bought (limited by cash and storage). Delivery fee applies when remote. */
export function buyIngredient(s: GameState, id: IngredientId, qty: number, delivery = false): number {
  const unit = ingredientPrice(s, id) * (delivery ? 1.08 : 1);
  const room = mods(s).storage - storageUsed(s);
  // Supplier credit: when nothing on any menu can be cooked, Mika fronts up to one day of upkeep in ingredients,
  // even into debt, so a broke empire can always restart instead of soft-locking with an empty kitchen.
  const stuck = !Object.values(s.restaurants).some((r) => r.menu.some((m) => s.recipes.includes(m) && canMake(s, m, 1)));
  const { wages, rent } = dailyCosts(s);
  const budget = Math.max(0, s.cash) + (stuck ? 5_000 + wages + rent : 0);
  qty = Math.max(0, Math.min(qty, room, Math.floor(budget / unit)));
  if (qty <= 0) return 0;
  const cost = qty * unit;
  s.cash -= cost; s.inventory[id] += qty;
  s.lifetime.expenses += cost; s.today.expenses += cost;
  if (!delivery) s.flags.boughtOnce = true;
  return qty;
}

export const autoRestockOn = (s: GameState) =>
  (s.research.includes('auto_restock') || s.staff.some((e) => e.role === 'manager' && e.restaurant)) && s.flags.autoRestockOff !== true;

function autoRestock(s: GameState): void {
  // Target > 0 switches an ingredient on; every in-use ingredient gets an equal share of storage, so targets grow
  // with the empire and one over-set ingredient can never fill the warehouse and starve the rest.
  const used = neededIngredients(s);
  // menu ingredients default to ON the moment auto-restock becomes available (manager or research); new menu items too
  for (const id of used) if (!s.flags['rs_' + id]) { s.flags['rs_' + id] = true; if (!(s.restock[id] > 0)) s.restock[id] = 1; }
  const share = Math.floor(mods(s).storage * 0.9 / Math.max(1, used.length));
  for (const id of INGREDIENT_IDS) {
    const need = (used.includes(id) && s.restock[id] > 0 ? share : 0) - s.inventory[id];
    if (need > 0) buyIngredient(s, id, need, true);
  }
}

/** Ingredient ids needed by the current menus — used to set sensible default restock targets. */
export function neededIngredients(s: GameState): IngredientId[] {
  const set = new Set<IngredientId>();
  for (const r of Object.values(s.restaurants)) for (const m of r.menu) if (s.recipes.includes(m))
    for (const k of Object.keys(RECIPES[m].ingredients)) set.add(k as IngredientId);
  return [...set];
}

// ---------------------------------------------------------------- orders
/** Accept an order. Ingredients are checked now and consumed when cooking starts. */
export function acceptOrder(
  s: GameState, restId: string,
  o: { recipe: string; pieces: number; type: CustomerType; customerId: number | null; manualOnly?: boolean },
): Ticket | 'nostock' {
  if (!canMake(s, o.recipe, o.pieces)) return 'nostock';
  const t: Ticket = {
    id: s.nextTicketId++, recipe: o.recipe, pieces: o.pieces, customerId: o.customerId, customerType: o.type,
    progress: 0, started: false, cook: o.manualOnly ? 'player' : 'kitchen', manualOnly: o.manualOnly, quality: 0, createdAt: s.clock,
  };
  s.restaurants[restId].orders.push(t);
  return t;
}

/** Player finished a minigame for this ticket. Consumes ingredients; returns false if stock ran out meanwhile. */
export function finishManual(s: GameState, restId: string, ticketId: number, score: number): boolean {
  const r = s.restaurants[restId];
  const i = r.orders.findIndex((t) => t.id === ticketId);
  if (i < 0) return false;
  const t = r.orders[i];
  if (!t.started && !consume(s, t.recipe, t.pieces)) return false;
  t.started = true; t.progress = t.pieces;
  t.quality = manualQuality(s, restId, score);
  r.orders.splice(i, 1); r.ready.push(t);
  s.lifetime.manualOrders++;
  if (score > PERFECT_SCORE) s.lifetime.perfectCooks++;
  emit('ticketReady', { restaurant: restId, ticketId: t.id });
  return true;
}

/** Bill for a ticket before tip. */
export function bill(s: GameState, restId: string, t: Ticket): number {
  return RECIPES[t.recipe].price * t.pieces * s.restaurants[restId].priceMult * conceptOf(s, restId).price * (t.manualOnly ? 2 : 1);
}

export function atmosphere(r: RestaurantState): number {
  const u = r.upgrades;
  return clamp(((u.lanterns ?? 0) + (u.plants ?? 0) + (u.sign ?? 0) + (u.seats ?? 0) * 0.5) / 9 + 0.1 * r.theme, 0, 1);
}

export function satisfactionFor(s: GameState, restId: string, t: Ticket, waitSec: number | null): number {
  const r = s.restaurants[restId], def = CUSTOMERS[t.customerType];
  const q = clamp(0.55 + (t.quality - def.qualityExpect) * 1.3, 0, 1);
  const patience = def.patience * (1 + 0.15 * (r.upgrades.register ?? 0) + 0.08 * (r.upgrades.seats ?? 0));
  const w = waitSec === null ? 0.8 : clamp(1.1 - waitSec / patience, 0, 1);
  const over = r.priceMult - def.priceTolerance;
  const price = over > 0 ? clamp(1 - over * 2, 0, 1) : clamp(1 + -over * 0.2, 0, 1);
  return clamp(0.35 * q + 0.25 * w + 0.15 * price + 0.15 * r.cleanliness + 0.1 * atmosphere(r) + mods(s).satisfaction, 0, 1);
}

/** Customer receives food and pays. The single place where money and pieces are earned for restaurants. */
export function settle(s: GameState, restId: string, ticketId: number, waitSec: number | null): { paid: number; tip: number; satisfaction: number } | null {
  const r = s.restaurants[restId];
  const i = r.ready.findIndex((t) => t.id === ticketId);
  if (i < 0) return null;
  const t = r.ready[i];
  r.ready.splice(i, 1);
  const sat = satisfactionFor(s, restId, t, waitSec);
  const paid = bill(s, restId, t);
  const tip = paid * CUSTOMERS[t.customerType].tipRate * Math.max(0, sat - 0.5) * 2;
  earn(s, paid + tip);
  s.lifetime.tips += tip;
  s.lifetime.customers++; s.today.customers++;
  s.lifetime.bestOrder = Math.max(s.lifetime.bestOrder, paid + tip);
  r.served++; r.revenue += paid + tip;
  r.day.rev += paid + tip; r.day.pieces += t.pieces; r.day.guests++;
  r.day.cost += recipeCost(RECIPES[t.recipe], mods(s).ingredientCost) * t.pieces;
  r.satisfaction += (sat - r.satisfaction) * 0.05;
  const w = CUSTOMERS[t.customerType].repWeight;
  r.reputation = clamp(r.reputation + (sat * 5.4 - r.reputation) * 0.02 * w, 0, 5);
  r.cleanliness = clamp(r.cleanliness - 0.005 * t.pieces / 3 * (1 - 0.25 * (r.upgrades.cleaning ?? 0)), 0, 1);
  addPieces(s, t.pieces, t.recipe);
  if (t.customerType === 'critic' && t.customerId !== null) toast(sat > 0.75 ? `📝 The critic loved ${r.name}! Reputation soars.` : `📝 The critic was unimpressed by ${r.name}...`, sat > 0.75 ? 'good' : 'bad');
  if (t.customerType === 'critic' && t.customerId !== null && sat > 0.75) s.lifetime.criticsWowed++;
  if (waitSec !== null && t.customerId !== null) { const w = Math.max(0.1, waitSec); s.lifetime.fastestServe = s.lifetime.fastestServe ? Math.min(s.lifetime.fastestServe, w) : w; }
  emit('sale', { restaurant: restId, pieces: t.pieces, paid, tip, satisfaction: sat, customerId: t.customerId, customerType: t.customerType, recipe: t.recipe, waitSec });
  return { paid, tip, satisfaction: sat };
}

/** A customer gave up (impatience, no stock). Reputation takes a modest hit. Cancels their pending tickets. */
export function customerLeft(s: GameState, restId: string, type: CustomerType, customerId: number | null, reason: 'patience' | 'nostock' | 'closed'): void {
  const r = s.restaurants[restId];
  if (customerId !== null) {
    // Their food is wasted (ingredients already used) — a real cost of slow service.
    r.orders = r.orders.filter((t) => t.customerId !== customerId);
    r.ready = r.ready.filter((t) => t.customerId !== customerId);
  }
  if (reason !== 'closed') { r.reputation = clamp(r.reputation - 0.04 * CUSTOMERS[type].repWeight, 0, 5); r.day.lost++; }
  s.lifetime.lost++;
  emit('customerLeft', { restaurant: restId, customerId, reason });
}

function refundTicketIngredients(s: GameState, ticket: Ticket): void {
  if (!ticket.started) return;
  for (const [id, amount] of Object.entries(RECIPES[ticket.recipe].ingredients)) {
    s.inventory[id as IngredientId] += (amount ?? 0) * ticket.pieces;
  }
}

/**
 * Visible NPCs are about to disappear (district change / load). Their tickets become takeout if the
 * restaurant is automated (the guest takes it to go), otherwise ingredients are returned to stock.
 * Guarantees no sale is duplicated or lost across scene transitions.
 */
export function releaseVisibleTickets(s: GameState, district: DistrictId | null): void {
  for (const r of Object.values(s.restaurants)) {
    if (district && PROPERTIES[r.id].district !== district) continue;
    const auto = isAutomated(s, r.id);
    const keep = (t: Ticket) => {
      if (t.customerId === null) return true;
      if (auto && !t.manualOnly) { t.customerId = null; t.cook = 'kitchen'; return true; }
      refundTicketIngredients(s, t);
      return false;
    };
    r.orders = r.orders.filter(keep);
    r.ready = r.ready.filter(keep);
  }
}

const lastStockWarn = new Map<string, number>();
/** Throttled warning (≈ once per in-game hour per restaurant) when staff lose an order to an empty pantry. */
function warnStock(s: GameState, restId: string, recipe: string): void {
  if ((lastStockWarn.get(restId) ?? -1e9) > s.clock - DAY_SECONDS / 24) return;
  lastStockWarn.set(restId, s.clock);
  const miss = Object.keys(RECIPES[recipe].ingredients).filter((k) => s.inventory[k as IngredientId] < (RECIPES[recipe].ingredients[k as IngredientId] ?? 0) * 2);
  const what = miss.map((k) => INGREDIENTS[k as IngredientId].name.toLowerCase()).join(' & ') || 'ingredients';
  toast(`⚠️ ${s.restaurants[restId].name} is out of ${what}! Restock at Mika's${autoRestockOn(s) ? '' : ', or hire a manager / research Scheduled Deliveries'}.`, 'bad', '📦');
}

export function earn(s: GameState, amount: number): void {
  s.cash += amount; s.lifetime.revenue += amount; s.today.revenue += amount;
}

export function spend(s: GameState, amount: number): boolean {
  if (s.cash < amount) return false;
  s.cash -= amount; s.lifetime.expenses += amount; s.today.expenses += amount;
  return true;
}

export function addPieces(s: GameState, n: number, recipe?: string, offline = false): void {
  s.lifetime.pieces += n;
  if (!offline) s.today.pieces += n; // offline output must not unlock 'pieces in one day' awards
  if (recipe) s.piecesByRecipe[recipe] = (s.piecesByRecipe[recipe] ?? 0) + n;
  s.rp += n * 0.1 * (1 + 0.15 * s.hq);
  checkMilestones(s);
}

// ---------------------------------------------------------------- per-restaurant tick
export function takeoutPerMin(s: GameState, restId: string, activeDistrict: string | null): number {
  if (!isAutomated(s, restId)) return 0;
  const d = demandPerMin(s, restId);
  const visible = PROPERTIES[restId].district === activeDistrict ? visibleSpawnPerMin(s, restId) : 0;
  return Math.max(0, d - visible);
}

export function tickRestaurant(s: GameState, restId: string, dt: number, activeDistrict: string | null): void {
  const r = s.restaurants[restId];
  // 1) off-screen takeout arrivals
  const auto = isAutomated(s, restId);
  if (!auto) {
    // These guests have no visible NPC and need an automated restaurant to fulfill their orders.
    const keepVisible = (ticket: Ticket) => {
      if (ticket.customerId !== null) return true;
      refundTicketIngredients(s, ticket);
      s.lifetime.lost++;
      return false;
    };
    if (r.orders.some((t) => t.customerId === null)) r.orders = r.orders.filter(keepVisible);
    if (r.ready.some((t) => t.customerId === null)) r.ready = r.ready.filter(keepVisible);
  }
  if (auto && isOpen(s.minute)) {
    r.takeoutFrac += takeoutPerMin(s, restId, activeDistrict) * dt / 60;
    const cap = 3 + 3 * staffAt(s, restId, 'chef').length;
    while (r.takeoutFrac >= 1) {
      r.takeoutFrac -= 1;
      if (r.orders.filter((t) => t.customerId === null).length >= cap) continue; // kitchen swamped: walk-away, no rep hit
      const type = pickCustomerType(s, PROPERTIES[restId].district, s.minute, restId);
      const o = makeOrder(s, restId, type);
      if (!o) { s.lifetime.lost++; continue; }
      if (acceptOrder(s, restId, { ...o, type, customerId: null }) === 'nostock') { s.lifetime.lost++; r.day.lost++; warnStock(s, restId, o.recipe); }
    }
  }
  // 2) kitchen — visible customers first, then takeout
  let budget = kitchenRate(s, restId) * dt * (1 - reservedShare(s, restId)); // catering contracts reserve kitchen time
  if (budget > 0) {
    const queue = [...r.orders.filter((t) => t.cook === 'kitchen' && t.customerId !== null), ...r.orders.filter((t) => t.cook === 'kitchen' && t.customerId === null)];
    for (const t of queue) {
      if (budget <= 0) break;
      if (!t.started) {
        if (!consume(s, t.recipe, t.pieces)) {
          r.orders.splice(r.orders.indexOf(t), 1);
          if (t.customerId !== null) customerLeft(s, restId, t.customerType, t.customerId, 'nostock');
          else s.lifetime.lost++;
          warnStock(s, restId, t.recipe);
          continue;
        }
        t.started = true;
      }
      const prepScale = RECIPES[t.recipe].prep / 3.5; // fancier rolls take longer
      const use = Math.min(budget, (t.pieces - t.progress) * prepScale);
      t.progress += use / prepScale; budget -= use;
      if (t.progress >= t.pieces - 1e-9) {
        t.progress = t.pieces;
        t.quality = clamp(kitchenQuality(s, restId) + (rand() - 0.5) * 0.08, 0, 1);
        r.orders.splice(r.orders.indexOf(t), 1); r.ready.push(t);
        emit('ticketReady', { restaurant: restId, ticketId: t.id });
      }
    }
  }
  // 3) takeout is collected automatically when automated (servers/manager bag it)
  if (auto) for (const t of r.ready.filter((t) => t.customerId === null)) settle(s, restId, t.id, null);
  // 4) cleaning
  for (const c of staffAt(s, restId, 'cleaner')) r.cleanliness = clamp(r.cleanliness + dt * 0.004 * (1 + 0.2 * c.skill), 0, 1);
  // 5) staff experience
  if (r.ready.length || r.orders.length) for (const e of staffAt(s, restId)) gainXp(s, e, dt * 0.02);
}

export function gainXp(s: GameState, e: Employee, amount: number): void {
  if (e.skill >= MAX_SKILL) return;
  e.xp += amount * mods(s).xp;
  const need = 20 * e.skill * e.skill;
  if (e.xp >= need) {
    e.xp -= need; e.skill++; e.wage = wageFor(e.role, e.skill);
    toast(`${e.name} improved to skill ${e.skill}!`, 'good', ROLES[e.role].emoji);
  }
}

// ---------------------------------------------------------------- global tick
export interface TickCtx { activeDistrict: string | null }

let restockTimer = 0;

export function tick(s: GameState, dt: number, ctx: TickCtx): void {
  s.playTime += dt;
  s.clock += dt;
  const speed = isOpen(s.minute) ? 1 : 4; // nights fly by while everything is closed
  s.minute += (dt * speed * 1440) / DAY_SECONDS;
  if (s.minute >= 1440) { s.minute -= 1440; endDay(s); }

  // campaigns expire
  s.campaigns = s.campaigns.filter((c) => c.endsDay > s.day || (c.endsDay === s.day && c.endsMinute > s.minute));

  for (const id of Object.keys(s.restaurants)) tickRestaurant(s, id, dt, ctx.activeDistrict);

  // franchises
  const fpps = franchisePPS(s);
  if (fpps > 0) {
    s.franchiseFrac += fpps * dt;
    const whole = Math.floor(s.franchiseFrac);
    if (whole > 0) {
      s.franchiseFrac -= whole;
      earn(s, whole * franchiseRoyaltyPerPiece(s));
      addPieces(s, whole);
    }
  }

  restockTimer += dt;
  if (restockTimer > 2) { restockTimer = 0; if (autoRestockOn(s)) autoRestock(s); }
}

export function franchisePPS(s: GameState): number {
  let n = 0;
  for (const [id, c] of Object.entries(s.cities)) if (c.open) n += c.franchises * CITIES[id].mult;
  return n * FRANCHISE_PPS * mods(s).franchise * campaignBoost(s, null) * (1 + s.brand / 200);
}
export function franchiseRoyaltyPerPiece(s: GameState): number {
  let w = 0, n = 0;
  for (const [id, c] of Object.entries(s.cities)) if (c.open && c.franchises) { w += c.franchises * CITIES[id].mult; n += c.franchises; }
  return FRANCHISE_ROYALTY * (n ? w / n : 1);
}

// ---------------------------------------------------------------- day end
export const restaurantRent = (s: GameState, id: string) => Math.round(PROPERTIES[id].rent * conceptOf(s, id).rent);

export function dailyCosts(s: GameState): { wages: number; rent: number } {
  const wages = s.staff.filter((e) => e.restaurant).reduce((a, e) => a + e.wage, 0) + s.staff.filter((e) => !e.restaurant).reduce((a, e) => a + e.wage * 0.5, 0);
  const rent = Object.keys(s.restaurants).reduce((a, id) => a + restaurantRent(s, id), 0);
  return { wages, rent };
}

export function endDay(s: GameState): void {
  const { wages, rent } = dailyCosts(s);
  const cost = wages + rent;
  s.cash -= cost; s.lifetime.expenses += cost; s.today.expenses += cost;
  for (const r of Object.values(s.restaurants)) {
    r.day.cost += staffAt(s, r.id).reduce((a, e) => a + e.wage, 0) + restaurantRent(s, r.id);
    r.hist.push({ ...r.day });
    if (r.hist.length > 14) r.hist.shift();
    r.day = emptyDay(s.day + 1);
    r.log = [];
  }
  const rsAll = Object.values(s.restaurants);
  const summary = { ...s.today, avgStars: rsAll.reduce((a, r) => a + r.reputation, 0) / Math.max(1, rsAll.length) };
  emit('dayEnd', summary);
  s.history.push(summary);
  if (s.history.length > 30) s.history.shift();
  s.day++;
  s.today = { day: s.day, revenue: 0, expenses: 0, pieces: 0, customers: 0 };
  if (s.cash < 0) toast(`Wages and rent left you at ¥${Math.round(s.cash).toLocaleString()}. Cook at the stand to recover — it has no rent!`, 'bad', '⚠️');

  // reputation drifts toward 3 when unattended; brand toward a target
  const rs = Object.values(s.restaurants);
  const avgRep = rs.reduce((a, r) => a + r.reputation, 0) / rs.length;
  const target = clamp(avgRep * 10 + Math.log10(1 + rs.length) * 18 + s.campaigns.reduce((a, c) => a + CAMPAIGNS[c.id].brand, 0) + (s.research.includes('brand_story') ? 8 : 0) + s.hq * 2, 0, 100);
  s.brand += (target - s.brand) * 0.25;

  refreshCandidates(s);
  rivalsAct(s);
  rollEvent(s);
}

function rollEvent(s: GameState): void {
  if (s.event && s.event.endsDay > s.day) return;
  s.event = null;
  if (rand() > 0.45) return;
  const options = Object.values(EVENTS).filter((e) => e.minPieces <= s.lifetime.pieces);
  if (!options.length) return;
  const e = pick(options);
  s.event = { id: e.id, endsDay: s.day + e.days };
  emit('event', { id: e.id, name: e.name, desc: e.desc, emoji: e.emoji });
}

/** Rivals follow simple visible rules: they gain share where you are weak and lose it where you are strong. */
export function rivalsAct(s: GameState): void {
  for (const [rid, shares] of Object.entries(s.rivals)) {
    const def = RIVALS[rid];
    for (const d of def.districts) {
      if (shares[d] === undefined) continue; // bought out
      const mine = Object.values(s.restaurants).filter((r) => PROPERTIES[r.id].district === d);
      const presence = mine.length ? (mine.reduce((a, r) => a + r.reputation, 0) / mine.length / 5) * Math.min(1, mine.length / 2) : 0;
      const marketing = s.campaigns.filter((c) => CAMPAIGNS[c.id].scope !== 'district' || c.district === d).length;
      const target = clamp(0.3 - presence * 0.22 - marketing * 0.03, 0.03, 0.35);
      let share = (shares[d] ?? 0) + (target - (shares[d] ?? 0)) * 0.3;
      if (rand() < 0.12 && s.districts.includes(d)) {
        share += 0.06;
        toast(`${def.name} launched a ${pick(['price war', 'big ad blitz', 'new branch', 'discount week'])} in ${DISTRICTS[d].name}!`, 'bad', '⚔️');
      }
      shares[d] = clamp(share, 0, 0.35);
    }
  }
}

export function buyoutCost(s: GameState, rid: string, d: DistrictId): number {
  return Math.round(5_000_000 * (1 + (s.rivals[rid][d] ?? 0) * 20) * (d === 'ginza' ? 3 : 1));
}

// ---------------------------------------------------------------- hiring
const FIRST = ['Haruto', 'Yui', 'Sota', 'Hina', 'Ren', 'Mio', 'Yuto', 'Aoi', 'Kaito', 'Sakura', 'Riku', 'Mei', 'Daiki', 'Emi', 'Kenta', 'Nao', 'Taro', 'Yuna', 'Shun', 'Rin', 'Akira', 'Kiko'];
const LAST = ['Sato', 'Suzuki', 'Takahashi', 'Ito', 'Watanabe', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato', 'Yoshida', 'Yamada', 'Mori', 'Ishikawa', 'Ono'];
const SKINS = ['#f1c27d', '#e0ac69', '#ffdbac', '#c68642', '#8d5524', '#f5d0b0'];
const HAIRS = ['#1b1b1b', '#2b1d14', '#5a3825', '#a0522d', '#d4a373', '#7b7b7b', '#3d2b56'];

export function randomAvatar(): Avatar {
  return { skin: pick(SKINS), hair: pick(HAIRS), hairStyle: Math.floor(rand() * 9), shirt: '#ffffff', pants: '#2d3142', headwear: 0 };
}

export function makeCandidate(s: GameState, role: Role): Employee {
  const maxSkill = s.lifetime.pieces > 100_000 ? 5 : s.lifetime.pieces > 10_000 ? 4 : 3;
  const skill = 1 + Math.floor(rand() * maxSkill);
  return { id: s.nextId++, name: `${pick(FIRST)} ${pick(LAST)}`, role, skill, xp: 0, wage: wageFor(role, skill), restaurant: null, look: randomAvatar() };
}

export function refreshCandidates(s: GameState): void {
  s.candidates = [];
  for (const role of Object.keys(ROLES) as Role[]) for (let i = 0; i < 2; i++) s.candidates.push(makeCandidate(s, role));
}

export function hireCost(e: Employee): number { return Math.round(ROLES[e.role].hireCost * (1 + 0.3 * (e.skill - 1))); }

// ---------------------------------------------------------------- milestones
export function checkMilestones(s: GameState): void {
  while (Number.isFinite(milestone(s.milestoneIndex).pieces) && s.lifetime.pieces >= milestone(s.milestoneIndex).pieces) {
    const m = milestone(s.milestoneIndex);
    const idx = s.milestoneIndex++;
    if (m.reward.cash) { s.cash += m.reward.cash; s.lifetime.revenue += m.reward.cash; }
    if (m.reward.rp) s.rp += m.reward.rp;
    if (m.reward.recipe && !s.recipes.includes(m.reward.recipe)) s.recipes.push(m.reward.recipe);
    s.player.title = m.title;
    emit('milestone', { index: idx, title: m.title, pieces: m.pieces, text: m.reward.text });
    if (m.pieces === 1_000_000) {
      s.flags.chapter2 = true;
      s.cities.tokyo ??= { open: true, franchises: 0 };
      emit('million', {});
    }
  }
}

export const nextMilestone = (s: GameState) => milestone(s.milestoneIndex);

// ---------------------------------------------------------------- offline progress
/** Earnings while the tab was closed. Only restaurants with a manager (and franchises) work offline. */
export function offlineProgress(s: GameState, seconds: number): { seconds: number; pieces: number; revenue: number; expenses: number } {
  const m = mods(s);
  seconds = clamp(seconds, 0, m.offlineCapH * 3600);
  let pieces = 0, revenue = 0, expenses = 0;
  if (seconds < 60) return { seconds: 0, pieces, revenue, expenses };
  const paused = { campaigns: s.campaigns, event: s.event };
  s.campaigns = []; s.event = null; // campaigns & events pause while away: no freezing a boost into hours of offline income
  const avgHour = 0.85; // average hourFactor across a day incl. closed hours
  for (const r of Object.values(s.restaurants)) {
    if (!hasManager(s, r.id) || !isAutomated(s, r.id)) continue;
    const menu = r.menu.filter((x) => s.recipes.includes(x));
    if (!menu.length) continue;
    const avgPrice = menu.reduce((a, x) => a + RECIPES[x].price, 0) / menu.length * r.priceMult;
    const avgCost = menu.reduce((a, x) => a + Object.entries(RECIPES[x].ingredients).reduce((b, [k, n]) => b + ingredientPrice(s, k as IngredientId) * 1.08 * (n ?? 0), 0), 0) / menu.length;
    const avgPrep = menu.reduce((a, x) => a + RECIPES[x].prep / 3.5, 0) / menu.length;
    const demandPPS = (demandPerMin(s, r.id, 12 * 60) / 1.5) * avgHour / 60 * 3; // ~3 pieces per customer
    const pps = Math.min(demandPPS, kitchenRate(s, r.id) / avgPrep) * m.offlineEff;
    const p = Math.floor(pps * seconds);
    // this location's wages + rent for the period (staff work half the hours of a full day cycle)
    const upkeep = (staffAt(s, r.id).reduce((a, e) => a + e.wage, 0) + restaurantRent(s, r.id)) * (seconds / DAY_SECONDS) * 0.5;
    const rev = p * avgPrice, exp = Math.min(rev, p * avgCost + upkeep); // a managed restaurant never loses money offline
    pieces += p; revenue += rev; expenses += exp;
    r.served += Math.round(p / 3); r.revenue += rev;
  }
  const fp = Math.floor(franchisePPS(s) * seconds * m.offlineEff);
  pieces += fp; revenue += fp * franchiseRoyaltyPerPiece(s);
  s.campaigns = paused.campaigns; s.event = paused.event;
  s.cash += revenue - expenses;
  s.lifetime.revenue += revenue; s.lifetime.expenses += expenses;
  if (pieces > 0) addPieces(s, pieces, undefined, true);
  return { seconds, pieces, revenue, expenses };
}

// re-export for convenience
export { FACILITIES, UPGRADES };
