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

// THE REGISTRY IS REQUIRED INSIDE route(), NOT HERE, AND THAT IS THE WHOLE OF THE CYCLE FIX.
//
// This module used to hold `const registry = require('@kernel/fragment_registry')` at module scope, and
// the registry eagerly requires all 30 fragments — so every fragment that wanted to route had a load-time
// path back to itself: fragment -> signal_bus -> fragment_registry -> fragment. CommonJS resolves that by
// handing out a HALF-BUILT module, and because both files assign `module.exports = {…}` (a replacement,
// not a mutation), whoever lost the race kept a reference to an object that was then thrown away. Measured
// 2026-09-10: with a module-scope bus require added to a fragment, Node warns about the circular dependency
// and that fragment's registry entry reads `receive: undefined` for the life of the process — silently
// unroutable, with preflight green throughout.
//
// Deferring it to call time removes the only load-time edge. By the first route() the registry is long
// since loaded and this is a cache hit, so the cost is one map lookup per call. Nothing else about routing
// moved: see architect_scratchpad.md §5 for what this file does and why none of it is redundant.
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

// ── `source` WAS RETIRED 2026-09-10, AND THE REASON IT LASTED IS WORTH ONE PARAGRAPH ─────────────
// The signature was `route(source, target, payload)` and **the body never referenced `source` once.**
// Nine call sites filled it in; every one of them passed `payload.from`, the same value already stamped
// into the envelope by `signal_utils` and the only sender identity anything downstream reads.
//
// It survived because it read as the sender half of a delivery — an argument named `source` next to one
// named `target` describes a contract the code does not have, and no session ever needed to open the
// body to believe it. That is the failure mode a dead parameter has: not a bug, a false statement about
// what the function needs, sitting where it is most likely to be believed.
//
// A THIRD ARGUMENT WOULD NOT HAVE MATTERED IF THE BUS VERIFIED IT. It does not. The one check here
// compares `payload.task` against `target` — a typo check between two things the CALLER supplies —
// so a sender name handed in separately could never have been anything but a claim about itself.
function route(target, payload = {}) {
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

  const registry = require('@kernel/fragment_registry');
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
