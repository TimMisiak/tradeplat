// Runs every bench/*.bench.js in turn. Each bench module prints its own results.
// Benchmarks justify architecture calls (ARCHITECTURE.md § Principles), so each
// one should print numbers that someone could put in a doc.
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('.', import.meta.url));
const only = process.argv[2];
const files = (await readdir(dir)).filter((f) => f.endsWith('.bench.js') && (!only || f.includes(only))).sort();

if (files.length === 0) console.log(only ? `no bench matching "${only}"` : 'no benchmarks yet');
for (const f of files) {
  console.log(`\n# ${f}`);
  await import(pathToFileURL(join(dir, f)).href);
}
