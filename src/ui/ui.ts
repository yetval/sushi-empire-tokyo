// UI root: HUD, title screen, modal stack and every in-game window.
import { AREAS } from '../core/data';
import '@fontsource/dela-gothic-one/400.css';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/zen-maru-gothic/900.css';
import './stack.css';
import * as THREE from 'three';
import { audio } from '../audio/audio';
import { on, toast } from '../core/bus';
import * as A from '../core/actions';
import { CONCEPTS, ConceptId, DISTRICTS, DISTRICT_IDS, DistrictId, PROPERTIES, milestone } from '../core/data';
import { clockStr, duration, exact, short, yen, yenExact } from '../core/format';
import * as sim from '../core/sim';
import { DEFAULT_AVATAR } from '../core/state';
import { claimQuest, streakBonus } from '../core/quests';
import { bar, delegate, el, esc, fail, patch, run, stars } from './dom';
import { ICON_IDS, IconId, icon } from './icons';
import { coinBurst, floatText, punch, rollNumber } from './fx';
import { UIHost } from './host';
import { Manage, Tab } from './manage';
import { Sheet, SheetTab, conceptCards } from './sheet';
import * as E from '../core/empire';

interface Modal { kind: string; el: HTMLElement; onClose: () => void; update?: (dt: number) => void; prev?: Element | null }
let uid = 0;

const PORTRAITS: Record<string, IconId> = { 'Grandpa Kenji': 'person', Mika: 'chef', 'Mr. Sato': 'briefcase', 'Ryo Tanaka': 'angry', 'Madame Aoki': 'note' };
// Hand-drawn HUD glyphs (authored SVG, one stroke weight).
const ICON = {
  day: '<svg viewBox="0 0 26 26" fill="none" stroke="#c8322a" stroke-width="2.2" stroke-linecap="round"><circle cx="13" cy="13" r="5.2" fill="#c8322a"/><path d="M13 2.5v3M13 20.5v3M2.5 13h3M20.5 13h3M5.6 5.6l2.1 2.1M18.3 18.3l2.1 2.1M5.6 20.4l2.1-2.1M18.3 7.7l2.1-2.1"/></svg>',
  dusk: '<svg viewBox="0 0 26 26" fill="none" stroke="#c8322a" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 17a6.5 6.5 0 0 1 13 0Z" fill="#e8873a" stroke="#c8322a"/><path d="M2.5 17h21M5 21h16M13 5.5v3M5.5 9.5l2 1.8M20.5 9.5l-2 1.8"/></svg>',
  night: '<svg viewBox="0 0 26 26"><path d="M17.5 3.5a9.5 9.5 0 1 0 5 15.5A8 8 0 0 1 17.5 3.5Z" fill="#3a2e26"/><circle cx="20" cy="7" r="1.1" fill="#c99a3c"/><circle cx="23" cy="11.5" r=".8" fill="#c99a3c"/></svg>',
  pause: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3.4 1.6v8.8M8.6 1.6v8.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 10 12" width="9" height="12" aria-hidden="true"><path d="M1.6 1.4c2.6 1.4 5 2.9 7.2 4.6-2.2 1.7-4.6 3.2-7.2 4.6z" fill="currentColor"/></svg>',
  maki: '<svg class="nori" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#1f3a2a" stroke="#000" stroke-width="1"/><circle cx="13" cy="13" r="9" fill="#f6eedd"/><circle cx="13" cy="13" r="4.4" fill="#ff8a5c"/><path d="M10.5 11.5l5 3" stroke="#ffb89a" stroke-width="1.2"/></svg>',
};
const TITLE_JA: Record<string, string> = { continue: '続きから', new: '新しく始める', settings: '設定', credits: 'クレジット' };

// Tutorial steps (game.ts tutorialObjective 0..5): seal icon + short card title. The instruction text comes from the game.
const TUTORIAL: [IconId, string, string][] = [
  ['walk', 'Find your stand', 'tut'], ['chef', 'Hire your first chef', 'tut'], ['nigiri', 'Make the first sale', 'tut'],
  ['server', 'Hire a server', 'tut'], ['tools', 'Buy an upgrade', 'tut'], ['shop', 'Open a second shop', 'tut'],
];
/** Card dressing for the free-play objective line (game.ts dynamicObjective); presentation only. */
const objectiveMeta = (t: string): [IconId, string, string] =>
  /no chef/.test(t) ? ['chef', 'A kitchen is idle', 'warn']
    : /attention/.test(t) ? ['warn', 'Shops need you', 'warn']
      : /second restaurant|New market/.test(t) ? ['map', 'Grow the empire', 'goal']
        : /Chapter 2/.test(t) ? ['crown', 'Chapter 2', 'goal'] : ['target', 'Next milestone', 'goal'];
const cashFmt = (n: number) => (Math.abs(n) < 1e7 ? yenExact(n) : yen(n));

const portrait = (name: string) => icon(PORTRAITS[name] ?? Object.entries(PORTRAITS).find(([k]) => name.startsWith(k.split(' ')[0]))?.[1] ?? 'person', 52, { variant: 'seal' });

export class UI {
  private root: HTMLElement;
  private stack: Modal[] = [];
  private hud!: HTMLElement;
  private q = <T extends HTMLElement>(sel: string) => this.hud.querySelector<T>(sel)!;
  private cashWin = 0; // seconds of small cash changes waiting to roll in as one
  private restSt: { last?: string } = {};
  private promptText: string | null = '';
  private objText: string | null | undefined = undefined;
  private slowT = 0;
  private manage: Manage | null = null;
  private title: HTMLElement | null = null;
  private sheet: Sheet | null = null;
  private alertT = 9;
  private iconKey = '';
  private flapStr = '';
  private questSt: { last?: string } = {};
  private questsOpen = false;
  private toastBox!: HTMLElement;
  private toastQ: [string, string, string | undefined, string | undefined][] = [];

  constructor(private host: UIHost) {
    this.root = document.getElementById('ui-root') ?? document.body.appendChild(el('div'));
    this.root.id = 'ui-root';
    this.buildHud();
    this.wireBus();
    // hover ticks on anything pressable (once per element entered)
    let hov: Element | null = null;
    document.addEventListener('pointerover', (e) => { const b = (e.target as Element).closest?.('button:not(:disabled), .btn, [data-act]') ?? null; if (b && b !== hov) audio.sfx('hover'); hov = b; });
  }

  // ================================================================ modal stack
  private push(m: Modal): Modal {
    m.prev = document.activeElement;
    const e = m.el;
    e.setAttribute('role', 'dialog');
    e.setAttribute('aria-modal', 'true');
    const h = e.querySelector('h2');
    if (h) { h.id ||= `dlg-h-${++uid}`; e.setAttribute('aria-labelledby', h.id); }
    e.tabIndex = -1;
    if (!e.dataset.trap) {
      e.dataset.trap = '1';
      e.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Tab') return;
        const f = [...e.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((x) => x.offsetParent !== null || x instanceof SVGElement);
        if (!f.length) { ev.preventDefault(); return; }
        const a = document.activeElement, first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && (a === first || a === e)) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && a === last) { ev.preventDefault(); first.focus(); }
      });
    }
    this.root.append(e);
    this.stack.push(m);
    this.syncInert();
    requestAnimationFrame(() => {
      e.classList.add('open');
      // the speech panel owns Space/E — focus the frame itself there, not a button
      const first = m.kind === 'dialog' ? null
        : ['.tab[aria-current]', '.stab[aria-current]', '.modal-body button:not([disabled]), .modal-body input, .modal-body select, .modal-body textarea', '.tab-body button', 'button:not(.x)', '[tabindex="0"]']
          .map((q) => e.querySelector<HTMLElement>(q)).find(Boolean) ?? null;
      (first ?? e).focus({ preventScroll: true });
    });
    return m;
  }
  /** While any window is open the 3D view and HUD leave the accessibility tree and tab order. */
  private syncInert(): void {
    const on = this.stack.length > 0;
    const canvas = document.getElementById('game');
    if (canvas) canvas.inert = on;
    this.hud.inert = on;
  }
  private remove(m: Modal, callClose = true): void {
    const i = this.stack.indexOf(m);
    if (i < 0) return;
    audio.sfx('close');
    this.stack.splice(i, 1);
    if (callClose) m.onClose();
    m.el.classList.remove('open'); m.el.classList.add('closing');
    setTimeout(() => { m.el.remove(); m.el.classList.remove('closing'); }, 200);
    this.syncInert();
    const prev = m.prev as HTMLElement | null;
    if (prev && prev !== document.body && prev.isConnected && !prev.closest('[inert], .closing')) prev.focus({ preventScroll: true });
    else {
      // the original target vanished (e.g. a re-rendered list): land in the window underneath instead of <body>
      const top = this.stack[this.stack.length - 1]?.el;
      // prefer the active tab; never an arbitrary button (a stray Enter on the close button would close the window)
      const tab = top?.querySelector<HTMLElement>('.tab[aria-current], .stab[aria-current]');
      if (top && !tab && !top.hasAttribute('tabindex')) top.tabIndex = -1; // make the window itself focusable
      (tab ?? top)?.focus({ preventScroll: true });
    }
  }
  private has(kind: string) { return this.stack.find((m) => m.kind === kind); }

  /** Standard modal window with header and body. */
  private window(kind: string, title: string, width: number, onClose: () => void = () => {}): { m: Modal; body: HTMLElement } {
    const e = el('div', 'modal ' + kind);
    e.innerHTML = `<div class="panel" style="width:min(${width}px,94vw)"><div class="modal-head"><h2>${title}</h2><button class="x" aria-label="Close" title="Close">${icon('close', 18)}</button></div><div class="modal-body" tabindex="0"></div></div>`;
    const m: Modal = { kind, el: e, onClose };
    e.querySelector('.x')!.addEventListener('click', () => { audio.sfx('click'); this.remove(m); });
    e.addEventListener('pointerdown', (ev) => { if (ev.target === e) this.remove(m); });
    return { m, body: e.querySelector('.modal-body')! };
  }

  isBlocking(): boolean { return this.stack.length > 0; }
  closeTop(): boolean {
    const m = this.stack[this.stack.length - 1];
    if (!m) return false;
    audio.sfx('click');
    this.remove(m);
    return true;
  }

  // ================================================================ HUD
  private buildHud(): void {
    this.hud = el('div', 'hud hidden');
    this.hud.innerHTML = `
      <div class="hud-tl">
        <div class="panel money"><span class="coin" aria-hidden="true">¥</span><div class="m-main"><div class="amt num lg" id="h-cash"></div><div class="m-sub"><span id="h-today"></span><span class="who" id="h-title"></span></div></div></div>
        <div class="panel objective" role="group" aria-label="Current objective"><span class="qc-seal" id="h-obj-seal" aria-hidden="true"></span><div class="qc-main"><div class="qc-top"><span class="qc-k" id="h-obj-k"></span><span class="qc-steps" id="h-obj-steps" aria-hidden="true"></span></div><div class="qc-t" id="h-obj-t"></div><div class="qc-txt" id="h-obj" aria-live="polite"></div></div></div>
        <div id="h-quests"></div>
      </div>
      <div class="hud-tc"><div class="panel sushi-count" aria-live="off"><div class="n">${ICON.maki}<span class="flaps" id="h-flaps" role="img" aria-label="pieces sold"></span><span class="goal" id="h-goal"></span></div><div class="meter sm" id="h-mbar" style="--pc: var(--c-money)"><i></i></div><div class="next" id="h-next"></div></div></div>
      <div class="hud-tr">
        <div class="hud-time">
          <div class="panel clock"><span class="icon" id="h-icon" aria-hidden="true"></span><div class="c-main"><div class="c-top"><span class="c-day" id="h-day"></span><span id="h-open"></span></div><div class="t num lg" id="h-time"></div></div></div>
          <div class="speed hud-click" id="h-speed" role="group" aria-label="Time speed">
            <button class="btn small" data-act="spd" data-arg="0" aria-label="Pause" title="Pause">${ICON.pause}</button><button class="btn small" data-act="spd" data-arg="1" aria-label="Normal speed" title="Normal speed (1)">${ICON.play}</button><button class="btn small" data-act="spd" data-arg="2" aria-label="Double speed" title="Double speed (2)">${ICON.play.repeat(2)}</button><button class="btn small" data-act="spd" data-arg="4" aria-label="Quadruple speed" title="Quadruple speed (3)">${ICON.play.repeat(3)}</button></div>
        </div>
        <button class="alert-pill hud-click" id="h-alerts" hidden></button>
        <div id="h-rest"></div>
      </div>
      <div class="panel prompt" id="h-prompt"><kbd class="kbd">E</kbd><span id="h-prompt-t"></span></div>
      <div class="hints" aria-label="Keyboard shortcuts"><span><kbd class="kbd">Tab</kbd>Manage</span><span><kbd class="kbd">M</kbd>Map</span><span><kbd class="kbd">Esc</kbd>Pause</span><span><kbd class="kbd">Shift</kbd>Sprint</span></div>`;
    this.root.append(this.hud);
    this.toastBox = el('div', 'toasts');
    this.toastBox.setAttribute('role', 'status'); this.toastBox.setAttribute('aria-live', 'polite');
    this.root.append(this.toastBox); // outside the HUD so it never goes inert behind windows
    delegate(this.q('#h-speed'), {
      spd: (v) => {
        const n = Number(v);
        audio.sfx('click');
        if (!n) { this.host.setPaused(!(this.host as unknown as { paused?: boolean }).paused); return; }
        this.host.setPaused(false); this.host.setSpeed(n as 1 | 2 | 4);
      },
    });
    this.q('#h-alerts').addEventListener('click', () => { audio.sfx('click'); this.toggleManage(Object.keys(this.host.s.restaurants).length >= 2 ? 'daicho' : undefined); });
    delegate(this.q('#h-quests'), {
      qtoggle: () => { this.questsOpen = !this.questsOpen; this.questSt.last = undefined; audio.sfx('click'); },
      claim: (id, b) => {
        if (!run(b, claimQuest(this.host.s.quests, this.host.s, id), 'coin')) return;
        punch(b); coinBurst(b, 12);
        this.questSt.last = undefined; toast('Request complete — reward collected!', 'good', 'check');
      },
    });
    // restaurant card call to action: straight to the Staff tab of the shop you're standing in
    delegate(this.q('#h-rest'), { hire: (id) => { audio.sfx('click'); this.openRestaurant(id, 'staff'); } });
  }

  /** Compact daily-request slip under the objective note. */
  private questsHtml(): string {
    const s = this.host.s, q = s.quests;
    if (!q?.list?.length || s.tutorial < 6) return '';
    const num = (v: number, t: number) => (Number.isInteger(t) ? short(Math.min(v, t)) : Math.min(v, t).toFixed(1));
    const rows = q.list.map((x) => {
      const failed = !!x.meta?.failed && !x.done;
      const right = x.claimed ? '<i class="mini-stamp">済</i>' : x.done ? `<button class="btn small gold" data-act="claim" data-arg="${esc(x.id)}">Claim</button>`
        : failed ? '<span class="tiny bad">missed</span>' : `<span class="qn">${num(x.progress, x.target)}/${num(x.target, x.target)}</span>`;
      return `<li class="${x.claimed ? 'claimed' : x.done ? 'done' : failed ? 'failed' : ''}" title="${esc(x.desc)}"><span class="qt">${esc(x.title)}</span>${right}
        ${!x.done && !failed ? bar(x.progress / x.target, 'gold') : ''}</li>`;
    }).join('');
    const b = streakBonus(q, s);
    const done = q.list.filter((x) => x.done).length, hot = q.list.some((x) => x.done && !x.claimed);
    const pill = `<button class="q-pill hud-click ${hot ? 'hot' : ''}" data-act="qtoggle" aria-expanded="${this.questsOpen}">依頼 ${done}/${q.list.length} <span aria-hidden="true">${this.questsOpen ? '▾' : '▸'}</span>${hot ? '<span class="sr-only"> — a reward is ready to claim</span>' : ''}</button>`;
    if (!this.questsOpen) return pill;
    return `${pill}<div class="panel quests hud-click"><div class="qh"><b>本日の依頼</b><span>Daily requests</span><span class="streak" title="Days in a row with every request claimed">連続 ${q.streak}</span></div>
      <ul>${rows}</ul><div class="qf">Claim all three: +${yen(b.cash)} · +${b.rp} RP</div></div>`;
  }

  private wireBus(): void {
    on('toast', (t) => this.toast(t.text, t.kind ?? 'info', t.icon));
    on('money', (m) => this.floatMoney(m.amount, m.x, m.y, m.z));
    on('sale', (e) => { if (e.customerId === null) return; this.q('.money').classList.remove('pulse'); void this.q('.money').offsetWidth; this.q('.money').classList.add('pulse'); });
    on('milestone', (m) => this.banner(m.title, `${short(m.pieces)} pieces sold · ${m.text}`));
    on('dayEnd', (d) => {
      // operating profit only: one-off purchases (hires, upgrades, lots, research) arrive separately as `invested`
      const p = d.revenue - d.expenses, inv = d.invested;
      this.toast(`Day ${d.day} closed · ${p >= 0 ? '+' : '−'}${yen(Math.abs(p))} operating profit`, p >= 0 ? 'good' : 'bad', 'moon',
        `${yen(d.revenue)} in · ${yen(d.expenses)} out${inv > 0 ? ` · ${yen(inv)} invested` : ''} · ${short(d.pieces)} pcs`);
    });
  }

  /**
   * Toasts: at most 3 on screen; a toast like the newest one (same kind, icon and first word, e.g. "Grand opening: …")
   * merges into it with a ×N count. While a centred window is open only errors show (they're feedback for that window);
   * the rest wait in a queue and arrive when it closes.
   */
  private toast(text: string, kind: string, ico?: string, meta?: string): void {
    if (kind !== 'bad' && this.stack.some((m) => m.kind !== 'sheet' && m.kind !== 'dialog')) { this.toastQ.push([text, kind, ico, meta]); return; }
    const box = this.toastBox;
    // only known icon ids draw (legacy emoji strings from unswept callers fall back to the kind's icon)
    const id: IconId = ico && ICON_IDS.includes(ico as IconId) ? ico as IconId : kind === 'bad' ? 'warn' : kind === 'gold' ? 'trophy' : kind === 'good' ? 'check' : 'bell';
    const key = `${kind}|${id}|${text.split(' ')[0]}`;
    const body = `<span class="t-txt">${meta ? `<b>${esc(text)}</b><span class="t-meta">${esc(meta)}</span>` : esc(text)}</span>`;
    const same = box.firstElementChild as HTMLElement | null;
    let t: HTMLElement;
    if (same && same.dataset.key === key && !same.classList.contains('out')) {
      t = same;
      const n = Number(t.dataset.n ?? 1) + 1;
      t.dataset.n = String(n);
      t.querySelector('.t-txt')!.outerHTML = body;
      t.querySelector('.t-n')!.textContent = `×${n}`;
      t.classList.add('multi');
      clearTimeout(Number(t.dataset.timer));
      punch(t);
    } else {
      t = el('div', 'toast ' + kind, `<span class="t-ico" aria-hidden="true">${icon(id, 20)}<b class="t-n"></b></span>${body}`);
      t.dataset.key = key;
      box.prepend(t);
      while (box.children.length > 3) box.lastElementChild!.remove();
    }
    audio.sfx('pop', 0.5);
    t.dataset.timer = String(setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 450); }, kind === 'gold' ? 6500 : 4500));
  }

  private floatMoney(amount: number, x?: number, y?: number, z?: number): void {
    if (!this.host.started || amount === 0) return;
    let sx = 120, sy = 70;
    if (x !== undefined && y !== undefined && z !== undefined) {
      const v = new THREE.Vector3(x, y, z).project(this.host.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return;
      sx = (v.x + 1) / 2 * innerWidth; sy = (1 - v.y) / 2 * innerHeight;
    }
    const f = el('div', 'float-money' + (amount < 0 ? ' bad' : ''), `${amount > 0 ? '+' : ''}${yenExact(Math.round(amount))}`);
    f.style.left = sx + 'px'; f.style.top = sy + 'px';
    this.root.append(f);
    setTimeout(() => f.remove(), 1650);
  }

  private banner(t: string, r: string): void {
    const b = el('div', 'banner', `<div class="seal" aria-hidden="true">祝</div><div class="k">Milestone reached</div><div class="t">${esc(t)}</div><div class="r">${esc(r)}</div>`);
    this.hud.append(b);
    setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 650); }, 4500);
  }

  /** Split-flap counter: only changed characters flip. */
  private flaps(str: string): void {
    if (str === this.flapStr) return;
    const box = this.q('#h-flaps');
    this.flapStr = str;
    box.setAttribute('aria-label', `${str} pieces sold`);
    const chars = [...str];
    if (box.children.length !== chars.length) {
      box.innerHTML = chars.map((c) => `<span class="flap${/[.,]/.test(c) ? ' sep' : /\d/.test(c) ? '' : ' unit'}"><b>${c}</b></span>`).join('');
      return;
    }
    chars.forEach((c, i) => {
      const f = box.children[i] as HTMLElement;
      if (f.textContent === c) return;
      f.firstElementChild!.textContent = c;
      f.classList.remove('flip'); void f.offsetWidth; f.classList.add('flip');
    });
  }

  setPrompt(t: string | null): void {
    if (t === this.promptText) return;
    this.promptText = t;
    if (t) this.q('#h-prompt-t').textContent = t;
    this.q('#h-prompt').classList.toggle('show', !!t);
  }

  /** Quest card: seal, title, one line of instruction; tutorial steps get "Step n of 6" and step pips. */
  setObjective(t: string | null): void {
    const step = this.host.s.tutorial, key = `${step < 99 ? step : ''}|${t}`;
    if (key === this.objText) return;
    const first = !this.objText?.split('|')[1];
    this.objText = key;
    const card = this.q('.objective');
    card.style.display = t ? '' : 'none';
    if (!t) return;
    const [ico, title, kind] = step < TUTORIAL.length ? TUTORIAL[step] : objectiveMeta(t);
    this.q('#h-obj').textContent = t;
    this.q('#h-obj-t').textContent = title;
    this.q('#h-obj-seal').innerHTML = icon(ico, 30, { variant: 'seal' });
    this.q('#h-obj-k').textContent = step < TUTORIAL.length ? `Step ${step + 1} of ${TUTORIAL.length}` : kind === 'warn' ? 'Needs you' : 'Next goal';
    this.q('#h-obj-steps').innerHTML = step < TUTORIAL.length ? TUTORIAL.map((_, i) => `<i class="${i < step ? 'done' : i === step ? 'on' : ''}"></i>`).join('') : '';
    card.className = `panel objective ${kind}`;
    if (!first) { card.classList.remove('pop-in'); void card.offsetWidth; card.classList.add('pop-in'); }
  }

  update(dt: number): void {
    const s = this.host.s;
    this.hud.classList.toggle('hidden', !this.host.started);
    for (const m of this.stack) m.update?.(dt);
    if (this.toastQ.length && !this.stack.some((m) => m.kind !== 'sheet' && m.kind !== 'dialog')) for (const q of this.toastQ.splice(0)) this.toast(...q);
    if (!this.host.started) return;
    if (this.title) this.hideTitle();
    // money: roll only when it changes. Small moves (sales, wages) gather for ~1s and roll in as one "+¥" float;
    // purchases and windfalls roll at once. rollNumber keeps the shown target in dataset.n.
    const cashEl = this.q('#h-cash'), shown = Number(cashEl.dataset.n ?? NaN), d = s.cash - shown;
    if (!Number.isFinite(shown)) rollNumber(cashEl, s.cash, cashFmt);
    else if (d === 0) this.cashWin = 0;
    else {
      const spendNow = d < 0 && -d >= Math.max(1, Math.abs(shown) * 0.01), windfall = d > Math.abs(shown) * 0.25;
      if ((this.cashWin += dt) >= 1 || spendNow || windfall) {
        this.cashWin = 0;
        if (Math.abs(d) > Math.max(1, Math.abs(s.cash) * 0.002)) audio.sfx('tick', 0.5);
        rollNumber(cashEl, s.cash, cashFmt, d > 0 ? 800 : 450);
        if ((d >= 1 || spendNow) && !this.stack.length) { // no floats over open windows
          // rise in the open sky just right of the money plate, never over the digits
          const r = this.q('.money').getBoundingClientRect();
          floatText({ x: r.right + 64, y: r.top + 56 }, (d > 0 ? '+' : '−') + cashFmt(Math.abs(d)), d > 0 ? 'gold' : 'bad');
        }
      }
    }
    this.slowT += dt;
    if (this.slowT < 0.25) return;
    this.slowT = 0;
    const tp = s.today.revenue - s.today.expenses;
    this.q('#h-today').innerHTML = `<span class="chip ${tp >= 0 ? 'p-upgrade' : 'p-danger'}">${tp >= 0 ? '+' : ''}${yen(tp)} today</span>`;
    this.q('#h-title').textContent = `${s.player.title ? s.player.title + ' · ' : ''}${s.player.name} of ${s.player.company}`;
    // sushi counter
    const p = s.lifetime.pieces, m = sim.nextMilestone(s);
    const prev = s.milestoneIndex ? milestone(s.milestoneIndex - 1).pieces : 0;
    this.flaps(p < 1e6 ? exact(p) : short(p));
    this.q('#h-goal').textContent = `/ ${p < 1e6 ? '1,000,000' : short(m.pieces)}`;
    this.q('#h-next').innerHTML = `Next: <b>${esc(m.title)}</b> at ${p < 1e6 ? exact(m.pieces) : short(m.pieces)}`;
    (this.q('#h-mbar').firstElementChild as HTMLElement).style.width = `${Math.max(0, Math.min(1, (p - prev) / (m.pieces - prev))) * 100}%`;
    // clock
    const h = s.minute / 60;
    const sky = h >= 6 && h < 17.5 ? 'day' : h >= 17.5 && h < 19.5 ? 'dusk' : 'night';
    if (this.iconKey !== sky) { this.iconKey = sky; this.q('#h-icon').innerHTML = ICON[sky]; }
    this.q('#h-time').textContent = clockStr(s.minute);
    const open = sim.isOpen(s.minute);
    this.q('#h-day').textContent = `Day ${s.day}`;
    this.q('#h-open').innerHTML = open ? '<span class="chip p-upgrade">営業中 Open</span>' : '<span class="chip">Closed · opens 07:00</span>';
    patch(this.q('#h-quests'), this.questsHtml(), this.questSt);
    // speed keys
    const paused = !!(this.host as unknown as { paused?: boolean }).paused;
    this.q('#h-speed').querySelectorAll<HTMLElement>('button').forEach((b) => {
      const n = Number(b.dataset.arg), on = n === 0 ? paused : !paused && this.host.speed === n;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    // alert pill (alerts() scans every restaurant, so ~1 Hz)
    if ((this.alertT += 0.25) >= 1) {
      this.alertT = 0;
      const al = E.alerts(s), crit = al.filter((a) => a.severity === 'critical').length, warn = al.filter((a) => a.severity === 'warning').length;
      const pill = this.q('#h-alerts');
      pill.hidden = !(crit + warn) || s.tutorial < 6;
      pill.className = `alert-pill hud-click ${crit ? 'crit' : 'warn'}`;
      pill.innerHTML = `<b aria-hidden="true">${crit ? '急' : '注'}</b>${crit + warn} ${crit + warn === 1 ? 'issue' : 'issues'}${crit ? ` · ${crit} urgent` : ''}`;
      pill.setAttribute('aria-label', `${crit + warn} business issues${crit ? `, ${crit} urgent` : ''}. Open management.`);
    }
    // restaurant card: who's working, and a hire call to action when the shop can't sell
    const site = this.host.currentSite(), r = site ? s.restaurants[site] : undefined;
    let rh = '';
    if (site && r) {
      const auto = sim.isAutomated(s, site), thin = auto && sim.understaffed(s, site);
      const status = !auto ? '<span class="chip p-danger">No chef · not selling</span>' : thin ? '<span class="chip p-money">Short-handed</span>' : '<span class="chip p-upgrade">Crew on shift · selling</span>';
      const cta = !auto ? `<button class="btn primary hud-click rc-cta" data-act="hire" data-arg="${esc(site)}">${icon('chef', 18)}Hire a chef</button>`
        : thin ? `<button class="btn primary small hud-click rc-cta" data-act="hire" data-arg="${esc(site)}">${icon('server', 16)}Hire a server</button>` : '';
      rh = `<div class="card rest-card${auto ? '' : ' idle'}"><div class="rc-top">${icon('shop', 26, { variant: 'seal' })}<div class="rc-id"><div class="nm">${esc(r.name)}</div>
        <div class="rc-rep">${stars(r.reputation)}<span class="tiny muted">${r.reputation.toFixed(1)}</span></div></div></div><div class="rc-status">${status}</div>${cta}</div>`;
    }
    patch(this.q('#h-rest'), rh, this.restSt);
  }

  // ================================================================ title screen
  showMainMenu(): void {
    this.title?.remove();
    const t = el('main', 'title');
    this.title = t;
    const save = this.host.hasSave();
    const big = (act: string, ic: IconId, label: string, cls: string) =>
      `<button class="btn big ${cls}" data-act="${act}">${icon(ic, 30, { variant: 'seal' })}<span class="tb-l">${label}<span class="ja">${TITLE_JA[act]}</span></span></button>`;
    const key = (k: string, what: string) => `<span><span class="kbd dark">${k}</span>${what}</span>`;
    t.innerHTML = `<div class="title-left">
        <div class="lockup">
          <span class="lk-jp" aria-hidden="true">寿司帝国</span>
          <h1 class="logo"><span class="l1">SUSHI<span class="lk-seal">${icon('nigiri', 92, { variant: 'seal' })}</span></span><span class="l2">EMPIRE</span><span class="jp"><b>TOKYO</b><i>東京</i></span></h1>
        </div>
        <p class="tagline">Start small. Sell a million. Build an empire.</p>
        <div class="title-menu">
          ${save ? big('continue', 'noren', 'Continue', 'brand') : ''}
          ${big('new', 'shop', 'New Game', save ? '' : 'brand')}
          <div class="title-sub">
            <button class="btn" data-act="settings">${icon('gear', 18)}Settings<span class="ja">${TITLE_JA.settings}</span></button>
            <button class="btn" data-act="credits">${icon('scroll', 18)}Credits<span class="ja">${TITLE_JA.credits}</span></button>
          </div>
        </div>
        <div class="title-foot">${key('WASD', 'move')}${key('Drag', 'camera')}${key('E', 'interact')}${key('Tab', 'manage')}${key('M', 'map')}</div>
      </div><div class="title-right"><div class="title-panel"></div></div>`;
    const panel = t.querySelector<HTMLElement>('.title-panel')!;
    const showPanel = (html: string, head = '', cls = 'p-info') => {
      panel.innerHTML = html ? `<div class="panel ${cls}">${head}<div class="tp-body">${html}</div></div>` : '';
    };
    const head = (ic: IconId, title: string, ja = '') => `<div class="seal-h">${icon(ic, 30, { variant: 'seal' })}<h2>${title}${ja ? ` <span class="ja">${ja}</span>` : ''}</h2></div>`;
    const back = (label = 'Back') => `<button type="button" class="btn ghost" data-act="back">${label}</button>`;
    const nameCo = () => {
      showPanel(`<p class="tp-lede">You own a little street stand in Asakusa and enough yen for your first chef.</p>
        <form class="nc-form" novalidate>
          <div class="nc-sign" aria-hidden="true"><span class="nc-co-t">Sushi Empire</span><span class="nc-own">Chef, owner · 浅草</span></div>
          <div class="nc-f"><label for="nc-co">Company</label><span class="nc-n" id="nc-co-n">0 / 28</span>
            <input id="nc-co" type="text" maxlength="28" placeholder="Sushi Empire" autocomplete="off" spellcheck="false" data-in="nc" aria-describedby="nc-co-n nc-hint"></div>
          <div class="nc-f"><label for="nc-name">Your name</label><span class="nc-n" id="nc-name-n">0 / 20</span>
            <input id="nc-name" type="text" maxlength="20" placeholder="Chef" autocomplete="off" spellcheck="false" data-in="nc" aria-describedby="nc-name-n nc-hint"></div>
          <p class="nc-hint" id="nc-hint" aria-live="polite">Leave a field blank to keep the suggested name.</p>
          <div class="tp-actions">${back()}<button type="submit" class="btn big brand" data-act="start">${icon('noren', 22)}Open the stand</button></div>
        </form>`, head('pencil', 'Name your company', '社名'));
      (panel.querySelector('#nc-co') as HTMLInputElement).focus();
    };
    // live sign preview + counters; blank or spaces-only falls back to the default (the same rule start() applies)
    const ncInput = () => {
      const f = (id: string, max: number, dflt: string) => {
        const i = panel.querySelector<HTMLInputElement>(id)!, v = i.value.trim(), n = panel.querySelector(id + '-n')!;
        n.textContent = `${i.value.length} / ${max}`;
        n.classList.toggle('full', i.value.length >= max);
        i.setAttribute('aria-invalid', String(!!i.value && !v));
        return v || dflt;
      };
      const raw = panel.querySelector<HTMLInputElement>('#nc-co')!.value.trim();
      const co = f('#nc-co', 28, 'Sushi Empire'), nm = f('#nc-name', 20, 'Chef');
      panel.querySelector('.nc-co-t')!.textContent = co;
      panel.querySelector('.nc-own')!.textContent = `${nm}, owner · 浅草`;
      panel.querySelector('.nc-sign')!.classList.toggle('dflt', !raw);
      const bad = !!panel.querySelector('[aria-invalid=true]'), hint = panel.querySelector('#nc-hint')!;
      hint.classList.toggle('bad', bad);
      hint.textContent = bad ? 'Spaces alone don’t make a name. That field will use the suggested one.' : 'Leave a field blank to keep the suggested name.';
    };
    t.addEventListener('submit', (e) => e.preventDefault()); // Enter in a name field = implicit click on "Open the stand"
    delegate(t, {
      continue: () => { audio.sfx('press'); this.hideTitle(); this.host.continueGame(); },
      new: () => {
        audio.sfx('press');
        if (this.host.hasSave()) showPanel(`<p class="tp-lede">This replaces your current empire (<b>${exact(this.host.s.lifetime.pieces)}</b> pieces sold).</p>
          <p class="nc-hint">Tip: export your save first from the pause menu.</p>
          <div class="tp-actions">${back('Cancel')}<button class="btn danger" data-act="confirmnew">${icon('warn', 18)}Yes, new game</button></div>`, head('warn', 'Start over?'), 'p-danger');
        else nameCo();
      },
      confirmnew: () => { audio.sfx('click'); nameCo(); },
      back: () => { audio.sfx('click'); showPanel(''); },
      start: () => {
        const v = (id: string) => (panel.querySelector(id) as HTMLInputElement).value.trim();
        const company = v('#nc-co') || 'Sushi Empire', name = v('#nc-name') || 'Chef';
        audio.sfx('success');
        this.hideTitle();
        this.host.newGame({ name, company, avatar: { ...DEFAULT_AVATAR } });
      },
      settings: () => { audio.sfx('click'); showPanel(`${this.settingsHtml()}<div class="tp-actions">${back()}</div>`, head('gear', 'Settings', TITLE_JA.settings)); },
      credits: () => {
        audio.sfx('click');
        showPanel(`<p><b>Sushi Empire: Tokyo</b> — an original game.</p>
          <p class="small">All 3D models (characters, buildings, sushi) are generated procedurally in code. All music and sound effects are synthesized live with the Web Audio API.</p>
          <p class="small">Built with <b>three.js</b> (MIT License) and <b>Vite</b>. Fonts: <b>Dela Gothic One</b> (Artakana) and <b>Zen Maru Gothic</b> (Yoshimichi Ohira), SIL Open Font License 1.1, bundled via @fontsource.</p>
          <p class="small muted">No assets were copied from any other game. Tokyo locations are stylized, fictionalized versions of real neighborhoods.</p>
          <div class="tp-actions">${back()}</div>`, head('scroll', 'Credits', TITLE_JA.credits));
      },
    }, { ...this.settingsInputs(), nc: ncInput });
    this.root.append(t);
  }

  private hideTitle(): void {
    const t = this.title;
    if (!t) return;
    t.inert = true;
    t.classList.add('out');
    this.title = null;
    setTimeout(() => t.remove(), 600);
  }

  // ================================================================ settings (shared)
  private settingsHtml(): string {
    const st = this.host.s.settings;
    const rng = (k: string, label: string, v: number, min = 0, max = 1, step = 0.05) =>
      `<label class="slider"><span class="lbl">${label}</span><output class="val">${this.settingVal(k, v)}</output><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-in="set" data-k="${k}" aria-valuetext="${this.settingVal(k, v)}" style="--v:${((v - min) / (max - min)) * 100}%"></label>`;
    const sw = (k: 'muted' | 'invertY', label: string) =>
      `<label class="switch"><input type="checkbox" data-in="set" data-k="${k}" ${st[k] ? 'checked' : ''}>${label}</label>`;
    const sec = (ic: IconId, title: string, body: string) => `<section class="set-sec"><div class="seal-h">${icon(ic, 28, { variant: 'seal' })}<h3>${title}</h3></div>${body}</section>`;
    return `<div class="settings">
      ${sec('sound', 'Sound', `${rng('master', 'Master volume', st.master)}${rng('music', 'Music', st.music)}${rng('sfx', 'Sound effects', st.sfx)}${sw('muted', 'Mute all')}`)}
      <div class="set-col">
        ${sec('camera', 'Camera', `${rng('sensitivity', 'Sensitivity', st.sensitivity, 0.3, 2.5, 0.1)}${sw('invertY', 'Invert camera Y')}`)}
        ${sec('tv', 'Graphics', `<div class="seg" role="radiogroup" aria-label="Graphics quality">${['low', 'medium', 'high'].map((q) => `<label><input type="radio" name="set-quality" value="${q}" data-in="set" data-k="quality" ${st.quality === q ? 'checked' : ''}><span>${q[0].toUpperCase() + q.slice(1)}</span></label>`).join('')}</div>`)}
      </div></div>`;
  }
  private settingVal(k: string, v: number): string { return k === 'sensitivity' ? `×${v}` : `${Math.round(v * 100)}%`; }
  private settingsInputs() {
    return {
      set: (v: string, e: HTMLInputElement) => {
        const st = this.host.s.settings as any, k = e.dataset.k!;
        st[k] = e.type === 'checkbox' ? v === 'true' : k === 'quality' ? v : Number(v);
        if (e.type === 'range') {
          const n = Number(v), min = Number(e.min), max = Number(e.max);
          e.setAttribute('aria-valuetext', this.settingVal(k, n));
          e.style.setProperty('--v', `${((n - min) / (max - min)) * 100}%`);
          const out = e.parentElement?.querySelector('.val');
          if (out) out.textContent = this.settingVal(k, n);
        }
        this.host.applySettings();
        if (e.type !== 'range') audio.sfx('click');
      },
    };
  }

  // ================================================================ management
  toggleManage(tab?: string): void {
    const open = this.has('manage');
    // owner-first: one restaurant → its sheet; an empire → the ledger dashboard
    if (!tab && !open && Object.keys(this.host.s.restaurants).length < 2) {
      if (this.has('sheet')) { this.closeTop(); return; }
      this.openRestaurant(this.host.currentSite() ?? Object.keys(this.host.s.restaurants)[0]);
      return;
    }
    if (open && (!tab || this.manage!.tab === tab)) { this.remove(open); return; }
    if (!this.manage) {
      let m!: Modal;
      this.manage = new Manage(this.host, () => this.remove(m), { openRestaurant: (id) => this.openRestaurant(id), buyLot: (id) => this.openProperty(id) });
      m = { kind: 'manage', el: this.manage.el, onClose: () => this.manage!.leave(), update: (dt) => this.manage!.update(dt) };
      (this.manage as any)._modal = m;
    }
    const m = (this.manage as any)._modal as Modal;
    this.manage.show((tab as Tab) || (Object.keys(this.host.s.restaurants).length >= 2 ? 'daicho' : undefined));
    if (!open) { audio.sfx('whoosh'); this.push(m); }
  }

  /** Restaurant altitude: the side sheet for one location. */
  openRestaurant(id: string, tab?: SheetTab): void {
    if (!this.host.s.restaurants[id]) return;
    const open = this.has('sheet');
    if (open) { this.sheet!.setRestaurant(id, tab); return; }
    let m!: Modal;
    this.sheet = new Sheet(this.host, id, () => this.remove(m), () => this.toggleManage(Object.keys(this.host.s.restaurants).length >= 2 ? 'daicho' : 'empire'));
    if (tab) this.sheet.show(tab);
    m = { kind: 'sheet', el: this.sheet.el, onClose: () => { this.sheet = null; }, update: (dt) => this.sheet?.update(dt) };
    audio.sfx('whoosh');
    this.push(m);
  }


  // ================================================================ city map
  openMap(): void {
    if (this.has('map')) return;
    const { m, body } = this.window('map', 'Tokyo Metro · 路線図', 1080);
    let sel: DistrictId = this.host.s.player.district;
    // Octilinear metro diagram. Station codes follow the real line-letter + number convention.
    const ST: Record<DistrictId, { x: number; y: number; code: string; color: string; lx: number; ly: number; anchor: string }> = {
      shinjuku: { x: 170, y: 200, code: 'M08', color: '#e60012', lx: -34, ly: -8, anchor: 'end' },
      shibuya: { x: 170, y: 360, code: 'G01', color: '#f39700', lx: -34, ly: -8, anchor: 'end' },
      ginza: { x: 560, y: 400, code: 'G09', color: '#f39700', lx: 0, ly: 54, anchor: 'middle' },
      asakusa: { x: 650, y: 140, code: 'G19', color: '#f39700', lx: 34, ly: -8, anchor: 'start' },
    };
    const render = () => {
      const s = this.host.s;
      const dists = DISTRICT_IDS.map((d) => {
        const st = ST[d], def = DISTRICTS[d], open = s.districts.includes(d), here = s.player.district === d;
        const owned = Object.keys(s.restaurants).filter((r) => PROPERTIES[r].district === d).length;
        const ring = open ? st.color : '#a59886';
        return `<g class="dist ${sel === d ? 'sel' : ''} ${open ? '' : 'locked'}" data-act="pick" data-arg="${d}" transform="translate(${st.x},${st.y})" role="button" tabindex="0" aria-pressed="${sel === d}" aria-label="${def.name}${open ? '' : ', locked'}${here ? ', you are here' : ''}${owned ? `, ${owned} owned` : ''}">
          ${sel === d ? '<circle class="halo" r="38"/>' : ''}
          <circle r="29" fill="#1f1b17"/>
          <circle class="ring" r="23" fill="#fffdf7" stroke="${ring}" stroke-width="8" ${open ? '' : 'stroke-dasharray="7 4"'}/>
          <text y="-3" text-anchor="middle" font-size="13" fill="#1f1b17">${st.code[0]}</text><text y="12" text-anchor="middle" font-size="12" fill="#1f1b17">${st.code.slice(1)}</text>
          <g class="lbl" transform="translate(${st.lx},${st.ly})">
            <text class="jp" text-anchor="${st.anchor}" font-size="24" fill="${open ? '#1f1b17' : '#6f6256'}">${def.jp}</text>
            <text y="20" text-anchor="${st.anchor}" font-size="14" fill="${open ? '#5b5047' : '#6f6256'}">${def.name}${open ? '' : ' · locked'}</text></g>
          ${owned ? `<g class="lot" transform="translate(${st.anchor === 'start' ? -24 : 24},-24)"><circle r="13" fill="#e2b04b" stroke="#1f1b17" stroke-width="3"/><text y="5" text-anchor="middle" font-size="14" fill="#1f1b17">${owned}</text></g>` : ''}
          ${!open ? `<g transform="translate(24,-24)"><circle r="12" fill="#fffdf7" stroke="#1f1b17" stroke-width="2.5"/><g transform="translate(-8,-8) scale(.67)" fill="none" stroke="#1f1b17" stroke-width="2.6" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></g></g>` : ''}
          ${here ? `<g class="here" transform="translate(0,-42)"><path d="M-26,-20 h52 v19 h-19 l-7,9 l-7,-9 h-19z" fill="#1f1b17" stroke="#fffdf7" stroke-width="2"/><text y="-6" text-anchor="middle" font-size="12" fill="#fbf7ee">現在地</text></g>` : ''}</g>`;
      }).join('');
      const d = DISTRICTS[sel], open = s.districts.includes(sel), here = s.player.district === sel;
      const props = Object.values(PROPERTIES).filter((p) => p.district === sel);
      const ownedN = props.filter((p) => s.restaurants[p.id]).length;
      const pct = Math.min(100, (s.lifetime.pieces / Math.max(1, d.unlock.pieces)) * 100);
      const ready = s.lifetime.pieces >= d.unlock.pieces && s.cash >= d.unlock.cost;
      const line = (c: string, y: number, label: string) => `<path d="M34,${y} h26" stroke="#1f1b17" stroke-width="10" stroke-linecap="round"/><path d="M34,${y} h26" stroke="${c}" stroke-width="6" stroke-linecap="round"/><text x="72" y="${y + 4}">${label}</text>`;
      body.innerHTML = `<div class="map-wrap"><svg class="map-svg" viewBox="0 0 800 520" role="group" aria-label="Tokyo metro map — choose a district">
          <path d="M700,0 C690,90 720,150 700,230 C680,310 730,380 700,520" fill="none" stroke="#d6dcc4" stroke-width="46"/>
          <text class="geo" x="736" y="300" font-size="12" fill="#55633f" transform="rotate(-80 736 300)">隅田川 Sumida River</text>
          <path d="M520,520 Q620,470 800,480 V520Z" fill="#d6dcc4"/><text class="geo" x="690" y="508" font-size="12" fill="#55633f">東京湾 Tokyo Bay</text>
          <rect x="370" y="250" width="110" height="70" rx="14" fill="#e1e6cc"/><text class="geo" x="425" y="290" text-anchor="middle" font-size="12" fill="#4f5a3a">皇居 Imperial Palace</text>
          <rect x="170" y="110" width="480" height="320" rx="80" fill="none" stroke="#1f1b17" stroke-width="13"/><rect x="170" y="110" width="480" height="320" rx="80" fill="none" stroke="#80c241" stroke-width="8"/>
          <path d="M170,200 H420 L560,340 V400" fill="none" stroke="#1f1b17" stroke-width="13" stroke-linejoin="round"/><path d="M170,200 H420 L560,340 V400" fill="none" stroke="#e60012" stroke-width="8" stroke-linejoin="round"/>
          <path d="M170,360 H420 L460,400 H560 L650,310 V140" fill="none" stroke="#1f1b17" stroke-width="13" stroke-linejoin="round"/><path d="M170,360 H420 L460,400 H560 L650,310 V140" fill="none" stroke="#f39700" stroke-width="8" stroke-linejoin="round"/>
          <g class="legend" font-size="13" fill="#1f1b17"><rect x="18" y="18" width="172" height="92" rx="12" fill="#fffdf7" stroke="#1f1b17" stroke-width="3"/>
            ${line('#f39700', 42, 'Ginza Line')}${line('#e60012', 64, 'Marunouchi Line')}${line('#80c241', 86, 'Yamanote Line')}</g>
          ${dists}</svg>
        <div class="map-side">
          <div class="panel ${open ? 'p-info' : 'p-expand'}"><div class="seal-h">${icon(open ? 'torii' : 'lock', 28, { variant: 'seal' })}<h3>${d.jp} ${d.name}</h3>${here ? '<span class="chip on">現在地 · here</span>' : open ? '<span class="chip p-upgrade">Open</span>' : '<span class="chip">Locked</span>'}</div>
            <div class="pad"><p class="small">${d.blurb}</p>
              <div class="map-stats"><div><span class="k">${icon('walk', 16)} Foot traffic</span><span class="num ink">${d.traffic}<small>/min</small></span></div><div><span class="k">${icon('yen', 16)} Price sensitivity</span><span class="num ink">×${d.elasticity}</span></div></div>
              ${open ? '' : `<div class="map-req"><div class="spread small"><b>Pieces sold</b><span>${exact(Math.min(s.lifetime.pieces, d.unlock.pieces))} / ${exact(d.unlock.pieces)}</span></div><div class="meter sm" style="--pc: var(--c-expand)"><i style="width:${pct}%"></i></div>
                <div class="spread small"><b>Business permit</b><span>${yen(d.unlock.cost)}</span></div></div>`}
            </div></div>
          ${open ? (here ? '' : `<button class="btn big brand" data-act="go" data-arg="${sel}">${icon('train', 22)} Travel to ${d.name}</button>`)
            : `<button class="btn big primary ${ready ? '' : 'poor'}" data-act="unlock" data-arg="${sel}">${icon('lock', 20)} Unlock · ${yen(d.unlock.cost)}</button>`}
          <div class="card map-props"><div class="seal-h">${icon('shop', 28, { variant: 'seal' })}<h3>Lots</h3><span class="chip">${ownedN} / ${props.length} owned</span></div>
            ${props.map((p) => { const r = s.restaurants[p.id]; return `<div class="prop-row"><span class="nm">${icon(r ? 'shop' : 'tag', 16)} ${esc(r?.name ?? p.name)}</span>${r ? '<span class="chip p-upgrade">Owned</span>' : `<span class="chip p-money">${yen(p.price)}</span>`}</div>`; }).join('')}</div>
        </div></div>`;
    };
    body.addEventListener('keydown', (e) => {
      const g = (e.target as Element).closest?.('g.dist');
      if (!g || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      body.querySelector<SVGElement>(`g.dist[data-arg="${(g as SVGElement).dataset.arg}"]`)?.focus();
    });
    delegate(body, {
      pick: (d) => { sel = d as DistrictId; audio.sfx('pop'); render(); },
      go: (d) => { this.remove(m); this.host.travel(d as DistrictId); },
      unlock: (d, b) => { if (run(b, A.unlockDistrict(this.host.s, d as DistrictId), 'fanfare')) { coinBurst(b, 14); render(); const go = body.querySelector<HTMLElement>('[data-act="go"]'); if (go) punch(go); } },
    });
    render();
    audio.sfx('whoosh');
    this.push(m);
  }

  // ================================================================ property dialog
  /** Buy-lot dialog with a format picker. Used by For-Sale signs in the street and the empire ledger. */
  openProperty(propId: string): void {
    if (this.has('prop')) return;
    const p = PROPERTIES[propId], d = AREAS[p.district];
    if (this.host.s.restaurants[propId]) { this.openRestaurant(propId); return; }
    const { m, body } = this.window('prop', `売物件 For sale · ${esc(p.name)}`, 1200);
    let pick: ConceptId = p.kind === 'stand' ? 'stand' : 'bar';
    const st: { last?: string } = {};
    const render = () => {
      const s = this.host.s, open = s.districts.includes(p.district);
      const why = A.conceptAllowed(s, propId, pick);
      const total = p.price + A.fitoutCost(propId, pick);
      const c = CONCEPTS[pick];
      patch(body, `<div class="lot-head">
          <div class="lot-tag"><b>${d.jp} ${esc(d.name)}</b><span>${p.kind === 'stand' ? 'Street-stand lot' : `${p.kind[0].toUpperCase()}${p.kind.slice(1)} lot`} for sale</span></div>
          <dl class="lot-facts"><div><dt>Lot</dt><dd>${yen(p.price)}</dd></div><div><dt>Base rent</dt><dd>${yen(p.rent)}/day</dd></div><div><dt>Foot traffic</dt><dd>×${p.size}</dd></div>
            <div><dt>Seats</dt><dd>${p.seatsMax}</dd></div><div><dt>Chef slots</dt><dd>${p.chefSlots}</dd></div><div><dt>Area guests</dt><dd>${d.traffic}/min</dd></div></dl></div>
        ${open ? '' : `<div class="slip warning"><span class="sev">鍵</span><span class="txt">${esc(d.name)} is not open to you yet: ${exact(d.unlock.pieces)} pieces sold and a ${yen(d.unlock.cost)} permit.</span><button class="btn small gold" data-act="unlock">Unlock ${yen(d.unlock.cost)}</button></div>`}
        <h3 class="section">Choose a format 業態</h3><div class="concepts">${conceptCards(s, propId, pick, 'buy')}</div>
        <div class="buybar"><span>Open a <b>${c.name}</b> here: <b>${yen(total)}</b> now, then about <b>${yen(Math.round(p.rent * c.rent))}</b>/day rent plus staff.<small>${esc(c.desc)}</small></span>
          <button class="btn ghost" data-act="close">Not now</button>
          <button class="btn big primary ${s.cash < total ? 'poor' : ''}" data-act="buy" ${!open || why ? 'disabled' : ''}>${!open ? 'Area locked' : why ? esc(why) : s.cash < total ? `Need ${yen(total)}` : 'Sign the lease 契約'}</button></div>`, st);
    };
    delegate(body, {
      close: () => this.remove(m),
      pickc: (cid) => { pick = cid as ConceptId; audio.sfx('pop'); st.last = undefined; render(); },
      unlock: (_, b) => { if (run(b, A.unlockDistrict(this.host.s, p.district), 'fanfare')) { st.last = undefined; render(); } },
      buy: (_, b) => {
        if (run(b, A.buyProperty(this.host.s, propId, pick), 'purchase')) { punch(b); coinBurst(b, 16); this.remove(m); setTimeout(() => this.openRestaurant(propId, 'staff'), 250); }
      },
    });
    let t = 0;
    m.update = (dt) => { if ((t += dt) > 0.5) { t = 0; render(); } };
    render();
    this.push(m);
  }


  // ================================================================ pause
  openPause(): void {
    if (this.has('pause')) return;
    this.host.setPaused(true);
    const { m, body } = this.window('pause', 'Paused', 600, () => this.host.setPaused(false));
    const h2 = m.el.querySelector('h2')!;
    const view = (v: string) => {
      const sub: Record<string, string> = { settings: 'Settings', controls: 'Controls', export: 'Export save', import: 'Import save' };
      h2.textContent = sub[v] ?? 'Paused';
      const back = (extra = '') => `<div class="pz-foot"><button class="btn" data-act="v" data-arg="main">Back</button>${extra}</div>`;
      if (v === 'main') body.innerHTML = `<div class="pz">
          <button class="btn big brand" data-act="resume">Resume</button>
          <div class="pz-grid">
            <button class="btn pz-tile" data-act="v" data-arg="settings">${icon('gear', 22)} Settings</button>
            <button class="btn pz-tile" data-act="v" data-arg="controls">${icon('walk', 22)} Controls</button>
          </div>
          <section class="pz-sec"><div class="seal-h">${icon('save', 28, { variant: 'seal' })}<h3>Your save</h3><span class="chip">auto-saves every 20 s</span></div>
            <div class="pz-grid g3">
              <button class="btn small" data-act="save">${icon('save', 16)} Save now</button>
              <button class="btn small" data-act="v" data-arg="export">${icon('export', 16)} Export</button>
              <button class="btn small" data-act="v" data-arg="import">${icon('import', 16)} Import</button>
            </div></section>
          <button class="btn" data-act="quit">${icon('home', 18)} Save & main menu</button></div>`;
      else if (v === 'settings') body.innerHTML = this.settingsHtml() + back();
      else if (v === 'controls') body.innerHTML = `<div class="ctrl-list">${([
        [['W', 'A', 'S', 'D'], 'Walk (or the arrow keys)'], [['Shift'], 'Sprint'], [['Space'], 'Jump'], [['E'], 'Interact: your shop, people, the metro'], [['Drag'], 'Rotate camera'],
        [['Wheel'], 'Zoom'], [['Tab'], 'Business management'], [['M'], 'City map'], [['Esc'], 'Pause / close window']] as [string[], string][])
        .map(([k, d]) => `<div class="ctrl"><span class="keys">${k.map((x) => `<span class="kbd">${x}</span>`).join('')}</span><span>${d}</span></div>`).join('')}</div>${back()}`;
      else if (v === 'export') body.innerHTML = `<p class="small">Copy this code to back up your empire or move it to another browser:</p>
          <textarea class="code-box" readonly>${this.host.exportSave()}</textarea>${back(`<button class="btn" data-act="copy">${icon('clipboard', 16)} Copy</button>`)}`;
      else if (v === 'import') body.innerHTML = `<p class="small">Paste a save code. <b>This replaces your current game.</b></p><textarea class="code-box" id="imp"></textarea>
          ${back(`<button class="btn danger" data-act="import">${icon('warn', 16)} Import & reload</button>`)}`;
    };
    delegate(body, {
      v: (a) => { audio.sfx('click'); view(a); body.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true }); },
      resume: () => this.remove(m),
      save: (_, b) => {
        if (!this.host.save()) return fail(b, 'The browser could not save your game. Export a backup before leaving.');
        audio.sfx('success'); punch(b);
        toast('Game saved!', 'good', 'save');
      },
      quit: (_, b) => {
        if (!this.host.save()) return fail(b, 'The browser could not save your game. Export a backup before leaving.');
        location.reload();
      },
      copy: () => { const ta = body.querySelector('textarea')!; ta.select(); navigator.clipboard?.writeText(ta.value).catch(() => document.execCommand('copy')); audio.sfx('success'); toast('Save code copied!', 'good', 'clipboard'); },
      import: (_, b) => { const err = this.host.importSave((body.querySelector('#imp') as HTMLTextAreaElement).value); if (err) fail(b, err); },
    }, this.settingsInputs());
    view('main');
    audio.sfx('open');
    this.push(m);
  }

  // ================================================================ dialog
  dialog(speaker: string, lines: string[]): Promise<void> {
    return new Promise((resolve) => {
      const d = el('div', 'panel dialog');
      d.innerHTML = `<div class="portrait">${portrait(speaker)}</div><div class="dlg-body"><div class="who">${esc(speaker)}</div><div class="txt"></div></div><div class="more" aria-hidden="true"></div><div class="sr-only" aria-live="polite"></div>`;
      const txt = d.querySelector<HTMLElement>('.txt')!, more = d.querySelector<HTMLElement>('.more')!;
      let i = 0, shown = 0, timer = 0, finished = false;
      const typeLine = () => {
        shown = 0; clearInterval(timer);
        const line = lines[i];
        d.querySelector('.sr-only')!.textContent = `${speaker}: ${line}`;
        const last = i >= lines.length - 1;
        more.innerHTML = `<span class="pips">${lines.length > 1 ? lines.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('') : ''}</span>click or <span class="kbd">E</span>${last ? icon('check', 14) : '<i class="nx"></i>'}`;
        more.classList.toggle('last', last);
        timer = window.setInterval(() => {
          shown += 2; txt.textContent = line.slice(0, shown);
          if (shown >= line.length) clearInterval(timer);
          if (shown % 6 === 0) audio.sfx('pop', 0.15);
        }, 28);
      };
      const end = () => { if (finished) return; finished = true; clearInterval(timer); removeEventListener('keydown', key, true); resolve(); };
      const advance = () => {
        // clicks/keys that land while the box is closing (or after the last line) must not index past `lines`
        if (finished || i >= lines.length) return;
        if (shown < lines[i].length) { shown = lines[i].length; txt.textContent = lines[i]; clearInterval(timer); return; }
        i++;
        if (i >= lines.length) { this.remove(m); return; }
        audio.sfx('click'); typeLine();
      };
      const key = (e: KeyboardEvent) => {
        if (this.stack.at(-1) !== m || !['KeyE', 'Space', 'Enter'].includes(e.code)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) advance();
      };
      const m: Modal = { kind: 'dialog', el: d, onClose: end };
      d.addEventListener('click', advance);
      addEventListener('keydown', key, true);
      this.push(m);
      typeLine();
    });
  }

  // ================================================================ celebrations
  celebrateMillion(): void {
    const s = this.host.s, L = s.lifetime;
    const e = el('div', 'modal celebrate');
    const colors = ['#b82d25', '#e2b04b', '#5a8c3a', '#7b4d2c', '#f2b8c0', '#fbf7ee'];
    let conf = '';
    for (let i = 0; i < 90; i++) conf += `<i class="confetti" style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${3 + Math.random() * 4}s;animation-delay:${Math.random() * 3}s;transform:rotate(${Math.random() * 360}deg)"></i>`;
    const best = Object.values(s.restaurants).sort((a, b) => b.revenue - a.revenue)[0];
    const stat = (k: string, v: string, cls = '') => `<div class="cel-stat ${cls}"><span class="k">${k}</span><span class="num ink">${v}</span></div>`;
    const feat = (ic: IconId, t: string, d: string) => `<div class="card cel-feat">${icon(ic, 28)}<b>${t}</b><span class="small muted">${d}</span></div>`;
    e.innerHTML = conf + `<div class="panel">
      <div class="cel-hero"><div class="emperor">SUSHI EMPEROR</div>
        <div class="cel-count"><span class="num xl gold">1,000,000</span><span class="cel-unit">pieces of sushi sold</span></div>
        <p class="cel-lead">${esc(s.player.name)}, all of Tokyo is celebrating <b>${esc(s.player.company)}</b>!</p></div>
      <div class="cel-stats">
        ${stat('Days in business', String(s.day))}${stat('Revenue', yen(L.revenue))}${stat('Customers', short(L.customers))}${stat('Restaurants', String(Object.keys(s.restaurants).length))}
        ${stat('Employees', String(s.staff.length))}${stat('Play time', duration(s.playTime))}<div class="cel-stat wide"><span class="k">Top location</span><b class="best">${esc(best?.name ?? '—')}</b></div></div>
      <div class="card p-money cel-unlock">${icon('cat', 28, { variant: 'seal' })}<span><b>Unlocked: Golden Maneki-neko.</b> A shining lucky cat now waves at your first stand.</span></div>
      <div class="seal-h cel-ch2">${icon('book', 28, { variant: 'seal' })}<h3>Chapter 2: The Empire</h3><span class="chip p-money">${icon('target', 14)} Next goal 2,000,000</span></div>
      <div class="cel-feats">
        ${feat('shop', 'Franchising', 'Franchises across Tokyo sell sushi for you everywhere.')}
        ${feat('plane', 'International cities', 'Osaka, Kyoto, Seoul, Singapore, New York, London, Paris, Dubai.')}
        ${feat('office', 'Headquarters', 'A tower in Shinjuku that grows with your empire.')}
        ${feat('factory', 'Central Kitchen', 'Industrial production and logistics boost everything.')}</div>
      <div class="cel-foot"><button class="btn" data-act="empire">${icon('globe', 18)} Open Empire tab</button><button class="btn big brand" data-act="go">Continue building your empire</button></div></div>`;
    const m: Modal = { kind: 'celebrate', el: e, onClose: () => {} };
    delegate(e, {
      go: (_, b) => { audio.sfx('success'); coinBurst(b, 16); this.remove(m); },
      empire: () => { this.remove(m); this.toggleManage('empire'); },
    });
    this.push(m);
    audio.sfx('fanfare');
    // the reveal: coins burst off the big number as it lands, then off the title
    const count = e.querySelector('.cel-count .num')!, title = e.querySelector('.emperor')!;
    setTimeout(() => { if (e.isConnected) coinBurst(count, 26); }, 650);
    setTimeout(() => { if (!e.isConnected) return; const r = title.getBoundingClientRect(); coinBurst({ x: r.left + r.width * 0.15, y: r.top + r.height / 2 }, 14); coinBurst({ x: r.right - r.width * 0.15, y: r.top + r.height / 2 }, 14); }, 950);
  }

  showOffline(o: { seconds: number; pieces: number; revenue: number; expenses: number }): void {
    const { m, body } = this.window('offline', 'While you were away', 520);
    m.el.querySelector('.panel')!.classList.add('p-money');
    const net = o.revenue - o.expenses;
    const ln = (ic: IconId, k: string, v: string, cls: string) => `<div class="ln"><span class="k">${icon(ic, 18)} ${k}</span><span class="num ${cls}">${v}</span></div>`;
    body.innerHTML = `<p class="off-lead">You were gone for <b>${duration(o.seconds)}</b>. ${o.pieces ? 'Your managers and franchises kept the business running.' : 'Without managers your restaurants stayed closed, but rent and wages were still due.'}</p>
      <div class="off-ledger">
        ${ln('nigiri', 'Pieces sold', exact(o.pieces), 'ink')}${ln('yen', 'Revenue', `+${yenExact(o.revenue)}`, o.revenue ? 'good' : 'ink')}${ln('receipt', 'Expenses', `−${yenExact(o.expenses)}`, 'bad')}
        <div class="ln total"><span class="k">${icon('chart', 18)} Net</span><span class="num lg ${net >= 0 ? 'good' : 'bad'}">${net >= 0 ? '+' : '−'}${yenExact(Math.abs(net))}</span></div></div>
      <p class="tiny muted">Offline earnings need a Manager in a fully staffed restaurant and run at reduced efficiency (capped).</p>
      <div class="off-foot"><button class="btn big brand" data-act="ok">Let's go!</button></div>`;
    delegate(body, { ok: (_, b) => { if (net > 0) coinBurst(b, 12); this.remove(m); } });
    this.push(m);
  }
}
