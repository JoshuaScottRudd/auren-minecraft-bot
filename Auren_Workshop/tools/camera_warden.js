// Auren_Workshop/tools/camera_warden.js
// THE CAMERA WARDEN — a camera per bot on a run where the bots do not exist yet.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────────
// Every other filming route is built for a crew whose size is known before the world starts. A
// CONTRACTOR run inverts that: the world comes up with zero bots, and a hire in game can bring bodies
// into being that nothing had heard of a minute earlier. A camera per bot has to be raisable DURING the
// take, or a let's-play run is the one run type that cannot be filmed.
//
// ── IT WATCHES THE WORLD, NOT THE LAUNCHER ──────────────────────────────────────────────────────────
// A hook in `foreman get` or `fleet_control botStart` is the wrong joint twice over. First, `bot-start`
// returns when the PROCESS is launched — a body enters the foreman's registry only after it connects,
// spawns and master_core initialises, seconds later — so a camera raised on the launcher's return aims
// at a bot not yet in the world (Law 26: the launcher's fact and the world's fact are different facts).
// Second, it would put the film crew inside the fleet's own pathway, making a run's behaviour depend on
// whether it is being filmed (Law 19 — the film crew observes, it does not act).
//
// So the warden SENSES instead: it asks the foreman's registry who is standing, every few seconds, and
// gives a camera to anyone who has none. That covers `foreman get`, a hand `bot-start`, a revive, and
// anything not yet written, since none of them is what it is watching (Invariant B — re-sense the
// world, never track it from remembered events).
//
// ── ATTACH ONLY. A CAMERA IS NEVER TAKEN DOWN MID-TAKE ────────────────────────────────────────────────
// A dismissed contractor leaves the registry, and its camera keeps filming an empty spectator vantage
// until the take ends, costing disk and nothing else. Reaping it would mean removing a live OBS source
// and killing a client whose Source Record filter is mid-file — a file no muxer closed is the expensive
// failure this whole stack exists to avoid. The whole crew comes down together, in order, at teardown,
// where recording stops before any window disappears (record_overlay's reap; Law 8).
// The registry holds CONNECTION, not life, so a bot that merely died is still in it and keeps its
// camera; only a bot that genuinely left drops out.
//
// ── WHAT IT DOES PER ATTACH, AND WHY EACH STEP IS THE OWNER'S ───────────────────────────────────────
//   start_cameras.ps1 -Bots <every standing bot> -Add    build + launch the missing clients, then
//                                                        restart the director and titler over all of them
//   recorder.bindLate   --bots=<the same set>            (record only) bind the new captures and prove every
//                                                        file is really writing — the recorder is the
//                                                        operator's, reached through workstation.findRecorder
// Not one line of that is implemented here: this file holds the TRIGGER and the ORDER, and every step
// is a call to the unit that already owns it (Law 16). The order matches a cold filmed run and is not
// negotiable — a capture bound before its window exists records black and reports a clean start.
//
// THE MID-TAKE ATTACH IS MEASURED: a Source Record filter created after StartRecord began wrote
// immediately, alongside the already-running capture, so a running recording does not need to be
// stopped and restarted for a new contractor.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────────────────────────────
// A ceiling on cameras, since this raises GAME CLIENTS and nothing else in the loop is counting — an
// unpinned framerate across several windows can hold a GPU flat (every camera is pinned to 60 fps for
// this). Past the ceiling the warden reports which bots it is NOT filming and keeps going: a run that
// stops filming is better than a run whose machine stalls, and both are better than a warden that
// quietly films some bots and never says which (Law 25).

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/camera_warden.js');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('../workshop_paths');
const TOOLS_DIR = __dirname;
const BOT_DIR = paths.BOT_ROOT;
const REPO_ROOT = paths.REPO_ROOT;
// The scripts are the operator's one-button starts and they live in the workshop, never in the shipped
// bot — so this one path crosses back to this side of the split while the rest reach across it.
const SCRIPTS = paths.workshop('scripts');
const KERNEL = paths.bot('js_kernel');

// THE FLEET'S OWN DOOR CLIENT, borrowed, not re-spelled — the same borrow tools/foreman_probe makes,
// for the same reason: a second socket client here would be a parallel route to which bots the foreman
// has REGISTERED, and the two would drift (Law 16). It only OBSERVES; the warden issues no verb to any
// bot, keeping the film crew out of the fleet's pathways (Law 19).
// Aliases are registered because the door is written for a process that has them.
paths.registerAliases();
const door = require(path.join(BOT_DIR, 'foreman', 'foreman_door.js'));

// How often the registry is asked. Six seconds is well under how long a body takes to join (the
// foreman allows ninety), so a contractor is filmed within a few seconds of standing up, and the cost
// of asking is one short-lived socket to a process on this machine.
const POLL_MS = 6000;
// The ceiling counts GAME CLIENTS, not bots: the host seat and the operator's eye are windows on the
// same GPU too.
const DEFAULT_MAX_CAMERAS = 6;
// A raise takes tens of seconds (an instance build, a Minecraft launch, a director restart). The poll
// suspends across one instead of running concurrently: two converging launches over one crew are two
// owners of one set (Invariant D), and the second would restart the director the first just raised.

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const onOff = (name) => /^(on|true|1|yes)$/i.test(String(opt(name, 'off')));

const OVERLAY = opt('overlay', 'watch');          // 'record' | 'watch' — decides only whether files are proved
const HOST_ON = onOff('host');
const ARCHITECT_ON = onOff('architect');
const MAX_CAMERAS = parseInt(opt('max-cameras', String(DEFAULT_MAX_CAMERAS)), 10);
// Bots already filmed when the warden was raised — a run that started with a standing crew. The warden
// must not re-launch a client that is already up, and -Add would find it running anyway; seeding is
// what keeps the first pass from being a needless full converge.
const SEED = String(opt('seeded', '')).split(',').map(s => s.trim()).filter(Boolean);

// The recorder, on a recorded run only. record_overlay refuses `record` on a machine without one before the
// warden is ever raised, so a missing one here is a warden started by hand — refused by name, never run as
// a watch that believes it is recording (Law 13).
const RECORDER = (() => {
  if (OVERLAY !== 'record') return null;
  const file = require(path.join(BOT_DIR, 'js_kernel', 'utils', 'workstation.js')).findRecorder();
  if (!file) throw new Error("camera_warden: --overlay=record needs a recorder and this machine has none. Use --overlay=watch.");
  return require(file);
})();

const PID_FILE = path.join(KERNEL, 'camera_warden.json');
const CREW_READY_FILE = path.join(KERNEL, 'camera_rig_ready.json');

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (m) => console.log(`${stamp()} WARDEN  ${m}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function runScript(name, args, label) {
  say(`→ ${label}`);
  console.log(`           ${name} ${args.join(' ')}`);
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(SCRIPTS, name), ...args],
    { stdio: 'inherit', cwd: REPO_ROOT });
  const code = r.status === null ? 1 : r.status;
  say(`  ${label} → exit ${code}`);
  return code === 0;
}

// How many windows this run has standing, counting the seats that are not bots. The ceiling is about
// the GPU, and the GPU does not care which of them a director is driving.
function windowsFor(botCount) {
  return botCount + (HOST_ON ? 1 : 0) + (ARCHITECT_ON ? 1 : 0);
}

// Ask the world who is standing. A registry that cannot be reached is NOT an empty registry — reading
// it as one would have the warden conclude every bot had left and then re-attach the whole crew on the
// next successful poll. Unreachable is its own answer and this pass simply does nothing (Law 23).
async function standingBots() {
  const state = await door.query();
  if (!state.ok) return { ok: false, error: state.error };
  return { ok: true, ids: state.bots.map(b => b.id).filter(Boolean) };
}

// The one attach pass. Converges the whole crew instead of adding one name: -Add and `up` are both
// convergent, so a converging call is its own repair path — a client that died in between is relaunched
// by the same pass that adds the new one (Invariant B).
async function attach(all, added) {
  say(`${added.join(' and ')} ${added.length === 1 ? 'is' : 'are'} standing and ${added.length === 1 ? 'has' : 'have'} no camera — raising ${added.length === 1 ? 'one' : added.length}.`);

  // Cleared before the launch and waited on after it, exactly as a cold raise does: the file left by the
  // previous converge describes clients that were already standing, so an uncleared one answers the wait
  // instantly and the new window is declared present before it has finished loading.
  try { if (fs.existsSync(CREW_READY_FILE)) fs.unlinkSync(CREW_READY_FILE); } catch (e) { /* nothing to clear */ }

  const camArgs = ['-Bots', all.join(','), '-Add', '-Framing',
    ...(HOST_ON ? ['-HostSeat'] : []), ...(ARCHITECT_ON ? ['-Architect'] : [])];
  if (!runScript('start_cameras.ps1', camArgs, `camera crew converge on ${all.join(', ')}`)) {
    say(`✗ the camera crew did not converge — ${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} NOT being filmed.`);
    return false;
  }

  // The rig publishes only when every client it expects is confirmed standing in the world. Waiting on
  // it is what stops the bind below from happening against a window that is still on a loading screen —
  // a capture bound there renders a loading screen and reports a clean start.
  if (!(await waitForCrew(windowsFor(all.length)))) {
    say('✗ the crew never finished joining — binding anyway would capture loading screens. Not bound.');
    return false;
  }

  // RECORD ONLY. A watched run has nothing to bind: the new window is up and the director is cutting to
  // it, which is the whole of watching. On a recorded run the recorder binds the new capture and proves
  // every file is putting real bytes on disk — the only moment a mid-take attach can be proved.
  if (RECORDER) {
    const obsArgs = [`--bots=${all.join(',')}`, `--host=${HOST_ON ? 'on' : 'off'}`, `--architect=${ARCHITECT_ON ? 'on' : 'off'}`];
    if (!RECORDER.bindLate(obsArgs)) {
      say('✗ the new camera is not recording — read the lines above for which step. The rest of the take is unaffected.');
      return false;
    }
  }
  say(`${added.join(' and ')} now filmed. ${all.length} bot camera(s) up.`);
  return true;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Generous, and the ceiling is a real failure, not a delay: a converge that never finished leaves the
// new camera unbound, and saying so lets the operator act during the take instead of finding a black
// file afterwards.
const CREW_READY_TIMEOUT_MS = 240000;
async function waitForCrew(expected) {
  const deadline = Date.now() + CREW_READY_TIMEOUT_MS;
  say(`waiting for ${expected} client(s) to finish loading and join the world`);
  let announced = 0;
  for (;;) {
    const r = readJson(CREW_READY_FILE);
    if (r && r.ready) { say(`crew standing: ${(r.cams || []).join(', ')}`); return true; }
    if (Date.now() >= deadline) return false;
    const waited = Math.round((CREW_READY_TIMEOUT_MS - (deadline - Date.now())) / 1000);
    if (waited >= announced + 15) { announced = waited; say(`still loading… ${waited}s`); }
    await sleep(2000);
  }
}

async function main() {
  if (!['record', 'watch'].includes(OVERLAY)) {
    // Default stopped: an unrecognised overlay would silently skip the growth proof and film a take
    // nobody verified.
    throw new Error(`camera_warden: --overlay must be 'record' or 'watch', not '${OVERLAY}'.`);
  }
  fs.mkdirSync(KERNEL, { recursive: true });
  // Law 6: a background process states what it is and how to find it. Written here and deleted by this
  // same process on the way out — record_overlay reaps by command line, never by trusting this file,
  // because a process killed hard leaves it behind.
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid, overlay: OVERLAY, host: HOST_ON, architect: ARCHITECT_ON,
      max_cameras: MAX_CAMERAS, raised_at: Date.now(),
    }, null, 2));
  } catch (e) { say(`⚠ could not record my own pid (${e.message}) — teardown still finds me by command line.`); }

  const filmed = new Set(SEED);
  say(`up. Watching the foreman's registry every ${POLL_MS / 1000}s for bots with no camera.`);
  say(`overlay '${OVERLAY}'${HOST_ON ? ', host seat on' : ''}${ARCHITECT_ON ? ", Architect's eye on" : ''}` +
    `, ceiling ${MAX_CAMERAS} window(s).` +
    (filmed.size ? ` Already filmed: ${[...filmed].join(', ')}.` : ' No crew yet — say "foreman get" in game.'));

  let refusedAnnounced = new Set();
  for (;;) {
    await sleep(POLL_MS);
    const seen = await standingBots();
    if (!seen.ok) continue;                       // unreachable is not empty — see standingBots

    const missing = seen.ids.filter(id => !filmed.has(id));
    if (!missing.length) continue;

    // The ceiling is applied to the WINDOW count, not the bot count, and the refusal names the bots it
    // is dropping. Announced once each: repeating it every six seconds for the rest of a two-hour take
    // would bury everything else the warden says.
    const room = Math.max(0, MAX_CAMERAS - windowsFor(filmed.size));
    const take = missing.slice(0, room);
    const refused = missing.slice(room);
    for (const id of refused) {
      if (refusedAnnounced.has(id)) continue;
      refusedAnnounced.add(id);
      say(`⚠ ceiling reached (${MAX_CAMERAS} windows) — ${id} is working and is NOT being filmed. ` +
        `Raise --max-cameras if this box has the headroom.`);
    }
    if (!take.length) continue;

    // ATTACHED OR NOT, THE NAME IS RECORDED: a failed converge left un-recorded would retry every six
    // seconds for the rest of the run, relaunching Prism and restarting the director each time — a
    // repair loop with no judge (Law 27), doing more damage than the missing camera. The repair path is
    // the same convergent call by hand.
    await attach([...filmed, ...take], take);
    for (const id of take) filmed.add(id);
  }
}

if (require.main === module) {
  const bye = () => {
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  main().catch(e => {
    console.error(`${stamp()} WARDEN  ✗ ${e.message}`);
    try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e2) { /* already gone */ }
    process.exit(1);
  });
}

module.exports = { PID_FILE, POLL_MS, DEFAULT_MAX_CAMERAS };
