// Photo mode: free orbit/fly camera, CSS filters, framed print with a red hanko stamp, PNG shutter.
// The game must skip its own camera/player update while isOpen() (see integration notes).
import * as THREE from 'three';

const FILTERS: [name: string, css: string][] = [
  ['None', 'none'],
  ['Film', 'contrast(1.08) saturate(1.25) sepia(0.12) brightness(1.03)'],
  ['B&W', 'grayscale(1) contrast(1.2)'],
  ['Showa', 'sepia(0.9) saturate(0.75) contrast(0.92) brightness(1.06)'],
  ['Neon night', 'saturate(1.9) contrast(1.25) hue-rotate(-18deg) brightness(0.92)'],
];

const CSS = `
.photo-frame{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:900}
.photo-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:901;display:flex;gap:6px;align-items:center;
  padding:8px 10px;border-radius:12px;background:rgba(20,16,14,.82);color:#f4ecdc;font:13px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);white-space:nowrap}
.photo-bar button{font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:6px 10px;cursor:pointer}
.photo-bar button[aria-pressed=true]{background:#f4ecdc;color:#1a1410}
.photo-bar .shutter{background:#c8102e;border-color:#c8102e;font-weight:700}
.photo-bar .hint{opacity:.65;font-size:11px;margin:0 6px}
.photo-flash{position:fixed;inset:0;background:#fff;z-index:902;pointer-events:none;animation:photo-flash .35s ease-out forwards}
@keyframes photo-flash{from{opacity:.9}to{opacity:0}}`;

export class PhotoMode {
  /** Override if the game renders through a post composer (e.g. `() => post.render()`). */
  render = () => this.renderer.render(this.scene, this.camera);
  private company = '';
  private date = '';
  private filter = 0;
  private opened = false;
  private saved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private anchor = new THREE.Vector3();
  private target = new THREE.Vector3();
  private yaw = 0; private pitch = 0.3; private dist = 6;
  private els: HTMLElement[] = [];
  private frame!: HTMLCanvasElement;
  private fbtns: HTMLButtonElement[] = [];
  private prevFilter = '';

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera,
    private hideUi: (hidden: boolean) => void) {}

  /** Text for the hanko stamp; call before open(). */
  setLabel(company: string, date: string): void { this.company = company; this.date = date; }
  isOpen(): boolean { return this.opened; }

  open(target: THREE.Vector3): void {
    if (this.opened) return;
    this.opened = true;
    this.saved.pos.copy(this.camera.position); this.saved.quat.copy(this.camera.quaternion);
    this.anchor.copy(target).y += 1.2;
    this.target.copy(this.anchor);
    const off = this.camera.position.clone().sub(this.target);
    this.dist = THREE.MathUtils.clamp(off.length(), 1, 25);
    this.yaw = Math.atan2(off.x, off.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(off.y / (off.length() || 1)), -0.2, 1.5);

    const style = document.createElement('style'); style.textContent = CSS;
    this.frame = document.createElement('canvas'); this.frame.className = 'photo-frame';
    const bar = document.createElement('div'); bar.className = 'photo-bar';
    const btn = (label: string, fn: () => void, cls = '') => {
      const b = document.createElement('button'); b.textContent = label; b.className = cls;
      b.onclick = () => { fn(); b.blur(); }; bar.append(b); return b;
    };
    this.fbtns = FILTERS.map(([name], i) => btn(name, () => this.setFilter(i)));
    btn('Shutter', () => this.shoot(), 'shutter');
    btn('Close', () => this.close());
    const hint = document.createElement('span'); hint.className = 'hint';
    hint.textContent = 'Drag orbit · Wheel zoom · WASD move · Q/E down/up · Esc exit';
    bar.append(hint);
    this.els = [style, this.frame, bar];
    document.head.append(style); document.body.append(this.frame, bar);

    this.prevFilter = this.renderer.domElement.style.filter;
    this.setFilter(this.filter);
    addEventListener('keydown', this.onKey, true);
    this.hideUi(true);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.camera.position.copy(this.saved.pos); this.camera.quaternion.copy(this.saved.quat);
    this.renderer.domElement.style.filter = this.prevFilter;
    removeEventListener('keydown', this.onKey, true);
    this.els.forEach((e) => e.remove()); this.els = []; this.fbtns = [];
    this.hideUi(false);
  }

  setFilter(i: number): void {
    this.filter = i;
    if (this.opened) this.renderer.domElement.style.filter = FILTERS[i][1];
    this.fbtns.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  }

  update(dt: number, input: { dragX: number; dragY: number; wheel: number; held(...codes: string[]): boolean }): void {
    if (!this.opened) return;
    this.yaw -= input.dragX * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.dragY * 0.004, -0.2, 1.5);
    this.dist = THREE.MathUtils.clamp(this.dist * (1 + input.wheel * 0.12), 1, 25);
    const k = (a: string, b: string) => (input.held(a) ? 1 : 0) - (input.held(b) ? 1 : 0);
    const mx = k('KeyD', 'KeyA'), mz = k('KeyW', 'KeyS'), sp = 6 * dt;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.target.x += (c * mx - s * mz) * sp;
    this.target.z += (-s * mx - c * mz) * sp;
    this.target.y = THREE.MathUtils.clamp(this.target.y + k('KeyE', 'KeyQ') * sp, 0.2, 20);
    // ponytail: leash of 40m around the open point, no collision; add a world raycast if clipping into walls bothers anyone
    const dx = this.target.x - this.anchor.x, dz = this.target.z - this.anchor.z, d = Math.hypot(dx, dz);
    if (d > 40) { this.target.x = this.anchor.x + dx / d * 40; this.target.z = this.anchor.z + dz / d * 40; }
    const cp = Math.cos(this.pitch);
    this.camera.position.set(s * cp, Math.sin(this.pitch), c * cp).multiplyScalar(this.dist).add(this.target);
    this.camera.position.y = Math.max(0.2, this.camera.position.y);
    this.camera.lookAt(this.target);

    const src = this.renderer.domElement;
    if (this.frame.width !== src.width || this.frame.height !== src.height) {
      this.frame.width = src.width; this.frame.height = src.height; // resizing also clears it
      this.drawFrame(this.frame.getContext('2d')!, src.width, src.height);
    }
  }

  /** Renders a frame, bakes filter + frame + stamp into a PNG, downloads it, and returns the data URL. */
  shoot(): string {
    this.render();
    const src = this.renderer.domElement;
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d')!;
    ctx.filter = FILTERS[this.filter][1]; // ponytail: needs ctx.filter (Chrome/Firefox, Safari 18+); older Safari saves unfiltered
    ctx.drawImage(src, 0, 0); // same task as render(), so the drawing buffer is still valid
    ctx.filter = 'none';
    this.drawFrame(ctx, c.width, c.height);
    const url = c.toDataURL('image/png');
    const a = document.createElement('a'); a.href = url; a.download = `sushi-photo-${Date.now()}.png`; a.click();
    const flash = document.createElement('div'); flash.className = 'photo-flash';
    flash.onanimationend = () => flash.remove();
    document.body.append(flash);
    return url;
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Escape') return;
    e.stopImmediatePropagation(); // keep the game's Input from also seeing Esc (would open the pause menu)
    this.close();
  };

  /** Cream print border + red hanko stamp; shared by the live overlay and the saved PNG. */
  private drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const m = Math.min(w, h), b = Math.round(m * 0.035);
    ctx.fillStyle = '#f4ecdc';
    ctx.fillRect(0, 0, w, b); ctx.fillRect(0, h - b, w, b); ctx.fillRect(0, 0, b, h); ctx.fillRect(w - b, 0, b, h);
    ctx.strokeStyle = 'rgba(40,30,20,.35)'; ctx.lineWidth = Math.max(1, m * 0.002);
    ctx.strokeRect(b, b, w - 2 * b, h - 2 * b);
    if (!this.company && !this.date) return;
    const s = m * 0.15;
    ctx.save();
    ctx.translate(w - b - s * 0.75, h - b - s * 0.75); ctx.rotate(-0.12);
    ctx.globalAlpha = 0.88; ctx.strokeStyle = ctx.fillStyle = '#c8102e';
    ctx.lineWidth = s * 0.06;
    ctx.beginPath(); ctx.roundRect(-s / 2, -s / 2, s, s, s * 0.12); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let fs = s * 0.22;
    do ctx.font = `700 ${fs}px "Hiragino Mincho ProN", "Yu Mincho", serif`; while (ctx.measureText(this.company).width > s * 0.82 && (fs *= 0.9) > s * 0.07);
    ctx.fillText(this.company, 0, -s * 0.13, s * 0.82);
    ctx.fillRect(-s * 0.36, s * 0.04, s * 0.72, s * 0.025);
    ctx.font = `600 ${s * 0.13}px "Hiragino Mincho ProN", "Yu Mincho", serif`;
    ctx.fillText(this.date, 0, s * 0.22, s * 0.82);
    ctx.restore();
  }
}
