// Business awards: one data table + one checker. Pure logic (no three/DOM).
// Unlocks persist as s.flags['ach_' + id]; rewards are applied once on unlock.
import { CITIES, DISTRICT_IDS, HQ_MAX, MAX_SKILL, PROPERTIES, PROPERTY_IDS, RECIPE_IDS, RESEARCH, UPGRADES } from './data';
import { yen } from './format';
import type { IconId } from '../ui/icons';
import type { GameState, RestaurantState } from './state';

export type AchTier = 'bronze' | 'silver' | 'gold';
export type AchCategory = 'quality' | 'speed' | 'expansion' | 'staff' | 'wealth' | 'collection' | 'secrets' | 'million';

export interface Achievement {
  id: string; title: string; icon: IconId; desc: string;
  tier: AchTier; category: AchCategory;
  check: (s: GameState) => boolean;
  reward: { cash?: number; rp?: number; cosmetic?: string };
}

// ---------------------------------------------------------------- helpers
// ponytail: optional counters not (yet) in GameState.lifetime; 0/undefined = never recorded.
const stat = (s: GameState, k: 'criticsWowed' | 'fastestServe'): number =>
  (s.lifetime as unknown as Record<string, number | undefined>)[k] ?? 0;
const rests = (s: GameState): RestaurantState[] => Object.values(s.restaurants);
const served = (s: GameState) => rests(s).reduce((a, r) => a + r.served, 0);
/** Satisfaction averaged over guests served (needs some traffic to mean anything). */
function avgSat(s: GameState): number {
  const n = served(s);
  return n < 200 ? 0 : rests(s).reduce((a, r) => a + r.satisfaction * r.served, 0) / n;
}
const bestDay = (s: GameState, k: 'pieces' | 'revenue') => Math.max(s.today[k], ...s.history.map((d) => d[k]));
const bestProfit = (s: GameState) => Math.max(0, ...s.history.map((d) => d.revenue - d.expenses));
const openCities = (s: GameState) => Object.values(s.cities).filter((c) => c.open).length;
const isMaxed = (r: RestaurantState, u: string) => (r.upgrades[u] ?? 0) >= UPGRADES[u].max;
const sold = (s: GameState, id: string) => s.piecesByRecipe[id] ?? 0;

// ---------------------------------------------------------------- table
const A = (
  id: string, title: string, icon: IconId, desc: string, tier: AchTier, category: AchCategory,
  check: Achievement['check'], reward: Achievement['reward'],
): Achievement => ({ id, title, icon, desc, tier, category, check, reward });

export const ACHIEVEMENTS: Achievement[] = [
  // Quality
  A('q_rep4', 'Four-Star Joint', 'star', 'Reach a 4-star reputation at any restaurant.', 'bronze', 'quality', (s) => rests(s).some((r) => r.reputation >= 4), { cash: 3_000, rp: 5 }),
  A('q_rep5', 'Five-Star Legend', 'sparkle', 'Reach a 4.9-star reputation at any restaurant.', 'silver', 'quality', (s) => rests(s).some((r) => r.reputation >= 4.9), { cash: 40_000, rp: 30, cosmetic: 'sign_gold_star' }),
  A('q_all_stars', 'Michelin Chain', 'medal', 'Every one of 3+ restaurants at 4.5 stars or better.', 'gold', 'quality', (s) => rests(s).length >= 3 && rests(s).every((r) => r.reputation >= 4.5), { cash: 500_000, rp: 150 }),
  A('q_sat80', 'Happy Regulars', 'happy', 'Average guest satisfaction 80%+ (200+ guests).', 'bronze', 'quality', (s) => avgSat(s) >= 0.8, { cash: 5_000, rp: 10 }),
  A('q_sat90', 'Pure Delight', 'heart', 'Average guest satisfaction 90%+ (200+ guests).', 'gold', 'quality', (s) => avgSat(s) >= 0.9, { cash: 150_000, rp: 80 }),
  A('q_critic', 'Critic’s Choice', 'note', 'Impress 3 food critics.', 'silver', 'quality', (s) => stat(s, 'criticsWowed') >= 3, { cash: 60_000, rp: 40, cosmetic: 'sign_laurel' }),

  // Speed
  A('sp_fast', 'Lightning Service', 'bolt', 'Serve a walk-in guest within 15 seconds.', 'silver', 'speed', (s) => stat(s, 'fastestServe') > 0 && stat(s, 'fastestServe') <= 15, { cash: 2_000, rp: 15 }),
  A('sp_day500', 'Busy Day', 'runner', 'Sell 500 pieces in one day.', 'bronze', 'speed', (s) => bestDay(s, 'pieces') >= 500, { cash: 5_000, rp: 10 }),
  A('sp_day10k', 'Rush Hour Hero', 'train', 'Sell 10,000 pieces in one day.', 'silver', 'speed', (s) => bestDay(s, 'pieces') >= 10_000, { cash: 200_000, rp: 60 }),
  A('sp_day250k', 'Sushi Factory', 'factory', 'Sell 250,000 pieces in one day.', 'gold', 'speed', (s) => bestDay(s, 'pieces') >= 250_000, { cash: 10_000_000, rp: 1_000 }),
  A('sp_speedrun', 'Overnight Success', 'rocket', 'Sell 1,000 pieces by day 3.', 'silver', 'speed', (s) => s.day <= 3 && s.lifetime.pieces >= 1_000, { cash: 10_000, rp: 20 }),

  // Expansion
  A('ex_second', 'Second Location', 'shop', 'Own 2 restaurants.', 'bronze', 'expansion', (s) => rests(s).length >= 2, { cash: 5_000, rp: 10 }),
  A('ex_five', 'Local Chain', 'shop', 'Own 5 restaurants.', 'silver', 'expansion', (s) => rests(s).length >= 5, { cash: 150_000, rp: 50 }),
  A('ex_all_props', 'Tokyo Landlord', 'tower', 'Own every property in Tokyo.', 'gold', 'expansion', (s) => PROPERTY_IDS.every((id) => id in s.restaurants), { cash: 5_000_000, rp: 500, cosmetic: 'sign_gold' }),
  A('ex_all_districts', 'All of Tokyo', 'map', 'Unlock every district.', 'silver', 'expansion', (s) => DISTRICT_IDS.every((d) => s.districts.includes(d)), { cash: 1_000_000, rp: 200 }),
  A('ex_maxed', 'Fully Loaded', 'tools', 'Max out every upgrade at one restaurant.', 'gold', 'expansion', (s) => rests(s).some((r) => Object.keys(UPGRADES).every((u) => isMaxed(r, u))), { cash: 2_000_000, rp: 300, cosmetic: 'theme_gold_leaf' }),
  A('ex_brand', 'Household Name', 'megaphone', 'Reach 75 brand.', 'silver', 'expansion', (s) => s.brand >= 75, { cash: 300_000, rp: 100 }),
  A('ex_city', 'Going National', 'train', 'Open franchises in 3 cities.', 'gold', 'expansion', (s) => openCities(s) >= 3, { cash: 20_000_000, rp: 2_000 }),
  A('ex_world', 'World Tour', 'globe', 'Open every city.', 'gold', 'expansion', (s) => Object.keys(CITIES).every((c) => s.cities[c]?.open), { cash: 2e9, rp: 50_000 }),
  A('ex_hq', 'Corporate HQ', 'office', 'Max out your headquarters.', 'gold', 'expansion', (s) => s.hq >= HQ_MAX, { cash: 1e9, rp: 25_000 }),

  // Staff
  A('st_hire', 'First Hire', 'handshake', 'Hire your first employee.', 'bronze', 'staff', (s) => s.staff.length >= 1, { cash: 1_000, rp: 5 }),
  A('st_manager', 'Delegator', 'clipboard', 'Assign a manager to a restaurant.', 'bronze', 'staff', (s) => s.staff.some((e) => e.role === 'manager' && e.restaurant), { cash: 10_000, rp: 15 }),
  A('st_team', 'Big Team', 'team', 'Employ 15 staff.', 'silver', 'staff', (s) => s.staff.length >= 15, { cash: 100_000, rp: 50 }),
  A('st_master', 'Sensei', 'robe', 'Train an employee to max skill.', 'silver', 'staff', (s) => s.staff.some((e) => e.skill >= MAX_SKILL), { cash: 80_000, rp: 60, cosmetic: 'uniform_black' }),
  A('st_elite', 'Dream Kitchen', 'chef', 'Have 5 chefs at skill 8+.', 'gold', 'staff', (s) => s.staff.filter((e) => e.role === 'chef' && e.skill >= 8).length >= 5, { cash: 1_000_000, rp: 300 }),

  // Wealth
  A('w_100k', 'Six Figures', 'yen', 'Hold ¥100,000 cash.', 'bronze', 'wealth', (s) => s.cash >= 100_000, { rp: 10 }),
  A('w_10m', 'Deep Pockets', 'yen', 'Hold ¥10M cash.', 'silver', 'wealth', (s) => s.cash >= 10_000_000, { rp: 150 }),
  A('w_1b', 'Billionaire Chef', 'crown', 'Hold ¥1B cash.', 'gold', 'wealth', (s) => s.cash >= 1e9, { rp: 20_000 }),
  A('w_tips', 'Tip Jar', 'heart', 'Earn ¥100,000 in tips.', 'silver', 'wealth', (s) => s.lifetime.tips >= 100_000, { cash: 25_000, rp: 20 }),
  A('w_order', 'Whale Watcher', 'whale', 'Receive a single order worth ¥20,000.', 'silver', 'wealth', (s) => s.lifetime.bestOrder >= 20_000, { cash: 20_000, rp: 25 }),
  A('w_profit', 'Banner Day', 'chart', 'Make ¥1M profit in one day.', 'silver', 'wealth', (s) => bestProfit(s) >= 1_000_000, { cash: 250_000, rp: 80 }),

  // Collection
  A('c_menu8', 'Growing Menu', 'scroll', 'Know 8 recipes.', 'bronze', 'collection', (s) => s.recipes.length >= 8, { cash: 10_000, rp: 20 }),
  A('c_menu_all', 'Complete Cookbook', 'book', 'Know every recipe.', 'gold', 'collection', (s) => RECIPE_IDS.every((r) => s.recipes.includes(r)), { cash: 3_000_000, rp: 500, cosmetic: 'sign_neon_rainbow' }),
  A('c_taste_all', 'Full Course', 'bento', 'Sell 1,000 of every recipe.', 'gold', 'collection', (s) => RECIPE_IDS.every((r) => sold(s, r) >= 1_000), { cash: 5_000_000, rp: 600 }),
  A('c_research10', 'Lab Rat', 'flask', 'Complete 10 research projects.', 'bronze', 'collection', (s) => s.research.length >= 10, { cash: 20_000, rp: 30 }),
  A('c_research_all', 'Mad Scientist', 'flask', 'Complete all research.', 'gold', 'collection', (s) => Object.keys(RESEARCH).every((r) => s.research.includes(r)), { cash: 1e9, rp: 50_000 }),

  // Million+
  A('m_1m', 'One Million Pieces', 'fireworks', 'Sell 1,000,000 pieces.', 'gold', 'million', (s) => s.lifetime.pieces >= 1_000_000, { rp: 1_000 }),
  A('m_10m', 'Ten Million Club', 'fireworks', 'Sell 10,000,000 pieces.', 'gold', 'million', (s) => s.lifetime.pieces >= 10_000_000, { cash: 100_000_000, rp: 10_000 }),
  A('m_100m', 'Hundred Million', 'trophy', 'Sell 100,000,000 pieces.', 'gold', 'million', (s) => s.lifetime.pieces >= 100_000_000, { cash: 2e9, rp: 80_000, cosmetic: 'sign_diamond' }),
  A('m_1b', 'Billion Served', 'gem', 'Sell 1,000,000,000 pieces.', 'gold', 'million', (s) => s.lifetime.pieces >= 1e9, { cash: 4e10, rp: 800_000 }),
  A('m_rev1b', 'Yen Billionaire', 'bank', 'Earn ¥1B lifetime revenue.', 'gold', 'million', (s) => s.lifetime.revenue >= 1e9, { cash: 50_000_000, rp: 5_000 }),

  // Secrets
  A('x_night', 'Night Owl', 'owl', 'Sell 100 pieces after midnight.', 'bronze', 'secrets', (s) => s.minute < 120 && s.today.pieces >= 100, { cash: 3_000, rp: 10 }),
  A('x_broke', 'Rock Bottom', 'down', 'Go into debt after selling 100 pieces.', 'bronze', 'secrets', (s) => s.cash < 0 && s.lifetime.pieces >= 100, { cash: 2_000 }),
  A('x_kappa', 'Kappa Devotee', 'roll', 'Sell 10,000 cucumber maki.', 'silver', 'secrets', (s) => sold(s, 'cucumber_maki') >= 10_000, { cash: 15_000, rp: 20 }),
  A('x_rename', 'Personal Touch', 'pencil', 'Rename one of your restaurants.', 'bronze', 'secrets', (s) => rests(s).some((r) => r.name.trim() !== '' && r.name !== PROPERTIES[r.id]?.name), { cash: 1_000, cosmetic: 'sign_neon_pink' }),
  A('x_luxury', 'Worth Every Yen', 'gem', 'Hold 4.5 stars while charging 2x prices.', 'silver', 'secrets', (s) => rests(s).some((r) => r.priceMult >= 2 && r.reputation >= 4.5 && r.served >= 100), { cash: 100_000, rp: 40 }),
];

// ---------------------------------------------------------------- checker
export const isUnlocked = (s: GameState, a: Achievement) => s.flags['ach_' + a.id] === true;

/** Unlock everything newly earned; applies rewards once. Returns the new unlocks (caller toasts them). */
export function checkAchievements(s: GameState): Achievement[] {
  const fresh: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (isUnlocked(s, a) || !a.check(s)) continue;
    s.flags['ach_' + a.id] = true;
    if (a.reward.cash) { s.cash += a.reward.cash; s.lifetime.revenue += a.reward.cash; }
    if (a.reward.rp) s.rp += a.reward.rp;
    fresh.push(a);
  }
  return fresh;
}

export const unlockedCosmetics = (s: GameState): string[] =>
  [...new Set(ACHIEVEMENTS.filter((a) => a.reward.cosmetic && isUnlocked(s, a)).map((a) => a.reward.cosmetic!))];

/** "¥5K + 10 RP + cosmetic" for toasts / award cards. */
export function rewardText(a: Achievement): string {
  const r = a.reward;
  return [r.cash && yen(r.cash), r.rp && `${r.rp.toLocaleString('en-US')} RP`, r.cosmetic && 'cosmetic unlock'].filter(Boolean).join(' + ');
}
