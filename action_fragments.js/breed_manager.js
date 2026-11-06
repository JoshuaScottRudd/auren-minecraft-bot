// fragment: breed_manager (action / ranching)
// Routing head of the breed job: one body takes two wheat for each pair the job names, runs one breeding round at
// the pen, writes the round's time on the pen's breeding clock, then banks what wheat is left (Law 15 API:
// herd_executor.breedRound).
//   - Sense    = the pen record (pen_gate.jobPen) and the job's pair count (magnet need, assessors/ranching).
//   - Executor = herd_executor.breedRound — walk to the shepherd post and feed every animal that comes to the fence.
//   - Exit     = the round written (pen_gate.writeBreedRound), the wheat back in the chests.
// One signal lives for the whole feed (Law 4) and it ends at recursive_judge.
//
// Every feed ends with one `[HERD_LEDGER]` line (role=breeder), read by monitoring/herding_lens beside the herds.

'use strict';

const watcher = require('@kernel/watcher');
const { retrieveItems, depositItems } = require('@api/inventory_swapper');
const hq = require('@kernel/corporate_headquarters');
const { jobPen, writeBreedRound } = require('@api/pen_gate');
const { breedRound, kvLine } = require('@action/herd_executor');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'breed_manager';
const FEED = 'wheat';
const PAIR = 2;

const wheatHeld = bot => bot.inventory.items().filter(i => i.name === FEED).reduce((n, i) => n + i.count, 0);
const sec = (from) => +((Date.now() - from) / 1000).toFixed(1);

function _finish(success, readable, metrics) {
  if (success) watcher.summary(TAG, readable); else watcher.warn(TAG, readable);
  routeToJudge(TAG, { readable, [TAG]: { success, readable, metrics } });
}

module.exports = {
  receive: watcher.track(TAG, async function (signalType) {
    if (signalType !== TAG) return;
    const bot = global.bot;
    if (!bot?.entity?.position) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before the breed manager ran.`);
    const botId = process.env.BOT_ID || 'default';
    const { structure, pen } = jobPen(botId) || {};
    if (!pen) return _finish(false, `${TAG}: the job names none of this crew's locked pens`, {});
    const magnet = hq.readBoardroomChair(botId, {})?.magnet;
    const pairs = magnet?.need;
    if (!Number.isInteger(pairs) || pairs < 1) return _finish(false, `${TAG}: the job names no pairs to feed (need=${pairs ?? '-'})`, {});

    let at = Date.now();
    const want = PAIR * pairs;
    if (wheatHeld(bot) < want && await retrieveItems(bot, FEED, want - wheatHeld(bot)) === undefined) return;   // abandoned to the judge
    const fetchS = sec(at);
    if (wheatHeld(bot) < PAIR) {
      watcher.summary('herd_ledger', `herd ${kvLine({ result: 'no_wheat_in_chests', role: 'breeder', fetch_s: fetchS })}`);
      return _finish(false, `${TAG}: fewer than ${PAIR} wheat in the chests to feed a pair`, {});
    }

    at = Date.now();
    const bred = await breedRound(bot, pen, Math.min(pairs, Math.floor(wheatHeld(bot) / PAIR)), magnet?.pairs_by || null);
    const breedS = sec(at);
    // The round is on the clock whatever it fed: the next is posted HERDING.breed_every_ms after its first feed (when the
    // game's cooldown began), or after now when it fed none. A round that never reached the pen's post leaves the clock as it was.
    if (bred.result === 'fed' || bred.result === 'none_fed' || bred.result === 'no_wheat') writeBreedRound(structure, { pairs, fed: bred.fed, ...(Number.isFinite(bred.first_fed_at) ? { at: bred.first_fed_at } : {}) });
    at = Date.now();
    const n = wheatHeld(bot);
    const r = n === 0 ? { transferred: 0 } : await depositItems(bot, FEED, n);
    if (!r) return;   // the deposit abandoned to the judge
    watcher.summary('herd_ledger', `herd ${kvLine({
      result: bred.result, role: 'breeder', fetch_s: fetchS, breed_s: breedS, bank_s: sec(at), pairs, penned: bred.penned,
      fed: bred.fed, refused: bred.refused, in_love: bred.in_love, banked: r.transferred,
    })}`);
    // A round that fed nobody is not a failure: the clock waits out the cooldown and the next round tries again.
    const ok = bred.result === 'fed' || bred.result === 'none_fed' || bred.result === 'tending_at_the_pen';
    _finish(ok, `${TAG}: ${bred.result} — fed ${bred.fed} of ${PAIR * pairs} (${bred.refused} refused, ${bred.penned} penned), ${bred.in_love ?? '?'} in love; banked ${r.transferred} wheat`,
      { result: bred.result, fed: bred.fed, seconds: breedS });
  }),
};
