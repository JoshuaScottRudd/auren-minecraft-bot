// child_fleet — raise the foreman and leave when it leaves.
//
// `start_auren.js` starts the foreman's process and must not outlive it. That is one capability, so it
// has one implementation (Law 16).
//
// Does not supervise: no restart, no health check, no backoff. A child that dies has a reason, and
// relaunching it would turn a diagnosable fault into an intermittent one. This module raises one process
// and follows it.

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const BOT_DIR = path.resolve(__dirname, '..', '..');

// start(label, script, env) → the child. `script` is a path relative to the bot directory, so a caller
// never spells an absolute path.
//
// Stdio is inherited, so one terminal shows everything; the watcher owns how a fleet log line looks
// (Law 16).
//
// Parent and child share one console, so whatever closes that console closes both — neither process can
// be the one that reports the other's death. The witness is a body, out in the fleet with a window of
// its own — see `js_kernel/utils/foreman_gone.js`.
function start(label, script, env = {}) {
  const child = spawn(process.execPath, [path.join(BOT_DIR, script)], {
    cwd: BOT_DIR,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  child.on('error', (e) => {
    console.error(`\n  [${label}] could not start: ${e.message}\n`);
  });

  return child;
}

// followOwner(child) — for the child that owns its own shutdown (the foreman: it stops the bots and the
// world it started, then exits). Ctrl-C reaches every process in the console, so the child hears it
// itself; this launcher says what is happening, never kills it, and leaves when it has left. Killing it
// here would end the foreman before it had stopped the server (Law 8: whatever raised a thing ends it —
// and the foreman raised the server).
//
// Exits quietly: the witness is a body already watching. Each bot holds a socket to the arbiter and
// already stops when it closes, so one of them claims the report and stays on screen in the window it
// already had (`js_kernel/utils/foreman_gone.js`). This door has no part in it, so it says nothing
// (Law 16).
//
// `carriesOn(code, signal)` is asked when the child has left: true means the launcher has more to do (it
// raises the child again after the machine's hour) and this door stays open for it.
let _saysWait = false;
function followOwner(child, _onExit, carriesOn) {
  if (!_saysWait) {
    _saysWait = true;
    const wait = () => console.log('\n  the foreman is shutting down — the bots first, then the world it started. This window closes when it has.');
    process.on('SIGINT', wait);
    process.on('SIGTERM', wait);
    process.on('SIGBREAK', wait);
  }
  child.on('exit', (code, signal) => {
    if (carriesOn && carriesOn(code, signal)) return;
    process.exit(signal ? 1 : (code === null ? 1 : code));
  });
}

module.exports = { start, followOwner, BOT_DIR };
