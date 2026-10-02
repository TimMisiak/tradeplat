// Snapshot cost at N players: server CPU and bytes per client, JSON frames.
// Decides whether hot messages move to binary (ARCHITECTURE.md § Protocol).
// "binary est." is what a packed frame would take (f64 own x/y/vx/vy, u8/i8 flags
// and timers, u16 id + f32 x/y + u8 facing/anim per ghost), for comparison.
// Usage: npm run bench -- snapshot
import { performance } from 'node:perf_hooks';
import { createGame } from '../server/game.js';
import { snapshotFrames } from '../server/net.js';
import { INPUT, TICK_RATE, TUNING, step } from '../shared/physics.js';
import { stepPlayer } from '../shared/sim.js';
import { SNAPSHOT_EVERY } from '../shared/protocol.js';

const game = createGame({ seed: 1 });
const all = { has: () => true };
const SNAPS_PER_S = TICK_RATE / SNAPSHOT_EVERY;
const binaryEst = (ghosts) => 8 + 4 * 8 + 12 + ghosts * 11;

function run(n, layout) {
  for (const id of [...game.players.keys()]) game.removePlayer(id);
  for (let i = 0; i < n; i++) {
    const p = game.addPlayer(`p${i}`);
    // crowd: everyone near the spawn post. spread: evenly across the map width.
    if (layout === 'spread') p.state = { ...p.state, x: ((i + 0.5) / n) * game.world.w * 16, y: (game.world.h / 2) * 16 };
    else p.state = { ...p.state, x: p.state.x + (i % 20) * 8 };
    game.receiveInput(p, 1, [INPUT.RIGHT]);
  }
  const ROUNDS = 200;
  const t0 = performance.now();
  for (let r = 0; r < ROUNDS; r++) snapshotFrames(game, r, all);
  const ms = (performance.now() - t0) / ROUNDS;
  // Sizes from one untimed round (players don't move here, so every round is the same).
  const frames = snapshotFrames(game, 0, all);
  const perClient = frames.reduce((sum, [, f]) => sum + f.length, 0) / n;
  const g = frames.reduce((sum, [, f]) => sum + JSON.parse(f).g.length, 0) / n;
  console.log(`${String(n).padStart(3)} players, ${layout.padEnd(6)}: ${ms.toFixed(3)} ms/snapshot round ` +
    `(${(ms * SNAPS_PER_S / 10).toFixed(2)}% of one core), ${g.toFixed(0)} ghosts/client, ` +
    `${perClient.toFixed(0)} B/client/snap = ${(perClient * SNAPS_PER_S / 1024).toFixed(1)} KiB/s/client, ` +
    `binary est. ${(binaryEst(g) * SNAPS_PER_S / 1024).toFixed(1)} KiB/s/client`);
}

for (const n of [8, 32, 64, 128]) for (const layout of ['crowd', 'spread']) run(n, layout);

// Physics for context: the other per-tick server cost.
let p = game.spawn;
const STEPS = 200000;
const t0 = performance.now();
for (let i = 0; i < STEPS; i++) p = step(p, i & 32 ? INPUT.RIGHT : INPUT.LEFT | INPUT.JUMP, game.world);
const us = (performance.now() - t0) * 1000 / STEPS;
console.log(`physics: ${us.toFixed(2)} µs/step (64 players at 60 Hz: ${(us * 64 * 60 / 1e4).toFixed(2)}% of one core)`);

// The full per-tick player step (shared/sim.js): physics plus spikes and enemies,
// next to the spawner with the most neighbours (the worst case for enemy checks).
const sps = game.world.spawners;
const busiest = sps.reduce((best, sp) => {
  const n = sps.filter((o) => Math.abs(o.x - sp.x) < 16 && Math.abs(o.y - sp.y) < 16).length;
  return n > best.n ? { sp, n } : best;
}, { sp: sps[0], n: 0 });
const home = { ...game.spawn, x: busiest.sp.x * 16, y: busiest.sp.y * 16 - TUNING.height };
let q = home;
const t1 = performance.now();
for (let i = 0; i < STEPS; i++) {
  q = stepPlayer(q, i & 32 ? INPUT.RIGHT : INPUT.LEFT | INPUT.JUMP, i, game.sim, {});
  if (i % 300 === 0) q = home; // stay among the enemies (deaths and drifting off reset it)
}
const us2 = (performance.now() - t1) * 1000 / STEPS;
console.log(`stepPlayer among ${busiest.n} spawners: ${us2.toFixed(2)} µs/step (64 players at 60 Hz: ${(us2 * 64 * 60 / 1e4).toFixed(2)}% of one core)`);
