// Art/UX QA gallery: drives the real game through window.game and saves 1280x760 screenshots of every
// walkable district (spawn / counter / guest view / wide) at day, dusk and night, plus title, new-game panel, HUD,
// the tutorial's first sheet (E at the stand → Staff) and the first hire,
// a 24-restaurant tycoon empire (every concept, walkable + remote areas): Daichō dashboard, alerts, region/city maps,
// restaurant sheet tabs, buy-lot concept picker, each concept's storefront, a 4× speed street, every management tab,
// metro map, pause, and a late-game stand with every upgrade maxed.
// Needs an already running dev server (does NOT start one).
// Usage: node scripts/gallery.mjs [outDir] [url] [filter]
//   outDir default: ../SellSushi-shots/gallery (next to the repo) · url default: http://localhost:5173/
//   filter: only shots whose name contains it; `--dry` runs every setup step but takes no shots (and no UI actions)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outDir = join(repo, '..', 'SellSushi-shots', 'gallery'), url = 'http://localhost:5173/', filter = ''] = process.argv.slice(2);
const SETTLE = 1500;
const dry = filter === '--dry';
mkdirSync(outDir, { recursive: true });

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
  // Other agents edit files concurrently: block Vite's HMR socket so the page is not reloaded mid-run.
  window.WebSocket = class { constructor() {} addEventListener() {} removeEventListener() {} send() {} close() {} };
  localStorage.clear(); // fresh title screen (no Continue button)
  performance.setResourceTimingBufferSize(10_000);
  // Import a source module as the SAME instance the game uses (Vite may append ?t=... to its URL).
  window.__mod = (path) => {
    const hit = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(hit ?? path);
  };
});

const saved = [], failed = [];
const wait = (fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout, polling: 200 });
const ev = (fn, arg) => page.evaluate(fn, arg);
/** Run setup (optional), let the scene settle, clear toasts, screenshot. A failure skips only this shot. */
async function shot(name, setup) {
  if (dry || (filter && !name.includes(filter))) return;
  const errBefore = errors.length;
  try {
    if (setup) await setup();
    await page.waitForTimeout(SETTLE);
    await ev(() => document.querySelectorAll('.toasts > *').forEach((t) => t.remove()));
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path });
    saved.push(path);
    const errs = errors.slice(errBefore);
    console.log(`ok   ${name}${errs.length ? `  (${errs.length} console errors)` : ''}`);
  } catch (e) {
    failed.push(name);
    console.log(`FAIL ${name}: ${String(e.message ?? e).split('\n')[0].slice(0, 200)}`);
  }
}
// wait out the close animation: toggleManage() right after a close would see Manage as still open and close it
const closeAll = async () => { await ev(() => { while (window.game.ui.closeTop()); }); await page.waitForTimeout(700); };

// Camera helpers (run in page). Player yaw faces (sin, cos); camera behind the player = yaw + PI.
const place = (spot, opts = {}) => ev(({ spot, opts }) => {
  const g = window.game;
  g.cam.focus = null;
  g.player.teleport(spot.x, spot.z, spot.yaw);
  g.cam.yaw = spot.yaw + Math.PI + (opts.yawOff ?? 0);
  g.cam.pitch = opts.pitch ?? 0.32;
  g.cam.dist = opts.dist ?? 7;
  g.cam.snap(g.player.pos);
}, { spot, opts });
/** High wide establishing shot of a site's frontage, from above the street (counter → door direction). */
const wide = (sp) => ev(({ counter, door }) => {
  const g = window.game, V = g.camera.position.constructor;
  const dx = door.x - counter.x, dz = door.z - counter.z, l = Math.hypot(dx, dz) || 1, fx = dx / l, fz = dz / l;
  g.player.teleport(door.x, door.z, Math.atan2(fx, fz)); // outside, so the roof stays visible
  // ponytail: fixed offset/height (focus ignores collision); tune if a district's street layout changes
  g.cam.focus = { pos: new V(door.x + fx * 15 + fz * 6, 18, door.z + fz * 15 - fx * 6), look: new V(counter.x, 1.5, counter.z) };
  g.cam.update(0, g.player.pos, true);
}, sp);
const setMinute = (m) => ev((m) => { window.game.s.minute = m; }, m);
const travel = async (d) => {
  await ev((d) => window.game.travel(d), d);
  await wait((d) => window.game.district.id === d && !window.game.busy && !document.querySelector('.fade-overlay'), d);
};
/** Camera spots for a site in the current district: `prefer` if given, else the first owned one. */
const spots = (prefer = null) => ev((prefer) => {
  const g = window.game, d = g.district;
  const site = d.sites.find((x) => x.id === prefer) ?? d.sites.find((x) => g.s.restaurants[x.id]) ?? d.sites[0];
  return { spawn: d.spawn, counter: site.counter, guest: site.queue[0] ?? site.door, door: site.door, site: site.id };
}, prefer);
/** Click a [data-act] control inside the open UI (works for SVG map stamps too). */
const act = (sel) => ev((sel) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`no element ${sel}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}, sel);

// ------------------------------------------------------------------ title + new-game panel
await page.goto(url, { waitUntil: 'load' });
await wait(() => !!window.game && !!document.querySelector('.title'), null, 60_000);
await shot('01_title');
await shot('02_new_game', () => page.click('.title [data-act="new"]'));

// ------------------------------------------------------------------ new game, early HUD, first sheet, first hire
await ev(() => {
  const g = window.game;
  g.ui.dialog = async () => {}; // skip Kenji's typed intro
  g.ui.hideTitle(); // private in TS, callable at runtime
  g.newGame({ name: 'Gallery Owner', company: 'Gallery Sushi Co', avatar: g.s.player.avatar });
  g.s.minute = 12 * 60;
});
await wait(() => window.game.started);
await shot('03_hud_early_spawn');
await shot('04_sheet_staff_tutorial', async () => {
  await place((await spots('asakusa_stand')).counter);
  await ev(() => window.game.ui.openRestaurant('asakusa_stand', 'staff'));
  await wait(() => !!document.querySelector('.stab.on[data-tab="staff"]'), null, 10_000);
});
await shot('04b_first_hire', async () => {
  await ev(async () => (await window.__mod('/src/core/empire.ts')).hireBest(window.game.s, 'asakusa_stand', 'chef'));
  await closeAll();
  await place((await spots('asakusa_stand')).counter);
  await wait(() => window.game.s.lifetime.customers > 0, null, 90_000).catch(() => {}); // first sale lands with the HUD reacting
});
await closeAll();

// ------------------------------------------------------------------ tycoon empire (recipe: scripts/smoke-sim.mjs "tycoon live")
const emp = await ev(async () => {
  const g = window.game, s = g.s;
  const [data, A] = await Promise.all(['data', 'actions'].map((m) => window.__mod(`/src/core/${m}.ts`)));
  s.tutorial = 6; s.flags.chapter2 = true; s.lifetime.pieces = Math.max(s.lifetime.pieces, 2e9); s.cash = 1e15;
  const errs = [];
  for (const id of Object.keys(data.AREAS)) if (!s.districts.includes(id)) { const e = A.unlockDistrict(s, id); if (e) errs.push(`unlock ${id}: ${e}`); }
  const walk = (p) => data.AREAS[p.district].walkable, owned = () => Object.keys(s.restaurants).length;
  const concepts = data.CONCEPT_IDS.filter((c) => c !== 'stand');
  const buy = (p, first) => {
    if (s.restaurants[p.id]) return false;
    if (p.kind === 'stand') return !A.buyProperty(s, p.id, 'stand');
    for (let k = 0; k < concepts.length; k++) {
      const c = concepts[(first + k) % concepts.length];
      if (!A.conceptAllowed(s, p.id, c) && !A.buyProperty(s, p.id, c)) return true;
    }
    return false;
  };
  const lots = Object.values(data.PROPERTIES);
  // pass 1: one walkable storefront per concept, so the street shots show every format
  for (const [i, c] of concepts.entries()) {
    const p = lots.find((p) => walk(p) && p.kind !== 'stand' && !s.restaurants[p.id] && !A.conceptAllowed(s, p.id, c));
    if (!p || A.buyProperty(s, p.id, c)) errs.push(`no walkable lot for ${c}`);
  }
  // pass 2: alternate remote / walkable lots, round-robin concepts, up to 24
  const W = lots.filter((p) => walk(p) && !s.restaurants[p.id]), R = lots.filter((p) => !walk(p) && !s.restaurants[p.id]);
  for (let i = 0; owned() < 24 && (W.length || R.length); i++) { const p = (i % 2 ? W : R).shift() ?? (W.shift() ?? R.shift()); buy(p, owned()); }
  if (!s.research.includes('ops_center')) s.research.push('ops_center'); // every restaurant managed: auto-hire + auto-price
  (await window.__mod('/src/core/sim.ts')).checkMilestones(s); // fire the pending milestones (and the 1M celebration modal) now, not mid-shot
  g.refreshWorld();
  const R2 = Object.keys(s.restaurants).map((id) => ({ id, c: s.restaurants[id].concept, area: data.PROPERTIES[id].district, walk: walk(data.PROPERTIES[id]) }));
  const byConcept = Object.fromEntries(data.CONCEPT_IDS.map((c) => [c, R2.find((r) => r.c === c && r.walk) ?? null]));
  return {
    n: R2.length, remote: R2.filter((r) => !r.walk).length, concepts: [...new Set(R2.map((r) => r.c))], byConcept, errs,
    walkable: Object.keys(data.AREAS).filter((id) => data.AREAS[id].walkable),
    regions: [...new Set(Object.values(data.AREAS).map((a) => a.region))],
    remoteArea: R2.find((r) => !r.walk)?.area ?? null,
    sheetId: (R2.find((r) => r.walk && r.c === 'kaiten') ?? R2.find((r) => r.c !== 'stand')).id,
    freeLot: lots.find((p) => !s.restaurants[p.id] && p.kind !== 'stand')?.id ?? null,
  };
});
await closeAll(); // dismiss the celebration
console.log(`empire: ${emp.n} restaurants (${emp.remote} remote), concepts ${emp.concepts.join('/')}${emp.errs.length ? `; setup errors: ${emp.errs.join('; ')}` : ''}`);
await shot('05_daicho_alerts', () => ev(() => window.game.ui.toggleManage())); // before applyFix, so the alert rail is populated
await closeAll();
const fixed = await ev(async () => {
  const s = window.game.s, E = await window.__mod('/src/core/empire.ts');
  const before = E.alerts(s).length;
  for (const a of E.alerts(s)) if (a.fix) E.applyFix(s, a);
  window.game.refreshWorld();
  const left = E.alerts(s);
  return `${before} → ${left.length}${left.length ? ` (left: ${left.map((a) => `${a.kind}${a.fix ? '' : ' [no fix]'}`).join(', ')})` : ''}`;
});
console.log(`alerts after applyFix: ${fixed}`);

// ------------------------------------------------------------------ Daichō dashboard, maps, sheet, buy-lot picker
await shot('06_daicho_overview', () => ev(() => window.game.ui.toggleManage()));
/** Region/city shots must not depend on an earlier (possibly filtered-out) shot having opened the Daichō. */
const daicho = async () => {
  if (await ev(() => !document.querySelector('.dc-root'))) await ev(() => window.game.ui.toggleManage('daicho'));
  await wait(() => !!document.querySelector('.dc-root'), null, 10_000);
};
for (const r of emp.regions) await shot(`07_daicho_region_${r}`, async () => { await daicho(); await act('.dc-root [data-act="up"]').catch(() => {}); await act(`.dc-root [data-act="region"][data-arg="${r}"]`); });
for (const a of ['asakusa', emp.remoteArea].filter(Boolean)) await shot(`08_daicho_city_${a}`, async () => {
  const region = await ev(async (a) => (await window.__mod('/src/core/data.ts')).AREAS[a].region, a);
  await daicho();
  await act('.dc-root [data-act="up"]').catch(() => {}); // climb out of the previous city view
  await page.waitForTimeout(300);
  await act(`.dc-root [data-act="region"][data-arg="${region}"]`).catch(() => {});
  await page.waitForTimeout(300);
  await act(`.dc-root [data-act="area"][data-arg="${a}"]`);
});
await closeAll();
const SHEET_TABS = ['overview', 'staff', 'menu', 'books', 'format', 'look']; // src/ui/sheet.ts SheetTab
for (const [i, t] of SHEET_TABS.entries()) await shot(`09_sheet_${i}_${t}`, () => ev(({ id, t }) => window.game.ui.openRestaurant(id, t), { id: emp.sheetId, t }));
await closeAll();
if (emp.freeLot) {
  await shot('09_buylot_picker', () => ev((id) => window.game.ui.openProperty(id), emp.freeLot));
  await shot('09_buylot_picker_omakase', () => act('[data-act="pickc"][data-arg="omakase"]'));
  await closeAll();
}

// ------------------------------------------------------------------ districts × views × times
const TIMES = [['day', 12 * 60], ['dusk', 18.5 * 60], ['night', 22 * 60]];
let n = 10;
for (const d of emp.walkable) {
  try { if ((await ev(() => window.game.district.id)) !== d) await travel(d); } catch (e) { failed.push(`travel ${d}`); console.log(`FAIL travel ${d}: ${e.message}`); continue; }
  const sp = await spots(d === 'asakusa' ? 'asakusa_stand' : null);
  for (const [tn, minute] of TIMES) {
    const pre = `${n++}_${d}_${tn}`;
    await shot(`${pre}_a_spawn`, async () => { await setMinute(minute); await place(sp.spawn); });
    await shot(`${pre}_b_counter`, async () => { await setMinute(minute); await place(sp.counter); });
    await shot(`${pre}_c_guest`, async () => { await setMinute(minute); await place(sp.guest, { dist: 5, pitch: 0.2 }); });
    await shot(`${pre}_d_wide`, async () => { await setMinute(minute); await wide(sp); });
  }
}
await ev(() => { window.game.cam.focus = null; });

// ------------------------------------------------------------------ each concept's storefront in the street
for (const [i, c] of Object.keys(emp.byConcept).entries()) {
  const r = emp.byConcept[c];
  if (!r) { console.log(`skip concept ${c}: no walkable restaurant`); continue; }
  try { if ((await ev(() => window.game.district.id)) !== r.area) await travel(r.area); } catch (e) { failed.push(`travel ${r.area}`); continue; }
  const sp = await spots(r.id);
  await shot(`3${i}_concept_${c}_a_guest`, async () => { await setMinute(12 * 60); await place(sp.guest, { dist: 5, pitch: 0.2 }); });
  await shot(`3${i}_concept_${c}_b_wide`, async () => { await setMinute(12 * 60); await wide(sp); });
  await shot(`3${i}_concept_${c}_c_night`, async () => { await setMinute(21 * 60); await wide(sp); });
}
await ev(() => { window.game.cam.focus = null; });

// ------------------------------------------------------------------ late game: every upgrade at the stand
{
  await travel('asakusa').catch((e) => { failed.push('travel asakusa'); console.log(`FAIL travel asakusa: ${e.message}`); });
  const bought = await ev(async () => {
    const g = window.game, s = g.s, A = await window.__mod('/src/core/actions.ts');
    s.cash = 1e12;
    let n = 0;
    for (const u of Object.keys((await window.__mod('/src/core/data.ts')).UPGRADES))
      while (!A.buyUpgrade(s, 'asakusa_stand', u)) n++;
    g.refreshWorld();
    return { n, upgrades: s.restaurants.asakusa_stand.upgrades };
  });
  console.log('late-game upgrades bought:', JSON.stringify(bought));
  const sp = await spots('asakusa_stand');
  await shot('60_late_day_counter', async () => { await setMinute(12 * 60); await place(sp.counter); });
  await shot('61_late_day_guest', async () => { await setMinute(12 * 60); await place(sp.guest, { dist: 5, pitch: 0.2 }); });
  await shot('62_late_day_wide', async () => { await setMinute(12 * 60); await wide(sp); });
  await shot('63_late_night_wide', async () => { await setMinute(22 * 60); await wide(sp); });
  await shot('64_late_night_guest', async () => { await setMinute(22 * 60); await place(sp.guest, { dist: 5, pitch: 0.2 }); });
  // HUD with live orders at the counter (wait for guests to queue up)
  await shot('65_hud_counter_orders', async () => {
    await setMinute(12.5 * 60); await place(sp.counter);
    await wait(() => window.game.s.restaurants.asakusa_stand.orders.length > 0, null, 20_000).catch(() => {});
  });

  // a street mid-run at 4× time speed (HUD speed control visible)
  await shot('66_speed4x_street', async () => {
    await setMinute(11 * 60); await place(sp.spawn);
    await ev(() => window.game.setSpeed(4));
    await page.waitForTimeout(6000);
  });
  await ev(() => window.game.setSpeed(1));

  // ---------------------------------------------------------------- UI panels
  const tabs = dry ? [] : await ev(async () => (await window.__mod('/src/ui/manage.ts')).TABS.map((t) => t[0]));
  for (const [i, t] of tabs.entries()) await shot(`7${String(i).padStart(2, "0")}_manage_${t}`, () => ev((t) => window.game.ui.toggleManage(t), t));
  await closeAll();
  await shot('80_map', () => ev(() => window.game.ui.openMap()));
  await closeAll();
  await shot('82_pause', () => ev(() => window.game.ui.openPause()));
  await closeAll();
}

console.log(`\n${saved.length} shots saved to ${outDir}${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}`);
const uniq = [...new Set(errors)];
if (uniq.length) console.log(`console errors (${uniq.length} unique):\n` + uniq.slice(0, 20).join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
