// Catering contracts: timed bulk orders for one owned restaurant. Pure logic on GameState: no three.js, no DOM.
//
// Kitchen reservation: contract pieces never become Tickets. tickContracts() cooks them with a reserved share
// (RESERVE) of the restaurant's chef throughput and consumes ingredients directly. On completion the payout goes
// through sim.earn and the pieces through sim.addPieces, exactly once. Because no Ticket exists, takeout
// auto-settle (tickRestaurant) and releaseVisibleTickets can never touch contract output: no double pay.
// With the optional one-line sim patch (reservedShare), walk-in/takeout cooking loses that same share.
import { toast } from './bus';
import { DAY_SECONDS, IngredientId, RECIPES } from './data';
import * as sim from './sim';
import type { GameState } from './state';

export const RESERVE = 0.4; // share of a kitchen's output a restaurant's contracts take while active
export const MAX_ACTIVE = 3;

export const CLIENTS = {
  office: { name: 'Marunouchi Office Party', emoji: '🏢', desc: 'A trading firm closed its biggest deal. Lunch is on the boss.', minPieces: 0, mult: 1.6, bonus: 1_500, rep: 0.15, hour: 12 },
  sumo: { name: 'Kotobuki Sumo Stable', emoji: '🙇', desc: 'Forty wrestlers after morning keiko. They count by the tray.', minPieces: 1_000, mult: 1.7, bonus: 3_000, rep: 0.2, hour: 11 },
  film: { name: 'Night-Shoot Film Crew', emoji: '🎬', desc: 'A rain-machine chase scene on Sumida bridge. Craft service is starving.', minPieces: 3_000, mult: 1.8, bonus: 5_000, rep: 0.25, hour: 23 },
  temple: { name: 'Lantern Festival Committee', emoji: '⛩️', desc: 'The shrine volunteers want sushi for every float bearer.', minPieces: 8_000, mult: 2, bonus: 10_000, rep: 0.3, hour: 18 },
  wedding: { name: 'Riverside Wedding Banquet', emoji: '💒', desc: 'The bride\'s grandmother insists the sushi be better than her own.', minPieces: 25_000, mult: 2.2, bonus: 25_000, rep: 0.4, hour: 17 },
  embassy: { name: 'Embassy Gala Dinner', emoji: '🎩', desc: 'Twelve ambassadors, one diplomatic incident if dinner is late.', minPieces: 100_000, mult: 2.5, bonus: 80_000, rep: 0.6, hour: 19 },
} as const;
export type ClientId = keyof typeof CLIENTS;

export interface Offer {
  id: number; client: ClientId; restaurant: string; recipe: string; qty: number;
  deadline: { day: number; minute: number }; payout: number; repPenalty: number;
}
export interface Contract extends Offer { done: number; frac: number }
export interface ContractState { offers: Offer[]; active: Contract[]; offersDay: number; nextId: number; completed: number; failed: number }

export const createContractState = (): ContractState => ({ offers: [], active: [], offersDay: 0, nextId: 1, completed: 0, failed: 0 });

// ponytail: optional field until state.ts declares `contracts`; the cast is a no-op afterwards.
export const contracts = (s: GameState): ContractState => ((s as GameState & { contracts?: ContractState }).contracts ??= createContractState());

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const prepScale = (recipe: string) => RECIPES[recipe].prep / 3.5; // same as sim.tickRestaurant
const past = (s: GameState, d: Offer['deadline']) => s.day > d.day || (s.day === d.day && s.minute >= d.minute);
// ponytail: nights run 4× faster, so a game day is ~0.84 × DAY_SECONDS real seconds; 0.8 leaves a little slack.
const realSecondsUntil = (s: GameState, d: Offer['deadline']) => ((d.day - s.day) * 1440 + d.minute - s.minute) * DAY_SECONDS / 1440 * 0.8;

/** Kitchen share reserved for contracts at this restaurant (for the optional sim.tickRestaurant patch). */
export const reservedShare = (s: GameState, restId: string) => contracts(s).active.some((c) => c.restaurant === restId) ? RESERVE : 0;

/** Replace today's offers: 0-3, only at restaurants with chefs, only recipes on that menu and unlocked. */
export function generateOffers(s: GameState, rng: () => number = sim.rand): Offer[] {
  const st = contracts(s);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
  const clients = (Object.keys(CLIENTS) as ClientId[]).filter((c) => CLIENTS[c].minPieces <= s.lifetime.pieces);
  const rests = Object.values(s.restaurants).filter((r) => sim.kitchenRate(s, r.id) > 0 && r.menu.some((m) => s.recipes.includes(m)));
  const n = rests.length ? Math.min(3, 1 + Math.floor(rng() * (1 + rests.length))) : 0;
  const offers: Offer[] = [];
  for (let i = 0; i < n; i++) {
    const r = pick(rests), client = pick(clients), def = CLIENTS[client];
    const recipe = pick(r.menu.filter((m) => s.recipes.includes(m)));
    const deadline = { day: s.day + 1 + Math.floor(rng() * 3), minute: def.hour * 60 };
    const capacity = sim.kitchenRate(s, r.id) * RESERVE * realSecondsUntil(s, deadline) / prepScale(recipe);
    const qty = Math.min(500, Math.floor(capacity * (0.35 + 0.35 * rng()) / 5) * 5);
    if (qty < 10) continue; // kitchen too slow for a bulk order
    offers.push({
      id: st.nextId++, client, restaurant: r.id, recipe, qty, deadline, repPenalty: def.rep,
      payout: Math.round(RECIPES[recipe].price * qty * Math.min(1, r.priceMult) * def.mult + def.bonus),
    });
  }
  st.offers = offers; st.offersDay = s.day;
  return offers;
}

/** Take an offer. Returns the contract, or a reason it can't be accepted. */
export function acceptContract(s: GameState, offerId: number): Contract | string {
  const st = contracts(s);
  const o = st.offers.find((x) => x.id === offerId);
  if (!o || past(s, o.deadline)) return 'Offer expired';
  if (!s.restaurants[o.restaurant]) return 'You no longer own that restaurant';
  if (st.active.length >= MAX_ACTIVE) return `Max ${MAX_ACTIVE} contracts at once`;
  const c: Contract = { ...o, done: 0, frac: 0 };
  st.offers = st.offers.filter((x) => x !== o);
  st.active.push(c);
  toast(`${CLIENTS[o.client].emoji} Contract signed: ${o.qty}× ${RECIPES[o.recipe].name} for ${CLIENTS[o.client].name}.`, 'good');
  return c;
}

/** Call every frame after sim.tick: refreshes offers daily, cooks reserved output, pays or fails contracts. */
export function tickContracts(s: GameState, dt: number): void {
  const st = contracts(s);
  if (st.offersDay !== s.day) generateOffers(s);
  st.offers = st.offers.filter((o) => !past(s, o.deadline) && s.restaurants[o.restaurant]);
  st.active = st.active.filter((c) => {
    const r = s.restaurants[c.restaurant];
    if (!r) return false;
    const def = CLIENTS[c.client];
    const sharing = st.active.filter((x) => x.restaurant === c.restaurant).length;
    c.frac += sim.kitchenRate(s, c.restaurant) * RESERVE / sharing * dt / prepScale(c.recipe);
    const ings = Object.entries(RECIPES[c.recipe].ingredients) as [IngredientId, number][];
    const k = Math.min(Math.floor(c.frac), c.qty - c.done, ...ings.map(([id, q]) => Math.floor(s.inventory[id] / q)));
    if (k > 0) { for (const [id, q] of ings) s.inventory[id] -= q * k; c.done += k; }
    c.frac = Math.min(c.frac - k, 1); // a kitchen idle for lack of stock loses that time
    if (c.done >= c.qty) {
      sim.earn(s, c.payout);
      sim.addPieces(s, c.qty, c.recipe);
      r.revenue += c.payout;
      st.completed++;
      toast(`${def.emoji} ${def.name} delivered! +¥${c.payout.toLocaleString()}`, 'gold');
      return false;
    }
    if (past(s, c.deadline)) {
      r.reputation = clamp(r.reputation - c.repPenalty, 0, 5); // same clamp as sim.customerLeft
      st.failed++;
      toast(`${def.emoji} Missed the ${def.name} deadline (${c.done}/${c.qty}). ${r.name} loses face.`, 'bad');
      return false;
    }
    return true;
  });
}

/** For state.migrate: drop contracts that reference unknown clients/recipes or restaurants no longer owned. */
export function sanitizeContracts(s: GameState): void {
  const st = contracts(s);
  const ok = (o: Offer) => o !== null && typeof o === 'object' && Object.hasOwn(CLIENTS, o.client) && Object.hasOwn(RECIPES, o.recipe)
    && Object.hasOwn(s.restaurants, o.restaurant) && Number.isFinite(o.qty) && Number.isFinite(o.payout)
    && o.deadline !== null && typeof o.deadline === 'object' && Number.isFinite(o.deadline.day) && Number.isFinite(o.deadline.minute)
    && (!('done' in o) || (Number.isFinite((o as any).done) && Number.isFinite((o as any).frac)));
  st.offers = Array.isArray(st.offers) ? st.offers.filter(ok) : [];
  st.active = Array.isArray(st.active) ? st.active.filter(ok) : [];
}
