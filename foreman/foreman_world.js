'use strict';
// foreman_world — the foreman's hold on the world. It starts a local Minecraft server or reaches a remote
// one, says in words why when it cannot, watches the server it started, and stops that server at the end.
//
// The foreman owns the server process for the whole run, holding it as its own child and reading every
// line it prints, so a failure anywhere is read by the one process still alive to explain it.
//
// WHAT `foreman_config.where` DECIDES:
//   'local'   localSteps: write the settings the bots need, mint a one-time console password, launch Java,
//             wait for the server's own "Done", open the console, set the gamerules. Stopped by stopServer.
//   'remote'  remoteSteps: connect to host:port and then the console, with a sentence for each way that
//             fails. Never started, never stopped — that world belongs to somebody else.
//
// Nothing here starts or stops a world it did not create. A local start refuses when a server is already
// answering on the port, because that server is somebody else's, and stopServer acts only on the child
// this process launched. A world is never killed: stop is the server's own `stop` command, and a server
// that will not finish saving is reported, not ended, because a killed JVM can tear the chunk it was
// writing.

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
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');
const { runSteps } = require('./foreman_steps');
const plan = require('./foreman_plan');
const processPriority = require('./utils/process_priority');

const WHERE = ['local', 'remote'];
const STARTUP_LIMIT_MS = 300000;      // a first boot generates the spawn area; five minutes is generous
const CONSOLE_OPEN_LIMIT_MS = 60000;  // the console opens a moment after "Done"
const SHUTDOWN_LIMIT_MS = 180000;     // a large save (~1000 chunks) can take over two minutes to finish
const REACH_LIMIT_MS = 20000;          // a remote world is knocked on every 5 s for this long
const TAIL_LINES = 80;
// Java grows its heap with demand while leaving startup memory available to the desktop and bodies.
const JAVA_ARGS = ['-Xmx4G', '-Xms512M', '-jar', 'server.jar', 'nogui'];
const PULSE_MS = 60000;               // how often the server is asked how its ticks and entities stand
const LAG_RE = /Can't keep up!.*Running (\d+)ms or (\d+) ticks behind/;

// ── WHAT JAVA RECORDS ABOUT ITSELF, EVERY RUN ───────────────────────────────────────────────────────
// A server that stalls says only "Can't keep up", after the fact. These two records say why, from inside Java:
//   server_gc.log — every garbage collection and every safepoint, with its pause, so a stall that is memory
//                   cleanup shows as a pause of that length at that second.
//   server.jfr    — Java Flight Recorder, kept the whole run and written when the server stops: CPU per thread,
//                   where the server thread was (method samples), garbage collection, disk reads and writes,
//                   thread waits. Read with the JDK's own `jfr print --events <name> server.jfr`.
// Both land in fleet_logs, so they belong to this run like every other record there. The GC log's path is
// written relative to the server folder when it can be: `-Xlog` reads a colon as its own separator.
// A continue start appends to the run's records, and Java would start both files over: the last segment's pair
// is kept beside them, named by when it was last written (`server.<time>.jfr`, `server_gc.<time>.log`).
// The lenses read the newest pair.
function keepPrevious(file) {
  return guardExternalSync('foreman_world', `keep the last segment's ${path.basename(file)}`, () => {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
    const stamp = fs.statSync(file).mtime.toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(file);
    const kept = path.join(path.dirname(file), `${path.basename(file, ext)}.${stamp}${ext}`);
    fs.renameSync(file, kept);
    return kept;
  });
}
function javaRecordArgs(serverDir) {
  const gc = path.join(RECORDS_DIR, 'server_gc.log');
  keepPrevious(gc);
  keepPrevious(path.join(RECORDS_DIR, 'server.jfr'));
  const rel = path.relative(serverDir, gc);
  const gcPath = rel.includes(':') ? `"${gc}"` : rel;
  return [
    `-Xlog:gc*,safepoint:file=${gcPath}:time,uptime,level,tags`,
    `-XX:StartFlightRecording=name=auren,settings=default,disk=true,dumponexit=true,filename=${path.join(RECORDS_DIR, 'server.jfr')}`,
  ];
}

// ── THE SERVER'S PULSE, ASKED ONCE A MINUTE AND AFTER EVERY LAG ─────────────────────────────────────
// `tick query` is the server's own account of its tick times (average and percentiles); the entity counts are
// the load it is ticking. Each reading is one SERVER PULSE line in the record; a reading that cannot be taken
// says so in the same line.
let pulseTimer = null;
async function samplePulse(log, why) {
  const r = await guardExternal('foreman_world', 'server pulse', () => rcon.once([
    'tick query', 'execute if entity @e', 'execute if entity @e[type=item]',
  ]));
  if (!r.ok) { log(`SERVER PULSE why=${why} unread=${r.reason}`); return; }
  const flat = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const count = (t) => { const m = /count: (\d+)/i.exec(String(t || '')); return m ? m[1] : 'none'; };
  log(`SERVER PULSE why=${why} entities=${count(r.value[1].body)} items=${count(r.value[2].body)} | ${flat(r.value[0].body).slice(0, 400)}`);
}
function startPulse(log) {
  if (pulseTimer || !WORLD.ours) return;
  pulseTimer = require('../js_kernel/utils/timeout_crash').every('foreman_world', 'sample the entity and item counts of the server', () => samplePulse(log, 'minute'), PULSE_MS);
  pulseTimer.unref();
}

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

// ── no invisible processes ──────────────────────────────────────────────────
// The server is this process's child with its console piped here, so it has no window of its own. It gets
// one: a follower on its console log, the same kind every fetched bot gets (`console_window.followFile`),
// opened when the server is launched and closed when this process ends — the server is stopped by then, and
// the foreman's alarm carries the last lines of a crash into its own window and record.
function closeServerWindow() {
  if (serverWindow) consoleWindow.closeWindow(serverWindow.pid);
  serverWindow = null;
}
process.on('exit', closeServerWindow);

// ── local, as proved steps ──────────────────────────────────────────────────
// Each step below is sensed, acted on and proved from the world (foreman_steps.runSteps); a step that
// cannot be proved stops the start with its own sentence.
function localSteps(log) {
  const ctx = { dir: null, java: null, gamePort: null, prep: null, restored: null, launch: null };
  return [
    {
      name: 'the server folder is found',
      proof: async () => {
        const folder = findFolder();
        if (folder.error) return { ok: false, final: true, why: folder.error };
        ctx.dir = folder.dir;
        WORLD.folder = folder.dir;
        return { ok: true, why: folder.dir };
      },
    },
    {
      name: 'the server can run here',
      proof: async () => {
        if (!fs.existsSync(path.join(ctx.dir, 'server.jar'))) {
          return { ok: false, final: true, why: `There is no server.jar in ${ctx.dir}. Put the Minecraft server jar there, named server.jar.` };
        }
        if (!eulaAccepted(ctx.dir)) {
          return { ok: false, final: true, why: `The server will not run until its licence is accepted, and that is your choice to make: open `
            + `${path.join(ctx.dir, 'eula.txt')} and set eula=true (the licence: https://aka.ms/MinecraftEULA).` };
        }
        ctx.java = workstation.findJava();
        if (!ctx.java.exe) {
          return { ok: false, final: true, why: `No Java ${workstation.JAVA_FLOOR} or newer was found, and the server needs it. `
            + `Tried: ${ctx.java.tried.join(', ')}. Install a Java ${workstation.JAVA_FLOOR}+ runtime (for example Eclipse Temurin).` };
        }
        return { ok: true, why: `server.jar, licence accepted, Java at ${ctx.java.exe}` };
      },
    },
    {
      name: "nothing else is on the server's port",
      proof: async () => {
        ctx.gamePort = settings.serverPort(ctx.dir);
        if (await settings.serverAnswers(ctx.gamePort)) {
          return { ok: false, final: true, why: `A server is already answering on port ${ctx.gamePort}, and this foreman did not start it, so it will `
            + `not start a second one or stop that one. Stop it (a server left from an earlier start is the usual cause), `
            + `or, to join it as it is, set where: 'remote' in foreman_config.js with its console password.` };
        }
        return { ok: true, why: `port ${ctx.gamePort} is free` };
      },
    },
    {
      // A ROLLBACK START PUTS THE WORLD BACK FIRST, while the server is down (foreman_plan.restoreFreshWorld).
      name: 'the world is its clean copy',
      when: () => plan.CONFIG.start === 'rollback',
      act: async () => {
        ctx.restored = plan.restoreFreshWorld(ctx.dir, settings.levelName(ctx.dir), log);
        if (ctx.restored.error) return { give: ctx.restored.error };
        return null;
      },
      // Proved by the world folder's level.dat being the clean copy's, byte for byte in size — read off the disk.
      proof: async () => {
        if (!ctx.restored.restored) return { ok: true, why: 'this server has no clean copy, so the world is used as it is' };
        const fresh = plan.freshWorld(ctx.dir);
        const a = path.join(ctx.dir, fresh.worldName, 'level.dat');
        const b = path.join(ctx.dir, 'world_snapshots', fresh.worldName, fresh.snapshot, 'level.dat');
        const same = fs.existsSync(a) && fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size;
        return same ? { ok: true, why: `'${fresh.worldName}' is '${fresh.snapshot}'` }
          : { ok: false, final: true, why: `the world folder does not match its clean copy after the copy (${a})` };
      },
    },
    {
      // THE SETTINGS, WRITTEN AND SAID OUT LOUD (*"it should instead report loudly what it
      // did and why"*). The server is down, so a fresh one-time console password is minted and read by this boot.
      name: 'the server settings are written',
      act: async () => {
        ctx.prep = settings.prepare(ctx.dir, { serverUp: false });
        if (ctx.prep.changes.length) {
          log(`SERVER SETTINGS CHANGED in ${ctx.prep.file}:`);
          for (const c of ctx.prep.changes) log(`   ${c.key}  — ${c.why}`);
        }
        if (ctx.prep.changes.some(c => c.key.startsWith('online-mode'))) {
          log('   NOTE: in offline mode a server checks no accounts. Keep it private or turn on the whitelist.');
        }
        return null;
      },
      // Read back from the file: every required key holds its value and the console password is the one minted.
      proof: async () => {
        const props = rcon.parseServerProperties(fs.readFileSync(ctx.prep.file, 'utf8'));
        const off = Object.entries(settings.REQUIRED_PROPS).filter(([k, v]) => props[k] !== v).map(([k, v]) => `${k}=${props[k]} (wanted ${v})`);
        if (props['rcon.password'] !== ctx.prep.password) off.push('rcon.password is not the one just written');
        return off.length ? { ok: false, final: true, why: `server.properties did not keep: ${off.join(', ')}` }
          : { ok: true, why: `${Object.keys(settings.REQUIRED_PROPS).length} settings and a fresh console password` };
      },
    },
    {
      name: 'the server is running',
      act: async () => { launchServer(ctx, log); return null; },
      within: STARTUP_LIMIT_MS,
      every: 1000,
      proof: async () => {
        if (ctx.launch.how === 'done') return { ok: true, why: `"Done" after ${Math.round((Date.now() - ctx.launch.at) / 1000)}s` };
        if (ctx.launch.how === 'exit') return { ok: false, final: true, why: diagnose(ctx.dir, child.exitCode), lines: lastLines() };
        return { ok: false, why: `the server started but did not finish loading in ${STARTUP_LIMIT_MS / 60000} minutes. It is `
          + 'still running and the foreman will stop it; its last lines are below.', lines: lastLines() };
      },
    },
    {
      // THE CONSOLE OPENS A MOMENT AFTER "Done". Everything the foreman does next (placing a crew, the gamerules)
      // goes through it, so the world is not up until the console answers.
      name: 'the server console answers',
      within: CONSOLE_OPEN_LIMIT_MS,
      every: 1000,
      proof: async () => {
        const r = await rcon.probe();
        return r.ok ? { ok: true, why: `port ${ctx.prep.rconPort}` }
          : { ok: false, why: `the server is running, but its console never answered on port ${ctx.prep.rconPort}: ${r.reason}`, lines: lastLines() };
      },
    },
    gamerulesStep(log),
  ];
}

// THE GAMERULES, EVERY START (fleet_control's reasoning, now in server_settings) — set, then read back, because a
// rule the server accepted and did not apply must not be reported as set.
function gamerulesStep(log) {
  return {
    name: 'the gamerules are set',
    tries: 2,
    retryAfter: 3000,
    act: async () => {
      for (const [rule, want] of Object.entries(settings.REQUIRED_GAMERULES)) {
        await guardExternal('foreman_world', `gamerule ${rule}`, () => rcon.once([`gamerule ${rule} ${want}`]));
      }
      // The weather is frozen by advance_weather; clearing it here makes what is frozen clear sky.
      await guardExternal('foreman_world', 'weather clear', () => rcon.once(['weather clear']));
      return null;
    },
    proof: async () => {
      const off = [];
      for (const [rule, want] of Object.entries(settings.REQUIRED_GAMERULES)) {
        const r = await guardExternal('foreman_world', `read gamerule ${rule}`, () => rcon.once([`gamerule ${rule}`]));
        const said = r.ok ? r.value[0].body : r.reason;
        if (!r.ok || !String(said).includes(want)) off.push(`${rule} reads "${said}"`);
      }
      return off.length ? { ok: false, why: `not taken: ${off.join('; ')}` }
        : { ok: true, why: Object.entries(settings.REQUIRED_GAMERULES).map(([k, v]) => `${k}=${v}`).join(', ') };
    },
  };
}

// Launch Java as this process's child, with its console piped to the record and a visible follower window. The
// step's proof reads `ctx.launch.how`: 'starting' until the server prints "Done", 'exit' if Java ends first.
function launchServer(ctx, log) {
  process.env.AUREN_SERVER_DIR = ctx.dir;
  process.env.AUREN_SERVER_HOST = 'localhost';
  process.env.AUREN_SERVER_PORT = String(ctx.gamePort);
  process.env.AUREN_RCON_PASSWORD = ctx.prep.password;
  process.env.AUREN_RCON_PORT = String(ctx.prep.rconPort);
  WORLD.host = 'localhost';
  WORLD.port = ctx.gamePort;

  const sink = openServerLog();
  // Opened without waiting — the PowerShell behind a window held this process 5 s on a busy machine.
  consoleWindow.followFileAsync({ title: 'auren server', logFile: path.join(RECORDS_DIR, 'console_server.log') }).then(w => {
    serverWindow = w;
    if (!w) log('WARNING could not open a window on the server console; it is in fleet_logs/console_server.log.');
  });
  log(`starting the Minecraft server in ${ctx.dir} (port ${ctx.gamePort}); its full console goes to fleet_logs/console_server.log`);
  WORLD.state = 'starting';
  WORLD.startedAt = new Date().toISOString();
  ctx.launch = { how: 'starting', at: Date.now() };
  child = spawn(ctx.java.exe, [...javaRecordArgs(ctx.dir), ...JAVA_ARGS], { cwd: ctx.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  WORLD.ours = true;
  WORLD.pid = child.pid;
  child.once('spawn', () => processPriority.apply(child.pid, 'server', log));

  const onLine = (line) => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
    if (SHOWN.test(line) && !NOT_SHOWN.test(line)) log(`[server] ${line}`);
    if (/\]: Done \(/.test(line) && ctx.launch.how === 'starting') ctx.launch.how = 'done';
    const lag = LAG_RE.exec(line);
    if (lag) {
      log(`SERVER LAG behind_ms=${lag[1]} ticks=${lag[2]} — server_gc.log and server.jfr hold what Java was doing`);
      if (pulseTimer) samplePulse(log, 'lag');
      require('./machine_pulse').atLag(log, +lag[1]);
    }
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
  child.on('error', (e) => { tail.push(`[foreman] could not launch Java: ${e.message}`); ctx.launch.how = 'exit'; });
  child.on('exit', (code, signal) => {
    sink.end();
    const wasUp = WORLD.state === 'up';
    ctx.launch.how = 'exit';
    if (stopping) { WORLD.state = 'stopped'; return; }
    WORLD.state = 'failed';
    WORLD.reason = diagnose(ctx.dir, signal || code);
    if (wasUp) for (const fn of unexpectedExitListeners) fn(WORLD.reason, lastLines());
  });
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

function remoteSteps(log) {
  const host = CONFIG.host;
  const port = CONFIG.port;
  const creds = { port: CONFIG.rconPort, password: CONFIG.rconPassword };
  return [
    {
      name: 'the address and console password are given',
      proof: async () => {
        if (!host) return { ok: false, final: true, why: "foreman_config.js says where: 'remote' and gives no host. THE SPOT TO CHANGE: foreman_config.js -> host." };
        if (!CONFIG.rconPassword) {
          return { ok: false, final: true, why: `foreman_config.js says where: 'remote' (${host}:${port}) and gives no console password. A crew is `
            + 'placed through that world\'s console, so the owner of the world has to give you its password. '
            + 'THE SPOT TO CHANGE: foreman_config.js -> rconPassword (and rconPort).' };
        }
        WORLD.host = host;
        WORLD.port = port;
        WORLD.state = 'starting';
        return { ok: true, why: `${host}:${port}` };
      },
    },
    {
      name: `the world answers at ${host}:${port}`,
      within: REACH_LIMIT_MS,
      every: 5000,
      proof: async () => {
        const k = await knock(host, port);
        return k.ok ? { ok: true } : { ok: false, why: `Could not reach the world at ${host}:${port}: ${k.reason}. THE SPOT TO CHANGE: foreman_config.js -> host, port.` };
      },
    },
    {
      name: "the world's console lets the foreman in",
      within: 10000,
      every: 2000,
      proof: async () => {
        const r = await rcon.probe({ creds });
        return r.ok ? { ok: true, why: `port ${CONFIG.rconPort}` }
          : { ok: false, why: `The world at ${host}:${port} answers, but its console on port ${CONFIG.rconPort} refused the foreman: `
            + `${r.reason}. THE SPOT TO CHANGE: foreman_config.js -> rconPort, rconPassword (they must match that server's rcon.port and rcon.password).` };
      },
      act: async () => {
        process.env.AUREN_SERVER_HOST = host;
        process.env.AUREN_SERVER_PORT = String(port);
        process.env.AUREN_RCON_PASSWORD = CONFIG.rconPassword;
        process.env.AUREN_RCON_PORT = String(CONFIG.rconPort);
        return null;
      },
    },
  ];
}

// bringUp(log, { note, stopped }) → { ok } | { ok:false, reason, lines } — whichever the config names, as proved steps.
async function bringUp(log, { note, stopped } = {}) {
  WORLD.where = CONFIG.where;
  if (!WHERE.includes(CONFIG.where)) {
    return failed(`foreman_config.js says where: '${CONFIG.where}', which is neither 'local' nor 'remote'. THE SPOT TO CHANGE: foreman_config.js -> where.`);
  }
  log(`bringing up the ${CONFIG.where} world, one proved step at a time:`);
  const r = await runSteps(CONFIG.where === 'local' ? localSteps(log) : remoteSteps(log), { log, note, stopped });
  if (!r.ok) return failed(r.why, r.lines);
  WORLD.state = 'up';
  WORLD.upAt = new Date().toISOString();
  log(CONFIG.where === 'local'
    ? `the world is up — localhost:${WORLD.port}. This foreman started it and will stop it.`
    : `the world is up — ${WORLD.host}:${WORLD.port}. Somebody else runs it; this foreman will not stop it.`);
  return { ok: true };
}

// stopServer(log) → { stopped: boolean, reason } — the server's own `stop`, and a wait for Java to exit.
// Acts only on the server this process launched. Never kills it (see the header).
async function stopServer(log) {
  if (!WORLD.ours || !child || child.exitCode !== null || child.signalCode !== null) {
    return { stopped: false, reason: WORLD.ours ? 'it had already exited' : 'this foreman did not start it' };
  }
  stopping = true;
  if (pulseTimer) { require('../js_kernel/utils/timeout_crash').stop(pulseTimer); pulseTimer = null; }
  WORLD.state = 'stopping';
  log('stopping the Minecraft server — it saves the world first, which can take a couple of minutes');
  const exited = new Promise(r => child.once('exit', () => r(true)));
  child.stdin.write('stop\n');
  const started = Date.now();
  const nag = require('../js_kernel/utils/timeout_crash').every('foreman_world', 'say the world is still saving', () => log(`still saving (${Math.round((Date.now() - started) / 1000)}s)`), 15000);
  const done = await Promise.race([exited, new Promise(r => setTimeout(() => r(false), SHUTDOWN_LIMIT_MS))]);
  require('../js_kernel/utils/timeout_crash').stop(nag);
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

// ── one line into the server's own console ───────────────────────────────────
// A teleport is the server's to perform, not a bot's. The foreman's body is an ordinary player without
// operator rights, so `bot.chat('/tp …')` is a sentence the server refuses. The console IS the operator,
// and this process already holds that pipe: `stopServer` writes `stop` to it the same way.
//
// Acts only on a server this foreman started, the same rule `stopServer` above states. A `remote` world
// belongs to somebody else; there is no stdin to reach, so the refusal is a return, never a throw — the
// caller turns it into a sentence a person standing in that world can act on.
//
// The line is written whole and nothing is parsed back. A console command's reply arrives in the server's
// log stream on its own schedule and is not addressed to the asker. What the person sees is the world
// moving (Law 3 — the world is the report), and what they hear from the desk is that the ask was sent.
function consoleCommand(line) {
  if (typeof line !== 'string' || !line.trim()) {
    throw new Error(`[foreman_world] CODING VIOLATION (Law 13): consoleCommand needs the console line to send, got ${JSON.stringify(line)}.`);
  }
  if (!WORLD.ours || !child || child.exitCode !== null || child.signalCode !== null) {
    return { sent: false, reason: WORLD.ours ? 'the server has already exited' : 'this foreman did not start this world, so it has no console to speak into' };
  }
  child.stdin.write(`${line.trim()}\n`);
  return { sent: true, reason: null };
}

module.exports = { bringUp, stopServer, startPulse, status, endpoint, onUnexpectedExit, lastLines, onShutdownAsked, askShutdown, consoleCommand };
