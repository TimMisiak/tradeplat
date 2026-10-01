import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPriceBook, createTradeMenu, formatAge, menuKey, menuResult, menuRows, openMenu } from '../client/ui/trade.js';

const goods = [['ore', 22, 18], ['food', 31, 28], ['relics', 610, 560]];

function setup(wallet = { money: 500, cargo: { food: 2 }, paid: { food: 29 }, hold: 20 }) {
  const menu = createTradeMenu();
  const sent = [];
  const ctx = { goods, wallet, now: 0, send: (o) => { sent.push(o); return sent.length; } };
  openMenu(menu, 4);
  return { menu, sent, ctx };
}

test('arrows move the selection and quantity, wrapping', () => {
  const { menu, ctx } = setup();
  menuKey(menu, 'ArrowUp', ctx);
  assert.equal(menu.sel, 2);
  menuKey(menu, 'ArrowDown', ctx);
  assert.equal(menu.sel, 0);
  menuKey(menu, 'ArrowLeft', ctx);
  assert.equal(menu.qty, 2);
  menuKey(menu, 'Digit2', ctx);
  assert.equal(menu.qty, 1);
  assert.equal(menuKey(menu, 'KeyP', ctx), false);
  menuKey(menu, 'Escape', ctx);
  assert.equal(menu.open, false);
});

test('buy ×5 sends an order clamped to what the hold allows', () => {
  const { menu, sent, ctx } = setup({ money: 500, cargo: { food: 17 }, paid: { food: 29 }, hold: 20 });
  menu.qty = 1; // ×5
  menuKey(menu, 'KeyZ', ctx);
  // 17 food use 17 of 20, so only 3 more fit.
  assert.deepEqual(sent, [{ postId: 4, goodId: 'ore', qty: 3, side: 'buy' }]);
  assert.equal(menu.pending, 1);
  // A second press waits for the answer.
  menuKey(menu, 'KeyZ', ctx);
  assert.equal(sent.length, 1);
  menuResult(menu, { reqId: 1, ok: true, price: 22 });
  assert.equal(menu.pending, 0);
  assert.equal(menu.status.text, 'Bought 3 Ore for 66');
});

test('max sells everything carried; impossible orders are explained without a request', () => {
  const { menu, sent, ctx } = setup();
  menu.sel = 1;
  menu.qty = 2;
  menuKey(menu, 'KeyX', ctx);
  assert.deepEqual(sent, [{ postId: 4, goodId: 'food', qty: 2, side: 'sell' }]);
  menuResult(menu, { reqId: 1, ok: false, reason: 'not at this post' });
  assert.equal(menu.status.text, 'Refused: not at this post');
  menu.sel = 2;
  menuKey(menu, 'KeyZ', ctx);
  assert.equal(sent.length, 1);
  assert.equal(menu.status.text, "Can't buy: not enough money");
});

test('carried goods the post does not trade are listed after its goods, and can\'t be traded', () => {
  const wallet = { money: 500, cargo: { relics: 1, water: 3, ore: 2 }, paid: { relics: 600, water: 8, ore: 20 }, hold: 20 };
  assert.deepEqual(menuRows(goods, wallet), [...goods, ['water', null, null]]);
  assert.deepEqual(menuRows(null, wallet), [], 'no rows before prices arrive');
  const { menu, sent, ctx } = setup(wallet);
  menuKey(menu, 'ArrowUp', ctx);
  assert.equal(menu.sel, 3);
  menuKey(menu, 'KeyX', ctx);
  assert.equal(sent.length, 0);
  assert.equal(menu.status.text, "Can't sell: not traded here");
});

test('price book: best remembered price elsewhere first', () => {
  const book = createPriceBook();
  book.add({ postId: 1, tick: 0, goods: [['ore', 30, 26]] }, 1000);
  book.add({ postId: 2, tick: 0, goods: [['ore', 40, 35], ['food', 9, 8]] }, 2000);
  book.add({ postId: 3, tick: 0, goods: [['ore', 20, 17]] }, 3000);
  assert.deepEqual(book.elsewhere('ore', 3).map((e) => [e.postId, e.buy]), [[2, 35], [1, 26]]);
  assert.deepEqual(book.elsewhere('water', 3), []);
});

test('formatAge', () => {
  assert.deepEqual([500, 12_000, 185_000, 7_300_000].map(formatAge), ['now', '12s', '3m', '2h']);
});
