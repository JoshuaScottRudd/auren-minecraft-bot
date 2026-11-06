// perception node: farmland_site
// purpose: Locate the locked farm site's world-space cells — the (optional) water source and every 'dirt'
//          group-token farmable row — for farm_executor's
//          clear/till/plant/harvest phases (and the farm_manager / job_board tend-gate via
//          getFarmState) to read fresh on every call (Law 2 self-containment: no phase may
//          assume a prior one already sensed this). Pure read, no side effects (Law 1
//          perception exception — action fragments may call this directly).
// WHY here and not duplicated per-phase (Law 16): every farming phase needs the
//   IDENTICAL cell list, transposed the IDENTICAL way. Reuses
//   blueprint_survey.transposeVoxelsForCandidate against the site's locked
//   transpose_origin instead of a second voxel-transpose implementation.
// invariants:
//  - Throws (Law 13 coding violation) if the farmland site hasn't been locked yet —
//    a farming verb dispatched before set_buildspot ran is a planning bug, not a
//    world condition.

const { Vec3 } = require('vec3');
const hq   = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
const { transposeVoxelsForCandidate } = require('@perception/blueprint_survey');
const { group_to_item, getWheatAge } = require('@utils/fragment_utils');

// The station_registry's chest-key shape, reused so a voxel position has ONE spelling here.
const slotKey = (x, y, z) => `${x}|${y}|${z}`;

function loadBuilding(blueprintName) {
  return blueprintRegistry.getBuilding(blueprintName, 'farmland_site');
}

// ── THE CROPS A FIELD IS PLANTED WITH ── The blueprint's `crop` names one; a blueprint naming none is wheat, and one
// naming 'none' (the water pool) grows nothing: it has no seed and no crop slot.
//   seed    the item planted, ordered and kept in the pocket for a planting visit
//   block   the crop's block in the slot
//   tilled  whether the ground is hoed to farmland first (wheat) or planted as it lies (sugar cane on dirt or sand
//           beside water)
// Wheat is ripe at age 7 and cut whole, the seed replanted. Sugar cane is ripe once two tall and cut from the second
// block up, so the bottom block stays and grows again. THE LAST CUT (CANE_LAST_CUT): once the cane standing and held
// reaches the build's need (calculators/ingredient_keep caneHold), every cane field but the first (FARM_FIELD.cane) is
// cut to the ground, its bottom blocks too, and nothing is planted in it; the first keeps its bottom blocks to grow
// again.
const CROPS = Object.freeze({
  wheat:      Object.freeze({ name: 'wheat', seed: 'wheat_seeds', block: 'wheat', tilled: true }),
  sugar_cane: Object.freeze({ name: 'sugar_cane', seed: 'sugar_cane', block: 'sugar_cane', tilled: false }),
  none:       Object.freeze({ name: 'none', seed: null, block: null, tilled: false }),
});
const CANE_LAST_CUT = Object.freeze({ ...CROPS.sugar_cane, last_cut: true });

// lastCut(roomKey, crop) → true for a cane field other than the first once the build's cane is all grown.
function lastCut(roomKey, crop) {
  if (crop !== CROPS.sugar_cane || roomKey === require('@thinking/architect_config').FARM_FIELD.cane) return false;
  return require('@utils/calculators/ingredient_keep').caneHold().reached;
}
// The ground sugar cane stands on, besides the dirt family.
const CANE_SOIL = new Set(['sand', 'red_sand', 'suspicious_sand']);
// isCaneSoil(name) → whether sugar cane stands on a block of this name: the dirt family or CANE_SOIL.
const isCaneSoil = name => !!name && (group_to_item.dirt.includes(name) || CANE_SOIL.has(name));
function cropOf(blueprintName) {
  const name = loadBuilding(blueprintName).crop || 'wheat';
  if (!CROPS[name]) {
    throw new Error(`[farmland_site] CODING VIOLATION (Law 13): blueprint '${blueprintName}' names the crop '${name}', which CROPS does not know. Known: ${Object.keys(CROPS).join(', ')}.`);
  }
  return CROPS[name];
}

// getFarmlandCells(bot, roomKey) -> { waterCell: {x,y,z}, rowCells: [{x,y,z}], growingSlots: Set<"x|y|z"> }
// rowCells are the GROUND 'dirt' voxels under a 'growing' voxel (the y that the blueprint tills), in whatever
// state they're currently in (dirt/grass pre-till, farmland post-till) — callers decide
// what to do from the live world block, this node only locates the cells. The crop grows
// one block ABOVE each rowCell, marked in the blueprint with voxel type 'growing' (not
// 'dirt'); rowCells stays dirt-only, so the stacked crop layer never doubles a cell.
//
// growingSlots is the SET of those crop-slot positions, returned so the 'clear' action can prove
// a block it is about to dig sits in a blueprint-declared crop slot and therefore can never be
// structure. The same set decides which dirt IS a row cell (dirt with no slot above it is a
// walkway), so 'clear' and 'till' can never reach a cell the blueprint does not crop.
// roomKey is the field's conference-room key (architect_config.FARM_FIELD keys). WHICH geometry it uses is read
// from the locked chair (see below), NOT from a module const.
function getFarmlandCells(bot, roomKey) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farmland_site] CODING VIOLATION: bot must be initialized before getFarmlandCells().');
  }
  if (typeof roomKey !== 'string' || !roomKey) {
    throw new Error(`[farmland_site] CODING VIOLATION (Law 13): getFarmlandCells needs the field's room key, got ${JSON.stringify(roomKey)}.`);
  }
  const setBuildspot = hq.readBuildingChair(roomKey, 'set_buildspot');
  if (!setBuildspot?.transpose_origin || typeof setBuildspot.transpose_origin.x !== 'number') {
    throw new Error(`[farmland_site] CODING VIOLATION: No locked transpose_origin for farm instance "${roomKey}". set_buildspot must run before any farming verb.`);
  }
  // WHICH blueprint geometry this instance is — read from the blueprint_paster chair set_buildspot stamped
  // when it locks the site. The stamped blueprint owns the row's direction; a missing stamp
  // throws before farming can select cells against guessed geometry (Law 13).
  const paster = hq.readBuildingChair(roomKey, 'blueprint_paster');
  const blueprintName = paster?.building_name;
  if (!blueprintName) {
    throw new Error(`[farmland_site] CODING VIOLATION (Law 13): farm instance "${roomKey}" has a locked transpose_origin but no blueprint_paster.building_name, so which direction its row reaches is unknown. site_chairs stamps both together.`);
  }
  const cells = fieldCellsAt(blueprintName, setBuildspot.transpose_origin);
  return lastCut(roomKey, cells.crop) ? { ...cells, crop: CANE_LAST_CUT } : cells;
}

// fieldCellsAt(blueprintName, origin) → the same cells for the field `blueprintName` locked at `origin`: the one
// layout a body reads off its chairs (getFarmlandCells) and the integrity keeper reads off its plans.
function fieldCellsAt(blueprintName, origin) {
  const building = loadBuilding(blueprintName);

  const voxels = transposeVoxelsForCandidate(building, origin);

  let waterCell = null;
  const waterCells = [];
  const dirtCells = [];
  const growingSlots = new Set();
  for (const v of voxels) {
    if (v.type === 'water') { waterCell = { x: v.x, y: v.y, z: v.z }; waterCells.push(waterCell); }
    else if (v.type === 'dirt') dirtCells.push({ x: v.x, y: v.y, z: v.z });
    else if (v.type === 'growing') growingSlots.add(slotKey(v.x, v.y, v.z));
  }
  // A ROW CELL IS DIRT WITH A CROP SLOT ON IT. Not every dirt voxel is one: dirt with air above is a walkway, and
  // tilling it would turn the walkway into farmland. The crop slot is what makes soil a field cell, so that is what is read.
  const rowCells = dirtCells.filter(c => growingSlots.has(slotKey(c.x, c.y + 1, c.z)));
  // waterCell is the blueprint's declared water voxel (a source the builder places by bucket), or null for a blueprint
  // that declares none. waterCells is every water voxel (a channel declares several).
  return { waterCell, waterCells, rowCells, growingSlots, crop: cropOf(blueprintName) };
}

// classifyCell(bot, c, growingSlots) -> the live state of one row cell plus the corrective FIELD
// actions it needs to reach {farmland ground, wheat crop}. Ground-BLOCK repair (stone→dirt) is
// deliberately absent: the row is a declared 'dirt' voxel, so the survey's structural pass owns
// laying it (Law 16). The field owns only the transitions a dig/place diff cannot express — clear
// an obstructed crop slot, hoe dirt→farmland, sow air→wheat, reap mature. One classifier so census
// and executor never diverge.
//
// WHY 'clear' exists. The crop slot is a blueprint 'growing' voxel, declared external, so
// blueprint_survey never places it, digs it, or compares it — nothing else owns what sits there.
// Minecraft refuses to hoe dirt under a non-air block, so any obstruction would deadlock its cell
// permanently: a lone 'till' the hoe always refuses, the executor counts the refusal as a success, and
// five identical no-ops trip the Law 13 five-identical-outcomes halt.
//
// WHY the obstruction test is `age === null` and not `aname !== 'wheat'`: getWheatAge is the single
// owner of whether this is our crop and what stage it is, name-checked at source, so a carrot at age 7
// never passes as ripe wheat here. The extra `aname !== 'wheat'` guard on the dig is redundant belt and
// braces: a wheat block whose age is unreadable must never be dug as an obstruction — never clearing our
// own crop is worth one extra string compare.
function classifyCell(bot, c, growingSlots, crop = CROPS.wheat) {
  const ground = bot.blockAt(new Vec3(c.x, c.y, c.z));
  const above  = bot.blockAt(new Vec3(c.x, c.y + 1, c.z));
  const gname = ground && ground.name;
  const aname = above && above.name;
  if (!crop.tilled) return classifyPlantedCell(bot, c, growingSlots, crop, gname, aname);

  const age    = getWheatAge(above);          // null unless this IS wheat with a readable stage
  const mature = age === 7;
  const slotClear = !aname || aname === 'air';
  // An obstruction: something real in the crop slot that is not our wheat. Gated on the blueprint
  // declaring this position a crop slot, so 'clear' can never reach a fence or a floor block.
  const obstructed = !slotClear && age === null && aname !== 'wheat'
                     && growingSlots.has(slotKey(c.x, c.y + 1, c.z));

  const actions = [];
  if (obstructed) actions.push('clear');       // first: everything below needs the slot empty
  if (gname === 'farmland') {
    if (mature) actions.push('harvest');
    else if (slotClear) actions.push('plant');
  } else if (gname && group_to_item.dirt.includes(gname)) {
    actions.push('till');
    if (slotClear) actions.push('plant');      // same pass: fresh-sense reads farmland
  }
  // A cell that was obstructed gets its 'plant' from the NEXT restricted pass, which re-senses
  // (Invariant B) and finds farmland under an empty slot — the same way harvest hands off to replant.
  return { gname, aname, age, mature, obstructed, actions };
}

// A crop planted on the ground as it lies (sugar cane): the slot holds the crop once planted, and it is ripe once the
// block over the slot is the crop too. `planted` is that the slot holds it; `age` stays null (no stage to read).
// Under THE LAST CUT every planted cell is ripe and an empty one is left empty.
function classifyPlantedCell(bot, c, growingSlots, crop, gname, aname) {
  const planted = aname === crop.block;
  const mature = planted && (crop.last_cut || bot.blockAt(new Vec3(c.x, c.y + 2, c.z))?.name === crop.block);
  const slotClear = !aname || aname === 'air';
  const obstructed = !slotClear && !planted && growingSlots.has(slotKey(c.x, c.y + 1, c.z));
  const soil = isCaneSoil(gname);
  const actions = [];
  if (obstructed) actions.push('clear');
  if (mature) actions.push('harvest');
  else if (slotClear && soil && !crop.last_cut) actions.push('plant');
  return { gname, aname, age: null, mature, planted, obstructed, soil, actions };
}

// getFarmState(bot, roomKey) -> census the job_board tend-gate and farm_manager routing read (Law 16 — the
// executor reads getFieldPlan off the SAME classifier). Harvest selects ripe cells independently
// of the rest of the field.
//
// `blocked` is a SEPARATE axis, not a fifth bucket: an obstructed cell is still counted as untilled
// or emptyTilled by its ground state, and blocked says the crop slot above it is stoppered. It is
// reported because a buried field is otherwise invisible in the digest (Law 6): the same untilled count
// can mean an open field or one entirely blocked by rock, and only the blocked count distinguishes them.
// A crop planted as the ground lies counts an unplanted cell as `emptyTilled` (ready for its seed) and never as
// untilled; `seed` and `tilled` name the crop's item and whether a hoe is wanted.
// THE CENSUS IS THE KEEPER'S. A body with a foreman reads the field's census off the integrity keeper's `fields`
// verdict (foreman/integrity_keeper_worker), one reading for the whole crew; a body without one counts it itself.
function getFarmState(bot, roomKey) {
  // The keeper counts every field by its own crop; a field under THE LAST CUT is counted here, by the last cut.
  const cells = getFarmlandCells(bot, roomKey);
  const kept = cells.crop.last_cut ? null : require('@kernel/keeper_verdicts').keptEntry('fields', roomKey);
  if (kept) return { ...kept.census };
  return censusAt(bot, cells);
}

// censusAt(world, cells) → the census of the field `cells` (getFarmlandCells / fieldCellsAt) as `world`
// ({ blockAt }) holds it. `standing` counts the blocks of a crop planted as the ground lies (sugar cane) standing in its
// slots, every block of every stalk: the cane the field holds (calculators/ingredient_keep, THE CANE HOLD).
function censusAt(world, { rowCells, growingSlots, crop }) {
  const bot = world;
  let untilled = 0, emptyTilled = 0, growing = 0, mature = 0, blocked = 0, standing = 0;
  for (const c of rowCells) {
    const cell = classifyCell(bot, c, growingSlots, crop);
    const { gname, age, mature: m, obstructed } = cell;
    if (obstructed) blocked++;
    if (!crop.tilled) {
      for (let y = c.y + 1; crop.block && bot.blockAt(new Vec3(c.x, y, c.z))?.name === crop.block; y++) standing++;
      if (m) mature++;
      else if (cell.planted) growing++;
      else if (cell.soil && !crop.last_cut) emptyTilled++;
    } else if (gname === 'farmland') {
      if (m) mature++;
      else if (age !== null) growing++;     // wheat with a readable stage — never a look-alike crop
      else emptyTilled++;
    } else if (gname && group_to_item.dirt.includes(gname)) {
      untilled++;
    }
  }
  const total = rowCells.length;
  const needsPrep = untilled > 0 || emptyTilled > 0 || blocked > 0;
  const harvestReady = mature > 0;
  return { total, untilled, emptyTilled, growing, mature, blocked, standing, needsPrep, harvestReady,
           actionable: needsPrep || harvestReady, seed: crop.seed, tilled: crop.tilled };
}

// getFieldPlan(bot, roomKey) -> per-cell corrective plans the executor applies from a reaching anchor. Every
// cell whose crop slot is obstructed yields a 'clear', so a stray block never sits unaddressed in a
// slot no fragment owns.
function getFieldPlan(bot, roomKey) {
  const { rowCells, growingSlots, crop } = getFarmlandCells(bot, roomKey);
  const plan = [];
  for (const c of rowCells) {
    const { actions } = classifyCell(bot, c, growingSlots, crop);
    if (actions.length) plan.push({ x: c.x, y: c.y, z: c.z, actions, crop });
  }
  return plan;
}

module.exports = { getFarmlandCells, fieldCellsAt, getFarmState, censusAt, getFieldPlan, cropOf, isCaneSoil, CROPS };
