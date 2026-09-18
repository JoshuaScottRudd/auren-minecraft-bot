// js_kernel/blueprint_material_rule.js — what a DOWNLOADED blueprint may be built from, applied voxel by voxel.
// Pure: voxels in, voxels and a report out. It reads no world and writes no file.
//
// ── THE RULE IS A WHITELIST (Architect 2026-09-17) ───────────────────────────────────────────────────
// *"all wood is sourced from one biome, no dyes, or carpet or anything that comes from an animal. all blocks must
// be non-rare- sourced from the overworld. so basically everything can onl be derived from either logs or stone.
// and iron if its low amount. anyting outside of either a small amount of iron, stone or wood is to be excluded.
// besides dirt of course."*
// A block is BUILT only when it belongs to one of the families below. A block outside every family is left out
// and its cell stays air. There is no list of forbidden blocks: absence from these families is the exclusion.
//   WOOD    — the one chosen species, every shape (planks, log, wood, stripped, stairs, slab, fence, gate, door,
//             trapdoor, sign, button, plate). Another species' block becomes the chosen species' same shape.
//   LEAVES  — the chosen species' leaves. Gathered with shears; `leaves:false` excludes them for a run that has
//             no shears (Architect: "yes we can get leaves from shears if not then we exclude leaves").
//   STONE   — the overworld stone family and its polished, brick, stairs, slab and wall shapes.
//   CRAFTS  — blocks made only from logs, stone and iron: chest, barrel, crafting table, furnaces, grindstone,
//             composter, ladder, torch, campfire (charcoal comes from logs), and the iron blocks in IRON_PER_BLOCK.
//   DIRT    — dirt. Grass and the other soils are placed as dirt ("dirt=grass": grass spreads onto it).
//
// ── SUBSTITUTIONS HE NAMED (2026-09-17) ─────────────────────────────────────────────────────────────
// *"we can exchange bricks for stone, bookshelves for planks, gravel for stone or dirt, and moss for dirt... just
// exchange brick for stone brick."* So bricks become stone bricks shape for shape, a bookshelf becomes the chosen
// planks, moss becomes dirt, and gravel becomes whichever of stone or dirt most of its six converted neighbours
// are (a tie is stone): "stone or dirt" left the choice to the place the gravel sits, and its neighbours are that
// place. Mossy stone becomes plain stone of the same shape, and an ore becomes the stone it is set in — both
// are the stone family wearing decoration. Every substitution is counted in the report under its own name.

'use strict';

const SPECIES = ['dark_oak', 'pale_oak', 'oak', 'spruce', 'birch', 'jungle', 'acacia', 'mangrove', 'cherry', 'crimson', 'warped', 'bamboo'];
// Longest first, so "_fence_gate" is tried before "_fence" and "_wall_sign" before "_sign".
const WOOD_SHAPES = ['_fence_gate', '_pressure_plate', '_wall_sign', '_trapdoor', '_planks', '_stairs', '_button', '_hyphae', '_fence', '_slab', '_door', '_sign', '_stem', '_log', '_wood'];
const STONE_BLOCKS = new Set([
  'stone', 'cobblestone', 'stone_bricks', 'smooth_stone', 'chiseled_stone_bricks', 'cracked_stone_bricks',
  'andesite', 'granite', 'diorite', 'polished_andesite', 'polished_granite', 'polished_diorite',
  'tuff', 'polished_tuff', 'tuff_bricks', 'chiseled_tuff', 'chiseled_tuff_bricks',
  'deepslate', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_bricks', 'deepslate_tiles', 'chiseled_deepslate',
  'cracked_deepslate_bricks', 'cracked_deepslate_tiles', 'stone_button', 'stone_pressure_plate',
]);
const STONE_SHAPE_BASES = ['stone', 'cobblestone', 'stone_brick', 'smooth_stone', 'andesite', 'granite', 'diorite', 'polished_andesite',
  'polished_granite', 'polished_diorite', 'tuff', 'polished_tuff', 'tuff_brick', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_brick', 'deepslate_tile'];
// Iron ingots per block, from the crafting recipes: lantern 8 nuggets; chain (iron_chain from 1.21.9) 1 ingot + 2 nuggets; 6 ingots → 16 bars;
// anvil 3 blocks + 4 ingots; plate 2; 6 ingots → 16 rails; 1 ingot → 2 hooks; blast furnace 5; stonecutter 1;
// hopper 5; cauldron 7; 6 ingots → 3 iron doors (the upper half costs nothing); 4 ingots → 1 iron trapdoor.
const IRON_PER_BLOCK = {
  lantern: 8 / 9, chain: 11 / 9, iron_chain: 11 / 9, iron_bars: 6 / 16, anvil: 31, heavy_weighted_pressure_plate: 2, rail: 6 / 16, tripwire_hook: 0.5,
  blast_furnace: 5, stonecutter: 1, hopper: 5, cauldron: 7, iron_door: 2, iron_trapdoor: 4,
};
const CRAFTS = new Set(['chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'smoker', 'grindstone', 'composter', 'ladder',
  'torch', 'wall_torch', 'campfire', ...Object.keys(IRON_PER_BLOCK)]);
const SOILS = new Set(['grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'dirt_path', 'mycelium', 'moss_block']);
const BRICKS = { bricks: 'stone_bricks', brick_stairs: 'stone_brick_stairs', brick_slab: 'stone_brick_slab', brick_wall: 'stone_brick_wall' };

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
      return { family: 'wood', to: `${stripped ? 'stripped_' : ''}${wood}${own}` };
    }
  }
  if (name === 'azalea_leaves' || name === 'flowering_azalea_leaves') return leaves ? { family: 'leaves', to: `${wood}_leaves` } : null;
  if (STONE_BLOCKS.has(name)) return { family: 'stone', to: name };
  const shaped = name.match(/^(.*)_(stairs|slab|wall)$/);
  if (shaped && STONE_SHAPE_BASES.includes(shaped[1])) return { family: 'stone', to: name };
  if (/^mossy_(stone_brick|cobblestone)/.test(name)) return { family: 'stone', to: name.replace(/^mossy_/, '') };
  if (BRICKS[name]) return { family: 'stone', to: BRICKS[name] };
  if (name === 'polished_blackstone_button') return { family: 'stone', to: 'stone_button' };
  if (/^deepslate_.*_ore$/.test(name)) return { family: 'stone', to: 'deepslate' };
  if (/_ore$/.test(name)) return { family: 'stone', to: 'stone' };
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
    if (!mc.blocksByName[to]) throw new Error(`[blueprint_material_rule] CODING VIOLATION: ${v[3]} is built as ${to}, which Minecraft ${serverVersion} does not have. Correct the family table in js_kernel/blueprint_material_rule.js.`);
    if (to === v[3]) count(report.kept, to); else count(report.substituted, `${v[3]} → ${to}`);
    if (IRON_PER_BLOCK[to] && !(v[4] && v[4].half === 'upper')) report.iron_ingots += IRON_PER_BLOCK[to];
    out.push(v.length > 4 ? [v[0], v[1], v[2], to, v[4]] : [v[0], v[1], v[2], to]);
  }
  report.iron_ingots = Math.ceil(report.iron_ingots);
  return { voxels: out, report };
}

module.exports = { applyMaterialRule, IRON_PER_BLOCK };
