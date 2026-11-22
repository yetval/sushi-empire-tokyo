import { describe, expect, it, vi } from 'vitest';
import { AREAS, PROPERTY_IDS, PROPERTIES } from '../src/core/data';

vi.mock('../src/world/kit', () => ({ Atlas: class {}, Builder: class {}, G: {} }));

import { placeArt } from '../src/world/place-art';

describe('restaurant place art', () => {
  it('provides a complete, usable identity for every property', () => {
    const walkableProperties = PROPERTY_IDS.filter((id) => AREAS[PROPERTIES[id].district].walkable);
    for (const id of walkableProperties) {
      const place = placeArt(id);
      expect(place, `missing place art for ${id}`).toBeDefined();
      expect(place!.nameplate.length).toBeGreaterThan(0);
      expect(place!.caption.length).toBeGreaterThan(0);
      expect(place!.print.length).toBeGreaterThan(0);
      for (const color of [place!.ink, place!.trim, place!.floor]) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(placeArt('unknown_property')).toBeUndefined();
    for (const id of PROPERTY_IDS.filter((id) => !AREAS[PROPERTIES[id].district].walkable)) {
      expect(placeArt(id)).toBeUndefined();
    }
  });
});
