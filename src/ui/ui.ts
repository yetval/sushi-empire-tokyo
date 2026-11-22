// UI root: HUD, title screen, modal stack and every in-game window.
import '@fontsource/dela-gothic-one/400.css';
import '@fontsource/zen-maru-gothic/500.css';
import '@fontsource/zen-maru-gothic/700.css';
import '@fontsource/zen-maru-gothic/900.css';
import * as THREE from 'three';
import { audio } from '../audio/audio';
import { on, toast } from '../core/bus';
import * as A from '../core/actions';
import { DISTRICTS, DISTRICT_IDS, DistrictId, EVENTS, INGREDIENTS, INGREDIENT_IDS, IngredientId, PROPERTIES, RECIPES, milestone } from '../core/data';
import { clockStr, duration, exact, short, yen, yenExact } from '../core/format';
import * as sim from '../core/sim';
import { Ticket } from '../core/state';
import { claimQuest, streakBonus } from '../core/quests';
import { holiday, season } from '../core/seasons';
import { startCooking } from './cooking';
import { Creator, makeCreator } from './creator';
import { bar, delegate, el, esc, fail, ingIcon, patch, run, stars } from './dom';
import { UIHost } from './host';
import { Manage, Tab } from './manage';

interface Modal { kind: string; el: HTMLElement; onClose: () => void; update?: (dt: number) => void; prev?: Element | null }
let uid = 0;

const PORTRAITS: Record<string, string> = { 'Grandpa Kenji': '👴', Mika: '👩‍🍳', 'Mr. Sato': '🧑‍💼', 'Ryo Tanaka': '😤', 'Madame Aoki': '📝' };
// Hand-drawn HUD glyphs (authored SVG, one stroke weight).
const ICON = {
  day: '<svg viewBox="0 0 26 26" fill="none" stroke="#c8322a" stroke-width="2.2" stroke-linecap="round"><circle cx="13" cy="13" r="5.2" fill="#c8322a"/><path d="M13 2.5v3M13 20.5v3M2.5 13h3M20.5 13h3M5.6 5.6l2.1 2.1M18.3 18.3l2.1 2.1M5.6 20.4l2.1-2.1M18.3 7.7l2.1-2.1"/></svg>',
  dusk: '<svg viewBox="0 0 26 26" fill="none" stroke="#c8322a" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 17a6.5 6.5 0 0 1 13 0Z" fill="#e8873a" stroke="#c8322a"/><path d="M2.5 17h21M5 21h16M13 5.5v3M5.5 9.5l2 1.8M20.5 9.5l-2 1.8"/></svg>',
  night: '<svg viewBox="0 0 26 26"><path d="M17.5 3.5a9.5 9.5 0 1 0 5 15.5A8 8 0 0 1 17.5 3.5Z" fill="#23385c"/><circle cx="20" cy="7" r="1.1" fill="#c99a3c"/><circle cx="23" cy="11.5" r=".8" fill="#c99a3c"/></svg>',
  maki: '<svg class="nori" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#1f3a2a" stroke="#000" stroke-width="1"/><circle cx="13" cy="13" r="9" fill="#f6eedd"/><circle cx="13" cy="13" r="4.4" fill="#ff8a5c"/><path d="M10.5 11.5l5 3" stroke="#ffb89a" stroke-width="1.2"/></svg>',
};
const TITLE_JA: Record<string, string> = { continue: '続きから', new: '新しく始める', settings: '設定', credits: 'クレジット' };

const portrait = (name: string) => PORTRAITS[name] ?? Object.entries(PORTRAITS).find(([k]) => name.startsWith(k.split(' ')[0]))?.[1] ?? '🙂';

export class UI {
  private root: HTMLElement;
  private stack: Modal[] = [];
  private hud!: HTMLElement;
  private q = <T extends HTMLElement>(sel: string) => this.hud.querySelector<T>(sel)!;
  private dispCash = 0;
  private promptText: string | null = '';
  private objText: string | null | undefined = undefined;
  private railSt: { last?: string } = {};
  private slowT = 0;
  private manage: Manage | null = null;
  private title: HTMLElement | null = null;
  private titleCreator: Creator | null = null;
  private iconKey = '';
  private flapStr = '';
  private questSt: { last?: string } = {};
  private questsOpen = false;
  private toastBox!: HTMLElement;

  constructor(private host: UIHost) {
    this.root = document.getElementById('ui-root') ?? document.body.appendChild(el('div'));
    this.root.id = 'ui-root';
    this.buildHud();
    this.wireBus();
    this.dispCash = host.s.cash;
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
      // timing games and the speech panel own Space/E — focus the frame itself there, not a button
      const first = m.kind === 'cook' || m.kind === 'dialog' ? null
        : e.querySelector<HTMLElement>('.tab[aria-current]') ?? e.querySelector<HTMLElement>('.modal-body button, .modal-body input, .modal-body select, .modal-body textarea, .tab-body button, button:not(.x), [tabindex="0"]');
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
    this.stack.splice(i, 1);
    if (callClose) m.onClose();
    m.el.classList.remove('open'); m.el.classList.add('closing');
    setTimeout(() => { m.el.remove(); m.el.classList.remove('closing'); }, 200);
    this.syncInert();
    const prev = m.prev as HTMLElement | null;
    if (prev?.isConnected && !prev.closest('[inert]')) prev.focus({ preventScroll: true });
  }
  private has(kind: string) { return this.stack.find((m) => m.kind === kind); }

  /** Standard modal window with header and body. */
  private window(kind: string, title: string, width: number, onClose: () => void = () => {}): { m: Modal; body: HTMLElement } {
    const e = el('div', 'modal ' + kind);
    e.innerHTML = `<div class="panel" style="width:min(${width}px,94vw)"><div class="modal-head"><h2>${title}</h2><button class="x" aria-label="Close">✕</button></div><div class="modal-body" tabindex="0"></div></div>`;
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
        <div class="panel money"><div class="coin">¥</div><div><div class="amt" id="h-cash"></div><div class="today" id="h-today"></div><div class="who" id="h-title"></div></div></div>
        <div class="panel objective"><b aria-hidden="true"></b><span id="h-obj" aria-live="polite"></span></div>
        <div id="h-quests"></div>
      </div>
      <div class="hud-tc"><div class="panel sushi-count" aria-live="off"><div class="n">${ICON.maki}<span class="row" style="gap:3px" id="h-flaps" role="img" aria-label="pieces sold"></span><span class="goal" id="h-goal"></span></div><div class="next" id="h-next"></div><div id="h-mbar"></div></div></div>
      <div class="hud-tr">
        <div class="panel clock"><div class="cal-top"><span id="h-day"></span><span class="rings"><i></i><i></i></span></div><div class="cal-body"><span class="icon" id="h-icon"></span><div><div class="t" id="h-time"></div><div class="d" id="h-open"></div></div></div><div class="cal-season" id="h-season"></div></div>
        <div id="h-holiday"></div>
        <div id="h-event"></div>
        <div id="h-rest"></div>
      </div>
      <div class="panel prompt" id="h-prompt"><span class="key">E</span><span id="h-prompt-t"></span></div>
      <div class="rail" id="h-rail"></div>
      <div class="hints"><span><span class="key sm">Tab</span>Manage</span><span><span class="key sm">M</span>Map</span><span><span class="key sm">Esc</span>Pause</span><span><span class="key sm">Shift</span>Sprint</span></div>`;
    this.root.append(this.hud);
    this.toastBox = el('div', 'toasts');
    this.toastBox.setAttribute('role', 'status'); this.toastBox.setAttribute('aria-live', 'polite');
    this.root.append(this.toastBox); // outside the HUD so it never goes inert behind windows
    delegate(this.q('#h-quests'), {
      qtoggle: () => { this.questsOpen = !this.questsOpen; this.questSt.last = undefined; audio.sfx('click'); },
      claim: (id, b) => { if (run(b, claimQuest(this.host.s.quests, this.host.s, id), 'coin')) { this.questSt.last = undefined; toast('Request complete — reward collected!', 'good', '🎐'); } },
    });
  }

  /** Compact daily-request slip under the objective note. */
  private questsHtml(): string {
    const s = this.host.s, q = s.quests;
    if (!q?.list?.length || s.tutorial < 6) return '';
    const num = (v: number, t: number) => (Number.isInteger(t) ? short(Math.min(v, t)) : Math.min(v, t).toFixed(1));
    const rows = q.list.map((x) => {
      const failed = !!x.meta?.failed && !x.done;
      const right = x.claimed ? '<i class="mini-stamp">済</i>' : x.done ? `<button class="btn small" data-act="claim" data-arg="${esc(x.id)}">Claim</button>`
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
      const p = d.revenue - d.expenses;
      this.toast(`Day ${d.day} closed — revenue ${yen(d.revenue)}, expenses ${yen(d.expenses)}, profit ${yen(p)} · 🍣 ${short(d.pieces)} · ${d.customers} guests`, p >= 0 ? 'good' : 'bad', '🌙');
    });
  }

  private toast(text: string, kind: string, icon?: string): void {
    const box = this.toastBox;
    const t = el('div', 'toast ' + kind, `${icon ? `<span>${icon}</span>` : ''}<span>${esc(text)}</span>`);
    box.prepend(t);
    while (box.children.length > 5) box.lastElementChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 450); }, kind === 'gold' ? 6500 : 4500);
  }

  private floatMoney(amount: number, x?: number, y?: number, z?: number): void {
    if (!this.host.started || amount === 0) return;
    let sx = 120, sy = 70;
    if (x !== undefined && y !== undefined && z !== undefined) {
      const v = new THREE.Vector3(x, y, z).project(this.host.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return;
      sx = (v.x + 1) / 2 * innerWidth; sy = (1 - v.y) / 2 * innerHeight;
    }
    const f = el('div', 'float-money', `${amount > 0 ? '+' : ''}${yenExact(Math.round(amount))}`);
    if (amount < 0) f.style.color = 'var(--red2)';
    f.style.left = sx + 'px'; f.style.top = sy + 'px';
    this.root.append(f);
    setTimeout(() => f.remove(), 1650);
  }

  private banner(t: string, r: string): void {
    const b = el('div', 'banner', `<div class="seal" aria-hidden="true">祝</div><div class="t">${esc(t)}</div><div class="r">${esc(r)}</div>`);
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
      box.innerHTML = chars.map((c) => `<span class="flap${/[.,]/.test(c) ? ' sep' : ''}"><b>${c}</b></span>`).join('');
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

  setObjective(t: string | null): void {
    if (t === this.objText) return;
    this.objText = t;
    this.q('#h-obj').textContent = t ?? '';
    (this.q('.objective')).style.display = t ? '' : 'none';
  }

  update(dt: number): void {
    const s = this.host.s;
    this.hud.classList.toggle('hidden', !this.host.started);
    for (const m of this.stack) m.update?.(dt);
    if (!this.host.started) return;
    if (this.title) this.hideTitle();
    // money count-up
    const diff = s.cash - this.dispCash;
    this.dispCash = Math.abs(diff) < 1 ? s.cash : this.dispCash + diff * Math.min(1, dt * 7);
    this.q('#h-cash').textContent = (this.dispCash < 0 ? '-¥' : '¥') + (Math.abs(this.dispCash) < 1e7 ? exact(Math.abs(this.dispCash)) : short(Math.abs(this.dispCash), 2));
    this.slowT += dt;
    if (this.slowT < 0.25) return;
    this.slowT = 0;
    const tp = s.today.revenue - s.today.expenses;
    this.q('#h-today').innerHTML = `<span class="${tp >= 0 ? 'good' : 'bad'}">today ${tp >= 0 ? '+' : ''}${yen(tp)}</span>`;
    this.q('#h-title').textContent = `${s.player.title ? '👑 ' + s.player.title + ' · ' : ''}${s.player.name} of ${s.player.company}`;
    // sushi counter
    const p = s.lifetime.pieces, m = sim.nextMilestone(s);
    const prev = s.milestoneIndex ? milestone(s.milestoneIndex - 1).pieces : 0;
    this.flaps(p < 1e6 ? exact(p) : short(p, 2));
    this.q('#h-goal').textContent = `/ ${p < 1e6 ? '1,000,000' : short(m.pieces)}`;
    this.q('#h-next').textContent = `Next: ${m.title} at ${p < 1e6 ? exact(m.pieces) : short(m.pieces)}`;
    this.q('#h-mbar').innerHTML = bar((p - prev) / (m.pieces - prev), 'gold');
    // clock
    const h = s.minute / 60;
    const icon = h >= 6 && h < 17.5 ? 'day' : h >= 17.5 && h < 19.5 ? 'dusk' : 'night';
    if (this.iconKey !== icon) { this.iconKey = icon; this.q('#h-icon').innerHTML = ICON[icon]; }
    this.q('#h-time').textContent = clockStr(s.minute);
    const open = sim.isOpen(s.minute);
    this.q('#h-day').textContent = `DAY ${s.day}`;
    this.q('#h-open').innerHTML = `<span class="${open ? 'good' : 'bad'}">${open ? '営業中 · Open' : 'Closed till 07:00'}</span>`;
    const se = season(s), hol = holiday(s);
    this.q('#h-season').textContent = `${se.emoji} ${se.name} ${se.jp} · ${se.dayOfSeason}/7`;
    this.q('#h-holiday').innerHTML = hol ? `<div class="holiday-chip" title="${esc(hol.desc)}"><b>${hol.jp}</b> ${hol.emoji} ${esc(hol.name)}</div>` : '';
    patch(this.q('#h-quests'), this.questsHtml(), this.questSt);
    const ev = s.event ? EVENTS[s.event.id] : null;
    this.q('#h-event').innerHTML = ev ? `<div class="event-chip" title="${esc(ev.desc)}">${ev.emoji} ${ev.name}<div class="tiny" style="opacity:.8;font-weight:500">${esc(ev.desc)}</div></div>` : '';
    // restaurant card
    const site = this.host.currentSite();
    if (site) {
      const r = s.restaurants[site], auto = sim.isAutomated(s, site);
      this.q('#h-rest').innerHTML = `<div class="panel rest-card"><div class="nm">${esc(r.name)}</div><div>${stars(r.reputation)} <span class="tiny muted">${r.reputation.toFixed(1)}</span></div>
        <div class="tiny">Cleanliness</div>${bar(r.cleanliness, r.cleanliness < 0.5 ? '' : 'green')}
        <div class="tiny muted" style="margin-top:4px">${auto ? 'Staff run the shop' : 'You run this place'} · ${r.orders.length} cooking · ${r.ready.length} ready</div></div>`;
    } else this.q('#h-rest').innerHTML = '';
    // ticket rail
    const orders = this.host.ordersAtCurrentSite();
    const more = orders.length > 3 ? `<div class="ticket-more">+${orders.length - 3}</div>` : '';
    patch(this.q('#h-rail'), orders.slice(0, 3).map((o) => `<div class="ticket ${o.status === 'ready' ? 'ready' : ''} ${o.vip ? 'vip' : ''}">
      <span class="st">${o.status === 'ordering' ? 'ordering' : o.status === 'ready' ? 'ready' : 'cooking'}</span><div class="who">${o.emoji}${o.vip ? '👑' : ''}</div>
      <div class="what">${o.pieces}× ${esc(RECIPES[o.recipe]?.name ?? o.recipe)}</div>${bar(o.patience, o.patience < 0.3 ? '' : 'green')}</div>`).join('') + more, this.railSt);
  }

  // ================================================================ title screen
  showMainMenu(): void {
    this.title?.remove();
    const t = el('main', 'title');
    this.title = t;
    t.innerHTML = `<div class="title-left">
        <h1 class="logo"><span class="l1">SUSHI</span><span class="l2">EMPIRE</span><span class="jp">TOKYO · 東京</span></h1>
        <div class="tagline">Start Small. Sell a Million. Build an Empire.</div>
        <div class="title-menu">
          ${this.host.hasSave() ? `<button class="btn big" data-act="continue">Continue<span class="ja">${TITLE_JA.continue}</span></button>` : ''}
          <button class="btn big ${this.host.hasSave() ? 'green' : ''}" data-act="new">New Game<span class="ja">${TITLE_JA.new}</span></button>
          <button class="btn ghost" data-act="settings">Settings<span class="ja">${TITLE_JA.settings}</span></button>
          <button class="btn ghost" data-act="credits">Credits<span class="ja">${TITLE_JA.credits}</span></button>
        </div>
        <div class="title-foot">WASD move · Mouse drag camera · E interact · Tab manage · M map</div>
      </div><div class="title-right"><div class="title-panel"></div></div>`;
    const panel = t.querySelector<HTMLElement>('.title-panel')!;
    const showPanel = (html: string) => { this.titleCreator?.dispose(); this.titleCreator = null; panel.innerHTML = html ? `<div class="panel" style="padding:16px 18px">${html}</div>` : ''; };
    const creator = () => {
      showPanel(`<h2>Create your chef</h2><div id="cr"></div><div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn ghost" data-act="back">Back</button><button class="btn big" data-act="start">Open the stand</button></div>`);
      this.titleCreator = makeCreator(this.host.s.player.avatar, { name: '', company: '', showNames: true });
      panel.querySelector('#cr')!.append(this.titleCreator.el);
      (panel.querySelector('#cr-name') as HTMLInputElement)?.focus();
    };
    delegate(t, {
      continue: () => { audio.sfx('fanfare'); this.hideTitle(); this.host.continueGame(); },
      new: () => {
        audio.sfx('click');
        if (this.host.hasSave()) showPanel(`<h2>Start over?</h2><p>This replaces your current empire (<b>${exact(this.host.s.lifetime.pieces)}</b> pieces sold). Tip: export your save first from the pause menu.</p>
          <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="back">Cancel</button><button class="btn" data-act="confirmnew">Yes, new game</button></div>`);
        else creator();
      },
      confirmnew: () => { audio.sfx('click'); creator(); },
      back: () => { audio.sfx('click'); showPanel(''); },
      start: () => {
        const c = this.titleCreator!;
        audio.sfx('fanfare');
        this.hideTitle();
        this.host.newGame({ name: c.name.trim() || 'Chef', company: c.company.trim() || 'Sushi Empire', avatar: { ...c.avatar } });
      },
      settings: () => { audio.sfx('click'); showPanel(`<h2>Settings</h2>${this.settingsHtml()}<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost" data-act="back">Back</button></div>`); },
      credits: () => {
        audio.sfx('click');
        showPanel(`<h2>Credits</h2><p><b>Sushi Empire: Tokyo</b> — an original game.</p>
          <p class="small">All 3D models (characters, buildings, sushi) are generated procedurally in code. All music and sound effects are synthesized live with the Web Audio API.</p>
          <p class="small">Built with <b>three.js</b> (MIT License) and <b>Vite</b>. Fonts: <b>Dela Gothic One</b> (Artakana) and <b>Zen Maru Gothic</b> (Yoshimichi Ohira), SIL Open Font License 1.1, bundled via @fontsource.</p>
          <p class="small muted">No assets were copied from any other game. Tokyo locations are stylized, fictionalized versions of real neighborhoods.</p>
          <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="back">Back</button></div>`);
      },
    }, this.settingsInputs());
    this.root.append(t);
  }

  private hideTitle(): void {
    const t = this.title;
    if (!t) return;
    this.titleCreator?.dispose(); this.titleCreator = null;
    t.inert = true;
    t.classList.add('out');
    this.title = null;
    setTimeout(() => t.remove(), 600);
    this.dispCash = this.host.s.cash;
  }

  // ================================================================ settings (shared)
  private settingsHtml(): string {
    const st = this.host.s.settings;
    const rng = (k: string, label: string, v: number, min = 0, max = 1, step = 0.05) =>
      `<label class="field">${label} <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-in="set" data-k="${k}" aria-valuetext="${k === 'sensitivity' ? `×${v}` : `${Math.round(v * 100)}%`}"></label>`;
    return `<div class="grid g2">${rng('master', '🔊 Master volume', st.master)}${rng('music', '🎵 Music', st.music)}${rng('sfx', '🔔 Sound effects', st.sfx)}${rng('sensitivity', '🖱️ Camera sensitivity', st.sensitivity, 0.3, 2.5, 0.1)}
      <label class="field">🎨 Graphics quality<select data-in="set" data-k="quality">${['low', 'medium', 'high'].map((q) => `<option ${st.quality === q ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
      <div class="grid"><label class="row bold"><input type="checkbox" data-in="set" data-k="muted" ${st.muted ? 'checked' : ''}> 🔇 Mute all</label>
      <label class="row bold"><input type="checkbox" data-in="set" data-k="invertY" ${st.invertY ? 'checked' : ''}> ↕️ Invert camera Y</label></div></div>`;
  }
  private settingsInputs() {
    return {
      set: (v: string, e: HTMLInputElement) => {
        const st = this.host.s.settings as any, k = e.dataset.k!;
        st[k] = e.type === 'checkbox' ? v === 'true' : k === 'quality' ? v : Number(v);
        if (e.type === 'range') e.setAttribute('aria-valuetext', k === 'sensitivity' ? `×${v}` : `${Math.round(Number(v) * 100)}%`);
        this.host.applySettings();
        if (e.type !== 'range') audio.sfx('click');
      },
    };
  }

  // ================================================================ management
  toggleManage(tab?: string): void {
    const open = this.has('manage');
    if (open && (!tab || this.manage!.tab === tab)) { this.remove(open); return; }
    if (!this.manage) {
      let m!: Modal;
      this.manage = new Manage(this.host, () => this.remove(m));
      m = { kind: 'manage', el: this.manage.el, onClose: () => {}, update: (dt) => this.manage!.update(dt) };
      (this.manage as any)._modal = m;
    }
    const m = (this.manage as any)._modal as Modal;
    this.manage.show((tab as Tab) || undefined);
    if (!open) { audio.sfx('whoosh'); this.push(m); }
  }

  // ================================================================ supplier shop
  openShop(): void {
    if (this.has('shop')) return;
    const { m, body } = this.window('shop', "🐟 Mika's Fresh Fish", 900);
    const st: { last?: string } = {};
    const render = () => {
      const s = this.host.s, delivery = !this.host.atSupplier();
      const need = new Set(sim.neededIngredients(s));
      const used = sim.storageUsed(s), cap = sim.mods(s).storage;
      const ev = s.event ? EVENTS[s.event.id] : null;
      patch(body, `<div class="row" style="gap:14px;margin-bottom:10px"><div style="font-size:54px">👩‍🍳</div>
          <div style="flex:1"><b>Mika:</b> "${ev?.ingredient ? `Bad news — ${INGREDIENTS[ev.ingredient].name} is scarce today, prices are way up!` : need.size ? 'Fresh this morning! The glowing ones are on your menus.' : 'Welcome! What can I get you?'}"
          <div class="spread small" style="margin-top:6px"><span>📦 Storage ${exact(used)} / ${exact(cap)}</span><span class="chip gold">¥ ${exact(s.cash)}</span></div>${bar(used / cap, used / cap > 0.9 ? '' : 'green')}</div></div>
        <div class="grid g4">${INGREDIENT_IDS.map((id) => {
          const d = INGREDIENTS[id], price = sim.ingredientPrice(s, id) * (delivery ? 1.08 : 1), shortage = ev?.ingredient === id;
          return `<div class="card ${need.has(id) ? 'hl' : ''}"><div class="spread"><span style="font-size:30px">${ingIcon(id)}</span><span class="chip ${s.inventory[id] < 10 && need.has(id) ? 'red' : ''}">${exact(s.inventory[id])} in stock</span></div>
            <b>${d.name}</b><div class="small ${shortage ? 'bad' : 'muted'}">${yen(Math.round(price * 10) / 10)} each ${shortage ? '· 📉 SHORTAGE' : ''}</div>
            <div class="row" style="margin-top:6px"><button class="btn small" data-act="buy" data-arg="${id}:10">+10</button><button class="btn small" data-act="buy" data-arg="${id}:50">+50</button><button class="btn small gold" data-act="buy" data-arg="${id}:max">Max</button></div></div>`;
        }).join('')}</div>
        <div class="row" style="justify-content:space-between;margin-top:12px"><span class="small muted">Tip: research Supplier Hotline to order from anywhere, then Scheduled Deliveries to automate it.</span>
          <button class="btn green" data-act="stockup">🧺 Stock up my menu</button></div>`, st);
    };
    const buy = (id: IngredientId, q: number | 'max', b: HTMLElement | null): boolean => {
      const s = this.host.s, delivery = !this.host.atSupplier();
      const unit = sim.ingredientPrice(s, id) * (delivery ? 1.08 : 1);
      const room = sim.mods(s).storage - sim.storageUsed(s);
      if (room <= 0) { fail(b, 'Storage is full!'); return false; }
      const qty = q === 'max' ? Math.min(room, Math.floor(Math.max(0, s.cash) / unit)) : q;
      if (!sim.buyIngredient(s, id, qty, delivery)) { fail(b, `Not enough cash for ${INGREDIENTS[id].name}`); return false; }
      return true;
    };
    delegate(body, {
      buy: (arg, b) => { const [id, q] = arg.split(':'); if (buy(id as IngredientId, q === 'max' ? 'max' : Number(q), b)) { audio.sfx('coin'); st.last = undefined; render(); } },
      stockup: (_, b) => {
        let ok = false;
        // weight by how many menu items use each ingredient (rice is in everything, so it runs out first)
        const s = this.host.s, uses = new Map<string, number>();
        for (const r of Object.values(s.restaurants)) for (const m of r.menu) if (s.recipes.includes(m))
          for (const k of Object.keys(RECIPES[m].ingredients)) uses.set(k, (uses.get(k) ?? 0) + 1);
        const max = Math.max(1, ...uses.values());
        for (const id of sim.neededIngredients(s)) ok = buy(id, Math.round(10 + 30 * (uses.get(id) ?? 1) / max), null) || ok;
        if (ok) { audio.sfx('coin'); st.last = undefined; render(); } else fail(b, 'Could not buy anything — check cash and storage.');
      },
    });
    let t = 0;
    m.update = (dt) => { if ((t += dt) > 0.5) { t = 0; render(); } };
    render();
    audio.sfx('door');
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
        const ring = open ? st.color : '#9b9086';
        return `<g class="dist ${sel === d ? 'sel' : ''}" data-act="pick" data-arg="${d}" transform="translate(${st.x},${st.y})" role="button" tabindex="0" aria-pressed="${sel === d}" aria-label="${def.name}${open ? '' : ', locked'}${here ? ', you are here' : ''}">
          ${sel === d ? '<circle r="34" fill="none" stroke="#1f1b17" stroke-width="2" stroke-dasharray="4 4"/>' : ''}
          <circle class="ring" r="24" fill="#fff" stroke="${ring}" stroke-width="${sel === d ? 9 : 7}" ${open ? '' : 'stroke-dasharray="6 4"'}/>
          <text y="-3" text-anchor="middle" font-size="13" fill="#1f1b17">${st.code[0]}</text><text y="12" text-anchor="middle" font-size="12" fill="#1f1b17">${st.code.slice(1)}</text>
          <g transform="translate(${st.lx},${st.ly})">
            <text class="jp" text-anchor="${st.anchor}" font-size="24" fill="${open ? '#1f1b17' : '#6f6256'}">${def.jp}</text>
            <text y="20" text-anchor="${st.anchor}" font-size="14" fill="${open ? '#5b5047' : '#6f6256'}">${def.name}${open ? '' : ' · locked'}</text></g>
          ${owned ? `<g transform="translate(20,-26) rotate(-8)"><rect x="-11" y="-11" width="22" height="22" rx="3" fill="#c8322a"/><text y="5" text-anchor="middle" font-size="13" fill="#f2e8d5">${owned}</text></g>` : ''}
          ${here ? `<g transform="translate(0,-40)"><path d="M-22,-18 h44 v16 h-16 l-6,8 l-6,-8 h-16z" fill="#1f1b17"/><text y="-6" text-anchor="middle" font-size="11" fill="#f2e8d5">現在地</text></g>` : ''}</g>`;
      }).join('');
      const d = DISTRICTS[sel], open = s.districts.includes(sel), here = s.player.district === sel;
      const props = Object.values(PROPERTIES).filter((p) => p.district === sel);
      body.innerHTML = `<div class="map-wrap"><svg class="map-svg" viewBox="0 0 800 520" role="group" aria-label="Tokyo metro map — choose a district">
          <path d="M700,0 C690,90 720,150 700,230 C680,310 730,380 700,520" fill="none" stroke="#cfe3ee" stroke-width="46"/>
          <text x="736" y="300" font-size="12" fill="#3f6678" transform="rotate(-80 736 300)">隅田川 Sumida River</text>
          <path d="M520,520 Q620,470 800,480 V520Z" fill="#cfe3ee"/><text x="690" y="508" font-size="12" fill="#3f6678">東京湾 Tokyo Bay</text>
          <rect x="370" y="250" width="110" height="70" rx="10" fill="#e3ead2"/><text x="425" y="290" text-anchor="middle" font-size="12" fill="#4f5a3a">皇居 Imperial Palace</text>
          <rect x="170" y="110" width="480" height="320" rx="80" fill="none" stroke="#80c241" stroke-width="9"/>
          <path d="M170,200 H420 L560,340 V400" fill="none" stroke="#e60012" stroke-width="9" stroke-linejoin="round"/>
          <path d="M170,360 H420 L460,400 H560 L650,310 V140" fill="none" stroke="#f39700" stroke-width="9" stroke-linejoin="round"/>
          <g font-size="12" fill="#5b5047"><rect x="22" y="22" width="150" height="66" rx="3" fill="#fbf7ef" stroke="#1f1b17" stroke-width="1.5"/>
            <rect x="32" y="34" width="22" height="6" fill="#f39700"/><text x="62" y="40">Ginza Line</text>
            <rect x="32" y="52" width="22" height="6" fill="#e60012"/><text x="62" y="58">Marunouchi Line</text>
            <rect x="32" y="70" width="22" height="6" fill="#80c241"/><text x="62" y="76">Yamanote Line</text></g>
          ${dists}</svg>
        <div class="grid" style="align-content:start">
          <div class="card"><h2>${d.jp} ${d.name}</h2><div class="small muted">${d.blurb}</div>
            <div class="small" style="margin-top:6px">🚶 Traffic ${d.traffic}/min · 💴 Price sensitivity ${d.elasticity}</div>
            <div class="small">⚔️ Rivals take ${Math.round(sim.rivalShare(s, sel) * 100)}% of guests</div></div>
          ${open ? (here ? '<div class="card small"><b>現在地</b> · You are here.</div>' : `<button class="btn big blue" data-act="go" data-arg="${sel}">🚇 Travel to ${d.name}</button>`)
            : `<div class="card locked small">🔒 Requires <b>${exact(d.unlock.pieces)}</b> pieces sold (you: ${exact(s.lifetime.pieces)}) and a business permit of <b>${yen(d.unlock.cost)}</b>.</div>
               <button class="btn gold" data-act="unlock" data-arg="${sel}">Unlock ${d.name} — ${yen(d.unlock.cost)}</button>`}
          <div class="card small"><b>Properties</b>${props.map((p) => `<div class="spread"><span>${s.restaurants[p.id] ? '🏮' : '🏷️'} ${esc(s.restaurants[p.id]?.name ?? p.name)}</span><span class="tiny">${s.restaurants[p.id] ? 'Owned' : yen(p.price)}</span></div>`).join('')}</div>
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
      unlock: (d, b) => { if (run(b, A.unlockDistrict(this.host.s, d as DistrictId), 'fanfare')) render(); },
    });
    render();
    audio.sfx('whoosh');
    this.push(m);
  }

  // ================================================================ property dialog
  openProperty(propId: string): void {
    if (this.has('prop')) return;
    const p = PROPERTIES[propId], s = this.host.s, d = DISTRICTS[p.district];
    const { m, body } = this.window('prop', `🏷️ For Sale: ${esc(p.name)}`, 560);
    const open = s.districts.includes(p.district);
    body.innerHTML = `<div class="row" style="gap:14px"><div style="font-size:64px">${{ stand: '🛖', shop: '🏠', restaurant: '🏯', flagship: '🏙️' }[p.kind]}</div>
      <div><h3>${esc(p.name)}</h3><div class="muted">${d.jp} ${d.name} · ${p.kind}</div></div></div>
      <table class="kv section"><tr><td>💴 Price</td><td>${yenExact(p.price)}</td></tr><tr><td>🏠 Rent</td><td>${yenExact(p.rent)} / day</td></tr>
        <tr><td>🚶 Foot traffic</td><td>×${p.size}</td></tr><tr><td>🪑 Max seats</td><td>${p.seatsMax}</td></tr>
        <tr><td>👨‍🍳 Chef slots</td><td>${p.chefSlots}</td></tr><tr><td>🧑‍💼 Server slots</td><td>${p.serverSlots}</td></tr></table>
      <p class="small muted">A new location needs a chef and a server to run while you're away. Bigger places attract far more guests.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="close">Not now</button>
        <button class="btn big ${open && s.cash >= p.price ? 'green' : ''}" data-act="buy">${open ? `Buy for ${yen(p.price)}` : `Unlock ${d.name} first`}</button></div>`;
    delegate(body, {
      close: () => this.remove(m),
      buy: (_, b) => {
        if (!open) return fail(b, `Unlock ${d.name} first (Tab → Expansion or the Metro map)`);
        if (run(b, A.buyProperty(this.host.s, propId), 'fanfare')) this.remove(m);
      },
    });
    this.push(m);
  }

  // ================================================================ pause
  openPause(): void {
    if (this.has('pause')) return;
    this.host.setPaused(true);
    let creator: Creator | null = null;
    const { m, body } = this.window('pause', '⏸️ Paused', 640, () => { creator?.dispose(); this.host.setPaused(false); });
    const view = (v: string) => {
      creator?.dispose(); creator = null;
      const back = '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-act="v" data-arg="main">Back</button></div>';
      if (v === 'main') body.innerHTML = `<div class="grid" style="max-width:360px;margin:0 auto">
          <button class="btn big green" data-act="resume">▶ Resume</button>
          <button class="btn ghost" data-act="v" data-arg="settings">⚙️ Settings</button>
          <button class="btn ghost" data-act="v" data-arg="customize">👕 Customize character</button>
          <button class="btn ghost" data-act="v" data-arg="controls">🎮 Controls</button>
          <button class="btn ghost" data-act="save">💾 Save now</button>
          <button class="btn ghost" data-act="v" data-arg="export">📤 Export save</button>
          <button class="btn ghost" data-act="v" data-arg="import">📥 Import save</button>
          <button class="btn" data-act="quit">🏠 Save & main menu</button></div>
          <div class="tiny muted" style="text-align:center;margin-top:10px">Progress auto-saves every 20 seconds.</div>`;
      else if (v === 'settings') body.innerHTML = this.settingsHtml() + back;
      else if (v === 'controls') body.innerHTML = `<table class="ctrl-table">${[
        ['W A S D / Arrows', 'Walk'], ['Shift', 'Sprint'], ['Space', 'Jump'], ['E', 'Interact (take order, cook, serve, shop, talk)'], ['Mouse drag', 'Rotate camera'],
        ['Mouse wheel', 'Zoom'], ['Tab', 'Business management'], ['M', 'City map'], ['Esc', 'Pause / close window']].map(([k, d]) => `<tr><td><span class="key sm">${k}</span></td><td>${d}</td></tr>`).join('')}</table>
        <p class="small muted">Cooking: Space / click to stop timers, number keys to pick ingredients, A/D to roll.</p>${back}`;
      else if (v === 'customize') {
        body.innerHTML = `<div id="pc"></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-act="v" data-arg="main">Cancel</button><button class="btn green" data-act="look">Save look</button></div>`;
        creator = makeCreator(this.host.s.player.avatar, { showNames: false });
        body.querySelector('#pc')!.append(creator.el);
      } else if (v === 'export') body.innerHTML = `<p class="small">Copy this code to back up your empire or move it to another browser:</p>
          <textarea class="code-box" readonly>${this.host.exportSave()}</textarea><div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn blue" data-act="copy">📋 Copy</button></div>${back}`;
      else if (v === 'import') body.innerHTML = `<p class="small">Paste a save code. <b>This replaces your current game.</b></p><textarea class="code-box" id="imp"></textarea>
          <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" data-act="import">Import & reload</button></div>${back}`;
    };
    delegate(body, {
      v: (a) => { audio.sfx('click'); view(a); },
      resume: () => this.remove(m),
      save: (_, b) => {
        if (!this.host.save()) return fail(b, 'The browser could not save your game. Export a backup before leaving.');
        audio.sfx('success');
        toast('Game saved!', 'good', '💾');
      },
      quit: (_, b) => {
        if (!this.host.save()) return fail(b, 'The browser could not save your game. Export a backup before leaving.');
        location.reload();
      },
      look: () => { if (creator) { this.host.s.player.avatar = { ...creator.avatar }; this.host.applyAvatar(); audio.sfx('success'); view('main'); } },
      copy: () => { const ta = body.querySelector('textarea')!; ta.select(); navigator.clipboard?.writeText(ta.value).catch(() => document.execCommand('copy')); audio.sfx('success'); toast('Save code copied!', 'good', '📋'); },
      import: (_, b) => { const err = this.host.importSave((body.querySelector('#imp') as HTMLTextAreaElement).value); if (err) fail(b, err); },
    }, this.settingsInputs());
    view('main');
    this.push(m);
  }

  // ================================================================ cooking
  openCooking(t: Ticket, restId: string): Promise<number | null> {
    const ses = startCooking(this.host.s, t, restId);
    if (!ses) return Promise.resolve(null);
    const m: Modal = { kind: 'cook', el: ses.el, onClose: () => ses.cancel() };
    this.push(m);
    return ses.promise.then((v) => { this.remove(m, false); return v; });
  }

  // ================================================================ dialog
  dialog(speaker: string, lines: string[]): Promise<void> {
    return new Promise((resolve) => {
      const d = el('div', 'panel dialog');
      d.innerHTML = `<div class="portrait">${portrait(speaker)}</div><div style="flex:1"><div class="who">${esc(speaker)}</div><div class="txt"></div></div><div class="more">click / E ▶</div><div class="sr-only" aria-live="polite"></div>`;
      const txt = d.querySelector<HTMLElement>('.txt')!, more = d.querySelector<HTMLElement>('.more')!;
      let i = 0, shown = 0, timer = 0, finished = false;
      const typeLine = () => {
        shown = 0; clearInterval(timer);
        const line = lines[i];
        d.querySelector('.sr-only')!.textContent = `${speaker}: ${line}`;
        more.textContent = i < lines.length - 1 ? 'click / E ▶' : 'click / E ✓';
        timer = window.setInterval(() => {
          shown += 2; txt.textContent = line.slice(0, shown);
          if (shown >= line.length) clearInterval(timer);
          if (shown % 6 === 0) audio.sfx('pop', 0.15);
        }, 28);
      };
      const end = () => { if (finished) return; finished = true; clearInterval(timer); removeEventListener('keydown', key, true); resolve(); };
      const advance = () => {
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
    const colors = ['#e63946', '#ffc93c', '#2ec27e', '#3fa7ff', '#ff6fa8', '#ff8a5c', '#fff'];
    let conf = '';
    for (let i = 0; i < 120; i++) conf += `<i class="confetti" style="left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${3 + Math.random() * 4}s;animation-delay:${Math.random() * 3}s;transform:rotate(${Math.random() * 360}deg)"></i>`;
    const best = Object.values(s.restaurants).sort((a, b) => b.revenue - a.revenue)[0];
    e.innerHTML = conf + `<div class="panel"><div class="emperor">SUSHI EMPEROR</div><div class="bold goldtxt" style="letter-spacing:.2em;font-size:14px">1,000,000 PIECES OF SUSHI SOLD</div><p style="font-size:18px">${esc(s.player.name)}, all of Tokyo is celebrating <b>${esc(s.player.company)}</b>! 🎆</p>
      <div class="statgrid">
        <div class="stat"><div class="k">Days in business</div><div class="v">${s.day}</div></div>
        <div class="stat"><div class="k">Revenue</div><div class="v">${yen(L.revenue)}</div></div>
        <div class="stat"><div class="k">Customers</div><div class="v">${short(L.customers)}</div></div>
        <div class="stat"><div class="k">Restaurants</div><div class="v">${Object.keys(s.restaurants).length}</div></div>
        <div class="stat"><div class="k">Employees</div><div class="v">${s.staff.length}</div></div>
        <div class="stat"><div class="k">Play time</div><div class="v">${duration(s.playTime)}</div></div>
        <div class="stat"><div class="k">Hand-made orders</div><div class="v">${short(L.manualOrders)}</div></div>
        <div class="stat"><div class="k">Top location</div><div class="v small">${esc(best?.name ?? '—')}</div></div></div>
      <div class="card done section">🐱✨ <b>Unlocked: Golden Maneki-neko</b> — a shining lucky cat now waves at your first stand.</div>
      <h3 class="section">📖 Chapter 2: The Empire</h3>
      <div class="grid g2 ch2">
        <div class="card"><span class="e">🏪</span><div><b>Franchising</b><div class="small muted">Sell franchises across Tokyo — they sell sushi for you everywhere.</div></div></div>
        <div class="card"><span class="e">✈️</span><div><b>International cities</b><div class="small muted">Osaka, Kyoto, Seoul, Singapore, New York, London, Paris, Dubai.</div></div></div>
        <div class="card"><span class="e">🏢</span><div><b>Headquarters</b><div class="small muted">Build a tower in Shinjuku that grows with your empire.</div></div></div>
        <div class="card"><span class="e">🏭</span><div><b>Central Kitchen & Logistics</b><div class="small muted">Industrial production and distribution boost everything.</div></div></div>
        <div class="card"><span class="e">🤝</span><div><b>Rival buyouts</b><div class="small muted">Buy out Kaiten King, Maguro Mart and Golden Chopstick.</div></div></div>
        <div class="card"><span class="e">🎯</span><div><b>Next goal: 2,000,000</b><div class="small muted">Then 10M, 100M, 1B... and beyond. There is no end.</div></div></div></div>
      <div class="row section" style="justify-content:center;gap:12px"><button class="btn ghost" data-act="empire">🌏 Open Empire tab</button><button class="btn big green" data-act="go">Continue building your empire ▶</button></div></div>`;
    const m: Modal = { kind: 'celebrate', el: e, onClose: () => {} };
    delegate(e, {
      go: () => { audio.sfx('fanfare'); this.remove(m); },
      empire: () => { this.remove(m); this.toggleManage('empire'); },
    });
    this.push(m);
  }

  showOffline(o: { seconds: number; pieces: number; revenue: number; expenses: number }): void {
    const { m, body } = this.window('offline', '🌙 While you were away...', 520);
    const net = o.revenue - o.expenses;
    body.innerHTML = `<p>You were gone for <b>${duration(o.seconds)}</b>. ${o.pieces ? 'Your managers and franchises kept the business running:' : 'Without managers, your restaurants stayed closed — but rent and wages were still due.'}</p>
      <table class="kv"><tr><td>🍣 Pieces sold</td><td>${exact(o.pieces)}</td></tr><tr><td>💴 Revenue</td><td class="good">+${yenExact(o.revenue)}</td></tr>
      <tr><td>🧾 Expenses</td><td class="bad">-${yenExact(o.expenses)}</td></tr><tr><td>📈 Net</td><td class="${net >= 0 ? 'good' : 'bad'}">${yenExact(net)}</td></tr></table>
      <p class="tiny muted">Offline earnings need a Manager in a fully staffed restaurant and run at reduced efficiency (capped).</p>
      <div class="row" style="justify-content:flex-end"><button class="btn big green" data-act="ok">Let's go!</button></div>`;
    delegate(body, { ok: () => this.remove(m) });
    this.push(m);
  }
}
