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
//   build_center instead of a second voxel-transpose implementation.
// invariants:
//  - Throws (Law 13 coding violation) if the farmland site hasn't been locked yet —
//    a farming verb dispatched before set_buildspot ran is a planning bug, not a
//    world condition.

const { Vec3 } = require('vec3');
const hq   = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
const { transposeVoxelsForCandidate } = require('@perception/blueprint_survey');
const { group_to_item, getWheatAge } = require('@utils/fragment_utils');
const { FARM_BLUEPRINT_NAME } = require('@thinking/architect_config');

// The station_registry's chest-key shape, reused so a voxel position has ONE spelling here.
const slotKey = (x, y, z) => `${x}|${y}|${z}`;

function loadBuilding(blueprintName) {
  return blueprintRegistry.getBuilding(blueprintName, 'farmland_site');
}

// getFarmlandCells(bot, roomKey) -> { waterCell: {x,y,z}, rowCells: [{x,y,z}], growingSlots: Set<"x|y|z"> }
// rowCells are the GROUND 'dirt' voxels (the y that the blueprint tills), in whatever
// state they're currently in (dirt/grass pre-till, farmland post-till) — callers decide
// what to do from the live world block, this node only locates the cells. The crop grows
// one block ABOVE each rowCell, marked in the blueprint with voxel type 'growing' (not
// 'dirt'); rowCells stays dirt-only, so the stacked crop layer never doubles a cell.
//
// growingSlots is the SET of those crop-slot positions, returned so the 'clear' action can prove
// a block it is about to dig sits in a blueprint-declared crop slot and therefore can never be
// structure. Today the blueprint guarantees the voxel above every 'dirt' cell is
// 'growing' — this set is what keeps that a checked fact rather than an assumption a future
// blueprint edit could silently break, turning 'clear' into a fence-eater.
// roomKey is the farm INSTANCE's conference-room key (32 wheat_plot_pair plots each have a distinct locked
// center). Defaults to the phase-1 blueprint name — instance 0's key and every single-farm caller — so this
// stays backward-compatible. WHICH geometry an instance uses is read per-instance from the locked chair (see
// below), NOT from a module const — so instances of DIFFERENT geometries can coexist under one subsystem.
function getFarmlandCells(bot, roomKey = FARM_BLUEPRINT_NAME) {
  if (!bot || !bot.blockAt) {
    throw new Error('[farmland_site] CODING VIOLATION: bot must be initialized before getFarmlandCells().');
  }
  const setBuildspot = hq.readBuildingChair(roomKey, 'set_buildspot');
  if (!setBuildspot?.build_center || typeof setBuildspot.build_center.x !== 'number') {
    throw new Error(`[farmland_site] CODING VIOLATION: No locked build_center for farm instance "${roomKey}". set_buildspot must run before any farming verb.`);
  }
  // WHICH blueprint geometry this instance is — read from the blueprint_paster chair set_buildspot stamped
  // when it locked the site, so the reader is no longer wired to one farm blueprint. Falls back to the
  // phase-1 default for a chair locked before the per-instance blueprint_name existed.
  const paster = hq.readBuildingChair(roomKey, 'blueprint_paster');
  const blueprintName = paster?.building_name || FARM_BLUEPRINT_NAME;
  const building = loadBuilding(blueprintName);

  const voxels = transposeVoxelsForCandidate(building, setBuildspot.build_center, setBuildspot.rotation || 0);

  let waterCell = null;
  const rowCells = [];
  const growingSlots = new Set();
  for (const v of voxels) {
    if (v.type === 'water') waterCell = { x: v.x, y: v.y, z: v.z };
    else if (v.type === 'dirt') rowCells.push({ x: v.x, y: v.y, z: v.z });
    else if (v.type === 'growing') growingSlots.add(slotKey(v.x, v.y, v.z));
  }
  // waterCell is OPTIONAL. A blueprint MAY declare its own water voxel (a source the builder places by bucket);
  // a wheat_plot_pair plot does NOT — the wheat_plot_scanner only ever sites a plot already adjacent to NATURAL
  // water, so hydration is guaranteed by the siter, not by a declared voxel. Absent water is therefore a valid
  // phase-1 field, not a coding violation: it is returned null and no field phase reads it (grep-confirmed:
  // waterCell has no consumers — the field phases use only rowCells + growingSlots).
  return { waterCell, rowCells, growingSlots };
}

// classifyCell(bot, c, growingSlots) -> the live state of one row cell plus the corrective FIELD
// actions it needs to reach {farmland ground, wheat crop}. Ground-BLOCK repair (stone→dirt) is
// deliberately absent: the row is a declared 'dirt' voxel, so the survey's structural pass owns
// laying it (Law 16). The field owns only the transitions a dig/place diff cannot express — clear
// an obstructed crop slot, hoe dirt→farmland, sow air→wheat, reap mature. One classifier so census
// and executor never diverge.
//
// WHY 'clear' exists. The crop slot is a blueprint 'growing' voxel, and 'growing' is declared
// external — so blueprint_survey never places it, never digs it, and never even COMPARES it.
// Nothing owned what sits there. Minecraft refuses to hoe dirt under a non-air block, so any
// obstruction deadlocked its cell permanently: a lone 'till' the hoe would always refuse, the
// executor counting the refusal as a success, and five identical no-ops tripping the Law 13
// five-identical-outcomes halt. "External" named a SUPPLIER and forgot the case where the slot is
// already occupied.
//
// WHY the obstruction test is `age === null` and not `aname !== 'wheat'`: getWheatAge is the single
// owner of "is this our crop and what stage is it" — it is name-checked at source, so a carrot at
// age 7 can no longer pass as ripe wheat here. The extra `aname !== 'wheat'` guard on the
// dig is deliberate belt-and-braces: a wheat block whose age is somehow unreadable must never be
// dug as an obstruction. Never clearing our own crop is worth one redundant string compare.
function classifyCell(bot, c, growingSlots) {
  const ground = bot.blockAt(new Vec3(c.x, c.y, c.z));
  const above  = bot.blockAt(new Vec3(c.x, c.y + 1, c.z));
  const gname = ground && ground.name;
  const aname = above && above.name;

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

// getFarmState(bot, roomKey) -> census the job_board tend-gate and farm_manager routing read (Law 16 — the
// executor reads getFieldPlan off the SAME classifier). harvestReady fires on ANY mature crop
// (whole-field all-or-nothing removed — harvest whatever's ripe).
//
// `blocked` is a SEPARATE axis, not a fifth bucket: an obstructed cell is still counted as untilled
// or emptyTilled by its ground state, and blocked says the crop slot above it is stoppered. It is
// reported because a buried field is otherwise invisible in the digest (Law 6) — "untilled" alone
// and "untilled, all blocked by rock" are the same count telling different stories, and only one
// of them explains why nothing moves.
function getFarmState(bot, roomKey = FARM_BLUEPRINT_NAME) {
  const { rowCells, growingSlots } = getFarmlandCells(bot, roomKey);
  let untilled = 0, emptyTilled = 0, growing = 0, mature = 0, blocked = 0;
  for (const c of rowCells) {
    const { gname, age, mature: m, obstructed } = classifyCell(bot, c, growingSlots);
    if (obstructed) blocked++;
    if (gname === 'farmland') {
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
  return { total, untilled, emptyTilled, growing, mature, blocked, needsPrep, harvestReady,
           actionable: needsPrep || harvestReady };
}

// getFieldPlan(bot, roomKey) -> per-cell corrective plans the executor applies from a reaching anchor. Every
// cell whose crop slot is obstructed yields a 'clear', so a stray block can no longer sit in a
// slot that no fragment owns.
function getFieldPlan(bot, roomKey = FARM_BLUEPRINT_NAME) {
  const { rowCells, growingSlots } = getFarmlandCells(bot, roomKey);
  const plan = [];
  for (const c of rowCells) {
    const { actions } = classifyCell(bot, c, growingSlots);
    if (actions.length) plan.push({ x: c.x, y: c.y, z: c.z, actions });
  }
  return plan;
}

module.exports = { getFarmlandCells, getFarmState, getFieldPlan };
