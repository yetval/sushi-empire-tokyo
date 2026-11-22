// Run against a running Vite dev server or production preview.
// Usage: node scripts/smoke.mjs [url]
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  args: process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  page.setDefaultTimeout(15_000);
  // block Vite's HMR socket: concurrent source edits must not reload the page mid-test
  await page.addInitScript(() => { window.WebSocket = class { addEventListener() {} removeEventListener() {} send() {} close() {} }; });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const check = async (name, action) => {
    try {
      await action();
      assert.equal(errors.length, 0, errors.join('\n'));
      console.log(`PASS ${name}`);
    } catch (error) {
      throw new Error(`${name} failed${errors.length ? `\n${errors.join('\n')}` : ''}`, { cause: error });
    }
  };
  const standId = 'asakusa_stand';
  const saveKey = 'sushi-empire-tokyo-save';
  const prompt = page.locator('#h-prompt.show');
  const waitForPrompt = (text, timeout = 15_000) => prompt.filter({ hasText: text }).waitFor({ state: 'visible', timeout });
  // Jump to a spot so the scenario doesn't depend on walking routes. Movement is verified separately with real keys.
  const visit = (station) => page.evaluate(({ standId, station }) => {
    const { player, district } = window.game;
    const spot = district.sites.find((site) => site.id === standId)[station];
    player.teleport(spot.x, spot.z, spot.yaw);
  }, { standId, station });
  const sheet = page.locator('.open > .sheet, .sheet.open, .open .sheet').first(); // a closing sheet lingers ~200 ms
  /** Press E at the stand: the restaurant sheet opens on the tab the tutorial asks for. */
  const openStand = async (tab) => {
    await visit('counter');
    await waitForPrompt(/manage/i);
    await page.keyboard.press('e');
    await sheet.waitFor();
    if (tab) await sheet.locator(`.stab.on[data-tab="${tab}"]`).waitFor();
  };
  const closeSheet = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.game.input.enabled);
  };

  await check('keyboard title navigation, company name, and tutorial dialogue', async () => {
    await page.goto(url);
    await page.waitForFunction(() => !!window.game);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.act), 'new');
    await page.keyboard.press('Space');
    await page.locator('#nc-co').waitFor();
    await page.getByRole('button', { name: /settings/i }).click();
    await page.getByRole('checkbox', { name: /invert camera/i }).check();
    await page.getByRole('button', { name: /new game/i }).click();
    await page.locator('#nc-co').fill('Smoke Sushi Co');
    await page.locator('#nc-name').fill('Smoke Owner');
    await page.getByRole('button', { name: /open the stand/i }).click();
    const dialogue = page.locator('.dialog.open');
    await dialogue.getByText('Grandpa Kenji', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.title')), false);
    const lastLine = dialogue.locator('.txt').getByText(/follow the yellow arrow.+press e there to run it\.$/i);
    for (let i = 0; i < 8 && !(await lastLine.isVisible()); i++) await page.keyboard.press('e');
    await lastLine.waitFor();
    await page.keyboard.down('e');
    try {
      await dialogue.waitFor({ state: 'hidden' });
      await page.keyboard.down('e'); // repeat while holding the key used to close the dialogue
    } finally {
      await page.keyboard.up('e');
    }
    await page.waitForFunction(() => window.game.input.enabled);
    assert.equal(await page.evaluate(() => window.game.s.player.company), 'Smoke Sushi Co');
    assert.equal(await page.evaluate(() => window.game.s.player.name), 'Smoke Owner');
    assert.equal(await page.evaluate(() => window.game.cam.invertY), true);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.invertY, saveKey), true);
  });

  await check('WASD moves the owner', async () => {
    const start = await page.evaluate(() => ({ x: window.game.player.pos.x, z: window.game.player.pos.z }));
    await page.keyboard.down('w');
    try {
      await page.waitForFunction(({ x, z }) => {
        const pos = window.game.player.pos;
        return Math.hypot(pos.x - x, pos.z - z) > 0.3;
      }, start);
      assert.equal(await page.locator('.map.open').count(), 0);
    } finally {
      await page.keyboard.up('w');
    }
  });

  await check('E at the stand opens Staff; hiring a chef starts sales on its own', async () => {
    await openStand('staff');
    await page.waitForFunction(() => window.game.s.tutorial === 1);
    assert.equal(await page.evaluate(() => window.game.s.lifetime.customers), 0, 'No chef, no sales');
    await sheet.locator('[data-act="hirebest"][data-arg="chef"]').first().click();
    await page.waitForFunction((id) => window.game.s.staff.some((e) => e.role === 'chef' && e.restaurant === id), standId);
    await closeSheet();
    await page.waitForFunction(() => window.game.s.lifetime.customers > 0, null, { timeout: 90_000 });
    await page.waitForFunction(() => window.game.s.tutorial === 3);
  });

  await check('hiring a server and buying an upgrade advance the tutorial', async () => {
    await page.evaluate(() => { window.game.s.cash += 20_000; }); // skip a few minutes of earning
    await openStand('staff');
    await sheet.locator('[data-act="hirebest"][data-arg="server"]').first().click();
    await page.waitForFunction(() => window.game.s.tutorial === 4);
    await closeSheet();
    await openStand('look');
    await sheet.locator('[data-act="upg"][data-arg="station"]').click();
    await page.waitForFunction((id) => window.game.s.tutorial === 5 && window.game.s.restaurants[id].upgrades.station === 1, standId);
    await closeSheet();
  });

  await check('continue preserves progress and applies title screen settings', async () => {
    // the staffed stand keeps selling while the game runs, so compare against the snapshot written at "save & main menu"
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /save & main menu/i }).click();
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), saveKey);
    await page.getByRole('button', { name: /settings/i }).click();
    await page.getByRole('checkbox', { name: /mute all/i }).check();
    await page.getByRole('button', { name: /continue/i }).click();
    await page.waitForFunction(() => window.game.started);
    const now = await page.evaluate((id) => ({ s: window.game.s, upgrades: window.game.s.restaurants[id].upgrades }), standId);
    assert.deepEqual(now.upgrades, saved.restaurants[standId].upgrades);
    assert.deepEqual(now.s.staff.map((e) => e.id), saved.staff.map((e) => e.id));
    assert.ok(now.s.lifetime.pieces >= saved.lifetime.pieces && now.s.lifetime.pieces > 0);
    assert.equal(await page.evaluate(() => window.game.s.player.company), 'Smoke Sushi Co');
    assert.equal(await page.evaluate(() => window.game.s.settings.muted), true);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.muted, saveKey), true);
  });

  await check('a storage write failure keeps the active game open', async () => {
    await page.keyboard.press('Escape');
    const pause = page.locator('.pause.open');
    await pause.waitFor();
    const storage = await page.evaluateHandle(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
      return { restore() { Storage.prototype.setItem = original; } };
    });
    try {
      await pause.getByRole('button', { name: /save & main menu/i }).click();
      await page.getByText(/the browser could not save your game/i).waitFor();
      assert.ok(await pause.isVisible());
      assert.ok(await page.evaluate(() => window.game.started));
    } finally {
      await storage.evaluate((handle) => handle.restore());
      await storage.dispose();
    }
    await pause.getByRole('button', { name: /resume/i }).click();
    await page.locator('.pause').waitFor({ state: 'detached' });
  });

  await check('a backup-only save is playable and restored to primary storage', async () => {
    await page.keyboard.press('Escape');
    await page.locator('.pause.open').getByRole('button', { name: /save & main menu/i }).click();
    const continueButton = page.getByRole('button', { name: /continue/i });
    await continueButton.waitFor();
    const original = await page.evaluate((saveKey) => {
      const saved = JSON.parse(localStorage.getItem(saveKey));
      saved.lastSaved = Date.now() - 120_000;
      saved.cities.tokyo = { open: true, franchises: 1 };
      localStorage.setItem(`${saveKey}-backup`, JSON.stringify(saved));
      localStorage.removeItem(saveKey);
      return { lastSaved: saved.lastSaved, pieces: saved.lifetime.pieces };
    }, saveKey);
    await page.reload();
    await continueButton.click();
    await page.waitForFunction(() => window.game.started);
    const restored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), saveKey);
    assert.equal(restored.player.company, 'Smoke Sushi Co');
    assert.equal(restored.restaurants[standId].upgrades.station, 1);
    assert.ok(restored.lastSaved > original.lastSaved, 'Continuing an away save should checkpoint it immediately');
    assert.ok(restored.lifetime.pieces > original.pieces, 'The checkpoint should include offline franchise sales');
  });
} finally {
  await browser.close();
}
