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
| Tile ids | `0 empty`, `1 solid`, `2 spike`, `3 oneWay`, `4 postFloor`, `5 postWall`, … (flags in `shared/tiles.js`) |

`shared/tiles.js` has a flag table per id (`SOLID`, `ONE_WAY`, `HAZARD`, `NO_SPAWN`). Physics, rendering and reachability look up flags by tile id instead of hard-coding ids.

## Pipeline

Stages run in order, and each takes the map plus its own RNG sub-stream.

1. **Terrain.**
   - A surface height profile comes from layered 1D value noise, with rolling hills and a few cliffs.
   - Below the surface, 2D value noise with a threshold makes caves, then 2–3 cellular-automaton smoothing passes (integer neighbour counts) remove single-tile noise.
   - Above the surface, floating islands come from a sparse, high-threshold noise layer.
2. **Trade posts.**
   - 8–12 posts are placed by rejection sampling, with a **minimum spacing** of about 96 tiles horizontally.
   - They are spread across heights: surface, cave, and sky island.
   - One post near the horizontal middle is chosen as the **spawn post**.
3. **Stamp posts.**
   - Each post is a small prefab: a hollow room of about 14 × 7 tiles with `postFloor`/`postWall` tiles, open doorways on both sides, and a landing platform outside each door.
   - The area around each post is cleared and flagged `NO_SPAWN`.
4. **Routes.**
   - Posts are connected along a minimum spanning tree over their positions, plus one or two extra edges so there are loops and more than one route to choose from.
   - For each edge, a meandering corridor (a noisy walk with ≥ 3 tiles of headroom) is carved between the two doorways.
   - Platforms are scattered along it, spaced within the **jump envelope** worked out from the physics `TUNING` table: maximum jump height ≈ v²/2g, and maximum horizontal gap from the flight time × run speed, with a safety margin.
   - This makes routes *likely* jumpable even though the v1 check doesn't prove it.
5. **Hazards and spawners.**
   - Spikes go on pit floors and the undersides of some ledges.
   - **Patroller** spawners go on flat runs of at least 4 standable tiles.
   - **Flyer** spawners go in open air pockets (a minimum empty radius is required).
   - Density goes up with distance from the nearest post and is zero inside `NO_SPAWN` areas ([DESIGN.md § Enemies](DESIGN.md#enemies-and-hazards-v1)).
   - Spawners are recorded as data: `{id, kind, x, y, params}`. [`shared/enemies.js`](ARCHITECTURE.md#enemies) turns them into motion.
6. **Reachability check and repair** (below).

The output is a plain object: `{version, seed, w, h, tiles, posts[], spawnPost, spawners[], hash}`.

## Reachability v1

The v1 check is a **flood fill over non-solid tiles**, deliberately simple.

- Start from the spawn post's zone and flood fill with 4-connectivity over tiles that are passable (not `SOLID`) and not hazards (`HAZARD` tiles block the fill, so a route of spikes doesn't count as connected). `ONE_WAY` tiles are passable.
- **Pass:** every post zone is inside the filled region.
- **Repair:**
  - For each post that wasn't reached, carve a 3-tile-tall tunnel from the nearest filled tile to its doorway (an L-shape with noise), clear any hazards on that path, and run the fill again.
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

- **`client/tools/worldgen.html`** is a dev-only preview page. It draws the map to a 2D canvas with posts, spawners, the flood-fill region, and the corridors from the route stage. It has a seed input and forward/back buttons. It's a DOM page on purpose: it's a tool, not the game.
- `test/worldgen.test.js`:
  - The golden hash matches for a fixed seed.
  - 200 random seeds all pass reachability.
  - Generation time stays under budget.

## Status

| Milestone | Scope | State |
|---|---|---|
| M1 | Hand-written test map in the same format (not generated): `shared/maps/test.js` | **done** 2026-09-30 |
| M2 | rng, noise, pipeline stages 1–4 and 6, map hash, preview tool | not started |
| M5 | stage 5 (hazards, spawners) | not started |
| M6+ | reachability v2 | not started |

## Open questions

- **Map size:** is 1024 × 256 right? We'll tune it to how long a post-to-post run should take (target: about 30–90 s per route).
- **Biomes:** should different regions have distinct looks and hazards (and later, the goods produced there, see [ECONOMY.md § v3](ECONOMY.md#v3-production-tree))?
- **Hand-made set pieces:** should we mix hand-authored challenge rooms into the generated terrain?
- **Terrain that changes at runtime** (breakable blocks, doors): the renderer supports it ([ARCHITECTURE.md § Rendering](ARCHITECTURE.md#rendering)), but it would need a tile-change event in the protocol and a map-hash story.
