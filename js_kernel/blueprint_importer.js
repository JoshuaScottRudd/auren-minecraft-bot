// js_kernel/blueprint_importer.js — turns a DOWNLOADED blueprint file into a fleet blueprint entry and its
// bill of materials. Pure: bytes in, an object out. It reads no world and writes no file; the workshop CLI
// (Auren_Workshop/tools/import_blueprint.js) owns the file on either side.
//
// ── WHY DOWNLOADED BLUEPRINTS NEVER SHARE A FILE WITH HAND-AUTHORED ONES (Architect 2026-09-16) ─────────
// *"hand authored blueprints and downloaded ones dont mix. it needs a seperate json or a seperate field in
// the json so i can easily tell the difference.... the difference being i know exactly whats in a hand
// crafted one and a downloaded one, it needs to be posted so i can see how many of what is needed clearly."*
// A hand-authored blueprint (building_blueprints.json) is written voxel by voxel by someone who knows every
// block in it, uses the fleet's group tokens ("planks"), and carries anchors. A downloaded one is exact
// blocks somebody else chose, so what it asks for has to be COUNTED and POSTED before anything else is
// decided about it. So an import goes to downloaded_blueprints.json, marked `origin: "downloaded"`, and
// every entry carries its own `bill_of_materials`.
//
// ── WHAT IS KEPT, WHAT IS CHANGED, AND WHERE THAT IS STATED ───────────────────────────────────────────
// The downloaded FILE is never modified (ratified 2026-09-16: "the blueprint itself is unchanged"). The
// entry built from it changes only what must change to be built on this server, and names every change:
//   - a block renamed since the server's version is written under its server name (RENAMES), counted;
//   - a block the server's version does not have at all is left out of the voxels, counted, and listed;
//   - state keys the game sets by itself (a stair's corner, a fence's links — facing_aim.DERIVED) are left
//     out of each voxel's state and counted, because no placement can choose them;
//   - air is left out of the voxels and counted (whether a building's air must be cleared is a siting
//     decision, not an import one).
// Anchors are not computed here. An imported entry is a counted, stated voxel set; it is not buildable
// until an anchor plan exists for it, and it says so in `status`.

'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const nbt = require('prismarine-nbt');
const { guardExternalSync } = require('@utils/external_library_guard');
const { familyOf, DERIVED } = require('@utils/movement/facing_aim');

// Blocks renamed between Minecraft versions, mapped to the other name. A rename applies only when the server's
// version lacks the file's name and has the mapped one, so an older download meets a newer server and a newer
// download meets an older one through the same table. Each entry is a rename measured in a real download, never a
// guess at a substitution: a substitution (a different block standing in) is a design choice and is reported, not made.
const RENAMES = {
  iron_chain: 'chain',          // 1.21.9 name on an older server; seen in "Normal survival house -from-abfielder"
  chain: 'iron_chain',          // pre-1.21.9 name on a newer server; seen in "Finished Castle-from-abfielder"
  grass: 'short_grass',         // renamed in 1.20.3; seen in "Finished Castle-from-abfielder" (data version 3105)
};

// Blocks whose ITEM is not their own name, and how many items one block costs. Everything else is placed
// with the item of the same name when the server's version has one.
function itemsFor(block, props, mc) {
  const p = props || {};
  if ((/_door$/.test(block) || /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|tall_seagrass)$/.test(block)) && p.half === 'upper') return [];
  if (/_bed$/.test(block) && p.part === 'head') return [];
  if (/_slab$/.test(block) && p.type === 'double') return [[block, 2]];
  if (/candle$/.test(block) && p.candles) return [[block, Number(p.candles)]];
  if (block === 'sea_pickle' && p.pickles) return [[block, Number(p.pickles)]];
  if (block === 'turtle_egg' && p.eggs) return [[block, Number(p.eggs)]];
  if (block === 'snow' && p.layers) return [[block, Number(p.layers)]];
  if (/^potted_/.test(block)) {
    const plant = block.replace(/^potted_/, '');
    return [['flower_pot', 1], [mc.itemsByName[plant] ? plant : `${plant} (no item)`, 1]];
  }
  if (mc.itemsByName[block]) return [[block, 1]];
  const special = { wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch', tripwire: 'string', redstone_wire: 'redstone', water: 'water_bucket', lava: 'lava_bucket', cocoa: 'cocoa_beans', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', wheat: 'wheat_seeds', sweet_berry_bush: 'sweet_berries', bamboo_sapling: 'bamboo', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries', kelp_plant: 'kelp', weeping_vines_plant: 'weeping_vines', twisting_vines_plant: 'twisting_vines' };
  if (special[block]) return [[special[block], 1]];
  const unwalled = block.replace('_wall_', '_');
  if (unwalled !== block && mc.itemsByName[unwalled]) return [[unwalled, 1]];
  return [[`${block} (no item)`, 1]];
}

// ── LITEMATICA ─────────────────────────────────────────────────────────────────────────────────────────
// A .litematic is gzipped NBT: Metadata, and Regions each with Position, Size (either sign per axis),
// BlockStatePalette, and BlockStates — palette indices packed end to end across 64-bit longs, with no
// per-long padding, `max(2, ceil(log2(paletteSize)))` bits each, index = y·sx·sz + z·sx + x.
function toBigInt(long) {
  if (typeof long === 'bigint') return BigInt.asUintN(64, long);
  return BigInt.asUintN(64, (BigInt(long[0]) << 32n) | BigInt(long[1] >>> 0));
}

function unpack(longs, bits, count) {
  const mask = (1n << BigInt(bits)) - 1n;
  const words = longs.map(toBigInt);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * bits;
    const w = Math.floor(start / 64);
    const off = BigInt(start % 64);
    let v = words[w] >> off;
    if (Number(off) + bits > 64) v |= words[w + 1] << (64n - off);
    out[i] = Number(v & mask);
  }
  return out;
}

function parseLitematic(bytes) {
  const raw = guardExternalSync('blueprint_importer', 'gunzip .litematic', () => zlib.gunzipSync(bytes));
  if (!raw.ok) return { ok: false, reason: `not a gzipped file: ${raw.reason}` };
  const parsed = guardExternalSync('blueprint_importer', 'parse .litematic NBT', () => nbt.parseUncompressed(raw.value, 'big'));
  if (!parsed.ok) return { ok: false, reason: `not NBT: ${parsed.reason}` };
  const root = nbt.simplify(parsed.value);
  if (!root.Regions || !root.Metadata) return { ok: false, reason: 'no Regions/Metadata — not a Litematica file' };

  const regions = Object.entries(root.Regions).map(([name, r]) => {
    const size = { x: r.Size.x, y: r.Size.y, z: r.Size.z };
    const abs = { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) };
    const min = {
      x: r.Position.x + (size.x < 0 ? size.x + 1 : 0),
      y: r.Position.y + (size.y < 0 ? size.y + 1 : 0),
      z: r.Position.z + (size.z < 0 ? size.z + 1 : 0),
    };
    const palette = r.BlockStatePalette.map(e => ({ name: String(e.Name).replace(/^minecraft:/, ''), props: e.Properties || null }));
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const volume = abs.x * abs.y * abs.z;
    const indices = unpack(r.BlockStates, bits, volume);
    const blocks = [];
    for (let y = 0; y < abs.y; y++) for (let z = 0; z < abs.z; z++) for (let x = 0; x < abs.x; x++) {
      blocks.push({ x: min.x + x, y: min.y + y, z: min.z + z, entry: palette[indices[y * abs.x * abs.z + z * abs.x + x]] });
    }
    return {
      name, min, size: abs, palette_size: palette.length, bits, blocks,
      entities: (r.Entities || []).map(e => String(e.id).replace(/^minecraft:/, '')),
      tile_entities: (r.TileEntities || []).length,
    };
  });
  const m = root.Metadata;
  return {
    ok: true,
    format: 'litematic',
    format_version: root.Version,
    minecraft_data_version: root.MinecraftDataVersion,
    meta: { name: m.Name, author: m.Author, description: m.Description, total_blocks: m.TotalBlocks, total_volume: m.TotalVolume, region_count: m.RegionCount, time_created: m.TimeCreated ? new Date(Number(toBigInt(m.TimeCreated))).toISOString() : null },
    regions,
  };
}

const FORMATS = { '.litematic': parseLitematic };

// importBlueprint — bytes of a downloaded file → { ok, entry } | { ok:false, reason }.
//   fileName     the downloaded file's name (its extension picks the reader)
//   serverVersion the Minecraft version the fleet builds on (architect_config.SERVER_MINECRAFT_VERSION)
function importBlueprint(bytes, fileName, serverVersion) {
  const ext = (fileName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const reader = FORMATS[ext];
  if (!reader) {
    return { ok: false, reason: `no reader for "${ext || 'no extension'}" yet. Readers exist for: ${Object.keys(FORMATS).join(', ')}. A Sponge .schem, legacy .schematic or vanilla structure .nbt needs its own reader added to FORMATS in js_kernel/blueprint_importer.js.` };
  }
  const file = reader(bytes);
  if (!file.ok) return file;
  const mc = require('minecraft-data')(serverVersion);

  const all = file.regions.flatMap(r => r.blocks);
  const min = { x: Math.min(...all.map(b => b.x)), y: Math.min(...all.map(b => b.y)), z: Math.min(...all.map(b => b.z)) };
  const max = { x: Math.max(...all.map(b => b.x)), y: Math.max(...all.map(b => b.y)), z: Math.max(...all.map(b => b.z)) };

  const voxels = [];
  const blockRows = {};
  const itemCounts = {};
  const renamed = {};
  const missing = {};
  const badValues = {};
  const derivedDropped = {};
  let air = 0;
  let placedWithOtherHalf = 0;

  for (const b of all) {
    const fileName0 = b.entry.name;
    if (fileName0 === 'air' || fileName0 === 'cave_air' || fileName0 === 'void_air') { air++; continue; }
    let block = fileName0;
    if (!mc.blocksByName[block] && RENAMES[block] && mc.blocksByName[RENAMES[block]]) {
      renamed[`${block} → ${RENAMES[block]}`] = (renamed[`${block} → ${RENAMES[block]}`] || 0) + 1;
      block = RENAMES[block];
    }
    if (!mc.blocksByName[block]) { missing[block] = (missing[block] || 0) + 1; continue; }

    const props = b.entry.props || {};
    const state = {};
    for (const [k, v] of Object.entries(props)) {
      if (DERIVED.has(k)) { const kv = `${k}=${v}`; derivedDropped[kv] = (derivedDropped[kv] || 0) + 1; continue; }
      const def = (mc.blocksByName[block].states || []).find(s => s.name === k);
      const ok = def && (def.type === 'bool' ? ['true', 'false'].includes(String(v)) : def.type === 'int' ? true : (def.values || []).includes(String(v)));
      if (!ok) { const key = `${block}.${k}=${v}`; badValues[key] = (badValues[key] || 0) + 1; }
      state[k] = String(v);
    }
    const hasState = Object.keys(state).length > 0;
    voxels.push(hasState ? [b.x - min.x, b.y - min.y, b.z - min.z, block, state] : [b.x - min.x, b.y - min.y, b.z - min.z, block]);

    const row = blockRows[block] = blockRows[block] || { block, count: 0, states: {} };
    row.count++;
    if (hasState) { const sig = Object.entries(state).map(([k, v]) => `${k}=${v}`).join(','); row.states[sig] = (row.states[sig] || 0) + 1; }
    const items = itemsFor(block, props, mc);
    if (items.length === 0) placedWithOtherHalf++;
    for (const [item, n] of items) itemCounts[item] = (itemCounts[item] || 0) + n;
  }

  // Placement coverage per block: which facing_aim rule places its state, or that none does.
  for (const row of Object.values(blockRows)) {
    const keys = [...new Set(Object.keys(row.states).flatMap(sig => sig.split(',').map(kv => kv.split('=')[0])))];
    const fam = familyOf(row.block);
    if (keys.length === 0) row.placement = 'no state to set';
    else if (!fam) row.placement = `NO PLACEMENT RULE for ${keys.join(', ')}`;
    else {
      const uncovered = keys.filter(k => !fam.controls.includes(k));
      row.placement = uncovered.length ? `rule "${fam.family}" does NOT set ${uncovered.join(', ')}` : `rule "${fam.family}"`;
    }
  }

  const entities = {};
  for (const r of file.regions) for (const e of r.entities) entities[e] = (entities[e] || 0) + 1;
  const sortDesc = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const blocksList = Object.values(blockRows).sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);
  const skippedVersion = Object.values(missing).reduce((s, n) => s + n, 0);

  const entry = {
    name: null,                                   // set by the caller (the key it is stored under)
    origin: 'downloaded',
    status: 'imported — counted and stated; no anchor plan yet, so the fleet cannot build it',
    source: {
      file: fileName,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      format: file.format,
      format_version: file.format_version,
      minecraft_data_version: file.minecraft_data_version,
      title: file.meta.name,
      author: file.meta.author,
      description: file.meta.description,
      created: file.meta.time_created,
      regions: file.regions.map(r => ({ name: r.name, size: r.size, palette_size: r.palette_size })),
    },
    dimensions: { w: max.x - min.x + 1, h: max.y - min.y + 1, l: max.z - min.z + 1 },
    build_center: { x: Math.floor((max.x - min.x + 1) / 2), y: 0, z: Math.floor((max.z - min.z + 1) / 2) },
    bill_of_materials: {
      totals: {
        volume,
        air,
        blocks_in_file: all.length - air,
        file_metadata_total_blocks: file.meta.total_blocks,
        blocks_in_blueprint: voxels.length,
        blocks_left_out_not_in_server_version: skippedVersion,
        blocks_placed_with_their_other_half: placedWithOtherHalf,   // a door's top, a bed's head: no item of their own
        distinct_blocks: blocksList.length,
        distinct_items: Object.keys(itemCounts).length,
        items_total: Object.values(itemCounts).reduce((s, n) => s + n, 0),
        blocks_with_a_state: blocksList.reduce((s, r) => s + Object.values(r.states).reduce((a, n) => a + n, 0), 0),
      },
      items: sortDesc(itemCounts).map(([item, count]) => ({ item, count })),
      blocks: blocksList.map(r => ({ block: r.block, count: r.count, placement: r.placement, states: Object.fromEntries(sortDesc(r.states)) })),
      version_gate: {
        server_version: serverVersion,
        renamed: sortDesc(renamed).map(([rename, count]) => ({ rename, count })),
        left_out_not_in_server_version: sortDesc(missing).map(([block, count]) => ({ block, count })),
        state_values_server_does_not_know: sortDesc(badValues).map(([value, count]) => ({ value, count })),
      },
      set_by_the_game_not_placed: sortDesc(derivedDropped).map(([key, count]) => ({ key, count })),
      not_built: {
        entities: sortDesc(entities).map(([entity, count]) => ({ entity, count })),
        block_entity_contents: file.regions.reduce((s, r) => s + r.tile_entities, 0),
      },
    },
    anchors: [],
    unassigned_voxels: voxels,
  };
  return { ok: true, entry };
}

module.exports = { importBlueprint, RENAMES };
