# Game Design

This doc covers what the game is and how it should feel. The tech is in [ARCHITECTURE.md](ARCHITECTURE.md), the map in [WORLDGEN.md](WORLDGEN.md), and prices in [ECONOMY.md](ECONOMY.md).

## Pitch

Taipan! with your thumbs. Trading gives you the *why*: a price gap between two posts. Platforming gives you the *how*: a dangerous run between them. The more you carry, the more you stand to lose, so every run is a risk decision.

## Core loop

1. **Spawn** at a trade post.
2. **Read prices** at the post. You also remember prices you've seen elsewhere, and those memories go stale.
3. **Buy** cargo, up to your hold capacity and your money.
4. **Run** across the map to another post, getting past terrain, hazards and enemies.
5. **Sell** at a profit, or not, if prices moved while you were travelling.
6. Repeat, growing your **net worth** (money + cargo, valued as in [ECONOMY.md § Net worth](ECONOMY.md#net-worth-leaderboard)).

A live **leaderboard** ranks players on the server by net worth. For now the world resets whenever the server restarts (see [ARCHITECTURE.md § Persistence readiness](ARCHITECTURE.md#persistence-readiness)).

### Information is part of the game
A post shows prices only while you're standing in it. Prices you've seen before are shown with their age ("Ore @ Rustmouth: 42, 3 min ago"). In the trade menu, the selected good lists the best prices you remember other posts paying for it, with how old each one is. The memory lasts until you reload or the server's world changes. You can't see live prices at a distance for now. Scouting and remembering are part of the skill. Selling that information (price boards, a scouting item) is a possible later feature.

## Movement feel

The target is Super Meat Boy: fast, precise and forgiving where it matters.

| Mechanic | Intent | Starting value (60 Hz frames) |
|---|---|---|
| Run acceleration | Reach a high top speed (5 px/tick, ~19 tiles/s) quickly, with a short visible ramp | ~10 frames to top speed |
| Ground friction | Stop quickly when you let go, with a slight slide | ~7 frames to stop |
| Air control | Strong: you can steer mid-jump | ~70% of ground acceleration |
| Variable jump | Releasing jump early cuts upward velocity | cut to ~40% on release |
| Coyote time | You can still jump just after leaving a ledge | 6 frames |
| Jump buffer | A jump pressed just before landing still fires | 6 frames |
| Wall slide | Holding into a wall slows your fall | fall speed capped at ~30% |
| Wall jump | Kicks you up and away; input briefly locked away from the wall | ~8 frame lock |
| Terminal velocity | Caps fall speed so collisions stay readable and stable | ≤ 1 tile/frame |

All of these constants live in a single tuning table (`TUNING` in `shared/physics.js`), which both client and server import. In game, the **\` (backquote) key** opens a dev panel that edits them live, shows the physics state, and copies the values to paste back into `TUNING`. Edits persist only in that browser. Edits apply only in the offline dev worlds (`?seed=N` or `?map=test`). Online, the server's physics is authoritative, so the client uses `TUNING` and the panel says your edits are ignored. **R** gives up: you die on the spot and respawn at your last post, losing your cargo like any other death. It's there for when you're stuck. `test/testmap.test.js` fails if a tuning change makes any section of the test level impossible.

**Ramps.** The world has 45° ramps, and the generator turns every 1-tile floor step into one ([WORLDGEN.md § Pipeline](WORLDGEN.md#pipeline)), so hills and tunnels can be run up and down at full speed without jumping. Horizontal speed is the same on a ramp as on flat ground. A ramp's tall side is a wall. Precision challenges come from gaps, walls and hazards, not from staircases.

**Cargo does not affect movement.** A full hold moves the same as an empty one. Cargo is limited only by hold capacity. This is a deliberate choice: the platforming feel never changes, and the risk of carrying cargo comes from what you'd lose, not from worse handling.

Controls: keyboard first (arrows/WASD move, Space/Z/K jump, E/Enter interact). Gamepad support through the Gamepad API is cheap to add later.

## Cargo, money and death

- Every unit of every **good** takes one slot in the hold ([ECONOMY.md § Goods](ECONOMY.md#goods-catalog)).
- The **hold** has a fixed capacity, 20 units to start. Hold upgrades bought at posts are a candidate money sink later.
- **Money** has no weight or size and is never lost.
- **When you die, you lose all your cargo.** You respawn almost at once at the **last trade post you visited** (the last post zone you stood in, or the spawn post if you haven't been anywhere yet). Your money is untouched.
- Dying is Meat Boy-style: you burst into a splat with a little screen shake, the screen fades to black, and you're back at the post 40 ticks (~0.7 s) after you died. The splat leaves a stain on the level for a minute and a half. A message says what killed you and how much cargo you lost.
- One touch of a hazard or enemy kills. There's no health, no life counter and no cooldown. The only penalties are the lost cargo and the time it takes to get back.

## Trade posts

- Trade posts are structures placed in the world by the generator. Each one has a sheltered **zone** and a safe landing platform.
- Standing in the zone and pressing interact (E/Enter) opens the **trade UI**. It's drawn in-canvas (see [ARCHITECTURE.md § UI](ARCHITECTURE.md#ui)) and controlled with the keyboard: ↑/↓ (W/S) pick a good, ←/→ (A/D, or 1/2/3) pick ×1 / ×5 / max, **Z** (or B) buys and **X** (or V) sells. Esc, E, Enter or Q closes it. ×5 is clamped to what you can afford and fit, so it never fails for being too big. The menu lists the post's goods with its buy and sell price, then any good you carry that the post doesn't trade, marked "not trading". Each row shows how many you carry and the average price you paid for them ([ECONOMY.md § Trade validation](ECONOMY.md#trade-validation)), and the menu shows what the selected order would cost or pay.
- **The world doesn't pause.** The simulation keeps running while the UI is open. While it's open the menu takes the keyboard, so your character stands still. If anything moves you out of the zone (a respawn, say), the menu closes. Nothing that can hurt you comes within 6 tiles of a post (no spikes, and no enemy's path or sword), so a post is always safe.
- The HUD shows money, hold used/capacity and the post you're standing in. A leaderboard of net worth (top 5, plus your own rank if lower) sits top-right.
- Each post stocks a **random subset** of the catalog. Which goods it stocks, and whether it only buys or sells some of them, sets up the trade routes.
- Each post has a generated name and a color identity, so you can tell them apart at a glance. Its name floats over the roof and a sign in its color hangs in each doorway.

## Enemies and hazards (v1)

Enemies are **obstacles, not a combat system**. The platformer is about avoiding them.

| Kind | Behaviour | Killable |
|---|---|---|
| Spikes | Static tile. The teeth point away from the rock the spike sits on, and only they hurt: the 10 px nearest the base | no |
| Saw | Moves up and down across a low passage, easing at the ends, every 1.7–2.7 s. You time your run under it. Round hitbox, 11 px radius | no |
| Patroller | Walks back and forth along its platform at 0.5–1 px/tick. At each end it stands for 0.8 s and swings its sword the way it was walking: 0.3 s of wind-up (the warning), then 1/6 s with the sword out, reaching 14 px past its body | yes, by stomping |
| Flyer | Loops around its anchor in an ellipse or a figure-8, every 2.5–5 s | no (v1) |

- **Stomping:** land on a patroller's head while falling (your feet within 6 px of its top on the tick before) and it dies. You bounce off like a jump: hold jump for the full bounce, or let go for a short one. Touching it any other way, or its sword, kills you.
- **Forgiveness:** what hazards and enemies hit is your body 2 px narrower on each side and 3 px shorter at the top. The feet count all the way down, so stomps and floor spikes are judged where your feet are.
- **What worldgen promises** ([WORLDGEN.md § Pipeline](WORLDGEN.md#pipeline) stage 5): floor spikes come in runs of 1–3 with flat ground and headroom on both sides, so you can always jump them. Spikes never cut off a post or make a pit you can't climb out of. Saws only cross passages tall enough to run under when they're up, and patrollers only walk runs of at least 4 tiles.
- Enemies appear at **spawner points** placed by world generation ([WORLDGEN.md § Pipeline](WORLDGEN.md#pipeline)). Spawner density goes up with distance from posts, so the middle of a route is the most dangerous part.
- A killed enemy **respawns** 20 s later, wherever its path has it by then. It blinks for its first second back and is harmless while it does, so it can't kill you by appearing on top of you.
- All enemy motion is a **deterministic function of its spawn parameters and the server tick**. That lets every client predict enemies exactly with almost no network traffic ([ARCHITECTURE.md § Netcode](ARCHITECTURE.md#netcode)).
- Later enemy ideas: turrets with deterministic projectile patterns, chasers (harder to network, because they depend on where the player is), and hazards that change with time of day.

## Multiplayer experience

- **One shared world and one shared market per server.** Everyone runs the same map and trades in the same posts.
- **Other players are ghosts.** They're drawn translucent with a name tag and don't collide with you or enemies from your point of view. The simulation is structured so physical PvP is possible later ([ARCHITECTURE.md § Simulation](ARCHITECTURE.md#simulation)).
- **Why share the market?** Other players are your competition. Once v2 supply and demand lands ([ECONOMY.md](ECONOMY.md#v2-supply-and-demand)), a player who dumps 20 ore at a post drops its price for everyone after them. In v1, prices are a random walk, so the shared market is shared in name only. That's acceptable for M4.
- Identity: you pick a display name when you join. There are no accounts yet.

## Visual direction

Flat-colored tiles and simple sprite quads with a readable palette: terrain is muted, hazards are saturated red, enemies orange, and posts each have their own color. You are bright, and ghosts are desaturated and translucent. Juice is added in layers: a squash-and-stretch jump, dust particles, screen shake on death, and a death splat that stays on the level for a while (a Meat Boy nod). Art assets can replace the flat quads later without changing the renderer's design. The asset spec and pipeline are in [ART.md](ART.md).

## Status

| Area | State |
|---|---|
| Core loop | designed |
| Movement feel | built (M1); tuning in progress using the \` panel |
| Cargo / death | cargo, money and hold built (M4). Death, cargo loss, respawn at the last post, the R give-up key, splat, stains, shake, fade and the death message built (M5) |
| Trade posts / UI | built (M4): trade menu, HUD, leaderboard, price memory with ages, post signs and names |
| Enemies v1 | built (M5): spikes, saws, patrollers (stomp, sword swing), flyers |
| Multiplayer ghosts | built (M3): translucent, tinted, interpolated. Name tags since M4 |

## Open questions

- **Trade menu on a gamepad:** the menu is keyboard-only for now. A gamepad needs menu navigation on the d-pad and buy/sell on face buttons.
- **Dropped cargo:** when you die, should your cargo drop as a pickup that other players (or you) can grab for a while? That would make death a multiplayer event and give scavengers a role.
- **Time model:** should there be an in-game day clock (price ticks per day, day/night hazards), or only real time?
- **Identity:** anonymous names now. When persistence lands, what kind of accounts?
- **PvP:** stomping other players? Stealing cargo? Only in opt-in zones? This affects netcode a lot (see [ARCHITECTURE.md § PvP later](ARCHITECTURE.md#pvp-later)).
- **Checkpoints:** is "last visited post" enough on long routes, or do we need checkpoints between posts that you can't trade at?
- **Stomp on flyers:** should flyers become killable once there's a reason to kill them?
- **Enemy tuning:** densities, speeds and the patroller's swing timing are first guesses (constants in `shared/enemies.js` and the rates in `shared/worldgen.js`). Playtest them, especially how dangerous the middle of a route feels compared with near posts.
- **Invulnerability after respawn:** posts have no hazards nearby, so there's none. Revisit if spawners ever come close to posts.
