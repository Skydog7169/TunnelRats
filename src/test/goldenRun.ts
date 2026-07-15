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
    enteredSap: boolean; // walked into the home trench's pre-dug sap gallery
    materialsDug: string[]; // distinct materials the pick actually removed
  };
}

/**
 * Fixed script against GOLDEN_SEED's worldgen-v3 geometry: spawn ≈ x28 on the
 * west trench floor (y≈37), ladder up the enemy-facing wall at column 37, sap
 * mouth at (38,37) declining east to ≈(49,41). Aim points are absolute world
 * coordinates chosen so the aim DIRECTION is level / steep-up / steep-down /
 * vertical as intended. Open-loop: same commands every run, no feedback.
 */
export function buildScript(): InputCommand[] {
  const cmds: InputCommand[] = [];
  const push = (ticks: number, mod: Partial<InputCommand>) => {
    for (let i = 0; i < ticks; i++) cmds.push({ ...emptyCommand(), ...mod });
  };
  const AIM_LEVEL = { aimX: 5000, aimY: 40 }; // far right, ~level from the trench area
  const AIM_UP = { aimX: 2000, aimY: -1400 }; // up-right, slope ≈ -0.7
  const AIM_DOWN = { aimX: 700, aimY: 560 }; // down-right, slope ≈ +0.8 from x≈60
  const AIM_VERT = { aimX: 68, aimY: 5000 }; // straight down from the dig area

  push(30, {}); // settle at spawn
  push(1, { swapLamp: true }); // armorer swap (in home trench)
  push(1, { toggleLamp: true }); // lamp off
  push(1, { toggleLamp: true }); // lamp on
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
    if (Math.abs(p.x - startX) > 2) coverage.walked = true;
    if (!p.grounded && !p.onLadder) coverage.jumped = true;
    if (p.onLadder) coverage.climbedLadder = true;
    if (p.crouching) coverage.everCrouched = true;
    if (p.impactSeq !== lastImpact) {
      lastImpact = p.impactSeq;
      for (const hit of p.lastImpactTiles) materials.add(TILE_NAME[hit.tile]);
    }
    const px = Math.floor(p.x);
    const py = Math.floor(p.y - 0.001);
    const sapFar = sap.x + sap.dir * (CONFIG.gen.sapLength - 1);
    if (
      px >= Math.min(sap.x + 2 * sap.dir, sapFar) &&
      px <= Math.max(sap.x + 2 * sap.dir, sapFar) &&
      py >= sap.y - 2 &&
      py <= sap.y + 8
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
