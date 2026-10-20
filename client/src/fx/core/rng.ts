// Small deterministic PRNG + hashing helpers. Everything visual that must match across clients
// (monster shape, flash schedules, simulated scenes) derives from these.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash of up to three ints → uint32. */
export function hash3(a: number, b = 0, c = 0): number {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= b | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= c | 0;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Deterministic 0..1 from integer coordinates. */
export function rand01(a: number, b = 0, c = 0): number {
  return hash3(a, b, c) / 4294967296;
}

export function range(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Approximately normal(0,1). */
export function gauss(rng: Rng): number {
  return (rng() + rng() + rng() + rng() - 2) * 1.732;
}

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
