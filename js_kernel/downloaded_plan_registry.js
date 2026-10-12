// js_kernel/downloaded_plan_registry.js
// The ONE route from a DOWNLOADED build plan into the fleet (Law 16), and the one place the blueprint's
// own frame is converted into world coordinates. Every fragment that needs the castle's anchors, its
// ground floor, its descent lists or the volume navigation must treat as solid asks here; nothing else
// opens the file.
//
// ── WHY THIS IS NOT blueprint_registry ──────────────────────────────────────────────────────────────
// `building_blueprints.json` holds the fleet's OWN structures: hand-authored, few, small, written in
// GROUP vocabulary (`planks`, `structural_fill`), and shipped inside the bot because they are part of
// what the bot IS. A downloaded plan is the operator's input: one specific building somebody chose, named
// in concrete blocks, and large (a castle can span tens of thousands of voxels across hundreds of anchor
// cubes). Folding it into the blueprint registry would make every download a shipped file and every bot
// carry a building it was not asked to build.
//
// ── IT LOADS LAZILY, AND THAT IS LOAD-BEARING ───────────────────────────────────────────────────────
// `createSnapshotRegistry` snapshots at construction and throws on a missing file — correct for a
// declared file every bot needs, and wrong for one only a BUILDER crew needs: a require-time snapshot
// would crash every homesteader run on a machine with no plan on disk. So the snapshot is taken on the
// first `load()`, which only the builder path reaches. Everything the snapshot buys after that —
// one read, drift warned, never re-opened mid-run — is unchanged.
//
// ── THE FRAME, AND THE ONE CONVERSION ───────────────────────────────────────────────────────────────
// The plan is written in the BLUEPRINT's frame: x 0..w-1, z 0..l-1, y layer 0 = the blueprint's lowest
// layer. The world knows none of that. `siteFrame(site)` is the only conversion, built from the row the
// foreman locked when it sited the building (`lock_all_buildspots.runBuilderLayout` writes
// `footprint.corner` and `footprint.ground_floor_y`).
//
//   y   world y = ground_floor_y - ground_floor_layer + blueprint y. `ground_floor_y` is the ring-median
//       natural ground height the survey measured; `ground_floor_layer` is the layer of the blueprint the
//       planner identified as its ground floor. So the building's ground floor lands ON the ground.
//   xz  the blueprint's x lays along world x and its z along world z, always. The survey finds a plot for
//       the footprint as authored and there is no second orientation to find.
//
// `facingOf`, `axisOf` and `stateOf` ARE IDENTITIES, and are still exported: every caller already routes
// its positions, facings, axes and states through them, so an explicit, user-chosen facing later has ONE
// place to land.

'use strict';

const fs = require('fs');
const path = require('path');
const { createSnapshotRegistry } = require('@kernel/snapshot_registry');
const { violation } = require('@utils/external_library_guard');

const TAG = 'downloaded_plan_registry';
// `ground` carries the ground floor; the anchors cover the whole box. A plan declaring a different schema
// is refused at load, and the refusal names the rebuild command.
const SCHEMA = 'auren.build_plan.v3';

// The clockwise compass, matching facing_aim's own `H`. A quarter turn is one step along it.
const COMPASS = ['north', 'east', 'south', 'west'];

let registry = null;      // the snapshot, once taken
let loadedFrom = null;    // the absolute path it was taken from

// planPathFor(buildName) — where the plan for a named build is expected to be.
//
// THE PATH IS THE OPERATOR'S, NOT THE BOT'S. `foreman_config.builder.plan` names it and the environment
// overrides that, the same shape `serverFolder` already uses for the one other thing that lives outside
// this repository. The default is the folder `Auren_Workshop/tools/plan_blueprint.js` writes into, so a
// plan made with the workshop is found with nothing to configure; a download somebody put elsewhere is
// one field away.
function planPathFor(buildName) {
  const configured = require('../foreman_config').builder?.plan;
  if (configured) return path.resolve(configured);
  // Two levels up from js_kernel is the repository root, which is where the workshop writes.
  return path.resolve(__dirname, '..', '..', 'html and json', 'Downloaded_Blueprints', `${buildName}.build_plan.json`);
}

// validate — the shape a plan must have before anything is built from it. Every field named here is one
// a consumer below reads without checking again (Law 26: validated at startup, then trusted).
function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'is not an object';
  if (parsed.schema !== SCHEMA) return `declares schema "${parsed.schema}" and the fleet builds ${SCHEMA} — rebuild it with Auren_Workshop/tools/plan_blueprint.js`;
  if (!parsed.dimensions || !Number.isInteger(parsed.dimensions.w) || !Number.isInteger(parsed.dimensions.h) || !Number.isInteger(parsed.dimensions.l)) return 'has no dimensions';
  if (!parsed.ground || !Number.isInteger(parsed.ground.ground_floor_layer)) return 'has no ground.ground_floor_layer';
  if (!Number.isInteger(parsed.ground.entry_feet_below)) return 'has no ground.entry_feet_below';
  // The building's iron-to-stone ratio is part of the plan: the gather is measured against it.
  if (!parsed.material_ratio || !Number.isFinite(parsed.material_ratio.cobblestone)) return 'has no material_ratio — rebuild it with Auren_Workshop/tools/plan_blueprint.js';
  if (!Array.isArray(parsed.anchors) || parsed.anchors.length === 0) return 'carries no anchors';
  if (!Array.isArray(parsed.columns) || parsed.columns.length === 0) return 'carries no columns';
  for (const col of parsed.columns) {
    if (!Array.isArray(col.anchors) || !Array.isArray(col.descent)) return `column ${col.column} is missing its anchors or its descent`;
    // A column with no stand cannot be worked at all: the pass enters from beneath the box through the stand
    // column and has no second way in. The anchor calculator reports these in `columns_without_a_stand`,
    // and the plan is refused (Law 13, Law 25).
    if (!Array.isArray(col.stand) || col.stand.length !== 2) return `column ${col.column} has no stand column — the plan cannot be worked as written`;
  }
  return null;
}

// load(buildName) — take the snapshot, once. Returns the plan. A second call with the same build returns
// the same snapshot; a call naming a DIFFERENT build is a coding violation, because one run builds one
// building and two plans in one process is two answers to one question (Law 16).
function load(buildName) {
  const file = planPathFor(buildName);
  if (registry) {
    if (loadedFrom !== file) {
      throw violation(TAG, `a plan is already loaded from ${loadedFrom} and "${buildName}" asks for ${file}. One run builds one building.`);
    }
    return registry.data();
  }
  if (!fs.existsSync(file)) {
    // A CORRECTION, NOT A BARE THROW (Law 13): the operator supplied this, so the message says what is
    // wrong, why, and the exact form that would have worked.
    throw violation(TAG, `no build plan for "${buildName}" at ${file}. `
      + `A downloaded building is built from a PLAN, which is made once from the import: `
      + `node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=${buildName}. `
      + `If the plan lives somewhere else, name its path in foreman_config.builder.plan (or AUREN_BUILD_PLAN).`);
  }
  registry = createSnapshotRegistry({ filePath: file, fileName: path.basename(file), tag: TAG, validate });
  loadedFrom = file;
  const plan = registry.data();
  if (plan.name !== buildName) {
    throw violation(TAG, `${file} is the plan for "${plan.name}" and the run was told to build "${buildName}".`);
  }
  verifyPlaceable(plan);
  agreesWithTheSurvey(plan, buildName);
  supports = computeSupports(plan, fullBlock(plan.server_version));
  return plan;
}

// ── WHAT HOLDS EACH BLOCK UP WHILE IT GOES IN ───────────────────────────────────────────────────────
// support_plan reads the plan once at load. supportsOf(anchorIndex) → Map(blueprint cell 'x,y,z' → helpers) for
// the blocks of that cube whose support is not guaranteed to stand first; supportSummary() → the counts.
let supports = null;
const { computeSupports } = require('@kernel/support_plan');
function fullBlock(version) {
  const mc = require('minecraft-data')(version);
  return (name) => { const d = mc.blocksByName[name]; return !!d && d.boundingBox === 'block'; };
}
function supportsOf(anchorIndex) {
  getPlan();
  return supports.helpers.get(anchorIndex) || null;
}
function supportSummary() {
  getPlan();
  return { ...supports.counts, stranded: supports.stranded.slice() };
}
// materialRatio — the plan's own iron-to-stone statement (plan_blueprint writes it).
function materialRatio() { return getPlan().material_ratio; }

// agreesWithTheSurvey — the plan and the SITE SURVEY describe one building, so they must say the same
// things about it. The foreman sites the plot before any body exists, from `architect_config.BUILDER_BUILDS`
// — it has no bot yet to read a plan file with. So there are two statements of the footprint and the pit
// depth in the fleet: a re-plan with a different blueprint, a different stair, or a taller basement would
// otherwise be surveyed at the old numbers and built at the new ones, and the first sign of it would be a
// column standing in ground nobody cleared.
//
// A REFUSAL, NOT A CORRECTION. Which of the two is right is not this module's to decide — the plan may be
// the new truth and the config stale, or the config may be what the operator wants and the plan made from
// the wrong blueprint. Both are named, and the run stops (Law 25).
function agreesWithTheSurvey(plan, buildName) {
  const spec = require('@thinking/architect_config').BUILDER_BUILDS[buildName];
  if (!spec) return;                       // architect_config's own load-time assert owns that question
  const said = [
    ['width', spec.w, plan.dimensions.w],
    ['length', spec.l, plan.dimensions.l],
    ['layers below the ground floor', spec.below, plan.ground.layers_below_ground_floor],
    ['blocks', spec.blocks, plan.blocks_built],
  ].filter(([, a, b]) => a !== b);
  if (!said.length) return;
  const lines = said.map(([what, a, b]) => `  • ${what}: the survey is set up for ${a}, the plan is ${b}`).join('\n');
  throw violation(TAG, `${buildName}'s plan and the plot the foreman surveys for disagree:\n${lines}\n`
    + 'Both describe one building. Put the plan\'s numbers into architect_config.BUILDER_BUILDS, or re-make the '
    + 'plan from the blueprint the config describes.');
}

// verifyPlaceable — every voxel that asks for a STATE has a placement rule that can give it, checked at
// the stopped→running boundary (Law 26: load, assert, then trust). Without this, one block family the
// fleet has never measured is a Law 13 throw deep into a build, from inside the one bot that happened to
// reach that cube. As a startup check it is a refusal that names the block, before the world is even
// raised.
//
// REPORTS THE WHOLE SET, NOT THE FIRST ONE: a plan with several unknown families would otherwise take
// several runs to learn about, and the measurement that fixes them is one sitting at a live server.
function verifyPlaceable(plan) {
  const { unplaceableReason } = require('@utils/movement/facing_aim');
  const problems = new Map();
  for (const anchor of plan.anchors) {
    for (const v of anchor.voxels) {
      if (!v[4]) continue;
      const why = unplaceableReason(v[3], v[4]);
      if (why && !problems.has(why)) problems.set(why, `(${v[0]},${v[1]},${v[2]})`);
    }
  }
  if (!problems.size) return;
  const lines = [...problems].map(([why, at]) => `  • ${why} first at blueprint ${at}`).join('\n');
  throw violation(TAG, `${plan.name} asks for ${problems.size} block state(s) the fleet has no placement rule for:\n${lines}\n`
    + 'Each rule is measured on a live server and added to js_kernel/utils/movement/facing_aim.js.');
}

function isLoaded() { return registry !== null; }

// getPlan — for a caller that has already been through `load`. A caller reaching here before the plan is
// loaded is a startup-order fault, not an operator mistake, so it throws in its own name.
function getPlan() {
  if (!registry) throw violation(TAG, 'a plan was asked for before any was loaded. The builder start step calls load() once, before any job is posted.');
  return registry.data();
}

// ── THE FRAME ───────────────────────────────────────────────────────────────────────────────────────
// siteFrame(site) → { worldOf, facingOf, axisOf, stateOf, blockOf, wood, groundFloorLayer, groundFloorY, footprint }
//
// `site` is the locked row: `hq.readBuildingChair(build, 'set_buildspot')`. It must carry the footprint
// the foreman wrote — the corner and the ground-floor height are the whole conversion, and a row without
// them cannot place a single block (Law 13: a missing field throws, it is not defaulted).
//
// NO TURN: THE PLAN IS PLACED THE WAY IT IS AUTHORED, AND THAT IS THE ONLY WAY IT IS PLACED. The frame is
// the identity at rotation 0: a blueprint offset plus the footprint corner, nothing rotated.
//
// ── THIS THROW IS THE FLEET'S ONLY SITING CHECK BELOW THE FOREMAN ─────────
// Whether a structure is sited is asked once, by the foreman, before any body exists (the step "every
// structure this crew builds is sited"). If a body reaches this line unsited anyway, it crashes here with
// the sentence that names who was accountable. One check at the top, one crash at the bottom, nothing in
// between.
function siteFrame(site) {
  const plan = getPlan();
  const f = site && site.footprint;
  if (!f || !f.corner || !Number.isFinite(f.corner.x) || !Number.isFinite(f.corner.z) || !Number.isFinite(f.ground_floor_y)) {
    throw violation(TAG, `the locked row for "${plan.name}" carries no footprint corner and ground_floor_y, so its blueprint frame cannot be placed in the world. `
      + 'The foreman sites every structure before it spawns a body and writes both when it does '
      + '(lock_all_buildspots.runBuilderLayout, proved in the foreman step "every structure this crew builds is sited"). '
      + 'A body reaching this line means that step passed on a row it should have refused — fix the foreman, not this call.');
  }
  const G = plan.ground.ground_floor_layer;
  const w = plan.dimensions.w;
  const baseY = f.ground_floor_y - G;

  const worldOf = (bx, by, bz) => ({ x: f.corner.x + bx, y: baseY + by, z: f.corner.z + bz });

  // A facing and an axis are placed exactly as the plan states them.
  const facingOf = (dir) => dir;
  const axisOf = (a) => a;

  // stateOf — the plan's state object, unchanged. Nothing about a placed block moves any more.
  const stateOf = (state) => state || null;

  // blockOf — the block the WORLD must show for a plan's block name: the plan's wood swapped for the
  // site's. Every reader of a voxel's name goes through this, exactly as every reader of a position goes
  // through worldOf, so a column's order, its done-test and its placement ask about the same block.
  const wood = siteWood();
  const planWood = plan.material_rule && plan.material_rule.wood;
  // Iron's blocks that copper also makes are built of copper (architect_config.COPPER_FOR_IRON).
  const { COPPER_FOR_IRON } = require('@thinking/architect_config');
  // Below the ground floor the plan's stone is ground, and ground a body dug is put back as cobblestone: the
  // rock as the pickaxe gives it, with no furnace between. `by` is the voxel's own layer.
  const blockOf = (name, by) => {
    if (!Number.isInteger(by)) throw violation(TAG, `blockOf("${name}", ${by}) needs the voxel's layer — the same block is built differently below the ground floor.`);
    if (by < G && name === 'stone') return 'cobblestone';
    return COPPER_FOR_IRON[name]
      || (wood && planWood && wood !== planWood && name.startsWith(`${planWood}_`)
        ? `${wood}${name.slice(planWood.length)}`
        : name);
  };

  // holds — does the world block `at` satisfy voxel v = [x, y, z, name, state]? Below the ground floor a natural
  // target is satisfied by any natural block: that is ground, and the plan's rock there is the ground it was cut
  // from. From the ground floor up every block is exact, since a stone's kind is the building's colour.
  const NATURAL = new Set(require('@utils/fragment_utils').group_to_item.natural_block);
  if (!NATURAL.size) throw violation(TAG, 'group_to_item.natural_block is empty, so no ground below the ground floor could ever read as correct.');
  const { standsFor } = require('@utils/movement/facing_aim');
  const GROWN_DIRT = new Set(['grass_block', 'mycelium']);
  const holds =(v, at) => {
    const want = blockOf(v[3], v[1]);
    if (v[1] < G && NATURAL.has(v[3]) && (NATURAL.has(at.name) || at.name.endsWith('_ore'))) return true;
    // Placed dirt grows over under open sky (blueprint_material_rule places every soil as dirt for that reason),
    // so the grown block is the dirt the plan asked for.
    if (want === 'dirt' && GROWN_DIRT.has(at.name)) return true;
    // Copper weathers where it stands, and the plan's own iron block is the block it asked for.
    const copper = !!COPPER_FOR_IRON[v[3]];
    const standing = copper ? at.name.replace(/^(waxed_)?(exposed_|weathered_|oxidized_)?/, '') : at.name;
    if (standing !== want && !(copper && at.name === v[3])) return false;
    const state = stateOf(v[4]);
    return !state || standsFor(at, state);
  };

  return {
    groundFloorLayer: G, groundFloorY: f.ground_floor_y, footprint: f,
    worldOf, facingOf, axisOf, stateOf, blockOf, holds, wood,
  };
}

// ── THE WOOD IS THE SITE'S, NOT THE PLAN'S ──────────────────────────────────────────────────────────
// siteWood() → 'oak' | 'birch' | 'dark_oak' | … , or null while the fleet has not decided.
//
// A plan names ONE species for every wooden block (blueprint_material_rule collapses the rest into it),
// and a species is only buildable where it GROWS: every log, every plank-shaped block and every leaf
// comes off a tree the crew can reach. The fleet sites only in ACCEPTABLE_BIOMES — plains, forests, birch
// and dark forest — so a plan's own species can be one that never grows there, and every voxel of it would
// have no source and sit ordered forever.
//
// So the one species stays ONE, and which one is read off the site: the fleet's own wood preference, the
// species with the most trunks around the base (set_wood_preference, decided once and never re-posted).
// That is the species the felling ladder already reaches for first, so the log the order asks for is the
// log the crew is cutting. NULL WHILE UNDECIDED: the column phase waits on it, so no column builds in the
// plan's wood while the rest build in the site's.
//
// A species the recipe book has no planks for is refused here: every shape of it would read as a raw
// gather no surface scan can fill.
function siteWood() {
  const pref = require('@action/set_wood_preference').readWoodPreference();
  if (!pref || !pref.species) return null;
  const wood = pref.species.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '');
  const { group_to_item } = require('@utils/fragment_utils');
  if (!(group_to_item.planks || []).includes(`${wood}_planks`)) {
    throw violation(TAG, `the fleet's wood preference is ${pref.species}, and the recipe book has no ${wood}_planks — `
      + 'a downloaded building cannot be made of a wood the fleet never crafts. Add the species to the wood groups in '
      + 'js_kernel/utils/fragment_utils.js, or site the build where a crafted wood grows.');
  }
  return wood;
}

// ── THE BOX IS SOLID TO NAVIGATION ONCE THE TREES ARE DOWN ────────────────────────────────────────
// closedBox() → { min:{x,y,z}, max:{x,y,z} } in world coordinates, or null while nothing is closed. The
// route search deletes every cell inside it from the graph (pathfinding_utils `forbidden`), for every
// body whatever its job — so a route to a column's foot can only come from UNDER the box, and a body
// inside a column can only leave down its own shaft (the search exempts the column its start stands in;
// see there).
//
// CLOSED FROM THE MOMENT THE TREE LATCH CLOSES AND NEVER REOPENED. Before it, the fellers must walk the
// site to reach the trunks, so the box is open ground. After it, nothing but the column pass has business
// inside, during the build and after it. The latch is asked through `assessors/shared`, its one owner
// (Law 16).
//
// NULL, NOT A THROW, when no plan is loaded: a homesteader or contractor process never loads one and has
// no box.
function closedBox() {
  if (!registry) return null;
  const plan = registry.data();
  const hq = require('@kernel/corporate_headquarters');
  const row = hq.readBuildingChair(plan.name, 'set_buildspot');
  if (!row || !row.footprint || !row.footprint.corner) return null;
  if (!require('@thinking/assessors/shared').siteTreePhaseDone(plan.name)) return null;
  const f = siteFrame(row);
  const lo = f.worldOf(0, 0, 0);
  const hi = f.worldOf(plan.dimensions.w - 1, plan.dimensions.h - 1, plan.dimensions.l - 1);
  return { min: lo, max: hi };
}

// The plan's own sections, so a reader never indexes the document itself.
const anchors = () => getPlan().anchors;
const columns = () => getPlan().columns;
const ground = () => getPlan().ground;
const dimensions = () => getPlan().dimensions;

module.exports = { load, isLoaded, getPlan, planPathFor, siteFrame, siteWood, closedBox, anchors, columns, ground, dimensions, supportsOf, supportSummary, materialRatio, SCHEMA };
