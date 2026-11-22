// The UI-to-game interface: what the UI may call on the game. Implemented by Game (src/game.ts).
import * as THREE from 'three';
import { DistrictId } from '../core/data';
import { Avatar, GameState } from '../core/state';

export interface UIHost {
  /** Live game state. Mutate only through src/core/actions.ts, or the plain cosmetic fields. */
  s: GameState;
  camera: THREE.PerspectiveCamera;
  started: boolean; // false while on the title screen
  hasSave(): boolean;
  newGame(opts: { name: string; company: string; avatar: Avatar }): void;
  continueGame(): void;
  importSave(code: string): string | null; // error message or null on success (game reloads)
  exportSave(): string;
  deleteSave(): void;
  save(): boolean;
  travel(d: DistrictId): void;
  applySettings(): void; // call after changing s.settings
  refreshWorld(): void; // call after restaurant cosmetic changes (name, signColor, theme, uniform)
  /** Property id of the owned restaurant the player is in/near, else null. */
  currentSite(): string | null;
  setPaused(p: boolean): void;
  /** Tycoon time speed: 1, 2 or 4 (sim + NPCs run faster). Pause is separate (setPaused). Keys 1/2/3 also set it. */
  speed: number;
  /** True while the pause menu or the pause button has stopped the simulation. */
  paused: boolean;
  setSpeed(n: 1 | 2 | 4): void;
}
