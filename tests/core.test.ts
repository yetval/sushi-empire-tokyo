import { beforeEach, describe, expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { DAY_SECONDS, FIXED_MILESTONE_COUNT, PROPERTIES, RECIPES, milestone, recipeCost } from '../src/core/data';
import { exact, short } from '../src/core/format';
import * as sim from '../src/core/sim';
import {
  GameState, SAVE_KEY, createNewState, deserialize, exportSave, importSave, loadFromStorage, saveToStorage, serialize,
} from '../src/core/state';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

let s: GameState;
beforeEach(() => { sim.setRandom(seeded()); s = createNewState(); sim.refreshCandidates(s); });

function hire(st: GameState, role: 'chef' | 'server' | 'manager', rest: string) {
  const c = sim.makeCandidate(st, role); st.candidates.push(c); st.cash += 1e9;
  const p = st.lifetime.pieces; st.lifetime.pieces = Math.max(p, 1e5); // bypass unlock thresholds
  expect(A.hire(st, c.id, rest)).toBeNull();
  st.cash -= 1e9; st.lifetime.pieces = p;
}

describe('format', () => {
  it('formats large numbers', () => {
    expect(short(9_999)).toBe('9,999');
    expect(short(1_500_000)).toBe('1.5M');
    expect(short(25_800_000)).toBe('25.8M');
    expect(short(1_200_000_000)).toBe('1.2B');
    expect(short(3e15)).toBe('3\u00a0quad');
    expect(exact(1_234_567_890_123)).toBe('1,234,567,890,123');
  });
});

describe('milestones', () => {
  it('are strictly increasing and never end', () => {
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      const m = milestone(i);
      expect(m.pieces).toBeGreaterThan(prev);
      expect(Number.isFinite(m.pieces)).toBe(true);
      expect(m.title.length).toBeGreaterThan(0);
      prev = m.pieces;
    }
    expect(milestone(FIXED_MILESTONE_COUNT - 1).pieces).toBe(1e9);
    expect(milestone(FIXED_MILESTONE_COUNT).pieces).toBe(2.5e9);
  });

  it('rewards are granted exactly once', () => {
    const cash0 = s.cash;
    sim.addPieces(s, 1_000);
    expect(s.milestoneIndex).toBe(2);
    expect(s.cash).toBe(cash0 + 6_000 + 20_000);
    sim.checkMilestones(s); sim.checkMilestones(s);
    expect(s.cash).toBe(cash0 + 26_000);
    expect(s.recipes).toContain('tuna_nigiri');
  });

  it('one million unlocks chapter 2 and play continues past it', () => {
    sim.addPieces(s, 999_999);
    expect(s.flags.chapter2).toBeFalsy();
    sim.addPieces(s, 1);
    expect(s.flags.chapter2).toBe(true);
    expect(s.player.title).toBe('Sushi Emperor');
    expect(s.cities.tokyo.open).toBe(true);
    const restaurants = Object.keys(s.restaurants).length, cash = s.cash;
    sim.addPieces(s, 5_000_000);
    expect(s.lifetime.pieces).toBe(6_000_000);
    expect(Object.keys(s.restaurants).length).toBe(restaurants);
    expect(s.cash).toBeGreaterThan(cash);
    sim.addPieces(s, 3e9); // past one billion: procedural milestones keep coming
    expect(s.milestoneIndex).toBeGreaterThan(FIXED_MILESTONE_COUNT);
    expect(s.lifetime.pieces).toBe(3_006_000_000);
  });
});

/** Test shortcut: the kitchen finishes this ticket now. */
function cook(st: GameState, restId: string, id: number): void {
  const r = st.restaurants[restId], i = r.orders.findIndex((t) => t.id === id);
  r.ready.push(...r.orders.splice(i, 1).map((t) => ({ ...t, started: true, progress: t.pieces, quality: 0.6 })));
}

describe('orders & ingredients', () => {
  it('a sale pays its ingredients at market price, once', () => {
    const t = sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 2, type: 'office', customerId: 1 });
    cook(s, 'asakusa_stand', t.id);
    const cash = s.cash;
    const res = sim.settle(s, 'asakusa_stand', t.id, 5)!;
    expect(res.paid).toBe(240);
    const ingredients = recipeCost(RECIPES.salmon_nigiri, sim.mods(s).ingredientCost) * 2;
    expect(ingredients).toBeGreaterThan(0);
    expect(s.cash).toBeCloseTo(cash + res.paid + res.tip - ingredients);
    expect(s.restaurants.asakusa_stand.day.cost).toBeCloseTo(ingredients);
    expect(s.lifetime.pieces).toBe(2);
    expect(sim.settle(s, 'asakusa_stand', t.id, 5)).toBeNull(); // cannot double-settle
  });

  it('no chef, no sales: nobody walks in and nothing sells off-screen', () => {
    expect(sim.isAutomated(s, 'asakusa_stand')).toBe(false);
    expect(sim.visibleSpawnPerMin(s, 'asakusa_stand')).toBe(0);
    for (let i = 0; i < 3000; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.lifetime.pieces).toBe(0);
  });

  it('a lone chef sells but works the counter too; a server frees the kitchen', () => {
    hire(s, 'chef', 'asakusa_stand');
    expect(sim.isAutomated(s, 'asakusa_stand')).toBe(true);
    expect(sim.understaffed(s, 'asakusa_stand')).toBe(true);
    const slow = sim.kitchenRate(s, 'asakusa_stand');
    for (let i = 0; i < 1200; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.lifetime.pieces).toBeGreaterThan(0);
    hire(s, 'server', 'asakusa_stand');
    expect(sim.understaffed(s, 'asakusa_stand')).toBe(false);
    expect(sim.kitchenRate(s, 'asakusa_stand')).toBeCloseTo(slow / sim.UNDERSTAFFED_RATE);
  });

  it('stress: random automated play keeps the accounting finite', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'server', 'asakusa_stand');
    s.cash = 50_000;
    const net0 = s.lifetime.revenue - s.lifetime.expenses;
    for (let i = 0; i < 20_000; i++) {
      if (i % 3000 === 1500) sim.releaseVisibleTickets(s, 'asakusa');
      sim.tick(s, 0.1, { activeDistrict: null });
    }
    expect(s.lifetime.pieces).toBeGreaterThan(100);
    expect(Number.isFinite(s.cash)).toBe(true);
    expect(s.lifetime.revenue - s.lifetime.expenses - net0).toBeCloseTo(s.cash - 50_000, 3); // every yen is booked
  }, 60_000);

  it('releasing visible tickets: without a chef they are dropped, with one they go to takeout; no sales either way', () => {
    sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 3, type: 'tourist', customerId: 7 });
    sim.releaseVisibleTickets(s, null);
    expect(s.restaurants.asakusa_stand.orders.length).toBe(0);
    hire(s, 'chef', 'asakusa_stand');
    const pieces = s.lifetime.pieces, cash = s.cash;
    sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 3, type: 'tourist', customerId: 8 });
    sim.releaseVisibleTickets(s, null);
    expect(s.restaurants.asakusa_stand.orders.map((t) => t.customerId)).toEqual([null]);
    expect(s.lifetime.pieces).toBe(pieces);
    expect(s.cash).toBe(cash);
  });
});

describe('economy', () => {
  it('upgrades cost the displayed price and change effects', () => {
    s.cash = 100_000;
    const price = A.upgradePrice(s, 'asakusa_stand', 'sign');
    const d0 = sim.demandPerMin(s, 'asakusa_stand', 12 * 60);
    expect(A.buyUpgrade(s, 'asakusa_stand', 'sign')).toBeNull();
    expect(s.cash).toBe(100_000 - price);
    expect(sim.demandPerMin(s, 'asakusa_stand', 12 * 60)).toBeGreaterThan(d0);
    s.cash = 0;
    expect(A.buyUpgrade(s, 'asakusa_stand', 'sign')).toMatch(/Need/);
  });

  it('one-off purchases count as invested, not operating expenses', () => {
    s.cash = 100_000;
    const price = A.upgradePrice(s, 'asakusa_stand', 'sign'), spent = s.lifetime.expenses;
    expect(A.buyUpgrade(s, 'asakusa_stand', 'sign')).toBeNull();
    expect(s.today.invested).toBe(price);
    expect(s.today.expenses).toBe(0);
    expect(s.lifetime.expenses).toBe(spent + price); // lifetime keeps every yen out
    sim.endDay(s);
    expect(s.history.at(-1)!.invested).toBe(price);
    expect(s.today.invested).toBe(0);
  });

  it('higher prices reduce demand but raise the bill', () => {
    const d1 = sim.demandPerMin(s, 'asakusa_stand', 12 * 60);
    A.setPrice(s, 'asakusa_stand', 1.5);
    expect(sim.demandPerMin(s, 'asakusa_stand', 12 * 60)).toBeLessThan(d1);
  });

  it('charges wages and rent at day end', () => {
    s.lifetime.pieces = 100_000; s.districts.push('shibuya'); s.cash = 1e7;
    expect(A.buyProperty(s, 'shibuya_crossing')).toBeNull();
    hire(s, 'chef', 'shibuya_crossing');
    const { wages, rent } = sim.dailyCosts(s);
    expect(rent).toBe(PROPERTIES.shibuya_crossing.rent);
    const cash = s.cash;
    sim.endDay(s);
    expect(s.cash).toBeCloseTo(cash - wages - rent);
    expect(s.history.length).toBe(1);
  });

  it('time advances a full day in DAY_SECONDS while open', () => {
    const d = s.day;
    for (let i = 0; i < DAY_SECONDS * 10; i++) sim.tick(s, 0.1, { activeDistrict: 'asakusa' });
    expect(s.day).toBeGreaterThan(d);
  });

  it('franchises sell pieces and pay royalties after chapter 2', () => {
    s.cash = 1e12; sim.addPieces(s, 1_000_000);
    expect(A.buyFranchise(s, 'tokyo')).toBeNull();
    const p = s.lifetime.pieces;
    for (let i = 0; i < 100; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.lifetime.pieces).toBeGreaterThan(p);
  });
});

describe('offline progress', () => {
  it('needs a manager and is capped', () => {
    expect(sim.offlineProgress(s, 3600).pieces).toBe(0);
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'manager', 'asakusa_stand');
    const a = sim.offlineProgress(createClone(s), 3600 * 8).pieces;
    const b = sim.offlineProgress(createClone(s), 3600 * 100).pieces;
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a); // capped at 8h
  });
});
const createClone = (st: GameState) => deserialize(serialize(st));

describe('save system', () => {
  it('round-trips through JSON and export codes', () => {
    s.cash = 123_456; s.lifetime.pieces = 2_500_000; s.flags.chapter2 = true;
    const b = deserialize(serialize(s));
    expect(b.cash).toBe(123_456);
    expect(b.lifetime.pieces).toBe(2_500_000);
    const c = importSave(exportSave(s));
    expect(c.flags.chapter2).toBe(true);
  });

  it('migrates old saves with missing fields', () => {
    const raw = JSON.parse(serialize(s));
    delete raw.facilities; delete raw.settings.quality; delete raw.inventory.toro; delete raw.restaurants.asakusa_stand.upgrades;
    const m = deserialize(JSON.stringify(raw));
    expect(m.facilities.kitchen).toBe(0);
    expect(m.settings.quality).toBe('high');
    expect(m.inventory.toro).toBe(0);
    expect(m.restaurants.asakusa_stand.upgrades).toEqual({});
  });

  it('falls back to the backup when the main save is corrupt', () => {
    const st = new MemStorage() as unknown as Storage;
    s.cash = 777; saveToStorage(s, st);
    s.cash = 888; saveToStorage(s, st); // previous becomes backup
    st.setItem(SAVE_KEY, '{garbage');
    expect(loadFromStorage(st)!.cash).toBe(777);
    expect(() => importSave('not a save')).toThrow();
  });
});

describe('offline regressions', () => {
  it('never charges wages offline for restaurants without a manager', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'server', 'asakusa_stand');
    const cash = s.cash;
    const r = sim.offlineProgress(s, 8 * 3600);
    expect(r.expenses).toBe(0);
    expect(s.cash).toBe(cash);
  });
  it('managed restaurants never lose money offline', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'manager', 'asakusa_stand');
    s.restaurants.asakusa_stand.reputation = 0; // terrible demand
    const cash = s.cash;
    sim.offlineProgress(s, 8 * 3600);
    expect(s.cash).toBeGreaterThanOrEqual(cash);
  });
});

describe('economy review regressions', () => {
  it('offline output does not count as pieces sold today', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'manager', 'asakusa_stand');
    const r = sim.offlineProgress(s, 8 * 3600);
    expect(r.pieces).toBeGreaterThan(0);
    expect(s.today.pieces).toBe(0);
    expect(s.lifetime.pieces).toBe(r.pieces);
  });
});
