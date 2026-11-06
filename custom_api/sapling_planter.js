// sapling_planter — a crew plants its build's two woods: one where each tree was felled, and the rest in the home band
// of its tree farm. Law 15 sub-loop API, sibling to tree_feller / seed_picker; harvest_executor calls
// plantWhereFelled(bot, felled) directly after each felling, and sapling_plant_executor calls plantFarm(bot) for the
// chest job (no signal-bus entry point here).
//
// ── WHO PLANTS ────────────────────────────────────────────────────────────────────────────────────────
// A species with a row in architect_config.TREE_FARM. A species with no row plants nothing and its
// saplings are handled as its stock rows say.
//
// ── WHAT IS PLANTED ───────────────────────────────────────────────────────────────────────────────────
// The farm saplings: one per build wood (architect_config.BUILD_WOOD, oak and birch), planted in equal numbers so
// the forest grows back in the two tones the build is made of. A pocket keeps the row's `keep` of each (pocketRow,
// read by job_board's whitelist) and banks the rest; the chests keep the row's `bank` of each before the composter may
// have any (compost_executor.bankedCompostables). Every other sapling is banked for the composter. Every tree is
// felled whatever its species; only these two are planted.
//
// ── WHERE ─────────────────────────────────────────────────────────────────────────────────────────────
// Never within GATHER_KEEPOUT of a sited footprint (the lights box included), never past GATHER_REACH of home
// (perception_nodes/tree_farm_ground owns the farm's geometry and what a cell holds).
//   - plantWhereFelled: after each felling outside the keep-out, the harvester plants ONE farm sapling where the tree
//     stood, so the forest it takes from stays as it was and never grows thicker. The rest it carries rides home and
//     is banked.
//   - plantFarm: the chest job plants the home band's open cells nearest home first. Which cells are open, and
//     whether the band has reached TREE_FARM.saturation, is the integrity keeper's map (the `tree_farm` verdict); a
//     body with no foreman reads the band itself, nearest first. At the target nothing is planted.
// A body claims a cell (`sapling:x,z`, target_claims) before it walks to it and releases it once the cell is planted or
// given up, so each cell has one planter. The cell is read again by the body before the claim and on arrival
// (Invariant B); a cell that does not qualify or could not be planted is refused by this body for REFUSAL_MS.
//
// ── HOW MUCH ──────────────────────────────────────────────────────────────────────────────────────────
// A felling plants one. The chest job plants every farm sapling it took out (plantingTrip: up to `batch`, both woods
// alike), alternating so neither tone runs ahead.
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
const ground = require('@perception/tree_farm_ground');

const TAG = 'sapling_planter';

// A dark oak grows only as four saplings in a square, so it is never a farm sapling.
const SINGLE_SAPLINGS = (group_to_item.saplings || []).filter(n => n !== 'dark_oak_sapling');
const { PLANTABLE, TUFT } = ground;
const SKY_ABOVE = 8;        // open cells a column is read through above the body's feet
const GROUND_BELOW = 8;     // and how far under them its ground is looked for
const BAND_SKY = 24;        // a body with no foreman reads the band this far over and under the home's origin, as the keeper does
const MISS_LIMIT = 3;       // cells one planting may walk to and fail at
// A refused cell stays so this long (Law 8: module memory, bounded on write). A sapling takes minutes to grow and a
// cleared bank or a felled trunk opens ground again, so the refusal lapses.
const REFUSAL_MS = 5 * 60 * 1000;
const _refused = new Map();   // cell key → when refused
function refuse(key, now) {
  _refused.set(key, now);
  for (const [k, at] of _refused) if (now - at > REFUSAL_MS) _refused.delete(k);
}
const isRefused = (key, now) => _refused.has(key) && now - _refused.get(key) <= REFUSAL_MS;
const EIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// One claim key per cell (foreman_brain OBJECT_KEY_PREFIXES), asked through target_claims.
const KEY_PREFIX = 'sapling:';
const keyOfCell = c => `${KEY_PREFIX}${c.x},${c.z}`;
const OPEN_LIST = 64;       // the open cells a body with no foreman reads before it stops, as the keeper lists them

// The TREE_FARM row.
function farmRow() {
  return require('@thinking/architect_config').TREE_FARM;
}

// The saplings this crew plants and keeps, primary first: one per build wood whose sapling grows alone.
function farmSaplings() {
  const { BUILD_WOOD } = require('@thinking/architect_config');
  return [BUILD_WOOD.primary, BUILD_WOOD.accent].map(w => `${w}_sapling`).filter(n => SINGLE_SAPLINGS.includes(n));
}

// The pocket rows that keep the farm saplings. They stand ahead of the `saplings` group row in the whitelist, so
// each farm sapling answers to its own row and the group row to the rest.
function pocketRow() {
  return farmSaplings().map(item => ({ item, dump_threshold: farmRow().keep }));
}

// bankKept(name) → how many of a sapling the chests keep for the farm before the composter may have any: the row's
// `bank` for a farm sapling, 0 for any other.
function bankKept(name) {
  return farmSaplings().includes(name) ? farmRow().bank : 0;
}

// zone() → the farm (tree_farm_ground.farmOf: cells, band, start, gapOf, outsideKeepout) with `origin`, or null before
// the home structure is sited. Read again only when the sited footprints change.
let _zone = null;   // { sig, zone }
function zone() {
  const row = farmRow();
  const { buildingRoomKey, homeBlueprint } = require('@kernel/bot_mandate');
  const { GATHER_KEEPOUT, GATHER_REACH } = require('@thinking/architect_config');
  const boxes = require('@action/find_buildingspot').getExistingFootprints(0);
  const home = boxes.find(b => b.key === buildingRoomKey(homeBlueprint()));
  if (!home) return null;
  const origin = require('@utils/fragment_utils').readTransposeOrigin(homeBlueprint());
  if (!origin) return null;
  const sig = JSON.stringify([boxes, origin, row]);
  if (_zone && _zone.sig === sig) return _zone.zone;
  const z = { ...ground.farmOf({ boxes, home, origin, row, keepout: GATHER_KEEPOUT, reach: GATHER_REACH }), origin };
  _zone = { sig, zone: z };
  return z;
}

const readerOf = (bot) => (x, y, z) => bot.blockAt(new Vec3(x, y, z));

// band(bot, farm) → { full, saturation, open_cells }: the home band as the integrity keeper's `tree_farm` verdict
// keeps it, or, for a body with no foreman, read by this body nearest first until OPEN_LIST open cells are found.
function band(bot, farm) {
  const verdicts = require('@kernel/keeper_verdicts');
  if (verdicts.required()) {
    const v = verdicts.get('tree_farm');
    if (!v || !v.sited) return { full: true, saturation: null, open_cells: [] };
    return { full: v.full, saturation: v.saturation, open_cells: v.open_cells };
  }
  const at = readerOf(bot), y = Math.floor(farm.origin.y);
  const open = [];
  for (const c of farm.band) {
    if (open.length >= OPEN_LIST) break;
    const r = ground.cellState(at, c, y + BAND_SKY, y - BAND_SKY, farm.row.spacing);
    if (r.state === 'open') open.push({ x: c.x, y: r.y, z: c.z, gap: c.gap });
  }
  return { full: open.length === 0, saturation: null, open_cells: open };
}

// groundOf — the y of a column's ground a sapling can stand on, read round the body's feet, or null.
function groundOf(bot, x, z, feetY) {
  const y = ground.groundOf(readerOf(bot), x, z, feetY + SKY_ABOVE, feetY - GROUND_BELOW);
  return y === 'unknown' ? null : y;
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

// plantWhereFelled(bot, felled) — called after each felling ({ position, species }, tree_feller.fell's result). Where
// the tree stood outside the keep-out, the harvester plants one farm sapling: the felled wood's own when it is a farm
// wood and held, else the farm sapling it holds most of. Everything else it carries rides home.
async function plantWhereFelled(bot, felled) {
  const saplings = farmSaplings();
  if (!saplings.length) return { planted: 0, reason: 'no_farm_sapling' };
  const farm = zone();
  if (!farm) return { planted: 0, reason: 'farm_not_sited' };
  const p = felled && felled.position;
  if (!p || !farm.outsideKeepout(p.x, p.z)) return { planted: 0, reason: 'inside_keepout' };
  const own = typeof felled.species === 'string' ? felled.species.replace(/_(log|wood)$/, '_sapling') : null;
  const held = saplings.filter(n => pocketCount(bot, n) > 0).sort((a, b) => pocketCount(bot, b) - pocketCount(bot, a));
  const sapling = held.includes(own) ? own : held[0];
  if (!sapling) return { planted: 0, reason: 'no_sapling_in_pocket' };
  const cells = [{ x: p.x, z: p.z, gap: farm.gapOf(p.x, p.z), ring: 0 }];
  return plantCells(bot, farm, cells, { [sapling]: 1 }, 'felled', Date.now());
}

// plantFarm — the chest job's planting: every farm sapling in the pocket, alternating, into the home band's open cells
// nearest home, until the band reaches its saturation.
async function plantFarm(bot) {
  const saplings = farmSaplings();
  if (!saplings.length) return { planted: 0, reason: 'no_farm_sapling' };
  const farm = zone();
  if (!farm) return { planted: 0, reason: 'farm_not_sited' };
  const quota = Object.fromEntries(saplings.map(n => [n, pocketCount(bot, n)]));
  if (Object.values(quota).every(q => q === 0)) return { planted: 0, reason: 'no_sapling_in_pocket' };
  const startedAt = Date.now();
  const b = band(bot, farm);
  if (b.full) return { planted: 0, reason: 'band_saturated' };
  const cells = b.open_cells.filter(c => !isRefused(keyOfCell(c), startedAt))
    .map(c => ({ x: c.x, z: c.z, gap: c.gap, ring: Math.floor((c.gap - farm.start) / farm.row.ring) }));
  if (!cells.length) return { planted: 0, reason: 'no_open_cell' };
  return plantCells(bot, farm, cells, quota, 'job', startedAt);
}

// plantCells(bot, farm, cells, quota, via, startedAt) — plants up to `quota` of each farm sapling in `cells`, ring by
// ring from ring 0, and says what it did on the PLANTED line.
async function plantCells(bot, farm, cells, quota, via, startedAt) {
  const saplings = farmSaplings();
  const { row } = farm;
  const at = readerOf(bot);
  const held = () => saplings.reduce((n, s) => n + pocketCount(bot, s), 0);
  const heldBefore = held();
  const feetY = Math.floor(bot.entity.position.y);
  const rings = Math.max(...cells.map(c => c.ring));
  const locomotion = require('@locomotion/locomotion_dispatcher');
  const spent = new Set();
  const plantedAt = [];
  const plantedOf = Object.fromEntries(saplings.map(n => [n, 0]));
  let misses = 0, peerHeld = 0, walked = 0, noStand = 0, nearLava = 0, nearWater = 0, reason = null;
  // A cell no body can plant is refused for REFUSAL_MS; a cell this planting walked to is passed for the planting.
  const pass = (c) => { spent.add(keyOfCell(c)); refuse(keyOfCell(c), Date.now()); return true; };
  // A cell this body cannot use is passed before any claim is asked for, and its ground is read then.
  const unusable = (c) => {
    if (spent.has(keyOfCell(c))) return true;
    const groundY = groundOf(bot, c.x, c.z, feetY);
    if (groundY === null || ground.crowded(at, c.x, groundY, c.z, row.spacing)) return pass(c);
    const fluid = ground.nearFluid(at, c.x, groundY, c.z);
    if (fluid) { if (fluid === 'lava') nearLava++; else nearWater++; return pass(c); }
    c.y = groundY + 1;
    // A cell no body can stand beside is passed like a cell with no ground: no claim and no walk.
    c.stand = standBeside(bot, c);
    if (!c.stand) { noStand++; return pass(c); }
    return false;
  };
  const approach = async (c) => {
    spent.add(keyOfCell(c));   // one walk at a cell per planting, reached or not
    const stand = c.stand;
    const from = bot.entity.position.clone();
    const nav = await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true, leg: 'work' });
    walked += Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z);
    if (!(nav && nav.arrived)) refuse(keyOfCell(c), Date.now());
    return { ok: !!(nav && nav.arrived), reason: 'path_failed' };
  };
  // The sapling planted next: the one with the most of its share still to plant, the primary on a tie.
  const nextSapling = () => saplings.filter(n => quota[n] > 0 && pocketCount(bot, n) > 0)
    .sort((a, b) => quota[b] - quota[a])[0] || null;
  let ring = 0;
  while (ring <= rings) {
    const sapling = nextSapling();
    if (!sapling) break;
    if (misses >= MISS_LIMIT) { reason = 'cells_unreachable'; break; }
    // Inside the ring, nearest the yard first, and among cells as near, nearest the body. The cell is claimed
    // before the walk, so one body walks to it and plants it (Invariant A).
    const here = bot.entity.position;
    const order = cells.filter(c => c.ring === ring && !spent.has(keyOfCell(c)))
      .sort((p, q) => (p.gap - q.gap)
        || (((p.x - here.x) ** 2 + (p.z - here.z) ** 2) - ((q.x - here.x) ** 2 + (q.z - here.z) ** 2)));
    const walk = await claimFirst(order, { keyOf: keyOfCell, skip: unusable, approach, maxUnreachable: MISS_LIMIT - misses });
    for (const key of walk.peerHeldKeys) spent.add(key);
    peerHeld += walk.peerHeld;
    misses += walk.unreachable;
    if (!walk.pick) { ring++; continue; }   // this ring holds no open cell: the next ring out
    spent.add(walk.key);
    const pick = new Vec3(walk.pick.x, walk.pick.y, walk.pick.z);

    // The cell is read again on arrival (Invariant B): the ground it was chosen for may have changed during the walk.
    const under = bot.blockAt(pick.offset(0, -1, 0));
    const inCell = bot.blockAt(pick);
    const open = under && PLANTABLE.has(under.name) && !ground.crowded(at, pick.x, pick.y - 1, pick.z, row.spacing)
      && (!inCell || !TUFT.test(inCell.name) || await performDig(bot, pick, inCell, TAG));
    if (open) {
      const place = await performPlace(bot, pick, under, new Vec3(0, 1, 0), sapling, TAG);
      const after = bot.blockAt(pick);
      if (after && after.name === sapling) { plantedAt.push(`${pick.x},${pick.y},${pick.z}`); quota[sapling]--; plantedOf[sapling]++; }
      else { misses++; refuse(walk.key, Date.now()); watcher.warn(TAG, `PLANT_MISSED cell=(${pick.x},${pick.y},${pick.z}) sapling=${sapling} reason=${place.reason || 'the cell does not hold the sapling'}`); }
    }
    releaseTarget(walk.keys);
  }
  if (reason === null && nextSapling()) reason = 'no_open_cell';

  const split = saplings.map(n => `${n}:${plantedOf[n]}`).join(',');
  const of = Object.values(quota).reduce((n, q) => n + q, 0) + plantedAt.length;
  watcher.summary(TAG, `${via} PLANTED n=${plantedAt.length} of=${of} sapling=${split} pocket=${held()} held_before=${heldBefore} grid_cells_in_reach=${cells.length} peer_held=${peerHeld} misses=${misses} no_stand=${noStand} near_lava=${nearLava} near_water=${nearWater} walk=${Math.round(walked)} ms=${Date.now() - startedAt} stopped=${reason || 'limit'}${plantedAt.length ? ` cells=${plantedAt.join(' ')}` : ''}`);
  return { planted: plantedAt.length, reason };
}

// openCell(bot, farm) → the home band's open cell nearest home that this body has not refused, or null while the band
// is at its saturation (band).
function openCell(bot, farm) {
  const b = band(bot, farm);
  if (b.full) return null;
  const now = Date.now();
  return b.open_cells.find(c => !isRefused(keyOfCell(c), now)) || null;
}

// farmStand(bot, farm) → the open cell nearest home, where the chest job walks before it plants (a cell's ground is
// read round the body's feet), or null when the band has none.
function farmStand(bot, farm) {
  const c = openCell(bot, farm);
  return c ? { x: c.x, y: c.y, z: c.z } : null;
}

// plantingTrip(banked) → [{ name, count }] the chest job takes out: up to `batch` farm saplings, the two woods in turn
// so neither runs ahead, of what the chests hold (`banked`, name → count).
function plantingTrip(banked) {
  const row = farmRow();
  const take = Object.fromEntries(farmSaplings().map(n => [n, 0]));
  let left = row.batch;
  for (let added = true; left > 0 && added;) {
    added = false;
    for (const n of Object.keys(take)) {
      if (left > 0 && take[n] < (banked[n] || 0)) { take[n]++; left--; added = true; }
    }
  }
  return Object.entries(take).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }));
}

module.exports = { plantWhereFelled, plantFarm, openCell, farmStand, plantingTrip, farmSaplings, pocketRow, bankKept, zone, TAG };
