// Art/UX QA gallery: drives the real game through window.game and saves 1280x760 screenshots of every
// district (spawn / counter / guest view / wide) at day, dusk and night, plus title, creator, HUD, cooking,
// every management tab, map, shop, pause, and a late-game stand with every upgrade maxed.
// Needs an already running dev server (does NOT start one).
// Usage: node scripts/gallery.mjs [outDir] [url] [filter]
//   outDir default: $TMPDIR/sushi-gallery · url default: http://localhost:5173/ · filter: only shots whose name contains it
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir = join(tmpdir(), 'sushi-gallery'), url = 'http://localhost:5173/', filter = ''] = process.argv.slice(2);
const SETTLE = 1500;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
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
  if (filter && !name.includes(filter)) return;
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
const closeAll = () => ev(() => { while (window.game.ui.closeTop()); });

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
const spots = () => ev(() => {
  const g = window.game, d = g.district;
  const site = d.sites.find((x) => g.s.restaurants[x.id]) ?? d.sites[0];
  return { spawn: d.spawn, counter: site.counter, guest: site.queue[0] ?? site.door, door: site.door, site: site.id };
});

// ------------------------------------------------------------------ title + creator
await page.goto(url, { waitUntil: 'load' });
await wait(() => !!window.game && !!document.querySelector('.title'), null, 60_000);
await shot('01_title');
await shot('02_creator', () => page.click('.title [data-act="new"]'));

// ------------------------------------------------------------------ new game, early HUD, cooking
await ev(() => {
  const g = window.game;
  g.ui.dialog = async () => {}; // skip Kenji's typed intro
  g.ui.hideTitle();
  g.newGame({ name: 'Gallery Chef', company: 'Gallery Sushi Co', avatar: g.s.player.avatar });
  g.s.minute = 12 * 60;
});
await wait(() => window.game.started);
await shot('03_hud_early_spawn');

await shot('04_cooking', async () => {
  await place((await spots()).counter);
  await ev(() => {
    const g = window.game, s = g.s, r = s.restaurants.asakusa_stand;
    for (const k of Object.keys(s.inventory)) s.inventory[k] = 99;
    r.orders.push({ id: 987654, recipe: s.recipes[0], pieces: 2, customerId: null, customerType: 'office', progress: 0, started: false, cook: 'kitchen', quality: 0, createdAt: s.clock, manualOnly: true });
    g.cook('asakusa_stand'); // private, resolves when the minigame closes
  });
  await wait(() => !!document.querySelector('.cook'));
});
await closeAll();
await ev(() => { const r = window.game.s.restaurants.asakusa_stand; r.orders = r.orders.filter((t) => t.id !== 987654); });

// ------------------------------------------------------------------ unlock everything, own a site per district
await ev(async () => {
  const g = window.game, s = g.s, A = await window.__mod('/src/core/actions.ts');
  s.tutorial = 6;
  s.cash = 1e10;
  for (const d of ['asakusa', 'shibuya', 'shinjuku', 'ginza']) if (!s.districts.includes(d)) s.districts.push(d);
  for (const p of ['shibuya_crossing', 'shinjuku_lunch', 'ginza_omakase']) { const err = A.buyProperty(s, p); if (err) console.error(`buyProperty ${p}: ${err}`); }
  g.refreshWorld();
});

// ------------------------------------------------------------------ districts × views × times
const TIMES = [['day', 12 * 60], ['dusk', 18.5 * 60], ['night', 22 * 60]];
let n = 10;
for (const d of ['asakusa', 'shibuya', 'shinjuku', 'ginza']) {
  try { if ((await ev(() => window.game.district.id)) !== d) await travel(d); } catch (e) { failed.push(`travel ${d}`); console.log(`FAIL travel ${d}: ${e.message}`); continue; }
  const sp = await spots();
  for (const [tn, minute] of TIMES) {
    const pre = `${n++}_${d}_${tn}`;
    await shot(`${pre}_a_spawn`, async () => { await setMinute(minute); await place(sp.spawn); });
    await shot(`${pre}_b_counter`, async () => { await setMinute(minute); await place(sp.counter); });
    await shot(`${pre}_c_guest`, async () => { await setMinute(minute); await place(sp.guest, { dist: 5, pitch: 0.2 }); });
    await shot(`${pre}_d_wide`, async () => { await setMinute(minute); await wide(sp); });
  }
}
await ev(() => { window.game.cam.focus = null; });

// ------------------------------------------------------------------ late game: every upgrade at the stand
{
  await travel('asakusa').catch((e) => { failed.push('travel asakusa'); console.log(`FAIL travel asakusa: ${e.message}`); });
  const bought = await ev(async () => {
    const g = window.game, s = g.s, A = await window.__mod('/src/core/actions.ts');
    s.cash = 1e12;
    let n = 0;
    for (const u of ['station', 'fridge', 'extra_station', 'expand', 'seats', 'lanterns', 'plants', 'sign', 'register', 'delivery', 'cleaning'])
      while (!A.buyUpgrade(s, 'asakusa_stand', u)) n++;
    g.refreshWorld();
    return { n, upgrades: s.restaurants.asakusa_stand.upgrades };
  });
  console.log('late-game upgrades bought:', JSON.stringify(bought));
  const sp = await spots();
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

  // ---------------------------------------------------------------- UI panels
  const tabs = await ev(async () => (await window.__mod('/src/ui/manage.ts')).TABS.map((t) => t[0]));
  for (const [i, t] of tabs.entries()) await shot(`7${String(i).padStart(2, "0")}_manage_${t}`, () => ev((t) => window.game.ui.toggleManage(t), t));
  await closeAll();
  await shot('80_map', () => ev(() => window.game.ui.openMap()));
  await closeAll();
  await shot('81_shop', () => ev(() => window.game.ui.openShop()));
  await closeAll();
  await shot('82_pause', () => ev(() => window.game.ui.openPause()));
  await closeAll();
}

console.log(`\n${saved.length} shots saved to ${outDir}${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}`);
const uniq = [...new Set(errors)];
if (uniq.length) console.log(`console errors (${uniq.length} unique):\n` + uniq.slice(0, 20).join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
