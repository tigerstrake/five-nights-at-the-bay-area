// Seeded deterministic RNG (mulberry32). State is a single uint32 so it can live inside GameState.
export interface Rng {
  next(): number; // [0,1)
  int(minIncl: number, maxIncl: number): number;
  range(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  state(): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    range: (a, b) => a + next() * (b - a),
    chance: (p) => next() < p,
    pick: (arr) => {
      if (!arr.length) throw new Error('pick from empty array');
      return arr[Math.floor(next() * arr.length)]!;
    },
    state: () => s,
  };
}

/** Stable 32-bit hash of a string (FNV-1a). */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
