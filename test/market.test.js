import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOODS, GOOD_BY_ID } from '../shared/goods.js';
import { THETA, cargoValues, createMarket, netWorth, pricesFor, quote, stationarySd, tickMarket } from '../server/market.js';

const posts = Array.from({ length: 10 }, (_, id) => ({ id }));

test('each post trades 4–6 goods, and every good is traded at ≥ 2 posts', () => {
  for (let seed = 0; seed < 200; seed++) {
    const m = createMarket(seed, posts);
    const count = Object.fromEntries(GOODS.map((g) => [g.id, 0]));
    for (const p of Object.values(m.posts)) {
      const ids = Object.keys(p.goods);
      // Topping up a rare good may push a post one past the usual 6.
      assert.ok(ids.length >= 4 && ids.length <= 7, `seed ${seed}: ${ids.length} goods`);
      for (const id of ids) count[id]++;
    }
    for (const [id, n] of Object.entries(count)) assert.ok(n >= 2, `seed ${seed}: ${id} at ${n} posts`);
  }
});

test('biases stay in the documented range', () => {
  const m = createMarket(7, posts);
  for (const p of Object.values(m.posts)) {
    for (const { bias } of Object.values(p.goods)) assert.ok(bias >= Math.exp(-0.5) && bias <= Math.exp(0.5));
  }
});

test('same seed, same market; the state is plain JSON', () => {
  const a = createMarket(42, posts);
  const b = createMarket(42, posts);
  for (let i = 0; i < 50; i++) { tickMarket(a); tickMarket(b); }
  assert.deepEqual(a, b);
  assert.equal(a.version, 1);
  assert.equal(a.tick, 50);
  // Persist and restore mid-run: the walk continues identically.
  const c = JSON.parse(JSON.stringify(a));
  tickMarket(a); tickMarket(c);
  assert.deepEqual(a, c);
});

test('prices stay bounded over 100k market ticks', () => {
  const m = createMarket(3, posts);
  const devs = [];
  for (let i = 0; i < 100_000; i++) {
    tickMarket(m);
    if (i % 10 !== 0) continue;
    for (const [pid, p] of Object.entries(m.posts)) {
      for (const [gid, e] of Object.entries(p.goods)) {
        const g = GOOD_BY_ID[gid];
        const dev = (e.x - Math.log(g.base * e.bias)) / stationarySd(g.sigma);
        assert.ok(Number.isFinite(e.x), `${pid}/${gid} not finite`);
        assert.ok(Math.abs(dev) < 6, `${pid}/${gid} ${dev.toFixed(1)} sd from its mean`);
        devs.push(dev);
      }
      for (const { sell, buy } of Object.values(quote(m, pid))) {
        assert.ok(Number.isInteger(sell) && Number.isInteger(buy) && buy >= 1 && sell > buy);
      }
    }
  }
  // The walk's spread matches σ/√(2θ−θ²).
  const sd = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / devs.length);
  assert.ok(sd > 0.85 && sd < 1.15, `normalised sd ${sd.toFixed(2)}`);
});

test('mean reversion pulls a displaced price back with half-life ln2/θ', () => {
  const m = createMarket(1, [{ id: 0 }]);
  const [gid, e] = Object.entries(m.posts[0].goods)[0];
  const mu = Math.log(GOOD_BY_ID[gid].base * e.bias);
  const halfLife = Math.round(Math.log(2) / THETA);
  // Average over many runs to beat the noise.
  let left = 0;
  const runs = 400;
  for (let r = 0; r < runs; r++) {
    m.posts[0].goods[gid].x = mu + 1;
    for (let i = 0; i < halfLife; i++) tickMarket(m);
    left += m.posts[0].goods[gid].x - mu;
  }
  assert.ok(Math.abs(left / runs - 0.5) < 0.1, `deviation left ${(left / runs).toFixed(2)}`);
});

test('pricesFor: whole numbers, minimum 1, post sells above what it pays', () => {
  assert.deepEqual(pricesFor(100, 0.08), { sell: 104, buy: 96 });
  assert.deepEqual(pricesFor(0.01, 0.08), { sell: 2, buy: 1 });
  assert.deepEqual(pricesFor(8, 0.08), { sell: 9, buy: 8 });
});

test('net worth values cargo at the mean buy price across posts', () => {
  const m = createMarket(9, posts);
  const values = cargoValues(m);
  const buys = Object.keys(m.posts).map((id) => quote(m, id).ore?.buy).filter((b) => b !== undefined);
  const mean = buys.reduce((a, b) => a + b, 0) / buys.length;
  assert.equal(values.ore, mean);
  assert.equal(netWorth({ money: 100, cargo: { ore: 3 }, hold: 20 }, values), Math.round(100 + 3 * mean));
});
