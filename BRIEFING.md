# Tunnel Rats — Complete Project Briefing

*Status date: July 14, 2026. Covers Phase 1 (complete, 7 playtest revisions) and Phase 1.5 Stages 1–3 (complete). Self-contained for design brainstorming — no codebase access assumed.*

---

## 1. What the game is

**Tunnel Rats** is a 2D real-time tunnel-warfare game inspired by WWI mining warfare. Terraria-style side-view tile world, but the game lives underground: opposing trenches at the ends of a map, all combat in player-dug tunnels, absolute fog of war (you see only what your lamps light), and sound as the primary sensing mechanism. v1 is single-player vs an AI enemy team; the architecture deliberately protects a future lockstep-multiplayer seam.

**Where we are:** Phase 1 (world, movement, camera, light) is complete after seven playtest revision rounds. Phase 1.5 (hardening + worldgen v3) is 3 of 5 stages done. Phases 2–5 are untouched. Build process: strict phase/stage order with a human playtest gate or checkpoint report at every step.

## 2. Architecture snapshot

- TypeScript + Vite + Canvas 2D. Zero runtime dependencies. Every gameplay constant lives in one `config.ts`.
- **Deterministic sim at 30 Hz**, renderer interpolates at display refresh. Input becomes per-tick command structs; the sim never sees raw events, wall-clock time, or `Math.random()` — one seeded PRNG, same seed + same commands = bit-identical world. This is the multiplayer seam, and Phase 1.5 hardened it (see §5).
- Tile world in flat typed arrays: **1200×400 tiles at 8 px** (halved from 16 px during playtesting — same physical world, double resolution; worldgen v3 will change dimensions again). Soldier is 3.5 tiles tall; tunnels are 4; `?seed=` fixes the world.
- Two-layer lighting living **in the sim** (Phase 4 AI must "see only lit tiles"): semi-static sunlight (column scan + local bleed, recomputed only near changes) and per-tick raycast lamp light with real shadows. Unlit = pure black.

## 3. Phase 1 as built (through playtest r7)

### World
- Seeded strata: topsoil/root mats → clay (loam lenses) → chalk; embedded sand pockets (fast/loud/unstable), rock intrusions (undiggable), water pockets (inert v1: solid, undiggable — flooding out of scope).
- Verified on every test seed: a straight trench-to-trench line crosses hundreds of rock/sand tiles — beelines always blocked.
- **Realistic trenches** (r4): floor ~5 tiles (≈7 ft) below local ground; plank revetment, duckboards, sandbag parapets, ladder up the enemy-facing wall.
- **Sap gallery** (r4): each trench has a pre-dug, timber-lintelled tunnel mouth at floor level in the enemy-facing wall, sloping down under no-man's-land — solves "the walls look solid" and marks where tunnelling begins.
- Surface/no-man's-land exists and is walkable — currently safe; becomes deadly in Phase 4 (overwatch).

### Soldier
- WWI Tommy placeholder: khaki tunic, webbing, belt, pack, puttees, boots, Brodie helmet + chinstrap. Germans get pickelhauben with the Phase 4 AI.
- **The head aims**: head+helmet turn and pitch toward the cursor; the headlamp lens is fixed to the helmet brow, so light follows the head.
- Distance-driven walk cycle (no foot-sliding), bob, air pose, ladder pose; **crouch = taking a knee** (~70% height, 3-tile crawlspaces).
- Platformer physics: auto step-up, coyote time, jump buffering, ladder climbing, fall damage past 10 tiles.

### Lamps (a loadout, not toggles)
- Exactly **one lamp carried**: headlamp (long aimed cone, real shadows) or hip lamp (short omni pool). `F` = power; `G` swaps type **only at your own trench** (armorer embryo). Faint always-on self-glow (Phase 2 burial reuses it).

### Digging — the most-iterated system (4 redesigns)
1. Hold LMB: the pick swings in ~0.55 s cycles (first swing pre-wound → first blow ~130 ms after click). Chunky, animated, debris particles.
2. The aim ray plus a wide up-biased fan finds the **nearest wall contact** within ~2.8 tiles.
3. The blow bites a **face window** sized by what a body needs (a point-origin arc collapses to nothing at close range — it wedged forward tunnelling twice before this model):
   - **Level aim** → the wall column across the digger's own passage height. Floor untouched; no vertical creep. Verified: 133 tiles of dead-level tunnel dug hands-off, zero pits, zero drift.
   - **Inclined aim** (r7) → a walkable **ramp**: window slides along the aim slope + one headroom row (walkable both directions); ascent capped ~45° (steeper strands faces out of reach; also the real stair limit). Flanking galleries — down, long, up under them — fully diggable.
   - **Vertical aim** → body-wide shaft.
4. Contacted tiles split one swing's progress — per-material rates from config (clay ≈ 3–4 swings/column, sand instant, chalk between).
5. **Telegraphing** (r6): while swinging, the next blow's tiles are outlined — white = will dig, red = won't (light-gated). Rock/timber strikes throw sparks; water splashes blue — undiggable ground is readable before Phase 3 audio arrives.

### Camera
- ~60×34 tiles visible, smooth follow + aim lead; bounds clamp uses the real window size. "Never show the surface while underground" kept but softened: top edge may reach (never pass) the surface line, and the clamp **eases** instead of snapping.

### Materials (per-layer data, all tunable now)
Topsoil fast/weak · root mats binding · clay slow/quiet/self-supporting · sand instant/loud/treacherous · chalk medium/VERY loud · rock & water undiggable. Phase-3 noise radii and Phase-2 stability bases already defined. Rubble and timber tile types exist.

## 4. Design decisions from playtesting (with rationale)

| Decision | Rationale |
|---|---|
| One lamp carried; swap at trench only | Light discipline as a loadout choice; first brick of the armorer. |
| No hard classes — **armorer + carry slots** | One soldier in single-player; "class" emerges from what you draw. AI squadmates can use role presets from the same items. |
| **Team dig economy** (for Phase 4 items): everyone *can* dig; slots decide who digs *well* | Prevents 10v10 becoming 20 moles: the tunneller spends slots on pick + timbers; others carry weapons/geophone/map and dig slowly with an entrenching tool. Role from scarcity, not locks. |
| Pistol = **one magazine**, resupply only at trench | Gun stays a loud last resort; knife is the primary, silent, gritty weapon. |
| **Surface overwatch fire** (Phase 4) | Spotted on the surface → warning → MG death; tunnels stay the only sane route. |
| Map & compass are **slot items that occupy your hands** | Navigation is a deliberate, vulnerable act. Dead-reckoned map drifts; re-anchors at the trench. |
| Water solid + undiggable in v1 | Blocks beelines without a fluid sim. |
| 8 px tiles + neighbor color blending | Blows bite 3–5 small tiles → dynamic excavation, earth-not-blocks look. Full texture pass in Phase 5. |
| Pacing fixed by **worldgen punctuation**, never velocity | Locked during Phase 1.5 planning: dig speeds/movement/camera untouched; the map's structure creates the rhythm. |

## 5. Phase 1.5 — Hardening (Stages 1–3 complete)

Inserted before Phase 2 so every later system inherits real guarantees. Rules in force: five stages, strict order, one per session, checkpoint each; determinism sacred; all tunables in config; nothing from Phase 2+ built early.

### Stage 1 — Determinism harness ✅
- **Sim-state hash**: hand-rolled dual-lane FNV-1a digest over *everything the sim owns* — full tile array, PRNG state, tick counter, complete player state including invisible internals (coyote/jump-buffer timers) and the key-sorted dig-progress map. Derived data (both light layers) and renderer state excluded. The hash module header is a **living registry**: every future system (stability, corpses, items, noise, AI, capture ownership) must register its state there — the safety net only protects what the hash can see.
- **Recorder/replayer**: `R` restarts the world from its seed and records every per-tick command; `R` again downloads a session JSON `{version, seed, commands, finalHash}` (aim floats round-trip bit-exactly). Drag a session onto the game → rebuilds from the seed, replays tick-by-tick, auto-compares the final hash ("REPLAY OK"/"MISMATCH"). Decisions: record-restarts-world (a mid-session start state can't be reconstructed); drag-drop over URL param; embedded `finalHash` makes every replay self-verifying.
- **Golden-seed regression test** (`npm run test:golden`): fixed seed + fixed ~2,400-tick script (walk, jump, ladder, level/incline/vertical digs, crouch, lamp swap) must land on a stored hash. Every run also runs the sim twice (must agree), flips one tile (hash must change — proves the hash sees the world), and asserts coverage flags. `--update-golden` for intentional changes only. 10/10 passes; a real recorded browser session replayed twice to identical hashes.

### Stage 2 — Transcendental-math sweep ✅
JS guarantees cross-engine bit-identical `+ − × ÷ sqrt` — but **not** `sin/cos/atan2/pow/exp/hypot`. Any of those in the sim would eventually desync lockstep peers. Found exactly four sites; replaced them:
- **4096-entry sine table** built with pure arithmetic (Taylor step + angle-addition recurrence) — identical on every machine. Cone angles read from it; lengths use `sqrt(x²+y²)`.
- The dig fan lost angles entirely: the facing vector is **rotated directly** by precomputed table entries — the sim now contains no angle math at all, only direction vectors.
- A **guard** in the golden test scans sim sources (comments stripped) for banned functions + `Math.random` + wall-clock, failing with file:line. Proven by injecting `Math.sin` — caught immediately.
- Table quantization ~0.09°: invisible in the lamp cone; the golden hash didn't even change. Decision beyond the prompt: `Math.hypot` added to the ban list (implementation-defined precision — same hazard class).

### Stage 3 — Loadout data-model stub ✅
The carry-slot skeleton the armorer grows into — **data only, zero new behavior**:
- Soldier has **4 slots** (config). Ten items defined as data (id, name, stack size): pick, entrenching tool, timbers, pistol, knife, geophone, compass, map, headlamp, hip lamp. Nothing consumes them yet.
- **Lamp choice migrated into the loadout**: soldier starts with pick (slot 0) + default lamp (slot 1); "which lamp" is now derived from slots. `F`/`G` verified byte-identical in behavior, including the trench-only gate on `G`.
- Loadout registered in the state hash via an **append-only** canonical item order (reordering would invalidate every future hash — documented loudly). Golden re-baselined once, intentionally, for the layout change; behavior coverage identical before/after.
- Decision beyond the prompt: the **pick occupies a real slot** from day one — it's exactly what a fighter build trades away for the entrenching tool in the team-economy design.

### Standing infrastructure after Stages 1–3
- One command (`npm run test:golden`, ~2.5 s): math-guard scan + double-run determinism + tile-flip sensitivity + coverage + golden compare.
- In-game: `R` record · drag-drop replay · `H` print state hash · debug overlay shows loadout, record/replay status, last hash.
- The rules are enforced by tooling, not discipline: no nondeterministic math, no silent behavior drift, no unregistered state (registry convention).

## 6. What remains

### Phase 1.5 Stage 4 — Worldgen v3 *(next, the big one)*
900-tile-wide map. Three queryable **depth bands** (shallow/clay/basement; `bandAt(x,y)` for later systems). 3–5 near-vertical **rock curtains** between capture points, each pierced by 2–4 diggable gaps (≥1 in the clay band), replacing scattered blobs. A **5-position capture-point chain** (two home trenches + three intermediates alternating trench-line / **fortified crater**; flag poles; ends owned, middles neutral; only 3 active in v1 but generation makes 5). 3–5 sealed, dark, partially-collapsed **abandoned workings** (rubble plugs, rotten timbers) reachable only by digging. An **enemy pre-dug network** branching 150–250 tiles from their sap, one branch dead-ending on purpose (the player digs their own war — the friendly side keeps only its short sap). A serializable `WorldRegions` object for later phases + a debug region view. 50-seed batch validation: beeline blocked, adjacent-point paths exist (flood-fill), curtains have ≥2 usable gaps, spacing in range, workings sealed and isolated, enemy net connected. Golden re-baseline once.

### Phase 1.5 Stage 5 — Crossing playtest v2 support
`?start=point2`-style spawn params; overlay: distance-to-next-point, depth band, elapsed time; PLAYTEST.md defining the human gate — **~3–4 minutes of digging to the first meaningful decision, punctuation every 60–90 s**, measured on 3+ seeds, surface travel banned by fiat.

### Phases 2–5 (unchanged plan, amended by playtest decisions)
- **Phase 2:** stability scores, shoring timbers (first real item, trench resupply), warning tells → propagating collapses, sand runs, rubble re-digging, burial with suffocation timer, persistent corpses holding gear. ⚠ Tune stability against today's 4-tall fast-opening tunnels, not the original 2-tall assumption.
- **Phase 3:** central noise-event system (dig noise by material — rock clinks carry far; footsteps, timber, collapses, gunshots), positional audio + screen-edge ripple, **geophone** (stand still, no weapon, bearing with distance vagueness, self-noise ruins it), ambient bed. Much of the remaining dig-feel gap is audio.
- **Phase 4:** knife-primary combat + one-mag pistol (muzzle flash lights the gallery, shots chip stability), **full armorer station** (slots, weapons, nav items — the builds-not-classes system, designed against the team dig economy), surface overwatch, AI team with the same senses as the player (lit tiles + noise events only), respawn, capture/hold win condition.
- **Phase 5:** feel pass — screen shake, particles, audio mix, difficulty, menus, full earth-texture treatment, worldgen loading screen (~0.5–0.8 s cold today).

## 7. Open questions for brainstorming

1. **Curtain gap discoverability** — ✅ ANSWERED IN STAGE 4 (v1): every gap gets a thin **seam tell** running through the strata into the curtain face — clay-colored in the shallow/basement bands, chalk-colored inside the clay band (clay-on-clay would be invisible in lamplight). Config-gated (`gen.curtains.tellsEnabled`) so playtests can compare with tells off. Does not preclude the geophone becoming the "real" discovery tool in Phase 3. Bonus surface hint discovered in play: curtains reach the surface, so their rock line is visible up top — a landmark for anyone who dares the surface.
2. **Crater identity** — ✅ ANSWERED IN STAGE 4 (v1): the topology is the identity. Open bowl with NO continuous parapet (scattered sandbag clumps only — cover fragments, not a wall), broken rubble ground, and 3–4 **wall mouths at different depths** (≥1 near the bowl floor, ≥1 high). A linear trench has two ends to watch; a crater cannot be watched from one spot. Phase 4's fight over the center inherits this geometry.
3. **Abandoned workings risk/reward** — free tunnel distance, but pre-collapsed (Phase 2 makes rubble plugs/rotten timbers dangerous) and ambush terrain (Phase 4). What belongs inside: corpses with gear, salvageable timbers, lore?
4. **Enemy network use** — how much should the Phase 4 AI actually patrol it vs. it being dread-scenery the player breaches into?
5. **Which 3 of 5 points are active in v1?** Ends + center is the obvious default; asymmetric alternates could vary seeds.
6. **Armorer economy** — how many slots (4 today), what earns one, is the armorer's stock finite per side (interesting for multiplayer later)?
7. **Corpse economy** — corpse-running as tension (geophone-able noise) vs. chore; does lost gear regenerate at the armorer?
8. **Crossing pacing** — Stage 5's gate encodes the target (3–4 min to first decision, punctuation every 60–90 s); worldgen v3's spacing/curtain knobs are the levers if playtests miss it.
9. **Spoil / backfill** (raised by the 2026-07-15 playtest) — dug earth currently vanishes; real tunnellers drowned in their own spoil. A placeable-spoil system would let players backfill voids ("add dirt"), bridge their own cuts, and hide workings — and dumping spoil is noisy/visible (Phase 3/4 hooks). Big system (carry, placement, spoil economy); Phase 2's timbers-as-footing covers the traversal need for now. Revisit alongside the armorer economy.

## 8. Current controls

A/D move · W/Space jump + climb ladders · S crouch/kneel + climb down · mouse aims head & pick · hold LMB dig (outlines show the next bite) · F lamp power · G swap lamp at own trench · `` ` `` debug overlay · B debug views · N new seed · R record session · H print state hash · drag-drop session JSON = replay
