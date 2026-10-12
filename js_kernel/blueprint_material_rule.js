// js_kernel/blueprint_material_rule.js — what a DOWNLOADED blueprint may be built from, applied voxel by voxel.
// Pure: voxels in, voxels and a report out. It reads no world and writes no file.
//
// ── FIVE BASE MATERIALS, AND EVERY BUILT BLOCK IS MADE OF ONE OF THEM ────────────────────────────────
// DIRT · SAND · STONE · WOOD · IRON. What the rule is keeping out is a RARE material — one the fleet has no
// standing job to obtain — so a common material the ground gives up to a shovel is a base like any other.
// A block is BUILT only when it belongs to one of the families below; a block outside every family is left
// out and its cell stays air. There is no list of forbidden blocks — absence from these families is the
// exclusion (Law 29).
//   WOOD    — the one chosen species, every shape (planks, log, wood, stairs, slab, fence, gate, door,
//             trapdoor, sign, button, plate). Another species' block becomes the chosen species' same shape.
//   LEAVES  — the chosen species' leaves, gathered with shears. BUILT (*"I want to make
//             the whole thing"*). The castle asks 702 of them, and a leaf only comes off a standing tree, so
//             at that scale they need A SYSTEM THAT HANDLES THE SHEER NUMBER OF TREES — a tree farm, not yet
//             built, and owed as well for the castle's ~4,000 logs and the charcoal behind its smelting. It is
//             a construction-phase concern and is deliberately left until then; the leaves stay in the plan so
//             the build is the whole castle. `leaves:false` still excludes them for a run that wants none.
//   STONE   — the three rock lineages the fleet can actually produce, and their vanilla shapes. See below.
//   GLASS   — plain glass and plain glass pane. The sand is a surface gather; the dye is not a base material,
//             so every stained colour becomes the plain block of the same shape.
//   CRAFTS  — blocks whose whole recipe is inside the four bases: chest, barrel, crafting table, furnaces,
//             grindstone, composter, ladder, torch, campfire (charcoal comes from logs), and the iron blocks
//             priced in IRON_PER_BLOCK.
//   DIRT    — dirt. Grass and the other soils are placed as dirt ("dirt=grass": grass spreads onto it),
//             and gravel resolves to dirt or stone from its neighbours.
//
// ── WHY THE STONE FAMILY COLLAPSES TO THREE LINEAGES ────────────────────────────────────────────────
// The fleet's only rock producer is a prospect dig that yields COBBLESTONE. Everything else the fleet lays is
// derived from it: cobblestone smelts to stone, stone crafts to stone bricks and to the stairs/slab/button
// shapes, stone smelts again to smooth stone. Andesite, granite, diorite, tuff and deepslate are each a
// SEPARATE mining target with no job that seeks it — so a blueprint asking for one is asking for a material
// outside the four bases, and it collapses to the base rock wearing the same SHAPE. That is why polished
// andesite is built as plain stone, and polished andesite stairs as plain stone stairs.
// Decoration is the same reading one step further in: mossy, cracked, chiseled and ore are all the base rock
// with something done to it that the fleet has no job to reproduce, so each collapses to its plain lineage.
//
// ── SUBSTITUTIONS NAMED AT THE TABLE ────────────────────────────────────────────────────────────────
// Brick becomes stone brick shape for shape, a bookshelf becomes the chosen planks, moss becomes dirt, and
// gravel becomes whichever of stone or dirt most of its six converted neighbours are (a tie is stone) —
// "stone or dirt" left the choice to the place the gravel sits, and its neighbours are that place.
// A STRIPPED LOG IS BUILT AS A PLAIN LOG, and the reason is that stripping is not a recipe: it is an axe used
// on a placed block, a verb no fragment in this fleet owns. Every other wood shape here is reachable through
// the recipe book, so admitting stripped wood would put one material in the plan that no job can obtain —
// the failure the deleted `coals` group is the standing account of (fragment_utils).
// Every substitution is counted in the report under its own name.

'use strict';

const SPECIES = ['dark_oak', 'pale_oak', 'oak', 'spruce', 'birch', 'jungle', 'acacia', 'mangrove', 'cherry', 'crimson', 'warped', 'bamboo'];
// Longest first, so "_fence_gate" is tried before "_fence" and "_wall_sign" before "_sign".
const WOOD_SHAPES = ['_fence_gate', '_pressure_plate', '_wall_sign', '_trapdoor', '_planks', '_stairs', '_button', '_hyphae', '_fence', '_slab', '_door', '_sign', '_stem', '_log', '_wood'];

// ── THE STONE TABLE — one table, two halves, and nothing else decides a stone block ──────────────────
// LINEAGE: the block actually laid, per lineage per shape. Only shapes vanilla gives that lineage appear;
// a shape a lineage does not have resolves through SHAPE_FALLBACK below.
const STONE_LINEAGE = {
  stone: { full: 'stone', stairs: 'stone_stairs', slab: 'stone_slab', button: 'stone_button', pressure_plate: 'stone_pressure_plate' },
  cobblestone: { full: 'cobblestone', stairs: 'cobblestone_stairs', slab: 'cobblestone_slab', wall: 'cobblestone_wall' },
  stone_brick: { full: 'stone_bricks', stairs: 'stone_brick_stairs', slab: 'stone_brick_slab', wall: 'stone_brick_wall' },
  smooth_stone: { full: 'smooth_stone', slab: 'smooth_stone_slab' },
};
// Vanilla gives no stone_wall, so a stone-lineage wall is laid in cobblestone — the cheapest wall the fleet
// already makes. Every other shape falls back to the base lineage.
const SHAPE_FALLBACK = { full: 'stone', stairs: 'stone', slab: 'stone', wall: 'cobblestone', button: 'stone', pressure_plate: 'stone' };
// SOURCE: which lineage a downloaded stone block belongs to. A rock name absent from here is not stone.
const STONE_SOURCE = {
  // The three the fleet produces, kept shape for shape.
  stone: 'stone', cobblestone: 'cobblestone', stone_brick: 'stone_brick', smooth_stone: 'smooth_stone',
  // The base rock wearing a finish no job reproduces.
  chiseled_stone_brick: 'stone_brick', cracked_stone_brick: 'stone_brick', mossy_stone_brick: 'stone_brick',
  mossy_cobblestone: 'cobblestone', infested_stone: 'stone', infested_cobblestone: 'cobblestone',
  brick: 'stone_brick',
  // A different rock entirely — its own mining target, so it collapses to the base.
  andesite: 'stone', polished_andesite: 'stone',
  granite: 'stone', polished_granite: 'stone',
  diorite: 'stone', polished_diorite: 'stone',
  tuff: 'stone', polished_tuff: 'stone', chiseled_tuff: 'stone', tuff_brick: 'stone_brick', chiseled_tuff_brick: 'stone_brick',
  deepslate: 'stone', cobbled_deepslate: 'cobblestone', polished_deepslate: 'stone', chiseled_deepslate: 'stone',
  deepslate_brick: 'stone_brick', cracked_deepslate_brick: 'stone_brick',
  deepslate_tile: 'stone_brick', cracked_deepslate_tile: 'stone_brick',
  calcite: 'stone', dripstone_block: 'stone',
  blackstone: 'stone', polished_blackstone: 'stone', gilded_blackstone: 'stone',
  polished_blackstone_brick: 'stone_brick', cracked_polished_blackstone_brick: 'stone_brick', chiseled_polished_blackstone: 'stone',
};

// stoneCut — split a block name into the lineage key and the shape. The plural is stripped from the full
// block because vanilla writes the full block plural and every shape of it singular (stone_bricks →
// stone_brick_stairs), and the table is keyed on the singular so one entry covers all five shapes.
function stoneCut(name) {
  const shaped = name.match(/^(.*)_(stairs|slab|wall|button|pressure_plate)$/);
  if (shaped) return { base: shaped[1], shape: shaped[2] };
  return { base: name.replace(/s$/, ''), shape: 'full' };
}

// Iron ingots per block, from the crafting recipes: lantern 8 nuggets; chain (iron_chain from 1.21.9) 1 ingot + 2 nuggets; 6 ingots → 16 bars;
// anvil 3 blocks + 4 ingots; plate 2; 6 ingots → 16 rails; 1 ingot → 2 hooks; blast furnace 5; stonecutter 1;
// hopper 5; cauldron 7; 6 ingots → 3 iron doors (the upper half costs nothing); 4 ingots → 1 iron trapdoor.
const IRON_PER_BLOCK = {
  lantern: 8 / 9, chain: 11 / 9, iron_chain: 11 / 9, iron_bars: 6 / 16, anvil: 31, heavy_weighted_pressure_plate: 2, rail: 6 / 16, tripwire_hook: 0.5,
  blast_furnace: 5, stonecutter: 1, hopper: 5, cauldron: 7, iron_door: 2, iron_trapdoor: 4,
};
// Cobblestone per block, the stone side of the iron-to-stone ratio. A stone-lineage shape costs what its recipe
// costs (6 → 4 stairs, 3 → 6 slabs, 2 → 1 plate); smelting and cutting cost no stone. The crafts are their recipes.
const COBBLE_PER_SHAPE = { full: 1, stairs: 1.5, slab: 0.5, wall: 1, button: 1, pressure_plate: 2 };
const COBBLE_PER_CRAFT = { furnace: 8, smoker: 8, blast_furnace: 11, stonecutter: 3, grindstone: 0.5 };
function cobbleOf(name) {
  if (COBBLE_PER_CRAFT[name]) return COBBLE_PER_CRAFT[name];
  const cut = stoneCut(name);
  return STONE_SOURCE[cut.base] ? COBBLE_PER_SHAPE[cut.shape] : 0;
}
const CRAFTS = new Set(['chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'smoker', 'grindstone', 'composter', 'ladder',
  'torch', 'wall_torch', 'campfire', ...Object.keys(IRON_PER_BLOCK)]);
const SOILS = new Set(['grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'dirt_path', 'mycelium', 'moss_block']);

// judge — one block name → { family, to } for a block that is built, or null for a block the rule leaves out.
// `to` is the block actually placed; 'gravel' is resolved later from its neighbours.
function judge(name, wood, leaves) {
  for (const sp of SPECIES) {
    for (const stripped of [false, true]) {
      const head = stripped ? `stripped_${sp}` : sp;
      if (!name.startsWith(head)) continue;
      const shape = name.slice(head.length);
      if (shape === '_leaves') return leaves ? { family: 'leaves', to: `${wood}_leaves` } : null;
      if (!WOOD_SHAPES.includes(shape)) continue;
      if (stripped && !['_log', '_wood', '_stem', '_hyphae'].includes(shape)) continue;
      const own = shape === '_stem' ? '_log' : shape === '_hyphae' ? '_wood' : shape;
      // The stripped prefix is dropped: stripping is an axe verb, not a recipe (see the header).
      return { family: 'wood', to: `${wood}${own}` };
    }
  }
  if (name === 'azalea_leaves' || name === 'flowering_azalea_leaves') return leaves ? { family: 'leaves', to: `${wood}_leaves` } : null;
  if (name === 'glass' || /_stained_glass$/.test(name)) return { family: 'glass', to: 'glass' };
  if (name === 'glass_pane' || /_stained_glass_pane$/.test(name)) return { family: 'glass', to: 'glass_pane' };
  if (/^deepslate_.*_ore$/.test(name) || /_ore$/.test(name)) return { family: 'stone', to: 'stone' };
  const cut = stoneCut(name);
  const lineage = STONE_SOURCE[cut.base];
  if (lineage) {
    const to = STONE_LINEAGE[lineage][cut.shape] || STONE_LINEAGE[SHAPE_FALLBACK[cut.shape]][cut.shape];
    if (to) return { family: 'stone', to };
  }
  if (CRAFTS.has(name)) return { family: 'craft', to: name };
  if (name === 'bookshelf') return { family: 'wood', to: `${wood}_planks` };
  if (name === 'dirt' || SOILS.has(name)) return { family: 'dirt', to: 'dirt' };
  if (name === 'gravel') return { family: 'gravel', to: null };
  return null;
}

// applyMaterialRule(voxels, { wood, leaves, serverVersion }) → { voxels, report }
//   voxels  [x,y,z,block,state?] as blueprint_importer writes them
//   wood    the one species every wood block is built from ('spruce')
//   leaves  true to build leaves from shears, false to leave them out
function applyMaterialRule(voxels, { wood, leaves, serverVersion }) {
  if (!SPECIES.includes(wood)) throw new Error(`[blueprint_material_rule] CODING VIOLATION: wood "${wood}" is not a species. Species: ${SPECIES.join(', ')}.`);
  const mc = require('minecraft-data')(serverVersion);
  const count = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const report = { wood, leaves, kept: {}, substituted: {}, left_out: {}, iron_ingots: 0 };
  const judged = voxels.map(v => ({ v, j: judge(v[3], wood, leaves) }));

  const at = new Map();
  for (const { v, j } of judged) if (j) at.set(`${v[0]},${v[1]},${v[2]}`, j);
  const out = [];
  for (const { v, j } of judged) {
    if (!j) { count(report.left_out, v[3]); continue; }
    let to = j.to;
    if (j.family === 'gravel') {
      let stone = 0, dirt = 0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = at.get(`${v[0] + dx},${v[1] + dy},${v[2] + dz}`);
        if (n && n.family === 'stone') stone++;
        if (n && n.family === 'dirt') dirt++;
      }
      to = dirt > stone ? 'dirt' : 'stone';
    }
    // A DOUBLE SLAB IS BUILT AS THE FULL BLOCK IT FILLS: two slabs in one cell are two clicks and no placement
    // rule sets `type=double`; the full block of the same material fills the same cell in one.
    let state = v[4];
    if (/_slab$/.test(to) && state && state.type === 'double') {
      const base = to.slice(0, -'_slab'.length);
      to = [`${base}_planks`, base, `${base}s`].find(n => mc.blocksByName[n]);
      if (!to) throw new Error(`[blueprint_material_rule] CODING VIOLATION: a double ${base}_slab has no full block among ${base}_planks, ${base}, ${base}s in Minecraft ${serverVersion}.`);
      state = undefined;
    }
    if (!mc.blocksByName[to]) throw new Error(`[blueprint_material_rule] CODING VIOLATION: ${v[3]} is built as ${to}, which Minecraft ${serverVersion} does not have. Correct the family table in js_kernel/blueprint_material_rule.js.`);
    if (to === v[3]) count(report.kept, to); else count(report.substituted, `${v[3]} → ${to}`);
    if (IRON_PER_BLOCK[to] && !(v[4] && v[4].half === 'upper')) report.iron_ingots += IRON_PER_BLOCK[to];
    out.push(state !== undefined ? [v[0], v[1], v[2], to, state] : [v[0], v[1], v[2], to]);
  }
  report.iron_ingots = Math.ceil(report.iron_ingots);
  standInSupports(voxels, judged, out, report, wood);
  return { voxels: out, report };
}

// standInSupports — a left-out block that is the ONLY thing a kept block hangs on is built as planks instead.
// Nothing in the download floats: a lantern hung from wool, a sign on a bed, a door on concrete each stood on
// a block this rule leaves out, and leaving the support out strands the block it held (support_plan counts
// them). The planks stand where the support stood; each one is reported under its own name.
function standInSupports(voxels, judged, out, report, wood) {
  const { normalsOf, hangs } = require('@kernel/support_plan');
  const VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
  const key = (x, y, z) => `${x},${y},${z}`;
  const built = new Set(out.map(v => key(v[0], v[1], v[2])));
  const dropped = new Map(judged.filter(({ j }) => !j).map(({ v }) => [key(v[0], v[1], v[2]), v]));
  const planks = `${wood}_planks`;
  for (const v of out.slice()) {
    if (!hangs(v[3], v[4])) continue;
    const normals = normalsOf(v[3], v[4]);
    if (!normals) continue;
    const cells = normals.map(n => key(v[0] - VEC[n][0], v[1] - VEC[n][1], v[2] - VEC[n][2]));
    if (cells.some(c => built.has(c))) continue;
    const c = cells.find(k => dropped.has(k));
    if (!c) continue;
    const d = dropped.get(c);
    out.push([d[0], d[1], d[2], planks]);
    built.add(c);
    dropped.delete(c);
    report.left_out[d[3]] -= 1;
    if (!report.left_out[d[3]]) delete report.left_out[d[3]];
    const name = `${d[3]} → ${planks} (holds up ${v[3]})`;
    report.substituted[name] = (report.substituted[name] || 0) + 1;
  }
}

// materialRatio(voxels, fromLayer, ironIngots) → { iron_ingots, cobblestone, cobblestone_per_iron }: the stone the
// building costs from `fromLayer` up (below the ground floor the ground is the stone) against its iron.
function materialRatio(voxels, fromLayer, ironIngots) {
  let cobble = 0;
  for (const v of voxels) if (v[1] >= fromLayer) cobble += cobbleOf(v[3]);
  cobble = Math.ceil(cobble);
  return { iron_ingots: ironIngots, cobblestone: cobble, cobblestone_per_iron: ironIngots ? Math.round(cobble / ironIngots) : null };
}

module.exports = { applyMaterialRule, materialRatio, IRON_PER_BLOCK };
