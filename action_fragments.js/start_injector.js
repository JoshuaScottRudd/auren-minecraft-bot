/**
 * fragment: start_injector
 * purpose: Manual bootstrap lever to flush transient state artifacts and kick the autonomous planning loop (task_delegator).
 * invariants:
 *   - watcher.json flushed on start; failure aborts injection (required for clean arc history).
 *   - A body carrying a placement player is STANDING BESIDE THEM, confirmed, before anything is routed.
 *   - Emits exactly one routed signal (start_command -> task_delegator) per inject() call, and none at
 *     all when either the flush or the placement gate refuses.
 * WHY: Provides an operator / dev entry point to reinitialize planning without restarting the whole process. Explicitly
 *      clearing watcher artifacts avoids the planner reasoning over stale arc history from a previous session.
 */
const fs = require('fs');
const path = require('path');
const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const { guardExternalSync } = require('@utils/external_library_guard');

// Config: toggle whether 'start' also triggers a system flush beforehand
const CONFIG = {
  alsoFlushOnStart: false // set to false to skip calling flush_system before starting
};

// watcher files live in js_kernel; hard-reset on start so history doesn't leak across restarts
const _siBotId = process.env.BOT_ID || '';
const _siKernelDir = path.dirname(require.resolve('@kernel/watcher.js'));
const WATCHER_JSON_PATH = require('@utils/record_homes').traceFile(_siBotId);

module.exports = {
  handle: 'start_injector',

  inject: async function () {
    // Reset the runtime clock so all watcher timestamps count from this moment
    watcher.resetRuntimeClock();

    // Optional: run system flush before starting
    if (CONFIG.alsoFlushOnStart) {
      // Unguarded: flush_system is ours, and starting a run on a flush that failed is how a run inherits
      // the previous one's state while the log says it was cleaned (Law 13 — default stopped).
      const { flush } = require('@kernel/flush_system.js');
      watcher.summary('start_injector', '🧹 Pre-start flush enabled; invoking flush_system...');
      await flush();
      watcher.summary('start_injector', '✅ flush_system complete. Proceeding with start.');
    }
    // Flush watcher file
    // A REAL BOUNDARY (fs), and the one place in this fragment where refusing to start is right: the run
    // record is the only thing that survives the run, so beginning one on top of the last one's trace
    // makes both unreadable. Truncate to EMPTY, not to an empty object — the story file is JSONL, and a
    // `{}` written into it is a line the reader cannot parse sitting at the top of the run.
    const flushed = guardExternalSync('start_injector', `flush watcher file at ${WATCHER_JSON_PATH}`,
      () => fs.writeFileSync(WATCHER_JSON_PATH, '', 'utf8'));
    if (!flushed.ok) return { started: false, why: `the run record at ${WATCHER_JSON_PATH} could not be cleared, so no run was begun` };
    watcher.summary('start_injector', `🧼 Flushed watcher file at ${WATCHER_JSON_PATH}`);

    // Start the global runtimer so uptime is tracked in watcher.json
    const timer = watcher.timer.start('runtimer', { source: 'start_injector' });
    watcher.summary('start_injector', `⏱️ runtimer started (elapsed=${timer.elapsed})`);

    // ── THE PLACEMENT GATE — BE STANDING WITH YOUR PERSON BEFORE YOU PLAN (Architect 2026-09-10) ────
    // *"the teleport needs to happen before they scan homebase… so teleport is a part of the start
    // process and the start command should not run until its been confirmed that teleport is completed
    // fully and the bot is near the player then it gives a start command."*
    //
    // WHY IT IS HERE AND NOT IN master_core. A start happens two ways — a body born started injects its
    // own, and an operator types `start` at the readline — and both arrive at this one function. Putting
    // the gate at the birth call site would have left the operator's verb ungated, which is the same
    // capability reached by two routes with one of them missing the check (Law 16). One place, so a
    // start cannot happen without passing it.
    //
    // WHY IT IS BEFORE THE ROUTE AND AFTER THE FLUSH. The flush above is what makes the run's record
    // start clean, so a refusal written after it lands in the trace a reader will actually open; a
    // refusal recorded before the flush would be erased by the next attempt. And it is before the route
    // because routing IS the start — the first thing the planning loop does is survey for a base, and
    // surveying from the wrong place is the whole fault this gate exists to close. Measured 2026-09-10:
    // the survey ran 0.2s before the desk's teleport landed, three runs in a row, so the base layout was
    // decided at the world spawn while the person who asked stood 130 blocks away.
    //
    // A BODY NOBODY PLACED STARTS WHERE IT STANDS. `startNearPlayer()` returns null only when no person
    // was named, which is the hand-launched single bot `beginsWorkAtBirth` describes — and inventing a
    // player to walk it to would be defaulting a missing field (Law 13). Everything the desk raises
    // carries a person, and a contractor derives one from its owner, so every fetched body is gated.
    const placeBeside = require('@kernel/bot_mandate').startNearPlayer();
    if (placeBeside) {
      const placed = await require('@kernel/body_recovery').arriveAtPlayer(global.bot, placeBeside);
      if (!placed.arrived) {
        // REFUSED, NOT STARTED-ANYWAY (Law 13, default-stopped). A body that plans from the wrong place
        // locks a base layout somewhere nobody chose, and a lock is the one act in the startup sequence
        // that outlives the mistake — it is written to the headquarters and every later job reads it.
        // Standing still and saying why is recoverable; a base in the wrong world is not.
        watcher.error('start_injector',
          `⛔ NOT STARTED — this body must be standing with ${placeBeside} before it plans, and it is not: ${placed.error}. `
          + 'Nothing was surveyed and nothing was locked. Place it and start it again.');
        return { started: false, why: `it is not standing with ${placeBeside}: ${placed.error}` };
      }
      watcher.summary('start_injector',
        `📍 Placed beside ${placeBeside} — ${placed.distance.toFixed(1)} blocks away. The base will be surveyed from here.`);
    }

    watcher.summary('start_injector', '🧪 Injected autonomous start signal to recursive_judge');
    // REQUIRED HERE, NOT AT MODULE SCOPE, and it is a cycle rather than a style choice:
    //   signal_bus:28 → fragment_registry:56 → start_injector → signal_bus
    // A module-scope require lands mid-way through signal_bus's own load whenever the bus is the one
    // pulled in first, so this file captured `{}` and kept it for the life of the process. MEASURED
    // live 2026-08-07: `verb start` on a sentry-armed bot threw "signalBus.route is not a function"
    // from signal_utils:44 — an unhandled rejection outside the judge, i.e. the operator's start verb
    // silently unavailable on exactly the runs that had already loaded the bus. Every other fragment
    // in the fleet already resolves the bus at call time (recursive_judge:180 is the pattern); this
    // file was the lone module-scope holdout.
    routeToJudge('start_injector', {
      readable: 'start_injector: starting autonomous planning loop with clean state',
      start_injector: { success: true },
    });
    // ── THE OUTCOME IS RETURNED, BECAUSE A CALLER THAT ASSUMES IT WILL ANNOUNCE A LIE (Law 25) ──────
    // Both callers — master_core's birth path and the `start` verb — used to fire this and immediately
    // print that the start signal had been injected, which was safe only while the single failure here
    // was a flush that never fails in practice. The placement gate above makes refusal an ordinary
    // outcome, and the first negative test of it printed *"🚀 Homesteader — launched to work. Autonomous
    // start signal injected."* to the terminal while the trace recorded that nothing had started. The
    // console is the half a person actually reads, so the truth has to reach it.
    return { started: true, why: null };
  }
};
