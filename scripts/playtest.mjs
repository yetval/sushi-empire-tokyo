// Real-input playtest / bug hunt. Drives the game with the keyboard and mouse (WASD, Shift, Space, E, Tab, M, Esc,
// mouse drag/wheel, real button clicks) against an ALREADY RUNNING dev server (does NOT start one).
// State is only touched to set up scenarios (teleport near a target, give cash) — the last meters and every action use real input.
// Usage: node scripts/playtest.mjs [url] [outDir]
//   url    default http://localhost:5173/
//   outDir default $PLAYTEST_OUT or <os tmpdir>/sushi-playtest  (screenshots + report.json)
// Exit code 1 if any section crashed or a page error was recorded.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? process.env.PLAYTEST_OUT ?? join(tmpdir(), 'sushi-playtest');
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
const find = (severity, title, detail = {}) => { findings.push({ section: current, severity, title, ...detail }); console.log(`  [${severity}] ${title}`); };
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

async function section(name, fn, { fresh = true } = {}) {
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
        district: G.district.id, x: p.x, y: p.y, z: p.z, camYaw: G.cam.yaw, camDist: G.cam.dist, pen: pen(p), camInside: camInside(),
      };
    },
    /** Tag visible clickable controls inside the top modal (or a selector) with data-pt; return descriptors. */
    scan: (sel) => {
      const scope = sel ? document.querySelector(sel) : topEl();
      if (!scope) return [];
      document.querySelectorAll('[data-pt]').forEach((e) => e.removeAttribute('data-pt'));
      const els = [...scope.querySelectorAll('button, [data-act], [data-tab], [role=button], [role=tab], .ing-btn, .tbar')].filter((e) => vis(e) && !e.disabled);
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
        for (const s of d.sites) G.s.restaurants[s.id] ? list.push({ kind: 'counter', spot: s.counter, r: 1.4 }, { kind: 'prep', spot: s.prep, r: 1.3 }) : list.push({ kind: 'sign', spot: s.sign, r: 2 });
        if (d.supplier) list.push({ kind: 'supplier', spot: d.supplier, r: 2.2 });
        list.push({ kind: 'metro', spot: d.metro, r: 2.5 });
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
          if (!G.cam.focus && !G.photo?.isOpen?.() && camInside() && ++camN % 30 === 1 && mon.cam.length < 30) { const c = G.camera.position; mon.cam.push({ x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2), d: G.district.id, dist: +G.cam.dist.toFixed(1) }); }
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
  const t = setInterval(() => { if (window.game) { clearInterval(t); window.__pt.startMonitor(); } }, 100);
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

// ------------------------------------------------------------------ cooking minigame driver (real clicks / keys)
async function playCooking(timeout = 60_000) {
  const t0 = Date.now();
  const log = [];
  let lastKey = '', sameN = 0;
  const info = () => ev(() => {
    const root = document.querySelector('.cook.open') ?? window.__pt.topEl();
    const cv = root?.querySelector('.cook-view canvas') ?? root?.querySelector('canvas');
    const r = cv?.getBoundingClientRect();
    const m = root?.querySelector('.ck-meter');
    const pct = (e) => e ? parseFloat(e.style.width || e.style.left || '0') : null;
    return {
      open: !!root && window.__pt.kind() === 'cook',
      instr: root?.querySelector('.cook-instr')?.textContent?.trim() ?? '',
      step: root?.querySelector('.cook-step-wrap span')?.textContent ?? '',
      chips: root?.querySelectorAll('.ck-chips span.done').length ?? 0,
      meter: m ? { fill: pct(m.querySelector('i')), target: pct(m.querySelector('b')) } : null,
      cv: r && { x: r.left, y: r.top, w: r.width, h: r.height },
      done: /order ready|serve it/i.test(root?.textContent ?? ''),
    };
  });
  const drag = async (pts) => { await page.mouse.move(pts[0][0], pts[0][1]); await page.mouse.down(); for (const [x, y] of pts.slice(1)) { await page.mouse.move(x, y, { steps: 2 }); await sleep(12); } await page.mouse.up(); };
  while (Date.now() - t0 < timeout) {
    const c = await info();
    if (!c.open) return { closed: true, ms: Date.now() - t0, log };
    if (c.done || !c.cv) { await sleep(250); continue; }
    const key = `${c.step}|${c.instr}|${c.chips}`;
    sameN = key === lastKey ? sameN + 1 : 0; lastKey = key;
    const { x, y, w, h } = c.cv, cx = x + w / 2, cy = y + h / 2;
    const stuck = sameN >= 6; // gesture is not progressing: fall back to the keyboard alternative
    if (stuck && sameN === 6) log.push(`mouse gesture made no progress on "${c.instr}" -> keyboard`);
    if (stuck) { await page.keyboard.press(/roll/i.test(c.instr) ? 'w' : /layer|order|bowl|pick|choose/i.test(c.instr) ? String(1 + (sameN % 5)) : 'Space'); await sleep(200); continue; }
    if (/shape|circle|rice/i.test(c.instr)) {
      const pts = []; for (let k = 0; k <= 48; k++) { const a = (k / 16) * Math.PI * 2; pts.push([cx + Math.cos(a) * w * 0.08, cy + Math.sin(a) * h * 0.12]); }
      await drag(pts); log.push('circle');
    } else if (/cut the roll|chop/i.test(c.instr)) {
      await page.mouse.click(cx, cy); log.push('chop'); await sleep(250);
    } else if (/slice/i.test(c.instr)) {
      const vertical = sameN % 2 === 1;
      const pts = []; for (let k = 0; k <= 20; k++) pts.push(vertical ? [cx, y + h * (0.15 + 0.7 * k / 20)] : [x + w * (0.15 + 0.7 * k / 20), cy]);
      await drag(pts); log.push(vertical ? 'slice-v' : 'slice-h'); await sleep(250);
    } else if (/roll/i.test(c.instr)) {
      const pts = []; for (let k = 0; k <= 12; k++) pts.push([cx, y + h * (0.8 - 0.6 * k / 12)]);
      await drag(pts); log.push('roll');
    } else if (/spoon|roe|hold/i.test(c.instr) && c.meter) {
      await page.mouse.move(cx, cy); await page.mouse.down();
      const tEnd = Date.now() + 4000;
      while (Date.now() < tEnd) { const m = (await info()).meter; if (!m || m.fill === null || m.fill >= (m.target ?? 70) - 2) break; await sleep(25); }
      await page.mouse.up(); log.push('hold'); await sleep(400);
    } else if (/layer|order|bowl|pick|add|choose/i.test(c.instr) && !/drag|drop|ring/i.test(c.instr)) {
      // click across the board to hit the bowls (wrong picks count as mistakes, that's fine)
      const col = sameN % 5, row = Math.floor(sameN / 5) % 2;
      await page.mouse.click(x + w * (0.2 + 0.15 * col), y + h * (0.35 + 0.3 * row)); log.push('pick'); await sleep(250);
    } else {
      // drag-to-ring style steps: drag from the middle toward the centre-low area, else Space
      await drag([[cx, y + h * 0.3], [cx, cy], [cx, y + h * 0.6]]); log.push('drag'); await sleep(300);
    }
  }
  return { closed: false, ms: Date.now() - t0, log };
}

// ------------------------------------------------------------------ "click every button" driver
const clickFails = [];
const cookLog = [];
const DANGER =/delete|reset|wipe|quit|main menu|import|new game|yes, new|copy/i;
/** Click every visible control in the top modal once (re-scanning after each click). Checks cash after each. */
async function clickAll(label, { maxClicks = 60, skip = DANGER, tabsToo = false } = {}) {
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
    const items = (await ev(() => window.__pt.scan())).filter((b) => !done.has(b.sig) && !skip.test(b.text) && (tabsToo || !b.tab) && !/^✕$|close|not now|cancel|back$/i.test(b.text.trim()));
    if (!items.length) break;
    const b = items[0];
    done.add(b.sig);
    const before = await snap();
    // the UI re-renders live, so a tagged element may be replaced between scan and click: re-scan and retry by signature
    let clicked = false;
    for (let tryN = 0; tryN < 3 && !clicked; tryN++) {
      const idx = tryN === 0 ? b.i : (await ev(() => window.__pt.scan())).find((x) => x.sig === b.sig)?.i;
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
    if (after.modal !== before.modal) { // opened something (e.g. a confirm) or closed itself
      if (after.modal === "dialog" || /celebrat/i.test(after.modal ?? "")) { await settle(); continue; } // a story beat popped up
      if (after.stack.length > before.stack.length) { await shot(`${label}-sub-${b.act ?? 'x'}`); await page.keyboard.press('Escape'); await sleep(250); }
      else break;
    }
  }
  return clicks;
}

// which window each interactable should open (matched against the modal kind, case-insensitive regex)
const EXPECT = { sign: 'prop', supplier: 'shop', metro: 'map', npc: 'dialog', hq: 'manage|empire', prep: 'cook', counter: 'none' };

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

// =================================================================== the playtest
await section('boot + fresh title screen', async () => {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.game, null, { timeout: 60_000 });
  await ev(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.game, null, { timeout: 60_000 });
  await sleep(800);
  await shot('title');
  // keys must not move anything on the title screen
  await hold(['w', 'Tab'], 300);
  if ((await snap()).started) find('high', 'game started from a key press on the title screen');
});

await section('title buttons + character creator (real clicks)', async () => {
  for (const name of [/settings/i, /credits/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible()) { await b.click(); await sleep(250); await shot(`title-${name.source}`); const back = page.getByRole('button', { name: /^back$/i }).first(); if (await back.isVisible()) await back.click(); }
  }
  await page.getByRole('button', { name: /new game/i }).first().click();
  await sleep(300);
  const confirm = page.getByRole('button', { name: /yes, new game/i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  const name = page.locator('input[type=text]').filter({ visible: true }).first();
  await name.waitFor();
  await name.fill('Play Tester');
  // click a few swatches / options in the creator
  const opts = await page.locator('.title-panel button, .creator button').filter({ visible: true }).all();
  let n = 0;
  for (const o of opts) { const t = (await o.textContent())?.trim() ?? ''; if (/open the stand|back|cancel/i.test(t)) continue; if (n++ % 3 === 0) await o.click({ timeout: 800 }).catch(() => {}); }
  await shot('creator');
  await page.getByRole('button', { name: /open the stand|start/i }).first().click();
  await page.waitForFunction(() => window.game.started, null, { timeout: 10_000 });
  return { creatorClicks: n };
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

await section('stand: walk in through each open side to the prep board and back out', async () => {
  const st = await ev(() => { const s = window.game.district.sites.find((x) => window.game.s.restaurants[x.id]); return s && { prep: s.prep, box: s.interior }; });
  if (!st?.box) return 'no owned site with an interior box';
  const { minX, maxX, minZ, maxZ } = st.box, mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
  const sides = { west: [minX - 1.2, mz], east: [maxX + 1.2, mz], north: [mx, minZ - 1.2], south: [mx, maxZ + 1.2] };
  const res = {};
  for (const [name, [x, z]] of Object.entries(sides)) {
    if (!(await freeAt(x, z))) { res[name] = 'blocked-start'; continue; }
    await teleport(x, z, 0);
    // walk to the side midpoint just inside the box edge first, then to the prep board
    const ix = name === 'west' ? minX + 0.6 : name === 'east' ? maxX - 0.6 : mx, iz = name === 'north' ? minZ + 0.6 : name === 'south' ? maxZ - 0.6 : mz;
    await walkTo(ix, iz, { stop: 0.5, timeout: 3000 });
    const dIn = await walkTo(st.prep.x, st.prep.z, { stop: 0.6, timeout: 4000 });
    let out = null;
    if (dIn < 1) { await walkTo(ix, iz, { stop: 0.5, timeout: 3000 }); out = (await walkTo(x, z, { stop: 0.7, timeout: 3000 })) < 1.2; }
    res[name] = dIn < 1 ? (out ? 'in+out' : 'in-only') : `no (${dIn.toFixed(1)} m short)`;
    const s = await snap();
    if (s.pen > 0.12) find('high', 'player overlaps a collider inside the stand', { at: [s.x, s.z] });
  }
  await teleport(st.prep.x, st.prep.z, st.prep.yaw); await sleep(300);
  await shot('stand-inside');
  if (!Object.values(res).some((v) => v === 'in+out')) find('high', 'could not walk into the stand and back out from any side', res);
  return res;
});

await section('first order loop: counter E → prep E → cooking via real clicks (Tab spam) → serve', async () => {
  const site = await ev(() => window.game.district.sites.find((x) => window.game.s.restaurants[x.id])?.id);
  const its = await ev(() => window.__pt.interactables());
  const counter = its.find((x) => x.kind === 'counter'), prep = its.find((x) => x.kind === 'prep');
  await teleport(counter.x, counter.z, counter.yaw);
  const got = await page.waitForFunction((i) => /take order/i.test(window.__pt.interactables()[i]?.prompt ?? ''), counter.i, { timeout: 60_000, polling: 250 }).then(() => true, () => false);
  if (!got) return 'no customer came within 60 s';
  const r1 = await interact({ ...counter, prompt: null }, 'none');
  await sleep(300);
  const orders = await ev((id) => window.game.s.restaurants[id].orders.length, site);
  if (!orders) find('high', 'pressing E at the counter did not take the order', r1);
  const r2 = await interact(prep, 'cook');
  if ((await snap()).modal !== 'cook') return { r1, r2, note: 'cooking did not open' };
  // spam Tab / M / E during cooking: must not open other windows or break the session
  await page.keyboard.press('m'); await page.keyboard.press('e'); await sleep(200);
  let s = await snap();
  if (s.modal !== 'cook') find('high', `M/E during cooking changed the window to "${s.modal}"`, { stack: s.stack });
  await page.keyboard.press('Tab'); await sleep(150); await page.keyboard.press('m'); await sleep(250);
  s = await snap();
  if (s.modal !== 'cook') find('low', `Tab during cooking cancels the minigame${s.modal ? ` and a follow-up M opens "${s.modal}"` : ''}`, { stack: s.stack });
  if (s.modal === 'cook' || (await ev(() => !!document.querySelector('.cook.open')))) {
    const cook = await playCooking();
    cookLog.push(...cook.log);
    if (!cook.closed) find('high', 'cooking minigame did not finish within 60 s of real mouse play', { log: cook.log.slice(-12) });
  } else {
    // Tab closed the cooking (and M may have opened the map) — the ticket must be cookable again and the game playable
    await recover();
    await expectPlayable('Tab during cooking');
    await interact(prep, 'cook');
    if ((await snap()).modal === 'cook') await playCooking();
  }
  await expectPlayable('cooking');
  const ready = await ev((id) => window.game.s.restaurants[id].ready.length, site);
  const cash0 = (await snap()).cash;
  const r3 = await interact({ ...counter, i: counter.i }, 'none');
  await sleep(400);
  const cash1 = (await snap()).cash;
  if (ready && cash1 <= cash0) find('high', 'serving at the counter did not pay', { ready, cash0, cash1, r3 });
  return { orders, ready, served: r3.prompt, cash: [cash0, cash1] };
});

await section('more orders by mouse + Esc mid-cook (ticket must stay cookable)', async () => {
  const site = await ev(() => window.game.district.sites.find((x) => window.game.s.restaurants[x.id])?.id);
  await ev(() => { const s = window.game.s; for (const k of Object.keys(s.inventory)) s.inventory[k] = Math.max(s.inventory[k], 40); }); // enough stock for several recipes
  const its = await ev(() => window.__pt.interactables());
  const counter = its.find((x) => x.kind === 'counter'), prep = its.find((x) => x.kind === 'prep');
  const res = { cooked: 0, escTest: null, recipes: [] };
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000 && res.cooked < 3) {
    await settle();
    await teleport(counter.x, counter.z, counter.yaw);
    const p = await page.waitForFunction((i) => window.__pt.interactables()[i]?.prompt ?? '', counter.i, { timeout: 30_000, polling: 250 }).then((h) => h.jsonValue(), () => '');
    if (/take order|serve/i.test(p)) { await page.keyboard.press('e'); await sleep(300); }
    const cp = await ev((i) => window.__pt.interactables()[i]?.prompt ?? null, prep.i);
    if (!cp) continue;
    await teleport(prep.x, prep.z, prep.yaw); await sleep(200);
    await page.keyboard.press('e'); await sleep(500);
    if ((await snap()).modal !== 'cook') continue;
    if (res.escTest === null) {
      const tid = await ev((id) => window.game.s.restaurants[id].orders.find((t) => t.cook === 'player')?.id ?? null, site);
      await page.keyboard.press('Escape'); await sleep(400);
      const after = await snap();
      const t = await ev(([id, tid]) => window.game.s.restaurants[id].orders.find((x) => x.id === tid) ?? null, [site, tid]);
      res.escTest = { closed: after.modal !== 'cook', ticketKept: !!t, cookReset: t ? t.cook !== 'player' : null };
      if (after.modal === 'cook') find('medium', 'Esc does not cancel the cooking minigame');
      if (t && t.cook === 'player') find('high', 'ticket stays assigned to the player after Esc-cancelling the minigame (no one will cook it)', { tid });
      await expectPlayable('Esc during cooking');
      continue;
    }
    res.recipes.push(cp);
    const cook = await playCooking();
    cookLog.push(...cook.log);
    if (!cook.closed) { find('high', `cooking "${cp}" did not finish within 60 s of real mouse play`, { log: cook.log.slice(-12) }); await recover(); continue; }
    res.cooked++;
    await expectPlayable('cooking');
  }
  res.gestures = [...new Set(cookLog.filter((l) => !l.includes('->')))];
  res.fallbacks = cookLog.filter((l) => l.includes('->'));
  return res;
});

await section('every interactable: walk up, check prompt, press E', async () => {
  const its = await ev(() => window.__pt.interactables());
  const res = [];
  for (const it of its) {
    if (it.kind === 'counter' || it.kind === 'prep') continue; // covered by the order loop
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

await section('supplier shop: every buy button, broke and rich', async () => {
  const sup = (await ev(() => window.__pt.interactables())).find((x) => x.kind === 'supplier');
  if (!sup) return 'no supplier in district';
  const open = async () => { await recover(); await teleport(sup.x, sup.z, sup.yaw); await sleep(200); await page.keyboard.press('e'); await sleep(400); return (await snap()).modal; };
  if ((await open()) !== 'shop') return 'shop did not open';
  const rich = await clickAll('shop-rich', { maxClicks: 40 });
  await ev(() => { window.game.s.cash = 3; });
  await recover();
  await open();
  const broke = await clickAll('shop-broke', { maxClicks: 40 });
  const s = await snap();
  if (s.cash < 0) find('high', 'shop purchases with ¥3 left drove cash negative', { cash: s.cash });
  await shot('shop-broke');
  await recover();
  await ev(() => { window.game.s.cash = 5000; });
  return { rich, broke, cash: s.cash };
});

async function manageAll(label) {
  await recover();
  await page.keyboard.press('Tab'); await sleep(400);
  let s = await snap();
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
  for (const it of its.filter((x) => ['sign', 'supplier', 'metro', 'npc', 'hq'].includes(x.kind))) {
    const r = await interact(it, EXPECT[it.kind]);
    res.push(`${it.kind}:${r.opened ?? 'none'}`);
    await recover();
    await expectPlayable(`closing ${it.kind}`);
  }
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
    if (v === 'customize') await clickAll('customize', { maxClicks: 8, skip: /save look|cancel|back/i });
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

await section('photo mode (P): move, drag, buttons, Esc/Tab/M inside, P to close', async () => {
  const isOpen = () => ev(() => window.game.photo?.isOpen?.() ?? false);
  await page.keyboard.press('p'); await sleep(400);
  if (!(await isOpen())) return 'P did not open photo mode (or no photo mode)';
  await shot('photo-open');
  const s0 = await snap();
  await hold(['w'], 500);
  const { width, height } = W();
  await page.mouse.move(width / 2, height / 2); await page.mouse.down(); await page.mouse.move(width / 2 + 150, height / 2 + 40, { steps: 6 }); await page.mouse.up();
  await page.mouse.wheel(0, 300);
  const s1 = await snap();
  if (Math.hypot(s1.x - s0.x, s1.z - s0.z) > 0.3) find('medium', 'W moves the chef while photo mode is open', { moved: Math.hypot(s1.x - s0.x, s1.z - s0.z) });
  // buttons in the photo bar (skip the shutter: it downloads a file)
  const btns = await page.locator('.photo-bar button').filter({ visible: true }).all();
  for (const b of btns) { const t = (await b.textContent()) ?? ''; if (/shutter|snap|📸|save|capture|close|exit|done/i.test(t) || /shutter/.test(await b.getAttribute('class') ?? '')) continue; await b.click({ timeout: 800 }).catch(() => {}); await sleep(120); }
  await page.keyboard.press('Tab'); await sleep(250);
  let s = await snap();
  if (s.modal === 'manage') find('medium', 'Tab opens management on top of photo mode', { stack: s.stack });
  await page.keyboard.press('m'); await sleep(250);
  s = await snap();
  if (s.modal === 'map') find('medium', 'M opens the map on top of photo mode', { stack: s.stack });
  await page.keyboard.press('Escape'); await sleep(300);
  s = await snap();
  const stillOpen = await isOpen();
  await shot('photo-esc');
  const res = { afterEsc: { photo: stillOpen, stack: s.stack, paused: s.paused } };
  if (stillOpen && (s.paused || s.stack.length)) find('medium', 'Esc in photo mode opens the pause menu underneath the photo overlay instead of leaving photo mode', res.afterEsc);
  await recover();
  if (await isOpen()) { await page.keyboard.press('p'); await sleep(300); }
  if (await isOpen()) find('high', 'cannot leave photo mode with P/Esc');
  await expectPlayable('photo mode');
  const hud = await ev(() => { const e = document.querySelector('#h-cash, .hud-tl, .money'); return !!e && window.__pt.vis(e); });
  if (!hud) find('medium', 'HUD not visible again after closing photo mode');
  return res;
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
  await page.getByRole('button', { name: /save & main menu|main menu/i }).first().click();
  await sleep(600);
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

// ------------------------------------------------------------------ report
current = 'report';
await drainMonitor();
if (mon?.nan?.length) find('critical', 'cash became NaN/Infinity at runtime', { samples: mon.nan });
if (mon?.stuck?.length) find('high', 'input disabled for >2.5 s with no window open (soft-lock)', { samples: mon.stuck });
if (mon?.pen?.length) find('medium', `player overlapped colliders while grounded (${mon.pen.length} samples)`, { samples: mon.pen.slice(0, 8) });
if (mon?.cam?.length) find('medium', `camera inside a collider during play (${mon.cam.length} samples)`, { samples: mon.cam.slice(0, 8) });
const report = { url, when: new Date().toISOString(), sections, findings, clickFails, cookLog, monitor: { frames: mon.frames, hitches: mon.hitch, minCash: mon.minCash }, logs };
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
