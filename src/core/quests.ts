// Daily objectives: three small side quests per in-game day. Pure logic on GameState: no three.js, no DOM.
// The game feeds questOnEvent() from the places where things happen (sales, cooking, purchases, day end).
import { toast } from './bus';
import {
  CLOSE_MIN, CustomerType, DAY_SECONDS, DISTRICTS, DistrictId, MAX_SKILL, OPEN_MIN, PROPERTIES, RECIPES, ROLES,
  Role, UPGRADES,
} from './data';
import { short, yen } from './format';
import * as sim from './sim';
import type { GameState } from './state';

export type QuestKind =
  | 'serve' | 'office' | 'recipe' | 'district' | 'earn' | 'perfect' | 'stars' | 'vip'
  | 'travel' | 'campaign' | 'hire' | 'train' | 'lunch' | 'clean' | 'upgrade';

export interface Quest {
  id: string; kind: QuestKind; title: string; desc: string;
  target: number; progress: number;
  reward: { cash: number; rp: number };
  done: boolean; claimed: boolean;
  meta?: { recipe?: string; district?: DistrictId; restaurant?: string; failed?: boolean };
}

export interface QuestState { day: number; list: Quest[]; streak: number }

export type QuestEvent =
  | { type: 'sale'; restaurant: string; recipe: string; pieces: number; revenue: number; customerType: CustomerType }
  | { type: 'manualCook'; restaurant: string; score: number }
  | { type: 'customerLeft'; restaurant: string; reason: 'patience' | 'nostock' | 'closed' }
  | { type: 'upgrade'; restaurant: string; upgrade: string }
  | { type: 'hire'; role: Role }
  | { type: 'train'; role: Role }
  | { type: 'campaign'; id: string }
  | { type: 'travel'; district: DistrictId }
  | { type: 'clean'; restaurant: string; cleanlinessBefore: number }
  | { type: 'dayEnd' };

export const QUESTS_PER_DAY = 3;
export const REVENUE_FLOOR = 5_000; // a brand-new stand's day
export const PERFECT_SCORE = 0.9;
export const DIRTY = 0.75; // "clean while dirty" threshold (player can clean below 0.85)
export const STAR_GOAL = 4.5;
export const LUNCH: [number, number] = [11 * 60, 14 * 60];
export const STREAK_CAP = 6; // bonus stops growing after this many perfect days

export function createQuestState(): QuestState { return { day: 0, list: [], streak: 0 }; }

// ---------------------------------------------------------------- estimates
const PIECES_PER_GUEST = 3;
const MANUAL_GUESTS_PER_MIN = 2.2; // one player cooking by hand (matches the balance bot)
const SLOT = 30; // game minutes per integration step
const REAL_MIN_PER_SLOT = (SLOT * DAY_SECONDS) / 1440 / 60;

interface Flow {
  guests: number; office: number; pieces: number; sales: number;
  byRecipe: Record<string, number>; byDistrict: Partial<Record<DistrictId, number>>;
}

/** Expected guests / pieces / sales revenue over a span of opening hours, limited by kitchen capacity. */
function flow(s: GameState, from = OPEN_MIN, to = 1440 + CLOSE_MIN): Flow {
  const f: Flow = { guests: 0, office: 0, pieces: 0, sales: 0, byRecipe: {}, byDistrict: {} };
  let manual = MANUAL_GUESTS_PER_MIN; // ponytail: the player's hands go to the first non-automated restaurant only
  for (const id of Object.keys(s.restaurants)) {
    const r = s.restaurants[id], d = PROPERTIES[id].district;
    const menu = r.menu.filter((m) => s.recipes.includes(m));
    if (!menu.length) continue;
    const price = (menu.reduce((a, m) => a + RECIPES[m].price, 0) / menu.length) * r.priceMult;
    const prep = menu.reduce((a, m) => a + RECIPES[m].prep / 3.5, 0) / menu.length;
    let cap: number;
    if (sim.isAutomated(s, id)) cap = (sim.kitchenRate(s, id) * 60) / prep / PIECES_PER_GUEST;
    else { cap = manual; manual = 0; }
    let g = 0;
    for (let m = from; m < to; m += SLOT) g += Math.min(sim.demandPerMin(s, id, m % 1440), cap) * REAL_MIN_PER_SLOT;
    const mix = DISTRICTS[d].mix, total = Object.values(mix).reduce((a, w) => a + (w ?? 0), 0);
    const pieces = g * PIECES_PER_GUEST;
    f.guests += g; f.office += (g * (mix.office ?? 0)) / total;
    f.pieces += pieces; f.sales += pieces * price;
    f.byDistrict[d] = (f.byDistrict[d] ?? 0) + pieces;
    for (const m of menu) f.byRecipe[m] = (f.byRecipe[m] ?? 0) + pieces / menu.length;
  }
  return f;
}

const estimatedTotal = (s: GameState) => flow(s).sales + sim.franchisePPS(s) * sim.franchiseRoyaltyPerPiece(s) * DAY_SECONDS;
const recentAvg = (s: GameState) => {
  const h = s.history.slice(-3);
  return h.length ? h.reduce((a, d) => a + d.revenue, 0) / h.length : null;
};

/** A typical day's revenue at the player's current stage (recent history, else a demand estimate), floored. */
export function estimateDailyRevenue(s: GameState): number {
  return Math.max(REVENUE_FLOOR, recentAvg(s) ?? estimatedTotal(s));
}

/** Round to two significant figures (≤5% error), never below 1. */
function nice(n: number): number {
  if (n < 10) return Math.max(1, Math.round(n));
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}
const plural = (n: number, one: string, many = one + 's') => `${short(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- kinds
interface Ctx { f: Flow; lunchGuests: number; rng: () => number }
interface Spec { title: string; desc: string; target: number; meta?: Quest['meta'] }
interface KindDef { w: number; ok: (s: GameState) => boolean; make: (s: GameState, c: Ctx) => Spec }

const pickOf = <T>(a: readonly T[], rng: () => number): T => a[Math.floor(rng() * a.length)];
const menuRecipes = (s: GameState) => [...new Set(Object.values(s.restaurants).flatMap((r) => r.menu))].filter((m) => s.recipes.includes(m));
const ownedDistricts = (s: GameState) => [...new Set(Object.keys(s.restaurants).map((id) => PROPERTIES[id].district))];

const FLAVOR: Record<DistrictId, { sell: string; visit: string }> = {
  asakusa: { sell: 'Old Town Favorite', visit: 'Temple Gate Stroll' },
  shibuya: { sell: 'Scramble Crossing Craze', visit: 'Next Stop: Shibuya' },
  shinjuku: { sell: 'Skyscraper Sushi Rush', visit: 'Shinjuku Skyline' },
  ginza: { sell: 'Ginza Glamour', visit: 'Gold-Leaf Getaway' },
};

// w = reward as a fraction of a day's revenue (kept inside 0.16..0.38 so 2-sig rounding stays within 15–40%).
const KINDS: Record<QuestKind, KindDef> = {
  serve: {
    w: 0.2, ok: () => true,
    make: (_, { f }) => { const n = nice(Math.max(5, 0.4 * f.guests)); return { title: 'Irasshaimase!', desc: `Serve ${plural(n, 'customer')} today.`, target: n }; },
  },
  office: {
    w: 0.2, ok: () => true,
    make: (_, { f }) => { const n = nice(Math.max(2, 0.35 * f.office)); return { title: 'Salaryman Special', desc: `Serve ${plural(n, 'office worker')} today.`, target: n }; },
  },
  recipe: {
    w: 0.2, ok: (s) => menuRecipes(s).length > 0,
    make: (s, { f, rng }) => {
      const recipe = pickOf(menuRecipes(s), rng), name = RECIPES[recipe].name;
      const n = nice(Math.max(3, 0.35 * (f.byRecipe[recipe] ?? 0)));
      return { title: `${name} Fever`, desc: `Sell ${plural(n, 'piece')} of ${name} today.`, target: n, meta: { recipe } };
    },
  },
  district: {
    w: 0.25, ok: (s) => ownedDistricts(s).length >= 2,
    make: (s, { f, rng }) => {
      const district = pickOf(ownedDistricts(s), rng);
      const n = nice(Math.max(5, 0.35 * (f.byDistrict[district] ?? 0)));
      return { title: FLAVOR[district].sell, desc: `Sell ${plural(n, 'piece')} in ${DISTRICTS[district].name} today.`, target: n, meta: { district } };
    },
  },
  earn: {
    w: 0.3, ok: () => true,
    make: (_, { f }) => { const n = nice(Math.max(1_000, 0.4 * f.sales)); return { title: 'Ka-ching Chōchin', desc: `Earn ${yen(n)} from sushi sales today.`, target: n }; },
  },
  perfect: {
    w: 0.3, ok: () => true,
    make: (s) => {
      const n = s.lifetime.manualOrders < 10 ? 1 : s.lifetime.manualOrders < 100 ? 2 : 3;
      return { title: 'Master Itamae', desc: `Cook ${plural(n, 'Perfect order')} by hand (score above 90%).`, target: n };
    },
  },
  stars: {
    w: 0.35, ok: (s) => s.lifetime.pieces >= 1_000 && Object.values(s.restaurants).some((r) => r.reputation >= 3.8),
    make: (s) => {
      const best = Object.values(s.restaurants).reduce((a, r) => (r.reputation > a.reputation ? r : a));
      return { title: 'Five-Star Omotenashi', desc: `End the day with ${best.name} at ${STAR_GOAL}★ or better.`, target: 1, meta: { restaurant: best.id } };
    },
  },
  vip: {
    w: 0.3, ok: (s) => (s.lifetime.pieces > 5_000 && s.flags.vipEnabled !== false) || s.event?.id === 'critic',
    make: () => ({ title: 'Red Carpet Service', desc: 'Serve 1 VIP guest or food critic.', target: 1 }),
  },
  travel: {
    w: 0.17, ok: (s) => s.districts.some((d) => d !== s.player.district),
    make: (s, { rng }) => {
      const district = pickOf(s.districts.filter((d) => d !== s.player.district), rng);
      return { title: FLAVOR[district].visit, desc: `Ride the metro to ${DISTRICTS[district].name} 1 time.`, target: 1, meta: { district } };
    },
  },
  campaign: {
    w: 0.2, ok: (s) => s.lifetime.pieces >= 100,
    make: () => ({ title: 'Talk of the Town', desc: 'Launch 1 marketing campaign.', target: 1 }),
  },
  hire: {
    w: 0.2,
    ok: (s) => Object.keys(s.restaurants).some((id) => (Object.keys(ROLES) as Role[]).some((role) =>
      s.lifetime.pieces >= ROLES[role].unlockPieces && sim.staffAt(s, id, role).length < sim.slotsFor(s, id, role))),
    make: () => ({ title: 'Help Wanted', desc: 'Hire 1 new staff member.', target: 1 }),
  },
  train: {
    w: 0.2, ok: (s) => s.staff.some((e) => e.skill < MAX_SKILL),
    make: () => ({ title: 'Dojo Day', desc: 'Train 1 staff member.', target: 1 }),
  },
  lunch: {
    w: 0.3, ok: (s) => s.minute < LUNCH[0],
    make: (_, { lunchGuests }) => {
      const n = Math.min(15, nice(Math.max(2, 0.4 * lunchGuests)));
      return { title: 'Lunch Rush Hero', desc: `Serve ${plural(n, 'customer')} in the 11:00–14:00 rush with zero walk-outs.`, target: n };
    },
  },
  clean: {
    w: 0.17, ok: (s) => s.lifetime.pieces >= 300 && Object.keys(s.restaurants).some((id) => !sim.staffAt(s, id, 'cleaner').length),
    make: () => ({ title: 'Spotless Shop', desc: `Clean 1 restaurant while it is below ${DIRTY * 100}% cleanliness.`, target: 1 }),
  },
  upgrade: {
    w: 0.2, ok: (s) => Object.values(s.restaurants).some((r) => Object.values(UPGRADES).some((u) => (r.upgrades[u.id] ?? 0) < u.max)),
    make: (s) => {
      const n = Object.keys(s.restaurants).length >= 3 ? 2 : 1;
      return { title: 'Renovation Fever', desc: `Buy ${plural(n, 'restaurant upgrade')}.`, target: n };
    },
  },
};
export const QUEST_KINDS = Object.keys(KINDS) as QuestKind[];

function rewardFor(r: number, w: number): { cash: number; rp: number } {
  return { cash: nice(r * w), rp: Math.max(1, Math.round((Math.sqrt(r) * w) / 2.5)) };
}

/** Three quests with distinct kinds, each achievable in the current state and scaled to its progress. */
export function rollDailyQuests(s: GameState, rng: () => number = Math.random): Quest[] {
  const total = estimatedTotal(s), hist = recentAvg(s);
  // Players slower than the model get proportionally easier volume targets.
  const pace = hist === null ? 1 : Math.max(0.3, Math.min(1, hist / Math.max(1, total)));
  const scale = (f: Flow): Flow => ({
    ...f, guests: f.guests * pace, office: f.office * pace, pieces: f.pieces * pace, sales: f.sales * pace,
    byRecipe: Object.fromEntries(Object.entries(f.byRecipe).map(([k, v]) => [k, v * pace])),
    byDistrict: Object.fromEntries(Object.entries(f.byDistrict).map(([k, v]) => [k, v * pace])),
  });
  const ctx: Ctx = { f: scale(flow(s)), lunchGuests: flow(s, LUNCH[0], LUNCH[1]).guests * pace, rng };
  const pool = QUEST_KINDS.filter((k) => KINDS[k].ok(s));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const revenue = estimateDailyRevenue(s);
  return pool.slice(0, QUESTS_PER_DAY).map((kind, i) => {
    const spec = KINDS[kind].make(s, ctx);
    return { id: `${s.day}-${i}-${kind}`, kind, ...spec, progress: 0, reward: rewardFor(revenue, KINDS[kind].w), done: false, claimed: false };
  });
}

/** Re-roll when the in-game day changed. A day that ended with an unfinished quest breaks the streak. Returns true if rolled. */
export function ensureQuests(q: QuestState, s: GameState, rng: () => number = Math.random): boolean {
  if (q.day === s.day) return false;
  // finished-but-unclaimed quests (e.g. 'stars', which completes at day end) are paid out, not lost
  const auto = q.list.filter((x) => x.done && !x.claimed);
  for (const x of auto) claimQuest(q, s, x.id);
  if (auto.length) toast(`📜 Yesterday's finished requests were paid out automatically (${auto.length}).`, 'good');
  if (q.list.some((x) => !x.done)) q.streak = 0;
  q.day = s.day;
  q.list = rollDailyQuests(s, rng);
  return true;
}

// ---------------------------------------------------------------- progress
const inLunch = (minute: number) => minute >= LUNCH[0] && minute < LUNCH[1];

function bump(x: Quest, n: number): void {
  x.progress = Math.min(x.target, x.progress + n);
  if (x.progress >= x.target && x.kind !== 'lunch') x.done = true;
}

function step(x: Quest, s: GameState, ev: QuestEvent): void {
  const m = x.meta ?? {};
  switch (x.kind) {
    case 'serve': if (ev.type === 'sale') bump(x, 1); break;
    case 'office': if (ev.type === 'sale' && ev.customerType === 'office') bump(x, 1); break;
    case 'vip': if (ev.type === 'sale' && (ev.customerType === 'vip' || ev.customerType === 'critic')) bump(x, 1); break;
    case 'recipe': if (ev.type === 'sale' && ev.recipe === m.recipe) bump(x, ev.pieces); break;
    case 'district': if (ev.type === 'sale' && PROPERTIES[ev.restaurant]?.district === m.district) bump(x, ev.pieces); break;
    case 'earn': if (ev.type === 'sale') bump(x, ev.revenue); break;
    case 'perfect': if (ev.type === 'manualCook' && ev.score > PERFECT_SCORE) bump(x, 1); break;
    case 'upgrade': if (ev.type === 'upgrade') bump(x, 1); break;
    case 'hire': if (ev.type === 'hire') bump(x, 1); break;
    case 'train': if (ev.type === 'train') bump(x, 1); break;
    case 'campaign': if (ev.type === 'campaign') bump(x, 1); break;
    case 'travel': if (ev.type === 'travel' && ev.district === m.district) bump(x, 1); break;
    case 'clean': if (ev.type === 'clean' && ev.cleanlinessBefore < DIRTY) bump(x, 1); break;
    case 'stars': if (ev.type === 'dayEnd' && (s.restaurants[m.restaurant ?? '']?.reputation ?? 0) >= STAR_GOAL) bump(x, 1); break;
    case 'lunch':
      if (m.failed) break;
      if (ev.type === 'customerLeft' && ev.reason !== 'closed' && inLunch(s.minute)) { x.meta = { ...m, failed: true }; break; }
      if (ev.type === 'sale' && inLunch(s.minute)) bump(x, 1);
      // The rush is over once we see any event after 14:00 (or the day ends).
      if ((ev.type === 'dayEnd' || s.minute >= LUNCH[1]) && x.progress >= x.target) x.done = true;
      break;
  }
}

/** Feed a game event to today's quests. Finished (or failed) quests ignore further events. */
export function questOnEvent(q: QuestState, s: GameState, ev: QuestEvent): void {
  if (ev.type !== 'dayEnd') ensureQuests(q, s);
  else if (q.day !== s.day) return;
  for (const x of q.list) if (!x.done) step(x, s, ev);
}

// ---------------------------------------------------------------- rewards
/** Bonus for claiming all of today's quests; grows with the streak up to STREAK_CAP. */
export function streakBonus(q: QuestState, s: GameState): { cash: number; rp: number } {
  return rewardFor(estimateDailyRevenue(s), 0.1 + 0.05 * Math.min(q.streak, STREAK_CAP));
}

function grant(s: GameState, r: { cash: number; rp: number }): void {
  // Same as milestone rewards in sim.checkMilestones: counts toward lifetime revenue, but not today's
  // sales (so it can't feed the "earn today" quest or inflate the history used to size rewards).
  s.cash += r.cash; s.lifetime.revenue += r.cash;
  s.rp += r.rp;
}

/** Claim a finished quest. Returns null on success, else the reason. Claiming the last one also pays the streak bonus. */
export function claimQuest(q: QuestState, s: GameState, id: string): string | null {
  const x = q.list.find((e) => e.id === id);
  if (!x) return 'Unknown quest';
  if (x.claimed) return 'Already claimed';
  if (!x.done) return 'Not finished yet';
  x.claimed = true;
  grant(s, x.reward);
  if (q.list.every((e) => e.claimed)) {
    grant(s, streakBonus(q, s));
    q.streak++;
  }
  return null;
}
