// Auren_Workshop/tools/record_overlay.js
// THE FILMING OVERLAY — one word added to any conducted run turns it into a filmed one, and one command
// closes it. It holds the ORDER of raising a film crew and reaping it, and nothing else.
//
// ── WHY AN OVERLAY AND NOT MORE RUNGS ───────────────────────────────────────────────────────────────
// Filming is orthogonal to what a run IS. `standard`, `continue` and every lanista scenario each have a
// definition worth keeping intact, and "the same run, filmed" must not become a second copy of that
// definition free to drift from the first. So the overlay attaches to a rung rather than replacing it:
// the rung decides what happens in the world, the overlay decides only whether there are lenses on it.
// A rung × overlay table is N + 2 declarations; a rung-per-combination is 2N, and the second copy is the
// one that ages (Law 16).
//
//   run_config.js  run.record: 'film'                      a run with cameras + OBS writing files
//   run_config.js  run.record: 'cameras'                    cameras only, nothing written
//   node tools/lanista_conductor.js ladder record          the combat bench, which still takes the word
//   node tools/record_overlay.js    stop                   THE closer, whichever caller raised it
//
// The two `test_conductor.js record|watch` lines that stood here named a script deleted on 2026-09-10;
// filming is a field on the run page now, not a verb (2026-09-11).
//
// ── WHAT IT ADDS TO A RUN, IN THIS ORDER (every step an existing owner) ─────────────────────────────
//   start_cameras.ps1 -Framing              N bot cameras + director + titler (+ the eye on --architect)
//   wait on camera_rig_ready.json           every client CONFIRMED standing in the world, not just spawned
//   camera_obs.ps1 configure                boot-time OBS config — legal only while OBS is STOPPED
//   camera_obs.ps1 up                       launch OBS, bind one capture per window
//   camera_obs.ps1 start                    one call records every camera
// and reaps it in the mirrored order: recording stopped, OBS quit, clients killed, and only then does
// the conductor take the fleet down. The ordering is the entire value and it is not guessable — OBS
// must be configured while it is stopped (Law 26: build while off, drive while on), `up` binds nothing
// if the windows do not exist yet, and a client killed before the recording is stopped leaves a file no
// muxer ever closed. One step out of order yields footage that looks fine and is black, which is the
// expensive failure because it is only discovered after the run.
//
// ── WHERE IT SITS IN THE RUN, AND WHY THERE ───────────────────────────────────────────────────────
// AFTER the bring-up, BEFORE the work starts. That is one insertion point for every rung, which is what
// keeps the overlay from needing to know what a rung does. The conductors therefore bring their fleet up
// IDLE when an overlay is armed and send the opening verb themselves afterwards — otherwise the lenses
// arrive after the thing worth filming has already begun, and the opening of every run is missing from
// the tape. Cameras need a live server, so earlier is not available.
//
// ── THE ARCHITECT'S EYE — OFF UNLESS ASKED FOR ─────────────────────────────────────────────────────
// One more spectator client, built and launched exactly like a bot camera, that the director arms
// (spectator + night vision) and then never commands — it is absent from the rig's shot list, so a
// human flies it. It gets its own OBS capture and its own file, so what he chooses to look at is on
// disk beside what the directed cameras chose. Its name is declared once, in camera_configure.
//
// It is the ONLY seat in the crew that produces nothing unless a human flies it for the entire run,
// which is why it defaults off (Law 13; the reasoning lives once, in camera_configure). `--architect`
// on either conductor turns it on for that run — a launch-time input, not a config edit (Law 26).
//
// WHY THIS FILE OWNS THE FLAG RATHER THAN THE CONDUCTORS. Both conductors `require` this module and run
// it in their own process, so the flag is parsed here, once, and each conductor only has to ADMIT the
// name into its accepted set (OVERLAY_FLAGS). Two parses would be two answers to one question the
// moment either drifted (Law 16), and the eye belongs to the overlay — it exists only on a filmed run.
//
// THE SAME VALUE GOES TO BOTH RAISERS. The launcher builds the window, camera_obs binds the capture,
// and a disagreement is silent in both directions — an unbound window records nothing, and a capture
// bound to a client that never launched reports a clean start over a black file. Neither throws, and
// both are only discovered after the run.
//
// ── THE CLOSER, AND WHY IT IS ONE COMMAND WITH TWO BEHAVIOURS ──────────────────────────────────────
// A conductor holding a filmed run open is inside a soak, and something has to be able to end that from
// another terminal — the operator is flying a camera in a game window, not watching a console. But two
// processes tearing the same stack down is two owners of one lifecycle (Invariant D), and that is the
// race this must not become. So `stop` never reaps a run that has a live conductor: it REQUESTS, by
// writing a sentinel the conductor reads between soak slices, and the conductor remains the only reaper.
// It reaps directly only when the session on record has no live conductor behind it — a run raised by
// `fleet_control test record`, or a conductor that died. Both cases are stated, never silently merged.
//
// LAW 25 ON THE STOP REPORT: "requested" and "torn down" are different outcomes and are printed as
// different outcomes. A stop that hands a sentinel to a conductor has not stopped anything yet, and
// saying so is the difference between a closer the operator can trust and one he has to go and check.
//
// ── THE FILES, AND WHO OWNS EACH (Law 6, Law 9) ────────────────────────────────────────────────────
//   js_kernel/record_overlay_session.json   written by raise, refreshed by the conductor's heartbeat,
//                                           deleted by reap. What is filming, and whether anyone is
//                                           still driving it.
//   js_kernel/record_overlay_stop.json      written by `stop`, deleted by reap. A request, not a state.
//   js_kernel/machine_load_sampler.json     written and deleted by the sampler itself; this file only
//                                           starts and stops it (Law 9 — one owner per file).
//   js_kernel/camera_rig_ready.json         WRITTEN BY camera_rig, never here. This file clears it before
//                                           a raise and deletes it at reap, and only ever reads it in
//                                           between — the crew's presence is the rig's fact to state.
// No unit both writes and deletes the same file: raise writes the session and clears any stale stop,
// stop writes the stop, reap deletes both and writes neither (Law 9). The stale-stop clear at raise is
// load-bearing rather than tidy — a stop request left behind by a previous run would otherwise close the
// next one within a minute of it starting, and the operator would be told a run ended that never began.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/record_overlay.js');

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

// THE SPLIT RUNS THROUGH THIS BLOCK. What used to be one `BOT_DIR` is now two places: the WORKSHOP holds
// fleet_control, the scripts, the lenses, the camera and the playground; the shipped BOT holds js_kernel,
// foreman and Thinking_fragments. Both are asked of workshop_paths by name, because a single constant
// covering both is the assumption the split just falsified (Law 7).
const paths     = require('../workshop_paths');
const TOOLS_DIR = __dirname;
const REPO_ROOT = paths.REPO_ROOT;
const SCRIPTS   = paths.workshop('scripts');
const KERNEL    = paths.bot('js_kernel');

const SESSION_FILE = path.join(KERNEL, 'record_overlay_session.json');
const STOP_FILE    = path.join(KERNEL, 'record_overlay_stop.json');
// Written by camera_rig, read and cleared here. Never written by this unit (Law 9).
const CREW_READY_FILE = path.join(KERNEL, 'camera_rig_ready.json');

// How long the crew is given to finish joining before the raise is called a failure. Generous on purpose:
// the cost of over-waiting is a slower start, the cost of under-waiting is a run whose first minutes are
// filmed by clients still streaming chunks — and the ceiling only ever fires when something is genuinely
// wrong, because the normal path returns the moment the rig publishes.
const CREW_READY_TIMEOUT_MS = 240000;
const CREW_READY_POLL_MS = 2000;

// How often a conductor holding a filmed run comes up for air. It bounds two things at once: how long
// after `stop` the run actually closes, and how coarse the soak's own arming becomes. A minute is short
// enough that a stop feels immediate and long enough that re-reading the trace 45 times over a 45-minute
// run costs nothing measurable.
const SLICE_SECONDS = 60;
// A conductor is presumed gone after three missed heartbeats. Presuming it gone too early is the harmful
// direction — that is what would put a second reaper on a live run — so the threshold is generous.
const STALE_MS = SLICE_SECONDS * 3 * 1000 + 20000;

// ── The declared overlays ────────────────────────────────────────────────────────────────────────
// DATA, so "what does a record run add" is answerable without reading what it does, and so the two
// differ in exactly one field rather than in two code paths.
const OVERLAYS = {
  record: {
    obs: true,
    blurb: 'cameras for every bot, and OBS recording every one of them to its own file.',
  },
  watch: {
    obs: false,
    blurb: 'cameras for every bot, and NO recording — lenses to watch through, nothing written.',
  },
};

// Flags the overlay owns, for a conductor to union into its own accepted set. A conductor refuses an
// unknown flag before touching anything (Law 25), so a name the overlay reads and the conductor has
// never heard of would be rejected on the way in — the run would refuse rather than film wrong, but it
// would refuse. Exported rather than duplicated: one list, two admissions.
const OVERLAY_FLAGS = ['architect', 'host'];

// Present → on. `--architect=off` forces it off over a config that says true, so a caller can state
// either intent rather than only the loud one. Read from this process's argv because both conductors
// run the overlay in-process; absent, camera_configure decides (Law 16 — one declaration).
function architectEye() { return seatSwitch('architect', c => c.architect); }

// THE HOST SEAT — the client a human PLAYS, and the only file in a take that carries a microphone.
// Read here, once, exactly as the eye is and for the same reason: both conductors and `fleet_control
// run` run this overlay in their own process, so one parse serves every caller and the same value is
// handed to BOTH raisers. That last part is the whole hazard. The launcher builds the window and
// camera_obs binds the capture and routes the voice into its file; if only one of them hears the
// switch, nothing throws — an unbound window records nothing, and a capture bound to a client that
// never launched reports a clean start over a black file, with the presenter's commentary nowhere.
function hostSeat() { return seatSwitch('host', c => c.host); }

// One reader for both, because they are the same question asked of two seats: a flag on this call
// wins, `=off` forces it off over a config that says true, and absent means camera_configure decides
// (Law 16 — one declaration, and the flag is an input authored while the machine is stopped).
function seatSwitch(name, pick) {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) {
    const CFG = require(paths.workshop('camera', 'camera_configure.js'));
    const block = pick(CFG);
    return !!(block && block.enable);
  }
  return hit === `--${name}` || /^(on|true|1|yes)$/i.test(hit.split('=')[1] || '');
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────
function stamp() { return new Date().toTimeString().slice(0, 8); }

function runScript(name, argv, label) {
  const file = path.join(SCRIPTS, name);
  console.log(`\n${stamp()} OVERLAY → ${label}\n           ${name} ${argv.join(' ')}`);
  const r = spawnSync('powershell', ['-NoProfile', '-File', file, ...argv],
    { stdio: 'inherit', cwd: REPO_ROOT });
  const code = r.status === null ? 1 : r.status;   // killed by a signal is a failure, never a 0
  console.log(`${stamp()} OVERLAY   ${label} → exit ${code}`);
  return code === 0;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// ── The session record ───────────────────────────────────────────────────────────────────────────
function readSession() { return readJson(SESSION_FILE); }

function writeSession(session) {
  try {
    fs.mkdirSync(KERNEL, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    return true;
  } catch (e) {
    // Not fatal to the filming, and saying so matters: the crew is up either way, but the stop command
    // has nothing to read, so the operator must know he is closing it by hand (Law 25).
    console.error(`${stamp()} ⚠ could not record the overlay session (${e.message}) — ` +
      `\`record_overlay.js stop\` will not find this run. Close it with --force.`);
    return false;
  }
}

// heartbeat: the conductor saying "I am still here and still the reaper". It is the ONLY thing that
// makes `stop` request rather than reap, so it is deliberately cheap enough to call every slice.
function heartbeat() {
  const s = readSession();
  if (!s) return;
  s.alive_at = Date.now();
  writeSession(s);
}

function conductorIsLive(session) {
  return !!(session && session.conductor_pid && session.alive_at &&
            (Date.now() - session.alive_at) < STALE_MS);
}

// ── The stop request ─────────────────────────────────────────────────────────────────────────────
// A REQUEST, read by the conductor between soak slices. It carries its reason so the run's own summary
// can say why it ended rather than reporting a soak that merely finished early.
function stopRequested() {
  const s = readJson(STOP_FILE);
  return s ? { at: s.at, why: s.why || 'the operator asked for it' } : null;
}

// ── The machine-load sampler ─────────────────────────────────────────────────────────────────────
// A filmed run is the run that puts the most load on the box — N game clients rendering beside the server,
// the bots and a recorder — so it is the run whose machine cost is worth a record, and the overlay is the
// one place that knows a filmed run is happening. Raised and reaped here for that reason alone; it observes
// the machine and joins no pathway of the work (Law 22 scope — the instrument operates ON the run, not IN
// it), so nothing downstream can behave differently because it is running.
//
// DETACHED and given no pipes, deliberately: it outlives the spawnSync-driven steps that follow it in the
// raise, and a pipe nobody drains would block it the moment its output filled the buffer. Its record is on
// disk; this process has no reason to read its console.
function raiseSampler(label) {
  const safeLabel = String(label || 'run').replace(/[^A-Za-z0-9_-]+/g, '_');
  try {
    const child = spawn(process.execPath, [
      path.join(TOOLS_DIR, 'machine_load_sampler.js'), 'run', `--label=${safeLabel}`,
    ], { detached: true, stdio: 'ignore', cwd: REPO_ROOT });
    child.unref();
    console.log(`
${stamp()} OVERLAY → machine-load sampler up (label '${safeLabel}') — ` +
      `read it after the run with: node Auren_Bot/monitoring/trace_monitor.js --machine-load`);
    return true;
  } catch (e) {
    // NOT fatal to the filming and said out loud: the run is still worth having without its load record,
    // but a missing record must never be discovered later as a silent gap (Law 25).
    console.error(`${stamp()} ⚠ the machine-load sampler did not start (${e.message}) — ` +
      `this run will have no machine-load record.`);
    return false;
  }
}

function stopSampler() {
  const r = spawnSync(process.execPath, [path.join(TOOLS_DIR, 'machine_load_sampler.js'), 'stop'],
    { stdio: 'inherit', cwd: REPO_ROOT });
  return r.status === 0;
}

// ── Wrapping the take ────────────────────────────────────────────────────────────────────────────
// The last debt a filmed run owes, and the only one whose deadline is the NEXT run rather than this
// one: every bot's trace is overwritten when the fleet is raised again. The footage survives that and
// the record that explains it does not, and footage nobody can index is footage nobody can cut. So the
// captures are folded into `footage/<takeKey>/` alongside a copy of each trace and a manifest, and
// after this a take is one folder that can be opened, moved or deleted whole.
//
// It belongs in the teardown rather than in an operator's memory because the run is what raised the
// lifecycle and is therefore what closes it (Law 8). As a verb somebody had to remember, the record's
// survival depended on nobody forgetting once, and the failure was silent, total and only discovered
// weeks later when a take turned out to be unreadable.
//
// A CHILD PROCESS, not a require, and that is the Law 26 joint rather than a convenience: the clipper
// refuses and exits non-zero on an unverified anchor, so importing it would put its refusal on this
// process's stack and abort a teardown mid-way. Across a process boundary the refusal is an exit code
// this reads, which is the same shape every other step here already uses.
//
// ORDER: after OBS has finalised the files (their duration is what the anchor is checked against) and
// after the sampler has stopped (its record is otherwise still being written while it is copied).
function wrapTheTake() {
  const r = spawnSync(process.execPath, [path.join(TOOLS_DIR, 'footage_clipper.js'), 'wrap'],
    { stdio: 'inherit', cwd: REPO_ROOT });
  return r.status === 0;
}

// Block this process without spinning a core. `raise` is synchronous top to bottom — every step is a
// spawnSync — so the wait below is a plain blocking pause rather than a promise; Atomics.wait on a
// throwaway buffer is the only sleep that actually yields the thread in synchronous code.
function pauseSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Wait for camera_rig to publish that every client it expects is standing in the world.
//
// TIMING OUT IS A FAILURE, NOT A SHRUG (Law 25): the honest report is that the crew never arrived, so the
// raise fails and the conductor tears the run down instead of filming an empty set. The tempting wrong
// turn is to continue after the ceiling "since the clients are probably up by now" — that turns the gate
// into a delay, which is exactly the state this replaced.
// How many game clients this script's launcher has standing right now. SENSED, and matched by the same
// command-line discriminator every teardown in this system uses — Prism writes the instance path into
// the java command line with FORWARD slashes even on Windows, so no separator may be assumed.
function liveClients() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name LIKE 'java%'\" -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.CommandLine -match 'instances[\\\\/]Cam' }).Count"], { encoding: 'utf8' });
  return parseInt(String(r.stdout || '0').trim(), 10) || 0;
}

// A BRAND-NEW PRISM INSTANCE LOSES ITS FIRST LAUNCH TO ITS OWN DOWNLOAD, and that is measured rather
// than supposed (2026-09-06, the first live let's play bring-up). The instance is created in the same
// pass that launches it, so Prism is still resolving components while the game starts: its log reached
// `Setting user: KaptainKrispyjr` and stopped there, one line before `Backend library: LWJGL`, with no
// crash report and no clean exit — `org.lwjgl3` was being fetched during that very launch. The
// identical command run afterwards worked first time and joined in seven seconds, because by then
// everything was cached. So the raise sat out the full 240s ceiling waiting for a process that had
// been dead for three minutes, and reported a crew that never arrived.
//
// ONE RELAUNCH, ON A SENSED FACT, NOT A TIMER AND NOT A RETRY LOOP. The trigger is that the launcher
// returned and NO client process is alive — a fact about the world, not an inference from slowness
// (Invariant B). It fires at most once and says so; a client that is merely slow keeps its full
// ceiling, because a live process is never relaunched. That is what keeps this from being the
// catch-and-retry Law 13 forbids: there is no uncertainty being papered over, there is a dead process
// being observed, and the second attempt is convergent (`-Add` relaunches only what is missing).
const CLIENT_DEATH_GRACE_MS = 30000;

function waitForCrew(expected, relaunch) {
  const deadline = Date.now() + CREW_READY_TIMEOUT_MS;
  const started = Date.now();
  console.log(`\n${stamp()} OVERLAY → waiting for ${expected} camera client(s) to finish loading and join the world`);
  let announced = 0;
  let relaunched = false;
  for (;;) {
    const r = readJson(CREW_READY_FILE);
    if (r && r.ready) {
      console.log(`${stamp()} OVERLAY   crew standing in the world: ${(r.cams || []).join(', ')} — the fleet may start.`);
      return { ok: true, cams: r.cams || [] };
    }
    if (!relaunched && relaunch && Date.now() - started > CLIENT_DEATH_GRACE_MS && liveClients() === 0) {
      relaunched = true;
      console.log(`${stamp()} OVERLAY   every camera client this raise launched has EXITED — nothing is loading. ` +
        `This is what a brand-new instance's first launch does while Prism is still fetching its ` +
        `components. Relaunching once (converge), then waiting out the rest of the ceiling.`);
      relaunch();
    }
    if (Date.now() >= deadline) {
      // The ceiling says only that the crew never arrived. WHICH failure it was — clients that died,
      // or clients still alive and stuck loading — is a different repair each way, and it is a fact
      // that can be sensed right here rather than left for the reader to go and find (Law 25).
      const alive = liveClients();
      const why = `only some of the ${expected} camera client(s) ever joined the world ` +
        `(${Math.round(CREW_READY_TIMEOUT_MS / 1000)}s ceiling) — camera_rig never published a ready crew · ` +
        (alive === 0
          ? `NO client process is alive${relaunched ? ' even after one relaunch' : ''} — they exited rather than hung; read tools\\camera_launch_logs\\*.err.log`
          : `${alive} client process(es) ARE alive${relaunched ? ' (one relaunch was issued)' : ''} — they are loading or stuck, not dead`);
      console.error(`${stamp()} ✗ ${why}`);
      return { ok: false, why };
    }
    const waited = Math.round((CREW_READY_TIMEOUT_MS - (deadline - Date.now())) / 1000);
    if (waited >= announced + 15) { announced = waited; console.log(`${stamp()} OVERLAY   still loading… ${waited}s`); }
    pauseSync(CREW_READY_POLL_MS);
  }
}

// ── Raise ────────────────────────────────────────────────────────────────────────────────────────
// Every step gated on the last: a camera crew that did not come up must never reach `up`, because an OBS
// that binds nothing records black and reports a clean start (Law 13 — default stopped).
// `host` is the RUN's answer when the caller has one, and undefined when it does not — the conductors
// have no `host` field to read and pass nothing, so the flag-then-config order below still decides for
// them. An explicit boolean from a run profile outranks both, because a run that declares itself a
// let's play has already answered the question and a config default reaching past it would be a second
// answer (Law 16). Resolution order, stated once: the run's field, then a --host flag on this process,
// then camera_configure.
function raise({ overlay, count, test, conductorPid, host: hostOpt }) {
  const decl = OVERLAYS[overlay];
  if (!decl) return { ok: false, why: `'${overlay}' is not a declared overlay` };

  // ── THE CAMERAS ARE HARDWIRED TO THIS BOX, SO THE FLEET HAD BETTER BE TOO ─────────────────────
  // Every camera client is launched `--server 127.0.0.1:25565`; the FLEET goes wherever
  // AUREN_SERVER_HOST points, and `launch()` hands children the whole environment. A shell that was
  // aimed at the public proxy earlier therefore produces a filmed run in which the crew is in one
  // world and every lens is in another — and nothing throws. The windows open, the director's RCON
  // answers (it reads the local server.properties), and the take is N spectators standing alone in an
  // empty world. Refused rather than forced, unlike `fleet_control local`: that verb's own NAME
  // settles which machine it means, and this one does not — filming is orthogonal to which world a run
  // is on, so the overlay has no standing to redirect the fleet (Law 25: escalate, don't reinterpret).
  const aimedAt = process.env.AUREN_SERVER_HOST;
  if (aimedAt && aimedAt !== 'localhost' && aimedAt !== '127.0.0.1') {
    return {
      ok: false,
      why: `this shell is pointed at ${aimedAt} (AUREN_SERVER_HOST) and every camera client joins ` +
        `127.0.0.1 — the fleet and the lenses would be in different worlds, and the take would be ` +
        `empty. Clear it, or film from a shell that was never aimed elsewhere.`,
    };
  }

  // Clear a stop request left behind by an earlier run BEFORE anything is raised. Without this a stale
  // sentinel closes the run that is starting, within one slice, and reports it as an operator stop.
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (e) { /* nothing to release */ }

  // The sampler goes up FIRST, before the cameras, and that ordering is the measurement rather than a
  // preference: launching N game clients is when chunks stream in, and chunk streaming is the load being
  // hunted. A sampler started after the windows exist has already missed the worst minute of the run.
  raiseSampler(test || overlay);

  // Clear the previous run's readiness BEFORE launching, for the same reason the stop sentinel is cleared
  // above: a file left by the last run would answer the wait instantly and the crew would be declared
  // present on the strength of a record about clients that are gone (Invariant B — re-sense, never trust
  // what was remembered).
  try { if (fs.existsSync(CREW_READY_FILE)) fs.unlinkSync(CREW_READY_FILE); } catch (e) { /* nothing to clear */ }

  const eye = architectEye();
  const host = typeof hostOpt === 'boolean' ? hostOpt : hostSeat();

  // ── THE CAMERA SET IS NAMED WHENEVER IT IS KNOWN, AND COUNTED ONLY WHEN IT IS NOT ──────────────
  // `-Count 0` means "the whole roster" to the launcher, which is the right reading of an unstated
  // count and the wrong reading of a run that genuinely has NO bots yet. A contractor run is exactly
  // that: the world comes up empty and the crew is hired in chat later, so the honest instruction is
  // an explicitly empty NAMED set, not a count of zero. The launcher tells the two apart by whether
  // the parameter was passed at all.
  const named = count === 0;
  const camArgs = [
    ...(named ? ['-Bots', ''] : ['-Count', String(count)]),
    '-Framing',
    ...(eye ? ['-Architect'] : []),
    ...(host ? ['-HostSeat'] : []),
  ];
  const crewWords = [
    named ? 'no bot cameras yet (they arrive with the crew)' : `${count} bot camera(s)`,
    ...(eye ? ["the Architect's eye"] : []),
    ...(host ? ['the HOST SEAT'] : []),
  ].join(' + ');
  if (!runScript('start_cameras.ps1', camArgs, `camera crew — ${crewWords} + director + titler`)) {
    return { ok: false, why: 'the camera crew did not come up' };
  }

  // Recorded the moment the crew is up, whether or not OBS follows: the clients and the director are
  // already ours to reap from here, and a session file written only on full success would strand them
  // if OBS failed (Law 8 — what is raised is reaped, and the record is how the closer finds it).
  writeSession({
    overlay, test: test || null, count, obs: decl.obs, architect: eye, host,
    conductor_pid: conductorPid || null,
    raised_at: Date.now(),
    alive_at: conductorPid ? Date.now() : null,
  });

  // THE STEP THAT MAKES "EVERYTHING IS UP" TRUE RATHER THAN LIKELY.
  //
  // Launching a game client and having one standing in the world are separated by tens of seconds of
  // loading, and the launcher owns only the first — it returns when the process starts. Every step after
  // this one is void without the wait: OBS binds by WINDOW, so binding before the windows finish loading
  // captures a loading screen and reports a clean start, and the fleet's opening minute is filmed by
  // cameras that are not there yet. Both failures report success, which is the only kind worth a gate
  // (Law 13 — prove it is safe to continue).
  //
  // The wait is on the RIG'S published fact, not on a probe of our own: the rig arms each client only
  // after the server answered `data get entity` for it, so it already holds this answer and a second
  // implementation of the question here would be the redundant route Law 16 forbids.
  // The bot cameras, plus the Architect's eye only when it was actually launched. Counting a seat that
  // was never raised turns the gate into a guaranteed timeout, which reads as "the crew never arrived"
  // on a crew that is standing complete (Law 25 — the criterion has to be the one that was asked for).
  // The host seat is counted here too. It is not a camera, but it IS a window OBS must bind, and the
  // rig confirms it standing on its `--present` list for exactly this gate — the one window carrying
  // the presenter and his voice must not be the one window nobody proved had finished loading.
  // The one repair the wait is allowed to make, and it is handed in rather than reached for: the same
  // launch that just ran, plus `-Add`, which senses what is already standing and launches only what is
  // missing. Convergent by construction, so a client that came up between the check and this call is
  // left alone rather than doubled.
  const crew = waitForCrew(count + (eye ? 1 : 0) + (host ? 1 : 0),
    () => runScript('start_cameras.ps1', [...camArgs, '-Add'], 'camera crew — relaunching what died on its first start'));
  if (!crew.ok) return { ok: false, why: crew.why };

  if (!decl.obs) {
    console.log(`\n${stamp()} OVERLAY   '${overlay}': cameras only — nothing is being recorded, by definition.`);
    if (!raiseWarden(overlay, count, eye, host)) return { ok: false, why: 'the camera warden did not start' };
    return { ok: true, obs: false };
  }

  // The same set the launcher was given, in the same form — an explicitly empty `--bots=` where the
  // launcher got an explicitly empty `-Bots`, so the two raisers cannot disagree about whether "none"
  // meant none or meant everything.
  const setArgs = count === 0 ? ['--bots='] : [`--count=${count}`];
  const seatArgs = [`--architect=${eye ? 'on' : 'off'}`, `--host=${host ? 'on' : 'off'}`];
  if (!runScript('camera_obs.ps1', ['configure', ...setArgs, ...seatArgs],
      'OBS configure (boot-time config — legal only while OBS is stopped)')) {
    return { ok: false, why: 'OBS could not be configured' };
  }
  // ONE announced retry, on `up` alone: OBS accepts the websocket a moment before it can serve requests,
  // so a cold launch can answer "not ready" and an immediate re-run succeeds. An environmental startup
  // race, not an uncertain outcome — and printed rather than swallowed, because a silent retry would
  // hide a genuinely broken OBS behind a second attempt that also failed for a real reason.
  if (!runScript('camera_obs.ps1', ['up', ...setArgs, ...seatArgs], 'OBS up (bind one capture per window)')) {
    console.log(`\n${stamp()} OVERLAY   OBS 'up' failed on the cold launch (known startup race) — retrying once.`);
    if (!runScript('camera_obs.ps1', ['up', ...setArgs, ...seatArgs], 'OBS up (retry)')) {
      return { ok: false, why: 'OBS would not bind the camera windows' };
    }
  }
  // No count: `start` inherits the roster `up` recorded, which is where the camera set was decided.
  if (!runScript('camera_obs.ps1', ['start'], 'OBS start (one call records every camera)')) {
    return { ok: false, why: 'the recording did not start' };
  }

  // THE WARDEN GOES UP LAST, AFTER THE RECORDING IS PROVEN. It attaches a camera to every bot that
  // appears for the rest of the run, and each attach ends by proving the new file is really writing —
  // a check that can only be made against a live output. Raised before `start`, its first attach would
  // land on an OBS that is not recording yet and would have nothing true to verify.
  if (!raiseWarden(overlay, count, eye, host)) return { ok: false, why: 'the camera warden did not start' };
  return { ok: true, obs: true };
}

// ── The warden ───────────────────────────────────────────────────────────────────────────────────
// Raised here because filming is this file's business and the fleet's is not: the warden watches the
// overseer's registry and gives a camera to any bot that appears, which is the missing half of "one
// camera per bot" on a run whose bots are hired in chat after the take has started. See its own
// header for why it senses the world rather than hooking the launcher.
//
// DETACHED with no pipes, exactly like the machine-load sampler and for the same reason: it outlives
// every spawnSync step around it, and a pipe nobody drains blocks it the moment its output fills the
// buffer. Its account goes to this run's terminal through its own window.
//
// `seeded` is the crew that already has cameras, so the first pass is not a needless full converge.
function raiseWarden(overlay, count, eye, host) {
  const roster = spawnSync(process.execPath, [paths.workshop('fleet_control.js'), 'roster'],
    { encoding: 'utf8', cwd: REPO_ROOT });
  const all = String(roster.stdout || '').trim().split('\n').pop().trim().split(',').filter(Boolean);
  const seeded = count > 0 ? all.slice(0, count) : [];
  try {
    const child = spawn('powershell', ['-NoProfile', '-Command',
      `& '${process.execPath}' '${path.join(TOOLS_DIR, 'camera_warden.js')}' ` +
      `--overlay=${overlay} --host=${host ? 'on' : 'off'} --architect=${eye ? 'on' : 'off'} ` +
      `--seeded=${seeded.join(',')}`,
    ], { detached: true, stdio: 'ignore', cwd: REPO_ROOT });
    child.unref();
    console.log(`\n${stamp()} OVERLAY → camera warden up — every bot that stands up from here on gets a ` +
      `camera${overlay === 'record' ? ' that records' : ''}. Say "foreman get" in game.`);
    return true;
  } catch (e) {
    // FATAL TO THE RAISE, unlike the sampler, and the difference is what each one costs. A missing
    // load record leaves a good take; a missing warden leaves a let's play in which the crew the
    // episode is about is never filmed at all, discovered when the footage is cut (Law 25).
    console.error(`${stamp()} ✗ the camera warden did not start (${e.message}) — contractors would not ` +
      `be filmed, which is the whole point of this run.`);
    return false;
  }
}

// ── Reap ─────────────────────────────────────────────────────────────────────────────────────────
// The mirror of raise, and it does NOT take the fleet down: the fleet was raised by the conductor and is
// the conductor's to reap (Law 8 — each owner reaps what it raised, and only that). Ordering: the
// recording is finalised before anything it is recording can disappear.
//
// Every step runs even if an earlier one failed. A stop that abandoned the remaining steps on the first
// error would leave exactly the zombies this exists to prevent, and the failure is reported instead.
function reap(why) {
  const session = readSession();

  console.log(`\n${'─'.repeat(96)}\n${stamp()} OVERLAY TEARDOWN — ${why}\n${'─'.repeat(96)}`);
  const failed = [];

  // THE WARDEN GOES FIRST, BEFORE ANYTHING IT COULD REACT TO MOVES. It is a loop that raises camera
  // clients and restarts the director whenever the registry changes, and a teardown is exactly when the
  // registry changes fastest — every bot leaving at once. Left running it would answer the fleet coming
  // down by launching Minecraft instances at it. Reaped by COMMAND LINE rather than by the pid it wrote:
  // a process killed hard leaves that file behind, and a stale pid reaped by number can only ever be
  // wrong (Law 23 — sense what is running, never trust a record of it). Unconditional, like the crew
  // teardown below, because a raise that failed halfway still raised one.
  if (!stopWarden()) failed.push('camera warden stop');
  // NO SESSION still reaps the clients. A missing session means the raise did not get far enough to
  // record one — which is precisely the case where a partial crew may be standing, so returning early
  // here would strand exactly what a failed raise produces. `-Down` reports finding nothing when there
  // is nothing, so the cost of asking is a line of output (Law 8: reap what was raised, and a raise that
  // failed halfway still raised something).
  // The OBS half is skipped without a session, because OBS is only ever raised AFTER the session is
  // recorded — asking a machine that was never started to stop is a step that can only report noise.
  if (session && session.obs) {
    if (!runScript('camera_obs.ps1', ['stop'], 'OBS stop (finalise every per-camera file)')) failed.push('OBS stop');
    if (!runScript('camera_obs.ps1', ['down'], 'OBS down (quit OBS)')) failed.push('OBS down');
  }
  // Unconditional, like the crew teardown below and for the same reason: the sampler is raised before the
  // session is recorded, so a raise that failed early leaves one running with nothing on record naming it.
  if (!stopSampler()) failed.push('machine-load sampler stop');
  if (!runScript('start_cameras.ps1', ['-Down'],
      `camera crew down (clients + director)${session ? '' : ' — no session on record, so this is a partial raise being cleaned up'}`)) {
    failed.push('camera crew down');
  }

  // Only a run that RECORDED has anything to pair — a `watch` overlay wrote no footage, so there is no
  // capture for a record to sit beside and the step would be asking a question about files that do not
  // exist. Same gate the OBS half above uses, for the same reason.
  if (session && session.obs) {
    console.log(`\n${stamp()} OVERLAY → wrap this take (its traces die with the next fleet run)`);
    if (!wrapTheTake()) failed.push('wrap the take');
  }

  // Deleted, never rewritten: the session and the request both die with the run they describe, so a
  // later `stop` cannot find a session that no longer exists and reap a stack it never raised.
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (e) { /* already gone */ }
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (e) { /* already gone */ }
  // The crew's readiness describes clients that no longer exist once they are reaped, so it dies here with
  // the run that produced it rather than surviving to answer the next run's wait.
  try { if (fs.existsSync(CREW_READY_FILE)) fs.unlinkSync(CREW_READY_FILE); } catch (e) { /* already gone */ }

  if (failed.length) {
    console.error(`\n${stamp()} ⚠ the overlay teardown did not report clean: ${failed.join(', ')}. ` +
      `Check for stray camera windows and an OBS still running before the next filmed run.`);
  }
  return { ok: failed.length === 0, reaped: true, failed };
}

// Matched the way start_cameras.ps1 matches its own director: by what is on the command line, which is
// the one discriminator that survives a process being killed, restarted or losing its record. Reports
// what it actually found, never a bare success — a stop that matched nothing must not read the same as
// one that stopped a running warden (Law 25).
function stopWarden() {
  const ps =
    "$n=0; foreach ($p in @(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%camera_warden.js%'\" " +
    '-ErrorAction SilentlyContinue)) { if ($p.ProcessId -eq $PID) { continue } ' +
    'Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++ } ; ' +
    'if ($n -eq 0) { "no warden was running" } else { "$n warden process(es) stopped" }';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const said = String(r.stdout || '').trim();
  console.log(`${stamp()} OVERLAY   camera warden → ${said || 'could not be asked about'}`);
  // The pid file is the warden's own and it deletes it on a clean exit; a hard kill leaves it, and a
  // stale one would have a later reader believe a warden is up. Cleared here because this is what
  // ended it (Law 8 — the ender closes the lifecycle).
  try {
    const pidFile = path.join(KERNEL, 'camera_warden.json');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch (e) { /* already gone */ }
  return r.status === 0;
}

// ── The `stop` command ───────────────────────────────────────────────────────────────────────────
//
// THREE EXIT CODES, and the third exists so `fleet_control down` can fold this command into itself
// without ever putting two reapers on one stack (Architect 2026-09-07: *"instead of 2 commands one to
// stop the recording and another to bring it down. its all under down"*).
//
//   0   done, or there was nothing to do — either is a closed run from the caller's point of view
//   1   a teardown was attempted and did not report clean
//   10  STOP REQUESTED ONLY. A live conductor holds this run and will close it, including the fleet.
//
// 10 is the one a wrapper must branch on. `down` calls this first, and on 10 it stops dead: the
// conductor is about to take the same fleet down from its own terminal, and racing it would kill the
// bots out from under a teardown that is mid-flight — which is precisely the half-wrapped take this
// whole file exists to prevent. There is no programmatic caller other than `down`; the code is a
// contract between exactly two files and is named at both ends.
const REQUESTED_NOT_REAPED = 10;

function stopCommand(force, why) {
  const session = readSession();

  if (!session && !force) {
    console.log(`\nrecord_overlay: no filmed run is on record — nothing was raised by an overlay, so ` +
      `nothing is reaped here.`);
    console.log(`  A run raised before this session file existed, or a crew started by hand, is closed with:`);
    console.log(`    node Auren_Workshop/tools/record_overlay.js stop --force`);
    return 0;
  }

  if (conductorIsLive(session)) {
    // REQUEST, never reap: the conductor is holding this run and is its one reaper. Writing the sentinel
    // is the whole of this branch's work, and the report says exactly that (Law 25 — a request that
    // reported itself as a teardown would be a success flag nobody earned).
    try {
      fs.writeFileSync(STOP_FILE, JSON.stringify({ at: Date.now(), why: why || 'the operator asked for it' }, null, 2));
    } catch (e) {
      console.error(`\nrecord_overlay: could not write the stop request (${e.message}). The conductor is ` +
        `alive and holding the run, so forcing a teardown here would put two reapers on one stack. ` +
        `Interrupt the conductor's own terminal instead.`);
      return 1;
    }
    const quiet = Math.round((Date.now() - session.alive_at) / 1000);
    console.log(`\nrecord_overlay: STOP REQUESTED — the '${session.test || 'conducted'}' run's conductor ` +
      `(pid ${session.conductor_pid}, last heard ${quiet}s ago) holds this run and is its one reaper.`);
    console.log(`  It reads this between soak slices, so it closes within about ${SLICE_SECONDS}s: it will stop ` +
      `the recording, quit OBS, close the cameras, capture and triage the run, and take the fleet down.`);
    console.log(`  NOTHING HAS BEEN TORN DOWN YET — this is a request, and the run's own terminal reports the close.`);
    return REQUESTED_NOT_REAPED;
  }

  if (session) {
    console.log(`\nrecord_overlay: a filmed session is on record (${session.overlay}, ${session.count} camera(s))` +
      `${session.conductor_pid
        ? ` but its conductor (pid ${session.conductor_pid}) has not been heard from in ` +
          `${session.alive_at ? Math.round((Date.now() - session.alive_at) / 1000) + 's' : 'this run'} — ` +
          `treating it as gone and reaping here`
        : ` with no conductor behind it — reaping here`}.`);
  } else {
    console.log(`\nrecord_overlay: --force with no session on record — reaping the film crew blind. ` +
      `This stops any OBS and any camera client it finds and reports what it actually found.`);
    // With no session there is nothing to read, so both halves are attempted and each reports for itself.
    // OBS is asked to stop first for the same ordering reason the recorded path uses — and the warden
    // before either, so nothing is launching cameras into a teardown.
    stopWarden();
    runScript('camera_obs.ps1', ['stop'], 'OBS stop (blind — may be nothing to stop)');
    runScript('camera_obs.ps1', ['down'], 'OBS down (blind)');
    const ok = runScript('start_cameras.ps1', ['-Down'], 'camera crew down (blind)');
    try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (e) { /* already gone */ }
    console.log(`\nrecord_overlay: blind teardown ${ok ? 'completed' : 'did NOT report clean — read above'}.`);
    console.log(`  The FLEET is untouched: it was not raised by an overlay. Take it down with:`);
    console.log(`    node Auren_Workshop/fleet_control.js down`);
    return ok ? 0 : 1;
  }

  const r = reap(why || 'the operator asked for it, and no conductor was holding the run');
  console.log(`\n  The FLEET is untouched — the overlay never raised it, so it is not the overlay's to reap.`);
  console.log(`  Take it down with:  node Auren_Workshop/fleet_control.js down`);
  return r.ok ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function usage() {
  console.log(`\nrecord_overlay — the filming overlay: raised by a run that asks for it, one command to close it.\n`);
  console.log(`  THE OVERLAYS:`);
  for (const [k, v] of Object.entries(OVERLAYS)) console.log(`    ${k.padEnd(8)} ${v.blurb}`);
  console.log(`\n  START one (the overlay is never invoked directly — a run asks for it):`);
  console.log(`  A RUN RAISES THIS OVERLAY BY BEING CONFIGURED TO. Set it on the one page and run it:`);
  console.log(`    Auren_Workshop/run_config.js   record: 'film'      cameras and OBS writing files`);
  console.log(`    Auren_Workshop/run_config.js   record: 'cameras'   cameras only, nothing written`);
  console.log(`    then:  node Auren_Workshop/run.js`);
  console.log(`       …which run is filmed is a FIELD now, not a word typed after the name. Set film on any`);
  console.log(`       run in Auren_Bot/Thinking_fragments/architect_fleetrunbook_config.js.`);
  console.log(`    node Auren_Workshop/tools/lanista_conductor.js ladder record    (the combat bench still takes the word)`);
  console.log(`\n  CLOSE one, whichever conductor raised it:`);
  console.log(`    node Auren_Workshop/tools/record_overlay.js stop`);
  console.log(`    node Auren_Workshop/tools/record_overlay.js stop --force    (no session on record — reap blind)`);
  console.log(`\n  STATUS:`);
  console.log(`    node Auren_Workshop/tools/record_overlay.js status\n`);
}

function statusCommand() {
  const session = readSession();
  if (!session) { console.log(`\nrecord_overlay: nothing filming — no session on record.\n`); return 0; }
  const live = conductorIsLive(session);
  console.log(`\nrecord_overlay: a '${session.overlay}' overlay is up.`);
  console.log(`  run       : ${session.test || 'unnamed'}`);
  console.log(`  cameras   : ${session.count === 0 ? 'on order — a camera per contractor as it stands up' : `${session.count} bot camera(s)`}` +
    `${session.architect ? " + the Architect's eye" : ''}${session.host ? ' + the HOST SEAT (yours to play, mic on its file)' : ''}`);
  // SENSED, never read off the declaration — the same discipline the warden line below already uses,
  // and it is here because the declaration was WRONG in exactly the case a reader most needs this line.
  // The session is written the moment the camera crew comes up, which is BEFORE the crew-ready gate and
  // therefore before OBS is launched at all: a raise that failed at that gate left `obs: true` on disk,
  // and this line reported "YES — OBS is writing one file per camera" over a run that recorded nothing
  // and had said so in its own terminal minutes earlier (Law 25 — a success flag nobody earned).
  // What is sensed is that an OBS process EXISTS, which is not the same as bytes reaching a file — so
  // the line says which of the two it knows, and the assay for the other is printed at the end.
  if (session.obs) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name = 'obs64.exe'\" -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: 'utf8' });
    const obsUp = (parseInt(String(r.stdout || '0').trim(), 10) || 0) > 0;
    console.log(`  recording : ${obsUp
      ? 'OBS IS RUNNING — this run asked it for one file per camera (bytes on disk are the assay below)'
      : 'NOTHING IS BEING RECORDED — this run asked for OBS and NO OBS PROCESS EXISTS. The raise never ' +
        'reached it; read the run\'s own terminal for where it stopped.'}`);
  } else {
    console.log('  recording : no (watch overlay)');
  }
  // Read from the process table, not from the session: the session says a warden was RAISED, and the
  // question a reader has during a take is whether one is still running (Law 23).
  {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%camera_warden.js%'\" -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: 'utf8' });
    const n = parseInt(String(r.stdout || '0').trim(), 10) || 0;
    console.log(`  warden    : ${n > 0 ? 'UP — new bots get a camera as they stand up' : 'NOT RUNNING — a contractor hired now would not be filmed'}`);
  }
  console.log(`  raised    : ${Math.round((Date.now() - session.raised_at) / 60000)} min ago`);
  // States the EVIDENCE, not a verdict about the process: what is known here is when the heartbeat was
  // last written, and a fresh one is not proof a process is healthy — only that it was, that recently
  // (Law 23 — report what was sensed). The consequence is what the reader actually needs anyway.
  console.log(`  conductor : ${session.conductor_pid
    ? `pid ${session.conductor_pid}, last heard ${session.alive_at ? Math.round((Date.now() - session.alive_at) / 1000) + 's ago' : 'never'} — ` +
      `${live ? '`stop` will REQUEST and let it close itself' : 'past the stale mark, so `stop` will reap here'}`
    : 'none behind this session — `stop` will reap here'}`);
  const req = stopRequested();
  if (req) console.log(`  stop      : REQUESTED ${Math.round((Date.now() - req.at) / 1000)}s ago (${req.why})`);
  // What OBS is really doing is OBS's to state, and it has its own reader. Pointing at it beats
  // restating a claim this file cannot verify (Law 23).
  if (session.obs) console.log(`\n  Is it really writing bytes?  .\\Auren_Workshop\\scripts\\camera_obs.ps1 status\n`);
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.find(a => !a.startsWith('--'));
  const why = (argv.find(a => a.startsWith('--why=')) || '').split('=').slice(1).join('=') || null;
  let code = 1;
  if (cmd === 'stop') code = stopCommand(argv.includes('--force'), why);
  else if (cmd === 'status') code = statusCommand();
  else { usage(); code = cmd ? 1 : 0; }
  process.exit(code);
}

module.exports = {
  OVERLAYS, OVERLAY_FLAGS, SLICE_SECONDS, architectEye,
  raise, reap, heartbeat, stopRequested, readSession, conductorIsLive,
  SESSION_FILE, STOP_FILE,
  // Exported 2026-09-10. The header above says this code "is named at both ends" and it was not: the
  // other end, `fleet_control.stopAnyRecording()`, referenced a bare `RECORD_OVERLAY_REQUESTED_NOT_REAPED`
  // that was never declared anywhere, so `down` threw a ReferenceError instead of branching. A number
  // written twice would have run and been wrong later; this way there is still one source for it.
  REQUESTED_NOT_REAPED,
};
