// Checks that client/assets/manifest.json agrees with the files on disk. See ART.md.
// Run just this file with: npm run test:assets
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../client/assets.js';

const ASSETS = fileURLToPath(new URL('../client/assets/', import.meta.url));
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, or null if the file is missing or not a PNG. */
async function pngSize(file) {
  let buf;
  try {
    buf = await readFile(join(ASSETS, file));
  } catch {
    return null;
  }
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function listPngs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      out.push(relative(ASSETS, join(entry.parentPath, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}

test('manifest is valid and matches the files on disk', async () => {
  const manifest = JSON.parse(await readFile(join(ASSETS, 'manifest.json'), 'utf8'));
  const { errors, warnings, files } = await validateManifest(manifest, pngSize);
  for (const w of warnings) console.log(`  warning: ${w}`);
  assert.deepEqual(errors, [], 'manifest errors');

  const orphans = (await listPngs(ASSETS)).filter((f) => !files.has(f));
  assert.deepEqual(orphans, [], 'PNGs on disk that the manifest does not reference');
});

// The validator itself, against a fake filesystem.

const PALETTE = {
  sky: '#000000', terrain: '#000000', terrainEdge: '#000000', oneWay: '#000000', hazard: '#000000',
  enemy: '#000000', player: '#000000', ghost: '#000000', postFloor: '#000000', postWall: '#000000',
  uiPanel: '#000000', uiText: '#000000', uiAccent: '#000000', money: '#000000',
  posts: Array(12).fill('#123456'),
};
const fakeFs = (sizes) => async (f) => sizes[f] ?? null;

test('validator accepts a well-formed manifest', async () => {
  const m = {
    version: 1,
    palette: PALETTE,
    tiles: { solid: { file: 'tiles/solid.png', autotile: 'cardinal4' }, spike: { file: 'tiles/spike.png' } },
    sprites: {
      patroller: { frame: [16, 16], anchor: [8, 16], anims: { walk: { file: 'sprites/patroller/walk.png', frames: 4, fps: 8, loop: true } } },
    },
    icons: { goods: { ore: 'icons/goods/ore.png' } },
  };
  const r = await validateManifest(m, fakeFs({
    'tiles/solid.png': { w: 256, h: 16 },
    'tiles/spike.png': { w: 16, h: 16 },
    'sprites/patroller/walk.png': { w: 64, h: 16 },
    'icons/goods/ore.png': { w: 16, h: 16 },
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.files.size, 4);
});

test('validator reports wrong sizes, unknown names and missing files', async () => {
  const m = {
    version: 1,
    palette: { ...PALETTE, sky: 'blue' },
    tiles: { solid: { file: 'tiles/solid.png', autotile: 'cardinal4' }, lava: { file: 'tiles/lava.png' } },
    sprites: { flyer: { frame: [16, 16], anchor: [8, 8], anims: { fly: { file: 'sprites/flyer/fly.png', frames: 3, fps: 10, loop: true } } } },
    icons: { goods: { gold: 'icons/goods/gold.png', ore: 'icons/goods/ore.png' } },
  };
  const r = await validateManifest(m, fakeFs({
    'tiles/solid.png': { w: 16, h: 16 },
    'sprites/flyer/fly.png': { w: 64, h: 16 },
  }));
  const text = r.errors.join('\n');
  assert.match(text, /palette\.sky/);
  assert.match(text, /tiles\.solid: .* is 16×16, expected 256×16/);
  assert.match(text, /tiles\.lava: unknown tile/);
  assert.match(text, /sprites\.flyer\.anims\.fly: .* expected 48×16/);
  assert.match(text, /icons\.goods\.gold: unknown good/);
  assert.match(text, /icons\.goods\.ore: .* missing/);
});
