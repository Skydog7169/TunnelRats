// WorldRegions: the serializable, seed-derived description of everything
// worldgen v3 placed — capture points, rock-curtain gaps, abandoned workings,
// the enemy network, and the depth-band boundaries backing world.bandAt().
// Later phases read this instead of re-deriving geometry: Phase 2 places
// corpses/salvage in working bounds, Phase 3 treats workings as echo spaces,
// Phase 4 drives capture logic and AI patrols from the point/network data.
//
// HASH POLICY (deliberate — see src/sim/hash.ts header): WorldRegions is
// static, seed-derived data, yet it IS registered in the sim-state hash via
// hashWorldRegions(). That makes the golden test sensitive to worldgen
// regressions — exactly the bug class Stage 4 introduces — at negligible
// cost. The MUTABLE state that will later live alongside these regions
// (flag ownership, half-mast capture progress — Phase 4) MUST be registered
// in the hash when it is introduced; this structure only covers generation
// output.

import type { StateHasher } from './hash';
import { isDiggable, Tile } from './tiles';
import type { World } from './world';

export type BandName = 'shallow' | 'clay' | 'basement';

/** Stable band → byte encoding for hashing (append-only, like ITEM_ORDER). */
export const BAND_ID: Record<BandName, number> = { shallow: 0, clay: 1, basement: 2 };

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number;
}

export interface CapturePointRegion {
  id: number; // 0..4, west → east
  kind: 'trench' | 'crater';
  active: boolean; // v1: ends + center. Activation is data, not geometry.
  footprint: { x0: number; x1: number }; // reserved column range
  floor: Rect; // interior floor rect (the capture volume, roughly)
  flagPole: { x: number; y: number }; // pole BASE tile — below local ground by design
  sapMouths: { x: number; y: number; dir: -1 | 1 }[]; // dir: which way the sap runs
  groundY: number; // local parapet/ground line
}

export interface CurtainGap {
  x: number; // curtain center column at the gap
  y0: number;
  y1: number; // inclusive vertical span
  band: BandName;
  sandGap: boolean; // sand inside the window — fast+loud, a different tactical proposition
  usable: boolean; // 4-tall dig-passable crossing verified after all carving
  tell: { x: number; y: number } | null; // seam anchor on the west face (null = tells disabled)
}

export interface CurtainRegion {
  id: number; // == interval index (0..3)
  x0: number;
  x1: number; // horizontal extent including edge warp
  gaps: CurtainGap[];
}

export interface WorkingRegion {
  id: number;
  bounds: Rect; // bounding region (Phase 2: corpses/salvage; Phase 3: echo space)
  sealed: boolean; // no air path out without digging (batch-validated)
}

export interface NetworkBranch {
  id: number;
  kind: 'drive' | 'stub';
  deadEnd: boolean; // exactly one drive: the abandoned drive (connected, goes nowhere)
  nodes: { x: number; y: number }[]; // floor-line waypoints, in dig order
}

export interface EnemyNetworkRegion {
  sapMouth: { x: number; y: number }; // where connectivity validation floods from
  branches: NetworkBranch[];
  segments: Rect[]; // carved air rects (debug view + hashing)
  tileCount: number;
}

export interface WorldRegions {
  points: CapturePointRegion[];
  curtains: CurtainRegion[];
  workings: WorkingRegion[];
  enemyNetwork: EnemyNetworkRegion;
  /** Per-column band boundaries backing world.bandAt(). Plain arrays: serializable. */
  bands: { shallowBottomY: number[]; clayBottomY: number[] };
}

// ---------------------------------------------------------------------------
// Hashing — fixed field order, append-only (same contract as the hash header).
// ---------------------------------------------------------------------------

function hashRect(h: StateHasher, r: Rect): void {
  h.u32(r.x0);
  h.u32(r.y0);
  h.u32(r.x1);
  h.u32(r.y1);
}

export function hashWorldRegions(h: StateHasher, r: WorldRegions): void {
  h.u32(r.points.length);
  for (const p of r.points) {
    h.u32(p.id);
    h.byte(p.kind === 'trench' ? 0 : 1);
    h.bool(p.active);
    h.u32(p.footprint.x0);
    h.u32(p.footprint.x1);
    hashRect(h, p.floor);
    h.u32(p.flagPole.x);
    h.u32(p.flagPole.y);
    h.u32(p.sapMouths.length);
    for (const m of p.sapMouths) {
      h.u32(m.x);
      h.u32(m.y);
      h.byte(m.dir === 1 ? 1 : 0);
    }
    h.u32(p.groundY);
  }
  h.u32(r.curtains.length);
  for (const c of r.curtains) {
    h.u32(c.id);
    h.u32(c.x0);
    h.u32(c.x1);
    h.u32(c.gaps.length);
    for (const g of c.gaps) {
      h.u32(g.x);
      h.u32(g.y0);
      h.u32(g.y1);
      h.byte(BAND_ID[g.band]);
      h.bool(g.sandGap);
      h.bool(g.usable);
      h.bool(g.tell !== null);
      if (g.tell) {
        h.u32(g.tell.x);
        h.u32(g.tell.y);
      }
    }
  }
  h.u32(r.workings.length);
  for (const w of r.workings) {
    h.u32(w.id);
    hashRect(h, w.bounds);
    h.bool(w.sealed);
  }
  const n = r.enemyNetwork;
  h.u32(n.sapMouth.x);
  h.u32(n.sapMouth.y);
  h.u32(n.branches.length);
  for (const b of n.branches) {
    h.u32(b.id);
    h.byte(b.kind === 'drive' ? 0 : 1);
    h.bool(b.deadEnd);
    h.u32(b.nodes.length);
    for (const nd of b.nodes) {
      h.u32(nd.x);
      h.u32(nd.y);
    }
  }
  h.u32(n.segments.length);
  for (const s of n.segments) hashRect(h, s);
  h.u32(n.tileCount);
  h.u32(r.bands.shallowBottomY.length);
  for (const v of r.bands.shallowBottomY) h.u32(v);
  h.u32(r.bands.clayBottomY.length);
  for (const v of r.bands.clayBottomY) h.u32(v);
}

// ---------------------------------------------------------------------------
// Dig-passability — the shared definition Part D/H validation is built on.
// ---------------------------------------------------------------------------

/**
 * A tile you can PASS while digging your own tunnel: open air (incl. ladder /
 * flag-pole cells) or any diggable material. Rock and water are impassable —
 * air-adjacency is NOT enough for a gap; a water pocket sitting in one kills it.
 */
export function isDigPassable(t: Tile): boolean {
  return t === Tile.Air || t === Tile.Ladder || t === Tile.FlagPole || isDiggable(t);
}

/**
 * Usable-gap check (the Part D definition, exactly): does a flood-fill over
 * dig-passable tiles connect the west side of the box to the east side, with
 * enough clearance that a standard `clearance`-tall tunnel can exist the whole
 * way? A cell participates only if the `clearance` rows below-and-including it
 * are all dig-passable. Pure integer BFS — sim-safe, reused by worldgen (gen-
 * time usability flags) and the batch validator (independent recheck).
 */
export function tunnelCrossingExists(
  world: World,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  clearance: number,
): boolean {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(world.w - 1, x1);
  y1 = Math.min(world.h - 1 - clearance, y1);
  if (x1 <= x0 || y1 < y0) return false;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;

  const open = new Uint8Array(bw * bh); // 1 = clearance-tall window fits here
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let ok = true;
      for (let r = 0; r < clearance; r++) {
        if (!isDigPassable(world.getTile(x, y + r))) {
          ok = false;
          break;
        }
      }
      if (ok) open[(y - y0) * bw + (x - x0)] = 1;
    }
  }

  // BFS from every open cell on the west edge; succeed on reaching the east edge.
  const visited = new Uint8Array(bw * bh);
  const queue: number[] = [];
  for (let y = 0; y < bh; y++) {
    const i = y * bw;
    if (open[i]) {
      visited[i] = 1;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const bx = i % bw;
    const by = (i / bw) | 0;
    if (bx === bw - 1) return true;
    if (bx > 0 && open[i - 1] && !visited[i - 1]) (visited[i - 1] = 1), queue.push(i - 1);
    if (bx < bw - 1 && open[i + 1] && !visited[i + 1]) (visited[i + 1] = 1), queue.push(i + 1);
    if (by > 0 && open[i - bw] && !visited[i - bw]) (visited[i - bw] = 1), queue.push(i - bw);
    if (by < bh - 1 && open[i + bw] && !visited[i + bw]) (visited[i + bw] = 1), queue.push(i + bw);
  }
  return false;
}
