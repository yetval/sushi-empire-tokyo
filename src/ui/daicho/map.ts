// STUB — replaced by the map agent. Implements Part from ./shared.
import { Ctx, Part, Snap } from './shared';

export class MapView implements Part {
  readonly el = document.createElement('div');
  constructor(private ctx: Ctx) { this.el.className = 'dc-map'; this.el.textContent = 'MapView'; }
  render(_snap: Snap): void { void this.ctx; }
  destroy(): void { this.el.remove(); }
}
