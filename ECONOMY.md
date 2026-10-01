# Economy

This doc covers goods, prices and trade rules. There are three stages: **v1 random walk → v2 supply and demand → v3 production tree**. Game rules for carrying and losing cargo are in [DESIGN.md](DESIGN.md#cargo-money-and-death). How trades are networked is in [ARCHITECTURE.md](ARCHITECTURE.md#deaths-trades-and-events).

## Principles

- **The server owns the market.** Price processes run only on the server (`server/market.js`). Clients receive prices and never compute them, so this code may use any `Math` function and any randomness.
- **Price gaps have to persist long enough to plan a trip around.** A route should stay roughly profitable for longer than the trip takes (30–90 s), with enough noise that it's still a gamble.
- **Each stage keeps the data model of the one before.** v2 adds stock to v1, and v3 adds industries to v2. The trade API (`trade {postId, goodId, qty, side}`) doesn't change.

## Goods catalog

Goods are defined in `shared/goods.js` (the catalog is shared so the client can show names). Every good takes one hold slot per unit. Starting values:

| id | Good | Base price | Volatility σ | v3 tier |
|---|---|---|---|---|
| `water` | Water | 8 | 0.03 | raw |
| `grain` | Grain | 12 | 0.04 | raw |
| `ore` | Ore | 20 | 0.05 | raw |
| `fuel` | Fuel | 35 | 0.08 | raw |
| `food` | Rations | 30 | 0.04 | intermediate |
| `metal` | Metal | 60 | 0.05 | intermediate |
| `cloth` | Cloth | 45 | 0.05 | intermediate |
| `tools` | Tools | 140 | 0.06 | finished |
| `meds` | Medicine | 220 | 0.09 | finished |
| `relics` | Relics | 600 | 0.15 | luxury |

With a 20-unit hold ([DESIGN.md](DESIGN.md#cargo-money-and-death)), the hold limits how much of a cheap good you can carry and money limits an expensive one. The player starts with **500 money**.

## Posts and what they trade

- Each post trades a **random subset of 4–6 goods**, buying and selling each of them.
- The subsets are chosen by the server from its own seeded RNG (seeded from the world seed), drawn after world generation. Each good is guaranteed to be traded at ≥ 2 posts, otherwise it would be useless. A good that falls short is added to posts that still have room; only if every other post is full does one go to 7 goods.
- Each (post, good) pair gets a persistent **local bias** `b`: a log-normal factor with its log in about [−0.5, +0.5], which works out to roughly ×0.6–×1.65 around the base price.
  - **Without a bias, every post would center on the same price, and profit would come only from noise.** The bias gives each post a lasting identity ("ore is cheap at Rustmouth, dear at Skyhold"), and the random walk moves prices around it.
  - v3 replaces the bias with actual production and consumption.

## v1 random-walk prices

Each (post, good) pair has a mid price that follows a **mean-reverting random walk in log space** (a discrete Ornstein–Uhlenbeck process). The market ticks every **10 s**:

```
x    = ln(mid)
μ    = ln(base · b)                  // this post's long-run price
x   += θ·(μ − x) + σ·N(0,1)          // θ ≈ 0.05 per tick, σ per good (table)
mid  = e^x
```

- **Why mean reversion?** A pure random walk in log price drifts without bound. Over a long server uptime, prices would end up at 0.01 or 10⁶. With mean reversion, the long-run spread of the log price is `σ/√(2θ−θ²)`. For θ = 0.05 and σ = 0.05, that's about 0.16, so about 95% of the time the price stays within ×0.73–×1.38 of the post's long-run price.
- **How long a trend lasts:** a deviation from the long-run price halves in `ln2/θ ≈ 14 ticks ≈ 2.3 min`. That is longer than a trip, which is what we want: a price you saw is still meaningful when you arrive, but not guaranteed.
- **Spread:** the post sells at `round(mid·(1 + s/2))` and buys at `round(mid·(1 − s/2))`, with `s = 8%`. Prices are whole numbers with a minimum of 1, and the sell price is always at least 1 above the buy price (otherwise rounding gives cheap goods like water no spread at all).
- **Stock is unlimited in v1,** and player trades don't move prices. The hold capacity is the only limit on trade size.
- **Initial state:** each price starts at a random point drawn from that long-run spread, so the market isn't flat when the server starts.
- **Normal samples** come from Box–Muller on the market's own seeded PRNG. The PRNG state is part of the market state so it can be persisted later.

### Net worth (leaderboard)
Net worth is money plus cargo. Each cargo unit is valued at the **mean buy price (what posts pay) across the posts that trade that good**. That is fair and stable, and it doesn't depend on where the player is standing. It's rounded to a whole number.

## Trade validation

The rules live in `shared/trade.js` (`checkTrade`, `applyTrade`), so the client can grey out what it can't do and size "max" orders. Only the server's result changes money or cargo. The server refuses a trade when:

- the player isn't standing in that post's zone, **by the server's position** (the tile under the hitbox's centre column and feet row is inside `post.zone`);
- the post doesn't trade that good, or the good doesn't exist;
- the quantity isn't a whole number in 1…1000, or the side isn't `buy`/`sell`;
- buying: the cost is more than the player's money, or the goods don't fit in the hold (`qty` on top of the units carried);
- selling: the player carries fewer units than that.

A trade fills completely at the price at the moment the server handles it (in v1, a market tick can land between the player seeing a price and the order arriving). The answer carries the unit price and the new wallet.

The wallet also keeps the **average price paid** per good carried (`wallet.paid`). A buy folds its price in, weighted by units (`(avg × had + price × qty) / (had + qty)`). A sell leaves it unchanged, and it's dropped when the last unit goes. Individual lots aren't tracked.

### v1 market state (plain data)
```js
{ version: 1, tick, rng: [a,b,c,d],
  posts: { [postId]: { spread, goods: { [goodId]: { bias, x } } } } }
```

## v2 supply and demand

Players move prices, and the shared market becomes competitive.

- Each (post, good) pair holds a **stock S** and a **target T**.
- **Price follows scarcity:** `mid = base · b · (T/S)^ε`, clamped to [×0.25, ×4], with ε ≈ 0.7.
- **Trades move stock:** buying lowers S, and selling raises S. A large order is priced **one unit at a time** (it is effectively the integral along the curve), so dumping 20 ore gets worse and worse returns. That price slippage is the natural limit on trade size in v2.
- **Stock drifts back:** each market tick, `S += r·(T − S)`, a restock or consumption drift standing in for production we don't model yet. A little noise on `T` keeps things moving when nobody trades. The v1 random walk is retired.
- **The shared market becomes real:** if a rival sells ore at Skyhold just before you, you get a worse price. Scouting and route choice now depend on what other players are doing.
- **Stock is finite:** a post can run out of a good (S reaches a floor, and buying is refused).

## v3 production tree

In v3, prices come from actual production and consumption.

- Each post has **industries** (recipes) and a **population**:
  ```js
  { inputs: { ore: 2, fuel: 1 }, outputs: { metal: 1 }, ratePerTick: 1 }
  ```
  - **Extractors** have no inputs and are the sources: water, grain, ore, fuel.
  - **Processors** turn inputs into outputs: grain + water → rations, ore + fuel → metal, grain → cloth, metal + fuel → tools, rations + cloth → medicine.
  - **Population** consumes goods (rations, water, medicine) and is the sink.
- A recipe runs each tick only if its inputs are in stock, so **scarcity spreads up the tree.** If ore runs short, metal and then tools get expensive downstream.
- **Where industries go** follows the map: ore and fuel in caves, grain and water on the surface, luxuries on sky islands. The v2 target `T` becomes the level a post needs, based on its recipes and population.
- **Keeping the economy healthy:** a closed production tree with no players can stall or blow up. There are two guardrails:
  1. A slow baseline restock or decay on every good, like v2's drift at a low rate.
  2. Offline tuning: `npm run econ-sim` simulates hours of market ticks with scripted "average trader" bots. It reports price bands, stockouts and route profitability, so the tree is tuned by measurement, not guesswork.

## Balance levers

| Lever | Effect |
|---|---|
| Spread `s` | Minimum margin a route needs. Raise it to punish short hops |
| θ (reversion) | How long price trends last. Lower θ means longer trends and more planning |
| σ per good | Risk and reward of each good |
| Bias range | How strong and stable the trade routes are (v1) |
| ε, r (v2) | How hard trades push prices, and how fast posts recover |
| Hold capacity | Scale of each trip |
| Route danger | Set in [WORLDGEN.md](WORLDGEN.md#pipeline). Risk premium on distant or dangerous posts |

## Tests

- `test/market.test.js`: over 100k simulated ticks, prices stay within the expected band, and there are no NaN, zero or infinite prices.
- `test/market.test.js` also checks subsets (4–6 goods, every good at ≥ 2 posts), bias range, determinism and a JSON round trip of the state mid-run, the half-life of a displaced price, and net-worth values.
- `test/trade.test.js`: validation (out of zone, not enough money, hold full, good not traded here), `maxQty`, and a server-side trade that's refused once the player walks out of the zone. In v2: unit-by-unit pricing and stock floors.

## Status

| Milestone | Scope | State |
|---|---|---|
| M4 | goods catalog, per-post subsets and bias, v1 random walk, spread, trade validation, net-worth leaderboard | **done** 2026-09-30 (`server/market.js`, `shared/trade.js`) |
| M6 | v2 stock, scarcity pricing, slippage, drift | not started |
| M7 | v3 industries, population, econ-sim tool | not started |

## Open questions

- **NPC traders:** should simulated traders move goods when few players are online, so the v2/v3 economy stays alive?
- **Events:** should there be Taipan-style market events ("Ore shortage at Rustmouth!", price spikes, embargoes), and how would players hear about them if they can only see prices where they stand?
- **Money sinks:** hold upgrades, fees at each post, or a respawn cost. Which of these, once persistence makes inflation matter?
- **Contracts:** "deliver 10 metal to Skyhold within 3 min" as a guided goal for new players?
- **Price information:** should players be able to buy remote price boards or a scouting item ([DESIGN.md](DESIGN.md#information-is-part-of-the-game))?
