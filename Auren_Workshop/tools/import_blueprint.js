'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/import_blueprint.js');
// import_blueprint — read a DOWNLOADED blueprint file, count exactly what it asks for, and store it apart
// from the hand-authored blueprints.
//
//   node Auren_Workshop/tools/import_blueprint.js "<path to .litematic>" [--name=<key>] [--out=<dir>]
//
// ── WHAT IT WRITES, AND WHERE ───────────────────────────────────────────────────────────────────────
// Two files, both in the folder the downloaded file sits in unless --out names another:
//   downloaded_blueprints.json          every imported entry, keyed by name, each marked
//                                       `origin: "downloaded"` and carrying its own bill_of_materials.
//                                       Never building_blueprints.json: the two do not mix (Architect
//                                       2026-09-16; the reasons are in js_kernel/blueprint_importer.js).
//   <name>.bill_of_materials.md         the same bill written to be READ — totals, every item and how
//                                       many, every block and the states it is placed in, what this
//                                       server version cannot build.
// The output sits beside its source by default because a download is somebody else's work: WHERE the
// converted copy lives decides whether it ships with the bot, and that is a decision for the person who
// downloaded it, made by choosing --out, never by this tool's default.
//
// Re-importing the same file (same sha256) replaces its entry. A DIFFERENT file under a name already in
// use is refused, naming both files, so one download can never silently overwrite another.

const fs = require('fs');
const path = require('path');
const paths = require('../workshop_paths');
paths.registerAliases();

const { importBlueprint } = require('@kernel/blueprint_importer');
const { SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');

const SCHEMA = 'auren.downloaded_blueprints.v1';

function args() {
  const a = process.argv.slice(2);
  const flag = (k) => { const hit = a.find(x => x.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : null; };
  return { file: a.find(x => !x.startsWith('--')), name: flag('name'), out: flag('out') };
}

function slug(fileName) {
  return path.basename(fileName, path.extname(fileName)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// One voxel per line keeps a 2,500-block house diffable without making the file 20,000 lines long.
function writeJson(file, doc) {
  let out = JSON.stringify(doc, (k, v) => (k === 'unassigned_voxels' ? '__VOXELS__' : v), 2);
  for (const entry of Object.values(doc.buildings)) {   // markers appear in the same order as the entries
    const marker = /^(\s*)"unassigned_voxels": "__VOXELS__"/m;
    const hit = out.match(marker);
    const pad = hit[1];
    const lines = entry.unassigned_voxels.map(v => `${pad}  ${JSON.stringify(v)}`).join(',\n');
    out = out.replace(marker, `${pad}"unassigned_voxels": [\n${lines}\n${pad}]`);
  }
  fs.writeFileSync(file, out + '\n');
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function billMarkdown(name, e) {
  const b = e.bill_of_materials;
  const t = b.totals;
  const g = b.version_gate;
  const lines = [];
  lines.push(`# Bill of materials — ${name}`);
  lines.push('');
  lines.push(`Downloaded blueprint, imported ${new Date().toISOString().slice(0, 10)} by \`Auren_Workshop/tools/import_blueprint.js\`. Written for reading; the machine copy is the \`${name}\` entry in \`downloaded_blueprints.json\` beside this file.`);
  lines.push('');
  lines.push(`- **Source file:** ${e.source.file} (${e.source.format}, format version ${e.source.format_version}, Minecraft data version ${e.source.minecraft_data_version})`);
  lines.push(`- **Title / author:** ${e.source.title || '—'} / ${e.source.author || '—'}`);
  lines.push(`- **Size:** ${e.dimensions.w} wide × ${e.dimensions.h} tall × ${e.dimensions.l} long`);
  lines.push(`- **Status:** ${e.status}`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(table(['what', 'count'], [
    ['blocks in the blueprint', t.blocks_in_blueprint],
    ['items needed to place them', t.items_total],
    ['different items', t.distinct_items],
    ['different blocks', t.distinct_blocks],
    ['blocks that must face or sit a certain way', t.blocks_with_a_state],
    ['blocks that come free with their other half (door tops, bed heads)', t.blocks_placed_with_their_other_half],
    [`blocks left out (not in Minecraft ${g.server_version})`, t.blocks_left_out_not_in_server_version],
    ['air cells inside the box', t.air],
    ['the file\'s own block count (cross-check)', `${t.file_metadata_total_blocks} (${t.file_metadata_total_blocks === t.blocks_in_file ? 'matches' : `DOES NOT MATCH the ${t.blocks_in_file} read`})`],
  ]));
  lines.push('');
  lines.push('## Items needed');
  lines.push('');
  lines.push(table(['item', 'count'], b.items.map(i => [i.item, i.count])));
  lines.push('');
  lines.push('## Blocks, and how each must be placed');
  lines.push('');
  lines.push('"Placement rule" is the fleet rule that sets the block\'s direction or position. A block with a state and no rule cannot yet be placed the way the blueprint shows it.');
  lines.push('');
  lines.push(table(['block', 'count', 'placement rule', 'states (count)'], b.blocks.map(r => [
    r.block, r.count, r.placement,
    Object.entries(r.states).map(([s, n]) => `${s} (${n})`).join('<br>') || '—',
  ])));
  lines.push('');
  lines.push(`## What Minecraft ${g.server_version} cannot build as downloaded`);
  lines.push('');
  if (!g.renamed.length && !g.left_out_not_in_server_version.length && !g.state_values_server_does_not_know.length) lines.push('Nothing — every block and state exists on this version.');
  for (const r of g.renamed) lines.push(`- **Renamed:** ${r.rename} — ${r.count} block(s), written under the server's name.`);
  for (const r of g.left_out_not_in_server_version) lines.push(`- **Does not exist on this version, left out:** ${r.block} — ${r.count} block(s).`);
  for (const r of g.state_values_server_does_not_know) lines.push(`- **State value this version does not know:** ${r.value} — ${r.count} block(s).`);
  lines.push('');
  lines.push('## Set by the game, not by the builder');
  lines.push('');
  lines.push('These parts of a block\'s state change on their own once neighbours are in place (a fence joining a fence, a stair turning a corner, a block holding water), so they are not asked for.');
  lines.push('');
  lines.push(table(['state as downloaded', 'blocks'], b.set_by_the_game_not_placed.map(d => [d.key, d.count])));
  lines.push('');
  lines.push('## Not built by the blueprint');
  lines.push('');
  lines.push(`- Entities (item frames, armour stands, animals): ${b.not_built.entities.map(x => `${x.entity} ×${x.count}`).join(', ') || 'none'}`);
  lines.push(`- Block contents (items inside chests, pots, signs' text and the like): ${b.not_built.block_entity_contents} block(s) carry some`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const a = args();
  if (!a.file) {
    console.error('usage: node Auren_Workshop/tools/import_blueprint.js "<path to downloaded blueprint>" [--name=<key>] [--out=<dir>]');
    process.exit(1);
  }
  const src = path.resolve(a.file);
  if (!fs.existsSync(src)) { console.error(`import_blueprint: no file at ${src}`); process.exit(1); }
  const name = a.name || slug(src);
  const outDir = path.resolve(a.out || path.dirname(src));
  const jsonFile = path.join(outDir, 'downloaded_blueprints.json');

  const result = importBlueprint(fs.readFileSync(src), path.basename(src), SERVER_MINECRAFT_VERSION);
  if (!result.ok) { console.error(`import_blueprint: ${result.reason}`); process.exit(1); }
  const entry = { ...result.entry, name };

  const doc = fs.existsSync(jsonFile)
    ? JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    : { schema: SCHEMA, note: 'Downloaded blueprints only — every entry is origin "downloaded" and carries its own bill_of_materials. Hand-authored blueprints live in Auren_Bot/js_kernel/building_blueprints.json and never here. Written by Auren_Workshop/tools/import_blueprint.js.', buildings: {} };
  if (doc.schema !== SCHEMA) { console.error(`import_blueprint: ${jsonFile} has schema "${doc.schema}", expected "${SCHEMA}"; refusing to write into it.`); process.exit(1); }
  const prior = doc.buildings[name];
  if (prior && prior.source.sha256 !== entry.source.sha256) {
    console.error(`import_blueprint: the name "${name}" already holds ${prior.source.file}; ${entry.source.file} is a different file. Import it with --name=<another key>.`);
    process.exit(1);
  }
  doc.buildings[name] = entry;
  writeJson(jsonFile, doc);
  const mdFile = path.join(outDir, `${name}.bill_of_materials.md`);
  fs.writeFileSync(mdFile, billMarkdown(name, entry));

  const t = entry.bill_of_materials.totals;
  console.log(`import_blueprint: ${entry.source.file} → "${name}"`);
  console.log(`  ${t.blocks_in_blueprint} blocks, ${t.distinct_blocks} kinds; ${t.items_total} items, ${t.distinct_items} kinds; ${t.blocks_with_a_state} with a state; ${t.blocks_left_out_not_in_server_version} left out for ${SERVER_MINECRAFT_VERSION}`);
  console.log(`  file says ${t.file_metadata_total_blocks} blocks, read ${t.blocks_in_file}: ${t.file_metadata_total_blocks === t.blocks_in_file ? 'MATCH' : 'MISMATCH'}`);
  console.log(`  wrote ${jsonFile}`);
  console.log(`  wrote ${mdFile}`);
}

main();
