// fragment: surface_filter (perception)
// Finds, on the surface, exposed (air-adjacent) blocks matching a filter and returns them nearest-first
// to the bot. Anchored to the surface column at the bot's XZ, not the bot's own Y, so a bot underground
// still finds surface targets; reports where it scanned (onSurface/surfaceY) so the caller can react.
// A synchronous, on-demand scanner called by action fragments per Law 1's perception exception.
//
// openRings(bot, filter) → { next() } — the world read one 16-block ring at a time, for an asker that
//   checks each ring's answer before it asks for the next (the tree feller, the punch path).
// offer(bot, filter, objectives, resolved, how) — what such an asker hands the navigator from a ring.
// scan(bot, filter) → { summary: { target, filtered, onSurface, surfaceY, ... }, objectives: [{name, position}] }
//   the same rings, gathered into one list for an asker that wants the list (a census, a material).
// filter.exclude (optional) — (position) => true to rule a cell OUT, applied inside the read rather
// than to the result (an excluded caller then gets "nothing available", not "nothing was looked at").
// Last scan stays in memory (getLastScan) — consumers (e.g. the navigator's candidates_ref) read it.

const watcher = require('@kernel/watcher');
const { group_to_item } = require('@utils/fragment_utils');
const { makeVoxelReader } = require('@utils/voxel_reader');

let _lastScan = null;

// Declares only the read need this node has (`type`), backing the hundreds of `name`/`boundingBox`
// reads surfaceYAt, isExposedToAir and collapseToTrunkBases make per scan.
// One reader per bot, memoized. WeakMap so a disconnected bot's reader is collected with it (Law 8).
const _readers = new WeakMap();
function readerFor(bot) {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
}

// A material scan ends at the ring that brings it to MAX_MATCHES reachable blocks, because the
// navigator multi-targets the whole answer. `exclude` and the open-to-air test both run inside the
// read, before a block is counted, so buried blocks and a wide exclusion zone never fill the count.
const MAX_MATCHES = 100;
const SURFACE_SCAN_TOP = 160;    // highest Y a natural overworld surface realistically reaches

// A section whose whole Y range sits well below the local surface cannot hold an exposed surface
// target. Loose because `surfaceY` is measured at the bot's column and terrain far away may differ.
const BAND_BELOW = 40;
const BAND_ABOVE = 48;

// ── THE NEGATIVE MEMO ───────────────────────────────────────────────────────────────────────────────
// Suppresses a repeat of a question already answered with nothing from ~the same place within a few
// seconds: only a zero-candidate scan is memoized (any success clears it), keyed by target set + a
// 16-block-quantised position, 30s TTL, per bot (WeakMap, Law 8).
const NEGATIVE_MEMO_MS = 30000;
const MEMO_CELL = 16;
const _negativeMemo = new WeakMap();

function memoKey(filter, center) {
  const names = [...targetNames(filter?.targets)].sort().join(',');
  const q = v => Math.floor(v / MEMO_CELL);
  return `${names}@${q(center.x)},${q(center.y)},${q(center.z)}`;
}

// Group-token expansion (e.g. 'stone' -> stone+andesite+diorite+granite). Sourced from the canonical
// group_to_item so a scan for a group means the same block set everywhere; 'stone' excludes cobblestone.
const OBJECT_GROUPS = group_to_item;

// What counts as a tree lives in @perception/trunk_bases — one definition shared with the assessors
// (Law 16); the regexes come back with it so a species test here can't drift from the collapse's.
const { collapseToTrunkBases, LEAF_RE, LOG_RE } = require('@perception/trunk_bases');

// WHY exposure: adjacency to air approximates visibility / minimal digging — a buried target is both
// unreachable and would mean tunnelling, so it is not a candidate.
const NEIGHBOR_OFFSETS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function isExposedToAir(reader, pos) {
  return NEIGHBOR_OFFSETS.some(([dx, dy, dz]) => {
    const n = reader.blockAt(pos.x + dx, pos.y + dy, pos.z + dz);
    return n && n.name === 'air';
  });
}

// Expand a filter's target tokens to concrete block names (group tokens resolved). Shared by the id
// lookup and the log-budget check so both mean the same block set (Law 16).
function targetNames(targets) {
  return new Set((targets || []).flatMap(t => OBJECT_GROUPS[t] || [t]));
}

// Resolve the block ids a filter targets (group tokens expanded). Unknown names are dropped so
// findBlocks gets a clean id list.
function targetIds(bot, targets) {
  const ids = [];
  for (const n of targetNames(targets)) {
    const blk = bot.registry?.blocksByName?.[n];
    if (blk) ids.push(blk.id);
  }
  return ids;
}

// The surface Y at a column: the topmost solid, non-tree block scanning down from the build ceiling.
// Falls back to the bot's own Y if nothing solid is found (unloaded column).
function surfaceYAt(bot, reader, x, z) {
  const bottom = Math.floor(bot.entity.position.y) - 8;
  for (let y = SURFACE_SCAN_TOP; y >= bottom; y--) {
    const b = reader.blockAt(x, y, z);
    if (b && b.boundingBox === 'block' && !LEAF_RE.test(b.name) && !LOG_RE.test(b.name)) return y;
  }
  return Math.floor(bot.entity.position.y);
}

// Group dominance: among matched blocks, keep only the single most-common type, so a group scan
// commits the approach to one material and never interleaves andesite/diorite/etc.
function dominantMatch(scanned) {
  const freq = {};
  for (const b of scanned) freq[b.name] = (freq[b.name] || 0) + 1;
  const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return { blocks: [], resolved: null };
  return { blocks: scanned.filter(b => b.name === dominant), resolved: dominant };
}

function dist2(p, c) {
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
  return dx * dx + dy * dy + dz * dz;
}

// Common tail: nearest-first sort (relative to the bot, i.e. what it must walk to), package, cache, log.
function finalize(filter, blocks, resolved, center, surface, how) {
  const out = Array.isArray(blocks) ? blocks.slice() : [];
  if (out.length > 1) out.sort((a, b) => dist2(a.position, center) - dist2(b.position, center));

  const output = {
    summary: {
      timestamp: new Date().toISOString(),
      filtered: out.length,
      filterType: filter?.type || 'none',
      target: resolved || 'unknown',
      onSurface: surface ? surface.onSurface : null,
      surfaceY:  surface ? surface.surfaceY : null,
    },
    objectives: out,
  };
  _lastScan = output;

  const where = surface ? (surface.onSurface ? 'at surface' : `surface y=${surface.surfaceY} (scanned from below)`) : 'coordinates';
  // `how` carries what the walk cost, or that a remembered empty answered instead of a walk.
  watcher.summary('surface_filter', `Scan complete: ${out.length} ${resolved || 'unknown'} found (${where}, filter=${filter?.type || 'none'}${how ? `, ${how}` : ''})`);
  return output;
}

// ── openRings — THE WORLD READ ONE RING AT A TIME ───────────────────────────────────────────────────
// A ring is RING_BLOCKS wide, measured flat from the centre: ring 0 is 0–16 blocks out, ring 1 is 16–32.
// `next()` reads only the chunk sections the next ring needs and hands back that ring's targets, nearest
// first; a ring holding none is passed over, so every answer has something in it. It returns null when
// the rings have reached the edge of what the body has loaded, or `filter.reach` blocks out.
// Nothing is read twice: a section is read when the first ring touching its chunk asks, and what it
// held farther out waits for the ring it belongs to.
//
// filter.center {x,z}  where the rings are centred; the body when omitted.
// filter.reach         blocks from the centre past which no ring is opened.
// filter.exclude       (position) => true rules a cell out before it is counted.
// `cost()` is what the rings opened so far have cost: { rings, read, skipped, ms, raw }.
const RING_BLOCKS = 16;

function openRings(bot, filter) {
  const reader = readerFor(bot);
  const here = bot.entity.position.floored();
  const given = filter?.center;
  const cx = given && Number.isFinite(given.x) ? Math.floor(given.x) : here.x;
  const cz = given && Number.isFinite(given.z) ? Math.floor(given.z) : here.z;
  const reach = Number.isFinite(filter?.reach) ? filter.reach : Infinity;
  const names = targetNames(filter?.targets);
  const ids = new Set(targetIds(bot, filter?.targets));
  const LOGS = new Set(OBJECT_GROUPS.logs || []);
  const wantsTrunks = [...names].some(n => LOGS.has(n));
  const exclude = filter && typeof filter.exclude === 'function' ? filter.exclude : null;
  const surfaceY = surfaceYAt(bot, reader, here.x, here.z);

  const Block = require('prismarine-block')(bot.registry);
  // A section with no palette is on the global palette and cannot be ruled out, so it is read.
  const paletteHolds = (section) => {
    if (!section.palette) return true;
    for (const stateId of section.palette) {
      const b = Block.fromStateId(stateId, 0);
      if (b && ids.has(b.type)) return true;
    }
    return false;
  };

  // Every loaded section in the surface band, nearest chunk first. `d` is the flat distance from the
  // centre to the chunk's nearest cell, so no block in the chunk is nearer than `d`.
  const minY = bot.game?.minY ?? -64;
  const totalSections = (bot.game?.height ?? 384) >> 4;
  const bandLow = surfaceY - BAND_BELOW, bandHigh = surfaceY + BAND_ABOVE;
  const jobs = [];
  if (ids.size) {
    for (const entry of (bot.world?.getColumns?.() || [])) {
      const col = entry?.column;
      if (!col || !Array.isArray(col.sections)) continue;
      const bx = Number(entry.chunkX) * 16, bz = Number(entry.chunkZ) * 16;
      const dx = cx < bx ? bx - cx : (cx > bx + 15 ? cx - (bx + 15) : 0);
      const dz = cz < bz ? bz - cz : (cz > bz + 15 ? cz - (bz + 15) : 0);
      const d = Math.sqrt(dx * dx + dz * dz);
      for (let s = 0; s < totalSections; s++) {
        const y0 = minY + s * 16;
        if (y0 + 15 < bandLow || y0 > bandHigh) continue;
        if (!col.sections[s]) continue;
        jobs.push({ bx, bz, y0, d, section: col.sections[s] });
      }
    }
    jobs.sort((a, b) => a.d - b.d || a.y0 - b.y0);
  }

  const { makeExecutionPacer } = require('@utils/execution_yield');
  // The pacer's combat gate is armed with the body: a real engagement leaves the awaited promise
  // unresolved and this search is discarded mid-read.
  const pace = makeExecutionPacer({ bot, source: 'surface_filter.rings' });

  const waiting = new Map();   // ring index -> targets read already that lie in that ring
  const cost = { rings: 0, read: 0, skipped: 0, ms: 0, raw: 0 };
  let cursor = 0, k = 0;

  const readSection = (j) => {
    for (let x = j.bx; x < j.bx + 16; x++) {
      for (let y = j.y0; y < j.y0 + 16; y++) {
        for (let z = j.bz; z < j.bz + 16; z++) {
          const b = reader.blockAt(x, y, z);
          if (!b || !names.has(b.name)) continue;
          const p = { x, y, z };
          if (exclude && exclude(p)) continue;
          cost.raw++;
          if (!isExposedToAir(reader, p)) continue;   // buried = unreachable, never a target
          const ring = Math.floor(Math.hypot(x - cx, z - cz) / RING_BLOCKS);
          const held = waiting.get(ring);
          if (held) held.push({ name: b.name, position: p }); else waiting.set(ring, [{ name: b.name, position: p }]);
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
      // A trunk is one column, so every log of it lies in one ring and collapses to its base here.
      const objectives = wantsTrunks ? await collapseToTrunkBases(reader, hits) : hits;
      if (!objectives.length) continue;
      const flat2 = (o) => (o.position.x - cx) ** 2 + (o.position.z - cz) ** 2;
      objectives.sort((a, b) => flat2(a) - flat2(b));
      return { index, inner, outer, objectives };
    }
  }

  return { next, cost: () => ({ ...cost }), wantsTrunks, loadedSections: jobs.length };
}

async function scan(bot, filter) {
  const center = bot.entity.position.floored();
  const reader = readerFor(bot);

  // Coordinates mode: match the exact cells given — no radius search.
  if (filter && filter.type === 'coordinates') {
    const matches = (filter.targets || []).map(c => {
      const b = reader.blockAt(c.x, c.y, c.z);
      return b ? { name: b.name, position: { x: c.x, y: c.y, z: c.z } } : null;
    }).filter(Boolean);
    return finalize(filter, matches, 'coordinates', center, null);
  }

  // Type mode ('object_group_or_direct'): the rings, opened one after another. Trees are gathered out
  // to the loaded frontier (a census); a material stops at the ring that brings it to MAX_MATCHES.
  const surfaceY  = surfaceYAt(bot, reader, center.x, center.z);
  const surface   = { surfaceY, onSurface: Math.abs(center.y - surfaceY) <= 2 };

  // A repeat of a question already answered empty (NEGATIVE_MEMO_MS).
  const key = memoKey(filter, center);
  const memo = _negativeMemo.get(bot);
  if (memo && memo.key === key && Date.now() - memo.at < NEGATIVE_MEMO_MS) {
    return finalize(filter, [], memo.resolved, center, surface, 'memo');
  }

  const rings = openRings(bot, filter);
  const found = [];
  for (let ring = await rings.next(); ring; ring = await rings.next()) {
    for (const o of ring.objectives) found.push(o);
    if (!rings.wantsTrunks && found.length >= MAX_MATCHES) break;
  }
  // Logs are felled by distance with no species preference, so every species stays; a material group
  // (e.g. 'stone') commits to its one dominant block, nearest MAX_MATCHES of it.
  const match = rings.wantsTrunks ? { blocks: found, resolved: 'logs' } : dominantMatch(found);
  const blocks = rings.wantsTrunks ? match.blocks : match.blocks.slice(0, MAX_MATCHES);

  if (blocks.length === 0) _negativeMemo.set(bot, { key, at: Date.now(), resolved: match.resolved });
  else _negativeMemo.delete(bot);   // anything found retires the memo immediately

  const c = rings.cost();
  return finalize(filter, blocks, match.resolved, center, surface,
    `${c.rings} ring(s), ${c.read} read, ${c.skipped} skipped, ${c.ms}ms, ${c.raw} raw hit(s)`);
}

// offer(bot, filter, objectives, resolved, how) — targets an asker took from a ring (the ring whole, or what is
// left of it) become the answer the navigator reads, the same way a scan's list does.
function offer(bot, filter, objectives, resolved, how) {
  const center = bot.entity.position.floored();
  const surfaceY = surfaceYAt(bot, readerFor(bot), center.x, center.z);
  return finalize(filter, objectives, resolved, center, { surfaceY, onSurface: Math.abs(center.y - surfaceY) <= 2 }, how);
}

function getLastScan() { return _lastScan; }

module.exports = { scan, openRings, offer, dominantMatch, getLastScan };
