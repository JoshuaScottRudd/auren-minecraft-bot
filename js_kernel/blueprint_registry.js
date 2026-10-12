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

// ── AN ANCHOR MUST NAME A BLOCK A BODY CAN STAND ON ───────────────────────────
// An anchor names the block a body's FEET REST ON — `locomotion.goToStand` adds the +1 — so every anchor
// must stand on a declared, solid voxel (planks, structural_fill, stand_ground, natural_block, or a
// deliberately stated block for untouched terrain). Standing on an undeclared cell or on `air` sends a
// body to pillar into the cell it is already standing in, and every station the anchor owns fails with it.
//
// A LOAD-TIME REFUSAL, NOT A RUNTIME ONE: the fact is in the FILE, so it is knowable with no world, no
// server and no bot. `preflight` loads this module, so a blueprint edit that breaks the rule is refused on
// the developer's machine (Law 13 — default-stopped at the boundary the fact crosses).
//
// AIR IS NAMED, not inferred from a list of solids. A whitelist of "blocks you may stand on" would have
// to be kept in step with every block the fleet learns to place, and would refuse a correct blueprint
// the day it fell behind. `air` is the one voxel type that states outright that nothing will be there
// (Law 29 — one list, and this is the list of things that are not blocks).
const AIR_VOXEL = 'air';

function validateAnchorFooting(parsed) {
  for (const [name, building] of Object.entries(parsed.buildings)) {
    const anchors = Array.isArray(building.anchors) ? building.anchors : [];
    // Every voxel the building declares, anchor-assigned or not — an anchor may legitimately stand on a
    // cell filed under a DIFFERENT anchor, or on one left unassigned, so the lookup is the whole plan.
    const plan = new Map();
    for (const a of anchors) for (const v of (a.voxels || [])) plan.set(`${v[0]},${v[1]},${v[2]}`, v[3]);
    for (const v of (building.unassigned_voxels || [])) plan.set(`${v[0]},${v[1]},${v[2]}`, v[3]);

    anchors.forEach((a, i) => {
      const p = a.position;
      if (!Array.isArray(p) || p.length !== 3) return;   // shape is the schema's business, not this rule's
      const key = `${p[0]},${p[1]},${p[2]}`;
      const type = plan.get(key);
      if (type === undefined) {
        throw violation(`"${name}" anchor ${i} stands at (${key}), which the blueprint does not declare at all. `
          + `An anchor names the block a body's FEET REST ON (goToStand adds the +1), so the building must `
          + `state what that block is. If the intent is to stand on untouched terrain, the plan has to say so `
          + `with a voxel — otherwise nothing can tell "solid ground here" from "nobody filled this in".`);
      }
      if (type === AIR_VOXEL) {
        throw violation(`"${name}" anchor ${i} stands at (${key}), which the blueprint declares as `
          + `'${AIR_VOXEL}'. An anchor names the block a body's FEET REST ON, so this asks a body to stand `
          + `on a hole: goToStand will demand feet at (${p[0]},${p[1] + 1},${p[2]}) with nothing under them, `
          + `the navigator will try to pillar into the cell the body is already in, and every approach to `
          + `every station this anchor owns will fail. Move the anchor DOWN one to the solid voxel beneath `
          + `the cell you meant as the stand.`);
      }
    });
  }
  return null;
}

// ── A PLEDGE-APPROVED BLUEPRINT IS A CLAIM ABOUT THE PLAN, AND THE PLAN IS CHECKED ──
// The label is explicit and granted deliberately — nothing here infers it, and a blueprint without it keeps
// the one-builder-per-anchor rule exactly as it was. What this function does is refuse a label the plan
// cannot honour, for the same reason the anchor-footing rule above is a load-time refusal: both facts are
// in the FILE, so they are knowable with no world, no server and no bot, and `preflight` loads this module.
//
// TWO PROPERTIES A PLEDGE-APPROVED PLAN MUST HOLD:
//   1. EXACTLY ONE ANCHOR. An anchor is a 5×5×5 cube and a second one STACKED above the first is precisely
//      the case where a body must pillar to reach it, digging its own footing out from under a peer. One
//      anchor is one ground-level stand, so there is no ladder for two bodies to fight over.
//   2. EVERY PLACED VOXEL RESTS ON SOMETHING THE PLAN DECLARES — the plan's own lowest layer, or another
//      voxel that is not air. The fleet releases a cell for claiming the moment the block BELOW it is
//      placed; a voxel floating over air is one no support will ever arrive for, so it would sit
//      permanently unclaimable while the board counted it as work and the crew stood in front of it. A
//      structure with an overhang is still perfectly buildable — it just may not carry this label.
function validatePledgeApproved(parsed) {
  for (const [name, building] of Object.entries(parsed.buildings)) {
    if (building.pledge_approved !== true) continue;
    const anchors = Array.isArray(building.anchors) ? building.anchors : [];
    if (anchors.length !== 1) {
      throw violation(`"${name}" is labelled pledge_approved but declares ${anchors.length} anchor(s). `
        + `A pledge-approved plan is built by every body at once from ground level, so it must be ONE anchor `
        + `— a cube stacked above another cube is the pillaring case the label exists to exclude. Either `
        + `remove the label, or make this a single-cube structure.`);
    }
    const plan = new Map();
    for (const a of anchors) for (const v of (a.voxels || [])) plan.set(`${v[0]},${v[1]},${v[2]}`, v[3]);
    for (const v of (building.unassigned_voxels || [])) plan.set(`${v[0]},${v[1]},${v[2]}`, v[3]);
    const lowestY = Math.min(...[...plan.keys()].map(k => Number(k.split(',')[1])));
    for (const [key, type] of plan) {
      if (type === AIR_VOXEL) continue;
      const [x, y, z] = key.split(',').map(Number);
      if (y === lowestY) continue;                       // the plan's own floor — the world holds it up
      const under = plan.get(`${x},${y - 1},${z}`);
      if (under !== undefined && under !== AIR_VOXEL) continue;
      throw violation(`"${name}" is labelled pledge_approved but its '${type}' voxel at (${key}) rests on `
        + `${under === undefined ? 'a cell the plan never declares' : `'${AIR_VOXEL}'`}. A pledge-approved plan `
        + `releases each cell for claiming once the block BELOW it is placed, so a voxel with nothing under it `
        + `can never become claimable: the board would count it as work forever and the crew would stand in `
        + `front of it. Give it a support voxel, or remove the label.`);
    }
  }
  return null;
}

// A throw out of `validate` reaches the caller as-is (createSnapshotRegistry does not catch), which is
// what lets the two messages above say the whole thing, each in its own words.
function violation(message) {
  return new Error(`[blueprint_registry] CODING VIOLATION (Law 13): ${message}`);
}

const registry = createSnapshotRegistry({
  filePath: BLUEPRINTS_PATH,
  fileName: 'building_blueprints.json',
  tag: 'blueprint_registry',
  validate: (parsed) => {
    if (!parsed.buildings || typeof parsed.buildings !== 'object') return 'has no "buildings" section';
    validateAnchorFooting(parsed);
    return validatePledgeApproved(parsed);
  },
});

// ── Accessors — the only way in ───────────────────────────────────────────────────────────────────

// The whole buildings section. Callers that iterate every blueprint use this.
function getBuildings() {
  return registry.data().buildings;
}

// One blueprint by name. A name that is not in the file is a Law 13 coding violation — the caller asked
// for something that does not exist, which no correct system does. `tag` names the caller so the throw
// reads as that caller's own.
function getBuilding(blueprintName, tag) {
  const building = registry.data().buildings[blueprintName];
  if (!building) {
    throw new Error(`[${tag || 'blueprint_registry'}] CODING VIOLATION: Blueprint "${blueprintName}" not found in building_blueprints.json.`);
  }
  return building;
}

// Absence-tolerant lookup for the one caller with a legitimate fallback (farming_integrity computes
// per-design constants at load and degrades to zeros when a blueprint is absent).
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

// MAY EVERY BODY BUILD THIS ONE AT ONCE? The one answer, read off the plan's own label (see
// `validatePledgeApproved`). Every caller that changes behaviour for a pledged build asks HERE — the
// board that sizes the seats, the manager that stages the load, the executor that claims the cells —
// so none of them can hold a different opinion about which structures the rule covers (Law 16).
// Unknown blueprint → false, and that is the safe direction: an unlabelled plan keeps the
// one-builder-per-anchor behaviour the fleet has always had.
function isPledgeApproved(blueprintName) {
  return tryGetBuilding(blueprintName)?.pledge_approved === true;
}

module.exports = { getBuildings, getBuilding, tryGetBuilding, isPledgeApproved, raw, bootHash, BLUEPRINTS_PATH };
