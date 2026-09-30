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
});

/** Tile table. The array index is the tile id stored in the map. */
export const TILES = Object.freeze([
  { name: 'empty', flags: 0 },
  { name: 'solid', flags: FLAG.SOLID },
  { name: 'spike', flags: FLAG.HAZARD },
  { name: 'oneWay', flags: FLAG.ONE_WAY },
  { name: 'postFloor', flags: FLAG.SOLID | FLAG.POST | FLAG.NO_SPAWN },
  { name: 'postWall', flags: FLAG.SOLID | FLAG.POST | FLAG.NO_SPAWN },
]);

export const TILE = Object.freeze(Object.fromEntries(TILES.map((t, id) => [t.name, id])));

/** Per-id flag lookup, used in hot loops. */
export const TILE_FLAGS = Uint8Array.from(TILES, (t) => t.flags);

export const TILE_SIZE = 16;
