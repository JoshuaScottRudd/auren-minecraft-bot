#!/usr/bin/env node
// start_auren.js — the one way in: the desk opens, and you hire every bot from inside the game.
//
//   node start_auren.js
//   then, in Minecraft chat:   foreman get contractor
//                        or:   foreman get homesteader
//
// Both crews are fetched by name from the desk and brought to wherever the requesting person stands.
// contractor answers to whoever asks for it in chat; homesteader answers to nobody and works its own
// agenda. foreman/foreman.js holds both halves this launches: the referee, which arbitrates holds on
// world objects and the planning turn, and the desk, a client that joins the world and fetches bodies.
//
// `start_bot.js` remains the one birth (Law 16); this file starts the foreman's process, and the
// foreman spawns `start_bot.js` when somebody asks for a bot. No bot is started by this script.

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

// The foreman's own port is fixed, not a CLI flag; only an environment override reaches it, for a
// machine that already runs a foreman permanently.
const FOREMAN_PORT = Number(process.env.FOREMAN_PORT) || 3001;

// Placing a crew where a person stands needs a server console, reachable only through RCON; flags carry
// it for a person, environment variables for a non-human caller (`start_bot.js` uses that path). Defaults
// come from `foreman_config.js`; flags still win over the file as a per-run override (Law 16).
const WORLD = require('./foreman_config');
const FLAGS = [
  { flag: 'where', env: 'AUREN_SERVER_WHERE', help: "'local' (the foreman starts your server) or 'remote' (it joins one somebody else runs)" },
  { flag: 'start', env: 'AUREN_START', help: "'rollback' (the bots start knowing nothing) or 'continue'" },
  { flag: 'soak', env: 'AUREN_SOAK', help: 'minutes the run lasts once the crew is working (0 = until stopped)' },
  { flag: 'ends', env: 'AUREN_ENDS', help: "'soak' (the run lasts the soak) or 'built' (a builder run ends when the building stands)" },
  { flag: 'crew', env: 'AUREN_CREW', help: "'homesteader', 'builder' or 'contractor'" },
  { flag: 'landing', env: 'AUREN_LANDING', help: "'usual' (the nearest good ground to world spawn) or 'random' (rolled new each run, far from the usual spot)" },
  { flag: 'test', env: 'AUREN_TEST', help: "exercise the foreman and stop before any bot is raised: 'scan'" },
  { flag: 'observer', env: 'AUREN_OBSERVER', help: "a person watching: the name you log in under. The foreman puts it in spectator at the site" },
  { flag: 'build', env: 'AUREN_BUILD', help: "for a builder crew: what it builds" },
  { flag: 'builder-count', env: 'AUREN_BUILDER_COUNT', help: 'how many builders the run raises, bounded by the available roster' },
  { flag: 'clock', env: 'AUREN_CLOCK', help: "'dawn', 'day' (pinned at midday) or 'held' (the world's own time)" },
  { flag: 'record', env: 'AUREN_RECORD', help: "'off', 'cameras' (a camera window per bot) or 'film' (cameras + a recorder)" },
  { flag: 'machine-hour', env: 'AUREN_MACHINE_HOUR', help: "the hour a day the computer has to itself: '00:00-01:00', or 'off'" },
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
  Start Auren: the foreman starts (or joins) your world, and you hire bots from inside it.

    node start_auren.js

  To EXERCISE the foreman without raising a single bot — three words, in this order:

    node start_auren.js test scan homesteader

  It brings the world up, joins it, finds a standing spot, sites the base, says what it found
  and shuts everything down. Nothing else about the run changes: it is the ordinary startup
  with its last two steps left off. The tests there are: scan.

    --test scan             the same thing said as an option, if you prefer options
    --where local|remote    which world  (default: ${WORLD.where}, from foreman_config.js)
    --start rollback|continue   a clean start, or carry on  (default: ${WORLD.start})
    --soak <minutes>        how long it runs once the crew is working  (default: ${WORLD.soak}; 0 = until stopped)
    --ends soak|built       built: a builder run ends when the building stands, the soak at most  (default: ${WORLD.ends})
    --crew homesteader|builder|contractor   what kind of bots  (default: ${WORLD.crew})
    --build <name>          for a builder crew: what it builds  (default: ${WORLD.builder.build})
    --builder-count <n>     number of builders, from 2 to the available roster  (default: ${WORLD.builder.count})
    --landing usual|random  random: the crew lands somewhere new each run, 2 to 4 loaded areas
                            from the usual spot  (default: ${WORLD.landing})
    --clock dawn|day|held   the world's time of day  (default: ${WORLD.clock})
    --record off|cameras|film   camera windows on the bots  (default: ${WORLD.record})
    --observer <name>       you watch: log in under that name and the foreman puts you, in
                            spectator, wherever it puts the crew  (default: ${WORLD.observer || 'nobody'})
    --machine-hour 00:00-01:00|off   the hour a day the computer does its own upkeep; a run
                            stops for it and carries on after  (default: ${WORLD.machineHour})
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
              enable-rcon=true        the crew is brought to you through the server console
              rcon.password=<random>  a new one every start
          When you stop Auren, it stops the server too and waits for it to save.
  remote: the foreman joins the world at host:port. It never starts or stops it.

  If anything fails, the foreman says what and where to change it.

  What happens:
    A foreman joins your world. A homesteader or builder crew it raises by
    itself: it finds open ground away from world spawn, sites the base, and
    brings the crew there. A contractor crew is yours to ask for: walk to where
    you want them and ask in chat:

      foreman get contractor    a crew of 2 that works for YOU and hears you
      foreman get homesteader   a crew of 2 that answers to nobody and builds
      foreman help              the words it knows
      foreman stop              send your contractors home

    Either way the crew is brought to where you are standing, and starts
    working when it arrives. Contractors take orders: say a bot's name and
    then what you want. Homesteaders have no ear at all — talking to one does
    nothing, by design.

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

for (let i = 0; i < argv.length; i++) {
  const raw = argv[i];
  if (raw === '--help' || raw === '-h') { usage(); process.exit(0); }
  if (!raw.startsWith('--')) die(`'${raw}' is not an option. Options start with --, and only 'test <what> <crew>' may come first. Try --help.`);
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
  test: 'AUREN_TEST', observer: 'AUREN_OBSERVER', 'builder-count': 'AUREN_BUILDER_COUNT',
  clock: 'AUREN_CLOCK', record: 'AUREN_RECORD', 'machine-hour': 'AUREN_MACHINE_HOUR', watch: 'AUREN_WATCH', wake: 'AUREN_WAKE',
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

// The foreman (`foreman/foreman_world.js`) owns proving the world — starting a local server or reaching
// a remote one, and saying why when it cannot. This file sweeps the records and raises the foreman.
(async () => {
  takeRunLock();
  // A ROLLBACK START IS THE ONE THING THAT EMPTIES fleet_logs/ (STANDING): swept here, since this is the one
  // door that starts a whole fleet before any bot exists. Every writer appends (watcher.js, crew_launch.js)
  // and none clears. A launcher that already swept for its own rollback passes `--records keep`.
  const records = given.records || 'sweep';
  if (records !== 'sweep' && records !== 'keep') {
    die(`'--records ${records}' is not a choice. Use 'sweep' (empty fleet_logs/ first) or 'keep' (your launcher already did).`);
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
    console.log(`\n  fleet_logs/ left as it is — the launcher that started this desk already swept it.`);
  }

  const where = process.env.AUREN_SERVER_WHERE || WORLD.where;
  const joins = `joins the world at ${process.env.AUREN_SERVER_HOST || WORLD.host}:${process.env.AUREN_SERVER_PORT || WORLD.port}`;
  // The crew as this run will have it: a flag set above wins over the page, which was read before the flags.
  const crew = process.env.AUREN_CREW || WORLD.crew;
  console.log(`\n  Auren — the foreman is starting, and it ${where === 'local' ? 'starts your server first' : joins}.`
    + (crew === 'contractor'
      ? `\n  when the foreman has joined, walk where you want your bots and type:`
        + `\n      foreman get contractor     works for you`
      : `\n  then it finds open ground, sites the base and brings in a ${crew} crew by itself.`)
    + `\n  Ctrl-C stops everything${where === 'local' ? ', and the foreman stops the server and waits for it to save' : ''}\n`);

  // The hub opens inside the foreman before its world and its body (foreman.js requires it first); the
  // desk names its own record `foreman` instead of inheriting a bot's name. DEP0040 (Node's built-in
  // `punycode` deprecation, raised by a library below mineflayer) is silenced by name via NODE_OPTIONS,
  // which the foreman and every bot it spawns inherit; every other warning still prints.
  const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=DEP0040'].filter(Boolean).join(' ');

  // ── THE MACHINE'S HOUR ──────────────────────────────────────────────────────────────────────────
  // One hour a day belongs to the computer (`foreman/utils/machine_hour.js`). The machine is made to keep
  // it before anything is raised; a machine that cannot be made to is a start that does not happen.
  const machineHour = require('./foreman/utils/machine_hour');
  const hourSetting = process.env.AUREN_MACHINE_HOUR || WORLD.machineHour;
  const hour = machineHour.ensure(hourSetting);
  if (!hour.ok) die(`THE MACHINE'S HOUR COULD NOT BE SET UP — nothing was started.\n  ${hour.why}`);
  console.log(`  ${hour.why}.`);

  raise();

  function raise() {
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
  }, () => {
    // The foreman left a note on its way out when the machine's hour opened: the run is not over. This
    // door waits the hour out and raises the foreman again as a continue start with the soak that was left.
    const note = machineHour.takeNote();
    if (!note) return false;
    const closes = new Date(note.closes_at);
    const wait = Math.max(0, closes.getTime() - Date.now());
    console.log(`\n  THE MACHINE'S HOUR — the run stopped for it and carries on at ${machineHour.clock(closes)}`
      + ` (${Math.round(wait / 60000)} min). The computer is doing its own upkeep. Ctrl-C ends the run here.\n`);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.once(sig, () => process.exit(0));
    setTimeout(() => {
      // The segment that just ended wrote its verdict; the one starting writes its own, and a foreman
      // that dies without one is told apart by the file being absent.
      fs.rmSync(outcomeFile(), { force: true });
      process.env.AUREN_START = 'continue';
      process.env.AUREN_SOAK = String(note.soak_left_min);
      console.log(`\n  the machine's hour is over — the foreman is starting again, and the crew carries on where it stopped.\n`);
      raise();
    }, wait);
    return true;
  });
  }
})();
