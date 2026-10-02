// How enemies are drawn: sprite art from the manifest where it's loaded, flat
// palette shapes otherwise (ART.md). Positions come from shared/enemies.js at the
// render tick, so they match what prediction collides with.
import { ENEMY, PHASE, enemyAt, enemyPhase, enemiesNear } from '../shared/enemies.js';
import { TICK_RATE } from '../shared/physics.js';

/**
 * Draw every enemy that may be in view.
 * @param {import('./gpu/renderer.js').SpriteBatch} batch
 * @param {ReturnType<import('../shared/sim.js').createSim>} sim
 * @param {Record<number, number>} kills spawner id → kill tick
 * @param {number} tick render tick (fractional)
 * @param {{x: number, y: number, w: number, h: number}} view world px, with margin
 * @param {Record<string, import('./assets.js').LoadedSprite>} sprites
 * @param {{enemy: number[], hazard: number[], dark: number[], steel: number[]}} colors
 */
export function drawEnemies(batch, sim, kills, tick, view, sprites, colors) {
  if (!sim.spawners.length) return;
  for (const i of enemiesNear(sim.index, view.x, view.y, view.x + view.w, view.y + view.h)) {
    const sp = sim.spawners[i];
    const phase = enemyPhase(kills, sp.id, Math.floor(tick));
    if (phase === PHASE.DEAD) continue;
    // Respawning: blink, harmless.
    if (phase === PHASE.SPAWNING && Math.floor(tick / 4) % 2 === 0) continue;
    const pose = enemyAt(sp, tick);
    if (sp.kind === 'patroller') drawPatroller(batch, pose, tick, sprites.patroller, colors);
    else if (sp.kind === 'flyer') drawFlyer(batch, pose, tick, sprites.flyer, colors);
    else drawSaw(batch, pose, tick, sprites.saw, colors);
  }
}

/** Frame `i` (wrapping or clamped) of an animation, or null if the sprite lacks it. */
function frameOf(sprite, anim, i) {
  const a = sprite?.anims[anim];
  if (!a) return null;
  const n = a.frames.length;
  return a.frames[a.loop ? ((i % n) + n) % n : Math.min(Math.max(0, i), n - 1)];
}

/** Push a sprite frame anchored at (x, y), mirrored around the anchor when facing left. */
function pushSprite(batch, sprite, uv, x, y, facing, tint = [1, 1, 1, 1]) {
  const [fw, fh] = sprite.frame;
  const [ax, ay] = sprite.anchor;
  const left = facing < 0 ? x - (fw - ax) : x - ax;
  batch.push(left, y - ay, fw, fh, tint, facing < 0 ? [uv[2], uv[1], uv[0], uv[3]] : uv);
}

const seconds = (tick) => tick / TICK_RATE;

function drawPatroller(batch, pose, tick, sprite, c) {
  if (sprite) {
    const walk = sprite.anims.walk;
    let uv;
    if (pose.anim === 'swing') uv = frameOf(sprite, 'swing', pose.frame);
    else if (pose.anim === 'walk') uv = frameOf(sprite, 'walk', Math.floor(seconds(tick) * walk.fps));
    uv ??= frameOf(sprite, 'walk', 0);
    pushSprite(batch, sprite, uv, pose.x, pose.y, pose.facing);
    return;
  }
  const b = pose.box;
  batch.push(b.x - 1, b.y - 1, b.w + 2, b.h + 2, c.dark);
  batch.push(b.x, b.y, b.w, b.h, c.enemy);
  batch.push(pose.facing > 0 ? b.x + b.w - 4 : b.x + 2, b.y + 3, 2, 2, c.dark);
  if (pose.anim === 'swing' && pose.frame === 0) {
    // Wind-up: the sword raised behind the head.
    batch.push(pose.facing > 0 ? b.x - 2 : b.x + b.w - 1, b.y - 8, 3, 9, c.steel);
  }
  if (pose.attack) {
    const a = pose.attack;
    batch.push(a.x, a.y + a.h / 2 - 1, a.w, 3, c.steel);
  }
}

function drawFlyer(batch, pose, tick, sprite, c) {
  if (sprite) {
    const fly = sprite.anims.fly;
    pushSprite(batch, sprite, frameOf(sprite, 'fly', Math.floor(seconds(tick) * fly.fps)), pose.x, pose.y, pose.facing);
    return;
  }
  const b = pose.box;
  const flap = Math.floor(tick / 6) % 2 === 0 ? -3 : 1;
  batch.push(b.x - 4, b.y + 4 + flap, 4, 3, c.enemy);
  batch.push(b.x + b.w, b.y + 4 + flap, 4, 3, c.enemy);
  batch.push(b.x - 1, b.y - 1, b.w + 2, b.h + 2, c.dark);
  batch.push(b.x, b.y, b.w, b.h, c.enemy);
  batch.push(pose.facing > 0 ? b.x + b.w - 4 : b.x + 2, b.y + 4, 2, 2, c.dark);
}

function drawSaw(batch, pose, tick, sprite, c) {
  if (sprite) {
    const spin = sprite.anims.spin;
    pushSprite(batch, sprite, frameOf(sprite, 'spin', Math.floor(seconds(tick) * spin.fps)), pose.x, pose.y, Math.floor(tick / 3) % 2 ? 1 : -1);
    return;
  }
  // A rough disc (two crossed rects), teeth turning around it, and a hub.
  const r = ENEMY.saw.r, x = pose.x, y = pose.y;
  const k = Math.round(r * 0.72);
  batch.push(x - r, y - k, 2 * r, 2 * k, c.hazard);
  batch.push(x - k, y - r, 2 * k, 2 * r, c.hazard);
  for (let i = 0; i < 6; i++) {
    const a = tick * 0.25 + (i * Math.PI) / 3;
    batch.push(x + Math.cos(a) * (r + 1) - 2, y + Math.sin(a) * (r + 1) - 2, 4, 4, c.hazard);
  }
  batch.push(x - 3, y - 3, 6, 6, c.dark);
}
