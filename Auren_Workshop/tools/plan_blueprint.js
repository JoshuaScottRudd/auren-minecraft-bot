'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/plan_blueprint.js');
// plan_blueprint — turn an IMPORTED downloaded blueprint into a build plan: what it is built from, where its ground
// floor is, and its 5×5×5 anchor cubes covering the whole box.
//
//   node Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<key> [--wood=spruce] [--leaves=yes|no]
//
// Two pure calculators do the work, in this order, the second on the output of the first:
//   js_kernel/blueprint_material_rule.js     what may be built (logs of one wood, stone, a little iron, dirt)
//   js_kernel/blueprint_anchor_calculator.js the ground floor layer; 5×5×5 cubes over the WHOLE box, in columns,
//                                            stands, the descent, order for split chests
//
// The ground is cleared by the same anchors that build the building; no terraform, stair, or basement
// section — the way down to the anchors is navigation's to find.
//
// ── WHAT IT WRITES, AND WHY APART FROM THE IMPORT ───────────────────────────────────────────────────
// Two files beside the downloaded_blueprints.json it reads:
//   <name>.build_plan.json   the machine plan: material report, ground floor, anchor summary, every anchor's voxels
//   <name>.build_plan.md     the same plan written to be read
// The import entry is never edited. It is the counted statement of what the download contains; a plan is derived
// from it under choices (the wood, leaves) that may change, so it is regenerated from the import each time,
// keeping the import the one source both files come from.

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

const { applyMaterialRule, materialRatio } = require('@kernel/blueprint_material_rule');
const { computeAnchors, groundFloorLayer, ENTRY_FEET_BELOW } = require('@kernel/blueprint_anchor_calculator');
const { SCHEMA } = require('@kernel/downloaded_plan_registry');
const { SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');

function args() {
  const a = process.argv.slice(2);
  const flag = (k, d) => { const hit = a.find(x => x.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d; };
  return { file: a.find(x => !x.startsWith('--')), name: flag('name', null), wood: flag('wood', 'spruce'), leaves: flag('leaves', 'yes') };
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}
const sorted = o => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const total = o => Object.values(o).reduce((s, n) => s + n, 0);

function planMarkdown(name, entry, plan) {
  const m = plan.material_rule, g = plan.ground, s = plan.anchor_summary;
  const L = [];
  L.push(`# Build plan — ${name}`, '');
  L.push(`Written ${new Date().toISOString().slice(0, 10)} by \`Auren_Workshop/tools/plan_blueprint.js\` from the \`${name}\` import (${entry.source.file}, ${entry.dimensions.w} wide × ${entry.dimensions.h} tall × ${entry.dimensions.l} long). The machine copy is \`${name}.build_plan.json\`.`, '');
  L.push('## What it is built from', '');
  L.push(`Only logs of one wood (**${m.wood}**), stone, a little iron, and dirt. Leaves: **${m.leaves ? `built as ${m.wood}_leaves (shears)` : 'left out'}**.`, '');
  L.push(table(['', 'blocks'], [
    ['in the download', plan.blocks_in_import],
    ['built as downloaded', total(m.kept)],
    ['built as a substitute', total(m.substituted)],
    ['left out (cell stays air)', total(m.left_out)],
    ['iron ingots needed', m.iron_ingots],
    ['cobblestone needed, ground floor up', plan.material_ratio.cobblestone],
    ['cobblestone per iron ingot', plan.material_ratio.cobblestone_per_iron],
  ]), '');
  L.push('### Substitutions', '', table(['downloaded → built', 'blocks'], sorted(m.substituted)), '');
  L.push('### Left out', '', table(['block', 'blocks'], sorted(m.left_out)), '');
  L.push('### Built as downloaded', '', table(['block', 'blocks'], sorted(m.kept)), '');
  L.push('## The ground — cleared by the build itself', '');
  L.push('- **Trees first:** every trunk standing on the footprint comes down before any column starts. Those logs are the build\'s wood supply.');
  L.push(`- **Ground floor:** blueprint layer **${g.ground_floor_layer}** (dirt covers ${Math.round(g.ground_floor_dirt_share * 100)}% of the footprint there). It is set at the natural ground height of the ring around the site.`);
  L.push(`- **No scrape, no crawlspace, no stair in this plan.** Every cell of the ${plan.dimensions.w} × ${plan.dimensions.h} × ${plan.dimensions.l} box belongs to one anchor cube; a cell the download leaves empty is an air target, so the dirt and stone standing in it are dug by the same pass that places the blocks.`);
  L.push(`- **The way in is from underneath.** A body is sent to stand ${g.entry_feet_below} below the box's lowest layer, under a column's stand, and navigation finds its own way there — one straight diagonal stair from the surface and a tunnel under the box. Whatever that leaves is the basement. The survey checks the ground ${g.layers_below_ground_floor} layers below the ground floor for water and lava.`, '');
  L.push('## Anchor cubes (5 × 5 × 5)', '');
  L.push(table(['', ''], [
    ['grid offset (x, z)', `${s.offset.x}, ${s.offset.z}`],
    ['columns — how many bots can work at once', s.columns],
    ['cubes over the whole box', `${s.anchors} (${s.empty_anchors} hold only air targets)`],
    ['cube layers', s.cube_layers],
    ['blocks per cube (min / median / max)', `${s.voxels_per_anchor.min} / ${s.voxels_per_anchor.median} / ${s.voxels_per_anchor.max}`],
    ['cubes holding 1 to 5 blocks', s.anchors_with_5_or_fewer],
    ['columns with no usable stand column', s.columns_without_a_stand],
    ['stand columns off the cube centre', s.stands_off_centre],
    ['two-cell pieces (door, bed, double chest)', s.two_cell_pieces],
    ['of those split across cubes', Object.entries(s.split_across_cubes).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'],
    ['double chests ordered across cubes', s.ordered_chest_pairs],
    [`farthest block from its stand (reach ${s.reach_limit})`, `${s.reach_max} — ${s.anchors_beyond_reach} cubes beyond reach`],
    ['tallest filler pillar', `${s.filler_height_max} blocks`],
    ['blocks placed on the descents (total / median / worst column)', `${s.descent_blocks.total} / ${s.descent_blocks.median} / ${s.descent_blocks.max}`],
    ['inventory slots the descent needs, worst column', s.pocket_slots_max],
  ]), '');
  L.push('One anchor per trip. The next anchor any body takes is the lowest unfinished cube of some column — the lowest layer first, the lowest column number among equals — so the building rises level across the site. One body per column at a time.', '');
  L.push(`Every visit starts under the column's stand and pillars up on cheap filler (dirt) to the anchor's y, clears and places that one cube, digs its filler back down and leaves to bank what it dug. The stand column's own blueprint blocks are **not** placed on the way up — they go in on the descent after the column's top cube, placed above the bot's head as it digs the filler out from under its feet. The bot carries them before that last trip: **${s.pocket_slots_max} slots** in the worst column, **${s.descent_blocks.max} blocks**.`, '');
  return L.join('\n');
}

function main() {
  const a = args();
  if (!a.file || !a.name) {
    console.error('usage: node Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<key> [--wood=spruce] [--leaves=yes|no]');
    process.exit(1);
  }
  const src = path.resolve(a.file);
  const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
  const entry = doc.buildings[a.name];
  if (!entry) { console.error(`plan_blueprint: no "${a.name}" in ${src}. Imported names: ${Object.keys(doc.buildings).join(', ')}.`); process.exit(1); }
  if (!['yes', 'no'].includes(a.leaves)) { console.error(`plan_blueprint: --leaves=${a.leaves} must be yes or no.`); process.exit(1); }
  // An import states block names for the server version it was made against; a block renamed between versions
  // (chain → iron_chain at 1.21.9) would be planned under a name the server does not have.
  const importedFor = entry.bill_of_materials.version_gate.server_version;
  if (importedFor !== SERVER_MINECRAFT_VERSION) {
    console.error(`plan_blueprint: "${a.name}" was imported for Minecraft ${importedFor} and the fleet builds on ${SERVER_MINECRAFT_VERSION}. Re-import it first: node Auren_Workshop/tools/import_blueprint.js "<the downloaded file ${entry.source.file}>" --name=${a.name}`);
    process.exit(1);
  }

  const material = applyMaterialRule(entry.unassigned_voxels, { wood: a.wood, leaves: a.leaves === 'yes', serverVersion: SERVER_MINECRAFT_VERSION });
  const floor = groundFloorLayer(material.voxels);
  const ground = {
    ground_floor_layer: floor.layer,
    ground_floor_dirt_share: floor.share,
    world_y: 'world y = h - ground_floor_layer + blueprint y, where h is the ring-median natural ground height',
    entry_feet_below: ENTRY_FEET_BELOW,
    // How deep under the ground floor a body's cells reach: every layer of the box below the ground floor, plus
    // the body standing beneath the box to enter a column. The foreman's survey checks exactly this deep.
    layers_below_ground_floor: floor.layer + ENTRY_FEET_BELOW,
  };
  // THE BUILDING'S IRON-TO-STONE RATIO — a property of the blueprint, written into its plan: the gather has to
  // bring iron and stone in this proportion or one runs out while the other piles up.
  const ratio = materialRatio(material.voxels, floor.layer, material.report.iron_ingots);
  const { anchors, columns, summary } = computeAnchors(material.voxels, entry.dimensions);

  const plan = {
    schema: SCHEMA, name: a.name, source_sha256: entry.source.sha256, server_version: SERVER_MINECRAFT_VERSION,
    frame: 'blueprint min corner; layer 0 = the lowest layer; see ground.world_y', dimensions: entry.dimensions,
    blocks_in_import: entry.unassigned_voxels.length, blocks_built: material.voxels.length,
    material_rule: material.report, material_ratio: ratio, ground, anchor_summary: summary, columns, anchors,
  };
  const outDir = path.dirname(src);
  const jsonFile = path.join(outDir, `${a.name}.build_plan.json`);
  // One anchor per line-group keeps a 25,000-voxel plan readable in a diff without one voxel per line.
  const body = JSON.stringify({ ...plan, anchors: '__ANCHORS__' }, null, 1)
    .replace('"__ANCHORS__"', `[\n${anchors.map(x => ` ${JSON.stringify(x)}`).join(',\n')}\n]`);
  fs.writeFileSync(jsonFile, body + '\n');
  const mdFile = path.join(outDir, `${a.name}.build_plan.md`);
  fs.writeFileSync(mdFile, planMarkdown(a.name, entry, plan));

  const m = material.report;
  console.log(`plan_blueprint: "${a.name}" — ${plan.blocks_in_import} blocks downloaded → ${plan.blocks_built} built (${total(m.kept)} as downloaded, ${total(m.substituted)} substituted), ${total(m.left_out)} left out; iron ${m.iron_ingots} ingots`);
  console.log(`  ground: floor layer ${ground.ground_floor_layer} (dirt ${Math.round(ground.ground_floor_dirt_share * 100)}%); bodies enter ${ground.entry_feet_below} under the box, ${ground.layers_below_ground_floor} layers below the ground floor`);
  console.log(`  cubes: offset ${summary.offset.x},${summary.offset.z}; ${summary.columns} columns; ${summary.anchors} cubes (${summary.empty_anchors} air-only); ${summary.cube_layers} layers; no stand ${summary.columns_without_a_stand}; off-centre stands ${summary.stands_off_centre}; split pieces ${JSON.stringify(summary.split_across_cubes)}; reach max ${summary.reach_max} (${summary.anchors_beyond_reach} beyond ${summary.reach_limit})`);
  console.log(`  descent: tallest pillar ${summary.filler_height_max}; ${summary.descent_blocks.total} blocks placed on descents (worst column ${summary.descent_blocks.max}, ${summary.pocket_slots_max} slots in the pocket)`);
  console.log(`  wrote ${jsonFile}`);
  console.log(`  wrote ${mdFile}`);
}

main();
