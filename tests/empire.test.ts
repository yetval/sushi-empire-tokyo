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

  it('only managed restaurants (manager or ops_center) run themselves', () => {
    s.cash = 1e9; s.lifetime.pieces = 5_000;
    A.buyProperty(s, 'asakusa_shop', 'bar');
    const kpi = () => E.restaurantKPIs(s).find((k) => k.id === 'asakusa_shop')!;
    expect(kpi().managed).toBe(false);
    expect(kpi().health).toBe('bad'); // no chef
    for (let h = 0; h < 3; h++) { s.minute = (12 + h) * 60; E.tickEmpire(s); }
    expect(sim.staffAt(s, 'asakusa_shop', 'chef').length).toBe(0);
    s.research.push('ops_center');
    expect(kpi().managed).toBe(true);
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

describe('tycoon review A regressions', () => {
  it('offline earnings use the concept price level', () => {
    s.cash = 1e9; s.lifetime.pieces = 1e6;
    A.buyProperty(s, 'asakusa_shop', 'omakase');
    E.hireBest(s, 'asakusa_shop', 'chef'); E.hireBest(s, 'asakusa_shop', 'manager');
    const a = sim.offlineProgress(JSON.parse(JSON.stringify(s)), 3600);
    s.restaurants.asakusa_shop.concept = 'bar';
    const b = sim.offlineProgress(JSON.parse(JSON.stringify(s)), 3600);
    expect(a.revenue / Math.max(1, a.pieces)).toBeGreaterThan(b.revenue / Math.max(1, b.pieces));
  });
  it('unknown/prototype concepts in saves are repaired', async () => {
    const { deserialize, serialize } = await import('../src/core/state');
    s.restaurants.asakusa_stand.concept = 'constructor' as any;
    expect(sim.conceptOf(s, 'asakusa_stand').id).toBe('bar');
    const raw = JSON.parse(serialize(s));
    raw.restaurants.asakusa_stand.concept = 'food_truck';
    raw.restaurants.asakusa_stand.hist = [null, { rev: 'x' }];
    const m = deserialize(JSON.stringify(raw));
    expect(m.restaurants.asakusa_stand.concept).toBe('stand');
    expect(m.restaurants.asakusa_stand.hist.every((d) => Number.isFinite(d.rev))).toBe(true);
    expect(() => E.restaurantKPIs(m)).not.toThrow();
  });
  it('unassigning before midnight does not halve wages', () => {
    s.cash = 1e9;
    E.hireBest(s, 'asakusa_stand', 'chef');
    const full = sim.dailyCosts(s).wages;
    A.assign(s, s.staff[0].id, null);
    expect(sim.dailyCosts(s).wages).toBe(full);
  });
});

describe('alerts and health', () => {
  it('a chef without a server is understaffed: warn health, one-click server hire', () => {
    s.cash = 1e6;
    A.buyProperty(s, 'asakusa_shop', 'bar');
    E.hireBest(s, 'asakusa_shop', 'chef');
    const a = E.alerts(s).find((x) => x.id === 'understaffed')!;
    expect(a.restIds).toContain('asakusa_shop');
    expect(E.restaurantKPIs(s).find((k) => k.id === 'asakusa_shop')!.health).not.toBe('good');
    expect(E.applyFix(s, a)).toBeNull();
    expect(sim.staffAt(s, 'asakusa_shop', 'server').length).toBe(1);
    expect(E.alerts(s).some((x) => x.id === 'understaffed' && x.restIds.includes('asakusa_shop'))).toBe(false);
  });
});
