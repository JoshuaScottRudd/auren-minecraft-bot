// fragment: navigator
// The single locomotion rung: receives from locomotion_dispatcher, resolves targets, runs A*,
// walks the annotated path step-by-step via edge-type dispatch, and exits ONLY to
// locomotion_judge — success or soft-fail (Law 15; coding violations throw). No 20Hz continuous
// drive, no fall/parkour: every descent is a reversible one-block move (Law 17). 'pillar' is the
// only straight-up move, priced at PROTECTED_VOXEL_DETOUR_BUDGET.

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
const { microCenter, waitUntilSettled } = require('@utils/movement/motion_primitives');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
const { isFluid } = require('@utils/gravity_utils');
const { tryBridgeStep, pillarStep } = require('@utils/movement/scaffold_movement');
const { isNotSafeSurface, isHazardBeside, isOpenTopContainer, isStationFloor } = require('@utils/movement/terrain_predicates');
const leafAuthority = require('@utils/movement/leaf_authority');
const { sleep, BLOCK_REACH } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly — the shared 500ms combat gate
// (also held by the dig and drive primitives), with the engaging/escaping bypass.
const { combatCheckpoint } = require('@api/battle_stations');
const { computeAStar, drainSearchCensus, pathStillWalkable, keyOf, straightLine, classifyFloorInline, isBlockPassable, isScaffoldBlock, isDoorBlock, COST_HIGH, COST_PLACE, PROTECTED_VOXEL_DETOUR_BUDGET, LAVA_FLOW_DETOUR_BUDGET } = require('@utils/pathfinding_utils');
// A forwarding router: calls route() with an upstream author's own from/to, so it cannot use
// signal_utils' envelope helpers (they stamp `from` = the caller).
const signalBus = require('@kernel/signal_bus');

// ---------------------------------------------------------------------------
// SECTION 2: Constants
// ---------------------------------------------------------------------------
// Build-block preference for both bridge and pillar placement — the stricter gravity-filtered
// scaffold_block (Law 17), shared with pathfinding_utils' isScaffoldBlock (Law 16).
const BUILD_PREFS = [...require('@utils/fragment_utils').group_to_item.scaffold_block];
const ARRIVAL_TOLERANCE = 1.5;
// How close to the goal a no-path result must be to read as a pinned dead spot worth a
// step-away + re-plan (stepAwayFromGoal).
const UNSTICK_RADIUS = 4.0;

// ── Pathfinding / replan configuration (single source of truth) ──────────────
// Every A* call here runs uncapped on node count, terminating on the goal popping or the frontier
// running dry; computeAStar cedes a macrotask every ~tick so a long search never stalls the world.
// The bound owed instead is a clock on how long a body may stand still — NAV_SEARCH_DEADLINE_MS.

// ── THE FIRST-MOVE SIGNAL ────────────────────────────────────────────────────────────────────────────
// Releases the fleet's spawn lock: a bot's first route plan is the moment its expensive A* burst is
// over, so it is the signal for the launcher to start the next bot. Fires once per process.
// summary(), not warn(): nothing is wrong, and the level is the interface for every trace reader.
const FIRST_MOVE_MARK = 'FIRST MOVE';
let firstMoveAnnounced = false;
function announceFirstMove(steps) {
  if (firstMoveAnnounced) return;
  firstMoveAnnounced = true;
  watcher.summary('navigator',
    `${FIRST_MOVE_MARK} — planning finished, body is walking a ${steps}-step route. ` +
    `This bot is past the expensive part of its start; whatever is waiting on it may go now.`);
  // Also told to the foreman live, via the boardroom chair (the channel body_cell already uses),
  // so a foreman pacing an arriving crew has the fact without reading a trace. fleet_state relays
  // it as `first_move_at`.
  const hq = require('@kernel/corporate_headquarters');
  const link = require('@kernel/foreman_link');
  const botId = link.getBotId() || process.env.BOT_ID || 'default';
  const chair = hq.readBoardroomChair(botId, {}) || {};
  chair.first_move_at = Date.now();
  hq.writeBoardroomChair(botId, chair);
  link.sendUpdate();
}

// NAV_SLOW_PLAN_MS — a performance tripwire, not a gate: flags a route search slow enough that
// waypointing might be warranted for that area. warn(), not error() — trace_monitor reads the LEVEL
// as the interface (Law 26). A trip over a SHORT hop reads as a near-unreachable goal, not a large area.
const NAV_SLOW_PLAN_MS   = 3000;   // route-search wall-time over this → wake-the-operator error, bot continues

// NAV_SEARCH_DEADLINE_MS — the clock bound on how long a body may stand still while A* searches
// (pathfinding_utils' third legitimate terminator): a search proving "no route" is otherwise
// unbounded in wall time. On expiry it returns its best PARTIAL with timedOut+complete:false, never
// a false "unreachable" (Law 25), handing the gap to the judge (Law 15/11/8). Sized from
// `trace_monitor.js --route-cost`'s measured worst successful search. Not applied to
// planRouteForTest, which only measures — it never walks.
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

// The edge types that dig or place terrain to make a step passable. Every carve is recorded and
// posted in one aggregated line at exit (flushCarves, Law 5). Keyed on the A* edge label, not the
// block actually broken — a 'walk' edge bridged at execution is not counted.
const CARVE_EDGES = new Set(['dig_through', 'dig_down', 'bridge', 'pillar', 'water_bank_out', 'dig_stair_up', 'dig_stair_down']);

// ── THE LOOKAHEAD ────────────────────────────────────────────────────────────────────────────────
// Fuses consecutive runnable edges into one continuous press instead of stopping at every cell
// boundary. The tier is lookahead DEPTH, not speed — depth 1 is edge-for-edge, depth 3 gives sprint
// the runway to reach speed; parkour is depth n over the same walker (Law 16: one mover). Only
// already-passable cells fuse: re-sensed cell by cell (Invariant B), handing back to the per-edge
// switch the moment a cell is not walkable. Mutable so the depth is a live operator dial.
let RUN_LOOKAHEAD = 3;
// Independent of RUN_LOOKAHEAD: fusing cells and jumping early are two separate effects, each
// with its own dial.
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
// edgeHistogram — compact "type×n, type×n" of a path's edges, tagging the A* plan line with which
// steps carve vs. walk before the walk proves what it actually cut.
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
// No bot↔bot movement de-confliction: mineflayer bodies have no player↔player collision, so routing
// A* around a peer would simulate a constraint the machine doesn't have. Resource contention is
// handled by the claim arbiter (trees/cells/anchors), and the ground a claim closes is kept out of
// the route as a box (loadClosedBoxes) — the ground is what is avoided, never the body. No "clear exit" gate either: a
// bot backs straight out of a dead end, so such a gate would guard a non-hazard. Movement hazards
// (falls, lava) are priced into A* by cost, never policed here (Law 17 binds the planner).

// Every subsystem that owns built voxels, each answering for its own (Law 16 / Invariant D). Each
// source takes `bot` so it can sense its own current state (see loadProtectedBlocks).
const PROTECTED_SOURCES = [
  ['buildings', (bot) => buildingIntegrity.getAllProtectedBlocks(bot)],  // every locked blueprint
  ['staircase', (bot) => miningIntegrity.getProtectedBlocks(bot)],
  ['cells',     ()    => miningCellGraph.getProtectedBlocks()],  // no world-diff of its own: plan-only, over-protected
];

// One "x,y,z" key Set of every non-air voxel the bot has built or plans to. A* charges
// PROTECTED_VOXEL_DETOUR_BUDGET to dig or cover one. Every source is enumerated and unguarded, so
// a broken source's throw travels and is never mistaken for an empty protected set (Law 13).
// PROTECTED = BUILT: passing `bot`
// lets each source diff against the world. Built once per invocation, reused across replans.
function loadProtectedBlocks(bot) {
  const set = new Set();
  for (const [, read] of PROTECTED_SOURCES) {
    const keys = read(bot);
    if (keys) for (const key of keys) set.add(key);
  }
  // Fresh Set, never a source's own — merging into one source's returned object mutates another node's
  // value (Invariant D).
  return set.size > 0 ? set : null;
}

// loadClosedBoxes — every box the route may not enter: the downloaded building, closed to the whole
// fleet, and the ground each working peer has closed over its claim. Read fresh for every search
// (Invariant B): a peer's claim opens and closes while a trip is under way.
function loadClosedBoxes(goal = null) {
  const building = require('@kernel/downloaded_plan_registry').closedBox();
  const peers = require('@kernel/foreman_link').getPeerClosedAreas();
  const pit = require('@api/waste_pit').closedBox();   // the trash in it stays out of every pickup box
  // A blueprint's lane: its fixtures are closed to every route, and its interior to every route whose
  // goal cell lies outside it, so the interior is reached by its entry and left by its exit.
  const survey = require('@perception/blueprint_survey');
  const goalFeet = goal && goal.type === 'position' ? { x: goal.pos.x, y: goal.pos.y + 1, z: goal.pos.z } : null;
  const lanes = survey.laneClosedBoxes(survey.getWorldLanes(), goalFeet);
  return [building, pit, ...lanes, ...peers].filter(Boolean);
}

// Queue waits allow peer claims and blueprint state to change; the admitted search reads them anew.
function freshSearchState(bot, goal) {
  return { protectedBlocks: loadProtectedBlocks(bot), closedBoxes: loadClosedBoxes(goal) };
}

// closedBy — whose closed ground a stand at `feet` falls in: 'building' | 'waste_pit' | 'lane' | 'peer',
// or null for open ground. A route search refuses such a goal before it starts; this names the owner for
// the caller's own report, by the same sources and the same floor-feet-head test the search applies.
function closedBy(feet) {
  const survey = require('@perception/blueprint_survey');
  const holds = (b) => !!b && feet.x >= b.min.x && feet.x <= b.max.x && feet.z >= b.min.z && feet.z <= b.max.z
    && feet.y + 1 >= b.min.y && feet.y - 1 <= b.max.y;
  if (holds(require('@kernel/downloaded_plan_registry').closedBox())) return 'building';
  if (holds(require('@api/waste_pit').closedBox())) return 'waste_pit';
  if (survey.laneClosedBoxes(survey.getWorldLanes(), feet).some(holds)) return 'lane';
  if (require('@kernel/foreman_link').getPeerClosedAreas().some(holds)) return 'peer';
  return null;
}

// entersPeerGround — the peer area the unwalked route walks INTO, or null. A step is an entry when its
// floor, feet or head cell lies in an area the cell before it lies outside, so a body leaving ground
// that closed around it is walking out, and is let go.
function entersPeerGround(path, fromIdx, fromFloor) {
  const areas = require('@kernel/foreman_link').getPeerClosedAreas();
  if (!areas.length) return null;
  const within = (a, p) => p.x >= a.min.x && p.x <= a.max.x && p.z >= a.min.z && p.z <= a.max.z
    && p.y + 2 >= a.min.y && p.y <= a.max.y;
  let before = fromFloor;
  for (let i = fromIdx; i < path.length; i++) {
    const at = path[i].pos;
    for (const a of areas) { if (within(a, at) && !within(a, before)) return a; }
    before = at;
  }
  return null;
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

// closeToExactCell: exact-arrival final approach — the walk leaves the bot within ARRIVAL_TOLERANCE,
// but exact-mode callers need the feet ON the target cell. Two closers: (1) close the horizontal
// gap via stepToFeet; (2) once aligned, pillar up if below the target. A gap over PILLAR_MAX, or
// the bot above the target, is left to Step 6. digIfObstructing clears a non-hazard solid (foliage,
// a log) from the feet/head cell; isNotSafeSurface gates hazards out (Law 17), protectedBlocks
// guards blueprint voxels (Law 16).
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
      // The floor is laid before the step, as a walk edge does (bridgeLevelStep): a body stepping onto
      // a cell with air under it is held only by the rim and drops when it centres.
      const under = bot.blockAt(onColumn.offset(0, -1, 0));
      if (!under || under.name === 'air' || under.boundingBox === 'empty') {
        const sx = feetCell.x - cur.x, sz = feetCell.z - cur.z;
        if (sx !== 0 && sz !== 0) return false;        // a diagonal has no rim face to bridge from
        const r = await tryBridgeStep(bot, sx, sz);
        if (!r || !r.success) return false;
      }
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

// describeCell — what is at a coordinate, for a give-up trace line (Law 5 observability). blockAt
// answers null for an unloaded column instead of throwing, so an escaping throw here is our own
// defect and must travel (Law 13).
function describeCell(bot, pos) {
  const b = bot.blockAt(pos);
  if (!b) return 'unloaded';
  const box = b.boundingBox === 'block' ? 'solid' : b.boundingBox === 'empty' ? 'passable' : b.boundingBox;
  return `${b.name}(${box})`;
}
// ledgerStepFailed — one report line for a step the body planned and did not complete, read off the
// world and the body as the step left them: the edge, both cells, where the body ended to the hundredth,
// how far it got, what each cell around the destination holds, and who else stands there. `stopped_by`
// names the first of these the readings show, in the order the server would apply them:
//   server_set_back   the server corrected the body's position during the step
//   no_floor          nothing to stand on at the destination
//   solid_feet/head   the destination's feet or head cell holds a block with a collision box
//   rise_over_step    the destination floor's top is more than a walking step above the body
//   wall_contact      the body is pressed against something and gained under a fifth of a block
//   no_motion         the body gained under a fifth of a block and is pressed against nothing
//   out_of_time       the body was still moving when the step's time ran out
// Read by step_failure_lens (--steps).
const WALK_STEP_HEIGHT = 0.6;
function ledgerStepFailed(bot, step, from, startPos, startedAt) {
  const to = step.pos.offset(0, 1, 0);
  const p = bot.entity.position;
  const at = (dx, dy, dz) => bot.blockAt(new Vec3(to.x + dx, to.y + dy, to.z + dz));
  const name = (b) => (b ? b.name : 'unloaded');
  const solid = (b) => !!b && b.boundingBox === 'block';
  const topOf = (b) => (b && Array.isArray(b.shapes) && b.shapes.length ? Math.max(...b.shapes.map(s => s[4])) : 0);
  const floor = at(0, -1, 0), feet = at(0, 0, 0), head = at(0, 1, 0);
  const rise = +((to.y - 1 + topOf(floor)) - p.y).toFixed(2);
  const gained = +(Math.hypot(to.x + 0.5 - startPos.x, to.z + 0.5 - startPos.z) - Math.hypot(to.x + 0.5 - p.x, to.z + 0.5 - p.z)).toFixed(2);
  const wall = !!bot.entity.isCollidedHorizontally;
  const corrected = bot._navLastServerPosition;
  const setBack = !!corrected && corrected.at >= startedAt;
  const levelEdge = step.edgeType === 'walk' || step.edgeType === 'bridge' || step.edgeType === 'door';
  const stoppedBy = setBack ? 'server_set_back'
    : !solid(floor) ? 'no_floor'
    : solid(feet) ? `solid_feet:${name(feet)}`
    : solid(head) ? `solid_head:${name(head)}`
    : levelEdge && rise > WALK_STEP_HEIGHT ? 'rise_over_step'
    : gained < 0.2 ? (wall ? 'wall_contact' : 'no_motion')
    : 'out_of_time';
  const others = Object.values(bot.entities || {})
    .filter(e => e && e !== bot.entity && e.position && Math.abs(e.position.y - to.y) < 2
      && Math.hypot(e.position.x - (to.x + 0.5), e.position.z - (to.z + 0.5)) < 1)
    .map(e => String(e.username || e.name || e.type).replace(/\s+/g, '_'));
  const held = bot.heldItem ? bot.heldItem.name : 'nothing';
  watcher.summary('step_fail',
    `step_failed edge=${step.edgeType} from=(${from.x},${from.y},${from.z}) to=(${to.x},${to.y},${to.z})`
    + ` body=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) stopped_by=${stoppedBy} gained=${gained} rise=${rise}`
    + ` on_ground=${bot.entity.onGround ? 1 : 0} wall=${wall ? 1 : 0} set_back=${setBack ? 1 : 0} step_ms=${Date.now() - startedAt}`
    + ` to_floor=${name(floor)} to_feet=${name(feet)} to_head=${name(head)}`
    + ` body_floor=${name(bot.blockAt(p.offset(0, -0.01, 0)))} body_head=${name(bot.blockAt(p.offset(0, 1.62, 0)))} body_above=${name(bot.blockAt(p.offset(0, 2.01, 0)))}`
    + ` others=${others.length ? others.join('+') : 'none'} held=${held}`);
}

// diagnoseGiveUp — the give-up post-mortem, answering three questions a give-up otherwise hides:
// (1) target footing — floor/feet/head at the goal; (2) pillar/bridge fuel carried, since an empty
// inventory silently disables every vertical/gap edge; (3) what A* actually tried — a fresh
// trace-wired search reusing computeAStar's trace facility (Law 5, Law 16 one edge model).
async function diagnoseGiveUp(bot, targetPos, reason, goal, protectedBlocks) {
  const feet  = new Vec3(Math.floor(targetPos.x), Math.floor(targetPos.y), Math.floor(targetPos.z));
  const floor = feet.offset(0, -1, 0);
  const head  = feet.offset(0, 1, 0);
  const p = bot.entity.position.floored();
  const fuel = (bot.inventory?.items?.() || []).reduce((n, i) => n + (i.count > 0 && isScaffoldBlock(i.name) ? i.count : 0), 0);
  // Unguarded: this runs the same computeAStar the trip ran, so an escaping throw means the
  // pathfinder itself is broken, and it must travel — never reduced to a warn line (Law 13).
  // The edges it tried go to the context buffer, which an error dumps; the warning carries the verdict.
  const r = await computeAStar(bot, p.offset(0, -1, 0), goal, {
    sense: () => freshSearchState(bot, goal),
    deadlineMs: NAV_SEARCH_DEADLINE_MS,
    owner: 'diagnostic',  // billed separately from the trip's own search cost — this is the post-mortem, not the trip
    trace: (_lbl, msg) => watcher.buffer.record('navigator', msg),
  });
  const cutOff = !!(r && r.complete === false);
  watcher.warn('navigator',
    `give-up (${reason}) at (${p.x},${p.y},${p.z}) — target (${feet.x},${feet.y},${feet.z}): ` +
    `floor below=${describeCell(bot, floor)}, feet=${describeCell(bot, feet)}, head=${describeCell(bot, head)}, ` +
    `pillar/bridge fuel ${fuel}${fuel === 0 ? ' (vertical & gap edges disabled)' : ''}; ` +
    // A dry frontier is a verdict (nothing reachable); a cut-off search is not one — it only
    // established a price floor (Law 25).
    `re-search ${r ? r.nodesVisited : '?'} nodes, ` +
    `${cutOff ? `cut off (nothing costs less than ${round1(r.provenBound || 0)})` : 'no reachable edge'}` +
    `${r && r.partial ? `, best ${round1(r.residual)} blocks short` : ''}.`);
}

// ---------------------------------------------------------------------------
// SECTION 5: Step execution functions (edge-type walkers)
// ---------------------------------------------------------------------------

function chooseBuildBlock(bot) {
  const items = bot.inventory?.items?.() || [];
  for (const name of BUILD_PREFS) { const it = items.find(i => i.name === name && i.count > 0); if (it) return it; }
  return null;
}

// How long a body found in the air is given to land before its step begins — a two-block fall is
// under 15 ticks.
const LAND_FIRST_MS = 750;

// stepToFeet: walk (and optionally jump) until the bot's feet occupy the target cell. Arrival
// requires onGround — a mid-air position during a jump arc is not arrival. A run of one: the walking
// loop lives in driveRun, and a single cell with strictFinal and no prejump IS that loop (Law 16 —
// one walker, not a "careful" one beside a "smooth" one).
async function stepToFeet(bot, feetCell, opts = {}) {
  // A body that starts the step in the air lands first, with nothing pressed. A body falling flush
  // against a ceiling ahead, pressing forward, sends the server a move that clips that ceiling; the
  // server refuses it and puts the body back at the same height, every tick, so it never lands.
  if (!bot.entity.onGround) {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    const landBy = Date.now() + LAND_FIRST_MS;
    while (!bot.entity.onGround && Date.now() < landBy) await sleep(50);
  }
  // opts.stallMs passes straight through, including `null` (the door step's stall waiver — see
  // drive.js). `undefined` stays undefined so driveRun applies its own default.
  const r = await driveRun(bot, [feetCell], { timeoutMs: opts.timeoutMs || 1500, strictFinal: true, stallMs: opts.stallMs });
  return r.arrived || (bot.entity.onGround && bot.entity.position.floored().equals(feetCell));
}

// stepAwayFromGoal — the navigator's near-goal unstick. A* never steps backward first, so a bot
// pinned under a protected overhang returns no path though a side approach is open. Steps to a safe
// adjacent floor pointing away from the goal, so the next A* plans from open ground. Same-Y lateral
// step, reuses stepToFeet; returns true only if the bot changed cells.
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
    if (isStationFloor(floorBlock)) continue;                // this retreat is an endpoint too — never park on a station (Law 17)
    const dest = new Vec3(feet.x + dx, feet.y, feet.z + dz);
    await stepToFeet(bot, dest, { timeoutMs: 1200 });
    if (!bot.entity.position.floored().equals(feet)) return true;
  }
  return false;
}

// badFooting(bot) → a reason string, or null when the body can walk out of where it stands. One
// function because the guard below asks it twice — to act, and to verify the action worked — so
// both checks share one criterion (Law 25). Two ways to be stuck:
//   no_support — nothing solid underfoot. inside_X — an open-top container: the block below is
//   solid but the body is walled in on four sides.
function badFooting(bot) {
  const feet = bot.entity.position.floored();
  const feetBlock = bot.blockAt(feet);
  if (feetBlock && isOpenTopContainer(feetBlock)) return `inside_${feetBlock.name}`;
  const support = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
  if (!support || support.boundingBox === 'empty') return 'no_support';
  return null;
}

// escapeLandings(bot) → feet cells the body may legally end up in, cheapest first: four same-level
// neighbours, then four one step up. Scanned through classifyFloorInline, A*'s own verdict (Law 16).
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

// jumpOutStep — the only edge whose job is leaving a cell, not entering one: standing in an
// open-top container whose rim is over the 0.6 auto-step, so `forward` alone presses into the
// wall. Jump is held (not tapped) for the whole crossing. No dig, no bridge, no place — the
// destination is already A*-standable, so this step only gets the body out and onto it, nothing
// else (Law 0).
async function jumpOutStep(bot, feetTarget) {
  bot.setControlState('jump', true);
  // withCleanup, not a guard: the hold must be released on every exit (landed, timed out, or a
  // throw out of the mover) or the body keeps hopping through whatever runs next.
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

// headCellBlocks — the cell the head crosses on a step up or down holds a block the search did not price
// for this edge. The search prices that cell on the dig_stair edges alone, so on a climb edge the step
// ends here and the re-plan reads the cell (closed ground, protected voxel, dig cost) before anything is dug.
function headCellBlocks(bot, cell, edgeType) {
  const b = bot.blockAt(cell);
  if (!b || b.name === 'air' || b.boundingBox === 'empty' || isBlockPassable(b)) return false;
  watcher.warn('navigator', `${edgeType} stopped: ${b.name} stands at (${cell.x},${cell.y},${cell.z}), the cell the head crosses, `
    + `and this route did not plan to dig it — re-planning with that cell read.`);
  return true;
}

async function stairUpStep(bot, dir, edgeType) {
  const feet = bot.entity.position.floored();
  const foundationPos = new Vec3(feet.x + dir.x, feet.y - 1, feet.z + dir.z);
  const treadPos = new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z);
  const upFeet = new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z);
  const solid = (b) => b && b.name !== 'air' && b.boundingBox !== 'empty';
  if (edgeType === 'climb_up' && headCellBlocks(bot, feet.offset(0, 2, 0), edgeType)) return false;

  // The three cells an ascent needs open — the origin's own ceiling (feet.offset(0,2,0)), the tread's
  // headroom, and the landing's headroom. performDig's report is read: a refused dig (protected
  // voxel, missing tool, unreachable face) returns false here, so the step never falls through to
  // a jump into a ceiling still there and misreports as a locomotion fault (Law 25).
  for (const c of [feet.offset(0, 2, 0), treadPos.offset(0, 1, 0), upFeet.offset(0, 1, 0)]) {
    const b = bot.blockAt(c);
    if (!solid(b)) continue;
    if (!await performDig(bot, b.position, b, 'navigator')) {   // one dig route (Law 16)
      watcher.warn('navigator', `stair up refused: ${b.name} at (${c.x},${c.y},${c.z}) would not clear `
        + `— the ascent is blocked by a block this body may not or cannot break, not by the step.`);
      return false;
    }
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
    // sneak and its guaranteed release, the aim and the click. sneak: true, not 'auto' — the crouch
    // holds the body on the block it is stepping up FROM, a fact about the move, not the anchor.
    await performPlace(bot, treadPos, foundation, new Vec3(0, 1, 0), item.name, 'navigator', { sneak: true });
    // The place result is not read: the world is asked instead, since only the world can tell an
    // accepted packet from a dropped one.
    tread = bot.blockAt(treadPos);
    if (!solid(tread)) return false;
  }

  return await stepToFeet(bot, upFeet);
}

// mineflayer emits forcedMove when the server sets the body's position; the last one is kept on the body
// for a failed step's report. Hooked once per body.
function watchServerPosition(bot) {
  if (bot._navForcedMoveHooked) return;
  bot._navForcedMoveHooked = true;
  bot.on('forcedMove', () => {
    const q = bot.entity.position;
    bot._navLastServerPosition = { at: Date.now(), x: q.x, y: q.y, z: q.z };
  });
}

async function stairDownStep(bot, dir, edgeType) {
  watchServerPosition(bot);
  const feet = bot.entity.position.floored();
  const downFeet = new Vec3(feet.x + dir.x, feet.y - 1, feet.z + dir.z);
  const landBlock = bot.blockAt(downFeet.offset(0, -1, 0));
  if (!landBlock || landBlock.name === 'air' || landBlock.boundingBox === 'empty') return false;
  if (edgeType === 'climb_down' && headCellBlocks(bot, new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z), edgeType)) return false;
  for (const c of [new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z), downFeet, new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z)]) {
    const b = bot.blockAt(c);
    if (b && b.name !== 'air' && b.boundingBox !== 'empty') {
      await performDig(bot, b.position, b, 'navigator');   // one dig route — equips + verifies (Law 16); never throws
    }
  }
  const from = bot.entity.position.clone();
  // The body's path through the step, one sample per physics tick, so a failed step shows whether the
  // body hopped, slid, fell or never moved.
  const path = [];
  const sample = () => {
    const q = bot.entity.position;
    if (path.length < 40) path.push(`${q.x.toFixed(2)},${q.y.toFixed(2)}${bot.entity.onGround ? 'g' : ''}`);
  };
  bot.on('physicsTick', sample);
  const ok = await withCleanup('navigator', 'stair-down path sample', () => stepToFeet(bot, downFeet),
    () => { bot.removeListener('physicsTick', sample); });
  if (!ok) {
    const cells = [new Vec3(feet.x, feet.y + 2, feet.z), new Vec3(feet.x + dir.x, feet.y + 1, feet.z + dir.z),
      new Vec3(feet.x + dir.x, feet.y, feet.z + dir.z), downFeet, downFeet.offset(0, -1, 0)]
      .map(c => `(${c.x},${c.y},${c.z})=${bot.blockAt(c)?.name ?? 'unloaded'}`).join(' ');
    const p = bot.entity.position, v = bot.entity.velocity;
    const near = Object.values(bot.entities || {})
      .filter(e => e && e !== bot.entity && e.position && e.position.distanceTo(p) <= 2)
      .map(e => `${e.username || e.name || e.type}@(${e.position.x.toFixed(2)},${e.position.y.toFixed(2)},${e.position.z.toFixed(2)})`)
      .join(' ') || 'none';
    const tp = bot._navLastServerPosition;
    // Full precision: a body flush with a block face differs from one touching it only past the 5th place.
    const serverMoved = tp ? `server set position ${Date.now() - tp.at}ms ago to (${tp.x.toFixed(9)},${tp.y.toFixed(9)},${tp.z.toFixed(9)})` : 'no server position correction seen';
    const ahead = new Vec3(feet.x + dir.x, feet.y + 2, feet.z + dir.z);
    watcher.warn('navigator', `stair-down step did not land: from (${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}) `
      + `to (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) aiming (${downFeet.x},${downFeet.y},${downFeet.z}); `
      + `onGround=${bot.entity.onGround} velocity=(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}) `
      + `collided h=${bot.entity.isCollidedHorizontally} v=${bot.entity.isCollidedVertically}; cells ${cells}; `
      + `ceiling ahead (${ahead.x},${ahead.y},${ahead.z})=${bot.blockAt(ahead)?.name ?? 'unloaded'}; `
      + `bodies within 2 blocks: ${near}; ${serverMoved}; `
      + `controls ${Object.entries(bot.controlState).filter(([, on]) => on).map(([k]) => k).join('+') || 'none'} `
      + `physics=${bot.physicsEnabled} inWater=${bot.entity.isInWater}; `
      + `path x,y per tick (g = on ground, ${path.length} ticks) ${path.join(' ')}`);
  }
  return ok;
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
// Safe-descent gate (Law 17): legal only when
//   (a) the feet cell is safe — not standing in a liquid;
//   (b) the block being dug (feet-1) is a real solid, not a hazard we'd breach into;
//   (c) the landing one below it (feet-2) is a safe solid — a one-block drop, never into a cavity
//       or lava;
//   (d) no side of the hole is a liquid/hazard that would flood or burn in.
// isNotSafeSurface is the single shared hazard gate (Law 16), reading null/unloaded as unsafe (Law
// 13). describeDoor reads the door predicate from pathfinding_utils — the same one the route search
// mints the edge with (Law 16) — since the opener (survival_instincts.doorHandlerTick) reports nothing.
function describeDoor(bot, cell) {
  const block = bot.blockAt(cell);
  if (!block) return 'unloaded';
  if (!isDoorBlock(block)) return `${block.name} (not a door)`;
  const props = guardExternalSync('navigator', 'read door properties', () => block.getProperties?.());
  if (!props.ok || !props.value) return `${block.name} (properties unreadable)`;
  return `${block.name} ${String(props.value.open) === 'true' ? 'OPEN' : 'shut'}`;
}

// How long the body is given to fall its one block before the drop is measured — roughly 6 server
// ticks for a one-block fall.
const DIG_SETTLE_MS = 250;

// Why the last digDownStep did not drop the body, for the caller that has to say it (descendColumn):
// this module's own lines are routine-quiet and reach disk only on an error.
let _digDownStall = null;
function digDownStall() { return _digDownStall; }

async function digDownStep(bot) {
  const feet = bot.entity.position.floored();
  _digDownStall = null;

  // Every refusal names itself (gate + detail) so a stalled descent is readable from the trace.
  // summary(), not warn() — a gate refusing is the guard working (Law 17), not a fault.
  const refuse = (gate, detail) => {
    _digDownStall = `gate ${gate}: ${detail}`;
    watcher.summary('navigator', `Dig-down refused at (${feet.x},${feet.y},${feet.z}) — ${_digDownStall}.`);
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
    if (isHazardBeside(sideLow)) {
      return refuse('d (wall at hole level)', `(${floorPos.x + dx},${floorPos.y},${floorPos.z + dz}) is ${sideLow ? sideLow.name : 'unloaded'}`);
    }
    const sideHigh = bot.blockAt(new Vec3(floorPos.x + dx, floorPos.y + 1, floorPos.z + dz));
    if (isHazardBeside(sideHigh)) {
      return refuse('d (wall at feet level)', `(${floorPos.x + dx},${floorPos.y + 1},${floorPos.z + dz}) is ${sideHigh ? sideHigh.name : 'unloaded'}`);
    }
  }

  await performDig(bot, floorBlock.position, floorBlock, 'navigator');   // one dig route (Law 16)
  await sleep(DIG_SETTLE_MS);

  const final = bot.entity.position.floored();
  const dropped = final.y < feet.y;
  if (dropped) { watcher.summary('navigator', `Dug down to (${final.x},${final.y},${final.z}).`); return true; }

  // A non-drop is read-only diagnosis, never a retry: the offset from the cell centre distinguishes
  // a body held up by an overhanging hitbox on a neighbouring column (0.6-wide body, 0.4 strict
  // arrival tolerance can leave 0.2 across a cell boundary) from a dig that never landed.
  const floorNow = bot.blockAt(floorPos);
  const wentAway = !floorNow || floorNow.name === 'air' || floorNow.boundingBox === 'empty';
  const vy = bot.entity.velocity && typeof bot.entity.velocity.y === 'number' ? bot.entity.velocity.y.toFixed(3) : 'unknown';
  const p = bot.entity.position;
  const offX = p.x - (feet.x + 0.5), offZ = p.z - (feet.z + 0.5);
  _digDownStall = wentAway ? 'the block below was dug and the body did not drop' : `the dig of ${floorBlock.name} below did not land`;
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
  // setControlState's only throw is our own bad literal, so it is unguarded (Law 13) — here and below.
  bot.setControlState('forward', true);
  let ok = false;
  // withCleanup, not a guard: the presses must be released on every exit or the body swims on into
  // whatever runs next.
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

// waterBankOutStep: out of water onto a bank that stands one block over it (pathfinding's water_bank_out).
// `top` is the bank's top floor. The surface water cell that touches both the body's column and the bank is
// filled with one block set against the bank's side; the body leaves the water onto that block as it
// leaves onto any level bank, and takes the one step up from it. `from` is the water cell the plan leaves by.
async function waterBankOutStep(bot, top, from) {
  const here = { x: from.x, z: from.z };   // the water cell the plan leaves from, not wherever the last swim step let go
  const y = top.y - 1;
  const fill = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dz]) => new Vec3(here.x + dx, y, here.z + dz))
    .find(c => Math.abs(c.x - top.x) + Math.abs(c.z - top.z) === 1 && isFluid((bot.blockAt(c) || {}).name));
  if (!fill) {
    watcher.warn('navigator', `water_bank_out to (${top.x},${top.y + 1},${top.z}): no surface water cell beside (${here.x},${here.z}) touches that bank.`);
    return false;
  }
  const items = bot.inventory.items();
  const item = BRIDGE_PREFS.map(name => items.find(i => i.name === name && i.count > 0)).find(Boolean);
  if (!item) { watcher.warn('navigator', 'water_bank_out: no block to place.'); return false; }
  const side = bot.blockAt(new Vec3(top.x, y, top.z));
  // The server sets no block into a cell a body overlaps, and a swim step ends anywhere within 0.8 of its
  // cell's centre. The body is brought to the middle of its own cell before the block is set beside it.
  const mid = { x: here.x + 0.5, z: here.z + 0.5 };
  await withCleanup('navigator', 'centre in the water cell', async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const p = bot.entity.position;
      const dx = mid.x - p.x, dz = mid.z - p.z;
      if (Math.hypot(dx, dz) <= 0.15) break;
      await guardExternal('navigator', 'look toward the cell centre', () => bot.look(Math.atan2(-dx, -dz), 0, true));
      bot.setControlState('forward', true);
      await sleep(50);
    }
  }, () => bot.setControlState('forward', false));
  const placed = await performPlace(bot, fill, side, new Vec3(fill.x - top.x, 0, fill.z - top.z), item.name, 'navigator', { sneak: false });
  if (!placed.ok) {
    watcher.warn('navigator', `water_bank_out: block not set at (${fill.x},${fill.y},${fill.z}) — ${placed.reason}`);
    return false;
  }
  if (!(await swimStep(bot, fill))) return false;
  await waitUntilSettled(bot);
  const stood = bot.entity.onGround && Math.floor(bot.entity.position.y + 0.01) === fill.y + 1;
  watcher.summary('navigator', `WATER_BANK_OUT set ${item.name} at (${fill.x},${fill.y},${fill.z}), stood_on_it=${stood}, to (${top.x},${top.y + 1},${top.z}).`);
  if (!stood) return false;
  return stairUpStep(bot, { x: top.x - fill.x, z: top.z - fill.z }, 'climb_up');
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

// What a navigation spent on searching, posted here since forwardToJudge is the single exit every
// navigation takes. `partial`/`failed` are left in even when zero (Law 25). Split by owner because
// the census is process-wide and other writers run under their own, shorter deadline.
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
    ` | workspace wait ${c.workspaceWaitMs}ms, active ${c.activeMs}ms, memoryLimited ${c.resourceLimited}` +
    ` | by owner: ${owners}.`);
}

// Both exits stamp the feet cell, and both may run on a path where the body is gone (disconnect, death
// mid-trip). Optional chaining, not a guard: the absence of an entity is a state to READ, and
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

// One exit only: forwardToJudge. A second exit that never fires is a pathway nobody maintains
// (Law 16); any future halt is a new verdict through this same terminus.

// ---------------------------------------------------------------------------
// SECTION 7: Receive (signal bus entry point) and navigation orchestrator
// ---------------------------------------------------------------------------
// planRouteForTest — plan-only test seam. Runs the same A* the navigator's STEP 2/3 runs, but
// walks nothing: no step execution, no signal bus, no recursive_judge. Reuses the real pathfinder
// (Law 16); the only authored input is the standpoint — everything else is read, never simulated.
//   standCoord {x,y,z} — the work-stand (feet cell); goal floor is y-1, as STEP 2 derives it.
//   opts.startCoord {x,y,z} — authored standpoint to plan FROM; defaults to the bot's real feet.
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
    maxNodes: opts.maxNodes, sense: () => freshSearchState(bot, goal),
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
  waterStepsForTest: { swimStep, waterBankOutStep },   // the two water walkers, for a live probe to drive one at a time
  // Exported for locomotion_dispatcher.descendColumn, which loops it to sink a scanned column
  // straight down — reused so both pathways share one safe-descent gate and one dig-down (Law 16).
  // Stays inside the locomotion folder — no executor calls it directly.
  digDownStep,
  digDownStall,
  // Exported for inspection, not routing: answers what the bot refuses to dig or bridge over
  // (Law 6). Pure read; a caller cannot change locomotion by touching it.
  loadProtectedBlocks,
  // The boxes a route may not enter, for a caller pricing a route the navigator will later walk
  // (drop_collector.priceRouteTo) — the price and the walk read one list (Law 16).
  loadClosedBoxes,
  // Whose closed ground a stand cell falls in, for a caller reporting a walk the search refused.
  closedBy,
  // The lookahead dial, exported so a live move test can set it per run (see move_injector).
  setRunLookahead, getRunLookahead, setRunPrejump, getRunPrejump, RUN_LOOKAHEAD_DEFAULT,
};

// Unguarded, deliberately: a throw here reaches master_core's crash reporter, never dressed as a
// no-progress trip the judge would retry forever (Law 25, Law 13).
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
    // correct side of the target. This is placement's goal (an angle a raycast can answer), not a
    // general interaction goal — station approach belongs to `locomotion.goToStationStance`.
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
  if (capsule.max_y != null) goal.max_y = capsule.max_y;
  if (capsule.walk_only) goal.walk_only = true;

  // --- STEP 3: Run A* ---
  const protectedBlocks = loadProtectedBlocks(bot);
  let result = await computeAStar(bot, botFloor, goal, { sense: () => freshSearchState(bot, goal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: !goal.walk_only });

  // An exact cell over a void or in open air needs no special mode: the single weighted search
  // reaches it and bridges/pillars the final gap as the cheapest route (Law 16: one search, one
  // cost model — no separate greedy "build-delivery" re-plan).

  // Near-goal no-path recovery for non-exact goals: a null result close to the goal is usually a
  // local dead spot (the bot pinned in a pocket), and A* never retreats first. One lateral step to
  // open ground, then one re-plan; hands A* a better vantage only, arrival stays Step 6's verdict.
  if (!result && !capsule.exact && !capsule.require_los && !capsule.required_side && nearestDist <= UNSTICK_RADIUS) {
    capsule.selected_target = { name: nearest.name, position: nearest.position };
    if (await stepAwayFromGoal(bot, nearest.position)) {
      const uf = bot.entity.position.floored().offset(0, -1, 0);
      watcher.summary('navigator', `Unstick: stepped clear of a near-goal dead spot to (${uf.x},${uf.y + 1},${uf.z}), re-planning.`);
      result = await computeAStar(bot, uf, goal, { sense: () => freshSearchState(bot, goal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: !goal.walk_only });
    }
  }

  // No route at all from a floor with running water round the feet: prevent-flow refuses every dig beside
  // that water, so the search ends on its first node. The way out is by placing — stop_flow plugs what
  // feeds the cell — then one re-plan from the same floor.
  if (!result && !goal.walk_only) {
    const { stopFlow, standingInFlow } = require('@utils/movement/stop_flow');
    if (standingInFlow(bot) && (await stopFlow(bot)).stopped) {
      const df = bot.entity.position.floored().offset(0, -1, 0);
      result = await computeAStar(bot, df, goal, { sense: () => freshSearchState(bot, goal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: true });
    }
  }

  if (!result) {
    // A* found no reachable path — soft-fail to judge for retry.
    const failReason = capsule.require_los ? 'astar_no_los_vantage' : 'astar_no_path';
    // A goal a working peer has closed is refused before the search starts; the line names the holder.
    const np = nearest.position;
    const peerArea = require('@kernel/foreman_link').peerAreaAt(Math.floor(np.x), Math.floor(np.y), Math.floor(np.z));
    watcher.warn('navigator', `A* found no path (${failReason})${peerArea ? ` — the goal (${Math.floor(np.x)},${Math.floor(np.y)},${Math.floor(np.z)}) is inside ground ${peerArea.botId} has closed (${peerArea.key})` : ''} — soft-fail to judge for retry.`);
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
    // Path is empty — already at the goal. For LOS goals, A* confirmed checkLOS passed at the
    // start node, so no movement is needed.
    const d = dist(botFeet, selectedTarget.position);
    const alreadyThere = capsule.require_los ? true
      : capsule.exact ? botFeet.equals(exactFeetCell(selectedTarget.position))
      : arrived(botFeet, selectedTarget.position);
    return forwardToJudge(payload, alreadyThere, d, 'empty_path');
  }

  const pathEndFloor = astarPath[astarPath.length - 1].pos;
  const isPartial = result.partial === true;
  // Posted on every plan line, not only when the tripwire fires below, so search time is on record
  // for cheap searches too — nodes measure what the search examined, time measures what the body
  // stood still for, and the two are not interchangeable.
  const searchMs = Date.now() - tSearch;
  watcher.summary('navigator', `A* path: ${astarPath.length} step(s) [${edgeHistogram(astarPath)}], cost ${round1(result.cost)}, ${result.nodesVisited} nodes, ${searchMs}ms${isPartial ? ` (PARTIAL, residual ${round1(result.residual)})` : ''} -> (${pathEndFloor.x},${pathEndFloor.y + 1},${pathEndFloor.z}).`);

  announceFirstMove(astarPath.length);

  // Performance tripwire (see NAV_SLOW_PLAN_MS). Non-fatal: warn, then fall through and walk the
  // valid plan. Reports the measured evidence (ms, nodes, hop distance) without asserting a
  // cause; only the distance tells the two candidate causes apart.
  if (searchMs > NAV_SLOW_PLAN_MS) {
    const hop = Math.round(dist(botFeet, selectedTarget.position));
    // Search effort follows the winning route's COST, not its distance: read it beside a CUTTING THE BUILD
    // warning (goal enclosed by the structure) or a PARTIAL (goal unreachable, frontier ran to the deadline).
    watcher.warn('navigator',
      `SLOW-NAV route search ${searchMs}ms (${result.nodesVisited} nodes, cost ${round1(result.cost)}) ` +
      `(${botFeet.x},${botFeet.y},${botFeet.z}) → (${selectedTarget.position.x},${selectedTarget.position.y},${selectedTarget.position.z}), ` +
      `hop ${hop} blocks, over the ${NAV_SLOW_PLAN_MS}ms line.`);
  }

  // A route through a protected voxel is the fleet electing to break its own structure — A* only
  // elects it after proving no detour under PROTECTED_VOXEL_DETOUR_BUDGET extra steps exists.
  // warn(), same reasoning as the slow-nav tripwire above. Fires only once the cut survives into
  // the walked route — considering one fires on nearly every base-adjacent plan.
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

  // Same shape as the cut above: a dig on this route will open lava into the hole it makes (a dig
  // onto water is no edge at all). A* prices it at LAVA_FLOW_DETOUR_BUDGET, so a surviving charge
  // proves nothing else reaches the goal.
  const breaches = astarPath.filter(s => s.flowCharge > 0);
  if (breaches.length) {
    const where = breaches.slice(0, 6).map(s => `${s.edgeType}@(${s.pos.x},${s.pos.y + 1},${s.pos.z})`).join(' ');
    watcher.warn('navigator',
      `OPENING LAVA — this route digs ${breaches.length} face(s) that lava will flow into and the bot is walking it. ` +
      `${where}${breaches.length > 6 ? ` +${breaches.length - 6} more` : ''}. ` +
      `A* charges ${LAVA_FLOW_DETOUR_BUDGET} for it and returns the cheapest route, so this is a PROOF that no ` +
      'other route reaches the goal. If the goal did not need to be reached through a lava wall, the caller is ' +
      'aiming at the wrong cell.');
  }

  // --- STEP 5: Walk the path step-by-step using edge dispatch ---
  // A failed step prices UP that move and re-plans, keyed on cell|edgeType so only the failed move
  // is charged. PENALTY_LADDER is capped at PROTECTED_VOXEL_DETOUR_BUDGET (Law 16), reading the
  // existing named tiers so the ladder tracks the cost model.
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
  // Carve ledger — every dig/place edge this trip executes, folded into one inspection line at exit
  // (Law 5).
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

  // Streaming-replan stall guard: a PARTIAL A* path to an unreachable goal walks its steps
  // "successfully" yet never closes the last gap, replanning forever. Tracks the best
  // distance-to-target; N consecutive replans with no real gain gives up to the judge. Bounds the
  // success branch, unlike the failure-branch MAX_REPLANS.
  let bestRemaining = Infinity;
  let stallReplans = 0;
  const MAX_STALL_REPLANS = 6;

  // No replan cadence: the trigger is verification failure or a spent path segment (see the walk
  // loop below); each replan says so where it happens (`replanFromHere`).

  // Run ledger — same shape as the carve ledger, same reason (Law 5). broken/taken is the ratio that
  // matters: a run that keeps breaking is a lookahead reading further than the ground supports.
  let runsTaken = 0, runsBroken = 0, runCellsCrossed = 0, runPrejumps = 0;
  // Jump presses split by bearing: whether a diagonal jump-up leaves the ground at the right speed.
  // `late` counts a press the plan itself declined to certify; its rate on diagonals vs. axials is
  // the measurement, since the plan's own verdict cannot report an error in itself (Law 26).
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

  // ── Candidate exhaustion ─────────────────────────────────────────────────────────────────────
  // A candidate set tries every candidate before giving up. When a committed target stalls, its
  // floor cell is retired here and the multi-goal is replanned over the survivors; give-up waits
  // until the set is empty, which terminates since the set is finite.
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
    if (goal.max_y != null) nextGoal.max_y = goal.max_y;
    if (goal.walk_only) nextGoal.walk_only = true;
    const fromFloor = bot.entity.position.floored().offset(0, -1, 0);
    const r = await computeAStar(bot, fromFloor, nextGoal, { movePenalties, sense: () => freshSearchState(bot, nextGoal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: !goal.walk_only });
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

  // replanFromHere — builds a whole new route to the same goal, in place: a stale route is remade
  // in full, never cut short. One function for two callers (Law 16); more than a computeAStar call
  // since a replan landing on a different multi-goal candidate must move `selectedTarget` (Law 25).
  // Returns true when a fresh route is loaded, false when the search found nothing.
  async function replanFromHere(why) {
    const rFeet = bot.entity.position.floored();
    const rFloor = new Vec3(rFeet.x, rFeet.y - 1, rFeet.z);
    const tReplan = Date.now();
    const rResult = await computeAStar(bot, rFloor, goal, { movePenalties, sense: () => freshSearchState(bot, goal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: !goal.walk_only });
    const replanMs = Date.now() - tReplan;
    if (!rResult || rResult.path.length === 0) return false;
    currentPath = rResult.path;
    stepIdx = 0;
    if (targets.length > 1 && rResult.target) {
      let mt = targets[0], md = Infinity;
      for (const t of targets) { const d2 = straightLine(rResult.target, t.position); if (d2 < md) { md = d2; mt = t; } }
      selectedTarget = { name: mt.name, position: currentPath[currentPath.length - 1].pos.offset(0, 1, 0) };
      capsule.selected_target = selectedTarget;
    }
    // Said here, not deferred to the progress heartbeat, so a replan followed by a failed step still
    // prints. The reason trails the numbers, matching the shape the route-cost lens'
    // `replan (\d+) step\(s\)` pattern reads (Law 16). Navigator is a hardened-quiet stage (watcher.js
    // ROUTINE_QUIET), so this is silent on an ordinary run; set AUREN_VERBOSE=navigator to measure it.
    watcher.summary('navigator', `replan ${currentPath.length} step(s), cost ${round1(rResult.cost)}, `
      + `${rResult.nodesVisited} nodes (${replanMs}ms) — ${why}.`);
    return true;
  }

  // How many times the world may move under one walk before it is abandoned. Consecutive, reset by
  // real progress (Invariant B) — a busy site can legitimately meet several genuine changes and route
  // around each. Named WORLD_MOVED and not STALE (MAX_STALL_REPLANS): a stall means replanning is
  // not getting closer, while WORLD_MOVED means the held route has stopped being legal (Law 7).
  const MAX_WORLD_MOVED_REPLANS = 3;
  let worldMovedReplans = 0;
  let bestSinceWorldMoved = Infinity;

  while (stepIdx < currentPath.length && !walkDone) {
    // 'locomotion' is a trace label, not a behaviour switch (battleStations branches only on
    // 'sentry'); kept because the `source` field separates a fight walked into from one an executor
    // polled. Safe to await here: the fight routes no signals, and on a win the tail abandons this
    // line to recursive_judge.
    await combatCheckpoint(bot, 'locomotion');

    // ── VERIFY BEFORE STEPPING, NOT AFTER ───────────────────────────────────
    // The whole route is rechecked every iteration, not one block ahead: a check run only after a
    // step cannot stop the body walking into a cell another body just changed. `pathStillWalkable`
    // is ~4 reads per unwalked cell against ~1.4M nodes for a replan. A dead search here is not a
    // give-up — it counts as a failure and falls to the normal give-up ladder below.
    const peerGround = entersPeerGround(currentPath, stepIdx, bot.entity.position.floored().offset(0, -1, 0));
    if (peerGround || !pathStillWalkable(bot, currentPath, stepIdx)) {
      const remainingNow = dist(bot.entity.position.floored(), selectedTarget.position);
      if (remainingNow < bestSinceWorldMoved - 0.5) { bestSinceWorldMoved = remainingNow; worldMovedReplans = 0; }
      if (++worldMovedReplans > MAX_WORLD_MOVED_REPLANS) {
        watcher.warn('navigator', `The world moved under this route ${worldMovedReplans - 1} times without progress — `
          + `still ${round1(remainingNow)} blocks from '${selectedTarget.name}'. Giving up to the judge.`);
        flushCarves(); flushRuns();
        await diagnoseGiveUp(bot, selectedTarget.position, 'route_kept_changing', goal, protectedBlocks);
        return forwardToJudge(payload, false, remainingNow, 'route_kept_changing');
      }
      const moved = peerGround ? `${peerGround.botId} closed the ground ahead (${peerGround.key})` : 'world moved';
      if (await replanFromHere(`${moved}, ${worldMovedReplans}/${MAX_WORLD_MOVED_REPLANS}`)) continue;
      // No route from here to the goal at all. Not this check's call to make — a candidate may be
      // genuinely unreachable, which the retarget ladder already owns.
      if (await retargetToNextCandidate()) continue;
      watcher.warn('navigator', `Route broke and nothing reachable replaced it — ${round1(remainingNow)} blocks from '${selectedTarget.name}'. Giving up to the judge.`);
      flushCarves(); flushRuns();
      await diagnoseGiveUp(bot, selectedTarget.position, 'no_route_after_change', goal, protectedBlocks);
      return forwardToJudge(payload, false, remainingNow, 'no_route_after_change');
    }

    const curFeet = bot.entity.position.floored();
    const step = currentPath[stepIdx];
    const curFloor = new Vec3(curFeet.x, curFeet.y - 1, curFeet.z);
    const dir = { x: step.pos.x - curFloor.x, z: step.pos.z - curFloor.z };

    // ── the fused run, tried before the per-edge switch ──────────────────────────────────────────
    // Two or more consecutive edges of a runnable type whose cells are already passable walk as one
    // continuous press; anything else collapses to the per-edge switch below. At RUN_LOOKAHEAD 1 the
    // `>= 2` gate never fires. Leaf reflex: autoclears the destination's feet, head and the cell
    // above unconditionally, since every predicate upstream already treats a phantom leaf as air. A
    // blueprint's leaf is not touched — leaf_authority.isPhantom refuses it (Law 25).
    await leafAuthority.clearStance(bot, step.pos.offset(0, 1, 0));

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
    // The step in hand, stamped on the body for the fall alert (survival_instincts reads it).
    bot._navStep = { at: Date.now(), edge: step.edgeType, to: step.pos.offset(0, 1, 0), from: curFeet, run: runCells.length,
      goal: selectedTarget.position, exact: !!capsule.exact };
    watchServerPosition(bot);
    await require('@kernel/server_pulse').answering(bot);
    const stepStartPos = bot.entity.position.clone();
    const stepStartedAt = Date.now();
    let ok = false;
    let runHandled = false;
    if (runCells.length >= 2) {
      // A cell only needs the exact centre when something is about to be done there: the
      // destination, or a carve edge whose primitive places/digs from the stand cell. Every other
      // run end is a cell the body is passing through, so it is entered, not stood on.
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
        // The shared ok-branch below owns all progress bookkeeping. A run that crossed n cells
        // credits n-1 here and lets that branch credit the last, so a fused run and a single step
        // account identically.
        stepIdx += r.crossed - 1;
        runHandled = true;
        ok = true;
      }
    }

    if (!runHandled) switch (step.edgeType) {
      case 'walk':        ok = await bridgeLevelStep(bot, dir); break;
      case 'jump_out':    ok = await jumpOutStep(bot, step.pos.offset(0, 1, 0)); break;
      case 'climb_up':    ok = await stairUpStep(bot, dir, step.edgeType); break;
      case 'climb_down':  ok = await stairDownStep(bot, dir, step.edgeType); break;
      case 'door': {
        const feetTarget = step.pos.offset(0, 1, 0);
        // This step does not open the door — survival_instincts.doorHandlerTick does, a physicsTick
        // reflex that reports nothing, so the door is read either side of the walk to name which of
        // the three failure causes fired. The door sits midway between the body and the far cell: the
        // edge is minted two cells out so the body never halts inside it, making dir exactly ±2.
        const doorCell = new Vec3(curFloor.x + dir.x / 2, curFloor.y + 1, curFloor.z + dir.z / 2);
        const doorBefore = describeDoor(bot, doorCell);
        // Lines up before going through: a doorway is a one-block gap and the body 0.6 wide, so a
        // legal arrival can still catch the jamb. Centring on the approach cell aligns with the door,
        // since the two share the cross-axis coordinate — the door cell itself is not stand-able.
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
      // A dug stair line arrives here one step at a time (pathfinding_utils unrolls it); each step is
      // the same stairUpStep/stairDownStep walker. What makes it one straight staircase is the search,
      // which only ever offers a whole line.
      case 'dig_stair_up':   ok = await stairUpStep(bot, dir, step.edgeType); break;
      case 'dig_stair_down': ok = await stairDownStep(bot, dir, step.edgeType); break;
      case 'swim':        ok = await swimStep(bot, step.pos); break;
      case 'water_exit':  ok = await swimStep(bot, step.pos); break;
      case 'water_bank_out': ok = await waterBankOutStep(bot, step.pos, stepIdx > 0 ? currentPath[stepIdx - 1].pos : curFloor); break;
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
        watcher.summary('navigator', `Progress: ${round1(remaining)} blocks remaining, at (${p.x},${p.y},${p.z}).`);
        lastProgressLog = now;
      }
      // Re-plan on one of exactly two events, never on a timed cadence:
      //   segmentDone  — the path ran out. A partial must be extended or the bot stops short.
      //   !stillValid  — the world moved under the remaining route, so the plan is now a lie.
      // Re-senses instead of trusting a timer (Invariant B).
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
              // set. Only give up when nothing untried remains (no early surrender).
              if (await retargetToNextCandidate()) { continue; }
              watcher.warn('navigator', `No progress across ${stallReplans} replans — stuck ${round1(remainingNow)} blocks from '${selectedTarget.name}', no untried candidate remains. Giving up to the judge.`);
              flushCarves(); flushRuns();
              await diagnoseGiveUp(bot, selectedTarget.position, 'no_progress', goal, protectedBlocks);
              return forwardToJudge(payload, false, remainingNow, 'no_progress');
            }
            // The same one replan the pre-step check uses (Law 16). The pre-step check at the top of
            // the loop earns its keep only where this one cannot reach: the first iteration, and any
            // iteration following a failed step.
            await replanFromHere(segmentDone ? 'segment ran out' : 'world moved');
          }
        }
      }
      continue;
    }

    // The step did not complete. Its report is written here, before any recovery moves the body, so the
    // readings are the ones the step ended on.
    ledgerStepFailed(bot, step, curFeet, stepStartPos, stepStartedAt);

    // ── Footing recovery: the step target was never the problem — the body's footing was — so this
    // does not blacklist the destination and does not count as a replan attempt. Two passes,
    // cheapest first: pass 1 (microcentre + walk) recovers a body hovering off the side of something;
    // pass 2 clears an open-top container's rim, which pass 1 cannot reach. ─────────────────────────
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
            // loop moves to the next one.
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

        // Pass 2 — clear the rim. Reuses the jump_out edge primitive
        // (Law 16: one way to get a body out of a bin, whether A* planned it or this guard did).
        if (!recovered) {
          const landings = escapeLandings(bot);
          if (landings.length === 0) {
            watcher.warn('navigator', `Jump-out: ${stuckWhy} at (${hovFeet.x},${hovFeet.y},${hovFeet.z}) and NO walkable landing on any of the eight neighbours — nothing to jump to. Leaving it to the judge.`);
          }
          // Unguarded: microCenter and jumpOutStep both report false on a failed landing; neither
          // throws.
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
          const recResult = await computeAStar(bot, recFloor, goal, { movePenalties, sense: () => freshSearchState(bot, goal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: !goal.walk_only });
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
      const replanResult = await computeAStar(bot, replanFloor, goal, { movePenalties, sense: () => freshSearchState(bot, goal), deadlineMs: NAV_SEARCH_DEADLINE_MS, owner: 'navigate', allowWorldAlteration: !goal.walk_only });
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
