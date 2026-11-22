import { describe, expect, it, vi } from 'vitest';
import { restaurantKPIs } from '../src/core/empire';
import { createNewState } from '../src/core/state';
import { ICON_IDS, icon, type IconId } from '../src/ui/icons';
import { crew, health, overlayBand, Store } from '../src/ui/daicho/shared';

describe('inline icons', () => {
  it('renders every registered icon as accessible SVG markup', () => {
    expect(ICON_IDS.length).toBeGreaterThan(0);
    for (const id of ICON_IDS) {
      const svg = icon(id, 20, { title: `${id} icon` });
      expect(svg).toContain(`<svg class="ico ico-glyph ico-${id}" width="20"`);
      expect(svg).toContain('role="img"');
      expect(svg).toContain(`<title>${id} icon</title>`);
    }
  });

  it('escapes accessible labels and hides decorative marks from assistive tech', () => {
    const titled = icon('fish', 18, { title: 'Fish & chips <"special">' });
    expect(titled).toContain('aria-label="Fish &amp; chips &lt;&quot;special&quot;&gt;"');
    expect(titled).toContain('<title>Fish &amp; chips &lt;&quot;special&quot;&gt;</title>');
    expect(icon('fish')).toContain('aria-hidden="true"');
  });

  it('uses the seal palette and a visible fallback for blank registered glyphs', () => {
    const seal = icon('fish', 18, { variant: 'seal' });
    expect(seal).toContain('ico-seal');
    expect(seal).toContain('fill="#b82d25"');
    expect(icon('missing' as IconId)).toContain('<circle cx="12" cy="12" r="3" fill="currentColor"/>');
    for (const id of ICON_IDS) {
      const svg = icon(id);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    }
  });
});

describe('daicho shared state and KPI helpers', () => {
  it('notifies only interested subscribers and ignores unchanged values', () => {
    const store = new Store();
    const region = vi.fn();
    const hover = vi.fn();
    const all = vi.fn();
    store.on(['region'], region);
    const off = store.on(['hover'], hover);
    store.on(null, all);

    store.set({ region: 'japan' });
    expect(region).toHaveBeenCalledWith(['region']);
    expect(hover).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(1);

    store.set({ region: 'japan' });
    expect(region).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);

    off();
    store.set({ hover: 'asakusa_stand' });
    expect(hover).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledWith(['hover']);
  });

  it('combines chefs and servers in crew counts, and explains health in priority order', () => {
    const kpi = restaurantKPIs(createNewState())[0];
    expect(crew(kpi)).toEqual([0, kpi.staff.chef[1] + kpi.staff.server[1]]);
    expect(health(kpi)).toEqual({ band: 'act', why: 'No chef' });

    const staffed = structuredClone(kpi);
    staffed.automated = true;
    staffed.health = 'warn';
    staffed.load = 1.3;
    staffed.staff.chef = [1, 1];
    staffed.staff.server = [0, 1];
    expect(health(staffed)).toEqual({ band: 'watch', why: 'Turning guests away' });

    staffed.load = 0.8;
    expect(health(staffed).why).toBe('No server');
    staffed.staff.server = [1, 1];
    expect(health(staffed).why).toBe('Needs a look');
  });

  it('maps overlay threshold edges consistently', () => {
    const kpi = restaurantKPIs(createNewState())[0];
    expect(overlayBand({ ...kpi, profitYesterday: null, revToday: 4_999 }, 'profit')).toEqual({ band: 'watch', label: 'new' });
    expect(overlayBand({ ...kpi, profitYesterday: 5_000 }, 'profit').band).toBe('good');
    expect(overlayBand({ ...kpi, load: 0.45 }, 'load').band).toBe('good');
    expect(overlayBand({ ...kpi, load: 1 }, 'load').band).toBe('good');
    expect(overlayBand({ ...kpi, load: 1.25 }, 'load').band).toBe('watch');
    expect(overlayBand({ ...kpi, load: 0.44 }, 'load').band).toBe('watch');
    expect(overlayBand({ ...kpi, load: 1.26 }, 'load').band).toBe('act');
    expect(overlayBand({ ...kpi, stars: 2 }, 'stars').band).toBe('watch');
    expect(overlayBand({ ...kpi, stars: 1.99 }, 'stars').band).toBe('act');
  });
});
