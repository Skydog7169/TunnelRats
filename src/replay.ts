// Command recorder / replayer. Lives OUTSIDE the sim boundary: the sim only
// ever sees InputCommand structs, whether they come from live input or from a
// recorded session.
//
// Session file format v1 (JSON):
// {
//   "version": 1,
//   "seed": 123456,             // world seed; replay reconstructs Sim from it
//   "start": 0,                 // OPTIONAL (Stage 5): capture-point spawn id
//                               // 0–4; omitted/0 = west home trench
//   "commands": [ [moveX, flags, aimX, aimY], ... ],  // one entry per tick,
//                               // starting at tick 0 of a FRESH sim
//   "finalHash": "16-hex-chars" // hashSimState after the last command
// }
// flags bitmask: 1 jump · 2 jumpHeld · 4 crouch · 8 dig · 16 toggleLamp ·
// 32 swapLamp · bits 6-8 = selectSlot + 1 (0 = no selection this tick; the
// encoding keeps the 4-tuple shape, so pre-slot sessions stay valid — their
// upper bits are simply 0). aimX/aimY are raw doubles — JSON round-trips
// them exactly (shortest-round-trip serialization), so replay input is
// bit-identical.

import { emptyCommand, InputCommand } from './command';

export type SerializedCommand = [number, number, number, number];

export interface SessionV1 {
  version: 1;
  seed: number;
  start?: number; // capture-point spawn id (Sim startPoint); absent = 0
  commands: SerializedCommand[];
  finalHash: string;
}

export function serializeCommand(c: InputCommand): SerializedCommand {
  let flags = 0;
  if (c.jump) flags |= 1;
  if (c.jumpHeld) flags |= 2;
  if (c.crouch) flags |= 4;
  if (c.dig) flags |= 8;
  if (c.toggleLamp) flags |= 16;
  if (c.swapLamp) flags |= 32;
  flags |= (c.selectSlot + 1) << 6; // 0 = none, 1..4 = slot 0..3
  return [c.moveX, flags, c.aimX, c.aimY];
}

export function deserializeCommand(s: SerializedCommand): InputCommand {
  const c = emptyCommand();
  c.moveX = s[0] as -1 | 0 | 1;
  const flags = s[1];
  c.jump = (flags & 1) !== 0;
  c.jumpHeld = (flags & 2) !== 0;
  c.crouch = (flags & 4) !== 0;
  c.dig = (flags & 8) !== 0;
  c.toggleLamp = (flags & 16) !== 0;
  c.swapLamp = (flags & 32) !== 0;
  c.selectSlot = ((flags >> 6) & 7) - 1;
  c.aimX = s[2];
  c.aimY = s[3];
  return c;
}

export function isValidSession(o: unknown): o is SessionV1 {
  const s = o as SessionV1;
  return (
    !!s &&
    s.version === 1 &&
    typeof s.seed === 'number' &&
    (s.start === undefined || (typeof s.start === 'number' && s.start >= 0 && s.start <= 4)) &&
    Array.isArray(s.commands) &&
    typeof s.finalHash === 'string'
  );
}

/** Trigger a browser download of the session JSON (renderer-side only). */
export function downloadSession(session: SessionV1): void {
  const blob = new Blob([JSON.stringify(session)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tunnelrats-session-${session.seed}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
