// Deterministic seeded RNG (mulberry32): reproducible executor randomness —
// identical seeds replay identical executor decisions (games still vary:
// the enemy fires with its own unseeded Math.random), so exploration and
// jitter stay testable and debuggable.

export function mulberry32(seed: number): () => number {
  // scramble zero/negative seeds so every seed yields a distinct stream
  let a = (seed | 0) ^ 0x9e3779b9;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
