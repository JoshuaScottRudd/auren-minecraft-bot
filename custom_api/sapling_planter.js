// sapling_planter — a crew replants beside its home structure when a tree harvest ends. Law 15 sub-loop
// API, sibling to tree_feller / seed_picker; harvest_executor calls plantAfterHarvest(bot) directly (no
// signal-bus entry point).
//
// ── WHO PLANTS ────────────────────────────────────────────────────────────────────────────────────────
// A species with a row in architect_config.TREE_FARM. A species with no row plants nothing and its
// saplings are handled as its stock rows say.
//
// ── WHAT IS PLANTED ───────────────────────────────────────────────────────────────────────────────────
// The primary sapling only: the sapling of the fleet's wood (set_wood_preference), the wood the build is
// made of. A pocket keeps the row's `keep` of it (pocketRow, read by job_board's whitelist); every other
// sapling, and the primary past the keep, goes to the waste pit (tossedSaplings, read by waste_pit).
//
// ── WHERE ─────────────────────────────────────────────────────────────────────────────────────────────
// The farm is the ground farther than yard_clear blocks from the home structure's footprint, on the three
// sides that do not face the row's `away_from` structure: the layers read `away_from`, home, clear ground, farm.
// A planting cell is a point of a grid `spacing` blocks apart counted from the home's corner, so the farm
// stands in rows a body walks between. A body claims a cell (`sapling:x,z`, target_claims) before it walks
// to it and releases it once the cell is planted or given up, so each cell has one planter. A cell qualifies when its ground is dirt or grass under open sky,
// no other building's footprint holds it, and no sapling or trunk stands within `spacing` of it.
//
// ── HOW MUCH ──────────────────────────────────────────────────────────────────────────────────────────
// One harvest plants at most `plantings` saplings, nearest cell first, in cells no farther than `search`
// blocks from where the harvest ended. No cell inside that distance: nothing is planted and no walk is made.
//
// Returns { planted, reason } — reason names why nothing more was planted, null when the limit was reached.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { performPlace } = require('@utils/movement/place_authority');
const { performDig } = require('@utils/movement/dig_authority');
const { classifyFloor } = require('@utils/movement/terrain_predicates');
const { group_to_item } = require('@utils/fragment_utils');
const { claimFirst, releaseTarget } = require('@utils/target_claims');

const TAG = 'sapling_planter';

// A dark oak grows only as four saplings in a square, so it is never the primary.
const SINGLE_SAPLINGS = (group_to_item.saplings || []).filter(n => n !== 'dark_oak_sapling');
const PLANTABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const TUFT = /^(short_grass|tall_grass|fern)$/;       // dug out of the cell before the sapling goes in
const LEAF = /(.*_)?leaves$/;
const TRUNK_OR_SAPLING = /(.*_)?log$|_sapling$/;
const SKY_ABOVE = 8;        // open cells a column is read through above the body's feet
const GROUND_BELOW = 8;     // and how far under them its ground is looked for
const TRUNK_BAND = { below: 1, above: 3 };   // the heights round a cell's ground a neighbouring trunk is read at
const MISS_LIMIT = 3;       // cells one harvest may walk to and fail at
const EIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// NO SAPLING NEAR LAVA OR WATER. Lava sets fire to what burns near it, and a grown tree's canopy reaches a few
// blocks out from its trunk, so a sapling planted beside surface lava becomes a forest fire that spreads tree to
// tree. The clearance is the canopy plus lava's reach; water keeps a sapling off a bank. Read in a band round the
// sapling's ground, from below it to the height of a grown crown.
const FLUID_CLEAR = { lava: 8, water: 2 };
const FLUID_BAND = { below: 2, above: 6 };
// One claim key per grid cell (foreman_brain OBJECT_KEY_PREFIXES), asked through target_claims.
const KEY_PREFIX = 'sapling:';
const keyOfCell = c => `${KEY_PREFIX}${c.x},${c.z}`;

// This species' TREE_FARM row, or null for a species that does not replant.
function farmRow() {
  const { TREE_FARM } = require('@thinking/architect_config');
  return TREE_FARM[require('@kernel/bot_mandate').currentMode()] || null;
}

// The one sapling this crew plants and keeps, or null: no farm row, no wood chosen yet, or a wood whose
// sapling does not grow alone.
function primarySapling() {
  if (!farmRow()) return null;
  const pref = require('@action/set_wood_preference').readWoodPreference();
  const name = pref && pref.species ? `${String(pref.species).replace(/_log$/, '')}_sapling` : null;
  return name && SINGLE_SAPLINGS.includes(name) ? name : null;
}

// The pocket row that keeps the primary sapling, as a list of none or one. It stands ahead of the
// `saplings` group row in the whitelist, so the primary answers to it and the group row to the rest.
function pocketRow() {
  const primary = primarySapling();
  return primary ? [{ item: primary, dump_threshold: farmRow().keep }] : [];
}

// The saplings whose surplus is trash for this crew: every one of them once a primary is known.
function tossedSaplings() {
  return primarySapling() ? [...(group_to_item.saplings || [])] : [];
}

// The farm's ground, or null before the home and the `away_from` structure are both sited.
function zone() {
  const row = farmRow();
  if (!row) return null;
  const { buildingRoomKey, homeBlueprint } = require('@kernel/bot_mandate');
  const boxes = require('@action/find_buildingspot').getExistingFootprints(0);
  const home = boxes.find(b => b.key === buildingRoomKey(homeBlueprint()));
  const away = boxes.find(b => b.key === buildingRoomKey(row.away_from));
  if (!home || !away) return null;
  // The side of the home that faces `away_from`, along the axis the two lie farthest apart on.
  const dx = (home.minX + home.maxX) / 2 - (away.minX + away.maxX) / 2;
  const dz = (home.minZ + home.maxZ) / 2 - (away.minZ + away.maxZ) / 2;
  const axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
  const sign = (axis === 'x' ? dx : dz) >= 0 ? 1 : -1;
  const edge = axis === 'x' ? (sign > 0 ? home.minX : home.maxX) : (sign > 0 ? home.minZ : home.maxZ);
  const others = boxes.filter(b => b !== home);
  const mod = (n, m) => ((n % m) + m) % m;

  // inFarm — true for a column past the clear ground that is a grid point and is no other building's ground.
  function inFarm(x, z) {
    if (sign * ((axis === 'x' ? x : z) - edge) < 0) return false;
    const gap = Math.max(home.minX - x, x - home.maxX, home.minZ - z, z - home.maxZ, 0);
    if (gap <= row.yard_clear) return false;
    if (mod(x - home.minX, row.spacing) !== 0 || mod(z - home.minZ, row.spacing) !== 0) return false;
    const g = row.building_gap;
    return !others.some(b => x >= b.minX - g && x <= b.maxX + g && z >= b.minZ - g && z <= b.maxZ + g);
  }
  return { row, inFarm };
}

// The y of a column's ground when a sapling can stand on it, or null: the column is read down through
// open sky from above the body's feet, and the first block met must be plantable.
function groundOf(bot, x, z, feetY) {
  for (let y = feetY + SKY_ABOVE; y >= feetY - GROUND_BELOW; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return null;
    if (AIR.has(b.name) || LEAF.test(b.name) || TUFT.test(b.name)) continue;
    if (y === feetY + SKY_ABOVE || !PLANTABLE.has(b.name)) return null;
    const over = bot.blockAt(new Vec3(x, y + 1, z));
    return over && (AIR.has(over.name) || TUFT.test(over.name)) ? y : null;
  }
  return null;
}

// True when a sapling or a trunk stands within `spacing` of the column, centre to centre.
function crowded(bot, x, groundY, z, spacing) {
  for (let dx = -(spacing - 1); dx < spacing; dx++) {
    for (let dz = -(spacing - 1); dz < spacing; dz++) {
      for (let y = groundY - TRUNK_BAND.below; y <= groundY + TRUNK_BAND.above; y++) {
        const b = bot.blockAt(new Vec3(x + dx, y, z + dz));
        if (b && TRUNK_OR_SAPLING.test(b.name)) return true;
      }
    }
  }
  return false;
}

// The fluid within its clearance of the column, or null (FLUID_CLEAR).
function nearFluid(bot, x, groundY, z) {
  const reach = Math.max(...Object.values(FLUID_CLEAR));
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      const far = Math.max(Math.abs(dx), Math.abs(dz));
      for (let y = groundY - FLUID_BAND.below; y <= groundY + FLUID_BAND.above; y++) {
        const b = bot.blockAt(new Vec3(x + dx, y, z + dz));
        if (!b) continue;
        for (const [fluid, clear] of Object.entries(FLUID_CLEAR)) if (far <= clear && b.name === fluid) return fluid;
      }
    }
  }
  return null;
}

// The feet cell a body plants `cell` from: one of the eight columns round it whose floor is level with the
// sapling's ground or one step above or below it and is standable (terrain_predicates.classifyFloor), the
// nearest to the body. Null when none of the eight stands.
function standBeside(bot, cell) {
  const from = bot.entity.position;
  const groundY = cell.y - 1;
  let best = null;
  for (const [dx, dz] of EIGHT) {
    for (const floorY of [groundY, groundY + 1, groundY - 1]) {
      const x = cell.x + dx, z = cell.z + dz;
      if (!classifyFloor(bot, bot.blockAt(new Vec3(x, floorY, z)))) continue;
      const d2 = (x + 0.5 - from.x) ** 2 + (z + 0.5 - from.z) ** 2;
      if (!best || d2 < best.d2) best = { pos: new Vec3(x, floorY + 1, z), d2 };
      break;
    }
  }
  return best ? best.pos : null;
}

function pocketCount(bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
}

// plantAfterHarvest — called where a tree harvest ended. Plants the primary sapling in the farm cells
// nearest the body, within the row's two limits.
async function plantAfterHarvest(bot) {
  const primary = primarySapling();
  if (!primary) return { planted: 0, reason: 'no_primary_sapling' };
  const farm = zone();
  if (!farm) return { planted: 0, reason: 'farm_not_sited' };
  const { row } = farm;
  const held = pocketCount(bot, primary);
  if (held === 0) return { planted: 0, reason: 'no_sapling_in_pocket' };

  const startedAt = Date.now();
  const start = bot.entity.position.clone();
  const feetY = Math.floor(start.y);
  const sx = Math.floor(start.x), sz = Math.floor(start.z);
  // The grid points of the farm inside the search distance, read once from where the harvest ended.
  const cells = [];
  for (let x = sx - row.search; x <= sx + row.search; x++) {
    for (let z = sz - row.search; z <= sz + row.search; z++) {
      if ((x - sx) ** 2 + (z - sz) ** 2 > row.search ** 2 || !farm.inFarm(x, z)) continue;
      cells.push({ x, z });
    }
  }
  if (!cells.length) return { planted: 0, reason: 'no_farm_cell_in_reach' };

  const locomotion = require('@locomotion/locomotion_dispatcher');
  const spent = new Set();
  const plantedAt = [];
  let misses = 0, peerHeld = 0, walked = 0, noStand = 0, nearLava = 0, nearWater = 0, reason = null;
  // A cell this body cannot use is passed before any claim is asked for, and its ground is read then.
  const unusable = (c) => {
    if (spent.has(keyOfCell(c))) return true;
    const groundY = groundOf(bot, c.x, c.z, feetY);
    if (groundY === null || crowded(bot, c.x, groundY, c.z, row.spacing)) { spent.add(keyOfCell(c)); return true; }
    const fluid = nearFluid(bot, c.x, groundY, c.z);
    if (fluid) { if (fluid === 'lava') nearLava++; else nearWater++; spent.add(keyOfCell(c)); return true; }
    c.y = groundY + 1;
    // A cell no body can stand beside is passed like a cell with no ground: no claim and no walk.
    c.stand = standBeside(bot, c);
    if (!c.stand) { noStand++; spent.add(keyOfCell(c)); return true; }
    return false;
  };
  const approach = async (c) => {
    spent.add(keyOfCell(c));   // one walk at a cell per harvest, reached or not
    const stand = c.stand;
    const from = bot.entity.position.clone();
    const nav = await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true, leg: 'work' });
    walked += Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z);
    return { ok: !!(nav && nav.arrived), reason: 'path_failed' };
  };
  while (plantedAt.length < row.plantings) {
    if (pocketCount(bot, primary) === 0) { reason = 'pocket_empty'; break; }
    if (misses >= MISS_LIMIT) { reason = 'cells_unreachable'; break; }
    // Nearest first from where the body stands now. The cell is claimed before the walk, so one body
    // walks to it and plants it (Invariant A); the grid keeps two claimed cells a full spacing apart.
    const here = bot.entity.position;
    const order = cells.filter(c => !spent.has(keyOfCell(c)))
      .sort((p, q) => ((p.x - here.x) ** 2 + (p.z - here.z) ** 2) - ((q.x - here.x) ** 2 + (q.z - here.z) ** 2));
    const walk = await claimFirst(order, { keyOf: keyOfCell, skip: unusable, approach, maxUnreachable: MISS_LIMIT - misses });
    for (const key of walk.peerHeldKeys) spent.add(key);
    peerHeld += walk.peerHeld;
    misses += walk.unreachable;
    if (!walk.pick) { reason = misses >= MISS_LIMIT ? 'cells_unreachable' : (walk.peerHeld ? 'cells_held_by_peers' : 'no_open_cell'); break; }
    spent.add(walk.key);
    const pick = new Vec3(walk.pick.x, walk.pick.y, walk.pick.z);

    // The cell is read again on arrival (Invariant B): the ground it was chosen for may have changed during the walk.
    const ground = bot.blockAt(pick.offset(0, -1, 0));
    const inCell = bot.blockAt(pick);
    const open = ground && PLANTABLE.has(ground.name) && !crowded(bot, pick.x, pick.y - 1, pick.z, row.spacing)
      && (!inCell || !TUFT.test(inCell.name) || await performDig(bot, pick, inCell, TAG));
    if (open) {
      const place = await performPlace(bot, pick, ground, new Vec3(0, 1, 0), primary, TAG);
      const after = bot.blockAt(pick);
      if (after && after.name === primary) plantedAt.push(`${pick.x},${pick.y},${pick.z}`);
      else { misses++; watcher.warn(TAG, `PLANT_MISSED cell=(${pick.x},${pick.y},${pick.z}) sapling=${primary} reason=${place.reason || 'the cell does not hold the sapling'}`); }
    }
    releaseTarget(walk.keys);
  }

  watcher.summary(TAG, `PLANTED n=${plantedAt.length} of=${row.plantings} sapling=${primary} pocket=${pocketCount(bot, primary)} held_before=${held} grid_cells_in_reach=${cells.length} peer_held=${peerHeld} misses=${misses} no_stand=${noStand} near_lava=${nearLava} near_water=${nearWater} walk=${Math.round(walked)} ms=${Date.now() - startedAt} stopped=${reason || 'limit'}${plantedAt.length ? ` cells=${plantedAt.join(' ')}` : ''}`);
  return { planted: plantedAt.length, reason };
}

module.exports = { plantAfterHarvest, primarySapling, pocketRow, tossedSaplings, zone, TAG };
