// Golden-seed determinism run. Builds a world from a FIXED seed, drives the
// sim with a FIXED open-loop command script (~2,400 ticks exercising walking,
// jumping, ladder climbing, level/incline/vertical digging, crouching, lamp
// swapping, sap entry, and ≥2 dug materials), and returns the final state
// hash plus coverage flags. Executed headlessly by scripts/golden.mjs via
// Vite ssrLoadModule — no DOM, no renderer imports.
//
// RE-AUTHORED for worldgen v3 (Phase 1.5 Stage 4): the coverage assertions
// are the contract — the old script's walks/climbs/digs assumed pre-v3
// geometry and would have let flags silently stop firing.

import { emptyCommand, InputCommand } from '../command';
import { CONFIG } from '../config';
import { hashSimState } from '../sim/hash';
import { Sim } from '../sim/sim';
import { TILE_NAME } from '../sim/tiles';

export const GOLDEN_SEED = 20260714;

export interface GoldenResult {
  hash: string;
  ticks: number;
  runMs: number;
  repeatOk: boolean; // two independent runs produced the same hash
  sensitivityOk: boolean; // flipping one tile changes the hash
  coverage: {
    walked: boolean;
    jumped: boolean; // was airborne off-ladder at least once
    climbedLadder: boolean;
    dugTiles: number; // pick impacts that connected
    everCrouched: boolean;
    lampSwapped: boolean;
    slotSelected: boolean; // cycled the active loadout slot (dig gating exercised)
    enteredSap: boolean; // walked into the home trench's pre-dug sap gallery
    materialsDug: string[]; // distinct materials the pick actually removed
  };
}

/**
 * Fixed script against GOLDEN_SEED's worldgen-v3 geometry at 4px tiles (r9):
 * spawn ≈ x56 on the west trench floor, ladder up the enemy-facing wall, sap
 * mouth declining east. Aim points are absolute world coordinates chosen so
 * the aim DIRECTION is level / steep-up / steep-down / vertical as intended
 * (all doubled with the r9 rescale — directions identical). Tick counts are
 * unchanged from the 8px script: speeds and distances doubled together, so
 * every phase covers the same physical ground. Open-loop: same commands
 * every run, no feedback from sim state.
 */
export function buildScript(): InputCommand[] {
  const cmds: InputCommand[] = [];
  const push = (ticks: number, mod: Partial<InputCommand>) => {
    for (let i = 0; i < ticks; i++) cmds.push({ ...emptyCommand(), ...mod });
  };
  const AIM_LEVEL = { aimX: 10000, aimY: 80 }; // far right, ~level from the trench area
  const AIM_UP = { aimX: 4000, aimY: -2800 }; // up-right, slope ≈ -0.7
  const AIM_DOWN = { aimX: 1400, aimY: 1120 }; // down-right, slope ≈ +0.8 from x≈120
  const AIM_VERT = { aimX: 136, aimY: 10000 }; // straight down from the dig area

  push(30, {}); // settle at spawn
  push(1, { swapLamp: true }); // armorer swap (in home trench)
  push(1, { toggleLamp: true }); // lamp off
  push(1, { toggleLamp: true }); // lamp on
  // stow the pick (slot 2 = lamp), try to dig — MUST whiff (gating), re-arm
  push(1, { selectSlot: 1 });
  push(20, { dig: true, ...AIM_LEVEL });
  push(1, { selectSlot: 0 });
  // to the ladder (≈9 tiles right of spawn) and climb to the surface
  push(27, { moveX: 1, ...AIM_LEVEL });
  push(100, { jumpHeld: true, ...AIM_UP }); // W = climb while overlapping the ladder
  push(40, { moveX: -1, ...AIM_LEVEL }); // step back over the trench, fall in
  push(30, {});
  // jumps on the trench floor
  for (let j = 0; j < 4; j++) {
    push(1, { jump: true, jumpHeld: true });
    push(24, {});
  }
  // walk right through the sap gallery to its end face (≈21 tiles, downhill)
  push(120, { moveX: 1, ...AIM_LEVEL });
  // dig level ~13s
  push(400, { moveX: 1, dig: true, ...AIM_LEVEL });
  // dig a down-ramp ~12s (toward the shallow/clay boundary)
  push(360, { moveX: 1, dig: true, ...AIM_DOWN });
  // dig an up-ramp ~8s
  push(240, { moveX: 1, dig: true, ...AIM_UP });
  // sink a vertical shaft ~7s
  push(200, { dig: true, ...AIM_VERT });
  // crouch-crawl a bit, then walk back left
  push(60, { moveX: -1, crouch: true, ...AIM_LEVEL });
  push(240, { moveX: -1, ...AIM_LEVEL });
  // idle out to a stable end state
  while (cmds.length < 2400) push(1, {});
  return cmds;
}

function runOnce(): { sim: Sim; coverage: GoldenResult['coverage'] } {
  const sim = new Sim(GOLDEN_SEED);
  const script = buildScript();
  const materials = new Set<string>();
  const coverage: GoldenResult['coverage'] = {
    walked: false,
    jumped: false,
    climbedLadder: false,
    dugTiles: 0,
    everCrouched: false,
    lampSwapped: false,
    slotSelected: false,
    enteredSap: false,
    materialsDug: [],
  };
  const startX = sim.player.x;
  const lampBefore = sim.player.carriedLamp;
  // Sap box derived from region data so the check survives geometry tweaks
  const sap = sim.world.regions.points[0].sapMouths[0];
  let lastImpact = 0;
  for (const cmd of script) {
    sim.step(cmd);
    const p = sim.player;
    if (Math.abs(p.x - startX) > 4) coverage.walked = true;
    if (!p.grounded && !p.onLadder) coverage.jumped = true;
    if (p.onLadder) coverage.climbedLadder = true;
    if (p.crouching) coverage.everCrouched = true;
    if (p.activeSlot !== 0) coverage.slotSelected = true;
    if (p.impactSeq !== lastImpact) {
      lastImpact = p.impactSeq;
      for (const hit of p.lastImpactTiles) materials.add(TILE_NAME[hit.tile]);
    }
    const px = Math.floor(p.x);
    const py = Math.floor(p.y - 0.001);
    const sapFar = sap.x + sap.dir * (CONFIG.gen.sapLength - 1);
    if (
      px >= Math.min(sap.x + 4 * sap.dir, sapFar) &&
      px <= Math.max(sap.x + 4 * sap.dir, sapFar) &&
      py >= sap.y - 4 &&
      py <= sap.y + 16
    ) {
      coverage.enteredSap = true;
    }
  }
  coverage.dugTiles = sim.player.impactSeq;
  coverage.lampSwapped = sim.player.carriedLamp !== lampBefore;
  coverage.materialsDug = [...materials].sort();
  return { sim, coverage };
}

export function runGolden(): GoldenResult {
  const t0 = Date.now();
  const a = runOnce();
  const b = runOnce();
  const hashA = hashSimState(a.sim);
  const hashB = hashSimState(b.sim);

  // Sensitivity: the hash must see the world — flip one tile, expect a change
  a.sim.world.tiles[123456] ^= 1;
  const tampered = hashSimState(a.sim);

  return {
    hash: hashA,
    ticks: buildScript().length,
    runMs: Date.now() - t0,
    repeatOk: hashA === hashB,
    sensitivityOk: tampered !== hashA,
    coverage: b.coverage,
  };
}
