// WebSocket connection lifecycle and message dispatch. See ARCHITECTURE.md § Netcode.
import { WebSocketServer } from 'ws';
import { CHUNK_TILES, LEADERBOARD_EVERY, MAX_INPUT_BATCH, MSG, PROTOCOL_VERSION, SNAPSHOT_EVERY, WS_PATH, decode, encode, packGhost } from '../shared/protocol.js';
import { TUNING, tuningHash } from '../shared/physics.js';
import { TILE_SIZE } from '../shared/tiles.js';
import { TICK_RATE } from './game.js';
import { MARKET_TICKS, cargoValues, netWorth, packQuote, quote } from './market.js';

const MAX_NAME_LEN = 16;
const MAX_FRAME_BYTES = 4096;

/**
 * Attach the game's WebSocket endpoint to an http server.
 * @param {import('node:http').Server} httpServer
 * @param {ReturnType<import('./game.js').createGame>} game
 */
export function attachNet(httpServer, game) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** Open sockets of players who have said hello. */
  const sockets = new Map();
  const TUNING_HASH = tuningHash(TUNING);
  /** Player id → the post whose prices it was last sent (-1: none since it left a zone). */
  const pricedAt = new Map();

  function broadcast(frame) {
    for (const ws of sockets.values()) ws.send(frame);
  }

  game.onTick.push((tick) => {
    if (sockets.size === 0) return;
    if (tick % SNAPSHOT_EVERY === 0) {
      for (const [id, frame] of snapshotFrames(game, tick, sockets)) sockets.get(id).send(frame);
    }
    // Prices go only to players standing in a post's zone (DESIGN.md § Information):
    // when they walk in, and after every market tick while they stay.
    const marketTicked = tick % MARKET_TICKS === 0;
    for (const [id, ws] of sockets) {
      const p = game.players.get(id);
      if (!p || (p.post === pricedAt.get(id) && !marketTicked)) continue;
      pricedAt.set(id, p.post);
      if (p.post >= 0) ws.send(pricesFrame(game, p.post));
    }
    if (tick % LEADERBOARD_EVERY === 0) broadcast(leaderboardFrame(game));
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    /** @type {import('./game.js').Player | null} */
    let player = null;
    ws.on('close', () => {
      if (!player) return;
      sockets.delete(player.id);
      pricedAt.delete(player.id);
      game.removePlayer(player.id);
      broadcast(encode(MSG.LEFT, { id: player.id }));
    });

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
          player = game.addPlayer(cleanName(msg.name));
          ws.send(encode(MSG.WELCOME, {
            playerId: player.id,
            name: player.name,
            protocol: PROTOCOL_VERSION,
            serverTick: game.now(),
            tickRate: TICK_RATE,
            // The client regenerates the world from this and checks both hashes (WORLDGEN.md § Determinism).
            tuningHash: TUNING_HASH,
            world: { seed: game.world.seed, genVersion: game.world.version, hash: game.world.hash },
            you: player.state,
            ack: player.seq,
            players: [...game.players.values()].filter((p) => p !== player).map((p) => [p.id, p.name]),
            wallet: player.wallet,
          }));
          broadcast(encode(MSG.JOINED, { id: player.id, name: player.name }));
          sockets.set(player.id, ws);
          ws.send(leaderboardFrame(game));
          break;
        }
        case MSG.PING:
          if (typeof msg.c === 'number') ws.send(encode(MSG.PONG, { c: msg.c, s: game.now() }));
          break;
        case MSG.INPUT:
          // `tick` is for lag-compensated enemy checks (M5). Movement only needs seq.
          if (!player || !Array.isArray(msg.bits) || msg.bits.length > MAX_INPUT_BATCH) return;
          game.receiveInput(player, msg.seq, msg.bits);
          break;
        case MSG.TRADE: {
          if (!player || !Number.isInteger(msg.reqId)) return;
          const res = Number.isInteger(msg.postId) && typeof msg.goodId === 'string'
            ? game.trade(player, { postId: msg.postId, goodId: msg.goodId, qty: msg.qty, side: msg.side })
            : { ok: false, reason: 'malformed' };
          ws.send(encode(MSG.TRADE_RESULT, { reqId: msg.reqId, ...res, wallet: player.wallet }));
          break;
        }
      }
    });
  });

  return wss;
}

/**
 * One snapshot frame per connected player: its own state and ack, plus ghosts
 * in its 3×3 interest chunks.
 * @param {ReturnType<import('./game.js').createGame>} game
 * @param {{has(id: number): boolean}} connected
 * @returns {[number, string][]} [playerId, frame]
 */
export function snapshotFrames(game, tick, connected) {
  const players = [...game.players.values()];
  const chunks = players.map((p) => chunkOf(p.state));
  const out = [];
  players.forEach((p, i) => {
    if (!connected.has(p.id)) return;
    const g = [];
    players.forEach((o, j) => {
      if (j !== i && near(chunks[i], chunks[j])) g.push(packGhost(o.id, o.state));
    });
    out.push([p.id, encode(MSG.SNAPSHOT, { tick, ack: p.seq, you: p.state, g })]);
  });
  return out;
}

/** The prices message for one post. */
export function pricesFrame(game, postId) {
  return encode(MSG.PRICES, { postId, tick: game.market.tick, goods: packQuote(quote(game.market, postId)) });
}

/** Every player's net worth, best first (ECONOMY.md § Net worth). */
export function leaderboardFrame(game) {
  const values = cargoValues(game.market);
  const rows = [...game.players.values()].map((p) => [p.id, p.name, netWorth(p.wallet, values)]);
  rows.sort((a, b) => b[2] - a[2] || a[0] - b[0]);
  return encode(MSG.LEADERBOARD, { rows });
}

/** Interest chunk of a player's centre. */
export function chunkOf(p) {
  const size = CHUNK_TILES * TILE_SIZE;
  return [Math.floor((p.x + TUNING.width / 2) / size), Math.floor((p.y + TUNING.height / 2) / size)];
}

/** Whether two chunks are within one chunk of each other (the 3×3 interest set). */
export function near(a, b) {
  return Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;
}

/** Display names: trimmed printable text, capped length, never empty. */
export function cleanName(name) {
  const s = typeof name === 'string'
    ? name.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, MAX_NAME_LEN)
    : '';
  return s || 'Trader';
}
