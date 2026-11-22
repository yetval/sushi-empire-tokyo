// Performance probe: FPS, draw calls, triangles, GPU resources, scene counts and heap per district / time / state / quality,
// plus a travel leak check. Drives window.game against an already running dev server (does NOT start one).
// Usage: node scripts/perf.mjs [url] [--secs=5] [--warm=45] [--dpr=2] [--vsync] [--headed] [--only=asakusa,ginza] [--no-leak] [--leak-loops=10]
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const flag = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const url = argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/';
const SECS = Number(flag('secs', 5));
// Visible customers spawn in real time (a few per minute per site) and reset on every travel: in the busy state, let them
// build up after each arrival so rows include a realistic crowd (fresh games have no staff to warm up for).
const WARM = Number(flag('warm', 45));
let warmed = null; // district the current busy crowd was built up in
const HEADED = argv.includes('--headed');
const DPR = Number(flag('dpr', 2)); // 2 = a retina Mac; high quality renders at min(dpr, 2), post at <=1.5
const VSYNC = argv.includes('--vsync'); // default: uncapped frame rate so FPS shows headroom above 60
const LEAK = !argv.includes('--no-leak');
const LEAK_LOOPS = Number(flag('leak-loops', 10));
const DISTRICTS = flag('only', 'asakusa,shibuya,shinjuku,ginza').split(',');
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
  window.__cpu = []; window.__rnd = []; window.__calls = []; window.__tris = [];
  info.autoReset = false; // the composer issues several render() calls per frame: count them all
  let rnd = 0;
  const wrapPost = () => {
    const post = g.post;
    if (!post || post.__wrapped) return;
    const render = post.render.bind(post);
    post.render = () => { const t = performance.now(); render(); rnd += performance.now() - t; };
    post.__wrapped = true;
  };
  g.frame = function () {
    wrapPost(); info.reset(); rnd = 0;
    const t = performance.now(); frame.call(this);
    window.__cpu.push(performance.now() - t); window.__rnd.push(rnd);
    window.__calls.push(info.render.calls); window.__tris.push(info.render.triangles);
  };
});
const gpu = await page.evaluate(() => {
  const gl = window.game.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

async function newState(busy) {
  warmed = null;
  await page.evaluate(() => localStorage.clear());
  const err = await page.evaluate(async (busy) => {
    const g = window.game;
    g.ui.dialog = async () => {};
    g.newGame({ name: 'Perf Chef', company: 'Perf Sushi Co', avatar: g.s.player.avatar });
    await new Promise((r) => setTimeout(r, 50)); // let the stubbed tutorial dialog resolve (clears g.busy)
    const s = g.s;
    s.tutorial = 99;
    for (const d of ['shibuya', 'shinjuku', 'ginza']) if (!s.districts.includes(d)) s.districts.push(d);
    if (!busy) return null;
    const [A, sim, data] = await Promise.all(['/src/core/actions.ts', '/src/core/sim.ts', '/src/core/data.ts'].map((p) => window.__mod(p)));
    s.cash = 1e12;
    s.lifetime.pieces = Math.max(s.lifetime.pieces, 500_000);
    for (const id of Object.keys(data.PROPERTIES)) if (!s.restaurants[id]) { const e = A.buyProperty(s, id); if (e) return `buyProperty ${id}: ${e}`; }
    for (const id of Object.keys(s.restaurants)) for (const u of Object.keys(data.UPGRADES)) while (A.buyUpgrade(s, id, u) === null);
    for (const k of Object.keys(s.inventory)) s.inventory[k] = 5000;
    for (const id of Object.keys(s.restaurants)) for (const role of ['chef', 'server', 'cleaner']) {
      while (sim.staffAt(s, id, role).length < sim.slotsFor(s, id, role)) {
        const c = sim.makeCandidate(s, role); s.candidates.push(c);
        const e = A.hire(s, c.id, id); if (e) return `hire ${role}@${id}: ${e}`;
      }
    }
    return null;
  }, busy);
  if (err) throw new Error(err);
  // Toasts from the setup pile up in the DOM; let them clear so they don't skew FPS.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
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
  for (const k of ['__cpu', '__rnd', '__calls', '__tris']) window[k].length = 0;
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
        gameAvg: mean(gameFps), cpuMs: mean(window.__cpu), renderMs: mean(window.__rnd),
        calls: mean(window.__calls), callsMin: Math.min(...window.__calls), callsMax: Math.max(...window.__calls), tris: mean(window.__tris),
      });
    }
  };
  requestAnimationFrame(step);
}), secs);

async function measure(label, d, time, quality) {
  const moved = await page.evaluate((d) => window.game.district.id !== d, d);
  await travel(d);
  if (moved) warmed = null;
  if (warmed !== d && label === 'busy' && WARM > 0) {
    warmed = d;
    await page.evaluate((m) => { const g = window.game; g.s.minute = m; const sp = g.district.spawn; g.player.teleport(sp.x, sp.z, sp.yaw); }, TIMES.noon);
    for (let t = 0; t < WARM; t += 5) { await page.waitForTimeout(5000); await page.evaluate((m) => { window.game.s.minute = m; }, TIMES.noon); }
  }
  await setQuality(quality);
  await page.evaluate((m) => { const g = window.game; g.s.minute = m; const sp = g.district.spawn; g.player.teleport(sp.x, sp.z, sp.yaw); }, TIMES[time]);
  await page.waitForTimeout(1500); // let NPCs spawn and shaders compile
  await page.evaluate((m) => { window.game.s.minute = m; }, TIMES[time]); // the clock keeps running; re-pin
  const fps = await sampleFps(SECS);
  await gc();
  const st = await stats();
  st.customers = await customers();
  return { label, d, time, quality, ...st, ...fps };
}

const rows = [];
const t0 = Date.now();
for (const state of ['busy', 'fresh']) {
  await newState(state === 'busy');
  for (const quality of state === 'busy' ? ['high', 'medium', 'low'] : ['high']) {
    for (const d of DISTRICTS) for (const time of Object.keys(TIMES)) {
      try { rows.push(await measure(state, d, time, quality)); }
      catch (e) { rows.push({ label: state, d, time, quality, error: String(e.message).split('\n')[0] }); }
      process.stderr.write('.');
    }
  }
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
  ['state', 5, (r) => r.label], ['district', 8, (r) => r.d], ['time', 5, (r) => r.time], ['qual', 4, (r) => r.quality],
  ['pr', 4, (r) => f(r.pr, 2)], ['fps', 5, (r) => f(r.avg, 1)], ['1%low', 5, (r) => f(r.p1, 1)], ['worst', 6, (r) => f(r.worstMs, 0) + 'ms'], ['gFps', 5, (r) => f(r.gameAvg, 0)],
  ['cpuMs', 5, (r) => f(r.cpuMs, 2)], ['rndMs', 5, (r) => f(r.renderMs, 2)],
  ['calls', 5, (r) => f(r.calls)], ['shCal', 5, (r) => r.callsMax - r.callsMin], ['tris', 8, (r) => f(r.tris)], ['geoGPU', 6, (r) => r.geoMem], ['texGPU', 6, (r) => r.texMem], ['progs', 5, (r) => r.programs],
  ['objs', 6, (r) => r.objects], ['meshes', 6, (r) => r.meshes], ['vis', 5, (r) => r.visMeshes], ['inst', 9, (r) => `${r.instanced}/${r.instances}`],
  ['uGeo', 5, (r) => r.uniqGeo], ['uMat', 5, (r) => r.uniqMat], ['lights', 6, (r) => r.lights], ['shdw', 4, (r) => r.shadowLights],
  ['npcs', 4, (r) => r.npcs], ['cust', 4, (r) => r.customers], ['heapMB', 6, (r) => f(r.heapMB, 1)],
];
console.log(cols.map(([h, w]) => pad(h, w)).join(' '));
for (const r of rows) {
  if (r.error) { console.log(`${pad(r.label, 5)} ${pad(r.d, 8)} ${pad(r.time, 5)} ${pad(r.quality, 4)}  ERROR ${r.error}`); continue; }
  console.log(cols.map(([, w, g]) => pad(g(r), w)).join(' '));
}
console.log('  fps/1%low/worst = own rAF timing (uncapped unless --vsync); gFps = game.fpsValue; cpuMs = JS time per game.frame(), rndMs = part of it in post.render (scene + shadow + post passes);');
console.log('  pr = renderer pixel ratio at the end of the sample (dynamic resolution may lower it);');
console.log('  calls/tris = mean per frame incl. post passes; shCal = max-min calls ~ shadow-pass calls (shadows redraw every other frame);');
console.log('  geoGPU/texGPU = live GPU resources; vis = meshes with all ancestors visible;');
console.log('  inst = InstancedMesh objects/instances; uGeo/uMat = unique geometries/materials in the scene graph; shdw = shadow-casting lights.');

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
