// Auren_Bot/Auren_Workshop/run_outcome.js
// HOW A RUN SAYS WHAT HAPPENED TO IT. One writer, used by `run.js` and `host_and_run.js`.
//
// ── THE RULING (Architect 2026-09-16) ───────────────────────────────────────────────────────────────
//
//   "thats another thing. why doesent it report to you? it should say that it either succeeded or
//    failed in its task in the output in a way you can read instead of looking at it manually."
//
// He said it about the run that had just failed: `host_and_run.js` exited 1 because no Java was on the
// PATH, and the only way to learn that was to scroll back through a PowerShell-wrapped node stack trace
// and find the one line that mattered. The information was all there. Nothing STATED it.
//
// ── IT IS THE SAME FAULT THE REST OF THIS DAY'S WORK REMOVED, ONE LAYER OUT ─────────────────────────
// `run.js` used to recover "did anything error" by parsing a lens's printed output; that was fixed by
// having the fleet state the fact as a field. This is that defect again with the run itself as the
// subject: the run KNOWS whether it passed, at which stage, and why — and it was leaving that to be
// reconstructed from console text by whoever came looking. A reader should never have to parse a
// narrative to learn an outcome the writer already held (Law 26 — the party with the witness answers).
//
// ── TWO CHANNELS, AND BOTH ARE THE SAME FACTS ───────────────────────────────────────────────────────
//   · STDOUT, as the LAST thing printed, under a `[run_outcome]` heading — field names and values, the
//     shape the lenses were converted to on 2026-09-16. It is last so that a reader who tails the
//     output gets the answer without scrolling, whatever happened above it.
//   · `Auren_Bot/fleet_logs/run_outcome.json` — the same object, for a supervisor that would rather
//     read one small file than a whole console. `fleet_logs/` is emptied by every start, so this file
//     always belongs to exactly one run (record_homes' standing rule), and `started_at` is stamped so a
//     file left by a bring-up failure that never reached the sweep cannot be mistaken for this run's.
//
// ── EVERY EXIT PATH WRITES ONE, INCLUDING THE ONES NOBODY PLANNED ───────────────────────────────────
// A crash that leaves no outcome is the case this exists for, so `CRASHED` is a real value rather than
// an absence. The four:
//   PASS     every check passed.
//   FAIL     the run happened and something in it failed. `checks` says what.
//   BLOCKED  the run never started — the world would not come up, terminals were open, a toolchain is
//            missing. Nothing was measured, which is a DIFFERENT answer from measuring a failure, and
//            conflating them sends a reader to debug a fleet that never ran (Law 25).
//   CRASHED  an error nobody graded reached the top. `reason` carries its message.

'use strict';

const fs = require('fs');
const path = require('path');

const OUTCOMES = new Set(['PASS', 'FAIL', 'BLOCKED', 'CRASHED']);
const MARKER = 'run_outcome';

function outcomeFile() {
  return path.join(path.resolve(__dirname, '..'), 'fleet_logs', `${MARKER}.json`);
}

// Field-name/value, one per line, in the shape the lenses print. A value that is absent prints as a
// dash rather than as `undefined` or an empty column — an absence is an answer and must look like one.
const KEY_WIDTH = 20;
function line(name, v) {
  const val = v === null || v === undefined || v === '' ? '—' : String(v);
  return name + ' '.repeat(Math.max(1, KEY_WIDTH - name.length)) + val;
}

// write(o) — state the outcome on both channels and return the exit code to leave with.
//
// `o.checks` is the run's own list of `{ name, ok, detail }`; only the FAILED ones are carried out, and
// they are carried whole. A count alone tells a reader that something broke and not what, which is the
// half of the answer that costs another look at the console — the thing this module exists to end.
function write(o) {
  const outcome = OUTCOMES.has(o.outcome) ? o.outcome : 'CRASHED';
  const checks = Array.isArray(o.checks) ? o.checks : [];
  const failed = checks.filter(c => !c.ok);
  const record = {
    outcome,
    stage: o.stage || null,
    reason: o.reason || null,
    exit_code: typeof o.exitCode === 'number' ? o.exitCode : (outcome === 'PASS' ? 0 : 1),
    checks_passed: checks.length - failed.length,
    checks_total: checks.length,
    failed_checks: failed.map(c => ({ name: c.name, detail: c.detail || null })),
    woke: o.woke === undefined ? null : !!o.woke,
    woke_on: o.wokeOn || null,
    ran_min: typeof o.ranMin === 'number' ? Number(o.ranMin.toFixed(2)) : null,
    started_at: o.startedAt || null,
    ended_at: new Date().toISOString(),
    // WHICH SCRIPT IS SPEAKING. `host_and_run` wraps `run`, so a reader that finds BLOCKED wants to know
    // straight away whether the world never came up or the run itself refused to start.
    reported_by: o.reportedBy || 'run',
  };

  // The file first, so an outcome survives even if stdout is closed under us (a killed console window,
  // a broken pipe) — which is exactly the run a reader most needs the answer from.
  const file = outcomeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  console.log('');
  console.log(`[${MARKER}]`);
  console.log(line('outcome', record.outcome));
  console.log(line('stage', record.stage));
  console.log(line('reason', record.reason));
  console.log(line('checks_passed', record.checks_passed));
  console.log(line('checks_total', record.checks_total));
  console.log(line('failed_checks', record.failed_checks.length));
  for (const f of record.failed_checks) console.log(line('  failed', `${f.name} — ${f.detail}`));
  console.log(line('woke', record.woke));
  console.log(line('woke_on', record.woke_on));
  console.log(line('ran_min', record.ran_min));
  console.log(line('reported_by', record.reported_by));
  console.log(line('exit_code', record.exit_code));
  console.log(line('written_to', file));
  return record.exit_code;
}

module.exports = { write, outcomeFile, MARKER };
