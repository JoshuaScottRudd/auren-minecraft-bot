// Auren_Workshop/tools/camera_warden.js
// THE CAMERA WARDEN — a camera per bot on a run where the bots do not exist yet.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────────
// Every filming route in this system was built for a crew whose size is known before the world starts:
// `-Count N`, N windows, one director, one `up`, one `start`. A CONTRACTOR run inverts that. The world
// comes up with zero bots on purpose — the thing under test is the desk — and a person standing in the
// game says `foreman get`, at which point two bodies come into being that nothing had heard of a minute
// earlier. A camera per bot then has to be raisable DURING the take, or the only run type a let's play
// is actually made of is the one run type that cannot be filmed.
//
//   Architect 2026-09-06: *"because i use contractors through foreman i want starting bots to also
//   start their spectator cameras… then ill call foreman get and get 2 bots, they start up and with
//   their start also starts cameras that are recording."*
//
// ── IT WATCHES THE WORLD, NOT THE LAUNCHER ──────────────────────────────────────────────────────────
// The obvious wiring is a hook in `foreman get`, or in `fleet_control botStart`, firing a camera launch
// beside each bot launch. It is the wrong joint twice over. First, `bot-start` RETURNS WHEN THE PROCESS
// IS LAUNCHED — a body enters the overseer's registry only after it connects, spawns and master_core
// initialises, seconds later — so a camera raised on the launcher's return is a camera aimed at a bot
// that is not in the world yet. That is the exact defect the foreman's own crew loop was rebuilt to fix
// (Law 26: the launcher's fact and the world's fact are different facts). Second, it would put the film
// crew inside the fleet's own pathway: the foreman would have to know cameras exist, and a run's
// behaviour would depend on whether it was being filmed — which is the one thing filming must never do
// (Law 19, and the camera runbook's opening rule: the film crew observes, it does not act).
//
// So the warden SENSES instead. It asks the overseer's registry who is standing, every few seconds, and
// gives a camera to anyone who has none. That covers `foreman get`, a hand `bot-start`, a revive, and
// anything not yet written, because none of them is what it is watching (Invariant B — re-sense the
// world, never track it from remembered events).
//
// ── ATTACH ONLY. A CAMERA IS NEVER TAKEN DOWN MID-TAKE, AND THAT IS A CHOICE ────────────────────────
// A dismissed contractor leaves the registry, and its camera goes on filming an empty spectator vantage
// until the take ends. That costs disk and nothing else. Reaping it would mean removing a live OBS
// source and killing a client whose Source Record filter is mid-file, and a file no muxer closed is the
// expensive failure this whole stack is arranged to avoid — expensive because it is only discovered
// after the episode. The whole crew comes down together, in order, at teardown, where the recording is
// stopped BEFORE any window disappears (record_overlay's reap). Law 8 is satisfied there, by the owner
// that raised the run, rather than here in pieces.
// The registry is also the right sensor for this specifically: it holds CONNECTION, not life, so a bot
// that merely DIED is still in it and keeps its camera. Only a bot that genuinely left drops out.
//
// ── WHAT IT DOES PER ATTACH, AND WHY EACH STEP IS THE OWNER'S ───────────────────────────────────────
//   start_cameras.ps1 -Bots <every standing bot> -Add    build + launch the missing clients, then
//                                                        restart the director and titler over all of them
//   camera_obs.ps1 up   --bots=<the same set>            create + bind the new captures and their filters
//   camera_obs.ps1 start                                 (record only) prove every file is really writing
// Not one line of that is implemented here. This file holds the TRIGGER and the ORDER and nothing else;
// every step is a call to the unit that already owns it (Law 16). The order is the same order a cold
// filmed run uses and it is not negotiable — a capture bound before its window exists records black and
// reports a clean start.
//
// THE MID-TAKE ATTACH WORKS, AND IT WAS MEASURED RATHER THAN ASSUMED (2026-09-06). A Source Record
// filter CREATED 7 SECONDS AFTER StartRecord began writing immediately: 3.1 MB on disk 14s later while
// the already-running capture kept growing untouched. Had that come back the other way this whole design
// would have needed OBS's recording stopped and restarted for every contractor, splitting the
// presenter's own file every time he hired somebody.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────────────────────────────
// A ceiling on cameras, because this raises GAME CLIENTS and nothing else in the loop is counting. Four
// windows at an unpinned framerate held this box's GPU at 98% flat for five minutes (measured
// 2026-08-16, which is why every camera is now pinned to 60 fps). The bound is stated and reported
// rather than silent: past it the warden says which bots it is NOT filming and keeps going, because a
// run that stops filming is better than a run whose machine stalls, and both are better than a warden
// that quietly films some bots and never says which (Law 25).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('../workshop_paths');
const TOOLS_DIR = __dirname;
const BOT_DIR = paths.BOT_ROOT;
const REPO_ROOT = paths.REPO_ROOT;
// The scripts are the ARCHITECT'S one-button starts and they live in the workshop, never in the shipped
// bot — so this one path crosses back to this side of the split while the rest reach across it.
const SCRIPTS = paths.workshop('scripts');
const KERNEL = paths.bot('js_kernel');

// THE FLEET'S OWN DOOR CLIENT, borrowed rather than re-spelled — the same borrow tools/foreman_probe
// makes, and for the same reason: the one fact this file needs is which bots the overseer has
// REGISTERED, and a second socket client written here would be a parallel route to it that drifts the
// day the envelope changes (Law 16). It is used to OBSERVE and never to command; the warden issues no
// verb to any bot, which is what keeps the film crew out of the fleet's pathways (Law 19).
// The aliases are registered because the door is written for a process that has them.
paths.registerAliases();
const door = require(path.join(BOT_DIR, 'foreman', 'overseer_door.js'));

// How often the registry is asked. Six seconds is well under how long a body takes to join (the
// foreman allows ninety), so a contractor is filmed within a few seconds of standing up, and the cost
// of asking is one short-lived socket to a process on this machine.
const POLL_MS = 6000;
// The ceiling, and it counts GAME CLIENTS rather than bots: the host seat and the Architect's eye are
// windows on the same GPU. See the header for the measurement behind it.
const DEFAULT_MAX_CAMERAS = 6;
// A raise takes tens of seconds (an instance build, a Minecraft launch, a director restart). The poll
// is suspended across one rather than run concurrently — two converging launches over one crew is two
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

// The one attach pass. Converges the whole crew rather than adding one name, because -Add and `up` are
// both convergent and a converging call is its own repair path — a client that died in between is
// relaunched by the same pass that adds the new one (Invariant B).
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

  const obsArgs = [`--bots=${all.join(',')}`, `--host=${HOST_ON ? 'on' : 'off'}`, `--architect=${ARCHITECT_ON ? 'on' : 'off'}`];
  if (!runScript('camera_obs.ps1', ['up', ...obsArgs], 'OBS up (bind the new capture and its filter)')) {
    say('✗ OBS would not bind the new window(s).');
    return false;
  }

  // RECORD ONLY, and this is the step that makes the attach true rather than likely. `start` against an
  // already-recording OBS skips StartRecord and verifies that every camera in the session is putting
  // real bytes on disk — which for a mid-take attach is the only moment the new file can be proved.
  if (OVERLAY === 'record') {
    if (!runScript('camera_obs.ps1', ['start', ...obsArgs], 'prove every camera is writing')) {
      say('✗ a camera is not writing — read the line above for which. The rest of the take is unaffected.');
      return false;
    }
  }
  say(`${added.join(' and ')} now filmed. ${all.length} bot camera(s) up.`);
  return true;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Generous, and the ceiling is a real failure rather than a delay: a converge that never finished
// leaves the new camera unbound, and saying so is what lets the operator act during the take instead of
// finding a black file afterwards.
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
  say(`up. Watching the overseer's registry every ${POLL_MS / 1000}s for bots with no camera.`);
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

    // ATTACHED OR NOT, THE NAME IS RECORDED — which is why the result is not branched on. A failed
    // converge left un-recorded would be retried every six seconds for the rest of the run, relaunching
    // Prism and restarting the director each time: a repair loop with no judge, which is the shape
    // Law 27 names, and it would do more damage than the missing camera. The failure is already stated
    // out loud where it happened; the operator decides whether to act, and the repair path is the same
    // convergent call by hand — `start_cameras.ps1 -Bots … -Add` then `camera_obs.ps1 up`.
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
