// chest_lock_utils.js — the ONE wait-for-release primitive for peer-locked chests.
//
// A locked chest stays fully VISIBLE — its last snapshot may feed any
// calculation — but locked means wait-to-act: a bot whose work needs THAT
// chest waits for the holder to finish, then acts on the fresh post-release
// snapshot. A bot that doesn't need the chest just continues on. Lock
// durations are short relative to a replan, so waiting is cheaper than
// replanning around the chest; the timeout only exists for the pathological
// case (holder crashed mid-job) and is handed back to the caller as an
// environmental outcome — this util never throws, never routes, never moves
// the bot (Law 15 failure ownership stays with the caller; Law 16: every
// waiter goes through this one primitive).

'use strict';

const stationRegistry = require('@perception/station_registry');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_MS = 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Resolves { released, holder, waitedMs }. released=true immediately (waitedMs
// ~0) when the chest is already free — callers may invoke it unconditionally.
async function waitUntilChestFree(stationId, opts = {}) {
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const pollMs = opts.pollMs !== undefined ? opts.pollMs : DEFAULT_POLL_MS;
    const t0 = Date.now();
    let holder = stationRegistry.getLockHolder(stationId);
    while (holder && Date.now() - t0 < timeoutMs) {
        await sleep(pollMs);
        holder = stationRegistry.getLockHolder(stationId);
    }
    return { released: !holder, holder: holder || null, waitedMs: Date.now() - t0 };
}

module.exports = { waitUntilChestFree };
