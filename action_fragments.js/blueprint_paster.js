// fragment: blueprint_paster (action / building)
// purpose: Validate that a named blueprint exists and is ready for building, stamp
//          a summary chair so building_planner knows the blueprint is confirmed, and
//          trigger dependent setup (mining_blueprinter for headframe). Routes back to
//          recursive_judge — building execution is a separate chain.
// WHY: Confirming the blueprint and triggering dependents is a decision (action).
//      The actual voxel transposition (relative → world coords) is NOT done here —
//      that is pure arithmetic and happens on the fly inside building_integrity.scan(),
//      so no derived voxel file exists to go stale against the blueprint.
//      Blueprints come from @kernel/blueprint_registry, never from the file directly.
//      NOT LIVE-EDITABLE, deliberately (reversed 2026-07-20): this comment used to promise
//      that editing building_blueprints.json took effect on the next integrity scan without a
//      restart. It did — and that was the defect, in both directions. The re-read crashed every
//      bot that scanned during the delete half of a delete-then-upload, and a completed swap
//      silently left the bot checking a half-built world against a different blueprint. The
//      registry snapshots at boot; an edit applies at the next start. See blueprint_registry.js.
// invariants:
//   - payload.blueprint_name must be set (by building_manager via RECIPES)
//   - building_confrence_room[blueprintName].set_buildspot.build_center must exist
//   - Idempotent: if blueprint_paster chair already written, skip and route to recursive_judge
//   - Law 6: writes building_confrence_room[blueprintName].blueprint_paster summary
//   - Routes to recursive_judge on completion or skip

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
const { routeToJudge } = require('@utils/signal_utils');

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

module.exports = {
  receive: watcher.track('blueprint_paster', function (signalType, payload) {
    if (signalType !== 'blueprint_paster') return;

    const signalBus = require('@kernel/signal_bus');
    const tag = 'blueprint_paster';

    // ── Validate blueprint_name ───────────────────────────────────────────────
    const blueprintName = payload?.blueprint_name;
    if (!blueprintName || typeof blueprintName !== 'string') {
      throw new Error('[blueprint_paster] CODING VIOLATION: payload.blueprint_name is missing. Check building_manager RECIPES.');
    }

    // ── Read build_center from the set_buildspot chair ────────────────────────
    const setBuildspot = hq.readBuildingChair(blueprintName, 'set_buildspot');
    if (!setBuildspot?.build_center || typeof setBuildspot.build_center.x !== 'number') {
      throw new Error(`[blueprint_paster] CODING VIOLATION: No locked build_center in building_confrence_room["${blueprintName}"].set_buildspot. set_buildspot must run before blueprint_paster.`);
    }

    // ── Idempotency check ─────────────────────────────────────────────────────
    const existingPaster = hq.readBuildingChair(blueprintName, 'blueprint_paster');
    if (existingPaster !== null && existingPaster !== undefined) {
      watcher.summary(tag, `ℹ️ Blueprint already confirmed for "${blueprintName}". Skipping. -> recursive_judge`);
      routeToJudge(signalBus, tag, {
        ...payload,
        result: 'already_pasted', success: true,
        blueprint_paster: { blueprint: blueprintName, skipped: true },
        readable: `${tag}: ${blueprintName} already confirmed, skipping`
      });
      return;
    }

    // ── Validate building blueprint exists ────────────────────────────────────
    const building = blueprintRegistry.getBuilding(blueprintName, 'blueprint_paster');
    const allVoxels = collectAllVoxels(building);
    if (allVoxels.length === 0) {
      throw new Error(`[blueprint_paster] CODING VIOLATION: Blueprint "${blueprintName}" has no voxels.`);
    }
    const voxelCount = allVoxels.length;

    // ── Stamp blueprint_paster summary chair in building_confrence_room (Law 6) ──
    // Confirms the blueprint is validated and ready. building_planner reads this
    // to know the blueprint step is complete. No voxel file is written — building_integrity
    // transposes building_blueprints.json on the fly when it scans.
    hq.writeBuildingChair(blueprintName, 'blueprint_paster', {
      building_name: blueprintName,
      confirmed_at:  new Date().toISOString(),
      total_voxels:  voxelCount,
      writer:        'blueprint_paster',
    });

    watcher.summary(tag, `✅ "${blueprintName}" blueprint validated (${voxelCount} voxels). Integrity will transpose on scan. Handing back to recursive_judge.`);

    // The headframe blueprint locks the shaft site — generate the mining staircase
    // blueprint immediately so mining_planner/mining_executor have it from the
    // first planning cycle. Pure computation (attach-point tiled), no bot needed.
    if (blueprintName === 'headframe') {
      const miningBluePrinter = require('@perception/mining_blueprinter');
      const miningResult = miningBluePrinter.generateStaircase();
      const shaftSite = miningResult.site;
      watcher.summary(tag, `Mining staircase from center (${shaftSite.startX},${shaftSite.surfaceY},${shaftSite.startZ}). ${miningResult.staircase_segments.length} copy(ies), ${miningResult.total_voxels} voxels.`);
    }

    routeToJudge(signalBus, tag, {
      ...payload,
      result: 'blueprint_confirmed', success: true,
      blueprint_paster: { blueprint: blueprintName, total_voxels: voxelCount },
      readable: `${tag}: confirmed "${blueprintName}" ${voxelCount} voxels -> recursive_judge`,
    });
  })
};
