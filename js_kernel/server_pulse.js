// module: server_pulse
// purpose: THIS BODY HEARS THE SERVER'S TICK, AND ENDS WHEN THE SERVER STOPS TICKING.
//
// ── THE PULSE ────────────────────────────────────────────────────────────────────────────────────────
//   A Minecraft server sends every player the world time once a second (every 20 ticks), from its tick
//   loop. While the server is ticking, the packets arrive a second apart; when its tick loop stalls, they
//   stop. So the gap since the last time packet is how long the server has been frozen, measured live.
//
// ── WARN, THEN END ───────────────────────────────────────────────────────────────────────────────────
//   At SERVER_SILENCE.warn_ms of silence the body says the server is silent. At timeout_crash's limit the
//   whole run ends through timeout_crash, with THE SERVER STOPPED ANSWERING as the cause.
//   A silence that ends below the limit is said with its length when the pulse comes back.
//
// ── THE BODY'S OWN STALL IS NOT THE SERVER'S ────────────────────────────────────────────────────────
//   The check runs once a second on this body's own clock. A check that arrives late by more than
//   SERVER_SILENCE.self_ms means THIS process was frozen, and the silence measured across it says nothing
//   about the server; it is said as a body stall and the pulse is re-read from that moment.

'use strict';

const TAG = 'server_pulse';
const CHECK_MS = 1000;

let _armed = false;
let _last = null;   // wall ms of the newest time packet; null until the first one arrives

// silentMs() → how long ago the server's last time packet arrived; 0 before the first one. A wait on the
// server's answer reads this to tell a server that has not answered from one that is not ticking.
function silentMs() {
    return _last === null ? 0 : Date.now() - _last;
}

// arm(bot) — listen for the server's time packets. Called once, right after createBot.
function arm(bot) {
    if (!bot || !bot._client) {
        throw new Error(`[${TAG}] CODING VIOLATION: arm called with no client to listen on.`);
    }
    if (_armed) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): arm() called twice.`);
    }
    _armed = true;
    const { SERVER_SILENCE } = require('@thinking/architect_config');
    const watcher = require('@kernel/watcher');
    let last = null;          // wall ms of the newest time packet; null until the first one arrives
    let lastCheck = Date.now();
    let longest = 0;
    let warned = false;
    bot._client.on('update_time', () => { last = Date.now(); _last = last; _holdSaid = false; });
    const timer = require('@utils/timeout_crash').every(TAG, 'read how long the server has been silent', () => {
        const now = Date.now();
        const late = now - lastCheck - CHECK_MS;
        lastCheck = now;
        if (last === null) return;
        if (late > SERVER_SILENCE.self_ms) {
            watcher.warn(TAG, `BODY STALLED for ${late} ms — the server's silence across it is not read`);
            last = now;
            return;
        }
        const silent = now - last;
        if (silent >= SERVER_SILENCE.warn_ms) {
            longest = Math.max(longest, silent);
            if (!warned) { warned = true; watcher.warn(TAG, `SERVER SILENT for ${silent} ms — no tick from it`); }
        } else if (warned) {
            warned = false;
            watcher.warn(TAG, `SERVER BACK after a silence of ${longest} ms`);
            longest = 0;
        }
        // The one limit, and the one end: a server silent for timeout_crash's limit ends the whole run.
        const timeoutCrash = require('@utils/timeout_crash');
        if (silent >= timeoutCrash.LIMIT_MS) {
            timeoutCrash.stop(timer);
            timeoutCrash.crashEverything(TAG, `THE SERVER STOPPED ANSWERING: no tick from it for ${silent} ms`,
                'the server\'s own record of the stall is fleet_logs/server_gc.log and fleet_logs/server.jfr');
        }
    }, CHECK_MS);
    timer.unref();
}

// answering(bot) → resolves when the server is ticking: at once when its last time packet is under
// HOLD_AFTER_MS old, otherwise on the next one. A body that acts while the server is frozen sends moves
// and digs the server applies late or refuses, so each act that changes the world waits here first.
const HOLD_AFTER_MS = 2000;
// Said once per silence: every act that waits on the same silence waits for the same tick. An ordinary
// line: a server pauses for a moment in normal running, and the warning is the watch's at warn_ms.
let _holdSaid = false;
function answering(bot) {
    if (silentMs() < HOLD_AFTER_MS) return Promise.resolve();
    if (!_holdSaid) {
        _holdSaid = true;
        require('@kernel/watcher').summary(TAG, `HOLDING STILL — the server has been silent ${silentMs()} ms; the next act waits for its next tick`);
    }
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false);
    return new Promise(resolve => bot._client.once('update_time', resolve));
}

module.exports = { arm, silentMs, answering, TAG };
