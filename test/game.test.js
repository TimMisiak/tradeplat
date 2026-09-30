import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGame, TICK_RATE } from '../server/game.js';

test('tick loop runs at roughly TICK_RATE', async () => {
  const game = createGame();
  const seen = [];
  game.onTick.push((t) => seen.push(t));
  game.start();
  await sleep(500);
  game.stop();
  const expected = TICK_RATE / 2;
  // Loose bounds: this only catches a broken loop, not scheduler jitter.
  assert.ok(game.tick > expected * 0.6 && game.tick < expected * 1.4, `ticks: ${game.tick}`);
  assert.deepEqual(seen, seen.map((_, i) => i + 1), 'ticks are consecutive');
});
