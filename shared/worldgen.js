// Procedural world: seed → tile map + trade posts. See WORLDGEN.md.
//
// Deterministic: all randomness comes from shared/rng.js, and all math is exact
// IEEE-754 (no Math.sin/pow/random). Client and server run this with the same
// seed and must get the same tiles and the same hash.
// Bump GEN_VERSION whenever the output for a given seed changes.
import { createRng, hashString } from './rng.js';
import { fbm, noise1, noise2 } from './noise.js';
import { FLAG, SLOPE, TILE, TILE_FLAGS, createMap } from './tiles.js';
import { enemyExtent } from './enemies.js';

export const GEN_VERSION = 4;
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
 *   posts: Post[], spawnPost: number, spawners: import('./enemies.js').Spawner[], hash: string,
 *   stats: Record<string, number>,
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
  const stats = { tunnels: 0, platforms: 0, filled: 0, ramps: 0, reachable: 0, spikes: 0, spikesRemoved: 0, patrollers: 0, flyers: 0, saws: 0 };
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

  // Pits: fill in anywhere you could get to but not get back from, which raises
  // each pit's floor to where you can climb out. A post in a pit can't be filled.
  // Stage 5's spikes go in after the first fill, so the pit check that confirms
  // the fill also confirms the spikes made no new pits and cut off no post. If
  // they did, the spike runs near the problem come out, and it checks again.
  const spawn = posts[spawnPost].spawn;
  const at = (p) => idx(map, p.spawn.tx, p.spawn.ty);
  let traps = findTraps(map, spawn);
  const before = traps.reached;
  let spikes = null;
  for (let fills = 0, removals = 0; ;) {
    const { trapped, count } = traps;
    const lost = spikes ? posts.filter((p) => before[at(p)] && !traps.reached[at(p)]) : [];
    if (count === 0 && lost.length === 0) {
      if (spikes) break;
      spikes = placeSpikes(map, rng.fork('hazards'), posts, traps.reached);
      traps = findTraps(map, spawn);
      continue;
    }
    if (spikes && removals < 6) {
      if (removeSpikes(map, spikes, trapped, lost, removals++, stats)) {
        traps = findTraps(map, spawn);
        continue;
      }
    }
    if (lost.length) return { ok: false, error: 'spikes made a post unreachable' };
    if (fills++ >= MAX_REPAIR_ROUNDS) return { ok: false, error: `${count} trapped tiles` };
    const stuck = posts.find((p) => trapped[at(p)]);
    if (stuck) return { ok: false, error: `${stuck.name} is in a pit` };
    for (let i = 0; i < trapped.length; i++) if (trapped[i]) { map.tiles[i] = TILE.solid; stats.filled++; }
    // A ramp buried under the fill is just rock now.
    for (let i = w; i < trapped.length; i++) {
      if ((TILE_FLAGS[map.tiles[i]] & SLOPE) && trapped[i - w]) { map.tiles[i] = TILE.solid; stats.ramps--; }
    }
    if (!spikes) spikes = placeSpikes(map, rng.fork('hazards'), posts, traps.reached);
    traps = findTraps(map, spawn);
  }
  stats.spikes = spikes.reduce((n, g) => n + g.tiles.length, 0);

  // Stage 5, continued: enemy spawners, on the final map.
  const spawners = placeSpawners(map, rng.fork('spawners'), posts, traps.reached, stats);

  for (const p of posts) delete p.isSpawn;
  return {
    ok: true,
    world: {
      version: GEN_VERSION, seed: 0, attempt: 0,
      w, h, tiles: map.tiles,
      posts, spawnPost,
      spawners,
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
 * Walk each path, both ways, and drop one-way platforms wherever the player would
 * have gone too far (in ENVELOPE terms) without anything to stand on. Walking it
 * backwards turns every drop into a climb, so a route can be run in both
 * directions. Returns the count.
 */
function addPlatforms(map, paths) {
  let placed = 0;
  // The row the player's feet rest on near (x, y), or -1 if there's no floor within 2 rows.
  const standRow = (x, y) => {
    for (let dy = 1; dy <= 2; dy++) {
      if (TILE_FLAGS[get(map, x, y + dy)] & (FLAG.SOLID | FLAG.ONE_WAY | SLOPE)) return y + dy - 1;
    }
    return -1;
  };
  for (const path of paths.flatMap((p) => [p, p.toReversed()])) {
    let last = null;
    for (const [x, y] of path) {
      // Climbs are measured from where the feet actually rest, not from the path point.
      const sy = standRow(x, y);
      if (sy >= 0) { last = { x, y: sy }; continue; }
      if (!last) { last = { x, y }; continue; }
      if (Math.abs(x - last.x) > ENVELOPE.gap || last.y - y >= ENVELOPE.stepUp) {
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

// Stage 5: hazards and spawners

/** Chance per candidate spot at full danger (WORLDGEN.md § Pipeline stage 5). */
const RATE = Object.freeze({ floorSpikes: 0.06, ceilingSpikes: 0.04, patroller: 0.8, flyer: 0.5, saw: 0.6 });
/** Danger rises from 0 at a post's noSpawn edge to 1 this many tiles away. */
const DANGER_RAMP = 40;
/** Spawners keep at least this many tiles (Chebyshev, between anchors) from each other. */
const SPAWNER_GAP = 8;
const SAW_GAP = 24;

/**
 * 0 inside any post's noSpawn rect, rising linearly to 1 at DANGER_RAMP tiles
 * from the nearest one, so the middle of a route is the most dangerous part.
 */
function danger(posts, x, y) {
  let d = Infinity;
  for (const p of posts) {
    const r = p.noSpawn;
    const dx = Math.max(r.x0 - x, 0, x - r.x1), dy = Math.max(r.y0 - y, 0, y - r.y1);
    d = Math.min(d, Math.max(dx, dy));
  }
  return Math.min(1, d / DANGER_RAMP);
}

/**
 * Spikes on floors (runs of 1–3 you can jump, with flat ground and headroom on
 * both sides) and on high ceilings (with at least 5 open rows under them).
 * `reached`: the pit check's standable tiles you can get to.
 * @returns {{x: number, y: number, tiles: number[]}[]} the runs placed
 */
function placeSpikes(map, rng, posts, reached) {
  const { w, h } = map;
  const at = (x, y) => get(map, x, y);
  const empty = (x, y) => at(x, y) === TILE.empty;
  const clear = (x, y0, y1) => { for (let y = y0; y <= y1; y++) if (!empty(x, y)) return false; return true; };
  // A flat spot to stand next to a spike run: plain ground, open above.
  const ledge = (x, y) => clear(x, y - 3, y) && at(x, y + 1) === TILE.solid && reached[idx(map, x, y)];
  const groups = [];
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 8; x++) {
      if (map.tiles[y * w + x] !== TILE.empty) continue;
      // Floor spikes: run x..x+n-1 in feet row y.
      if (map.tiles[(y + 1) * w + x] === TILE.solid && ledge(x - 1, y) && clear(x, y - 3, y)) {
        const f = danger(posts, x, y);
        if (f > 0 && rng.chance(RATE.floorSpikes * f)) {
          const n = rng.int(1, 3);
          let ok = ledge(x + n, y);
          for (let i = 0; i < n && ok; i++) ok = clear(x + i, y - 3, y) && at(x + i, y + 1) === TILE.solid && danger(posts, x + i, y) > 0;
          if (ok) {
            const tiles = [];
            for (let i = 0; i < n; i++) { set(map, x + i, y, TILE.spike); tiles.push(idx(map, x + i, y)); }
            groups.push({ x, y, tiles });
            x += n + 6;
            continue;
          }
        }
      }
      // Ceiling spikes: hanging from plain rock with 5 open rows below.
      if (map.tiles[(y - 1) * w + x] === TILE.solid && clear(x, y, y + 5)) {
        const f = danger(posts, x, y);
        if (f > 0 && rng.chance(RATE.ceilingSpikes * f)) {
          const n = rng.int(1, 4);
          const tiles = [];
          for (let i = 0; i < n && at(x + i, y - 1) === TILE.solid && clear(x + i, y, y + 5) && danger(posts, x + i, y) > 0; i++) {
            set(map, x + i, y, TILE.spike);
            tiles.push(idx(map, x + i, y));
          }
          groups.push({ x, y, tiles });
          x += n + 6;
        }
      }
    }
  }
  return groups;
}

/**
 * Take out the spike runs near a problem the pit check found: new trap tiles, or
 * the spawn tile of a post the spikes cut off. Wider each round; on the last
 * rounds, every run. Returns whether any were removed.
 */
function removeSpikes(map, groups, trapped, lost, round, stats) {
  const w = map.w;
  const bad = [];
  for (let i = 0; i < trapped.length; i++) if (trapped[i] === 1) bad.push(i);
  for (const p of lost) bad.push(idx(map, p.spawn.tx, p.spawn.ty));
  const r = (lost.length ? 12 : 6) * (round + 1);
  const near = (g) => round >= 4 || bad.some((i) => {
    const tx = i % w, ty = (i - tx) / w;
    return Math.abs(g.x - tx) <= r + 3 && Math.abs(g.y - ty) <= r;
  });
  let removed = 0;
  for (const g of groups) {
    if (!g.tiles.length || !near(g)) continue;
    for (const i of g.tiles) map.tiles[i] = TILE.empty;
    g.tiles = [];
    removed++;
  }
  stats.spikesRemoved += removed;
  return removed > 0;
}

/**
 * Enemy spawners (shared/enemies.js describes their params and motion):
 * saws across low passages, patrollers on flat runs of 4+ standable tiles,
 * flyers in open air near the ground. All in reachable places (`reached`: the
 * final pit check's standable tiles), nothing that can reach into a post's
 * noSpawn rect, more of them further from posts.
 * @returns {import('./enemies.js').Spawner[]}
 */
function placeSpawners(map, rng, posts, reached, stats) {
  const { w, h } = map;
  const at = (x, y) => get(map, x, y);
  const empty = (x, y) => at(x, y) === TILE.empty;
  const spawners = [];
  const T = 16; // px per tile
  const roomFor = (x, y, gap, kind) => spawners.every((s) => Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) >= (kind && s.kind === kind ? Math.max(gap, SAW_GAP) : gap));
  // Nothing an enemy can reach (its sword included) may overlap a post's noSpawn rect.
  const add = (kind, x, y, params) => {
    const sp = { id: spawners.length, kind, x, y, params };
    const e = enemyExtent(sp);
    const clear = posts.every(({ noSpawn: r }) => e.x1 <= r.x0 * T || e.x0 >= (r.x1 + 1) * T || e.y1 <= r.y0 * T || e.y0 >= (r.y1 + 1) * T);
    if (!clear) return false;
    spawners.push(sp);
    stats[`${kind}s`]++;
    return true;
  };
  const standable = (x, y) => empty(x, y) && empty(x, y - 1) && empty(x, y - 2) && at(x, y + 1) === TILE.solid && reached[idx(map, x, y)] && danger(posts, x, y) > 0;

  // Saws: a vertical track across a low passage (a ceiling 4–6 rows over the
  // floor), timed so the gap under it opens and closes. The saw is wider than its
  // column, so the passage must be open over the columns either side too.
  for (let y = 8; y < h - 4; y++) {
    for (let x = 6; x < w - 6; x++) {
      if (map.tiles[y * w + x] !== TILE.empty || !(TILE_FLAGS[map.tiles[(y + 1) * w + x]] & (FLAG.SOLID | SLOPE))) continue;
      if (!reached[idx(map, x, y)] && !reached[idx(map, x, y + 1)]) continue;
      let top = 0, bottom = h, ceiling = false;
      for (let c = x - 1; c <= x + 1; c++) {
        let up = y, down = y;
        if (!empty(c, y)) { top = h; break; }
        while (y - up < 7 && empty(c, up - 1)) up--;
        while (down - y < 2 && empty(c, down + 1)) down++;
        if (c === x) ceiling = at(c, up - 1) === TILE.solid;
        top = Math.max(top, up);
        bottom = Math.min(bottom, down);
      }
      const open = bottom - top + 1;
      if (!ceiling || open < 4 || open > 6) continue;
      if (!roomFor(x, y, SPAWNER_GAP / 2, 'saw') || !rng.chance(RATE.saw * danger(posts, x, y))) continue;
      const r = 11, period = rng.int(100, 160);
      if (add('saw', x, y, { x0: x * T + 8, y0: top * T + r + 1, x1: x * T + 8, y1: (bottom + 1) * T - r - 1, period, phase: rng.int(0, period - 1) })) x += 8;
    }
  }

  // Patrollers: flat runs of at least 4 standable tiles, walking at most 12 of them.
  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      if (map.tiles[(y + 1) * w + x] !== TILE.solid || !standable(x, y)) continue;
      let n = 1;
      while (x + n < w - 4 && standable(x + n, y)) n++;
      if (n >= 4) {
        const len = Math.min(n, rng.int(6, 12));
        const x0 = x + rng.int(0, n - len);
        const mid = x0 + (len >> 1);
        if (roomFor(mid, y, SPAWNER_GAP) && rng.chance(RATE.patroller * danger(posts, mid, y))) {
          add('patroller', mid, y, { x0: x0 * T + 6, x1: (x0 + len) * T - 6, floor: (y + 1) * T, speed: rng.pick([0.5, 0.75, 1]), phase: rng.int(0, 999) });
        }
      }
      x += n;
    }
  }

  // Flyers: open pockets with room for the whole path, and ground you can reach
  // within 8 rows below, with open air between (so the pocket is reachable too).
  for (let gy = 8; gy < h - 8; gy += 7) {
    for (let gx = 8; gx < w - 8; gx += 7) {
      const x = gx + rng.int(-2, 2), y = gy + rng.int(-2, 2);
      const rx = rng.int(2, 4), ry = rng.int(1, 2);
      if (!empty(x, y)) continue;
      let ok = true;
      for (let yy = y - ry - 1; yy <= y + ry + 1 && ok; yy++) for (let xx = x - rx - 1; xx <= x + rx + 1 && ok; xx++) ok = empty(xx, yy);
      if (!ok) continue;
      let ground = false;
      for (let yy = y + ry + 2; yy <= y + 8 && !ground && empty(x, yy); yy++) ground = reached[idx(map, x, yy)] === 1;
      const f = danger(posts, x, y);
      if (!ground || !roomFor(x, y, SPAWNER_GAP) || !rng.chance(RATE.flyer * f)) continue;
      const period = rng.int(150, 300);
      add('flyer', x, y, { rx: rx * T, ry: ry * T, period, phase: rng.int(0, period - 1), path: rng.pick(['loop', 'eight']) });
    }
  }
  return spawners;
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

/**
 * Pits: standable tiles the player can get to from `start` but can't get back
 * from, moving within ENVELOPE (jump up to stepUp rows, up to gap tiles sideways
 * per jump, drift up to one tile per row while falling, drop through one-ways).
 * Wall jumps aren't modelled, so a pit counts as a trap even if a wall jump
 * would get you out.
 *
 * The search runs over states (tile, rise left r, sideways left g). A tile's
 * feet row is its own row, and the body also fills the row above. Standing on a
 * tile refills both budgets. Each tile keeps a bitmask of its states, bit
 * r * (gap + 1) + g, so every move is a few bit operations on the whole mask.
 * Forward from `start` gives where you can go; backward gives where you can
 * come back from. A trap is in the first and not the second.
 *
 * @returns {{trapped: Uint8Array, reached: Uint8Array, count: number}} per tile;
 *   `count` is the number of standable trap tiles (trapped === 1).
 */
export function findTraps(map, start) {
  const { w, h, tiles } = map;
  const U = ENVELOPE.stepUp, G = ENVELOPE.gap, W1 = G + 1;
  const n = w * h;
  const ROW0 = (1 << W1) - 1; // r = 0
  const ALL = (1 << (W1 * (U + 1))) - 1;
  const TOP_ROW = ROW0 << (U * W1); // r = U
  const FULL = 1 << (U * W1 + G); // r = U, g = G: just landed
  let G0 = 0; // g = 0, every r
  for (let r = 0; r <= U; r++) G0 |= 1 << (r * W1);
  const GMAX = G0 << G; // g = G, every r
  const everyRow = (m) => { let out = 0; for (let r = 0; r <= U; r++) out |= m << (r * W1); return out; };
  const anyRow = (m) => { let out = 0; for (let r = 0; r <= U; r++) out |= (m >>> (r * W1)) & ROW0; return out; };

  const blocked = (i) => TILE_FLAGS[tiles[i]] & (FLAG.SOLID | FLAG.HAZARD);
  // body: the feet tile is free or a ramp (you stand in it), and the tile above is
  // free. So you can't move through a ramp from above or below. stand: body plus
  // a floor to rest on, or a ramp. The outer rows and columns never get a body,
  // so i ± 1 and i ± w never leave the map or wrap to another row.
  const body = new Uint8Array(n);
  const stand = new Uint8Array(n);
  for (let i = w; i < n - w; i++) {
    const x = i % w;
    if (x === 0 || x === w - 1 || blocked(i) || blocked(i - w) || (TILE_FLAGS[tiles[i - w]] & SLOPE)) continue;
    body[i] = 1;
    if ((TILE_FLAGS[tiles[i + w]] & (FLAG.SOLID | FLAG.ONE_WAY | SLOPE)) || (TILE_FLAGS[tiles[i]] & SLOPE)) stand[i] = 1;
  }
  const si = start.ty * w + start.tx;
  if (!body[si]) return { trapped: new Uint8Array(n), reached: new Uint8Array(n), count: 0 };

  // FIFO ring of tiles whose mask grew. A tile is in it at most once, so n slots suffice.
  const queue = new Int32Array(n);
  const queued = new Uint8Array(n);
  let head = 0, tail = 0;
  const run = (mask, expand) => {
    mask[si] = FULL;
    queue[tail++] = si;
    queued[si] = 1;
    while (head !== tail) {
      const i = queue[head];
      head = head + 1 === n ? 0 : head + 1;
      queued[i] = 0;
      expand(i, mask[i]);
    }
  };
  const add = (mask, j, m) => {
    if (!body[j] || (mask[j] | m) === mask[j]) return;
    mask[j] |= m;
    if (!queued[j]) {
      queued[j] = 1;
      queue[tail] = j;
      tail = tail + 1 === n ? 0 : tail + 1;
    }
  };

  // Forward: rise (r-1), step sideways (g-1), fall (r=0, g+1 up to G), land (FULL).
  const fwd = new Uint32Array(n);
  run(fwd, (i, m) => {
    if (stand[i] && !(m & FULL)) m = fwd[i] |= FULL;
    add(fwd, i - w, m >>> W1);
    const side = (m & ~G0) >>> 1;
    add(fwd, i - 1, side);
    add(fwd, i + 1, side);
    const g = anyRow(m);
    add(fwd, i + w, ((g << 1) & ROW0) | (g & (1 << G)));
  });

  // Backward: the same moves reversed. mask[i] = states at i that can get back to start.
  const back = new Uint32Array(n);
  run(back, (i, m) => {
    if (stand[i] && (m & FULL) && m !== ALL) m = back[i] = ALL;
    add(back, i + w, (m & ~TOP_ROW) << W1);
    const side = (m & ~GMAX) << 1;
    add(back, i - 1, side);
    add(back, i + 1, side);
    const g0 = m & ROW0;
    add(back, i - w, everyRow((g0 >>> 1) | (g0 & (1 << G))));
  });

  // 1 = a standable tile you can reach but not leave. 2 = any other tile you can
  // reach but not leave (the air of a pit), or the head room above one that you
  // never stand in.
  const trapped = new Uint8Array(n);
  const reached = new Uint8Array(n); // standable tiles you can get to
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (stand[i] && (fwd[i] & FULL)) reached[i] = 1;
    if (!fwd[i] || (fwd[i] & back[i])) continue;
    if (stand[i]) { trapped[i] = 1; count++; } else trapped[i] = 2;
    if (!fwd[i - w]) trapped[i - w] = 2;
  }
  return { trapped, reached, count };
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

/** FNV-1a over the tiles, the post layout and the spawners, as 8 hex digits. */
export function hashWorld(world) {
  let h = 0x811c9dc5;
  const t = world.tiles;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t[i], 0x01000193);
  const meta = JSON.stringify([world.version, world.w, world.h, world.spawnPost, world.posts.map((p) => [p.id, p.name, p.kind, p.x, p.y, p.w, p.h]),
    world.spawners.map((sp) => [sp.id, sp.kind, sp.x, sp.y, sp.params])]);
  h = hashString(meta, h >>> 0);
  return h.toString(16).padStart(8, '0');
}
