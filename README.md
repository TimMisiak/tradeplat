# Platform Trader (working title)

A web-based multiplayer game that combines **tight, Super Meat Boy-style platforming** with **Taipan!/Gazillionaire-style trading**. Everyone on a server shares one procedurally generated world and one market. You run, jump and wall-jump between trade posts, buying low and selling high, while hazards and respawning enemies stand in the way. If you die, you lose everything you're carrying.

## Running

```sh
npm install
npm start          # serves the game on http://localhost:3000 (PORT env overrides)
npm test           # node --test
npm run test:assets  # just the asset manifest check (see ART.md)
```

Or run it in a container with `docker compose up --build`. The compose file publishes the server on `${HOST_PORT}`. `client/` is bind-mounted, so client and art edits show up on a browser reload. Changes to `server/` or `shared/` are baked into the image, so they need a rebuild (the Rebuild/Restart button, or `docker compose up --build`).

Browsers only expose WebGPU in a secure context, so open the game over **https** (or on `localhost`). The server speaks plain HTTP; in deployment, TLS terminates at the proxy in front of it. You need a browser with WebGPU (current Chrome/Edge, Safari 26+, or Firefox with WebGPU enabled). There is no build step. The browser loads the ES modules directly from `client/` and `shared/`.

## Documents

| Doc | Owns |
|---|---|
| [DESIGN.md](DESIGN.md) | Game design: core loop, movement feel, cargo and death, trade posts, enemies, multiplayer experience |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technology choices, repo layout, simulation, netcode, rendering, UI, persistence readiness |
| [WORLDGEN.md](WORLDGEN.md) | Procedural map generation, determinism, reachability checking |
| [ECONOMY.md](ECONOMY.md) | Goods, price models (random walk → supply/demand → production tree), trade rules |
| [ART.md](ART.md) | Art assets: style rules, required tiles/sprites/icons, manifest format, asset viewer |

Each decision is written down in one doc, and the others link to it. Every doc ends with a **Status** table and **Open questions**.

## Roadmap

| # | Milestone | Main doc | Status |
|---|---|---|---|
| M0 | Repo skeleton, static server, WebGPU clear-screen, `node --test` running | ARCHITECTURE, ART | **done** 2026-09-30 |
| M1 | Shared physics plus a local single-player on a hand-written test map, with the movement feel tuned | DESIGN, ARCHITECTURE | **built** 2026-09-30. Feel tuning is ongoing with the \` panel |
| M2 | World generation with the flood-fill reachability check, the tile-texture renderer, and the scrolling camera | WORLDGEN | not started |
| M3 | Server-authoritative netcode: prediction, reconciliation, and interpolated ghosts | ARCHITECTURE | not started |
| M4 | Trade posts, v1 random-walk market, hold capacity, in-canvas trade UI | ECONOMY, DESIGN | not started |
| M5 | Hazards and enemies, death, cargo loss, respawn | DESIGN | not started |
| M6+ | v2 supply and demand, v3 production tree, persistence, PvP study | ECONOMY, ARCHITECTURE | not started |
