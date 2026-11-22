# 🍣 Sushi Empire: Tokyo

### *Start Small. Sell a Million. Build an Empire.*

A browser-based 3D cartoon restaurant tycoon. You walk a stylized Tokyo in third person, cook sushi by hand at a tiny Asakusa street stand, serve real animated customers, and grow that stand into a sushi empire spanning Tokyo, Japan and the world.

Selling **1,000,000 pieces** makes you *Sushi Emperor*, which opens Chapter 2 instead of ending the game. Milestones keep coming forever.

No install, no backend, no API keys. It runs in any modern browser and saves to your machine.

---

## How to play

| Key | Action |
| --- | --- |
| **W A S D** / **Arrow keys** | Move (camera-relative) |
| **Shift** | Sprint |
| **Space** | Jump |
| **E** | Interact: take orders, cook, serve, shop, talk, ride the metro |
| **Mouse drag** | Rotate the camera |
| **Mouse wheel** | Zoom |
| **Tab** | Business management (staff, upgrades, menu & prices, marketing, research, expansion, empire) |
| **M** | City map / metro travel |
| **P** | Photo mode: free camera, film filters, hanko-stamped frame, PNG export |
| **Esc** | Close the top window / pause |

### The core loop

1. **Take an order.** Stand behind your counter. When a customer reaches the front of the queue, press **E**.
2. **Cook it.** At the prep board, press **E** for the hands-on minigame: knead the rice with circular mouse motion, drag the knife along the line, roll the bamboo mat, chop on the marks, spoon the roe (every step also has a keyboard path). Better technique means higher quality, which earns bigger tips and more reputation.
3. **Serve and get paid.** Back at the counter, press **E**. Cash and the 🍣 counter go up.
4. **Restock.** Ingredients run out. Buy from Mika's Fresh Fish (the supplier), or research the Supplier Hotline and Scheduled Deliveries to order from anywhere.
5. **Reinvest.** Spend on upgrades, seats, signs and recipes. Every upgrade visibly changes the restaurant.

The tutorial walks you through all of this in the first few minutes with Grandpa Kenji and a yellow arrow.

### Progression

| Stage | What opens up |
| --- | --- |
| **The stand** | ¥5,000, Grandpa Kenji's stand, Cucumber Maki and Salmon Nigiri. You cook everything yourself. |
| **First staff** (50 pieces) | Hire a **Sushi Chef** (cooks automatically) and a **Server** (takes orders and serves). A chef plus a server (or a manager) means the stand runs itself, including off-screen takeout orders. Cleaners unlock at 300 pieces, Managers at 3,000. |
| **More restaurants** | Buy properties: Kaminari Corner Shop (¥45k) and Sumida Riverside House (¥180k) in Asakusa, up to the Golden Koi Flagship in Ginza (¥30M). |
| **New districts** | **Shibuya** (1,000 pieces, ¥25k): crowds and volume. **Shinjuku** (10,000, ¥250k): office lunch rushes and big rents. **Ginza** (50,000, ¥2M): fewer guests who pay far more. Travel by metro. |
| **Research** | Research points come from every piece sold and from milestones. Six branches: cooking, supply, staff, marketing, recipes (Shrimp Nigiri → Chef's Special Platter) and empire. |
| **Marketing & reputation** | Flyers, newspaper, social media, influencers, billboards, TV and global campaigns. Each restaurant earns star reputation from quality, speed, price and cleanliness, and these roll up into a company-wide brand. |
| **Competition & events** | Rivals (Kaiten King, Maguro Mart, Golden Chopstick) fight for market share by simple, visible rules. Random events include festivals, tourist season, rainy days, ingredient shortages, Golden Week and visits from food critics. |
| **Daily life** | Three **daily requests** (quests) with streak bonuses, timed **catering contracts** (office parties, sumo stables, embassy galas), a 28-day **seasonal calendar** (sakura, matsuri, momiji, winter + New Year) with limited recipes, **54 awards**, a Tabelog-style **review feed** per restaurant, and short **story moments** with Grandpa Kenji, Mika, Mr. Sato, rival Ryo Tanaka and critic Madame Aoki. |
| **🏆 1,000,000 pieces** | **Sushi Emperor.** Fireworks over Tokyo, a stats retrospective, ¥25M, the Golden Maneki-neko, and **Chapter 2**. Nothing resets. |
| **Chapter 2: The Empire** | **Franchises** that sell around the clock. **Cities** from Tokyo Suburbs and Osaka to Kyoto, Seoul, Singapore, New York, London, Paris and Dubai. A **Headquarters** (10 levels). **Facilities**: Central Kitchen and Distribution Center. **Rival buyouts**, plus empire research such as Global Logistics and Demand Forecasting AI. |
| **Forever** | Fixed milestones run through 2M, 5M, 10M … up to 1B *Legendary Sushi Empire*. After that they're generated procedurally (2.5B, 5B, 10B, 25B …) with no cap. |

**Money matters.** Wages and rent are charged at the end of every in-game day (about 8½ real minutes, since closed hours from 02:00 to 07:00 fly by 4× faster). Prices are adjustable per restaurant: higher prices mean better margins but less demand, and how much demand drops depends on the district. If you overextend, the starter stand has no rent, so you can always cook your way back.

**Offline earnings.** Only restaurants with a **Manager** and at least one **Chef** and franchises keep earning while the tab is closed. They earn at 50% efficiency for up to 8 hours, or 75% for up to 12 hours with Manager Academy. You get a summary when you return.

---

## Tech stack

- **Three.js** for rendering, with a custom third-person controller, camera with wall-avoidance, and circle-vs-box collision
- **TypeScript** + **Vite**; **Vitest** for unit tests
- **Everything is procedural.** Characters, buildings, sushi and props are built in code. Music and sound effects are synthesized with the Web Audio API. There are no downloaded art or audio files (see [CREDITS.md](CREDITS.md)).
- **No backend.** State lives in LocalStorage.

## Architecture

```
src/
  core/     Pure simulation: no three.js, no DOM. Unit-tested.
            data.ts (all numbers: recipes, districts, upgrades, research, milestones, cities)
            state.ts (state shape, save/load, migration, export/import)
            sim.ts (tick, demand, kitchen, settle, milestones, offline progress)
            actions.ts (player business actions; each returns null or a reason it failed)
            bus.ts (typed event bus), format.ts (yen / 1.5M formatting)
  engine/   Renderer-side plumbing: input, player controller, camera, collision, character rig
  world/    Districts, buildings, props, sushi models, sky (day/night, rain, fireworks)
  npc/      Pedestrians, customers, staff, story NPCs, speech bubbles
  ui/       HUD, menus, management screens, cooking minigame, character creator (HTML/CSS)
  audio/    Synthesized music, ambience and SFX
  game.ts   Orchestrator: scene loading, interactions, tutorial, persistence, main loop
```

The modules meet at two shared contracts:

- **`src/world/types.ts`**: `DistrictScene` / `RestaurantSite`, the spots, colliders and paths that a world provides to the game and NPC systems.
- **`src/ui/host.ts`**: `UIHost`, everything the UI may call on the game.

The simulation is authoritative and frame-rate independent. Nearby customers are fully simulated 3D NPCs. Restaurants in other districts run as aggregate takeout demand against the same economy, so leaving a scene can't duplicate sales or inventory.

## Scripts

```bash
npm install
npm run dev          # dev server at http://localhost:5173
npm run build        # type-check + production build to dist/
npm run preview      # serve the production build
npm test             # unit + balance tests (vitest)
npm run typecheck

node scripts/shot.mjs out.png ["js to eval"] [waitMs] [url]   # headless screenshot
node scripts/smoke.mjs [url]       # UI-driven E2E: title → creator → tutorial → cooking → save/continue
node scripts/smoke-sim.mjs [url]   # state-driven E2E: tutorial steps, staff automation, save/reload, travel, past 1M
node scripts/smoke-layout.mjs [url] # walkable routes from metro spawns to property signs, counters and prep stations
node scripts/gallery.mjs           # screenshot gallery of districts, day/night, menus
node scripts/perf.mjs              # FPS, draw calls, memory per district + travel leak check
npm run smoke                      # smoke.mjs + smoke-sim.mjs
```

The E2E scripts use `playwright-core` with Google Chrome and expect the dev server to be running. Most of them hard-code the macOS Chrome path (`/Applications/Google Chrome.app/...`); `smoke.mjs` also accepts `CHROME_PATH`.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs the tests, builds, checks that asset paths are relative, and deploys on every push to `main`. Pull requests get the test and build steps without deploying, and you can also start it manually (workflow_dispatch).

1. Push the repo to GitHub.
2. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push to `main`, or run the workflow manually from the Actions tab. The game will be live at `https://<user>.github.io/<repo>/`.

`vite.config.ts` uses `base: './'`, so the same build works under any repository subpath (or a custom domain) without changes.

## Save system

- **Autosave** runs every 20 seconds, on tab hide and on close, to LocalStorage.
- **Backup slot.** Before each write, the previous good save is copied to a backup key. If the main save is corrupt, the game loads the backup instead of crashing.
- **Migration.** Saves carry a version number. Older saves are filled in with defaults for new fields and validated on load, so adding mechanics doesn't break existing progress.
- **Export / import.** Copy your save as a text code and paste it into another browser, from the pause/settings menu.

Saved data includes your avatar and position, cash, every restaurant (upgrades, menu, prices, look), staff, inventory, research, recipes, reputation and brand, campaigns, lifetime stats, milestones, districts, cities, franchises, HQ and facilities.

## Roadmap / not yet implemented

Honest status of what is *not* done yet:

- **Other cities are management-only.** Osaka, Kyoto, Seoul, Singapore, New York, London, Paris and Dubai are franchise markets you manage from the Empire tab; they have no explorable 3D streets yet. Only the four Tokyo districts are walkable.
- **Headquarters is an exterior.** The Shinjuku HQ tower grows with each level and is the Empire-management entrance, but there is no walkable HQ interior.
- **Customization is partial.** Restaurant name, sign colour, interior theme and uniform colour are editable, and award cosmetics feed into those pickers; per-item furniture placement and unlockable player clothing/hats are not implemented (some award cosmetic ids have no visual hook yet).
- **No optional prestige/legacy reset.** By design the game never forces a reset; an *optional* prestige layer is not built.
- **No delivery-scooter gameplay.** The Delivery Fleet upgrade raises demand and parks scooters out front, but there are no driveable delivery runs.
- **Restaurant photography** exists as photo mode; there is no in-game album.
- **Narrow screens.** The HUD targets ≥1280×720; below ~640 px wide some HUD panels overlap. No touch/mobile controls.
- **Balance is simulation-tuned, not player-tuned.** Pacing comes from headless bot strategies (≈6 h of active play to 1M); real-player feedback will move numbers.
- **Visuals.** Characters inside restaurants pick up the cool moonlight at night (interior surfaces get a warm lift, characters don't yet). Characters cast shadows only near the camera; the camera can still clip thin foliage edges; distant skyline is low-detail by design.

## License

Code: see [LICENSE](LICENSE). Third-party components: see [CREDITS.md](CREDITS.md).
