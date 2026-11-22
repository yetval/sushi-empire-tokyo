// Balance check: a greedy "bot player" plays the real economy sim and we measure pacing.
// Manual cooking at the stand is approximated at a human-ish pace until staff are hired.
import { expect, it } from 'vitest';
import * as A from '../src/core/actions';
import { CAMPAIGNS, CITY_IDS, DISTRICTS, DistrictId, PROPERTIES, RESEARCH, RECIPES, Role, UPGRADES } from '../src/core/data';
import { short } from '../src/core/format';
import * as sim from '../src/core/sim';
import { createNewState, GameState } from '../src/core/state';

function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function botSpend(s: GameState): void {
  const ids = Object.keys(s.restaurants);
  // keep ingredients stocked for menus
  for (const k of sim.neededIngredients(s)) if (s.inventory[k] < 40 + 20 * ids.length) sim.buyIngredient(s, k, 60 + 40 * ids.length);
  // staff
  for (const id of ids) {
    for (const role of ['chef', 'server', 'manager', 'cleaner'] as Role[]) {
      const have = sim.staffAt(s, id, role).length;
      const want = role === 'chef' ? (have === 0 || s.restaurants[id].orders.length > have * 2 ? Math.min(have + 1, sim.slotsFor(s, id, role)) : have) : role === 'server' ? 1 : role === 'manager' ? (s.lifetime.pieces > 20_000 ? 1 : 0) : (s.lifetime.pieces > 2_000 ? 1 : 0);
      if (have < want) {
        const c = s.candidates.find((e) => e.role === role) ?? (s.candidates.push(sim.makeCandidate(s, role)), s.candidates[s.candidates.length - 1]);
        if (s.cash > sim.hireCost(c) * 2) A.hire(s, c.id, id);
      }
    }
  }
  // research: cheapest available
  const avail = Object.keys(RESEARCH).filter((r) => !A.canResearch(s, r)).sort((a, b) => RESEARCH[a].cost - RESEARCH[b].cost);
  if (avail.length) A.doResearch(s, avail[0]);
  const top = [...s.recipes].sort((a, b) => RECIPES[b].price - RECIPES[a].price).slice(0, 6);
  for (const id of ids) { const r = s.restaurants[id]; for (const x of top) if (!r.menu.includes(x)) r.menu.push(x); r.menu = r.menu.filter((x) => top.includes(x)); }
  // districts and properties
  for (const d of Object.keys(DISTRICTS) as DistrictId[]) if (!s.districts.includes(d) && s.cash > DISTRICTS[d].unlock.cost * 1.5) A.unlockDistrict(s, d);
  const prop = Object.values(PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district)).sort((a, b) => a.price - b.price)[0];
  if (prop && s.cash > prop.price * 1.3) A.buyProperty(s, prop.id);
  // upgrades: cheapest affordable
  let best: [string, string, number] | null = null;
  for (const id of ids) for (const u of Object.keys(UPGRADES)) {
    if ((s.restaurants[id].upgrades[u] ?? 0) >= A.upgradeMax(id, u)) continue;
    const c = A.upgradePrice(s, id, u);
    if (!best || c < best[2]) best = [id, u, c];
  }
  if (best && s.cash > best[2] * 2) A.buyUpgrade(s, best[0], best[1]);
  // marketing
  for (const c of ['newspaper', 'social', 'influencer', 'billboard', 'tv']) if (s.cash > CAMPAIGNS[c].cost * 5) A.launchCampaign(s, c);
  // empire
  if (s.flags.chapter2) {
    for (const c of CITY_IDS) if (!s.cities[c]?.open && s.cash > 2 * 1) A.openCity(s, c);
    for (const c of CITY_IDS) if (s.cities[c]?.open && s.cash > A.franchisePrice(s, c) * 1.5) A.buyFranchise(s, c);
    if (s.cash > 3e8) { A.buyHQ(s); A.buyFacility(s, 'kitchen'); A.buyFacility(s, 'logistics'); }
  }
}

it('progression pacing is reasonable', () => {
  sim.setRandom(seeded());
  const s = createNewState();
  sim.refreshCandidates(s);
  const reached: string[] = [];
  let mi = 0;
  const dt = 0.5;
  let manualAcc = 0, t = 0, negSince = -1, worstNeg = 0;
  const HOURS = 30;
  while (t < HOURS * 3600 && s.lifetime.pieces < 3_000_000) {
    // manual play at the stand until it is automated (≈ 2.2 customers/min, capped by demand)
    if (!sim.isAutomated(s, 'asakusa_stand')) {
      manualAcc += Math.min(2.2, sim.visibleSpawnPerMin(s, 'asakusa_stand')) * dt / 60;
      while (manualAcc >= 1) {
        manualAcc--;
        const type = sim.pickCustomerType(s, 'asakusa');
        const o = sim.makeOrder(s, 'asakusa_stand', type);
        if (!o) continue;
        const tk = sim.acceptOrder(s, 'asakusa_stand', { ...o, type, customerId: 1 });
        if (tk !== 'nostock' && sim.finishManual(s, 'asakusa_stand', tk.id, 0.75)) sim.settle(s, 'asakusa_stand', tk.id, 30);
      }
    }
    sim.tick(s, dt, { activeDistrict: null });
    t += dt;
    if (Math.floor(t / dt) % 10 === 0) botSpend(s);
    if (s.cash < 0) { if (negSince < 0) negSince = t; worstNeg = Math.min(worstNeg, s.cash); } else negSince = -1;
    while (s.milestoneIndex > mi) { reached.push(`${(t / 60).toFixed(0).padStart(5)} min  ${short(s.lifetime.pieces).padStart(6)}  cash ${short(s.cash).padStart(6)}  rest ${Object.keys(s.restaurants).length}  staff ${s.staff.length}`); mi++; }
  }
  console.log(Object.values(s.restaurants).map((r) => `${r.id} rep=${r.reputation.toFixed(1)} clean=${r.cleanliness.toFixed(2)} dem=${sim.demandPerMin(s, r.id, 720).toFixed(0)} kit=${sim.kitchenRate(s, r.id).toFixed(1)} chefs=${sim.staffAt(s, r.id, "chef").length} q=${r.orders.length} ${JSON.stringify(r.upgrades)}`).join("\n"));
  const perRecipe = Object.entries(s.piecesByRecipe).map(([k, v]) => `${RECIPES[k].name}:${short(v)}`).join(', ');
  console.log(['Milestone timeline (play minutes):', ...reached, `ended at ${(t / 3600).toFixed(1)}h with ${short(s.lifetime.pieces)} pieces, cash ${short(s.cash)}, brand ${s.brand.toFixed(0)}, research ${s.research.length}`, perRecipe, `worst cash ${short(worstNeg)}`].join('\n'));
  const minutesTo = (i: number) => Number(reached[i]?.trim().split(' ')[0] ?? Infinity);
  expect(minutesTo(0)).toBeLessThan(25); // 100 pieces
  expect(minutesTo(1)).toBeLessThan(90); // 1,000 pieces
  expect(minutesTo(2)).toBeLessThan(200); // 10,000 pieces
  expect(minutesTo(7)).toBeGreaterThan(240); // 1M takes real effort...
  expect(minutesTo(7)).toBeLessThan(12 * 60); // ...but is reachable in a normal long campaign
}, 600_000); // ~10s alone; generous for loaded CI machines
