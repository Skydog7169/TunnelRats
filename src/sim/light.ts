// Dynamic lamp lighting, recomputed per tick in the sim (Phase-4 AI must query
// "is this tile lit", so this cannot live in the renderer).
//
// Method: for every tile within a source's range, sample along the ray from
// the source to the tile center; each solid tile crossed multiplies the light
// by CONFIG.light.solidTransmit → real shadows, with wall faces still lit.
// Cleared each tick via a touched-index list — never a full-grid clear.

import { CONFIG } from '../config';
import { len2 } from '../core/trig';
import { World } from './world';

export interface LightSource {
  x: number; // tile-unit world coords
  y: number;
  range: number; // tiles
  intensity: number; // 0..1 at the source
  // Optional cone (headlamp): direction + angular cutoffs in radians
  dirX?: number;
  dirY?: number;
  coneCos?: number; // cos(half-angle): full brightness inside
  coneSoftCos?: number; // cos(half-angle + soft): zero beyond
}

export class DynamicLight {
  private touched: number[] = [];

  constructor(private world: World) {}

  /** Recompute all dynamic light for this tick from the given sources. */
  update(sources: LightSource[]): void {
    const { lightDyn } = this.world;
    for (const i of this.touched) lightDyn[i] = 0;
    this.touched.length = 0;
    for (const s of sources) this.castSource(s);
  }

  private castSource(s: LightSource): void {
    const { world } = this;
    const R = Math.ceil(s.range);
    const x0 = Math.max(0, Math.floor(s.x) - R);
    const x1 = Math.min(world.w - 1, Math.floor(s.x) + R);
    const y0 = Math.max(0, Math.floor(s.y) - R);
    const y1 = Math.min(world.h - 1, Math.floor(s.y) + R);
    const transmit = CONFIG.light.solidTransmit;

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const cx = tx + 0.5;
        const cy = ty + 0.5;
        const dx = cx - s.x;
        const dy = cy - s.y;
        const dist = len2(dx, dy); // Math.hypot is implementation-defined precision
        if (dist > s.range) continue;

        // Flat-then-fall distance curve (bright through mid-range, quick fade
        // at the edge); the renderer applies a gamma lift on top.
        const dr = dist / s.range;
        let v = s.intensity * (1 - dr * dr);

        // Cone mask
        if (s.coneCos !== undefined && dist > 0.75) {
          const d = (dx / dist) * (s.dirX ?? 1) + (dy / dist) * (s.dirY ?? 0);
          const soft = s.coneSoftCos ?? s.coneCos;
          if (d < soft) continue;
          if (d < s.coneCos) v *= (d - soft) / (s.coneCos - soft);
        }
        if (v <= 0.004) continue;

        // Occlusion: sample the segment, charging each solid tile crossed once.
        // The target tile itself is not charged, so wall faces light up.
        const steps = Math.max(1, Math.ceil(dist / 0.33));
        let lastTile = -1;
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const sx = Math.floor(s.x + dx * t);
          const sy = Math.floor(s.y + dy * t);
          const ti = sy * world.w + sx;
          if (ti === lastTile || (sx === tx && sy === ty)) continue;
          lastTile = ti;
          if (world.isSolid(sx, sy)) {
            v *= transmit;
            if (v <= 0.004) break;
          }
        }
        if (v <= 0.004) continue;

        const i = ty * world.w + tx;
        if (world.lightDyn[i] === 0) this.touched.push(i);
        if (v > world.lightDyn[i]) world.lightDyn[i] = v;
      }
    }
  }
}
