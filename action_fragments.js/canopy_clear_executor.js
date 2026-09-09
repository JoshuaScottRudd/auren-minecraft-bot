// fragment: canopy_clear_executor (action / base-canopy clearing)
// purpose: The engine of the PROACTIVE tree-clear pathway — fell wild trees
//          standing within TREE_CLEAR_RADIUS of an opted-in surface blueprint's build_center, ordered
//          closest to that center, so the camera framing around the base/farm stays clear. One verb:
//          fell one wild tree inside a blueprint's clear radius (Law 0).
//
// WHY a dedicated executor, not harvest_executor: harvest fells to satisfy a log DEFICIENCY through its
// inside→outside supply ladder; this fells to keep a radius clear for FILM regardless of log need, at the
// lowest priority. Same felling primitive (tree_feller.fell — Law 16), different trigger and scope; folding it
// into harvest would tangle the supply cascade with a camera concern. Mirrors torch_executor:
// a thin one-shot executor over an existing API.
//
// WHY trust magnet.where for the center: a build_center is immutable once set_buildspot locks it (unlike
// torch's dark-cell list, which peers change between sweeps), so the center copied onto the magnet at
// post time is still correct at run time — no re-scan needed. job_board's gate (a log within radius of
// the center) only posts this while a tree still stands in range, so the executor stops being dispatched
// once the ring is clear.
//
// One tree per dispatch: tree_feller.fell clears ONE whole connected tree, then we route to
// recursive_judge so the board re-plans (a higher-priority job may have appeared) and re-posts
// clear_canopy for the next tree while the gate still finds one. A futile pass (nothing in range
// reachable) concedes to idle_park rather than re-dispatching an identical zero-progress fell — the
// lowest-priority film job must never churn the judge into a stuck-loop halt (Law 13).

'use strict';

const watcher = require('@kernel/watcher');
const treeFeller = require('@api/tree_feller');
const portableJudge = require('@kernel/portable_judge');
const { TREE_CLEAR_RADIUS } = require('@thinking/architect_config');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'canopy_clear_executor';

// Concede to idle instead of soft-failing to the judge (mirror harvest_executor.routeIdle). Used when a
// clear pass is FUTILE from here (no reachable tree in range) — an identical zero-progress fell 5× would
// trip the judge's false stuck-loop kill. Clearing the magnet drops the bot off the job; idle_park moves
// it clear and arms the heartbeat, and the next sweep re-posts if a tree still stands in range.
//
// IT IS JUDGED, for the reason harvest_executor's twin states in full: routing around recursive_judge
// means carrying a judge along, never doing without one (Law 11 — no loop without exactly one judge).
// Without it this concession is a complete unjudged cycle: the gate re-posts while a standing tree is
// merely unreachable, the dispatcher re-claims, the fell is refused for the same reason, and nothing in
// the fleet is counting. FORGIVING because a fresh plan cycle is the right first answer to "futile from
// here"; the retry counter escalates to a strict kill if replanning keeps landing back on it.
// Returns after an escalation without routing — portable_judge has already routed, and a second signal
// in one scope is a Law 4 violation.
async function _routeIdle(reason) {
  const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
  if (verdict === false) return;
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  const signalBus = require('@kernel/signal_bus');
  routeSignal(signalBus, TAG, 'idle_park', { readable: `${TAG}: ${reason} → idle_park` });
}

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before canopy clear ran.`);
    }

    const hq = require('@kernel/corporate_headquarters');
    const botId = process.env.BOT_ID || 'default';
    const where = hq.readBoardroomChair(botId, {})?.magnet?.where;
    if (!where || typeof where.x !== 'number') {
      // The blueprint center didn't ride the magnet (base unlocked between post and dispatch) —
      // environmental/timing, not a bug. Concede to idle; the next sweep re-plans from live state.
      return _routeIdle('no blueprint center on magnet — nothing to clear');
    }

    // Fell one wild tree inside the blueprint's clear ring, worked closest-to-center first. The zone
    // uses the SAME square (Chebyshev radius) job_board's gate counts trees in, so the two agree on
    // what "in range" means (no post-a-job-the-fell-can't-satisfy churn).
    //
    // NO preferWood HERE, and that omission is the design. This verb's goal is an EMPTY
    // ring, so species is meaningless to it — ordering by a preferred wood would only make it walk past
    // near trees to reach far ones and finish the same clearing slower. Supply-side felling wants one
    // species (harvest_executor's log ladder passes the flag); clearing wants the nearest trunk.
    const center = { x: where.x, z: where.z };
    const result = await treeFeller.fell(bot, null, {
      canopyZone: { mode: 'inside', center, radius: TREE_CLEAR_RADIUS },
      preferNear: { x: where.x, y: where.y, z: where.z },
    });

    if (result && result.success) {
      const at = result.position ? ` @${result.position.x},${result.position.y},${result.position.z}` : '';
      const readable = `${TAG}: cleared ${result.species}${at}, mined ${result.minedCount}`;
      portableJudge.done(TAG);   // a felled tree is progress — the concession ledger starts over
      watcher.summary(TAG, readable);
      const signalBus = require('@kernel/signal_bus');
      const capsule = payload[TAG] || (payload[TAG] = {});
      capsule.success = true;
      capsule.readable = readable;
      payload.readable = readable;
      return routeToJudge(signalBus, TAG, { ...payload, readable });
    }

    // No clearable tree in range → concede (the gate stops posting once the ring is truly clear; a
    // transient can't-reach must not churn the judge on the lowest-priority job).
    return _routeIdle(`no clearable tree in range (${result?.reason || 'unknown'})`);
  }),
};
