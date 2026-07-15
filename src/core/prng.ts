// Seeded, deterministic randomness. The ONLY randomness sources allowed in sim
// code. mulberry32 for sequential streams; hash2 for position-keyed lattice
// values (worldgen noise), so generation order can never change the world.

export class PRNG {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** Internal state, exposed for the sim-state hash (read-only use). */
  get state(): number {
    return this.s;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Derive an independent stream (e.g. worldgen vs live sim). */
  fork(streamId: number): PRNG {
    return new PRNG((this.s ^ Math.imul(streamId, 0x85ebca6b)) >>> 0);
  }
}

/** Stateless position hash → [0, 1). Order-independent by construction. */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
