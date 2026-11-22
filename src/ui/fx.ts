// UI juice: number rolls, press punches, coin bursts, floating +¥ text. DOM + CSS only (keyframes live in base.css),
// every effect cleans itself up, and all of it is instant / a no-op under prefers-reduced-motion.

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const layer = (): HTMLElement => document.getElementById('ui-root') ?? document.body;
const center = (t: Element | { x: number; y: number }): { x: number; y: number } => {
  if (!(t instanceof Element)) return t;
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

type Roll = { from: number; to: number; t0: number; ms: number; raf: number; shown: number };
const rolls = new WeakMap<HTMLElement, Roll>();
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Tween el's text from the number it currently shows to `to`. Call again mid-tween to re-target smoothly
 *  (it continues from the value on screen). Same target = no-op; first call just sets the text. */
export function rollNumber(el: HTMLElement, to: number, format: (n: number) => string = String, ms = 600): void {
  const cur = rolls.get(el);
  if (cur && cur.to === to) return;
  if (cur) cancelAnimationFrame(cur.raf);
  const from = cur ? cur.shown : Number(el.dataset.n ?? NaN);
  el.dataset.n = String(to);
  if (!Number.isFinite(from) || from === to || reduced() || ms <= 0) {
    rolls.delete(el);
    el.textContent = format(to);
    return;
  }
  const r: Roll = { from, to, t0: performance.now(), ms, raf: 0, shown: from };
  const step = (now: number) => {
    const k = Math.min(1, (now - r.t0) / r.ms);
    r.shown = k >= 1 ? r.to : r.from + (r.to - r.from) * easeOut(k);
    el.textContent = format(k >= 1 ? r.to : Math.round(r.shown));
    if (k < 1) r.raf = requestAnimationFrame(step);
    else rolls.delete(el);
  };
  rolls.set(el, r);
  r.raf = requestAnimationFrame(step);
}

/** Restartable scale-punch (press feedback on purchases). */
export function punch(el: HTMLElement): void {
  if (reduced()) return;
  el.classList.remove('punch');
  void el.offsetWidth; // restart the animation
  el.classList.add('punch');
  el.addEventListener('animationend', () => el.classList.remove('punch'), { once: true });
}

/** Mon coins (with a few hanko dots and paper glints) burst out of an element or a screen point. */
export function coinBurst(target: Element | { x: number; y: number }, n = 10): void {
  if (reduced()) return;
  const { x, y } = center(target);
  const root = layer();
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'fx-coin' + (i % 5 === 4 ? ' seal' : i % 5 === 2 ? ' glint' : '');
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9; // upward fan, ±80°
    const d = 48 + Math.random() * 52;
    p.style.cssText = `left:${x}px;top:${y}px;--tx:${(Math.cos(a) * d).toFixed(1)}px;--ty:${(Math.sin(a) * d).toFixed(1)}px;--rot:${Math.round((Math.random() - 0.5) * 540)}deg;--dur:${(0.7 + Math.random() * 0.3).toFixed(2)}s`;
    p.addEventListener('animationend', () => p.remove(), { once: true });
    root.append(p);
    setTimeout(() => p.remove(), 1500); // belt and braces if animationend never fires (hidden tab)
  }
}

/** Floating text (e.g. "+¥1,200") that rises off an element and fades. */
export function floatText(target: Element | { x: number; y: number }, text: string, kind: 'good' | 'bad' | 'gold' = 'good'): void {
  if (reduced()) return;
  const { x, y } = center(target);
  const f = document.createElement('div');
  f.className = `fx-float ${kind}`;
  f.textContent = text;
  f.setAttribute('aria-hidden', 'true');
  f.style.left = `${x}px`;
  f.style.top = `${y - 12}px`;
  f.addEventListener('animationend', () => f.remove(), { once: true });
  layer().append(f);
  setTimeout(() => f.remove(), 1600);
}
