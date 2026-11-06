'use strict';
// foreman.js — the foreman's body: it runs the world, sites the base, raises the crew its run page names
// and ends the run. Does not plan, judge, or decide what a bot does once it exists. It hears nothing in chat;
// it says the run's beats there (utils/run_announcer).
//
// Not a bot: holds a player slot and a body, but no BOT_ID, mandate, corporate_headquarters, job board or
// place in BOT_SENIORITY — the fourth process type in the fleet, after the server, the foreman and the bots.
// Spawns `start_bot.js`, the one birth in this tree (Law 16), rather than requiring master_core directly.
//
// Run:  node start_auren.js

const path = require('path');

const moduleAlias = require('module-alias');
const BOT_DIR = path.resolve(__dirname, '..');
// Hand-registered and kept short: each alias is a layer of the fleet this process can reach. Values match
// package.json's `_moduleAliases` (Law 16).
moduleAlias.addAliases({
  '@thinking': path.join(BOT_DIR, 'Thinking_fragments'),
  '@kernel':   path.join(BOT_DIR, 'js_kernel'),
  '@utils':    path.join(BOT_DIR, 'js_kernel', 'utils'),
  '@foreman': path.join(BOT_DIR, 'foreman'),
  // The event grammar the foreman's record is written in (Law 16).
  '@api':      path.join(BOT_DIR, 'custom_api'),
  // The crew raise's read on where world spawn is; `spawn_protection` is the one owner of that latch (Law 16).
  '@perception': path.join(BOT_DIR, 'perception_nodes.js'),
  // The crew's own surveyor, run with `dryRun: true` so the foreman's siting check is a read (Law 16).
  '@action':     path.join(BOT_DIR, 'action_fragments.js'),
  // A load-time dependency of the siting scan's combat checkpoint (battle_stations), loaded but never driven.
  '@locomotion': path.join(BOT_DIR, 'custom_api', 'locomotion'),
});

// ── THE FOREMAN KEEPS A RECORD, AND IT IS THE FLEET'S OWN WRITER ────────────────────────────────────
// Naming the unit before the watcher require lets it resolve its filename at load, the camera's own
// arrangement (BOT_ID=camera_rig). Names a record here, not a mandate: never connects `foreman_link`,
// so the foreman's record stays out of the fleet's merged stream (Law 26).
process.env.BOT_ID = process.env.BOT_ID || 'foreman';
// ── THE CONSOLE NEVER HOLDS THE ARBITER ─────────────────────────────────────────────────────────
// Every bot's log line is relayed through this process to one console (foreman_hub.handleLog), and a
// console or pipe write on Windows waits on the event loop's own thread for whatever is displaying it —
// a terminal in select mode, a launcher whose reader paused — and with it every claim, token and
// heartbeat the fleet is asking for. Installed before the first line is printed: the lane hands each
// line to the thread pool and the loop never waits on a display (js_kernel/utils/console_lane).
const consoleLane = require('@utils/console_lane');
consoleLane.install();
const record = require('./foreman_record');
const { log, alarm } = require('./utils/say');

// ── WHERE THE THIRD-PARTY PACKAGES LIVE IS ASKED, NEVER ASSUMED ──────────────────────────────────
// Resolves the module path itself (Law 2); a no-op once `npm install` has put packages beside this tree.
require('@utils/node_module_homes').bootstrapModulePath();
// Each require's resolved file is remembered once the aliases and module homes are set (require_memo).
require('@utils/require_memo').install();

// ── THE FOREMAN AND THE HUB ARE ONE PROCESS ────────────────────────────────
// One body. Requiring the hub restores every crew's buildings and stations from disk and opens both
// ports; the body reaches it through `foreman_door.local` further down.
// foreman_config is checked whole and said back here, before memory, ports or world are touched; a
// rollback start empties the fleet's memory now, before the hub loads it.
const plan = require('./foreman_plan');
{
  const c = plan.check();
  if (!c.ok) {
    log('foreman_config.js does not make sense yet, so NOTHING was started:');
    for (const w of c.wrong) log(`   ${w}`);
    log('Fix those fields in Auren_Bot/foreman_config.js and start again.');
    require('@kernel/watcher').flushNow();
    process.exit(1);
  }
  log(`THE RUN: ${plan.sentence()}`);
  require('./utils/process_priority').apply(process.pid, 'foreman', log);
  plan.emptyMemory(log);
}

const { hub: foremanHub } = require('@foreman/foreman_hub');

const mineflayer = require('mineflayer');
const { FOREMAN_NAME, SERVER_MINECRAFT_VERSION } = require('@thinking/architect_config');

// The foreman's own read of the fleet, answered by the hub in this process (foreman_door.local).
const door = require('./foreman_door').local(foremanHub);

// `foreman_world` starts or reaches the world before the body joins and says which address it dials,
// asked at connect time since a local port is known only once settings are read. VERSION is the fleet's
// one answer (Law 16).
const world = require('./foreman_world');
const { runSteps } = require('./foreman_steps');
const VERSION = SERVER_MINECRAFT_VERSION;

// ── THE BODY'S GAME DATA IS LOADED NOW, WHILE NOTHING IS CONNECTED ───────────────────────────
// Pre-warms the block, item and chunk data mineflayer loads at join, via the same factories the plugins call.
{
  const registry = require('prismarine-registry')(VERSION);
  for (const m of ['prismarine-chunk', 'prismarine-block', 'prismarine-item', 'prismarine-windows',
    'prismarine-recipe', 'prismarine-entity', 'prismarine-biome', 'prismarine-chat']) require(m)(registry);
}


(function banner() {
  const C = '\x1b[95m\x1b[1m', R = '\x1b[0m';
  const bar = '═'.repeat(56);
  console.log(`${C}${bar}${R}`);
  console.log(`${C}  🛎️   FOREMAN  ·  ${FOREMAN_NAME}${R}`);
  console.log(`${C}      runs the world, sites the base, raises the crew${R}`);
  console.log(`${C}${bar}${R}`);
})();

// Fetching a body — through start_bot.js, the one birth (foreman/utils/crew_launch.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const crewLaunch = require('./utils/crew_launch');
const integrityKeeper = require('./integrity_keeper');
process.on('exit', crewLaunch.releaseFetched);
// Ctrl-C and the ordinary stop signals take the one shutdown road.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(`${sig} at the foreman`, 0));

// ── A THROW IS A WAY THIS PROCESS ENDS, SO IT TAKES THE SHUTDOWN ROAD TOO ──────
// Routes through `shutdown`, never exits bare, since the foreman's death ends every body with it.
// A stuck piece of work or an impossible state, found here or reported by a body, ends the whole run on
// the same road, with timeout_crash's report as the cause.
require('../js_kernel/utils/timeout_crash').onCrash(fleetCrash);
function fleetCrash(report) {
  const head = report.split('\n');
  alarm([
    'THE WHOLE RUN IS ENDING — timeout_crash.',
    head[0], head[1] || '',
    '',
    `Every bot is being sent 'stop' and the world is being saved.`,
    'The full report is printed below and written to the run record.',
  ]);
  console.error(report);
  record.note(`TIMEOUT_CRASH: ${report}`);
  require('./utils/run_watch').crashed('timeout_crash', `${head[0]} ${head[1] || ''}`);
  shutdown(`timeout_crash — ${head[1] || head[0]}`, 1);
}

function crashStop(kind, err) {
  const detail = (err && err.stack) || String(err);
  const first = String((err && err.message) || err).split('\n')[0];
  alarm([
    `THE FOREMAN CRASHED — ${kind}.`,
    first,
    '',
    `Every bot is being sent 'stop' and the world is being saved.`,
    `The whole fleet ends with the foreman. Nothing restarts by itself.`,
    `This run is recorded as CRASHED, not as a FAIL — it never finished.`,
    '',
    `The stack is printed below. Start again with start_auren.js.`,
  ]);
  // Unwrapped, below the alarm block, so the file:line references stay clickable.
  console.error(detail);
  record.note(`CRASH (${kind}): ${detail}`);
  // Told before shutdown runs, since `shutdown` asks it for the verdict after sending every bot home.
  require('./utils/run_watch').crashed(kind, first);
  shutdown(`the foreman crashed — ${kind}: ${first}`, 1);
}
process.on('uncaughtException', (err) => crashStop('uncaught exception', err));
process.on('unhandledRejection', (reason) => crashStop('unhandled rejection', reason));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What the foreman does, in its utility folder
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//   utils/get_crew.js       the one way a crew is raised
//   utils/startup_steps.js  the startup after the world is up, as proved steps
//   utils/admin_steps.js    the run's admin: leftover terminals, the clock, the cameras
//   utils/run_watch.js      the watch over a working run, and the PASS/FAIL verdict at its end
//   utils/crew_launch.js    one body launched, and every body ended
//   utils/say.js            the log line and the alarm
const crewRaise = require('./utils/get_crew');
const { foremanSteps } = require('./utils/startup_steps');
const testModes = require('./utils/test_modes');
const observer = require('./utils/observer');
// The run's admin and its verdict live in the foreman's own utility folder.
const adminSteps = require('./utils/admin_steps');
const runWatch = require('./utils/run_watch');   // every scan the foreman runs yields each tick
// The crew raise's spawn-clearance gate (armed at createBot); one module owns the world-spawn latch,
// so the foreman and a body's dig refusal cannot disagree about where spawn is (Law 16).
const { armSpawnProtection, maskWorldReads } = require('@perception/spawn_protection');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The body
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// ── THE BODY IS REQUIRED: LOSING IT ENDS THE RUN ──────────────────────────────
// Spectator removes every in-world cause of loss; what remains is the connection — loop freeze, the
// server stopping, `duplicate_login`, chat spam, an operator kick, a missing whitelist entry, or an
// undecodable packet. None of these proves the run is safe to continue (Law 13), so the body leaving the
// world for any reason but this process's own shutdown stops the whole fleet, and the cause is investigated.
// There is no rejoin: the keeper's station and its world copy are proved once, at startup.
const FLEET_STOP_GRACE_MS = 10000;
const LOOP_FREEZE_ALERT_MS = 5000;    // a third of the ~15 s the server allows before "Timed out"
const BODY = { present: false, lastKick: null, stopping: false };
let bot = null;
// The door and the body are handed to the utilities that act through them; `bot` is read at call time
// because it is made by the startup step that joins the body.
crewRaise.bind({ door, hub: foremanHub, getBot: () => bot });

// ── ONE SHUTDOWN ROAD ─────────────────────────────────────────────────────────────────────────────
// Every way this process ends comes here: bots sent `stop` and given FLEET_STOP_GRACE_MS to leave, the
// body leaves, the server this process started is stopped and waited on until saved. Idempotent.
let shuttingDown = null;
function shutdown(why, code) {
  if (shuttingDown) {
    log(`already shutting down (${why} ignored) — waiting for the world to finish saving.`);
    return shuttingDown;
  }
  BODY.stopping = true;
  shuttingDown = (async () => {
    log(`SHUTDOWN — ${why}`);
    plan.note({ closing: why });
    // Kept before the bots are sent home: a fleet going home is not reporting on its work.
    runWatch.freeze(() => foremanHub.fleetState());
    require('./utils/run_announcer').stop();
    const r = foremanHub.stopFleet(why);
    if (r && r.sent > 0) {
      log(`'stop' reached ${r.sent} bot(s); giving them ${FLEET_STOP_GRACE_MS / 1000}s to leave.`);
      const until = Date.now() + FLEET_STOP_GRACE_MS;
      while (Date.now() < until && foremanHub.fleetState().bots.length > 0) await new Promise(res => setTimeout(res, 500));
    }
    // Every body sent its last reading on the way out, so the book is whole here.
    await foremanHub.writeItemBook();
    await foremanHub.flushMemory();
    await crewLaunch.releaseFetchedAsync();
    // The cameras come down after the bots and before the world: a recording is finalised while its windows exist.
    if (plan.record() !== 'off') await adminSteps.stopCameras(why, log, plan.record() === 'film');
    integrityKeeper.stop();
    if (bot && BODY.present) bot.quit('the foreman is shutting down');
    const s = await world.stopServer(log);
    if (!s.stopped) log(`the world was not stopped: ${s.reason}.`);
    log(`the foreman has shut down (${why}).`);
    // Sets how this process exits: 0 PASS, 2 FAIL after a working run, 1 the startup did not finish.
    const verdictCode = runWatch.verdict(why);
    code = Math.max(code, verdictCode);
    // The record's writer is asynchronous; flushed before exit or the alarm and lines above it are lost.
    await require('@kernel/watcher').flush();
    // The console lane is drained the same way, bounded: the last lines are how the run ended.
    await consoleLane.drained(5000);
    // The archive includes the final verdict and drained shutdown records, after cameras have stopped.
    if (plan.record() === 'film' && !(await adminSteps.archiveRecording(log))) code = Math.max(code, 1);
    process.exit(code);
  })();
  return shuttingDown;
}

function stopEverything(why) {
  if (BODY.stopping) return;
  alarm([`FOREMAN BODY LOST — STOPPING THE WHOLE FLEET`, why,
    `every bot is being sent 'stop', then the world this foreman started is stopped.`]);
  shutdown(why, 1);
}

function bodyLost(reason) {
  BODY.present = false;
  if (BODY.stopping) return;
  const kick = BODY.lastKick;
  const said = kick ? `kicked: ${kick}` : `connection ended: ${reason}`;
  if (kick && /duplicate_login|logged in from another location/i.test(kick)) {
    stopEverything(`another client logged in as ${FOREMAN_NAME} (${said}). Two foremen cannot share one name.`);
    return;
  }
  if (kick && /outdated (client|server)|incompatible/i.test(kick)) {
    stopEverything(`the server refused the body (${said}). This fleet speaks Minecraft ${VERSION}.`);
    return;
  }
  stopEverything(`the body left the world (${said}). Nothing proves the run is safe to continue without it.`);
}

// ── THE FREEZE PROFILE ───────────────────────────────────────────────────────────────────────
// With AUREN_FOREMAN_PROFILE=1 the V8 sampling profiler runs from the first line, and the first freeze
// the watch loop catches stops it and writes the profile beside the run's other records
// (`fleet_logs/foreman_freeze.cpuprofile`): the samples taken during the freeze name what ran without
// yielding. Off by default; a profile is a diagnosis, not a record every run keeps.
let _profiler = null;
if (process.env.AUREN_FOREMAN_PROFILE === '1') {
  const { Session } = require('inspector');
  _profiler = new Session();
  _profiler.connect();
  _profiler.post('Profiler.enable');
  _profiler.post('Profiler.setSamplingInterval', { interval: 1000 });
  _profiler.post('Profiler.start');
  log('freeze profile armed: the first freeze over the alert line writes fleet_logs/foreman_freeze.cpuprofile');
}
function writeFreezeProfile() {
  if (!_profiler) return;
  const session = _profiler;
  _profiler = null;
  session.post('Profiler.stop', (err, result) => {
    if (err || !result) { log(`freeze profile not written: ${err ? err.message : 'no profile'}`); return; }
    const { RECORDS_DIR } = require('@utils/record_homes');
    const file = path.join(RECORDS_DIR, 'foreman_freeze.cpuprofile');
    require('fs').writeFileSync(file, JSON.stringify(result.profile));
    log(`freeze profile written: ${file}`);
  });
}

// Fires every second and reports firing late by more than LOOP_FREEZE_ALERT_MS. Unref'd (Law 8).
(function watchLoop() {
  let last = Date.now();
  const t = require('../js_kernel/utils/timeout_crash').every('foreman', 'report the loop of the foreman firing late', () => {
    const now = Date.now();
    const late = now - last - 1000;
    last = now;
    if (late > LOOP_FREEZE_ALERT_MS) {
      const mem = process.memoryUsage();
      writeFreezeProfile();
      alarm([`FOREMAN PROCESS FROZE FOR ${(late / 1000).toFixed(1)}s`,
        `heap ${(mem.heapUsed / 1048576).toFixed(0)} of ${(mem.heapTotal / 1048576).toFixed(0)} MB, rss ${(mem.rss / 1048576).toFixed(0)} MB.`,
        `the server drops a silent client at ~15s; the body${BODY.present ? '' : ' (already gone)'} was at risk.`,
        `something in this process ran without yielding; AUREN_FOREMAN_PROFILE=1 names it in fleet_logs/foreman_freeze.cpuprofile.`]);
    }
  }, 1000);
  if (t.unref) t.unref();
})();

function connectBody() {
  if (BODY.stopping) return;
  const at = world.endpoint();
  bot = mineflayer.createBot({
    host: at.host, port: at.port, username: FOREMAN_NAME, version: VERSION, auth: 'offline',
  });
  wireBody();
}

function wireBody() {
// Armed here, not in `spawn` below, since `spawn_position` arrives during login and a later listener
// would miss it.
armSpawnProtection(bot);

bot.on('error', e => log(`ERROR: ${e.message}`));
bot.on('kicked', r => { BODY.lastKick = typeof r === 'string' ? r : JSON.stringify(r); log(`KICKED: ${BODY.lastKick}`); });
// The body leaving ends the run (see THE BODY IS REQUIRED).
bot.on('end', r => bodyLost(r));

bot.once('spawn', () => {
  BODY.present = true;
  // The foreman reads the same masked world its crew will, so it cannot site a base where the masked crew
  // could not place. Wrapped here since mineflayer has not attached `bot.blockAt` when `createBot` returns.
  maskWorldReads(bot);
  log(`standing by at ${bot.entity.position.floored()}.`);

  // ── THE CAMERA IS PLACED WHERE THE CREW IS, INCLUDING A LATE JOIN (observer.js) ─────────────────
  // The only player the foreman acts on is a named camera.
  bot.on('playerJoined', (player) => {
    const name = player && player.username;
    if (!name || !observer.isObserver(name)) return;
    observer.atSite(name).then(r => log(r.ok ? `camera: ${r.why}` : `camera: ${name} joined but is not placed — ${r.why}`));
  });
  bot.on('playerLeft', (player) => {
    const name = player && player.username;
    if (name && observer.isObserver(name)) log(`camera: ${name} left — the run carries on.`);
  });
});
}

// THE SOAK: how long the run lasts once its crew is working, then the one shutdown road. 0 = until stopped.
function startSoak() {
  const min = plan.CONFIG.soak;
  if (!(min > 0)) return;
  const endsAt = new Date(Date.now() + min * 60000);
  plan.note({ soakEndsAt: endsAt.toISOString() });
  log(`soak: ${min} min — everything is shut down at ${endsAt.toTimeString().slice(0, 8)}.`);
  setTimeout(() => shutdown(`the ${min}-minute soak ended`, 0), min * 60000);
}

// ── THE ORDER THIS PROCESS COMES UP IN ─────────────────────────────────────────
// hub → the world → the body. A world that does not come up ends the process; a world this process
// started that stops on its own ends the fleet, since nothing the bots do survives it.
world.onShutdownAsked((why) => shutdown(why, 0));
world.onUnexpectedExit((reason, lines) => {
  alarm(['THE MINECRAFT SERVER STOPPED ON ITS OWN — STOPPING THE FLEET', reason, ...lines]);
  shutdown(`the server stopped on its own: ${reason}`, 1);
});

(async () => {
  const stepping = { note: plan.note, stopped: () => BODY.stopping };
  log(`the run: ${plan.sentence()} · ${plan.overlays()}`);
  const clear = await runSteps([adminSteps.terminalsStep()], { log, ...stepping });
  if (!clear.ok) {
    runWatch.startupFailed(clear.step, clear.why);
    alarm(['NOTHING WAS STARTED — A TERMINAL FROM AN EARLIER RUN IS OPEN', clear.why]);
    shutdown(`nothing was started: ${clear.why}`, 1);
    return;
  }
  const up = await world.bringUp(log, stepping);
  if (!up.ok) {
    runWatch.startupFailed('the world comes up', up.reason);
    alarm(['THE WORLD DID NOT COME UP — THE FOREMAN IS STOPPING', up.reason, ...(up.lines || [])]);
    shutdown(`the world did not come up: ${up.reason}`, 1);
    return;
  }
  world.startPulse(log);
  require('./machine_pulse').start(log, (line) => alarm([line]));
  plan.note({ crew: 'raising' });
  log(`the run, one proved step at a time (${plan.sentence()}):`);
  // A test run is the same list, cut short by test_modes.stepsFor after the step the named test stops at.
  const allSteps = foremanSteps({ getBot: () => bot, BODY, connectBody, door, hub: foremanHub, startSoak, shutdown });
  const r = await runSteps(testModes.stepsFor(plan.CONFIG.test, allSteps), { log, ...stepping });
  if (!r.ok) {
    if (BODY.stopping) return;
    plan.note({ crew: 'failed' });
    runWatch.startupFailed(r.step, r.why);
    alarm([`THE RUN STOPPED AT: ${r.step.toUpperCase()}`, r.why]);
    shutdown(`the run stopped at "${r.step}": ${r.why}`, 1);
    return;
  }
  runWatch.startupDone();
  // The fleet is still up, so what it found is read off the live door, never a record.
  if (plan.isTest()) {
    const state = await door.query();
    const held = state.ok ? crewRaise.existingSite(state.buildings, plan.CONFIG.crew) : null;
    const found = testModes.verdict(plan.CONFIG.test, { site: held ? held.site : null, species: plan.CONFIG.crew });
    log(`test ${plan.CONFIG.test} — what the fleet holds:`);
    for (const line of found.lines) log(line);
    runWatch.testDone(plan.CONFIG.test, found);
    // A test that stays open has no end of its own: it is up for a person to look, and ends when stopped.
    if (found.ok && testModes.staysOpen(plan.CONFIG.test)) {
      plan.note({ crew: 'waiting' });
      log(`test ${plan.CONFIG.test} — open until stopped, nobody raised. To end it: `
        + `node Auren_Workshop/fleet_control.js verb shutdown, or Ctrl-C in the terminal that started it.`);
      return;
    }
    shutdown(`the ${plan.CONFIG.test} test finished`, found.ok ? 0 : 2);
    return;
  }
  // The integrity keeper was raised before the crew (startup_steps, "the integrity keeper holds every structure").
  plan.note({ crew: 'working' });
})();
