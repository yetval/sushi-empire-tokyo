import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

// kit.ts touches the DOM at import; stub the static-geometry Builder and keep a seeded rng.
vi.mock('../src/world/kit', () => {
  const geo = () => new THREE.BufferGeometry();
  const rng = (s: number) => () => ((s = (s * 16807 + 1) % 2147483647) / 2147483647);
  return { Builder: class { add() { return this; } collide() { return this; } }, G: { cyl: geo, rbox: geo, box: geo }, rng };
});
vi.setConfig({ testTimeout: 20_000 }); // building the eight vehicle models is CPU-heavy on a loaded machine

import { Builder } from '../src/world/kit';
import { Traffic } from '../src/world/traffic';

const far = new THREE.Vector3(0, 100, 0);
const front = (v: Traffic['vehicles'][number]) => v.pos + (v.lane.dir * v.spec.len) / 2;

describe('traffic', () => {
  it('cycles signals and never shows green both ways', () => {
    const T = new Traffic(new Builder() as never, 'shibuya');
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      T.update(0.1, 0, far);
      const x = T.signal('x'), z = T.signal('z');
      seen.add(x + z);
      expect(x !== 'r' && z !== 'r').toBe(false);
      if (x !== 'r') expect(T.pedSignal('x')).toBe('r');
    }
    expect(seen).toContain('gr'); expect(seen).toContain('rg'); expect(seen).toContain('rr');
  });

  it('holds vehicles at a red stop line and stops for the player in the lane', () => {
    const T = new Traffic(new Builder() as never, 'shibuya');
    while (T.signal('x') !== 'r' || T.signal('z') !== 'g') T.update(0.1, 0, far);
    const east = T.vehicles.filter((v) => v.active && !v.waiting && v.lane.axis === 'x' && v.lane.dir === 1 && front(v) < -11.6 - 0.5);
    expect(east.length).toBeGreaterThan(0);
    for (let i = 0; i < 80 && T.signal('x') === 'r'; i++) T.update(0.1, 0, far);
    for (const v of east) if (!v.waiting) expect(front(v)).toBeLessThan(-11.6 + 0.5);

    const v = T.vehicles.find((o) => o.active && !o.waiting && o.lane.axis === 'x' && o.v > 3)!;
    const p = new THREE.Vector3(front(v) + v.lane.dir * 8, 0, v.lane.c);
    for (let i = 0; i < 60; i++) T.update(0.05, 0, p);
    expect(v.v).toBeLessThan(0.2);
    expect((p.x - front(v)) * v.lane.dir).toBeGreaterThan(0.3);
  });
});
