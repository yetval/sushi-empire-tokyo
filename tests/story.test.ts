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
  ['staffed', at(800, (s) => { s.staff.push({ id: 1, name: 'A', role: 'chef', skill: 1, xp: 0, wage: 900, restaurant: 'asakusa_stand', look: s.player.avatar }); })],
  ['shibuya', at(20_000, (s) => { s.districts.push('shibuya'); })],
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
    expect(dialogueFor('kenji', variety[0][1]).join(' ')).toContain('Hire a chef');
    expect(dialogueFor('kenji', variety[3][1])).not.toEqual(dialogueFor('kenji', variety[0][1]));
    expect(dialogueFor('ryo', variety[4][1]).join(' ')).toContain('Shibuya');
    expect(dialogueFor('kenji', variety[0][1])).not.toEqual(dialogueFor('kenji', variety[5][1]));
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
      (s) => { s.lifetime.pieces = 600; },
      (s) => { s.lifetime.pieces = 1_200; },
      (s) => { s.lifetime.pieces = 2_500; },
      (s) => { s.restaurants.x = { ...s.restaurants.asakusa_stand, id: 'x' }; s.lifetime.pieces = 6_000; },
      (s) => { s.districts.push('ginza'); },
      (s) => { s.lifetime.pieces = 1_000_000; s.flags.chapter2 = true; },
      (s) => { s.cities = { tokyo: { open: true, franchises: 0 }, osaka: { open: true, franchises: 0 } }; },
      (s) => { s.lifetime.pieces = 20_000_000; },
    ];
    for (const step of steps) { step(s); drain(); drain(); }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(9);
    for (const id of seen) expect(s.flags['story_' + id]).toBe(true);
  });

  it('returns one beat per call, Ryo first at 1,000 pieces', () => {
    const s = at(1_000);
    const b = checkStoryBeat(s);
    expect(b?.id).toBe('ryo_rival');
    expect(b?.speaker).toBe('Ryo Tanaka');
    expect(checkStoryBeat(s)?.id).toBe('mika_regular');
    expect(checkStoryBeat(s)).toBeNull();
  });
});
