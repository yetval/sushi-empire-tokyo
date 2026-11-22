// Daichō ledger (right pane): restaurants grouped by area, worst first, patched in place every snapshot.
// Rows are keyed by restaurant id, built once, and only changed cells/attributes are written (see put()).
import { setPolicy } from '../../core/actions';
import { AREAS } from '../../core/data';
import { RestKPI, applyRule } from '../../core/empire';
import { yen } from '../../core/format';
import { esc, run } from '../dom';
import './ledger.css';
import { BAND_MARK, Band, Ctx, Part, Snap, conceptGlyph, health, overlayBand, spark } from './shared';

type SortKey = 'worst' | 'name' | 'profit' | 'load' | 'stock' | 'stars' | 'staff';
type Rule = 'autoHire' | 'autoPrice';
const RANK: Record<Band, number> = { good: 0, watch: 1, act: 2 };
const NO_POLICY = 'Needs a manager here, or research Operations Center';
const RULES: { key: Rule; glyph: string; word: string }[] = [{ key: 'autoHire', glyph: '自', word: 'Auto-hire' }, { key: 'autoPrice', glyph: '価', word: 'Auto-price' }];
// Header columns. `dir` = direction of the first click (every numeric column opens on its problem end).
const COLS: { cls: string; key?: SortKey; label: string; title: string; dir?: 1 | -1 }[] = [
  { cls: 'lc-sel', label: '', title: '' },
  { cls: 'lc-band', key: 'worst', label: '◎', title: 'Health (worst first)', dir: 1 },
  { cls: 'lc-name', key: 'name', label: 'Restaurant', title: 'Name', dir: 1 },
  { cls: 'lc-profit', key: 'profit', label: '¥/day', title: 'Profit yesterday (today so far for new shops), 7-day trend', dir: 1 },
  { cls: 'lc-load', key: 'load', label: 'Load', title: 'Kitchen load at a busy hour (over 100% = turning guests away)', dir: -1 },
  { cls: 'lc-stock', key: 'stock', label: 'Stock', title: 'Days of ingredients left', dir: 1 },
  { cls: 'lc-stars', key: 'stars', label: '★', title: 'Rating', dir: 1 },
  { cls: 'lc-staff', key: 'staff', label: 'Staff', title: 'Staff hired / slots', dir: 1 },
  { cls: 'lc-rules', label: 'Rules', title: 'House rules: 自 auto-hire · 価 auto-price', },
];

interface Item { k: RestKPI; p: number; band: Band; why: string; have: number; slots: number }
interface Row {
  id: string; area: string; tr: HTMLTableRowElement; cb: HTMLInputElement; tds: Record<string, HTMLTableCellElement>;
  pol: Record<Rule, HTMLButtonElement>; last: Map<string, string>;
}
interface Group { area: string; tb: HTMLTableSectionElement; head: HTMLTableRowElement; th: HTMLTableCellElement; last: Map<string, string>; order: string }

/** Write only when the value changed since last time. */
function put(o: { last: Map<string, string> }, key: string, v: string, apply: (v: string) => void): void {
  if (o.last.get(key) !== v) { o.last.set(key, v); apply(v); }
}
const minus = (s: string) => s.replace('-', '−');
const sumStaff = (k: RestKPI) => Object.values(k.staff).reduce((a, r) => [a[0] + r[0], a[1] + r[1]], [0, 0]);

export class Ledger implements Part {
  readonly el = document.createElement('section');
  private readonly scroller = document.createElement('div');
  private readonly table = document.createElement('table');
  private readonly empty = document.createElement('div');
  private readonly bulk = document.createElement('div');
  private readonly filter = document.createElement('input');
  private readonly title = document.createElement('h3');
  private readonly count = document.createElement('span');
  private readonly allCb = document.createElement('input');
  private readonly ths: HTMLTableCellElement[] = [];
  private rows = new Map<string, Row>();
  private groups = new Map<string, Group>();
  private visible: Row[] = [];
  private groupOrder = '';
  private sort: { key: SortKey; dir: 1 | -1 } = { key: 'worst', dir: 1 };
  private active: string | null = null; // roving tabindex owner
  private hl: Row | null = null;
  private selfHover: string | null = null;
  private pointerIn = false;
  private force = true;
  private bulkKey = '';
  private readonly unsub: (() => void)[] = [];

  constructor(private ctx: Ctx) {
    const el = this.el;
    el.className = 'dc-ledger';
    el.setAttribute('aria-label', 'Ledger — restaurants');
    const top = document.createElement('div');
    top.className = 'dc-lg-top';
    this.title.className = 'dc-lg-title';
    this.count.className = 'dc-lg-count';
    this.filter.type = 'search';
    this.filter.className = 'dc-lg-filter';
    this.filter.placeholder = 'Filter  /';
    this.filter.setAttribute('aria-label', 'Filter restaurants by name or area');
    top.append(this.title, this.count, this.filter);

    this.allCb.type = 'checkbox';
    this.allCb.setAttribute('aria-label', 'Select all visible restaurants');
    const thead = this.table.createTHead().insertRow();
    for (const c of COLS) {
      const th = document.createElement('th');
      th.className = c.cls; th.scope = 'col';
      if (c.cls === 'lc-sel') th.append(this.allCb);
      else if (c.key) th.innerHTML = `<button type="button" class="dc-lg-sort" data-sort="${c.key}" title="${esc(c.title)}">${c.label}${c.key === 'worst' ? '<span class="dc-sr">Health</span>' : ''}</button>`;
      else { th.textContent = c.label; th.title = c.title; }
      thead.append(th); this.ths.push(th);
    }
    this.table.className = 'dc-lg-table';
    this.table.createCaption().className = 'dc-sr';
    this.scroller.className = 'dc-lg-scroll';
    this.scroller.append(this.table);

    this.empty.className = 'dc-lg-empty card';
    this.empty.hidden = true;
    this.empty.innerHTML = '<b>白紙 — a blank ledger</b><p>No restaurants yet. Pick a lot on the map and open your first shop; every one you own gets a line here.</p>';

    this.bulk.className = 'dc-lg-bulk';
    this.bulk.hidden = true;
    this.bulk.innerHTML = `<span class="n" aria-live="polite"></span><span class="lbl">Make it a rule:</span>
      ${RULES.map((r) => `<button type="button" class="btn small blue" data-rule="${r.key}">${r.glyph} ${r.word}</button>`).join('')}
      <button type="button" class="btn small ghost" data-clear>Clear</button>`;

    el.append(top, this.scroller, this.empty, this.bulk);

    this.table.addEventListener('click', this.onClick);
    this.table.addEventListener('change', this.onChange);
    this.bulk.addEventListener('click', this.onBulk);
    el.addEventListener('keydown', this.onKey);
    this.filter.addEventListener('input', () => { this.force = true; this.render(this.ctx.snap()); });
    this.scroller.addEventListener('pointerenter', () => { this.pointerIn = true; });
    this.scroller.addEventListener('pointerleave', () => { this.pointerIn = false; this.hover(null); });
    this.table.addEventListener('pointerover', (e) => { const r = this.rowOf(e.target); if (r) this.hover(r.id); });
    this.table.addEventListener('focusin', (e) => {
      const r = this.rowOf(e.target);
      if (!r) return;
      this.active = r.id; this.roving();
      this.hover(r.id);
    });
    this.table.addEventListener('focusout', (e) => { if (!this.table.contains(e.relatedTarget as Node)) this.hover(null); });

    const { store } = ctx;
    this.unsub.push(
      store.on(['area'], () => { this.force = true; this.scroller.scrollTop = 0; this.render(ctx.snap()); }),
      store.on(['selected'], () => this.render(ctx.snap())),
      store.on(['hover'], () => this.onHover()),
    );
  }

  // ------------------------------------------------------------------ render (patch)
  render(snap: Snap): void {
    const { store } = this.ctx, area = store.st.area, sel = store.st.selected;
    const none = snap.kpis.length === 0;
    if (this.empty.hidden !== !none) { this.empty.hidden = !none; this.scroller.hidden = none; this.filter.hidden = none; }

    // rows: drop sold, build new, patch cells
    const live = new Set(snap.kpis.map((k) => k.id));
    for (const [id, r] of this.rows) if (!live.has(id)) { r.tr.remove(); this.rows.delete(id); sel.delete(id); }
    const q = this.filter.value.trim().toLowerCase();
    const items: Item[] = [];
    for (const k of snap.kpis) {
      const h = health(k), [have, slots] = sumStaff(k);
      const it: Item = { k, p: k.profitYesterday ?? k.revToday, band: h.band, why: h.why, have, slots };
      const r = this.rows.get(k.id) ?? this.makeRow(k);
      this.patchRow(r, it, sel.has(k.id));
      const a = AREAS[k.area];
      const show = (!area || k.area === area) && (!q || `${k.name} ${k.areaName} ${a?.jp ?? ''}`.toLowerCase().includes(q));
      if (r.tr.hidden === show) r.tr.hidden = !show;
      if (show) items.push(it);
    }

    // sort, group (groups ordered by their first = worst member), reorder only on change
    const { key, dir } = this.sort;
    const num: Partial<Record<SortKey, (i: Item) => number>> = {
      profit: (i) => i.p, load: (i) => i.k.load, stock: (i) => i.k.stockDays, stars: (i) => i.k.stars, staff: (i) => (i.slots ? i.have / i.slots : 1),
    };
    items.sort((a, b) => key === 'worst' ? dir * (RANK[b.band] - RANK[a.band] || a.p - b.p) || a.k.name.localeCompare(b.k.name)
      : key === 'name' ? dir * a.k.name.localeCompare(b.k.name)
        : dir * (num[key]!(a) - num[key]!(b)) || a.k.name.localeCompare(b.k.name));
    const byArea = new Map<string, Item[]>();
    for (const it of items) (byArea.get(it.k.area) ?? byArea.set(it.k.area, []).get(it.k.area)!).push(it);
    const frozen = this.pointerIn && !this.force; // ponytail: don't shuffle rows under the cursor; next tick after leaving catches up
    this.visible = [];
    for (const [a, its] of byArea) {
      const g = this.groups.get(a) ?? this.makeGroup(a);
      this.patchGroup(g, its, !!area);
      const order = its.map((i) => i.k.id).join();
      if (g.order !== order && !frozen) {
        g.order = order;
        const focused = document.activeElement as HTMLElement | null;
        let at = g.head.nextElementSibling;
        for (const it of its) {
          const tr = this.rows.get(it.k.id)!.tr;
          if (at === tr) at = tr.nextElementSibling; else g.tb.insertBefore(tr, at);
        }
        if (focused && g.tb.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }
      for (const it of its) this.visible.push(this.rows.get(it.k.id)!);
    }
    if (frozen) this.visible.sort((x, y) => (x.tr.compareDocumentPosition(y.tr) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (const g of this.groups.values()) { const show = byArea.has(g.area); if (g.tb.hidden === show) g.tb.hidden = !show; }
    const gOrder = [...byArea.keys()].join();
    if (gOrder !== this.groupOrder && !frozen) {
      this.groupOrder = gOrder;
      let at = this.table.tHead!.nextElementSibling;
      for (const a of byArea.keys()) {
        const tb = this.groups.get(a)!.tb;
        if (at === tb) at = tb.nextElementSibling; else this.table.insertBefore(tb, at);
      }
    }
    this.force = false;

    // header: title, count, sort state, select-all
    const t = area ? `${AREAS[area]?.jp ?? ''} ${AREAS[area]?.name ?? area}` : '台帳 Ledger';
    if (this.title.textContent !== t) this.title.textContent = t;
    const c = none ? '' : `${items.length}${items.length !== snap.kpis.length && !area ? ` of ${snap.kpis.length}` : ''} shop${items.length === 1 ? '' : 's'}`;
    if (this.count.textContent !== c) this.count.textContent = c;
    this.ths.forEach((th, i) => {
      const k = COLS[i].key;
      if (!k) return;
      const s = k !== key ? 'none' : (k === 'worst') === (dir === 1) ? 'descending' : 'ascending';
      if (th.getAttribute('aria-sort') !== s) th.setAttribute('aria-sort', s);
    });
    const cap = `Restaurants, sorted by ${COLS.find((x) => x.key === key)!.title.toLowerCase()}`;
    if (this.table.caption!.textContent !== cap) this.table.caption!.textContent = cap;
    const nSel = items.filter((i) => sel.has(i.k.id)).length;
    const all = items.length > 0 && nSel === items.length, some = nSel > 0 && !all;
    if (this.allCb.checked !== all) this.allCb.checked = all;
    if (this.allCb.indeterminate !== some) this.allCb.indeterminate = some;
    this.allCb.disabled = items.length === 0;

    this.patchBulk(snap);
    this.roving();
  }

  private makeRow(k: RestKPI): Row {
    const tr = document.createElement('tr');
    tr.className = 'dc-lg-row';
    tr.dataset.id = k.id;
    tr.tabIndex = -1;
    tr.innerHTML = `<td class="lc-sel"><input type="checkbox" tabindex="-1"></td><td class="lc-band"></td>
      <td class="lc-name"><button type="button" class="dc-lg-name" tabindex="-1" data-open></button></td>
      <td class="lc-profit"><span class="v"></span><span class="s"></span></td>
      <td class="lc-load"><span class="dc-lg-load"><i></i></span><span class="t"></span></td>
      <td class="lc-stock"></td><td class="lc-stars"></td><td class="lc-staff"></td>
      <td class="lc-rules">${RULES.map((r) => `<button type="button" class="dc-lg-pol" tabindex="-1" data-pol="${r.key}" aria-label="${r.word}">${r.glyph}</button>`).join('')}</td>`;
    const tds = Object.fromEntries([...tr.cells].map((td) => [td.className, td]));
    const pol = Object.fromEntries(RULES.map((r) => [r.key, tr.querySelector<HTMLButtonElement>(`[data-pol="${r.key}"]`)!])) as Record<Rule, HTMLButtonElement>;
    const r: Row = { id: k.id, area: k.area, tr, cb: tr.querySelector('input')!, tds, pol, last: new Map() };
    this.rows.set(k.id, r);
    (this.groups.get(k.area) ?? this.makeGroup(k.area)).tb.append(tr);
    return r;
  }

  private patchRow(r: Row, it: Item, selected: boolean): void {
    const { k } = it, td = r.tds;
    put(r, 'name', `${k.concept}|${k.name}`, () => {
      // the area is already named by the group header / title, so drop it from the row ("Soho Grand Hall" → "Grand Hall")
      const pre = [k.areaName, k.areaName.split(' · ').pop()!].find((a) => k.name.startsWith(`${a} `));
      const nm = pre ? k.name.slice(pre.length + 1) : k.name;
      td['lc-name'].firstElementChild!.innerHTML = `${conceptGlyph(k.concept, 13)}<span class="t">${esc(nm)}</span>`;
      td['lc-name'].firstElementChild!.setAttribute('title', `Open ${k.name}`);
      r.cb.setAttribute('aria-label', `Select ${k.name}`);
    });
    put(r, 'band', `${it.band}|${it.why}`, () => {
      const m = BAND_MARK[it.band];
      td['lc-band'].innerHTML = `<span class="dc-band ${it.band}" aria-hidden="true">${m.glyph}</span><span class="dc-sr">${m.word}: ${esc(it.why)}</span>`;
      td['lc-band'].title = it.why;
      r.tr.dataset.band = it.band;
    });
    const pv = minus(yen(it.p));
    put(r, 'p', pv, () => {
      const v = td['lc-profit'].firstElementChild as HTMLElement;
      v.textContent = pv;
      v.classList.toggle('neg', it.p < 0);
    });
    put(r, 'new', String(k.profitYesterday === null), (v) => { td['lc-profit'].title = v === 'true' ? 'New: revenue today so far' : 'Profit yesterday · 7-day trend'; });
    put(r, 'spark', k.profit7.map(Math.round).join(), () => { td['lc-profit'].lastElementChild!.innerHTML = spark(k.profit7, 30, 14); });
    const lb = overlayBand(k, 'load');
    put(r, 'load', `${lb.label}|${lb.band}`, () => {
      const bar = td['lc-load'].firstElementChild as HTMLElement;
      (bar.firstElementChild as HTMLElement).style.width = `${Math.min(1, Math.max(0, k.load)) * 100}%`;
      bar.className = `dc-lg-load ${lb.band}${k.load > 1 ? ' over' : ''}`;
      td['lc-load'].lastElementChild!.textContent = lb.label;
      td['lc-load'].title = k.load > 1 ? `Load ${lb.label}: turning guests away` : `Load ${lb.label}`;
    });
    const sb = overlayBand(k, 'stock');
    put(r, 'stock', `${sb.label}|${sb.band}`, () => { td['lc-stock'].textContent = sb.label; td['lc-stock'].className = `lc-stock ${sb.band}`; });
    put(r, 'stars', k.stars.toFixed(1), (v) => { td['lc-stars'].textContent = v; });
    put(r, 'staff', `${it.have}/${it.slots}|${k.staff.chef[0]}`, () => {
      td['lc-staff'].textContent = `${it.have}/${it.slots}`;
      td['lc-staff'].classList.toggle('act', k.staff.chef[0] === 0);
      td['lc-staff'].title = Object.entries(k.staff).map(([role, [h, s]]) => `${role} ${h}/${s}`).join(' · ');
    });
    for (const rule of RULES) {
      const on = k.policy[rule.key];
      put(r, rule.key, `${on}|${k.policiesAvailable}`, () => {
        const b = r.pol[rule.key];
        b.setAttribute('aria-pressed', String(on));
        b.disabled = !on && !k.policiesAvailable;
        b.title = `${rule.word}: ${on ? 'on — click to turn off' : k.policiesAvailable ? 'off — click to turn on' : `off. ${NO_POLICY}`}`;
      });
    }
    put(r, 'sel', String(selected), () => { r.cb.checked = selected; r.tr.classList.toggle('is-sel', selected); });
  }

  private makeGroup(area: string): Group {
    const tb = document.createElement('tbody');
    tb.dataset.area = area;
    const head = tb.insertRow();
    head.className = 'dc-lg-grp';
    const th = document.createElement('th');
    th.colSpan = COLS.length; th.scope = 'rowgroup';
    head.append(th);
    this.table.append(tb);
    const g: Group = { area, tb, head, th, last: new Map(), order: '' };
    this.groups.set(area, g);
    return g;
  }

  private patchGroup(g: Group, its: Item[], city: boolean): void {
    if (g.head.hidden !== city) g.head.hidden = city;
    if (city) return;
    const worst = its.reduce<Band>((w, i) => (RANK[i.band] > RANK[w] ? i.band : w), 'good');
    const sum = its.reduce((a, i) => a + i.p, 0), a = AREAS[g.area];
    put(g, 'h', `${its.length}|${Math.round(sum)}|${worst}`, () => {
      const m = BAND_MARK[worst];
      g.th.innerHTML = `<div><span class="dc-band ${worst}" aria-hidden="true">${m.glyph}</span><span class="dc-sr">worst: ${m.word}.</span>
        <span class="jp">${esc(a?.jp ?? '')}</span><span class="nm">${esc(a?.name ?? g.area)}</span>
        <span class="n">${its.length} shop${its.length === 1 ? '' : 's'}</span><span class="sum${sum < 0 ? ' neg' : ''}">${minus(yen(sum))}/day</span></div>`;
    });
  }

  private patchBulk(snap: Snap): void {
    const ids = [...this.ctx.store.st.selected];
    const show = ids.length > 0;
    if (this.bulk.hidden === show) this.bulk.hidden = !show;
    if (!show) return;
    const can = ids.some((id) => snap.byId.get(id)?.policiesAvailable);
    if (this.bulkKey === `${ids.length}|${can}`) return;
    this.bulkKey = `${ids.length}|${can}`;
    {
      this.bulk.querySelector('.n')!.textContent = `${ids.length} selected`;
      this.bulk.querySelector('.lbl')!.textContent = can ? 'Make it a rule:' : 'Rules need a manager:';
      for (const b of this.bulk.querySelectorAll<HTMLButtonElement>('[data-rule]')) {
        b.disabled = !can;
        b.title = can ? `Turn on for every selected restaurant that can use house rules` : `None selected can use house rules. ${NO_POLICY}`;
      }
    }
  }

  /** One row in the tab order: the active one (or the first visible). */
  private roving(): void {
    if (!this.visible.some((r) => r.id === this.active)) this.active = this.visible[0]?.id ?? null;
    for (const r of this.rows.values()) {
      const ti = r.id === this.active ? 0 : -1;
      if (r.tr.tabIndex !== ti) r.tr.tabIndex = ti;
    }
  }

  // ------------------------------------------------------------------ hover cross-highlight
  private hover(id: string | null): void {
    const { store } = this.ctx;
    if (id === null && this.selfHover === null) return; // only clear what we set
    if (id === null && store.st.hover !== this.selfHover) return;
    this.selfHover = id;
    store.set({ hover: id });
  }

  private onHover(): void {
    const id = this.ctx.store.st.hover, r = id ? this.rows.get(id) ?? null : null;
    if (r !== this.hl) { this.hl?.tr.classList.remove('is-hl'); r?.tr.classList.add('is-hl'); this.hl = r; }
    if (id !== this.selfHover) {
      this.selfHover = null;
      if (r && !r.tr.hidden) this.reveal(r.tr); // set by the map: bring it into view
    }
  }

  /** Scroll the ledger (only) so the row is visible below the sticky header; block:'nearest' semantics. */
  private reveal(tr: HTMLElement): void {
    const sc = this.scroller, head = this.table.tHead!.offsetHeight;
    const top = tr.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    if (top - head < sc.scrollTop) sc.scrollTop = top - head;
    else if (top + tr.offsetHeight > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + tr.offsetHeight - sc.clientHeight;
  }

  // ------------------------------------------------------------------ events
  private rowOf(t: EventTarget | null): Row | undefined {
    const tr = (t as HTMLElement | null)?.closest?.<HTMLElement>('tr.dc-lg-row');
    return tr ? this.rows.get(tr.dataset.id!) : undefined;
  }

  private readonly onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const sortBtn = t.closest<HTMLElement>('[data-sort]');
    if (sortBtn) {
      const k = sortBtn.dataset.sort as SortKey;
      this.sort = this.sort.key === k ? { key: k, dir: (this.sort.dir * -1) as 1 | -1 } : { key: k, dir: COLS.find((c) => c.key === k)!.dir! };
      this.force = true;
      this.render(this.ctx.snap());
      return;
    }
    const r = this.rowOf(t);
    if (!r) return;
    const pol = t.closest<HTMLButtonElement>('[data-pol]');
    if (pol) {
      const key = pol.dataset.pol as Rule;
      if (run(pol, setPolicy(this.ctx.host.s, r.id, key, pol.getAttribute('aria-pressed') !== 'true'), 'click')) this.ctx.refresh();
    } else if (t.closest('[data-open]')) this.ctx.opts.openRestaurant(r.id);
  };

  private readonly onChange = (e: Event) => {
    const t = e.target as HTMLInputElement, { store } = this.ctx, sel = store.st.selected;
    if (t === this.allCb) {
      for (const r of this.visible) if (t.checked) sel.add(r.id); else sel.delete(r.id);
    } else {
      const r = this.rowOf(t);
      if (!r) return;
      if (t.checked) sel.add(r.id); else sel.delete(r.id);
    }
    store.touchSelected();
  };

  private readonly onBulk = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    const { store } = this.ctx;
    if (b.dataset.clear !== undefined) { store.st.selected.clear(); store.touchSelected(); return; }
    if (run(b, applyRule(this.ctx.host.s, b.dataset.rule as Rule, [...store.st.selected]))) this.ctx.refresh();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement && t.type !== 'checkbox';
    if (e.key === '/' && !typing) { e.preventDefault(); this.filter.focus(); this.filter.select(); return; }
    if (typing) { if (e.key === 'ArrowDown' && this.visible[0]) { e.preventDefault(); this.visible[0].tr.focus(); } return; }
    const r = this.rowOf(t);
    if (!r) return;
    const i = this.visible.indexOf(r);
    const go = (j: number) => { const n = this.visible[Math.max(0, Math.min(this.visible.length - 1, j))]; if (n) { n.tr.focus(); this.reveal(n.tr); } };
    const ctrls = [r.tr, ...r.tr.querySelectorAll<HTMLElement>('input, button')].filter((c) => c === r.tr || (c.offsetParent !== null && !(c as HTMLButtonElement).disabled));
    const ci = ctrls.indexOf(t);
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(this.visible.length - 1); break;
      case 'ArrowRight': ctrls[Math.min(ctrls.length - 1, ci + 1)]?.focus(); break;
      case 'ArrowLeft': ctrls[Math.max(0, ci - 1)]?.focus(); break;
      case ' ': if (t !== r.tr) return; r.cb.click(); break;
      case 'Enter': if (t !== r.tr) return; this.ctx.opts.openRestaurant(r.id); break;
      default: return;
    }
    e.preventDefault();
  };

  destroy(): void {
    for (const u of this.unsub) u();
    this.el.remove();
  }
}
