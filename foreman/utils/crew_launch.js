'use strict';
// foreman/utils/crew_launch.js — ONE CREW BODY IS LAUNCHED HERE, AND EVERY ONE IS ENDED HERE.
//   startBot() → { code, out } one body; releaseFetchedAsync()/releaseFetched() end every fetched body.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const consoleWindow = require('@utils/console_window');
const { RECORDS_DIR, consoleLogFile } = require('@utils/record_homes');
const processPriority = require('./process_priority');
const { log } = require('./say');

const BOT_DIR = path.resolve(__dirname, '..', '..');

// Launches ONE contractor body through `start_bot.js`, the tree's one birth (Law 16); `fleet_control` is
// personal equipment that does not ship. The caller already filters to free, not-already-running bots,
// so this file only launches and ends bodies. It resolves on launch, not on exit: `start_bot.js` does not
// return until the bot dies, so a death inside the grace window below is the one outcome reported here.
const BOT_LAUNCH_GRACE_MS = 3000;

// Bodies this desk fetched, so they leave when it does (Law 8 — whatever raised a process terminates it).
const fetched = [];

// `species` is 'contractor' or 'homesteader'; owner is '' for a homesteader (`bot_mandate` requires it).
// `BOT_AUTOSTART` starts a homesteader at fetch (a contractor is already born started); `BOT_START_NEAR`
// places both species beside the asker, confirmed by the body itself before planning (`start_injector`'s
// gate, Law 16). `held` withholds `BOT_AUTOSTART`: the body places itself and waits for the operator's
// `start` (foreman_config `go`). Each body's console drains to a file under `record_homes` (Law 16), tailed by a window.
function startBot(botId, species, owner, placeBeside, held = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BOT_DIR, 'start_bot.js')], {
      cwd: BOT_DIR,
      // The mandate stamped as environment, the path `start_bot.js` documents for a non-human caller.
      env: { ...process.env, BOT_ID: botId, BOT_MODE: species, BOT_OWNER: owner, BOT_AUTOSTART: held ? '0' : '1', BOT_START_NEAR: placeBeside },
      stdio: ['ignore', 'pipe', 'pipe'], // Piped, not shown: the follower window opened below is the only console.
      // Detached so the child survives a force-killed foreman long enough for `foreman_link`'s close
      // handler to report it lost. Not `child.unref()`: `stopAll` still ends every body by pid (Law 8).
      detached: true,
    });

    fs.mkdirSync(RECORDS_DIR, { recursive: true });
    // record_homes' path: a body appends to this same file once the foreman is gone (Law 16).
    const logFile = consoleLogFile(botId);
    const sink = fs.createWriteStream(logFile, { flags: 'a' });
    // A console log is a convenience, not the run's record — the trace is that; a write failure is logged once.
    sink.on('error', e => console.log(`  [${botId}] console log unavailable: ${e.message}`));
    // Opened without waiting: the entry learns its window once one opens, or closes it on arrival for a bot already exited.
    const entry = { child, sink, window: null, botId };
    fetched.push(entry);
    consoleWindow.followFileAsync({ title: `auren ${botId}`, logFile }).then(w => {
      entry.window = w;
      if (w && child.exitCode !== null) { entry.window = null; consoleWindow.closeWindowAsync(w.pid); }
    });

    let out = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    // Every chunk goes to the file for the whole run; only the grace window keeps a copy in memory.
    const tee = (d) => {
      sink.write(d);
      if (!settled) out += d.toString();
    };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.on('error', e => finish({ code: -1, out: `could not start ${botId}: ${e.message}` }));
    child.once('spawn', () => processPriority.apply(child.pid, botId, log));
    child.on('exit', code => {
      // The view goes when the thing it was viewing goes (Law 8, applied to the window).
      if (entry.window) { consoleWindow.closeWindowAsync(entry.window.pid); entry.window = null; }
      if (!sink.writableEnded) sink.end();
      finish({
        code,
        out: out.trim() || `${botId}: stopped immediately (exit ${code}) — nothing was said about why`,
      });
    });
    setTimeout(() => finish({ code: 0, out: `${botId}: launched` }), BOT_LAUNCH_GRACE_MS);
  });
}

// Ends every body this desk fetched, registered for ordinary exits and for Ctrl-C; each entry's console
// log and window end with its child (Law 8). Closes windows concurrently; `releaseFetched` below is the
// sync backstop for process exit.
async function releaseFetchedAsync() {
  const closing = [];
  for (const entry of fetched) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
    if (entry.window) { closing.push(consoleWindow.closeWindowAsync(entry.window.pid)); entry.window = null; }
  }
  await Promise.all(closing);
  releaseFetched();
}
function releaseFetched() {
  for (const { child, sink, window } of fetched) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (window) consoleWindow.closeWindow(window.pid);
    // Closed, not deleted, so a desk going down can still be read (`fleet_logs/` empties on the next
    // start). Checked with `writableEnded` instead of caught (Law 13).
    if (sink && !sink.writableEnded) sink.end();
  }
}

function firstMeaningfulLine(out) {
  if (!out) return null;
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !/deprecat|warning|^\(node:/i.test(l));
  return lines.length ? lines[lines.length - 1] : null;
}

module.exports = { startBot, releaseFetchedAsync, releaseFetched, firstMeaningfulLine };
