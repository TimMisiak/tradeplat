// World instance and fixed-tick loop. See ARCHITECTURE.md § Simulation.
// M0: only the tick clock. The world, players and market plug in here later.
import { performance } from 'node:perf_hooks';
import { TICK_RATE } from '../shared/physics.js';

export { TICK_RATE };
const TICK_MS = 1000 / TICK_RATE;
/** Longest catch-up after a stall (e.g. debugger pause) before we drop time instead. */
const MAX_CATCHUP_TICKS = 30;

export function createGame() {
  const game = {
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
