// js_kernel/downloaded_plan_registry.js
// The ONE route from a large-building plan into the fleet (Law 16), and the one place the blueprint's
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
// declared file every bot needs, and wrong for an operator plan only a selected crew needs. The first
// load snapshots that file, or derives a native structure's cubes from blueprint_registry's snapshot.
// Source edits are warned by their owning registry and apply on the next start.
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
const SCHEMA = 'auren.build_plan.v4';

// The clockwise compass, matching facing_aim's own `H`. A quarter turn is one step along it.
const COMPASS = ['north', 'east', 'south', 'west'];

let registry = null;      // the snapshot, once taken
let loadedFrom = null;    // the absolute path it was taken from
let view = null;          // the snapshot with every block whose producer is not ready set aside (setAside)

// planPathFor(buildName) — where the plan for a named build is expected to be.
//
// THE PATH IS THE OPERATOR'S, NOT THE BOT'S. `foreman_config.builder.plan` names it and the environment
// overrides that, the same shape `serverFolder` already uses for the one other thing that lives outside
// this repository. The default is the folder `Auren_Workshop/tools/plan_blueprint.js` writes into, so a
// plan made with the workshop is found with nothing to configure; a download somebody put elsewhere is
// one field away.
function planPathFor(buildName) {
  if (require('@thinking/architect_config').BUILDER_BUILDS[buildName]?.blueprint) return require('@kernel/blueprint_registry').BLUEPRINTS_PATH;
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
  // Each cube's trash is the peak its trip stands (cube_trash_need), the figure its price is built on.
  const untrashed = parsed.anchors.find(a => !Number.isInteger(a.trash) || a.trash < 0);
  if (untrashed) return `anchor ${untrashed.index} carries no trash figure — rebuild it with Auren_Workshop/tools/plan_blueprint.js`;
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
    if (loadedFrom !== file || view.name !== buildName) {
      throw violation(TAG, `a plan is already loaded from ${loadedFrom} and "${buildName}" asks for ${file}. One run builds one building.`);
    }
    registry.data();
    return view;
  }
  if (!fs.existsSync(file)) {
    // A CORRECTION, NOT A BARE THROW (Law 13): the operator supplied this, so the message says what is
    // wrong, why, and the exact form that would have worked.
    throw violation(TAG, `no build plan for "${buildName}" at ${file}. `
      + `A downloaded building is built from a PLAN, which is made once from the import: `
      + `node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=${buildName}. `
      + `If the plan lives somewhere else, name its path in foreman_config.builder.plan (or AUREN_BUILD_PLAN).`);
  }
  const config = require('@thinking/architect_config'), sourceName = config.BUILDER_BUILDS[buildName]?.blueprint;
  if (sourceName) {
    const sourceRegistry = require('@kernel/blueprint_registry');
    const planned = require('@kernel/blueprint_plan_calculator').calculatePlan(sourceRegistry.getBuilding(sourceName), {
      name: buildName, schema: SCHEMA, preserveSource: true, serverVersion: config.SERVER_MINECRAFT_VERSION,
      wood: config.BUILD_WOOD.primary, accent: config.BUILD_WOOD.accent, leaves: true, recolour: config.COLOR_SWAP,
      substitutions: config.BUILDER_BUILDS[buildName].substitutions, beds: config.BUILDER_BUILDS[buildName].beds,
    });
    const error = validate(planned); if (error) throw violation(TAG, `${sourceName} ${error}.`);
    // The source registry owns the snapshot and drift warnings; the cube plan is a derived view of that source.
    registry = { data() { sourceRegistry.getBuilding(sourceName); return planned; } };
  } else registry = createSnapshotRegistry({ filePath: file, fileName: path.basename(file), tag: TAG, validate });
  loadedFrom = file;
  const plan = setAside(registry.data());
  view = plan;
  if (plan.name !== buildName) {
    throw violation(TAG, `${file} is the plan for "${plan.name}" and the run was told to build "${buildName}".`);
  }
  verifyPlaceable(plan);
  sameColourSwap(plan);
  agreesWithTheSurvey(plan, buildName);
  supports = computeSupports(plan, fullBlock(plan.server_version));
  return plan;
}

// ── A BLOCK WHOSE PRODUCER DOES NOT STAND YET IS SET ASIDE ──────────────────────────────────────────
// The plan keeps every block a producer makes beyond the base materials (blueprint_material_rule's awaiting
// family). While that producer is not ready (producer_hooks), its blocks are taken out of the cubes and the
// descents, so each such cell is an air target and nothing orders the block; every reader of the plan sees the
// building without them. Said once per producer at load. A kept block is emptied of the states its producer names
// (producer_hooks.emptied): it is placed as the fleet places it.
//
// A HALF WHOSE PARTNER THE DOWNLOAD DOES NOT CARRY IS SET ASIDE FOR GOOD (orphanHalves): a bed head with no foot
// behind it, a bed foot with no head before it, a door's top with no bottom under it. The game places a bed by its
// foot and a door by its bottom, the second half coming with the first (facing_aim), so such a cell is one no body
// can ever build, and its cube would never stand. Built as air, said once at load.
const BED_DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
function orphanHalves(plan) {
  const at = new Map();
  for (const a of plan.anchors) for (const v of a.voxels) at.set(`${v[0]},${v[1]},${v[2]}`, v);
  const holds = (x, y, z, test) => { const w = at.get(`${x},${y},${z}`); return !!w && test(w[3], w[4] || {}); };
  const orphans = new Set();
  for (const v of at.values()) {
    const s = v[4] || {};
    const d = BED_DIRS[s.facing];
    if (/_bed$/.test(v[3]) && d) {
      const partner = s.part === 'head' ? [v[0] - d[0], v[1], v[2] - d[1], 'foot'] : [v[0] + d[0], v[1], v[2] + d[1], 'head'];
      if (!holds(partner[0], partner[1], partner[2], (n, t) => n === v[3] && t.part === partner[3] && t.facing === s.facing)) orphans.add(`${v[0]},${v[1]},${v[2]}`);
    }
    if (/_door$/.test(v[3]) && s.half === 'upper' && !holds(v[0], v[1] - 1, v[2], (n, t) => n === v[3] && t.half === 'lower')) orphans.add(`${v[0]},${v[1]},${v[2]}`);
  }
  return orphans;
}

function setAside(plan) {
  const { awaits, producerOf, emptied } = require('@kernel/producer_hooks');
  const aside = {};
  const orphans = orphanHalves(plan);
  const orphan = (v) => orphans.has(`${v[0]},${v[1]},${v[2]}`);
  const counted = (v) => {
    if (orphan(v)) return false;
    if (!awaits(v[3])) return true;
    const k = producerOf(v[3]); aside[k] = (aside[k] || 0) + 1; return false;
  };
  const kept = (v) => !awaits(v[3]) && !orphan(v);
  const out = {
    ...plan,
    anchors: plan.anchors.map(a => ({ ...a, voxels: a.voxels.filter(counted).map(emptied) })),
    columns: plan.columns.map(c => ({ ...c, descent: c.descent.filter(kept).map(emptied) })),
  };
  const watcher = require('@kernel/watcher');
  for (const [name, n] of Object.entries(aside)) {
    watcher.summary(TAG, `SET_ASIDE producer=${name} blocks=${n} — built as air until the producer stands (producer_hooks)`);
  }
  if (orphans.size) watcher.summary(TAG, `SET_ASIDE orphan_halves=${orphans.size} cells=${[...orphans].slice(0, 8).join('|')} — a two-cell half whose partner the download does not carry, built as air`);
  return out;
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
// blockCounts() → { name: count } of every block the whole plan places, the set-aside blocks included: what the
// building asks for in all, before any of it stands (calculators/cane_critical_mass sizes the cane fields by it).
function blockCounts() {
  getPlan();
  const counts = {};
  const add = (v) => { counts[v[3]] = (counts[v[3]] || 0) + 1; };
  for (const a of registry.data().anchors) a.voxels.forEach(add);
  for (const c of registry.data().columns) c.descent.forEach(add);
  return counts;
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
  registry.data();
  return view;
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

  // blockOf — the block the WORLD must show for a plan's block name. Every reader of a voxel's name goes through
  // this, exactly as every reader of a position goes through worldOf, so a column's order, its done-test and its
  // placement ask about the same block. The wood is the plan's own (siteWood).
  const wood = siteWood();
  // Iron's blocks that copper also makes are built of copper (architect_config.COPPER_FOR_IRON).
  const { COPPER_FOR_IRON } = require('@thinking/architect_config');
  // Below the ground floor the plan's stone is ground, and ground a body dug is put back as cobblestone: the
  // rock as the pickaxe gives it, with no furnace between. `by` is the voxel's own layer.
  const blockOf = (name, by) => {
    if (!Number.isInteger(by)) throw violation(TAG, `blockOf("${name}", ${by}) needs the voxel's layer — the same block is built differently below the ground floor.`);
    if (by < G && name === 'stone') return 'cobblestone';
    return COPPER_FOR_IRON[name] || name;
  };
  // voxelBlock(v) / voxelState(v) — the block and state a trip builds for voxel v = [x, y, z, name, state]: blockOf's,
  // except a STAND-IN block (architect_config.STAND_INS) in a cube not yet paid for (standIns), built as the site
  // wood's planks with no state. Every reader that orders, places or tests a cell asks these; the building's whole
  // bill (assessors/downloaded_build castleBalance) asks blockOf, since the real block is still owed.
  const { STAND_INS } = require('@thinking/architect_config');
  const stoodIn = (v) => !!STAND_INS[v[3]] && !standIns(frame).real.has(standInCubeOf(v));
  const voxelBlock = (v) => (stoodIn(v) ? `${wood}_planks` : blockOf(v[3], v[1]));
  const voxelState = (v) => (stoodIn(v) ? null : stateOf(v[4]));

  // holds — does the world block `at` satisfy voxel v = [x, y, z, name, state]? Below the ground floor a natural
  // target is satisfied by any natural block: that is ground, and the plan's rock there is the ground it was cut
  // from. From the ground floor up every block is exact, since a stone's kind is the building's colour.
  const NATURAL = new Set(require('@utils/fragment_utils').group_to_item.natural_block);
  if (!NATURAL.size) throw violation(TAG, 'group_to_item.natural_block is empty, so no ground below the ground floor could ever read as correct.');
  const { standsFor } = require('@utils/movement/facing_aim');
  const GROWN_DIRT = new Set(['grass_block', 'mycelium']);
  const holds =(v, at) => {
    // A stood-in cell holds its planks, and the real block once it stands, whichever the cube's books say now.
    if (STAND_INS[v[3]] && at.name === `${wood}_planks`) return stoodIn(v);
    const want = blockOf(v[3], v[1]);
    if (v[1] < G && NATURAL.has(v[3]) && (NATURAL.has(at.name) || at.name.endsWith('_ore'))) return true;
    // Placed dirt grows over under open sky (blueprint_material_rule places every soil as dirt for that reason),
    // so the grown block is the dirt the plan asked for.
    if (want === 'dirt' && GROWN_DIRT.has(at.name)) return true;
    // Copper weathers where it stands, and the plan's own iron block is the block it asked for.
    const { unaged } = require('@utils/fragment_utils');
    if (unaged(at.name) !== unaged(want) && !(COPPER_FOR_IRON[v[3]] && at.name === v[3])) return false;
    const state = stateOf(v[4]);
    return !state || standsFor(at, state);
  };

  const frame = {
    groundFloorLayer: G, groundFloorY: f.ground_floor_y, footprint: f,
    worldOf, facingOf, axisOf, stateOf, blockOf, voxelBlock, voxelState, holds, wood,
  };
  return frame;
}

// ── WHICH CUBES OF STOOD-IN BLOCKS ARE PAID FOR ───────────────────────────────────────────────────────────
// standInCubeOf(v) → the anchor index of the cube whose voxels hold v, or null (a stand shaft's own voxel).
// standIns(frame) → { real: Set(anchor index), owed, reached }, read again every STAND_IN_READ_MS:
//   owed     the books every stood-in cell not yet holding its real block is made of (STAND_INS books)
//   reached  the books the fleet reaches, a bookshelf or lectern counted as the books it is made of
//   real     the cubes built of the real block: taken in build order, each while `reached` still pays for every
//            stood-in cell of it not yet real, and the first cube it does not pay for ends the walk, so the books
//            gather for the next cube in line. A cube whose cells are all real is real and costs nothing.
// A process with no body (the foreman's keeper) reads no cube as paid for: planks or the real block both hold.
const STAND_IN_READ_MS = 5000;
let _standInCells = null;   // { plan, cubeOf: Map("x,y,z" → index), cubes: [{ index, cells: [v] }] }
let _standIns = { at: 0, real: new Set(), owed: 0, reached: 0 };
function standInCells() {
  const plan = getPlan();
  if (_standInCells && _standInCells.plan === plan.name) return _standInCells;
  const { STAND_INS } = require('@thinking/architect_config');
  const cubeOf = new Map(), cubes = [];
  for (const anchor of [...plan.anchors].sort((a, b) => a.layer - b.layer || a.index - b.index)) {
    const cells = anchor.voxels.filter(v => STAND_INS[v[3]]);
    for (const v of cells) cubeOf.set(`${v[0]},${v[1]},${v[2]}`, anchor.index);
    if (cells.length) cubes.push({ index: anchor.index, cells });
  }
  _standInCells = { plan: plan.name, cubeOf, cubes };
  return _standInCells;
}
function standInCubeOf(v) {
  const i = standInCells().cubeOf.get(`${v[0]},${v[1]},${v[2]}`);
  return i === undefined ? null : i;
}
function standIns(frame) {
  const now = Date.now();
  if (now - _standIns.at < STAND_IN_READ_MS) return _standIns;
  const bot = global.bot;
  const next = { at: now, real: new Set(), owed: 0, reached: 0 };
  if (!bot || typeof bot.blockAt !== 'function' || !frame) { _standIns = next; return next; }
  const Vec3 = require('vec3');
  const { STAND_INS } = require('@thinking/architect_config');
  const lens = require('@kernel/inventory_lens');
  next.reached = lens.reachableByFleet('book')
    + Object.entries(STAND_INS).reduce((n, [name, s]) => n + s.books * lens.reachableByFleet(name), 0);
  let left = next.reached, open = true;
  for (const cube of standInCells().cubes) {
    let owed = 0;
    for (const v of cube.cells) {
      const p = frame.worldOf(v[0], v[1], v[2]);
      const at = bot.blockAt(new Vec3(p.x, p.y, p.z));
      if (!at || at.name !== frame.blockOf(v[3], v[1])) owed += STAND_INS[v[3]].books;
    }
    next.owed += owed;
    if (owed === 0 || (open && owed <= left)) { next.real.add(cube.index); left -= owed; }
    else open = false;
  }
  _standIns = next;
  return next;
}
// standInsAtSite() → standIns on this body's own site frame, or null while no plan is loaded or the site is unlocked.
function standInsAtSite() {
  if (!registry) return null;
  const row = require('@kernel/corporate_headquarters').readBuildingChair(registry.data().name, 'set_buildspot');
  if (!row || !row.footprint || !row.footprint.corner) return null;
  return standIns(siteFrame(row));
}

// ── THE WOOD IS THE FLEET'S TWO: OAK, WITH BIRCH ACCENTS ────────────────────────────────────────────────
// siteWood() → the primary species the loaded plan is built of ('oak'), or null while no plan is loaded.
//
// A plan builds its download's most-used wood as the primary and every other wood as the accent
// (blueprint_material_rule), both fixed fleet-wide (architect_config.BUILD_WOOD). A plan made in other woods is
// refused here, so the woods the crew fells and replants are the woods the plan asks for. The primary's saplings
// are the ones the crew plants beside the yard (sapling_planter), and the base is sited where oak grows
// (architect_config.BASE_BIOMES).
function siteWood() {
  if (!registry) return null;
  const plan = registry.data();
  const { BUILD_WOOD } = require('@thinking/architect_config');
  const m = plan.material_rule || {};
  if (m.wood !== BUILD_WOOD.primary || m.accent !== BUILD_WOOD.accent) {
    throw violation(TAG, `plan "${plan.name}" is built of ${m.wood} with ${m.accent} accents, and the fleet builds of ${BUILD_WOOD.primary} with `
      + `${BUILD_WOOD.accent} accents (architect_config.BUILD_WOOD). Regenerate it: node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js `
      + `"html and json/Downloaded_Blueprints/downloaded_blueprints.json" --name=${plan.name}`);
  }
  return m.wood;
}

// ── A PLAN IS MADE WITH THE FLEET'S COLOUR SWAP ─────────────────────────────────────────────────────
// The swap is made when the plan is made (blueprint_material_rule), so a plan made with another table, or with
// none, still asks for a far colour. It is refused here with the command that makes it again.
function sameColourSwap(plan) {
  const { COLOR_SWAP } = require('@thinking/architect_config');
  const flat = (o) => JSON.stringify(Object.entries(o || {}).sort());
  const m = plan.material_rule || {};
  if (flat(m.recolour) !== flat(COLOR_SWAP)) {
    throw violation(TAG, `plan "${plan.name}" was made with the colour swap ${flat(m.recolour)}, and the fleet swaps ${flat(COLOR_SWAP)} `
      + `(architect_config.COLOR_SWAP). Regenerate it: node Auren_Bot/Auren_Workshop/tools/plan_blueprint.js `
      + `"html and json/Downloaded_Blueprints/downloaded_blueprints.json" --name=${plan.name}`);
  }
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
// NULL, NOT A THROW, when no plan is loaded: a homesteader process never loads one and has
// no box.
// AN AUTHORED HOME OPENS ONCE IT STANDS: its design_intent names rooms and stands to walk to, so while the assessor's last sweep
// reads every cube standing, its box is ordinary ground under its own protected voxels. Damage closes it again for the column pass.
let _standing = false;
function noteStanding(stands) { _standing = stands; }
function standing() { return _standing; }
function closedBox() {
  if (!registry) return null;
  const plan = registry.data();
  if (_standing && plan.design_intent?.workstations) return null;
  const hq = require('@kernel/corporate_headquarters');
  const row = hq.readBuildingChair(plan.name, 'set_buildspot');
  if (!row || !row.footprint || !row.footprint.corner) return null;
  if (!require('@thinking/assessors/shared').siteTreePhaseDone(plan.name)) return null;
  const f = siteFrame(row);
  const lo = f.worldOf(0, 0, 0);
  const hi = f.worldOf(plan.dimensions.w - 1, plan.dimensions.h - 1, plan.dimensions.l - 1);
  return { min: lo, max: hi };
}

// ── THE BUILDING'S OWN LOGS ARE NEVER A TREE ────────────────────────────────────────────────────────
// buildWoodCells() → Map of world "x,y,z" → the log the plan stands there, or null while no plan is loaded
// or sited. Read off the plan and the locked row alone, so it answers the same for every body whether or
// not that body's tree latch has closed: a census or a feller asking "is this log a tree" asks here first.
const BUILD_LOG = /(.*_)?log$/;
let _buildWood = null;   // { key, cells }
function buildWoodCells() {
  if (!registry) return null;
  const plan = registry.data();
  const row = require('@kernel/corporate_headquarters').readBuildingChair(plan.name, 'set_buildspot');
  if (!row || !row.footprint || !row.footprint.corner) return null;
  const f = siteFrame(row);
  const key = `${plan.name}@${row.footprint.corner.x},${row.footprint.ground_floor_y},${row.footprint.corner.z}:${f.wood}`;
  if (_buildWood && _buildWood.key === key) return _buildWood.cells;
  const cells = new Map();
  const add = (bx, by, bz, name) => {
    const block = f.blockOf(name, by);
    if (!BUILD_LOG.test(block)) return;
    const p = f.worldOf(bx, by, bz);
    cells.set(`${p.x},${p.y},${p.z}`, block);
  };
  for (const anchor of plan.anchors) for (const v of anchor.voxels) add(v[0], v[1], v[2], v[3]);
  for (const column of plan.columns) for (const v of column.descent) add(column.stand[0], v[1], column.stand[1], v[3]);
  _buildWood = { key, cells };
  return cells;
}

// The plan's own sections, so a reader never indexes the document itself.
const anchors = () => getPlan().anchors;
const columns = () => getPlan().columns;
const ground = () => getPlan().ground;
const dimensions = () => getPlan().dimensions;

// ── WHAT EACH CUBE AND EACH STAND SHAFT OWNS ──────────────────────────────────────────────────────────
// cubeTargets(anchor) → [{ b:[x,y,z], v }] for every in-box cell of the cube except the stand column (restored on
// the column's last descent), `v` the plan's voxel or null for an air target. shaftTargets(column) → the stand
// column's own cells over the whole box, top first. One answer for the assessor that builds the cubes
// (assessors/downloaded_build, which caches them) and the integrity keeper that watches them (foreman/mansion_keeper).
function cubeTargets(anchor) {
  const { cubeCells } = require('@kernel/blueprint_anchor_calculator');
  const byCell = new Map(anchor.voxels.map(v => [`${v[0]},${v[1]},${v[2]}`, v]));
  const t = [];
  for (const [x, y, z] of cubeCells(anchor, dimensions())) {
    if (x === anchor.stand[0] && z === anchor.stand[2]) continue;
    t.push({ b: [x, y, z], v: byCell.get(`${x},${y},${z}`) || null });
  }
  return t;
}
// `support` marks an air cell the block above it stands on (a piece the download left floating): the descent stands a
// kept block there, and that cell reads correct holding one.
function shaftTargets(column) {
  const { restorableOverhead } = require('@kernel/blueprint_anchor_calculator');
  const byY = new Map(column.descent.map(v => [v[1], v]));
  const t = [];
  for (let y = dimensions().h - 1; y >= 0; y--) {
    const v = byY.get(y) || null, over = byY.get(y + 1);
    const support = !v && !!over && !restorableOverhead(over[3], over[4]) && !/_wall_/.test(over[3]);
    t.push({ b: [column.stand[0], y, column.stand[1]], v, ...(support ? { support: true } : {}) });
  }
  return t;
}
// basementCell(column) → the mine's old cell under this column, in plan coordinates: { open: [[x,y,z]...], fill:
// [[x,y,z]...], roof: [[x,y,z]...], lamps: [{ source, attach }] }. An implicit blueprint, like the mine's: generated from its
// grid, never saved in a plan. It sits on the column's own cube grid, whole, so it hangs past the box wherever the
// column's cubes do. `roof` is the two fill blocks the climb cuts over the stand, lowest last. mining_cell_graph owns the cell.
function basementCell(column) {
  const { CUBE } = require('@kernel/blueprint_anchor_calculator');
  const graph = require('@perception/mining_cell_graph');
  const [x0, , z0] = anchors()[column.anchors[0]].cube_min;
  const anchor = { x: x0 + 2, y: -CUBE, z: z0 + 2 };
  const voxels = graph.generateCell(anchor).voxels.map(v => ({ b: [v[0], v[1], v[2]], air: v[3] === 'air' }));
  return {
    open: voxels.filter(v => v.air).map(v => v.b),
    fill: voxels.filter(v => !v.air).map(v => v.b),
    roof: [[column.stand[0], -1, column.stand[1]], [column.stand[0], -2, column.stand[1]]],
    lamps: graph.unitLamps({ anchor }),
  };
}

// mouthCell — the building's one way in, in plan coordinates [bx, by, bz]: the cell just outside the first column's
// basement cell, level with its west door, so a body walks in through the doors. Pure geometry of the plan, so the
// foreman (which holds no wood and no mandate) marks it from the same answer the trips walk to.
function mouthCell() {
  const { ENTRY_FEET_BELOW } = require('@kernel/blueprint_anchor_calculator');
  const [x0, , z0] = anchors()[columns()[0].anchors[0]].cube_min;
  return [x0 - 1, -ENTRY_FEET_BELOW, z0 + 2];
}

module.exports = { load, isLoaded, getPlan, planPathFor, siteFrame, standInsAtSite, mouthCell, basementCell, siteWood, closedBox, noteStanding, standing, buildWoodCells, anchors, columns, ground, dimensions, cubeTargets, shaftTargets, supportsOf, supportSummary, materialRatio, blockCounts, agreesWithTheSurvey, SCHEMA };
