// Daichō 台帳 — the Empire / City management dashboard. Mounted full-size inside the Manage window by the host UI.
// Layout: lacquer KPI strip (top) · washi map (left) | ledger (right) · alert rail (bottom).
// The shell owns the snapshot cadence and altitude keyboard (Esc climbs City → Empire); parts own their own DOM.
import { UIHost } from '../host';
import { AlertRail } from './alerts';
import './daicho.css';
import { Ledger } from './ledger';
import { MapView } from './map';
import { Ctx, Part, SNAP_EVERY, Snap, Store, buildSnap } from './shared';
import { Strip } from './strip';

export class Daicho {
  readonly el: HTMLElement;
  private readonly ctx: Ctx;
  private readonly parts: Part[];
  private acc = 0;
  private last!: Snap;
  private readonly contain = (e: Event) => e.stopPropagation();
  private readonly onKey = (e: KeyboardEvent) => {
    // game.ts ignores 1/2/3 while Manage is open (input disabled), so the dashboard handles speed keys itself
    const t = e.target as HTMLElement;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !t.closest('input, textarea, select') && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault();
      this.ctx.host.setPaused(false);
      this.ctx.host.setSpeed(({ '1': 1, '2': 2, '3': 4 } as const)[e.key]);
      this.rebuild();
      return;
    }
    if (e.key === 'Escape' && this.ctx.store.st.area) {
      // climb City → Empire instead of letting Manage close
      e.preventDefault(); e.stopPropagation();
      this.ctx.store.set({ area: null });
    }
  };

  constructor(host: UIHost, opts: { openRestaurant(restId: string): void; buyLot(propId: string): void }) {
    this.el = document.createElement('section');
    this.el.className = 'dc-root';
    this.el.setAttribute('aria-label', 'Daichō — empire ledger');
    const store = new Store();
    this.ctx = { host, store, opts, refresh: () => this.rebuild(), snap: () => this.last };
    this.last = buildSnap(host.s);
    const strip = new Strip(this.ctx), map = new MapView(this.ctx), ledger = new Ledger(this.ctx), rail = new AlertRail(this.ctx);
    this.parts = [strip, map, ledger, rail];
    strip.el.classList.add('dc-a-strip'); map.el.classList.add('dc-a-map'); ledger.el.classList.add('dc-a-ledger'); rail.el.classList.add('dc-a-rail');
    this.el.append(strip.el, map.el, ledger.el, rail.el);
    this.el.addEventListener('keydown', this.onKey);
    // The host's delegated handlers (Manage: data-act/data-in on its body) must never see our events:
    // e.g. a map lot's data-act="buy" was also firing Manage's ingredient-buy. Our own handlers live below this root.
    for (const t of ['click', 'input', 'change'] as const) this.el.addEventListener(t, this.contain);
    for (const p of this.parts) p.render(this.last);
  }

  /** Called every frame while visible. Rebuilds the snapshot at most every SNAP_EVERY seconds. */
  update(dt: number): void {
    this.acc += dt;
    if (this.acc >= SNAP_EVERY) this.rebuild();
  }

  private rebuild(): void {
    this.acc = 0;
    this.last = buildSnap(this.ctx.host.s);
    for (const p of this.parts) p.render(this.last);
  }

  destroy(): void {
    this.el.removeEventListener('keydown', this.onKey);
    for (const t of ['click', 'input', 'change'] as const) this.el.removeEventListener(t, this.contain);
    for (const p of this.parts) p.destroy();
    this.el.remove();
  }
}
