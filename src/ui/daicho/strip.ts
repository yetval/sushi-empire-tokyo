// STUB — replaced by the strip agent. Implements Part from ./shared.
import { Ctx, Part, Snap } from './shared';

export class Strip implements Part {
  readonly el = document.createElement('div');
  constructor(private ctx: Ctx) { this.el.className = 'dc-strip'; this.el.textContent = 'Strip'; }
  render(_snap: Snap): void { void this.ctx; }
  destroy(): void { this.el.remove(); }
}
