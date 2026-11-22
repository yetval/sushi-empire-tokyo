// Daichō 台帳 — alert rail: the inbox of paper slips at the bottom of the dashboard.
// Slips are keyed by alert.id, built once and patched per snapshot. Acting on a slip stamps it 済
// when the alert disappears from the next snapshot. Snooze lives in this part's memory only.
import { audio } from '../../audio/audio';
import { unlockDistrict } from '../../core/actions';
import { AREAS, PROPERTIES } from '../../core/data';
import { Alert, Severity, applyFix } from '../../core/empire';
import { yen } from '../../core/format';
import { run } from '../dom';
import { coinBurst, punch } from '../fx';
import { icon } from '../icons';
import './alerts.css';
import { Ctx, Part, Snap } from './shared';

// glyph is markup (innerHTML)
const SEV: Record<Severity, { glyph: string; word: string }> = {
  critical: { glyph: icon('close', 12), word: 'Act now' }, warning: { glyph: '△', word: 'Soon' }, opportunity: { glyph: icon('sparkle', 13), word: 'Chance' },
};
const ROW = 3; // collapsed rail = one row of 3 slips (+ a compact "+N" tile)
const SNOOZE_MS = 120_000;
const STAMP_MS = 1500;
const ACTED_MS = 20_000; // keep "we acted" around a little while, in case the alert clears a tick later

interface Slip {
  a: Alert; el: HTMLElement; sevGlyph: HTMLElement; sevWord: HTMLElement;
  txt: HTMLElement; pre: HTMLElement; who: HTMLButtonElement; post: HTMLElement;
  fix: HTMLButtonElement; alt: HTMLButtonElement;
  stamping: boolean;
}

/** "A, B and C" */
const listOf = (n: string[]) => n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] ?? '';
const set = (e: HTMLElement, text: string) => { if (e.textContent !== text) e.textContent = text; };
const btn = (cls: string, text: string) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.textContent = text;
  return b;
};

export class AlertRail implements Part {
  readonly el = document.createElement('section');
  private readonly grid = document.createElement('div');
  private readonly more = btn('btn dc-al-more', '');
  private readonly empty = document.createElement('div');
  private readonly live = document.createElement('div');
  private readonly slips = new Map<string, Slip>();
  private order: string[] = [];
  private readonly snoozed = new Map<string, number>(); // id → until (performance.now)
  private readonly acted = new Map<string, number>(); // id → when we acted (performance.now)
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
    for (const [id, t] of this.acted) if (now - t > ACTED_MS) this.acted.delete(id);
    const list = snap.alerts.filter((a) => !this.snoozed.has(a.id));
    const ids = new Set(list.map((a) => a.id));

    // announce newly appeared critical alerts only
    const crit = new Set(list.filter((a) => a.severity === 'critical').map((a) => a.id));
    if (this.seenCritical) {
      const fresh = list.filter((a) => crit.has(a.id) && !this.seenCritical!.has(a.id));
      if (fresh.length) { this.live.textContent = fresh.map((a) => `Act now: ${a.text}`).join(' '); audio.sfx('alert'); }
    }
    this.seenCritical = crit;

    // gone: stamp if we acted on it, otherwise drop
    for (const [id, slip] of this.slips) {
      if (ids.has(id) || slip.stamping) continue;
      if (this.acted.has(id) && !this.snoozed.has(id)) this.stamp(slip);
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
    el.className = 'dc-al-slip pop-in';
    el.addEventListener('animationend', () => el.classList.remove('pop-in'), { once: true });
    const tab = document.createElement('span'); tab.className = 'dc-al-tab'; tab.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div'); body.className = 'dc-al-body';
    // head line: severity word · fix · snooze; then the cause, clamped to 2 lines (full text in title + aria-label)
    const head = document.createElement('div'); head.className = 'dc-al-head';
    const sevWord = document.createElement('b'); sevWord.className = 'dc-al-word';
    const fix = btn('btn small dc-al-fix', '');
    const snooze = btn('btn small ghost dc-al-snooze', 'zZ');
    snooze.setAttribute('aria-label', 'Snooze for 2 minutes'); snooze.title = 'Snooze — hide for 2 minutes';
    const alt = btn('btn small primary dc-al-alt', ''); // unlock the area right here (a spend = primary)
    head.append(sevWord, fix, alt, snooze);
    const p = document.createElement('p'); p.className = 'dc-al-txt';
    const pre = document.createElement('span'), post = document.createElement('span');
    const who = btn('dc-al-who', '');
    p.append(pre, who, post);
    body.append(head, p);
    el.append(tab, body);
    const slip: Slip = { a, el, sevGlyph: tab, sevWord, txt: p, pre, who, post, fix, alt, stamping: false };

    const { store } = this.ctx;
    const hoverOn = () => { if (slip.a.restIds.length === 1) store.set({ hover: slip.a.restIds[0] }); };
    const hoverOff = () => { if (slip.a.restIds.length === 1 && store.st.hover === slip.a.restIds[0]) store.set({ hover: null }); };
    who.addEventListener('mouseenter', hoverOn); who.addEventListener('focus', hoverOn);
    who.addEventListener('mouseleave', hoverOff); who.addEventListener('blur', hoverOff);
    who.addEventListener('click', () => { if (slip.a.restIds.length === 1) this.ctx.opts.openRestaurant(slip.a.restIds[0]); });
    fix.addEventListener('click', () => {
      const a = slip.a;
      if (a.fix) {
        if (run(fix, applyFix(this.ctx.host.s, a), a.fix.cost > 0 ? 'purchase' : 'coin')) { punch(fix); if (a.fix.cost > 0) coinBurst(fix, 12); this.act(a.id); }
      } else if (a.propId) { punch(fix); this.ctx.opts.buyLot(a.propId); } // opens the concept picker; no stamp (the buy may be cancelled)
      else if (a.areaId) store.set({ area: a.areaId }); // map switches region + zooms itself
    });
    alt.addEventListener('click', () => {
      const id = slip.a.areaId;
      if (id && run(alt, unlockDistrict(this.ctx.host.s, id), 'purchase')) { punch(alt); coinBurst(alt, 12); this.act(slip.a.id); }
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
    slip.a = a;
    const sev = SEV[a.severity];
    if (slip.el.dataset.sev !== a.severity) { slip.el.dataset.sev = a.severity; slip.sevGlyph.innerHTML = sev.glyph; }
    set(slip.sevWord, sev.word);
    // several restaurants: name them in the tooltip / label (the text itself only says "N restaurants")
    const s = this.ctx.host.s;
    const n = a.restIds.length;
    const full = n > 1 ? `${a.text} (${listOf(a.restIds.map((id) => s.restaurants[id]?.name ?? id))})` : a.text;
    const label = `${sev.word}: ${full}`;
    if (slip.el.getAttribute('aria-label') !== label) slip.el.setAttribute('aria-label', label);
    if (slip.txt.title !== full) slip.txt.title = full;

    // one restaurant: the text starts with its name, make that prefix a button that opens it
    const whoText = n === 1 ? (s.restaurants[a.restIds[0]]?.name ?? '') : '';
    slip.who.hidden = !whoText;
    set(slip.who, whoText);
    const aria = `Open ${whoText}`;
    if (whoText && slip.who.getAttribute('aria-label') !== aria) slip.who.setAttribute('aria-label', aria);
    if (whoText && a.text.startsWith(whoText)) { set(slip.pre, ''); set(slip.post, a.text.slice(whoText.length)); }
    else { set(slip.pre, whoText ? `${a.text} ` : a.text); set(slip.post, ''); }

    // primary: the alert's fix, else buy the lot, else show the new area on the map
    const lot = a.propId ? PROPERTIES[a.propId] : undefined, area = a.areaId ? AREAS[a.areaId] : undefined;
    const fixText = a.fix ? (a.fix.cost > 0 ? `${a.fix.label} · ${yen(a.fix.cost)}` : a.fix.label)
      : lot ? `Pick a concept · ${lot.name}` : area ? 'Show on map' : '';
    slip.fix.hidden = !fixText;
    set(slip.fix, fixText);
    if (slip.fix.title !== fixText) slip.fix.title = fixText; // may ellipsize in a narrow slip
    slip.fix.classList.toggle('poor', s.cash < (a.fix?.cost ?? lot?.price ?? 0));
    // colour = what the press does: act / spend (primary green), navigate (brand vermilion). Gold = rewards only.
    const nav = !a.fix && !lot && !!area;
    slip.fix.classList.toggle('primary', !nav);
    slip.fix.classList.toggle('brand', nav);
    slip.alt.hidden = !area;
    if (area) {
      const altText = `Unlock · ${yen(area.unlock.cost)}`;
      set(slip.alt, altText);
      const altAria = `Unlock ${area.name} for ${yen(area.unlock.cost)}`;
      if (slip.alt.getAttribute('aria-label') !== altAria) slip.alt.setAttribute('aria-label', altAria);
    }
  }

  private act(id: string): void {
    this.acted.set(id, performance.now());
    this.ctx.refresh();
  }

  private stamp(slip: Slip): void {
    slip.stamping = true;
    if (slip.el.contains(document.activeElement)) this.el.focus();
    slip.el.inert = true;
    slip.el.classList.add('done');
    slip.el.setAttribute('aria-label', `Resolved: ${slip.a.text}`);
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
