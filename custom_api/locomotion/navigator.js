// fragment: navigator
// purpose: The single locomotion rung. Receives from locomotion_dispatcher, resolves targets,
//          runs A* with inline blockAt queries, walks the annotated path step-by-step using
//          edge-type dispatch (walk, climb_up, climb_down, ...), and routes ONLY to
//          locomotion_judge (success or soft-fail). No 20Hz continuous drive — step-by-step
//          edge walking only. No fall/parkour: every descent is a reversible one-block move.
//
// THE EDGE SET IS DELIBERATELY CONSERVATIVE: there is no fall edge — every descent is a diagonal
// stair or a vertical dig_down, one reversible block at a time, so no step can commit the body to a
// drop it cannot undo (Law 17). 'pillar' is the only straight-up move, and A* prices a
// bore-through-ceiling pillar at PROTECTED_VOXEL_DETOUR_BUDGET so it is a last resort rather than a shortcut.
//
// CONTRACT: exits ONLY to locomotion_judge, success or soft-fail. Judge-to-judge is the only way out
// (Law 15); coding violations throw.

// ---------------------------------------------------------------------------
// SECTION 1: Dependencies
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const { performPlace } = require('@utils/movement/place_authority');
const watcher = require('@kernel/watcher');
const { performDig } = require('@utils/movement/dig_authority');
const { driveRun } = require('@utils/movement/drive');
const { microCenter } = require('@utils/movement/motion_primitives');
const { tryBridgeStep, pillarStep } = require('@utils/movement/scaffold_movement');
const { isNotSafeSurface, isOpenTopContainer, isStationFloor } = require('@utils/movement/terrain_predicates');
const { sleep, BLOCK_REACH } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { computeAStar, drainSearchCensus, pathStillWalkable, keyOf, straightLine, classifyFloorInline, isScaffoldBlock, isDoorBlock, COST_HIGH, COST_PLACE, PROTECTED_VOXEL_DETOUR_BUDGET, FLOW_DETOUR_BUDGET, LAVA_FLOW_DETOUR_BUDGET } = require('@utils/pathfinding_utils');
// The bus at MODULE SCOPE, which it could not be before 2026-09-10: the load cycle through
// fragment_registry forced this require inside a function in every routing file. This is one of the
// six FORWARDING routers — it calls route() with an upstream author's own from/to rather than building
// an envelope, so it cannot use signal_utils' helpers (they stamp `from` = the caller and would rewrite
// authorship). Every other fragment now has no contact with the bus at all.
const signalBus = require('@kernel/signal_bus');

// ---------------------------------------------------------------------------
// SECTION 2: Constants
// ---------------------------------------------------------------------------
// The navigator places bridge AND pillar blocks on one list, so it reads the gravity-filtered
// scaffold_block rather than pillar_block — the stricter of the two, because the list has to be legal
// for the bridge case it also serves (Law 17). Not structural_fill: that order is for permanent fill.
// This was a sixth hand-maintained copy of "what is a construction block"; the fifth is gone from
// pathfinding_utils, which this file also imports isScaffoldBlock() from. They now agree by
// construction rather than by someone remembering to edit both (Law 16). No `||` fallback for the same
// reason the other reads dropped theirs: the literal named cobblestone and logs, which this order now
// ranks LAST, so a missing group would have silently inverted the preference (Law 13, Law 16).
const BUILD_PREFS = [...require('@utils/fragment_utils').group_to_item.scaffold_block];
const ARRIVAL_TOLERANCE = 1.5;
// Near-goal unstick reach: how close to the goal a no-path result must be before the navigator
// treats it as a pinned dead spot (worth one step-away + re-plan) rather than a genuine long-range
// failure. See stepAwayFromGoal / the STEP-3 recovery.
const UNSTICK_RADIUS = 4.0;

// ── Pathfinding / replan configuration (single source of truth) ──────────────
// NO NODE BUDGET (Architect 2026-08-04: "remove the cap"). Every A* call here â initial plan, floor
// recovery, fail-replan, candidate retarget â runs uncapped and terminates on the goal popping or the
// frontier running dry at the edge of the loaded chunks. The history is why it had to go rather than
// shrink: the cap was 1500, and on a deep-mine cell the true all-walkable route (down the staircase, then
// along the already-mined corridor) needed more nodes than that to discover, so A* returned a
// distance-greedy PARTIAL that carved a diagonal shortcut and dead-ended at a room ceiling (live:
// TessaBot 62|13|-10). It was raised to 200000, which moved the same failure further out instead of
// removing it â and the failure recurred at 200005 nodes on a two-block move, 2026-08-04. A budget sized
// "past any real route" is a guess about terrain, and a guess that runs out reports "unreachable" for a
// place the bot can walk to. Uncapped is safe here for one specific reason: computeAStar cedes a
// macrotask every ~tick, so a long search never stalls the shared world (see voxel_scan_throttle).

// ── THE FIRST-MOVE SIGNAL (Architect 2026-09-03) ─────────────────────────────────────────────────────
// "the first first movement the bot does releases the lock. when it starts, it does a bunch of thinking
//  and not moving and when it starts moving then its done thinking... im a fan of dynamic scheduling
//  instead of timers."
//
// WHAT IT IS FOR. Starting a fleet all at once gets most of it kicked off the server: each bot is one
// event loop, a route search blocks it, and a bot silent for 30s is dropped by both the proxy and the
// server (architect_bugsquashing.md round 223 — 9 of 12 lost). The first fix was a 30-SECOND TIMER
// between starts, which worked and was rejected for the right reason: a timer prices every bot at the
// worst case, so a bot that finished thinking in four seconds still cost thirty.
//
// WHY *THIS* MOMENT IS THE RIGHT ONE, and it is not arbitrary. The expensive thing a starting bot does is
// the A* search — that is the CPU that starves its peers and blocks the event loop that must answer
// keep-alives. Walking the resulting path is nearly free: the body steps on a timer and the loop is idle
// between steps. So the instant a path EXISTS is the instant this bot stops being expensive, and it is
// therefore the honest moment to let the next one start. Announced here rather than at the first step
// taken, because the step is already on the far side of the cost.
//
// ONCE PER PROCESS, and deliberately not once per start. A bot that has already moved is a bot already
// past its planning burst, so a marker that is ALREADY PRESENT when the launcher looks is the correct
// answer — release immediately — and not a stale reading to be defended against.
//
// It is a summary() and not a warn(): nothing is wrong, and the level IS the interface for every machine
// that reads this trace (see the warn()-vs-error() note below, which is the same lesson).
const FIRST_MOVE_MARK = 'FIRST MOVE';
let firstMoveAnnounced = false;
function announceFirstMove(steps) {
  if (firstMoveAnnounced) return;
  firstMoveAnnounced = true;
  watcher.summary('navigator',
    `${FIRST_MOVE_MARK} — planning finished, body is walking a ${steps}-step route. ` +
    `This bot is past the expensive part of its start; whatever is waiting on it may go now.`);
}

// NAV_SLOW_PLAN_MS — a performance TRIPWIRE, never a gate. It exists to make one deferred decision
// announce itself: we chose NOT to pre-build the two-hop staircase→corridor waypoint approach, since it
// may only ever be needed in some areas as the base grows. A search crossing this line is the evidence
// that waypointing may be warranted THERE. Set well above the worst measured under load (~0.6s idle) so
// it does not false-fire.
//
// WHY warn() AND NOT error() — do not re-promote this to be "louder". It WAS error() for one day,
// borrowed as the loud channel because error() forwards to the overseer and trips wake-on-error. That
// broke the attended loop within 8 minutes on 2026-07-20: a non-fatal error is PERMANENT in the trace
// and --watch wakes on errors at ANY index, so every re-arm re-woke on the same historical tripwire,
// forever, with no new event. The root fault was a category error (Law 26) — the prose said "NON-FATAL,
// BOT CONTINUING" but trace_monitor is a machine consuming a LEVEL, not a sentence. The level IS the
// interface; a thing said only in the prose is not said. Loudness is already covered honestly by
// warn-burst (5/60s) and warn-repeat (3x identical).
//
// DISTANCE IS NOT THE ONLY TRIGGER — do not read a trip as "this area got big" without checking.
// Measured 2026-07-20: 44.8s / 163,850 nodes for a TWO-BLOCK hop, (19,64,-18) → (21,64,-18), identical
// on both bots. The goal had just been dug out and was effectively enclosed, so A* exhausted a huge
// space to reach a cell 2 blocks away. Slow over a SHORT hop means a near-unreachable goal, not a large
// area — waypointing would not have helped it.
const NAV_SLOW_PLAN_MS   = 3000;   // route-search wall-time over this → wake-the-operator error, bot continues

// NAV_SEARCH_DEADLINE_MS — the bound on how long a BODY may stand still, which is the one bound the
// uncapped search above still owes (Architect 2026-08-06). Read the NO-NODE-BUDGET note above first:
// none of it is retracted here. A node cap is a guess about TERRAIN and this is not one — it is a clock,
// the third terminator pathfinding_utils already names as legitimate ("a bound the WORLD imposed... how
// long a body may stand still"), and locomotion was simply never given one.
//
// WHY IT WAS NEEDED — the negative proof is unbounded in wall time. A search that SUCCEEDS is cheap
// because the heuristic drives straight at the goal (measured this run: 5ms/57 nodes, 599ms/204 nodes).
// A search that must answer "no route" cannot stop until the frontier runs dry across the whole loaded
// region, and that is hundreds of thousands of nodes however near the goal is. The 44.8s/163,850-node
// two-block hop recorded above is the SAME event surviving the 2026-08-04 uncap — the cap was the only
// thing bounding it, and removing the cap removed the ceiling without replacing it. Live 2026-08-06:
// TessaBot entered one goTo of FOUR blocks, (-1,70,6) → (-1,70,2), and was still inside it 10 minutes
// later holding 1,045 MB and 98% of a core, having emitted nothing since. It would have OOM'd, not
// finished.
//
// WHAT THIS RESTORES, and it is not "make pathfinding better": the JUDGE. Law 15 obliges a sub-loop API
// that cannot deliver to abandon to the judge; Law 11 puts one judge on the loop to notice the gap has
// stopped shrinking; Law 8 says the lifecycle terminates with its owner. All three are already built and
// all three were unreachable, because none of them gets control until the search returns. The deadline
// does not decide whether the goal is reachable — it hands the question back to the machinery that
// already exists to answer it. NAV_SLOW_PLAN_MS cannot cover this: it is read AFTER the search returns
// (see the tripwire below), so the one case it most needed to catch is the case it structurally cannot see.
//
// SIZED SO IT CAN NEVER CUT A SEARCH THAT WOULD HAVE SUCCEEDED — that is the whole risk, since a
// premature stop is what made the old cap return the dead-end diagonal. The clearance is measured, not
// assumed: `trace_monitor.js --route-cost` prints a DEADLINE EVIDENCE section giving p50/p90/p99 and the
// worst search that actually FOUND a route, and this constant is set from that worst figure. Re-read it
// after any change to the cost model — lowering a cost tier shrinks the expansions a successful search
// makes, which moves this floor down with it, and a deadline left at the old floor is not conservative,
// it is a body standing still for the difference.
//
// WHY GENEROSITY HERE IS NOT FREE, which is the half that reads as safe and is not. A deadline is only
// ever spent by a search that FAILS to find a route in time, and the failing case is the unreachable
// goal — so every millisecond of headroom past the successful worst case is paid ENTIRELY by trips that
// were never going to arrive, as a body frozen in the world while the frontier drains. The cost is not
// the search's CPU, it is the standing still (that is what this constant bounds), so the correct size is
// the smallest that clears real successes rather than the largest that feels safe.
//
// On expiry the search returns its best PARTIAL toward the goal with timedOut+complete:false (never a
// false "unreachable"), so the walker still makes progress and the verdict stays honest (Law 25).
//
// NOT APPLIED to planRouteForTest: that oracle measures rather than walks, and a clock there would
// abandon a measurement to the judge — the same exemption combat_navigator takes for its combat gate.
const NAV_SEARCH_DEADLINE_MS = 5000;

function isOnCorrectSide(botFeet, targetPos, side) {
  const dx = botFeet.x - Math.floor(targetPos.x);
  const dz = botFeet.z - Math.floor(targetPos.z);
  if (dx === 0 && dz === 0) return false;
  const dominant = Math.abs(dx) > Math.abs(dz)
    ? (dx > 0 ? 'east' : 'west')
    : (dz > 0 ? 'south' : 'north');
  return dominant === side;
}

const round1 = (n) => Math.round(n * 10) / 10;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// CARVE_EDGES — the edge types that DIG or PLACE terrain to make a step passable (vs. a plain walk/climb
// over ground that already exists). Every carve the navigator performs on a trip is recorded and posted in
// ONE aggregated line at exit (flushCarves), so "why is the bot digging around the build area" is
// answerable from the trace alone (Architect 2026-07-18: "whenever digging or placing is required in
// navigator, it must declare that edge as visible for inspection"). Law 5: aggregated per trip, never a
// per-step log. NOTE the ledger keys off the A* EDGE LABEL, not the block actually broken — a 'walk' edge
// whose floor turned out to be air and got bridged at execution is not counted; the labeled carve edges
// (which are the "it chose to dig" signal) are.
const CARVE_EDGES = new Set(['dig_through', 'dig_down', 'bridge', 'pillar', 'dig_climb_up', 'dig_climb_down']);

// ── THE LOOKAHEAD (Architect 2026-08-01) ─────────────────────────────────────────────────────────
// "right now the bot go to edge of block. stops, then jump moves forward."
//
// It does, and the stop was never in the walking — it is in the SEAM BETWEEN EDGES. Each edge primitive
// releases `forward` in its `finally`, so the body decelerates to zero at every cell boundary no matter
// how walkable the next one is. The fix is therefore not a second, faster mover; it is reading further
// ahead before handing cells to the one mover there is.
//
// THE TIER IS LOOKAHEAD DEPTH, NOT SPEED. Depth 1 is today, edge for edge. Depth 3 is what makes
// sprinting worth anything (sprint needs runway to reach speed, and a body that stops each cell never
// gets there). Parkour is depth n over the same code. That is why there is no "battle movement" system
// beside this one: they would be the same walker at two settings, which is exactly the redundant route
// Law 16 forbids.
//
// DEFAULT 3, RATIFIED ON MEASUREMENT (Architect 2026-08-01). It shipped at 1 so the layer changed no
// trip until an A/B settled it; the A/B settled it. Same course, same body, three legs each:
//   staircase_up   la1 3677ms   la3 3453ms   la3np 2854ms
//   flat_run       la1 3594ms   la3 2433ms   la3np 2460ms
// Fusing is worth 22–32%. The prejump arm is within noise of the no-prejump arm (3076 vs 2893ms over
// five legs, OVERLAPPING ranges) and stays on because it is the arm with arithmetic behind it —
// prejump-off is a held button that happens to bunny-hop, and it cannot tell a clearable step from an
// unclearable one. Anything wanting the old walk asks for a run of one.
//
// ONLY ALREADY-PASSABLE CELLS FUSE. A 'walk' edge may still turn out to need a bridge or a dig at
// execution time, and a body still moving through a cell it is placing the floor of builds underneath
// itself. So the run is re-sensed cell by cell before it is taken (Invariant B) and hands straight back
// to the per-edge switch the moment a cell is not already walkable — the carve keeps its one route.
// Mutable rather than a constant so the A/B is one operator argument on a LIVE bot. A restart-only dial
// would make comparing depths a fleet restart apiece, and the two runs would then differ by more than
// the dial — which is not a comparison.
let RUN_LOOKAHEAD = 3;
// SEPARATE FROM THE DEPTH, because the first live A/B could not tell them apart. Fusing cells and
// jumping early are two independent changes that shipped together, and depth 3 came back slower than
// depth 1 on both courses — with no way to say which half cost the time. One dial cannot answer a
// two-variable question, so there are two.
let RUN_PREJUMP = true;
const RUNNABLE_EDGE_TYPES = new Set(['walk', 'climb_up', 'climb_down']);
const RUN_LOOKAHEAD_DEFAULT = 3;
function setRunLookahead(n) {
  const v = Math.max(1, Math.min(8, Math.floor(Number(n) || RUN_LOOKAHEAD_DEFAULT)));
  RUN_LOOKAHEAD = v;
  return v;
}
function getRunLookahead() { return RUN_LOOKAHEAD; }
function setRunPrejump(on) { RUN_PREJUMP = !!on; return RUN_PREJUMP; }
function getRunPrejump() { return RUN_PREJUMP; }
// edgeHistogram — compact "type×n, type×n" of a path's edges. Tags the A* plan line so the plan DECLARES
// up front which of its steps carve vs. walk — the plan's carve INTENT, before the walk proves what it cut.
function edgeHistogram(path) {
  const h = {};
  for (const s of path) h[s.edgeType] = (h[s.edgeType] || 0) + 1;
  return Object.entries(h).map(([t, n]) => `${t}×${n}`).join(', ');
}

const buildingIntegrity = require('@perception/building_integrity');
const miningIntegrity   = require('@perception/mining_integrity');
const miningCellGraph   = require('@perception/mining_cell_graph');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');

// ── No peer movement de-confliction (Law 19) ─────────────────────────────────
// There is deliberately NO bot↔bot movement de-confliction here. mineflayer clients have no
// player↔player collision — two bots pass straight through each other and can share one cell — so
// routing A* around a peer, or making bots take turns at a doorway, would simulate a constraint
// that does not bind the machine (Law 19: don't engineer human-embodiment behavior a machine peer
// doesn't need). The old peer-cell A* blacklist + doorway seniority hierarchy were removed for that
// reason, and because the blacklist actively caused a stall (it blanked a co-located bot's own A*
// start). Resource contention is handled where it belongs — the claim arbiter (trees/cells/anchors),
// not pathing. Bot↔HUMAN collision IS real and will need its own handling, but that's a separate
// problem for when players share the world, not built ahead of need.
//
// A terrain-only "don't enter a 1-wide passage without a clear exit" gate once lived here too. It
// was removed: a mineflayer bot backs straight out of a dead-end passage (no momentum, no
// collision), so the gate guarded a non-hazard while false-firing on incidental terrain pinch
// points — vetoing legitimate steps into blacklist→replan churn and warning spam at every doorway.
// Real movement hazards (falls, lava) are absent from A* by cost, not policed here (Law 17 binds
// the planner). A door is just another step now.

// PROTECTED_SOURCES — every subsystem that owns built voxels, each answering for its OWN (Law 16 /
// Invariant D: one voxel, one owner). This list is the single inspection point for "what does the
// bot refuse to chew through"; a new integrity node joins by adding one line here.
// Each source takes `bot` so it can SENSE rather than recite its plan — see loadProtectedBlocks.
const PROTECTED_SOURCES = [
  ['buildings', (bot) => buildingIntegrity.getAllProtectedBlocks(bot)],  // EVERY locked blueprint, not just headframe
  ['staircase', (bot) => miningIntegrity.getProtectedBlocks(bot)],
  // mining_cell_graph has no world-diff of its own yet, so it still answers from plan alone. Its cells
  // are therefore over-protected exactly as everything was before 2026-07-20 — safe, not free.
  ['cells',     ()    => miningCellGraph.getProtectedBlocks()],
];

// loadProtectedBlocks — one "x,y,z" key Set of every non-air voxel the bot has built or plans to.
// A* charges PROTECTED_VOXEL_DETOUR_BUDGET to dig OR cover one — near-forbidden but finite, so the bot uses the
// door/stairs and only breaks through if truly entombed.
//
// WHY every source is enumerated and NONE of them is guarded: this stood as three stacked `catch (_) {}`
// over a possibly-null set, so a source that failed meant "nothing is protected" and A* went back to
// pricing walls at COST_HIGH (25) with nothing on disk to say it had happened — protection failing OPEN
// and SILENT, the inverse of Law 13. The sources are our own perception nodes and each absorbs its own
// environmental failure, so a throw escaping one is a defect; it now travels and stops the bot rather
// than quietly deleting a category of protected voxel for the rest of the run. A null/empty source is a
// different thing entirely and is NOT a fault: pre-lock there is genuinely nothing to protect.
//
// The set is also built by ENUMERATION, never by naming one blueprint: asking for a blueprint by name
// protects the one someone remembered and leaves every sibling in the same conference room unprotected.
//
// PROTECTED = BUILT, NOT PLANNED. Sources used to answer from the blueprint alone, so a cell of virgin
// terrain was priced at the full PROTECTED_VOXEL_DETOUR_BUDGET — and A* must examine every route cheaper
// than that budget before returning one, which turned short hops into whole-region floods. Passing `bot`
// makes each source diff against the world, so the budget means "this destroys finished work", not
// "someone intends to build here one day". Cheap enough per plan against the searches it prevents, and
// the Set is built ONCE per invocation and reused across replans.
function loadProtectedBlocks(bot) {
  const set = new Set();
  for (const [, read] of PROTECTED_SOURCES) {
    const keys = read(bot);
    if (keys) for (const key of keys) set.add(key);
  }
  // Fresh Set, never a source's own — the old merge added mining's keys INTO the object
  // building_integrity handed back, mutating another node's return value (Invariant D).
  return set.size > 0 ? set : null;
}

// ---------------------------------------------------------------------------
// SECTION 3: Target resolution helpers
// ---------------------------------------------------------------------------

function validCoordinate(c) {
  return !!c && ['x', 'y', 'z'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k]));
}

function resolveTargets(capsule) {
  if (validCoordinate(capsule.coordinate)) {
    const c = capsule.coordinate;
    return [{ name: 'goal', position: { x: c.x, y: c.y, z: c.z } }];
  }
  return readCandidates(capsule.candidates_ref);
}

function readCandidates(ref) {
  let data;
  if (ref === 'surface_filter') {
    const surfaceFilter = require('@perception/surface_filter');
    data = surfaceFilter.getLastScan();
    if (!data) throw new Error(`[navigator] CODING VIOLATION: surface_filter has no scan results in memory.`);
  } else {
    const file = path.resolve(__dirname, '../../js_kernel/', ref);
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const objectives = Array.isArray(data?.objectives) ? data.objectives : [];
  const cleaned = objectives
    .map(o => ({ name: o?.name || 'candidate', position: o?.position }))
    .filter(o => validCoordinate(o.position))
    .map(o => ({ name: o.name, position: { x: o.position.x, y: o.position.y, z: o.position.z } }));
  if (!cleaned.length) {
    throw new Error(`[navigator] CODING VIOLATION: candidate ref '${ref}' resolved to zero valid targets.`);
  }
  return cleaned;
}

function pickNearest(botFeet, targets) {
  let best = targets[0];
  let bestD = straightLine(botFeet, best.position);
  for (let i = 1; i < targets.length; i++) {
    const d = straightLine(botFeet, targets[i].position);
    if (d < bestD) { bestD = d; best = targets[i]; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// SECTION 4: Arrival predicate
// ---------------------------------------------------------------------------

function arrived(feet, target) {
  return dist(feet, target) <= ARRIVAL_TOLERANCE;
}

// exactFeetCell — the floored feet cell an exact-mode caller demands the bot occupy.
function exactFeetCell(target) {
  return new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
}

// closeToExactCell: exact-arrival final approach. A* + the walk leave the bot within
// ARRIVAL_TOLERANCE (1.5) of the goal, but exact-mode callers (anchored builds) need the
// FEET on the target cell — reach in anchored_repair is measured from the microCentered
// stand block, so a 1-block offset puts far voxels out of reach.
//
// Two closers, ordered: (1) close the horizontal gap FIRST, at the bot's current Y, nudging
// onto the target's column via stepToFeet; (2) once aligned in x,z, if the bot is BELOW the
// target, pillar straight up onto it. Case (2) is the Architect's "the bot should have pillared"
// case: an exact stand that sits ON TOP of an anchor floor block the build hasn't placed yet —
// the target feet cell has no floor, so the only way onto it is to build the block underfoot
// and rise (reusing pillarStep, the same primitive the pillar edge and farm footing use). A gap
// taller than PILLAR_MAX, or the bot ABOVE the target, is a genuine path shortfall left to the
// Step-6 arrival check (no_progress / closer_but_not_arrived), not a footing tweak.
// digIfObstructing: an exact-mode caller demands the bot OCCUPY the target cell, so a non-hazard
// solid squatting in its feet or head cell (oak_leaves from a tree grown over the footprint, a
// sapling, a stray log) has to come out — the closer only steps and pillars, it never dug, so
// without this it stalls forever on foliage (the tree-in-the-headframe-footprint stall that killed
// AurenBot). Law 17: never dig a hazard — isNotSafeSurface gates lava/fire/cactus/cobweb/etc. out;
// clearing a leaf from the cell the bot is about to stand IN causes no self-injury (the bot isn't
// there yet). protectedBlocks guards an active blueprint's intended voxels so the navigator can't
// carve a real build block even if a caller mistargets a solid stand cell (Law 16 — the build owns
// its blocks). Returns true only when it actually removed something.
async function digIfObstructing(bot, pos, protectedBlocks) {
  const b = bot.blockAt(pos);
  if (!b || b.name === 'air' || b.boundingBox === 'empty') return false;   // already clear/passable
  if (isNotSafeSurface(b)) return false;                                   // hazard — leave it (Law 17)
  if (protectedBlocks && protectedBlocks.has(`${pos.x},${pos.y},${pos.z}`)) return false; // blueprint voxel
  const dug = await performDig(bot, pos, b, 'navigator');
  if (dug) watcher.summary('navigator', `Cleared ${b.name} obstructing exact target cell (${pos.x},${pos.y},${pos.z}).`);
  return dug;
}

const PILLAR_MAX = 3;
async function closeToExactCell(bot, feetCell, protectedBlocks) {
  const headCell = feetCell.offset(0, 1, 0);
  for (let i = 0; i < 8; i++) {
    const cur = bot.entity.position.floored();
    if (cur.equals(feetCell)) return true;
    const dxz = Math.max(Math.abs(cur.x - feetCell.x), Math.abs(cur.z - feetCell.z));
    // Within reach of the target column: clear any non-hazard solid squatting in the feet/head
    // cell so the step/pillar below can actually enter it (foliage in the footprint otherwise
    // blocks the closer indefinitely). A hazard is left in place for the judge to route around.
    if (dxz <= 1) {
      await digIfObstructing(bot, feetCell, protectedBlocks);
      await digIfObstructing(bot, headCell, protectedBlocks);
    }
    if (dxz > 0) {
      if (dxz > 1) return false;                       // >1 block horizontal: genuine path shortfall
      // Step onto the target's column at the CURRENT Y (below-target case), or straight onto the
      // cell when already level. Reduces the gap to a pure vertical the pillar branch then closes.
      const onColumn = cur.y === feetCell.y ? feetCell : new Vec3(feetCell.x, cur.y, feetCell.z);
      await stepToFeet(bot, onColumn, { timeoutMs: 1200 });
      continue;
    }
    if (cur.y < feetCell.y) {                          // aligned and below → pillar onto the target
      if (feetCell.y - cur.y > PILLAR_MAX) return false;
      const res = await pillarStep(bot);
      if (!res || !res.success) return false;
      continue;
    }
    return false;                                      // aligned but above the target: shortfall
  }
  return bot.entity.position.floored().equals(feetCell);
}

// describeCell / reportTargetFooting — on a navigation give-up, say WHAT is at the target so the
// failure is diagnosable from the trace alone (Architect: "report why it can't navigate by telling
// us what is at the target coordinate"). The feet cell must be passable and the block below it
// solid; logging all three (head/feet/floor) turns an opaque "no_progress" into "target floor is
// air — nothing to stand on" at a glance (Law 5 observability).
// No guard: blockAt ANSWERS for an unloaded column (null) instead of throwing, so the only throw it
// could raise is our own bad Vec3 — a defect that must travel (Law 13).
function describeCell(bot, pos) {
  const b = bot.blockAt(pos);
  if (!b) return 'unloaded';
  const box = b.boundingBox === 'block' ? 'solid' : b.boundingBox === 'empty' ? 'passable' : b.boundingBox;
  return `${b.name}(${box})`;
}
// diagnoseGiveUp — the give-up post-mortem. reportTargetFooting used to say only WHAT sits at the
// target; this answers the three questions a near-goal give-up kept hiding (Architect: "I want to
// know the edges it tried"):
//   1. TARGET FOOTING    — floor/feet/head at the goal (is there anything to stand on, or is it void?).
//   2. PILLAR/BRIDGE FUEL — construction blocks carried. The pillar AND bridge edges are gated on
//      hasBlocks, so an empty inventory silently deletes every vertical and gap-crossing edge — "it
//      should have pillared" is impossible with 0 blocks, and A* then burns its whole node budget
//      finding no route across a void it cannot bridge.
//   3. WHAT A* TRIED     — one fresh A* from the bot's current floor with the trace sink wired to the
//      watcher, exposing the edges generated near the goal (incl. the new PILLAR/BRIDGE emit+skip
//      lines) and whether the NODE budget was exhausted. The only limit is node count — there is NO
//      total-path-cost cap — so "EXHAUSTED" means "ran out of nodes to expand", never "path too
//      expensive". Reuses computeAStar's trace facility (Law 5 observability, Law 16 one edge model).
async function diagnoseGiveUp(bot, targetPos, reason, goal, protectedBlocks) {
  const feet  = new Vec3(Math.floor(targetPos.x), Math.floor(targetPos.y), Math.floor(targetPos.z));
  const floor = feet.offset(0, -1, 0);
  const head  = feet.offset(0, 1, 0);
  const p = bot.entity.position.floored();
  const fuel = (bot.inventory?.items?.() || []).reduce((n, i) => n + (i.count > 0 && isScaffoldBlock(i.name) ? i.count : 0), 0);
  watcher.warn('navigator',
    `give-up (${reason}) at (${p.x},${p.y},${p.z}) — target (${feet.x},${feet.y},${feet.z}): ` +
    `floor below=${describeCell(bot, floor)}, feet=${describeCell(bot, feet)}, head=${describeCell(bot, head)}. ` +
    `Pillar/bridge fuel: ${fuel} block(s)${fuel === 0 ? ' — vertical & gap edges DISABLED' : ''}.`);
  // No guard on the replay: it runs the SAME computeAStar the trip ran, and that is our code — a throw
  // here means the pathfinder is broken, which is the largest possible finding of a post-mortem and the
  // last thing that should be reduced to one warn line and walked past (Law 13).
  const lines = [];
  const r = await computeAStar(bot, p.offset(0, -1, 0), goal, {
    protectedBlocks,
    deadlineMs: NAV_SEARCH_DEADLINE_MS,
    // Billed separately from the trip's own searching: this replay is the POST-MORTEM, not work the
    // navigation did to get anywhere, and folding it into `navigate` inflates the cost of exactly the
    // trips that already failed — the ones whose numbers get read hardest.
    owner: 'diagnostic',
    trace: (_lbl, msg) => { if (lines.length < 60) lines.push(msg); },
  });
  const cutOff = !!(r && r.complete === false);
  watcher.warn('navigator',
    `A* post-mortem: ${r ? r.nodesVisited : '?'} nodes` +
    // The only distinction worth making in a post-mortem, now that there is no node budget to blame:
    // a dry frontier is a VERDICT (nothing reachable), a cut-off search is not one and must never be
    // read as such — all it established is a price floor (Law 25).
    `${cutOff ? ` CUT OFF (no verdict — established only that nothing costs less than ${round1(r.provenBound || 0)})` : ' (frontier ran dry — there is genuinely no reachable edge)'}` +
    `${r && r.partial ? `, best ${round1(r.residual)} blocks short` : ''}. Edges tried:\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------------------
// SECTION 5: Step execution functions (edge-type walkers)
// ---------------------------------------------------------------------------

function chooseBuildBlock(bot) {
  const items = bot.inventory?.items?.() || [];
  for (const name of BUILD_PREFS) { const it = items.find(i => i.name === name && i.count > 0); if (it) return it; }
  return null;
}

// stepToFeet: walk (and optionally jump) until the bot's feet occupy the target cell.
// Arrival requires onGround — a mid-air position during a jump arc is not arrival.
// Without this gate, the bot passes through the target Y mid-jump, reports success,
// then falls back down to a lower resting position.
//
// THIS IS A RUN OF ONE (Architect 2026-08-01). The walking loop it used to own verbatim now lives in
// driveRun, and a single cell with strictFinal and no prejump IS that loop — same centre tolerance, same
// grounded-arrival test, same 50ms poll. Kept as one implementation on purpose (Law 16): a separate
// "careful" walker beside a "smooth" walker is two routes to the same capability, and they would drift
// the first time only one of them got a fix.
async function stepToFeet(bot, feetCell, opts = {}) {
  // opts.stallMs is passed STRAIGHT THROUGH, including `null` — that is the door step's stall waiver
  // (drive.js explains why one caller gets it). `undefined` stays undefined so driveRun applies its own
  // default; this must not coalesce, or every caller would silently inherit the waiver.
  const r = await driveRun(bot, [feetCell], { timeoutMs: opts.timeoutMs || 1500, strictFinal: true, stallMs: opts.stallMs });
  return r.arrived || (bot.entity.onGround && bot.entity.position.floored().equals(feetCell));
}

// stepAwayFromGoal — the navigator's near-goal unstick. A* expands only toward lower cost, so it
// never tries stepping BACKWARD first even when retreating one cell is the only way forward: the
// classic trap is the bot pinned directly UNDER a protected overhang (the headframe pier), where
// every cheap move up is a protected voxel A* won't carve, so it returns no path from that exact
// cell though two of the three approaches are open. This steps the bot to a safe adjacent floor
// pointing AWAY from the goal (never toward it — that is the dead spot), so the NEXT A* plans from
// open ground with the side-approach available ("go away a little, then swing around" — Architect).
// Same-Y lateral step, reuses stepToFeet; returns true only if the bot actually changed cells.
async function stepAwayFromGoal(bot, goalPos) {
  const feet = bot.entity.position.floored();
  const awayX = Math.sign(feet.x - Math.floor(goalPos.x));   // +1 ⇒ retreat toward +x
  const awayZ = Math.sign(feet.z - Math.floor(goalPos.z));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const awayScore = ([dx, dz]) => dx * awayX + dz * awayZ;   // >0 away, <0 toward, 0 perpendicular
  dirs.sort((a, b) => awayScore(b) - awayScore(a));
  for (const [dx, dz] of dirs) {
    if (awayScore([dx, dz]) < 0) continue;                   // never step toward the goal
    const floorBlock = bot.blockAt(new Vec3(feet.x + dx, feet.y - 1, feet.z + dz));
    if (!classifyFloorInline(bot, floorBlock)) continue;     // not a safe standable floor + clear feet/head
    // This retreat leaves the body parked where it lands, so it is an endpoint under the same rule the
    // route search applies to its goal — an unstick that ends on a chest has swapped one bad stance for
    // another. Not applied to escapeLandings: escaping a bin the body cannot climb out of outranks a
    // tidy stance (Law 17), and there the alternative is staying stuck.
    if (isStationFloor(floorBlock)) continue;
    const dest = new Vec3(feet.x + dx, feet.y, feet.z + dz);
    await stepToFeet(bot, dest, { timeoutMs: 1200 });
    if (!bot.entity.position.floored().equals(feet)) return true;
  }
  return false;
}

// ── THE FOOTING GUARD'S ONE DEFINITION OF "STUCK" ───────────────────────────────────────────────────
// badFooting(bot) → a reason string, or null when the body is standing somewhere it can walk out of.
//
// ONE function because the guard below asks this question TWICE — to decide whether to act, and to decide
// whether its action worked — and two separately-written versions would let it declare a recovery it had
// not made (Law 25: the verdict is measured against the criterion that opened the work, never a looser one
// substituted at the end). That is not hypothetical: the recovery used to re-check only "is there support
// under me", which is true for a body still sitting in a composter with planks beneath the bin.
//
// Two ways to be stuck, and the second is why this exists at all:
//   no_support — nothing solid underfoot (the original case: perched on a door, hovering).
//   inside_X   — the feet cell is an open-top container. The block BELOW is perfectly solid, so the
//                original test read this as healthy footing while the body was walled in on four sides.
function badFooting(bot) {
  const feet = bot.entity.position.floored();
  const feetBlock = bot.blockAt(feet);
  if (feetBlock && isOpenTopContainer(feetBlock)) return `inside_${feetBlock.name}`;
  const support = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
  if (!support || support.boundingBox === 'empty') return 'no_support';
  return null;
}

// escapeLandings(bot) → feet cells the body may legally end up in, cheapest first: the four same-level
// neighbours, then the four one step up.
//
// SCANNED, NEVER GUESSED — a jump aimed at a wall spends the recovery and leaves the body where it was,
// and from inside a bin there is no second chance to notice. Every candidate is put through
// classifyFloorInline, the SAME verdict A* plans with (Law 16), so a landing this accepts is one the
// pathfinder would also stand on: standable floor, clear feet, clear head. Level-first because the body
// only has to clear the rim it is behind, not gain a block as well.
function escapeLandings(bot) {
  const feet = bot.entity.position.floored();
  const out = [];
  for (const dy of [0, 1]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const floorCell = new Vec3(feet.x + dx, feet.y - 1 + dy, feet.z + dz);
      if (!classifyFloorInline(bot, bot.blockAt(floorCell))) continue;
      out.push(floorCell.offset(0, 1, 0));
    }
  }
  return out;
}

// jumpOutStep — the only edge that leaves a cell rather than entering one. The body is standing in an
// open-top container (composter, cauldron); its feet cell IS the bin, and the rim is a full block above
// the inner floor it is resting on — over the 0.6 auto-step, so `forward` alone only presses it into the
// wall. Jump is HELD rather than tapped for the whole crossing: releasing it on a fixed timer would put
// the release before or after the moment the body is over the rim depending on tick alignment, and a
// held jump simply re-hops until the step lands.
//
// No dig, no bridge, no place: the destination is a floor A* already classified standable (a jump_out is
// generated only from the start node and only onto a normal walk destination), so this verb is "get the
// body out and onto it" and nothing else (Law 0). Everything else it might need is stepToFeet's, which is
// driveRun — the one mover (Law 16).
async function jumpOutStep(bot, feetTarget) {
  bot.setControlState('jump', true);
  // withCleanup, not a guard: nothing here is caught. The hold must be released on every exit — landed,
  // timed out, or a throw out of the mover — or the body keeps hopping through whatever runs next.
  return await withCleanup('navigator', 'jump-out hold', () => stepToFeet(bot, feetTarget, { timeoutMs: 3000 }),
    () => { bot.setControlState('jump', false); });
}

async function bridgeLevelStep(bot, dir) {
  const feet = bot.entity.position.floored();
  const overFeet = new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z);
  const overFloor = bot.blockAt(overFeet.offset(0, -1, 0));
  if (!overFloor || overFloor.name === 'air' || overFloor.boundingBox === 'empty') {
    const r = await tryBridgeStep(bot, dir.x, dir.z);
    if (!r || !r.success) return false;
  }
  for (const c of [overFeet, overFeet.offset(0, 1, 0)]) {
    const b = bot.blockAt(c);
    if (b && b.name !== 'air' && b.boundingBox !== 'empty') {
      await performDig(bot, b.position, b, 'navigator');   // one dig route — equips + verifies (Law 16); never throws
    }
  }
  return await stepToFeet(bot, overFeet);
}

async function stairUpStep(bot, dir) {
  const feet = bot.entity.position.floored();
  const foundationPos = new Vec3(feet.x + dir.x, feet.y - 1, feet.z + dir.z);
  const treadPos = new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z);
  const upFeet = new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z);
  const solid = (b) => b && b.name !== 'air' && b.boundingBox !== 'empty';

  for (const c of [feet.offset(0, 2, 0), treadPos.offset(0, 1, 0), upFeet.offset(0, 1, 0)]) {
    const b = bot.blockAt(c);
    if (solid(b)) await performDig(bot, b.position, b, 'navigator');   // one dig route (Law 16)
  }

  let foundation = bot.blockAt(foundationPos);
  if (!solid(foundation)) {
    const r = await tryBridgeStep(bot, dir.x, dir.z);
    if (!r || !r.success) return false;
    foundation = bot.blockAt(foundationPos);
    if (!solid(foundation)) return false;
  }

  let tread = bot.blockAt(treadPos);
  if (!solid(tread)) {
    const item = chooseBuildBlock(bot);
    if (!item) return false;
    // The one place route (Law 16) owns equip, the spawn-protection gate, the combat checkpoint, the
    // sneak and its guaranteed release, the aim and the click.
    //
    // sneak: true rather than 'auto' — the crouch here holds the body on the block it is stepping UP
    // from, which is a fact about the MOVE; the authority's 'auto' asks what the anchor is, which is the
    // right question for a builder and the wrong one for a climber.
    //
    // The gate buys no correctness at this particular site — the world-read below would already report
    // no tread and give up — it buys a NAMED cause. Without it the trace says "stair tread did not
    // appear" for ground the fleet is simply not allowed to build on, which reads as a placement bug
    // (Law 13). A* already declines to route a place edge into the square, so it fires only for a step
    // the search did not author.
    await performPlace(bot, treadPos, foundation, new Vec3(0, 1, 0), item.name, 'navigator', { sneak: true });
    // The place result is not read: the world is asked instead, because a server that accepted the packet
    // and a server that dropped it are told apart by what is standing there, not by the call returning.
    tread = bot.blockAt(treadPos);
    if (!solid(tread)) return false;
  }

  return await stepToFeet(bot, upFeet);
}

async function stairDownStep(bot, dir) {
  const feet = bot.entity.position.floored();
  const downFeet = new Vec3(feet.x + dir.x, feet.y - 1, feet.z + dir.z);
  const landBlock = bot.blockAt(downFeet.offset(0, -1, 0));
  if (!landBlock || landBlock.name === 'air' || landBlock.boundingBox === 'empty') return false;
  for (const c of [new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z), downFeet, new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z)]) {
    const b = bot.blockAt(c);
    if (b && b.name !== 'air' && b.boundingBox !== 'empty') {
      await performDig(bot, b.position, b, 'navigator');   // one dig route — equips + verifies (Law 16); never throws
    }
  }
  return await stepToFeet(bot, downFeet);
}

// digThroughStep: dig foot+head blocks at the wall in the given direction, then walk through.
async function digThroughStep(bot, dir) {
  const feet = bot.entity.position.floored();

  // Refuse to dig while in water — extremely slow and unreliable.
  const feetBlock = bot.blockAt(feet);
  if (feetBlock && (feetBlock.name === 'water' || feetBlock.name === 'flowing_water')) return false;

  const footPos = new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z);
  const headPos = new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z);
  const solid = (b) => b && b.name !== 'air' && b.boundingBox !== 'empty';

  for (const pos of [footPos, headPos]) {
    const b = bot.blockAt(pos);
    if (solid(b)) {
      await performDig(bot, b.position, b, 'navigator');   // one dig route — equips + verifies (Law 16); never throws
    }
  }
  await sleep(100);
  return await stepToFeet(bot, footPos);
}

// digDownStep: dig the floor block directly below the bot's feet and drop EXACTLY one block.
// Safe-descent gate (Law 17, Architect 2026-07-14): a vertical dig-down is legal only when
//   (a) the feet cell is safe — not standing in a liquid;
//   (b) the block being dug (feet-1) is a real solid, not a hazard we'd breach into;
//   (c) the landing one below it (feet-2) is a safe solid — so the drop is exactly one block and
//       never a 2-block fall into a cavity nor a plunge into lava;
//   (d) no side of the hole is a liquid/hazard that would flood or burn in.
// isNotSafeSurface is the single shared hazard gate (Law 16) — it flags water, lava, fire, cactus,
// etc., and (Law 13) reads a null/unloaded block as unsafe. It checks feet-1, feet-2, and the four
// sides; nothing deeper (the next block down is the NEXT step's landing, re-sensed then — Invariant B).
// describeDoor — a door cell's name and open/shut state, as one phrase for a trace line.
//
// WHY THIS LIVES HERE AND NOT WITH THE OPENER. `survival_instincts.doorHandlerTick` is what opens and
// closes doors, and it has done since it was written — its own history shows exactly one change, the
// commit that created it. It is declared ATOMIC in its header ("No watcher, no signal_bus, no file
// I/O"), so it cannot say whether it fired, and honouring that contract is why the witness sits on
// this side of the seam instead. The predicate comes from pathfinding_utils rather than a third copy
// of the door-name list — the same one the route search mints the edge with, so the reader and the
// planner cannot disagree about what a door is (Law 16).
function describeDoor(bot, cell) {
  const block = bot.blockAt(cell);
  if (!block) return 'unloaded';
  if (!isDoorBlock(block)) return `${block.name} (not a door)`;
  const props = guardExternalSync('navigator', 'read door properties', () => block.getProperties?.());
  if (!props.ok || !props.value) return `${block.name} (properties unreadable)`;
  return `${block.name} ${String(props.value.open) === 'true' ? 'OPEN' : 'shut'}`;
}

// How long the body is given to fall its one block before the drop is measured. NAMED, because it is
// the prime suspect in bugsquashing §19.3 and a magic 250 is not something a successor can weigh: a
// one-block fall is roughly 6 server ticks, so this budget and the thing it measures are the same order
// of magnitude, and every failure on record was the FIRST step of a fresh column — the one step taken
// from a standing start, where no prior fall is already in progress. Changing it is a behaviour change
// and is NOT what this instrumentation does; the line below reports enough to decide whether to.
const DIG_SETTLE_MS = 250;

async function digDownStep(bot) {
  const feet = bot.entity.position.floored();

  // ── EVERY REFUSAL NAMES ITSELF (2026-09-11, bugsquashing §19.3) ─────────────────────────────────
  // All four gates below were bare `return false`, while descendColumn's caller comment claimed
  // "digDownStep already reports WHICH gate refused". It did not, and that gap is what made a stalled
  // descent unreadable: nothing in the trace could separate a safety gate refusing from a dig that ran
  // and did not drop. They report at SUMMARY level, not warn — a gate refusing is the guard WORKING
  // (Law 17), and a warn here would wake the watch through warn-repeat on a bot behaving correctly.
  const refuse = (gate, detail) => {
    watcher.summary('navigator', `Dig-down refused at (${feet.x},${feet.y},${feet.z}) — gate ${gate}: ${detail}.`);
    return false;
  };

  // (a) feet cell safe to dig from (not submerged in a liquid).
  const feetBlock = bot.blockAt(feet);
  if (feetBlock && (feetBlock.name === 'water' || feetBlock.name === 'flowing_water' || feetBlock.name === 'lava' || feetBlock.name === 'flowing_lava')) {
    return refuse('a (feet submerged)', `feet cell holds ${feetBlock.name}`);
  }

  // (b) the block we dig: a real solid, never a hazard.
  const floorPos = new Vec3(feet.x, feet.y - 1, feet.z);
  const floorBlock = bot.blockAt(floorPos);
  if (!floorBlock || floorBlock.name === 'air' || floorBlock.boundingBox === 'empty') {
    return refuse('b (nothing solid to dig)', `block below is ${floorBlock ? floorBlock.name : 'unloaded'}`);
  }
  if (isNotSafeSurface(floorBlock)) return refuse('b (hazard below)', `block below is ${floorBlock.name}`);

  // (c) the landing one below must be a safe solid — one-block drop, never into air or lava.
  const landingBlock = bot.blockAt(new Vec3(feet.x, feet.y - 2, feet.z));
  if (!landingBlock || landingBlock.name === 'air' || landingBlock.boundingBox === 'empty') {
    return refuse('c (no landing)', `two below is ${landingBlock ? landingBlock.name : 'unloaded'} — the drop would be more than one block`);
  }
  if (isNotSafeSurface(landingBlock)) return refuse('c (hazard landing)', `two below is ${landingBlock.name}`);

  // (d) no side floods/burns the hole — liquid or hazard at the wall, at hole level or feet level.
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const sideLow = bot.blockAt(new Vec3(floorPos.x + dx, floorPos.y, floorPos.z + dz));
    if (isNotSafeSurface(sideLow)) {
      return refuse('d (wall at hole level)', `(${floorPos.x + dx},${floorPos.y},${floorPos.z + dz}) is ${sideLow ? sideLow.name : 'unloaded'}`);
    }
    const sideHigh = bot.blockAt(new Vec3(floorPos.x + dx, floorPos.y + 1, floorPos.z + dz));
    if (isNotSafeSurface(sideHigh)) {
      return refuse('d (wall at feet level)', `(${floorPos.x + dx},${floorPos.y + 1},${floorPos.z + dz}) is ${sideHigh ? sideHigh.name : 'unloaded'}`);
    }
  }

  await performDig(bot, floorBlock.position, floorBlock, 'navigator');   // one dig route (Law 16)
  await sleep(DIG_SETTLE_MS);

  const final = bot.entity.position.floored();
  const dropped = final.y < feet.y;
  if (dropped) { watcher.summary('navigator', `Dug down to (${final.x},${final.y},${final.z}).`); return true; }

  // ── A NON-DROP HAS THREE CAUSES AND THE CALLER CANNOT TELL THEM APART ───────────────────────────
  // Measured 2026-09-11 across four occurrences, and the first reading already eliminated two of
  // them: the block is GONE every time, and the body is onGround=true at a whole-number y with the
  // resting velocity (-0.078). So the dig lands, and the body is NOT still falling — it is being
  // HELD UP by something, which can only be a neighbouring column catching a hitbox that overhangs
  // this cell. That is why the offset from the cell centre is reported: a body is 0.6 wide (±0.3)
  // and driveRun's strict arrival tolerance is 0.4, so a legal arrival can leave 0.2 of the hitbox
  // across the boundary and standing on the neighbour. Read-only — nothing here recentres, waits
  // longer or retries; recentring is a behaviour change and the Architect's call (§19.3).
  const floorNow = bot.blockAt(floorPos);
  const wentAway = !floorNow || floorNow.name === 'air' || floorNow.boundingBox === 'empty';
  const vy = bot.entity.velocity && typeof bot.entity.velocity.y === 'number' ? bot.entity.velocity.y.toFixed(3) : 'unknown';
  const p = bot.entity.position;
  const offX = p.x - (feet.x + 0.5), offZ = p.z - (feet.z + 0.5);
  watcher.warn('navigator',
    `Dig-down: expected to drop from y=${feet.y}, still at y=${final.y}. ` +
    `Target (${floorPos.x},${floorPos.y},${floorPos.z}) was ${floorBlock.name} and is now ` +
    `${floorNow ? floorNow.name : 'unloaded'} — ${wentAway ? 'DUG, the block went' : 'STILL THERE, the dig did not land'}. ` +
    `body (${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}), off-centre dx=${offX.toFixed(3)} dz=${offZ.toFixed(3)} ` +
    `(|off|+0.3 over 0.5 means the hitbox overhangs and a neighbour is holding it up), ` +
    `onGround=${bot.entity.onGround}, velocityY=${vy}, measured ${DIG_SETTLE_MS}ms after the dig returned.`);
  return false;
}

// swimStep: move the bot to a water-surface position. Works for land→water entry,
// water→water traversal, and fall-into-water. survival_instincts handles floating.
// Detects shallow water (head above surface) and uses wading physics — longer timeout
// and jump control to climb out, instead of pure swim which stalls in 1-deep water.
async function swimStep(bot, targetPos) {
  const curFeet = bot.entity.position.floored();
  const headBlock = bot.blockAt(curFeet.offset(0, 1, 0));
  const headSubmerged = headBlock && (headBlock.name === 'water' || headBlock.name === 'flowing_water');

  const TIMEOUT = headSubmerged ? 1000 : 2500;
  const t0 = Date.now();
  await guardExternal('navigator', 'lookAt swim target', () => bot.lookAt(new Vec3(targetPos.x + 0.5, targetPos.y + 1, targetPos.z + 0.5), true));
  // setControlState asserts on a bad control name or non-boolean state and can fail no other way, so its
  // only throw is our own defect and must travel (Law 13). Same for every control press below.
  bot.setControlState('forward', true);
  let ok = false;
  // withCleanup, not a guard: nothing is caught. The presses must be released on every exit or the body
  // swims on into whatever runs next; the releases themselves are unguarded because setControlState can
  // only fail on our own bad literal.
  await withCleanup('navigator', 'swim leg', async () => {
    while (Date.now() - t0 < TIMEOUT) {
      const p = bot.entity.position;
      const dx = targetPos.x + 0.5 - p.x, dz = targetPos.z + 0.5 - p.z;
      if (Math.hypot(dx, dz) <= 0.8) { ok = true; break; }
      await guardExternal('navigator', 'look while swimming', () => bot.look(Math.atan2(-dx, -dz), 0, true));
      if (!headSubmerged) {
        const dy = targetPos.y + 1 - p.y;
        bot.setControlState('jump', dy > 0.3);
      }
      await sleep(50);
    }
  }, () => {
    bot.setControlState('forward', false);
    if (!headSubmerged) bot.setControlState('jump', false);
  });
  if (!ok) watcher.warn('navigator', `Swim step timed out heading toward (${targetPos.x},${targetPos.y + 1},${targetPos.z}).`);
  return ok;
}

// pillarUpStep: place a block underfoot at jump peak, rise 1 block. Uses scaffold_movement.pillarStep.
async function pillarUpStep(bot) {
  const result = await pillarStep(bot, { debug: false });
  if (result && result.success) {
    watcher.summary('navigator', `Pillared up to y=${result.newY} using ${result.itemName}.`);
    return true;
  }
  watcher.warn('navigator', `Pillar failed: ${result?.reason || 'unknown'}.`);
  return false;
}

// ---------------------------------------------------------------------------
// SECTION 6: Exit helpers (route ONLY to locomotion_judge)
// ---------------------------------------------------------------------------

// WHAT A NAVIGATION SPENT ON SEARCHING (Architect 2026-08-04: "calculate the time each pathfinding
// takes and post it for watcher tracer to look at"). Posted HERE because forwardToJudge is the single
// exit every navigation takes — success, give-up and exception alike — so no trip can finish without
// declaring its search cost. Posting at the seven computeAStar call sites instead would emit a line per
// re-plan (the per-step noise Law 5 removed) and would still miss the exception path.
//
// The three numbers are the ones a verdict is read from, not decoration: `partial` and `failed` are what
// the Architect's binary requirement ("this is the only way / I have the best way") actually turns on —
// a partial is the search saying it stopped looking, and no route it returns can be called best. Left in
// even when zero so the tracer can distinguish "no partials" from "not measured" (Law 25).
// THE OWNER SPLIT IS NOT DECORATION. This drain empties a census the whole process writes to, and the
// navigation is only one of its writers — a drop being priced for reachability searches under a deadline
// of its own, far shorter than this one. Reported as a single total, a trip could show more timeouts than
// its own deadline could account for in the time it also reported, and nothing in the line said the two
// numbers came from different clocks. The split is what lets a reader hold each owner against the deadline
// that owner actually ran under (Law 25: the verdict must equal what happened, and "whose" is part of it).
function postSearchCensus() {
  const c = drainSearchCensus();
  if (c.searches === 0) return;
  const owners = Object.entries(c.byOwner)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([name, t]) => `${name} ${t.searches}×/${t.totalMs}ms${t.timedOut ? `/${t.timedOut} timedOut` : ''}`)
    .join(', ');
  watcher.summary('pathfinding',
    `A* this trip: ${c.searches} search(es), ${c.totalMs}ms total, ${Math.round(c.totalMs / c.searches)}ms avg, ${c.maxMs}ms worst, ${c.nodes} nodes` +
    ` | partial ${c.partial}, cutoff ${c.incomplete}, timedOut ${c.timedOut}, noRoute ${c.failed}` +
    ` | by owner: ${owners}.`);
}

// Both exits stamp the feet cell, and both may run on a path where the body is gone (disconnect, death
// mid-trip). Optional chaining, not a guard: "there is no entity right now" is a state to READ, and
// reading it is what a guard here was faking (Law 26 — the catch was standing in for a question).
function describeFeet() {
  const p = global.bot?.entity?.position?.floored?.();
  return p ? `(${p.x},${p.y},${p.z})` : 'unknown';
}

function forwardToJudge(payload, success, distNow, reason) {
  const capsule = payload.locomotion;
  const feet = describeFeet();
  postSearchCensus();
  watcher.summary('navigator', success
    ? `${capsule.verb} reached '${capsule.selected_target?.name}' — at ${feet}, ${distNow.toFixed(1)} blocks from target. Reporting success to the judge.`
    : `${capsule.verb} gave up (${reason}) at ${feet}, ${distNow.toFixed(1)} blocks from '${capsule.selected_target?.name}'. To the judge for retry/decision.`
  );
  const out = {
    ...payload,
    from: 'navigator',
    to: 'locomotion_judge',
    task: 'locomotion_judge',
    success: !!success,
    // Structured reason (not the readable string) so the judge can decide retry vs
    // abandon on a field, not by parsing prose (Law 10). Only a reason that reflects
    // forward progress is worth retrying — the judge whitelists which ones.
    fail_reason: success ? null : reason,
    readable: success ? `navigator: success ${capsule.verb}_reached` : `navigator: fail ${reason}`,
    locomotion: capsule
  };
  signalBus.route(out.to, out);
}

// DELETED 2026-08-15: `haltForEmergency(payload)` — an emergency exit that drained the census, raised an
// `aborted_by_emergency` error and routed nothing. It had no caller, and a walk this file can be stopped
// mid-way by has exactly one exit that reports (forwardToJudge). A second one that never fires is a
// pathway nobody maintains standing beside the one that works (Law 16), and its census-draining WHY was
// the strongest argument for keeping it — which is exactly how a dead exit survives an audit. If an
// emergency halt is ever needed here, it is a NEW verdict through the existing terminus, not this back.

// ---------------------------------------------------------------------------
// SECTION 7: Receive (signal bus entry point) and navigation orchestrator
// ---------------------------------------------------------------------------
// planRouteForTest — PLAN-ONLY test seam (Architect 2026-07-19). Runs the SAME A* the navigator's
// STEP 2/3 runs (identical position-goal construction + loadProtectedBlocks, same uncapped search), captures
// every trace line, and returns the plan — but WALKS NOTHING. No step execution, no signal bus, no
// recursive_judge → structurally cannot trigger the autonomy/stall recursion. It is the "route
// correctly?" oracle for the throttle/uncap fix: point it from an anchor at a deep cell stand and read
// whether the plan descends the staircase then walks the corridor (correct) or carves a diagonal
// shortcut to a dead-end (the old budget-partial bug). Reuses the real pathfinder (Law 16); the only
// authored input is the standpoint — READ, DON'T SIMULATE, the rule that anything Minecraft decides is
// read and only the operator's choices are authored.
//   standCoord {x,y,z} — the work-stand (feet cell); goal floor is y-1, exactly as STEP 2 derives it.
//   opts.startCoord {x,y,z} — AUTHORED standpoint (bot feet) to plan FROM; defaults to the bot's real
//     feet. Lets the oracle plan "as if standing at the anchor" while the observer body sits wherever it
//     spawned (only voxel reads need the chunks resident; the start is data, not the body's location) —
//     the same rule again: author the standpoint, READ the voxels.
//   returns { result, trace: string[] } — result is computeAStar's raw return (path, cost, partial, …).
async function planRouteForTest(bot, standCoord, opts = {}) {
  if (!bot?.entity?.position && !opts.startCoord) throw new Error('[navigator] planRouteForTest: no bot loaded and no startCoord.');
  const t = standCoord;
  const goal = { type: 'position', pos: new Vec3(Math.floor(t.x), Math.floor(t.y) - 1, Math.floor(t.z)) };
  if (opts.min_y != null) goal.min_y = opts.min_y;
  const feet = opts.startCoord
    ? new Vec3(Math.floor(opts.startCoord.x), Math.floor(opts.startCoord.y), Math.floor(opts.startCoord.z))
    : bot.entity.position.floored();
  const botFloor = feet.offset(0, -1, 0);
  const protectedBlocks = loadProtectedBlocks(bot);
  const trace = [];
  const result = await computeAStar(bot, botFloor, goal, {
    maxNodes: opts.maxNodes, protectedBlocks,
    owner: 'diagnostic',
    trace: (lbl, msg) => trace.push(`${lbl}: ${msg}`),
  });
  return { result, trace, start: { x: botFloor.x, y: botFloor.y + 1, z: botFloor.z }, goalFloor: goal.pos };
}

module.exports = {
  receive: watcher.track('navigator', async function (signalType, payload) {
    if (signalType !== 'navigator') return;
    await runNavigation(payload);
  }),
  planRouteForTest,   // plan-only oracle (no execution, no bus) — see above
  // digDownStep — the hardened one-block vertical descent, exported for ONE caller:
  // locomotion_dispatcher.descendColumn, which loops it to sink a scanned column straight down. It is
  // exported rather than reimplemented precisely so the safe-descent gate above (feet / floor / landing /
  // four walls) is the same gate in both pathways, and so the fleet still has exactly one dig-down
  // (Law 16). It stays inside the locomotion folder — no executor may call it directly.
  digDownStep,
  // Exported for inspection, not for routing — nothing calls this but the A* setup above. It answers
  // "what does the bot currently refuse to dig or bridge over", which is the question round 36 spent
  // 20 minutes unable to ask (Law 6: a decision must be inspectable after the fact). Pure read; a
  // caller cannot change locomotion by touching it.
  loadProtectedBlocks,
  // The lookahead dial. Exported so a live move test can set it per run (see move_injector); nothing in
  // the walking pathway reads it except the fuse block, so turning it cannot change anything else.
  setRunLookahead, getRunLookahead, setRunPrejump, getRunPrejump, RUN_LOOKAHEAD_DEFAULT,
};

// UNGUARDED, DELIBERATELY. This whole body sat inside one catch that reported `navigation_exception` to
// the judge with a hardcoded distance of 999 when it could not measure one — a defect dressed as a trip
// that made no progress, which the judge is built to RETRY. Every real cause (a bad capsule, a broken
// pathfinder, a null step) therefore looped instead of stopping, and the 999 travelled onward as though
// it were a reading (Law 25: a default is not a measurement). A throw out of here now reaches
// master_core's crash reporter, which is the terminus this catch was pretending to be (Law 13).
async function runNavigation(payload) {
  // --- Validate the inner locomotion capsule (Law 13: malformed = coding violation) ---
  const capsule = payload?.locomotion;
  if (!capsule || typeof capsule !== 'object' || !capsule.verb) {
    throw new Error('[navigator] CODING VIOLATION: missing inner locomotion capsule (verb). Only the locomotion sub-loop may route here.');
  }
  const verb = capsule.verb;
  const hasCoordinate = validCoordinate(capsule.coordinate);
  const hasCandidatesRef = typeof capsule.candidates_ref === 'string' && capsule.candidates_ref.length > 0;
  if (!hasCoordinate && !hasCandidatesRef) {
    throw new Error('[navigator] CODING VIOLATION: locomotion capsule carries neither a valid coordinate nor a candidate-set reference.');
  }
  const bot = global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[navigator] CODING VIOLATION: invoked with no bot loaded.');
  }

  // --- STEP 1: Resolve targets ---
  const targets = resolveTargets(capsule);
  const botFeet = bot.entity.position.floored();
  const botFloor = botFeet.offset(0, -1, 0);
  const nearest = pickNearest(botFeet, targets);
  const nearestDist = straightLine(botFeet, nearest.position);

  // --- STEP 2: Build A* goal ---
  const tSearch = Date.now();
  let goal;
  if (capsule.require_los || capsule.required_side) {
    // Interaction goal: find a vantage point with LOS within [MIN_PLACEMENT_DIST, BLOCK_REACH].
    // required_side (if set) adds a cardinal-side filter — A* only accepts positions on the
    // correct side of the target. Both constraints live in the same LOS goal; the executor
    // says "I need to interact with this block" and locomotion figures out where to stand.
    //
    // THIS IS PLACEMENT'S GOAL, and it is no longer a general interaction goal. Placing needs an ANGLE,
    // which is what a raycast answers. USING a station needs a specific pre-approved stance, which a
    // raycast cannot answer at all — it is satisfied from across a room and through a doorway, which is
    // how a bot came to report ARRIVED without moving and then retry a chest window forever. Station
    // approach left this goal on 2026-08-31 for `locomotion.goToStationStance`; leave this to the
    // callers that place and dig.
    const losTarget = validCoordinate(capsule.coordinate) ? capsule.coordinate : nearest.position;
    goal = { type: 'los', targetPos: losTarget, required_side: capsule.required_side || null };
  } else if (targets.length === 1) {
    const t = targets[0].position;
    goal = { type: 'position', pos: new Vec3(Math.floor(t.x), Math.floor(t.y) - 1, Math.floor(t.z)) };
  } else {
    const positions = targets.map(t => new Vec3(Math.floor(t.position.x), Math.floor(t.position.y) - 1, Math.floor(t.position.z)));
    goal = { type: 'multi', positions };
  }
  if (capsule.min_y != null) goal.min_y = capsule.min_y;

  // --- STEP 3: Run A* ---
  const protectedBlocks = loadProtectedBlocks(bot);
  let result = await computeAStar(bot, botFloor, goal, { protectedBlocks, deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate' });

  // An exact cell that hangs over a void or sits up in open air (a build anchor above its own shaft)
  // needs no special mode: the single weighted search (pathfinding_utils HEURISTIC_WEIGHT) reaches
  // it and bridges/pillars the final gap as the cheapest route, because no walk gets there. What
  // used to be a separate greedy "build-delivery" re-plan here is gone — it papered over budget
  // exhaustion by committing distance-first, which laid plank causeways across walkable ground on
  // far goals (Law 16: one search, one cost model).

  // Near-goal no-path recovery for NON-exact goals (an LOS/side goal has no "close enough" and no
  // cell to build toward, so a missing vantage is a genuine soft-fail below). A null result a few
  // blocks from the goal is usually a LOCAL dead spot — the bot pinned in a pocket. A* never retreats
  // first (stepping away raises cost until it pays off two moves later), so we do it explicitly: ONE
  // lateral step to open ground, then re-plan once where the side approach is now cheapest ("go away
  // a little, then swing around" — Architect). Hands A* a better vantage only; arrival stays Step 6's
  // sole verdict.
  if (!result && !capsule.exact && !capsule.require_los && !capsule.required_side && nearestDist <= UNSTICK_RADIUS) {
    capsule.selected_target = { name: nearest.name, position: nearest.position };
    if (await stepAwayFromGoal(bot, nearest.position)) {
      const uf = bot.entity.position.floored().offset(0, -1, 0);
      watcher.summary('navigator', `Unstick: stepped clear of a near-goal dead spot to (${uf.x},${uf.y + 1},${uf.z}), re-planning.`);
      result = await computeAStar(bot, uf, goal, { protectedBlocks, deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate' });
    }
  }

  if (!result) {
    // A* found no reachable path — soft-fail to judge for retry.
    const failReason = capsule.require_los ? 'astar_no_los_vantage' : 'astar_no_path';
    watcher.warn('navigator', `A* found no path (${failReason}) — soft-fail to judge for retry.`);
    capsule.selected_target = { name: nearest.name, position: nearest.position };
    return forwardToJudge(payload, false, nearestDist, failReason);
  }

  const astarPath = result.path;

  // --- STEP 4: Identify which target was reached (for multi-target) ---
  let selectedTarget;
  if (result.target) {
    const endFloor = result.target;
    let matchedTarget = targets[0];
    let minDist = Infinity;
    for (const t of targets) {
      const d = straightLine(endFloor, t.position);
      if (d < minDist) { minDist = d; matchedTarget = t; }
    }
    selectedTarget = { name: matchedTarget.name, position: matchedTarget.position };
  } else {
    selectedTarget = { name: nearest.name, position: nearest.position };
  }
  capsule.selected_target = selectedTarget;

  if (astarPath.length === 0) {
    // Path is empty — we are at the goal already. For LOS goals this means
    // the bot already has line of sight from its current position (A* confirmed
    // checkLOS passed at the start node). No movement needed.
    const d = dist(botFeet, selectedTarget.position);
    const alreadyThere = capsule.require_los ? true
      : capsule.exact ? botFeet.equals(exactFeetCell(selectedTarget.position))
      : arrived(botFeet, selectedTarget.position);
    return forwardToJudge(payload, alreadyThere, d, 'empty_path');
  }

  const pathEndFloor = astarPath[astarPath.length - 1].pos;
  const isPartial = result.partial === true;
  // ms ON THIS LINE, not only on the tripwire below. The tripwire fires at NAV_SLOW_PLAN_MS, so the only
  // searches whose duration reached the trace were the ones already known to be slow — which makes the
  // question "do long walks cost time, or short ones?" unanswerable from a run, because the cheap half of
  // the comparison was never recorded. Nodes were being posted here and time was not, and the two are not
  // interchangeable: nodes measure what the search examined, time measures what the BODY stood still for.
  const searchMs = Date.now() - tSearch;
  watcher.summary('navigator', `A* path: ${astarPath.length} step(s) [${edgeHistogram(astarPath)}], cost ${round1(result.cost)}, ${result.nodesVisited} nodes, ${searchMs}ms${isPartial ? ` (PARTIAL, residual ${round1(result.residual)})` : ''} -> (${pathEndFloor.x},${pathEndFloor.y + 1},${pathEndFloor.z}).`);

  announceFirstMove(astarPath.length);

  // Performance tripwire (see NAV_SLOW_PLAN_MS). Non-fatal: warn for the timed inspection, then fall
  // through and walk the valid plan. tSearch was stamped before goal-building; elapsed ≈ A* wall-time.
  // Reports the measured evidence (ms, nodes, and the hop distance) rather than asserting a cause: the
  // two candidate causes need opposite fixes and only the distance tells them apart (see the
  // DISTANCE IS NOT THE ONLY TRIGGER note above).
  if (searchMs > NAV_SLOW_PLAN_MS) {
    const hop = Math.round(dist(botFeet, selectedTarget.position));
    watcher.warn('navigator',
      `SLOW-NAV TRIPWIRE — NON-FATAL, BOT CONTINUING on a valid plan. Route search took ${searchMs}ms ` +
      `(${result.nodesVisited} nodes) for (${botFeet.x},${botFeet.y},${botFeet.z}) → (${selectedTarget.position.x},${selectedTarget.position.y},${selectedTarget.position.z}), ` +
      `hop distance ${hop} blocks, over the ${NAV_SLOW_PLAN_MS}ms line. Nothing is broken — inspect at the next timed check-in. ` +
      `READ THE PRICE, NOT THE DISTANCE: search effort is set by what the winning route COST, never by how far it went ` +
      `(measured — a 225-step walk examined a third as many cells as a 4-step cut through the build). ` +
      `Diagnose by what accompanies this line: a CUTTING THE BUILD warning means the goal is enclosed by the structure ` +
      `and the fix is a way in or a different goal cell; a PARTIAL means the goal was unreachable and the frontier ran ` +
      `to the deadline; neither means waypointing, which only helps when a long hop is genuinely priced by its distance.`);
  }

  // ── CUTTING THE BUILD IS ANNOUNCED, AT THE SAME VOLUME AS THE SLOW-NAV TRIPWIRE ────────────────────
  // A route through a protected voxel is the most consequential thing this search can decide: it is the
  // fleet electing to break its own structure, and A* only elects it after PROVING no detour under
  // PROTECTED_VOXEL_DETOUR_BUDGET extra steps exists. That proof is exactly what makes it worth hearing —
  // it is never a near-miss or a rounding error, it is a demonstrated statement that the build now
  // encloses somewhere the fleet needs to stand. Until now it happened silently and was visible only as
  // an unexplained cost in the trace.
  //
  // warn() AND DELIBERATELY NOT error(), for the reason written against the tripwire above and not
  // retracted here: a non-fatal error is PERMANENT in the trace and --watch wakes on errors at any index,
  // so every re-arm would re-wake on the same historical cut forever with no new event. The warn channel
  // already carries the loudness honestly through warn-burst and warn-repeat. "As loud as slow-nav" means
  // the same channel and the same level, which is what makes them comparable in triage.
  //
  // Announced only when the cut survives into the WALKED route. The search weighs a protected edge on
  // nearly every base-adjacent plan and discards almost all of them; warning on consideration rather than
  // commitment would fire continuously and teach the reader to skip the line.
  const cuts = astarPath.filter(s => s.protectedVoxel);
  if (cuts.length) {
    const where = cuts.slice(0, 6).map(s => `${s.edgeType}@(${s.pos.x},${s.pos.y + 1},${s.pos.z})`).join(' ');
    watcher.warn('navigator',
      `CUTTING THE BUILD — this route breaks ${cuts.length} PROTECTED voxel(s) and the bot is walking it. ` +
      `${where}${cuts.length > 6 ? ` +${cuts.length - 6} more` : ''}. ` +
      `A* charges ${PROTECTED_VOXEL_DETOUR_BUDGET} per protected voxel and returns the cheapest route, so this is a PROOF that no ` +
      `detour under ${PROTECTED_VOXEL_DETOUR_BUDGET} extra steps reaches (${selectedTarget.position.x},${selectedTarget.position.y},${selectedTarget.position.z}) — the goal is enclosed by the build, ` +
      `not merely awkward to reach. Two fixes and they are opposite: if the goal SHOULD be reachable, the ` +
      `blueprint is missing a way in; if it should not, the caller is targeting an interior cell instead of ` +
      `an anchor. Raising the budget only buys a wider search for the same cut.`);
  }

  // Same shape, same reason, different decision: a dig on this route will OPEN A LIQUID into the hole it
  // makes. A* prices that (FLOW_DETOUR_BUDGET for water, LAVA_FLOW_DETOUR_BUDGET for lava) instead of
  // banning it, so a route carrying one is a proof that no drier way under that many extra steps exists —
  // and, like the cut above, it is announced only where the charge SURVIVED into the walked route.
  //
  // Split by liquid because the two readings are not the same errand. Water says "expect the bot to come
  // back wet and re-plan; the corridor it just dug is now a stream." Lava says the route is one dig away
  // from killing the bot, and it is only ever chosen because the search found literally nothing cheaper —
  // which at the cost ceiling means nothing else reaches at all.
  const breaches = astarPath.filter(s => s.flowCharge > 0);
  if (breaches.length) {
    const lava = breaches.filter(s => s.flowCharge >= LAVA_FLOW_DETOUR_BUDGET);
    const where = breaches.slice(0, 6).map(s => `${s.edgeType}@(${s.pos.x},${s.pos.y + 1},${s.pos.z})`).join(' ');
    watcher.warn('navigator',
      `OPENING A LIQUID — this route digs ${breaches.length} face(s) that a liquid will flow into` +
      `${lava.length ? ` INCLUDING ${lava.length} onto LAVA` : ''} and the bot is walking it. ` +
      `${where}${breaches.length > 6 ? ` +${breaches.length - 6} more` : ''}. ` +
      `A* charges ${FLOW_DETOUR_BUDGET} for water and ${LAVA_FLOW_DETOUR_BUDGET} for lava and returns the cheapest route, so this is a ` +
      `PROOF that no drier detour under that many extra steps reaches the goal. ` + (lava.length
        ? 'The lava faces are the ones to act on: the dig is next to a lava source and the executor will '
          + 'swing at it. If the goal did not need to be reached through a lava wall, the caller is aiming '
          + 'at the wrong cell.'
        : 'Expect the dug corridor to be flooded on the way back — a later route through the same cells '
          + 'will price it as water, not air.'));
  }

  // --- STEP 5: Walk the path step-by-step using edge dispatch ---
  // When a step fails, PRICE UP the failed destination and re-plan from the current position. A* then
  // routes around it if any alternative exists, and still through it if none does — which is the whole
  // difference from the hard ban this replaced. The ban could delete the only route to a cell including
  // the GOAL (a final step that stumbles bans its own destination), and the re-plan then spent the full
  // node budget proving a falsehood: 200,005 nodes and 5.7s on a two-block move, live 2026-08-04, after
  // which the bot walked to that very cell anyway. Escalating so a cell that keeps failing does
  // eventually stop being chosen, without ever becoming unreachable (Law 13 default-stopped applies to
  // acting, not to deleting the map).
  // THE FINE IS ON THE MOVE, NOT ON THE PLACE. A failed step observed one thing — "bridging into X did
  // not work" — and the cell-shaped key generalised it into "X is a bad place", which nothing measured.
  // The bot then avoided X by every route, including a plain walk in from another side that would have
  // worked. Keying on cell|edgeType charges what actually failed and leaves the other ways in unpriced.
  // The cell shape was inherited from the hard ban this charge replaced: deletion has nowhere to land but
  // a cell, so the ban had to be cell-shaped, and nobody re-asked the target when the ban became a fine.
  //
  // THE LADDER IS CAPPED AT THE COST MODEL'S OWN CEILING, and the top rung used to sit ten times above it.
  // PROTECTED_VOXEL_DETOUR_BUDGET is the most the fleet will ever pay for one edge, so a fine above it
  // silently declared a further tier appearing in no tier list and no edge catalog — a second cost model
  // beside the one the header documents (Law 16). The cost is not the fine itself but the PROOF it forces:
  // A* must rule out every route cheaper than the winner, so a rung of N obliges the search to examine
  // everything reachable within N walk-steps before it may accept the fined move. Capping at the ceiling
  // means a fine can no longer make a search worse than the cost model already permits at its maximum,
  // while the ladder still escalates and still never makes a move unreachable.
  //
  // EVERY RUNG IS AN EXISTING NAMED TIER rather than a fresh number, so the ladder cannot drift away from
  // the cost model it is supposed to sit inside — it re-reads the same constants the edges are priced
  // from, and moving one of those moves this too (the previous ladder was written against a ceiling of
  // 250 and would have gone degenerate the moment that constant changed, which it since has).
  const movePenalties = new Map();
  const penaltyRung = new Map();
  const PENALTY_LADDER = [COST_HIGH, COST_PLACE, PROTECTED_VOXEL_DETOUR_BUDGET];
  const penaliseMove = (cellKey, edgeType) => {
    const key = `${cellKey}|${edgeType}`;
    const rung = penaltyRung.get(key) || 0;
    penaltyRung.set(key, rung + 1);
    movePenalties.set(key, PENALTY_LADDER[Math.min(rung, PENALTY_LADDER.length - 1)]);
    return key;
  };
  // Carve ledger — every dig/place edge this trip executes, folded into ONE inspection line at exit.
  // Declares WHERE the navigator cut terrain so digging around a build is visible in the trace (Law 5).
  const carves = [];
  const flushCarves = () => {
    if (!carves.length) return;
    const byType = {};
    for (const c of carves) (byType[c.t] || (byType[c.t] = [])).push(`(${c.x},${c.y},${c.z})`);
    const parts = Object.entries(byType).map(([t, ls]) =>
      `${t}×${ls.length} ${ls.slice(0, 12).join(' ')}${ls.length > 12 ? ` +${ls.length - 12} more` : ''}`);
    watcher.summary('navigator', `carved this trip — ${parts.join(' | ')}.`);
    carves.length = 0;
  };
  const MAX_REPLANS = 3;
  let replans = 0;
  let currentPath = astarPath;
  let stepIdx = 0;
  let walkDone = false;
  let lastProgressLog = Date.now();
  const PROGRESS_INTERVAL = 3000;

  // Streaming-replan stall guard. A PARTIAL A* path to an UNREACHABLE goal (e.g. drop_collector
  // chasing an item with no standable cell next to it) walks its steps "successfully" yet never
  // closes the last gap — the loop below would replan forever. That never terminated AND the
  // back-to-back A* calls starved mineflayer's keep-alive, timing the bot off the server with no
  // error emote. Track the best distance-to-target; N consecutive replans with no real gain = a
  // stuck goal → give up to the judge (drop_collector then skips it as unreachable). Unlike the
  // failure-branch MAX_REPLANS, this bounds the SUCCESS branch, which nothing else did.
  let bestRemaining = Infinity;
  let stallReplans = 0;
  const MAX_STALL_REPLANS = 6;

  // Node budget lives in Section 2 (single source of truth). There is no replan CADENCE any more —
  // the trigger is verification failure or a spent path segment; see the walk loop below.
  // Replans no longer print their own line — they stash stats here and
  // the next progress heartbeat folds them into one line. Cuts navigation noise:
  // one heartbeat every PROGRESS_INTERVAL instead of a progress line plus a
  // replan line (often at the same timestamp) on every refresh.
  let pendingReplanNote = '';

  // Run ledger — the same shape as the carve ledger and for the same reason (Law 5, one line per trip).
  // This is the ONLY evidence that the lookahead did anything, and the ratio that matters is
  // broken/taken: a run that keeps breaking is a lookahead reading further than the ground supports,
  // which is the failure the depth dial exists to tune away.
  let runsTaken = 0, runsBroken = 0, runCellsCrossed = 0, runPrejumps = 0;
  // ── THE JUMP PRESSES, SPLIT BY THE BEARING THEY WERE MADE ON (Architect 2026-08-06) ──────────────
  // "we should have calculators jump diagonally up at the correct speed but im not sure if that works."
  //
  // The count alone cannot answer that, and this is the trip that HAS the answer: combat runs on flat
  // ground by the base and produced ONE press across a 25-minute soak, while an ordinary walk climbs
  // constantly. Same driveRun, same prejump — so the presses were always here, just never separated.
  //
  // riseAhead measures a step by subtracting a flat 0.5 from the distance to the cell CENTRE, which is
  // the half-width of a face met HEAD-ON. A corner is ~0.707 away, so at 45° the reported lead runs
  // ~0.33 b long — about 1.2 ticks at sprint against a 5-tick window. `late` below is the count that
  // matters: a press the plan itself declined to certify. Its rate on diagonals against its rate on
  // axials is the measurement, because the plan's own verdict is computed FROM the suspect distance
  // and therefore cannot report an error in it (Law 26 — no grading its own paper).
  const jumpBearing = { axial: 0, oblique: 0, diagonal: 0, lateAxial: 0, lateDiagonal: 0 };
  const flushRuns = () => {
    if (!runsTaken) return;
    const jb = jumpBearing;
    const rate = (late, n) => (n ? `${late}/${n} not certified (${Math.round(late / n * 100)}%)` : 'none');
    watcher.summary('navigator',
      `fused this trip — ${runsTaken} run(s) over ${runCellsCrossed} cell(s), ${runPrejumps} prejump(s), ` +
      `${runsBroken} broke early (lookahead ${RUN_LOOKAHEAD}, prejump ${RUN_PREJUMP ? 'on' : 'off'}).` +
      (runPrejumps
        ? ` Jump bearing: ${jb.axial} axial, ${jb.oblique} oblique, ${jb.diagonal} diagonal — ` +
          `axial ${rate(jb.lateAxial, jb.axial)}, diagonal ${rate(jb.lateDiagonal, jb.diagonal)}.`
        : ''));
  };

  // ── Candidate exhaustion (Architect 2026-07-14) ──────────────────────────────────────────────
  // A candidate SET must try EVERY candidate before giving up — never refixate on one the walk has
  // already proven unreachable, never surrender with 20 good candidates untried. When a committed
  // target stalls, its floor cell is retired here and the multi-goal is replanned over the survivors;
  // give-up waits until the set is empty. The set is finite, so this terminates on its own — the old
  // blind MAX_STALL_REPLANS kill is now a per-candidate cap that MOVES ON instead of surrendering.
  // "Keep trying different things, never the exact same thing twice, until the list is exhausted."
  const triedCandidates = new Set();
  const goalFloorOf = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
  // selectedTarget.position drifts to the reached floor on replans, so match it back to the nearest
  // ORIGINAL target to key the retired-set stably.
  const currentCandidateFloor = () => {
    let mt = targets[0], md = Infinity;
    for (const t of targets) { const d = straightLine(selectedTarget.position, t.position); if (d < md) { md = d; mt = t; } }
    return goalFloorOf(mt.position);
  };
  // Retire the current target and re-aim at the nearest UNTRIED candidate. True = a fresh plan to a
  // different candidate is loaded (loop continues); false = the set is exhausted (caller gives up).
  async function retargetToNextCandidate() {
    if (goal.type !== 'multi') return false;                       // single / los / exact — nothing else to try
    triedCandidates.add(keyOf(currentCandidateFloor()));
    const live = targets.map(t => goalFloorOf(t.position)).filter(p => !triedCandidates.has(keyOf(p)));
    if (live.length === 0) return false;                           // every candidate tried
    const nextGoal = { type: 'multi', positions: live };
    if (goal.min_y != null) nextGoal.min_y = goal.min_y;
    const fromFloor = bot.entity.position.floored().offset(0, -1, 0);
    const r = await computeAStar(bot, fromFloor, nextGoal, { movePenalties, protectedBlocks, deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate' });
    if (!r || r.path.length === 0) return false;                   // no untried candidate reachable → exhausted
    goal = nextGoal;
    currentPath = r.path;
    stepIdx = 0;
    let mt = targets[0], md = Infinity;
    const endPos = r.target || currentPath[currentPath.length - 1].pos;
    for (const t of targets) { const d = straightLine(endPos, t.position); if (d < md) { md = d; mt = t; } }
    selectedTarget = { name: mt.name, position: mt.position };
    capsule.selected_target = selectedTarget;
    bestRemaining = Infinity; stallReplans = 0; replans = 0;       // full fresh effort for the new candidate
    watcher.summary('navigator', `Retired candidate (unreachable); ${triedCandidates.size} tried, re-aiming at nearest of ${live.length} untried — '${mt.name}', ${currentPath.length} step(s).`);
    return true;
  }

  while (stepIdx < currentPath.length && !walkDone) {
    // 'locomotion' is a TRACE LABEL, not a behaviour switch, and has been since the spoils gate came
    // out (Architect 2026-08-05) -- battleStations now branches on 'sentry' and nothing else, so this
    // tag reads identically to undefined. Kept because the journal's `source` field is how a run is
    // read back: it is what separates a fight the navigator walked into from one an executor polled.
    // The water gate this once named is not in battleStations at all (retired 2026-07-18 to performDig).
    // Safe to await from inside the step loop: the fight routes no signals, and on a win the tail
    // abandons this line to recursive_judge, so the loop below never resumes on a pre-fight path.
    await combatCheckpoint(bot, 'locomotion');

    const curFeet = bot.entity.position.floored();
    const step = currentPath[stepIdx];
    const curFloor = new Vec3(curFeet.x, curFeet.y - 1, curFeet.z);
    const dir = { x: step.pos.x - curFloor.x, z: step.pos.z - curFloor.z };

    // ── the fused run, tried before the per-edge switch ──────────────────────────────────────────
    // Two or more consecutive edges of a runnable type whose cells are ALREADY passable get walked as
    // one continuous press. Anything else — a carve edge, an unloaded cell, a floor that turned out to
    // be air — collapses the run and the per-edge switch below handles that step exactly as it always
    // has. At RUN_LOOKAHEAD 1 the `>= 2` gate never fires and this block is inert.
    const runCells = [];
    let runEndsAt = stepIdx;
    if (RUN_LOOKAHEAD > 1) {
      for (let k = stepIdx; k < currentPath.length && runCells.length < RUN_LOOKAHEAD; k++) {
        const s = currentPath[k];
        if (!RUNNABLE_EDGE_TYPES.has(s.edgeType)) break;
        if (!classifyFloorInline(bot, bot.blockAt(s.pos))) break;   // re-sensed: the plan is old news
        runCells.push(s.pos.offset(0, 1, 0));
        runEndsAt = k;
      }
    }
    let ok = false;
    let runHandled = false;
    if (runCells.length >= 2) {
      // ── WHY THE RUN'S END IS USUALLY NOT STRICT (first live A/B, 2026-08-01) ──────────────────────
      // The first build ended EVERY fused run on the strict centre test, and the A/B said depth 3 was
      // 7.7% SLOWER than depth 1 over the same course, six legs cleanly separated. That is the seam
      // being reinstated every N cells — and made worse, because the body now arrives at that centre
      // OFF-AXIS (having cut the two before it) and has to correct into it. Relaxing the middle while
      // still stopping at the end pays the cost of both.
      //
      // A cell only needs the exact centre when something is about to be done THERE: the destination,
      // or a carve edge whose primitive places and digs from the stand cell. Every other run end is a
      // cell the body is passing through, so it is entered, not stood on.
      const nextIsCarve = runEndsAt + 1 < currentPath.length
        && !RUNNABLE_EDGE_TYPES.has(currentPath[runEndsAt + 1].edgeType);
      const strictFinal = runEndsAt >= currentPath.length - 1 || nextIsCarve;
      const r = await driveRun(bot, runCells, { prejump: RUN_PREJUMP, strictFinal });
      runsTaken++;
      runPrejumps += r.prejumps;
      runCellsCrossed += r.crossed;
      for (const j of (r.jumps || [])) {
        const diag = (j.deg || 0) > 30, axial = (j.deg || 0) <= 10;
        if (diag) { jumpBearing.diagonal++; if (!j.will) jumpBearing.lateDiagonal++; }
        else if (axial) { jumpBearing.axial++; if (!j.will) jumpBearing.lateAxial++; }
        else jumpBearing.oblique++;
      }
      if (!r.arrived) runsBroken++;
      if (r.crossed > 0) {
        // The shared ok-branch below owns ALL progress bookkeeping (arrival, the replan trigger, the
        // stall guard). A run that crossed n cells credits n-1 here and lets that branch credit the
        // last one, so a fused run and a single step account identically and neither can drift.
        stepIdx += r.crossed - 1;
        runHandled = true;
        ok = true;
      }
    }

    if (!runHandled) switch (step.edgeType) {
      case 'walk':        ok = await bridgeLevelStep(bot, dir); break;
      case 'jump_out':    ok = await jumpOutStep(bot, step.pos.offset(0, 1, 0)); break;
      case 'climb_up':    ok = await stairUpStep(bot, dir); break;
      case 'climb_down':  ok = await stairDownStep(bot, dir); break;
      case 'door': {
        const feetTarget = step.pos.offset(0, 1, 0);
        // ── THIS STEP DOES NOT OPEN THE DOOR, AND THAT IS THE DESIGN ────────────────────────────────
        // The opener is survival_instincts.doorHandlerTick, a physicsTick reflex that fires when the
        // body walks up to a shut door holding 'forward'. So this is a plain walk through a cell that
        // is SOLID until the reflex acts, and a failure here has three indistinguishable causes: the
        // reflex never fired, it fired too late for this step's budget, or the door was open all along
        // and the walk failed on its own. The reflex reports nothing by contract, so read the door
        // either side of the walk and let the trace name which one (2026-09-11, bugsquashing §19.2).
        // The door sits midway between the body and the far cell: the edge is minted two cells out so
        // the body never halts inside the door block, which makes dir exactly ±2 on one axis.
        const doorCell = new Vec3(curFloor.x + dir.x / 2, curFloor.y + 1, curFloor.z + dir.z / 2);
        const doorBefore = describeDoor(bot, doorCell);
        // ── LINE UP FIRST, THEN GO THROUGH (Architect 2026-09-11) ──────────────────────────────────
        // *"it snags on the door every time… upon every entry the bot snags on the door either too far
        // left or right."* The door opens well before the body arrives, so the snag is not the opening
        // — it is the APPROACH. A doorway is a one-block gap and the body is 0.6 wide, leaving 0.2 of
        // clearance a side; driveRun's arrival tolerance is 0.4, so a body that arrived legally can be
        // half a door-frame off and catches the jamb every time.
        //
        // Centring on the cell the body already stands in IS aligning with the door: the approach cell
        // and the door cell differ only along the direction of travel, so they share the cross-axis
        // coordinate, and the centre of one is on the centre-line of the other. That is why this
        // centres HERE rather than trying to centre on the door block itself, which is a cell the body
        // may not stand in.
        //
        // It runs before the walk, never during — descending into a doorway mid-stride is what the
        // snag already is. microCenter now strafes without turning the body (motion_primitives), so
        // lining up costs no facing the walk would then have to undo.
        await microCenter(bot, { eps: 0.06 });
        ok = await stepToFeet(bot, feetTarget, { timeoutMs: 3000, stallMs: null });
        if (!ok) {
          watcher.warn('navigator',
            `Door step failed through (${doorCell.x},${doorCell.y},${doorCell.z}): was ${doorBefore}, ` +
            `now ${describeDoor(bot, doorCell)}, forward=${!!(bot.controlState && bot.controlState.forward)}. ` +
            `Still shut means the reflex never opened it; OPEN means it did and the 3000ms budget ran out anyway.`);
        }
        break;
      }
      case 'dig_through': ok = await digThroughStep(bot, dir); break;
      case 'bridge':      ok = await bridgeLevelStep(bot, dir); break;
      case 'dig_down':    ok = await digDownStep(bot); break;
      case 'pillar':      ok = await pillarUpStep(bot); break;
      // Diagonal dig-stairs reuse the stair walkers, which already dig blocked foot/head cells to
      // carve a permanent staircase; only the A* cost tier differs. (Straight-up-through-rock is
      // NOT a separate edge — it is the 'pillar' case above, priced PROTECTED_VOXEL_DETOUR_BUDGET by A* so the diagonal
      // staircase is preferred; pillarStep digs the ceiling as it rises.)
      case 'dig_climb_up':   ok = await stairUpStep(bot, dir); break;
      case 'dig_climb_down': ok = await stairDownStep(bot, dir); break;
      case 'swim':        ok = await swimStep(bot, step.pos); break;
      default:
        watcher.warn('navigator', `Unknown edgeType '${step.edgeType}' — attempting bridgeLevelStep.`);
        ok = await bridgeLevelStep(bot, dir);
        break;
    }

    if (ok) {
      if (CARVE_EDGES.has(step.edgeType)) carves.push({ t: step.edgeType, x: step.pos.x, y: step.pos.y + 1, z: step.pos.z });
      stepIdx++;
      const now = Date.now();
      if (now - lastProgressLog >= PROGRESS_INTERVAL) {
        const p = bot.entity.position.floored();
        const remaining = dist(p, selectedTarget.position);
        watcher.summary('navigator', `Progress: ${round1(remaining)} blocks remaining, at (${p.x},${p.y},${p.z})${pendingReplanNote}.`);
        pendingReplanNote = '';
        lastProgressLog = now;
      }
      // Re-plan on one of exactly two events, both of them real (Architect 2026-08-04 — this replaced
      // an unconditional every-2s/every-20-steps cadence):
      //   segmentDone  — the path ran out. A partial must be extended or the bot stops short.
      //   !stillValid  — the world moved under the remaining route, so the plan is now a lie.
      // The cadence was neither: it re-planned a healthy walk 27 times for 23.3s on one 97-second trip,
      // more than half the fleet's entire pathfinding bill for a ten-minute run, and every one of those
      // searches re-derived a route that was still correct. Verification costs ~4 reads per unwalked
      // cell against ~1.4M for a replan, and re-senses instead of trusting a timer (Invariant B).
      {
        const segmentDone = stepIdx >= currentPath.length;
        const stale = !segmentDone && !pathStillWalkable(bot, currentPath, stepIdx);
        if (segmentDone || stale) {
          const rFeet = bot.entity.position.floored();
          if (arrived(rFeet, selectedTarget.position)) {
            walkDone = true;
          } else {
            // Stall guard (see MAX_STALL_REPLANS): bail on an unreachable goal instead of
            // replanning it forever and starving the connection.
            const remainingNow = dist(rFeet, selectedTarget.position);
            if (remainingNow < bestRemaining - 0.5) { bestRemaining = remainingNow; stallReplans = 0; }
            else if (++stallReplans >= MAX_STALL_REPLANS) {
              // This candidate is unreachable after a full effort — retire it and try the next of the
              // set. Only give up when nothing untried remains (Architect 2026-07-14: no early surrender).
              if (await retargetToNextCandidate()) { continue; }
              watcher.warn('navigator', `No progress across ${stallReplans} replans — stuck ${round1(remainingNow)} blocks from '${selectedTarget.name}', no untried candidate remains. Giving up to the judge.`);
              flushCarves(); flushRuns();
              await diagnoseGiveUp(bot, selectedTarget.position, 'no_progress', goal, protectedBlocks);
              return forwardToJudge(payload, false, remainingNow, 'no_progress');
            }
            const rFloor = new Vec3(rFeet.x, rFeet.y - 1, rFeet.z);
            const tReplan = Date.now();
            const rResult = await computeAStar(bot, rFloor, goal, { movePenalties, protectedBlocks, deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate' });
            const replanMs = Date.now() - tReplan;
            if (rResult && rResult.path.length > 0) {
              currentPath = rResult.path;
              stepIdx = 0;
              if (targets.length > 1 && rResult.target) {
                let mt = targets[0], md = Infinity;
                for (const t of targets) { const d2 = straightLine(rResult.target, t.position); if (d2 < md) { md = d2; mt = t; } }
                selectedTarget = { name: mt.name, position: currentPath[currentPath.length - 1].pos.offset(0, 1, 0) };
                capsule.selected_target = selectedTarget;
              }
              pendingReplanNote = ` | replan ${currentPath.length} step(s), cost ${round1(rResult.cost)}, ${rResult.nodesVisited} nodes (${replanMs}ms)`;
            }
          }
        }
      }
      continue;
    }

    // ── Footing recovery: the step target was never the problem — the body's footing was — so this
    // does NOT blacklist the destination and does NOT count as a replan attempt.
    //
    // TWO PASSES, CHEAPEST FIRST, and the second exists because the first cannot reach a body in a bin.
    // Pass 1 (microcentre + walk) recovers a body HOVERING off the side of something: it is already free
    // to move horizontally and only needs to be pointed at ground. A body inside an open-top container
    // is not — it is behind a rim taller than the auto-step, and pressing `forward` at it is precisely
    // the six minutes of no_progress that put this pass here. Pass 2 clears the rim.
    //
    // Pass 1 is still tried first for the bin case rather than skipped: it costs ~300 ms, it is the
    // gentler move, and a body only PARTLY over a rim is recentred out by it. ─────────────────────────
    {
      const hovFeet = bot.entity.position.floored();
      const stuckWhy = badFooting(bot);
      if (stuckWhy) {
        watcher.warn('navigator', `Bad footing at (${hovFeet.x},${hovFeet.y},${hovFeet.z}): ${stuckWhy}. Attempting floor recovery.`);
        let recovered = false;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const adjFloor = bot.blockAt(new Vec3(hovFeet.x + dx, hovFeet.y - 1, hovFeet.z + dz));
          if (adjFloor && adjFloor.boundingBox !== 'empty' && adjFloor.name !== 'air') {
            await microCenter(bot);
            bot.setControlState('forward', false);
            const target = new Vec3(hovFeet.x + dx + 0.5, hovFeet.y, hovFeet.z + dz + 0.5);
            // Only the aim is a boundary; a refused aim means this neighbour cannot be tried, so the
            // loop moves to the next one rather than pressing forward at whatever it was facing.
            if (!(await guardExternal('navigator', 'lookAt floor-recovery neighbour', () => bot.lookAt(target))).ok) continue;
            bot.setControlState('forward', true);
            await sleep(200);
            bot.setControlState('forward', false);
            await sleep(100);
            if (!badFooting(bot)) {
              const newFeet = bot.entity.position.floored();
              watcher.summary('navigator', `Floor recovery: stepped to (${newFeet.x},${newFeet.y},${newFeet.z}). Re-planning.`);
              recovered = true;
              break;
            }
          }
        }

        // Pass 2 — clear the rim. Reuses the jump_out edge primitive rather than pressing jump here
        // (Law 16: one way to get a body out of a bin, whether A* planned it or this guard did).
        if (!recovered) {
          const landings = escapeLandings(bot);
          if (landings.length === 0) {
            watcher.warn('navigator', `Jump-out: ${stuckWhy} at (${hovFeet.x},${hovFeet.y},${hovFeet.z}) and NO walkable landing on any of the eight neighbours — nothing to jump to. Leaving it to the judge.`);
          }
          // Unguarded: microCenter and jumpOutStep are both ours and both REPORT (false = did not get
          // out), so the guard that stood here could only ever fire on a defect — and it turned that
          // defect into "this landing didn't work", silently trying the next one.
          for (const feetTarget of landings) {
            await microCenter(bot);
            if (!await jumpOutStep(bot, feetTarget)) continue;
            if (badFooting(bot)) continue;
            const jFeet = bot.entity.position.floored();
            watcher.summary('navigator', `Jump-out recovery: ${stuckWhy} → jumped to (${jFeet.x},${jFeet.y},${jFeet.z}) of ${landings.length} scanned landing(s). Re-planning.`);
            recovered = true;
            break;
          }
        }

        if (recovered) {
          const recFeet = bot.entity.position.floored();
          const recFloor = new Vec3(recFeet.x, recFeet.y - 1, recFeet.z);
          const recResult = await computeAStar(bot, recFloor, goal, { movePenalties, protectedBlocks, deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate' });
          if (recResult && recResult.path.length > 0) {
            currentPath = recResult.path;
            stepIdx = 0;
            continue;
          }
        }
      }
    }

    // Step failed — price up THIS MOVE (not the destination) and re-plan from current position.
    const finedKey = penaliseMove(step.key, step.edgeType);
    replans++;
    if (replans <= MAX_REPLANS) {
      const failFeet = bot.entity.position.floored();
      watcher.warn('navigator', `Step failed: ${step.edgeType} to (${step.pos.x},${step.pos.y + 1},${step.pos.z}) — bot at (${failFeet.x},${failFeet.y},${failFeet.z}), charged ${movePenalties.get(finedKey)} on ${step.edgeType} into that cell (other ways in stay unpriced) and re-planning (${replans}/${MAX_REPLANS}).`);
      const replanFloor = new Vec3(curFeet.x, curFeet.y - 1, curFeet.z);
      const tFailReplan = Date.now();
      const replanResult = await computeAStar(bot, replanFloor, goal, { movePenalties, protectedBlocks, deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate' });
      const failReplanMs = Date.now() - tFailReplan;
      if (replanResult && replanResult.path.length > 0) {
        currentPath = replanResult.path;
        stepIdx = 0;
        if (targets.length > 1) {
          let matchedTarget = targets[0];
          let minD = Infinity;
          for (const t of targets) {
            const d2 = straightLine(replanResult.target, t.position);
            if (d2 < minD) { minD = d2; matchedTarget = t; }
          }
          selectedTarget = { name: matchedTarget.name, position: currentPath[currentPath.length - 1].pos.offset(0, 1, 0) };
          capsule.selected_target = selectedTarget;
        }
        watcher.summary('navigator', `Re-planned: ${currentPath.length} step(s), cost ${round1(replanResult.cost)}, ${replanResult.nodesVisited} nodes (${failReplanMs}ms).`);
        continue;
      }
    }
    // No route to this target — retire it and try the next untried candidate before stopping.
    if (await retargetToNextCandidate()) { continue; }
    watcher.warn('navigator', `Step failed — no viable re-plan and no untried candidate. Stopping.`);
    walkDone = true;
  }

  flushCarves();   // declare every dig/place edge this trip cut, in one inspection line (all post-loop exits)
  flushRuns();     // and every fused run, so the lookahead's effect is readable from the trace alone

  // --- STEP 6: Final arrival check, route to judge ---
  const finalFeet = bot.entity.position.floored();
  const d = dist(finalFeet, selectedTarget.position);
  const startDist = nearestDist;

  if (capsule.require_los || capsule.required_side) {
    if (d > BLOCK_REACH) return forwardToJudge(payload, false, d, 'los_out_of_range');
    if (capsule.required_side) {
      const sideTarget = capsule.coordinate || selectedTarget.position;
      if (!isOnCorrectSide(finalFeet, sideTarget, capsule.required_side)) {
        return forwardToJudge(payload, false, d, 'wrong_side');
      }
    }
    return forwardToJudge(payload, true, d);
  }
  // Exact mode: the feet must occupy the target cell (anchored builds measure reach from
  // the exact stand block). Run the final ≤1-block closer, then require cell equality — a
  // within-tolerance-but-off arrival is a failure here, retried/abandoned by the judge.
  if (capsule.exact) {
    const cell = exactFeetCell(selectedTarget.position);
    await closeToExactCell(bot, cell, protectedBlocks);
    const ef = bot.entity.position.floored();
    const de = dist(ef, selectedTarget.position);
    if (ef.equals(cell)) return forwardToJudge(payload, true, de);
    const reason = de < startDist - 0.5 ? 'closer_but_not_arrived' : 'no_progress';
    await diagnoseGiveUp(bot, selectedTarget.position, reason, goal, protectedBlocks);
    return forwardToJudge(payload, false, de, reason);
  }
  if (arrived(finalFeet, selectedTarget.position)) {
    return forwardToJudge(payload, true, d);
  }
  const reason = d < startDist - 0.5 ? 'closer_but_not_arrived' : 'no_progress';
  await diagnoseGiveUp(bot, selectedTarget.position, reason, goal, protectedBlocks);
  return forwardToJudge(payload, false, d, reason);
}
