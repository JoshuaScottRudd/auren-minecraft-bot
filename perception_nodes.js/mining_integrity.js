// perception node: mining_integrity — diffs the world against building_blueprints.json's mining segments
// and hands back the highest-priority (shallowest, lowest id tuple) incomplete segment's dig/place steps.
// interface: scan(bot) -> { schema, segment_count, built_count, completed_segments, first_incomplete,
// frontier_id, shaft_excavated, maintenance_needed, all_segments_complete }. Called by mining_executor
// before each dig pass.
// Own node (Law 7): segments tile by a [shaftSegment, highwayIndex, branchIndex] tuple, sorted
// depth-major. A wall voxel ("structural_fill") accepts any solid non-gravity block; only air (a breach)
// needs placing, only a gravity block needs replacing. Pure observation (Law 1): segment positions come
// from blueprint arithmetic, compared against the sensed world.

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');

const { comparePriority, generateStaircase } = require('@perception/mining_blueprinter'); // owns attach-point tiling + generation
const { GRAVITY_BLOCKS } = require('@utils/gravity_utils'); // shared cave-in/cascade Set (Law 16)
// normalizeBlockName: world/blueprint name -> inventory token (wall_torch→torch). blocksCompletion is
// the completion-gate predicate shared with the build side (Law 16).
const { normalizeBlockName, group_to_item } = require('@utils/fragment_utils');
const { blocksCompletion } = require('@utils/calculators/build_material_calculator');

let _lastScan = null;         // memory-primary; scan()'s return value is the caller's copy, kept here for getState()
let _lastLoggedSummary = null;

const SOLID_FILL_TOKENS = new Set(['structural_fill']); // loose wall token: any solid non-gravity block satisfies it

function isAir(name) {
  return name === null || name === undefined || name === 'air' || name === 'cave_air' || name === 'void_air';
}

// wallSatisfied — the wall rule the scan below applies, for the placer to ask of the block it finds:
// a `structural_fill` voxel is satisfied by any solid block that does not fall.
function wallSatisfied(type, name) {
  return SOLID_FILL_TOKENS.has(type) && !isAir(name) && !GRAVITY_BLOCKS.has(name);
}

function isTorch(name) {
  return !!name && /torch/.test(name);
}

// The step reasons that are lighting — optional work (scanSegment).
const LIGHT_REASONS = new Set(['torch_missing', 'torch_blocked']);

// gravityAbove: is (x,y+1,z) a gravity block, so digging (x,y,z) lets the column cascade in and the
// carve step must repeat-mine? Unguarded like every blockAt here: null (unloaded) is already handled.
function gravityAbove(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y + 1, z));
  return !!b && GRAVITY_BLOCKS.has(b.name);
}

// Diffs one segment's [wx,wy,wz,type,facing?] voxels against the sensed world; null when fully complete,
// else the dig/place steps plus Y span (executor needs top/bottom Y to pick dig direction).
function scanSegment(bot, segment, excluded) {
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

    // null = unloaded chunk, not air (isAir() folds null in) — unsensed, no step, same contract as
    // building_integrity (Invariant B / Law 13).
    if (actName === null) { unloaded++; continue; }

    if (expType === 'air') { // walkway: must be carved empty — the bulk of mining is DIGGING OUT air voxels
      if (isAir(actName)) { correct++; continue; }
      carve++;
      // gravity_affected: this cell is (or sits under) a gravity block, so digging cascades a column in —
      // the executor must repeat-mine until it stays clear.
      const gravityAffected = GRAVITY_BLOCKS.has(actName) || gravityAbove(bot, x, y, z);
      digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'carve_walkway', ...(gravityAffected ? { gravity_affected: true } : {}) });
      continue;
    }

    if (isTorch(expType)) { // lighting; facing is cosmetic — only presence of a torch variant matters
      if (isTorch(actName)) {
        correct++;
        continue;
      }
      if (isAir(actName)) {
        missing++;
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'torch_missing', ...(expFacing ? { facing: expFacing } : {}) });
        continue;
      }
      mismatched++; // solid block where a torch belongs: clear it, then place the torch
      digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'torch_blocked' });
      placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'torch_blocked', ...(expFacing ? { facing: expFacing } : {}) });
      continue;
    }

    if (SOLID_FILL_TOKENS.has(expType)) { // wall: any solid non-gravity block is acceptable
      // A BRANCH KEEPS ONLY ITS FLOOR. A cell's walls and ceiling are not repaired: a cave or a vein that opens
      // them is left open, and nobody comes back to close it. The floor (the anchor's own height) is what the
      // feet walk on, so a hole in it is still filled. The staircase is the fleet's one way in and out and
      // keeps every wall.
      if (segment.type === 'cell' && y !== segment.world_position.y) { correct++; continue; }
      if (isAir(actName)) {
        missing++; // hole in the wall (e.g. the shaft grazed a cave): wall it off
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'wall_breach' });
        continue;
      }
      if (GRAVITY_BLOCKS.has(actName)) {
        // cave-in risk: dig it out and reseal; gravity_affected so the executor repeat-mines the
        // cascading column before capping
        mismatched++;
        digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'gravity_wall', gravity_affected: true });
        placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'gravity_wall' });
        continue;
      }
      correct++; // wallSatisfied: any other solid block, ore included, IS the wall -- a blueprint is built, never mined for material
      continue;
    }

    if (actName === expType) { correct++; continue; } // exact-name fallback; mining segments are air/solid_fill/torch, this path is rare
    if (isAir(actName)) {
      missing++;
      placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'missing', ...(expFacing ? { facing: expFacing } : {}) });
      continue;
    }
    mismatched++;
    digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'mismatch' });
    placeSteps.push({ id: segment.id, action: 'place', place: { x, y, z }, type: expType, reason: 'mismatch', ...(expFacing ? { facing: expFacing } : {}) });
  }

  // ── LIGHT IS OPTIONAL: a torch is placed in passing, never waited for ─────────────────────────────
  // A torch step is work only for a body holding a torch, and it never holds a segment or cell open: a diff
  // whose outstanding steps are all light reads complete. A working body keeps its 24-block no-spawn sphere
  // over the dark it stands in, so the dig never stops for light.
  if (!bot.inventory.items().some(it => isTorch(it.name))) {
    for (const steps of [digSteps, placeSteps]) {
      for (let i = steps.length - 1; i >= 0; i--) if (LIGHT_REASONS.has(steps[i].reason)) steps.splice(i, 1);
    }
  }
  if (unloaded === 0 && [...digSteps, ...placeSteps].every(s => LIGHT_REASONS.has(s.reason))) return null;

  const totalSteps = digSteps.length + placeSteps.length;
  // unsensed voxels keep the diff PARTIAL, never null ("complete"), or mining_executor's post-diff
  // registers unsensed rock as built (Invariant B / Law 13)
  if (totalSteps === 0 && unloaded === 0) return null; // fully sensed and already matches the world

  // Items the bot can't place yet; a segment reads complete only when every remaining step is one of
  // these. structural_fill is never deferrable — an unsealed breach must never diff clean (Law 17); light
  // is settled above. The set is job_board's per-sweep measurement, passed in as `excluded` —
  // never authored here; absent excluded, nothing defers.
  const DEFERRABLE_TYPES = new Set(require('@thinking/job_exclusions').names(excluded));
  // optional block defers only while the bot can't place it (Law 17); same AND-gate the build side runs
  // via blocksCompletion (Law 16), gated on availableCount saying it's placeable now
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

  // Per-step evidence for the record: a drop in `correct` alone can't say breach vs flickering torch vs
  // unloaded chunk (Invariant C). Capped at WITNESS_CELLS so the reason histogram plus named cells stay a
  // diagnosis, not a dump; sorted deterministically (top-down, dig before place) so an unchanged fault
  // prints unchanged bytes and the caller's log-dedup still suppresses it.
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
  // `type` means opposite things on the two step kinds — found (dig) vs wanted (place) — so the verb is
  // spelled out in full.
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
    anchors: Array.isArray(segment.anchors) ? segment.anchors : null, // per-copy stand-spots; cells fall back to world_position
    voxels: segment.voxels, // full blueprint list (Law 6, building_integrity parity), for a re-diff via scanSegmentSteps after working the segment
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

// Scans ACTIVE segments only: every segment registered built in HQ (permanent maintenance) plus the
// single frontier segment (next to excavate); deeper undug rock is excluded. Results in memory
// (_lastScan) + HQ. Returns { schema, segment_count, built_count, active_count, completed_segments,
// incomplete_count, first_incomplete, frontier_id, shaft_excavated, maintenance_needed,
// all_segments_complete }: first_incomplete is the shallowest active segment with work (.built=true if
// it's damage to a finished segment, .voxels for re-diffing); shaft_excavated drives the cell-mining
// switch; maintenance_needed flags built-segment damage; all_segments_complete = excavated AND undamaged.
// ── A SEGMENT IS BUILT WHEN THIS BODY REGISTERED IT OR THE WORLD SHOWS IT MATCHING ─────────────────
// The registry lives in each body's own HQ, so a segment a peer finished is unknown to it; the world is
// the one record every body shares. `_builtReader` answers from the registry, then from a diff of the
// segment against the world (memoised for the one scan), so the board and the shaft-complete verdict
// read the same fact.
function _builtReader(bot, excluded) {
  const reg = hq.readConfRoomFlag('mining_confrence_room', 'built_segments', {}) || {};
  const clean = new Map();
  return (seg) => {
    if (Object.prototype.hasOwnProperty.call(reg, seg.id) && reg[seg.id]) return true;
    if (!clean.has(seg.id)) { const r = scanSegment(bot, seg, excluded); clean.set(seg.id, !r || _lightOnly(r)); }
    return clean.get(seg.id);
  };
}

// A diff whose every step is light: only a torch-holding body sees one (scanSegment drops light for the
// rest), and it is not a trip — light is placed in passing, so a segment waiting only on a torch is built.
const _lightOnly = (r) => !!r && r.stats.unloaded === 0 && r.steps.length > 0 && r.steps.every(s => LIGHT_REASONS.has(s.reason));

// shaftFillNeed(bot) → how many wall cells across the whole staircase need a fill block placed (breach,
// gravity wall, ore wall), read off the world before the body descends, so the trip carries the fill for the
// shaft it owns.
function shaftFillNeed(bot) {
  let need = 0;
  for (const seg of generateStaircase().staircase_segments || []) {
    const r = scanSegment(bot, seg, null);
    if (r) need += r.steps.filter(s => s.action === 'place' && SOLID_FILL_TOKENS.has(s.type)).length;
  }
  return need;
}

// shaftTorchNeed(bot) → how many of the staircase's torch cells hold no torch now, read off the world: the
// torches a trip down could still place. A cell whose chunk is not loaded is not counted.
function shaftTorchNeed(bot) {
  let need = 0;
  for (const seg of generateStaircase().staircase_segments || []) {
    for (const v of seg.voxels) {
      if (!isTorch(v[3])) continue;
      const at = bot.blockAt(new Vec3(v[0], v[1], v[2]));
      if (at && !isTorch(at.name)) need++;
    }
  }
  return need;
}

function scan(bot, excluded) {
  if (!bot || !bot.blockAt) {
    throw new Error('[mining_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }
  const scanStart = Date.now();   // ~125 voxels × active-segment count — report the sweep cost

  const plan = generateStaircase(); // fresh each scan so blueprint changes take effect immediately; unguarded (Law 16), its own throws say what's wrong
  const allSegments = [...(plan.staircase_segments || [])]; // staircase only; cells are diffed separately via scanSegmentSteps (nearest-to-shaft, mining_cell_graph)

  // BUILT REGISTRY: mining_executor writes a segment's id here once excavated (Law 6 — its section). A
  // built segment is permanent blueprint to maintain, like building_integrity's headframe; this registry
  // distinguishes damage to a finished segment from rock not yet dug.
  const isBuilt = _builtReader(bot, excluded);

  // FRONTIER = shallowest not-yet-built segment. Built segments form a contiguous prefix from the surface
  // and the frontier is the only reachable one to excavate.
  const frontier = allSegments.find(seg => !isBuilt(seg)) || null;
  const anyUnbuilt = allSegments.some(seg => !isBuilt(seg));

  const activeSegments = allSegments.filter(seg => isBuilt(seg) || (frontier && seg.id === frontier.id)); // ACTIVE = built segments + the frontier

  const completedSegmentIds = [];
  const incomplete = [];
  for (const segment of activeSegments) {
    const built = isBuilt(segment);
    // No catch: a dropped throwing segment would shrink `incomplete` and let the shaft read COMPLETE —
    // an error laundered into a success verdict (Law 13). Unloaded chunks are handled by scanSegment's
    // `unloaded` classification, not by throwing.
    // Same diff rule for both: the frontier surfaces as work until sealed, a built segment surfaces its
    // damage; `built` only tags the result for reporting (maintain vs excavate).
    const result = scanSegment(bot, segment, excluded);
    if (result && !_lightOnly(result)) { result.built = built; incomplete.push(result); }
    else completedSegmentIds.push(segment.id);
  }

  // Reachability ordering: shallowest first. Damaged built segments are always shallower
  // than the frontier, so a breach up top is repaired BEFORE the bot digs deeper (Law 17 —
  // keep the structure you stand on intact before extending it).
  incomplete.sort((a, b) => comparePriority(a, b));
  const firstIncomplete = incomplete[0] || null;

  const builtCount = allSegments.filter(seg => isBuilt(seg)).length;
  const maintenanceNeeded = incomplete.some(r => r.built);     // a finished segment has damage
  const shaftExcavated = !anyUnbuilt;                          // every segment dug out + registered
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
    shaft_excavated: shaftExcavated, // drives the switch to cell mining, not gated on damage (cobble keeps flowing for repairs)
    maintenance_needed: maintenanceNeeded, // a built segment has damage to repair
    all_segments_complete: allComplete,
  };

  const priorScan = _lastScan; // held so the log line below can state the delta, not just the position
  _lastScan = integrityOut;

  // same coordinate as headframe's transpose_origin (Law 6) — posted here so both are visible in one file
  hq.writeConfRoomFlag('mining_confrence_room', 'shaft_center', {
    x: plan.site.startX,
    y: plan.site.surfaceY,
    z: plan.site.startZ,
    matches_headframe_transpose_origin: true,
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
      // turns "94 correct" into "94 correct (was 99, -5)" using _lastScan, only for the SAME segment —
      // a delta across two segments would compare unrelated quantities (Law 25)
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

// Diffs one already-generated segment (e.g. a cell from generateCell); returns its work result or null.
// Cells are selected nearest-to-shaft (mining_cell_graph.selectNextCell, D6), not the shaft's depth-major
// order, so scan() answers only "is the shaft done?" while this owns per-cell diffing.
function scanSegmentSteps(bot, segment, excluded) {
  if (!bot || !bot.blockAt) {
    throw new Error('[mining_integrity] CODING VIOLATION: bot must be initialized before scanSegmentSteps().');
  }
  return scanSegment(bot, segment, excluded);
}

function getState() { return _lastScan; }

// Set of "x,y,z" world keys for all non-air voxels in the shaft blueprint, same format as
// building_integrity.getProtectedBlocks; navigator merges it with the building set so A* penalizes
// digging shaft walls instead of entering through the headframe door. `bot` (optional) turns this from a
// PLAN read into a SENSED read, otherwise every declared solid voxel prices a full-budget A* detour
// whether or not anything stands there (Invariant B). The comparator is PROVENANCE, not correctness: a
// block that generates in world terrain was made by the earth (cheap dig); anything else in a wall cell
// was PLACED by the bot (digging destroys work, and a repaired wall reseals with construction material,
// so the second dig stays costly). Unknown names default to CONSTRUCTED/protected (Law 13, default
// stopped), same as a null blockAt.
// The list lives in fragment_utils.group_to_item.natural_block, not here, so site selection and the
// navigator share one definition of "natural" (Law 16).
const NATURAL_TERRAIN_BLOCKS = new Set(group_to_item?.natural_block || []);
function isNaturalTerrain(name) { // ore is the earth's own block, so it reads as natural
  if (!name) return false;
  return NATURAL_TERRAIN_BLOCKS.has(name) || name.endsWith('_ore') || name === 'ancient_debris';
}

// Unguarded: protection fails CLOSED — a throw here stops the bot, keeping the mine protected (Law 13;
// Law 25). No site yet is told apart from a real read failure by ASKING for the locked site (as
// getFootprintCells does below), which surfaces the generator's throw directly (Law 16).
function getProtectedBlocks(bot = null) {
  if (!require('@perception/mining_blueprinter').shaftChair()) return null;
  const plan = generateStaircase();
  const set = new Set();
  for (const segment of plan.staircase_segments) {
    for (const v of segment.voxels) {
      if (v[3] === 'air') continue;
      if (bot) {
        // null = unloaded chunk, NOT air; only a confirmed reading drops the cell
        const actual = bot.blockAt(new Vec3(v[0], v[1], v[2]));
        if (actual && (isAir(actual.name) || isNaturalTerrain(actual.name))) continue;
      }
      set.add(`${v[0]},${v[1]},${v[2]}`);
    }
  }
  return set.size > 0 ? set : null;
}

// Every shaft voxel incl. the carved-air walkway, as a Set of "x,y,z" world keys. Unlike
// getProtectedBlocks (solid-only, for dig penalties), this includes air because a torch dropped into the
// walkway is the overlap torch_integrity must forbid; blueprint always overrides lighting.
function getFootprintCells() {
  if (!require('@perception/mining_blueprinter').shaftChair()) return null; // unlocked site = null (ordinary early-run state), a real throw still travels (Law 13, Law 16)
  const plan = generateStaircase();
  const set = new Set();
  for (const segment of plan.staircase_segments) {
    for (const v of segment.voxels) set.add(`${v[0]},${v[1]},${v[2]}`);
  }
  return set.size > 0 ? set : null;
}

module.exports = { scan, shaftFillNeed, shaftTorchNeed, scanSegmentSteps, getState, getProtectedBlocks, getFootprintCells, wallSatisfied };
