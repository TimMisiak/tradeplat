import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.js';
import { cleanName } from '../server/net.js';
import { resolvePath } from '../server/static.js';
import { MSG, PROTOCOL_VERSION, WS_PATH, decode, encode } from '../shared/protocol.js';

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
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next }));
    ws.once('error', reject);
  });
}

test('hello → welcome, ping → pong', async () => {
  const { ws, next } = await openWs();
  ws.send(encode(MSG.HELLO, { name: '  Ada<script>  ', protocol: PROTOCOL_VERSION }));
  const welcome = await next();
  assert.equal(welcome.t, MSG.WELCOME);
  assert.equal(welcome.name, 'Adascript');
  assert.equal(welcome.tickRate, 60);
  assert.ok(Number.isInteger(welcome.playerId) && welcome.playerId > 0);

  ws.send(encode(MSG.PING, { c: 1234.5 }));
  const pong = await next();
  assert.equal(pong.t, MSG.PONG);
  assert.equal(pong.c, 1234.5);
  assert.ok(pong.s >= welcome.serverTick);
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
