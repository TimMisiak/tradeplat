// Runtime glyph atlas and UI quads. See ARCHITECTURE.md § UI.
// Glyphs are drawn with Canvas2D fillText (system monospace) into an OffscreenCanvas
// at the viewport's device scale, so a glyph quad that is CELL_W × CELL_H virtual
// px maps 1:1 onto device pixels and text stays crisp at any integer scale. Goods
// icons are copied into the same canvas (nearest-neighbour), so the whole UI is one
// texture. Characters are added on first use (player names can be any script).
import { SpriteBatch } from '../gpu/renderer.js';

/** Glyph cell in virtual px. Every glyph advances by CELL_W. */
export const CELL_W = 6;
export const CELL_H = 11;
const FONT_PX = 10;
const ATLAS_PX = 1024;
/** Preloaded so the first menu frame doesn't stall. */
const PRELOAD = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') + '×·←→↑↓…▶—●';

/** Width in virtual px of a string drawn with text(). */
export const textWidth = (str) => [...str].length * CELL_W;

/**
 * @param {number} scale device px per virtual px (≥ 1, an integer for crisp text)
 * @param {Record<string, ImageBitmap>} icons goodId → 16×16 icon bitmap
 */
export function createTextAtlas(scale, icons = {}) {
  const s = Math.max(1, Math.round(scale));
  const canvas = new OffscreenCanvas(ATLAS_PX, ATLAS_PX);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const cw = CELL_W * s, ch = CELL_H * s;
  const cols = Math.floor(ATLAS_PX / cw);
  /** char → [u0, v0, u1, v1] in atlas texels */
  const glyphs = new Map();
  /** goodId → [u0, v0, u1, v1] */
  const iconUv = {};
  let next = 0;

  // Icons along the bottom rows (16 virtual px each), glyphs from the top.
  const ip = 16 * s;
  const perRow = Math.floor(ATLAS_PX / (ip + s));
  const iconList = Object.entries(icons);
  iconList.forEach(([id, bmp], i) => {
    const x = (i % perRow) * (ip + s);
    const y = ATLAS_PX - (ip + s) * (1 + Math.floor(i / perRow));
    ctx.drawImage(bmp, x, y, ip, ip);
    iconUv[id] = [x, y, x + ip, y + ip];
  });
  const iconRows = Math.ceil(iconList.length / perRow);
  const glyphRows = Math.floor((ATLAS_PX - iconRows * (ip + s)) / ch);
  const capacity = cols * glyphRows;

  ctx.font = `${FONT_PX * s}px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';

  const atlas = {
    canvas,
    scale: s,
    iconUv,
    /** Set when glyphs were added since the last upload. */
    dirty: true,
    /** Atlas rect for a character (added on first use; '?' when the atlas is full). */
    glyph(c) {
      let g = glyphs.get(c);
      if (g) return g;
      if (next >= capacity) return glyphs.get('?');
      const x = (next % cols) * cw, y = Math.floor(next / cols) * ch;
      next++;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cw, ch);
      ctx.clip();
      ctx.fillText(c, x + cw / 2, y + ch / 2 + s * 0.5);
      ctx.restore();
      g = [x, y, x + cw, y + ch];
      glyphs.set(c, g);
      atlas.dirty = true;
      return g;
    },
  };
  for (const c of PRELOAD) atlas.glyph(c);
  return atlas;
}

/**
 * Screen-space UI batch in virtual px: text, flat rects and icons. Positions are
 * whole virtual pixels from the top-left of the view.
 */
export class UiBatch extends SpriteBatch {
  /** @param {ReturnType<typeof createTextAtlas> | null} atlas */
  setAtlas(atlas) { this.atlas = atlas; }

  rect(x, y, w, h, color) { this.push(x, y, w, h, color); }

  /** Draw a string; returns the x after it. A shadow color adds a 1 px drop shadow. */
  text(x, y, str, color, shadow) {
    if (!this.atlas) return x + textWidth(str);
    if (shadow) this.text(x + 1, y + 1, str, shadow);
    for (const c of str) {
      if (c !== ' ') this.push(x, y, CELL_W, CELL_H, color, this.atlas.glyph(c));
      x += CELL_W;
    }
    return x;
  }

  /** Right-aligned text ending at x. */
  textRight(x, y, str, color, shadow) { return this.text(x - textWidth(str), y, str, color, shadow); }

  /** Centered on x. */
  textCenter(x, y, str, color, shadow) { return this.text(Math.round(x - textWidth(str) / 2), y, str, color, shadow); }

  /** A 16×16 goods icon at (x, y) drawn at `size`, or a flat swatch if there's no art. */
  icon(x, y, goodId, size, fallback) {
    const uv = this.atlas?.iconUv[goodId];
    if (uv) this.push(x, y, size, size, [1, 1, 1, 1], uv);
    else this.push(x + size / 4, y + size / 4, size / 2, size / 2, fallback);
  }
}
