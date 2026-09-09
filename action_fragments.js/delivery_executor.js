// fragment: delivery_executor
// purpose: Transfer items between bot inventory and station chests.
//          action='deliver' (default): deposit from inventory into chest.
//          action='retrieve': pull items from chest back into inventory.
//          Calls inventory_swapper (Law 15 API) to handle navigation,
//          chest interaction, and snapshot. Reports result to recursive_judge
//          via the manager stamp.

'use strict';

const watcher = require('@kernel/watcher');
const invSwap = require('@api/inventory_swapper');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'delivery_executor';

module.exports = {
    receive: watcher.track(TAG, async function (signalType, payload) {
        if (signalType !== TAG) return;

        const signalBus = require('@kernel/signal_bus');
        const bot       = global.bot;
        const item      = payload.objective;
        const quantity  = payload.quantity || 64;
        const stationId = payload.station_id;
        const action    = payload.action || 'deliver';

        watcher.summary(TAG, `${action} ${quantity}x ${item} — station ${stationId}`);

        // inventory_swapper is a Law 15 API — its throws are environmental failures
        // from mineflayer (chest locked, pathfinding failed). Those bubble up through
        // watcher.track and stop the bot. No catch here (Law 16: one pathway).
        const result = (action === 'retrieve')
            ? await invSwap.retrieveItems(bot, item, quantity, stationId)
            : await invSwap.depositItems(bot, item, quantity, stationId);

        // undefined = the swapper already abandoned this line to recursive_judge
        // (Law 15 — chest unreachable, lock-queue timeout, open failed). The
        // failure signal is in flight; throwing or routing here would raise a
        // SECOND report for the same failure (Law 4/16) — this crashed the
        // wheat_seeds deliver on 2026-07-05. Die quietly.
        if (result === undefined) return;

        // A resolved-but-unsuccessful result means the transfer ran and moved
        // nothing — the dispatch was wrong. That IS a coding violation: the
        // dispatcher must not route here unless the station has the item
        // (retrieve) or has space (deposit).
        if (!result.success) {
            throw new Error(
                `[${TAG}] CODING VIOLATION (Law 13): ${action} moved nothing for ${item} at station ${stationId}. ` +
                `The dispatcher should never send a ${action} to a station that cannot fulfill it. ` +
                `Check job_board's station request calculation and station_registry for stale data.`
            );
        }

        const transferred = result.transferred;
        const reason = `${action === 'retrieve' ? 'retrieved' : 'delivered'} ${transferred}x ${item} (station ${stationId})`;
        watcher.summary(TAG, `✅ ${reason}`);

        routeToJudge(signalBus, TAG, {
            manager:  payload.manager || null,
            readable: `${TAG}: ${reason}`,
            [TAG]:    { success: true, transferred, item, station_id: stationId, action },
        });
    }),
};
