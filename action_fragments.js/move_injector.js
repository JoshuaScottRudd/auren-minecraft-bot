// fragment: move_injector — walks the bot to ONE authored coordinate through the real locomotion API,
// and terminates.
//
// The arena reachability gate (tools/lanista.js) approves a coordinate pair with a search run at a
// smaller node budget than the live navigator uses, so this fragment drives the real locomotion ladder
// over the same ground to check that verdict against an actual body.
//
// ─── The rules it follows ───
// Law 0  — one verb: go to the authored cell. It does not choose the cell, teleport, retry, or replan.
// Law 1  — it calls a locomotion API directly (Law 15 sub-loop API), and routes its OUTCOME on the bus.
// Law 4  — one signal: the goTo promise is awaited to a single terminal outcome before anything routes.
// Law 8  — the lifecycle it opens terminates at recursive_judge. Nothing runs on past it.
// Law 25 — the readable carries the TRUE outcome measured against what the operator asked for: arrived
//          or not, where the body actually stands, and how many attempts the ladder spent.
//
// ─── The test flag ───
// `test: true` makes recursive_judge log the outcome and halt without entering the planning recursion.
// Same mechanism sentry uses to run combat in isolation.
//
// KNOWN HOLE: the flag rides on this fragment's own route to the judge, not through the locomotion
// chain. If the movement stalls enough for portable_judge to escalate (three straight failures to the
// same goal, locomotion_judge's strict checkpoint), portable_judge routes its own payload to
// recursive_judge with no test flag, and the planning recursion starts — a move test that ends in a
// stall can leave a replan in the trace for this reason.
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

  // to — { x, y, z } feet cell, authored by the operator. Malformed input is a coding violation (Law 13):
  // throws.
  // opts.lookahead — the locomotion lookahead depth for THIS run only, not a persisted change to the
  // default. Depth 1 is the per-cell walk; `runfleet move a b` against `runfleet move a b 3` over the
  // same pair isolates the dial as the only difference between the two traces. Reported in the readable,
  // since a timing result whose settings are not on the record is not a result (Law 6).
  inject: async function (to, opts = {}) {
    if (!validCell(to)) {
      throw new Error(`[${TAG}] CODING VIOLATION: move requires a numeric {x,y,z} destination. Got: ${JSON.stringify(to)}`);
    }
    const bot = global.bot;
    if (!bot || !bot.entity || !bot.entity.position) {
      // Not a throw: the operator can legally send this before chunks land. Environmental (Law 13) —
      // report and stop.
      watcher.warn(TAG, 'move — bot not spawned/positioned yet; nothing dispatched.');
      return;
    }

    const start = bot.entity.position.floored();
    const goal = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
    const navigator = require('@locomotion/navigator');
    const lookahead = navigator.setRunLookahead(opts.lookahead != null ? opts.lookahead : navigator.RUN_LOOKAHEAD_DEFAULT);
    // Separate dial: fusing cells and jumping early are two distinct changes, each needing its own
    // attribution for a slower leg.
    const prejump = navigator.setRunPrejump(opts.prejump !== false && opts.prejump !== 0 && opts.prejump !== '0');
    const t0 = Date.now();
    watcher.summary(TAG,
      `🧪 move test: (${start.x},${start.y},${start.z}) → (${goal.x},${goal.y},${goal.z}) via the locomotion API, lookahead ${lookahead}, prejump ${prejump ? 'on' : 'off'}.`);

    // The Law 15 API. Resolves on both terminal verdicts — success and give-up after the ladder's
    // attempts — both reported here. The strict-kill abandonment described in the header reports itself
    // through the judge instead.
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
