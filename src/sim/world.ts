// The tile world: flat typed arrays + sunlight field. Sunlight is semi-static:
// recomputed only in a dirty band around tile changes (never full-grid per tick).

import { CONFIG } from '../config';
import type { BandName, WorldRegions } from './regions';
import { recomputeStabilityRect } from './stability';
import { Tile, TILE_SOLID, TILE_STABILITY } from './tiles';

export interface TrenchZone {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number;
}

export class World {
  readonly w = CONFIG.map.width;
  readonly h = CONFIG.map.height;

  readonly tiles = new Uint8Array(this.w * this.h);
  // LIVE state since Phase 2 Stage A (see stability.ts) — hashed in hash.ts.
  // Solid tiles hold the material mirror; open tiles hold the roof score.
  readonly stability = new Float32Array(this.w * this.h);
  readonly lightSun = new Float32Array(this.w * this.h);
  readonly lightDyn = new Float32Array(this.w * this.h);

  readonly surfaceY = new Int16Array(this.w); // first solid row per column (updated by carving)
  readonly groundY = new Int16Array(this.w); // PRE-carve natural ground line (frozen at gen)

  // Depth-band boundaries per column (set by worldgen; backs bandAt).
  readonly bandShallowBottomY = new Int16Array(this.w);
  readonly bandClayBottomY = new Int16Array(this.w);

  /** Seed-derived generation regions (set once by generateWorld). */
  regions!: WorldRegions;

  trenches: TrenchZone[] = [];

  // Columns whose sunlight needs recomputing (from tile edits).
  private dirtySunMin = Number.POSITIVE_INFINITY;
  private dirtySunMax = Number.NEGATIVE_INFINITY;

  // Rect of tile edits whose stability window needs recomputing.
  private dirtyStabX0 = Number.POSITIVE_INFINITY;
  private dirtyStabY0 = Number.POSITIVE_INFINITY;
  private dirtyStabX1 = Number.NEGATIVE_INFINITY;
  private dirtyStabY1 = Number.NEGATIVE_INFINITY;

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  getTile(x: number, y: number): Tile {
    if (!this.inBounds(x, y)) return Tile.Rock; // out of bounds = solid
    return this.tiles[y * this.w + x];
  }

  isSolid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    return TILE_SOLID[this.tiles[y * this.w + x]] === 1;
  }

  setTile(x: number, y: number, t: Tile): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.w + x;
    if (this.tiles[i] === t) return;
    this.tiles[i] = t;
    this.stability[i] = TILE_STABILITY[t]; // provisional; updateStability rescoring follows
    this.markSunDirty(x);
    this.markStabilityDirty(x, y);
  }

  markSunDirty(x: number): void {
    if (x < this.dirtySunMin) this.dirtySunMin = x;
    if (x > this.dirtySunMax) this.dirtySunMax = x;
  }

  markStabilityDirty(x: number, y: number): void {
    if (x < this.dirtyStabX0) this.dirtyStabX0 = x;
    if (x > this.dirtyStabX1) this.dirtyStabX1 = x;
    if (y < this.dirtyStabY0) this.dirtyStabY0 = y;
    if (y > this.dirtyStabY1) this.dirtyStabY1 = y;
  }

  /**
   * Process pending stability dirt. Called once per tick; no-op when clean.
   * The expansion is exactly the score's dependency window: a changed tile
   * can affect support scans supportScanMax away on its own row, and roofs /
   * ceiling-contact status up to overburdenRows BELOW it. Nothing above a
   * change can see it (scores look up and sideways only), so the rect never
   * grows upward — this is what makes incremental == full, and the golden
   * run asserts that equivalence.
   */
  updateStability(): void {
    if (this.dirtyStabX0 === Number.POSITIVE_INFINITY) return;
    const S = CONFIG.stability;
    recomputeStabilityRect(
      this,
      this.dirtyStabX0 - S.supportScanMax,
      this.dirtyStabY0,
      this.dirtyStabX1 + S.supportScanMax,
      this.dirtyStabY1 + S.overburdenRows,
    );
    this.dirtyStabX0 = Number.POSITIVE_INFINITY;
    this.dirtyStabY0 = Number.POSITIVE_INFINITY;
    this.dirtyStabX1 = Number.NEGATIVE_INFINITY;
    this.dirtyStabY1 = Number.NEGATIVE_INFINITY;
  }

  /** Full initial stability computation (worldgen; also the equivalence oracle). */
  computeStabilityFull(): void {
    recomputeStabilityRect(this, 0, 0, this.w - 1, this.h - 1);
    this.dirtyStabX0 = Number.POSITIVE_INFINITY;
    this.dirtyStabY0 = Number.POSITIVE_INFINITY;
    this.dirtyStabX1 = Number.NEGATIVE_INFINITY;
    this.dirtyStabY1 = Number.NEGATIVE_INFINITY;
  }

  /**
   * Depth band at a tile — pure, cheap, sim-safe (two array reads). Phase 2
   * stability, Phase 3 noise radii, and Phase 4 AI pathing all query this.
   * Above-ground coordinates report 'shallow'; callers gate on air themselves.
   */
  bandAt(x: number, y: number): BandName {
    const cx = x < 0 ? 0 : x >= this.w ? this.w - 1 : x;
    if (y < this.bandShallowBottomY[cx]) return 'shallow';
    if (y < this.bandClayBottomY[cx]) return 'clay';
    return 'basement';
  }

  inTrench(x: number, y: number): TrenchZone | null {
    for (const t of this.trenches) {
      if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return t;
    }
    return null;
  }

  /** Combined light at a tile (sun + dynamic), 0..1. What the sim "sees". */
  lightAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    const i = y * this.w + x;
    const s = this.lightSun[i];
    const d = this.lightDyn[i];
    return s > d ? s : d;
  }

  /** Process pending sunlight dirt. Called once per tick; no-op when clean. */
  updateSunlight(): void {
    if (this.dirtySunMin === Number.POSITIVE_INFINITY) return;
    const spread = 40; // horizontal bleed reach in tiles (≥ sunRelaxPasses)
    const x0 = Math.max(0, Math.floor(this.dirtySunMin) - spread);
    const x1 = Math.min(this.w - 1, Math.ceil(this.dirtySunMax) + spread);
    this.computeSunlightBand(x0, x1);
    this.dirtySunMin = Number.POSITIVE_INFINITY;
    this.dirtySunMax = Number.NEGATIVE_INFINITY;
  }

  /** Full initial sunlight computation. */
  computeSunlightFull(): void {
    this.computeSunlightBand(0, this.w - 1);
    this.dirtySunMin = Number.POSITIVE_INFINITY;
    this.dirtySunMax = Number.NEGATIVE_INFINITY;
  }

  /**
   * Sunlight = per-column vertical scan (hard attenuation through solids),
   * then a few relaxation passes for horizontal bleed into trench walls and
   * tunnel mouths. Only the [x0, x1] band is written; neighbors just outside
   * are read so light flows across the band edge.
   */
  private computeSunlightBand(x0: number, x1: number): void {
    const L = CONFIG.light;
    const { w, h, tiles, lightSun } = this;

    for (let x = x0; x <= x1; x++) {
      let sun = 1.0;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        lightSun[i] = sun;
        if (TILE_SOLID[tiles[i]] === 1) sun *= L.sunSolidTransmit;
        if (sun < 0.004) {
          for (let yy = y + 1; yy < h; yy++) lightSun[yy * w + x] = 0;
          break;
        }
      }
    }

    // Relaxation: light[i] = max(light[i], best neighbor - decay(material at i))
    const rx0 = Math.max(0, x0 - 1);
    const rx1 = Math.min(w - 1, x1 + 1);
    for (let pass = 0; pass < L.sunRelaxPasses; pass++) {
      for (let y = 0; y < h; y++) {
        for (let x = rx0; x <= rx1; x++) {
          const i = y * w + x;
          let best = 0;
          if (x > 0 && lightSun[i - 1] > best) best = lightSun[i - 1];
          if (x < w - 1 && lightSun[i + 1] > best) best = lightSun[i + 1];
          if (y > 0 && lightSun[i - w] > best) best = lightSun[i - w];
          if (y < h - 1 && lightSun[i + w] > best) best = lightSun[i + w];
          const decay = TILE_SOLID[tiles[i]] === 1 ? L.sunSpreadDecaySolid : L.sunSpreadDecayAir;
          const v = best - decay;
          if (v > lightSun[i]) lightSun[i] = v;
        }
      }
    }
  }
}
