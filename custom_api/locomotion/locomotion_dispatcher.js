// fragment: locomotion_dispatcher
// purpose: The Law 15 doorway into the locomotion sub-loop. Exposes the movement API —
//          goTo — and births each inner chain's payload (Law 8 origin).
//          goTo handles all cases: short-range, long-range, and far-off exploration.
//          Locomotion picks the route and succeeds at the closest reachable position.
//
// ROUTING: the dispatcher always routes to navigator (A* + step-by-step edge walking).
// Navigator resolves targets, runs A*, walks the path step-by-step, and routes only to
// locomotion_judge. One consistent pipeline — no attempt-gated branch that bypasses
// pathfinding and sends retries to a different rung than attempt 1.
//
// role in the sub-loop (fractal twin of Thinking_fragments / sequencer):
//   caller ──(direct call, NO signal in flight)──> goTo
//     1. dispatcher births a fresh inner payload and routes it to navigator
//     2. navigator walks the A* path and terminates at locomotion_judge
//     3. the judge routes a verdict signal back here:
//          'success' → resolve the caller's pending promise (the API "returns")
//          'retry'   → dispatch a FRESH chain from current world state (judge owns the budget)
//     4. on give-up the judge sends a failure verdict — the pending promise resolves with
//        arrived=false so the caller can re-plan (pick a different target, not the same one)
//
// invariants:
//  - Writes NOTHING to the caller's payload (Law 15: the API is a doorway, not a routing hop).
//  - One pending invocation at a time (Law 4: the inner chain is the system's one active
//    signal; a second invocation before the first concludes means the first was abandoned).
//  - Malformed goals and missing bot are coding violations and throw immediately (Law 13) —
//    a movement request can only come from a running caller, so "no bot" is never environmental.
//  - All state lives in module-level memory (Law 9: per-invocation scratch, not inter-fragment
//    data) and is surfaced through Watcher lines (Law 5). No locomotion_dispatcher.json —
//    state surfaces through Watcher lines only, never a persisted file.
//  - Emergency: the signal bus refuses routing while an emergency override is active, so a
//    dispatch or verdict silently dies at the bus and the pending invocation is abandoned —
//    the same abandonment path as give-up, with the emergency system owning the follow-up.
//
// ---------------------------------------------------------------------------
// SECTION 1: Dependencies
// ---------------------------------------------------------------------------
// watcher    — diagnostic logging (Law 5); required at module load like all fragments
// signal_bus — required lazily inside functions (repo convention) to avoid the circular
//              load signal_bus → fragment_registry → this module
// NOTE (Law 1): this fragment requires NOTHING from locomotion_judge. All judge→dispatcher
// communication travels as routed verdict signals carrying their own data — the retry budget
// is the judge's internal ruling and never needs to be known here.
// ---------------------------------------------------------------------------
const watcher = require('@kernel/watcher');
// The bus at MODULE SCOPE, which it could not be before 2026-09-10: the load cycle through
// fragment_registry forced this require inside a function in every routing file. This is one of the
// six FORWARDING routers — it calls route() with an upstream author's own from/to rather than building
// an envelope, so it cannot use signal_utils' helpers (they stamp `from` = the caller and would rewrite
// authorship). Every other fragment now has no contact with the bus at all.
const signalBus = require('@kernel/signal_bus');

// ---------------------------------------------------------------------------
// SECTION 2: Configuration constants
// ---------------------------------------------------------------------------
// (reserved for future dispatcher-level tuning; routing constants live in the rungs)

// ---------------------------------------------------------------------------
// SECTION 3: Pending-invocation memory (Law 9 module-level scratch state)
// ---------------------------------------------------------------------------
// Exactly one invocation may be pending at a time, and the record holds ONLY what physically
// cannot travel in a payload: the caller's resolve function (plus identity and start time for
// stories). The loop's actual data — the original request (verb + goal) and the try count —
// lives in the payloads themselves: this fragment writes it at chain birth, the judge echoes
// it back in verdict signals, and the next chain is rebuilt from the verdict. Law 1: judge
// and dispatcher communicate exclusively through routed signals, never through shared memory
// or imports. invocationCounter gives every invocation a unique id so a stale verdict (from
// an abandoned invocation) is recognized and dropped instead of resolving the wrong caller.
// ---------------------------------------------------------------------------
let pending = null;        // { invocationId, verb, resolve, startedAt }
let invocationCounter = 0; // monotonically increasing invocation id

// ---------------------------------------------------------------------------
// SECTION 4: Goal validation and normalization
// ---------------------------------------------------------------------------
// The API accepts two goal shapes (D6 — no policy parameters):
//   { x, y, z }                                  — a single coordinate goal
//   { candidates_ref, candidates_count, candidates_kind } — several acceptable targets whose
//     coordinates live in a perception file (e.g. surface_filter.json). The payload is a
//     doorbell with a sticky note: it carries only the file name, how many targets it holds,
//     and what kind — NEVER the array itself (Law 6: bulk goal data lives in a transparent
//     file; the payload stays small). The long-range rung's composite ranking reads that file
//     and picks among the targets (the only selection logic).
// Anything else is a coding violation: the caller authored a bad request (Law 13 → throw).
// ---------------------------------------------------------------------------

// validCoordinate: true when c is an object with finite numeric x/y/z.
function validCoordinate(c) {
  return !!c && ['x', 'y', 'z'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k]));
}

// normalizeGoal: convert either accepted goal shape into { coordinate, candidates_ref,
// candidates_count, candidates_kind }. Throws on malformed input — never defaults, never
// guesses (Law 13).
function normalizeGoal(verb, goal) {
  if (validCoordinate(goal)) {
    return { coordinate: { x: goal.x, y: goal.y, z: goal.z }, require_los: goal.require_los === true, required_side: goal.required_side || null, min_y: goal.min_y != null ? goal.min_y : null, exact: goal.exact === true, candidates_ref: null, candidates_count: 0, candidates_kind: null };
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
// Births the inner payload from a request object and routes it to path_finder — ALWAYS, with
// no position-based entry decision (see the header). The request comes from the API call
// (attempt 1) or from a judge retry verdict (the judge echoes the original request back with
// the try count it placed in the payload). The `locomotion` capsule is the sub-loop's typed
// instruction contract (Law 10) — every rung and the judge rely on exactly this shape:
//   locomotion: {
//     verb:             'goTo'               — always exact-or-closest-reachable arrival
//     coordinate:       {x,y,z} | null       — single-goal form
//     require_los:      boolean              — placement/dig vantage: see the face, within BLOCK_REACH
//     candidates_ref:   string | null        — candidate-set form: file holding the coordinates
//     candidates_count: number               — how many targets the file holds (sticky note)
//     candidates_kind:  string | null        — what they are, e.g. 'oak_log' (sticky note)
//     attempt:          number               — which dispatch this is (the judge owns the budget)
//     invocation_id:    number               — ties the chain's verdict back to the pending call
//   }
// ---------------------------------------------------------------------------
function dispatchChain(request) {
  // A request must carry a goal in one of the two legal shapes. Absence here means either
  // the API validation was bypassed or a judge verdict was authored wrongly (Law 13 throw).
  if (!request || (!validCoordinate(request.coordinate) && !(typeof request.candidates_ref === 'string' && request.candidates_ref))) {
    throw new Error(`[locomotion_dispatcher] CODING VIOLATION: dispatch request carries no valid goal. Got: ${JSON.stringify(request)}`);
  }

  const bot = global.bot;
  // No bot means a movement API was called outside a running game session — a caller can
  // only execute while the bot exists, so this is authored wrongly somewhere (Law 13 throw).
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: movement API invoked with no bot loaded.');
  }

  const goalText = request.coordinate
    ? `(${request.coordinate.x},${request.coordinate.y},${request.coordinate.z})`
    : `${request.candidates_count} ${request.candidates_kind} candidates in ${request.candidates_ref}`;

  // Always route to navigator. It resolves targets, runs A*, and walks the path
  // step-by-step using edge-type dispatch.
  const hasCoordinate = validCoordinate(request.coordinate);
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
      // exact: arrive standing ON the target cell (feet === coordinate), no 1.5 tolerance.
      // For anchored builds whose reach is measured from the exact stand block — a 1-off
      // arrival puts far voxels out of reach. Default false: ordinary goTo keeps the tolerance.
      exact: request.exact || false,
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
// Returns a promise the caller awaits. The promise resolves ONLY on a success verdict
// from locomotion_judge. On give-up or emergency it never resolves — the invocation is
// abandoned (Law 15) and a fresh signal has already started elsewhere. Coding violations
// (bad goal, no bot) throw/reject loudly instead, because those must crash, not stall.
// ---------------------------------------------------------------------------

// invoke: validates the goal, claims the single pending slot, and dispatches attempt 1.
// The request data goes into the chain's payload, not into the pending slot: retries are
// rebuilt from the judge's verdict echo, never from memory here.
function invoke(verb, goal) {
  const normalized = normalizeGoal(verb, goal); // throws on malformed input before any state changes
  if (pending) {
    // A previous invocation never concluded — it was abandoned (give-up or emergency).
    // Log it for the operator, then let the new invocation take the slot.
    watcher.warn('locomotion_dispatcher',
      `⚠️ Invocation #${pending.invocationId} (${pending.verb}) was still pending — treating as abandoned and replacing.`
    );
  }
  invocationCounter++;
  return new Promise((resolve) => {
    pending = {
      invocationId: invocationCounter,
      verb,
      resolve,
      startedAt: Date.now()
    };
    dispatchChain({
      verb,
      coordinate: normalized.coordinate,
      require_los: normalized.require_los,
      required_side: normalized.required_side,
      min_y: normalized.min_y,
      exact: normalized.exact,
      candidates_ref: normalized.candidates_ref,
      candidates_count: normalized.candidates_count,
      candidates_kind: normalized.candidates_kind,
      attempt: 1,
      invocationId: invocationCounter
    });
  });
}

// goTo: move toward the goal (single coordinate or candidate set). The locomotion system
// picks the route automatically — short-range (≤5 blocks) goes direct via cube-Dijkstra,
// long-range goes through the district scan + full Dijkstra. If the exact target is
// unreachable (solid block, beyond scan radius), the bot succeeds at the closest reachable
// position and the caller's SPA loop re-plans from there.
//
// TWO KINDS OF GOAL, and picking the wrong one is the most expensive mistake a caller can make here:
//   bare {x,y,z}                → STAND ON THIS CELL. The navigator will DIG whatever is in the way,
//                                 including the station you meant to visit. Never point this at a block
//                                 you want to keep.
//   { require_los: true }       → stand where you can CLICK THIS FACE (within BLOCK_REACH, raycast
//                                 clear). For PLACING and DIGGING, where the angle is what matters.
//
// AND A THIRD THING THAT IS NOT A GOAL SHAPE: to USE a station — open a chest, load a furnace, work a
// table — call `goToStationAnchor` below. Do not reach for require_los there; see its header.
function goTo(goal) { return invoke('goTo', goal); }

// goToStand: "stand ON this anchor block." An ANCHOR names the block the bot's feet rest on, so the feet
// cell A* must reach is anchor + (0,1,0). This is the ONE home for that +1 — the "does going to X mean
// standing on top of X?" conversion, kept as a single named primitive instead of left for each caller to
// hand-roll independently. It could NOT be folded into goTo itself: most goTo callers pass a FEET cell or
// a stand-NEAR target (a drop to walk onto, a chest to LOS, a resolved neighbour stand from
// resolveAnchorStand/findStand) — a blanket +1 would send every one of those a block too high. So the +1
// lives in a NAMED sibling used only where the anchor block itself is the stand. Defaults exact:true: a
// build/work stand measures reach from the stand block, so the feet must land ON the cell, not merely
// within tolerance (pass { exact:false } for a tolerant park).
function goToStand(anchor, opts = {}) {
  return goTo({ x: anchor.x, y: anchor.y + 1, z: anchor.z, exact: true, ...opts });
}

// reposition: move the bot away from a position to a valid placement vantage point.
// Inverse of goTo's LOS approach — A* expands outward from the bot's current position,
// checking LOS at each node, and stops at the nearest position that is at least
// MIN_PLACEMENT_DIST (1.5) away with line of sight to the target. Minimum movement,
// guaranteed placement viability. When required_side is set, the vantage must also be
// on the correct cardinal side of the target for facing-sensitive blocks.
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

  // Use the same LOS goal type that goTo uses for interaction targets. A* expands
  // outward from the bot's current position and stops at the cheapest node within
  // [MIN_PLACEMENT_DIST, BLOCK_REACH] that has line of sight to the target face.
  // The LOS refinement budget keeps looking for an even closer position after the
  // first hit. The result is the minimum-movement placement vantage point.
  const goal = { type: 'los', targetPos: { x: ox, y: oy, z: oz }, required_side: side };
  if (opts.min_y != null) goal.min_y = opts.min_y;
  // 500 is an ECONOMIC bound, not a runaway guard — a guessed runaway cap reports "unreachable" for
  // reachable places, which is why the navigator carries no such budget of its own. This one survives
  // because it states the CALLER's criterion: a placement vantage is by definition within arm's
  // reach of the target, so a route that takes 500 nodes to find is not a reposition, it is a journey —
  // and "no vantage nearby" is the right answer to give at that point, not a longer search.
  const result = await computeAStar(bot, botFloor, goal, { maxNodes: 500, owner: 'reposition' });

  if (!result) {
    watcher.summary('locomotion_dispatcher',
      `🔄 reposition: no LOS vantage from (${ox},${oy},${oz})${side ? ` [${side} side]` : ''}`);
    return { arrived: false, verb: 'reposition', reason: 'no_los_vantage' };
  }

  // A* returned an empty path — the bot is already at a valid LOS position.
  if (!result.path || result.path.length === 0) {
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

// ── goToStationAnchor: THE ONE WAY A BOT GOES TO USE A STATION ────────────────────────────────────
//
// Architect 2026-08-31: *"since all chests and furnaces operate off of blueprints, with the only
// exception being a temporary crafting table to boostrap the bot — then instead of the LOS logic, remove
// all of that and instead walk the blueprint and stand at the anchor the station is placed on … i dont
// want to violate shared world rules and having the bots using chests on the outside of the building
// through a wall breaking immersion. the anchor is a designated building point and is a pre approved
// location to stand and reach every block within its domain so reuse it instead of making some non
// deterministic way to stand."*
//
// WHAT THIS REPLACES, AND WHY BOTH PREDECESSORS WERE THE SAME MISTAKE. Station approach used
// `require_los` — a raycast vantage inside BLOCK_REACH — which is satisfied from across a room and
// through a doorway, so the search often found the body ALREADY at the goal, returned an empty path, and
// reported arrival without a step; the caller then retried a chest window it could not reach, forever.
// For one day that was replaced by a radius goal, which fixed the reach and kept the real defect: both
// are SEARCHES over a set of acceptable cells, and a search returns whichever is cheapest from wherever
// the body happens to be. Cheapest from outside a building is a cell outside the wall. The bug was never
// the metric — it was that the stance was being computed at all.
//
// The anchor is authored. build_executor stands on it to BUILD those voxels, so "every voxel in this
// group is reachable from here" is the anchor's defining contract, checked when the blueprint was drawn
// rather than re-derived per approach. One cell, the same on every run and from every direction
// (Law 19), inside the building by construction — which is the immersion half of his ruling, and the one
// no reach metric can deliver.
//
// RETURNS { arrived, anchor, blueprint, roomKey, anchorIndex, reason? }.
//   reason 'no_anchor'  — no locked blueprint claims that cell. The Architect named the one legitimate
//                         case: a temporary crafting table a bot sets down beside itself. NOTHING MOVES,
//                         and the caller must decide — it is not permission to improvise a stance.
//   reason 'unassigned' — a blueprint owns the cell but filed it outside every anchor. That is a
//                         blueprint to edit, not a stance to invent, so it is named apart from
//                         'no_anchor' rather than folded into it (Law 25).
async function goToStationAnchor(pos) {
  const bot = global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: goToStationAnchor called with no bot loaded.');
  }
  const owner = require('@perception/blueprint_survey').resolveVoxelAnchor(pos);

  if (!owner) {
    watcher.warn('locomotion_dispatcher',
      `🚪 no blueprint claims the station at (${pos.x},${pos.y},${pos.z}) — no authored stance exists for it. `
      + `Only a temporary bootstrap table should ever land here; the caller decides what to do.`);
    return { arrived: false, anchor: null, blueprint: null, roomKey: null, anchorIndex: -1, reason: 'no_anchor' };
  }
  if (!owner.anchor) {
    watcher.warn('locomotion_dispatcher',
      `🚪 the ${owner.type} at (${pos.x},${pos.y},${pos.z}) belongs to blueprint "${owner.blueprint}" but to no anchor `
      + `(unassigned voxel) — that blueprint needs the voxel filed under an anchor before a bot can use it.`);
    return { arrived: false, anchor: null, blueprint: owner.blueprint, roomKey: owner.roomKey, anchorIndex: -1, reason: 'unassigned' };
  }

  const a = owner.anchor;
  watcher.summary('locomotion_dispatcher',
    `🚪 ${owner.type} at (${pos.x},${pos.y},${pos.z}) → standing on ${owner.blueprint} anchor ${owner.anchorIndex} (${a.x},${a.y},${a.z}).`);
  // goToStand owns the "+1 to stand ON it" conversion and defaults exact:true — the feet must land on the
  // anchor cell itself, not merely within tolerance of it, or the stance is back to being approximate.
  const nav = await goToStand(a);
  return {
    arrived: !!(nav && nav.arrived), anchor: a,
    blueprint: owner.blueprint, roomKey: owner.roomKey, anchorIndex: owner.anchorIndex,
    reason: nav && nav.arrived ? undefined : (nav?.reason || 'unreachable_anchor'),
  };
}

// ── descendColumn: sink a shaft STRAIGHT DOWN, in one XZ, and never leave it ──────────────────────
//
// WHY THIS EXISTS, and it is a design ruling rather than a helper (Architect 2026-08-31): *"either its
// fully diagonal which requires a diagonal scan and doesent use return resources like planks or a
// straight vertical shaft which uses trash and planks to extract the stone. right now it does a little
// bit of both."*
//
// THE HYBRID HE IS NAMING. The stone prospect is authored end-to-end as a VERTICAL design: the scanner
// proves ONE column — an uninterrupted run of `stone`, solid non-conducting walls on all four sides for
// the whole depth, and a resting block under the last stone — and the executor climbs back out of that
// same column on pillar blocks it carried in for the purpose. Both halves are about a 1-wide hole.
// Between them, the descent was `goTo({…, exact: true})`, an ordinary A* route to the bottom cell. A*
// owes nothing to the column: `dig_down` and `dig_climb_down` are the SAME cost (15), so the moment a
// vertical step is refused or repriced the search steps aside and cuts a diagonal — out of the scanned
// column, through walls nothing checked, into a hole the pillar-out was never sized for. That is the
// "little bit of both", and it is not a tuning problem: no cost makes a route search respect a column,
// because staying in one is a CONSTRAINT and a search only knows prices (Law 27 — author the fact where
// it can be authored rather than a rule an enforcer polices).
//
// WHY NOT THE OTHER HALF OF HIS CHOICE. The diagonal design is coherent and cheaper to run — a walked
// staircase needs no pillar blocks to come back up. It also needs a scanner that proves a DIAGONAL
// corridor: walls, fluid and cave guards along a moving XZ instead of a fixed one, which is a new
// perception node. The vertical design is already built, twice over, in the two files either side of
// this call. So this closes the gap in the design that exists rather than opening a second one.
//
// IT LOOPS navigator.digDownStep AND IMPLEMENTS NOTHING. Every safety property of a dig-down — feet not
// submerged, the floor a real solid, the landing one below a safe solid, no liquid at any of the four
// walls — is that function's, re-sensed per step against live world state (Invariant B). This adds
// exactly one thing on top: the body may not move in X or Z.
//
// Returns { arrived, y, dug, reason }. `arrived` is TRUE only when the feet actually reach toFeetY —
// a stall reports where it stopped and why, because a caller nine blocks down needs to know which.
async function descendColumn({ x, z, toFeetY }) {
  const bot = global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[locomotion_dispatcher] CODING VIOLATION: descendColumn called with no bot loaded.');
  }
  if (![x, z, toFeetY].every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error(`[locomotion_dispatcher] CODING VIOLATION: descendColumn needs finite {x, z, toFeetY}. Got: ${JSON.stringify({ x, z, toFeetY })}`);
  }

  const { digDownStep } = require('@locomotion/navigator');
  const start = bot.entity.position.floored();

  // THE BODY MUST ALREADY BE ON THE COLUMN. This refuses rather than walking there itself: the caller
  // stood the bot on the scanned surface cell and RE-SENSED that it arrived (goTo resolves at the
  // closest reachable cell, so `arrived` alone is not a position), and a descent that quietly relocated
  // would sink a shaft through a column nothing had scanned — the exact failure that re-sense exists to
  // stop (Law 25).
  if (start.x !== x || start.z !== z) {
    watcher.warn('locomotion_dispatcher',
      `⛏ descendColumn refused: body at (${start.x},${start.z}) is not on column (${x},${z}). The caller must stand it on the column first.`);
    return { arrived: false, y: start.y, dug: 0, reason: 'not_on_column' };
  }

  // The budget is the drop itself plus a small slack, so it cannot outlive the shaft it is digging. It
  // is a BACKSTOP, not the terminator — the stall check below is what normally ends this.
  const budget = Math.max(0, start.y - toFeetY) + 4;
  let dug = 0;

  for (let i = 0; i < budget; i++) {
    const before = bot.entity.position.floored();
    if (before.y <= toFeetY) return { arrived: true, y: before.y, dug };
    // Drift is a HARD STOP, not something to walk back from. A body that left the column has already
    // opened a cell outside everything the scan proved; carrying on would deepen the mistake, and
    // stepping back into line would be this function inventing lateral movement it exists to forbid.
    if (before.x !== x || before.z !== z) {
      watcher.warn('locomotion_dispatcher',
        `⛏ descendColumn stopped: body drifted to (${before.x},${before.z}) off column (${x},${z}) after ${dug} dig(s).`);
      return { arrived: false, y: before.y, dug, reason: 'left_column' };
    }
    await digDownStep(bot);
    const after = bot.entity.position.floored();
    if (after.y >= before.y) {
      // digDownStep already reports WHICH gate refused; this names the consequence for the caller.
      watcher.warn('locomotion_dispatcher',
        `⛏ descendColumn stalled at y=${after.y} (wanted ${toFeetY}) after ${dug} dig(s) — the next step down was refused.`);
      return { arrived: false, y: after.y, dug, reason: 'step_refused' };
    }
    dug++;
  }

  const end = bot.entity.position.floored();
  return { arrived: end.y <= toFeetY, y: end.y, dug, reason: end.y <= toFeetY ? undefined : 'budget_exhausted' };
}

// ---------------------------------------------------------------------------
// SECTION 7: Verdict receiver (signal bus entry point)
// ---------------------------------------------------------------------------
// The only legal sender is locomotion_judge. A verdict is a DEAD signal — its declared
// termination point (Law 8) is right here. It carries its own data, because the only two
// facts that survive the loop are the original request (we are NOT re-deciding where to go)
// and the try count, and the judge places both in the payload (fractal of recursive_judge
// tracking loop counts — the judge echoes only non-stale data, never world state):
//   locomotion_judge: { verdict: 'success', invocation_id, attempt }
//   locomotion_judge: { verdict: 'retry',   invocation_id, attempt,   ← already incremented
//                       verb, coordinate, candidates_ref,
//                       candidates_count, candidates_kind }            ← the echoed request
// 'success' → resolve the caller's promise with where the bot ended up; clear the slot.
// 'retry'   → rebuild the request FROM THE VERDICT and dispatch a fresh chain from current
//             world state.
// 'failure' → resolve the caller's promise with arrived=false; the caller gets control back
//             and is responsible for re-planning (pick a different target).
// The dispatcher executes verdicts; it never judges — retry-vs-failure belongs to the judge.
// ---------------------------------------------------------------------------
module.exports = {
  receive: watcher.track('locomotion_dispatcher', async function (signalType, payload) {
    if (signalType !== 'locomotion_dispatcher') return; // ignore foreign signals

    const verdictCapsule = payload?.locomotion_judge;
    // A signal here without a verdict capsule is a stray outer route — authored wrongly (Law 13).
    if (!verdictCapsule || typeof verdictCapsule !== 'object' || !verdictCapsule.verdict) {
      throw new Error('[locomotion_dispatcher] CODING VIOLATION: routed signal lacks a locomotion_judge verdict capsule. Only locomotion_judge may route here.');
    }

    // Stale verdict: the invocation it belongs to was already abandoned/replaced. This is a
    // legal late arrival, not a bug — log it with its ids and drop it.
    if (!pending || verdictCapsule.invocation_id !== pending.invocationId) {
      watcher.warn('locomotion_dispatcher',
        `⚠️ Dropping stale verdict '${verdictCapsule.verdict}' for invocation #${verdictCapsule.invocation_id} (pending: ${pending ? '#' + pending.invocationId : 'none'}).`
      );
      return;
    }

    if (verdictCapsule.verdict === 'success') {
      // The API call "returns": resolve with where the bot actually ended up. The attempts
      // count comes from the verdict — the judge placed it there; no memory of it is kept here.
      const p = global.bot?.entity?.position?.floored?.();
      const endPosition = p ? { x: p.x, y: p.y, z: p.z } : null;
      const elapsedSec = ((Date.now() - pending.startedAt) / 1000).toFixed(1);
      watcher.summary('locomotion_dispatcher',
        `✅ ${pending.verb} succeeded on attempt ${verdictCapsule.attempt} in ${elapsedSec}s — bot at ${endPosition ? `(${endPosition.x},${endPosition.y},${endPosition.z})` : 'unknown'} (invocation #${pending.invocationId}).`
      );
      const resolve = pending.resolve;
      // selected_target tells a candidate-set caller which candidate the ladder actually reached.
      const result = { arrived: true, verb: pending.verb, position: endPosition, attempts: verdictCapsule.attempt, selected_target: verdictCapsule.selected_target || null };
      pending = null; // free the slot BEFORE resolving so the caller may immediately re-invoke
      resolve(result);
      return;
    }

    if (verdictCapsule.verdict === 'retry') {
      // Fresh chain from current world state: the bot has moved; navigator re-resolves targets and
      // re-pathfinds from the new position (retries always route to navigator, Section 5).
      // The request is rebuilt ENTIRELY from the verdict's echo: verb + goal (unchanged by
      // design — we are not re-deciding where to go) and the attempt number the judge already
      // incremented. dispatchChain re-validates the echoed goal and throws if the judge
      // authored it wrongly (Law 13).
      watcher.summary('locomotion_dispatcher',
        `🔁 Retry verdict received — dispatching fresh chain, attempt ${verdictCapsule.attempt} (invocation #${pending.invocationId}).`
      );
      dispatchChain({
        verb: verdictCapsule.verb,
        coordinate: verdictCapsule.coordinate ?? null,
        require_los: verdictCapsule.require_los ?? false,
        required_side: verdictCapsule.required_side ?? null,
        min_y: verdictCapsule.min_y ?? null,
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
  goToStationAnchor,
  reposition,
  descendColumn,
};
