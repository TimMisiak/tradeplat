// Asset manifest: the spec for what the game expects, and a validator.
// See ART.md. This module is pure (no DOM, no Node APIs), so the Node test
// (test/assets.test.js) and the in-browser viewer (tools/assets.html) share it.
// The runtime asset loader will live here too (M1/M2).
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
