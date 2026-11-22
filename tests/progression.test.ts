// Progression and economy invariants: milestones, chapter 2, huge numbers, offline caps, daily costs, purchase prices.
// (tests/core.test.ts covers the basic milestone rewards, the 8h cap and the basic chapter-2 flag.)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { BusEvents, on } from '../src/core/bus';
import {
  DAY_SECONDS, DISTRICTS, FIXED_MILESTONE_COUNT, INGREDIENT_IDS, PROPERTIES, ROLES, milestone, trainCost, wageFor,
} from '../src/core/data';
import { exact, short, yen } from '../src/core/format';
import * as sim from '../src/core/sim';
import { GameState, createNewState, deserialize, serialize } from '../src/core/state';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hire(st: GameState, role: 'chef' | 'server' | 'cleaner' | 'manager', rest: string | null, skill?: number) {
  const c = sim.makeCandidate(st, role); st.candidates.push(c); st.cash += 1e9;
  if (skill) { c.skill = skill; c.wage = wageFor(role, skill); }
  const p = st.lifetime.pieces; st.lifetime.pieces = Math.max(p, 1e5);
  expect(A.hire(st, c.id, rest)).toBeNull();
  st.cash -= 1e9; st.lifetime.pieces = p;
  return c;
}
const clone = (st: GameState) => deserialize(serialize(st, st.lastSaved));
const stockUp = (st: GameState, n = 1_000) => { for (const k of INGREDIENT_IDS) st.inventory[k] = n; };

let s: GameState;
const unsubs: (() => void)[] = [];
function record<K extends keyof BusEvents>(k: K): BusEvents[K][] {
  const got: BusEvents[K][] = [];
  unsubs.push(on(k, (e) => got.push(e)));
  return got;
}
beforeEach(() => { sim.setRandom(seeded()); s = createNewState(); sim.refreshCandidates(s); });
afterEach(() => { while (unsubs.length) unsubs.pop()!(); });

describe('milestones', () => {
  it('one huge addPieces fires every crossed milestone exactly once, in order, with exact rewards', () => {
    const events = record('milestone');
    const cash0 = s.cash, rp0 = s.rp;
    sim.addPieces(s, 3e9); // crosses all fixed milestones plus the first procedural one (2.5B)
    const n = FIXED_MILESTONE_COUNT + 1;
    expect(events.map((e) => e.index)).toEqual([...Array(n).keys()]);
    expect(events.map((e) => e.title)).toEqual([...Array(n).keys()].map((i) => milestone(i).title));
    expect(s.milestoneIndex).toBe(n);
    const rewards = [...Array(n).keys()].map((i) => milestone(i).reward);
    expect(s.cash).toBe(cash0 + rewards.reduce((a, r) => a + (r.cash ?? 0), 0));
    expect(s.rp).toBeCloseTo(rp0 + 3e9 * 0.1 + rewards.reduce((a, r) => a + (r.rp ?? 0), 0), 0);
    expect(s.player.title).toBe(milestone(n - 1).title);
    expect(new Set(s.recipes).size).toBe(s.recipes.length); // recipe rewards not duplicated
    sim.addPieces(s, 1); sim.checkMilestones(s);
    expect(events.length).toBe(n);
  });

  it('many small steps and one big jump reach the same milestones and cash', () => {
    const big = createNewState(), small = createNewState();
    const bigEvents: number[] = [], smallEvents: number[] = [];
    let target: number[] = bigEvents;
    unsubs.push(on('milestone', (e) => target.push(e.index)));
    sim.addPieces(big, 2_000_000);
    target = smallEvents;
    for (let i = 0; i < 2_000; i++) sim.addPieces(small, 1_000);
    expect(smallEvents).toEqual(bigEvents);
    expect(small.cash).toBe(big.cash);
    expect(small.milestoneIndex).toBe(big.milestoneIndex);
    expect(small.flags.chapter2).toBe(true);
  });

  // regression: Infinity pieces used to spin checkMilestones forever once milestone(i).pieces overflowed to Infinity
  it('addPieces(Infinity) terminates', () => {
    sim.addPieces(s, Infinity);
    expect(Number.isSafeInteger(s.milestoneIndex)).toBe(true);
    expect(Number.isFinite(sim.nextMilestone(s).pieces)).toBe(false);
    sim.checkMilestones(s);
  });

  it('the million event fires once even when many milestones are crossed at once', () => {
    const million = record('million');
    sim.addPieces(s, 5e9);
    sim.addPieces(s, 5e9);
    expect(million.length).toBe(1);
  });

  it('procedural milestones after 1B: exact 2.5/5/10 steps, unique titles, rewards scale', () => {
    const titles = new Set<string>();
    for (let i = 0; i < FIXED_MILESTONE_COUNT; i++) titles.add(milestone(i).title);
    let prev = milestone(FIXED_MILESTONE_COUNT - 1).pieces;
    for (let k = 0; k < 50; k++) {
      const m = milestone(FIXED_MILESTONE_COUNT + k);
      expect(m.pieces).toBe([2.5e9, 5e9, 1e10][k % 3] * 10 ** Math.floor(k / 3));
      expect(m.pieces).toBeGreaterThan(prev);
      expect(titles.has(m.title)).toBe(false);
      titles.add(m.title);
      expect(m.reward.cash).toBe(Math.round(m.pieces * 90));
      expect(m.reward.text).not.toMatch(/NaN|undefined/);
      prev = m.pieces;
    }
  });
});

describe('huge numbers', () => {
  it('pieces stay exact around 1e15 and milestones line up', () => {
    sim.addPieces(s, 1e15 - 1);
    sim.addPieces(s, 1);
    expect(s.lifetime.pieces).toBe(1e15);
    for (let i = 0; i < 7; i++) sim.addPieces(s, 1);
    expect(s.lifetime.pieces).toBe(1_000_000_000_000_007);
    expect(Number.isSafeInteger(s.lifetime.pieces)).toBe(true);
    // 1e15 = 10B × 10^5 → procedural k = 17 is the last reached
    expect(s.milestoneIndex).toBe(FIXED_MILESTONE_COUNT + 18);
    expect(sim.nextMilestone(s).pieces).toBe(2.5e15);
    expect(Number.isFinite(s.cash)).toBe(true);
    expect(exact(s.lifetime.pieces)).toBe('1,000,000,000,000,007');
    expect(short(s.lifetime.pieces)).toBe('1Qa');
  });

  it.each([
    [10_000, '10K'], [12_345, '12.3K'], [100_000, '100K'], [1_500_000, '1.5M'], [25_800_000, '25.8M'],
    [1_200_000_000, '1.2B'], [2.58e16, '25.8Qa'], [-1_500_000, '-1.5M'], [-9_999, '-9,999'], [0, '0'],
  ])('short(%d) = %s', (n, want) => {
    expect(short(n)).toBe(want);
  });

  it('yen() prefixes sign before the currency symbol', () => {
    expect(yen(25_800_000)).toBe('¥25.8M');
    expect(yen(-1_200_000_000)).toBe('-¥1.2B');
  });

  // regression: values that round up to 1000 used to render as "1000K" / "1000M"
  it.each([
    [999_999, '1M'], [999_950_000, '1B'], [999_499, '999K'], [999_500, '1M'], [-999_999, '-1M'], [99_999, '100K'],
  ])('short(%d) rolls over to %s', (n, want) => {
    expect(short(n)).toBe(want);
  });

  it('short() shows NaN as a dash and keeps ∞ for infinities', () => {
    expect(short(NaN)).toBe('—');
    expect(short(Infinity)).toBe('∞');
    expect(short(-Infinity)).toBe('∞');
  });
});

describe('chapter 2 and beyond', () => {
  it('a real sale crossing 1M flips chapter2 and the restaurant keeps running', () => {
    hire(s, 'chef', 'asakusa_stand'); hire(s, 'server', 'asakusa_stand');
    stockUp(s);
    sim.addPieces(s, 999_999);
    const million = record('million');
    let guard = 0;
    while (s.lifetime.pieces < 1_000_000 && guard++ < 20_000) sim.tick(s, 0.1, { activeDistrict: null });
    expect(million.length).toBe(1);
    expect(s.flags.chapter2).toBe(true);
    const day = s.day, pieces = s.lifetime.pieces;
    stockUp(s);
    for (let i = 0; i < DAY_SECONDS * 10; i++) sim.tick(s, 0.1, { activeDistrict: null });
    expect(s.day).toBeGreaterThan(day);
    expect(s.lifetime.pieces).toBeGreaterThan(pieces);
    expect(Number.isFinite(s.cash)).toBe(true);
  });

  it('franchise ticks add pieces and exactly royalty × pieces in cash', () => {
    sim.addPieces(s, 1_000_000);
    s.cash = 1e12;
    for (let i = 0; i < 5; i++) expect(A.buyFranchise(s, 'tokyo')).toBeNull();
    const pps = sim.franchisePPS(s), royalty = sim.franchiseRoyaltyPerPiece(s);
    expect(pps).toBeGreaterThan(0);
    const cash = s.cash, pieces = s.lifetime.pieces;
    let last = pieces;
    for (let i = 0; i < 200; i++) { // 20s at 09:00 — no day end, no restaurant sales
      sim.tick(s, 0.1, { activeDistrict: null });
      expect(s.lifetime.pieces).toBeGreaterThanOrEqual(last);
      last = s.lifetime.pieces;
    }
    const gained = s.lifetime.pieces - pieces;
    expect(gained).toBeGreaterThanOrEqual(Math.floor(pps * 20) - 1);
    expect(gained).toBeLessThanOrEqual(Math.ceil(pps * 20));
    expect(s.cash - cash).toBeCloseTo(gained * royalty, 6);
  });
});

describe('offline progress', () => {
  beforeEach(() => { hire(s, 'chef', 'asakusa_stand'); hire(s, 'manager', 'asakusa_stand'); });

  it('caps at 8h normally and 12h with manager_academy', () => {
    expect(sim.offlineProgress(clone(s), 100 * 3600).seconds).toBe(8 * 3600);
    s.research.push('manager_academy');
    const at12 = sim.offlineProgress(clone(s), 12 * 3600);
    const at100 = sim.offlineProgress(clone(s), 100 * 3600);
    expect(at100.seconds).toBe(12 * 3600);
    expect(at100.pieces).toBe(at12.pieces);
    expect(at12.pieces).toBeGreaterThan(sim.offlineProgress(clone(s), 8 * 3600).pieces);
  });

  it('gives nothing for under a minute or a negative clock delta', () => {
    const cash = s.cash;
    expect(sim.offlineProgress(s, 59)).toEqual({ seconds: 0, pieces: 0, revenue: 0, expenses: 0 });
    expect(sim.offlineProgress(s, -3600).pieces).toBe(0);
    expect(s.cash).toBe(cash);
  });

  it('only managed restaurants earn; an automated restaurant without a manager stays untouched', () => {
    s.cash = 1e7; s.lifetime.pieces = 1_000; s.districts.push('shibuya');
    expect(A.buyProperty(s, 'shibuya_crossing')).toBeNull();
    hire(s, 'chef', 'shibuya_crossing'); hire(s, 'server', 'shibuya_crossing');
    const before = { ...s.restaurants.shibuya_crossing };
    const r = sim.offlineProgress(s, 4 * 3600);
    expect(r.pieces).toBeGreaterThan(0);
    expect(s.restaurants.shibuya_crossing.served).toBe(before.served);
    expect(s.restaurants.shibuya_crossing.revenue).toBe(before.revenue);
    expect(s.restaurants.asakusa_stand.revenue).toBeGreaterThan(0);
  });

  it('a managed money-pit restaurant never loses money offline', () => {
    s.cash = 1e8; s.lifetime.pieces = 60_000; s.districts.push('ginza');
    expect(A.buyProperty(s, 'ginza_flagship')).toBeNull();
    hire(s, 'chef', 'ginza_flagship', 10); hire(s, 'manager', 'ginza_flagship', 10);
    const g = s.restaurants.ginza_flagship;
    g.reputation = 0; g.cleanliness = 0; A.setPrice(s, 'ginza_flagship', 2.5);
    for (const secs of [61, 3600, 8 * 3600]) {
      const st = clone(s), cash = st.cash;
      const r = sim.offlineProgress(st, secs);
      expect(r.revenue).toBeGreaterThanOrEqual(r.expenses);
      expect(st.cash).toBeGreaterThanOrEqual(cash);
    }
  });
});

describe('end of day', () => {
  it('charges assigned wages + half wages for unassigned staff + rent, exactly', () => {
    s.cash = 1e7; s.lifetime.pieces = 1_000; s.districts.push('shibuya');
    expect(A.buyProperty(s, 'shibuya_crossing')).toBeNull();
    const assigned = [hire(s, 'chef', 'asakusa_stand'), hire(s, 'server', 'shibuya_crossing'), hire(s, 'manager', 'shibuya_crossing')];
    const benched = [hire(s, 'cleaner', null), hire(s, 'chef', null)];
    const expected = assigned.reduce((a, e) => a + e.wage, 0) + benched.reduce((a, e) => a + e.wage / 2, 0)
      + PROPERTIES.asakusa_stand.rent + PROPERTIES.shibuya_crossing.rent;
    const cash = s.cash, expenses = s.lifetime.expenses, todayExp = s.today.expenses;
    sim.endDay(s);
    expect(s.cash).toBe(cash - expected);
    expect(s.lifetime.expenses).toBe(expenses + expected);
    expect(s.history.at(-1)!.expenses).toBe(todayExp + expected);
    expect(s.today.expenses).toBe(0);
  });
});

describe('inventory under load', () => {
  it('a big kitchen with almost no stock never drives inventory negative', () => {
    s.cash = 1e8; s.lifetime.pieces = 1_000;
    expect(A.buyProperty(s, 'asakusa_house')).toBeNull();
    for (let i = 0; i < 3; i++) hire(s, 'chef', 'asakusa_house', 10);
    hire(s, 'server', 'asakusa_house'); hire(s, 'chef', 'asakusa_stand'); hire(s, 'server', 'asakusa_stand');
    stockUp(s, 1);
    const lost = s.lifetime.lost;
    const bad: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      if (i % 200 === 0) for (const k of INGREDIENT_IDS) s.inventory[k] += 3; // trickle of stock
      sim.tick(s, i % 2 ? 5 : 0.05, { activeDistrict: null });
      for (const k of INGREDIENT_IDS) if (!(s.inventory[k] >= 0 && Number.isInteger(s.inventory[k]))) bad.push(`${i}:${k}=${s.inventory[k]}`);
    }
    expect(bad).toEqual([]);
    expect(s.lifetime.lost).toBeGreaterThan(lost); // stockouts are recorded, not hidden
  }, 30_000);

  it('over-accepted orders cannot all be cooked from the same stock', () => {
    for (const k of INGREDIENT_IDS) s.inventory[k] = 0;
    s.inventory.rice = 2; s.inventory.salmon = 2;
    const tickets = [];
    for (let i = 0; i < 5; i++) {
      const t = sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 2, type: 'office', customerId: i + 1 });
      expect(t).not.toBe('nostock'); // stock is checked, not reserved
      tickets.push(t as Exclude<typeof t, 'nostock'>);
    }
    const cooked = tickets.filter((t) => sim.finishManual(s, 'asakusa_stand', t.id, 1)).length;
    expect(cooked).toBe(1);
    expect(s.inventory.rice).toBe(0);
    expect(s.inventory.salmon).toBe(0);
  });
});

describe('purchases charge exact costs and refuse when short', () => {
  it('hire', () => {
    s.lifetime.pieces = 50;
    const c = s.candidates.find((e) => e.role === 'chef')!;
    const cost = sim.hireCost(c);
    s.cash = cost - 1;
    expect(A.hire(s, c.id, 'asakusa_stand')).toMatch(/Need/);
    expect(s.cash).toBe(cost - 1);
    expect(s.staff).toEqual([]);
    expect(s.candidates).toContain(c);
    s.cash = cost;
    expect(A.hire(s, c.id, 'asakusa_stand')).toBeNull();
    expect(s.cash).toBe(0);
    expect(s.lifetime.expenses).toBe(cost);
    expect(s.candidates).not.toContain(c);
    expect(A.hire(s, c.id, 'asakusa_stand')).toMatch(/no longer available/);
  });

  it('hire refuses locked roles and full slots without charging', () => {
    s.cash = 1e6;
    const mgr = s.candidates.find((e) => e.role === 'manager')!;
    expect(A.hire(s, mgr.id, 'asakusa_stand')).toMatch(/Unlocks at/);
    s.lifetime.pieces = ROLES.manager.unlockPieces;
    const chefs = s.candidates.filter((e) => e.role === 'chef');
    expect(A.hire(s, chefs[0].id, 'asakusa_stand')).toBeNull();
    const cash = s.cash;
    expect(A.hire(s, chefs[1].id, 'asakusa_stand')).toMatch(/No free slot/); // stand has 1 chef slot
    expect(s.cash).toBe(cash);
  });

  it('fire is free and idempotent', () => {
    const c = hire(s, 'chef', 'asakusa_stand');
    const cash = s.cash;
    expect(A.fire(s, c.id)).toBeNull();
    expect(A.fire(s, c.id)).toMatch(/Unknown/);
    expect(s.cash).toBe(cash);
    expect(s.staff).toEqual([]);
  });

  it('train charges trainCost (with the training_program discount) and refuses when short or maxed', () => {
    const c = hire(s, 'chef', 'asakusa_stand');
    c.skill = 3;
    const full = trainCost('chef', 3);
    s.cash = full - 1;
    expect(A.train(s, c.id)).toMatch(/Need/);
    expect(c.skill).toBe(3);
    s.cash = full;
    expect(A.train(s, c.id)).toBeNull();
    expect(s.cash).toBe(0);
    expect(c.skill).toBe(4);
    s.research.push('training_program');
    const discounted = Math.round(trainCost('chef', 4) * 0.7);
    s.cash = discounted;
    expect(A.train(s, c.id)).toBeNull();
    expect(s.cash).toBe(0);
    c.skill = 10; s.cash = 1e9;
    expect(A.train(s, c.id)).toMatch(/master/);
    expect(s.cash).toBe(1e9);
  });

  it('buyProperty', () => {
    const price = PROPERTIES.asakusa_shop.price + A.fitoutCost('asakusa_shop', 'bar'); // lot + fit-out
    s.cash = price - 1;
    expect(A.buyProperty(s, 'asakusa_shop')).toMatch(/Need/);
    expect(s.restaurants.asakusa_shop).toBeUndefined();
    s.cash = price;
    expect(A.buyProperty(s, 'asakusa_shop')).toBeNull();
    expect(s.cash).toBe(0);
    s.cash = 1e9;
    expect(A.buyProperty(s, 'asakusa_shop')).toMatch(/Already owned/);
    expect(A.buyProperty(s, 'ginza_flagship')).toMatch(/Unlock/);
    expect(s.cash).toBe(1e9);
  });

  it('buyUpgrade at exactly the price, then refuses when maxed', () => {
    const price = A.upgradePrice(s, 'asakusa_stand', 'seats');
    s.cash = price;
    expect(A.buyUpgrade(s, 'asakusa_stand', 'seats')).toBeNull();
    expect(s.cash).toBe(0);
    s.cash = 1e12;
    while (A.buyUpgrade(s, 'asakusa_stand', 'seats') === null);
    expect(s.restaurants.asakusa_stand.upgrades.seats).toBe(A.upgradeMax('asakusa_stand', 'seats'));
    const cash = s.cash;
    expect(A.buyUpgrade(s, 'asakusa_stand', 'seats')).toMatch(/maxed/);
    expect(s.cash).toBe(cash);
  });

  it('unlockDistrict needs both pieces and cash', () => {
    const { pieces, cost } = DISTRICTS.shinjuku.unlock;
    s.cash = cost * 10; s.lifetime.pieces = pieces - 1;
    expect(A.unlockDistrict(s, 'shinjuku')).toMatch(/Sell/);
    s.lifetime.pieces = pieces; s.cash = cost - 1;
    expect(A.unlockDistrict(s, 'shinjuku')).toMatch(/Need/);
    expect(s.districts).not.toContain('shinjuku');
    expect(s.cash).toBe(cost - 1);
    s.cash = cost;
    expect(A.unlockDistrict(s, 'shinjuku')).toBeNull();
    expect(s.cash).toBe(0);
    expect(s.districts).toContain('shinjuku');
    expect(A.unlockDistrict(s, 'shinjuku')).toMatch(/Already/);
  });
});
