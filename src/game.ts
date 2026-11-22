// Game orchestrator: renderer, loop, scene management, interactions, tutorial, persistence.
import * as THREE from 'three';
import { audio } from './audio/audio';
import { emit, on, toast } from './core/bus';
import { AREAS, DISTRICTS, DistrictId, PROPERTIES } from './core/data';
import { fitoutCost } from './core/actions';
import { short, yen } from './core/format';
import { StoryNpcId, checkStoryBeat, dialogueFor } from './core/story';
import { checkAchievements, rewardText } from './core/achievements';
import { QuestEvent, ensureQuests, questOnEvent } from './core/quests';
import { makeReview, pushReview } from './core/reviews';
import { alerts as empireAlerts, tickEmpire } from './core/empire';
import * as sim from './core/sim';
import {
  Avatar, GameState, SAVE_KEY, createNewState, exportSave, importSave, loadFromStorage, saveToStorage,
} from './core/state';
import { ThirdPersonCamera } from './engine/camera';
import { Overview } from './engine/overview';
import { Post, createPost } from './engine/post';
import { Character, Outfit } from './engine/character';
import { TitleFlyover } from './engine/flyover';
import { applyXray, updateXray } from './engine/xray';
import { World } from './engine/collision';
import { Input } from './engine/input';
import { Player } from './engine/player';
import { NPCManager } from './npc/npcs';
import { UIHost } from './ui/host';
import { UI } from './ui/ui';
import { buildDistrict } from './world/district';
import { Sky } from './world/sky';
import { Fx } from './fx/fx';
import { DistrictScene, RestaurantSite, Spot } from './world/types';

/** The owner dresses the part and pops on screen: cream shirt, camel blazer, mid-grey trousers, no hat. */
const ownerLook = (a: Avatar): [Avatar, Outfit] => [{ ...a, shirt: '#f4efe4', pants: '#7d7a76', headwear: 0 }, { cut: 'blazer', vest: '#a9825a' }];

interface Interactable { kind: string; spot: Spot; r: number; prompt: () => string | null; act: () => void }

export class Game implements UIHost {
  renderer: THREE.WebGLRenderer;
  post!: Post;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
  input: Input;
  world = new World();
  cam: ThirdPersonCamera;
  overview!: Overview;
  player: Player;
  sky: Sky;
  ui: UI;
  district!: DistrictScene;
  npcs!: NPCManager;
  s: GameState;
  started = false;
  paused = false;
  private busy = false; // dialog / travelling
  private timer = new THREE.Timer();
  private saveTimer = 0;
  private night = 0;
  fx!: Fx;
  private wasGrounded = true;
  private steamT = 0;
  private marker: THREE.Mesh;
  private markerTarget: Spot | null = null;
  private flyover = new TitleFlyover();
  private flyFade: HTMLDivElement | null = null;
  private storyTimer = 0;
  private frameNo = 0;
  private objTimer = 0;
  private objText = '';
  private basePR = 1;
  private resScale = 1;
  private achTimer = 0;
  private fps = { frames: 0, t: 0, value: 60 };
  private savedGameAvailable: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.post = createPost(this.renderer, this.scene, this.camera);
    this.input = new Input(canvas, () => this.started);
    this.cam = new ThirdPersonCamera(this.camera, this.world);
    const saved = loadFromStorage();
    this.savedGameAvailable = saved !== null;
    this.s = saved ?? createNewState();
    sim.releaseVisibleTickets(this.s, null);
    this.player = new Player(new Character(...ownerLook(this.s.player.avatar)), this.world);
    this.scene.add(this.player.char.root);
    this.player.onStep = () => audio.step(this.input.held('ShiftLeft', 'ShiftRight'));
    this.sky = new Sky(this.scene, this.renderer);
    this.fx = new Fx(this.scene, this.camera);
    this.fx.locate = (rid) => { const st = this.site(rid); return st ? new THREE.Vector3(st.queue[0].x, 1.2, st.queue[0].z) : null; };
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 4), new THREE.MeshBasicMaterial({ color: '#ffd23f' }));
    this.marker.rotation.x = Math.PI;
    this.scene.add(this.marker);
    this.loadDistrict(this.s.player.district, false);
    this.ui = new UI(this);
    this.overview = new Overview(this);
    this.applySettings();
    this.wireEvents();
    addEventListener('resize', () => this.resize());
    this.resize();
    addEventListener('pointerdown', () => audio.unlock(), { once: false });
    addEventListener('keydown', () => audio.unlock());
    let hiddenAt = 0;
    addEventListener('visibilitychange', () => {
      if (!this.started) return;
      if (document.hidden) { hiddenAt = Date.now(); this.save(); return; }
      // a hidden tab stops the game loop: credit managed restaurants for the time away
      const away = hiddenAt ? (Date.now() - hiddenAt) / 1000 : 0;
      hiddenAt = 0;
      if (away >= 60) { const off = sim.offlineProgress(this.s, away); if (off.pieces > 0) { this.ui.showOffline(off); emit('offline', off); } this.save(); }
    });
    addEventListener('beforeunload', () => { if (this.started) this.save(); });
    this.ui.showMainMenu();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------ UIHost
  hasSave(): boolean { return this.savedGameAvailable; }

  newGame(o: { name?: string; company: string; avatar?: Avatar }): void {
    const settings = this.s.settings;
    this.s = createNewState(o.name || 'Chef', o.company || 'Sushi Empire');
    this.s.settings = settings;
    if (o.avatar) this.s.player.avatar = o.avatar;
    sim.refreshCandidates(this.s);
    this.applyAvatar();
    this.loadDistrict('asakusa', true);
    this.start();
    this.save();
    this.runTutorialIntro();
  }

  continueGame(): void {
    const loaded = loadFromStorage();
    if (loaded) {
      loaded.settings = this.s.settings;
      this.s = loaded;
      sim.releaseVisibleTickets(this.s, null);
    }
    if (!this.s.candidates.length) sim.refreshCandidates(this.s);
    this.applyAvatar();
    this.loadDistrict(this.s.player.district, false);
    this.player.teleport(this.s.player.x, this.s.player.z, this.s.player.yaw);
    this.cam.snap(this.player.pos);
    const away = (Date.now() - this.s.lastSaved) / 1000;
    const off = sim.offlineProgress(this.s, away);
    this.start();
    this.save();
    if (off.pieces > 0 || off.expenses > 0) { this.ui.showOffline(off); emit('offline', off); }
  }

  private start(): void { this.started = true; this.flyFade?.remove(); this.flyFade = null; this.applySettings(); this.ui.update(0); }

  /** Title screen: a cinematic camera drifts over the districts behind the UI, fading through black between shots. */
  private titleFlyover(dt: number): void {
    if (this.district.id !== this.flyover.district) {
      const keep = this.s.player.district; // the save's district must not change just because the title wandered
      this.loadDistrict(this.flyover.district, false);
      this.s.player.district = keep;
    }
    const { fade } = this.flyover.update(dt, this.camera, this.district);
    if (!this.flyFade) {
      this.flyFade = document.createElement('div');
      this.flyFade.style.cssText = 'position:fixed;inset:0;background:#15110e;pointer-events:none;';
      document.body.insertBefore(this.flyFade, document.getElementById('ui-root')); // above the canvas, under the title UI
    }
    this.flyFade.style.opacity = fade.toFixed(3);
  }

  importSave(code: string): string | null {
    let imported: GameState;
    try { imported = importSave(code); } catch { return 'That save code is not valid.'; }
    if (!saveToStorage(imported)) return 'The browser could not store that save.';
    this.started = false;
    location.reload();
    return null;
  }
  exportSave(): string { return exportSave(this.s); }
  deleteSave(): void { localStorage.removeItem(SAVE_KEY); localStorage.removeItem(SAVE_KEY + '-backup'); this.started = false; location.reload(); }
  save(): boolean {
    this.s.player.x = this.player.pos.x; this.s.player.z = this.player.pos.z; this.s.player.yaw = this.player.yaw;
    const saved = saveToStorage(this.s);
    if (saved) this.savedGameAvailable = true;
    return saved;
  }

  travel(d: DistrictId): void {
    if (this.busy || d === this.district.id || !this.s.districts.includes(d)) return;
    this.busy = true;
    const fade = document.createElement('div');
    fade.className = 'fade-overlay';
    fade.innerHTML = `<div class="fade-title">${DISTRICTS[d].jp}<small>${DISTRICTS[d].name}</small></div>`;
    document.body.append(fade);
    audio.sfx('whoosh');
    requestAnimationFrame(() => fade.classList.add('on'));
    setTimeout(() => {
      sim.releaseVisibleTickets(this.s, this.district.id);
      this.loadDistrict(d, true);
      questOnEvent(this.s.quests, this.s, { type: 'travel', district: d });
      this.save();
      fade.classList.remove('on');
      setTimeout(() => { fade.remove(); this.busy = false; }, 700);
    }, 700);
  }

  applySettings(): void {
    const st = this.s.settings;
    this.cam.sensitivity = st.sensitivity; this.cam.invertY = st.invertY;
    // match the post-processing cap (rendering above it is wasted fill); dynamic resolution scales below this
    this.basePR = Math.min(devicePixelRatio, st.quality === 'high' ? 1.5 : st.quality === 'medium' ? 1.25 : 1);
    this.resScale = 1;
    this.renderer.setPixelRatio(this.basePR);
    this.post?.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = st.quality !== 'low';
    this.post.setQuality(st.quality);
    this.sky.setQuality(st.quality);
    audio.setVolumes(st);
  }

  applyAvatar(): void { this.player.char.setAvatar(...ownerLook(this.s.player.avatar)); }
  refreshWorld(): void { this.district.refresh(this.s); this.npcs.refresh(this.s); }

  currentSite(): string | null {
    let best: string | null = null, bd = 12;
    for (const site of this.district.sites) {
      if (!this.s.restaurants[site.id]) continue;
      const d = Math.hypot(site.counter.x - this.player.pos.x, site.counter.z - this.player.pos.z);
      if (d < bd) { bd = d; best = site.id; }
    }
    return best;
  }
  setPaused(p: boolean): void { this.paused = p; }
  speed: 1 | 2 | 4 = 1;
  setSpeed(n: 1 | 2 | 4): void { this.speed = n; }

  // ------------------------------------------------------------ scenes
  private loadDistrict(d: DistrictId, toSpawn: boolean): void {
    if (this.district) { this.npcs.dispose(); this.district.dispose(); }
    this.overview?.exit(true);
    this.district = buildDistrict(d, this.s);
    this.scene.add(this.district.group);
    this.world.colliders = this.district.colliders;
    this.npcs = new NPCManager(this.scene, this.district, this.s);
    this.district.refresh(this.s);
    this.s.player.district = d;
    applyXray(this.scene); // occluders between the camera and the owner dissolve
    this.renderer.compile(this.scene, this.camera); // pre-compile shaders: no hitch on first look
    if (toSpawn) {
      const sp = this.district.spawn;
      this.player.teleport(sp.x, sp.z, sp.yaw);
      this.cam.yaw = sp.yaw + Math.PI;
    }
    this.cam.snap(this.player.pos);
  }

  private site(id: string): RestaurantSite | undefined { return this.district.sites.find((x) => x.id === id); }

  // ------------------------------------------------------------ events
  private wireEvents(): void {
    on('restaurantsChanged', () => this.refreshWorld());
    on('upgrade', () => this.cam.shake(0.35));
    on('purchase', () => this.cam.shake(0.5));
    on('milestone', () => this.cam.shake(0.45));
    on('million', () => this.cam.shake(0.9));
    on('milestone', (m) => {
      audio.sfx('milestone');
    });
    on('million', () => {
      this.sky.fireworks(40);
      audio.sfx('fanfare');
      this.district.refresh(this.s);
      this.ui.celebrateMillion();
    });
    const q = (ev: QuestEvent) => { if (this.started) questOnEvent(this.s.quests, this.s, ev); };
    on('sale', (e) => {
      if (!this.s.restaurants[e.restaurant]) return; // stale event (restaurant sold/converted, or another state)
      q({ type: 'sale', restaurant: e.restaurant, recipe: e.recipe, pieces: e.pieces, revenue: e.paid + e.tip, customerType: e.customerType });
      const notable = e.customerType === 'critic' || e.customerType === 'vip' || e.customerType === 'influencer';
      if (notable || Math.random() < 1 / 8) this.s.reviews[e.restaurant] = pushReview(this.s.reviews[e.restaurant] ?? [], makeReview(this.s, e.restaurant, e, Math.random));
    });
    on('customerLeft', (e) => q({ type: 'customerLeft', restaurant: e.restaurant, reason: e.reason }));
    on('upgrade', (e) => q({ type: 'upgrade', restaurant: e.restaurant, upgrade: e.upgrade }));
    on('hire', (e) => q({ type: 'hire', role: e.role } as QuestEvent));
    on('train', (e) => q({ type: 'train', role: e.role } as QuestEvent));
    on('campaign', (e) => q({ type: 'campaign', id: e.id }));
    on('dayEnd', () => q({ type: 'dayEnd' }));
    on('sale', (e) => { if (e.customerId !== null) audio.sfx('cash'); });
    on('upgrade', () => audio.sfx('upgrade'));
    on('purchase', () => { audio.sfx('purchase'); });
  }

  // ------------------------------------------------------------ tutorial
  private async runTutorialIntro(): Promise<void> {
    this.busy = true;
    await this.ui.dialog('Grandpa Kenji', [
      `${this.s.player.company}. It has a ring to it.`,
      'Forty years behind that counter. My knees have put in their notice, so the stand is yours.',
      'You\'re the owner now, not the cook. Hire good people, keep them busy, and open the next shop.',
      'Follow the yellow arrow to the stand. Press E there to run it.',
    ]);
    this.busy = false;
    this.s.tutorial = 0;
  }

  /**
   * Steps: 0 walk to the stand → 1 hire a chef → 2 first sale → 3 hire a server → 4 buy an upgrade → 5 buy a second lot → 99.
   * Each step completes from game state, so loaded or migrated saves catch up on their own.
   */
  private tutorialDone(step: number): boolean {
    const s = this.s, staffed = (role: string) => s.staff.some((e) => e.role === role && e.restaurant);
    switch (step) {
      case 0: {
        const st = this.district.id === 'asakusa' ? this.site('asakusa_stand') : undefined;
        return !!st && Math.hypot(st.counter.x - this.player.pos.x, st.counter.z - this.player.pos.z) < 5 || Object.keys(s.restaurants).length > 1;
      }
      case 1: return staffed('chef');
      case 2: return s.lifetime.customers > 0;
      case 3: return staffed('server') || staffed('manager');
      case 4: return Object.values(s.restaurants).some((r) => Object.keys(r.upgrades).length);
      case 5: return Object.keys(s.restaurants).length > 1;
    }
    return true;
  }

  private tutorialObjective(): { text: string; target: Spot | null } | null {
    const stand = this.district.id === 'asakusa' ? this.site('asakusa_stand') : undefined;
    switch (this.s.tutorial) {
      case 0: return { text: 'Follow the arrow to your stand. Use WASD to walk and drag to look around.', target: stand?.counter ?? null };
      case 1: return { text: 'Hire a chef: press E at the stand and open Staff. Only chefs cook, so no chef means no sales.', target: stand?.counter ?? null };
      case 2: return { text: 'Your chef is open for business. Wait for the first guest to pay.', target: null };
      case 3: return { text: 'Your chef is also working the counter, which slows the kitchen. Hire a server: E at the stand → Staff.', target: stand?.counter ?? null };
      case 4: return { text: 'Buy an upgrade for the stand: E at the stand → Look.', target: stand?.counter ?? null };
      case 5: {
        // the cheapest lot here, with the cheapest fit-out (a kiosk), so the player knows what to save up for
        const lots = Object.values(PROPERTIES).filter((p) => !this.s.restaurants[p.id] && this.s.districts.includes(p.district)).map((p) => p.price + fitoutCost(p.id, 'kiosk'));
        const from = lots.length ? ` (from ${yen(Math.min(...lots))} with fit-out)` : '';
        return { text: `Open a second restaurant${from}: walk to a 売物件 For Sale sign, or press Tab.`, target: null };
      }
    }
    return null;
  }

  private dynamicObjective(): string {
    const s = this.s;
    const p = s.lifetime.pieces;
    const nm = sim.nextMilestone(s);
    const goal = `Next: ${nm.title} (${short(p)} / ${short(nm.pieces)} pieces)`;
    const ids = Object.keys(s.restaurants);
    const idle = ids.filter((id) => !sim.isAutomated(s, id));
    if (idle.length) return `${s.restaurants[idle[0]].name} has no chef, so it sells nothing. Hire one: E there, or Tab.`;
    if (ids.length === 1) return 'Open a second restaurant: walk to a 売物件 For Sale sign or press Tab.';
    const need = empireAlerts(s).filter((a) => a.severity !== 'opportunity').reduce((a, x) => a + Math.max(1, x.restIds.length), 0);
    if (need) return `Check the Empire ledger (Tab): ${need} restaurant${need === 1 ? ' needs' : 's need'} attention.`;
    for (const a of Object.values(AREAS))
      if (!s.districts.includes(a.id) && p >= a.unlock.pieces && s.cash >= a.unlock.cost && (!a.unlock.chapter2 || s.flags.chapter2)) return `New market open: ${a.name}. Expand from the Empire ledger.`;
    if (s.flags.chapter2 && !s.flags.seenChapter2Hint) return 'Chapter 2: franchises, cities and HQ in Tab → Empire';
    return goal;
  }

  // ------------------------------------------------------------ interactions
  private interactables(): Interactable[] {
    const list: Interactable[] = [];
    const s = this.s, d = this.district;
    for (const site of d.sites) {
      const owned = !!s.restaurants[site.id];
      if (!owned) {
        list.push({ kind: 'sign', spot: site.sign, r: 2, prompt: () => `View property: ${PROPERTIES[site.id].name}`, act: () => this.ui.openProperty(site.id) });
        continue;
      }
      // at the counter or right at the front door: shops' counters sit ~10 m inside
      for (const spot of [site.counter, site.door]) list.push({
        kind: 'shop', spot, r: 2.5,
        prompt: () => `Manage ${s.restaurants[site.id]?.name ?? PROPERTIES[site.id].name}`,
        act: () => this.ui.openRestaurant(site.id, s.tutorial === 1 || s.tutorial === 3 ? 'staff' : s.tutorial === 4 ? 'look' : undefined),
      });
    }
    list.push({ kind: 'metro', spot: d.metro, r: 2.5, prompt: () => 'Take the Metro (travel map)', act: () => this.ui.openMap() });
    if (d.hq && s.flags.chapter2) list.push({ kind: 'hq', spot: d.hq, r: 2.5, prompt: () => `${s.player.company} HQ — Empire management`, act: () => { s.flags.seenChapter2Hint = true; this.ui.toggleManage('empire'); } });
    for (const n of d.storyNpcs) list.push({ kind: 'npc', spot: n.spot, r: 2, prompt: () => `Talk to ${n.name}`, act: () => this.talk(n.id, n.name) });
    return list;
  }

  private nearest(): Interactable | null {
    let best: Interactable | null = null, bd = Infinity;
    for (const it of this.interactables()) {
      const dd = Math.hypot(it.spot.x - this.player.pos.x, it.spot.z - this.player.pos.z);
      if (dd < it.r && dd < bd && it.prompt() !== null) { bd = dd; best = it; }
    }
    return best;
  }

  private async talk(id: string, name: string): Promise<void> {
    this.busy = true;
    await this.ui.dialog(name, dialogueFor(id as StoryNpcId, this.s));
    this.busy = false;
  }

  // ------------------------------------------------------------ frame
  private frame(): void {
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    this.fps.frames++; this.fps.t += dt;
    if (this.fps.t > 1) { this.fps.value = this.fps.frames / this.fps.t; this.fps.frames = 0; this.fps.t = 0; this.adaptResolution(); }
    const s = this.s;
    const blocking = this.ui.isBlocking();
    this.input.enabled = this.started && !blocking && !this.busy;

    if (this.input.pressed('Escape')) {
      if (!this.ui.closeTop() && this.started) { if (this.overview.active) this.overview.exit(); else this.ui.openPause(); }
    }
    if (this.started && !this.paused) {
      const sdt = dt * this.speed; // tycoon time speed
      sim.tick(s, sdt, { activeDistrict: this.district.id });
      tickEmpire(s);
      ensureQuests(s.quests, s);
      if ((this.achTimer += dt) > 1) {
        this.achTimer = 0;
        const got = checkAchievements(s);
        if (got.length > 3) toast(`${got.length} awards unlocked! See Management → Awards.`, 'gold', 'trophy');
        else for (const a of got) toast(`Award: ${a.title} — ${rewardText(a)}`, 'gold', a.icon);
        if (got.length) audio.sfx('milestone');
      }
      if (this.input.enabled) {
        if (this.input.pressed('Tab')) this.ui.toggleManage();
        if (this.input.pressed('KeyM')) this.ui.openMap();
        if (this.input.pressed('Digit1')) this.setSpeed(1);
        if (this.input.pressed('Digit2')) this.setSpeed(2);
        if (this.input.pressed('Digit3')) this.setSpeed(4);
        if (this.input.pressed('KeyO')) this.overview.toggle();
      }
      if (!this.overview.active) this.cam.input(this.input.dragX, this.input.dragY, this.input.wheel);
      this.player.locked = this.overview.active; // overview: the avatar waits where it stood
      this.player.update(dt, this.input, this.cam.yaw);
      // juice: landing dip + dust, sprint FOV kick
      if (this.player.grounded && !this.wasGrounded) { this.cam.land(0.8); this.fx.puff(this.player.pos); audio.step(true); }
      this.wasGrounded = this.player.grounded;
      this.cam.sprint(this.player.char.speed > 5.5, dt);
      this.updateInteraction(dt);
      if (this.input.enabled && this.s.tutorial === 99 && (this.storyTimer += dt) > 3) {
        this.storyTimer = 0;
        const beat = checkStoryBeat(this.s);
        if (beat) { this.busy = true; void this.ui.dialog(beat.speaker, beat.lines).then(() => { this.busy = false; this.save(); }); }
      }
      this.saveTimer += dt;
      if (this.saveTimer > 20) { this.saveTimer = 0; this.save(); }
    } else if (!this.started) this.titleFlyover(dt);
    this.night = this.sky.setTime(this.started ? s.minute : this.flyover.minute);
    this.sky.update(dt, this.overview.focus);
    this.district.update(dt, this.night, this.player.pos);
    if (!this.paused) this.npcs.update(dt * (this.started ? this.speed : 1), s, this.player.pos, this.night);
    this.fx.focus.copy(this.player.pos);
    this.fx.update(dt);
    if ((this.steamT += dt) > 0.3) { // steam over busy prep boards in this district
      this.steamT = 0;
      for (const st of this.district.sites) {
        const r = s.restaurants[st.id];
        if (r?.orders.some((t) => t.started)) this.fx.steam(new THREE.Vector3(st.prep.x + Math.sin(st.prep.yaw) * 0.5, 1.15, st.prep.z + Math.cos(st.prep.yaw) * 0.5));
      }
    }
    if (this.started) { this.cam.update(dt, this.player.pos); this.overview.update(dt); }
    const site = this.currentSite();
    // crosswalk chirps: how close the nearest signalled crossing is, and whether it shows walk
    let cd = Infinity, cw = false;
    const tr = this.district.traffic;
    for (const c of tr?.crossings ?? []) {
      if (!c.signal) continue;
      const d = Math.hypot(c.x - this.player.pos.x, c.z - this.player.pos.z);
      if (d < cd) { cd = d; cw = tr.pedSignal(c.road) === 'g'; }
    }
    audio.setScene({ district: this.district.id, night: this.night, inside: !!site, busy: site ? s.restaurants[site].orders.length : 0, crossing: Math.max(0, 1 - cd / 30), walk: cw });
    audio.update(dt);
    this.ui.update(dt);
    // shadows re-render every other frame: half the shadow-pass draw calls, imperceptible lag
    this.renderer.shadowMap.needsUpdate = (this.frameNo++ & 1) === 0;
    this.post.setNight(this.night);
    this.camera.updateMatrixWorld();
    updateXray(this.camera, this.player.pos, this.started && !this.overview.active);
    this.post.render();
    this.input.endFrame();
  }

  private updateInteraction(dt: number): void {
    // objective + marker
    if (this.s.tutorial < 99 && this.tutorialDone(this.s.tutorial)) { this.s.tutorial = this.s.tutorial >= 5 ? 99 : this.s.tutorial + 1; audio.sfx('pop'); }
    const tut = this.s.tutorial < 99 ? this.tutorialObjective() : null;
    if (tut) this.ui.setObjective(tut.text);
    else if ((this.objTimer += dt) > 1 || !this.objText) { this.objTimer = 0; this.objText = this.dynamicObjective(); this.ui.setObjective(this.objText); }
    this.markerTarget = tut?.target ?? null;
    this.marker.visible = !!this.markerTarget && !this.busy;
    if (this.markerTarget) this.marker.position.set(this.markerTarget.x, 2.6 + Math.sin(performance.now() / 250) * 0.18, this.markerTarget.z);
    this.marker.rotation.y += dt * 2;

    if (!this.input.enabled || this.overview.active) { this.ui.setPrompt(null); return; }
    const it = this.nearest();
    this.ui.setPrompt(it ? it.prompt() : null);
    if (it && this.input.pressed('KeyE')) { audio.sfx('click'); it.act(); }
  }

  /** Dynamic resolution: drop render scale when the GPU can't hold ~50 fps, recover when there's headroom. */
  private adaptResolution(): void {
    if (!this.started) return;
    const f = this.fps.value;
    let next = this.resScale;
    if (f < 45 && next > 0.55) next = Math.max(0.55, next - 0.1);
    else if (f > 58 && next < 1) next = Math.min(1, next + 0.05);
    if (next === this.resScale) return;
    this.resScale = next;
    this.renderer.setPixelRatio(this.basePR * next);
    this.resize();
  }

  private resize(): void {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.post?.setSize(innerWidth, innerHeight);
  }

  get fpsValue(): number { return this.fps.value; }
}

export type { UIHost };
