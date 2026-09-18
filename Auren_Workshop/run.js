// module: run
// purpose: THE ONE SCRIPT. Reads `run_config.js`'s `run` block once, then performs the whole run without
//          being driven. **The foreman it starts brings the world** — starting a local server itself, or
//          joining a remote one — per `Auren_Bot/foreman_config.js` (2026-09-18, see the section below).
//
//     ..\Auren_Workshop\scripts\_node.ps1 ; $n = Get-AurenNode ; & $n Auren_Workshop\run.js
//
// There are no flags. Everything a run can be told is on the page next door, which is the point
// (Architect 2026-09-10: *"you make all the configurations before you start anything on one page then
// you click the same runscript and it runs according to the configure"*). A flag here would be a second
// place to say the same thing, and the two would disagree the first time somebody used both (Law 16).
//
// ── SUPERSEDED 2026-09-18: THE FOREMAN NOW STARTS AND STOPS THE WORLD ─────────────────────────────────
// *"Foreman starts first before the server… Who owns the process? Foreman does."* This script starts the
// foreman first and asks IT whether the world came up (`worldFromForeman`), and at teardown asks it to shut
// down. It still never starts a JVM or touches a server folder itself — the foreman does. The 2026-09-11
// ruling below is kept as the record of what this replaced; its one question is now asked of the foreman
// that owns the world rather than of the world directly.
//
// ── (2026-09-11) IT DOES NOT START, STOP OR ROLL BACK A WORLD, AND THAT IS ITS DEFINITION ───
// *"i have a script that autostarts the server, then when its the bots turn to connect its a seperate
// piece that only cares if the server is there not if the script runs correctly? so law 1. isolated verb.
// my script autostarts server then foreman check to see if the server is there not if i started it with
// the script. this is so a stranger can use it. i want an architect and a user start to be identical."*
//
// This file asks the world exactly ONE question — **are you there** — and gets its answer from the world,
// by dialling the address in `Auren_Bot/foreman_config.js` and speaking to it. It never asks, and cannot
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
// The run's own report of itself, stated at every exit path - see run_outcome.js.
const outcome = require('./run_outcome');
const RUN_STARTED_AT = new Date().toISOString();
// WHETHER THE WATCH FIRED, AND ON WHAT. Module scope because the SOAK learns it and the VERDICT states
// it, and those are two different functions. A fact discovered in one place and reported in another is
// exactly what a local hides: this was read into the closing sentence only, and a run whose watch fired
// ten seconds in still printed PASS with every check green.
let woke = false;
let wokeOn = null;

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
// WHAT CAN WAKE A WATCH, AND WHY THE LIST SHRANK (Architect 2026-09-16). These used to be
// `trace_monitor` SIGNATURE names, because the watch was a lens reading the trace file. The watch now
// asks the live fleet, so the list names facts THE FLEET STATES ABOUT ITSELF: `error` is the watcher's
// own error level, counted by the foreman as it arrives; `death` is job_board's own answer about
// whether there is a body, carried on the boardroom chair.
//
// `halt` IS GONE BECAUSE IT HAD ALREADY STOPPED WORKING, not because the watch changed. Its signature
// matched `HALTED for inspection after killing "…"`, and nothing in the fleet has written that line in
// a long time — recursive_judge writes `⏸️ <bot> PLANNER HALTED after killing "…"`, which that pattern
// does not match. It was a wake condition that could never fire, sitting in his config looking armed.
// Removing it is what makes the list true; the planner halt is still visible in the record afterwards,
// and if it should wake a run that is a fact for the fleet to state, the same way death now does.
const WAKE_SIGS = ['error', 'death'];
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
  //   `host` `port` `rconPort` — in `Auren_Bot/foreman_config.js`, the one page a downloader edits and the
  //                              one answer the bots, the foreman, the camera rig and the seed scanner
  //                              all read. This script is only one of that file's readers (Law 16).
  //   `rconPassword`           — same file, or `AUREN_RCON_PASSWORD`. A hosted run is handed a freshly
  //                              minted one through the environment and never sees it on any page.
};

// WHERE THE WORLD IS — read from the one page a downloader edits, never restated here (Law 16).
const WORLD = require(paths.bot('foreman_config.js'));
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
  // 'film' needs a recorder ON THIS MACHINE, which is a fact about the machine rather than the page, and it
  // is asked here so the answer arrives before the world is joined rather than after the crew is up. The
  // camera crew ships for watching; recording its windows is the Architect's equipment (2026-09-14).
  if (c.record === 'film' && !require(paths.bot('js_kernel', 'utils', 'workstation.js')).findRecorder()) {
    wrong.push(`record: 'film' writes every camera to a file, and this copy has no recorder. 'cameras' is the ` +
      `same run watched through the same windows — each is titled Cam_<Bot>, so your own screen recorder can capture it.`);
  }

  // THERE ARE NO CROSS-FIELD RULES LEFT, and their absence is the shape of the change rather than a gap
  // (2026-09-11). The only one this file ever had was "a fresh world cannot be rolled back under a running
  // server" — a fact about who owns the server folder, which is now a fact about `host_and_run.js` and is
  // checked there, before it stops anything. Every field above is independent of every other, which is
  // what a page belonging to ONE verb looks like.
  if (wrong.length) refuse(wrong);
}
validate(CONFIG);

// ── THE WORLD'S CONSOLE, LEARNED AFTER THE FOREMAN HAS THE WORLD (2026-09-18) ──────────────────────────
// A crew is placed beside a person through the server's console (RCON), and this script reads the world
// through it too (who is in, where they stand). It used to need the password BEFORE anything started, because
// a host had minted it upstream. The foreman now starts or reaches the world itself (foreman/foreman_world.js),
// so the password exists only once the foreman has said the world is up:
//   local   the foreman wrote a fresh one into the server's server.properties; read from there.
//   remote  the world's owner gave it, in foreman_config.js (or AUREN_RCON_PASSWORD).
let CREDS = null;
function worldConsole() {
  return WORLD.where === 'remote'
    ? { port: WORLD.rconPort, password: WORLD.rconPassword }
    : rcon.readServerProperties();
}
const EXTRACT = paths.bot();     // the tree this file lives in — see clearMemory's header for why there is no copy
const TRACE = path.join(EXTRACT, 'fleet_logs', 'traces', 'watcher_fleet.jsonl');

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

// THE ENVIRONMENT A STRANGER HAS. Every AUREN_/BOT_/FOREMAN_ variable this machine exports is stripped
// before the fleet is launched: leaving them lets the run inherit his own configuration and certify a
// build that works on one box in the world. The rcon password is handed back in as a FLAG, because
// typing it is what somebody else would do.
function strangerEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(AUREN_|BOT_|FOREMAN)/.test(k) || k === 'NODE_PATH') delete env[k];
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

async function teardown(why) {
  if (CONFIG.teardown === 'leave-up') {
    console.log(`\n  teardown: 'leave-up' — the desk, the crew and the person are STILL IN THE WORLD.`);
    console.log(`  Their console windows are open and still following — read them there.`);
    console.log(`  To end it all, the foreman included (it stops a world it started):  node Auren_Workshop/fleet_control.js verb shutdown\n`);
    return;
  }
  console.log(`\n  taking it down (${why})`);
  if (CONFIG.record !== 'off') {
    const overlay = require('./tools/record_overlay.js');
    overlay.reap('the run ended');
  }
  keepConsoles();
  // ── THE FOREMAN IS ASKED TO SHUT DOWN, NOT KILLED (Architect 2026-09-18: *"how does shutting down a server
  // work after a soak or a problem?… I want foreman to handle that."*) ───────────────────────────────────
  // It sends every bot home and, if it started the world, stops it and waits for the save. A killed desk
  // would leave that server running and holding the world folder. The wait is the foreman's own save limit
  // plus a margin; whatever is still standing after it is ended below, and said.
  const desk = children.find(c => c.label === 'desk');
  if (desk && desk.child.exitCode === null) {
    fleetControl(['verb', 'shutdown']);
    const until = Date.now() + SHUTDOWN_WAIT_MS;
    while (desk.child.exitCode === null && Date.now() < until) await sleep(1000);
    say(desk.child.exitCode === null
      ? `the foreman had not finished shutting down after ${SHUTDOWN_WAIT_MS / 1000}s — it is being ended; check the world with the server's own window.`
      : 'the foreman shut down: the bots are home and a world it started is stopped and saved.');
  }
  for (const c of children.slice().reverse()) {
    if (c.child.exitCode === null) { try { c.child.kill(); } catch (_) { /* already gone */ } }
    // The window goes with the process it was watching. Left open it would sit on a file the next run
    // empties whole (Architect 2026-08-31 — no record survives a run), showing a run that is over as
    // though it were live. `leave-up` returns above and keeps its windows, which is the whole point of
    // that mode.
    if (c.window) consoleWindow.closeWindow(c.window.pid);
  }
  // AND EVERY OTHER TERMINAL THE RUN OPENED — the crew's followers above all, which the foreman's own close
  // never reaches on Windows — then LOOK AGAIN and say what is left (Architect 2026-09-11: *"at the end of
  // the run, the run shall check and close all terminals"*). The world's terminal is not this run's.
  const reaped = consoleWindow.closeWindows({ except: ['server'] });
  say(`terminals: closed ${reaped.closed.length}; ${consoleWindow.describeWindows(reaped.stillOpen)}.`);
  // THE WORLD IS THE FOREMAN'S TO STOP, and it has (a local one) or has left it alone (a remote one).
  say(`desk, crew and person are down. The world: ${WORLD.where === 'local' ? 'stopped by the foreman that started it' : 'left running — somebody else owns it'}.`);
}

// ── THE RUN ─────────────────────────────────────────────────────────────────────────────────────────
// ── A NAMED FUNCTION CALLED AT THE END OF THE FILE, NOT AN IIFE HERE (fixed 2026-09-18) ─────────────
// This was `(async () => { … })()`, and the wrong turn is worth naming because it looks correct and is
// invisible until the exact right shape of run. An async function runs SYNCHRONOUSLY until its first
// real suspension, and everything above `await worldFromForeman(desk)` — the terminal check, preflight,
// the record sweep, the memory wipe, `npm install`, spawning the desk — is synchronous. So the IIFE
// reached that call before the module body had finished evaluating, and every `const` declared BELOW it
// was still in its temporal dead zone: the first hosted run under the new foreman died on `Cannot access
// 'WORLD_WAIT_MS' before initialization`, after the server and the desk were already up. Declaring the
// work as a function and calling it on the last line makes the whole module initialized before any of it
// runs, whatever gets added above the first await later.
async function main() {
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
  // ── EVERY TERMINAL CLOSED BEFORE ANYTHING STARTS — CHECKED, NEVER CLOSED HERE (Architect 2026-09-11) ──
  // *"before startup it should also check but not close. just prevent another start from happening and say
  // what terminals are open that prevents another start. thats our server hang problem"*. The world's own
  // terminal is the one expected open: this run joins a world, and whoever started it owns that window.
  phase('every terminal closed?');
  const openTerminals = consoleWindow.openWindows({ except: ['server'] });
  if (openTerminals.length) {
    console.error(`\n  run: NOTHING WAS STARTED — ${consoleWindow.describeWindows(openTerminals)}.`);
    console.error(`  A run started beside those shares the world with whatever is still in it. Nothing was`);
    console.error(`  closed; close them, then start again:`);
    console.error(`      node Auren_Workshop/fleet_control.js down --keep-server\n`);
    process.exit(1);
  }
  say('no terminals open');

  phase('preflight — does the tree load at all');
  if (spawnSync(process.execPath, [paths.workshop('tools', 'preflight.js')],
        { stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
    console.error(`\n  run: preflight failed, so NOTHING was started. No process was launched and nothing`);
    console.error(`  joined the world. Read its output above — it names the file.\n`);
    process.exit(1);
  }
  say('the tree loads');

  // ── THE FOREMAN FIRST, AND IT BRINGS THE WORLD (Architect 2026-09-18) ────────────────────────────────
  // *"You give everything you need to foreman. Foreman starts first before the server… If any part of the
  // process fails then the Foreman is a live process that can troubleshoot… Who owns the process? Foreman
  // does."* This script no longer checks for a world before it starts: it starts the foreman the way a
  // stranger does, and ASKS THE FOREMAN, through its door, whether the world came up — and if not, why.
  clearRecords();
  clearMemory();
  install();

  phase('node start_auren.js  — the one door, and the foreman brings the world');
  // `--records keep` because clearRecords() above already swept; a second sweep deleted console_desk.log
  // out from under this runner's open handle on every run (start_auren.js's sweep site has the mechanism).
  // `--where` and, for a remote world, its address and console travel as FLAGS, because strangerEnv()
  // strips this machine's AUREN_ variables and typing them is what somebody else would do.
  const deskArgs = ['start_auren.js', '--where', WORLD.where, '--records', 'keep'];
  if (WORLD.where === 'remote') {
    deskArgs.push('--host', WORLD.host, '--port', String(WORLD.port),
      '--rcon-password', WORLD.rconPassword, '--rcon-port', String(WORLD.rconPort));
  }
  const desk = launch('desk', process.execPath, deskArgs, EXTRACT);

  phase(`is the world there — asked of the foreman (${WORLD.where})`);
  const world = await worldFromForeman(desk);
  if (!check('the foreman has the world', world.state === 'up',
    world.state === 'up'
      ? `${world.where} world at ${world.host}:${world.port}${world.ours ? ', started by the foreman' : ', run by somebody else'}`
      : `${world.state}: ${world.reason}`)) {
    return finish('the world did not come up');
  }
  CREDS = worldConsole();
  const before = (await playersOnline()) || [];
  say(`${before.length} player(s) in the world`);

  // THE CLOCK IS A RUN INPUT, AUTHORED WHILE NOTHING IS RUNNING (Law 26). Not gated: a fleet on a dark
  // world is still a fleet running, so a clock that would not set is worth SEEING and never worth
  // aborting a run over (Law 13).
  if (CONFIG.clock !== 'held') {
    fleetControl(['clock', CONFIG.clock]);
    say(`clock: ${CONFIG.clock}`);
  }

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
    // `record_overlay` declares two overlays, `record` (cameras + a recorder writing files) and `watch`
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
  // Watched, this polls the LIVE FLEET and ENDS the run when a bot reports a fault, so it is read at the
  // moment it happens. Blind, the run sleeps out its window. The wake list is his — `errors wake,
  // warnings sleep` — and it is a config value rather than a constant here because the criterion
  // belongs to the asker (Law 25).
  //
  // ── THIS USED TO SPAWN `trace_monitor --watch`, AND THAT WAS THE DEFECT (Architect 2026-09-16) ─────
  // *"Nothing should be using trace monitor while the bot is online, its post Mortem only. Run.js should
  // be talking directly to the program it needs… not asking trace monitor who checks the file which was
  // written by the program that it needs its answer from. It should skip that and talk directly."*
  //
  // The old shape was four hops for one fact: a bot errored → its watcher wrote a line to a file → a
  // lens tailed that file → this script parsed the lens's output. Every hop was a place for the answer
  // to go stale or be misread, and the last one had already shipped a regression that failed every run
  // (§6.10). A lens is a POST-MORTEM instrument — it reconstructs a run that is over — and pointing one
  // at a fleet that is still moving asks it to be something it is not.
  //
  // What replaces it is the first hop and nothing after it: the foreman receives every bot's error()
  // the instant it fires (that forward has always existed; it just threw the fact away), so it now keeps
  // the count, and `foreman_door.query()` is the proper function for asking it. One process, one
  // question, no file and no record in between.
  phase(`letting the crew work for ${CONFIG.soak} min${CONFIG.watch ? ' — watched' : ''}`);
  // ── AND THE ONE WINDOW HE ACTUALLY READS IS OPENED WITH IT (Architect 2026-09-10) ─────────────────
  // *"i cant see whats going on and help at all"*, and 2026-09-03 already named the window that answers
  // it: *"can you place all the node powershells on one as well? i want a one stop shop to see all my
  // terminals and i want the overseer one to scroll like it is."* `fleet-console` is that window and this
  // one-button script never opened it, so the view existed and a run did not produce it.
  //
  // OPENED HERE, not at bring-up, because it follows `watcher_fleet.jsonl` and that file is written by
  // the fleet — before the crew has arrived there is nothing to tail. By this line the traces exist.
  //
  // It is a LENS rather than a raw console, which is why it is the right window to put in front of him
  // (Law 26, and CLAUDE.md's rule that a run record is read only through its lens). The per-process
  // windows carry raw stdout and remain the fallback when the question is about one body. Read-only, so
  // closing it stops nothing, and `down` already reaps it — it is in `FLEET_PROCESSES`.
  fleetControl(['fleet-console']);
  if (CONFIG.watch) {
    auditWakeList();
    const started = Date.now();
    const endAt = started + CONFIG.soak * 60 * 1000;
    let missed = 0;
    // Asked on a cadence rather than pushed, because the door is a request/response socket and this is
    // the one shape it already serves (Law 16 — `camera_warden` polls the same door for the same
    // reason). Six seconds is the warden's interval and the cost is one short-lived local socket.
    while (Date.now() < endAt) {
      await sleep(Math.min(WATCH_POLL_MS, Math.max(0, endAt - Date.now())));
      const state = await fleetFaults();
      // AN UNREACHABLE FLEET IS NOT A CLEAN FLEET — but one missed ask is not a dead desk either. A
      // single failure is ordinary churn and is skipped; a RUN of them is the desk itself having
      // crashed, which is the one crash no bot can ever report, because the thing that reports is what
      // died. Counted rather than tolerated forever: without this the run would sit out its whole
      // window talking to nothing and fail the verdict as unproven thirty minutes late (Law 25).
      if (!state.ok) {
        if (++missed >= DESK_SILENT_POLLS) {
          woke = true;
          wokeOn = `the desk stopped answering — ${missed} polls over ~${Math.round(missed * WATCH_POLL_MS / 1000)}s, last reason: ${state.error || 'none given'}`;
          break;
        }
        continue;
      }
      missed = 0;
      wokeOn = wakeReason(state);
      if (wokeOn) { woke = true; break; }
    }
    const ranMin = (Date.now() - started) / 60000;
    // A WAKE IS A FINDING, AND IT HAS TO REACH THE VERDICT (Law 25). This first read `woke` into the
    // closing sentence only, so a run whose watch fired ten seconds in still printed PASS with every
    // check green — because none of the checks were ABOUT the soak. The window not being served is the
    // most consequential thing such a run has to say, and a verdict that omits it is the run grading
    // itself on the questions it happens to have asked.
    check('the crew worked its window out', !woke,
      woke ? `the watch woke after ${ranMin.toFixed(1)} of ${CONFIG.soak} min and ended the run — ${wokeOn}`
           : `${CONFIG.soak} min served with nothing waking the watch`);
  } else {
    await sleep(CONFIG.soak * 60 * 1000);
  }

  // ── THE RUN IS JUDGED BY THE FLEET'S OWN REPORT OF ITSELF (Architect 2026-09-16) ──────────────────
  // The bar is the watcher's ERROR level, asked of the live foreman rather than reconstructed from the
  // record afterwards. Warnings are deliberately NOT the bar: the first run of a fresh download is
  // legitimately full of them (the loudest being that a bot's headquarters file does not exist yet,
  // which is the correct state of a bot that has never seen a world), and gating on those would make a
  // clean install permanently unreadable.
  //
  // WHAT THIS REPLACED, and why it was wrong even though it worked: `lens(['--level=error'])`, a
  // subprocess that read the trace FILE and printed a count this script then matched out of its output
  // with a regex. Three parties for one number, and the fleet — which held that number the whole time —
  // was not one of them. Both hops are gone; the count comes from the process the errors were reported
  // to (Law 26 — the party with the witness answers).
  phase('the fleet reports its own run');
  const final = await fleetFaults();
  // AN UNANSWERED FLEET IS NOT A CLEAN FLEET. The door resolves rather than throwing, so an unreachable
  // desk arrives as ok:false — and it FAILS this check as unproven rather than passing on silence
  // (Law 13 — prove it is safe to continue, never assume it).
  // A DEPARTED BOT'S ERRORS COUNT TOO, and this is where forgetting them would hurt most: a bot that
  // errored and then crashed is absent from the roster, so counting only what is still connected would
  // let the worst run of all — the one that lost a body — report zero errors (Law 25). The foreman
  // keeps a crashed bot's tally, so both lists are read as one.
  const present = final.ok ? final.bots : [];
  const gone = final.ok ? (final.departed || []) : [];
  const errBots = [...present, ...gone].filter(b => (b.error || 0) > 0);
  const errTotal = errBots.reduce((n, b) => n + b.error, 0);
  check('the run record is clean (no errors)', final.ok && errTotal === 0,
    !final.ok ? `the desk did not answer, so this run is UNPROVEN rather than clean — ${final.error || 'no reason given'}`
      : errTotal === 0 ? `the desk reports 0 error-level lines across ${present.length + gone.length} bot(s)`
      : `${errTotal} error(s) across ${errBots.length} bot(s); ${errBots[0].id} said: ${errBots[0].last_error || 'its line was not carried'}`);

  // ── THE CREW IS STILL THE CREW, CHECKED SEPARATELY FROM WHAT IT SAID (Architect 2026-09-16) ────────
  // *"if bots crash it should still end the run and wake you to investigate."* A crash that says nothing
  // on its way out leaves every counter at zero, so the error check above would pass it. Losing a body
  // is its own failure whatever the logs hold, and it gets its own check rather than being folded into
  // the one above — two different faults reported as one is a verdict that cannot be acted on (Law 29).
  check('the crew that started is the crew that finished', final.ok && gone.length === 0,
    !final.ok ? 'the desk did not answer, so whether the crew is intact is UNPROVEN'
      : gone.length === 0 ? `all ${present.length} bot(s) that registered are still connected`
      : `${gone.length} bot(s) left and did not come back: ${gone.map(d => `${d.id} at ${d.gone_at}`).join(', ')}`);

  // For information, and never a check: warnings are normal and a count of them is context for whoever
  // reads the verdict, not a verdict of its own.
  for (const b of present) {
    say(`${b.id}: ${b.summary} summary, ${b.warn} warning(s), ${b.error} error(s)`
      + `${b.unlabelled ? `, ${b.unlabelled} line(s) whose level did not travel` : ''}`
      + `${b.dead === true ? ', and it is DEAD right now' : ''}`);
  }
  for (const d of gone) {
    say(`${d.id}: GONE at ${d.gone_at} — ${d.summary} summary, ${d.warn} warning(s), ${d.error} error(s)`
      + `${d.last_error ? `; its last error line: ${d.last_error}` : '; it logged no error on the way out'}`);
  }

  return finish(woke ? 'the watch woke' : 'the window closed');
}

async function runFailed(e) {
  console.error(`\n  run stopped on an error it could not grade: ${e && e.message}`);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  await teardown('an ungraded error');
  // THE CRASH PATH STATES ITS OUTCOME TOO, and it is the path that needed it most: before this, an
  // ungraded error left a stack trace and exit 1, and a reader had to scroll a console to learn whether
  // the fleet had even started. CRASHED is its own value — a run that fell over is not a run that
  // measured a failure, and reporting them alike sends the next reader to debug the wrong thing.
  process.exit(outcome.write({
    outcome: 'CRASHED', stage: 'ungraded', reason: (e && e.message) || String(e),
    checks, woke, wokeOn, startedAt: RUN_STARTED_AT,
    ranMin: (Date.now() - Date.parse(RUN_STARTED_AT)) / 60000, exitCode: 1,
  }));
}

// worldFromForeman(desk) → the foreman's own account of the world: { state:'up'|'failed'|..., reason, ... }.
// Polled through the door until the foreman says up or failed. A local first boot generates terrain, so the
// ceiling is the foreman's own startup limit plus a margin. A desk that exits before answering is a failure
// with its console tail as the reason — the foreman prints its diagnosis there before it ends.
const WORLD_WAIT_MS = 6 * 60 * 1000;
const SHUTDOWN_WAIT_MS = 240000;   // the foreman's own save limit is 180 s, plus the bots' grace
async function worldFromForeman(desk) {
  const end = Date.now() + WORLD_WAIT_MS;
  let last = null;
  while (Date.now() < end) {
    if (desk.child.exitCode !== null) {
      return { state: 'failed', reason: `the foreman ended before the world came up. It said: ${desk.read().slice(-600)}` };
    }
    const r = await fleetFaults();
    if (r.ok && r.world) {
      if (r.world.state !== (last && last.state)) say(`foreman: the world is ${r.world.state}`);
      last = r.world;
      if (r.world.state === 'up' || r.world.state === 'failed') return r.world;
    }
    await sleep(2000);
  }
  return { state: 'failed', reason: `the foreman did not report the world up within ${WORLD_WAIT_MS / 60000} min (last: ${last ? last.state : 'no answer'})` };
}

// ── ASKING THE LIVE FLEET, WHICH IS THE ONLY THING THIS SCRIPT DOES WHILE BOTS ARE UP ───────────────
// (Architect 2026-09-16) *"Make sure no live code program uses a lens or monitor and talks directly to
// the system needed."* This is that one door. `foreman_door` is the fleet's own request/response
// channel — the same one `camera_warden` and the foreman use, so there is no second route to keep in
// step (Law 16) — and it resolves rather than throwing, which is why every caller above tests `ok`.
const WATCH_POLL_MS = 6000;
// Five polls — half a minute of silence. Above the longest ordinary hiccup (a boardroom broadcast under
// load, a socket re-open) and far below the window it protects, so a desk that genuinely died is caught
// in seconds while a desk that merely stuttered is not accused of dying.
const DESK_SILENT_POLLS = 5;
let _door = null;
function fleetDoor() {
  if (!_door) _door = require(paths.bot('foreman', 'foreman_door.js'));
  return _door;
}
// The fleet's answer about itself: who is registered, what each is holding, how many lines of each
// level each has written, and whether it has a body. One question, one instant (Law 16) — a caller that
// asked for the counts separately from the roster would be comparing two different moments.
function fleetFaults() {
  return fleetDoor().query();
}

// WHICH FACTS END A RUN EARLY, read off his list rather than decided here (Law 25 — the criterion
// belongs to the asker). `CONFIG.wake` used to name trace_monitor SIGNATURES; it now names facts the
// fleet states about itself, because the fleet is who this asks. A name in the list that nothing here
// knows how to test is REPORTED rather than ignored, so a typo cannot silently disarm the watch.
// Said once, before the first poll, so a name nothing tests is reported even on a run that wakes
// immediately — a check that only runs on the quiet path is not a check (Law 25).
function auditWakeList() {
  const unknown = CONFIG.wake.filter(w => w !== 'error' && w !== 'death');
  if (!unknown.length) return;
  say(`run_config wake lists ${unknown.join(', ')}, which the fleet states no fact for — those wake nothing`);
  CONFIG.wake = CONFIG.wake.filter(w => w === 'error' || w === 'death');
}

function wakeReason(state) {
  // ── A CRASH IS AN ABSENCE, AND AN ABSENCE HAD TO BE MADE VISIBLE (Architect 2026-09-16) ────────────
  // *"if bots crash it should still end the run and wake you to investigate."* A bot that dies hard
  // stops logging, so the error count it never wrote cannot wake anything; it simply stopped being in
  // the fleet. The foreman holds the socket that closed and now remembers the departure, so this reads
  // a stated FACT rather than diffing two polls of its own and guessing which absence is new.
  for (const d of state.departed || []) {
    return `${d.id} left the fleet at ${d.gone_at} and did not come back`
      + `${d.last_error ? `; its last error line: ${d.last_error}` : ' — it logged no error on the way out'}`;
  }
  for (const b of state.bots) {
    // The bot's own words for what went wrong, carried through untouched — it participated in the
    // decision it is describing and may say why; this script did not (the emitter-authority rule).
    if (CONFIG.wake.includes('error') && (b.error || 0) > 0) {
      return `${b.id} reported ${b.error} error(s); its own line: ${b.last_error || 'not carried'}`;
    }
    if (CONFIG.wake.includes('death') && b.dead === true) return `${b.id} is dead`;
  }
  return null;
}
// ── THE HEADFRAME CLOCK — A GRADE, PRINTED, NEVER A CHECK (Architect 2026-09-15) ────────────────────
// *"it should never end the run... its just a grade. it shouldnt pass or fail the run."* The milestones
// lens times the headframe from the start command and grades it against his bands
// (architect_config.HEADFRAME_CLOCK). This prints the lens's own block and adds nothing to `checks`, so
// no grade can move the verdict.
//
// ── IT IS READ AFTER THE FLEET IS DOWN, AND THAT IS THE WHOLE CHANGE (Architect 2026-09-16) ──────────
// *"Nothing should be using trace monitor while the bot is online, its post Mortem only."* This block
// used to run in the middle of the verdict, with every bot still in the world — a lens pointed at a
// record that was still being written, which is the one thing a lens is not for. It now runs after
// `teardown`, against a finished record, which is what a post-mortem is.
//
// SO IT IS SKIPPED ENTIRELY ON `leave-up`, and says so rather than going quiet. That setting leaves the
// crew in the world on purpose, and a run that left the fleet up has no post-mortem to take — grading a
// record that is still growing would report a build as late because it was asked too early (Law 25).
// The grade is still available afterwards by hand, which is what the line says.
const CLOCK_SECTION = '[headframe_clock]';
const CLOCK_SECTION_RE = /^\s*\[[a-z0-9_.]+\]\s*$/;
async function sayHeadframeClock() {
  if (CONFIG.teardown === 'leave-up') {
    say('headframe clock: not graded — the fleet is still up, and a lens reads a finished record only.');
    say(`  take it by hand once it is down:  node Auren_Bot/monitoring/trace_monitor.js ${TRACE} --milestones`);
    return;
  }
  if (!fs.existsSync(TRACE)) { say('headframe clock: no run record was written, so there is nothing to grade'); return; }
  // THE LAST WRITES LAND AFTER THE LAST PROCESS DIES, so the record is still warm for a second or two
  // after a teardown that has genuinely finished. The lens's gate refuses a captured read of a hot
  // record, so this waits for it to go quiet rather than asking the gate to trust a caller's word for
  // it. A record that never settles means something is STILL WRITING — which is worth saying out loud,
  // and is not a grade (Law 25).
  const settled = await require(paths.bot('monitoring', 'post_mortem_gate.js')).awaitSettled(TRACE);
  if (!settled) {
    say('headframe clock: not graded — the run record is still being written to, so the fleet is not all the way down');
    return;
  }
  const r = spawnSync(process.execPath, [paths.bot('monitoring', 'trace_monitor.js'), TRACE, '--milestones'],
    { encoding: 'utf8' });
  const lines = ((r.stdout || '') + (r.stderr || '')).split('\n');
  // ADDRESSED BY SECTION NAME, NEVER BY A PREFIX OR A COUNT. This once matched the sentence the lens
  // opened with, then a fixed three-line slice; the first broke when the adjective changed and the
  // second silently truncated when the lens grew a fourth field. The lens owns how much it has to say —
  // this owns only where the block starts and ends. A blank line inside it is not a terminator; only the
  // next `[section]` is, so spacing the renderer chooses cannot cut the block short.
  const at = lines.findIndex(l => l.trim() === CLOCK_SECTION);
  if (at === -1) { say(`headframe clock: the milestones lens printed no ${CLOCK_SECTION} section`); return; }
  for (let i = at + 1; i < lines.length && !CLOCK_SECTION_RE.test(lines[i]); i++) {
    if (lines[i].trim()) say(lines[i].trim());
  }
}

// ── THE VERDICT, AND WHY IT ENDS IN A SENTENCE ABOUT PUBLISHING RATHER THAN A PUSH ──────────────────
// The run says whether the build a stranger would get worked, and then stops. Posting it is his call in
// conversation, because the thing being tested is different every time and a green run certifies the
// feature that was exercised, not the tree (Architect 2026-09-10: *"were never testing the same thing
// and errors will always be different. so the workflow is verbal not coded"*).
async function finish(why) {
  const failed = checks.filter(c => !c.ok);
  console.log(`\n══ ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length - failed.length}/${checks.length} check(s) · ${why} ══`);
  for (const f of failed) say(`FAILED  ${f.name} — ${f.detail}`);
  // The desk's last words, in the verdict rather than in a folder the next run empties. Printed only on
  // a FAIL, because that is the one case where a fault may live OUTSIDE every bot's trace — the foreman
  // and the foreman run in the desk process, and a lens can only read what a watcher wrote.
  if (failed.length) {
    const tail = consoleTail('desk', 25);
    if (tail) {
      console.log(`\n  ── the desk's own console, last ${tail.length} line(s) ` + '─'.repeat(30));
      for (const l of tail) console.log(`     ${l}`);
    }
  }
  await teardown(why);
  // THE ONE LENS READ IN THIS FILE, AND IT IS HERE BECAUSE HERE IS AFTER THE FLEET IS DOWN. Everything
  // above this line asked the live fleet directly; the record is only opened once nobody is writing it.
  await sayHeadframeClock();
  if (!failed.length) {
    console.log(`\n  This is the build a stranger would get, and it worked. If the feature you were`);
    console.log(`  testing is the one you wanted, it is postable — that is a call to make out loud,`);
    console.log(`  not something this script does.\n`);
  }
  // THE RUN STATES ITS OWN OUTCOME, LAST, IN FIELDS (Architect 2026-09-16). Everything above this is
  // written for a person reading along; this block is written for whoever has to ASK how it went
  // without reading any of it. See run_outcome.js for why that is not the same job.
  process.exit(outcome.write({
    outcome: failed.length ? 'FAIL' : 'PASS',
    stage: 'verdict', reason: why, checks,
    woke, wokeOn, startedAt: RUN_STARTED_AT,
    ranMin: (Date.now() - Date.parse(RUN_STARTED_AT)) / 60000,
    exitCode: failed.length ? 2 : 0,
  }));
}

// ── THE LAST LINE OF THE FILE, AND THAT POSITION IS THE POINT ───────────────────────────────────────
// See main()'s header: the run performs its whole opening synchronously, so starting it anywhere above
// this line puts every constant declared below the call site in its temporal dead zone.
main().catch(runFailed);
