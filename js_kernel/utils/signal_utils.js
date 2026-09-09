// utils: signal_utils
// The caller-side envelope helpers for the signal bus. The bus itself is passive (Law 3) — it
// routes and refuses, it never constructs a payload — so the one-line envelope every fragment
// stamps to hand a signal onward lives here, not on the bus and not in fragment_utils (which is the
// pure/stateless spine and explicitly holds no signaling).
//
// A fragment that routes a signal — to the judge on completion, or to the next fragment in a chain —
// writes the same three envelope keys every time: { from, to: T, task: T }. Two facts get copied at
// every call site: the three keys, and the bus's hard contract that `task` MUST equal the routing
// target (signal_bus.route silently drops any payload where task !== target). One typo in either is a
// signal that vanishes and only surfaces as a stalled bot. routeSignal makes the envelope+contract a
// single source of truth (Law 16): the shape changes in one place, and the task===target invariant can
// no longer be got wrong by hand.
//
// routeSignal is the general form (any target); routeToJudge is the completion special case, a thin
// wrapper that fixes target = recursive_judge. The caller owns everything that VARIES — success/
// result flags, the result capsule keyed by its own name, the readable, manager/objective fields,
// any `...payload` spread — all passed as `fields`. The helper only stamps the three envelope keys
// (last, so a spread payload carrying a stale `to` can't override the destination) and dispatches.
// It returns whatever route() returns, so callers may `return routeSignal(...)`.
//
// NOT for the forwarding routers. recursive_judge, the locomotion judge/dispatcher, and the test
// injectors route an EXISTING payload by its own from/to (`route(payload.from, payload.to, payload)`)
// — they forward what an upstream author built, and must preserve that author's `from`. routeSignal
// stamps `from` = the caller, so using it there would rewrite authorship. Those stay as they are.
//
// Every routed envelope appends its own author to a trail, so when signal_sequencer catches two live
// chains it can print both side by side: they share a prefix and diverge at exactly one fragment, which
// is where the second signal was born. This is the only place it can be done structurally — every call
// site remembering to append individually would be one more chance to forget.
//
// `signal_id` is NOT stamped here on purpose. It is INHERITED through the `...fields` spread when a
// caller forwards a payload, and absent when a caller builds a fresh envelope — which maps exactly onto
// the two cases the sequencer must tell apart: a chain continuing (carries its id) versus a Law 15
// abandonment originating a new one (carries none). Stamping the current id here would hand a stale
// executor a fresh-looking id and blind the check entirely.

'use strict';

const sequencer = require('@kernel/signal_sequencer');

function routeSignal(signalBus, from, target, fields = {}) {
  return signalBus.route(from, target, {
    ...fields,
    from,
    to: target,
    task: target,
    signal_trail: sequencer.appendTrail(fields.signal_trail, from),
  });
}

function routeToJudge(signalBus, from, fields = {}) {
  return routeSignal(signalBus, from, 'recursive_judge', fields);
}

module.exports = { routeSignal, routeToJudge };
