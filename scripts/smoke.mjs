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
  // Jump between stations so the same scenario runs against different district layouts.
  // Movement is verified separately with the real keyboard input.
  const visit = (station) => page.evaluate(({ standId, station }) => {
    const { player, district } = window.game;
    const spot = station === 'supplier' ? district.supplier : district.sites.find((site) => site.id === standId)[station];
    player.teleport(spot.x, spot.z, spot.yaw);
  }, { standId, station });

  await check('keyboard title navigation, character creation, and tutorial dialogue', async () => {
    await page.goto(url);
    await page.waitForFunction(() => !!window.game);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.act), 'new');
    await page.keyboard.press('Space');
    await page.locator('#cr-name').waitFor();
    await page.getByRole('button', { name: /settings/i }).click();
    await page.getByRole('checkbox', { name: /invert camera/i }).check();
    await page.getByRole('button', { name: /new game/i }).click();
    await page.locator('#cr-name').fill('Smoke Chef');
    await page.getByRole('button', { name: /open the stand/i }).click();
    const dialogue = page.locator('.dialog.open');
    await dialogue.getByText('Grandpa Kenji', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.title')), false);
    const finalPrompt = dialogue.locator('.more').filter({ hasText: 'click / E ✓' });
    for (let i = 0; i < 6 && !(await finalPrompt.isVisible()); i++) {
      await page.keyboard.press('e');
    }
    await dialogue.locator('.txt').getByText(/follow the yellow arrow.+back of the counter\.$/i).waitFor();
    await page.keyboard.down('e');
    try {
      await dialogue.waitFor({ state: 'hidden' });
      await page.keyboard.down('e'); // repeat while holding the key used to close the dialogue
    } finally {
      await page.keyboard.up('e');
    }
    await page.waitForFunction(() => window.game.input.enabled);
    assert.equal(await page.evaluate(() => window.game.s.player.name), 'Smoke Chef');
    assert.equal(await page.evaluate(() => window.game.cam.invertY), true);
    assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.invertY, saveKey), true);
  });

  await check('WASD moves the chef', async () => {
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

  await check('first customer order reaches the prep station', async () => {
    await visit('counter');
    await waitForPrompt(/take order/i, 90_000);
    await page.keyboard.press('e');
    await page.waitForFunction((id) => window.game.s.restaurants[id].orders.length > 0, standId);
    await visit('prep');
    await waitForPrompt(/make \d/i);
    await page.keyboard.press('e');
    await page.locator('.cook.open').waitFor();
  });

  await check('manual cooking and serving settle the order', async () => {
    const cook = page.locator('.cook.open');
    const ticket = await page.evaluate((id) => window.game.s.restaurants[id].orders[0], standId);
    const cash = await page.evaluate(() => window.game.s.cash);
    assert.equal(ticket.recipe, 'salmon_nigiri', 'The fresh-save tutorial orders salmon nigiri');
    const instruction = (text) => cook.locator('.cook-instr').filter({ hasText: text }).waitFor();
    await instruction(/shape the rice/i);
    for (const key of ['w', 'd', 's', 'a', 'w', 'd', 's', 'a', 'w']) await page.keyboard.press(key);
    await instruction(/slice the fish/i);
    await page.keyboard.press('Space');
    await cook.locator('.ck-chips .next').filter({ hasText: /cut 2/i }).waitFor();
    // The knife is still animating the first cut when the second marker appears.
    await page.waitForTimeout(450);
    await page.keyboard.press('Space');
    await instruction(/place the topping/i);
    await page.keyboard.press('Space');
    await instruction(/order ready/i);
    await cook.waitFor({ state: 'hidden' });
    await visit('counter');
    await waitForPrompt(/serve 1 order/i);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.game.s.lifetime.customers === 1);
    const result = await page.evaluate(() => ({ cash: window.game.s.cash, ...window.game.s.lifetime }));
    assert.equal(result.pieces, ticket.pieces);
    assert.equal(result.manualOrders, 1);
    assert.ok(result.cash > cash, 'Serving should increase cash');
  });

  await check('supplier purchases and restaurant upgrades advance the tutorial', async () => {
    await visit('supplier');
    await waitForPrompt(/buy ingredients/i);
    await page.keyboard.press('e');
    const shop = page.locator('.shop.open');
    const before = await page.evaluate(() => ({ cash: window.game.s.cash, spent: window.game.s.lifetime.expenses, rice: window.game.s.inventory.rice }));
    await shop.locator('[data-arg="rice:10"]').click();
    const after = await page.evaluate(() => ({ cash: window.game.s.cash, spent: window.game.s.lifetime.expenses, rice: window.game.s.inventory.rice }));
    assert.equal(after.rice, before.rice + 10);
    assert.ok(after.spent > before.spent, 'Restocking should charge cash'); // cash can rise mid-test from an award
    await page.waitForFunction(() => window.game.s.tutorial === 5);
    await shop.getByRole('button', { name: 'Close' }).click();
    await page.waitForFunction(() => window.game.input.enabled);
    await page.keyboard.press('Tab');
    const management = page.locator('.manage.open');
    await management.locator('[data-act="upg"][data-arg="station"]').click();
    await page.waitForFunction((id) => window.game.s.tutorial >= 6 && window.game.s.restaurants[id].upgrades.station === 1, standId);
    await management.getByRole('button', { name: 'Close' }).click();
  });

  await check('continue preserves progress and applies title screen settings', async () => {
    const progress = () => page.evaluate((id) => {
      const { lifetime, inventory, cash, restaurants } = window.game.s;
      return { lifetime, inventory, cash, upgrades: restaurants[id].upgrades };
    }, standId);
    const before = await progress();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /save & main menu/i }).click();
    await page.getByRole('button', { name: /settings/i }).click();
    await page.getByRole('checkbox', { name: /mute all/i }).check();
    await page.getByRole('button', { name: /continue/i }).click();
    await page.waitForFunction(() => window.game.started);
    assert.deepEqual(await progress(), before);
    assert.equal(await page.evaluate(() => window.game.s.player.name), 'Smoke Chef');
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
    assert.equal(restored.player.name, 'Smoke Chef');
    assert.equal(restored.restaurants[standId].upgrades.station, 1);
    assert.ok(restored.lastSaved > original.lastSaved, 'Continuing an away save should checkpoint it immediately');
    assert.ok(restored.lifetime.pieces > original.pieces, 'The checkpoint should include offline franchise sales');
  });
} finally {
  await browser.close();
}
