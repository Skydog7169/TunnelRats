// ============================================================================
// Tunnel Rats — ALL gameplay tunables live here. Edit freely.
// Units: distances in TILES, times in SECONDS unless noted. 1 tile = 8 px
// (halved from 16 in playtest r3 — world is 1200×400, same physical size).
// Per-second values are converted to per-tick inside the sim (30 Hz).
// ============================================================================

export const CONFIG = {
  sim: {
    tickRate: 30, // fixed sim Hz. Renderer interpolates between ticks.
  },

  map: {
    width: 960,   // tiles (worldgen v3 — see gen.points for the spacing arithmetic)
    height: 224,  // tiles. Trimmed from 400: the basement rock floor sits ≈ row
                  // 190 at the deepest warp, so everything below was dead chalk
                  // paid for on every worldgen + lighting pass.
    tileSize: 8,  // px per tile (render only)
  },

  // --------------------------------------------------------------------------
  // World generation v3 (all seeded; tweak then press N in-game to regen)
  // --------------------------------------------------------------------------
  gen: {
    surfaceBaseY: 36,      // average surface row
    surfaceAmp: 10,        // surface height noise amplitude
    surfaceFreq: 0.0075,   // surface noise frequency

    // Depth bands (queryable via world.bandAt(x, y) — Phase 2 stability,
    // Phase 3 noise, Phase 4 AI all read this). The bands ARE the strata:
    //   shallow  = topsoil/root mats/sand — fast, loud, unstable
    //   clay     = clay + loam lenses     — slow, quiet, self-supporting
    //   basement = chalk shading to rock  — closes off the bottom
    bands: {
      shallowThickness: 26, // avg thickness of the shallow band below the surface
      shallowAmp: 10,       // noise warp of the shallow/clay boundary
      clayBottomY: 148,     // avg row where clay gives way to the basement
      clayBottomAmp: 14,    // noise warp of the clay/basement boundary
      warpFreq: 0.01,       // frequency of both boundary warps
      basementChalkRows: 34,// chalk depth below the clay band before solid rock
      chalkRockDither: 8,   // rows over which chalk speckles into rock (shading)
    },

    rootMatDepth: 6,       // root mats appear within this many tiles below surface
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
    //        = 960 − 24 − 76 − 76 − 72 = 712
    // Feasibility requires 4·spacingMin ≤ span ≤ 4·spacingMax, i.e. with the
    // 150/200 band the map must keep span within [600, 800]. At 900 wide the
    // span drops to 652 (avg interval 163) and anything above ~190 becomes
    // arithmetically impossible — that is why the band tops out at 200 with
    // width 960. Additionally |spacingJitter| must satisfy
    //   span/4 − 1.5·jitter ≥ spacingMin  and  span/4 + 1.5·jitter ≤ spacingMax
    // (the ±1.5× comes from the zero-sum jitter renormalization).
    points: {
      spacingMin: 150,      // min tiles between adjacent point footprints
      spacingMax: 200,      // max — see the arithmetic note above before raising
      spacingJitter: 12,    // seeded ± jitter on each interval (zero-sum)
      edgeMargin: 12,       // map edge → home-trench footprint
      homeFootprint: 38,    // home trench: 14-wide trench + parapets + margin
      lineFootprint: 38,    // intermediate trench-line point footprint
      craterFootprint: 72,  // crater bowl + broken-ground apron
      active: [0, 2, 4],    // v1: both homes + the center crater (data, not geometry)
    },

    trenchWidth: 14,       // tiles wide
    trenchDepth: 5,        // tiles below the local surface high point (~7 ft: head height + parapet)
    // Sap gallery: the pre-dug, timber-framed tunnel mouth in the enemy-facing
    // trench wall at floor level — where the tunnelers start digging.
    // Intermediate trench-line points get a sap in BOTH faces.
    sapLength: 12,         // tiles of pre-dug gallery into the earth
    sapHeight: 4,          // gallery height (fits a standing soldier)
    sapTimberedLen: 5,     // how many tiles of the gallery ceiling get timber lintels

    // Fortified crater (center point). Identity = topology: an open bowl with
    // NO continuous parapet and several wall mouths at different depths — a
    // trench has two ends to watch; a crater cannot be watched from one spot.
    crater: {
      width: 44,           // bowl diameter at the rim
      depth: 11,           // bowl depth below the local ground line at center
      rimJitter: 1.5,      // per-column noise on the bowl profile (broken ground)
      floorRubbleChance: 0.4, // fraction of bowl floor tiles turned to rubble
      mouthsMin: 3,        // wall mouths: short stub tunnels punched into the bowl
      mouthsMax: 4,
      mouthLenMin: 5,      // stub length into the wall
      mouthLenMax: 9,
      mouthHeight: 4,      // stub gallery height
    },

    flagPoleAboveGround: 3, // pole tiles rising above the local ground/parapet line

    // Rock curtains: one near-vertical intrusion wall per interval, surface
    // down into the basement rock, pierced only by the gaps. Route choice
    // across a curtain = depth choice.
    curtains: {
      perInterval: 1,      // curtains per interval (experimenting knob)
      thickness: 4,        // avg wall thickness, tiles
      edgeWarpAmp: 2.5,    // horizontal noise warp of the wall edges (reads as geology)
      edgeWarpFreq: 0.06,
      pointMargin: 26,     // curtain keeps this far from point footprints
      gapsMin: 2,          // diggable gaps per curtain
      gapsMax: 4,
      gapHeight: 7,        // vertical extent of a gap (admits a 4-tall tunnel + slack)
      gapMinDepth: 12,     // gap top at least this far below the local ground line
      gapMinSeparation: 16,// min vertical distance between gap centers
      gapRetries: 14,      // re-rolls when a candidate window hits water/rock
      tellsEnabled: true,  // GAP_TELLS_ENABLED — clay-seam tells at each gap
      tellLength: 7,       // seam run into the strata on each side of the wall
      tellThickness: 2,    // seam height, tiles
    },

    // Abandoned workings: sealed, half-collapsed old galleries in the middle
    // intervals. Break in by digging; Phase 2 puts corpses/salvage inside.
    workings: {
      countMin: 3,
      countMax: 5,
      intervals: [1, 2],   // interval indices they may occupy (never edge intervals)
      segmentsMin: 3,      // meander segments per working
      segmentsMax: 6,
      segLenMin: 6,        // tiles per horizontal segment
      segLenMax: 14,
      height: 3,           // old cramped galleries (crouch height)
      shaftChance: 0.35,   // chance a segment ends in a short shaft
      shaftDepthMin: 4,
      shaftDepthMax: 7,
      rubblePlugsMin: 1,   // full-height rubble chokes per working
      rubblePlugsMax: 3,
      plugLenMin: 2,
      plugLenMax: 4,
      timberChance: 0.12,  // rotten ceiling timbers per gallery column
      minDepth: 14,        // working top at least this far below ground
      airMargin: 6,        // min tiles between a working and any existing air
      gapMargin: 10,       // min tiles between a working and any curtain gap
      placeRetries: 24,    // placement attempts per working before giving up
    },

    // Enemy pre-dug network: branching galleries from the EAST home sap,
    // extending under no-man's-land toward (never through) the center point.
    // The west side keeps only its short sap — the player digs their own war.
    network: {
      reachMin: 150,       // horizontal extent from the sap mouth, tiles
      reachMax: 250,
      branchesMin: 2,      // drives (the mainline counts as one)
      branchesMax: 4,
      branchLenMin: 18,    // side-drive length
      branchLenMax: 40,
      stubsMin: 1,         // short listening stubs off the galleries
      stubsMax: 2,
      stubLenMin: 3,
      stubLenMax: 6,
      galleryHeight: 4,    // standing height (the enemy are competent tunnellers)
      shaftWidth: 2,       // the access shaft sunk near their sap (laddered)
      depthBias: 0.55,     // target depth as a fraction into the clay band
      centerMargin: 12,    // never closer than this to the center footprint
      waterRetries: 8,     // vertical nudges when a segment would cross water
    },

    // Blob features. Each: count, min/max radius (tiles), y range they can
    // center in. Rock blobs are GONE in v3 — curtains own the blocking job.
    sandPockets:  { count: 60, rMin: 4, rMax: 12, yMin: 42,  yMax: 130 },
    waterPockets: { count: 18, rMin: 4, rMax: 9,  yMin: 66,  yMax: 176 },
    blobEdgeNoise: 0.35,   // 0 = perfect ellipses, higher = rougher blob edges
    blobPointMargin: 8,    // blob centers keep this far from point footprints

    bedrockRows: 6,        // failsafe solid rock rows at the bottom of the map
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
    pacingTunnelRows: 4,
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
  //   digTime:   seconds to dig one tile (0 = undiggable). Tiles are small —
  //              a 1-wide, 2-physical-tall tunnel face is 8 tiles now.
  //   stability: base stability 0..100 (inert data in Phase 1; drives Phase 2)
  //   noiseRadius: tiles, how far digging THIS material is heard (Phase 3)
  // --------------------------------------------------------------------------
  materials: {
    topsoil: { digTime: 0.12, stability: 25,  noiseRadius: 20 },
    rootMat: { digTime: 0.22, stability: 45,  noiseRadius: 16 }, // roots bind soil
    clay:    { digTime: 0.4,  stability: 80,  noiseRadius: 8  }, // slow, quiet, self-supporting
    sand:    { digTime: 0.04, stability: 8,   noiseRadius: 44 }, // fast, loud, treacherous
    chalk:   { digTime: 0.22, stability: 60,  noiseRadius: 52 }, // medium, VERY loud
    rock:    { digTime: 0,    stability: 100, noiseRadius: 0  }, // undiggable
    water:   { digTime: 0,    stability: 0,   noiseRadius: 0  }, // inert v1: solid, undiggable
    rubble:  { digTime: 0.25, stability: 15,  noiseRadius: 24 }, // Phase 2: collapse fill
    timber:  { digTime: 0.5,  stability: 100, noiseRadius: 24 }, // Phase 2: shoring
  },

  // --------------------------------------------------------------------------
  // Player movement & digging
  // --------------------------------------------------------------------------
  player: {
    width: 1.2,          // AABB width, tiles
    height: 3.5,         // standing height (fits 4-tile tunnels)
    crouchHeight: 2.4,   // kneeling height (fits 3-tile crawlspaces — a knee, not a ball)
    walkSpeed: 10,       // tiles/s
    crouchSpeed: 3.8,    // tiles/s while crouched (crawlspace penalty)
    airControl: 0.75,    // fraction of walk accel while airborne
    accel: 80,           // tiles/s^2 ground acceleration
    gravity: 64,         // tiles/s^2
    maxFallSpeed: 56,    // tiles/s terminal velocity
    jumpVelocity: 18,    // tiles/s (≈2.5 tile jump height)
    coyoteTime: 0.1,     // s of grace after walking off a ledge
    jumpBuffer: 0.1,     // s a jump press is remembered before landing
    stepUpHeight: 2.1,   // auto-climb ledges up to this many tiles while grounded

    fallDamageThreshold: 10, // tiles of fall distance before damage starts
    fallDamagePerTile: 8,    // hp per tile beyond threshold
    maxHealth: 100,

    digReach: 2.8,       // tiles from player center (short pick — chip what's at hand)
    respawnDelay: 1.0,   // s after death before reset (placeholder until Phase 4)
    climbSpeed: 7,       // tiles/s on ladders

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
    faceBiteSide: 1,  // tiles each side of the contact (vertical digs)
  },

  // --------------------------------------------------------------------------
  // Lighting. Intensities 0..1; unlit tiles render pure black.
  // Per-tile transmit values are per SMALL tile now (≈ sqrt of the old ones,
  // since light crosses twice as many tiles for the same earth thickness).
  // --------------------------------------------------------------------------
  light: {
    headlampRange: 24,        // tiles
    headlampConeDeg: 30,      // half-angle of the cone
    headlampConeSoftDeg: 12,  // soft falloff band beyond the half-angle
    hipLampRange: 9,          // tiles, omnidirectional
    selfGlowRange: 3.2,       // always-on faint glow so you can see yourself
    selfGlowIntensity: 0.28,
    solidTransmit: 0.65,      // light multiplier per solid tile crossed (shadows)
    sunSolidTransmit: 0.47,   // sunlight multiplier per solid tile (vertical scan)
    sunSpreadDecayAir: 0.08,  // sunlight relaxation decay per air tile (horizontal bleed)
    sunSpreadDecaySolid: 0.25,// sunlight relaxation decay per solid tile
    sunRelaxPasses: 12,       // relaxation iterations ≈ max bleed distance in tiles
    minVisible: 0.02,         // light below this renders as pure black
  },

  camera: {
    viewTilesX: 60,
    viewTilesY: 34,
    followSpeed: 8,     // 1/s exponential smoothing rate
    aimLead: 3,         // tiles of camera lead toward the cursor
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
//   = 0.12 × 4 + 0.1 = 0.58 s/tile
// (playtest run 1 on seed 54715452 measured ≈0.6–0.76 s/tile live — the
// model holds). The punctuation gate says something must interrupt the digger
// every punctuationCeilingS seconds, so the map may never present more than
//   90 s ÷ 0.58 s/tile ≈ 155 tiles
// of feature-free earth in the dig corridor. Recompute automatically if dig
// times, tunnel height, walk speed, or the gate ceiling ever change.
// ---------------------------------------------------------------------------
export const MAX_FEATURELESS_SPAN_TILES = Math.floor(
  CONFIG.validation.punctuationCeilingS /
    (CONFIG.materials.topsoil.digTime * CONFIG.validation.pacingTunnelRows +
      1 / CONFIG.player.walkSpeed),
);
