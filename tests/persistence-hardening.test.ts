// Save/load hardening: full round-trips, migration of minimal saves, backup fallback, hostile input, export codes.
// (tests/persistence.test.ts and tests/core.test.ts cover quota-on-primary, legacy ticket ids and basic fallback.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as A from '../src/core/actions';
import { CITIES, INGREDIENT_IDS, START_RECIPES, wageFor } from '../src/core/data';
import * as sim from '../src/core/sim';
import {
  GameState, SAVE_KEY, SAVE_VERSION, createNewState, deserialize, exportSave, importSave, loadFromStorage, migrate,
  saveToStorage, serialize,
} from '../src/core/state';

function seeded(seed = 42) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }
const mem = () => new MemStorage() as unknown as Storage & MemStorage;
const BACKUP = SAVE_KEY + '-backup';

function hire(st: GameState, role: 'chef' | 'server' | 'manager', rest: string | null) {
  const c = sim.makeCandidate(st, role); st.candidates.push(c); st.cash += 1e9;
  const p = st.lifetime.pieces; st.lifetime.pieces = Math.max(p, 1e5);
  expect(A.hire(st, c.id, rest)).toBeNull();
  st.cash -= 1e9; st.lifetime.pieces = p;
}

/** A state that has been played for a while: staff, a second shop, tickets in flight, flags. */
function playedState(): GameState {
  const s = createNewState('Kenji', 'Sushi Co');
  sim.refreshCandidates(s);
  s.cash = 5e7;
  s.lifetime.pieces = 60_000;
  s.districts.push('shibuya');
  expect(A.buyProperty(s, 'shibuya_crossing')).toBeNull();
  hire(s, 'chef', 'asakusa_stand'); hire(s, 'server', 'asakusa_stand'); hire(s, 'manager', 'asakusa_stand');
  hire(s, 'chef', 'shibuya_crossing'); hire(s, 'server', null);
  s.flags.chapter2 = true; s.flags.boughtOnce = true;
  expect(A.launchCampaign(s, 'newspaper')).toBeNull();
  for (let i = 0; i < 1500; i++) sim.tick(s, 0.2, { activeDistrict: 'asakusa' });
  sim.acceptOrder(s, 'asakusa_stand', { recipe: 'salmon_nigiri', pieces: 3, type: 'vip', customerId: 7 });
  return s;
}

beforeEach(() => sim.setRandom(seeded()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('round-trip', () => {
  it('serialize → deserialize preserves every field of a played state', () => {
    const s = playedState();
    expect(s.restaurants.asakusa_stand.orders.length + s.restaurants.asakusa_stand.ready.length).toBeGreaterThan(0);
    const json = serialize(s, 1_700_000_000_000);
    const loaded = deserialize(json);
    expect(loaded).toEqual({ ...s, lastSaved: 1_700_000_000_000 });
    expect(serialize(loaded, 1_700_000_000_000)).toBe(json); // byte-stable: re-saving changes nothing
  });

  it('a loaded game keeps simulating identically to the original', () => {
    const a = playedState();
    const b = deserialize(serialize(a, a.lastSaved));
    sim.setRandom(seeded(9));
    for (let i = 0; i < 495; i++) sim.tick(a, 0.2, { activeDistrict: null });
    sim.setRandom(seeded(9));
    for (let i = 0; i < 495; i++) sim.tick(b, 0.2, { activeDistrict: null });
    expect(b.cash).toBe(a.cash);
    expect(b.lifetime).toEqual(a.lifetime);
  });
});

describe('migrate', () => {
  it('fills every missing field of a minimal save without touching progress', () => {
    const minimal = {
      cash: 42_000, lifetime: { pieces: 12_345 }, milestoneIndex: 3,
      recipes: [...START_RECIPES, 'tuna_nigiri'], districts: ['asakusa', 'shibuya'], research: ['knife_skills'],
      flags: { boughtOnce: true }, player: { name: '鮨職人', district: 'shibuya' }, inventory: { salmon: 7 },
    };
    const s = migrate(structuredClone(minimal));
    expect(s.cash).toBe(42_000);
    expect(s.lifetime.pieces).toBe(12_345);
    expect(s.lifetime.revenue).toBe(0);
    expect(s.milestoneIndex).toBe(3);
    expect(s.recipes).toEqual(minimal.recipes);
    expect(s.districts).toEqual(['asakusa', 'shibuya']);
    expect(s.research).toEqual(['knife_skills']);
    expect(s.flags).toEqual({ boughtOnce: true });
    expect(s.player.name).toBe('鮨職人');
    expect(s.player.district).toBe('shibuya');
    expect(s.player.company).toBe('Sushi Empire');
    expect(s.player.avatar).toEqual(createNewState().player.avatar);
    expect(s.inventory.salmon).toBe(7);
    for (const k of INGREDIENT_IDS) expect(Number.isInteger(s.inventory[k])).toBe(true);
    expect(Object.keys(s.restaurants)).toEqual(['asakusa_stand']);
    expect(s.restaurants.asakusa_stand.menu).toEqual(START_RECIPES);
    expect(s.settings.quality).toBe('high');
    expect(s.version).toBe(SAVE_VERSION);
    expect(s.nextTicketId).toBe(1);
    // the migrated save is fully playable and stable under a second migration
    for (let i = 0; i < 200; i++) sim.tick(s, 0.5, { activeDistrict: 'shibuya' });
    expect(migrate(JSON.parse(serialize(s, 1)))).toEqual({ ...s, lastSaved: 1 });
  });

  it('v1 saves: cleaners become servers, retired research/upgrades are dropped, the tutorial resumes at "hire a chef"', () => {
    const raw = JSON.parse(serialize(createNewState()));
    raw.version = 1; raw.tutorial = 4;
    raw.staff = [{ id: 1, role: 'cleaner', skill: 3, xp: 0, wage: 1, restaurant: 'asakusa_stand' }];
    raw.candidates = [{ id: 2, role: 'cleaner' }];
    raw.research = ['knife_skills', 'auto_restock'];
    raw.restaurants.asakusa_stand.upgrades = { sign: 1, cleaning: 2 };
    raw.rivals = { kaiten: { shibuya: 0.2 } }; raw.event = { id: 'festival', endsDay: 9 }; raw.contracts = { active: [] };
    const s = deserialize(JSON.stringify(raw));
    expect(s.staff[0]).toMatchObject({ role: 'server', skill: 3, wage: wageFor('server', 3), restaurant: 'asakusa_stand' });
    expect(s.candidates[0].role).toBe('server');
    expect(s.research).toEqual(['knife_skills']);
    expect(s.restaurants.asakusa_stand.upgrades).toEqual({ sign: 1 });
    expect(s.tutorial).toBe(1);
    expect(s.version).toBe(SAVE_VERSION);
  });

  it('fills a restaurant that is missing its nested fields', () => {
    const raw = JSON.parse(serialize(createNewState()));
    raw.restaurants.asakusa_stand = { id: 'asakusa_stand', served: 321, revenue: 9_999 };
    const r = deserialize(JSON.stringify(raw)).restaurants.asakusa_stand;
    expect(r.served).toBe(321);
    expect(r.revenue).toBe(9_999);
    expect(r.menu).toEqual(START_RECIPES);
    expect(r.orders).toEqual([]);
    expect(r.priceMult).toBe(1);
  });
});

describe('storage fallback', () => {
  it.each(['[]', 'null', '"text"', '42', '{}', '{"cash":"5000"}', '', '{"cash":1,"restaurants":[]}'])(
    'main save %j is unusable → the backup loads', (main) => {
      const st = mem();
      const backup = createNewState(); backup.cash = 4_321;
      st.setItem(BACKUP, serialize(backup));
      st.setItem(SAVE_KEY, main);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(loadFromStorage(st)?.cash).toBe(4_321);
    });

  it('returns null when both copies are corrupt or storage is empty', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const st = mem();
    expect(loadFromStorage(st)).toBeNull();
    st.setItem(SAVE_KEY, '{bad'); st.setItem(BACKUP, '[1,2');
    expect(loadFromStorage(st)).toBeNull();
  });

  it('does not overwrite a good backup with a corrupt main save', () => {
    const st = mem();
    const s = createNewState(); s.cash = 111;
    expect(saveToStorage(s, st)).toBe(true);
    s.cash = 222;
    expect(saveToStorage(s, st)).toBe(true); // 111 → backup
    st.setItem(SAVE_KEY, '{corrupt');
    s.cash = 333;
    expect(saveToStorage(s, st)).toBe(true); // corrupt main must not replace the 111 backup
    expect(deserialize(st.getItem(BACKUP)!).cash).toBe(111);
    expect(loadFromStorage(st)?.cash).toBe(333);
  });
});

describe('throwing storage', () => {
  it('saveToStorage returns false (never throws) when every storage call throws', () => {
    const boom = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    const st = { getItem: boom, setItem: boom, removeItem: boom } as unknown as Storage;
    const s = createNewState(); const t = s.lastSaved;
    expect(saveToStorage(s, st)).toBe(false);
    expect(s.lastSaved).toBe(t);
    expect(loadFromStorage(st)).toBeNull();
  });

  it('quota while writing the backup leaves the previous main save loadable', () => {
    const st = mem();
    const s = createNewState(); s.cash = 10;
    saveToStorage(s, st);
    vi.spyOn(st, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    s.cash = 20;
    expect(saveToStorage(s, st)).toBe(false);
    vi.restoreAllMocks();
    expect(loadFromStorage(st)?.cash).toBe(10);
  });

  it('without any localStorage (node) save fails soft and load returns null', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(saveToStorage(createNewState())).toBe(false);
    expect(loadFromStorage()).toBeNull();
  });
});

describe('hostile saves', () => {
  const base = () => JSON.parse(serialize(createNewState()));
  type Mut = (raw: any) => void;

  /** Load must either throw or yield a sane, playable state. */
  function loadOrReject(json: string): GameState | 'rejected' {
    let s: GameState;
    try { s = deserialize(json); } catch { return 'rejected'; }
    expect(Number.isFinite(s.cash)).toBe(true);
    expect(Number.isFinite(s.lifetime.pieces) && s.lifetime.pieces >= 0).toBe(true);
    for (const k of INGREDIENT_IDS) expect(s.inventory[k]).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 100; i++) sim.tick(s, 0.5, { activeDistrict: s.player.district });
    sim.offlineProgress(s, 3600);
    serialize(s);
    return s;
  }

  it.each<[string, Mut]>([
    ['cash as string', (r) => { r.cash = '5000'; }],
    ['cash null (NaN serialized)', (r) => { r.cash = null; }],
    ['unknown district', (r) => { r.districts.push('atlantis'); }],
    ['unknown restaurant', (r) => { r.restaurants.bogus_bar = { ...r.restaurants.asakusa_stand, id: 'bogus_bar' }; }],
    ['restaurant key/id mismatch', (r) => { r.restaurants.asakusa_stand.id = 'ginza_flagship'; }],
    ['unknown menu recipe', (r) => { r.restaurants.asakusa_stand.menu = ['poison_fugu']; }],
    ['unknown unlocked recipe', (r) => { r.recipes.push('poison_fugu'); }],
    ['unknown piecesByRecipe key', (r) => { r.piecesByRecipe = { poison_fugu: 5 }; }],
    ['unknown staff role', (r) => { r.staff = [{ id: 1, role: 'ninja' }]; }],
    ['null staff entry', (r) => { r.staff = [null]; }],
    ['staff not an array', (r) => { r.staff = 'everyone'; }],
    ['unknown campaign', (r) => { r.campaigns = [{ id: 'mind_control', district: null, endsDay: 9, endsMinute: 0 }]; }],
    ['rivals not an object', (r) => { r.rivals = 5; }],
    ['fractional milestoneIndex', (r) => { r.milestoneIndex = 1.5; }],
    ['milestoneIndex as string', (r) => { r.milestoneIndex = '3'; }],
    ['inventory as array', (r) => { r.inventory = []; }],
    ['inventory value as string', (r) => { r.inventory.salmon = 'lots'; }],
    ['settings as string', (r) => { r.settings = 'loud'; }],
    ['ticket with unknown recipe', (r) => { r.restaurants.asakusa_stand.orders = [{ id: 1, recipe: 'x', customerType: 'office' }]; }],
    ['__proto__ restaurant key', (r) => { Object.defineProperty(r.restaurants, '__proto__', { value: { id: 'x' }, enumerable: true }); }],
  ])('rejects: %s', (_, mut) => {
    const raw = base(); mut(raw);
    expect(loadOrReject(JSON.stringify(raw))).toBe('rejected');
  });

  it.each<[string, Mut, (s: GameState) => void]>([
    ['cash overflow (1e400 → Infinity)', (r) => { r.cash = '§INF'; }, (s) => expect(s.cash).toBe(0)],
    ['negative pieces', (r) => { r.lifetime.pieces = -50; }, (s) => expect(s.lifetime.pieces).toBe(0)],
    ['infinite pieces', (r) => { r.lifetime.pieces = '§INF'; }, (s) => expect(s.lifetime.pieces).toBe(0)],
    ['negative / fractional inventory', (r) => { r.inventory.salmon = -10; r.inventory.rice = 2.7; }, (s) => {
      expect(s.inventory.salmon).toBe(0); expect(s.inventory.rice).toBe(2);
    }],
    ['bad nextTicketId', (r) => { r.nextTicketId = -5; }, (s) => expect(s.nextTicketId).toBe(1)],
    ['infinite inventory (1e400)', (r) => { r.inventory.salmon = '§INF'; }, (s) => expect(s.inventory.salmon).toBe(0)],
    ['unknown city is dropped', (r) => { r.cities = { atlantis: { open: true, franchises: 3 }, tokyo: { open: true, franchises: 2 } }; },
      (s) => expect(s.cities).toEqual({ tokyo: { open: true, franchises: 2 } })],
    ['franchises clamped to the city max', (r) => { r.cities = { tokyo: { open: true, franchises: '§INF' }, osaka: { open: true, franchises: -4.5 } }; },
      (s) => { expect(s.cities.tokyo.franchises).toBe(0); expect(s.cities.osaka.franchises).toBe(0); }],
    ['huge finite franchises clamped', (r) => { r.cities = { tokyo: { open: true, franchises: 1e300 } }; },
      (s) => expect(s.cities.tokyo.franchises).toBe(CITIES.tokyo.maxFranchises)],
    ['unknown extra top-level keys', (r) => { r.hacked = { admin: true }; }, () => {}],
  ])('sanitizes: %s', (_, mut, check) => {
    const raw = base(); mut(raw);
    const json = JSON.stringify(raw).replaceAll('"§INF"', '1e400');
    const s = loadOrReject(json);
    expect(s).not.toBe('rejected');
    check(s as GameState);
  });

  it('prototype-pollution keys never reach Object.prototype', () => {
    const json = JSON.stringify(base())
      .replace('{', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},')
      .replace('"flags":{}', '"flags":{"__proto__":{"polluted":true}}')
      .replace('"settings":{', '"settings":{"__proto__":{"polluted":true},');
    const s = loadOrReject(json);
    expect(s).not.toBe('rejected');
    expect(({} as any).polluted).toBeUndefined();
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf((s as GameState).flags)).toBe(Object.prototype);
    for (const field of ['piecesByRecipe', 'restaurants']) {
      const raw = JSON.stringify(base()).replace(`"${field}":{`, `"${field}":{"__proto__":{"polluted":true},`);
      expect(loadOrReject(raw)).toBe('rejected');
    }
    expect(({} as any).polluted).toBeUndefined();
  });

  it.each([null, [], 'save', 42, true, {}])('rejects non-save JSON root %j', (root) => {
    expect(() => deserialize(JSON.stringify(root))).toThrow();
  });

  // regression: minimal employees used to load with undefined skill/wage and turn cash into NaN at endDay
  it('fills minimal employees so wages and the kitchen stay finite', () => {
    const raw = base();
    raw.staff = [
      { id: 98, role: 'chef', restaurant: 'asakusa_stand' },
      { id: 99, role: 'server', restaurant: 'asakusa_stand', skill: '§INF', wage: '§INF' },
    ];
    raw.candidates = [{ id: 100, role: 'manager' }];
    const s = deserialize(JSON.stringify(raw).replaceAll('"§INF"', '1e400'));
    for (const e of [...s.staff, ...s.candidates]) {
      expect(Number.isFinite(e.skill) && Number.isFinite(e.wage) && Number.isFinite(e.xp)).toBe(true);
      expect(e.look).toBeTypeOf('object');
    }
    expect(s.staff[0]).toMatchObject({ skill: 1, wage: wageFor('chef', 1), xp: 0 });
    expect(s.staff[1]).toMatchObject({ skill: 1, wage: wageFor('server', 1) });
    expect(s.candidates[0].restaurant).toBeNull();
    const cash = s.cash;
    sim.endDay(s);
    expect(s.cash).toBe(cash - wageFor('chef', 1) - wageFor('server', 1));
    for (let i = 0; i < 1_000; i++) sim.tick(s, 0.5, { activeDistrict: null });
    expect(Number.isFinite(s.cash)).toBe(true);
    expect(s.lifetime.pieces).toBeGreaterThan(0); // the filled-in chef actually cooks
  });

  // regression: a ticket without valid `pieces` used to load and turn inventory into NaN
  it.each([undefined, 0, -3, 1.5, '2', 1e400])('rejects a ticket with pieces = %s', (pieces) => {
    const raw = base();
    raw.restaurants.asakusa_stand.orders = [{ id: 1, recipe: 'salmon_nigiri', customerType: 'office', customerId: null, cook: 'kitchen', pieces }];
    expect(loadOrReject(JSON.stringify(raw))).toBe('rejected');
  });

  // regression: franchises = 1e400 used to make lifetime.pieces Infinity and hang checkMilestones forever
  it('infinite franchises in a save are clamped and the next tick returns', () => {
    const s = deserialize(serialize(createNewState()).replace('"cities":{}', '"cities":{"tokyo":{"open":true,"franchises":1e400}}'));
    expect(s.cities.tokyo.franchises).toBe(0);
    sim.tick(s, 0.1, { activeDistrict: null });
    expect(Number.isFinite(s.lifetime.pieces)).toBe(true);
  });
});

describe('export / import codes', () => {
  it.each([
    ['日本語', '寿司帝国株式会社'],
    ['🍣 Chef 🔪', '👑 Empire 🇯🇵'],
    ['Zoë Ñúñez', 'Crème brûlée & <script>"\'\\'],
  ])('round-trips unicode names %s / %s', (name, company) => {
    const s = createNewState(name, company);
    s.cash = 987_654; s.lifetime.pieces = 1_234_567; s.flags.chapter2 = true;
    const code = exportSave(s);
    expect(code).toMatch(/^[A-Za-z0-9+/]+=*$/); // pure ASCII base64, safe to paste anywhere
    const back = importSave(`\n  ${code}  \n`); // users paste with whitespace
    expect(back.player.name).toBe(name);
    expect(back.player.company).toBe(company);
    expect(back.cash).toBe(987_654);
    expect(back.lifetime.pieces).toBe(1_234_567);
    expect({ ...back, lastSaved: 0 }).toEqual({ ...s, lastSaved: 0 });
  });

  it('a lone surrogate (cut emoji) in a name still exports and imports', () => {
    const s = createNewState('Chef \uD83C', '\uDF63 Co');
    expect(importSave(exportSave(s)).player.name).toBe('Chef \uD83C');
  });

  it.each(['', '   ', '!!!not base64!!!', btoa('{}'), btoa('null'), btoa('{"cash":1,"player":{"district":"mars"}}'), btoa('\xff\xfe')])(
    'rejects bad code %j by throwing', (code) => {
      expect(() => importSave(code)).toThrow();
    });

});
