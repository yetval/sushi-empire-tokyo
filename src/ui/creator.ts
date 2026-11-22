// Character creator with a live rotating 3D preview (own small renderer, shared between uses).
import * as THREE from 'three';
import { audio } from '../audio/audio';
import { Avatar } from '../core/state';
import { Character } from '../engine/character';
import { el, esc } from './dom';

const SKINS = ['#ffdbac', '#f5d0b0', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a21'];
const HAIRS = ['#1b1b1b', '#2b1d14', '#5a3825', '#a0522d', '#d4a373', '#f2d16b', '#7b7b7b', '#e85d75', '#3d7dd8', '#3d2b56'];
const SHIRTS = ['#ffffff', '#e63946', '#ff8a5c', '#ffc93c', '#2ec27e', '#3fa7ff', '#2b2d42', '#9b5de5', '#ff6fa8', '#1d3557'];
const HAIR_STYLES = ['Short', 'Spiky', 'Long', 'Bun', 'Bald'];
const NAMES: Record<string, string> = {
  '#ffdbac': 'Porcelain', '#f5d0b0': 'Peach', '#f1c27d': 'Honey', '#e0ac69': 'Golden', '#c68642': 'Caramel', '#8d5524': 'Chestnut', '#5c3a21': 'Espresso',
  '#1b1b1b': 'Black', '#2b1d14': 'Dark brown', '#5a3825': 'Brown', '#a0522d': 'Auburn', '#d4a373': 'Light brown', '#f2d16b': 'Blond', '#7b7b7b': 'Grey', '#e85d75': 'Pink', '#3d7dd8': 'Blue', '#3d2b56': 'Plum',
  '#ffffff': 'White', '#e63946': 'Red', '#ff8a5c': 'Salmon', '#ffc93c': 'Yellow', '#2ec27e': 'Green', '#2b2d42': 'Navy', '#9b5de5': 'Purple', '#ff6fa8': 'Rose', '#1d3557': 'Indigo',
};
const HEADWEAR = ['None', 'Chef Hat', 'Headband', 'Cap'];

let renderer: THREE.WebGLRenderer | null = null;

export interface Creator { el: HTMLElement; avatar: Avatar; name: string; company: string; dispose(): void }

export function makeCreator(initial: Avatar, opts: { name?: string; company?: string; showNames: boolean }): Creator {
  const avatar: Avatar = { ...initial };
  const c: Creator = { el: el('div', 'creator'), avatar, name: opts.name ?? '', company: opts.company ?? '', dispose };

  // --- 3D preview
  const canvas = el('canvas', 'preview');
  renderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const r = renderer;
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(220, 290, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#ffb38a', 1.6));
  const sun = new THREE.DirectionalLight('#fff4e0', 2); sun.position.set(2, 3, 3); scene.add(sun);
  const cam = new THREE.PerspectiveCamera(30, 220 / 290, 0.1, 20);
  cam.position.set(0, 1.1, 4.4); cam.lookAt(0, 0.85, 0);
  const ch = new Character(avatar, { apron: true });
  scene.add(ch.root);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.06, 32), new THREE.MeshStandardMaterial({ color: '#ffe3c4' }));
  disc.position.y = -0.03; scene.add(disc);
  let spin = 0.4, raf = 0, last = performance.now(), dragging = false, waveT = 1.5;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!dragging) spin += dt * 0.6;
    waveT -= dt;
    ch.anim = waveT > 0 ? 'wave' : 'idle';
    ch.root.rotation.y = spin;
    ch.update(dt);
    r.render(scene, cam);
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(r.domElement, 0, 0, canvas.width, canvas.height); }
  };
  canvas.width = 440; canvas.height = 580;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) spin += e.movementX * 0.02; });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.title = 'Drag to rotate';
  loop();

  // --- controls
  const form = el('div', 'grid');
  const sw = (key: keyof Avatar, list: string[], label: string) =>
    `<div><h4>${label}</h4><div class="swatches">${list.map((v) => `<button class="sw ${avatar[key] === v ? 'on' : ''}" style="background:${v}" data-k="${key}" data-v="${v}" aria-pressed="${avatar[key] === v}" aria-label="${label}: ${NAMES[v] ?? v}" title="${NAMES[v] ?? v}"></button>`).join('')}</div></div>`;
  const opt = (key: keyof Avatar, list: string[], label: string) =>
    `<div><h4>${label}</h4><div class="row wrap">${list.map((n, i) => `<button class="opt ${avatar[key] === i ? 'on' : ''}" data-k="${key}" data-n="${i}" aria-pressed="${avatar[key] === i}">${n}</button>`).join('')}</div></div>`;
  const render = () => {
    form.innerHTML = (opts.showNames ? `<div class="grid g2">
        <label class="field">Chef name<input type="text" maxlength="18" id="cr-name" value="${esc(c.name)}" placeholder="Your name"></label>
        <label class="field">Company name<input type="text" maxlength="24" id="cr-co" value="${esc(c.company)}" placeholder="Sushi Empire"></label></div>` : '') +
      sw('skin', SKINS, 'Skin tone') + opt('hairStyle', HAIR_STYLES, 'Hair style') + sw('hair', HAIRS, 'Hair color') +
      sw('shirt', SHIRTS, 'Shirt') + opt('headwear', HEADWEAR, 'Headwear');
    form.querySelector<HTMLInputElement>('#cr-name')?.addEventListener('input', (e) => { c.name = (e.target as HTMLInputElement).value; });
    form.querySelector<HTMLInputElement>('#cr-co')?.addEventListener('input', (e) => { c.company = (e.target as HTMLInputElement).value; });
  };
  form.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
    if (!b) return;
    const k = b.dataset.k as keyof Avatar;
    (avatar as any)[k] = b.dataset.v ?? Number(b.dataset.n);
    audio.sfx('pop');
    ch.setAvatar(avatar);
    waveT = 0.8;
    const sel = b.dataset.v ? `[data-k="${k}"][data-v="${b.dataset.v}"]` : `[data-k="${k}"][data-n="${b.dataset.n}"]`;
    render();
    form.querySelector<HTMLElement>(sel)?.focus();
  });
  render();
  const left = el('div', 'grid');
  left.style.alignContent = 'start';
  left.append(canvas);
  const rnd = el('button', 'btn small ghost', 'Randomize');
  rnd.onclick = () => {
    const p = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    Object.assign(avatar, { skin: p(SKINS), hair: p(HAIRS), shirt: p(SHIRTS), hairStyle: Math.floor(Math.random() * 5), headwear: Math.floor(Math.random() * 4) });
    ch.setAvatar(avatar); waveT = 1; audio.sfx('pop'); render();
  };
  left.append(rnd);
  c.el.append(left, form);

  function dispose() { cancelAnimationFrame(raf); ch.dispose(); disc.geometry.dispose(); }
  return c;
}
