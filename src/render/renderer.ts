// Canvas 2D renderer. Reads sim state, never mutates it. Interpolates the
// player between the previous and current tick for smooth motion at any
// display refresh rate. All decoration (uniform, trench dressing, debris
// particles) is render-side only — the sim knows nothing about it.

import { CONFIG } from '../config';
import { Sim } from '../sim/sim';
import { Tile, TILE_DIG_TICKS } from '../sim/tiles';
import { hash2 } from '../core/prng';
import { Camera } from './camera';
import { SKY_COLOR, TILE_COLOR } from './palette';
import { drawDebugOverlay, DebugState } from './debug';

const NEIGHBORS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

interface Particle {
  x: number; // world tile units
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  camera: Camera;
  scale = 1; // screen px per world px

  debug: DebugState = {
    overlayOn: CONFIG.debug.enabledByDefault,
    viewMode: 0, // 0 none, 1 strata, 2 stability
    fps: 0,
    status: '',
    lastHash: '',
  };

  private particles: Particle[] = [];
  private lastImpactSeq = 0;
  private lastClinkSeq = 0;

  // Walk-cycle state (render-side only)
  private walkCycle = 0;
  private lastDrawX = 0;
  private lastDrawY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private sim: Sim,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.camera = new Camera(sim.player.x, sim.player.y);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Swap to a fresh sim (record restart / replay) and reset render-side state. */
  attachSim(sim: Sim): void {
    this.sim = sim;
    this.camera = new Camera(sim.player.x, sim.player.y);
    this.particles = [];
    this.lastImpactSeq = sim.player.impactSeq;
    this.lastClinkSeq = sim.player.clinkSeq;
    this.walkCycle = 0;
    this.lastDrawX = sim.player.x;
    this.lastDrawY = sim.player.y;
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    const ts = CONFIG.map.tileSize;
    // Guarantee at most ~viewTilesX × viewTilesY tiles are visible
    this.scale = Math.max(
      this.canvas.width / (CONFIG.camera.viewTilesX * ts),
      this.canvas.height / (CONFIG.camera.viewTilesY * ts),
    );
  }

  /** Screen px → world tile coords (used by input to build aim commands). */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const ts = CONFIG.map.tileSize * this.scale;
    return {
      x: this.camera.x + (sx - this.canvas.width / 2) / ts,
      y: this.camera.y + (sy - this.canvas.height / 2) / ts,
    };
  }

  render(alpha: number, mouseSx: number, mouseSy: number, dtSec: number): void {
    const { ctx, canvas, sim } = this;
    const world = sim.world;
    const p = sim.player;
    const ts = CONFIG.map.tileSize * this.scale;

    // Interpolated player position
    const px = p.prevX + (p.x - p.prevX) * alpha;
    const py = p.prevY + (p.y - p.prevY) * alpha;
    const pcx = px;
    const pcy = py - p.height / 2;

    const aim = this.screenToWorld(mouseSx, mouseSy);
    const adx = Math.max(-1, Math.min(1, (aim.x - pcx) / 8));
    const ady = Math.max(-1, Math.min(1, (aim.y - pcy) / 8));
    this.camera.update(
      world,
      pcx,
      pcy,
      adx,
      ady,
      dtSec,
      canvas.width / (2 * ts),
      canvas.height / (2 * ts),
    );

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const halfWpx = canvas.width / 2;
    const halfHpx = canvas.height / 2;
    const wsx = (wx: number) => halfWpx + (wx - this.camera.x) * ts;
    const wsy = (wy: number) => halfHpx + (wy - this.camera.y) * ts;

    const x0 = Math.max(0, Math.floor(this.camera.x - halfWpx / ts) - 1);
    const x1 = Math.min(world.w - 1, Math.ceil(this.camera.x + halfWpx / ts) + 1);
    const y0 = Math.max(0, Math.floor(this.camera.y - halfHpx / ts) - 1);
    const y1 = Math.min(world.h - 1, Math.ceil(this.camera.y + halfHpx / ts) + 1);

    const fullbright = this.debug.viewMode !== 0;
    const minVis = CONFIG.light.minVisible;

    for (let tyy = y0; tyy <= y1; tyy++) {
      for (let txx = x0; txx <= x1; txx++) {
        const i = tyy * world.w + txx;
        const tile = world.tiles[i] as Tile;
        let light = fullbright ? 1 : Math.min(1, world.lightAt(txx, tyy));
        if (light < minVis) continue; // pure black — render nothing
        if (!fullbright) light = Math.pow(light, 0.6); // gamma lift for readable mids

        const sx = wsx(txx);
        const sy = wsy(tyy);

        if (tile === Tile.Air || tile === Tile.Ladder || tile === Tile.FlagPole) {
          // Sky above the surface; warm haze in lamplit tunnel air
          if (tyy < world.surfaceY[txx]) {
            ctx.fillStyle = SKY_COLOR;
            ctx.globalAlpha = light;
          } else {
            const [r, g, b] = TILE_COLOR[Tile.Air];
            ctx.fillStyle = `rgb(${Math.floor(r * light)},${Math.floor(g * light)},${Math.floor(b * light)})`;
            ctx.globalAlpha = 1;
          }
          ctx.fillRect(sx, sy, ts + 0.5, ts + 0.5);
          ctx.globalAlpha = 1;
          if (tile === Tile.Ladder) this.drawLadderTile(sx, sy, ts, light, tyy);
          if (tile === Tile.FlagPole) {
            this.drawFlagPoleTile(sx, sy, ts, light, world.getTile(txx, tyy - 1) !== Tile.FlagPole);
          }
          continue;
        }

        let [r, g, b] = TILE_COLOR[tile];

        // Soft strata blending: mix in neighbouring solid materials so layer
        // boundaries read as earth, not block edges
        let nr = 0;
        let ng = 0;
        let nb = 0;
        let nc = 0;
        for (const [ox, oy] of NEIGHBORS) {
          const nt = world.getTile(txx + ox, tyy + oy);
          if (nt === Tile.Air || nt === Tile.Ladder) continue;
          const c = TILE_COLOR[nt];
          nr += c[0];
          ng += c[1];
          nb += c[2];
          nc++;
        }
        if (nc > 0) {
          r = r * 0.7 + (nr / nc) * 0.3;
          g = g * 0.7 + (ng / nc) * 0.3;
          b = b * 0.7 + (nb / nc) * 0.3;
        }

        // Per-tile brightness variation for grain
        const varn = 0.86 + hash2(7, txx, tyy) * 0.28;
        r = Math.floor(r * varn * light);
        g = Math.floor(g * varn * light);
        b = Math.floor(b * varn * light);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(sx, sy, ts + 0.5, ts + 0.5);

        // Soft edge shading only where earth meets open air
        ctx.fillStyle = `rgba(0,0,0,${0.3 * light})`;
        const bw = Math.max(1, ts * 0.14);
        if (!world.isSolid(txx, tyy - 1)) ctx.fillRect(sx, sy, ts, bw);
        if (!world.isSolid(txx, tyy + 1)) ctx.fillRect(sx, sy + ts - bw, ts, bw);
        if (!world.isSolid(txx - 1, tyy)) ctx.fillRect(sx, sy, bw, ts);
        if (!world.isSolid(txx + 1, tyy)) ctx.fillRect(sx + ts - bw, sy, bw, ts);
      }
    }

    this.drawTrenchDressing(wsx, wsy, ts, x0, x1, y0, y1, fullbright);
    this.drawCraterDressing(wsx, wsy, ts, x0, x1, y0, y1, fullbright);
    this.drawDigCracks(wsx, wsy, ts, x0, x1, y0, y1, fullbright);
    this.drawDigPreview(wsx, wsy, ts, fullbright);
    this.updateAndDrawParticles(wsx, wsy, ts, dtSec, fullbright);
    if (!p.dead) this.drawPlayer(pcx, pcy, wsx, wsy, ts, alpha);

    if (this.debug.viewMode === 2) this.drawStabilityOverlay(x0, x1, y0, y1, wsx, wsy, ts);
    if (this.debug.viewMode === 3) this.drawRegionsOverlay(x0, x1, y0, y1, wsx, wsy, ts);

    this.drawHud();
    if (p.dead) this.drawDeathFlash();
    if (this.debug.overlayOn) {
      drawDebugOverlay(ctx, sim, this.debug, { x: Math.floor(px), y: Math.floor(py) });
    }
  }

  // --- Trench dressing (visual only) ---------------------------------------

  private drawTrenchDressing(
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    fullbright: boolean,
  ): void {
    const { ctx } = this;
    const world = this.sim.world;

    for (const t of world.trenches) {
      if (t.x1 + 2 < x0 || t.x0 - 2 > x1) continue;

      const floorRow = t.y1 + 1;
      const lightOf = (x: number, y: number) =>
        fullbright ? 1 : Math.pow(Math.min(1, world.lightAt(x, y)), 0.6);

      // Revetment planks on the interior faces of both walls
      for (const wallX of [t.x0 - 1, t.x1 + 1]) {
        if (wallX < x0 || wallX > x1) continue;
        const surf = world.surfaceY[Math.max(0, Math.min(world.w - 1, wallX))];
        for (let y = Math.max(surf, y0); y <= Math.min(t.y1, y1); y++) {
          if (!world.isSolid(wallX, y)) continue;
          const l = lightOf(wallX, y);
          if (l < CONFIG.light.minVisible) continue;
          const sx = wsx(wallX);
          const sy = wsy(y);
          ctx.fillStyle = `rgba(92, 66, 34, ${0.55 * l})`;
          ctx.fillRect(sx, sy, ts, ts);
          ctx.fillStyle = `rgba(30, 20, 10, ${0.6 * l})`;
          const lw = Math.max(1, ts * 0.1);
          ctx.fillRect(sx + ts * 0.5, sy, lw, ts); // plank seam
          if (y % 4 === 0) ctx.fillRect(sx, sy + ts * 0.5, ts, lw); // joints
        }
      }

      // Duckboards along the floor
      if (floorRow >= y0 && floorRow <= y1) {
        for (let x = Math.max(t.x0, x0); x <= Math.min(t.x1, x1); x++) {
          const l = lightOf(x, t.y1);
          if (l < CONFIG.light.minVisible) continue;
          const sx = wsx(x);
          const sy = wsy(floorRow);
          ctx.fillStyle = `rgba(109, 87, 50, ${0.9 * l})`;
          ctx.fillRect(sx, sy, ts, ts * 0.22);
          ctx.fillStyle = `rgba(40, 30, 16, ${0.7 * l})`;
          ctx.fillRect(sx + ts * 0.45, sy, Math.max(1, ts * 0.08), ts * 0.22); // slat gap
        }
      }

      // Sandbag parapets stacked on the surface at both lips (2 columns wide)
      for (const bagX of [t.x0 - 2, t.x0 - 1, t.x1 + 1, t.x1 + 2]) {
        if (bagX < x0 || bagX > x1) continue;
        const surf = world.surfaceY[Math.max(0, Math.min(world.w - 1, bagX))];
        const bagRow = surf - 1; // the air tile sitting on the ground
        if (bagRow < y0 || bagRow > y1) continue;
        const l = lightOf(bagX, bagRow);
        if (l < CONFIG.light.minVisible) continue;
        const sx = wsx(bagX);
        const sy = wsy(bagRow);
        ctx.fillStyle = `rgba(138, 122, 88, ${l})`;
        ctx.strokeStyle = `rgba(60, 52, 36, ${l})`;
        ctx.lineWidth = Math.max(1, ts * 0.04);
        const bag = (bx: number, by: number, bw: number, bh: number) => {
          ctx.beginPath();
          ctx.ellipse(sx + bx * ts, sy + by * ts, (bw * ts) / 2, (bh * ts) / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        };
        bag(0.25, 0.85, 0.5, 0.3);
        bag(0.72, 0.85, 0.5, 0.3);
        bag(0.32, 0.6, 0.5, 0.3);
        bag(0.68, 0.58, 0.5, 0.3);
        bag(0.5, 0.33, 0.55, 0.3);
      }
    }
  }

  private drawLadderTile(sx: number, sy: number, ts: number, light: number, tileY: number): void {
    const { ctx } = this;
    ctx.strokeStyle = `rgba(125, 95, 56, ${Math.min(1, light + 0.15)})`;
    ctx.lineWidth = Math.max(1.5, ts * 0.16);
    ctx.beginPath();
    ctx.moveTo(sx + ts * 0.2, sy);
    ctx.lineTo(sx + ts * 0.2, sy + ts);
    ctx.moveTo(sx + ts * 0.8, sy);
    ctx.lineTo(sx + ts * 0.8, sy + ts);
    if (tileY % 2 === 0) {
      ctx.moveTo(sx + ts * 0.2, sy + ts * 0.5);
      ctx.lineTo(sx + ts * 0.8, sy + ts * 0.5);
    }
    ctx.stroke();
  }

  private drawFlagPoleTile(sx: number, sy: number, ts: number, light: number, isTop: boolean): void {
    const { ctx } = this;
    const l = Math.min(1, light + 0.1);
    ctx.strokeStyle = `rgba(150, 148, 140, ${l})`;
    ctx.lineWidth = Math.max(1.5, ts * 0.14);
    ctx.beginPath();
    ctx.moveTo(sx + ts * 0.5, sy);
    ctx.lineTo(sx + ts * 0.5, sy + ts);
    ctx.stroke();
    if (isTop) {
      // Neutral pennant — ownership/capture visuals arrive with Phase 4
      ctx.fillStyle = `rgba(120, 118, 110, ${l})`;
      ctx.beginPath();
      ctx.moveTo(sx + ts * 0.5, sy);
      ctx.lineTo(sx + ts * 2.1, sy + ts * 0.35);
      ctx.lineTo(sx + ts * 0.5, sy + ts * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Scattered sandbag clumps in the crater bowl — cover fragments, NOT a parapet. */
  private drawCraterDressing(
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    fullbright: boolean,
  ): void {
    const { ctx } = this;
    const world = this.sim.world;
    const regions = world.regions;
    if (!regions) return;

    for (const p of regions.points) {
      if (p.kind !== 'crater') continue;
      if (p.floor.x1 < x0 || p.floor.x0 > x1) continue;
      const clumps = 9;
      for (let k = 0; k < clumps; k++) {
        const bagX = p.floor.x0 + 2 + Math.floor(hash2(41, p.id * 17 + k, 3) * (p.floor.x1 - p.floor.x0 - 4));
        const bagRow = world.surfaceY[Math.max(0, Math.min(world.w - 1, bagX))] - 1;
        if (bagX < x0 || bagX > x1 || bagRow < y0 || bagRow > y1) continue;
        const l = fullbright ? 1 : Math.pow(Math.min(1, world.lightAt(bagX, bagRow)), 0.6);
        if (l < CONFIG.light.minVisible) continue;
        const sx = wsx(bagX);
        const sy = wsy(bagRow);
        ctx.fillStyle = `rgba(138, 122, 88, ${l})`;
        ctx.strokeStyle = `rgba(60, 52, 36, ${l})`;
        ctx.lineWidth = Math.max(1, ts * 0.04);
        const nBags = 2 + Math.floor(hash2(43, p.id, k) * 2);
        for (let b = 0; b < nBags; b++) {
          const bx = 0.25 + hash2(47, k, b) * 0.5;
          const by = 0.85 - b * 0.26;
          ctx.beginPath();
          ctx.ellipse(sx + bx * ts, sy + by * ts, ts * 0.28, ts * 0.15, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  // --- Digging feedback ------------------------------------------------------

  /** Cracks on every partially-dug tile in view (only where there's light). */
  private drawDigCracks(
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    fullbright: boolean,
  ): void {
    const p = this.sim.player;
    const world = this.sim.world;
    for (const [i, prog] of p.digProgress) {
      const x = i % world.w;
      const y = (i / world.w) | 0;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const light = fullbright ? 1 : Math.min(1, world.lightAt(x, y));
      if (light < CONFIG.light.minVisible) continue; // no cracks in the dark
      const tile = world.tiles[i] as Tile;
      const frac = prog / Math.max(1, TILE_DIG_TICKS[tile]);
      const sx = wsx(x);
      const sy = wsy(y);
      this.ctx.strokeStyle = `rgba(20,15,10,${(0.4 + frac * 0.5) * light})`;
      this.ctx.lineWidth = Math.max(1, ts * 0.05);
      this.ctx.beginPath();
      const cx = sx + ts / 2;
      const cy = sy + ts / 2;
      const cracks = 2 + Math.floor(frac * 4);
      for (let c = 0; c < cracks; c++) {
        const a = hash2(31, x * 7 + c, y * 13) * Math.PI * 2;
        this.ctx.moveTo(cx, cy);
        this.ctx.lineTo(cx + Math.cos(a) * ts * 0.45 * (0.4 + frac), cy + Math.sin(a) * ts * 0.45 * (0.4 + frac));
      }
      this.ctx.stroke();
    }
  }

  /** Outline the tiles the NEXT blow will hit (white = will dig, red = won't). */
  private drawDigPreview(
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
    fullbright: boolean,
  ): void {
    const p = this.sim.player;
    if (p.dead || p.swingTick < 0) return; // only while actually swinging
    const world = this.sim.world;
    const { ctx } = this;
    ctx.lineWidth = Math.max(1, ts * 0.12);
    const draw = (tiles: { x: number; y: number }[], color: string, baseA: number) => {
      for (const t of tiles) {
        const light = fullbright ? 1 : Math.min(1, world.lightAt(t.x, t.y));
        if (light < CONFIG.light.minVisible) continue; // don't reveal the dark
        ctx.strokeStyle = `${color}${(baseA * (0.4 + 0.6 * light)).toFixed(2)})`;
        ctx.strokeRect(wsx(t.x) + 1, wsy(t.y) + 1, ts - 2, ts - 2);
      }
    };
    draw(p.digPreview.bites, 'rgba(235, 228, 200, ', 0.5);
    draw(p.digPreview.clinks, 'rgba(200, 80, 60, ', 0.55);
  }

  private updateAndDrawParticles(
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
    dtSec: number,
    fullbright: boolean,
  ): void {
    const p = this.sim.player;
    // Spawn debris on each new pick impact, at every tile the blow contacted
    // (render-side Math.random is fine — particles never touch the sim)
    if (p.impactSeq !== this.lastImpactSeq) {
      this.lastImpactSeq = p.impactSeq;
      for (const hit of p.lastImpactTiles) {
        const [r, g, b] = TILE_COLOR[hit.tile] ?? [120, 100, 80];
        for (let n = 0; n < 6; n++) {
          const a = Math.PI * (1 + Math.random()); // spray upward-ish
          const sp = 4 + Math.random() * 8; // tiles/s (tiles are 8px now)
          this.particles.push({
            x: hit.x + 0.5,
            y: hit.y + 0.5,
            vx: Math.cos(a) * sp * (Math.random() < 0.5 ? 1 : -1) * 0.5,
            vy: Math.sin(a) * sp,
            life: 0.45 + Math.random() * 0.25,
            maxLife: 0.7,
            color: `${r},${g},${b}`,
          });
        }
      }
    }
    // Clink: the pick met rock/water/timber — sparks (or a wet splash) so the
    // player learns "this won't dig" even in silence (sound lands in Phase 3)
    if (p.clinkSeq !== this.lastClinkSeq) {
      this.lastClinkSeq = p.clinkSeq;
      for (const hit of p.lastClinks) {
        const isWater = hit.tile === Tile.Water;
        for (let n = 0; n < 5; n++) {
          const a = Math.PI * (1 + Math.random());
          const sp = isWater ? 3 + Math.random() * 4 : 7 + Math.random() * 9;
          this.particles.push({
            x: hit.x + 0.5,
            y: hit.y + 0.5,
            vx: Math.cos(a) * sp * (Math.random() < 0.5 ? 1 : -1) * 0.6,
            vy: Math.sin(a) * sp,
            life: isWater ? 0.5 + Math.random() * 0.2 : 0.15 + Math.random() * 0.15,
            maxLife: isWater ? 0.7 : 0.3,
            color: isWater ? '120,170,235' : '235,230,210', // splash vs spark
          });
        }
      }
    }

    const world = this.sim.world;
    const { ctx } = this;
    for (let n = this.particles.length - 1; n >= 0; n--) {
      const pt = this.particles[n];
      pt.life -= dtSec;
      if (pt.life <= 0) {
        this.particles.splice(n, 1);
        continue;
      }
      pt.vy += 44 * dtSec;
      pt.x += pt.vx * dtSec;
      pt.y += pt.vy * dtSec;
      const light = fullbright
        ? 1
        : Math.pow(Math.min(1, world.lightAt(Math.floor(pt.x), Math.floor(pt.y))), 0.6);
      const a = (pt.life / pt.maxLife) * light;
      if (a <= 0.02) continue;
      ctx.fillStyle = `rgba(${pt.color},${a})`;
      const s = Math.max(1.5, ts * 0.24);
      ctx.fillRect(wsx(pt.x) - s / 2, wsy(pt.y) - s / 2, s, s);
    }
  }

  // --- Player ------------------------------------------------------------------

  private drawPlayer(
    pcx: number,
    pcy: number,
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    tileTs: number,
    alpha: number,
  ): void {
    const { ctx } = this;
    const p = this.sim.player;
    const sx = wsx(pcx);
    const sy = wsy(pcy);
    const h = p.height * tileTs;
    // Body proportions use a FIXED unit (16 screen px at 1× zoom) so the
    // figure keeps its build regardless of how small the world tiles get.
    const ts = 16 * this.scale;
    const headR = ts * 0.18;
    const side = p.facingX >= 0 ? 1 : -1;

    const KHAKI = '#8a7d55';
    const SKIN = '#c9a888';
    const HELMET = '#5d6247';
    const HELMET_RIM = '#474c37';
    const PUTTEE = '#a29467';
    const BOOT = '#3d3226';
    const BELT = '#4a3b26';
    const STRAP = '#6b5d3e';
    const PACK = '#6f6647';

    // Walk/climb cycle driven by actual displacement so feet never slide
    const ddx = pcx - this.lastDrawX;
    const ddy = pcy - this.lastDrawY;
    this.lastDrawX = pcx;
    this.lastDrawY = pcy;
    if (Math.abs(ddx) < 2 && Math.abs(ddy) < 2) {
      this.walkCycle += p.onLadder ? ddy * 2 : ddx * 2; // ddx is in (small) tiles
    }
    const ph = this.walkCycle;
    const moving = Math.abs(p.vx) > 0.4 || (p.onLadder && Math.abs(p.vy) > 0.4);

    ctx.lineCap = 'round';

    // Skeleton anchor points (crouch lean pushes the upper body toward aim)
    const lean = p.crouching ? side * ts * 0.26 : 0;
    const bob = moving && p.grounded ? Math.abs(Math.sin(ph)) * ts * 0.05 : 0;
    const footY = sy + h / 2;
    const hipY = sy + h * 0.18 - bob;
    const shoulderY = sy - h / 2 + headR * 2 + ts * 0.12 - bob;
    const headX = sx + lean + side * ts * 0.03;
    const headY = shoulderY - headR - ts * 0.05;
    const hipX = sx;
    const shoulderX = sx + lean;

    // --- Legs ---------------------------------------------------------------
    let f1x: number, f1y: number, f2x: number, f2y: number;
    if (p.onLadder) {
      f1x = -ts * 0.14; f1y = -Math.max(0, Math.sin(ph)) * ts * 0.22;
      f2x = ts * 0.14;  f2y = -Math.max(0, -Math.sin(ph)) * ts * 0.22;
    } else if (!p.grounded) {
      // airborne: one leg tucked, one trailing
      f1x = -ts * 0.12 * side; f1y = -ts * 0.2;
      f2x = ts * 0.2 * side;   f2y = -ts * 0.04;
    } else if (p.crouching && !moving) {
      // taking a knee: rear knee down behind, front foot planted ahead
      f1x = -side * ts * 0.3; f1y = 0;
      f2x = side * ts * 0.4;  f2y = 0;
    } else if (moving) {
      const stride = p.crouching ? 0.18 : 0.3; // low shuffle while kneeling
      f1x = Math.sin(ph) * ts * stride;  f1y = -Math.max(0, Math.cos(ph)) * ts * 0.14;
      f2x = -Math.sin(ph) * ts * stride; f2y = -Math.max(0, -Math.cos(ph)) * ts * 0.14;
    } else {
      f1x = -ts * 0.16; f1y = 0;
      f2x = ts * 0.16;  f2y = 0;
    }
    // khaki thigh, puttee-wrapped shin, dark boot
    const drawLeg = (fx: number, fy: number) => {
      const footX = sx + fx;
      const footYy = footY + fy;
      const kneeX = hipX + (footX - hipX) * 0.55;
      const kneeY = hipY + (footYy - hipY) * 0.55;
      ctx.strokeStyle = KHAKI;
      ctx.lineWidth = Math.max(1.5, ts * 0.11);
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(kneeX, kneeY);
      ctx.stroke();
      ctx.strokeStyle = PUTTEE;
      ctx.lineWidth = Math.max(1.5, ts * 0.12);
      ctx.beginPath();
      ctx.moveTo(kneeX, kneeY);
      ctx.lineTo(footX, footYy);
      ctx.stroke();
      ctx.strokeStyle = BOOT;
      ctx.lineWidth = Math.max(2, ts * 0.11);
      ctx.beginPath();
      ctx.moveTo(footX - side * ts * 0.03, footYy);
      ctx.lineTo(footX + side * ts * 0.11, footYy);
      ctx.stroke();
    };
    drawLeg(f1x, f1y);
    drawLeg(f2x, f2y);

    // --- Torso: pack behind, filled tunic, belt, chest webbing ------------------
    ctx.fillStyle = PACK;
    const packCx = shoulderX - side * ts * 0.22;
    ctx.fillRect(packCx - ts * 0.11, shoulderY + ts * 0.04, ts * 0.22, ts * 0.36);

    ctx.fillStyle = KHAKI;
    ctx.beginPath();
    ctx.moveTo(shoulderX - ts * 0.15, shoulderY - ts * 0.03);
    ctx.lineTo(shoulderX + ts * 0.15, shoulderY - ts * 0.03);
    ctx.lineTo(hipX + ts * 0.12, hipY);
    ctx.lineTo(hipX - ts * 0.12, hipY);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = STRAP; // shoulder webbing
    ctx.lineWidth = Math.max(1, ts * 0.05);
    ctx.beginPath();
    ctx.moveTo(shoulderX - ts * 0.09, shoulderY + ts * 0.02);
    ctx.lineTo(hipX - ts * 0.05, hipY - ts * 0.05);
    ctx.moveTo(shoulderX + ts * 0.09, shoulderY + ts * 0.02);
    ctx.lineTo(hipX + ts * 0.05, hipY - ts * 0.05);
    ctx.stroke();

    ctx.strokeStyle = BELT;
    ctx.lineWidth = Math.max(1.5, ts * 0.07);
    ctx.beginPath();
    ctx.moveTo(hipX - ts * 0.14, hipY - ts * 0.05);
    ctx.lineTo(hipX + ts * 0.14, hipY - ts * 0.05);
    ctx.stroke();

    // --- Free arm ---------------------------------------------------------------
    let fhX: number, fhY: number;
    if (p.onLadder) {
      fhX = shoulderX - side * ts * 0.08;
      fhY = shoulderY - ts * 0.4 + Math.sin(ph + Math.PI) * ts * 0.1; // reaching up the rungs
    } else if (moving && p.grounded) {
      fhX = shoulderX + Math.sin(ph + Math.PI) * ts * 0.26;
      fhY = shoulderY + ts * 0.38;
    } else if (!p.grounded) {
      fhX = shoulderX - side * ts * 0.28;
      fhY = shoulderY + ts * 0.1; // flung out for balance
    } else {
      fhX = shoulderX - side * ts * 0.1;
      fhY = shoulderY + ts * 0.42;
    }
    ctx.strokeStyle = KHAKI;
    ctx.lineWidth = Math.max(1.5, ts * 0.09);
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY + ts * 0.06);
    ctx.lineTo(fhX, fhY);
    ctx.stroke();
    ctx.fillStyle = SKIN; // bare hand
    ctx.beginPath();
    ctx.arc(fhX, fhY, ts * 0.05, 0, Math.PI * 2);
    ctx.fill();

    // --- Pick arm + tool ----------------------------------------------------------
    const period = p.swingPeriodTicks;
    const phase = p.swingTick < 0 ? -1 : Math.min(0.999, (p.swingTick + alpha) / period);
    const baseAng = Math.atan2(p.facingY, p.facingX);
    let toolAng: number;
    if (phase < 0) {
      toolAng = side >= 0 ? 1.9 : 1.25; // resting: haft hangs at the side
    } else {
      const ip = CONFIG.player.swingImpactPoint;
      if (phase < ip) {
        const t = phase / ip;
        toolAng = baseAng - side * 1.7 + t * t * (side * 2.05); // windup → strike
      } else {
        const t = (phase - ip) / (1 - ip);
        toolAng = baseAng + side * 0.35 - t * side * 0.55; // recoil back
      }
    }
    const armLen = ts * 0.42;
    const toolLen = ts * 0.8;
    const handX = shoulderX + Math.cos(toolAng) * armLen;
    const handY = shoulderY + ts * 0.1 + Math.sin(toolAng) * armLen;

    ctx.strokeStyle = KHAKI;
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY + ts * 0.06);
    ctx.lineTo(handX, handY);
    ctx.stroke();
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(handX, handY, ts * 0.05, 0, Math.PI * 2);
    ctx.fill();

    const tipX = handX + Math.cos(toolAng) * toolLen;
    const tipY = handY + Math.sin(toolAng) * toolLen;
    ctx.strokeStyle = '#8a6a3c';
    ctx.lineWidth = Math.max(1.5, ts * 0.08);
    ctx.beginPath();
    ctx.moveTo(handX, handY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    const perp = toolAng + Math.PI / 2;
    ctx.strokeStyle = '#9aa0a8';
    ctx.lineWidth = Math.max(2, ts * 0.1);
    ctx.beginPath();
    ctx.moveTo(tipX - Math.cos(perp) * ts * 0.28, tipY - Math.sin(perp) * ts * 0.28);
    ctx.lineTo(tipX + Math.cos(perp) * ts * 0.28, tipY + Math.sin(perp) * ts * 0.28);
    ctx.stroke();

    // --- Head + helmet: the HEAD aims; the lamp is bolted to the helmet ------------
    // Pitch = up/down tilt of the face in the facing direction's frame.
    const pitch = Math.max(-0.65, Math.min(0.65, Math.atan2(p.facingY, Math.abs(p.facingX))));

    ctx.save();
    ctx.translate(headX, headY);
    ctx.scale(side, 1); // mirror so +x is always "forward"
    ctx.rotate(pitch);

    // face
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(0, 0, headR, 0, Math.PI * 2);
    ctx.fill();

    // chinstrap (under the jaw, hangs from the brim line)
    ctx.strokeStyle = BELT;
    ctx.lineWidth = Math.max(1, headR * 0.16);
    ctx.beginPath();
    ctx.moveTo(headR * 0.5, -headR * 0.1);
    ctx.lineTo(headR * 0.05, headR * 0.85);
    ctx.stroke();

    // Brodie: shallow dome + wide flat brim, riding with the head
    ctx.fillStyle = HELMET;
    ctx.beginPath();
    ctx.arc(0, -headR * 0.35, headR * 0.95, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -headR * 0.35, headR * 1.65, headR * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = HELMET_RIM; // brim rim highlight
    ctx.lineWidth = Math.max(1, headR * 0.14);
    ctx.beginPath();
    ctx.ellipse(0, -headR * 0.35, headR * 1.65, headR * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Headlamp lens fixed to the helmet front (does not slide around the head)
    if (p.lampOn && p.carriedLamp === 'head') {
      ctx.fillStyle = '#ffe9a0';
      ctx.beginPath();
      ctx.arc(headR * 0.95, -headR * 0.45, ts * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Hip lamp on the belt
    if (p.lampOn && p.carriedLamp === 'hip') {
      ctx.fillStyle = '#ffd27a';
      ctx.beginPath();
      ctx.arc(hipX - side * ts * 0.12, hipY, ts * 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- Overlays / HUD ----------------------------------------------------------

  private drawStabilityOverlay(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
  ): void {
    const { ctx } = this;
    const world = this.sim.world;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * world.w + x;
        if (world.tiles[i] === Tile.Air || world.tiles[i] === Tile.Ladder) continue;
        const s = world.stability[i] / 100; // 0 bad → 1 solid
        const r = Math.floor(255 * (1 - s));
        const g = Math.floor(220 * s);
        ctx.fillStyle = `rgba(${r},${g},40,0.45)`;
        ctx.fillRect(wsx(x), wsy(y), ts + 0.5, ts + 0.5);
      }
    }
  }

  /**
   * Debug view 3 — worldgen v3 regions: depth-band tints, capture-point
   * footprints, curtain gaps (color-coded by band, red = unusable, orange
   * ring = sand gap), abandoned workings, and the enemy network with the
   * dead-end branch visually distinct.
   */
  private drawRegionsOverlay(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    wsx: (x: number) => number,
    wsy: (y: number) => number,
    ts: number,
  ): void {
    const { ctx } = this;
    const world = this.sim.world;
    const regions = world.regions;
    if (!regions) return;

    // Depth-band tints per column (band boundaries are noise-warped)
    for (let x = x0; x <= x1; x++) {
      const surf = world.groundY[x];
      const sb = world.bandShallowBottomY[x];
      const cb = world.bandClayBottomY[x];
      const strip = (ya: number, yb: number, color: string) => {
        const a = Math.max(ya, y0);
        const b = Math.min(yb, y1 + 1);
        if (b <= a) return;
        ctx.fillStyle = color;
        ctx.fillRect(wsx(x), wsy(a), ts + 0.5, (b - a) * ts);
      };
      strip(surf, sb, 'rgba(200, 170, 60, 0.12)'); // shallow: fast, loud, unstable
      strip(sb, cb, 'rgba(190, 90, 60, 0.16)'); // clay: the premium stealth route
      strip(cb, y1 + 1, 'rgba(110, 115, 145, 0.20)'); // basement: closes the bottom
    }

    const box = (r: { x0: number; y0: number; x1: number; y1: number }, stroke: string, fill?: string) => {
      const px = wsx(r.x0);
      const py = wsy(r.y0);
      const w = (r.x1 - r.x0 + 1) * ts;
      const h = (r.y1 - r.y0 + 1) * ts;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(px, py, w, h);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1.5, ts * 0.15);
      ctx.strokeRect(px, py, w, h);
    };

    // Capture points: footprint span + floor rect + flag pole marker
    for (const p of regions.points) {
      if (p.footprint.x1 < x0 || p.footprint.x0 > x1) continue;
      const c = p.active ? 'rgba(120, 220, 140, 0.9)' : 'rgba(120, 220, 140, 0.35)';
      box({ x0: p.footprint.x0, y0: Math.max(y0, p.groundY - 8), x1: p.footprint.x1, y1: Math.min(y1, p.groundY + 14) }, c);
      box(p.floor, c, p.active ? 'rgba(120, 220, 140, 0.15)' : undefined);
      ctx.fillStyle = c;
      ctx.font = `${Math.max(10, ts * 1.4)}px monospace`;
      ctx.fillText(
        `P${p.id} ${p.kind}${p.active ? ' ●' : ''}`,
        wsx(p.footprint.x0),
        wsy(p.groundY - 9),
      );
    }

    // Curtain gaps, color-coded by band; red = unusable, orange ring = sand
    const bandColor = { shallow: 'rgba(230, 200, 60, 0.9)', clay: 'rgba(235, 120, 80, 0.9)', basement: 'rgba(140, 150, 235, 0.9)' };
    for (const c of regions.curtains) {
      if (c.x1 < x0 || c.x0 > x1) continue;
      for (const g of c.gaps) {
        const stroke = g.usable ? bandColor[g.band] : 'rgba(255, 40, 40, 1)';
        box({ x0: c.x0, y0: g.y0, x1: c.x1, y1: g.y1 }, stroke, g.usable ? undefined : 'rgba(255,40,40,0.25)');
        if (g.sandGap) {
          box({ x0: c.x0 - 1, y0: g.y0 - 1, x1: c.x1 + 1, y1: g.y1 + 1 }, 'rgba(240, 180, 40, 0.8)');
        }
        if (g.tell) {
          ctx.fillStyle = 'rgba(240, 240, 240, 0.9)';
          ctx.fillRect(wsx(g.tell.x) - ts * 0.25, wsy(g.tell.y) - ts * 0.25, ts * 0.5, ts * 0.5);
        }
      }
    }

    // Abandoned workings
    for (const w of regions.workings) {
      if (w.bounds.x1 < x0 || w.bounds.x0 > x1) continue;
      box(w.bounds, 'rgba(235, 160, 60, 0.85)', 'rgba(235, 160, 60, 0.10)');
      ctx.fillStyle = 'rgba(235, 160, 60, 0.85)';
      ctx.font = `${Math.max(10, ts * 1.2)}px monospace`;
      ctx.fillText(`W${w.id}${w.sealed ? '' : ' UNSEALED!'}`, wsx(w.bounds.x0), wsy(w.bounds.y0) - 4);
    }

    // Enemy network: segment fills + branch polylines (dead-end distinct)
    const net = regions.enemyNetwork;
    for (const s of net.segments) {
      if (s.x1 < x0 || s.x0 > x1) continue;
      ctx.fillStyle = 'rgba(220, 70, 70, 0.14)';
      ctx.fillRect(wsx(s.x0), wsy(s.y0), (s.x1 - s.x0 + 1) * ts, (s.y1 - s.y0 + 1) * ts);
    }
    for (const b of net.branches) {
      const color = b.deadEnd
        ? 'rgba(240, 80, 240, 0.95)' // the abandoned drive — dead end BY DESIGN
        : b.kind === 'stub'
          ? 'rgba(90, 200, 220, 0.9)'
          : 'rgba(230, 90, 90, 0.9)';
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, ts * 0.2);
      ctx.setLineDash(b.deadEnd ? [ts, ts * 0.6] : []);
      ctx.beginPath();
      b.nodes.forEach((nd, i) => {
        const px = wsx(nd.x) + ts / 2;
        const py = wsy(nd.y) + ts / 2;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      if (b.deadEnd) {
        const end = b.nodes[b.nodes.length - 1];
        ctx.fillStyle = color;
        ctx.font = `${Math.max(10, ts * 1.2)}px monospace`;
        ctx.fillText('✕ dead end', wsx(end.x) - ts * 6, wsy(end.y) - ts);
      }
    }
    ctx.fillStyle = 'rgba(230, 90, 90, 0.9)';
    ctx.beginPath();
    ctx.arc(wsx(net.sapMouth.x) + ts / 2, wsy(net.sapMouth.y) + ts / 2, ts * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawHud(): void {
    const { ctx } = this;
    const p = this.sim.player;
    ctx.font = '14px monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = p.health < 35 ? '#ff6a5e' : '#cfc9b8';
    ctx.fillText(`HP ${Math.ceil(p.health)}`, 12, 12);
    ctx.fillStyle = p.lampOn ? '#ffe9a0' : '#5a564c';
    ctx.fillText(`[F] ${p.carriedLamp === 'head' ? 'headlamp' : 'hip lamp'} ${p.lampOn ? 'ON' : 'off'}`, 12, 30);
    if (p.inHomeTrench()) {
      ctx.fillStyle = '#9fb8a0';
      ctx.fillText(`[G] armorer: swap to ${p.carriedLamp === 'head' ? 'hip lamp' : 'headlamp'}`, 12, 48);
    }

    // Crossing-playtest line (Stage 5): elapsed sim time · depth band ·
    // distance to the next capture point east. Reads sim state only.
    if (CONFIG.debug.playtestHud) {
      const sim = this.sim;
      const secs = Math.floor(sim.tickCount / CONFIG.sim.tickRate);
      const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      const px = Math.floor(p.x);
      const band = sim.world.bandAt(px, Math.floor(p.y - 0.001));
      const next = sim.world.regions?.points.find((pt) => pt.flagPole.x > p.x);
      const nextTxt = next
        ? `next: P${next.id} ${next.kind}${next.active ? ' ●' : ''} ${Math.ceil(next.flagPole.x - p.x)} tiles →`
        : 'next: — (east end)';
      const line = `⏱ ${clock}  ·  band: ${band}  ·  ${nextTxt}`;
      const w = ctx.measureText(line).width;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(this.canvas.width / 2 - w / 2 - 10, 8, w + 20, 24);
      ctx.fillStyle = '#cfc9b8';
      ctx.fillText(line, this.canvas.width / 2 - w / 2, 13);
    }
  }

  private drawDeathFlash(): void {
    const { ctx, canvas } = this;
    ctx.fillStyle = 'rgba(120, 10, 10, 0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e0d8c8';
    ctx.font = '22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('You died. Returning to the trench…', canvas.width / 2, canvas.height / 2);
    ctx.textAlign = 'left';
  }
}
