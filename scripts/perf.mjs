// Performance probe: FPS, draw calls, triangles, GPU resources, scene counts and heap per district / time / state / quality,
// plus a travel leak check and a tycoon scenario (40 restaurants, 1× vs 4× speed, sim vs render split, Manage/Daichō DOM cost).
// Drives window.game against an already running dev server (does NOT start one).
// Usage: node scripts/perf.mjs [url] [--scenarios=busy,fresh,tycoon] [--secs=5] [--warm=45] [--dpr=2] [--vsync] [--headed]
//        [--only=asakusa,ginza] [--tycoon-n=40] [--no-leak] [--leak-loops=10] [--dry-run]
// --dry-run: build each scenario's state and take one 1 s sample per kind of row (checks the setup; numbers are meaningless).
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const flag = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const url = argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/';
const DRY = argv.includes('--dry-run');
const SECS = DRY ? 1 : Number(flag('secs', 5));
const SCENARIOS = flag('scenarios', 'busy,fresh,tycoon').split(',');
const TYCOON_N = Number(flag('tycoon-n', 40));
// Visible customers spawn in real time (a few per minute per site) and reset on every travel: in the busy state, let them
// build up after each arrival so rows include a realistic crowd (fresh games have no staff to warm up for).
const WARM = DRY ? 0 : Number(flag('warm', 45));
let warmed = null; // district the current busy crowd was built up in
const HEADED = argv.includes('--headed');
const DPR = Number(flag('dpr', 2)); // 2 = a retina Mac; high quality renders at min(dpr, 2), post at <=1.5
const VSYNC = argv.includes('--vsync'); // default: uncapped frame rate so FPS shows headroom above 60
const LEAK = !argv.includes('--no-leak') && !DRY;
const LEAK_LOOPS = Number(flag('leak-loops', 10));
let DISTRICTS = flag('only', '').split(',').filter(Boolean); // default: every walkable area (read from data.AREAS)
const TIMES = { noon: 12 * 60, night: 22 * 60 };

const browser = await chromium.launch({
  headless: !HEADED,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    ...(VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: DPR });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`[http ${r.status()}] ${new URL(r.url()).pathname}`); }); // names the module Vite failed to transform
await page.addInitScript(() => {
  // Other agents edit files concurrently: block Vite's HMR socket so the page is not reloaded mid-run.
  window.WebSocket = class { constructor() {} addEventListener() {} removeEventListener() {} send() {} close() {} };
  performance.setResourceTimingBufferSize(10_000);
  window.__mod = (path) => {
    const hit = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(hit ?? path);
  };
  // Count live listeners on window/document (getEventListeners is DevTools-only).
  window.__listeners = 0;
  const add = EventTarget.prototype.addEventListener, rm = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (...a) { if (this === window || this === document) window.__listeners++; return add.apply(this, a); };
  EventTarget.prototype.removeEventListener = function (...a) { if (this === window || this === document) window.__listeners--; return rm.apply(this, a); };
});
const cdp = await page.context().newCDPSession(page);
const gc = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); };
const wait = (fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

await page.goto(url, { waitUntil: 'load' });
await wait(() => !!window.game, null, 60_000);
await page.evaluate(() => {
  const g = window.game, frame = Object.getPrototypeOf(g).frame, info = g.renderer.info;
  window.__cpu = []; window.__rnd = []; window.__calls = []; window.__tris = []; window.__ui = []; window.__npc = [];
  info.autoReset = false; // the composer issues several render() calls per frame: count them all
  let rnd = 0, uiT = 0, npcT = 0;
  const wrap = (o, k, add) => { // time an instance method; re-applied each frame because npcs/post are replaced on travel
    if (!o || o[k].__perf) return;
    const fn = o[k].bind(o);
    o[k] = (...a) => { const t = performance.now(); try { return fn(...a); } finally { add(performance.now() - t); } };
    o[k].__perf = true;
  };
  const wrapPost = () => {
    const post = g.post;
    if (!post || post.__wrapped) return;
    const render = post.render.bind(post);
    post.render = () => { const t = performance.now(); render(); rnd += performance.now() - t; };
    post.__wrapped = true;
  };
  g.frame = function () {
    wrapPost(); info.reset(); rnd = 0; uiT = 0; npcT = 0;
    wrap(g.ui, 'update', (ms) => { uiT += ms; }); wrap(g.npcs, 'update', (ms) => { npcT += ms; });
    const t = performance.now(); frame.call(this);
    window.__cpu.push(performance.now() - t); window.__rnd.push(rnd); window.__ui.push(uiT); window.__npc.push(npcT);
    window.__calls.push(info.render.calls); window.__tris.push(info.render.triangles);
  };
});
if (!DISTRICTS.length) DISTRICTS = await page.evaluate(async () => {
  const data = await window.__mod('/src/core/data.ts');
  return Object.keys(data.AREAS).filter((id) => data.AREAS[id].walkable);
});
const gpu = await page.evaluate(() => {
  const gl = window.game.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

async function newState(busy) {
  warmed = null;
  await page.evaluate(() => localStorage.clear());
  const err = await page.evaluate(async ([busy, walk]) => {
    const g = window.game;
    g.ui.dialog = async () => {};
    g.newGame({ name: 'Perf Chef', company: 'Perf Sushi Co', avatar: g.s.player.avatar });
    await new Promise((r) => setTimeout(r, 50)); // let the stubbed tutorial dialog resolve (clears g.busy)
    const s = g.s;
    s.tutorial = 99;
    for (const d of walk) if (!s.districts.includes(d)) s.districts.push(d);
    if (!busy) return null;
    const [A, sim, data] = await Promise.all(['/src/core/actions.ts', '/src/core/sim.ts', '/src/core/data.ts'].map((p) => window.__mod(p)));
    s.cash = 1e12;
    s.lifetime.pieces = Math.max(s.lifetime.pieces, 500_000);
    for (const p of Object.values(data.PROPERTIES)) if (!s.restaurants[p.id] && s.districts.includes(p.district)) { const e = A.buyProperty(s, p.id); if (e) return `buyProperty ${p.id}: ${e}`; }
    for (const id of Object.keys(s.restaurants)) for (const u of Object.keys(data.UPGRADES)) while (A.buyUpgrade(s, id, u) === null);
    for (const id of Object.keys(s.restaurants)) for (const role of ['chef', 'server']) {
      while (sim.staffAt(s, id, role).length < sim.slotsFor(s, id, role)) {
        const c = sim.makeCandidate(s, role); s.candidates.push(c);
        const e = A.hire(s, c.id, id); if (e) return `hire ${role}@${id}: ${e}`;
      }
    }
    return null;
  }, [busy, DISTRICTS]);
  if (err) throw new Error(err);
  // Toasts from the setup pile up in the DOM; let them clear so they don't skew FPS.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

// Tycoon: chapter 2, every area unlocked (most are remote/management-only), N restaurants round-robin over the concepts,
// ops_center (every restaurant managed: auto-hire + auto-price), every empire alert fixed. Mirrors smoke-sim.mjs's tycoon checks.
async function tycoonState(n) {
  await newState(false);
  const r = await page.evaluate(async (n) => {
    const g = window.game, s = g.s;
    const [A, data, E] = await Promise.all(['actions', 'data', 'empire'].map((m) => window.__mod(`/src/core/${m}.ts`)));
    s.flags.chapter2 = true; s.lifetime.pieces = 2e9; s.cash = 1e15;
    const errs = [];
    for (const id of Object.keys(data.AREAS)) if (!s.districts.includes(id)) { const e = A.unlockDistrict(s, id); if (e) errs.push(`unlock ${id}: ${e}`); }
    for (const id of ['ops_center']) if (!s.research.includes(id)) s.research.push(id);
    const concepts = data.CONCEPT_IDS.filter((c) => c !== 'stand'); // stand only fits stand lots
    let k = 0;
    for (const p of Object.values(data.PROPERTIES)) {
      if (Object.keys(s.restaurants).length >= n) break;
      if (s.restaurants[p.id] || !s.districts.includes(p.district)) continue;
      const e = A.buyProperty(s, p.id, p.kind === 'stand' ? 'stand' : concepts[k++ % concepts.length]);
      if (e) errs.push(`buy ${p.id}: ${e}`);
    }
    for (const a of E.alerts(s)) if (a.fix) { const e = E.applyFix(s, a); if (e) errs.push(`fix ${a.fix.id}: ${e}`); }
    g.refreshWorld();
    const ids = Object.keys(s.restaurants);
    return { n: ids.length, remote: ids.filter((id) => !data.AREAS[data.PROPERTIES[id].district].walkable).length, staff: s.staff.length, alertsLeft: E.alerts(s).length, errs };
  }, n);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  if (r.n < n) throw new Error(`tycoon: only ${r.n}/${n} restaurants (${r.errs.slice(0, 3).join('; ')})`);
  return r;
}

// Inclusive ms per frame of sim.tick and empire.tickEmpire from a CPU profile (module exports can't be wrapped).
async function profileSplit(secs) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  await page.evaluate(() => { window.__cpu.length = 0; });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(secs * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const frames = await page.evaluate(() => window.__cpu.length);
  const byId = new Map(profile.nodes.map((x) => [x.id, x])), parent = new Map();
  for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
  const want = { sim: ['tick', '/src/core/sim.ts'], empire: ['tickEmpire', '/src/core/empire.ts'] };
  const ms = { sim: 0, empire: 0 };
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const hit = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const cf = byId.get(x).callFrame;
      for (const [k, [fn, file]] of Object.entries(want)) if (cf.functionName === fn && cf.url.includes(file)) hit.add(k);
    }
    for (const k of hit) ms[k] += dt;
  });
  return { simMs: ms.sim / Math.max(1, frames), empireMs: ms.empire / Math.max(1, frames) };
}

// DOM cost while a dashboard is open: layouts / style recalcs per frame (>1 layout per frame = forced sync layout,
// i.e. thrash), their ms, DOM mutations per frame, and the ui.update share of the frame.
async function domCost(secs) {
  await cdp.send('Performance.enable');
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await page.evaluate(() => {
    window.__mut = 0;
    window.__mo?.disconnect();
    window.__mo = new MutationObserver((l) => { window.__mut += l.length; });
    window.__mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const a = await m();
  const fps = await sampleFps(secs);
  const b = await m();
  const extra = await page.evaluate(() => { window.__mo.disconnect(); return { mut: window.__mut, nodes: document.getElementsByTagName('*').length }; });
  const frames = Math.max(1, fps.frames);
  return {
    ...fps, layouts: (b.LayoutCount - a.LayoutCount) / frames, styles: (b.RecalcStyleCount - a.RecalcStyleCount) / frames,
    layoutMs: ((b.LayoutDuration - a.LayoutDuration) * 1000) / frames, styleMs: ((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000) / frames,
    mutations: extra.mut / frames, domNodes: extra.nodes,
    scriptMs: ((b.ScriptDuration - a.ScriptDuration) * 1000) / frames, taskMs: ((b.TaskDuration - a.TaskDuration) * 1000) / frames,
  };
}

async function travel(d) {
  const cur = await page.evaluate(() => window.game.district.id);
  if (cur === d) return;
  await wait(() => !document.querySelector('.fade-overlay'), null, 15_000);
  // game.travel() no-ops while busy (story dialogs, etc.), so keep asking until it happens
  await wait((d) => {
    const g = window.game, idle = !document.querySelector('.fade-overlay');
    if (g.district.id !== d && idle) g.travel(d);
    return g.district.id === d && idle;
  }, d, 20_000);
}

async function setQuality(q) { await page.evaluate((q) => { window.game.s.settings.quality = q; window.game.applySettings(); }, q); }

const stats = () => page.evaluate(() => {
  const g = window.game, info = g.renderer.info;
  let objects = 0, meshes = 0, visMeshes = 0, instanced = 0, instances = 0, lights = 0, shadowLights = 0, sprites = 0;
  const geos = new Set(), mats = new Set();
  g.scene.traverse((o) => {
    objects++;
    if (o.isMesh || o.isSprite || o.isPoints || o.isLine) {
      if (o.isSprite) sprites++; else meshes++;
      let v = true; for (let p = o; p; p = p.parent) if (!p.visible) { v = false; break; }
      if (v) visMeshes++;
      if (o.isInstancedMesh) { instanced++; instances += o.count; }
      if (o.geometry) geos.add(o.geometry.uuid);
      for (const m of [].concat(o.material ?? [])) mats.add(m.uuid);
    }
    if (o.isLight && !o.isAmbientLight && !o.isHemisphereLight) { lights++; if (o.castShadow && o.visible) shadowLights++; }
  });
  const n = g.npcs ?? {};
  const npcs = ['customers', 'staff', 'peds', 'story'].reduce((a, k) => a + (Array.isArray(n[k]) ? n[k].length : 0), 0);
  return {
    geoMem: info.memory.geometries, texMem: info.memory.textures,
    programs: info.programs?.length ?? 0, objects, meshes, visMeshes, instanced, instances, sprites, uniqGeo: geos.size, uniqMat: mats.size,
    lights, shadowLights, npcs, children: g.scene.children.length, pr: g.renderer.getPixelRatio(),
    heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN, listeners: window.__listeners,
  };
});

// FPS via our own rAF timestamps (game.fpsValue integrates a dt clamped to 50 ms, so it over-reports below 20 fps).
const customers = () => page.evaluate(() => window.game.npcs.customers?.length ?? 0);
const sampleFps = (secs) => page.evaluate((secs) => new Promise((resolve) => {
  const ts = [], gameFps = [];
  for (const k of ['__cpu', '__rnd', '__calls', '__tris', '__ui', '__npc']) window[k].length = 0;
  const end = performance.now() + secs * 1000;
  let last = 0;
  const step = (t) => {
    ts.push(t);
    if (t - last > 1000) { last = t; gameFps.push(window.game.fpsValue); }
    if (t < end) requestAnimationFrame(step);
    else {
      const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
      const span = (ts.at(-1) - ts[0]) / 1000;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      resolve({
        avg: (ts.length - 1) / span, p1: 1000 / d[Math.floor(d.length * 0.99)], worstMs: d.at(-1),
        gameAvg: mean(gameFps), cpuMs: mean(window.__cpu), renderMs: mean(window.__rnd), uiMs: mean(window.__ui), npcMs: mean(window.__npc), frames: window.__cpu.length,
        calls: mean(window.__calls), callsMin: Math.min(...window.__calls), callsMax: Math.max(...window.__calls), tris: mean(window.__tris),
      });
    }
  };
  requestAnimationFrame(step);
}), secs);

async function measure(label, d, time, quality, speed = 1) {
  const moved = await page.evaluate((d) => window.game.district.id !== d, d);
  await travel(d);
  if (moved) warmed = null;
  if (warmed !== d && label !== 'fresh' && WARM > 0) {
    warmed = d;
    await page.evaluate((m) => { const g = window.game; g.s.minute = m; const sp = g.district.spawn; g.player.teleport(sp.x, sp.z, sp.yaw); }, TIMES.noon);
    for (let t = 0; t < WARM; t += 5) { await page.waitForTimeout(5000); await page.evaluate((m) => { window.game.s.minute = m; }, TIMES.noon); }
  }
  await setQuality(quality);
  await page.evaluate((sp) => window.game.setSpeed?.(sp), speed);
  await page.evaluate((m) => { const g = window.game; g.s.minute = m; const sp = g.district.spawn; g.player.teleport(sp.x, sp.z, sp.yaw); }, TIMES[time]);
  await page.waitForTimeout(1500); // let NPCs spawn and shaders compile
  await page.evaluate((m) => { window.game.s.minute = m; }, TIMES[time]); // the clock keeps running; re-pin
  const fps = await sampleFps(SECS);
  await gc();
  const st = await stats();
  st.customers = await customers();
  const split = label === 'tycoon' ? await profileSplit(Math.min(3, SECS)) : {};
  await page.evaluate(() => window.game.setSpeed?.(1));
  return { label, d, time, quality, speed, ...st, ...fps, ...split };
}

const rows = [];
const t0 = Date.now();
const dryD = DRY ? DISTRICTS.slice(0, 1) : DISTRICTS, dryT = DRY ? ['noon'] : Object.keys(TIMES);
for (const state of ['busy', 'fresh'].filter((x) => SCENARIOS.includes(x))) {
  await newState(state === 'busy');
  for (const quality of state === 'busy' ? (DRY ? ['high', 'low'] : ['high', 'medium', 'low']) : ['high']) {
    for (const d of dryD) for (const time of dryT) {
      try { rows.push(await measure(state, d, time, quality)); }
      catch (e) { rows.push({ label: state, d, time, quality, error: String(e.message).split('\n')[0] }); }
      process.stderr.write('.');
    }
  }
}

let tycoon = null;
if (SCENARIOS.includes('tycoon')) {
  try {
    tycoon = { setup: await tycoonState(TYCOON_N), dash: [] };
    for (const d of dryD) for (const speed of [1, 4]) {
      try { rows.push(await measure('tycoon', d, 'noon', 'high', speed)); }
      catch (e) { rows.push({ label: 'tycoon', d, time: 'noon', quality: 'high', speed, error: String(e.message).split('\n')[0] }); }
      process.stderr.write('t');
    }
    // Manage / Daichō dashboard open over the whole empire (in the first district, warm crowd), closed vs open, 1× and 4×.
    await travel(DISTRICTS[0]);
    for (const speed of [1, 4]) for (const tab of [null, 'daicho']) {
      try {
        await page.evaluate(([sp, tab]) => {
          const g = window.game; g.setSpeed(sp); g.s.minute = 12 * 60;
          while (g.ui.isBlocking() && g.ui.closeTop());
          if (tab) g.ui.toggleManage(tab);
        }, [speed, tab]);
        await page.waitForTimeout(DRY ? 300 : 1500);
        const open = await page.evaluate(() => window.game.ui.isBlocking());
        if (tab && !open) throw new Error('dashboard did not open (ui.isBlocking() false)');
        tycoon.dash.push({ speed, tab: tab ?? 'closed', ...(await domCost(SECS)) });
      } catch (e) { tycoon.dash.push({ speed, tab: tab ?? 'closed', error: String(e.message).split('\n')[0] }); }
      process.stderr.write('d');
    }
    await page.evaluate(() => { const g = window.game; while (g.ui.isBlocking() && g.ui.closeTop()); g.setSpeed(1); });
  } catch (e) { tycoon = { error: String(e.message).split('\n')[0] }; }
}

let leak = null;
if (LEAK) {
  await newState(true);
  await setQuality('high');
  await travel('asakusa');
  await page.waitForTimeout(1000);
  const snap = async () => { await gc(); await page.waitForTimeout(300); return stats(); };
  const first = await snap();
  first.name = 'start';
  const history = [first];
  for (let i = 0; i < LEAK_LOOPS; i++) {
    await travel('shibuya'); await page.waitForTimeout(400);
    await travel('asakusa'); await page.waitForTimeout(400);
    if (i === 0 || i === LEAK_LOOPS - 1 || i === Math.floor(LEAK_LOOPS / 2) - 1) history.push({ ...(await snap()), name: `after ${i + 1}` });
    process.stderr.write('~');
  }
  leak = history;
}
process.stderr.write('\n');
await browser.close();

const pad = (s, n) => String(s).padStart(n);
const f = (x, dp = 0) => (Number.isFinite(x) ? x.toFixed(dp) : '-');
console.log(`\nGPU: ${gpu}   sample: ${SECS}s/row   headless: ${!HEADED}   total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const cols = [
  ['state', 6, (r) => r.label], ['district', 8, (r) => r.d], ['time', 5, (r) => r.time], ['qual', 4, (r) => r.quality], ['spd', 3, (r) => `${r.speed ?? 1}x`],
  ['pr', 4, (r) => f(r.pr, 2)], ['fps', 5, (r) => f(r.avg, 1)], ['1%low', 5, (r) => f(r.p1, 1)], ['worst', 6, (r) => f(r.worstMs, 0) + 'ms'], ['gFps', 5, (r) => f(r.gameAvg, 0)],
  ['cpuMs', 5, (r) => f(r.cpuMs, 2)], ['rndMs', 5, (r) => f(r.renderMs, 2)], ['uiMs', 5, (r) => f(r.uiMs, 2)], ['npcMs', 5, (r) => f(r.npcMs, 2)],
  ['simMs', 5, (r) => f(r.simMs, 3)], ['empMs', 5, (r) => f(r.empireMs, 3)],
  ['calls', 5, (r) => f(r.calls)], ['shCal', 5, (r) => r.callsMax - r.callsMin], ['tris', 8, (r) => f(r.tris)], ['geoGPU', 6, (r) => r.geoMem], ['texGPU', 6, (r) => r.texMem], ['progs', 5, (r) => r.programs],
  ['objs', 6, (r) => r.objects], ['meshes', 6, (r) => r.meshes], ['vis', 5, (r) => r.visMeshes], ['inst', 9, (r) => `${r.instanced}/${r.instances}`],
  ['uGeo', 5, (r) => r.uniqGeo], ['uMat', 5, (r) => r.uniqMat], ['lights', 6, (r) => r.lights], ['shdw', 4, (r) => r.shadowLights],
  ['npcs', 4, (r) => r.npcs], ['cust', 4, (r) => r.customers], ['heapMB', 6, (r) => f(r.heapMB, 1)],
];
console.log(cols.map(([h, w]) => pad(h, w)).join(' '));
for (const r of rows) {
  if (r.error) { console.log(`${pad(r.label, 6)} ${pad(r.d, 8)} ${pad(r.time, 5)} ${pad(r.quality, 4)} ${pad(`${r.speed ?? 1}x`, 3)}  ERROR ${r.error}`); continue; }
  console.log(cols.map(([, w, g]) => pad(g(r), w)).join(' '));
}
console.log('  fps/1%low/worst = own rAF timing (uncapped unless --vsync); gFps = game.fpsValue; cpuMs = JS time per game.frame(), rndMs = part of it in post.render (scene + shadow + post passes);');
console.log('  uiMs/npcMs = ui.update / npcs.update per frame; simMs/empMs = sim.tick / empire.tickEmpire per frame (tycoon rows only, from a CPU profile;');
console.log('  tickEmpire only does work once per in-game hour, so empMs is that cost averaged over the frames);');
console.log('  pr = renderer pixel ratio at the end of the sample (dynamic resolution may lower it);');
console.log('  calls/tris = mean per frame incl. post passes; shCal = max-min calls ~ shadow-pass calls (shadows redraw every other frame);');
console.log('  geoGPU/texGPU = live GPU resources; vis = meshes with all ancestors visible;');
console.log('  inst = InstancedMesh objects/instances; uGeo/uMat = unique geometries/materials in the scene graph; shdw = shadow-casting lights.');

if (tycoon) {
  if (tycoon.error) console.log(`\nTycoon setup FAILED: ${tycoon.error}`);
  else {
    const t = tycoon.setup;
    console.log(`\nTycoon: ${t.n} restaurants (${t.remote} remote), ${t.staff} staff, ${t.alertsLeft} alerts left after fixes${t.errs.length ? `; setup errors: ${t.errs.slice(0, 4).join('; ')}` : ''}`);
    console.log(`Manage/Daichō dashboard in ${DISTRICTS[0]} (high, noon):`);
    const dc = [['speed', 5, (r) => `${r.speed}x`], ['tab', 7, (r) => r.tab], ['fps', 6, (r) => f(r.avg, 1)], ['cpuMs', 6, (r) => f(r.cpuMs, 2)], ['uiMs', 6, (r) => f(r.uiMs, 2)], ['jsMs/f', 6, (r) => f(r.scriptMs, 2)], ['taskMs/f', 8, (r) => f(r.taskMs, 2)],
      ['layout/f', 8, (r) => f(r.layouts, 2)], ['layoutMs', 8, (r) => f(r.layoutMs, 2)], ['style/f', 7, (r) => f(r.styles, 2)], ['styleMs', 7, (r) => f(r.styleMs, 2)],
      ['mut/f', 6, (r) => f(r.mutations, 1)], ['domNodes', 8, (r) => r.domNodes]];
    console.log(dc.map(([h, w]) => pad(h, w)).join(' '));
    for (const r of tycoon.dash) console.log(r.error ? `${pad(`${r.speed}x`, 5)} ${pad(r.tab, 7)}  ERROR ${r.error}` : dc.map(([, w, g]) => pad(g(r), w)).join(' '));
    console.log('  jsMs/f = all main-thread JS per frame (incl. timers/handlers outside game.frame); taskMs/f = all main-thread work per frame (JS+style+layout+paint setup);');
    console.log('  layout/f, style/f = forced + regular layouts / style recalcs per frame (>1 layout per frame means layout thrash); mut/f = DOM mutations per frame.');
  }
}

if (leak) {
  console.log(`\nLeak check: asakusa→shibuya→asakusa ×${LEAK_LOOPS} (busy state, after forced GC, measured in asakusa)`);
  const lc = [['geoGPU', 'geoMem'], ['texGPU', 'texMem'], ['progs', 'programs'], ['objs', 'objects'], ['children', 'children'], ['listeners', 'listeners'], ['heapMB', 'heapMB']];
  console.log(pad('snapshot', 10) + lc.map(([h]) => pad(h, 10)).join(''));
  leak.forEach((s) => console.log(pad(s.name, 10) + lc.map(([, k]) => pad(k === 'heapMB' ? f(s[k], 1) : s[k], 10)).join('')));
  const a = leak[1], b = leak.at(-1), n = LEAK_LOOPS - 1; // compare after-1 vs end: excludes first-visit caches
  const per = (k) => ((b[k] - a[k]) / Math.max(1, n));
  console.log(`growth per round trip (after 1 → after ${LEAK_LOOPS}): ` + lc.map(([h, k]) => `${h} ${per(k) >= 0 ? '+' : ''}${f(per(k), k === 'heapMB' ? 2 : 1)}`).join(', '));
}
if (errors.length) console.log(`\nconsole/page errors (${errors.length}):\n  ${[...new Set(errors)].slice(0, 15).join('\n  ')}`);
process.exit(0);
