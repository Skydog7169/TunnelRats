// Deterministic sim-state digest — the foundation of the replay/regression
// safety net. Dual-lane FNV-1a (two 32-bit lanes with different offset bases,
// concatenated to a 16-hex-char digest). Hand-rolled, zero dependencies, and
// only integer/bit math (safe inside the sim boundary).
//
// WHAT IS HASHED (keep this list current — future systems MUST register here):
//   - seed, tickCount
//   - world.tiles (the full Uint8Array)
//   - live-sim PRNG internal state
//   - player: position/velocity/prev-position, facing, crouch/grounded/ladder,
//     health/death/respawn timer, the full LOADOUT (slots encoded via the
//     append-only ITEM_ORDER index; carriedLamp is derived from it) + lamp
//     power, swing state, impact and clink sequence counters,
//     coyote/jump-buffer/fall-distance internals, the full digProgress
//     map (key-sorted so iteration order can't matter), and the r8 stair
//     mode (rampDir — hysteresis state, persists across ticks)
//   - world.regions (WorldRegions — DELIBERATE POLICY: this is static,
//     seed-derived data, yet it IS hashed. Registering it makes the golden
//     test sensitive to worldgen regressions — exactly the bug class Stage 4
//     (worldgen v3) introduced — at negligible cost. Includes the depth-band
//     boundary arrays backing world.bandAt.)
//     ⚠ CONVENTION: the MUTABLE state that will later live alongside regions
//     (flag ownership, half-mast capture progress — Phase 4) MUST be
//     registered here the moment it is introduced. Regions only cover the
//     generation output.
//
// DELIBERATELY EXCLUDED (derived or renderer-owned):
//   - lightSun / lightDyn: recomputed from tiles + player state every tick
//   - stability array: currently a pure mirror of tiles. ⚠ Phase 2 makes it
//     live state — REGISTER IT HERE when that lands.
//   - player.digPreview / lastImpactTiles / lastClinks: transient per-tick
//     outputs, fully derived
//   - camera, particles, walk cycle, debug state: renderer-owned
//
// Phase 2+ registration checklist: stability array, corpses, placed timbers /
// items, noise events in flight, AI soldier state, capture-point ownership +
// capture progress (see the regions note above).

// Type-only: keeps hash.ts import-cycle-free at runtime (loadout → hash).
import type { Sim } from './sim';
import { hashWorldRegions } from './regions';

export class StateHasher {
  private h1 = 0x811c9dc5 >>> 0; // FNV-1a offset basis
  private h2 = 0x9dc5811c >>> 0; // second lane, rotated basis
  private view = new DataView(new ArrayBuffer(8));

  byte(b: number): void {
    this.h1 = Math.imul(this.h1 ^ (b & 0xff), 0x01000193) >>> 0;
    this.h2 = Math.imul(this.h2 ^ (b & 0xff), 0x01000193) >>> 0;
  }

  bool(b: boolean): void {
    this.byte(b ? 1 : 0);
  }

  u32(n: number): void {
    this.byte(n);
    this.byte(n >>> 8);
    this.byte(n >>> 16);
    this.byte(n >>> 24);
  }

  /** Hash the exact IEEE-754 bit pattern — no rounding, no string round-trip. */
  f64(n: number): void {
    this.view.setFloat64(0, n, true);
    for (let i = 0; i < 8; i++) this.byte(this.view.getUint8(i));
  }

  u8Array(a: Uint8Array): void {
    this.u32(a.length);
    for (let i = 0; i < a.length; i++) {
      this.h1 = Math.imul(this.h1 ^ a[i], 0x01000193) >>> 0;
      this.h2 = Math.imul(this.h2 ^ a[i], 0x01000193) >>> 0;
    }
  }

  digest(): string {
    return (
      this.h1.toString(16).padStart(8, '0') + this.h2.toString(16).padStart(8, '0')
    );
  }
}

/** Stable digest of everything the sim owns. Same seed + same commands ⇒ same digest. */
export function hashSimState(sim: Sim): string {
  const h = new StateHasher();
  h.u32(sim.seed);
  h.u32(sim.tickCount);
  h.u8Array(sim.world.tiles);
  h.u32(sim.rng.state);
  sim.player.hashState(h);
  hashWorldRegions(h, sim.world.regions); // appended in Stage 4 (see header)
  return h.digest();
}
