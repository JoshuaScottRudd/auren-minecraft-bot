// fragment: find_buildingspot (action)
// purpose: Locates viable surface positions for a named building from its building_blueprints.json
//          dimensions. Blueprint facing is literal — no rotation. Each candidate emits a center waypoint
//          and a footprint bounding box; locomotion_dispatcher.goNear picks which is reached.
//
// Scan PIPELINE: validate the blueprint, walk the candidate grid, keep the nearest survivor, report,
// route. The shaft-safety diagonal-descent overlay (payload.require_shaft) lives in
// @utils/building_site_overlays and is only called from here.
//
// invariants:
//  - payload.blueprint_name must match a key in building_blueprints.buildings
//  - Missing blueprint or bad dimensions = CODING VIOLATION → throw (Law 13)
//  - No viable spot found = environmental failure → route to recursive_judge
//  - Hands the candidate set to locomotion_dispatcher.goNear; on arrival routes to set_buildspot

const hq      = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
// Building room keys carry an owner; this strips one back to the structure name (Law 16 — one rule, one place).
const { roomKeyName } = require('@foreman/message_schema');
const blueprintSurvey   = require('@perception/blueprint_survey');   // footprintExtent — the blueprint's true XZ reach (Law 1: a fragment may read a perception node directly)
const Vec3    = require('vec3');

// PLANTABLE_GROUND — blocks a tree-farm floor may rest on unmodified: the 'dirt' group
// building_integrity also uses to judge a floor cell satisfied (Law 16).
const { group_to_item } = require('@utils/fragment_utils');
const PLANTABLE_GROUND = new Set(group_to_item.dirt || []);

// Shaft-safety diagonal-descent overlay plus shared site-geometry primitives used with the base scan (Law 16).
const {
  BUFFER_BLOCKS,
  overlapsExisting,
  overheadClear,
  getBiomeName,
  evaluateStaircasePrism,
} = require('@utils/building_site_overlays');

// Column-read and expanding-ring primitives, shared with the arena bench (Law 16).
const siteGeometry = require('@utils/site_geometry');

// Settle-able biome set (plains + forest), same set exploration uses to stop seeking (Law 16).
const { ACCEPTABLE_BIOMES } = require('@thinking/architect_config');

// Shared scan pacer (Law 16, Law 19) so the uncapped search never stalls the tick.
const { makeExecutionPacer } = require('@utils/execution_yield');

// ── Tuning constants — surface scan ──────────────────────────────────────────
// BUFFER_BLOCKS (navigation clearance ring) is imported from building_site_overlays (Law 16).
const SEARCH_STEP     = 2;   // candidate grid step — smaller = more thorough but slower
const MAX_Y_VARIANCE  = 2;   // footprint flatness cap: max Y span across the footprint before a candidate is rejected (global to every blueprint)
const SURFACE_RANGE   = 8;   // blocks to scan up/down from bot Y when finding solid ground

// ── Expanding-ring scan ────────────────────────────────────────────────────
// Radial modes expand in square rings outward (Dijkstra-nearest), keeping the closest valid site,
// bounded only by the loaded world — ending on 'found' or the loaded frontier (Law 13 hard stop if nothing found).
const UNLOADED_RING_STOP = 2;    // consecutive all-unloaded rings ⇒ loaded frontier reached

// overheadClear lives in @utils/building_site_overlays; CLEARABLE in @utils/site_geometry (Law 16).

// readerFor — adapter across site_geometry's reader seam (each caller supplies its own blockAt), reading
// through the per-number voxel type table since every predicate here needs only name/boundingBox (Law 25).
const { makeVoxelReader } = require('@utils/voxel_reader');
const _readers = new WeakMap();   // memoized per bot
const readerFor = bot => {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
};

// ─────────────────────────────────────────────────────────────────────────────
// surfaceY — top solid non-canopy block at (x,z) within ±SURFACE_RANGE of refY, or null if unloaded/none.
// The walk is site_geometry.surfaceY (Law 16).
// ─────────────────────────────────────────────────────────────────────────────
function surfaceY(bot, x, z, refY) {
  const hit = siteGeometry.surfaceY(readerFor(bot), x, z, refY, SURFACE_RANGE, SURFACE_RANGE);
  return hit ? hit.y : null;
}

// getExistingFootprints — reads every locked building from building_confrence_room and returns its
// world-space bounding box, so an overlapping candidate is rejected. `clearance` inflates each box
// (default BUFFER_BLOCKS; the tree farm widens it to stay clear of canopy shade). Reject boxes are
// rebuilt from the BLUEPRINT, reading every owner's rooms (Law 16, matches getAllProtectedBlocks).
//
// rowExtent — footprint for a locked building whose blueprint isn't in the registry; the foreman writes
// width/length/corner onto the row when it sites it. Missing both is a coding violation.
function rowExtent(spot, blueprintName) {
  const f = spot.footprint;
  if (!f || !Number.isInteger(f.width) || !Number.isInteger(f.length)) {
    throw new Error(`[find_buildingspot] CODING VIOLATION: "${blueprintName}" is not in building_blueprints.json and its locked row carries no footprint.`);
  }
  const c = spot.transpose_origin;
  const minX = f.corner ? f.corner.x : c.x - Math.floor(f.width / 2);
  const minZ = f.corner ? f.corner.z : c.z - Math.floor(f.length / 2);
  return { min_dx: minX - c.x, max_dx: minX + f.width - 1 - c.x, min_dz: minZ - c.z, max_dz: minZ + f.length - 1 - c.z };
}

function getExistingFootprints(clearance = BUFFER_BLOCKS) {
  const room = hq.readOffice('building_confrence_room', {});
  const boxes = [];
  for (const [key, entry] of Object.entries(room)) {
    if (!entry || typeof entry !== 'object') continue;
    const spot = entry.set_buildspot;
    if (!spot?.transpose_origin || typeof spot.transpose_origin.x !== 'number') continue;
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(key);
    const building = blueprintRegistry.tryGetBuilding(blueprintName);
    const extent = building ? blueprintSurvey.footprintExtent(building) : rowExtent(spot, blueprintName);
    boxes.push(footprintBox(spot.transpose_origin.x, spot.transpose_origin.z, extent, clearance, key));
  }
  return boxes;
}

// footprintBox — the one overlap-reject box definition (Law 16): the blueprint's reach around (cx,cz),
// inflated by `clearance`. `extent` is offsets, not a width, since no blueprint is origin-symmetric.
function footprintBox(cx, cz, extent, clearance, key) {
  return {
    key,
    minX: cx + extent.min_dx - clearance, maxX: cx + extent.max_dx + clearance,
    minZ: cz + extent.min_dz - clearance, maxZ: cz + extent.max_dz + clearance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCandidate — footprint check for a building centered at (centerX, centerZ); `extent` sizes the
// checked box to the blueprint's actual footprint. Returns { valid: true, groundY } or
// { valid: false, reason, blockName? }.
//
// Floor is measured over the footprint only (the buffer ring is overhead-only). +1 Y forgiveness is a
// hard cap: valid only if every cell is within one block of the lowest (maxSY-minSY<=1); the floor
// anchors to minSY, so the build never sinks more than one tile and nothing floats.
// ─────────────────────────────────────────────────────────────────────────────
function evaluateCandidate(bot, centerX, centerZ, extent, buildingH, refY, existingBoxes, requireDirtGround) {
  // Building footprint — the cells the blueprint actually rests on (no buffer).
  const bStartX = centerX + extent.min_dx;
  const bStartZ = centerZ + extent.min_dz;
  const bEndX   = centerX + extent.max_dx;
  const bEndZ   = centerZ + extent.max_dz;

  // Full extent incl. navigation buffer — used for overlap + overhead clearance only.
  const startX = bStartX - BUFFER_BLOCKS;
  const startZ = bStartZ - BUFFER_BLOCKS;
  const endX   = bEndX + BUFFER_BLOCKS;
  const endZ   = bEndZ + BUFFER_BLOCKS;

  if (existingBoxes && existingBoxes.length > 0) {
    const overlap = overlapsExisting(startX, endX, startZ, endZ, existingBoxes);
    if (overlap) return { valid: false, reason: 'overlaps_existing', blockName: overlap };
  }

  // ── Surface flatness over the BUILDING FOOTPRINT ONLY ──────────────────────
  let minSY = Infinity;
  let maxSY = -Infinity;
  for (let x = bStartX; x <= bEndX; x++) {
    for (let z = bStartZ; z <= bEndZ; z++) {
      const sy = surfaceY(bot, x, z, refY);
      if (sy === null) return { valid: false, reason: 'chunk_unloaded' };
      if (sy < minSY) minSY = sy;
      if (sy > maxSY) maxSY = sy;
    }
  }

  // +1 forgiveness is the hard cap; rougher terrain is rejected (feeds the settle diagnostic).
  if (maxSY - minSY > MAX_Y_VARIANCE) return { valid: false, reason: 'too_uneven', variance: maxSY - minSY, minSY, maxSY };

  // Floor anchors to the lowest footprint cell — this IS the transpose_origin.y the staircase attaches below.
  const floorY = minSY;

  // ── Plantable-ground gate (tree farm) ──────────────────────────────────────────
  // Every footprint cell's block at floorY must be dirt-groupable, or the candidate is rejected.
  if (requireDirtGround) {
    for (let x = bStartX; x <= bEndX; x++) {
      for (let z = bStartZ; z <= bEndZ; z++) {
        const fb = bot.blockAt(new Vec3(x, floorY, z));
        const name = fb ? fb.name : null;
        if (!name || !PLANTABLE_GROUND.has(name)) {
          return { valid: false, reason: 'not_dirt_ground', blockName: name || 'unknown' };
        }
      }
    }
  }

  // ── Overhead clearance over the building footprint + navigation buffer ──────
  // Clears floorY+1..floorY+buildingH+1 across the footprint and the same band across the buffer.
  for (let x = startX; x <= endX; x++) {
    for (let z = startZ; z <= endZ; z++) {
      const oh = overheadClear(bot, x, z, floorY, buildingH);
      if (!oh.clear) return { valid: false, reason: 'overhead_blocked', blockName: oh.blockName };
    }
  }

  return { valid: true, groundY: floorY };
}

// ─────────────────────────────────────────────────────────────────────────────
// makeCandidate — the candidate structure from a passing evaluation. transpose_origin is the navigation
// target and blueprint-transposition anchor; footprint is the blueprint's reach from it (Law 6 record —
// reject boxes are always recomputed from the blueprint, not from this).
// ─────────────────────────────────────────────────────────────────────────────
function makeCandidate(centerX, centerZ, extent, groundY) {
  return {
    transpose_origin: { x: centerX, y: groundY, z: centerZ },
    footprint:    { width: extent.width, length: extent.length, ground_y: groundY },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// groundProfile — accountability read for the one spot find_buildingspot locks: what the floor rests
// on per footprint cell, and how uneven the ground was. Run once at lock. Reuses surfaceY (Law 16).
function groundProfile(bot, centerX, centerZ, extent, refY) {
  const blockCounts = {};
  const syHist = {};
  let cells = 0;
  for (let x = centerX + extent.min_dx; x <= centerX + extent.max_dx; x++) {
    for (let z = centerZ + extent.min_dz; z <= centerZ + extent.max_dz; z++) {
      const sy = surfaceY(bot, x, z, refY);
      if (sy === null) continue;
      cells++;
      syHist[sy] = (syHist[sy] || 0) + 1;
      const b = bot.blockAt(new Vec3(x, sy, z));
      const name = b ? b.name : 'unknown';
      blockCounts[name] = (blockCounts[name] || 0) + 1;
    }
  }
  const syKeys = Object.keys(syHist).map(Number);
  const minSY = syKeys.length ? Math.min(...syKeys) : null;
  const maxSY = syKeys.length ? Math.max(...syKeys) : null;
  let sliced = 0;
  if (minSY !== null) for (const k of syKeys) if (k > minSY) sliced += syHist[k];
  return { blockCounts, minSY, maxSY, sliced, cells };
}

// topCounts — formats a { blockName: count } histogram as "stone×412, sand×90", highest first.
function topCounts(counts, n = 3) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
  if (entries.length === 0) return 'none observed';
  return entries.map(([name, count]) => `${name}×${count}`).join(', ');
}

// formatUneven — a { variance: count } histogram as "Δ2:310, Δ3:90", sorted ascending by variance.
function formatUneven(hist) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) return 'none';
  return keys.map(v => `Δ${v}:${hist[v]}`).join(', ');
}

// Human labels for rejection reason keys, shared by every mode's summary (Law 16).
const REJECTION_LABELS = {
  chunk_unloaded:     'chunk unloaded',
  too_uneven:         'terrain too uneven',
  overhead_blocked:   'overhead blocked',
  overlaps_existing:  'overlaps existing building',
  not_dirt_ground:    'ground not dirt-groupable',
};
const STAIRCASE_REJECTION_LABELS = {
  too_shallow:     'staircase too shallow',
  unsafe_descent:  'unsafe descent',
  biome_mismatch:  'wrong biome',
  no_attach_point: 'no attach point',
};

// formatRejectionBreakdown — turns a { reason: count } tally into one sorted, human-labeled clause
// list, highest count first, zero-count reasons dropped.
function formatRejectionBreakdown(rejections, blockCountsByReason = {}, labels = REJECTION_LABELS) {
  const entries = Object.entries(rejections)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      const label = labels[reason] || reason.replace(/_/g, ' ');
      const bc = blockCountsByReason[reason];
      const detail = bc && Object.keys(bc).length > 0 ? ` (${topCounts(bc)})` : '';
      return `${count} ${label}${detail}`;
    });
  return entries.length > 0 ? entries.join('; ') : 'none';
}

// ── Failure post-mortem helpers (warn-channel only, zero-candidate path) ──────────────────────

// enumerateRing — (x,z) cells on a square annulus at Chebyshev radius `r`, stepped by `step`; ring
// order visits nearest-first, so the first buildable spot found is the closest (Law 16, matches
// craft_handler placement).
const enumerateRing = siteGeometry.enumerateRing;

// dominantReason — the highest-count rejection reason; drives which post-mortem branch runs.
function dominantReason(rejections) {
  let best = null, bestN = 0;
  for (const [reason, n] of Object.entries(rejections)) {
    if (n > bestN) { bestN = n; best = reason; }
  }
  return best;
}

// describeRejectBoxes — one line per locked building the candidates collided with: key + reject box.
function describeRejectBoxes(boxes, overlapKeyCounts) {
  return boxes.map(b => {
    const w = b.maxX - b.minX + 1, l = b.maxZ - b.minZ + 1;
    const hits = overlapKeyCounts[b.key] || 0;
    return `    '${b.key}': reject box X[${b.minX}..${b.maxX}] Z[${b.minZ}..${b.maxZ}] (${w}×${l})` +
           `${hits ? ` — ${hits} candidate(s) hit it` : ''}`;
  }).join('\n');
}

// Load + validate a blueprint's dimensions block (shared by locate and any caller needing dims before
// building opts). Throws Law 13 coding violations.
function loadBlueprintDims(blueprintName) {
  const building = blueprintRegistry.getBuilding(blueprintName, 'find_buildingspot');
  const dims = building.dimensions;
  if (!dims || typeof dims.w !== 'number' || typeof dims.h !== 'number' || typeof dims.l !== 'number') {
    throw new Error(`[find_buildingspot] CODING VIOLATION: blueprint "${blueprintName}" has missing or invalid dimensions. Requires { w, h, l }.`);
  }
  // dims.h is the authored height (overhead clearance); dims.w/l are not used for ground — extent below
  // is measured off the voxels.
  return { building, dims, extent: blueprintSurvey.footprintExtent(building) };
}

// ─────────────────────────────────────────────────────────────────────────────
// locate(bot, opts) — reusable scan engine: senses and reports only, returning the single nearest valid
// site (Dijkstra, uncapped to the loaded frontier) or a structured not-found with a ready post-mortem.
// The caller owns policy — receive throws Law 13 on exhaustion; the batch collects every result.
//
//   opts: { blueprintName, building, dims, origin:{x,y,z}, requireShaft, requireDirtGround, existingFootprints }
//   found:     { found:true,  candidate, distFromOrigin, checked, reachedRadius, scanSecs,
//                staircaseValidated, successSummary }
//   not found: { found:false, reason, checked, reachedRadius, scanSecs,
//                warnText, summaryText, throwText }
//     reason ∈ chunks_not_loaded | exhausted; throwText set only for reason='exhausted' (Law 13 material).
async function locate(bot, opts) {
  const { blueprintName, building, dims, origin, requireShaft, requireDirtGround, existingFootprints } = opts;
  // Extent is derived from the blueprint, not opts — the caller supplies where to search (Law 16).
  const extent = blueprintSurvey.footprintExtent(building);
  const refX = origin.x, refY = origin.y, refZ = origin.z;
  const existingBoxes = existingFootprints;

    // ── Scan terrain ──────────────────────────────────────────────────────────
    // Blueprint facing is literal — no rotation; each grid cell tested at the authored w×l.
    const candidates = [];
    let checked = 0;
    // Every reason evaluateCandidate can return needs a key here, or it silently reads as dead (Law 6).
    const rejections = { chunk_unloaded: 0, too_uneven: 0, overhead_blocked: 0, overlaps_existing: 0, not_dirt_ground: 0 };
    // Tree-farm mode: histogram of block names at rejected floor cells, for a "what the ground was" summary.
    const notDirtBlockCounts = {};

    // Settle diagnostics: distributions + closest-to-flat rejected cell, feeding the exhaustion post-mortem.
    const unevenHist = {};
    const overheadBlockCounts = {};
    // Which locked building each rejected candidate collided with, feeding the overlap-exhaustion diagnostic.
    const overlapKeyCounts = {};
    let flattestReject = null;
    let groundLo = Infinity, groundHi = -Infinity;

    // existingBoxes arrives via opts, already padded by the caller's clearance (Law 16).

    // ── Staircase overlay bookkeeping (require_shaft mode only) ───────────────
    // staircaseCache dedupes the descent check per (x,z) column; the rest feed the watcher.story explanation.
    const staircaseCache = new Map();
    const staircaseRejections = { too_shallow: 0, unsafe_descent: 0, biome_mismatch: 0, no_attach_point: 0 };
    let staircaseSpotsChecked = 0;

    // ── Biome gate (require_shaft mode only) ──────────────────────────────────
    // Rejects a staircase candidate outside ACCEPTABLE_BIOMES — the same set exploration uses (Law 16).
    const biomeGate = requireShaft ? ACCEPTABLE_BIOMES : null;

    // checkStaircaseAt — evaluate (and cache) the diagonal descent for a candidate site, keyed by (x,z).
    function checkStaircaseAt(transposeOrigin) {
      const key = `${transposeOrigin.x},${transposeOrigin.z}`;
      if (staircaseCache.has(key)) return { staircase: staircaseCache.get(key), firstCheck: false };
      const result = evaluateStaircasePrism(bot, building, transposeOrigin, biomeGate);
      staircaseCache.set(key, result);
      staircaseSpotsChecked++;
      if (!result.ok) {
        if (staircaseRejections[result.reason] !== undefined) staircaseRejections[result.reason]++;
        else staircaseRejections.unsafe_descent++;
      }
      return { staircase: result, firstCheck: true };
    }

    // Shared pacer for every voxel-heavy loop below (Law 19).
    const pace = makeExecutionPacer();   // Time bounds a slice regardless of the footprint's size.
    let reachedRadius = 0;
    const scanStart = Date.now();
    const scanSecs = () => ((Date.now() - scanStart) / 1000).toFixed(1);

    // ── Expanding-ring scan (Dijkstra-nearest, uncapped to the loaded frontier) ──────────────
    // One ring machinery for every mode (Law 16); keeps the single closest valid transpose_origin and
    // stops once ring radius reaches its distance.
    let best = null;   // { cand, dist } — the single nearest valid site (replace-if-nearer)
    let consecutiveUnloadedRings = 0;

    ringLoop:
    for (let r = 0; ; r += SEARCH_STEP) {   // uncapped — only 'found' or the loaded frontier ends it
      let ringAllUnloaded = true;

      for (const { x: cx, z: cz } of enumerateRing(refX, refZ, r, SEARCH_STEP)) {
        checked++;
        await pace();

        // Flat clear ground (+ safe diagonal descent for require_shaft, + plantable-ground gate for the tree farm).
        const r1 = evaluateCandidate(bot, cx, cz, extent, dims.h, refY, existingBoxes, requireDirtGround);
        if (r1.reason !== 'chunk_unloaded') ringAllUnloaded = false; // any readable cell keeps the ring "loaded"

        if (r1.valid) {
          let cand = null;
          if (requireShaft) {
            const transposeOrigin = { x: cx, y: r1.groundY, z: cz };
            const { staircase } = checkStaircaseAt(transposeOrigin);
            if (staircase.ok) {
              cand = makeCandidate(cx, cz, extent, r1.groundY);
              cand.staircase = { lowestSafeY: staircase.lowestSafeY, surfaceY: staircase.surfaceY, depthReached: staircase.depthReached, safeCopies: staircase.safeCopies, haltReason: staircase.haltReason || null };
            }
          } else {
            cand = makeCandidate(cx, cz, extent, r1.groundY);
          }
          if (cand) {
            const dist = Math.hypot(cx - refX, cz - refZ);
            if (!best || dist < best.dist) best = { cand, dist };
          }
        } else {
          if (rejections[r1.reason] !== undefined) rejections[r1.reason]++;
          // Settle diagnostics: capture the magnitude/location behind the bare reason count.
          if (r1.reason === 'too_uneven') {
            unevenHist[r1.variance] = (unevenHist[r1.variance] || 0) + 1;
            if (!flattestReject || r1.variance < flattestReject.variance) {
              flattestReject = { variance: r1.variance, x: cx, z: cz, minSY: r1.minSY, maxSY: r1.maxSY };
            }
            if (r1.minSY < groundLo) groundLo = r1.minSY;
            if (r1.maxSY > groundHi) groundHi = r1.maxSY;
          } else if (r1.reason === 'overhead_blocked' && r1.blockName) {
            overheadBlockCounts[r1.blockName] = (overheadBlockCounts[r1.blockName] || 0) + 1;
          } else if (r1.reason === 'overlaps_existing' && r1.blockName) {
            overlapKeyCounts[r1.blockName] = (overlapKeyCounts[r1.blockName] || 0) + 1;
          } else if (r1.reason === 'not_dirt_ground' && r1.blockName) {
            notDirtBlockCounts[r1.blockName] = (notDirtBlockCounts[r1.blockName] || 0) + 1;
          }
        }
      }

      reachedRadius = r;
      // Nearest-match stop (Dijkstra): once ring radius reaches best.dist, no farther cell can beat it.
      if (best && r >= best.dist) break ringLoop;
      consecutiveUnloadedRings = (r > 0 && ringAllUnloaded) ? consecutiveUnloadedRings + 1 : 0;
      // Loaded frontier — unloaded chunks in every direction for UNLOADED_RING_STOP rings running.
      if (consecutiveUnloadedRings >= UNLOADED_RING_STOP) break ringLoop;
    }

    if (best) candidates.push(best.cand); // the single nearest valid site (or none → exhaustion below)

    // ── Radial-mode exhaustion: Law 13 hard stop ─────────────────────────────
    // Zero candidates means nothing is buildable in the loaded area — halts for human inspection.
    if (candidates.length === 0) {
      // Every surveyed cell unloaded = world hasn't streamed in yet — soft-fail for retry, not a stop.
      const loadedCellsSurveyed = checked - rejections.chunk_unloaded;
      if (loadedCellsSurveyed === 0) {
        return {
          found: false, reason: 'chunks_not_loaded', checked, reachedRadius, scanSecs: scanSecs(),
          warnText: `⚠️ find_buildingspot: all ${checked} surveyed cell(s) were unloaded chunks around (${refX},${refY},${refZ}) — world not streamed in yet. Soft-failing for retry (not a Law 13 stop).`,
          summaryText: `Scan aborted: no loaded terrain around the bot yet (${checked} cell(s), all unloaded). Retrying once chunks load.`,
        };
      }

      const standingBiome = getBiomeName(bot, refX, refY, refZ) || 'unknown';
      const frontierNote = `searched to the loaded frontier at radius ${reachedRadius} in ${scanSecs()}s`;
      const wl = [];
      if (requireShaft) {
        // Both tallies merged (surface + staircase/biome failures) so one breakdown reads the whole scan.
        const combinedRejections = { ...rejections, ...staircaseRejections };
        const combinedLabels     = { ...REJECTION_LABELS, ...STAIRCASE_REJECTION_LABELS };
        const biomeNote = staircaseRejections.biome_mismatch > 0
          ? ` ${staircaseRejections.biome_mismatch} site(s) were the wrong biome (bot not in a settle-able plains/forest biome).` : '';
        const groundSpan = Number.isFinite(groundLo) ? `${groundLo}..${groundHi} (Δ${groundHi - groundLo})` : 'n/a';
        const flat = flattestReject
          ? `flattest reject Δ${flattestReject.variance} at (${flattestReject.x},${flattestReject.z}) [surface Y ${flattestReject.minSY}..${flattestReject.maxSY}]`
          : 'no too-uneven cells this scan';
        const unevenNote = Object.keys(unevenHist).length
          ? ` Unevenness spread (footprint Δ, cap Δ${MAX_Y_VARIANCE}): ${formatUneven(unevenHist)}.` : '';
        wl.push(`no safe staircase for '${blueprintName}' anywhere in the loaded area (${frontierNote}).`);
        wl.push(`  Bot at (${refX},${refY},${refZ}) biome='${standingBiome}'; inspected ${checked} surface cell(s), ${staircaseSpotsChecked} staircase site(s). Wall: ${formatRejectionBreakdown(combinedRejections, { overhead_blocked: overheadBlockCounts }, combinedLabels)}.`);
        wl.push(`  Settle terrain: surface-Y span ${groundSpan}; ${flat}.${unevenNote}${biomeNote}`);
      } else {
        const dom = dominantReason(rejections);
        wl.push(`no viable spot for '${blueprintName}' (${dims.w}×${dims.l} footprint) anywhere in the loaded area (${frontierNote}).`);
        wl.push(`  Bot at (${refX},${refY},${refZ}) biome='${standingBiome}'; scanned ${checked} cell(s). Wall: ${formatRejectionBreakdown(rejections, { overhead_blocked: overheadBlockCounts, not_dirt_ground: notDirtBlockCounts })}.`);
        if (dom === 'overlaps_existing' && existingBoxes.length > 0) {
          wl.push(`  Every candidate overlaps a locked building — the ENTIRE loaded area sits inside the base's reject ring(s):`);
          wl.push(describeRejectBoxes(existingBoxes, overlapKeyCounts));
        } else if (dom === 'too_uneven') {
          const groundSpan = Number.isFinite(groundLo) ? `${groundLo}..${groundHi} (Δ${groundHi - groundLo})` : 'n/a';
          const flat = flattestReject
            ? `flattest reject Δ${flattestReject.variance} at (${flattestReject.x},${flattestReject.z}) [surface Y ${flattestReject.minSY}..${flattestReject.maxSY}]`
            : 'n/a';
          wl.push(`  Terrain too rough (cap Δ${MAX_Y_VARIANCE}): surface-Y span ${groundSpan}; ${flat}. Spread: ${formatUneven(unevenHist)}.`);
        } else if (dom === 'overhead_blocked') {
          wl.push(`  Overhead blocked by: ${topCounts(overheadBlockCounts)} — solid (stone/dirt) is a mountain/overhang.`);
        } else if (dom === 'not_dirt_ground') {
          wl.push(`  Ground not plantable: ${topCounts(notDirtBlockCounts)} — the tree farm requires a complete grass/dirt floor (≤1 layer scraped); no such patch within the spread gate. Move the base nearer grass, or widen the gate.`);
        } else if (dom === 'chunk_unloaded') {
          wl.push(`  Most cells sat in unloaded chunks — the area around the bot may not be streamed in.`);
        }
      }
      const cause = `The bot cannot resolve this: either the start location is unbuildable (bad seed — stranded/hemmed in) or the '${blueprintName}' acceptance standard is too strict and must be tuned. Human inspection required.`;
      return {
        found: false, reason: 'exhausted', checked, reachedRadius, scanSecs: scanSecs(),
        throwText: `[find_buildingspot] LAW 13 HARD STOP — ${wl.join('\n')}\n  ${cause}`,
      };
    }

    // A require_shaft candidate carries a validated .staircase block; downstream reads it via this flag.
    const staircaseValidated = requireShaft;

    // ── Found: build the Law 6 narrative (what was inspected, why the pick validated) for the nearest site ──
    const selected = candidates[0];
    const distFromOrigin = Math.hypot(selected.transpose_origin.x - refX, selected.transpose_origin.z - refZ);
    // Ground-composition accountability: what the floor rests on and how much mound gets sliced.
    const gp = groundProfile(bot, selected.transpose_origin.x, selected.transpose_origin.z, extent, refY);
    const scrapeDepth = gp.minSY !== null ? gp.maxSY - gp.minSY : 0;
    const span = gp.minSY !== null
      ? `surface Y ${gp.minSY}..${gp.maxSY} (Δ${scrapeDepth}), floor anchors Y${gp.minSY}, scrapes up to ${scrapeDepth} layer(s) (cap ${MAX_Y_VARIANCE}) across ${gp.sliced}/${gp.cells} cell(s)`
      : 'surface unread';
    const dirtNote = requireDirtGround ? ` plantable-floor gate ON (every cell must be grass/dirt at Y${gp.minSY})` : '';
    const groundNote = ` GROUND under the ${selected.footprint.width}x${selected.footprint.length} footprint: ${topCounts(gp.blockCounts, 6)}; ${span}.${dirtNote}`;
    let successSummary;
    if (requireShaft) {
      successSummary =
        `Inspected: ${checked} surface cell(s) out to ring radius ${reachedRadius} in ${scanSecs()}s, ${staircaseSpotsChecked} staircase site(s) for '${blueprintName}' gated to the settle-able (plains/forest) biome set. ` +
        `Nearest match (flat surface + safe diagonal staircase): transpose_origin=(${selected.transpose_origin.x},${selected.transpose_origin.y},${selected.transpose_origin.z}), ` +
        `footprint=${selected.footprint.width}x${selected.footprint.length}, descends to Y=${selected.staircase.lowestSafeY} ` +
        `(surface Y=${selected.staircase.surfaceY}, depth ${selected.staircase.depthReached}, ${selected.staircase.safeCopies} safe copy(ies)); ` +
        `${distFromOrigin.toFixed(1)} block(s) from origin.${groundNote} Rejected: ${formatRejectionBreakdown(staircaseRejections, {}, STAIRCASE_REJECTION_LABELS)}.`;
    } else {
      successSummary = `Inspected: ${checked} cell(s) out to ring radius ${reachedRadius} in ${scanSecs()}s for '${blueprintName}'. Nearest match: flat, clear spot at (${selected.transpose_origin.x},${selected.transpose_origin.y},${selected.transpose_origin.z}); ${distFromOrigin.toFixed(1)} block(s) from origin.${groundNote} Rejected: ${formatRejectionBreakdown(rejections)}.`;
    }

    return {
      found: true, candidate: selected, distFromOrigin,
      // Reach this candidate was validated at, so a sibling reservation in the same pass uses the same box.
      extent,
      checked, reachedRadius, scanSecs: scanSecs(), staircaseValidated,
      successSummary,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// find_buildingspot is a pure library (Law 16): lock_all_buildspots calls locate() directly per base
// blueprint in one startup pass. Survives here: the sense-and-report engine (locate) plus the geometry
// helpers the batch composes with.
module.exports = {
  locate,
  loadBlueprintDims,
  getExistingFootprints,
  footprintBox,
};
