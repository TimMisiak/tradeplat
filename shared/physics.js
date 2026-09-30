// Player movement. See DESIGN.md § Movement feel and ARCHITECTURE.md § Simulation.
//
// step() is PURE: same (state, input, map, tuning) → same result, bit for bit,
// on every JS engine. It uses only + − × ÷ and Math.floor/ceil/min/max/abs/sign,
// which are exact under IEEE-754. It has no randomness, no clock, and no mutation
// of its arguments. The client predicts with it and the server re-simulates with
// it (M3), so any hidden state here becomes a desync.
//
// Units: pixels and ticks (60 Hz). Positions are the top-left of the hitbox, y down.
import { FLAG, TILE_FLAGS, TILE_SIZE, tileAt } from './tiles.js';

export const TICK_RATE = 60;

/** Input bitmask, sampled once per tick. */
export const INPUT = Object.freeze({
  LEFT: 1 << 0,
  RIGHT: 1 << 1,
  UP: 1 << 2,
  DOWN: 1 << 3,
  JUMP: 1 << 4,
  INTERACT: 1 << 5,
});

/**
 * Movement tuning. Every feel constant lives here (DESIGN.md). Values are per
 * tick at 60 Hz. The dev tuning panel (backquote key) edits a copy live.
 */
export const TUNING = Object.freeze({
  // hitbox (px). ART.md sizes the player sprite around it
  width: 12,
  height: 18,

  // running
  runSpeed: 3.2, // top speed, px/tick (~12 tiles/s)
  groundAccel: 0.55, // ~6 ticks from standstill to top speed
  groundDecel: 0.8, // ~4 ticks from top speed to a stop
  groundTurn: 1.2, // accel when reversing, snappier than starting
  airAccel: 0.4, // ~70% of ground accel: strong air control
  airDecel: 0.12, // no input in the air: momentum mostly kept
  airTurn: 0.6,

  // jumping and gravity
  gravity: 0.36, // rising
  fallGravityMult: 1.4, // falling is heavier, which makes jumps feel snappy
  maxFall: 8, // terminal velocity, px/tick (half a tile, so it can't tunnel)
  jumpVel: 7.2, // full-hold jump ≈ jumpVel²/2g ≈ 72 px ≈ 4.5 tiles
  jumpCut: 0.4, // releasing jump while rising multiplies vy by this, once
  coyoteTicks: 6, // can still ground-jump this long after leaving a ledge
  jumpBufferTicks: 6, // a jump pressed this long before landing still fires

  // walls
  wallSlideMax: 2.4, // fall speed cap while holding into a wall
  wallJumpX: 4.0, // horizontal kick away from the wall
  wallJumpY: 6.8,
  wallLockTicks: 8, // after a wall jump, input toward that wall is ignored
  wallCoyoteTicks: 5, // can still wall-jump this long after leaving the wall
});

/** Hard per-tick speed cap. Below one tile, so per-axis collision can't skip a tile. */
const MAX_STEP = TILE_SIZE - 1;

/**
 * Player movement state. Plain data, so it can be serialized, snapshotted and replayed.
 * @typedef {{
 *   x: number, y: number, vx: number, vy: number,
 *   onGround: boolean, wallDir: -1|0|1, facing: -1|1,
 *   coyote: number, jumpBuffer: number, wallCoyote: number, wallCoyoteDir: -1|0|1,
 *   wallLock: number, wallLockDir: -1|0|1, jumping: boolean, buttons: number,
 * }} PlayerState
 */

/** @returns {PlayerState} a player standing with its feet at (footX, footY). */
export function createPlayer(footX, footY, tuning = TUNING) {
  return {
    x: footX - tuning.width / 2,
    y: footY - tuning.height,
    vx: 0,
    vy: 0,
    onGround: false,
    wallDir: 0, // wall touching this tick (airborne only): -1 left, 1 right
    facing: 1,
    coyote: 0,
    jumpBuffer: 0,
    wallCoyote: 0,
    wallCoyoteDir: 0,
    wallLock: 0,
    wallLockDir: 0,
    jumping: false, // rising from a jump, so releasing the button cuts it
    buttons: 0, // last tick's input, for edge detection
  };
}

const approach = (v, target, rate) => (v < target ? Math.min(v + rate, target) : Math.max(v - rate, target));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Advance one tick.
 * @param {PlayerState} p
 * @param {number} input INPUT bitmask
 * @param {import('./tiles.js').TileMap} map
 * @param {typeof TUNING} [t]
 * @returns {PlayerState} a new state (p is not modified)
 */
export function step(p, input, map, t = TUNING) {
  const s = { ...p };
  const jumpHeld = (input & INPUT.JUMP) !== 0;
  const jumpPressed = jumpHeld && (p.buttons & INPUT.JUMP) === 0;
  const down = (input & INPUT.DOWN) !== 0;
  let dir = ((input & INPUT.RIGHT) ? 1 : 0) - ((input & INPUT.LEFT) ? 1 : 0);

  // Timers
  s.jumpBuffer = jumpPressed ? t.jumpBufferTicks : Math.max(0, p.jumpBuffer - 1);
  s.coyote = p.onGround ? t.coyoteTicks : Math.max(0, p.coyote - 1);
  if (p.wallDir !== 0) {
    s.wallCoyote = t.wallCoyoteTicks;
    s.wallCoyoteDir = p.wallDir;
  } else {
    s.wallCoyote = Math.max(0, p.wallCoyote - 1);
  }
  s.wallLock = Math.max(0, p.wallLock - 1);
  if (s.wallLock > 0 && dir === s.wallLockDir) dir = 0;

  // Jumps: ground (including coyote time) wins over wall
  if (s.jumpBuffer > 0) {
    if (s.coyote > 0) {
      groundJump(s, t);
    } else if (s.wallCoyote > 0) {
      const wall = s.wallCoyoteDir;
      s.vx = -wall * t.wallJumpX;
      s.vy = -t.wallJumpY;
      s.jumping = true;
      s.wallLock = t.wallLockTicks;
      s.wallLockDir = wall;
      s.wallCoyote = 0;
      s.jumpBuffer = 0;
      s.facing = -wall;
    }
  }

  // Horizontal
  const target = dir * t.runSpeed;
  let accel;
  if (dir === 0) accel = p.onGround ? t.groundDecel : t.airDecel;
  else if (s.vx !== 0 && Math.sign(s.vx) !== dir) accel = p.onGround ? t.groundTurn : t.airTurn;
  else accel = p.onGround ? t.groundAccel : t.airAccel;
  s.vx = approach(s.vx, target, accel);
  if (dir !== 0) s.facing = dir;

  // Vertical: variable jump height, gravity, wall slide
  if (s.jumping && (!jumpHeld || s.vy >= 0)) {
    if (s.vy < 0) s.vy *= t.jumpCut;
    s.jumping = false;
  }
  s.vy += s.vy > 0 ? t.gravity * t.fallGravityMult : t.gravity;
  s.vy = Math.min(s.vy, t.maxFall);
  if (p.wallDir !== 0 && dir === p.wallDir && s.vy > t.wallSlideMax) s.vy = t.wallSlideMax;

  s.vx = clamp(s.vx, -MAX_STEP, MAX_STEP);
  s.vy = clamp(s.vy, -MAX_STEP, MAX_STEP);

  // Move and collide, one axis at a time
  moveX(s, map, t);
  s.onGround = moveY(s, map, t, down);
  if (s.onGround) {
    s.jumping = false;
    // A buffered jump fires on the landing tick itself, with no grounded frame in between.
    if (s.jumpBuffer > 0) groundJump(s, t);
  }

  s.wallDir = s.onGround ? 0 : touchingWall(s, map, t);
  s.buttons = input;
  return s;
}

function groundJump(s, t) {
  s.vy = -t.jumpVel;
  s.jumping = true;
  s.coyote = 0;
  s.jumpBuffer = 0;
}

// Tile span covered by [a, a+len): first and last tile index.
const first = (a) => Math.floor(a / TILE_SIZE);
const last = (a, len) => Math.ceil((a + len) / TILE_SIZE) - 1;

function moveX(s, map, t) {
  if (s.vx === 0) return;
  s.x += s.vx;
  const ty0 = first(s.y), ty1 = last(s.y, t.height);
  if (s.vx > 0) {
    const tx = last(s.x, t.width);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (TILE_FLAGS[tileAt(map, tx, ty)] & FLAG.SOLID) {
        s.x = tx * TILE_SIZE - t.width;
        s.vx = 0;
        return;
      }
    }
  } else {
    const tx = first(s.x);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (TILE_FLAGS[tileAt(map, tx, ty)] & FLAG.SOLID) {
        s.x = (tx + 1) * TILE_SIZE;
        s.vx = 0;
        return;
      }
    }
  }
}

/** Moves vertically. Returns true if the player landed on something this tick. */
function moveY(s, map, t, down) {
  const prevBottom = s.y + t.height;
  s.y += s.vy;
  const tx0 = first(s.x), tx1 = last(s.x, t.width);
  if (s.vy > 0) {
    // Scan every row the feet swept through, top to bottom, so a one-way platform
    // is caught even when the feet pass its top edge between ticks.
    const rowFrom = first(prevBottom), rowTo = last(s.y, t.height);
    for (let ty = rowFrom; ty <= rowTo; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const f = TILE_FLAGS[tileAt(map, tx, ty)];
        const top = ty * TILE_SIZE;
        if ((f & FLAG.SOLID) || ((f & FLAG.ONE_WAY) && !down && prevBottom <= top)) {
          s.y = top - t.height;
          s.vy = 0;
          return true;
        }
      }
    }
  } else if (s.vy < 0) {
    const ty = first(s.y);
    for (let tx = tx0; tx <= tx1; tx++) {
      if (TILE_FLAGS[tileAt(map, tx, ty)] & FLAG.SOLID) {
        s.y = (ty + 1) * TILE_SIZE;
        s.vy = 0;
        s.jumping = false;
        return false;
      }
    }
  }
  return false;
}

/** -1 / 1 if a solid wall is directly against the left / right side, else 0. */
function touchingWall(s, map, t) {
  const ty0 = first(s.y), ty1 = last(s.y, t.height);
  const right = first(s.x + t.width);
  const left = first(s.x - 1);
  // Exact contact only: after collision snapping, x lands on tile boundaries.
  const atRight = (s.x + t.width) % TILE_SIZE === 0;
  const atLeft = s.x % TILE_SIZE === 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    if (atRight && (TILE_FLAGS[tileAt(map, right, ty)] & FLAG.SOLID)) return 1;
    if (atLeft && (TILE_FLAGS[tileAt(map, left, ty)] & FLAG.SOLID)) return -1;
  }
  return 0;
}
