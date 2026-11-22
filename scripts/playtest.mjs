// Real-input playtest / bug hunt. Drives the game with the keyboard and mouse (WASD, Shift, Space, E, Tab, M, Esc,
// mouse drag/wheel, real button clicks) against an ALREADY RUNNING dev server (does NOT start one).
// State is only touched to set up scenarios (teleport near a target, give cash) — the last meters and every action use real input.
// Usage: node scripts/playtest.mjs [url] [outDir] [--dry] [--only=<regex>]
//   url      default http://localhost:5173/
//   outDir   default $PLAYTEST_OUT or <os tmpdir>/sushi-playtest  (screenshots + report.json)
//   --dry    no UI input at all: boot, start a game through state, run the tycoon setup (core APIs) and print the plan
//   --only=  run only sections whose name matches the regex (boot/new game always run; tycoon sections run their own setup)
// Exit code 1 if any section crashed or a page error was recorded.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (k) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a === undefined ? null : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const DRY = !!flag('dry');
const ONLY = typeof flag('only') === 'string' ? new RegExp(flag('only'), 'i') : null;
const url = pos[0] ?? 'http://localhost:5173/';
const out = pos[1] ?? process.env.PLAYTEST_OUT ?? join(tmpdir(), 'sushi-playtest');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.setDefaultTimeout(8_000);

// ------------------------------------------------------------------ logging
const logs = [];      // console errors / warnings / page errors
const findings = [];  // suspected bugs
const sections = [];  // per-section pass / crash
let current = 'boot';
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ section: current, type: m.type(), text: m.text().slice(0, 400) }); });
page.on('pageerror', (e) => logs.push({ section: current, type: 'pageerror', text: String(e.stack ?? e.message).slice(0, 800) }));
const find = (severity, title, detail = {}) => {
  const dup = findings.find((f) => f.section === current && f.title === title);
  if (dup) { dup.count = (dup.count ?? 1) + 1; return; } // same issue again in this section: count it, don't spam
  findings.push({ section: current, severity, title, ...detail }); console.log(`  [${severity}] ${title}`);
};
let shotN = 0;
const shot = async (name) => { const f = join(out, `${String(++shotN).padStart(2, '0')}-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
const sleep = (ms) => page.waitForTimeout(ms);

const mon = { stuck: [], nan: [], pen: [], cam: [], hitch: 0, frames: 0, minCash: Infinity };
async function drainMonitor() {
  const m = await page.evaluate(() => window.__pt?.drain()).catch(() => null);
  if (!m) return;
  for (const k of ['stuck', 'nan', 'pen', 'cam']) mon[k].push(...m[k].map((x) => ({ section: current, ...x })));
  mon.hitch += m.hitch; mon.frames += m.frames;
  if (m.minCash !== null) mon.minCash = Math.min(mon.minCash, m.minCash);
}

async function section(name, fn, { fresh = true, always = false, dry = false } = {}) {
  // --dry: only setup sections (no UI input); --only: name filter (always-sections still run)
  if (DRY ? !(always || dry) : (ONLY && !always && !ONLY.test(name))) return;
  if (page.isClosed()) return;
  current = name;
  const t0 = Date.now(), errs = logs.filter((l) => l.type === 'pageerror').length;
  console.log(`\n== ${name}`);
  try {
    if (fresh && sections.length > 1) await recover(); // every section starts from free play with no window open
    const detail = await fn();
    await drainMonitor();
    const pe = logs.filter((l) => l.type === 'pageerror').length - errs;
    sections.push({ name, ok: pe === 0, ms: Date.now() - t0, detail: detail ?? (pe ? `${pe} page error(s)` : '') });
    console.log(`  ${pe ? 'PAGEERROR' : 'ok'} (${Date.now() - t0} ms)${detail ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`);
  } catch (e) {
    sections.push({ name, ok: false, ms: Date.now() - t0, crash: String(e.message ?? e).split('\n').slice(0, 3).join(' | ') });
    console.log(`  CRASH ${String(e.message ?? e).split('\n')[0]}`);
    await shot(`crash-${name.replace(/\W+/g, '_')}`);
    await recover();
  }
}

// ------------------------------------------------------------------ in-page helpers
await page.addInitScript(() => {
  // Other agents edit files concurrently: block Vite's HMR socket so the page is not reloaded mid-test.
  window.WebSocket = class { constructor() {} addEventListener() {} removeEventListener() {} send() {} close() {} };
  performance.setResourceTimingBufferSize(10_000);
  // import a source module as the SAME instance the game uses (Vite may append ?t=... to its URL)
  window.__mod = (path) => {
    const hit = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(hit ?? path);
  };
  const g = () => window.game;
  const vis = (e) => !!e && e.isConnected && (e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? e.offsetParent !== null)
    && (() => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; })();
  const stack = () => g()?.ui?.stack ?? [];
  const topEl = () => stack().at(-1)?.el ?? [...document.querySelectorAll('.modal.open, .dialog.open, .open')].filter(vis).at(-1) ?? null;
  const pen = (p, r = 0.38) => {
    let worst = 0;
    for (const c of g().world.colliders) {
      if (c.player === false) continue; // camera-only (awnings)
      if (p.y > c.maxY - 0.05 || p.y + 1.6 < c.minY) continue;
      const cx = Math.max(c.minX, Math.min(p.x, c.maxX)), cz = Math.max(c.minZ, Math.min(p.z, c.maxZ));
      const inside = p.x > c.minX && p.x < c.maxX && p.z > c.minZ && p.z < c.maxZ;
      const d = inside ? -Math.min(p.x - c.minX, c.maxX - p.x, p.z - c.minZ, c.maxZ - p.z) : Math.hypot(p.x - cx, p.z - cz);
      worst = Math.max(worst, r - d);
    }
    return worst; // > 0 means the player circle overlaps a collider
  };
  const camInside = () => {
    const p = g().camera.position, m = 0.02;
    return g().world.colliders.some((c) => c.camera !== false && p.x > c.minX + m && p.x < c.maxX - m && p.y > c.minY + m && p.y < c.maxY - m && p.z > c.minZ + m && p.z < c.maxZ - m);
  };
  window.__pt = {
    vis, topEl, pen, camInside,
    kind: () => stack().at(-1)?.kind ?? topEl()?.className ?? null,
    snap: () => {
      const G = g(), s = G.s, p = G.player.pos;
      return {
        started: G.started, paused: G.paused, busy: G.busy, enabled: G.input.enabled, blocking: G.ui.isBlocking?.() ?? stack().length > 0,
        modal: stack().at(-1)?.kind ?? null, stack: stack().map((m) => m.kind), cash: s.cash, pieces: s.lifetime.pieces, tutorial: s.tutorial,
        district: G.district.id, rests: Object.keys(s.restaurants).length, staffN: s.staff.length, areas: s.districts.length,
        researchN: (s.research ?? []).length, upgN: Object.values(s.restaurants).reduce((a, r) => a + Object.values(r.upgrades ?? {}).reduce((x, y) => x + y, 0), 0),
        speed: G.speed ?? 1, clock: s.clock ?? 0, x: p.x, y: p.y, z: p.z, camYaw: G.cam.yaw, camDist: G.cam.dist, pen: pen(p), camInside: camInside(),
      };
    },
    /** Tag visible clickable controls inside the top modal (or a selector) with data-pt; return descriptors. */
    scan: (sel) => {
      const scope = sel ? document.querySelector(sel) : topEl();
      if (!scope) return [];
      document.querySelectorAll('[data-pt]').forEach((e) => e.removeAttribute('data-pt'));
      const els = [...scope.querySelectorAll('button, [data-act], [data-tab], [role=button], [role=tab], [role=switch], summary, .ing-btn, .tbar')].filter((e) => vis(e) && !e.disabled);
      return els.map((e, i) => {
        e.setAttribute('data-pt', String(i));
        return { i, sig: `${e.dataset.tab ?? ''}|${e.dataset.act ?? ''}|${e.dataset.arg ?? ''}|${(e.textContent ?? '').replace(/[\d,.¥]+/g, '#').trim().slice(0, 40)}`, text: (e.textContent ?? e.getAttribute('aria-label') ?? '').trim().slice(0, 60), tab: e.dataset.tab ?? null, act: e.dataset.act ?? null };
      });
    },
    /** Is `text` visible anywhere on screen? */
    textVisible: (text) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.includes(text.slice(0, 24)) && vis(n.parentElement)) return true;
      return false;
    },
    interactables: () => {
      const G = g();
      let list = [];
      try { list = G.interactables(); } catch { /* fallback below */ }
      if (!list?.length) {
        const d = G.district;
        // mirror of game.ts interactables(): owned shops (counter + door) open the sheet, unowned lots show a sign
        for (const s of d.sites) G.s.restaurants[s.id] ? list.push({ kind: 'shop', spot: s.counter, r: 2.5 }, { kind: 'shop', spot: s.door, r: 2.5 }) : list.push({ kind: 'sign', spot: s.sign, r: 2 });
        list.push({ kind: 'metro', spot: d.metro, r: 2.5 });
        if (d.hq && G.s.flags.chapter2) list.push({ kind: 'hq', spot: d.hq, r: 2.5 });
        for (const n of d.storyNpcs ?? []) list.push({ kind: 'npc', spot: n.spot, r: 2, name: n.name });
      }
      return list.map((it, i) => ({ i, kind: it.kind, x: it.spot.x, z: it.spot.z, yaw: it.spot.yaw ?? 0, r: it.r, prompt: (() => { try { return it.prompt?.() ?? null; } catch (e) { return `THROW ${e.message}`; } })() }));
    },
    /** Background monitor: stuck input, NaN cash, player inside walls, camera inside walls, frame hitches. */
    startMonitor: () => {
      if (window.__mon) return;
      const mon = window.__mon = { stuck: [], nan: [], pen: [], cam: [], hitch: 0, frames: 0, minCash: Infinity };
      let stuckSince = 0, last = performance.now(), camN = 0, penN = 0;
      const loop = () => {
        const now = performance.now(), G = g();
        if (G?.started) {
          mon.frames++;
          if (now - last > 120 && !document.hidden) mon.hitch++;
          const s = G.s;
          if (!Number.isFinite(s.cash) && mon.nan.length < 5) mon.nan.push({ t: now, cash: String(s.cash) });
          mon.minCash = Math.min(mon.minCash, s.cash);
          const blocked = !G.input.enabled && !G.paused && !(G.ui.isBlocking?.() ?? stack().length) && !document.querySelector('.fade-overlay');
          if (blocked) { if (!stuckSince) stuckSince = now; else if (now - stuckSince > 2500 && mon.stuck.length < 5 && !mon.stuck.some((x) => x.since === stuckSince)) mon.stuck.push({ since: stuckSince, busy: G.busy, locked: G.player.locked }); } else stuckSince = 0;
          const p = pen(G.player.pos);
          if (p > 0.12 && G.player.grounded && ++penN % 30 === 1 && mon.pen.length < 20) mon.pen.push({ x: +G.player.pos.x.toFixed(2), z: +G.player.pos.z.toFixed(2), pen: +p.toFixed(2), d: G.district.id });
          if (!G.cam.focus && camInside() && ++camN % 30 === 1 && mon.cam.length < 30) { const c = G.camera.position; mon.cam.push({ x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2), d: G.district.id, dist: +G.cam.dist.toFixed(1) }); }
        }
        last = now;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    /** Hand the monitor samples to Node and reset them (called after every section, so page reloads lose nothing). */
    drain: () => {
      const m = window.__mon;
      if (!m) return null;
      const out = JSON.parse(JSON.stringify({ ...m, minCash: Number.isFinite(m.minCash) ? m.minCash : null }));
      m.stuck = []; m.nan = []; m.pen = []; m.cam = []; m.hitch = 0; m.frames = 0; m.minCash = Infinity;
      return out;
    },
  };
  const t = setInterval(() => { if (window.game?.s) { clearInterval(t); window.__pt.startMonitor(); } }, 100);
});

const snap = () => page.evaluate(() => window.__pt.snap());
const ev = (fn, arg) => page.evaluate(fn, arg);
const W = () => page.viewportSize();

/** Close everything with Esc and make sure the game ends up playable. */
async function recover() {
  for (let i = 0; i < 6; i++) {
    const s = await snap().catch(() => null);
    if (!s) return;
    if (!s.stack.length && !s.paused) break;
    await page.keyboard.press('Escape'); await sleep(250);
  }
  await page.keyboard.up('w'); await page.keyboard.up('s'); await page.keyboard.up('Shift');
  await sleep(300);
}

/** Story beats / celebrations pop up on their own: read them through like a player (E for dialogs, the continue button for celebrations). */
async function settle() {
  for (let i = 0; i < 25; i++) {
    const s = await snap().catch(() => null);
    if (!s) return;
    if (s.modal === 'dialog') { await page.keyboard.press('e'); await sleep(120); continue; }
    if (s.modal && /celebrat|offline|milestone/i.test(s.modal)) {
      const b = page.locator('.open button').filter({ visible: true }).last();
      if (!(await b.click({ timeout: 800 }).then(() => true, () => false))) await page.keyboard.press('Escape');
      await sleep(300); continue;
    }
    return;
  }
}

/** Do a real input step; if a story beat / celebration popped up over it (the input went to that window), read it through and redo the step once. */
async function beatSafe(step, done = async () => false) {
  await settle(); await recover();
  await step();
  const s = await snap();
  if (await done()) return;
  if (!s.stack.some((k) => k === 'dialog' || /celebrat|milestone/i.test(k))) return;
  await settle(); await recover();
  await step();
}

/** Wait until input is enabled again; record a finding if it never comes back. */
async function expectPlayable(context, timeout = 3000) {
  await settle();
  const ok = await page.waitForFunction(() => window.game.input.enabled, null, { timeout, polling: 100 }).then(() => true, () => false);
  if (!ok) { const s = await snap(); find('high', `input stays disabled after ${context}`, { state: s }); await shot('stuck'); }
  return ok;
}

// ------------------------------------------------------------------ real-input movement helpers
/** Rotate the camera with a real mouse drag so that W walks along (dx, dz). Falls back to setting yaw if dragging does nothing. */
async function face(dx, dz) {
  const want = Math.atan2(-dx, -dz);
  const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // start the drag on a spot where the canvas (not a HUD panel) is under the cursor
  const { sx, sy } = await ev(() => {
    for (const [fx, fy] of [[0.5, 0.62], [0.5, 0.45], [0.35, 0.55], [0.65, 0.55], [0.5, 0.3]]) {
      const x = innerWidth * fx, y = innerHeight * fy;
      if (document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { sx: x, sy: y };
    }
    return { sx: innerWidth / 2, sy: innerHeight * 0.62 };
  });
  // up to 3 corrective drags (big turns can fall a little short); only "no rotation at all" is a bug
  for (let attempt = 0; attempt < 3; attempt++) {
    const { yaw, sens } = await ev(() => ({ yaw: window.game.cam.yaw, sens: window.game.cam.sensitivity }));
    const d = norm(want - yaw);
    if (Math.abs(d) < 0.12) return;
    const px = Math.max(-sx + 5, Math.min(W().width - sx - 5, -d / (0.005 * sens)));
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    const steps = Math.max(2, Math.ceil(Math.abs(px) / 40));
    for (let k = 1; k <= steps; k++) await page.mouse.move(sx + (px * k) / steps, sy, { steps: 1 });
    await page.mouse.up();
    await sleep(60);
    const after = await ev(() => window.game.cam.yaw);
    if (Math.abs(d) > 0.3 && Math.abs(norm(after - yaw)) < 0.05 && !(await snap()).stack.length && !(await snap()).paused) {
      if (!face.warned) { face.warned = true; find('high', 'mouse drag on the canvas did not rotate the camera', { want, before: yaw, after }); }
      break;
    }
  }
  if (Math.abs(norm(want - (await ev(() => window.game.cam.yaw)))) > 0.35) await ev((y) => { window.game.cam.yaw = y; }, want);
}

/** Walk toward (x, z) holding W (camera re-aimed every ~0.4 s). Returns final distance. */
async function walkTo(x, z, { stop = 0.6, timeout = 6000, sprint = false } = {}) {
  const t0 = Date.now();
  let d = Infinity;
  if (sprint) await page.keyboard.down('Shift');
  try {
    while (Date.now() - t0 < timeout) {
      const p = await ev(() => ({ x: window.game.player.pos.x, z: window.game.player.pos.z }));
      d = Math.hypot(x - p.x, z - p.z);
      if (d < stop) break;
      await face(x - p.x, z - p.z);
      await page.keyboard.down('w');
      await sleep(Math.min(400, Math.max(60, d * 120)));
      await page.keyboard.up('w');
    }
  } finally { await page.keyboard.up('w'); if (sprint) await page.keyboard.up('Shift'); }
  return d;
}

const hold = async (keys, ms) => { for (const k of keys) await page.keyboard.down(k); await sleep(ms); for (const k of [...keys].reverse()) await page.keyboard.up(k); };
const teleport = (x, z, yaw = 0) => ev(([x, z, yaw]) => { window.game.player.teleport(x, z, yaw); window.game.cam.snap?.(window.game.player.pos); }, [x, z, yaw]);
const freeAt = (x, z) => ev(([x, z]) => window.__pt.pen({ x, y: 0, z }, 0.6) <= 0, [x, z]);

// ------------------------------------------------------------------ "click every button" driver
const clickFails = [];
const DANGER =/delete|reset|wipe|quit|main menu|import|new game|yes, new|copy/i;
/**
 * Click every visible control in the top modal (or inside `scope`, a CSS selector) once, re-scanning after each click.
 * Checks cash after each click. broke: nothing may be bought (restaurants/staff/areas/research/upgrades unchanged, cash never < 0).
 * keepOpen: sub-windows a click opens are closed with Esc (default); return value = number of clicks.
 */
async function clickAll(label, { maxClicks = 60, skip = DANGER, tabsToo = false, scope = null, broke = false, also = null } = {}) {
  const done = new Set();
  let clicks = 0;
  const modal0 = (await snap()).modal;
  const activeTab = () => ev(() => document.querySelector('.open [data-tab].on, .open [role=tab][aria-selected=true]')?.dataset?.tab ?? null);
  const tab0 = await activeTab();
  while (clicks < maxClicks) {
    const s = await snap();
    if (s.modal !== modal0) break; // the click closed/replaced the window
    // a "Manage" / "Hire" link may jump to another tab: go back so every button of THIS tab gets clicked
    if (tab0 && (await activeTab()) !== tab0) await page.locator(`.open [data-tab="${tab0}"]`).first().click({ timeout: 1000 }).catch(() => {});
    const items = (await ev((sc) => window.__pt.scan(sc), scope)).filter((b) => (!also || also(b)) && !done.has(b.sig) && !skip.test(b.text) && (tabsToo || !b.tab) && !/^✕$|close|not now|cancel|back$/i.test(b.text.trim()));
    if (!items.length) break;
    const b = items[0];
    done.add(b.sig);
    if (broke) await ev(() => { window.game.s.cash = 0; window.game.setPaused?.(true); });
    const before = await snap();
    // the UI re-renders live, so a tagged element may be replaced between scan and click: re-scan and retry by signature
    let clicked = false;
    for (let tryN = 0; tryN < 3 && !clicked; tryN++) {
      const idx = tryN === 0 ? b.i : (await ev((sc) => window.__pt.scan(sc), scope)).find((x) => x.sig === b.sig)?.i;
      if (idx === undefined) break;
      const loc = page.locator(`[data-pt="${idx}"]`);
      clicked = await loc.click({ timeout: 700 }).then(() => true, () => false);
      if (!clicked) { const bb = await loc.boundingBox().catch(() => null); if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); clicked = true; } }
    }
    if (!clicked) clickFails.push(`${label}: ${b.text.replace(/\s+/g, ' ').slice(0, 40)}`);
    clicks++;
    await sleep(160);
    const after = await snap();
    if (!Number.isFinite(after.cash)) find('critical', `${label}: cash became ${after.cash} after clicking "${b.text}"`, { before: before.cash });
    else if (after.cash < 0 && before.cash >= 0) find('high', `${label}: cash went negative after clicking "${b.text}"`, { before: before.cash, after: after.cash });
    if (broke) {
      const bought = ['rests', 'staffN', 'areas', 'upgN'].filter((k) => after[k] > before[k]); // research costs RP, not yen
      if (bought.length) find('high', `${label}: "${b.text.replace(/\s+/g, ' ').slice(0, 40)}" went through while broke (${bought.join(', ')} increased)`, { cash: [before.cash, after.cash] });
      if (after.cash < before.cash - 1e-6) find('high', `${label}: "${b.text.replace(/\s+/g, ' ').slice(0, 40)}" charged ¥${(before.cash - after.cash).toFixed(0)} while broke`, { cash: [before.cash, after.cash] });
    }
    if (after.modal !== before.modal) { // opened something (e.g. a confirm) or closed itself
      if (after.modal === "dialog" || /celebrat/i.test(after.modal ?? "")) { await settle(); continue; } // a story beat popped up
      if (after.stack.length > before.stack.length) { await shot(`${label}-sub-${b.act ?? 'x'}`); await page.keyboard.press('Escape'); await sleep(250); }
      else break;
    }
  }
  if (broke) await ev(() => window.game.setPaused?.(false));
  return clicks;
}

// which window each interactable should open (matched against the modal kind, case-insensitive regex)
const EXPECT = { sign: 'prop', shop: 'sheet', metro: 'map', npc: 'dialog', hq: 'manage|empire' };

/** Real-input interaction test: approach the spot walking, check the prompt, press E, see what opens. */
async function interact(it, expect) {
  const back = 2.6;
  // start a few meters away, behind where the player would stand, on a free spot
  let sx = it.x - Math.sin(it.yaw) * back, sz = it.z - Math.cos(it.yaw) * back;
  for (const a of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const x = it.x - Math.sin(it.yaw + a) * back, z = it.z - Math.cos(it.yaw + a) * back;
    if (await freeAt(x, z)) { sx = x; sz = z; break; }
  }
  await settle();
  await teleport(sx, sz, it.yaw);
  await sleep(150);
  let dist = await walkTo(it.x, it.z, { stop: Math.min(0.6, it.r * 0.5), timeout: 5000 });
  await settle();
  let walked = true;
  if (dist > it.r) { walked = false; await teleport(it.x, it.z, it.yaw); await sleep(200); dist = 0; }
  const prompt = await ev((i) => window.__pt.interactables()[i]?.prompt ?? null, it.i);
  const shown = prompt ? await page.waitForFunction((t) => window.__pt.textVisible(t), prompt, { timeout: 1500 }).then(() => true, () => false) : null;
  if (prompt && !shown) find('medium', `${it.kind}: prompt "${prompt}" not visible on screen when standing at the spot`);
  if (!prompt) return { kind: it.kind, walked, prompt: null };
  const before = await snap();
  await page.keyboard.press('e');
  await sleep(700);
  const after = await snap();
  let opened = after.modal;
  if (opened === 'dialog' && it.kind !== 'npc') { // a story beat popped up at the same moment: read it, retry once
    await settle(); await page.keyboard.press('e'); await sleep(700);
    opened = (await snap()).modal;
  }
  if (expect && (expect === "none" ? !!opened : !new RegExp(expect, "i").test(opened ?? ""))) find('medium', `${it.kind}: E opened "${opened}" (expected "${expect}")`, { prompt });
  await shot(`interact-${it.kind}`);
  return { kind: it.kind, walked, prompt, opened, cash: [before.cash, after.cash] };
}

// ------------------------------------------------------------------ tycoon helpers (core APIs for setup only; all actions use real input)
/** Load src/core modules into window.__core (same instances as the game). Returns the list of missing exports, if any. */
async function loadCore() {
  return ev(async () => {
    const [A, E, D, S] = await Promise.all(['actions', 'empire', 'data', 'sim'].map((m) => window.__mod(`/src/core/${m}.ts`)));
    window.__core = { A, E, D, S };
    const need = { A: ['unlockDistrict', 'buyProperty', 'conceptAllowed', 'fitoutCost'], E: ['alerts', 'applyFix', 'hireBest', 'restaurantKPIs'], D: ['AREAS', 'PROPERTIES', 'CONCEPTS', 'CONCEPT_IDS'], S: ['understaffed', 'isAutomated', 'staffAt'] };
    return Object.entries(need).flatMap(([m, ks]) => ks.filter((k) => !(k in window.__core[m])).map((k) => `${m}.${k}`));
  });
}

/**
 * State-only setup for the tycoon sections: enough pieces/cash, every walkable area unlocked, and one more lot in each
 * walkable area (so the Daichō is the default Manage view and metro travel has owned lots to visit). Idempotent.
 */
async function tycoonSetup({ cash = 2e8, pieces = 60_000, target = 14 } = {}) {
  const missing = await loadCore();
  if (missing.length) throw new Error(`core API missing: ${missing.join(', ')}`);
  return ev(({ cash, pieces, target }) => {
    const { A, E, D } = window.__core, s = window.game.s;
    s.cash = Math.max(s.cash, cash); s.lifetime.pieces = Math.max(s.lifetime.pieces, pieces);
    const walk = D.AREA_IDS ? D.AREA_IDS.filter((a) => D.AREAS[a].walkable) : Object.keys(D.AREAS).filter((a) => D.AREAS[a].walkable);
    const errs = [];
    for (const a of walk) if (!s.districts.includes(a)) { const e = A.unlockDistrict(s, a); if (e) errs.push(`unlock ${a}: ${e}`); }
    for (const a of walk) {
      if (!s.districts.includes(a)) continue;
      const owned = Object.keys(s.restaurants).filter((id) => D.PROPERTIES[id]?.district === a).length;
      if (owned >= (a === 'asakusa' ? 2 : 1)) continue;
      const lot = Object.values(D.PROPERTIES).filter((p) => p.district === a && !s.restaurants[p.id] && p.kind !== 'stand').sort((x, y) => x.price - y.price)[0];
      if (lot) { const e = A.buyProperty(s, lot.id, 'bar'); if (e) errs.push(`buy ${lot.id}: ${e}`); }
    }
    // mid-game empire: top up to `target` restaurants with mixed formats (cheapest lots first, any unlocked area)
    const others = (D.AREA_IDS ?? Object.keys(D.AREAS)).filter((a) => !D.AREAS[a].walkable && !D.AREAS[a].unlock.chapter2).sort((a, b) => D.AREAS[a].unlock.cost - D.AREAS[b].unlock.cost);
    for (const a of others.slice(0, 3)) if (!s.districts.includes(a)) A.unlockDistrict(s, a);
    const fmts = D.CONCEPT_IDS.filter((c) => c !== 'stand');
    const lots = Object.values(D.PROPERTIES).filter((p) => s.districts.includes(p.district) && p.kind !== 'stand').sort((x, y) => x.price - y.price);
    for (const lot of lots) {
      if (Object.keys(s.restaurants).length >= target) break;
      if (s.restaurants[lot.id]) continue;
      const c = fmts.map((_, k) => fmts[(Object.keys(s.restaurants).length + k) % fmts.length]).find((x) => !A.conceptAllowed(s, lot.id, x));
      if (c) A.buyProperty(s, lot.id, c);
    }
    s.tutorial = 99; // mid-game: the HUD alert pill and hints are tutorial-gated
    window.game.refreshWorld?.();
    const al = E.alerts(s);
    return { restaurants: Object.keys(s.restaurants).length, areas: s.districts.length, walkable: walk, cash: Math.round(s.cash), alerts: al.length, fixable: al.filter((x) => x.fix).length, errs };
  }, { cash, pieces, target });
}

/** Lots × concepts the player could buy right now: [{ lot, area, concept, total, why }] (why = refusal reason or null). */
const conceptPlan = () => ev(() => {
  const { A, D } = window.__core, s = window.game.s;
  const lots = Object.values(D.PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district));
  return D.CONCEPT_IDS.map((c) => {
    const ok = lots.filter((p) => !A.conceptAllowed(s, p.id, c)).map((p) => ({ lot: p.id, area: p.district, total: p.price + A.fitoutCost(p.id, c) })).sort((a, b) => a.total - b.total);
    const pick = ok.find((x) => x.total <= s.cash) ?? null;
    return { concept: c, ...(pick ?? {}), why: pick ? null : ok.length ? `cheapest ${ok[0].total} > cash` : (lots[0] ? A.conceptAllowed(s, lots[0].id, c) : 'no unowned lot in an unlocked area') };
  });
});

/** Open Manage with the real Tab key and make sure the Daichō dashboard is showing. Returns true when it is. */
async function openDaicho() {
  await recover(); await settle();
  await page.keyboard.press('Tab'); await sleep(500);
  let s = await snap();
  if (s.modal === 'dialog') { await settle(); await recover(); await page.keyboard.press('Tab'); await sleep(500); s = await snap(); } // a story beat popped up
  if (s.modal === 'sheet') { find('medium', 'Tab opened a restaurant sheet instead of the Daichō while owning ≥2 restaurants', { rests: s.rests }); await recover(); return false; }
  if (s.modal !== 'manage') { find('high', `Tab did not open Manage (got "${s.modal}")`); return false; }
  const shown = await page.waitForFunction(() => { const e = document.querySelector('.open .dc-root'); return !!e && window.__pt.vis(e); }, null, { timeout: 4000 }).then(() => true, () => false);
  if (!shown) {
    const tab = page.locator('.open [data-tab="daicho"]').first();
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await sleep(500); }
    const again = await ev(() => !!document.querySelector('.open .dc-root'));
    find(again ? 'medium' : 'high', again ? 'Daichō is not the default Manage view with ≥2 restaurants (needed a tab click)' : 'Daichō dashboard did not render (fallback list shown?)');
    if (!again) await shot('daicho-missing');
    return again;
  }
  return true;
}

/** Click an element by real mouse at its centre (works for SVG <g> map pins too). */
async function mouseClick(sel) {
  const loc = page.locator(sel).first();
  if (!(await loc.count())) return false;
  await loc.scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
  const bb = await loc.boundingBox().catch(() => null);
  if (!bb) return false;
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  return true;
}

/** Open the for-sale window of a lot: Daichō map (area → lot) by real clicks, else the UI hook (logged). */
async function openLot(lot, area) {
  if (await openDaicho()) {
    await mouseClick(`.open .dc-root [data-act="area"][data-arg="${area}"]`); await sleep(400);
    if (await mouseClick(`.open .dc-root [data-arg="${lot}"]`)) { await sleep(500); if ((await snap()).modal === 'prop') return 'map'; }
  }
  await recover();
  await ev((id) => window.game.ui.openProperty(id), lot); await sleep(400);
  return (await snap()).modal === 'prop' ? 'hook' : null;
}

/** Pause menu → "Save & main menu". That reloads the page, so wait for the game to boot back to the title. */
async function toTitle() {
  await page.getByRole('button', { name: /save & main menu|main menu/i }).first().click();
  await page.waitForFunction(() => window.game?.s && !window.game.started && !!document.querySelector('.title'), null, { timeout: 60_000 });
  await sleep(600);
}

// =================================================================== the playtest
await section('boot + fresh title screen', async () => {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.game?.s, null, { timeout: 60_000 });
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.game?.s, null, { timeout: 60_000 });
  await sleep(800);
  await shot('title');
  if (DRY) return 'dry run: no input';
  // keys must not move anything on the title screen
  await hold(['w', 'Tab'], 300);
  if ((await snap()).started) find('high', 'game started from a key press on the title screen');
}, { always: true });

if (DRY || ONLY) await section('dry/--only: start a new game through state (no title clicks)', async () => {
  await ev(() => { const g = window.game; const dlg = g.ui.dialog; g.ui.dialog = async () => {}; g.newGame({ name: 'Play Tester', company: 'Playtest Holdings' }); g.ui.dialog = dlg; });
  await page.waitForFunction(() => window.game.started, null, { timeout: 10_000 });
  await ev(() => { window.game.s.tutorial = 99; }); // tycoon sections don't need the tutorial
  return { cash: (await snap()).cash };
}, { dry: true, always: !!ONLY });

if (!ONLY) await section('title buttons + new game (company + owner name, real clicks)', async () => {
  for (const name of [/settings/i, /credits/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible()) { await b.click(); await sleep(250); await shot(`title-${name.source}`); const back = page.getByRole('button', { name: /^back$/i }).first(); if (await back.isVisible()) await back.click(); }
  }
  await page.getByRole('button', { name: /new game/i }).first().click();
  await sleep(300);
  const confirm = page.getByRole('button', { name: /yes, new game/i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.locator('#nc-co').fill('Playtest Holdings');
  await page.locator('#nc-name').fill('Play Tester');
  await shot('new-game');
  await page.getByRole('button', { name: /open the stand/i }).first().click();
  await page.waitForFunction(() => window.game.started, null, { timeout: 10_000 });
  const p = await ev(() => ({ company: window.game.s.player.company, name: window.game.s.player.name, cash: window.game.s.cash }));
  if (p.company !== 'Playtest Holdings' || p.name !== 'Play Tester') find('high', 'new game did not keep the typed company/owner name', p);
  if (Math.round(p.cash) !== 7_000) find('low', `new game starts with ¥${Math.round(p.cash)} (expected ¥7,000)`);
  return p;
});

await section('intro dialog: Tab/M/Space/Esc spam, then E through', async () => {
  const dlg = await page.waitForFunction(() => window.__pt.kind() === 'dialog', null, { timeout: 5000 }).then(() => true, () => false);
  if (!dlg) { find('medium', 'intro dialog did not appear after starting a new game'); return 'no intro dialog'; }
  const y0 = (await snap()).y;
  await page.keyboard.press('Tab'); await page.keyboard.press('m'); await page.keyboard.press('Space');
  await sleep(150);
  let s = await snap();
  if (s.stack.includes('manage') || s.stack.includes('map')) find('medium', 'Tab/M opened a window on top of the intro dialog', { stack: s.stack });
  if (s.y > y0 + 0.05 || !(await ev(() => window.game.player.grounded))) find('low', 'Space during dialog makes the chef jump');
  await shot('dialog');
  for (let i = 0; i < 12 && (await snap()).modal === 'dialog'; i++) { await page.keyboard.press('e'); await sleep(120); }
  await sleep(300);
  s = await snap();
  if (s.modal) { await recover(); }
  await expectPlayable('the intro dialog');
  return { tutorial: (await snap()).tutorial };
}, { fresh: false });

await section('movement: WASD / arrows / sprint / jump / mouse drag + wheel', async () => {
  const res = {};
  const start = await snap();
  await face(0, 1);
  for (const [k, label] of [['w', 'W'], ['s', 'S'], ['a', 'A'], ['d', 'D'], ['ArrowUp', 'Up'], ['ArrowLeft', 'Left']]) {
    const a = await snap(); await hold([k], 450); await sleep(250); const b = await snap();
    res[label] = +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2);
    if (res[label] < 0.4) find('high', `key ${label} does not move the chef`, { moved: res[label] });
  }
  // sprint vs walk speed
  // measure the commanded horizontal speed at the end of a hold (independent of walls in the way)
  const sp = async (keys) => { for (const k of keys) await page.keyboard.down(k); await sleep(700); const v = await ev(() => Math.hypot(window.game.player.vel.x, window.game.player.vel.z)); for (const k of [...keys].reverse()) await page.keyboard.up(k); return v; };
  await face(0, 1);
  const walk = await sp(['w']); await sleep(300);
  await face(0, -1);
  const run = await sp(['Shift', 'w']);
  res.walk = +walk.toFixed(2); res.sprint = +run.toFixed(2);
  if (run < walk * 1.3) find('medium', 'Shift sprint is not noticeably faster than walking', res);
  // jump
  await page.keyboard.press('Space');
  let maxY = 0;
  for (let i = 0; i < 12; i++) { maxY = Math.max(maxY, (await snap()).y); await sleep(40); }
  res.jumpY = +maxY.toFixed(2);
  if (maxY < 0.3) find('high', 'Space does not jump', res);
  // mouse drag + wheel
  const c0 = await snap();
  const { width, height } = W();
  await page.mouse.move(width / 2, height / 2); await page.mouse.down(); await page.mouse.move(width / 2 + 200, height / 2 + 60, { steps: 8 }); await page.mouse.up();
  await page.mouse.wheel(0, 400); await sleep(200);
  const c1 = await snap();
  res.dragYaw = +(c1.camYaw - c0.camYaw).toFixed(2); res.zoom = [c0.camDist, c1.camDist];
  if (Math.abs(res.dragYaw) < 0.2) find('high', 'mouse drag does not rotate the camera', res);
  if (c1.camDist === c0.camDist) find('medium', 'mouse wheel does not zoom', res);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -200);
  await sleep(200);
  res.zoomMin = (await snap()).camDist;
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 200);
  await sleep(200);
  res.zoomMax = (await snap()).camDist;
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
  await shot('movement');
  // keys held while a window opens must not keep walking
  await page.keyboard.down('w'); await sleep(150); await page.keyboard.press('Tab'); await sleep(150);
  const m0 = await snap(); await sleep(400); const m1 = await snap();
  await page.keyboard.up('w');
  if (m1.modal && Math.hypot(m1.x - m0.x, m1.z - m0.z) > 0.3) find('medium', 'chef keeps walking while the Tab menu is open', { moved: Math.hypot(m1.x - m0.x, m1.z - m0.z) });
  // Space with a window open (also the native "activate focused button" key) must not make the chef jump behind it
  if (m1.modal) {
    await ev(() => document.activeElement?.blur?.());
    await page.keyboard.press('Space');
    let jy = 0; for (let i = 0; i < 8; i++) { jy = Math.max(jy, (await snap()).y); await sleep(40); }
    if (jy > 0.2) find('low', `Space while the "${m1.modal}" window is open makes the chef jump behind it`, { jumpY: +jy.toFixed(2) });
  }
  await recover();
  res.start = [start.x.toFixed(1), start.z.toFixed(1)];
  return res;
});

await section('walls: walk/sprint/jump into buildings from 4 sides, back against walls (camera)', async () => {
  // pick big camera-blocking colliders near the player
  const targets = await ev(() => {
    const p = window.game.player.pos;
    return window.game.world.colliders
      .map((c, i) => ({ i, c, d: Math.hypot((c.minX + c.maxX) / 2 - p.x, (c.minZ + c.maxZ) / 2 - p.z), w: c.maxX - c.minX, dd: c.maxZ - c.minZ }))
      .filter((o) => o.c.camera !== false && o.c.player !== false && o.c.minY < 0.3 && o.c.maxY > 2 && Math.max(o.w, o.dd) > 1.5 && o.d < 45)
      .sort((a, b) => a.d - b.d).slice(0, 8)
      .map((o) => ({ i: o.i, minX: o.c.minX, maxX: o.c.maxX, minZ: o.c.minZ, maxZ: o.c.maxZ }));
  });
  let tests = 0, clipP = 0, clipC = 0, stuck = 0;
  for (const c of targets) {
    const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const fx = nx ? (nx > 0 ? c.maxX : c.minX) : cx, fz = nz ? (nz > 0 ? c.maxZ : c.minZ) : cz;
      const sx = fx + nx * 2.2, sz = fz + nz * 2.2;
      if (!(await freeAt(sx, sz))) continue;
      tests++;
      await teleport(sx, sz, 0);
      await face(-nx, -nz);
      await page.keyboard.down('Shift'); await page.keyboard.down('w');
      await sleep(550); await page.keyboard.press('Space'); await sleep(550);
      await page.keyboard.up('w'); await page.keyboard.up('Shift');
      await sleep(100);
      const a = await snap();
      if (a.pen > 0.12) { clipP++; find('high', 'player overlaps a collider after sprinting into a wall', { at: [a.x, a.z], pen: a.pen, box: c }); await shot('clip-player'); }
      // through = now on the far side of the face AND still within the box's span on the other axis (not slid around its end)
      const lateralIn = nx ? a.z > c.minZ && a.z < c.maxZ : a.x > c.minX && a.x < c.maxX;
      if (lateralIn && (nx ? Math.sign(a.x - fx) : Math.sign(a.z - fz)) === -(nx || nz) && Math.abs(nx ? a.x - fx : a.z - fz) > 0.2) { clipP++; find('critical', 'player passed THROUGH a building', { from: [sx, sz], to: [a.x, a.z], box: c }); }
      // back into the wall (S walks toward the camera, which is now between the chef and the wall)
      await face(nx, nz);
      await hold(['s'], 700); await sleep(200);
      const b = await snap();
      if (b.camInside) { clipC++; if (clipC <= 3) { find('medium', 'camera ends up inside a building when backing against a wall', { at: [b.x, b.z], camDist: b.camDist }); await shot('clip-camera'); } }
      // walk away: must not be stuck (try straight away, then both sideways: a low prop may sit right behind the chef)
      let escaped = false;
      for (const [ex, ez] of [[nx, nz], [nz, nx], [-nz, -nx]]) {
        const p0 = await snap();
        await face(ex, ez); await hold(['w'], 500);
        const d = await snap();
        if (Math.hypot(d.x - p0.x, d.z - p0.z) >= 0.5) { escaped = true; break; }
      }
      if (!escaped) { stuck++; find('high', 'chef stuck against a wall (cannot walk away in any direction)', { at: [b.x, b.z] }); }
    }
  }
  return { colliders: targets.length, tests, clipPlayer: clipP, clipCamera: clipC, stuck };
});

/** Walk up to the starter stand with real keys and press E (interact() checks the "Manage …" prompt). Returns the modal kind. */
async function eAtStand() {
  const it = (await ev(() => window.__pt.interactables())).find((x) => x.kind === 'shop');
  if (!it) return null;
  await recover();
  return (await interact(it, 'sheet')).opened ?? null;
}
const sheetTabOn = () => ev(() => document.querySelector('.open .sheet-tabs .stab.on, .open .sheet-tabs [data-tab].on')?.dataset.tab ?? null);
const STAND = 'asakusa_stand';

await section('stand: E opens Staff, hiring a chef (real click) makes a sale, understaffed until a server is hired', async () => {
  await loadCore();
  const res = {};
  // tutorial 0 → 1 by walking up; E then opens the sheet on the Staff tab
  res.opened = await eAtStand();
  res.tutorial = (await snap()).tutorial;
  if (res.opened !== 'sheet') { find('high', `E at the stand opened "${res.opened}" (expected the restaurant sheet)`); return res; }
  res.tab = await sheetTabOn();
  if (res.tutorial === 1 && res.tab !== 'staff') find('medium', `E at the stand during "hire a chef" opened the "${res.tab}" tab (expected Staff)`);
  const sold0 = await ev(() => window.game.s.lifetime.customers);
  if (sold0 > 0 && !(await ev((id) => window.__core.S.isAutomated(window.game.s, id), STAND))) find('high', 'the stand sold something with no chef', { customers: sold0 });
  const chefBtn = page.locator('.open [data-act="hirebest"][data-arg="chef"]').filter({ visible: true }).first();
  if (!(await chefBtn.count())) { find('high', 'Staff tab has no "Hire best chef" button on a fresh stand'); return res; }
  await chefBtn.click();
  const hired = await page.waitForFunction((id) => window.game.s.staff.some((e) => e.role === 'chef' && e.restaurant === id), STAND, { timeout: 3000 }).then(() => true, () => false);
  if (!hired) { find('high', 'clicking "Hire best chef" did not hire a chef', { cash: (await snap()).cash }); return res; }
  // a stand needs a server: with the chef alone it is understaffed and the Daichō says so
  res.understaffed = await ev((id) => ({ sim: window.__core.S.understaffed(window.game.s, id), alert: window.__core.E.alerts(window.game.s).some((a) => a.id === 'understaffed' && a.restIds.includes(id)) }), STAND);
  if (!res.understaffed.sim || !res.understaffed.alert) find('medium', 'stand with a chef and no server is not flagged understaffed', res.understaffed);
  await recover();
  // the first sale comes on its own (4× speed with the real key)
  await page.keyboard.press('3');
  const t0 = Date.now();
  const sold = await page.waitForFunction(() => window.game.s.lifetime.customers > 0, null, { timeout: 60_000, polling: 250 }).then(() => true, () => false);
  res.firstSaleS = Math.round((Date.now() - t0) / 1000);
  await page.keyboard.press('1');
  if (!sold) { find('high', 'no sale within 60 s (4×) after hiring a chef'); return res; }
  await settle();
  if (!(await page.waitForFunction(() => window.game.s.tutorial >= 3, null, { timeout: 5000 }).then(() => true, () => false))) find('medium', 'tutorial did not reach "hire a server" after the first sale', { tutorial: (await snap()).tutorial });
  // hire a server through E → Staff
  await ev(() => { window.game.s.cash += 20_000; }); // skip a few minutes of earning
  res.opened2 = await eAtStand();
  res.tab2 = await sheetTabOn();
  if (res.opened2 === 'sheet' && res.tab2 !== 'staff' && (await snap()).tutorial === 3) find('medium', `E at the stand during "hire a server" opened the "${res.tab2}" tab (expected Staff)`);
  const srv = page.locator('.open [data-act="hirebest"][data-arg="server"]').filter({ visible: true }).first();
  if (await srv.count()) await srv.click(); else find('high', 'Staff tab has no "Hire best server" button with a lone chef');
  await sleep(400);
  res.after = await ev((id) => ({ sim: window.__core.S.understaffed(window.game.s, id), alert: window.__core.E.alerts(window.game.s).some((a) => a.id === 'understaffed' && a.restIds.includes(id)), tutorial: window.game.s.tutorial }), STAND);
  if (res.after.sim || res.after.alert) find('medium', 'stand still understaffed after hiring a server', res.after);
  if (res.after.tutorial < 4) find('medium', 'tutorial did not advance after hiring a server', res.after);
  await shot('stand-staffed');
  await recover();
  await expectPlayable('stand staffing');
  return res;
});

await section('every interactable: walk up, check prompt, press E', async () => {
  const its = await ev(() => window.__pt.interactables());
  const res = [];
  for (const it of its) {
    const r = await interact(it, EXPECT[it.kind]);
    res.push(`${it.kind}:${r.opened ?? (r.prompt ? 'nothing' : 'no-prompt')}${r.walked ? '' : '(teleported)'}`);
    if (r.opened === 'dialog') {
      // Esc during dialog must close it and give control back
      await page.keyboard.press('Escape'); await sleep(250);
      if ((await snap()).paused) await page.keyboard.press('Escape');
    } else if (r.opened) {
      await clickAll(`interact-${it.kind}`, { maxClicks: 12, skip: /travel|unlock|buy|go$|delete|import/i });
      await page.keyboard.press('Escape'); await sleep(250);
    }
    await recover();
    await expectPlayable(`closing ${it.kind}`);
  }
  return res;
});

async function manageAll(label) {
  await recover();
  await page.keyboard.press('Tab'); await sleep(400);
  let s = await snap();
  // owner-first: with a single restaurant Tab opens its sheet; the classic tabs are then reached through Manage
  if (s.modal === 'sheet') {
    await clickAll(`${label}-sheet`, { scope: '.open .sheet .sheet-body', maxClicks: 25, skip: /ride the metro|travel|delete/i });
    await recover();
    await ev(() => window.game.ui.toggleManage('staff')); await sleep(400);
    s = await snap();
  }
  if (s.modal !== 'manage') { find('high', 'Tab did not open management', { modal: s.modal }); return; }
  const tabs = (await ev(() => window.__pt.scan())).filter((b) => b.tab);
  const out = {};
  for (const t of tabs) {
    s = await snap();
    if (s.modal !== 'manage') { await recover(); await page.keyboard.press('Tab'); await sleep(300); }
    await page.locator(`[data-tab="${t.tab}"]`).first().click({ timeout: 1500 }).catch(() => {});
    await sleep(250);
    // sliders: real mouse clicks at both ends; selects: every option; text: type
    const ranges = await page.locator('.manage input[type=range], .open input[type=range]').filter({ visible: true }).all();
    for (const r of ranges) { const b = await r.boundingBox(); if (b) { await page.mouse.click(b.x + 3, b.y + b.height / 2); await page.mouse.click(b.x + b.width - 3, b.y + b.height / 2); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); } }
    for (const sel of await page.locator('.open select').filter({ visible: true }).all()) {
      const vals = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value));
      for (const v of vals.slice(0, 3)) await sel.selectOption(v).catch(() => {});
    }
    for (const inp of await page.locator('.open input[type=text], .open input[type=number]').filter({ visible: true }).all()) await inp.fill('42').catch(() => {});
    if ((await snap()).cash < 0) find('high', `${label}/${t.tab}: cash negative after sliders/inputs`);
    out[t.tab] = await clickAll(`${label}-${t.tab}`, { maxClicks: 45, skip: /travel|delete|reset|import|quit/i });
    await shot(`${label}-${t.tab}`);
    const after = await snap();
    if (!Number.isFinite(after.cash)) find('critical', `${label}/${t.tab}: cash is ${after.cash}`);
  }
  // Tab closes it again
  await page.keyboard.press('Tab'); await sleep(300);
  if ((await snap()).modal === 'manage') find('info', 'Tab does not close the management window (by design: a11y keyboard navigation)');
  await recover();
  await expectPlayable(`${label} management`);
  return out;
}

await section('Tab management: every tab + button with no money', async () => {
  await ev(() => { window.game.s.cash = 0; });
  return manageAll('manage-broke');
});

await section('Tab management: every tab + button rich (unlock everything we can)', async () => {
  await ev(() => { const s = window.game.s; s.cash = 5e9; s.lifetime.pieces = Math.max(s.lifetime.pieces, 60_000); s.rp = (s.rp ?? 0) + 1e6; });
  await settle();
  const r = await manageAll('manage-rich');
  const s = await snap();
  return { ...r, cashLeft: s.cash, district: s.district };
});

await section('metro travel: E/Tab/M/Esc spam during the fade', async () => {
  await recover();
  const s0 = await snap();
  await page.keyboard.press('m'); await sleep(400);
  if ((await snap()).modal !== 'map') { find('medium', 'M did not open the map'); return; }
  await shot('map');
  // pick another open district on the map and press its travel button with real clicks
  const picks = await ev(() => [...document.querySelectorAll('.open [data-act=pick]')].map((e) => e.dataset.arg));
  let went = false;
  for (const d of picks) {
    if (d === s0.district) continue;
    const pick = page.locator(`.open [data-act=pick][data-arg="${d}"]`).first();
    const bb = await pick.boundingBox().catch(() => null);
    if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(200);
    const go = page.getByRole('button', { name: /travel to/i }).first();
    if (await go.isVisible().catch(() => false)) { await go.click(); went = true; break; }
  }
  if (!went) { await recover(); return { note: 'no other open district', open: await ev(() => window.game.s.districts) }; }
  for (let i = 0; i < 10; i++) { for (const k of ['e', 'Tab', 'm', 'Escape']) await page.keyboard.press(k); await sleep(60); }
  await sleep(2200);
  await shot('after-travel');
  const s1 = await snap();
  if (s1.district === s0.district) find('high', 'travel did not change district', { from: s0.district });
  if (s1.stack.length) find('medium', `windows left open after travelling with key spam: ${s1.stack}`);
  if (s1.pen > 0.12) find('high', 'arrived inside a collider after travel', { at: [s1.x, s1.z] });
  await recover();
  await expectPlayable('travel');
  // walk around the new district for a bit
  await face(0, 1); await hold(['Shift', 'w'], 1500); await face(1, 0); await hold(['w'], 800);
  return { from: s0.district, to: s1.district };
});

await section('new district: every interactable', async () => {
  const its = await ev(() => window.__pt.interactables());
  const res = [];
  for (const it of its.filter((x) => ['sign', 'shop', 'metro', 'npc', 'hq'].includes(x.kind))) {
    const r = await interact(it, EXPECT[it.kind]);
    res.push(`${it.kind}:${r.opened ?? 'none'}`);
    await recover();
    await expectPlayable(`closing ${it.kind}`);
  }
  return res;
});

// =================================================================== tycoon: Daichō dashboard & management (real input)
await section('tycoon setup (core APIs): unlock walkable areas, one extra lot each', async () => {
  await settle();
  const r = await tycoonSetup();
  if (r.errs.length) find('medium', 'tycoon setup could not unlock/buy everything', { errs: r.errs });
  const plan = await conceptPlan();
  return { ...r, concepts: plan.map((p) => `${p.concept}:${p.lot ?? p.why}`) };
}, { dry: true });

await section('Daichō: Tab opens the dashboard; KPI strip + every visible control', async () => {
  await tycoonSetup();
  if (!(await openDaicho())) return 'no dashboard';
  await shot('daicho');
  const parts = await ev(() => Object.fromEntries(['dc-a-strip', 'dc-a-map', 'dc-a-ledger', 'dc-a-rail'].map((c) => [c, !!document.querySelector(`.open .${c}`)])));
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) find('medium', `Daichō parts missing: ${missing.join(', ')}`);
  const kpis = await ev(() => [...document.querySelectorAll('.open .dc-strip-kpis li, .open .dc-strip [class*=kpi]')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6));
  if (kpis.some((t) => /NaN|undefined|Infinity/.test(t))) find('high', 'Daichō KPI strip shows NaN/undefined', { kpis });
  // strip controls (speed hanko etc.) — the speed section checks their effect
  const strip = await clickAll('daicho-strip', { scope: '.open .dc-a-strip', maxClicks: 12 });
  // the HUD alert pill must open the Daichō too
  await recover();
  await sleep(1500); await settle(); await recover();
  const pill = await ev(() => { const e = document.querySelector('#h-alerts'); return e ? { shown: !e.hidden && window.__pt.vis(e), text: e.textContent.trim() } : null; });
  let pillOpens = null;
  if (pill?.shown) { await beatSafe(async () => { await mouseClick('#h-alerts'); await sleep(600); }); pillOpens = await ev(() => !!document.querySelector('.open .dc-root')); if (!pillOpens) find('medium', 'clicking the HUD alert pill did not open the Daichō', { ...pill, stack: (await snap()).stack }); await recover(); }
  else if (await ev(() => window.__core.E.alerts(window.game.s).some((a) => a.severity !== 'opportunity'))) find('medium', 'HUD alert pill hidden although there are critical/warning alerts', pill);
  await page.locator('.open .dc-a-strip [data-n="1"]').first().click({ timeout: 800 }).catch(() => {}); // back to 1×
  return { parts, kpis, strip, pill, pillOpens };
});

await section('Daichō alerts: one-click fixes, snooze, show more', async () => {
  await tycoonSetup(); // the lots it buys have no crew: an "unstaffed" alert with a Hire crew fix
  if (!(await openDaicho())) return 'no dashboard';
  await sleep(1200); // the dashboard snapshots on a cadence
  const rail = '.open .dc-a-rail';
  const count = () => ev((r) => document.querySelectorAll(`${r} .dc-al-fix, ${r} [class*=dc-al-fix]`).length, rail);
  const res = { before: await ev(() => window.__core.E.alerts(window.game.s).map((a) => a.id)), fixes: 0, snoozed: 0 };
  // one-click fixes: each must change state or explain itself, never NaN / negative cash
  for (let i = 0; i < 12; i++) {
    const fix = page.locator(`${rail} .dc-al-fix`).filter({ visible: true }).first();
    if (!(await fix.count())) break;
    const label = ((await fix.textContent()) ?? '').trim(), b = await snap();
    await fix.click({ timeout: 1000 }).catch(() => {}); await sleep(600);
    const a = await snap(); res.fixes++;
    if (!Number.isFinite(a.cash) || a.cash < 0) find('high', `alert fix "${label}" left cash at ${a.cash}`);
    if (a.staffN === b.staffN && a.cash === b.cash && /hire|price/i.test(label)) find('low', `alert fix "${label}" changed nothing visible (staff/cash)`, { cash: b.cash });
    if (a.modal !== 'manage') { await settle(); if ((await snap()).modal !== 'manage') { await openDaicho(); await sleep(800); } }
  }
  for (let i = 0; i < 3; i++) {
    const sn = page.locator(`${rail} .dc-al-snooze`).filter({ visible: true }).first();
    if (!(await sn.count())) break;
    await sn.click({ timeout: 1000 }).catch(() => {}); await sleep(300); res.snoozed++;
  }
  res.other = await clickAll('daicho-rail', { scope: rail, maxClicks: 15 }); // "more", restaurant links, anything new
  res.after = await ev(() => window.__core.E.alerts(window.game.s).map((a) => a.id));
  if (res.fixes && res.after.includes('unstaffed')) find('medium', '"unstaffed" alert still there after clicking every one-click fix', { after: res.after });
  await shot('daicho-alerts');
  if (!res.fixes && res.before.length) find('medium', 'alerts exist but the rail shows no one-click fix buttons', { alerts: res.before });
  if (await ev(() => window.__core.E.alerts(window.game.s).some((a) => /stock|dirty|clean/i.test(a.id + a.kind)))) find('medium', 'Daichō still raises a cut alert kind (stock/clean)');
  return res;
});

await section('Daichō ledger: sort, health lights, open a restaurant sheet', async () => {
  await tycoonSetup();
  if (!(await openDaicho())) return 'no dashboard';
  const L = '.open .dc-a-ledger';
  const res = { sorts: 0, sheet: null };
  for (const h of await page.locator(`${L} [data-sort]`).filter({ visible: true }).all()) { await h.click({ timeout: 800 }).catch(() => {}); await sleep(120); await h.click({ timeout: 800 }).catch(() => {}); res.sorts++; }
  // every restaurant has a health light, and an unstaffed one is red
  res.kpi = await ev(() => { const k = window.__core.E.restaurantKPIs(window.game.s); return { n: k.length, bad: k.filter((x) => x.health === 'bad').length, broken: k.filter((x) => !['good', 'warn', 'bad'].includes(x.health) || typeof x.managed !== 'boolean').map((x) => x.id), redUnstaffed: k.every((x) => x.automated || x.health === 'bad') }; });
  if (res.kpi.broken.length) find('high', 'restaurant KPIs without a valid health/managed field', { ids: res.kpi.broken });
  if (!res.kpi.redUnstaffed) find('medium', 'an unstaffed restaurant is not health "bad"');
  res.rows = await ev((l) => document.querySelectorAll(`${l} tr[data-id]`).length, L);
  if (!res.rows) find('medium', 'Daichō ledger shows no restaurant rows');
  await shot('daicho-ledger');
  // open a restaurant from its name
  const name = page.locator(`${L} [data-open]`).filter({ visible: true }).first();
  if (await name.count()) {
    await name.click({ timeout: 1000 }).catch(() => {}); await sleep(600);
    res.sheet = (await snap()).modal;
    if (res.sheet !== 'sheet') find('medium', `clicking a ledger restaurant name opened "${res.sheet}" (expected the restaurant sheet)`);
  } else find('medium', 'ledger has no clickable restaurant names');
  return res;
});

await section('restaurant sheet: every tab, price slider, menu, staff, books, format, upgrades', async () => {
  await tycoonSetup();
  await recover();
  // owner-first entry: from the Daichō ledger name; fall back to the HUD alert pill / UI hook
  if (await openDaicho()) { await page.locator('.open .dc-a-ledger [data-open]').filter({ visible: true }).first().click({ timeout: 1000 }).catch(() => {}); await sleep(600); }
  if ((await snap()).modal !== 'sheet') { await recover(); await ev(() => window.game.ui.openRestaurant(Object.keys(window.game.s.restaurants)[1] ?? Object.keys(window.game.s.restaurants)[0])); await sleep(500); }
  if ((await snap()).modal !== 'sheet') return 'sheet did not open';
  const tabs = await ev(() => [...document.querySelectorAll('.open .sheet-tabs [data-tab]')].map((e) => e.dataset.tab));
  if (tabs.join() !== 'overview,staff,menu,books,format,look') find('medium', `restaurant sheet tabs are [${tabs}] (expected overview, staff, menu, books, format, look)`);
  const res = {};
  for (const t of tabs) {
    await page.locator(`.open .sheet-tabs [data-tab="${t}"]`).first().click({ timeout: 1000 }).catch(() => {}); await sleep(300);
    for (const r of await page.locator('.open .sheet input[type=range]').filter({ visible: true }).all()) {
      const b = await r.boundingBox(); if (!b) continue;
      const before = await ev(() => Object.values(window.game.s.restaurants).map((x) => x.priceMult).join());
      await page.mouse.click(b.x + 4, b.y + b.height / 2); await page.mouse.click(b.x + b.width - 4, b.y + b.height / 2); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      if (t === 'menu' && before === (await ev(() => Object.values(window.game.s.restaurants).map((x) => x.priceMult).join()))) find('medium', 'sheet price slider clicks did not change the price');
    }
    for (const sel of await page.locator('.open .sheet select').filter({ visible: true }).all()) { const v = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value)); if (v[1]) await sel.selectOption(v[1]).catch(() => {}); }
    res[t] = await clickAll(`sheet-${t}`, { scope: '.open .sheet .sheet-body', maxClicks: 30, skip: /ride the metro|travel|delete|import|quit/i });
    if ((await snap()).modal !== 'sheet') { await settle(); if ((await snap()).modal !== 'sheet') break; }
    await shot(`sheet-${t}`);
  }
  // prev / next restaurant arrows
  const nav = page.locator('.open .sheet [data-nav]').first();
  if (await nav.count()) { const n0 = await ev(() => document.querySelector('.open .sheet-head')?.textContent); await nav.click({ timeout: 800 }).catch(() => {}); await sleep(300); if (n0 === (await ev(() => document.querySelector('.open .sheet-head')?.textContent))) find('low', 'sheet ‹ › arrows did not switch restaurant'); }
  await page.keyboard.press('Escape'); await sleep(300);
  if ((await snap()).modal === 'sheet') find('medium', 'Esc does not close the restaurant sheet');
  await recover(); // the Daichō it was opened from stays underneath
  await expectPlayable('restaurant sheet');
  return res;
});

await section('managed restaurant: a manager (hired by real click) auto-hires the missing chef', async () => {
  await tycoonSetup();
  // a fresh lot with no crew, and no ops_center (which would manage every restaurant)
  const id = await ev(() => {
    const { A, D } = window.__core, s = window.game.s;
    s.research = (s.research ?? []).filter((r) => r !== 'ops_center');
    const lot = Object.values(D.PROPERTIES).filter((p) => !s.restaurants[p.id] && s.districts.includes(p.district) && p.kind !== 'stand' && !A.conceptAllowed(s, p.id, 'bar')).sort((a, b) => a.price - b.price)[0];
    if (!lot || A.buyProperty(s, lot.id, 'bar')) return null;
    window.game.refreshWorld?.();
    return lot.id;
  });
  if (!id) return 'no lot to buy';
  const kpi = () => ev((id) => { const k = window.__core.E.restaurantKPIs(window.game.s).find((x) => x.id === id); const st = window.game.s.staff.filter((e) => e.restaurant === id).map((e) => e.role); return { managed: k?.managed, health: k?.health, staff: st }; }, id);
  const res = { id, before: await kpi() };
  if (res.before.managed) find('medium', 'restaurant without a manager or ops_center reports managed', res.before);
  await recover();
  await ev((id) => window.game.ui.openRestaurant(id, 'staff'), id); await sleep(400);
  if ((await snap()).modal !== 'sheet') return { ...res, note: 'sheet did not open' };
  if ((await sheetTabOn()) !== 'staff') await page.locator('.open .sheet-tabs [data-tab="staff"]').first().click({ timeout: 1000 }).catch(() => {});
  const mgr = page.locator('.open [data-act="hirebest"][data-arg="manager"]').filter({ visible: true }).first();
  if (!(await mgr.count())) { find('medium', 'Staff tab has no "Hire best manager" button', res.before); await recover(); return res; }
  await mgr.click(); await sleep(400);
  res.hired = await kpi();
  if (!res.hired.staff.includes('manager')) { find('high', 'clicking "Hire best manager" did not hire one', res.hired); await recover(); return res; }
  if (!res.hired.managed) find('medium', 'restaurant with a manager does not report managed', res.hired);
  await recover();
  // managed restaurants act once per in-game hour (25 s at 1×): run 4× with the real key
  await page.keyboard.press('3');
  const ok = await page.waitForFunction((id) => window.game.s.staff.some((e) => e.restaurant === id && e.role === 'chef'), id, { timeout: 25_000, polling: 250 }).then(() => true, () => false);
  await page.keyboard.press('1');
  res.after = await kpi();
  if (!ok) find('high', 'a managed restaurant with no chef did not auto-hire one within ~2 in-game hours', { ...res.after, log: await ev((id) => window.game.s.restaurants[id].log, id) });
  return res;
});

await section('Daichō map: regions, overlays, area stamps, lots, locked areas, Esc climbs City → Empire', async () => {
  await tycoonSetup();
  if (!(await openDaicho())) return 'no dashboard';
  const M = '.open .dc-a-map';
  const res = { regions: 0, overlays: 0, areas: 0, lots: 0, locked: 0 };
  for (const b of await page.locator(`${M} [data-act="overlay"]`).filter({ visible: true }).all()) { await b.click({ timeout: 800 }).catch(() => {}); await sleep(150); res.overlays++; }
  await page.locator(`${M} summary`).first().click({ timeout: 800 }).catch(() => {});
  const regions = await ev((m) => [...document.querySelectorAll(`${m} [data-act="region"]`)].map((e) => e.dataset.arg), M);
  for (const rg of regions) {
    await page.locator(`${M} [data-act="region"][data-arg="${rg}"]`).first().click({ timeout: 800 }).catch(() => {}); await sleep(300); res.regions++;
    // a locked area: popup with an unlock button (we are rich) or a close
    if (res.locked < 2 && await mouseClick(`${M} [data-act="locked"]`)) {
      await sleep(300); res.locked++;
      const un = page.locator(`${M} [data-act="unlock"]:not([disabled])`).first();
      if (await un.count()) { const a0 = (await snap()).areas; await un.click({ timeout: 800 }).catch(() => {}); await sleep(300); if ((await snap()).areas <= a0) find('medium', 'map "Unlock" button with enough cash did not unlock the area'); }
      else await mouseClick(`${M} [data-act="close"]`);
    }
  }
  if (regions[0]) { await page.locator(`${M} [data-act="region"][data-arg="${regions[0]}"]`).first().click({ timeout: 800 }).catch(() => {}); await sleep(300); }
  const areas = await ev((m) => [...document.querySelectorAll(`${m} [data-act="area"]`)].map((e) => e.dataset.arg), M);
  if (!areas.length) find('medium', 'Daichō map shows no clickable area for owned restaurants in the first region');
  for (const a of areas.slice(0, 4)) {
    if (!(await mouseClick(`${M} [data-act="area"][data-arg="${a}"]`))) continue;
    await sleep(400); res.areas++;
    await shot(`daicho-area-${a}`);
    // a lot for sale opens the concept picker
    if (await mouseClick(`${M} .dc-lot[data-act="buy"]`)) {
      await sleep(500); res.lots++;
      const m = (await snap()).modal;
      if (m !== 'prop') find('medium', `clicking a for-sale lot on the map opened "${m}" (expected the concept picker)`);
      else { await page.keyboard.press('Escape'); await sleep(300); }
    }
    // Esc in city view must climb back to the empire, not close Manage (focus inside the dashboard)
    await page.locator(`${M} button`).filter({ visible: true }).first().focus().catch(() => {});
    const focus = await ev(() => { const a = document.activeElement; return { inDaicho: !!a?.closest('.dc-root'), el: `${a?.tagName}.${a?.className}`.slice(0, 60) }; });
    await page.keyboard.press('Escape'); await sleep(300);
    const s = await snap();
    if (s.modal !== 'manage') { find('medium', 'Esc in a Daichō city view closed Manage instead of climbing to the empire view', { focus }); if (!(await openDaicho())) break; }
    else if (await ev((m) => !!document.querySelector(`${m} [data-act="up"]`), M)) find('low', 'Esc in a Daichō city view did not climb back to the empire view');
  }
  res.other = await clickAll('daicho-map', { scope: M, maxClicks: 25, skip: /unlock|travel|delete/i, also: (b) => !/^(buy|area|locked)$/.test(b.act ?? '') });
  return res;
});

await section('concept picker: buy one lot per affordable concept by real clicks', async () => {
  await tycoonSetup({ cash: 5e8, pieces: 2e6 });
  await ev(() => { window.game.s.flags.chapter2 = true; });
  const res = {};
  for (const c0 of await ev(() => window.__core.D.CONCEPT_IDS)) {
    const p = (await conceptPlan()).find((x) => x.concept === c0); // re-plan: the previous purchase took a lot
    if (!p.lot) { res[p.concept] = `skip (${p.why})`; continue; }
    await recover();
    const via = await openLot(p.lot, p.area);
    if (!via) { res[p.concept] = 'picker did not open'; find('medium', `could not open the for-sale window for ${p.lot}`); continue; }
    if (via === 'hook') find('low', `lot ${p.lot} was not reachable by clicking the Daichō map (opened through the UI hook)`);
    const card = page.locator(`.open [data-act="pickc"][data-arg="${p.concept}"]`).first();
    if (!(await card.count())) { res[p.concept] = 'no concept card'; find('medium', `concept picker has no "${p.concept}" card`); continue; }
    await card.click({ timeout: 1000 }); await sleep(250);
    if ((await card.getAttribute('aria-pressed').catch(() => null)) === 'false') find('low', `concept card "${p.concept}" not marked selected after clicking`);
    await ev(() => window.game.setPaused?.(true)); // freeze income/costs so the charge is exact
    const b = await snap();
    await page.locator('.open.prop [data-act="buy"], .open [data-act="buy"]:not([data-arg])').first().click({ timeout: 1500 }).catch(() => {});
    await sleep(700);
    const a = await snap();
    await ev(() => window.game.setPaused?.(false));
    const got = await ev((id) => window.game.s.restaurants[id]?.concept ?? null, p.lot);
    res[p.concept] = got === p.concept ? `${p.lot} ¥${Math.round(b.cash - a.cash)}` : `not bought (${got})`;
    if (got !== p.concept) find('high', `buying ${p.lot} as "${p.concept}" through the picker failed`, { cash: b.cash, total: p.total });
    else if (Math.abs((b.cash - a.cash) - p.total) > 1) find('medium', `${p.concept}: charged ¥${Math.round(b.cash - a.cash)} but the picker quoted ¥${p.total}`);
    await shot(`concept-${p.concept}`);
  }
  // locked concepts: buy must be refused (fresh pieces count would gate them — check the disabled state on one lot)
  return res;
});

await section('time speed: HUD + Daichō buttons and keys 1/2/3 (sim rate), pause button', async () => {
  await recover();
  // sim rate = game seconds per real second, measured with story beats off-screen
  const rate = async () => { await settle(); const a = await snap(); await sleep(1500); const b = await snap(); return b.stack.length ? null : (b.clock - a.clock) / 1.5; };
  const res = {};
  // keys 1/2/3 in free play
  for (const [k, want] of [['2', 2], ['3', 4], ['1', 1]]) {
    await beatSafe(async () => { await page.keyboard.press(k); await sleep(200); });
    const s = await snap();
    if (s.speed !== want) find('medium', `key ${k} did not set speed ${want}× (got ${s.speed}×)`);
    const r = await rate(); res[`key${k}`] = r === null ? null : +r.toFixed(2);
  }
  if (res.key3 && res.key1 && res.key3 / res.key1 < 3) find('medium', `4× speed only runs the sim ${(res.key3 / res.key1).toFixed(1)}× as fast as 1×`, res);
  // HUD speed buttons (pause / 1 / 2 / 4)
  for (const n of ['2', '4', '0', '1']) {
    await settle(); await recover();
    const under = await ev((n) => { const b = document.querySelector(`#h-speed [data-arg="${n}"]`)?.getBoundingClientRect(); if (!b) return null; const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e?.closest('#h-speed') ? null : `${e?.tagName}.${e?.className}`.slice(0, 60); }, n);
    let ok = false;
    await beatSafe(async () => { ok = await mouseClick(`#h-speed [data-arg="${n}"]`); await sleep(200); }, async () => { const x = await snap(); return n === '0' ? x.paused : !x.paused && x.speed === Number(n); });
    const s = await snap();
    if (!ok) { res.hud = 'no HUD speed buttons'; break; }
    if (n === '0' ? !s.paused : s.paused || s.speed !== Number(n)) find('medium', `HUD speed button ${n} → speed ${s.speed}, paused ${s.paused}`, { coveredBy: under, stack: s.stack });
    if (n === '0') { const c0 = s.clock; await sleep(800); if ((await snap()).clock !== c0) find('medium', 'HUD pause button does not stop the clock'); }
  }
  if (!(await snap()).paused) await expectPlayable('speed buttons');
  // Daichō strip speed buttons
  if (await openDaicho()) {
    for (const n of ['4', '2', '0', '1']) {
      await page.locator(`.open .dc-a-strip [data-n="${n}"]`).first().click({ timeout: 800 }).catch(() => {}); await sleep(200);
      const s = await snap();
      if (n === '0' ? !s.paused : s.paused || s.speed !== Number(n)) find('medium', `Daichō speed button ${n} → speed ${s.speed}, paused ${s.paused}`);
      if (n !== '0' && (await page.locator(`.open .dc-a-strip [data-n="${n}"]`).first().getAttribute('aria-pressed')) !== 'true') find('low', `Daichō speed ${n}× button not marked pressed`);
    }
  }
  await recover();
  await expectPlayable('speed controls');
  return res;
});

await section('metro travel to every district with owned lots, walk to each lot', async () => {
  await tycoonSetup();
  const targets = await ev(() => { const { D } = window.__core, s = window.game.s; return [...new Set(Object.keys(s.restaurants).map((id) => D.PROPERTIES[id]?.district).filter((a) => a && D.AREAS[a].walkable))]; });
  const res = {};
  for (const d of targets) {
    await recover();
    if ((await snap()).district !== d) {
      await page.keyboard.press('m'); await sleep(400);
      if ((await snap()).modal !== 'map') { res[d] = 'M did not open the map'; continue; }
      await mouseClick(`.open [data-act="pick"][data-arg="${d}"]`); await sleep(250);
      const go = page.getByRole('button', { name: /travel to/i }).first();
      if (!(await go.isVisible().catch(() => false))) { res[d] = 'no travel button'; find('medium', `map offers no "Travel to" for ${d} although it has an owned lot`); await recover(); continue; }
      await go.click();
      await page.waitForFunction((d) => window.game.district.id === d && !document.querySelector('.fade-overlay'), d, { timeout: 8000 }).catch(() => {});
      await sleep(400);
      if ((await snap()).district !== d) { res[d] = 'travel failed'; find('high', `metro travel to ${d} did not arrive`); continue; }
    }
    await settle();
    // walk to each owned site in this district (last meters with real keys)
    const sites = await ev(() => window.game.district.sites.filter((x) => window.game.s.restaurants[x.id]).map((x) => ({ id: x.id, x: x.counter.x, z: x.counter.z, yaw: x.counter.yaw })));
    const reached = [];
    for (const st of sites) {
      await teleport(st.x + Math.sin(st.yaw) * 4, st.z + Math.cos(st.yaw) * 4, st.yaw);
      const dleft = await walkTo(st.x, st.z, { stop: 1.2, timeout: 5000 });
      reached.push(`${st.id}:${dleft.toFixed(1)}m`);
    }
    if (!sites.length) find('medium', `${d} has owned lots in state but no owned site in the 3D district`);
    res[d] = reached.join(' ') || 'no sites';
    await shot(`travel-${d}`);
    await expectPlayable(`travel to ${d}`);
  }
  return res;
});

await section('broke pass: every buy / hire / unlock / fix refused cleanly', async () => {
  await tycoonSetup();
  await ev(() => { window.game.s.cash = 0; });
  const res = {};
  if (await openDaicho()) {
    await sleep(800);
    res.rail = await clickAll('broke-rail', { scope: '.open .dc-a-rail', broke: true, maxClicks: 20 });
    res.map = await clickAll('broke-map', { scope: '.open .dc-a-map', broke: true, maxClicks: 25 });
    res.ledger = await clickAll('broke-ledger', { scope: '.open .dc-a-ledger', broke: true, maxClicks: 20, also: (b) => !/^$/.test(b.text) });
    // the classic Manage tabs (staff pool, research, marketing, world…)
    for (const t of ['staff', 'research', 'marketing', 'empire', 'finances']) {
      if ((await snap()).modal !== 'manage') await openDaicho();
      if (!(await page.locator(`.open [data-tab="${t}"]`).first().click({ timeout: 800 }).then(() => true, () => false))) continue;
      await sleep(300);
      res[t] = await clickAll(`broke-${t}`, { broke: true, maxClicks: 30, skip: /travel|delete|import|quit/i });
    }
  }
  await recover();
  // a restaurant sheet: hire best / train / upgrades / format convert
  await ev(() => window.game.ui.openRestaurant(Object.keys(window.game.s.restaurants)[0])); await sleep(400);
  for (const t of ['staff', 'format', 'look']) {
    if (!(await page.locator(`.open .sheet-tabs [data-tab="${t}"]`).first().click({ timeout: 800 }).then(() => true, () => false))) continue;
    await sleep(250);
    res[`sheet-${t}`] = await clickAll(`broke-sheet-${t}`, { scope: '.open .sheet .sheet-body', broke: true, maxClicks: 25, skip: /ride the metro|travel/i });
  }
  await recover();
  // the concept picker on an unowned lot: every concept + Sign the lease
  const lot = await ev(() => { const { D } = window.__core, s = window.game.s; return Object.values(D.PROPERTIES).find((p) => !s.restaurants[p.id] && s.districts.includes(p.district) && p.kind !== 'stand')?.id; });
  if (lot) {
    await ev((id) => window.game.ui.openProperty(id), lot); await sleep(400);
    for (const c of await ev(() => [...document.querySelectorAll('.open [data-act="pickc"]')].map((e) => e.dataset.arg))) {
      await page.locator(`.open [data-act="pickc"][data-arg="${c}"]`).first().click({ timeout: 800 }).catch(() => {});
      const b = await snap();
      const buy = page.locator('.open [data-act="buy"]:not([data-arg])').first();
      const dis = await buy.isDisabled().catch(() => true);
      await buy.click({ timeout: 500, force: true }).catch(() => {}); await sleep(250);
      const a = await snap();
      if (a.rests > b.rests || a.cash < 0) find('high', `concept picker sold ${lot} as ${c} with ¥0`);
      if (!dis && !(await ev(() => /need|locked|¥/i.test(document.querySelector('.open [data-act="buy"]:not([data-arg])')?.textContent ?? '')))) find('low', `broke: "${c}" buy button is enabled and gives no reason`);
    }
    res.picker = 'checked';
    await recover();
  }
  const s = await snap();
  if (s.cash < 0) find('high', `broke pass ended with negative cash ${s.cash}`);
  await expectPlayable('broke pass');
  await ev(() => { window.game.s.cash = 5e7; });
  return res;
});

await section('pause menu: every view, settings, export, bad import, save', async () => {
  await recover();
  await page.keyboard.press('Escape'); await sleep(300);
  const s = await snap();
  if (!s.paused && s.modal !== 'pause') { find('medium', 'Esc did not open the pause menu'); return; }
  const views = await ev(() => [...document.querySelectorAll('.open [data-act=v]')].map((e) => e.dataset.arg).filter((v) => v !== 'main'));
  for (const v of views) {
    await page.locator(`.open [data-act=v][data-arg="${v}"]`).first().click().catch(() => {});
    await sleep(250);
    if (v === 'settings') {
      for (const r of await page.locator('.open input[type=range]').filter({ visible: true }).all()) { const b = await r.boundingBox(); if (b) await page.mouse.click(b.x + b.width * 0.7, b.y + b.height / 2); }
      for (const c of await page.locator('.open input[type=checkbox]').filter({ visible: true }).all()) { await c.click(); await c.click(); }
      const q = page.locator('.open select').first();
      if (await q.isVisible().catch(() => false)) { await q.selectOption('low'); await sleep(300); await q.selectOption('high'); }
    }
    if (v === 'export') { const code = await page.locator('.open textarea').first().inputValue().catch(() => ''); if (code.length < 20) find('medium', 'export save code is empty'); }
    if (v === 'import') {
      await page.locator('.open textarea').first().fill('not a real save code');
      const before = page.url();
      await page.getByRole('button', { name: /import/i }).first().click();
      await sleep(600);
      if (!(await ev(() => !!window.game?.started))) find('critical', 'importing an invalid save code reset/reloaded the game');
      if (page.url() !== before) find('high', 'invalid import navigated away');
    }
    await shot(`pause-${v}`);
    const back = page.locator('.open [data-act=v][data-arg=main]').first();
    if (await back.isVisible().catch(() => false)) await back.click();
    else if (!(await snap()).paused) { await page.keyboard.press('Escape'); await sleep(250); }
    await sleep(200);
  }
  const save = page.getByRole('button', { name: /save now/i }).first();
  if (await save.isVisible().catch(() => false)) await save.click();
  await sleep(200);
  await page.keyboard.press('Escape'); await sleep(300);
  const s2 = await snap();
  if (s2.paused || s2.modal) find('medium', 'Esc does not close the pause menu', { stack: s2.stack });
  await recover();
  await expectPlayable('pause menu');
  return views;
});

await section('resize mid-game (walking)', async () => {
  const sizes = [[800, 600], [1600, 900], [480, 820], [1280, 760]];
  const res = [];
  await page.keyboard.down('w');
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(400);
    const r = await ev(() => ({ cw: document.querySelector('canvas').clientWidth, ch: document.querySelector('canvas').clientHeight, iw: innerWidth, ih: innerHeight, aspect: window.game.camera.aspect }));
    res.push(r);
    if (Math.abs(r.cw - r.iw) > 2 || Math.abs(r.ch - r.ih) > 2) find('medium', 'canvas does not follow the window size', r);
    if (Math.abs(r.aspect - r.iw / r.ih) > 0.01) find('medium', 'camera aspect not updated on resize', r);
    await shot(`resize-${w}x${h}`);
  }
  await page.keyboard.up('w');
  // open Tab at a small size: the manage window must stay usable
  await page.setViewportSize({ width: 800, height: 600 });
  await page.keyboard.press('Tab'); await sleep(400);
  const fits = await ev(() => { const e = window.__pt.topEl(); const r = e?.querySelector('.panel')?.getBoundingClientRect() ?? e?.getBoundingClientRect(); return r ? { w: r.width, h: r.height, top: r.top, left: r.left } : null; });
  if (fits && (fits.top < -2 || fits.left < -2 || fits.w > 802)) find('low', 'management window overflows an 800x600 window', fits);
  await shot('resize-manage-800');
  await recover();
  await page.setViewportSize({ width: 1280, height: 760 });
  return res.map((r) => `${r.iw}x${r.ih}`);
});

await section('save & main menu → continue → play', async () => {
  await recover();
  const before = await snap();
  await page.keyboard.press('Escape'); await sleep(300);
  await toTitle();
  // keys on the title must be ignored
  await hold(['w', 'e', 'Tab'], 200);
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.waitForFunction(() => window.game.started, null, { timeout: 8000 });
  await sleep(500);
  await recover();
  const after = await snap();
  if (after.district !== before.district) find('medium', 'continue put the player in a different district', { before: before.district, after: after.district });
  if (Math.hypot(after.x - before.x, after.z - before.z) > 2) find('low', 'continue did not restore the player position', { before: [before.x, before.z], after: [after.x, after.z] });
  await expectPlayable('continue');
  await hold(['w'], 400);
  return { district: after.district };
});


// =================================================================== part A: a new player's first minutes (¥7k, tutorial)
await section('owner-first flow: new game from the title, follow the objective hints with real input', async () => {
  // fresh game through the real menus: Esc → Save & main menu → New Game → company/owner name → intro dialog
  await recover();
  await page.keyboard.press('Escape'); await sleep(300);
  await toTitle();
  await page.getByRole('button', { name: /new game/i }).first().click(); await sleep(300);
  const yes = page.getByRole('button', { name: /yes, new game/i });
  if (await yes.isVisible().catch(() => false)) await yes.click();
  await page.locator('#nc-co').fill('First Hour Sushi');
  await page.locator('#nc-name').fill('New Owner');
  await page.getByRole('button', { name: /open the stand/i }).first().click();
  await page.waitForFunction(() => window.game.started, null, { timeout: 10_000 });
  for (let i = 0; i < 12 && (await snap()).modal === 'dialog'; i++) { await page.keyboard.press('e'); await sleep(150); }
  await settle();
  await loadCore();
  const T0 = Date.now(), C0 = (await snap()).clock;
  const startCash = (await snap()).cash;
  if (Math.round(startCash) !== 7_000) find('low', `new game starts with ¥${Math.round(startCash)} (expected ¥7,000)`);
  const obj = () => ev(() => document.querySelector('#h-obj')?.textContent?.trim() ?? '');
  const tl = { hints: [], milestones: {} };
  const mark = async (k) => { if (!tl.milestones[k]) { const s = await snap(); tl.milestones[k] = { realS: Math.round((Date.now() - T0) / 1000), gameMin: Math.round((s.clock - C0) / 60), cash: Math.round(s.cash) }; console.log(`  · ${k} at ${tl.milestones[k].realS}s real / ${tl.milestones[k].gameMin} game-min`); } };
  const MILESTONES = ['hired a chef', 'first sale', 'hired a server', 'first upgrade', 'second restaurant'];
  const speed = async (n) => { if (!(await mouseClick(`#h-speed [data-arg="${n}"]`))) await page.keyboard.press(n === 4 ? '3' : String(n)); };
  const stand = () => ev(() => window.game.district.sites.find((x) => x.id === 'asakusa_stand')?.counter ?? null);
  // walk there; if the straight line is blocked, teleport to a free spot ~2.6 m away and walk the last meters
  const go = async (x, z, stop = 1.0) => {
    const p = await snap();
    if (Math.hypot(p.x - x, p.z - z) > 14) await teleport(x + (p.x - x) / Math.hypot(p.x - x, p.z - z) * 6, z + (p.z - z) / Math.hypot(p.x - x, p.z - z) * 6, 0);
    let d = await walkTo(x, z, { stop, timeout: 5000, sprint: true });
    for (let k = 0; k < 8 && d > stop + 0.3; k++) {
      const a = (k / 8) * Math.PI * 2, ox = x + Math.sin(a) * 2.6, oz = z + Math.cos(a) * 2.6;
      if (!(await freeAt(ox, oz))) continue;
      await teleport(ox, oz, 0); await sleep(100);
      d = await walkTo(x, z, { stop, timeout: 3000 });
    }
    return d;
  };
  /** Walk to the stand and press E: the sheet should open on `tab` (the one the hint names). Falls back to Tab. */
  const standSheet = async (tab) => {
    await recover();
    const c = await stand();
    if (c) {
      await go(c.x, c.z, 1.2);
      await page.waitForFunction(() => /manage/i.test(document.querySelector('#h-prompt')?.textContent ?? ''), null, { timeout: 2000 }).catch(() => {});
      await page.keyboard.press('e'); await sleep(500);
    }
    if ((await snap()).modal !== 'sheet') {
      if (!tl.eFallback) { tl.eFallback = true; find('medium', 'owner-first: E at the stand did not open its sheet (used Tab)'); }
      await recover(); await page.keyboard.press('Tab'); await sleep(500);
      if ((await snap()).modal === 'manage') { await page.locator('.open .dc-a-ledger [data-open]').filter({ visible: true }).first().click({ timeout: 1000 }).catch(() => {}); await sleep(500); }
      if ((await snap()).modal !== 'sheet') return false;
    }
    const on = await sheetTabOn();
    if (on !== tab) {
      if (!tl.wrongTab?.[tab]) { tl.wrongTab = { ...tl.wrongTab, [tab]: on }; find('medium', `owner-first: the hint names the ${tab} tab but E at the stand opened "${on}"`); }
      await page.locator(`.open .sheet-tabs [data-tab="${tab}"]`).first().click({ timeout: 1000 }).catch(() => {}); await sleep(300);
    }
    return true;
  };
  const hireRole = async (role) => {
    if (!(await standSheet('staff'))) { find('medium', `hint says hire a ${role}, but no restaurant sheet opened`); return false; }
    const b = page.locator(`.open [data-act="hirebest"][data-arg="${role}"]`).filter({ visible: true }).first();
    if (!(await b.count())) { find('medium', `restaurant sheet Staff tab has no "Hire best" for ${role}`); await recover(); return false; }
    const n0 = (await snap()).staffN; const label = ((await b.textContent()) ?? '').trim();
    await b.click({ timeout: 1000 }).catch(() => {}); await sleep(400);
    const ok = (await snap()).staffN > n0;
    if (!ok) { const why = await ev(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).slice(-1)[0] ?? ''); tl.hireFails = tl.hireFails ?? {}; tl.hireFails[role] = `${label} → ${why}`.slice(0, 120); }
    await recover(); return ok;
  };
  let lastHint = '', hintSince = Date.now(), stalls = 0;
  const budgetMs = 9 * 60_000;
  while (Date.now() - T0 < budgetMs) {
    await settle();
    const h = await obj(), s = await snap();
    if (h !== lastHint) { tl.hints.push({ t: Math.round((Date.now() - T0) / 1000), gameMin: Math.round((s.clock - C0) / 60), tutorial: s.tutorial, hint: h }); lastHint = h; hintSince = Date.now(); }
    else if (Date.now() - hintSince > 150_000 && !/^Next:/.test(h)) { stalls++; if (stalls === 1) find('medium', `objective hint stuck for 150 s of real time (4×) with no progress: "${h}"`, { cash: Math.round(s.cash), staff: s.staffN, rests: s.rests }); hintSince = Date.now(); }
    const roles = await ev(() => window.game.s.staff.filter((e) => e.restaurant).map((e) => e.role));
    if (roles.includes('chef')) await mark('hired a chef');
    if (await ev(() => window.game.s.lifetime.customers > 0)) await mark('first sale');
    if (roles.includes('server') || roles.includes('manager')) await mark('hired a server');
    if (s.upgN > 0) await mark('first upgrade');
    if (s.rests >= 2) await mark('second restaurant');
    if (s.tutorial === 99 && MILESTONES.every((k) => tl.milestones[k])) break; // tutorial done
    if (/arrow|walk to/i.test(h) && s.tutorial === 0) { const c = await stand(); if (c) await go(c.x, c.z, 1.0); await sleep(500); }
    else if (/hire a chef/i.test(h)) { if (!(await hireRole('chef'))) { await speed(4); await sleep(4000); } }
    else if (/first guest/i.test(h)) { await speed(4); await sleep(3000); }
    else if (/hire a server/i.test(h)) { if (!(await hireRole('server'))) { tl.waitingForServer = true; await speed(4); await sleep(5000); } }
    else if (/upgrade/i.test(h)) {
      if (await standSheet('look')) {
        const u = page.locator('.open [data-act="upg"]').filter({ visible: true }).first();
        const n0 = (await snap()).upgN;
        if (await u.count()) { await u.click({ timeout: 1000 }).catch(() => {}); await sleep(300); }
        if ((await snap()).upgN === n0) { tl.waitingForUpgrade = true; await recover(); await speed(4); await sleep(4000); }
        await recover();
      }
    } else if (/second restaurant|for sale sign/i.test(h)) {
      const lot = await ev(() => { const { A, D } = window.__core, s = window.game.s; return Object.values(D.PROPERTIES).filter((p) => p.district === window.game.district.id && !s.restaurants[p.id]).map((p) => ({ id: p.id, total: Math.min(...D.CONCEPT_IDS.filter((c) => !A.conceptAllowed(s, p.id, c)).map((c) => p.price + A.fitoutCost(p.id, c))) })).sort((a, b) => a.total - b.total)[0]; });
      if (!lot || s.cash < lot.total) { tl.waitingFor2nd = lot?.total; await speed(4); await sleep(5000); continue; }
      // walk to its For Sale sign and press E
      const lotName = await ev((id) => window.__core.D.PROPERTIES[id].name, lot.id);
      const signs = (await ev(() => window.__pt.interactables())).filter((it) => it.kind === 'sign');
      const sign = signs.find((it) => it.prompt?.includes(lotName)) ?? signs[0];
      if (sign) { await go(sign.x, sign.z, 0.8); await page.keyboard.press('e'); await sleep(500); }
      if ((await snap()).modal !== 'prop') { await recover(); await ev((id) => window.game.ui.openProperty(id), lot.id); await sleep(400); find('low', 'could not open the lot window by walking to a For Sale sign (used the UI hook)'); }
      const cards = await ev(() => [...document.querySelectorAll('.open [data-act="pickc"]:not(.locked)')].map((e) => e.dataset.arg));
      for (const c of cards) {
        await page.locator(`.open [data-act="pickc"][data-arg="${c}"]`).first().click({ timeout: 800 }).catch(() => {}); await sleep(150);
        const buy = page.locator('.open [data-act="buy"]:not([data-arg])').first();
        if (!(await buy.isDisabled().catch(() => true)) && !/need/i.test((await buy.textContent()) ?? '')) { await buy.click({ timeout: 1000 }).catch(() => {}); await sleep(700); break; }
      }
      await recover();
    } else if (/no chef|ledger|attention/i.test(h)) { // a restaurant other than the stand: fix it from the Daichō rail
      if (await openDaicho()) {
        for (let i = 0; i < 4; i++) { const f = page.locator('.open .dc-a-rail .dc-al-fix').filter({ visible: true }).first(); if (!(await f.count())) break; await f.click({ timeout: 1000 }).catch(() => {}); await sleep(500); }
      }
      await recover(); await speed(4); await sleep(3000);
    } else if (/new market|expand/i.test(h)) {
      if (await openDaicho()) { if (await mouseClick('.open .dc-a-map [data-act="locked"]')) { await sleep(300); await page.locator('.open .dc-a-map [data-act="unlock"]:not([disabled])').first().click({ timeout: 800 }).catch(() => {}); } }
      await recover(); await sleep(2000);
    } else { await speed(4); await sleep(5000); }
  }
  await speed(1);
  const end = await snap();
  tl.end = { realS: Math.round((Date.now() - T0) / 1000), gameMin: Math.round((end.clock - C0) / 60), cash: Math.round(end.cash), staff: end.staffN, rests: end.rests, tutorial: end.tutorial, pieces: Math.round(await ev(() => window.game.s.lifetime.pieces)) };
  // milestones must come in tutorial order: chef → sale → server → upgrade → second lot
  const order = MILESTONES.filter((k) => tl.milestones[k]);
  for (let i = 1; i < order.length; i++) if (tl.milestones[order[i]].realS < tl.milestones[order[i - 1]].realS) find('low', `owner-first: "${order[i]}" came before "${order[i - 1]}"`);
  for (const k of MILESTONES) if (!tl.milestones[k]) find('info', `owner-first flow: "${k}" not reached within ${tl.end.realS}s real / ${tl.end.gameMin} game-min`);
  if (tl.milestones['first sale'] && tl.milestones['hired a chef'] && tl.milestones['first sale'].gameMin - tl.milestones['hired a chef'].gameMin > 60) find('low', 'first sale took over an in-game hour after hiring the chef', tl.milestones);
  if (tl.end.tutorial !== 99) find('medium', `tutorial not finished at the end of the owner-first flow (step ${tl.end.tutorial})`);
  await shot('owner-first-end');
  console.log('  hints:'); for (const x of tl.hints) console.log(`   ${String(x.t).padStart(4)}s ${String(x.gameMin).padStart(4)}gm  [${x.tutorial}] ${x.hint}`);
  return tl;
});

// ------------------------------------------------------------------ report
current = 'report';
await drainMonitor();
if (mon?.nan?.length) find('critical', 'cash became NaN/Infinity at runtime', { samples: mon.nan });
if (mon?.stuck?.length) find('high', 'input disabled for >2.5 s with no window open (soft-lock)', { samples: mon.stuck });
if (mon?.pen?.length) find('medium', `player overlapped colliders while grounded (${mon.pen.length} samples)`, { samples: mon.pen.slice(0, 8) });
if (mon?.cam?.length) find('medium', `camera inside a collider during play (${mon.cam.length} samples)`, { samples: mon.cam.slice(0, 8) });
const report = { url, when: new Date().toISOString(), sections, findings, clickFails, monitor: { frames: mon.frames, hitches: mon.hitch, minCash: mon.minCash }, logs };
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();

console.log('\n================ SUMMARY');
for (const s of sections) console.log(`${s.ok ? 'PASS ' : s.crash ? 'CRASH' : 'ERR  '} ${s.name}${s.crash ? ' — ' + s.crash : ''}`);
console.log(`\n${findings.length} finding(s):`);
for (const f of findings) console.log(` - [${f.severity}] (${f.section}) ${f.title}`);
const pe = logs.filter((l) => l.type === 'pageerror'), ce = logs.filter((l) => l.type === 'error'), cw = logs.filter((l) => l.type === 'warning');
console.log(`\npage errors: ${pe.length}, console errors: ${ce.length}, warnings: ${cw.length}`);
for (const l of [...pe, ...ce].slice(0, 15)) console.log(` - [${l.type}] (${l.section}) ${l.text.split('\n')[0]}`);
console.log(`click retries exhausted (element re-rendered/covered): ${clickFails.length}`);
console.log(`\nmonitor: ${mon.frames} frames, ${mon.hitch} hitches >120ms, min cash ${mon.minCash}`);
console.log(`report: ${join(out, 'report.json')}`);
process.exit(sections.some((s) => !s.ok) ? 1 : 0);
