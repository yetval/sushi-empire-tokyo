// Title-screen flyover: a slow cinematic camera behind the title UI. It drifts along Asakusa's street in the
// morning, then circles high over Shibuya at dusk, and loops. Real game rendering, no video. Each shot runs
// for `dur` seconds, with the camera path built from the live district's own spots (spawn, restaurant sites),
// so it follows whatever the world builders put there. The game swaps districts during a fade between shots.
import * as THREE from 'three';
import type { DistrictId } from '../core/data';
import type { DistrictScene } from '../world/types';

interface Shot {
  district: DistrictId;
  minute: number; // time of day shown
  dur: number;
  /** camera position and look target for t in 0..1 */
  pose(d: DistrictScene, t: number): { pos: THREE.Vector3; look: THREE.Vector3 };
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** Centroid of the district's restaurant sites (falls back to the spawn point). */
function centre(d: DistrictScene): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const s of d.sites) c.add(new THREE.Vector3(s.door.x, 0, s.door.z));
  return d.sites.length ? c.divideScalar(d.sites.length) : new THREE.Vector3(d.spawn.x, 0, d.spawn.z);
}

const SHOTS: Shot[] = [
  { // Asakusa morning: a low dolly along the street, past Grandpa Kenji's stand
    district: 'asakusa', minute: 8 * 60 + 40, dur: 22,
    pose(d, t) {
      const st = d.sites.find((s) => s.id === 'asakusa_stand') ?? d.sites[0];
      const at = st ? new THREE.Vector3(st.door.x, 0, st.door.z) : centre(d);
      const k = ease(t);
      const pos = new THREE.Vector3(at.x - 16 + 26 * k, 11 - 3 * k, at.z + 19 - 3 * k);
      const look = new THREE.Vector3(at.x - 3 + 8 * k, 1.6, at.z - 1);
      return { pos, look };
    },
  },
  { // Shibuya at dusk: a high, slow arc over the crossing; reads as a miniature (tilt-shift kicks in up high)
    district: 'shibuya', minute: 18 * 60 + 35, dur: 26,
    pose(d, t) {
      const c = centre(d);
      const a = -0.5 + 0.9 * ease(t);
      const pos = new THREE.Vector3(c.x + Math.sin(a) * 32, 56 - 6 * t, c.z + Math.cos(a) * 32); // above the towers, looking down
      return { pos, look: new THREE.Vector3(c.x, 1, c.z) };
    },
  },
  { // Asakusa golden hour: high over the rooftops toward the temple gate
    district: 'asakusa', minute: 17 * 60 + 50, dur: 20,
    pose(d, t) {
      const c = centre(d);
      const k = ease(t);
      const pos = new THREE.Vector3(c.x + 22 - 30 * k, 26 + 4 * k, c.z + 30);
      return { pos, look: new THREE.Vector3(c.x - 6 * k, 2, c.z - 4) };
    },
  },
];

const FADE = 0.9; // seconds of fade-to-black at each end of a shot

export class TitleFlyover {
  private i = 0;
  private t = 0;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  /** District the current shot needs. */
  get district(): DistrictId { return SHOTS[this.i].district; }
  get minute(): number { return SHOTS[this.i].minute; }

  /**
   * Advance and pose the camera. Returns the fade amount (0 = clear, 1 = black) so the caller can
   * cover the district swap, and `next` when the shot just changed (load the new district then).
   */
  update(dt: number, camera: THREE.PerspectiveCamera, d: DistrictScene): { fade: number; next: boolean } {
    const shot = SHOTS[this.i];
    this.t += dt;
    let next = false;
    if (this.t >= shot.dur) { this.t = 0; this.i = (this.i + 1) % SHOTS.length; next = true; }
    const cur = SHOTS[this.i];
    if (d.id === cur.district) {
      const { pos, look } = cur.pose(d, Math.min(1, this.t / cur.dur));
      // first frame of a shot snaps; afterwards a light low-pass keeps it buttery
      const k = this.t < 0.05 ? 1 : Math.min(1, dt * 6);
      this.pos.lerp(pos, k); this.look.lerp(look, k);
      camera.position.copy(this.pos);
      camera.lookAt(this.look);
    }
    const fade = Math.max(0, 1 - this.t / FADE, 1 - (cur.dur - this.t) / FADE);
    return { fade: Math.min(1, fade), next };
  }
}
