import { describe, expect, it } from 'vitest';
import { CUSTOMERS, INGREDIENTS, RECIPES, recipeCost } from '../src/core/data';
import {
  HOLIDAYS, SEASONAL_RECIPES, YEAR_DAYS, dayOfYear, holiday, season, seasonalRecipes, seasonDecor, seasonDemand, seasonMix, year,
} from '../src/core/seasons';
import { createNewState } from '../src/core/state';

const DAYS = Array.from({ length: YEAR_DAYS * 3 }, (_, i) => i + 1);

describe('seasons calendar', () => {
  it('starts in spring and accepts GameState', () => {
    const s = createNewState();
    expect(season(s)).toMatchObject({ id: 'spring', dayOfSeason: 1 });
    expect(holiday(s)).toBeNull();
  });

  it('wraps over multiple years', () => {
    for (const d of DAYS) {
      expect(season(d)).toEqual(season(d + YEAR_DAYS));
      expect(holiday(d)).toBe(holiday(d + YEAR_DAYS));
    }
    expect(dayOfYear(28)).toBe(28);
    expect(dayOfYear(29)).toBe(1);
    expect(year(28)).toBe(1);
    expect(year(29)).toBe(2);
    expect(season(29).id).toBe('spring');
    expect(dayOfYear(0)).toBe(28); // defensive: never out of range
  });

  it('each season lasts exactly 7 consecutive days in order', () => {
    const ids = Array.from({ length: YEAR_DAYS }, (_, i) => season(i + 1).id);
    expect(ids).toEqual([...Array(7).fill('spring'), ...Array(7).fill('summer'), ...Array(7).fill('autumn'), ...Array(7).fill('winter')]);
    expect(Array.from({ length: 7 }, (_, i) => season(8 + i).dayOfSeason)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('every day maps to exactly one decor, one per season', () => {
    const bySeason = new Map<string, Set<string>>();
    for (const d of DAYS) {
      const k = season(d).id;
      if (!bySeason.has(k)) bySeason.set(k, new Set());
      bySeason.get(k)!.add(seasonDecor(d));
    }
    expect([...bySeason.values()].map((v) => [...v])).toEqual([['sakura'], ['matsuri'], ['momiji'], ['snow']]);
  });

  it('holidays have unique ids/days within the year; New Year closes winter', () => {
    expect(new Set(HOLIDAYS.map((h) => h.id)).size).toBe(HOLIDAYS.length);
    expect(new Set(HOLIDAYS.map((h) => h.day)).size).toBe(HOLIDAYS.length);
    for (const h of HOLIDAYS) expect(h.day >= 1 && h.day <= YEAR_DAYS).toBe(true);
    expect(holiday(28)?.id).toBe('shogatsu');
    expect(season(28).id).toBe('winter');
    expect(holiday(YEAR_DAYS * 2 + 4)?.id).toBe('hanami');
  });

  it('demand stays in a sane range and holidays boost it', () => {
    for (const d of DAYS) {
      const m = seasonDemand(d);
      expect(m).toBeGreaterThanOrEqual(0.85);
      expect(m).toBeLessThanOrEqual(1.5);
    }
    expect(seasonDemand(28)).toBeGreaterThan(seasonDemand(22));
  });

  it('mix only uses real customer types with positive weights', () => {
    for (const d of DAYS) for (const [k, w] of Object.entries(seasonMix(d))) {
      expect(CUSTOMERS).toHaveProperty(k);
      expect(w).toBeGreaterThan(0);
    }
    expect(seasonMix(28).family).toBeGreaterThan(seasonMix(22).family ?? 0);
  });
});

describe('seasonal recipes', () => {
  it('are valid, profitable RecipeDefs merged into RECIPES under unique ids', () => {
    const ids = Object.keys(SEASONAL_RECIPES);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const [id, r] of Object.entries(SEASONAL_RECIPES)) {
      expect(r.id).toBe(id);
      expect(RECIPES[id]).toBe(SEASONAL_RECIPES[id]); // merged into RECIPES by data.ts; ids must stay unique
      expect(['nigiri', 'maki', 'roll', 'gunkan', 'platter']).toContain(r.kind);
      for (const [k, n] of Object.entries(r.ingredients)) {
        expect(INGREDIENTS).toHaveProperty(k);
        expect(n).toBeGreaterThan(0);
      }
      expect(r.price).toBeGreaterThan(recipeCost(r));
      expect(r.prep).toBeGreaterThan(0);
    }
  });

  it('every limited recipe is available on some day, and availability follows the calendar', () => {
    const seen = new Set<string>();
    for (const d of DAYS) for (const id of seasonalRecipes(d)) {
      expect(SEASONAL_RECIPES).toHaveProperty(id);
      seen.add(id);
    }
    expect([...seen].sort()).toEqual(Object.keys(SEASONAL_RECIPES).sort());
    expect(seasonalRecipes(1)).toEqual(['sakura_ebi_nigiri']);
    expect(seasonalRecipes(28)).toEqual(['yuki_roll', 'osechi_platter']);
    expect(seasonalRecipes(22)).not.toContain('osechi_platter');
  });
});
