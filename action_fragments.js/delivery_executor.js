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

        // ── A RACE BETWEEN TWO BOTS IS NOT A CODING VIOLATION (Architect 2026-09-12) ──────────────
        // *"a code 13 violation should be a true coding violation… double check that theres no
        // enviomental throws."*
        //
        // THIS THREW UNTIL TODAY, AND ITS OWN MESSAGE NAMED THE REASON IT SHOULD NOT HAVE: it told the
        // reader to check `station_registry` **for stale data**. Stale registry data is a world fact, not
        // a miscoding — and in a fleet of two or more bots it is the EXPECTED one. The plan is made from a
        // scan of what a chest held; by the time this body opens that chest a peer may have taken the last
        // of it, or filled the slot a deposit was sized for. Nothing in the dispatcher can close that gap,
        // because the gap is the travel time between sensing and arriving (Invariant B — re-sense, never
        // remember; the re-sense IS this call, and this is it returning what it found).
        //
        // A user's chest being emptied by their own second bot should not stop that bot. So the shortfall
        // is REPORTED with `success:false` — a real counted fault the judge and the manager can act on,
        // naming the station and the item — and the loop re-plans against what the world now holds. The
        // trace still says a transfer moved nothing; what it no longer does is kill the signal chain
        // outside the judge and leave the body sitting there looking alive (Law 25).
        if (!result.success) {
            const shortfall = `${action} moved nothing for ${item} at station ${stationId} — the station could not fulfill it. `
                + `Most likely a peer took or filled it between the plan and the arrival; re-sensing and re-planning.`;
            watcher.warn(TAG, shortfall);
            return routeToJudge(TAG, {
                manager:  payload.manager || null,
                readable: `${TAG}: ${shortfall}`,
                [TAG]:    { success: false, transferred: 0, item, station_id: stationId, action },
                success:  false,
            });
        }

        const transferred = result.transferred;
        const reason = `${action === 'retrieve' ? 'retrieved' : 'delivered'} ${transferred}x ${item} (station ${stationId})`;
        watcher.summary(TAG, `✅ ${reason}`);

        routeToJudge(TAG, {
            manager:  payload.manager || null,
            readable: `${TAG}: ${reason}`,
            [TAG]:    { success: true, transferred, item, station_id: stationId, action },
        });
    }),
};
