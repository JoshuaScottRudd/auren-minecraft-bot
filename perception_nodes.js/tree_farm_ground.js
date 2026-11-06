// perception node: tree_farm_ground
// purpose: THE TREE FARM'S GROUND, one definition for the integrity keeper's thread and for a body (Law 16). Where
//          the farm lies (farmOf), and what one of its grid cells holds now (cellState). Pure read, no side effects:
//          every reader is handed in as at(x, y, z) → a block with a `name`, or null where the world is not held.
//
// ── WHERE THE FARM LIES (architect_config.TREE_FARM) ─────────────────────────────────────────────────
// Every grid point `spacing` apart, counted from the home footprint's corner, GATHER_KEEPOUT or more from every
// sited footprint (the lights box included) and within GATHER_REACH of the home's origin. `gap` is a cell's distance
// out from the home footprint, and `start` the gap of the nearest cell. THE HOME BAND is the cells within the row's
// `close` of the start: the ground the keeper counts and the chest job fills.
//
// ── WHAT A CELL HOLDS (cellState) ─────────────────────────────────────────────────────────────────────
//   treed    a sapling or a trunk stands on the cell, or within `spacing` of it: the cell is taken by a tree
//   open     ground a sapling stands on under open sky, no tree within `spacing`, no fluid within its clearance
//   blocked  no plantable ground under open sky (water, rock, a building, a hill over the read), or fluid too near
//   unknown  the cell's column is not held

'use strict';

const PLANTABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const TUFT = /^(short_grass|tall_grass|fern)$/;       // dug out of the cell before the sapling goes in
const LEAF = /(.*_)?leaves$/;
const TRUNK_OR_SAPLING = /(.*_)?log$|_sapling$/;
const TRUNK_BAND = { below: 1, above: 3 };   // the heights round a cell's ground a neighbouring trunk is read at
// NO SAPLING NEAR LAVA OR WATER. Lava sets fire to what burns near it, and a grown tree's canopy reaches a few
// blocks out from its trunk, so a sapling planted beside surface lava becomes a forest fire that spreads tree to
// tree. The clearance is the canopy plus lava's reach; water keeps a sapling off a bank. Read in a band round the
// sapling's ground, from below it to the height of a grown crown.
const FLUID_CLEAR = { lava: 8, water: 2 };
const FLUID_BAND = { below: 2, above: 6 };
const FLUID_REACH = Math.max(...Object.values(FLUID_CLEAR));
const OVER = (name) => AIR.has(name) || LEAF.test(name) || TUFT.test(name);

// farmOf({ boxes, home, origin, row, keepout, reach }) → { row, cells, home, gapOf, outsideKeepout, start, band }.
// `boxes` are every sited footprint at clearance 0 (find_buildingspot.footprintsOf), `home` the home structure's box
// among them, `origin` its transpose origin. `cells` is every grid point of the farm nearest first; `band` its home band.
function farmOf({ boxes, home, origin, row, keepout, reach }) {
  const mod = (n, m) => ((n % m) + m) % m;
  // gapOf — a column's distance in blocks out from the home's footprint.
  const gapOf = (x, z) => Math.max(home.minX - x, x - home.maxX, home.minZ - z, z - home.maxZ, 0);
  const within = (b, m, x, z) => x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m;
  // outsideKeepout — true for a column GATHER_KEEPOUT or more from every footprint and within GATHER_REACH of home,
  // on the grid or off it.
  const outsideKeepout = (x, z) => (x - origin.x) ** 2 + (z - origin.z) ** 2 <= reach * reach && !boxes.some(b => within(b, keepout, x, z));
  const cells = [];
  // first(n, from) — the first grid line (from's, `spacing` apart) at or past n.
  const first = (n, from) => n + mod(from - n, row.spacing);
  for (let x = first(origin.x - reach, home.minX); x <= origin.x + reach; x += row.spacing) {
    for (let z = first(origin.z - reach, home.minZ); z <= origin.z + reach; z += row.spacing) {
      if (outsideKeepout(x, z)) cells.push({ x, z, gap: gapOf(x, z) });
    }
  }
  cells.sort((p, q) => p.gap - q.gap);
  const start = cells.length ? cells[0].gap : 0;
  const band = cells.filter(c => c.gap <= start + row.close);
  return { row, cells, home, gapOf, outsideKeepout, start, band };
}

// groundOf(at, x, z, top, bottom) → the y of a column's ground when a sapling can stand on it, or null; `unknown`
// when the column is not held. The column is read down through open sky from `top`, and the first block met must be
// plantable with air or a tuft over it.
function groundOf(at, x, z, top, bottom) {
  for (let y = top; y >= bottom; y--) {
    const b = at(x, y, z);
    if (!b) return 'unknown';
    if (OVER(b.name)) continue;
    if (y === top || !PLANTABLE.has(b.name)) return null;
    const over = at(x, y + 1, z);
    return over && (AIR.has(over.name) || TUFT.test(over.name)) ? y : null;
  }
  return null;
}

// standsOn(at, x, z, top, bottom) → true when the first block under open sky in the column is a trunk or a sapling.
function standsOn(at, x, z, top, bottom) {
  for (let y = top; y >= bottom; y--) {
    const b = at(x, y, z);
    if (!b) return false;
    if (TRUNK_OR_SAPLING.test(b.name)) return true;
    if (!OVER(b.name)) return false;
  }
  return false;
}

// crowded(at, x, groundY, z, spacing) → true when a sapling or a trunk stands within `spacing` of the column.
function crowded(at, x, groundY, z, spacing) {
  for (let dx = -(spacing - 1); dx < spacing; dx++) {
    for (let dz = -(spacing - 1); dz < spacing; dz++) {
      for (let y = groundY - TRUNK_BAND.below; y <= groundY + TRUNK_BAND.above; y++) {
        const b = at(x + dx, y, z + dz);
        if (b && TRUNK_OR_SAPLING.test(b.name)) return true;
      }
    }
  }
  return false;
}

// nearFluid(at, x, groundY, z) → the fluid within its clearance of the column, or null (FLUID_CLEAR).
function nearFluid(at, x, groundY, z) {
  for (let dx = -FLUID_REACH; dx <= FLUID_REACH; dx++) {
    for (let dz = -FLUID_REACH; dz <= FLUID_REACH; dz++) {
      const far = Math.max(Math.abs(dx), Math.abs(dz));
      for (let y = groundY - FLUID_BAND.below; y <= groundY + FLUID_BAND.above; y++) {
        const b = at(x + dx, y, z + dz);
        if (!b) continue;
        for (const [fluid, clear] of Object.entries(FLUID_CLEAR)) if (far <= clear && b.name === fluid) return fluid;
      }
    }
  }
  return null;
}

// cellState(at, cell, top, bottom, spacing) → { state, y, fluid }: what the cell holds (header), `y` the cell a
// sapling would go in when open, `fluid` the fluid that blocked it.
function cellState(at, cell, top, bottom, spacing) {
  if (standsOn(at, cell.x, cell.z, top, bottom)) return { state: 'treed' };
  const groundY = groundOf(at, cell.x, cell.z, top, bottom);
  if (groundY === 'unknown') return { state: 'unknown' };
  if (groundY === null) return { state: 'blocked' };
  if (crowded(at, cell.x, groundY, cell.z, spacing)) return { state: 'treed' };
  const fluid = nearFluid(at, cell.x, groundY, cell.z);
  if (fluid) return { state: 'blocked', fluid };
  return { state: 'open', y: groundY + 1 };
}

module.exports = {
  farmOf, cellState, groundOf, crowded, nearFluid, FLUID_REACH,
  PLANTABLE, AIR, TUFT, LEAF, TRUNK_OR_SAPLING,
};
