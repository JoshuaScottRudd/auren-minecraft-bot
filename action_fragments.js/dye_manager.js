// fragment: dye_manager (action / ranching)
// Routing head of the dye job: one body takes the dye of one color and a wheat, dyes the pen's white animals that color
// from outside the fence, then banks what is left (Law 15 API: dye_executor.dyePen).
//   - Sense    = the pen record (pen_gate.jobPen); the job names the dye (`what`, '<color>_dye') and how many animals
//                (`need`): assessors/ranching's share of the flock for that color, less those already that color.
//   - Executor = dye_executor.dyePen — walk to the shepherd post, ask the server the colors, dye the nearest white.
//   - Exit     = the dye and the wheat go back to the chests.
// One signal lives for the whole dyeing (Law 4) and it ends at recursive_judge.
//
// Every dyeing ends with one `[HERD_LEDGER]` line (role=dyer), read by monitoring/herding_lens beside the herds.

'use strict';

const watcher = require('@kernel/watcher');
const hq = require('@kernel/corporate_headquarters');
const { DYES } = require('@thinking/architect_config');
const { retrieveItems, depositItems } = require('@api/inventory_swapper');
const { jobPen } = require('@api/pen_gate');
const { dyePen } = require('@action/dye_executor');
const { kvLine } = require('@action/herd_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'dye_manager';
const LURE = 'wheat';

const held = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const sec = (from) => +((Date.now() - from) / 1000).toFixed(1);

function _finish(success, readable, metrics) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable, [TAG]: { success, readable, metrics } });
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the dye manager ran.`);
    const botId = process.env.BOT_ID || 'default';
    const { pen } = jobPen(botId) || {};
    if (!pen) return _finish(false, `${TAG}: the job names none of this crew's locked pens`, {});
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const color = Object.keys(DYES).find(c => DYES[c].dye === magnet?.what);
    const count = Number.isInteger(magnet?.need) ? magnet.need : 0;
    if (!color || count <= 0) return _finish(false, `${TAG}: the job names no dye and count (what=${magnet?.what || '-'} need=${magnet?.need ?? '-'})`, {});
    const dye = DYES[color].dye;

    let at = Date.now();
    if (held(bot, dye) < count && await retrieveItems(bot, dye, count - held(bot, dye)) === undefined) return;   // abandoned to the judge
    if (held(bot, LURE) === 0 && await retrieveItems(bot, LURE, 1) === undefined) return;
    const fetchS = sec(at);
    if (held(bot, dye) === 0) {
      watcher.summary('herd_ledger', `herd ${kvLine({ result: 'no_dye_in_chests', role: 'dyer', color, fetch_s: fetchS })}`);
      return _finish(false, `${TAG}: no ${dye} in the chests`, {});
    }

    at = Date.now();
    const dyed = await dyePen(bot, pen, color, Math.min(count, held(bot, dye)));
    const dyeS = sec(at);
    at = Date.now();
    let banked = 0;
    for (const name of [dye, LURE]) {
      const n = held(bot, name);
      if (n === 0) continue;
      const r = await depositItems(bot, name, n);
      if (!r) return;   // the deposit abandoned to the judge
      banked += r.transferred;
    }
    watcher.summary('herd_ledger', `herd ${kvLine({
      result: dyed.result, role: 'dyer', color, fetch_s: fetchS, dye_s: dyeS, bank_s: sec(at), asked: dyed.asked,
      white: dyed.white, wanted: count, dyed: dyed.dyed, now_color: dyed.now_color, banked,
    })}`);
    const ok = dyed.result === 'dyed' || dyed.result === 'tending_at_the_pen';
    _finish(ok, `${TAG}: ${dyed.result} — dyed ${dyed.dyed} of ${count} ${color} (${dyed.white} white of ${dyed.asked}); the pen holds ${dyed.now_color ?? '?'} ${color}; banked ${banked}`,
      { result: dyed.result, dyed: dyed.dyed, seconds: dyeS });
  }),
};
