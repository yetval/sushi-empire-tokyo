// Season & holiday calendar driven by s.day. Pure data + small functions — no three.js, no DOM.
// A year is 28 days: spring (days 1-7), summer (8-14), autumn (15-21), winter (22-28).
// New Year sits at the end of winter: Omisoka (day 27) and Shogatsu (day 28); the year rolls over after it,
// so day 1 of every year (including the player's very first day) is a calm spring day.
import { CustomerType, RecipeDef } from './data';

export const YEAR_DAYS = 28;
export const SEASON_DAYS = 7;

export type SeasonId = 'spring' | 'summer' | 'autumn' | 'winter';
export type Decor = 'sakura' | 'matsuri' | 'momiji' | 'snow';

interface SeasonDef { id: SeasonId; name: string; jp: string; emoji: string; decor: Decor; demand: number; mix: Partial<Record<CustomerType, number>> }
export interface HolidayDef { id: string; name: string; jp: string; emoji: string; day: number; demand: number; desc: string; mix: Partial<Record<CustomerType, number>> }

export const SEASONS: SeasonDef[] = [
  { id: 'spring', name: 'Spring', jp: '春', emoji: '🌸', decor: 'sakura', demand: 1.1, mix: { tourist: 1.5 } },
  { id: 'summer', name: 'Summer', jp: '夏', emoji: '🎐', decor: 'matsuri', demand: 1.05, mix: { student: 1.5, tourist: 0.5 } },
  { id: 'autumn', name: 'Autumn', jp: '秋', emoji: '🍁', decor: 'momiji', demand: 1, mix: { foodie: 1 } },
  { id: 'winter', name: 'Winter', jp: '冬', emoji: '❄️', decor: 'snow', demand: 0.9, mix: { family: 1, office: 0.5 } },
];

/** One-day holidays keyed by day of year (1..28). Original flavour text. */
export const HOLIDAYS: HolidayDef[] = [
  { id: 'hanami', name: 'Hanami Peak', jp: '花見', emoji: '🌸', day: 4, demand: 1.3, desc: 'Full bloom! Picnic blankets everywhere and everyone wants bento-sized rolls.', mix: { tourist: 1, family: 1 } },
  { id: 'tanabata', name: 'Tanabata', jp: '七夕', emoji: '🎋', day: 10, demand: 1.15, desc: 'Wishes on bamboo strips — one of them says "free otoro".', mix: { student: 1, influencer: 0.5 } },
  { id: 'obon', name: 'Obon Dance Night', jp: 'お盆', emoji: '🏮', day: 13, demand: 1.2, desc: 'Lanterns glow, drums thump, whole families stop by after the bon-odori.', mix: { family: 2 } },
  { id: 'tsukimi', name: 'Tsukimi & Yokai Night', jp: '月見', emoji: '🎑', day: 18, demand: 1.15, desc: 'Harvest moon viewing — some guests swear they came dressed as kitsune on purpose.', mix: { foodie: 1, influencer: 0.5 } },
  { id: 'christmas_eve', name: 'Christmas Eve', jp: 'イブ', emoji: '🎄', day: 24, demand: 1.35, desc: 'Date night rush. Fancy plates and candlelight orders all evening.', mix: { wealthy: 1, influencer: 0.5 } },
  { id: 'omisoka', name: 'Omisoka', jp: '大晦日', emoji: '🔔', day: 27, demand: 1.25, desc: "New Year's Eve: 108 temple bells and a last feast of the year.", mix: { family: 2, office: 1 } },
  { id: 'shogatsu', name: 'Shogatsu', jp: '正月', emoji: '🎍', day: 28, demand: 1.4, desc: 'Happy New Year! Families out in kimono, everyone ordering celebratory platters.', mix: { family: 3, tourist: 1 } },
];

type Day = { day: number } | number;
const dayNum = (s: Day) => (typeof s === 'number' ? s : s.day);
/** 1..28; safe for day <= 0 too. */
export const dayOfYear = (s: Day) => ((((dayNum(s) - 1) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS) + 1;
export const year = (s: Day) => Math.floor((dayNum(s) - 1) / YEAR_DAYS) + 1;

const seasonDef = (s: Day) => SEASONS[Math.floor((dayOfYear(s) - 1) / SEASON_DAYS)];

export function season(s: Day) {
  const { id, name, jp, emoji } = seasonDef(s);
  return { id, name, jp, emoji, dayOfSeason: ((dayOfYear(s) - 1) % SEASON_DAYS) + 1 };
}

export function holiday(s: Day): HolidayDef | null {
  const d = dayOfYear(s);
  return HOLIDAYS.find((h) => h.day === d) ?? null;
}

export const seasonDecor = (s: Day): Decor => seasonDef(s).decor;

/** Combined season × holiday demand multiplier, clamped to 0.85..1.5. */
export function seasonDemand(s: Day): number {
  const m = seasonDef(s).demand * (holiday(s)?.demand ?? 1);
  return Math.min(1.5, Math.max(0.85, m));
}

/** Additive customer-mix weights (same scale as DISTRICTS[d].mix: ~1-6). */
export function seasonMix(s: Day): Partial<Record<CustomerType, number>> {
  const out = { ...seasonDef(s).mix };
  for (const [k, w] of Object.entries(holiday(s)?.mix ?? {})) out[k as CustomerType] = (out[k as CustomerType] ?? 0) + (w ?? 0);
  return out;
}

// ---------------------------------------------------------------- limited-time recipes
export const SEASONAL_RECIPES: Record<string, RecipeDef> = {
  sakura_ebi_nigiri: { id: 'sakura_ebi_nigiri', name: 'Sakura Shrimp Nigiri', jp: '桜えび', price: 170, ingredients: { rice: 1, shrimp: 1 }, prep: 4, kind: 'nigiri', topColor: '#f7a1b5' },
  matsuri_temaki: { id: 'matsuri_temaki', name: 'Festival Crab Roll', jp: '祭り巻き', price: 190, ingredients: { rice: 1, nori: 1, crab: 1, cucumber: 1, mayo: 1 }, prep: 4.5, kind: 'roll', topColor: '#ff6f59' },
  momiji_gunkan: { id: 'momiji_gunkan', name: 'Autumn Oyako Gunkan', jp: '紅葉軍艦', price: 320, ingredients: { rice: 1, nori: 1, salmon: 1, roe: 1 }, prep: 5, kind: 'gunkan', topColor: '#e8590c' },
  yuki_roll: { id: 'yuki_roll', name: 'Snowfall Crab Roll', jp: '雪巻き', price: 220, ingredients: { rice: 1, nori: 1, crab: 1, avocado: 1, mayo: 1 }, prep: 5, kind: 'roll', topColor: '#eef2f7' },
  osechi_platter: { id: 'osechi_platter', name: 'New Year Osechi Platter', jp: 'お節', price: 1100, ingredients: { rice: 1, toro: 1, roe: 1, eel: 1, shrimp: 1 }, prep: 9, kind: 'platter', premium: true, topColor: '#c92a2a' },
};

/** When each limited recipe is on offer: a season id (whole season) or a holiday id (that day only). */
const AVAILABLE: Record<string, string[]> = {
  sakura_ebi_nigiri: ['spring'], matsuri_temaki: ['summer'], momiji_gunkan: ['autumn'],
  yuki_roll: ['winter'], osechi_platter: ['omisoka', 'shogatsu'],
};

export function seasonalRecipes(s: Day): string[] {
  const tags = [seasonDef(s).id as string, holiday(s)?.id];
  return Object.keys(SEASONAL_RECIPES).filter((id) => AVAILABLE[id].some((t) => tags.includes(t)));
}
