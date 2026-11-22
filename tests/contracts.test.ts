import { describe, expect, it } from 'vitest';
import { on } from '../src/core/bus';
import { CLIENTS, acceptContract, contracts, generateOffers, tickContracts, type Contract } from '../src/core/contracts';
import { INGREDIENT_IDS } from '../src/core/data';
import * as sim from '../src/core/sim';
import { GameState, createNewState, newRestaurant } from '../src/core/state';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Automated stand (chef + server), plus an unstaffed shop; menu contains a recipe the player hasn't unlocked. */
function state(): GameState {
  sim.setRandom(seeded(7));
  const s = createNewState();
  s.lifetime.pieces = 30_000; s.milestoneIndex = 30; // no milestone cash muddying the books
  for (const role of ['chef', 'chef', 'server'] as const) { const e = sim.makeCandidate(s, role); e.skill = 3; e.restaurant = 'asakusa_stand'; s.staff.push(e); }
  s.restaurants.asakusa_stand.menu.push('toro_nigiri');
  s.restaurants.asakusa_shop = newRestaurant('asakusa_shop', 1);
  for (const k of INGREDIENT_IDS) s.inventory[k] = 2_000;
  return s;
}

const accepted = (s: GameState, rng = seeded(1)): Contract => {
  const offers = generateOffers(s, rng);
  expect(offers.length).toBeGreaterThan(0);
  const c = acceptContract(s, offers[0].id);
  if (typeof c === 'string') throw new Error(c);
  return c;
};

describe('catering contracts', () => {
  it('offers only unlocked menu recipes at staffed restaurants, and pay better than sales', () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = state();
      for (const o of generateOffers(s, seeded(seed))) {
        expect(o.restaurant).toBe('asakusa_stand'); // the shop has no chef
        expect(s.recipes).toContain(o.recipe);
        expect(s.restaurants[o.restaurant].menu).toContain(o.recipe);
        expect(o.qty).toBeGreaterThanOrEqual(10);
        expect(o.payout).toBeGreaterThan(sim.bill(s, o.restaurant, { recipe: o.recipe, pieces: o.qty } as never) * 1.5);
        expect(CLIENTS[o.client].minPieces).toBeLessThanOrEqual(s.lifetime.pieces);
        expect(o.deadline.day).toBeGreaterThan(s.day);
      }
    }
  });

  it('no chefs, no offers', () => {
    const s = createNewState();
    expect(generateOffers(s, seeded(3))).toEqual([]);
  });

  it('is deterministic with a seeded rng', () => {
    expect(generateOffers(state(), seeded(99))).toEqual(generateOffers(state(), seeded(99)));
  });

  it('fails exactly once past the deadline, with the reputation hit', () => {
    const s = state();
    const c = accepted(s);
    s.inventory = Object.fromEntries(INGREDIENT_IDS.map((k) => [k, 0])) as GameState['inventory']; // can't cook
    const rep = s.restaurants[c.restaurant].reputation, cash = s.cash;
    tickContracts(s, 1);
    expect(contracts(s).active).toHaveLength(1);
    s.day = c.deadline.day; s.minute = c.deadline.minute;
    tickContracts(s, 1); tickContracts(s, 1);
    expect(s.restaurants[c.restaurant].reputation).toBeCloseTo(rep - c.repPenalty);
    expect(contracts(s).failed).toBe(1);
    expect(contracts(s).active).toHaveLength(0);
    expect(s.cash).toBe(cash);
  });

  it('delivery pays exactly once: cash += payout, pieces += qty', () => {
    const s = state();
    const c = accepted(s);
    const cash = s.cash, pieces = s.lifetime.pieces, byRecipe = s.piecesByRecipe[c.recipe] ?? 0;
    for (let i = 0; i < 5_000 && contracts(s).active.length; i++) tickContracts(s, 0.5);
    for (let i = 0; i < 50; i++) tickContracts(s, 0.5);
    expect(contracts(s).completed).toBe(1);
    expect(s.cash - cash).toBeCloseTo(c.payout);
    expect(s.lifetime.pieces - pieces).toBe(c.qty);
    expect(s.piecesByRecipe[c.recipe] - byRecipe).toBe(c.qty);
  });

  it('no double pay alongside takeout settlement and scene transitions', () => {
    const s = state();
    const c = accepted(s);
    let sales = 0, salePieces = 0;
    const off = on('sale', (e) => { sales += e.paid + e.tip; salePieces += e.pieces; });
    const rev = s.lifetime.revenue, pieces = s.lifetime.pieces;
    s.minute = 12 * 60;
    for (let i = 0; i < 20_000 && contracts(s).active.length; i++) {
      sim.tick(s, 0.1, { activeDistrict: null });
      tickContracts(s, 0.1);
      if (i % 500 === 0) sim.releaseVisibleTickets(s, null);
    }
    off();
    expect(contracts(s).completed).toBe(1);
    expect(sales).toBeGreaterThan(0); // takeout really ran alongside
    expect(s.lifetime.revenue - rev).toBeCloseTo(sales + c.payout);
    expect(s.lifetime.pieces - pieces).toBe(salePieces + c.qty);
  });

  it('rejects unknown, expired, or excess offers', () => {
    const s = state();
    expect(acceptContract(s, 12345)).toBe('Offer expired');
    const st = contracts(s);
    const o = generateOffers(s, seeded(1))[0];
    st.offers = [0, 1, 2, 3].map((i) => ({ ...o, id: 100 + i }));
    for (let i = 0; i < 3; i++) expect(typeof acceptContract(s, 100 + i)).toBe('object');
    expect(acceptContract(s, 103)).toMatch(/Max/);
  });
});
