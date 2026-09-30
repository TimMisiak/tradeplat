// Goods catalog. See ECONOMY.md § Goods catalog for the reasoning behind each value.
// Shared so the client can show names and sizes. Prices are computed only on the server.

/** @typedef {{id: string, name: string, size: number, base: number, sigma: number, tier: string}} Good */

/** @type {readonly Good[]} */
export const GOODS = Object.freeze([
  { id: 'water', name: 'Water', size: 2, base: 8, sigma: 0.03, tier: 'raw' },
  { id: 'grain', name: 'Grain', size: 2, base: 12, sigma: 0.04, tier: 'raw' },
  { id: 'ore', name: 'Ore', size: 3, base: 20, sigma: 0.05, tier: 'raw' },
  { id: 'fuel', name: 'Fuel', size: 2, base: 35, sigma: 0.08, tier: 'raw' },
  { id: 'food', name: 'Rations', size: 1, base: 30, sigma: 0.04, tier: 'intermediate' },
  { id: 'metal', name: 'Metal', size: 2, base: 60, sigma: 0.05, tier: 'intermediate' },
  { id: 'cloth', name: 'Cloth', size: 1, base: 45, sigma: 0.05, tier: 'intermediate' },
  { id: 'tools', name: 'Tools', size: 1, base: 140, sigma: 0.06, tier: 'finished' },
  { id: 'meds', name: 'Medicine', size: 1, base: 220, sigma: 0.09, tier: 'finished' },
  { id: 'relics', name: 'Relics', size: 1, base: 600, sigma: 0.15, tier: 'luxury' },
].map(Object.freeze));

export const GOOD_BY_ID = Object.freeze(Object.fromEntries(GOODS.map((g) => [g.id, g])));
