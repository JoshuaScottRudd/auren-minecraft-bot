// signal_bus — routes a signal to its registered fragment receiver; pure passive middleware (Law 3),
// with no scheduling or retry logic.
// route() delivers only when payload.task matches target, never mutates payload fields, and warns on
// an unknown target so the pipeline stays resilient to optional modules.

// Duplicate-signal detection is signal_sequencer's job: it stamps a monotonic id on the chain and
// throws on a stale one. The bus decides nothing about what has already routed (Law 3).

// route() requires the fragment registry per call, not at module scope, so this file carries no
// load-time edge into fragment_registry's require graph, which reaches every fragment.
const watcher = require('@kernel/watcher');
const sequencer = require('@kernel/signal_sequencer');

// ── THE DEAD-STOP LATCH ──────────────────────────────────────────────────────────────────────────
// Halts every signal once signal_sequencer trips, not only the one that tripped it — the bus is the
// one point every signal passes, so it is the one place "stop everything" can mean everything. It
// reads a boolean owned by signal_sequencer; obeying it is not deciding (Law 3).
// Nothing clears it but a process restart (Law 13: default stopped).
let stoppedAnnounced = false;

function route(target, payload = {}) {
  const halt = sequencer.isTripped();
  if (halt) {
    // Announced once per trip, so every other in-flight route does not also print and bury the
    // detection that matters under its own repeats (Law 5).
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
