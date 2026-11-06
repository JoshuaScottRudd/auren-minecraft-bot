// ring_scan — THE ONE SEARCH FOR A KIND OF THING: RINGS OPEN OUTWARD, THE NEAREST RING ANSWERS FIRST.
// Every search for blocks of a kind (logs, grass, a material, water, a composter, stone) and for entities of a kind
// (an animal, a drop) goes through here (Law 16), the tree search's rings made the fleet's. A ring is RING_BLOCKS
// wide, measured flat from the centre: ring 0 is 0–16 blocks out, ring 1 is 16–32. A search asks for one ring at a
// time and stops on the first ring that answers it, so a thing beside the body costs one ring and a thing far off
// costs as far as it lies.
// Not for a full picture: a route (pathfinding), a sector's census (sector_scan.scanSector) or a site's survey read
// every cell they cover, nearest or not.
//
// blockRings(bot, opts) → { next(), cost(), loadedSections }
//   next() reads only the chunk sections the next ring needs and hands back that ring's blocks, nearest first; a
//   ring holding none is passed over, so every answer has something in it. null when the rings have reached the
//   edge of what the body has loaded, or `reach`. A section is read once, when the first ring touching its chunk
//   asks; what it held farther out waits for the ring it belongs to. A section whose palette holds none of the
//   names is skipped unread.
//   opts.names    block names searched for (required).
//   opts.center   {x,z} the rings are centred on; the body when omitted.
//   opts.reach    blocks from the centre past which nothing is returned and no ring is opened.
//   opts.band     {low, high} the Y range read; the whole world when omitted.
//   opts.exclude  (position) => true rules a cell out before it is counted.
//   opts.accept   (reader, position, block) => false rules a matched cell out (open to air, a source with air
//                 over it); run after exclude, before the cell is counted.
//   opts.collapse async (reader, hits) => objectives, applied to each ring's hits (a trunk is one column, so
//                 every log of it lies in one ring and collapses to its base there).
//   opts.source   the pacer's name in the record.
//   cost() → { rings, read, skipped, ms, raw }: what the rings opened so far have cost; raw counts name matches
//   before `accept`.
// nearestBlocks(bot, opts, limit) → up to `limit` blocks, ring by ring, nearest first (limit 1: the nearest).
// entityRings(bot, opts) → { next() } over the entities the body senses, the same rings by flat distance.
//   opts.match (entity) => true, opts.center, opts.reach.
// nearestEntity(bot, opts) → the nearest matching entity, or null.
// namesMatching(bot, pattern) → every block name in this version that the pattern matches, for a search named by rule.

'use strict';

const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeExecutionPacer } = require('@utils/execution_yield');

const RING_BLOCKS = 16;

// One reader per bot, memoized; a WeakMap so a disconnected bot's reader goes with it (Law 8).
const _readers = new WeakMap();
function readerFor(bot) {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
}

function centreOf(bot, given) {
  const here = bot.entity.position.floored();
  return given && Number.isFinite(given.x) && Number.isFinite(given.z)
    ? { x: Math.floor(given.x), z: Math.floor(given.z) } : { x: here.x, z: here.z };
}

function namesMatching(bot, pattern) {
  return Object.keys(bot.registry?.blocksByName || {}).filter(n => pattern.test(n));
}

const flat = (p, c) => Math.hypot(p.x - c.x, p.z - c.z);

function blockRings(bot, opts = {}) {
  const names = new Set(opts.names || []);
  if (!names.size) throw new Error('[ring_scan] CODING VIOLATION: blockRings needs the block names it searches for.');
  const reader = readerFor(bot);
  const c = centreOf(bot, opts.center);
  const reach = Number.isFinite(opts.reach) ? opts.reach : Infinity;
  const exclude = typeof opts.exclude === 'function' ? opts.exclude : null;
  const accept = typeof opts.accept === 'function' ? opts.accept : null;
  const collapse = typeof opts.collapse === 'function' ? opts.collapse : null;
  const ids = new Set();
  for (const n of names) { const b = bot.registry?.blocksByName?.[n]; if (b) ids.add(b.id); }

  // Whether a state id is one of the names, worked out once per id for this search: a section's cells are matched on
  // their state ids, and a block is read whole only where one matches.
  const byState = bot.registry && bot.registry.blocksByStateId;
  const matchByState = [];
  const stateMatches = (stateId) => {
    let m = matchByState[stateId];
    if (m === undefined) { const d = byState[stateId]; m = !!d && ids.has(d.id); matchByState[stateId] = m; }
    return m;
  };
  const byId = reader.fast && !!byState;
  // A search for logs or ores alone reads each section's labelled cells (voxel_labels) instead of its every cell.
  const labelKind = reader.fast ? require('@utils/voxel_labels').kindOfNames(names) : null;
  const labels = labelKind ? require('@utils/voxel_labels').labelsFor(bot) : null;
  // A section with no palette is on the global palette and cannot be ruled out, so it is read.
  const Block = byState ? null : require('prismarine-block')(bot.registry);
  const paletteHolds = (section) => {
    if (!section.palette) return true;
    for (const stateId of section.palette) {
      if (byState) { if (stateMatches(stateId)) return true; continue; }
      const b = Block.fromStateId(stateId, 0);
      if (b && ids.has(b.type)) return true;
    }
    return false;
  };

  // Every loaded section in the band, nearest chunk first. `d` is the flat distance from the centre to the
  // chunk's nearest cell, so no block in the chunk is nearer than `d`.
  const minY = bot.game?.minY ?? -64;
  const totalSections = (bot.game?.height ?? 384) >> 4;
  const bandLow = Number.isFinite(opts.band?.low) ? opts.band.low : -Infinity;
  const bandHigh = Number.isFinite(opts.band?.high) ? opts.band.high : Infinity;
  const jobs = [];
  if (ids.size) {
    for (const entry of (bot.world?.getColumns?.() || [])) {
      const col = entry?.column;
      if (!col || !Array.isArray(col.sections)) continue;
      const bx = Number(entry.chunkX) * 16, bz = Number(entry.chunkZ) * 16;
      const dx = c.x < bx ? bx - c.x : (c.x > bx + 15 ? c.x - (bx + 15) : 0);
      const dz = c.z < bz ? bz - c.z : (c.z > bz + 15 ? c.z - (bz + 15) : 0);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > reach) continue;
      for (let s = 0; s < totalSections; s++) {
        const y0 = minY + s * 16;
        if (y0 + 15 < bandLow || y0 > bandHigh) continue;
        if (!col.sections[s]) continue;
        jobs.push({ bx, bz, y0, d, section: col.sections[s] });
      }
    }
    jobs.sort((a, b) => a.d - b.d || a.y0 - b.y0);
  }

  // The pacer's combat gate is armed with the body: a real engagement leaves the awaited promise unresolved and
  // this search is discarded mid-read.
  const pace = makeExecutionPacer({ bot, source: opts.source || 'ring_scan' });
  const waiting = new Map();   // ring index -> blocks read already that lie in that ring
  const cost = { rings: 0, read: 0, skipped: 0, ms: 0, raw: 0 };
  let cursor = 0, k = 0;

  const consider = (x, y, z) => {
    const b = reader.blockAt(x, y, z);
    if (!b || !names.has(b.name)) return;
    const p = { x, y, z };
    const d = flat(p, c);
    if (d > reach) return;
    if (exclude && exclude(p)) return;
    cost.raw++;
    if (accept && !accept(reader, p, b)) return;
    const ring = Math.floor(d / RING_BLOCKS);
    const held = waiting.get(ring);
    if (held) held.push({ name: b.name, position: p }); else waiting.set(ring, [{ name: b.name, position: p }]);
  };
  const readSection = (j) => {
    const yLow = Math.max(j.y0, bandLow), yHigh = Math.min(j.y0 + 15, bandHigh);
    if (labels) {
      for (const q of labels.sectionCellsOfKind(labelKind, j.bx >> 4, j.bz >> 4, (j.y0 - minY) >> 4)) {
        if (q.y >= yLow && q.y <= yHigh) consider(q.x, q.y, q.z);
      }
      return;
    }
    for (let x = j.bx; x < j.bx + 16; x++) {
      for (let y = yLow; y <= yHigh; y++) {
        for (let z = j.bz; z < j.bz + 16; z++) {
          if (byId) { const sid = reader.stateIdAt(x, y, z); if (sid < 0 || !stateMatches(sid)) continue; }
          consider(x, y, z);
        }
      }
    }
  };

  async function next() {
    for (;;) {
      const inner = k * RING_BLOCKS, outer = inner + RING_BLOCKS;
      if (inner > reach) return null;
      if (cursor >= jobs.length && waiting.size === 0) return null;
      const t0 = Date.now();
      while (cursor < jobs.length && jobs[cursor].d < outer) {
        const j = jobs[cursor++];
        if (!paletteHolds(j.section)) { cost.skipped++; continue; }
        readSection(j);
        cost.read++;
        await pace();
      }
      cost.ms += Date.now() - t0;
      const hits = waiting.get(k) || [];
      waiting.delete(k);
      const index = k++;
      cost.rings = k;
      const objectives = collapse ? await collapse(reader, hits) : hits;
      if (!objectives.length) continue;
      objectives.sort((a, b) => flat(a.position, c) - flat(b.position, c));
      return { index, inner, outer, objectives };
    }
  }

  return { next, cost: () => ({ ...cost }), loadedSections: jobs.length, center: c };
}

async function nearestBlocks(bot, opts, limit = 1) {
  const rings = blockRings(bot, opts);
  const found = [];
  for (let ring = await rings.next(); ring && found.length < limit; ring = found.length < limit ? await rings.next() : null) {
    for (const o of ring.objectives) { if (found.length >= limit) break; found.push(o); }
  }
  return { found, cost: rings.cost() };
}

// The entities the body senses already sit in its memory, so their rings cost nothing to open; they are rings
// all the same, so an entity search ends at the same ring a block search for the same place would.
function entityRings(bot, opts = {}) {
  const c = centreOf(bot, opts.center);
  const reach = Number.isFinite(opts.reach) ? opts.reach : Infinity;
  const match = typeof opts.match === 'function' ? opts.match : () => true;
  const byRing = new Map();
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity || !match(e)) continue;
    const d = flat(e.position, c);
    if (d > reach) continue;
    const ring = Math.floor(d / RING_BLOCKS);
    const held = byRing.get(ring);
    if (held) held.push({ entity: e, distance: d }); else byRing.set(ring, [{ entity: e, distance: d }]);
  }
  const order = [...byRing.keys()].sort((a, b) => a - b);
  let i = 0;
  return {
    next() {
      if (i >= order.length) return null;
      const index = order[i++];
      const entities = byRing.get(index).sort((a, b) => a.distance - b.distance);
      return { index, inner: index * RING_BLOCKS, outer: (index + 1) * RING_BLOCKS, entities };
    },
  };
}

function nearestEntity(bot, opts) {
  const ring = entityRings(bot, opts).next();
  return ring ? ring.entities[0].entity : null;
}

// Every matching entity within reach, ring by ring, nearest first.
function entitiesNearest(bot, opts) {
  const rings = entityRings(bot, opts);
  const out = [];
  for (let ring = rings.next(); ring; ring = rings.next()) for (const r of ring.entities) out.push(r);
  return out;
}

module.exports = { RING_BLOCKS, readerFor, namesMatching, blockRings, nearestBlocks, entityRings, nearestEntity, entitiesNearest };
