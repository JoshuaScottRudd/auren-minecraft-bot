// building_site_overlays — the two site-scan OVERLAYS find_buildingspot layers onto its base
// surface scan, plus the two shared site-geometry primitives both the base scan and the overlays
// use (BUFFER_BLOCKS, overlapsExisting). Extracted from find_buildingspot so the fragment holds the
// scan PIPELINE (grid walk, candidate ranking, reporting, signal routing) and this holds the heavy,
// world-reading geometry each overlay contributes — each independently testable against a mock bot.
//
// shaft overlay (payload.require_shaft):
//   The shaft-safety scan formerly lived in a separate perception fragment (miningshaft_scanner).
//   The ONLY reason the bot scans for a mineshaft is to pick the headframe's location, so that scan
//   folds into the site search: every surface candidate's column is checked for a safe diagonal-
//   staircase descent AS IT IS FOUND (evaluateStaircasePrism), instead of a second full pass. It
//   projects the REAL staircase geometry (mining_blueprinter.projectStaircase — one tiling pathway,
//   Law 16) and hazard-checks the exact volume it will carve. A copy is "good by default" and only
//   disqualified by a proven hazard (fluids in/adjacent, a gravity block whose column conducts fluid,
//   unknown/unloaded blocks) — never by its contents (stone/dirt/ore are all fine to dig).
//
// (A third overlay, the water-site farmland search, was retired — Law 16. The wheat farm is now
// sited by the wheat_plot_scanner's shoreline BFS, not find_buildingspot, so the whole
// require_water_site path and its blueprint were removed.)

'use strict';

const Vec3 = require('vec3');
// Gravity / fluid identification + the gravel-to-fluid conduit scan live in one shared module
// (Law 16) so find_buildingspot, mining_integrity and the cell scanner all agree on what is a
// gravity block, a fluid, and a hazardous conduit.
const { GRAVITY_BLOCKS: SHAFT_GRAVITY_BLOCKS, FLUID_HAZARDS: SHAFT_FLUID_HAZARDS, followGravityColumn } = require('@utils/gravity_utils');
const { projectStaircase } = require('@perception/mining_blueprinter');
const { transposeAttachPoints } = require('@perception/building_integrity');
const { CLEARABLE } = require('@utils/site_geometry');
const { guardExternalSync } = require('@utils/external_library_guard');

// ── Shared site-geometry primitives (base surface scan + both overlays) ───────
const BUFFER_BLOCKS = 2;   // extra clearance per side — building_integrity clears a 1-block perimeter, this adds navigable space beyond it

function overlapsExisting(startX, endX, startZ, endZ, existingBoxes) {
  for (const box of existingBoxes) {
    if (startX <= box.maxX && endX >= box.minX && startZ <= box.maxZ && endZ >= box.minZ) {
      return box.key;
    }
  }
  return null;
}

// CLEARABLE moved on again — to @utils/site_geometry, and re-exported here so every existing consumer
// is untouched. It left because this module reaches the watcher and @perception, which makes it
// unimportable from outside the construct; the arena bench needs THIS set, not a similar one, and a
// second near-copy of it is precisely the Law 16 fault the first move was fixing. Its rationale and
// membership travelled with it verbatim.

// overheadClear — walk the column above a build floor at (x,z), from groundY+1 through groundY+buildingH+1,
// and decide whether the site carves into terrain. Every CLEARABLE block (air, trees, plants) is free — a
// preconstruction pass removes it, at any height, no matter how many. Every OTHER block is solid terrain
// that must be DUG; up to `maxScrape` such layers are tolerated (a small mound the build flattens), but the
// (maxScrape+1)th proves the floor is buried in a slope/mountain and the site is rejected.
//   maxScrape=0 (surface base, the default): ANY solid block overhead rejects — the base wants open sky
//     above its floor (unchanged from when this lived in find_buildingspot). (maxScrape>0 once served the
//     retired water-site farm's sea-level bank scrape; every live caller now passes 0, but the knob stays
//     generic in case a future overlay needs a bounded-scrape site.)
// Returns { clear:true, scraped } or { clear:false, blockName, y, scraped }.
function overheadClear(bot, x, z, groundY, buildingH, maxScrape = 0) {
  let scraped = 0;
  for (let y = groundY + 1; y <= groundY + buildingH + 1; y++) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return { clear: false, blockName: 'unloaded_chunk', y, scraped };
    if (CLEARABLE.has(block.name)) continue;   // air / tree / plant — cleared for free, never counts
    scraped++;                                 // a solid terrain block that must be dug to build here
    if (scraped > maxScrape) return { clear: false, blockName: block.name, y, scraped };
  }
  return { clear: true, scraped };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAIRCASE-SAFETY OVERLAY — the diagonal-descent replacement for the old vertical shaft scan.
// ─────────────────────────────────────────────────────────────────────────────
const STAIRCASE_SAFETY = {
  // ONE depth knob (Law 16 — collapsed from the old TARGET_Y + MAX_LOWEST_SAFE_Y pair). The
  // descent must be hazard-free all the way to this Y; a site whose descent hits lava/water before
  // reaching it is rejected outright — the floor must be reached, no partial descents.
  //
  // This is a FLOOR ON THE WHOLE MINE, not merely on the staircase: cell floors are derived from the
  // copies this descent emits (mining_cell_graph.getDeepestSegmentMarkers), so no cell — and nothing
  // dug — sits below the deepest copy. It is set to hold the mine clear of the DEEPSLATE BLEND BAND,
  // which thickens from y≈8 down to y=0: deepslate is slower to mine and wants its own tooling and
  // handling, so the stone/deepslate boundary is a design decision rather than something the descent
  // should wander into on its own.
  //
  // The descent steps 3 Y at a time and the phase depends on surface Y, so the deepest voxel lands at
  // this Y, +1, or +2. The value is therefore the floor the mine never passes, not the exact depth it
  // reaches — which is the property worth having on a keep-out band.
  //
  // Tuning: RAISE this if live runs show too few qualifying sites — a shallower floor is a shorter
  // descent with fewer chances to hit a fluid, so more sites pass. The cost is paid in cell floors:
  // they are spaced 6 apart around mining_cell_graph.STRADDLE_FLOOR_Y, so a floor climbing past one
  // deletes it from the bottom up.
  REQUIRED_DEPTH_Y: 10,
  PRISM_MARGIN:     1,   // shell of blocks around the staircase envelope checked for fluids —
                        // a fluid one block outside the carved volume still floods in
};
// Stop scanning once this many surface-spot + safe-staircase overlaps have been found. Keeps the
// scan from checking far more candidates than needed while still guaranteeing a non-empty result if
// a few exist nearby.
const SUFFICIENT_STAIRCASE_MATCHES = 5;

// SHAFT_FLUID_HAZARDS and SHAFT_GRAVITY_BLOCKS are imported from @utils/gravity_utils (single source
// of truth, Law 16). The only hazards are lava and water: a fluid is the material-based hard
// disqualifier, and a gravity block matters ONLY when its column conducts a fluid into the descent
// (followGravityColumn → CONDUIT) — which is itself a lava/water hazard. A gravity block that does not
// conduct, and the descent's natural vertical steps, are not hazards.

// getBiomeName — returns the stripped biome name (no 'minecraft:' prefix) at the given position, or
// null if the chunk is not loaded. Used to gate staircase candidates onto the settle-able
// ACCEPTABLE_BIOMES set (require_shaft mode), and to stamp informational biome on farmland candidates.
// ⚠ FLAGGED — SEPARATE BUG, not fixed here (Invariant B).
// The header claim "null if the chunk is not loaded" is FALSE. prismarine-world's worldsync.js
// implements `getBiome(pos) { const chunk = this.getColumnAt(pos); if (!chunk) return 0; ... }` — an
// unloaded chunk returns biome id **0**, not null and not a throw. So `biomeId == null` never fires,
// and this function reports biome 0's NAME as though it were sensed. evaluateStaircasePrism then runs
// `acceptableBiomes.has(biome)` against a biome nobody ever looked at. Fixing it needs a real
// chunk-presence gate (bot.blockAt(pos) !== null).
// getBiome is a genuine third-party boundary (chunk.getBiome / bot.world), so it keeps one — through
// the guard, which reports rather than swallowing (Law 16). null here means "unknown".
function getBiomeName(bot, x, y, z) {
  const read = guardExternalSync('building_site_overlays', `getBiome at (${x},${y},${z})`, () => bot.world.getBiome(new Vec3(x, y, z)));
  if (!read.ok || read.value == null) return null;
  const name = bot.registry?.biomes?.[read.value]?.name || '';
  return name.replace('minecraft:', '').toLowerCase() || null;
}

// checkCopyHazards — hazard-check ONE staircase copy against the real world. Scans every envelope
// cell (the copy's voxels) plus a PRISM_MARGIN shell for fluids, and the envelope cells for gravity
// blocks that conduct to fluid. The ONLY hazards are lava and water: a null/unloaded block is unsafe
// too (Law 13 — cannot prove it clear).
//
// Drops/falls are NOT hazards. The diagonal descent's natural vertical steps are how the staircase is
// built, and a plain sand/gravel block that could fall is not penalized — only a gravel/sand column
// that actually DRAINS a fluid into the descent (followGravityColumn → CONDUIT) is rejected, and that
// is a lava/water hazard, not a "falling block" one.
//
// WHY margin: a fluid one block outside the carved staircase still floods in once the wall voxel is
// dug or breaks, so the shell must be clear too — the diagonal analogue of the old column's 9×9
// safety footprint, but hugging the actual prism instead of a vertical box.
function checkCopyHazards(bot, segment) {
  const m = STAIRCASE_SAFETY.PRISM_MARGIN;
  const fluidChecked = new Set();

  for (const v of segment.voxels) {
    const [wx, wy, wz] = v;
    // Envelope cell + margin shell — fluids anywhere here flood the descent.
    for (let dx = -m; dx <= m; dx++) {
      for (let dy = -m; dy <= m; dy++) {
        for (let dz = -m; dz <= m; dz++) {
          const x = wx + dx, y = wy + dy, z = wz + dz;
          const key = `${x},${y},${z}`;
          if (fluidChecked.has(key)) continue;
          fluidChecked.add(key);
          const block = bot.blockAt(new Vec3(x, y, z));
          if (!block) return { safe: false, failureReason: 'unknown_block' };
          if (SHAFT_FLUID_HAZARDS.has(block.name)) return { safe: false, failureReason: block.name };
        }
      }
    }
  }

  // Gravity conduits: a sand/gravel column inside the envelope that drains into a fluid pours
  // lava/water into the descent when disturbed — that IS a fluid hazard, so it stays a disqualifier.
  // A gravity block that does NOT conduct is ignored (falling blocks are not a hazard). Checked on
  // the envelope cells only.
  for (const v of segment.voxels) {
    const [wx, wy, wz] = v;
    const block = bot.blockAt(new Vec3(wx, wy, wz));
    if (block && SHAFT_GRAVITY_BLOCKS.has(block.name) && followGravityColumn(bot, wx, wy, wz) === 'CONDUIT') {
      return { safe: false, failureReason: 'gravity_fluid_conduit' };
    }
  }

  return { safe: true, failureReason: null };
}

// evaluateStaircasePrism — project the diagonal staircase from a CANDIDATE build center and hazard-
// walk its copies top-down (shallowest first), accepting the safe prefix. The headframe↔staircase
// join is resolved candidate-backed (no chair yet) through transposeAttachPoints, so this uses the
// SAME join the locked site will. Returns { ok:false, reason } for no attach point / biome mismatch /
// too-shallow / unsafe, or { ok:true, startX, startZ, surfaceY, lowestSafeY, depthReached,
// safeCopies, haltReason }.
//
// acceptableBiomes: a Set of settle-able biome names (ACCEPTABLE_BIOMES). When passed, the build
// center's own biome must be a member — this is where "only settle in plains/forest" is enforced per
// candidate, the same gate exploration uses to decide when to stop seeking (one set, Law 16). A
// candidate in a rejected biome is out before any hazard work.
function evaluateStaircasePrism(bot, headframeBuilding, buildCenter, acceptableBiomes) {
  const surfY = buildCenter.y; // ground the headframe sits on = top of the descent

  if (acceptableBiomes) {
    const biome = getBiomeName(bot, buildCenter.x, surfY, buildCenter.z);
    if (!acceptableBiomes.has(biome)) return { ok: false, reason: 'biome_mismatch', biome };
  }

  // Headframe attach A in world for THIS candidate — the staircase's first copy lands here.
  const headAWorld = transposeAttachPoints(headframeBuilding, buildCenter).A;
  if (!headAWorld) return { ok: false, reason: 'no_attach_point' };

  // Project the descent to the required floor; hazard-walk the copies shallow → deep.
  const proj = projectStaircase({ headAWorld, lowestSafeY: STAIRCASE_SAFETY.REQUIRED_DEPTH_Y });
  if (proj.segments.length === 0) {
    return { ok: false, reason: 'too_shallow', haltReason: 'no_copy_fits' };
  }

  let lowestSafeY  = surfY;
  let safeCopies    = 0;
  let haltReason    = 'reached_target';

  for (const seg of proj.segments) { // proj.segments are already shallow → deep
    const hz = checkCopyHazards(bot, seg);
    if (!hz.safe) { haltReason = hz.failureReason; break; }
    lowestSafeY = seg.world_position.y + proj.minVoxY; // this copy's deepest voxel Y
    safeCopies++;
  }

  // Reach the floor, no matter what: the ENTIRE descent to REQUIRED_DEPTH_Y must be clean. A hazard
  // anywhere short of the deepest projected copy means we can't safely reach the required depth, so
  // the site is out (this replaced the old numeric lowestSafeY > MAX gate — a single fluid strike now
  // rejects the site rather than accepting a partial, too-shallow descent). safeCopies===0 folds in.
  if (safeCopies < proj.segments.length) {
    return { ok: false, reason: 'unsafe_descent', depthReached: surfY - lowestSafeY, lowestSafeY, haltReason };
  }

  return {
    ok: true,
    startX: buildCenter.x, startZ: buildCenter.z,
    surfaceY: surfY, lowestSafeY, depthReached: surfY - lowestSafeY, safeCopies,
    haltReason,
  };
}

module.exports = {
  BUFFER_BLOCKS,
  overlapsExisting,
  CLEARABLE,
  overheadClear,
  SUFFICIENT_STAIRCASE_MATCHES,
  getBiomeName,
  evaluateStaircasePrism,
};
