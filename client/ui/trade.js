// Trade menu: state, keyboard handling and layout, plus the client's memory of
// prices seen at each post. See DESIGN.md § Trade posts and § Information is part
// of the game. Nothing here changes money or cargo: orders go to the server, and the
// wallet shown is always the server's. No DOM, so Node tests drive it directly.
import { GOOD_BY_ID } from '../../shared/goods.js';
import { SIDE, checkTrade, holdUsed, maxQty } from '../../shared/trade.js';
import { textWidth } from './text.js';

/** Quantity choices, cycled with ←/→. 0 = as many as possible. */
export const QTYS = Object.freeze([1, 5, 0]);
const qtyLabel = (q) => (q === 0 ? 'max' : `×${q}`);
/** A trade with no answer after this long is given up on (the server answers every request). */
const PENDING_TIMEOUT_MS = 3000;

/**
 * Prices seen at each post, with when they were seen. Nothing is shown at a
 * distance unless we were there (DESIGN.md § Information is part of the game).
 */
export function createPriceBook() {
  /** @type {Map<number, {goods: [string, number, number][], at: number, tick: number}>} */
  const seen = new Map();
  return {
    seen,
    /** @param {{postId: number, tick: number, goods: [string, number, number][]}} msg */
    add(msg, now) { seen.set(msg.postId, { goods: msg.goods, at: now, tick: msg.tick }); },
    get: (postId) => seen.get(postId) ?? null,
    clear: () => seen.clear(),
    /**
     * Where else we've seen a good, best price for selling first (what the post pays).
     * @returns {{postId: number, sell: number, buy: number, at: number}[]}
     */
    elsewhere(goodId, exceptPostId) {
      const out = [];
      for (const [postId, e] of seen) {
        if (postId === exceptPostId) continue;
        const g = e.goods.find(([id]) => id === goodId);
        if (g) out.push({ postId, sell: g[1], buy: g[2], at: e.at });
      }
      return out.sort((a, b) => b.buy - a.buy || b.at - a.at);
    },
  };
}

/** Wire goods list → {goodId: {sell, buy}} for checkTrade. */
export function quoteOf(goods) {
  return Object.fromEntries(goods.map(([id, sell, buy]) => [id, { sell, buy }]));
}

/** "now", "12s", "3m", "2h" */
export function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 2) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function createTradeMenu() {
  return {
    open: false,
    postId: -1,
    /** Selected row (index into the post's goods). */
    sel: 0,
    /** Index into QTYS. */
    qty: 0,
    /** reqId of the trade waiting for an answer (0: none), when it was sent, and what it was. */
    pending: 0,
    pendingAt: 0,
    /** @type {{goodId: string, qty: number, side: string} | null} */
    order: null,
    /** Last result line: {text, ok}. */
    status: null,
  };
}

/** Units a side would trade for the selected quantity, clamped to what's possible. */
export function orderQty(menu, wallet, goodId, side, price) {
  const max = maxQty(wallet, goodId, side, price);
  const want = QTYS[menu.qty];
  return want === 0 ? max : Math.min(want, max);
}

/**
 * Open the menu at a post.
 * @param {ReturnType<typeof createTradeMenu>} menu
 */
export function openMenu(menu, postId) {
  if (menu.postId !== postId) { menu.sel = 0; menu.status = null; }
  menu.open = true;
  menu.postId = postId;
}

export function closeMenu(menu) {
  menu.open = false;
}

/**
 * One key press while the menu is open (KeyboardEvent.code). Returns true if the
 * key was used.
 * @param {ReturnType<typeof createTradeMenu>} menu
 * @param {string} code
 * @param {{goods: [string, number, number][] | null, wallet: import('../../shared/trade.js').Wallet | null,
 *   send: (order: {postId: number, goodId: string, qty: number, side: string}) => number, now: number}} ctx
 */
export function menuKey(menu, code, ctx) {
  const n = ctx.goods?.length ?? 0;
  switch (code) {
    case 'Escape': case 'KeyE': case 'Enter': case 'KeyQ':
      closeMenu(menu);
      return true;
    case 'ArrowUp': case 'KeyW':
      if (n) menu.sel = (menu.sel + n - 1) % n;
      return true;
    case 'ArrowDown': case 'KeyS':
      if (n) menu.sel = (menu.sel + 1) % n;
      return true;
    case 'ArrowLeft': case 'KeyA':
      menu.qty = (menu.qty + QTYS.length - 1) % QTYS.length;
      return true;
    case 'ArrowRight': case 'KeyD':
      menu.qty = (menu.qty + 1) % QTYS.length;
      return true;
    case 'Digit1': case 'Digit2': case 'Digit3':
      menu.qty = Number(code.slice(5)) - 1;
      return true;
    case 'KeyZ': case 'KeyB':
      return order(menu, SIDE.BUY, ctx);
    case 'KeyX': case 'KeyV':
      return order(menu, SIDE.SELL, ctx);
  }
  return false;
}

function order(menu, side, ctx) {
  if (menu.pending && ctx.now - menu.pendingAt < PENDING_TIMEOUT_MS) return true;
  menu.pending = 0;
  const row = ctx.goods?.[menu.sel];
  if (!row || !ctx.wallet) return true;
  const [goodId, sell, buy] = row;
  const qty = orderQty(menu, ctx.wallet, goodId, side, side === SIDE.BUY ? sell : buy);
  // Refusals we can see coming are explained here, without a round trip.
  const reason = checkTrade(ctx.wallet, { goodId, qty: Math.max(1, qty), side }, quoteOf(ctx.goods));
  if (reason) {
    menu.status = { text: `Can't ${side}: ${reason}`, ok: false };
    return true;
  }
  const reqId = ctx.send({ postId: menu.postId, goodId, qty, side });
  if (!reqId) {
    menu.status = { text: 'Not connected', ok: false };
    return true;
  }
  menu.pending = reqId;
  menu.pendingAt = ctx.now;
  menu.order = { goodId, qty, side };
  menu.status = { text: `${side === SIDE.BUY ? 'Buying' : 'Selling'} ${qty} ${GOOD_BY_ID[goodId].name}…`, ok: true };
  return true;
}

/**
 * Apply a tradeResult to the menu's status line.
 * @param {{reqId: number, ok: boolean, reason?: string, price?: number}} msg
 */
export function menuResult(menu, msg) {
  if (msg.reqId !== menu.pending || !menu.order) return;
  menu.pending = 0;
  if (!msg.ok) {
    menu.status = { text: `Refused: ${msg.reason}`, ok: false };
    return;
  }
  const { side, qty, goodId } = menu.order;
  menu.status = { text: `${side === SIDE.BUY ? 'Bought' : 'Sold'} ${qty} ${GOOD_BY_ID[goodId].name} for ${msg.price * qty}`, ok: true };
}

// Layout (virtual px). Panel centred horizontally, near the top. It covers the
// player, who stands still while the menu is open.
const PW = 344;
const PX = Math.round((640 - PW) / 2);
const PY = 40;
const ROW = 16;
const COL = { icon: 8, name: 30, size: 136, buy: 190, sell: 240, have: 290 };

/**
 * Draw the open menu.
 * @param {import('./text.js').UiBatch} ui
 * @param {ReturnType<typeof createTradeMenu>} menu
 * @param {{post: {id: number, name: string}, postColor: number[], prices: {goods: [string, number, number][], at: number} | null,
 *   live: boolean, offline: boolean, wallet: import('../../shared/trade.js').Wallet | null,
 *   book: ReturnType<typeof createPriceBook>, postName: (id: number) => string, now: number,
 *   colors: Record<string, number[]>, iconColor: (goodId: string) => number[]}} ctx
 */
export function drawTradeMenu(ui, menu, ctx) {
  const { colors: c, wallet } = ctx;
  const goods = ctx.prices?.goods ?? [];
  const rowsH = Math.max(1, goods.length) * ROW;
  const h = 34 + rowsH + 8 * ROW + 10;
  const y0 = PY;
  ui.rect(PX - 1, y0 - 1, PW + 2, h + 2, ctx.postColor);
  ui.rect(PX, y0, PW, h, c.panel);

  // Header: post name, price age
  let y = y0 + 4;
  ui.text(PX + 8, y, ctx.post.name, ctx.postColor);
  const age = ctx.offline ? 'offline' : !ctx.prices ? 'waiting for prices…'
    : ctx.live ? 'prices live' : `prices ${formatAge(ctx.now - ctx.prices.at)} old`;
  ui.textRight(PX + PW - 8, y, age, c.dim);
  y += ROW + 2;

  ui.text(PX + COL.name, y, 'Good', c.dim);
  ui.textRight(PX + COL.size, y, 'Size', c.dim);
  ui.textRight(PX + COL.buy, y, 'Buy', c.dim);
  ui.textRight(PX + COL.sell, y, 'Sell', c.dim);
  ui.textRight(PX + COL.have + 30, y, 'Have', c.dim);
  y += ROW;

  if (!goods.length) {
    ui.text(PX + COL.name, y, ctx.offline ? 'Dev worlds have no market.' : 'Waiting for the post\'s prices…', c.dim);
  }
  goods.forEach(([id, sell, buy], i) => {
    const ry = y + i * ROW;
    const selected = i === menu.sel;
    if (selected) ui.rect(PX + 2, ry - 3, PW - 4, ROW, c.selRow);
    if (selected) ui.text(PX + 2, ry, '▶', c.accent);
    ui.icon(PX + COL.icon + 2, ry - 3, id, 16, ctx.iconColor(id));
    const g = GOOD_BY_ID[id];
    ui.text(PX + COL.name, ry, g?.name ?? id, c.text);
    ui.textRight(PX + COL.size, ry, String(g?.size ?? '?'), c.dim);
    const canBuy = wallet && maxQty(wallet, id, SIDE.BUY, sell) > 0;
    ui.textRight(PX + COL.buy, ry, String(sell), canBuy ? c.money : c.dim);
    ui.textRight(PX + COL.sell, ry, String(buy), c.money);
    const have = wallet?.cargo[id] ?? 0;
    ui.textRight(PX + COL.have + 30, ry, have ? String(have) : '-', have ? c.text : c.dim);
  });
  y += rowsH + 4;

  // Quantity selector
  let x = ui.text(PX + 8, y, 'Qty ', c.dim);
  QTYS.forEach((q, i) => {
    const label = qtyLabel(q);
    if (i === menu.qty) ui.rect(x - 2, y - 2, textWidth(label) + 4, ROW, c.selRow);
    x = ui.text(x, y, label, i === menu.qty ? c.accent : c.dim) + 8;
  });
  if (wallet) ui.textRight(PX + PW - 8, y, `Hold ${holdUsed(wallet.cargo)}/${wallet.hold}`, c.text);
  y += ROW;

  // What Z / X would do right now
  const row = goods[menu.sel];
  if (row && wallet) {
    const [id, sell, buy] = row;
    const nb = orderQty(menu, wallet, id, SIDE.BUY, sell);
    const ns = orderQty(menu, wallet, id, SIDE.SELL, buy);
    x = ui.text(PX + 8, y, 'Z buy ', nb ? c.text : c.dim);
    x = ui.text(x, y, nb ? `${nb} for ${nb * sell}` : '-', nb ? c.money : c.dim);
    x = ui.text(x + 18, y, 'X sell ', ns ? c.text : c.dim);
    ui.text(x, y, ns ? `${ns} for ${ns * buy}` : '-', ns ? c.money : c.dim);
  }
  y += ROW;

  // Remembered prices elsewhere for the selected good
  if (row) {
    const seen = ctx.book.elsewhere(row[0], menu.postId).slice(0, 3);
    ui.text(PX + 8, y, seen.length ? `${GOOD_BY_ID[row[0]]?.name ?? row[0]} elsewhere (they pay):` : 'Not seen at other posts yet', c.dim);
    seen.forEach((s, i) => {
      const sy = y + (i + 1) * ROW;
      ui.text(PX + 20, sy, ctx.postName(s.postId), c.text);
      ui.textRight(PX + 180, sy, String(s.buy), c.money);
      ui.text(PX + 192, sy, `${formatAge(ctx.now - s.at)} ago`, c.dim);
    });
  }
  y += 4 * ROW;

  if (menu.status) ui.text(PX + 8, y, menu.status.text, menu.status.ok ? c.good : c.bad);
  y += ROW + 2;
  ui.text(PX + 8, y, 'Up/Down good  Left/Right qty  Z buy  X sell  Esc', c.dim);
  return h;
}
