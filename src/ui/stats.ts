// Statistics panel: canvas charts of the last 30 days + lifetime ledger. Mounted by the management UI; styles live in progress.css.
import { PROPERTIES, RECIPES } from '../core/data';
import { duration, exact, short, yen, yenExact } from '../core/format';
import type { DaySummary, GameState } from '../core/state';
import { el, esc, stars } from './dom';
import { icon } from './icons';

// Canvas can't read CSS vars cheaply; these mirror the warm :root tokens in base.css.
const C = { sumi: '#1f1b17', sumi2: '#5b5047', shu: '#b82d25', wood: '#7b4d2c', kin: '#d9a83f', matcha: '#4d7d33', paper: '#fcf7ec' };
const FONT = '800 12px "Zen Maru Gothic", system-ui, sans-serif';

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
    const L = 64, R = 14, T = 14, B = 26, pw = w - L - R, ph = h - T - B;
    const y = (v: number) => T + ph * (1 - (v - lo) / (hi - lo));
    const step = pw / days.length;
    const x = (i: number) => L + step * (i + 0.5);
    g.font = FONT; g.textBaseline = 'middle';
    // grid + y labels (outside the plot, left of L)
    for (let v = lo; v <= hi + tick / 2; v += tick) {
      const yy = Math.round(y(v)) + 0.5;
      g.strokeStyle = 'rgba(31,27,23,.12)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, yy); g.lineTo(w - R, yy); g.stroke();
      g.fillStyle = C.sumi2; g.textAlign = 'right'; g.fillText(fmt(v), L - 8, yy);
    }
    g.strokeStyle = C.sumi; g.lineWidth = 2;
    g.beginPath(); g.moveTo(L, Math.round(y(0)) + 0.5); g.lineTo(w - R, Math.round(y(0)) + 0.5); g.stroke();
    // x labels (thinned so they never overlap)
    g.textAlign = 'center'; g.fillStyle = C.sumi;
    const every = Math.ceil(30 / step);
    days.forEach((d, i) => { if ((days.length - 1 - i) % every === 0) g.fillText(`D${d.day}`, x(i), h - B / 2); });
    // bars: chunky, ink-outlined
    const bars = series.filter((s) => s.kind === 'bar');
    const bw = Math.max(3, Math.min(days.length < 7 ? 40 : 22, (step * 0.72) / Math.max(1, bars.length)));
    g.lineWidth = 1.5; g.strokeStyle = C.sumi;
    bars.forEach((s, j) => {
      g.fillStyle = s.color;
      s.vals.forEach((v, i) => {
        const bx = x(i) - (bw * bars.length) / 2 + j * bw, y0 = y(0), y1 = y(v);
        const top = Math.min(y0, y1), hh = Math.abs(y1 - y0);
        g.fillRect(bx, top, bw - 1, hh);
        if (hh > 2 && bw > 5) g.strokeRect(bx + 0.75, top + 0.75, bw - 2.5, hh - 1.5);
        // short histories have room to print each value, which keeps tiny bars readable
        if (days.length < 7) { g.fillStyle = C.sumi; g.textAlign = 'center'; g.fillText(fmt(v), bx + bw / 2, v >= 0 ? top - 9 : top + hh + 9); g.fillStyle = s.color; }
      });
    });
    // lines: ink casing under a coloured stroke, dot per day
    for (const s of series.filter((s) => s.kind === 'line')) {
      g.lineJoin = 'round'; g.lineCap = 'round';
      const path = () => { g.beginPath(); s.vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); };
      g.strokeStyle = C.sumi; g.lineWidth = 6; path(); g.stroke();
      g.strokeStyle = s.color; g.lineWidth = 3; path(); g.stroke();
      s.vals.forEach((v, i) => { g.beginPath(); g.arc(x(i), y(v), 4, 0, Math.PI * 2); g.fillStyle = s.color; g.fill(); g.lineWidth = 2; g.strokeStyle = C.sumi; g.stroke(); });
    }
  };
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

const legend = (series: Series[]) => `<span class="stats-legend">${series.map((s) =>
  `<span><i class="${s.kind === 'line' ? 'ln' : ''}" style="background:${s.color}"></i>${s.label}</span>`).join('')}</span>`;

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** Lifetime totals (short, with the exact figure on hover); re-patched on the management window's tick. */
export function ledgerHtml(s: GameState): string {
  const L = s.lifetime, net = L.revenue - L.expenses;
  const fav = Object.entries(s.piecesByRecipe).filter(([id]) => RECIPES[id]).sort((a, b) => b[1] - a[1])[0];
  const value = Object.keys(s.restaurants).reduce((a, id) => a + PROPERTIES[id].price, 0) + s.cash;
  const row = (k: string, v: string, cls = '', title = '') => `<div class="ln"><span>${k}</span><b class="${cls}"${title ? ` title="${title}"` : ''}>${v}</b></div>`;
  const money = (k: string, n: number, cls = '') => row(k, yen(n), cls, yenExact(n));
  const tone = (n: number) => (n > 0 ? 'good' : n < 0 ? 'bad' : '');
  return `${row('Sushi pieces sold', exact(L.pieces))}${money('Total revenue', L.revenue, 'good')}
    ${money('Total spent (running + investments)', L.expenses, 'bad')}${money('Net result', net, tone(net))}
    ${row('Customers served', exact(L.customers))}${row('Customers lost', exact(L.lost), L.lost ? 'bad' : '')}
    ${money('Tips received', L.tips)}${money('Largest single order', L.bestOrder)}
    ${row('Favorite recipe', fav ? `${esc(RECIPES[fav[0]].name)} (${exact(fav[1])})` : '—', 'txt')}${row('Restaurants', String(Object.keys(s.restaurants).length))}
    ${row('Franchises', String(Object.values(s.cities).reduce((a, c) => a + c.franchises, 0)))}${row('Employees', String(s.staff.length))}
    ${money('Business value (property + cash)', value)}${row('Days in business', String(s.day))}${row('Play time', duration(s.playTime), 'txt')}`;
}

export function statsPanel(s: GameState): HTMLElement {
  const h = s.history.slice(-30);
  const root = el('div', 'stats-panel');

  const topRec = Object.entries(s.piecesByRecipe).filter(([id, n]) => RECIPES[id] && n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const recMax = topRec[0]?.[1] ?? 1;
  const rests = Object.values(s.restaurants).sort((a, b) => b.revenue - a.revenue);
  root.innerHTML = `<div class="pg-head">${icon('chart', 36, { variant: 'seal' })}<h2>Statistics <span class="ja">統計</span></h2></div>
    <div class="ledger">${ledgerHtml(s)}</div>
    <div data-charts></div>
    <div class="grid g2 section">
      <div class="card"><div class="seal-h">${icon('nigiri', 28, { variant: 'seal' })}<h3>Top recipes</h3></div>${topRec.length ? `<div class="stats-rec">${topRec.map(([id, n]) =>
        `<span>${esc(RECIPES[id].name)}</span><span class="n">${exact(n)}</span><div class="meter sm p-money"><i style="width:${(n / recMax) * 100}%"></i></div>`).join('')}</div>`
        : '<div class="muted small">Nothing sold yet.</div>'}</div>
      <div class="card"><div class="seal-h">${icon('shop', 28, { variant: 'seal' })}<h3>Restaurants</h3></div><div class="stats-tbl-wrap"><table class="stats-tbl"><tr><th>Location</th><th>Served</th><th>Revenue</th><th>Rating</th></tr>
        ${rests.map((r) => `<tr><td>${esc(r.name)}</td><td>${exact(r.served)}</td><td title="${yenExact(r.revenue)}">${yen(r.revenue)}</td><td title="${r.reputation.toFixed(1)} stars">${stars(r.reputation)}</td></tr>`).join('')}</table></div></div>
    </div>`;

  // ---- charts
  const box = root.querySelector<HTMLElement>('[data-charts]')!;
  if (h.length < 2) {
    const d = h[0];
    box.innerHTML = `<div class="card muted section">Daily charts appear once two business days have closed.${d
      ? ` Day ${d.day}: ${yenExact(d.revenue)} revenue, ${yenExact(d.expenses)} running costs, ${exact(d.pieces)} pieces, ${exact(d.customers)} guests.` : ''}</div>`;
    return root;
  }
  const rev = h.map((d) => d.revenue), exp = h.map((d) => d.expenses), pro = h.map((d) => d.revenue - d.expenses);
  const pcs = h.map((d) => d.pieces), cus = h.map((d) => d.customers);
  const span = `days ${h[0].day}–${h[h.length - 1].day}`;
  const best = h.reduce((a, d) => (d.revenue - d.expenses > a.revenue - a.expenses ? d : a));
  const money: Series[] = [
    { label: 'Revenue', color: C.matcha, vals: rev, kind: 'bar' },
    { label: 'Running costs', color: C.shu, vals: exp, kind: 'bar' },
    { label: 'Operating profit', color: C.kin, vals: pro, kind: 'line' },
  ];
  const volume: Series[] = [
    { label: 'Pieces', color: C.kin, vals: pcs, kind: 'line' },
    { label: 'Customers', color: C.wood, vals: cus, kind: 'line' },
  ];
  const head = (t: string, ser: Series[]) => el('div', 'stats-h', `<h3>${t}</h3>${legend(ser)}`);
  box.append(
    head(`Money · last ${h.length} days`, money),
    chart(h, money, `Revenue, running costs and operating profit for ${span}. Total revenue ${yenExact(sum(rev))}, costs ${yenExact(sum(exp))}, profit ${yenExact(sum(pro))}. Best day ${best.day} with ${yenExact(best.revenue - best.expenses)} profit.`, yen),
    head('Pieces & guests', volume),
    chart(h, volume, `Pieces sold and customers per day for ${span}. ${exact(sum(pcs))} pieces and ${exact(sum(cus))} customers in total, averaging ${exact(sum(pcs) / h.length)} pieces and ${exact(sum(cus) / h.length)} customers a day.`, short),
  );
  return root;
}
