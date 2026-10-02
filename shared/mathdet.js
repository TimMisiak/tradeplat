// Deterministic trig for shared simulation code. See ARCHITECTURE.md § Determinism.
// Math.sin/cos aren't guaranteed to give the same bits on every JS engine. These use
// only + − × ÷ and Math.floor, which are exact under IEEE-754, so client and server
// agree bit for bit. Accuracy is better than 1e-11, plenty for enemy paths.

const TAU = 6.283185307179586;

/** sin of a whole number of turns (1 turn = 2π). */
export function sinTurns(t) {
  let f = t - Math.floor(t); // [0, 1)
  let sign = 1;
  if (f >= 0.5) { f -= 0.5; sign = -1; }
  if (f > 0.25) f = 0.5 - f; // [0, 0.25]: sin is symmetric about a quarter turn
  const x = f * TAU; // [0, π/2]
  const x2 = x * x;
  // Taylor series to x^15, in Horner form. Error < 1e-11 on [0, π/2].
  const s = x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156 * (1 - x2 / 210)))))));
  return sign * s;
}

/** cos of a whole number of turns. */
export function cosTurns(t) {
  return sinTurns(t + 0.25);
}
