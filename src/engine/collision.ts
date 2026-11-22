// Static axis-aligned box colliders. Player = circle in XZ; camera = ray vs boxes.
import * as THREE from 'three';

/** camera:false = player-only (low counters); player:false = camera-only (awnings, canopies). */
export interface Collider { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; camera?: boolean; player?: boolean }

/** Box centered at (x, z) with size (w, d), height h from ground. `camera` false = player-only (e.g. low counters). */
export function boxCollider(x: number, z: number, w: number, d: number, h = 3, camera = h > 1.6): Collider {
  return { minX: x - w / 2, maxX: x + w / 2, minY: 0, maxY: h, minZ: z - d / 2, maxZ: z + d / 2, camera };
}

/** Collider from an object's world bounding box. */
export function colliderFromObject(o: THREE.Object3D, pad = 0): Collider {
  const b = new THREE.Box3().setFromObject(o);
  return { minX: b.min.x - pad, maxX: b.max.x + pad, minY: b.min.y, maxY: b.max.y, minZ: b.min.z - pad, maxZ: b.max.z + pad, camera: b.max.y - b.min.y > 1.6 };
}

export class World {
  colliders: Collider[] = [];

  /** Push a circle at pos (feet y) out of every overlapping box. Mutates pos. */
  resolve(pos: THREE.Vector3, r: number, height = 1.6): void {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.colliders) {
        if (c.player === false) continue;
        if (pos.y > c.maxY - 0.05 || pos.y + height < c.minY) continue;
        const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
        const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
        let dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pos.x += (dx / d) * (r - d); pos.z += (dz / d) * (r - d);
        } else {
          // center inside box: push out along smallest axis
          const px = Math.min(pos.x - c.minX, c.maxX - pos.x), pz = Math.min(pos.z - c.minZ, c.maxZ - pos.z);
          if (px < pz) pos.x = pos.x - c.minX < c.maxX - pos.x ? c.minX - r : c.maxX + r;
          else pos.z = pos.z - c.minZ < c.maxZ - pos.z ? c.minZ - r : c.maxZ + r;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  /** True if a circle at pos still overlaps any player-blocking box (used to undo a bad push-out). */
  overlaps(pos: THREE.Vector3, r: number, height = 1.6): boolean {
    for (const c of this.colliders) {
      if (c.player === false || pos.y > c.maxY - 0.05 || pos.y + height < c.minY) continue;
      const dx = pos.x - Math.max(c.minX, Math.min(pos.x, c.maxX)), dz = pos.z - Math.max(c.minZ, Math.min(pos.z, c.maxZ));
      if (dx * dx + dz * dz < r * r * 0.8) return true;
    }
    return false;
  }

  /** Distance along ray to first camera-blocking box, or maxDist. */
  raycast(o: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    let best = maxDist;
    for (const c of this.colliders) {
      if (c.camera === false) continue;
      let tmin = 0, tmax = best;
      for (const [oa, da, mn, mx] of [[o.x, dir.x, c.minX, c.maxX], [o.y, dir.y, c.minY, c.maxY], [o.z, dir.z, c.minZ, c.maxZ]]) {
        if (Math.abs(da) < 1e-9) { if (oa < mn || oa > mx) { tmin = Infinity; break; } continue; }
        let t1 = (mn - oa) / da, t2 = (mx - oa) / da;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { tmin = Infinity; break; }
      }
      if (tmin < best && tmin > 0) best = tmin;
    }
    return best;
  }
}
