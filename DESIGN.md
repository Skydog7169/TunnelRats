# Tunnel Rats — Design Document (v1: single-player vs AI)

Build a 2D real-time tunnel-warfare game called **Tunnel Rats**, inspired by WWI mining warfare. Terraria-style side-view tile world, but the entire game is underground: two trenches at opposite ends of the map, all combat happens in player-dug tunnels, fog of war is absolute (you see only what your lamps light), and sound is the primary sensing mechanism.

Work **phase by phase, in order**. At the end of each phase, stop: make sure the game runs, tell me how to playtest the phase's acceptance criteria, and wait for my feedback before starting the next phase. Do not build ahead.

First action: save this entire prompt as `DESIGN.md` in the repo root, and create a `CLAUDE.md` that points to it and records architecture decisions as you make them. Keep both updated as we go.

## Tech & architecture requirements (non-negotiable)

- **Stack:** TypeScript + Vite + HTML5 Canvas 2D. No game engine, no rendering framework. Zero runtime dependencies unless truly necessary (justify any).
- **Deterministic fixed-timestep simulation**, fully decoupled from rendering and input:
  - Sim ticks at a fixed rate (e.g., 30 Hz); renderer interpolates at display refresh.
  - Input is captured into a per-tick **input command struct**; the sim consumes only commands, never raw events. (This is the seam where lockstep multiplayer attaches later.)
  - All randomness through a single **seeded PRNG** owned by the sim. Same seed + same command stream = identical world. No `Math.random()` in sim code, no floating-point-order hazards you can avoid, no sim reads of wall-clock time.
- **Tile world:** 16px tiles stored in flat typed arrays (tile type, stability, light level, per-team visibility/survey masks). Target map ~600×200 tiles; keep per-tile updates cheap (dirty-region or active-set processing, not full-grid scans every tick).
- **Tunables in one file:** `config.ts` holds every gameplay constant (dig speeds, noise radii, lamp ranges, stability thresholds, timers) with comments. I will be editing this constantly.
- **Debug overlay** toggled with a key: FPS, tick rate, current seed, player tile coords, and per-phase debug views specified below. Add a URL param `?seed=` to fix the world seed.

---

## Phase 1 — World, movement, camera, light

**Terrain generation (seeded):** horizontal strata with noise-warped boundaries, top to bottom: topsoil/loam → clay bands → chalk, with embedded features: sand/gravel pockets, undiggable rock intrusions, water pockets (inert this phase), root mats near the surface. Two trenches (pre-dug open areas with surface access) at the far left and far right. Layer palette (flat colors + simple tile borders is fine):

- Topsoil: fast dig, poor stability (values matter in later phases; define them in config now)
- Clay: slow dig, quiet, self-supporting
- Sand/gravel: very fast dig, loud, terrible stability
- Chalk: medium dig, very loud, decent stability
- Rock: undiggable

Generation goal: a straight line between trenches should almost always hit rock, sand, or water — verify by eyeballing several seeds.

**Player:** stick-figure-style soldier sprite (placeholder art), side-view platformer movement: walk, jump/climb small steps, gravity, fall damage past a threshold. Dig by holding a mouse direction / key toward an adjacent tile; dig time per tile from config by layer. Tunnels are 2 tiles tall by default (crouching in 1-tall crawlspaces: movement penalty).

**Camera:** tight follow, roughly 30×17 tiles visible. Never shows the surface unless the player is literally in the trench. No minimap.

**Lighting:** tile-based propagation with falloff; unlit = pure black (render nothing).
- Headlamp: directional cone in facing/cursor direction, long reach (config).
- Hip lamp: omnidirectional, short radius (config).
- Independent toggle keys. Trenches have ambient light.

**Debug views:** strata overlay (ignore lighting), stability values heatmap (inert data for now).

**Acceptance:** I can regenerate worlds by seed, dig a tunnel from my trench in any direction at layer-dependent speeds, movement and gravity feel right, and the two lamps behave distinctly with real darkness beyond them.

---

## Phase 2 — Stability, shoring, cave-ins, corpses

- Every air (excavated) tile gets a **stability score** from: depth, surrounding layer types, unsupported span width/height, and distance to nearest support (shoring timber tile or intact wall). Recompute incrementally on nearby changes only.
- **Shoring timbers:** carried item, finite (config), placed as a tile against tunnel walls/ceiling; resupply only at own trench. Placement makes noise (matters in Phase 3). **Amendment (2026-07-15 playtest):** a placed timber is solid FOOTING — it can be stood on, so timbers also bridge player-cut voids and build step-ways. This is the v1 answer to environment-locked traversal (you can't dig air; jump reach is bounded); pass-through platforms were explicitly declined. Design placement UX with both uses in mind.
- Below a stability threshold: warning tells (dust particle trickle, creak sound stub, lamp flicker) → then collapse. Collapse fills tiles with rubble and **propagates** to adjacent unstable tiles until reaching stable ground. Sand pockets breached without immediate shoring "run" into the tunnel.
- Rubble is re-diggable (faster than virgin clay, slower than sand).
- **Burial:** a player caught in a collapse is buried — screen goes black except a faint self-glow, suffocation timer (config), can wiggle to extend slightly. Dug out in time = survives. Otherwise dies in place.
- **Corpses:** dead soldiers leave a corpse tile-entity holding their carried items. Corpses persist; buried corpses are found by re-digging. (Respawn itself comes in Phase 4 — for now, death = reset player to trench, corpse stays.)

**Debug views:** live stability heatmap, collapse propagation visualizer.

**Acceptance:** wide unsupported galleries in loam collapse with visible warnings; clay self-supports; timbers rescue bad spots; I can get buried, dug out (debug key to simulate), and find a prior corpse with its gear by excavating rubble.

---

## Phase 3 — Sound & the geophone

- Central **noise event** system in the sim: digging (radius by layer: sand/chalk loud, clay near-silent), footsteps (walk vs crouch), timber placement, collapses (huge), gunshots (huge — Phase 4 emits these).
- Propagation through earth with distance falloff. Delivery to a listener: positional Web Audio (simple synthesized/placeholder sounds are fine) **plus** a subtle directional visual ripple at the screen edge scaled by intensity, so the game is playable without headphones.
- **Geophone:** equip → must stand still, no weapon out; after a short settle time, shows a directional bearing indicator toward the loudest nearby source, with distance-based vagueness (close = tight arc, far = wide arc). Any self-noise ruins the read.
- Ambient audio bed: drips, creaks, muffled surface artillery for atmosphere (placeholder assets fine).

**Debug view:** noise event visualizer showing emission radii in the world.

**Acceptance:** with a debug-spawned noise source digging somewhere unseen, I can localize it by geophone discipline (move, stop, listen), and layer choice audibly changes how detectable my own digging is.

---

## Phase 4 — Combat, AI, respawn, win condition

**Weapons:**
- Pistol: limited ammo (resupply at trench), loud gunshot noise event, **muzzle flash momentarily lights the gallery**, projectile is a fast visible tracer, hits chip nearby wall stability slightly. 2–3 body hits or 1 headshot-range-band kill (keep it simple; tune in config).
- Knife: silent, instant kill at melee range from behind/unaware, brief struggle otherwise. The lights-out weapon.

**Respawn ("fresh soldier"):** death → corpse with carried items remains → respawn at own trench after a timer (config). Team's **surveyed map** (Phase 4 also adds the map — below) persists at the trench.

**Navigation tools:**
- **Compass:** small true-heading indicator, always available.
- **Dead-reckoned map:** opening it occupies hands and dims lamps. It renders the team's surveyed tunnels with small accumulating positional drift per surveyed segment, so long galleries are meters off. Visiting your trench syncs your copy with the master (and re-anchors drift at the trench).

**AI enemy team** (2–3 soldiers, config): dig from their trench toward yours with layer-aware pathing (prefer quiet/stable, shore as needed), respond to heard noise by pausing/listening/investigating or counter-digging, fight with pistol/knife using the same rules as the player (they see only lit tiles, hear the same noise events — no cheating omniscience), respawn from their trench. A simple utility/state machine is fine; it must exercise every system, not be brilliant.

**Win/loss:** reach and hold the inside of the enemy trench for N continuous seconds (config, start 60) → win. Enemy AI holding yours → loss. Persistent world, no round reset; contested = timer pauses.

**HUD (minimal):** health, ammo, timbers, lamp states, compass, hold-timer when contesting.

**Acceptance:** a full loop is playable start to finish — dig toward the enemy guided by sound and compass, survive/ambush encounters where light discipline matters, die, respawn, recover my old corpse's gear, and win by holding their trench.

---

## Phase 5 — Feel pass (after playtesting Phases 1–4)

Screen shake on collapses/gunshots, particle polish (dust, muzzle smoke), audio mix pass, difficulty tuning of AI and geology, menu with seed entry and basic settings. We will scope this phase together after playtesting; do not start it unprompted.

## Revisions from playtest round 1 (2026-07-14)

Feedback on the Phase 1 build. Items marked **[done]** are implemented; the rest are design amendments for their phase.

- **[done] Lamp loadout:** the soldier carries exactly ONE lamp — headlamp or hip lamp — not both. `F` toggles the carried lamp's power; `G` swaps head↔hip, but only inside your own trench (placeholder for the armorer, below).
- **[done] Swing digging:** no more click-a-block. Holding dig swings a pick in cycles (period + impact point in config); the blow lands a chunk of progress, with debris particles. Average rates still follow the per-material dig times, so clay ≈ 3 swings, sand bursts in 1.
- **[done, r2] Directional arc digging:** no hover-target at all — you pick the swing *direction* and at the impact frame the pick tip sweeps an arc (`swingArcDeg`); every diggable tile it contacts splits the blow's progress between them. A swing across a wall face chips 2–3 tiles at once, so galleries open organically instead of block-by-block. Rays stop at the first solid tile (no cutting behind walls); whiffing at air is allowed. If digging still feels too blocky after play, the next lever is halving the tile size to 8px (map 1200×400) — deferred until playtested.
- **[done, r2] Aimed head:** the head/helmet assembly turns and pitches toward the cursor; the headlamp lens is fixed to the helmet brow, so the light follows the head instead of sliding around it.
- **[done, r2] Movement animation pass:** distance-driven walk cycle (no foot sliding), body bob, idle stance, airborne pose, ladder-climb pose, crouch lean.
- **[done, r3] Half-size tiles:** tiles halved to 8px (world 1200×400, same physical size) so arc digging bites ~3–5 tiles per blow and excavation reads dynamic rather than blocky. All config units rescaled; verified beeline-blocking and perf (~1.8ms/tick).
- **[done, r3] Soft earth blending (first pass):** renderer blends each tile's color with its solid neighbours + grain, so strata transitions look like earth. The full texture/feel treatment (dithered edges, surface decals) stays in Phase 5.
- **[done, r4] Realistic trench depth:** trench floor sits `trenchDepth` (5 tiles ≈ 7 ft) below the local ground instead of a fixed deep row — head-height cover plus parapet, like the real thing.
- **[done, r4] Sap gallery:** each trench has a pre-dug, timber-lintelled tunnel mouth at floor level in the enemy-facing wall, sloping gently downward for `sapLength` tiles — the unmistakable "tunnellers start here" opening (fixes the walled-in look).
- **[done, r4] Uniform detail pass:** filled tunic, chest webbing, belt, backpack, puttee-wrapped shins, boots, helmet rim + chinstrap, bare hands.
- **[done, r5] Kneeling crouch:** crouch height raised to ~70% (a knee, not a ball) with a proper kneel pose; crawlspaces are now 3 tiles minimum.
- **[done, r5] Camera surface transition:** the never-show-the-sky clamp now eases in smoothly instead of snapping when you step underground, and the top edge may reach the surface line itself (still never above it).
- **[done, r5] Face-bite digging:** replaced the point-origin swing arc (which collapses to nothing at close range — the cause of "breaks in front but not above/below") with an anchor-fan + face-window model: rays find the nearest wall contact; a level swing then bites the player's own passage rows (head→feet) at that column — floor untouched, no upward creep — while a deliberate up/down aim shifts the bite. Verified: 130+ tiles of continuous level tunnelling with zero floor pits and zero vertical drift.
- **[done, r6] Dig telegraphing:** while swinging, the tiles the next blow will hit are outlined (white = will dig, red = undiggable), light-gated so darkness reveals nothing.
- **[done, r6] Snappier first swing:** fresh swings start pre-wound (`firstSwingWindup`) — first blow ~130ms after click instead of ~300ms; sustained rate unchanged.
- **[done, r6] Clink feedback:** striking rock/timber throws sparks, striking water splashes blue — undiggable ground is distinguishable from a whiff even before Phase-3 audio. Clinks are flagged as future Phase-3 noise events (metal on stone carries).
- **[done, r7] Inclined digging (ramps):** a deliberately angled aim now digs a walkable ramp — the bite window slides along the aim's slope line with an extra headroom row (walkable both directions, verified). Ascent is capped at one row per swing: steeper up-shifts bite out of walking order and carve overhang pockets whose faces end up beyond reach; 45° is the steepest walkable stair regardless. Flanking galleries are now diggable.
- **[done, r8] Stair mode (dig-pathing pass, 2026-07-15 playtest):** incline digging reworked for consistency after a playtest trap (a steep down-aim cut a multi-row pit the digger couldn't jump back over). (1) Level↔stair mode now has HYSTERESIS (`rampAimEnter`/`rampAimExit`) — the bite window can't flicker between modes near the threshold; (2) the shift is a symmetric **±1 step** regardless of aim steepness or anchor distance — the same stair every time, steeper cutting means aiming vertical (the old slope×distance shift is what dug the pit); (3) a faint **ghost preview** telegraphs the next two stair steps; (4) two stall bugs found by a headless stair test during the rework: never step-shift at the digger's own column (digs the floor from under your feet — this guard lived silently inside r7's slope×distance product), and the strike now sweeps every column between digger and anchor so slow tiles (root mat/clay) can't survive their window and strand at head height outside the fan's cone (the r7 "beyond reach" trap class, closed for good). Verified: dig down 11 rows, turn around, dig back OUT unaided — self-recovery from your own cut works. `rampDir` is new sim state, registered in the hash; per-material dig speeds untouched (pacing lock).
- **[done, r9] Quarter-size tiles (4 px):** after r8's stair mode still read as jagged, tiles halved again (8→4 px; world 1920×448, same physical size — the "worm holes, not jagged paths" direction; the second application of the r3 lever). Physical equivalence maintained everywhere: tile-denominated lengths/speeds/accelerations doubled; per-tile dig times × 2/7 (passage is 7 rows and a physical 8 px advance is 2 columns — seconds per metre of tunnel unchanged, pacing lock intact, 50-seed batch still green with the same physical distribution); per-tile light transmit square-rooted, linear decays halved, lamp occlusion step in config (`light.rayStepTiles`); FRACTIONAL dig ticks legalized (the integer floor silently made fast materials 3× slower as tiles shrink); stair/sap spare headroom is 2 tiles (= the old 1×8 px), body clearance tracked from 4 columns back. Perf measured: 0.76 ms/tick digging with headlamp (budget 33). Stair steps are now half-height — a ±1 staircase reads as a bore. Full granular dirt/strata simulation noted as a future direction, not this pass. **r9.1 (same day, from the first 4px playtest "it doesn't clear enough to move"):** two scale bugs fixed. (1) Player height was set to an INTEGER (7.0): with feet at a row bottom the collision box needs ceil(h)+1 rows while the dig window carves ceil(h) — every fresh tunnel was one row too short to walk into (crawling worked; walking wedged). Height is now 6.9; rule recorded in config: standing height must never be integer. (2) Swing-quantization waste: one swing's 16.5 tile-ticks aren't banked, so a cheap 7-tile column (7.2 ticks) consumed a whole swing and physical dig speed silently HALVED at 4px (the Dijkstra pacing proxy prices digTime, not swing quantization — it couldn't see this). Fix: `faceBiteDepth 2` — a blow bites two columns (rows when vertical) into the face, a physical 8px mouthful; expensive materials unaffected (their progress banks between swings). Measured after: 0.69 s per physical 8px of level topsoil tunnel — inside the r8 real-play band (0.6–0.76). **r9.2 (same day, from the follow-up playtest "still impossible to point diagonally and tunnel; aiming is erratic"):** the vertical/horizontal window boundary sat at exactly 45° with no hysteresis — precisely the diagonal aim — so diagonal digging flickered between the 5-wide shaft band and the passage window (measured: 60% of the session's diagonal dig time in shaft mode, 37 window-shape flips per minute). Shaft mode now needs a deliberately steep aim (`vertAimEnter` ratio 1.6 ≈ 58°, exit 1.1, hysteresis, new hashed `vertDig` state); diagonals belong to stair mode. And in stair mode the beyond-anchor face columns STAGGER by ±1 per column so the two-column mouthful is a slope-following parallelogram (matching the ghost preview) instead of two aligned columns whose corner catches the body. Verified hands-off: one held 45° aim bores down 21 rows over 44 columns and a held reverse aim climbs back out — no cursor management. **r9.3 (same day, "going down is better than going up — still trapped by blocks above my head"):** ascent has an asymmetry descent doesn't: the RISE happens where the digger STANDS, and his 2.4-wide body still overlaps up to two trailing columns whose ceilings were cut at the older, lower stair level — at certain alignments the trailing ceiling catches his head and traps the climb (descent just falls into space cut ahead). An up-stair blow now also chips the rise clearance above his own head and one trailing column — ceiling rows only, strictly above the passage top; the own-column FLOOR guard is untouched. Verified: dive 27 rows, then one held 45° up-aim climbs 41 rows clean to surface breakthrough in 19.5 s with a longest mid-climb pause of 1.0 s (one swing cycle).
- **[done] Confined peripherals (2026-07-15):** camera tightened ~30% (`camera.viewTilesX/Y` 84×48 at 4px vs the Phase-1-equivalent 120×68). Direction locked: NOT seeing where you're going IS the game — disorientation and (Phase 3) sound are the navigation tools; the headlamp beam now reaches past the screen edge, so sight is screen-limited in the aim direction and darkness-limited everywhere else. Standing rule for all future phases: **nothing off-team ever renders through walls or darkness** — no enemy tunnels, no enemies, no items; Phase 4 AI/soldiers render only when actually lit (the sim already owns lighting for exactly this reason). The playtest HUD's distance readout is measurement instrumentation, not navigation UI — it turns off via `debug.playtestHud` and is not part of the shipped game's HUD plan. **Round 3 (same day, from recording 1784161555568):** (a) the surface-hide clamp now YIELDS to the player — `camera.keepAbovePlayer` (10) tiles above his center always stay visible, so shallow digs show a surface strip instead of a beheaded soldier and you can always see the hole lip you're climbing for (14% of the recorded dig time had been spent half-visible); (b) the anchor fan now picks the face contact closest to the CURSOR LINE (angular priority, widening outward only on whiffs) instead of nearest-by-distance across the whole 75° fan — measured mean aim→bite deviation in the recording was 37° ("it chooses blocks far to the side"); the wide fan survives for its r5 purpose (pressed-close lips) as the fallback, not the default. **Round 2 (same day):** view tightened again to 72×40 and the surface-hide rule made REAL: underground outside a trench, the view's top edge clamps `camera.surfaceHideDepth` (6) BELOW the surface line — in a tunnel the surface does not exist on screen. Found in the process: the r5 "eased" clamp was a soft constraint — it fought the follow smoothing to an equilibrium ~8 tiles short and had quietly shown a surface strip ever since; the clamp value still eases in (no r5 snap) but now applies as a HARD floor once tracked. Combat-forethought invariant recorded at the camera config: lamp ranges must exceed the view half-width (48 > 36), so an approaching enemy's light always splashes on your walls before the enemy enters your screen — you fight at pick range, but you see trouble coming as LIGHT.
- **Environment-lock / void bridging (decision, 2026-07-15):** you cannot bridge AIR by digging, and jump reach (~2.5 up / ~5.5 across) bounds what excavations you can re-cross. Canonical fix = **Phase 2 shoring timbers double as FOOTING**: a placed timber tile can be stood on, so the same finite trench-resupplied item shores galleries, bridges player-cut voids, and builds step-ways — the tunneller's slots buy mobility, fitting the team dig economy. Terraria-style pass-through platforms were considered and **declined** (imports a foreign fiction into a game whose identity is "earth is earth"). Placeable spoil/backfill recorded as an open question (very WWI — spoil management + Phase 3 noise hooks — but a whole system: where dug earth goes, carry, placement).
- **Team economy direction (recorded, build later with items):** everyone CAN dig, but the armorer's carry slots decide who digs WELL — dedicated tunnellers carry the pick + timbers, others carry weapons/geophone/map instead (slower entrenching-tool digging only). This is what prevents a hypothetical 10v10 from becoming 20 moles: role emerges from loadout scarcity, not class locks. Design the Phase-4 item list with this explicitly in mind.
- **Armorer/items staging (answer recorded):** Phase 2 introduces the first carried item (shoring timbers, finite, trench resupply); Phase 3 adds the geophone; Phase 4 delivers the full armorer station with carry slots, weapons/ammo, and map/compass as slot items.
- **[done] WWI uniforms (placeholder art):** player is British — khaki + Brodie wide-brim helmet. AI Germans get spike helmets (pickelhaube) in Phase 4.
- **[done] Trench dressing & surface access:** trenches are narrower (7 tiles), with plank revetment walls, duckboard floors, sandbag parapets, and a ladder up the enemy-facing wall. The surface/no-man's-land is reachable over the top.
- **Phase 4 — surface overwatch fire:** the surface must be a terrible place to be. When a soldier is on the surface and spotted (easy to be spotted up top), enemy MG/sniper overwatch opens up after a short exposure warning — crossing overland is near-suicide, reinforcing tunnels as the only sane route. Tune exposure timer/damage in config.
- **Phase 4 — combat emphasis:** gritty and scarce. Knife is the primary weapon (silent, ugly, personal). The pistol carries ONE magazine only — no belt reloads in the tunnel; resupply only at your trench armorer. This keeps the gun a last resort rather than OP.
- **No hard classes — armorer builds instead:** rather than locked classes (tunneler/medic/explosives/captain), your own trench has an **armorer station**: before heading down you draw equipment into a limited number of carry slots. "Class" emerges from the build (lamp choice, geophone, map, compass, timbers, ammo, future medic/explosive kit all compete for slots). AI squadmates in Phase 4 may still use role presets built from the same items. A commander/captain role can arrive later as items (officer's compass, whistle), not a class. Classes-as-presets can be revisited after v1.
- **Phase 4 — navigation costs slots and hands:** the compass and the dead-reckoned map are inventory items occupying armorer slots, and *using* either occupies your hands (stops digging/weapons, dims lamps for the map) — navigation is a deliberate act, not a free overlay.

## Phase 1.5 — Hardening + Worldgen v3 (inserted before Phase 2)

Five stages, strictly in order, one per session, checkpoint report at each: **(1) determinism harness** (sim-state hash, command recorder/replayer, golden-seed regression test) · **(2) transcendental-math sweep** (no trig/exp/pow inside the sim boundary; lookup tables; guard check) · **(3) `Loadout` data-model stub** (slots + item ids as data only; lamp choice migrates into it) · **(4) worldgen v3** (900-wide map, three depth bands with `bandAt(x,y)`, rock curtains with gaps, 5-point capture chain with flag poles — trenches and fortified craters, abandoned workings, enemy pre-dug network, emitted `WorldRegions` data, 50-seed batch validation) · **(5) crossing playtest v2 support** (`?start=`, overlay additions, PLAYTEST.md gate: ~3–4 min to first meaningful decision, punctuation every 60–90 s).

Locked decisions: pacing is fixed by worldgen punctuation, NOT by touching dig speeds/movement/camera; determinism rules apply to all new code; every tunable in config.

**Stage log:**
- Stage 1 complete (2026-07-14) — state hash (dual-lane FNV-1a; coverage documented in `src/sim/hash.ts`), R-key recorder + drag-drop replayer with self-verifying session files, golden test green 10/10 with coverage assertions and tile-flip sensitivity check built into every run.
- Stage 2 complete (2026-07-14) — transcendental sweep: deterministic 4096-entry sin table (`src/core/trig.ts`, built with pure arithmetic); dig fan rewritten as vector rotations (no atan2 at all); cone cosines and vector lengths deterministic (`Math.hypot` treated as banned too — implementation-defined precision). Guard integrated into `test:golden`, proven to fail on an injected `Math.sin`. Golden hash did NOT change — tile quantization absorbed the ≤0.09° fan differences — so no re-baseline was needed.
- Stage 3 complete (2026-07-14) — Loadout data stub: 4 carry slots on the soldier, ten item defs as data (`items.ts` with append-only `ITEM_ORDER` for hashing), lamp choice migrated into the loadout (`carriedLamp` now derived; F/G behavior verified identical, G still trench-gated). Loadout registered in the state hash — golden re-baselined ONCE for the layout change (behavior coverage identical before/after).
- Stage 4 complete (2026-07-14) — Worldgen v3: 960×224 map (width fixed by the spacing arithmetic — asserted at gen, documented in config); three noise-warped depth bands behind `world.bandAt(x,y)`; 5-point capture chain (homes · trench lines with saps both faces · fortified crater with 3–4 wall mouths at different depths — Q2's v1 answer) with inert flag-pole tiles; rock curtains (one per interval, 2–4 diggable gaps each, ≥1 clay, clay/chalk seam tells — Q1's v1 answer, `tellsEnabled` flag); 3–5 sealed abandoned workings (rubble plugs, rotten timbers); enemy pre-dug network from the east sap (laddered shaft, gap-routed crossings, exactly one marked dead-end drive); serializable `WorldRegions` registered in the state hash (deliberate: golden now catches worldgen regressions); debug region view (B ×4). `npm run test:worldgen`: 50 seeds × 7 contracts, all green in ~4.5 s, including a dig-cost Dijkstra pacing proxy — west first leg gated at 80–300 proxy-seconds (recalibrated from the prompt's 150–300 with measured distribution: min 95 / median 123 / max 289 ≈ 3–4 real minutes at median; east leg deliberately cheap via the enemy network, reported ungated). Golden re-authored against the new geometry (adds sap-entry + ≥2-materials coverage) and re-baselined ONCE for worldgen v3 + the WorldRegions hash registration. Checkpoint: CHECKPOINT-STAGE4.md.
- Stage 5 support complete (2026-07-14) — crossing playtest v2: `?start=` capture-point spawns (a Sim INPUT recorded in session files — replays reproduce it; golden default unchanged, hash identical, no re-baseline); playtest HUD (elapsed sim time · depth band · distance to next point east, `debug.playtestHud`); PLAYTEST.md defines the human gate (~3–4 min to first meaningful decision, punctuation every 60–90 s, 3 named seeds spanning the pacing distribution, surface travel banned by fiat) plus the approved worldgen-only tuning levers. **Phase 1.5 exits through that human playtest — Phase 2 waits for it.**

## Explicitly out of scope for v1 (do not build, do not preclude)

Online multiplayer (the deterministic sim + command-stream input is the prep for lockstep — protect that seam), explosive charges / camouflet counter-mining, water flow & flooding (water pockets generate but stay inert), bad-air/ventilation, corpse-to-skeleton aging, sprite-sheet art pass.
