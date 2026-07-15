// Deterministic trig for the sim boundary. JavaScript guarantees bit-identical
// results across engines for +, -, *, / and Math.sqrt (IEEE-754 correctly
// rounded) — but NOT for Math.sin/cos/atan2/etc. This module provides a
// sin/cos lookup table built with only basic arithmetic, so every machine
// computes the exact same values: safe for lockstep.
//
// Construction: one ultra-accurate Taylor evaluation of sin/cos at the tiny
// table step (error ~1e-24), then the angle-addition recurrence to fill the
// table. Only +,-,* — fully deterministic. Accumulated drift over a full
// circle is ~1e-12, far below gameplay relevance.
//
// The renderer is unrestricted and should keep using Math.* directly.

export const ANGLE_STEPS = 4096; // table resolution: full circle, ~0.088° per step

const SIN = new Float64Array(ANGLE_STEPS);
{
  const d = (2 * Math.PI) / ANGLE_STEPS; // Math.PI is a constant, not a function
  // Taylor at d (|d| ≈ 0.0015): more than enough terms for full f64 precision
  const d2 = d * d;
  const sd = d * (1 - (d2 / 6) * (1 - d2 / 20 + (d2 * d2) / 840));
  const cd = 1 - (d2 / 2) * (1 - d2 / 12 + (d2 * d2) / 360);
  let s = 0;
  let c = 1;
  for (let i = 0; i < ANGLE_STEPS; i++) {
    SIN[i] = s;
    const ns = s * cd + c * sd;
    c = c * cd - s * sd;
    s = ns;
  }
}

const MASK = ANGLE_STEPS - 1;
const QUARTER = ANGLE_STEPS / 4;

/** sin of an integer table angle (wraps; negatives fine). */
export function sinIdx(i: number): number {
  return SIN[i & MASK];
}

/** cos of an integer table angle. */
export function cosIdx(i: number): number {
  return SIN[(i + QUARTER) & MASK];
}

/** Degrees → nearest table angle (quantizes to ~0.088°). */
export function degToIdx(deg: number): number {
  return Math.round((deg * ANGLE_STEPS) / 360);
}

export function sinDeg(deg: number): number {
  return sinIdx(degToIdx(deg));
}

export function cosDeg(deg: number): number {
  return cosIdx(degToIdx(deg));
}

/** Deterministic 2D vector length (Math.hypot is implementation-defined). */
export function len2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Rotate (x, y) by a table angle: returns [x', y']. */
export function rotateIdx(x: number, y: number, i: number): [number, number] {
  const c = cosIdx(i);
  const s = sinIdx(i);
  return [x * c - y * s, x * s + y * c];
}
