// Headless fleet operation — launch, command and teardown, and the only console, so an AI monitor or
// script can run the whole stack without GUI windows: Minecraft server, foreman, bots, operator verbs,
// snapshots, teardown. Every process is inspectable afterward: PIDs in fleet_control_runtime.json, each
// in its own visible console window (Law 6). Operates the construct but is not part of it — no fragment,
// no signal bus, no decisions inside the SPA loop; verbs reach the fleet through the foreman's one
// operator pathway ('operator_command' over the socket, the TTY console's twin transport, Law 16).
// Graceful server stop goes through RCON, since a detached java process has no reachable stdin and a hard
// kill risks world corruption. Starts no world — that comes up only through the foreman's own startup
// steps (`start_auren.js`, `run.js`, or a bench through `bench_world.js`); this file stops, inspects and
// drives. `snapshot` refuses while the server is up (rollback.ps1's own precondition); restoring is
// destructive and stays behind a manual invocation of rollback.ps1.
//
// Usage:
//   node fleet_control.js status
//   node fleet_control.js snapshot [--name=label]           [--world=<name>]
//   node fleet_control.js roster                (print the canonical roster, seniority order)
//   node fleet_control.js verb start [--stagger=45000] [--min-gap=1500]   paced by first movement
//   node fleet_control.js verb <start|stop|flush|wipe|...>
//   node fleet_control.js down [--keep-server]
//
// Exit codes: 0 ok · 1 the requested operation could not be completed.

'use strict';
require('../js_kernel/utils/developer_door').enter('Auren_Workshop/fleet_control.js');

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

// The bot lives beside the workshop, not inside it. Every path below — roster, launcher, fleet_logs,
// kernel's live state — is derived from `paths`, the one answer to where the bot is (Law 16).
const paths = require('./workshop_paths');
const BOT_DIR = paths.BOT_ROOT;
const PROJECT_ROOT = paths.REPO_ROOT;
const RUNTIME_FILE = path.join(BOT_DIR, 'fleet_control_runtime.json');
// ROSTER derives from the canonical BOT_SENIORITY table, ordered so ROSTER[0] is the eldest; adding a bot
// is one edit in architect_config.js (Law 16). The `roster` command prints this list for the launchers.
// Registers the @-aliases before the first bot file loads, since architect_config reaches
// `@utils/fragment_utils` while still evaluating; `paths` owns the map (Law 16).
paths.registerAliases();
const { BOT_SENIORITY } = require(paths.bot('Thinking_fragments/architect_config.js'));
const ROSTER = Object.keys(BOT_SENIORITY).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);

// Every process the fleet raises, named once so every teardown path uses the same list (Law 8, Law 16).
// Order is the teardown order: bots first (they persist HQ on the way out), then the foreman they talk
// through. 'fleet-console' is included so `down` reaps that read-only observer window too.
const FLEET_PROCESSES = ['trace', 'fleet-console', ...ROSTER, 'foreman'];
const FLEET_PROCESSES_WITH_SERVER = [...FLEET_PROCESSES, 'server'];
const SERVER_PORT = 25565;
const FOREMAN_PORT_DEFAULT = 3001;

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = name => args.includes(`--${name}`);
const positional = args.filter(a => !a.startsWith('--')).slice(1);

// --world=<name> selects the world; null means run whatever server.properties already names.
// effectiveWorld() resolves the actual name in use.
const WORLD = opt('world', null);

// ── Executables and the server folder ────────────────────────────────────────
// Every child process runs on `process.execPath`, already running this file (Law 16). Java and the
// server folder come from the workstation resolver, asked only when a command needs them.
const workstation = require(paths.bot('js_kernel/utils/workstation'));
function serverDir() { return workstation.needServerDir(); }

// Both module-home questions go to @utils/node_module_homes — one list, two verbs off it (Law 16).
const moduleHomes = require(paths.bot('js_kernel/utils/node_module_homes'));
// Opens a visible process console (see `launch()`).
const consoleWindow = require(paths.bot('js_kernel/utils/console_window'));

// What the spawned bots get: a child cannot inherit a resolver re-initialised in this process's memory,
// so it travels as an environment value.
function nodePathEnv() { return moduleHomes.nodePathValue(); }

// What this process itself needs, resolved by absolute path, leaving our own NODE_PATH untouched.
function requireWs() { return moduleHomes.requireFromHomes('ws'); }

// ── Runtime registry (Law 6: every spawned PID is on record) ────────────────
function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeRuntime(rt) {
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(rt, null, 2));
}
// pidAlive(entry) — is the process we recorded still the one at that pid? A bare `process.kill(pid, 0)`
// answers only whether something holds this pid, never whether it is ours — Windows recycles pids, so a
// stale entry can point at a stranger (Law 23). The check compares the OS's start time for that pid
// against the `started_at` stamped at spawn; a recycled pid always starts later, and SKEW_MS absorbs the
// gap between process creation and the stamp. Uncertain resolves to NOT OURS (Law 13): a launcher
// relaunches, and forceKill declines to signal a process it cannot confirm it owns.
const PID_SKEW_MS = 15000;
function pidAlive(entry) {
  const pid = entry && typeof entry === 'object' ? entry.pid : entry;
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (_) { return false; }   // nothing there at all — cheap, decisive

  // A bare pid (no stamp to compare) cannot be verified, and callers still pass one from older paths.
  const startedAt = entry && typeof entry === 'object' ? Date.parse(entry.started_at) : NaN;
  if (!Number.isFinite(startedAt)) return true;

  const osStart = processStartMs(pid);
  if (osStart === null) return false;                          // could not confirm → not ours
  return osStart <= startedAt + PID_SKEW_MS;
}

// The OS's creation time for a pid, in epoch ms, or null when it cannot be read. Shells out to
// PowerShell because Node exposes no process-start-time API.
function processStartMs(pid) {
  try {
    const out = require('child_process').execFileSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch (_) { return null; }
}

// ── Probes and waits ─────────────────────────────────────────────────────────
function probePort(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function waitFor(label, cond, timeoutMs, intervalMs = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.error(`fleet_control: timed out waiting for ${label} (${timeoutMs / 1000}s)`);
  return false;
}

// Opens the process window through `js_kernel/utils/console_window.js`, the one owner of that job
// (Law 16), and keeps the part that is genuinely fleet_control's: recording the pid in `runtime.json`
// for `status`, `down` and `takeover` to read.
function launch(name, exe, argv, cwd, env, windowStyle) {
  const { pid, style } = consoleWindow.openProcess({
    exe, argv: argv || [], cwd, env: env || {}, style: windowStyle, label: name,
  });
  const rt = readRuntime();
  rt[name] = { pid, started_at: new Date().toISOString() };
  writeRuntime(rt);
  console.log(`${name}: spawned pid ${pid} (${style.toLowerCase()} window)`);
  return pid;
}

// ── THE ONE WINDOW ───────────────────────────────────────────────────────────
// Every bot writes into one merged story, the foreman trace, so this streams that file through
// `trace_monitor --follow` (Law 26). Opened NORMAL while bots are minimized, the obvious window on the
// taskbar; it only reads, so closing it stops nothing.
function fleetConsole() {
  const existing = readRuntime()['fleet-console'];
  if (pidAlive(existing)) {
    console.log(`fleet-console: already open (pid ${existing.pid}).`);
    return existing.pid;
  }
  const title = 'AUREN FLEET - every bot, one scrolling story';
  const trace = paths.workshop('scripts', 'trace.ps1');
  const inner = `$Host.UI.RawUI.WindowTitle = '${title}'; ` +
    `& '${trace}' --follow; ` +
    `Write-Host ''; Read-Host 'the fleet console ended - press Enter to close'`;
  return launch('fleet-console', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner],
    paths.REPO_ROOT, {}, 'Normal');
}

// ── RCON (minimal client — only what a graceful 'stop' needs) ────────────────
function serverProperties() {
  const props = {};
  for (const line of fs.readFileSync(path.join(serverDir(), 'server.properties'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return props;
}

// ── World selection ──────────────────────────────────────────────────────────
// The world the server runs is server.properties `level-name`. currentLevelName() reads it; WORLD
// (--world) overrides. effectiveWorld() is the name we actually act on (repoint / snapshot / logs).
function currentLevelName() {
  try { return serverProperties()['level-name'] || 'world'; } catch (_) { return 'world'; }
}
function effectiveWorld() { return WORLD || currentLevelName(); }


// ── THE CLOCK — one owner for both halves of it ─────────────────────────────────────────────────
// A run's clock is a time AND whether the cycle advances from it, both set together (fleet_runbook's
// CLOCKS declares the three answers, Law 16). Asserted every call, since `advance_time` persists in
// level.dat and pinning it false would leave it false for every run afterwards unless restated (Invariant
// B); not fatal — a clock that would not set leaves a run worth having, and the failure is reported (Law 25).
const CLOCK_SETTINGS = require(paths.bot('js_kernel/utils/server_settings')).CLOCKS;   // one definition, read by the foreman too

async function applyClock(clock) {
  if (clock === 'held') {
    console.log('run: the world keeps whatever time and cycle it holds — a deliberate night run.');
    return;
  }
  const want = CLOCK_SETTINGS[clock];
  if (!want) throw new Error(`fleet_control: '${clock}' is not a clock this runner carries out.`);
  try {
    // `advance_time` is the gamerule that gates the day/night cycle.
    await rconCommand(`gamerule advance_time ${want.cycle}`);
    // Read back after the write, so a rule accepted but not applied is caught here, not reported as set
    // (Law 23).
    const after = (await rconCommand('gamerule advance_time')) || '';
    await rconCommand(`time set ${want.time}`);
    console.log(after.includes(`is currently set to: ${want.cycle}`)
      ? `run: world clock ${want.said}.`
      : `run: ⚠ world time set, but advance_time would not take — server said "${after.trim()}". ` +
        `The light WILL move during this run.`);
  } catch (e) {
    console.log(`run: ⚠ could not set the clock (${e.message}) — the world keeps whatever time it holds.`);
  }
}

function rconPacket(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const pkt = Buffer.alloc(14 + b.length);
  pkt.writeInt32LE(10 + b.length, 0);
  pkt.writeInt32LE(id, 4);
  pkt.writeInt32LE(type, 8);
  b.copy(pkt, 12);
  return pkt;
}

// RCON credentials default to the fleet's own `MinecraftServer/server.properties`. `AUREN_RCON_PASSWORD`
// / `AUREN_RCON_PORT` override for a world this fleet did not start, in the shape `SERVER_ENDPOINT` uses
// for host/port (Law 16). `enable-rcon` is skipped when a password is supplied, since that flag describes
// the fleet's own properties file, not the server actually being addressed.
function rconCommand(command) {
  const envPw = process.env.AUREN_RCON_PASSWORD;
  const envPort = parseInt(process.env.AUREN_RCON_PORT, 10);
  const props = envPw ? {} : serverProperties();
  if (!envPw && props['enable-rcon'] !== 'true') return Promise.reject(new Error('rcon disabled in server.properties'));
  const port = (Number.isFinite(envPort) && envPort > 0 && envPort < 65536)
    ? envPort : (parseInt(props['rcon.port'], 10) || 25575);
  const password = envPw || props['rcon.password'] || '';
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 5000 });
    let stage = 'auth';
    sock.on('connect', () => sock.write(rconPacket(1, 3, password)));
    sock.on('data', (data) => {
      const id = data.readInt32LE(4);
      if (stage === 'auth') {
        // A connected socket with a refused auth means the wrong password was presented, never that
        // nothing is listening — so the error names which password source was used, the one fact only
        // this function knows.
        if (id === -1) {
          sock.destroy();
          reject(new Error(envPw
            ? `rcon auth refused on port ${port} — AUREN_RCON_PASSWORD was set but this server rejected it`
            : `rcon auth refused on port ${port} — no AUREN_RCON_PASSWORD was set, so this fleet used its `
              + `OWN MinecraftServer/server.properties password. If you are addressing a server this fleet `
              + `did not start, it must be TOLD the password.`));
          return;
        }
        stage = 'cmd';
        sock.write(rconPacket(2, 2, command));
      } else {
        const body = data.slice(12, data.length - 2).toString('utf8');
        sock.destroy();
        resolve(body);
      }
    });
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('rcon timeout')); });
  });
}

// ── Subcommands ──────────────────────────────────────────────────────────────
// A world comes up only through the foreman's proved steps (`start_auren.js`, `run.js`, or a bench
// through `bench_world.js`); what stays here stops, inspects and drives. "Stopped" means the process has
// exited, not that the port went dark — Minecraft closes its socket early and saves chunks afterward, so
// the port can lag the fact by minutes. `launch()`'s recorded pid, verified by `pidAlive` against OS start
// time, is read as the fact instead (Law 26); an untracked server leaves only that weaker fact (Law 25).
const SHUTDOWN_WAIT_MS = 180000;
async function serverStop() {
  const tracked = readRuntime()['server'];
  // Both must be quiet: a dark port with a live JVM is the save-in-progress window, and a tracked-dead
  // pid with an open port is a server someone else is running.
  if (!(await probePort(SERVER_PORT)) && !pidAlive(tracked)) {
    console.log('server: not running.');
    return true;
  }
  try {
    await rconCommand('stop');
    console.log('server: rcon stop sent.');
  } catch (e) {
    console.error(`server: rcon stop failed (${e.message}) — NOT killing the process; a hard kill risks world corruption. Stop it manually or fix rcon.`);
    return false;
  }
  if (pidAlive(tracked)) {
    const down = await waitFor(
      `the server process to exit (pid ${tracked.pid}) — it is saving chunks, which is the slow part`,
      async () => !pidAlive(tracked), SHUTDOWN_WAIT_MS, 2000);
    if (down) console.log('server: stopped — the process has exited and the world is unlocked.');
    else console.error(`server: pid ${tracked.pid} is STILL RUNNING ${SHUTDOWN_WAIT_MS / 1000}s after stop. `
      + `It holds the world's session.lock, so do not start another run against this world yet.`);
    return down;
  }
  const down = await waitFor('the server port to close (no pid tracked — this fleet did not launch it)',
    async () => !(await probePort(SERVER_PORT)), 60000, 2000);
  if (down) console.log(`server: port ${SERVER_PORT} is closed. This fleet did not launch that server, `
    + `so whether its process has finished saving is not knowable from here.`);
  return down;
}

async function snapshot() {
  if (await probePort(SERVER_PORT)) {
    console.error('snapshot: server is RUNNING — rollback.ps1 requires it stopped (world files mid-write are not a snapshot). Stop the world first: node Auren_Workshop/fleet_control.js verb shutdown.');
    return false;
  }
  const name = opt('name', null);
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', paths.workshop('scripts', 'world_rollback.ps1'),
    '-Action', 'snapshot', '-Root', serverDir(), '-World', effectiveWorld()];
  if (name) psArgs.push('-Name', name);
  const r = spawnSync('powershell', psArgs, { cwd: serverDir(), encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  const ok = r.status === 0;
  console.log(ok ? 'snapshot: done.' : `snapshot: rollback.ps1 exited ${r.status}.`);
  return ok;
}

// The names the server says are in the world, as an exact list. `list` answers "There are N of a max of
// M players online: A, B, C"; names come after the last colon (the preamble has one too), compared
// exactly, so `Foreman` does not match `ForemanKeeper`.
async function playersOnline() {
  const said = (await rconCommand('list')) || '';
  const tail = said.slice(said.lastIndexOf(':') + 1);
  return tail.split(',').map(s => s.trim()).filter(Boolean);
}

// Delivers one operator verb to the foreman over its 'operator_command' pathway (Law 16).
async function sendVerb(verb, args = {}) {
  const { OPERATOR_VERBS: VERBS } = require(paths.bot('foreman/message_schema'));   // one vocabulary, three processes (Law 16)
  if (!VERBS.has(verb)) {
    console.error(`verb: '${verb}' is not an operator verb (${[...VERBS].join(' | ')}).`);
    return false;
  }
  const port = parseInt(opt('port', String(FOREMAN_PORT_DEFAULT)), 10);
  if (!(await probePort(port))) {
    console.error(`verb: no foreman on port ${port}.`);
    return false;
  }
  const WebSocket = requireWs();
  const { createEnvelope } = require(paths.bot('foreman/message_schema'));
  const sent = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => {
      ws.send(JSON.stringify(createEnvelope('operator_command', 'fleet_control', { verb, args })));
      // The foreman answers nothing on this path; give the send a beat to land, then leave.
      setTimeout(() => { ws.close(); console.log(`verb: '${verb}' sent to foreman.`); resolve(true); }, 500);
    });
    ws.on('error', (e) => { console.error(`verb: socket error — ${e.message}`); resolve(false); });
  });
  if (!sent) return false;

  // 'sent' is the socket write, never the outcome (Law 25). Only `flush` has a cheap, exact postcondition
  // to verify (a cold HQ file on disk); `start` and `stop` are left reporting delivery only.
  if (verb === 'flush') return await waitForColdHQ(parseInt(opt('flush-timeout', '15000'), 10));
  return true;
}

// ── STAGGERED START ─────────────────────────────────────────────────────────────────────────────────
// A broadcast `start` plans every bot at once; twelve route searches contending for one Node event loop
// each can silence a bot long enough for the proxy or server to drop it as dead. Pacing arrivals is the
// default (`--stagger=0` broadcasts). Paced dynamically: each bot's release of the fleet-wide
// planning-token mutex (`foreman_link`'s plan phase)
// signals it is done, and `navigator.js`'s `FIRST MOVE` line is the earlier marker when a bot walks —
// first of either wins, bounded by STAGGER_CEILING_MS for a bot that emits neither (Law 25).
const STAGGER_CEILING_MS = 45000;   // longest this will wait on any one bot before moving on
const STAGGER_MIN_GAP_MS = 1500;    // floor between starts, so an all-ready fleet still trickles in
const FIRST_MOVE_MARK = 'FIRST MOVE';
const PLAN_DONE_MARK   = 'Released planning token';

// Reads the bot's own trace file — the same route `botOnline` uses for the spawn marker (Law 16, one
// story read by whoever needs it). Returns raw text so a caller can baseline it; presence alone is not a
// decision.
function botTraceText(botId) {
  try {
    return fs.readFileSync(require(paths.bot('js_kernel/utils/record_homes')).traceFile(botId), 'utf8');
  } catch (_) { return ''; }   // file not written yet = nothing has happened yet
}

// Counts plan-phase marks, since a bot plans many times over a run and simple presence would read true
// forever after the first one. What pacing needs is whether the count went up since the verb was sent.
function planPhaseCount(text) {
  let n = 0, i = 0;
  for (const mark of [FIRST_MOVE_MARK, PLAN_DONE_MARK]) {
    i = 0;
    while ((i = text.indexOf(mark, i)) !== -1) { n++; i += mark.length; }
  }
  return n;
}

// Waits for `botId` to get past its first plan; returns how it ended, since a ceiling hit is information
// about that bot, not an error. Baselined before the verb: a mark already present when `start` was sent
// belongs to joining, not this start, so only a mark appearing after the verb counts (Law 25).
async function waitForFirstMove(botId, ceilingMs, baselineText) {
  const t0 = Date.now();
  const before = planPhaseCount(baselineText || '');
  while (Date.now() - t0 < ceilingMs) {
    if (planPhaseCount(botTraceText(botId)) > before) return { moved: true, ms: Date.now() - t0 };
    await new Promise(r => setTimeout(r, 250));
  }
  return { moved: false, ms: Date.now() - t0 };
}

async function startStaggered() {
  // --stagger is the ceiling: how long one bot may hold up the next.
  const stagger = parseInt(opt('stagger', String(STAGGER_CEILING_MS)), 10);
  const minGap = parseInt(opt('min-gap', String(STAGGER_MIN_GAP_MS)), 10);

  // pidAlive asks narrowly whether a live process exists to receive the verb, via the runtime pid map
  // confirmed against process start time; botOnline answers whether a spawn was announced in the current
  // trace, and undercounts a bot that relaunched.
  const rt = readRuntime();
  const online = ROSTER.filter(id => pidAlive(rt[id]));

  if (!online.length) {
    console.error('start: no bot processes are running. Start a run first (start_auren.js) — this paces autonomy, it does not launch anyone.');
    return false;
  }
  // One bot is not a storm — broadcasting is correct here and is one fewer moving part.
  if (stagger <= 0 || online.length === 1) {
    if (stagger <= 0 && online.length > 1) {
      console.log(`start: --stagger=0 — broadcasting to all ${online.length} at once. This is the shape that ` +
        `dropped 9 of 12 on 2026-09-03; use it only when you mean to.`);
    }
    return await sendVerb('start');
  }

  console.log(`start: releasing ${online.length} bot(s) one at a time — each waits for the one before it to`);
  console.log(`  finish planning and start moving. No fixed delay; ceiling ${stagger / 1000}s per bot if one never reports.`);

  let started = 0;
  const slow = [];
  for (let i = 0; i < online.length; i++) {
    const id = online[i];
    // Baselined before the verb goes out (see waitForFirstMove) so the wait cannot count anything this
    // start caused before it was sent.
    const baseline = botTraceText(id);
    const ok = await sendVerb('start', { bot: id });
    if (ok) started++;
    if (i === online.length - 1) {
      console.log(`  [${i + 1}/${online.length}] ${id}${ok ? '' : ' — SEND FAILED'}`);
      break;
    }
    // A send that failed is not waited on — there is nothing running to report movement.
    const r = ok ? await waitForFirstMove(id, stagger, baseline) : { moved: false, ms: 0 };
    if (r.moved && r.ms < minGap) await new Promise(res => setTimeout(res, minGap - r.ms));
    const how = !ok ? 'SEND FAILED'
      : r.moved ? `done planning after ${(r.ms / 1000).toFixed(1)}s — releasing the next`
      : `NO plan-done signal in ${(r.ms / 1000).toFixed(0)}s — moving on without it`;
    if (ok && !r.moved) slow.push(id);
    console.log(`  [${i + 1}/${online.length}] ${id} — ${how}`);
  }

  // Delivery, not outcome (Law 25): each bot was sent its verb without another bot's burst on top of it;
  // whether it is still connected is a question for the server.
  console.log(`start: ${started} of ${online.length} verb(s) delivered, paced by each bot finishing its first plan.`);
  if (slow.length) {
    console.log(`  hit the ceiling with no plan-done signal: ${slow.join(', ')} — check these first.`);
  }
  console.log('  Confirm they actually held:  node Auren_Workshop/fleet_control.js status');
  return started === online.length;
}

// Kills the whole process tree, not just the recorded pid, since a recorded pid is often the PowerShell
// wrapper and a bare kill would orphan the node child doing the work (Law 8).
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid);
}

// No trace window is auto-launched: the live observer is the dashboard (monitoring/dashboard.js →
// fleet_logs/traces/dashboard.json), run by hand. Teardown still reaps a 'trace' process defensively.

// A flushed HQ file holds exactly the two bookkeeping keys corporate_headquarters.js reset() writes —
// `schema` (EMPTY_HQ) and `updated_at` (the write stamp). Any third key is an office/chair that survived.
const HQ_BOOKKEEPING_KEYS = new Set(['schema', 'updated_at']);

function hqSurvivingSections(botId) {
  const file = path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${botId}.json`);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return []; }   // absent (never written) or mid-write — nothing claimed to be cold yet
  return Object.keys(obj).filter(k => !HQ_BOOKKEEPING_KEYS.has(k));
}

// `verb flush` reports HQ cold, the state the flush is supposed to produce (Law 25), since delivery on
// that path is unobservable and this reads the real result (Law 26). Scoped to bots that are online,
// since those are the ones that could have received the broadcast; a bot announces readiness with
// "Online at (x, y, z)" in its own watcher trace, and a start empties those files, so a marker found
// belongs to this run.
function botOnline(botId) {
  try {
    return /Online at \(/.test(fs.readFileSync(require(paths.bot('js_kernel/utils/record_homes')).traceFile(botId), 'utf8'));
  } catch (_) { return false; }   // file not yet written = not online yet
}
async function waitForColdHQ(timeoutMs = 15000) {
  const online = ROSTER.filter(botOnline);
  if (online.length === 0) {
    console.error(`flush: no bot is online — nothing could receive the broadcast, so HQ was NOT flushed.`);
    return false;
  }
  const cold = await waitFor(
    `HQ cold for [${online.join(', ')}]`,
    () => online.every(b => hqSurvivingSections(b).length === 0),
    timeoutMs, 500
  );
  // Says what was seen, not just that nothing went wrong: waitFor is silent on success, and a gate
  // whose only evidence is the absence of an error reads identically to one that never ran (Law 6).
  if (cold) console.log(`flush: HQ verified COLD on disk for [${online.join(', ')}] — the run starts with no carried-over offices.`);
  if (!cold) {
    for (const b of online) {
      const left = hqSurvivingSections(b);
      if (left.length) console.error(`flush: ${b} HQ still holds ${left.length} section(s): [${left.join(', ')}]`);
    }
    console.error(`flush: HQ did not go cold within ${timeoutMs}ms — a run started now would be WARM. Reporting failure.`);
  }
  return cold;
}

// Wipes the fleet's memory on disk while nothing is running — a delete, not the `flush` verb, since flush
// addresses running bots through the foreman. Absent is a legal HQ state, what a bot's first boot finds.
// One implementation for every caller wanting a fresh start (Law 16): HQ holds coordinates (transpose
// origin, sited blueprints, chest and furnace cells) for a particular world, so restoring the world
// without wiping this leaves bots acting on terrain the record has since stopped matching.
function wipeMemory() {
  const dir = path.join(BOT_DIR, 'js_kernel');
  let wiped = 0;
  for (const f of fs.readdirSync(dir).filter(n => /^corporate_headquarters.*\.json$/.test(n))) {
    fs.rmSync(path.join(dir, f), { force: true });
    wiped++;
  }
  console.log(`memory-wipe: HQ wiped cold — ${wiped} file(s). Every bot's next boot starts with no offices.`);
  return true;
}

function stopAnyRecording() {
  const file = paths.workshop('tools', 'record_overlay.js');
  // The exit code comes from the file that produces it (Law 16), so a bare literal cannot drift from it.
  // `record_overlay`'s module body is side-effect free, so requiring it here to read the constant is safe.
  const { REQUESTED_NOT_REAPED } = require(file);
  const r = spawnSync(process.execPath, [file, 'stop', '--why=the fleet is coming down'],
    { stdio: 'inherit', cwd: PROJECT_ROOT });
  if (r.status === REQUESTED_NOT_REAPED) return 'requested';
  return r.status === 0 ? 'closed' : 'unclean';
}

async function down() {
  const port = parseInt(opt('port', String(FOREMAN_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  // The foreman takes its own run down: `shutdown` sends its bots home, stops and saves the world it
  // started, and exits — proved by its port going quiet. What is left after it is `serverStop`'s job.
  if (await probePort(port)) {
    await sendVerb('shutdown');
    const gone = await waitFor(`the foreman to finish its shutdown (port ${port} closes)`,
      async () => !(await probePort(port)), SHUTDOWN_WAIT_MS + 60000, 2000);
    console.log(gone ? 'down: the foreman shut its run down.' : 'down: ⚠ the foreman is still answering — continuing with what is left.');
  }

  const film = stopAnyRecording();
  if (film === 'requested') {
    console.log(`\ndown: STOPPED HERE ON PURPOSE — a conducted run is holding this fleet and has been asked ` +
      `to close. It stops the recording, wraps the take and takes the fleet down from its own terminal, ` +
      `within about a slice. Nothing has been killed here; killing it now would cut its teardown in half.`);
    return true;
  }
  if (film === 'unclean') {
    console.error(`\ndown: the film teardown did not report clean (read its output above). Continuing with ` +
      `the fleet — but check for stray camera windows (and, on a recorded run, a recorder still running) before the next run.`);
  }
  for (const name of FLEET_PROCESSES) {
    const entry = rt[name];
    if (entry && pidAlive(entry)) {
      // killTree kills the whole process tree (see its header) — a wrapper's child survives a bare kill
      // and keeps its console window open over a fleet that is gone.
      try { killTree(entry.pid); console.log(`${name}: pid ${entry.pid} terminated.`); }
      catch (e) { console.error(`${name}: could not terminate pid ${entry.pid} — ${e.message}`); }
    }
  }
  if (!has('keep-server')) {
    if (!(await serverStop())) return false;
  }
  // ---- The camera crew comes down with the fleet --------------------------
  // A camera window is a game client connected to a server that is now gone, so `down` closes it too,
  // delegated to start_cameras.ps1 -Down, the owner of that teardown (Law 16). Called unconditionally,
  // since -Down is convergent and costs one honest line even after stopAnyRecording already called it.
  runScript('start_cameras.ps1', ['-Down']);
  // ---- And the console windows that were watching it -----------------------------
  // Every terminal console_window opened is in its ledger; this closes them all and looks again, so what
  // it prints is what is still open. The server is untouched here.
  const reaped = consoleWindow.closeWindows();
  if (reaped.closed.length) console.log(`down: closed ${reaped.closed.length} terminal(s) — ${reaped.closed.map(e => e.label).join(', ')}.`);
  console.log(`down: ${consoleWindow.describeWindows(reaped.stillOpen)}.`);
  console.log('down: done.');
  return true;
}

// One-shot RCON passthrough for operator world-edits (Law 22 recovery), the same client serverStop()
// uses, exposed generically for any command.
async function rconExec(command) {
  if (!command) { console.error('rcon: usage `node fleet_control.js rcon "<command>"`.'); return false; }
  try {
    const reply = await rconCommand(command);
    console.log(`rcon: ${reply || '(no reply)'}`);
    return true;
  } catch (e) {
    console.error(`rcon: failed — ${e.message}`);
    return false;
  }
}

// ── move: the live locomotion test ──────────────────────────────────────────
//   node Auren_Workshop/fleet_control.js move --from=-8,65,16 --to=-18,71,15 [--lookahead=N] [--prejump=off] [--bot=AurenBot]
// Teleports the body to `from`, then asks the locomotion system to walk it to `to`, answering whether a
// body actually crosses this ground on the fleet's own locomotion ladder. The teleport is RCON (an
// authored input); the walk is the signal into the real graph being measured. Addressed when --bot is
// given, so a multi-bot fleet does not send every body to one
// cell (Law 4). Returns whether the teleport landed and the verb was delivered, never whether the bot
// arrived (Law 25): the arrival verdict is written to the bot's own trace (`watcher_<BotId>.json`, tag
// move_injector).
function parseCell(text, label) {
  const parts = String(text || '').split(',').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
    console.error(`move: --${label} must be x,y,z (got '${text}').`);
    return null;
  }
  return { x: Math.floor(parts[0]), y: Math.floor(parts[1]), z: Math.floor(parts[2]) };
}

async function moveTest() {
  const from = parseCell(opt('from', ''), 'from');
  const to = parseCell(opt('to', ''), 'to');
  if (!from || !to) { console.error('move: usage `move --from=x,y,z --to=x,y,z [--lookahead=N] [--prejump=off] [--bot=AurenBot]`.'); return false; }
  const bot = opt('bot', ROSTER[0]);
  // --lookahead: walkable cells locomotion may fuse into one continuous press (default 3; 1 is per-cell).
  const lookahead = Math.max(1, Math.min(8, parseInt(opt('lookahead', '3'), 10) || 3));
  // --prejump=off removes the early jump while keeping fusion, isolating which caused a slow leg.
  const prejump = !/^(off|0|false|no)$/i.test(String(opt('prejump', 'on')));

  // Teleport, then verify (a silently missed RCON tp would read as a mysteriously long walk) (Law 23).
  try {
    await rconCommand(`tp ${bot} ${from.x + 0.5} ${from.y} ${from.z + 0.5}`);
  } catch (e) {
    console.error(`move: teleport failed — ${e.message}`);
    return false;
  }
  let landed = null;
  for (let i = 0; i < 20 && !landed; i++) {
    await new Promise(r => setTimeout(r, 250));
    let reply = '';
    try { reply = await rconCommand(`data get entity ${bot} Pos`); } catch (_) { continue; }
    const nums = String(reply).match(/-?\d+\.?\d*/g);
    if (!nums || nums.length < 3) continue;
    const at = { x: Math.floor(Number(nums[nums.length - 3])), y: Math.floor(Number(nums[nums.length - 2])), z: Math.floor(Number(nums[nums.length - 1])) };
    if (Math.abs(at.x - from.x) <= 1 && Math.abs(at.z - from.z) <= 1 && Math.abs(at.y - from.y) <= 3) landed = at;
  }
  if (!landed) {
    console.error(`move: '${bot}' never landed on (${from.x},${from.y},${from.z}) — is it connected, and is that cell loaded?`);
    return false;
  }
  console.log(`move: '${bot}' placed at (${landed.x},${landed.y},${landed.z}); dispatching walk to (${to.x},${to.y},${to.z}) at lookahead ${lookahead}, prejump ${prejump ? 'on' : 'off'}.`);
  const ok = await sendVerb('move', { to, bot, lookahead, prejump });
  if (ok) console.log(`move: verb delivered. The ARRIVAL verdict is the bot's — read watcher_${bot}.json (tag move_injector).`);
  return ok;
}

// Locomotion of a single bot, tested in isolation, lives at `tools/combat_drive_probe.js`
// (Law 16 — one route to one measurement).

async function status() {
  const port = parseInt(opt('port', String(FOREMAN_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  const serverUp = await probePort(SERVER_PORT);
  console.log(`server (${SERVER_PORT}):   ${serverUp ? 'UP' : 'down'}`);
  console.log(`foreman (${port}): ${(await probePort(port)) ? 'UP' : 'down'}`);

  // Who is actually in the world, asked of the server: a pid says a process exists, only the player
  // list says a body arrived (Law 25).
  if (serverUp) {
    try {
      const here = await playersOnline();
      // The server truncates `list` at roughly 180 characters (marked "..."), so on a full fleet the
      // tail of the roster can be missing; that truncation is stated to the operator explicitly.
      const cut = here[here.length - 1] === '...';
      const names = cut ? here.slice(0, -1) : here;
      console.log(`in world:        ${names.length ? names.join(', ') : '(nobody)'}`);
      if (cut) console.log(`                 ...and more - the server truncates this list. Ask about one player with:`);
      if (cut) console.log(`                 node fleet_control.js rcon "data get entity <name> playerGameType"`);
    } catch (e) { console.log(`in world:        unknown — rcon did not answer (${e.message})`); }
  }

  // The one fleet list (Law 16) — same set the teardowns use, so a process can never be running,
  // killable, and invisible to status all at once.
  for (const name of FLEET_PROCESSES_WITH_SERVER) {
    const e = rt[name];
    if (e) console.log(`  ${name}: pid ${e.pid} ${pidAlive(e) ? 'alive' : 'gone'} (spawned ${e.started_at})`);
  }
  return true;
}

// ── Takeover: the operator's deliberate kill switch ──────────────────────────
// The one place a hard kill is sanctioned: serverStop refuses to hard-kill (world corruption, Law 17/13),
// and takeover is the operator accepting that risk to guarantee a stop when RCON is dead or hung. Tries
// graceful first, force-kills what is left, and verifies the ports are dead before claiming success.
// forceKill takes the recorded runtime entry so pidAlive can confirm the pid is still ours (Law 23).
function forceKill(label, entry) {
  if (!pidAlive(entry)) return;
  const pid = entry.pid;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8' });
    else process.kill(pid, 'SIGKILL');
    console.log(`${label}: pid ${pid} force-killed.`);
  } catch (e) {
    console.error(`${label}: force-kill of pid ${pid} failed — ${e.message}`);
  }
}

async function takeover() {
  console.log('takeover: forcing the whole stack down (bots + server), graceful-first…');
  const port = parseInt(opt('port', String(FOREMAN_PORT_DEFAULT)), 10);
  const rt = readRuntime();

  // 1) Courtesy graceful pass — let bots persist HQ and the world flush if those paths still work.
  if (await probePort(port)) {
    try { await sendVerb('stop'); await new Promise(r => setTimeout(r, 3000)); } catch (_) { /* graceful is best-effort */ }
  }
  if (await probePort(SERVER_PORT)) {
    try { await rconCommand('stop'); await new Promise(r => setTimeout(r, 3000)); } catch (_) { /* rcon may be dead — that's why takeover exists */ }
  }

  // 2) Force-kill whatever graceful left standing — every registered fleet pid, tree and all.
  for (const name of FLEET_PROCESSES_WITH_SERVER) {
    const e = rt[name];
    if (e) forceKill(name, e);
  }

  // 3) Orphan server: a java on the port with no registered pid (or one that survived) — kill by port.
  if (await probePort(SERVER_PORT)) {
    console.log(`takeover: server still on ${SERVER_PORT} after graceful + registered kill — killing by port.`);
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${SERVER_PORT} -State Listen -ErrorAction SilentlyContinue | ` +
        `Select-Object -ExpandProperty OwningProcess | ForEach-Object { taskkill /F /PID $_ }`],
        { encoding: 'utf8' });
      process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    }
  }

  // A killed listener can hold its port for a moment; the verdict is read after it settles (Law 25).
  await new Promise(r => setTimeout(r, 1500));
  const serverDown = !(await probePort(SERVER_PORT));
  const foremanDown = !(await probePort(port));
  console.log(`takeover: server ${serverDown ? 'down' : 'STILL UP'}, foreman ${foremanDown ? 'down' : 'STILL UP'}.`);
  return serverDown && foremanDown;
}

// ── Configuration and bring-up live elsewhere ───────────────────────────────
// One way to run the fleet and one way to configure it (Law 16): `run_config.js` authors every setting
// before anything starts, and `run.js` reads it once and performs the whole run, raising bots through the
// foreman's desk like any other player. What lives here is the plumbing: `snapshot`, `clock`, `down`,
// `status`, `rcon`, `memory-wipe`, `verb`. `runScript` survives only because `stopAnyRecording` uses it.
const SCRIPTS_DIR = paths.workshop('scripts');

function runScript(name, argv) {
  const file = path.join(SCRIPTS_DIR, name);
  console.log(`test: → ${name} ${argv.join(' ')}\n`);
  return spawnSync('powershell', ['-NoProfile', '-File', file, ...argv], { stdio: 'inherit' }).status === 0;
}


// ── World spawn, read from the world itself ─────────────────────────────────────────────────────────
// The centre of the spawn-protected square, taken from `level.dat` — the same value the server sends a
// client in its `spawn_position` packet, which is what the bots gate on (Law 23; no rcon verb answers
// this). level.dat has held this fact under two shapes: through 1.21.x as three loose ints on `Data`
// (`SpawnX`/`SpawnY`/`SpawnZ`); from 26.1 as a `spawn` compound holding `pos` alongside pitch, yaw and
// dimension, with the old keys gone. Both shapes are read and translated to one `{x, y, z}` answer, so a
// caller need not know which world version it is talking to.
async function worldSpawn(worldName) {
  const file = path.join(serverDir(), worldName, 'level.dat');
  if (!fs.existsSync(file)) return null;
  const nbt = moduleHomes.requireFromHomes('prismarine-nbt');
  const parsed = (await nbt.parse(fs.readFileSync(file))).parsed.value.Data.value;

  const pos = parsed.spawn?.value?.pos?.value;                                  // 26.1 and later
  const triple = Array.isArray(pos) ? pos : [parsed.SpawnX?.value, parsed.SpawnY?.value, parsed.SpawnZ?.value];
  const [x, y, z] = triple;
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
(async () => {
  const table = {
    'status': status,
    'snapshot': snapshot,
    // --bot narrows the verb to one bot, forwarded to the foreman's `only` addressee; without it the
    // verb reaches the whole fleet. `verb start` with no --bot is the one verb that must not be a
    // broadcast (see startStaggered); every other verb, and `start` aimed at one bot, goes straight
    // through.
    'verb': () => (positional[0] === 'start' && !opt('bot'))
      ? startStaggered()
      : sendVerb(positional[0], opt('bot') ? { bot: opt('bot') } : {}),
    // Cold and offline; pairing this with a world restore is enforced by the caller that owns both
    // halves, since only it knows which world is being restored.
    'memory-wipe': () => wipeMemory(),
    // Standalone: the window it opens is read-only, and the usual reason to want it is that it was
    // closed while the fleet kept running.
    'fleet-console': () => { fleetConsole(); return true; },
    // The terminal check on its own, for any moment between runs.
    'windows': () => { console.log(`windows: ${consoleWindow.describeWindows(consoleWindow.openWindows())}.`); return true; },
    'down': down,
    'takeover': takeover,
    'rcon': () => rconExec(positional[0]),
    // Exposed as a verb so the PowerShell benches set the clock the same way as an authored run, rather
    // than sending their own `time set` over the generic rcon passthrough (Law 16).
    'clock': async () => {
      // A wrong word is a correction, never a throw: the cause is named and the form that works comes
      // with it (Law 13).
      const want = positional[0] || 'dawn';
      if (want !== 'held' && !CLOCK_SETTINGS[want]) {
        console.error(`clock: '${want}' is not a clock setting. ` +
          `Valid: ${[...Object.keys(CLOCK_SETTINGS), 'held'].join(' | ')} — ` +
          `'dawn' starts at sunrise and lets the day run, 'day' pins midday and freezes the cycle, ` +
          `'held' leaves the world exactly as it is. Usage: node Auren_Workshop/fleet_control.js clock day`);
        return false;
      }
      await applyClock(want);
      return true;
    },
    'move': moveTest,
    // World spawn as one JSON line, so `run.js` measures distance from the centre off the same
    // level.dat reader the spawn-protection drill uses (Law 16).
    'world-spawn': async () => {
      const world = effectiveWorld();
      const at = await worldSpawn(world);
      if (!at) {
        console.error(`world-spawn: no spawn could be read from ${path.join(serverDir(), world, 'level.dat')} `
          + `— the file is missing or holds no SpawnX/SpawnY/SpawnZ.`);
        return false;
      }
      console.log(JSON.stringify(at));
      return true;
    },
    // Prints the canonical roster (seniority order, comma-joined), the one source the PowerShell
    // launchers read (Law 16).
    'roster': () => { console.log(ROSTER.join(',')); return true; },
    // What the LIVE fleet is warning about, asked of the foreman's door: the run, each body's line counts,
    // and every warning folded by unit and shape. --since=<ISO> keeps the shapes raised again after it.
    'warnings': async () => {
      paths.registerAliases();
      const r = await require(paths.bot('foreman', 'foreman_door.js')).query();
      if (!r.ok) { console.error(`warnings: ${r.error}`); return false; }
      const since = opt('since');
      const rows = r.warnings.filter(w => !since || w.last_at > since).sort((a, b) => b.count - a.count);
      console.log(JSON.stringify({ asked_at: new Date().toISOString(), run: r.run, world_state: r.world && r.world.state,
        bots: r.bots.length, departed: r.departed.map(d => d.id) }));
      for (const b of r.bots) {
        console.log(JSON.stringify({ bot: b.id, dead: b.dead, warn: b.warn, error: b.error, summary: b.summary,
          cubes_finished: b.cubes_finished, last_error: b.last_error,
          quiet_sec: b.last_line_at ? Math.round((Date.now() - Date.parse(b.last_line_at)) / 1000) : null,
          last_line: b.last_line }));
      }
      for (const w of rows) {
        console.log(JSON.stringify({ unit: w.unit, count: w.count, bots: w.bots.length, first_at: w.first_at,
          last_at: w.last_at, shape: w.shape, sample: w.sample }));
      }
      return true;
    },
  };
  const fn = table[cmd];
  if (!fn) {
    console.error(`fleet_control: unknown command '${cmd || ''}'. Commands: ${Object.keys(table).join(' | ')}`);
    process.exit(1);
  }
  const ok = await fn();
  process.exit(ok ? 0 : 1);
})();
