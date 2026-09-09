// fragment: eat_manager  (action / self-preservation)
// purpose: The routing head of the eating triad. It owns the `eat` job and runs the
//          canonical verify loop the supply/mining/build managers run — NOT an inline call. Called in two
//          contexts, and it does the SAME thing in both because it always RE-SENSES (Invariant B):
//            a) fresh dispatch from the dispatcher
//            b) return from eat_executor via recursive_judge (the verification hop)
//          Every call: read the truth (health_integrity.scan), then either —
//            - full/above the eat line → release to the judge (gap closed → job_board)   [SUCCESS]
//            - still hungry            → dispatch eat_executor to feed the bot            [WORK]
//
// WHY the manager verifies and the executor cannot: the executor reports
// "I ate," which is an ACTION, not a safe-state. The manager re-reads bot.food after the executor returns
// through the judge and only releases when it confirms the bot is full. If the executor ate everything on
// hand and the bot is still short, this re-sense sees it and dispatches again.
//
// WHY a "stand down" branch (two-tier): getting food — pocket, then storage via
// inventory_swapper — is still the EXECUTOR's job, and a truly-empty system AT the must-eat floor is still
// its Law 13 throw. But ABOVE that floor with no food reachable (the farms still growing the first loaf),
// dispatching the executor would only no-op and, re-sensed hungry, loop back here into a stall the judge
// kills — punishing the bot for a chain that simply hasn't produced yet. So the manager stands down there
// (releases, lets the bot work) and dispatches the executor only when food is reachable OR the bot is at the
// must-eat floor. It reads the ONE shared availability predicate (Law 16), never re-deriving it.

'use strict';

const watcher = require('@kernel/watcher');
const healthIntegrity = require('@perception/health_integrity');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'eat_manager';

module.exports = {
  receive: watcher.track(TAG, function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const signalBus = require('@kernel/signal_bus');
    const bot = global.bot;
    const from = payload?.from || 'unknown';

    // An eat job is posted only for a live bot with a readable food level (health_integrity gated it) — no
    // bot here is a coding fault, not an environmental one (Law 13).
    if (!bot || typeof bot.food !== 'number') {
      throw new Error(`[${TAG}] CODING VIOLATION: dispatched with no bot/food loaded.`);
    }

    // VERIFY / RE-SENSE (Invariant B): the fresh truth, never the executor's self-report.
    const verdict = healthIntegrity.scan(bot);

    // SUCCESS: full/above the eat line → release. recursive_judge sends a manager release on to job_board.
    if (!verdict.needs_to_eat) {
      const readable = `${TAG}: verified full — food ${verdict.food}/20. Safe → release.`;
      watcher.summary(TAG, readable);
      return routeToJudge(signalBus, TAG, { [TAG]: { success: true, food: verdict.food }, readable });
    }

    // STAND DOWN (two-tier): should-eat but NOT at the must-eat floor AND no food is
    // reachable — release rather than dispatch a no-op that would loop into a judge-killed stall. job_board's
    // should-eat gate won't re-post while food is unavailable, so the bot picks real work (farming the food)
    // and rides the runway down. Only the must-eat floor forces the executor with no food (its Law 13 halt).
    const { hasAccessibleFood } = require('@action/eat_executor');
    if (!verdict.must_eat && !hasAccessibleFood(bot)) {
      const readable = `${TAG}: hungry (food ${verdict.food}/20) but no food reachable yet — standing down; bot works while the farms produce.`;
      watcher.summary(TAG, readable);
      return routeToJudge(signalBus, TAG, { [TAG]: { success: true, food: verdict.food, stood_down: true }, readable });
    }

    // WORK: food is reachable (or the bot is at the must-eat floor) → dispatch the executor to feed the bot
    // (at the floor with no food it raises the Law 13 halt). Stamp this manager so recursive_judge routes the
    // executor's outcome back here to verify (the loop closes on the next re-sense above).
    const readable = `${TAG}: hungry (food ${verdict.food}/20) from=${from} → eat_executor.`;
    watcher.summary(TAG, readable);
    return routeSignal(signalBus, TAG, 'eat_executor', { ...payload, manager: TAG, readable });
  }),
};
