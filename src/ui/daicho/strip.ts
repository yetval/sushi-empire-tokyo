// Daichō strip — the lacquer/indigo noren band across the top: hanko time controls, calendar, 5 empire KPIs.
// DOM is built once; render() only patches text/attributes that changed (values tick every SNAP_EVERY).
import { milestone } from '../../core/data';
import { clockStr, exact, short, yen } from '../../core/format';
import { holiday, season } from '../../core/seasons';
import { nextMilestone } from '../../core/sim';
import { BAND_MARK, Ctx, Part, Snap, spark } from './shared';
import './strip.css';

type K = 'cash' | 'profit' | 'pieces' | 'stars' | 'alerts';
const TILES: [K, string, string][] = [
  ['cash', 'Cash', '金'], ['profit', 'Net/day', '益'], ['pieces', 'Pieces/day', '貫'], ['stars', 'Avg rating', '星'], ['alerts', 'Alerts', '報'],
];
// [speed (0 = pause), glyph, aria-label, key]
const SPEEDS: [0 | 1 | 2 | 4, string, string, string][] = [[0, '⏸', 'Pause', ''], [1, '▶', 'Speed 1×', '1'], [2, '▶▶', 'Speed 2×', '2'], [4, '▶▶▶', 'Speed 4×', '3']];

const txt = (el: Element, v: string) => { if (el.textContent !== v) el.textContent = v; };
const attr = (el: Element, k: string, v: string) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
const yenWords = (n: number) => `${n < 0 ? 'minus ' : ''}${exact(Math.abs(n))} yen`;

interface Tile { li: HTMLLIElement; sr: HTMLElement; val: HTMLElement; dlt: HTMLElement; sp: HTMLElement; spKey: string; bar?: HTMLElement }

export class Strip implements Part {
  readonly el = document.createElement('div');
  private readonly btns: HTMLButtonElement[] = [];
  private readonly cal: { day: HTMLElement; season: HTMLElement; hol: HTMLElement };
  private readonly tiles = {} as Record<K, Tile>;
  // ponytail: ★ has no per-day history in core, so the strip keeps its own end-of-day samples for this session.
  // Upgrade path: add avgStars to DaySummary and read it from totals like profit7.
  private stars7: number[] = [];
  private starsDay = -1;
  private starsLast = 0;

  constructor(private ctx: Ctx) {
    this.el.className = 'dc-strip';
    this.el.innerHTML = `
      <div class="dc-strip-time">
        <div class="dc-strip-spd" role="group" aria-label="Time speed">${SPEEDS.map(([n, g, label, key]) =>
          `<button type="button" data-n="${n}" aria-label="${label}" aria-pressed="false" title="${label}${key ? ` (key ${key})` : ''}"><span aria-hidden="true">${g}</span>${key ? `<kbd aria-hidden="true">${key}</kbd>` : ''}</button>`).join('')}</div>
        <div class="dc-strip-cal">
          <div class="d"></div>
          <div class="s"><span class="se"></span><span class="hol" hidden></span></div>
        </div>
      </div>
      <ul class="dc-strip-kpis" aria-label="Empire at a glance">${TILES.map(([k, label, jp]) => `
        <li class="dc-kpi" data-k="${k}">
          <span class="dc-sr"></span>
          <div class="v" aria-hidden="true">
            <span class="lbl">${label}<i>${jp}</i></span>
            <b class="val"></b>
            <span class="dlt"></span>
            <span class="sp"></span>
            ${k === 'pieces' ? '<span class="bar"><i></i></span>' : ''}
          </div>
        </li>`).join('')}</ul>`;
    const q = <T extends HTMLElement>(sel: string, root: ParentNode = this.el) => root.querySelector(sel) as T;
    this.el.querySelectorAll<HTMLButtonElement>('.dc-strip-spd button').forEach((b) => {
      this.btns.push(b);
      b.addEventListener('click', () => {
        const n = Number(b.dataset.n) as 0 | 1 | 2 | 4, host = this.ctx.host;
        if (!n) host.setPaused(!this.paused());
        else { host.setPaused(false); host.setSpeed(n); }
        this.syncTime();
      });
    });
    this.cal = { day: q('.dc-strip-cal .d'), season: q('.dc-strip-cal .se'), hol: q('.dc-strip-cal .hol') };
    for (const [k] of TILES) {
      const li = q<HTMLLIElement>(`.dc-kpi[data-k="${k}"]`);
      this.tiles[k] = { li, sr: q('.dc-sr', li), val: q('.val', li), dlt: q('.dlt', li), sp: q('.sp', li), spKey: '\0', bar: q('.bar i', li) ?? undefined };
    }
  }

  private paused(): boolean { return (this.ctx.host as unknown as { paused?: boolean }).paused === true; }

  private syncTime(): void {
    const paused = this.paused(), speed = this.ctx.host.speed;
    for (const b of this.btns) {
      const n = Number(b.dataset.n), on = n === 0 ? paused : !paused && speed === n;
      attr(b, 'aria-pressed', String(on));
    }
    this.el.classList.toggle('is-paused', paused);
  }

  render(snap: Snap): void {
    const s = this.ctx.host.s, t = snap.totals;
    this.syncTime();

    // calendar
    const se = season(s), hol = holiday(s);
    txt(this.cal.day, `Day ${s.day} · ${clockStr(s.minute)}`);
    txt(this.cal.season, `${se.emoji} ${se.name} ${se.jp}`);
    this.cal.hol.hidden = !hol;
    if (hol) { txt(this.cal.hol, `${hol.emoji} ${hol.name}`); attr(this.cal.hol, 'title', hol.desc); }

    // cash: end-of-day balances reconstructed backwards from today (all spending goes through sim.spend → expenses)
    const todayNet = s.today.revenue - s.today.expenses;
    const cash7: number[] = [];
    for (let i = t.profit7.length - 1, c = t.cash - todayNet; i >= 0; c -= t.profit7[i--]) cash7.unshift(c);
    const pLast = t.profit7.length ? t.profit7[t.profit7.length - 1] : null;
    this.money('cash', t.cash, pLast, cash7, 'Cash', 'net yesterday');

    const prev = (a: number[]) => (a.length >= 2 ? a[a.length - 2] : null);
    const pp = prev(t.profit7);
    this.money('profit', t.profitYesterday, pLast !== null && pp !== null ? pLast - pp : null, t.profit7, 'Net profit yesterday', 'vs day before', !t.profit7.length);

    // pieces/day + milestone bar
    const pcs = t.pieces7.length ? t.pieces7[t.pieces7.length - 1] : null, pcsPrev = prev(t.pieces7);
    const m = nextMilestone(s), base = s.milestoneIndex ? milestone(s.milestoneIndex - 1).pieces : 0;
    const frac = Math.max(0, Math.min(1, (s.lifetime.pieces - base) / Math.max(1, m.pieces - base)));
    const pct = Math.floor(frac * 100);
    const pd = pcs !== null && pcsPrev !== null ? pcs - pcsPrev : null;
    this.tile('pieces', pcs === null ? '—' : short(pcs), this.delta(pd, short),
      `Pieces sold yesterday: ${pcs === null ? 'no full day yet' : exact(pcs)}. ${this.deltaWords(pd, exact, 'vs day before')} Next milestone ${m.title} at ${exact(m.pieces)} pieces, ${pct}% there.`, t.pieces7);
    const bar = this.tiles.pieces.bar!;
    const w = `${(frac * 100).toFixed(1)}%`;
    if (bar.style.width !== w) bar.style.width = w;
    attr(this.tiles.pieces.li, 'title', `Next: ${m.title} at ${exact(m.pieces)} pieces (${pct}%)`);

    // avg ★ (session-sampled history, see stars7)
    if (this.starsDay !== s.day) {
      if (this.starsDay !== -1) { this.stars7.push(this.starsLast); if (this.stars7.length > 7) this.stars7.shift(); }
      this.starsDay = s.day;
    }
    this.starsLast = t.avgStars;
    const sPrev = this.stars7.length ? this.stars7[this.stars7.length - 1] : null;
    const sd = t.restaurants && sPrev !== null ? Math.round((t.avgStars - sPrev) * 10) / 10 : null;
    const fmt1 = (n: number) => n.toFixed(1);
    this.tile('stars', t.restaurants ? `★ ${t.avgStars.toFixed(1)}` : '—', this.delta(sd, fmt1),
      t.restaurants ? `Average rating ${t.avgStars.toFixed(1)} of 5 stars across ${t.restaurants} restaurant${t.restaurants === 1 ? '' : 's'}. ${this.deltaWords(sd, fmt1, 'since yesterday')}` : 'Average rating: no restaurants yet.',
      [...this.stars7, t.avgStars].slice(-7));

    // alerts by severity
    const n = { critical: 0, warning: 0, opportunity: 0 };
    for (const a of snap.alerts) n[a.severity]++;
    const al = this.tiles.alerts, total = snap.alerts.length;
    txt(al.val, total ? String(total) : `${BAND_MARK.good.glyph} All quiet`);
    const html = total
      ? [n.critical && `<span class="crit">${BAND_MARK.act.glyph} ${n.critical} act now</span>`, n.warning && `<span>${BAND_MARK.watch.glyph} ${n.warning}</span>`, n.opportunity && `<span class="opp">✦ ${n.opportunity}</span>`].filter(Boolean).join('')
      : '<span>Nothing needs you</span>';
    if (al.dlt.innerHTML !== html) al.dlt.innerHTML = html;
    al.li.classList.toggle('has-crit', n.critical > 0);
    txt(al.sr, total ? `Alerts: ${total} open — ${n.critical} act now, ${n.warning} to watch, ${n.opportunity} ${n.opportunity === 1 ? 'opportunity' : 'opportunities'}.` : 'Alerts: all quiet.');
  }

  private money(k: K, v: number, d: number | null, series: number[], label: string, vs: string, none = false): void {
    this.tile(k, none ? '—' : yen(v), this.delta(d, yen), `${label}: ${none ? 'no full day yet' : yenWords(v)}. ${this.deltaWords(d, yenWords, vs)}`, series);
  }

  /** Visible Δ: arrow + amount (never colour alone). */
  private delta(d: number | null, f: (n: number) => string): { text: string; dir: string } {
    if (d === null) return { text: '—', dir: 'none' };
    if (d === 0) return { text: '＝ same', dir: 'flat' };
    return { text: `${d > 0 ? '▲' : '▼'} ${f(Math.abs(d))}`, dir: d > 0 ? 'up' : 'down' };
  }

  private deltaWords(d: number | null, f: (n: number) => string, vs: string): string {
    if (d === null) return 'No change data yet.';
    return d === 0 ? `Unchanged ${vs}.` : `${d > 0 ? 'Up' : 'Down'} ${f(Math.abs(d))} ${vs}.`;
  }

  private tile(k: K, val: string, d: { text: string; dir: string }, sr: string, series: number[]): void {
    const tl = this.tiles[k];
    txt(tl.val, val);
    txt(tl.dlt, d.text);
    attr(tl.dlt, 'data-dir', d.dir);
    txt(tl.sr, sr);
    const key = series.join(',');
    if (key !== tl.spKey) { tl.spKey = key; tl.sp.innerHTML = spark(series, 44, 14, 'on-dark'); }
  }

  destroy(): void { this.el.remove(); }
}
