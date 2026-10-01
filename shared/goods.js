// Goods catalog. See ECONOMY.md § Goods catalog for the reasoning behind each value.
// Shared so the client can show names. Prices are computed only on the server.

/** @typedef {{id: string, name: string, base: number, sigma: number, tier: string}} Good */

/** @type {readonly Good[]} */
export const GOODS = Object.freeze([
  { id: 'water', name: 'Water', base: 8, sigma: 0.03, tier: 'raw' },
  { id: 'grain', name: 'Grain', base: 12, sigma: 0.04, tier: 'raw' },
  { id: 'ore', name: 'Ore', base: 20, sigma: 0.05, tier: 'raw' },
  { id: 'fuel', name: 'Fuel', base: 35, sigma: 0.08, tier: 'raw' },
  { id: 'food', name: 'Rations', base: 30, sigma: 0.04, tier: 'intermediate' },
  { id: 'metal', name: 'Metal', base: 60, sigma: 0.05, tier: 'intermediate' },
  { id: 'cloth', name: 'Cloth', base: 45, sigma: 0.05, tier: 'intermediate' },
  { id: 'tools', name: 'Tools', base: 140, sigma: 0.06, tier: 'finished' },
  { id: 'meds', name: 'Medicine', base: 220, sigma: 0.09, tier: 'finished' },
  { id: 'relics', name: 'Relics', base: 600, sigma: 0.15, tier: 'luxury' },
].map(Object.freeze));

export const GOOD_BY_ID = Object.freeze(Object.fromEntries(GOODS.map((g) => [g.id, g])));
