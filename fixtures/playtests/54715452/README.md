# Playtest fixtures — seed 54715452 (crossing playtest v2, 2026-07-15)

Three recorded sessions (v1 session format: `{version, seed, start, commands, finalHash}`),
all **hash-verified** against the current build at capture time — drag any of them onto the
running game to re-watch, and the replayer auto-compares the final state hash.

| file | length | what it shows |
|---|---|---|
| `run1-crossing-attempt.json` | 04:01, dig held 68% | Disciplined underground crossing attempt. Reached curtain 0 at 1:54 after a 105 s featureless topsoil run; found the chalk tell at 2:31; wall-followed vertically THROUGH the open gap (rows 73–79) without recognizing it; ended stuck probing rock below it. Source of the Stage-4 follow-up findings (probing protocol + featureless-span validator check). |
| `run2-surface-over-curtain.json` | 01:43, dig held 76% | Crossed curtain 0 **over the top** at the surface, dropped into P1's trench. |
| `run3-surface-jog-to-crater.json` | 00:58, dig held 0% | Pure surface jog from the west trench to the center crater (x≈476) in under a minute. Zero digging. |

## ⚠ Contract: runs 2–3 are the Phase 4 SURFACE-OVERWATCH ACCEPTANCE FIXTURES

Runs 2 and 3 are hash-verified proof that, in the v1 world, **the surface bypasses the entire
tunnel game in under two minutes**. Surface travel is currently banned only by playtest fiat
(PLAYTEST.md); DESIGN.md's Phase 4 closes it for real with overwatch fire (exposure warning →
MG/sniper death).

**When surface overwatch lands, replaying runs 2 and 3 must end in the soldier's death** —
i.e. the recordings must no longer reproduce their stored `finalHash` (the sim state diverges
the moment overwatch damage exists), and a Phase 4 acceptance test must assert exactly that:

- replay `run2-surface-over-curtain.json` → soldier dies on the surface before reaching P1;
  final hash ≠ stored hash.
- replay `run3-surface-jog-to-crater.json` → soldier dies well before x≈476;
  final hash ≠ stored hash.
- replay `run1-crossing-attempt.json` (stays underground after the opening trench exit) —
  expected to remain LARGELY reproducible; if overwatch alters it, document why.

No replay-assertion tooling exists yet — building it is explicitly a Phase 4 concern.
This README is the contract; the JSONs are the evidence. Do not regenerate or "fix" them:
their value is that they were recorded by a human against the Stage-4/5 build.

Note: any intentional sim/worldgen change between now and Phase 4 (there will be several —
stability, items, noise) also breaks these hashes for benign reasons. That is fine: the Phase 4
test's assertion is *the soldier dies on the surface*, demonstrated by divergence + death state,
not mere hash inequality. Keep the death check primary.
