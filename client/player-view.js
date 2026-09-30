// How a player is drawn: animation state from physics state, and sprite or
// flat-color fallback instances. Used for the local player now, and for ghosts in M3.
import { TUNING } from '../shared/physics.js';

/** Which animation fits this physics state. Names match SPRITE_SPEC.player (ART.md). */
export function animFor(p) {
  if (p.onGround) return Math.abs(p.vx) > 0.1 ? 'run' : 'idle';
  if (p.wallDir !== 0 && p.vy > 0) return 'wallSlide';
  return p.vy < 0 ? 'jump' : 'fall';
}

/** Tracks when the current animation started, so frames play from 0 on a change. */
export function createAnimator() {
  let current = '';
  let start = 0;
  return {
    /** @returns {{anim: string, t: number}} t = seconds into the animation */
    update(anim, now) {
      if (anim !== current) { current = anim; start = now; }
      return { anim, t: now - start };
    },
  };
}

/**
 * Push a player into the sprite batch.
 * @param {import('./gpu/renderer.js').SpriteBatch} batch
 * @param {{x: number, y: number}} pos interpolated hitbox top-left
 * @param {import('../shared/physics.js').PlayerState} p latest state (facing, wall, etc.)
 * @param {{anim: string, t: number}} anim
 * @param {{player: number[], outline: number[]}} colors
 * @param {import('./assets.js').LoadedSprite | undefined} sprite
 */
export function drawPlayer(batch, pos, p, anim, colors, sprite, tuning = TUNING) {
  const footX = pos.x + tuning.width / 2;
  const footY = pos.y + tuning.height;
  // Face the wall while sliding. The art has the wall on the right.
  const facing = anim.anim === 'wallSlide' ? p.wallDir : p.facing;

  const a = sprite?.anims[anim.anim] ?? sprite?.anims.idle;
  if (sprite && a) {
    const n = a.frames.length;
    const i = Math.floor(anim.t * a.fps);
    const [u0, v0, u1, v1] = a.frames[a.loop ? i % n : Math.min(i, n - 1)];
    const [fw, fh] = sprite.frame;
    const [ax, ay] = sprite.anchor;
    // Mirror around the anchor when facing left.
    const x = facing < 0 ? footX - (fw - ax) : footX - ax;
    batch.push(x, footY - ay, fw, fh, [1, 1, 1, 1], facing < 0 ? [u1, v0, u0, v1] : [u0, v0, u1, v1]);
    return;
  }

  // Flat-color fallback: outlined hitbox with an "eye" on the facing side.
  const { width: w, height: h } = tuning;
  batch.push(pos.x - 1, pos.y - 1, w + 2, h + 2, colors.outline);
  batch.push(pos.x, pos.y, w, h, colors.player);
  const eyeX = facing > 0 ? pos.x + w - 4 : pos.x + 2;
  batch.push(eyeX, pos.y + 4, 2, 3, colors.outline);
}
