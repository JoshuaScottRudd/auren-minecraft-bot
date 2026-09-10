// fragment: move_injector
// purpose: Walk the bot to ONE authored coordinate through the real locomotion API, and terminate.
//
// ─── WHY THIS EXISTS ───
// The question it was built to answer: the arena's reachability gate (tools/lanista.js) approves a pair
// by running the construct's own A* with world-altering edges deleted. That inherits the DEFINITION of
// reachable from the fleet, but not validation in this regime — the live navigator runs the same search
// at NODE_BUDGET 200000 and treats a partial result as incremental progress, while the gate runs it at
// 4000 and turns a partial into a verdict. So the gate's verdict gets checked by a body crossing the
// ground, and the body is the real one running the real locomotion ladder.
//
// The alternative was a standalone script with its own mineflayer body and its own walk loop. That is a
// second locomotion (Law 16) validating a copy of the thing under test — and it is unnecessary, because
// the construct is already built to be driven live. This fragment is the whole difference.
//
// ─── The rules it follows ───
// Law 0  — one verb: go to the authored cell. It does not choose the cell, teleport, retry, or replan.
// Law 1  — it calls a locomotion API directly (Law 15 sub-loop API), and routes its OUTCOME on the bus.
// Law 4  — one signal: the goTo promise is awaited to a single terminal outcome before anything routes.
// Law 8  — the lifecycle it opens terminates at recursive_judge. Nothing runs on past it.
// Law 25 — the readable carries the TRUE outcome measured against what the operator asked for: arrived
//          or not, where the body actually stands, and how many attempts the ladder spent.
//
// ─── The test flag, and exactly what it does and does not cover ───
// `test: true` makes recursive_judge log the outcome and HALT rather than replan (its ratified purpose)
// — so a move test can never seed the planning recursion. Same mechanism sentry uses to run combat in
// isolation.
//
// KNOWN HOLE, stated rather than implied: the flag rides on THIS fragment's own route to the judge. It
// does not ride through the locomotion chain. If the movement stalls hard enough for portable_judge to
// escalate (three straight failures to the same goal, locomotion_judge's strict checkpoint), portable
// judge routes its own payload to recursive_judge with no test flag and the planning recursion does
// start. Closing that needs `test` threaded through the locomotion capsule and the two sub-loop judges,
// which is a change to live locomotion and belongs at the Architect's table, not here. Until then a move
// test that ends in a stall is expected to leave a replan in the trace — read it as the harness leaking,
// not as the route being walkable.
//
// ─── Feet, not floor ───
// The coordinate is a FEET cell, which is what goTo takes and what an arena spawn box's `y` already is.
// No ±1 conversion happens here; goToStand is the sibling that owns the anchor→stand +1 (see its header).

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const locomotion = require('@locomotion/locomotion_dispatcher');

const TAG = 'move_injector';

function validCell(c) {
  return c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z);
}

module.exports = {
  handle: TAG,

  // to — { x, y, z } feet cell, authored by the operator. Malformed input is a coding violation in the
  // operator pathway that built it, never an environmental condition (Law 13): throw, do not default.
  // opts.lookahead — the locomotion lookahead depth for THIS run only, not a persisted change to the
  // default. Depth 1 is the old per-cell walk, so the A/B is `runfleet move a b` against
  // `runfleet move a b 3` over the same pair, and the difference
  // between the two traces is the dial and nothing else. Reported in the readable because a timing result
  // whose settings are not on the record is not a result (Law 6).
  inject: async function (to, opts = {}) {
    if (!validCell(to)) {
      throw new Error(`[${TAG}] CODING VIOLATION: move requires a numeric {x,y,z} destination. Got: ${JSON.stringify(to)}`);
    }
    const bot = global.bot;
    if (!bot || !bot.entity || !bot.entity.position) {
      // Not a throw: the operator can legally send this before chunks land, and the bot recovering by
      // saying so beats it dying. Environmental (Law 13) — report and stop.
      watcher.warn(TAG, 'move — bot not spawned/positioned yet; nothing dispatched.');
      return;
    }

    const start = bot.entity.position.floored();
    const goal = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
    const navigator = require('@locomotion/navigator');
    const lookahead = navigator.setRunLookahead(opts.lookahead != null ? opts.lookahead : navigator.RUN_LOOKAHEAD_DEFAULT);
    // Separate dial because fusing cells and jumping early are two changes; one dial cannot attribute
    // a slower leg to either.
    const prejump = navigator.setRunPrejump(opts.prejump !== false && opts.prejump !== 0 && opts.prejump !== '0');
    const t0 = Date.now();
    watcher.summary(TAG,
      `🧪 move test: (${start.x},${start.y},${start.z}) → (${goal.x},${goal.y},${goal.z}) via the locomotion API, lookahead ${lookahead}, prejump ${prejump ? 'on' : 'off'}.`);

    // The Law 15 API. It resolves on BOTH terminal verdicts — success, and give-up after the ladder's
    // attempts — so both are reported here. The one case it does not resolve is the strict-kill
    // abandonment described in the header; that path reports itself through the judge instead.
    const result = await locomotion.goTo(goal);

    const elapsedMs = Date.now() - t0;
    navigator.setRunLookahead(navigator.RUN_LOOKAHEAD_DEFAULT); navigator.setRunPrejump(true);   // per-run dials, never left set for whatever walks next (Law 8)
    const end = bot.entity.position.floored();
    const gap = Math.hypot(end.x - goal.x, end.y - goal.y, end.z - goal.z);
    const outcome = result && result.arrived
      ? `ARRIVED at (${end.x},${end.y},${end.z}) in ${result.attempts} attempt(s), ${elapsedMs}ms, lookahead ${lookahead}/prejump ${prejump ? 'on' : 'off'}`
      : `DID NOT ARRIVE — stopped at (${end.x},${end.y},${end.z}), ${gap.toFixed(1)} blocks from the goal, ` +
        `${result ? `${result.attempts} attempt(s), reason '${result.reason || 'unknown'}'` : 'no verdict returned'}`;
    watcher.summary(TAG, `move test complete: ${outcome}.`);

    routeToJudge(TAG, {
      test: true,                    // halt, no replan — a move test never enters the planning recursion
      readable: `${TAG}: move (${start.x},${start.y},${start.z}) → (${goal.x},${goal.y},${goal.z}) — ${outcome}`,
      move_injector: {
        arrived: !!(result && result.arrived),
        from: { x: start.x, y: start.y, z: start.z },
        goal,
        ended: { x: end.x, y: end.y, z: end.z },
        gapBlocks: Number(gap.toFixed(2)),
        elapsedMs,
        lookahead,
        prejump,
        attempts: result ? result.attempts : null,
        reason: result && !result.arrived ? (result.reason || 'unknown') : null,
      },
    });
  },
};
