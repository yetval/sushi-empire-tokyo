// Keyboard + mouse state. `pressed()` is true only on the frame a key went down.
export class Input {
  private down = new Set<string>();
  private justDown = new Set<string>();
  dragX = 0; dragY = 0; wheel = 0;
  private dragging = false;
  enabled = true; // false while a modal UI is open

  constructor(el: HTMLElement, captureKeys: () => boolean) {
    addEventListener('keydown', (e) => {
      if (!captureKeys()) return;
      const t = e.target as HTMLElement;
      if (t?.closest?.('input,textarea,select') && e.code !== 'Escape') return;
      // keep native keyboard navigation inside UI windows; only claim these keys for the game itself
      if (!t?.closest?.('#ui-root .modal, #ui-root .cook, dialog, .dialog, [role=dialog]') && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
      if (!e.repeat && !this.down.has(e.code)) this.justDown.add(e.code);
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
    el.addEventListener('pointerdown', (e) => { this.dragging = true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', (e) => { this.dragging = false; el.releasePointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => { if (this.dragging) { this.dragX += e.movementX; this.dragY += e.movementY; } });
    // proportional zoom: one mouse-wheel notch ≈ 1 step; trackpads send many small deltas and stay gentle
    el.addEventListener('wheel', (e) => { this.wheel += Math.max(-3, Math.min(3, e.deltaY * (e.deltaMode === 1 ? 0.33 : 0.01))); e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  held(...codes: string[]): boolean { return this.enabled && codes.some((c) => this.down.has(c)); }
  pressed(...codes: string[]): boolean { return codes.some((c) => this.justDown.has(c)); }

  /** Call at end of frame. */
  endFrame(): void { this.justDown.clear(); this.dragX = 0; this.dragY = 0; this.wheel = 0; }
}
