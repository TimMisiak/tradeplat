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
6. Repeat, growing your **net worth** (money + cargo at local sell price).

A live **leaderboard** ranks players on the server by net worth. For now the world resets whenever the server restarts (see [ARCHITECTURE.md § Persistence readiness](ARCHITECTURE.md#persistence-readiness)).

### Information is part of the game
A post shows prices only while you're standing in it. Prices you've seen before are shown with their age ("Ore @ Rustmouth: 42, 3 min ago"). You can't see live prices at a distance for now. Scouting and remembering are part of the skill. Selling that information (price boards, a scouting item) is a possible later feature.

## Movement feel

The target is Super Meat Boy: fast, precise and forgiving where it matters.

| Mechanic | Intent | Starting value (60 Hz frames) |
|---|---|---|
| Run acceleration | Reach top speed almost instantly | ~6 frames to top speed |
| Ground friction | Stop almost instantly when you let go | ~4 frames to stop |
| Air control | Strong: you can steer mid-jump | ~70% of ground acceleration |
| Variable jump | Releasing jump early cuts upward velocity | cut to ~40% on release |
| Coyote time | You can still jump just after leaving a ledge | 6 frames |
| Jump buffer | A jump pressed just before landing still fires | 6 frames |
| Wall slide | Holding into a wall slows your fall | fall speed capped at ~30% |
| Wall jump | Kicks you up and away; input briefly locked away from the wall | ~8 frame lock |
| Terminal velocity | Caps fall speed so collisions stay readable and stable | ≤ 1 tile/frame |

All of these constants live in a single tuning table in `shared/physics.js`, which both client and server import. M1 includes a debug overlay to tweak them live while tuning.

**Cargo does not affect movement.** A full hold moves the same as an empty one. Cargo is limited only by hold capacity. This is a deliberate choice: the platforming feel never changes, and the risk of carrying cargo comes from what you'd lose, not from worse handling.

Controls: keyboard first (arrows/WASD move, Space/Z/K jump, E/Enter interact). Gamepad support through the Gamepad API is cheap to add later.

## Cargo, money and death

- Each **good** takes up some **size** in hold units ([ECONOMY.md § Goods](ECONOMY.md#goods-catalog)).
- The **hold** has a fixed capacity, 20 units to start. Hold upgrades bought at posts are a candidate money sink later.
- **Money** has no weight or size and is never lost.
- **When you die, you lose all your cargo.** You respawn instantly (after a short Meat Boy-style fade/restart) at the **last trade post you visited**. Your money is untouched.
- There's no life counter and no cooldown. The only penalties are the lost cargo and the time it takes to get back.

## Trade posts

- Trade posts are structures placed in the world by the generator. Each one has a sheltered **zone** and a safe landing platform.
- Standing in the zone and pressing interact opens the **trade UI**. It's drawn in-canvas (see [ARCHITECTURE.md § UI](ARCHITECTURE.md#ui)) and controlled with the keyboard: pick a good, then press buy/sell with ×1 / ×5 / max quantities.
- **The world doesn't pause.** The simulation keeps running while the UI is open. Post zones are free of hazards and enemy spawns, but a flyer can wander close to the edge.
- Each post stocks a **random subset** of the catalog. Which goods it stocks, and whether it only buys or sells some of them, sets up the trade routes.
- Each post has a generated name and a color identity, so you can tell them apart at a glance.

## Enemies and hazards (v1)

Enemies are **obstacles, not a combat system**. The platformer is about avoiding them.

| Kind | Behaviour | Killable |
|---|---|---|
| Spikes | Static tile; touching one kills you | no |
| Saw | Static or moving on a fixed track; kills on contact | no |
| Patroller | Walks back and forth along the length of its platform | yes, by stomping; bounces you up |
| Flyer | Follows a sine or loop path around its anchor | no (v1) |

- Enemies appear at **spawner points** placed by world generation ([WORLDGEN.md § Pipeline](WORLDGEN.md#pipeline)). Spawner density goes up with distance from posts, so the middle of a route is the most dangerous part.
- A killed enemy **respawns** from its spawner a set time later (e.g. 20 s).
- All enemy motion is a **deterministic function of its spawn parameters and the server tick**. That lets every client predict enemies exactly with almost no network traffic ([ARCHITECTURE.md § Netcode](ARCHITECTURE.md#netcode)).
- Later enemy ideas: turrets with deterministic projectile patterns, chasers (harder to network, because they depend on where the player is), and hazards that change with time of day.

## Multiplayer experience

- **One shared world and one shared market per server.** Everyone runs the same map and trades in the same posts.
- **Other players are ghosts.** They're drawn translucent with a name tag and don't collide with you or enemies from your point of view. The simulation is structured so physical PvP is possible later ([ARCHITECTURE.md § Simulation](ARCHITECTURE.md#simulation)).
- **Why share the market?** Other players are your competition. Once v2 supply and demand lands ([ECONOMY.md](ECONOMY.md#v2-supply-and-demand)), a player who dumps 20 ore at a post drops its price for everyone after them. In v1, prices are a random walk, so the shared market is shared in name only. That's acceptable for M4.
- Identity: you pick a display name when you join. There are no accounts yet.

## Visual direction

Flat-colored tiles and simple sprite quads with a readable palette: terrain is muted, hazards are saturated red, enemies orange, and posts each have their own color. You are bright, and ghosts are desaturated and translucent. Juice is added in layers: a squash-and-stretch jump, dust particles, screen shake on death, and a death splat that stays on the level for a while (a Meat Boy nod). Art assets can replace the flat quads later without changing the renderer's design.

## Status

| Area | State |
|---|---|
| Core loop | designed |
| Movement feel | designed; tuning is M1 |
| Cargo / death | designed; built in M4/M5 |
| Trade posts / UI | designed; M4 |
| Enemies v1 | designed; M5 |
| Multiplayer ghosts | designed; M3 |

## Open questions

- **Dropped cargo:** when you die, should your cargo drop as a pickup that other players (or you) can grab for a while? That would make death a multiplayer event and give scavengers a role.
- **Time model:** should there be an in-game day clock (price ticks per day, day/night hazards), or only real time?
- **Identity:** anonymous names now. When persistence lands, what kind of accounts?
- **PvP:** stomping other players? Stealing cargo? Only in opt-in zones? This affects netcode a lot (see [ARCHITECTURE.md § PvP later](ARCHITECTURE.md#pvp-later)).
- **Checkpoints:** is "last visited post" enough on long routes, or do we need checkpoints between posts that you can't trade at?
- **Stomp on flyers:** should flyers become killable once there's a reason to kill them?
