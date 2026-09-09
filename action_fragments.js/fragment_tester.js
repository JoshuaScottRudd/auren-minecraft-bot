/**
 * fragment: fragment_tester — live single-fragment isolation harness
 *
 * WHY: exercises ONE action fragment alone, live, without running the whole autonomous
 * chain. Injects the signal the fragment would normally receive, lets it run its verb,
 * and intercepts its OUTPUT signal here instead of letting it flow on to the next
 * fragment or recursive_judge.
 *
 * Agnostic by design: not bound to any particular fragment — routes a payload in and
 * logs whatever routes back. Point it at any fragment by editing TARGET + PAYLOAD below
 * (the find_buildingspot values here are just a placeholder).
 *
 * HOW TO RUN A TEST — two temporary edits, this file + the fragment under test:
 *   1. Here: set TARGET to the fragment's signal name and PAYLOAD to the signal it
 *      normally receives (copy a real one from a trace).
 *   2. In the fragment under test: temporarily reroute its onward call to
 *      `to: 'fragment_tester'` instead of the next fragment / recursive_judge — that
 *      reroute is the interception, landing the fragment's return signal in receive()
 *      below.
 *   3. Trigger inject() (master_core readline verb `test_fragment`), read the captured
 *      signal in the trace, then REVERT the reroute from step 2.
 *
 * RECURSION GUARD (why this can't become a start signal): the injected signal must
 * terminate at the fragment under test, never propagate — three paths, each capped:
 *   - SUCCESS → the temporary reroute (step 2) dead-ends the chain here instead of
 *     handing off to the next fragment.
 *   - FAILURE → the fragment soft-fails to recursive_judge (Law 13). Left alone, the
 *     judge would replan and dispatch a FRESH signal from world state — a start signal
 *     cascading into the real loop. The `test: true` flag below rides in the payload so
 *     it survives through to the judge, which halts on it instead of replanning (and
 *     does not route anything back here).
 *   - receive() only LOGS the captured signal, never re-injects — a self-propagating
 *     inject would itself be a start signal, so receive() is terminal.
 */

const watcher = require('@kernel/watcher');

// ── EDIT THESE PER TEST ─────────────────────────────────────────────────────
const TARGET  = 'find_buildingspot';       // signal name of the fragment under test
const PAYLOAD = {                           // the signal that fragment normally receives
  test: true,                              // recursion guard: recursive_judge halts on this if the
                                           // fragment fails through to it (never replans a test signal)
  blueprint_name: 'headframe',
  require_shaft: true,
};
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  handle: 'fragment_tester',

  // Fires one test signal into the fragment under test — called directly from the
  // master_core `test_fragment` verb as a one-shot manual trigger, never self-invoked.
  inject() {
    const signalBus = require('@kernel/signal_bus');
    const payload = { from: 'fragment_tester', to: TARGET, task: TARGET, ...PAYLOAD };
    watcher.summary('fragment_tester',
      `→ Injecting test signal into '${TARGET}'. Confirm '${TARGET}' is temporarily rerouted to reply 'to: fragment_tester'.`);
    signalBus.route('fragment_tester', TARGET, payload);
  },

  // Intercepts the fragment's output signal (routed here by the step-2 reroute) and logs
  // it. Terminal by contract — no re-inject, no route-onward — the recursion guard.
  receive: watcher.track('fragment_tester', async (signalType, payload = {}) => {
    if (signalType !== 'fragment_tester') return;
    const verdict = payload.success === false ? '❌ FAIL' : '✅ captured';
    watcher.summary('fragment_tester',
      `${verdict} — return signal from '${payload.from || 'unknown'}': ${JSON.stringify(payload)}`);
  })
};
