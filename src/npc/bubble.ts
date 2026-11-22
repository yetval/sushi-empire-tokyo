// Speech bubbles: camera-facing sprites with cached canvas textures + a separate patience bar
// (bar is a scaled sprite, so patience changes never redraw a texture).
import * as THREE from 'three';

// LRU cache of bubble textures; textures still shown by a live bubble are never disposed.
const cache = new Map<string, { tex: THREE.CanvasTexture; aspect: number }>();
const users = new Map<THREE.Texture, number>();
const CACHE_MAX = 64;
// textures drawn before the web font loaded use a fallback face: drop unused ones once fonts are ready
document.fonts?.ready.then(() => { for (const [k, e] of cache) if (!users.get(e.tex)) { e.tex.dispose(); cache.delete(k); } });

function texFor(text: string, accent: string): { tex: THREE.CanvasTexture; aspect: number } {
  const key = text + '|' + accent;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = '700 34px "Zen Maru Gothic", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 40, h = 72;
  c.width = w; c.height = h + 14;
  g.font = font;
  g.fillStyle = '#ffffff'; g.strokeStyle = accent; g.lineWidth = 5;
  g.beginPath(); if (g.roundRect) g.roundRect(3, 3, w - 6, h - 6, 22); else g.rect(3, 3, w - 6, h - 6); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(w / 2 - 10, h - 4); g.lineTo(w / 2, h + 10); g.lineTo(w / 2 + 10, h - 4); g.closePath(); g.fill();
  g.fillStyle = '#2b2430'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const v = { tex, aspect: c.width / c.height };
  if (cache.size >= CACHE_MAX) for (const [k, e] of cache) { if (!users.get(e.tex)) { e.tex.dispose(); cache.delete(k); break; } }
  cache.set(key, v);
  return v;
}

export class Bubble {
  readonly group = new THREE.Group();
  private sprite: THREE.Sprite;
  private bar: THREE.Sprite;
  private barBg: THREE.Sprite;
  private key = '';

  constructor(height = 2.15) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
    this.barBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#3a3340', depthTest: false }));
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#5ad16b', depthTest: false }));
    for (const [sp, o] of [[this.sprite, 20], [this.barBg, 21], [this.bar, 22]] as const) sp.renderOrder = 900 + o;
    // centered on x: the group inherits the character's yaw, so any x offset would swing around
    this.barBg.position.set(0, -0.06, 0); this.bar.position.set(0, -0.06, 0);
    this.barBg.scale.set(0.8, 0.075, 1);
    this.group.add(this.sprite, this.barBg, this.bar);
    this.group.position.y = height;
    this.group.visible = false;
  }

  /** text null hides. bar = patience 0..1 or null for none. */
  set(text: string | null, bar: number | null = null, accent = '#ff6b6b'): void {
    if (!text) { this.group.visible = false; return; }
    this.group.visible = true;
    const k = text + accent;
    if (k !== this.key) {
      this.key = k;
      const { tex, aspect } = texFor(text, accent);
      this.release();
      users.set(tex, (users.get(tex) ?? 0) + 1);
      this.sprite.material.map = tex; this.sprite.material.needsUpdate = true;
      const hgt = 0.36;
      this.sprite.scale.set(hgt * aspect, hgt, 1);
      this.sprite.position.y = 0.2;
    }
    const showBar = bar !== null;
    this.bar.visible = this.barBg.visible = showBar;
    if (showBar) {
      const f = Math.max(0.02, Math.min(1, bar!));
      this.bar.scale.set(0.78 * f, 0.055, 1);
      this.bar.material.color.set(f > 0.55 ? '#5ad16b' : f > 0.28 ? '#ffc83d' : '#ff5a5a');
    }
  }

  private release(): void {
    const old = this.sprite.material.map;
    if (old) users.set(old, Math.max(0, (users.get(old) ?? 1) - 1));
  }

  dispose(): void {
    this.release();
    this.group.removeFromParent();
    for (const sp of [this.sprite, this.bar, this.barBg]) sp.material.dispose();
  }
}
