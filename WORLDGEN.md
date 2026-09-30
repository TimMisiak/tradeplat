# World Generation

This doc covers how a seed becomes a playable map. Game rules are in [DESIGN.md](DESIGN.md). How the map is networked and rendered is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Goals

- **One large, continuous, scrolling map** per server, generated fresh on every server start.
- Every point of interest (trade posts, the spawn) can be **reached**. In v1 that is checked by flood fill (see below).
- **Deterministic.** Client and server build the identical map from `{seed, genVersion}`, so the map is never sent over the network.
- **Fast:** under 200 ms in the browser for the v1 map size. A benchmark tracks this.

## Determinism

- All randomness comes from `shared/rng.js`: **sfc32**, seeded from a 32-bit seed through a splitmix step. Each pipeline stage gets its own **sub-stream** (`rng.fork("terrain")`, `rng.fork("posts")`, …). Changing one stage then doesn't reshuffle the others, which makes tuning a lot easier.
- Noise is **integer-hash value noise**: `Math.imul`-based hashing, then smoothstep interpolation using only `+ − ×`. There are no `Math.sin`/`Math.pow` calls ([ARCHITECTURE.md § Determinism](ARCHITECTURE.md#determinism)).
- `genVersion` is a constant in `worldgen.js`. It is **bumped whenever the output changes for the same seed**. The client refuses to play if its version differs from the server's.
- After generating, both sides compute an FNV-1a **map hash** over the tile bytes and the POI list. The client compares its hash with the server's `welcome` message. A test asserts a fixed golden hash for a fixed seed.

## Map

| Property | v1 value |
|---|---|
| Size | 1024 × 256 tiles (16 px tiles → 16384 × 4096 px) |
| Storage | `Uint8Array(w*h)`, row-major, one tile id per byte |
| Border | Solid bedrock frame. You can't leave the map, and there's no "fell out of the world" case |
| Tile ids | `0 empty`, `1 solid`, `2 spike`, `3 oneWay`, `4 postFloor`, `5 postWall`, `6 slopeR` ('/'), `7 slopeL` ('\\'), … (flags in `shared/tiles.js`) |

`shared/tiles.js` has a flag table per id (`SOLID`, `ONE_WAY`, `HAZARD`, `NO_SPAWN`, `POST`, `SLOPE_R`, `SLOPE_L`). Ramps are 45° and *not* `SOLID`: physics treats them as a walkable surface ([ARCHITECTURE.md § Simulation](ARCHITECTURE.md#simulation)), and the flood fill treats them as passable. Physics, rendering and reachability look up flags by tile id instead of hard-coding ids.

## Pipeline

Stages run in order, and each takes the map plus its own RNG sub-stream.

1. **Terrain.**
   - A surface height profile comes from layered 1D value noise (rolling hills). **It changes by at most one row per column**, so every change becomes a 45° ramp (see rampify below) and the surface can be run up and down without jumping.
   - Below the surface, 2D value noise with a threshold makes caves, which get more open with depth. Two cellular-automaton smoothing passes (integer neighbour counts) remove single-tile noise.
   - Above the surface, floating islands come from a sparse, high-threshold noise layer.
   - The surface itself is painted **after the posts are planned**. Surface posts flatten the ground under their footprint, plus one column past each landing platform. Then `relaxSurface` re-applies the one-row-per-column limit outward from those flats, and removes 1-wide peaks, since one tile can't be both '/' and '\\'. Then the surface is painted over the noise terrain: a 5-row solid crust, with 14 rows of clear air above it.
2. **Trade posts.**
   - 8–12 posts. The width is split into equal slots, with one post per slot jittered by up to ±20% of the slot, so posts are always about 78–118 tiles apart.
   - Each post is surface, cave or sky (weights 2 : 2 : 1). Sky posts fall back to surface when there's no room above the ground. The middle post is always a surface post and is the **spawn post**.
   - Each post gets a generated name (`Rust`+`mouth` style, unique within the world) and a `colorIndex` into the palette's `posts[]`.
3. **Stamp posts.**
   - Each post is a 14 × 7 prefab: a `postWall` roof, 3-row walls, and 3-row open doorways on both sides. Its `postFloor` floor runs 3 tiles past each door as a landing platform.
   - 3 tiles of air are cleared around the room. A surface post's floor *is* the flattened ground, so its landing platforms meet level ground at each end.
   - Each post records its trade `zone` (the interior), a `noSpawn` rect (6-tile margin, used by stage 5), its `doors`, and a `spawn` tile.
4. **Routes.**
   - Posts are connected along a minimum spanning tree over their positions, plus one or two extra edges so there are loops and more than one route to choose from.
   - For each edge, a corridor is carved between the two posts. It starts and ends just past the facing landing platforms, at floor level, so it never runs into a platform from below.
   - The path follows a noisy curve, moving **diagonally, one row per column** (these become ramps). It only goes straight up or down when it lags the curve by more than `ROUTE_MAX_LAG` (4) rows. Opposite diagonals always have a flat step between them.
   - The brush clears the point's column from the feet row up 3 rows, plus 3 rows of headroom in the next column. It leaves the next column's feet row alone, so on a diagonal each column's floor sits right under its own point: a clean 1-tile staircase.
   - Then one-way platforms (up to 4 wide) are added wherever the path goes further than the **`ENVELOPE`** allows without support: `gap` = 4 tiles across, or `stepUp` = 3 rows up. Stacked one-ways in a vertical shaft make a ladder you jump up through.
   - `ENVELOPE` lives in `worldgen.js` and deliberately does **not** read `TUNING`, so tweaking the movement feel doesn't change any maps. Instead, `test/worldgen.test.js` checks that the current physics can still climb a `stepUp` ledge and clear a `gap` jump.
   - This makes routes *likely* jumpable even though the v1 check doesn't prove it.
5. **Hazards and spawners.**
   - Spikes go on pit floors and the undersides of some ledges.
   - **Patroller** spawners go on flat runs of at least 4 standable tiles.
   - **Flyer** spawners go in open air pockets (a minimum empty radius is required).
   - Density goes up with distance from the nearest post and is zero inside `NO_SPAWN` areas ([DESIGN.md § Enemies](DESIGN.md#enemies-and-hazards-v1)).
   - Spawners are recorded as data: `{id, kind, x, y, params}`. [`shared/enemies.js`](ARCHITECTURE.md#enemies) turns them into motion.
6. **Reachability check and repair** (below).
7. **Rampify.** Every 1-tile floor step anywhere (surface, route staircases, repair tunnels, natural cave floors) becomes a 45° ramp. The step needs two open rows of headroom above it, and the ground must continue past it. 1-wide bumps and post tiles are left alone. The conditions are read from a snapshot, so ramps placed in this pass don't affect each other. About 2,200 ramps per world.

The output is a plain object: `{version, seed, attempt, w, h, tiles, posts[], spawnPost, spawners[], hash, stats, debug}`. `stats` holds the number of platforms and repair tunnels and the reachable tile count. `debug.routes` holds the carved paths, used by the preview tool. Neither is part of the hash.

### Where the seed comes from

- The server picks a random 32-bit seed at startup, or uses the `SEED` environment variable if it's set, and logs the seed, hash and generation time.
- `welcome` carries `world: {seed, genVersion, hash}`. The client regenerates the world and compares the result. If they differ, it shows "This page is out of date with the server" and doesn't play.
- When the client reconnects to a server with a new seed (after a server restart), it regenerates and respawns.
- Dev overrides: `/?seed=N` generates locally without checking against the server, and `/?map=test` loads the M1 test level.

## Reachability v1

The v1 check is a **flood fill over non-solid tiles**, deliberately simple.

- Start from the spawn post's zone and flood fill with 4-connectivity over tiles that are passable (not `SOLID`) and not hazards (`HAZARD` tiles block the fill, so a route of spikes doesn't count as connected). `ONE_WAY` tiles are passable.
- **Pass:** every post zone is inside the filled region.
- **Repair:**
  - For each post that wasn't reached, carve a tunnel (same brush as routes) from the nearest filled tile to its doorway: vertical first, then horizontal. Add platforms along it with the same envelope rule, and run the fill again.
  - Repair is limited to a few rounds.
  - If it still fails, regenerate with the next sub-seed (`seed, attempt+1`). This loop is deterministic, so the client ends up on the same attempt.
- **Known gap:** flood fill treats every connected air tile as reachable, **ignoring gravity and jump height**. A post at the top of a 20-tile vertical shaft passes the check, but nobody can jump up to it. Step 4's jump envelope makes this rare but not impossible. Playtesting and the preview tool (below) are how we catch it until v2.

## Reachability v2 (future)

This version checks reachability using how the player actually moves.

1. Find **standable tiles**: an empty tile with a solid or one-way tile directly below it and enough headroom above.
2. Build a directed graph. Edges are walks to a neighbour, drops to a lower standable tile, and **jumps**. Jump edges come from arcs simulated with the real `shared/physics.js` `step()` using a small set of canned input patterns (full jump, short hop, and each of those with a run left or right, plus wall jumps where there's a wall).
3. Every post must be reachable from the spawn post, and the spawn post must be reachable **back** from every post, so you can't strand yourself.
4. Repair by adding platforms along the path that's closest to working.

Because this uses the real step function, it stays correct when the movement tuning changes.

## Tooling

- **`/tools/worldgen.html`** is a dev-only preview page. It draws the whole map (1 px per tile, zoom 1–4×) with posts and their names, the spawn post, the flood-fill region, and the carved route paths. It shows the generation stats, has seed input with forward/back/random buttons, and a "play this seed" link (`/?seed=N`). It's a DOM page on purpose: it's a tool, not the game.
- `test/worldgen.test.js`:
  - The golden hash matches for a fixed seed.
  - The same seed gives the same world.
  - 200 seeds all pass reachability, with well-formed, uniquely named posts and a spawn tile standing on floor.
  - All three post kinds appear across seeds.
  - Generation time stays under budget.
  - The physics still beats `ENVELOPE`.
  - RNG and noise properties.
- `npm run bench -- worldgen`: 50 worlds. Measured 2026-09-30 in Node 24 (genVersion 2, with ramps): **mean 81 ms, p95 100 ms, max 117 ms**, no retries, no repair tunnels, about 88 platforms per world.

## Status

| Milestone | Scope | State |
|---|---|---|
| M1 | Hand-written test map in the same format (not generated): `shared/maps/test.js` | **done** 2026-09-30 |
| M2 | rng, noise, pipeline stages 1–4 and 6, map hash, server seed + client regen/verify, preview tool | **done** 2026-09-30 |
| M2.1 | 45° ramps: one-row-per-column surface, post flats relaxed into ramps, diagonal routes, rampify pass (genVersion 2) | **done** 2026-09-30 |
| M5 | stage 5 (hazards, spawners) | not started |
| M6+ | reachability v2 | not started |

## Open questions

- **Only floors get ramps.** Ceilings, and the undersides of islands, keep their 1-tile stair-step look. That's fine for play, since you rarely touch a ceiling. Ceiling ramps would need their own tile type and physics.
- **Ramps are all 45°.** Gentler 22.5° ramps (two tiles per row) would make rolling hills look softer. They'd need two more tile types and matching physics, and the one-row-per-column limit would become a choice between the two slopes.
- **Sky posts** depend on route platforms, which the flood fill can't check (see the known gap above). Watch for them in the preview tool and in playtests.

- **Map size:** is 1024 × 256 right? We'll tune it to how long a post-to-post run should take (target: about 30–90 s per route).
- **Biomes:** should different regions have distinct looks and hazards (and later, the goods produced there, see [ECONOMY.md § v3](ECONOMY.md#v3-production-tree))?
- **Hand-made set pieces:** should we mix hand-authored challenge rooms into the generated terrain?
- **Terrain that changes at runtime** (breakable blocks, doors): the renderer supports it ([ARCHITECTURE.md § Rendering](ARCHITECTURE.md#rendering)), but it would need a tile-change event in the protocol and a map-hash story.
