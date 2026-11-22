// Balance check: a "tycoon" bot plays the real economy sim and we measure pacing.
// It hand-cooks at the stand until the first crew is hired, then plays like a sensible owner:
// unlocks areas, buys lots with a format that fits the area, staffs via empire.hireBest,
// fixes alerts, turns on house rules when available, upgrades, markets and (after 1M) franchises.
import { expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { AREAS, CAMPAIGNS, CITY_IDS, CONCEPTS, ConceptId, PROPERTIES, RESEARCH, RECIPES, UPGRADES } from '../src/core/data';
import * as E from '../src/core/empire';
import { short } from '../src/core/format';
import * as sim from '../src/core/sim';
import { createNewState, deserialize, GameState, serialize } from '../src/core/state';

function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Style = 'hands-on' | 'rules';

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

function bot(s: GameState, style: Style, expand = true): void {
  const ids = Object.keys(s.restaurants);
  // stock: until auto-restock exists, keep ~0.4 day of use (with a floor for the hand-run stand)
  if (!sim.autoRestockOn(s)) {
    const use = E.ingredientUsePerSec(s);
    for (const k of sim.neededIngredients(s)) {
      const want = Math.max(25, Math.ceil(use[k] * 600 * 0.4));
      if (s.inventory[k] < want * 0.6) sim.buyIngredient(s, k, want - s.inventory[k], true);
    }
  }
  // research: a few priorities first, then the cheapest available
  const prio = ['ops_center', 'auto_restock', 'phone_orders', 'knife_skills', 'bulk_buying'];
  const avail = Object.keys(RESEARCH).filter((r) => !A.canResearch(s, r))
    .sort((a, b) => Number(prio.includes(b)) - Number(prio.includes(a)) || RESEARCH[a].cost - RESEARCH[b].cost);
  if (avail.length) A.doResearch(s, avail[0]);
  // 'rules' owners hand everything to house rules once available (only critical alerts by hand);
  // until then — and always for 'hands-on' owners — staffing and prices are managed by hand
  const ruled = (id: string) => style === 'rules' && A.canUsePolicies(s, id);
  for (const id of ids) if (ruled(id)) s.restaurants[id].policy = { autoHire: true, autoPrice: true };
  {
    for (const al of E.alerts(s)) {
      if (!al.fix || al.fix.cost > s.cash * (al.severity === 'critical' ? 0.95 : 0.5) || al.fix.id === 'priceDown') continue;
      if (al.restIds.length && al.restIds.every(ruled) && al.severity !== 'critical') continue;
      E.applyFix(s, al);
    }
    for (const k of E.restaurantKPIs(s)) {
      if (!k.automated || ruled(k.id)) continue;
      const r = s.restaurants[k.id];
      if (k.load > 1.05 && k.staff.chef[0] < k.staff.chef[1] && s.cash > 15_000) E.hireBest(s, k.id, 'chef');
      else if (k.load > 1.1 && r.priceMult < 2) A.setPrice(s, k.id, r.priceMult + 0.05);
      else if (k.load < 0.7 && r.priceMult > 0.8) A.setPrice(s, k.id, r.priceMult - 0.05);
      if (sim.conceptOf(s, k.id).needsServer && k.staff.server[0] < Math.min(k.staff.server[1], Math.ceil((k.staff.chef[0] + 1) / 3))) E.hireBest(s, k.id, 'server');
      if (r.cleanliness < 0.6 && !k.staff.cleaner[0]) E.hireBest(s, k.id, 'cleaner');
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
  if (expand && areas[0] && s.cash > areas[0].unlock.cost * 1.6) A.unlockDistrict(s, areas[0].id);
  const lots = Object.values(PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district)).sort((a, b) => lotCost(s, a.id) - lotCost(s, b.id));
  if (expand && lots[0] && ids.every((id) => sim.isAutomated(s, id)) && s.cash > lotCost(s, lots[0].id) * 1.1 + 4_000) A.buyProperty(s, lots[0].id, chooseConcept(s, lots[0].id));
  // upgrades that move the needle, cheapest first
  let best: [string, string, number] | null = null;
  for (const id of ids) for (const u of ['station', 'sign', 'delivery', 'expand', 'extra_station', 'register', 'seats', 'fridge', 'cleaning']) {
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

/** Simulate `hours` of real play (1 s steps) for a bot style; stops early at `stopAt` pieces. */
function play(style: Style, hours: number, stopAt = Infinity, seed = 7): Run {
  sim.setRandom(seeded(seed));
  const s = createNewState();
  sim.refreshCandidates(s);
  const marks: Record<string, number> = {};
  const reached: string[] = [];
  let mi = 0, manualAcc = 0, t = 0, worstNeg = 0;
  while (t < hours * 3600 && s.lifetime.pieces < stopAt) {
    if (!sim.isAutomated(s, 'asakusa_stand')) {
      // hand service at the stand (~2.2 guests/min) until the first crew is hired
      manualAcc += Math.min(2.2, sim.visibleSpawnPerMin(s, 'asakusa_stand')) / 60;
      while (manualAcc >= 1) {
        manualAcc--;
        const type = sim.pickCustomerType(s, 'asakusa');
        const o = sim.makeOrder(s, 'asakusa_stand', type);
        if (!o) continue;
        const tk = sim.acceptOrder(s, 'asakusa_stand', { ...o, type, customerId: 1 });
        if (tk !== 'nostock' && sim.finishManual(s, 'asakusa_stand', tk.id, 0.75)) sim.settle(s, 'asakusa_stand', tk.id, 30);
      }
    }
    if (t === 180) s.tutorial = 99; // tutorial (first order by hand) done after ~3 min
    sim.tick(s, 1, { activeDistrict: null });
    E.tickEmpire(s);
    t++;
    if (t % 5 === 0) bot(s, style);
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
  const run = play('hands-on', 9, 1_500_000);
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
  expect(marks.crew).toBeLessThan(8); // first crew within a few minutes
  expect(marks.r3).toBeLessThan(60); // 3 restaurants ≈ 45 min
  expect(marks.r10).toBeLessThan(200); // 10 restaurants ≈ 2.5 h
  expect(marks.m7).toBeGreaterThan(4 * 60); // 1M takes real effort...
  expect(marks.m7).toBeLessThan(7.5 * 60); // ...but lands around 5–6 h
  expect(Object.keys(s.restaurants).length).toBeGreaterThanOrEqual(25); // a real empire by 1M
}, 600_000);

it('house rules are good but a hands-on owner beats them', () => {
  // Controlled experiment: one mid-game snapshot, the same three fresh restaurants opened in both branches,
  // then 1 h with expansion frozen. Only staffing and pricing differ: the hand-run owner vs house rules.
  const branch = (base: GameState, style: Style) => {
    const lots = Object.values(PROPERTIES).filter((p) => !base.restaurants[p.id] && base.districts.includes(p.district)).sort((x, y) => x.price - y.price).slice(0, 3);
    sim.setRandom(seeded(99));
    const s = deserialize(serialize(base));
    s.cash = Math.max(s.cash, 0) + lots.reduce((a, p) => a + p.price * 2, 0);
    for (const p of lots) A.buyProperty(s, p.id, chooseConcept(s, p.id));
    const p0 = s.lifetime.pieces;
    for (let t = 1; t <= 3600; t++) { sim.tick(s, 1, { activeDistrict: null }); E.tickEmpire(s); if (t % 5 === 0) bot(s, style, false); }
    return s.lifetime.pieces - p0;
  };
  const snaps = [play('hands-on', 2).s, play('hands-on', 3).s];
  const hands = snaps.reduce((a, b) => a + branch(b, 'hands-on'), 0), rules = snaps.reduce((a, b) => a + branch(b, 'rules'), 0);
  const edge = hands / rules - 1;
  console.log(`1h from the same snapshots (2 h, 3 h): hands-on +${short(hands)} vs house rules +${short(rules)} pieces (hands-on edge ${(edge * 100).toFixed(0)}%)`);
  expect(rules).toBeGreaterThan(hands * 0.75); // automation is viable
  expect(edge).toBeGreaterThan(0.03); // but attention pays
}, 600_000);
