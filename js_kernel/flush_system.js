// js_kernel/flush_system.js
// The 'flush' operator verb — resets a bot to "fresh on a server".
//
// corporate_headquarters is the ONLY dynamic state a bot carries, so flushing it
// IS the flush. reset() empties the in-memory cache and writes the empty baseline
// to disk in one step, so this session's next read and the next cold start (which
// re-parses the file) both see a blank HQ. The foreman clears its own mirrored
// fleet state (merged stations + structures) separately when it broadcasts the
// verb — see foreman_hub — so nothing stale is re-injected.
//
// ── ITS RADIUS IS THE WHOLE FLEET, WHICH IS WHY IT IS NOT THE IN-WORLD VERB (Law 28) ──────────────────
// This clears one bot's HQ whole, and the foreman clears the shared mirror alongside it — so across the
// fleet it reaches every owner's stations, every owner's structures and every human's standing requests.
// Law 28 grants reach at exactly the scope of the answering: that radius is correct from the terminal,
// where the whole fleet is one person's responsibility, and wrong from a person in the world who answers
// for their own crew alone. wipe_system is that person's verb and cannot address a foreign row at all.
// Widening this one, or handing it to an in-world speaker, re-creates the fault: work destroyed that
// another party answers for, and the question about it arriving at someone who did not act.
//
// usage:
//  - programmatic: const { flush } = require('@kernel/flush_system.js'); await flush();
//  - console/foreman: the 'flush' verb via operator_commands (Law 16: one pathway)

'use strict';

const watcher = require('@kernel/watcher');

// The operator receives completion after the blank baseline reaches durable storage.
async function flush() {
  const flushed = await require('@kernel/corporate_headquarters').reset();
  if (flushed === false) throw require('@utils/external_library_guard').violation('flush_system', 'HQ reset did not reach disk; see the corporate_headquarters warning');
  watcher.summary('flush_system', 'Reset corporate_headquarters (memory + disk) to empty — bot is fresh.');
}

module.exports = { flush };
