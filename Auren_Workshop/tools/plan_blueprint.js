'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/plan_blueprint.js');
// plan_blueprint — turn an IMPORTED downloaded blueprint into a build plan: what it is built from, where its ground
// floor is, the basement and stair under it, and its 5×5×5 anchor cubes.
//
//   node Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<key>
//        [--stair-side=north|south|east|west (north)] [--wood=spruce] [--leaves=yes|no] [--stair-width=2]
//
// Three pure calculators do the work, in this order, each on the output of the one before:
//   js_kernel/blueprint_material_rule.js     what may be built (logs of one wood, stone, a little iron, dirt)
//   js_kernel/blueprint_terraform.js         the one scrape: ground floor layer, parallel lines, crawlspace, stair
//   js_kernel/blueprint_anchor_calculator.js 5×5×5 cubes in columns, stands, the descent, order for split chests
//
// ── WHAT IT WRITES, AND WHY APART FROM THE IMPORT ───────────────────────────────────────────────────
// Two files beside the downloaded_blueprints.json it reads:
//   <name>.build_plan.json   the machine plan: material report, basement, anchor summary, every anchor's voxels
//   <name>.build_plan.md     the same plan written to be read
// The import entry is never edited. It is the counted statement of what the download contains; a plan is derived
// from it under choices (the wood, leaves, the stair side) that may change, so a plan is regenerated from the import
// rather than overwriting it, and the import stays the one source both come from.
// The stair side is north unless --stair-side names another (the default lives in blueprint_terraform.js).

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

const { applyMaterialRule } = require('@kernel/blueprint_material_rule');
const { planTerraform } = require('@kernel/blueprint_terraform');
const { computeAnchors } = require('@kernel/blueprint_anchor_calculator');
const { SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');

function args() {
  const a = process.argv.slice(2);
  const flag = (k, d) => { const hit = a.find(x => x.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d; };
  return {
    file: a.find(x => !x.startsWith('--')), name: flag('name', null), wood: flag('wood', 'spruce'), leaves: flag('leaves', 'yes'),
    stairSide: flag('stair-side', undefined), stairWidth: Number(flag('stair-width', '2')),
  };
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}
const sorted = o => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const total = o => Object.values(o).reduce((s, n) => s + n, 0);

function planMarkdown(name, entry, plan) {
  const m = plan.material_rule, b = plan.terraform, s = plan.anchor_summary;
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
  ]), '');
  L.push('### Substitutions', '', table(['downloaded → built', 'blocks'], sorted(m.substituted)), '');
  L.push('### Left out', '', table(['block', 'blocks'], sorted(m.left_out)), '');
  L.push('### Built as downloaded', '', table(['block', 'blocks'], sorted(m.kept)), '');
  L.push('## The terraform — trees, then one scrape, then the seal', '');
  L.push(`- **Trees first:** every log and leaf standing over the site comes down before the first scrape line, across the footprint plus a ${b.trees.region.margin}-block margin (${b.trees.region.x[0]}…${b.trees.region.x[1]} × ${b.trees.region.z[0]}…${b.trees.region.z[1]}), so nothing is left hanging in the air when the ground under it goes. Those logs are the build's wood supply and go to the hub chests.`);
  L.push(`- **Ground floor:** blueprint layer **${b.ground_floor_layer}** (dirt covers ${Math.round(b.ground_floor_dirt_share * 100)}% of the footprint there). It is set at the natural ground height of the ring around the site.`);
  L.push(`- **Lines:** **${b.scrape.lines}** parallel lines, 1 wide, running along **${b.scrape.axis}** (the longer side, ${b.scrape.run_length} blocks). ${b.scrape.lines} bots can scrape at once, one line each, and no two lines ever cross.`);
  L.push(`- **Depth:** every layer from the highest block over the site down to ${b.scrape.layers_below_ground_floor} layers below the ground floor — ${b.scrape.footprint.columns} footprint columns. The basement is not a second job; it is where the scrape stops.`);
  L.push(`- **Crawlspace:** ${plan.dimensions.w} × ${plan.dimensions.l}, ${b.crawlspace.height} high, directly under the blueprint's lowest layer, standing on layer ${b.floor_y}, which is never dug.`);
  L.push(`- **Stair:** left behind by the scrape rather than cut. ${b.stair.width} wide on the **${b.stair.side}** side, centred, ${b.stair.steps} steps down to the crawlspace, **${b.stair.blocks_dug_if_ground_is_level} blocks** when the ground there is level. A step is two cells — the tread and the headroom — and nothing above it is touched, so it is a covered stairwell with the natural ground as its roof and only the mouth showing. Each layer down, the lane moves one step (${b.stair.width} blocks) further out. ${b.scrape.lane_extends_lines ? 'The lane is the same lines carrying on past the footprint edge.' : 'The lane is its own short lines outside the footprint, parallel to the rest.'}`);
  L.push('- **Nothing here is a to-do list.** What is left to scrape is read off the world every cycle: the active layer is the highest one that still has a block in it, and a line is available while any of its cells at that layer does. An interrupted bot leaves nothing to repair.');
  L.push(`- **The seal, when the building is done:** the stairwell is filled back with dirt — ${b.seal.blocks} blocks, deepest step first — so the mouth closes and a player sees natural ground. The crawlspace is left empty and unreachable. The bot rises with the fill and leaves through the mouth.`, '');
  L.push('## Anchor cubes (5 × 5 × 5)', '');
  L.push(table(['', ''], [
    ['grid offset (x, z)', `${s.offset.x}, ${s.offset.z}`],
    ['columns — how many bots can work at once', s.columns],
    ['cubes, counting empty ones a column rises through', `${s.anchors} (${s.empty_anchors} empty)`],
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
  L.push('Cubes in one column are built bottom to top by one bot at a time, and the column is sealed once on the way down after its top cube, so no bot ever digs a finished block to get out.', '');
  L.push(`Every visit starts at the column's x,z in the crawlspace and pillars up on cheap filler (dirt) to the anchor's y. The stand column's own blueprint blocks are **not** placed on the way up — they go in on the single descent after the column's top cube, placed above the bot's head as it digs the filler out from under its feet. The bot carries them before it starts: **${s.pocket_slots_max} slots** in the worst column, **${s.descent_blocks.max} blocks**.`, '');
  return L.join('\n');
}

function main() {
  const a = args();
  if (!a.file || !a.name) {
    console.error('usage: node Auren_Workshop/tools/plan_blueprint.js "<downloaded_blueprints.json>" --name=<key> [--stair-side=north|south|east|west (north)] [--wood=spruce] [--leaves=yes|no] [--stair-width=2]');
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
  const terraform = planTerraform(material.voxels, entry.dimensions, { stairSide: a.stairSide, stairWidth: a.stairWidth });
  if (!terraform.ok) { console.error(`plan_blueprint: ${terraform.reason}`); process.exit(1); }
  const { anchors, columns, summary } = computeAnchors(material.voxels, entry.dimensions);

  const plan = {
    schema: 'auren.build_plan.v2', name: a.name, source_sha256: entry.source.sha256, server_version: SERVER_MINECRAFT_VERSION,
    frame: 'blueprint min corner; layer 0 = the lowest layer; see terraform.world_y', dimensions: entry.dimensions,
    blocks_in_import: entry.unassigned_voxels.length, blocks_built: material.voxels.length,
    material_rule: material.report, terraform, anchor_summary: summary, columns, anchors,
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
  console.log(`  terraform: ground floor layer ${terraform.ground_floor_layer} (dirt ${Math.round(terraform.ground_floor_dirt_share * 100)}%); ${terraform.scrape.lines} parallel lines along ${terraform.scrape.axis}, ${terraform.scrape.run_length} long; down ${terraform.scrape.layers_below_ground_floor} layers below the ground floor; stair ${terraform.stair.width} wide × ${terraform.stair.steps} steps on the ${terraform.stair.side} side, ${terraform.scrape.lane_extends_lines ? 'extending the lines' : 'its own lines outside the footprint'}`);
  console.log(`  cubes: offset ${summary.offset.x},${summary.offset.z}; ${summary.columns} columns; ${summary.anchors} cubes (${summary.empty_anchors} empty); ${summary.cube_layers} layers; no stand ${summary.columns_without_a_stand}; off-centre stands ${summary.stands_off_centre}; split pieces ${JSON.stringify(summary.split_across_cubes)}; reach max ${summary.reach_max} (${summary.anchors_beyond_reach} beyond ${summary.reach_limit})`);
  console.log(`  descent: tallest pillar ${summary.filler_height_max}; ${summary.descent_blocks.total} blocks placed on descents (worst column ${summary.descent_blocks.max}, ${summary.pocket_slots_max} slots in the pocket)`);
  console.log(`  wrote ${jsonFile}`);
  console.log(`  wrote ${mdFile}`);
}

main();
