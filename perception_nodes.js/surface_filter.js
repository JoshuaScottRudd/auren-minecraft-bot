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

let _lastScan = null;

// The ring search's own reader (one per bot), backing the `name`/`boundingBox` reads surfaceYAt,
// isExposedToAir and collapseToTrunkBases make per scan.
const { readerFor } = require('@utils/ring_scan');

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
// A TREE GROWS UNDER THE SKY: from its trunk base up to SURFACE_SCAN_TOP every cell is its own wood, leaves, or
// something without a collision box. A log under rock is a cave's or a structure's, and reaching it means
// tunnelling down among what spawns there, under gravel that falls on the digger.
function underSky(reader, pos) {
  for (let y = pos.y + 1; y <= SURFACE_SCAN_TOP; y++) {
    const b = reader.blockAt(pos.x, y, pos.z);
    if (!b) return true;   // past what the reader holds: nothing above was read as solid
    if (b.name === 'air' || LOG_RE.test(b.name) || LEAF_RE.test(b.name)) continue;
    if (b.boundingBox === 'block') return false;
  }
  return true;
}

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
// The fleet's ring search (@utils/ring_scan) over the surface band, with this node's rules on it: a target is
// open to the air, logs collapse to their trunk bases, and a trunk is kept only under the sky (underSky). A ring
// holding none is passed over, so every answer has something in it; null at the edge of what the body has
// loaded, or `filter.reach` blocks out.
//
// filter.center {x,z}  where the rings are centred; the body when omitted.
// filter.reach         blocks from the centre past which no ring is opened.
// filter.exclude       (position) => true rules a cell out before it is counted.
// `cost()` is what the rings opened so far have cost: { rings, read, skipped, ms, raw }.
function openRings(bot, filter) {
  const reader = readerFor(bot);
  const here = bot.entity.position.floored();
  const names = targetNames(filter?.targets);
  const LOGS = new Set(OBJECT_GROUPS.logs || []);
  const wantsTrunks = [...names].some(n => LOGS.has(n));
  const surfaceY = surfaceYAt(bot, reader, here.x, here.z);
  const rings = require('@utils/ring_scan').blockRings(bot, {
    names,
    center: filter?.center,
    reach: filter?.reach,
    band: { low: surfaceY - BAND_BELOW, high: surfaceY + BAND_ABOVE },
    exclude: filter && typeof filter.exclude === 'function' ? filter.exclude : null,
    accept: (r, p) => isExposedToAir(r, p),   // buried = unreachable, never a target
    collapse: wantsTrunks ? async (r, hits) => (await collapseToTrunkBases(r, hits)).filter(t => underSky(r, t.position)) : null,
    source: 'surface_filter.rings',
  });
  return { next: rings.next, cost: rings.cost, wantsTrunks, loadedSections: rings.loadedSections };
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
