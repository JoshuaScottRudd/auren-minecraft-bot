// fragment: craft_executor
// purpose: Signal-bus wrapper for the craft_handler API (Law 15). Receives a
//          crafting signal, delegates all resolution and execution to the API,
//          then routes the result to recursive_judge. All crafting logic lives
//          in @api/craft_handler — this fragment only reads signals and routes
//          payloads.
//
// invariants:
//  - craft_handler.craftItems() returns on success OR on a partial this seat
//    explicitly asked for, abandons the caller when nothing could be made, and
//    throws on coding violations. So two outcomes reach here and one never
//    does: a full craft and a short one both continue, an empty one does not.
//  - A partial continues but is NOT relabelled a success — the capsule flag
//    stays false and the readable names the shortfall (Law 25). Downstream
//    reads that verdict as settled fact and never re-derives it, so a short
//    craft wearing a success flag would be a lie no later unit could catch.
//  - Routing: both outcomes → recursive_judge via manager stamp.
//  - Readable string includes progress tag for recursive_judge's loop detector.

'use strict';

const watcher = require('@kernel/watcher');
const { craftItems } = require('@api/craft_handler');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'craft_executor';

module.exports = {
  receive: watcher.track(TAG, async (signalType, payload) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    const signalBus = require('@kernel/signal_bus');
    const targetItem = payload.objective;
    const quantity = Math.max(1, Number(payload.quantity) || 1);

    watcher.summary(TAG, `Crafting "${targetItem}" x${quantity}`);

    // Capsule exists early so even early exits expose structure
    const capsule = payload.craft_executor || (payload.craft_executor = { objective: targetItem });

    // Delegate to craft_handler API (Law 15). Three outcomes:
    //   1. Returns result object → success path below
    //   2. Abandons caller → this code never resumes
    //   3. Throws → propagates through watcher.track, stops the bot
    // ALLOWS A PARTIAL, AND THIS SEAT IS WHY THE OPTION EXISTS. A supply row tops a holder up toward a
    // keep level; it is not staging a structure that must be complete before the first block is placed.
    // So a short craft is material the fleet KEEPS and progress it does not repeat, and the remainder is
    // re-posted by the board when more input arrives — the pull chain running, not a failure to retry.
    // Withholding here is what made the whole run torchless: a threshold held fuel back, nothing spent
    // it, and a bar one unit from opening was indistinguishable from a broken one (Law 25 — the asker
    // owns the criterion, and this asker's criterion is "whatever we can make now").
    const result = await craftItems(bot, targetItem, quantity, payload, { allowPartial: true });

    // craft_handler returns undefined on caller abandonment — guard just in case
    if (!result) return;
    if (!result.success && !result.partial) return;

    const { metrics, progressTag, sequenceLength } = result;

    // The flag stays FALSE on a short craft and the readable states the shortfall. The work is real and
    // the signal continues, but nothing downstream is told the order was filled (Law 25).
    capsule.success = !!result.success;
    capsule.result = result.partial ? 'crafted_partial' : 'crafted';
    if (result.partial) {
      capsule.made = result.made;
      capsule.shortfall = result.shortfall;
    }
    capsule.crafted = targetItem;
    capsule.sequence_length = sequenceLength;
    capsule.metrics = metrics;
    // The verdict word is the outcome, not a constant. It also feeds the loop judge, which compares
    // successive readables: a partial that keeps making headway reads differently each pass, while one
    // that has genuinely stopped moving repeats and is killed — which is the judge doing its job.
    const verdict = result.partial ? `partial +${result.made} short ${result.shortfall}` : 'success';
    capsule.readable = `${TAG}: ${verdict} ${targetItem} crafts_ok=${metrics.crafts_ok} ` +
      `crafts_fail=${metrics.crafts_fail} placed=${metrics.stations_placed} ` +
      `reused=${metrics.stations_reused} ${progressTag}`;

    payload.readable = capsule.readable;
    // Drop the leftovers before handing back — a craft overshoots by design (a plank recipe
    // yields 4 for a job needing 1), and those leftovers ride in the pocket until something
    // kills the bot. Dropping here is the cheapest drop-off in the fleet: the craft just
    // happened AT a crafting table, which stands in the base beside the chest.
    // BEFORE routeToJudge, never after — routeToJudge dispatches, so anything awaited past it races the
    // judge's next dispatch. Same seam, same reason, as the gather side.
    // `abandoned` = the drop-off already routed to the judge (Law 15); routing again would be a second
    // live signal (Law 4).
    const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
    if (drop?.abandoned) return;
    routeToJudge(signalBus, TAG, { ...payload });
  })
};
