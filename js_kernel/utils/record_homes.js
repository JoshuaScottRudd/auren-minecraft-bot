'use strict';
// record_homes — WHERE A RUN'S TRACES LIVE, answered in one place.
//
// ── THE RULING THIS IMPLEMENTS (Architect 2026-08-31) ─────────────────────────────────────────────
//
//   "the watcher can stay but all the bot traces need to go, they arent read. corporate headquarters
//    stay because its used live. […] i want the kernel and the jsons in the kernal need to be
//    neccessary for bot operation and if not it needs to exist outside."
//
// THE KERNEL IS WHAT A BOT NEEDS IN ORDER TO RUN. That is the whole rule, and it sorts the two kinds of
// JSON that were sitting side by side under one directory as though they were the same kind of thing:
//   · `corporate_headquarters*.json` is READ BY THE FLEET WHILE IT WORKS — where home is, which chests
//     are whose, what has been sited. A bot that loses it cannot act. It stays in the kernel.
//   · `watcher_*.jsonl` is EXHAUST. Nothing in the running fleet reads it; it exists so a person or a
//     lens can reconstruct a run afterwards. It is not part of operating, so it lives outside.
// The two were indistinguishable by location, which is what made the kernel look like a junk drawer and
// made "is this needed to run?" unanswerable by looking (Law 6, Law 7 — a location is a claim about what
// a thing is for).
//
// ── WHY `fleet_logs/traces/` AND NOT A NEW DIRECTORY ─────────────────────────────────────────────
// `fleet_logs/` is already where a run's records live — the combat witness, the arena tapes, the run
// reports, every probe's findings, and each process's console mirror. It is already gitignored whole.
// Inventing a second records home beside it would be two answers to "where did the run go" (Law 16), so
// the traces join the records that were already there rather than founding a new place to look.
//
// ── WHY THIS IS A MODULE AND NOT A CONSTANT COPIED INTO EACH CALLER ──────────────────────────────
// Seven files held this path: the watcher, the start injector, the camera rig, the launcher's run-start
// sweep and its online check, and four lenses. That is one fact stated seven times, and the failure mode
// is not hypothetical — it is exactly how a reader ends up confidently reporting an empty run because it
// was looking in the directory the writer stopped using. One home, one answer, every caller asking
// (Law 16 — the same shape as `node_module_homes`, which exists for the same reason one directory over).
//
// ── IT LIVES IN THE KERNEL, AND THAT IS NOT A CONTRADICTION ──────────────────────────────────────
// The RECORDS are exhaust; knowing where to put them is not. `watcher.js` cannot write a line without
// this answer, and the watcher is the one module every fragment imports — so this is load-bearing for
// operation even though what it points at is not. The rule sorts DATA by whether the fleet reads it, not
// code by what the code is about.

const fs = require('fs');
const path = require('path');

const BOT_DIR = path.resolve(__dirname, '..', '..');

// The records room. Every run trace, whatever unit wrote it — bots, the overseer, the cameras, the desk.
const TRACE_DIR = path.join(BOT_DIR, 'fleet_logs', 'traces');

// CREATED ON DEMAND, AND BY THE WRITER RATHER THAN BY A SETUP STEP. A fresh clone has no `fleet_logs/`
// at all (it is gitignored whole), so a watcher that assumed the directory would fail on its first line
// on a machine nobody had run the fleet on yet — and it would fail inside the one module whose job is to
// report failures. Recursive so the parent is made too; idempotent, so every caller may simply call it.
function ensureTraceDir() {
  fs.mkdirSync(TRACE_DIR, { recursive: true });
  return TRACE_DIR;
}

// traceFile(unit) → the absolute path this unit's story is written to and read from.
// An unnamed unit gets the bare name, which is what a standalone process (a tool, a bench) writes.
function traceFile(unit) {
  return path.join(TRACE_DIR, unit ? `watcher_${unit}.jsonl` : 'watcher.jsonl');
}

// The deep per-fragment trace artifact, kept beside the story it belongs to but never mixed into it
// (Law 5 — the story is one file).
function deepTraceFile(unit) {
  return path.join(TRACE_DIR, unit ? `watcher_${unit}_trace.json` : 'watcher_trace.json');
}

// ── NO RECORD SURVIVES A RUN (Architect 2026-08-31, STANDING) ───────────────────────────────────────
// *"A start empties `fleet_logs/` whole, so every file there belongs to exactly one run."*
//
// THIS RULE WAS ENFORCED BY NOTHING UNTIL 2026-09-10, and the gap was found by the run that exposed it:
// `fleet_logs/traces/` held twenty-four trace files dated across six days — 5, 6, 9 and 10 September —
// sitting beside the two the current run had just written. What used to keep the room clean was an
// ACCIDENT of the stranger test: `run.js` copied the tracked tree to a fresh sibling directory and ran
// the copy, and `fleet_logs/` is gitignored, so the copy simply had no records in it. Shipping the whole
// stack as one piece deleted that copy, and the emptiness left with it (Law 13 — a guarantee must not
// quietly leave with the thing that happened to provide it). It is the second guarantee the copy was
// silently providing; the first was shipped-tree self-containment, now a `preflight` pass.
//
// WHAT IT COST IMMEDIATELY, which is why this is a real fault and not housekeeping: the lens reads the
// records room, so it read a `ProbeBot` error written at 11:12 by a bench that was not part of the run at
// all, and `run.js` scored the run FAIL on it — "the run record is clean (no errors): the lens found 5
// error line(s)". A verdict about this run, computed from another run's exhaust. Invariant B exactly:
// rows written days apart never measured the same system.
//
// WHY IT IS CALLED BY A FLEET START AND NOT BY THE WATCHER. Every bot imports the watcher, so a sweep
// there would have the SECOND bot delete the FIRST bot's trace mid-run — the rule is one sweep per run,
// and only something that owns a whole run knows when a run begins. `start_auren.js` (the one public
// door: desk and referee, before any bot exists) and `run.js` (the bench) are those things. A bare
// `start_bot.js` joining an existing fleet deliberately does NOT sweep.
//
// It reports what it removed rather than returning a count, because a caller printing "records cleared"
// with no subject cannot be checked against the room afterwards (Law 25).
const RECORDS_DIR = path.join(BOT_DIR, 'fleet_logs');

function sweepRecords() {
  if (!fs.existsSync(RECORDS_DIR)) return { swept: false, entries: [], dir: RECORDS_DIR };
  const entries = fs.readdirSync(RECORDS_DIR);
  for (const name of entries) {
    fs.rmSync(path.join(RECORDS_DIR, name), { recursive: true, force: true });
  }
  return { swept: true, entries, dir: RECORDS_DIR };
}

module.exports = {
  TRACE_DIR, RECORDS_DIR, ensureTraceDir, traceFile, deepTraceFile, sweepRecords, BOT_DIR,
};
