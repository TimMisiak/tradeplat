# Architecture

This doc covers the technology choices, the repo layout, the simulation, netcode, rendering and UI. Game rules are in [DESIGN.md](DESIGN.md), the map in [WORLDGEN.md](WORLDGEN.md), and prices in [ECONOMY.md](ECONOMY.md).

## Principles

1. **One simulation, two hosts.** Code that must match on client and server (physics, tiles, world generation, enemy motion, protocol) lives in `shared/` as plain ES modules. Node and the browser import the *same files*.
2. **No build step.** The browser loads the source files directly. Any third-party browser module comes from a CDN through an import map in `client/index.html`. We only add a bundler if a measured problem requires one.
3. **The server is authoritative, and the client predicts.** The server decides money, cargo, deaths and prices. The client simulates its own player locally, so input feels instant.
4. **Measure before re-architecting.** Performance choices (binary protocol, workers, sharding) come with a benchmark in `bench/` that justifies them.
5. **State is plain data.** World, market and player state are serializable objects with a `version` field, so persistence can be added later without restructuring.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server runtime | Node ≥ 22 (dev on 24), `"type": "module"` | Shares ES modules with the client |
| Transport | WebSocket via [`ws`](https://github.com/websockets/ws) | Mature and small. Node has no built-in WS server. It is the **only runtime dependency** |
| HTTP | `node:http` static file server | Serves `client/` and `shared/`. A dozen lines, so no framework |
| Tests | `node --test` + `node:assert` | Built in, no dependency |
| Rendering | WebGPU (WGSL shaders inline in JS modules) | Target platform. No WebGL fallback |
| Browser libraries | None planned. If needed, add an import map to `cdn.jsdelivr.net/npm/...` | No build step |

## Repo layout

```
*.md                    # all docs at the root (README, CLAUDE, DESIGN, ARCHITECTURE, WORLDGEN, ECONOMY, ART)
package.json            # "type": "module", scripts: start, test, test:assets, bench
server/
  main.js               # entry: http server + ws on one port; startServer() for tests
  static.js             # static files: / → client/, /shared/ → shared/ (traversal-safe)
  game.js               # world instance, fixed-tick loop, player registry
  net.js                # ws connection lifecycle, message dispatch, interest sets
  market.js             # price processes, trade validation (server-only)
shared/
  rng.js                # sfc32 seeded PRNG + helpers
  tiles.js              # tile ids, flags (solid, oneWay, hazard), map accessors
  physics.js            # TUNING table + pure step()
  worldgen.js           # seed → map + POIs + spawners
  enemies.js            # enemy kinds, deterministic position(spawner, tick)
  goods.js              # goods catalog
  protocol.js           # message type constants, encode/decode helpers
  mathdet.js            # deterministic sin/cos (see Determinism)
  maps/test.js          # hand-written M1 test level (ASCII)
  noise.js              # integer-hash value noise + fbm
client/
  index.html            # <canvas>, import map, one <script type="module">
  main.js               # boot, main loop, fixed-step accumulator
  input.js              # keyboard (+ gamepad later) → input bitmask
  net.js                # ws client, clock sync, reconciliation, ghost buffers
  camera.js             # follow, look-ahead, pixel snapping, bounds
  player-view.js        # physics state → animation + sprite (or flat fallback) instances
  dev/tuning.js         # dev-only DOM tuning panel (` key), see DESIGN.md § Movement feel
  assets.js             # asset spec + manifest validator (+ runtime loader later), see ART.md
  assets/               # exported art: manifest.json, tiles/, sprites/, icons/ (ART.md)
  gpu/renderer.js       # device setup, tile pass, sprite pass
  gpu/shaders.js        # WGSL source strings
  ui/text.js            # runtime glyph atlas, text quads
  ui/trade.js           # trade menu state + layout
  tools/                # dev-only DOM pages: assets.html (art viewer), worldgen.html (map preview)
art/                    # art source files (not served). See ART.md
test/                   # *.test.js, run by node --test
bench/                  # perf measurements that justify architecture calls (npm run bench)
```

The static server maps `/` → `client/` and `/shared/` → `shared/`. Client modules import shared code by **relative path** (`../shared/physics.js` from `client/`, `../../shared/…` from `client/gpu/`). A relative path works both in the browser (where `client/` is served at `/`, so `..` stops at the root) and in Node tests that import client modules. An absolute `/shared/` path would only work in the browser. The server sets `Content-Type: text/javascript` and uses `Cache-Control: no-cache` in development.

## Simulation

- **A fixed 60 Hz tick** on both sides. The client runs a fixed-step accumulator separate from `requestAnimationFrame`, and interpolates between the last two physics states when it renders. The server runs an accumulator loop driven by `performance.now()`. It does not use a bare `setInterval`, which drifts.
- **`step(player, input, map, tuning) → player`** in `shared/physics.js` is pure: no globals, no time source, no randomness. The player state is a small plain object: `{x, y, vx, vy, onGround, wallDir, coyote, jumpBuffer, wallLock, …}`.
- **Collision:** the player's AABB is tested against the tile grid one axis at a time (move X, resolve; move Y, resolve). Terminal velocity is capped at ≤ 1 tile per tick, so the player can't tunnel through tiles, and no swept collision is needed in v1. One-way platforms are solid only from above, and only when down is not held.
- **Hazards and enemies** are checked after the move: spike tiles via tile flags, and enemies via AABB overlap with `enemies.position(spawner, tick)`.
- **Why pure:** a pure step function can be replayed, so reconciliation is simple and rollback for PvP stays possible later.

### Determinism

Client prediction and client-side world generation both depend on client and server computing **bit-identical** results.

- The basic IEEE-754 double operations (`+ − × ÷`, `Math.sqrt`) are exact and give the same results on every JS engine. The **transcendental functions (`Math.sin`, `Math.exp`, `Math.pow`, …) are not guaranteed** to match across V8, SpiderMonkey and JavaScriptCore.
- So shared simulation code uses only the basic operations, plus `shared/mathdet.js`: deterministic `sin`/`cos` built from a fixed polynomial and a table. Enemy paths use these.
- `Math.random` is banned in `shared/`. Randomness comes from `shared/rng.js` (sfc32 with an explicit seed).
- Server-only code, such as the market's random walk, may use any `Math` function, because its results are sent to clients rather than recomputed by them.
- A test runs a recorded input sequence through `step()` and compares it with a golden hash. A browser-side debug page runs the same check, so we can compare engines by hand.

## Netcode

### Connection
1. The client opens `ws(s)://host/ws` and sends `hello {name}`. The scheme and host always come from `location` (`wss:` on an `https:` page), because the game is served over HTTPS behind a TLS-terminating proxy, and WebGPU needs a secure context anyway. The server itself speaks plain HTTP/WS and never builds absolute URLs.
2. The server replies `welcome {playerId, name, protocol, serverTick, tickRate, world: {seed, genVersion, hash}}`. `tuningHash` and the market snapshot join it in M3/M4.
3. The client **regenerates the map from the seed** ([WORLDGEN.md](WORLDGEN.md#determinism)) and checks that its own map hash and tuning hash match the server's. If either doesn't match, it shows an error and refuses to play, because prediction would be wrong.

### Clock sync
The client pings the server periodically. From the round-trip time it estimates the server tick and keeps a smoothed offset. The client runs its own simulation a little *ahead* of the server tick (roughly RTT/2 plus a small buffer), so its inputs arrive just before the server needs them.

### Own player: prediction and reconciliation
- Every tick the client samples its input into a bitmask (`left, right, up, down, jump, interact`). It applies that input locally and sends `input {seq, tick, bits}`. Several ticks can be batched into one message if we measure that it helps.
- **Because ghosts don't interact, the server steps each player independently, as that player's inputs arrive.** It doesn't wait on a single global lockstep. This avoids mispredictions caused by network jitter.
  - **Speed-hack guard:** the server tracks each player's simulated tick against real elapsed time. It rejects inputs that run ahead by more than a small window, and fills in "no input" frames for a player who falls too far behind.
  - Enemy collisions for an input are evaluated at the tick number that input carries, within an allowed window of ±15 ticks (±250 ms) of server time. This is effectively lag compensation, and it is safe because the enemies are deterministic.
- About every 3 ticks (20 Hz), a snapshot carries the player's authoritative state and `ackSeq`. The client takes that state, **replays the inputs the server hasn't acknowledged yet**, and eases out any leftover visual error over a few frames.
- With identical code on both sides, mismatches should almost never happen. The client counts them as a **determinism health metric** in the debug overlay.

### Ghosts (other players)
- A snapshot contains `{id, x, y, facing, anim}` for every player in the client's interest set.
- The client buffers these and renders ghosts **about 100 ms behind**, interpolating between the snapshots on either side of that time.

### Enemies
- Enemy positions are never sent. The client computes `enemies.position(spawner, tick)` itself.
- Only events go over the wire: `enemyKilled {spawnerId, tick}` and `enemySpawned {spawnerId, tick}`, plus the alive/dead set in `welcome`.

### Deaths, trades and events
- **Deaths:** the client predicts the death at once (splat, restart fade) and sends nothing extra. The server detects the same death while replaying inputs, clears the player's cargo, and sends `died {tick, cause}`. If the server disagrees, which should be rare, the client follows the server.
- **Trades:** `trade {reqId, postId, goodId, qty, side}` → `tradeResult {reqId, ok, reason?, money, cargo}`. The server checks that the player is inside the post zone (using the server's position), has enough money or cargo, has hold space, and that the post actually trades that good. Money and cargo only change on the server.
- **Market:** after each market tick, the server sends `prices {postId, …}` only to players who are in that post's zone. This supports the design rule that you only see prices where you are standing ([DESIGN.md](DESIGN.md#information-is-part-of-the-game)).

### Interest management
- The world is divided into **32×32-tile chunks**. Each client's interest set is the chunks within a margin of its camera view (about 3×3 chunks around it).
- Ghosts and enemy events outside that set aren't sent. The leaderboard is sent to everyone at a low rate (every 2 s).

### Protocol
- JSON text frames: `{t: "<type>", ...}`. Type constants are defined in `shared/protocol.js`.
- **We start with JSON on purpose.** It's easy to debug and fast enough at this scale. A benchmark in `bench/` (snapshot encode cost and bytes per client at N players) decides whether and when to switch hot messages (`input`, snapshots) to binary `ArrayBuffer` frames. The protocol module keeps encode/decode behind one interface, so switching doesn't touch game code.

### Scale target
The v1 target is **one Node process per world, about 64 concurrent players**. Physics per player per tick is a handful of tile lookups, so the bottleneck will be snapshot serialization, and the benchmark will measure it. Scaling past that (sharding the map, multiple worlds) is out of scope until we have measurements.

### PvP later
Physical PvP (stomping, bumping) breaks the "step each player independently" model, because it needs one shared tick and authority over who hit whom. The plan for that change:
- Move to a global server tick with a per-player input jitter buffer.
- Predict the local player, and resolve player-vs-player contacts on the server with lag compensation (rewinding ghost positions to the attacker's view).
- Rollback on the client if it turns out to be needed.

Keeping `step()` pure and the state as plain data is what keeps this migration possible. Nothing in v1 should assume players can't affect each other beyond what the netcode needs.

## Rendering

- **WebGPU only.** If `navigator.gpu` is missing or `requestAdapter()` fails, show a plain-text message ("This game needs WebGPU"), and link to the browser support table.
- **Virtual resolution:** gameplay is laid out for a 640×360 view (40×22.5 tiles at 16 px). It is scaled by the largest integer factor that fits the window, with letterboxing, so pixels stay crisp and players with bigger screens don't see more of the level. The camera follows the player with a little look-ahead in the direction of movement, and is **snapped to whole virtual pixels**.
- **Tile pass:**
  - The whole map is uploaded once as an `r8uint` texture (1024×256 = 256 KB), with one tile id per texel.
  - A fullscreen triangle's fragment shader converts each screen pixel to world space, reads the tile with `textureLoad`, and takes its color from a palette uniform (later, a texture array for tile art).
  - It costs one draw call no matter how big the map is.
  - When a tile changes at runtime (breakable blocks, later), it is patched with `queue.writeTexture` for that one texel.
- **Sprite pass:**
  - Players, ghosts, enemies, particles and UI text are all **instanced quads**.
  - Each frame the client fills a CPU-side `Float32Array` of instances `{x, y, w, h, color, uvRect, flags}` and uploads it with `writeBuffer`, then issues one draw per material (a flat-color pipeline and a textured/atlas pipeline).
  - Draw order: tiles, then enemies, then ghosts (alpha), then the local player, then particles, then UI.
- **Rendering order:** the `requestAnimationFrame` callback runs any pending fixed simulation steps, interpolates positions for drawing, then encodes and submits one command buffer.

## UI

- The **DOM holds the `<canvas>` plus a hidden `<input>`**, which is focused only for typing your name and future chat, so mobile and IME text entry work. Everything else is drawn in WebGPU.
- **Text:** `ui/text.js` builds a **glyph atlas at runtime**. It draws each character with Canvas2D `fillText` into an `OffscreenCanvas` using a system monospace font, then uploads it as a texture. Text is then just textured quads in the sprite pass, so no font files or libraries are needed.
- The **trade menu, HUD** (money, hold used/capacity, the name of the post you're at) and **leaderboard** are simple immediate-mode layouts built on top of that. Trade is keyboard-driven ([DESIGN.md § Trade posts](DESIGN.md#trade-posts)).

## Persistence readiness

- For now, the server **generates a new seed on every start**, and everything lives in memory.
- To keep persistence possible later:
  - All world, market and player state is plain JSON-able data with a `version` field. There are no class instances with hidden state and no closures holding game state.
  - The server keeps the seed and the market's PRNG state, so a saved world can be restored exactly.
  - Player identity is a server-issued `playerId`, kept separate from the display name, so accounts can be attached to it later.
- Planned path: periodic JSON snapshots to disk (M6+), then a real database once accounts exist.

## Testing and benchmarks

- `test/physics.test.js`: recorded inputs give a golden hash; unit cases for coyote time, jump buffering and wall jumps.
- `test/worldgen.test.js`: the same seed gives the same map hash, and many seeds all pass reachability ([WORLDGEN.md](WORLDGEN.md#reachability-v1)).
- `test/market.test.js`: prices stay bounded over a long simulated run ([ECONOMY.md](ECONOMY.md#v1-random-walk-prices)).
- `test/trade.test.js`: trade validation (out of zone, no money, full hold).
- `bench/snapshot.bench.js`: bytes and CPU per snapshot at N players, JSON vs. binary. Run with `npm run bench`.

## Status

| Milestone | Scope in this doc | State |
|---|---|---|
| M0 | layout, static server, hello/welcome + ping/pong, 60 Hz tick clock, WebGPU letterboxed clear, asset manifest + viewer, `npm test` | **done** 2026-09-30 |
| M1 | `physics.js` step + tuning, fixed-step client loop with interpolation, sprite pass + runtime sprite atlas, input (keyboard + gamepad), follow camera, dev tuning panel. The **tile pass landed here too** (flat palette colors with exposed-edge shading). Tile art is M2 | **done** 2026-09-30 |
| M2 | tile art in the tile pass: a 16×16 texture array, cardinal4 masks (a neighbour joins if it's the same tile or both are solid), and spikes rotated onto their solid neighbour. Also the camera on the full-size generated map, and loading the world from the server's seed | **done** 2026-09-30 |
| M3 | netcode: clock sync, prediction/reconciliation, ghosts, interest sets | not started |
| M4 | trade messages, text atlas, trade UI | not started |
| M6+ | persistence snapshots, binary protocol (if the bench says so), PvP netcode | not started |

## Open questions

- **Firefox/Safari WebGPU gaps:** M0 asks for no optional features or raised limits, so it should run anywhere WebGPU does. It has **not been tried on real browsers yet**. In the dev sandbox, headless Chromium with SwiftShader loses the device when presenting to a canvas, even for a trivial clear. The M0 pipeline was verified by rendering offscreen and reading the pixels back. Check Chrome, Firefox and Safari by hand before M1 adds anything that depends on them.
- **Batching inputs:** send one message per tick, or batch 2–3 ticks? The M3 bench and a latency feel test decide.
- **Hosting:** one small VPS/container per world is enough for v1. The `Dockerfile` (node:24-alpine, production deps only, non-root, with a healthcheck) and `docker-compose.yml` run one world. Still to decide at first deploy: TLS for `wss`, which should terminate at a reverse proxy in front of the container.
- **Mobile touch controls:** out of scope for now. Precise platforming on touch screens is a design problem, not only a technical one.
