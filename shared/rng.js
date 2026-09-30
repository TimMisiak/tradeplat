// Seeded PRNG: sfc32, seeded through splitmix32. See WORLDGEN.md § Determinism.
// Integer math only (Math.imul, shifts, >>> 0), so the output is bit-identical on
// every JS engine. Use this instead of Math.random anywhere in shared/.

/** 32-bit FNV-1a of a string, for turning labels into seeds. */
export function hashString(str, h = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(state) {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * @param {number} seed 32-bit integer
 * @returns {Rng}
 *
 * @typedef {{
 *   seed: number,
 *   u32(): number,
 *   float(): number,
 *   int(lo: number, hi: number): number,
 *   range(lo: number, hi: number): number,
 *   chance(p: number): boolean,
 *   pick<T>(arr: readonly T[]): T,
 *   shuffle<T>(arr: T[]): T[],
 *   fork(label: string): Rng,
 *   state(): number[],
 * }} Rng
 */
export function createRng(seed, _state) {
  let a, b, c, d;
  if (_state) {
    [a, b, c, d] = _state;
  } else {
    const sm = splitmix32(seed);
    a = sm(); b = sm(); c = sm(); d = sm();
  }

  function u32() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t;
  }

  const rng = {
    seed: seed >>> 0,
    u32,
    /** [0, 1). Exact: a 32-bit integer divided by 2^32. */
    float: () => u32() / 4294967296,
    /** Integer in [lo, hi], inclusive. */
    int: (lo, hi) => lo + Math.floor((u32() / 4294967296) * (hi - lo + 1)),
    /** Float in [lo, hi). */
    range: (lo, hi) => lo + (u32() / 4294967296) * (hi - lo),
    chance: (p) => u32() / 4294967296 < p,
    pick: (arr) => arr[Math.floor((u32() / 4294967296) * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor((u32() / 4294967296) * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    /**
     * An independent stream for a named stage. Depends only on this rng's seed and
     * the label, not on how much of this stream has been used, so adding draws to
     * one stage doesn't reshuffle the others.
     */
    fork: (label) => createRng(hashString(label, rng.seed ^ 0x811c9dc5)),
    /** Internal state, for persistence (restore with createRng(seed, state)). */
    state: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
  return rng;
}
