// perception node: building_integrity
// purpose: The BUILDINGS wrapper over the neutral blueprint_survey engine. It scans a named building
//          for structural discrepancies (via survey) and layers on the building-specific reading:
//          craft-material aggregation (what blocks/logs the remaining place steps still need), the
//          per-anchor status breakdown, and the boxed-in-footprint troubleshooting log. The transpose
//          and voxel-diff machinery lives in blueprint_survey, domain-neutral so farming can reuse the
//          same scan. Geometry helpers are re-exported from here so this stays the buildings-facing
//          surface its callers already import (build_executor, preconstruction, mining_blueprinter,
//          navigator, torch, etc.).
// interface: scan(bot, blueprintName) → { schema, building_name, stats, all_complete, steps, summary, materials_needed, materials_missing, anchor_status, footprint }
// called by: build_executor (before each build pass), building_planner (structure completion)
// WHY: Pure observation. Materials aggregation is a building concern (crafting/inventory), so it lives
//      here, not in the neutral survey — a farm reads the same survey but gates on seeds, not blocks.

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const blueprintSurvey = require('@perception/blueprint_survey');

// Plain require: the calculator is ours and always present, and the guard that stood here would have
// left countInInventory undefined — a TypeError far from the cause, masking a missing module as a bad
// call site (Law 13, and Law 16: it also hid the module from pass 1).
const { countInInventory } = require('@utils/calculators/inventory_calculator');

// Memory-primary: last scan result stored here for getState() inspection. Callers get the result
// from scan()'s return value; the HQ conference-room chair gets the summary (Law 6).
let _lastScan = null;

// ============================================================
// Materials aggregation for the first incomplete pass (building presentation)
// ============================================================
// WHY: building_planner/crafting_planner need "what does this build still need, and how much do I
// already have" without re-scanning. building_integrity already produces the place-step list, so it
// is the natural owner (Law 6). This is the BUILDING reading of a survey — a farm reads the same
// steps but converts them to seeds/logs itself.

// Blocks that occupy multiple voxels per single item placed (placing a door item creates both halves).
// Without the divisor the material gate demands twice the items. Placement needs no matching rule —
// placeOne re-senses the cell (Invariant B) and returns 'already' when the game's auto-created second
// half is standing there.
const VOXELS_PER_ITEM = { door: 2 };

// Counts how many of each item/group token the 'place' steps require.
function aggregateMaterialsNeeded(steps) {
  const needed = {};
  for (const s of steps) {
    if (s.action !== 'place') continue;
    needed[s.type] = (needed[s.type] || 0) + 1;
  }
  for (const [type, vpi] of Object.entries(VOXELS_PER_ITEM)) {
    if (needed[type]) needed[type] = Math.ceil(needed[type] / vpi);
  }
  return needed;
}

// ── THE LOWEST COURSE THAT STILL OWES BLOCKS ─────────────────────────────────
// Finds the lowest anchor Y level that can still be built.
//
// A course, not the whole anchor: a build can stack one block type directly on another (a furnace on a
// barrel), so an anchor whose lower blocks are unaffordable and whose upper blocks are not hands back a
// load of blocks with nothing under them — every one unplaceable. Restricting the affordable question to
// the lowest Y that still owes blocks makes support a settled fact: the course beneath is finished, or
// this is not the lowest course (Law 27). Within the course, anything buildable is unchanged.
//
// It bounds the BUILD only. The shortfall ORDER stays the whole anchor's: fetching one course at a time
// would cost a round trip per layer, and order is not what places a block.
function lowestUnbuiltY(placeSteps) {
  let low = null;
  for (const s of placeSteps) {
    if (s.action !== 'place') continue;
    const y = s.place?.y;
    if (typeof y !== 'number') continue;
    if (low === null || y < low) low = y;
  }
  return low;
}

// ── THE CELLS THAT COULD BE PLACED RIGHT NOW, AND THE ORDER THEY ARE HANDED OUT IN ──────────────────
// On a pledge-worthy blueprint, a block can be placed once the cell directly below it is placed — it
// need not wait for the whole row beneath it to finish.
//
// More precise than `lowestUnbuiltY` above: a course is a conservative approximation of the per-cell
// support fact, right about every cell it admits and wrong about every cell one layer up whose own
// support is already standing. On a twelve-barrel yard that is the difference between twelve cells open
// and twenty-four — the difference between twelve bodies working and twelve waiting.
//
// The test is whether the cell below is still owed, not whether it is solid: a voxel the survey did not
// raise a place step for is either already correct or not part of the plan, and both mean the support is
// there. Asking the steps keeps one answer (Law 16) and costs no block reads.
//
// Ordered lowest Y first, then the plan's own voxel order within a layer. Bodies claim off the front of
// this list, so two bodies arriving at once take adjacent cells, not scattering across the site; the
// claim arbitration is the foreman's `cell:` lock, and this list is only what they walk in.
//
// It is the set, not a count: three callers need three different cuts of it and each must be the same
// set — the board sizes its seats by the LENGTH, the manager stages the MATERIALS for it, and the
// executor claims and places the STEPS in it.
function placeableNow(placeSteps) {
  const owed = new Set();
  for (const s of placeSteps) {
    if (s.action !== 'place' || !s.place) continue;
    owed.add(`${s.place.x},${s.place.y},${s.place.z}`);
  }
  return placeSteps
    .filter(s => s.action === 'place' && s.place && !owed.has(`${s.place.x},${s.place.y - 1},${s.place.z}`))
    .sort((a, b) => a.place.y - b.place.y);
}

// Flattens the bot's current inventory into { itemName: count }.
function aggregateInventory(bot) {
  const counts = {};
  for (const item of bot.inventory.items()) {
    counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return counts;
}

// Diffs materials_needed against inventory. Group tokens (planks/stairs/logs) sum their concrete
// members; concrete tokens match by exact name. Only items actually short appear in the result.
function computeMaterialsMissing(needed, invCounts) {
  const missing = {};
  for (const [type, count] of Object.entries(needed)) {
    const have = countInInventory(type, invCounts);
    const short = count - have;
    if (short > 0) missing[type] = short;
  }
  return missing;
}

// scan — the buildings verdict. Delegates the structural diff to blueprint_survey.survey, then adds
// the craft-material aggregation, per-anchor status, HQ chair post, and troubleshooting log that only
// buildings care about. Return shape is unchanged from before the survey split (callers untouched).
// ── progressSplit — WHAT THE FLEET ACTUALLY STOOD UP, SEPARATED FROM WHAT THE GROUND ALREADY GAVE ──
// Three unlike things live in a blueprint's voxel list and only one of them is carpentry:
//   air    — the cleared site already provides it; nothing is ever placed here
//   base   — a GROUND_FILL voxel a chosen-flat lot satisfies with its own dirt or grass, untouched
//   struct — a block the fleet has to manufacture, carry and place. THIS is build progress.
//
// The ground set is read from `fragment_utils`, the one place it is defined (Law 16); a second list kept
// here could drift from the group table it would duplicate.
//
// An unsensed cell is not a placed one. "Placed" is inferred from the absence of a place step, and an
// unloaded chunk produces no step either, so progress may never be inferred from silence: an unsensed
// voxel counts against the total and toward nothing, and this number can only ever understate.
//
// A complete build has no step list — `result` is null — and every struct voxel is therefore placed.
function progressSplit(voxels, result) {
  const GROUND_FILL_TYPES = require('@utils/fragment_utils').GROUND_FILL_VOXEL_TYPES;
  const pendingPlace = new Set();
  for (const st of (result?.steps || [])) {
    if (st.action === 'place') pendingPlace.add(`${st.place.x},${st.place.y},${st.place.z}`);
  }
  const unsensed = new Set((result?.stats?.unloaded_cells || []).map(c => `${c.x},${c.y},${c.z}`));
  let airCells = 0, baseCells = 0, structTotal = 0, structPlaced = 0;
  for (const v of (voxels || [])) {
    const key = `${v.x},${v.y},${v.z}`;
    if (v.type === 'air') { airCells++; continue; }
    const pending = pendingPlace.has(key);
    if (GROUND_FILL_TYPES.has(v.type) && !pending && !unsensed.has(key)) { baseCells++; continue; }
    structTotal++;
    if (!pending && !unsensed.has(key)) structPlaced++;
  }
  return {
    structPlaced, structTotal,
    airCells, baseCells,
    noWorkCells: airCells + baseCells,
    voxelsTotal: airCells + baseCells + structTotal,
  };
}

async function scan(bot, blueprintName, conferenceRoomKey, opts) {
  const pace = require('@utils/execution_yield').makeExecutionPacer();
  conferenceRoomKey = conferenceRoomKey || blueprintName;

  const s = await blueprintSurvey.survey(bot, blueprintName, conferenceRoomKey, opts);
  const voxels     = s.voxels;
  const footprint  = s.footprint;
  const transposeOrigin = s.transpose_origin;
  const anchorCount = s.anchor_count;
  const scanMs     = s.scan_duration_ms;
  const result     = s.all_complete ? null : { steps: s.steps, stats: s.stats, summary: s.summary };

  const invCounts        = aggregateInventory(bot);
  const materialsNeeded  = result ? aggregateMaterialsNeeded(result.steps) : {};
  const materialsMissing = result ? computeMaterialsMissing(materialsNeeded, invCounts) : {};

  // Per-anchor breakdown. anchor_index is already stamped on every step, so this is pure aggregation —
  // one entry per blueprint anchor. PERCEPTION ONLY: it reports raw per-anchor needs; it does NOT judge
  // which materials are "optional" or which anchor is "next" (a planning decision owned by job_board).
  const anchorStatus = [];
  if (result && anchorCount > 0) {
    const unloadedCells = result.stats.unloaded_cells || [];
    for (let ai = 0; ai < anchorCount; ai++) {
      await pace();
      const placeSteps = result.steps.filter(st => st.action === 'place' && (st.anchor_index ?? -1) === ai);
      const digCount   = result.steps.filter(st => st.action === 'dig'   && (st.anchor_index ?? -1) === ai).length;
      // Unsensed is not done. An anchor in an unloaded chunk produces no steps, so a consumer that asks
      // whether this anchor still owes work by counting steps gets a silent no, and a next-anchor search
      // could read a no-work anchor as finished. Carrying the count per anchor lets consumers distinguish
      // nothing left to build from never looked (Law 23: verified, or it is not a fact).
      const unloadedCount = unloadedCells.filter(c => (c.anchor_index ?? -1) === ai).length;
      const mNeeded    = aggregateMaterialsNeeded(placeSteps);
      // The same bill, cut to the lowest course that still owes blocks (see lowestUnbuiltY). `null` when
      // the anchor owes no placements at all, which is a different answer from "an empty course".
      const lowY       = lowestUnbuiltY(placeSteps);
      const mNeededLow = lowY === null ? {} : aggregateMaterialsNeeded(placeSteps.filter(s => s.place?.y === lowY));
      // The per-cell cut of the same bill, for a pledge-approved plan (see placeableNow). Carried beside
      // the coursed one, not replacing it: which cut a caller reads is decided by the blueprint's label,
      // and a plan without the label keeps reading exactly what it read before.
      const placeable   = placeableNow(placeSteps);
      const mNeededPlaceable = aggregateMaterialsNeeded(placeable);
      // Anchor world location = centroid of its solid voxels (stable regardless of remaining work),
      // so the trace shows WHERE each anchor sits — the datum for spotting a boxed-in bot.
      const av = voxels.filter(v => (v.anchor_index ?? -1) === ai && v.type !== 'air');
      const location = av.length
        ? { x: Math.round(av.reduce((sum, v) => sum + v.x, 0) / av.length),
            y: Math.round(av.reduce((sum, v) => sum + v.y, 0) / av.length),
            z: Math.round(av.reduce((sum, v) => sum + v.z, 0) / av.length) }
        : null;
      anchorStatus.push({
        anchor_index:      ai,
        location,
        place_count:       placeSteps.length,
        dig_count:         digCount,
        unloaded_count:    unloadedCount,
        materials_needed:  mNeeded,
        materials_missing: computeMaterialsMissing(mNeeded, invCounts),
        lowest_unbuilt_y:  lowY,
        materials_needed_lowest_y: mNeededLow,
        placeable_now:     placeable.length,
        placeable_steps:   placeable,
        materials_needed_placeable: mNeededPlaceable,
      });
    }
  }

  // ── THE HONEST PROGRESS SPLIT, COMPUTED ONCE FOR EVERY READER ──────────────────────────────────
  // `stats.correct / stats.expected` is the executor's step math and is correct for that purpose: a
  // voxel needing no action is "correct" because there is no step to take. It is the wrong number to
  // show a person as progress, because it counts a cell the fleet never touched — open air the site
  // already had, and BASE cells a chosen-flat lot satisfies with its own dirt and grass.
  //
  // Computed once here so every reader, including build_executor's own progress line, reads the same
  // split; a number computed inside a log statement would be available to exactly one log statement
  // (Law 16).
  const progress = progressSplit(voxels, result);

  // A structure with any voxel in ground this body has not been sent is UNSEEN: neither built nor owing
  // work. The scan says so in one field, and an unseen scan posts nothing to the shared chair, so a body
  // out of sight of a structure never overwrites what a body beside it saw (Law 23).
  const unseen = !!result && (result.stats.unloaded_cells || []).length > 0;

  const integrityOut = {
    unseen,
    schema:            'auren.building_integrity.v1',
    generated_at:      new Date().toISOString(),
    building_name:     blueprintName,
    scan_duration_ms:  scanMs,
    stats:             result ? result.stats : null,
    progress,
    all_complete:      result === null,
    steps:             result ? result.steps : [],
    summary:           result ? result.summary : 'all voxels match world state',
    materials_needed:  materialsNeeded,
    materials_missing: materialsMissing,
    anchor_status:     anchorStatus,
    footprint,
  };
  _lastScan = integrityOut;

  // Post a summary of what's missing into building_confrence_room at our own chair (Law 6).
  if (!unseen) hq.writeBuildingChair(conferenceRoomKey, 'building_integrity', {
    materials_needed:  materialsNeeded,
    materials_missing: materialsMissing,
    all_complete:      integrityOut.all_complete,
    generated_at:      integrityOut.generated_at,
    writer:            'building_integrity',
  });

  // opts.quiet suppresses the story log — used by build_executor's per-placement rescan where the
  // scan is needed for data but a story line every block is noise.
  if (!opts?.quiet) {
    if (integrityOut.all_complete) {
      watcher.summary('building_integrity', `"${blueprintName}" matches the blueprint — nothing to fix. (scan ${scanMs}ms)`);
    } else {
      const { dig_steps, place_steps, unloaded } = result.stats;
      const unloadedNote = unloaded ? ` — ${unloaded} voxel${unloaded === 1 ? '' : 's'} unsensed (chunk not loaded), scan partial` : '';
      // Display only, from `progress` (see progressSplit above) — result.stats and the returned object
      // are untouched and still drive the executor's own step math.
      const { structPlaced, structTotal, airCells, baseCells, noWorkCells: noWork } = progress;
      watcher.summary('building_integrity', `"${blueprintName}" — ${structPlaced}/${structTotal} structure placed · ${place_steps} to place, ${dig_steps} to dig · ${noWork} no-work cell${noWork === 1 ? '' : 's'} (${airCells} air + ${baseCells} ground already there)${unloadedNote}. (scan ${scanMs}ms)`);
      const yBreakdown = {};
      for (const st of result.steps) {
        const y = st.place.y;
        if (!yBreakdown[y]) yBreakdown[y] = { dig: 0, place: 0 };
        yBreakdown[y][st.action]++;
      }
      const yLine = Object.keys(yBreakdown).sort((a, b) => a - b)
        .map(y => `Y${y}: ${yBreakdown[y].dig} dig ${yBreakdown[y].place} place`)
        .join(' | ');
      watcher.summary('building_integrity', `  ${yLine}`);

      // Troubleshooting line: transpose_origin, bot position, footprint bounds, per-anchor locations.
      // Flags when the bot stands INSIDE the footprint — the boxed-in fingerprint behind place-timeouts.
      if (footprint && bot.entity?.position) {
        const { minX, maxX, minY, maxY, minZ, maxZ } = footprint;
        const bp = bot.entity.position.floored();
        const inside = bp.x >= minX && bp.x <= maxX && bp.z >= minZ && bp.z <= maxZ && bp.y >= minY && bp.y <= maxY + 1;
        watcher.summary('building_integrity',
          `  bot@(${bp.x},${bp.y},${bp.z}) transpose_origin=(${transposeOrigin.x},${transposeOrigin.y},${transposeOrigin.z}) ` +
          `footprint x[${minX}..${maxX}] y[${minY}..${maxY}] z[${minZ}..${maxZ}]` +
          `${inside ? ' — ⚠️ bot is INSIDE the footprint (placement/pathing can box in — relocate out to work)' : ''}`);
        const busy = anchorStatus.filter(a => a.place_count + a.dig_count > 0);
        if (busy.length) {
          const aLine = busy.map(a =>
            `A${a.anchor_index}@(${a.location ? `${a.location.x},${a.location.y},${a.location.z}` : '?'}) ` +
            `[${a.place_count} place, ${a.dig_count} dig]`).join(' | ');
          watcher.summary('building_integrity', `  anchors: ${aLine}`);
        }
      }
    }
  }

  return integrityOut;
}

// Returns the materials needed for a specific set of Y levels within a scan result. build_executor
// pulls one batch's worth of materials from the chest instead of emptying the entire chest.
function materialsForBatch(scanResult, yLevels) {
  if (!scanResult || !Array.isArray(scanResult.steps)) return {};
  const ySet = Array.isArray(yLevels) ? new Set(yLevels) : new Set([yLevels]);
  const batchSteps = scanResult.steps.filter(s => s.action === 'place' && ySet.has(s.place.y));
  return aggregateMaterialsNeeded(batchSteps);
}

// Anchor twin of materialsForBatch: the place-material need for a single anchor. preconstruction uses
// it to prep only the claimed anchor's materials (per-anchor gating).
function materialsForAnchor(scanResult, anchorIndex) {
  if (!scanResult || !Array.isArray(scanResult.steps)) return {};
  const anchorSteps = scanResult.steps.filter(s => s.action === 'place' && (s.anchor_index ?? -1) === anchorIndex);
  return aggregateMaterialsNeeded(anchorSteps);
}

function getState() { return _lastScan; }

// Geometry helpers live in blueprint_survey now (one definition, Law 16). Re-exported here so the
// buildings-facing callers that already import them from building_integrity stay unchanged.
const {
  getWorldAnchors, transposeAttachPoints, transposeVoxelsForCandidate, transposeAnchorsForCandidate,
  getWorldAttachPoints, getProtectedBlocks, getAllProtectedBlocks, getFootprintCells, getAllFootprintCells, collectAllVoxels,
  resolveVoxelAnchor,
} = blueprintSurvey;

module.exports = {
  scan, materialsForBatch, materialsForAnchor, getState,
  getWorldAnchors, transposeAttachPoints, transposeVoxelsForCandidate, transposeAnchorsForCandidate,
  getWorldAttachPoints, getProtectedBlocks, getAllProtectedBlocks, getFootprintCells, getAllFootprintCells, collectAllVoxels,
  resolveVoxelAnchor, placeableNow,
};
