// Owner overview: O lifts the camera from the street to a tilted "architect's model" of the district (post.ts adds
// tilt-shift once the camera is high). Pan with WASD/arrows or the screen edge, wheel zooms, drag rotates.
// Hovering a restaurant or For Sale lot outlines it with a small label; clicking opens its sheet. O or Esc drops back.
import * as THREE from 'three';
import type { Game } from '../game';
import { audio } from '../audio/audio';
import { PROPERTIES } from '../core/data';
import { restaurantKPIs } from '../core/empire';
import { yen } from '../core/format';
import { icon } from '../ui/icons';
import { DistrictScene } from '../world/types';

const PITCH = 0.9; // ~52° down
const DIST_MIN = 40, DIST_MAX = 110, DIST_START = 68; // along the view ray: 31..86 m up, starts ~53 m
const BLEND_S = 1; // rise / drop duration
const EDGE_PX = 14; // screen-edge pan band
const SITE_H = 6; // height of the pick / outline box over a site footprint
const HEALTH = { good: ['#5b8a4a', 'Running well'], warn: ['#d99a2b', 'Needs attention'], bad: ['#c8452f', 'Losing money'] } as const;

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
.ov-label { position: fixed; z-index: 40; pointer-events: none; min-width: 170px; max-width: 260px; padding: 8px 11px 9px;
  background: #f6efe2; color: #2b2622; border: 2px solid #2b2622; border-radius: 6px; box-shadow: 0 3px 0 rgba(43,38,34,.35);
  font: 500 13px/1.4 var(--body, system-ui); }
.ov-label b { display: block; font: 400 16px/1.2 var(--display, serif); margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-label span { display: flex; align-items: center; gap: 6px; }
.ov-label i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ov-label em { display: block; margin-top: 4px; font-style: normal; font-size: 12px; color: #c8452f; }
.ov-hint { position: fixed; z-index: 40; pointer-events: none; left: 50%; top: 122px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; background: rgba(246,239,226,.94); color: #2b2622; border: 2px solid #2b2622; border-radius: 999px;
  font: 500 13px/1.3 var(--body, system-ui); white-space: nowrap; transition: opacity .3s; }
.ov-hint b { color: #c8452f; font-weight: 700; }
`;

export class Overview {
  /** True while in (or rising into) the overview; false while dropping back or on the street. */
  active = false;
  private t = 0; // 0 street .. 1 overview
  private center = new THREE.Vector3();
  private yaw = 0;
  private dist = DIST_START;
  private boxes: { id: string; box: THREE.Box3 }[] = [];
  private bounds = new THREE.Box2();
  private builtFor: DistrictScene | null = null;
  private mouse = { x: 0, y: 0, over: false, downX: 0, downY: 0 };
  private hover: string | null = null;
  private labelT = 0;
  private ray = new THREE.Raycaster();
  private hit = new THREE.Vector3();
  private pose = new THREE.PerspectiveCamera(); // a camera so lookAt aims -z
  private _focus = new THREE.Vector3();
  private outline = new THREE.Group();
  private lineMat = new THREE.LineBasicMaterial({ color: '#f6efe2', depthTest: false, depthWrite: false, transparent: true });
  private fillMat = new THREE.MeshBasicMaterial({ color: '#f6efe2', depthTest: false, depthWrite: false, transparent: true, opacity: 0.22 });
  private label = document.createElement('div');
  private hint = document.createElement('div');

  constructor(private g: Game) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.label.className = 'ov-label'; this.label.hidden = true;
    this.hint.className = 'ov-hint'; this.hint.style.opacity = '0';
    this.hint.innerHTML = `${icon('map', 16)}<span><b>Overview</b> &nbsp;WASD / edge to pan · wheel zoom · drag to turn · click a shop · <b>O</b> or <b>Esc</b> to walk</span>`;
    document.body.append(this.label, this.hint);

    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), this.lineMat);
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, -0.48, 0), this.fillMat);
    for (const o of [lines, fill]) { o.renderOrder = 999; o.frustumCulled = false; }
    this.outline.add(lines, fill);
    this.outline.visible = false;
    g.scene.add(this.outline);

    const canvas = g.renderer.domElement;
    addEventListener('pointermove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.over = e.target === canvas; });
    document.documentElement.addEventListener('mouseleave', () => { this.mouse.over = false; });
    addEventListener('blur', () => { this.mouse.over = false; });
    canvas.addEventListener('pointerdown', (e) => { this.mouse.downX = e.clientX; this.mouse.downY = e.clientY; });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 0 && Math.hypot(e.clientX - this.mouse.downX, e.clientY - this.mouse.downY) < 6) this.click();
    });
  }

  /** Where sky/shadows should centre: blends from the avatar to the overview's ground point. */
  get focus(): THREE.Vector3 { return this.t > 0 ? this._focus : this.g.player.pos; }

  toggle(): void { if (this.active) this.exit(); else this.enter(); }

  enter(): void {
    if (this.t === 0) { // fresh rise: start over the avatar, looking the same way as the street camera
      this.build(this.g.district);
      this.center.set(this.g.player.pos.x, 0, this.g.player.pos.z);
      this.clampCenter();
      this.yaw = this.g.cam.yaw;
      this.dist = DIST_START;
    }
    this.active = true;
    audio.sfx('whoosh', 0.5);
  }

  /** Drop back to the avatar (instant on district change). */
  exit(instant = false): void {
    if (this.active && !instant) audio.sfx('whoosh', 0.4);
    this.active = false;
    if (instant) { this.t = 0; this.setHover(null); this.hint.style.opacity = '0'; }
  }

  /** Call after the street camera's update: blends the camera toward the overview pose and handles pan/zoom/hover. */
  update(dt: number): void {
    const g = this.g, inp = g.input;
    if (g.district !== this.builtFor) this.build(g.district);
    this.t = THREE.MathUtils.clamp(this.t + (this.active ? dt : -dt) / BLEND_S, 0, 1);
    const k = ease(this.t);
    this.hint.style.opacity = this.active && k > 0.5 ? '1' : '0';
    if (k <= 0) { this.setHover(null); return; }

    if (this.active && inp.enabled) {
      let fwd = 0, right = 0;
      if (inp.held('KeyW', 'ArrowUp')) fwd += 1;
      if (inp.held('KeyS', 'ArrowDown')) fwd -= 1;
      if (inp.held('KeyD', 'ArrowRight')) right += 1;
      if (inp.held('KeyA', 'ArrowLeft')) right -= 1;
      if (this.mouse.over && this.t >= 1) {
        if (this.mouse.x < EDGE_PX) right -= 1; else if (this.mouse.x > innerWidth - EDGE_PX) right += 1;
        if (this.mouse.y < EDGE_PX) fwd += 1; else if (this.mouse.y > innerHeight - EDGE_PX) fwd -= 1;
      }
      const sp = this.dist * 0.7 * dt * (inp.held('ShiftLeft', 'ShiftRight') ? 2 : 1);
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      this.center.x += (-sy * fwd + cy * right) * sp;
      this.center.z += (-cy * fwd - sy * right) * sp;
      this.clampCenter();
      this.yaw -= inp.dragX * 0.005 * g.cam.sensitivity;
      this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(inp.wheel * 0.12), DIST_MIN, DIST_MAX);
    }

    const cp = Math.cos(PITCH);
    this.pose.position.set(this.center.x + Math.sin(this.yaw) * cp * this.dist, Math.sin(PITCH) * this.dist, this.center.z + Math.cos(this.yaw) * cp * this.dist);
    this.pose.lookAt(this.center);
    const cam = g.camera; // holds this frame's street pose: blend from it, so dropping back lands exactly on the avatar camera
    cam.position.lerp(this.pose.position, k);
    cam.quaternion.slerp(this.pose.quaternion, k);
    cam.updateMatrixWorld();
    this._focus.copy(g.player.pos).lerp(this.center, k);

    this.setHover(this.active && this.t >= 1 && inp.enabled && this.mouse.over ? this.pick() : null);
    if (this.hover) {
      if ((this.labelT -= dt) <= 0) { this.labelT = 0.5; this.label.innerHTML = this.labelHTML(this.hover); }
      const w = this.label.offsetWidth, h = this.label.offsetHeight;
      this.label.style.left = `${Math.min(this.mouse.x + 18, innerWidth - w - 8)}px`;
      this.label.style.top = `${Math.min(this.mouse.y + 18, innerHeight - h - 8)}px`;
    }
  }

  private build(d: DistrictScene): void {
    this.builtFor = d;
    this.boxes = d.sites.map((st) => {
      const r = st.interior;
      const box = new THREE.Box3(new THREE.Vector3(r.minX, 0, r.minZ), new THREE.Vector3(r.maxX, SITE_H, r.maxZ));
      box.expandByPoint(new THREE.Vector3(st.sign.x, 0, st.sign.z)); // lots: the For Sale sign sits out front
      return { id: st.id, box };
    });
    this.bounds.makeEmpty();
    for (const path of d.walkPaths) for (const p of path) this.bounds.expandByPoint(new THREE.Vector2(p.x, p.z));
    for (const b of this.boxes) { this.bounds.expandByPoint(new THREE.Vector2(b.box.min.x, b.box.min.z)); this.bounds.expandByPoint(new THREE.Vector2(b.box.max.x, b.box.max.z)); }
  }

  private clampCenter(): void {
    if (this.bounds.isEmpty()) return;
    this.center.x = THREE.MathUtils.clamp(this.center.x, this.bounds.min.x, this.bounds.max.x);
    this.center.z = THREE.MathUtils.clamp(this.center.z, this.bounds.min.y, this.bounds.max.y);
  }

  private pick(): string | null {
    const rc = this.g.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((this.mouse.x - rc.left) / rc.width) * 2 - 1, -((this.mouse.y - rc.top) / rc.height) * 2 + 1), this.g.camera);
    let best: string | null = null, bd = Infinity;
    for (const b of this.boxes) {
      if (!this.ray.ray.intersectBox(b.box, this.hit)) continue;
      const d = this.hit.distanceToSquared(this.ray.ray.origin);
      if (d < bd) { bd = d; best = b.id; }
    }
    return best;
  }

  private click(): void {
    if (!this.active || this.t < 1 || this.g.ui.isBlocking()) return;
    const id = this.pick();
    if (!id) return;
    audio.sfx('click');
    if (this.g.s.restaurants[id]) this.g.ui.openRestaurant(id); else this.g.ui.openProperty(id);
  }

  private setHover(id: string | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.outline.visible = !!id;
    this.label.hidden = !id;
    this.g.renderer.domElement.style.cursor = id ? 'pointer' : '';
    if (!id) return;
    const box = this.boxes.find((b) => b.id === id)!.box;
    box.getCenter(this.outline.position);
    box.getSize(this.outline.scale);
    const k = this.g.s.restaurants[id] ? restaurantKPIs(this.g.s).find((x) => x.id === id) : undefined;
    const color = k ? HEALTH[k.health][0] : '#f6efe2';
    this.lineMat.color.set(color); this.fillMat.color.set(color);
    this.labelT = 0; // refresh the label text this frame
  }

  private labelHTML(id: string): string {
    const s = this.g.s, p = PROPERTIES[id], r = s.restaurants[id];
    if (!r) return `<b>${esc(p.name)}</b><span><i style="background:#c8452f"></i>For sale · ${yen(p.price)}</span><em>Click to view the lot</em>`;
    const k = restaurantKPIs(s).find((x) => x.id === id);
    if (!k) return `<b>${esc(r.name)}</b>`;
    const [color, text] = HEALTH[k.health];
    const status = k.health === 'bad' && !k.automated ? 'No chef: sells nothing' : text;
    const money = k.profitYesterday !== null ? `${yen(k.profitYesterday)}/day profit` : `${yen(k.revToday)} sales today`;
    return `<b>${esc(r.name)}</b><span><i style="background:${color}"></i>${status}</span><span>${icon('yen', 14)}${money}</span><em>Click to manage</em>`;
  }
}
