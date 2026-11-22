// STUB — replaced by the alerts agent. Implements Part from ./shared.
import { Ctx, Part, Snap } from './shared';

export class AlertRail implements Part {
  readonly el = document.createElement('div');
  constructor(private ctx: Ctx) { this.el.className = 'dc-alerts'; this.el.textContent = 'AlertRail'; }
  render(_snap: Snap): void { void this.ctx; }
  destroy(): void { this.el.remove(); }
}
