'use strict';
// library: voxel_snapshot_store — where captured loaded areas live on disk, and how a scanner reads one back with no
// server. The capture itself is voxel_snapshot.js (a live body); the building-site survey (zone_flatness.js) loads from here.
//
// ── WHAT A SNAPSHOT IS ──────────────────────────────────────────────────────────────────────────────
// Every chunk column a connected body held once its view had fully arrived, serialised by prismarine-chunk's own
// `ChunkColumn.toJson` — the object mineflayer writes the server's block updates into — so the blocks read back are
// the blocks the body had, through the same library, with nothing re-encoded here. Light arrays are dropped before
// saving: no scanner in the fleet reads light off a snapshot (voxel_reader's type table answers name, shape and
// water-source from the state id alone), and light is most of the size of a column.
// The header carries the seed, the world, the version, the view distance, world spawn, where the body stood and the
// person spot it was placed on, so a result can be traced back to the exact ground it came from.
//
// ── TWO RULES THE STORE ENFORCES, BECAUSE A SURVEY ACROSS SNAPSHOTS IS ONLY WORTH SOMETHING UNDER THEM ──
//   • NO TWO SNAPSHOTS OF ONE SEED SHARE A CHUNK. A voxel counted in two snapshots is one piece of ground weighed
//     twice, and a total built across snapshots (a biome's share, a site ranking) overstates it. A capture that
//     overlaps is refused, naming the snapshot it overlaps and how far to move (Law 13 correction).
//   • AT MOST KEEP snapshots. Saving the eleventh deletes the oldest first, and says which.
//
// ── READING ONE BACK ────────────────────────────────────────────────────────────────────────────────
// `loadSnapshot` returns the part of a mineflayer bot that voxel scans read: `version`, `registry`, `world`
// (getColumn / getColumnAt / getColumns / getBiome, and the unload hooks voxel_reader listens on, which never fire),
// `blockAt`, `spawnPoint`, `game.serverViewDistance`, plus `snapshot` (the header). wheat_plot_scanner,
// site_geometry, biome_scanner and voxel_reader's fast path all run on it unchanged.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Vec3 = require('vec3');
const paths = require('../workshop_paths');
paths.registerAliases();
const moduleHomes = require('@utils/node_module_homes');
const { guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'voxel_snapshot_store';
const SNAPSHOT_DIR = paths.workshop('voxel_snapshots');
const KEEP = 10;
const FORMAT = 1;

function readFile(file) {
  const got = guardExternalSync(TAG, `read ${file}`, () => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')));
  if (!got.ok) throw new Error(`[${TAG}] CODING VIOLATION: snapshot ${file} is unreadable (${got.reason}) — delete it; it was not written by this store.`);
  if (got.value.header?.format !== FORMAT) {
    throw new Error(`[${TAG}] CODING VIOLATION: snapshot ${file} is format ${got.value.header?.format}, this store reads ${FORMAT}. Delete it and capture again.`);
  }
  return got.value;
}

// listSnapshots → [{ name, file, header, chunks:Set<"x,z"> }], oldest first.
function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json.gz')).map(f => {
    const file = path.join(SNAPSHOT_DIR, f);
    const data = readFile(file);
    return { name: f.replace(/\.json\.gz$/, ''), file, header: data.header, chunks: new Set(data.chunks.map(c => `${c.x},${c.z}`)) };
  }).sort((a, b) => a.header.capturedAt.localeCompare(b.header.capturedAt));
}

// stripLight — the column's JSON with its light sections emptied (see WHAT A SNAPSHOT IS).
function stripLight(columnJson) {
  const j = JSON.parse(columnJson);
  j.skyLightSections = j.skyLightSections.map(() => null);
  j.blockLightSections = j.blockLightSections.map(() => null);
  return JSON.stringify(j);
}

// overlapWith(header, chunkKeys) → the first same-seed snapshot sharing a chunk, with the count, or null.
function overlapWith(header, chunkKeys) {
  for (const s of listSnapshots()) {
    if (String(s.header.seed) !== String(header.seed)) continue;
    let shared = 0;
    for (const k of chunkKeys) if (s.chunks.has(k)) shared++;
    if (shared) return { snapshot: s, shared };
  }
  return null;
}

// saveSnapshot({ header, columns:[{ x, z, json }] }) → { ok, file, pruned[] } | { ok:false, reason }
function saveSnapshot({ header, columns }) {
  const keys = columns.map(c => `${c.x},${c.z}`);
  const hit = overlapWith(header, keys);
  if (hit) {
    const o = hit.snapshot.header.body;
    return { ok: false, reason: `this area shares ${hit.shared} chunk(s) with snapshot '${hit.snapshot.name}' of the same seed ` +
      `(body at ${o.x},${o.z}). Nothing was saved. Capture again at least ${(2 * (header.viewDistance + 2) + 1) * 16} blocks from there ` +
      'along X or Z, or in a different seed.' };
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const pruned = [];
  const existing = listSnapshots();
  while (existing.length >= KEEP) {
    const old = existing.shift();
    fs.unlinkSync(old.file);
    pruned.push(old.name);
  }
  const name = `${header.capturedAt.replace(/[:.]/g, '-')}_${header.label}`;
  const file = path.join(SNAPSHOT_DIR, `${name}.json.gz`);
  const body = { header: { ...header, format: FORMAT, name, chunkCount: columns.length }, chunks: columns.map(c => ({ x: c.x, z: c.z, column: stripLight(c.json) })) };
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(body)), { level: 6 }));
  return { ok: true, file, name, pruned, bytes: fs.statSync(file).size };
}

// loadSnapshot(name | 'latest') → a bot-shaped reader over that snapshot.
function loadSnapshot(which) {
  const all = listSnapshots();
  const hit = which === 'latest' ? all[all.length - 1] : all.find(s => s.name === which || s.header.label === which);
  if (!hit) {
    throw new Error(`[${TAG}] CODING VIOLATION: no snapshot '${which}' in ${SNAPSHOT_DIR}. Have: ${all.map(s => s.name).join(', ') || 'none — capture one with voxel_snapshot.js capture'}.`);
  }
  const data = readFile(hit.file);
  const { header } = data;
  const registry = require('prismarine-registry')(header.mcVersion);
  const Block = require('prismarine-block')(registry);
  const ChunkColumn = moduleHomes.requireFromHomes('prismarine-chunk')(registry);

  const columns = new Map();
  for (const c of data.chunks) columns.set(`${c.x},${c.z}`, ChunkColumn.fromJson(c.column));
  const local = (pos) => ({ x: Math.floor(pos.x) & 15, y: Math.floor(pos.y), z: Math.floor(pos.z) & 15 });
  const world = {
    getColumn(cx, cz) { return columns.get(`${cx},${cz}`) || null; },
    getColumnAt(pos) { return columns.get(`${Math.floor(pos.x) >> 4},${Math.floor(pos.z) >> 4}`) || null; },
    getColumns() { return [...columns.keys()].map(k => { const [chunkX, chunkZ] = k.split(',').map(Number); return { chunkX, chunkZ, column: columns.get(k) }; }); },
    getBiome(pos) { const col = world.getColumnAt(pos); return col ? col.getBiome(local(pos)) : 0; },
    on() {}, removeListener() {},    // a snapshot never loads or unloads a column
  };
  return {
    version: header.mcVersion, registry, world, snapshot: header,
    spawnPoint: new Vec3(header.spawn.x, header.spawn.y, header.spawn.z),
    game: { serverViewDistance: header.viewDistance },
    blockAt(pos) {
      const col = world.getColumnAt(pos);
      if (!col) return null;
      const p = local(pos);
      const b = Block.fromStateId(col.getBlockStateId(p), col.getBiome(p));
      b.position = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
      return b;
    },
  };
}

module.exports = { listSnapshots, saveSnapshot, loadSnapshot, overlapWith, SNAPSHOT_DIR, KEEP };
