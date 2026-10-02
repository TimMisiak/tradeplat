// Death juice (DESIGN.md § Visual direction): a splat burst, stains left on the
// level for a while, screen shake, and the fade to and from black around a
// respawn. Client-only and cosmetic, so Math.random and wall-clock time are fine.
import { TICK_RATE } from '../shared/physics.js';

const GRAVITY = 900; // px/s² for burst particles
const MAX_STAINS = 64;
const STAIN_S = 90; // a stain lasts this long, fading out over the last 10 s

export function createFx() {
  /** @type {{x: number, y: number, vx: number, vy: number, life: number, size: number}[]} */
  const parts = [];
  /** @type {{x: number, y: number, w: number, h: number, at: number}[]} */
  const stains = [];
  /** @type {{x: number, y: number, vx: number, vy: number, life: number}[]} */
  const puffs = [];
  let shake = 0;

  return {
    /** A player died at (x, y) (centre). `big` adds screen shake (our own death). */
    splat(x, y, now, big = false) {
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * 180;
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, life: 0.5 + Math.random() * 0.4, size: 2 + Math.floor(Math.random() * 3) });
      }
      for (let i = 0; i < 4; i++) {
        stains.push({ x: x - 8 + Math.random() * 16, y: y - 4 + Math.random() * 12, w: 2 + Math.floor(Math.random() * 5), h: 2 + Math.floor(Math.random() * 3), at: now });
      }
      while (stains.length > MAX_STAINS) stains.shift();
      if (big) shake = 0.35;
    },
    /** An enemy was stomped at (x, y). */
    puff(x, y) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        puffs.push({ x, y, vx: Math.cos(a) * 70, vy: Math.sin(a) * 40, life: 0.35 });
      }
    },
    /** Advance particles. dt in seconds. */
    update(dt) {
      for (const p of parts) {
        p.vy += GRAVITY * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
      }
      for (const p of puffs) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
      for (const list of [parts, puffs]) for (let i = list.length - 1; i >= 0; i--) if (list[i].life <= 0) list.splice(i, 1);
      shake = Math.max(0, shake - dt);
    },
    /** Camera offset in px for the screen shake. */
    shakeOffset() {
      if (shake <= 0) return [0, 0];
      const k = 6 * (shake / 0.35);
      return [Math.round((Math.random() * 2 - 1) * k), Math.round((Math.random() * 2 - 1) * k)];
    },
    /** Stains under everything else, particles over. */
    drawStains(batch, color, now) {
      for (const s of stains) {
        const age = (now - s.at) / 1000;
        if (age > STAIN_S) continue;
        batch.push(s.x, s.y, s.w, s.h, [color[0], color[1], color[2], 0.75 * Math.min(1, (STAIN_S - age) / 10)]);
      }
    },
    drawParticles(batch, color, puffColor) {
      for (const p of parts) batch.push(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size, color);
      for (const p of puffs) batch.push(p.x - 2, p.y - 2, 4, 4, [puffColor[0], puffColor[1], puffColor[2], Math.min(1, p.life / 0.2)]);
    },
    clear() { parts.length = 0; stains.length = 0; puffs.length = 0; shake = 0; },
  };
}

/**
 * How dark the screen is (0..1) while dead: clear for the splat, then a fade to
 * black that lifts again on the first ticks after the respawn.
 * @param {number} dead the state's ticks left before respawning (0 = alive)
 * @param {number} sinceRespawn ticks since the last respawn
 */
export function fadeAlpha(dead, sinceRespawn) {
  const FADE = 14;
  if (dead > 0) return Math.min(1, Math.max(0, (FADE - dead) / FADE + 0.15));
  return Math.max(0, 1 - sinceRespawn / (TICK_RATE / 5));
}
