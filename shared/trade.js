// Trade rules shared by client and server. See ECONOMY.md § Trade validation and
// DESIGN.md § Cargo, money and death. The server is authoritative: it runs
// checkTrade() on its own state before applying a trade. The client runs the same
// check only to grey out actions and size "max" orders, never to change money or cargo.
import { GOOD_BY_ID } from './goods.js';
import { TILE_SIZE } from './tiles.js';
import { TUNING } from './physics.js';

/** Hold capacity in units of goods (DESIGN.md § Cargo). Per player, so upgrades can raise it later. */
export const HOLD_CAPACITY = 20;
/** Money a new player starts with (ECONOMY.md § Goods catalog). */
export const START_MONEY = 500;
/** Largest quantity one trade request may carry. Anything bigger is malformed. */
export const MAX_TRADE_QTY = 1000;

export const SIDE = Object.freeze({ BUY: 'buy', SELL: 'sell' });

/**
 * A player's money and cargo. Plain data (persistence-ready).
 * @typedef {{money: number, cargo: Record<string, number>, paid: Record<string, number>, hold: number}} Wallet
 * cargo maps goodId → units carried; goods with 0 units are left out. paid maps
 * goodId → average unit price paid for the units carried (same keys as cargo).
 */

/** @returns {Wallet} */
export function createWallet() {
  return { money: START_MONEY, cargo: {}, paid: {}, hold: HOLD_CAPACITY };
}

/** Hold space in use. Every unit of every good takes one slot. */
export function holdUsed(cargo) {
  let used = 0;
  for (const n of Object.values(cargo)) used += n;
  return used;
}

/**
 * The post whose zone the player is standing in, or null. The zone is a tile
 * rect (WORLDGEN.md § Pipeline); the player is in it when the tile under its
 * centre column and its feet row is inside.
 * @param {import('./worldgen.js').Post[]} posts
 * @param {{x: number, y: number}} p hitbox top-left
 */
export function postAt(posts, p, tuning = TUNING) {
  const tx = Math.floor((p.x + tuning.width / 2) / TILE_SIZE);
  const ty = Math.floor((p.y + tuning.height - 1) / TILE_SIZE);
  for (const post of posts) {
    const z = post.zone;
    if (tx >= z.x0 && tx <= z.x1 && ty >= z.y0 && ty <= z.y1) return post;
  }
  return null;
}

/**
 * Most units of a good the wallet can buy at `price` (money and hold space), or sell.
 * @param {Wallet} w
 */
export function maxQty(w, goodId, side, price) {
  if (!GOOD_BY_ID[goodId]) return 0;
  if (side === SIDE.SELL) return w.cargo[goodId] ?? 0;
  if (!(price > 0)) return 0;
  return Math.max(0, Math.min(Math.floor(w.money / price), w.hold - holdUsed(w.cargo)));
}

/**
 * Validate a trade against a wallet and a post's current quote. Returns a reason
 * string if it's refused, or null if it's allowed.
 * @param {Wallet} w
 * @param {{goodId: string, qty: number, side: string}} order
 * @param {Record<string, {sell: number, buy: number}> | null} quote the post's prices
 *   (sell = what the post charges, buy = what it pays), or null if not at a post
 */
export function checkTrade(w, order, quote) {
  const { goodId, qty, side } = order;
  if (!GOOD_BY_ID[goodId]) return 'unknown good';
  if (side !== SIDE.BUY && side !== SIDE.SELL) return 'bad side';
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_TRADE_QTY) return 'bad quantity';
  if (!quote) return 'not at this post';
  const q = quote[goodId];
  if (!q) return 'not traded here';
  if (side === SIDE.BUY) {
    if (q.sell * qty > w.money) return 'not enough money';
    if (holdUsed(w.cargo) + qty > w.hold) return 'hold full';
  } else if ((w.cargo[goodId] ?? 0) < qty) {
    return 'not enough cargo';
  }
  return null;
}

/**
 * Apply an allowed trade (checkTrade returned null) and return the new wallet and
 * the unit price used. Pure: the input wallet isn't modified. Buying folds the
 * price into the good's average paid, weighted by units; selling leaves it alone.
 * @param {Wallet} w
 * @returns {{wallet: Wallet, price: number}}
 */
export function applyTrade(w, { goodId, qty, side }, quote) {
  const q = quote[goodId];
  const price = side === SIDE.BUY ? q.sell : q.buy;
  const cargo = { ...w.cargo };
  const paid = { ...w.paid };
  const had = cargo[goodId] ?? 0;
  const n = had + (side === SIDE.BUY ? qty : -qty);
  if (side === SIDE.BUY) paid[goodId] = ((paid[goodId] ?? 0) * had + price * qty) / n;
  if (n > 0) cargo[goodId] = n;
  else { delete cargo[goodId]; delete paid[goodId]; }
  const money = w.money + (side === SIDE.BUY ? -price * qty : price * qty);
  return { wallet: { ...w, money, cargo, paid }, price };
}
