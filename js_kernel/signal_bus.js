// fragment: signal_bus
// purpose: enforce routing contract and dispatch signals to registered fragment receivers (JS side kernel)
// invariants:
//  - route() MUST only deliver when payload.task === target (task name canonicalizes intent)
//  - NEVER mutate payload fields (pass through reference; fragments clone/spread internally if modifying)
//  - SILENTLY ignore unknown targets (warn only) to keep pipeline resilient to optional modules
//  - NO scheduling / retry logic here (pure immediate dispatch)
//  - ROUTES NO MATTER WHAT (beyond the two contract checks below) — it never refuses a well-formed
//    signal to a registered receiver
// WHY: A minimal, explicit routing hinge keeps the signaling surface auditable and prevents hidden
// coupling or side-effects creeping into the transport layer. The bus is pure passive middleware
// (Law 3) — it routes and forwards, nothing else.
//
// ── THE DUPLICATE-SIGNAL GUARD THAT USED TO LIVE HERE ──────────────────────────────────────────────
// A `route._lastSignal` slot held the last (source, target) pair and refused a repeat. Do not put it
// back. It was wrong in three ways at once, and each is a trap a successor will otherwise re-dig:
//   1. A router that refuses is DECIDING (Law 3). Middleware may not.
//   2. It compared the SOURCE, so two different fragments routing to the same target were never
//      duplicates to it — and that is the shape every real duplicate has.
//   3. It was never cleared on completion, so it could not tell "still running" from "ran and finished",
//      refusing a legitimate follow-up route and leaving the bot inert with zero live signals.
// The job moved to `signal_sequencer`, called by recursive_judge: it stamps a monotonic id on the chain
// and throws when a stale one comes back. Live state belongs to whoever owns the scope, never here.

const registry = require('@kernel/fragment_registry');
const watcher = require('@kernel/watcher');
const sequencer = require('@kernel/signal_sequencer');

// ── THE DEAD-STOP LATCH ──────────────────────────────────────────────────────────────────────────
// Once the sequencer trips, every signal must stop — not just the one that tripped it.
//
// NOT the old guard coming back. The bus computes nothing here and compares nothing — it reads one
// boolean owned by signal_sequencer, whose entire verb is deciding it. Obeying a kill switch is not
// deciding (Law 3); the `_lastSignal` slot was the bus deriving a verdict of its own, which is.
//
// It has to be HERE and nowhere else: killing one signal at its source says nothing about others
// already in flight, and the bus is the only place every signal passes — so it is the only place
// "stop everything" can mean everything.
//
// Nothing clears it but a process restart (Law 13: default stopped).
let stoppedAnnounced = false;

function route(source, target, payload = {}) {
  const halt = sequencer.isTripped();
  if (halt) {
    // Announced ONCE. After a trip every fragment in flight tries to route and each would print, burying
    // the detection that matters under its own consequences (Law 5).
    if (!stoppedAnnounced) {
      stoppedAnnounced = true;
      watcher.error('signal_bus',
        `⛔ ROUTING STOPPED — signal_sequencer tripped on '${halt.from}': ${halt.reason} ` +
        `Every route from here is refused until this process restarts. Further refusals are silent.`);
    }
    return;
  }

  if (payload.task !== target) {
    watcher.error('signal_bus', `Payload task mismatch: expected '${target}' but got '${payload.task}'`);
    return;
  }

  const fragment = registry[target];
  if (!fragment || typeof fragment.receive !== 'function') {
    watcher.warn('signal_bus', `No valid receiver found for '${target}'`);
    return;
  }

  setTimeout(() => {
    fragment.receive(payload.task, payload);
  }, 100);
}

module.exports = { route };
