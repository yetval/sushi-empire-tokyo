// All static game definitions. Pure data — no three.js, no DOM.
import { SEASONAL_RECIPES } from './seasons';

export const DAY_SECONDS = 600; // real seconds per in-game day
export const START_MINUTE = 9 * 60;
export const OPEN_MIN = 7 * 60; // restaurants open 07:00
export const CLOSE_MIN = 2 * 60; // close 02:00 (next day)
export const MILLION = 1_000_000;

// ---------------------------------------------------------------- ingredients
export type IngredientId =
  | 'rice' | 'nori' | 'cucumber' | 'salmon' | 'tuna' | 'shrimp'
  | 'avocado' | 'crab' | 'eel' | 'mayo' | 'roe' | 'toro';

export interface IngredientDef { id: IngredientId; name: string; emoji: string; cost: number; color: string }

export const INGREDIENTS: Record<IngredientId, IngredientDef> = {
  rice: { id: 'rice', name: 'Sushi Rice', emoji: '🍚', cost: 8, color: '#fbf7ee' },
  nori: { id: 'nori', name: 'Nori', emoji: '🟩', cost: 6, color: '#1f3a2a' },
  cucumber: { id: 'cucumber', name: 'Cucumber', emoji: '🥒', cost: 5, color: '#5fae4b' },
  salmon: { id: 'salmon', name: 'Salmon', emoji: '🐟', cost: 35, color: '#ff8a5c' },
  tuna: { id: 'tuna', name: 'Tuna', emoji: '🐟', cost: 45, color: '#d9364a' },
  shrimp: { id: 'shrimp', name: 'Shrimp', emoji: '🦐', cost: 30, color: '#ffb199' },
  avocado: { id: 'avocado', name: 'Avocado', emoji: '🥑', cost: 20, color: '#a7c957' },
  crab: { id: 'crab', name: 'Crab', emoji: '🦀', cost: 25, color: '#ff6f59' },
  eel: { id: 'eel', name: 'Unagi Eel', emoji: '🐍', cost: 70, color: '#7a4a24' },
  mayo: { id: 'mayo', name: 'Spicy Mayo', emoji: '🌶️', cost: 6, color: '#ff9f43' },
  roe: { id: 'roe', name: 'Salmon Roe', emoji: '🟠', cost: 55, color: '#ff6b1a' },
  toro: { id: 'toro', name: 'Fatty Tuna', emoji: '💎', cost: 160, color: '#f48fb1' },
};
export const INGREDIENT_IDS = Object.keys(INGREDIENTS) as IngredientId[];

// ---------------------------------------------------------------- recipes
export type MinigameKind = 'nigiri' | 'maki' | 'roll' | 'gunkan' | 'platter';

export interface RecipeDef {
  id: string; name: string; jp: string; price: number; // yen per piece
  ingredients: Partial<Record<IngredientId, number>>; // per piece
  prep: number; // base chef seconds per piece
  kind: MinigameKind; premium?: boolean;
  topColor: string; // main topping/filling color for 3D model
}

export const RECIPES: Record<string, RecipeDef> = {
  cucumber_maki: { id: 'cucumber_maki', name: 'Cucumber Maki', jp: 'かっぱ巻き', price: 60, ingredients: { rice: 1, nori: 1, cucumber: 1 }, prep: 3, kind: 'maki', topColor: '#5fae4b' },
  salmon_nigiri: { id: 'salmon_nigiri', name: 'Salmon Nigiri', jp: 'サーモン', price: 120, ingredients: { rice: 1, salmon: 1 }, prep: 3.5, kind: 'nigiri', topColor: '#ff8a5c' },
  tuna_nigiri: { id: 'tuna_nigiri', name: 'Tuna Nigiri', jp: 'まぐろ', price: 150, ingredients: { rice: 1, tuna: 1 }, prep: 3.5, kind: 'nigiri', topColor: '#d9364a' },
  tuna_maki: { id: 'tuna_maki', name: 'Tuna Maki', jp: '鉄火巻き', price: 130, ingredients: { rice: 1, nori: 1, tuna: 1 }, prep: 3.5, kind: 'maki', topColor: '#d9364a' },
  shrimp_nigiri: { id: 'shrimp_nigiri', name: 'Shrimp Nigiri', jp: 'えび', price: 140, ingredients: { rice: 1, shrimp: 1 }, prep: 4, kind: 'nigiri', topColor: '#ffb199' },
  california_roll: { id: 'california_roll', name: 'California Roll', jp: 'カリフォルニア', price: 160, ingredients: { rice: 1, nori: 1, crab: 1, avocado: 1 }, prep: 4.5, kind: 'roll', topColor: '#ff6f59' },
  spicy_tuna_roll: { id: 'spicy_tuna_roll', name: 'Spicy Tuna Roll', jp: 'スパイシー', price: 190, ingredients: { rice: 1, nori: 1, tuna: 1, mayo: 1 }, prep: 4.5, kind: 'roll', topColor: '#ff9f43' },
  roe_gunkan: { id: 'roe_gunkan', name: 'Ikura Gunkan', jp: 'いくら', price: 260, ingredients: { rice: 1, nori: 1, roe: 1 }, prep: 4.5, kind: 'gunkan', topColor: '#ff6b1a' },
  eel_nigiri: { id: 'eel_nigiri', name: 'Eel Nigiri', jp: 'うなぎ', price: 240, ingredients: { rice: 1, eel: 1 }, prep: 4.5, kind: 'nigiri', topColor: '#7a4a24' },
  dragon_roll: { id: 'dragon_roll', name: 'Dragon Roll', jp: 'ドラゴン', price: 340, ingredients: { rice: 1, nori: 1, eel: 1, avocado: 1, shrimp: 1 }, prep: 6, kind: 'roll', topColor: '#7a4a24' },
  rainbow_roll: { id: 'rainbow_roll', name: 'Rainbow Roll', jp: 'レインボー', price: 380, ingredients: { rice: 1, nori: 1, salmon: 1, tuna: 1, avocado: 1 }, prep: 6, kind: 'roll', topColor: '#f9c74f' },
  toro_nigiri: { id: 'toro_nigiri', name: 'Fatty Tuna Nigiri', jp: '大トロ', price: 520, ingredients: { rice: 1, toro: 1 }, prep: 5, kind: 'nigiri', premium: true, topColor: '#f48fb1' },
  chefs_special: { id: 'chefs_special', name: "Chef's Special Platter", jp: 'おまかせ', price: 980, ingredients: { rice: 1, salmon: 1, tuna: 1, toro: 1, roe: 1 }, prep: 9, kind: 'platter', premium: true, topColor: '#ffd166' },
};
Object.assign(RECIPES, SEASONAL_RECIPES); // limited-time recipes, only orderable while in season
export const START_RECIPES = ['cucumber_maki', 'salmon_nigiri'];

export function recipeCost(r: RecipeDef, costMult = 1): number {
  let c = 0;
  for (const [k, n] of Object.entries(r.ingredients)) c += INGREDIENTS[k as IngredientId].cost * (n ?? 0);
  return c * costMult;
}

// ---------------------------------------------------------------- customers
export type CustomerType = 'student' | 'office' | 'tourist' | 'family' | 'foodie' | 'wealthy' | 'influencer' | 'critic' | 'vip';

export interface CustomerDef {
  id: CustomerType; name: string; emoji: string;
  priceTolerance: number; // how much above base price they accept (1 = base)
  patience: number; // seconds willing to wait in total
  orderMin: number; orderMax: number;
  qualityExpect: number; // 0..1
  tipRate: number; // fraction of bill at perfect satisfaction
  prefers: string[]; // recipe ids they like (boost chance)
  hours: [number, number][]; // preferred hour ranges
  repWeight: number; // reputation impact multiplier
}

export const CUSTOMERS: Record<CustomerType, CustomerDef> = {
  student: { id: 'student', name: 'Student', emoji: '🎒', priceTolerance: 0.9, patience: 70, orderMin: 1, orderMax: 3, qualityExpect: 0.3, tipRate: 0.02, prefers: ['cucumber_maki', 'california_roll', 'spicy_tuna_roll'], hours: [[14, 18], [20, 24]], repWeight: 1 },
  office: { id: 'office', name: 'Office Worker', emoji: '💼', priceTolerance: 1.1, patience: 55, orderMin: 2, orderMax: 4, qualityExpect: 0.45, tipRate: 0.05, prefers: ['salmon_nigiri', 'tuna_nigiri', 'tuna_maki'], hours: [[11, 14], [18, 21]], repWeight: 1 },
  tourist: { id: 'tourist', name: 'Tourist', emoji: '📸', priceTolerance: 1.3, patience: 90, orderMin: 2, orderMax: 5, qualityExpect: 0.4, tipRate: 0.1, prefers: ['california_roll', 'salmon_nigiri', 'dragon_roll', 'rainbow_roll'], hours: [[9, 20]], repWeight: 1.2 },
  family: { id: 'family', name: 'Family', emoji: '👨‍👩‍👧', priceTolerance: 1.0, patience: 80, orderMin: 4, orderMax: 8, qualityExpect: 0.4, tipRate: 0.05, prefers: ['cucumber_maki', 'salmon_nigiri', 'shrimp_nigiri', 'california_roll'], hours: [[11, 14], [17, 21]], repWeight: 1 },
  foodie: { id: 'foodie', name: 'Food Enthusiast', emoji: '🍽️', priceTolerance: 1.5, patience: 100, orderMin: 2, orderMax: 5, qualityExpect: 0.7, tipRate: 0.12, prefers: ['eel_nigiri', 'roe_gunkan', 'toro_nigiri', 'dragon_roll'], hours: [[12, 23]], repWeight: 1.6 },
  wealthy: { id: 'wealthy', name: 'Wealthy Diner', emoji: '💎', priceTolerance: 2.2, patience: 90, orderMin: 3, orderMax: 6, qualityExpect: 0.75, tipRate: 0.15, prefers: ['toro_nigiri', 'chefs_special', 'roe_gunkan', 'eel_nigiri'], hours: [[18, 24]], repWeight: 1.5 },
  influencer: { id: 'influencer', name: 'Influencer', emoji: '🤳', priceTolerance: 1.4, patience: 60, orderMin: 2, orderMax: 4, qualityExpect: 0.6, tipRate: 0.08, prefers: ['rainbow_roll', 'dragon_roll', 'spicy_tuna_roll'], hours: [[12, 22]], repWeight: 3 },
  critic: { id: 'critic', name: 'Food Critic', emoji: '📝', priceTolerance: 1.8, patience: 90, orderMin: 3, orderMax: 5, qualityExpect: 0.85, tipRate: 0.05, prefers: [], hours: [[12, 21]], repWeight: 6 },
  vip: { id: 'vip', name: 'VIP Guest', emoji: '👑', priceTolerance: 3, patience: 140, orderMin: 4, orderMax: 8, qualityExpect: 0.8, tipRate: 0.3, prefers: ['chefs_special', 'toro_nigiri', 'dragon_roll', 'rainbow_roll'], hours: [[11, 23]], repWeight: 4 },
};

// ---------------------------------------------------------------- districts & properties
export type DistrictId = 'asakusa' | 'shibuya' | 'shinjuku' | 'ginza';

export interface DistrictDef {
  id: DistrictId; name: string; jp: string; blurb: string;
  traffic: number; // base customers per minute per restaurant (before size mult)
  elasticity: number; // price sensitivity (higher = more sensitive)
  unlock: { pieces: number; cost: number };
  mix: Partial<Record<CustomerType, number>>; // customer mix weights
  palette: { ground: string; accent: string; sky: string };
}

export const DISTRICTS: Record<DistrictId, DistrictDef> = {
  asakusa: { id: 'asakusa', name: 'Asakusa', jp: '浅草', blurb: 'Cozy old-town streets near the great temple gate. Where it all begins.', traffic: 7, elasticity: 1.4, unlock: { pieces: 0, cost: 0 }, mix: { student: 2, office: 2, tourist: 3, family: 2, foodie: 1 }, palette: { ground: '#d9c7a7', accent: '#c0392b', sky: '#8fd3ff' } },
  shibuya: { id: 'shibuya', name: 'Shibuya', jp: '渋谷', blurb: 'Neon, giant screens and the world\'s busiest crossing. Young crowds, huge volume.', traffic: 9, elasticity: 1.6, unlock: { pieces: 1_000, cost: 25_000 }, mix: { student: 4, influencer: 1, tourist: 3, office: 2, foodie: 1 }, palette: { ground: '#9aa0ad', accent: '#ff3e9a', sky: '#9ad0ff' } },
  shinjuku: { id: 'shinjuku', name: 'Shinjuku', jp: '新宿', blurb: 'Skyscrapers and salarymen. Massive lunch and dinner rushes, pricey rent.', traffic: 8, elasticity: 1.2, unlock: { pieces: 10_000, cost: 250_000 }, mix: { office: 6, tourist: 2, foodie: 1, student: 1, wealthy: 1 }, palette: { ground: '#8f97a3', accent: '#3fa7ff', sky: '#a5c8ef' } },
  ginza: { id: 'ginza', name: 'Ginza', jp: '銀座', blurb: 'Luxury boutiques and gold-leaf elegance. Fewer guests who pay far more.', traffic: 4.5, elasticity: 0.6, unlock: { pieces: 50_000, cost: 2_000_000 }, mix: { wealthy: 5, foodie: 3, tourist: 2, critic: 0.4, office: 1 }, palette: { ground: '#e4ddd0', accent: '#c9a227', sky: '#b9d9f5' } },
};
export const DISTRICT_IDS = Object.keys(DISTRICTS) as DistrictId[];

// ---------------------------------------------------------------- areas (walkable districts + management-only areas)
// Walkable districts are 3D scenes. Remote areas (other Tokyo wards, Japan, the world) are run purely from the
// management UI: their restaurants are simulated by the same economy code, just never rendered.
export type Region = 'tokyo' | 'japan' | 'world';
export interface AreaDef {
  id: string; name: string; jp: string; blurb: string; region: Region; walkable: boolean;
  traffic: number; elasticity: number; unlock: { pieces: number; cost: number; chapter2?: boolean };
  mix: Partial<Record<CustomerType, number>>; lotBase: number; // price of the smallest lot
  map: { x: number; y: number }; // position on the empire map (0..100 within its region)
}
const R = (id: string, name: string, jp: string, region: Region, traffic: number, elasticity: number, pieces: number, cost: number, lotBase: number, mix: AreaDef['mix'], blurb: string, x: number, y: number, chapter2 = false): AreaDef =>
  ({ id, name, jp, region, walkable: false, traffic, elasticity, unlock: { pieces, cost, chapter2 }, mix, lotBase, blurb, map: { x, y } });

export const REMOTE_AREAS: Record<string, AreaDef> = Object.fromEntries([
  R('ueno', 'Ueno', '上野', 'tokyo', 6, 1.4, 2_000, 60_000, 140_000, { tourist: 3, family: 3, office: 1 }, 'Museums, the zoo and Ameyoko market crowds.', 62, 22),
  R('ikebukuro', 'Ikebukuro', '池袋', 'tokyo', 7, 1.5, 3_000, 90_000, 225_000, { student: 4, office: 2, influencer: 1 }, 'Department stores, anime shops and students.', 30, 16),
  R('akihabara', 'Akihabara', '秋葉原', 'tokyo', 6.5, 1.6, 5_000, 150_000, 360_000, { student: 4, tourist: 3 }, 'Electric Town: quick, cheap and late-night.', 60, 32),
  R('harajuku', 'Harajuku', '原宿', 'tokyo', 7, 1.7, 8_000, 250_000, 1_200_000, { student: 4, influencer: 3, tourist: 2 }, 'Takeshita Street trends. Photogenic sushi sells.', 34, 52),
  R('shimokita', 'Shimokitazawa', '下北沢', 'tokyo', 4.5, 1.3, 15_000, 300_000, 1_400_000, { student: 3, foodie: 3 }, 'Thrift shops, live houses and picky foodies.', 18, 62),
  R('odaiba', 'Odaiba', 'お台場', 'tokyo', 6, 1.3, 20_000, 600_000, 2_800_000, { family: 4, tourist: 4 }, 'Waterfront malls and weekend families.', 72, 78),
  R('roppongi', 'Roppongi', '六本木', 'tokyo', 5, 0.9, 30_000, 1_200_000, 5_000_000, { wealthy: 3, foodie: 2, tourist: 2 }, 'Nightlife, embassies and expense accounts.', 44, 66),
  R('tsukiji', 'Tsukiji Outer Market', '築地', 'tokyo', 5.5, 1.0, 40_000, 1_000_000, 4_800_000, { foodie: 5, tourist: 3 }, 'The fish-lover pilgrimage. Quality is everything.', 64, 60),
  R('osaka_namba', 'Osaka · Namba', '難波', 'japan', 8, 1.3, 150_000, 6_000_000, 12_000_000, { tourist: 3, family: 3, student: 2 }, 'Kuidaore! Big appetites, loud neon.', 48, 62),
  R('kyoto_gion', 'Kyoto · Gion', '祇園', 'japan', 5, 0.8, 250_000, 12_000_000, 18_000_000, { tourist: 4, wealthy: 2, foodie: 2 }, 'Lantern-lit lanes and refined palates.', 54, 56),
  R('sapporo', 'Sapporo', '札幌', 'japan', 6, 1.2, 400_000, 18_000_000, 24_000_000, { family: 3, foodie: 3, tourist: 2 }, 'Hokkaido seafood country.', 70, 12),
  R('fukuoka', 'Fukuoka', '福岡', 'japan', 6.5, 1.3, 600_000, 22_000_000, 27_000_000, { office: 3, student: 2, foodie: 2 }, 'Yatai stalls and Kyushu hospitality.', 22, 80),
  R('nyc_midtown', 'New York · Midtown', 'ニューヨーク', 'world', 9, 1.1, 1_000_000, 150_000_000, 180_000_000, { office: 4, tourist: 3, wealthy: 2 }, 'Lunch-hour lines around the block.', 22, 34, true),
  R('london_soho', 'London · Soho', 'ロンドン', 'world', 7, 1.0, 2_000_000, 250_000_000, 270_000_000, { office: 3, foodie: 3, tourist: 2 }, 'Theatre crowds and food critics.', 46, 26, true),
  R('paris_marais', 'Paris · Le Marais', 'パリ', 'world', 6, 0.8, 4_000_000, 400_000_000, 420_000_000, { foodie: 4, wealthy: 2, tourist: 3 }, 'Gastronomes who know their toro.', 48, 32, true),
  R('seoul_gangnam', 'Seoul · Gangnam', 'ソウル', 'world', 8, 1.3, 1_500_000, 180_000_000, 210_000_000, { student: 3, influencer: 3, office: 2 }, 'Trend-setters and late-night K-food fans.', 80, 30, true),
  R('singapore_marina', 'Singapore · Marina Bay', 'シンガポール', 'world', 7, 1.0, 6_000_000, 600_000_000, 600_000_000, { wealthy: 3, tourist: 3, office: 2 }, 'Skyline dining for the jet set.', 74, 58, true),
  R('dubai_marina', 'Dubai · Marina', 'ドバイ', 'world', 5, 0.6, 10_000_000, 1_000_000_000, 1_050_000_000, { wealthy: 6, tourist: 2 }, 'Gold-leaf nigiri, no budget.', 60, 44, true),
].map((a) => [a.id, a]));

/** Every area id (walkable districts first). */
export type AreaId = DistrictId | string;
export const AREAS: Record<string, AreaDef> = {
  ...Object.fromEntries(DISTRICT_IDS.map((d, i) => [d, { ...DISTRICTS[d], region: 'tokyo' as Region, walkable: true, lotBase: [45_000, 300_000, 1_200_000, 4_000_000][i], map: [{ x: 64, y: 30 }, { x: 36, y: 46 }, { x: 32, y: 34 }, { x: 56, y: 48 }][i] }])),
  ...REMOTE_AREAS,
};
export const AREA_IDS = Object.keys(AREAS);
export const areaDef = (id: string): AreaDef => AREAS[id];
export const isWalkable = (id: string): id is DistrictId => (DISTRICT_IDS as string[]).includes(id);

// ---------------------------------------------------------------- restaurant concepts (formats)
export type ConceptId = 'stand' | 'kiosk' | 'bar' | 'kaiten' | 'omakase' | 'ghost';
export interface ConceptDef {
  id: ConceptId; name: string; jp: string; emoji: string; desc: string;
  traffic: number; elasticity: number; price: number; // bill multiplier (the concept's price level)
  cook: number; quality: number; staff: number; // chef-slot multiplier
  rent: number; fitout: number; // fit-out cost as a fraction of the lot price
  walkIn: boolean; needsServer: boolean; unlockPieces: number;
  mix?: Partial<Record<CustomerType, number>>;
}
export const CONCEPTS: Record<ConceptId, ConceptDef> = {
  stand: { id: 'stand', name: 'Yatai Stand', jp: '屋台', emoji: '🏮', desc: 'A street stand. Cheap, charming and personal.', traffic: 1, elasticity: 1, price: 1, cook: 1, quality: 0, staff: 1, rent: 1, fitout: 0, walkIn: true, needsServer: true, unlockPieces: 0 },
  kiosk: { id: 'kiosk', name: 'Takeout Kiosk', jp: '持ち帰り', emoji: '🥡', desc: 'Grab-and-go packs. Fast, cheap, high volume, price-sensitive.', traffic: 1.35, elasticity: 1.35, price: 0.85, cook: 1.15, quality: -0.05, staff: 1, rent: 0.7, fitout: 0.15, walkIn: true, needsServer: true, unlockPieces: 0, mix: { student: 2, office: 2 } },
  bar: { id: 'bar', name: 'Sushi Bar', jp: '寿司屋', emoji: '🍣', desc: 'The classic counter. Balanced in every way.', traffic: 1, elasticity: 1, price: 1, cook: 1, quality: 0, staff: 1, rent: 1, fitout: 0.2, walkIn: true, needsServer: true, unlockPieces: 0 },
  kaiten: { id: 'kaiten', name: 'Kaiten Conveyor', jp: '回転寿司', emoji: '🔄', desc: 'Plates circle on a belt. Huge volume, low prices, needs big kitchens.', traffic: 1.55, elasticity: 1.5, price: 0.8, cook: 1.2, quality: -0.08, staff: 1.3, rent: 1.15, fitout: 0.35, walkIn: true, needsServer: true, unlockPieces: 5_000, mix: { family: 3, student: 2 } },
  omakase: { id: 'omakase', name: 'Omakase Room', jp: 'おまかせ', emoji: '🎎', desc: 'Chef’s choice for a handful of guests. Tiny volume, enormous bills, needs master chefs.', traffic: 0.25, elasticity: 0.45, price: 1.4, cook: 0.7, quality: 0.12, staff: 0.75, rent: 1.25, fitout: 0.5, walkIn: true, needsServer: true, unlockPieces: 50_000, mix: { wealthy: 4, foodie: 3, critic: 0.3 } },
  ghost: { id: 'ghost', name: 'Ghost Kitchen', jp: 'デリバリー', emoji: '🛵', desc: 'Delivery-only kitchen. No dining room, no servers, cheap rent.', traffic: 1.1, elasticity: 1.2, price: 0.95, cook: 1.0, quality: -0.03, staff: 1.25, rent: 0.45, fitout: 0.25, walkIn: false, needsServer: false, unlockPieces: 10_000, mix: { office: 2, student: 2 } },
};
export const CONCEPT_IDS = Object.keys(CONCEPTS) as ConceptId[];


export type RestaurantKind = 'stand' | 'shop' | 'restaurant' | 'flagship';

export interface PropertyDef {
  id: string; district: AreaId; name: string; kind: RestaurantKind;
  price: number; rent: number; // per day
  size: number; // traffic multiplier
  seatsMax: number; chefSlots: number; serverSlots: number;
}

export const PROPERTIES: Record<string, PropertyDef> = {
  asakusa_stand: { id: 'asakusa_stand', district: 'asakusa', name: "Grandpa Kenji's Stand", kind: 'stand', price: 0, rent: 0, size: 1.5, seatsMax: 4, chefSlots: 1, serverSlots: 1 },
  asakusa_shop: { id: 'asakusa_shop', district: 'asakusa', name: 'Kaminari Corner Shop', kind: 'shop', price: 15_000, rent: 600, size: 2.2, seatsMax: 8, chefSlots: 2, serverSlots: 1 },
  asakusa_house: { id: 'asakusa_house', district: 'asakusa', name: 'Sumida Riverside House', kind: 'restaurant', price: 180_000, rent: 3_500, size: 3.2, seatsMax: 12, chefSlots: 3, serverSlots: 2 },
  shibuya_crossing: { id: 'shibuya_crossing', district: 'shibuya', name: 'Crossing Sushi Bar', kind: 'shop', price: 450_000, rent: 9_000, size: 3, seatsMax: 10, chefSlots: 3, serverSlots: 2 },
  shibuya_center: { id: 'shibuya_center', district: 'shibuya', name: 'Center-gai Mega Sushi', kind: 'restaurant', price: 4_000_000, rent: 60_000, size: 5, seatsMax: 16, chefSlots: 5, serverSlots: 3 },
  shinjuku_lunch: { id: 'shinjuku_lunch', district: 'shinjuku', name: 'Nishi-Shinjuku Lunch Counter', kind: 'shop', price: 4_500_000, rent: 65_000, size: 4, seatsMax: 12, chefSlots: 4, serverSlots: 2 },
  shinjuku_tower: { id: 'shinjuku_tower', district: 'shinjuku', name: 'Skytower Sushi Hall', kind: 'flagship', price: 18_000_000, rent: 220_000, size: 7, seatsMax: 20, chefSlots: 7, serverSlots: 4 },
  ginza_omakase: { id: 'ginza_omakase', district: 'ginza', name: 'Ginza Omakase Room', kind: 'restaurant', price: 9_000_000, rent: 120_000, size: 4, seatsMax: 10, chefSlots: 4, serverSlots: 2 },
  ginza_flagship: { id: 'ginza_flagship', district: 'ginza', name: 'Golden Koi Flagship', kind: 'flagship', price: 45_000_000, rent: 480_000, size: 9, seatsMax: 20, chefSlots: 8, serverSlots: 4 },
};
// more walkable lots (placed in the 3D districts)
Object.assign(PROPERTIES, {
  asakusa_alley: { id: 'asakusa_alley', district: 'asakusa', name: 'Lantern Alley Counter', kind: 'shop', price: 15_000, rent: 600, size: 2.4, seatsMax: 8, chefSlots: 2, serverSlots: 1 },
  asakusa_market: { id: 'asakusa_market', district: 'asakusa', name: 'Nakamise Market Hall', kind: 'restaurant', price: 520_000, rent: 9_000, size: 3.6, seatsMax: 14, chefSlots: 4, serverSlots: 2 },
  shibuya_alley: { id: 'shibuya_alley', district: 'shibuya', name: 'Nonbei Yokocho Nook', kind: 'shop', price: 300_000, rent: 6_500, size: 2.6, seatsMax: 8, chefSlots: 2, serverSlots: 1 },
  shibuya_scramble: { id: 'shibuya_scramble', district: 'shibuya', name: 'Scramble Square Sushi', kind: 'restaurant', price: 1_800_000, rent: 30_000, size: 4.2, seatsMax: 16, chefSlots: 5, serverSlots: 3 },
  shinjuku_omoide: { id: 'shinjuku_omoide', district: 'shinjuku', name: 'Omoide Lane Stall', kind: 'shop', price: 2_000_000, rent: 32_000, size: 3.2, seatsMax: 8, chefSlots: 3, serverSlots: 1 },
  shinjuku_station: { id: 'shinjuku_station', district: 'shinjuku', name: 'West Exit Sushi Station', kind: 'restaurant', price: 9_000_000, rent: 125_000, size: 5.5, seatsMax: 16, chefSlots: 6, serverSlots: 3 },
  ginza_corner: { id: 'ginza_corner', district: 'ginza', name: 'Chuo-dori Corner', kind: 'shop', price: 4_500_000, rent: 70_000, size: 3.2, seatsMax: 10, chefSlots: 3, serverSlots: 2 },
  ginza_tower: { id: 'ginza_tower', district: 'ginza', name: 'Ginza Six Sky Sushi', kind: 'restaurant', price: 22_000_000, rent: 280_000, size: 6, seatsMax: 16, chefSlots: 6, serverSlots: 3 },
} satisfies Record<string, PropertyDef>);
// management-only lots: three per remote area (small / mid / large)
for (const a of Object.values(REMOTE_AREAS)) {
  const tiers = [['shop', 'Sushi Counter', 1, 2.5, 3, 1], ['restaurant', 'Sushi House', 4, 4, 5, 2], ['flagship', 'Grand Sushi Hall', 12, 6.5, 8, 3]] as const;
  tiers.forEach(([kind, label, pm, size, chefs, servers], i) => {
    const id = `${a.id}_${i + 1}`;
    const price = Math.round(a.lotBase * pm);
    PROPERTIES[id] = { id, district: a.id, name: `${a.name.split(' · ').pop()} ${label}`, kind, price, rent: Math.round(price * 0.008), size, seatsMax: 6 + 4 * (i + 1), chefSlots: chefs, serverSlots: servers };
  });
}
export const PROPERTY_IDS = Object.keys(PROPERTIES);

// ---------------------------------------------------------------- upgrades (per restaurant)
export type UpgradeCategory = 'kitchen' | 'dining' | 'decor' | 'operations';

export interface UpgradeDef {
  id: string; name: string; category: UpgradeCategory; emoji: string;
  max: number; base: number; growth: number; desc: string;
}

export const UPGRADES: Record<string, UpgradeDef> = {
  station: { id: 'station', name: 'Prep Station', category: 'kitchen', emoji: '🔪', max: 4, base: 5_000, growth: 3.5, desc: '+20% cooking speed per level (you and chefs).' },
  fridge: { id: 'fridge', name: 'Refrigerated Case', category: 'kitchen', emoji: '🧊', max: 3, base: 4_000, growth: 3, desc: 'Fresher fish: +6% food quality per level.' },
  extra_station: { id: 'extra_station', name: 'Extra Chef Station', category: 'kitchen', emoji: '👨‍🍳', max: 3, base: 40_000, growth: 3.8, desc: '+1 chef slot per level (up to property limit +3).' },
  expand: { id: 'expand', name: 'Renovate & Expand', category: 'dining', emoji: '🏗️', max: 3, base: 0, growth: 3.5, desc: '+25% guest capacity & foot traffic, +2 chef slots per level. A bigger, grander restaurant.' },
  seats: { id: 'seats', name: 'Seating', category: 'dining', emoji: '🪑', max: 5, base: 3_000, growth: 2.2, desc: 'More seats: more guests at once and +patience.' },
  lanterns: { id: 'lanterns', name: 'Paper Lanterns', category: 'decor', emoji: '🏮', max: 3, base: 1_500, growth: 2.5, desc: '+Atmosphere. Glows warmly at night.' },
  plants: { id: 'plants', name: 'Bonsai & Plants', category: 'decor', emoji: '🪴', max: 3, base: 2_000, growth: 2.5, desc: '+Atmosphere and +cleanliness feel.' },
  sign: { id: 'sign', name: 'Neon Sign', category: 'decor', emoji: '💡', max: 3, base: 8_000, growth: 3.5, desc: '+15% foot traffic per level. Pedestrians notice you.' },
  register: { id: 'register', name: 'Fast Register', category: 'operations', emoji: '🧾', max: 3, base: 3_000, growth: 2.8, desc: 'Orders taken faster, guests wait less (+15% patience).' },
  delivery: { id: 'delivery', name: 'Delivery Fleet', category: 'operations', emoji: '🛵', max: 4, base: 80_000, growth: 3.6, desc: '+15% orders per level from delivery apps. Scooters park out front.' },
  cleaning: { id: 'cleaning', name: 'Cleaning Kit', category: 'operations', emoji: '🧽', max: 3, base: 2_000, growth: 2.5, desc: 'Restaurant gets dirty 25% slower per level.' },
};

export function upgradeCost(u: UpgradeDef, level: number, sizeMult = 1): number {
  return Math.round(u.base * Math.pow(u.growth, level) * sizeMult);
}

// ---------------------------------------------------------------- staff
export type Role = 'chef' | 'server' | 'cleaner' | 'manager';

export interface RoleDef { id: Role; name: string; emoji: string; baseWage: number; hireCost: number; desc: string; unlockPieces: number }

export const ROLES: Record<Role, RoleDef> = {
  chef: { id: 'chef', name: 'Sushi Chef', emoji: '👨‍🍳', baseWage: 900, hireCost: 3_000, desc: 'Cooks accepted orders automatically. Skill = speed & quality.', unlockPieces: 0 },
  server: { id: 'server', name: 'Server / Cashier', emoji: '🧑‍💼', baseWage: 700, hireCost: 2_000, desc: 'Takes orders and serves food. Chef + Server = full automation.', unlockPieces: 0 },
  cleaner: { id: 'cleaner', name: 'Cleaner', emoji: '🧹', baseWage: 500, hireCost: 2_000, desc: 'Keeps the restaurant spotless. Dirty restaurants lose guests.', unlockPieces: 0 },
  manager: { id: 'manager', name: 'Manager', emoji: '📋', baseWage: 3_000, hireCost: 25_000, desc: 'Runs the place while you are away: offline earnings, auto-restock, and auto-hire / smart-pricing policies.', unlockPieces: 500 },
};

export function wageFor(role: Role, skill: number): number {
  return Math.round(ROLES[role].baseWage * (1 + (skill - 1) * 0.35));
}
export function trainCost(role: Role, skill: number): number {
  return Math.round(ROLES[role].hireCost * 0.8 * Math.pow(1.7, skill - 1));
}
export const MAX_SKILL = 10;

// ---------------------------------------------------------------- marketing
export interface CampaignDef { id: string; name: string; emoji: string; cost: number; days: number; boost: number; scope: 'district' | 'city' | 'global'; brand: number; requires?: string; desc: string }

export const CAMPAIGNS: Record<string, CampaignDef> = {
  flyers: { id: 'flyers', name: 'Hand Out Flyers', emoji: '📄', cost: 800, days: 1, boost: 0.25, scope: 'district', brand: 0.5, desc: '+25% guests in your current district for 1 day.' },
  newspaper: { id: 'newspaper', name: 'Local Newspaper Ad', emoji: '📰', cost: 20_000, days: 2, boost: 0.3, scope: 'city', brand: 1, desc: '+30% guests in all of Tokyo for 2 days.' },
  social: { id: 'social', name: 'Social Media Campaign', emoji: '📱', cost: 120_000, days: 3, boost: 0.5, scope: 'city', brand: 2, requires: 'social_media', desc: '+50% guests citywide for 3 days. Attracts students.' },
  influencer: { id: 'influencer', name: 'Influencer Partnership', emoji: '🤳', cost: 600_000, days: 3, boost: 0.8, scope: 'city', brand: 4, requires: 'influencer_network', desc: '+80% guests citywide for 3 days. Influencers visit.' },
  billboard: { id: 'billboard', name: 'Shibuya Billboard', emoji: '📺', cost: 3_000_000, days: 5, boost: 0.7, scope: 'city', brand: 6, requires: 'brand_story', desc: '+70% guests citywide for 5 days and big brand boost.' },
  tv: { id: 'tv', name: 'National TV Spot', emoji: '🎬', cost: 20_000_000, days: 5, boost: 1.2, scope: 'global', brand: 10, requires: 'chapter2', desc: '+120% guests and franchise output for 5 days.' },
  global: { id: 'global', name: 'International Brand Campaign', emoji: '🌏', cost: 80_000_000, days: 7, boost: 1.5, scope: 'global', brand: 15, requires: 'global_logistics', desc: '+150% everywhere for 7 days, including franchises.' },
};

// ---------------------------------------------------------------- research
export interface ResearchDef {
  id: string; name: string; emoji: string; branch: 'cooking' | 'supply' | 'staff' | 'marketing' | 'recipes' | 'empire';
  cost: number; // research points
  requires: string[]; minPieces: number; desc: string;
  unlockRecipe?: string;
}

export const RESEARCH: Record<string, ResearchDef> = {
  knife_skills: { id: 'knife_skills', name: 'Knife Skills', emoji: '🔪', branch: 'cooking', cost: 10, requires: [], minPieces: 0, desc: '+15% cooking speed everywhere.' },
  rice_science: { id: 'rice_science', name: 'Rice Science', emoji: '🍚', branch: 'cooking', cost: 40, requires: ['knife_skills'], minPieces: 0, desc: '+8% food quality everywhere.' },
  conveyor: { id: 'conveyor', name: 'Conveyor Belt Kitchens', emoji: '🔄', branch: 'cooking', cost: 600, requires: ['rice_science'], minPieces: 20_000, desc: '+30% cooking speed everywhere.' },
  robot_assist: { id: 'robot_assist', name: 'Robot Rice Formers', emoji: '🤖', branch: 'cooking', cost: 20_000, requires: ['conveyor'], minPieces: 1_000_000, desc: '+50% cooking speed everywhere.' },

  bulk_buying: { id: 'bulk_buying', name: 'Bulk Buying', emoji: '📦', branch: 'supply', cost: 15, requires: [], minPieces: 0, desc: '-10% ingredient costs.' },
  phone_orders: { id: 'phone_orders', name: 'Supplier Hotline', emoji: '☎️', branch: 'supply', cost: 30, requires: ['bulk_buying'], minPieces: 0, desc: 'Order ingredients from the management menu anywhere.' },
  auto_restock: { id: 'auto_restock', name: 'Scheduled Deliveries', emoji: '🚚', branch: 'supply', cost: 80, requires: ['phone_orders'], minPieces: 0, desc: 'Ingredients automatically restocked to your targets.' },
  cold_chain: { id: 'cold_chain', name: 'Cold Chain Warehouse', emoji: '🏭', branch: 'supply', cost: 1_000, requires: ['auto_restock'], minPieces: 10_000, desc: '+1000 storage and -10% ingredient costs.' },
  supply_contracts: { id: 'supply_contracts', name: 'Long-term Supplier Contracts', emoji: '🤝', branch: 'supply', cost: 8_000, requires: ['cold_chain'], minPieces: 250_000, desc: '-15% ingredient costs. Shortages hurt half as much.' },

  training_program: { id: 'training_program', name: 'Training Program', emoji: '🎓', branch: 'staff', cost: 20, requires: [], minPieces: 0, desc: 'Staff training costs 30% less.' },
  uniforms: { id: 'uniforms', name: 'Smart Uniforms', emoji: '👘', branch: 'staff', cost: 60, requires: ['training_program'], minPieces: 0, desc: '+5% guest satisfaction.' },
  career_ladder: { id: 'career_ladder', name: 'Career Ladder', emoji: '📈', branch: 'staff', cost: 1_500, requires: ['uniforms'], minPieces: 20_000, desc: 'Staff gain experience 2x faster.' },
  ops_center: { id: 'ops_center', name: 'Operations Center', emoji: '🗂️', branch: 'staff', cost: 120, requires: ['training_program'], minPieces: 2_000, desc: 'House rules (auto-hire, smart pricing) at every restaurant, no manager needed.' },
  manager_academy: { id: 'manager_academy', name: 'Manager Academy', emoji: '🏫', branch: 'staff', cost: 4_000, requires: ['career_ladder'], minPieces: 100_000, desc: 'Offline earnings efficiency 50% → 75%, cap 12h.' },

  social_media: { id: 'social_media', name: 'Social Media', emoji: '📱', branch: 'marketing', cost: 25, requires: [], minPieces: 0, desc: 'Unlocks Social Media campaigns.' },
  loyalty_cards: { id: 'loyalty_cards', name: 'Loyalty Stamp Cards', emoji: '🎫', branch: 'marketing', cost: 90, requires: ['social_media'], minPieces: 0, desc: '+10% guests everywhere (regulars come back).' },
  influencer_network: { id: 'influencer_network', name: 'Influencer Network', emoji: '🌟', branch: 'marketing', cost: 1_200, requires: ['loyalty_cards'], minPieces: 10_000, desc: 'Unlocks Influencer campaigns.' },
  brand_story: { id: 'brand_story', name: 'Brand Story', emoji: '📖', branch: 'marketing', cost: 3_000, requires: ['influencer_network'], minPieces: 50_000, desc: 'Unlocks Billboards. Brand grows faster.' },

  r_shrimp: { id: 'r_shrimp', name: 'Ebi Technique', emoji: '🦐', branch: 'recipes', cost: 15, requires: [], minPieces: 0, desc: 'Unlocks Shrimp Nigiri.', unlockRecipe: 'shrimp_nigiri' },
  r_california: { id: 'r_california', name: 'California Roll', emoji: '🥑', branch: 'recipes', cost: 35, requires: ['r_shrimp'], minPieces: 0, desc: 'Unlocks California Roll.', unlockRecipe: 'california_roll' },
  r_spicy: { id: 'r_spicy', name: 'Spicy Mayo Mastery', emoji: '🌶️', branch: 'recipes', cost: 60, requires: ['r_california'], minPieces: 0, desc: 'Unlocks Spicy Tuna Roll.', unlockRecipe: 'spicy_tuna_roll' },
  r_ikura: { id: 'r_ikura', name: 'Gunkan Wrapping', emoji: '🟠', branch: 'recipes', cost: 120, requires: ['r_spicy'], minPieces: 5_000, desc: 'Unlocks Ikura Gunkan.', unlockRecipe: 'roe_gunkan' },
  r_eel: { id: 'r_eel', name: 'Unagi Glaze', emoji: '🔥', branch: 'recipes', cost: 150, requires: ['r_shrimp'], minPieces: 5_000, desc: 'Unlocks Eel Nigiri.', unlockRecipe: 'eel_nigiri' },
  r_dragon: { id: 'r_dragon', name: 'Dragon Roll', emoji: '🐉', branch: 'recipes', cost: 2_000, requires: ['r_eel', 'r_california'], minPieces: 25_000, desc: 'Unlocks Dragon Roll.', unlockRecipe: 'dragon_roll' },
  r_rainbow: { id: 'r_rainbow', name: 'Rainbow Roll', emoji: '🌈', branch: 'recipes', cost: 2_500, requires: ['r_dragon'], minPieces: 50_000, desc: 'Unlocks Rainbow Roll.', unlockRecipe: 'rainbow_roll' },
  r_toro: { id: 'r_toro', name: 'Toro Sourcing', emoji: '💎', branch: 'recipes', cost: 4_500, requires: ['r_rainbow'], minPieces: 100_000, desc: 'Unlocks Fatty Tuna Nigiri.', unlockRecipe: 'toro_nigiri' },
  r_omakase: { id: 'r_omakase', name: 'Omakase Philosophy', emoji: '🎎', branch: 'recipes', cost: 10_000, requires: ['r_toro'], minPieces: 500_000, desc: "Unlocks Chef's Special Platter.", unlockRecipe: 'chefs_special' },

  franchise_manual: { id: 'franchise_manual', name: 'Franchise Playbook', emoji: '📘', branch: 'empire', cost: 15_000, requires: [], minPieces: 1_000_000, desc: 'Franchises cost 15% less.' },
  regional_offices: { id: 'regional_offices', name: 'Regional Offices', emoji: '🏢', branch: 'empire', cost: 40_000, requires: ['franchise_manual'], minPieces: 2_000_000, desc: '+25% franchise output.' },
  global_logistics: { id: 'global_logistics', name: 'Global Logistics', emoji: '✈️', branch: 'empire', cost: 125_000, requires: ['regional_offices'], minPieces: 5_000_000, desc: '+25% franchise output. Unlocks international campaigns.' },
  sushi_ai: { id: 'sushi_ai', name: 'Demand Forecasting AI', emoji: '🧠', branch: 'empire', cost: 400_000, requires: ['global_logistics'], minPieces: 25_000_000, desc: '+30% guests everywhere, franchises included.' },
};

// ---------------------------------------------------------------- milestones
export interface Milestone { pieces: number; title: string; reward: { cash?: number; rp?: number; recipe?: string; text: string } }

const FIXED_MILESTONES: Milestone[] = [
  { pieces: 100, title: 'First Steps', reward: { cash: 6_000, recipe: 'tuna_nigiri', text: '¥6,000 + Tuna Nigiri recipe' } },
  { pieces: 1_000, title: 'Rising Sushi Chef', reward: { cash: 20_000, recipe: 'tuna_maki', rp: 20, text: '¥20,000 + Tuna Maki + 20 RP. Shibuya can be unlocked!' } },
  { pieces: 10_000, title: 'Neighborhood Favorite', reward: { cash: 120_000, rp: 80, text: '¥120,000 + 80 RP. Shinjuku can be unlocked!' } },
  { pieces: 50_000, title: 'Tokyo Sensation', reward: { cash: 600_000, rp: 200, text: '¥600,000 + 200 RP. Ginza can be unlocked!' } },
  { pieces: 100_000, title: 'Sushi Mogul', reward: { cash: 800_000, rp: 400, text: '¥800,000 + 400 RP' } },
  { pieces: 250_000, title: 'Restaurant Tycoon', reward: { cash: 2_000_000, rp: 800, text: '¥2M + 800 RP' } },
  { pieces: 500_000, title: 'Sushi Legend', reward: { cash: 5_000_000, rp: 1_500, text: '¥5M + 1,500 RP' } },
  { pieces: 1_000_000, title: 'Sushi Emperor', reward: { cash: 25_000_000, rp: 3_000, text: '¥25M + 3,000 RP + Golden Maneki-neko. Chapter 2: The Empire begins!' } },
  { pieces: 2_000_000, title: 'Tokyo Dominator', reward: { cash: 50_000_000, rp: 5_000, text: '¥50M + 5,000 RP' } },
  { pieces: 5_000_000, title: "Japan's Favorite", reward: { cash: 120_000_000, rp: 10_000, text: '¥120M + 10,000 RP' } },
  { pieces: 10_000_000, title: 'National Sushi King', reward: { cash: 300_000_000, rp: 20_000, text: '¥300M + 20,000 RP' } },
  { pieces: 25_000_000, title: 'Franchise Master', reward: { cash: 800_000_000, rp: 40_000, text: '¥800M + 40,000 RP' } },
  { pieces: 50_000_000, title: 'International Expansion', reward: { cash: 2e9, rp: 80_000, text: '¥2B + 80,000 RP' } },
  { pieces: 100_000_000, title: 'Global Sushi Icon', reward: { cash: 5e9, rp: 150_000, text: '¥5B + 150,000 RP' } },
  { pieces: 250_000_000, title: 'Worldwide Franchise', reward: { cash: 1.2e10, rp: 300_000, text: '¥12B + 300,000 RP' } },
  { pieces: 500_000_000, title: 'Sushi Billionaire', reward: { cash: 3e10, rp: 600_000, text: '¥30B + 600,000 RP' } },
  { pieces: 1_000_000_000, title: 'Legendary Sushi Empire', reward: { cash: 8e10, rp: 1_000_000, text: '¥80B + 1M RP' } },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function roman(n: number): string {
  if (n <= 10) return ROMAN[n];
  return String(n);
}
const BEYOND = ['Celestial Sushi Dynasty', 'Galactic Rice Council', 'Infinite Omakase', 'Cosmic Conveyor', 'Eternal Sushi Empire'];

/** Milestone i (0-based). Procedural after the fixed list — never ends. */
export function milestone(i: number): Milestone {
  if (i < FIXED_MILESTONES.length) return FIXED_MILESTONES[i];
  const k = i - FIXED_MILESTONES.length; // 0,1,2...
  const steps = [2.5, 5, 10]; // 2.5B, 5B, 10B, 25B, 50B, 100B ...
  const decade = Math.floor(k / 3);
  const pieces = 1e9 * steps[k % 3] * Math.pow(10, decade);
  const title = `${BEYOND[decade % BEYOND.length]} ${roman((k % 3) + 1 + 3 * Math.floor(decade / BEYOND.length))}`;
  const cash = Math.round(pieces * 90);
  const rp = Math.round(pieces / 1000);
  return { pieces, title, reward: { cash, rp, text: `¥${(cash / 1e9).toFixed(0)}B + ${(rp / 1e6).toFixed(1)}M RP` } };
}
export const FIXED_MILESTONE_COUNT = FIXED_MILESTONES.length;

// ---------------------------------------------------------------- endgame: cities, HQ, facilities
export interface CityDef { id: string; name: string; flag: string; openCost: number; franchiseBase: number; maxFranchises: number; mult: number; minPieces: number }

export const CITIES: Record<string, CityDef> = {
  tokyo: { id: 'tokyo', name: 'Tokyo Suburbs', flag: '🗼', openCost: 0, franchiseBase: 4_000_000, maxFranchises: 40, mult: 1, minPieces: 1_000_000 },
  osaka: { id: 'osaka', name: 'Osaka', flag: '🏯', openCost: 60_000_000, franchiseBase: 6_000_000, maxFranchises: 30, mult: 1.1, minPieces: 1_500_000 },
  kyoto: { id: 'kyoto', name: 'Kyoto', flag: '⛩️', openCost: 90_000_000, franchiseBase: 7_000_000, maxFranchises: 20, mult: 1.3, minPieces: 2_000_000 },
  seoul: { id: 'seoul', name: 'Seoul', flag: '🇰🇷', openCost: 250_000_000, franchiseBase: 15_000_000, maxFranchises: 35, mult: 1.4, minPieces: 5_000_000 },
  singapore: { id: 'singapore', name: 'Singapore', flag: '🇸🇬', openCost: 500_000_000, franchiseBase: 25_000_000, maxFranchises: 30, mult: 1.6, minPieces: 10_000_000 },
  nyc: { id: 'nyc', name: 'New York City', flag: '🗽', openCost: 1.5e9, franchiseBase: 60_000_000, maxFranchises: 60, mult: 2.2, minPieces: 25_000_000 },
  london: { id: 'london', name: 'London', flag: '🇬🇧', openCost: 2.5e9, franchiseBase: 80_000_000, maxFranchises: 50, mult: 2.4, minPieces: 50_000_000 },
  paris: { id: 'paris', name: 'Paris', flag: '🗼', openCost: 4e9, franchiseBase: 110_000_000, maxFranchises: 50, mult: 2.7, minPieces: 100_000_000 },
  dubai: { id: 'dubai', name: 'Dubai', flag: '🇦🇪', openCost: 8e9, franchiseBase: 200_000_000, maxFranchises: 40, mult: 3.5, minPieces: 250_000_000 },
};
export const CITY_IDS = Object.keys(CITIES);

/** Each franchise sells this many pieces per real second (before multipliers). */
export const FRANCHISE_PPS = 2;
/** Royalty per franchise piece, yen. */
export const FRANCHISE_ROYALTY = 200;
export function franchiseCost(city: CityDef, owned: number, discount = 1): number {
  return Math.round(city.franchiseBase * Math.pow(1.12, owned) * discount);
}

export const HQ_MAX = 10;
export function hqCost(level: number): number { return Math.round(50_000_000 * Math.pow(2.4, level)); }
export const FACILITIES = {
  kitchen: { name: 'Central Kitchen', emoji: '🏭', desc: '+15% cooking speed in every restaurant per level, franchise output +10%.', base: 40_000_000, growth: 2.5, max: 10 },
  logistics: { name: 'Distribution Center', emoji: '🚛', desc: '-6% ingredient cost per level, +10% franchise output.', base: 30_000_000, growth: 2.5, max: 10 },
} as const;
export type FacilityId = keyof typeof FACILITIES;

// ---------------------------------------------------------------- rivals & events
export interface RivalDef { id: string; name: string; owner: string; color: string; style: string; districts: DistrictId[] }
export const RIVALS: Record<string, RivalDef> = {
  kaiten: { id: 'kaiten', name: 'Kaiten King', owner: 'Ryo Tanaka', color: '#e63946', style: 'cheap conveyor sushi, price wars', districts: ['asakusa', 'shibuya', 'shinjuku'] },
  maguro: { id: 'maguro', name: 'Maguro Mart', owner: 'Ms. Fujiwara', color: '#457b9d', style: 'supermarket sushi, aggressive ads', districts: ['shibuya', 'shinjuku'] },
  golden: { id: 'golden', name: 'Golden Chopstick', owner: 'Chef Hayashi', color: '#c9a227', style: 'luxury omakase', districts: ['ginza', 'shinjuku'] },
};

export interface EventDef { id: string; name: string; emoji: string; desc: string; demand: number; days: number; ingredient?: IngredientId; ingredientMult?: number; rain?: boolean; minPieces: number }
export const EVENTS: Record<string, EventDef> = {
  festival: { id: 'festival', name: 'Tokyo Sushi Festival', emoji: '🎏', desc: 'Sushi fever! +60% demand everywhere.', demand: 1.6, days: 1, minPieces: 500 },
  tourists: { id: 'tourists', name: 'Tourist Season', emoji: '🧳', desc: 'Tour buses everywhere. +35% demand, more tourists.', demand: 1.35, days: 2, minPieces: 200 },
  rain: { id: 'rain', name: 'Rainy Day', emoji: '🌧️', desc: 'Fewer walk-ins (-25%) but takeout booms for automated shops.', demand: 0.75, days: 1, rain: true, minPieces: 0 },
  shortage_salmon: { id: 'shortage_salmon', name: 'Salmon Shortage', emoji: '📉', desc: 'Salmon costs 2.5x today.', demand: 1, days: 1, ingredient: 'salmon', ingredientMult: 2.5, minPieces: 300 },
  shortage_tuna: { id: 'shortage_tuna', name: 'Tuna Shortage', emoji: '📉', desc: 'Tuna costs 2.5x today.', demand: 1, days: 1, ingredient: 'tuna', ingredientMult: 2.5, minPieces: 1_000 },
  holiday: { id: 'holiday', name: 'Golden Week Rush', emoji: '🎌', desc: 'Holiday crowds: +80% demand.', demand: 1.8, days: 1, minPieces: 5_000 },
  critic: { id: 'critic', name: 'Critic in Town', emoji: '📝', desc: 'A famous food critic is visiting restaurants today. Impress them!', demand: 1, days: 1, minPieces: 2_000 },
};
