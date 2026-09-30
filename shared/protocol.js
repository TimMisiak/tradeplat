// Wire protocol shared by client and server. See ARCHITECTURE.md § Netcode.
// Messages are JSON text frames shaped {t: <type>, ...fields}. Keep every
// encode/decode behind this module so a later switch to binary frames for hot
// messages doesn't touch game code.
import { ANIMS, animFor } from './physics.js';

export const PROTOCOL_VERSION = 2;

/** Server ticks between snapshots (60 Hz / 3 = 20 Hz). */
export const SNAPSHOT_EVERY = 3;
/** Most input ticks one `input` message may carry. */
export const MAX_INPUT_BATCH = 8;
/** Interest chunks are this many tiles square (ARCHITECTURE.md § Interest management). */
export const CHUNK_TILES = 32;

/** Path the WebSocket server listens on. */
export const WS_PATH = '/ws';

/** Message types. Client → server and server → client share one namespace. */
export const MSG = Object.freeze({
  // client → server
  HELLO: 'hello', // {name, protocol}
  PING: 'ping', // {c: clientTimeMs}
  INPUT: 'input', // {seq, tick, bits: number[]}: input for ticks seq, seq+1, …; tick = client's estimate of server tick
  // server → client
  WELCOME: 'welcome', // {playerId, name, protocol, serverTick, tickRate, tuningHash, world: {seed, genVersion, hash},
  //                      you: PlayerState, ack, players: [[id, name]]}
  PONG: 'pong', // {c: echoed clientTimeMs, s: serverTick (fractional)}
  SNAPSHOT: 'snap', // {tick, ack, you: PlayerState, g: Ghost[]} (see packGhost)
  JOINED: 'joined', // {id, name}
  LEFT: 'left', // {id}
  ERROR: 'error', // {reason}
});

/** @param {string} t @param {object} [fields] */
export function encode(t, fields = {}) {
  return JSON.stringify({ t, ...fields });
}

/**
 * Parse a frame. Returns null (never throws) for anything that isn't a JSON
 * object carrying a string `t`, so callers can drop bad input.
 * @param {string} data
 */
export function decode(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
    return null;
  }
  return msg;
}

/**
 * A ghost on the wire: [id, x, y, facing, anim]. x/y are the hitbox top-left,
 * rounded to 0.1 px (ghosts are only drawn). facing is the drawn facing (the wall
 * side while wall sliding). anim is an index into ANIMS.
 * @param {number} id @param {import('./physics.js').PlayerState} p
 */
export function packGhost(id, p) {
  const anim = animFor(p);
  const facing = anim === 'wallSlide' ? p.wallDir : p.facing;
  return [id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, facing, ANIMS.indexOf(anim)];
}

/** @param {any[]} g @returns {{id: number, x: number, y: number, facing: number, anim: number}} */
export function unpackGhost(g) {
  return { id: g[0], x: g[1], y: g[2], facing: g[3], anim: g[4] };
}
