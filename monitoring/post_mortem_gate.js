// Auren_Bot/monitoring/post_mortem_gate.js
// Enforces that a lens reads a finished record, not one a running program is still writing (Law 29).
//
// The hazard is narrow and local: reading a record that is still being appended to. This module cannot
// ask whether the fleet is up without reaching into the workshop, which the dependency-direction rule
// forbids, so it tests the record itself — its modification time says whether anything is still
// appending to it.
//
// A read is refused only when both hold:
//   · CAPTURED BY A PROGRAM — stdout is not a terminal, so something is parsing the output. A person at a
//     console may watch a moving record freely; this gate stands only between a program and a live file.
//   · TAKEN OF A HOT RECORD — the file was appended to within SETTLE_MS. A finished run's record stops
//     changing once the last process dies, so a cold record is a post-mortem by definition.
// Either condition alone is permitted; both together is refused.
//
// Streaming modes pass `live: true` and are never gated: `--watch` and `--follow` tail a record that is
// still moving, for a human's eyes. The refusal above is about a machine taking a measurement of a moving
// file and reporting it as a finished result.

'use strict';

const fs = require('fs');

// How long a record must sit quiet before a read of it counts as post-mortem, set high enough that a run
// still in progress trips it repeatedly while a torn-down fleet clears it quickly. A refusal here can be
// waited out (see `awaitSettled`); the value guards against a number reported as final that was taken
// mid-write (Law 25).
const SETTLE_MS = 5000;

// Milliseconds since the last write to this record; null when there is no record, which counts as not
// hot — a run that wrote nothing is a finished run with nothing in it.
function quietFor(file) {
  if (!file || !fs.existsSync(file)) return null;
  return Date.now() - fs.statSync(file).mtimeMs;
}

function isHot(file) {
  const quiet = quietFor(file);
  return quiet !== null && quiet < SETTLE_MS;
}

// True when nothing is looking at this output. `isTTY` needs no cooperation from the caller: a console
// gives a terminal, a pipe or captured buffer does not. A child spawned with stdio 'inherit' from a real
// console inherits that terminal and reads as a person.
function capturedByAProgram() {
  return !process.stdout.isTTY;
}

// The gate: exits the process on refusal, so a caller cannot silently carry on past it (Law 13).
//
// Reports on stderr and exits 3. stdout is the answer channel and carries nothing but the answer; a
// refusal printed there would smuggle a sentence onto the data channel, which the output guard forbids.
// Exit 3 is distinct from 0 (clean) and 2 (a signature firing), so a caller can distinguish a refusal
// from a bad answer.
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
    + `  IF YOU ARE A PROGRAM: ask the fleet instead. Its own door (foreman/foreman_door.js) answers who\n`
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

// Waits for a record to go quiet, for a caller that has just taken a fleet down and wants an immediate
// post-mortem — the last writes land milliseconds after the last process dies, so the record is briefly
// hot for a legitimate post-mortem reader.
//
// Resolves false on timeout: a record that never settles means something is still writing, and the
// caller can report that plainly (Law 25).
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
