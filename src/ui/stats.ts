// Statistics panel: canvas charts of the last 30 days + lifetime tiles. Self-contained; mounted by the management UI.
import { PROPERTIES, RECIPES } from '../core/data';
import { duration, exact, short, yen, yenExact } from '../core/format';
import type { DaySummary, GameState } from '../core/state';
import { bar, el, esc, stars } from './dom';

// Canvas can't read CSS vars cheaply; these mirror :root in styles.css.
const C = { sumi: '#1f1b17', sumi2: '#5b5047', sumi3: '#8b7d6f', shu: '#c8322a', ai: '#23385c', kin: '#c99a3c', matcha: '#4f7a35', paper: '#fffdf7' };
const FONT = '700 12px "Zen Maru Gothic", system-ui, sans-serif';

const CSS = `
.stats-chart { position: relative; height: 190px; background: ${C.paper}; border: 1.5px solid var(--sumi); border-radius: 3px; }
.stats-chart canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.stats-legend { display: inline-flex; gap: 10px; font: 700 12px var(--body); color: var(--sumi2); }
.stats-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; border-radius: 2px; }
.stats-legend i.ln { height: 3px; vertical-align: 2px; }
.stats-rec { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center; font-size: 13px; font-weight: 700; }
.stats-rec .bar { grid-column: 1 / -1; height: 7px; margin-bottom: 6px; }
table.stats-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
table.stats-tbl th { text-align: right; font-size: 12px; font-weight: 800; color: var(--sumi2); letter-spacing: .06em; padding: 4px; border-bottom: 1.5px solid var(--sumi); }
table.stats-tbl td { text-align: right; padding: 6px 4px; border-bottom: 1px dotted var(--sumi3); font-weight: 800; font-variant-numeric: tabular-nums; }
table.stats-tbl th:first-child, table.stats-tbl td:first-child { text-align: left; font-weight: 700; overflow-wrap: anywhere; }
`;

type Series = { label: string; color: string; vals: number[]; kind: 'bar' | 'line' };

/** Draws grouped bars + lines over day labels. Redraws on resize (also covers first layout after mounting). */
function chart(days: DaySummary[], series: Series[], aria: string, fmt: (n: number) => string): HTMLElement {
  const wrap = el('div', 'stats-chart');
  const cv = el('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', aria);
  wrap.append(cv);
  const draw = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const all = series.flatMap((s) => s.vals);
    // round the axis to a 1/2/5×10^n tick step so labels read cleanly
    const raw = (Math.max(1, ...all) - Math.min(0, ...all)) / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const tick = mag * ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10);
    const hi = Math.ceil(Math.max(1, ...all) / tick) * tick, lo = Math.floor(Math.min(0, ...all) / tick) * tick;
    const L = 52, R = 10, T = 12, B = 22, pw = w - L - R, ph = h - T - B;
    const y = (v: number) => T + ph * (1 - (v - lo) / (hi - lo));
    const step = pw / days.length;
    const x = (i: number) => L + step * (i + 0.5);
    g.font = FONT; g.textBaseline = 'middle';
    // grid + y labels
    for (let v = lo; v <= hi + tick / 2; v += tick) {
      const yy = Math.round(y(v)) + 0.5;
      g.strokeStyle = 'rgba(31,27,23,.1)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, yy); g.lineTo(w - R, yy); g.stroke();
      g.fillStyle = C.sumi2; g.textAlign = 'right'; g.fillText(fmt(v), L - 6, yy);
    }
    if (lo < 0) { g.strokeStyle = C.sumi; g.beginPath(); g.moveTo(L, Math.round(y(0)) + 0.5); g.lineTo(w - R, Math.round(y(0)) + 0.5); g.stroke(); }
    // x labels (thinned so they never overlap)
    g.textAlign = 'center'; g.fillStyle = C.sumi;
    const every = Math.ceil(28 / step);
    days.forEach((d, i) => { if ((days.length - 1 - i) % every === 0) g.fillText(`D${d.day}`, x(i), h - B / 2); });
    // bars
    const bars = series.filter((s) => s.kind === 'bar');
    const bw = Math.min(14, (step * 0.7) / Math.max(1, bars.length));
    bars.forEach((s, j) => {
      g.fillStyle = s.color;
      s.vals.forEach((v, i) => {
        const bx = x(i) - (bw * bars.length) / 2 + j * bw, y0 = y(0), y1 = y(v);
        g.fillRect(bx, Math.min(y0, y1), bw - 1, Math.abs(y1 - y0));
      });
    });
    // lines
    for (const s of series.filter((s) => s.kind === 'line')) {
      g.strokeStyle = g.fillStyle = s.color; g.lineWidth = 2.5; g.lineJoin = 'round';
      g.beginPath(); s.vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
      s.vals.forEach((v, i) => { g.beginPath(); g.arc(x(i), y(v), 2.8, 0, Math.PI * 2); g.fill(); });
    }
  };
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

const legend = (series: Series[]) => `<span class="stats-legend">${series.map((s) =>
  `<span><i class="${s.kind === 'line' ? 'ln' : ''}" style="background:${s.color}"></i>${s.label}</span>`).join('')}</span>`;

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Exact lifetime totals; re-patched on the management window's tick. */
export function ledgerHtml(s: GameState): string {
  const L = s.lifetime, profitAll = L.revenue - L.expenses;
  const fav = Object.entries(s.piecesByRecipe).filter(([id]) => RECIPES[id]).sort((a, b) => b[1] - a[1])[0];
  const value = Object.keys(s.restaurants).reduce((a, id) => a + PROPERTIES[id].price, 0) + s.cash;
  const row = (k: string, v: string, cls = '') => `<div class="ln"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  return `${row('Sushi pieces sold', exact(L.pieces))}${row('Total revenue', yenExact(L.revenue))}${row('Total expenses', yenExact(L.expenses))}
    ${row('Total profit', yenExact(profitAll), profitAll > 0 ? 'good' : profitAll < 0 ? 'bad' : '')}${row('Customers served', exact(L.customers))}${row('Customers lost', exact(L.lost), L.lost ? 'bad' : '')}
    ${row('Tips received', yenExact(L.tips))}${row('Largest single order', yenExact(L.bestOrder))}${row('Orders cooked by hand', exact(L.manualOrders))}
    ${row('Favorite recipe', fav ? `${esc(RECIPES[fav[0]].name)} (${exact(fav[1])})` : '—')}${row('Restaurants', String(Object.keys(s.restaurants).length))}
    ${row('Franchises', String(Object.values(s.cities).reduce((a, c) => a + c.franchises, 0)))}${row('Employees', String(s.staff.length))}
    ${row('Business value (property + cash)', yenExact(value))}${row('Days in business', String(s.day))}${row('Play time', duration(s.playTime))}`;
}

export function statsPanel(s: GameState): HTMLElement {
  if (!document.getElementById('stats-css')) {
    const st = el('style'); st.id = 'stats-css'; st.textContent = CSS; document.head.append(st);
  }
  const h = s.history.slice(-30);
  const root = el('div', 'stats-panel');

  // ---- lifetime tiles
  const topRec = Object.entries(s.piecesByRecipe).filter(([id, n]) => RECIPES[id] && n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const recMax = topRec[0]?.[1] ?? 1;
  const rests = Object.values(s.restaurants).sort((a, b) => b.revenue - a.revenue);
  root.innerHTML = `<h2>Statistics 統計</h2>
    <div class="ledger">${ledgerHtml(s)}</div>
    <div class="section" data-charts></div>
    <div class="grid g2 section">
      <div class="card"><h3>Top recipes</h3>${topRec.length ? `<div class="stats-rec">${topRec.map(([id, n]) =>
        `<span>${esc(RECIPES[id].name)}</span><span class="small">${exact(n)}</span>${bar(n / recMax, 'gold')}`).join('')}</div>`
        : '<div class="muted small">Nothing sold yet.</div>'}</div>
      <div class="card"><h3>Restaurants</h3><table class="stats-tbl"><tr><th>Location</th><th>Served</th><th>Revenue</th><th>Rating</th></tr>
        ${rests.map((r) => `<tr><td>${esc(r.name)}</td><td>${exact(r.served)}</td><td>${yenExact(r.revenue)}</td><td title="${r.reputation.toFixed(1)} stars">${stars(r.reputation)}</td></tr>`).join('')}</table></div>
    </div>`;

  // ---- charts
  const box = root.querySelector<HTMLElement>('[data-charts]')!;
  if (h.length < 2) {
    const d = h[0];
    box.innerHTML = `<div class="card muted">Daily charts appear once two business days have closed.${d
      ? ` Day ${d.day}: ${yenExact(d.revenue)} revenue, ${yenExact(d.expenses)} expenses, ${exact(d.pieces)} pieces, ${exact(d.customers)} guests.` : ''}</div>`;
    return root;
  }
  const rev = h.map((d) => d.revenue), exp = h.map((d) => d.expenses), pro = h.map((d) => d.revenue - d.expenses);
  const pcs = h.map((d) => d.pieces), cus = h.map((d) => d.customers);
  const span = `days ${h[0].day}–${h[h.length - 1].day}`;
  const best = h.reduce((a, d) => (d.revenue - d.expenses > a.revenue - a.expenses ? d : a));
  const money: Series[] = [
    { label: 'Revenue', color: C.ai, vals: rev, kind: 'bar' },
    { label: 'Expenses', color: C.shu, vals: exp, kind: 'bar' },
    { label: 'Profit', color: C.kin, vals: pro, kind: 'line' },
  ];
  const volume: Series[] = [
    { label: 'Pieces', color: C.matcha, vals: pcs, kind: 'line' },
    { label: 'Customers', color: C.ai, vals: cus, kind: 'line' },
  ];
  const h3 = (t: string, ser: Series[]) => el('h3', '', `${t} ${legend(ser)}`);
  box.append(
    h3(`Money · last ${h.length} days`, money),
    chart(h, money, `Revenue, expenses and profit for ${span}. Total revenue ${yenExact(sum(rev))}, expenses ${yenExact(sum(exp))}, profit ${yenExact(sum(pro))}. Best day ${best.day} with ${yenExact(best.revenue - best.expenses)} profit.`, yen),
    Object.assign(h3('Pieces & guests', volume), { style: 'margin-top:18px' }),
    chart(h, volume, `Pieces sold and customers per day for ${span}. ${exact(sum(pcs))} pieces and ${exact(sum(cus))} customers in total, averaging ${exact(sum(pcs) / h.length)} pieces and ${exact(sum(cus) / h.length)} customers a day.`, short),
  );
  return root;
}
