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

## Seeds (from the validated 50-seed batch — spread across the pacing distribution)

| # | URL | West-leg proxy estimate | Why it's in the panel |
|---|---|---|---|
| 1 | `?seed=610462366`  | 95 s (fast tail)   | fastest healthy seed — punctuation density check |
| 2 | `?seed=19569978`   | 123 s (median)     | the typical crossing |
| 3 | `?seed=2025286815` | 256 s (slow tail)  | slowest-but-passing — boredom check |
| alt | `?seed=3746043038` | 289 s (slowest)  | substitute if any seed above feels compromised |

Proxy seconds assume perfect play; real time runs ~1.5–2× (median seed ≈ 3–4 real minutes to the
first curtain — which is why the batch gate sits at 80–300 proxy-s; see CHECKPOINT-STAGE4.md §1).

`?start=` isolates legs when a full crossing isn't needed: `?start=p1` / `?start=center` /
`?start=p3` / `?start=east` spawn at that point (recorded in sessions, so replays reproduce).
Useful for re-measuring a middle leg after a worldgen tweak without replaying the first leg.

## Results

| seed | T-first | first decision was | punctuation gaps (s) | T-crater | verdict |
|---|---|---|---|---|---|
| 610462366 | | | | | |
| 19569978 | | | | | |
| 2025286815 | | | | | |

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
