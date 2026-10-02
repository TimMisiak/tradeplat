import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.js';
import { cleanName } from '../server/net.js';
import { resolvePath } from '../server/static.js';
import { MSG, PROTOCOL_VERSION, WS_PATH, decode, encode } from '../shared/protocol.js';
import { INPUT, TUNING, tuningHash } from '../shared/physics.js';
import { stepPlayer } from '../shared/sim.js';
import { HOLD_CAPACITY, START_MONEY } from '../shared/trade.js';

let server;
let base;
before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.port}`;
});
after(() => server.close());

/** Raw GET that sends the path exactly as given (fetch would normalise `..`). */
function rawGet(path) {
  return new Promise((resolve, reject) => {
    request(`${base}${path}`, { path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject).end();
  });
}

test('serves the client index at /', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<canvas id="game">/);
});

test('serves shared modules as JavaScript', async () => {
  const res = await fetch(`${base}/shared/protocol.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/javascript/);
});

test('serves the asset manifest as JSON', async () => {
  const res = await fetch(`${base}/assets/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 1);
});

test('404 for missing files, 405 for non-GET', async () => {
  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

test('refuses to escape the served directories', async () => {
  assert.equal(resolvePath('/../package.json'), null);
  assert.equal(resolvePath('/shared/../server/main.js'), null);
  assert.equal(resolvePath('/%2e%2e/package.json'), null);
  assert.equal(resolvePath('/%00'), null);
  assert.equal(resolvePath('/%E0%A4%A'), null);
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/shared/%2e%2e/server/main.js']) {
    assert.ok([403, 404].includes(await rawGet(path)), path);
  }
});

function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = decode(data.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  /** Next message of type t (skipping others), optionally also matching `pred`. */
  const nextOf = async (t, pred = () => true) => {
    for (;;) {
      const msg = await next();
      if (msg.t === t && pred(msg)) return msg;
    }
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next, nextOf }));
    ws.once('error', reject);
  });
}

test('hello → welcome, ping → pong', async () => {
  const { ws, next, nextOf } = await openWs();
  ws.send(encode(MSG.HELLO, { name: '  Ada<script>  ', protocol: PROTOCOL_VERSION }));
  const welcome = await next();
  assert.equal(welcome.t, MSG.WELCOME);
  assert.equal(welcome.name, 'Adascript');
  assert.equal(welcome.tickRate, 60);
  assert.ok(Number.isInteger(welcome.playerId) && welcome.playerId > 0);

  ws.send(encode(MSG.PING, { c: 1234.5 }));
  const pong = await nextOf(MSG.PONG);
  assert.equal(pong.t, MSG.PONG);
  assert.equal(pong.c, 1234.5);
  assert.ok(pong.s >= welcome.serverTick);
  ws.close();
});

test('welcome carries the tuning hash and the starting player state', async () => {
  const { ws, next } = await openWs();
  ws.send(encode(MSG.HELLO, { name: 'Bo', protocol: PROTOCOL_VERSION }));
  const welcome = await next();
  assert.equal(welcome.tuningHash, tuningHash(TUNING));
  assert.deepEqual(welcome.you, server.game.spawn);
  assert.equal(welcome.ack, 0);
  ws.close();
});

test('inputs are acknowledged with the state a local replay predicts', async () => {
  const { ws, nextOf } = await openWs();
  ws.send(encode(MSG.HELLO, { name: 'Cy', protocol: PROTOCOL_VERSION }));
  const { you } = await nextOf(MSG.WELCOME);
  const bits = [...Array(8).fill(INPUT.RIGHT), ...Array(4).fill(INPUT.RIGHT | INPUT.JUMP)];
  const t0 = server.game.tick + 3;
  ws.send(encode(MSG.INPUT, { seq: 1, tick: t0, bits: bits.slice(0, 6) }));
  ws.send(encode(MSG.INPUT, { seq: 7, tick: t0 + 6, bits: bits.slice(6) }));
  const snap = await nextOf(MSG.SNAPSHOT, (m) => m.ack === bits.length);
  let s = you;
  bits.forEach((b, i) => { s = stepPlayer(s, b, t0 + i, server.game.sim, {}); });
  assert.deepEqual(snap.you, s);
  ws.close();
});

test('two players see each other as ghosts, with join and leave events', async () => {
  const a = await openWs();
  a.ws.send(encode(MSG.HELLO, { name: 'Ann', protocol: PROTOCOL_VERSION }));
  const wa = await a.nextOf(MSG.WELCOME);
  const b = await openWs();
  b.ws.send(encode(MSG.HELLO, { name: 'Ben', protocol: PROTOCOL_VERSION }));
  const wb = await b.nextOf(MSG.WELCOME);
  assert.ok(wb.players.some(([id, name]) => id === wa.playerId && name === 'Ann'));
  const joined = await a.nextOf(MSG.JOINED);
  assert.deepEqual([joined.id, joined.name], [wb.playerId, 'Ben']);

  // Both spawn at the same post, so each is in the other's interest set.
  const snap = await a.nextOf(MSG.SNAPSHOT, (m) => m.g.length > 0);
  const ghost = snap.g.find((g) => g[0] === wb.playerId);
  assert.ok(ghost, 'b is a ghost for a');
  assert.ok(!snap.g.some((g) => g[0] === wa.playerId), 'not our own ghost');

  b.ws.close();
  const left = await a.nextOf(MSG.LEFT);
  assert.equal(left.id, wb.playerId);
  a.ws.close();
});

test('at the spawn post: prices arrive, a trade goes through, the leaderboard counts it', async () => {
  const { ws, nextOf } = await openWs();
  ws.send(encode(MSG.HELLO, { name: 'Tia', protocol: PROTOCOL_VERSION }));
  const welcome = await nextOf(MSG.WELCOME);
  assert.deepEqual(welcome.wallet, { money: START_MONEY, cargo: {}, paid: {}, hold: HOLD_CAPACITY });
  const prices = await nextOf(MSG.PRICES);
  assert.equal(prices.postId, server.game.world.spawnPost);
  assert.ok(prices.goods.length >= 4);
  const [goodId, sell] = prices.goods[0];

  ws.send(encode(MSG.TRADE, { reqId: 1, postId: prices.postId, goodId, qty: 1, side: 'buy' }));
  const ok = await nextOf(MSG.TRADE_RESULT);
  assert.equal(ok.reqId, 1);
  assert.equal(ok.ok, true);
  assert.equal(ok.wallet.cargo[goodId], 1);
  assert.equal(ok.wallet.paid[goodId], ok.price);
  assert.equal(ok.wallet.money, START_MONEY - ok.price);
  assert.ok(Math.abs(ok.price - sell) / sell < 0.5, 'priced near the quote');

  ws.send(encode(MSG.TRADE, { reqId: 2, postId: prices.postId, goodId, qty: 99, side: 'sell' }));
  const refused = await nextOf(MSG.TRADE_RESULT);
  assert.deepEqual([refused.reqId, refused.ok, refused.reason], [2, false, 'not enough cargo']);
  ws.send(encode(MSG.TRADE, { reqId: 3, postId: 'x', goodId, qty: 1, side: 'buy' }));
  assert.equal((await nextOf(MSG.TRADE_RESULT)).reason, 'malformed');

  const board = await nextOf(MSG.LEADERBOARD, (m) => m.rows.some(([id]) => id === welcome.playerId));
  const row = board.rows.find(([id]) => id === welcome.playerId);
  assert.equal(row[1], 'Tia');
  assert.ok(row[2] > START_MONEY - ok.price, 'cargo counts toward net worth');
  ws.close();
});

test('dying (giving up) loses the cargo: died carries what was lost and the emptied wallet', async () => {
  const { ws, nextOf } = await openWs();
  ws.send(encode(MSG.HELLO, { name: 'Dee', protocol: PROTOCOL_VERSION }));
  const welcome = await nextOf(MSG.WELCOME);
  assert.deepEqual(welcome.kills, {});
  assert.deepEqual([welcome.you.dead, welcome.you.home], [0, server.game.world.spawnPost]);
  const prices = await nextOf(MSG.PRICES);
  const [goodId] = prices.goods[0];
  ws.send(encode(MSG.TRADE, { reqId: 1, postId: prices.postId, goodId, qty: 2, side: 'buy' }));
  const bought = await nextOf(MSG.TRADE_RESULT);
  assert.equal(bought.ok, true);
  ws.send(encode(MSG.INPUT, { seq: 1, tick: server.game.tick, bits: [INPUT.RESPAWN] }));
  const died = await nextOf(MSG.DIED);
  assert.equal(died.cause, 'gave up');
  assert.deepEqual(died.lost, { [goodId]: 2 });
  assert.deepEqual(died.wallet, { ...bought.wallet, cargo: {}, paid: {} });
  const snap = await nextOf(MSG.SNAPSHOT, (m) => m.ack === 1);
  assert.ok(snap.you.dead > 0);
  ws.close();
});

test('protocol mismatch gets an error and a close', async () => {
  const { ws, next } = await openWs();
  const closed = new Promise((r) => ws.once('close', r));
  ws.send(encode(MSG.HELLO, { name: 'x', protocol: PROTOCOL_VERSION + 1 }));
  assert.equal((await next()).t, MSG.ERROR);
  await closed;
});

test('cleanName', () => {
  assert.equal(cleanName(undefined), 'Trader');
  assert.equal(cleanName('   '), 'Trader');
  assert.equal(cleanName('a'.repeat(40)).length, 16);
  assert.equal(cleanName('Zoë_99'), 'Zoë_99');
});
