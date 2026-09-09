// perception node: mining_integrity
// purpose: Scan the world against building_blueprints.json mining segments to find
//          which segment (shaft / highway / branch) still has work, and hand back
//          exactly ONE segment's worth of dig/place steps -- the highest-priority
//          (shallowest, lowest id tuple) incomplete segment.
//          Generates shaft segments on the fly from building_blueprints.json +
//          the locked shaft site in corporate_headquarters — no static file needed.
// interface: scan(bot) -> { schema, segment_count, built_count, completed_segments,
//            first_incomplete, frontier_id, shaft_excavated, maintenance_needed, all_segments_complete }
// called by: mining_executor (before each dig pass)
//
// WHY mining_integrity is NOT building_integrity (Law 7 -- its own node):
//   1. SEGMENT TILING. Mining uses repeating segment templates tiled downward,
//      each identified by a numeric [shaftSegment, highwayIndex, branchIndex]
//      tuple. Incomplete segments are sorted by reachability (depth-major, lowest
//      tuple first) — you cannot dig segment 6 through the solid rock of segment 0.
//   2. SOLID-FILL semantics. A mining wall voxel ("structural_fill") means
//      "any solid, non-gravity block is fine here" -- natural stone already
//      satisfies it. Only air (a cave breach) needs a block placed, and only a
//      gravity block (cave-in risk) needs replacing. The bulk of mining work is
//      the opposite of building: DIGGING OUT the air-walkway voxels.
//
// Pure observation (Law 1 perception exception): computes segment positions from
// building_blueprints.json (arithmetic, not a decision), then compares what IS
// in the world vs what the blueprint says SHOULD BE.

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');

// comparePriority + generateStaircase: imported from mining_blueprinter which owns
// the attach-point tiling and segment generation logic.
const { comparePriority, generateStaircase } = require('@perception/mining_blueprinter');

// Gravity-block identification is shared (Law 16) — same Set find_buildingspot and the
// cell scanner use. mining_integrity needs it both to detect cave-in risk in walls and
// to flag carve steps whose column will cascade (gravity_affected, Phase 1.5).
const { GRAVITY_BLOCKS } = require('@utils/gravity_utils');

// normalizeBlockName maps a world/blueprint name to its canonical inventory token (wall_torch→torch)
// so a torch-availability check matches what the bot actually holds. blocksCompletion is the ONE
// completion-gate rule shared with the build side (Law 16): a deferrable block (torch) gates the
// segment only when the bot is actually carrying it — an unlit shaft is a mob hazard, not decoration.
const { normalizeBlockName, group_to_item } = require('@utils/fragment_utils');
const { blocksCompletion } = require('@utils/calculators/build_material_calculator');
const { guardExternalSync } = require('@utils/external_library_guard');

// Memory-primary: last scan result stored here, not written to file.
// Callers get the result from scan()'s return value. HQ conference room
// gets the summary. This variable exists for getState() inspection.
let _lastScan = null;
let _lastLoggedSummary = null;

// "structural_fill" is the loose solid-fill token: any solid, non-gravity
// block satisfies it (natural stone walls are fine as-is). The full solid_fill
// token resolution is a flagged open item -- for now this set is the one member.
const SOLID_FILL_TOKENS = new Set(['structural_fill']);

// ORE derivation (D9). An ore is a block the bot should COLLECT out of a wall (dig it,
// reseal with structural_fill) rather than leave as natural fill. The plan's literal
// shorthand was "a block whose drop ≠ itself", but taken literally that captures stone
// (→cobblestone), deepslate (→cobbled_deepslate) and grass_block (→dirt) — which would
// make the bot needlessly dig-and-reseal every natural stone wall. The precise,
// still-minecraft-data-derived set is "blocks whose name ends in _ore" (covers every
// vanilla ore incl. deepslate/nether variants) plus ancient_debris (drops itself, so the
// suffix/own-drop rules both miss it). Derived per bot.version and cached.
let _oreBlocksCache = null;
let _oreBlocksVersion = null;
function getOreBlocks(bot) {
  const version = bot?.version || null;
  if (_oreBlocksCache && _oreBlocksVersion === version) return _oreBlocksCache;
  const set = new Set(['ancient_debris']);
  // A real boundary: minecraft-data is a third-party module and this version may not be in it. The
  // degraded answer is honest and named — the _ore suffix match downstream still catches every vanilla
  // ore, it just cannot learn a modded one.
  guardExternalSync('mining_integrity', `minecraft-data(${version}) for ore derivation`, () => {
    const mcData = require('minecraft-data')(version);
    for (const b of (mcData?.blocksArray || [])) {
      if (b && typeof b.name === 'string' && b.name.endsWith('_ore')) set.add(b.name);
    }
  });
  _oreBlocksCache = set;
  _oreBlocksVersion = version;
  return set;
}

// isOre — membership in the derived set, with a suffix fallback so the rule still holds
// if minecraft-data enumeration failed (the set would then only carry ancient_debris).
function isOre(name, oreBlocks) {
  if (!name) return false;
  if (oreBlocks && oreBlocks.has(name)) return true;
  return name.endsWith('_ore');
}

function isAir(name) {
  return name === null || name === undefined || name === 'air' || name === 'cave_air' || name === 'void_air';
}

function isTorch(name) {
  return !!name && /torch/.test(name);
}

// DELETED 2026-08-15: `readBlockFacing(block)` — a placed block's facing, for torch orientation checks
// that were never written. No caller. `building_integrity` holds the live property probe; this was a
// second copy of it kept for a check that does not exist (Law 16). `fragment_utils`' wheat-age reader
// still cites building_integrity's probe as its pattern, which is where the pattern actually lives.

// ----------------------------------------------------------------------------
// scanSegment: diff one segment's [wx,wy,wz,type,facing?] voxels against the
// real world. Returns null if the segment is fully complete, otherwise a result
// carrying the dig/place steps plus the segment's Y span (the executor needs the
// top/bottom Y to decide which direction to dig).
// ----------------------------------------------------------------------------
// gravityAbove — is the block directly above (x,y+1,z) a gravity block? If so, digging
// (x,y,z) lets that column cascade in, so the carve step must repeat-mine (Phase 1.6).
// Unguarded, like every blockAt in this file: it ANSWERS null for an unloaded column rather than
// throwing, and null is already the reading each call site handles.
function gravityAbove(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y + 1, z));
  return !!b && GRAVITY_BLOCKS.has(b.name);
}

function scanSegment(bot, segment, oreBlocks) {
  const digSteps = [];
  const placeSteps = [];
  let correct = 0, carve = 0, missing = 0, mismatched = 0, unloaded = 0;
  let yTop = -Infinity, yBottom = Infinity;

  for (const v of segment.voxels) {
    const x = v[0], y = v[1], z = v[2], expType = v[3];
    const expFacing = v[4] != null ? v[4] : null;
    if (y > yTop) yTop = y;
    if (y < yBottom) yBottom = y;

    const actual = bot.blockAt(new Vec3(x, y, z));
    const actName = actual ? actual.name : null;

    // A null block is an UNLOADED chunk, not air. isAir() folds null into 'air', so leaving it
    // unguarded fabricates a confident diff over voxels the bot never sensed — a persistently
    // unloaded wall surfaces as an unsealable wall_breach that never clears, the frontier never
    // registers built, and the manager↔executor pair oscillates until recursive_judge kills it.
    // Mirror building_integrity's null→unloaded contract: count it unsensed, emit no step
    // (Invariant B / Law 13 — never default a missing sensor reading to a value).
    if (actName === null) { unloaded++; continue; }

    // Expected AIR -> the walkway. Must be carved empty. This is the bulk of
    // mining: solid rock where the blueprint wants open space.
    if (expType === 'air') {
      if (isAir(actName)) { correct++; continue; }
      carve++;
      // gravity_affected (Phase 1.5): the position is itself a gravity block, or a
      // gravity block sits directly above it. Either way, digging here lets a column
      // cascade into the space — the executor must repeat-mine until it stays clear.
      const gravityAffected = GRAVITY_BLOCKS.has(actName) || gravityAbove(bot, x, y, z);
      digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'carve_walkway', ...(gravityAffected ? { gravity_affected: true } : {}) });
      continue;
    }

    // Expected TORCH -> lighting. Facing is cosmetic for torches — a torch on any
    // wall lights the room the same way. Only check that a torch variant is present.
    if (isTorch(expType)) {
      if (isTorch(actName)) {
        correct++;
        continue;
      }
      if (isAir(actName)) {
        missing++;
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'torch_missing', ...(expFacing ? { facing: expFacing } : {}) });
        continue;
      }
      // Something solid where a torch belongs: clear it, then place the torch.
      mismatched++;
      digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'torch_blocked' });
      placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'torch_blocked', ...(expFacing ? { facing: expFacing } : {}) });
      continue;
    }

    // Expected SOLID FILL (wall) -> any solid non-gravity block is acceptable.
    if (SOLID_FILL_TOKENS.has(expType)) {
      if (isAir(actName)) {
        // A hole in the wall (e.g. the shaft grazed a cave): wall it off.
        missing++;
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'wall_breach' });
        continue;
      }
      if (GRAVITY_BLOCKS.has(actName)) {
        // Cave-in risk in a wall position: dig it out and reseal with a stable block.
        // gravity_affected so the executor repeat-mines the cascading column before
        // capping (Phase 1.6).
        mismatched++;
        digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'gravity_wall', gravity_affected: true });
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'gravity_wall' });
        continue;
      }
      if (isOre(actName, oreBlocks)) {
        // Ore in a wall position (D9): collect it (dig) and reseal with structural_fill.
        // Mirrors the gravity rule. Copper is included — it's dumped as junk downstream.
        mismatched++;
        digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'ore_wall' });
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'ore_wall' });
        continue;
      }
      // Natural solid wall -- leave it exactly as the earth made it.
      correct++;
      continue;
    }

    // Expected a CONCRETE block (fallback, exact-name match). Mining segments are
    // air/solid_fill/torch today, so this path is rare, but kept for completeness.
    if (actName === expType) { correct++; continue; }
    if (isAir(actName)) {
      missing++;
      placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'missing', ...(expFacing ? { facing: expFacing } : {}) });
      continue;
    }
    mismatched++;
    digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'mismatch' });
    placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'mismatch', ...(expFacing ? { facing: expFacing } : {}) });
  }

  const totalSteps = digSteps.length + placeSteps.length;
  // Unsensed voxels make the diff PARTIAL — never collapse to null ("complete") off an unloaded
  // region, or mining_executor's post-diff registers unsensed rock as built (Invariant B / Law 13).
  if (totalSteps === 0 && unloaded === 0) return null; // fully sensed and already matches the world

  // Items the bot can't place until crafting/smelting produces them. If EVERY remaining
  // step is one of these, the segment is functionally complete.
  //
  // structural_fill (wall/stair reseal) is NEVER deferrable — but NOT because the material is
  // guaranteed present. That was the old reason written here ("the bot can always fill a breach with
  // cobblestone OR planks, so there is no deadlock to defer for") and it was a claim about the stock
  // table, not about this node; when cobblestone's keep went to zero it became false and a breached
  // segment could neither seal nor stand down. The real reason is below and does not depend on stock: a
  // deferred breach would let a half-walled segment diff clean. Absent material is handled where it is
  // sensed — mining_executor exits material_short rather than deferring. A breach is real damage to seal
  // whether the segment is the
  // frontier being excavated or an already-built segment under maintenance — ONE rule for
  // both. This is what makes "built" honest: a frontier diffs clean (and so becomes
  // eligible to register built) ONLY once its walls are actually closed, not while a row
  // of open breaches sits deferred. Marking a half-walled segment built was the bug that
  // flipped it straight to "built segment damaged" and oscillated forever.
  //
  // EMPTY, and torches are why. They were deferred here so an unsmelted torch could not stall the shaft
  // advancing — but a deferred light source lets an UNLIT segment diff clean, and an unlit shaft spawns
  // the mobs (Law 17). The bootstrap case the deferral protected is already answered upstream: fuel is
  // reachable from the storage chest the furnace chain stocks, so a torch order is fillable rather than
  // impossible, and a segment that genuinely cannot obtain material exits `material_short` from
  // mining_executor instead of quietly reading complete. Deferral traded a stall for a silence, and the
  // silence is worse: a stall is visible in the trace, a segment that diffs clean while dark is not.
  const DEFERRABLE_TYPES = new Set([]);
  // An optional block (torch/furnace) defers ONLY while the bot can't place it — a torch the bot is
  // carrying stops being deferrable and starts being outstanding safety work (an unlit shaft spawns
  // mobs, Law 17). This is the SAME AND-gate the build side runs via blocksCompletion (Law 16): the
  // predicate gates on the block ONLY when availableCount says it's placeable now, so an absent torch
  // still doesn't block the shaft advancing (bootstrap — the torch needs upstream smelting).
  const invCounts = {};
  for (const it of bot.inventory.items()) {
    const n = normalizeBlockName(it.name);
    invCounts[n] = (invCounts[n] || 0) + it.count;
  }
  const availableCount = (item) => invCounts[normalizeBlockName(item)] || 0;
  const deferrableOnly = unloaded === 0 &&
    digSteps.length === 0 &&
    placeSteps.length > 0 &&
    !placeSteps.some(s => blocksCompletion(s.type, 1, DEFERRABLE_TYPES, availableCount));
  if (deferrableOnly) return null;

  // Counts alone cannot diagnose a regression: a drop in the correct count can mean a wall breach, a
  // torch flickering out of the count on a re-render, or cells reading as air because the chunk
  // half-unloaded — three different causes that print the identical count line and call for three
  // different responses. The per-step evidence already existed on `steps` and simply never reached the
  // record (Invariant C: reasoning recoverable by whoever depends on it — and the dependant here is a
  // cold-start reader with no live world to go look at).
  //
  // Capped at WITNESS_CELLS because the point is a DIAGNOSIS, not a dump: the reason histogram carries the
  // shape of the whole diff, and the named cells are there so the reader can go stand at one. The list is
  // deterministically sorted (top-down, dig before place), so an unchanged fault prints unchanged bytes and
  // the caller's log-dedup still suppresses it — a witness that reshuffled every scan would defeat that.
  const sortedSteps = [...digSteps, ...placeSteps].sort((a, b) => {
    if (b.place.y !== a.place.y) return b.place.y - a.place.y;
    if (a.action !== b.action) return a.action === 'dig' ? -1 : 1;
    if (a.place.x !== b.place.x) return a.place.x - b.place.x;
    return a.place.z - b.place.z;
  });
  const WITNESS_CELLS = 6;
  const reasonCounts = {};
  for (const s of sortedSteps) reasonCounts[s.reason] = (reasonCounts[s.reason] || 0) + 1;
  const reasonText = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r, n]) => `${r}x${n}`).join(' ');
  // `type` means opposite things on the two step kinds — on a dig it is the block FOUND, on a place it is
  // the block WANTED — so the verb is spelled out rather than left to a symbol. A reader who has to guess
  // which way round it is has been handed the same ambiguity in a shorter string.
  const witnessText = sortedSteps.slice(0, WITNESS_CELLS)
    .map(s => `${s.action}(${s.place.x},${s.place.y},${s.place.z})`
      + `${s.action === 'dig' ? 'found' : 'want'}=${s.type}/${s.reason}`)
    .join(' ');
  const witness = sortedSteps.length
    ? ` reasons[${reasonText}]`
      + ` first${Math.min(WITNESS_CELLS, sortedSteps.length)}: ${witnessText}`
      + (sortedSteps.length > WITNESS_CELLS ? ` (+${sortedSteps.length - WITNESS_CELLS} more)` : '')
    : '';

  return {
    id: segment.id,
    type: segment.type,
    world_position: segment.world_position,
    // Per-copy anchor stand-spots (world coords), transposed by mining_blueprinter.
    // The anchored builder (Item 5) stands at each and dig-all/place-all within reach.
    // Carried through so first_incomplete reaches mining_executor with its stand spots;
    // cells (scanSegmentSteps) have no per-copy anchors and fall back to world_position.
    anchors: Array.isArray(segment.anchors) ? segment.anchors : null,
    // The segment's full blueprint voxel list — "what SHOULD be there" (Law 6,
    // building_integrity parity). Carried on the result so a caller that holds only
    // this scan output (e.g. mining_executor's first_incomplete) can RE-DIFF the same
    // segment with scanSegmentSteps after working it — the maintenance re-pass needs a
    // fresh diff to catch blocks the bot itself broke while carving/placing.
    voxels: segment.voxels,
    y_top: yTop,
    y_bottom: yBottom,
    stats: {
      expected: segment.voxels.length,
      correct,
      carve,
      missing,
      mismatched,
      unloaded,
      dig_steps: digSteps.length,
      place_steps: placeSteps.length,
      total_steps: totalSteps,
    },
    steps: sortedSteps,
    reasons: reasonCounts,
    summary: `${segment.type} ${segment.id} y=${yBottom}..${yTop} expected=${segment.voxels.length} correct=${correct} carve=${carve} missing=${missing} mismatched=${mismatched} unloaded=${unloaded} (dig=${digSteps.length} place=${placeSteps.length})${witness}`,
  };
}

/**
 * Scan the world against the SHAFT plan and return the highest-priority work item.
 * Only ACTIVE segments are scanned: every segment registered built in HQ (permanent
 * maintenance) plus the single frontier segment (next to excavate). Deeper undug rock
 * is excluded so the scan never reports it as work. Results in memory (_lastScan) + HQ.
 *
 * @param {object} bot - mineflayer bot instance
 * @returns {{ schema, segment_count, built_count, active_count, completed_segments,
 *   incomplete_count, first_incomplete, frontier_id, shaft_excavated, maintenance_needed,
 *   all_segments_complete }}
 *   - first_incomplete: shallowest active segment with work (a damaged BUILT segment, flagged
 *     .built=true, or the frontier to dig). Carries .voxels for re-diffing.
 *   - shaft_excavated: every segment dug out + registered (drives the cell-mining switch).
 *   - maintenance_needed: a built segment has damage to repair.
 *   - all_segments_complete: excavated AND undamaged — no shaft work of any kind.
 */
function scan(bot) {
  if (!bot || !bot.blockAt) {
    throw new Error('[mining_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }
  const scanStart = Date.now();   // ~125 voxels × active-segment count — report the sweep cost

  // Generate staircase segments on the fly from building_blueprints.json + the locked
  // shaft site in corporate_headquarters. Attach-point tiled, computed fresh each scan so
  // blueprint changes take effect immediately.
  // Unguarded: generateStaircase is ours and its own throws already say what is wrong with the
  // blueprint or the locked site. Re-labelling one as a CODING VIOLATION added a word and cost the
  // original stack (Law 16 — a catch that only re-words is a second pathway to the same failure).
  const plan = generateStaircase();

  // Staircase segments only (top-down: generateStaircase emits surface → deep, so index 0
  // is the surface copy). Cells are NOT folded in here — they are selected nearest-to-shaft
  // via mining_cell_graph and diffed one at a time (scanSegmentSteps). scan() owns the
  // descent only.
  const allSegments = [...(plan.staircase_segments || [])];

  // ── BUILT REGISTRY ──────────────────────────────────────────────────────────
  // mining_executor writes a segment's id here the moment it finishes excavating it
  // (Law 6 — mining_executor owns this section). A mining blueprint is NOT dig-and-forget:
  // once a segment is built it is a PERMANENT blueprint to maintain, exactly like
  // building_integrity maintains the headframe (a creeper hole is always rebuilt). The
  // registry is what lets this node tell "damage to a finished segment" (repair it) apart
  // from "rock that simply hasn't been dug yet" (NOT damage). Without it the scan would
  // report the undug void at the bottom of the shaft as endless work.
  const builtRegistry = hq.readConfRoomFlag('mining_confrence_room', 'built_segments', {}) || {};
  const isBuilt = (id) => Object.prototype.hasOwnProperty.call(builtRegistry, id) && !!builtRegistry[id];

  // FRONTIER = the shallowest not-yet-built segment. Built segments form a contiguous
  // prefix from the surface (the shaft is excavated strictly top-down), so the first
  // unbuilt one is the only currently-reachable segment to excavate. Everything BELOW it
  // is undug rock and is excluded from the scan entirely.
  let frontier = null;
  for (const seg of allSegments) { if (!isBuilt(seg.id)) { frontier = seg; break; } }

  // ACTIVE = every built segment (permanent maintenance) + the single frontier segment
  // (excavation). Deeper unbuilt segments are not scanned.
  const activeSegments = allSegments.filter(seg => isBuilt(seg.id) || (frontier && seg.id === frontier.id));

  // Derive the ore set once for this scan (version-bound, cached across scans).
  const oreBlocks = getOreBlocks(bot);

  const completedSegmentIds = [];
  const incomplete = [];
  for (const segment of activeSegments) {
    const built = isBuilt(segment.id);
    // NO CATCH. A `catch → warn` here would drop a throwing segment from BOTH `incomplete` and
    // `completedSegmentIds`, so it would silently vanish — and since `allComplete = shaftExcavated &&
    // incomplete.length === 0` below, a segment that CRASHED would shrink `incomplete` and let the shaft
    // read COMPLETE: an error laundered into a success verdict. Unloaded chunks are already handled by
    // scanSegment's `unloaded` classification, not by throwing, so a throw here is a coding violation
    // and must surface (Law 13).
    // ONE diff rule for both (breaches always count — see scanSegment): the frontier
    // surfaces as work until its walls are sealed, and a built segment surfaces its
    // damage. The built flag only tags the result for reporting (MAINTAIN vs excavate).
    const result = scanSegment(bot, segment, oreBlocks);
    if (result) { result.built = built; incomplete.push(result); }
    else completedSegmentIds.push(segment.id);
  }

  // Reachability ordering: shallowest first. Damaged built segments are always shallower
  // than the frontier, so a breach up top is repaired BEFORE the bot digs deeper (Law 17 —
  // keep the structure you stand on intact before extending it).
  incomplete.sort((a, b) => comparePriority(a, b));
  const firstIncomplete = incomplete[0] || null;

  const builtCount = allSegments.filter(seg => isBuilt(seg.id)).length;
  const maintenanceNeeded = incomplete.some(r => r.built);     // a finished segment has damage
  const shaftExcavated = frontier === null;                    // every segment dug out + registered
  const allComplete = shaftExcavated && incomplete.length === 0; // dug out AND undamaged

  const integrityOut = {
    schema: 'auren.mining_integrity.v1',
    generated_at: new Date().toISOString(),
    segment_count: allSegments.length,
    built_count: builtCount,
    active_count: activeSegments.length,
    completed_segments: completedSegmentIds,
    incomplete_count: incomplete.length,
    first_incomplete: firstIncomplete,
    frontier_id: frontier ? frontier.id : null,
    // shaft_excavated drives the switch to cell mining (NOT gated on damage, so cobble
    // keeps flowing for repairs); maintenance_needed flags damage to a built segment;
    // all_segments_complete = no actionable shaft work of any kind remains.
    shaft_excavated: shaftExcavated,
    maintenance_needed: maintenanceNeeded,
    all_segments_complete: allComplete,
  };

  // Held across the assignment below so the log line can state the MOVEMENT of the diff, not only its
  // position. See the delta note at the emit site.
  const priorScan = _lastScan;
  _lastScan = integrityOut;

  // Post shaft center to mining_confrence_room (Law 6). This is the same coordinate
  // as headframe's build_center — posted here so both are visible in one file for
  // verifying alignment.
  hq.writeConfRoomFlag('mining_confrence_room', 'shaft_center', {
    x: plan.site.startX,
    y: plan.site.surfaceY,
    z: plan.site.startZ,
    matches_headframe_build_center: true,
    writer: 'mining_integrity',
  });

  const summaryKey = firstIncomplete
    ? `${firstIncomplete.built ? 'maint' : 'dig'}:${firstIncomplete.summary}`
    : (shaftExcavated ? `all_${allSegments.length}_complete` : `frontier_clean_${frontier && frontier.id}`);
  if (summaryKey !== _lastLoggedSummary) {
    _lastLoggedSummary = summaryKey;
    const scanNote = ` (scan ${Date.now() - scanStart}ms)`;
    if (firstIncomplete) {
      const tag = firstIncomplete.built ? 'MAINTAIN (built segment damaged)' : 'excavate frontier';
      // ── DIRECTION, NOT JUST POSITION ────────────────────────────────────────────────────────────────
      // A line reading `correct=94` is only alarming if the reader remembers it said 99 last scan, and
      // nothing in the record carried that: this node is a fresh-sense perception call with no memory in
      // its output, so the previous number lived only in a human's head, one scroll up. The scan DOES
      // hold the prior result in _lastScan for exactly one tick — spending it here turns "94 correct"
      // into "94 correct (was 99, -5)", which is the difference between a number and a symptom. Only
      // emitted for the SAME segment: a delta across two different segments is a comparison of unrelated
      // quantities, i.e. a false statement in a true-looking format (Law 25).
      const prior = priorScan && priorScan.first_incomplete;
      let delta = '';
      if (prior && prior.id === firstIncomplete.id && prior.stats && firstIncomplete.stats) {
        const parts = ['correct', 'carve', 'missing', 'mismatched', 'unloaded']
          .filter(k => prior.stats[k] !== firstIncomplete.stats[k])
          .map(k => `${k} ${prior.stats[k]}->${firstIncomplete.stats[k]}`);
        if (parts.length) delta = ` | since last scan: ${parts.join(', ')}`;
      }
      watcher.summary('mining_integrity', `${tag}: ${firstIncomplete.summary}${delta} | built ${builtCount}/${allSegments.length} shaft_center=(${plan.site.startX},${plan.site.surfaceY},${plan.site.startZ})${scanNote}`);
    } else if (shaftExcavated) {
      watcher.summary('mining_integrity', `shaft fully excavated & intact — all ${allSegments.length} segment(s) built, nothing to maintain.${scanNote}`);
    } else {
      watcher.summary('mining_integrity', `frontier ${frontier && frontier.id} already matches the blueprint — awaiting executor to register it built (built ${builtCount}/${allSegments.length}).${scanNote}`);
    }
    if (completedSegmentIds.length > 0) watcher.summary('mining_integrity', `clean this scan: ${completedSegmentIds.join(', ')}`);
  }

  return integrityOut;
}

// scanSegmentSteps — diff ONE already-generated segment (e.g. a cell from
// generateCell) against the world and return its work result, or null if complete.
// The cell system uses this instead of the full shaft scan(): cells are SELECTED by
// nearest-to-shaft (mining_cell_graph.selectNextCell, D6), not by the shaft's
// depth-major priority order, so they are NOT folded into scan()'s iteration. This
// keeps scan() answering exactly one question — "is the shaft done?" — while the cell
// path owns cell selection and per-cell diffing. Derives the ore set from the bot.
function scanSegmentSteps(bot, segment) {
  if (!bot || !bot.blockAt) {
    throw new Error('[mining_integrity] CODING VIOLATION: bot must be initialized before scanSegmentSteps().');
  }
  return scanSegment(bot, segment, getOreBlocks(bot));
}

function getState() { return _lastScan; }

// Returns a Set of "x,y,z" keys for all non-air voxels in the shaft blueprint,
// transposed to world coordinates. Same format as building_integrity.getProtectedBlocks.
// Navigator merges this with the building set so A* penalizes digging through
// shaft walls instead of entering through the headframe door.
// `bot` (optional) turns this from a PLAN read into a SENSED read — the staircase half of the
// protected-voxel fix (see the long WHY on blueprint_survey.worldVoxelKeys). Without it,
// every DECLARED solid voxel is protected whether or not anything stands in it, so A* priced empty
// space at PROTECTED_VOXEL_DETOUR_BUDGET and charged a full-budget detour to route through a wall that does not exist
// (Invariant B: remembered intent, never re-sensed).
//
// NATURAL vs CONSTRUCTED is the comparator here, and the asymmetry with the building filter is the
// point: a bot can dig a natural block cheaply, but rebuilding the blueprint afterward uses cobblestone
// or another construction block, making the second dig maximally costly.
//
// WHY EXACT/GROUP MATCHING CANNOT BE REUSED HERE — the wrong turn, so a successor does not retake it:
// the first draft called blueprint_survey.classifyVoxel. But mining's wall token is `structural_fill`,
// a LOOSE group whose members include stone, andesite, diorite, granite and dirt (SOLID_FILL_TOKENS,
// scanSegment: "natural stone walls are fine as-is"). Under group matching every untouched rock wall
// reads CORRECT, so nothing would ever drop out and the entire staircase would stay at PROTECTED_VOXEL_DETOUR_BUDGET — the
// exact bug this parameter exists to remove. Group membership cannot separate natural from placed,
// because the earth and the bot both produce members of the same group.
//
// So the discriminator is PROVENANCE, not correctness: a cell holding a block that GENERATES in world
// terrain was made by the earth and costs a plain dig; anything else in a wall cell is something the bot
// PLACED, and digging it destroys real work. The anti-thrash guarantee comes free: a bot may cheaply dig
// through a natural wall once, but the repair reseals it with cobblestone, which is not natural, so the
// second dig is PROTECTED_VOXEL_DETOUR_BUDGET. The loop cannot run.
//
// UNKNOWN NAMES DEFAULT TO CONSTRUCTED (protected). A block on neither provenance list is one nobody
// thought about; over-protecting costs a detour, under-protecting destroys a wall (Law 13, default
// stopped). Same reason a null blockAt stays protected: unsensed is not permission.
//
// The list itself lives in fragment_utils.group_to_item.natural_block, NOT here. It was briefly a local
// set in this file, which made it a SECOND definition of "natural" invisible to site selection and to the
// navigator — the same Law 16 fault that had "what is a construction block" living in five places.
const NATURAL_TERRAIN_BLOCKS = new Set(group_to_item?.natural_block || []);
// Ore is left OUT of natural_block deliberately and re-added here: scanSegment's D9 rule digs ore out of
// a wall and reseals it, so an ore cell is work the bot is already scheduled to do — not a wall to route
// around. That is mining's business, so the exception lives with mining rather than in the shared list.
function isNaturalTerrain(name) {
  if (!name) return false;
  return NATURAL_TERRAIN_BLOCKS.has(name) || name.endsWith('_ore') || name === 'ancient_debris';
}

// Unguarded, and this is the one place in the file where a guard was actively dangerous: `catch { return
// null }` reads downstream as "nothing here is protected", so A* re-priced the whole shaft from PROTECTED_VOXEL_DETOUR_BUDGET
// to ordinary terrain and was free to dig or bridge straight through it. Protection must fail CLOSED —
// a throw stops the bot instead of quietly unprotecting the mine (Law 13; Law 25).
//
// NO SITE YET IS NOT A DEFECT, AND THAT DISTINCTION IS THE WHOLE GUARD. "There is a shaft and I could not
// read it" must stop the bot; "no shaft has been planned yet" is the ordinary state of every run before
// find_buildingspot finishes, and answering it with an empty protection set is the truth rather than a
// swallowed failure — an unplanned shaft has no voxels to protect. The two are told apart by ASKING for
// the locked site, exactly as getFootprintCells below already does, never by catching the generator's
// throw (Law 16 — a catch is never the expected pathway).
//
// THE FAILURE THIS REPAIRS, in structural terms: the navigator collects protected blocks on EVERY
// navigation, so a bot that walked anywhere before its site was locked reached the generator's coding
// violation through a path that had done nothing wrong. It arrived as an unhandled rejection outside the
// judge, which kills that bot's signal for the rest of the run — a Law 13 misclassification (environmental
// state reported as a coding violation) whose cost was a silent bot, not a stopped one.
function getProtectedBlocks(bot = null) {
  const site = hq.readBuildingChair('headframe', 'set_buildspot');
  if (!site?.build_center || !site?.staircase) return null;
  const plan = generateStaircase();
  const set = new Set();
  for (const segment of plan.staircase_segments) {
    for (const v of segment.voxels) {
      if (v[3] === 'air') continue;
      if (bot) {
        // null = unloaded chunk, NOT air — isAir() would fold the two and unprotect a wall the bot
        // never sensed. Only a confirmed reading drops the cell.
        const actual = bot.blockAt(new Vec3(v[0], v[1], v[2]));
        if (actual && (isAir(actual.name) || isNaturalTerrain(actual.name))) continue;
      }
      set.add(`${v[0]},${v[1]},${v[2]}`);
    }
  }
  return set.size > 0 ? set : null;
}

// getFootprintCells — EVERY shaft voxel incl. the carved-air walkway, as a Set of "x,y,z" world
// keys. Unlike getProtectedBlocks (solid-only, for dig penalties), this includes air because a torch
// dropped into the walkway is exactly the overlap torch_integrity must forbid — the torch↔shaft
// collision that made a built segment re-diff "damaged" forever. Blueprint always overrides lighting.
function getFootprintCells() {
  // ASKS whether the site is locked rather than provoking generateStaircase's coding violation and
  // catching it. Callers use this to avoid lighting inside a blueprint, and "no shaft planned yet" is an
  // ordinary early-run state — so the unlocked case is a null, and a throw from the generator stays what
  // it is: a defect that must travel (Law 13, Law 16 — a catch is never the expected pathway). Mirrors
  // building_integrity.getFootprintCells, which already returns null on an unlocked site with no throw.
  const site = hq.readBuildingChair('headframe', 'set_buildspot');
  if (!site?.build_center || !site?.staircase) return null;
  const plan = generateStaircase();
  const set = new Set();
  for (const segment of plan.staircase_segments) {
    for (const v of segment.voxels) set.add(`${v[0]},${v[1]},${v[2]}`);
  }
  return set.size > 0 ? set : null;
}

module.exports = { scan, scanSegmentSteps, getState, getProtectedBlocks, getFootprintCells };
