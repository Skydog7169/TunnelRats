// Smooth-follow camera in tile units. Enforces the "never show the surface
// unless the player is in a trench" rule by clamping its top edge to the
// local surface row when the player is underground.

import { CONFIG } from '../config';
import { World } from '../sim/world';

export class Camera {
  x: number; // center, tile units
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  update(
    world: World,
    targetX: number,
    targetY: number,
    aimDx: number,
    aimDy: number,
    dtSec: number,
    halfW: number, // ACTUAL visible half-extents in tiles (from canvas size),
    halfH: number, // not the configured view — clamping on config over-clamps
  ): void {
    const C = CONFIG.camera;
    let tx = targetX + aimDx * C.aimLead;
    let ty = targetY + aimDy * C.aimLead;

    // Exponential smoothing (frame-rate independent)
    const k = 1 - Math.exp(-C.followSpeed * dtSec);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;

    // Surface rule: underground and outside a trench, the camera's top edge
    // may reach the surface line but never show the sky/no-man's-land above.
    // Approach the limit SMOOTHLY — a hard snap when stepping underground
    // yanks the view down (playtest r5 feedback).
    const px = Math.floor(targetX);
    const py = Math.floor(targetY);
    const inTrench = world.inTrench(px, py) !== null;
    const surf = world.surfaceY[Math.max(0, Math.min(world.w - 1, px))];
    const onSurface = py <= surf;
    if (!inTrench && !onSurface) {
      const minY = surf + halfH;
      if (this.y < minY) {
        const k2 = 1 - Math.exp(-5 * dtSec);
        this.y += (minY - this.y) * k2;
      }
    }

    // Map bounds
    this.x = Math.max(halfW, Math.min(world.w - halfW, this.x));
    this.y = Math.max(halfH, Math.min(world.h - halfH, this.y));
  }
}
