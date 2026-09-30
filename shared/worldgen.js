// Procedural world: seed → tile map + trade posts. See WORLDGEN.md.
//
// Deterministic: all randomness comes from shared/rng.js, and all math is exact
// IEEE-754 (no Math.sin/pow/random). Client and server run this with the same
// seed and must get the same tiles and the same hash.
// Bump GEN_VERSION whenever the output for a given seed changes.
import { createRng, hashString } from './rng.js';
import { fbm, noise1, noise2 } from './noise.js';
import { FLAG, SLOPE, TILE, TILE_FLAGS, createMap } from './tiles.js';

export const GEN_VERSION = 2;
export const WORLD_W = 1024;
export const WORLD_H = 256;

/**
 * What worldgen assumes the player can do, in tiles. Deliberately below what the
 * physics allows, and independent of TUNING so feel tweaks don't change maps.
 * test/worldgen.test.js checks that the physics still beats these numbers.
 */
export const ENVELOPE = Object.freeze({
  stepUp: 3, // platforms stacked at most this many rows apart
  gap: 4, // at most this many tiles of horizontal travel without support
});

/** A route runs diagonally (on ramps) until it lags its target height by more than this; then it goes vertical. */
const ROUTE_MAX_LAG = 4;

// Post prefab (tiles)
const POST_W = 14;
const POST_H = 7; // roof row + 3 wall rows + 3 doorway rows
const POST_PAD = 3; // cleared air around the room; landing platforms this long
const POST_NO_SPAWN = 6; // hazard/spawner-free margin around a post

const MAX_ATTEMPTS = 8;
const MAX_REPAIR_ROUNDS = 3;

/**
 * @typedef {{
 *   id: number, name: string, kind: 'surface'|'cave'|'sky', colorIndex: number,
 *   x: number, y: number, w: number, h: number,
 *   zone: {x0: number, y0: number, x1: number, y1: number},
 *   noSpawn: {x0: number, y0: number, x1: number, y1: number},
 *   doors: {tx: number, ty: number}[],
 *   spawn: {tx: number, ty: number},
 * }} Post
 * All coordinates are in tiles. `spawn` and `doors` are the tile a player's feet occupy.
 *
 * @typedef {import('./tiles.js').TileMap & {
 *   version: number, seed: number, attempt: number,
 *   posts: Post[], spawnPost: number, spawners: object[], hash: string,
 *   stats: {tunnels: number, platforms: number, ramps: number, reachable: number},
 *   debug: {routes: [number, number][][], edges: [number, number][]},
 * }} World
 */

/**
 * @param {number} seed 32-bit integer
 * @param {{w?: number, h?: number}} [opts]
 * @returns {World}
 */
export function generateWorld(seed, opts = {}) {
  const w = opts.w ?? WORLD_W;
  const h = opts.h ?? WORLD_H;
  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptSeed = attempt === 0 ? seed >>> 0 : hashString(`attempt:${attempt}`, seed >>> 0);
    const result = tryGenerate(attemptSeed, w, h);
    if (result.ok) {
      const world = result.world;
      world.seed = seed >>> 0;
      world.attempt = attempt;
      world.hash = hashWorld(world);
      return world;
    }
    lastError = result.error;
  }
  throw new Error(`worldgen: seed ${seed} failed ${MAX_ATTEMPTS} attempts (${lastError})`);
}

function tryGenerate(seed, w, h) {
  const rng = createRng(seed);
  const map = createMap(w, h);
  const surface = terrain(map, rng.fork('terrain'));
  const posts = planPosts(rng.fork('posts'), surface, h);
  if (posts.length < 2) return { ok: false, error: 'too few posts' };
  // Surface posts sit on flattened ground. Ramp the terrain into those flats, then paint it.
  const locked = new Uint8Array(w);
  for (const p of posts) if (p.kind === 'surface') locked.fill(1, p.x - POST_PAD - 1, p.x + p.w + POST_PAD + 1);
  relaxSurface(surface, locked);
  paintSurface(map, surface);
  for (const p of posts) stampPost(map, p);
  const { routes, edges } = carveRoutes(map, rng.fork('routes'), posts);
  const stats = { tunnels: 0, platforms: 0, ramps: 0, reachable: 0 };
  stats.platforms += addPlatforms(map, routes);

  // Reachability v1: flood fill from the spawn post, repairing with tunnels.
  const spawnPost = posts.find((p) => p.isSpawn).id;
  for (let round = 0; ; round++) {
    const { visited, count } = floodFill(map, posts[spawnPost].spawn);
    const unreached = posts.filter((p) => !zoneReached(map, visited, p.zone));
    stats.reachable = count;
    if (unreached.length === 0) break;
    if (round >= MAX_REPAIR_ROUNDS) return { ok: false, error: `${unreached.length} posts unreachable` };
    for (const post of unreached) {
      const tunnel = carveTunnel(map, visited, post.doors[0]);
      if (tunnel) {
        routes.push(tunnel);
        stats.tunnels++;
        stats.platforms += addPlatforms(map, [tunnel]);
      }
    }
  }

  // Every 1-tile floor step (terrain, routes, caves, tunnels) becomes a ramp.
  stats.ramps = rampify(map);
  for (const p of posts) delete p.isSpawn;
  return {
    ok: true,
    world: {
      version: GEN_VERSION, seed: 0, attempt: 0,
      w, h, tiles: map.tiles,
      posts, spawnPost,
      spawners: [], // stage 5 (hazards + spawners) lands in M5
      hash: '',
      stats,
      debug: { routes, edges },
    },
  };
}

// Helpers

const idx = (map, x, y) => y * map.w + x;
const inside = (map, x, y) => x >= 0 && y >= 0 && x < map.w && y < map.h;
function set(map, x, y, id) {
  if (inside(map, x, y)) map.tiles[idx(map, x, y)] = id;
}
function get(map, x, y) {
  return inside(map, x, y) ? map.tiles[idx(map, x, y)] : TILE.solid;
}
function fillRect(map, x0, y0, x1, y1, id) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(map, x, y, id);
}
/**
 * Carve the space a path point needs: its column from the feet row up 3 rows,
 * and 3 rows of headroom in the next column. The next column's feet row is left
 * for the next point to decide, so on a diagonal each column's floor sits right
 * under its own point (1-tile steps that rampify turns into ramps).
 */
function brush(map, x, y) {
  for (let dy = -3; dy <= 0; dy++) carve(map, x, y + dy);
  for (let dy = -3; dy <= -1; dy++) carve(map, x + 1, y + dy);
}

/** Clear to empty, leaving trade post tiles alone. */
function carve(map, x, y) {
  if (!inside(map, x, y)) return;
  const i = idx(map, x, y);
  if (!(TILE_FLAGS[map.tiles[i]] & FLAG.POST)) map.tiles[i] = TILE.empty;
}
const isSolid = (map, x, y) => (TILE_FLAGS[get(map, x, y)] & FLAG.SOLID) !== 0;

// Stage 1: terrain

/**
 * Noise terrain: surface heights, caves and islands. Returns the surface row (top
 * solid tile) of each column. The surface itself is painted later by paintSurface,
 * once posts have flattened their ground.
 */
function terrain(map, rng) {
  const { w, h } = map;
  const sSurface = rng.u32(), sCave = rng.u32(), sIsland = rng.u32();

  // Surface height: rolling hills from 1D noise, changing by at most one row per
  // column so every change can be a 45° ramp.
  const surface = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const n = fbm(noise1, x / 64, 0, sSurface, 4);
    const raw = Math.max(40, Math.min(h - 70, Math.round(h * 0.38 + (n - 0.5) * 90)));
    surface[x] = x === 0 ? raw : surface[x - 1] + Math.sign(raw - surface[x - 1]);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = surface[x];
      let solid = y >= s;
      if (solid && y > s + 6 && y < h - 4) {
        // Caves, more open with depth.
        const depth = (y - s) / (h - s);
        const n = fbm(noise2, x / 24, y / 14, sCave, 3);
        if (n > 0.6 - depth * 0.08) solid = false;
      } else if (!solid && y > 12 && y < s - 14) {
        // Floating islands in the sky.
        const n = fbm(noise2, x / 18, y / 8, sIsland, 2);
        if (n > 0.7) solid = true;
      }
      map.tiles[y * w + x] = solid ? TILE.solid : TILE.empty;
    }
  }

  // Cellular-automaton smoothing removes single-tile noise from caves and islands.
  for (let pass = 0; pass < 2; pass++) smooth(map);
  return surface;
}

/**
 * Make neighbouring columns differ by at most one row (so a ramp fits), keeping
 * `locked` columns (post flats) fixed. Then remove 1-wide peaks, which rampify
 * leaves as blocks (one tile can't be both '/' and '\\').
 */
function relaxSurface(surface, locked) {
  const w = surface.length;
  for (let iter = 0; iter < 32; iter++) {
    let changed = false;
    for (let x = 1; x < w; x++) {
      if (locked[x]) continue;
      const v = Math.max(surface[x - 1] - 1, Math.min(surface[x - 1] + 1, surface[x]));
      if (v !== surface[x]) { surface[x] = v; changed = true; }
    }
    for (let x = w - 2; x >= 0; x--) {
      if (locked[x]) continue;
      const v = Math.max(surface[x + 1] - 1, Math.min(surface[x + 1] + 1, surface[x]));
      if (v !== surface[x]) { surface[x] = v; changed = true; }
    }
    if (!changed) break;
  }
  for (let x = 1; x < w - 1; x++) {
    if (!locked[x] && surface[x] < surface[x - 1] && surface[x] < surface[x + 1]) surface[x]++;
  }
}

/**
 * Paint the surface over the noise terrain: 14 rows of clear air above and a 5-row
 * solid crust. Height changes are single-row steps here; rampify turns them into ramps.
 */
function paintSurface(map, surface) {
  const { w, h } = map;
  for (let x = 0; x < w; x++) {
    const s = surface[x];
    fillRect(map, x, s - 14, x, s - 1, TILE.empty);
    fillRect(map, x, s, x, s + 4, TILE.solid);
  }
  // Bedrock frame: walls at the sides, floor at the bottom.
  fillRect(map, 0, 0, 1, h - 1, TILE.solid);
  fillRect(map, w - 2, 0, w - 1, h - 1, TILE.solid);
  fillRect(map, 0, h - 3, w - 1, h - 1, TILE.solid);
}

function smooth(map) {
  const { w, h, tiles } = map;
  const next = new Uint8Array(tiles);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && isSolid(map, x + dx, y + dy)) n++;
        }
      }
      if (n >= 5) next[y * w + x] = TILE.solid;
      else if (n <= 3) next[y * w + x] = TILE.empty;
    }
  }
  tiles.set(next);
}

// Stages 2 + 3: trade posts

const NAME_START = ['Rust', 'Sky', 'Salt', 'Iron', 'Ash', 'Cinder', 'Moss', 'Brine', 'Copper', 'Dusk', 'Hollow', 'Stone', 'Ember', 'Frost', 'Gale', 'Thorn'];
const NAME_END = ['mouth', 'hold', 'reach', 'haven', 'gate', 'rest', 'mark', 'post', 'fall', 'crag', 'well', 'deep', 'watch', 'ford'];

/** Decide where posts go. Surface posts flatten `surface` under their footprint. */
function planPosts(rng, surface, h) {
  const w = surface.length;
  const count = rng.int(8, 12);
  const margin = 40;
  const slot = (w - margin * 2) / count;
  const spawnIndex = Math.floor(count / 2); // near the horizontal middle
  const names = new Set();
  const colors = rng.shuffle(Array.from({ length: 12 }, (_, i) => i));
  const posts = [];

  for (let i = 0; i < count; i++) {
    const cx = Math.floor(margin + slot * (i + 0.5) + rng.range(-0.2, 0.2) * slot);
    const x0 = cx - (POST_W >> 1);
    const x1 = x0 + POST_W - 1;

    // Pick the kind, then the floor row.
    let kind = i === spawnIndex ? 'surface' : rng.pick(['surface', 'surface', 'cave', 'cave', 'sky']);
    let top = h;
    for (let x = x0 - POST_PAD; x <= x1 + POST_PAD; x++) top = Math.min(top, surface[x]);
    let floor;
    if (kind === 'sky' && top - 30 < 24) kind = 'surface';
    if (kind === 'cave' && surface[cx] + 25 > h - 20) kind = 'surface';
    if (kind === 'surface') {
      // Flatten the footprint plus one column each side, so ground at floor level
      // meets the ends of the landing platforms before any ramp starts.
      floor = surface[cx];
      for (let x = x0 - POST_PAD - 1; x <= x1 + POST_PAD + 1; x++) surface[x] = floor;
    } else if (kind === 'cave') floor = rng.int(surface[cx] + 25, h - 20);
    else floor = rng.int(24, top - 30);

    let name;
    do name = rng.pick(NAME_START) + rng.pick(NAME_END); while (names.has(name));
    names.add(name);

    const roof = floor - POST_H + 1;
    posts.push({
      id: i,
      name,
      kind,
      colorIndex: colors[i % colors.length],
      x: x0, y: roof, w: POST_W, h: POST_H,
      zone: { x0: x0 + 1, y0: roof + 1, x1: x1 - 1, y1: floor - 1 },
      noSpawn: { x0: x0 - POST_NO_SPAWN, y0: roof - POST_NO_SPAWN, x1: x1 + POST_NO_SPAWN, y1: floor + 2 },
      doors: [{ tx: x0 - 2, ty: floor - 1 }, { tx: x1 + 2, ty: floor - 1 }],
      spawn: { tx: cx, ty: floor - 1 },
      isSpawn: i === spawnIndex,
    });
  }
  return posts;
}

/** Clear air around the room, lay the floor with its landing platforms, and build the shell. */
function stampPost(map, p) {
  const x0 = p.x, x1 = p.x + p.w - 1;
  const roof = p.y, floor = p.y + p.h - 1;
  fillRect(map, x0 - POST_PAD, roof - POST_PAD, x1 + POST_PAD, floor - 1, TILE.empty);
  fillRect(map, x0 - POST_PAD, floor, x1 + POST_PAD, floor, TILE.postFloor);
  fillRect(map, x0, roof, x1, roof, TILE.postWall);
  fillRect(map, x0, roof + 1, x0, roof + 3, TILE.postWall);
  fillRect(map, x1, roof + 1, x1, roof + 3, TILE.postWall);
}

// Stage 4: routes

/** Minimum spanning tree over post centres (Prim), plus up to two extra edges for loops. */
function routeEdges(rng, posts) {
  const n = posts.length;
  const dist = (a, b) => Math.abs(posts[a].spawn.tx - posts[b].spawn.tx) + Math.abs(posts[a].spawn.ty - posts[b].spawn.ty);
  const inTree = new Array(n).fill(false);
  inTree[0] = true;
  const edges = [];
  const has = (a, b) => edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
  for (let k = 1; k < n; k++) {
    let best = null;
    for (let a = 0; a < n; a++) {
      if (!inTree[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inTree[b]) continue;
        const d = dist(a, b);
        if (!best || d < best[2]) best = [a, b, d];
      }
    }
    inTree[best[1]] = true;
    edges.push([best[0], best[1]]);
  }
  const candidates = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (!has(a, b)) candidates.push([a, b, dist(a, b)]);
  candidates.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
  const extras = rng.int(1, 2);
  for (const [a, b] of rng.shuffle(candidates.slice(0, 6)).slice(0, extras)) edges.push([a, b]);
  return edges;
}

function carveRoutes(map, rng, posts) {
  const edges = routeEdges(rng, posts);
  const routes = [];
  for (const [ia, ib] of edges) {
    // Leave and arrive just past the ends of the landing platforms, at floor level,
    // so a route never runs into a platform from below.
    const [a, b] = posts[ia].spawn.tx <= posts[ib].spawn.tx ? [posts[ia], posts[ib]] : [posts[ib], posts[ia]];
    const start = { tx: a.x + a.w + POST_PAD, ty: a.spawn.ty };
    const end = { tx: b.x - POST_PAD - 1, ty: b.spawn.ty };
    const path = meander(rng, start, end, map.h);
    for (const [x, y] of path) brush(map, x, y);
    routes.push(path);
  }
  return { routes, edges };
}

/**
 * A path from start to end that never goes backwards in x. It follows a noisy
 * curve between the two, moving diagonally (one row per column, on ramps laid by
 * placeRamps) and going straight up or down only when it lags the curve by more
 * than ROUTE_MAX_LAG rows. Opposite diagonals always have a flat step between
 * them, since one floor tile can't be both '/' and '\\'.
 */
function meander(rng, start, end, h) {
  const seed = rng.u32();
  const span = Math.max(1, end.tx - start.tx);
  const amp = Math.min(24, span * 0.25);
  const wantAt = (x) => {
    const t = (x - start.tx) / span;
    const bulge = 4 * t * (1 - t); // 0 at the ends, 1 in the middle
    const v = Math.round(start.ty + (end.ty - start.ty) * t + (fbm(noise1, x / 24, 0, seed, 2) - 0.5) * 2 * amp * bulge);
    return Math.max(6, Math.min(h - 6, v));
  };
  const path = [];
  let x = start.tx, y = start.ty, lastDy = 0;
  path.push([x, y]);
  while (x < end.tx) {
    const want = wantAt(x + 1);
    if (Math.abs(want - y) > ROUTE_MAX_LAG) {
      // Too steep for ramps: go straight to within a row of the curve.
      while (Math.abs(want - y) > 1) { y += Math.sign(want - y); path.push([x, y]); }
      lastDy = 0;
    }
    let dy = Math.sign(want - y);
    if (dy !== 0 && dy === -lastDy) dy = 0;
    x++;
    y += dy;
    lastDy = dy;
    path.push([x, y]);
  }
  while (y !== end.ty) { y += Math.sign(end.ty - y); path.push([x, y]); }
  return path;
}

/**
 * Turn every 1-tile floor step into a 45° ramp. A step up to the right at column c
 * and feet row y looks like this (and mirrored for a step up to the left):
 *
 *     . . .      y-2   headroom over the ramp (the player is taller than a tile)
 *     . . .      y-1
 *     . # #      y     c becomes '/'; c+1 must be solid, so the ground continues
 *     # # #      y+1
 *    c-1 c c+1
 *
 * Only plain `solid` tiles become ramps, never post tiles. Conditions are read
 * from a snapshot, so ramps placed in this pass don't affect each other.
 * Returns the number of ramps placed.
 */
export function rampify(map) {
  const { w, h } = map;
  const snap = new Uint8Array(map.tiles);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? TILE.solid : snap[y * w + x]);
  const solid = (x, y) => (TILE_FLAGS[at(x, y)] & FLAG.SOLID) !== 0;
  const open = (x, y) => (TILE_FLAGS[at(x, y)] & (FLAG.SOLID | SLOPE)) === 0;
  let placed = 0;
  for (let y = 3; y < h - 1; y++) {
    for (let x = 3; x < w - 3; x++) {
      if (at(x, y) !== TILE.solid || !open(x, y - 1) || !open(x, y - 2)) continue;
      // Step up to the right: stand at x-1, the ground continues at x+1.
      if (open(x - 1, y) && open(x - 1, y - 1) && solid(x - 1, y + 1) && solid(x + 1, y)) {
        map.tiles[y * w + x] = TILE.slopeR;
        placed++;
      } else if (open(x + 1, y) && open(x + 1, y - 1) && solid(x + 1, y + 1) && solid(x - 1, y)) {
        map.tiles[y * w + x] = TILE.slopeL;
        placed++;
      }
    }
  }
  return placed;
}

/**
 * Walk each path and drop one-way platforms wherever the player would have gone
 * too far (in ENVELOPE terms) without anything to stand on. Returns the count.
 */
function addPlatforms(map, paths) {
  let placed = 0;
  const supported = (x, y) => {
    for (let dy = 1; dy <= 2; dy++) {
      const f = TILE_FLAGS[get(map, x, y + dy)] | TILE_FLAGS[get(map, x + 1, y + dy)];
      if (f & (FLAG.SOLID | FLAG.ONE_WAY | SLOPE)) return true;
    }
    return false;
  };
  for (const path of paths) {
    let last = null;
    for (const [x, y] of path) {
      if (supported(x, y)) { last = { x, y }; continue; }
      if (!last) { last = { x, y }; continue; }
      if (x - last.x > ENVELOPE.gap || last.y - y >= ENVELOPE.stepUp) {
        for (let px = x - 1; px <= x + 2; px++) {
          if (get(map, px, y + 1) === TILE.empty) set(map, px, y + 1, TILE.oneWay);
        }
        placed++;
        last = { x, y };
      } else if (y > last.y) {
        // Dropping is always fine, but measure the next climb from the lowest point.
        last = { x: last.x, y };
      }
    }
  }
  return placed;
}

// Stage 6: reachability

/** 4-connected flood fill over tiles a player can occupy (not solid, not hazard). */
export function floodFill(map, start) {
  const { w, h, tiles } = map;
  const visited = new Uint8Array(w * h);
  const blocked = FLAG.SOLID | FLAG.HAZARD;
  const stack = new Int32Array(w * h);
  let sp = 0, count = 0;
  const s = start.ty * w + start.tx;
  if (TILE_FLAGS[tiles[s]] & blocked) return { visited, count };
  visited[s] = 1;
  stack[sp++] = s;
  while (sp > 0) {
    const i = stack[--sp];
    count++;
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return { visited, count };
  function push(j) {
    if (!visited[j] && !(TILE_FLAGS[tiles[j]] & blocked)) { visited[j] = 1; stack[sp++] = j; }
  }
}

function zoneReached(map, visited, z) {
  for (let y = z.y0; y <= z.y1; y++) for (let x = z.x0; x <= z.x1; x++) if (visited[idx(map, x, y)]) return true;
  return false;
}

/** Carve an L-shaped tunnel from the nearest reached tile to `to`. Returns its path. */
function carveTunnel(map, visited, to) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < visited.length; i++) {
    if (!visited[i]) continue;
    const x = i % map.w, y = (i - x) / map.w;
    const d = Math.abs(x - to.tx) + Math.abs(y - to.ty);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  const fx = best % map.w, fy = (best - fx) / map.w;
  const path = [];
  let x = fx, y = fy;
  path.push([x, y]);
  while (y !== to.ty) { y += y < to.ty ? 1 : -1; path.push([x, y]); }
  while (x !== to.tx) { x += x < to.tx ? 1 : -1; path.push([x, y]); }
  for (const [px, py] of path) brush(map, px, py);
  return path;
}

// Hash

/** FNV-1a over the tiles and the post layout, as 8 hex digits. */
export function hashWorld(world) {
  let h = 0x811c9dc5;
  const t = world.tiles;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t[i], 0x01000193);
  const meta = JSON.stringify([world.version, world.w, world.h, world.spawnPost, world.posts.map((p) => [p.id, p.name, p.kind, p.x, p.y, p.w, p.h])]);
  h = hashString(meta, h >>> 0);
  return h.toString(16).padStart(8, '0');
}
