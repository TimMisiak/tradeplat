// World instance, fixed-tick loop and player registry. See ARCHITECTURE.md § Simulation and § Netcode.
// The world is generated from a seed on start (WORLDGEN.md). Clients get only
// {seed, genVersion, hash} and regenerate it themselves. The market (market.js)
// is seeded from the same seed and ticks every MARKET_TICKS. Trades are checked
// against the server's own position and wallet (ECONOMY.md, shared/trade.js).
//
// Players are stepped independently, as their inputs arrive (ghosts don't interact).
// Each server tick gives a player one tick of credit. An input tick runs only when
// there is credit, so a client can't move faster than real time (speed-hack guard).
// Input that arrives early waits in a short queue. A player whose credit piles up
// past MAX_CREDIT (stalled or stopped sending) is stepped with no input instead.
// Those filler steps take no input seq: the client's inputs still apply in order,
// and it replays them on top of the server state it gets back. When real input
// resumes, the catch-up burst the client sends (it simulates up to MAX_FRAME_S of
// the stall) runs on the credit left over, and the next tick resets the credit.
// Otherwise a client that lost time (background tab) stays pinned at the limit,
// where any jitter forces more filler, or its burst sits in the queue for good.
import { performance } from 'node:perf_hooks';
import { randomInt } from 'node:crypto';
import { INPUT_MASK, TICK_RATE, spawnAt, stepInput } from '../shared/physics.js';
import { generateWorld } from '../shared/worldgen.js';
import { applyTrade, checkTrade, createWallet, postAt } from '../shared/trade.js';
import { MARKET_TICKS, createMarket, quote, tickMarket } from './market.js';

export { TICK_RATE };
const TICK_MS = 1000 / TICK_RATE;
/** Longest catch-up after a stall (e.g. debugger pause) before we drop time instead. */
const MAX_CATCHUP_TICKS = 30;
/** Ticks a player may fall behind real time before the server steps them with no input (500 ms). */
export const MAX_CREDIT = 30;
/** Input ticks a player may send ahead of real time. Any more are dropped. */
export const MAX_QUEUE = 30;
/** Credit a player starts with on its first input, to absorb a little jitter. */
const START_CREDIT = 2;

/**
 * @typedef {{
 *   version: 1, id: number, name: string,
 *   state: import('../shared/physics.js').PlayerState,
 *   seq: number, bits: number, queue: number[], credit: number, started: boolean, stalled: boolean, resync: boolean,
 *   wallet: import('../shared/trade.js').Wallet, post: number,
 * }} Player
 * post: id of the post whose zone the player is in (-1 if none), updated every tick.
 * seq: last input tick applied (the snapshot's ackSeq). bits: its input.
 * stalled: filler steps ran since the last real input. resync: reset the credit next tick.
 * queue: input bits for seq+1, seq+2, … that arrived before there was credit for them.
 */

/** @param {{seed?: number}} [opts] seed defaults to a random 32-bit value */
export function createGame({ seed = randomInt(0, 2 ** 32) } = {}) {
  const t0 = performance.now();
  const world = generateWorld(seed);
  const genMs = performance.now() - t0;
  const spawnTile = world.posts[world.spawnPost].spawn;
  const spawn = spawnAt(spawnTile.tx, spawnTile.ty);

  const game = {
    world,
    genMs,
    spawn,
    market: createMarket(world.seed, world.posts),
    tick: 0,
    running: false,
    /** @type {Map<number, Player>} */
    players: new Map(),
    /** @type {((tick: number) => void)[]} */
    onTick: [],
    start,
    stop,
    now,
    addPlayer,
    removePlayer,
    receiveInput,
    advance,
    trade,
  };

  let nextPlayerId = 1;
  let last = 0;
  let acc = 0;
  let timer = null;

  /** @returns {Player} */
  function addPlayer(name) {
    const p = {
      version: 1, id: nextPlayerId++, name, state: spawn, seq: 0, bits: 0, queue: [], credit: 0, started: false, stalled: false, resync: false,
      wallet: createWallet(), post: postIdAt(spawn),
    };
    game.players.set(p.id, p);
    return p;
  }

  function removePlayer(id) {
    game.players.delete(id);
  }

  function postIdAt(state) {
    return postAt(world.posts, state)?.id ?? -1;
  }

  /**
   * Buy or sell at a post, if the player is standing in its zone right now (by the
   * server's position) and the wallet allows it.
   * @param {Player} p
   * @param {{postId: number, goodId: string, qty: number, side: string}} order
   * @returns {{ok: boolean, reason?: string, price?: number}}
   */
  function trade(p, order) {
    const here = postIdAt(p.state);
    const q = here >= 0 && here === order.postId ? quote(game.market, here) : null;
    const reason = checkTrade(p.wallet, order, q);
    if (reason) return { ok: false, reason };
    const { wallet, price } = applyTrade(p.wallet, order, q);
    p.wallet = wallet;
    return { ok: true, price };
  }

  function apply(p, bits) {
    p.state = stepInput(p.state, bits, world, spawn);
    p.seq++;
    p.bits = bits;
  }

  function applyFiller(p) {
    p.state = stepInput(p.state, 0, world, spawn);
    p.stalled = true;
  }

  function drain(p) {
    while (p.credit > 0 && p.queue.length > 0) {
      apply(p, p.queue.shift());
      p.credit--;
    }
  }

  /**
   * Input for ticks seq, seq+1, …. Ticks already received are skipped. A gap
   * (only a misbehaving client makes one) repeats the last input. Anything past
   * the queue limit is dropped, and the snapshot corrects the client.
   * @returns {boolean} false if the message was malformed
   */
  function receiveInput(p, seq, bits) {
    if (!Number.isInteger(seq) || seq < 1 || !Array.isArray(bits) || bits.length === 0) return false;
    if (!bits.every((b) => Number.isInteger(b) && b >= 0 && b <= INPUT_MASK)) return false;
    let recv = p.seq + p.queue.length;
    if (seq > recv + MAX_QUEUE) return true;
    const had = p.queue.length;
    for (let i = 0; i < bits.length; i++) {
      const s = seq + i;
      while (recv < s && p.queue.length < MAX_QUEUE) {
        p.queue.push(recv + 1 === s ? bits[i] : p.queue.at(-1) ?? p.bits);
        recv++;
      }
    }
    if (!p.started) {
      p.started = true;
      p.credit = START_CREDIT;
    }
    if (p.stalled && p.queue.length > had) {
      p.stalled = false;
      p.resync = true;
    }
    drain(p);
    return true;
  }

  /** One server tick of player bookkeeping. Runs before the onTick hooks. */
  function advance() {
    game.tick++;
    if (game.tick % MARKET_TICKS === 0) tickMarket(game.market);
    for (const p of game.players.values()) {
      if (!p.started) continue;
      if (p.resync) {
        p.resync = false;
        p.credit = START_CREDIT;
      }
      p.credit++;
      drain(p);
      if (p.credit > MAX_CREDIT) {
        applyFiller(p);
        p.credit--;
      }
      p.post = postIdAt(p.state);
    }
    for (const fn of game.onTick) fn(game.tick);
  }

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

  /** Server time in fractional ticks, for clock sync. */
  function now() {
    return game.tick + (game.running ? Math.min(acc + performance.now() - last, TICK_MS) / TICK_MS : 0);
  }

  // Accumulator loop driven by performance.now(). setTimeout jitters by a few
  // ms, but the accumulator keeps the long-run rate exact, which a bare
  // setInterval doesn't.
  function loop() {
    const t = performance.now();
    acc += t - last;
    last = t;
    if (acc > TICK_MS * MAX_CATCHUP_TICKS) acc = TICK_MS * MAX_CATCHUP_TICKS;
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      advance();
    }
    schedule();
  }

  function schedule() {
    if (!game.running) return;
    timer = setTimeout(loop, Math.max(0, TICK_MS - acc));
  }

  return game;
}
