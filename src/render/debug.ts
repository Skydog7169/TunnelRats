// Debug overlay: FPS, tick, seed, player coords, current debug view, controls.
// Debug VIEWS (strata / stability) are handled in the renderer; this file is
// the text panel.

import { CONFIG } from '../config';
import { Sim } from '../sim/sim';
import { Tile, TILE_NAME } from '../sim/tiles';

export interface DebugState {
  overlayOn: boolean;
  viewMode: number; // 0 none, 1 strata (fullbright), 2 stability heatmap, 3 regions
  fps: number;
  status: string; // recorder/replayer status line (set by main.ts)
  lastHash: string; // last on-demand sim-state hash (H key)
}

export const VIEW_COUNT = 4;
const VIEW_NAMES = ['off', 'strata (fullbright)', 'stability heatmap', 'regions (worldgen v3)'];

export function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  sim: Sim,
  dbg: DebugState,
  playerTile: { x: number; y: number },
): void {
  const p = sim.player;
  const tileUnder = sim.world.getTile(playerTile.x, playerTile.y + 1) as Tile;
  const lines = [
    `fps ${dbg.fps.toFixed(0)}  tick ${sim.tickCount} @ ${CONFIG.sim.tickRate}Hz`,
    `seed ${sim.seed}   (?seed=${sim.seed}${sim.startPoint !== 0 ? `&start=${sim.startPoint}` : ''}, N = new seed)`,
    `player tile ${playerTile.x},${playerTile.y}  vel ${p.vx.toFixed(1)},${p.vy.toFixed(1)}`,
    `standing on: ${TILE_NAME[tileUnder]}  band: ${sim.world.bandAt(playerTile.x, playerTile.y)}  crouch:${p.crouching ? 'y' : 'n'} grounded:${p.grounded ? 'y' : 'n'}`,
    `loadout: ${p.loadout.slots.map((s) => (s ? `${s.item}×${s.count}` : '—')).join(' | ')}`,
    `debug view [B]: ${VIEW_NAMES[dbg.viewMode]}`,
    `light@player sun ${sim.world.lightSun[sim.world.idx(playerTile.x, playerTile.y)]?.toFixed(2)} dyn ${sim.world.lightDyn[sim.world.idx(playerTile.x, playerTile.y)]?.toFixed(2)}`,
    `[R] record  [H] hash  (drop a session .json to replay)`,
  ];
  if (dbg.status) lines.push(dbg.status);
  if (dbg.lastHash) lines.push(`state hash: ${dbg.lastHash}`);

  const w = 460;
  const lh = 16;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(ctx.canvas.width - w - 8, 8, w, lines.length * lh + 12);
  ctx.font = '12px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#8fe388';
  lines.forEach((l, i) => ctx.fillText(l, ctx.canvas.width - w, 14 + i * lh));
}
