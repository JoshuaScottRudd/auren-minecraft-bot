'use strict';
require('../js_kernel/utils/developer_door').enter('Auren_Workshop/bench_world.js');
// bench_world — A BENCH ASKS THE FOREMAN FOR A WORLD. IT NEVER STARTS OR STOPS ONE ITSELF.
//
// *"can you work on eliminating all scripts that are now under foremans control? a script is
// categorized as someting that runs and really cant handle anything that goes wrong. it just walks a sequence of
// events. now i want foreman to control and pace everything without scripts."*
//
// Benches (voxel_snapshot, wheat_site_probe, seed_scanner, world_forge) each started the server through
// fleet_control's `server-start` / `snapshot-restore` / `up` and stopped it with `server-stop` — a second owner of
// the world beside the foreman, walking a fixed order with nothing checking that each step happened. Those verbs
// are deleted. A bench now starts THE FOREMAN, exactly as a person does (start_auren.js, with the sentence as
// flags), and waits on the foreman's own door until its proved startup is done; the foreman restores, starts,
// verifies and later stops the world. So a bench's world comes up the one way every world comes up (Law 16).
//
//   up({ start, crew, soak, build })  → { ok, why, foreman }   defaults: continue · contractor · 0 (a world, no crew)
//   down(foreman)                     → { ok, why }            the foreman's own shutdown: bots home, world saved
//
// The foreman's console goes to fleet_logs/console_desk.log with a window following it (no invisible processes).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const paths = require('./workshop_paths');
paths.registerAliases();
const consoleWindow = require(paths.bot('js_kernel', 'utils', 'console_window.js'));
const { RECORDS_DIR, sweepRecords } = require(paths.bot('js_kernel', 'utils', 'record_homes.js'));
const door = () => require(paths.bot('foreman', 'foreman_door.js'));

const READY_WAIT_MS = 15 * 60 * 1000;   // world start (first boot generates terrain) plus a crew's siting
const SHUTDOWN_WAIT_MS = 240000;        // the foreman's own save limit is 180 s, plus the bots' grace
const POLL_MS = 3000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function up({ start = 'continue', crew = 'contractor', soak = 0, build = null, say = console.log } = {}) {
  // Only a rollback start empties the records; a continue start adds to them. Swept here, before this file
  // opens the desk's console log inside the room, and start_auren is told so (`--records keep`).
  if (start === 'rollback') sweepRecords();
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const logFile = path.join(RECORDS_DIR, 'console_desk.log');
  const fd = fs.openSync(logFile, 'a');
  const args = [paths.bot('start_auren.js'), '--start', start, '--crew', crew, '--soak', String(soak), '--records', 'keep'];
  if (build) args.push('--build', build);
  const child = spawn(process.execPath, args, { cwd: paths.bot(), stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const window = consoleWindow.followFile({ title: 'auren desk', logFile });
  const foreman = { child, window, logFile };
  const tail = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-900) : '');
  say(`bench_world: the foreman is bringing up a world — ${start} start, ${crew}${soak ? `, ${soak} min` : ''} (its window: auren desk)`);

  let lastStep = null;
  for (const end = Date.now() + READY_WAIT_MS; Date.now() < end;) {
    await sleep(POLL_MS);
    if (child.exitCode !== null) return { ok: false, why: `the foreman ended before the world was ready. It said: ${tail()}`, foreman };
    const r = await door().query();
    if (!r.ok || !r.run) continue;
    if (r.run.step !== lastStep) { say(`bench_world: foreman step — ${r.run.step}`); lastStep = r.run.step; }
    if (r.run.closing) return { ok: false, why: `the foreman is shutting down: ${r.run.closing}`, foreman };
    if (r.world && r.world.state === 'failed') return { ok: false, why: `the world did not come up: ${r.world.reason}`, foreman };
    if (r.run.stepState === 'done') return { ok: true, why: `the foreman proved every step (${r.run.sentence})`, foreman };
  }
  return { ok: false, why: `the foreman did not finish its startup in ${READY_WAIT_MS / 60000} min (last step: ${lastStep || 'none'})`, foreman };
}

async function down(foreman, { say = console.log } = {}) {
  if (!foreman || foreman.child.exitCode !== null) {
    if (foreman && foreman.window) consoleWindow.closeWindow(foreman.window.pid);
    return { ok: true, why: 'the foreman had already ended' };
  }
  say('bench_world: asking the foreman to shut down (it stops and saves the world it started)');
  spawnSync(process.execPath, [paths.workshop('fleet_control.js'), 'verb', 'shutdown'], { stdio: 'inherit' });
  for (const end = Date.now() + SHUTDOWN_WAIT_MS; Date.now() < end && foreman.child.exitCode === null;) await sleep(1000);
  if (foreman.window) consoleWindow.closeWindow(foreman.window.pid);
  return foreman.child.exitCode === null
    ? { ok: false, why: `the foreman had not finished shutting down after ${SHUTDOWN_WAIT_MS / 1000}s — check the server's own window` }
    : { ok: true, why: 'the foreman shut down and the world is saved' };
}

// stopRunning() — for a bench that did not start the running world itself: asks whichever foreman runs it to shut
// down, and proves it by the server's port going quiet. → { ok, why }
async function stopRunning({ say = console.log } = {}) {
  const settings = require(paths.bot('js_kernel', 'utils', 'server_settings.js'));
  const port = settings.serverPort(require(paths.bot('js_kernel', 'utils', 'workstation.js')).needServerDir());
  if (!await settings.serverAnswers(port)) return { ok: true, why: 'no server was running' };
  say('bench_world: a world is running — asking its foreman to shut down (it stops and saves the world)');
  spawnSync(process.execPath, [paths.workshop('fleet_control.js'), 'verb', 'shutdown'], { stdio: 'inherit' });
  for (const end = Date.now() + SHUTDOWN_WAIT_MS; Date.now() < end;) {
    await sleep(2000);
    if (!await settings.serverAnswers(port)) return { ok: true, why: 'the server stopped and saved' };
  }
  return { ok: false, why: `the server on port ${port} still answers after ${SHUTDOWN_WAIT_MS / 1000}s — check the server's own window` };
}

// spawnNow() → { x, y, z } | null — the world spawn the foreman read off its body and publishes on its door.
async function spawnNow() {
  const r = await door().query();
  return r.ok && r.run && r.run.spawn ? r.run.spawn : null;
}

module.exports = { up, down, stopRunning, spawnNow };
