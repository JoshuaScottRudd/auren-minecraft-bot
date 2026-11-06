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

// ── THE DEEP SHAFT IS DUG WHEN A MATERIAL ASKS ──────────────────────────────────────────────────────────
// assessors/mining sets this each sweep from the gate (an ask for a deep ore, the tool that ore needs). Closed, the
// scan holds the descent to the shallow shaft: the deep pieces are neither work nor upkeep.
let _deepOpen = false;
function setDeepOpen(open) { _deepOpen = !!open; }
function isDeepOpen() { return _deepOpen; }
// openSegments(plan) → the pieces this body may work now, top first.
const openSegments = (plan) => plan.staircase_segments.filter(seg => _deepOpen || seg.part === 'shallow');

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
const LIGHT_REASONS = new Set(['torch_missing']);

// facingFrom(attach, at) → the way a wall torch at `at` hung on `attach` faces: away from the wall.
function facingFrom(attach, at) {
  if (at.x > attach.x) return 'east';
  if (at.x < attach.x) return 'west';
  return at.z > attach.z ? 'south' : 'north';
}

// gravityAbove: is (x,y+1,z) a gravity block, so digging (x,y,z) lets the column cascade in and the
// carve step must repeat-mine? Unguarded like every blockAt here: null (unloaded) is already handled.
function gravityAbove(bot, x, y, z) {
  const b = bot.blockAt(new Vec3(x, y + 1, z));
  return !!b && GRAVITY_BLOCKS.has(b.name);
}

// _torchStep → the place step for the torch the mine's design stands in this open cell (lighting_integrity.mineLamps,
// `lamps` its spots), or null.
function _torchStep(lamps, segment, x, y, z) {
  const lamp = lamps.get(`${x},${y},${z}`);
  if (!lamp) return null;
  return { id: segment.id, action: 'place', place: { x, y, z }, type: 'wall_torch', reason: 'torch_missing', facing: facingFrom(lamp.attach, lamp.source) };
}

// Diffs one segment's [wx,wy,wz,type,facing?] voxels against the sensed world; null when fully complete,
// else the dig/place steps plus Y span (executor needs top/bottom Y to pick dig direction).
function scanSegment(bot, segment, excluded) {
  const digSteps = [];
  const placeSteps = [];
  let correct = 0, carve = 0, missing = 0, mismatched = 0, unloaded = 0;
  let yTop = -Infinity, yBottom = Infinity;
  const lamps = require('@perception/lighting_integrity').mineLamps().spots;

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
      // A torch in the walkway is the mine's light (lighting_integrity), never rock to carve.
      if (isTorch(actName)) { correct++; continue; }
      if (isAir(actName)) {
        // The torch the mine's design stands in this cell, missing: light, placed in passing by a body holding
        // torches, in the shaft and the tunnels alike.
        const step = _torchStep(lamps, segment, x, y, z);
        if (!step) { correct++; continue; }
        missing++;
        placeSteps.push(step);
        continue;
      }
      carve++;
      // gravity_affected: this cell is (or sits under) a gravity block, so digging cascades a column in —
      // the executor must repeat-mine until it stays clear.
      const gravityAffected = GRAVITY_BLOCKS.has(actName) || gravityAbove(bot, x, y, z);
      digSteps.push({ id: segment.id, action: 'dig', place: { x, y, z }, type: actName, reason: 'carve_walkway', ...(gravityAffected ? { gravity_affected: true } : {}) });
      // THE DIGGER LIGHTS AS IT DIGS. The mine's torches stand on its design, so a torch designed into this rock is
      // placed in the same pass, after the digs (places follow digs), never by a pass that comes back.
      const torch = _torchStep(lamps, segment, x, y, z);
      if (torch) placeSteps.push(torch);
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

    if (actName === expType) { correct++; continue; } // exact-name fallback; mining segments are air/solid_fill, this path is rare
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
    part: segment.part,
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
// all_segments_complete, unseen }: first_incomplete is the shallowest active segment with work (.built=true if
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

// ── A SHAFT NEVER OPENS INTO A CAVE ────────────────────────────────────────────────────────────────
// Every shaft is sited only where its descent meets no cave (building_site_overlays.evaluateStaircaseFrom), so a
// staircase segment still being dug for the first time (rock left to carve) whose wall is already air deeper than
// CAVE_BELOW_SURFACE under the shaft's ground, with air beyond it in the shell outside the segment, is a cave the
// siting missed: the site is wrong, and the fleet stops before a body digs beside it (Law 13). A finished segment's
// breach is damage and is resealed as before.
// A CAVE REACHES PAST THE WALL. A wall cell the crew itself emptied — a gravel wall dug out to be resealed
// (gravity_wall), with its stone not placed yet — is air enclosed by the walkway and the rock round it, and a peer's
// scan between the dig and the place reads it as a breach, open to the walkway of the flight above it. Only a breach
// whose air goes on outside the staircase's own cells (every segment's, `shaft`) is a cave: the same PRISM_MARGIN
// shell the siting reads its cave air in (checkCopyHazards).
// A CAVE IS THERE BEFORE THE DIG. The siting refused every air cell of that shell, so air found there once a body
// has dug into the segment was made by the dig: gravel that fell from a wall dug out to be resealed leaves air the
// siting never saw. The stop reads a segment no body has dug yet, every walkway cell of its own (none another
// segment shares) still rock; a breach in a segment already being dug is resealed as wall_breach.
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function _shaftCells(segments) {
  return new Set(segments.flatMap(seg => seg.voxels.map(v => `${v[0]},${v[1]},${v[2]}`)));
}
function _openBeyond(bot, shaft, p) {
  return SIDES.some(([dx, dy, dz]) => {
    const x = p.x + dx, y = p.y + dy, z = p.z + dz;
    if (shaft.has(`${x},${y},${z}`)) return false;
    const b = bot.blockAt(new Vec3(x, y, z));
    return !!b && isAir(b.name);
  });
}
function _untouched(bot, segments, segment) {
  const others = _shaftCells(segments.filter(seg => seg.id !== segment.id));
  return segment.voxels.every(v => {
    if (v[3] !== 'air' || others.has(`${v[0]},${v[1]},${v[2]}`)) return true;
    const b = bot.blockAt(new Vec3(v[0], v[1], v[2]));
    return !b || (!isAir(b.name) && !isTorch(b.name));
  });
}
function _refuseCave(bot, shaft, segments, segment, result) {
  if (!result || segment.type !== 'staircase' || result.stats.carve === 0) return;
  const site = require('@perception/mining_blueprinter').shaftChair();
  if (!site) return;
  const { STAIRCASE_SAFETY } = require('@utils/building_site_overlays');
  const deep = site.staircase.surfaceY - STAIRCASE_SAFETY.CAVE_BELOW_SURFACE;
  const open = result.steps.filter(st => st.reason === 'wall_breach' && st.place.y <= deep && _openBeyond(bot, shaft, st.place));
  if (!open.length || !_untouched(bot, segments, segment)) return;
  const o = site.transpose_origin;
  throw new Error(`[mining_integrity] LAW 13 HARD STOP — the shaft sited at (${o.x},${o.y},${o.z}) opens into a cave: staircase `
    + `segment ${segment.id} (y=${result.y_bottom}..${result.y_top}), not yet dug, has ${open.length} wall cell(s) of air at or below `
    + `y${deep}, first ${open.slice(0, 4).map(st => `(${st.place.x},${st.place.y},${st.place.z})`).join(' ')}. The siting refuses any `
    + `descent that meets cave air, so this site is wrong; the shaft is not dug beside a cave.`);
}

// shaftFillNeed(bot) → how many wall cells across the whole staircase need a fill block placed (breach,
// gravity wall, ore wall), read off the world before the body descends, so the trip carries the fill for the
// shaft it owns.
function shaftFillNeed(bot) {
  let need = 0;
  for (const seg of openSegments(generateStaircase())) {
    const r = scanSegment(bot, seg, null);
    if (r) need += r.steps.filter(s => s.action === 'place' && SOLID_FILL_TOKENS.has(s.type)).length;
  }
  return need;
}

function scan(bot, excluded) {
  if (!bot || !bot.blockAt) {
    throw new Error('[mining_integrity] CODING VIOLATION: bot must be initialized before scan(). Check caller.');
  }
  const scanStart = Date.now();   // ~125 voxels × active-segment count — report the sweep cost

  const plan = generateStaircase(); // fresh each scan so blueprint changes take effect immediately; unguarded (Law 16), its own throws say what's wrong
  const allSegments = openSegments(plan); // staircase only; cells are diffed separately via scanSegmentSteps (nearest-to-shaft, mining_cell_graph)

  // BUILT REGISTRY: mining_executor writes a segment's id here once excavated (Law 6 — its section). A
  // built segment is permanent blueprint to maintain, like building_integrity's headframe; this registry
  // distinguishes damage to a finished segment from rock not yet dug.
  const isBuilt = _builtReader(bot, excluded);

  // FRONTIER = shallowest not-yet-built segment. Built segments form a contiguous prefix from the surface
  // and the frontier is the only reachable one to excavate.
  const frontier = allSegments.find(seg => !isBuilt(seg)) || null;
  const anyUnbuilt = allSegments.some(seg => !isBuilt(seg));

  let _cells = null;
  const shaftCells = () => (_cells = _cells || _shaftCells(allSegments));
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
    if (!built) _refuseCave(bot, shaftCells(), allSegments, segment, result);
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
  const shaftExcavated = allSegments.filter(seg => seg.part === 'shallow').every(isBuilt);   // the shallow shaft dug out + registered
  const deepPieces = allSegments.filter(seg => seg.part === 'deep');
  const deepExcavated = deepPieces.length > 0 && deepPieces.every(isBuilt);   // the deep shaft too, only ever true while it is open
  const allComplete = !anyUnbuilt && incomplete.length === 0;  // every open piece dug out AND undamaged
  // ── A SHAFT THIS BODY CANNOT SEE WHOLE IS NOT JUDGED ──────────────────────────────────────────────
  // An unloaded cell emits no step and is not a fault, so a segment out of sight reads neither built nor
  // damaged. The verdict stays the one this body last read with the shaft in sight (building_integrity's
  // unseen structure, the same ruling); a body that never saw it keeps this scan's verdict.
  const unseen = incomplete.some(r => r.stats.unloaded > 0);
  if (unseen && _lastScan && !_lastScan.unseen) return { ..._lastScan, unseen: true };

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
    deep_excavated: deepExcavated, // drives the deep tunnels
    open_excavated: !anyUnbuilt, // nothing left to dig for the first time, so the upkeep pass may run
    shaft_excavated: shaftExcavated, // drives the switch to cell mining, not gated on damage (cobble keeps flowing for repairs)
    maintenance_needed: maintenanceNeeded, // a built segment has damage to repair
    all_segments_complete: allComplete,
    unseen,
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
    : (!anyUnbuilt ? `all_${allSegments.length}_complete` : `frontier_clean_${frontier && frontier.id}`);
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
    } else if (!anyUnbuilt) {
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
const TREE_LOGS = new Set(group_to_item.logs);
function isNaturalTerrain(name) { // ore is the earth's own block, so it reads as natural
  if (!name) return false;
  return NATURAL_TERRAIN_BLOCKS.has(name) || name.endsWith('_ore') || name === 'ancient_debris';
}

// Unguarded: protection fails CLOSED — a throw here stops the bot, keeping the mine protected (Law 13;
// Law 25). No site yet is told apart from a real read failure by ASKING for the locked site (as
// below), which surfaces the generator's throw directly (Law 16).
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
        // A tree standing in a cell the plan gives no log is a tree, not the staircase: protected, it is a
        // trunk the mouth's canopy job counts and the feller refuses forever.
        if (actual && TREE_LOGS.has(actual.name) && !TREE_LOGS.has(normalizeBlockName(v[3])) && v[3] !== 'log') continue;
      }
      set.add(`${v[0]},${v[1]},${v[2]}`);
    }
  }
  return set.size > 0 ? set : null;
}

module.exports = { scan, setDeepOpen, isDeepOpen, shaftFillNeed, scanSegmentSteps, getState, getProtectedBlocks, wallSatisfied };
