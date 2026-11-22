// Balance check: a "tycoon" bot plays the real economy sim and we measure pacing.
// It hires a chef for the stand at once (only chefs cook), then plays like a sensible owner:
// unlocks areas, buys lots with a format that fits the area, staffs via empire.hireBest,
// fixes alerts, upgrades, markets and (after 1M) franchises.
import { expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { AREAS, CAMPAIGNS, CITY_IDS, CONCEPTS, ConceptId, DAY_SECONDS, PROPERTIES, RESEARCH, RECIPES, UPGRADES } from '../src/core/data';
import * as E from '../src/core/empire';
import { short } from '../src/core/format';
import * as sim from '../src/core/sim';
import { createNewState, GameState } from '../src/core/state';

function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Format a sensible owner picks for a lot: luxury areas get omakase, big lots kaiten, remote lots ghost, else kiosk/bar. */
function chooseConcept(s: GameState, propId: string): ConceptId {
  const p = PROPERTIES[propId], area = AREAS[p.district];
  if (p.kind === 'stand') return 'stand';
  const ok = (c: ConceptId) => A.conceptAllowed(s, propId, c) === null;
  const owned = Object.values(s.restaurants);
  const share = (c: ConceptId) => owned.filter((r) => r.concept === c).length / Math.max(1, owned.length);
  if (area.elasticity <= 0.9 && ok('omakase') && share('omakase') < 0.25) return 'omakase';
  if (p.kind !== 'shop' && ok('kaiten') && share('kaiten') < 0.45) return 'kaiten';
  if (!area.walkable && ok('ghost') && share('ghost') < 0.25) return 'ghost';
  return share('kiosk') < 0.5 ? 'kiosk' : 'bar';
}

const lotCost = (s: GameState, propId: string) => PROPERTIES[propId].price + A.fitoutCost(propId, chooseConcept(s, propId));

function bot(s: GameState): void {
  const ids = Object.keys(s.restaurants);
  // research: a few priorities first, then the cheapest available
  const prio = ['knife_skills', 'bulk_buying'];
  const avail = Object.keys(RESEARCH).filter((r) => !A.canResearch(s, r))
    .sort((a, b) => Number(prio.includes(b)) - Number(prio.includes(a)) || RESEARCH[a].cost - RESEARCH[b].cost);
  if (avail.length) A.doResearch(s, avail[0]);
  {
    for (const al of E.alerts(s)) {
      if (!al.fix || al.fix.cost > s.cash * (al.severity === 'critical' ? 0.95 : 0.5) || al.fix.id === 'priceDown') continue;
      E.applyFix(s, al);
    }
    for (const k of E.restaurantKPIs(s)) {
      if (!k.automated) continue;
      const r = s.restaurants[k.id];
      if (k.load > 1.05 && k.staff.chef[0] < k.staff.chef[1] && s.cash > 15_000) E.hireBest(s, k.id, 'chef');
      else if (k.load > 1.1 && r.priceMult < 2) A.setPrice(s, k.id, r.priceMult + 0.05);
      else if (k.load < 0.7 && r.priceMult > 0.8) A.setPrice(s, k.id, r.priceMult - 0.05);
      if (sim.conceptOf(s, k.id).needsServer && k.staff.server[0] < Math.min(k.staff.server[1], Math.ceil((k.staff.chef[0] + 1) / 3))) E.hireBest(s, k.id, 'server');
    }
  }
  // menus: everything but volume formats keeps the six best-earning recipes
  const byPrice = [...s.recipes].sort((a, b) => RECIPES[b].price - RECIPES[a].price);
  for (const id of ids) {
    const r = s.restaurants[id];
    if (r.concept !== 'kaiten' && r.concept !== 'kiosk') r.menu = byPrice.slice(0, 6);
  }
  // expansion: unlock the cheapest reachable area, then the cheapest lot once every restaurant is crewed
  const areas = Object.values(AREAS).filter((a) => !s.districts.includes(a.id) && s.lifetime.pieces >= a.unlock.pieces && (!a.unlock.chapter2 || s.flags.chapter2)).sort((a, b) => a.unlock.cost - b.unlock.cost);
  if (areas[0] && s.cash > areas[0].unlock.cost * 1.6) A.unlockDistrict(s, areas[0].id);
  const lots = Object.values(PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district)).sort((a, b) => lotCost(s, a.id) - lotCost(s, b.id));
  if (lots[0] && ids.every((id) => sim.isAutomated(s, id)) && s.cash > lotCost(s, lots[0].id) * 1.1 + 4_000) A.buyProperty(s, lots[0].id, chooseConcept(s, lots[0].id));
  // upgrades that move the needle, cheapest first
  let best: [string, string, number] | null = null;
  for (const id of ids) for (const u of ['station', 'sign', 'delivery', 'expand', 'extra_station', 'register', 'seats', 'fridge']) {
    if (!UPGRADES[u] || (s.restaurants[id].upgrades[u] ?? 0) >= A.upgradeMax(id, u)) continue;
    const c = A.upgradePrice(s, id, u);
    if (!best || c < best[2]) best = [id, u, c];
  }
  if (best && s.cash > best[2] * 3) A.buyUpgrade(s, best[0], best[1]);
  for (const c of ['newspaper', 'social', 'influencer', 'billboard', 'tv']) if (s.cash > CAMPAIGNS[c].cost * 8) A.launchCampaign(s, c);
  if (s.flags.chapter2) {
    for (const c of CITY_IDS) if (!s.cities[c]?.open) A.openCity(s, c);
    for (const c of CITY_IDS) if (s.cities[c]?.open && s.cash > A.franchisePrice(s, c) * 2) A.buyFranchise(s, c);
    if (s.cash > 3e8) { A.buyHQ(s); A.buyFacility(s, 'kitchen'); A.buyFacility(s, 'logistics'); }
  }
}

interface Run { marks: Record<string, number>; reached: string[]; s: GameState; worstNeg: number }

/** Simulate `hours` of real play (1 s steps); stops early at `stopAt` pieces. */
function play(hours: number, stopAt = Infinity, seed = 7): Run {
  sim.setRandom(seeded(seed));
  const s = createNewState();
  sim.refreshCandidates(s);
  const marks: Record<string, number> = {};
  const reached: string[] = [];
  let mi = 0, t = 0, worstNeg = 0;
  // the first tutorial action: hire a chef for the stand with the starting cash
  expect(E.hireBest(s, 'asakusa_stand', 'chef')).toBeNull();
  s.tutorial = 99;
  while (t < hours * 3600 && s.lifetime.pieces < stopAt) {
    sim.tick(s, 1, { activeDistrict: null });
    E.tickEmpire(s);
    t++;
    if (t % 5 === 0) bot(s);
    worstNeg = Math.min(worstNeg, s.cash);
    const n = Object.keys(s.restaurants).length;
    if (marks.crew === undefined && sim.isAutomated(s, 'asakusa_stand')) marks.crew = t / 60;
    for (const k of [3, 10, 25]) if (marks['r' + k] === undefined && n >= k) marks['r' + k] = t / 60;
    while (s.milestoneIndex > mi) {
      marks['m' + mi] = t / 60;
      reached.push(`${(t / 60).toFixed(0).padStart(5)} min  ${short(s.lifetime.pieces).padStart(6)}  cash ${short(s.cash).padStart(6)}  rest ${String(n).padStart(2)}  staff ${s.staff.length}`);
      mi++;
    }
  }
  return { marks, reached, s, worstNeg };
}

it('tycoon progression pacing is reasonable', () => {
  const run = play(9, 1_500_000);
  const { marks, s } = run;
  const byConcept: Record<string, { n: number; pcs: number; profit: number }> = {};
  for (const r of Object.values(s.restaurants)) {
    const b = (byConcept[r.concept] ??= { n: 0, pcs: 0, profit: 0 });
    const days = r.hist.slice(-3);
    b.n++;
    b.pcs += days.reduce((a, d) => a + d.pieces, 0) / Math.max(1, days.length);
    b.profit += days.reduce((a, d) => a + d.rev - d.cost, 0) / Math.max(1, days.length);
  }
  console.log([
    'Tycoon timeline (play minutes):', ...run.reached,
    `first crew ${marks.crew?.toFixed(1)} min · 3 restaurants ${marks.r3?.toFixed(0)} · 10 restaurants ${marks.r10?.toFixed(0)} · 25 restaurants ${marks.r25?.toFixed(0)} min`,
    `end: ${short(s.lifetime.pieces)} pieces, cash ${short(s.cash)}, ${Object.keys(s.restaurants).length} restaurants in ${new Set(Object.keys(s.restaurants).map((id) => PROPERTIES[id].district)).size} areas, worst cash ${short(run.worstNeg)}`,
    `remote payback (lot + fit-out ÷ avg profit/day, last 3 days): ${Object.values(s.restaurants).filter((r) => !AREAS[PROPERTIES[r.id].district].walkable && r.hist.length >= 3).map((r) => { const d = r.hist.slice(-3); const pd = d.reduce((x, y) => x + y.rev - y.cost, 0) / 3; return (lotCost(s, r.id) / Math.max(1, pd)).toFixed(1); }).join(' ')} days`,
    ...Object.entries(byConcept).map(([c, b]) => `  ${CONCEPTS[c as ConceptId].name.padEnd(16)} ×${b.n}  per restaurant per day: ${short(b.pcs / b.n)} pcs, profit ${short(b.profit / b.n)}`),
  ].join('\n'));
  expect(marks.r3).toBeLessThan(60); // 3 restaurants ≈ 45 min
  expect(marks.r10).toBeLessThan(200); // 10 restaurants ≈ 2.5 h
  expect(marks.m7).toBeGreaterThan(4 * 60); // 1M takes real effort...
  expect(marks.m7).toBeLessThan(7.5 * 60); // ...but lands around 5–6 h
  expect(Object.keys(s.restaurants).length).toBeGreaterThanOrEqual(25); // a real empire by 1M
}, 600_000);

it('the first chef pays back in about one in-game day', () => {
  // New game, hire the cheapest chef on offer, stand only (no server, no upgrades): how long until the stand's
  // profit since hiring covers the hire fee? The tutorial promises a quick first sale and a sane first day.
  sim.setRandom(seeded(3));
  const s = createNewState();
  sim.refreshCandidates(s);
  const chef = s.candidates.filter((c) => c.role === 'chef').sort((a, b) => sim.hireCost(a) - sim.hireCost(b))[0];
  const fee = sim.hireCost(chef);
  expect(s.cash).toBeGreaterThanOrEqual(fee + chef.wage); // starting cash covers the best case with a day's margin
  expect(A.hire(s, chef.id, 'asakusa_stand')).toBeNull();
  const cash0 = s.cash;
  let firstSale = -1, payback = -1;
  for (let t = 1; t <= 3 * DAY_SECONDS && payback < 0; t++) {
    sim.tick(s, 1, { activeDistrict: null });
    if (firstSale < 0 && s.lifetime.customers > 0) firstSale = t;
    if (s.cash - cash0 - (t < DAY_SECONDS ? chef.wage * t / DAY_SECONDS : 0) >= fee) payback = t; // wages accrue through the day, paid at midnight
  }
  console.log(`first chef (skill ${chef.skill}, fee ¥${fee}): first sale after ${firstSale} s, pays back after ${(payback / DAY_SECONDS).toFixed(2)} days`);
  expect(firstSale).toBeGreaterThan(0);
  expect(firstSale).toBeLessThan(50); // off-screen takeout; walk-in guests at the stand add to this
  expect(payback).toBeGreaterThan(0.6 * DAY_SECONDS);
  expect(payback).toBeLessThan(1.4 * DAY_SECONDS);
});
