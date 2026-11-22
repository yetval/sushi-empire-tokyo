import { describe, expect, it } from 'vitest';
import { GameState, createNewState } from '../src/core/state';
import { StoryNpcId, checkStoryBeat, dialogueFor } from '../src/core/story';

const NPCS: StoryNpcId[] = ['kenji', 'mika', 'sato', 'ryo', 'aoki'];

function at(pieces: number, tweak: (s: GameState) => void = () => {}): GameState {
  const s = createNewState();
  s.lifetime.pieces = pieces;
  tweak(s);
  return s;
}

const variety: [string, GameState][] = [
  ['fresh', createNewState()],
  ['night', at(0, (s) => { s.minute = 23 * 60; })],
  ['early morning', at(300, (s) => { s.minute = 6 * 60; })],
  ['festival', at(800, (s) => { s.event = { id: 'festival', endsDay: 2 }; })],
  ['critic', at(3000, (s) => { s.event = { id: 'critic', endsDay: 2 }; })],
  ['shortage', at(1500, (s) => { s.event = { id: 'shortage_tuna', endsDay: 2 }; })],
  ['rain', at(50, (s) => { s.event = { id: 'rain', endsDay: 2 }; })],
  ['buyout', at(20_000, (s) => { delete s.rivals.kaiten.asakusa; s.districts.push('shibuya'); })],
  ['all buyouts', at(5e6, (s) => { s.rivals = { kaiten: {}, maguro: {}, golden: {} }; })],
  ['chapter2', at(1_000_000, (s) => { s.flags.chapter2 = true; s.cities.tokyo = { open: true, franchises: 0 }; })],
  ['late game', at(2e8, (s) => { s.flags.chapter2 = true; s.districts = ['asakusa', 'shibuya', 'shinjuku', 'ginza']; s.cities = { tokyo: { open: true, franchises: 5 }, osaka: { open: true, franchises: 2 } }; })],
];

describe('dialogueFor', () => {
  it.each(variety)('every NPC has short lines (%s)', (_, s) => {
    for (const id of NPCS) {
      const lines = dialogueFor(id, s);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) { expect(l.length).toBeGreaterThan(0); expect(l.length).toBeLessThanOrEqual(140); }
    }
  });

  it('reacts to progress', () => {
    expect(dialogueFor('ryo', variety[7][1]).join(' ')).toContain('Asakusa');
    expect(dialogueFor('kenji', variety[0][1])).not.toEqual(dialogueFor('kenji', variety[9][1]));
  });
});

describe('checkStoryBeat', () => {
  it('fresh state has no beat', () => {
    expect(checkStoryBeat(createNewState())).toBeNull();
  });

  it('never fires a beat twice across a progression', () => {
    const s = createNewState();
    const seen: string[] = [];
    const drain = () => { for (let b = checkStoryBeat(s); b; b = checkStoryBeat(s)) seen.push(b.id); };
    const steps: ((s: GameState) => void)[] = [
      (s) => { s.lifetime.pieces = 600; s.flags.boughtOnce = true; },
      (s) => { s.lifetime.pieces = 1_200; },
      (s) => { s.event = { id: 'critic', endsDay: 9 }; },
      (s) => { s.event = null; s.restaurants.x = { ...s.restaurants.asakusa_stand, id: 'x' }; s.lifetime.pieces = 6_000; },
      (s) => { delete s.rivals.kaiten.asakusa; },
      (s) => { s.districts.push('ginza'); s.rivals.kaiten = {}; },
      (s) => { s.lifetime.pieces = 1_000_000; s.flags.chapter2 = true; },
      (s) => { s.cities = { tokyo: { open: true, franchises: 0 }, osaka: { open: true, franchises: 0 } }; },
      (s) => { s.lifetime.pieces = 20_000_000; },
    ];
    for (const step of steps) { step(s); drain(); drain(); }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(10);
    for (const id of seen) expect(s.flags['story_' + id]).toBe(true);
  });

  it('returns one beat per call, Ryo first at 1,000 pieces', () => {
    const s = at(1_000);
    const b = checkStoryBeat(s);
    expect(b?.id).toBe('ryo_rival');
    expect(b?.speaker).toBe('Ryo Tanaka');
    expect(checkStoryBeat(s)).toBeNull();
  });
});
