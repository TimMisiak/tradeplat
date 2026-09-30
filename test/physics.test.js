import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT, TUNING, createPlayer, step } from '../shared/physics.js';
import { TILE_SIZE, parseAsciiMap } from '../shared/tiles.js';

const { LEFT, RIGHT, DOWN, JUMP } = INPUT;
const T = TUNING;

// A frozen copy of the tuning for the golden-hash test, so tuning the game's feel
// doesn't break it. Only changes to step() logic should.
const GOLDEN_TUNING = Object.freeze({
  width: 12, height: 18, runSpeed: 3.2, groundAccel: 0.55, groundDecel: 0.8, groundTurn: 1.2,
  airAccel: 0.4, airDecel: 0.12, airTurn: 0.6, gravity: 0.36, fallGravityMult: 1.4, maxFall: 8,
  jumpVel: 7.2, jumpCut: 0.4, coyoteTicks: 6, jumpBufferTicks: 6, wallSlideMax: 2.4,
  wallJumpX: 4.0, wallJumpY: 6.8, wallLockTicks: 8, wallCoyoteTicks: 5,
});

/** Player standing on the '@' marker's floor (the marker sits in the tile just above the floor). */
function spawn(map, tuning = T) {
  const { tx, ty } = map.markers['@'][0];
  return createPlayer((tx + 0.5) * TILE_SIZE, (ty + 1) * TILE_SIZE, tuning);
}

/** Run `ticks` steps with a fixed input (or input(i) function). Returns every state. */
function run(p, map, ticks, input, tuning = T) {
  const states = [];
  for (let i = 0; i < ticks; i++) {
    p = step(p, typeof input === 'function' ? input(i, p) : input, map, tuning);
    states.push(p);
  }
  return states;
}
const lastOf = (a) => a[a.length - 1];
const settle = (p, map) => lastOf(run(p, map, 10, 0));

const FLAT = parseAsciiMap([
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '....................................',
  '...@................................',
  '####################################',
]);

test('standing still is stable and grounded', () => {
  const p0 = settle(spawn(FLAT), FLAT);
  const states = run(p0, FLAT, 120, 0);
  for (const s of states) {
    assert.equal(s.onGround, true);
    assert.equal(s.y, p0.y);
    assert.equal(s.vy, 0);
  }
  assert.equal(p0.y + T.height, 9 * TILE_SIZE, 'feet on the floor');
});

test('step does not mutate its input state', () => {
  const p = settle(spawn(FLAT), FLAT);
  const copy = structuredClone(p);
  step(p, RIGHT | JUMP, FLAT);
  assert.deepEqual(p, copy);
});

test('run reaches top speed in ~6 ticks and stops in ~4', () => {
  let p = settle(spawn(FLAT), FLAT);
  const accel = run(p, FLAT, 12, RIGHT);
  const reached = accel.findIndex((s) => s.vx === T.runSpeed) + 1;
  assert.ok(reached >= 4 && reached <= 7, `ticks to top speed: ${reached}`);
  const stop = run(lastOf(accel), FLAT, 10, 0);
  const stopped = stop.findIndex((s) => s.vx === 0) + 1;
  assert.ok(stopped >= 3 && stopped <= 5, `ticks to stop: ${stopped}`);
});

test('full jump reaches ~jumpVel²/2g; tapping gives a lower hop', () => {
  const p0 = settle(spawn(FLAT), FLAT);
  const peak = (states) => p0.y - Math.min(...states.map((s) => s.y));
  const full = peak(run(p0, FLAT, 60, JUMP));
  const expected = (T.jumpVel * T.jumpVel) / (2 * T.gravity);
  assert.ok(Math.abs(full - expected) < TILE_SIZE / 2, `full jump ${full.toFixed(1)} px, expected ~${expected.toFixed(1)}`);
  const tap = peak(run(p0, FLAT, 60, (i) => (i < 3 ? JUMP : 0)));
  assert.ok(tap < full * 0.5, `tap ${tap.toFixed(1)} px vs full ${full.toFixed(1)} px`);
  // Holding jump after landing doesn't bounce: a new press is needed.
  const held = run(p0, FLAT, 120, JUMP);
  assert.equal(lastOf(held).onGround, true);
});

const LEDGE = parseAsciiMap([
  '..............................',
  '..............................',
  '..............................',
  '..............................',
  '..@...........................',
  '######........................',
  '..............................',
  '..............................',
  '..............................',
  '..............................',
  '..............................',
  '##############################',
]);

/** Walk right off the ledge, pressing jump `late` ticks after leaving the ground. */
function coyoteJump(late) {
  let p = settle(spawn(LEDGE), LEDGE);
  let airborne = -1;
  for (let i = 0; i < 80; i++) {
    const jump = airborne >= 0 && i - airborne === late;
    p = step(p, RIGHT | (jump ? JUMP : 0), LEDGE);
    if (airborne < 0 && !p.onGround) airborne = i;
    if (jump) return p.vy < 0;
  }
  throw new Error('never left the ledge');
}

test('coyote time: jump shortly after leaving a ledge still works', () => {
  assert.equal(coyoteJump(3), true, '3 ticks late');
  assert.equal(coyoteJump(T.coyoteTicks - 1), true, 'at the edge of the window');
  assert.equal(coyoteJump(T.coyoteTicks + 3), false, 'too late');
});

test('jump buffer: pressing jump just before landing jumps on landing', () => {
  for (const early of [1, 4, T.jumpBufferTicks - 1]) {
    let p = settle(spawn(FLAT), FLAT);
    p = { ...p, y: p.y - 40 }; // start in the air
    // Find the landing tick with no input.
    const fall = run(p, FLAT, 60, 0);
    const land = fall.findIndex((s) => s.onGround);
    const states = run(p, FLAT, land + 3, (i) => (i === land - early ? JUMP : 0));
    const after = states.slice(land);
    assert.ok(after.some((s) => s.vy < 0), `buffered ${early} ticks early`);
  }
  // Pressed far too early: no jump on landing.
  let p = { ...settle(spawn(FLAT), FLAT) };
  p = { ...p, y: p.y - 120 };
  const fall = run(p, FLAT, 90, 0);
  const land = fall.findIndex((s) => s.onGround);
  const states = run(p, FLAT, land + 3, (i) => (i === land - (T.jumpBufferTicks + 4) ? JUMP : 0));
  assert.ok(states.slice(land).every((s) => s.vy >= 0));
});

const SHAFT = parseAsciiMap([
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#.......@..#',
  '############',
]);

test('wall slide caps fall speed while holding into the wall', () => {
  let p = settle(spawn(SHAFT), SHAFT);
  p = { ...p, x: 11 * TILE_SIZE - T.width, y: 2 * TILE_SIZE, vy: 0, coyote: 0, onGround: false }; // against the right wall, high up
  const states = run(p, SHAFT, 40, RIGHT);
  const sliding = states.filter((s) => !s.onGround).slice(5);
  assert.ok(sliding.length > 5);
  for (const s of sliding) {
    assert.equal(s.wallDir, 1);
    assert.ok(s.vy <= T.wallSlideMax, `vy ${s.vy}`);
  }
  // Not holding into the wall: normal fall, faster than the slide cap.
  const free = run(p, SHAFT, 20, 0);
  assert.ok(Math.max(...free.map((s) => s.vy)) > T.wallSlideMax);
});

test('wall jump kicks away from the wall and locks input toward it briefly', () => {
  let p = settle(spawn(SHAFT), SHAFT);
  p = { ...p, x: 11 * TILE_SIZE - T.width, y: 4 * TILE_SIZE, vy: 1, coyote: 0, onGround: false };
  p = lastOf(run(p, SHAFT, 3, RIGHT));
  assert.equal(p.wallDir, 1);
  const jumped = step(p, RIGHT | JUMP, SHAFT);
  assert.ok(jumped.vy < 0, 'moving up');
  assert.ok(jumped.vx < 0, 'kicked left, away from the right wall');
  // Holding toward the wall during the lock doesn't pull back into it.
  const locked = run(jumped, SHAFT, T.wallLockTicks - 1, RIGHT | JUMP);
  assert.ok(locked.every((s) => s.vx < 0));
  assert.ok(lastOf(locked).x < jumped.x);
});

const NARROW = parseAsciiMap([
  ...Array(20).fill('#....#'),
  '#.@..#',
  '######',
]);

test('wall jumps chain up a narrow shaft', () => {
  // Jump from the ground, then jump off each wall as soon as we touch it,
  // holding toward the next wall and holding jump while rising.
  let p = settle(spawn(NARROW), NARROW);
  const startY = p.y;
  let side = 1;
  let wallJumps = 0;
  for (let i = 0; i < 300; i++) {
    const touching = p.wallDir === side;
    const wasHeld = (p.buttons & JUMP) !== 0;
    // A jump needs a fresh press, so release for a tick if jump is still held on contact.
    const press = (p.onGround || touching) && !wasHeld;
    const hold = press || (p.jumping && p.vy < 0 && !touching);
    p = step(p, (side > 0 ? RIGHT : LEFT) | (hold ? JUMP : 0), NARROW);
    if (press && touching) { side = -side; wallJumps++; }
  }
  assert.ok(wallJumps >= 4, `wall jumps: ${wallJumps}`);
  assert.ok(startY - p.y > 8 * TILE_SIZE, `climbed ${(startY - p.y).toFixed(0)} px`);
});

const ONEWAY = parseAsciiMap([
  '..........',
  '..........',
  '..........',
  '..======..',
  '..........',
  '..........',
  '....@.....',
  '##########',
]);

test('one-way platforms: jump up through, land on top, drop through with down', () => {
  let p = settle(spawn(ONEWAY), ONEWAY);
  const top = 3 * TILE_SIZE;
  const up = run(p, ONEWAY, 60, (i) => (i < 30 ? JUMP : 0));
  assert.ok(up.some((s) => s.y < top - T.height), 'passed up through the platform');
  p = lastOf(up);
  assert.equal(p.onGround, true);
  assert.equal(p.y + T.height, top, 'standing on the platform');
  const drop = run(p, ONEWAY, 30, DOWN);
  assert.equal(lastOf(drop).y + T.height, 7 * TILE_SIZE, 'dropped to the floor');
});

test('no tunneling: a fall at terminal velocity stops on a 1-tile floor', () => {
  const rows = Array(60).fill('.....');
  rows[1] = '..@..';
  rows[50] = '#####';
  rows.push('.....');
  const map = parseAsciiMap(rows);
  const states = run(spawn(map), map, 200, 0);
  assert.ok(states.some((s) => s.vy === T.maxFall), 'reached terminal velocity');
  assert.equal(lastOf(states).y + T.height, 50 * TILE_SIZE);
});

test('ceiling stops upward motion', () => {
  const map = parseAsciiMap([
    '########',
    '........',
    '........',
    '...@....',
    '########',
  ]);
  const states = run(settle(spawn(map), map), map, 40, JUMP);
  assert.ok(Math.min(...states.map((s) => s.y)) >= TILE_SIZE, 'head never enters the ceiling');
});

test('determinism: golden hash of a recorded run', () => {
  // Scripted input: run, jump, wall-jump in the shaft, drop.
  const script = (i) =>
    (i % 90 < 50 ? RIGHT : LEFT) | (i % 37 < 12 ? JUMP : 0) | (i % 200 > 190 ? DOWN : 0);
  const states = run(spawn(SHAFT, GOLDEN_TUNING), SHAFT, 600, script, GOLDEN_TUNING);
  const h = hashStates(states);
  // Same input gives the same result.
  assert.equal(hashStates(run(spawn(SHAFT, GOLDEN_TUNING), SHAFT, 600, script, GOLDEN_TUNING)), h);
  // Update this ONLY for intentional changes to step() logic, and say so in the commit.
  assert.equal(h, GOLDEN_HASH, `golden hash changed: got ${h}`);
});

const GOLDEN_HASH = '39f58df9';

/** FNV-1a over the bit patterns of every numeric/boolean field of every state. */
function hashStates(states) {
  const f = new Float64Array(1);
  const bytes = new Uint8Array(f.buffer);
  let h = 0x811c9dc5;
  for (const s of states) {
    for (const k of Object.keys(s).sort()) {
      f[0] = +s[k];
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
