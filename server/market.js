// v1 market: per-post goods subsets, local biases, and a mean-reverting random walk
// in log price. See ECONOMY.md § v1 random-walk prices. Server-only: prices are
// sent to clients, never recomputed by them, so Math.exp/log/cos are fine here.
// The state is plain data (ECONOMY.md § v1 market state), including the PRNG state.
import { GOODS, GOOD_BY_ID } from '../shared/goods.js';
import { TICK_RATE } from '../shared/physics.js';
import { createRng, hashString } from '../shared/rng.js';

/** Server ticks per market tick (10 s). */
export const MARKET_TICKS = 10 * TICK_RATE;
/** Mean reversion per market tick (a deviation halves in ln2/θ ≈ 14 ticks). */
export const THETA = 0.05;
/** Bid/ask spread around the mid price. */
export const SPREAD = 0.08;
/** Goods each post trades. */
const MIN_GOODS = 4;
const MAX_GOODS = 6;
/** Every good is traded at no fewer posts than this. */
const MIN_POSTS_PER_GOOD = 2;
/** |ln b| range of a (post, good) bias. */
const BIAS_LOG = 0.5;

/**
 * @typedef {{
 *   version: 1, tick: number, rng: number[],
 *   posts: Record<number, {spread: number, goods: Record<string, {bias: number, x: number}>}>,
 * }} Market
 * x is ln(mid). bias is the multiplicative local bias b (so μ = ln(base·b)).
 *
 * @typedef {Record<string, {sell: number, buy: number}>} Quote
 * sell: what the post charges; buy: what the post pays.
 */

/** Long-run standard deviation of x for a good: σ/√(2θ−θ²). */
export function stationarySd(sigma, theta = THETA) {
  return sigma / Math.sqrt(2 * theta - theta * theta);
}

/**
 * Build a market for a world's posts. Deterministic for a given (seed, post count).
 * @param {number} seed
 * @param {{id: number}[]} posts
 * @returns {Market}
 */
export function createMarket(seed, posts) {
  const rng = createRng(hashString('market', seed >>> 0));
  const ids = posts.map((p) => p.id);

  // Subsets: 4–6 goods per post, then top up any good traded at too few posts by
  // adding it to the posts that have room (or, if none do, any post that lacks it).
  const sets = new Map(ids.map((id) => [id, new Set(rng.shuffle(GOODS.map((g) => g.id)).slice(0, rng.int(MIN_GOODS, MAX_GOODS)))]));
  for (const g of GOODS) {
    const have = () => ids.filter((id) => sets.get(id).has(g.id)).length;
    const room = rng.shuffle(ids.filter((id) => !sets.get(id).has(g.id)))
      .sort((a, b) => (sets.get(a).size >= MAX_GOODS) - (sets.get(b).size >= MAX_GOODS));
    while (have() < Math.min(MIN_POSTS_PER_GOOD, ids.length) && room.length) sets.get(room.shift()).add(g.id);
  }

  const market = { version: 1, tick: 0, rng: [], posts: {} };
  for (const id of ids) {
    const goods = {};
    // Catalog order, so the menu lists goods the same way at every post.
    for (const g of GOODS) {
      if (!sets.get(id).has(g.id)) continue;
      const bias = Math.exp(rng.range(-BIAS_LOG, BIAS_LOG));
      // Start somewhere in the long-run spread, so the market isn't flat at boot.
      const x = Math.log(g.base * bias) + normal(rng) * stationarySd(g.sigma);
      goods[g.id] = { bias, x };
    }
    market.posts[id] = { spread: SPREAD, goods };
  }
  market.rng = rng.state();
  return market;
}

/** Standard normal sample (Box–Muller) from the market's PRNG. */
function normal(rng) {
  const u = 1 - rng.float(); // (0, 1], so the log is finite
  const v = rng.float();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * One market tick: every (post, good) price takes a mean-reverting step in log
 * space. Mutates and returns the market.
 * @param {Market} m
 */
export function tickMarket(m, theta = THETA) {
  const rng = createRng(0, m.rng);
  for (const post of Object.values(m.posts)) {
    for (const [id, e] of Object.entries(post.goods)) {
      const g = GOOD_BY_ID[id];
      const mu = Math.log(g.base * e.bias);
      e.x += theta * (mu - e.x) + g.sigma * normal(rng);
    }
  }
  m.rng = rng.state();
  m.tick++;
  return m;
}

/** Whole-number prices with a minimum of 1. The post always sells above what it pays. */
export function pricesFor(mid, spread) {
  const buy = Math.max(1, Math.round(mid * (1 - spread / 2)));
  const sell = Math.max(buy + 1, Math.round(mid * (1 + spread / 2)));
  return { sell, buy };
}

/**
 * A post's current prices, or null if it isn't a post.
 * @param {Market} m
 * @returns {Quote | null}
 */
export function quote(m, postId) {
  const post = m.posts[postId];
  if (!post) return null;
  const q = {};
  for (const [id, e] of Object.entries(post.goods)) q[id] = pricesFor(Math.exp(e.x), post.spread);
  return q;
}

/** Quote → wire form [[goodId, sell, buy], …] in catalog order. */
export function packQuote(q) {
  return Object.entries(q).map(([id, { sell, buy }]) => [id, sell, buy]);
}

/**
 * Per-good unit value for net worth: the mean of what posts pay (buy price) across
 * the posts that trade it (ECONOMY.md § Net worth).
 * @param {Market} m
 * @returns {Record<string, number>}
 */
export function cargoValues(m) {
  const sum = {};
  const n = {};
  for (const id of Object.keys(m.posts)) {
    for (const [g, { buy }] of Object.entries(quote(m, id))) {
      sum[g] = (sum[g] ?? 0) + buy;
      n[g] = (n[g] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.keys(sum).map((g) => [g, sum[g] / n[g]]));
}

/** Money plus cargo at `values` (from cargoValues), rounded to a whole number. */
export function netWorth(wallet, values) {
  let worth = wallet.money;
  for (const [g, qty] of Object.entries(wallet.cargo)) worth += (values[g] ?? 0) * qty;
  return Math.round(worth);
}
