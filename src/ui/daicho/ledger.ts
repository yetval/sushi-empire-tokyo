// STUB — replaced by the ledger agent. Implements Part from ./shared.
import { Ctx, Part, Snap } from './shared';

export class Ledger implements Part {
  readonly el = document.createElement('div');
  constructor(private ctx: Ctx) { this.el.className = 'dc-ledger'; this.el.textContent = 'Ledger'; }
  render(_snap: Snap): void { void this.ctx; }
  destroy(): void { this.el.remove(); }
}
