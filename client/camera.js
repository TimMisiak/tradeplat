// Camera: follows a target with look-ahead, stays inside the map, and snaps
// to whole pixels (the renderer rounds). See ARCHITECTURE.md § Rendering.
// Client-only and not simulation, so Math.exp etc. are fine here.
import { VIEW_H, VIEW_W } from './gpu/renderer.js';
import { TILE_SIZE } from '../shared/tiles.js';

const FOLLOW_RATE = 10; // 1/s: higher means tighter follow
const LOOK_RATE = 3; // 1/s: how quickly the look-ahead shifts after a turn
const LOOK_AHEAD = 48; // px ahead of the player at full run
const LOOK_VX_FULL = 3; // px/tick that counts as "full run" for look-ahead
const VERTICAL_BIAS = 30; // px: show a bit more above than below the player

export function createCamera() {
  const cam = { x: 0, y: 0, look: 0 };

  /** Jump straight to the target (spawn, respawn, teleport). */
  function snap(tx, ty, map) {
    cam.look = 0;
    cam.x = tx - VIEW_W / 2;
    cam.y = ty - VIEW_H / 2 - VERTICAL_BIAS;
    clampToMap(map);
  }

  /** @param {number} dt seconds since the last frame */
  function update(tx, ty, vx, dt, map) {
    const lookTarget = Math.max(-1, Math.min(1, vx / LOOK_VX_FULL)) * LOOK_AHEAD;
    cam.look += (lookTarget - cam.look) * (1 - Math.exp(-LOOK_RATE * dt));
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    cam.x += (tx + cam.look - VIEW_W / 2 - cam.x) * k;
    cam.y += (ty - VIEW_H / 2 - VERTICAL_BIAS - cam.y) * k;
    clampToMap(map);
  }

  function clampToMap(map) {
    const mw = map.w * TILE_SIZE, mh = map.h * TILE_SIZE;
    cam.x = mw <= VIEW_W ? (mw - VIEW_W) / 2 : Math.max(0, Math.min(mw - VIEW_W, cam.x));
    cam.y = mh <= VIEW_H ? (mh - VIEW_H) / 2 : Math.max(0, Math.min(mh - VIEW_H, cam.y));
  }

  return { cam, snap, update };
}
