// Worldgen v3 (Phase 1.5 Stage 4): depth-banded strata, a 5-position
// capture-point chain (home trenches · trench lines · fortified crater),
// rock curtains pierced by diggable gaps, sealed abandoned workings, and the
// enemy pre-dug network — all emitted as a serializable WorldRegions object.
//
// Determinism: everything flows from the seeded PRNG (dedicated worldgen
// stream, forked per subsystem so tuning one never reshuffles the others) and
// the stateless position hash. No transcendental math anywhere in here — the
// crater bowl is a plain parabola, curtains warp with value noise.
//
// Recorded lesson (do not relearn): generation carves tunnels as EXPLICIT
// tile regions (carveRun / carveShaft), never by simulating pick swings.

import { CONFIG } from '../config';
import { fbm2, noise1 } from '../core/noise';
import { hash2, PRNG } from '../core/prng';
import {
  BandName,
  CapturePointRegion,
  CurtainGap,
  CurtainRegion,
  EnemyNetworkRegion,
  NetworkBranch,
  Rect,
  tunnelCrossingExists,
  WorkingRegion,
  WorldRegions,
} from './regions';
import { isDiggable, Tile, TILE_SOLID, TILE_STABILITY } from './tiles';
import { World } from './world';

export interface GenResult {
  spawnLeft: { x: number; y: number };
  spawnRight: { x: number; y: number };
  regions: WorldRegions;
}

interface Footprint {
  x0: number;
  x1: number; // inclusive
  kind: 'trench' | 'crater';
}

interface Layout {
  footprints: Footprint[]; // 5, west → east
  intervals: number[]; // 4 gaps between adjacent footprints, tiles
}

interface TrenchBuild {
  x0: number;
  x1: number;
  topY: number;
  floorY: number;
  groundLine: number;
  sapMouths: { x: number; y: number; dir: -1 | 1 }[];
  sapEnds: { x: number; floorY: number; dir: -1 | 1 }[];
  poleBase: { x: number; y: number };
}

export function generateWorld(world: World, seed: number): GenResult {
  const G = CONFIG.gen;
  const root = new PRNG(seed ^ 0x5eed); // dedicated worldgen stream
  // Forked sub-streams: tweaking one subsystem's draw count cannot reshuffle
  // the others (same reason worldgen never shares the live-sim stream).
  const rngPoints = root.fork(11);
  const rngBlobs = root.fork(12);
  const rngCurtains = root.fork(13);
  const rngCrater = root.fork(14);
  const rngNetwork = root.fork(15);
  const rngWorkings = root.fork(16);

  const layout = layoutPointChain(world.w, rngPoints);

  fillStrata(world, seed);
  stampBlobs(world, rngBlobs, seed + 61, Tile.Sand, G.sandPockets, layout);
  stampBlobs(world, rngBlobs, seed + 83, Tile.Water, G.waterPockets, layout);

  const curtains = stampCurtains(world, rngCurtains, seed, layout);

  // --- Capture points (west → east; world.trenches[0] MUST stay the west home
  // trench — inHomeTrench() and the armorer gate depend on it) --------------
  const points: CapturePointRegion[] = [];
  const builds: (TrenchBuild | null)[] = [];
  for (let i = 0; i < 5; i++) {
    const f = layout.footprints[i];
    if (f.kind === 'trench') {
      const dirs: (-1 | 1)[] = i === 0 ? [1] : i === 4 ? [-1] : [1, -1];
      const b = carveTrenchPoint(world, f, dirs);
      builds.push(b);
      points.push({
        id: i,
        kind: 'trench',
        active: (G.points.active as readonly number[]).includes(i),
        footprint: { x0: f.x0, x1: f.x1 },
        floor: { x0: b.x0, y0: b.topY, x1: b.x1, y1: b.floorY - 1 },
        flagPole: b.poleBase,
        sapMouths: b.sapMouths,
        groundY: b.groundLine,
      });
    } else {
      builds.push(null);
      points.push(carveCrater(world, rngCrater, seed, f, i));
    }
  }

  // --- Enemy pre-dug network (east side only — the player digs their own war)
  const east = builds[4]!;
  const network = carveNetwork(world, rngNetwork, layout, curtains, east);

  // --- Abandoned workings (after everything with air, so isolation scans see it)
  const workings = carveWorkings(world, rngWorkings, layout, curtains);

  // --- Stability mirror + light ---------------------------------------------
  for (let i = 0; i < world.tiles.length; i++) {
    world.stability[i] = TILE_STABILITY[world.tiles[i]];
  }
  world.computeSunlightFull();

  // --- Final gap flags (after ALL carving: the network may tunnel through a
  // gap, which only ever adds air) -------------------------------------------
  finalizeGaps(world, curtains);

  const regions: WorldRegions = {
    points,
    curtains,
    workings,
    enemyNetwork: network,
    bands: {
      shallowBottomY: Array.from(world.bandShallowBottomY),
      clayBottomY: Array.from(world.bandClayBottomY),
    },
  };
  world.regions = regions;
  return {
    spawnLeft: pointSpawn(world, 0),
    spawnRight: pointSpawn(world, 4),
    regions,
  };
}

/**
 * Deterministic spawn position at a capture point (Stage 5 `?start=` support):
 * a few tiles beside the flag pole, feet on the local floor. Works for
 * trenches and the crater alike because carving keeps surfaceY = floor row.
 * The start point is a SIM INPUT (like the seed): same seed + same start +
 * same commands ⇒ identical state.
 */
export function pointSpawn(world: World, pointId: number): { x: number; y: number } {
  const p = world.regions.points[pointId];
  const sx = p.flagPole.x + (pointId === 4 ? 6 : -6);
  return { x: sx, y: world.surfaceY[sx] - 0.5 };
}

// ===========================================================================
// Part A — point chain layout + the spacing constraint (an ASSERT, not a hope)
// ===========================================================================

function layoutPointChain(w: number, rng: PRNG): Layout {
  const P = CONFIG.gen.points;
  const widths = [P.homeFootprint, P.lineFootprint, P.craterFootprint, P.lineFootprint, P.homeFootprint];
  const kinds: Footprint['kind'][] = ['trench', 'trench', 'crater', 'trench', 'trench'];
  const fixed = 2 * P.edgeMargin + widths.reduce((a, b) => a + b, 0);
  const span = w - fixed;

  // The 4 intervals must EXACTLY fill `span` (the home trenches are pinned to
  // the edges), so feasibility is pure arithmetic — see the config comment.
  if (span < 4 * P.spacingMin) {
    throw new Error(
      `worldgen: infeasible point spacing — available span ${span} < 4×spacingMin ` +
        `${4 * P.spacingMin}. Widen the map or shrink footprints/spacingMin.`,
    );
  }
  if (span > 4 * P.spacingMax) {
    throw new Error(
      `worldgen: infeasible point spacing — available span ${span} > 4×spacingMax ` +
        `${4 * P.spacingMax}; every interval would be forced ABOVE spacingMax. ` +
        `Narrow the map, grow footprints, or raise spacingMax.`,
    );
  }

  // Zero-sum seeded jitter: intervals always sum to span exactly.
  const jit = [0, 1, 2, 3].map(() => rng.range(-P.spacingJitter, P.spacingJitter));
  const mean = (jit[0] + jit[1] + jit[2] + jit[3]) / 4;
  const intervals = jit.map((j) => Math.round(span / 4 + j - mean));
  intervals[3] = span - intervals[0] - intervals[1] - intervals[2];

  for (const iv of intervals) {
    if (iv < P.spacingMin || iv > P.spacingMax) {
      throw new Error(
        `worldgen: interval ${iv} outside spacing band [${P.spacingMin}, ${P.spacingMax}] — ` +
          `spacingJitter too large for the available span (see config note).`,
      );
    }
  }

  const footprints: Footprint[] = [];
  let x = P.edgeMargin;
  for (let i = 0; i < 5; i++) {
    footprints.push({ x0: x, x1: x + widths[i] - 1, kind: kinds[i] });
    x += widths[i] + (i < 4 ? intervals[i] : 0);
  }
  return { footprints, intervals };
}

// ===========================================================================
// Part B — strata as depth bands: shallow (topsoil) / clay / basement (chalk→rock)
// ===========================================================================

function fillStrata(world: World, seed: number): void {
  const G = CONFIG.gen;
  const B = G.bands;
  const { w, h, tiles } = world;

  for (let x = 0; x < w; x++) {
    const surf = Math.round(
      G.surfaceBaseY + (noise1(seed + 11, x * G.surfaceFreq) - 0.5) * 2 * G.surfaceAmp,
    );
    world.surfaceY[x] = surf;
    world.groundY[x] = surf; // frozen natural ground line (carving updates surfaceY only)

    const shallowBot = Math.round(
      surf + B.shallowThickness + (noise1(seed + 23, x * B.warpFreq) - 0.5) * 2 * B.shallowAmp,
    );
    const clayBot = Math.round(
      B.clayBottomY + (noise1(seed + 37, x * B.warpFreq) - 0.5) * 2 * B.clayBottomAmp,
    );
    world.bandShallowBottomY[x] = shallowBot;
    world.bandClayBottomY[x] = clayBot;
    const rockTop = clayBot + B.basementChalkRows;

    for (let y = 0; y < h; y++) {
      let t: Tile;
      if (y < surf) {
        t = Tile.Air;
      } else if (y < shallowBot) {
        // Shallow band: topsoil with root mats near the surface
        if (
          y - surf < G.rootMatDepth &&
          fbm2(seed + 41, x * 0.03, y * 0.03, 2) > G.rootMatThreshold
        ) {
          t = Tile.RootMat;
        } else {
          t = Tile.Topsoil;
        }
      } else if (y < clayBot) {
        // Clay band with occasional loam lenses
        t = fbm2(seed + 53, x * 0.0125, y * 0.0225, 2) > G.loamLensThreshold ? Tile.Topsoil : Tile.Clay;
      } else if (y < rockTop - B.chalkRockDither) {
        t = Tile.Chalk;
      } else if (y < rockTop) {
        // Chalk shading into rock: speckled transition, position-hashed
        const frac = (y - (rockTop - B.chalkRockDither)) / B.chalkRockDither;
        t = hash2(seed + 97, x, y) < frac ? Tile.Rock : Tile.Chalk;
      } else {
        t = Tile.Rock;
      }
      if (y >= h - G.bedrockRows) t = Tile.Rock;
      tiles[y * w + x] = t;
    }
  }
}

// ===========================================================================
// Blob features (sand + water; rock blobs are gone — curtains own blocking)
// ===========================================================================

interface BlobSpec {
  count: number;
  rMin: number;
  rMax: number;
  yMin: number;
  yMax: number;
}

function stampBlobs(
  world: World,
  rng: PRNG,
  noiseSeed: number,
  tile: Tile,
  spec: BlobSpec,
  layout: Layout,
): void {
  const G = CONFIG.gen;
  const { w, h } = world;

  for (let n = 0; n < spec.count; n++) {
    const rx = rng.range(spec.rMin, spec.rMax);
    const ry = rx * rng.range(0.5, 1.0); // squashed ellipses read as strata pockets

    // Rejection-sample a center clear of every point footprint (radius-aware).
    let cx = -1;
    const reach = rx * 1.6 + G.blobPointMargin;
    for (let attempt = 0; attempt < 20; attempt++) {
      const c = rng.range(16, w - 16);
      if (!layout.footprints.some((f) => c > f.x0 - reach && c < f.x1 + reach)) {
        cx = c;
        break;
      }
    }
    if (cx < 0) continue; // no clear spot found — drop this blob
    const cy = rng.range(spec.yMin, spec.yMax);

    const x0 = Math.max(0, Math.floor(cx - rx * 1.6));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx * 1.6));
    const y0 = Math.max(0, Math.floor(cy - ry * 1.6));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry * 1.6));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cur = world.tiles[y * w + x];
        if (cur === Tile.Air || cur === Tile.Rock) continue; // never fill air; respect bedrock
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const edge = 1 + (fbm2(noiseSeed, x * 0.0375, y * 0.0375, 2) - 0.5) * 2 * G.blobEdgeNoise;
        if (dx * dx + dy * dy <= edge) {
          world.tiles[y * w + x] = tile;
        }
      }
    }
  }
}

// ===========================================================================
// Part D — rock curtains & gaps
// ===========================================================================

function stampCurtains(world: World, rng: PRNG, seed: number, layout: Layout): CurtainRegion[] {
  const G = CONFIG.gen;
  const C = G.curtains;
  const B = G.bands;
  const curtains: CurtainRegion[] = [];
  const hh = Math.floor(C.gapHeight / 2);
  const maxHalf = C.thickness / 2 + C.edgeWarpAmp + 1;

  for (let interval = 0; interval < 4; interval++) {
    const ix0 = layout.footprints[interval].x1 + 1;
    const ix1 = layout.footprints[interval + 1].x0 - 1;

    for (let c = 0; c < C.perInterval; c++) {
      // Sub-range so multiple curtains per interval spread out
      const lo = ix0 + C.pointMargin + ((ix1 - ix0 - 2 * C.pointMargin) * c) / C.perInterval;
      const hi = ix0 + C.pointMargin + ((ix1 - ix0 - 2 * C.pointMargin) * (c + 1)) / C.perInterval;
      const cx = Math.round(rng.range(lo, hi));
      const wseed = seed + 211 + interval * 31 + c * 7;

      const ground = world.groundY[cx];
      const shallowBot = world.bandShallowBottomY[cx];
      const clayBot = world.bandClayBottomY[cx];
      const chalkSafeBottom = clayBot + B.basementChalkRows - B.chalkRockDither - 2;

      // Candidate ranges for gap CENTERS per band (kept inside diggable rows).
      const ranges: Record<BandName, [number, number]> = {
        shallow: [ground + C.gapMinDepth + hh, shallowBot - hh - 1],
        clay: [Math.max(shallowBot + hh, ground + C.gapMinDepth + hh), clayBot - hh - 1],
        basement: [clayBot + hh, chalkSafeBottom - hh],
      };

      // A gap window must be free of water (a water pocket in a gap kills it)
      // and of rock (basement dither). Scan wider than the wall so the
      // approach on both sides is clean too.
      const scanHalf = Math.ceil(maxHalf) + 12;
      const windowClean = (cy: number): boolean => {
        for (let y = cy - hh - 4; y <= cy + hh + 4; y++) {
          for (let x = cx - scanHalf; x <= cx + scanHalf; x++) {
            const t = world.getTile(x, y);
            if (t === Tile.Water || t === Tile.Rock) return false;
          }
        }
        return true;
      };

      const gaps: CurtainGap[] = [];
      const count = rng.int(C.gapsMin, C.gapsMax);
      // First gap is ALWAYS in the clay band (the premium stealth route must
      // exist); the rest spread across bands so route choice is a depth choice.
      const bandChoices: BandName[] = ['clay'];
      const all: BandName[] = ['shallow', 'clay', 'basement'];
      for (let g = 1; g < count; g++) bandChoices.push(all[rng.int(0, 2)]);

      for (const band of bandChoices) {
        let [rLo, rHi] = ranges[band];
        if (rLo > rHi) [rLo, rHi] = ranges.clay; // degenerate band range → clay
        let placed = false;
        for (let attempt = 0; attempt < C.gapRetries && !placed; attempt++) {
          const relaxed = attempt >= C.gapRetries - 3; // last tries ignore separation
          const cy = rng.int(rLo, rHi);
          if (!relaxed && gaps.some((g) => Math.abs((g.y0 + g.y1) / 2 - cy) < C.gapMinSeparation)) {
            continue;
          }
          if (!windowClean(cy)) continue;
          const y0 = cy - hh;
          gaps.push({
            x: cx,
            y0,
            y1: y0 + C.gapHeight - 1,
            band,
            sandGap: false, // finalized after all carving
            usable: false,
            tell: null,
          });
          placed = true;
        }
      }

      // Deficit pass: a curtain MUST end with ≥1 clay gap and ≥ gapsMin gaps.
      // When the strict water scan keeps failing (watery seeds), accept any
      // window that satisfies the REAL Part-D usability predicate on the
      // pre-stamp strata, restricted to rows inside the gap span — those rows
      // are skipped at stamping, so the crossing survives the wall.
      const clearance = Math.ceil(CONFIG.player.height);
      const crossingOk = (y0: number, y1: number): boolean =>
        tunnelCrossingExists(world, cx - scanHalf, cx + scanHalf, y0, y1 - clearance + 1, clearance);
      const rescue = (band: BandName): boolean => {
        let [rLo, rHi] = ranges[band];
        if (rLo > rHi) [rLo, rHi] = ranges.clay;
        for (let attempt = 0; attempt < C.gapRetries; attempt++) {
          const cy = rng.int(rLo, rHi);
          if (gaps.some((g) => Math.abs((g.y0 + g.y1) / 2 - cy) < C.gapHeight + 2)) continue;
          const y0 = cy - hh;
          const y1 = y0 + C.gapHeight - 1;
          if (!crossingOk(y0, y1)) continue;
          gaps.push({ x: cx, y0, y1, band, sandGap: false, usable: false, tell: null });
          return true;
        }
        return false;
      };
      let deficitGuard = 0;
      while (!gaps.some((g) => g.band === 'clay') && deficitGuard++ < 6) rescue('clay');
      while (gaps.length < C.gapsMin && deficitGuard++ < 24) {
        rescue(all[rng.int(0, 2)]);
      }

      // Stamp the wall: near-vertical, noise-warped edges, surface → basement
      // rock. Gap rows are skipped entirely (native strata stay in place).
      let minX = cx;
      let maxX = cx;
      const yTop = Math.min(world.groundY[Math.max(0, cx - 16)], ground, world.groundY[Math.min(world.w - 1, cx + 16)]);
      const yBottom = Math.min(world.h - 1, clayBot + B.basementChalkRows + 12);
      for (let y = yTop; y <= yBottom; y++) {
        if (gaps.some((g) => y >= g.y0 && y <= g.y1)) continue;
        const wobble = (noise1(wseed, y * C.edgeWarpFreq) - 0.5) * 2 * C.edgeWarpAmp;
        const half = C.thickness / 2 + (noise1(wseed + 7, y * C.edgeWarpFreq) - 0.5) * 1.0;
        const wx0 = Math.round(cx + wobble - half);
        const wx1 = Math.round(cx + wobble + half);
        for (let x = wx0; x <= wx1; x++) {
          if (!world.inBounds(x, y)) continue;
          if (world.tiles[y * world.w + x] === Tile.Air) continue; // keep surface profile
          world.tiles[y * world.w + x] = Tile.Rock;
        }
        if (wx0 < minX) minX = wx0;
        if (wx1 > maxX) maxX = wx1;
      }

      // Clay-seam tells: a thin readable seam running through the strata into
      // the wall at each gap (v1 answer to open question Q1). In the clay band
      // the seam is chalk — clay-on-clay would be invisible in lamplight.
      if (C.tellsEnabled) {
        for (const g of gaps) {
          const cy = (g.y0 + g.y1) >> 1;
          const tellTile = g.band === 'clay' ? Tile.Chalk : Tile.Clay;
          const tx0 = Math.round(cx - maxHalf - C.tellLength);
          const tx1 = Math.round(cx + maxHalf + C.tellLength);
          for (let x = tx0; x <= tx1; x++) {
            for (let dy = 0; dy < C.tellThickness; dy++) {
              const y = cy - 1 + dy;
              if (!world.inBounds(x, y)) continue;
              const t = world.tiles[y * world.w + x] as Tile;
              if (t !== Tile.Air && t !== Tile.Water && isDiggable(t)) {
                world.tiles[y * world.w + x] = tellTile;
              }
            }
          }
          g.tell = { x: Math.round(cx - C.thickness / 2 - 1), y: cy };
        }
      }

      curtains.push({ id: interval * C.perInterval + c, x0: minX, x1: maxX, gaps });
    }
  }
  return curtains;
}

/** Post-carve gap flags: usability (Part D definition) + sand content. */
function finalizeGaps(world: World, curtains: CurtainRegion[]): void {
  const clearance = Math.ceil(CONFIG.player.height); // a standard 4-tall tunnel
  for (const c of curtains) {
    for (const g of c.gaps) {
      g.usable = tunnelCrossingExists(world, c.x0 - 12, c.x1 + 12, g.y0 - 8, g.y1 + 8, clearance);
      g.sandGap = false;
      for (let y = g.y0; y <= g.y1 && !g.sandGap; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
          if (world.getTile(x, y) === Tile.Sand) {
            g.sandGap = true;
            break;
          }
        }
      }
    }
  }
}

// ===========================================================================
// Part C — capture points: trenches (r4 construction, saps per face) + crater
// ===========================================================================

function carveTrenchPoint(world: World, f: Footprint, sapDirs: (-1 | 1)[]): TrenchBuild {
  const G = CONFIG.gen;
  const x0 = f.x0 + Math.floor((f.x1 - f.x0 + 1 - G.trenchWidth) / 2);
  const x1 = x0 + G.trenchWidth - 1;

  // Depth is measured from the lowest ground across the trench, so every
  // column is at least trenchDepth deep (r4 rule, unchanged).
  let topY: number = world.h;
  let maxSurf = 0;
  for (let x = x0; x <= x1; x++) {
    topY = Math.min(topY, world.surfaceY[x]);
    maxSurf = Math.max(maxSurf, world.surfaceY[x]);
  }
  const floorY = maxSurf + G.trenchDepth;

  for (let x = x0; x <= x1; x++) {
    for (let y = 0; y < floorY; y++) {
      world.tiles[y * world.w + x] = Tile.Air;
    }
    // Firm clay floor + walls so the trench itself never needs shoring
    world.tiles[floorY * world.w + x] = Tile.Clay;
    world.surfaceY[x] = floorY;
  }
  for (let y = topY; y <= floorY; y++) {
    if (x0 - 1 >= 0 && world.tiles[y * world.w + x0 - 1] !== Tile.Air) {
      world.tiles[y * world.w + x0 - 1] = Tile.Clay;
    }
    if (x1 + 1 < world.w && world.tiles[y * world.w + x1 + 1] !== Tile.Air) {
      world.tiles[y * world.w + x1 + 1] = Tile.Clay;
    }
  }

  const sapMouths: TrenchBuild['sapMouths'] = [];
  const sapEnds: TrenchBuild['sapEnds'] = [];
  for (const dir of sapDirs) {
    // Ladder up to no-man's-land on each sap-facing wall (the way "over the top")
    const ladderX = dir === 1 ? x1 : x0;
    const outerCol = dir === 1 ? x1 + 1 : x0 - 1;
    const outerSurf = world.surfaceY[Math.max(0, Math.min(world.w - 1, outerCol))];
    for (let y = outerSurf - 1; y <= floorY - 1; y++) {
      if (world.tiles[y * world.w + ladderX] === Tile.Air) {
        world.tiles[y * world.w + ladderX] = Tile.Ladder;
      }
    }

    // Sap gallery: pre-dug, timber-lintelled tunnel mouth at floor level in the
    // facing wall — where the tunnellers start (r4 construction, verbatim).
    const mouthX = dir === 1 ? x1 + 1 : x0 - 1;
    let endX = mouthX;
    let endFloor = floorY;
    for (let d = 0; d < G.sapLength; d++) {
      const x = mouthX + dir * d;
      if (x < 1 || x >= world.w - 1) break;
      const gFloor = floorY + Math.floor(d / 3); // gentle decline under no-man's-land
      // The ceiling must clear a soldier still standing on the floor up to two
      // columns behind (his AABB straddles 3 columns), or he wedges on the way
      // down — and he needs a spare tile of headroom to step back UP the slope.
      const gFloorBack = floorY + Math.floor(Math.max(0, d - 4) / 3);
      const carveTop = gFloorBack - G.sapHeight - (d > 0 ? 2 : 0);
      for (let y = carveTop; y <= gFloor - 1; y++) {
        world.tiles[y * world.w + x] = Tile.Air;
      }
      // continuous clay footing + timber lintels over the entrance stretch
      world.tiles[gFloor * world.w + x] = Tile.Clay;
      if (d < G.sapTimberedLen) {
        world.tiles[(carveTop - 1) * world.w + x] = Tile.Timber;
      }
      endX = x;
      endFloor = gFloor;
    }
    sapMouths.push({ x: mouthX, y: floorY - 1, dir });
    sapEnds.push({ x: endX, floorY: endFloor, dir });
  }

  // Flag pole: base on the trench floor (below local ground by construction),
  // pole tiles rising past the parapet line. Inert — capture logic is Phase 4.
  const poleX = x0 + Math.floor(G.trenchWidth / 2);
  for (let y = maxSurf - G.flagPoleAboveGround; y <= floorY - 1; y++) {
    if (world.getTile(poleX, y) === Tile.Air) {
      world.tiles[y * world.w + poleX] = Tile.FlagPole;
    }
  }

  world.trenches.push({ x0, y0: 0, x1, y1: floorY - 1 });
  return {
    x0,
    x1,
    topY,
    floorY,
    groundLine: maxSurf,
    sapMouths,
    sapEnds,
    poleBase: { x: poleX, y: floorY - 1 },
  };
}

/**
 * Fortified crater (center point). The topology IS the identity: an open bowl
 * with no continuous parapet and several wall mouths at different depths — a
 * linear trench has two ends to watch; a crater cannot be watched from one
 * spot. Broken ground (jittered profile + rubble), flag pole at the lowest
 * point of the bowl. Scattered sandbag clumps are renderer dressing.
 */
function carveCrater(
  world: World,
  rng: PRNG,
  seed: number,
  f: Footprint,
  id: number,
): CapturePointRegion {
  const G = CONFIG.gen;
  const C = G.crater;
  const cx = Math.round((f.x0 + f.x1) / 2);
  const half = Math.floor(C.width / 2);
  const bx0 = cx - half;
  const bx1 = cx + half;

  let groundLine = 0;
  for (let x = bx0; x <= bx1; x++) groundLine = Math.max(groundLine, world.groundY[x]);

  let deepest = 0;
  let poleX = cx;
  for (let x = bx0; x <= bx1; x++) {
    const t = (x - cx) / half; // -1..1 across the bowl
    const jit = (hash2(seed + 131, x, 0) - 0.5) * 2 * C.rimJitter;
    let fl = Math.round(groundLine + C.depth * (1 - t * t) + jit);
    fl = Math.max(fl, world.groundY[x]); // never rise above the natural ground
    for (let y = 0; y < fl; y++) {
      world.tiles[y * world.w + x] = Tile.Air;
    }
    world.surfaceY[x] = fl;
    if (hash2(seed + 137, x, 1) < C.floorRubbleChance) {
      world.tiles[fl * world.w + x] = Tile.Rubble; // broken ground
    }
    if (fl > deepest) {
      deepest = fl;
      poleX = x;
    }
  }

  // Wall mouths: short stub tunnels punched into the bowl walls at different
  // depths — at least one near the floor, one high on the wall.
  const mouths: CapturePointRegion['sapMouths'] = [];
  const nm = rng.int(C.mouthsMin, C.mouthsMax);
  const usedFloors: number[] = [];
  for (let m = 0; m < nm; m++) {
    const side: -1 | 1 = m % 2 === 0 ? 1 : -1;
    let mFloor = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const frac =
        m === 0 ? rng.range(0.72, 0.9) : m === 1 ? rng.range(0.25, 0.45) : rng.range(0.3, 0.85);
      mFloor = Math.round(groundLine + C.depth * frac);
      // Mouths must sit at DIFFERENT depths — that's the crater's identity
      if (usedFloors.every((u) => Math.abs(u - mFloor) >= 6)) break;
    }
    usedFloors.push(mFloor);
    // Walk outward from center until the bowl floor rises above the mouth
    // depth — that column is the wall face at this depth.
    let wx = cx;
    while (wx > f.x0 + 4 && wx < f.x1 - 4 && world.surfaceY[wx] >= mFloor) wx += side;
    const len = rng.int(C.mouthLenMin, C.mouthLenMax);
    for (let d = 0; d <= len; d++) {
      const x = wx + side * d;
      if (x < f.x0 + 2 || x > f.x1 - 2) break;
      for (let y = mFloor - C.mouthHeight; y <= mFloor - 1; y++) {
        world.tiles[y * world.w + x] = Tile.Air;
      }
      const ft = world.tiles[mFloor * world.w + x] as Tile;
      if (TILE_SOLID[ft] === 1 && ft !== Tile.Rock && ft !== Tile.Water) {
        world.tiles[mFloor * world.w + x] = Tile.Clay; // firm footing (solid earth only)
      }
    }
    mouths.push({ x: wx, y: mFloor - 1, dir: side });
  }

  // Flag pole at the bowl's lowest point, flying past the rim line.
  for (let y = groundLine - G.flagPoleAboveGround; y <= deepest - 1; y++) {
    if (world.getTile(poleX, y) === Tile.Air) {
      world.tiles[y * world.w + poleX] = Tile.FlagPole;
    }
  }

  return {
    id,
    kind: 'crater',
    active: (G.points.active as readonly number[]).includes(id),
    footprint: { x0: f.x0, x1: f.x1 },
    floor: { x0: bx0, y0: groundLine, x1: bx1, y1: deepest - 1 },
    flagPole: { x: poleX, y: deepest - 1 },
    sapMouths: mouths,
    groundY: groundLine,
  };
}

// ===========================================================================
// Shared carving primitives — explicit tile regions, walkable slopes
// ===========================================================================

interface RunResult {
  endFloor: number;
  rect: Rect;
  floors: Map<number, number>; // column x → floor row
  tops: Map<number, number>; // column x → topmost carved row
}

/**
 * Carve a walkable gallery from (fromX, fromFloor) to (toX, wantFloor).
 * Floor steps are distributed evenly (≤1 row per column — carveable slope);
 * the ceiling tracks the floor from two columns back plus one spare row on
 * slopes (the sap-gallery clearance rule — a soldier's AABB straddles 3
 * columns and wedges without it). If `rng` is given, the target floor is
 * nudged vertically to dodge water pockets (bounded retries).
 */
function carveRun(
  world: World,
  fromX: number,
  fromFloor: number,
  toX: number,
  wantFloor: number,
  height: number,
  rec: Set<number> | null,
  rng: PRNG | null,
  retries: number,
): RunResult {
  const dir = toX >= fromX ? 1 : -1;
  const n = Math.abs(toX - fromX);
  const clampFloor = (v: number) =>
    Math.max(fromFloor - n, Math.min(fromFloor + n, Math.max(16, Math.min(world.h - 20, v))));

  let target = clampFloor(wantFloor);
  const planFloors = (f1: number): number[] => {
    const fs: number[] = [];
    for (let i = 0; i <= n; i++) fs.push(fromFloor + Math.round((i * (f1 - fromFloor)) / Math.max(1, n)));
    return fs;
  };
  const hitsWater = (fs: number[]): boolean => {
    for (let i = 0; i <= n; i++) {
      const x = fromX + dir * i;
      const top = Math.min(fs[i], fs[Math.max(0, i - 4)]) - height - 2;
      for (let y = top; y <= fs[i]; y++) {
        if (world.getTile(x, y) === Tile.Water) return true;
      }
    }
    return false;
  };

  let floors = planFloors(target);
  if (rng) {
    for (let attempt = 0; attempt < retries && hitsWater(floors); attempt++) {
      const off = (attempt % 2 === 0 ? 1 : -1) * (4 + 4 * Math.floor(attempt / 2));
      target = clampFloor(wantFloor + off + rng.int(0, 1));
      floors = planFloors(target);
    }
  }

  const sloped = floors[n] !== fromFloor;
  const floorsMap = new Map<number, number>();
  const topsMap = new Map<number, number>();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i <= n; i++) {
    const x = fromX + dir * i;
    if (x < 1 || x >= world.w - 1) break;
    const fH = floors[i];
    const fB = floors[Math.max(0, i - 4)];
    const top = Math.min(fH, fB) - height - (sloped ? 2 : 0);
    for (let y = top; y <= fH - 1; y++) {
      if (!world.inBounds(x, y)) continue;
      world.tiles[y * world.w + x] = Tile.Air;
      rec?.add(y * world.w + x);
    }
    // Clay footing is COSMETIC ONLY: it may replace solid diggable earth,
    // never fill air. Stamping air would bridge a crossing gallery with a
    // 1-tile diagonal wall and SEVER it (found by the batch validator —
    // orphaned network branches). Crossing galleries must merge.
    const ft = world.tiles[fH * world.w + x] as Tile;
    if (TILE_SOLID[ft] === 1 && ft !== Tile.Rock && ft !== Tile.Water && ft !== Tile.Timber) {
      world.tiles[fH * world.w + x] = Tile.Clay;
    }
    floorsMap.set(x, fH);
    topsMap.set(x, top);
    if (top < minY) minY = top;
    if (fH > maxY) maxY = fH;
  }
  return {
    endFloor: floors[n],
    rect: {
      x0: Math.min(fromX, fromX + dir * n),
      y0: minY === Infinity ? fromFloor : minY,
      x1: Math.max(fromX, fromX + dir * n),
      y1: maxY === -Infinity ? fromFloor : maxY,
    },
    floors: floorsMap,
    tops: topsMap,
  };
}

/** Sink a vertical access shaft (optionally laddered) from yTop to a floor at yBottom. */
function carveShaft(
  world: World,
  xRight: number,
  yTop: number,
  yBottom: number,
  width: number,
  ladder: boolean,
  rec: Set<number> | null,
): Rect {
  const x0 = xRight - width + 1;
  for (let x = x0; x <= xRight; x++) {
    for (let y = yTop; y <= yBottom - 1; y++) {
      if (!world.inBounds(x, y)) continue;
      world.tiles[y * world.w + x] = Tile.Air;
      rec?.add(y * world.w + x);
    }
  }
  if (ladder) {
    for (let y = yTop - 1; y <= yBottom - 1; y++) {
      if (world.getTile(xRight, y) === Tile.Air) {
        world.tiles[y * world.w + xRight] = Tile.Ladder;
      }
    }
  }
  return { x0, y0: yTop, x1: xRight, y1: yBottom };
}

// ===========================================================================
// Part F — enemy pre-dug network (from the EAST home sap)
// ===========================================================================

function carveNetwork(
  world: World,
  rng: PRNG,
  layout: Layout,
  curtains: CurtainRegion[],
  east: TrenchBuild,
): EnemyNetworkRegion {
  const N = CONFIG.gen.network;
  const gh = N.galleryHeight;
  const rec = new Set<number>();
  const segments: Rect[] = [];
  const branches: NetworkBranch[] = [];

  const mouth = east.sapMouths[0];
  const sapEnd = east.sapEnds[0];
  const centerF = layout.footprints[2];

  const reach = rng.int(N.reachMin, N.reachMax);
  const targetX = Math.max(mouth.x - reach, centerF.x1 + N.centerMargin);

  const depthAt = (x: number): number => {
    const cx = Math.max(0, Math.min(world.w - 1, x));
    const sb = world.bandShallowBottomY[cx];
    const cb = world.bandClayBottomY[cx];
    return Math.round(sb + (cb - sb) * N.depthBias);
  };

  // --- Mainline (branch 0): approach drive → laddered shaft → clay galleries,
  // crossing each intervening curtain THROUGH one of its gaps ---------------
  const nodes: { x: number; y: number }[] = [{ x: sapEnd.x, y: sapEnd.floorY }];
  const mainFloors = new Map<number, number>();
  let cx = sapEnd.x;
  let cf = sapEnd.floorY;

  const approach = rng.int(10, 18);
  let r = carveRun(world, cx, cf, cx - approach, cf, gh, rec, null, 0);
  segments.push(r.rect);
  cx -= approach;
  nodes.push({ x: cx, y: cf });

  // Curtains between the shaft and the terminus, east → west. The mainline
  // may ONLY cross a curtain through a gap — carving rock is forbidden.
  const crossings = curtains
    .filter((c) => c.x1 < cx - 8 && c.x0 > targetX)
    .sort((a, b) => b.x1 - a.x1);
  const nearestGap = (c: CurtainRegion, y: number): CurtainGap => {
    let gap = c.gaps[0];
    for (const g of c.gaps) {
      if (Math.abs((g.y0 + g.y1) / 2 - y) < Math.abs((gap.y0 + gap.y1) / 2 - y)) gap = g;
    }
    return gap;
  };

  // Access shaft: aim for mid-clay, but if the first curtain is too close for
  // a ≤45° drive to reach its gap, sink the shaft to gap depth directly
  // (deep laddered shafts are period-accurate; rock-cut galleries are not).
  let gy = Math.max(depthAt(cx), cf + 16);
  if (crossings.length > 0) {
    const g0 = nearestGap(crossings[0], gy);
    const dist = cx - (crossings[0].x1 + 10);
    if (Math.abs(g0.y1 - 1 - gy) > dist) gy = g0.y1 - 1;
  }
  segments.push(carveShaft(world, cx, cf, gy, N.shaftWidth, true, rec));
  cf = gy;
  nodes.push({ x: cx, y: cf });

  for (const c of crossings) {
    // Pick the gap needing the least vertical detour (clay-band gaps usually win —
    // the enemy are competent tunnellers)
    const gap = nearestGap(c, cf);
    const gFloor = gap.y1 - 1;
    r = carveRun(world, cx, cf, c.x1 + 10, gFloor, gh, rec, rng, N.waterRetries);
    segments.push(r.rect);
    r.floors.forEach((v, k) => mainFloors.set(k, v));
    cx = c.x1 + 10;
    cf = r.endFloor;
    nodes.push({ x: cx, y: cf });
    if (cf !== gFloor) {
      // Slope or water-nudge shortfall: connect down/up to gap depth with a
      // laddered shaft rather than ever carving the curtain's rock.
      const yTop = Math.min(cf, gFloor) - 8;
      const yBot = Math.max(cf, gFloor);
      segments.push(carveShaft(world, cx, yTop, yBot, N.shaftWidth, true, rec));
      cf = gFloor;
      nodes.push({ x: cx, y: cf });
    }
    // The crossing itself: dead level through the gap, no water nudging (the
    // window was screened at gap placement; nudging could climb into rock).
    r = carveRun(world, cx, cf, c.x0 - 10, gFloor, gh, rec, null, 0);
    segments.push(r.rect);
    r.floors.forEach((v, k) => mainFloors.set(k, v));
    cx = c.x0 - 10;
    cf = r.endFloor;
    nodes.push({ x: cx, y: cf });
  }

  r = carveRun(world, cx, cf, targetX, depthAt(targetX), gh, rec, rng, N.waterRetries);
  segments.push(r.rect);
  r.floors.forEach((v, k) => mainFloors.set(k, v));
  nodes.push({ x: targetX, y: r.endFloor });
  branches.push({ id: 0, kind: 'drive', deadEnd: false, nodes });

  // --- Side drives + listening stubs ----------------------------------------
  // Branches never cross a curtain (only the mainline routes through gaps):
  // clamp a westward endpoint to stay east of any curtain in the way.
  const clampEastOfCurtains = (fromX: number, toX: number): number => {
    let v = toX;
    for (const c of curtains) {
      if (c.x1 + 8 < fromX && c.x1 + 8 > v) v = c.x1 + 8;
    }
    return Math.max(v, centerF.x1 + N.centerMargin);
  };
  const junctionXs = [...mainFloors.keys()].sort((a, b) => a - b);
  const pickJunction = (): { x: number; y: number } | null => {
    if (junctionXs.length < 20) return null;
    const i = rng.int(Math.floor(junctionXs.length * 0.1), Math.floor(junctionXs.length * 0.85));
    const x = junctionXs[i];
    return { x, y: mainFloors.get(x)! };
  };

  const drives = rng.int(N.branchesMin, N.branchesMax);
  let nextId = 1;
  for (let b = 1; b < drives; b++) {
    const j = pickJunction();
    if (!j) break;
    const len = rng.int(N.branchLenMin, N.branchLenMax);
    const endX = clampEastOfCurtains(j.x, j.x - len);
    if (endX >= j.x - 8) continue; // no room — degenerate branch, skip
    const cb = world.bandClayBottomY[endX];
    const sb = world.bandShallowBottomY[endX];
    const endF = Math.max(sb + 16, Math.min(cb + 20, j.y + rng.int(-12, 28)));
    const br = carveRun(world, j.x, j.y, endX, endF, gh, rec, rng, N.waterRetries);
    segments.push(br.rect);
    branches.push({
      id: nextId++,
      kind: 'drive',
      deadEnd: false,
      nodes: [
        { x: j.x, y: j.y },
        { x: endX, y: br.endFloor },
      ],
    });
  }
  // Exactly one non-mainline drive is the abandoned dead-end. If every side
  // drive degenerated (rare), the mainline terminus itself takes the flag —
  // there is always exactly one.
  const sideDrives = branches.filter((b) => b.id !== 0 && b.kind === 'drive');
  if (sideDrives.length > 0) {
    sideDrives[rng.int(0, sideDrives.length - 1)].deadEnd = true;
  } else {
    branches[0].deadEnd = true;
  }

  const stubs = rng.int(N.stubsMin, N.stubsMax);
  for (let s = 0; s < stubs; s++) {
    const j = pickJunction();
    if (!j) break;
    const len = rng.int(N.stubLenMin, N.stubLenMax);
    const dir: -1 | 1 = rng.chance(0.5) ? 1 : -1;
    let endX = j.x + dir * len;
    if (dir === -1) endX = clampEastOfCurtains(j.x, endX);
    if (Math.abs(endX - j.x) < 4) continue;
    const st = carveRun(world, j.x, j.y - 2, endX, j.y - 2, 6, rec, null, 0); // cramped listening post
    segments.push(st.rect);
    branches.push({
      id: nextId++,
      kind: 'stub',
      deadEnd: false,
      nodes: [
        { x: j.x, y: j.y - 2 },
        { x: endX, y: j.y - 2 },
      ],
    });
  }

  return {
    sapMouth: { x: mouth.x, y: mouth.y },
    branches,
    segments,
    tileCount: rec.size,
  };
}

// ===========================================================================
// Part E — abandoned workings: sealed, half-collapsed old galleries
// ===========================================================================

function carveWorkings(
  world: World,
  rng: PRNG,
  layout: Layout,
  curtains: CurtainRegion[],
): WorkingRegion[] {
  const K = CONFIG.gen.workings;
  const out: WorkingRegion[] = [];
  const count = rng.int(K.countMin, K.countMax);

  const gapBoxes = curtains.flatMap((c) =>
    c.gaps.map((g) => ({
      x0: c.x0 - K.gapMargin,
      x1: c.x1 + K.gapMargin,
      y0: g.y0 - K.gapMargin,
      y1: g.y1 + K.gapMargin,
    })),
  );

  interface PlannedRun {
    x0: number;
    f0: number;
    x1: number;
    f1: number;
  }
  interface PlannedShaft {
    x: number;
    y0: number;
    y1: number;
  }

  for (let k = 0; k < count; k++) {
    for (let attempt = 0; attempt < K.placeRetries; attempt++) {
      const iv = K.intervals[rng.int(0, K.intervals.length - 1)];
      const ix0 = layout.footprints[iv].x1 + 14;
      const ix1 = layout.footprints[iv + 1].x0 - 14;
      const sx = rng.int(ix0 + 20, ix1 - 20);
      const ground = world.groundY[sx];
      const sb = world.bandShallowBottomY[sx];
      const cb = world.bandClayBottomY[sx];
      const yLo = Math.max(ground + K.minDepth, sb - 16);
      const yHi = cb - 20;
      if (yLo >= yHi) continue;
      const sy = rng.int(yLo, yHi);

      // Plan the meander first (consumes RNG whether or not it's accepted —
      // that's fine, determinism only needs a fixed draw order).
      const runs: PlannedRun[] = [];
      const shafts: PlannedShaft[] = [];
      const nSeg = rng.int(K.segmentsMin, K.segmentsMax);
      let x = sx;
      let fl = sy;
      let dir = rng.chance(0.5) ? 1 : -1;
      for (let s = 0; s < nSeg; s++) {
        const len = rng.int(K.segLenMin, K.segLenMax);
        const dy = rng.int(-4, 6);
        runs.push({ x0: x, f0: fl, x1: x + dir * len, f1: fl + dy });
        x += dir * len;
        fl += dy;
        if (rng.chance(K.shaftChance)) {
          const depth = rng.int(K.shaftDepthMin, K.shaftDepthMax);
          shafts.push({ x, y0: fl, y1: fl + depth });
          fl += depth;
        }
        if (rng.chance(0.3)) dir = -dir;
      }

      // Bounding box — must mirror carveRun's envelope EXACTLY (top row =
      // min floor − height − 1 sloped headroom). An inflated box once made
      // the seal test seed from a NEIGHBORING working's air and cry wolf.
      let bx0 = Infinity;
      let bx1 = -Infinity;
      let by0 = Infinity;
      let by1 = -Infinity;
      for (const rr of runs) {
        bx0 = Math.min(bx0, rr.x0, rr.x1);
        bx1 = Math.max(bx1, rr.x0, rr.x1);
        by0 = Math.min(by0, Math.min(rr.f0, rr.f1) - K.height - (rr.f0 !== rr.f1 ? 1 : 0));
        by1 = Math.max(by1, rr.f0, rr.f1);
      }
      for (const sh of shafts) {
        bx0 = Math.min(bx0, sh.x - 1);
        bx1 = Math.max(bx1, sh.x + 1);
        by1 = Math.max(by1, sh.y1);
      }
      const bounds: Rect = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

      // --- Constraints (Part E): inside the interval, deep enough, clear of
      // curtain rock, never near a gap, and AIR-SEALED — no existing air
      // within the margin, so breaking in always requires digging.
      if (bx0 < ix0 || bx1 > ix1) continue;
      let ok = true;
      for (let xx = bx0; xx <= bx1 && ok; xx++) {
        if (by0 < world.groundY[Math.max(0, Math.min(world.w - 1, xx))] + K.minDepth - 8) ok = false;
      }
      if (!ok) continue;
      if (by1 > world.bandClayBottomY[sx] + CONFIG.gen.bands.basementChalkRows - 20) continue;
      if (curtains.some((c) => bx1 >= c.x0 - 8 && bx0 <= c.x1 + 8)) continue;
      if (gapBoxes.some((g) => bx1 >= g.x0 && bx0 <= g.x1 && by1 >= g.y0 && by0 <= g.y1)) continue;
      // Never overlap another working's bounds (+margin) — each is an
      // ISOLATED pocket; the air scan below covers real air, this covers
      // bookkeeping (seal validation floods per-bounds).
      if (
        out.some(
          (o) =>
            bx1 >= o.bounds.x0 - K.airMargin &&
            bx0 <= o.bounds.x1 + K.airMargin &&
            by1 >= o.bounds.y0 - K.airMargin &&
            by0 <= o.bounds.y1 + K.airMargin,
        )
      ) {
        continue;
      }
      for (let yy = by0 - K.airMargin; yy <= by1 + K.airMargin && ok; yy++) {
        for (let xx = bx0 - K.airMargin; xx <= bx1 + K.airMargin; xx++) {
          const t = world.getTile(xx, yy);
          if (TILE_SOLID[t] === 0 || t === Tile.Water) {
            ok = false; // air/ladder/pole = seal risk; water = don't carve pockets
            break;
          }
        }
      }
      if (!ok) continue;

      // --- Execute: carve galleries + shafts, then choke with rubble plugs
      // and drop rotten ceiling timbers.
      const colSpans = new Map<number, { top: number; floor: number }>();
      for (const rr of runs) {
        const res = carveRun(world, rr.x0, rr.f0, rr.x1, rr.f1, K.height, null, null, 0);
        res.floors.forEach((floorY, colX) => {
          colSpans.set(colX, { top: res.tops.get(colX)!, floor: floorY });
        });
      }
      for (const sh of shafts) {
        carveShaft(world, sh.x, sh.y0, sh.y1, 2, false, null);
      }

      const cols = [...colSpans.keys()];
      const nPlugs = rng.int(K.rubblePlugsMin, K.rubblePlugsMax);
      for (let p = 0; p < nPlugs && cols.length > 0; p++) {
        const start = cols[rng.int(0, cols.length - 1)];
        const plugLen = rng.int(K.plugLenMin, K.plugLenMax);
        for (let d = 0; d < plugLen; d++) {
          const span = colSpans.get(start + d);
          if (!span) continue;
          for (let y = span.top; y <= span.floor - 1; y++) {
            world.tiles[y * world.w + (start + d)] = Tile.Rubble; // full-height choke
          }
        }
      }
      for (const colX of cols) {
        if (rng.chance(K.timberChance)) {
          const span = colSpans.get(colX)!;
          if (world.getTile(colX, span.top) === Tile.Air) {
            world.tiles[span.top * world.w + colX] = Tile.Timber; // rotten lintel
          }
        }
      }

      out.push({ id: k, bounds, sealed: true });
      break;
    }
  }
  return out;
}
