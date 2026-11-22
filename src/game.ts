// Game orchestrator: renderer, loop, scene management, interactions, tutorial, persistence.
import * as THREE from 'three';
import { audio } from './audio/audio';
import { emit, on, toast } from './core/bus';
import * as A from './core/actions';
import { DISTRICTS, DistrictId, PROPERTIES, RECIPES, ROLES } from './core/data';
import { clockStr, short } from './core/format';
import { PhotoMode } from './photo/photo';
import { StoryNpcId, checkStoryBeat, dialogueFor } from './core/story';
import { checkAchievements, rewardText } from './core/achievements';
import { QuestEvent, ensureQuests, questOnEvent } from './core/quests';
import { makeReview, pushReview } from './core/reviews';
import { tickContracts } from './core/contracts';
import { tickEmpire } from './core/empire';
import * as sim from './core/sim';
import {
  Avatar, GameState, SAVE_KEY, Ticket, createNewState, exportSave, importSave, loadFromStorage, saveToStorage,
} from './core/state';
import { ThirdPersonCamera } from './engine/camera';
import { Post, createPost } from './engine/post';
import { Character } from './engine/character';
import { World } from './engine/collision';
import { Input } from './engine/input';
import { Player } from './engine/player';
import { NPCManager, OrderView } from './npc/npcs';
import { UIHost } from './ui/host';
import { UI } from './ui/ui';
import { buildDistrict } from './world/district';
import { Sky } from './world/sky';
import { Fx } from './fx/fx';
import { makePlate } from './world/sushi';
import { DistrictScene, RestaurantSite, Spot } from './world/types';

interface Interactable { kind: string; spot: Spot; r: number; prompt: () => string | null; act: () => void }

export class Game implements UIHost {
  renderer: THREE.WebGLRenderer;
  post!: Post;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
  input: Input;
  world = new World();
  cam: ThirdPersonCamera;
  player: Player;
  sky: Sky;
  photo!: PhotoMode;
  ui: UI;
  district!: DistrictScene;
  npcs!: NPCManager;
  s: GameState;
  started = false;
  paused = false;
  private busy = false; // cooking / dialog / travelling
  private timer = new THREE.Timer();
  private saveTimer = 0;
  private night = 0;
  fx!: Fx;
  private wasGrounded = true;
  private steamT = 0;
  private marker: THREE.Mesh;
  private markerTarget: Spot | null = null;
  private carryPlate: THREE.Object3D | null = null;
  private menuAngle = 0;
  private storyTimer = 0;
  private frameNo = 0;
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
    this.player = new Player(new Character(this.s.player.avatar, { apron: true }), this.world);
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
    this.photo = new PhotoMode(this.renderer, this.scene, this.camera, (h) => {
      document.getElementById('ui-root')!.style.visibility = h ? 'hidden' : '';
      document.querySelectorAll<HTMLElement>('body > *:not(canvas):not(#ui-root):not(.photo-bar)').forEach((e) => (e.style.visibility = h ? 'hidden' : ''));
      this.player.locked = h;
    });
    this.photo.render = () => this.post.render();
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

  newGame(o: { name: string; company: string; avatar: Avatar }): void {
    const settings = this.s.settings;
    this.s = createNewState(o.name || 'Chef', o.company || 'Sushi Empire');
    this.s.settings = settings;
    this.s.player.avatar = o.avatar;
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

  private start(): void { this.started = true; this.applySettings(); this.ui.update(0); }

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
    if (this.photo.isOpen()) this.photo.close();
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

  applyAvatar(): void { this.player.char.setAvatar(this.s.player.avatar, { apron: true }); }
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
  atSupplier(): boolean {
    const sp = this.district.supplier;
    return !!sp && Math.hypot(sp.x - this.player.pos.x, sp.z - this.player.pos.z) < 3;
  }
  setPaused(p: boolean): void { this.paused = p; }
  speed: 1 | 2 | 4 = 1;
  setSpeed(n: 1 | 2 | 4): void { this.speed = n; }
  ordersAtCurrentSite(): OrderView[] { const id = this.currentSite(); return id ? this.npcs.ordersView(this.s, id) : []; }

  // ------------------------------------------------------------ scenes
  private loadDistrict(d: DistrictId, toSpawn: boolean): void {
    if (this.district) { this.npcs.dispose(); this.district.dispose(); }
    this.district = buildDistrict(d, this.s);
    this.scene.add(this.district.group);
    this.world.colliders = this.district.colliders;
    this.npcs = new NPCManager(this.scene, this.district, this.s);
    this.district.refresh(this.s);
    this.s.player.district = d;
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
    on('event', (e) => toast(`${e.emoji} ${e.name}: ${e.desc}`, 'info'));
    const q = (ev: QuestEvent) => { if (this.started) questOnEvent(this.s.quests, this.s, ev); };
    on('sale', (e) => {
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
    on('sale', (e) => {
      if (e.customerId !== null) audio.sfx('cash');
      if (this.s.tutorial === 3) this.advanceTutorial(4);
    });
    on('upgrade', () => { audio.sfx('upgrade'); if (this.s.tutorial === 5) this.advanceTutorial(6); });
    on('purchase', () => { audio.sfx('fanfare'); });
  }

  // ------------------------------------------------------------ tutorial
  private async runTutorialIntro(): Promise<void> {
    this.busy = true;
    await this.ui.dialog('Grandpa Kenji', [
      `${this.s.player.name}. Good timing. The rice is still warm.`,
      'Forty years behind that counter. My knees have put in their notice, so I’m giving you the keys.',
      'The first regular will be here soon. He asks for salmon before he’s even sat down.',
      'There’s your stand. Follow the yellow arrow, then come around to the back of the counter.',
    ]);
    this.busy = false;
    this.s.tutorial = 0;
  }

  private advanceTutorial(step: number): void {
    if (this.s.tutorial >= step) return;
    this.s.tutorial = step;
    audio.sfx('pop');
    if (step === 1) this.npcs.hurryCustomer('asakusa_stand');
  }

  private tutorialObjective(): { text: string; target: Spot | null } | null {
    const t = this.s.tutorial;
    const stand = this.district.id === 'asakusa' ? this.site('asakusa_stand') : undefined;
    switch (t) {
      case 0: return { text: 'Follow the arrow to the stand. Use WASD to walk and drag to look around.', target: stand?.counter ?? null };
      case 1: return { text: 'Stand behind the counter and press E to take the first order.', target: stand?.counter ?? null };
      case 2: return { text: 'Press E at the cutting board to start the order.', target: stand?.prep ?? null };
      case 3: return { text: 'Bring the plate back to the counter and press E to serve it.', target: stand?.counter ?? null };
      case 4: return { text: "Restock at Mika's Fresh Fish. Press E at the shop to buy ingredients.", target: this.district.supplier };
      case 5: return { text: 'Press Tab, open Restaurants, and buy an upgrade for the stand.', target: null };
    }
    return null;
  }

  private dynamicObjective(): string {
    const s = this.s;
    const p = s.lifetime.pieces;
    const nm = sim.nextMilestone(s);
    const goal = `Next: ${nm.title} — ${short(p)} / ${short(nm.pieces)} 🍣`;
    if (p >= ROLES.chef.unlockPieces && !s.staff.some((e) => e.role === 'chef')) return 'Press Tab and open Staff to hire your first chef.';
    if (s.staff.some((e) => e.role === 'chef') && !s.staff.some((e) => e.role === 'server')) return 'Hire a server so the stand can take orders and serve them on its own.';
    for (const d of ['shibuya', 'shinjuku', 'ginza'] as DistrictId[])
      if (!s.districts.includes(d) && p >= DISTRICTS[d].unlock.pieces && s.cash >= DISTRICTS[d].unlock.cost) return `You can open ${DISTRICTS[d].name}! Tab → Expansion`;
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
      list.push({
        kind: 'counter', spot: site.counter, r: 1.4,
        prompt: () => this.npcs.counterPrompt(s, site.id) ?? (s.restaurants[site.id].cleanliness < 0.85 ? 'Clean up the counter' : null),
        act: () => this.counterAct(site.id),
      });
      list.push({ kind: 'prep', spot: site.prep, r: 1.3, prompt: () => this.cookPrompt(site.id), act: () => this.cook(site.id) });
    }
    if (d.supplier) list.push({ kind: 'supplier', spot: d.supplier, r: 2.2, prompt: () => "Mika's Fresh Fish — buy ingredients", act: () => this.ui.openShop() });
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

  private counterAct(siteId: string): void {
    const res = this.npcs.counterAction(this.s, siteId);
    this.player.override = 'interact';
    setTimeout(() => { if (this.player.override === 'interact') this.player.override = null; }, 350);
    if (res === 'took') { audio.sfx('pop'); if (this.s.tutorial <= 1) this.advanceTutorial(2); }
    else if (res === 'served') { if (this.s.tutorial <= 3) this.advanceTutorial(4); }
    else if (res === 'nostock') { audio.sfx('error'); toast('Out of ingredients for that order! Restock at the supplier.', 'bad', '📦'); }
    else if (this.s.restaurants[siteId].cleanliness < 0.85) { questOnEvent(this.s.quests, this.s, { type: 'clean', restaurant: siteId, cleanlinessBefore: this.s.restaurants[siteId].cleanliness }); A.playerClean(this.s, siteId); audio.sfx('whoosh'); toast('✨ Sparkling clean!', 'good'); }
  }

  private cookableTicket(siteId: string): Ticket | undefined {
    const r = this.s.restaurants[siteId];
    return r.orders.find((t) => t.manualOnly && !t.started) ?? r.orders.find((t) => !t.started && t.customerId !== null) ?? r.orders.find((t) => !t.started);
  }

  private cookPrompt(siteId: string): string | null {
    const t = this.cookableTicket(siteId);
    if (!t) return null;
    return `${t.manualOnly ? '👑 VIP special: ' : ''}Make ${t.pieces}× ${RECIPES[t.recipe].name}`;
  }

  private async cook(siteId: string): Promise<void> {
    const t = this.cookableTicket(siteId);
    const site = this.site(siteId);
    if (!t || !site) return;
    const prevCook = t.cook;
    t.cook = 'player';
    this.busy = true;
    this.player.locked = true; this.player.override = 'cook';
    this.player.teleport(site.prep.x, site.prep.z, site.prep.yaw);
    const fx = Math.sin(site.prep.yaw), fz = Math.cos(site.prep.yaw);
    this.cam.focus = {
      pos: new THREE.Vector3(site.prep.x - fx * 1.6 + fz * 0.6, 2.6, site.prep.z - fz * 1.6 - fx * 0.6),
      look: new THREE.Vector3(site.prep.x + fx * 0.6, 1.0, site.prep.z + fz * 0.6),
    };
    sim.setCookingTicket(t.id);
    const score = await this.ui.openCooking(t, siteId).finally(() => sim.setCookingTicket(null));
    this.cam.focus = null;
    this.player.locked = false; this.player.override = null;
    this.busy = false;
    if (score === null) { t.cook = prevCook; return; }
    if (!this.s.restaurants[siteId].orders.some((o) => o.id === t.id)) { audio.sfx('error'); toast('The guest left before you finished…', 'bad', '😢'); return; }
    if (!sim.finishManual(this.s, siteId, t.id, score)) { audio.sfx('error'); toast('Not enough ingredients!', 'bad', '📦'); t.cook = prevCook; return; }
    if (this.s.tutorial <= 2) this.advanceTutorial(3);
    questOnEvent(this.s.quests, this.s, { type: 'manualCook', restaurant: siteId, score });
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
      if (!this.ui.closeTop() && this.started) this.ui.openPause();
    }
    if (this.started && !this.paused) {
      const sdt = dt * this.speed; // tycoon time speed
      sim.tick(s, sdt, { activeDistrict: this.district.id });
      tickContracts(s, sdt);
      tickEmpire(s);
      ensureQuests(s.quests, s);
      if ((this.achTimer += dt) > 1) {
        this.achTimer = 0;
        const got = checkAchievements(s);
        if (got.length > 3) toast(`🏆 ${got.length} awards unlocked! See Management → Awards.`, 'gold');
        else for (const a of got) toast(`Award: ${a.title} — ${rewardText(a)}`, 'gold', a.emoji);
        if (got.length) audio.sfx('milestone');
      }
      if (this.input.pressed('KeyP') && (this.photo.isOpen() || this.input.enabled)) {
        if (this.photo.isOpen()) this.photo.close();
        else { this.photo.setLabel(s.player.company, `Day ${s.day} · ${clockStr(s.minute)}`); this.photo.open(this.player.pos.clone()); }
      }
      if (this.photo.isOpen()) this.photo.update(dt, this.input);
      else if (this.input.enabled) {
        if (this.input.pressed('Tab')) this.ui.toggleManage();
        if (this.input.pressed('KeyM')) this.ui.openMap();
        if (this.input.pressed('Digit1')) this.setSpeed(1);
        if (this.input.pressed('Digit2')) this.setSpeed(2);
        if (this.input.pressed('Digit3')) this.setSpeed(4);
      }
      if (!this.photo.isOpen()) this.cam.input(this.input.dragX, this.input.dragY, this.input.wheel);
      this.player.update(dt, this.input, this.cam.yaw);
      // juice: landing dip + dust, sprint FOV kick
      if (this.player.grounded && !this.wasGrounded) { this.cam.land(0.8); this.fx.puff(this.player.pos); audio.step(true); }
      this.wasGrounded = this.player.grounded;
      this.cam.sprint(this.player.char.speed > 5.5, dt);
      if (!this.photo.isOpen()) this.updateInteraction(dt);
      if (blocking && this.photo.isOpen()) this.photo.close(); // a modal (e.g. the million celebration) must never open unseen
      if (this.input.enabled && !this.photo.isOpen() && this.s.tutorial === 99 && (this.storyTimer += dt) > 3) {
        this.storyTimer = 0;
        const beat = checkStoryBeat(this.s);
        if (beat) { this.busy = true; void this.ui.dialog(beat.speaker, beat.lines).then(() => { this.busy = false; this.save(); }); }
      }
      this.updateCarry();
      this.saveTimer += dt;
      if (this.saveTimer > 20) { this.saveTimer = 0; this.save(); }
    } else if (!this.started) {
      // title screen: slow orbit around the stand
      this.menuAngle += dt * 0.08;
      this.camera.position.set(-6 + Math.sin(this.menuAngle) * 12, 7, 3 + Math.cos(this.menuAngle) * 12);
      this.camera.lookAt(-6, 1.5, 3);
    }
    this.night = this.sky.setTime(s.minute);
    const rain = !!(s.event && s.event.id === 'rain');
    this.sky.setRain(rain);
    this.sky.update(dt, this.player.pos);
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
    if (this.started && !this.photo.isOpen()) this.cam.update(dt, this.player.pos);
    const site = this.currentSite();
    audio.setScene({ district: this.district.id, night: this.night, rain, inside: !!site, busy: site ? s.restaurants[site].orders.length : 0 });
    audio.update(dt);
    this.ui.update(dt);
    // shadows re-render every other frame: half the shadow-pass draw calls, imperceptible lag
    this.renderer.shadowMap.needsUpdate = (this.frameNo++ & 1) === 0;
    this.post.setNight(this.night);
    this.post.render();
    this.input.endFrame();
  }

  private updateInteraction(dt: number): void {
    // objective + marker
    const tut = this.s.tutorial < 6 ? this.tutorialObjective() : null;
    if (!tut && this.s.tutorial !== 99) this.s.tutorial = 99;
    if (this.s.tutorial === 0 && this.district.id === 'asakusa') {
      const st = this.site('asakusa_stand');
      if (st && Math.hypot(st.counter.x - this.player.pos.x, st.counter.z - this.player.pos.z) < 5) this.advanceTutorial(1);
    }
    if (this.s.tutorial === 4 && this.s.flags.boughtOnce) this.advanceTutorial(5);
    if (this.s.tutorial === 5 && Object.values(this.s.restaurants).some((r) => Object.keys(r.upgrades).length)) this.advanceTutorial(6);
    this.ui.setObjective(tut ? tut.text : this.dynamicObjective());
    this.markerTarget = tut?.target ?? null;
    this.marker.visible = !!this.markerTarget && !this.busy;
    if (this.markerTarget) this.marker.position.set(this.markerTarget.x, 2.6 + Math.sin(performance.now() / 250) * 0.18, this.markerTarget.z);
    this.marker.rotation.y += dt * 2;

    if (!this.input.enabled) { this.ui.setPrompt(null); return; }
    const it = this.nearest();
    this.ui.setPrompt(it ? it.prompt() : null);
    if (it && it.kind === 'counter') {
      const site = this.district.sites.find((x) => x.counter === it.spot);
      if (site) this.cam.nudgeYaw(site.counter.yaw + Math.PI + 0.6, dt, 0.8); // 3/4 view: see the counter AND the guest
    }
    if (it && this.input.pressed('KeyE')) { audio.sfx('click'); it.act(); }
  }

  /** Visual: the player carries a plate while their own cooked orders wait to be served. */
  private updateCarry(): void {
    const siteId = this.currentSite();
    const r = siteId ? this.s.restaurants[siteId] : null;
    const t = r?.ready.find((x) => x.customerId !== null);
    const want = !!t && sim.staffAt(this.s, siteId!, 'server').length === 0;
    if (want && !this.carryPlate) {
      this.carryPlate = makePlate(t!.recipe, t!.pieces);
      this.carryPlate.scale.setScalar(1.4);
      this.player.char.hands.add(this.carryPlate);
    } else if (!want && this.carryPlate) {
      this.carryPlate.removeFromParent(); this.carryPlate = null;
    }
    this.player.carrying = !!this.carryPlate;
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
