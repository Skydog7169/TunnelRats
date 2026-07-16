# Crossing Playtest v2 — the Stage 5 human gate

*Phase 1.5 exits through THIS document. The 50-seed batch (`npm run test:worldgen`) already
proves every seed is structurally sound and inside the proxy pacing band; what only a human can
measure is whether the crossing FEELS right. Worldgen v3 is accepted when the two criteria below
hold on 3+ seeds.*

## The gate

1. **First meaningful decision at ~3–4 minutes.** From spawn, digging east, the map must force
   its first real route choice at roughly 3–4 minutes of play (acceptable window 2.5–5). The
   canonical first decision is reaching the first rock curtain and choosing a gap — shallow
   (fast, loud, unstable) vs clay (slow, quiet, safe) vs basement chalk (deep, VERY loud) — but
   an unavoidable water pocket or a sand run that forces a reroute counts too.
2. **Punctuation every 60–90 seconds.** After the first decision, something map-driven should
   interrupt autopilot digging at least every 90 s: curtain contact, spotting a tell seam,
   crossing a gap, bursting a sand pocket, clinking rock or water, crossing into a new band
   (chalk gets LOUD in Phase 3 — for now it reads as a color change), breaching an abandoned
   working, arriving at a trench line or the crater. Stretches > 90 s of uninterrupted straight
   digging are a fail signal; so is constant interruption (< ~30 s median) — the crossing should
   breathe.

**Rules during a run** (fixed by fiat):
- **No surface travel** outside a capture point's footprint. Over-the-top movement between
  points is banned — Phase 4 makes it lethal; v1 just forbids it.
- No config edits mid-run; default loadout; dig speed / movement / camera are LOCKED levers.

## Protocol (per seed)

1. Open the seed URL (below). The playtest HUD (top center) shows **elapsed sim time · current
   depth band · distance to the next point east**.
2. Press `R` once — the world restarts from the seed and records every tick.
3. Dig east toward the center crater. Note from the HUD clock:
   - **T-first** — time of the first meaningful decision (and what it was);
   - **punctuation timestamps** — each map-driven interruption (one word each);
   - **T-crater** — arrival at the center crater floor, if reached.
4. Press `R` again — the session JSON downloads (self-verifying; drag it back onto the page any
   time to re-watch the run).
5. AFTER the run, `` ` `` + `B`×3 (region view) to review what the map had placed vs what you
   found — tells you whether tells/gaps are discoverable, but spoils the seed, so always last.

### Probing (standard procedure at curtains)

When the pick **clinks on rock** (sparks fly), do not commit to a new direction blind — **sweep
the aim across the face and the rows above/below** while still swinging: the telegraphed
outline is the probe. **White outline = diggable. Red outline = rock/water — don't bother.**
A gap in a curtain is a window of white on an otherwise red wall; a tell seam says "somewhere
near here," and the probe closes the last few tiles. Treat *dig → stop → probe → dig* as the
standard rhythm at every curtain face (playtest run 1 on seed 54715452 dug vertically THROUGH
an open gap without noticing it — the probe would have caught it in one sweep).

*Design rationale:* pick-probing is the v1 stand-in for the Phase 3 geophone rhythm — stop,
sense, then act. The tell narrows the search; the probe finishes it.

### Recovery (getting back out of your own diggings)

- **Stairs, not shafts.** Aim moderately up/down (the r8 stair mode — a faint ghost preview
  shows the next two steps) and you carve a walkable ±1 staircase you can always retrace.
  You can dig OUT of any hole this way: face a solid wall, aim up ~45°, and climb as you cut.
- **You cannot bridge air.** Digging removes earth, never adds it; jump reach is ~5 tiles up
  and ~11 across (4px tiles — same physical arc as ever). Until Phase 2's placeable timbers
  land, don't cut a pit or shaft wider than ~11 tiles unless you're prepared to stair-case
  down into it and back out the far side.
- If you do get cornered: dig a fresh up-staircase through virgin earth — it always exists —
  or take the death respawn (the world persists; only your position resets). Log any spot
  where recovery took more than ~30 s in the results notes: that's r8 feedback.

## Seeds (r10 panel — from the validated 50-seed batch, spread across the pacing distribution)

| # | URL | West-leg proxy | est. T-first | Why it's in the panel |
|---|---|---|---|---|
| 1 | `?seed=4201562141` | 130 s (fastest) | ~2.5 min | fastest healthy seed — punctuation density check |
| 2 | `?seed=1573859174` | 152 s (median)  | ~2.9 min | the typical crossing |
| 3 | `?seed=1933126768` | 272 s (slow)    | ~2.8 min | slow tail — boredom check |
| alt | `?seed=230975198` | 402 s (slowest outlier) | ~2.8 min | the extreme the new 420 s ceiling allows — a boredom veto here should tighten `validation.pacingMaxS` |

⚠ CALIBRATION AMENDED (r10, 2026-07-16 panel): real dig throughput measured ≈ **1.0× proxy**
(sustained advance ≈ 2.3 tiles/s), not the 1.5–2× Stage 4 assumed. Est. T-first above = curtain-0
distance ÷ measured pace. The pre-r10 panel seeds (610462366 / 19569978 / 2025286815) generate
DIFFERENT worlds since r10 (map 1920→2496, spacing 450–560, east-biased curtains, punctuation
deficit pass) — their recorded sessions no longer replay against current worldgen.

`?start=` isolates legs when a full crossing isn't needed: `?start=p1` / `?start=center` /
`?start=p3` / `?start=east` spawn at that point (recorded in sessions, so replays reproduce).
Useful for re-measuring a middle leg after a worldgen tweak without replaying the first leg.

## Results

### Panel run 1 — 2026-07-16, pre-r10 worlds (map 1920, uniform curtains)

All sessions R-recorded, hash-VERIFIED, and replay-analyzed headlessly (timelines extracted from
the sim, not from notes). Runs ended at P1; T-crater unmeasured.

| seed | T-first | first decision was | punctuation gaps (s) | T-crater | verdict |
|---|---|---|---|---|---|
| 610462366 | 1:31 | curtain 0 clink → gap crossed 2:07 | 30 · 62 · 36 · 27 (max 62, med 36) ✓ | — (P1 @ 2:34) | punctuation PASS · **T-first EARLY** |
| 19569978 | 0:44 | curtain 0 clink → crossed 0:52 | 31 · 14 · 8 · **98** (>90 fail signal) | — (P1 @ 2:30) | **T-first EARLY · one dead stretch** |
| 2025286815 | 1:50 | curtain 0 clink → crossed 1:56 | 57 · 53 · 6 · 25 (max 57, med 53) ✓ | — (P1 @ 2:21) | punctuation PASS · **T-first EARLY** |

**Panel verdict: FAIL on criterion 1** — first decision at 0:44–1:50 against the 2.5-min floor,
consistently ~2× early because real throughput ≈ 1.0× proxy (see calibration note above). The
map structurally COULD NOT satisfy the window: at 2.3 tiles/s a ~356-tile interval is fully
crossed in ~2.6 min, so no curtain placement inside it can land at 3–4 min.

**r10 retune applied** (the documented levers, worldgen structure only): map.width 1920→2496 +
spacing 450–560 (~500-tile intervals), `gen.curtains.intervalBias` [0.55, 0.85] (east-biased
walls — also shortens the post-curtain dead stretch that produced 19569978's 98 s), pocket counts
×1.3, punctuation deficit pass (featureless cap now generative), `validation.pacing` band
re-derived 80–300 → 110–420. 50/50 batch green; golden re-baselined. Est. T-first on the new
panel: 2.5–2.9 min.

### Panel run 2 — r10 worlds (owed)

| seed | T-first | first decision was | punctuation gaps (s) | T-crater | verdict |
|---|---|---|---|---|---|
| 4201562141 | | | | | |
| 1573859174 | | | | | |
| 1933126768 | | | | | |

## If the gate fails — tuning levers (worldgen structure ONLY)

Dig speed, movement, and camera are locked (recorded decision). In rough order of leverage:

- **First decision too early/late** → `gen.curtains.pointMargin` (pushes curtain 0 toward/away
  from the home footprint) and `gen.points.spacingMin/Max` + `map.width` — but read the
  width↔spacing arithmetic comment at `gen.points` first; the assert will catch violations.
- **Too little punctuation between curtains** → raise `gen.sandPockets.count` /
  `gen.waterPockets.count`, or add a second curtain per interval
  (`gen.curtains.perInterval` — an explicitly experimental knob).
- **Gap choice not landing as a decision** → `gen.curtains.gapMinDepth` (deeper shallow gaps =
  costlier fast route), `gapsMin/Max` (fewer gaps = starker choice), `tellsEnabled` off to test
  whether tells carry the discovery moment.
- **Workings never encountered** → `gen.workings.countMin/Max` or widen `workings.intervals`.

After ANY change: `npm run test:worldgen` must stay 50/50 green (the proxy distribution in its
summary shows how far the change moved pacing before a human replays a single seed), and
`npm run test:golden` must still pass — re-baseline only for intentional worldgen changes, once,
with the reason in the commit message.
