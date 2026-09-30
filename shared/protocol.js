// Wire protocol shared by client and server. See ARCHITECTURE.md § Netcode.
// Messages are JSON text frames shaped {t: <type>, ...fields}. Keep every
// encode/decode behind this module so a later switch to binary frames for hot
// messages doesn't touch game code.

export const PROTOCOL_VERSION = 1;

/** Path the WebSocket server listens on. */
export const WS_PATH = '/ws';

/** Message types. Client → server and server → client share one namespace. */
export const MSG = Object.freeze({
  // client → server
  HELLO: 'hello', // {name, protocol}
  PING: 'ping', // {c: clientTimeMs}
  // server → client
  WELCOME: 'welcome', // {playerId, name, protocol, serverTick, tickRate, world: {seed, genVersion, hash}}
  PONG: 'pong', // {c: echoed clientTimeMs, s: serverTick}
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
