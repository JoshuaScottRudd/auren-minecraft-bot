// perception node: mining_blueprinter (staircase generation)
//
// PURPOSE (Law 14 -- clear English summary):
//   Generates the underground mining descent as a diagonal STAIRCASE, by tiling the
//   `architect_staircase_final` blueprint downward via ATTACH POINTS (not a hardcoded
//   offset, and not the old shaft/highway/branch model). Uses the already-proven-safe
//   headframe site locked in corporate_headquarters.json
//   (building_confrence_room.headframe.set_buildspot). Returns the segment plan in
//   memory -- mining_integrity calls generateStaircase() on each scan, so the segment plan is
//   always regenerated from the CURRENT blueprint set rather than a cached plan file.
//   That set is the boot snapshot held by @kernel/blueprint_registry, NOT the file on disk:
//   an edit to building_blueprints.json applies at the next start, never mid-run. Treating it
//   as live instead of a snapshot risks crashing on a delete-then-upload or silently
//   re-planning a shaft mid-build from a half-written file.
//
// ATTACH-POINT TILING MODEL (replaces the old offset + rotation machinery):
//   Every blueprint declares lettered attach points (A, B, ...) relative to its build
//   center. Connection is expressed as "this point meets that point" -- the child's point
//   is placed on the parent's point. No offset arithmetic, no rotation table.
//     - Convention here: attach 'A' = INBOUND (top) joint, 'B' = OUTBOUND (bottom) joint.
//     - The first staircase copy's A lands on the headframe's attach A (one block below
//       the headframe build center: headframe A = (0,-1,0)).
//     - Each subsequent copy's A lands on the previous copy's B. That reduces to a pure
//       per-copy translation of (B - A) = (3,-3,0) for the current staircase -- the step
//       falls out of the attach points, so a redesigned staircase re-derives its own step.
//   Heading is fixed east (Law 19 determinism), so tiling is
//   pure translation: no rotation. Attach points carry position only; if a future piece
//   must attach rotated, they will need an orientation field (deferred).
//
// OVERLAP-AGREEMENT RULE (Law 13 / Law 16):
//   Where two copies meet, the cell under one copy's attach point is the SAME world voxel
//   as the cell under the other's. Both sides must AGREE on that voxel or the maintenance
//   diff oscillates (one says air, the other a block -> dig, place, dig, place forever).
//   Resolution: identical block, OR dominant/submissive (one defines it, the other leaves
//   it undefined). This module ENFORCES it: two copies writing the same world cell with
//   DIFFERENT types is a coding violation -> throw. It never silently picks a winner
//   (that would hide the oscillation bug).
//
// Pure computation: no bot, no world reads, no signal bus (Law 1 perception exception --
// this consumes an already-written scan result, the same way blueprint_paster consumes
// set_buildspot's locked build_center).

const blueprintRegistry = require('@kernel/blueprint_registry');
const hq = require('@kernel/corporate_headquarters');
// collectAllVoxels resolves a blueprint's voxels from anchors[].voxels (the anchor
// model, e.g. the staircase), unassigned_voxels, or a legacy voxels array. Imported (not
// forked) so mining and building segments read their voxels through the same resolver (Law 16).
const { collectAllVoxels, transposeAttachPoints } = require('@perception/building_integrity');

const HEADFRAME_BLUEPRINT = 'headframe';
const STAIRCASE_BLUEPRINT = 'architect_staircase_final';
// Attach-point letters. 'A' is the inbound/top joint every piece exposes; 'B' is the
// staircase's outbound/bottom joint that the next copy's A attaches to.
const INBOUND_ID  = 'A';
const OUTBOUND_ID = 'B';

// Coordinate-as-ID: a segment's world origin is its identity ("x|y|z"). Naturally unique,
// self-describing, survives restart. Reachability ordering falls out of Y sorting.
function makeSegmentId(origin) {
  return `${origin.x}|${origin.y}|${origin.z}`;
}

// Reachability sort: shallower segments (higher Y) must be completed first. For equal Y,
// sort by X then Z for deterministic ordering.
function comparePriority(a, b) {
  const ay = a.world_position.y, by = b.world_position.y;
  if (ay !== by) return by - ay;
  const ax = a.world_position.x, bx = b.world_position.x;
  if (ax !== bx) return ax - bx;
  return a.world_position.z - b.world_position.z;
}

function loadBuildings() {
  return blueprintRegistry.getBuildings();
}

// Look up a blueprint's attach point by letter. Returns its [x,y,z] relative to the
// build center. A missing attach point is a coding violation -- tiling cannot proceed.
function attachPoint(building, id) {
  const list = building.attach_points || [];
  const ap = list.find(p => p.id === id);
  if (!ap || !Array.isArray(ap.position)) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: blueprint "${building.name || 'unknown'}" has no attach point "${id}".`);
  }
  return ap.position;
}

// Flat [x,y,z,type,facing?] voxels relative to the blueprint's build center.
function blueprintVoxels(building) {
  const collected = collectAllVoxels(building);
  if (collected.length === 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: blueprint "${building.name || 'unknown'}" has no voxels (checked anchors[].voxels, unassigned_voxels, legacy voxels).`);
  }
  return collected.map(({ raw }) => raw);
}

// Translate one voxel by a world origin. Pure translation -- heading is fixed east, so
// there is no rotation (Law 19). Facing strings ride along unchanged.
function translateVoxel(v, origin) {
  const out = [origin.x + v[0], origin.y + v[1], origin.z + v[2], v[3]];
  if (v[4]) out.push(v[4]);
  return out;
}

// placeVoxelsAt -- stamp a blueprint's voxels at a world origin (no rotation). Returns
// { voxels } in the [wx,wy,wz,type,facing?] shape the diff engine consumes. Used for
// single-piece placement (e.g. cells) that does not need attach-point tiling.
function placeVoxelsAt(building, origin) {
  return { voxels: blueprintVoxels(building).map(v => translateVoxel(v, origin)) };
}

// ----------------------------------------------------------------------------
// loadSite: read the headframe's locked site from corporate_headquarters.json
// (building_confrence_room.headframe.set_buildspot), written by set_buildspot.js.
// Carries the build_center find_buildingspot proved a safe diagonal staircase can descend
// from (.staircase), plus the proven-safe depth. Law 13: a missing chair or missing
// .staircase is a coding violation -- the descent cannot be generated for a site never
// proven safe and locked.
// ----------------------------------------------------------------------------
function loadSite() {
  const site = hq.readBuildingChair('headframe', 'set_buildspot');
  if (!site?.build_center || !site?.staircase) {
    throw new Error('[mining_blueprinter] CODING VIOLATION: building_confrence_room.headframe.set_buildspot has no locked build_center + staircase data -- run find_buildingspot (require_shaft) and set_buildspot before generating the staircase.');
  }
  return {
    buildCenter: site.build_center,        // {x,y,z} -- headframe origin in the world
    surfaceY:    site.staircase.surfaceY,
    lowestSafeY: site.staircase.lowestSafeY,
  };
}

// staircaseSideAttaches: the joints a CELL hangs on — every attach point except the A/B
// tiling joints. `outward` is the across-walkway direction the cell grows: the walkway runs
// east (heading fixed), so z is across it (+z south, -z north); a purely-x attach
// would grow east/west. Cell-side geometry lives HERE (Law 16) so mining_cell_graph consumes
// ready-made {id, rel, outward} and holds no staircase-blueprint knowledge of its own.
function staircaseSideAttaches() {
  const stair = loadBuildings()[STAIRCASE_BLUEPRINT];
  if (!stair) throw new Error(`[mining_blueprinter] CODING VIOLATION: "${STAIRCASE_BLUEPRINT}" not found in building_blueprints.json.`);
  const pts = (stair.attach_points || []).filter(p => p.id !== INBOUND_ID && p.id !== OUTBOUND_ID);
  return pts.map(p => {
    const rel = p.position;
    const outward = rel[2] > 0 ? 'south' : rel[2] < 0 ? 'north' : rel[0] > 0 ? 'east' : 'west';
    return { id: p.id, rel, outward };
  });
}

// ----------------------------------------------------------------------------
// projectStaircase: PURE tiling. Given the WORLD position of the headframe's attach A and
// the proven-safe floor (lowestSafeY), tile architect_staircase_final downward by attach
// points. No HQ read, no bot -- so find_buildingspot can call it for a CANDIDATE site
// (pre-lock, before any chair exists) and generateStaircase can call it for the LOCKED
// site. ONE tiling pathway (Law 16): the volume find_buildingspot hazard-scans is the exact
// volume this builds.
//
// Copy 0's inbound (A) lands on headAWorld; copy n+1's A lands on copy n's B, which reduces
// to a per-copy translation of (B - A). Only whole copies whose deepest voxel stays
// at/above lowestSafeY are emitted -- no partial, unproven segment. Enforces the
// overlap-agreement rule across copies (throw on disagreement, dedupe identical shared cells
// into the shallower copy).
//
// Returns:
//   segments       [{ id, type, world_position, voxel_count, anchors:[{x,y,z}], voxels, summary }]
//                  -- anchors are the staircase's anchor stand-spots transposed per copy
//                     (the anchored stationary builder needs them to pick stand spots).
//   occupiedCells  Map "x,y,z" -> type. EVERY cell the staircase defines (air + solid) =
//                  the exact prism find_buildingspot must hazard-check.
//   step           {x,y,z} per-copy translation (B - A).
//   minVoxY        staircase's lowest voxel Y (relative). bottomY: world Y of deepest voxel.
// ----------------------------------------------------------------------------
function projectStaircase({ headAWorld, lowestSafeY }) {
  if (!headAWorld || typeof headAWorld.x !== 'number' || typeof headAWorld.y !== 'number' || typeof headAWorld.z !== 'number') {
    throw new Error('[mining_blueprinter] CODING VIOLATION: projectStaircase requires headAWorld {x,y,z}.');
  }
  if (typeof lowestSafeY !== 'number') {
    throw new Error('[mining_blueprinter] CODING VIOLATION: projectStaircase requires numeric lowestSafeY.');
  }

  const buildings = loadBuildings();
  const stair = buildings[STAIRCASE_BLUEPRINT];
  if (!stair) throw new Error(`[mining_blueprinter] CODING VIOLATION: "${STAIRCASE_BLUEPRINT}" not found in building_blueprints.json.`);

  const stairIn  = attachPoint(stair, INBOUND_ID);  // staircase top joint  (0,0,0)
  const stairOut = attachPoint(stair, OUTBOUND_ID); // staircase bottom joint (3,-3,0)

  // Per-copy translation: place the child's inbound (A) on the parent's outbound (B).
  const step = { x: stairOut[0] - stairIn[0], y: stairOut[1] - stairIn[1], z: stairOut[2] - stairIn[2] };
  if (step.y >= 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: staircase attach B is not below attach A (step.y=${step.y}); the descent must go down.`);
  }

  // Anchor stand-spots (relative to build center), transposed per copy below. Missing anchors
  // is a coding violation -- the anchored stationary builder needs stand spots.
  const stairAnchors = Array.isArray(stair.anchors) ? stair.anchors.map(a => a.position) : [];
  if (stairAnchors.length === 0) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: "${STAIRCASE_BLUEPRINT}" has no anchors -- the anchored builder needs stand spots.`);
  }

  const stairVox = blueprintVoxels(stair);
  const minVoxY = Math.min(...stairVox.map(v => v[1]));

  // Copy n origin = the world point where copy n's build center sits. Copy 0's inbound (A)
  // lands on headAWorld, so copy 0 origin = headAWorld - stairIn; each further copy adds step.
  const originFor = (n) => ({
    x: headAWorld.x - stairIn[0] + n * step.x,
    y: headAWorld.y - stairIn[1] + n * step.y,
    z: headAWorld.z - stairIn[2] + n * step.z,
  });

  // How many whole copies fit with their deepest voxel at/above lowestSafeY. May be 0
  // (site too shallow for even one copy). projectStaircase reports that as an empty result
  // -- a legitimate DATA outcome for the candidate-scan path (find_buildingspot rejects it).
  // The locked-site path (generateStaircase) treats 0 copies as a coding violation, since
  // find_buildingspot already proved the depth before locking.
  let repeatCount = 0;
  while (originFor(repeatCount).y + minVoxY >= lowestSafeY) {
    repeatCount++;
    if (repeatCount > 1024) throw new Error('[mining_blueprinter] CODING VIOLATION: staircase repeat count exceeded 1024 -- bad site depth.');
  }

  // Build segments, enforcing the overlap-agreement rule across copies. occupiedCells maps a
  // claimed world cell to its block type: a second copy claiming the same cell with a
  // DIFFERENT type is a disagreement (oscillation) -> throw; the SAME type is deduped so
  // the cell lives in exactly one segment (the shallower copy that claimed it first).
  const occupiedCells = new Map();
  const segments = [];
  for (let n = 0; n < repeatCount; n++) {
    const origin = originFor(n);
    const placed = [];
    for (const v of stairVox) {
      const wv = translateVoxel(v, origin);
      const key = `${wv[0]},${wv[1]},${wv[2]}`;
      const prev = occupiedCells.get(key);
      if (prev !== undefined) {
        if (prev !== wv[3]) {
          throw new Error(`[mining_blueprinter] CODING VIOLATION (attach-point overlap): world (${key}) is "${prev}" in one staircase copy and "${wv[3]}" in another. The two disagree, which oscillates the maintenance diff (dig/place forever). Make the shared voxel identical, or leave one side undefined (dominant/submissive).`);
        }
        continue; // identical -- already claimed by a shallower copy
      }
      occupiedCells.set(key, wv[3]);
      placed.push(wv);
    }
    const id = makeSegmentId(origin);
    const anchors = stairAnchors.map(p => ({ x: origin.x + p[0], y: origin.y + p[1], z: origin.z + p[2] }));
    segments.push({
      id,
      type: 'staircase',
      world_position: origin,
      voxel_count: placed.length,
      anchors,
      summary: `staircase ${id} y=${origin.y}..${origin.y + minVoxY}`,
      voxels: placed,
    });
  }

  // bottomY = deepest voxel Y across all emitted copies; for an empty result, the floor the
  // first (unbuilt) copy WOULD reach -- so callers can report how shallow the site is.
  const bottomY = segments.length > 0
    ? segments[segments.length - 1].world_position.y + minVoxY
    : originFor(0).y + minVoxY;
  return { segments, occupiedCells, step, minVoxY, bottomY, repeatCount };
}

// ----------------------------------------------------------------------------
// generateStaircase: LOCKED-site wrapper around projectStaircase. Reads the headframe's
// locked site from the HQ chair, resolves the headframe attach A to world, projects the
// staircase, and wraps the segments with site metadata. mining_integrity/blueprint_paster
// call this; find_buildingspot calls projectStaircase directly with a candidate site.
// ----------------------------------------------------------------------------
function generateStaircase() {
  const site = loadSite();
  const buildings = loadBuildings();
  const headframe = buildings[HEADFRAME_BLUEPRINT];
  if (!headframe) throw new Error(`[mining_blueprinter] CODING VIOLATION: "${HEADFRAME_BLUEPRINT}" not found in building_blueprints.json.`);

  // World position of the headframe's attach A, via the shared attach-point resolver so the
  // headframe↔staircase join has ONE definition (Law 16). find_buildingspot resolves the same
  // join for a candidate site through transposeAttachPoints with a candidate build center.
  const bc = site.buildCenter;
  const headAWorld = transposeAttachPoints(headframe, bc)[INBOUND_ID];
  if (!headAWorld) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: headframe has no attach point "${INBOUND_ID}".`);
  }

  const { segments, step, bottomY } = projectStaircase({ headAWorld, lowestSafeY: site.lowestSafeY });
  if (segments.length < 1) {
    throw new Error(`[mining_blueprinter] CODING VIOLATION: locked site (headframe A y=${headAWorld.y}, lowestSafeY=${site.lowestSafeY}) is not deep enough for one staircase copy -- find_buildingspot should have rejected it before set_buildspot locked it.`);
  }
  const totalVoxels = segments.reduce((sum, seg) => sum + seg.voxel_count, 0);

  return {
    schema: 'auren.mining_blueprinter.v2',
    generated_at: new Date().toISOString(),
    site: {
      startX: bc.x,
      startZ: bc.z,
      surfaceY: site.surfaceY,
      lowestSafeY: site.lowestSafeY,
    },
    total_voxels: totalVoxels,
    staircase_segments: segments,
    summary: `Generated ${segments.length} staircase copy(ies) (${totalVoxels} voxels), attach-point tiled (step ${step.x},${step.y},${step.z}) from headframe attach A (y=${headAWorld.y}) down to y=${bottomY}, within the proven-safe depth (lowestSafeY=${site.lowestSafeY}).`,
  };
}

if (require.main === module) {
  const result = generateStaircase();
  console.log(result.summary);
  for (const seg of result.staircase_segments) {
    console.log(`  ${seg.summary}`);
  }
}

module.exports = {
  makeSegmentId, comparePriority, loadBuildings,
  attachPoint, blueprintVoxels, placeVoxelsAt,
  projectStaircase, generateStaircase, staircaseSideAttaches,
};
