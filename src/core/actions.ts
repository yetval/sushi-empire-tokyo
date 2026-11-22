// Player business actions. Each returns null on success or a human-readable reason it failed.
import { emit, toast } from './bus';
import {
  CAMPAIGNS, CITIES, DISTRICTS, DistrictId, FACILITIES, FacilityId, HQ_MAX, MAX_SKILL, PROPERTIES, RESEARCH, RIVALS,
  ROLES, UPGRADES, franchiseCost, hqCost, trainCost, upgradeCost, wageFor,
} from './data';
import { yen } from './format';
import { GameState, newRestaurant } from './state';
import { seasonalRecipes } from './seasons';
import { buyoutCost, hireCost, mods, neededIngredients, slotsFor, spend, staffAt } from './sim';

type Result = string | null;
const changed = () => emit('restaurantsChanged', {});

export function upgradePrice(s: GameState, restId: string, upgId: string): number {
  const lvl = s.restaurants[restId].upgrades[upgId] ?? 0;
  if (upgId === 'expand') return Math.round(Math.max(30_000, PROPERTIES[restId].price * 0.6) * Math.pow(UPGRADES.expand.growth, lvl));
  return upgradeCost(UPGRADES[upgId], s.restaurants[restId].upgrades[upgId] ?? 0, Math.sqrt(PROPERTIES[restId].size));
}

/** Max level of an upgrade at this property (seating is limited by floor space). */
export function upgradeMax(restId: string, upgId: string): number {
  return upgId === 'seats' ? Math.min(UPGRADES.seats.max, Math.ceil(PROPERTIES[restId].seatsMax / 2)) : UPGRADES[upgId].max;
}

export function buyUpgrade(s: GameState, restId: string, upgId: string): Result {
  const r = s.restaurants[restId], u = UPGRADES[upgId];
  const lvl = r.upgrades[upgId] ?? 0;
  if (lvl >= upgradeMax(restId, upgId)) return 'Already maxed out';
  const cost = upgradePrice(s, restId, upgId);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  r.upgrades[upgId] = lvl + 1;
  emit('upgrade', { restaurant: restId, upgrade: upgId, level: lvl + 1 });
  toast(`${u.emoji} ${u.name} upgraded to level ${lvl + 1}!`, 'good');
  changed();
  return null;
}

export function hire(s: GameState, candidateId: number, restId: string | null): Result {
  const c = s.candidates.find((e) => e.id === candidateId);
  if (!c) return 'Candidate no longer available';
  if (s.lifetime.pieces < ROLES[c.role].unlockPieces) return `Unlocks at ${ROLES[c.role].unlockPieces} pieces sold`;
  if (restId && staffAt(s, restId, c.role).length >= slotsFor(s, restId, c.role)) return 'No free slot for that role there';
  const cost = hireCost(c);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  s.candidates = s.candidates.filter((e) => e !== c);
  c.restaurant = restId;
  s.staff.push(c);
  emit('hire', { role: c.role });
  toast(`${ROLES[c.role].emoji} Hired ${c.name}!`, 'good');
  changed();
  return null;
}

export function assign(s: GameState, empId: number, restId: string | null): Result {
  const e = s.staff.find((x) => x.id === empId);
  if (!e) return 'Unknown employee';
  if (restId && e.restaurant !== restId && staffAt(s, restId, e.role).length >= slotsFor(s, restId, e.role)) return 'No free slot for that role there';
  e.restaurant = restId;
  changed();
  return null;
}

export function fire(s: GameState, empId: number): Result {
  const e = s.staff.find((x) => x.id === empId);
  if (!e) return 'Unknown employee';
  s.staff = s.staff.filter((x) => x !== e);
  toast(`${e.name} has left the company.`);
  changed();
  return null;
}

export function train(s: GameState, empId: number): Result {
  const e = s.staff.find((x) => x.id === empId);
  if (!e) return 'Unknown employee';
  if (e.skill >= MAX_SKILL) return 'Already a master';
  const cost = Math.round(trainCost(e.role, e.skill) * mods(s).trainCost);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  e.skill++; e.xp = 0;
  emit('train', { role: e.role });
  e.wage = wageFor(e.role, e.skill);
  toast(`🎓 ${e.name} trained to skill ${e.skill}`, 'good');
  return null;
}

export function unlockDistrict(s: GameState, d: DistrictId): Result {
  const def = DISTRICTS[d];
  if (s.districts.includes(d)) return 'Already unlocked';
  if (s.lifetime.pieces < def.unlock.pieces) return `Sell ${def.unlock.pieces.toLocaleString()} pieces first`;
  if (!spend(s, def.unlock.cost)) return `Need ${yen(def.unlock.cost)} (business permit)`;
  s.districts.push(d);
  toast(`🗾 ${def.name} unlocked! Take the metro to visit.`, 'gold');
  emit('purchase', { what: d });
  return null;
}

export function buyProperty(s: GameState, propId: string): Result {
  const p = PROPERTIES[propId];
  if (s.restaurants[propId]) return 'Already owned';
  if (!s.districts.includes(p.district)) return `Unlock ${DISTRICTS[p.district].name} first`;
  if (!spend(s, p.price)) return `Need ${yen(p.price)}`;
  s.restaurants[propId] = newRestaurant(propId, s.day, s.brand);
  s.restaurants[propId].menu = s.recipes.slice(0, 6);
  toast(`🎉 Grand opening: ${p.name}!`, 'gold');
  emit('purchase', { what: propId });
  changed();
  return null;
}

export function setPrice(s: GameState, restId: string, mult: number): void {
  s.restaurants[restId].priceMult = Math.max(0.6, Math.min(2.5, Math.round(mult * 20) / 20));
}

export function toggleMenu(s: GameState, restId: string, recipe: string): Result {
  const r = s.restaurants[restId];
  const orderable = (m: string) => s.recipes.includes(m) || seasonalRecipes(s).includes(m);
  if (r.menu.includes(recipe)) {
    // keep at least one permanent (non-seasonal) recipe so a menu never goes empty when a season ends
    if (s.recipes.includes(recipe) && r.menu.filter((m) => s.recipes.includes(m)).length <= 1) return 'Menu needs at least one item';
    r.menu = r.menu.filter((m) => m !== recipe);
  } else {
    if (!orderable(recipe)) return 'Recipe not unlocked';
    r.menu.push(recipe);
  }
  return null;
}

export function launchCampaign(s: GameState, id: string): Result {
  const c = CAMPAIGNS[id];
  if (c.requires && !s.research.includes(c.requires) && !s.flags[c.requires]) return `Requires ${RESEARCH[c.requires]?.name ?? 'Chapter 2'}`;
  if (s.campaigns.some((x) => x.id === id && (c.scope !== 'district' || x.district === s.player.district))) return 'Already running';
  if (!spend(s, c.cost)) return `Need ${yen(c.cost)}`;
  const endsMinute = s.minute;
  s.campaigns.push({ id, district: c.scope === 'district' ? s.player.district : null, endsDay: s.day + c.days, endsMinute });
  s.brand = Math.min(100, s.brand + c.brand * 0.5);
  emit('campaign', { id });
  toast(`${c.emoji} ${c.name} launched!`, 'good');
  return null;
}

export function canResearch(s: GameState, id: string): Result {
  const r = RESEARCH[id];
  if (s.research.includes(id)) return 'Done';
  if (s.lifetime.pieces < r.minPieces) return `Sell ${r.minPieces.toLocaleString()} pieces`;
  const missing = r.requires.filter((x) => !s.research.includes(x));
  if (missing.length) return `Requires ${missing.map((m) => RESEARCH[m].name).join(', ')}`;
  if (s.rp < r.cost) return `Need ${r.cost.toLocaleString()} RP`;
  return null;
}

export function doResearch(s: GameState, id: string): Result {
  const err = canResearch(s, id);
  if (err) return err;
  const r = RESEARCH[id];
  s.rp -= r.cost;
  s.research.push(id);
  if (r.unlockRecipe && !s.recipes.includes(r.unlockRecipe)) s.recipes.push(r.unlockRecipe);
  if (id === 'auto_restock') for (const k of neededIngredients(s)) s.restock[k] = Math.max(s.restock[k], 60);
  toast(`🔬 Research complete: ${r.name}`, 'good');
  return null;
}

export function openCity(s: GameState, cityId: string): Result {
  const c = CITIES[cityId];
  if (!s.flags.chapter2) return 'Sell 1,000,000 pieces first';
  if (s.cities[cityId]?.open) return 'Already open';
  if (s.lifetime.pieces < c.minPieces) return `Sell ${c.minPieces.toLocaleString()} pieces`;
  if (!spend(s, c.openCost)) return `Need ${yen(c.openCost)}`;
  s.cities[cityId] = { open: true, franchises: 0 };
  toast(`${c.flag} Expanded to ${c.name}!`, 'gold');
  emit('purchase', { what: cityId });
  return null;
}

export function franchisePrice(s: GameState, cityId: string): number {
  return franchiseCost(CITIES[cityId], s.cities[cityId]?.franchises ?? 0, mods(s).franchiseCost);
}

export function buyFranchise(s: GameState, cityId: string): Result {
  const st = s.cities[cityId];
  if (!st?.open) return 'Open the city first';
  if (st.franchises >= CITIES[cityId].maxFranchises) return 'Market saturated';
  const cost = franchisePrice(s, cityId);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  st.franchises++;
  toast(`🏪 New franchise in ${CITIES[cityId].name} (#${st.franchises})`, 'good');
  return null;
}

export function buyHQ(s: GameState): Result {
  if (!s.flags.chapter2) return 'Sell 1,000,000 pieces first';
  if (s.hq >= HQ_MAX) return 'Headquarters complete';
  const cost = hqCost(s.hq);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  s.hq++;
  toast(`🏢 Headquarters expanded to floor ${s.hq * 5}!`, 'gold');
  changed();
  return null;
}

export function facilityPrice(s: GameState, id: FacilityId): number {
  const f = FACILITIES[id];
  return Math.round(f.base * Math.pow(f.growth, s.facilities[id]));
}

export function buyFacility(s: GameState, id: FacilityId): Result {
  if (!s.flags.chapter2) return 'Sell 1,000,000 pieces first';
  const f = FACILITIES[id];
  if (s.facilities[id] >= f.max) return 'Maxed';
  const cost = facilityPrice(s, id);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  s.facilities[id]++;
  toast(`${f.emoji} ${f.name} level ${s.facilities[id]}`, 'good');
  return null;
}

export function buyout(s: GameState, rid: string, d: DistrictId): Result {
  if (!s.flags.chapter2) return 'Sell 1,000,000 pieces first';
  if (s.rivals[rid][d] === undefined) return 'Already bought out';
  const cost = buyoutCost(s, rid, d);
  if (!spend(s, cost)) return `Need ${yen(cost)}`;
  delete s.rivals[rid][d];
  toast(`🤝 You bought out ${RIVALS[rid].name} in ${DISTRICTS[d].name}!`, 'gold');
  changed();
  return null;
}

/** Player wipes tables / sweeps at their restaurant. */
export function playerClean(s: GameState, restId: string): void {
  const r = s.restaurants[restId];
  r.cleanliness = Math.min(1, r.cleanliness + 0.35);
}
