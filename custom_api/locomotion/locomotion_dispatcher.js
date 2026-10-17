// fragment: locomotion_dispatcher
// purpose: The Law 15 doorway into the locomotion sub-loop. Exposes goTo and births each inner
//          chain's payload (Law 8 origin), always routing to navigator, which terminates at
//          locomotion_judge.
//
// role: goTo births a payload → navigator walks A* → locomotion_judge verdicts back: 'success'
// resolves the caller's promise, 'retry' dispatches a fresh chain (judge owns the budget),
// 'failure' resolves arrived=false for the caller to re-plan.
//
// invariants: writes nothing to the caller's payload (Law 15); one pending invocation at a time
// (Law 4); malformed goals/missing bot throw (Law 13); state lives in module memory (Law 9) and
// Watcher lines (Law 5); an emergency override drops routing at the bus, abandoning the pending call.
//
// ---------------------------------------------------------------------------
// SECTION 1: Dependencies
// ---------------------------------------------------------------------------
// watcher required at load (Law 5); signal_bus required lazily (avoids the circular load through
// fragment_registry). Law 1: nothing is required from locomotion_judge.
// ---------------------------------------------------------------------------
const watcher = require('@kernel/watcher');
// A FORWARDING router: calls route() with an upstream author's own from/to, so it cannot use
// signal_utils' helpers (they would stamp `from` as this caller).
const signalBus = require('@kernel/signal_bus');

// ---------------------------------------------------------------------------
// SECTION 2: Configuration constants
// ---------------------------------------------------------------------------
// (reserved for future dispatcher-level tuning; routing constants live in the rungs)

// ---------------------------------------------------------------------------
// SECTION 3: Pending-invocation memory (Law 9 module-level scratch state)
// ---------------------------------------------------------------------------
// Holds only what cannot travel in a payload: the resolve function, identity, start time (the
// request and try count live in the payloads, Law 1). invocationCounter flags a stale verdict.
// ---------------------------------------------------------------------------
let pending = null;        // { invocationId, verb, resolve, startedAt }
let invocationCounter = 0; // monotonically increasing invocation id

// ---------------------------------------------------------------------------
// SECTION 4: Goal validation and normalization
// ---------------------------------------------------------------------------
// Two legal goal shapes (D6 — no policy parameters): { x, y, z }, or { candidates_ref,
// candidates_count, candidates_kind } naming a perception file of targets (Law 6). Anything else is a coding violation (Law 13).
// ---------------------------------------------------------------------------

// validCoordinate: true when c is an object with finite numeric x/y/z.
function validCoordinate(c) {
  return !!c && ['x', 'y', 'z'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k]));
}

// normalizeGoal: convert either accepted goal shape into { coordinate, candidates_ref,
// candidates_count, candidates_kind }. Throws on malformed input (Law 13).
function normalizeGoal(verb, goal) {
  if (validCoordinate(goal)) {
    return { coordinate: { x: goal.x, y: goal.y, z: goal.z }, require_los: goal.require_los === true, required_side: goal.required_side || null, min_y: goal.min_y != null ? goal.min_y : null, max_y: goal.max_y != null ? goal.max_y : null, walk_only: goal.walk_only === true, exact: goal.exact === true, candidates_ref: null, candidates_count: 0, candidates_kind: null };
  }
  if (goal && typeof goal.candidates_ref === 'string' && goal.candidates_ref && Number(goal.candidates_count) > 0) {
    return {
      coordinate: null,
      candidates_ref: goal.candidates_ref,
      candidates_count: Number(goal.candidates_count),
      candidates_kind: goal.candidates_kind || 'candidate'
    };
  }
  throw new Error(
    `[locomotion_dispatcher] CODING VIOLATION: ${verb} requires {x,y,z} or {candidates_ref, candidates_count>0, candidates_kind}. Got: ${JSON.stringify(goal)}`
  );
}

// ---------------------------------------------------------------------------
// SECTION 5: Chain dispatch (Law 8 origin — every inner payload is born here)
// ---------------------------------------------------------------------------
// Births the inner payload and routes it to navigator, from the API call (attempt 1) or a judge
// retry echo. The `locomotion` capsule is the sub-loop's typed instruction contract (Law 10):
// goal fields as normalized above; require_los/required_side/min_y/exact — arrival tolerance;
// attempt — which dispatch this is (judge owns the budget); invocation_id — ties the verdict back.
// ---------------------------------------------------------------------------
function dispatchChain(request) {
  // A missing goal means the API validation was bypassed or a judge verdict was authored wrongly (Law 13).
  if (!request || (!validCoordinate(request.coordinate) && !(typeof request.candidates_ref === 'string' && request.candidates_ref))) {
    throw new Error(`[locomotion_dispatcher] CODING VIOLATION: dispatch request carries no valid goal. Got: ${JSON.stringify(request)}`);
  }

  const bot = global.bot;
  // A movement request can only come from a running caller (Law 13).
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: movement API invoked with no bot loaded.');
  }

  const goalText = request.coordinate
    ? `(${request.coordinate.x},${request.coordinate.y},${request.coordinate.z})`
    : `${request.candidates_count} ${request.candidates_kind} candidates in ${request.candidates_ref}`;

  const nextRung = 'navigator';

  const payload = {
    from: 'locomotion_dispatcher',
    to: nextRung,
    task: nextRung,
    readable: `locomotion_dispatcher: dispatch ${request.verb} attempt ${request.attempt} via ${nextRung}`,
    locomotion: {
      verb: request.verb,
      coordinate: request.coordinate,
      require_los: request.require_los || false,
      required_side: request.required_side || null,
      min_y: request.min_y != null ? request.min_y : null,
      max_y: request.max_y != null ? request.max_y : null,
      walk_only: request.walk_only === true, // a route with no dig and no place edge (drop_collector's strip chase)
      exact: request.exact || false, // arrive standing ON the target cell; default false keeps ~1.5 tolerance
      candidates_ref: request.candidates_ref,
      candidates_count: request.candidates_count,
      candidates_kind: request.candidates_kind,
      attempt: request.attempt,
      invocation_id: request.invocationId,
    }
  };

  watcher.summary('locomotion_dispatcher',
    `🚪 ${request.verb} → ${goalText}, entering ladder at '${nextRung}' (attempt ${request.attempt}, invocation #${request.invocationId}).`
  );

  signalBus.route(payload.to, payload);
}

// ---------------------------------------------------------------------------
// SECTION 6: The exposed API
// ---------------------------------------------------------------------------
// Each call returns a promise resolving only on a success verdict from locomotion_judge; on give-up or emergency it never resolves (Law 15).
// ---------------------------------------------------------------------------

// ── THE WALK LEDGER: ONE LINE PER WALK, UNDER A TAG THAT REACHES DISK ──
// A walk is one of two legs. `travel` is getting to the work or away from it: to the site, to a chest or
// a table, back home. `work` is moving about inside the work once it has begun, and a caller says so with
// `leg: 'work'` on its goal. Only travel is counted as walking against the job's time.
const LEGS = Object.freeze(['travel', 'work']);
function _legOf(goal) {
  const leg = (goal && goal.leg) || 'travel';
  if (!LEGS.includes(leg)) {
    throw new Error(`[locomotion_dispatcher] CODING VIOLATION (Law 13): a walk was asked with leg '${leg}'; the legs are ${LEGS.join(' and ')}.`);
  }
  return leg;
}
// Every walk is charged to the job the body holds (bot_minutes' open span: its job token, or idle/startup)
// and to its purpose (the station it walks to, or `move`), so a lens can split commuting from working and
// say where the commute went. `walk_ledger` is not a quiet tag, unlike this file's own.
function _walkCategory() {
  const span = require('@kernel/bot_minutes').snapshot().open_span;
  if (!span) return 'none';
  return span.kind === 'working' ? span.label : `${span.kind}:${span.label || '-'}`;
}
// THIS BODY'S OWN WALKING PACE, measured off the walks it has finished: every arrived walk of PACE_MIN_WALK
// blocks or more adds its flat distance and its time. walkPace() → seconds per block, or null until
// PACE_MIN_TOTAL blocks have been measured.
const PACE_MIN_WALK = 8;
const PACE_MIN_TOTAL = 32;
const _pace = { blocks: 0, ms: 0 };
function walkPace() {
  return _pace.blocks >= PACE_MIN_TOTAL ? (_pace.ms / 1000) / _pace.blocks : null;
}
function _ledgerWalk(p, outcome, endPosition) {
  if (outcome === 'arrived' && p.fromPos && endPosition) {
    const blocks = Math.hypot(endPosition.x - p.fromPos.x, endPosition.z - p.fromPos.z);
    if (blocks >= PACE_MIN_WALK) { _pace.blocks += blocks; _pace.ms += Date.now() - p.startedAt; }
  }
  const held = ((Date.now() - p.startedAt) / 1000).toFixed(1);
  if (p.leg === 'travel') require('@kernel/bot_minutes').walked(Date.now() - p.startedAt, p.category);
  const at = endPosition ? `(${endPosition.x},${endPosition.y},${endPosition.z})` : 'unknown';
  watcher.summary('walk_ledger',
    `walk verb=${p.verb} category=${p.category} purpose=${p.purpose} leg=${p.leg} held=${held}s outcome=${outcome} from=${p.from} to=${at}`);
}

// invoke: validates the goal, claims the single pending slot, and dispatches attempt 1 (retries
// are rebuilt from the judge's verdict echo, never from memory here).
function invoke(verb, goal) {
  const normalized = normalizeGoal(verb, goal); // throws before any state changes
  if (pending) {
    // previous invocation abandoned (give-up/emergency); log and replace.
    watcher.warn('locomotion_dispatcher',
      `⚠️ Invocation #${pending.invocationId} (${pending.verb}) was still pending — treating as abandoned and replacing.`
    );
    _ledgerWalk(pending, 'abandoned', null);
  }
  invocationCounter++;
  const start = global.bot?.entity?.position?.floored?.();
  return new Promise((resolve) => {
    pending = {
      invocationId: invocationCounter,
      verb,
      resolve,
      startedAt: Date.now(),
      category: _walkCategory(),
      purpose: (goal && typeof goal.purpose === 'string' && goal.purpose) || 'move',
      leg: _legOf(goal),
      from: start ? `(${start.x},${start.y},${start.z})` : 'unknown',
      fromPos: start || null,
    };
    dispatchChain({
      verb,
      coordinate: normalized.coordinate,
      require_los: normalized.require_los,
      required_side: normalized.required_side,
      min_y: normalized.min_y,
      max_y: normalized.max_y,
      walk_only: normalized.walk_only,
      exact: normalized.exact,
      candidates_ref: normalized.candidates_ref,
      candidates_count: normalized.candidates_count,
      candidates_kind: normalized.candidates_kind,
      attempt: 1,
      invocationId: invocationCounter
    });
  });
}

// goTo: move toward a goal, succeeding at the closest reachable position if unreachable. bare {x,y,z}
// stands ON the cell (digs through); { require_los: true } is for placing/digging. To USE a station, call goToStationStance below.
//
// A walk into or out of a blueprint's lane (blueprint_survey.getWorldLanes) is made in legs: out by the
// lane's exit, in by its entry, then the goal itself. Each leg is its own invocation, ledgered under
// `lane:exit` / `lane:entry`. A leg that does not arrive ends the walk with arrived=false and names the leg.
async function goTo(goal) {
  const feet = global.bot?.entity?.position?.floored?.();
  if (feet) {
    const survey = require('@perception/blueprint_survey');
    const to = validCoordinate(goal) ? { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) } : null;
    for (const leg of survey.laneLegs(survey.getWorldLanes(), feet, to)) {
      const stand = standOn(leg.anchor, { purpose: `lane:${leg.point}` });
      const now = global.bot.entity.position.floored();
      if (now.x === stand.x && now.y === stand.y && now.z === stand.z) continue;   // already standing in the mouth
      watcher.summary('locomotion_dispatcher',
        `🚪 ${leg.blueprint} lane: walking by its ${leg.point} (${stand.x},${stand.y},${stand.z}) first.`);
      const via = await invoke('goTo', stand);
      if (!via.arrived) {
        watcher.warn('locomotion_dispatcher',
          `🚪 ${leg.blueprint} lane ${leg.point} (${stand.x},${stand.y},${stand.z}) was not reached (${via.reason || 'no reason given'}) — the walk ends here; the caller decides.`);
        return { ...via, reason: `lane_${leg.point}_unreached:${via.reason || 'unknown'}` };
      }
    }
  }
  return invoke('goTo', goal);
}

// standOn: the goal that stands a body ON an anchor block — feet cell anchor + (0,1,0), the one named
// home for that +1 conversion. Defaults exact:true (pass { exact:false } for a tolerant park).
function standOn(anchor, opts = {}) {
  return { x: anchor.x, y: anchor.y + 1, z: anchor.z, exact: true, ...opts };
}

// goToStand: stand ON an anchor block.
function goToStand(anchor, opts = {}) {
  return goTo(standOn(anchor, opts));
}

// reposition: move away from a position to a valid placement vantage — the nearest position at
// least MIN_PLACEMENT_DIST (1.5) away with line of sight to the target, honoring required_side.
async function reposition(awayFrom, opts = {}) {
  const bot = global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: reposition called with no bot loaded.');
  }

  const Vec3 = require('vec3');
  const { computeAStar } = require('@utils/pathfinding_utils');

  const ox = Math.floor(awayFrom.x);
  const oy = Math.floor(awayFrom.y);
  const oz = Math.floor(awayFrom.z);
  const side = opts.required_side || null;

  const botFeet = bot.entity.position.floored();
  const botFloor = new Vec3(botFeet.x, botFeet.y - 1, botFeet.z);

  // Same LOS goal type goTo uses for interaction targets: stops at the cheapest node in
  // [MIN_PLACEMENT_DIST, BLOCK_REACH] with line of sight, refining toward a closer position.
  const goal = { type: 'los', targetPos: { x: ox, y: oy, z: oz }, required_side: side };
  if (opts.min_y != null) goal.min_y = opts.min_y;
  const result = await computeAStar(bot, botFloor, goal, { maxNodes: 500, owner: 'reposition' }); // 500: an economic bound, not a runaway guard

  if (!result) {
    watcher.summary('locomotion_dispatcher',
      `🔄 reposition: no LOS vantage from (${ox},${oy},${oz})${side ? ` [${side} side]` : ''}`);
    return { arrived: false, verb: 'reposition', reason: 'no_los_vantage' };
  }

  // An interrupted search has not proved a placement vantage, even when its best endpoint is the start.
  if (result.partial) {
    return { arrived: false, verb: 'reposition', reason: result.resourceLimited ? 'memory_budget' : 'incomplete_los_search' };
  }
  if (!result.path || result.path.length === 0) { // empty path: already at a valid LOS position
    watcher.summary('locomotion_dispatcher',
      `🔄 reposition: already at valid LOS position for (${ox},${oy},${oz})${side ? ` [${side} side]` : ''}`);
    return { arrived: true, verb: 'reposition', position: botFeet };
  }

  const targetFloor = result.target || result.path[result.path.length - 1].pos;
  const targetFeet = { x: targetFloor.x, y: targetFloor.y + 1, z: targetFloor.z };

  watcher.summary('locomotion_dispatcher',
    `🔄 reposition away from (${ox},${oy},${oz})${side ? ` [${side} side]` : ''} → (${targetFeet.x},${targetFeet.y},${targetFeet.z}) cost=${result.cost.toFixed(1)} [${result.nodesVisited} nodes]`);

  return goTo(targetFeet);
}

// ── goToStationStance: THE ONE WAY A BOT GOES TO USE A STATION ────────────────────────────────────
//
// Stands the bot on a station's authored stance and faces it before returning (Law 16), resolving
// whichever exists: 'anchor' (blueprint's owning anchor, proven to reach every voxel in its group),
// 'recorded' (registry row's `stance` from placement), or 'in_reach' (already within BLOCK_REACH).
// Neither source is a search — both are single authored cells, identical on every run (Law 19).
//
// Returns { arrived, stance, source, blueprint, roomKey, anchorIndex, reason? }: 'no_stance' — no
// cell authored, not in reach, caller decides; 'unassigned' — blueprint owns the cell but filed it
// outside every anchor (Law 25); 'unreachable' — a cell was authored but navigation couldn't reach it.
async function goToStationStance(pos) {
  const bot = global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: goToStationStance called with no bot loaded.');
  }
  const Vec3 = require('vec3'); // matches `reposition` above — this file's convention
  const { BLOCK_REACH } = require('@utils/fragment_utils'); // the one shared interaction distance (Law 16)
  const centre = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
  const face = async () => { await bot.lookAt(centre); };

  const owner = require('@perception/blueprint_survey').resolveVoxelAnchor(pos);

  if (owner && !owner.anchor) {
    watcher.warn('locomotion_dispatcher',
      `🚪 the ${owner.type} at (${pos.x},${pos.y},${pos.z}) belongs to blueprint "${owner.blueprint}" but to no anchor `
      + `(unassigned voxel) — that blueprint needs the voxel filed under an anchor before a bot can use it.`);
    return { arrived: false, stance: null, source: null, blueprint: owner.blueprint, roomKey: owner.roomKey, anchorIndex: -1, reason: 'unassigned' };
  }

  // Blueprint anchor outranks a recorded stance; the latter is consulted only when no blueprint claims the cell.
  let stance = null, source = null, blueprint = null, roomKey = null, anchorIndex = -1;
  if (owner) {
    stance = owner.anchor; source = 'anchor';
    blueprint = owner.blueprint; roomKey = owner.roomKey; anchorIndex = owner.anchorIndex;
  } else {
    const row = require('@perception/station_registry').stationAt(pos);
    if (row && row.stance) { stance = row.stance; source = 'recorded'; }
  }

  if (!stance) {
    // checked only after both authored sources come back empty (no using a station from outside the wall)
    const d = bot.entity.position.distanceTo(centre);
    if (d <= BLOCK_REACH) {
      watcher.summary('locomotion_dispatcher',
        `🚪 station at (${pos.x},${pos.y},${pos.z}) has no authored stance and is already within reach `
        + `(${d.toFixed(1)}b) — using it where the body stands, which is the set-it-down-beside-me case.`);
      await face();
      return { arrived: true, stance: null, source: 'in_reach', blueprint: null, roomKey: null, anchorIndex: -1 };
    }
    watcher.warn('locomotion_dispatcher',
      `🚪 the station at (${pos.x},${pos.y},${pos.z}) has no authored stance — no blueprint claims it and no `
      + `placement stance was recorded for it — and it is ${d.toFixed(1)} blocks away, past the ${BLOCK_REACH}-block `
      + `reach. NOTHING MOVES; the caller decides (for a crafting table, set down its own).`);
    return { arrived: false, stance: null, source: null, blueprint: null, roomKey: null, anchorIndex: -1, reason: 'no_stance' };
  }

  watcher.summary('locomotion_dispatcher',
    `🚪 station at (${pos.x},${pos.y},${pos.z}) → standing on its ${source} stance (${stance.x},${stance.y},${stance.z})`
    + `${source === 'anchor' ? ` [${blueprint} anchor ${anchorIndex}]` : ''}.`);
  // The walk is charged to the station it reaches (the walk ledger's purpose).
  const stationType = owner?.type || require('@perception/station_registry').stationAt(pos)?.type || 'station';
  const nav = await goToStand(stance, { purpose: `station:${stationType}` }); // owns the +1 stand conversion, exact:true by default
  const arrived = !!(nav && nav.arrived);
  if (arrived) await face();
  return {
    arrived, stance, source, blueprint, roomKey, anchorIndex,
    reason: arrived ? undefined : (nav?.reason || 'unreachable'),
  };
}

// ── descendColumn: sink a shaft STRAIGHT DOWN, in one XZ, and never leave it ──────────────────────
//
// Owns the descent half of the vertical stone-prospect design: an ordinary A* route can step aside
// onto a diagonal, since staying in one column is a constraint a route search cannot price (Law 27).
// Loops navigator.digDownStep and implements nothing of its own — every dig-down safety property is
// that function's, re-sensed per step (Invariant B); this adds one constraint: no move in X or Z.
//
// Returns { arrived, y, dug, reason }; `arrived` is true only when the feet reach toFeetY.
async function descendColumn({ x, z, toFeetY }) {
  const bot = global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: descendColumn called with no bot loaded.');
  }
  if (![x, z, toFeetY].every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error(`[locomotion_dispatcher] CODING VIOLATION: descendColumn needs finite {x, z, toFeetY}. Got: ${JSON.stringify({ x, z, toFeetY })}`);
  }

  const { digDownStep, digDownStall } = require('@locomotion/navigator');
  const start = bot.entity.position.floored();

  if (start.x !== x || start.z !== z) { // body must already be on the scanned column (Law 25)
    watcher.warn('locomotion_dispatcher',
      `⛏ descendColumn refused: body at (${start.x},${start.z}) is not on column (${x},${z}). The caller must stand it on the column first.`);
    return { arrived: false, y: start.y, dug: 0, reason: 'not_on_column' };
  }

  const { microCenter } = require('@utils/movement/motion_primitives'); // centre before the first cut: an overhanging hitbox can hold the body up; non-fatal if it fails
  if (!await microCenter(bot, { eps: 0.06 })) {
    watcher.warn('locomotion_dispatcher',
      `⛏ descendColumn could not centre on column (${x},${z}) before opening it — descending anyway; an overhanging hitbox may be caught by a neighbour and refuse to drop.`);
  }

  const budget = Math.max(0, start.y - toFeetY) + 4; // backstop only; the stall check below ends this normally
  let dug = 0;

  for (let i = 0; i < budget; i++) {
    const before = bot.entity.position.floored();
    if (before.y <= toFeetY) return { arrived: true, y: before.y, dug };
    if (before.x !== x || before.z !== z) { // drift off the column is a hard stop
      watcher.warn('locomotion_dispatcher',
        `⛏ descendColumn stopped: body drifted to (${before.x},${before.z}) off column (${x},${z}) after ${dug} dig(s).`);
      return { arrived: false, y: before.y, dug, reason: 'left_column' };
    }
    await digDownStep(bot);
    const after = bot.entity.position.floored();
    if (after.y >= before.y) { // dug counts observed drops, not swings
      // A refused step down is the descent's own gate answering; the caller is handed the reason.
      watcher.summary('locomotion_dispatcher',
        `⛏ descendColumn stalled at y=${after.y} (wanted ${toFeetY}) after ${dug} observed drop(s) — ${digDownStall() || 'the step gave no reason'}.`);
      return { arrived: false, y: after.y, dug, reason: `step_refused (${digDownStall() || 'no reason given'})` };
    }
    dug++;
  }

  const end = bot.entity.position.floored();
  return { arrived: end.y <= toFeetY, y: end.y, dug, reason: end.y <= toFeetY ? undefined : 'budget_exhausted' };
}

// ---------------------------------------------------------------------------
// SECTION 7: Verdict receiver (signal bus entry point)
// ---------------------------------------------------------------------------
// The only legal sender is locomotion_judge — its declared termination point (Law 8):
//   { verdict: 'success', invocation_id, attempt }
//   { verdict: 'retry', invocation_id, attempt, verb, coordinate, candidates_ref/count/kind }
// 'success' resolves the caller's promise with where the bot ended up; 'retry' rebuilds the
// request from the echo and dispatches a fresh chain; 'failure' resolves with arrived=false. The
// dispatcher executes verdicts; it never judges retry-vs-failure.
// ---------------------------------------------------------------------------
module.exports = {
  receive: watcher.track('locomotion_dispatcher', async function (signalType, payload) {
    if (signalType !== 'locomotion_dispatcher') return; // ignore foreign signals

    const verdictCapsule = payload?.locomotion_judge;
    if (!verdictCapsule || typeof verdictCapsule !== 'object' || !verdictCapsule.verdict) { // stray outer route (Law 13)
      throw new Error('[locomotion_dispatcher] CODING VIOLATION: routed signal lacks a locomotion_judge verdict capsule. Only locomotion_judge may route here.');
    }

    if (!pending || verdictCapsule.invocation_id !== pending.invocationId) { // stale verdict — legal late arrival, not a bug
      watcher.warn('locomotion_dispatcher',
        `⚠️ Dropping stale verdict '${verdictCapsule.verdict}' for invocation #${verdictCapsule.invocation_id} (pending: ${pending ? '#' + pending.invocationId : 'none'}).`
      );
      return;
    }

    if (verdictCapsule.verdict === 'success') { // the API call "returns": resolve with where the bot ended up
      const p = global.bot?.entity?.position?.floored?.();
      const endPosition = p ? { x: p.x, y: p.y, z: p.z } : null;
      const elapsedSec = ((Date.now() - pending.startedAt) / 1000).toFixed(1);
      watcher.summary('locomotion_dispatcher',
        `✅ ${pending.verb} succeeded on attempt ${verdictCapsule.attempt} in ${elapsedSec}s — bot at ${endPosition ? `(${endPosition.x},${endPosition.y},${endPosition.z})` : 'unknown'} (invocation #${pending.invocationId}).`
      );
      _ledgerWalk(pending, 'arrived', endPosition);
      const resolve = pending.resolve;
      const result = { arrived: true, verb: pending.verb, position: endPosition, attempts: verdictCapsule.attempt, selected_target: verdictCapsule.selected_target || null }; // selected_target: which candidate the ladder reached
      pending = null; // free the slot BEFORE resolving so the caller may immediately re-invoke
      resolve(result);
      return;
    }

    if (verdictCapsule.verdict === 'retry') { // fresh chain from current world state, rebuilt entirely from the verdict's echo
      watcher.summary('locomotion_dispatcher',
        `🔁 Retry verdict received — dispatching fresh chain, attempt ${verdictCapsule.attempt} (invocation #${pending.invocationId}).`
      );
      dispatchChain({
        verb: verdictCapsule.verb,
        coordinate: verdictCapsule.coordinate ?? null,
        require_los: verdictCapsule.require_los ?? false,
        required_side: verdictCapsule.required_side ?? null,
        min_y: verdictCapsule.min_y ?? null,
        max_y: verdictCapsule.max_y ?? null,
        walk_only: verdictCapsule.walk_only === true,
        exact: verdictCapsule.exact ?? false,
        candidates_ref: verdictCapsule.candidates_ref ?? null,
        candidates_count: verdictCapsule.candidates_count ?? 0,
        candidates_kind: verdictCapsule.candidates_kind ?? null,
        attempt: verdictCapsule.attempt,
        invocationId: verdictCapsule.invocation_id
      });
      return;
    }

    if (verdictCapsule.verdict === 'failure') {
      const p = global.bot?.entity?.position?.floored?.();
      const endPosition = p ? { x: p.x, y: p.y, z: p.z } : null;
      const elapsedSec = ((Date.now() - pending.startedAt) / 1000).toFixed(1);
      watcher.summary('locomotion_dispatcher',
        `❌ ${pending.verb} failed after ${elapsedSec}s — bot at ${endPosition ? `(${endPosition.x},${endPosition.y},${endPosition.z})` : 'unknown'} (invocation #${pending.invocationId}). Returning arrived=false to caller.`
      );
      _ledgerWalk(pending, 'failed', endPosition);
      const resolve = pending.resolve;
      const result = { arrived: false, verb: pending.verb, position: endPosition, attempts: verdictCapsule.attempt, reason: verdictCapsule.reason || 'give_up' };
      pending = null;
      resolve(result);
      return;
    }

    // An unknown verdict value is authored wrongly in the judge (Law 13).
    throw new Error(`[locomotion_dispatcher] CODING VIOLATION: unknown verdict '${verdictCapsule.verdict}' from locomotion_judge.`);
  }),

  // The doorway: movement APIs.
  goTo,
  goToStand,
  walkPace,
  goToStationStance,
  reposition,
  descendColumn,
};
