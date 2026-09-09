// fragment: surface_filter (perception)
// purpose: find, on the SURFACE, exposed blocks matching a filter and return them nearest-first.
// invariants:
//  - Surface-centered, not bot-centered: the search is anchored to the surface column at the bot's
//    XZ, so a bot underground still finds surface grass/trees (the surface above it is a loaded
//    chunk). The result reports where it scanned (onSurface / surfaceY) so the caller can react —
//    finding a target is not reaching it; navigation/exploration owns the trek up.
//  - Only air-exposed blocks are returned (a buried target is unreachable and not worth digging to).
//  - Nearest-first relative to the bot's real position (what it actually has to walk to).
// WHY: Pure perception — a synchronous, on-demand scanner called directly by action fragments
// (seed_picker, harvest_executor, tree_feller) per Law 1's perception exception. It makes no
// decisions and routes no signals; it reports what's out there.
//
// HOW it queries: the server keeps NO index of blocks by type — chunk data lives in the client's
// loaded columns, so any "where is X" is a client-side read. mineflayer's bot.findBlocks is the fast,
// idiomatic form of that: it walks the section/palette storage (skipping empty sections), matches
// block ids directly, and returns positions nearest-first — replacing the old ~1M-read brute-force
// cubic blockAt loop. Exposure is applied as a cheap post-filter on the (few) matches, not on every
// cell.
//
// scan(bot, filter) → { summary: { target, filtered, onSurface, surfaceY, ... }, objectives: [{name, position}] }
// filter.exclude (optional) — (position) => true to rule a cell OUT. It is applied inside the query,
// not to the result, which is the difference between "nothing is available" and "nothing was looked at".
// Last scan stays in memory (getLastScan) — consumers (e.g. the navigator's candidates_ref) read it.

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { group_to_item } = require('@utils/fragment_utils');
const { makeVoxelReader } = require('@utils/voxel_reader');

let _lastScan = null;

// THE READER HALF OF THE FRONT DOOR, WITHOUT THE PACER — and that split is the point. Pacing and
// reading are two different needs. The note at MAX_DISTANCE below already settled that this
// node must NOT pace (it makes one synchronous findBlocks call; there is no per-cell loop to yield in,
// and manufacturing one would restore the ~1M-read sweep findBlocks replaced). But findBlocks is not the
// whole scan: surfaceYAt walks a column, isExposedToAir probes six neighbours per match, and
// collapseToTrunkBases walks each trunk down — hundreds to thousands of reads, every one of them asking
// only `name` and `boundingBox`. Those go through the declared-needs reader. So this node takes the half
// it needs and declines the half it does not, which is what declaring needs is FOR.
//
// One reader per bot, not per scan: the number table is memoized inside it, and rebuilding it per call
// would pay the classification cost on every scan instead of once. WeakMap so a disconnected bot's
// reader is collected with it (Law 8 — nothing outlives its owner).
const _readers = new WeakMap();
function readerFor(bot) {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
}

// Bounded by COUNT, not distance. findBlocks iterates OUTWARD from the point (nearest-first) and
// stops as soon as it has MAX_MATCHES hits — so a common target (grass, logs) stops almost
// immediately regardless of the ceiling, and a rare one is bounded by the loaded-chunk horizon. This
// is why the old tight 32-radius (there to cap the brute-force loop's compute) is no longer needed: a
// direct type query self-limits by count. MAX_DISTANCE is just a ceiling ~ the loaded-chunk horizon.
//
// THE TRAP THAT PROPERTY SETS, and why `exclude` exists (read this before removing it). "Stops almost
// immediately" means the budget for a COMMON block is spent inside ~6 blocks — mineflayer's findBlocks
// breaks the moment a completed chunk-section layer holds `count` hits, then sorts by distance and
// slices to the nearest `count`. That is a performance virtue and a correctness trap: a caller that
// filters the RESULT against an exclusion zone WIDER than the budget's reach can only ever get the
// empty set, because every block the query ever saw was inside the zone — indistinguishable from the
// world genuinely being empty, though the scan simply never looked far enough.
// So an exclusion belongs INSIDE the query, never after it: `exclude` rides in findBlocks' own
// useExtraInfo hook, which runs per candidate BEFORE the block is counted against the budget, so the
// search walks outward until it has `count` blocks the caller can actually use. Filter first, budget
// second — the reverse is a guaranteed empty answer wearing the face of an honest one.
// UNCAPPED to the loaded frontier: findBlocks can only ever see LOADED chunks, so the loaded horizon —
// the server's view-distance (10 chunks ≈ 160 blocks) — is the real ceiling; this constant only needs
// to exceed it so the frontier, not an arbitrary number, is the bound. A cap sitting INSIDE the
// view-distance frontier fences off already-loaded terrain: a target beyond the cap but inside a
// loaded chunk is reported "none found" though it was reachable. 256 clears a 16-chunk view-distance
// with margin; raise it if the server's view-distance is ever set higher.
//
// WHY NOT voxel_scan_throttle here — the mechanism does not fit. That pacer yields between iterations
// of a MANUAL cell loop (find_buildingspot's ring sweep, the wheat scanner).
// surface_filter makes ONE synchronous bot.findBlocks call — the palette sweep that REPLACED the old
// brute-force voxel loop (see the budget note above). There is no per-cell loop to insert `await pace()`
// into, and re-introducing one to make the throttle applicable would restore the ~1M-read cost findBlocks
// was adopted to kill (Law 16). Uncapping is safe without it: findBlocks self-limits at `count` for a
// common target (grass/dirt stop within a few blocks), and the only full-horizon sweep is a scarce/absent
// target — a single optimised pass bounded by the loaded chunks, not a fleet-stalling loop.
const MAX_DISTANCE = 256;
const MAX_MATCHES = 100;         // return up to this many nearest matches; navigator multi-targets them
const SURFACE_SCAN_TOP = 160;    // highest Y a natural overworld surface realistically reaches

// ── EXPANDING RINGS, BECAUSE THE PARAGRAPH ABOVE IS ONLY TRUE FOR COMMON TARGETS ────────────────────
// MEASURED 2026-09-04, twelve bots on the public server: a single log scan took **10.4 SECONDS**, and
// the bots ran them back to back, forever. That one number explains most of what the fleet had been
// blamed for — bots taking 23-33s to make their first move, bots burning a whole CPU core, and bots
// dropped by the server for failing to answer a keep-alive inside 30s.
//
// WHY THE ORIGINAL REASONING MISSED IT, and it is a good miss to understand. The note above is right
// that findBlocks "stops almost immediately" for a common target: it breaks as soon as a completed
// section layer holds `count` hits. The unstated premise is that `count` gets FILLED. For a SCARCE
// target it never does, so there is no early break and the call sweeps every loaded section out to
// MAX_DISTANCE — and a log request asks for 800 blocks (MAX_MATCHES x LOG_BLOCKS_PER_TRUNK), which a
// deforested base will never supply. The header predicted this exact case and judged it acceptable as
// "a single optimised pass". It is not a single pass: the caller that gets an unusable answer scans
// again, and 10 seconds every 10 seconds is a busy loop wearing the face of perception.
//
// THE FIX IS THE SEARCH ORDER, NOT THE SEARCH. Ask the near volume first and stop as soon as the answer
// is usable. Volume is cubic, so the first ring is ~0.7% of the full horizon's cells: when a tree is
// anywhere nearby — the overwhelmingly common case — the scan gets ~150x cheaper for an identical
// result, because nearest-first ordering means the near ring already holds the blocks the caller would
// have picked out of the far one.
//
// MEASURED RING COSTS, live server, 12-bot world, logs, 2026-09-04 — the numbers the tuning is built on
// rather than reasoned toward, because the volume argument above got the SHAPE right and the DECISION
// wrong on its first attempt:
//
//     ring  48   ~200 ms     0-4 trees
//     ring 112  ~1500 ms     4-5 trees
//     ring 256 ~10500 ms     5-6 trees      <- 50x the cost of ring 112 for ONE more tree
//
// The full horizon is not "the expensive tail of a search", it IS the search cost, and what it buys is
// almost nothing. Everything worth having is inside 112 blocks — which makes sense the moment you look
// at the server: `view-distance=8` means the loaded frontier is ~128 blocks, so most of ring 256 is
// scanning chunks that are not there.
//
// WHAT IT COSTS WHEN THE TARGET IS GENUINELY ABSENT: three sweeps instead of one, ~1.1x, because the
// two inner rings are nearly free next to the outer. That case is then handled by the negative memo
// below rather than by making the rings cleverer.
//
// SATISFACTION IS MEASURED AFTER THE COLLAPSE, NOT ON RAW HITS. A ring is only "enough" if it yields
// enough USABLE candidates — exposure-filtered and collapsed to trunk bases — because raw log blocks
// are not trees, and stopping on raw hits would hand the feller a fistful of canopy branches and send
// it straight back for another scan. Cheap to do: the post-filters run on the few matches, never on the
// volume.
//
// TIER_SATISFIED IS THE SURVEY DEFAULT, AND A HOT CALLER MUST OVERRIDE IT WITH `filter.enough`.
// THIS NUMBER MADE THE RINGS ACTIVELY WORSE on their first outing and the failure is worth keeping:
// with a fixed 8, a base ringed by 5 trees could never be satisfied by a near ring, so every scan paid
// 48 AND 112 AND 256 — three sweeps where the old single-call code paid one — while the caller that
// triggered it had asked for ONE log. Rings only pay off when something can stop them, and a perception
// node has no way to know what "enough" means for a caller it cannot see. 8 stays as the default because
// the callers that DON'T override it are surveys (set_wood_preference counts trunks per species to
// choose one), and a survey genuinely wants the horizon.
const SCAN_TIERS = [48, 112, MAX_DISTANCE];
const TIER_SATISFIED = 8;        // SURVEY default only — a caller with a smaller need passes `enough`

// ── THE NEGATIVE MEMO ───────────────────────────────────────────────────────────────────────────────
// Rings fix the case where the thing EXISTS. This fixes the case where it does not: a bot standing in a
// deforested base asking "any logs within 256 blocks?" gets the same answer every ten seconds, and pays
// the full horizon for it every time. Six bots doing that is a permanently busy machine.
//
// DELIBERATELY NARROW, because a perception node returning a remembered answer is exactly the kind of
// shortcut that goes wrong quietly. It only ever suppresses a repeat of a question already answered
// with NOTHING, at the FULL horizon, from ~the same place, within a few seconds:
//   - only a full-horizon sweep that found ZERO usable candidates is memoized; any success clears it
//   - keyed by the target set AND a 16-block-quantised position, so walking a chunk away re-asks
//   - 30s TTL, against a caller that re-asks every ~10s
//   - per bot (WeakMap), so it dies with the bot (Law 8)
// Nothing that FOUND something is ever cached, so a memo can never substitute a stale answer for a real
// one — the only thing it can do is decline to re-run a sweep that just came back empty.
const NEGATIVE_MEMO_MS = 30000;
const MEMO_CELL = 16;
const _negativeMemo = new WeakMap();

function memoKey(filter, center) {
  const names = [...targetNames(filter?.targets)].sort().join(',');
  const q = v => Math.floor(v / MEMO_CELL);
  return `${names}@${q(center.x)},${q(center.y)},${q(center.z)}`;
}

// Log scans budget in the WRONG UNIT unless corrected: findBlocks counts log BLOCKS, but
// collapseToTrunkBases folds each whole trunk column into ONE base, so a block-sized budget spent on
// multi-block trunks surfaces far fewer trees than the budget number implies — the tree horizon is
// pinned low no matter how many trees stand around it. Ask for enough blocks that ~MAX_MATCHES TRUNKS
// survive the collapse. Only logs collapse, so only logs pay the larger scan.
const LOG_BLOCKS_PER_TRUNK = 8;  // conservative blocks-per-tree (trunk + branches) for the budget

// Group-token expansion for scan-target matching (e.g. 'stone' -> stone+andesite+diorite+granite,
// 'logs' -> every log species). Sourced from the canonical group_to_item so a scan for a group means
// the same block set everywhere. 'stone' deliberately excludes cobblestone (a drop product, not a
// terrain block), so this never targets player-placed cobblestone.
const OBJECT_GROUPS = group_to_item;

const LEAF_RE = /(.*_)?leaves$/;
const LOG_RE  = /(.*_)?(log|stem|wood|hyphae)$/;

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
// Tree logs/leaves are skipped so a tree doesn't report as the surface. Falls back to the bot's own
// Y if nothing solid is found (unloaded column) — the scan then behaves bot-centered, no worse than
// before. One column of blockAt reads, cheap.
function surfaceYAt(bot, reader, x, z) {
  const bottom = Math.floor(bot.entity.position.y) - 8;
  for (let y = SURFACE_SCAN_TOP; y >= bottom; y--) {
    const b = reader.blockAt(x, y, z);
    if (b && b.boundingBox === 'block' && !LEAF_RE.test(b.name) && !LOG_RE.test(b.name)) return y;
  }
  return Math.floor(bot.entity.position.y);
}

// Group dominance: among matched blocks, keep only the single most-common type. WHY: a group scan
// ('stone') should commit the approach to ONE material rather than interleaving andesite/diorite/etc,
// which keeps the locomotion target set coherent. Returns { blocks, resolved }.
function dominantMatch(scanned) {
  const freq = {};
  for (const b of scanned) freq[b.name] = (freq[b.name] || 0) + 1;
  const dominant = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return { blocks: [], resolved: null };
  return { blocks: scanned.filter(b => b.name === dominant), resolved: dominant };
}

// collapseToTrunkBases: group log blocks by XZ column, keep the lowest Y per column, then walk down
// through contiguous same-type blocks (a direct world read, ignoring exposure) to the true trunk
// base — the bottom log is wedged air-tight so it never shows as "exposed". A column counts as a real
// trunk only if its base rests on solid, non-tree ground; a branchy canopy log juts sideways and its
// XZ column bottoms out on air/leaves, so those phantom high-Y "trees" are dropped here (Law 16: this
// node alone decides what is a tree, so the feller never routes up to a branch and stalls).
function collapseToTrunkBases(reader, blocks) {
  const byXZ = new Map();
  for (const block of blocks) {
    const key = `${block.position.x},${block.position.z}`;
    const existing = byXZ.get(key);
    if (!existing || block.position.y < existing.position.y) byXZ.set(key, block);
  }
  const bases = [];
  for (const block of byXZ.values()) {
    let { x, y, z } = block.position;
    while (true) {
      const below = reader.blockAt(x, y - 1, z);
      if (below && below.name === block.name) y -= 1; else break;
    }
    const below = reader.blockAt(x, y - 1, z);
    const groundSupported = below && below.boundingBox === 'block'
      && !LEAF_RE.test(below.name) && !LOG_RE.test(below.name);
    if (!groundSupported) continue;   // branch/canopy log, not a trunk — drop it
    bases.push(y === block.position.y ? block : { name: block.name, position: { x, y, z } });
  }
  return bases;
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
  // `how` reports WHICH RING answered, or that a remembered empty did. Without it the expensive case
  // and the cheap case print the same line, and the 10-second sweep this file was rebuilt to kill was
  // invisible in the trace for exactly that reason.
  watcher.summary('surface_filter', `Scan complete: ${out.length} ${resolved || 'unknown'} found (${where}, filter=${filter?.type || 'none'}${how ? `, ${how}` : ''})`);
  return output;
}

function scan(bot, filter) {
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

  // Type mode ('object_group_or_direct'): anchor the search on the surface column at the bot's XZ so
  // surface targets are found regardless of the bot's depth, then query by id via findBlocks.
  const ids = targetIds(bot, filter?.targets);
  const surfaceY  = surfaceYAt(bot, reader, center.x, center.z);
  const onSurface = Math.abs(center.y - surfaceY) <= 2;
  const surface   = { surfaceY, onSurface };

  // Trunk-aware budget: a log request is collapsed to one base per column downstream, so spend the
  // block budget in trunks (see LOG_BLOCKS_PER_TRUNK). Same log test as the collapse trigger below.
  const LOGS = new Set(OBJECT_GROUPS.logs || []);
  const wantsTrunks = [...targetNames(filter?.targets)].some(n => LOGS.has(n));
  const blockBudget = wantsTrunks ? MAX_MATCHES * LOG_BLOCKS_PER_TRUNK : MAX_MATCHES;

  // `exclude(position) -> true` marks a cell the CALLER cannot use. Handed to findBlocks as
  // useExtraInfo (a per-candidate predicate it evaluates before counting the hit) rather than applied
  // to the returned array — see the budget note at the top of this file for the livelock that ordering
  // caused. Passing it also keeps the palette-based section skip, because `matching` stays an id list.
  const callerExclude = filter && typeof filter.exclude === 'function' ? filter.exclude : null;

  // ── THE SPAWN-PROTECTED SQUARE IS EXCLUDED FROM EVERY TYPE SEARCH, CALLER OR NO CALLER ───────────
  // This is the fleet's ONE surface-candidate search: trees, crops, seeds, salvage and the navigator's
  // candidate list all come out of here. Composing the keep-out into the search itself is what turns
  // "the server refuses this tree" into "this tree was never a candidate" — the difference between a
  // bot that walks to spawn, swings, is refused, replans and walks back, and a bot that picks the next
  // tree out instead. That loop is the whole reason the gate belongs at selection and not only at the
  // swing (Law 27: the failing case cannot form inside the thing that would have to form it).
  //
  // IT MUST COMPOSE WITH THE CALLER'S FILTER, NEVER REPLACE IT. harvest_executor passes its own base
  // keep-out; a scan that dropped it in favour of this one would send bots to farm their own build.
  //
  // TYPE MODE ONLY — the coordinates branch above returns before this. There the caller named exact
  // cells and is asking what is AT them, so silently omitting some would answer a question it did not
  // ask (Law 25: the asker owns the criterion), and the integrity scanners that read that way would
  // start reporting protected cells as absent rather than as protected. Acting on such a cell is still
  // refused, at the dig authority, which is where an act is refused rather than a reading edited.
  // The box is hoisted ONCE and compared inline, and the predicate is only installed when there is
  // actually something to exclude. Both matter here and nowhere else: useExtraInfo makes findBlocks
  // materialise a full block object per candidate instead of matching ids out of the palette, so
  // handing it an always-present predicate would put that cost on every scan in the fleet — including
  // the runs where spawn protection is switched off and nothing is being excluded at all. Null when the
  // rule is off or the world spawn is not known yet, which restores the original fast path exactly.
  const { spawnProtectionBox } = require('@perception/spawn_protection');
  const spawnBox = spawnProtectionBox(bot);
  let spawnHeld = 0;
  const exclude = (callerExclude || spawnBox)
    ? (position) => {
        if (callerExclude && callerExclude(position)) return true;
        if (spawnBox && position
            && Math.max(Math.abs(Math.floor(position.x) - spawnBox.centerX),
                        Math.abs(Math.floor(position.z) - spawnBox.centerZ)) <= spawnBox.radius) {
          spawnHeld++;
          return true;
        }
        return false;
      }
    : null;

  // The full pipeline for ONE ring. Kept as a closure rather than inlined three times so the tiers
  // cannot drift apart in what they mean by "a usable candidate" (Law 16).
  const sweep = (radius) => {
    // Reset per ring, not accumulated across them: each ring re-scans the ground the last one covered,
    // so a running total would count the same protected tree once per tier and report a number that
    // never existed in the world (Law 25 — the count has to be true, not merely large).
    spawnHeld = 0;
    let scanned = [];
    if (ids.length) {
      const positions = bot.findBlocks({
        point: new Vec3(center.x, surfaceY, center.z),
        matching: ids,
        maxDistance: radius,
        count: blockBudget,
        ...(exclude ? { useExtraInfo: b => !!b && !exclude(b.position) } : {}),
      });
      for (const p of positions) {
        if (!isExposedToAir(reader, p)) continue;   // buried = unreachable, skip
        const b = reader.blockAt(p.x, p.y, p.z);
        if (b) scanned.push({ name: b.name, position: { x: p.x, y: p.y, z: p.z } });
      }
    }

    // Logs are felled by DISTANCE, every species equal — no per-scan species preference. So a log scan
    // collapses ALL matched species to trunk bases and returns them together; the nearest-first sort in
    // finalize() then does the ordering. Non-log groups (e.g. 'stone') still commit to one dominant
    // material — there the coherence is wanted (mine one stone type); for logs species-uniformity is
    // not. Reuses wantsTrunks (the same log test that sized the block budget) so "is this a log scan"
    // is decided in exactly one place (Law 16).
    if (wantsTrunks) return { blocks: collapseToTrunkBases(reader, scanned), resolved: 'logs' };
    const match = dominantMatch(scanned);
    return { blocks: match.blocks, resolved: match.resolved };
  };

  // A repeat of a question that just came back empty at the full horizon — see NEGATIVE_MEMO_MS. The
  // memo is consulted BEFORE any sweep, which is the whole point: the cost being avoided is the sweep.
  const key = memoKey(filter, center);
  const memo = _negativeMemo.get(bot);
  if (memo && memo.key === key && Date.now() - memo.at < NEGATIVE_MEMO_MS) {
    return finalize(filter, [], memo.resolved, center, surface, 'memo');
  }

  // ENOUGH IS THE CALLER'S NUMBER, NOT THE NODE'S. The first version of this loop used a fixed
  // TIER_SATISFIED=8 and it made the rings WORSE, not better: a base with 5 trees around it never
  // reached 8, so every scan paid ring 48 AND ring 112 AND the full horizon — three sweeps where the
  // original code paid one. The caller had asked for ONE tree. A perception node cannot know what
  // "enough" means; only the fragment with the need does (Law 25 — the asker owns the criterion), so
  // `filter.enough` carries it and TIER_SATISFIED is only the default for a caller that says nothing.
  const enough = Number.isFinite(filter?.enough) && filter.enough > 0 ? filter.enough : TIER_SATISFIED;

  let result = { blocks: [], resolved: null };
  let tierUsed = null;
  // Per-ring cost and yield, reported in the trace. MEASURED, NOT ASSUMED: this file has now been
  // wrong twice about which ring is expensive, both times from reasoning about volume instead of
  // timing the call. The numbers cost one Date.now() per ring and they are the only thing that makes
  // the next tuning decision an observation rather than a third guess.
  const tierTrace = [];
  for (const radius of SCAN_TIERS) {
    const t0 = Date.now();
    result = sweep(radius);
    tierUsed = radius;
    tierTrace.push(`${radius}:${result.blocks.length}/${Date.now() - t0}ms`);
    // Stop at the first ring that can actually answer the caller. The last ring always ends the loop,
    // so an absent target still gets the honest full-horizon "nothing".
    if (result.blocks.length >= enough) break;
  }

  if (tierUsed === MAX_DISTANCE && result.blocks.length === 0) {
    _negativeMemo.set(bot, { key, at: Date.now(), resolved: result.resolved });
  } else if (result.blocks.length > 0) {
    _negativeMemo.delete(bot);   // anything found retires the memo immediately
  }

  // The spawn keep-out is named in the scan line whenever it held anything. Without it a bot standing
  // beside a forest inside the protected square reports "0 found" and reads as an empty world, which is
  // the one wrong conclusion this whole gate would otherwise cause a reader to draw (Law 6).
  const how = `rings ${tierTrace.join(' ')}${spawnHeld > 0 ? `, ${spawnHeld} held by spawn protection` : ''}`;
  return finalize(filter, result.blocks, result.resolved, center, surface, how);
}

function getLastScan() { return _lastScan; }

module.exports = { scan, getLastScan };
