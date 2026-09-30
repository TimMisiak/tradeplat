// World instance and fixed-tick loop. See ARCHITECTURE.md § Simulation.
// The world is generated from a seed on start (WORLDGEN.md). Clients get only
// {seed, genVersion, hash} and regenerate it themselves. Players and the market plug in later.
import { performance } from 'node:perf_hooks';
import { randomInt } from 'node:crypto';
import { TICK_RATE } from '../shared/physics.js';
import { generateWorld } from '../shared/worldgen.js';

export { TICK_RATE };
const TICK_MS = 1000 / TICK_RATE;
/** Longest catch-up after a stall (e.g. debugger pause) before we drop time instead. */
const MAX_CATCHUP_TICKS = 30;

/** @param {{seed?: number}} [opts] seed defaults to a random 32-bit value */
export function createGame({ seed = randomInt(0, 2 ** 32) } = {}) {
  const t0 = performance.now();
  const world = generateWorld(seed);
  const genMs = performance.now() - t0;

  const game = {
    world,
    genMs,
    tick: 0,
    running: false,
    /** @type {((tick: number) => void)[]} */
    onTick: [],
    start,
    stop,
  };

  let last = 0;
  let acc = 0;
  let timer = null;

  function start() {
    if (game.running) return;
    game.running = true;
    last = performance.now();
    acc = 0;
    schedule();
  }

  function stop() {
    game.running = false;
    clearTimeout(timer);
    timer = null;
  }

  // Accumulator loop driven by performance.now(). setTimeout jitters by a few
  // ms, but the accumulator keeps the long-run rate exact, which a bare
  // setInterval doesn't.
  function loop() {
    const now = performance.now();
    acc += now - last;
    last = now;
    if (acc > TICK_MS * MAX_CATCHUP_TICKS) acc = TICK_MS * MAX_CATCHUP_TICKS;
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      game.tick++;
      for (const fn of game.onTick) fn(game.tick);
    }
    schedule();
  }

  function schedule() {
    if (!game.running) return;
    timer = setTimeout(loop, Math.max(0, TICK_MS - acc));
  }

  return game;
}
