// One player tick as every host runs it: movement (physics.js step()), then
// spikes, enemies, death and respawn. See DESIGN.md § Cargo, money and death and
// ARCHITECTURE.md § Simulation. Client prediction, client replay and the server
// all go through stepPlayer(), so it is pure like step(): the same arguments give
// the same result on every engine, and nothing outside its return value and the
// caller's `out` array changes.
//
// A player state is physics.js's PlayerState plus two fields of its own:
//   dead: ticks left before respawning (0 while alive). step() never runs while dead.
//   home: id of the last post whose zone the player stood in (-1 if none yet). You respawn there.
// Money and cargo aren't here: the server owns them, and clears the cargo when
// its own stepPlayer() reports a death.
import { INPUT, TUNING, spawnAt, step } from './physics.js';
import { HIT, PHASE, STOMPABLE, buildEnemyIndex, enemiesNear, enemyAt, enemyHit, enemyPhase } from './enemies.js';
import { FLAG, TILE_FLAGS, TILE_SIZE, tileAt } from './tiles.js';
import { postAt } from './trade.js';

/** Ticks between dying and respawning: the splat, then the fade (DESIGN.md). */
export const DEATH_TICKS = 40;

/** Why a player died, as sent in `died`. Enemy kinds are causes too. */
export const CAUSE = Object.freeze({ SPIKES: 'spikes', PATROLLER: 'patroller', FLYER: 'flyer', SAW: 'saw', GAVE_UP: 'gave up' });

/**
 * Hurtbox inset from the movement hitbox, px. Hazards forgive a near miss
 * (Super Meat Boy does the same). The feet stay at the bottom edge, so stomps
 * and floor spikes are judged where the feet are.
 */
const HURT = Object.freeze({ side: 2, top: 3 });
/** A stomp counts if the feet were at most this far below the enemy's top on the tick before. */
const STOMP_SLACK = 6;

/**
 * Everything stepPlayer needs about a world, built once per world.
 * @param {import('./tiles.js').TileMap & {posts?: any[], spawners?: import('./enemies.js').Spawner[]}} world
 * @param {{tx: number, ty: number}} spawn where to respawn with no home post (maps without posts)
 */
export function createSim(world, spawn) {
  const spawners = world.spawners ?? [];
  return { map: world, posts: world.posts ?? [], spawners, index: buildEnemyIndex(spawners, world.w, world.h), spawn };
}

/** A fresh, alive player standing at the spawn tile of post `home` (or the sim's spawn). */
export function spawnPlayer(sim, home, t = TUNING) {
  const tile = sim.posts[home]?.spawn ?? sim.spawn;
  return { ...spawnAt(tile.tx, tile.ty, t), dead: 0, home };
}

/**
 * One tick.
 * @param {ReturnType<typeof spawnPlayer>} p
 * @param {number} input INPUT bitmask
 * @param {number} tick the server tick this input is for; enemies are where they are at this tick
 * @param {ReturnType<typeof createSim>} sim
 * @param {Record<number, number>} kills spawner id → kill tick (enemies.js enemyPhase)
 * @param {({type: 'died', cause: string} | {type: 'stomp', id: number, tick: number})[]} [out] events are pushed here
 * @returns a new state (p is not modified)
 */
export function stepPlayer(p, input, tick, sim, kills, out, t = TUNING) {
  if (p.dead > 0) {
    if (p.dead > 1) return { ...p, dead: p.dead - 1, buttons: input };
    // Respawn. A jump held through the fade doesn't fire on the first tick.
    return { ...spawnPlayer(sim, p.home, t), buttons: input };
  }
  if (input & INPUT.RESPAWN) return die(p, CAUSE.GAVE_UP, out);

  const s = step(p, input & ~INPUT.RESPAWN, sim.map, t);
  const post = postAt(sim.posts, s, t);
  if (post) s.home = post.id;

  const hx = s.x + HURT.side, hy = s.y + HURT.top, hw = t.width - 2 * HURT.side, hh = t.height - HURT.top;
  if (sim.spawners.length) {
    for (const i of enemiesNear(sim.index, hx, hy, hx + hw, hy + hh)) {
      const sp = sim.spawners[i];
      if (enemyPhase(kills, sp.id, tick) !== PHASE.ALIVE) continue;
      const pose = enemyAt(sp, tick);
      const hit = enemyHit(pose, hx, hy, hw, hh);
      if (hit === HIT.NONE) continue;
      const prevBottom = p.y + t.height;
      if (hit === HIT.BODY && STOMPABLE[sp.kind] && p.vy >= 0 && prevBottom <= pose.box.y + STOMP_SLACK) {
        // Stomp: bounce off like a jump (releasing jump cuts it), and the enemy dies.
        s.y = Math.min(s.y, Math.max(p.y, pose.box.y - t.height));
        s.vy = -t.stompVel;
        s.jumping = true;
        s.onGround = false;
        s.coyote = 0;
        s.jumpBuffer = 0;
        out?.push({ type: 'stomp', id: sp.id, tick });
        continue;
      }
      return die(s, sp.kind, out);
    }
  }
  if (touchesSpikes(sim.map, hx, hy, hw, hh)) return die(s, CAUSE.SPIKES, out);
  return s;
}

function die(s, cause, out) {
  out?.push({ type: 'died', cause });
  return { ...s, vx: 0, vy: 0, jumping: false, dead: DEATH_TICKS };
}

/**
 * Whether the rect touches a spike's teeth. A spike points away from the solid
 * tile it sits on (below, else above, else left, else right: the same rule the
 * renderer draws it with), and only the 10 px nearest that base hurt, inset 2 px
 * at the sides. A spike with no solid neighbour hurts inset 3 px all round.
 */
export function touchesSpikes(map, x, y, w, h) {
  const tx0 = Math.floor(x / TILE_SIZE), tx1 = Math.floor((x + w - 1) / TILE_SIZE);
  const ty0 = Math.floor(y / TILE_SIZE), ty1 = Math.floor((y + h - 1) / TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!(TILE_FLAGS[tileAt(map, tx, ty)] & FLAG.HAZARD)) continue;
      const solid = (dx, dy) => (TILE_FLAGS[tileAt(map, tx + dx, ty + dy)] & FLAG.SOLID) !== 0;
      let l = 3, r = 3, top = 3, bot = 3; // inset from each side of the tile
      if (solid(0, 1)) { l = r = 2; top = 6; bot = 0; }
      else if (solid(0, -1)) { l = r = 2; top = 0; bot = 6; }
      else if (solid(-1, 0)) { top = bot = 2; l = 0; r = 6; }
      else if (solid(1, 0)) { top = bot = 2; l = 6; r = 0; }
      const kx = tx * TILE_SIZE + l, ky = ty * TILE_SIZE + top;
      const kw = TILE_SIZE - l - r, kh = TILE_SIZE - top - bot;
      if (x < kx + kw && kx < x + w && y < ky + kh && ky < y + h) return true;
    }
  }
  return false;
}
