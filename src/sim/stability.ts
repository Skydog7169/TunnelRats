// Phase 2 Stage A — the live stability field.
//
// Every OPEN tile (air / ladder / flag pole) with a solid ROOF directly
// overhead gets a score 0..100:
//
//   score = matBase × supportFactor × depthFactor
//
//   matBase       decaying-weight mix of the material stability of the rows
//                 straight up (CONFIG.stability.overburdenRows). Air inside
//                 the window contributes 0, so a thin shell over another void
//                 is precarious for free. A timber tile overhead (stability
//                 100) reads as full shoring through the same table.
//   supportFactor distance to the nearest solid at the SAME row (wall,
//                 pillar, timber; out of bounds counts as rock), capped at
//                 supportScanMax. Within supportSafeDist there is no
//                 penalty; beyond, it falls linearly to spanFloor.
//   depthFactor   overburden pressure below the NATURAL ground line
//                 (world.groundY — carving never relieves pressure).
//
// Open tiles with air overhead score a flat 100 (nothing to fall on you —
// this is also what keeps sky and open trench air out of the heatmap).
// Solid tiles keep the inert per-material mirror (TILE_STABILITY).
//
// DETERMINISM CONTRACT: a tile's score is a pure function of the tiles inside
// a bounded window (supportScanMax horizontally, overburdenRows up) plus the
// frozen groundY line. No score reads another score, so recompute order can
// never matter, and a dirty rect expanded by exactly that window is
// bit-identical to a full pass — the golden run asserts this equivalence.
// The whole array is registered in the state hash (see hash.ts).
// Sim-boundary math rules apply: basic arithmetic + min/max only.

import { CONFIG } from '../config';
import { Tile, TILE_SOLID, TILE_STABILITY } from './tiles';
import type { World } from './world';

const S = CONFIG.stability;

/** Score one OPEN tile. Caller guarantees (x, y) in bounds and non-solid. */
export function scoreOpenTile(world: World, x: number, y: number): number {
  const { w, tiles } = world;
  // Roof check: the tile directly overhead. The map's top row is open sky,
  // not the out-of-bounds "everything is rock" default.
  if (y === 0) return 100;
  if (TILE_SOLID[tiles[(y - 1) * w + x]] !== 1) return 100;

  // Roof material quality straight up.
  let mat = 0;
  let wsum = 0;
  let wgt = 1;
  for (let i = 0; i < S.overburdenRows; i++) {
    const yy = y - 1 - i;
    const t = yy < 0 ? Tile.Rock : tiles[yy * w + x];
    if (TILE_SOLID[t] === 1) mat += wgt * TILE_STABILITY[t];
    wsum += wgt;
    wgt *= S.overburdenDecay;
  }
  const matBase = mat / wsum;

  // Distance to the nearest support at this row. The scan cap is what bounds
  // the incremental dirty window — see world.updateStability.
  let dl = 1;
  while (dl < S.supportScanMax && x - dl >= 0 && TILE_SOLID[tiles[y * w + (x - dl)]] !== 1) dl++;
  let dr = 1;
  while (dr < S.supportScanMax && x + dr < w && TILE_SOLID[tiles[y * w + (x + dr)]] !== 1) dr++;
  const d = dl < dr ? dl : dr;
  const supportFactor =
    d <= S.supportSafeDist
      ? 1
      : 1 - (1 - S.spanFloor) * ((d - S.supportSafeDist) / (S.supportScanMax - S.supportSafeDist));

  const depth = y - world.groundY[x];
  const depthFactor = depth <= 0 ? 1 : Math.max(S.depthFloor, 1 - depth * S.depthPenaltyPerTile);

  return matBase * supportFactor * depthFactor;
}

/**
 * Recompute stability for every tile in the rect (inclusive, clamped to the
 * map). Solid tiles get the material mirror; open tiles get scored.
 */
export function recomputeStabilityRect(
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const { w, h, tiles, stability } = world;
  const ax0 = Math.max(0, x0);
  const ay0 = Math.max(0, y0);
  const ax1 = Math.min(w - 1, x1);
  const ay1 = Math.min(h - 1, y1);
  for (let y = ay0; y <= ay1; y++) {
    for (let x = ax0; x <= ax1; x++) {
      const i = y * w + x;
      stability[i] =
        TILE_SOLID[tiles[i]] === 1 ? TILE_STABILITY[tiles[i]] : scoreOpenTile(world, x, y);
    }
  }
}
