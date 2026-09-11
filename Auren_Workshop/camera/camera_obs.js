// Auren_Workshop/camera/camera_obs.js
// The OBS operator — one implementation of "record every camera window to its own file" (Law 16).
// Read-only toward the world, same film-crew citizenship as camera_rig: it films, it never acts in
// the shared world and joins no SPA loop (Law 19).
//
// WHY THIS EXISTS. The old workflow was one OBS instance per camera, hand-driven: launch N OBS,
// pick N windows, arrange N layouts, press record N times. That cost scales with camera count and
// it scales badly — every added bot multiplied a manual ritual. Everything it needed to stop being
// manual already existed: camera_window_titler.ps1 gives every camera window a unique, stable OS
// title, which is the ONLY thing that ever blocked a single OBS from telling Cam_AurenBot from
// Cam_TessaBot. This file cashes that in: ONE OBS, one Window Capture per camera, one Source Record
// filter per capture writing its own file, one StartRecord. Camera count becomes a parameter.
//
// ── THE LAW OF THIS FILE: BUILD WHILE OFF, DRIVE WHILE ON (Law 26) ──────────────────────────────
// OBS is a deterministic machine; this script is driven by a generator. Law 26 forbids the two being
// wired together directly and makes the legal boundary STATE-BOUND, which is exactly how the
// subcommands are split:
//
//   OBS STOPPED  → `configure` authors boot-time settings only (the profile INI, the obs-websocket
//                  enable flag). These are internals, and authoring an internal is legal precisely
//                  and only while nothing is running to corrupt. OBS validates them at startup —
//                  malformed JSON/INI is rejected loudly, which is the form catch.
//   OBS RUNNING  → `up`/`start`/`stop`/`status` touch NOTHING but obs-websocket, the interface both
//                  sides agreed to. Scenes, sources and filters are CREATED THROUGH IT, never by
//                  writing basic/scenes/*.json.
//
// WHY THE SCENE COLLECTION IS NOT GENERATED ON DISK (the wrong turn, named — Law 14). The obvious
// route is to author basic/scenes/<name>.json the way this file authors basic.ini. It was rejected:
// that file is version-fragile (it carries "version": 2, per-source uuids and a canvas_uuid OBS
// mints itself), so authoring it means DECIDING values that belong to OBS — simulation, which Law 26
// bars as the deleted guarantee. Creating the same objects over the websocket lets OBS decide and
// this file READ the result, and it survives a schema bump instead of breaking on one.
//
// WHY THE WINDOW STRING IS DISCOVERED, NOT BUILT. OBS identifies a window as "title:class:exe"
// (e.g. "Cam_AurenBot:GLFW30:javaw.exe"). Hand-building it hardcodes a class name that belongs to
// whatever GLFW/Java the launcher happens to ship. Instead every source is created empty, OBS is
// asked what windows it can actually see (GetInputPropertiesListPropertyItems), and the reported
// string is matched on the title we control and written back verbatim. Law 23: the window list is
// sensed, never assumed.
//
// TRUTH-CHECK (Law 25). "I sent StartRecord" is not "it is recording". Issuing is not succeeding, so
// `status` reports outputActive from OBS *and* the real size of each per-camera file on disk. Note
// GetRecordStatus does NOT return a path (only outputActive/outputPaused/outputTimecode/
// outputDuration/outputBytes) — that is why the file check reads the output directory directly
// rather than asking OBS where it is writing.
//
// LIFECYCLE (Law 8). `down` stops the recording before quitting OBS, so a run never leaves an
// encoder writing into a file nobody will close. Nothing survives the run that raised it.
//
// Diagnostics: BOT_ID=camera_obs routes every decision to fleet_logs/traces/watcher_camera_obs.jsonl — a
// file named after the unit that owns it (Law 6).
//
// Usage (all forms resolve the roster from architect_config.js, the single source — Law 16):
//   node camera_obs.js configure [--bots=A,B] [--count=N]   OBS must be STOPPED. Writes boot config.
//   node camera_obs.js up        [--bots=A,B] [--count=N]   Launch OBS, build/verify scene+sources.
//                                                           Always includes the Architect's eye: one
//                                                           more capture and one more file, for the
//                                                           camera a human flies.
//   node camera_obs.js start                                Begin recording (all cameras, one call).
//   node camera_obs.js stop                                 End recording.
//   node camera_obs.js status                               outputActive + per-file bytes on disk.
// start/stop/status take no roster: they INHERIT the set `up` recorded (see SESSION ROSTER below),
// because they are not where the camera count is decided. --bots/--count still override.
//   node camera_obs.js down                                 Stop recording, then quit OBS.
//   node camera_obs.js probe                                Dump OBS's own default settings keys for
//                                                           window_capture + source_record, and the
//                                                           live capturable-window list. Diagnostic
//                                                           only — it decides nothing.

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/camera/camera_obs.js');

// The @-aliases are registered EXPLICITLY, before the watcher require. package.json's _moduleAliases
// only self-register for an entry point launched from that package root; this file is a workshop tool
// launched by path, so without this the watcher loads but its own @kernel requires fail and every
// narrate() degrades to a SELF-FAULT — diagnostics silently gone while the tool appears to work.
const paths = require('../workshop_paths');
paths.registerAliases();

process.env.BOT_ID = process.env.BOT_ID || 'camera_obs';   // must precede the watcher require
const watcher = require(paths.bot('js_kernel/watcher.js'));
const CFG = require('./camera_configure.js');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--')) || 'status';
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};

// A config value this file cannot proceed without. Missing means camera_configure was edited into a
// shape this file cannot read — a coding violation, thrown, never defaulted (Law 13).
function requireString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`camera_obs: ${where} must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  return value.trim();
}

const { BOT_SENIORITY } = require(paths.bot('Thinking_fragments/architect_config.js'));
const ROSTER = Object.keys(BOT_SENIORITY);
const COUNT = parseInt(opt('count', '0'), 10);
// `--bots=` PRESENT AND EMPTY IS A REAL ANSWER — "no bot cameras" — and it has to be distinguishable
// from not being told at all, which still means the whole roster. A let's play comes up with none: the
// crew is hired in chat later and camera_warden binds each camera as its bot stands up. Testing the
// VALUE could not tell the two apart, so a run that asked for no bot cameras got twenty-two window
// captures, every one of them unbound and recording black.
const BOTS_GIVEN = args.some(a => a === '--bots' || a.startsWith('--bots='));
const EXPLICIT_ROSTER = BOTS_GIVEN || COUNT >= 1;            // the operator named the set on THIS call
let BOTS = BOTS_GIVEN
  ? opt('bots', '').split(',').map(s => s.trim()).filter(Boolean)
  : (COUNT >= 1 ? ROSTER.slice(0, COUNT) : ROSTER);
let CAMS = BOTS.map(b => `Cam_${b}`);

// ── THE ARCHITECT'S EYE IS A CAMERA, NOT A BOT ───────────────────────────────────────────────
// It is one more window to capture and one more file to write, and nothing here needs to know that a
// human rather than a director is flying it. So it joins CAMS and not BOTS: every count, every bind
// check and every growth check downstream reads CAMS, and BOTS keeps meaning "roster bot" rather than
// quietly becoming "thing with a camera". Its name comes from camera_configure, the one declaration.
//
// OPTIONAL, AND OFF BY DEFAULT — the seat produces nothing unless a human flies it for the whole run,
// so it is asked for rather than assumed (Law 13; the reasoning is in camera_configure's architect
// section, once).
//
// THE SWITCH MUST ARRIVE THE SAME WAY IT REACHED THE LAUNCHER, which is why `--architect` is read here
// and not inferred. The launcher builds the window and this file binds the capture; those are two
// owners of one decision, and a disagreement between them is silent in both directions — an unbound
// window renders and records nothing, and a capture bound to a client that never launched reports a
// clean start over a black file. Neither throws. Passing the same value to both is what makes them one
// decision (Law 16), and the config default answers a call that names nothing.
const ARCHITECT_CAM = (CFG.architect && CFG.architect.camName) || 'Cam_Architect';
const ARCHITECT_ARG = opt('architect', null);
const ARCHITECT_ON = ARCHITECT_ARG === null
  ? !!(CFG.architect && CFG.architect.enable)
  : /^(on|true|1|yes)$/i.test(ARCHITECT_ARG);
if (ARCHITECT_ON && !CAMS.includes(ARCHITECT_CAM)) CAMS.push(ARCHITECT_CAM);

// ── THE HOST SEAT IS A CAPTURE, NOT A CAMERA ─────────────────────────────────────────────────
// Everything downstream of here — the bind check, the growth check, the session roster, the stop
// tally — reads CAMS, so the presenter's window joins that list and is counted like any other
// window. It stays out of BOTS for the same reason the eye does: BOTS means "roster bot", and a
// seat that quietly widened it would put a human into every per-bot tally in the fleet.
//
// WHAT MAKES IT DIFFERENT IS ONE THING AND IT IS THE AUDIO. Every other capture in a take carries
// its own window's sound and nothing else; this one carries a mixer track holding its window AND
// the microphone. `isHost` below is the only branch in this file, and it is deliberately a single
// predicate rather than a per-camera settings table — two tables would be two answers to "what is
// this camera" the moment either was edited (Law 16).
//
// THE SWITCH REACHES BOTH RAISERS OR NEITHER, exactly as the eye's does: the launcher builds the
// window, this file binds the capture and the recording filter, and a disagreement is silent in
// both directions — an unbound window renders and records nothing, a filter bound to a client that
// never launched reports a clean start over a black file. record_overlay passes one value to both.
// NO FALLBACK STRING. camera_configure is the one declaration of this name and three consumers read
// it; a literal here would be a second declaration that only ever gets used at the moment the first
// one is unreachable — i.e. it binds a capture to a window nobody launched and reports a clean start
// over a black file (Law 16, and Law 13: default stopped rather than default guessed).
const HOST_CAM = requireString(CFG.host && CFG.host.camName, 'camera_configure host.camName');
const HOST_ARG = opt('host', null);
const HOST_ON = HOST_ARG === null
  ? !!(CFG.host && CFG.host.enable)
  : /^(on|true|1|yes)$/i.test(HOST_ARG);
if (HOST_ON && !CAMS.includes(HOST_CAM)) CAMS.push(HOST_CAM);
const isHost = cam => HOST_ON && cam === HOST_CAM;

// Mixer track carrying [host window + microphone]. Clamped to OBS's real range rather than trusted
// from the config: track 1 is the main recording's own track, so a host file pointed at it would
// carry every other window in the scene, and a track above 6 does not exist and would bind nothing.
// Both failures are silent in the file (Law 13 — validate the precondition, never default past it).
const MIC_TRACK = (() => {
  const t = Number((CFG.host && CFG.host.micTrack) || 2);
  if (!Number.isInteger(t) || t < 2 || t > 6) {
    throw new Error(`camera_configure host.micTrack is ${CFG.host && CFG.host.micTrack} — it must be an ` +
      `integer 2-6. Track 1 is OBS's own recording track and would put every window in the scene into ` +
      `the presenter's file; there is no track above 6.`);
  }
  return t;
})();
const MIC_INPUT = 'Mic/Aux';

// ── The session roster ────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS. `up` is told how many cameras this session has; `start`/`stop`/`status` are
// not, and they fell back to the WHOLE roster. So a two-camera session reported "2/3 file(s) growing
// — NOT EVERY CAMERA IS WRITING (Cam_IrisBot)" and told the operator to re-run `up` with the windows
// open. That is a Law 25 violation with real teeth: a truthful shortfall against a criterion nobody
// set, which trains the reader to ignore the one warning that catches a genuinely unbound window.
// `up` decides the set, so `up` records it, and the later verbs read it instead of guessing.
// An explicit --bots/--count on the call still wins — the operator outranks the record.
// Law 8: raised by `up`, released by `down`; a stale file cannot outlive its session.
const SESSION_FILE = paths.bot('js_kernel', 'camera_obs_session.json');

function writeSessionRoster() {
  // `host` is recorded alongside the set because it is not derivable from it: the host seat being in `cams`
  // says a window is captured, not that a microphone was routed into its file. A later `status` that
  // re-read the config instead would report whatever the config says TODAY about a session raised
  // yesterday (Invariant B — the session states what was actually raised).
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ bots: BOTS, cams: CAMS, host: HOST_ON ? HOST_CAM : null, micTrack: HOST_ON ? MIC_TRACK : null }, null, 2)); }
  catch (e) { narrate('warn', 'camera_obs', `could not record the session roster (${e.message}) — later verbs will assume the full roster.`); }
}

function clearSessionRoster() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (e) { /* nothing to release */ }
}

// Adopt the set `up` recorded. Silent when absent: no session file means no `up` this boot, and the
// full roster is then the honest default rather than a guess.
//
// THE SESSION IS ADOPTED OFF `cams`, NEVER OFF `bots`, and that distinction is the whole of a defect
// measured live on 2026-09-06. This gated on `s.bots.length`, so a session whose bot list is EMPTY —
// which is every let's play, where the crew is hired in chat later and the only window up is the host
// seat — read as "no session on record" and fell back to the full 22-bot roster. `start` then reported
// `0/20 per-camera file(s) growing … NOT EVERY CAMERA IS WRITING` and named twenty bots that were
// never asked for, while the host seat's file was on disk at 33 MB and writing perfectly. A truthful
// shortfall against a criterion nobody set is the Law 25 fault this file's own header already
// describes — and it trains the reader to ignore the one warning that catches a genuinely dead camera.
//
// `cams` is the right key because it is the ANSWER: every count, bind check and growth check
// downstream reads CAMS, and a session always has at least one camera or there was nothing to record.
// `bots` means "roster bot" and legitimately empty. Third occurrence of one class of bug in this pass
// (the launcher's `-Bots`, this file's `--bots=`, and here): an empty collection is a real answer and
// tests the LENGTH of one to decide whether it was given cannot tell that from silence.
function adoptSessionRoster() {
  if (EXPLICIT_ROSTER) return;
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Array.isArray(s.cams) && s.cams.length) {
      CAMS = s.cams;
      BOTS = Array.isArray(s.bots) ? s.bots : [];
    }
  } catch (e) { /* no session on record — keep the full roster */ }
}

function narrate(level, stage, message) {
  const icon = level === 'warn' ? '⚠️ ' : level === 'error' ? '❌ ' : '';
  console.log(`${icon}[${stage.toUpperCase()}] ${message}`);
  watcher[level](stage, message);
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────
// The portable OBS tree lives in tools/OBS (gitignored — a 450 MB per-machine asset, exactly like
// tools/PrismLauncher). Portable mode is what puts config INSIDE that tree instead of %APPDATA%,
// which is the whole reason these paths are deterministic enough to generate against.
// HOW portable mode is activated: `up` passes --portable on the launch (see spawn below) — that is
// the authoritative route, because OBS resolves the portable_mode.txt FILE from the OBS ROOT
// (bin/64bit/../..), not from beside the exe, so a file dropped next to obs64.exe is silently
// ignored and OBS falls back to %APPDATA% (measured 2026-07-20: config + websocket landed in
// %APPDATA%, port 4455 refused, no log ever written to tools/OBS). portable_mode.txt at the tree
// ROOT is kept only as the hand-launch fallback (double-clicking obs64.exe); the operator never
// relies on it.
const PROJECT_ROOT = paths.REPO_ROOT;
const OBS_DIR      = path.join(PROJECT_ROOT, 'tools', 'OBS');
const OBS_EXE      = path.join(OBS_DIR, 'bin', '64bit', 'obs64.exe');
// OBS's own names for the two global audio devices it creates in every fresh profile. Fixed strings
// rather than a camera_configure knob: they are OBS's identifiers, not a choice this system makes, and
// a knob would imply an off position that means "record the machine" — which no filming run wants.
const GLOBAL_AUDIO_INPUTS = ['Desktop Audio', 'Mic/Aux'];

const OBS_CONFIG   = path.join(OBS_DIR, 'config', 'obs-studio');
const WS_CONFIG    = path.join(OBS_CONFIG, 'plugin_config', 'obs-websocket', 'config.json');
const PROFILE_DIR  = path.join(OBS_CONFIG, 'basic', 'profiles', CFG.obs.profileName);
const FOOTAGE_DIR  = path.isAbsolute(CFG.obs.outputDir)
  ? CFG.obs.outputDir
  : path.join(PROJECT_ROOT, CFG.obs.outputDir);
// Where the main recording lands. Separate from FOOTAGE_DIR so the deliverables directory contains
// only deliverables — see the `trigger` block in camera_configure.js for why that output exists.
const TRIGGER_DIR  = path.isAbsolute(CFG.obs.trigger.dir)
  ? CFG.obs.trigger.dir
  : path.join(PROJECT_ROOT, CFG.obs.trigger.dir);

function requireObsInstalled() {
  if (!fs.existsSync(OBS_EXE)) {
    // Default stopped (Law 13): a missing OBS is a precondition failure, not something to work
    // around. start_cameras.ps1 owns the download; this file never installs.
    throw new Error(`OBS not found at ${OBS_EXE} — run start_cameras.ps1 to install it.`);
  }
}

const obsRunning = () => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-Process obs64 -ErrorAction SilentlyContinue | Measure-Object).Count'], { encoding: 'utf8' });
  return parseInt((r.stdout || '0').trim(), 10) > 0;
};

// ── configure: boot-time settings. OBS MUST BE STOPPED (Law 26 state gate). ───────────────────
// Everything written here is read by OBS once, at startup. Writing it while OBS runs would be
// reaching into a turning engine — and OBS rewrites both files on exit, so the edit would be
// silently clobbered anyway. The gate is therefore enforced, not documented.
function configure() {
  requireObsInstalled();
  if (obsRunning()) {
    throw new Error('OBS is running — `configure` authors boot-time internals and is legal only ' +
                    'while it is stopped (Law 26). Run `down` first.');
  }

  // — obs-websocket. The password is NOT invented here: obs-websocket generates a random one on its
  //   first load and we reuse it verbatim, so authentication stays ON with no secret for anyone to
  //   manage or leak into git. first_load MUST be false or the plugin regenerates the password on
  //   next start and rewrites this file, discarding the intent.
  fs.mkdirSync(path.dirname(WS_CONFIG), { recursive: true });
  const ws = fs.existsSync(WS_CONFIG) ? JSON.parse(fs.readFileSync(WS_CONFIG, 'utf8')) : {};
  if (!ws.server_password) ws.server_password = crypto.randomBytes(12).toString('base64');
  Object.assign(ws, {
    first_load: false,
    server_enabled: true,
    server_port: CFG.obs.websocketPort,
    auth_required: true,
    alerts_enabled: false,
  });
  fs.writeFileSync(WS_CONFIG, JSON.stringify(ws, null, 2) + '\n');

  // — Legacy migration guard. obs-websocket ≤5.4.2 kept its settings in global.ini's [OBSWebSocket]
  //   section; ≥5.5.0 moved to the config.json above and migrates on startup — and on that one
  //   startup the migrated ini values WIN over what we just wrote. Stripping the section makes the
  //   write above authoritative regardless of what the tree was upgraded from.
  const globalIni = path.join(OBS_CONFIG, 'global.ini');
  if (fs.existsSync(globalIni)) {
    const text = fs.readFileSync(globalIni, 'utf8');
    const stripped = text.replace(/^\[OBSWebSocket\][\s\S]*?(?=^\[|\s*$)/m, '');
    if (stripped !== text) {
      fs.writeFileSync(globalIni, stripped);
      narrate('summary', 'camera_obs', 'stripped legacy [OBSWebSocket] section from global.ini.');
    }
  }

  // — First-run wizard suppression. On a COLD OBS install (binaries freshly copied into tools/OBS,
  //   no config OBS ever wrote), global.ini does not exist and OBS treats launch as a first run: it
  //   blocks on the Auto-Configuration Wizard BEFORE the websocket server starts, so `up` hangs its
  //   full timeout with NO log written at all (measured 2026-07-20 on the home box's fresh tools/OBS
  //   copy — obs64 alive, logs/ dir never created, port 4455 never bound). FirstRun=true tells OBS
  //   the first run already happened, skipping the wizard. This MUST be authored: the alternative is
  //   a human clicking through the wizard once, which is exactly the manual step the unattended chain
  //   cannot contain (Law 26 — configure owns authoring the COMPLETE stopped-state boot config, not a
  //   partial one OBS then finishes via a blocking modal). Legal only because OBS is verified stopped.
  setIniKey(globalIni, 'General', 'FirstRun', 'true');

  // — ConfirmOnExit. OBS defaults to asking "are you sure?" on close, which turns a graceful
  //   shutdown request into a modal dialog nothing is there to answer — so the close hangs, the
  //   force-kill lands, and the NEXT start comes up in the crash-recovery path. An unattended OBS
  //   must be allowed to exit when asked.
  setIniKey(path.join(OBS_CONFIG, 'user.ini'), 'General', 'ConfirmOnExit', 'false');

  // — System tray OFF. With the tray enabled, a close request makes OBS HIDE to the tray instead of
  //   exiting, so every `down` fell through to the force-kill (measured: ConfirmOnExit=false alone
  //   did not help — the close was being honoured, it just meant "hide"). Tray mode also removes
  //   the main window, which is what made CloseMainWindow() a no-op. One visible OBS window is the
  //   correct trade: it is ONE window instead of the three this whole system exists to delete, and
  //   it makes "am I recording?" answerable at a glance.
  setIniKey(path.join(OBS_CONFIG, 'user.ini'), 'BasicWindow', 'SysTrayEnabled', 'false');

  // — Stale crash sentinel. OBS creates config/obs-studio/.sentinel at startup and removes it on a
  //   clean exit; finding it at startup means "unclean shutdown" and raises a SAFE MODE dialog that
  //   blocks before the websocket ever opens — an unattended launch then hangs forever with no
  //   error (measured 2026-07-20: the log stops dead at "Crash or unclean shutdown detected").
  //   --disable-shutdown-check does NOT suppress this in 32.1.2; it was tried and is inert.
  //   Clearing it is only legal because OBS is verified stopped above: with OBS running the
  //   sentinel is LIVE state and deleting it would be reaching into the turning engine (Law 26).
  clearCrashSentinel();

  // — Profile. Canvas + fps + the recording path. The per-camera files are written by the Source
  //   Record filters, not by this output, so the main recording is only the container the filters
  //   ride on — but its FPS and canvas still set what every capture is sampled at.
  //   Because it is only a container, it is pointed at its own directory and given its own bitrate
  //   (`trigger` in camera_configure.js). Both are read by THIS output alone: each Source Record
  //   filter sets its own `path` and `bitrate` explicitly, so neither value can reach a deliverable.
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
  fs.mkdirSync(TRIGGER_DIR, { recursive: true });
  const enc = resolveEncoder();
  const ini = [
    '[General]',
    `Name=${CFG.obs.profileName}`,
    '',
    '[Output]',
    'Mode=Simple',
    '',
    '[SimpleOutput]',
    `FilePath=${TRIGGER_DIR.replace(/\\/g, '\\\\')}`,
    `RecFormat2=${CFG.obs.container}`,
    `VBitrate=${CFG.obs.trigger.bitrateKbps}`,
    'RecQuality=Stream',
    `RecEncoder=${enc}`,
    `StreamEncoder=${enc}`,
    'RecTracks=1',
    '',
    '[Video]',
    `BaseCX=${CFG.obs.canvas.width}`,
    `BaseCY=${CFG.obs.canvas.height}`,
    `OutputCX=${CFG.obs.canvas.width}`,
    `OutputCY=${CFG.obs.canvas.height}`,
    'FPSType=0',
    `FPSCommon=${CFG.obs.canvas.fps}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(PROFILE_DIR, 'basic.ini'), ini);

  narrate('summary', 'camera_obs',
    `configured · profile=${CFG.obs.profileName} ${CFG.obs.canvas.width}x${CFG.obs.canvas.height}@${CFG.obs.canvas.fps} ` +
    `encoder=${enc} footage=${FOOTAGE_DIR} @${CFG.obs.bitrateKbps}kbps · ` +
    `trigger=${TRIGGER_DIR} @${CFG.obs.trigger.bitrateKbps}kbps · ` +
    `ws=127.0.0.1:${CFG.obs.websocketPort} (auth on)`);
}

// The sentinel is a DIRECTORY, not a file — removing it needs a recursive delete, and a plain
// unlink fails silently enough to look like it worked.
function clearCrashSentinel() {
  const sentinel = path.join(OBS_CONFIG, '.sentinel');
  if (fs.existsSync(sentinel)) {
    fs.rmSync(sentinel, { recursive: true, force: true });
    return true;
  }
  return false;
}

// Minimal INI key setter: preserves every other line and the file's BOM (OBS writes user.ini with
// one). Only touches the single key asked for — this file is OBS's, not ours, and a rewrite that
// normalised it would be authoring decisions that belong to OBS.
// CREATES the file (with just the requested section) when it is MISSING: on a cold OBS install
// neither global.ini nor user.ini exists yet, and configure's job is to author the boot config, so
// a silent no-op there left ConfirmOnExit/SysTrayEnabled/FirstRun unwritten and OBS wedged on the
// first-run wizard (measured 2026-07-20). Non-normalizing on an EXISTING file is preserved — the
// intent above is "don't rewrite what OBS owns", not "refuse to seed what OBS hasn't written yet".
function setIniKey(file, section, key, value) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const bom = raw.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/);
  let inSection = false, done = false;
  const out = lines.map(line => {
    const header = line.match(/^\[(.+)\]\s*$/);
    if (header) { inSection = header[1] === section; return line; }
    if (inSection && !done && new RegExp(`^${key}=`).test(line)) { done = true; return `${key}=${value}`; }
    return line;
  });
  if (!done) {
    const idx = out.findIndex(l => l.trim() === `[${section}]`);
    if (idx >= 0) out.splice(idx + 1, 0, `${key}=${value}`);
    else out.push(`[${section}]`, `${key}=${value}`);
  }
  fs.writeFileSync(file, bom + out.join('\n'));
}

// Encoder: MEASURED, not assumed. `auto` reads OBS's own most recent log and asks whether the
// hardware encoder module actually initialised on THIS machine — the work box has no NVIDIA GPU and
// logs "Failed to initialize module 'obs-nvenc.dll'", the home 5090 loads it. Checking the log is
// checking what OBS did; checking the GPU model would only be checking what we think it implies.
function resolveEncoder() {
  if (CFG.obs.encoder !== 'auto') return CFG.obs.encoder;
  const logDir = path.join(OBS_CONFIG, 'logs');
  if (!fs.existsSync(logDir)) return 'x264';
  const logs = fs.readdirSync(logDir).filter(f => f.endsWith('.txt'))
    .map(f => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  // Use the newest log that actually got far enough to enumerate encoders. The detection reads
  // NVENC as available when the "failed to initialize" line is ABSENT — so a log that stopped
  // early (a crash-dialog stall truncates at line 2) reports every encoder as present. Absence of
  // evidence was being read as evidence of absence; requiring the "Available Encoders:" marker
  // makes the instrument prove it was working before its reading is trusted (Law 23).
  // Measured 2026-07-20: without this, a stalled start yielded encoder=nvenc on a box with no
  // NVIDIA GPU at all.
  for (const { f } of logs) {
    const text = fs.readFileSync(path.join(logDir, f), 'utf8');
    if (!/Available Encoders:/.test(text)) continue;
    if (!/Failed to initialize module 'obs-nvenc\.dll'/.test(text)) return 'nvenc';
    if (/Failed to initialize module 'obs-qsv11\.dll'/.test(text)) return 'x264';
    return 'qsv';
  }
  // No complete log yet (first ever run). x264 is the honest answer: it is the one encoder every
  // machine has, and a wrong guess at a hardware encoder fails at record time, not here.
  return 'x264';
}

// ── The websocket client (the ONLY thing that touches a running OBS) ──────────────────────────
class ObsLink {
  constructor() { this.pending = new Map(); this.seq = 0; }

  connect() {
    if (!fs.existsSync(WS_CONFIG)) {
      throw new Error('obs-websocket is not configured — run `configure` first.');
    }
    const cfg = JSON.parse(fs.readFileSync(WS_CONFIG, 'utf8'));
    if (!cfg.server_enabled) throw new Error('obs-websocket is disabled — run `configure` first.');

    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${cfg.server_port}`);
      this.sock = sock;
      const fail = e => reject(new Error(`obs-websocket: ${e.message || e}`));
      sock.on('error', fail);
      sock.on('close', (code) => {
        // 4009 is the protocol's explicit "your auth string was wrong" — worth naming, because the
        // silent alternative reads as "OBS isn't running" and sends diagnosis down the wrong path.
        if (code === 4009) fail(new Error('authentication failed (4009) — stale password in config.json?'));
        for (const [, p] of this.pending) p.reject(new Error('obs-websocket closed'));
        this.pending.clear();
      });
      sock.on('message', raw => {
        const { op, d } = JSON.parse(raw);
        if (op === 0) {
          // Branch on the Hello payload, never on whether we happen to hold a password: the server
          // decides whether auth is in play, and it is the only party that knows.
          const identify = { rpcVersion: 1, eventSubscriptions: 0 };
          if (d.authentication) {
            const secret = crypto.createHash('sha256')
              .update(cfg.server_password + d.authentication.salt, 'utf8').digest('base64');
            identify.authentication = crypto.createHash('sha256')
              .update(secret + d.authentication.challenge, 'utf8').digest('base64');
          }
          sock.send(JSON.stringify({ op: 1, d: identify }));
        } else if (op === 2) {
          resolve(this);
        } else if (op === 7) {
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          if (d.requestStatus.result) p.resolve(d.responseData || {});
          else p.reject(new Error(`${d.requestType} → ${d.requestStatus.code}: ${d.requestStatus.comment || 'failed'}`));
        }
      });
    });
  }

  request(requestType, requestData) {
    const requestId = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.sock.send(JSON.stringify({ op: 6, d: { requestType, requestId, ...(requestData && { requestData }) } }));
    });
  }

  // Some requests are expected to fail benignly (asking whether a thing exists). Only those call
  // this; everything else lets the rejection through, because a swallowed failure is exactly the
  // hiding place Law 16 forbids.
  async tryRequest(requestType, requestData) {
    try { return await this.request(requestType, requestData); } catch { return null; }
  }

  close() { if (this.sock) this.sock.close(); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connectWithRetry(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { return await new ObsLink().connect(); } catch (e) { last = e; await sleep(1000); }
  }
  throw new Error(`could not reach obs-websocket within ${timeoutMs / 1000}s — ${last && last.message}`);
}

// ── up: launch OBS, then build/verify the scene through the websocket ─────────────────────────
async function up() {
  requireObsInstalled();
  if (!fs.existsSync(WS_CONFIG)) configure();

  if (!obsRunning()) {
    // Clear a stale sentinel on every launch, not just at `configure` time: the crash flag is left
    // by whatever happened LAST run (a force-kill, a power loss), so checking it once at setup
    // would miss every case that actually produces it. Safe here because OBS is verified down.
    if (clearCrashSentinel()) {
      narrate('warn', 'camera_obs',
        'stale crash sentinel found — previous OBS exited uncleanly. Cleared it so this start does ' +
        'not stall on the safe-mode dialog.');
    }
    // --collection is deliberately NOT passed: the collection is created over the websocket below if
    // absent, and naming one that does not exist yet makes OBS mint an empty one under a name we
    // then have to reconcile. The profile DOES exist by now (configure wrote it), so it is safe.
    // No --minimize-to-tray: see configure()'s SysTrayEnabled note — tray mode makes a close request
    // mean "hide", which breaks unattended shutdown. --disable-shutdown-check is also NOT passed: it
    // is inert in 32.1.2 (tested), and carrying a flag that does nothing invites trusting it later.
    const child = spawn(OBS_EXE, [
      '--portable',                       // authoritative: forces config into tools/OBS/config, not
                                          //   %APPDATA% — the portable_mode.txt file resolves from the
                                          //   OBS root (not beside the exe) and is unreliable alone.
      '--profile', CFG.obs.profileName,
      '--disable-updater',
    ], { cwd: path.join(OBS_DIR, 'bin', '64bit'), detached: true, stdio: 'ignore' });
    child.unref();
    narrate('summary', 'camera_obs', 'OBS launched — waiting for the websocket...');
  }

  const obs = await connectWithRetry();
  const ver = await obs.request('GetVersion');
  narrate('summary', 'camera_obs',
    `linked · OBS ${ver.obsVersion} · obs-websocket ${ver.obsWebSocketVersion} (rpc ${ver.rpcVersion})`);

  await ensureScene(obs);
  await silenceGlobalAudio(obs);
  const results = [];
  for (const cam of CAMS) results.push(await ensureCamera(obs, cam));

  const bound = results.filter(r => r.bound).length;
  const level = bound === CAMS.length ? 'summary' : 'warn';
  narrate(level, 'camera_obs',
    `${bound}/${CAMS.length} camera window(s) bound · ${results.map(r => `${r.cam}${r.bound ? '' : '(NO WINDOW)'}`).join(' · ')}` +
    (bound === CAMS.length ? '' : ' — unbound sources record black until their window exists; re-run `up` once the cameras are open.'));

  writeSessionRoster();   // this is THE set for the session — start/stop/status inherit it from here
  obs.close();
  return results;
}

// THE TAKE CARRIES THE GAME AND NOTHING ELSE — the two global devices are muted on every `up`.
//
// OBS ships a fresh profile with `Desktop Audio` (wasapi_output_capture, device "default") and
// `Mic/Aux` (wasapi_input_capture) both enabled and unmuted on every mixer track. Desktop audio is
// the WHOLE MACHINE's output, so anything played while a run records lands in the take, and the
// operator cannot use the box for anything else during a soak without appearing on the tape. The mic
// is worse: it is live on every take by default and nobody chose it.
//
// MUTED RATHER THAN DELETED, and rather than authored on disk. Muting is an interface operation OBS
// itself performs and persists, so it is legal while OBS runs (Law 26 — drive through the agreed
// interface, never reach into the engine). Deleting the inputs would have OBS recreate its defaults
// on the next load, and editing the scene collection JSON is barred by the ruling at the top of this
// file (its uuids and version field belong to OBS; deciding them is simulation).
//
// RE-ASSERTED EVERY `up`, exactly like capture_audio. A profile that has ever been unmuted by hand
// stays unmuted forever otherwise, and the failure is silent in the direction that matters: the
// footage plays back fine and carries whatever else the machine was doing.
//
// This does NOT silence the cameras. Each window capture carries its own audio on its own source
// (capture_audio + reroute_audio), which is what puts the world as heard at bot N into bot N's file.
// The two devices muted here are the machine's, not the game's.
// THE MICROPHONE IS THE ONE EXCEPTION, AND IT IS OPENED ONTO A SINGLE TRACK.
//
// Desktop Audio is muted unconditionally and always will be: it is the WHOLE MACHINE's output, so a
// browser, a notification or anything else played during a two-hour episode lands in the take, and
// nobody chose that. The microphone is muted too on every run WITHOUT a host seat, for the same
// reason it always was — it is live by default in a fresh OBS profile and nobody chose that either.
//
// With a host seat up, the presenter's voice is the entire point, so the mic is unmuted and routed
// to `MIC_TRACK` ONLY — never track 1. Track 1 is what OBS's own recording carries, and every other
// window in the scene sits on it; putting the mic there would leak the presenter's voice into the
// trigger by-product and, more importantly, would not put it anywhere the host's own file can read.
// The host capture is placed on track 1 AND MIC_TRACK by ensureCamera, so MIC_TRACK is exactly
// [host window + voice] and nothing else can reach it.
//
// RE-ASSERTED EVERY `up`, like capture_audio and the mute above: a profile unmuted by hand once
// stays unmuted forever otherwise, and every failure in this area is silent in the direction that
// matters — the footage plays back fine and carries the wrong thing, or nothing.
async function silenceGlobalAudio(obs) {
  const said = [];
  for (const name of GLOBAL_AUDIO_INPUTS) {
    // tryRequest: a profile may legitimately not have one of these (a box with no microphone), and an
    // absent device is already silent. Missing is not a failure — but a PRESENT one that refuses to
    // mute is, and that comes back as a thrown request rather than a skip.
    const state = await obs.tryRequest('GetInputMute', { inputName: name });
    if (!state) continue;

    if (HOST_ON && name === MIC_INPUT) {
      if (state.inputMuted) await obs.request('SetInputMute', { inputName: name, inputMuted: false });
      // The device, when one is named. 'default' is left alone deliberately — writing a value there
      // would be this file deciding which endpoint Windows should hand OBS, which is OBS's own call
      // (Law 26 — never author what the machine decides). A NAMED device is the operator's decision
      // and is asserted, because the whole reason to name one is that the default is wrong here.
      const dev = CFG.host && CFG.host.micDevice;
      if (dev && dev !== 'default') {
        await obs.request('SetInputSettings', { inputName: name, inputSettings: { device_id: dev } });
      }
      await obs.request('SetInputAudioTracks', { inputName: name, inputAudioTracks: trackMap([MIC_TRACK]) });
      said.push(`${MIC_INPUT} LIVE on track ${MIC_TRACK}${dev && dev !== 'default' ? ` (device "${dev}")` : ' (system default device)'}`);
      continue;
    }

    if (!state.inputMuted) await obs.request('SetInputMute', { inputName: name, inputMuted: true });
    said.push(`${name} muted${state.inputMuted ? ' (already)' : ''}`);
  }
  narrate('summary', 'camera_obs', said.length
    ? `global audio · ${said.join(' · ')}${HOST_ON ? '' : ' — takes carry the game windows only.'}`
    : 'no global audio devices in this profile — nothing to set.');
}

// OBS's SetInputAudioTracks takes every track it is to decide, so an omitted track is left at
// whatever the input already held. Stating all six is what makes this an assertion rather than a
// nudge: a source that was on track 3 by hand stays there forever under a partial map, and the one
// thing this system needs to be true — that MIC_TRACK carries the host window and the voice and
// NOTHING else — cannot be checked by looking at any single input.
function trackMap(on) {
  const m = {};
  for (let t = 1; t <= 6; t++) m[t] = on.includes(t);
  return m;
}

async function ensureScene(obs) {
  const { scenes } = await obs.request('GetSceneList');
  if (!scenes.some(s => s.sceneName === CFG.obs.sceneName)) {
    await obs.request('CreateScene', { sceneName: CFG.obs.sceneName });
    narrate('summary', 'camera_obs', `created scene "${CFG.obs.sceneName}".`);
  }
  await obs.request('SetCurrentProgramScene', { sceneName: CFG.obs.sceneName });
}

// One camera = one Window Capture input + one Source Record filter. Idempotent by construction:
// every step asks what exists before creating, so `up` is safe to re-run at any point (which is the
// property that lets it double as the repair path after a camera restart).
// The capture settings, in ONE place, because they are asserted TWICE — once at creation and once
// against an input that already exists. Two copies would be two settings that agree until one of them
// is edited (Law 16).
function captureSettings() {
  return {
    method: CFG.obs.capture.method,      // 2 = Windows 10 (1903+) / WGC — keeps an OCCLUDED
                                         //     window rendering, which is what allows the camera
                                         //     windows to be stacked instead of tiled.
    priority: CFG.obs.capture.priority,  // 1 = match TITLE — the titler guarantees it is unique
                                         //     and stable, so a restarted camera re-binds to the
                                         //     correct source instead of swapping.
    cursor: false,
    client_area: true,
    // SOUND. Off by default in OBS, which is why every take filmed before 2026-08-20 carries a silent
    // track rather than no track at all — see the note in camera_configure.js. reroute_audio keeps
    // each window's sound ON ITS OWN SOURCE, so camera N records the world as heard at bot N.
    capture_audio: CFG.obs.capture.audio,
    reroute_audio: CFG.obs.capture.audioPerCam,
  };
}

async function ensureCamera(obs, cam) {
  const { inputs } = await obs.request('GetInputList');
  const exists = inputs.some(i => i.inputName === cam);

  if (!exists) {
    await obs.request('CreateInput', {
      sceneName: CFG.obs.sceneName,
      inputName: cam,
      inputKind: 'window_capture',
      inputSettings: captureSettings(),
      sceneItemEnabled: true,
    });
  } else {
    // RE-ASSERT, exactly as ensureSourceRecordFilter does below and for the same reason. An input
    // created by an earlier revision keeps the settings it was created with forever, so a camera tree
    // already set up once on this machine would never receive capture_audio: the change would look
    // applied, every command would succeed, and the takes would go on being silent. That is the Law 25
    // shape — an outcome that reads as success while carrying none of the change.
    // The WINDOW is deliberately not in here; bindWindow owns that key and runs immediately below.
    await obs.request('SetInputSettings', { inputName: cam, inputSettings: captureSettings() });
  }

  // EVERY CAPTURE'S TRACKS ARE STATED, not only the host's. The property that has to hold is
  // "MIC_TRACK carries the host window and the voice and nothing else", and that is a fact about
  // the WHOLE set — one bot camera left on MIC_TRACK by an earlier revision or a hand edit puts a
  // second game window under the presenter's commentary, and the take plays back fine. So each
  // camera is pinned to track 1 alone and the host to track 1 plus MIC_TRACK (track 1 so the host
  // still appears in OBS's own recording like every other source; MIC_TRACK is the one its file
  // actually reads). Asserted every `up`, for the same reason the mute is.
  await obs.request('SetInputAudioTracks', {
    inputName: cam,
    inputAudioTracks: trackMap(isHost(cam) ? [1, MIC_TRACK] : [1]),
  });

  const bound = await bindWindow(obs, cam);
  await ensureSourceRecordFilter(obs, cam);
  return { cam, bound };
}

// Ask OBS which windows it can actually see and take the string it reports for ours. The alternative
// — composing "Cam_X:GLFW30:javaw.exe" ourselves — bakes in a window class owned by whatever Java the
// launcher ships, and fails silently (a black capture, not an error) the day it changes.
async function bindWindow(obs, cam) {
  const list = await obs.tryRequest('GetInputPropertiesListPropertyItems',
    { inputName: cam, propertyName: 'window' });
  if (!list) return false;
  const match = list.propertyItems.find(i => String(i.itemValue).split(':')[0] === cam);
  if (!match) return false;
  await obs.request('SetInputSettings', { inputName: cam, inputSettings: { window: match.itemValue } });
  return true;
}

// The Source Record filter is what makes ONE OBS enough: it writes this source to its OWN file,
// independently of the main recording, so N cameras produce N full-resolution files from a single
// StartRecord.
//
// record_mode is the plugin's own enum, read off its locale file rather than guessed:
//   0 None · 1 Always · 2 Streaming · 3 Recording · 4 Streaming-or-Recording · 5 Virtual Camera
// `Recording` is what makes one `start` enough for N cameras — every filter follows OBS's own
// recording state, so the fleet needs no per-camera call. The cost is that the main recording must
// run, which is why it has its own directory and bitrate (see `trigger` in camera_configure.js).
// The mode that would remove that output entirely is `Virtual Camera`, driven by StartVirtualCam:
// it is NOT a drop-in, because the Windows virtual-camera device is registered by the OBS installer
// and this is a portable OBS — the device may not exist, and a filming run that cannot start is a
// far worse failure than a by-product file. Prove the device registers before reaching for it.
//
// THE HOST'S FILE READS A MIXER TRACK, AND IT TAKES TWO KEYS. MEASURED 2026-09-06, not read:
// `audio_track: N` on its own is INERT — a filter carrying it wrote digital silence (-91.0 dB) in the
// same pass where a 440 Hz tone assigned to that very track reached the main recording at -21.1 dB.
// `different_audio: true` is what arms it, and with both set the file carried the track exactly
// (-21.1 dB). Naming a source instead (`different_audio` + `audio_source`) also works and is the wrong
// tool here: it carries ONE source, and this file needs the window and the voice mixed.
// Every other camera omits both keys and gets its parent window's own audio, which is what puts the
// world as heard at bot N into bot N's file.
async function ensureSourceRecordFilter(obs, cam) {
  const settings = {
    path: FOOTAGE_DIR,
    filename_formatting: `${cam}_%CCYY-%MM-%DD_%hh-%mm-%ss`,
    rec_format: CFG.obs.container,
    record_mode: CFG.obs.sourceRecord.recordMode,
    encoder: resolveEncoder(),
    rate_control: 'CBR',
    bitrate: CFG.obs.bitrateKbps,
    ...(isHost(cam) ? { different_audio: true, audio_track: MIC_TRACK } : {}),
  };

  const existing = await obs.tryRequest('GetSourceFilterList', { sourceName: cam });
  if (existing && existing.filters.some(f => f.filterName === CFG.obs.filterName)) {
    // Re-assert settings rather than returning early. "Idempotent" has to mean CONVERGES on the
    // configured state, not merely "doesn't crash twice": an existing filter left untouched keeps
    // whatever mode it was created with, so a corrected record_mode would never reach a tree that
    // had already been set up once — the fix would look applied and silently not be.
    await obs.request('SetSourceFilterSettings', {
      sourceName: cam, filterName: CFG.obs.filterName, filterSettings: settings,
    });
    return;
  }
  // 'source_record_filter' is the plugin's internal kind id — NOT 'source_record' (the dll name) and
  // not its "Source Record" display name. Read off GetSourceFilterKindList on the installed build;
  // guessing it from the filename fails with error 607 and reads like a missing plugin.
  await obs.request('CreateSourceFilter', {
    sourceName: cam,
    filterName: CFG.obs.filterName,
    filterKind: 'source_record_filter',
    filterSettings: settings,
  });
  narrate('summary', 'camera_obs', `${cam}: Source Record filter created → own file in ${FOOTAGE_DIR}.`);
}

// ── Recording control + the truth check ──────────────────────────────────────────────────────
// `start` MEANS "EVERY CAMERA IN THIS SESSION IS WRITING", and it is idempotent for that reason.
//
// It used to mean "StartRecord was issued", and against an already-recording OBS it warned and
// returned — a correct statement about a call and the wrong answer to the question. The contractor
// path is what makes the difference load-bearing: a camera raised mid-take joins an OBS that is
// ALREADY recording, so the only call that can confirm the new file is writing is one made while the
// output is live. Returning early there would leave the one case that needs verifying as the one case
// that is never verified (Law 25 — the criterion is the caller's: N files growing).
//
// So the StartRecord is skipped when the output is already up and the growth check runs either way.
async function startRecording() {
  const obs = await connectWithRetry(10000);
  const status = await obs.request('GetRecordStatus');
  const alreadyRolling = status.outputActive;
  const before = perCameraFiles();
  if (alreadyRolling) {
    narrate('summary', 'camera_obs',
      'already recording — StartRecord not re-issued; verifying every camera in the session is writing.');
  } else {
    await obs.request('StartRecord');
  }

  // POLL, don't sleep-once. Source Record creates each file immediately but buffers its first
  // writes, so a file sits at 0 bytes for several seconds before the muxer flushes — a single fixed
  // wait samples inside that window and reports a false failure (measured: 0/3 at 4s, 3/3 by 9s).
  // Polling until the claim is actually true converges as fast as the machine allows instead of
  // encoding a guess about how slow it is.
  let growing = [];
  for (let i = 0; i < CFG.obs.verifySeconds; i++) {
    await sleep(1000);
    growing = growingCameras(before);
    if (growing.length === CAMS.length) break;
  }
  const after = await obs.request('GetRecordStatus');
  obs.close();

  // Law 25: the verdict is measured against what the caller asked for — N files GROWING — not
  // against "the command returned without throwing". A StartRecord that succeeds while a Source
  // Record filter sits unbound would otherwise report a clean success and hand back black video.
  //
  // GROWTH, not newness. An earlier version counted files that appeared after StartRecord, which
  // reported 0/3 while three files were writing perfectly: the filters had begun at CREATION time
  // (record_mode 1 = Always), so their files predated the call and were filtered out as "not new".
  // Bytes-increased is the property actually being claimed; file-is-new was a proxy for it that
  // silently stops being one the moment the mode changes.
  const now = perCameraFiles();
  const level = (after.outputActive && growing.length === CAMS.length) ? 'summary' : 'warn';
  narrate(level, 'camera_obs',
    `recording=${after.outputActive} · ${growing.length}/${CAMS.length} per-camera file(s) growing after ` +
    `${CFG.obs.verifySeconds}s · ${growing.map(c => `${c} ${(now[c].bytes / 1048576).toFixed(1)}MB`).join(' · ') || 'none'}` +
    (level === 'warn'
      ? ` — NOT EVERY CAMERA IS WRITING (${CAMS.filter(c => !growing.includes(c)).join(', ')}). Its window is ` +
        'probably unbound: re-run `up` with the camera windows open.'
      : ''));
}

async function stopRecording() {
  const obs = await connectWithRetry(10000);
  const status = await obs.request('GetRecordStatus');
  if (!status.outputActive) {
    narrate('warn', 'camera_obs', 'not recording — StopRecord not issued.');
    obs.close();
    return;
  }
  await obs.request('StopRecord');
  await sleep(1500);
  obs.close();
  // Report the per-CAMERA files, matched by their own prefix. Taking "the newest N files" instead
  // silently mixes in the main recording and drops a camera from the tally — a report that looks
  // complete and is not (Law 25: the reader would act differently on the true list).
  const files = perCameraFiles();
  const missing = CAMS.filter(c => !files[c]);
  const reaped = reapTriggerRecording();
  narrate(missing.length ? 'warn' : 'summary', 'camera_obs',
    `stopped · ${CAMS.filter(c => files[c]).map(c => `${c} ${(files[c].bytes / 1048576).toFixed(1)}MB`).join(' · ') || 'no per-camera files'}` +
    (missing.length ? ` · NO FILE FOR: ${missing.join(', ')}` : '') +
    (reaped ? ` · trigger by-product deleted (${reaped})` : ''));
}

// THE TRIGGER RECORDING IS A SWITCH, NOT A TAKE — so it is deleted the moment it has finished switching.
//
// Every Source Record filter runs in `Recording` mode, which means each one follows OBS's OWN recording
// state; that is what makes a single StartRecord produce N per-camera files instead of needing N calls.
// The cost of that mechanism is that OBS's main output must actually run, and a running output writes a
// file. Nothing reads it: it is a low-bitrate composite of a scene whose sources are all being captured
// individually at full quality. It is the exhaust of the trigger, not an angle anyone chose.
//
// DELETED RATHER THAN PREVENTED, and the alternative is named because it is the obvious one to retry:
// Source Record's `Virtual Camera` mode (5) driven by StartVirtualCam would remove the output entirely.
// It is not a drop-in — the Windows virtual-camera DEVICE is registered by the OBS installer and this is
// a portable OBS, so the device may simply not exist here, and a filming run that cannot start is a far
// worse failure than a file. Prove the device registers before reaching for it; until then the mechanism
// stays and its exhaust gets reaped.
//
// Law 8: this unit starts the output, so this unit clears what the output left. Law 9 is intact — the
// files written by this module are the profile INI and the session roster, neither of which is here.
function reapTriggerRecording() {
  let freed = 0, n = 0;
  try {
    for (const name of fs.readdirSync(TRIGGER_DIR)) {
      const file = path.join(TRIGGER_DIR, name);
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      freed += st.size; n++;
      fs.unlinkSync(file);
    }
  } catch (e) {
    // An environmental failure, and a soft one by definition: the deliverables are already safe on disk
    // and a file left behind costs disk, never correctness. Warned rather than thrown so a locked handle
    // cannot turn a successful take into a failed stop (Law 13 — this is the world's fault, not a bug).
    narrate('warn', 'camera_obs', `could not clear the trigger by-product (${e.message}) — delete ${TRIGGER_DIR} by hand.`);
    return null;
  }
  return n ? `${n} file(s), ${(freed / 1048576).toFixed(1)}MB` : null;
}

// cam → its newest own file. Source Record names each file with the camera prefix we set in
// filename_formatting, so the prefix is the ownership link between a file on disk and the camera
// that produced it — the only per-camera evidence available, since GetRecordStatus reports one
// aggregate output and never names a path.
// Which cameras have actually written bytes since `before` was taken. A file that exists but is
// still 0 bytes does not count — existence is the filter being wired, bytes are it working.
function growingCameras(before) {
  const now = perCameraFiles();
  return CAMS.filter(cam => {
    const a = now[cam];
    if (!a || a.bytes === 0) return false;
    const b = before[cam];
    return !b || a.name !== b.name || a.bytes > b.bytes;
  });
}

function perCameraFiles() {
  const all = footageFiles();
  const map = {};
  for (const cam of CAMS) {
    const mine = all.filter(f => f.name.startsWith(`${cam}_`)).sort((a, b) => b.mtime - a.mtime);
    if (mine.length) map[cam] = mine[0];
  }
  return map;
}

function footageFiles() {
  if (!fs.existsSync(FOOTAGE_DIR)) return [];
  return fs.readdirSync(FOOTAGE_DIR)
    .filter(f => !f.startsWith('.'))
    .map(name => {
      const st = fs.statSync(path.join(FOOTAGE_DIR, name));
      return { name, bytes: st.size, mtime: st.mtimeMs };
    });
}

async function status() {
  if (!obsRunning()) { narrate('summary', 'camera_obs', 'OBS is not running.'); return; }
  const obs = await connectWithRetry(10000);
  const s = await obs.request('GetRecordStatus');
  const { inputs } = await obs.request('GetInputList');

  // THE HOST SEAT'S AUDIO IS READ BACK OFF OBS, never restated from what this file asked for. Four
  // separate facts have to hold for a presenter's voice to reach his file — the mic unmuted, the mic
  // on the track, the host window on the track, and the filter told to read the track — and every one
  // of them fails silently. Asserting them at `up` and then REPORTING them from the config would be
  // the value-used-to-check and the value-used-to-act being the same value (Law 23: sense it).
  let voice = null;
  const hostCam = CAMS.find(c => c === HOST_CAM);
  if (hostCam) {
    const mute = await obs.tryRequest('GetInputMute', { inputName: MIC_INPUT });
    const micTracks = await obs.tryRequest('GetInputAudioTracks', { inputName: MIC_INPUT });
    const hostTracks = await obs.tryRequest('GetInputAudioTracks', { inputName: hostCam });
    const filter = await obs.tryRequest('GetSourceFilter', { sourceName: hostCam, filterName: CFG.obs.filterName });
    const fs_ = (filter && filter.filterSettings) || {};
    const onTrack = t => !!(t && t.inputAudioTracks && t.inputAudioTracks[String(MIC_TRACK)]);
    const ok = mute && !mute.inputMuted && onTrack(micTracks) && onTrack(hostTracks)
      && fs_.different_audio === true && Number(fs_.audio_track) === MIC_TRACK;
    voice = `${hostCam} voice ${ok ? 'WIRED' : 'BROKEN'} · mic ${mute ? (mute.inputMuted ? 'MUTED' : 'live') : 'absent'}` +
      ` · mic→t${MIC_TRACK} ${onTrack(micTracks) ? 'yes' : 'NO'} · window→t${MIC_TRACK} ${onTrack(hostTracks) ? 'yes' : 'NO'}` +
      ` · filter reads t${fs_.audio_track ?? '—'} ${fs_.different_audio === true ? '(armed)' : '(NOT armed — different_audio is off, so the track is inert)'}`;
  }
  obs.close();
  const present = CAMS.filter(c => inputs.some(i => i.inputName === c));
  const files = perCameraFiles();
  narrate(voice && /BROKEN/.test(voice) ? 'warn' : 'summary', 'camera_obs',
    `recording=${s.outputActive} timecode=${s.outputTimecode} · sources ${present.length}/${CAMS.length} · ` +
    CAMS.map(c => `${c} ${files[c] ? (files[c].bytes / 1048576).toFixed(1) + 'MB' : '—'}`).join(' · ') +
    (voice ? `\n           ${voice}` : ''));
}

// Law 8: the recording is stopped BEFORE OBS is asked to quit, so no encoder is ever killed
// mid-file. A hard quit on a live recording is how a run ends with an unplayable container.
async function down() {
  clearSessionRoster();   // Law 8: the roster `up` raised dies with the session that raised it
  if (!obsRunning()) { narrate('summary', 'camera_obs', 'OBS already down.'); return; }
  try {
    const obs = await connectWithRetry(10000);
    const s = await obs.request('GetRecordStatus');
    if (s.outputActive) { await obs.request('StopRecord'); await sleep(2000); }
    obs.close();
  } catch (e) {
    narrate('warn', 'camera_obs', `could not stop recording cleanly (${e.message}) — quitting anyway.`);
  }
  // Give OBS a real chance to exit ON ITS OWN, polling instead of sleeping a fixed 4s. A force-kill
  // is not a neutral fallback here: it leaves the .sentinel behind, and the NEXT start then stalls
  // on the safe-mode dialog forever. The cheap fix for that stall is to not cause it — so the kill
  // is a last resort after 20s, and it is reported rather than silently taken.
  // taskkill (no /F) not CloseMainWindow(): OBS runs --minimize-to-tray, so it has NO main window
  // and CloseMainWindow() silently does nothing — every shutdown then hit the force path. taskkill
  // posts WM_CLOSE to the process regardless of whether a window is showing.
  const killScript =
    'taskkill /IM obs64.exe | Out-Null ; ' +
    '$n=0; while ($n -lt 20 -and (Get-Process obs64 -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1; $n++ } ; ' +
    'if (Get-Process obs64 -ErrorAction SilentlyContinue) { Get-Process obs64 | Stop-Process -Force; "FORCED" } else { "CLEAN" }';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', killScript], { encoding: 'utf8' });
  const forced = /FORCED/.test(r.stdout || '');

  // SUMMARY, not warn, when the force path is taken after a confirmed stop — and the level is the
  // interface, so getting this right matters more than how loud it feels (Law 5). OBS routinely
  // ignores WM_CLOSE here; chasing a graceful exit cost a round and did not get one. It is also not
  // a degraded outcome: StopRecord has already closed and finalised every file (verified on disk
  // above), hybrid_mp4 survives an unclean process death by design, and `up` clears the sentinel
  // the kill leaves. Emitting a warn on every single teardown would be warn-spam that trains the
  // reader to skip the one that eventually matters.
  // The real failure — the recording could NOT be stopped first — is warned about where it happens,
  // in the catch above, which is the only case where a kill loses anything.
  narrate('summary', 'camera_obs',
    forced ? 'OBS down (force-quit after a confirmed stop — its files are closed; sentinel clears on next `up`).'
           : 'OBS down (clean exit).');
}

// ── miccheck: THE ONE THING NO COMMAND RETURN CAN PROVE ──────────────────────────────────────
//
// A microphone that is present, unmuted, correctly routed and reported healthy by every call in this
// file can still be recording digital silence — a virtual endpoint Windows handed OBS as "default", a
// muted device at the OS level, an unplugged headset. Nothing upstream of the file on disk can tell,
// and the discovery comes after the episode. That exact failure has already been shipped here once:
// every take filmed before 2026-08-20 carries an AAC track measuring -91.0 dB mean AND max — a real
// stream containing nothing, indistinguishable from a quiet one until something tries to use it.
//
// So this records a short take and MEASURES THE FILE, which is the only evidence that answers the
// question (Law 25 — the verdict is the sensed result, not the absence of an error). -91.0 dB is the
// signature of digital silence, not of a quiet room: a live microphone in a silent room still carries
// a noise floor well above it. The verdict is therefore stated against that line and not against a
// judgement about loudness, which is the presenter's to make.
//
// It DELETES the file it measured. A miccheck take is an instrument reading, not footage, and leaving
// it in `footage/` would fold a test clip into the next wrap as though it were an angle somebody shot.
const MICCHECK_SECONDS = 8;
const SILENCE_DB = -90;

function resolveFfmpeg() {
  // A hand-dropped tools/ffmpeg/bin first, so a machine that already has one is not made to re-download;
  // then `ffmpeg-static` in any of this machine's module homes — it puts a real binary inside node_modules,
  // the one install method that works on a box where nothing may be installed at the root. The homes are
  // the bot's one resolver's answer (Law 16), so no machine's folder names are written here. Resolved here
  // rather than imported from Cutting_room: the dependency runs one way — the editor reads the bot.
  const candidates = [
    path.join(PROJECT_ROOT, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ...require(paths.bot('js_kernel/utils/node_module_homes')).moduleHomes()
      .map(home => path.join(home, 'ffmpeg-static', 'ffmpeg.exe')),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function micCheck() {
  if (!HOST_ON) {
    // Default stopped, and named rather than assumed away: without a host seat there is no file that
    // is supposed to carry a voice, so a "pass" here would be a verdict about nothing.
    throw new Error('miccheck needs the host seat — nothing else in a take carries a microphone. ' +
      'Run it as: camera_obs.ps1 miccheck --host=on   (with the host window open and OBS up).');
  }
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error('no ffmpeg to measure with. Install it into the module tree with:\n' +
      '  cd Auren_Bot; .\\scripts\\npm.ps1 install');
  }

  const obs = await connectWithRetry(15000);
  const pre = await obs.request('GetRecordStatus');
  if (pre.outputActive) {
    obs.close();
    throw new Error('OBS is already recording — a miccheck would cut into a live take. Measure before ' +
      '`start`, or read the take itself.');
  }
  const before = perCameraFiles();
  narrate('summary', 'camera_obs', `miccheck: recording ${MICCHECK_SECONDS}s — SPEAK NOW, at your normal presenting volume.`);
  await obs.request('StartRecord');
  await sleep(MICCHECK_SECONDS * 1000);
  await obs.request('StopRecord');
  await sleep(2500);
  obs.close();

  const now = perCameraFiles();
  const file = now[HOST_CAM];
  if (!file || (before[HOST_CAM] && before[HOST_CAM].name === file.name)) {
    narrate('error', 'camera_obs', `miccheck: the host seat wrote NO file. Its window is unbound — open ` +
      `${HOST_CAM} and re-run \`up --host=on\` before measuring.`);
    return;
  }
  const full = path.join(FOOTAGE_DIR, file.name);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', full, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(text);
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(text);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(text);

  // Measured, then reaped: the reading is the product, the clip is not.
  try { fs.unlinkSync(full); } catch (e) { /* left behind is a disk cost, never a wrong verdict */ }

  if (!hasAudio || !mean) {
    narrate('error', 'camera_obs', `miccheck: ${HOST_CAM}'s file carries NO AUDIO STREAM AT ALL — the ` +
      `recording filter is not reading track ${MIC_TRACK}. Re-run \`up --host=on\`, which asserts both ` +
      `\`different_audio\` and the track.`);
    return;
  }
  const meanDb = parseFloat(mean[1]);
  const maxDb = max ? parseFloat(max[1]) : meanDb;
  if (maxDb <= SILENCE_DB) {
    narrate('error', 'camera_obs', `miccheck: DIGITAL SILENCE — mean ${meanDb} dB, max ${maxDb} dB on ` +
      `track ${MIC_TRACK}. The take would have a real audio stream containing nothing. The device OBS ` +
      `has is not hearing you: name the right one in camera_configure's \`host.micDevice\` (this box ` +
      `carries several VIRTUAL microphones that answer as devices and emit silence), then re-run \`up\`.`);
    return;
  }
  narrate('summary', 'camera_obs', `miccheck: track ${MIC_TRACK} is LIVE — mean ${meanDb} dB, peak ${maxDb} dB ` +
    `over ${MICCHECK_SECONDS}s. The voice reaches ${HOST_CAM}'s file. (This says the signal arrives; whether ` +
    `the level is right for the episode is yours to judge.)`);
}

// Diagnostic only — it decides nothing. Prints the setting keys OBS itself declares for the two
// object kinds this file creates, so a schema change is READ off the running machine rather than
// guessed at from documentation that may not match the installed build (Law 23).
async function probe() {
  const obs = await connectWithRetry(15000);

  // The filter KIND id is the plugin's internal name, not its display name, and nothing guarantees
  // it matches the dll filename — asking OBS for the list is the only way to know it for the build
  // actually installed (Law 23: sense it, don't assume it).
  const kinds = await obs.tryRequest('GetSourceFilterKindList');
  console.log('\n=== GetSourceFilterKindList ===\n', JSON.stringify(kinds, null, 2));

  const d = await obs.tryRequest('GetInputDefaultSettings', { inputKind: 'window_capture' });
  console.log('\n=== GetInputDefaultSettings(window_capture) ===\n', JSON.stringify(d, null, 2));

  for (const k of (kinds && kinds.sourceFilterKinds || []).filter(k => /record/i.test(k))) {
    const f = await obs.tryRequest('GetSourceFilterDefaultSettings', { filterKind: k });
    console.log(`\n=== GetSourceFilterDefaultSettings(${k}) ===\n`, JSON.stringify(f, null, 2));
  }
  const { inputs } = await obs.request('GetInputList');
  if (inputs.length) {
    const list = await obs.tryRequest('GetInputPropertiesListPropertyItems',
      { inputName: inputs[0].inputName, propertyName: 'window' });
    console.log(`\n=== capturable windows (via ${inputs[0].inputName}) ===`);
    if (list) for (const i of list.propertyItems) console.log('  ', i.itemValue);
  } else {
    console.log('\n(no inputs yet — run `up` first to enumerate capturable windows)');
  }
  obs.close();
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────
const COMMANDS = { configure, up, start: startRecording, stop: stopRecording, status, down, probe, miccheck: micCheck };

// Which verbs need the roster `up` recorded. `configure` and `up` are TOLD the set (they are where it
// is decided); these three only ever inherit it. Adopting in one place, before dispatch, keeps a
// single resolution pathway rather than three copies (Law 16).
// `miccheck` is in the set because it asks a question about the SESSION's host seat, and the session
// is where the camera set was decided. Without adopting it, a miccheck run against a live crew would
// measure the config's idea of the roster rather than the one `up` actually bound.
const ROSTER_CONSUMERS = new Set(['start', 'stop', 'status', 'miccheck']);

(async () => {
  if (ROSTER_CONSUMERS.has(command)) adoptSessionRoster();
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`camera_obs: unknown command "${command}". One of: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(1);
  }
  try {
    await fn();
    process.exit(0);
  } catch (e) {
    narrate('error', 'camera_obs', `${command} failed — ${e.message}`);
    process.exit(1);
  }
})();
