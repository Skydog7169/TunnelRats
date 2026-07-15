// The per-tick input command struct — the ONLY way input reaches the sim.
// This is the lockstep-multiplayer seam: a remote player is just another
// stream of these.

export interface InputCommand {
  moveX: -1 | 0 | 1;
  jump: boolean;      // pressed this tick (edge)
  jumpHeld: boolean;
  crouch: boolean;
  dig: boolean;       // held
  aimX: number;       // cursor position in WORLD tile coords
  aimY: number;
  toggleLamp: boolean; // edge: switch carried lamp on/off
  swapLamp: boolean;   // edge: swap head<->hip lamp (only works at own trench)
}

export function emptyCommand(): InputCommand {
  return {
    moveX: 0,
    jump: false,
    jumpHeld: false,
    crouch: false,
    dig: false,
    aimX: 0,
    aimY: 0,
    toggleLamp: false,
    swapLamp: false,
  };
}
