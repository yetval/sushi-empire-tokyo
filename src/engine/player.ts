// Player controller: camera-relative movement with acceleration, sprint, jump, collisions.
import * as THREE from 'three';
import { Character } from './character';
import { World } from './collision';
import { Input } from './input';

const WALK = 4.2, RUN = 7.5, ACCEL = 30, DECEL = 22, GRAV = 26, JUMP = 8.5;

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  grounded = true;
  locked = false;
  override: 'cook' | 'interact' | 'cheer' | null = null;
  stepDist = 0;
  private lastGood: [number, number] | null = null;
  onStep: () => void = () => {};

  constructor(public char: Character, private world: World) {}

  update(dt: number, input: Input, camYaw: number): void {
    let ix = 0, iz = 0;
    if (!this.locked) {
      if (input.held('KeyW', 'ArrowUp')) iz -= 1;
      if (input.held('KeyS', 'ArrowDown')) iz += 1;
      if (input.held('KeyA', 'ArrowLeft')) ix -= 1;
      if (input.held('KeyD', 'ArrowRight')) ix += 1;
    }
    const len = Math.hypot(ix, iz);
    const running = input.held('ShiftLeft', 'ShiftRight');
    const max = running ? RUN : WALK;
    // camera-relative: forward = away from camera
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const want = new THREE.Vector3();
    if (len > 0) want.addScaledVector(fwd, -iz / len).addScaledVector(right, ix / len).multiplyScalar(max);
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const diff = want.clone().sub(hv);
    const rate = (len > 0 ? ACCEL : DECEL) * dt;
    if (diff.length() <= rate) hv.copy(want); else hv.addScaledVector(diff.normalize(), rate);
    this.vel.x = hv.x; this.vel.z = hv.z;

    if (!this.locked && input.enabled && this.grounded && input.pressed('Space')) { this.vel.y = JUMP; this.grounded = false; }
    this.vel.y -= GRAV * dt;
    const prevX = this.pos.x, prevZ = this.pos.z;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y <= 0) { this.pos.y = 0; this.vel.y = 0; this.grounded = true; }
    this.world.resolve(this.pos, 0.38);
    // narrow gaps can leave the push-out oscillating inside a wall: fall back to the last good spot
    if (this.world.overlaps(this.pos, 0.38)) {
      // narrow gaps can leave the push-out stuck inside a wall: fall back to the previous spot, or the last
      // grounded spot that was clear (the previous one may have been mid-air above a prop)
      const back = !this.world.overlaps(new THREE.Vector3(prevX, this.pos.y, prevZ), 0.38) ? [prevX, prevZ] : this.lastGood;
      if (back) { this.pos.x = back[0]; this.pos.z = back[1]; this.vel.x = this.vel.z = 0; }
    } else if (this.grounded) this.lastGood = [this.pos.x, this.pos.z];

    const sp = hv.length();
    if (sp > 0.3) {
      const target = Math.atan2(hv.x, hv.z);
      let d = target - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 12);
      if (this.grounded) {
        this.stepDist += sp * dt;
        const stride = running ? 1.3 : 0.9;
        if (this.stepDist > stride) { this.stepDist = 0; this.onStep(); }
      }
    }
    this.char.root.position.copy(this.pos);
    this.char.root.rotation.y = this.yaw;
    this.char.speed = sp;
    this.char.anim = this.override ?? (!this.grounded ? 'jump' : sp > 5 ? 'run' : sp > 0.2 ? 'walk' : 'idle');
    this.char.update(dt);
  }

  teleport(x: number, z: number, yaw: number): void {
    this.pos.set(x, 0, z); this.vel.set(0, 0, 0); this.yaw = yaw;
    this.char.root.position.copy(this.pos); this.char.root.rotation.y = yaw;
  }
}
