// Auren_Workshop/fleet_control.js
// Headless fleet operation — the non-TTY twin of start_fleet.ps1 + the overseer
// console, built so an AI monitor (or any script) can run the whole stack
// without GUI windows: Minecraft server, overseer, bots, operator verbs,
// snapshots, teardown. It exists because the interactive surfaces (PowerShell
// windows, readline consoles) assume a human at a keyboard; this tool assumes
// nobody is watching and everything must be inspectable afterward (Law 6:
// PIDs in fleet_control_runtime.json; each process runs in its OWN visible
// console window — Architect standing rule 2026-07-10, no windowless orphans).
//
// It OPERATES the construct but is not part of it — no fragment, no signal
// bus, no decisions inside the SPA loop. Verbs reach the fleet through the
// overseer's one operator pathway ('operator_command' over the socket — the
// TTY console's twin transport, Law 16). Graceful server stop goes through
// RCON (localhost, enabled in server.properties) because a detached java
// process has no reachable stdin and a hard kill risks world corruption.
//
// World selection (relaxed 2026-07-10): `--world=<name>` runs the fleet against any world folder under
// MinecraftServer/, so several test worlds can be kept and picked between. It repoints the server by
// writing `level-name` in server.properties BEFORE launch (a live server can't be re-pointed). With NO
// flag, fleet_control runs whatever world server.properties already names and does NOT touch the pointer
// — a world a prior session left selected is respected and left alone. (Was hardcoded to 'Test world'.)
//
// Other safety rails: `snapshot` refuses while the server is up (rollback.ps1's own precondition); there
// is NO restore subcommand — restoring is destructive and stays behind an explicit, manual invocation of
// rollback.ps1 directly.
//
// Usage:
//   node fleet_control.js status
//   node fleet_control.js server-start | server-stop        [--world=<name>]
//   node fleet_control.js snapshot [--name=label]           [--world=<name>]
//   node fleet_control.js overseer-start [--port=3001]
//   node fleet_control.js run [profile] [--dry]              THE COMMANDED START — reads architect_fleetrunbook_config
//   node fleet_control.js runbook                            print the authored profiles and their answers
//   node fleet_control.js foreman-start                        (the in-game clerk: get a bot / stop a bot)
//   node fleet_control.js bot-start <Name> [--mode=homesteader|contractor]
//   node fleet_control.js observer-start                     (RETIRED 2026-08-06 — prints where the data went)
//   node fleet_control.js bot-start <BotId>
//   node fleet_control.js local [--count=N]     THE LOCAL SERVER — world + overseer + foreman on THIS
//                                               machine, no bots, no online checks. For testing the
//                                               contractor path while the DEDICATED (public) server stays
//                                               up and untouched. Bots come from `foreman get`.
//   node fleet_control.js up [--count=N] [--world=<name>]   (server + overseer + bots; no autonomy yet; default count = whole roster)
//   node fleet_control.js bots-up [--count=N]   (overseer + bots only; FAILS if server isn't already up)
//   node fleet_control.js repair [--count=N] [--autonomy-if-cold]
//                                               IDEMPOTENT. Starts only what is missing and never tears
//                                               down or sweeps fleet_logs — which is exactly what `up` and
//                                               `bots-up` do first, so neither of them can be re-run
//                                               against a half-live fleet. DEFAULT IS ZERO BOTS: overseer
//                                               and foreman only, because the public server is on-order.
//   node fleet_control.js roster                (print the canonical roster, seniority order — the launchers read this)
//   node fleet_control.js verb start [--stagger=45000] [--min-gap=1500]   paced by FIRST MOVEMENT, not a timer
//   node fleet_control.js verb <start|stop|flush|wipe|...>
//   node fleet_control.js down [--keep-server]
//
// Exit codes: 0 ok · 1 the requested operation could not be completed.

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

// THE BOT IS A SIBLING NOW, NOT THIS DIRECTORY. `__dirname` said "the bot" for as long as this file sat
// inside Auren_Bot/, and every path below is derived from it — the roster, the launcher, fleet_logs, the
// kernel's live state. The workshop's one answer to where the bot is replaces that one assumption.
const paths = require('./workshop_paths');
const BOT_DIR = paths.BOT_ROOT;
const PROJECT_ROOT = paths.REPO_ROOT;
const RUNTIME_FILE = path.join(BOT_DIR, 'fleet_control_runtime.json');
// ROSTER derives from the canonical BOT_SENIORITY table — ordered by seniority so ROSTER[0] is the
// eldest. Adding a bot is ONE edit in architect_config.js, not here (Law 16, single source of truth).
// The `roster` command below prints this list so the PowerShell launchers read the same source too.
const { BOT_SENIORITY, TERMINAL_SPAWN_MODE, BOT_MODES, FOREMAN_NAME, FOREMAN_PREFIX, SPAWN_PROTECTION_RADIUS } = require(paths.bot('Thinking_fragments/architect_config.js'));
const VALID_BOT_MODES = new Set(Object.values(BOT_MODES));
const ROSTER = Object.keys(BOT_SENIORITY).sort((a, b) => BOT_SENIORITY[a] - BOT_SENIORITY[b]);

// EVERY PROCESS THE FLEET RAISES, named once (Law 8, Law 16).
//
// Law 8 is what you raise, you take down — and a teardown is only as complete as its list. This was
// four hand-copied arrays in four teardown paths, which is four places to remember a new process
// type: the foreman was added to none of them, so every `down` and every fresh-start left a clerk
// standing in the world after the run that started it had ended. A list that must be updated in
// four places is a list that will be updated in three.
//
// ORDER IS THE TEARDOWN ORDER. Bots first (they persist HQ on the way out), then the foreman, then the
// overseer they talk through — a process is never left addressing a socket that has already gone.
// 'fleet-console' is in the list so `down` reaps it: it is read-only and harmless, but an observer
// window left tailing a dead fleet is exactly the orphan the visible-window rule exists to prevent -
// and one that would show a frozen story forever without ever saying the fleet had gone.
const FLEET_PROCESSES = ['trace', 'fleet-console', ...ROSTER, 'foreman', 'overseer'];
const FLEET_PROCESSES_WITH_SERVER = [...FLEET_PROCESSES, 'server'];
const SERVER_PORT = 25565;
const OVERSEER_PORT_DEFAULT = 3001;

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const has = name => args.includes(`--${name}`);
const positional = args.filter(a => !a.startsWith('--')).slice(1);

// --world=<name> selects the world; null = "run whatever server.properties names, don't rewrite it"
// (so a world a prior session left selected is respected). effectiveWorld() resolves the actual name.
// Defined after `opt` because it reads the CLI.
const WORLD = opt('world', null);

// ── Executables and the server folder ────────────────────────────────────────
// Node: every child runs on `process.execPath`, the interpreter already running this file. It was
// resolved once, by whoever started us (a stranger's `node`, or scripts/_node.ps1 on his machines), and
// asking again could only produce a second answer (Law 16). Java and the server folder are the workstation
// resolver's answers — the stranger's way first, then the Architect's workstation file — asked at the
// moment they are needed, so a command that touches neither never pays for either.
const workstation = require(paths.bot('js_kernel/utils/workstation'));
function serverDir() { return workstation.needServerDir(); }

// Both module-home questions now go to @utils/node_module_homes rather than to two lists maintained
// here. They had already drifted — nodePathEnv knew two homes and requireWs knew three, so a machine
// with only Auren_Bot/node_modules resolved `ws` for THIS process and handed its children a NODE_PATH
// that did not contain it. One list, two verbs off it (Law 16).
const moduleHomes = require(paths.bot('js_kernel/utils/node_module_homes'));
// The one owner of "open a visible console window" — see `launch()` for why it is not local code.
const consoleWindow = require(paths.bot('js_kernel/utils/console_window'));

// What the spawned BOTS get. A child cannot inherit a resolver re-initialised in this process's memory,
// so it travels as an environment value.
function nodePathEnv() { return moduleHomes.nodePathValue(); }

// What THIS process needs, resolved by absolute path rather than by altering our own NODE_PATH —
// fleet_control is a launcher and has no business changing how it resolves its own requires.
function requireWs() { return moduleHomes.requireFromHomes('ws'); }

// ── Runtime registry (Law 6: every spawned PID is on record) ────────────────
function readRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeRuntime(rt) {
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(rt, null, 2));
}
// pidAlive(entry) — is the process we recorded STILL THE ONE AT THAT PID?
//
// WHY THE START TIME IS CHECKED AND A BARE `process.kill(pid, 0)` IS NOT ENOUGH (found live 2026-08-05).
// `kill(pid, 0)` answers "does SOME process hold this pid", never "is it MINE". Windows recycles pids
// aggressively, so a runtime entry that outlives its process eventually points at a stranger. Measured:
// the (since-retired) observer's entry from the 02:43 run held pid 18596; twenty hours later that pid
// belonged to an OpenConsole window spawned by the very launch that then reported `already running (pid
// 18596)` and skipped the start. The run went 90 seconds with no recorder — no tape, no hits, no death
// wake — and nothing said so, because the claim was never checked against reality (Law 23). The observer
// is gone; the pid check guards every tracked process and the symptom it was found on outlives it.
//
// The same read guards forceKill, where the failure is worse than silence: `down` would have sent a kill
// to a process it never spawned.
//
// The test is the spawn clock. We stamp `started_at` at spawn, so the OS's own start time for a pid we
// still own must be at or before it; a recycled pid ALWAYS starts later. SKEW_MS absorbs the gap between
// the OS creating the process and this file writing the stamp.
//
// UNCERTAIN → NOT OURS, deliberately, because that default is the safe one on both sides (Law 13):
// a launcher relaunches (loud, and a doubled process is visible in the trace) instead of silently
// skipping, and forceKill declines to signal a process it cannot confirm it owns.
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

// The OS's creation time for a pid, in epoch ms, or null when it cannot be read. Shelling out to
// PowerShell because Node exposes no process-start-time API; this runs a handful of times per launcher
// invocation and never inside the fleet's own loop.
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

// THE WINDOW MECHANICS MOVED OUT (2026-09-10) — `js_kernel/utils/console_window.js` now owns them, and
// what is left here is the part that is genuinely fleet_control's: the pid ledger in `runtime.json` that
// `status`, `down` and `takeover` read. The move was not tidying. This function was the ONLY launcher in
// the fleet that opened a window, and the rule it implemented — every fleet process in its own visible
// console — was therefore true only of processes that came through here. Two others did not: `run.js`
// spawned the desk and the person with stdio on a file descriptor and no window at all, and the foreman
// spawned every BOT with `windowsHide: true`. The Architect found the result at the dedicated machine —
// *"nothing runs so i cant see whats going on and help at all"* — and one owner is what makes the rule
// hold for a launcher written next year (Law 16).
//
// The visible-window rationale itself lives in that module's header, including why -PassThru's pid is
// load-bearing and why the default window style changed from minimized to normal.
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

// ── THE ONE WINDOW (Architect 2026-09-03) ───────────────────────────────────────────────────────────
// "can you place all the node powershells on one as well? i want a one stop shop to see all my
//  terminals and i want the overseer one to scroll like it is."
//
// Every bot already writes into ONE merged story - the overseer trace - so the one-window console is not
// a new aggregation to build, it is that file, followed. `trace_monitor --follow` is the lens extended to
// stream it (Law 26: a tool needing a fact out of a record calls a lens; when the lens cannot answer,
// extend the lens rather than reading the file raw).
//
// It is opened NORMAL while the bots are minimized: this is the window meant to be looked at, and the
// contrast is what makes it the obvious one on the taskbar. It only READS, so closing it stops nothing -
// the same property that makes the public server's board safe to leave open.
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
// Repoint the server before launch. A running server is never re-pointed (serverStart guards on this);
// the folder itself is untouched — an unknown name just makes Minecraft generate a fresh world of that
// name on start, which is how a NEW test world is born.
function setServerProperty(key, value) {
  const file = path.join(serverDir(), 'server.properties');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`);
  let found = false;
  const out = lines.map(l => (re.test(l) ? (found = true, `${key}=${value}`) : l));
  if (!found) out.push(`${key}=${value}`);
  fs.writeFileSync(file, out.join('\n'));
}
function setLevelName(world) { setServerProperty('level-name', world); }

// Settings the fleet cannot run correctly without, asserted at launch instead of trusted.
//
// spawn-protection: the vanilla default, ON, and the value comes from architect_config's
// SPAWN_PROTECTION_RADIUS rather than a literal here — the bots gate their own decisions on that same
// constant, so the square the launcher enforces and the square they avoid cannot drift apart (Law 16).
//
// WHAT THE SETTING DOES: inside a Chebyshev square of that radius around world spawn — X/Z only, full
// height — the server refuses block breaks and placements by non-op players. It refuses SILENTLY: no
// revert, no error, nothing the client can see. mineflayer writes AIR into its own world model anyway
// and reports the dig as done, so a bot inside the zone mines a phantom hole, walks into a block that
// never left, and strands itself with 0 items and no error anywhere in the trace.
//
// THE WRONG TURN, TAKEN ONCE AND WORTH NOT RETAKING: this was `0` — the rule deleted from the world —
// because the fleet had no way to see the refusal, and switching it off was the only thing that made the
// silence stop. That trade trained the fleet on a world with a rule missing from it, so nothing in the
// stack ever learned the rule exists; the moment a bot met a server that had it (any public or vanilla
// one — this is the DEFAULT setting), the same maroon returns with nothing changed. The fix is the fleet
// holding the rule itself: `perception_nodes.js/spawn_protection` gates target selection, route search
// and both world-altering verbs on the square, so a protected cell is refused BEFORE the swing rather
// than discovered as a phantom after it.
//
// Op-ing the bots would also silence it, and is the other wrong turn: exempting the construct from a
// limit every other agent obeys is the Rogue Machine error Law 19 forbids. The fleet's own gate
// therefore ignores op status entirely — an op'd bot is refused exactly like a non-op one, because a
// constraint honoured only where it cannot be defeated is not a constraint (Invariant E).
//
// difficulty=hard keeps the HUNGER system fully live — food drains with activity and a bot can starve to
// death at food 0 — which is what arms the eating subsystem (on peaceful, food never drains and the whole
// eat tier is dormant, so the system would never be exercised).
//
// spawn-monsters=TRUE since 2026-08-03 (Architect: "go ahead and do a standard test. we will enable
// monsters as well… every main feature added to the game now with combat"). It was FALSE from 2026-07-16
// so a test could isolate the survival loop from combat while combat did not exist — the bot faced hunger,
// not creepers. That reason has lapsed rather than been overruled: the counter arms, the engagement queue
// and the combat journal all shipped, and every one of them is now unexercised by a run with nothing hostile in
// it. Leaving the flag off would make the standard test quietly stop covering the feature the fleet spent
// four sessions building, which is the same silence in a new place (Law 25).
//
// What this costs, named so a bad run is read correctly: the survival loop is no longer isolated. A bot
// that starves during a monster-enabled run may have starved because combat interrupted the eat tier, and
// hunger and combat can no longer be told apart from the outcome alone — they have to be told apart from
// the record (trace_monitor's warnings; `--engagement` for the fights). Flip this back to 'false' for any run
// whose question is about hunger, farming or building alone.
//
// All four load at JVM start, so a live server carrying the wrong values can only be reported and
// restarted (handled below), never hot-corrected.
//
// Why here and not documentation: MinecraftServer/ is gitignored, so server.properties does NOT travel
// between the Architect's two machines. A hand-sync checklist is a constraint enforced by memory —
// exactly the defeatable kind (Invariant E), and it already failed once. The launcher touches every run
// on every machine and is the only place that can assert this rather than ask.
//
// ── DIFFICULTY IS PEACEFUL WHILE THE DESK IS BEING BUILT (Architect 2026-08-30: "also set the mode to
//    peaceful for now. while continuing to test") ─────────────────────────────────────────────────────
// A TEMPORARY VALUE WITH A PERMANENT REASON RECORDED BESIDE IT, because the paragraphs above are the
// argument FOR hard and they have not been overruled — they are being set aside while a different
// subsystem is under construction, and a successor who reads `peaceful` here without them will conclude
// the fleet was never meant to face hunger or combat at all.
//
// WHAT PEACEFUL COSTS, so a run is read correctly: food never drains, so the whole eat tier is dormant
// and unexercised; no hostile spawns, so the counter arms, the engagement queue and every combat path
// are unexercised too. A green run under peaceful says NOTHING about either. It also removes the one
// exposure that killed a probe run outright — a partial explosion packet crashing mineflayer's physics
// handler, three libraries down, under every client in the fleet — which is worth knowing when reading
// this as a testing choice rather than only as a difficulty one.
//
// TO RESTORE: `difficulty` back to 'hard'. Nothing else changes; `spawn-monsters` is deliberately LEFT
// TRUE so that restoring is one word rather than a hunt, and it costs nothing meanwhile — peaceful
// suppresses hostile spawns whatever that flag says.
// ── sync-chunk-writes=FALSE, AND THIS IS THE `FLEET FROZEN` FAULT (measured 2026-09-10) ────────────
// Vanilla ships this TRUE, which makes the server thread fsync every chunk as it saves it. On this
// machine that is the difference between a save and a stall, measured on the drive the world lives on:
//
//     8 KB write, no fsync :  25.5 ms
//     8 KB write, fsync    : 144.5 ms      → 6x
//
// A save of ~1000 resident chunks is therefore ~150 SECONDS of blocking disk I/O on the one thread that
// also runs the game. Observed directly, on a ONE-MINUTE run with four players:
//
//     [19:32:23] Saving chunks for level 'sub_agent_01'/minecraft:overworld
//     [19:34:57] Saving chunks for level 'sub_agent_01'/minecraft:the_end      ← 2m34s later
//
// AND A CPU SAMPLE ACROSS THAT WINDOW SETTLES WHAT THE RECORD COULD NOT. bugsquashing §14.9 left two
// candidates — the server doing heavy work, or the server starved of a core by the node fleet — and told
// the next session to accept neither without a sample. Through the stall java held 0-5% of ONE core of
// eight, node held 0%, and 22.6 GB of RAM was free: the tick thread was neither busy nor starved, it was
// BLOCKED. That is a third cause and it is the one that fits every symptom on record.
//
// What it retro-explains: every client dropping in the SAME INSTANT with a client-side timeout (a >30s
// block outlasts mineflayer's 30-second keep-alive, so the protocol is behaving correctly); no
// OutOfMemoryError ever appearing; and §14.8's heap theory failing the way it did — a 4 GB heap froze
// SOONER than 1 GB because more heap holds more chunks resident, and resident chunks are what a save has
// to write. It is intermittent for the same reason: how much terrain two ranging bots dirtied before the
// next autosave.
//
// THE COST, NAMED: an abruptly killed JVM can leave a torn chunk. This fleet restores its world from a
// snapshot at the start of every run, so the exposure lasts exactly one run and is never carried.
const REQUIRED_PROPS = {
  'spawn-protection': String(SPAWN_PROTECTION_RADIUS), 'difficulty': 'peaceful', 'spawn-monsters': 'true', 'spawn-animals': 'true',
  'sync-chunk-writes': 'false',
};

// ── REQUIRED GAMERULES (Architect 2026-08-09) ───────────────────────────────────────────────────────
//   "can you make sure you turn mob griefing off repo wide? so when i do a standard test as well?"
//
// Gamerules, not server properties, and that difference decides where this lives. Properties are read
// once at JVM start (serverStart can only WARN about a live one); a gamerule is world state settable over
// rcon at any time — so it is applied on BOTH paths here, including a reused server, and a live server no
// longer has to be restarted to be correct.
//
// It belongs at bring-up rather than in any one bench because it is a property of every run, and because
// ROLLBACK REVERTS IT: the gamerule persists in the world's level.dat, so a snapshot restore silently puts
// it back to whatever the snapshot held. Setting it once by hand would survive until the first rollback
// and then quietly stop being true — which is why it is re-asserted every time the server comes up rather
// than assumed. `lanista` used to author this itself; that copy is now a read-back check, so there is one
// author and one verifier (Law 16).
//
// WHY mobGriefing IS OFF: a creeper detonation craters the ground the next wave is sited on, so each trial
// was fought on terrain the previous trial had rearranged and the ladder was calling that difference the
// bot. Turning it off costs no difficulty — the bot still takes the full blast damage, measured at 20.0 hp
// from 2.3 b on 2026-08-09. Only the terrain is spared.
// WHY doInsomnia IS OFF: phantoms were the only reason the fleet needed a bed, and the bed was the only
// reason it needed wool. death_manager already returns a body to the headframe, so the bed bought nothing
// else. Rule off, bed and hunt chain deleted (Architect 2026-08-14).
const REQUIRED_GAMERULES = { mobGriefing: 'false', doInsomnia: 'false' };

// Applied after the server answers, because rcon needs it up. Never fatal: a run whose gamerule could not
// be set is still a run, and saying so beats refusing to start (Law 13 governs acting on uncertainty, not
// reporting it — the operator is told and decides).
async function applyGamerules() {
  // THE GAME PORT IS NOT THE RCON PORT, and the first live run of this proved it: 25565 answered, this ran
  // immediately, and rcon refused the connection because the server had not opened 25575 yet. The failure
  // was caught only because the write is read back — an unverified write would have reported success and
  // left every run cratering (Law 23, and the reason the read-back is not optional).
  const rconPort = parseInt(serverProperties()['rcon.port'], 10) || 25575;
  if (!(await waitFor(`rcon port ${rconPort}`, () => probePort(rconPort), 60000, 1000))) {
    console.log(`server: ⚠ rcon never opened on ${rconPort} — gamerules not applied; the world keeps whatever it had.`);
    return;
  }
  for (const [rule, want] of Object.entries(REQUIRED_GAMERULES)) {
    try {
      const now = (await rconCommand(`gamerule ${rule}`)) || '';
      if (now.includes(`is currently set to: ${want}`)) continue;
      await rconCommand(`gamerule ${rule} ${want}`);
      // READ BACK rather than trusting the write. A rule that was accepted and not applied must not be
      // reported as applied (Law 23) — the same discipline lanista's applyWorld uses for difficulty/time.
      const after = (await rconCommand(`gamerule ${rule}`)) || '';
      console.log(after.includes(`is currently set to: ${want}`)
        ? `server: gamerule ${rule}=${want}.`
        : `server: ⚠ gamerule ${rule} would not take — server said "${after.trim()}".`);
    } catch (e) {
      console.log(`server: ⚠ could not set gamerule ${rule} (${e.message}) — the world keeps whatever it had.`);
    }
  }
}

// ── THE CLOCK — one owner for both halves of it ─────────────────────────────────────────────────
// A run's clock is a time AND whether the cycle advances from it, and both are set here so a caller
// cannot author one without the other. The three answers are declared in fleet_runbook's CLOCKS; this
// is the only place that carries them out, and `test`'s --clock and fresh_start's -Clock both route here
// rather than reaching for `time set` themselves (Law 16 — one implementation, three callers).
//
// BOTH DIRECTIONS ARE ASSERTED, WHICH IS THE WHOLE REASON THIS IS NOT TWO LINES AT THE CALL SITE.
// `doDaylightCycle` persists in the world's level.dat, exactly like the gamerules above: once a run
// pins it false it stays false for every run afterwards, so a later 'dawn' run would sit at sunrise
// forever while reporting that it set the clock and let it run. Stating the whole clock every time is
// what makes each value mean the same thing on the hundredth run as on the first (Invariant B).
//
// NOT FATAL, AND SAID OUT LOUD. A clock that would not set leaves a run worth having; a run that
// reported a clock it never set does not (Law 25). Same posture as applyGamerules directly above.
const CLOCK_SETTINGS = {
  dawn: { time: '0',   cycle: 'true',  said: 'set to DAWN, and the day runs on from there' },
  // Midday rather than `time set day` (1000, an hour after sunrise): noon is the top of the arc, so a
  // frozen world holds the flattest shadows and the same light on every side of a build.
  day:  { time: '6000', cycle: 'false', said: 'PINNED AT MIDDAY — daylight cycle frozen, so it stays light for the whole run' },
};

async function applyClock(clock) {
  if (clock === 'held') {
    console.log('run: the world keeps whatever time and cycle it holds — a deliberate night run.');
    return;
  }
  const want = CLOCK_SETTINGS[clock];
  if (!want) throw new Error(`fleet_control: '${clock}' is not a clock this runner carries out.`);
  try {
    await rconCommand(`gamerule doDaylightCycle ${want.cycle}`);
    // READ BACK, never trusted from the write — the same discipline applyGamerules uses, and for the
    // same reason: a rule accepted and not applied would leave the run walking into a night it just
    // reported it had frozen out.
    const after = (await rconCommand('gamerule doDaylightCycle')) || '';
    await rconCommand(`time set ${want.time}`);
    console.log(after.includes(`is currently set to: ${want.cycle}`)
      ? `run: world clock ${want.said}.`
      : `run: ⚠ world time set, but doDaylightCycle would not take — server said "${after.trim()}". ` +
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

// WHERE THE RCON CREDENTIALS COME FROM, and why an override exists (measured 2026-09-05).
//
// By default they are read out of the fleet's OWN `MinecraftServer/server.properties`, which is correct
// whenever the fleet launched the world it is talking to. It is WRONG the moment the fleet is a guest on
// a world somebody else started — which is exactly the public-server case, and it fails in the most
// confusing way available: the public backend also listens for rcon on 25575, so the connection SUCCEEDS
// and the auth is refused, because the password belongs to a different server. `playersOnline()` then
// rejects, `foremanStart` can never confirm its clerk arrived, and `status` reports "rcon did not answer"
// about a server answering perfectly well.
//
// `AUREN_RCON_PASSWORD` / `AUREN_RCON_PORT` are the same shape `SERVER_ENDPOINT` already uses for the
// host and port a body connects to (architect_config.js): the fleet stays ignorant of who owns the world
// and is simply TOLD, by whoever is pointing it at one. The `enable-rcon` gate is skipped when a password
// is supplied, because that flag is a fact about the fleet's own properties file and says nothing about
// the server actually being addressed.
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
        // THE ERROR NAMES ITS OWN CAUSE, because `rcon auth failed` is a sentence about the SERVER and
        // the fault is always on this side of the wire. An auth refusal is never ambiguous: the socket
        // connected, so something is listening on that port and answering — this fleet simply presented
        // the wrong password. The one thing a reader needs is WHICH password it used, and only this
        // function knows (measured 2026-09-05: a bare `foreman-start` against the public server read the
        // dev world's properties, was refused, and the failure surfaced 45 seconds later as "Foreman
        // never appeared in the server's player list" — a claim about the world, from an instrument that
        // had never once worked).
        if (id === -1) {
          sock.destroy();
          reject(new Error(envPw
            ? `rcon auth refused on port ${port} — AUREN_RCON_PASSWORD was set but this server rejected it`
            : `rcon auth refused on port ${port} — no AUREN_RCON_PASSWORD was set, so this fleet used its `
              + `OWN MinecraftServer/server.properties password. If you are addressing a server this fleet `
              + `did not start (the public server), it must be TOLD the password.`));
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
async function serverStart() {
  if (await probePort(SERVER_PORT)) {
    console.log(`server: already listening on ${SERVER_PORT} — reusing it (running world '${currentLevelName()}'; a live server can't be re-pointed).`);
    // These are read once at JVM start, so a live server cannot be corrected — only reported. Say it
    // loudly, and note which direction of spawn-protection mismatch actually bites: a server running a
    // LARGER radius than the fleet's constant has protected ground the bots believe is open, which is
    // the silent-refusal maroon; a SMALLER one only makes them over-cautious near spawn. Neither is
    // fixable without a restart, and the first is a stranding, so the warning is worth reading.
    const live = serverProperties();
    for (const [k, want] of Object.entries(REQUIRED_PROPS)) {
      if (live[k] !== want) console.log(`server: ⚠ live server has ${k}=${live[k] ?? '(unset)'}, needs ${k}=${want} — restart the server to apply (settings load at startup).`);
    }
    // A reused server gets them too: unlike properties these ARE fixable live, so a reused world is not
    // condemned to whatever gamerules it happened to come up with.
    await applyGamerules();
    return true;
  }
  if (WORLD && WORLD !== currentLevelName()) {
    setLevelName(WORLD);
    console.log(`server: repointed level-name → '${WORLD}'.`);
  }
  const props = serverProperties();
  for (const [k, want] of Object.entries(REQUIRED_PROPS)) {
    if (props[k] !== want) {
      setServerProperty(k, want);
      console.log(`server: set ${k}=${want} (was ${props[k] ?? 'unset'}).`);
    }
  }
  console.log(`server: launching on world '${effectiveWorld()}'.`);
  // ── 4 GB, NOT 1 GB, AND THE 1 GB IS WHAT KILLED A 20-MINUTE SOAK (2026-09-10) ─────────────────────
  // A fleet ran 14m53s absolutely clean — zero errors, chests delivering, the headframe going up — and
  // then every client dropped at once. It was not the fleet. The server's own log:
  //
  //   [18:33:54] WARN: Can't keep up! Is the server overloaded? Running  4979ms or  99 ticks behind
  //   [18:44:30] WARN: Can't keep up! Is the server overloaded? Running 35977ms or 719 ticks behind
  //   [18:44:30] INFO: Foreman lost connection: Disconnected      ← same second
  //   [18:44:35] architect · [18:44:38] AurenBot · [18:44:39] TessaBot
  //
  // **A 36-second server-thread stall outlasts mineflayer's 30-second keep-alive**, so the disconnects
  // are the protocol working exactly as designed. No OutOfMemoryError is logged and none is expected:
  // this is GC thrash, not exhaustion — the heap never runs out, it just spends longer and longer
  // collecting, which is why the stalls escalate (5s, then 36s) instead of failing outright.
  //
  // WHY 1 GB IS TOO LITTLE HERE SPECIFICALLY: two bots exploring outward hold a widening set of loaded
  // chunks, and A* is deliberately UNCAPPED (pathfinding_utils' own header: "im always against the
  // budget cap"), so a search can touch the whole loaded region. That is the right call for correctness
  // and it makes the server's chunk residency the binding constraint rather than the bot's.
  //
  // 4 GB on a 32 GB machine, and Xms == Xmx because an equal pair removes heap-resize pauses — the
  // stall being fixed is a pause, so a setting that adds pauses of its own is the wrong shape. This
  // number ships with the bot, so a stranger's one-button run gets it too; `scripts/world_rollback.ps1`
  // already documented `-Xmx2G -Xms1G` in its own example, so 1 GB was low even by this repo's account.
  launch('server', workstation.needJava(), ['-Xmx4G', '-Xms4G', '-jar', 'server.jar', 'nogui'], serverDir(), {});
  const up = await waitFor(`server port ${SERVER_PORT}`, () => probePort(SERVER_PORT), 120000, 2000);
  if (up) {
    console.log('server: up.');
    // AFTER the port answers, not before — rcon has nothing to talk to until then. This is the line that
    // makes the rule repo-wide: every path that reaches a running server goes through here.
    await applyGamerules();
  }
  return up;
}

// ── "STOPPED" MEANS THE PROCESS HAS EXITED, AND IT USED TO MEAN THE PORT WENT DARK (fixed 2026-09-10)
// Minecraft closes its listening socket EARLY in shutdown and then saves chunks for as long as that
// takes. Measured on a one-minute run: the port closed at 19:32:22 and the JVM exited at 19:34:59 —
// this function printed `server: stopped.` two minutes and thirty-seven seconds before it was true, and
// a `server-stop` issued in that gap answered `server: not running.` while a live JVM held the world.
//
// WHAT THAT COSTS THE CALLER, twice over. `run.js` starts its next run on the strength of this answer,
// and the world restore then dies on `Copy-Item: another process has locked a portion of the file` —
// `session.lock`, held by the server that had not finished leaving. And a caller told "not running" by
// the early return has been handed the opposite of the fact.
//
// THE PROCESS IS THE FACT AND THIS FUNCTION ALREADY HAS IT: `launch()` records the real pid from
// -PassThru, and `pidAlive` verifies it against the OS start time so a recycled pid cannot pass. The
// port was a PROXY, and a proxy that leads the fact by two minutes is a wrong answer rather than an
// early one (Law 26 — read the fact, and Law 19 — the same answer from every direction).
//
// A server this fleet did not launch has no tracked pid, so there the port is the only fact available.
// That reading is weaker and says so out loud rather than passing itself off as the strong one (Law 25).
const SHUTDOWN_WAIT_MS = 180000;
async function serverStop() {
  const tracked = readRuntime()['server'];
  // BOTH have to be quiet. Either one alone is the bug above: a dark port with a live JVM is the
  // save-in-progress window, and a tracked-dead pid with an open port is a server someone else is running.
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
    console.error('snapshot: server is RUNNING — rollback.ps1 requires it stopped (world files mid-write are not a snapshot). Run server-stop first.');
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

async function overseerStart() {
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  if (await probePort(port)) {
    console.log(`overseer: already listening on ${port} — reusing it.`);
    return true;
  }
  launch('overseer', process.execPath, [path.join('overseer', 'overseer_server.js'), String(port)], BOT_DIR,
    { NODE_PATH: nodePathEnv() });
  const up = await waitFor(`overseer port ${port}`, () => probePort(port), 20000, 500);
  if (up) console.log('overseer: up.');
  return up;
}

// ── THE COMBAT OBSERVER IS GONE (Architect 2026-08-06) ──────────────────────────────────────────────
// "the value add of having a combat monitor is minimum when the bot can announce most of the things and
//  have trace monitor capture all important pieces ... we only care about the combat data that the bot
//  receives ... i want the watcher trace to be the one source of truth."
//
// Three processes and ~4200 lines (combat_observer, combat_observer_monitor, combat_monitor) were deleted
// because they answered from OUTSIDE a question the bot can answer about ITSELF. The observer's one
// genuinely exclusive contribution was naming what hit the bot, and 1.21's damage_event packet delivers
// that to the client — so the outside view was buying a fact the bot already had.
//
// WHAT REPLACED IT was battle_stations' own journal (fleet_logs/combat_journal/) read by
// `trace_monitor --combat`. That record is ALSO gone now (2026-08-22) and the sentence above is the
// reason it went: *"i want the watcher trace to be the one source of truth"* was answered in 2026-08-06
// by deleting the outside observer and writing a second file of the bot's own instead, which is one
// source of truth in the same sense two diaries are. The fight's beats are now lines on the bot's own
// watcher trace — engage, end, wave, hurt, blast, death — and the reader is `--engagement`.
//
// The verb is KEPT as a stub rather than removed so an operator (or a script) that still calls
// `observer-start` gets told where the data went instead of an unknown-verb error.
async function observerStart() {
  console.log('observer: RETIRED 2026-08-06 — the fleet records its own combat, on its own watcher trace.');
  console.log('          Read it with: node Auren_Bot/monitoring/trace_monitor.js --engagement [--bot=AurenBot] [--all]');
  return true;
}

// THE FLEET'S pathway to a bot — the roster, the corpse check, the PID registry, the window. Both species
// come out of this function; only the stamp differs.
//
// IT NO LONGER LAUNCHES master_core DIRECTLY, and that is a Law 16 fix rather than an indirection
// (2026-09-08). This comment used to read "THE ONE LAUNCHER of master_core.js in the whole tree, and it
// stays that way" — which was true while this file was the only way anybody could start a bot, and stopped
// being sustainable the moment a public copy needed one too. `fleet_control` cannot be that launcher for a
// stranger: it starts a Minecraft server of its own, manages a roster of eight, and spawns minimized
// PowerShell windows. Writing a second entry
// point beside it would have left two places that stamp a mandate and require master_core — the exact
// duplication the old comment forbade, drifting apart the first time one of them learned something.
//
// So the direction was inverted instead: `start_bot.js` stamps the mandate and is the one birth, and this
// function spawns THAT. Everything above the birth stays here, because none of it is portable and all of
// it is the fleet's own business. The environment stamped below reaches `start_bot.js` untouched — its
// rule is that a given flag wins and an absent flag falls back to the environment, and this caller passes
// no flags, so its stamp passes straight through.
//
// `mode` defaults to the TERMINAL species because this is the terminal's own pathway — an operator
// typing `bot-start AurenBot` gets a homesteader, exactly as before humans existed. The foreman passes
// `--mode=contractor` when it gets a bot for someone in the world.
//
// A CONTRACTOR IS AN OVERRIDDEN HOMESTEADER, so sharing this launcher is correct rather than a
// shortcut: they are the same program, and the mode decides how much of it mounts. An earlier
// revision planned two separate spawn pathways to keep the species apart. That was solving a problem
// the mandate already solves — the ear is either mounted or it is not — and it would have left two
// launchers to keep in step, which is the duplication Law 16 exists to prevent.
// reviveIfDead(botId) → { ok, why } — stand this bot's body up BEFORE its process is launched onto it.
//
// Composed from fleet_revive's own exported parts rather than calling its `preflight`, and the
// difference matters: preflight is a CONTINUE's gate and refuses on an HQ it dislikes, which is correct
// there (a continue carries the last run's HQ forward and must not proceed on a broken one) and wrong
// here (a fresh launch has every right to an empty or flushed HQ). Only the corpse half is this
// launcher's business. The HQ is read for one thing — where the recovery cell is — and never judged.
//
// DETECTION IS AN OFFLINE FILE READ, so this costs nothing on the overwhelmingly common path where the
// body is alive: the server flushes playerdata on a clean stop, so `Health` on disk is the state the
// next login resumes from. A client is only built for a bot that is actually dead.
async function reviveIfDead(botId) {
  const revive = require('./tools/fleet_revive');
  const body = revive.readBody(effectiveWorld(), botId);
  if (body.unreadable) {
    // NOT a refusal. An unreadable file is not evidence of a corpse, and refusing a launch on it would
    // invent a second gate on the busiest road in the fleet for a case this check cannot diagnose. Said
    // out loud so it is not silent, and the launch proceeds to fail on its own terms if it is going to
    // (Law 25 — report the shortfall honestly rather than converting it into a different verdict).
    console.log(`bot-start: ${botId} playerdata unreadable (${body.reason}) — launching anyway; this check only repairs corpses.`);
    return { ok: true, why: 'playerdata unreadable — not checked' };
  }
  if (!body.found || body.alive) return { ok: true, why: body.found ? 'body is alive' : 'no playerdata yet — first life' };

  const hq = revive.hqAudit(botId);
  const at = hq.ok ? revive.anchorZeroFeet(hq.buildCenter) : null;
  console.log(`bot-start: ${botId} is DEAD on disk — standing it up before launch${at ? ` and putting it at (${at.x},${at.y},${at.z})` : ' (no sited base yet, so wherever vanilla puts it)'}.`);
  const r = await revive.revive(botId, { at });
  if (!r.respawned) return { ok: false, why: `the revival failed — ${r.error}` };
  return { ok: true, why: r.teleported ? 'revived and moved home' : 'revived' };
}

async function botStart(botId, mode = TERMINAL_SPAWN_MODE, owner = null) {
  if (!ROSTER.includes(botId)) {
    console.error(`bot-start: '${botId}' is not in the roster [${ROSTER.join(', ')}].`);
    return false;
  }
  if (!VALID_BOT_MODES.has(mode)) {
    console.error(`bot-start: '${mode}' is not a species — valid: ${[...VALID_BOT_MODES].join(' | ')}.`);
    return false;
  }
  // AN OWNER IS PART OF BEING A CONTRACTOR, NOT A SETTING ON ONE. A contractor exists because somebody
  // in the world asked for it, so a nameless one is not an under-configured contractor — it is a
  // contradiction, and one that would silently become "everyone's bot" at the delivery filter. A
  // homesteader is the mirror: it answers to nobody, so an owner on one is a claim nothing can honour.
  // Refusing both here means the pairing cannot be got wrong later, because it cannot be spawned wrong
  // (Law 27 — settle it where the thing is made, rather than policing it at every use).
  if (mode === BOT_MODES.CONTRACTOR && !owner) {
    console.error('bot-start: a contractor needs --owner=<player>. Every contractor is somebody\'s; an ownerless one would answer to anyone in the world.');
    return false;
  }
  if (mode === BOT_MODES.HOMESTEADER && owner) {
    console.error(`bot-start: --owner=${owner} was given for a homesteader. A homesteader answers to nobody, so there is no one for it to belong to.`);
    return false;
  }
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  if (rt[botId] && pidAlive(rt[botId])) {
    console.log(`${botId}: already running (pid ${rt[botId].pid}).`);
    return true;
  }
  // ── THE CORPSE PREFLIGHT (Architect's ruling: spawning, starting, getting and natural death all run
  //    identical logic) ──────────────────────────────────────────────────────────────────────────────
  // A bot whose last life ended dead never receives `spawn`, so master_core never initialises, so it
  // never registers with the overseer — and delivery runs off that registry, so NO operator verb can
  // reach it. It survives `verb stop`. The process sits alive holding a roster name that cannot be
  // exited and cannot be handed to anyone else (Law 8: a lifecycle nothing can terminate).
  //
  // THIS IS THE ONE LAUNCHER, WHICH IS WHY THE CHECK BELONGS HERE AND NOT IN THE CONDUCTOR. It was in
  // the conductor, which covers a continue and covers nothing else — so `foreman get` walked a human
  // straight onto the case, and the person who could least diagnose it was the one who met it. A check
  // on the one road every bot is born on covers every route by construction rather than by a list of
  // callers somebody has to keep complete (Law 16, Law 27).
  //
  // IT RUNS BEFORE THE LAUNCH AND MUST: the repair client wears this bot's own username, and a name
  // holds exactly one connection. Refusing to launch is the right outcome when the repair fails —
  // default-stopped (Law 13) — because the alternative is the unreachable process described above.
  const revived = await reviveIfDead(botId);
  if (!revived.ok) {
    console.error(`bot-start: ${botId} was NOT launched — ${revived.why}. A launch onto a corpse produces a process no verb can reach.`);
    return false;
  }

  // ── A SEAT DOES NOT REMEMBER ITS LAST OCCUPANT (Architect 2026-09-05) ──────────────────────────────
  //
  // *"durable player keyed HQ that exists until i hand delete them."* The durable half now lives in the
  // overseer's per-player store; this is the half that makes his DELETION stick.
  //
  // A roster name is a seat that changes hands. Its working memory —
  // `js_kernel/corporate_headquarters.<botId>.json` — is not swept by anything: `resetRunArtifacts`
  // clears only `fleet_logs/`. So a body handed to a new person boots holding the last person's rooms
  // and stations, and on its first `hq_delta` it broadcasts them back up to the overseer, which merges
  // them and writes them to disk. **A player file he deleted by hand would reappear**, authored by a bot
  // that has no business remembering that person at all.
  //
  // CONTRACTORS ONLY, AND THE ASYMMETRY IS THE MANDATE ITSELF. A homesteader answers to nobody and is
  // the Architect's own standing fleet — its memory is its life's work and clearing it on every start
  // would be the destructive default this system spent a day removing. A contractor exists because a
  // stranger asked for it ten seconds ago and is released when they leave; it has nothing to carry that
  // is worth carrying, and everything it might carry belongs to somebody else.
  //
  // WHAT IS NOT LOST: the crew's PLACES. Those live in the overseer's player store and arrive in the
  // first `hq_broadcast` after this body registers — which is exactly the *"grab their hq and use that
  // as my base"* he described, and is why this deletion is safe rather than merely tidy.
  if (mode === BOT_MODES.CONTRACTOR) {
    const hqFile = path.join(BOT_DIR, 'js_kernel', `corporate_headquarters.${botId}.json`);
    try {
      if (fs.existsSync(hqFile)) {
        fs.rmSync(hqFile, { force: true });
        console.log(`${botId}: swept a legacy HQ file left by an older build — contractors keep no memory of their own.`);
      }
    } catch (e) {
      // REPORTED, NOT FATAL, AND NO LONGER LOAD-BEARING (2026-09-05). This delete used to be the whole
      // mechanism keeping a seat blank between tenants, so a failure here meant a previous occupant's
      // rooms could be re-broadcast. It is now a sweep for files written by earlier builds:
      // `corporate_headquarters` refuses to LOAD one for a contractor at all, so a file this failed to
      // remove is inert rather than dangerous.
      console.error(`${botId}: could not sweep ${path.basename(hqFile)} (${e.code || e.message}) — harmless; a contractor does not read it.`);
    }
  }

  // The species is STAMPED here rather than defaulted at the reader, and that is the whole Law 13
  // point: a default inside bot_mandate would turn a mis-wired launcher into a plausible-looking bot,
  // while a stamp here turns it into a boot-time throw that names the launcher which forgot.
  launch(botId, process.execPath, ['start_bot.js'], BOT_DIR, {
    NODE_PATH: nodePathEnv(),
    BOT_ID: botId,
    BOT_MODE: mode,
    // Travels the same road as the species for the same reason: a birth fact belongs in the environment
    // that created the process, where nothing running can rewrite it.
    ...(owner ? { BOT_OWNER: owner } : {}),
    OVERSEER_URL: `ws://localhost:${port}`,
  });
  console.log(`${botId}: starting as ${mode.toUpperCase()}${owner ? ` for ${owner}` : ''}.`);
  return true;
}

// nextFreeBot — the roster is the ceiling. "there can only be as many bots as there are names."
// Names are taken in SENIORITY order, so the eldest free name is always the one handed out; ROSTER is
// already sorted that way at the top of this file. Returns null when every name is out, which the
// caller reports as a full house rather than inventing a name (Law 13).
function nextFreeBot() {
  const rt = readRuntime();
  for (const id of ROSTER) if (!(rt[id] && pidAlive(rt[id]))) return id;
  return null;
}

// foremanStart — the in-game clerk. Its own visible window like every other fleet process, because a
// windowless orphan once held port 25565 and that rule has not been relaxed.
// playersOnline — the names the SERVER says are in the world, as an exact list.
//
// `list` answers "There are N of a max of M players online: A, B, C", and the names are taken from
// after the LAST colon because the preamble contains one too. Names are compared exactly rather than
// searched for as substrings: a substring test says yes to `Foreman` when the only player present is
// `ForemanKeeper`, which is the presence check reporting on the wrong player entirely.
async function playersOnline() {
  const said = (await rconCommand('list')) || '';
  const tail = said.slice(said.lastIndexOf(':') + 1);
  return tail.split(',').map(s => s.trim()).filter(Boolean);
}

// IS THIS ONE PLAYER IN THE WORLD? Asked of the entity directly, NEVER by looking for the name in `list`.
//
// WHY, measured 2026-09-05 on the public server with a full fleet up: the server's own `list` reply is
// TRUNCATED. Twenty players online, and the reply is 180 characters ending in a literal ", ..." after the
// fourteenth name — confirmed through two independent rcon clients, so it is the server truncating and not
// a packet this code failed to reassemble. `playersOnline()` therefore returns a SHORT LIST with no
// indication that it is short, and every membership test against it is a coin flip decided by join order.
//
// The foreman joins last, after twenty bots, so it fell off the end every single time. `foremanStart`
// waited its full 45 seconds and reported `Foreman never appeared in the server's player list` while
// Foreman was standing in the world — the proxy log showed it admitted and connected one second after
// launch. It is the same defect this project keeps meeting in new clothes: an instrument that quietly
// returns a PARTIAL answer, and a caller that reads the gap as a fact about the world (Law 23/25).
//
// `data get entity <name>` asks about exactly one player and cannot overflow, so the answer is the same
// whether the name is first or twenty-first. "No entity was found" is the negative; anything else is the
// player answering. It is the same call `foremanToSpectator` already reads a game mode back with, so this
// is the shape the file already trusted for a single-player question.
async function playerPresent(name) {
  const said = (await rconCommand(`data get entity ${name} playerGameType`)) || '';
  return said.includes(`${name} has the following entity data`);
}

async function foremanStart() {
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  const already = rt.foreman && pidAlive(rt.foreman);
  if (already) console.log(`foreman: process already running (pid ${rt.foreman.pid}) — confirming it is actually in the world.`);
  else {
    launch('foreman', process.execPath, [path.join('foreman', 'foreman.js')], BOT_DIR, {
      NODE_PATH: nodePathEnv(),
      OVERSEER_URL: `ws://localhost:${port}`,
    });
  }

  // PRESENCE IS CONFIRMED, NOT ASSUMED (Law 25). A spawned process is not a foreman standing in the
  // world: it can die on a version mismatch, be refused by the whitelist, or fail to resolve the
  // host, and every one of those exits AFTER launch() has already returned. Reporting "on duty" off
  // the spawn would send a human in to speak to a clerk that is not there — and a foreman that is
  // simply deaf looks identical from inside the game, so that is the one failure they cannot
  // diagnose from where they are standing.
  //
  // The SERVER is asked, rather than the foreman's own window or its pid. The foreman holds a player
  // slot, so the server's player list is the one party that knows whether it arrived; a process
  // reporting on itself is a claim, and the roster is the world's own answer (Law 23).
  //
  // AN ALREADY-RUNNING FOREMAN IS PUT THROUGH THE SAME GATE. A live pid is a fact about a process, not
  // about the world: the process is alive for the whole of its startup before it has connected, and
  // a run that took the pid as proof would hand back a bench whose clerk is still on its way in.
  // One pathway, one standard of evidence (Law 16) — the only difference is that a foreman already
  // present satisfies it on the first poll.
  // THE INSTRUMENT'S OWN SILENCE IS RECORDED, NOT DISCARDED. Swallowing the rcon error and returning
  // false is correct DURING the wait — a backend still opening its port is not a verdict about the
  // foreman — but it is a lie at the END of it. If rcon never answered once, this function learned
  // nothing about the world in 45 seconds, and saying "never appeared in the player list" reports the
  // absence of a measurement as the absence of a foreman. Measured 2026-09-05: exactly that, while the
  // backend log said `Foreman joined the game`. Law 25 — the caller must be able to tell a boundary of
  // the instrument from a fact about the world.
  let everAnswered = false;
  let lastRconError = null;
  const here = await waitFor(`${FOREMAN_NAME} to reach the world`, async () => {
    try { const p = await playerPresent(FOREMAN_NAME); everAnswered = true; return p; }
    catch (e) { lastRconError = e; return false; }   // not answering YET — keep waiting, not a verdict
  }, 45000, 1000);
  if (here) console.log(`foreman: on duty — the server lists ${FOREMAN_NAME} in the world.`);
  else if (!everAnswered) {
    console.error(`foreman: CANNOT TELL. The process is ${already ? 'running' : 'launched'}, but rcon never `
      + `answered once in 45s, so nothing here has looked at the world at all — this is NOT a report that `
      + `${FOREMAN_NAME} is missing. Reason: ${lastRconError ? lastRconError.message : 'rcon unreachable'}`);
  }
  else console.error(`foreman: the process is ${already ? 'running' : 'launched'}, but ${FOREMAN_NAME} never appeared in the server's player list. Check the foreman window; do NOT expect it to answer in game.`);
  if (here) await foremanToSpectator();
  return here;
}

// THE FOREMAN IS A DESK, NOT A BODY (Architect 2026-08-31: *"foreman is a live player, needs to be a
// spectator. not a player."*).
//
// It is a mineflayer client, so the server gives it a survival body like any other login: it stands in
// the world with collision, a health bar, hunger, and a skin other players can see and walk into. None of
// that serves anything it does — it listens on a chat channel and answers. What the body actually costs is
// the world's own consistency: a person walking up to the base finds a silent motionless player standing
// in it, mobs path to it, it can be pushed, drowned or killed, and a killed foreman is a desk that stops
// answering for a reason nobody watching would connect to it.
//
// SPECTATOR IS THE MINECRAFT ANSWER, applied over rcon rather than built: no collision, no damage, no
// hunger, invisible to players, and chat unchanged — which is the only faculty the foreman uses.
//
// APPLIED HERE, EVERY RUN, rather than saved anywhere. Game mode lives in the world's playerdata, and a
// run's first act is often a snapshot restore that replaces that folder wholesale — so a mode set once is
// silently gone the next time the world rolls back. Setting it after every confirmed arrival is the only
// version of this that survives the thing the bench does most.
//
// READ BACK, NEVER ASSUMED (Law 23, the same discipline the gamerules above use): `playerGameType` is the
// server's own answer, and 3 is spectator. NEVER FATAL — a foreman standing in survival still takes
// orders, so a failure here is reported and the run continues rather than losing the desk over a cosmetic.
const SPECTATOR_GAME_TYPE = 3;
async function foremanToSpectator() {
  try {
    await rconCommand(`gamemode spectator ${FOREMAN_NAME}`);
    const after = (await rconCommand(`data get entity ${FOREMAN_NAME} playerGameType`)) || '';
    console.log(new RegExp(`\\b${SPECTATOR_GAME_TYPE}\\b`).test(after)
      ? `foreman: ${FOREMAN_NAME} set to SPECTATOR — no body, no collision, invisible to players.`
      : `foreman: ⚠ ${FOREMAN_NAME} would not go spectator — server said "${after.trim()}". It is still a live player in the world.`);
  } catch (e) {
    console.log(`foreman: ⚠ could not set spectator (${e.message}) — ${FOREMAN_NAME} stays a live player. The desk still works.`);
  }
}

async function sendVerb(verb, args = {}) {
  const { OPERATOR_VERBS: VERBS } = require(paths.bot('overseer/message_schema'));   // one vocabulary, three processes (Law 16)
  if (!VERBS.has(verb)) {
    console.error(`verb: '${verb}' is not an operator verb (${[...VERBS].join(' | ')}).`);
    return false;
  }
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  if (!(await probePort(port))) {
    console.error(`verb: no overseer on port ${port}.`);
    return false;
  }
  const WebSocket = requireWs();
  const { createEnvelope } = require(paths.bot('overseer/message_schema'));
  const sent = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => {
      ws.send(JSON.stringify(createEnvelope('operator_command', 'fleet_control', { verb, args })));
      // The overseer answers nothing on this path; give the send a beat to land, then leave.
      setTimeout(() => { ws.close(); console.log(`verb: '${verb}' sent to overseer.`); resolve(true); }, 500);
    });
    ws.on('error', (e) => { console.error(`verb: socket error — ${e.message}`); resolve(false); });
  });
  if (!sent) return false;

  // 'sent' is the socket write, never the outcome (Law 25). Where the verb leaves an observable
  // postcondition, assay it and report THAT. Only flush has one that is cheap and exact (a cold HQ
  // file on disk); `start` and `stop` are left reporting delivery, and that limit is stated here
  // rather than hidden behind a true — see waitForColdHQ for what this cost us.
  if (verb === 'flush') return await waitForColdHQ(parseInt(opt('flush-timeout', '15000'), 10));
  return true;
}

// ── STAGGERED START ─────────────────────────────────────────────────────────────────────────────────
// MEASURED 2026-09-03 (architect_bugsquashing.md round 223, Public_server/CAPACITY.md §5). Twelve bots
// sent `start` in one broadcast: NINE were kicked off the server inside seventy seconds. Twelve bots
// running is fine — the machine sat at 20% busy and the server held 20.0 TPS. Twelve bots STARTING
// together is not.
//
// WHY, and it is not a capacity problem. Each bot is one Node process with ONE event loop. A route
// search over tens of thousands of nodes blocks that loop, and a blocked loop sends no packets. Twelve
// bots planning at once stretch each other's searches through CPU contention until one goes silent for
// thirty seconds — at which point the proxy AND the server both conclude the client is dead and drop it.
// The bots were alive and working the whole time. They could not answer.
//
// The proxy's half is configurable and was widened (velocity.toml read-timeout 30s -> 120s). The
// server's half is NOT: the thirty-second keep-alive lives in vanilla's packet handler and Paper 1.21.5
// exposes no key for it. So the only remaining lever is the one the Architect asked for — arrive one at
// a time:
//
//   "a start command should straggle all bots. so on a homestead server, it should pace starts to
//    prevent dropping or kicking."
//
// PACED BY DEFAULT, not behind a flag. A default that drops two thirds of the fleet is not a default
// worth preserving for speed, and the cost is only wall-clock on a server that runs continuously.
// `--stagger=0` restores the broadcast for anyone who wants it.
//
// ── DYNAMIC, NOT A TIMER (Architect 2026-09-03) ─────────────────────────────────────────────────────
// The first version of this paced starts by a fixed 30 SECONDS — the interval the server enforces before
// dropping a silent client. It worked and he rejected it, correctly:
//
//   "thats way to slow. 30 seconds is way to slow... the first first movement the bot does releases the
//    lock... im a fan of dynamic scheduling instead of timers."
//
// A timer prices EVERY bot at the worst case. A bot that finished thinking in four seconds still cost
// thirty, and twelve bots cost five and a half minutes to avoid a hazard that is usually over in a few.
//
// The bot now says when it is done. `navigator.js` posts a one-time `FIRST MOVE` line the moment a route
// EXISTS — see its header for why that instant and not the first step: the A* search is the expensive
// thing, walking the result is nearly free, so a bot with a path has stopped starving its peers. This
// waits for that line and releases immediately.
//
// THE TIMER SURVIVES AS A CEILING, NOT A PACE. A bot that never posts the marker (it had nowhere to go,
// it died, it is standing still by design) must not wedge the whole fleet, so the wait ends at
// STAGGER_CEILING_MS and says which bot it gave up on rather than failing silently. That is the
// difference between a fallback and a guess: the fallback is announced (Law 25).
// ONE SIGNAL WAS NOT ENOUGH, AND THE MEASUREMENT SAID SO. `FIRST MOVE` was the only marker until
// 2026-09-04, when a 12-bot start was traced and exactly ONE bot in eleven had ever emitted it. The
// premise was wrong: a bot's first act after `start` is frequently not a walk at all — it crafts, sorts
// its inventory, mines a block it is already standing on, or parks — so the marker it was waiting for
// was never coming, and every one of those bots cost the full 45-second ceiling. Six bots took 235s to
// start for that reason alone, nearly all of it spent waiting on a line that would never be written.
//
// THE UNIVERSAL SIGNAL IS THE PLANNING TOKEN, and it was already there. `overseer_link` runs the plan
// phase as a FLEET-WIDE MUTEX — one bot plans at a time, losers park until promoted — so every bot,
// whatever it decides to do, passes through acquire → plan → release. The release is therefore the exact
// event this pacing wants ("this bot is done with the expensive part") and it is emitted by every bot
// rather than by the minority that happen to walk somewhere. Movement stays as the SECOND marker because
// it is strictly earlier when it does happen: a bot with a route has finished thinking whether or not it
// has let go of the token yet. First of the two wins.
//
// WORTH KNOWING BEFORE TUNING THIS FURTHER: because the token is a fleet mutex, the planning burst this
// stagger was built to prevent is ALREADY serialized by the arbiter. The stagger's remaining job is the
// narrower one of keeping twelve JOIN + world-load bursts off each other, so a ceiling hit is cheap
// insurance now rather than the load-bearing mechanism it was assumed to be.
const STAGGER_CEILING_MS = 45000;   // longest this will wait on any one bot before moving on
const STAGGER_MIN_GAP_MS = 1500;    // floor between starts, so an all-ready fleet still trickles in
const FIRST_MOVE_MARK = 'FIRST MOVE';
const PLAN_DONE_MARK   = 'Released planning token';

// Read the bot's OWN trace file — the same route `botOnline` uses for the spawn marker and the same one
// `lanista_conductor` waits on rather than sleeping (Law 16, one story read by whoever needs it).
// Returns the raw text so a caller can BASELINE it; presence alone is not a decision.
function botTraceText(botId) {
  try {
    return fs.readFileSync(require(paths.bot('js_kernel/utils/record_homes')).traceFile(botId), 'utf8');
  } catch (_) { return ''; }   // file not written yet = nothing has happened yet
}

// COUNTED, NOT TESTED FOR PRESENCE. A bot plans many times over a run, so "the trace contains a
// plan-done line" is true forever after the first one and answers a question nobody asked. What the
// pacing needs is "has ANOTHER one happened since I sent the verb", which is a count that went up.
// Presence plus "the file got longer" was tried first and is not good enough: the trace grows from every
// log line a bot writes, so any bot that had planned even once before `start` passed instantly — six
// bots all reporting an identical 1.8s, which is what a broken clock looks like when it is fast.
function planPhaseCount(text) {
  let n = 0, i = 0;
  for (const mark of [FIRST_MOVE_MARK, PLAN_DONE_MARK]) {
    i = 0;
    while ((i = text.indexOf(mark, i)) !== -1) { n++; i += mark.length; }
  }
  return n;
}

// Wait for `botId` to get past its first plan. Returns how it ended, because the caller reports it: a
// ceiling hit is information about that bot, not an error, and it is the operator's cue to go and look.
//
// BASELINED BEFORE THE VERB, NOT MATCHED ABSOLUTELY. A mark already present when `start` was sent belongs
// to something the bot did while joining, and counting it would release the next bot instantly — pacing
// that reports a 2-second wait while doing nothing at all. Only a mark that appears AFTER the verb is
// evidence that THIS start got past planning (Law 25 — the answer has to match the question asked).
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
  // --stagger is now the CEILING. Kept as the same flag name because it is the same knob - "how long may
  // one bot hold up the next" - and a second name for it would be a second thing to learn.
  const stagger = parseInt(opt('stagger', String(STAGGER_CEILING_MS)), 10);
  const minGap = parseInt(opt('min-gap', String(STAGGER_MIN_GAP_MS)), 10);

  // WHICH BOTS, and why this is `pidAlive` and NOT `botOnline`. `botOnline` greps a bot's own trace for
  // an "Online at (" marker, which answers "did this bot ever announce a spawn in the CURRENT trace" —
  // a different question, and measured 2026-09-03 to say 5 while the server itself reported all 12
  // connected (bots relaunched individually rewrite that file; their peers' markers had aged out of the
  // run). A start list built on it silently skips bots, which is a worse failure than the broadcast this
  // function exists to replace: nobody notices seven bots that were never told to start.
  //
  // The question here is narrower and has an exact answer: **is there a live process to receive the
  // verb**. That is the runtime pid map, confirmed against process start time so a reissued pid cannot
  // masquerade as ours.
  const rt = readRuntime();
  const online = ROSTER.filter(id => pidAlive(rt[id]));

  if (!online.length) {
    console.error('start: no bot processes are running. Run `bots-up` first — this paces autonomy, it does not launch anyone.');
    return false;
  }
  // One bot is not a storm. Broadcasting is also correct here and is one fewer moving part.
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
    // Per-bot, not broadcast: the overseer already routes `start` by `args.bot` (the `run` profile path
    // uses the same call), so this needs no new vocabulary.
    // Read BEFORE the verb goes out — see waitForFirstMove. Taken here rather than inside the wait so
    // it cannot accidentally include anything this start caused.
    const baseline = botTraceText(id);
    const ok = await sendVerb('start', { bot: id });
    if (ok) started++;
    if (i === online.length - 1) {
      console.log(`  [${i + 1}/${online.length}] ${id}${ok ? '' : ' — SEND FAILED'}`);
      break;
    }
    // The wait is on the bot that was just started, not on a clock. A send that failed is not waited on
    // at all — there is nothing running to report movement, and waiting the full ceiling for it would
    // charge the whole fleet for one failure.
    const r = ok ? await waitForFirstMove(id, stagger, baseline) : { moved: false, ms: 0 };
    if (r.moved && r.ms < minGap) await new Promise(res => setTimeout(res, minGap - r.ms));
    // Reported per bot rather than only at the end: a progress line is the difference between "working"
    // and "hung" to whoever is watching the window — and here it also shows the pacing ADAPTING, which is
    // the whole point of the change.
    const how = !ok ? 'SEND FAILED'
      : r.moved ? `done planning after ${(r.ms / 1000).toFixed(1)}s — releasing the next`
      : `NO plan-done signal in ${(r.ms / 1000).toFixed(0)}s — moving on without it`;
    if (ok && !r.moved) slow.push(id);
    console.log(`  [${i + 1}/${online.length}] ${id} — ${how}`);
  }

  // Delivery, not outcome (Law 25). What this loop can honestly claim is that each bot was sent its
  // verb without another bot's burst on top of it; whether all of them are still connected is a question
  // for the server, and the operator is pointed at the thing that can answer it.
  console.log(`start: ${started} of ${online.length} verb(s) delivered, paced by each bot finishing its first plan.`);
  if (slow.length) {
    // Named, never swallowed. A bot that never reported movement is the one case where the pacing did
    // NOT do its job, and it is also the most likely bot to have been dropped.
    console.log(`  hit the ceiling with no plan-done signal: ${slow.join(', ')} — check these first.`);
  }
  console.log('  Confirm they actually held:  node Public_server\\rcon.js list');
  return started === online.length;
}

// A RUN STARTS CLEAN, AND THE ROOM IS THE WHOLE OF fleet_logs (Architect 2026-08-31):
//
//   "there should be one place to write logs and jsons, one way to write, one major writer and all data
//    is overwritten at the beginning of a run no exception. longterm data is extrated and written down
//    into markdowns. thats the long term memory, we dont keep raw data we keep the interpetation and
//    usefulness of it."
//
// WHY NO RECORD IS EXEMPT. The temptation is always one file: a ledger of trials, a series of metrics, a
// snapshot to diff the next run against. Each is individually reasonable and all of them are the same
// error — the fleet CHANGES between runs, so a row written last week and a row written today did not
// measure the same system, and a comparison across them reads as evidence while being none (Invariant B:
// remembered state carries stale intent invisibly, and it is worst exactly where it looks most like
// data). Three such files existed and all three are gone; what replaced them is a person reading a run
// and writing the CONCLUSION into a markdown, which is the only form that survives the code changing
// underneath it.
//
// The sweep therefore names no filenames and keeps no exception list. It empties the room. A pattern or
// an allow-list would put the property in a filter someone must remember to maintain, and the first
// record added by a future instrument would quietly outlive its run (Law 27 — settle it by defining the
// place). Writers create what they need on demand, so nothing is recreated here.
async function resetRunArtifacts() {
  const logsDir = path.join(BOT_DIR, 'fleet_logs');
  let files = 0, bytes = 0;
  const held = [];
  const sweep = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }              // absent on a fresh clone — nothing to release
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { sweep(full); try { fs.rmdirSync(full); } catch (_) { /* not empty: a held file below */ } continue; }
      // A FILE THAT WILL NOT DELETE IS NAMED, NEVER SKIPPED QUIETLY. On Windows an open handle refuses
      // the unlink, and the one thing that must not happen is a run starting on last run's records while
      // the console says it started clean (Law 25). Reported to the operator, who owns the decision.
      try { bytes += fs.statSync(full).size; fs.rmSync(full, { force: true }); files++; }
      catch (e2) { held.push(`${path.relative(logsDir, full)} (${e2.code || e2.message})`); }
    }
  };
  sweep(logsDir);
  console.log(`reset: released ${files} run record(s), ${(bytes / 1e6).toFixed(1)} MB — fleet_logs is empty for this run.`);
  if (held.length) {
    console.log(`reset: ⚠ ${held.length} file(s) WOULD NOT RELEASE and this run will read them as its own:`);
    for (const h of held) console.log(`  ${h}`);
    console.log('  Something still has them open — check for a fleet that did not come down.');
  }
}

// Every start is a fresh run: tear down any lingering bot-side processes (trace, bots, overseer —
// NEVER the server) before the log flush, so no reused process survives to rewrite its in-memory
// watcher story back over the cleared files (the stale-error-replay bug, Architect 2026-07-08).
// A graceful `verb stop` first lets bots persist HQ before dying, so the fleet's memory is intact
// on the next launch. Safe when nothing is running: probePort is false and the pids are dead, so it
// is a no-op. HQ (corporate_headquarters*.json) is never touched here.
async function teardownBotSide() {
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  if (await probePort(port)) {
    await sendVerb('stop');
    await new Promise(r => setTimeout(r, 4000));   // let bots persist tail/HQ then exit
  }
  for (const name of FLEET_PROCESSES) {
    const entry = rt[name];
    if (entry && pidAlive(entry)) {
      try { killTree(entry.pid); console.log(`${name}: pid ${entry.pid} terminated (fresh-start teardown).`); }
      catch (_) { /* already gone */ }
    }
  }
}

// A RECORDED PID IS NOT ALWAYS THE WHOLE PROCESS. Measured 2026-09-03: `down` reported
// `fleet-console: pid 11616 terminated` and left a live node process still holding a console window,
// because that entry's recorded pid is the PowerShell wrapper and the node doing the work is its child.
// A bare `process.kill` takes the parent and orphans the child - and an orphaned window that keeps
// showing a story about a fleet that no longer exists is precisely the zombie the visible-window rule
// exists to prevent (Law 8).
//
// So the automatic teardown takes the TREE, the same way `takeover`'s forceKill always has. This is not
// the same reflex as forceKill's: that one is the operator's deliberate override and says so loudly;
// this is the ordinary path and simply refuses to leave children behind. `/T` is a no-op on a process
// with no descendants, so a bot whose recorded pid IS the node is unaffected.
function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid);
}

// No auto-launched trace window anymore (Architect, 2026-07-14): the live observer is now the
// dashboard (monitoring/dashboard.js → fleet_logs/traces/dashboard.json, watched in the editor), which the
// Architect runs himself. trace_monitor stays the AI dev's on-demand tool (--story/--around and the
// separate --watch --exit-on-flag wake-arm). Teardown still reaps a 'trace' process defensively in
// case one was launched by an older build, so those name-lists keep the entry harmlessly.

// A launched bot process is NOT a ready bot: it still has to connect to the overseer and spawn into
// the world (several seconds). A `verb start` sent into that gap is silently dropped by the overseer
// ("No bots connected — 'start' not sent") and the send still returns success, so the caller never
// knows autonomy never began — the bots sit connected but idle. The bot announces readiness in its
// own watcher story with "Online at (x, y, z)" (written on register + spawn); those files are cleared
// at the top of every up(), so a fresh marker is unambiguously this run's. Gating up() on it means
// "up" only returns once the fleet is genuinely ready for `start` — fixing the race for BOTH the human
// flow (up returns → type start) and the attended background-watch flow (up returns → verb start).
function botOnline(botId) {
  try {
    return /Online at \(/.test(fs.readFileSync(require(paths.bot('js_kernel/utils/record_homes')).traceFile(botId), 'utf8'));
  } catch (_) { return false; }   // file not yet written = not online yet
}
function waitForBotsOnline(botIds, timeoutMs) {
  return waitFor(`bots online [${botIds.join(', ')}]`, () => botIds.every(botOnline), timeoutMs, 1000);
}

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

// The same defect the botOnline gate above fixes for `start`, one verb over: `verb flush` reported
// success when the SOCKET WRITE landed (a 500ms setTimeout, then resolve(true)) — the performer's
// criterion substituted for the asker's, which is "HQ is cold" (Law 25). It cost a real run: on
// 2026-07-20 a scan test printed "verb: 'flush' sent to overseer", then the base-layout survey opened
// on 12 plots already locked and drove lock_all_buildspots into a recursive-judge loop. The run was
// warm wearing a success flag.
//
// Delivery is unobservable on that path (the overseer answers nothing back), so this does NOT try to
// time the race better — a better guess is still a guess. It reads the real state the flush was
// supposed to produce (Law 26: the translator verifies against world-state instead of modelling the
// machine). waitFor returns on FIRST satisfaction, so observing cold once is the proof; a bot that
// legitimately repopulates HQ afterward does not retroactively fail the flush.
//
// Scoped to bots that are ONLINE — those are the ones that could have received the broadcast. An
// offline bot's stale file is a real problem, but not this verb's to fail on.
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
  // Say what was SEEN, not just that nothing went wrong: waitFor is silent on success, and a gate whose
  // only evidence is the absence of an error reads identically to a gate that never ran (Law 6).
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

async function up() {
  const count = Math.min(parseInt(opt('count', String(ROSTER.length)), 10), ROSTER.length);
  await teardownBotSide();
  await resetRunArtifacts();
  if (!(await serverStart())) return false;
  if (!(await overseerStart())) return false;
  for (let i = 0; i < count; i++) {
    await botStart(ROSTER[i]);
    if (i < count - 1) await new Promise(r => setTimeout(r, 2000));   // same spawn stagger as start_fleet
  }
  const roster = ROSTER.slice(0, count);
  if (!(await waitForBotsOnline(roster, 90000))) {
    console.error(`up: bot(s) launched but did not come online within 90s — missing [${roster.filter(b => !botOnline(b)).join(', ')}]. Check each process window. NOT ready for \`start\`.`);
    return false;
  }
  console.log(`up: server + overseer + ${count} bot(s) ONLINE. Autonomy is NOT started — send \`verb start\` deliberately. Watch the run with .\\Auren_Workshop\\scripts\\dashboard.ps1`);
  return true;
}

// ── THE LOCAL SERVER — this machine, for testing, while the dedicated one stays up ─────────────────
// THE ASK (Architect 2026-09-05): *"we dont have to use the remote server. we can do a contractor test on
// this computer correct?… so make a test version for me to use to minimize downtime. so i will work on
// the local version on this computer while dedicated stays up, make changes and just restart the main
// server when i apply changes… it starts nearly identical to the server start withuot the online checks
// because i will only be using it locally so no need for access port."*
//
// TWO SERVERS, TWO NAMES, AND THE NAMES ARE HIS:
//   **dedicated server** — the public one strangers join. Proxy, join gate, warden, `online.ps1`, and the
//                          eight-step joinable check that ends outside the machine.
//   **local server**     — this. The world on this box, reached at localhost, with none of that.
//
// WHY IT IS A VERB HERE RATHER THAN A THIRD SCRIPT AT THE REPO ROOT. His standing ruling on the operator
// surface is *"you are allowed exactly 2 scripts. either up or down"*, and that pair (`online.ps1` /
// `offline.ps1`) belongs to the dedicated stack. The local world is the FLEET's own server, which already
// has exactly one launcher — this file — so the local path is a verb on the one implementation and is
// surfaced through the one wrapper (Law 16). Nothing new appears at the root.
//
// WHAT IT DELIBERATELY DOES NOT DO, which is the whole of *"without the online checks"*: no proxy, no
// AurenGate, no TCPShield, no public address, no `joinable.js`, no warden. Those exist to answer *can a
// stranger get in*, and on a world only this machine can reach that question has no meaning — an
// instrument that cannot fail is not reassurance, it is noise (and `online` is a word this project has
// already had to make honest once).
//
// ZERO BOTS, LIKE THE DEDICATED ONE, and that is what makes it a real rehearsal rather than a different
// system: the thing under test is `foreman get`, so a world that came up with a standing roster would be
// testing something nobody is going to ship. `--count=N` is there for the other kind of test.
async function local() {
  // ── THE ONE GUARD, AND IT IS THE ONLY WAY THIS COMMAND COULD DO REAL HARM ────────────────────────
  // `AUREN_SERVER_HOST` / `_PORT` override where every body connects, and `launch()` hands children
  // `{...process.env}` — so a shell that was pointed at the public proxy earlier would have this command
  // start a Minecraft server on THIS box and then send the bots, the foreman and every contractor to the
  // DEDICATED WORLD. Every window would look right. The local server would sit empty while a "local test"
  // edited the world strangers are in.
  //
  // FORCED RATHER THAN REFUSED, because the verb's own name settles the ambiguity: `local` cannot mean
  // anything other than this machine, so an inherited endpoint is stale environment rather than an
  // instruction (Law 25 — the asker's criterion is in the word they said). It is announced when it
  // actually overrides something, never silently.
  const inheritedHost = process.env.AUREN_SERVER_HOST;
  const inheritedPort = process.env.AUREN_SERVER_PORT;
  if ((inheritedHost && inheritedHost !== 'localhost' && inheritedHost !== '127.0.0.1')
      || (inheritedPort && Number(inheritedPort) !== SERVER_PORT)) {
    console.log(`local: this shell was pointed at ${inheritedHost || 'localhost'}:${inheritedPort || SERVER_PORT} — `
      + `overriding to localhost:${SERVER_PORT}. \`local\` means this machine; nothing here touches the dedicated server.`);
  }
  process.env.AUREN_SERVER_HOST = 'localhost';
  process.env.AUREN_SERVER_PORT = String(SERVER_PORT);

  const count = Math.min(parseInt(opt('count', '0'), 10) || 0, ROSTER.length);
  await teardownBotSide();
  await resetRunArtifacts();
  if (!(await serverStart())) return false;
  if (!(await overseerStart())) return false;
  for (let i = 0; i < count; i++) {
    await botStart(ROSTER[i]);
    if (i < count - 1) await new Promise(r => setTimeout(r, 2000));
  }
  if (count && !(await waitForBotsOnline(ROSTER.slice(0, count), 90000))) {
    console.error(`local: bot(s) launched but did not come online within 90s — missing [${ROSTER.slice(0, count).filter(b => !botOnline(b)).join(', ')}].`);
    return false;
  }
  // THE FOREMAN IS THE POINT OF THIS VERB, so it is started even though `up` does not start one: `up`
  // opens a RUN for the operator to drive, and this opens a SERVICE for a human to walk into. It goes
  // last, after the world is up, because it joins the server as a player and has nothing to join before.
  if (!(await foremanStart())) {
    console.error('local: the world and the overseer are up, but the foreman never appeared in the player list — nobody in game can order a bot. Check the foreman window.');
    return false;
  }
  console.log(`\nlocal: LOCAL SERVER UP — world + overseer + foreman${count ? ` + ${count} homesteader(s)` : ', no bots'} on localhost:${SERVER_PORT}.`);
  console.log('  Join it in Minecraft at:  localhost');
  console.log(`  Then say in chat:         ${FOREMAN_PREFIX} get`);
  console.log('  Take it down with:        node Auren_Workshop/fleet_control.js down');
  console.log('  This is the LOCAL server. The dedicated (public) one is untouched and is run by .\\online.ps1.\n');
  return true;
}

// The bots-only twin of up(): never calls serverStart. When the server owner is a human
// running their own launch + snapshot-restore step, this command must not silently spin up
// a java process behind them — it fails fast instead (Law 13: prove safe to continue, don't
// assume the world is the one they meant to test on). Reuses every other up() primitive.
async function botsUp() {
  const count = Math.min(parseInt(opt('count', String(ROSTER.length)), 10), ROSTER.length);
  if (!(await probePort(SERVER_PORT))) {
    console.error(`bots-up: no server listening on ${SERVER_PORT}. This command never launches ` +
      `Minecraft itself — start it yourself (and confirm the snapshot), then re-run.`);
    return false;
  }
  await teardownBotSide();
  await resetRunArtifacts();
  if (!(await overseerStart())) return false;
  for (let i = 0; i < count; i++) {
    await botStart(ROSTER[i]);
    if (i < count - 1) await new Promise(r => setTimeout(r, 2000));
  }
  const roster = ROSTER.slice(0, count);
  if (!(await waitForBotsOnline(roster, 90000))) {
    console.error(`bots-up: bot(s) launched but did not come online within 90s — missing [${roster.filter(b => !botOnline(b)).join(', ')}]. Check each process window. NOT ready for \`start\`.`);
    return false;
  }
  // Opened LAST and only once the bots are actually on: a console that starts before them shows an empty
  // trace, which reads like a fleet that has nothing to say rather than one that has not arrived yet.
  if (!has('no-console')) fleetConsole();
  console.log(`bots-up: overseer + ${count} bot(s) ONLINE — server left untouched, each bot minimized to the taskbar.`);
  console.log(`  Watch them all in the one window titled AUREN FLEET.`);
  console.log(`  Autonomy is NOT started — send \`verb flush\` then \`verb start\` deliberately. \`start\` paces itself.`);
  return true;
}

// WIPE THE FLEET'S MEMORY, ON DISK, WHILE NOTHING IS RUNNING.
//
// A DELETE AND NOT THE `flush` VERB: flush is addressed to running bots through the overseer, so it needs
// somebody to receive it. This is the cold path — the one that works when the whole machine is down, which
// is the only state a world restore can happen in anyway. Absent is a legal HQ state; it is what a bot's
// first-ever boot finds, and it writes a fresh one.
//
// EXTRACTED FROM `runProfile` 2026-09-05 so that the public server's rollback and the bench's fresh start
// are the same act rather than two copies of it (Law 16). It was inline in one caller, and the second
// caller would have been a PowerShell reimplementation of a glob and an rmSync — which is exactly how the
// two would have drifted the first time a fourth memory file was added.
//
// WORLD AND MEMORY ARE ONE DECISION. HQ holds a build centre, sited blueprints, chest and furnace cells —
// coordinates FOR A PARTICULAR WORLD. Restoring the world without wiping this leaves bots acting on
// coordinates that describe terrain that no longer exists (measured: `base_layout` saw a base already laid
// out and never posted, and the crew stood down in 1.3 minutes reporting "finished"). Carrying both
// forward together is what makes a continue a continue. Neither caller may do one without the other.
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// REPAIR — the idempotent twin of `up`. Brings the fleet to its intended state and touches nothing
// that is already in it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// WHY IT CANNOT BE `up` OR `bots-up` (Architect 2026-09-05: *"its also idempotent. that means if i run it
// and some processes are up and some are not then it will fix it for me"*). Both of those OPEN A RUN, and
// the first two things a run does are `teardownBotSide()` and `resetRunArtifacts()` — kill everything
// bot-side, then empty `fleet_logs/`. Run against a fleet that is nine-twelfths healthy, that destroys the
// nine to build twelve, and throws away the records of the run still in progress. It is the correct
// behaviour for starting a run and the exact opposite of repairing one.
//
// SO THIS FUNCTION NEVER TEARS DOWN AND NEVER SWEEPS. The "no record survives a run" rule is not broken
// by that: a repair is the SAME run continuing, so its logs are this run's logs. Only a fresh `up` opens
// a new one and only a fresh `up` clears them.
//
// EVERY STEP IS A PRIMITIVE THAT ALREADY GUARDS ITSELF (Law 16) — `overseerStart` reuses a live port,
// `foremanStart` reuses a live pid and then re-confirms the clerk against the SERVER's player list, and
// `botStart` skips a bot whose recorded pid is still verifiably ours. This function is a sequence, not an
// implementation; the idempotence was already in the parts and had no caller that used only those parts.
//
// AUTONOMY IS NOT SENT unless `--autonomy-if-cold` is passed, and then only if the fleet was ENTIRELY
// cold when this pass began. `verb start` injects a start signal into a bot's kernel, so a repair that
// fired it unconditionally would re-signal nine healthy bots as a side effect of reviving three — the
// precise non-idempotence this command exists to remove. A fleet that was cold has nothing to disturb,
// which is the one case where sending it is safe, and it is also the case the Architect actually hit: the
// machine slept and everything died at once.
//
// The coldness test lives HERE rather than in the caller because this is where the pid map and the
// overseer probe already are; a second implementation in PowerShell would be a second thing to keep true.
// THE DEFAULT IS ZERO BOTS, and that is the public server's model rather than a cautious setting
// (Architect 2026-09-05: *"it shouldnt be bringing up 20 bots. its to order remember? so the server should
// just host the foreman and the overseer. if i want to add homesteaders later i can... theres no room for
// humans"*). On the public world a bot exists because somebody in the game ASKED the foreman for one, and
// it arrives as a CONTRACTOR owned by that person. Twenty homesteaders standing in the world by default
// are twenty of the sixty slots and a share of the tick budget spent on nobody's request - and the whole
// reason the foreman exists is that this is on-order.
//
// `--count=N` still brings up the first N of the roster as homesteaders, which is what a bench run on the
// dev box wants. `up` is unchanged and still defaults to the whole roster: opening a RUN and maintaining a
// SERVICE are different acts, and this is the service.
async function repair() {
  const count = Math.min(parseInt(opt('count', '0'), 10), ROSTER.length);
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const roster = ROSTER.slice(0, count);

  // Taken BEFORE anything is started, because the report has to distinguish "found running" from
  // "started by this pass" — that difference is the whole point of an idempotent command, and it is
  // also what tells the caller whether the fleet was cold (see the autonomy note above).
  const rtBefore = readRuntime();
  const wasCold = !(await probePort(port)) && roster.every(id => !pidAlive(rtBefore[id]));
  const alreadyUp = roster.filter(id => pidAlive(rtBefore[id]));

  // A STANDING BOT NOBODY ORDERED IS REPORTED, NEVER REAPED. With the default count of 0 the roster this
  // pass cares about is empty, so a homesteader somebody started deliberately would go unmentioned - and
  // silently ignoring processes is how a fleet ends up with survivors nobody can account for. It is not
  // killed here either: `repair` starts what is missing and stops nothing, and a bot that is in the world
  // may be a contractor working for a player right now.
  const strays = ROSTER.filter(id => !roster.includes(id) && pidAlive(rtBefore[id]));
  if (count === 0) {
    console.log('repair: on-order server - no homesteaders are started. Bots come from the foreman, on request.');
  } else {
    console.log(`repair: ${alreadyUp.length} of ${roster.length} bot(s) already running; leaving them alone.`);
  }
  if (strays.length) {
    console.log(`repair: ${strays.length} bot(s) running that this pass did not ask for: [${strays.join(', ')}].`);
    console.log('        Left alone - one of them may be working for a player. Stop them with: fleet_control.js verb stop');
  }

  let ok = true;
  if (!(await overseerStart())) {
    console.error('repair: the overseer did not come up. Bots have nothing to register with, so they are NOT launched.');
    return false;   // the one hard dependency — every bot talks through it
  }

  // A LAUNCHED BOT IS NOT A STARTED BOT and the stagger is why. Twelve JVM-adjacent node processes all
  // resolving chunks at once is the storm `up` spaces out; a repair launching four of them has the same
  // problem at a smaller scale, so it borrows the same 2s gap rather than inventing a second answer.
  const started = [];
  for (const id of roster) {
    if (pidAlive(readRuntime()[id])) continue;
    if (await botStart(id)) started.push(id);
    else { ok = false; console.error(`repair: ${id} would not launch — see the line above for the reason.`); }
    await new Promise(r => setTimeout(r, 2000));
  }

  // THE FOREMAN IS LAST, and that ordering is not cosmetic. It confirms itself by asking the SERVER for
  // its player list over rcon, so it is the one step that needs a world it can reach — putting it after
  // the bots means a failure here is unambiguously the foreman's and not a symptom of a fleet still
  // arriving. It is also NOT allowed to fail the whole repair: the foreman is the in-game clerk, and a
  // fleet with no clerk is a fleet that works and cannot be asked for a bot in chat.
  const foremanOk = await foremanStart();
  if (!foremanOk) {
    console.error('repair: the foreman is NOT on duty. Everything else above still stands; nobody can ask for a bot in game.');
  }

  console.log('');
  if (count === 0) {
    // The whole autonomy branch below is about not disturbing bots. With none asked for there are none to
    // disturb and none to start, so saying anything about it would be noise on the one line he reads.
    console.log(`repair: overseer up, foreman ${foremanOk ? 'on duty' : 'NOT on duty'}, no homesteaders (on-order).`);
    return ok && foremanOk;
  }
  console.log(`repair: overseer up, ${alreadyUp.length} bot(s) already there, ${started.length} started`
    + `${started.length ? ' [' + started.join(', ') + ']' : ''}, foreman ${foremanOk ? 'on duty' : 'NOT on duty'}.`);

  if (!has('autonomy-if-cold')) {
    console.log('repair: autonomy was NOT sent. Start it with:  node Auren_Workshop\\fleet_control.js verb start');
  } else if (!wasCold) {
    console.log('repair: autonomy NOT sent — bots were already running when this began, and a broadcast start');
    console.log('        would re-signal them. Send it yourself if you meant to:  fleet_control.js verb start');
  } else if (!started.length) {
    console.log('repair: autonomy not sent — no bot is running to receive it.');
  } else {
    // Bots need to be IN THE WORLD, not merely launched. startStaggered refuses on an empty pid map but
    // cannot tell a process that is still connecting from one that has arrived, so the wait is here —
    // and it is the same marker and the same 90s ceiling `up` gates on, rather than a second answer.
    console.log('');
    console.log(`repair: the fleet was entirely cold, so nothing can be disturbed - waiting for the bots to reach the world.`);
    if (!(await waitForBotsOnline(started, 90000))) {
      console.error(`repair: not every bot arrived within 90s — missing [${started.filter(b => !botOnline(b)).join(', ')}].`);
      console.error('repair: autonomy NOT sent. Check those windows, then send it with:  fleet_control.js verb start');
      return false;
    }
    if (!(await startStaggered())) ok = false;
  }
  return ok && foremanOk;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE COMMANDED START — a run the Architect AUTHORED rather than one he retyped
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// `up` and `test standard` still exist and still do exactly what they did; nothing here replaces
// them and nothing about the BOT was changed to add this. That is deliberate and it is a promise he
// asked for in the same breath: "i dont want current bot logic messed with so i can get a
// homesteader at any time." `bot-start <Name>` is still one command and still stamps homesteader.
//
// What `run` adds is that the ANSWERS live in a file. `up --count=2` encodes a decision in a flag
// that has to be remembered and retyped identically across a round of testing; a profile encodes it
// once, explains itself in its own comments, and reads back the same on round nine as on round one.
//
// EVERY STEP HERE CALLS A PRIMITIVE THAT ALREADY EXISTED (Law 16). This function is a sequence, not
// an implementation — snapshotRestore, serverStart, overseerStart, foremanStart, botStart, sendVerb
// and down are the fleet's own, unchanged. A runner carrying its own copy of "start a bot" would be
// a second launcher to keep in step, which is exactly how `--bot` came to be silently dropped.
async function snapshotRestore(world, snap) {
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', paths.workshop('scripts', 'world_rollback.ps1'),
    '-Action', 'restore', '-Root', serverDir(), '-World', world, '-Name', snap, '-Force'];
  const r = spawnSync('powershell', psArgs, { cwd: serverDir(), encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) { console.error("run: restore of '" + snap + "' failed (rollback.ps1 exited " + r.status + ').'); return false; }
  console.log("run: world '" + world + "' rolled back to '" + snap + "'.");
  return true;
}

// `runbook` — read the authored answers back without running anything.
function stopAnyRecording() {
  const file = paths.workshop('tools', 'record_overlay.js');
  // THE EXIT CODE COMES FROM THE FILE THAT PRODUCES IT (Law 16). This branched on a bare
  // `RECORD_OVERLAY_REQUESTED_NOT_REAPED` that was declared nowhere, so every `down` threw a
  // ReferenceError before it could stop anything — found 2026-09-10 by a run whose teardown crashed.
  // `record_overlay` exits before this require would matter, and its module body is side-effect free
  // (its CLI is behind `require.main === module`), so reading the constant costs nothing.
  const { REQUESTED_NOT_REAPED } = require(file);
  const r = spawnSync(process.execPath, [file, 'stop', '--why=the fleet is coming down'],
    { stdio: 'inherit', cwd: PROJECT_ROOT });
  if (r.status === REQUESTED_NOT_REAPED) return 'requested';
  return r.status === 0 ? 'closed' : 'unclean';
}

async function down() {
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  if (await probePort(port)) {
    await sendVerb('stop');
    // exit persists each bot's tail state then process.exit(0)s — give them a moment.
    await new Promise(r => setTimeout(r, 4000));
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
      `the fleet — but check for a stray OBS and an unwrapped take before the next filmed run.`);
  }
  for (const name of FLEET_PROCESSES) {
    const entry = rt[name];
    if (entry && pidAlive(entry)) {
      // killTree, not process.kill — see its header. A wrapper's child survives a bare kill and keeps
      // its console window open over a fleet that is gone.
      try { killTree(entry.pid); console.log(`${name}: pid ${entry.pid} terminated.`); }
      catch (e) { console.error(`${name}: could not terminate pid ${entry.pid} — ${e.message}`); }
    }
  }
  if (!has('keep-server')) {
    if (!(await serverStop())) return false;
  }
  // ---- The camera crew comes down with the fleet (Architect 2026-08-16) --------------------------
  // A camera window is a game client connected to a server that is now gone: it is not idle, it is a
  // dead window nobody will close, and before this it survived every teardown. `down` is the one verb an
  // operator reaches for when he wants everything off, so everything off is what it must mean.
  // DELEGATED, never reimplemented: start_cameras.ps1 -Down is the owner of that teardown (it knows the
  // director, the clients and the titler), and a second implementation here would be the redundant route
  // Law 16 forbids. Calling an owner's teardown is not owning it.
  // It reports honestly when nothing was up, so this costs a line of output on a terminal-only run — and
  // the failure it prevents (a filmed run whose windows outlive the world) is worth that line.
  //
  // UNCONDITIONAL EVEN THOUGH stopAnyRecording ALREADY CALLED IT on a filmed run, and the second call is
  // deliberate rather than an oversight. `-Down` is convergent — it reaps what it finds and says so when
  // it finds nothing — so the cost of calling it twice is one honest line, while the cost of gating it on
  // "was there a session" is that a crew started by hand, or by a raise that died before it recorded one,
  // survives the fleet. Cheap and always right beats conditional and right most of the time.
  runScript('start_cameras.ps1', ['-Down']);
  // ---- AND THE CONSOLE WINDOWS THAT WERE WATCHING IT (2026-09-10) --------------------------------
  // Same argument as the camera crew directly above, for the same kind of window: a follower tailing a
  // console log is a view of a fleet that is now gone, and `down` means everything off. It is here
  // rather than left to the process that opened it because the foreman's teardown provably does not run
  // on Windows — `console_window.closeStale` carries that measurement.
  const stale = consoleWindow.closeStale();
  if (stale.closed.length) console.log(`down: closed ${stale.closed.length} console window(s) — ${stale.closed.join(', ')}.`);
  console.log('down: done.');
  return true;
}

// Force-terminate a pid decisively. Windows: taskkill /F /T takes the whole process tree (a bot or
// a watch harness can have children); elsewhere SIGKILL. Used ONLY by takeover — the deliberate
// operator override, never the automatic path.
function forceKill(label, pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
    console.log(`${label}: pid ${pid} force-killed.`);
  } catch (e) { console.error(`${label}: could not force-kill pid ${pid} — ${e.message}`); }
}

// Operator kill switch (`takeover`): force-stop the ENTIRE fleet — bots AND server — decisively,
// even where the graceful `down` cannot (RCON disabled, a hung bot, an orphaned server whose pid the
// runtime lost track of). A brief courtesy save runs first so the world flushes when it can; then
// nothing is spared. This is the DELIBERATE, human-invoked override: the automatic loop NEVER
// force-kills the server (Law 17/13, the corruption rail), but the operator — at the pedal by his own
// choice — may (Law 19/21). It is the manual twin of the stop-tuple: one command, the whole fleet down.
async function takeover() {
  console.log('takeover: force-stopping the ENTIRE fleet (bots + server) — operator kill switch.');
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const rt = readRuntime();

  // 1. Brief graceful courtesy so the world can flush when it's able (bounded — this is still a force stop).
  if (await probePort(port)) { try { await sendVerb('stop'); } catch (_) {} }
  if (await probePort(SERVER_PORT)) {
    try { await rconCommand('stop'); console.log('takeover: rcon stop sent (courtesy save).'); } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 3000));

  // 2. Force-kill every known fleet pid — no refusal, no waiting.
  for (const name of FLEET_PROCESSES_WITH_SERVER) {
    const e = rt[name];
    if (e && pidAlive(e)) forceKill(name, e.pid);
  }

  // 3. Orphan catch: the runtime server pid can be stale (a server started outside this launcher —
  //    we have hit exactly that). If the port still answers, kill the java process(es) holding it.
  if ((await probePort(SERVER_PORT)) && process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      'Get-Process java -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $_.Id }'],
      { encoding: 'utf8' });
    const killed = (r.stdout || '').trim();
    if (killed) console.log(`server: force-killed orphan java pid(s) [${killed.replace(/\s+/g, ', ')}].`);
  }

  // 4. Verify and report — a glance confirms it is really down.
  await new Promise(r => setTimeout(r, 1500));
  const serverDown = !(await probePort(SERVER_PORT));
  const overseerDown = !(await probePort(port));
  console.log(`takeover: server ${serverDown ? 'DOWN' : 'STILL UP'} · overseer ${overseerDown ? 'DOWN' : 'STILL UP'}.`);
  console.log(serverDown && overseerDown
    ? 'takeover: fleet fully stopped — nothing left running.'
    : 'takeover: something is STILL UP — check `status` and Task Manager.');
  return serverDown && overseerDown;
}

// One-shot RCON passthrough for operator world-edits (Law 22 recovery: a physically-broken
// tile in an already-built structure needs a world fix, not a code fix — this is the same
// RCON client serverStop() already uses, just exposed generically instead of hardcoded to 'stop').
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

// ── move: the live locomotion test (Architect 2026-07-31) ──────────────────────────────────────────
//
//   node Auren_Workshop/fleet_control.js move --from=-8,65,16 --to=-18,71,15 [--lookahead=N] [--prejump=off] [--bot=AurenBot]
//
// Two voxels: put the body on `from`, then ask the locomotion system to walk it to `to`. It answers
// one question a headless bench structurally cannot — does a body actually cross this ground — and it
// answers it with the fleet's own locomotion ladder rather than a test harness's imitation of one.
//
// THE SPLIT IS THE POINT. The teleport is RCON, because where a test begins is an AUTHORED input to
// the bench (the same rule the sentry verb follows: the arena director places the body, the system
// under test never decides where the fight happens). The walk is a signal into the real graph, because
// that is the thing being measured. Author the setup, READ the result — never the reverse.
//
// The verb is ADDRESSED when --bot is given, so a multi-bot fleet does not send every body to one cell
// (Law 4). Autonomy need not be running: `up` leaves the bots idle and this verb drives locomotion
// directly, so a move test costs one bot and no planning loop.
//
// Law 25 on what this returns: `true` means the teleport landed and the verb was delivered — NOT that
// the bot arrived. The arrival verdict is the injector's, and it is written to the bot's own trace
// (`watcher_<BotId>.json`, tag move_injector) because that is where an outcome sensed by the construct
// belongs. Read it there; this side cannot honestly report it.
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
  // --lookahead: how many walkable cells locomotion may fuse into one continuous press for THIS run.
  // Defaults to the fleet default (3, ratified on the A/B); 1 is the old per-cell walk that stops at
  // every boundary. Same pair, two depths, two traces — the comparison is why this is an argument.
  const lookahead = Math.max(1, Math.min(8, parseInt(opt('lookahead', '3'), 10) || 3));
  // --prejump=off keeps the fusion and removes the early jump, so a slow leg can be attributed to one
  // or the other. They shipped together and the first A/B could not tell them apart.
  const prejump = !/^(off|0|false|no)$/i.test(String(opt('prejump', 'on')));

  // Teleport, then VERIFY. An RCON tp that silently missed (bad name, unloaded chunk) would otherwise
  // surface as a mysterious long walk, and the test would be measuring ground nobody chose (Law 23).
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

// ── THERE IS NO `drive` VERB, AND THE RULING THAT REMOVED IT IS WORTH THE PARAGRAPH ─────────────────
// A `drive` verb lived here for one afternoon on 2026-08-11: a sibling of `move` that teleported a fleet
// bot and dispatched combat locomotion at it through the overseer. The Architect struck the METHOD, not
// the measurement — "read fleet runbook and use testbot. thats how you test individual pieces of bots
// live" — and `tools/combat_drive_probe.js` is the measurement in its ratified home.
//
// It is not a preference between two working routes. The verb route needs the whole fleet standing
// (server + overseer + a bot whose login survives its own playerdata), so a locomotion question is
// answered only when everything unrelated to locomotion happens to be healthy; the same afternoon it was
// unanswerable because a fleet bot's corpse bricked the login. The probe needs a server and nothing
// else. Two routes to one measurement is Law 16 regardless, and this is the one that fails for fewer
// reasons — so do not reintroduce a verb here when a piece of the bot needs driving in isolation.

async function status() {
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
  const rt = readRuntime();
  const serverUp = await probePort(SERVER_PORT);
  console.log(`server (${SERVER_PORT}):   ${serverUp ? 'UP' : 'down'}`);
  console.log(`overseer (${port}): ${(await probePort(port)) ? 'UP' : 'down'}`);

  // WHO IS ACTUALLY IN THE WORLD, asked of the server rather than inferred from pids. A pid says a
  // process exists; only the player list says a body arrived, and the two disagree for the whole of
  // a client's startup and for any client that connected and was refused (Law 25).
  if (serverUp) {
    try {
      const here = await playersOnline();
      // THE COUNT IS TRUSTWORTHY, THE NAMES ARE NOT. The server truncates `list` at roughly 180
      // characters and marks the cut with a literal "..." — so on a full fleet the tail of the roster is
      // simply missing. Saying so is the difference between a short list and a WRONG one: without this
      // line, twenty bots online reads as fourteen and the six that are absent look like a fleet problem.
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
// The ONE place a hard kill is sanctioned. serverStop refuses to hard-kill because a killed java
// risks world corruption (Law 17/13) — but that refusal is a constraint that binds where it is
// defeatable (Law 19): `takeover` is the operator explicitly accepting that risk to GUARANTEE a stop
// when RCON is dead or a process hung. It still tries graceful FIRST (verb stop so bots persist HQ,
// rcon stop so the world flushes) and force-kills only what graceful left standing. Unlike `down`,
// it never trusts a return — it verifies the ports are dead before claiming success.
function forceKill(label, pid) {
  if (!pidAlive(pid)) return;
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
  const port = parseInt(opt('port', String(OVERSEER_PORT_DEFAULT)), 10);
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
    if (e) forceKill(name, e.pid);
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

  const serverDown = !(await probePort(SERVER_PORT));
  const overseerDown = !(await probePort(port));
  console.log(`takeover: server ${serverDown ? 'down' : 'STILL UP'}, overseer ${overseerDown ? 'down' : 'STILL UP'}.`);
  return serverDown && overseerDown;
}

// ── THE NAMED TESTS AND THE AUTHORED PROFILES ARE GONE (2026-09-10) ─────────────────────────────────
// `test standard|continue|scan|record|arena|spawnzone`, plus `run <profile>` and `runbook`, lived here
// and are deleted. Each was ONE FROZEN COMBINATION of settings, so a combination nobody had frozen
// needed a new entry; and each carried its own bring-up order, which is how this file came to hold
// three separate answers to "is the world restored before or after the bots come down".
//
// Replaced by one page and one script (Architect 2026-09-10: *"instead of different scripts to start
// the test. theres one way law 16 on how to do it. then theres one way to configure it"*):
//
//     Auren_Workshop/run_config.js     every setting, authored before anything starts
//     Auren_Workshop/run.js            reads it once and performs the whole run
//
// THE DECISIVE DIFFERENCE IS NOT THE FILE COUNT. Those tests raised bots by running `start_bot.js` and
// handing it a mandate — a door nobody who downloads this repository has. `run.js` seats a player and
// has that PLAYER ask the desk, which is the only way anyone else can get a crew, so a run that works
// is evidence about the build a stranger gets (*"i dont want to test in a way that a public user wont
// be using"*).
//
// WHAT STAYED HERE IS THE PLUMBING, AND IT STAYED ON PURPOSE (*"i still want the same type of
// plumbing"*): `server-start`, `server-stop`, `snapshot`, `snapshot-restore`, `clock`, `down`, `up`,
// `status`, `rcon`, `memory-wipe`, `verb`. `run.js` COMPOSES those verbs instead of reimplementing
// them, so this file remains the one owner of the world's lifecycle (Law 16).
//
// `runScript` survives below because the camera teardown at `stopAnyRecording` still uses it. It is no
// longer a route to a fleet bring-up — the two .ps1 launchers it used to reach are deleted.
const SCRIPTS_DIR = paths.workshop('scripts');

function runScript(name, argv) {
  const file = path.join(SCRIPTS_DIR, name);
  console.log(`test: → ${name} ${argv.join(' ')}\n`);
  return spawnSync('powershell', ['-NoProfile', '-File', file, ...argv], { stdio: 'inherit' }).status === 0;
}


// ── WORLD SPAWN, READ FROM THE WORLD ITSELF ────────────────────────────────────────────────────────
// The centre of the spawn-protected square, taken from `level.dat` — the same value the server sends a
// client in its `spawn_position` packet, which is what the bots gate on. Read rather than assumed, and
// read from the ONE file that is authoritative, so the drill and the crew cannot disagree about where
// the square is (Law 23 — verify, never trust; a drill that aimed at the wrong square would report a
// working gate as broken, or a broken one as working).
//
// It is NBT and there is no rcon verb that will answer this: `data get` reaches entities, blocks and
// storage, never the level. That is why this parses the file instead of asking the running server.
async function worldSpawn(worldName) {
  const file = path.join(serverDir(), worldName, 'level.dat');
  if (!fs.existsSync(file)) return null;
  const nbt = moduleHomes.requireFromHomes('prismarine-nbt');
  const parsed = (await nbt.parse(fs.readFileSync(file))).parsed.value.Data.value;
  const x = parsed.SpawnX?.value, y = parsed.SpawnY?.value, z = parsed.SpawnZ?.value;
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
(async () => {
  const table = {
    'status': status,
    'server-start': serverStart,
    'server-stop': serverStop,
    'snapshot': snapshot,
    // RESTORE, EXPOSED AS A VERB (2026-09-10). `snapshotRestore` already existed and had exactly one
    // caller — the `run --restore` profile — so a fresh world was only reachable by asking for a whole
    // authored run. `run.js` needs the rollback WITHOUT the bring-up that used to come welded to it,
    // because it raises the fleet the stranger's way instead. Exposing the existing function is the
    // Law 16 move; the alternative was `run.js` calling rollback.ps1 itself, which would be a second
    // implementation of this repository's one restore.
    //
    // NOT gated on the server being stopped HERE, because the function's own failure is the honest
    // report: rollback.ps1 refuses a world it cannot safely copy and says so. A guard here would be a
    // second opinion about the same fact (Law 26 — the owner answers).
    'snapshot-restore': () => {
      // The NAME is never defaulted (Law 13): guessing which snapshot was meant would restore the wrong
      // world silently, and there is no way to tell afterwards which one you got.
      const snapName = opt('snapshot', null);
      if (!snapName) {
        console.error('snapshot-restore: which snapshot? Usage: ' +
          'node Auren_Workshop/fleet_control.js snapshot-restore --snapshot=<name> [--world=<name>]');
        return false;
      }
      return snapshotRestore(opt('world', null) || effectiveWorld(), snapName);
    },
    'overseer-start': overseerStart,
    'observer-start': observerStart,
    'bot-start': () => botStart(positional[0], opt('mode', TERMINAL_SPAWN_MODE), opt('owner') || null),
    'foreman-start': foremanStart,
    // --bot ADDRESSES the verb to one bot instead of the whole fleet. It was accepted on the command
    // line and silently dropped here, so `verb stop --bot=X` stopped EVERY bot — the overseer's
    // broadcastCommand has taken an `only` addressee since `move` needed one, and this caller simply
    // never handed it over.
    // `verb start` with no --bot is the one verb that must not be a broadcast — see startStaggered.
    // Every other verb, and `start` aimed at ONE bot, goes straight through unchanged.
    'verb': () => (positional[0] === 'start' && !opt('bot'))
      ? startStaggered()
      : sendVerb(positional[0], opt('bot') ? { bot: opt('bot') } : {}),
    'up': up,
    // THE LOCAL SERVER — this machine, world + overseer + foreman, no bots. The dedicated (public) server
    // is `online.ps1` at the repo root and shares nothing with this path.
    'local': local,
    'bots-up': botsUp,
    'repair': repair,
    // Cold, offline, and deliberately NOT paired with a world restore here: the pairing is enforced by the
    // callers that own both halves (`run --restore`, and the public server's rollback.ps1), because only
    // they know which world is being restored.
    'memory-wipe': () => wipeMemory(),
    // Standalone, because the window it opens is read-only and the usual reason to want it is that it
    // was closed while the fleet kept running.
    'fleet-console': () => { fleetConsole(); return true; },
    'down': down,
    'takeover': takeover,
    'rcon': () => rconExec(positional[0]),
    // The clock, exposed as a verb so the PowerShell benches set it the same way `run` does instead of
    // sending their own `time set` over the generic rcon passthrough (Law 16). Same three answers the
    // authored runs use — fleet_runbook's CLOCKS is where they are declared.
    'clock': async () => {
      // A person typed this, so a wrong word is a correction and never a throw: nothing crosses, the
      // cause is named, and the form that works comes with it (Law 13, correction category).
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
    // Print the canonical roster (seniority order, comma-joined) so the PowerShell launchers read the
    // same single source (architect_config BOT_SENIORITY) instead of a hand-mirrored array (Law 16).
    'roster': () => { console.log(ROSTER.join(',')); return true; },
  };
  const fn = table[cmd];
  if (!fn) {
    console.error(`fleet_control: unknown command '${cmd || ''}'. Commands: ${Object.keys(table).join(' | ')}`);
    process.exit(1);
  }
  const ok = await fn();
  process.exit(ok ? 0 : 1);
})();
