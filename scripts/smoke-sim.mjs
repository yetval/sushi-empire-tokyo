// State-driven end-to-end smoke test: tutorial, staff automation, save/reload, travel, and life after 1M.
// Drives the real game through window.game against an already running dev server (does NOT start one).
// UI-driven checks (title screen, cooking minigame clicks) live in scripts/smoke.mjs.
// Usage: node scripts/smoke-sim.mjs [url]   (default http://localhost:5173/)
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const SITE = 'asakusa_stand';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => {
  // Other agents edit files concurrently: block Vite's HMR socket so the page is not reloaded mid-test.
  window.WebSocket = class { constructor() {} addEventListener() {} removeEventListener() {} send() {} close() {} };
  performance.setResourceTimingBufferSize(10_000);
  // Import a source module as the SAME instance the game uses (Vite may append ?t=... to its URL).
  window.__mod = (path) => {
    const hit = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(hit ?? path);
  };
});

const wait = (fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const results = [];
async function check(name, fn) {
  const t0 = Date.now(), errBefore = errors.length;
  let detail = '';
  try {
    detail = (await fn()) ?? '';
    if (errors.length > errBefore) throw new Error(errors.slice(errBefore).join(' | '));
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message ?? e).split('\n')[0].slice(0, 160) });
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const snap = () => page.evaluate(() => {
  const s = window.game.s;
  return { cash: s.cash, pieces: s.lifetime.pieces, customers: s.lifetime.customers, staff: s.staff.length, tutorial: s.tutorial, district: s.player.district };
});

await check('boot: window.game exists', async () => {
  await page.goto(url, { waitUntil: 'load' });
  await wait(() => !!window.game, null, 60_000);
  await page.evaluate(() => localStorage.clear());
});

await check('new game starts the tutorial', async () => {
  await page.evaluate(() => {
    const g = window.game;
    g.ui.dialog = async () => {}; // skip Kenji's typed intro; dialog UI is covered by smoke.mjs
    g.newGame({ name: 'Sim Chef', company: 'Smoke Sushi Co', avatar: g.s.player.avatar });
  });
  await wait(() => window.game.started && window.game.s.tutorial === 0);
  const s = await snap();
  assert(s.cash === 5000 && s.pieces === 0, `fresh state wrong: ${JSON.stringify(s)}`);
  return 'cash ¥5,000, 0 pieces';
});

await check('tutorial 0→1: walk to the stand', async () => {
  await page.evaluate((id) => { const g = window.game, c = g.district.sites.find((x) => x.id === id).counter; g.player.teleport(c.x, c.z, c.yaw); }, SITE);
  await wait(() => window.game.s.tutorial >= 1);
});

await check('tutorial 1→2: take the first order', async () => {
  await wait((id) => (window.game.npcs.counterPrompt(window.game.s, id) ?? '').startsWith('Take order'), SITE, 45_000);
  await page.evaluate((id) => window.game.counterAct(id), SITE);
  await wait(() => window.game.s.tutorial >= 2);
  const t = await page.evaluate((id) => window.game.s.restaurants[id].orders[0], SITE);
  assert(t, 'no ticket after taking the order');
  return `${t.pieces}× ${t.recipe}`;
});

await check('tutorial 2→3: cook (minigame stubbed to a perfect score)', async () => {
  const before = await page.evaluate(() => ({ ...window.game.s.inventory }));
  await page.evaluate(async (id) => {
    const g = window.game;
    const real = g.ui.openCooking;
    g.ui.openCooking = async () => 1;
    try { await g.cook(id); } finally { g.ui.openCooking = real; }
  }, SITE);
  await wait(() => window.game.s.tutorial >= 3);
  const after = await page.evaluate(() => ({ ...window.game.s.inventory }));
  assert(after.rice < before.rice, `rice not consumed (${before.rice} → ${after.rice})`);
  assert(Object.values(after).every((n) => n >= 0), 'negative inventory');
  return `rice ${before.rice} → ${after.rice}`;
});

await check('tutorial 3→4: serve and get paid', async () => {
  const before = await snap();
  await wait((id) => (window.game.npcs.counterPrompt(window.game.s, id) ?? '').startsWith('Serve'), SITE, 20_000);
  await page.evaluate((id) => window.game.counterAct(id), SITE);
  await wait(() => window.game.s.tutorial >= 4);
  const after = await snap();
  assert(after.pieces > 0 && after.cash > before.cash, `no sale: ${JSON.stringify(after)}`);
  return `+${after.pieces} pieces, cash ${before.cash} → ${Math.round(after.cash)}`;
});

await check('tutorial 4→5→99: buy ingredients, buy an upgrade', async () => {
  await page.evaluate(async () => { const sim = await window.__mod('/src/core/sim.ts'); sim.buyIngredient(window.game.s, 'salmon', 10); });
  await wait(() => window.game.s.tutorial >= 5);
  const err = await page.evaluate(async (id) => (await window.__mod('/src/core/actions.ts')).buyUpgrade(window.game.s, id, 'lanterns'), SITE);
  assert(err === null, `buyUpgrade failed: ${err}`);
  await wait(() => window.game.s.tutorial === 99, null, 10_000)
    .catch(async () => { throw new Error(`tutorial stuck at ${await page.evaluate(() => window.game.s.tutorial)}, expected 99 (done)`); });
});

await check('staff automation: chef + server sell on their own', async () => {
  const err = await page.evaluate(async (id) => {
    const g = window.game, s = g.s;
    const [A, sim] = await Promise.all([window.__mod('/src/core/actions.ts'), window.__mod('/src/core/sim.ts')]);
    s.lifetime.pieces = Math.max(s.lifetime.pieces, 60); // roles unlock at 50 pieces
    s.cash += 100_000;
    s.minute = 12 * 60; // lunch: open and busy
    for (const k of ['rice', 'nori', 'cucumber', 'salmon', 'tuna']) sim.buyIngredient(s, k, 120);
    for (const role of ['chef', 'server']) {
      let c = s.candidates.find((e) => e.role === role);
      if (!c) { c = sim.makeCandidate(s, role); s.candidates.push(c); }
      const e = A.hire(s, c.id, id);
      if (e) return `${role}: ${e}`;
    }
    return sim.isAutomated(s, id) ? null : 'not automated after hiring';
  }, SITE);
  assert(err === null, err);
  const before = await snap();
  // The player stands far away and does nothing: only staff can sell now.
  await page.evaluate(() => { const sp = window.game.district.spawn; window.game.player.teleport(sp.x, sp.z, sp.yaw); });
  await wait((p) => window.game.s.lifetime.pieces > p, before.pieces, 90_000);
  const after = await snap();
  return `pieces ${before.pieces} → ${after.pieces} with ${after.staff} staff`;
});

await check('save → reload → continue keeps progress', async () => {
  const before = await page.evaluate(() => {
    const g = window.game; g.setPaused(true); g.save();
    const s = g.s; return { cash: s.cash, pieces: s.lifetime.pieces, staff: s.staff.length, upgrades: { ...s.restaurants.asakusa_stand.upgrades } };
  });
  await page.reload({ waitUntil: 'load' });
  await wait(() => !!window.game, null, 60_000);
  assert(await page.evaluate(() => window.game.hasSave()), 'hasSave() false after reload');
  await page.evaluate(() => window.game.continueGame());
  await wait(() => window.game.started);
  const after = await page.evaluate(() => {
    const s = window.game.s; return { cash: s.cash, pieces: s.lifetime.pieces, staff: s.staff.length, upgrades: { ...s.restaurants.asakusa_stand.upgrades } };
  });
  assert(JSON.stringify(after) === JSON.stringify(before), `changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  return `cash ${Math.round(after.cash)}, ${after.pieces} pieces, ${after.staff} staff`;
});

await check('travel to Shibuya after unlocking it', async () => {
  await page.evaluate(() => { const g = window.game; if (!g.s.districts.includes('shibuya')) g.s.districts.push('shibuya'); g.travel('shibuya'); });
  await wait(() => window.game.district.id === 'shibuya' && window.game.s.player.district === 'shibuya' && !document.querySelector('.fade-overlay'), null, 15_000);
  const sites = await page.evaluate(() => window.game.district.sites.map((x) => x.id));
  return `sites: ${sites.join(', ') || '(none)'}`;
});

await check('1,000,000 pieces: celebration, game keeps going', async () => {
  await page.evaluate(async () => {
    const g = window.game, s = g.s;
    const sim = await window.__mod('/src/core/sim.ts');
    window.__celebrations = 0;
    const real = g.ui.celebrateMillion.bind(g.ui);
    g.ui.celebrateMillion = () => { window.__celebrations++; real(); };
    s.minute = 12 * 60;
    for (const k of ['rice', 'nori', 'cucumber', 'salmon', 'tuna']) s.inventory[k] += 200;
    s.lifetime.pieces = 999_990;
    sim.addPieces(s, 10); // crosses 1M through the real milestone path (cascades earlier milestones)
  });
  const at = await page.evaluate(() => {
    const s = window.game.s;
    return { celebrations: window.__celebrations, chapter2: !!s.flags.chapter2, title: s.player.title, pieces: s.lifetime.pieces, next: window.game.s.milestoneIndex, started: window.game.started, clock: s.clock };
  });
  assert(at.celebrations === 1, `celebrateMillion called ${at.celebrations}×`);
  assert(at.chapter2 && at.title === 'Sushi Emperor', `chapter2=${at.chapter2} title=${at.title}`);
  assert(at.started, 'game stopped after 1M');
  const blocking = await page.evaluate(() => window.game.ui.isBlocking());
  assert(blocking, 'celebration modal not shown (ui.isBlocking() false)');
  // The sim must keep ticking under the modal, then the player dismisses it and keeps playing.
  await wait((c) => window.game.s.clock > c + 1, at.clock, 10_000);
  await page.evaluate(() => { while (window.game.ui.isBlocking()) if (!window.game.ui.closeTop()) break; });
  await wait((p) => window.game.s.lifetime.pieces > p, at.pieces, 90_000);
  const after = await page.evaluate(() => ({ pieces: window.game.s.lifetime.pieces, cash: window.game.s.cash, next: (window.game.s.milestoneIndex) }));
  assert(Number.isFinite(after.cash), 'cash is not finite');
  return `pieces ${at.pieces.toLocaleString()} → ${after.pieces.toLocaleString()}, still playing`;
});

await check('milestones repeat no rewards after reload past 1M', async () => {
  const before = await page.evaluate(() => { const g = window.game; g.setPaused(true); g.save(); return { idx: g.s.milestoneIndex, cash: g.s.cash }; });
  await page.reload({ waitUntil: 'load' });
  await wait(() => !!window.game, null, 60_000);
  await page.evaluate(() => { window.__million = 0; window.game.ui.celebrateMillion = () => { window.__million++; }; window.game.continueGame(); });
  await wait(() => window.game.started);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ idx: window.game.s.milestoneIndex, million: window.__million, title: window.game.s.player.title }));
  assert(after.idx === before.idx && after.million === 0, `milestones re-fired: ${JSON.stringify(after)}`);
  return `milestoneIndex ${after.idx}, title ${after.title}`;
});

await browser.close();

const pad = (s, n) => String(s).padEnd(n);
const w = Math.max(...results.map((r) => r.name.length));
console.log(`\n${pad('RESULT', 6)}  ${pad('CHECK', w)}  ${pad('TIME', 7)}  DETAIL`);
for (const r of results) console.log(`${pad(r.ok ? 'PASS' : 'FAIL', 6)}  ${pad(r.name, w)}  ${pad((r.ms / 1000).toFixed(1) + 's', 7)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (errors.length) console.log(`console/page errors:\n  ${errors.slice(0, 20).join('\n  ')}`);
process.exit(failed ? 1 : 0);
