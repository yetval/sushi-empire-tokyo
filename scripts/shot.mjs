// Headless screenshot helper for development/QA.
// Usage: node scripts/shot.mjs <out.png> [jsToEvalAfterStart] [waitMs] [url]
// The page exposes window.game. Example JS: "game.newGame({name:'T',company:'C',avatar:game.s.player.avatar}); game.player.teleport(0,10,Math.PI)"
import { chromium } from 'playwright-core';
const [out = 'shot.png', js = '', wait = '1500', url = 'http://localhost:5173/'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
// block Vite HMR so concurrent edits don't reload the page mid-shot
await page.addInitScript(() => { window.WebSocket = class { constructor() {} addEventListener() {} removeEventListener() {} send() {} close() {} }; });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.game && window.game.s, null, { timeout: 30000 }); // game boots after fonts
await page.evaluate(() => localStorage.clear());
await page.waitForTimeout(500);
if (js) { try { const r = await page.evaluate(js); if (r !== undefined) console.log('eval result:', JSON.stringify(r)); } catch (e) { logs.push('[eval] ' + e.message); } }
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
const fps = await page.evaluate(() => (window.game ? Math.round(window.game.fpsValue) : null)).catch(() => null);
console.log(`saved ${out} fps=${fps}`);
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
await browser.close();
