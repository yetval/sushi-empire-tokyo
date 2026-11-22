// Boot screen controller. The loader markup and critical CSS live inline in index.html so they paint
// before the main bundle (three.js etc.) finishes downloading; this module takes over once JS runs:
// real progress steps, rotating tips, fade-out, and the WebGL-unsupported / crash fallback page.

const TIPS = [
  'A chef plus a server runs a restaurant on its own, even while you explore.',
  'Hire a manager and a restaurant hires its own staff and sets its own prices.',
  'Watch the patience bubbles: guests who wait too long walk out.',
  'Higher prices mean better margins, but fewer guests. Ginza diners pay far more.',
  'Managers keep a restaurant earning while the tab is closed.',
  'An amber seal means a restaurant needs attention: usually one more chef or server.',
  'Press E at any restaurant you own to open its books, staff and upgrades.',
  'One million pieces is not the end. Chapter 2 opens franchises around the world.',
  'Finish all three daily requests to build a streak bonus.',
  'Each district has its own crowd: students in Shibuya, salarymen in Shinjuku.',
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let tipTimer = 0;
let tipIndex = Math.floor(Math.random() * TIPS.length);
function rotateTips(): void {
  const tip = $('boot-tip');
  if (!tip) return;
  tip.textContent = TIPS[tipIndex];
  tipTimer = window.setInterval(() => {
    tipIndex = (tipIndex + 1) % TIPS.length;
    tip.classList.add('swap');
    window.setTimeout(() => { tip.textContent = TIPS[tipIndex]; tip.classList.remove('swap'); }, reducedMotion ? 0 : 220);
  }, 4200);
}
rotateTips();

export function webglSupported(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch { return false; }
}

/** Move the bar to `pct` with a label, wait for `work` (bounded by `timeoutMs`), then let the browser paint. */
export async function step(pct: number, label: string, work?: Promise<unknown>, timeoutMs = 4000): Promise<void> {
  const fill = $('boot-fill'), text = $('boot-label'), bar = $('boot-bar');
  if (fill) { fill.style.animation = 'none'; fill.style.width = `${pct}%`; }
  if (bar) bar.setAttribute('aria-valuenow', String(pct));
  if (text) text.textContent = label;
  await nextFrame();
  if (work) await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Wait for the UI fonts so the title screen doesn't flash fallback glyphs. */
export function fontsReady(): Promise<unknown> {
  if (!document.fonts?.load) return Promise.resolve();
  return Promise.all(['500 1em "Zen Maru Gothic"', '700 1em "Zen Maru Gothic"', '400 1em "Dela Gothic One"'].map((f) => document.fonts.load(f)));
}

export function done(): void {
  clearInterval(tipTimer);
  const root = $('boot');
  if (!root) return;
  const fill = $('boot-fill');
  if (fill) fill.style.width = '100%';
  root.classList.add('out'); // pointer-events: none immediately, so the title screen is clickable during the fade
  root.setAttribute('aria-busy', 'false');
  window.setTimeout(() => root.remove(), reducedMotion ? 0 : 600);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Replace the loader with a friendly explanation. Without an error it's the "no WebGL" page. */
export function fail(err?: unknown): void {
  clearInterval(tipTimer);
  const root = $('boot');
  if (!root) return;
  root.classList.add('failed');
  root.setAttribute('aria-busy', 'false');
  const noGL = err === undefined;
  const panel = root.querySelector('.boot-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="boot-logo"><img src="${document.querySelector<HTMLLinkElement>('link[rel=icon][type="image/svg+xml"]')?.href ?? ''}" alt="" width="56" height="56"><div><b>SUSHI EMPIRE</b><span>TOKYO · 東京</span></div></div>
    <h1>${noGL ? 'Your browser can’t draw 3D right now' : 'Something went wrong while starting the game'}</h1>
    ${noGL ? `<p>Sushi Empire: Tokyo is a 3D game and needs <b>WebGL</b>. It’s built into every modern browser, but it can be switched off.</p>
    <ul>
      <li>Use an up-to-date <b>Chrome, Edge, Firefox or Safari</b>.</li>
      <li>Turn on <b>hardware acceleration</b> in your browser settings, then restart the browser.</li>
      <li>Update your graphics drivers, or try another device.</li>
    </ul>` : `<p>Try reloading the page. Your progress is saved in this browser and won’t be lost.</p>
    <details><summary>Technical details</summary><pre>${esc(String((err as Error)?.stack ?? err))}</pre></details>`}
    <p class="boot-actions"><button type="button" onclick="location.reload()">Try again</button></p>`;
}
