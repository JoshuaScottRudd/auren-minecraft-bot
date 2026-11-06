#!/usr/bin/env node
// start_auren.js — the one way in: the foreman opens and raises the crew its run page names.
//
//   node start_auren.js
//
// Both crews (homesteader, builder) answer to nobody and work their own agenda. foreman/foreman.js holds
// both halves this launches: the referee, which arbitrates holds on world objects and the planning turn,
// and the body, a client that joins the world, sites the base and fetches bodies.
//
// `start_bot.js` remains the one birth (Law 16); this file starts the foreman's process, and the
// foreman spawns `start_bot.js` for each body of its crew. No bot is started by this script.

'use strict';

// This process loads shipped bot code (watcher, foreman_link) requiring `@kernel/`, `@foreman/` and
// `@utils/`, so the alias map is registered here, same entry-point convention as `foreman/foreman_hub.js`,
// `master_core` and `foreman` (Law 16). `path.resolve(__dirname)` anchors it to this directory, not the
// module's install directory; registered once per process.
require('module-alias')(require('path').resolve(__dirname));

const fs = require('fs');
const path = require('path');
const fleet = require('./js_kernel/utils/child_fleet');
const { guardExternalSync } = require('./js_kernel/utils/external_library_guard');
// The same red block the foreman raises, so a death reported from out here looks like a death reported
// from in there. Rendering only — the recording half stays with the foreman, which owns a record (Law 16).
const alarmBlock = require('./js_kernel/utils/alarm_block');

// ── THE FOREMAN'S PORTS ARE ASSIGNED AT START, NOT FIXED ──────────────────────────────────────────────
// The foreman holds two ports: its own and the one above it (the in-game door, foreman_hub). A run takes the
// first free pair from 3001 up (port_book), so a second run on this machine, from its own Auren_Bot copy, takes
// the next pair and says so instead of being refused. FOREMAN_PORT, when set, names the pair and is not moved.
// The pair taken is written on the run lock, where the operator's tools read it (port_book.runForemanPort).
const portBook = require('./js_kernel/utils/port_book');
const FOREMAN_PORT_ASKED = Number(process.env.FOREMAN_PORT) || null;
let FOREMAN_PORT = FOREMAN_PORT_ASKED || portBook.FOREMAN_PORT_USUAL;

// Placing a crew on its landing cell needs a server console, reachable only through RCON; flags carry
// it for a person, environment variables for a non-human caller (`start_bot.js` uses that path). Defaults
// come from `foreman_config.js`; flags still win over the file as a per-run override (Law 16).
const WORLD = require('./foreman_config');
const FLAGS = [
  { flag: 'where', env: 'AUREN_SERVER_WHERE', help: "'local' (the foreman starts your server) or 'remote' (it joins one somebody else runs)" },
  { flag: 'start', env: 'AUREN_START', help: "'rollback' (the bots start knowing nothing) or 'continue'" },
  { flag: 'soak', env: 'AUREN_SOAK', help: 'minutes the run lasts once the crew is working (0 = until stopped)' },
  { flag: 'ends', env: 'AUREN_ENDS', help: "'soak' (the run lasts the soak), 'built' (a builder run ends when the building stands) or 'real' (built, with no planks standing in)" },
  { flag: 'crew', env: 'AUREN_CREW', help: "'homesteader' or 'builder'" },
  { flag: 'landing', env: 'AUREN_LANDING', help: "'usual' (the nearest good ground to world spawn) or 'random' (rolled new each run, far from the usual spot)" },
  { flag: 'test', env: 'AUREN_TEST', help: "exercise the foreman and stop before any bot is raised: 'scan', 'inspect' or 'world'" },
  { flag: 'module', env: 'AUREN_MODULE', help: "'off', or a test module the judge hands every planning turn to in place of the planner: 'walk'" },
  { flag: 'module-biome', env: 'AUREN_MODULE_BIOME', help: "for --module walk: the biome walked to (default 'jungle')" },
  { flag: 'observer', env: 'AUREN_OBSERVER', help: "a person watching: the name you log in under. The foreman puts it in spectator at the site" },
  { flag: 'build', env: 'AUREN_BUILD', help: "for a builder crew: what it builds" },
  { flag: 'count', env: 'AUREN_CREW_COUNT', help: 'how many homesteaders or builders the run raises, bounded by the available roster' },
  { flag: 'only', env: 'AUREN_CREW_ONLY', help: 'roster names raised and no others (comma-separated), in place of --count' },
  { flag: 'clock', env: 'AUREN_CLOCK', help: "'dawn', 'day' (pinned at midday) or 'held' (the world's own time)" },
  { flag: 'go', env: 'AUREN_GO', help: "'now' (bots work as they arrive) or 'held' (every bot is raised and placed first, then all are released)" },
  { flag: 'record', env: 'AUREN_RECORD', help: "'off', 'cameras' (a camera window per bot) or 'film' (cameras + a recorder)" },
  { flag: 'watch', env: 'AUREN_WATCH', help: "'true' ends the run the moment something in --wake happens, 'false' runs it out" },
  { flag: 'wake', env: 'AUREN_WAKE', help: "what ends a watched run: 'error,death' (the default), or one of them" },
  { flag: 'server-folder', env: 'AUREN_SERVER_DIR', help: "the folder your Minecraft server runs in (the one holding server.properties)" },
  { flag: 'host', def: WORLD.host, help: 'server address the foreman connects to' },
  { flag: 'port', def: String(WORLD.port), help: 'server port' },
  // The console password and port are for a REMOTE world, whose owner gives them to you. For a local one
  // the foreman writes a fresh password into server.properties each start, and nobody types one.
  { flag: 'rcon-password', env: 'AUREN_RCON_PASSWORD', help: "a console password already set up by a launcher above this one" },
  { flag: 'rcon-port', env: 'AUREN_RCON_PORT', help: "that console's port  (default: 25575)" },
  // 'sweep' (default) empties fleet_logs/ because this door is the start of a run. 'keep' is for a
  // caller that is itself the start and already swept.
  { flag: 'records', def: 'sweep', help: "'sweep' empties fleet_logs/ first (default) · 'keep' if your launcher already did" },
];

function usage() {
  console.log(`
  Start Auren: the foreman starts (or joins) your world, sites a base and raises the crew foreman_config.js names.

    node start_auren.js

  To EXERCISE the foreman without raising a single bot — three words, in this order:

    node start_auren.js test scan homesteader

  It brings the world up, joins it, finds a standing spot, sites the base, says what it found
  and shuts everything down. Nothing else about the run changes: it is the ordinary startup
  with its last two steps left off. The tests there are: scan, inspect, world.

  To LOOK OVER what the last run built — one word:

    node start_auren.js inspect

  It brings the world up as the last run left it, raises no bot, opens the one camera
  window you fly, puts it at the base (a builder's laydown yard), pins midday, and stays
  up until you stop it. Nothing is put back or emptied.

    --test scan|inspect|world   the same thing said as an option, if you prefer options
    --where local|remote    which world  (default: ${WORLD.where}, from foreman_config.js)
    --start rollback|continue   a clean start, or carry on  (default: ${WORLD.start})
    --soak <minutes>        how long it runs once the crew is working  (default: ${WORLD.soak}; 0 = until stopped)
    --ends soak|built|real  built: a builder run ends when the building stands, the soak at most;
                            real: as built, with every stood-in cell its real block  (default: ${WORLD.ends})
    --crew homesteader|builder   what kind of bots  (default: ${WORLD.crew})
    --build <name>          for a builder crew: what it builds  (default: ${WORLD.builder.build})
    --count <n>             homesteaders or builders raised, 2 to the available roster  (default: ${WORLD.count})
    --only <name,...>       raise these roster names and no others, e.g. one body isolated on a continue
    --landing usual|random  random: the crew lands somewhere new each run, 2 to 4 loaded areas
                            from the usual spot  (default: ${WORLD.landing})
    --clock dawn|day|held   the world's time of day  (default: ${WORLD.clock})
    --record off|cameras|film   camera windows on the bots  (default: ${WORLD.record})
    --observer <name>       you watch: log in under that name and the foreman puts you, in
                            spectator, wherever it puts the crew  (default: ${WORLD.observer || 'nobody'})
    --watch true|false      end the run the moment something goes wrong  (default: ${WORLD.watch})
    --wake error,death      what counts as going wrong  (default: ${WORLD.wake.join(',')})
    --server-folder <dir>   local: the folder your Minecraft server runs in
    --host <address>        remote: the server's address  (default: ${WORLD.host})
    --port <n>              remote: the server's port  (default: ${WORLD.port})
    --rcon-password <pw>    remote: that server's console password, from its owner
    --rcon-port <n>         remote: that console's port  (default: ${WORLD.rconPort})
    --help                  this text

  Put these in foreman_config.js, beside this file, and you never type them again.

  local:  the foreman starts your server itself, and sets up what the bots need
          in its server.properties, printing every change and why:
              online-mode=false       the bots have no Minecraft accounts
              enable-rcon=true        the crew is placed on its base through the server console
              rcon.password=<random>  a new one every start
          When you stop Auren, it stops the server too and waits for it to save.
  remote: the foreman joins the world at host:port. It never starts or stops it.

  If anything fails, the foreman says what and where to change it.

  What happens:
    A foreman joins your world and raises its crew by itself: it finds open
    ground away from world spawn, sites the base, and brings the crew there.
    The crew answers to nobody: talking to it does nothing, by design.

    Ctrl-C stops everything: the bots, the foreman, and a server it started.
`);
}

function die(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
const given = {};

// `test <what> <crew>`: shorthand for --test and --crew (Law 16), then falls through to the ordinary
// flag parse. Accepted only as the first word, so `test` can never be swallowed as a flag's value.
if (argv[0] === 'test') {
  const what = argv[1];
  const crew = argv[2];
  if (!what || what.startsWith('--')) die("'test' needs the name of a test after it, then the crew — e.g. test scan homesteader. Try --help.");
  if (!crew || crew.startsWith('--')) die(`'test ${what}' needs the crew after it — e.g. test ${what} homesteader. Try --help.`);
  given.test = what;
  given.crew = crew;
  argv.splice(0, 3);
}

// `inspect [crew]`: shorthand for --test inspect on a continue start with midday pinned, so an untimed
// look never walks into a night. The crew is the page's unless one is said; a later flag still wins.
if (argv[0] === 'inspect') {
  const crew = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  given.test = 'inspect';
  given.start = 'continue';
  given.clock = 'day';
  if (crew) given.crew = crew;
  argv.splice(0, crew ? 2 : 1);
}

for (let i = 0; i < argv.length; i++) {
  const raw = argv[i];
  if (raw === '--help' || raw === '-h') { usage(); process.exit(0); }
  if (!raw.startsWith('--')) die(`'${raw}' is not an option. Options start with --, and only 'test <what> <crew>' or 'inspect' may come first. Try --help.`);
  const eq = raw.indexOf('=');
  const name = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).toLowerCase();
  if (!FLAGS.some(f => f.flag === name)) die(`'--${name}' is not an option. Try --help for the list.`);
  const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
  if (value === undefined || value.startsWith('--')) die(`'--${name}' needs a value after it.`);
  given[name] = value;
}

// Every flag becomes an environment variable, read by the foreman through `foreman_config.js` (Law 16),
// reaching the foreman's process and every bot it spawns. Every flag in `FLAGS` must have a row here;
// the load-time check below proves it, since a missing row cannot be seen by reading either list alone
// (Law 25).
const FLAG_ENV = {
  where: 'AUREN_SERVER_WHERE', start: 'AUREN_START', soak: 'AUREN_SOAK', ends: 'AUREN_ENDS', crew: 'AUREN_CREW', build: 'AUREN_BUILD', landing: 'AUREN_LANDING',
  test: 'AUREN_TEST', module: 'AUREN_MODULE', 'module-biome': 'AUREN_MODULE_BIOME',observer: 'AUREN_OBSERVER', count: 'AUREN_CREW_COUNT', only: 'AUREN_CREW_ONLY',
  clock: 'AUREN_CLOCK', go: 'AUREN_GO', record: 'AUREN_RECORD', watch: 'AUREN_WATCH', wake: 'AUREN_WAKE',
  'server-folder': 'AUREN_SERVER_DIR', host: 'AUREN_SERVER_HOST', port: 'AUREN_SERVER_PORT',
  'rcon-password': 'AUREN_RCON_PASSWORD', 'rcon-port': 'AUREN_RCON_PORT',
};
// `records` is the one flag with no environment row on purpose: it is read directly below, by this file,
// and never travels to a child. Every other flag reaches the foreman only through the environment.
const NOT_ENV = new Set(['records']);
const dropped = FLAGS.map(f => f.flag).filter(f => !FLAG_ENV[f] && !NOT_ENV.has(f));
if (dropped.length) {
  throw new Error(`start_auren: --${dropped.join(', --')} ${dropped.length > 1 ? 'are' : 'is'} offered by --help `
    + `but carried nowhere, so ${dropped.length > 1 ? 'they' : 'it'} would be accepted and silently ignored. `
    + `Give each one its AUREN_* row in FLAG_ENV, or take it out of FLAGS.`);
}
for (const [flag, env] of Object.entries(FLAG_ENV)) {
  if (given[flag] !== undefined) process.env[env] = given[flag];
}

// ── ONE RUN AT A TIME ───────────────────────────────────────────────────────────────────────────────
// A run holds `run_lock.json` from before its first act to the exit of this process and its foreman. The
// lock is taken before a record is swept or a memory emptied, so a second start is refused with the run
// that is up named, and nothing of that run is touched (Invariant A, Law 13).
const RUN_LOCK = path.join(__dirname, 'run_lock.json');
const MACHINE_BOT_LIMIT = 30;
const lockHeld = { pid: process.pid, started_at: new Date().toISOString(), asked: process.argv.slice(2).join(' ') || '(the page as written)' };

function isRunning(pid) {
  return Number.isInteger(pid)
    && guardExternalSync('start_auren', `asking the operating system whether process ${pid} is running`, () => process.kill(pid, 0)).ok;
}

function writeRunLock(flag) {
  return guardExternalSync('start_auren', 'writing the run lock', () => fs.writeFileSync(RUN_LOCK, JSON.stringify(lockHeld), { flag }));
}

function takeRunLock() {
  if (fs.existsSync(RUN_LOCK)) {
    const read = guardExternalSync('start_auren', 'reading the run lock', () => JSON.parse(fs.readFileSync(RUN_LOCK, 'utf8')));
    const held = read.ok && read.value ? read.value : {};
    const up = [['this launcher', held.pid], ['its foreman', held.foreman_pid]].filter(([, pid]) => isRunning(pid));
    if (up.length) {
      die(`A RUN IS ALREADY UP — nothing was started, and nothing of that run was touched.\n`
        + `  started ${held.started_at} with: ${held.asked}\n`
        + `  still running: ${up.map(([who, pid]) => `${who} (process ${pid})`).join(', ')}\n`
        + `  To end it:  node Auren_Workshop/fleet_control.js verb shutdown`);
    }
    console.log(`\n  a run lock from ${held.started_at || 'an unreadable start'} was left behind by a run that is no longer up — taken over.`);
    fs.unlinkSync(RUN_LOCK);
  }
  // 'wx' creates the file or fails, so of two starts in the same moment exactly one holds the lock.
  if (!writeRunLock('wx').ok) die('ANOTHER START TOOK THE RUN LOCK IN THE SAME MOMENT — nothing was started here.');
  process.on('exit', () => { if (!lockHeld.foreman || lockHeld.foreman.exitCode !== null || lockHeld.foreman.signalCode !== null) fs.rmSync(RUN_LOCK, { force: true }); });
}

// THE MACHINE CARRIES AT MOST MACHINE_BOT_LIMIT BODIES ACROSS EVERY SEAT, so two full fleets fill it. Other runs count
// at what their launchers asked, since their bodies may still be rising, or at the bodies up when a probe raised more.
function crewAsked(only, count) {
  return only ? only.split(',').filter(Boolean).length : count === undefined ? 15 : Number(count);
}
function refuseOverMachineLimit() {
  if (process.platform !== 'win32') return;
  const listed = guardExternalSync('start_auren', 'listing the fleets on this machine', () => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json";
    return [].concat(JSON.parse(require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })));
  });
  if (!listed.ok) { console.log('\n  the machine bot limit was not checked: the process list could not be read.'); return; }
  const others = listed.value.filter(p => p.ProcessId !== process.pid && p.CommandLine);
  const flag = (line, name) => { const m = new RegExp(`--${name}[ =](\\S+)`).exec(line); return m ? m[1] : undefined; };
  const launchers = others.filter(p => /start_auren\.js/.test(p.CommandLine) && /--crew/.test(p.CommandLine));
  const asked = launchers.reduce((n, p) => n + crewAsked(flag(p.CommandLine, 'only'), flag(p.CommandLine, 'count')), 0);
  const bodies = others.filter(p => /start_bot\.js/.test(p.CommandLine)).length;
  const mine = process.env.AUREN_CREW || given.crew ? crewAsked(process.env.AUREN_CREW_ONLY, process.env.AUREN_CREW_COUNT) : 0;
  const elsewhere = Math.max(asked, bodies);
  if (elsewhere + mine > MACHINE_BOT_LIMIT) {
    die(`THE MACHINE LIMIT IS ${MACHINE_BOT_LIMIT} BOTS — nothing was started or cleared.\n`
      + `  ${elsewhere} on other seats, and this run asks for ${mine}. Wait for a run to end, or ask for fewer.`);
  }
}

// The foreman (`foreman/foreman_world.js`) owns proving the world — starting a local server or reaching
// a remote one, and saying why when it cannot. This file sweeps the records and raises the foreman.
(async () => {
  // A test that looks at the last run's world is refused on any other start here, before a record is swept.
  const test = process.env.AUREN_TEST || WORLD.test;
  const testStart = test === 'off' ? null : require('./foreman/utils/test_modes').startFor(test);
  if (testStart && (process.env.AUREN_START || WORLD.start) !== testStart) {
    die(`'--test ${test}' looks at the world the last run left, so it needs --start ${testStart}. Nothing was started or cleared.\n`
      + `  The short way:  node start_auren.js ${test}`);
  }
  const hold = require('./js_kernel/utils/record_homes').architectHold();
  if (hold) {
    die(`ARCHITECT HOLD ON THIS SEAT — nothing was started or cleared.\n`
      + `  held by ${hold.session} since ${hold.at}: ${hold.reason}\n`
      + `  Only the Architect's release lifts it.`);
  }
  refuseOverMachineLimit();
  takeRunLock();
  if (!FOREMAN_PORT_ASKED) {
    const pair = await portBook.firstFree({ from: portBook.FOREMAN_PORT_USUAL, width: 2, step: 2 });
    if (pair === null) {
      die(`NO FREE PORTS FOR THE FOREMAN — ${portBook.PORT_TRIES} pairs from ${portBook.FOREMAN_PORT_USUAL} up are all in use. Nothing was started or cleared.`);
    }
    if (pair !== portBook.FOREMAN_PORT_USUAL) {
      console.log(`
  the foreman's usual ports ${portBook.FOREMAN_PORT_USUAL} and ${portBook.FOREMAN_PORT_USUAL + 1} are in use (another run on this machine) — `
        + `this run's foreman takes ${pair} and ${pair + 1}.`);
    }
    FOREMAN_PORT = pair;
  }
  lockHeld.foreman_port = FOREMAN_PORT;
  writeRunLock('w');
  // A ROLLBACK START IS THE ONE THING THAT EMPTIES fleet_logs/ (STANDING): swept here, since this is the one
  // door that starts a whole fleet before any bot exists. Every writer appends (watcher.js, crew_launch.js)
  // and none clears. A launcher that already swept for its own rollback passes `--records keep`.
  const records = given.records || 'sweep';
  if (records !== 'sweep' && records !== 'keep') {
    die(`'--records ${records}' is not a choice. Use 'sweep' (empty fleet_logs/ first) or 'keep' (your launcher already did).`);
  }
  // A WORLD ANOTHER SERVER HOLDS IS REFUSED BEFORE ANY RECORD IS SWEPT. The run lock above covers runs started
  // from this copy; a server started from another copy of the bot, or by a probe, holds the world's session.lock,
  // and its records may be these records. The foreman refuses that world too, but only after this sweep.
  if ((process.env.AUREN_SERVER_WHERE || WORLD.where) === 'local') {
    const serverDir = require('./js_kernel/utils/workstation').findServerDir().dir;
    if (serverDir && require('./js_kernel/utils/server_settings').worldInUse(serverDir)) {
      die(`A SERVER IS ALREADY RUNNING ON THIS WORLD (${serverDir}) — nothing was started or cleared.\n`
        + `  Another run or probe holds it. Wait for it to end, or join it with --where remote.`);
    }
  }
  // A CONTINUE START KEEPS THE LAST RUN'S RECORDS: the world carries on and so does what was written about
  // it, each run its own segment of the same files. Only a rollback start empties the room.
  if ((process.env.AUREN_START || WORLD.start) === 'continue') {
    console.log(`\n  fleet_logs/ kept — a continue start carries on from the last run's records.`);
  } else if (records === 'sweep') {
    const sweep = require('./js_kernel/utils/record_homes').sweepRecords();
    if (sweep.swept && sweep.entries.length) {
      console.log(`\n  cleared ${sweep.entries.length} record(s) from the last run — everything in `
        + `fleet_logs/ now belongs to this one.`);
    }
  } else {
    console.log(`\n  fleet_logs/ left as it is — the launcher that started this foreman already swept it.`);
  }

  const where = process.env.AUREN_SERVER_WHERE || WORLD.where;
  const joins = `joins the world at ${process.env.AUREN_SERVER_HOST || WORLD.host}:${process.env.AUREN_SERVER_PORT || WORLD.port}`;
  // The crew as this run will have it: a flag set above wins over the page, which was read before the flags.
  const crew = process.env.AUREN_CREW || WORLD.crew;
  console.log(`\n  Auren — the foreman is starting, and it ${where === 'local' ? 'starts your server first' : joins}.`
    + `\n  then it finds open ground, sites the base and brings in a ${crew} crew by itself.`
    + `\n  Ctrl-C stops everything${where === 'local' ? ', and the foreman stops the server and waits for it to save' : ''}\n`);

  // The hub opens inside the foreman before its world and its body (foreman.js requires it first); the
  // foreman names its own record `foreman` instead of inheriting a bot's name. DEP0040 (Node's built-in
  // `punycode` deprecation, raised by a library below mineflayer) is silenced by name via NODE_OPTIONS,
  // which the foreman and every bot it spawns inherit; every other warning still prints.
  const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0040'].filter(Boolean).join(' ');

  const foreman = fleet.start('foreman', 'foreman/foreman.js', {
    NODE_OPTIONS: nodeOptions,
    FOREMAN_PORT: String(FOREMAN_PORT),
    FOREMAN_URL: `ws://127.0.0.1:${FOREMAN_PORT}`,
    BOT_ID: 'foreman',
  });
  // The foreman's own process is named on the lock, so the run stays held for as long as either is up.
  lockHeld.foreman_pid = foreman.pid;
  writeRunLock('w');
  Object.defineProperty(lockHeld, 'foreman', { value: foreman, enumerable: false, configurable: true });

  // The foreman ends itself, so this door waits for it instead of killing it: a killed foreman would
  // leave the server it started running, unsaved and holding the world folder. If it dies without ending
  // itself, this is the last witness — a force-killed foreman takes every body with it before any of
  // them write a byte, since they are ended by the operating system.
  //
  // `code` alone cannot tell a chosen exit from a force-kill (both can read `code=1 signal=null`). The
  // foreman's shutdown road always ends by writing the outcome file, so the file's presence is the
  // signal: present means it chose its ending, absent means it did not (`fleet_logs/` was swept above,
  // so the file cannot be a leftover).
  const { outcomeFile } = require('./foreman/utils/run_outcome');
  fleet.followOwner(foreman, (code, signal) => {
    if (fs.existsSync(outcomeFile())) return;   // it chose its ending and already reported it
    // Windows reports a TerminateProcess as 4294967295 (0xFFFFFFFF); named here instead of printed raw,
    // so a person reading it knows what happened.
    const how = signal ? `signal ${signal}`
      : code === null ? 'no exit code at all'
      : code >= 0xFFFFFFF0 ? `a forced kill from outside (Windows code ${code})`
      : `exit code ${code}`;
    alarmBlock.print([
      'THE FOREMAN DIED WITHOUT SHUTTING DOWN.',
      'The whole fleet went with it.',
      '',
      `How it left: ${how}.`,
      'It never wrote a verdict, so it did not reach its own shutdown road.',
      '',
      'WHAT THAT MEANS:',
      'The bots were not sent home — they are already gone, ended by the',
      'operating system, and they cannot report for themselves.',
      'A world this run started was killed rather than asked to save.',
      '',
      'WHAT IT RULES OUT:',
      'A finished soak, a Ctrl-C, a failed startup and a FAIL verdict all',
      'write a verdict file before exiting. None of them reach this block.',
      '',
      'WHERE TO LOOK:',
      'The lines just above this block, for the cause.',
      'fleet_logs/traces/watcher_foreman.jsonl, for what it was doing.',
      '',
      'BEFORE STARTING AGAIN, close any leftover terminals:',
      '    node Auren_Workshop/fleet_control.js down',
    ]);
  });
})();
