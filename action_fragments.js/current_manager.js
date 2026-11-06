// fragment: current_manager (action / leaving running water) — TEMPORARY: it stands until a body swims a current as a
// priced move, and is then removed with the current reflex and the current gate.
//
// The manager seat for the one job a body in running water may hold (assessors/current). The controls are the current
// reflex's (underwater_swimming): this waits while the reflex holds the body, and when the body is still carried with
// nothing holding it (on its feet in a shallow current), asks that same unit's ashore. Verified by sensing: the body is
// out when inCurrent reads false (Law 26). Either way it routes to the judge, and the next sweep posts leave_current
// again while the body is still in the water: that re-post is the only retry.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const { sleep } = require('@utils/fragment_utils');

const TAG = 'current_manager';
const WAIT_MS = 20000;   // the longest this waits on the reflex before it reports and the board decides again

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the current manager ran.`);
    const swimming = require('@locomotion/underwater_swimming');

    const finish = (readable) => {
      watcher.summary(TAG, readable);
      const capsule = payload[TAG] || (payload[TAG] = {});
      capsule.readable = readable;
      return routeToJudge(TAG, { ...payload, readable });
    };

    const end = Date.now() + WAIT_MS;
    while (swimming.inCurrent(bot) && swimming.survivalHasControl(bot) && Date.now() < end && bot.health > 0) await sleep(100);
    if (swimming.inCurrent(bot) && !swimming.survivalHasControl(bot) && bot.health > 0) {
      const out = await swimming.ashore(bot);
      if (!out.ok) return finish(`${TAG}: still in running water at ${bot.entity.position.floored()} — ashore: ${out.reason}`);
    }
    const at = bot.entity.position.floored();
    return finish(swimming.inCurrent(bot)
      ? `${TAG}: still in running water at ${at} after ${WAIT_MS / 1000}s — the reflex holds the body; replanning`
      : `${TAG}: out of running water at ${at}`);
  }),
};
