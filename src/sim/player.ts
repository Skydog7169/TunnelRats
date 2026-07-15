// Player: AABB platformer physics on the tile grid, crouching, auto step-up,
// ladder climbing, fall damage, swing-based digging, lamp loadout.
// Positions are floats in TILE units; (x, y) is the CENTER of the feet
// (bottom-middle of the AABB).

import { InputCommand } from '../command';
import { CONFIG } from '../config';
import { degToIdx, len2, rotateIdx } from '../core/trig';
import { StateHasher } from './hash';
import { Loadout } from './loadout';
import { isDiggable, Tile, TILE_DIG_TICKS } from './tiles';
import { World } from './world';

// Anchor-fan ray angles as table indices, precomputed from config once.
// Positive rotation is toward screen-down; the strike code flips sign by
// facing so "up" stays up. (Deterministic: table trig only — see core/trig.)
const FAN_UP_IDX = [0.2, 0.4, 0.6, 0.8, 1].map((f) =>
  degToIdx(CONFIG.player.anchorFanUpDeg * f),
);
const FAN_DOWN_IDX = [0.33, 0.66, 1].map((f) =>
  degToIdx(CONFIG.player.anchorFanDownDeg * f),
);

const DT = 1 / CONFIG.sim.tickRate;
const EPS = 0.001;

export type LampKind = 'head' | 'hip';

export class Player {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  prevX: number;
  prevY: number;

  crouching = false;
  grounded = false;
  onLadder = false;
  facingX = 1; // aim direction (normalized), drives the headlamp cone
  facingY = 0;

  health: number = CONFIG.player.maxHealth;
  dead = false;
  respawnTimer = 0;

  // Carry slots (Stage 3: data model only). The lamp choice lives here now —
  // exactly one lamp item carried; swap only at the home trench (armorer).
  loadout = new Loadout();
  lampOn = true; // power state of whichever lamp is carried

  // Digging (pick swings)
  digProgress = new Map<number, number>(); // tile index -> accumulated ticks
  swingTick = -1; // -1 = not swinging, else 0..swingPeriodTicks-1
  impactSeq = 0; // increments on every CONNECTING pick impact (renderer watches this)
  lastImpactTiles: { x: number; y: number; tile: Tile }[] = []; // tiles hit by the last blow
  clinkSeq = 0; // increments when a blow strikes something undiggable
  lastClinks: { x: number; y: number; tile: Tile }[] = []; // rock/water/timber struck
  /** Where the NEXT blow will land — recomputed every digging tick for the HUD/renderer. */
  digPreview: { bites: { x: number; y: number; tile: Tile }[]; clinks: { x: number; y: number; tile: Tile }[] } =
    { bites: [], clinks: [] };

  private coyoteTicks = 0;
  private jumpBufferTicks = 0;
  private fallDistance = 0;

  constructor(
    private world: World,
    private spawn: { x: number; y: number },
  ) {
    this.x = spawn.x;
    this.y = spawn.y;
    this.prevX = this.x;
    this.prevY = this.y;
    this.loadout.add('pick');
    this.loadout.add(CONFIG.player.defaultLamp === 'head' ? 'lamp_head' : 'lamp_hip');
  }

  /** Which lamp is carried — derived from the loadout (migrated in Stage 3). */
  get carriedLamp(): LampKind {
    return this.loadout.has('lamp_hip') ? 'hip' : 'head';
  }

  get width(): number {
    return CONFIG.player.width;
  }

  get height(): number {
    return this.crouching ? CONFIG.player.crouchHeight : CONFIG.player.height;
  }

  get centerX(): number {
    return this.x;
  }

  get centerY(): number {
    return this.y - this.height / 2;
  }

  get swingPeriodTicks(): number {
    return Math.max(2, Math.round(CONFIG.player.swingPeriod * CONFIG.sim.tickRate));
  }

  /** 0..1 through the current swing, or -1 when idle. */
  get swingPhase(): number {
    return this.swingTick < 0 ? -1 : this.swingTick / this.swingPeriodTicks;
  }

  /**
   * Feed every piece of player-owned sim state into the digest. Includes the
   * private movement internals (coyote/jump-buffer/fall-distance) — they
   * affect future ticks, so they are state. digPreview/lastImpactTiles/
   * lastClinks are excluded: recomputed every tick, purely derived.
   */
  hashState(h: StateHasher): void {
    h.f64(this.x);
    h.f64(this.y);
    h.f64(this.vx);
    h.f64(this.vy);
    h.f64(this.prevX);
    h.f64(this.prevY);
    h.f64(this.facingX);
    h.f64(this.facingY);
    h.bool(this.crouching);
    h.bool(this.grounded);
    h.bool(this.onLadder);
    h.f64(this.health);
    h.bool(this.dead);
    h.f64(this.respawnTimer);
    this.loadout.hashState(h); // carriedLamp is derived from this
    h.bool(this.lampOn);
    h.u32(this.swingTick + 1); // -1 = idle, offset to stay unsigned
    h.u32(this.impactSeq);
    h.u32(this.clinkSeq);
    h.u32(this.coyoteTicks);
    h.u32(this.jumpBufferTicks);
    h.f64(this.fallDistance);
    const keys = [...this.digProgress.keys()].sort((a, b) => a - b);
    h.u32(keys.length);
    for (const k of keys) {
      h.u32(k);
      h.f64(this.digProgress.get(k)!);
    }
  }

  /** Standing inside the home (left) trench interior — the armorer's reach. */
  inHomeTrench(): boolean {
    const t = this.world.trenches[0];
    if (!t) return false;
    const px = Math.floor(this.x);
    const py = Math.floor(this.y - EPS);
    return px >= t.x0 && px <= t.x1 && py >= t.y0 && py <= t.y1 + 1;
  }

  tick(cmd: InputCommand): void {
    this.prevX = this.x;
    this.prevY = this.y;

    if (this.dead) {
      this.respawnTimer -= DT;
      if (this.respawnTimer <= 0) this.respawnAtTrench();
      return;
    }

    // Aim (also headlamp direction)
    const ax = cmd.aimX - this.centerX;
    const ay = cmd.aimY - this.centerY;
    const alen = len2(ax, ay);
    if (alen > 0.01) {
      this.facingX = ax / alen;
      this.facingY = ay / alen;
    }

    if (cmd.toggleLamp) this.lampOn = !this.lampOn;
    if (cmd.swapLamp && this.inHomeTrench()) {
      if (this.loadout.has('lamp_head')) this.loadout.swapItem('lamp_head', 'lamp_hip');
      else this.loadout.swapItem('lamp_hip', 'lamp_head');
    }

    this.updateCrouch(cmd.crouch);
    this.updateMovement(cmd);
    this.updateDig(cmd);
  }

  private updateCrouch(wantCrouch: boolean): void {
    if (wantCrouch && !this.crouching) {
      this.crouching = true;
    } else if (!wantCrouch && this.crouching) {
      // Stand only if there's headroom
      if (!this.collides(this.x, this.y, CONFIG.player.height)) this.crouching = false;
    }
  }

  private updateMovement(cmd: InputCommand): void {
    const P = CONFIG.player;
    const maxSpeed = this.crouching ? P.crouchSpeed : P.walkSpeed;
    const accel = P.accel * (this.grounded || this.onLadder ? 1 : P.airControl);

    // Horizontal accel toward desired velocity
    const target = cmd.moveX * maxSpeed;
    if (this.vx < target) this.vx = Math.min(target, this.vx + accel * DT);
    else if (this.vx > target) this.vx = Math.max(target, this.vx - accel * DT);

    this.onLadder = this.touchingLadder();
    if (this.onLadder) {
      // Ladder: no gravity; W climbs, S descends. Fall distance resets.
      this.vy = cmd.jumpHeld ? -P.climbSpeed : cmd.crouch ? P.climbSpeed : 0;
      this.fallDistance = 0;
      this.jumpBufferTicks = 0;
    } else {
      // Gravity
      this.vy = Math.min(this.vy + P.gravity * DT, P.maxFallSpeed);

      // Jump: buffered press + coyote time
      if (cmd.jump) this.jumpBufferTicks = Math.round(P.jumpBuffer / DT);
      if (this.jumpBufferTicks > 0 && this.coyoteTicks > 0 && !this.crouching) {
        this.vy = -P.jumpVelocity;
        this.jumpBufferTicks = 0;
        this.coyoteTicks = 0;
      }
      if (this.jumpBufferTicks > 0) this.jumpBufferTicks--;
    }

    this.moveX(this.vx * DT);
    this.moveY(this.vy * DT);

    // Grounded check + coyote + fall damage bookkeeping
    const wasGrounded = this.grounded;
    // Probe a few hundredths of a tile below the feet: must exceed the EPS
    // used by the landing snap or float error makes grounded flicker false.
    this.grounded = this.collides(this.x, this.y + 0.06, this.height);
    if (this.grounded) {
      this.coyoteTicks = Math.round(P.coyoteTime / DT);
      if (!wasGrounded && this.fallDistance > P.fallDamageThreshold) {
        this.takeDamage((this.fallDistance - P.fallDamageThreshold) * P.fallDamagePerTile);
      }
      this.fallDistance = 0;
    } else {
      if (this.coyoteTicks > 0) this.coyoteTicks--;
      if (!this.onLadder && this.vy > 0) this.fallDistance += this.vy * DT;
    }
  }

  private touchingLadder(): boolean {
    const half = this.width / 2;
    const x0 = Math.floor(this.x - half);
    const x1 = Math.floor(this.x + half);
    const y0 = Math.floor(this.y - this.height);
    const y1 = Math.floor(this.y - EPS);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.world.getTile(tx, ty) === Tile.Ladder) return true;
      }
    }
    return false;
  }

  private moveX(dx: number): void {
    if (dx === 0) return;
    const nx = this.x + dx;
    if (!this.collides(nx, this.y, this.height)) {
      this.x = nx;
      return;
    }
    // Auto step-up: while grounded, try lifting over ledges up to stepUpHeight
    if (this.grounded && !this.crouching) {
      const lifts: number[] = [];
      for (let l = 0.35; l < CONFIG.player.stepUpHeight; l += 0.35) lifts.push(l);
      lifts.push(CONFIG.player.stepUpHeight);
      for (const lift of lifts) {
        if (
          !this.collides(this.x, this.y - lift, this.height) &&
          !this.collides(nx, this.y - lift, this.height)
        ) {
          this.y -= lift;
          this.x = nx;
          return;
        }
      }
    }
    // Slide flush against the wall
    const half = this.width / 2;
    if (dx > 0) {
      const wallTile = Math.floor(nx + half);
      this.x = wallTile - half - EPS;
    } else {
      const wallTile = Math.floor(nx - half) + 1;
      this.x = wallTile + half + EPS;
    }
    this.vx = 0;
  }

  private moveY(dy: number): void {
    if (dy === 0) return;
    const ny = this.y + dy;
    if (!this.collides(this.x, ny, this.height)) {
      this.y = ny;
      return;
    }
    if (dy > 0) {
      this.y = Math.floor(ny) - EPS; // land on tile top
    } else {
      const headTile = Math.floor(ny - this.height);
      this.y = headTile + 1 + this.height + EPS; // bonk on ceiling
    }
    this.vy = 0;
  }

  /** AABB (feet at cx,cy, given height) vs solid tiles. */
  private collides(cx: number, cy: number, height: number): boolean {
    const half = this.width / 2;
    const x0 = Math.floor(cx - half);
    const x1 = Math.floor(cx + half);
    const y0 = Math.floor(cy - height);
    const y1 = Math.floor(cy - EPS);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (this.world.isSolid(tx, ty)) return true;
      }
    }
    return false;
  }

  /**
   * Swing digging: holding dig runs the pick in cycles regardless of what's
   * in front of you (whiffs are allowed). At the impact frame the pick tip
   * sweeps an arc centred on the aim direction; every diggable tile the tip
   * reaches splits one cycle's worth of ticks between them. Hitting a single
   * tile matches the CONFIG dig rate exactly; hitting a 2-tile wall face
   * loosens both at half rate each — same material moved, more organic hole.
   */
  private updateDig(cmd: InputCommand): void {
    if (!cmd.dig) {
      this.swingTick = -1;
      this.digPreview = { bites: [], clinks: [] };
      return;
    }

    const P = CONFIG.player;
    const period = this.swingPeriodTicks;
    const impactTick = Math.round(period * P.swingImpactPoint);
    // Fresh swings start pre-wound so the first blow lands almost immediately
    this.swingTick =
      this.swingTick < 0
        ? Math.min(Math.round(period * P.firstSwingWindup), impactTick - 1)
        : this.swingTick + 1;
    if (this.swingTick >= period) this.swingTick = 0;

    this.digPreview = this.strikeWindow();
    if (this.swingTick !== impactTick) return;

    const { bites, clinks } = this.digPreview;
    if (clinks.length > 0) {
      // Pick met rock/water/timber — no bite, but the renderer sparks it.
      // Phase 3: this is also a noise event (metal on stone carries).
      this.lastClinks = clinks;
      this.clinkSeq++;
    }
    if (bites.length === 0) return; // whiffed into open air (or all clink)

    const share = period / bites.length;
    for (const c of bites) {
      const i = this.world.idx(c.x, c.y);
      const progress = (this.digProgress.get(i) ?? 0) + share;
      if (progress >= TILE_DIG_TICKS[c.tile]) {
        this.world.setTile(c.x, c.y, Tile.Air);
        this.digProgress.delete(i);
        // Phase 3: emit dig-noise event here (radius = TILE_NOISE_RADIUS[tile])
      } else {
        this.digProgress.set(i, progress);
      }
    }
    this.lastImpactTiles = bites;
    this.impactSeq++;
  }

  /**
   * The aim ray finds the first solid tile within reach (the pick can't cut
   * what's behind a wall); the blow then bites a FACE WINDOW around that
   * contact: a vertical head-to-shin column (up-biased) for horizontal digs,
   * a body-wide horizontal band for vertical digs. Window size is constant
   * regardless of how close the digger stands — a point-origin arc collapses
   * at short range, which made forward tunnelling wedge (playtest r5).
   * Returns diggable tiles as `bites` and undiggable ones (rock/water/timber)
   * as `clinks`, so the renderer can preview the window and spark the misses.
   */
  private strikeWindow(): {
    bites: { x: number; y: number; tile: Tile }[];
    clinks: { x: number; y: number; tile: Tile }[];
  } {
    const P = CONFIG.player;
    const cx = this.centerX;
    const cy = this.centerY;

    // Anchor: NEAREST solid tile across an asymmetric ray fan. A single ray
    // slips through an already-dug slot and whiffs while a head-height lip
    // (up to ~75° above the aim when standing close) blocks the body. "Up"
    // flips with facing because screen y grows downward. Rays are the facing
    // vector rotated by fixed table angles — no transcendental Math in here.
    const upSign = this.facingX >= 0 ? -1 : 1;
    const fanAngles = [0];
    for (const idx of FAN_UP_IDX) fanAngles.push(upSign * idx);
    for (const idx of FAN_DOWN_IDX) fanAngles.push(-upSign * idx);

    let ax = -1;
    let ay = -1;
    let bestD = Infinity;
    for (const t of fanAngles) {
      const [rdx, rdy] = rotateIdx(this.facingX, this.facingY, t);
      let lastIdx = -1;
      for (let d = 0.15; d <= P.digReach; d += 0.15) {
        const tx = Math.floor(cx + rdx * d);
        const ty = Math.floor(cy + rdy * d);
        const i = ty * this.world.w + tx;
        if (i === lastIdx) continue;
        lastIdx = i;
        if (this.world.isSolid(tx, ty)) {
          if (d < bestD) {
            bestD = d;
            ax = tx;
            ay = ty;
          }
          break;
        }
      }
    }
    if (ax < 0) return { bites: [], clinks: [] }; // nothing in reach — whiff

    const bites: { x: number; y: number; tile: Tile }[] = [];
    const clinks: { x: number; y: number; tile: Tile }[] = [];
    const bite = (tx: number, ty: number) => {
      if (!this.world.isSolid(tx, ty)) return; // ragged face — skip the gap
      const tile = this.world.getTile(tx, ty);
      (isDiggable(tile) ? bites : clinks).push({ x: tx, y: ty, tile });
    };

    if (Math.abs(this.facingY) > Math.abs(this.facingX)) {
      // Vertical dig: body-wide band at the anchor row
      for (let o = -P.faceBiteSide; o <= P.faceBiteSide; o++) bite(ax + o, ay);
    } else {
      // Horizontal-dominant dig: the player's own passage rows at the anchor
      // column. A LEVEL aim never shifts the window — the anchor only picks
      // the column, so wide fan rays that anchor the ceiling can't creep the
      // tunnel upward. A deliberately INCLINED aim turns the window into a
      // ramp: it slides down/up the aim's slope line and gains one extra
      // headroom row so the finished incline is walkable in both directions
      // (stepped tunnels wedge without it — same lesson as the sap decline).
      const feetRow = Math.floor(this.y - EPS);
      const passTop = feetRow - (Math.ceil(this.height) - 1);
      let shift = 0;
      let headroom = 0;
      if (Math.abs(this.facingY) > 0.35) {
        const slope = this.facingY / Math.max(0.001, Math.abs(this.facingX));
        const colDist = Math.abs(ax - Math.floor(cx));
        shift = Math.round(slope * colDist);
        // Ascending is capped at ONE row per swing: a bigger up-shift bites
        // columns out of walking order and carves an overhang pocket whose
        // remaining faces sit just beyond reach (r7 up-ramp trap). 45° is the
        // steepest stair a soldier can walk anyway.
        if (shift < -1) shift = -1;
        headroom = 1;
      }
      for (let r = passTop + shift - headroom; r <= feetRow + shift; r++) bite(ax, r);
    }
    return { bites, clinks };
  }

  takeDamage(amount: number): void {
    if (this.dead) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.respawnTimer = CONFIG.player.respawnDelay;
      // Phase 2: leave a corpse tile-entity here.
    }
  }

  private respawnAtTrench(): void {
    this.dead = false;
    this.health = CONFIG.player.maxHealth;
    this.x = this.spawn.x;
    this.y = this.spawn.y;
    this.prevX = this.x;
    this.prevY = this.y;
    this.vx = 0;
    this.vy = 0;
    this.fallDistance = 0;
    this.swingTick = -1;
  }
}
