// Run against the Vite dev server: node scripts/smoke-layout.mjs [url]
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  args: process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.goto(url);
  const results = await page.evaluate(async () => {
    const [{ buildDistrict }, { createNewState, newRestaurant }, { DISTRICT_IDS, PROPERTIES }] = await Promise.all([
      import(new URL('./src/world/district.ts', location.href).href),
      import(new URL('./src/core/state.ts', location.href).href),
      import(new URL('./src/core/data.ts', location.href).href),
    ]);

    // Test normal walking from the metro spawn on a 25 cm grid using the player's
    // collision radius and height. Only positions within an interaction's reach count.
    const scale = 4;
    const extent = 90 * scale;
    const width = extent * 2 + 1;
    const radius = 0.38;
    const index = (x, z) => (z + extent) * width + x + extent;

    function reachableFromSpawn(district) {
      const cells = new Uint8Array(width * width);
      for (const box of district.colliders) {
        if (box.minY > 1.6 || box.maxY < 0.05) continue;
        const x0 = Math.max(-extent, Math.ceil((box.minX - radius) * scale));
        const x1 = Math.min(extent, Math.floor((box.maxX + radius) * scale));
        const z0 = Math.max(-extent, Math.ceil((box.minZ - radius) * scale));
        const z1 = Math.min(extent, Math.floor((box.maxZ + radius) * scale));
        for (let z = z0; z <= z1; z++) {
          const dz = Math.max(box.minZ - z / scale, z / scale - box.maxZ, 0);
          for (let x = x0; x <= x1; x++) {
            const dx = Math.max(box.minX - x / scale, x / scale - box.maxX, 0);
            if (dx * dx + dz * dz < radius * radius) cells[index(x, z)] = 1;
          }
        }
      }

      const spawn = index(Math.round(district.spawn.x * scale), Math.round(district.spawn.z * scale));
      if (cells[spawn] !== 0) throw new Error(`${district.id} spawn is blocked`);
      const queue = [spawn];
      cells[spawn] = 2;
      for (let i = 0; i < queue.length; i++) {
        const cell = queue[i];
        const col = cell % width;
        if (col > 0) visit(cell - 1);
        if (col < width - 1) visit(cell + 1);
        if (cell >= width) visit(cell - width);
        if (cell < cells.length - width) visit(cell + width);
      }

      function visit(cell) {
        if (cells[cell] !== 0) return;
        cells[cell] = 2;
        queue.push(cell);
      }

      return (spot, range) => {
        const x0 = Math.ceil((spot.x - range) * scale);
        const x1 = Math.floor((spot.x + range) * scale);
        const z0 = Math.ceil((spot.z - range) * scale);
        const z1 = Math.floor((spot.z + range) * scale);
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            if (cells[index(x, z)] === 2 && Math.hypot(x / scale - spot.x, z / scale - spot.z) < range) return true;
          }
        }
        return false;
      };
    }

    return DISTRICT_IDS.map((id) => {
      const state = createNewState();
      state.flags.chapter2 = true;
      const district = buildDistrict(id, state);
      try {
        district.refresh(state);
        const canReachForSale = reachableFromSpawn(district);
        const blocked = district.sites
          .filter((site) => !state.restaurants[site.id] && !canReachForSale(site.sign, 2))
          .map((site) => `${site.id} property sign`);
        const siteIds = new Set(district.sites.map((site) => site.id));
        for (const property of Object.values(PROPERTIES)) {
          if (property.district === id && !siteIds.has(property.id)) blocked.push(`${property.name} missing from the district`);
        }
        for (const site of district.sites) {
          state.restaurants[site.id] ??= newRestaurant(site.id, state.day);
        }
        district.refresh(state);
        const canReach = reachableFromSpawn(district);
        const checks = [
          ['metro', district.metro, 2.5],
          ['supplier', district.supplier, 2.2],
          ['headquarters', district.hq, 2.5],
          ...district.sites.flatMap((site) => [
            [`${PROPERTIES[site.id].name} counter`, site.counter, 1.4],
            [`${PROPERTIES[site.id].name} prep station`, site.prep, 1.3],
          ]),
        ];
        for (const [label, spot, range] of checks) if (spot && !canReach(spot, range)) blocked.push(label);
        return { id, sites: district.sites.length, blocked };
      } finally {
        district.dispose();
      }
    });
  });

  const failures = [];
  for (const { id, sites, blocked } of results) {
    if (blocked.length) failures.push(`${id}: ${blocked.join(', ')}`);
    else console.log(`PASS ${id}: metro and ${sites} restaurant sites reachable on foot`);
  }
  assert.deepEqual(failures, [], 'District interactions blocked by scenery');
} finally {
  await browser.close();
}
