// light_calculator — the model of block light the torch network is planned on.
// Minecraft spreads block light from a source one block at a time: the source cell holds its emission, and
// each step into a neighbouring cell loses the larger of 1 and that cell's light filter. A cell whose filter
// is 15 (stone, dirt, any full opaque block) takes no light and passes none. The level a cell ends with is
// the highest any source gives it, so light from several torches combines as a maximum, never a sum.
//
// Every number comes from the game's own block table (minecraft-data: emitLight, filterLight), so water,
// leaves, glass and ice lose light by what the game says they lose; a block that lights only in some states
// (a burning furnace, a lit candle) gives the game's level for the state it is in. Directional blocking (a slab's top face,
// a stair's back) is not modelled: those blocks pass light as their filter says, in every direction.
// An unread cell (unloaded, outside the reader) passes no light, so the model never claims light it did not
// trace through cells it saw; a plan built on it can only lay a torch too many, never one too few.
//
// Pure arithmetic over a caller's reader (Law 26: a deterministic machine). `blockAt(x, y, z)` returns an
// object with `name`, or null for a cell that could not be read.

'use strict';

const OPAQUE = 15;

let _blocks = null;
function blockTable() {
  if (!_blocks) _blocks = require('minecraft-data')(require('@thinking/architect_config').SERVER_MINECRAFT_VERSION).blocksByName;
  return _blocks;
}

// filterOf(name) → how much light a cell of this block takes from light passing into it; 15 stops it.
function filterOf(name) {
  if (!name) return OPAQUE;
  const b = blockTable()[name];
  if (!b) {
    throw new Error(`[light_calculator] CODING VIOLATION: '${name}' is not a block of ${require('@thinking/architect_config').SERVER_MINECRAFT_VERSION}. `
      + 'The reader handed the light model a name the game table does not hold.');
  }
  return typeof b.filterLight === 'number' ? b.filterLight : (b.transparent ? 0 : OPAQUE);
}

// The blocks whose light depends on their state. The game table gives one number per name, so a burning
// furnace reads 0 there and a cold campfire 15; these are the game's own levels for each state.
const LIT_EMISSION = {
  furnace: 13, blast_furnace: 13, smoker: 13, redstone_ore: 9, deepslate_redstone_ore: 9, redstone_lamp: 15,
  redstone_torch: 7, redstone_wall_torch: 7, campfire: 15, soul_campfire: 10,
  copper_bulb: 15, exposed_copper_bulb: 12, weathered_copper_bulb: 8, oxidized_copper_bulb: 4,
  waxed_copper_bulb: 15, waxed_exposed_copper_bulb: 12, waxed_weathered_copper_bulb: 8, waxed_oxidized_copper_bulb: 4,
};
const truthy = (v) => v === true || v === 'true';

// emissionOf(name, props) → the light level a block gives off (torch 14, lantern 15, air 0). `props`, the
// block's state properties, decides it for the blocks that light only in some states; without them the
// table's level stands.
function emissionOf(name, props) {
  const b = name ? blockTable()[name] : null;
  const level = b && typeof b.emitLight === 'number' ? b.emitLight : 0;
  if (!props) return level;
  if (name === 'light') return Number(props.level) || 0;
  if (name === 'respawn_anchor') return [0, 3, 7, 11, 15][Number(props.charges) || 0];
  if (name === 'sea_pickle') return truthy(props.waterlogged) ? 3 * (Number(props.pickles) || 1) + 3 : 0;
  if (name === 'cave_vines' || name === 'cave_vines_plant') return truthy(props.berries) ? 14 : 0;
  if (props.lit === undefined) return level;
  if (!truthy(props.lit)) return 0;
  if (name.endsWith('candle')) return 3 * (Number(props.candles) || 1);
  if (name.endsWith('candle_cake')) return 3;
  return LIT_EMISSION[name] ?? level;
}

const stringKey = (x, y, z) => `${x},${y},${z}`;

// lightField(blockAt, source, emission, floor, key) → Map key(x,y,z) → level, for every cell this one source
// lights above `floor`; `key` defaults to "x,y,z", and a caller planning many fields passes a numeric one.
// `only`, when given, is the Set of keys the caller will read: the trace still runs through every cell, and
// the returned Map holds only those.
// Cells at or under the floor are left out: they are what a planner treats as unlit, and tracing them would
// only cost time. Light cannot travel farther than its emission, so the trace runs in a fixed box round the
// source, and spreads in falling-level buckets: every cell is settled at its highest level the first time
// it is taken (the order Dijkstra settles a shortest path in).
// One scratch box per emission, reused by every trace and wiped back cell by cell (a plan traces thousands).
const _boxes = new Map();
function boxFor(R) {
  let box = _boxes.get(R);
  if (!box) {
    const size = (2 * R + 1) ** 3;
    box = { level: new Int8Array(size), filter: new Int8Array(size).fill(-1), touched: [] };
    _boxes.set(R, box);
  }
  return box;
}

function lightField(blockAt, source, emission, floor = 0, key = stringKey, only = null) {
  const field = new Map();
  if (emission <= floor) return field;
  const R = emission, W = 2 * R + 1, AREA = W * W;
  const { level, filter, touched } = boxFor(R);
  const at = (lx, ly, lz) => (lx * W + ly) * W + lz;
  const buckets = Array.from({ length: emission + 1 }, () => []);
  const c0 = at(R, R, R);
  level[c0] = emission;
  filter[c0] = 0;
  touched.push(c0);
  buckets[emission].push(c0);
  const steps = [AREA, -AREA, W, -W, 1, -1];
  for (let lv = emission; lv > floor; lv--) {
    const bucket = buckets[lv];
    for (let b = 0; b < bucket.length; b++) {
      const i = bucket[b];
      if (level[i] !== lv) continue;                       // settled higher by another path
      const lx = Math.floor(i / AREA), ly = Math.floor(i / W) % W, lz = i % W;
      const k = key(source.x + lx - R, source.y + ly - R, source.z + lz - R);
      if (!only || only.has(k)) field.set(k, lv);
      for (let n = 0; n < 6; n++) {
        // A step off the box's edge would need more light than the source has; the box is never left.
        if ((n === 0 && lx === W - 1) || (n === 1 && lx === 0) || (n === 2 && ly === W - 1) || (n === 3 && ly === 0) || (n === 4 && lz === W - 1) || (n === 5 && lz === 0)) continue;
        const j = i + steps[n];
        let f = filter[j];
        if (f < 0) {
          const jx = Math.floor(j / AREA), jy = Math.floor(j / W) % W, jz = j % W;
          const blk = blockAt(source.x + jx - R, source.y + jy - R, source.z + jz - R);
          f = blk ? filterOf(blk.name) : OPAQUE;
          filter[j] = f;
          touched.push(j);
        }
        if (f >= OPAQUE) continue;
        const next = lv - Math.max(1, f);
        if (next <= floor || level[j] >= next) continue;
        level[j] = next;
        buckets[next].push(j);
      }
    }
  }
  for (const t of touched) { level[t] = 0; filter[t] = -1; }
  touched.length = 0;
  return field;
}

module.exports = { lightField, emissionOf, filterOf, OPAQUE };
