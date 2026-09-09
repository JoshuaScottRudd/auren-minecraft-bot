// js_kernel/blueprint_registry.js
// The ONE route to building_blueprints.json (Law 16). Every fragment and perception node that needs a
// blueprint asks here; nothing else opens the file. Scattered independent read sites let inconsistent
// reads of the same file race with a concurrent write — a single route removes that class of bug.
//
// The snapshot/hash/drift-warn mechanism lives in @kernel/snapshot_registry and is shared with the
// crafting registry — read the WHY there. This file owns only what is specific to building blueprints:
// the "buildings" section shape, and the accessors callers actually ask for.
//
// A blueprint edit takes effect only for buildings constructed after a restart, not ones already
// built — the snapshot loads once at boot, so a live process keeps the shape it booted with.

'use strict';

const { createSnapshotRegistry } = require('@kernel/snapshot_registry');

const BLUEPRINTS_PATH = require.resolve('@kernel/building_blueprints.json');

const registry = createSnapshotRegistry({
  filePath: BLUEPRINTS_PATH,
  fileName: 'building_blueprints.json',
  tag: 'blueprint_registry',
  validate: (parsed) =>
    (!parsed.buildings || typeof parsed.buildings !== 'object') ? 'has no "buildings" section' : null,
});

// ── Accessors — the only way in ───────────────────────────────────────────────────────────────────

// The whole buildings section. Callers that iterate every blueprint use this.
function getBuildings() {
  return registry.data().buildings;
}

// One blueprint by name. A name that is not in the file is a Law 13 coding violation — the caller asked
// for something that does not exist, which no correct system does. `tag` names the caller so the throw
// still reads as its own rather than a generic message shared across every call site.
function getBuilding(blueprintName, tag) {
  const building = registry.data().buildings[blueprintName];
  if (!building) {
    throw new Error(`[${tag || 'blueprint_registry'}] CODING VIOLATION: Blueprint "${blueprintName}" not found in building_blueprints.json.`);
  }
  return building;
}

// Absence-tolerant lookup for the one caller with a legitimate fallback (farming_integrity computes
// per-design constants at load and degrades to zeros rather than refusing to boot).
function tryGetBuilding(blueprintName) {
  return registry.data().buildings[blueprintName] || null;
}

// The full parsed document, for a caller that needs a section other than `buildings`.
function raw() {
  return registry.data();
}

// The running version's identity — for a boot line, so a run's trace records WHICH blueprints it built
// against. Without it, a trace from a past run cannot be matched to the file that produced it.
function bootHash() {
  return registry.bootHash();
}

module.exports = { getBuildings, getBuilding, tryGetBuilding, raw, bootHash, BLUEPRINTS_PATH };
