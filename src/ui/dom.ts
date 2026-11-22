// Small DOM helpers shared by the UI modules.
import { audio } from '../audio/audio';
import { toast } from '../core/bus';
import { INGREDIENTS } from '../core/data';

export const root = () => document.getElementById('ui-root') ?? document.body;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Action failed: shake the element, error sound, red toast. */
export function fail(target: Element | null, msg: string): void {
  audio.sfx('error');
  if (target) { target.classList.remove('shake'); void (target as HTMLElement).offsetWidth; target.classList.add('shake'); }
  toast(msg, 'bad', '❌');
}

/** Run an action returning an error string (or null). Plays feedback. Returns true on success. */
export function run(target: Element | null, result: string | null, okSfx: Parameters<typeof audio.sfx>[0] = 'coin'): boolean {
  if (result) { fail(target, result); return false; }
  audio.sfx(okSfx);
  return true;
}

export const stars = (rep: number) => {
  let h = '';
  for (let i = 1; i <= 5; i++) h += rep >= i - 0.25 ? '★' : rep >= i - 0.75 ? '<span style="opacity:.6">★</span>' : '<span class="off">★</span>';
  return `<span class="stars">${h}</span>`;
};

export const bar = (frac: number, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%"></i></div>`;
export const pips = (n: number, max: number) => `<span class="pips">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;

/**
 * Click / input delegation: elements with data-act="name" (and optional data-arg) call handlers[name](arg, el).
 * Inputs with data-in="name" call inputs[name](value, el) on input/change.
 */
export function delegate(
  rootEl: HTMLElement,
  handlers: Record<string, (arg: string, el: HTMLElement) => void>,
  inputs: Record<string, (val: string, el: HTMLInputElement) => void> = {},
): void {
  rootEl.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t || !rootEl.contains(t) || (t as HTMLButtonElement).disabled) return;
    const h = handlers[t.dataset.act!];
    if (h) { e.stopPropagation(); h(t.dataset.arg ?? '', t); }
  });
  const onIn = (e: Event) => {
    const t = e.target as HTMLInputElement;
    const name = t.dataset?.in;
    if (!name) return;
    const h = inputs[name];
    const live = t.type === 'range' || t.type === 'text' || t.type === 'color';
    if (h && (e.type === 'input') === live) h(t.type === 'checkbox' ? String(t.checked) : t.value, t);
  };
  rootEl.addEventListener('input', onIn);
  rootEl.addEventListener('change', onIn);
}

let pointerDown = false;
addEventListener('pointerdown', () => { pointerDown = true; }, true);
addEventListener('pointerup', () => { pointerDown = false; }, true);

/** Replace innerHTML only if changed and the user is not interacting with a field inside. Keeps scroll. */
export function patch(container: HTMLElement, html: string, state: { last?: string }): void {
  if (state.last === html) return;
  const a = document.activeElement as HTMLInputElement | null;
  if (a && container.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && (pointerDown || !['range', 'checkbox'].includes(a.type))) return;
  const scroller = container.closest('.tab-body, .modal-body') as HTMLElement | null;
  const top = scroller?.scrollTop ?? 0;
  const f = a && container.contains(a) ? (a as HTMLElement) : null;
  const key = f?.dataset.act ? `[data-act="${f.dataset.act}"]${f.dataset.arg !== undefined ? `[data-arg="${CSS.escape(f.dataset.arg)}"]` : ''}` : null;
  container.innerHTML = html;
  state.last = html;
  if (scroller) scroller.scrollTop = top;
  if (key) {
    const same = container.querySelector<HTMLElement>(key);
    // never fall back to an arbitrary action button (Enter could hire/buy by accident): park focus on the panel
    if (same) same.focus({ preventScroll: true });
    else {
      const panel = container.closest<HTMLElement>('.tab-body, .modal-body') ?? container;
      if (panel.tabIndex < 0 && !panel.hasAttribute('tabindex')) panel.tabIndex = -1; // focusable, so focus never drops to <body>
      panel.focus();
    }
  }
}

/** Ingredient glyph: a drawn nori sheet for nori (its emoji reads as a placeholder), emoji otherwise. */
export const ingIcon = (id: string) => (id === 'nori' ? '<i class="nori-sheet" role="img" aria-label="Nori"></i>' : INGREDIENTS[id as keyof typeof INGREDIENTS]?.emoji ?? '');
