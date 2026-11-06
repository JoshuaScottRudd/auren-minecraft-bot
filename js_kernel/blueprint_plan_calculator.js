'use strict';
// One calculator assembles cube plans for operator imports and authored fleet structures.
const crypto = require('crypto');
const { applyMaterialRule, materialRatio, IRON_PER_BLOCK } = require('@kernel/blueprint_material_rule');
const { computeAnchors, groundFloorLayer, ENTRY_FEET_BELOW } = require('@kernel/blueprint_anchor_calculator');
const { trashNeeds } = require('@kernel/cube_trash_need');
const { producerOf } = require('@kernel/producer_hooks');
const total = values => Object.values(values).reduce((sum, count) => sum + count, 0);

// Authored geometry keeps its materials except declared feature substitutions; groups and derived states normalize here.
function authoredMaterial(voxels, options) {
  const mc = require('minecraft-data')(options.serverVersion);
  const { group_to_item } = require('@utils/fragment_utils');
  const { DERIVED } = require('@utils/movement/facing_aim');
  const report = { wood: options.wood, accent: options.accent, leaves: options.leaves, recolour: options.recolour,
    recoloured: {}, kept: {}, substituted: {}, awaiting: {}, left_out: {}, iron_ingots: 0 };
  const concrete = voxels.map(v => {
    const token = options.substitutions?.[v[3]] || v[3];
    const name = mc.blocksByName[token] ? token : group_to_item[token]?.find(n => mc.blocksByName[n]);
    if (!name) throw new Error(`[blueprint_plan_calculator] Authored block '${v[3]}' at ${v.slice(0,3)} has no Minecraft block or material group in ${options.serverVersion}.`);
    const state = token === v[3] ? Object.fromEntries(Object.entries(v[4] || {}).filter(([key]) => !DERIVED.has(key) && !(key === 'open' && name === 'barrel'))) : {}; // a barrel's lid is whoever has it open
    if (token === v[3]) report.kept[name] = (report.kept[name] || 0) + 1;
    // What a producer owes is one count per piece as a body makes it, so the free half of a bed owes nothing (flock_colors.woolOwed).
    const producer = producerOf(name);
    if (producer && v[4]?.part !== 'head') { const owed = `${producer}: ${name}`; report.awaiting[owed] = (report.awaiting[owed] || 0) + 1; }
    else { const change = `${v[3]} → ${name}`; report.substituted[change] = (report.substituted[change] || 0) + 1; }
    if (IRON_PER_BLOCK[name] && v[4]?.half !== 'upper') report.iron_ingots += IRON_PER_BLOCK[name];
    return [...v.slice(0,3), name, ...(Object.keys(state).length ? [state] : [])];
  });
  report.iron_ingots = Math.ceil(report.iron_ingots);
  return { voxels: concrete, report };
}

// authoredVoxels(entry, beds) → every voxel the entry builds. Structure Studio assigns authored voxels to editor anchors, so
// both stores count. `beds`, when given, keeps the first that many of design_intent.beds: the crew's bedroom is the crew's size.
function authoredVoxels(entry, beds) {
  const all = [...(entry.unassigned_voxels || []), ...(entry.anchors || []).flatMap(anchor => anchor.voxels || [])];
  if (!Number.isInteger(beds)) return all;
  const left = new Set((entry.design_intent.beds.slice(beds)).flatMap(bed => [bed.foot.join(), bed.head.join()]));
  return all.filter(v => !left.has(v.slice(0, 3).join()));
}

function calculatePlan(entry, { name, schema, preserveSource = false, beds, ...options }) {
  const sourceVoxels = authoredVoxels(entry, beds);
  const material = preserveSource ? authoredMaterial(sourceVoxels, options) : applyMaterialRule(sourceVoxels, options);
  const floor = groundFloorLayer(material.voxels);
  const ground = { ground_floor_layer: floor.layer, ground_floor_dirt_share: floor.share,
    world_y: 'world y = h - ground_floor_layer + blueprint y, where h is the ring-median natural ground height',
    entry_feet_below: ENTRY_FEET_BELOW, layers_below_ground_floor: floor.layer + ENTRY_FEET_BELOW };
  const { anchors, columns, summary } = computeAnchors(material.voxels, entry.dimensions);
  const trash = trashNeeds({ dimensions: entry.dimensions, anchor_summary: summary, columns, anchors });
  for (const anchor of anchors) anchor.trash = trash.get(anchor.index);
  return { schema, name, source_sha256: entry.source?.sha256 || crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
    server_version: options.serverVersion, frame: 'blueprint min corner; layer 0 = the lowest layer; see ground.world_y', dimensions: entry.dimensions,
    blocks_in_import: sourceVoxels.length, blocks_built: material.voxels.length - (preserveSource ? 0 : total(material.report.awaiting)),
    blocks_awaiting: total(material.report.awaiting), material_rule: material.report,
    material_ratio: materialRatio(material.voxels, floor.layer, material.report.iron_ingots), ground, anchor_summary: summary, columns, anchors,
    ...(preserveSource ? { design_intent: entry.design_intent } : {}) };
}

module.exports = { calculatePlan, authoredVoxels };
