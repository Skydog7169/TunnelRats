# Tunnel Rats — Claude Code project notes

The full game design lives in [DESIGN.md](DESIGN.md). Read it before touching anything.
We build **phase by phase** and stop for playtest feedback after each phase. Current status: **Phase 1 complete (7 playtest revisions); Phase 1.5 in progress — Stages 1–4 done (determinism harness, transcendental sweep, Loadout data stub, worldgen v3), awaiting checkpoint sign-off before Stage 5 (crossing playtest v2 support: `?start=`, pacing overlay, PLAYTEST.md).** Work Phase 1.5 stages strictly in order, one per session; do not build Phase 2+. Stage 4 checkpoint report: [CHECKPOINT-STAGE4.md](CHECKPOINT-STAGE4.md).

## Worldgen v3 (Phase 1.5 Stage 4)

- Map is **960×224** (width set by the spacing arithmetic; height trimmed — everything below the basement rock floor was dead chalk). `src/sim/worldgen.ts` is a full rewrite; `src/sim/regions.ts` holds the serializable **`WorldRegions`** output (capture points, curtain gaps, workings, enemy network, band boundaries), **registered in the sim-state hash on purpose** even though it's static seed-derived data — see the policy note in `src/sim/hash.ts`; the mutable capture state that later joins it (Phase 4 flag ownership/progress) must be registered when introduced.
- **Depth bands**: `world.bandAt(x, y)` → `'shallow' | 'clay' | 'basement'`, backed by per-column `Int16Array` boundaries (two array reads; sim-safe — Phase 2 stability, Phase 3 noise, Phase 4 AI all query it). The bands ARE the strata. Basement = chalk shading into rock via position-hashed dither; rock closes the bottom. `world.groundY` keeps the pre-carve natural ground line (`surfaceY` is mutated by carving).
- **5-point capture chain** west→east: home trench · trench line · fortified crater · trench line · home trench. Only 0/2/4 active in v1 (`gen.points.active` — data, not geometry). Intermediate trench lines get saps + ladders on BOTH faces. `world.trenches[0]` must stay the WEST home trench (armorer gate / `inHomeTrench`). Every point gets an inert `Tile.FlagPole` column (non-solid, undiggable): base on the floor below ground, pennant above the parapet line.
- **Spacing is an ASSERT, not a hope**: the 4 intervals must exactly fill `width − footprints`, so `4×spacingMin ≤ span ≤ 4×spacingMax` or generation throws; zero-sum jitter is bounded by the ±1.5× renormalization factor. The width↔spacing trap is documented at `gen.points` in config — read it before touching map width, footprints, or the band.
- **Crater identity = topology** (v1 answer to open question Q2): open bowl (parabola + hash jitter — no trig), no continuous parapet, 3–4 wall mouths at DIFFERENT depths (≥1 near floor, ≥1 high; ≥3 rows apart), rubble-broken floor, renderer-side scattered sandbag clumps. A trench has two ends to watch; a crater can't be watched from one spot.
- **Rock curtains** replace the old rock blobs: one noise-warped near-vertical wall per interval (`gen.curtains.perInterval` to experiment), surface down into basement rock, pierced ONLY by 2–4 diggable gaps (≥1 always clay-band). Gap rows are skipped at stamping so native strata stay in place — sand in a gap is legal (flagged `sandGap`); water would kill one, so windows are screened + a deficit pass guarantees minimums using the real usability predicate. Each gap gets a **tell seam** (v1 answer to Q1): clay seam in shallow/basement, CHALK seam inside the clay band (clay-on-clay is invisible in lamplight); `gen.curtains.tellsEnabled` disables for playtest comparison.
- **Abandoned workings**: 3–5 sealed 3-tall meander galleries (short shafts, rubble plugs, rotten ceiling timbers) in the middle intervals; placement rejected unless the bounds are clear of air/water/curtains/gaps/other workings by margin. Bounds are emitted for Phase 2 (corpses/salvage) and Phase 3 (echo spaces).
- **Enemy network**: east sap → short drive → **laddered access shaft** sunk to clay/gap depth → westward drives that cross curtains dead-level THROUGH a chosen gap (never through rock; a connector shaft covers slope shortfall), 2–4 drives + 1–2 listening stubs, exactly one side drive flagged `deadEnd` (abandoned drive — connected, goes nowhere). The west side keeps only its short r4 sap.
- **Debug**: `B` cycles 4 views; mode 3 = regions (band tints, point footprints, gaps color-coded by band + red when unusable + orange ring for sand, workings, network polylines with the dead-end drive dashed magenta). Overlay line shows the player's current band.

## Loadout (Phase 1.5 Stage 3 — data model only)

- `src/sim/items.ts`: `ItemId` union + `ITEMS` defs (id/name/stackSize) for pick, entrenching_tool, timbers, pistol, knife, geophone, compass, map, lamp_head, lamp_hip. **`ITEM_ORDER` is append-only** — it encodes items in the state hash; reordering breaks every future hash.
- `src/sim/loadout.ts`: `Loadout` (slots from `CONFIG.player.loadoutSlots`, start 4) with `add/has/findSlot/swapItem/hashState`. Player starts with pick + default lamp; `player.carriedLamp` is now a GETTER derived from the loadout; F/G behavior unchanged. No item does anything yet — behaviors land in Phases 2–4.

## Sim-boundary math rules (Phase 1.5 Stage 2 — enforced by the guard)

- NO `Math.sin/cos/tan/atan/atan2/asin/acos/exp/log/pow/hypot/random`, `Date.now`, or `performance.now` anywhere under `src/sim`, `src/core`, `src/command.ts`, `src/config.ts`. `npm run test:golden` scans (comment-stripped) and fails the build on violations.
- Allowed: `+,-,*,/`, `Math.sqrt/abs/floor/ceil/round/min/max/imul/trunc/sign`, `Math.PI` (constant).
- Need trig in the sim? Use `src/core/trig.ts`: a 4096-entry sin table built with pure arithmetic (deterministic across engines). `cosDeg/sinDeg` for fixed config angles, `rotateIdx` to rotate a direction vector by a table angle (this replaced the dig fan's atan2+cos/sin — rotate the facing vector instead of going through angles), `len2` instead of `Math.hypot`.
- The renderer is unrestricted — keep using `Math.*` there.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — typecheck (`tsc`) + production build
- `npm run test:golden` — golden-seed determinism test (`-- --update-golden` to re-baseline INTENTIONALLY; note why in the commit)
- `npm run test:worldgen` — 50-seed worldgen batch validation (beeline blocked, connectivity, usable gaps, spacing, sealed workings, network integrity, dig-cost pacing proxy). ~4.5 s; non-zero exit on any violation.

## Determinism harness (Phase 1.5 Stage 1 — protect this)

- `src/sim/hash.ts` — dual-lane FNV-1a digest of ALL sim-owned state. The file header lists exactly what's hashed and what's excluded (derived/renderer state). **Any new sim state (Phase 2 stability, corpses, items, noise events, AI) MUST be registered there and in `Player.hashState` — the golden test only protects what the hash can see.**
- `src/replay.ts` + main.ts — command recorder/replayer. `R` restarts the sim from the current seed and records; `R` again downloads a session JSON (`{version, seed, commands[[moveX, flagsBitmask, aimX, aimY]], finalHash}`); drag-and-drop a session file onto the page to replay + auto-verify against `finalHash`. `H` logs the current state hash.
- `src/test/goldenRun.ts` + `scripts/golden.mjs` — fixed-seed, fixed-script (~2,400 ticks) regression run executed headlessly via Vite `ssrLoadModule` (zero new deps). Runs the sim twice in-process (must agree), flips a tile (hash must change), checks coverage flags (walk/jump/ladder/dig/crouch/lamp-swap), compares `src/test/golden.json`.

## Architecture

- TypeScript + Vite + Canvas 2D. Zero runtime dependencies (only `vite` + `typescript` as dev deps).
- **Sim/render seam (protect this — it's the future lockstep-multiplayer boundary):**
  - `src/sim/**` is the deterministic world. It ticks at a fixed 30 Hz (`CONFIG.sim.tickRate`), consumes only `InputCommand` structs (`src/command.ts`), and uses only the seeded PRNG (`src/core/prng.ts`). No `Math.random()`, no `Date`/`performance.now()`, no DOM reads inside `src/sim/`.
  - `src/main.ts` runs the fixed-timestep accumulator loop; `src/render/**` interpolates between the previous and current tick (sim entities store `prevX/prevY`).
  - `src/input.ts` samples keyboard/mouse into an `InputCommand` once per tick. Mouse aim is converted to *world coordinates* at command-build time, so the sim never sees the camera.
- **Tile world** (`src/sim/world.ts`): flat typed arrays (`tiles: Uint8Array`, `stability: Float32Array`, `lightSun`/`lightDyn: Float32Array`), **960×224 tiles, 8px each** (8px since playtest r3; dimensions set by worldgen v3 — see the Worldgen v3 section). Per-team visibility/survey masks come in Phase 4.
- **All tunables** in `src/config.ts`, including per-tile-type material table (dig times, stability bases, Phase-3 noise radii already defined so they're tunable now).

## Key decisions (and why)

- **PRNG**: mulberry32 core, plus a stateless `hash2(seed,x,y)` for worldgen value-noise lattices (position-hashed, so generation order can't change the world). Worldgen uses its own PRNG stream (`seed ^ constant`) so future sim RNG consumption never changes terrain.
- **Lighting** = two layers, combined with `max()` at render/sim-query time:
  - *Sunlight* (`lightSun`): per-column vertical scan (attenuates hard through solids) + a few local relaxation passes for horizontal bleed. Recomputed only in a dirty band around tile changes. This is what makes trenches ambient-lit for free.
  - *Dynamic lamps* (`lightDyn`): per-tick raycast (DDA-ish sampling) from each source to every tile in range — gives real shadows; solids transmit a fraction per tile so wall faces light up. Cone lamp = same, with a smoothstepped angular mask toward the aim cursor. Cleared each tick via a touched-index list, never a full-grid clear. Dynamic light lives **in the sim** (not the renderer) because Phase 4 AI must "see only lit tiles".
  - Player always has a tiny self-glow (`CONFIG.light.selfGlow*`) so you're never 100% invisible to yourself; DESIGN's Phase-2 burial "faint self-glow" reuses this.
- **Water pockets are solid + undiggable this phase** ("inert"): they block digging like rock so the beeline-blocking generation goal works. Flooding is explicitly out of scope for v1.
- **Physics**: floats in tile units, AABB vs tile grid, axis-separated sweep. Auto step-up of 1 tile while grounded; coyote time + jump buffering for feel. Crouch shrinks the AABB to fit 1-tile crawlspaces with a speed penalty from config.
- **Digging** (playtest r5 — anchor fan + face window; no hover-target): holding dig runs pick-swing cycles (whiffs allowed). At the impact frame, `sweepStrike()`:
  1. Fans rays asymmetrically around the aim (`anchorFanUpDeg` 75° up / `anchorFanDownDeg` 40° down — head lips sit steep when you stand close) and anchors on the NEAREST solid tile within `digReach`.
  2. Bites a face window there: horizontal digs bite the player's own passage rows (head→feet, from `Math.ceil(height)`) at the anchor's column — a level aim NEVER shifts this window (anchor only picks the column; floor stays intact, tunnel can't creep upward). An inclined aim (`|facingY| > 0.35`) turns it into a RAMP: window slides `round(slope × colDist)` rows with +1 headroom (walkable both ways), with upward shift hard-capped at -1 — bigger up-shifts dig out of walking order and strand faces beyond reach (r7 trap). Vertical digs bite `faceBiteSide`-wide bands.
  3. Contacted tiles SPLIT one cycle's worth of ticks between them; progress persists in a `Map`.
  Do NOT go back to a point-origin arc: its angular coverage collapses to ~0 vertical span when pressed against the face, which wedges forward tunnelling (r2–r4 bug, twice). `strikeWindow()` returns `{bites, clinks}` — clinks are undiggable tiles struck (rock/water/timber), bumped on `clinkSeq` for renderer sparks/splashes and earmarked as Phase-3 noise events. `player.digPreview` holds the live window each digging tick; the renderer outlines it (white/red, light-gated). Fresh swings start at `firstSwingWindup` through the cycle so the first blow lands ~130ms after click. Renderer watches `player.impactSeq`/`lastImpactTiles` for debris and draws cracks on lit, partially-dug tiles.
- **Lamp loadout** (playtest r1): player carries exactly ONE lamp (`carriedLamp: 'head'|'hip'`); F toggles power, G swaps type but only while `inHomeTrench()` (armorer placeholder — future armorer/slot system replaces hard classes, see DESIGN revisions).
- **Ladders**: `Tile.Ladder` is non-solid + climbable + undiggable (special-cased in tiles.ts, `MATERIAL_OF = null`). Placed at gen on each trench's enemy-facing wall so the surface is reachable. On-ladder physics: gravity off, W/S climb, fall distance resets.
- **Trenches** (r4): floor is `gen.trenchDepth` below the lowest local ground (shallow, ~7 ft), not a fixed row — `carveTrench` returns the computed floor for spawns. Each trench gets a **sap gallery**: pre-dug tunnel mouth at floor level in the enemy wall, declining 1 row per 3 tiles. Its ceiling tracks the floor from two columns back plus 1 spare tile — the player AABB straddles 3 columns, and without that clearance he wedges walking the slope (both directions were bugs). Step-up tries 0.35-tile lift increments (hardcoded lift lists don't survive tile-size changes).
- **Camera clamps** (r4): bounds/surface clamps use the ACTUAL visible half-extents computed from canvas size (passed into `camera.update`), not `CONFIG.camera.viewTiles*` — clamping on config over-clamps in windows narrower than the configured aspect and pins the player off-center.
- **Camera**: smooth-follow; top edge may reach (never pass) the local surface line unless the player is inside a trench zone (the "never show the sky/no-man's-land" rule). The clamp EASES in (exp smoothing) rather than snapping — a hard clamp yanks the view down when stepping underground (r5 feedback).
- **Player rendering** (r2): all animation is renderer-side pose math in `drawPlayer` — distance-driven walk cycle (`walkCycle` accumulates actual displacement so feet don't slide), bob, air/ladder/crouch poses. The head+helmet is drawn in a mirrored+pitched local frame toward the aim; the headlamp lens is fixed to the helmet brow. The sim knows nothing about any of this. Body proportions use a FIXED 16px-at-1× unit inside `drawPlayer` (decoupled from `map.tileSize` — don't size limbs in tiles).
- **Earth look** (r3, renderer-only): each solid tile's color is blended 70/30 with the average of its solid neighbours' material colors + per-tile hash grain, so strata boundaries read as earth, not blocks. Full texture pass (dither, decals) deferred to Phase 5.
- Death (Phase 1 placeholder): fall damage → HP ≤ 0 → reset to own-trench spawn. Corpses arrive in Phase 2.
- **Gallery footing is cosmetic-only** (Stage 4 lesson, found by the batch validator): `carveRun`'s clay footing may replace solid diggable earth but must NEVER fill air — a branch whose floor line crosses another gallery would otherwise stamp a 1-tile diagonal clay wall that fully SEVERS it (orphaned network branches). Crossing galleries must merge.
- **Bounding boxes must mirror the carve exactly** (Stage 4 lesson): the workings' seal validation floods from all air inside the recorded bounds — an inflated box swallowed a NEIGHBOR working's air and reported a false leak. If a region records bounds, compute them with the same formula the carver uses, and keep region boxes mutually exclusive by margin.
- **Pacing proxy calibration** (Stage 4): the Dijkstra estimate is gated on the WEST first leg only (the east leg rides the enemy's pre-dug network by design), and its band is expressed in PROXY seconds (80–300) — the proxy assumes optimal play, so ~123 proxy-s median ≈ 3–4 real minutes, matching the Stage-5 human gate. Full rationale in config `validation` + CHECKPOINT-STAGE4.md. Pacing stays fixed by map structure only — dig/movement/camera untouched (locked decision).

## Controls (Phase 1, rev 1)

A/D or ←/→ move · W/Space jump (climbs ladders) · S crouch/climb down · mouse aim · hold LMB swing pick · F lamp on/off · G swap lamp (own trench only) · `` ` `` debug overlay · B cycle debug view (strata → stability → regions) · N new random seed (reloads with `?seed=`) · R record session (restarts world; R again downloads JSON) · H log state hash · drag-drop session JSON = replay

`?seed=12345` URL param fixes the world seed.
