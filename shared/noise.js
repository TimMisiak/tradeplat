// Integer-hash value noise. See WORLDGEN.md § Determinism.
// Uses only Math.imul, shifts, + − × and floor, so results are bit-identical on
// every engine. No Math.sin, Math.pow or Math.random.

/** Hash of lattice point (x, y) with a seed → [0, 1). */
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 1D value noise in [0, 1). `x` is in lattice units. */
export function noise1(x, seed) {
  const x0 = Math.floor(x);
  const t = smooth(x - x0);
  const a = hash2(x0, 0, seed), b = hash2(x0 + 1, 0, seed);
  return a + (b - a) * t;
}

/** 2D value noise in [0, 1). */
export function noise2(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = smooth(x - x0), ty = smooth(y - y0);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Fractal sum of octaves, normalised to [0, 1). Each octave doubles the frequency
 * and halves the amplitude (both exact in floating point).
 * @param {(x: number, y: number, seed: number) => number} fn noise1 (y ignored) or noise2
 */
export function fbm(fn, x, y, seed, octaves) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += fn(x * f, y * f, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}
