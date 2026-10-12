// Auren_Workshop/tools/record_overlay.js
// THE FILMING OVERLAY — attaches optional cameras and recording to any conducted run, closed with one
// command, attached to a rung: the rung decides what happens in the world, the overlay decides only
// whether there are lenses on it (Law 16).
//
//   run_config.js  run.record: 'film'                a run with cameras + a recorder writing files
//   run_config.js  run.record: 'cameras'              cameras only, nothing written — what a download has
//   node tools/lanista_conductor.js ladder record     the combat bench, same overlay
//   node tools/record_overlay.js    stop              THE closer, whichever caller raised it
//
// ORDER (every step an existing owner): start_cameras.ps1 -Framing raises the cameras + director +
// titler; waits on camera_rig_ready.json for every client confirmed standing; recorder.raise ('record'
// only) binds a capture per window and starts writing. Reaped in the mirrored order. Sits AFTER the
// bring-up, BEFORE the work starts — conductors bring their fleet up IDLE when armed and send the
// opening verb themselves, so the tape includes every run's opening.
//
// The recorder is not in this copy's code: `record` reaches it through ONE hook,
// `workstation.findRecorder()`, answering only on a machine whose workstation file names one. Elsewhere
// `record` refuses and points at `cameras` — the same crew with nothing written, each window titled
// Cam_<Bot> so any screen recorder can bind it.
//
// THE OPERATOR'S EYE, off unless asked for: a spectator client, launched like a bot camera, that the
// director arms and never commands — a human flies it. Defaults off (Law 13; camera_configure holds the
// governing setting). `--architect` turns it on for that run (Law 26). Parsed here once (OVERLAY_FLAGS),
// not by each conductor, so the launcher and the recorder see the same value (Law 16); the host seat the same.
//
// THE CLOSER is one command, two behaviours (Invariant D — one lifecycle owner). `stop` never reaps a
// run with a live conductor: it REQUESTS, by writing a sentinel the conductor reads between soak
// slices, and reaps directly only when no live conductor stands behind the session (Law 25).
//
// THE FILES, each with one owner (Law 6, Law 9):
//   js_kernel/record_overlay_session.json   written by raise, refreshed by the conductor's heartbeat,
//                                           deleted by reap.
//   js_kernel/record_overlay_stop.json      written by `stop`, deleted by reap. A request, not a state.
//   js_kernel/machine_load_sampler.json     written and deleted by the sampler itself.
//   js_kernel/camera_rig_ready.json         WRITTEN BY camera_rig, never here; cleared before a raise
//                                           and deleted at reap, read only in between.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/record_overlay.js');

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

// Two roots: the WORKSHOP holds fleet_control, the scripts, the lenses, the camera and the playground;
// the shipped BOT holds js_kernel, foreman and Thinking_fragments. Each is asked of workshop_paths by
// name (Law 7).
const paths     = require('../workshop_paths');
const TOOLS_DIR = __dirname;
const REPO_ROOT = paths.REPO_ROOT;
const SCRIPTS   = paths.workshop('scripts');
const KERNEL    = paths.bot('js_kernel');

const workstation = require(paths.bot('js_kernel', 'utils', 'workstation.js'));

// recorder() → the recorder module, or null on a machine that has none. Asked when a recording step is
// reached, so `cameras`, `stop` and `status` never touch it on a copy without one.
function recorder() {
  const file = workstation.findRecorder();
  return file ? require(file) : null;
}

const SESSION_FILE = path.join(KERNEL, 'record_overlay_session.json');
const STOP_FILE    = path.join(KERNEL, 'record_overlay_stop.json');
// Written by camera_rig, never by this unit (Law 9).
const CREW_READY_FILE = path.join(KERNEL, 'camera_rig_ready.json');

// Ceiling before the crew's absence is called a raise failure. The normal path returns the moment the
// rig publishes, so this only ever fires when something is genuinely wrong.
const CREW_READY_TIMEOUT_MS = 240000;
const CREW_READY_POLL_MS = 2000;

// How often a conductor holding a filmed run checks in; bounds how soon after `stop` the run closes.
const SLICE_SECONDS = 60;
// A conductor is presumed gone after three missed heartbeats.
const STALE_MS = SLICE_SECONDS * 3 * 1000 + 20000;

// ── The declared overlays ────────────────────────────────────────────────────────────────────────
// DATA: what a record run adds over a watch run, held in one field.
const OVERLAYS = {
  record: {
    records: true,
    blurb: 'cameras for every bot, and a recorder writing every one of them to its own file (needs a recorder on this machine).',
  },
  watch: {
    records: false,
    blurb: 'cameras for every bot, and NO recording — lenses to watch through, nothing written.',
  },
};

// Flags the overlay owns, for a conductor to union into its own accepted set (Law 25).
const OVERLAY_FLAGS = ['architect', 'host'];

// The operator's eye — a spectator seat, off unless asked for.
function architectEye() { return seatSwitch('architect', c => c.architect); }

// THE HOST SEAT — the client a human PLAYS, the only file in a take that carries a microphone.
function hostSeat() { return seatSwitch('host', c => c.host); }

// One reader for both seats: a flag wins, `=off` forces it off, absent defers to camera_configure (Law 16).
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
    // Not fatal: the crew is up either way, but `stop` has nothing to read without this file (Law 25).
    console.error(`${stamp()} ⚠ could not record the overlay session (${e.message}) — ` +
      `\`record_overlay.js stop\` will not find this run. Close it with --force.`);
    return false;
  }
}

// Marks the conductor as still live. While this timestamp is current, `stop` only requests a close
// through the session file; once it goes stale, `stop` reaps directly.
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
// A request, read by the conductor between soak slices; carries its reason for the run's own summary.
function stopRequested() {
  const s = readJson(STOP_FILE);
  return s ? { at: s.at, why: s.why || 'the operator asked for it' } : null;
}

// ── The machine-load sampler ─────────────────────────────────────────────────────────────────────
// A filmed run is the heaviest load this box carries; raised and reaped here, the one place that
// knows a filmed run is happening. Observes the machine only (Law 22 scope). DETACHED with no pipes:
// it outlives the spawnSync steps around it, and an undrained pipe would block it once its output
// filled the buffer.
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
    // Not fatal: the run is still worth having without its load record, and the gap is reported (Law 25).
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

// Blocking sleep for synchronous code — `raise` runs top to bottom as spawnSync steps, so there is no
// promise to await; Atomics.wait on a throwaway buffer yields the thread instead.
function pauseSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Waits for camera_rig to publish that every expected client is standing in the world; timing out is
// a failure (Law 25), not a shrug.
// Count of live camera-client processes, matched by command line — Prism writes the instance path
// with forward slashes even on Windows.
function liveClients() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name LIKE 'java%'\" -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.CommandLine -match 'instances[\\\\/]Cam' }).Count"], { encoding: 'utf8' });
  return parseInt(String(r.stdout || '0').trim(), 10) || 0;
}

// Grace period before a client with no live process is read as dead — long enough that a brand-new Prism
// instance losing its first launch to its own component download is not mistaken for merely slow.
// Triggers one relaunch, on the sensed fact (Invariant B); a live-but-slow client keeps its full ceiling.
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
      // Distinguishes which failure it was — died vs. stuck loading — since each has a different
      // repair (Law 25).
      const alive = liveClients();
      const why = `only some of the ${expected} camera client(s) ever joined the world ` +
        `(${Math.round(CREW_READY_TIMEOUT_MS / 1000)}s ceiling) — camera_rig never published a ready crew · ` +
        (alive === 0
          ? `NO client process is alive${relaunched ? ' even after one relaunch' : ''} — they exited rather than hung; read Auren_Workshop\\camera\\clients\\camera_launch_logs\\*.err.log`
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
// Every step gated on the last (Law 13). `host` resolution order: the run's own field, then a --host
// flag on this process, then camera_configure (Law 16 — one declaration).
function raise({ overlay, count, fill, test, conductorPid, host: hostOpt }) {
  // `fill` is whether a bot that stands up later is given a camera. A crew hired in chat needs it, since
  // how many bots there will be is not knowable at raise time; a run that asks for a fixed number of bot
  // seats has already stated the whole answer, so filling would overrule the run's own sentence. Absent
  // means on, which is the crew-in-chat reading every existing caller relies on.
  const fillLater = fill === undefined ? true : !!fill;
  const decl = OVERLAYS[overlay];
  if (!decl) return { ok: false, why: `'${overlay}' is not a declared overlay` };

  // A run that writes files needs a recorder, checked before any window opens (Law 13 — default stopped).
  const rec = decl.records ? recorder() : null;
  if (decl.records && !rec) {
    return {
      ok: false,
      why: `'${overlay}' writes every camera to a file, and this copy has no recorder — the camera crew ` +
        `ships for watching. Set record: 'cameras' in foreman_config.js to watch the same run through the same ` +
        `windows; each is titled Cam_<Bot>, so your own screen recorder can capture any of them.`,
    };
  }

  // Every camera client joins 127.0.0.1; refused when the fleet is aimed elsewhere — filming has no
  // standing to pick the fleet's target (Law 25).
  const aimedAt = process.env.AUREN_SERVER_HOST;
  if (aimedAt && aimedAt !== 'localhost' && aimedAt !== '127.0.0.1') {
    return {
      ok: false,
      why: `this shell is pointed at ${aimedAt} (AUREN_SERVER_HOST) and every camera client joins ` +
        `127.0.0.1 — the fleet and the lenses would be in different worlds, and the take would be ` +
        `empty. Clear it, or film from a shell that was never aimed elsewhere.`,
    };
  }

  // Clears a stale stop request before anything is raised, so it cannot close the run that is starting.
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (e) { /* nothing to release */ }

  // The sampler goes up first, before the cameras, so it is running before chunk-streaming load peaks.
  raiseSampler(test || overlay);

  // Clears the previous run's readiness, so the wait cannot be answered by a stale record (Invariant B).
  try { if (fs.existsSync(CREW_READY_FILE)) fs.unlinkSync(CREW_READY_FILE); } catch (e) { /* nothing to clear */ }

  const eye = architectEye();
  const host = typeof hostOpt === 'boolean' ? hostOpt : hostSeat();

  // `-Count 0` means "the whole roster" to the launcher, the wrong reading for a run that starts with
  // no bots; `named` distinguishes an explicitly empty set from an unstated count.
  const named = count === 0;
  const camArgs = [
    ...(named ? ['-Bots', ''] : ['-Count', String(count)]),
    '-Framing',
    ...(eye ? ['-Architect'] : []),
    ...(host ? ['-HostSeat'] : []),
  ];
  const crewWords = [
    named ? (fillLater ? 'no bot cameras yet (they arrive with the crew)' : 'no bot cameras') : `${count} bot camera(s)`,
    ...(eye ? ["the Architect's eye"] : []),
    ...(host ? ['the HOST SEAT'] : []),
  ].join(' + ');
  if (!runScript('start_cameras.ps1', camArgs, `camera crew — ${crewWords} + director + titler`)) {
    return { ok: false, why: 'the camera crew did not come up' };
  }

  // Recorded the moment the crew is up: the clients are already ours to reap, and a session written
  // only on full success would strand them if the recorder failed (Law 8).
  writeSession({
    overlay, test: test || null, count, records: decl.records, architect: eye, host,
    conductor_pid: conductorPid || null,
    raised_at: Date.now(),
    alive_at: conductorPid ? Date.now() : null,
  });

  // Gates on the RIG'S published fact (Law 16), counting only the seats actually launched (Law 25).
  // The repair, if it stalls, is the same launch plus `-Add`.
  const crew = waitForCrew(count + (eye ? 1 : 0) + (host ? 1 : 0),
    () => runScript('start_cameras.ps1', [...camArgs, '-Add'], 'camera crew — relaunching what died on its first start'));
  if (!crew.ok) return { ok: false, why: crew.why };

  if (!decl.records) {
    console.log(`\n${stamp()} OVERLAY   '${overlay}': cameras only — nothing is being recorded, by definition.`);
    if (!raiseWarden(overlay, count, eye, host, fillLater)) return { ok: false, why: 'the camera warden did not start' };
    return { ok: true, records: false };
  }

  // Mirrors the launcher's own set exactly, so the two raisers cannot disagree about what "none" meant.
  const setArgs = count === 0 ? ['--bots='] : [`--count=${count}`];
  const seatArgs = [`--architect=${eye ? 'on' : 'off'}`, `--host=${host ? 'on' : 'off'}`];
  const started = rec.raise({ setArgs, seatArgs });
  if (!started.ok) return { ok: false, why: started.why };

  // The warden goes up last, after the recording is proven: each attach proves the new file is really
  // writing, which needs a live output to check against.
  if (!raiseWarden(overlay, count, eye, host, fillLater)) return { ok: false, why: 'the camera warden did not start' };
  return { ok: true, records: true };
}

// ── The warden ───────────────────────────────────────────────────────────────────────────────────
// Watches the foreman's registry and gives a camera to any bot that appears after the take has started
// — the missing half of "one camera per bot" on a crew hired in chat. DETACHED with no pipes, like the
// machine-load sampler, so an undrained pipe cannot block it. `seeded` is the crew that already has
// cameras, so the first pass is not a needless full converge.
function raiseWarden(overlay, count, eye, host, fillLater) {
  // A run that asked for no bot cameras gets no warden: the whole warden is "give the next bot a camera",
  // and there is nothing for it to do that the run did not already refuse. Said as a success, because the
  // absence is the run's own answer rather than a step that failed to happen.
  if (!fillLater) {
    console.log(`\n${stamp()} OVERLAY   no camera warden — this run asked for no bot cameras, so a bot ` +
      `standing up is not given one.`);
    return true;
  }
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
    // Fatal to the raise, unlike the sampler: a missing warden means the crew the episode is about is
    // never filmed at all (Law 25).
    console.error(`${stamp()} ✗ the camera warden did not start (${e.message}) — contractors would not ` +
      `be filmed, which is the whole point of this run.`);
    return false;
  }
}

// ── Reap ─────────────────────────────────────────────────────────────────────────────────────────
// The mirror of raise. Does not take the fleet down — the fleet is the conductor's to reap (Law 8).
// Recording is finalised before anything it is recording can disappear. Every step runs even if an
// earlier one failed, so a failure never leaves the zombies an early return would.
function reap(why) {
  const session = readSession();

  console.log(`\n${'─'.repeat(96)}\n${stamp()} OVERLAY TEARDOWN — ${why}\n${'─'.repeat(96)}`);
  const failed = [];

  // The warden goes first, before the registry it watches moves fastest. Reaped by command line rather
  // than its pid file: a hard kill leaves the file behind and a stale pid can only be wrong (Law 23).
  if (!stopWarden()) failed.push('camera warden stop');
  // A missing session still gets its clients reaped, since a failed raise may have stranded a partial
  // crew before it wrote one (Law 8). Runs before any window disappears, so every file is finalised
  // while its source still exists.
  const rec = session && session.records ? recorder() : null;
  if (session && session.records) {
    if (rec) failed.push(...rec.finalise(false));
    else failed.push('finalise the recording (this session recorded, and no recorder is on this machine now)');
  }
  // Unconditional: the sampler is raised before the session is written, so a failed early raise can
  // leave one running with nothing on record naming it.
  if (!stopSampler()) failed.push('machine-load sampler stop');
  if (!runScript('start_cameras.ps1', ['-Down'],
      `camera crew down (clients + director)${session ? '' : ' — no session on record, so this is a partial raise being cleaned up'}`)) {
    failed.push('camera crew down');
  }

  // Pairs footage to trace before the next run overwrites every bot's trace (Law 8), after the files
  // are finalised and the sampler stopped.
  if (rec && !rec.wrapTake()) failed.push('wrap the take');

  // Deleted, never rewritten, so a later `stop` cannot find a session describing a run already gone.
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (e) { /* already gone */ }
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (e) { /* already gone */ }
  try { if (fs.existsSync(CREW_READY_FILE)) fs.unlinkSync(CREW_READY_FILE); } catch (e) { /* already gone */ }

  if (failed.length) {
    console.error(`\n${stamp()} ⚠ the overlay teardown did not report clean: ${failed.join(', ')}. ` +
      `Check for stray camera windows${session && session.records ? ' and a recorder still running' : ''} before the next run.`);
  }
  return { ok: failed.length === 0, reaped: true, failed };
}

// Matched by command line, the one discriminator that survives a kill or a lost record. Reports what it
// actually found, so a no-op cannot read the same as a real stop (Law 25).
function stopWarden() {
  const ps =
    "$n=0; foreach ($p in @(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%camera_warden.js%'\" " +
    '-ErrorAction SilentlyContinue)) { if ($p.ProcessId -eq $PID) { continue } ' +
    'Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++ } ; ' +
    'if ($n -eq 0) { "no warden was running" } else { "$n warden process(es) stopped" }';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const said = String(r.stdout || '').trim();
  console.log(`${stamp()} OVERLAY   camera warden → ${said || 'could not be asked about'}`);
  // A hard kill leaves the pid file behind; cleared here since this is what ended the warden (Law 8).
  try {
    const pidFile = path.join(KERNEL, 'camera_warden.json');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch (e) { /* already gone */ }
  return r.status === 0;
}

// ── The `stop` command ───────────────────────────────────────────────────────────────────────────
// Three exit codes, so `fleet_control down` folds this command in without ever putting two reapers on
// one stack: 0 done or nothing to do, 1 a teardown was attempted and did not report clean, 10 STOP
// REQUESTED ONLY — a live conductor holds this run and will close it, including the fleet. `down` calls
// this first and stops dead on 10, since the conductor is about to take the fleet down itself.
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
    // Requests, never reaps: the conductor holds this run and is its one reaper (Law 25).
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
    console.log(`  It reads this between soak slices, so it closes within about ${SLICE_SECONDS}s: it will ` +
      `${session.records ? 'finalise the recording, ' : ''}close the cameras, capture and triage the run, and take the fleet down.`);
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
    const rec = recorder();
    console.log(`\nrecord_overlay: --force with no session on record — reaping the film crew blind. ` +
      `This stops ${rec ? 'any recording and ' : ''}any camera client it finds and reports what it actually found.`);
    // With no session to read, every half this machine has is attempted, warden first so nothing
    // launches cameras into the teardown, and each reports for itself.
    stopWarden();
    if (rec) rec.finalise(true);
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
  console.log(`\n  START one — a run raises it by being configured to (the foreman does, 2026-09-18):`);
  console.log(`    Auren_Bot/foreman_config.js    record: 'cameras'   cameras only, nothing written`);
  console.log(`    Auren_Bot/foreman_config.js    record: 'film'      cameras and a recorder writing files (a machine with a recorder)`);
  console.log(`    then:  node start_auren.js     (the foreman runs: record_overlay.js raise --overlay=watch|record --count=N)`);
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
  // Sensed, not read off the declaration: the session is written before the recorder is raised, so a
  // raise that failed at the crew-ready gate would leave the flag claiming a recording that never
  // started (Law 25). What is sensed is that the process exists, not that bytes reach a file.
  const rec = session.records ? recorder() : null;
  if (session.records) {
    const up = rec && rec.isRunning();
    console.log(`  recording : ${up
      ? 'THE RECORDER IS RUNNING — this run asked it for one file per camera (bytes on disk are the assay below)'
      : 'NOTHING IS BEING RECORDED — this run asked for a recording and NO RECORDER PROCESS EXISTS. The raise ' +
        'never reached it; read the run\'s own terminal for where it stopped.'}`);
  } else {
    console.log('  recording : no (watch overlay)');
  }
  // Read from the process table, not the session, since the question is whether one is still up (Law 23).
  {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%camera_warden.js%'\" -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: 'utf8' });
    const n = parseInt(String(r.stdout || '0').trim(), 10) || 0;
    console.log(`  warden    : ${n > 0 ? 'UP — new bots get a camera as they stand up' : 'NOT RUNNING — a contractor hired now would not be filmed'}`);
  }
  console.log(`  raised    : ${Math.round((Date.now() - session.raised_at) / 60000)} min ago`);
  // States the evidence: a fresh heartbeat proves the process was healthy that recently (Law 23).
  console.log(`  conductor : ${session.conductor_pid
    ? `pid ${session.conductor_pid}, last heard ${session.alive_at ? Math.round((Date.now() - session.alive_at) / 1000) + 's ago' : 'never'} — ` +
      `${live ? '`stop` will REQUEST and let it close itself' : 'past the stale mark, so `stop` will reap here'}`
    : 'none behind this session — `stop` will reap here'}`);
  const req = stopRequested();
  if (req) console.log(`  stop      : REQUESTED ${Math.round((Date.now() - req.at) / 1000)}s ago (${req.why})`);
  // The recorder's own state is the recorder's to report (Law 23).
  if (rec) console.log(`\n  Is it really writing bytes?  ${rec.STATUS_COMMAND}\n`);
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv.find(a => !a.startsWith('--'));
  const why = (argv.find(a => a.startsWith('--why=')) || '').split('=').slice(1).join('=') || null;
  let code = 1;
  // `raise` is the foreman's door in — run as a process since bot code may not require this file.
  const val = (name) => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
  if (cmd === 'raise') {
    const r = raise({
      overlay: val('overlay'),
      count: parseInt(val('count') || '2', 10),
      fill: val('fill') !== 'off',
      test: 'foreman',
    });
    if (!r.ok) console.error(`record_overlay: not raised — ${r.why}`);
    code = r.ok ? 0 : 1;
  } else if (cmd === 'stop') code = stopCommand(argv.includes('--force'), why);
  else if (cmd === 'status') code = statusCommand();
  else { usage(); code = cmd ? 1 : 0; }
  process.exit(code);
}

module.exports = {
  OVERLAYS, OVERLAY_FLAGS, SLICE_SECONDS, architectEye,
  raise, reap, heartbeat, stopRequested, readSession, conductorIsLive,
  SESSION_FILE, STOP_FILE,
  // The stop-request exit code, exported so `fleet_control.stopAnyRecording()` reads the same value
  // (Law 16).
  REQUESTED_NOT_REAPED,
};
