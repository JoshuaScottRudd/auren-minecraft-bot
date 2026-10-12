'use strict';
// record_homes — the one place that answers where a run's traces and records live.
//
// The kernel holds what a bot needs in order to run. Data the fleet reads live —
// `corporate_headquarters*.json` — stays in the kernel; data that exists only for a person or a lens to
// reconstruct a run afterwards — `watcher_*.jsonl` — lives outside it, in `fleet_logs/` (Law 6, Law 7 — a
// location is a claim about what a thing is for).
//
// Traces join `fleet_logs/`, which already holds every other record of a run and is gitignored whole
// (Law 16 — one answer to "where did the run go").
//
// The path lives in this module so every reader and writer agrees on one answer (Law 16 — same shape as
// `node_module_homes`).
//
// This module is load-bearing for operation even though what it points traces at is not: `watcher.js`
// cannot write a line without this answer, and every fragment imports the watcher.

const fs = require('fs');
const path = require('path');

const BOT_DIR = path.resolve(__dirname, '..', '..');

// The records room. Every run trace, whatever unit wrote it — bots, the foreman, the cameras, the desk.
const TRACE_DIR = path.join(BOT_DIR, 'fleet_logs', 'traces');

// Creates the trace directory on demand. Recursive so the parent is made too; idempotent, so any caller
// may simply call it.
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

// Every file under `fleet_logs/` belongs to exactly one WORLD, from its rollback start on: each run of
// that world is a segment of the same files, in order.
const RECORDS_DIR = path.join(BOT_DIR, 'fleet_logs');

// consoleLogFile(unit) → the file this unit's visible console window is tailing (Law 16, shared by the
// foreman and the bot itself).
//
// The foreman pipes a bot's stdout into this file and opens a window on it. A bot appends here directly
// only when the foreman is gone and the pipe carrying its stdout goes nowhere — the window is still open;
// only its supplier died.
//
// Not the trace: the trace is the run's record and is read by the lenses; this is what is on a screen. A
// body that appends here is talking to a person, not filing.
function consoleLogFile(unit) {
  return path.join(RECORDS_DIR, `console_${String(unit).replace(/[^A-Za-z0-9_-]/g, '_')}.log`);
}

// Empties fleet_logs/ whole. Called by a ROLLBACK start and by nothing else (start_auren.js; bench_world.js
// when a bench asks for a rollback): the world goes back to its clean copy and so does what was written
// about it. A continue start adds to every file here. Returns what it removed, not just a count, so a
// caller can verify against the room afterwards (Law 25).
function sweepRecords() {
  if (!fs.existsSync(RECORDS_DIR)) return { swept: false, entries: [], dir: RECORDS_DIR };
  const entries = fs.readdirSync(RECORDS_DIR);
  for (const name of entries) {
    fs.rmSync(path.join(RECORDS_DIR, name), { recursive: true, force: true });
  }
  return { swept: true, entries, dir: RECORDS_DIR };
}

module.exports = {
  TRACE_DIR, RECORDS_DIR, ensureTraceDir, traceFile, deepTraceFile, consoleLogFile, sweepRecords, BOT_DIR,
};
