// fragment: cull_manager (action / ranching)
// Routing head of the cull job: a full meat pen's grown animals past its breeding stock are slaughtered with a shepherd
// holding the flock, the culler leaves the pen, and banks the meat and hide (Law 15 API: cull_executor.cullPen).
//   - Sense    = the pen the job names (pen_gate.jobPen); which animals are grown is the server's word, asked in cullPen.
//   - Executor = cull_executor.cullPen — standby, a shepherd holding, in through the gate, cull, pick up the drops.
//   - Exit     = pen_gate.leavePen (to the doorway, through, shut behind), then the standby cell is given up — the
//                culler's word `out`, on which the shepherd leaves — and the produce banked.
// One signal lives for the whole job (Law 4) and it ends at recursive_judge.
//
// Every cull ends with one `[HERD_LEDGER]` line (role=culler) of seconds by step (walk, shepherd_wait, gate_wait, enter,
// cull, collect, exit, bank) and total_s, read by monitoring/herding_lens beside the herds.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { depositItems } = require('@api/inventory_swapper');
const { jobPen, penGeometry, leavePen, releasePark, sayPhase, tendClock } = require('@api/pen_gate');
const { cullPen, PRODUCE } = require('@action/cull_executor');
const { kvLine } = require('@action/herd_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'cull_manager';
const STEPS = ['walk', 'shepherd_wait', 'gate_wait', 'enter', 'cull', 'collect', 'exit', 'bank'];

function _finish(success, readable, metrics) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable, [TAG]: { success, readable, metrics } });
}

// Banks every piece of meat and hide the body carries, kind by kind → the count banked, or null when a deposit was
// abandoned.
async function bankProduce(bot) {
  let banked = 0;
  const kinds = [...new Set(bot.inventory.items().filter(i => PRODUCE.test(i.name)).map(i => i.name))];
  for (const name of kinds) {
    const n = bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
    const r = await depositItems(bot, name, n);
    if (!r) return null;
    banked += r.transferred;
  }
  return banked;
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the cull manager ran.`);
    const botId = process.env.BOT_ID || 'default';
    const { pen } = jobPen(botId) || {};
    if (!pen) return _finish(false, `${TAG}: the job names none of this crew's locked pens`, {});
    // The job names how many grown animals it culls (assessors/ranching: need = penned past the breeding stock).
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const count = magnet?.need;
    if (!Number.isInteger(count) || count < 1) return _finish(false, `${TAG}: the job names no count to cull (need=${count ?? '-'})`, {});

    const clock = tendClock('culler');
    const culled = await cullPen(bot, pen, clock, count, { strangers: magnet.strangers || null });
    clock.to('exit');
    const out = await leavePen(bot, pen, pen.animal, { gateHeld: culled.metrics.gate_held === true });
    if (culled.metrics.park_held) {
      const geo = penGeometry(pen);
      sayPhase(geo, botId, 'culler', 'out');
      releasePark(geo, botId);
    }
    clock.to('bank');
    const banked = await bankProduce(bot);
    if (banked === null) return;   // the deposit abandoned to the judge
    const { t, total } = clock.done();
    const cm = culled.metrics;
    watcher.summary('herd_ledger', `herd ${kvLine({
      result: culled.result, role: 'culler', total_s: total, ...Object.fromEntries(STEPS.map(s => [`${s}_s`, t[s] ?? null])),
      animal: cm.animal, penned: cm.penned, grown: cm.grown, wanted: cm.wanted, culled: cm.culled, left: cm.left, produce_got: cm.produce_got, leather_got: cm.leather_got, drops_left: cm.drops_left,
      weapon: cm.weapon, shepherd: cm.shepherd, off_cell: cm.off_cell, escaped: out.escaped ?? null, escaped_at: out.escaped_at || null,
      exit_fault: out.fault || null, banked, park: cm.park,
    })}`);
    const exit = out.fault ? `left the pen: FAILED ${out.fault}` : `left the pen, ${out.escaped} escaped`;
    _finish(culled.success && !out.fault, `${culled.readable}; ${exit}; banked ${banked} meat and hide; ${total}s in all`,
      { result: culled.result, culled: cm.culled, seconds: total });
  }),
};
