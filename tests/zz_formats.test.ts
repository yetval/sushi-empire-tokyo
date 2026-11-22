import { it } from 'vitest';
import * as A from '../src/core/actions';
import { CONCEPT_IDS, ConceptId, DAY_SECONDS, INGREDIENT_IDS, PROPERTIES, RECIPES } from '../src/core/data';
import { SEASONAL_RECIPES } from '../src/core/seasons';
import * as E from '../src/core/empire';
import * as sim from '../src/core/sim';
import { createNewState } from '../src/core/state';

function seeded(seed = 7) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

it('formats', () => {
  const lots = (process.env.LOTS ?? 'odaiba_2,asakusa_shop,roppongi_3').split(',');
  for (const lot of lots) for (const c of CONCEPT_IDS) {
    if (c === 'stand') continue;
    sim.setRandom(seeded(3));
    const s = createNewState(); sim.refreshCandidates(s);
    s.cash = 1e12; s.lifetime.pieces = 60_000; s.brand = 30;
    s.recipes = Object.keys(RECIPES).filter((r) => !(r in SEASONAL_RECIPES));
    s.districts.push(PROPERTIES[lot].district);
    const cash0 = s.cash;
    if (A.buyProperty(s, lot, c as ConceptId)) throw new Error('buy ' + lot + c);
    for (const role of ['chef', 'server'] as const) while (sim.staffAt(s, lot, role).length < sim.slotsFor(s, lot, role)) {
      const e = sim.makeCandidate(s, role); e.skill = 3; e.wage = Math.round(e.wage); s.candidates.push(e); A.hire(s, e.id, lot);
    }
    const invest = cash0 - s.cash;
    s.restaurants[lot].reputation = 3.5;
    s.minute = 0; s.day = 2;
    for (const r of Object.values(s.restaurants)) r.day.day = 2;
    for (let t = 0; t < DAY_SECONDS * 1.05; t += 0.5) {
      if (t % 10 === 0) for (const k of INGREDIENT_IDS) s.inventory[k] = 2000;
      sim.tick(s, 0.5, { activeDistrict: null });
      if (s.day > 2) break;
    }
    const h = s.restaurants[lot].hist[0];
    const profit = h.rev - h.cost;
    const hrs = DAY_SECONDS / 3600 * 0.85; // ~real hours of one day incl fast night
    console.log(`${lot.padEnd(14)} ${c.padEnd(8)} invest ${(invest / 1e3).toFixed(0).padStart(6)}K  pcs/day ${h.pieces.toFixed(0).padStart(6)}  rev ${(h.rev / 1e3).toFixed(0).padStart(6)}K  profit/day ${(profit / 1e3).toFixed(0).padStart(6)}K  payback ${(invest / Math.max(1, profit)).toFixed(1).padStart(5)}d  load ${E.restaurantKPIs(s).find((k) => k.id === lot)!.load.toFixed(2)}`);
  }
}, 120000);
