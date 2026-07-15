// Seeded value noise built on the stateless position hash. Used by worldgen
// for strata boundary warping, blob edges, and root-mat placement.

import { hash2 } from './prng';

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise in [0, 1). x/y are in "noise space" (pre-multiply by freq). */
export function valueNoise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const a = hash2(seed, xi, yi);
  const b = hash2(seed, xi + 1, yi);
  const c = hash2(seed, xi, yi + 1);
  const d = hash2(seed, xi + 1, yi + 1);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Fractal (fBm) value noise in [0, 1). */
export function fbm2(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(seed + i * 101, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** 1D convenience wrapper. */
export function noise1(seed: number, x: number): number {
  return valueNoise2(seed, x, 0.5);
}
