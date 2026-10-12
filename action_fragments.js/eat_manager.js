// fragment: eat_manager  (action / self-preservation)
// Routes the `eat` job: re-senses bot.food via health_integrity.scan on every call, fresh dispatch
// or eat_executor's return via recursive_judge (Invariant B). Releases to the judge when safe;
// dispatches eat_executor when hungry. Stands down when hungry but under the must-eat floor with no
// food reachable, so the bot works while food becomes available; the floor itself always forces the
// executor (its Law 13 halt). Reads the one shared availability predicate (Law 16).

'use strict';

const watcher = require('@kernel/watcher');
const healthIntegrity = require('@perception/health_integrity');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');

const TAG = 'eat_manager';

module.exports = {
  receive: watcher.track(TAG, function (signalType, payload = {}) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    const from = payload?.from || 'unknown';

    // health_integrity gates posting to a live, readable bot — no bot here is a coding fault (Law 13).
    if (!bot || typeof bot.food !== 'number') {
      throw new Error(`[${TAG}] CODING VIOLATION: dispatched with no bot/food loaded.`);
    }

    // Re-senses the fresh truth via health_integrity.scan (Invariant B).
    const verdict = healthIntegrity.scan(bot);

    // SUCCESS: full/above the eat line → release. recursive_judge sends a manager release on to job_board.
    if (!verdict.needs_to_eat) {
      const readable = `${TAG}: verified full — food ${verdict.food}/20. Safe → release.`;
      watcher.summary(TAG, readable);
      return routeToJudge(TAG, { [TAG]: { success: true, food: verdict.food }, readable });
    }

    // STAND DOWN: hungry but under the must-eat floor with no food reachable — releases so job_board
    // holds off reposting and the bot picks other work while food becomes available.
    const { hasAccessibleFood } = require('@action/eat_executor');
    if (!verdict.must_eat && !hasAccessibleFood(bot)) {
      const readable = `${TAG}: hungry (food ${verdict.food}/20) but no food reachable yet — standing down; bot works while the farms produce.`;
      watcher.summary(TAG, readable);
      return routeToJudge(TAG, { [TAG]: { success: true, food: verdict.food, stood_down: true }, readable });
    }

    // WORK: food reachable, or at the must-eat floor — dispatch the executor, stamped so
    // recursive_judge routes its outcome back here to verify.
    const readable = `${TAG}: hungry (food ${verdict.food}/20) from=${from} → eat_executor.`;
    watcher.summary(TAG, readable);
    return routeSignal(TAG, 'eat_executor', { ...payload, manager: TAG, readable });
  }),
};
