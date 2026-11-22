// State-driven end-to-end smoke test: tutorial, staff automation, save/reload, travel, and life after 1M.
// Drives the real game through window.game against an already running dev server (does NOT start one).
// UI-driven checks (title screen, dialogue, sheet clicks) live in scripts/smoke.mjs.
// Usage: node scripts/smoke-sim.mjs [url] [--core-only]   (default http://localhost:5173/)
//   --core-only  run only the tycoon-core checks (pure src/core on a separate state object, no UI/world needed)
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const CORE_ONLY = args.includes('--core-only');
const url = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/';
const SITE = 'asakusa_stand';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`[http ${r.status()}] ${new URL(r.url()).pathname}`); }); // names the module Vite failed to transform
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
async function check(name, fn, { core = false } = {}) {
  if (CORE_ONLY && !core) return;
  const t0 = Date.now(), errBefore = errors.length;
  let detail = '';
  try {
    detail = (await fn()) ?? '';
    if (errors.length > errBefore) throw new Error(errors.slice(errBefore).join(' | '));
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: process.env.STACK ? String(e.stack ?? e).slice(0, 900) : String(e.message ?? e).split("\n")[0].slice(0, 160) });
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const snap = () => page.evaluate(() => {
  const s = window.game.s;
  return { cash: s.cash, pieces: s.lifetime.pieces, customers: s.lifetime.customers, staff: s.staff.length, tutorial: s.tutorial, district: s.player.district };
});

await check('boot: window.game exists', async () => {
  await page.goto(url, { waitUntil: 'load' });
  await wait(() => !!window.game?.s, null, 60_000);
  await page.evaluate(() => localStorage.clear());
}, { core: true });

await check('new game starts the tutorial', async () => {
  await page.evaluate(() => {
    const g = window.game;
    g.ui.dialog = async () => {}; // skip Kenji's typed intro; dialog UI is covered by smoke.mjs
    g.newGame({ name: 'Sim Chef', company: 'Smoke Sushi Co', avatar: g.s.player.avatar });
  });
  await wait(() => window.game.started && window.game.s.tutorial === 0);
  const s = await snap();
  const startCash = await page.evaluate(async () => (await window.__mod('/src/core/state.ts')).createNewState().cash);
  assert(startCash === 7_000, `createNewState().cash is ¥${startCash}, expected ¥7,000`);
  assert(s.cash === startCash && s.pieces === 0, `fresh state wrong (expected ¥${startCash}): ${JSON.stringify(s)}`);
  return `cash ¥${startCash.toLocaleString()}, 0 pieces`;
});

await check('tutorial 0→1: walk to the stand', async () => {
  await page.evaluate((id) => { const g = window.game, c = g.district.sites.find((x) => x.id === id).counter; g.player.teleport(c.x, c.z, c.yaw); }, SITE);
  await wait(() => window.game.s.tutorial >= 1);
});

await check('E at the stand opens the Staff tab', async () => {
  await page.waitForSelector('#h-prompt.show', { timeout: 15_000 });
  await page.keyboard.press('e');
  await page.waitForSelector('.stab.on[data-tab="staff"]', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await wait(() => window.game.input.enabled);
});

await check('tutorial 1→2→3: hire a chef, first sale comes on its own', async () => {
  const err = await page.evaluate(async (id) => (await window.__mod('/src/core/empire.ts')).hireBest(window.game.s, id, 'chef'), SITE);
  assert(err === null, `hireBest chef: ${err}`);
  await wait(() => window.game.s.tutorial >= 2);
  const t0 = Date.now();
  await wait(() => window.game.s.lifetime.customers > 0 && window.game.s.tutorial >= 3, null, 90_000);
  const s = await snap();
  assert(s.pieces > 0, `customer but no pieces: ${JSON.stringify(s)}`);
  return `first sale after ${((Date.now() - t0) / 1000).toFixed(1)} s real time`;
});

await check('sim.understaffed: a chef alone is understaffed until a server joins', async () => {
  const r = await page.evaluate(async (id) => {
    const [sim, E] = await Promise.all([window.__mod('/src/core/sim.ts'), window.__mod('/src/core/empire.ts')]);
    const s = window.game.s;
    const before = { u: sim.understaffed(s, id), alert: E.alerts(s).some((a) => a.id === 'understaffed' && a.restIds.includes(id)) };
    s.cash += 20_000;
    const err = E.hireBest(s, id, 'server');
    return { before, err, after: sim.understaffed(s, id), alertAfter: E.alerts(s).some((a) => a.id === 'understaffed' && a.restIds.includes(id)) };
  }, SITE);
  assert(r.before.u === true, 'stand with only a chef should be understaffed (stand needs a server)');
  assert(r.before.alert, 'no understaffed alert for the chef-only stand');
  assert(r.err === null, `hireBest server: ${r.err}`);
  assert(r.after === false && !r.alertAfter, `still understaffed after hiring a server: ${JSON.stringify(r)}`);
  await wait(() => window.game.s.tutorial >= 4);
});

await check('tutorial 4→5→99: buy an upgrade, buy a second lot', async () => {
  const err = await page.evaluate(async (id) => (await window.__mod('/src/core/actions.ts')).buyUpgrade(window.game.s, id, 'lanterns'), SITE);
  assert(err === null, `buyUpgrade failed: ${err}`);
  await wait(() => window.game.s.tutorial >= 5);
  const lot = await page.evaluate(async () => {
    const [A, data] = await Promise.all([window.__mod('/src/core/actions.ts'), window.__mod('/src/core/data.ts')]);
    const s = window.game.s;
    const p = Object.values(data.PROPERTIES).find((x) => !s.restaurants[x.id] && s.districts.includes(x.district) && x.kind !== 'stand');
    s.cash += p.price + A.fitoutCost(p.id, 'bar') + 1;
    const e = A.buyProperty(s, p.id, 'bar');
    window.game.refreshWorld();
    return e ? `ERR ${e}` : p.id;
  });
  assert(!lot.startsWith('ERR'), lot);
  await wait(() => window.game.s.tutorial === 99, null, 10_000)
    .catch(async () => { throw new Error(`tutorial stuck at ${await page.evaluate(() => window.game.s.tutorial)}, expected 99 (done)`); });
  return `second lot ${lot}`;
});

await check('staff automation: the stand sells while the owner is away', async () => {
  const before = await snap();
  await page.evaluate(() => { const sp = window.game.district.spawn; window.game.player.teleport(sp.x, sp.z, sp.yaw); window.game.s.minute = 12 * 60; });
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
  await wait(() => !!window.game?.s, null, 60_000);
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
  await wait(() => !!window.game?.s, null, 60_000);
  await page.evaluate(() => { window.__million = 0; window.game.ui.celebrateMillion = () => { window.__million++; }; window.game.continueGame(); });
  await wait(() => window.game.started);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ idx: window.game.s.milestoneIndex, million: window.__million, title: window.game.s.player.title }));
  assert(after.idx === before.idx && after.million === 0, `milestones re-fired: ${JSON.stringify(after)}`);
  return `milestoneIndex ${after.idx}, title ${after.title}`;
});

// ---------------------------------------------------------------- tycoon core (src/core only, separate state `T`)
// These never touch window.game.s, so they're valid before the tycoon UI/world is integrated (--core-only).
await page.evaluate(async () => {
  const [state, data, A, sim, E] = await Promise.all(['state', 'data', 'actions', 'sim', 'empire'].map((m) => window.__mod(`/src/core/${m}.ts`)));
  window.__T = { state, data, A, sim, E };
  // every non-finite number in an object tree, by path
  window.__badNums = (o, path = '', out = []) => {
    if (typeof o === 'number') { if (!Number.isFinite(o)) out.push(`${path}=${o}`); }
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) window.__badNums(v, path ? `${path}.${k}` : k, out);
    return out;
  };
  window.__rich = () => { const T = state.createNewState('Tycoon', 'Smoke Holdings'); T.flags.chapter2 = true; T.lifetime.pieces = 2e9; T.cash = 1e15; return T; };

  // The bus is shared with the live game, whose listeners read game.s. Run each core check with game.s pointed at
  // the test state so those listeners see consistent data (and get exercised), then restore the real state.
  window.__with = (fn) => { const g = window.game, real = g.s; if (window.__TT) g.s = window.__TT; try { return fn(); } finally { g.s = real; } };
});
const core = (fn) => page.evaluate(`window.__with(${fn.toString()})`);

await check('tycoon: unlockDistrict opens every area, incl. remote & chapter 2', async () => {
  return core(() => {
    const { data, A } = window.__T, T = window.__rich();
    const ids = Object.keys(data.AREAS), errs = [];
    for (const id of ids) if (!T.districts.includes(id)) { const e = A.unlockDistrict(T, id); if (e) errs.push(`${id}: ${e}`); }
    if (errs.length) throw new Error(errs.join('; '));
    const remote = ids.filter((id) => !data.AREAS[id].walkable);
    if (!remote.length) throw new Error('no remote (management-only) areas defined');
    // gating: a fresh player can't open a chapter-2 area
    const fresh = window.__T.state.createNewState(); fresh.cash = 1e15;
    const ch2 = ids.find((id) => data.AREAS[id].unlock.chapter2);
    if (ch2 && A.unlockDistrict(fresh, ch2) === null) throw new Error(`${ch2} unlocked without chapter 2`);
    window.__TT = T;
    return `${ids.length} areas (${remote.length} remote)`;
  });
}, { core: true });

await check('tycoon: buyProperty with every concept, gated by pieces', async () => {
  return core(() => {
    const { data, A } = window.__T, T = window.__TT, out = [];
    for (const c of data.CONCEPT_IDS) {
      const lot = Object.values(data.PROPERTIES).find((p) => !T.restaurants[p.id] && T.districts.includes(p.district) && (p.kind === 'stand') === (c === 'stand'));
      if (!lot && c === 'stand' && T.restaurants.asakusa_stand?.concept === 'stand') { out.push('stand (starter)'); continue; } // the only stand lot is owned from the start
      if (!lot) throw new Error(`no free lot for ${c}`);
      const cash = T.cash, want = lot.price + A.fitoutCost(lot.id, c);
      const e = A.buyProperty(T, lot.id, c);
      if (e) throw new Error(`${c} @ ${lot.id}: ${e}`);
      if (T.restaurants[lot.id].concept !== c) throw new Error(`${lot.id} concept ${T.restaurants[lot.id].concept} ≠ ${c}`);
      if (Math.abs(cash - T.cash - want) > 1e-6) throw new Error(`${c}: charged ${cash - T.cash}, expected ${want}`);
      out.push(`${c}→${lot.id}`);
    }
    const fresh = window.__T.state.createNewState(); fresh.cash = 1e15; fresh.districts = Object.keys(data.AREAS);
    const gated = data.CONCEPT_IDS.find((c) => data.CONCEPTS[c].unlockPieces > 0);
    const lot = Object.values(data.PROPERTIES).find((p) => p.kind !== 'stand' && !fresh.restaurants[p.id]);
    if (gated && A.buyProperty(fresh, lot.id, gated) === null) throw new Error(`${gated} bought at 0 pieces`);
    return out.join(', ');
  });
}, { core: true });

await check('tycoon: setConcept converts and charges the fit-out', async () => {
  return core(() => {
    const { A } = window.__T, T = window.__TT;
    const id = Object.keys(T.restaurants).find((k) => T.restaurants[k].concept === 'bar');
    const cash = T.cash, fee = A.fitoutCost(id, 'kaiten');
    const e = A.setConcept(T, id, 'kaiten');
    if (e) throw new Error(e);
    if (T.restaurants[id].concept !== 'kaiten' || Math.abs(cash - T.cash - fee) > 1e-6) throw new Error(`concept ${T.restaurants[id].concept}, charged ${cash - T.cash} vs ${fee}`);
    if (A.setConcept(T, id, 'kaiten') === null) throw new Error('converting to the same concept succeeded');
    return `${id}: bar → kaiten for ¥${Math.round(fee).toLocaleString()}`;
  });
}, { core: true });

await check('tycoon: empire alerts + applyFix staffs unstaffed restaurants', async () => {
  return core(() => {
    const { E, sim } = window.__T, T = window.__TT;
    const before = E.alerts(T);
    const hire = before.find((a) => a.fix?.id === 'hireMissing');
    if (!hire) throw new Error(`no hireMissing alert among: ${before.map((a) => a.kind).join(', ') || '(none)'}`);
    if (hire.severity !== 'critical') throw new Error(`hireMissing severity ${hire.severity}`);
    const staff0 = T.staff.length;
    const e = E.applyFix(T, hire);
    if (e) throw new Error(`applyFix: ${e}`);
    const unstaffed = hire.restIds.filter((id) => !sim.isAutomated(T, id));
    if (unstaffed.length) throw new Error(`still not automated: ${unstaffed.join(', ')}`);
    const stillHire = E.alerts(T).some((a) => a.fix?.id === 'hireMissing');
    if (stillHire) throw new Error('hireMissing alert remains after the fix');
    return `${before.length} alerts; fixed ${hire.restIds.length} restaurants (+${T.staff.length - staff0} staff)`;
  });
}, { core: true });

await check('tycoon: only managed restaurants auto-hire (manager or ops_center)', async () => {
  return core(() => {
    const { data, A, E, sim } = window.__T, T = window.__TT;
    const nextHour = () => { T.minute = ((Math.floor(T.minute / 60) + 1) % 24) * 60 + 1; E.tickEmpire(T); };
    const kpi = (id) => E.restaurantKPIs(T).find((k) => k.id === id);
    T.research = T.research.filter((r) => r !== 'ops_center');
    const lot = Object.values(data.PROPERTIES).find((p) => !T.restaurants[p.id] && T.districts.includes(p.district) && p.kind !== 'stand');
    if (A.buyProperty(T, lot.id, 'bar')) throw new Error('could not buy test lot');
    for (let h = 0; h < 3; h++) nextHour();
    if (sim.isAutomated(T, lot.id)) throw new Error('an unmanaged restaurant hired staff on its own');
    if (kpi(lot.id).managed) throw new Error('KPI says managed without manager or ops_center');
    if (kpi(lot.id).health !== 'bad') throw new Error(`crewless restaurant health ${kpi(lot.id).health}, expected bad`);
    const e = E.hireBest(T, lot.id, 'manager', true);
    if (e) throw new Error(`hire manager: ${e}`);
    if (!kpi(lot.id).managed) throw new Error('KPI not managed after hiring a manager');
    for (let h = 0; h < 3 && !sim.isAutomated(T, lot.id); h++) nextHour();
    if (!sim.isAutomated(T, lot.id)) throw new Error(`manager did not auto-hire a chef at ${lot.id}; log: ${T.restaurants[lot.id].log.join(' / ')}`);
    // ops_center: every restaurant runs as managed
    const lot2 = Object.values(data.PROPERTIES).find((p) => !T.restaurants[p.id] && T.districts.includes(p.district) && p.kind !== 'stand');
    if (A.buyProperty(T, lot2.id, 'bar')) throw new Error('could not buy second test lot');
    T.research.push('ops_center');
    if (!kpi(lot2.id).managed) throw new Error('ops_center did not mark the restaurant managed');
    for (let h = 0; h < 3 && !sim.isAutomated(T, lot2.id); h++) nextHour();
    if (!sim.isAutomated(T, lot2.id)) throw new Error(`ops_center did not auto-hire at ${lot2.id}`);
    return `${lot.id}: ${T.restaurants[lot.id].log.join(' / ')}; ${lot2.id} via ops_center`;
  });
}, { core: true });

await check('tycoon: 40-restaurant empire runs 2 days with finite KPIs', async () => {
  return core(() => {
    const { data, A, E, sim } = window.__T, T = window.__TT;
    const concepts = data.CONCEPT_IDS.filter((c) => c !== 'stand');
    for (const p of Object.values(data.PROPERTIES)) {
      if (Object.keys(T.restaurants).length >= 40) break;
      if (T.restaurants[p.id] || !T.districts.includes(p.district)) continue;
      A.buyProperty(T, p.id, p.kind === 'stand' ? 'stand' : concepts[Object.keys(T.restaurants).length % concepts.length]);
    }
    const n = Object.keys(T.restaurants).length;
    if (n < 40) throw new Error(`only ${n} lots available`);
    if (!T.research.includes('ops_center')) T.research.push('ops_center');
    for (const a of E.alerts(T)) if (a.fix) E.applyFix(T, a);
    const p0 = T.lifetime.pieces, day0 = T.day;
    for (let t = 0; t < 2 * data.DAY_SECONDS * 2 && T.day < day0 + 2; t++) { sim.tick(T, 0.5, { activeDistrict: null }); E.tickEmpire(T); }
    const kpis = E.restaurantKPIs(T);
    const bad = [...window.__badNums(kpis, 'kpi'), ...window.__badNums(E.empireTotals(T), 'totals'), ...window.__badNums({ cash: T.cash, lifetime: T.lifetime }, 's')];
    const odd = kpis.filter((k) => !['good', 'warn', 'bad'].includes(k.health) || k.managed !== true);
    if (odd.length) throw new Error(`KPI health/managed wrong: ${odd.slice(0, 3).map((k) => `${k.id}:${k.health}/${k.managed}`).join(', ')}`);
    if (bad.length) throw new Error(`non-finite: ${bad.slice(0, 6).join(', ')}`);
    if (T.lifetime.pieces <= p0) throw new Error('empire sold nothing in 2 days');
    const tot = E.empireTotals(T);
    return `${n} restaurants, ${tot.staff} staff, ${tot.areas} areas, +${Math.round(T.lifetime.pieces - p0).toLocaleString()} pieces in ${T.day - day0} days`;
  });
}, { core: true });

// ---------------------------------------------------------------- tycoon live (needs the integrated tycoon UI/world)
await check('tycoon live: 20+ restaurant empire at 4× speed keeps selling', async () => {
  const r = await page.evaluate(async () => {
    const g = window.game, s = g.s, { data, A, E } = window.__T;
    s.flags.chapter2 = true; s.lifetime.pieces = Math.max(s.lifetime.pieces, 2e9); s.cash = 1e15; if (!s.research.includes('ops_center')) s.research.push('ops_center');
    for (const id of Object.keys(data.AREAS)) if (!s.districts.includes(id)) A.unlockDistrict(s, id);
    const concepts = data.CONCEPT_IDS.filter((c) => c !== 'stand');
    for (const p of Object.values(data.PROPERTIES)) {
      if (Object.keys(s.restaurants).length >= 24) break;
      if (!s.restaurants[p.id]) A.buyProperty(s, p.id, p.kind === 'stand' ? 'stand' : concepts[Object.keys(s.restaurants).length % concepts.length]);
    }
    for (const a of E.alerts(s)) if (a.fix) E.applyFix(s, a);
    g.refreshWorld(); g.setSpeed(4); s.minute = 11 * 60;
    return { n: Object.keys(s.restaurants).length, remote: Object.keys(s.restaurants).filter((id) => !data.AREAS[data.PROPERTIES[id].district].walkable).length, pieces: s.lifetime.pieces, clock: s.clock };
  });
  await page.waitForTimeout(15_000);
  const after = await page.evaluate(() => {
    const g = window.game, s = g.s, { E } = window.__T;
    return { pieces: s.lifetime.pieces, clock: s.clock, bad: window.__badNums({ k: E.restaurantKPIs(s), t: E.empireTotals(s), cash: s.cash }) };
  });
  assert(after.clock - r.clock > 40, `4× speed: only ${(after.clock - r.clock).toFixed(1)} game-s in 15 real s`);
  assert(after.pieces > r.pieces, 'empire sold nothing at 4×');
  assert(!after.bad.length, `non-finite: ${after.bad.slice(0, 6).join(', ')}`);
  await page.evaluate(() => window.game.setSpeed(1));
  return `${r.n} restaurants (${r.remote} remote), +${Math.round(after.pieces - r.pieces).toLocaleString()} pieces, ${(after.clock - r.clock).toFixed(0)} game-s in 15 s`;
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
