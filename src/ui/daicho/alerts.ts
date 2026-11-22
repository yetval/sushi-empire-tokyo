// Daichō 台帳 — alert rail: the inbox of paper slips at the bottom of the dashboard.
// Slips are keyed by alert.id, built once and patched per snapshot. Acting on a slip stamps it 済 (fix) or 掟 (rule)
// when the alert disappears from the next snapshot. Snooze lives in this part's memory only.
import { unlockDistrict } from '../../core/actions';
import { AREAS, INGREDIENTS, IngredientId, PROPERTIES } from '../../core/data';
import { Alert, Severity, applyFix, applyRule } from '../../core/empire';
import { yen } from '../../core/format';
import { esc, ingIcon, run } from '../dom';
import './alerts.css';
import { Ctx, Part, Snap } from './shared';

const SEV: Record<Severity, { glyph: string; word: string }> = {
  critical: { glyph: '✕', word: 'Act now' }, warning: { glyph: '△', word: 'Soon' }, opportunity: { glyph: '★', word: 'Chance' },
};
const ROW = 3; // collapsed rail = one row of 3 slips (+ a compact "+N" tile)
const SNOOZE_MS = 120_000;
const STAMP_MS = 1500;
const ACTED_MS = 20_000; // a rule resolves on the next in-game hour, so keep "we acted" around a little while
const RESTOCK_NOTE = 'Restocking runs itself once you research Scheduled Deliveries (Research) or hire a manager.';

interface Slip {
  a: Alert; el: HTMLElement; sevGlyph: HTMLElement; sevWord: HTMLElement;
  txt: HTMLElement; ings: HTMLElement; pre: HTMLElement; who: HTMLButtonElement; post: HTMLElement;
  fix: HTMLButtonElement; alt: HTMLButtonElement; rule: HTMLButtonElement; note: HTMLElement;
  stamping: boolean;
}

/** "rice, nori and cucumber" */
const listOf = (ids: IngredientId[]) => {
  const n = ids.map((i) => INGREDIENTS[i].name.toLowerCase());
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] ?? '';
};
const set = (e: HTMLElement, text: string) => { if (e.textContent !== text) e.textContent = text; };
const btn = (cls: string, text: string) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text;
  return b;
};

export class AlertRail implements Part {
  readonly el = document.createElement('section');
  private readonly grid = document.createElement('div');
  private readonly more = btn('dc-al-more', '');
  private readonly empty = document.createElement('div');
  private readonly live = document.createElement('div');
  private readonly slips = new Map<string, Slip>();
  private order: string[] = [];
  private readonly snoozed = new Map<string, number>(); // id → until (performance.now)
  private readonly acted = new Map<string, { mark: '済' | '掟'; t: number }>();
  private seenCritical: Set<string> | null = null; // null until the first render (don't announce what was already there)
  private expanded = false;
  private readonly timers = new Set<number>();

  constructor(private ctx: Ctx) {
    this.el.className = 'dc-alerts';
    this.el.setAttribute('aria-label', 'Alerts');
    this.el.tabIndex = -1; // focus target when the focused slip goes away
    this.grid.className = 'dc-al-grid';
    this.live.className = 'dc-sr';
    this.live.setAttribute('aria-live', 'polite');
    this.empty.className = 'dc-al-slip dc-al-empty';
    this.empty.setAttribute('role', 'note');
    this.empty.innerHTML = '<span class="dc-al-tab" aria-hidden="true">◎</span><p class="dc-al-txt"><b class="dc-al-word">All quiet</b> — the house runs itself.</p>';
    this.more.addEventListener('click', () => { this.expanded = !this.expanded; this.layout(); });
    this.grid.append(this.more, this.empty);
    this.el.append(this.grid, this.live);
  }

  render(snap: Snap): void {
    const now = performance.now();
    for (const [id, until] of this.snoozed) if (until <= now) this.snoozed.delete(id);
    for (const [id, a] of this.acted) if (now - a.t > ACTED_MS) this.acted.delete(id);
    const list = snap.alerts.filter((a) => !this.snoozed.has(a.id));
    const ids = new Set(list.map((a) => a.id));

    // announce newly appeared critical alerts only
    const crit = new Set(list.filter((a) => a.severity === 'critical').map((a) => a.id));
    if (this.seenCritical) {
      const fresh = list.filter((a) => crit.has(a.id) && !this.seenCritical!.has(a.id));
      if (fresh.length) this.live.textContent = fresh.map((a) => `Act now: ${a.text}`).join(' ');
    }
    this.seenCritical = crit;

    // gone: stamp if we acted on it, otherwise drop
    for (const [id, slip] of this.slips) {
      if (ids.has(id) || slip.stamping) continue;
      const acted = this.acted.get(id);
      if (acted && !this.snoozed.has(id)) this.stamp(slip, acted.mark);
      else this.drop(id);
    }

    for (const a of list) {
      let slip = this.slips.get(a.id);
      if (slip?.stamping) { this.drop(a.id); slip = undefined; } // came back mid-stamp: show it live again
      if (!slip) { slip = this.make(a); this.slips.set(a.id, slip); }
      this.patch(slip, a);
    }

    // new order = snapshot order, with stamping slips held at their previous index so the stamp doesn't jump
    const next = list.map((a) => a.id);
    this.order.forEach((id, i) => { if (this.slips.get(id)?.stamping) next.splice(Math.min(i, next.length), 0, id); });
    this.order = next;
    this.layout();
  }

  private layout(): void {
    const total = this.order.length;
    if (total <= ROW) this.expanded = false;
    const cap = this.expanded ? total : Math.min(total, ROW);
    this.order.forEach((id, i) => {
      const el = this.slips.get(id)!.el;
      if (this.grid.children[i] !== el) this.grid.insertBefore(el, this.grid.children[i] ?? null);
      el.hidden = i >= cap;
    });
    this.more.hidden = total <= ROW;
    set(this.more, this.expanded ? 'Show less' : `+${total - cap} more`);
    this.el.classList.toggle('has-more', total > ROW && !this.expanded);
    this.more.setAttribute('aria-expanded', String(this.expanded));
    this.empty.hidden = total > 0;
    this.el.classList.toggle('expanded', this.expanded);
  }

  private make(a: Alert): Slip {
    const el = document.createElement('article');
    el.className = 'dc-al-slip';
    const tab = document.createElement('span'); tab.className = 'dc-al-tab'; tab.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div'); body.className = 'dc-al-body';
    // head line: severity word · fix · rule · snooze; then the cause, clamped to 2 lines (full text in title + aria-label)
    const head = document.createElement('div'); head.className = 'dc-al-head';
    const sevWord = document.createElement('b'); sevWord.className = 'dc-al-word';
    const fix = btn('btn small dc-al-fix', '');
    const rule = btn('btn small ghost dc-al-rule', '掟 Rule');
    rule.setAttribute('aria-label', 'Make it a rule'); rule.title = 'Make it a house rule (掟) so this never comes back';
    const snooze = btn('dc-al-snooze', 'zZ');
    snooze.setAttribute('aria-label', 'Snooze for 2 minutes'); snooze.title = 'Snooze — hide for 2 minutes';
    const alt = btn('btn small ghost dc-al-alt', ''); // secondary: unlock the area right here
    head.append(sevWord, fix, alt, rule, snooze);
    const p = document.createElement('p'); p.className = 'dc-al-txt';
    const pre = document.createElement('span'), post = document.createElement('span');
    const who = btn('dc-al-who', '');
    const ings = document.createElement('span'); ings.className = 'dc-al-ings';
    p.append(ings, pre, who, post);
    const note = document.createElement('p'); note.className = 'dc-al-note'; note.hidden = true; note.textContent = RESTOCK_NOTE;
    note.setAttribute('role', 'note');
    body.append(head, p, note);
    el.append(tab, body);
    const slip: Slip = { a, el, sevGlyph: tab, sevWord, txt: p, ings, pre, who, post, fix, alt, rule, note, stamping: false };

    const { store } = this.ctx;
    const hoverOn = () => { if (slip.a.restIds.length === 1) store.set({ hover: slip.a.restIds[0] }); };
    const hoverOff = () => { if (slip.a.restIds.length === 1 && store.st.hover === slip.a.restIds[0]) store.set({ hover: null }); };
    who.addEventListener('mouseenter', hoverOn); who.addEventListener('focus', hoverOn);
    who.addEventListener('mouseleave', hoverOff); who.addEventListener('blur', hoverOff);
    who.addEventListener('click', () => {
      const ids = slip.a.restIds;
      if (ids.length === 1) this.ctx.opts.openRestaurant(ids[0]);
      else { store.st.selected = new Set(ids); store.touchSelected(); }
    });
    fix.addEventListener('click', () => {
      const a = slip.a;
      if (a.fix) { if (run(fix, applyFix(this.ctx.host.s, a))) this.act(a.id, '済'); }
      else if (a.propId) this.ctx.opts.buyLot(a.propId); // opens the concept picker; no stamp (the buy may be cancelled)
      else if (a.areaId) store.set({ area: a.areaId }); // map switches region + zooms itself
    });
    alt.addEventListener('click', () => {
      const id = slip.a.areaId;
      if (id && run(alt, unlockDistrict(this.ctx.host.s, id), 'success')) this.act(slip.a.id, '済');
    });
    rule.addEventListener('click', () => {
      const r = slip.a.rule;
      if (r === 'autoRestock') { // global: no per-restaurant rule to flip — show the guidance popover
        note.hidden = !note.hidden; rule.setAttribute('aria-expanded', String(!note.hidden)); return;
      }
      if (r && run(rule, applyRule(this.ctx.host.s, r, slip.a.restIds), 'success')) this.act(slip.a.id, '掟');
    });
    snooze.addEventListener('click', () => {
      this.snoozed.set(slip.a.id, performance.now() + SNOOZE_MS);
      const i = this.order.indexOf(slip.a.id);
      this.drop(slip.a.id);
      this.order.splice(i, 1);
      this.layout();
      // keep keyboard users in the rail: next slip's first button, else the rail itself
      const nextEl = this.slips.get(this.order[Math.min(i, this.order.length - 1)])?.el;
      (nextEl?.querySelector<HTMLElement>('button:not([hidden])') ?? this.el).focus();
    });
    return slip;
  }

  private patch(slip: Slip, a: Alert): void {
    const prevRule = slip.a.rule;
    slip.a = a;
    const sev = SEV[a.severity];
    if (slip.el.dataset.sev !== a.severity) slip.el.dataset.sev = a.severity;
    set(slip.sevGlyph, sev.glyph);
    set(slip.sevWord, sev.word);
    // stock: "Low on 🍚 Rice · Nori +k" from a.ingredients (what the restock fix buys); the core text's list is cut at 3 + "…"
    const ingIds = a.ingredients ?? [];
    const k = ingIds.join(',');
    if (slip.ings.dataset.k !== k) {
      slip.ings.dataset.k = k;
      slip.ings.innerHTML = ingIds.length ? 'Low on ' + ingIds.slice(0, 3).map((i) => `<span class="dc-al-ing"><span aria-hidden="true">${ingIcon(i)}</span> ${esc(INGREDIENTS[i].name)}</span>`).join(' · ')
        + (ingIds.length > 3 ? ` <span class="dc-al-ingk">+${ingIds.length - 3}</span>` : '') : '';
    }
    const colon = a.text.indexOf(': ');
    const rest = ingIds.length && colon >= 0 ? a.text.slice(colon) : a.text; // the text after the icon list
    const full = ingIds.length ? `Low on ${listOf(ingIds)}${rest}` : a.text;
    const label = `${sev.word}: ${full}`;
    if (slip.el.getAttribute('aria-label') !== label) slip.el.setAttribute('aria-label', label);
    if (slip.txt.title !== full) slip.txt.title = full;

    // restaurant(s): the text starts with the name / "N restaurants" — make that prefix the button
    const s = this.ctx.host.s;
    const n = a.restIds.length;
    const whoText = n === 1 ? (s.restaurants[a.restIds[0]]?.name ?? '') : n > 1 ? `${n} restaurants` : '';
    slip.who.hidden = !whoText;
    set(slip.who, whoText);
    const aria = n === 1 ? `Open ${whoText}` : `Select these ${n} restaurants in the ledger`;
    if (whoText && slip.who.getAttribute('aria-label') !== aria) slip.who.setAttribute('aria-label', aria);
    if (whoText && rest.startsWith(whoText)) { set(slip.pre, ''); set(slip.post, rest.slice(whoText.length)); }
    else { set(slip.pre, whoText ? `${rest} ` : rest); set(slip.post, ''); }

    // primary: the alert's fix, else buy the lot, else show the new area on the map
    const lot = a.propId ? PROPERTIES[a.propId] : undefined, area = a.areaId ? AREAS[a.areaId] : undefined;
    const fixText = a.fix ? (a.fix.cost > 0 ? `${a.fix.label} · ${yen(a.fix.cost)}` : a.fix.label)
      : lot ? `Pick a concept · ${lot.name}` : area ? 'Show on map' : '';
    slip.fix.hidden = !fixText;
    set(slip.fix, fixText);
    const fixLong = a.fix?.id === 'restock' && ingIds.length ? `Restock ${listOf(ingIds)} for 1 day, ${yen(a.fix.cost)}` : fixText;
    if (slip.fix.title !== fixLong) slip.fix.title = fixLong; // may ellipsize in a narrow slip
    if (slip.fix.getAttribute('aria-label') !== fixLong) slip.fix.setAttribute('aria-label', fixLong);
    slip.fix.classList.toggle('poor', s.cash < (a.fix?.cost ?? lot?.price ?? 0));
    slip.fix.classList.toggle('gold', !a.fix && !!fixText); // growth actions in kin, not shu
    slip.alt.hidden = !area;
    if (area) {
      const altText = `Unlock · ${yen(area.unlock.cost)}`;
      set(slip.alt, altText);
      const altAria = `Unlock ${area.name} for ${yen(area.unlock.cost)}`;
      if (slip.alt.getAttribute('aria-label') !== altAria) slip.alt.setAttribute('aria-label', altAria);
    }
    slip.rule.hidden = !a.rule;
    if (a.rule !== prevRule) { slip.note.hidden = true; slip.rule.removeAttribute('aria-expanded'); }
  }

  private act(id: string, mark: '済' | '掟'): void {
    this.acted.set(id, { mark, t: performance.now() });
    this.ctx.refresh();
  }

  private stamp(slip: Slip, mark: '済' | '掟'): void {
    slip.stamping = true;
    if (slip.el.contains(document.activeElement)) this.el.focus();
    slip.el.inert = true;
    slip.el.dataset.stamp = mark;
    slip.el.classList.add('done');
    slip.el.setAttribute('aria-label', `${mark === '掟' ? 'Handled by a house rule' : 'Resolved'}: ${slip.a.text}`);
    this.acted.delete(slip.a.id);
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      if (this.slips.get(slip.a.id) !== slip) return;
      this.drop(slip.a.id);
      this.order = this.order.filter((id) => id !== slip.a.id);
      this.layout();
    }, STAMP_MS);
    this.timers.add(t);
  }

  private drop(id: string): void {
    const slip = this.slips.get(id);
    if (!slip) return;
    if (slip.el.contains(document.activeElement)) this.el.focus();
    if (slip.a.restIds.length === 1 && this.ctx.store.st.hover === slip.a.restIds[0] && slip.who.matches(':hover, :focus')) this.ctx.store.set({ hover: null });
    slip.el.remove();
    this.slips.delete(id);
  }

  destroy(): void {
    for (const t of this.timers) clearTimeout(t);
    this.el.remove();
  }
}
