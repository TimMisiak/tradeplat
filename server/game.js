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
//
// Each input tick carries the server tick the client stamped it with. Enemies are
// checked at that tick (clamped to LAG_WINDOW of server time), which is the
// client's view of them, so a hit the client saw is a hit here (lag compensation;
// safe because enemy motion is deterministic). Deaths clear the cargo, and stomps
// record kills; both are reported through onEvent (ARCHITECTURE.md § Deaths, trades and events).
import { performance } from 'node:perf_hooks';
import { randomInt } from 'node:crypto';
import { INPUT_MASK, TICK_RATE } from '../shared/physics.js';
import { ENEMY } from '../shared/enemies.js';
import { createSim, spawnPlayer, stepPlayer } from '../shared/sim.js';
import { generateWorld } from '../shared/worldgen.js';
import { applyTrade, checkTrade, createWallet, dropCargo, postAt } from '../shared/trade.js';
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
/** An input's enemy tick may be at most this far from server time (±250 ms). */
export const LAG_WINDOW = 15;
/** Kills older than this can't matter to any input any more, and are pruned. */
const KILL_MEMORY = ENEMY.respawnTicks + ENEMY.graceTicks + 4 * LAG_WINDOW;

/**
 * @typedef {{
 *   version: 1, id: number, name: string,
 *   state: import('../shared/physics.js').PlayerState,
 *   seq: number, bits: number, queue: {bits: number, tick: number | null}[], credit: number, started: boolean, stalled: boolean, resync: boolean,
 *   wallet: import('../shared/trade.js').Wallet, post: number, deaths: number,
 * }} Player
 * state: shared/sim.js player state (physics plus dead and home).
 * post: id of the post whose zone the player is in (-1 if none), updated every tick.
 * seq: last input tick applied (the snapshot's ackSeq). bits: its input.
 * stalled: filler steps ran since the last real input. resync: reset the credit next tick.
 * queue: input for seq+1, seq+2, … that arrived before there was credit for it, with
 *   the tick the client stamped it with (null for a gap the server filled in).
 *
 * @typedef {{type: 'died', cause: string, tick: number, lost: Record<string, number>}
 *   | {type: 'killed', id: number, tick: number}} GameEvent
 * died: the player died at tick and lost that cargo. killed: the player stomped enemy `id`.
 */

/** @param {{seed?: number}} [opts] seed defaults to a random 32-bit value */
export function createGame({ seed = randomInt(0, 2 ** 32) } = {}) {
  const t0 = performance.now();
  const world = generateWorld(seed);
  const genMs = performance.now() - t0;
  const sim = createSim(world, world.posts[world.spawnPost].spawn);
  const spawn = spawnPlayer(sim, world.spawnPost);

  const game = {
    world,
    genMs,
    sim,
    spawn,
    market: createMarket(world.seed, world.posts),
    /** Enemy state: spawner id → kill tick (shared/enemies.js enemyPhase). Plain data. */
    enemies: { version: 1, kills: /** @type {Record<number, number>} */ ({}) },
    tick: 0,
    running: false,
    /** @type {Map<number, Player>} */
    players: new Map(),
    /** @type {((tick: number) => void)[]} */
    onTick: [],
    /** Called as things happen while stepping players. @type {((p: Player, e: GameEvent) => void)[]} */
    onEvent: [],
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
      wallet: createWallet(), post: postIdAt(spawn), deaths: 0,
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
    if (p.state.dead) return { ok: false, reason: 'dead' };
    const here = postIdAt(p.state);
    const q = here >= 0 && here === order.postId ? quote(game.market, here) : null;
    const reason = checkTrade(p.wallet, order, q);
    if (reason) return { ok: false, reason };
    const { wallet, price } = applyTrade(p.wallet, order, q);
    p.wallet = wallet;
    return { ok: true, price };
  }

  /** One tick of a player at enemy tick `tick` (null: now), and what came of it. */
  function simulate(p, bits, tick) {
    const t = tick === null ? game.tick : Math.max(game.tick - LAG_WINDOW, Math.min(game.tick + LAG_WINDOW, tick));
    const events = [];
    p.state = stepPlayer(p.state, bits, t, sim, game.enemies.kills, events);
    for (const e of events) {
      if (e.type === 'stomp') {
        // The step saw it alive at t: never killed, killed long enough ago to be back,
        // or killed at t or later (by an input stamped later but applied first).
        // Either way it's dead from t on.
        game.enemies.kills[e.id] = t;
        for (const fn of game.onEvent) fn(p, { type: 'killed', id: e.id, tick: t });
      } else if (e.type === 'died') {
        const lost = p.wallet.cargo;
        p.wallet = dropCargo(p.wallet);
        p.deaths++;
        for (const fn of game.onEvent) fn(p, { type: 'died', cause: e.cause, tick: t, lost });
      }
    }
  }

  function apply(p, { bits, tick }) {
    simulate(p, bits, tick);
    p.seq++;
    p.bits = bits;
  }

  function applyFiller(p) {
    simulate(p, 0, null);
    p.stalled = true;
  }

  function drain(p) {
    while (p.credit > 0 && p.queue.length > 0) {
      apply(p, p.queue.shift());
      p.credit--;
    }
  }

  /**
   * Input for ticks seq, seq+1, …, stamped with enemy ticks tick, tick+1, ….
   * Ticks already received are skipped. A gap (only a misbehaving client makes
   * one) repeats the last input. Anything past the queue limit is dropped, and
   * the snapshot corrects the client. A missing tick means "now".
   * @returns {boolean} false if the message was malformed
   */
  function receiveInput(p, seq, bits, tick) {
    if (!Number.isInteger(seq) || seq < 1 || !Array.isArray(bits) || bits.length === 0) return false;
    if (!bits.every((b) => Number.isInteger(b) && b >= 0 && b <= INPUT_MASK)) return false;
    if (!Number.isInteger(tick)) tick = null;
    let recv = p.seq + p.queue.length;
    if (seq > recv + MAX_QUEUE) return true;
    const had = p.queue.length;
    for (let i = 0; i < bits.length; i++) {
      const s = seq + i;
      while (recv < s && p.queue.length < MAX_QUEUE) {
        p.queue.push(recv + 1 === s ? { bits: bits[i], tick: tick === null ? null : tick + i } : { bits: p.queue.at(-1)?.bits ?? p.bits, tick: null });
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
    if (game.tick % TICK_RATE === 0) {
      const kills = game.enemies.kills;
      for (const id in kills) if (game.tick - kills[id] > KILL_MEMORY) delete kills[id];
    }
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
