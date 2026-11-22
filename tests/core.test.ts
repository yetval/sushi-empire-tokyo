import { beforeEach, describe, expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { DAY_SECONDS, FIXED_MILESTONE_COUNT, INGREDIENT_IDS, PROPERTIES, milestone } from '../src/core/data';
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

const totalInv = (st: GameState) => INGREDIENT_IDS.reduce((a, k) => a + st.inventory[k], 0);
function hire(st: GameState, role: 'chef' | 'server' | 'cleaner' | 'manager', rest: string) {
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
    expect(short(3e15)).toBe('3Qa');
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
    expect(s.cash).toBe(cash0 + 2_000 + 15_000);
    sim.checkMilestones(s); sim.checkMilestones(s);
    expect(s.cash).toBe(cash0 + 17_000);
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

describe('orders & inventory', () => {
  it('rejects orders without stock and never goes negative', () => {
    expect(sim.acceptOrder(s, 'asakusa_stand', { recipe: 'tuna_nigiri', pieces: 2, type: 'office', customerId: 1 })).toBe('nostock');
    s.inventory.salmon = 3;
    const t = sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 2, type: 'office', customerId: 1 });
    expect(t).not.toBe('nostock');
    expect(s.inventory.salmon).toBe(3); // consumed only when cooking starts
    expect(sim.finishManual(s, 'asakusa_stand', (t as any).id, 1)).toBe(true);
    expect(s.inventory.salmon).toBe(1);
    expect(s.inventory.rice).toBe(28);
    const cash = s.cash;
    const res = sim.settle(s, 'asakusa_stand', (t as any).id, 5)!;
    expect(res.paid).toBe(240);
    expect(s.cash).toBeCloseTo(cash + res.paid + res.tip);
    expect(s.lifetime.pieces).toBe(2);
    expect(sim.settle(s, 'asakusa_stand', (t as any).id, 5)).toBeNull(); // cannot double-settle
  });

  it('buying ingredients respects cash and storage', () => {
    s.cash = 100;
    const got = sim.buyIngredient(s, 'salmon', 50);
    expect(got).toBe(2);
    expect(s.cash).toBeGreaterThanOrEqual(0);
    s.cash = 1e9;
    sim.buyIngredient(s, 'rice', 1e6);
    expect(sim.storageUsed(s)).toBe(sim.mods(s).storage);
  });

  it('stress: random automated play never makes inventory negative or loses accounting', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'server', 'asakusa_stand');
    s.cash = 50_000;
    for (let i = 0; i < 20_000; i++) {
      if (i % 500 === 0) for (const k of ['rice', 'nori', 'cucumber', 'salmon'] as const) sim.buyIngredient(s, k, 40);
      if (i % 3000 === 1500) sim.releaseVisibleTickets(s, 'asakusa');
      sim.tick(s, 0.1, { activeDistrict: null });
      for (const k of INGREDIENT_IDS) expect(s.inventory[k]).toBeGreaterThanOrEqual(0);
    }
    expect(s.lifetime.pieces).toBeGreaterThan(100);
    expect(Number.isFinite(s.cash)).toBe(true);
  }, 60_000);

  it('releasing visible tickets conserves ingredients and creates no sales', () => {
    s.inventory.salmon = 10;
    const t = sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 3, type: 'tourist', customerId: 7 }) as any;
    sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 2, type: 'tourist', customerId: 8 });
    sim.finishManual(s, 'asakusa_stand', t.id, 0.8); // consumes 3
    const before = totalInv(s), pieces = s.lifetime.pieces, cash = s.cash;
    sim.releaseVisibleTickets(s, null); // not automated → refunds the cooked one, drops the uncooked one
    expect(totalInv(s)).toBe(before + 3 * 2); // salmon+rice for 3 pieces
    expect(s.lifetime.pieces).toBe(pieces);
    expect(s.cash).toBe(cash);
    expect(s.restaurants.asakusa_stand.orders.length + s.restaurants.asakusa_stand.ready.length).toBe(0);
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

  it('a non-automated restaurant earns nothing off-screen', () => {
    for (let i = 0; i < 3000; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.lifetime.pieces).toBe(0);
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
  it('out-of-season items can always be removed from the menu', () => {
    const r = s.restaurants.asakusa_stand;
    r.menu = ['sakura_ebi_nigiri', 'salmon_nigiri'];
    s.day = 10; // summer: sakura recipe is out of season
    expect(A.toggleMenu(s, 'asakusa_stand', 'sakura_ebi_nigiri')).toBeNull();
    expect(A.toggleMenu(s, 'asakusa_stand', 'salmon_nigiri')).toMatch(/at least one/);
    expect(A.toggleMenu(s, 'asakusa_stand', 'sakura_ebi_nigiri')).toMatch(/not unlocked/);
  });
});
describe('menu always keeps a permanent recipe', () => {
  it('cannot reduce a menu to seasonal-only items', () => {
    const r = s.restaurants.asakusa_stand;
    s.day = 3; // spring
    r.menu = ['salmon_nigiri'];
    expect(A.toggleMenu(s, 'asakusa_stand', 'sakura_ebi_nigiri')).toBeNull();
    expect(A.toggleMenu(s, 'asakusa_stand', 'salmon_nigiri')).toMatch(/at least one/);
  });
});
describe('auto-restock with a manager', () => {
  it('restocks menu ingredients without any research, and respects a player switching one off', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'manager', 'asakusa_stand');
    s.cash = 1e6;
    for (const k of INGREDIENT_IDS) s.inventory[k] = 0;
    for (let i = 0; i < 30; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.inventory.rice).toBeGreaterThan(50);
    expect(s.inventory.salmon).toBeGreaterThan(50);
    s.restock.salmon = 0; s.inventory.salmon = 0;
    for (let i = 0; i < 30; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.inventory.salmon).toBe(0);
  });
});
