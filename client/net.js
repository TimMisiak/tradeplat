// WebSocket client. See ARCHITECTURE.md § Netcode.
// M0: connect, send hello, get welcome, and measure round-trip time with pings.
// Clock sync, prediction and ghosts arrive in M3.
import { MSG, PROTOCOL_VERSION, WS_PATH, decode, encode } from '../shared/protocol.js';

const PING_INTERVAL_MS = 2000;
const RECONNECT_MS = 2000;

/**
 * @param {{name: string}} opts
 */
export function createNet({ name }) {
  const net = {
    /** 'connecting' | 'connected' | 'disconnected' */
    status: 'connecting',
    playerId: 0,
    serverTick: 0,
    /** Smoothed round-trip time in ms (0 until the first pong arrives). */
    rtt: 0,
    /** Set when the server rejects us for good (e.g. a protocol mismatch). Stops reconnecting. */
    fatal: '',
    /** From the last welcome: {seed, genVersion, hash}. */
    world: null,
    /** Called with each welcome message (including after a reconnect). */
    onWelcome: [],
  };

  let ws = null;
  let pingTimer = null;

  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
    net.status = 'connecting';
    ws = new WebSocket(url);

    ws.onopen = () => ws.send(encode(MSG.HELLO, { name, protocol: PROTOCOL_VERSION }));

    ws.onmessage = (ev) => {
      const msg = decode(ev.data);
      if (!msg) return;
      switch (msg.t) {
        case MSG.WELCOME:
          net.status = 'connected';
          net.playerId = msg.playerId;
          net.serverTick = msg.serverTick;
          net.world = msg.world;
          console.info(`[net] welcome: player ${msg.playerId} "${msg.name}", tick ${msg.serverTick} @ ${msg.tickRate} Hz, world seed ${msg.world?.seed}`);
          for (const fn of net.onWelcome) fn(msg);
          ping();
          pingTimer = setInterval(ping, PING_INTERVAL_MS);
          break;
        case MSG.PONG: {
          const sample = performance.now() - msg.c;
          net.rtt = net.rtt === 0 ? sample : net.rtt * 0.8 + sample * 0.2;
          net.serverTick = msg.s;
          break;
        }
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
