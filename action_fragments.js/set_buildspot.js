// fragment: set_buildspot (action)
// purpose: Lock the selected building site center into the set_buildspot chair of
//          building_confrence_room[blueprintName], validate the blueprint exists in
//          building_blueprints.json, stamp the blueprint_paster chair to confirm
//          readiness, and trigger dependents (mining_blueprinter for headframe).
//          Routes to recursive_judge on completion.
// WHY: Setting the coordinates is a decision (action). Validating the blueprint
//      and stamping readiness is the natural continuation — both are part of the
//      same "confirm this building is ready to build" setup phase. The actual voxel
//      transposition happens later in building_integrity.scan() (observation, not action).
// invariants:
//   - payload.blueprint_name must be present (set by building_manager)
//   - build_center from payload.find_buildingspot.selected_candidate.build_center
//   - Idempotent: if set_buildspot chair already has coordinates, skip to validation
//   - Law 6: writes set_buildspot + blueprint_paster chairs with writer labels
//   - Routes to recursive_judge on completion or failure

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');

// Collect all voxels from a blueprint — anchors[].voxels + unassigned_voxels, or legacy flat voxels.
function collectAllVoxels(building) {
  const result = [];
  if (Array.isArray(building.anchors)) {
    for (const a of building.anchors) { if (Array.isArray(a.voxels)) result.push(...a.voxels); }
  }
  if (Array.isArray(building.unassigned_voxels)) result.push(...building.unassigned_voxels);
  if (result.length > 0) return result;
  if (Array.isArray(building.voxels)) return building.voxels;
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// lock(candidate, blueprintName, roomKey) — the reusable LOCK primitive.
// Writes the two conference-room chairs that mark a build site chosen (set_buildspot) and its blueprint
// validated (blueprint_paster). Pure record write — NO judge route and NO proximity test; the caller
// owns what happens next (receive routes to the judge; the startup batch lock_all_buildspots calls this
// once per surveyed blueprint after its whole-layout ≤64 check passes). Throws Law 13 if a center is
// already locked for this room — set_buildspot's job is to lock a FRESH home, so the caller must gate
// already-located rooms itself. Returns { voxelCount, buildCenter }.
function lock(candidate, blueprintName, roomKey) {
  const tag = 'set_buildspot';
  const buildCenter = candidate?.build_center;
  if (!buildCenter || typeof buildCenter.x !== 'number' || typeof buildCenter.y !== 'number' || typeof buildCenter.z !== 'number') {
    throw new Error('[set_buildspot] CODING VIOLATION: no valid build_center on candidate. candidate.build_center must be present.');
  }

  // ── Law 13: a build_center must NOT already exist here ────────────────────
  // Locking is for a FRESH home. job_board gates the coordinates requirement as satisfied the instant a
  // build_center exists, so a find/set task never runs against an established home. Reaching here with a
  // center already locked means stale cross-process HQ a flush should have cleared (the bot's
  // corporate_headquarters and/or the overseer's mirrored fleet state), or a center that reappeared
  // mid-find via an overseer broadcast. Crash loudly for inspection instead of soft-looping.
  const existing = hq.readBuildingChair(roomKey, 'set_buildspot');
  if (existing?.build_center && typeof existing.build_center.x === 'number') {
    const bc = existing.build_center;
    throw new Error(
      `[set_buildspot] LAW 13 VIOLATION: asked to lock a build_center for "${roomKey}" at ` +
      `candidate (${buildCenter.x},${buildCenter.y},${buildCenter.z}), but one is ALREADY locked ` +
      `at (${bc.x},${bc.y},${bc.z}). A find/set task must never run against an established home — ` +
      `job_board gates the coordinates step on exactly this. Root cause is almost always stale HQ ` +
      `a flush should have cleared (the bot's corporate_headquarters and/or the overseer's mirrored ` +
      `fleet state), or the center reappearing mid-find via an overseer broadcast. Flush the fleet ` +
      `and restart, or inspect the assessors/building coordinates gating.`
    );
  }

  // ── Write set_buildspot chair (Law 6) — the center is fresh by the guard above ──
  // rotation: the quarterTurns find_buildingspot validated this candidate against (farmland's water-site
  // overlay is the only mode that ever sets a non-zero value). Every reader that reconstructs world
  // coordinates from this chair (scan/getProtectedBlocks/getWorldAnchors/farmland_site) must apply the
  // SAME rotation the candidate was proven safe at, or it silently rebuilds against the unvalidated footprint.
  hq.writeBuildingChair(roomKey, 'set_buildspot', {
    build_center: { x: buildCenter.x, y: buildCenter.y, z: buildCenter.z },
    footprint:    candidate?.footprint   || null,
    staircase:    candidate?.staircase   || null,
    rotation:     candidate?.rotation ?? 0,
    locked_at:    new Date().toISOString(),
    writer:       'set_buildspot',
  });
  watcher.summary(tag, `✅ Locked ${roomKey} build site — build_center (${buildCenter.x},${buildCenter.y},${buildCenter.z}).`);

  // Validate the blueprint exists and has voxels, then stamp blueprint_paster (building_planner reads
  // this to know the blueprint step is complete).
  const building = blueprintRegistry.getBuilding(blueprintName, 'set_buildspot');
  const allVoxels = collectAllVoxels(building);
  if (allVoxels.length === 0) {
    throw new Error(`[set_buildspot] CODING VIOLATION: Blueprint "${blueprintName}" has no voxels.`);
  }
  const voxelCount = allVoxels.length;

  hq.writeBuildingChair(roomKey, 'blueprint_paster', {
    building_name: blueprintName,
    confirmed_at:  new Date().toISOString(),
    total_voxels:  voxelCount,
    writer:        'set_buildspot',
  });
  watcher.summary(tag, `Blueprint "${blueprintName}" validated (${voxelCount} voxels). Integrity will transpose on scan.`);

  return { voxelCount, buildCenter };
}

// set_buildspot is now a pure LIBRARY (Law 16 — one pathway): the reactive signal
// `receive` — the second half of the retired lazy locate route (find_buildingspot → set_buildspot → judge)
// — is gone. lock_all_buildspots is the ONE locator and calls lock() directly for every base blueprint
// after its whole-layout ≤64 check passes. Only the lock primitive survives.
module.exports = {
  lock,
};
