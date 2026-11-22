// Game state shape, creation, persistence (LocalStorage), migration, import/export.
import type { QuestState } from './quests';
import type { Review } from './reviews';
import { createContractState, sanitizeContracts, type ContractState } from './contracts';
import {
  CAMPAIGNS, CITIES, CUSTOMERS, CustomerType, DISTRICTS, DistrictId, EVENTS, INGREDIENT_IDS, IngredientId,
  PROPERTIES, RECIPES, RIVALS, ROLES, Role, START_MINUTE, START_RECIPES, wageFor,
} from './data';

export const SAVE_VERSION = 1;
export const SAVE_KEY = 'sushi-empire-tokyo-save';

export interface Avatar {
  skin: string; hair: string; hairStyle: number; // 0 short,1 spiky,2 long,3 bun,4 bald
  shirt: string; pants: string; headwear: number; // 0 none,1 chef hat,2 headband,3 cap
}

export interface Ticket {
  id: number; recipe: string; pieces: number;
  customerId: number | null; // visible NPC id; null = takeout / off-screen order
  customerType: CustomerType;
  progress: number; // pieces cooked (fractional while kitchen works)
  started: boolean; // ingredients consumed
  cook: 'kitchen' | 'player'; // who is responsible for cooking
  manualOnly?: boolean; // VIP special request: only the player can cook it
  quality: number; // 0..1, set when finished
  createdAt: number; // state.clock seconds
}

export interface RestaurantState {
  id: string; name: string;
  upgrades: Record<string, number>;
  priceMult: number; // 0.6..2.0
  menu: string[];
  reputation: number; // 0..5 stars
  cleanliness: number; // 0..1
  signColor: string; theme: number; uniform: string;
  orders: Ticket[]; // accepted, not ready
  ready: Ticket[]; // cooked, waiting to be served
  takeoutFrac: number; // fractional arrival accumulator
  served: number; revenue: number; // lifetime for this location
  satisfaction: number; // rolling avg 0..1
  openedDay: number;
}

export interface Employee {
  id: number; name: string; role: Role; skill: number; xp: number; wage: number;
  restaurant: string | null; look: Avatar;
}

export interface DaySummary { day: number; revenue: number; expenses: number; pieces: number; customers: number }

export interface Settings {
  master: number; music: number; sfx: number; muted: boolean;
  sensitivity: number; invertY: boolean; quality: 'low' | 'medium' | 'high';
}

export interface GameState {
  version: number;
  createdAt: number; lastSaved: number;
  clock: number; // total in-game seconds elapsed while playing (monotonic)
  playTime: number;
  day: number; minute: number; // minute of day 0..1439
  cash: number;
  lifetime: { pieces: number; revenue: number; expenses: number; customers: number; tips: number; manualOrders: number; bestOrder: number; lost: number; perfectCooks: number; criticsWowed: number; fastestServe: number };
  quests: QuestState;
  contracts: ContractState;
  reviews: Record<string, Review[]>;
  piecesByRecipe: Record<string, number>;
  player: { name: string; company: string; district: DistrictId; x: number; z: number; yaw: number; avatar: Avatar; title: string | null };
  inventory: Record<IngredientId, number>;
  restock: Record<IngredientId, number>; // auto-restock targets
  restaurants: Record<string, RestaurantState>;
  staff: Employee[]; candidates: Employee[]; nextId: number;
  nextTicketId: number;
  campaigns: { id: string; district: DistrictId | null; endsDay: number; endsMinute: number }[];
  brand: number; // 0..100
  rp: number; research: string[];
  recipes: string[];
  milestoneIndex: number; // number of milestones reached
  districts: DistrictId[];
  flags: Record<string, boolean>;
  tutorial: number; // step index; 99 = done
  rivals: Record<string, Partial<Record<DistrictId, number>>>; // rival market share 0..0.6
  event: { id: string; endsDay: number } | null;
  hq: number; facilities: { kitchen: number; logistics: number };
  cities: Record<string, { open: boolean; franchises: number }>;
  franchiseFrac: number;
  history: DaySummary[]; today: DaySummary;
  settings: Settings;
}

export const DEFAULT_AVATAR: Avatar = { skin: '#f1c27d', hair: '#2b1d14', hairStyle: 0, shirt: '#ffffff', pants: '#2d3142', headwear: 2 };

export function newRestaurant(id: string, day: number, brand = 0): RestaurantState {
  const p = PROPERTIES[id];
  return {
    id, name: p.name, upgrades: {}, priceMult: 1, menu: [...START_RECIPES],
    reputation: Math.min(3.5, 2 + brand / 40), cleanliness: 1,
    signColor: '#c0392b', theme: 0, uniform: '#ffffff',
    orders: [], ready: [], takeoutFrac: 0, served: 0, revenue: 0, satisfaction: 0.7, openedDay: day,
  };
}

export function createNewState(name = 'Chef', company = 'Sushi Empire'): GameState {
  const inv = Object.fromEntries(INGREDIENT_IDS.map((i) => [i, 0])) as Record<IngredientId, number>;
  inv.rice = 30; inv.nori = 15; inv.cucumber = 15; inv.salmon = 15;
  const restock = Object.fromEntries(INGREDIENT_IDS.map((i) => [i, 0])) as Record<IngredientId, number>;
  const now = Date.now();
  return {
    version: SAVE_VERSION, createdAt: now, lastSaved: now, clock: 0, playTime: 0,
    day: 1, minute: START_MINUTE, cash: 5_000,
    lifetime: { pieces: 0, revenue: 0, expenses: 0, customers: 0, tips: 0, manualOrders: 0, bestOrder: 0, lost: 0, perfectCooks: 0, criticsWowed: 0, fastestServe: 0 },
    quests: { day: 0, list: [], streak: 0 }, reviews: {}, contracts: createContractState(),
    piecesByRecipe: {},
    player: { name, company, district: 'asakusa', x: 0, z: 14, yaw: Math.PI, avatar: { ...DEFAULT_AVATAR }, title: null },
    inventory: inv, restock,
    restaurants: { asakusa_stand: newRestaurant('asakusa_stand', 1) },
    staff: [], candidates: [], nextId: 1, nextTicketId: 1,
    campaigns: [], brand: 0, rp: 0, research: [], recipes: [...START_RECIPES],
    milestoneIndex: 0, districts: ['asakusa'], flags: {}, tutorial: 0,
    rivals: { kaiten: { asakusa: 0.1, shibuya: 0.2, shinjuku: 0.15 }, maguro: { shibuya: 0.15, shinjuku: 0.15 }, golden: { ginza: 0.25, shinjuku: 0.05 } },
    event: null, hq: 0, facilities: { kitchen: 0, logistics: 0 },
    cities: {}, franchiseFrac: 0,
    history: [], today: { day: 1, revenue: 0, expenses: 0, pieces: 0, customers: 0 },
    settings: { master: 0.8, music: 0.5, sfx: 0.8, muted: false, sensitivity: 1, invertY: false, quality: 'high' },
  };
}

// ---------------------------------------------------------------- persistence

/** Upgrade older saves, filling missing fields while retaining progress. */
export function migrate(raw: unknown): GameState {
  if (!isRecord(raw) || typeof raw.cash !== 'number') throw new Error('Not a valid save');
  const { rivals, ...fresh } = createNewState();
  deepFill(raw, fresh);
  // A missing market share means the player bought out that rival in that district.
  raw.rivals ??= rivals;
  if (!isRecord(raw.rivals)) throw new Error('Invalid rival markets');
  for (const [id, shares] of Object.entries(rivals)) raw.rivals[id] ??= shares;
  const s = raw as unknown as GameState;
  // version-specific migrations go here: if (s.version < 2) { ... }
  if (!knownId(s.player.district, DISTRICTS) || s.districts.some((d) => !knownId(d, DISTRICTS))) {
    throw new Error('Invalid district');
  }
  if (!Number.isSafeInteger(s.milestoneIndex) || s.milestoneIndex < 0) throw new Error('Invalid milestone');
  if (!Number.isSafeInteger(s.nextTicketId) || s.nextTicketId < 1) s.nextTicketId = 1;
  const ticketIds = new Set<number>();
  const ticketsToRenumber: Ticket[] = [];
  for (const [id, r] of Object.entries(s.restaurants)) {
    if (!knownId(id, PROPERTIES) || !isRecord(r)) throw new Error('Invalid restaurant');
    deepFill(r, newRestaurant(id, s.day));
    if (r.id !== id || r.menu.some((recipe) => !knownId(recipe, RECIPES))) throw new Error('Invalid restaurant menu');
    if (!(r.takeoutFrac >= 0 && r.takeoutFrac < 1)) throw new Error('Invalid takeout counter');
    for (const ticket of [...r.orders, ...r.ready]) {
      if (!isRecord(ticket) || !knownId(ticket.recipe, RECIPES) || !knownId(ticket.customerType, CUSTOMERS) || !Number.isSafeInteger(ticket.pieces) || ticket.pieces < 1) {
        throw new Error('Invalid order');
      }
      if (!Number.isSafeInteger(ticket.id) || ticket.id < 1 || ticketIds.has(ticket.id)) {
        ticketsToRenumber.push(ticket);
      } else {
        ticketIds.add(ticket.id);
        s.nextTicketId = Math.max(s.nextTicketId, ticket.id + 1);
      }
    }
  }
  // Older releases reused IDs after reload. Live NPC references are rebuilt on load.
  for (const ticket of ticketsToRenumber) ticket.id = s.nextTicketId++;
  if (s.recipes.some((recipe) => !knownId(recipe, RECIPES)) || Object.keys(s.piecesByRecipe).some((recipe) => !knownId(recipe, RECIPES))) {
    throw new Error('Invalid recipe');
  }
  sanitizeContracts(s);
  if (!isRecord(s.quests) || !Array.isArray(s.quests.list)) s.quests = { day: 0, list: [], streak: 0 };
  s.quests.list = s.quests.list.filter((x) => isRecord(x) && typeof x.id === 'string' && Number.isFinite(x.target) && Number.isFinite(x.progress));
  if (!isRecord(s.reviews)) s.reviews = {};
  for (const k of Object.keys(s.reviews)) if (!Array.isArray(s.reviews[k])) delete s.reviews[k];
  if ([...s.staff, ...s.candidates].some((employee) => !isRecord(employee) || !knownId(employee.role, ROLES))) {
    throw new Error('Invalid employee');
  }
  for (const e of [...s.staff, ...s.candidates]) {
    deepFill(e as unknown as Record<string, unknown>, { name: 'Staff', skill: 1, xp: 0, wage: wageFor(e.role, 1), restaurant: null, look: { ...DEFAULT_AVATAR } });
    if (!Number.isFinite(e.skill)) e.skill = 1;
    if (!Number.isFinite(e.wage)) e.wage = wageFor(e.role, e.skill);
  }
  for (const [id, c] of Object.entries(s.cities)) {
    if (!knownId(id, CITIES) || !isRecord(c)) { delete s.cities[id]; continue; }
    c.franchises = Number.isFinite(c.franchises) ? Math.max(0, Math.min(CITIES[id].maxFranchises, Math.floor(c.franchises))) : 0;
  }
  if (s.campaigns.some((campaign) => !isRecord(campaign) || !knownId(campaign.id, CAMPAIGNS)) ||
      (s.event !== null && (!isRecord(s.event) || !knownId(s.event.id, EVENTS)))) {
    throw new Error('Invalid event or campaign');
  }
  if (Object.entries(s.cities).some(([id, city]) => !knownId(id, CITIES) || !isRecord(city)) ||
      Object.entries(s.rivals).some(([id, shares]) => !knownId(id, RIVALS) || !isRecord(shares))) {
    throw new Error('Invalid empire markets');
  }
  if (!Number.isFinite(s.cash)) s.cash = 0;
  if (!Number.isFinite(s.lastSaved)) s.lastSaved = fresh.lastSaved;
  if (!Number.isFinite(s.lifetime.pieces) || s.lifetime.pieces < 0) s.lifetime.pieces = 0;
  for (const k of INGREDIENT_IDS) s.inventory[k] = Number.isFinite(s.inventory[k]) ? Math.max(0, Math.floor(s.inventory[k])) : 0;
  s.version = SAVE_VERSION;
  return s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function knownId(value: unknown, definitions: object): boolean {
  return typeof value === 'string' && Object.hasOwn(definitions, value);
}

function deepFill(target: Record<string, unknown>, defaults: object): void {
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = target[key];
    if (value == null) {
      target[key] = structuredClone(fallback);
    } else if (isRecord(fallback)) {
      if (!isRecord(value)) throw new Error(`Invalid save field: ${key}`);
      deepFill(value, fallback);
    } else if (Array.isArray(fallback) ? !Array.isArray(value) : fallback !== null && typeof value !== typeof fallback) {
      throw new Error(`Invalid save field: ${key}`);
    }
  }
}

/** Encode a snapshot with its capture time. */
export function serialize(s: GameState, lastSaved = Date.now()): string {
  return JSON.stringify({ ...s, lastSaved });
}

/** Note: callers must run sim.releaseVisibleTickets(s, null) after loading (NPCs are not persisted). */
export function deserialize(json: string): GameState {
  return migrate(JSON.parse(json));
}

export function saveToStorage(s: GameState, storage?: Storage): boolean {
  try {
    const target = storage ?? localStorage;
    const savedAt = Math.max(Date.now(), s.lastSaved || 0); // never move backwards: clock rollbacks can't farm offline time
    const json = serialize(s, savedAt);
    const previous = target.getItem(SAVE_KEY);
    if (previous && readSnapshot(previous)) target.setItem(SAVE_KEY + '-backup', previous);
    target.setItem(SAVE_KEY, json);
    s.lastSaved = savedAt;
    return true;
  } catch { return false; }
}

/** Returns null when no save; falls back to backup if the main save is corrupt. */
export function loadFromStorage(storage?: Storage): GameState | null {
  for (const key of [SAVE_KEY, SAVE_KEY + '-backup']) {
    try {
      const json = (storage ?? localStorage).getItem(key);
      if (!json) continue;
      const snapshot = readSnapshot(json);
      if (snapshot) return snapshot;
      console.warn('Corrupt save in', key);
    } catch { /* Try the other copy if storage cannot read this key. */ }
  }
  return null;
}

function readSnapshot(json: string): GameState | null {
  try { return deserialize(json); } catch { return null; }
}

export function exportSave(s: GameState): string { return btoa(unescape(encodeURIComponent(serialize(s)))); }
export function importSave(code: string): GameState { return deserialize(decodeURIComponent(escape(atob(code.trim())))); }
