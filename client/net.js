// WebSocket client, clock sync, prediction/reconciliation and ghost buffers.
// See ARCHITECTURE.md § Netcode. createPredictor and createGhosts touch no DOM or
// network, so Node tests drive them directly.
import { MAX_INPUT_BATCH, MSG, PROTOCOL_VERSION, WS_PATH, decode, encode, unpackGhost } from '../shared/protocol.js';
import { TICK_RATE, TUNING, sameState, stepInput } from '../shared/physics.js';

const PING_INTERVAL_MS = 1000;
const RECONNECT_MS = 2000;
const TICK_MS = 1000 / TICK_RATE;
/** Ghosts are drawn this far behind the estimated server time (100 ms, two snapshots). */
export const INTERP_TICKS = 6;
/** A clock sample this far off the estimate means the server restarted or we slept: take it as is. */
const CLOCK_RESET_TICKS = 30;
/** Unacknowledged ticks kept for replay (10 s). */
const MAX_PENDING = 600;

/**
 * @param {{name: string}} opts
 */
export function createNet({ name }) {
  const net = {
    /** 'connecting' | 'connected' | 'disconnected' */
    status: 'connecting',
    playerId: 0,
    /** Smoothed round-trip time in ms (0 until the first pong arrives). */
    rtt: 0,
    /** Set when the server rejects us for good (e.g. a protocol mismatch). Stops reconnecting. */
    fatal: '',
    /** From the last welcome: {seed, genVersion, hash}. */
    world: null,
    /** id → display name of the other players. */
    names: new Map(),
    /** Called with each welcome message (including after a reconnect). */
    onWelcome: [],
    /** Called with each snapshot. */
    onSnapshot: [],
    /** Called with each prices message ({postId, tick, goods}). */
    onPrices: [],
    /** Called with each trade result. */
    onTradeResult: [],
    /** Our money and cargo, as the server last reported them. Never changed locally. */
    wallet: null,
    /** Latest leaderboard rows [[id, name, netWorth]], best first. */
    board: [],
    /** Estimated server time, in fractional ticks, at performance.now() = `now`. */
    serverTick: (now = performance.now()) => now / TICK_MS + offset,
    /** Send input for ticks seq, seq+1, …. */
    sendInput(seq, bits) {
      if (ws?.readyState !== WebSocket.OPEN || net.status !== 'connected') return;
      for (let i = 0; i < bits.length; i += MAX_INPUT_BATCH) {
        ws.send(encode(MSG.INPUT, { seq: seq + i, tick: Math.round(net.serverTick() + lead()), bits: bits.slice(i, i + MAX_INPUT_BATCH) }));
      }
    },
    /**
     * Ask the server for a trade. Returns its reqId, or 0 if not connected.
     * @param {{postId: number, goodId: string, qty: number, side: 'buy'|'sell'}} order
     */
    sendTrade(order) {
      if (ws?.readyState !== WebSocket.OPEN || net.status !== 'connected') return 0;
      const reqId = ++lastReqId;
      ws.send(encode(MSG.TRADE, { reqId, ...order }));
      return reqId;
    },
  };

  let ws = null;
  let pingTimer = null;
  let lastReqId = 0;
  /** server tick − performance.now() in ticks. */
  let offset = 0;
  let synced = false;
  /** How far ahead of the server our inputs are stamped: half the RTT plus a small buffer. */
  const lead = () => net.rtt / 2 / TICK_MS + 2;

  function clockSample(serverTick, now, rttMs) {
    const sample = serverTick + rttMs / 2 / TICK_MS - now / TICK_MS;
    if (!synced || Math.abs(sample - offset) > CLOCK_RESET_TICKS) offset = sample;
    else offset += (sample - offset) * 0.1;
    synced = true;
  }

  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
    net.status = 'connecting';
    const sentAt = performance.now();
    ws = new WebSocket(url);

    ws.onopen = () => ws.send(encode(MSG.HELLO, { name, protocol: PROTOCOL_VERSION }));

    ws.onmessage = (ev) => {
      const msg = decode(ev.data);
      if (!msg) return;
      switch (msg.t) {
        case MSG.WELCOME:
          net.status = 'connected';
          net.playerId = msg.playerId;
          net.world = msg.world;
          net.names = new Map(msg.players);
          net.wallet = msg.wallet;
          synced = false;
          // Rough until the first pong: the connect round trip is about two RTTs.
          clockSample(msg.serverTick, performance.now(), (performance.now() - sentAt) / 2);
          console.info(`[net] welcome: player ${msg.playerId} "${msg.name}", tick ${msg.serverTick.toFixed(1)} @ ${msg.tickRate} Hz, world seed ${msg.world?.seed}`);
          for (const fn of net.onWelcome) fn(msg);
          ping();
          pingTimer = setInterval(ping, PING_INTERVAL_MS);
          break;
        case MSG.PONG: {
          const now = performance.now();
          const sample = now - msg.c;
          net.rtt = net.rtt === 0 ? sample : net.rtt * 0.8 + sample * 0.2;
          clockSample(msg.s, now, sample);
          break;
        }
        case MSG.SNAPSHOT:
          for (const fn of net.onSnapshot) fn(msg);
          break;
        case MSG.PRICES:
          for (const fn of net.onPrices) fn(msg);
          break;
        case MSG.TRADE_RESULT:
          net.wallet = msg.wallet;
          for (const fn of net.onTradeResult) fn(msg);
          break;
        case MSG.LEADERBOARD:
          net.board = msg.rows;
          break;
        case MSG.JOINED:
          net.names.set(msg.id, msg.name);
          break;
        case MSG.LEFT:
          net.names.delete(msg.id);
          break;
        case MSG.ERROR:
          net.fatal = msg.reason;
          console.error(`[net] server error: ${msg.reason}`);
          break;
      }
    };

    ws.onclose = () => {
      clearInterval(pingTimer);
      net.status = 'disconnected';
      if (!net.fatal) setTimeout(connect, RECONNECT_MS);
    };
  }

  function ping() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(encode(MSG.PING, { c: performance.now() }));
  }

  connect();
  return net;
}

/**
 * Client-side prediction of the local player (ARCHITECTURE.md § Own player).
 * Every tick is applied locally at once and kept, with its input, until the server
 * acknowledges it. A snapshot's state is compared with what we predicted for the
 * same input tick. Equal (the normal case) means nothing to do. Different means a
 * misprediction: take the server's state, replay the unacknowledged inputs on top,
 * and hand the visual jump to `err` to ease out.
 * @param {import('../shared/tiles.js').TileMap} map
 * @param {import('../shared/physics.js').PlayerState} spawn
 */
export function createPredictor(map, spawn, tuning = TUNING) {
  const pred = {
    /** Last two predicted states, for render interpolation. */
    prev: spawn,
    cur: spawn,
    /** Input tick of `cur`. */
    seq: 0,
    /** @type {{seq: number, bits: number, state: import('../shared/physics.js').PlayerState}[]} */
    pending: [],
    lastAck: 0,
    /** Snapshots that disagreed with the prediction (the determinism health metric). */
    mismatches: 0,
    /** Render offset (px) left over from corrections. Decays in decay(). */
    err: { x: 0, y: 0 },
    reset,
    advance,
    reconcile,
    decay,
  };

  function reset(state, ack) {
    pred.prev = pred.cur = state;
    pred.seq = pred.lastAck = ack;
    pred.pending = [];
    pred.err = { x: 0, y: 0 };
  }

  /** Predict one tick. Returns its input tick (seq) for sending. */
  function advance(bits) {
    pred.prev = pred.cur;
    pred.cur = stepInput(pred.cur, bits, map, spawn, tuning);
    pred.seq++;
    pred.pending.push({ seq: pred.seq, bits, state: pred.cur });
    // Nothing acknowledges input while disconnected or with edited tuning.
    if (pred.pending.length > MAX_PENDING) pred.pending.shift();
    return pred.seq;
  }

  /** @returns {boolean} whether the snapshot corrected the prediction */
  function reconcile(ack, state) {
    if (ack <= pred.lastAck) return false;
    pred.lastAck = ack;
    const i = pred.pending.findIndex((e) => e.seq >= ack);
    if (i >= 0 && pred.pending[i].seq === ack && sameState(pred.pending[i].state, state)) {
      pred.pending.splice(0, i + 1);
      return false;
    }
    pred.mismatches++;
    const old = pred.cur;
    if (ack >= pred.seq) {
      // Nothing of ours left to replay. (An ack past our seq shouldn't happen. If
      // it does, our inputs up to ack will be dropped, so continue from there.)
      pred.pending = [];
      pred.seq = ack;
      pred.prev = pred.cur = state;
    } else {
      pred.pending = pred.pending.filter((e) => e.seq > ack);
      let s = state;
      let before = state;
      for (const e of pred.pending) {
        before = s;
        s = e.state = stepInput(s, e.bits, map, spawn, tuning);
      }
      pred.cur = s;
      // Keep the interpolation span the same length. err covers the jump.
      pred.prev = pred.pending.length ? before : state;
    }
    const dx = old.x - pred.cur.x, dy = old.y - pred.cur.y;
    // Small corrections ease out; a teleport-sized one (respawn) just snaps.
    if (dx * dx + dy * dy < 64 * 64) { pred.err.x += dx; pred.err.y += dy; }
    else pred.err = { x: 0, y: 0 };
    return true;
  }

  /** Ease the correction offset out. dt in seconds. */
  function decay(dt) {
    const k = Math.exp(-15 * dt);
    pred.err.x = Math.abs(pred.err.x * k) < 0.05 ? 0 : pred.err.x * k;
    pred.err.y = Math.abs(pred.err.y * k) < 0.05 ? 0 : pred.err.y * k;
  }

  return pred;
}

/**
 * Snapshot buffers for other players, drawn INTERP_TICKS behind server time by
 * interpolating between the snapshots on either side (ARCHITECTURE.md § Ghosts).
 */
export function createGhosts() {
  /** @type {Map<number, {samples: {tick: number, x: number, y: number, facing: number, anim: number}[], lastTick: number}>} */
  const ghosts = new Map();
  let latest = 0;

  /** Add one snapshot's ghost list. */
  function add(tick, list) {
    if (tick <= latest) return;
    latest = tick;
    for (const g of list) {
      const { id, ...sample } = unpackGhost(g);
      let e = ghosts.get(id);
      if (!e) ghosts.set(id, (e = { samples: [], lastTick: 0 }));
      e.samples.push({ tick, ...sample });
      e.lastTick = tick;
      if (e.samples.length > 32) e.samples.shift();
    }
  }

  /**
   * Ghost poses at renderTick. A ghost missing from the latest snapshot (left, or
   * out of the interest set) is kept until its last sample has been drawn.
   * @returns {{id: number, x: number, y: number, facing: number, anim: number}[]}
   */
  function sample(renderTick) {
    const out = [];
    for (const [id, e] of ghosts) {
      if (e.lastTick < latest && renderTick >= e.lastTick) { ghosts.delete(id); continue; }
      const s = e.samples;
      while (s.length > 2 && s[1].tick <= renderTick) s.shift();
      const a = s[0];
      const b = s[1];
      if (!b || renderTick <= a.tick) { out.push({ id, ...a }); continue; }
      const t = Math.min(1, (renderTick - a.tick) / (b.tick - a.tick));
      // Snapshots skipped (out of interest for a while) or a teleport: don't slide across.
      const jump = b.tick - a.tick > 30 || Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > 64;
      if (jump) { out.push({ id, ...(t < 1 ? a : b) }); continue; }
      out.push({ id, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, facing: t < 0.5 ? a.facing : b.facing, anim: t < 0.5 ? a.anim : b.anim });
    }
    return out;
  }

  return { add, sample, clear: () => { ghosts.clear(); latest = 0; }, get size() { return ghosts.size; } };
}
