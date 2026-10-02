# CLAUDE.md

Platform Trader: a multiplayer web game that combines Super Meat Boy-style platforming with Taipan-style trading. It is a Node server with a vanilla-JS WebGPU client. See [README.md](README.md) for the pitch and how to run it.

## Where things are decided

Read the owning doc before changing an area. When a milestone lands, update that doc's **Status** table and the roadmap in README.md.

| Topic | Doc |
|---|---|
| Roadmap / milestones | [README.md](README.md#roadmap) |
| Game rules: movement feel, cargo, death, posts, enemies, ghosts | [DESIGN.md](DESIGN.md) |
| Stack, repo layout, simulation, netcode, rendering, UI, persistence | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Map generation, determinism, reachability | [WORLDGEN.md](WORLDGEN.md) |
| Goods, prices, trade rules, v2/v3 economy | [ECONOMY.md](ECONOMY.md) |
| Art: style, asset spec, manifest, viewer | [ART.md](ART.md) |

Every design decision lives in exactly one doc, and other docs link to it rather than repeat it. All documentation is markdown at the repo root.

## Rules that are easy to break

- **No build step and no frameworks.** The browser loads `client/` and `shared/` ES modules as they are. Any third-party browser module comes from a CDN via the import map in `client/index.html`. `ws` is the only runtime dependency. Ask before adding another.
- **`shared/` must give bit-identical results on client and server:**
  - no `Math.random` (use `shared/rng.js`);
  - no `Math.sin/cos/exp/pow` (use `shared/mathdet.js`);
  - no DOM, Node APIs, or wall-clock time.
- **`step()` in `shared/physics.js` and `stepPlayer()` in `shared/sim.js` stay pure.** Prediction, rollback and PvP later depend on it.
- **Worldgen output changes → bump `GEN_VERSION`** and update the golden hash in `test/worldgen.test.js`. Worldgen reads `ENVELOPE`, never `TUNING`.
- **Stopping dev servers:** Node renames its process to `MainThread`, so `pgrep -x node` misses it. Match on the command line instead (`ps -eo pid,args`).
- **The server is authoritative** for money, cargo, deaths and prices. The client only predicts its own movement.
- **State is plain JSON-able data with a `version` field,** with no game state hidden in classes or closures, so persistence can be added later.
- **HTTPS always works.** The game is tested over https behind a TLS proxy (WebGPU needs a secure context). Build every URL from `location`: `wss:` when the page is `https:`, and no hard-coded `http://`, `ws://`, host or port. Anything added later (asset URLs, APIs) must work under both schemes.
- **Import `shared/` by relative path** (`../shared/x.js`) so the same file works in the browser and in Node tests.
- **Art lives in `client/assets/`, listed in `manifest.json`.** Game code looks assets up by the names in `shared/tiles.js`, `shared/goods.js` and `SPRITE_SPEC`, and falls back to flat palette colors when one is missing.
- **Minimal DOM.** The game is drawn in WebGPU, including its text. Dev tools such as `client/tools/*` may use the DOM.
- **Measure before re-architecting.** A binary protocol, workers or sharding each need a benchmark in `bench/` first.

## Commands

```sh
npm start        # http + ws server (PORT env, default 3000; SEED=N for a fixed world)
npm test         # node --test
npm run test:assets  # manifest ↔ files check only
npm run bench    # bench/*.bench.js
```
