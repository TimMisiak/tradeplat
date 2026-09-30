// WebSocket connection lifecycle and message dispatch. See ARCHITECTURE.md § Netcode.
import { WebSocketServer } from 'ws';
import { MSG, PROTOCOL_VERSION, WS_PATH, decode, encode } from '../shared/protocol.js';
import { TICK_RATE } from './game.js';

const MAX_NAME_LEN = 16;
const MAX_FRAME_BYTES = 4096;

/**
 * Attach the game's WebSocket endpoint to an http server.
 * @param {import('node:http').Server} httpServer
 * @param {ReturnType<import('./game.js').createGame>} game
 */
export function attachNet(httpServer, game) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let nextPlayerId = 1;

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    /** @type {{id: number, name: string} | null} */
    let player = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = decode(data.toString());
      if (!msg) return;

      switch (msg.t) {
        case MSG.HELLO: {
          if (player) return;
          if (msg.protocol !== PROTOCOL_VERSION) {
            ws.send(encode(MSG.ERROR, { reason: `protocol mismatch: server ${PROTOCOL_VERSION}` }));
            ws.close();
            return;
          }
          player = { id: nextPlayerId++, name: cleanName(msg.name) };
          ws.send(encode(MSG.WELCOME, {
            playerId: player.id,
            name: player.name,
            protocol: PROTOCOL_VERSION,
            serverTick: game.tick,
            tickRate: TICK_RATE,
          }));
          break;
        }
        case MSG.PING:
          if (typeof msg.c === 'number') ws.send(encode(MSG.PONG, { c: msg.c, s: game.tick }));
          break;
      }
    });
  });

  return wss;
}

/** Display names: trimmed printable text, capped length, never empty. */
export function cleanName(name) {
  const s = typeof name === 'string'
    ? name.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, MAX_NAME_LEN)
    : '';
  return s || 'Trader';
}
