import { afterEach, describe, expect, it, vi } from 'vitest';
import { fire, hire } from '../src/core/actions';
import { acceptOrder, makeCandidate, settle, tickRestaurant } from '../src/core/sim';
import {
  GameState, SAVE_KEY, createNewState, deserialize, exportSave, importSave, loadFromStorage, saveToStorage, serialize,
} from '../src/core/state';

const BACKUP_KEY = `${SAVE_KEY}-backup`;
const STAND = 'asakusa_stand';
const SALMON_ORDER = { recipe: 'salmon_nigiri', type: 'office' } as const;

class MemoryStorage implements Storage {
  private records = new Map<string, string>();

  get length(): number { return this.records.size; }
  clear(): void { this.records.clear(); }
  getItem(key: string): string | null { return this.records.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.records.keys())[index] ?? null; }
  removeItem(key: string): void { this.records.delete(key); }
  setItem(key: string, value: string): void { this.records.set(key, value); }
}

afterEach(() => vi.restoreAllMocks());

/** Test shortcut: the kitchen finishes this ticket now. */
function cook(s: GameState, restId: string, id: number): void {
  const r = s.restaurants[restId], i = r.orders.findIndex((t) => t.id === id);
  r.ready.push(...r.orders.splice(i, 1).map((t) => ({ ...t, started: true, progress: t.pieces, quality: 0.6 })));
}

describe('save recovery', () => {
  it('retains the valid backup when the corrupt primary cannot be replaced', () => {
    const storage = new MemoryStorage();
    const state = createNewState();
    const backup = serialize(state);
    storage.setItem(BACKUP_KEY, backup);
    storage.setItem(SAVE_KEY, '{corrupt');
    const write = vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === SAVE_KEY) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      MemoryStorage.prototype.setItem.call(storage, key, value);
    });
    vi.spyOn(Date, 'now').mockReturnValue(state.lastSaved + 1_000);
    const originalTimestamp = state.lastSaved;
    state.cash += 100;

    expect(saveToStorage(state, storage)).toBe(false);
    expect(state.lastSaved).toBe(originalTimestamp);
    expect(storage.getItem(BACKUP_KEY)).toBe(backup);
    expect(loadFromStorage(storage)?.cash).toBe(state.cash - 100);

    write.mockRestore();
    expect(saveToStorage(state, storage)).toBe(true);
    expect(state.lastSaved).toBe(originalTimestamp + 1_000);
    expect(loadFromStorage(storage)?.cash).toBe(state.cash);
    expect(storage.getItem(BACKUP_KEY)).toBe(backup);
  });

  it.each([
    { player: { district: 'unknown' } },
    { staff: {} },
    { milestoneIndex: -1 },
    { restaurants: { asakusa_stand: { takeoutFrac: 1e30 } } },
  ])('tries the backup after parseable save corruption %j', (fields) => {
    const storage = new MemoryStorage();
    storage.setItem(BACKUP_KEY, serialize(createNewState()));
    storage.setItem(SAVE_KEY, JSON.stringify({ cash: 123, ...fields }));

    expect(loadFromStorage(storage)?.cash).toBe(createNewState().cash);
  });

  it('tries the backup when reading the primary raises an error', () => {
    const storage = new MemoryStorage();
    storage.setItem(BACKUP_KEY, serialize(createNewState()));
    vi.spyOn(storage, 'getItem').mockImplementation((key) => {
      if (key === SAVE_KEY) throw new DOMException('Storage access denied', 'SecurityError');
      return MemoryStorage.prototype.getItem.call(storage, key);
    });

    expect(loadFromStorage(storage)?.cash).toBe(createNewState().cash);
  });
});

describe('save snapshots', () => {
  it('repairs duplicate legacy ticket IDs and keeps old and new orders distinct', () => {
    const state = createNewState();
    const first = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 2, customerId: null });
    const second = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 3, customerId: null });
    cook(state, STAND, first.id);
    const legacy = JSON.parse(serialize(state));
    delete legacy.nextTicketId;
    legacy.restaurants[STAND].ready[0].id = second.id;

    const loaded = deserialize(JSON.stringify(legacy));
    const rest = loaded.restaurants[STAND];
    const newTicket = acceptOrder(loaded, STAND, { ...SALMON_ORDER, pieces: 4, customerId: 1 });
    expect(new Set([...rest.orders, ...rest.ready].map((ticket) => ticket.id)).size).toBe(3);
    cook(loaded, STAND, newTicket.id);
    expect(settle(loaded, STAND, newTicket.id, 5)?.paid).toBe(480);
    expect(rest.ready.map((ticket) => ticket.pieces)).toEqual([2]);
    expect(rest.orders.map((ticket) => ticket.pieces)).toEqual([3]);
    expect(deserialize(serialize(loaded)).nextTicketId).toBe(newTicket.id + 1);
  });

  it('timestamps an export without updating the active save timestamp', () => {
    const state = createNewState('料理人', '鮨の帝国');
    const originalTimestamp = state.lastSaved;
    const exportedAt = originalTimestamp + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(exportedAt);

    expect(importSave(exportSave(state))).toMatchObject({ player: state.player, lastSaved: exportedAt });
    expect(state.lastSaved).toBe(originalTimestamp);
  });
});

it('clears pending takeout (no sale, no cost) when the last chef leaves; visible guests keep their order', () => {
  const state = createNewState();
  state.lifetime.pieces = 60;
  state.cash = 100_000;
  const chef = makeCandidate(state, 'chef');
  state.candidates.push(chef);
  expect(hire(state, chef.id, STAND)).toBeNull();

  const ready = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 2, customerId: null });
  cook(state, STAND, ready.id);
  acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 3, customerId: null });
  const visible = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 4, customerId: 1 });
  expect(fire(state, chef.id)).toBeNull();
  const cash = state.cash;

  tickRestaurant(state, STAND, 1, 'asakusa');
  tickRestaurant(state, STAND, 1, 'asakusa');
  expect(state.lifetime.lost).toBe(2);
  expect(state.cash).toBe(cash);
  expect(state.restaurants[STAND].ready).toEqual([]);
  expect(state.restaurants[STAND].orders).toEqual([visible]);
});
