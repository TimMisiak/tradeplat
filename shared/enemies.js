// Enemy kinds and their motion. See DESIGN.md § Enemies and hazards and
// ARCHITECTURE.md § Enemies.
//
// Every enemy's position is a pure function of its spawner (placed by worldgen,
// WORLDGEN.md § Pipeline stage 5) and the server tick, so clients compute enemies
// themselves and nothing about their motion goes over the wire. Only kills do:
// `kills` maps spawner id → the tick it was killed, and enemyPhase() derives dead,
// respawning and alive from that and the tick.
//
// Deterministic: only + − × ÷, %, Math.floor/min/max/abs and shared/mathdet.js.
// The renderer may pass a fractional tick to draw between ticks; the simulation
// always passes whole ticks.
import { cosTurns, sinTurns } from './mathdet.js';
import { TILE_SIZE } from './tiles.js';

/** Enemy tuning. Ticks are 60 Hz, distances px. */
export const ENEMY = Object.freeze({
  respawnTicks: 20 * 60, // a killed enemy comes back this long after its kill tick
  graceTicks: 60, // after respawning it blinks and is harmless for this long
  patroller: {
    w: 12, h: 14, // body hitbox, centred on the feet
    pause: 48, // ticks it stands at each end of its platform
    windup: [12, 30], // pause ticks drawn as the wind-up frame
    strike: [30, 40], // pause ticks the sword is out and hurts
    reach: 14, // sword hitbox: this far past the front of the body
    swordTop: 20, swordBottom: 4, // sword hitbox rows, measured up from the feet
  },
  flyer: { size: 12 },
  saw: { r: 11 },
});

/** Kinds that die when stomped (landed on from above). */
export const STOMPABLE = Object.freeze({ patroller: true, flyer: false, saw: false });

/** enemyPhase() results. */
export const PHASE = Object.freeze({ ALIVE: 0, DEAD: 1, SPAWNING: 2 });

/**
 * A spawner, as worldgen records it. x, y: anchor tile. params depend on kind (px, ticks):
 *   patroller: {x0, x1, floor, speed, phase}  feet x walks between x0 and x1, feet at y = floor
 *   flyer:     {rx, ry, period, phase, path}  path 'loop' (ellipse) or 'eight' around the anchor's centre
 *   saw:       {x0, y0, x1, y1, period, phase}  centre eases back and forth between the two points
 * @typedef {{id: number, kind: 'patroller'|'flyer'|'saw', x: number, y: number, params: Record<string, any>}} Spawner
 *
 * Where an enemy is at a tick. box is the body hitbox (top-left, size). attack is
 * the patroller's sword while it's out. r is set for round hitboxes (saws), with
 * box as its bounding square. anim/frame are for drawing.
 * @typedef {{x: number, y: number, facing: -1|1, anim: string, frame: number,
 *   box: {x: number, y: number, w: number, h: number}, attack: {x: number, y: number, w: number, h: number} | null, r: number}} EnemyPose
 */

/**
 * Whether an enemy is around at `tick`. It is alive up to and including its kill
 * tick (so replaying the stomp tick stomps it again), dead for respawnTicks, then
 * blinking and harmless for graceTicks.
 * @param {Record<number, number>} kills spawner id → kill tick
 */
export function enemyPhase(kills, id, tick) {
  const k = kills[id];
  if (k === undefined || tick <= k) return PHASE.ALIVE;
  const since = tick - k;
  if (since < ENEMY.respawnTicks) return PHASE.DEAD;
  if (since < ENEMY.respawnTicks + ENEMY.graceTicks) return PHASE.SPAWNING;
  return PHASE.ALIVE;
}

const mod = (a, n) => { const r = a % n; return r < 0 ? r + n : r; };

/**
 * Where a spawner's enemy is at `tick`. x, y is the feet (patroller) or centre.
 * @param {Spawner} sp
 * @returns {EnemyPose}
 */
export function enemyAt(sp, tick) {
  const q = sp.params;
  if (sp.kind === 'patroller') {
    const P = ENEMY.patroller;
    const walk = (q.x1 - q.x0) / q.speed;
    const t = mod(tick + q.phase, 2 * (walk + P.pause));
    let x, facing, pause = -1;
    if (t < walk) { x = q.x0 + t * q.speed; facing = 1; }
    else if (t < walk + P.pause) { x = q.x1; facing = 1; pause = t - walk; }
    else if (t < 2 * walk + P.pause) { x = q.x1 - (t - walk - P.pause) * q.speed; facing = -1; }
    else { x = q.x0; facing = -1; pause = t - 2 * walk - P.pause; }
    let anim = 'walk', frame = 0, attack = null;
    if (pause >= 0) {
      anim = 'idle';
      if (pause >= P.windup[0] && pause < P.windup[1]) anim = 'swing';
      else if (pause >= P.strike[0] && pause < P.strike[1]) {
        anim = 'swing';
        frame = 1;
        const front = x + facing * P.w / 2;
        attack = { x: facing > 0 ? front : front - P.reach, y: q.floor - P.swordTop, w: P.reach, h: P.swordTop - P.swordBottom };
      }
    }
    return { x, y: q.floor, facing, anim, frame, box: { x: x - P.w / 2, y: q.floor - P.h, w: P.w, h: P.h }, attack, r: 0 };
  }
  if (sp.kind === 'flyer') {
    const turn = (tick + q.phase) / q.period;
    const cx = (sp.x + 0.5) * TILE_SIZE, cy = (sp.y + 0.5) * TILE_SIZE;
    let x, y, facing;
    if (q.path === 'eight') {
      x = cx + q.rx * sinTurns(turn);
      y = cy + q.ry * sinTurns(2 * turn);
      facing = cosTurns(turn) >= 0 ? 1 : -1;
    } else {
      x = cx + q.rx * cosTurns(turn);
      y = cy + q.ry * sinTurns(turn);
      facing = sinTurns(turn) > 0 ? -1 : 1;
    }
    const s = ENEMY.flyer.size;
    return { x, y, facing, anim: 'fly', frame: 0, box: { x: x - s / 2, y: y - s / 2, w: s, h: s }, attack: null, r: 0 };
  }
  // saw
  const u = (1 - cosTurns((tick + q.phase) / q.period)) / 2;
  const x = q.x0 + (q.x1 - q.x0) * u, y = q.y0 + (q.y1 - q.y0) * u;
  const r = ENEMY.saw.r;
  return { x, y, facing: 1, anim: 'spin', frame: 0, box: { x: x - r, y: y - r, w: 2 * r, h: 2 * r }, attack: null, r };
}

/**
 * Every pixel an enemy can ever cover, including its attack: {x0, y0, x1, y1} px.
 * @param {Spawner} sp
 */
export function enemyExtent(sp) {
  const q = sp.params;
  if (sp.kind === 'patroller') {
    const P = ENEMY.patroller;
    const side = P.w / 2 + P.reach;
    return { x0: q.x0 - side, y0: q.floor - Math.max(P.h, P.swordTop), x1: q.x1 + side, y1: q.floor };
  }
  if (sp.kind === 'flyer') {
    const cx = (sp.x + 0.5) * TILE_SIZE, cy = (sp.y + 0.5) * TILE_SIZE, s = ENEMY.flyer.size / 2;
    return { x0: cx - q.rx - s, y0: cy - q.ry - s, x1: cx + q.rx + s, y1: cy + q.ry + s };
  }
  const r = ENEMY.saw.r;
  return { x0: Math.min(q.x0, q.x1) - r, y0: Math.min(q.y0, q.y1) - r, x1: Math.max(q.x0, q.x1) + r, y1: Math.max(q.y0, q.y1) + r };
}

/** What a hitbox touches: nothing, the enemy's body, or its attack (the patroller's sword). */
export const HIT = Object.freeze({ NONE: 0, BODY: 1, ATTACK: 2 });

/**
 * Whether the rect [x, x+w) × [y, y+h) touches the enemy in `pose`.
 * @param {EnemyPose} pose
 */
export function enemyHit(pose, x, y, w, h) {
  const b = pose.box;
  if (pose.r > 0) {
    // Circle against the rect: distance from the centre to the nearest point of the rect.
    const nx = Math.max(x, Math.min(pose.x, x + w)) - pose.x;
    const ny = Math.max(y, Math.min(pose.y, y + h)) - pose.y;
    return nx * nx + ny * ny < pose.r * pose.r ? HIT.BODY : HIT.NONE;
  }
  if (overlaps(b, x, y, w, h)) return HIT.BODY;
  if (pose.attack && overlaps(pose.attack, x, y, w, h)) return HIT.ATTACK;
  return HIT.NONE;
}

const overlaps = (b, x, y, w, h) => x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + h;

/** Spatial index cell size, px. */
const CELL = 16 * TILE_SIZE;

/**
 * Bucket spawners by the cells their extent covers, so a player only checks the
 * enemies that could reach it. Derived from the spawners, so it's never sent or hashed.
 * @param {Spawner[]} spawners
 * @returns {{cols: number, rows: number, cells: number[][]}} cells hold indexes into spawners
 */
export function buildEnemyIndex(spawners, mapW, mapH) {
  const cols = Math.max(1, Math.ceil(mapW * TILE_SIZE / CELL));
  const rows = Math.max(1, Math.ceil(mapH * TILE_SIZE / CELL));
  const cells = Array.from({ length: cols * rows }, () => []);
  spawners.forEach((sp, i) => {
    const e = enemyExtent(sp);
    forCells(cols, rows, e.x0, e.y0, e.x1, e.y1, (c) => cells[c].push(i));
  });
  return { cols, rows, cells };
}

/**
 * Indexes of the spawners whose extent may touch the rect [x0, x1] × [y0, y1] px,
 * each once, in ascending order (so every host checks them in the same order).
 */
export function enemiesNear(index, x0, y0, x1, y1) {
  const out = [];
  forCells(index.cols, index.rows, x0, y0, x1, y1, (c) => {
    for (const i of index.cells[c]) if (!out.includes(i)) out.push(i);
  });
  return out.sort((a, b) => a - b);
}

function forCells(cols, rows, x0, y0, x1, y1, fn) {
  const cx0 = Math.max(0, Math.floor(x0 / CELL)), cx1 = Math.min(cols - 1, Math.floor(x1 / CELL));
  const cy0 = Math.max(0, Math.floor(y0 / CELL)), cy1 = Math.min(rows - 1, Math.floor(y1 / CELL));
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * cols + cx);
}
