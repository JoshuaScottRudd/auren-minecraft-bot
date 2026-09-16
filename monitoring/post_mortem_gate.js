// Auren_Bot/monitoring/post_mortem_gate.js
// A LENS READS A FINISHED RECORD. This module is what makes that a fact rather than a habit.
//
// ── THE RULING (Architect 2026-09-16, STANDING) ─────────────────────────────────────────────────────
//
//   "Why does run.js use trace monitor? Nothing should be using trace monitor while the bot is online,
//    its post Mortem only. Run.js should be talking directly to the program it needs. So if run.js needs
//    an answer then it uses the proper functions directly into the program it needs it from not asking
//    trace monitor who checks the file which was written by the program that it needs its answer from.
//    It should skip that and talk directly. Make sure no live code program uses a lens or monitor and
//    talks directly to the system needed"
//
// ── WHY A GATE HERE RATHER THAN A RULE WRITTEN DOWN SOMEWHERE ───────────────────────────────────────
// The rule already WAS written down, twice, and both violations cited it on the way past. `record_homes`
// says of the traces: *"Nothing in the running fleet reads it; it exists so a person or a lens can
// reconstruct a run afterwards."* CLAUDE.md says every question about a run is answered by calling a
// lens — and a machine that needs a fact out of a record calls one too. Read together by a session that
// wants an answer, those produce exactly the thing he struck out: `run.js` spawning a lens at a trace
// file while two bots were still writing to it. A guard that lives in prose is a guard that argues with
// the next reader. This one cannot be argued with (the same reason the output guard moved from a
// vocabulary blacklist to a structural one on 2026-09-16 — Law 29).
//
// ── WHAT IT ACTUALLY TESTS, AND WHY THAT IS THE REAL HAZARD ─────────────────────────────────────────
// Not "is the fleet up" — this module cannot ask that without reaching into the workshop, which the
// dependency-direction rule forbids, and a pid map full of reissued pids answers it wrongly anyway. The
// hazard is narrower and completely local: READING A RECORD THAT IS STILL BEING WRITTEN. That is what
// makes an answer wrong, and the record itself is the witness — its modification time says whether
// anything is still appending to it.
//
// ── TWO CONDITIONS, AND BOTH MUST HOLD (Law 29 — this is the whitelist of when to refuse) ───────────
// A read is refused only when it is BOTH of:
//   · CAPTURED BY A PROGRAM — stdout is not a terminal, so nobody is reading this; something is parsing
//     it. A person at a console may look at a moving record whenever they like: interpreting a run is
//     the Architect's job and not a lens's, and this gate has no business standing between him and his
//     own instrument.
//   · TAKEN OF A HOT RECORD — the file was appended to within SETTLE_MS. A finished run's record stops
//     changing the moment the last process dies, so a cold record is a post-mortem by definition.
// Either one alone is ordinary and permitted. Together they are the exact shape of the defect.
//
// Streaming modes are never gated and must pass `live: true`: `--watch` and `--follow` exist to tail a
// record that is still moving, which is their whole purpose (`fleet-console` is `--follow`, and it is
// the one window he actually watches). They are for a human's eyes; the refusal above is about a
// machine taking a MEASUREMENT of a moving file and reporting it as a result.

'use strict';

const fs = require('fs');

// How long a record must have been quiet before a measurement of it counts as post-mortem. Generous on
// purpose: a fleet mid-run writes constantly, so any run still going trips this many times over, while a
// torn-down fleet clears it in one breath. The cost of being wrong in the strict direction is a refusal
// the caller can wait out (see `awaitSettled`); the cost of being wrong the other way is a number
// reported as final that was taken mid-write, which is the thing this exists to prevent (Law 25).
const SETTLE_MS = 5000;

// How old is the last write to this record, in ms. `null` when there is no record — which is NOT hot: a
// run that wrote nothing at all is a finished run with nothing in it, and refusing to read it would hide
// that fact behind a gate error instead of reporting it.
function quietFor(file) {
  if (!file || !fs.existsSync(file)) return null;
  return Date.now() - fs.statSync(file).mtimeMs;
}

function isHot(file) {
  const quiet = quietFor(file);
  return quiet !== null && quiet < SETTLE_MS;
}

// capturedByAProgram() — nobody is looking at this output.
//
// `isTTY` is the honest test and it needs no cooperation from the caller: a console gives a terminal, a
// pipe or a captured buffer does not. A child spawned with stdio 'inherit' from a real console inherits
// that terminal and reads as a person, which is correct — inheriting a console IS showing a human.
function capturedByAProgram() {
  return !process.stdout.isTTY;
}

// refuseIfLive(file, { live }) — the gate. Returns nothing and exits the process on refusal, because a
// lens that refused and then carried on would have made the refusal advisory (Law 13).
//
// IT REPORTS ON stderr AND EXITS 3. stdout is the answer channel and must never carry anything but the
// answer, so a refusal that printed there would be a sentence smuggled onto the data channel — the exact
// thing the output guard forbids. Exit 3 is its own code: 0 is clean, 2 is a signature firing, and a
// caller must be able to tell "your question was refused" from "the answer is bad news".
function refuseIfLive(file, { live = false } = {}) {
  if (live) return;
  if (!capturedByAProgram()) return;
  if (!isHot(file)) return;
  const quiet = quietFor(file);
  process.stderr.write(
    `post_mortem_gate: refused.\n`
    + `  A program is capturing this lens's output and the record is still being written to\n`
    + `  (last append ${Math.round(quiet / 1000)}s ago; a record counts as finished after ${SETTLE_MS / 1000}s).\n`
    + `  ${file}\n`
    + `  A lens reconstructs a run that is OVER.\n`
    + `\n`
    + `  IF YOU ARE A PROGRAM: ask the fleet instead. Its own door (foreman/overseer_door.js) answers who\n`
    + `  is registered, what each bot holds, how many lines of each level it has written, and whether it\n`
    + `  still has a body — live, with no record in between. Architect 2026-09-16: "Nothing should be\n`
    + `  using trace monitor while the bot is online, its post Mortem only... talk directly."\n`
    + `\n`
    + `  IF YOU ARE A PERSON and your console did not come through as a terminal: --follow is the live\n`
    + `  view and is never gated (it is what the fleet-console window runs). Or take this read once the\n`
    + `  run is down, when the record has stopped moving and the answer is a whole one.\n`,
  );
  process.exit(3);
}

// awaitSettled(file, timeoutMs) → Promise<boolean> — for a caller that has just taken a fleet DOWN and
// wants its post-mortem immediately. The last writes land milliseconds after the last process dies, so
// the record is briefly hot for a legitimately post-mortem reader; this is the wait for it to go quiet,
// rather than a flag that would let any caller declare itself post-mortem and walk through the gate.
//
// Resolves false on timeout instead of throwing: a record that never settles means something is STILL
// WRITING, and the caller reporting that plainly is better than either a throw or a measurement taken
// anyway (Law 25).
function awaitSettled(file, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (!isHot(file)) return resolve(true);
      if (Date.now() >= until) return resolve(false);
      setTimeout(poll, 500);
    };
    poll();
  });
}

module.exports = { refuseIfLive, awaitSettled, isHot, quietFor, SETTLE_MS };
