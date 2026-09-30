// Tile ids and flags. See WORLDGEN.md § Map.
// Physics, rendering, worldgen and the asset manifest look tiles up by these
// names and flags. Never hard-code ids elsewhere.
// Ids are stored one per byte in the map, so there can be at most 256.

export const FLAG = Object.freeze({
  SOLID: 1 << 0, // blocks movement on every side
  ONE_WAY: 1 << 1, // solid only from above, and only when down isn't held
  HAZARD: 1 << 2, // kills on touch
  NO_SPAWN: 1 << 3, // no hazards or enemy spawners (post surroundings)
  POST: 1 << 4, // part of a trade post structure
  SLOPE_R: 1 << 5, // 45° ramp rising to the right ('/'): solid below the diagonal
  SLOPE_L: 1 << 6, // 45° ramp rising to the left ('\\')
});

/** Either ramp direction. Ramps are not SOLID: physics treats them as a walkable surface. */
export const SLOPE = FLAG.SLOPE_R | FLAG.SLOPE_L;

/** Tile table. The array index is the tile id stored in the map. */
export const TILES = Object.freeze([
  { name: 'empty', flags: 0 },
  { name: 'solid', flags: FLAG.SOLID },
  { name: 'spike', flags: FLAG.HAZARD },
  { name: 'oneWay', flags: FLAG.ONE_WAY },
  { name: 'postFloor', flags: FLAG.SOLID | FLAG.POST | FLAG.NO_SPAWN },
  { name: 'postWall', flags: FLAG.SOLID | FLAG.POST | FLAG.NO_SPAWN },
  { name: 'slopeR', flags: FLAG.SLOPE_R },
  { name: 'slopeL', flags: FLAG.SLOPE_L },
]);

export const TILE = Object.freeze(Object.fromEntries(TILES.map((t, id) => [t.name, id])));

/** Per-id flag lookup, used in hot loops. */
export const TILE_FLAGS = Uint8Array.from(TILES, (t) => t.flags);

export const TILE_SIZE = 16;

// Maps

/**
 * A tile map: row-major tile ids, one byte per tile. See WORLDGEN.md § Map.
 * @typedef {{w: number, h: number, tiles: Uint8Array}} TileMap
 */

/** @returns {TileMap} */
export function createMap(w, h) {
  return { w, h, tiles: new Uint8Array(w * h) };
}

/** Tile id at (tx, ty). Anything outside the map counts as solid, so the border is implicit bedrock. */
export function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return TILE.solid;
  return map.tiles[ty * map.w + tx];
}

export function flagsAt(map, tx, ty) {
  return TILE_FLAGS[tileAt(map, tx, ty)];
}

/** Characters used by hand-written ASCII maps (tests, the M1 test level). */
export const ASCII_LEGEND = Object.freeze({
  '.': TILE.empty,
  ' ': TILE.empty,
  '#': TILE.solid,
  '^': TILE.spike,
  '=': TILE.oneWay,
  '_': TILE.postFloor,
  '|': TILE.postWall,
  '/': TILE.slopeR,
  '\\': TILE.slopeL,
});

/**
 * Parse an ASCII map. Rows may differ in length (short rows are padded with empty).
 * Characters not in the legend are empty tiles, and their positions are returned
 * as markers (e.g. '@' for the spawn point).
 * @param {string[]} rows
 * @returns {TileMap & {markers: Record<string, {tx: number, ty: number}[]>}}
 */
export function parseAsciiMap(rows) {
  const w = Math.max(...rows.map((r) => r.length));
  const map = createMap(w, rows.length);
  const markers = {};
  rows.forEach((row, ty) => {
    for (let tx = 0; tx < row.length; tx++) {
      const ch = row[tx];
      const id = ASCII_LEGEND[ch];
      if (id !== undefined) {
        map.tiles[ty * w + tx] = id;
      } else {
        (markers[ch] ??= []).push({ tx, ty });
      }
    }
  });
  return { ...map, markers };
}
