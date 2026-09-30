// The M1 test level must stay traversable with the CURRENT tuning. If movement
// tuning makes a section impossible, this fails, and you choose whether to change
// the level or the tuning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT, TUNING, createPlayer, step } from '../shared/physics.js';
import { TILE_SIZE } from '../shared/tiles.js';
import { createTestMap } from '../shared/maps/test.js';

const map = createTestMap();
const { RIGHT, LEFT, JUMP } = INPUT;
const W = TUNING.width, H = TUNING.height;
const feetTile = (p) => [Math.floor((p.x + W / 2) / TILE_SIZE), Math.floor((p.y + H) / TILE_SIZE)];

test('test map has one spawn, standing on solid ground', () => {
  assert.equal(map.markers['@']?.length, 1);
  const { tx, ty } = map.markers['@'][0];
  let p = createPlayer((tx + 0.5) * TILE_SIZE, (ty + 1) * TILE_SIZE);
  for (let i = 0; i < 30; i++) p = step(p, 0, map);
  assert.equal(p.onGround, true);
  assert.deepEqual(feetTile(p), [tx, ty + 1]);
});

test('stairs: every step can be climbed', () => {
  const { tx, ty } = map.markers['@'][0];
  let p = createPlayer((tx + 0.5) * TILE_SIZE, (ty + 1) * TILE_SIZE);
  let hold = 0;
  for (let i = 0; i < 900 && p.x < 34 * TILE_SIZE; i++) {
    let bits = RIGHT;
    if (hold > 0) { bits |= JUMP; hold--; }
    else if (p.onGround && p.vx === 0 && i > 5 && !(p.buttons & JUMP)) { bits |= JUMP; hold = 24; }
    p = step(p, bits, map);
  }
  assert.ok(p.x >= 34 * TILE_SIZE, `stuck at tile ${feetTile(p)}`);
});

/** From a platform's left end (top at row 18), run right and try every jump timing. */
function crossable(fromTx, toTx0, toTx1) {
  for (let j = 0; j < 40; j++) {
    let p = createPlayer(fromTx * TILE_SIZE + W / 2, 18 * TILE_SIZE);
    for (let i = 0; i < 5; i++) p = step(p, 0, map);
    for (let i = 0; i < 120; i++) {
      p = step(p, RIGHT | (i >= j && i < j + 25 ? JUMP : 0), map);
      if (i > j + 2 && p.onGround) {
        const [x, y] = feetTile(p);
        if (y === 18 && x >= toTx0 && x <= toTx1) return true;
        break;
      }
    }
  }
  return false;
}

test('pit: the 3-, 5- and 7-tile gaps and the far wall can be jumped', () => {
  assert.ok(crossable(31, 38, 41), 'gap 3');
  assert.ok(crossable(38, 47, 50), 'gap 5');
  assert.ok(crossable(47, 58, 61), 'gap 7');
  assert.ok(crossable(58, 67, 72), 'gap 5 to the far wall');
});

test('shaft: wall jumps reach the top ledge', () => {
  let p = createPlayer(74 * TILE_SIZE, 31 * TILE_SIZE);
  let side = 1;
  let reached = false;
  for (let i = 0; i < 900 && !reached; i++) {
    const inShaft = p.x > 77 * TILE_SIZE - 2;
    const touching = p.wallDir === side;
    const press = inShaft && (p.onGround || touching) && !(p.buttons & JUMP);
    const hold = press || (p.jumping && p.vy < 0 && !touching);
    const dir = !inShaft || p.y < 9 * TILE_SIZE || side > 0 ? RIGHT : LEFT;
    p = step(p, dir | (hold ? JUMP : 0), map);
    if (press && touching) side = -side;
    reached = p.onGround && feetTile(p)[1] === 10 && p.x > 81 * TILE_SIZE;
  }
  assert.ok(reached, `highest point: tile ${feetTile(p)}`);
});
