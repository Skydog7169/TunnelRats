# Phase 2 Stage A checkpoint — stability field + live heatmap

**Status: code complete, all gates green.** Exits through Hayden's playtest with
the heatmap (debug view 2). No collapses yet — scores are data + colors only;
tells and propagation are Stage B.

## What shipped

- **`src/sim/stability.ts`** — every OPEN tile (air/ladder/flag pole) with a
  solid roof directly overhead gets a live score 0..100:
  `score = matBase × supportFactor × depthFactor`
  - `matBase`: decaying-weight mix of the material stability of
    `overburdenRows` rows straight up. Air rows count 0, so a thin shell over
    another void is precarious with no special-casing. A timber overhead
    (stability 100) reads as full shoring through the same table.
  - `supportFactor`: distance to the nearest solid at the same row (wall,
    pillar, timber), no penalty within `supportSafeDist`, falling linearly to
    `spanFloor` at `supportScanMax`. Mid-span of long galleries is the danger
    zone; material dominates (long clay drive ≈ 43, long topsoil run ≈ 15).
  - `depthFactor`: mild overburden-pressure penalty below the NATURAL ground
    line (`groundY` — carving never relieves pressure), floored at `depthFloor`.
  - Open tiles with air overhead score a flat 100 (sky, open trench) and are
    invisible on the heatmap. Solid tiles keep the inert material mirror.
  - All tunables in `CONFIG.stability`; `warnThreshold`/`collapseThreshold`
    are DATA ONLY this stage (heatmap color bands, Stage B consumes them).

- **Incremental recompute (no full scans on the 860k-tile map)** — a score is
  a pure function of the tiles in a bounded window (`supportScanMax` sideways,
  `overburdenRows` up, nothing below), so `World` accumulates a dirty rect per
  tick and recomputes only that rect expanded by exactly the window. Nothing
  ABOVE a change can see it, so the rect never grows upward. **The golden run
  now asserts incremental == full bit-for-bit (`stabIncrOk`) on every run** —
  if a future factor widens the dependency window without widening the dirty
  expansion, the gate fails loudly.

- **Hash registration** — the full stability Float32Array is hashed (exact
  IEEE-754 f32 bit patterns, explicit little-endian; `StateHasher.f32Array`).
  Golden re-baselined `520b8bbfd9509e36 → 510af6c0ce704f0d` for this reason
  alone. ⚠ Session JSONs recorded before this commit no longer verify their
  `finalHash` — re-record. hash.ts's header checklist updated (stability moved
  from "excluded" to "hashed").

- **Live heatmap** — debug view 2 (`B`) is now the LIVE field: red below
  `collapseThreshold`, red→yellow through the warn band, yellow→green fading
  out as roofs get solid; faint material backdrop on solids for context. The
  debug overlay gained a `roof stability:` readout — the score of the ceiling
  over the player's column, with its zone (`ok`/`WARN`/`COLLAPSE`).

## Probe numbers (the panel seeds — medians, warn<30, collapse<15)

Scored-tile populations at gen time (scratch probe, not committed):

| structure | 610462366 | 19569978 | 2025286815 |
|---|---|---|---|
| all scored open tiles | 70.8 | 63.7 | 53.3 |
| enemy network drive ceilings | 27.9 | 44.4 | 23.2 |
| workings gallery ceilings | 71.8 | 72.4 | 76.2 |
| sap ceiling, timbered 10 | 65.3 | 53.3 | 53.3 |
| sap ceiling, bare tail | 44.9 | 24.9 | 24.9 |
| under-sand roofs | 7.6 | 7.0 | 7.1 |

Open-to-sky trench air: always exactly 100 (unscored) — verified 0 violations
on all seeds. Timber vs bare-tail sap contrast (≈53–65 vs ≈25–45) is the
Stage C payoff made visible.

## Findings for the playtest / Stage B decisions

1. **Enemy network drives dip into the warn band mid-span** (medians 23–44).
   Clay self-supports above collapse, but long pre-dug drives read yellow.
   Stage B must decide: timber the enemy network at gen (they ARE competent
   tunnellers), raise clay's span tolerance, or accept creaky enemy galleries
   as fiction.
2. **Drives passing under sand pockets score collapse-level** (≈4–8). Correct
   fiction (sand overhead is treacherous) but pre-dug infrastructure would
   cave immediately when Stage B lands — same decision as (1).
3. **Bare sap tails sit at ≈24–45**, right around the warn line on 2 of 3
   seeds. Either timber full saps at gen or accept the warning ambience.
4. Thresholds (30/15) are first-pass. The heatmap playtest tunes
   `CONFIG.stability` — nothing else consumes the scores yet, so tuning is
   free of gameplay consequences this stage.

## Gates at sign-off

`npm run build` ✓ · `npm run test:golden` ✓ (repeatOk, sensitivityOk,
stabIncrOk, coverage, hash matches re-baselined golden) · `npm run
test:worldgen` ✓ 50/50 seeds. Browser-verified live on seed 610462366:
fresh digs paint immediately, readout tracks the player, 120 fps with the
overlay on.
