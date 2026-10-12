// utils: signal_utils — caller-side envelope helpers for the signal bus.
//
// The bus is passive (Law 3): it routes and refuses, never constructs a payload. The envelope every
// fragment stamps to hand a signal onward lives here, not on the bus and not in fragment_utils (the
// pure/stateless spine, which holds no signaling).
//
// A fragment that routes a signal — to the judge on completion, or to the next fragment in a chain —
// writes the same three envelope keys every time: { from, to: T, task: T }. `task` must equal the routing
// target (signal_bus.route drops any payload where task !== target); a mismatch is a signal that vanishes
// and only surfaces as a stalled bot. routeSignal makes the envelope and that contract a single source of
// truth (Law 16): the shape changes in one place.
//
// routeSignal is the general form (any target); routeToJudge is the completion special case, a thin
// wrapper that fixes target = recursive_judge. The caller owns everything that varies — success/result
// flags, the result capsule keyed by its own name, the readable, manager/objective fields, any
// `...payload` spread — passed as `fields`. The helper stamps the three envelope keys last, so a spread
// payload carrying a stale `to` cannot override the destination, then dispatches. Returns whatever
// route() returns, so callers may `return routeSignal(...)`.
//
// Not for the forwarding routers: recursive_judge, the locomotion judge/dispatcher, and the test
// injectors route an existing payload by its own from/to (`route(payload.from, payload.to, payload)`),
// preserving the upstream author's `from`. routeSignal always stamps `from` = the caller, so using it
// there would rewrite authorship.
//
// Every routed envelope appends its own author to a trail, so signal_sequencer can print two live chains
// side by side and find exactly where they diverge — done here once, structurally, for every call site.
//
// `signal_id` is not stamped here: it is inherited through the `...fields` spread when a caller forwards
// a payload, and absent when a caller builds a fresh envelope — the two cases the sequencer must tell
// apart, a chain continuing (carries its id) versus a Law 15 abandonment originating a new one (carries
// none). Stamping an id here would hand a stale executor a fresh-looking id and blind that check.

'use strict';

const sequencer = require('@kernel/signal_sequencer');
// The bus is held here, once, so a caller of this passive middleware needs to know only a target string
// (Law 3). A test seam, if ever wanted, is one setter on this module.
const signalBus = require('@kernel/signal_bus');

function routeSignal(from, target, fields = {}) {
  // `from` is stamped into the envelope, not handed to the bus separately — it is the one sender
  // identity in the system: the judge reads it, and the trail appends it.
  return signalBus.route(target, {
    ...fields,
    from,
    to: target,
    task: target,
    signal_trail: sequencer.appendTrail(fields.signal_trail, from),
  });
}

function routeToJudge(from, fields = {}) {
  return routeSignal(from, 'recursive_judge', fields);
}

module.exports = { routeSignal, routeToJudge };
