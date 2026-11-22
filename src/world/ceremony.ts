// Grand-opening beat when a lot is bought (~3.4 s): a kōhaku (red/white) curtain on a cream frame rises over the
// new shopfront, a ribbon across the door pops (confetti), the curtain draws open and the frame sinks away.
// Self-contained: listens to the 'purchase' bus event; game.ts only constructs it and calls update(dt) each frame.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { audio } from '../audio/audio';
import { on } from '../core/bus';
import { PROPERTIES } from '../core/data';
import type { Fx } from '../fx/fx';
import type { DistrictScene, RestaurantSite } from './types';

const CREAM = '#f6efe2', INK = '#2b2622', VERMILION = '#c8452f', GOLD = '#c9a45c';
const DUR = 3.4, POP = 1.0, OPEN0 = 1.25, OPEN1 = 2.3, SINK0 = 2.55;

const ease = (k: number) => k * k * (3 - 2 * k);
const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
const backOut = (k: number) => 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);

interface Beat {
  group: THREE.Group; t: number; popped: boolean; opened: boolean;
  halves: THREE.Mesh[]; ribbon: THREE.Object3D[]; bow: THREE.Object3D;
  bowW: THREE.Vector3; postsW: THREE.Vector3[];
}

export class Ceremonies {
  private beats: Beat[] = [];
  private pending: string[] = [];
  private d: DistrictScene | null = null;
  private off: () => void;

  constructor(private scene: THREE.Scene, private district: () => DistrictScene | null | undefined, private fx?: Fx) {
    // ponytail: defer to update() so the beat is built after 'restaurantsChanged' rebuilt the shopfront
    this.off = on('purchase', (e) => this.pending.push(e.what));
  }

  update(dt: number): void {
    const d = this.district() ?? null;
    if (d !== this.d) { this.clear(); this.d = d; }
    if (this.pending.length) {
      for (const id of this.pending) { const site = d?.sites.find((x) => x.id === id); if (site) this.beats.push(this.build(site)); }
      this.pending.length = 0;
    }
    for (const b of this.beats) this.step(b, dt);
    for (const b of this.beats.filter((x) => x.t >= DUR)) this.kill(b);
    this.beats = this.beats.filter((x) => x.t < DUR);
  }

  dispose(): void { this.off(); this.clear(); }

  private clear(): void { this.beats.forEach((b) => this.kill(b)); this.beats = []; }

  private kill(b: Beat): void {
    b.group.removeFromParent();
    b.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mt = m.material as THREE.MeshStandardMaterial | undefined;
      mt?.map?.dispose(); mt?.dispose?.();
    });
  }

  private step(b: Beat, dt: number): void {
    const t = (b.t += dt);
    // frame rises out of the ground, later sinks back into it
    b.group.scale.y = t < SINK0 ? Math.max(0.001, backOut(clamp01(t / 0.35))) : Math.max(0.001, 1 - Math.pow(clamp01((t - SINK0) / (DUR - SINK0)), 2));
    // ribbon pops: bow vanishes, halves swing down from their stanchions
    if (!b.popped && t >= POP) {
      b.popped = true;
      audio.sfx('pop');
      this.fx?.sparkleRing(b.bowW);
    }
    const pk = clamp01((t - POP) / 0.45);
    b.bow.scale.setScalar(t < POP ? 1 + 0.08 * Math.sin(t * 14) : Math.max(0.001, 1 - pk * 4));
    const sw = pk === 0 ? 0 : 1.45 * (1 - Math.exp(-pk * 5) * Math.cos(pk * 9));
    b.ribbon[0].rotation.z = -sw; b.ribbon[1].rotation.z = sw;
    // curtain draws open toward the posts, pleats bunching up as it gathers
    const ok = ease(clamp01((t - OPEN0) / (OPEN1 - OPEN0)));
    if (!b.opened && t >= OPEN0) { b.opened = true; audio.sfx('whoosh', 0.6); }
    if (b.opened && ok >= 1 && b.postsW.length) { for (const p of b.postsW) this.fx?.sparkleRing(p); b.postsW = []; }
    for (const h of b.halves) {
      h.scale.x = 1 - 0.86 * ok;
      h.scale.z = 1 + 2.2 * ok + 0.15 * Math.sin(t * 3 + h.id); // gentle billow while closed
    }
  }

  private build(site: RestaurantSite): Beat {
    // shopfront = the interior rect edge the door stands outside of
    const I = site.interior, dx = site.door.x, dz = site.door.z, mx = (I.minX + I.maxX) / 2, mz = (I.minZ + I.maxZ) / 2;
    const edges = [
      { out: I.minX - dx, nx: -1, nz: 0, cx: I.minX, cz: mz, w: I.maxZ - I.minZ },
      { out: dx - I.maxX, nx: 1, nz: 0, cx: I.maxX, cz: mz, w: I.maxZ - I.minZ },
      { out: I.minZ - dz, nx: 0, nz: -1, cx: mx, cz: I.minZ, w: I.maxX - I.minX },
      { out: dz - I.maxZ, nx: 0, nz: 1, cx: mx, cz: I.maxZ, w: I.maxX - I.minX },
    ];
    const f = edges.reduce((a, e) => (e.out > a.out ? e : a));
    const stand = PROPERTIES[site.id]?.kind === 'stand';
    const W = f.w + 0.3, H = stand ? 2.7 : 2.4, Z = stand ? 1.0 : 0.75; // hung under the eave/awning (~2.5-2.7 m)

    const g = new THREE.Group();
    g.position.set(f.cx, 0, f.cz);
    g.rotation.y = Math.atan2(f.nx, f.nz);
    const std = (color: string, o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.82, ...o });
    const cream = std(CREAM), ink = std(INK), gold = std(GOLD, { roughness: 0.45, metalness: 0.35 }), red = std(VERMILION, { roughness: 0.7 });
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; parent.add(mesh); return mesh;
    };

    // frame: two bevelled posts with ink feet and gold finials, a cream top beam
    for (const s of [-1, 1]) {
      const x = s * (W / 2 + 0.1);
      add(new RoundedBoxGeometry(0.18, H + 0.25, 0.18, 2, 0.04), cream, x, (H + 0.25) / 2, Z);
      add(new RoundedBoxGeometry(0.34, 0.12, 0.34, 2, 0.03), ink, x, 0.06, Z);
      add(new THREE.SphereGeometry(0.11, 16, 10), gold, x, H + 0.36, Z);
    }
    add(new RoundedBoxGeometry(W + 0.5, 0.22, 0.24, 2, 0.05), cream, 0, H + 0.08, Z);

    // kōhaku curtain: two pleated halves, vertical red/white stripes, gathered toward their posts when opening
    const tex = new THREE.DataTexture(new Uint8Array([0xc8, 0x45, 0x2f, 255, 0xf6, 0xef, 0xe2, 255]), 2, 1);
    tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = Math.max(2, Math.round(W / 2 / 0.5)) / 2; tex.needsUpdate = true;
    const cloth = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide });
    const halves = [-1, 1].map((s) => {
      const geo = new THREE.PlaneGeometry(W / 2, H - 0.05, 28, 1);
      geo.translate(-s * W / 4, (H - 0.05) / 2, 0);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, 0.06 * Math.sin((p.getX(i) / (W / 2)) * Math.PI * 2 * Math.max(2, Math.round(W / 2 / 0.5))));
      geo.computeVertexNormals();
      return add(geo, cloth, s * (W / 2), 0, Z);
    });

    // ribbon across the door between two gold stanchions, with a bow in the middle
    const ux = Math.cos(g.rotation.y), uz = -Math.sin(g.rotation.y);
    const doorX = THREE.MathUtils.clamp((dx - f.cx) * ux + (dz - f.cz) * uz, -W / 2 + 1, W / 2 - 1);
    const rz = Math.min(f.out, 1.6), half = 0.85, ry = 1.0;
    const ribbon: THREE.Object3D[] = [];
    for (const s of [-1, 1]) {
      const x = doorX + s * half;
      add(new THREE.CylinderGeometry(0.03, 0.03, ry + 0.05, 10), gold, x, (ry + 0.05) / 2, rz);
      add(new THREE.CylinderGeometry(0.13, 0.15, 0.05, 18), ink, x, 0.025, rz);
      add(new THREE.SphereGeometry(0.055, 12, 8), gold, x, ry + 0.07, rz);
      const pivot = new THREE.Group(); pivot.position.set(x, ry, rz); g.add(pivot);
      add(new RoundedBoxGeometry(half, 0.1, 0.02, 1, 0.008), red, -s * half / 2, 0, 0, pivot);
      ribbon.push(pivot);
    }
    const bow = new THREE.Group(); bow.position.set(doorX, ry, rz + 0.02); g.add(bow);
    add(new THREE.SphereGeometry(0.06, 12, 8), gold, 0, 0, 0, bow);
    for (const s of [-1, 1]) {
      const loop = add(new THREE.TorusGeometry(0.09, 0.025, 8, 16), red, s * 0.1, 0.02, 0, bow);
      loop.scale.set(1.2, 0.7, 1); loop.rotation.z = s * 0.35;
      const tail = add(new THREE.BoxGeometry(0.05, 0.22, 0.012), red, s * 0.06, -0.13, 0, bow);
      tail.rotation.z = s * 0.3;
    }

    g.scale.y = 0.001;
    this.scene.add(g);
    g.updateMatrixWorld(true);
    const ground = (o: THREE.Object3D, x: number, z: number) => o.localToWorld(new THREE.Vector3(x, 0, z));
    return {
      group: g, t: 0, popped: false, opened: false, halves, ribbon, bow,
      bowW: ground(g, doorX, rz), // sparkleRing: ground ring of sparkles + confetti thrown from ~1.9 m
      postsW: [-1, 1].map((s) => ground(g, s * (W / 2 + 0.1), Z + 0.3)),
    };
  }
}
