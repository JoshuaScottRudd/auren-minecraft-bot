/**
 * fragment: start_injector
 * purpose: Manual bootstrap lever to flush transient state artifacts and kick the autonomous planning loop (task_delegator).
 * invariants:
 *   - watcher.json flushed on start; failure aborts injection (required for clean arc history).
 *   - Emits exactly one routed signal (start_command -> task_delegator) per inject() call.
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
    if (!flushed.ok) return;
    watcher.summary('start_injector', `🧼 Flushed watcher file at ${WATCHER_JSON_PATH}`);

    // Start the global runtimer so uptime is tracked in watcher.json
    const timer = watcher.timer.start('runtimer', { source: 'start_injector' });
    watcher.summary('start_injector', `⏱️ runtimer started (elapsed=${timer.elapsed})`);

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
    const signalBus = require('@kernel/signal_bus');
    routeToJudge(signalBus, 'start_injector', {
      readable: 'start_injector: starting autonomous planning loop with clean state',
      start_injector: { success: true },
    });
  }
};
