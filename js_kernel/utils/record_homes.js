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

module.exports = { TRACE_DIR, ensureTraceDir, traceFile, deepTraceFile, BOT_DIR };
