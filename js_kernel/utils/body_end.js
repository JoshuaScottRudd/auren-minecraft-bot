// A stopped body releases its holds and drains its record before exiting (Law 8).
// Requires stay lazy because the watcher and foreman link also call this endpoint.
'use strict';
const EXIT_DEFER_MS = 2000;
let ending = null;

async function flushRecord(reason) {
    require('@kernel/bot_minutes').close(reason);
    require('@kernel/item_book').end();
    require('@thinking/dispatcher.js').clearMagnet();
    await require('@kernel/corporate_headquarters').flushNow();
    await require('@kernel/watcher').flush();
}

// The first stop owns the cause; repeated disconnect notifications share its drain.
function endBody(reason, opts = {}) {
    if (ending) return ending;
    require('@kernel/foreman_link').standDown(reason);
    ending = (async () => {
        await flushRecord(reason);
        if (require('@utils/foreman_gone').isWitness()) {
            console.log(`⚠️ ${reason} — this body is the fleet's last witness, so its window stays open. Close it when you have read the report above.`);
            return;
        }
        if (!opts.immediate) await new Promise(resolve => setTimeout(resolve, EXIT_DEFER_MS));
        console.log(`⚠️ ${reason} — this body is finished. Exiting so it stops costing the machine.`);
        await require('@utils/console_lane').drained(3000);
        process.exit(opts.code === undefined ? 0 : opts.code);
    })();
    return ending;
}

module.exports = { endBody, flushRecord, EXIT_DEFER_MS };
