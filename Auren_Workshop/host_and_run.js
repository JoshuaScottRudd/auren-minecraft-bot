// module: host_and_run
// purpose: THE OVERLAY FOR A MACHINE THAT HOSTS THE WORLD ITSELF. It starts the server, runs `run.js`
//          untouched, and stops the server afterwards — one command, one pass.
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
//     HOSTING A WORLD   this file          stop · roll back to a snapshot · mint a console password · start
//     RUNNING A CREW    run.js             join a world that is there · work · read the record · come down
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
const rcon = require(paths.bot('js_kernel/utils/rcon_link'));
const { guardExternal } = require(paths.bot('js_kernel/utils/external_library_guard'));

// ONLY THE `hosting` BLOCK. `run.js` owns the other one and validates it for itself; this file never
// reads it, so a fault in the run's settings is reported by the run's own refusal, in the run's own words.
const { hosting: CONFIG } = require('./run_config');

const PERMITTED = { world: ['fresh', 'continue'] };
const SHAPE = { world: 'enum', snapshot: 'string', worldName: 'string' };

function refuse(lines) {
  console.error(`\n  host_and_run: NOTHING WAS STARTED — the world was not touched.\n`);
  for (const l of lines) console.error(`    ${l}`);
  console.error(``);
  process.exit(1);
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
          `  hosting. Its address is in Auren_Bot/your_server.js.`]);
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

// ── THE MINT HAPPENS AFTER THE OLD SERVER IS STOPPED, AND THAT ORDER IS THE FIX (2026-09-10) ────────
// It once ran before anything else, and destroyed the credential needed to stop the server that was
// already up: `server-stop` reads the password from this same file, so it presented the NEW one to a JVM
// booted with the OLD one and got `rcon auth refused`. The stop then correctly refused to hard-kill a live
// world, the rollback hit a locked `session.lock`, and the run halted with nothing started — a sequence
// whose every step was right and whose order was wrong. The symptom reads as a wrong password and is
// actually a stale process.
//
// So: the file holds the RUNNING server's password until that server is gone, and only then is a new one
// written. Called exactly once, between the stop and the start.
//
// WHY MINT AT ALL (Architect 2026-09-10: *"no password at all for local server. theres no ports open."*).
// A literally blank one is not available, and Minecraft rather than this file settles that: with
// `rcon.password=` empty the server answers *"No rcon password set in server.properties, rcon disabled!"*
// and the port never opens, so blanking it removes the console rather than the password. Minting removes
// it from HIS side instead — nothing to choose, nothing to remember, nothing typed, and no credential
// sitting in a tracked file for the extract to carry.
function mintConsolePassword() {
  // Random per run, so it is never a shared secret and never the same twice. Not cryptographic and it does
  // not need to be: it authenticates this machine to a loopback port on a world it just created.
  const token = `auren-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
  const before = fs.readFileSync(PROPS_FILE, 'utf8');
  const after = /^rcon\.password=.*$/m.test(before)
    ? before.replace(/^rcon\.password=.*$/m, `rcon.password=${token}`)
    : `${before.replace(/\s*$/, '')}\nrcon.password=${token}\n`;
  // Written before the server BOOTS, because the server reads this file once at boot.
  fs.writeFileSync(PROPS_FILE, after);
  return token;
}

(async () => {
  console.log(`\n══ host_and_run — this machine hosts the world (${SERVER_FOLDER}) ══`);
  say(`the world      ${CONFIG.world === 'fresh' ? `rolled back to '${CONFIG.snapshot}'` : 'carried forward as it stands'}`);
  say(`then           Auren_Workshop/run.js, unchanged — the same run a stranger gets`);

  // ── NOTHING IS IN THE WORLD → CHANGE THE WORLD → LET THINGS IN ─────────────────────────────────────
  // A rollback under a live fleet restores files beneath running clients. The fleet comes down first, and
  // it comes down before the server so the clients are gone before the thing they were talking to is.
  phase(`take the world down`);
  if (!fleetControl(['down'])) say('nothing was up to bring down, which is the expected state');
  // NOT `refuse()`: that says "the world was not touched", and by this line the fleet HAS been brought
  // down. A refusal that overstates what it left alone is worse than no message (Law 23).
  if (!fleetControl(['server-stop'])) {
    console.error(`\n  host_and_run: the server would not stop, so the world was NOT rolled back and no run`);
    console.error(`  was started. A rollback under a running server restores files mid-write, which is not`);
    console.error(`  a world. The fleet was already brought down before this, so nothing is in there.`);
    console.error(`  Read the message above — it names what refused.\n`);
    process.exit(1);
  }

  phase(`the world (${CONFIG.world})`);
  const password = mintConsolePassword();
  say('a fresh console password was minted for this run');
  if (CONFIG.world === 'fresh') {
    if (!fleetControl(['snapshot-restore', `--world=${CONFIG.worldName}`, `--snapshot=${CONFIG.snapshot}`])) {
      console.error(`\n  host_and_run: the world could not be rolled back to '${CONFIG.snapshot}'. NOTHING was`);
      console.error(`  started — a fresh run on last run's world is not the run that was asked for.\n`);
      process.exit(1);
    }
    say(`rolled back to '${CONFIG.snapshot}'`);
  } else {
    say('left as the last run finished it');
  }

  phase('start the world');
  if (!fleetControl(['server-start'])) {
    console.error(`\n  host_and_run: the server did not come up, so nothing joined it.\n`);
    process.exit(1);
  }
  say('the world is up');

  // ── THE HAND-OFF: THE ENVIRONMENT, AND NOTHING ELSE ───────────────────────────────────────────────
  // `Auren_Bot/your_server.js` reads these two before its own values, and `run.js` reads that file. So the
  // minted password reaches the run down the SAME path a stranger's typed one does, and there is no
  // argument, no flag and no file this run could inspect to discover that a host started its world.
  // The port is read back off `server.properties` rather than assumed, because that file is what the JVM
  // that is now running actually booted from (Law 23).
  const rconPort = propsValue('rcon.port') || '25575';
  process.env.AUREN_RCON_PASSWORD = password;
  process.env.AUREN_RCON_PORT = rconPort;

  phase('run.js — the same run a stranger runs');
  const child = spawn(process.execPath, [paths.workshop('run.js')],
    { stdio: 'inherit', env: process.env });

  const code = await new Promise(resolve => child.on('exit', c => resolve(c === null ? 1 : c)));

  // ── THE WORLD COMES DOWN UNLESS SOMEBODY IS STILL STANDING IN IT ──────────────────────────────────
  // A failed run is not a reason to leave a JVM holding the world folder: the next pass starts by
  // restoring a snapshot into it, and a live server there is the locked `session.lock` this project has
  // already lost a run to. So the default is down, including after a failure.
  //
  // THE ONE EXCEPTION IS READ FROM THE WORLD, NOT FROM THE CONFIG PAGE (Law 1, same rule as the hand-off
  // above). `run.js`'s `teardown: 'leave-up'` deliberately leaves the desk and the crew standing to be
  // poked at by hand, and killing the server under them would delete the very thing that mode exists to
  // preserve. This file does not read the run's settings to find that out — it asks the SERVER who is in
  // the world, which is the same question `run.js` asks and the only roster not written by the thing under
  // test. Anyone left in there means somebody is still using this world; nobody means the run finished and
  // cleaned up after itself.
  // The console read goes through `external_library_guard` rather than a hand-written try/catch, which is
  // the one pathway to the outside in this project (Law 16) and is machine-checked by preflight pass 4. An
  // unreachable console comes back `ok: false` and means the world is already gone or wedged — either way
  // the stop below is the right move, so the failure needs no branch of its own.
  phase('stop the world');
  const roster = await guardExternal('host_and_run', 'who is still in the world', () =>
    rcon.once(['list'], { creds: { port: Number(rconPort), password } }));
  const listed = roster.ok && /players online:\s*(.*)$/.exec((roster.value[0] && roster.value[0].body) || '');
  const stillInside = listed ? listed[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  if (stillInside.length) {
    say(`LEFT UP — ${stillInside.join(', ')} ${stillInside.length === 1 ? 'is' : 'are'} still in the world.`);
    say(`They are yours to reap:  node Auren_Workshop/fleet_control.js down`);
    say(`Then stop the world:     node Auren_Workshop/fleet_control.js server-stop`);
  } else {
    fleetControl(['server-stop']);
    say('the world this script started is down again');
  }

  console.log(`\n══ host_and_run finished — the run ${code === 0 ? 'PASSED' : `exited ${code}`} ══\n`);
  process.exit(code);
})();
