// Netcode pieces without sockets: the server's per-player input queue and credit
// (speed-hack guard), client prediction + reconciliation, and ghost interpolation.
// See ARCHITECTURE.md § Netcode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAG_WINDOW, MAX_CREDIT, MAX_QUEUE, createGame } from '../server/game.js';
import { chunkOf, near } from '../server/net.js';
import { createGhosts, createKillBook, createPredictor } from '../client/net.js';
import { INPUT } from '../shared/physics.js';
import { stepPlayer } from '../shared/sim.js';
import { CHUNK_TILES, packGhost, unpackGhost } from '../shared/protocol.js';
import { TILE_SIZE } from '../shared/tiles.js';

const { LEFT, RIGHT, JUMP, RESPAWN } = INPUT;
const game = createGame({ seed: 12345 });

/** A varied input script: runs, jumps, turns. */
const script = (i) => ((i >> 5) & 1 ? RIGHT : LEFT) | (i % 23 < 9 ? JUMP : 0);
const bitsFor = (from, n) => Array.from({ length: n }, (_, k) => script(from + k));

/** Run `n` server ticks. */
const ticks = (n) => { for (let i = 0; i < n; i++) game.advance(); };
/** One tick as the server runs it, with no kills. */
const stepAt = (s, bits, tick) => stepPlayer(s, bits, tick, game.sim, {});

test('the server applies input only as fast as real time', () => {
  const p = game.addPlayer('speedy');
  game.receiveInput(p, 1, bitsFor(1, 8));
  assert.equal(p.seq, 2, 'start credit only');
  assert.equal(p.queue.length, 6);
  ticks(3);
  assert.equal(p.seq, 5);
  // Flooding: far more input than time allows is capped at the queue.
  for (let s = 9; s < 200; s += 8) game.receiveInput(p, s, bitsFor(s, 8));
  assert.equal(p.seq + p.queue.length, 5 + MAX_QUEUE);
  ticks(10);
  assert.equal(p.seq, 15);
  game.removePlayer(p.id);
});

test('server state matches a straight replay of the same input and ticks', () => {
  const p = game.addPlayer('a');
  let s = game.spawn;
  const t0 = game.tick + 2;
  for (let seq = 1; seq <= 300; seq += 3) {
    game.receiveInput(p, seq, bitsFor(seq, 3), t0 + seq);
    ticks(3);
  }
  for (let i = 1; i <= 300; i++) s = stepAt(s, script(i), t0 + i);
  assert.equal(p.seq, 300);
  assert.deepEqual(p.state, s);
  game.removePlayer(p.id);
});

test('duplicates are ignored, gaps repeat the last input, junk is rejected', () => {
  const p = game.addPlayer('b');
  ticks(1);
  game.receiveInput(p, 1, [RIGHT, RIGHT]);
  game.receiveInput(p, 1, [LEFT, LEFT]); // already have 1 and 2
  game.receiveInput(p, 5, [JUMP]); // 3 and 4 missing
  assert.equal(p.seq + p.queue.length, 5);
  assert.deepEqual(p.queue.map((q) => q.bits), [RIGHT, RIGHT, JUMP]);
  assert.equal(game.receiveInput(p, 6, [1 << 9]), false);
  assert.equal(game.receiveInput(p, 0, [0]), false);
  assert.equal(game.receiveInput(p, 6, 'x'), false);
  assert.equal(game.receiveInput(p, 1e9, [0]), true, 'far future: dropped quietly');
  assert.equal(p.seq + p.queue.length, 5);
  game.removePlayer(p.id);
});

test('a player who stops sending is stepped with no input, then recovers', () => {
  const p = game.addPlayer('c');
  // Jump off to the right, then go quiet in mid-air.
  game.receiveInput(p, 1, [RIGHT | JUMP]);
  const { seq, state } = p;
  ticks(MAX_CREDIT - 5);
  assert.deepEqual(p.state, state, 'still waiting');
  ticks(20);
  assert.notDeepEqual(p.state, state, 'filler steps ran');
  assert.equal(p.seq, seq, 'without using up input seqs');
  // Input resumes in order. The client's catch-up burst (two messages) runs at
  // once, then the credit resets, so normal jitter doesn't force more filler.
  const pred = createPredictor(game.sim, game.spawn);
  pred.reset(state, seq, game.tick);
  const burst = Array(15).fill(RIGHT);
  for (const b of burst) pred.advance(b);
  game.receiveInput(p, seq + 1, burst.slice(0, 8), game.tick + 1);
  game.receiveInput(p, seq + 9, burst.slice(8), game.tick + 9);
  assert.equal(p.seq, seq + 15);
  assert.equal(p.queue.length, 0, 'nothing left queued to add lag');
  ticks(1);
  assert.ok(p.credit <= 3);
  assert.equal(pred.reconcile(p.seq, p.state), true, 'the client takes the server state');
  assert.deepEqual(pred.cur, p.state);
  game.removePlayer(p.id);
});

test('prediction agrees with the server: no mismatches, pending drains', () => {
  const p = game.addPlayer('d');
  const pred = createPredictor(game.sim, game.spawn);
  pred.reset(p.state, p.seq, game.tick + 2);
  for (let i = 0; i < 200; i++) {
    const seq = pred.advance(script(i + 1) | (i === 120 ? RESPAWN : 0));
    game.receiveInput(p, seq, [script(i + 1) | (i === 120 ? RESPAWN : 0)], pred.tick);
    game.advance();
    // Snapshots arrive "late": every third tick, with the server a little behind us.
    if (i % 3 === 0) pred.reconcile(p.seq, p.state);
  }
  assert.equal(pred.mismatches, 0);
  pred.reconcile(p.seq, p.state);
  assert.equal(pred.pending.length, 200 - p.seq);
  game.removePlayer(p.id);
});

test('a misprediction replays unacknowledged input on the server state', () => {
  const pred = createPredictor(game.sim, game.spawn);
  pred.reset(game.spawn, 0, 0);
  for (let i = 1; i <= 30; i++) pred.advance(script(i));
  // The server saw something different for tick 10 (say it was dropped as a gap).
  let server = game.spawn;
  for (let i = 1; i <= 10; i++) server = stepAt(server, i === 10 ? 0 : script(i), i);
  assert.equal(pred.reconcile(10, server), true);
  assert.equal(pred.mismatches, 1);
  let expect = server;
  for (let i = 11; i <= 30; i++) expect = stepAt(expect, script(i), i);
  assert.deepEqual(pred.cur, expect);
  assert.equal(pred.pending.length, 20);
  assert.equal(pred.reconcile(10, server), false, 'old acks are ignored');
  // Server ahead of everything we predicted: take its state and seq.
  pred.reconcile(40, game.spawn);
  assert.equal(pred.seq, 40);
  assert.deepEqual(pred.cur, game.spawn);
  assert.equal(pred.pending.length, 0);
});

test('ghosts interpolate between snapshots, hold at the ends, and leave', () => {
  const g = createGhosts();
  const pose = (x) => ({ ...game.spawn, x, onGround: true });
  g.add(3, [packGhost(7, pose(100)), packGhost(8, pose(0))]);
  g.add(6, [packGhost(7, pose(106))]);
  assert.equal(g.sample(0).find((s) => s.id === 7).x, 100);
  assert.ok(g.sample(2).some((s) => s.id === 8), 'kept until its last sample is drawn');
  assert.equal(g.sample(4).find((s) => s.id === 7).x, 102);
  assert.ok(!g.sample(4).some((s) => s.id === 8), 'then dropped');
  assert.equal(g.sample(7).find((s) => s.id === 7).x, 106);
  // A teleport doesn't slide across the map.
  g.add(9, [packGhost(7, pose(900))]);
  assert.equal(g.sample(7.5).find((s) => s.id === 7).x, 106);
});

test('ghost wire format', () => {
  const s = { ...game.spawn, x: 10.1234, y: 20.06, facing: -1, wallDir: 1, onGround: false, vy: 1 };
  assert.deepEqual(unpackGhost(packGhost(3, s)), { id: 3, x: 10.1, y: 20.1, facing: 1, anim: 4 });
});

test('interest: the 3×3 chunks around a player', () => {
  const at = (cx, cy) => chunkOf({ x: cx * CHUNK_TILES * TILE_SIZE + 5, y: cy * CHUNK_TILES * TILE_SIZE + 5 });
  assert.deepEqual(at(2, 1), [2, 1]);
  assert.ok(near(at(2, 1), at(3, 2)));
  assert.ok(near(at(2, 1), at(1, 0)));
  assert.ok(!near(at(2, 1), at(4, 1)));
  assert.ok(!near(at(2, 1), at(2, 3)));
});
