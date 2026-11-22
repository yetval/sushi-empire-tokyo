// Third-person orbit camera: drag to rotate, wheel to zoom, smooth follow, pulls in to avoid walls.
import * as THREE from 'three';
import { World } from './collision';

export class ThirdPersonCamera {
  yaw = Math.PI; // camera yaw around target (0 = camera at +z looking -z)
  pitch = 0.32;
  dist = 7;
  private curDist = 7;
  private target = new THREE.Vector3();
  sensitivity = 1;
  invertY = false;
  /** Optional override (e.g. scripted screenshots). Set to null to return to follow mode. */
  focus: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

  private trauma = 0; private dip = 0; private dipV = 0; private fovKick = 0; private baseFov: number;

  constructor(public cam: THREE.PerspectiveCamera, private world: World) { this.baseFov = cam.fov; }

  /** Add shake trauma (0..1); decays in ~0.5s, offset ∝ trauma². */
  shake(amount: number): void { this.trauma = Math.min(1, this.trauma + amount); }
  /** Landing dip: the camera bobs down and springs back. */
  land(strength = 1): void { this.dipV -= 2.4 * strength; }
  /** Call every frame: sprinting widens the FOV a touch. */
  sprint(on: boolean, dt: number): void { this.fovKick += ((on ? 6 : 0) - this.fovKick) * (1 - Math.exp(-dt * 5)); }

  private juice(dt: number): void {
    this.dipV += (-70 * this.dip - 10 * this.dipV) * dt; this.dip += this.dipV * dt;
    this.cam.position.y += this.dip;
    if (this.trauma > 0.001) {
      const a = this.trauma * this.trauma * 0.22;
      this.cam.position.x += (Math.random() - 0.5) * a; this.cam.position.y += (Math.random() - 0.5) * a; this.cam.position.z += (Math.random() - 0.5) * a;
      this.trauma = Math.max(0, this.trauma - dt * 2);
    }
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.cam.fov - fov) > 0.01) { this.cam.fov = fov; this.cam.updateProjectionMatrix(); }
  }

  input(dx: number, dy: number, wheel: number): void {
    this.yaw -= dx * 0.005 * this.sensitivity;
    this.pitch += dy * 0.004 * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -0.15, 1.25);
    this.dist = THREE.MathUtils.clamp(this.dist + wheel * 0.8, 2.5, 16);
  }

  snap(p: THREE.Vector3): void { this.target.copy(p).add(new THREE.Vector3(0, 1.5, 0)); this.curDist = this.dist; this.update(1, p, true); }

  update(dt: number, player: THREE.Vector3, instant = false): void {
    if (this.focus) {
      const k = instant ? 1 : 1 - Math.exp(-dt * 5);
      this.cam.position.lerp(this.focus.pos, k);
      const look = new THREE.Vector3();
      this.cam.getWorldDirection(look);
      const want = this.focus.look.clone().sub(this.cam.position).normalize();
      look.lerp(want, k);
      this.cam.lookAt(this.cam.position.clone().add(look));
      this.juice(dt);
      return;
    }
    const goal = player.clone().add(new THREE.Vector3(0, 1.5, 0));
    this.target.lerp(goal, instant ? 1 : 1 - Math.exp(-dt * 12));
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const hit = this.world.raycast(this.target, dir, this.dist + 0.3);
    const want = Math.max(0.3, Math.min(this.dist, hit - 0.35));
    // walls pull in instantly (never see through them); zooming and easing back out stay smooth
    const wallLimited = want < this.dist - 1e-3;
    if (instant || (wallLimited && want < this.curDist)) this.curDist = want;
    else this.curDist += (want - this.curDist) * (1 - Math.exp(-dt * (want < this.curDist ? 10 : 3)));
    const pos = this.target.clone().addScaledVector(dir, this.curDist);
    pos.y = Math.max(0.3, pos.y);
    this.cam.position.copy(pos);
    this.cam.lookAt(this.target);
    this.juice(dt);
  }
}
