import { beforeEach, describe, expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { AREAS, PROPERTIES, REMOTE_AREAS } from '../src/core/data';
import * as E from '../src/core/empire';
import * as sim from '../src/core/sim';
import { GameState, createNewState } from '../src/core/state';

let s: GameState;
beforeEach(() => { s = createNewState(); sim.refreshCandidates(s); });

describe('tycoon: areas, concepts, many restaurants', () => {
  it('has many lots across walkable and management-only areas', () => {
    expect(Object.keys(PROPERTIES).length).toBeGreaterThanOrEqual(60);
    expect(Object.keys(REMOTE_AREAS).length).toBeGreaterThanOrEqual(15);
    for (const p of Object.values(PROPERTIES)) expect(AREAS[p.district]).toBeTruthy();
  });

  it('remote restaurants earn off-screen once staffed', () => {
    s.cash = 1e9; s.lifetime.pieces = 5_000;
    expect(A.unlockDistrict(s, 'ueno')).toBeNull();
    expect(A.buyProperty(s, 'ueno_1', 'kiosk')).toBeNull();
    expect(s.restaurants.ueno_1.concept).toBe('kiosk');
    expect(E.alerts(s).some((a) => a.id === 'unstaffed' && a.restIds.includes('ueno_1'))).toBe(true);
    const fix = E.alerts(s).find((a) => a.id === 'unstaffed')!;
    expect(E.applyFix(s, fix)).toBeNull();
    expect(sim.isAutomated(s, 'ueno_1')).toBe(true);
    for (const k of Object.keys(s.inventory)) (s.inventory as any)[k] = 200;
    s.minute = 12 * 60;
    for (let i = 0; i < 600; i++) sim.tick(s, 0.1, { activeDistrict: 'asakusa' });
    expect(s.restaurants.ueno_1.day.pieces).toBeGreaterThan(0);
    expect(s.restaurants.ueno_1.day.rev).toBeGreaterThan(0);
  });

  it('ghost kitchens need no servers and get no walk-ins', () => {
    s.cash = 1e9; s.lifetime.pieces = 20_000; s.districts.push('ueno');
    expect(A.buyProperty(s, 'ueno_2', 'ghost')).toBeNull();
    expect(E.hireBest(s, 'ueno_2', 'chef')).toBeNull();
    expect(sim.isAutomated(s, 'ueno_2')).toBe(true);
    expect(sim.visibleSpawnPerMin(s, 'ueno_2')).toBe(0);
    expect(sim.slotsFor(s, 'ueno_2', 'server')).toBe(0);
  });

  it('concepts gate on progress and stands stay on stand lots', () => {
    s.cash = 1e9;
    expect(A.buyProperty(s, 'asakusa_shop', 'omakase')).toMatch(/unlocks/);
    expect(A.buyProperty(s, 'asakusa_shop', 'stand')).toMatch(/stand/);
    expect(A.buyProperty(s, 'asakusa_shop', 'kiosk')).toBeNull();
    s.lifetime.pieces = 60_000;
    expect(A.setConcept(s, 'asakusa_shop', 'omakase')).toBeNull();
    expect(sim.bill(s, 'asakusa_shop', { recipe: 'salmon_nigiri', pieces: 1, manualOnly: false } as any)).toBeGreaterThan(150); // omakase price level > a bar's ¥120
  });

  it('house rules need a manager or research, then auto-hire and auto-price', () => {
    s.cash = 1e9; s.lifetime.pieces = 5_000;
    A.buyProperty(s, 'asakusa_shop', 'bar');
    expect(A.setPolicy(s, 'asakusa_shop', 'autoHire', true)).toMatch(/manager/);
    s.research.push('ops_center');
    expect(A.setPolicy(s, 'asakusa_shop', 'autoHire', true)).toBeNull();
    expect(A.setPolicy(s, 'asakusa_shop', 'autoPrice', true)).toBeNull();
    for (let h = 0; h < 6; h++) { s.minute = (12 + h) * 60; E.tickEmpire(s); }
    expect(sim.staffAt(s, 'asakusa_shop', 'chef').length).toBeGreaterThan(0);
    expect(sim.isAutomated(s, 'asakusa_shop')).toBe(true);
    expect(s.restaurants.asakusa_shop.log.some((l) => /Hired/.test(l))).toBe(true);
  });

  it('per-restaurant books close each day into history', () => {
    s.cash = 1e9;
    A.buyProperty(s, 'asakusa_shop', 'bar');
    s.restaurants.asakusa_shop.day.rev = 1000;
    sim.endDay(s);
    const h = s.restaurants.asakusa_shop.hist;
    expect(h.length).toBe(1);
    expect(h[0].rev).toBe(1000);
    expect(h[0].cost).toBeGreaterThan(0); // rent
    expect(E.restaurantKPIs(s).find((k) => k.id === 'asakusa_shop')!.profitYesterday).toBe(1000 - h[0].cost);
  });

  it('world areas require chapter 2', () => {
    s.cash = 1e12; s.lifetime.pieces = 1e9;
    expect(A.unlockDistrict(s, 'nyc_midtown')).toMatch(/Chapter 2/);
  });
});
