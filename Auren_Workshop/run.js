// module: run
// purpose: THE ONE SCRIPT. Reads `run_config.js`'s `run` block once, then performs the whole run without
//          being driven. **It joins a world that is already running.**
//
//     1. start your Minecraft server
//     2. . .\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\run.js
//
// There are no flags. Everything a run can be told is on the page next door, which is the point
// (Architect 2026-09-10: *"you make all the configurations before you start anything on one page then
// you click the same runscript and it runs according to the configure"*). A flag here would be a second
// place to say the same thing, and the two would disagree the first time somebody used both (Law 16).
//
// ── IT DOES NOT START, STOP OR ROLL BACK A WORLD, AND THAT IS ITS DEFINITION (Architect 2026-09-11) ───
// *"i have a script that autostarts the server, then when its the bots turn to connect its a seperate
// piece that only cares if the server is there not if the script runs correctly? so law 1. isolated verb.
// my script autostarts server then foreman check to see if the server is there not if i started it with
// the script. this is so a stranger can use it. i want an architect and a user start to be identical."*
//
// This file asks the world exactly ONE question — **are you there** — and gets its answer from the world,
// by dialling the address in `Auren_Bot/your_server.js` and speaking to it. It never asks, and cannot
// find out, who started that world. A stranger starts theirs by hand; `host_and_run.js` starts his in the
// same pass and then runs THIS FILE as a child process. Both arrive here identical, because the thing
// that differs happened outside and left no trace in the config this file reads (Law 1, decoupled).
//
// WHAT THIS REPLACED IS THE SHAPE, NOT A FEATURE. A `server: 'local' | 'already-up' | 'auto'` field stood
// on the config page and this file branched on it — minting a console password, stopping a JVM, restoring
// a snapshot, starting a JVM, and stopping it again at teardown. Every one of those needs the server
// FOLDER, which only a host has, so the branch meant the Architect's run and a stranger's run were two
// different sequences through one file and only one of them was ever exercised here. All of it moved to
// `host_and_run.js`, whole, and none of it was rewritten on the way (`fleet_control`'s `server-start`,
// `server-stop` and `snapshot-restore` were already the isolated verbs — what was missing was a caller
// that was not this one).
//
// ── WHAT THIS REPLACED, AND WHY IT IS LESS CODE RATHER THAN MORE ─────────────────────────────────────
// Nine named tests, two conductors and three PowerShell launchers, all of which started a fleet. Each
// froze one combination of the settings now on `run_config.js`, and each had its own bring-up order —
// which meant three separate answers to "does the world get restored before or after the bots come
// down", and the wrong one was only ever found by a run going strange. This file is one order.
//
// ── THE BOTS ARRIVE THE WAY A STRANGER'S BOTS ARRIVE, AND THERE IS NO OTHER DOOR ─────────────────────
// *"i dont want to test in a way that a public user wont be using."*
// The old launchers ran `start_bot.js` directly and handed it a mandate. Nobody who downloads this can
// do that — they get `start_auren.js`, which raises a desk and a referee and NO bots, and then they
// stand in the world and ask. So this script does exactly that, on his behalf: it clears what the bots
// know, starts the tree as a stranger's shell would, seats a player, and has that PLAYER type `foreman
// get`. If the desk refuses, the run has failed — there is no privileged path to fall back to.
//
// ── THE OVERLAYS ARE LAID ON, NOT BRANCHED INTO ──────────────────────────────────────────────────────
// *"overlayed on top of it are the record and watch test."* Filming and watching are switches read out
// of the config at the two moments they apply — cameras before the crew is hired so they see the first
// thought, the watch after placement is confirmed. The run underneath is identical either way, which is
// what makes a filmed run and a plain run comparable evidence.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────────────────────────────
// It does not publish. That workflow is spoken, not coded (Architect 2026-09-10: *"its not a
// deterministic process… so the workflow is verbal not coded"*), so the run ENDS by saying whether the
// build is postable and leaves the posting to him. A gate that published on a green run was measuring
// one feature and certifying the whole tree, and no two runs test the same thing.

'use strict';
require('../js_kernel/utils/developer_door').enter('Auren_Workshop/run.js');

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const paths = require('./workshop_paths');
paths.registerAliases();
const rcon = require(paths.bot('js_kernel/utils/rcon_link'));
// `workstation` (which Java, which server FOLDER) is deliberately NOT required here any more: this script
// never touches a server folder, so having the resolver in scope would be an invitation to start.
// The one owner of "open a visible console window" — this runner's children are watched through it.
const consoleWindow = require(paths.bot('js_kernel/utils/console_window'));

// ONLY THE `run` BLOCK. The page's other block, `hosting`, belongs to `host_and_run.js` and this file
// does not read it, validate it, or know what is in it — which is what makes the two verbs separable
// rather than merely separated (Law 1). Destructured here so there is no `CONFIG.hosting` in scope to
// reach for by accident.
const { run: CONFIG } = require('./run_config');

// ── THE CONFIG IS PROVED WHOLE BEFORE ANYTHING IS TOUCHED (Law 13) ──────────────────────────────────
// Every field is checked against the values it permits, and an unknown field is an error rather than
// something ignored — a typo in a key would otherwise read as "left at its default" and the run would
// quietly not be the run that was asked for. Nothing below this block can be reached by a config that
// does not make sense, which is why none of the phases carry their own validation.
const PERMITTED = {
  memory:   ['clear', 'keep'],
  clock:    ['dawn', 'day', 'held'],
  crew:     ['homesteader', 'contractor'],
  record:   ['off', 'cameras', 'film'],
  teardown: ['down', 'leave-up'],
};
const WAKE_SIGS = ['error', 'halt', 'death'];
const SHAPE = {
  memory: 'enum', clock: 'enum', person: 'string',
  standing: 'string', crew: 'enum', soak: 'number', watch: 'boolean', wake: 'list',
  stream: 'list', record: 'enum', teardown: 'enum',
  // ── FIVE KEYS STOOD HERE AND ARE GONE, EACH FOR ITS OWN REASON. They are absent on purpose: the
  // validator refuses any key it does not name, so a page still carrying one is REPORTED by name rather
  // than read and silently ignored, which is the failure a move like this otherwise causes.
  //   `server`                 — the whole question of who starts the world. Moved to `host_and_run.js`,
  //                              where it is not a question at all: that script is the host (2026-09-11).
  //   `world` `snapshot`       — rolling a world back needs the server folder and the server stopped.
  //   `worldName`                Now `hosting.world` / `.snapshot` / `.worldName`, same page, other block.
  //                              What `world: 'fresh'` also did — wiping the bots' notes — stayed here
  //                              and is now `memory: 'clear'`, which anybody can do.
  //   `host` `port` `rconPort` — in `Auren_Bot/your_server.js`, the one page a downloader edits and the
  //                              one answer the bots, the foreman, the camera rig and the seed scanner
  //                              all read. This script is only one of that file's readers (Law 16).
  //   `rconPassword`           — same file, or `AUREN_RCON_PASSWORD`. A hosted run is handed a freshly
  //                              minted one through the environment and never sees it on any page.
};

// WHERE THE WORLD IS — read from the one page a downloader edits, never restated here (Law 16).
const WORLD = require(paths.bot('your_server.js'));
const NAME_OK = /^[A-Za-z0-9_]{3,16}$/;
const COORDS_OK = /^-?\d+\s+-?\d+\s+-?\d+$/;

function refuse(lines) {
  console.error(`\n  run: NOTHING WAS STARTED — Auren_Workshop/run_config.js's 'run' block does not make sense yet.\n`);
  for (const l of lines) console.error(`    ${l}`);
  console.error(`\n  Fix the page and run the same command again.\n`);
  process.exit(1);
}

function validate(c) {
  const wrong = [];
  for (const key of Object.keys(c)) {
    if (!SHAPE[key]) wrong.push(`'${key}' is not a setting. Settings: ${Object.keys(SHAPE).join(', ')}`);
  }
  for (const [key, kind] of Object.entries(SHAPE)) {
    if (!(key in c)) { wrong.push(`'${key}' is missing, and there is no default for it.`); continue; }
    const v = c[key];
    if (kind === 'enum' && !PERMITTED[key].includes(v)) {
      wrong.push(`${key}: '${v}' is not one of ${PERMITTED[key].map(x => `'${x}'`).join(' | ')}`);
    }
    if (kind === 'string' && typeof v !== 'string') wrong.push(`${key} must be text, and is ${typeof v}`);
    if (kind === 'number' && (typeof v !== 'number' || !isFinite(v))) wrong.push(`${key} must be a number, and is '${v}'`);
    if (kind === 'boolean' && typeof v !== 'boolean') wrong.push(`${key} must be true or false, and is '${v}'`);
    if (kind === 'list' && !Array.isArray(v)) wrong.push(`${key} must be a list in [ ], and is '${v}'`);
  }
  if (Array.isArray(c.wake)) {
    for (const w of c.wake) {
      if (!WAKE_SIGS.includes(w)) wrong.push(`wake: '${w}' is not wake-worthy. Only ${WAKE_SIGS.join(', ')} can wake a watch.`);
    }
  }
  if (typeof c.person === 'string' && !NAME_OK.test(c.person)) {
    wrong.push(`person: '${c.person}' is not a Minecraft name (3-16 letters, numbers or _)`);
  }
  // 'biome' joins 'spawn' and a literal cell as the third permitted value — the proxy resolves it with
  // the fleet's own biome scanner, and it is passed through untouched by the same line that passes a
  // cell (`--stand=`). Listed here because an unknown `standing` is an error rather than a default.
  if (typeof c.standing === 'string' && c.standing !== 'spawn' && c.standing !== 'biome'
      && !COORDS_OK.test(c.standing)) {
    wrong.push(`standing: '${c.standing}' is not 'biome', not 'spawn', and not three whole numbers like '72 63 -116'`);
  }
  if (typeof c.soak === 'number' && c.soak <= 0) wrong.push(`soak: ${c.soak} minutes is not a run`);

  // THERE ARE NO CROSS-FIELD RULES LEFT, and their absence is the shape of the change rather than a gap
  // (2026-09-11). The only one this file ever had was "a fresh world cannot be rolled back under a running
  // server" — a fact about who owns the server folder, which is now a fact about `host_and_run.js` and is
  // checked there, before it stops anything. Every field above is independent of every other, which is
  // what a page belonging to ONE verb looks like.
  if (wrong.length) refuse(wrong);
}
validate(CONFIG);

// ── THE ONE THING THIS SCRIPT NEEDS FROM THE WORLD, AND THE ONLY WAY IT CAN GET IT ──────────────────
// A crew is placed beside a person through the server's console (RCON), so a console this script cannot
// reach is a run it cannot do. `WORLD` is `Auren_Bot/your_server.js`, which reads the environment first
// and its own values second — so a hosted run, which mints a password and exports it before spawning this
// file, arrives here through the SAME two lines a stranger's typed-in password does. There is no branch
// for who set it, because there is nothing in either case to branch on.
//
// A BLANK PASSWORD IS NOT A BLANK FIELD, and Minecraft rather than this file settles that: with
// `rcon.password=` empty in server.properties the server answers
//     [Server thread/WARN]: No rcon password set in server.properties, rcon disabled!
// and never opens the port at all. So a blank one removes the console rather than the password, which is
// why it is refused here by name instead of tried and failed on later (Law 13).
const CREDS = { port: WORLD.rconPort, password: WORLD.rconPassword };
if (!CREDS.password) {
  refuse([`No console password has been given for the world at ${WORLD.host}:${WORLD.port}.`,
          `  A crew cannot be placed beside a person without that world's console, so the run stops`,
          `  rather than guessing at it.`,
          ``,
          `  THE SPOT TO CHANGE:  Auren_Bot/your_server.js   ->   rconPassword`,
          `  (or set AUREN_RCON_PASSWORD, which wins over that file.) It must match rcon.password in`,
          `  your server.properties, and that server needs enable-rcon=true.`,
          ``,
          `  If this machine HOSTS the world, run Auren_Workshop/host_and_run.js instead — it starts the`,
          `  server, mints a password for it and hands it to this script, and there is nothing to type.`]);
}
const EXTRACT = paths.bot();     // the tree this file lives in — see clearMemory's header for why there is no copy
const TRACE = path.join(EXTRACT, 'fleet_logs', 'traces', 'watcher_overseer.jsonl');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = m => console.log(`  ${m}`);
let phaseNo = 0;
const phase = m => { phaseNo++; const t = `${phaseNo}. ${m}`; console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 74 - t.length))}`); };

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  return ok;
}

// ── EVERY CHILD THIS SCRIPT RAISES, SO TEARDOWN CANNOT MISS ONE ─────────────────────────────────────
// Registered at spawn rather than tracked by name, because the failure this prevents is a crash between
// two launches leaving the first one orphaned in the world — and a list written by hand is exactly the
// list that goes stale when a phase is added.
const children = [];

// ── A CHILD'S OUTPUT GOES STRAIGHT TO A FILE, AND THIS IS NOT A CONVENIENCE ─────────────────────────
// It was `stdio: ['pipe','pipe','pipe']` with the bytes accumulated in a string by a `data` handler, and
// that arrangement STALLED THE DESK — the whole fleet with it — on every run.
//
// THE MEASUREMENT (2026-09-10, the run that finally named it). Phase 10 runs the watch with
// `spawnSync`, which BLOCKS this process for the entire soak; nothing here can drain a pipe for fifteen
// minutes. So the desk's pipe filled. Its console output last reached this runner at 20:25:17.867, it
// kept writing its own trace until 20:26:23.522 — sixty-six seconds later, proving the process was alive
// and only its stdout was backed up — and twelve seconds after that AurenBot's claim request timed out
// with nothing having answered it. Three runs died this way, twice as an unexplained `FLEET FROZEN`
// (the planning-token wait has no timeout, so a bot parks on it forever and its trace simply stops) and
// once, here, as the claim path's 10-second timeout finally throwing and naming itself.
//
// A FILE DESCRIPTOR CANNOT BACK UP. Handing the OS the fd removes this runner from the path entirely:
// there is no pipe, no reader to schedule, and no in-memory buffer that grows for the length of a soak.
// The record also exists DURING the run rather than being assembled at teardown, which is what a person
// watching a stuck run actually needs.
//
// STDIN STAYS A PIPE, because the person is typed to (`foreman get` is written to it). It is the one
// direction this runner genuinely drives.
//
// It lands in the fleet's own `fleet_logs/`, beside the traces, because it is one run's record and a
// start empties that folder whole (Architect 2026-08-31 — no record survives a run).
// AND A WINDOW TAILS THAT FILE, because the descriptor is what made the run READABLE and it is also what
// made it INVISIBLE (Architect 2026-09-10: *"why doesent any terminal run? im at home looking at the
// dedicated computer and nothing runs so i cant see whats going on and help at all. every terminal always
// needs to be visible."*). He was right about the symptom and the cause is above: a redirected stdout is
// not on a console, so this runner's children — the desk, and the person — had no window at all.
//
// THE TWO REQUIREMENTS CONFLICT AT THE OS AND THE FOLLOWER IS THE ONLY SHAPE THAT SERVES BOTH. A child's
// stdout goes either to a console somebody can see or to a descriptor this process can read; teeing
// through a pipe would buy both and cost interactive stdin, which is the one direction this runner
// genuinely drives, and which is also the exact mechanism documented above as the cause of three dead
// soaks. A second READER of the file costs the run nothing: it cannot back a pipe up, it cannot touch
// stdin, and closing the window stops nothing.
function launch(label, file, args, cwd) {
  const dir = path.join(EXTRACT, 'fleet_logs');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `console_${label.replace(/[^A-Za-z0-9_-]/g, '_')}.log`);
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(file, args, { cwd, env: strangerEnv(), stdio: ['pipe', fd, fd] });
  // Closed HERE rather than kept: the child holds its own duplicate of the descriptor, so this copy has
  // no further use and leaving it open would leak one per launch.
  fs.closeSync(fd);
  // Opened AFTER the file exists, so the follower never starts on a missing path. It is a view and never
  // a gate: a window that failed to open reports itself and the run carries on (Law 25).
  const window = consoleWindow.followFile({ title: `auren ${label}`, logFile });
  const handle = {
    label, child, logFile, window,
    // Read from disk on demand. A caller asking what a child said gets what is on the file NOW, which is
    // the point — the old `read()` returned whatever this process had managed to buffer.
    read: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''),
  };
  children.push(handle);
  if (window) say(`${label}'s console is open in its own window (pid ${window.pid})`);
  return handle;
}

// THE ENVIRONMENT A STRANGER HAS. Every AUREN_/BOT_/OVERSEER_ variable this machine exports is stripped
// before the fleet is launched: leaving them lets the run inherit his own configuration and certify a
// build that works on one box in the world. The rcon password is handed back in as a FLAG, because
// typing it is what somebody else would do.
function strangerEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(AUREN_|BOT_|OVERSEER)/.test(k) || k === 'NODE_PATH') delete env[k];
  }
  return env;
}

function fleetControl(args) {
  const r = spawnSync(process.execPath, [paths.workshop('fleet_control.js'), ...args],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  return r.status === 0;
}

// ── THE SERVER'S OWN ACCOUNT OF WHO IS IN THE WORLD ─────────────────────────────────────────────────
// The only roster not written by the thing under test. Parsed by form, and null on a reply shape it does
// not recognise rather than guessing at one (Law 26).
const LIST_REPLY = /players online:\s*(.*)$/;
async function playersOnline() {
  const [reply] = await rcon.once(['list'], { creds: CREDS });
  const m = LIST_REPLY.exec((reply && reply.body) || '');
  if (!m) return null;
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}
async function waitForPlayer(name, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const who = await playersOnline();
    if (who && who.includes(name)) return true;
    await sleep(1500);
  }
  return false;
}

// ── WAITING FOR A BODY TO STOP MOVING, MEASURED OFF THE SERVER ──────────────────────────────────────
// "Is it done placing itself?" has no event to subscribe to from out here, so it is answered the way the
// world answers it: the same cell twice in a row, with a floor on how long that has to hold. The proxy's
// own placement is a teleport followed by a ground test that may teleport again, so a single matching
// pair taken too early would pass between the two.
//
// Bounded and non-fatal: a body that never settles is REPORTED and the run continues against wherever it
// is, because a person standing in a river is a legitimate thing to test and the desk's own refusal is
// the honest outcome (Law 25). Returning the verdict rather than acting on it keeps that decision at the
// call site.
//
// STILL IS NOT SETTLED WHILE THE BODY HAS NOT LEFT (measured 2026-09-11). The proxy waits up to 20s for
// the survey area's chunks before it moves at all, and that wait is perfectly still — three matching
// polls passed at 10:48:14, seven seconds after `architect` logged in at (1.5,74,-9.5), and the run
// measured a body that had not started moving. So a caller hands in `settled(at)` — where the body has
// to BE — and a position that fails it does not count toward stillness. 90s covers the proxy's slowest
// honest path: survey wait 20s + /tp 2s + eight step-out moves at 2s + chunk wait 8s + /tp 2s ≈ 50s.
const PERSON_SETTLE_MS = 90000;
const STILL_POLL_MS = 1000;
const STILL_CONSECUTIVE = 3;
async function waitForStillness(name, timeoutMs, settled = () => true) {
  let last = null;
  let same = 0;
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    const at = await rcon.entityPos(name, { creds: CREDS });
    const key = at && settled(at) ? `${Math.floor(at.x)}|${Math.floor(at.y)}|${Math.floor(at.z)}` : null;
    if (key && key === last) {
      if (++same >= STILL_CONSECUTIVE) {
        say(`${name} has stopped moving at (${key.split('|').join(',')}) — that is the cell the crew is fetched to`);
        return true;
      }
    } else {
      same = key ? 1 : 0;
    }
    last = key;
    await sleep(STILL_POLL_MS);
  }
  say(`${name} had not come to rest where it has to be after ${timeoutMs / 1000}s — the placement checks `
    + `below measure where it actually is`);
  return false;
}


// ── THERE IS NO DOWNLOAD ANY MORE, AND ITS ABSENCE IS THE POINT (Architect 2026-09-10) ──────────────
// *"theres 2 way of running the bot and i only want one. every time i try to do more than one i have
// these issues... i should just ship the whole thing as one piece."*
//
// A 98-line `buildDownload()` stood here. It copied every tracked file under `Auren_Bot/` to a sibling
// directory OUTSIDE the repository, carried `node_modules` across, and ran the copy — because the
// workshop was not in the shipped set, so this file could not test the tree it lived in.
//
// THE WORKSHOP NOW LIVES INSIDE THE BOT, so the tree this file lives in IS the shipped tree and the copy
// has nothing left to prove. Three faults went with it, and every one of them had already cost a run:
//
//   1. `git ls-files` names the INDEX while the bytes were copied from the WORKING TREE. Those disagree
//      for exactly as long as any change is uncommitted, which is every turn — `session_sync` runs last.
//      A deletion crashed the build with ENOENT after the world had already been rolled back and the
//      server restarted; nineteen untracked files were silently omitted the other way.
//   2. TWO COPIES OF EVERY RECORD meant two answers to "what is happening", which is what produced the
//      false `FLEET FROZEN — 5708s` over a fleet that was working perfectly.
//   3. The copy handed its console back down a PIPE, and that pipe stalled the desk on three consecutive
//      runs — see `launch()` above and `architect_bugsquashing.md` §9.
//
// None of the three was a bug in the bot. All three were the boundary's overhead, paid every run.
//
// THE COPY WAS SILENTLY PROVIDING TWO GUARANTEES, AND BOTH ARE NOW STATED OUTRIGHT. Neither was written
// down as a job of `buildDownload`; both were side effects of building somewhere empty, which is why
// deleting it took them with it. One was caught when the copy was deleted, the other cost a run first.
//
//   1. NOTHING SHIPPED DEPENDS ON ANYTHING PRIVATE. A private require would have failed as
//      MODULE_NOT_FOUND inside the download. Now a `preflight` pass states it, runs after every change
//      instead of once per run, and names the file and the line.
//   2. THE RECORDS ROOM STARTS EMPTY. `fleet_logs/` is gitignored, so the copy had none — which is the
//      standing rule *"no record survives a run"* being satisfied by accident. Running in place, twenty
//      four trace files from four different days accumulated, the lens read a bench's `ProbeBot` error
//      from a different hour, and this file scored the run FAIL on it. Now `clearRecords()` below sweeps
//      the room by name, every run, and says what it removed.
function clearRecords() {
  phase('the records room');
  // NOT GATED ON `memory`, and that separation is the point (Law 29). `memory: 'keep'` carries what the
  // bots KNOW; records are EXHAUST that nothing running reads. A run that inherited the last run's trace
  // would make every lens answer about two runs at once, which is the one thing the rule forbids.
  const { sweepRecords, RECORDS_DIR } = require(paths.bot('js_kernel', 'utils', 'record_homes'));
  const swept = sweepRecords();
  if (!swept.swept) return say(`nothing to clear — no ${path.basename(RECORDS_DIR)}/ yet, the first writer makes it`);
  say(swept.entries.length
    ? `every record here belongs to THIS run — removed ${swept.entries.length} leftover: ${swept.entries.join(', ')}`
    : 'the records room was already empty');
}
//
// WHAT THE BOTS KNOW is cleared in place rather than sidestepped by building somewhere empty.
// `corporate_headquarters.<bot>.json` and `player_memory/` are untracked runtime state, and both halves of
// what a bot knows — the shared record of the base, and its own private notes — move together, which is
// why `memory` is ONE field covering both rather than two that could disagree.
//
// IT IS A RUN SETTING AND NOT A HOSTING ONE (2026-09-11). This used to be the second half of
// `world: 'fresh'`, which also rolled the server's world folder back — fusing something anybody can do
// (delete the bots' own files, inside the bot) with something only a host can (restore a snapshot, with
// the server stopped). Pair `memory: 'clear'` with `hosting.world: 'fresh'` for the old baseline; the
// point of the split is that a stranger can have the first without needing the second.
function clearMemory() {
  phase('the bots\' own memory');
  if (CONFIG.memory === 'keep') {
    return say('carried forward — memory: \'keep\', so what the bots know survives this run');
  }
  const kernel = path.join(EXTRACT, 'js_kernel');
  let wiped = 0;
  if (fs.existsSync(kernel)) {
    for (const f of fs.readdirSync(kernel)) {
      if (/^corporate_headquarters\..*\.json$/.test(f)) { fs.rmSync(path.join(kernel, f)); wiped++; }
    }
  }
  const memory = path.join(EXTRACT, 'player_memory');
  const hadMemory = fs.existsSync(memory);
  if (hadMemory) fs.rmSync(memory, { recursive: true, force: true });
  say(`the bots start with no memory at all — ${wiped} headquarters file(s)`
    + `${hadMemory ? ' and player_memory/' : ''} removed`);
}

// INSTALL THE WAY THE README SAYS TO, and skip only under the one condition that provably makes the
// installed tree the right one: the lockfile has not moved since it was installed. The marker lives
// inside the tree it describes so it cannot outlive it.
function install() {
  phase('npm install');
  const lock = path.join(EXTRACT, 'package-lock.json');
  const marker = path.join(EXTRACT, 'node_modules', '.run_lock');
  const stamp = fs.existsSync(lock) ? `${fs.readFileSync(lock, 'utf8').length}:${fs.statSync(lock).size}` : 'none';
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) {
    return check('npm install', true, 'skipped — the lockfile has not moved since this tree was installed');
  }
  // npm's JS ENTRY POINT, RUN BY THIS NODE — not `npm.cmd`. Node 20+ refuses to execFile a Windows
  // `.cmd` without a shell, and reaching for `shell: true` would put every argument through cmd.exe
  // quoting for no benefit. This also guarantees the install uses the node already running.
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error(`no npm beside this node — looked for ${cli}`);
  const out = execFileSync(process.execPath, [cli, 'install', '--no-fund', '--no-audit'],
    { cwd: EXTRACT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: strangerEnv() });
  fs.writeFileSync(marker, stamp, 'utf8');
  return check('npm install', true, out.split('\n').filter(Boolean).slice(-1)[0] || 'installed');
}

// ── WHAT THE STRANGER WOULD HAVE SEEN ON THEIR OWN TERMINAL ─────────────────────────────────────────
// Each child's stdout and stderr are on disk from its first byte — `launch()` hands the OS a file
// descriptor rather than a pipe, for the reason written there. This only has to SAY where they are.
//
// Until 2026-09-10 the bytes were buffered in memory and dropped at teardown, and that cost a whole
// turn: a 15-minute run died at 3m 36s with both bots parked on `Requested planning token.` forever, the
// bots' traces proved the request was sent and never answered, and the answer to WHY was in the buffer
// this runner had thrown away. Keeping them was the first fix; the second was discovering that the
// buffering itself was the CAUSE.
function keepConsoles() {
  for (const c of children) {
    if (!fs.existsSync(c.logFile)) continue;
    const lines = fs.readFileSync(c.logFile, 'utf8').split('\n').filter(Boolean).length;
    say(`${c.label}'s console — ${lines} line(s) at ${path.relative(EXTRACT, c.logFile)}`);
  }
}

// The tail of a console, for the verdict block. A FAIL is exactly when somebody wants these lines and
// exactly when they are least likely to go looking in a folder the next run will empty.
function consoleTail(label, lines) {
  const c = children.find(h => h.label === label);
  if (!c) return null;
  const all = c.read().split('\n').filter(Boolean);
  return all.length ? all.slice(-lines) : null;
}

function teardown(why) {
  if (CONFIG.teardown === 'leave-up') {
    console.log(`\n  teardown: 'leave-up' — the desk, the crew and the person are STILL IN THE WORLD.`);
    console.log(`  Their console windows are open and still following — read them there.`);
    console.log(`  They are yours to reap:  node Auren_Workshop/fleet_control.js down\n`);
    return;
  }
  console.log(`\n  taking it down (${why})`);
  if (CONFIG.record !== 'off') {
    const overlay = require('./tools/record_overlay.js');
    overlay.reap('the run ended');
  }
  keepConsoles();
  for (const c of children.slice().reverse()) {
    if (c.child.exitCode === null) { try { c.child.kill(); } catch (_) { /* already gone */ } }
    // The window goes with the process it was watching. Left open it would sit on a file the next run
    // empties whole (Architect 2026-08-31 — no record survives a run), showing a run that is over as
    // though it were live. `leave-up` returns above and keeps its windows, which is the whole point of
    // that mode.
    if (c.window) consoleWindow.closeWindow(c.window.pid);
  }
  // THE WORLD IS LEFT RUNNING, ALWAYS. This script did not start it and has no business ending it —
  // whoever did owns that, and on a hosted run that is `host_and_run.js`, after this process returns.
  say('desk, crew and person are down. The world is left exactly as it was found: running.');
}

// ── THE RUN ─────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n══ run — ${CONFIG.crew} · ${CONFIG.soak} min · memory ${CONFIG.memory}`
    + `${CONFIG.watch ? ' · watched' : ''}${CONFIG.record !== 'off' ? ` · ${CONFIG.record}` : ''} ══`);
  say(`the fleet      ${EXTRACT}`);
  say(`the world      ${WORLD.host}:${WORLD.port}   (joined, not started)`);
  say(`the person     ${CONFIG.person}, standing at ${CONFIG.standing}`);

  // ── PREFLIGHT IS THE FIRST STEP, BEFORE ANYTHING JOINS (Architect 2026-08-10) ─────────────────────
  // The deleted conductors both ran this in their own preflight, and the reason is worth keeping: a load
  // fault found by the LIVE route surfaces ~40 seconds in — after a rollback, a JVM start and a bot
  // login — and it surfaces wearing the costume of a bot that will not come online. Here it costs
  // seconds and names the file. Gated: nothing is worth starting on a tree that does not load (Law 13).
  //
  // It reads the tree this run will actually start, which since 2026-09-10 is the only tree there is —
  // the workshop moved inside the bot and the run no longer builds a copy of anything.
  phase('preflight — does the tree load at all');
  if (spawnSync(process.execPath, [paths.workshop('tools', 'preflight.js')],
        { stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
    console.error(`\n  run: preflight failed, so NOTHING was started. No process was launched and nothing`);
    console.error(`  joined the world. Read its output above — it names the file.\n`);
    process.exit(1);
  }
  say('the tree loads');

  // ── IS THE SERVER THERE. THAT IS THE WHOLE QUESTION (Architect 2026-09-11, Law 1) ─────────────────
  // *"when its the bots turn to connect its a seperate piece that only cares if the server is there not
  // if the script runs correctly… foreman check to see if the server is there not if i started it with
  // the script."*
  //
  // The answer comes from the WORLD, by speaking to it — not from a flag, a lock file, a PID, or an exit
  // code handed down by whatever started it. That is what makes this script indifferent to who did: a
  // world started by hand ten minutes ago and one started by `host_and_run.js` four seconds ago are the
  // same fact at this line, and there is nothing here that could tell them apart even if it wanted to.
  //
  // ASKED FIRST, BEFORE ANYTHING IS SWEPT OR LAUNCHED, because everything after it needs the console and
  // the cheapest failure is the earliest one.
  //
  // THE ADDRESS IS ASSUMED, SO A WRONG ONE MUST SAY WHERE IT IS WRITTEN (*"so assume the server is there,
  // if not crash and report pointing to the spot where to change"*). Nothing here probes for a server,
  // scans a port range or falls back to a second address — the one in `your_server.js` is tried and that
  // is all. This is the only place that assumption can be wrong, so it is the place that names the file,
  // the fields, and what was actually attempted.
  phase('is the world there');
  const reach = await rcon.probe({ creds: CREDS });
  if (!reach.ok) {
    check('a server is up with rcon enabled', false, reach.reason);
    console.error(`\n  Nothing answered at ${WORLD.host}:${WORLD.port} (console port ${WORLD.rconPort}).`);
    console.error(`  This script does not start servers. Start your world, then run it again.`);
    console.error(``);
    console.error(`  THE SPOT TO CHANGE:  Auren_Bot/your_server.js`);
    const field = (name, value, why) => console.error(`      ${name.padEnd(13)}${String(value).padEnd(12)}<- ${why}`);
    field('host', WORLD.host, 'the computer the world runs on');
    field('port', WORLD.port, 'server-port in your server.properties');
    field('rconPort', WORLD.rconPort, 'rcon.port, and enable-rcon must be true');
    field('rconPassword', WORLD.rconPassword ? '(set)' : '(EMPTY)', 'must equal rcon.password there');
    console.error(``);
    console.error(`  If your server IS running with those numbers, it is the console that is off:`);
    console.error(`  set enable-rcon=true in server.properties and restart it.`);
    console.error(``);
    console.error(`  If this machine HOSTS the world, run Auren_Workshop/host_and_run.js — it starts the`);
    console.error(`  server first and then runs this exact script.\n`);
    return finish('the world could not be reached');
  }
  const before = (await playersOnline()) || [];
  check('a server is up with rcon enabled', true, `${before.length} player(s) already in the world`);

  // THE CLOCK IS A RUN INPUT, AUTHORED WHILE NOTHING IS RUNNING (Law 26). Not gated: a fleet on a dark
  // world is still a fleet running, so a clock that would not set is worth SEEING and never worth
  // aborting a run over (Law 13).
  if (CONFIG.clock !== 'held') {
    fleetControl(['clock', CONFIG.clock]);
    say(`clock: ${CONFIG.clock}`);
  }

  clearRecords();
  clearMemory();
  install();

  // ── THE DESK, FROM THE DOWNLOAD, IN A STRANGER'S SHELL ────────────────────────────────────────────
  phase('node start_auren.js  — the one door');
  // `--records keep` because STEP 4 ALREADY SWEPT, and reported the count as a check. Without it the
  // desk swept a second time, after this runner had created `console_desk.log` and handed over its
  // descriptor — deleting the desk's console out from under the open handle, silently, on every single
  // run.js-driven run. `start_auren.js`'s sweep site carries the mechanism.
  const deskArgs = ['start_auren.js', '--host', WORLD.host, '--port', String(WORLD.port),
    '--rcon-password', CREDS.password, '--rcon-port', String(WORLD.rconPort), '--records', 'keep'];
  const desk = launch('desk', process.execPath, deskArgs, EXTRACT);
  const deskUp = await waitForPlayer('Foreman', 60000);
  if (!check('the desk joined the world', deskUp,
    deskUp ? 'Foreman is in the server player list' : `no Foreman after 60s. It said: ${desk.read().slice(-400)}`)) {
    return finish('the desk never opened');
  }

  // ── THE PERSON. THIS IS HIS HAND, NOT AN OBSERVER ─────────────────────────────────────────────────
  phase(`bring ${CONFIG.person} into the world`);
  // The authored cell is handed to the proxy rather than applied from here — see the `standing` note
  // below for why this run cannot be the one that teleports the body.
  const personArgs = [paths.workshop('tools', 'proxy_human.js'), `--as=${CONFIG.person}`, '--quiet'];
  if (CONFIG.standing !== 'spawn') personArgs.push(`--stand=${CONFIG.standing}`);
  const person = launch('person', process.execPath, personArgs, paths.repo());
  const personUp = await waitForPlayer(CONFIG.person, 60000);
  if (!check(`${CONFIG.person} is standing in the world`, personUp,
    personUp ? 'in the server player list' : `did not join after 60s. It said: ${person.read().slice(-400)}`)) {
    return finish('the person never joined');
  }
  // ── THE PERSON IS OP'D SO THEY CAN PUT THEMSELVES ON GROUND A BODY CAN STAND ON ───────────────────
  // (Architect 2026-09-10): *"the architect needs to be teleported to a valid standing spot."*
  //
  // `proxy_human` does the placing, because it holds the client and can therefore both READ the ground
  // (`site_geometry.standingSpotNear` — the same test the desk now refuses on) and VERIFY the move. What
  // it cannot do is grant itself permission: `/tp` from a player prompt needs op, and `--as=<name>` is
  // this harness's invention rather than a name on the server's op list.
  //
  // So the op is granted HERE, by the only thing in the run that already has console access, and it is
  // granted BEFORE the placement can matter. A REAL person running this is already an op on their own
  // server — the proxy's default is to read its name off the ops list — so this restores the normal case
  // rather than creating a special one.
  await rcon.once([`op ${CONFIG.person}`], { creds: CREDS });

  // ── THE `standing` FIELD IS APPLIED BY THE PROXY, NOT FROM HERE (fixed 2026-09-10) ────────────────
  // This run used to teleport the person to `CONFIG.standing` itself, on this line, and the field was
  // silently thrown away every time. `waitForPlayer` returns the instant the name appears in the
  // server's player list, which is BEFORE the proxy's own 'spawn' handler has finished placing the body
  // on standable ground — so this teleport landed first and the proxy's landed second and won. The
  // symptom was a run that reported `standing at 10 64 4` in its own header and then hard-stopped on the
  // base layout at (-6,64,-6).
  //
  // One writer owns the body: the proxy. It receives `--stand=` above, puts the body there, and only
  // then runs its ground test from that cell — so the authored cell is both honoured and still checked.
  //
  // Waited for either way, because the seed cell of the whole run is whatever the proxy settles on.
  await sleep(4000);
  // ── THE PERSON IS ALLOWED TO FINISH MOVING FIRST (2026-09-10) ─────────────────────────────────────
  // `waitForPlayer` returns the instant the name appears in the server's player list, which is BEFORE
  // the proxy has placed itself. With `standing: 'biome'` that gap is now seconds long, not
  // milliseconds — the proxy waits for the survey area's chunks to stream in, surveys, then teleports.
  // Reading the position in that window and typing `foreman get` against it would fetch the crew to
  // where the person WAS, which is the same class of race the `--stand` handoff fixed inside the proxy
  // and the reason the desk's placement is measured rather than assumed.
  //
  // MEASURED OFF THE SERVER, not read out of the proxy's console. The server is the witness to where a
  // body is (Law 26); parsing the child's log for a "placed" line would make this gate depend on the
  // wording of a sentence written for a person.
  //
  // ── AND WHERE IT HAS TO COME TO REST IS CLEAR OF WORLD SPAWN (Architect 2026-09-11) ───────────────
  // *"you were supposed to have architect bot teleport away from world center before having it call
  // foreman get… it should be atleast 50 blocks away from world center"*. The proxy moves the body; this
  // is the witness that it did, measured off the server's position and the world's own level.dat (Law 26)
  // BEFORE the one command that raises a crew. Both runs of that afternoon fetched their crews to world
  // spawn, and the second spent its soak refused inside the protected square. The same distance is what
  // the stillness wait counts toward, so a body resting at spawn while the proxy surveys is not "settled".
  //
  // The spawn comes from fleet_control's `world-spawn` verb — `worldSpawn`, the one level.dat reader.
  const minFromSpawn = require(paths.bot('Thinking_fragments/architect_config.js')).PERSON_CLEAR_OF_SPAWN;
  const spawnReply = spawnSync(process.execPath, [paths.workshop('fleet_control.js'), 'world-spawn'], { encoding: 'utf8' });
  const spawnLine = (spawnReply.stdout || '').trim().split('\n').pop();
  const spawnAt = spawnReply.status === 0 && spawnLine ? JSON.parse(spawnLine) : null;
  if (!check('the world spawn is known', spawnAt !== null,
    spawnAt ? `(${spawnAt.x},${spawnAt.z})`
      : `it could not be read — ${(spawnReply.stderr || '').trim() || 'fleet_control world-spawn said nothing'}`)) {
    return finish('the world spawn could not be read, so the person\'s distance from it cannot be measured');
  }
  const fromSpawn = at => Math.max(Math.abs(at.x - spawnAt.x), Math.abs(at.z - spawnAt.z));
  await waitForStillness(CONFIG.person, PERSON_SETTLE_MS, at => fromSpawn(at) >= minFromSpawn);
  const personAt = await rcon.entityPos(CONFIG.person, { creds: CREDS });
  if (!check(`${CONFIG.person} has a position to be brought to`, !!personAt,
    personAt ? `(${personAt.x},${personAt.y},${personAt.z})` : 'the server reported no position')) {
    return finish('the person had no position');
  }
  // The proxy's own last lines ride along on a failure — they are the only place that says WHY it did
  // not move (no acceptable biome, no op, water under every aim), and without them this check names the
  // symptom and nothing else. Shown, never parsed: the verdict is the server's number.
  if (!check(`${CONFIG.person} stands at least ${minFromSpawn} blocks from world spawn`,
    fromSpawn(personAt) >= minFromSpawn,
    fromSpawn(personAt) >= minFromSpawn ? `${fromSpawn(personAt)} blocks from world spawn (${spawnAt.x},${spawnAt.z})`
      : `${fromSpawn(personAt)} blocks from world spawn (${spawnAt.x},${spawnAt.z}). It said: ${person.read().slice(-900)}`)) {
    return finish('the person was not moved clear of world spawn');
  }

  // ── THE CAMERAS GO UP BEFORE THE CREW, NOT AFTER ──────────────────────────────────────────────────
  // A recording that begins after the first thought is missing the only part nobody can reconstruct.
  // Gated: a run that was asked to be filmed and is not being filmed is not that run (Law 13).
  if (CONFIG.record !== 'off') {
    phase(`the ${CONFIG.record} overlay`);
    const overlay = require('./tools/record_overlay.js');
    // THE CONFIG'S WORDS AND THE OVERLAY'S WORDS ARE DIFFERENT ON PURPOSE, AND THIS IS THE SEAM.
    // `record_overlay` declares two overlays, `record` (cameras + OBS writing files) and `watch`
    // (cameras, nothing written). The config page cannot reuse `watch`, because `watch:` there already
    // means the wake-on-error TRACE watch — two unrelated things under one word on the page a person
    // edits is the expensive kind of collision. So the page says `film` / `cameras` and the
    // translation happens here, once, at the boundary between the two vocabularies.
    const r = overlay.raise({ overlay: CONFIG.record === 'film' ? 'record' : 'watch', count: 2, test: 'run' });
    if (!check(`the ${CONFIG.record} overlay came up`, !!(r && r.ok), (r && r.ok) ? 'cameras are watching an empty world' : `${r && r.why}`)) {
      return finish('the overlay did not come up, and a run that is not being filmed is not the run asked for');
    }
  }

  // ── THE ONE COMMAND THAT RAISES A CREW, TYPED BY THE PERSON ───────────────────────────────────────
  phase(`"foreman get ${CONFIG.crew}"  — typed by ${CONFIG.person}`);
  person.child.stdin.write(`foreman get ${CONFIG.crew}\n`);

  // The crew is whoever is in the world now who was not before. COUNTED, never named: the roster
  // belongs to the fleet, and a list of bot names written here goes stale the day the roster changes.
  const known = new Set([...before, 'Foreman', CONFIG.person]);
  let crew = [];
  for (const end = Date.now() + 150000; Date.now() < end;) {
    crew = ((await playersOnline()) || []).filter(n => !known.has(n));
    if (crew.length >= 2) break;
    await sleep(2500);
  }
  if (!check('a crew arrived', crew.length >= 2,
    crew.length ? `the server sees ${crew.join(', ')}` : `nobody new joined. The desk said: ${desk.read().slice(-500)}`)) {
    return finish('the desk did not raise a crew');
  }

  // ── WERE THEY PUT WHERE THE PERSON IS STANDING ────────────────────────────────────────────────────
  // Measured off the SERVER's entity data, not off anything the fleet reports about itself. This is the
  // check that would have caught the three runs that surveyed world spawn while the player stood 130
  // blocks away.
  //
  // ── WHAT THIS DISTANCE IS AND IS NOT (corrected 2026-09-10) ───────────────────────────────────────
  // It was a PASS/FAIL against 12 blocks and that was measuring the wrong thing. `get` returns after each
  // body has registered, placed itself, confirmed the placement and STARTED WORKING — so by the time this
  // line runs a bot may already have walked to a tree. On the run that exposed it, AurenBot read 14.0
  // blocks and was failed for it while TessaBot read 0.0 in the same world; nothing was wrong with either
  // teleport. The bot's own gate is 4 blocks (`body_recovery.PLAYER_ARRIVAL_TOLERANCE`) and it will not
  // begin work until it clears it, so a bot that is working is a bot that arrived — the two facts are
  // already one (Law 27), and a second, later, looser measurement of the same thing can only disagree
  // with it wrongly.
  //
  // So the distance is REPORTED, and the check is the fact that actually holds: the body confirmed its
  // own placement, which is the only version of this question with a witness (Law 26 — the process
  // holding the client is the one that can answer it). A body that could not be placed does not start,
  // and the desk's crew-short branch is what surfaces that.
  phase('placement, measured off the server');
  for (const name of crew) {
    const at = await rcon.entityPos(name, { creds: CREDS });
    const d = at ? Math.hypot(at.x - personAt.x, at.y - personAt.y, at.z - personAt.z) : null;
    check(`${name} confirmed it was placed beside ${CONFIG.person}`, at !== null,
      d === null
        ? 'no position from the server — the body is not in the world'
        : `it is in the world and working; ${d.toFixed(1)} blocks from ${CONFIG.person} at this moment `
          + `(NOT a placement test — it starts working the instant it arrives, so this drifts)`);
  }

  // ── THE SOAK, WATCHED OR BLIND ────────────────────────────────────────────────────────────────────
  // Watched, the lens owns the clock and ENDS the run when something wakes it, so a fault is read at the
  // moment it happens. Blind, the run sleeps out its window and the trace is read once at the end. The
  // wake list is his — `errors wake, warnings sleep` — and it is a config value rather than a constant
  // here because the criterion belongs to the asker (Law 25).
  phase(`letting the crew work for ${CONFIG.soak} min${CONFIG.watch ? ' — watched' : ''}`);
  // ── AND THE ONE WINDOW HE ACTUALLY READS IS OPENED WITH IT (Architect 2026-09-10) ─────────────────
  // *"i cant see whats going on and help at all"*, and 2026-09-03 already named the window that answers
  // it: *"can you place all the node powershells on one as well? i want a one stop shop to see all my
  // terminals and i want the overseer one to scroll like it is."* `fleet-console` is that window and this
  // one-button script never opened it, so the view existed and a run did not produce it.
  //
  // OPENED HERE, not at bring-up, because it follows `watcher_overseer.jsonl` and that file is written by
  // the fleet — before the crew has arrived there is nothing to tail. By this line the traces exist.
  //
  // It is a LENS rather than a raw console, which is why it is the right window to put in front of him
  // (Law 26, and CLAUDE.md's rule that a run record is read only through its lens). The per-process
  // windows carry raw stdout and remain the fallback when the question is about one body. Read-only, so
  // closing it stops nothing, and `down` already reaps it — it is in `FLEET_PROCESSES`.
  fleetControl(['fleet-console']);
  let woke = false;
  if (CONFIG.watch) {
    const args = [paths.bot('monitoring', 'trace_monitor.js'), TRACE, '--watch',
      `--max-minutes=${CONFIG.soak}`];
    if (CONFIG.wake.length) args.push(`--exit-on-flag=${CONFIG.wake.join(',')}`);
    if (CONFIG.stream.length) args.push(`--stream=${CONFIG.stream.join(',')}`);
    const started = Date.now();
    const w = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    woke = w.status !== 0;
    const ranMin = (Date.now() - started) / 60000;
    // A WAKE IS A FINDING, AND IT HAS TO REACH THE VERDICT (Law 25). This first read `woke` into the
    // closing sentence only, so a run whose watch fired ten seconds in still printed PASS with every
    // check green — because none of the checks were ABOUT the soak. The window not being served is the
    // most consequential thing such a run has to say, and a verdict that omits it is the run grading
    // itself on the questions it happens to have asked.
    check('the crew worked its window out', !woke,
      woke ? `the watch woke after ${ranMin.toFixed(1)} of ${CONFIG.soak} min and ended the run — read its ❌ line above`
           : `${CONFIG.soak} min served with nothing waking the watch`);
  } else {
    await sleep(CONFIG.soak * 60 * 1000);
  }

  // ── THE RUN IS JUDGED BY AN INSTRUMENT THIS SCRIPT DID NOT WRITE (Law 26) ─────────────────────────
  // `trace_monitor` decides what a fault is, so this file never enumerates fault types and a class the
  // lens learns next month is caught here with nobody editing this. The bar is ERROR-level lines: the
  // digest's exit code cannot serve, because it also returns non-zero for a warn burst, and the first
  // run of a fresh download is legitimately full of warnings (the loudest being that a bot's
  // headquarters file does not exist yet, which is the correct state of a bot that has never seen a
  // world). Gating on those would make a clean install permanently unreadable.
  phase('the lens reads the run record');
  if (!fs.existsSync(TRACE)) {
    check('the run record is clean (no errors)', false, 'no trace was written at all — nothing ran');
    return finish('nothing was recorded');
  }
  const errs = lens(['--level=error']);
  const n = errorLines(errs.out);
  // AN UNREADABLE ANSWER IS A FAILURE, NOT A PASS. If the lens stops stating its count, this must not
  // read that silence as "no errors" (Law 13 — prove it is safe to continue).
  check('the run record is clean (no errors)', n === 0,
    n === null ? `could not read a line count out of the lens — unproven: ${errs.out.slice(0, 200)}`
      : n === 0 ? 'the lens found no error-level lines'
      : `the lens found ${n} error line(s): ${firstProblem(errs.out)}`);
  const digest = lens([]);
  say(`for information, the full digest: ${digest.code === 0 ? 'clean' : firstProblem(digest.out)}`);

  return finish(woke ? 'the watch woke' : 'the window closed');
})().catch(e => {
  console.error(`\n  run stopped on an error it could not grade: ${e && e.message}`);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  teardown('an ungraded error');
  process.exit(1);
});

function lens(flags) {
  const r = spawnSync(process.execPath, [paths.bot('monitoring', 'trace_monitor.js'), TRACE, ...flags],
    { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
// How many lines the lens said it matched, read off its OWN header — and null when that sentence is not
// there, so an unrecognised answer is reported as unproven rather than rounded down to zero.
const LENS_COUNT = /·\s*([0-9]+)\s*line\(s\)/;
function errorLines(out) {
  const m = LENS_COUNT.exec(out || '');
  return m ? parseInt(m[1], 10) : null;
}
function firstProblem(out) {
  const line = (out || '').split('\n').find(l => /❌|⚠️/.test(l));
  return line ? line.trim().slice(0, 220) : 'nothing the lens would name';
}

// ── THE VERDICT, AND WHY IT ENDS IN A SENTENCE ABOUT PUBLISHING RATHER THAN A PUSH ──────────────────
// The run says whether the build a stranger would get worked, and then stops. Posting it is his call in
// conversation, because the thing being tested is different every time and a green run certifies the
// feature that was exercised, not the tree (Architect 2026-09-10: *"were never testing the same thing
// and errors will always be different. so the workflow is verbal not coded"*).
function finish(why) {
  const failed = checks.filter(c => !c.ok);
  console.log(`\n══ ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length - failed.length}/${checks.length} check(s) · ${why} ══`);
  for (const f of failed) say(`FAILED  ${f.name} — ${f.detail}`);
  // The desk's last words, in the verdict rather than in a folder the next run empties. Printed only on
  // a FAIL, because that is the one case where a fault may live OUTSIDE every bot's trace — the overseer
  // and the foreman run in the desk process, and a lens can only read what a watcher wrote.
  if (failed.length) {
    const tail = consoleTail('desk', 25);
    if (tail) {
      console.log(`\n  ── the desk's own console, last ${tail.length} line(s) ` + '─'.repeat(30));
      for (const l of tail) console.log(`     ${l}`);
    }
  }
  teardown(why);
  if (!failed.length) {
    console.log(`\n  This is the build a stranger would get, and it worked. If the feature you were`);
    console.log(`  testing is the one you wanted, it is postable — that is a call to make out loud,`);
    console.log(`  not something this script does.\n`);
  }
  process.exit(failed.length ? 2 : 0);
}
