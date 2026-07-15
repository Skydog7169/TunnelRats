// Worldgen v3 batch validation (Phase 1.5 Stage 4, Part H). Generates N seeds
// (derived deterministically from CONFIG.validation.batchBaseSeed) and asserts
// the structural contracts per seed:
//   1. beeline blocked          — straight trench→trench line crosses rock/water
//   2. adjacent connectivity    — dig-passable path between every adjacent pair
//   3. curtain gaps             — ≥2 usable gaps per curtain, ≥1 usable in clay,
//                                 each admitting a 4-tall tunnel (Part D definition)
//   4. spacing in band          — every interval within [spacingMin, spacingMax]
//   5. workings sealed          — no air path out of a working without digging
//   6. network connected        — all network air reachable from the enemy sap
//                                 mouth; exactly one branch marked dead-end
//   7. pacing proxy             — dig-cost-weighted Dijkstra between adjacent
//                                 points; first legs must land in the config band
//
// Pacing edge weights (all from config): entering an air tile costs walk time
// (1/walkSpeed); entering a diggable tile costs walk time + digTime ×
// pacingTunnelRows (a real passage clears a player-height column per tile of
// advance — equivalently swings-per-tile × swingPeriod, since one swing's
// progress equals one swing period of tile-ticks). Rock/water are impassable.
// Open air above the natural ground line is impassable OUTSIDE point
// footprints: surface travel is banned by fiat (Stage 5 playtest rule), and
// without the ban every leg would be a ~20 s stroll and the proxy would be
// meaningless. This proxy ignores navigation error and hesitation — it
// UNDER-estimates real crossing time by design; it exists to catch degenerate
// seeds (a 60 s freebie or a 600 s slog) before a human plays them.
//
// Executed headlessly by scripts/worldgen.mjs (npm run test:worldgen).

import { CONFIG, MAX_FEATURELESS_SPAN_TILES } from '../config';
import { hash2 } from '../core/prng';
import { tunnelCrossingExists, WorldRegions } from '../sim/regions';
import { Tile, TILE_DIG_TICKS, TILE_SOLID } from '../sim/tiles';
import { World } from '../sim/world';
import { generateWorld } from '../sim/worldgen';

export interface SeedReport {
  seed: number;
  genMs: number;
  checkMs: number;
  intervals: number[]; // 4, west → east
  gapsPerCurtain: { total: number; usable: number; clayUsable: number; sand: number }[];
  legSeconds: (number | null)[]; // 4 legs west → east; null = unreachable
  featurelessSpans: number[]; // 4 intervals: longest feature-free run, tiles
  failures: string[]; // empty = seed passes
}

export function deriveSeeds(base: number, count: number): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = Math.floor(hash2(base, i, 0x5eed) * 4294967296) >>> 0;
    seeds.push(s === 0 ? base + i + 1 : s);
  }
  return seeds;
}

export function validateSeed(seed: number): SeedReport {
  const world = new World();
  const t0 = Date.now();
  generateWorld(world, seed);
  const genMs = Date.now() - t0;
  const R = world.regions;
  const failures: string[] = [];
  const V = CONFIG.validation;
  const P = CONFIG.gen.points;

  // --- 4. spacing in band ----------------------------------------------------
  const intervals: number[] = [];
  for (let i = 0; i < 4; i++) {
    const iv = R.points[i + 1].footprint.x0 - R.points[i].footprint.x1 - 1;
    intervals.push(iv);
    if (iv < P.spacingMin || iv > P.spacingMax) {
      failures.push(`interval ${i} = ${iv} outside [${P.spacingMin}, ${P.spacingMax}]`);
    }
  }

  // --- 1. beeline blocked ------------------------------------------------------
  {
    const a = R.points[0].flagPole;
    const b = R.points[4].flagPole;
    let blocked = 0;
    const steps = Math.ceil(Math.abs(b.x - a.x) * 2);
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const x = Math.floor(a.x + ((b.x - a.x) * s) / steps);
      const y = Math.floor(a.y + ((b.y - a.y) * s) / steps);
      const i = y * world.w + x;
      if (i === last) continue;
      last = i;
      const t = world.getTile(x, y);
      if (t === Tile.Rock || t === Tile.Water) blocked++;
    }
    if (blocked === 0) failures.push('beeline NOT blocked (no rock/water on the straight line)');
  }

  // --- 2. adjacent-point connectivity (dig-passable flood fill) ---------------
  {
    const reach = digPassableFill(world, R.points[0].flagPole);
    for (let i = 1; i < 5; i++) {
      const p = R.points[i].flagPole;
      if (!reach[p.y * world.w + p.x]) {
        failures.push(`point P${i - 1}→P${i} not dig-passable-connected`);
      }
    }
  }

  // --- 3. curtain gaps ---------------------------------------------------------
  const clearance = Math.ceil(CONFIG.player.height);
  const gapsPerCurtain = R.curtains.map((c) => {
    let usable = 0;
    let clayUsable = 0;
    let sand = 0;
    for (const g of c.gaps) {
      // Independent recheck of the gen-time flag (same Part D definition)
      const ok = tunnelCrossingExists(world, c.x0 - 6, c.x1 + 6, g.y0 - 4, g.y1 + 4, clearance);
      if (ok !== g.usable) {
        failures.push(`curtain ${c.id}: gen-time usable flag disagrees with recheck`);
      }
      if (ok) {
        usable++;
        if (g.band === 'clay') clayUsable++;
      }
      if (g.sandGap) sand++;
    }
    return { total: c.gaps.length, usable, clayUsable, sand };
  });
  gapsPerCurtain.forEach((g, i) => {
    if (g.usable < 2) failures.push(`curtain ${i}: only ${g.usable} usable gaps (<2)`);
    if (g.clayUsable < 1) failures.push(`curtain ${i}: no usable clay-band gap`);
  });

  // --- 5. workings sealed & isolated ------------------------------------------
  for (const wk of R.workings) {
    if (!airSealed(world, wk.bounds)) {
      failures.push(`working ${wk.id} NOT sealed (air escapes its bounds)`);
    }
  }

  // --- 6. enemy network connectivity + exactly one dead end --------------------
  {
    const net = R.enemyNetwork;
    const reach = airFill(world, net.sapMouth);
    let orphaned = 0;
    for (const s of net.segments) {
      for (let y = Math.max(0, s.y0); y <= Math.min(world.h - 1, s.y1); y++) {
        for (let x = Math.max(0, s.x0); x <= Math.min(world.w - 1, s.x1); x++) {
          const i = y * world.w + x;
          if (TILE_SOLID[world.tiles[i]] === 0 && !reach[i]) orphaned++;
        }
      }
    }
    if (orphaned > 0) {
      failures.push(`enemy network: ${orphaned} air tiles NOT reachable from the sap mouth`);
    }
    const deadEnds = net.branches.filter((b) => b.deadEnd);
    if (deadEnds.length !== 1) {
      failures.push(`enemy network: ${deadEnds.length} dead-end branches (want exactly 1)`);
    }
  }

  // --- 8. featureless-span check (Stage 4 follow-up — the punctuation gate's
  // structural counterpart). See featurelessSpan() for the corridor definition.
  const featurelessSpans: number[] = [];
  for (let i = 0; i < 4; i++) {
    const span = featurelessSpan(world, R, i);
    featurelessSpans.push(span);
    if (span > MAX_FEATURELESS_SPAN_TILES) {
      const sPerTile =
        CONFIG.materials.topsoil.digTime * V.pacingTunnelRows + 1 / CONFIG.player.walkSpeed;
      failures.push(
        `interval ${i}: featureless span ${span} tiles > ${MAX_FEATURELESS_SPAN_TILES} ` +
          `(≈${Math.round(span * sPerTile)}s of uninterrupted digging)`,
      );
    }
  }

  // --- 7. pacing proxy ----------------------------------------------------------
  const legSeconds: (number | null)[] = [];
  for (let i = 0; i < 4; i++) {
    const t = digCostShortestPath(world, R, R.points[i].flagPole, R.points[i + 1].flagPole);
    legSeconds.push(t);
    if (t === null) failures.push(`leg P${i}→P${i + 1}: no dig-cost path at all`);
  }
  // The PLAYER's first leg (west home → center-adjacent point) carries the
  // gate. The east first leg is deliberately cheap — the enemy's pre-dug
  // network covers most of it — so it is reported but not gated.
  const westLeg = legSeconds[0];
  if (westLeg !== null && (westLeg < V.pacingMinS || westLeg > V.pacingMaxS)) {
    failures.push(
      `west first leg P0→P1 = ${westLeg.toFixed(0)}s outside [${V.pacingMinS}, ${V.pacingMaxS}]s`,
    );
  }

  return {
    seed,
    genMs,
    checkMs: Date.now() - t0 - genMs,
    intervals,
    gapsPerCurtain,
    legSeconds,
    featurelessSpans,
    failures,
  };
}

/**
 * Longest contiguous horizontal run of FEATURE-FREE columns in the plausible
 * dig corridor of interval `i` (between points i and i+1).
 *
 * Corridor definition (deterministic, documented here): the x range is the
 * interval between the two footprints. The row band spans from one passage
 * height (ceil(player.height)) above the shallower of the two point floors
 * (the band a level digger occupies leaving a sap) down to 16 rows below the
 * deeper floor (room for shallow-ramp drift), clamped per column to start at
 * least 4 rows below the natural ground line (a digger stays underground;
 * surface dips don't count).
 *
 * A column is featureless iff EVERY corridor tile in it is plain topsoil or
 * root mat — anything else (sand pocket, rock/curtain, chalk or clay tell
 * seam, water, rubble/timber, pre-dug air of a working or gallery, band clay)
 * is an event a digger would notice. The threshold MAX_FEATURELESS_SPAN_TILES
 * is derived in config.ts from dig rates × the punctuation ceiling.
 */
function featurelessSpan(world: World, regions: WorldRegions, i: number): number {
  const a = regions.points[i];
  const b = regions.points[i + 1];
  const floorA = a.floor.y1 + 1;
  const floorB = b.floor.y1 + 1;
  const yTop = Math.min(floorA, floorB) - Math.ceil(CONFIG.player.height);
  const yBot = Math.max(floorA, floorB) + 16;

  let run = 0;
  let longest = 0;
  for (let x = a.footprint.x1 + 1; x < b.footprint.x0; x++) {
    const y0 = Math.max(yTop, world.groundY[x] + 4);
    let clean = true;
    for (let y = y0; y <= yBot; y++) {
      const t = world.getTile(x, y);
      if (t !== Tile.Topsoil && t !== Tile.RootMat) {
        clean = false;
        break;
      }
    }
    if (clean) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/** Exposed for the runner script's summary line. */
export function maxFeaturelessSpanTiles(): number {
  return MAX_FEATURELESS_SPAN_TILES;
}

export function runBatch(): { reports: SeedReport[]; pass: boolean } {
  const V = CONFIG.validation;
  const seeds = deriveSeeds(V.batchBaseSeed, V.batchCount);
  const reports = seeds.map(validateSeed);
  return { reports, pass: reports.every((r) => r.failures.length === 0) };
}

// ---------------------------------------------------------------------------
// Flood fills
// ---------------------------------------------------------------------------

function isDigPassableTile(t: number): boolean {
  if (TILE_SOLID[t] === 0) return true; // air / ladder / flag pole
  return TILE_DIG_TICKS[t] > 0; // diggable material; rock & water are 0
}

/** BFS over dig-passable tiles from a start coordinate; returns visited mask. */
function digPassableFill(world: World, from: { x: number; y: number }): Uint8Array {
  return fill(world, from, (t) => isDigPassableTile(t));
}

/** BFS over open (non-solid) tiles only — what you can WALK/climb without digging. */
function airFill(world: World, from: { x: number; y: number }): Uint8Array {
  return fill(world, from, (t) => TILE_SOLID[t] === 0);
}

function fill(
  world: World,
  from: { x: number; y: number },
  passable: (t: number) => boolean,
): Uint8Array {
  const { w, h, tiles } = world;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const start = from.y * w + from.x;
  if (!passable(tiles[start])) return visited;
  visited[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    const tryPush = (j: number) => {
      if (!visited[j] && passable(tiles[j])) {
        visited[j] = 1;
        queue[tail++] = j;
      }
    };
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (y > 0) tryPush(i - w);
    if (y < h - 1) tryPush(i + w);
  }
  return visited;
}

/**
 * Working seal check: flood over OPEN tiles from every open tile inside the
 * bounds; the working is sealed iff the flood never escapes bounds+1 (all
 * carving stayed inside the bounding box, so escaping air = a connection to
 * something foreign — trench, sap, network, surface, or another working).
 */
function airSealed(world: World, b: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const { w, h, tiles } = world;
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let y = Math.max(0, b.y0); y <= Math.min(h - 1, b.y1); y++) {
    for (let x = Math.max(0, b.x0); x <= Math.min(w - 1, b.x1); x++) {
      const i = y * w + x;
      if (TILE_SOLID[tiles[i]] === 0) {
        visited[i] = 1;
        queue.push(i);
      }
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < b.x0 - 1 || x > b.x1 + 1 || y < b.y0 - 1 || y > b.y1 + 1) return false; // escaped
    const tryPush = (j: number) => {
      if (!visited[j] && TILE_SOLID[tiles[j]] === 0) {
        visited[j] = 1;
        queue.push(j);
      }
    };
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (y > 0) tryPush(i - w);
    if (y < h - 1) tryPush(i + w);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dig-cost-weighted Dijkstra (pacing proxy)
// ---------------------------------------------------------------------------

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }

  pop(): { key: number; val: number } {
    const k = this.keys;
    const v = this.vals;
    const top = { key: k[0], val: v[0] };
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

function digCostShortestPath(
  world: World,
  regions: WorldRegions,
  from: { x: number; y: number },
  to: { x: number; y: number },
): number | null {
  const { w, h, tiles } = world;
  const V = CONFIG.validation;
  const walk = 1 / CONFIG.player.walkSpeed;

  // Precompute per-column "surface air allowed" (inside any point footprint)
  const fpAllowed = new Uint8Array(w);
  for (const p of regions.points) {
    for (let x = Math.max(0, p.footprint.x0); x <= Math.min(w - 1, p.footprint.x1); x++) {
      fpAllowed[x] = 1;
    }
  }

  const enterCost = (i: number, x: number, y: number): number => {
    const t = tiles[i];
    if (t === Tile.Rock || t === Tile.Water) return -1;
    if (TILE_SOLID[t] === 0) {
      if (y < world.groundY[x] && fpAllowed[x] === 0) return -1; // surface ban
      return walk;
    }
    return walk + (TILE_DIG_TICKS[t] / CONFIG.sim.tickRate) * V.pacingTunnelRows;
  };

  const dist = new Float64Array(w * h).fill(Infinity);
  const done = new Uint8Array(w * h);
  const heap = new MinHeap();
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  dist[start] = 0;
  heap.push(0, start);

  while (heap.size > 0) {
    const { key: d, val: i } = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === goal) return d;
    const x = i % w;
    const y = (i / w) | 0;
    const relax = (j: number, jx: number, jy: number) => {
      if (done[j]) return;
      const c = enterCost(j, jx, jy);
      if (c < 0) return;
      const nd = d + c;
      if (nd < dist[j]) {
        dist[j] = nd;
        heap.push(nd, j);
      }
    };
    if (x > 0) relax(i - 1, x - 1, y);
    if (x < w - 1) relax(i + 1, x + 1, y);
    if (y > 0) relax(i - w, x, y - 1);
    if (y < h - 1) relax(i + w, x, y + 1);
  }
  return null;
}
