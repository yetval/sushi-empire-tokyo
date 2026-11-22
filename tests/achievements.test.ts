import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, checkAchievements, unlockedCosmetics } from '../src/core/achievements';
import { CITIES, DISTRICT_IDS, HQ_MAX, PROPERTY_IDS, RECIPE_IDS, RESEARCH, UPGRADES } from '../src/core/data';
import { DEFAULT_AVATAR, GameState, createNewState, newRestaurant } from '../src/core/state';

type Mut = (s: GameState) => void;
const lt = (s: GameState) => s.lifetime as unknown as Record<string, number>;
const first = (s: GameState) => s.restaurants.asakusa_stand;
const own = (s: GameState, n: number) => { for (const id of PROPERTY_IDS.slice(0, n)) s.restaurants[id] ??= newRestaurant(id, 1); };
const guests = (s: GameState, sat: number) => { first(s).served = 300; first(s).satisfaction = sat; };
const hire = (s: GameState, n: number, role: 'chef' | 'manager' = 'chef', skill = 1) => {
  for (let i = 0; i < n; i++) s.staff.push({ id: 900 + s.staff.length, name: 'X', role, skill, xp: 0, wage: 1, restaurant: 'asakusa_stand', look: { ...DEFAULT_AVATAR } });
};

/** One state mutation per achievement that makes its check true. */
const SETUP: Record<string, Mut> = {
  q_rep4: (s) => { first(s).reputation = 4; },
  q_rep5: (s) => { first(s).reputation = 5; },
  q_all_stars: (s) => { own(s, 3); for (const r of Object.values(s.restaurants)) r.reputation = 4.6; },
  q_sat80: (s) => guests(s, 0.82),
  q_sat90: (s) => guests(s, 0.95),
  q_critic: (s) => { lt(s).criticsWowed = 3; },
  sp_fast: (s) => { lt(s).fastestServe = 12; },
  sp_day500: (s) => { s.history.push({ day: 1, revenue: 0, expenses: 0, pieces: 600, customers: 0 }); },
  sp_day10k: (s) => { s.today.pieces = 10_000; },
  sp_day250k: (s) => { s.today.pieces = 250_000; },
  sp_speedrun: (s) => { s.day = 3; s.lifetime.pieces = 1_000; },
  ex_second: (s) => own(s, 2),
  ex_five: (s) => own(s, 5),
  ex_all_props: (s) => own(s, PROPERTY_IDS.length),
  ex_all_districts: (s) => { s.districts = [...DISTRICT_IDS]; },
  ex_maxed: (s) => { for (const [id, u] of Object.entries(UPGRADES)) first(s).upgrades[id] = u.max; },
  ex_brand: (s) => { s.brand = 80; },
  ex_city: (s) => { for (const c of ['tokyo', 'osaka', 'kyoto']) s.cities[c] = { open: true, franchises: 1 }; },
  ex_world: (s) => { for (const c of Object.keys(CITIES)) s.cities[c] = { open: true, franchises: 0 }; },
  ex_hq: (s) => { s.hq = HQ_MAX; },
  st_hire: (s) => hire(s, 1),
  st_manager: (s) => hire(s, 1, 'manager'),
  st_team: (s) => hire(s, 15),
  st_master: (s) => hire(s, 1, 'chef', 10),
  st_elite: (s) => hire(s, 5, 'chef', 8),
  w_100k: (s) => { s.cash = 100_000; },
  w_10m: (s) => { s.cash = 10_000_000; },
  w_1b: (s) => { s.cash = 1e9; },
  w_tips: (s) => { s.lifetime.tips = 100_000; },
  w_order: (s) => { s.lifetime.bestOrder = 25_000; },
  w_profit: (s) => { s.history.push({ day: 1, revenue: 1_500_000, expenses: 200_000, pieces: 0, customers: 0 }); },
  c_menu8: (s) => { s.recipes = RECIPE_IDS.slice(0, 8); },
  c_menu_all: (s) => { s.recipes = [...RECIPE_IDS]; },
  c_taste_all: (s) => { for (const r of RECIPE_IDS) s.piecesByRecipe[r] = 1_000; },
  c_research10: (s) => { s.research = Object.keys(RESEARCH).slice(0, 10); },
  c_research_all: (s) => { s.research = Object.keys(RESEARCH); },
  m_1m: (s) => { s.lifetime.pieces = 1e6; },
  m_10m: (s) => { s.lifetime.pieces = 1e7; },
  m_100m: (s) => { s.lifetime.pieces = 1e8; },
  m_1b: (s) => { s.lifetime.pieces = 1e9; },
  m_rev1b: (s) => { s.lifetime.revenue = 1e9; },
  x_night: (s) => { s.minute = 30; s.today.pieces = 120; },
  x_broke: (s) => { s.cash = -500; s.lifetime.pieces = 150; },
  x_kappa: (s) => { s.piecesByRecipe.cucumber_maki = 10_000; },
  x_rename: (s) => { first(s).name = 'Chez Me'; },
  x_luxury: (s) => { Object.assign(first(s), { priceMult: 2, reputation: 4.6, served: 150 }); },
};

describe('achievements', () => {
  it('fresh state unlocks nothing', () => {
    const s = createNewState();
    expect(checkAchievements(s)).toEqual([]);
    expect(unlockedCosmetics(s)).toEqual([]);
  });

  it('ids are unique and every achievement has a reachability setup', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(SETUP).sort()).toEqual([...ids].sort());
  });

  it.each(ACHIEVEMENTS.map((a) => [a.id, a] as const))('%s is reachable', (id, a) => {
    const s = createNewState();
    expect(a.check(s)).toBe(false);
    SETUP[id](s);
    expect(a.check(s)).toBe(true);
  });

  it('unlocks once, persists the flag, and pays the reward once', () => {
    const s = createNewState();
    s.restaurants.asakusa_stand.reputation = 4;
    const cash = s.cash, rev = s.lifetime.revenue, rp = s.rp;
    const got = checkAchievements(s);
    expect(got.map((a) => a.id)).toEqual(['q_rep4']);
    expect(s.flags.ach_q_rep4).toBe(true);
    expect(s.cash).toBe(cash + 3_000);
    expect(s.lifetime.revenue).toBe(rev + 3_000);
    expect(s.rp).toBe(rp + 5);
    expect(checkAchievements(s)).toEqual([]);
    expect(s.cash).toBe(cash + 3_000);
  });

  it('reports cosmetics of unlocked awards', () => {
    const s = createNewState();
    SETUP.x_rename(s);
    checkAchievements(s);
    expect(unlockedCosmetics(s)).toEqual(['sign_neon_pink']);
  });
});
