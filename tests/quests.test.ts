import { beforeEach, describe, expect, it } from 'vitest';
import { DISTRICT_IDS, RECIPES, START_RECIPES } from '../src/core/data';
import {
  Quest, QuestEvent, QuestKind, QuestState, QUEST_KINDS, STREAK_CAP, claimQuest, createQuestState, ensureQuests,
  estimateDailyRevenue, questOnEvent, rollDailyQuests, streakBonus,
} from '../src/core/quests';
import * as sim from '../src/core/sim';
import { GameState, createNewState, newRestaurant } from '../src/core/state';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function addStaff(s: GameState, role: 'chef' | 'server' | 'cleaner' | 'manager', rest: string | null, skill = 3) {
  const e = sim.makeCandidate(s, role); e.skill = skill; e.restaurant = rest; s.staff.push(e);
}

/** Mid/late game: several districts and restaurants, staff, all recipes; every quest kind is eligible. */
function richState(): GameState {
  const s = createNewState();
  s.lifetime.pieces = 60_000; s.lifetime.manualOrders = 50; s.milestoneIndex = 4;
  s.cash = 5_000_000;
  s.districts = [...DISTRICT_IDS];
  s.recipes = Object.keys(RECIPES);
  for (const id of ['asakusa_shop', 'shibuya_crossing', 'ginza_omakase']) {
    s.restaurants[id] = newRestaurant(id, 1);
    s.restaurants[id].menu = s.recipes.slice(0, 6);
  }
  s.restaurants.asakusa_stand.reputation = 4.2;
  for (const id of ['asakusa_shop', 'shibuya_crossing', 'ginza_omakase']) { addStaff(s, 'chef', id); addStaff(s, 'server', id); }
  s.minute = 9 * 60;
  return s;
}

/** Late game: big flagships, many skilled chefs, chapter 2 franchises. */
function lateState(): GameState {
  const s = richState();
  s.lifetime.pieces = 3_000_000; s.flags.chapter2 = true;
  for (const id of ['shibuya_center', 'shinjuku_tower', 'ginza_flagship']) {
    s.restaurants[id] = newRestaurant(id, 1); s.restaurants[id].menu = ['dragon_roll', 'rainbow_roll', 'toro_nigiri', 'chefs_special'];
    s.restaurants[id].reputation = 4.5;
    for (let i = 0; i < 5; i++) addStaff(s, 'chef', id, 8);
    addStaff(s, 'server', id, 8);
  }
  s.cities = { tokyo: { open: true, franchises: 20 }, osaka: { open: true, franchises: 10 } };
  return s;
}

function fresh(day = 1): [QuestState, GameState] {
  const s = createNewState(); s.day = day;
  const q = createQuestState(); ensureQuests(q, s, seeded());
  return [q, s];
}

/** Roll with successive seeds until `kind` shows up (proves it can actually be rolled). */
function rollUntil(s: GameState, kind: QuestKind): Quest {
  for (let seed = 1; seed < 500; seed++) {
    const found = rollDailyQuests(s, seeded(seed)).find((x) => x.kind === kind);
    if (found) return found;
  }
  throw new Error(`${kind} never rolled`);
}

const sale = (over: Partial<Extract<QuestEvent, { type: 'sale' }>> = {}): QuestEvent =>
  ({ type: 'sale', restaurant: 'asakusa_stand', recipe: 'salmon_nigiri', pieces: 3, revenue: 400, customerType: 'office', ...over });

function finish(q: QuestState) { for (const x of q.list) { x.progress = x.target; x.done = true; } }

beforeEach(() => sim.setRandom(seeded(7)));

describe('rolling', () => {
  it('rolls 3 quests with distinct kinds', () => {
    const s = richState();
    for (let seed = 1; seed < 100; seed++) {
      const list = rollDailyQuests(s, seeded(seed));
      expect(list).toHaveLength(3);
      expect(new Set(list.map((x) => x.kind)).size).toBe(3);
      expect(new Set(list.map((x) => x.id)).size).toBe(3);
      for (const x of list) {
        expect(x.target).toBeGreaterThan(0);
        expect(x.desc).toMatch(/\d/);
        expect(x.title.length).toBeGreaterThan(0);
        expect(x.reward.cash).toBeGreaterThan(0);
        expect(x.reward.rp).toBeGreaterThan(0);
      }
    }
  });

  it('re-rolls on a new day, not on the same day', () => {
    const [q, s] = fresh();
    const first = q.list;
    expect(q.day).toBe(1);
    expect(ensureQuests(q, s, seeded(99))).toBe(false);
    expect(q.list).toBe(first);
    s.day = 2;
    expect(ensureQuests(q, s, seeded(99))).toBe(true);
    expect(q.day).toBe(2);
    expect(q.list).not.toBe(first);
    expect(q.list.every((x) => x.id.startsWith('2-') && !x.done && !x.claimed)).toBe(true);
  });

  it('fresh-state rolls never include locked content', () => {
    const allowed: QuestKind[] = ['serve', 'office', 'recipe', 'earn', 'perfect', 'lunch', 'upgrade'];
    const s = createNewState();
    for (let seed = 1; seed < 300; seed++) {
      for (const x of rollDailyQuests(s, seeded(seed))) {
        expect(allowed).toContain(x.kind);
        if (x.meta?.recipe) expect(START_RECIPES).toContain(x.meta.recipe);
        if (x.meta?.district) expect(x.meta.district).toBe('asakusa');
      }
    }
  });

  it('meta only references unlocked, owned content', () => {
    const s = richState();
    delete s.restaurants.ginza_omakase; s.districts = ['asakusa', 'shibuya', 'shinjuku'];
    for (let seed = 1; seed < 300; seed++) {
      for (const x of rollDailyQuests(s, seeded(seed))) {
        if (x.meta?.recipe) expect(s.recipes).toContain(x.meta.recipe);
        if (x.meta?.district) expect(s.districts).toContain(x.meta.district);
        if (x.kind === 'district') expect(['asakusa', 'shibuya']).toContain(x.meta!.district);
        if (x.kind === 'travel') expect(x.meta!.district).not.toBe(s.player.district);
        if (x.meta?.restaurant) expect(s.restaurants[x.meta.restaurant]).toBeDefined();
      }
    }
  });

  it('skips the lunch quest once the rush has started', () => {
    const s = createNewState(); s.minute = 12 * 60;
    for (let seed = 1; seed < 200; seed++) expect(rollDailyQuests(s, seeded(seed)).some((x) => x.kind === 'lunch')).toBe(false);
  });
});

describe('scaling', () => {
  it('late-game rewards dwarf fresh ones and both sit at 15–40% of a day', () => {
    const early = createNewState(), late = lateState();
    const rEarly = estimateDailyRevenue(early), rLate = estimateDailyRevenue(late);
    expect(rEarly).toBe(5_000); // floor for a brand-new stand
    expect(rLate).toBeGreaterThan(rEarly * 100);
    for (const [s, r] of [[early, rEarly], [late, rLate]] as const) {
      for (let seed = 1; seed < 60; seed++) {
        for (const x of rollDailyQuests(s, seeded(seed))) {
          expect(x.reward.cash / r).toBeGreaterThanOrEqual(0.15);
          expect(x.reward.cash / r).toBeLessThanOrEqual(0.4);
        }
      }
    }
    const avg = (s: GameState) => { const l = rollDailyQuests(s, seeded(3)); return l.reduce((a, x) => a + x.reward.cash, 0) / l.length; };
    expect(avg(late)).toBeGreaterThan(avg(early) * 100);
    expect(rollUntil(late, 'serve').target).toBeGreaterThan(rollUntil(early, 'serve').target * 10);
  });

  it('uses recent history when there is some', () => {
    const s = createNewState();
    s.history = [1, 2, 3].map((day) => ({ day, revenue: 200_000, expenses: 0, pieces: 0, customers: 0 }));
    expect(estimateDailyRevenue(s)).toBe(200_000);
  });

  it('fresh targets are small and doable', () => {
    const s = createNewState();
    expect(rollUntil(s, 'serve').target).toBeLessThanOrEqual(15);
    expect(rollUntil(s, 'perfect').target).toBe(1);
    expect(rollUntil(s, 'upgrade').target).toBe(1);
  });
});

describe('every kind is reachable', () => {
  // How to drive each kind to done, given a state where it rolled.
  const drive: Record<QuestKind, (q: QuestState, s: GameState, x: Quest) => void> = {
    serve: (q, s) => questOnEvent(q, s, sale()),
    office: (q, s) => questOnEvent(q, s, sale({ customerType: 'office' })),
    vip: (q, s) => questOnEvent(q, s, sale({ customerType: 'vip' })),
    recipe: (q, s, x) => questOnEvent(q, s, sale({ recipe: x.meta!.recipe, pieces: 5 })),
    district: (q, s, x) => questOnEvent(q, s, sale({ restaurant: Object.keys(s.restaurants).find((id) => id.startsWith(x.meta!.district!))!, pieces: 8 })),
    earn: (q, s) => questOnEvent(q, s, sale({ revenue: 50_000 })),
    perfect: (q, s) => questOnEvent(q, s, { type: 'manualCook', restaurant: 'asakusa_stand', score: 0.95 }),
    upgrade: (q, s) => questOnEvent(q, s, { type: 'upgrade', restaurant: 'asakusa_stand', upgrade: 'sign' }),
    hire: (q, s) => questOnEvent(q, s, { type: 'hire', role: 'chef' }),
    train: (q, s) => questOnEvent(q, s, { type: 'train', role: 'chef' }),
    campaign: (q, s) => questOnEvent(q, s, { type: 'campaign', id: 'flyers' }),
    travel: (q, s, x) => questOnEvent(q, s, { type: 'travel', district: x.meta!.district! }),
    clean: (q, s) => questOnEvent(q, s, { type: 'clean', restaurant: 'asakusa_stand', cleanlinessBefore: 0.5 }),
    stars: (q, s, x) => { s.restaurants[x.meta!.restaurant!].reputation = 4.8; questOnEvent(q, s, { type: 'dayEnd' }); },
    lunch: (q, s) => {
      s.minute = 12 * 60; questOnEvent(q, s, sale());
      if (q.list[0].progress >= q.list[0].target) { s.minute = 15 * 60; questOnEvent(q, s, sale()); }
    },
  };

  for (const kind of QUEST_KINDS) {
    it(kind, () => {
      const s = richState();
      const x = rollUntil(s, kind);
      const q: QuestState = { day: s.day, list: [x], streak: 0 };
      for (let i = 0; i < 10_000 && !x.done; i++) drive[kind](q, s, x);
      expect(x.done).toBe(true);
      expect(x.progress).toBe(x.target);
      drive[kind](q, s, x); // ignored once done, never exceeds target
      expect(x.progress).toBe(x.target);
      expect(claimQuest(q, s, x.id)).toBeNull();
    });
  }

  it('wrong events do not count', () => {
    const s = richState();
    const q: QuestState = { day: s.day, list: [rollUntil(s, 'recipe'), rollUntil(s, 'travel'), rollUntil(s, 'clean')], streak: 0 };
    const [recipe, travel, clean] = q.list;
    questOnEvent(q, s, sale({ recipe: Object.keys(RECIPES).find((r) => r !== recipe.meta!.recipe)! }));
    questOnEvent(q, s, { type: 'travel', district: s.player.district });
    questOnEvent(q, s, { type: 'clean', restaurant: 'asakusa_stand', cleanlinessBefore: 0.84 });
    questOnEvent(q, s, { type: 'manualCook', restaurant: 'asakusa_stand', score: 0.9 });
    expect([recipe.progress, travel.progress, clean.progress]).toEqual([0, 0, 0]);
  });

  it('a lunch walk-out fails the lunch quest', () => {
    const s = richState();
    const x = rollUntil(s, 'lunch');
    const q: QuestState = { day: s.day, list: [x], streak: 0 };
    s.minute = 11 * 60 + 30;
    questOnEvent(q, s, { type: 'customerLeft', restaurant: 'asakusa_stand', reason: 'closed' }); // closing-time leaves don't count
    expect(x.meta?.failed).toBeFalsy();
    questOnEvent(q, s, { type: 'customerLeft', restaurant: 'asakusa_stand', reason: 'patience' });
    for (let i = 0; i < 50; i++) questOnEvent(q, s, sale());
    questOnEvent(q, s, { type: 'dayEnd' });
    expect(x.meta?.failed).toBe(true);
    expect(x.done).toBe(false);
    expect(claimQuest(q, s, x.id)).toBe('Not finished yet');
  });

  it('lunch completes at day end if no event came after 14:00', () => {
    const s = richState();
    const x = rollUntil(s, 'lunch');
    const q: QuestState = { day: s.day, list: [x], streak: 0 };
    s.minute = 12 * 60;
    for (let i = 0; i < x.target; i++) questOnEvent(q, s, sale());
    expect(x.done).toBe(false); // the rush is not over yet
    questOnEvent(q, s, { type: 'dayEnd' });
    expect(x.done).toBe(true);
  });
});

describe('claiming', () => {
  it('fails for unfinished quests and never pays twice', () => {
    const [q, s] = fresh();
    const x = q.list[0];
    const cash = s.cash, rp = s.rp, rev = s.lifetime.revenue, today = s.today.revenue;
    expect(claimQuest(q, s, x.id)).toBe('Not finished yet');
    expect(claimQuest(q, s, 'nope')).toBe('Unknown quest');
    expect(s.cash).toBe(cash);
    x.progress = x.target; x.done = true;
    expect(claimQuest(q, s, x.id)).toBeNull();
    expect(s.cash).toBe(cash + x.reward.cash);
    expect(s.rp).toBe(rp + x.reward.rp);
    expect(s.lifetime.revenue).toBe(rev + x.reward.cash);
    expect(s.today.revenue).toBe(today); // rewards don't count as sales
    expect(claimQuest(q, s, x.id)).toBe('Already claimed');
    expect(s.cash).toBe(cash + x.reward.cash);
  });

  it('pays a streak bonus that grows, caps and resets', () => {
    const s = createNewState();
    const q = createQuestState();
    const bonuses: number[] = [];
    for (let day = 1; day <= STREAK_CAP + 3; day++) {
      s.day = day; ensureQuests(q, s, seeded(day));
      finish(q);
      const expected = streakBonus(q, s);
      const cash = s.cash;
      for (const x of q.list) expect(claimQuest(q, s, x.id)).toBeNull();
      bonuses.push(s.cash - cash - q.list.reduce((a, x) => a + x.reward.cash, 0));
      expect(bonuses.at(-1)).toBe(expected.cash);
      expect(q.streak).toBe(day);
    }
    for (let i = 1; i <= STREAK_CAP; i++) expect(bonuses[i]).toBeGreaterThan(bonuses[i - 1]);
    expect(bonuses.at(-1)).toBe(bonuses[STREAK_CAP]); // capped
    expect(bonuses.at(-1)! / estimateDailyRevenue(s)).toBeLessThanOrEqual(0.4);

    // A day ending with an unfinished quest resets the streak.
    s.day++; ensureQuests(q, s, seeded(1));
    q.list[0].done = true;
    s.day++; ensureQuests(q, s, seeded(2));
    expect(q.streak).toBe(0);
    finish(q);
    const cash = s.cash;
    for (const x of q.list) claimQuest(q, s, x.id);
    expect(s.cash - cash - q.list.reduce((a, x) => a + x.reward.cash, 0)).toBe(bonuses[0]);
    expect(q.streak).toBe(1);
  });

  it('no bonus until all three are claimed', () => {
    const [q, s] = fresh();
    finish(q);
    const cash = s.cash;
    claimQuest(q, s, q.list[0].id); claimQuest(q, s, q.list[1].id);
    expect(s.cash).toBe(cash + q.list[0].reward.cash + q.list[1].reward.cash);
    expect(q.streak).toBe(0);
  });
});

describe('integration with the sim', () => {
  it('events on a stale day trigger a re-roll before counting', () => {
    const [q, s] = fresh();
    s.day = 2;
    questOnEvent(q, s, sale());
    expect(q.day).toBe(2);
  });

  it('day end for an old list is ignored', () => {
    const [q, s] = fresh();
    s.day = 5;
    questOnEvent(q, s, { type: 'dayEnd' });
    expect(q.day).toBe(1);
  });
});
