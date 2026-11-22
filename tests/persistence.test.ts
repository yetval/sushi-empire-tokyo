import { afterEach, describe, expect, it, vi } from 'vitest';
import { buyout, fire, hire } from '../src/core/actions';
import { acceptOrder, finishManual, makeCandidate, settle, tickRestaurant } from '../src/core/sim';
import {
  SAVE_KEY, createNewState, deserialize, exportSave, importSave, loadFromStorage, saveToStorage, serialize,
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

    expect(loadFromStorage(storage)?.cash).toBe(5_000);
  });

  it('tries the backup when reading the primary raises an error', () => {
    const storage = new MemoryStorage();
    storage.setItem(BACKUP_KEY, serialize(createNewState()));
    vi.spyOn(storage, 'getItem').mockImplementation((key) => {
      if (key === SAVE_KEY) throw new DOMException('Storage access denied', 'SecurityError');
      return MemoryStorage.prototype.getItem.call(storage, key);
    });

    expect(loadFromStorage(storage)?.cash).toBe(5_000);
  });
});

describe('save snapshots', () => {
  it('repairs duplicate legacy ticket IDs and keeps old and new orders distinct', () => {
    const state = createNewState();
    const first = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 2, customerId: null });
    const second = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 3, customerId: null });
    if (first === 'nostock' || second === 'nostock') throw new Error('Fixture requires salmon');
    expect(finishManual(state, STAND, first.id, 1)).toBe(true);
    const legacy = JSON.parse(serialize(state));
    delete legacy.nextTicketId;
    legacy.restaurants[STAND].ready[0].id = second.id;

    const loaded = deserialize(JSON.stringify(legacy));
    const rest = loaded.restaurants[STAND];
    const newTicket = acceptOrder(loaded, STAND, { ...SALMON_ORDER, pieces: 4, customerId: 1 });
    if (newTicket === 'nostock') throw new Error('Fixture requires salmon');
    expect(new Set([...rest.orders, ...rest.ready].map((ticket) => ticket.id)).size).toBe(3);
    expect(finishManual(loaded, STAND, newTicket.id, 1)).toBe(true);
    expect(settle(loaded, STAND, newTicket.id, 5)?.paid).toBe(480);
    expect(rest.ready.map((ticket) => ticket.pieces)).toEqual([2]);
    expect(rest.orders.map((ticket) => ticket.pieces)).toEqual([3]);
    expect(deserialize(serialize(loaded)).nextTicketId).toBe(newTicket.id + 1);
  });

  it('keeps a rival buyout after reload while retaining other markets', () => {
    const storage = new MemoryStorage();
    const state = createNewState();
    state.flags.chapter2 = true;
    state.cash = 1e9;
    expect(buyout(state, 'kaiten', 'asakusa')).toBeNull();

    expect(saveToStorage(state, storage)).toBe(true);
    const loaded = loadFromStorage(storage);
    expect(loaded?.rivals.kaiten.asakusa).toBeUndefined();
    expect(loaded?.rivals.kaiten.shibuya).toBe(state.rivals.kaiten.shibuya);
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

it('clears stranded takeout and refunds their ingredients when the last server leaves', () => {
  const state = createNewState();
  state.lifetime.pieces = 60;
  state.cash = 100_000;
  const chef = makeCandidate(state, 'chef');
  const server = makeCandidate(state, 'server');
  state.candidates.push(chef, server);
  expect(hire(state, chef.id, STAND)).toBeNull();
  expect(hire(state, server.id, STAND)).toBeNull();

  const ready = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 2, customerId: null });
  if (ready === 'nostock') throw new Error('Fixture requires salmon');
  expect(finishManual(state, STAND, ready.id, 1)).toBe(true);
  acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 3, customerId: null });
  const visible = acceptOrder(state, STAND, { ...SALMON_ORDER, pieces: 4, customerId: 1, manualOnly: true });
  expect(fire(state, server.id)).toBeNull();
  const cash = state.cash;

  tickRestaurant(state, STAND, 1, 'asakusa');
  tickRestaurant(state, STAND, 1, 'asakusa');
  expect(state.inventory.salmon).toBe(15);
  expect(state.inventory.rice).toBe(30);
  expect(state.lifetime.lost).toBe(2);
  expect(state.cash).toBe(cash);
  expect(state.restaurants[STAND].ready).toEqual([]);
  expect(state.restaurants[STAND].orders).toEqual([visible]);
});
