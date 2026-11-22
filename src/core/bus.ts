import type { CustomerType } from './data';
// Tiny typed event bus so the sim can notify UI/audio/world without importing them.
export interface BusEvents {
  toast: { text: string; kind?: 'info' | 'good' | 'bad' | 'gold'; icon?: string };
  money: { amount: number; x?: number; y?: number; z?: number }; // floating yen at world pos
  sale: { restaurant: string; pieces: number; paid: number; tip: number; satisfaction: number; customerId: number | null; customerType: CustomerType; recipe: string; waitSec: number | null };
  hire: { role: string };
  train: { role: string };
  campaign: { id: string };
  milestone: { index: number; title: string; pieces: number; text: string };
  million: Record<string, never>;
  upgrade: { restaurant: string; upgrade: string; level: number };
  purchase: { what: string };
  dayEnd: { day: number; revenue: number; expenses: number; pieces: number; customers: number };
  event: { id: string; name: string; desc: string; emoji: string };
  customerLeft: { restaurant: string; customerId: number | null; reason: 'patience' | 'nostock' | 'closed' };
  ticketReady: { restaurant: string; ticketId: number };
  restaurantsChanged: Record<string, never>; // ownership / upgrades / staff changed → rebuild visuals
  offline: { seconds: number; pieces: number; revenue: number; expenses: number };
}

type Handler<T> = (e: T) => void;
const handlers: { [K in keyof BusEvents]?: Handler<BusEvents[K]>[] } = {};

export function on<K extends keyof BusEvents>(k: K, h: Handler<BusEvents[K]>): () => void {
  (handlers[k] ??= [] as any).push(h);
  return () => { handlers[k] = (handlers[k] as any).filter((x: any) => x !== h); };
}
export function emit<K extends keyof BusEvents>(k: K, e: BusEvents[K]): void {
  for (const h of handlers[k] ?? []) h(e);
}
export const toast = (text: string, kind: BusEvents['toast']['kind'] = 'info', icon?: string) => emit('toast', { text, kind, icon });
