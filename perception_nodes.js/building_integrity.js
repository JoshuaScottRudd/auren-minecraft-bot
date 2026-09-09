// perception node: building_integrity
// purpose: The BUILDINGS wrapper over the neutral blueprint_survey engine. It scans a named building
//          for structural discrepancies (via survey) and layers on the building-specific reading:
//          craft-material aggregation (what blocks/logs the remaining place steps still need), the
//          per-anchor status breakdown, and the boxed-in-footprint troubleshooting log. The transpose
//          + voxel-diff machinery it used to own now lives in blueprint_survey (Architect 2026-07-11:
//          once farming reuses the same scan, the engine can't be named for one domain). Geometry
//          helpers are re-exported from here so this stays the buildings-facing surface its callers
//          already import (build_executor, preconstruction, mining_blueprinter, navigator, torch, etc.).
// interface: scan(bot, blueprintName) → { schema, building_name, stats, all_complete, steps, summary, materials_needed, materials_missing, anchor_status, footprint }
// called by: build_executor (before each build pass), building_planner (structure completion)
// WHY: Pure observation. Materials aggregation is a building concern (crafting/inventory), so it lives
//      here, not in the neutral survey — a farm reads the same survey but gates on seeds, not blocks.

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const blueprintSurvey = require('@perception/blueprint_survey');

// Plain require: the calculator is ours and always present, and the guard that stood here would have
// left countInInventory undefined — a TypeError far from the cause, wearing the costume of a bad call
// site rather than a missing module (Law 13, and Law 16: it also hid the module from pass 1).
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
function scan(bot, blueprintName, conferenceRoomKey, opts) {
  conferenceRoomKey = conferenceRoomKey || blueprintName;

  const s = blueprintSurvey.survey(bot, blueprintName, conferenceRoomKey, opts);
  const voxels     = s.voxels;
  const footprint  = s.footprint;
  const buildCenter = s.build_center;
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
      const placeSteps = result.steps.filter(st => st.action === 'place' && (st.anchor_index ?? -1) === ai);
      const digCount   = result.steps.filter(st => st.action === 'dig'   && (st.anchor_index ?? -1) === ai).length;
      // UNSENSED IS NOT DONE (Architect 2026-08-13). An anchor in an unloaded chunk produces no steps, so
      // every consumer that asks "does this anchor still owe work" by counting steps gets a silent NO —
      // and job_board's next-anchor search reads a no-work anchor as finished, which on 2026-08-12 let it
      // walk past a bare site. Carrying the count per anchor is what lets those consumers distinguish
      // "nothing left to build" from "never looked" (Law 23: verified, or it is not a fact).
      const unloadedCount = unloadedCells.filter(c => (c.anchor_index ?? -1) === ai).length;
      const mNeeded    = aggregateMaterialsNeeded(placeSteps);
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
      });
    }
  }

  const integrityOut = {
    schema:            'auren.building_integrity.v1',
    generated_at:      new Date().toISOString(),
    building_name:     blueprintName,
    scan_duration_ms:  scanMs,
    stats:             result ? result.stats : null,
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
  hq.writeBuildingChair(conferenceRoomKey, 'building_integrity', {
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
      // "voxels correct" conflated three unlike things: manufactured blocks the bot actually stood up,
      // open AIR the clear site already provides, and BASE cells a chosen-flat lot satisfies with its own
      // dirt/grass (structural_fill is ground-inclusive). Counting air + base as "correct" made a
      // never-touched site read ~half-built. Split them: structure-placed is the honest build-progress
      // number; air + base are no-work cells that were never carpentry. Display only — result.stats and
      // the returned object are untouched (they still drive the executor's step math, which is correct).
      const GROUND_FILL_TYPES = new Set(['structural_fill', 'dirt']); // satisfied by a flat lot's own ground
      const pendingPlace = new Set();
      for (const st of result.steps) if (st.action === 'place') pendingPlace.add(`${st.place.x},${st.place.y},${st.place.z}`);
      // AN UNSENSED CELL IS NOT A PLACED ONE (Architect 2026-08-13). "Placed" was inferred from the
      // ABSENCE of a place step, and an unloaded chunk produces no step either — so a scan taken 158
      // blocks from a bare site read "26/167 structure placed" on 2026-08-12 and nearly went into the
      // record as the moment the build started. Progress may never be inferred from silence: an unsensed
      // voxel counts against the total and toward nothing, so this number can only ever understate.
      const unsensed = new Set((result.stats.unloaded_cells || []).map(c => `${c.x},${c.y},${c.z}`));
      let airCells = 0, baseCells = 0, structTotal = 0, structPlaced = 0;
      for (const v of voxels) {
        const key = `${v.x},${v.y},${v.z}`;
        if (v.type === 'air') { airCells++; continue; }
        const pending = pendingPlace.has(key);
        if (GROUND_FILL_TYPES.has(v.type) && !pending && !unsensed.has(key)) { baseCells++; continue; } // base met by existing ground
        structTotal++;
        if (!pending && !unsensed.has(key)) structPlaced++;
      }
      const noWork = airCells + baseCells;
      watcher.summary('building_integrity', `"${blueprintName}" — ${structPlaced}/${structTotal} structure placed · ${place_steps} to place, ${dig_steps} to dig · ${noWork} no-work cell${noWork === 1 ? '' : 's'} (${airCells} air + ${baseCells} base on existing ground)${unloadedNote}. (scan ${scanMs}ms)`);
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

      // Troubleshooting line: build_center, bot position, footprint bounds, per-anchor locations.
      // Flags when the bot stands INSIDE the footprint — the boxed-in fingerprint behind place-timeouts.
      if (footprint && bot.entity?.position) {
        const { minX, maxX, minY, maxY, minZ, maxZ } = footprint;
        const bp = bot.entity.position.floored();
        const inside = bp.x >= minX && bp.x <= maxX && bp.z >= minZ && bp.z <= maxZ && bp.y >= minY && bp.y <= maxY + 1;
        watcher.summary('building_integrity',
          `  bot@(${bp.x},${bp.y},${bp.z}) build_center=(${buildCenter.x},${buildCenter.y},${buildCenter.z}) ` +
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
  resolveVoxelAnchor,
};
