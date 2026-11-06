// fragment: shepherd_manager (action / ranching)
// Routing head of the shepherd job: one body takes a wheat, holds the crew's penned flock against the long side while a
// tender works the pen (a bringer dropping a flock off, a shearer shearing), then banks the wheat and goes
// (Law 15 API: herd_executor.shepherdFor).
//   - Sense    = the pen record (pen_gate.jobPen); the tender standing by and the post are read in shepherdFor.
//   - Executor = herd_executor.shepherdFor — walk to the post, show the wheat, check every penned animal is in tempt
//                reach (stepping along the long side toward any that are not), say it is holding, hold until the
//                tender says it is out with the gate shut.
//   - Exit     = the wheat goes back to the chests.
// One signal lives for the whole hold (Law 4) and it ends at recursive_judge.
//
// THE SHEPHERD JOB IS URGENT. assessors/ranching posts it while a tender holds the standby cell with no shepherd: the
// tender opens the gate on nothing less, so every minute without one is a minute it waits.
//
// Every hold ends with one `[HERD_LEDGER]` line (role=shepherd) of seconds by step (fetch, walk, place, hold, bank) and
// total_s, read by monitoring/herding_lens beside the herds; each step change is its own `[HERD_STEP]` line.

'use strict';

const watcher = require('@kernel/watcher');
const { retrieveItems, depositItems } = require('@api/inventory_swapper');
const { jobPen, tendClock } = require('@api/pen_gate');
const { shepherdFor, kvLine } = require('@action/herd_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'shepherd_manager';
const LURE = 'wheat';
const STEPS = ['fetch', 'walk', 'place', 'hold', 'bank'];

const wheatHeld = bot => bot.inventory.items().filter(i => i.name === LURE).reduce((n, i) => n + i.count, 0);

function _finish(success, readable, metrics) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable, [TAG]: { success, readable, metrics } });
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the shepherd manager ran.`);
    const { pen } = jobPen(process.env.BOT_ID || 'default') || {};
    if (!pen) return _finish(false, `${TAG}: the job names none of this crew's locked pens`, {});

    const clock = tendClock('shepherd');
    clock.to('fetch');
    if (wheatHeld(bot) === 0 && await retrieveItems(bot, LURE, 1) === undefined) return;   // abandoned to the judge
    if (wheatHeld(bot) === 0) {
      const { t, total } = clock.done();
      watcher.summary('herd_ledger', `herd ${kvLine({ result: 'no_wheat_in_chests', role: 'shepherd', total_s: total, fetch_s: t.fetch ?? null })}`);
      return _finish(false, `${TAG}: no wheat in the chests to hold the flock with`, {});
    }

    const held = await shepherdFor(bot, pen, clock);
    clock.to('bank');
    const n = wheatHeld(bot);
    const r = n === 0 ? { transferred: 0 } : await depositItems(bot, LURE, n);
    if (!r) return;   // the deposit abandoned to the judge
    const { t, total } = clock.done();
    const reach = held.reach || {};
    const result = held.fault || (held.held ? 'held' : 'no_tender_to_hold_for');
    watcher.summary('herd_ledger', `herd ${kvLine({
      result, role: 'shepherd', held_for: held.held_for, total_s: total, ...Object.fromEntries(STEPS.map(s => [`${s}_s`, t[s] ?? null])),
      penned: reach.penned ?? null, in_reach: reach.in_reach ?? null, out_of_reach: reach.out_of_reach ?? null,
      out_at: reach.out_at || null, swept: held.sweep ? held.sweep.stands : null, sweep_missed: held.sweep ? held.sweep.missed : null, shepherd_at: reach.shepherd_at || null, off_cell: held.off_cell || null,
      shooed: held.shooed ?? null, foreign: held.foreign || null, banked: r.transferred,
    })}`);
    // Nobody to hold for is the board's word arriving late, not a failure: the tender finished or a peer took the post.
    _finish(!held.fault, `${TAG}: ${result}${held.held_for ? ` for ${held.held_for}` : ''} in ${Math.round(total)}s; banked ${r.transferred} wheat`,
      { result, held_for: held.held_for, seconds: total });
  }),
};
