// ============================================================================
// Tunnel Rats — ALL gameplay tunables live here. Edit freely.
// Units: distances in TILES, times in SECONDS unless noted. 1 tile = 4 px
// (halved 16→8 in playtest r3, 8→4 in r9 — same physical world each time:
// every tile-denominated length/speed/accel doubles, per-tile dig times
// rescale by (old rows × old cols)/(new rows × new cols) per physical
// advance, per-tile light transmit takes the square root, per-tile linear
// decays halve. Diagonal cuts read as bores, not stairs — the r9 goal).
// Per-second values are converted to per-tick inside the sim (30 Hz).
// ============================================================================

export const CONFIG = {
  sim: {
    tickRate: 30, // fixed sim Hz. Renderer interpolates between ticks.
  },

  map: {
    width: 1920,  // tiles (worldgen v3 — see gen.points for the spacing arithmetic)
    height: 448,  // tiles (everything below the basement rock floor stays trimmed)
    tileSize: 4,  // px per tile (render only)
  },

  // --------------------------------------------------------------------------
  // World generation v3 (all seeded; tweak then press N in-game to regen)
  // --------------------------------------------------------------------------
  gen: {
    surfaceBaseY: 72,      // average surface row
    surfaceAmp: 20,        // surface height noise amplitude
    surfaceFreq: 0.00375,  // surface noise frequency (per tile — halves with tile size)

    // Depth bands (queryable via world.bandAt(x, y) — Phase 2 stability,
    // Phase 3 noise, Phase 4 AI all read this). The bands ARE the strata:
    //   shallow  = topsoil/root mats/sand — fast, loud, unstable
    //   clay     = clay + loam lenses     — slow, quiet, self-supporting
    //   basement = chalk shading to rock  — closes off the bottom
    bands: {
      shallowThickness: 52, // avg thickness of the shallow band below the surface
      shallowAmp: 20,       // noise warp of the shallow/clay boundary
      clayBottomY: 296,     // avg row where clay gives way to the basement
      clayBottomAmp: 28,    // noise warp of the clay/basement boundary
      warpFreq: 0.005,      // frequency of both boundary warps
      basementChalkRows: 68,// chalk depth below the clay band before solid rock
      chalkRockDither: 16,  // rows over which chalk speckles into rock (shading)
    },

    rootMatDepth: 12,      // root mats appear within this many tiles below surface
    rootMatThreshold: 0.52,// noise > threshold => root mat (0..1, lower = more roots)
    loamLensThreshold: 0.72, // fbm > threshold => loam lens inside the clay band

    // Capture-point chain: 5 positions west→east —
    //   home trench · trench line · fortified crater · trench line · home trench.
    //
    // ⚠ WIDTH ↔ SPACING ARITHMETIC (this is a known trap — the assert in
    // worldgen.ts enforces it loudly). The chain's 4 intervals must EXACTLY
    // fill the span left over after the fixed footprints:
    //   span = map.width − 2·edgeMargin − 2·homeFootprint − 2·lineFootprint
    //          − craterFootprint
    //        = 1920 − 48 − 152 − 152 − 144 = 1424
    // Feasibility requires 4·spacingMin ≤ span ≤ 4·spacingMax, i.e. with the
    // 300/400 band the map must keep span within [1200, 1600]. Additionally
    // |spacingJitter| must satisfy
    //   span/4 − 1.5·jitter ≥ spacingMin  and  span/4 + 1.5·jitter ≤ spacingMax
    // (the ±1.5× comes from the zero-sum jitter renormalization).
    points: {
      spacingMin: 300,      // min tiles between adjacent point footprints
      spacingMax: 400,      // max — see the arithmetic note above before raising
      spacingJitter: 24,    // seeded ± jitter on each interval (zero-sum)
      edgeMargin: 24,       // map edge → home-trench footprint
      homeFootprint: 76,    // home trench: 28-wide trench + parapets + margin
      lineFootprint: 76,    // intermediate trench-line point footprint
      craterFootprint: 144, // crater bowl + broken-ground apron
      active: [0, 2, 4],    // v1: both homes + the center crater (data, not geometry)
    },

    trenchWidth: 28,       // tiles wide
    trenchDepth: 10,       // tiles below the local surface high point (~7 ft: head height + parapet)
    // Sap gallery: the pre-dug, timber-framed tunnel mouth in the enemy-facing
    // trench wall at floor level — where the tunnelers start digging.
    // Intermediate trench-line points get a sap in BOTH faces.
    sapLength: 24,         // tiles of pre-dug gallery into the earth
    sapHeight: 8,          // gallery height (fits a standing soldier)
    sapTimberedLen: 10,    // how many tiles of the gallery ceiling get timber lintels

    // Fortified crater (center point). Identity = topology: an open bowl with
    // NO continuous parapet and several wall mouths at different depths — a
    // trench has two ends to watch; a crater cannot be watched from one spot.
    crater: {
      width: 88,           // bowl diameter at the rim
      depth: 22,           // bowl depth below the local ground line at center
      rimJitter: 3,        // per-column noise on the bowl profile (broken ground)
      floorRubbleChance: 0.4, // fraction of bowl floor tiles turned to rubble
      mouthsMin: 3,        // wall mouths: short stub tunnels punched into the bowl
      mouthsMax: 4,
      mouthLenMin: 10,     // stub length into the wall
      mouthLenMax: 18,
      mouthHeight: 8,      // stub gallery height
    },

    flagPoleAboveGround: 6, // pole tiles rising above the local ground/parapet line

    // Rock curtains: one near-vertical intrusion wall per interval, surface
    // down into the basement rock, pierced only by the gaps. Route choice
    // across a curtain = depth choice.
    curtains: {
      perInterval: 1,      // curtains per interval (experimenting knob)
      thickness: 8,        // avg wall thickness, tiles
      edgeWarpAmp: 5,      // horizontal noise warp of the wall edges (reads as geology)
      edgeWarpFreq: 0.03,
      pointMargin: 52,     // curtain keeps this far from point footprints
      gapsMin: 2,          // diggable gaps per curtain
      gapsMax: 4,
      gapHeight: 14,       // vertical extent of a gap (admits a full-height tunnel + slack)
      gapMinDepth: 24,     // gap top at least this far below the local ground line
      gapMinSeparation: 32,// min vertical distance between gap centers
      gapRetries: 14,      // re-rolls when a candidate window hits water/rock
      tellsEnabled: true,  // GAP_TELLS_ENABLED — clay-seam tells at each gap
      tellLength: 14,      // seam run into the strata on each side of the wall
      tellThickness: 4,    // seam height, tiles
    },

    // Abandoned workings: sealed, half-collapsed old galleries in the middle
    // intervals. Break in by digging; Phase 2 puts corpses/salvage inside.
    workings: {
      countMin: 3,
      countMax: 5,
      intervals: [1, 2],   // interval indices they may occupy (never edge intervals)
      segmentsMin: 3,      // meander segments per working
      segmentsMax: 6,
      segLenMin: 12,       // tiles per horizontal segment
      segLenMax: 28,
      height: 6,           // old cramped galleries (crouch height)
      shaftChance: 0.35,   // chance a segment ends in a short shaft
      shaftDepthMin: 8,
      shaftDepthMax: 14,
      rubblePlugsMin: 1,   // full-height rubble chokes per working
      rubblePlugsMax: 3,
      plugLenMin: 4,
      plugLenMax: 8,
      timberChance: 0.12,  // rotten ceiling timbers per gallery column
      minDepth: 28,        // working top at least this far below ground
      airMargin: 12,       // min tiles between a working and any existing air
      gapMargin: 20,       // min tiles between a working and any curtain gap
      placeRetries: 24,    // placement attempts per working before giving up
    },

    // Enemy pre-dug network: branching galleries from the EAST home sap,
    // extending under no-man's-land toward (never through) the center point.
    // The west side keeps only its short sap — the player digs their own war.
    network: {
      reachMin: 300,       // horizontal extent from the sap mouth, tiles
      reachMax: 500,
      branchesMin: 2,      // drives (the mainline counts as one)
      branchesMax: 4,
      branchLenMin: 36,    // side-drive length
      branchLenMax: 80,
      stubsMin: 1,         // short listening stubs off the galleries
      stubsMax: 2,
      stubLenMin: 6,
      stubLenMax: 12,
      galleryHeight: 8,    // standing height (the enemy are competent tunnellers)
      shaftWidth: 4,       // the access shaft sunk near their sap (laddered)
      depthBias: 0.55,     // target depth as a fraction into the clay band
      centerMargin: 24,    // never closer than this to the center footprint
      waterRetries: 8,     // vertical nudges when a segment would cross water
    },

    // Blob features. Each: count, min/max radius (tiles), y range they can
    // center in. Rock blobs are GONE in v3 — curtains own the blocking job.
    sandPockets:  { count: 60, rMin: 8, rMax: 24, yMin: 84,  yMax: 260 },
    waterPockets: { count: 18, rMin: 8, rMax: 18, yMin: 132, yMax: 352 },
    blobEdgeNoise: 0.35,   // 0 = perfect ellipses, higher = rougher blob edges
    blobPointMargin: 16,   // blob centers keep this far from point footprints

    bedrockRows: 12,       // failsafe solid rock rows at the bottom of the map
  },

  // --------------------------------------------------------------------------
  // Worldgen batch validation (npm run test:worldgen) — Part H thresholds.
  // --------------------------------------------------------------------------
  validation: {
    batchBaseSeed: 20260714, // seed list derives deterministically from this
    batchCount: 50,
    // Pacing proxy: dig-cost-weighted Dijkstra between adjacent points.
    // Cost to enter a tile = walk time (air) or walk + dig time (diggable);
    // dig time per tile = material digTime × pacingTunnelRows (a real passage
    // clears a full player-height column per tile of advance). Rock/water
    // impassable. Open air ABOVE the ground line is impassable outside point
    // footprints (surface travel is banned by fiat — Stage 5 playtest rule).
    pacingTunnelRows: 7, // = ceil(player.height) — r9 passage is 7 rows
    // Band for the WEST first leg (player home → center-adjacent point), in
    // PROXY seconds. Deviation from the Stage-4 prompt's initial 150–300,
    // with rationale: the proxy assumes optimal straight-line digging with
    // zero hesitation and measured ~0.95–1.6× under real swing throughput
    // (r5 playtests: clay ≈ 3–4 swings/column ≈ 1.9 s vs proxy 1.7 s). The
    // 50-seed distribution sits at min 95 / median 123 / max 289 proxy-
    // seconds ≈ 3–4 REAL minutes at the median — the Stage-5 human gate —
    // so 150 proxy-s as a floor would have rejected 2/3 of healthy seeds
    // while a true 60 s freebie or 600 s slog still fails loudly.
    pacingMinS: 80,
    pacingMaxS: 300,
    // The playtest gate's punctuation ceiling: something map-driven must
    // interrupt a digger at least this often (PLAYTEST.md). Feeds the
    // featureless-span batch check via MAX_FEATURELESS_SPAN_TILES below.
    punctuationCeilingS: 90,
  },

  // --------------------------------------------------------------------------
  // Material table. THE central per-layer tuning surface.
  //   digTime:   seconds to dig one tile (0 = undiggable). r9 rescale: a
  //              passage column is now 7 tiles and a physical 8px advance is
  //              2 columns, so per-tile times are old × (4 rows·1 col)/(7·2)
  //              = ×2/7 — seconds per PHYSICAL metre of tunnel are unchanged
  //              (the pacing lock). Fractional sub-tick times are legal.
  //   stability: base stability 0..100 (inert data in Phase 1; drives Phase 2)
  //   noiseRadius: tiles, how far digging THIS material is heard (Phase 3)
  // --------------------------------------------------------------------------
  materials: {
    topsoil: { digTime: 0.034, stability: 25,  noiseRadius: 40  },
    rootMat: { digTime: 0.063, stability: 45,  noiseRadius: 32  }, // roots bind soil
    clay:    { digTime: 0.114, stability: 80,  noiseRadius: 16  }, // slow, quiet, self-supporting
    sand:    { digTime: 0.011, stability: 8,   noiseRadius: 88  }, // fast, loud, treacherous
    chalk:   { digTime: 0.063, stability: 60,  noiseRadius: 104 }, // medium, VERY loud
    rock:    { digTime: 0,     stability: 100, noiseRadius: 0   }, // undiggable
    water:   { digTime: 0,     stability: 0,   noiseRadius: 0   }, // inert v1: solid, undiggable
    rubble:  { digTime: 0.071, stability: 15,  noiseRadius: 48  }, // Phase 2: collapse fill
    timber:  { digTime: 0.143, stability: 100, noiseRadius: 48  }, // Phase 2: shoring
  },

  // --------------------------------------------------------------------------
  // Player movement & digging
  // --------------------------------------------------------------------------
  player: {
    width: 2.4,          // AABB width, tiles
    height: 7,           // standing height (fits 8-tile tunnels)
    crouchHeight: 4.8,   // kneeling height (fits 6-tile crawlspaces — a knee, not a ball)
    walkSpeed: 20,       // tiles/s
    crouchSpeed: 7.6,    // tiles/s while crouched (crawlspace penalty)
    airControl: 0.75,    // fraction of walk accel while airborne
    accel: 160,          // tiles/s^2 ground acceleration
    gravity: 128,        // tiles/s^2
    maxFallSpeed: 112,   // tiles/s terminal velocity
    jumpVelocity: 36,    // tiles/s (≈5 tile jump height — same physical arc)
    coyoteTime: 0.1,     // s of grace after walking off a ledge
    jumpBuffer: 0.1,     // s a jump press is remembered before landing
    stepUpHeight: 4.2,   // auto-climb ledges up to this many tiles while grounded

    fallDamageThreshold: 20, // tiles of fall distance before damage starts
    fallDamagePerTile: 4,    // hp per tile beyond threshold (same hp per physical metre)
    maxHealth: 100,

    digReach: 5.6,       // tiles from player center (short pick — chip what's at hand)
    respawnDelay: 1.0,   // s after death before reset (placeholder until Phase 4)
    climbSpeed: 14,      // tiles/s on ladders

    // Loadout: carry slots (Phase 1.5 Stage 3 — data model; armorer UI later).
    // Slot 0 starts with the pick, slot 1 with the default lamp.
    loadoutSlots: 4,
    // You carry ONE lamp, chosen at the trench (armorer placeholder).
    defaultLamp: 'head' as 'head' | 'hip',

    // Swing digging: the pick swings in cycles; at the impact frame the tip
    // sweeps an arc around the aim direction and EVERY diggable tile it
    // contacts shares one cycle's worth of dig progress between them.
    swingPeriod: 0.55,   // s per full pick swing
    swingImpactPoint: 0.55, // fraction of the cycle where the blow lands
    firstSwingWindup: 0.35, // fresh swings start this far pre-wound, so the
                            // first blow lands ~0.1s after the click, not 0.3s
    // Face window: a small ray fan finds the NEAREST wall contact; the blow
    // then bites a band of the face there (a point-origin arc collapses to
    // nothing when you stand close — this stays full-size at any distance).
    // Horizontal digs bite the player's own passage rows (head→feet) at that
    // column, shifted only when the aim points up/down — so a level swing
    // always opens exactly what you need to walk through, floor untouched.
    // Vertical digs bite a body-wide horizontal band.
    anchorFanUpDeg: 75,  // anchor-fan spread above the aim (head lips sit steep)
    anchorFanDownDeg: 40, // spread below (enough for shin lips, misses the floor)
    faceBiteSide: 2,  // tiles each side of the contact (vertical digs — body-wide)
    // Stair mode (r8): a deliberately inclined aim carves exactly ONE step
    // up/down per face (symmetric ±1 — the old slope×distance shift could cut
    // 2–3-row pits on steep down-aims; playtest 2026-07-15). Hysteresis so
    // the level↔stair mode can't flicker while digging near the threshold.
    // These are aim-slope fractions (|facingY| with |facingY|<|facingX|).
    rampAimEnter: 0.4, // enter stair mode above this
    rampAimExit: 0.3,  // leave stair mode below this (only while still digging)
  },

  // --------------------------------------------------------------------------
  // Lighting. Intensities 0..1; unlit tiles render pure black.
  // Per-tile transmit values are per SMALL tile (r9: ≈ sqrt of the 8px ones —
  // light crosses twice as many tiles for the same earth thickness; per-tile
  // linear decays halve; ranges/passes double).
  // --------------------------------------------------------------------------
  light: {
    headlampRange: 48,        // tiles
    headlampConeDeg: 30,      // half-angle of the cone
    headlampConeSoftDeg: 12,  // soft falloff band beyond the half-angle
    hipLampRange: 18,         // tiles, omnidirectional
    selfGlowRange: 6.4,       // always-on faint glow so you can see yourself
    selfGlowIntensity: 0.28,
    solidTransmit: 0.81,      // light multiplier per solid tile crossed (shadows)
    sunSolidTransmit: 0.69,   // sunlight multiplier per solid tile (vertical scan)
    sunSpreadDecayAir: 0.04,  // sunlight relaxation decay per air tile (horizontal bleed)
    sunSpreadDecaySolid: 0.125,// sunlight relaxation decay per solid tile
    sunRelaxPasses: 24,       // relaxation iterations ≈ max bleed distance in tiles
    rayStepTiles: 0.66,       // lamp occlusion sampling step (same physical density as 8px)
    minVisible: 0.02,         // light below this renders as pure black
  },

  camera: {
    viewTilesX: 120,
    viewTilesY: 68,
    followSpeed: 8,     // 1/s exponential smoothing rate
    aimLead: 6,         // tiles of camera lead toward the cursor
  },

  debug: {
    enabledByDefault: false,
    // Stage 5 crossing-playtest HUD line: elapsed sim time · depth band ·
    // distance to the next capture point east. Renderer-only (never hashed).
    playtestHud: true,
  },
} as const;

export type MaterialKey = keyof typeof CONFIG.materials;

// ---------------------------------------------------------------------------
// Longest allowed featureless dig run between adjacent capture points, in
// tiles — DERIVED, not guessed (batch-validator spec check, Stage 4 follow-up).
//
// A digger advancing through clean shallow earth clears a player-height
// column per tile of advance and walks in behind it, so the sustained rate is
//   topsoil.digTime × pacingTunnelRows + 1/walkSpeed   seconds per tile
//   = 0.034 × 7 + 0.05 ≈ 0.29 s/tile at 4px  (≈0.58 s per physical 8px —
// playtest run 1 on seed 54715452 measured ≈0.6–0.76 s per 8px live; the
// model holds). The punctuation gate says something must interrupt the digger
// every punctuationCeilingS seconds, so the map may never present more than
//   90 s ÷ 0.29 s/tile ≈ 312 tiles (same physical distance as the 8px 155)
// of feature-free earth in the dig corridor. Recomputed automatically if dig
// times, tunnel height, walk speed, or the gate ceiling ever change.
// ---------------------------------------------------------------------------
export const MAX_FEATURELESS_SPAN_TILES = Math.floor(
  CONFIG.validation.punctuationCeilingS /
    (CONFIG.materials.topsoil.digTime * CONFIG.validation.pacingTunnelRows +
      1 / CONFIG.player.walkSpeed),
);
