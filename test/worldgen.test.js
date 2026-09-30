import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE, GEN_VERSION, floodFill, generateWorld } from '../shared/worldgen.js';
import { createRng } from '../shared/rng.js';
import { fbm, noise1, noise2 } from '../shared/noise.js';
import { INPUT, createPlayer, step } from '../shared/physics.js';
import { FLAG, TILE, TILE_FLAGS, TILE_SIZE, parseAsciiMap } from '../shared/tiles.js';

// Update ONLY for intentional generator changes, together with a GEN_VERSION bump
// (clients check the hash against the server's). Say so in the commit.
const GOLDEN = { seed: 1, genVersion: 1, hash: '08ff870b' };

test('golden hash: generator output for a fixed seed is unchanged', () => {
  const w = generateWorld(GOLDEN.seed);
  assert.equal(GEN_VERSION, GOLDEN.genVersion, 'GEN_VERSION changed; update GOLDEN with it');
  assert.equal(w.hash, GOLDEN.hash, `hash changed: got ${w.hash}. If intentional, bump GEN_VERSION and update GOLDEN`);
});

test('same seed, same world', () => {
  const a = generateWorld(987654321);
  const b = generateWorld(987654321);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.tiles, b.tiles);
  assert.deepEqual(a.posts, b.posts);
  assert.notEqual(generateWorld(987654322).hash, a.hash);
});

test('200 seeds: every post reachable from the spawn post, posts well-formed', () => {
  const kinds = { surface: 0, cave: 0, sky: 0 };
  for (let seed = 1000; seed < 1200; seed++) {
    const w = generateWorld(seed);
    assert.ok(w.posts.length >= 8 && w.posts.length <= 12, `seed ${seed}: ${w.posts.length} posts`);
    assert.equal(new Set(w.posts.map((p) => p.name)).size, w.posts.length, `seed ${seed}: duplicate names`);
    const spawn = w.posts[w.spawnPost].spawn;
    // Spawn tile is open with a solid floor under it.
    assert.equal(w.tiles[spawn.ty * w.w + spawn.tx], TILE.empty, `seed ${seed}: spawn blocked`);
    assert.ok(TILE_FLAGS[w.tiles[(spawn.ty + 1) * w.w + spawn.tx]] & FLAG.SOLID, `seed ${seed}: no floor under spawn`);
    const { visited } = floodFill(w, spawn);
    for (const p of w.posts) {
      kinds[p.kind]++;
      let reached = false;
      for (let y = p.zone.y0; y <= p.zone.y1 && !reached; y++) {
        for (let x = p.zone.x0; x <= p.zone.x1; x++) if (visited[y * w.w + x]) { reached = true; break; }
      }
      assert.ok(reached, `seed ${seed}: ${p.name} unreachable`);
    }
  }
  // All three kinds show up across seeds.
  for (const [k, n] of Object.entries(kinds)) assert.ok(n > 20, `${k} posts: ${n}`);
});

test('generation stays within budget', () => {
  const t0 = performance.now();
  for (let seed = 0; seed < 10; seed++) generateWorld(seed);
  const avg = (performance.now() - t0) / 10;
  // The target is <200 ms in a browser. Node is usually faster; this only catches large regressions.
  assert.ok(avg < 400, `average ${avg.toFixed(0)} ms per world`);
});

// The generator places ledges and gaps using ENVELOPE. The physics must still beat
// it with the current TUNING, or generated worlds stop being playable.

test('physics can climb an ENVELOPE.stepUp ledge', () => {
  const rows = ['..........', '..........', '..........', '..........', '..........', '..........'];
  for (let r = 0; r < ENVELOPE.stepUp; r++) rows.push('.....#####');
  rows[rows.length - 1] = '.@...#####';
  rows.push('##########');
  const map = parseAsciiMap(rows);
  const s = map.markers['@'][0];
  let p = createPlayer((s.tx + 0.5) * TILE_SIZE, (s.ty + 1) * TILE_SIZE);
  let hold = 0;
  for (let i = 0; i < 200; i++) {
    let bits = INPUT.RIGHT;
    if (hold > 0) { bits |= INPUT.JUMP; hold--; }
    else if (p.onGround && p.vx === 0 && i > 3 && !(p.buttons & INPUT.JUMP)) { bits |= INPUT.JUMP; hold = 30; }
    p = step(p, bits, map);
  }
  assert.ok(p.onGround && p.x >= 5 * TILE_SIZE, `stuck at x=${p.x.toFixed(0)}`);
});

test('physics can jump an ENVELOPE.gap-tile gap from a short run-up', () => {
  const g = ENVELOPE.gap;
  const row = '@...' + '.'.repeat(g) + '....';
  const floor = '####' + '.'.repeat(g) + '####';
  const map = parseAsciiMap(['.'.repeat(row.length), '.'.repeat(row.length), '.'.repeat(row.length), row.replace('@', '.'), floor, '.'.repeat(row.length)]);
  let crossed = false;
  for (let j = 0; j < 30 && !crossed; j++) {
    let p = createPlayer(TILE_SIZE / 2, 4 * TILE_SIZE);
    for (let i = 0; i < 120; i++) {
      p = step(p, INPUT.RIGHT | (i >= j && i < j + 25 ? INPUT.JUMP : 0), map);
      if (i > j + 2 && p.onGround) { crossed = p.x > (4 + g) * TILE_SIZE; break; }
      if (p.y > 5 * TILE_SIZE) break; // fell in
    }
  }
  assert.ok(crossed);
});

test('rng: deterministic, forks are independent, ranges hold', () => {
  const a = createRng(5), b = createRng(5);
  for (let i = 0; i < 100; i++) assert.equal(a.u32(), b.u32());
  // A fork doesn't depend on how much of the parent stream was used.
  const p1 = createRng(9), p2 = createRng(9);
  p2.u32(); p2.u32();
  assert.equal(p1.fork('x').u32(), p2.fork('x').u32());
  assert.notEqual(createRng(9).fork('x').u32(), createRng(9).fork('y').u32());
  const r = createRng(1);
  for (let i = 0; i < 10000; i++) {
    const f = r.float();
    assert.ok(f >= 0 && f < 1);
    const n = r.int(-3, 3);
    assert.ok(Number.isInteger(n) && n >= -3 && n <= 3);
  }
  // State round-trips (for persistence later).
  const s = createRng(77); s.u32();
  const restored = createRng(77, s.state());
  assert.equal(restored.u32(), s.u32());
});

test('noise stays in [0, 1)', () => {
  for (let i = 0; i < 5000; i++) {
    const x = i * 0.37 - 900, y = i * 0.13 - 300;
    for (const v of [noise1(x, 3), noise2(x, y, 3), fbm(noise2, x, y, 3, 4)]) assert.ok(v >= 0 && v < 1, `${v}`);
  }
});
