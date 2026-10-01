// HUD and leaderboard: money, hold, the post you're at, and net-worth ranking.
// Immediate-mode layout in virtual px (ARCHITECTURE.md § UI). No DOM.
import { holdUsed } from '../../shared/trade.js';
import { textWidth } from './text.js';

const BOARD_ROWS = 5;

/**
 * @param {import('./text.js').UiBatch} ui
 * @param {{wallet: import('../../shared/trade.js').Wallet | null, post: {name: string} | null, postColor: number[] | null,
 *   netColor: number[], board: [number, string, number][], playerId: number, menuOpen: boolean,
 *   colors: Record<string, number[]>}} ctx
 */
export function drawHud(ui, ctx) {
  const c = ctx.colors;
  const w = ctx.wallet;

  // Top-left: connection dot, money, hold, post
  const lines = w ? 2 : 1;
  ui.rect(4, 4, 104, 6 + lines * 12 + (ctx.post ? 12 : 0), c.panelSoft);
  ui.rect(8, 9, 3, 3, ctx.netColor);
  if (w) {
    ui.text(16, 6, `$ ${w.money}`, c.money, c.shadow);
    const used = holdUsed(w.cargo);
    ui.text(16, 18, `Hold ${used}/${w.hold}`, used >= w.hold ? c.bad : c.text, c.shadow);
  } else {
    ui.text(16, 6, 'offline', c.dim, c.shadow);
  }
  if (ctx.post) ui.text(8, 6 + lines * 12, ctx.post.name, ctx.postColor, c.shadow);

  // Top-right: leaderboard
  const rows = ctx.board;
  if (rows.length) {
    const width = 132;
    const x0 = 640 - 4 - width;
    const mine = rows.findIndex(([id]) => id === ctx.playerId);
    const shown = rows.slice(0, BOARD_ROWS).map((r, i) => [i, r]);
    if (mine >= BOARD_ROWS) shown.push([mine, rows[mine]]);
    ui.rect(x0, 4, width, 18 + shown.length * 12, c.panelSoft);
    ui.text(x0 + 4, 6, 'Net worth', c.dim, c.shadow);
    shown.forEach(([rank, [id, name, worth]], i) => {
      const y = 18 + i * 12;
      const color = id === ctx.playerId ? c.accent : c.text;
      ui.text(x0 + 4, y, `${rank + 1}.`.padEnd(3), c.dim, c.shadow);
      ui.text(x0 + 4 + textWidth('00 '), y, name.slice(0, 10), color, c.shadow);
      ui.textRight(x0 + width - 4, y, String(worth), c.money, c.shadow);
    });
  }

  // Bottom centre: how to trade, when standing at a post
  if (ctx.post && !ctx.menuOpen) {
    const msg = `E  trade at ${ctx.post.name}`;
    const tw = textWidth(msg);
    ui.rect(320 - tw / 2 - 6, 330, tw + 12, 16, c.panelSoft);
    ui.textCenter(320, 333, msg, c.text, c.shadow);
  }
}
