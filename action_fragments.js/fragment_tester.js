/**
 * fragment: fragment_tester — live single-fragment isolation harness
 *
 * Exercises one action fragment alone, live, without running the whole autonomous chain:
 * injects the signal the fragment would normally receive, lets it run its verb, and intercepts
 * its output signal here instead of letting it flow on to the next fragment or recursive_judge.
 *
 * Agnostic by design: routes a payload into whichever fragment TARGET names and logs whatever
 * routes back (the find_buildingspot values below are a placeholder to overwrite per test).
 *
 * To run a test: set TARGET to the fragment's signal name and PAYLOAD to the signal it normally
 * receives, temporarily reroute that fragment's onward call to `to: 'fragment_tester'` in place
 * of its usual next fragment or recursive_judge, trigger inject() (master_core readline verb
 * `test_fragment`), read the captured signal in the trace, then revert the reroute.
 *
 * Recursion guard: the injected signal terminates at the fragment under test on every path — a
 * success dead-ends at the temporary reroute instead of handing off further; a failure carries
 * the `test: true` payload flag through to recursive_judge, which halts on it instead of
 * replanning a fresh signal from world state; receive() only logs the captured signal and never
 * re-injects.
 */

const watcher = require('@kernel/watcher');
// One of the six forwarding routers: calls route() directly with an upstream author's own
// from/to, since signal_utils' helpers stamp `from` as the caller and would rewrite authorship.
// Every other fragment has no direct contact with the bus.
const signalBus = require('@kernel/signal_bus');

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
    const payload = { from: 'fragment_tester', to: TARGET, task: TARGET, ...PAYLOAD };
    watcher.summary('fragment_tester',
      `→ Injecting test signal into '${TARGET}'. Confirm '${TARGET}' is temporarily rerouted to reply 'to: fragment_tester'.`);
    signalBus.route(TARGET, payload);
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
