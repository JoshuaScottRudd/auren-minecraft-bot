'use strict';
// foreman_world — THE FOREMAN'S HOLD ON THE WORLD. It starts a local Minecraft server or reaches a remote
// one, says in words why when it cannot, watches the server it started, and stops that server at the end.
//
// ── WHO OWNS THE PROCESS? THE FOREMAN (Architect 2026-09-18) ────────────────────────────────────────
// *"Foreman starts first before the server. Then if it says in its config a local server then it will start
// the server. If not and it's on a public one then you give it the address and it attempts to connect. If
// any part of the process fails then the Foreman is a live process that can troubleshoot… how does shutting
// down a server work after a soak or a problem?… I want foreman to handle that… Who owns the process?
// Foreman does."*
//
// Before this file the world was started by one workshop script (`host_and_run` → `fleet_control
// server-start`), checked by another (`run.js`), prepared by a third (`start_auren.prepareOwnServer`), and
// stopped by a fourth (`fleet_control down`). A failure in any of them surfaced as the next one's confusing
// error, because the process that could have read the server's own output had already exited. Now the one
// process that lives for the whole run holds the server as its child and reads every line it prints.
//
// WHAT `foreman_config.where` DECIDES:
//   'local'   startLocal: write the settings the bots need, mint a one-time console password, launch Java,
//             wait for the server's own "Done", open the console, set the gamerules. Stopped by stopServer.
//   'remote'  reachRemote: connect to host:port and then the console, with a sentence for each way that
//             fails. Never started, never stopped — that world belongs to somebody else.
//
// THE SAFETY KEPT FROM THE OLD RULING (2026-09-11: nothing here starts or stops a world it did not create).
// A local start refuses when a server is already answering on the port, because that server is somebody
// else's, and stopServer acts only on the child this process launched. A world is never killed: stop is the
// server's own `stop` command, and a server that will not finish saving is reported, not ended, because a
// killed JVM can tear the chunk it was writing.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG = require('../foreman_config');
const workstation = require('@utils/workstation');
const settings = require('@utils/server_settings');
const rcon = require('@utils/rcon_link');
const { RECORDS_DIR } = require('@utils/record_homes');
const consoleWindow = require('@utils/console_window');
const { guardExternal } = require('@utils/external_library_guard');

const WHERE = ['local', 'remote'];
const STARTUP_LIMIT_MS = 300000;      // a first boot generates the spawn area; five minutes is generous
const CONSOLE_OPEN_LIMIT_MS = 60000;  // the console opens a moment after "Done"
const SHUTDOWN_LIMIT_MS = 180000;     // measured: saving ~1000 chunks took 2m34s (fleet_control, 2026-09-10)
const REACH_DELAYS_MS = [0, 5000, 15000];
const TAIL_LINES = 80;
const JAVA_ARGS = ['-Xmx4G', '-Xms4G', '-jar', 'server.jar', 'nogui'];   // 4 GB: fleet_control's 2026-09-10 soak

// What the world is doing right now. `ours` is the whole difference between a world this process may stop
// and one it may not.
const WORLD = {
  where: null, state: 'not-started', reason: null, host: null, port: null, folder: null,
  ours: false, pid: null, startedAt: null, upAt: null,
};
let child = null;
let serverWindow = null;
let stopping = false;
const tail = [];
const unexpectedExitListeners = [];

function status() { return { ...WORLD }; }

// THE TERMINAL'S `shutdown` VERB arrives at the hub, and the shutdown road lives in foreman.js (it holds the
// body and the fetched bots). This is the one wire between them: foreman.js registers its road, the hub asks.
let shutdownRoad = null;
function onShutdownAsked(fn) { shutdownRoad = fn; }
function askShutdown(why) {
  if (!shutdownRoad) return false;
  shutdownRoad(why);
  return true;
}
function endpoint() { return { host: WORLD.host, port: WORLD.port }; }
function onUnexpectedExit(fn) { unexpectedExitListeners.push(fn); }

function failed(reason, lines = []) {
  WORLD.state = 'failed';
  WORLD.reason = reason;
  return { ok: false, reason, lines };
}

// ── READING THE SERVER'S OWN WORDS ──────────────────────────────────────────────────────────────────
// Each row is a line the server (or Java) prints when a start goes wrong, and the sentence a person acts on.
// The first match in the tail wins, so the list runs from the most specific to the most general.
const DIAGNOSES = [
  { re: /You need to agree to the EULA/i,
    say: (d) => `The server will not run until its licence is accepted, and that is your choice to make: open ${path.join(d, 'eula.txt')} and set eula=true.` },
  { re: /FAILED TO BIND TO PORT|BindException|Address already in use/i,
    say: () => 'Another program is already using the server\'s port. Close it (often a server left running from an earlier start), or change server-port in server.properties.' },
  { re: /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime/i,
    say: () => `The Java found is too old for this server. Install Java ${workstation.JAVA_FLOOR} or newer.` },
  { re: /Could not reserve enough space|Invalid maximum heap size|Initial heap size set to a larger value|Error occurred during initialization of VM/i,
    say: () => 'Java could not get the 4 GB of memory the server is started with. Close other programs, or run on a computer with more memory.' },
  { re: /Unable to access jarfile/i,
    say: (d) => `There is no server.jar in ${d}. Put the Minecraft server jar there, named server.jar.` },
  { re: /session\.lock|already locked|DirectoryLock/i,
    say: () => 'The world folder is locked by another server that is still running on it. Stop that one first.' },
  { re: /This crash report has been saved to:\s*(.+)$/im,
    say: (d, m) => `The server crashed. Its own crash report: ${m[1].trim()}` },
  { re: /Stopping server|Stopping the server/i,
    say: () => 'The server was stopped from its own console or by an operator in the game (/stop).' },
  { re: /Failed to start the minecraft server|Exception in server tick loop|Encountered an unexpected exception/i,
    say: () => 'The server failed with an error of its own; its last lines are below.' },
];

function diagnose(folder, code) {
  const text = tail.join('\n');
  for (const d of DIAGNOSES) {
    const m = d.re.exec(text);
    if (m) return d.say(folder, m);
  }
  return `The server exited (code ${code}) without saying why in a way the foreman recognises; its last lines are below.`;
}

function lastLines(n = 12) { return tail.slice(-n); }

// ── LOCAL ───────────────────────────────────────────────────────────────────────────────────────────

function findFolder() {
  if (CONFIG.serverFolder && !process.env.AUREN_SERVER_DIR) process.env.AUREN_SERVER_DIR = CONFIG.serverFolder;
  const told = process.env.AUREN_SERVER_DIR;
  // A folder that holds server.jar and no server.properties is a server nobody has started yet. It gets its
  // own sentence, because "no server folder found" would send the person looking for a folder they have.
  if (told && fs.existsSync(path.join(told, 'server.jar')) && !fs.existsSync(path.join(told, 'server.properties'))) {
    return { error: `${told} has a server.jar that has never been started, so it has no server.properties yet. `
      + 'Start it once by hand (java -jar server.jar nogui), accept the licence in eula.txt, then start Auren again.' };
  }
  const found = workstation.findServerDir();
  if (!found.dir) {
    return { error: `foreman_config.js says where: 'local', so the foreman starts your server — and no server folder was found. `
      + `Tried: ${found.tried.join(', ')}. THE SPOT TO CHANGE: foreman_config.js -> serverFolder (the folder holding server.properties).` };
  }
  return { dir: found.dir };
}

function eulaAccepted(dir) {
  const file = path.join(dir, 'eula.txt');
  return fs.existsSync(file) && /^\s*eula\s*=\s*true\s*$/mi.test(fs.readFileSync(file, 'utf8'));
}

function openServerLog() {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  return fs.createWriteStream(path.join(RECORDS_DIR, 'console_server.log'), { flags: 'a' });
}

// Lines repeated in the foreman's own window: the milestones and the server's warnings and errors. The whole
// console is in the server's own window and in fleet_logs/console_server.log; the console's per-connection
// thread chatter (one pair of lines per command the foreman sends) stays there.
const SHOWN = /Done \(|Starting minecraft server|Preparing level|WARN|ERROR|Exception|Stopping|eula/i;
const NOT_SHOWN = /RCON (Client|Listener)|restricted method|enable-native-access|Restricted methods|java\.lang\.System::load/i;

// ── NO INVISIBLE PROCESSES (Architect 2026-09-18: *"no visible windows. no invisible processes allowed"*) ──
// The server is this process's child with its console piped here, so it has no window of its own. It gets
// one: a follower on its console log, the same kind every fetched bot gets (`console_window.followFile`),
// opened when the server is launched and closed when this process ends — the server is stopped by then, and
// the foreman's alarm carries the last lines of a crash into its own window and record.
function closeServerWindow() {
  if (serverWindow) consoleWindow.closeWindow(serverWindow.pid);
  serverWindow = null;
}
process.on('exit', closeServerWindow);

async function startLocal(log) {
  const folder = findFolder();
  if (folder.error) return failed(folder.error);
  const dir = folder.dir;
  WORLD.folder = dir;

  if (!fs.existsSync(path.join(dir, 'server.jar'))) {
    return failed(`There is no server.jar in ${dir}. Put the Minecraft server jar there, named server.jar.`);
  }
  if (!eulaAccepted(dir)) {
    return failed(`The server will not run until its licence is accepted, and that is your choice to make: open `
      + `${path.join(dir, 'eula.txt')} and set eula=true (the licence: https://aka.ms/MinecraftEULA).`);
  }
  const java = workstation.findJava();
  if (!java.exe) {
    return failed(`No Java ${workstation.JAVA_FLOOR} or newer was found, and the server needs it. `
      + `Tried: ${java.tried.join(', ')}. Install a Java ${workstation.JAVA_FLOOR}+ runtime (for example Eclipse Temurin).`);
  }

  const gamePort = settings.serverPort(dir);
  if (await settings.serverAnswers(gamePort)) {
    return failed(`A server is already answering on port ${gamePort}, and this foreman did not start it, so it will `
      + `not start a second one or stop that one. Stop it (a server left from an earlier start is the usual cause), `
      + `or, to join it as it is, set where: 'remote' in foreman_config.js with its console password.`);
  }

  // THE SETTINGS, WRITTEN AND SAID OUT LOUD (Architect 2026-09-14: *"it should instead report loudly what it
  // did and why"*). The server is down, so a fresh one-time console password is minted and read by this boot.
  const prep = settings.prepare(dir, { serverUp: false });
  if (prep.changes.length) {
    log(`SERVER SETTINGS CHANGED in ${prep.file}:`);
    for (const c of prep.changes) log(`   ${c.key}  — ${c.why}`);
  }
  if (prep.changes.some(c => c.key.startsWith('online-mode'))) {
    log('   NOTE: in offline mode a server checks no accounts. Keep it private or turn on the whitelist.');
  }

  // THE ENVIRONMENT IS HOW EVERY CHILD LEARNS THE WORLD — bots read foreman_config at their own load, and
  // foreman_config reads the environment first. Set before any child exists.
  process.env.AUREN_SERVER_DIR = dir;
  process.env.AUREN_SERVER_HOST = 'localhost';
  process.env.AUREN_SERVER_PORT = String(gamePort);
  process.env.AUREN_RCON_PASSWORD = prep.password;
  process.env.AUREN_RCON_PORT = String(prep.rconPort);
  WORLD.host = 'localhost';
  WORLD.port = gamePort;

  const sink = openServerLog();
  serverWindow = consoleWindow.followFile({ title: 'auren server', logFile: path.join(RECORDS_DIR, 'console_server.log') });
  if (!serverWindow) log('WARNING could not open a window on the server console; it is in fleet_logs/console_server.log.');
  log(`starting the Minecraft server in ${dir} (port ${gamePort}); its full console goes to fleet_logs/console_server.log`);
  WORLD.state = 'starting';
  WORLD.startedAt = new Date().toISOString();
  child = spawn(java.exe, JAVA_ARGS, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  WORLD.ours = true;
  WORLD.pid = child.pid;

  let ready = null;
  const readyOnce = new Promise(r => { ready = r; });
  const onLine = (line) => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
    if (SHOWN.test(line) && !NOT_SHOWN.test(line)) log(`[server] ${line}`);
    if (/\]: Done \(/.test(line)) ready('done');
  };
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (chunk) => {
      sink.write(chunk);
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
  }
  // A write to the console after the server has gone is not a fault worth a crash; the exit below says why.
  child.stdin.on('error', (e) => log(`server console input closed: ${e.message}`));
  child.on('error', (e) => { tail.push(`[foreman] could not launch Java: ${e.message}`); ready('exit'); });
  child.on('exit', (code, signal) => {
    sink.end();
    const wasUp = WORLD.state === 'up';
    ready('exit');
    if (stopping) { WORLD.state = 'stopped'; return; }
    WORLD.state = 'failed';
    WORLD.reason = diagnose(dir, signal || code);
    if (wasUp) for (const fn of unexpectedExitListeners) fn(WORLD.reason, lastLines());
  });

  const limit = setTimeout(() => ready('timeout'), STARTUP_LIMIT_MS);
  const how = await readyOnce;
  clearTimeout(limit);
  if (how === 'exit') return failed(diagnose(dir, child.exitCode), lastLines());
  if (how === 'timeout') {
    return failed(`The server started but did not finish loading in ${STARTUP_LIMIT_MS / 60000} minutes. It is `
      + 'still running and the foreman will stop it; its last lines are below.', lastLines());
  }

  // THE CONSOLE OPENS A MOMENT AFTER "Done". Everything the foreman does next (placing a crew, the gamerules)
  // goes through it, so the world is not up until the console answers.
  const consoleUp = await waitForConsole();
  if (!consoleUp.ok) {
    return failed(`The server is running, but its console never answered on port ${prep.rconPort}: ${consoleUp.reason}`, lastLines());
  }
  await applyGamerules(log);
  WORLD.state = 'up';
  WORLD.upAt = new Date().toISOString();
  log(`the world is up — localhost:${gamePort}, console on ${prep.rconPort}. This foreman started it and will stop it.`);
  return { ok: true };
}

async function waitForConsole() {
  const until = Date.now() + CONSOLE_OPEN_LIMIT_MS;
  let last = { ok: false, reason: 'not asked yet' };
  while (Date.now() < until) {
    last = await rcon.probe();
    if (last.ok) return last;
    await new Promise(r => setTimeout(r, 1000));
  }
  return last;
}

// ── THE GAMERULES, EVERY START (fleet_control's reasoning, now in server_settings) ──────────────────────
// Read back after writing, because a rule the server accepted and did not apply must not be reported as set.
async function applyGamerules(log) {
  for (const [rule, want] of Object.entries(settings.REQUIRED_GAMERULES)) {
    const r = await guardExternal('foreman_world', `gamerule ${rule}`, () =>
      rcon.once([`gamerule ${rule}`, `gamerule ${rule} ${want}`, `gamerule ${rule}`]));
    const after = r.ok ? r.value[2].body : r.reason;
    log(r.ok && after.includes(want) ? `gamerule ${rule}=${want}` : `WARNING gamerule ${rule} would not take — "${after}"`);
  }
}

// ── REMOTE ──────────────────────────────────────────────────────────────────────────────────────────

// knock(host, port) → { ok } | { ok:false, reason } — a bare connect, with each way it fails said in words.
function knock(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 });
    s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, reason: `nothing answered at ${host}:${port} within 5 s — the address is wrong, the server is off, or a firewall is in the way` }); });
    s.once('error', (e) => {
      const why = {
        ENOTFOUND: `no computer is called '${host}' — check the address`,
        EAI_AGAIN: `the name '${host}' could not be looked up right now — check this computer's internet connection`,
        ECONNREFUSED: `the computer at ${host} is there, but nothing is listening on port ${port} — the server is off or on another port`,
        EHOSTUNREACH: `the computer at ${host} cannot be reached from here`,
        ENETUNREACH: 'this computer has no network route to that address',
        ETIMEDOUT: `nothing answered at ${host}:${port} — the server is off, or a firewall is in the way`,
      }[e.code] || `${e.code || ''} ${e.message}`.trim();
      resolve({ ok: false, reason: why });
    });
  });
}

async function reachRemote(log) {
  const host = CONFIG.host;
  const port = CONFIG.port;
  WORLD.host = host;
  WORLD.port = port;
  if (!host) return failed("foreman_config.js says where: 'remote' and gives no host. THE SPOT TO CHANGE: foreman_config.js -> host.");
  if (!CONFIG.rconPassword) {
    return failed(`foreman_config.js says where: 'remote' (${host}:${port}) and gives no console password. A crew is `
      + 'placed through that world\'s console, so the owner of the world has to give you its password. '
      + 'THE SPOT TO CHANGE: foreman_config.js -> rconPassword (and rconPort).');
  }
  WORLD.state = 'starting';
  let knocked = null;
  for (const wait of REACH_DELAYS_MS) {
    if (wait) { log(`world not reached (${knocked.reason}); trying again in ${wait / 1000}s`); await new Promise(r => setTimeout(r, wait)); }
    knocked = await knock(host, port);
    if (knocked.ok) break;
  }
  if (!knocked.ok) return failed(`Could not reach the world at ${host}:${port}: ${knocked.reason}. THE SPOT TO CHANGE: foreman_config.js -> host, port.`);
  const consoleUp = await rcon.probe({ creds: { port: CONFIG.rconPort, password: CONFIG.rconPassword } });
  if (!consoleUp.ok) {
    return failed(`The world at ${host}:${port} answers, but its console on port ${CONFIG.rconPort} refused the foreman: `
      + `${consoleUp.reason}. THE SPOT TO CHANGE: foreman_config.js -> rconPort, rconPassword (they must match that server's rcon.port and rcon.password).`);
  }
  process.env.AUREN_SERVER_HOST = host;
  process.env.AUREN_SERVER_PORT = String(port);
  process.env.AUREN_RCON_PASSWORD = CONFIG.rconPassword;
  process.env.AUREN_RCON_PORT = String(CONFIG.rconPort);
  WORLD.state = 'up';
  WORLD.upAt = new Date().toISOString();
  log(`the world is up — ${host}:${port}, console on ${CONFIG.rconPort}. Somebody else runs it; this foreman will not stop it.`);
  return { ok: true };
}

// bringUp(log) → { ok } | { ok:false, reason, lines } — whichever the config names.
async function bringUp(log) {
  WORLD.where = CONFIG.where;
  if (!WHERE.includes(CONFIG.where)) {
    return failed(`foreman_config.js says where: '${CONFIG.where}', which is neither 'local' nor 'remote'. THE SPOT TO CHANGE: foreman_config.js -> where.`);
  }
  return CONFIG.where === 'local' ? startLocal(log) : reachRemote(log);
}

// stopServer(log) → { stopped: boolean, reason } — the server's own `stop`, and a wait for Java to exit.
// Acts only on the server this process launched. Never kills it (see the header).
async function stopServer(log) {
  if (!WORLD.ours || !child || child.exitCode !== null || child.signalCode !== null) {
    return { stopped: false, reason: WORLD.ours ? 'it had already exited' : 'this foreman did not start it' };
  }
  stopping = true;
  WORLD.state = 'stopping';
  log('stopping the Minecraft server — it saves the world first, which can take a couple of minutes');
  const exited = new Promise(r => child.once('exit', () => r(true)));
  child.stdin.write('stop\n');
  const started = Date.now();
  const nag = setInterval(() => log(`still saving (${Math.round((Date.now() - started) / 1000)}s)`), 15000);
  const done = await Promise.race([exited, new Promise(r => setTimeout(() => r(false), SHUTDOWN_LIMIT_MS))]);
  clearInterval(nag);
  if (done) {
    WORLD.state = 'stopped';
    log(`the Minecraft server has stopped and the world is saved (${Math.round((Date.now() - started) / 1000)}s).`);
    return { stopped: true, reason: null };
  }
  const why = `the server (pid ${child.pid}) is still running ${SHUTDOWN_LIMIT_MS / 1000}s after stop. It holds the `
    + 'world folder, so do not start another run on this world until it has gone.';
  log(`WARNING ${why}`);
  return { stopped: false, reason: why };
}

module.exports = { bringUp, stopServer, status, endpoint, onUnexpectedExit, lastLines, onShutdownAsked, askShutdown };
