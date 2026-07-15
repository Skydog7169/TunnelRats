// Input manager: samples raw DOM events into per-tick InputCommand structs.
// Edge-triggered actions (jump press, lamp toggles) are latched between ticks
// so a quick tap between two ticks is never lost. The sim never sees DOM state.

import { emptyCommand, InputCommand } from './command';

export class InputManager {
  private keys = new Set<string>();
  private jumpLatch = false;
  private toggleLampLatch = false;
  private swapLampLatch = false;
  private mouseDown = false;

  mouseSx = 0; // raw screen px, used by renderer for aim/camera lead
  mouseSy = 0;

  // Render-side debug key callbacks (not part of the sim command stream)
  onToggleOverlay: (() => void) | null = null;
  onCycleView: (() => void) | null = null;
  onNewSeed: (() => void) | null = null;
  onToggleRecord: (() => void) | null = null;
  onHashState: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      switch (e.code) {
        case 'KeyW':
        case 'Space':
        case 'ArrowUp':
          this.jumpLatch = true;
          e.preventDefault();
          break;
        case 'KeyF':
          this.toggleLampLatch = true;
          break;
        case 'KeyG':
          this.swapLampLatch = true;
          break;
        case 'Backquote':
          this.onToggleOverlay?.();
          break;
        case 'KeyB':
          this.onCycleView?.();
          break;
        case 'KeyN':
          this.onNewSeed?.();
          break;
        case 'KeyR':
          this.onToggleRecord?.();
          break;
        case 'KeyH':
          this.onHashState?.();
          break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    canvas.addEventListener('mousemove', (e) => {
      this.mouseSx = e.clientX;
      this.mouseSy = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Build the command for the next sim tick. aim is world tile coords. */
  buildCommand(aimWorld: { x: number; y: number }): InputCommand {
    const cmd = emptyCommand();
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    cmd.moveX = left === right ? 0 : left ? -1 : 1;
    cmd.jump = this.jumpLatch;
    cmd.jumpHeld =
      this.keys.has('KeyW') || this.keys.has('Space') || this.keys.has('ArrowUp');
    cmd.crouch = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    cmd.dig = this.mouseDown;
    cmd.aimX = aimWorld.x;
    cmd.aimY = aimWorld.y;
    cmd.toggleLamp = this.toggleLampLatch;
    cmd.swapLamp = this.swapLampLatch;

    this.jumpLatch = false;
    this.toggleLampLatch = false;
    this.swapLampLatch = false;
    return cmd;
  }
}
