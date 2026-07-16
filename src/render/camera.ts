// Smooth-follow camera in tile units. Enforces the "never show the surface
// unless the player is in a trench" rule by clamping its top edge to the
// local surface row when the player is underground.

import { CONFIG } from '../config';
import { World } from '../sim/world';

export class Camera {
  x: number; // center, tile units
  y: number;

  // Eased-in HARD floor for the underground surface-hide rule. null while
  // the rule is inactive (on the surface / in a trench).
  private surfaceClampY: number | null = null;

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
    // must sit surfaceHideDepth BELOW the surface line — in a tunnel the
    // surface simply doesn't exist on screen (confined-peripherals rule).
    // The clamp value EASES in from wherever the camera was (a hard snap on
    // stepping underground yanks the view — playtest r5), but once tracked
    // it applies as a HARD floor each frame: the old ease-only version
    // fought the follow smoothing to an equilibrium ~8 tiles short and
    // quietly kept the surface on screen.
    const px = Math.floor(targetX);
    const py = Math.floor(targetY);
    const inTrench = world.inTrench(px, py) !== null;
    const surf = world.surfaceY[Math.max(0, Math.min(world.w - 1, px))];
    const onSurface = py <= surf;
    if (!inTrench && !onSurface) {
      // The player always outranks the surface-hide rule: never clamp so far
      // down that fewer than keepAbovePlayer tiles above his center remain
      // visible (shallow digs show a surface strip instead of a beheaded
      // soldier; climbing out, the hole's lip stays in view).
      const minY = Math.min(
        surf + C.surfaceHideDepth + halfH,
        targetY - C.keepAbovePlayer + halfH,
      );
      const k2 = 1 - Math.exp(-5 * dtSec);
      this.surfaceClampY =
        this.surfaceClampY === null ? this.y : this.surfaceClampY + (minY - this.surfaceClampY) * k2;
      if (this.y < this.surfaceClampY) this.y = this.surfaceClampY;
    } else {
      this.surfaceClampY = null;
    }

    // Map bounds
    this.x = Math.max(halfW, Math.min(world.w - halfW, this.x));
    this.y = Math.max(halfH, Math.min(world.h - halfH, this.y));
  }
}
