// module: host_and_run
// purpose: THE OVERLAY FOR A MACHINE THAT HOSTS THE WORLD ITSELF. It checks nothing is left over, rolls
//          the world back to its snapshot, and runs `run.js` untouched with the world set to 'local' — and
//          run.js's foreman then starts the server, and stops it at the end (since 2026-09-18). One command,
//          one pass.
//
//     . .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\host_and_run.js
//
// ── THE TWO VERBS, AND WHY THEY ARE TWO (Architect 2026-09-11, Law 1 — decoupled) ───────────────────
// *"i have a script that autostarts the server, then when its the bots turn to connect its a seperate
// piece that only cares if the server is there not if the script runs correctly? so law 1. isolated verb.
// my script autostarts server then foreman check to see if the server is there not if i started it with
// the script. this is so a stranger can use it. i want an architect and a user start to be identical. my
// commands should overlay ontop of strangers commands and there should be a clear seperation between what
// is architect and what is user."*
//
//     HOSTING A WORLD   this file          check nothing is left over · roll back to a snapshot
//     RUNNING A CREW    run.js             its foreman starts the world · work · read the record · come down
//
// (The two lines above were redrawn 2026-09-18: minting the console password and starting and stopping the
// world moved into the foreman, on *"Who owns the process? Foreman does."* The rest of this 2026-09-11
// reasoning stands for what is left here; where it says run.js asks the world, run.js now asks the foreman.)
//
// **`run.js` IS RUN AS A CHILD PROCESS, NOT IMPORTED AND NOT REIMPLEMENTED.** That is what makes "his run
// is identical to a stranger's run" a structural fact rather than a promise two files are trying to keep:
// there is one copy of the run, it takes no argument from this file, and it cannot be told that a host is
// standing behind it. The only thing that crosses the boundary is the environment — the same environment a
// stranger fills in by hand — and `run.js` has no way to tell a minted password from a typed one.
//
// SO THE HAND-OFF IS STATE, NEVER A CLAIM. This file does not tell `run.js` "the server is up"; it starts
// the server and gets out of the way, and `run.js` then asks the WORLD whether it is there. If the JVM
// died between the two, `run.js` fails with the same message a stranger gets when they forgot to start
// theirs — which is the behaviour wanted, because "my script reported success" is not evidence that a
// server is accepting connections (Law 25).
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────────
// It does not preflight, sweep records, clear memory, launch a desk, place a person, hire a crew, watch,
// film, or read the trace. Every one of those belongs to the run and none of them needs a server folder.
// A second copy of any of them here would be the second bring-up order this project deleted three
// launchers to be rid of.

'use strict';
require('../js_kernel/utils/developer_door').enter('Auren_Workshop/host_and_run.js');

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const paths = require('./workshop_paths');
paths.registerAliases();
const workstation = require(paths.bot('js_kernel/utils/workstation'));
const consoleWindow = require(paths.bot('js_kernel/utils/console_window'));
const serverSettings = require(paths.bot('js_kernel/utils/server_settings'));
// The run's own report of itself. THIS script needs it as much as `run.js` does, and for a sharper
// reason: a bring-up failure never reaches `run.js` at all, so without this the only record of what went
// wrong is console text. That is exactly the case the Architect named on 2026-09-16 — no Java on the
// PATH, surfacing as a node stack trace wrapped in a PowerShell error, with the one line that mattered
// four screens up. What this file writes is BLOCKED: nothing was measured, which is a different answer
// from a run that measured a failure (see run_outcome.js).
const outcome = require('./run_outcome');
const HOST_STARTED_AT = new Date().toISOString();
const blocked = (stage, reason) => process.exit(outcome.write({
  outcome: 'BLOCKED', stage, reason, startedAt: HOST_STARTED_AT, reportedBy: 'host_and_run', exitCode: 1,
}));

// ONLY THE `hosting` BLOCK. `run.js` owns the other one and validates it for itself; this file never
// reads it, so a fault in the run's settings is reported by the run's own refusal, in the run's own words.
const { hosting: CONFIG } = require('./run_config');

const PERMITTED = { world: ['fresh', 'continue'] };
const SHAPE = { world: 'enum', snapshot: 'string', worldName: 'string' };

function refuse(lines) {
  console.error(`\n  host_and_run: NOTHING WAS STARTED — the world was not touched.\n`);
  for (const l of lines) console.error(`    ${l}`);
  console.error(``);
  blocked('preconditions', lines[0] || 'a precondition refused the run');
}

// ── EVERYTHING IS PROVED BEFORE THE SERVER IS STOPPED, NOT DURING THE ROLLBACK (Law 13) ─────────────
// Without this the sequence gets as far as taking a live world down and only then discovers there is
// nothing to restore — which leaves the machine in a worse state than it started in, for a fault that was
// knowable before anything moved. Measured on this workstation once: `world_snapshots/` did not exist at
// all, so the shipped default named a baseline that was never here.
const found = workstation.findServerDir();
const SERVER_FOLDER = found.dir;
if (!SERVER_FOLDER) {
  refuse([`This script hosts the world, and this machine has no server folder for it to host.`,
          `  tried: ${found.tried.join(', ')}`,
          ``,
          `  Set AUREN_SERVER_DIR to the folder that holds your server's server.properties.`,
          ``,
          `  If you start your Minecraft server yourself, you do not want this script at all —`,
          `  start your server and run Auren_Workshop/run.js, which is the same run without the`,
          `  hosting. Its address is in Auren_Bot/foreman_config.js.`]);
}
const PROPS_FILE = path.join(SERVER_FOLDER, 'server.properties');

{
  const wrong = [];
  for (const key of Object.keys(CONFIG)) {
    if (!SHAPE[key]) wrong.push(`hosting.${key} is not a setting. Settings: ${Object.keys(SHAPE).join(', ')}`);
  }
  for (const [key, kind] of Object.entries(SHAPE)) {
    if (!(key in CONFIG)) { wrong.push(`hosting.${key} is missing, and there is no default for it.`); continue; }
    const v = CONFIG[key];
    if (kind === 'enum' && !PERMITTED[key].includes(v)) {
      wrong.push(`hosting.${key}: '${v}' is not one of ${PERMITTED[key].map(x => `'${x}'`).join(' | ')}`);
    }
    if (kind === 'string' && typeof v !== 'string') wrong.push(`hosting.${key} must be text, and is ${typeof v}`);
  }
  if (!wrong.length && CONFIG.world === 'fresh') {
    const home = path.join(SERVER_FOLDER, 'world_snapshots', CONFIG.worldName);
    const asDir = path.join(home, CONFIG.snapshot);
    if (!fs.existsSync(asDir) && !fs.existsSync(`${asDir}.zip`)) {
      const have = fs.existsSync(home) ? fs.readdirSync(home) : [];
      wrong.push(`hosting.snapshot: there is no '${CONFIG.snapshot}' to roll back to. Looked in ${home}`);
      wrong.push(have.length ? `  What is there: ${have.join(', ')}` : `  That folder holds no snapshots at all.`);
      wrong.push(`  Either name one that exists, or set hosting.world: 'continue' to keep the world as it`);
      wrong.push(`  stands. To make the current world the baseline: stop the server, then`);
      wrong.push(`      node Auren_Workshop/fleet_control.js snapshot --name=${CONFIG.snapshot}`);
    }
  }
  if (wrong.length) refuse(wrong);
}

const say = m => console.log(`  ${m}`);
let phaseNo = 0;
const phase = m => { phaseNo++; const t = `${phaseNo}. ${m}`; console.log(`\n══ ${t} ${'═'.repeat(Math.max(0, 72 - t.length))}`); };

function fleetControl(args) {
  const r = spawnSync(process.execPath, [paths.workshop('fleet_control.js'), ...args],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  return r.status === 0;
}

function propsValue(key) {
  if (!fs.existsSync(PROPS_FILE)) return '';
  const m = new RegExp(`^${key.replace(/\./g, '\\.')}=(.*)$`, 'm').exec(fs.readFileSync(PROPS_FILE, 'utf8'));
  return m ? m[1].trim() : '';
}

(async () => {
  console.log(`\n══ host_and_run — this machine hosts the world (${SERVER_FOLDER}) ══`);
  say(`the world      ${CONFIG.world === 'fresh' ? `rolled back to '${CONFIG.snapshot}'` : 'carried forward as it stands'}`);
  say(`then           Auren_Workshop/run.js, unchanged — the same run a stranger gets`);

  // ── EVERY TERMINAL CLOSED BEFORE ANYTHING STARTS — CHECKED HERE, NEVER CLOSED HERE (2026-09-11) ────
  // *"before startup it should also check but not close. just prevent another start from happening and
  // say what terminals are open that prevents another start. thats our server hang problem"*. This used to
  // BRING DOWN whatever it found (`down`, then `server-stop`), which made a leftover invisible: every start
  // cleaned up after the last run, so nobody learned the last run had not. Now a leftover stops the start
  // by name, and the teardown that left it is the thing to fix. A world already answering is a leftover as
  // well — and a rollback under a live server restores files mid-write, which is not a world.
  phase('every terminal closed?');
  const open = consoleWindow.openWindows();
  const serverPort = Number(propsValue('server-port')) || 25565;
  const worldUp = await serverSettings.serverAnswers(serverPort);
  if (open.length || worldUp) {
    refuse([
      `${consoleWindow.describeWindows(open)}.`,
      ...(worldUp ? [`A Minecraft server is already answering on port ${serverPort} — a world from an earlier start is still up.`] : []),
      ``,
      `A start beside those shares a world with them. Nothing was closed; close them, then start again:`,
      `    node Auren_Workshop/fleet_control.js down`,
      `(the verb that closes every terminal a run opened and stops the world through its console).`,
    ]);
  }
  say('no terminals open, and no world answering');

  phase(`the world (${CONFIG.world})`);
  if (CONFIG.world === 'fresh') {
    if (!fleetControl(['snapshot-restore', `--world=${CONFIG.worldName}`, `--snapshot=${CONFIG.snapshot}`])) {
      console.error(`\n  host_and_run: the world could not be rolled back to '${CONFIG.snapshot}'. NOTHING was`);
      console.error(`  started — a fresh run on last run's world is not the run that was asked for.\n`);
      blocked('world_rollback', `the world could not be rolled back to '${CONFIG.snapshot}'`);
    }
    say(`rolled back to '${CONFIG.snapshot}'`);
  } else {
    say('left as the last run finished it');
  }

  // ── THE FOREMAN STARTS THE WORLD NOW, AND STOPS IT (Architect 2026-09-18) ─────────────────────────────
  // *"Foreman starts first before the server… Who owns the process? Foreman does."* This file used to
  // mint a console password, start the JVM through `fleet_control server-start`, and stop it afterwards.
  // All three moved into the foreman (`foreman/foreman_world.js`), which run.js starts in 'local' mode:
  // it writes the settings, mints the one-time password, launches the server in its own window, says why
  // if it fails, and stops and saves it when the run ends. What stays here is what needs the world DOWN —
  // the leftover check and the rollback above — done before the foreman exists.
  phase('run.js — the same run a stranger runs; its foreman starts this world');
  const child = spawn(process.execPath, [paths.workshop('run.js')],
    { stdio: 'inherit', env: { ...process.env, AUREN_SERVER_WHERE: 'local' } });

  const code = await new Promise(resolve => child.on('exit', c => resolve(c === null ? 1 : c)));

  // A world still answering after the run is a `leave-up` run, or a foreman that had not finished saving.
  // It is said, never stopped from here: the foreman that started it is its one stopper.
  if (await serverSettings.serverAnswers(serverPort)) {
    say(`the world is STILL UP on port ${serverPort} — the run left it up, or its foreman had not finished.`);
    say(`To end it with its foreman:  node Auren_Workshop/fleet_control.js verb shutdown`);
  } else {
    say('the world this machine hosts is down again');
  }

  console.log(`\n══ host_and_run finished — the run ${code === 0 ? 'PASSED' : `exited ${code}`} ══\n`);

  // ── THE INNERMOST THING THAT ACTUALLY RAN OWNS THE OUTCOME ────────────────────────────────────────
  // `run.js` writes the full record — every check, the wake, the timings — so this file must not
  // overwrite it with the thinner view it has from out here (Law 16: one writer per fact). It reads that
  // record back and echoes the headline instead.
  //
  // THE ONE CASE IT DOES WRITE is the gap that would otherwise swallow the worst failure of all: a child
  // that died without stating anything — killed, out of memory, a hard exit past its own handlers. An
  // exit code alone is not an outcome, and a reader finding LAST run's file sitting there would read a
  // stale answer as this run's (Invariant B). The `started_at` comparison is what makes the difference
  // between "it reported" and "something old is lying here" observable rather than assumed.
  const file = outcome.outcomeFile();
  const stated = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const fresh = stated && stated.started_at && Date.parse(stated.started_at) >= Date.parse(HOST_STARTED_AT);
  if (fresh) {
    console.log(`  the run stated its own outcome: ${stated.outcome} — ${stated.reason || 'no reason given'}`);
    console.log(`  read it whole at: ${file}\n`);
    process.exit(code);
  }
  process.exit(outcome.write({
    outcome: 'CRASHED', stage: 'run_js',
    reason: `run.js exited ${code} without stating an outcome — it died past its own reporting`,
    startedAt: HOST_STARTED_AT, reportedBy: 'host_and_run', exitCode: code || 1,
  }));
})();
