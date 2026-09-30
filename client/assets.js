// Asset manifest: the spec for what the game expects, a validator, and the runtime loader.
// See ART.md. The spec and validateManifest are pure (no DOM, no Node APIs), so the Node
// test (test/assets.test.js) and the in-browser viewer (tools/assets.html) share them.
// The runtime loader (loadManifest, loadSpriteAtlas) at the bottom is browser-only.
import { TILES } from '../shared/tiles.js';
import { GOODS } from '../shared/goods.js';

export const MANIFEST_VERSION = 1;
export const TILE_PX = 16;
export const ICON_PX = 16;

/** Autotile layouts. `cardinal4`: a 16-frame horizontal strip, frame = N | E<<1 | S<<2 | W<<3. */
export const AUTOTILE = Object.freeze({
  cardinal4: { frames: 16 },
});

/** Tiles that get art (every tile except `empty`), and whether autotiling makes sense for each. */
export const TILE_SPEC = Object.freeze({
  solid: { autotile: 'cardinal4', note: 'main terrain' },
  spike: { autotile: null, note: 'points up; the renderer rotates it for walls and ceilings' },
  oneWay: { autotile: null, note: 'thin platform; the top 4 px read as the standing surface' },
  postFloor: { autotile: 'cardinal4', note: 'trade post floor' },
  postWall: { autotile: 'cardinal4', note: 'trade post walls and roof' },
  slopeR: { autotile: null, note: "45° ramp rising to the right ('/'). Also used mirrored for slopeL" },
  slopeL: { autotile: null, note: "optional: '\\' ramp, if the mirrored slopeR art doesn't suit" },
});

/**
 * Sprites the game will draw, with their recommended frame size and anchor
 * (the pivot, in frame pixels, that sits at the entity's position).
 * `required` animations are needed before the sprite replaces its flat-color quad.
 */
export const SPRITE_SPEC = Object.freeze({
  player: { frame: [24, 24], anchor: [12, 24], required: ['idle', 'run', 'jump', 'fall', 'wallSlide'], optional: ['land', 'death'] },
  patroller: { frame: [16, 16], anchor: [8, 16], required: ['walk'], optional: ['stomped'] },
  flyer: { frame: [16, 16], anchor: [8, 8], required: ['fly'], optional: [] },
  saw: { frame: [32, 32], anchor: [16, 16], required: ['spin'], optional: [] },
  dust: { frame: [8, 8], anchor: [4, 8], required: ['puff'], optional: [] },
  splat: { frame: [16, 16], anchor: [8, 8], required: ['burst', 'stain'], optional: [] },
  postSign: { frame: [32, 16], anchor: [16, 16], required: ['idle'], optional: [] },
});

/** Named colors. Flat-color rendering uses them now; art should stay in this palette. */
export const PALETTE_KEYS = Object.freeze([
  'sky', 'terrain', 'terrainEdge', 'oneWay', 'hazard', 'enemy',
  'player', 'ghost', 'postFloor', 'postWall', 'uiPanel', 'uiText', 'uiAccent', 'money',
]);
/** Palette `posts` must have at least this many colors, one per trade post. */
export const MIN_POST_COLORS = 12;

const HEX = /^#[0-9a-fA-F]{6}$/;
const FILE = /^(tiles|sprites|icons)\/[a-z0-9_\-/]+\.png$/;

/**
 * Validate a manifest against the spec and the image files it references.
 * @param {any} m parsed manifest.json
 * @param {(file: string) => Promise<{w: number, h: number} | null>} readSize
 *   size of an image path relative to client/assets/, or null if missing or unreadable
 * @returns {Promise<{errors: string[], warnings: string[], files: Set<string>}>}
 *   `files` lists every image the manifest references (for orphan checks)
 */
export async function validateManifest(m, readSize) {
  const errors = [];
  const warnings = [];
  const files = new Set();
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0);

  if (!isObj(m)) return { errors: ['manifest is not an object'], warnings, files };
  if (m.version !== MANIFEST_VERSION) errors.push(`version must be ${MANIFEST_VERSION}`);

  async function checkImage(where, file, w, h) {
    if (typeof file !== 'string' || !FILE.test(file)) {
      errors.push(`${where}: bad file path ${JSON.stringify(file)} (lowercase, under tiles/ sprites/ icons/, .png)`);
      return;
    }
    files.add(file);
    const size = await readSize(file);
    if (!size) errors.push(`${where}: ${file} is missing or not a PNG`);
    else if (size.w !== w || size.h !== h) errors.push(`${where}: ${file} is ${size.w}×${size.h}, expected ${w}×${h}`);
  }

  // palette
  if (!isObj(m.palette)) {
    errors.push('palette: missing');
  } else {
    for (const key of PALETTE_KEYS) {
      if (!HEX.test(m.palette[key] ?? '')) errors.push(`palette.${key}: must be "#rrggbb"`);
    }
    const posts = m.palette.posts;
    if (!Array.isArray(posts) || posts.length < MIN_POST_COLORS || !posts.every((c) => HEX.test(c))) {
      errors.push(`palette.posts: must be at least ${MIN_POST_COLORS} "#rrggbb" colors`);
    }
    for (const key of Object.keys(m.palette)) {
      if (key !== 'posts' && !PALETTE_KEYS.includes(key)) warnings.push(`palette.${key}: not used by the game yet`);
    }
  }

  // tiles
  const tileNames = new Set(TILES.map((t) => t.name));
  for (const [name, t] of Object.entries(m.tiles ?? {})) {
    const where = `tiles.${name}`;
    if (!tileNames.has(name) || name === 'empty') {
      errors.push(`${where}: unknown tile (see shared/tiles.js)`);
      continue;
    }
    if (!isObj(t)) { errors.push(`${where}: must be an object`); continue; }
    if (t.autotile !== undefined && !AUTOTILE[t.autotile]) {
      errors.push(`${where}: unknown autotile ${JSON.stringify(t.autotile)}`);
      continue;
    }
    const frames = t.autotile ? AUTOTILE[t.autotile].frames : 1;
    await checkImage(where, t.file, TILE_PX * frames, TILE_PX);
  }

  // sprites
  for (const [name, s] of Object.entries(m.sprites ?? {})) {
    const where = `sprites.${name}`;
    const spec = SPRITE_SPEC[name];
    if (!spec) warnings.push(`${where}: not in SPRITE_SPEC (the game won't draw it yet)`);
    if (!isObj(s) || !isPair(s.frame) || !isPair(s.anchor) || !isObj(s.anims)) {
      errors.push(`${where}: needs frame [w,h], anchor [x,y] and anims {}`);
      continue;
    }
    const [fw, fh] = s.frame;
    if (fw === 0 || fh === 0) errors.push(`${where}: frame size must be positive`);
    if (s.anchor[0] > fw || s.anchor[1] > fh) errors.push(`${where}: anchor lies outside the frame`);
    if (spec && (fw !== spec.frame[0] || fh !== spec.frame[1])) {
      warnings.push(`${where}: frame ${fw}×${fh} differs from the recommended ${spec.frame.join('×')}`);
    }
    for (const [anim, a] of Object.entries(s.anims)) {
      const aw = `${where}.anims.${anim}`;
      if (!isObj(a) || !Number.isInteger(a.frames) || a.frames < 1 || !(a.fps > 0) || typeof a.loop !== 'boolean') {
        errors.push(`${aw}: needs file, frames (≥1 integer), fps (>0), loop (boolean)`);
        continue;
      }
      if (spec && !spec.required.includes(anim) && !spec.optional.includes(anim)) {
        warnings.push(`${aw}: not an animation the game knows`);
      }
      await checkImage(aw, a.file, fw * a.frames, fh);
    }
    if (spec) {
      const missing = spec.required.filter((a) => !(a in s.anims));
      if (missing.length) warnings.push(`${where}: missing required anims ${missing.join(', ')} (the flat-color fallback stays in use)`);
    }
  }

  // icons
  const goodIds = new Set(GOODS.map((g) => g.id));
  for (const [id, file] of Object.entries(m.icons?.goods ?? {})) {
    if (!goodIds.has(id)) { errors.push(`icons.goods.${id}: unknown good (see shared/goods.js)`); continue; }
    await checkImage(`icons.goods.${id}`, file, ICON_PX, ICON_PX);
  }

  return { errors, warnings, files };
}

// Runtime loading (browser only). The functions above stay pure for the Node test.

/** "#rrggbb" → [r, g, b, 1] in 0..1. */
export function hexToRgba(hex, alpha = 1) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

/** Fetch and parse client/assets/manifest.json. Returns null if it's unavailable. */
export async function loadManifest(base = new URL('./assets/', import.meta.url)) {
  try {
    const res = await fetch(new URL('manifest.json', base));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('[assets] manifest unavailable, using built-in colors:', err.message);
    return null;
  }
}

/**
 * Load every sprite whose REQUIRED animations are all present and readable, and
 * pack their strips into one atlas texture (simple shelf packing). Sprites with
 * missing art are left out, so the game keeps drawing their flat-color fallback.
 * @param {GPUDevice} device
 * @param {any} manifest
 * @returns {Promise<{texture: GPUTexture | null, sprites: Record<string, LoadedSprite>}>}
 *
 * @typedef {{frame: [number, number], anchor: [number, number],
 *   anims: Record<string, {frames: [number, number, number, number][], fps: number, loop: boolean}>}} LoadedSprite
 *   frames are atlas texel rects [u0, v0, u1, v1]
 */
export async function loadSpriteAtlas(device, manifest, base = new URL('./assets/', import.meta.url)) {
  const wanted = [];
  for (const [name, s] of Object.entries(manifest?.sprites ?? {})) {
    const spec = SPRITE_SPEC[name];
    if (!spec || !s?.anims) continue;
    if (!spec.required.every((a) => a in s.anims)) continue;
    wanted.push([name, s]);
  }
  if (wanted.length === 0) return { texture: null, sprites: {} };

  const load = async (file) => {
    try {
      const res = await fetch(new URL(file, base));
      if (!res.ok) return null;
      return await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      return null;
    }
  };

  // Load every strip, and drop a sprite whose required strips fail.
  const strips = []; // {name, anim, bitmap, def}
  for (const [name, s] of wanted) {
    const loaded = await Promise.all(Object.entries(s.anims).map(async ([anim, a]) => ({ name, anim, def: a, bitmap: await load(a.file) })));
    const ok = SPRITE_SPEC[name].required.every((r) => loaded.find((l) => l.anim === r)?.bitmap);
    if (ok) strips.push(...loaded.filter((l) => l.bitmap));
    else console.warn(`[assets] sprite ${name}: a required strip failed to load, using the flat-color fallback`);
  }
  if (strips.length === 0) return { texture: null, sprites: {} };

  // Shelf pack: tallest first, rows across a fixed width. 1 px gutter against bleeding.
  const ATLAS_W = 1024;
  const GUTTER = 1;
  strips.sort((a, b) => b.bitmap.height - a.bitmap.height);
  let x = 0, y = 0, rowH = 0;
  for (const s of strips) {
    if (s.bitmap.width > ATLAS_W) throw new Error(`[assets] ${s.name}.${s.anim} is wider than the ${ATLAS_W}px atlas`);
    if (x + s.bitmap.width > ATLAS_W) { x = 0; y += rowH + GUTTER; rowH = 0; }
    s.x = x; s.y = y;
    x += s.bitmap.width + GUTTER;
    rowH = Math.max(rowH, s.bitmap.height);
  }
  const atlasH = y + rowH;

  const texture = device.createTexture({
    label: 'sprite atlas',
    size: [ATLAS_W, atlasH],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const sprites = {};
  for (const s of strips) {
    device.queue.copyExternalImageToTexture({ source: s.bitmap }, { texture, origin: [s.x, s.y] }, [s.bitmap.width, s.bitmap.height]);
    const def = manifest.sprites[s.name];
    const [fw, fh] = def.frame;
    const sprite = (sprites[s.name] ??= { frame: [fw, fh], anchor: def.anchor, anims: {} });
    sprite.anims[s.anim] = {
      fps: s.def.fps,
      loop: s.def.loop,
      frames: Array.from({ length: s.def.frames }, (_, i) => [s.x + i * fw, s.y, s.x + (i + 1) * fw, s.y + fh]),
    };
    s.bitmap.close();
  }
  console.info(`[assets] sprite atlas ${ATLAS_W}×${atlasH}: ${Object.keys(sprites).join(', ')}`);
  return { texture, sprites };
}

/**
 * Load tile art into a 16×16 texture array: one layer per frame (16 for a
 * cardinal4 strip). Tiles without art are left out, so they keep their flat
 * palette style.
 * @param {GPUDevice} device
 * @returns {Promise<{texture: GPUTexture | null, art: Record<string, {layer: number, autotile: boolean}>}>}
 */
export async function loadTileArt(device, manifest, base = new URL('./assets/', import.meta.url)) {
  const entries = [];
  for (const [name, t] of Object.entries(manifest?.tiles ?? {})) {
    if (!TILE_SPEC[name] || typeof t?.file !== 'string') continue;
    const frames = t.autotile ? AUTOTILE[t.autotile]?.frames : 1;
    if (!frames) continue;
    try {
      const res = await fetch(new URL(t.file, base));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (bitmap.width !== TILE_PX * frames || bitmap.height !== TILE_PX) {
        console.warn(`[assets] tile ${name}: ${bitmap.width}×${bitmap.height}, expected ${TILE_PX * frames}×${TILE_PX}. Using the flat style`);
        bitmap.close();
        continue;
      }
      entries.push({ name, bitmap, frames, autotile: !!t.autotile });
    } catch (err) {
      console.warn(`[assets] tile ${name}: ${err.message}. Using the flat style`);
    }
  }
  if (entries.length === 0) return { texture: null, art: {} };

  const layers = entries.reduce((n, e) => n + e.frames, 0);
  const texture = device.createTexture({
    label: 'tile art',
    size: [TILE_PX, TILE_PX, layers],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const art = {};
  let layer = 0;
  for (const e of entries) {
    art[e.name] = { layer, autotile: e.autotile };
    for (let f = 0; f < e.frames; f++) {
      device.queue.copyExternalImageToTexture(
        { source: e.bitmap, origin: [f * TILE_PX, 0] },
        { texture, origin: [0, 0, layer + f] },
        [TILE_PX, TILE_PX],
      );
    }
    layer += e.frames;
    e.bitmap.close();
  }
  console.info(`[assets] tile art: ${Object.keys(art).join(', ')} (${layers} layers)`);
  return { texture, art };
}
