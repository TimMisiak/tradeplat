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
  market.js             # v1 price process, quotes, net worth (server-only)
shared/
  rng.js                # sfc32 seeded PRNG + helpers
  tiles.js              # tile ids, flags (solid, oneWay, hazard), map accessors
  physics.js            # TUNING table + pure step()
  worldgen.js           # seed → map + POIs + spawners
  enemies.js            # enemy kinds, deterministic position(spawner, tick)
  goods.js              # goods catalog
  trade.js              # wallet, hold, post zones, trade validation (server authoritative, client for hints)
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
  ui/text.js            # runtime glyph + icon atlas, UI batch (text, rects, icons)
  ui/trade.js           # trade menu state, keys + layout; remembered prices
  ui/hud.js             # money, hold, post, leaderboard, interact prompt
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
- **Ramps** (45° `slopeR`/`slopeL` tiles) are walkable surfaces, not solids:
  - The box rests on the **highest ramp point under its bottom edge**.
  - While grounded, running uphill lifts the box by up to `|vx|+1` px per tick, but not if that would push the head into a ceiling. Running downhill keeps it stuck to the surface by the same amount, so you don't hop off.
  - An airborne box with a ramp within that margin under its feet gets the same lift and step tolerance. Otherwise a short hop while running uphill, rising slower than the ramp climbs, lets the ramp pass through the feet and leaves the player stuck inside it.
  - A solid tile that overlaps only that bottom margin is a step to walk onto, not a wall (the flat top at the end of a ramp). A ramp blocks like a wall only from its **tall side**.
  - Horizontal speed is the same on ramps as on flat ground.
  - Because the box rests on its highest corner, its centre floats up to 6 px above the ramp. `feetY()` gives the renderer the surface height under the centre, so the sprite's feet are drawn on the ramp.
  - On a map with no ramps, the behaviour is exactly the same as before, and the physics golden hash didn't change.
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
2. The server replies `welcome {playerId, name, protocol, serverTick, tickRate, tuningHash, world: {seed, genVersion, hash}, you, ack, players, wallet}`. `you` is the new player's starting state and `ack` its input seq (0). `players` is `[[id, name]]` for everyone else, kept current by `joined {id, name}` and `left {id}`. `wallet` is `{money, cargo, paid, hold}` (`paid` is the average unit price paid per good carried). There's no market snapshot: prices arrive only while standing in a post ([Deaths, trades and events](#deaths-trades-and-events)). A leaderboard follows the welcome right away.
3. The client **regenerates the map from the seed** ([WORLDGEN.md](WORLDGEN.md#determinism)) and checks that its own map hash and tuning hash match the server's. If either doesn't match, it shows an error and refuses to play, because prediction would be wrong.
4. Every welcome is a new server-side player, including after a reconnect. The client restarts prediction from `you` and `ack`.
5. Dev worlds (`?seed=N`, `?map=test`) aren't the server's world. They stay connected but send no input and draw no ghosts. Online, the client always simulates with the server's `TUNING` and always reconciles. Tuning-panel edits ([DESIGN.md § Movement feel](DESIGN.md#movement-feel)) apply only in the offline dev worlds. (An earlier M3 version kept panel edits online and switched corrections off. Because edits persist in `localStorage`, one stale tweak left players silently out of sync with their own ghosts.)

### Clock sync
The client pings the server once a second. `pong` carries the server's fractional tick. The client adds half the round trip to it and keeps a smoothed offset between `performance.now()` and server ticks (it resets on a jump of more than 30 ticks, such as a server restart). Ghost rendering uses this clock. Inputs are stamped with it, plus RTT/2 and a 2-tick buffer, as the `tick` that M5 enemy checks will use.

### Own player: prediction and reconciliation
- Every tick the client samples its input into a bitmask (`left, right, up, down, jump, interact`, plus the dev `respawn` bit for R). It applies that input locally and numbers it with a per-connection `seq` (1, 2, 3, …). **Once per rendered frame** it sends `input {seq, tick, bits: [...]}` with that frame's ticks, usually one and at most 15 after a hitch (up to 8 per message).
- `stepInput()` in `shared/physics.js` is one tick as every host runs it: the respawn bit resets to the spawn state, then `step()`. The client's prediction, the client's replay and the server all call it.
- **Because ghosts don't interact, the server steps each player independently, as that player's inputs arrive.** It doesn't wait on a single global lockstep. This avoids mispredictions caused by network jitter.
  - **Speed-hack guard (credit):**
    - Each server tick gives a player one tick of credit, and applying an input tick spends one. So nobody moves faster than real time.
    - Input that arrives with no credit waits in a queue of up to 30 ticks. Beyond that, it is dropped. A duplicate seq is ignored, and a gap repeats the last input. Honest clients over TCP produce neither.
    - A player whose credit passes 30 ticks (500 ms of no input) gets a **no-input filler step** each tick. Filler steps don't use up a seq, so the client's late inputs still apply in order, and it replays them on top of the server state it gets back.
    - When input resumes after filler steps, the client's catch-up burst runs on the leftover credit, and the next tick resets the credit to 2. Otherwise a client that lost time (background tab, long hitch) would stay pinned at the limit, where any jitter forces more filler steps, or its burst would sit in the queue and add lag for good.
  - Enemy collisions for an input are evaluated at the tick number that input carries, within an allowed window of ±15 ticks (±250 ms) of server time. This is effectively lag compensation, and it is safe because the enemies are deterministic. (M5)
- Every 3 ticks (20 Hz), each client gets `snap {tick, ack, you, g}`. `you` is its authoritative state after input `ack`.
  - The client keeps each unacknowledged tick's input and predicted state. If the prediction for `ack` equals `you` field for field, which is the normal case, it just drops the acknowledged entries.
  - Otherwise it takes `you`, **replays the inputs the server hasn't acknowledged yet**, and eases the visual jump out of the render position over a few frames. A jump over 64 px (a respawn) snaps instead.
- With identical code on both sides, mismatches should almost never happen. The client counts them as a **determinism health metric** in the dev panel (with seq, ack and pending count), and logs each one to the console. The expected one comes after a stall of more than 500 ms, when the server filled in no-input steps.

### Ghosts (other players)
- A snapshot's `g` lists every other player in the client's interest set as `[id, x, y, facing, anim]` (`packGhost` in `shared/protocol.js`). x and y are rounded to 0.1 px. `facing` is the drawn facing (the wall side while sliding), and `anim` is an index into `ANIMS`.
- The client buffers these and renders ghosts **6 ticks (100 ms) behind** the synced server clock, interpolating between the snapshots on either side of that time. At the ends it holds the nearest sample and doesn't extrapolate. A jump over 64 px (a respawn) or a gap over 30 ticks (the ghost was out of interest) snaps instead of sliding.
- A ghost missing from the latest snapshot is dropped once its last sample has been drawn.
- Ghosts are drawn before the local player, with the player sprite tinted translucent blue, and a name tag (from `players`/`joined`) in the UI pass.

### Enemies
- Enemy positions are never sent. The client computes `enemies.position(spawner, tick)` itself.
- Only events go over the wire: `enemyKilled {spawnerId, tick}` and `enemySpawned {spawnerId, tick}`, plus the alive/dead set in `welcome`.

### Deaths, trades and events
- **Deaths:** the client predicts the death at once (splat, restart fade) and sends nothing extra. The server detects the same death while replaying inputs, clears the player's cargo, and sends `died {tick, cause}`. If the server disagrees, which should be rare, the client follows the server.
- **Trades:** `trade {reqId, postId, goodId, qty, side}` → `tradeResult {reqId, ok, reason?, price?, wallet: {money, cargo, paid, hold}}`. The server checks that the player is inside the post zone (using the server's position), has enough money or cargo, has hold space, and that the post actually trades that good ([ECONOMY.md § Trade validation](ECONOMY.md#trade-validation)). It handles a trade as soon as it arrives, against the player's latest simulated state. Money and cargo only change on the server; the client shows the wallet from the last `welcome` or `tradeResult` and keeps one order in flight at a time.
- **Market:** the server ticks the market every 600 ticks (10 s). It sends `prices {postId, tick, goods: [[goodId, sell, buy]]}` only to players who are in that post's zone: once when the server sees them walk in (checked every tick), and again after each market tick while they stay. This supports the design rule that you only see prices where you are standing ([DESIGN.md](DESIGN.md#information-is-part-of-the-game)). The client keeps every prices message as its memory of that post, stamped with when it arrived, and calls them live if they arrived since it walked into the zone.
- **Leaderboard:** `board {rows: [[id, name, netWorth]]}`, best first, every player on the server, broadcast every 120 ticks (2 s) and once after each welcome. At the 64-player target that is about 2 KB per 2 s per client; send only the top rows plus each player's own if it grows.

### Interest management
- The world is divided into **32×32-tile chunks**. Each client's interest set is the 3×3 chunks around the chunk its player's centre is in. That covers the 40×22.5-tile view with at least a chunk of margin.
- Ghosts and enemy events outside that set aren't sent. The leaderboard is sent to everyone at a low rate (every 2 s).

### Protocol
- JSON text frames: `{t: "<type>", ...}`. Type constants are defined in `shared/protocol.js`.
- **We start with JSON on purpose.** It's easy to debug and fast enough at this scale. A benchmark in `bench/` (snapshot encode cost and bytes per client at N players) decides whether and when to switch hot messages (`input`, snapshots) to binary `ArrayBuffer` frames. The protocol module keeps encode/decode behind one interface, so switching doesn't touch game code.
- **M3 measurement** (`npm run bench -- snapshot`, Node 24, one dev machine). "Crowd" puts everyone near one post, which is the worst case for interest sets. "Spread" puts them evenly across the map.

  | Players | Layout | Server CPU for snapshots | JSON per client | Packed binary (est.) |
  |---|---|---|---|---|
  | 64 | crowd | 1.1 ms per round, ~2% of a core | 1.6 KB/snap, 31 KiB/s | 15 KiB/s |
  | 64 | spread | 0.24 ms, ~0.5% | 350 B, 7 KiB/s | 2 KiB/s |
  | 128 | crowd | 4.2 ms, ~8% | 3.0 KB, 59 KiB/s | 28 KiB/s |

  Physics costs about 0.4 µs per step (0.15% of a core for 64 players). **Verdict: stay on JSON.** At the 64-player target, the worst case is ~2 MB/s of total egress and 2% of a core. Binary would roughly halve the bytes. Revisit if crowds at posts turn out to be common, or the player target grows.

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
  - Draw order: tiles, then post signs, then enemies, then ghosts (alpha), then the local player, then particles, then UI.
  - **UI pass:** the same sprite pipeline with its own view uniform (camera at 0,0, so positions are virtual screen px) and its own texture, the UI atlas from `ui/text.js`. Both batches share one instance buffer; the UI draws with `firstInstance` after the world sprites. World-anchored labels (ghost name tags, post names) are converted to screen px on the CPU.
- **Rendering order:** the `requestAnimationFrame` callback runs any pending fixed simulation steps, interpolates positions for drawing, then encodes and submits one command buffer.

## UI

- The **DOM holds the `<canvas>` plus a hidden `<input>`**, which is focused only for typing your name and future chat, so mobile and IME text entry work. Everything else is drawn in WebGPU.
- **Text:** `ui/text.js` builds a **glyph atlas at runtime**. It draws each character with Canvas2D `fillText` into an `OffscreenCanvas` using a system monospace font, then uploads it as a texture. Text is then just textured quads in the sprite pass, so no font files or libraries are needed.
  - Glyphs are monospace cells of 6×11 virtual px. The atlas is drawn at the viewport's integer scale, so a cell maps 1:1 onto device pixels and text is crisp (not upscaled pixel text). It's rebuilt when the scale changes.
  - Printable ASCII and a few symbols are preloaded. Any other character (player names may be any script) is added on first use and the texture re-uploaded; a full atlas draws `?`.
  - Goods icons from the manifest are copied into the same atlas (nearest-neighbour), so the whole UI is one texture. A good without an icon gets a flat swatch in a post-palette color.
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
- `test/trade-ui.test.js`: trade menu keys, order sizing (×5 clamped, max), refusals explained without a request, price memory ordering.
- `test/netcode.test.js`: the server's credit and queue (speed-hack guard, gaps, duplicates, filler steps and recovery). Also: server state equals a plain replay, prediction against the server gives zero mismatches, a misprediction replays correctly, ghost interpolation, and interest chunks.
- `test/server.test.js`: over real sockets, welcome fields, acknowledged input matches a local replay, and two players see each other as ghosts with join and leave events.
- `bench/snapshot.bench.js`: bytes and CPU per snapshot at N players, JSON vs. a packed-binary estimate. Run with `npm run bench -- snapshot`.

## Status

| Milestone | Scope in this doc | State |
|---|---|---|
| M0 | layout, static server, hello/welcome + ping/pong, 60 Hz tick clock, WebGPU letterboxed clear, asset manifest + viewer, `npm test` | **done** 2026-09-30 |
| M1 | `physics.js` step + tuning, fixed-step client loop with interpolation, sprite pass + runtime sprite atlas, input (keyboard + gamepad), follow camera, dev tuning panel. The **tile pass landed here too** (flat palette colors with exposed-edge shading). Tile art is M2 | **done** 2026-09-30 |
| M2 | tile art in the tile pass: a 16×16 texture array, cardinal4 masks (a neighbour joins if it's the same tile or both are solid), and spikes rotated onto their solid neighbour. Also the camera on the full-size generated map, and loading the world from the server's seed | **done** 2026-09-30 |
| M3 | netcode: clock sync, prediction/reconciliation (credit-based speed guard, no-input filler), ghosts with 100 ms interpolation, 3×3-chunk interest sets, join/leave, snapshot bench (verdict: JSON). Checked in headless Chromium with two tabs: no mismatches in normal play, and one correction after a forced 1.2 s stall. Ghost name tags wait for the M4 text atlas | **done** 2026-09-30 |
| M4 | trade, prices and leaderboard messages (protocol 3), text + icon atlas and UI pass, trade menu, HUD, leaderboard, ghost name tags, post signs. Checked in headless Chromium (frames read back from an offscreen texture): HUD, signs, ghost name tags, the menu, ×5 and max buys, icon art, the offline dev world | **done** 2026-09-30 |
| M6+ | persistence snapshots, binary protocol (if the bench says so), PvP netcode | not started |

## Open questions

- **Firefox/Safari WebGPU gaps:** M0 asks for no optional features or raised limits, so it should run anywhere WebGPU does. It has **not been tried on real browsers yet**. In the dev sandbox, headless Chromium with SwiftShader loses the device when presenting to a canvas, even for a trivial clear. The M0 pipeline was verified by rendering offscreen and reading the pixels back. Check Chrome, Firefox and Safari by hand before M1 adds anything that depends on them.
- **Batching inputs:** M3 sends one message per rendered frame, carrying that frame's ticks (so usually one tick per message at 60 fps, which is ~60 small frames/s per client up). Worth batching 2–3 ticks only if a latency feel test says the added delay is unnoticeable and server message overhead shows up in a profile.
- **Client clock drift:** a client whose clock runs fast fills its server queue over a long session (30 ticks at 100 ppm takes ~80 min). That adds latency to its acks and to how others see it, then drops input. If it shows up, send the queue length in snapshots and have the client slow its tick slightly (time dilation).
- **Latency testing:** everything so far ran on localhost. Try a real network, or an artificial delay and jitter, before M5 relies on the input `tick`.
- **Hosting:** one small VPS/container per world is enough for v1. The `Dockerfile` (node:24-alpine, production deps only, non-root, with a healthcheck) and `docker-compose.yml` run one world. Still to decide at first deploy: TLS for `wss`, which should terminate at a reverse proxy in front of the container.
- **Mobile touch controls:** out of scope for now. Precise platforming on touch screens is a design problem, not only a technical one.
