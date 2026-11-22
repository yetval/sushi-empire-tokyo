import { describe, expect, it } from 'vitest';
import { CUSTOMERS, CustomerType } from '../src/core/data';
import { MAX_REVIEW_LEN, PHRASES, Review, averageStars, makeReview, pushReview } from '../src/core/reviews';
import * as sim from '../src/core/sim';
import { createNewState } from '../src/core/state';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const s = createNewState();
const REST = 'asakusa_stand';
const TYPES = Object.keys(CUSTOMERS) as CustomerType[];
const sale = (satisfaction: number, customerType: CustomerType = 'office', waitSec: number | null = 20) =>
  ({ customerType, recipe: 'salmon_nigiri', pieces: 3, satisfaction, waitSec });

function meanStars(sat: number, rng: () => number) {
  const stars = Array.from({ length: 2000 }, (_, i) => makeReview(s, REST, sale(sat, TYPES[i % TYPES.length]), rng).stars);
  return { mean: stars.reduce((a, b) => a + b, 0) / stars.length, min: Math.min(...stars), max: Math.max(...stars) };
}

describe('reviews', () => {
  it('is deterministic for a seed (explicit rng and via sim.setRandom)', () => {
    const run = (rng?: () => number) => TYPES.map((t, i) => makeReview(s, REST, sale(i / 9, t, i % 2 ? null : 30 * i), rng));
    expect(run(seeded(7))).toEqual(run(seeded(7)));
    sim.setRandom(seeded(9)); const a = run();
    sim.setRandom(seeded(9)); const b = run();
    expect(a).toEqual(b);
  });

  it('stars track satisfaction', () => {
    const rng = seeded(1);
    const hi = meanStars(0.95, rng), mid = meanStars(0.6, rng), lo = meanStars(0.2, rng);
    expect(hi.mean).toBeGreaterThan(mid.mean);
    expect(mid.mean).toBeGreaterThan(lo.mean);
    expect(hi.min).toBeGreaterThanOrEqual(4);
    expect(lo.max).toBeLessThanOrEqual(2);
  });

  it('every customer type writes non-empty, bounded text with an author', () => {
    const rng = seeded(3);
    for (const t of TYPES) {
      for (const sat of [0, 0.5, 1]) {
        for (const wait of [null, 1, 500]) {
          const r = makeReview(s, REST, sale(sat, t, wait), rng);
          expect(r.text.length).toBeGreaterThan(10);
          expect(r.text.length).toBeLessThanOrEqual(MAX_REVIEW_LEN);
          expect(r.text).not.toMatch(/\{\w+\}/);
          expect(r.author).toBeTruthy();
          expect(Number.isInteger(r.stars) && r.stars >= 1 && r.stars <= 5).toBe(true);
          expect(r.day).toBe(s.day);
        }
      }
    }
  });

  it('has at least 150 distinct phrase fragments', () => {
    expect(new Set(PHRASES).size).toBeGreaterThanOrEqual(150);
  });

  it('ring buffer keeps newest first, capped at 50', () => {
    let list: Review[] = [];
    for (let i = 0; i < 80; i++) list = pushReview(list, { stars: (i % 5) + 1, author: 'a', text: 't', day: i });
    expect(list).toHaveLength(50);
    expect(list[0].day).toBe(79);
    expect(list[49].day).toBe(30);
    expect(averageStars(list)).toBeCloseTo(3, 5);
    expect(averageStars([])).toBe(0);
  });
});
