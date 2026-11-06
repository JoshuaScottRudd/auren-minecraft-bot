'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/plan_blueprint.js');
// plan_blueprint — turn an IMPORTED downloaded blueprint into a build plan: what it is built from, where its ground
// floor is, and its 5×5×5 anchor cubes covering the whole box.
//
//   node Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<key> [--leaves=yes|no]
//
// Two pure calculators do the work, in this order, the second on the output of the first:
//   js_kernel/blueprint_material_rule.js     what may be built (oak with birch accents, stone, a little iron, dirt)
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
// from it under choices (the fleet's woods, leaves) that may change, so it is regenerated from the import each time,
// keeping the import the one source both files come from.

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

const { calculatePlan } = require('@kernel/blueprint_plan_calculator');
const { SCHEMA } = require('@kernel/downloaded_plan_registry');
const { SERVER_MINECRAFT_VERSION, BUILD_WOOD, COLOR_SWAP } = require('@thinking/architect_config');

function args() {
  const a = process.argv.slice(2);
  const flag = (k, d) => { const hit = a.find(x => x.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d; };
  return { file: a.find(x => !x.startsWith('--')), name: flag('name', null), leaves: flag('leaves', 'yes') };
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
  L.push(`Wood in two tones: the download's most-used wood as **${m.wood}**, every other as **${m.accent}** (architect_config.BUILD_WOOD); stone, a little iron, and dirt. Leaves: **${m.leaves ? `built as ${m.wood}_leaves (shears)` : 'left out'}**.`, '');
  L.push(table(['', 'blocks'], [
    ['in the download', plan.blocks_in_import],
    ['built as downloaded', total(m.kept)],
    ['built as a substitute', total(m.substituted)],
    ['awaiting a producer (air until it stands)', total(m.awaiting)],
    ['left out, extreme rarity (cell stays air)', total(m.left_out)],
    ['iron ingots needed', m.iron_ingots],
    ['cobblestone needed, ground floor up', plan.material_ratio.cobblestone],
    ['cobblestone per iron ingot', plan.material_ratio.cobblestone_per_iron],
  ]), '');
  L.push('### Recoloured', '', `A far dye built in a common colour (architect_config.COLOR_SWAP: ${Object.entries(m.recolour || {}).map(([f, t]) => `${f} → ${t}`).join(', ') || 'none'}). The plan holds only the swapped name.`, '', table(['downloaded → built', 'blocks'], sorted(m.recoloured || {})), '');
  L.push('### Substitutions', '', table(['downloaded → built', 'blocks'], sorted(m.substituted)), '');
  L.push('### Awaiting a producer', '', 'Kept in the plan; each is set aside at load while its producer (`js_kernel/producer_hooks.js`) is not ready.', '', table(['producer: block', 'blocks'], sorted(m.awaiting)), '');
  L.push('### Left out — extreme rarities', '', table(['block', 'blocks'], sorted(m.left_out)), '');
  L.push('### Built as downloaded', '', table(['block', 'blocks'], sorted(m.kept)), '');
  L.push('## The ground — cleared by the build itself', '');
  L.push('- **Trees first:** every trunk standing on the footprint comes down before any column starts. Those logs are the build\'s wood supply.');
  L.push(`- **Ground floor:** blueprint layer **${g.ground_floor_layer}** (dirt covers ${Math.round(g.ground_floor_dirt_share * 100)}% of the footprint there). It is set at the natural ground height of the ring around the site.`);
  L.push(`- **No scrape, no crawlspace, no stair in this plan.** Every cell of the ${plan.dimensions.w} × ${plan.dimensions.h} × ${plan.dimensions.l} box belongs to one anchor cube; a cell the download leaves empty is an air target, so the dirt and stone standing in it are dug by the same pass that places the blocks.`);
  L.push(`- **The way in is from underneath.** Under every column of cubes lies the mine's old 5×5×5 cell, on the column's own grid and whole even where it hangs past the box. A body stands on its floor at the centre, feet ${g.entry_feet_below} below the box's lowest layer. The survey reads the whole basement, and the keeper keeps every block of it. Bodies walk in through the doors from the mouth outside the first column's cell.`, '');
  L.push('## Anchor cubes (5 × 5 × 5)', '');
  L.push(table(['', ''], [
    ['grid offset (x, z)', `${s.offset.x}, ${s.offset.z}`],
    ['columns — how many bots can work at once', s.columns],
    ['cubes over the whole box', `${s.anchors} (${s.empty_anchors} hold only air targets)`],
    ['cube layers', s.cube_layers],
    ['blocks per cube (min / median / max)', `${s.voxels_per_anchor.min} / ${s.voxels_per_anchor.median} / ${s.voxels_per_anchor.max}`],
    ['cubes holding 1 to 5 blocks', s.anchors_with_5_or_fewer],
    ['stand column blocks placed after their support', s.shaft_blocks_needing_support],
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
    console.error('usage: node Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<key> [--leaves=yes|no]');
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

  const plan = calculatePlan(entry, { name: a.name, schema: SCHEMA, preserveSource: entry.origin === 'original',
    wood: BUILD_WOOD.primary, accent: BUILD_WOOD.accent, leaves: a.leaves === 'yes', recolour: COLOR_SWAP, serverVersion: SERVER_MINECRAFT_VERSION });
  const { ground, anchors, anchor_summary: summary } = plan;
  const outDir = path.dirname(src);
  const jsonFile = path.join(outDir, `${a.name}.build_plan.json`);
  // One anchor per line-group keeps a 25,000-voxel plan readable in a diff without one voxel per line.
  const body = JSON.stringify({ ...plan, anchors: '__ANCHORS__' }, null, 1)
    .replace('"__ANCHORS__"', `[\n${anchors.map(x => ` ${JSON.stringify(x)}`).join(',\n')}\n]`);
  fs.writeFileSync(jsonFile, body + '\n');
  const mdFile = path.join(outDir, `${a.name}.build_plan.md`);
  fs.writeFileSync(mdFile, planMarkdown(a.name, entry, plan));

  const m = plan.material_rule;
  console.log(`plan_blueprint: "${a.name}" — ${plan.blocks_in_import} blocks downloaded → ${plan.blocks_built} built (${total(m.kept)} as downloaded, ${total(m.substituted)} substituted), ${total(m.awaiting)} awaiting a producer, ${total(m.left_out)} left out; iron ${m.iron_ingots} ingots`);
  console.log(`  ground: floor layer ${ground.ground_floor_layer} (dirt ${Math.round(ground.ground_floor_dirt_share * 100)}%); bodies enter ${ground.entry_feet_below} under the box, ${ground.layers_below_ground_floor} layers below the ground floor`);
  console.log(`  cubes: offset ${summary.offset.x},${summary.offset.z}; ${summary.columns} columns; ${summary.anchors} cubes (${summary.empty_anchors} air-only); ${summary.cube_layers} layers; shaft blocks needing support ${summary.shaft_blocks_needing_support}; split pieces ${JSON.stringify(summary.split_across_cubes)}; reach max ${summary.reach_max} (${summary.anchors_beyond_reach} beyond ${summary.reach_limit})`);
  console.log(`  descent: tallest pillar ${summary.filler_height_max}; ${summary.descent_blocks.total} blocks placed on descents (worst column ${summary.descent_blocks.max}, ${summary.pocket_slots_max} slots in the pocket)`);
  console.log(`  wrote ${jsonFile}`);
  console.log(`  wrote ${mdFile}`);
}

main();
