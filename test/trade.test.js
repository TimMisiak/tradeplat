import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_CAPACITY, START_MONEY, applyTrade, checkTrade, createWallet, holdUsed, maxQty, postAt } from '../shared/trade.js';
import { TUNING, spawnAt } from '../shared/physics.js';
import { TILE_SIZE } from '../shared/tiles.js';
import { generateWorld } from '../shared/worldgen.js';
import { createGame } from '../server/game.js';
import { quote } from '../server/market.js';

const q = { ore: { sell: 22, buy: 18 }, relics: { sell: 610, buy: 560 }, food: { sell: 31, buy: 28 } };

test('a new wallet: 500 money, empty 20-unit hold', () => {
  assert.deepEqual(createWallet(), { money: START_MONEY, cargo: {}, paid: {}, hold: HOLD_CAPACITY });
});

test('checkTrade refusals', () => {
  const w = createWallet();
  const order = (o) => ({ goodId: 'ore', qty: 1, side: 'buy', ...o });
  assert.equal(checkTrade(w, order(), null), 'not at this post');
  assert.equal(checkTrade(w, order({ goodId: 'gold' }), q), 'unknown good');
  assert.equal(checkTrade(w, order({ goodId: 'water' }), q), 'not traded here');
  assert.equal(checkTrade(w, order({ side: 'steal' }), q), 'bad side');
  for (const qty of [0, -1, 1.5, '3', 1e6]) assert.equal(checkTrade(w, order({ qty }), q), 'bad quantity', String(qty));
  assert.equal(checkTrade(w, order({ goodId: 'relics' }), q), 'not enough money');
  // Every unit takes one slot: 20 fit in 20, a 21st doesn't.
  const rich = { ...w, money: 1e6 };
  assert.equal(checkTrade(rich, order({ qty: 20 }), q), null);
  assert.equal(checkTrade(rich, order({ qty: 21 }), q), 'hold full');
  assert.equal(checkTrade(w, order({ side: 'sell' }), q), 'not enough cargo');
});

test('buy then sell moves money and cargo at the quoted prices', () => {
  let w = createWallet();
  let r = applyTrade(w, { goodId: 'ore', qty: 5, side: 'buy' }, q);
  assert.equal(r.price, 22);
  assert.deepEqual(r.wallet.cargo, { ore: 5 });
  assert.equal(r.wallet.money, 500 - 110);
  assert.deepEqual(w.cargo, {}, 'input wallet untouched');
  w = r.wallet;
  assert.equal(holdUsed(w.cargo), 5);
  r = applyTrade(w, { goodId: 'ore', qty: 5, side: 'sell' }, q);
  assert.equal(r.price, 18);
  assert.deepEqual(r.wallet.cargo, {}, 'empty entries are dropped');
  assert.deepEqual(r.wallet.paid, {});
  assert.equal(r.wallet.money, 390 + 90);
});

test('average paid is weighted by units bought, and selling leaves it alone', () => {
  let w = createWallet();
  w = applyTrade(w, { goodId: 'ore', qty: 3, side: 'buy' }, q).wallet; // 3 @ 22
  assert.equal(w.paid.ore, 22);
  w = applyTrade(w, { goodId: 'ore', qty: 1, side: 'buy' }, { ore: { sell: 30, buy: 25 } }).wallet; // 1 @ 30
  assert.equal(w.paid.ore, (3 * 22 + 30) / 4);
  w = applyTrade(w, { goodId: 'ore', qty: 2, side: 'sell' }, q).wallet;
  assert.equal(w.paid.ore, 24);
  w = applyTrade(w, { goodId: 'ore', qty: 2, side: 'buy' }, { ore: { sell: 12, buy: 10 } }).wallet; // 2 @ 24 + 2 @ 12
  assert.equal(w.paid.ore, 18);
  w = applyTrade(w, { goodId: 'food', qty: 1, side: 'buy' }, q).wallet;
  assert.deepEqual(w.paid, { ore: 18, food: 31 });
});

test('maxQty is limited by money, hold space, or cargo', () => {
  const w = { money: 100, cargo: { food: 4 }, hold: 20 };
  assert.equal(maxQty(w, 'ore', 'buy', 22), 4); // money: 100/22
  assert.equal(maxQty({ ...w, money: 1e6 }, 'ore', 'buy', 22), 16); // hold: 16 free
  assert.equal(maxQty(w, 'food', 'sell', 28), 4);
  assert.equal(maxQty(w, 'ore', 'sell', 18), 0);
});

test('postAt: the spawn is inside the spawn post, and outside the room is not', () => {
  const world = generateWorld(12345);
  const post = world.posts[world.spawnPost];
  const s = spawnAt(post.spawn.tx, post.spawn.ty);
  assert.equal(postAt(world.posts, s)?.id, post.id);
  const door = post.doors[0];
  assert.equal(postAt(world.posts, spawnAt(door.tx, door.ty)), null);
  // Jumping above the room's ceiling isn't in the zone.
  assert.equal(postAt(world.posts, { x: s.x, y: (post.y - 2) * TILE_SIZE - TUNING.height }), null);
});

test('server trade: checked against the server position and the post', () => {
  const game = createGame({ seed: 12345 });
  const p = game.addPlayer('T');
  const here = game.world.spawnPost;
  const prices = quote(game.market, here);
  const goodId = Object.keys(prices)[0];
  assert.deepEqual(game.trade(p, { postId: here + 1, goodId, qty: 1, side: 'buy' }), { ok: false, reason: 'not at this post' });
  const r = game.trade(p, { postId: here, goodId, qty: 1, side: 'buy' });
  assert.deepEqual(r, { ok: true, price: prices[goodId].sell });
  assert.equal(p.wallet.money, START_MONEY - prices[goodId].sell);
  assert.equal(p.wallet.cargo[goodId], 1);
  // Walk out of the zone: trading is refused.
  const door = game.world.posts[here].doors[0];
  p.state = spawnAt(door.tx, door.ty);
  assert.equal(game.trade(p, { postId: here, goodId, qty: 1, side: 'sell' }).reason, 'not at this post');
  assert.equal(p.wallet.cargo[goodId], 1);
});
