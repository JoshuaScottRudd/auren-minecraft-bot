// child_fleet — RAISE A SET OF PROCESSES AND TAKE THEM ALL DOWN TOGETHER (Law 8).
//
// WHY IT EXISTS: `start_auren.js` starts several long-lived
// processes and both must end them when the person presses Ctrl-C. That is one capability, so it has one
// implementation (Law 16). Written as a module rather than copied into both launchers because the thing
// that rots is teardown — the copy that gets a fix and the copy that does not are indistinguishable until
// somebody is left with an orphaned bot holding a roster name.
//
// LAW 8 IS THE WHOLE POINT. Whatever raised a process terminates it. A launcher that starts an foreman
// and two bots and then exits leaving them running has produced three zombies, and the person who typed
// one command now needs a task manager to undo it. Every process raised here is tracked and killed on the
// way out, including when the way out is a crash.
//
// IT DOES NOT SUPERVISE. There is no restart, no health check and no backoff: a bot that dies has a reason,
// and relaunching it would turn a diagnosable fault into an intermittent one (the same rule the foreman's
// `get` follows when it refuses to retry). This module raises, reports and reaps. Nothing else.

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const BOT_DIR = path.resolve(__dirname, '..', '..');

// Everything raised, in the order it was raised. Teardown walks it BACKWARDS: bots persist their
// headquarters on the way out and need the foreman still standing to do it, so the referee is the last
// thing to leave the room.
const raised = [];

let tearingDown = false;
// Set by followOwner: the child leaving IS the ending, so it is not reported as a surprise.
let ownerLeads = false;

// start(label, script, env) → the child. `script` is a path relative to the bot directory, so a caller
// never spells an absolute path and the two launchers cannot disagree about where the tree is.
//
// STDIO IS INHERITED, which is what makes one terminal show everything. The alternative — piping and
// re-printing with a prefix — was rejected because it would put this module in the business of formatting
// the fleet's own log lines, and the watcher already owns how a line looks (Law 16).
function start(label, script, env = {}) {
  const child = spawn(process.execPath, [path.join(BOT_DIR, script)], {
    cwd: BOT_DIR,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  raised.push({ label, child });

  // A child that dies on its own is REPORTED AND NOT REPLACED. Silence here would leave the person
  // watching a terminal that looks healthy while the thing they asked for is gone (Invariant C).
  child.on('exit', (code, signal) => {
    if (tearingDown || ownerLeads) return;
    const how = signal ? `killed by ${signal}` : `exit code ${code}`;
    console.log(`\n  [${label}] stopped on its own — ${how}.`
      + `\n  The rest of the fleet is still running. Ctrl-C to stop everything.\n`);
  });

  child.on('error', (e) => {
    console.error(`\n  [${label}] could not start: ${e.message}\n`);
  });

  return child;
}

// stopAll() — end everything, youngest first. Idempotent: Ctrl-C twice must not double-kill, and the
// exit handler runs after the signal handler has already done the work.
function stopAll() {
  if (tearingDown) return;
  tearingDown = true;
  console.log('\n  stopping the fleet...');
  for (let i = raised.length - 1; i >= 0; i--) {
    const { label, child } = raised[i];
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // SIGTERM rather than SIGKILL: a bot flushes its headquarters on the way down, and a killed one
    // loses the buildspots it just earned. On Windows Node maps this onto TerminateProcess, so the
    // flush is best-effort there — which is why the flush is debounced short rather than relied on here.
    const ended = child.kill('SIGTERM');
    if (!ended) console.error(`  [${label}] would not stop — end it by hand (pid ${child.pid}).`);
  }
}

// installSignals() — wire Ctrl-C and the ordinary exits to teardown. Called once by a launcher, after it
// has raised everything, so a signal arriving mid-launch cannot reap a half-built fleet.
//
// `SIGBREAK` is Windows' Ctrl-Break and is a distinct signal from SIGINT; omitting it left one of the two
// keystrokes a person actually presses doing nothing.
function installSignals() {
  const bye = () => { stopAll(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGBREAK', bye);
  process.on('exit', stopAll);
  // An uncaught throw in the launcher must not strand the fleet it already raised.
  process.on('uncaughtException', (e) => {
    console.error(`\n  the launcher failed: ${e && e.message}\n`);
    stopAll();
    process.exit(1);
  });
}

// `waitFor`, the pause between raising the overseer and the foreman (then two processes), was deleted 2026-09-18 with the second
// launch it spaced: the two are one process now (§32), and nothing else called it.
// followOwner(child) — for a child that OWNS its own shutdown (the foreman, since 2026-09-18: it stops the bots
// and the world it started, then exits). Ctrl-C reaches every process in the console, so the child hears it
// itself; this launcher says what is happening, never kills it, and leaves when it has left. Killing it here
// would end the foreman before it had stopped the server (Law 8: whatever raised a thing ends it — and the
// foreman raised the server).
function followOwner(child) {
  ownerLeads = true;
  const wait = () => console.log('\n  the foreman is shutting down — the bots first, then the world it started. This window closes when it has.');
  process.on('SIGINT', wait);
  process.on('SIGTERM', wait);
  process.on('SIGBREAK', wait);
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code === null ? 1 : code)));
}

module.exports = { start, stopAll, installSignals, followOwner, BOT_DIR };
