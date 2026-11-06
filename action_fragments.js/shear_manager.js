// fragment: shear_manager (action / ranching)
// Routing head of the shear job: the body takes the fleet's shears from the chest, shears the crew's woolly penned
// flock with a shepherd holding it, leaves the pen, and banks the wool and the shears (Law 15 API: shear_executor.shearPen).
//   - Sense    = the pen record (pen_gate.jobPen); which animals are woolly is the server's word, asked in shearPen.
//   - Executor = shear_executor.shearPen — standby, a shepherd holding, in through the gate, shear, pick up the wool.
//   - Exit     = pen_gate.leavePen (to the doorway, through, shut behind), then the standby cell is given up — the
//                shearer's word `out`, on which the shepherd leaves — and the wool banked.
// One signal lives for the whole job (Law 4) and it ends at recursive_judge.
//
// Every shearing ends with one `[HERD_LEDGER]` line (role=shearer) of seconds by step (walk, shepherd_wait, gate_wait,
// enter, shear, collect, exit, bank) and total_s, read by monitoring/herding_lens beside the herds; each step change is
// its own `[HERD_STEP]` line.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { depositItems, retrieveItems } = require('@api/inventory_swapper');
const { jobPen, penGeometry, leavePen, releasePark, sayPhase, tendClock } = require('@api/pen_gate');
const { shearPen } = require('@action/shear_executor');
const { kvLine } = require('@action/herd_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'shear_manager';
const STEPS = ['walk', 'shepherd_wait', 'gate_wait', 'enter', 'shear', 'collect', 'exit', 'bank'];

function _finish(success, readable, metrics) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable, [TAG]: { success, readable, metrics } });
}

// Banks every wool the body carries, colour by colour → the count banked, or null when a deposit was abandoned.
async function bankWool(bot) {
  let banked = 0;
  const kinds = [...new Set(bot.inventory.items().filter(i => /_wool$/.test(i.name)).map(i => i.name))];
  for (const name of kinds) {
    const n = bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
    const r = await depositItems(bot, name, n);
    if (!r) return null;
    banked += r.transferred;
  }
  return banked;
}

const hasShears = bot => bot.inventory.items().some(i => i.name === 'shears');

// Puts the shears back in the chest → how many went back, or null when the deposit was abandoned.
async function bankShears(bot) {
  const n = bot.inventory.items().filter(i => i.name === 'shears').reduce((s, i) => s + i.count, 0);
  if (!n) return 0;
  const r = await depositItems(bot, 'shears', n);
  if (!r) return null;
  watcher.summary(TAG, `SHEARS put back in the chest (${r.transferred})`);
  return r.transferred;
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the shear manager ran.`);
    const botId = process.env.BOT_ID || 'default';
    const { pen } = jobPen(botId) || {};
    if (!pen) return _finish(false, `${TAG}: the job names none of this crew's locked pens`, {});

    const clock = tendClock('shearer');
    // The job names the wool it shears for (assessors/ranching: what = '<color>_wool').
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const color = /^(\w+)_wool$/.exec(magnet?.what || '')?.[1];
    if (!color) return _finish(false, `${TAG}: the job names no wool color (what=${magnet?.what || '-'})`, {});
    // THE SHEARS COME FROM THE CHEST AND GO BACK TO IT (assessors/ranching: the pair is banked).
    if (!hasShears(bot)) {
      if (await retrieveItems(bot, 'shears', 1) === undefined) return;   // abandoned to the judge
      if (!hasShears(bot)) return _finish(false, `${TAG}: no shears in the chests to shear with`, {});
      watcher.summary(TAG, 'SHEARS taken from the chest for the shearing');
    }
    const sheared = await shearPen(bot, pen, clock, color);
    clock.to('exit');
    const out = await leavePen(bot, pen, pen.animal, { gateHeld: sheared.metrics.gate_held === true });
    if (sheared.metrics.park_held) {
      const geo = penGeometry(pen);
      sayPhase(geo, botId, 'shearer', 'out');
      releasePark(geo, botId);
    }
    clock.to('bank');
    const banked = await bankWool(bot);
    if (banked === null) return;   // the deposit abandoned to the judge
    const shearsBack = await bankShears(bot);
    if (shearsBack === null) return;   // the deposit abandoned to the judge
    const { t, total } = clock.done();
    const sm = sheared.metrics;
    watcher.summary('herd_ledger', `herd ${kvLine({
      result: sheared.result, role: 'shearer', total_s: total, ...Object.fromEntries(STEPS.map(s => [`${s}_s`, t[s] ?? null])),
      color: sm.color, penned: sm.penned, woolly: sm.woolly, shorn: sm.shorn, wool_got: sm.wool_got, woolly_left: sm.woolly_left, shepherd: sm.shepherd,
      off_cell: sm.off_cell, escaped: out.escaped ?? null, escaped_at: out.escaped_at || null, exit_fault: out.fault || null, banked, shears_banked: shearsBack, park: sm.park,
    })}`);
    const exit = out.fault ? `left the pen: FAILED ${out.fault}` : `left the pen, ${out.escaped} escaped`;
    _finish(sheared.success && !out.fault, `${sheared.readable}; ${exit}; banked ${banked} wool; ${total}s in all`,
      { result: sheared.result, shorn: sm.shorn, seconds: total });
  }),
};
