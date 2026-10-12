// console_lane — THE CONSOLE NEVER HOLDS THE EVENT LOOP.
//
// ── WHY ─────────────────────────────────────────────────────────────────────────────────────────────
// On Windows a line printed to a PIPE or a CONSOLE is written on the event loop's own thread, and the write
// waits for the other end: a terminal in select mode, a launcher whose reader has paused, a redirect
// with a slow file. While it waits, nothing else in the process runs — for the foreman that is every
// claim, token and heartbeat the fleet is asking for; for a body it is its own signal loop. Putting the
// pipe in non-blocking mode does not change this, because the first attempt at every write is made
// synchronously before anything is queued.
//
// ── WHAT ────────────────────────────────────────────────────────────────────────────────────────────
// `install()` rebuilds the process's `console` over two streams whose every chunk goes to the thread pool
// (`fs.write` on the inherited descriptor), in order, one write in flight per descriptor. A paused display
// then costs memory for the queued lines and never a millisecond of the loop. `drained(maxMs)` is for the
// exit road: the last lines written are the record of how the process ended, so an exit waits for the
// queue, bounded so a display that never resumes cannot hold the exit either.
//
// A write the descriptor refuses (the display is gone) is counted and the lane carries on; there is
// nowhere left to say it, and the run's records are written elsewhere (watcher, foreman_record).
'use strict';

const fs = require('fs');
const { Writable } = require('stream');
const { Console } = require('console');

const lanes = new Map();   // fd → { queue, inFlight, refused }

function lane(fd) {
  const state = { queue: [], inFlight: false, refused: 0, waiting: [] };
  const pump = () => {
    if (state.inFlight) return;
    const chunk = state.queue.shift();
    if (!chunk) { for (const w of state.waiting.splice(0)) w(); return; }
    state.inFlight = true;
    fs.write(fd, chunk, (err) => {
      if (err) state.refused += 1;
      state.inFlight = false;
      pump();
    });
  };
  const stream = new Writable({
    write(chunk, encoding, callback) {
      state.queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      pump();
      callback();
    },
  });
  lanes.set(fd, { state, stream });
  return stream;
}

// install() — every console.log / console.error from here on goes down the lane. Idempotent.
//
// A CONSOLE WINDOW IS SET UP FIRST. Node's own stdout stream is touched so the terminal is switched to
// escape-sequence rendering (the colours and the alarm block), and on Windows the console's code page is
// set to UTF-8, since the lane writes bytes and a console on its default page renders every emoji and box
// line as three wrong characters. Both are the console's own state, shared by every process attached to
// it, so the one launcher's console is set once and the bodies inherit it.
function install() {
  if (lanes.size) return;
  const tty = !!process.stdout.isTTY;
  if (tty && process.platform === 'win32') {
    require('child_process').spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true });
  }
  const out = lane(1);
  const err = lane(2);
  global.console = new Console({ stdout: out, stderr: err, colorMode: tty });
}

// drained(maxMs) — resolves when both lanes are empty, or after maxMs, whichever is first.
function drained(maxMs = 5000) {
  const pending = [...lanes.values()].filter(({ state }) => state.inFlight || state.queue.length);
  if (!pending.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = pending.length;
    const t = setTimeout(() => resolve(false), maxMs);
    if (t.unref) t.unref();
    for (const { state } of pending) state.waiting.push(() => { if (--left === 0) { clearTimeout(t); resolve(true); } });
  });
}

function refused() {
  let n = 0;
  for (const { state } of lanes.values()) n += state.refused;
  return n;
}

module.exports = { install, drained, refused };
