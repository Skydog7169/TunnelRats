// Tile type enum + derived per-type property lookup tables (indexed by tile id
// for cheap access in hot loops). Gameplay numbers come from CONFIG.materials.

import { CONFIG, MaterialKey } from '../config';

export enum Tile {
  Air = 0,
  Topsoil = 1,
  RootMat = 2,
  Clay = 3,
  Sand = 4,
  Chalk = 5,
  Rock = 6,
  Water = 7,
  Rubble = 8, // Phase 2
  Timber = 9, // Phase 2
  Ladder = 10, // non-solid, climbable; trench exits to the surface
  FlagPole = 11, // non-solid, undiggable, INERT in v1 — capture logic is Phase 4
}

export const TILE_COUNT = 12;

const MATERIAL_OF: Record<number, MaterialKey | null> = {
  [Tile.Air]: null,
  [Tile.Topsoil]: 'topsoil',
  [Tile.RootMat]: 'rootMat',
  [Tile.Clay]: 'clay',
  [Tile.Sand]: 'sand',
  [Tile.Chalk]: 'chalk',
  [Tile.Rock]: 'rock',
  [Tile.Water]: 'water',
  [Tile.Rubble]: 'rubble',
  [Tile.Timber]: 'timber',
  [Tile.Ladder]: null, // special: non-solid, climbable, undiggable
  [Tile.FlagPole]: null, // special: non-solid, undiggable; a tile so it survives serialization
};

export const TILE_NAME: string[] = [
  'air', 'topsoil', 'root mat', 'clay', 'sand', 'chalk', 'rock', 'water', 'rubble', 'timber', 'ladder', 'flag pole',
];

// Flat lookup tables, indexed by tile id.
export const TILE_SOLID = new Uint8Array(TILE_COUNT);
export const TILE_DIG_TICKS = new Float32Array(TILE_COUNT); // 0 = undiggable
export const TILE_STABILITY = new Float32Array(TILE_COUNT);
export const TILE_NOISE_RADIUS = new Float32Array(TILE_COUNT);

for (let t = 0; t < TILE_COUNT; t++) {
  const mat = MATERIAL_OF[t];
  if (mat === null) {
    TILE_SOLID[t] = 0;
    continue;
  }
  const m = CONFIG.materials[mat];
  TILE_SOLID[t] = 1; // everything but air is solid in v1 (water is inert/solid)
  // FRACTIONAL ticks are legal (r9, 4px tiles): fast materials need < 1 tick
  // per tile or the integer floor silently multiplies their physical dig time
  // as tiles shrink. digProgress is float; a swing's share clears several
  // sub-tick tiles at once, exactly like it splits across a window.
  TILE_DIG_TICKS[t] = m.digTime > 0 ? m.digTime * CONFIG.sim.tickRate : 0;
  TILE_STABILITY[t] = m.stability;
  TILE_NOISE_RADIUS[t] = m.noiseRadius;
}

export function isDiggable(t: Tile): boolean {
  return TILE_DIG_TICKS[t] > 0;
}
