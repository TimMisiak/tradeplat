// World generation cost and output stats across seeds. Target: <200 ms per world
// in a browser (WORLDGEN.md § Goals). Usage: npm run bench -- worldgen
import { performance } from 'node:perf_hooks';
import { generateWorld } from '../shared/worldgen.js';

const N = 50;
const times = [];
let attempts = 0, tunnels = 0, platforms = 0, filled = 0;
for (let seed = 0; seed < N; seed++) {
  const t0 = performance.now();
  const w = generateWorld(seed);
  times.push(performance.now() - t0);
  attempts += w.attempt;
  tunnels += w.stats.tunnels;
  platforms += w.stats.platforms;
  filled += w.stats.filled;
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(N - 1, Math.floor(p * N))].toFixed(0);
console.log(`${N} worlds (1024×256): mean ${(times.reduce((a, b) => a + b, 0) / N).toFixed(0)} ms, p50 ${pct(0.5)}, p95 ${pct(0.95)}, max ${pct(1)}`);
console.log(`retries ${attempts}, repair tunnels ${tunnels}, platforms/world ${(platforms / N).toFixed(0)}, pit tiles filled/world ${(filled / N).toFixed(0)}`);
