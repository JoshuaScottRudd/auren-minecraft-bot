// voxel_labels — what each loaded cell IS, kept as current as the map: a classification, never an answer.
//
// ── LABELS, NOT ANSWERS ─────────────────────────────────────────────────────────────────────────────
// A label says what one cell is, read off the blocks at and above it:
//     floor   'jumpable' (a safe floor with three clear above), 'walkable' (two clear), or null: the verdict
//             voxel_reader.classifyFloor composes live, computed by that same function.
//     kind    'log' (a block group_to_item.logs names) or 'ore' (any *_ore, ancient_debris): what the block is.
// No label answers a question. Nearest, reachable, a route, whose claim, worth the walk: each is asked by its
// owner at its own Sense stage, over these labels, exactly as it would be asked over the raw blocks.
//
// ── AS FRESH AS THE MAP ─────────────────────────────────────────────────────────────────────────────
// mineflayer writes a server block change into bot.world and emits 'blockUpdate' in that same call. The labels
// the change touches are corrected inside that listener, before any other code runs, so a label is never older
// than the block it describes (Law 11). A column that arrives ('chunkColumnLoad': a first load or a re-send) or
// leaves ('chunkColumnUnload') drops every label it held. Nothing is classified until something reads it: a
// 16×16×16 section is labelled on its first read and kept from then on.
//
// ── WHAT ONE CHANGE TOUCHES ─────────────────────────────────────────────────────────────────────────
// A floor label reads its own block and the three above it, so a change at y corrects the floor labels at
// y-3..y in that one (x, z). A kind label is the changed block alone. Labels never cross a column, so a change
// touches one column.
//
// ── WHO READS THEM ──────────────────────────────────────────────────────────────────────────────────
// One set per body (labelsFor), kept for the body's life. The route search reads its floors here (pathfinding_utils),
// and the search for a kind of block (ring_scan) reads a section's logs or ores here when every name it searches is
// one kind.
//
// ── THE SPAWN SQUARE ────────────────────────────────────────────────────────────────────────────────
// Labels are read through the body's voxel_reader, so a masked cell is labelled as the mask shows it. The mask
// moves without a block change (a spawn packet, an enrolment), so every MASK_RECHECK reads the latch is read
// again and a moved mask drops every label.

'use strict';

const { makeVoxelReader } = require('@utils/voxel_reader');
const { group_to_item } = require('@utils/fragment_utils');
const { guardExternalSync } = require('@utils/external_library_guard');

const FLOOR_NONE = 0, FLOOR_WALKABLE = 1, FLOOR_JUMPABLE = 2;
const FLOOR_NAMES = [null, 'walkable', 'jumpable'];
const LOG_NAMES = new Set(group_to_item.logs);
const MASK_RECHECK = 4096;

function kindOfName(name) {
  if (LOG_NAMES.has(name)) return 'log';
  if (name.endsWith('_ore') || name === 'ancient_debris') return 'ore';
  return null;
}

// makeVoxelLabels(bot, opts) → labels over this body's loaded world. opts.reader: the voxel_reader to label through
// (default: a fresh one, needs ['type']). Labels need the fast reader: a body with no chunk store has nothing to keep.
function makeVoxelLabels(bot, opts = {}) {
  const reader = opts.reader || makeVoxelReader(bot, { needs: ['type'] });
  if (!reader.fast) {
    throw new Error('[voxel_labels] CODING VIOLATION: labels are kept from a body\'s chunk store, and this reader has none (voxel_reader fell to its slow path).');
  }
  const minY = () => (bot.game && typeof bot.game.minY === 'number') ? bot.game.minY : -64;
  // The kind of a state id is a fact about Minecraft, so it is worked out once per id.
  const Block = require('prismarine-block')(reader._version);
  const kindByState = [];
  const kindOf = (stateId) => {
    let k = kindByState[stateId];
    if (k !== undefined) return k;
    // prismarine-block throws on a state id this version does not know; that id is labelled nothing.
    const proto = guardExternalSync('voxel_labels', `Block.fromStateId(${stateId})`, () => Block.fromStateId(stateId, 0)).value ?? null;
    k = proto ? kindOfName(proto.name) : null;
    kindByState[stateId] = k;
    return k;
  };

  // column "cx,cz" → { floor: [section → Uint8Array(4096)], kinds: [section → Map(kind → Set(index))] }
  const columns = new Map();
  const stats = { floorSections: 0, kindSections: 0, corrections: 0, drops: 0 };
  const colKey = (cx, cz) => `${cx},${cz}`;
  const index = (x, y, z) => (((y - minY()) & 15) << 8) | ((z & 15) << 4) | (x & 15);

  let maskSeen = null;
  let sinceMask = 0;
  function maskState() {
    const sp = require('@perception/spawn_protection');
    return `${sp.latchVersion()}|${!!bot._spawnMaskInstalled}`;
  }
  function checkMask() {
    if (++sinceMask < MASK_RECHECK && maskSeen !== null) return;
    sinceMask = 0;
    const now = maskState();
    if (maskSeen !== null && now !== maskSeen) { columns.clear(); stats.drops++; }
    maskSeen = now;
  }

  function entry(cx, cz) {
    const k = colKey(cx, cz);
    let e = columns.get(k);
    if (!e) {
      if (!bot.world.getColumn(cx, cz)) return null;
      e = { floor: [], kinds: [] };
      columns.set(k, e);
    }
    return e;
  }

  function buildFloor(e, sec, cx, cz) {
    const out = new Uint8Array(4096);
    const y0 = minY() + sec * 16;
    for (let dy = 0; dy < 16; dy++) for (let dz = 0; dz < 16; dz++) for (let dx = 0; dx < 16; dx++) {
      const v = reader.classifyFloor(cx * 16 + dx, y0 + dy, cz * 16 + dz);
      out[(dy << 8) | (dz << 4) | dx] = v === 'jumpable' ? FLOOR_JUMPABLE : v === 'walkable' ? FLOOR_WALKABLE : FLOOR_NONE;
    }
    e.floor[sec] = out;
    stats.floorSections++;
    return out;
  }

  function buildKinds(e, sec, cx, cz) {
    const out = new Map();
    e.kinds[sec] = out;
    stats.kindSections++;
    const col = bot.world.getColumn(cx, cz);
    const section = col && col.sections ? col.sections[sec] : null;
    if (!section) return out;
    // A section whose palette holds no labelled kind holds none in its cells: the 4096 reads are skipped.
    if (section.palette && !section.palette.some(s => kindOf(s))) return out;
    const y0 = minY() + sec * 16;
    for (let dy = 0; dy < 16; dy++) for (let dz = 0; dz < 16; dz++) for (let dx = 0; dx < 16; dx++) {
      const s = reader.stateIdAt(cx * 16 + dx, y0 + dy, cz * 16 + dz);
      const k = s < 0 ? null : kindOf(s);
      if (!k) continue;
      let set = out.get(k);
      if (!set) out.set(k, set = new Set());
      set.add((dy << 8) | (dz << 4) | dx);
    }
    return out;
  }

  // floorAt(x, y, z[, floorStateId]) → 'jumpable' | 'walkable' | null, identical to voxel_reader.classifyFloor at the
  // same cell (null where the column is not loaded). Shaped as classifyFloorAt so a search can read it in that seam.
  function floorAt(x, y, z) {
    checkMask();
    const cx = x >> 4, cz = z >> 4;
    const e = entry(cx, cz);
    if (!e) return null;
    const sec = (y - minY()) >> 4;
    if (sec < 0) return null;
    const f = e.floor[sec] || buildFloor(e, sec, cx, cz);
    return FLOOR_NAMES[f[index(x, y, z)]];
  }

  // cellsOfKind(kind, cx, cz) → every cell of this kind in a loaded column, as {x, y, z}; null when the column is not
  // loaded. The cells only: which of them is wanted is the caller's question.
  function cellsOfKind(kind, cx, cz) {
    checkMask();
    const e = entry(cx, cz);
    if (!e) return null;
    const col = bot.world.getColumn(cx, cz);
    const n = col && col.sections ? col.sections.length : 0;
    const out = [];
    for (let sec = 0; sec < n; sec++) {
      const set = (e.kinds[sec] || buildKinds(e, sec, cx, cz)).get(kind);
      if (!set) continue;
      const y0 = minY() + sec * 16;
      for (const i of set) out.push({ x: cx * 16 + (i & 15), y: y0 + (i >> 8), z: cz * 16 + ((i >> 4) & 15) });
    }
    return out;
  }

  // sectionCellsOfKind(kind, cx, cz, sec) → the cells of this kind in one section of a loaded column, as {x, y, z} in
  // x, then y, then z order (the order a section is read cell by cell); [] when the column is not loaded.
  function sectionCellsOfKind(kind, cx, cz, sec) {
    checkMask();
    const e = entry(cx, cz);
    if (!e || sec < 0) return [];
    const set = (e.kinds[sec] || buildKinds(e, sec, cx, cz)).get(kind);
    if (!set) return [];
    const y0 = minY() + sec * 16;
    const out = [];
    for (const i of set) out.push({ x: cx * 16 + (i & 15), y: y0 + (i >> 8), z: cz * 16 + ((i >> 4) & 15) });
    out.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    return out;
  }

  // ── KEPT CURRENT ──────────────────────────────────────────────────────────────────────────────────
  function onBlockUpdate(oldBlock, newBlock) {
    const p = newBlock && newBlock.position;
    if (!p) return;
    const e = columns.get(colKey(p.x >> 4, p.z >> 4));
    if (!e) return;
    stats.corrections++;
    for (let y = p.y - 3; y <= p.y; y++) {
      const sec = (y - minY()) >> 4;
      if (sec < 0 || !e.floor[sec]) continue;
      const v = reader.classifyFloor(p.x, y, p.z);
      e.floor[sec][index(p.x, y, p.z)] = v === 'jumpable' ? FLOOR_JUMPABLE : v === 'walkable' ? FLOOR_WALKABLE : FLOOR_NONE;
    }
    const sec = (p.y - minY()) >> 4;
    const kinds = e.kinds[sec];
    if (!kinds) return;
    const i = index(p.x, p.y, p.z);
    const was = oldBlock ? kindOf(oldBlock.stateId) : null;
    const now = kindOf(newBlock.stateId);
    if (was === now) return;
    if (was && kinds.get(was)) kinds.get(was).delete(i);
    if (now) { let set = kinds.get(now); if (!set) kinds.set(now, set = new Set()); set.add(i); }
  }
  function onColumn(corner) {
    if (columns.delete(colKey(corner.x >> 4, corner.z >> 4))) stats.drops++;
  }
  bot.world.on('blockUpdate', onBlockUpdate);
  bot.world.on('chunkColumnLoad', onColumn);
  bot.world.on('chunkColumnUnload', onColumn);

  return {
    floorAt,
    classifyFloorAt: floorAt,
    cellsOfKind,
    sectionCellsOfKind,
    stats,
    get columnsHeld() { return columns.size; },
    // Law 8: the listeners raised here end with the labels.
    dispose() {
      bot.world.removeListener('blockUpdate', onBlockUpdate);
      bot.world.removeListener('chunkColumnLoad', onColumn);
      bot.world.removeListener('chunkColumnUnload', onColumn);
      columns.clear();
    },
  };
}

// labelsFor(bot) → this body's labels, made on first ask and kept with the body (a WeakMap, so they go with it).
const _labels = new WeakMap();
function labelsFor(bot) {
  let l = _labels.get(bot);
  if (!l) { l = makeVoxelLabels(bot); _labels.set(bot, l); }
  return l;
}

// kindOfNames(names) → the one kind every name is ('log' or 'ore'), or null when they are not all one kind.
function kindOfNames(names) {
  let kind = null;
  for (const n of names) {
    const k = kindOfName(n);
    if (!k || (kind && k !== kind)) return null;
    kind = k;
  }
  return kind;
}

module.exports = { makeVoxelLabels, labelsFor, kindOfNames };
