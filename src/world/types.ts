// CONTRACT between world (src/world), NPCs (src/npc) and the game orchestrator (src/game.ts).
// Coordinates: y up, ground at y=0, meters. A Spot's yaw follows the character convention:
// yaw = atan2(dirX, dirZ), i.e. yaw 0 faces +z.
import * as THREE from 'three';
import { DistrictId } from '../core/data';
import { GameState } from '../core/state';
import { Collider } from '../engine/collision';

export interface Spot { x: number; z: number; yaw: number }
export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

export interface RestaurantSite {
  id: string; // property id (PROPERTIES key)
  door: Spot; // just outside the entrance; customers walk here from the sidewalk
  counter: Spot; // where the PLAYER stands to take orders / serve (behind the counter, facing guests)
  prep: Spot; // where the PLAYER stands to cook (prep station)
  queue: Spot[]; // customer queue in front of counter, index 0 = front (facing counter)
  seats: Spot[]; // ALL seat spots for the max seat level; the NPC system only uses the first activeSeats
  chefs: Spot[]; // chef work spots (length >= property chefSlots + 4)
  servers: Spot[]; // server idle spots (length >= serverSlots)
  cleaner: Spot; manager: Spot;
  interior: Rect; // footprint used to hide the roof when the player is inside
  sign: Spot; // "For Sale" sign / plaque the player interacts with when not owned
  counterTop: THREE.Vector3; // world point on the counter surface where ready plates appear
}

export interface StoryNpc { id: 'kenji' | 'mika' | 'sato' | 'ryo' | 'aoki'; name: string; spot: Spot }

export interface DistrictScene {
  id: DistrictId;
  group: THREE.Group; // add to scene
  colliders: Collider[]; // static colliders (walls, buildings, counters, props)
  spawn: Spot; // player arrival point (near metro)
  metro: Spot; // metro entrance: interact → travel map
  supplier: Spot | null; // supplier shop counter: interact → buy ingredients
  hq: Spot | null; // headquarters entrance (Shinjuku); visible building grows with state.hq
  sites: RestaurantSite[]; // every property in this district (owned or for sale)
  walkPaths: THREE.Vector3[][]; // closed loops along sidewalks for pedestrians (y=0)
  edges: Spot[]; // off-screen-ish points where NPCs appear/disappear
  storyNpcs: StoryNpc[];
  /** Per-frame animation of local scenery. night: 0 day .. 1 full night. */
  update(dt: number, night: number, playerPos: THREE.Vector3): void;
  /** Rebuild visuals of one property from state (owned or for-sale, upgrades, sign color, theme, HQ). */
  refresh(s: GameState): void;
  dispose(): void;
}
