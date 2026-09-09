// fragment: find_buildingspot (action)
// purpose: Locate viable surface positions for a named building by reading its
//          dimensions from building_blueprints.json, then scanning terrain around
//          the bot. Blueprint facing is literal — north in the blueprint is north in
//          the game world, no rotation — because a house/mine has no orientation
//          constraint. Each candidate emits a center waypoint (for the locomotion
//          ladder) and a full footprint bounding box so downstream fragments can align
//          the blueprint precisely to the valid area.
//          Which candidate is reached is decided by locomotion_dispatcher.goNear
//          (reachability ranking) — not by this fragment.
//
// This fragment is the scan PIPELINE: validate the blueprint, walk the candidate grid, keep the
// nearest survivor, report, and route. The one site-scan OVERLAY it can layer on — the shaft-safety
// diagonal descent (payload.require_shaft) — lives in @utils/building_site_overlays with its full
// rationale. Here it is just called: a surface candidate's column is checked for a safe descent as it's
// found. (A retired water-site farmland overlay once lived here too; the wheat farm is now sited by the
// wheat_plot_scanner, so require_water_site was removed — Law 16.)
//
// invariants:
//  - payload.blueprint_name must match a key in building_blueprints.buildings
//  - Missing blueprint or bad dimensions = CODING VIOLATION → throw (Law 13)
//  - No viable spot found = environmental failure → route to recursive_judge
//  - Hands the candidate set to locomotion_dispatcher.goNear (candidate-set form);
//    on arrival routes the selected candidate to set_buildspot

const hq      = require('@kernel/corporate_headquarters');
const blueprintRegistry = require('@kernel/blueprint_registry');
// Building room keys carry an owner; this strips one back to the structure name (Law 16 — one rule, one place).
const { roomKeyName } = require('@overseer/message_schema');
const blueprintSurvey   = require('@perception/blueprint_survey');   // footprintExtent — the blueprint's true XZ reach (Law 1: a fragment may read a perception node directly)
const Vec3    = require('vec3');

// PLANTABLE_GROUND — the blocks a tree-farm floor may rest on unmodified. Reuses the SAME 'dirt' group
// building_integrity uses to decide a floor cell is already satisfied (Law 16), so a spot that passes the
// requireDirtGround gate produces a FREE floor: grass_block, dirt, coarse_dirt, podzol, farmland. Anything
// else (stone, gravel, sand) fails the gate — a sapling can't root on it and integrity would otherwise
// dig+place a dirt slab there, the "short on dirt" the tree farm hit on a stone shelf.
const { group_to_item } = require('@utils/fragment_utils');
const PLANTABLE_GROUND = new Set(group_to_item.dirt || []);

// The shaft-safety diagonal-descent OVERLAY plus the two shared site-geometry primitives the base scan
// uses with it (BUFFER_BLOCKS clearance ring, overlapsExisting) live in one utility so this fragment
// holds only the scan PIPELINE. The overlay's full rationale lives in building_site_overlays.
const {
  BUFFER_BLOCKS,
  overlapsExisting,
  overheadClear,
  getBiomeName,
  evaluateStaircasePrism,
} = require('@utils/building_site_overlays');

// The three site-scan primitives this fragment ORIGINATED — the column read and the expanding ring —
// now live in @utils/site_geometry, which owns them for every caller (Law 16). They moved because the
// arena bench needs the same three parts around a different footprint question, and the alternative was
// a second near-copy of a scan whose correctness this fragment spent months settling. Nothing here got
// a new algorithm; the bodies left and the call sites stayed.
const siteGeometry = require('@utils/site_geometry');

// The one settle-able biome set (plains + forest families). Same set exploration uses to decide when
// to stop seeking — here it gates the build center so the descent/headframe site only locks where the
// bot is allowed to live (Law 16: one set, both ends of the decision).
const { ACCEPTABLE_BIOMES } = require('@thinking/architect_config');

// The shared scan pacer (Law 16, Law 19). Every radial cell + shoreline site is evaluated behind this
// so the uncapped whole-loaded-area search never stalls the server tick, this bot's physics, or the
// other bots — a long gentle sweep, never a synchronous churn.
const { makeScanThrottle } = require('@utils/voxel_scan_throttle');

// ── Tuning constants — surface scan ──────────────────────────────────────────
// BUFFER_BLOCKS (the navigation clearance ring) is imported from building_site_overlays (Law 16 — one
// definition, shared with the overlap-reject footprint math).
const SEARCH_STEP     = 2;   // candidate grid step — smaller = more thorough but slower
const MAX_Y_VARIANCE  = 2;   // scrape cap (hard): the footprint may vary by at most this many blocks — the scanner slices up to this many top layers off the highest cells to reach the anchored floor, nothing floats. GLOBAL to every blueprint (headframe/farmland terraform this loosely too); bumped 1→2 so the 9×9 tree farm can flatten mild mounds instead of exhausting on natural undulation.
const SURFACE_RANGE   = 8;   // blocks to scan up/down from bot Y when finding solid ground

// ── Expanding-ring scan ────────────────────────────────────────────────────
// The radial modes (staircase + surface/tree-farm) no longer raster a fixed box. They expand in
// square rings OUTWARD from the bot (a Dijkstra-nearest sweep), keep the single CLOSEST valid site,
// and are bounded ONLY by the LOADED WORLD — never by a number. No constant may cap this: the loaded
// frontier is the one legitimate limit, and it sizes itself to the server's actual view distance — a
// fixed cap ("400 blocks") can't know where the terrain ends, only the terrain can: too small and it
// shades a big view distance, too big and it is dead weight. So the
// loop runs until it either settles the nearest site or reads unloaded chunks in every direction. The
// throttle is what makes an uncapped sweep harmless. One filter pass, first/best match: every
// acceptance filter is applied up front, so the nearest valid cell IS the answer — no "collect N then
// rank" (a redundant second filter). Two terminals, both self-sizing:
//   • found            — the nearest valid site is settled: the ring radius reached its distance, so no
//                        unscanned cell (all farther out) can beat it.
//   • loaded frontier  — UNLOADED_RING_STOP consecutive whole rings were entirely unloaded: past the
//                        edge of what the server has streamed in, nothing left to see without moving.
//                        The loaded area is finite, so this is guaranteed to arrive — it is what
//                        terminates a no-match scan (no numeric backstop stands behind it).
// Zero candidates after the frontier is a Law 13 HARD STOP (the bot cannot fix a bad seed or a too-
// strict standard — a human must), handled at the exhaustion block below.
const UNLOADED_RING_STOP = 2;    // consecutive all-unloaded rings ⇒ loaded frontier reached

// overheadClear (the column scan that rejects a site carving into terrain) lives in
// @utils/building_site_overlays; CLEARABLE, which both it and the surface scan read, now lives one
// level further out in @utils/site_geometry (Law 16 — one set, and one reachable from outside the
// construct).

// readerFor — the adapter across site_geometry's reader seam. site_geometry takes no dependency at all
// (not even vec3) so an observer tool outside the construct can drive the same scan; the cost of that is
// each caller supplying its own blockAt. This is that cost, paid once.
//
// DECLARES ITS CRITERIA: every scan should ask only for what it needs and read through the throttled
// voxel scan. It is literally true here: every predicate this scan drives —
// site_geometry.isGround, CLEARABLE membership, the surface walk — asks only `name` and `boundingBox`,
// and both are functions of the block's number alone. So it asks for ['type'] and reads come from the
// per-number table instead of rebuilding a ~20-field description per cell.
//
// The siting sweep is the fleet's heaviest one-shot scan (a whole building footprint per candidate
// cell), which is why it is the first converted. Falls back to the full read automatically if a future
// need here stops being type-derivable — the reader reports which path it took on `.fast`, never
// pretending a light level came from the type table (Law 25).
//
// MEMOIZED PER BOT because this is called from inside the sweep, once per candidate column, not once per
// scan. Building a reader is cheap but not free, and the per-number table it closes over is the thing
// worth keeping warm across the whole sweep — a fresh reader per column would still share the module's
// table, but would allocate a closure set per column for nothing. WeakMap so a bot that goes away is not
// held alive by this cache.
const { makeVoxelReader } = require('@utils/voxel_reader');
const _readers = new WeakMap();
const readerFor = bot => {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
};

// ─────────────────────────────────────────────────────────────────────────────
// surfaceY — the top solid non-canopy block at (x,z) within ±SURFACE_RANGE of refY.
// Returns that Y, or null if the chunk isn't loaded or nothing qualifies in range.
//
// The walk itself is site_geometry.surfaceY now, and it decides IDENTICALLY: site_geometry.isGround is
// this function's old test (`boundingBox === 'block' && !CLEARABLE.has(name)`) moved, not re-decided.
// The move is a relocation with no behaviour delta — deliberately, because the reason it moved was a
// test bench that needed the same walk, and a bench must not retune where the live fleet puts its base.
// ─────────────────────────────────────────────────────────────────────────────
function surfaceY(bot, x, z, refY) {
  const hit = siteGeometry.surfaceY(readerFor(bot), x, z, refY, SURFACE_RANGE, SURFACE_RANGE);
  return hit ? hit.y : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// getExistingFootprints — Read all locked buildings from building_confrence_room
// and return their world-space bounding boxes. Used to reject candidates that
// would overlap an already-placed building.
//   clearance — blocks to inflate each existing footprint by (the reject ring).
//     Defaults to BUFFER_BLOCKS (the navigation ring every build keeps). The tree
//     farm passes a larger value so it lands well clear of the base: a farm planted
//     against the headframe re-grows the canopy the felling was meant to clear, so
//     the gap is the whole point. Enforced at farm-placement
//     time — the base is sited first, so keeping the farm clear of it is sufficient.
// ─────────────────────────────────────────────────────────────────────────────
// A locked instance's reject box is rebuilt from its BLUEPRINT, not from the width/length the chair
// happens to carry: the geometry is a fact of the blueprint and the chair only supplies where it was
// put, so there is one owner of the shape and nothing to migrate when that shape changes. The
// key→blueprint-name resolution (`blueprint_paster.building_name`, falling back to the key with its owner
// stripped) is the same one getAllProtectedBlocks uses to walk this room (Law 16).
//
// IT READS EVERY OWNER'S ROOMS AND THAT IS THE POINT. Building room keys carry an owner and a bot writes
// only its own — but overlap is a fact about the WORLD, not about whose base it is, so a crew must refuse
// to site on top of a structure belonging to somebody it has never met. Read everyone's, write your own;
// this is the read half, and narrowing it to one owner is what would let two humans' bases interpenetrate.
function getExistingFootprints(clearance = BUFFER_BLOCKS) {
  const room = hq.readOffice('building_confrence_room', {});
  const boxes = [];
  for (const [key, entry] of Object.entries(room)) {
    if (!entry || typeof entry !== 'object') continue;
    const spot = entry.set_buildspot;
    if (!spot?.build_center || typeof spot.build_center.x !== 'number') continue;
    const blueprintName = entry?.blueprint_paster?.building_name || roomKeyName(key);
    const building = blueprintRegistry.getBuilding(blueprintName, 'find_buildingspot');
    const extent = blueprintSurvey.footprintExtent(building, spot.rotation || 0);
    boxes.push(footprintBox(spot.build_center.x, spot.build_center.z, extent, clearance, key));
  }
  return boxes;
}

// footprintBox — the ONE definition of a building's overlap-reject box (Law 16): the blueprint's true
// reach around (cx,cz), inflated by `clearance` per side. Used both for LOCKED buildings
// (getExistingFootprints) and for the startup batch's not-yet-locked PENDING footprints, so a blueprint
// surveyed earlier in the same pass reserves its space against the ones surveyed after it (siblings
// never overlap). `extent` is blueprint_survey.footprintExtent — offsets, never a width, because a
// width can only place a box that is symmetric about the origin and no blueprint is obliged to be
// (headframe reaches 7 west of its shaft and 2 east; the staircase lies entirely east of its top step).
function footprintBox(cx, cz, extent, clearance, key) {
  return {
    key,
    minX: cx + extent.min_dx - clearance, maxX: cx + extent.max_dx + clearance,
    minZ: cz + extent.min_dz - clearance, maxZ: cz + extent.max_dz + clearance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateCandidate — Full footprint check for a building whose build_center sits at (centerX, centerZ).
// The footprint arrives as `extent` (blueprint_survey.footprintExtent — offsets from the build_center),
// so the cells checked are the ones the blueprint actually covers. It does NOT radiate equally outward:
// assuming that put the checked box in the wrong place for every off-centre blueprint, leaving real
// footprint columns unmeasured for flatness while measuring bare ground the build never touches.
// Returns { valid: true, groundY } or { valid: false, reason, blockName? }.
//
// Surface anchoring rule (the whole-blueprint-on-whole-ground law):
//   - The floor is measured over the BUILDING FOOTPRINT ONLY. The BUFFER_BLOCKS ring
//     is navigation clearance — it is checked for overhead, but its terrain must NOT
//     drag the floor down (that was sinking the headframe + staircase 2-3 blocks into
//     a cavern when the buffer clipped a dip).
//   - +1 Y forgiveness is a HARD cap: a candidate is valid only if every building
//     footprint cell sits within one block of the lowest one (maxSY - minSY <= 1).
//     The scanner may slice exactly one top layer off the highest cells; anything
//     rougher is rejected so we keep looking for a genuinely flat spot.
//   - The floor anchors to minSY (the lowest footprint cell). So the deepest the
//     build ever sinks is exactly one tile, and no cell is ever left floating over a
//     gap (every cell's ground is at or above the floor). The +1 cells become dig
//     targets that building_integrity handles.
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

  // ── THE SPAWN-PROTECTED SQUARE, FIRST OF ALL THE GATES ──────────────────────────────────────────
  // Ahead of every other rejection because it is the only one that costs no world reads: pure
  // arithmetic against a hoisted box, where flatness, ground type and overhead each walk the footprint
  // calling blockAt. A candidate the server would never let us build on should not be paid for.
  //
  // THE BUILDING FOOTPRINT, NOT THE BUFFERED EXTENT. Spawn protection governs placing and breaking, and
  // the buffer is only walked — a build whose navigation margin clips the square is perfectly legal, so
  // rejecting on the buffer would refuse legitimate sites for ground nobody touches. The footprint is
  // exactly the set of columns this blueprint puts blocks into, which is exactly what the rule binds.
  //
  // ANY cell, not the centre: the square has a hard edge, so a footprint straddling it would have some
  // rows place and others silently refuse, leaving a half-built structure the integrity scan then tries
  // to repair forever against ground that cannot accept a block.
  {
    const { firstSpawnProtectedCell } = require('@perception/spawn_protection');
    const cells = [];
    for (let x = bStartX; x <= bEndX; x++) for (let z = bStartZ; z <= bEndZ; z++) cells.push({ x, z });
    const hit = firstSpawnProtectedCell(bot, cells);
    if (hit) return { valid: false, reason: 'spawn_protected', blockName: `(${hit.x},${hit.z})` };
  }

  // Overlap check against existing buildings (full extent)
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

  // +1 forgiveness is the hard cap. Rougher terrain sinks the build more than one
  // tile (or would float part of it) — reject and keep searching for a flat spot.
  // Carry the variance magnitude + Y span so the settle diagnostic can say HOW uneven (Δ2 vs Δ20 =
  // "one tile short" vs "on a mountainside") and WHERE the flattest cell was.
  if (maxSY - minSY > MAX_Y_VARIANCE) return { valid: false, reason: 'too_uneven', variance: maxSY - minSY, minSY, maxSY };

  // Floor anchors to the lowest footprint cell: highest cells lose one top layer,
  // nothing floats. This IS the build_center.y the staircase attaches one below.
  const floorY = minSY;

  // ── Plantable-ground gate (tree farm) ──────────────────────────────────────────
  // The floor rests at floorY; every footprint cell's block AT that level is what it lands on (the
  // surface for a floorY cell, the sub-surface layer for a +1 cell whose top gets sliced). ALL must be
  // dirt-groupable — a COMPLETE plantable floor — or reject and keep searching. On grass this passes
  // (grass over dirt); on stone/gravel/sand it fails, so the farm never locks onto ground it would have
  // to pave with a dirt slab. The one-layer slice cap is already enforced by MAX_Y_VARIANCE above.
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
  // Clear the building's own column (floorY+1 .. floorY+buildingH+1) across the
  // footprint, and the same band across the buffer so the bot can move around it.
  for (let x = startX; x <= endX; x++) {
    for (let z = startZ; z <= endZ; z++) {
      const oh = overheadClear(bot, x, z, floorY, buildingH);
      if (!oh.clear) return { valid: false, reason: 'overhead_blocked', blockName: oh.blockName };
    }
  }

  return { valid: true, groundY: floorY };
}

// ─────────────────────────────────────────────────────────────────────────────
// makeCandidate — Builds the candidate data structure from a passing evaluation.
// build_center — center of the building at floor level. This IS the navigation
//               target for the locomotion ladder and the anchor point for blueprint
//               transposition. There is no separate waypoint or SW corner.
// footprint   — the blueprint's reach in each direction from the build_center (the extent's offsets),
//               with width/length carried alongside for the reports that quote a size. It is a RECORD of
//               what was validated here (Law 6), not the source anyone rebuilds the box from — every
//               reject box is recomputed from the blueprint, so a chair can never disagree with it.
// ─────────────────────────────────────────────────────────────────────────────
function makeCandidate(centerX, centerZ, extent, groundY) {
  return {
    build_center: { x: centerX, y: groundY, z: centerZ },
    footprint:    { width: extent.width, length: extent.length, ground_y: groundY },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// groundProfile — the ACCOUNTABILITY read for the ONE spot find_buildingspot locks. The spot is
// chosen once and never revisited, so its reasoning must be fully visible: WHAT the floor
// will rest on (the surface block at each footprint cell — dirt/grass satisfy the blueprint floor and
// need no placing; gravel/sand/stone force a dig+place, which is the "short on dirt" the operator sees
// downstream), and HOW uneven the ground was (the surface-Y span + how many cells get their top layer
// sliced to reach the anchored floor at minSY). Bounded to the footprint (w×l) and run once at lock —
// cheap, no per-cell scan spam. Reuses surfaceY (Law 16), the same top-solid read the candidate scan uses.
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

// topCounts — format a { blockName: count } histogram as "stone×412, sand×90" (highest first,
// capped at n entries) for a one-line summary instead of a bare rejection total.
function topCounts(counts, n = 3) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
  if (entries.length === 0) return 'none observed';
  return entries.map(([name, count]) => `${name}×${count}`).join(', ');
}

// formatUneven — a { variance: count } histogram as "Δ2:310, Δ3:90, Δ5:12" sorted by variance
// ASCENDING (not by count), so the reader sees at a glance whether the ground is almost-flat
// (mass near Δ2, one tile over the cap) or genuinely steep (mass at high Δ). Settle diagnostic only.
function formatUneven(hist) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) return 'none';
  return keys.map(v => `Δ${v}:${hist[v]}`).join(', ');
}

// Human labels for rejection reason keys — one naming definition shared by every mode's
// summary (Law 16), so a reader never has to decode a raw reason string.
const REJECTION_LABELS = {
  chunk_unloaded:     'chunk unloaded',
  too_uneven:         'terrain too uneven',
  overhead_blocked:   'overhead blocked',
  overlaps_existing:  'overlaps existing building',
  not_dirt_ground:    'ground not dirt-groupable',
  spawn_protected:    'inside the spawn-protected square',
};
const STAIRCASE_REJECTION_LABELS = {
  too_shallow:     'staircase too shallow',
  unsafe_descent:  'unsafe descent',
  biome_mismatch:  'wrong biome',
  no_attach_point: 'no attach point',
};

// formatRejectionBreakdown — turns a flat { reason: count } tally into one sorted,
// human-labeled clause list ("589 not a water source (stone×403...); 24 ground not
// dirt-groupable (...); 9 overlaps existing"), highest count first, zero-count
// reasons dropped. Replaces a fixed-order enumeration (every reason printed
// regardless of count) with a report shaped by what actually happened this scan.
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

// ── Failure post-mortem helpers (the navigator-style "why", warn-channel only) ────────────────────
// The scan reports success on the summary channel; when it finds NOTHING these reconstruct the wall
// it hit, mirroring navigator.diagnoseGiveUp. They run only on the zero-candidate path, so a healthy
// scan never pays for them and the operator's warn feed stays a pure failure log (Law 5).

// enumerateRing — the (x,z) cells on the perimeter of a square annulus at Chebyshev radius `r` from
// (cx,cz), stepping by `step`. Walking r = 0, step, 2·step… and evaluating each ring in turn visits the
// world nearest-first, so the FIRST buildable spot found is the closest one — the same "closest open
// spot" value the craft_handler placement follows.
//
// The body moved to @utils/site_geometry unchanged (Law 16). Kept as a local name because the ring
// walk reads as one idea with the ringLoop below it, and re-spelling the module path at the call site
// would obscure that.
const enumerateRing = siteGeometry.enumerateRing;

// dominantReason — the highest-count rejection reason, i.e. the wall the scan actually hit. Drives
// which branch of the post-mortem runs (overlap vs. rough terrain vs. unloaded), so the diagnostic
// speaks to the real blocker instead of printing every reason equally.
function dominantReason(rejections) {
  let best = null, bestN = 0;
  for (const [reason, n] of Object.entries(rejections)) {
    if (n > bestN) { bestN = n; best = reason; }
  }
  return best;
}

// describeRejectBoxes — one line per locked building the candidates collided with: its key and the
// world-space reject box (footprint + clearance ring) that swallowed them. This is the overlap-wall
// analog of the navigator's "what is at the target" — it names the structures the bot is boxed
// inside, so "625 overlaps" becomes "you are standing inside headframe's 31×31 reject ring".
function describeRejectBoxes(boxes, overlapKeyCounts) {
  return boxes.map(b => {
    const w = b.maxX - b.minX + 1, l = b.maxZ - b.minZ + 1;
    const hits = overlapKeyCounts[b.key] || 0;
    return `    '${b.key}': reject box X[${b.minX}..${b.maxX}] Z[${b.minZ}..${b.maxZ}] (${w}×${l})` +
           `${hits ? ` — ${hits} candidate(s) hit it` : ''}`;
  }).join('\n');
}

// Load + validate a blueprint's dimensions block (shared by locate and any caller that needs dims
// before building the opts). Throws Law 13 coding violations — a missing/garbled blueprint is a bug.
function loadBlueprintDims(blueprintName) {
  const building = blueprintRegistry.getBuilding(blueprintName, 'find_buildingspot');
  const dims = building.dimensions;
  if (!dims || typeof dims.w !== 'number' || typeof dims.h !== 'number' || typeof dims.l !== 'number') {
    throw new Error(`[find_buildingspot] CODING VIOLATION: blueprint "${blueprintName}" has missing or invalid dimensions. Requires { w, h, l }.`);
  }
  // dims.h is the authored HEIGHT and is used as-is (overhead clearance). dims.w/dims.l are NOT used for
  // ground: the extent below is measured off the voxels, so the checked box sits where the building
  // actually is rather than centred on the origin. Callers that only quote a size still read dims.
  return { building, dims, extent: blueprintSurvey.footprintExtent(building) };
}

// ─────────────────────────────────────────────────────────────────────────────
// locate(bot, opts) — the reusable scan ENGINE.
// Extracted from receive so the startup batch (lock_all_buildspots) can survey every blueprint's
// nearest spot in one pass, from an ARBITRARY origin, WITHOUT routing or throwing. locate only SENSES
// and REPORTS: it returns the single nearest valid site (Dijkstra, uncapped to the loaded frontier) plus
// its XZ distance from the origin, or a structured not-found carrying a ready-to-emit post-mortem. The
// CALLER owns policy — receive throws Law 13 on radial exhaustion and soft-routes environmental misses;
// the batch collects every result, reports each blueprint's closeness, and judges the whole base layout
// at once. Range NEVER caps the scan; the loaded frontier is the
// sole terminator, and how-close-the-nearest-is is a value the caller judges, never a stop condition here.
//
//   opts: { blueprintName, building, dims, origin:{x,y,z}, requireShaft, requireDirtGround, existingFootprints }
//   found:     { found:true,  candidate, distFromOrigin, checked, reachedRadius, scanSecs,
//                staircaseValidated, successSummary }
//   not found: { found:false, reason, checked, reachedRadius, scanSecs,
//                warnText, summaryText, throwText }
//     reason ∈ chunks_not_loaded | exhausted
//     throwText is set ONLY for reason='exhausted' (radial whole-loaded-area miss = Law 13 material).
async function locate(bot, opts) {
  const { blueprintName, building, dims, origin, requireShaft, requireDirtGround, existingFootprints } = opts;
  // Derived here from the blueprint rather than taken from opts: the caller supplies WHERE to search,
  // never the shape being placed, so no caller can hand the scan a footprint the blueprint disagrees
  // with. Same function loadBlueprintDims exposes for the batch's pending reservations — one definition.
  const extent = blueprintSurvey.footprintExtent(building);
  const refX = origin.x, refY = origin.y, refZ = origin.z;
  const existingBoxes = existingFootprints;

    // ── Scan terrain ──────────────────────────────────────────────────────────
    // Blueprint facing is literal — no rotation. Each grid position is tested
    // once with the blueprint's authored dimensions (w along X, l along Z).
    const candidates = [];
    let checked = 0;
    // EVERY REASON evaluateCandidate CAN RETURN NEEDS A KEY HERE. The tally below increments only keys
    // that already exist (`!== undefined`), so a reason missing from this object is counted zero forever
    // and its gate reads as dead in every scan report — a silent filter, which is the one thing a gate
    // in this fleet may not be (Law 6).
    const rejections = { chunk_unloaded: 0, too_uneven: 0, overhead_blocked: 0, overlaps_existing: 0, not_dirt_ground: 0, spawn_protected: 0 };
    // Tree-farm mode: histogram of the block names at rejected floor cells, so a failed scan's summary
    // says WHAT the ground was (e.g. "stone×600") instead of a bare count.
    const notDirtBlockCounts = {};

    // Settle diagnostics (require_shaft / headframe is a one-time settle, so heavy logging here is
    // warranted to see WHY the bot won't lock a spot). Aggregates, not per-cell
    // spam: unevenHist = how-uneven distribution; overheadBlockCounts = what's overhead; flattestReject
    // = the closest-to-flat cell we had to reject; groundLo/Hi = the surface-Y span across the scan
    // (a big span = the bot is straddling a slope/mountain, the real reason nothing settles).
    const unevenHist = {};
    const overheadBlockCounts = {};
    // Non-shaft overlap wall: which locked building each rejected candidate collided with (the key
    // overlapsExisting returns). Feeds the "you are boxed inside your own base" post-mortem so a
    // 625/625 overlap names the structure, not just a bare count.
    const overlapKeyCounts = {};
    let flattestReject = null;
    let groundLo = Infinity, groundHi = -Infinity;

    // existingBoxes (the overlap-reject footprints, already padded by the caller's clearance) arrives
    // via opts — the caller owns the ring width (BUFFER_BLOCKS floor; tree farm widens it to keep out of
    // canopy-shading range; the batch also folds in not-yet-locked pending footprints so sibling
    // blueprints in the same startup pass never overlap each other).

    // ── Staircase overlay bookkeeping (require_shaft mode only) ───────────────
    // staircaseCache dedupes the descent check when the same site (x,z column) appears
    // in multiple candidates. staircaseRejections / staircaseSpotsChecked feed the
    // watcher.story explanation of why a spot was (or wasn't) chosen.
    const staircaseCache = new Map();
    const staircaseRejections = { too_shallow: 0, unsafe_descent: 0, biome_mismatch: 0, no_attach_point: 0 };
    let staircaseSpotsChecked = 0;

    // ── Biome gate (require_shaft mode only) ──────────────────────────────────
    // A staircase candidate whose own biome isn't in ACCEPTABLE_BIOMES is rejected — the surface base
    // only settles in the plains/forest families, the SAME set exploration uses to decide when to stop
    // seeking (Law 16). Enforced per candidate here so the descent/headframe site never locks on
    // rejected terrain even if the bot drifted onto a boundary while find_buildingspot ran.
    const biomeGate = requireShaft ? ACCEPTABLE_BIOMES : null;

    // checkStaircaseAt — evaluate (and cache) the diagonal descent for a candidate site.
    // Cached by (x,z): the same column yields the same groundY, so the same descent.
    function checkStaircaseAt(buildCenter) {
      const key = `${buildCenter.x},${buildCenter.z}`;
      if (staircaseCache.has(key)) return { staircase: staircaseCache.get(key), firstCheck: false };
      const result = evaluateStaircasePrism(bot, building, buildCenter, biomeGate);
      staircaseCache.set(key, result);
      staircaseSpotsChecked++;
      if (!result.ok) {
        if (staircaseRejections[result.reason] !== undefined) staircaseRejections[result.reason]++;
        else staircaseRejections.unsafe_descent++;
      }
      return { staircase: result, firstCheck: true };
    }

    // Shared pacer for every voxel-heavy loop below (Law 19: never stall the run stream). Outcome of
    // the radial expansion, filled by the ring loop and read by the exhaustion/post-mortem block.
    const pace = makeScanThrottle();   // time-sliced (one tick); each cell here is a whole footprint read — the pacer normalizes that automatically
    let reachedRadius = 0;
    // Scan wall-clock — every summary reports how long the sweep took: an uncapped search is fine as
    // long as it says how long it ran, so a slow one is visible, not silent.
    const scanStart = Date.now();
    const scanSecs = () => ((Date.now() - scanStart) / 1000).toFixed(1);

    // ── Expanding-ring scan (Dijkstra-nearest, uncapped to the loaded frontier) ──────────────
    // ONE ring machinery for every mode (Law 16). Rings expand from the origin; each cell is tested by
    // the mode's evaluator — flat-ground (+ safe staircase for require_shaft, + plantable-ground gate for
    // the tree farm). We keep the single CLOSEST valid build_center and stop the instant no unscanned cell
    // could be nearer: once ring radius r reaches the best site's distance, every remaining cell (radius >
    // r) is farther, so the best found is the global nearest (the Dijkstra "pop the nearest" guarantee).
    // The surface site's build_center IS the ring cell, so there is no offset slack.
    let best = null;   // { cand, dist } — the single nearest valid site (replace-if-nearer)
    let consecutiveUnloadedRings = 0;

    ringLoop:
    for (let r = 0; ; r += SEARCH_STEP) {   // uncapped — only 'found' or the loaded frontier ends it
      let ringAllUnloaded = true;

      for (const { x: cx, z: cz } of enumerateRing(refX, refZ, r, SEARCH_STEP)) {
        checked++;
        await pace();

        // Surface / staircase site: flat clear ground (+ safe diagonal descent for require_shaft,
        // + plantable-ground gate for the tree farm).
        const r1 = evaluateCandidate(bot, cx, cz, extent, dims.h, refY, existingBoxes, requireDirtGround);
        if (r1.reason !== 'chunk_unloaded') ringAllUnloaded = false; // any readable cell keeps the ring "loaded"

        if (r1.valid) {
          let cand = null;
          if (requireShaft) {
            const buildCenter = { x: cx, y: r1.groundY, z: cz };
            const { staircase } = checkStaircaseAt(buildCenter);
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
      // Nearest-match stop (Dijkstra): the surface site's build_center IS the ring cell, so once the ring
      // radius reaches best.dist no unscanned cell (all farther out) can beat it.
      if (best && r >= best.dist) break ringLoop;
      consecutiveUnloadedRings = (r > 0 && ringAllUnloaded) ? consecutiveUnloadedRings + 1 : 0;
      // Loaded frontier — unloaded chunks in every direction for UNLOADED_RING_STOP rings running.
      // The loaded area is finite, so this always arrives on a no-match scan; it is the sole terminator.
      if (consecutiveUnloadedRings >= UNLOADED_RING_STOP) break ringLoop;
    }

    if (best) candidates.push(best.cand); // the single nearest valid site (or none → exhaustion below)

    // ── Radial-mode exhaustion: Law 13 HARD STOP ─────────────────────────────
    // The staircase + surface scans are uncapped to the loaded frontier, so zero candidates here means
    // NOTHING is buildable in the entire loaded area. That is not a retry and not a walk — the bot
    // cannot fix it: either the start location is unbuildable (bad seed — stranded/hemmed in) or the
    // acceptance standard is too strict and must be tuned; both need a human. So throw (Law 13: default
    // stopped, human inspection) with the full post-mortem as the halt reason.
    if (candidates.length === 0) {
      // Environmental guard BEFORE the hard stop (Law 13's own test — a normal-world transient is a
      // soft-fail, not a coding violation). If EVERY surveyed cell was an unloaded chunk, the world
      // simply hasn't streamed in around the bot yet (just arrived / teleported); that is not a bad
      // seed and not a too-strict standard — it resolves itself. The caller soft-fails for a retry
      // once chunks load, rather than halting the bot on a transient.
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
        // Both tallies merged (surface cells failed pre-descent vs. descents/biome failed) — one
        // breakdown reads the whole scan; the settle diagnostic answers "mountainside" vs "one short".
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

    // The ring scan already returned the single nearest valid site — nothing to rank. A require_shaft
    // candidate carries a validated .staircase block; downstream reads that via this flag.
    const staircaseValidated = requireShaft;

    // ── Found: build the Law 6 narrative (what was inspected, why the pick validated) for the nearest site ──
    const selected = candidates[0];
    const distFromOrigin = Math.hypot(selected.build_center.x - refX, selected.build_center.z - refZ);
    // Ground-composition accountability (surface + staircase modes both anchor a floor on ground):
    // WHAT the floor rests on + how much mound gets sliced.
    const gp = groundProfile(bot, selected.build_center.x, selected.build_center.z, extent, refY);
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
        `Nearest match (flat surface + safe diagonal staircase): build_center=(${selected.build_center.x},${selected.build_center.y},${selected.build_center.z}), ` +
        `footprint=${selected.footprint.width}x${selected.footprint.length}, descends to Y=${selected.staircase.lowestSafeY} ` +
        `(surface Y=${selected.staircase.surfaceY}, depth ${selected.staircase.depthReached}, ${selected.staircase.safeCopies} safe copy(ies)); ` +
        `${distFromOrigin.toFixed(1)} block(s) from origin.${groundNote} Rejected: ${formatRejectionBreakdown(staircaseRejections, {}, STAIRCASE_REJECTION_LABELS)}.`;
    } else {
      successSummary = `Inspected: ${checked} cell(s) out to ring radius ${reachedRadius} in ${scanSecs()}s for '${blueprintName}'. Nearest match: flat, clear spot at (${selected.build_center.x},${selected.build_center.y},${selected.build_center.z}); ${distFromOrigin.toFixed(1)} block(s) from origin.${groundNote} Rejected: ${formatRejectionBreakdown(rejections)}.`;
    }

    return {
      found: true, candidate: selected, distFromOrigin,
      // The reach this candidate was validated at, returned so a caller reserving it against a sibling
      // in the same pass reserves the SAME box the scan proved clear (the batch's pending footprints).
      extent,
      checked, reachedRadius, scanSecs: scanSecs(), staircaseValidated,
      successSummary,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// find_buildingspot is now a pure LIBRARY (Law 16 the old system): the reactive
// signal `receive` — the lazy per-blueprint locate route (job_board → manager → find → set → judge) — is
// RETIRED. lock_all_buildspots is the ONE locator: it calls locate() directly for every base blueprint in
// one startup pass and commits via set_buildspot.lock(). What survives here is the sense-and-report engine
// (locate) plus the geometry helpers the batch composes with (loadBlueprintDims, getExistingFootprints,
// footprintBox). No routing, no throwing except locate's own coding-violation guards.
module.exports = {
  locate,
  loadBlueprintDims,
  getExistingFootprints,
  footprintBox,
};
