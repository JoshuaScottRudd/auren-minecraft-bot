// Auren_Workshop/camera/camera_rig.js
// Event-driven spectator camera director — a read-only observer OUTSIDE the construct (same
// citizenship as trace_monitor: no signal bus, no fragment, decides nothing in any SPA loop;
// Law 19 — it films the shared world, never acts in it). Design: camera_system_plan.md v2,
// validated against a real run in camera_shot_profile_05_Jul_26.md. Every knob lives in
// camera_configure.js — this file hardcodes no framing number.
//
// THE LAW OF THIS FILE: the camera always AIMS AT THE BOT. Pre-staging on a spot and guessing when the bot
// would walk into frame (and how long it'd stay) was too fiddly — the camera kept staring at empty coords.
// The OBJECTIVE (the bot's latest locomotion destination) never sets the aim; it picks the shot SIZE and,
// for a travel leg, WHERE THE CAMERA STANDS (at the destination, so the bot walks into the lens).
// Aim height is LOW (aimRise ≈ the bot's feet) so the shot tilts down onto the bot rather than over its head.
//
// Every shot resolves through ONE solver (solveView — Law 16, it replaced the old per-case recipes and the
// bot→pool→dolly ladder). It is a SEEKER, not a blind grid: it first SENSES where the open sightlines are —
// castVisibilityField fires rays OUTWARD from the bot and reports the clear distance in each direction — then
// places camera candidates AT those real openings, scores them, and confirms the best few with the 117-ray cone.
// Candidates come from proven openings, so it never dead-ends on "no clear candidate"; it ALWAYS returns a shot
// (worst case the most-open direction), failing only if the bot is sealed in rock. Score prefers a good subject
// SIZE (near preferredDist), a gentle DOWN-angle, the APPROACH side, more open room, and the 30-degree rule.
//
// AIM IS NO LONGER FROZEN (2026-07-21). Position is still locked at the cut, but the aim belongs to
// camera_gimbal.js: a headless client parked at the camera position that the Prism camera /spectate's, so its
// head rotation IS the shot's aim and is interpolated to render framerate. The shot still reads as STATIC —
// the gimbal holds perfectly still inside a generous dead zone and only rescues the frame when the bot is
// about to leave it, then SNAPS on the next cut (a cut must read as a cut, never a swing). Consequences worth
// knowing before editing: with a gimbal live the frame-exit ANGLE test is skipped (measuring the bot against
// the cut-time aim would report "left frame" for a bot the gimbal is holding, and every report is a cut), and
// a TRAVEL shot is framed around the DESTINATION and held unbroken until arrival.
//
// The old model, kept because a successor will otherwise reinvent it: position and aim were BOTH frozen at the
// cut, so a traversing bot walked out of frame and the rig needed frameExitDeg/exitGraceMs/a 10s reposition to
// keep rebuilding the shot. That machinery is what continuous aim deletes.
//
// The director HUNTS mid-hold — it re-seeks ~1×/s and CUTS when a materially better, ≥30°-different vantage
// appears (betterShot / seek.*), suppressed during a travel shot so the journey stays one unbroken take. It
// also RE-TESTS OCCLUSION every hold.occlusionCheckMs, because the cone runs once at the cut and a 30s hold
// outlives its verdict — a bot that walks behind a tree must end the shot, not sit invisible in it.
// A camera moves at most once per minHold (5s).
//
// "Cone" is the anti-canopy core (camera_scout.coneClear): a 117-ray FRUSTUM sized to the real frame, not one
// line, so a subject crowded by leaves scores low even when its centre line is open. Two things it cannot do
// alone, hence the air box and the visual-blocker list: it validates a single bearing (useless for a rotating
// gimbal) and it rides on raycasts, which pass straight through sugar cane and tall grass.
//
// THE ENCLOSED (SEE-THROUGH) SHOT IS A SECOND CAMERA, not a setting of this one. A spectator renders through
// rock, so underground nothing occludes, there is no canopy to duck, and a bot in a tunnel moves slowly: the
// whole apparatus above — cone, air box, camera plane, gimbal — measures or avoids things that are not there,
// and the plane in particular costs a mine shaft its ONLY sightline (the vertical one). So an enclosed shot
// takes none of it: a fixed distance at a gentle rise, frozen aim, cut when the bot leaves frame. Enclosure is
// two signals, either sufficient — depth, or a mining job whose sightline search came back walled on every
// bearing. See camera_configure's SEE-THROUGH section for why the depth test alone was not enough.
//
// Collaborators: Watcher story files (the objective = the goTo destination; navigator cost = leg length)
// · camera_scout.js (the cone raycast + smooth bot positions) · Prism spectators (cameras, RCON tp).
//
// Diagnostics: BOT_ID=camera_rig routes every decision to fleet_logs/traces/watcher_camera_rig.jsonl — the
// CAMERA's own trace, parallel to the fleet's and deliberately not merged into it (monitoring/trace_read
// splits the two views; monitoring/camera_lens is this file's reader). Every decision is written twice on
// purpose, in two registers: a prose summary for a person scrolling, and a `crew_log` event for the lens.
// Warns on launcher/scout/drought.

'use strict';

const paths = require('../workshop_paths');
// NODE_PATH and the aliases before ANYTHING from the bot: `module-alias` is third-party and lives in
// whichever node_modules this machine has, and `crew_log` requires `@kernel/watcher` on its own.
paths.registerAliases();

process.env.BOT_ID = process.env.BOT_ID || 'camera_rig';   // must precede the watcher require
const watcher = require(paths.bot('js_kernel/watcher.js'));

// ── THE CAMERA REPORTS IN THE FLEET'S GRAMMAR, NOT A SECOND ONE ────────────────────────────────────
// `crew_log` is the form the combat seats already state facts in — `VERB key=value`, one renderer, one
// parser, both ends importing the same module. Nothing in it is about combat: it is a machine-readable
// form for a decision, and a director choosing a vantage is a decision. A camera-only grammar would be a
// second copy of the same contract that drifts the first time either is edited (Law 16, Law 26).
//
// The prose narration below it is NOT redundant with this and neither replaces the other: the sentence is
// for the person scrolling the trace, the event is for `monitoring/camera_lens`. They are two renderings
// of one decision, which the WHY-only rule tolerates exactly where one of the readers is a machine — the
// alternative is a lens parsing English, which is the joint Law 26 forbids.
//
const crewLog = require(paths.bot('custom_api/crew_log.js'));
const CFG = require('./camera_configure.js');
const { SERVER_ENDPOINT, SERVER_MINECRAFT_VERSION } = require(paths.bot('Thinking_fragments/architect_config.js'));
const { createScout } = require('./camera_scout.js');
const { createGimbals } = require('./camera_gimbal.js');
const { createWitness } = require('./combat_witness.js');

const fs = require('fs');
const path = require('path');

// Blocks a raycast passes through but a viewer cannot see past (sugar cane, tall grass, ferns, vines).
// A Set because it is tested per cell along every checked line. See camera_configure's OCCLUSION notes.
const VISUAL_BLOCKERS = new Set(CFG.frame.visualBlockers || []);

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const { BOT_SENIORITY } = require(paths.bot('Thinking_fragments/architect_config.js'));
// AN EMPTY --bots IS A LEGITIMATE ANSWER, NOT AN ABSENT ONE, and the two used to arrive as the same
// string. A contractor run comes up with no crew at all — the bots are hired in chat later — so the
// launcher has to be able to say "no bot cameras" as distinct from "you were not told, use the whole
// roster". `''.split(',')` yields `['']`: one entry naming a bot called nothing, and this rig would
// then have polled `data get entity Cam_ Pos` once a second for the length of the run and never
// published a ready crew, because a camera that does not exist never arms. Filtering after the split
// is what makes the empty answer a real one.
const BOTS = opt('bots', Object.keys(BOT_SENIORITY).join(',')).split(',').map(s => s.trim()).filter(Boolean);
const CAMS = opt('cams', BOTS.map(b => `Cam_${b}`).join(',')).split(',').map(s => s.trim()).filter(Boolean);
const LAUNCH_LOG_DIR = opt('launchlogs', '').replace(/^['"]|['"]$/g, '');
if (CAMS.length !== BOTS.length) {
  console.error('camera_rig: --cams must list one camera name per bot.');
  process.exit(1);
}

// ── FREE CAMERAS: armed once, commanded never ────────────────────────────────────────────────
// A camera in this list gets the same two RCON lines a bot camera gets (spectator + night vision) and
// then nothing, ever — it is deliberately absent from `rigs`, so no cut, no teleport and no gimbal
// bind can reach it. A human flies it.
//
// THE SEPARATION IS THE POINT AND IT IS STRUCTURAL. Arming and directing are two different jobs that
// happened to share a loop; a free camera splits them. Keeping the arming here rather than in the
// launcher preserves one owner for "make a client into a camera" (Law 16) — the alternative was a
// second RCON caller sending the identical pair of commands from PowerShell.
const FREE_CAMS = opt('freecams', '').split(',').map(s => s.trim()).filter(Boolean);

// ── PRESENT-ONLY CLIENTS: confirmed standing, never touched ──────────────────────────────────
// A third list, and it exists because the HOST SEAT — the client a human PLAYS on a let's play — must
// be neither directed nor armed. `--bots` is the shot list; `--freecams` arms a client to spectator,
// night vision and operator. A presenter must be none of those: he mines, builds, dies and hires a
// crew, and a seat flipped to spectator can do none of it.
//
// IT CARRIES IN-WORLD PLAYER NAMES, AND THE OTHER TWO LISTS CARRY WINDOW NAMES THAT HAPPEN TO MATCH.
// Every camera joins under its own instance name, so for those two lists the distinction never
// surfaces. The host does not: its window is `host.camName` and it joins as `host.playerName`. The
// only question asked of a name here is `data get entity <name> Pos`, which the server answers for a
// logged-in PLAYER and for nothing else — so a window name put on this list asks about an entity that
// cannot exist and is never confirmed. The failure is silent and total: the seat stands in the world
// while this rig never publishes a ready crew, the overlay waits out its whole ceiling, and OBS is
// never reached, so a run that looked healthy end to end recorded nothing. The flag is named
// `--presentplayers` rather than `--present` for exactly that reason (Law 7 — the name is what stops
// the next reader handing it the wrong string).
//
// So why is it passed to the rig at all? Because of the ONE thing this rig owns that nothing else can
// answer: whether a client has actually finished joining the world. `data get entity <name> Pos` is
// answered by the server only for a client that has completed its join, and this file is the only
// thing in the stack holding an RCON connection to ask it. The overlay waits on the published crew
// before it lets OBS bind anything — and a capture bound to a window still on a loading screen renders
// a loading screen and reports a clean start. Leaving the host out of that gate would mean the one
// window carrying the presenter and his microphone is the one window nobody proved was ready.
//
// CONFIRMED, NOT ARMED, and the separation is expressed as a list rather than as a branch inside the
// arming loop for the same reason FREE_CAMS is a separate list from `rigs`: a name that is never passed
// to the thing that commands cannot be commanded by a later edit (Law 27 — the property is what the
// list IS, not a rule something has to keep honouring). The only RCON this list ever produces is the
// read that asks whether the client is there.
const PRESENT_PLAYERS = opt('presentplayers', '').split(',').map(s => s.trim()).filter(Boolean);

// ── FRAMING AS A LAUNCH INPUT ────────────────────────────────────────────────────────────────
// mode.framing defaults OFF (Law 13) and a run that wants the film crew says so at launch. This is an
// input authored while the machine is stopped, which is the legal half of Law 26's state rule — the
// alternative was an automated run editing camera_configure.js on its way past, i.e. a generator
// writing an internal of a system it is about to start.
// Absent → the config decides, unchanged. `--framing=off` forces it off over a config that says true,
// so the override is symmetric and a caller can state either intent rather than only the loud one.
const FRAMING_ARG = opt('framing', null);

function narrate(level, stage, message) {
  const icon = level === 'warn' ? '⚠️ ' : level === 'error' ? '❌ ' : '';
  console.log(`${icon}[${stage.toUpperCase()}] ${message}`);
  watcher[level](stage, message);
}

// ── RCON ─────────────────────────────────────────────────────────────────────────────────────
// The protocol lived HERE (a persistent session this file did not export) until 2026-07-31, alongside a
// second copy in tools/rcon_cmd. The arena director needed a third, so all three now share
// js_kernel/utils/rcon_link (Law 16 — one capability, one implementation). The session shape is unchanged: same
// resolve-on-auth, same onDown callback the link/relink loop below already handles.
const { readServerProperties, open: rconConnect } = require(paths.bot('js_kernel/utils/rcon_link'));

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────
const dist3d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = p => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
const shortAngle = a => ((a + 180) % 360 + 360) % 360 - 180;

// aimAt: yaw/pitch (numbers, degrees) looking from cam toward target. MC: yaw 0 faces +Z, +pitch down.
function aimAt(cam, target) {
  const lx = target.x - cam.x, ly = target.y - cam.y, lz = target.z - cam.z;
  const len = Math.hypot(lx, ly, lz) || 1;
  return { yaw: -Math.atan2(lx, lz) * 180 / Math.PI, pitch: -Math.asin(ly / len) * 180 / Math.PI };
}
// The low aim point a bot shot targets (aimRise above the feet — see camera_configure: it tilts the shot
// DOWN so the bot isn't clipped at the bottom), and the target of the hold's frame-exit test. One rise,
// shared, so the frozen aim and the exit-test agree on where the subject is.
const subjAim = p => ({ x: p.x, y: p.y + CFG.frame.bot.aimRise, z: p.z });

// aimOffset: how far (degrees) a point sits off the frozen aim — the frame-exit test.
function aimOffset(aim, camPos, point) {
  const want = aimAt(camPos, point);
  return Math.hypot(shortAngle(want.yaw - aim.yaw), want.pitch - aim.pitch);
}

// ── Geometry for the seeker ────────────────────────────────────────────────────────────────────
const dir2d = az => ({ x: Math.sin(az), z: Math.cos(az) });             // azimuth (rad) → horizontal unit
const dot2d = (a, b) => a.x * b.x + a.z * b.z;
const norm2d = v => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };
const angDiffDeg = (a, b) => Math.abs(shortAngle(a - b));               // 0..180
// ── solveView: the SEEKER ───────────────────────────────────────────────────────────────────────
// Frames the bot. It SENSES first — castVisibilityField fires rays OUTWARD from the bot and reports how far
// until a block in each direction (azimuth × elevation) — then places camera candidates ALONG the open
// directions (at the clear distance, capped to preferredDist), scores them, and confirms the best few with
// the 117-ray cone. Candidates come from real openings, so the outward ray already proves the camera→bot line
// clear (the cone only grades the RING around the bot for leaf-crowding). It never dead-ends on a blind grid:
// if every direction is cramped it takes the MOST-open one; it only truly fails if the bot is sealed in rock.
// It does NOT score. Survivors are ordered by a strict priority — FARTHEST first, then HIGHEST to break that
// tie, then the approach side to break what is left — and confirmed by a BINARY cone: every ray clear, or the
// candidate is rejected. The first to pass wins, because the ordering already said which is preferable.
// Only when NOTHING passes does a fraction get consulted, and then only to rank the failures.
// And when no direction offers even `minUsable` blocks, it stops placing a lens at all and returns the
// FIRST-PERSON framing — the camera spectates the bot itself. See firstPersonShot for why that is a
// different answer rather than a worse one.
// opts: { preferredDist, maxRange, approachDir, lastBearingDeg, underground, miningJob, label }.
// Returns { cam, aim, subjectAt, kind, bearingDeg, coneScore, room, note, search, rays }.
//
// ASYNC because the two ray calls are (camera_scout's header has the why: a synchronous ray loop deafens
// the client's own packet handlers, and that client is also the combat witness). Nothing about the solve
// itself became concurrent — it is the same sequence with yields in it. The blind branches above still
// return without awaiting anything, so a scout-less rig pays no scheduling cost at all.
async function solveView(subject, sc, opts) {
  const W = CFG.frame.weights, F = CFG.frame.field, B = CFG.frame.bot;
  const pref = opts.preferredDist;
  const aimPt = { x: subject.x, y: subject.y + B.aimRise, z: subject.z };
  // THE CAMERA LADDER. `camHeight` is the height of the BOTTOM rung — bot eye level — and the elevation
  // rungs climb from there: a candidate on rung θ stands at eyePt.y + usable·sin(θ).
  //
  // IT WAS A SINGLE PLANE, AND THE REASON IT STOPPED BEING ONE IS NOT A REVERSAL. The rule was "never above
  // eye level" (Architect, 2026-07-21: "i just never have any good expierience with high cameras… any
  // elevation always includes canopies"), and that is a PROXY: it bans height because height USUALLY means
  // canopy. The binary gate below measures that directly instead of assuming it — a raised camera now has
  // to prove an unobstructed frame, and if it can, the objection to it was never about the height. So height
  // becomes a PREFERENCE (Architect, later: "the bot should prefer higher so you see more") and the proxy
  // retires, having been replaced by the measurement it stood in for. It is a preference and not the ruling
  // key — see FARTHEST, THEN HIGHEST below for why that ordering is the thing that keeps the old rule's
  // intent while dropping its bluntness. The ceiling still encodes the taste: `field.elevs` tops out where
  // a shot stops reading as a camera and starts reading as a map.
  //
  // THE PLANE ALSO DESCRIBED AN INTENT AND NOT THE FOOTAGE, until sendCam started converting: `tp` places a
  // player by its feet and the picture comes from its eye, so the lens really sat at bot feet + 3.12 —
  // above the bot's head, tilted down, filming precisely the canopy the rule was written to avoid.
  // The search is run FROM this height, not from the aim point: casting at one height and then placing the
  // lens at another would measure clearance the camera never gets. With elevs = [0] the ray is horizontal,
  // so cam.y comes out exactly here and the height needs no separate clamp.
  // THIS IS THE LENS, not the camera entity's feet. Every candidate `cam` below is therefore a lens
  // position and every test in this function speaks that unit; sendCam is the single place that converts
  // to feet for the teleport, and the note there has why that was not always true.
  const eyePt = { x: subject.x, y: subject.y + CFG.frame.camHeight, z: subject.z };
  // CAST ONE MARGIN PAST THE SHOT CEILING, not to it. `usable` is clearDist − margin, so a field bounded at
  // exactly `pref` could never yield a `pref`-block shot — the furthest possible camera would land a margin
  // short of the ceiling and the top of the range would be unreachable by construction. "Rays bounded to 7"
  // means "no camera further than 7"; this is what makes 7 actually attainable.
  const maxRange = (opts.maxRange || pref) + F.margin;
  // ── THE SEEK'S OWN FACTS, CARRIED OUT ON THE FRAMING ──────────────────────────────────────────
  // `note` and `search` below are sentences for a human reading the trace. This is the same seek stated
  // as fields, for `monitoring/camera_lens` — and it is built HERE rather than reconstructed by the
  // caller because half of it (which pre-filter rejected how many, whether the 30-degree rule relaxed,
  // how many cones were actually cast) exists only inside this function and is thrown away on return.
  // Every branch below sets `verdict` before it returns; a framing that reaches the rig with a null
  // verdict is a return path somebody added without recording what it decided.
  const sweep = { verdict: null, fieldMs: null, fieldRays: 0, roomy: 0,
                  airRejects: 0, lensRejects: 0, relaxed: false, maxRange };
  const mk = (cam, bearingDeg, room, coneScore, note, search, rays) => ({
    cam, aim: aimAt(cam, aimPt), subjectAt: { x: subject.x, y: subject.y, z: subject.z },
    kind: opts.label, bearingDeg, room, coneScore, note, search, rays, sweep });

  // Blind bearing when we can't sense: aim from the approach side (bot walks in), else off the last bearing.
  const blindAz = opts.approachDir ? Math.atan2(opts.approachDir.x, opts.approachDir.z)
                                   : ((opts.lastBearingDeg || 0) + 90) * Math.PI / 180;
  const blindShot = (dist, note, search) => {
    const d = dir2d(blindAz);
    const cam = { x: subject.x + d.x * dist, y: eyePt.y, z: subject.z + d.z * dist };   // blind shot: same camera plane
    sweep.verdict = 'blind';
    return mk(cam, blindAz * 180 / Math.PI, dist, null, note, search, 0);
  };

  // THE SEE-THROUGH SHOT. A spectator renders through rock, so enclosed there is nothing to test and nothing
  // to duck: the cone measures nothing, and the camera PLANE — which exists solely to get under a canopy —
  // costs the only sightline a shaft has. So this ignores both and restores the pre-seeker tripod: a fixed
  // distance at a gentle rise, aimed down at the bot. `seeThrough` travels on the framing because the CUT
  // must also detach the gimbal (see camera_configure's SEE-THROUGH section — the Architect wants no
  // interpolation down there, and a frozen aim plus a frame-exit cut is enough at tunnel speed).
  const seeThroughShot = (why) => {
    const E = CFG.frame.enclosed;
    const d = dir2d(blindAz);
    const cam = { x: subject.x + d.x * E.distance, y: subject.y + E.rise, z: subject.z + d.z * E.distance };
    const f = mk(cam, blindAz * 180 / Math.PI, E.distance, 1, `see-through d${E.distance} h${E.rise}`, why, 0);
    sweep.verdict = 'see_through';
    // NO CONE IS RUN HERE, AND RUNNING ONE WOULD BE A FALSEHOOD, NOT A MEASUREMENT. The cone counts
    // BLOCK OCCUPANCY along each ray; a spectator client renders THROUGH solid blocks, so underground
    // every ray reports "blocked" while the picture is perfectly clear. A score emitted here would be a
    // well-formed number that means the opposite of what a reader would take it for (Law 26 — a
    // guarantee is deleted when the thing it measures is not the thing that happens).
    // What IS recorded is the evidence for the branch itself, so "was it really enclosed" stays
    // answerable: the subject's depth against `undergroundY`, which is the entire test.
    sweep.subject = true;   // it is seen through the rock — that is the premise of this branch
    sweep.depth = Math.round(subject.y);
    f.seeThrough = true;
    return f;
  };

  // THE FIRST-PERSON SHOT. Not a camera placement at all — the camera client /spectate's the BOT, so the
  // picture is the bot's own eyes, its own head movement, its own hands.
  //
  // WHY IT REPLACES A PLACEMENT RATHER THAN JOINING THE POOL. Every other branch here answers "where should
  // the lens stand"; this one is what you say when the honest answer is NOWHERE. Below `minUsable` there is
  // no vantage to rank — the fallback that used to run here took the most-open direction and jammed the
  // lens a block or two from the subject in a space that had already been measured as too tight, which is
  // a shot of a wall with a bot pressed against it. First person is the only framing a 1-block corridor
  // actually has (Architect: "if no candidtates closer than 2 blocks then just go first person instead").
  //
  // IT CARRIES NO GIMBAL AND NO OCCLUSION TESTS, and both fall out of what it is rather than being
  // exceptions bolted on: the aim is the bot's own head, so there is nothing to point; and the subject is
  // the viewpoint, so it cannot be occluded from itself. `cam` is set to the bot's eye anyway — nothing
  // teleports there, but the CUT line and the same-shot test both read it, and a framing that lies about
  // where it is filming from would make both of those unreadable.
  const firstPersonShot = (why) => {
    const cam = { x: subject.x, y: subject.y + CFG.frame.camHeight, z: subject.z };
    const f = mk(cam, opts.lastBearingDeg || 0, 0, 1, 'first person — no room for a camera', why, 0);
    sweep.verdict = 'first_person';
    f.firstPerson = true;
    return f;
  };

  // THE CALLER MAY DEMAND FIRST PERSON, and this is the only way it may get one: routed through the same
  // branch every other first-person shot comes from, so there is exactly one construction of that framing
  // (Law 16). The thrash guard is the caller — see `hold.thrashWindowMs` in camera_configure.
  if (opts.forceFirstPerson) return firstPersonShot(opts.forceFirstPerson);
  if (opts.underground) return seeThroughShot('underground — no raycast, no gimbal');
  if (!sc) return blindShot(Math.min(pref * 1.4, maxRange), 'blind (no scout)', 'no scout — blind');

  const tField = Date.now();
  const field = await sc.castVisibilityField(eyePt, { azSteps: F.azSteps, elevs: F.elevs, maxRange });
  sweep.fieldMs = Date.now() - tField;
  sweep.fieldRays = field.known && field.rays ? field.rays.length : 0;
  let rays = field.known ? F.azSteps * F.elevs.length : 0;
  if (!field.known || !field.rays.length) return blindShot(pref, 'blind (field not ready)', 'field unknown — chunk streaming');

  const LB = CFG.frame.lensBox || { half: 1, from: 2, to: 5 };
  // Which rung a ray belongs to. F.elevs is ascending, so the index IS the height ranking — and comparing
  // by INDEX rather than by degrees means the ladder can be re-spaced in config without the comparator
  // acquiring an opinion about how far apart the rungs should be.
  const rungOf = elevDeg => { const i = F.elevs.indexOf(elevDeg); return i < 0 ? 0 : i; };
  // ── THE ONLY SEEK: RANK THE RAYS, TAKE THE FIRST THAT CLEARS THE BOXES ────────────────────────
  // There is no candidate list and no cone gate any more; see camera_configure's ONE SEEKER block for the
  // measurement that removed them. What is left is the ray field itself, ordered, and the first direction
  // whose lens cell survives the two block tests.
  //
  // `roomyDirs` is counted SEPARATELY and BEFORE anything is rejected, because it answers a different
  // question than the seek does: "no candidates" and "no ROOM" are different failures with different right
  // answers. A field where six directions offer seven blocks but every one of them is leafy still wants a
  // camera, just a compromised one. A field where nothing anywhere offers `minUsable` wants no camera at
  // all, and that is what first person is for.
  let roomyDirs = 0;
  for (const r of field.rays) if (Math.min(pref, r.clearDist - F.margin) >= F.minUsable) roomyDirs++;
  sweep.roomy = roomyDirs;

  // A MINING JOB OUTRANKS BOTH FALLBACKS, and it is checked first (Architect: "mining should never be that
  // way because underground is see through"). The reasoning that briefly put first person ahead of it was
  // that a shaft too tight for a lens is too tight for a tripod either — which is true of ROCK and
  // irrelevant to a SPECTATOR, because a spectator renders through it. There is no such thing as a camera
  // position underground that "cannot fit": the wall is not in the picture. So the starved-field question
  // down here is not "where is there room" at all, and first person would be answering a question nobody
  // asked while throwing away the only framing a shaft has.
  if (opts.miningJob && !roomyDirs) {
    return seeThroughShot(`enclosed: mining job + no room in any dir — treated as rock`);
  }

  // NO ROOM ANYWHERE — not "no good spot", no SPACE. Above ground that is what first person is for; the
  // seek below would otherwise jam the lens a block from the subject in a space already measured as too
  // tight, which is a shot of a wall with a bot pressed against it.
  if (!roomyDirs) return firstPersonShot(`no direction offers ${F.minUsable}b of ${field.rays.length} rays`);

  // FURTHEST, THEN LOWEST. Distance is the primary key: reach is the only thing here measured in the same
  // units as the complaint (a cramped shot fills the frame with whatever is doing the cramping), and height
  // and distance are not independent — a raised rung is normally the one that runs into something soonest,
  // so ranking by height first systematically prefers the CRAMPED candidate.
  //
  // The rung breaks the tie LOWEST-FIRST, and that is canopy geometry rather than taste: leaves sit above a
  // bot, so every degree of rise puts more of them between lens and subject and forces the lens to look
  // down through the layer it just climbed into. The bottom rung is `camHeight` — the bot's own eye height —
  // so the low shot is a level one, never a worm's-eye one.
  //
  // REACH IS BUCKETED TO THE HALF BLOCK for the same reason the deleted comparator did it: raw floats let
  // 7.00 beat 6.98 on noise, and an open field pins every rung to the same reach, so an exact comparison
  // would leave the rung deciding only between rays that tied to the last decimal.
  const bucket = u => Math.round(u * 2) / 2;
  let ordered = [...field.rays].sort((a, b) =>
    (bucket(b.clearDist) - bucket(a.clearDist)) || (rungOf(a.elev) - rungOf(b.elev)));

  // THE 30-DEGREE RULE IS A GATE, NOT A BONUS (Architect, 2026-07-21: "the angle difference between shots
  // needs to be at minimum 30… its only moving a few blocks after a cut"). It survives the deletion of the
  // ranked path because it was never part of it — it constrains the BEARING between consecutive shots, and
  // consecutive shots exist on any seeker. Relaxes rather than fails: a bot boxed into one open corridor
  // has no other bearing to offer, and SAYS SO in the sweep line, because a silently-relaxed rule is how
  // this rotted into a soft bonus the first time.
  let bearingRelaxed = false;
  if (opts.lastBearingDeg != null) {
    const differing = ordered.filter(r => angDiffDeg(r.az, opts.lastBearingDeg) >= W.minBearingChangeDeg);
    if (differing.length) ordered = differing; else bearingRelaxed = true;
    sweep.relaxed = bearingRelaxed;
  }

  // Walk the order and take the first direction the lens can actually stand in. The two block tests are the
  // same pair the deleted path used as a pre-filter, and they are the whole of the quality bar now:
  //   · THE AIR BOX — a small ball ON the lens. Guarantees the clearance a ROTATING gimbal needs on every
  //     bearing it may pan toward, not just this one, and rejects the wedged-in-canopy pocket.
  //   · THE LENS BOX — a clear tube straight ahead over the near field, where a single leaf fills the frame
  //     and the (retired) subject-anchored cone was at its narrowest.
  // `margin` is what makes this loop able to succeed at all: it must exceed `airBox`, or the block that
  // stopped the ray sits inside the ball and every distance-limited direction fails here. See the margin
  // note in camera_configure — that off-by-one is what starved the deleted path.
  const setback = ray => Math.max(B.minFramedDist, Math.min(pref, ray.clearDist - F.margin));
  const lensAt = (ray, u) => ({ x: eyePt.x + ray.dir.x * u, y: eyePt.y + ray.dir.y * u, z: eyePt.z + ray.dir.z * u });
  let airRejects = 0, frontRejects = 0;
  let chosen = null;
  for (const ray of ordered) {
    const u = setback(ray);
    const cam = lensAt(ray, u);
    if (F.airBox > 0 && !sc.airClear({ x: Math.floor(cam.x), y: Math.floor(cam.y), z: Math.floor(cam.z) },
                                     F.airBox, VISUAL_BLOCKERS)) { airRejects++; continue; }
    if (LB.half > 0 && !sc.frontClear(cam, aimPt,
                                      { half: LB.half, from: LB.from, to: LB.to, blockers: VISUAL_BLOCKERS })) {
      frontRejects++; continue;
    }
    chosen = { ray, cam, usable: u };
    break;
  }
  sweep.airRejects = airRejects; sweep.lensRejects = frontRejects;

  // NOTHING CLEARED THE BOXES — take the furthest-reaching direction anyway. This rig must always return a
  // shot, so the honest move is to place the lens where the world is most open and RECORD that nothing
  // passed, rather than to relax a test until something does (Law 25 — meeting a criterion by loosening it
  // is the criterion being usurped).
  const forced = !chosen;
  if (forced) { const ray = ordered[0]; chosen = { ray, cam: lensAt(ray, setback(ray)), usable: setback(ray) }; }
  sweep.verdict = forced ? 'forced' : 'clear';

  // ONE RAY, AND IT DECIDES NOTHING — it RECORDS. `centerClear` is whether the lens can see the bot at all,
  // and it is the fact the record was missing when a frame-purity score was mistaken for shot quality. It
  // runs after the choice rather than before it so it cannot quietly become a gate: a siting that cannot
  // see its subject still returns, and the trace says so.
  const seen = await sc.coneClear(chosen.cam, aimPt, { gridH: 1, gridV: 1, visualBlockers: VISUAL_BLOCKERS });
  rays += 1;
  sweep.subject = seen.known ? !!seen.centerClear : null;
  sweep.blockedBy = seen.known && !seen.centerClear ? (seen.blockedBy || null) : null;
  sweep.el = Math.round(chosen.ray.elev || 0);
  sweep.usable = Math.round(chosen.usable * 10) / 10;
  // `coneScore` is what betterShot ranks a mid-hold re-seek on, and with the gate gone it carries subject
  // visibility instead of frame purity: 1 seen, 0 hidden. That makes "swap to a vantage that can see the
  // bot" the only cleanliness improvement the motivated re-seek recognises, which is the one worth cutting
  // for. An UNKNOWN reading scores 1 so an unloaded chunk cannot make a standing shot look spoiled.
  const coneScore = sweep.subject === false ? 0 : 1;
  const bearingDeg = chosen.ray.az;    // castVisibilityField reports az in DEGREES already
  return mk(chosen.cam, bearingDeg, chosen.ray.clearDist, coneScore,
    `az${Math.round(bearingDeg)}° el${sweep.el}° d${chosen.usable.toFixed(1)} h${(chosen.cam.y - subject.y).toFixed(1)} ` +
    `(${forced ? 'FORCED — nothing cleared the boxes' : 'clear'}, ${chosen.ray.clearDist.toFixed(0)}b room` +
    `${sweep.subject === false ? `, SUBJECT HIDDEN behind ${sweep.blockedBy || 'terrain'}` : ''})`,
    // NOTE the arity: mk(cam, bearingDeg, room, coneScore, note, search, rays) — SEVEN. An eighth argument
    // (coneScore, passed again) used to sit before `rays`, so every trace line reported the score as its ray
    // count ("0.59 rays in 3ms") and the real cost of a solve was never recorded.
    `${roomyDirs} roomy dirs of ${field.rays.length} rays (rejected: airbox ${airRejects}, lensbox ${frontRejects})` +
    `${bearingRelaxed ? ' · 30° RELAXED' : ''} · ${forced ? 'none cleared' : 'cleared'}`, rays);
}

// Per-mode seeker params: how far the camera ideally sits and whether to prefer a HIGH angle (idle wide).
// Every mode is clamped to frame.maxShotDist: the bots are the subject, and the measured canopy failures were
// ALL long shots (every 20-block wide framed leaves; every good frame was 4.3–7 blocks). Scenery is a separate,
// deferred camera on a static subject — never a widened bot shot.
function modeParams(mode) {
  const Wd = CFG.frame.wide, O = CFG.frame.objective, W = CFG.frame.weights;
  const cap = CFG.frame.maxShotDist;
  const clamp = p => ({ ...p, preferredDist: Math.min(p.preferredDist, cap), maxRange: Math.min(p.maxRange, cap) });
  // `highAngle` is gone. It was the wide shot's INVERSION of the anti-top-down bias — a bias that no longer
  // exists, because every mode now prefers height and the binary gate decides whether it gets it. An idle
  // establishing shot and a working shot want the same thing from the ladder; distance is all they differ in.
  // maxRange is the mode's own preferred distance: solveView adds the margin, so the cast reaches exactly far
  // enough to make that distance attainable and no further (Architect: "so now we bound raycasts to 7 blocks").
  if (mode === 'wide')   return clamp({ preferredDist: Wd.distance, maxRange: Wd.distance });
  if (mode === 'travel') return clamp({ preferredDist: O.travelDistance, maxRange: O.travelDistance });
  return clamp({ preferredDist: W.preferredDist, maxRange: W.preferredDist });
}

// betterShot: is a freshly-seeked candidate worth CUTTING to, mid-hold? The Architect's rule — don't move on a
// timer, move when a materially better vantage appears. Two gates, both required: it must be a real CUT (bearing
// differs by the 30-degree rule, else it's the same shot nudged — jitter), AND it must EARN the cut, either by a
// cleaner frame (cone score up by seek.improve) or a more open one (seek.minRoomGain more blocks of room without
// going backwards on clarity). Everything short of that lets the current locked tripod keep holding.
function betterShot(cand, cur) {
  if (!cand || !cur) return false;
  const W = CFG.frame.weights, K = CFG.frame.seek;
  // FIRST PERSON YIELDS TO ANY REAL CAMERA, IMMEDIATELY AND WITHOUT ARGUING. It is the answer to "there is
  // nowhere to stand", and that is a fact about where the bot is standing right now, not about the shot —
  // one step out of the corridor and it is no longer true. Both gates below would fight that: the bearing
  // rule measures against a bearing first person does not really have (it carries the PREVIOUS shot's, so
  // the seeked candidate is compared to a vantage nobody is filming from), and `cleaner` cannot fire at all
  // because first person scores a perfectly honest 1.00 — it IS an unobstructed picture. So a shot that is
  // supposed to be a stopgap would outrank every replacement forever.
  //
  // The candidate must be a real one: first person re-solving to first person is the no-op cut, and the
  // suppression in cut() catches it, but not spending the cut is cheaper than suppressing it.
  if (cur.firstPerson) return !cand.firstPerson;
  if (angDiffDeg(cand.bearingDeg, cur.bearingDeg) < W.minBearingChangeDeg) return false;
  const cleaner = cand.coneScore >= cur.coneScore + K.improve;
  const roomier = cand.room >= cur.room + K.minRoomGain && cand.coneScore >= cur.coneScore;
  return cleaner || roomier;
}

// ── Launcher log digestion (Prism's console noise → explained warns in the rig's trace) ───────
const KNOWN_LAUNCHER_ISSUES = [
  {
    match: /An access error occurred/,
    explain: 'Qt file write blocked — another process held the file open mid-write (same EBUSY/EPERM '
      + 'class watcher._safeWrite dodges); a single-instance handoff writing the shared dir does it. '
      + 'Harmless to filming once the game window opened.',
  },
  {
    match: /Failed to launch|Could not launch|java.*not found/i,
    explain: 'The game itself failed to start — NOT harmless; that camera will never join the server.',
  },
];

class LauncherLog {
  constructor(dir) { this.dir = dir; this.offsets = new Map(); }
  poll() {
    if (!this.dir) return [];
    let files;
    try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.log')); }
    catch (_) { return []; }
    const out = [];
    for (const f of files) {
      try {
        const txt = fs.readFileSync(path.join(this.dir, f), 'utf8');
        const off = this.offsets.get(f) || 0;
        if (txt.length < off) this.offsets.set(f, 0);
        else if (txt.length > off) {
          this.offsets.set(f, txt.length);
          const lines = txt.slice(off).split(/\r?\n/).filter(l => / [CE]: /.test(l));
          if (lines.length) out.push({ file: f, lines });
        }
      } catch (_) { /* mid-write — next poll */ }
    }
    return out;
  }
}

function digestLauncherLogs(launcherLog) {
  for (const { file, lines } of launcherLog.poll()) {
    const groups = new Map();
    for (const l of lines) {
      const msg = l.replace(/^\s*[\d.]+ [CE]: /, '').replace(/ \(unknown:0\)\s*$/, '');
      groups.set(msg, (groups.get(msg) || 0) + 1);
    }
    for (const [msg, n] of groups) {
      const known = KNOWN_LAUNCHER_ISSUES.find(k => k.match.test(msg));
      const times = n > 1 ? ` ×${n}` : '';
      narrate('warn', 'launcher',
        `${file}: "${msg}"${times} — ${known ? known.explain
          : 'unrecognized launcher-critical. Usually harmless if the game window opened; if a camera never joins, this line is the lead.'}`);
    }
  }
}

// ── Event extraction: one Watcher story line → shot candidate / context, or null ─────────────
const PAREN = /\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/;
const xyz = m => m ? { x: +m[1], y: +m[2], z: +m[3] } : null;

function extractEvent(line) {
  const tag = line.match(/\[([A-Z][A-Z_]+)\]/);
  if (!tag) return null;
  const sys = tag[1];
  if (sys === 'OVERSEER_LINK' && line.includes('Online at')) {
    return { kind: 'cut', type: 'OPENING', at: xyz(line.match(PAREN)) };
  }
  if ((sys === 'SET_BUILDSPOT' && line.includes('build_center'))
      || ((sys === 'SET_BUILDSPOT' || sys === 'CORPORATE_HEADQUARTERS') && line.includes('uild center'))) {
    return { kind: 'cut', type: 'SITE', at: xyz(line.match(PAREN)) };
  }
  if (sys === 'LOCOMOTION_DISPATCHER' && line.includes('goTo')) {
    return { kind: 'journey', at: xyz(line.match(/goTo\s*\S*\s*\((-?\d+),(-?\d+),(-?\d+)\)/)) };
  }
  // NAVIGATOR reports the A* path cost for the current leg — how far the bot must walk to its objective.
  // The director uses it (vs. straight-line) to decide travel-shot vs. staged-objective (long legs travel).
  if (sys === 'NAVIGATOR') {
    const m = line.match(/cost\s+(\d+(?:\.\d+)?)/);
    if (m) return { kind: 'legcost', cost: +m[1] };
  }
  if (sys === 'TREE_FELLER' && line.includes('Claimed')) {
    return { kind: 'cut', type: 'PLACE:harvest', at: xyz(line.match(PAREN)) };
  }
  if (sys === 'MINING_MANAGER' && line.includes('Dispatching')) {
    return { kind: 'cut', type: 'PLACE:mining', at: xyz(line.match(PAREN)) };
  }
  if (sys === 'MINING_EXECUTOR' && line.includes('Segment') && !line.includes('pass:')) {
    return { kind: 'cut', type: 'PLACE:mining', at: xyz(line.match(/Segment (-?\d+)\|(-?\d+)\|(-?\d+)/)) };
  }
  if (sys === 'FURNACE_EXECUTOR') {
    return { kind: 'cut', type: 'PLACE:furnace', at: xyz(line.match(/furnace (-?\d+)\|(-?\d+)\|(-?\d+)/)) };
  }
  if (sys === 'CRAFT_HANDLER' && line.includes('crafting_table@')) {
    return { kind: 'cut', type: 'PLACE:craft', at: xyz(line.match(/crafting_table@\((-?\d+),(-?\d+),(-?\d+)\)/)) };
  }
  if (sys === 'DELIVERY_EXECUTOR' && line.includes('deliver')) {
    return { kind: 'cut', type: 'PLACE:delivery', at: xyz(line.match(/station (-?\d+)\|(-?\d+)\|(-?\d+)/)) };
  }
  if (sys === 'DISPATCHER') {
    const j = line.match(/Claimed (P\d+ \S+)/);
    if (j) return { kind: 'job', job: j[1] };
  }
  if (sys === 'JOB_BOARD' && PAREN.test(line)) {
    return { kind: 'beacon', at: xyz(line.match(PAREN)) };
  }
  return null;
}

// ── StoryTail: poll one bot's watcher_<Bot>.jsonl and yield new lines. A SHRINK = the bot restarted
//    → replay from the new story's top. Startup skips history. ─────────────────────────────────────
//
// The file is APPEND-ONLY as of 2026-08-12, which is what makes this poll safe: the only line a read
// can catch mid-write is the LAST one, and dropping it costs one poll's latency because the next poll
// sees it complete. Before that the file was rewritten whole through a rename, and this counted on the
// rename's atomicity for the same guarantee.
class StoryTail {
  constructor(bot) {
    this.bot = bot;
    this.file = require(paths.bot('js_kernel/utils/record_homes')).traceFile(bot);
    this.seen = null;
  }
  poll() {
    let story;
    try {
      const rows = fs.readFileSync(this.file, 'utf8').split('\n');
      story = [];
      for (const r of rows) {
        if (!r) continue;
        try { story.push(JSON.parse(r)); } catch (_) { /* torn tail — the next poll gets it whole */ }
      }
    } catch (_) { return []; }
    if (this.seen === null || story.length < this.seen) {
      const fresh = this.seen !== null;
      this.seen = fresh ? 0 : story.length;
      if (!fresh) return [];
    }
    const out = story.slice(this.seen);
    this.seen = story.length;
    return out;
  }
}

// ── Director ─────────────────────────────────────────────────────────────────────────────────
async function main() {
  watcher.resetRuntimeClock();

  // ── THE TWO SWITCHES (Architect 2026-08-09) ─────────────────────────────────────────────────────
  // FRAMING places and cuts cameras; WITNESS writes the server's account of the fleet's fights. They
  // share one scout client and one rcon link and are otherwise unrelated jobs. Both default off, so a
  // process launched with neither has nothing to do — and it says which key to flip and LEAVES rather
  // than sitting on an rcon link and a game slot doing nothing (Law 8).
  const FRAMING = FRAMING_ARG === null ? !!(CFG.mode && CFG.mode.framing) : FRAMING_ARG === 'on';
  const WITNESS = !!(CFG.mode && CFG.mode.witness);
  if (!FRAMING && !WITNESS) {
    narrate('warn', 'camera_rig',
      'both modes are OFF — nothing to do. Set mode.framing (place/cut cameras) and/or mode.witness ' +
      '(record combat) to true in camera/camera_configure.js, or launch with --framing=on, then ' +
      'start again.');
    watcher.flushNow();
    return;
  }

  let rcon = null;
  let linking = false;
  let announcedDown = false;

  // Which free cameras have already been made spectators. A Set rather than a re-probe each pass because
  // both effects are server-side and persistent — gamemode lives in playerdata and the night vision is
  // `infinite` — so a relog keeps them and a second arming would buy nothing but RCON traffic.
  const freeCamArmed = new Set();

  // Which present-only clients have been SEEN standing. Not "armed" — nothing is done to them — so the
  // Set records an observation rather than an effect, and it is kept for the same reason freeCamArmed is:
  // once the server has answered for a client, asking again every pass for the rest of a two-hour take
  // buys nothing but RCON traffic.
  const presentConfirmed = new Set();

  // Published once, when every expected client is confirmed in the world. See publishCrewReady().
  const READY_FILE = paths.bot('js_kernel', 'camera_rig_ready.json');
  let crewReadyPublished = false;

  // Floating names over every head are the one piece of UI that survives into the footage, and a
  // scoreboard team is the only server-side switch that turns them off. See hideNametags().
  const FILM_TEAM = 'auren_no_nametags';
  const FILM_TEAM_MAX_PASSES = 300;
  let filmTeamCreated = false;
  let filmTeamPasses = 0;

  let scout = null;
  let scoutArmed = false;
  let scoutAnchor = null;
  let scoutSettleUntil = 0;
  // BOTH modes need the eyes, for different questions — framing asks them where a lens can stand, the
  // witness asks them what happened. One client answers both (Law 16); scout.enable is the client's own
  // switch and still disables it for a deliberately blind framing run.
  if (CFG.scout.enable && (FRAMING || WITNESS)) {
    scout = createScout({
      host: SERVER_ENDPOINT.host, port: SERVER_ENDPOINT.port, version: SERVER_MINECRAFT_VERSION, username: CFG.scout.username,
      scanSliceMs: CFG.scout.scanSliceMs,
      // POSTED, NOT BUFFERED. These fire from the client's own socket callbacks, which are not inside
      // either of this file's passes — a buffered event would sit until some unrelated pass happened to
      // flush it, and land on the trace after decisions it actually preceded.
      onReady: () => {
        narrate('summary', 'scout', `${CFG.scout.username} connected — world access live, raycast sweep-search armed.`);
        crewLog.post('scout', 'link', { state: 'up' });
      },
      onEnd: (why) => {
        scoutArmed = false; scoutAnchor = null;
        narrate('warn', 'scout', `${CFG.scout.username} down (${why}) — raycast off, blind default framing until it returns.`);
        crewLog.post('scout', 'link', { state: 'down', why });
      },
      log: (lvl, msg) => narrate(lvl, 'scout', msg),
    });
    if (scout.available === false) {
      narrate('warn', 'scout', `mineflayer scout unavailable (${scout.reason}) — running without raycast (blind default framing).`);
      crewLog.post('scout', 'link', { state: 'absent', why: scout.reason });
      scout = null;
    }
  }
  const usableScout = () => (scout && scout.isReady() && Date.now() >= scoutSettleUntil) ? scout : null;

  // parkScoutOver: STEP ONE OF EVERY SOLVE — stand the eyes over the thing about to be scanned, then scan.
  //
  // A loaded chunk is a full column, bedrock to build height, so altitude is free and irrelevant to what
  // can be read; only the horizontal chunk decides that. Standing on the subject's own column is therefore
  // the cheapest possible guarantee that the seeker is casting through chunks that exist. camera_configure's
  // scout block has the two failures the old centroid park produced, both of which end in a BLIND shot —
  // and a blind shot is not a worse frame, it is no framing decision at all.
  //
  // IT WAITS BY READING, NOT BY CLOCK. A fixed settle would spend 2.5 s on every park whether or not the
  // chunks arrived, and — worse — would proceed after 2.5 s whether or not they did. So it asks the scout
  // for the subject's OWN cell and returns the moment that reads: the condition being waited on is the
  // condition being tested, rather than a stand-in for it (Law 23 — an unread cell is unknown, and the
  // whole point of the wait is to stop treating one as air). settleMs is the give-up bound, and giving up
  // still leaves `scoutSettleUntil` in the future so usableScout() reports honestly unavailable.
  //
  // A LIVE FIGHT OUTRANKS IT. The witness's hot anchor is a record being written, and a framing nicety may
  // not interrupt it — the scout is one client with two jobs (Law 16) and the record is the one that cannot
  // be re-taken. When a fight owns the scout the seeker uses whatever chunks it has and says { known:false }
  // if it cannot answer, which is the honest degradation.
  async function parkScoutOver(pos, why) {
    if (!rcon || !scout || !scout.isReady() || !pos) return;
    if (witness && witness.anchorTarget()) return;                        // a fight owns the eyes
    if (scoutAnchor && Math.hypot(pos.x - scoutAnchor.x, pos.z - scoutAnchor.z) <= CFG.scout.parkRadius) return;
    const target = { x: Math.round(pos.x), y: Math.round(pos.y + CFG.scout.parkRise), z: Math.round(pos.z) };
    await rcon.command(`tp ${CFG.scout.username} ${target.x} ${target.y} ${target.z}`);
    scoutAnchor = { x: target.x, z: target.z };
    scoutSettleUntil = Date.now() + CFG.scout.settleMs;
    const deadline = Date.now() + CFG.scout.settleMs;
    let loaded = false;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 120));
      if (!scout || !scout.isReady()) break;
      if (scout.blockAt(pos)) { loaded = true; break; }                   // the cell reads — chunks are here
    }
    if (loaded) scoutSettleUntil = 0;                                     // usable NOW, not at the deadline
    const waited = CFG.scout.settleMs - (deadline - Date.now());
    narrate('summary', 'scout',
      `parked ${CFG.scout.parkRise}b over (${target.x},${target.z}) @ y=${target.y}${why || ''} — ` +
      (loaded ? `chunks live after ${waited}ms`
              : `chunks did not stream inside ${CFG.scout.settleMs}ms; framing stays blind until they do`));
    // The park is the first half of every scan: a seeker casting through chunks that never arrived returns
    // a blind shot, and without this the trace would show the blind shot with no record of why.
    crewLog.event('scout', 'park', {
      at: `(${target.x},${target.y},${target.z})`, loaded: loaded ? 'yes' : 'no', ms: waited,
    });
  }

  // The gimbals — one per bot, each owning its camera's AIM (see camera_gimbal.js). If unavailable the rig
  // keeps the old frozen-aim tripod: filming must survive a missing gimbal, exactly as it survives a missing
  // scout. That fallback is degradation, not a second pathway — there is still one way to aim a WORKING rig.
  let gimbals = null;
  if (CFG.gimbal.enable && FRAMING) {
    gimbals = createGimbals({
      bots: BOTS, host: SERVER_ENDPOINT.host, port: SERVER_ENDPOINT.port, version: SERVER_MINECRAFT_VERSION, cfg: CFG.gimbal,
      // The SAME list the seeker places on. A rig that cuts on one definition of "blocked" while the seeker
      // places on another argues with itself: it would cut away from a bot behind sugar cane and then site
      // the next camera as though sugar cane were air (Law 16 — and ./sightline is the shared walk).
      visualBlockers: VISUAL_BLOCKERS,
      log: msg => narrate('summary', 'gimbal', msg),
    });
    if (gimbals.available === false) {
      narrate('warn', 'gimbal', `mineflayer gimbal unavailable (${gimbals.reason}) — falling back to FROZEN-AIM tripod shots (a traversing bot will drift out of frame).`);
      crewLog.post('gimbal', 'link', { state: 'absent', why: gimbals.reason });
      gimbals = null;
    }
  }
  // gimbalLive gates every aim decision in the file. `gimbalDetached` is the see-through shot deliberately
  // giving the aim back to the camera — a DECISION, not a failure, but from here down it must look exactly
  // like a missing gimbal so there stays one frozen-aim pathway rather than two (Law 16).
  const gimbalLive = r => !!(gimbals && gimbals.isReady(r.bot) && r.gimbalBound && !r.gimbalDetached);

  const rigs = BOTS.map((bot, i) => ({
    bot, cam: CAMS[i],
    stage: `cam_${bot.toLowerCase()}`,
    tail: new StoryTail(bot),
    ready: false,
    botPos: null,            // RCON 1 Hz poll (cut timing + scout anchoring; never placement)
    job: '',
    shot: null,              // { at, type, tCut, framing, aim, acquired, noFollow, mode }
    objective: null,         // the spot the bot is working toward — its latest goTo destination (what we film)
    legCost: null,           // navigator A* cost for the current leg (null until NAVIGATOR reports; straight-line meanwhile)
    lastBearingDeg: null,    // the previous shot's camera bearing → enforces the 30-degree rule on the next
    cutNo: 0,
    absorbed: 0,
    exitSince: 0,            // when the subject first left the frame (0 = in frame)
    lastEventMs: Date.now(),
    lastSentMs: 0,
    gimbalBound: false,      // camera is /spectate-locked to its gimbal (so the gimbal owns the aim)
    gimbalDetached: false,   // …released ON PURPOSE for a see-through shot, which is a frozen tripod
  }));

  // ── THE WITNESS ─────────────────────────────────────────────────────────────────────────────────
  // Built here rather than beside the scout because it needs the rig's per-bot position poll, and that
  // lives on `rigs`. It BORROWS the rcon link through a thin adapter rather than holding the session
  // object: `rcon` is reassigned on every relink, so a captured reference would go stale silently and
  // the nose would fail into the old socket forever. The adapter also means a witness started before the
  // link is up simply gets a rejected command and records the miss (Law 25), instead of throwing.
  let witness = null;
  if (WITNESS) {
    witness = createWitness({
      scout,
      rcon: { command: (c) => (rcon ? rcon.command(c) : Promise.reject(new Error('rcon link down'))) },
      botNames: BOTS,
      botPosFn: (name) => { const r = rigs.find(x => x.bot === name); return r ? r.botPos : null; },
      cfg: CFG.witness || {},
      log: (lvl, msg) => narrate(lvl, 'witness', msg),
    });
    if (witness.available === false) {
      narrate('warn', 'witness', `combat witness unavailable (${witness.reason}) — no combat record this run.`);
      witness = null;
    } else {
      narrate('summary', 'witness',
        `recording the server's account of every fleet engagement → ${path.basename(witness.file)} ` +
        `(sample ${(CFG.witness || {}).sampleMs || 100}ms while a fight is open, nothing while idle). ` +
        'Read it with: node monitoring/trace_monitor.js --witness');
    }
  }

  async function link() {
    if (rcon || linking) return;
    linking = true;
    try {
      const session = await rconConnect(readServerProperties(), () => {
        rcon = null;
        for (const r of rigs) r.ready = false;
        scoutArmed = false; scoutAnchor = null;
        narrate('warn', 'camera_rig', 'rcon link lost — waiting for the server to come back.');
      });
      rcon = session;
      announcedDown = false;
      await rcon.command('gamerule sendCommandFeedback false');
      await rcon.command('gamerule logAdminCommands false');
      narrate('summary', 'camera_rig',
        `rcon up · ${BOTS.map((b, i) => `${b}→${CAMS[i]}`).join(' · ')} · absorb=${CFG.frame.absorbRadius} min_hold=${CFG.timing.minHoldMs / 1000}s field≈${CFG.frame.field.azSteps * CFG.frame.field.elevs.length} rays/seek margin=${CFG.frame.field.margin}>airbox=${CFG.frame.field.airBox} spoil-cone=${CFG.frame.cone.gridH}×${CFG.frame.cone.gridV}`);
    } catch (e) {
      if (!announcedDown) { console.log(`waiting for the server (rcon: ${e.message})...`); announcedDown = true; }
    }
    linking = false;
  }

  // sendCam: place the shot. WITH A GIMBAL the camera is not moved at all — it is /spectate-locked to the
  // gimbal, so we teleport the GIMBAL and send NO yaw/pitch: the aim is authored per-tick by camera_gimbal
  // and interpolated by the spectating client. Sending an aim here would fight it, and would step at 20 Hz.
  // WITHOUT one we fall back to the original frozen-aim tripod (position AND aim in one tp).
  //
  // ── THE ONE PLACE FEET ARE WANTED, AND IT IS HERE ─────────────────────────────────────────────
  // `pos` is a LENS position: everything upstream — the visibility field's origin, the air box, the lens
  // box, every cone ray — is measured from the point the picture is rendered from. `tp` does not take that
  // point. It places a player by its FEET, and the picture comes from its EYE, `eyeHeight` above. So the
  // whole stack was verifying one plane and filming another 1.62 blocks higher: `camHeight: 1.5` promised
  // a lens at bot eye level and delivered one at bot feet + 3.12, above the bot's head and tilted down
  // through the canopy — which is the shot the horizontal-only search exists to make impossible. The air
  // box was centred on the feet cell too, so the block the lens was actually INSIDE was often outside the
  // box entirely; a spectator inside a leaf renders that leaf across the whole screen, and it passed.
  // Subtracting here rather than adding upstream keeps the lens the unit every test speaks in, and leaves
  // exactly one line in the file that knows about feet.
  const feetY = y => y - CFG.frame.eyeHeight;
  const sendCam = (r, pos, aim) => {
    if (gimbalLive(r)) {
      return rcon.command(`tp ${gimbals.nameFor(r.bot)} ${pos.x.toFixed(1)} ${feetY(pos.y).toFixed(1)} ${pos.z.toFixed(1)}`);
    }
    return rcon.command(`tp ${r.cam} ${pos.x.toFixed(1)} ${feetY(pos.y).toFixed(1)} ${pos.z.toFixed(1)} ${aim.yaw.toFixed(1)} ${aim.pitch.toFixed(1)}`);
  };

  // cut: the only moment a camera moves. One tp into a frozen framing (solveView already chose it); it
  // holds there — position AND aim — until the followed subject leaves the frame (holdTick) or maxHold.
  // The shot's subject is framing.subjectAt (the objective for a staged shot, the bot for travel/wide),
  // so the absorb test measures new events against what's actually on screen. Records lastBearingDeg so
  // the NEXT solve enforces the 30-degree rule against this shot's angle.
  // ── THE TOKEN AND THE SENTENCE ARE BOTH ARGUMENTS, AND NEITHER IS DERIVED FROM THE OTHER ────────
  // `trigger` is the sentence a person reads ("subject lost — sightline blocked by oak_leaves for 1.4s").
  // `why` is the same cause as one word, for the lens that counts how a run's cuts were caused. Deriving
  // the token by matching the sentence here would be a machine reading prose in the one place it is
  // avoidable — reword the sentence and the counts silently change category (Law 26). Every call site
  // states both, so a new cut reason cannot be added without naming what class it belongs to.
  async function cut(r, framing, trigger, why) {
    const place = framing.subjectAt;
    const type = framing.kind;
    // A CUT THAT DOESN'T MOVE THE LENS IS NOT A CUT — it is a re-tp to the same spot: invisible on screen, and
    // a lie in the trace that hides a stuck trigger behind a wall of CUT lines. Measured 2026-07-21: a spoiled
    // travel shot re-solved to its own destination and logged 22 identical CUTs over 67 seconds. The hold
    // clock RESTARTS rather than the trigger being ignored, because the honest reading is that this shot
    // simply continues — so the same trigger cannot re-fire before minHold, and the next attempt re-solves
    // against a world that has had time to move.
    // The distance test only means "same shot" when the two are the same KIND of shot. A first-person
    // framing records the bot's own eye as `cam`, which is within sameShotDist of any close tripod — so
    // comparing position alone would suppress the very cut that gets the camera back off the bot's face.
    const modeKey = f => f.firstPerson ? 'bot' : (f.seeThrough ? 'free' : 'gimbal');
    if (r.shot && modeKey(framing) === modeKey(r.shot.framing)
        && dist3d(framing.cam, r.shot.framing.cam) < CFG.hold.sameShotDist) {
      r.shot.tCut = Date.now();
      r.shot.lastOcclMs = Date.now();
      watcher.buffer.record(r.stage, `no-op cut suppressed (${trigger}) — solver returned the standing camera`);
      crewLog.event(r.stage, 'hold', { why: 'no_op', on: why });
      return;
    }
    const held = r.shot ? Math.round((Date.now() - r.shot.tCut) / 1000) : 0;
    const absorbedBefore = r.absorbed;
    const fromCam = r.shot ? r.shot.framing.cam : null;
    const prev = r.shot ? `held ${r.shot.type} ${held}s, absorbed ${r.absorbed} in-frame` : 'first shot';
    r.shot = { at: place, type, tCut: Date.now(), framing, aim: { ...framing.aim }, acquired: false,
               noFollow: !!framing.noFollow, mode: framing.mode,
               seeThrough: !!framing.seeThrough, firstPerson: !!framing.firstPerson };
    r.lastBearingDeg = framing.bearingDeg;   // next solve must differ by ≥ minBearingChangeDeg (30° rule)
    r.absorbed = 0;
    r.exitSince = 0;
    if (!rcon || !r.ready) return;
    r.cutNo++;
    // HAND THE AIM OVER AT THE CUT. A see-through shot is a frozen tripod by decision, not by degradation, so
    // the camera must stop spectating and be aimed directly — `execute as <cam> run spectate` with no target
    // is the only way to release it from RCON (bare `/spectate` releases the SENDER, and the sender here is
    // the console). Both directions are handled, and the flag is flipped BEFORE sendCam so it takes the
    // matching branch. Everything downstream keys off gimbalLive(), so releasing the gimbal also re-arms the
    // frame-exit angle test that a live gimbal correctly suppresses.
    // THREE MODES NOW, AND THEY ARE A STATE MACHINE RATHER THAN A PAIR OF BOOLEANS. It was seeThrough
    // yes/no, which is two states and could be a flag; first person makes three, and three booleans
    // checking each other is how a camera ends up spectating one thing while the rig believes another.
    //   gimbal — the normal shot: the gimbal owns the aim and the camera rides it
    //   free   — the see-through tripod: released, aimed directly by tp (a decision, not degradation)
    //   bot    — first person: the camera IS the bot's eyes, and there is nothing to aim or place
    if (gimbals && r.gimbalBound) {
      const want = framing.firstPerson ? 'bot' : (framing.seeThrough ? 'free' : 'gimbal');
      if (want !== (r.specMode || 'gimbal')) {
        // Bare `/spectate` releases the SENDER, and the sender here is the console — so releasing the
        // camera needs `execute as <cam>`. That detail has bitten this file once already.
        if (want === 'free') await rcon.command(`execute as ${r.cam} run spectate`);
        else if (want === 'bot') await rcon.command(`spectate ${r.bot} ${r.cam}`);
        else await rcon.command(`spectate ${gimbals.nameFor(r.bot)} ${r.cam}`);
        r.specMode = want;
        r.gimbalDetached = (want !== 'gimbal');   // everything downstream still keys off gimbalLive()
      }
    }
    // NOTHING IS TELEPORTED IN FIRST PERSON. The camera is bound to the bot and the bot moves itself; a tp
    // here would fight that every heartbeat, and there is no position to send anyway — `framing.cam` is the
    // bot's eye, recorded so the log and the same-shot test can read it, not a place to put anything.
    if (!framing.firstPerson) await sendCam(r, framing.cam, r.shot.aim);
    // SNAP the gimbal at the cut. Without this the gimbal would EASE from its previous orientation into the
    // new shot, turning every cut into a swing — "a 6 year old… easily gets distracted." A cut is a cut: the
    // camera arrives already on the bot, and only then does the gimbal go back to holding still.
    if (gimbalLive(r) && !framing.firstPerson) gimbals.snap(r.bot);
    // Re-assert the binding on every cut. /spectate is known to drop on respawn and chunk churn, and a cut is
    // both the cheapest moment to re-issue it (≥minHold apart, so never spammy) and the one where a stale
    // binding would be most visible. If a drop is ever observed MID-hold, this needs its own timer too.
    if (gimbalLive(r)) await rcon.command(`spectate ${gimbals.nameFor(r.bot)} ${r.cam}`);
    r.lastSentMs = Date.now();
    const cost = framing.solveMs != null ? ` · ${framing.rays || 0} rays in ${framing.solveMs}ms` : '';
    narrate('summary', r.stage,
      `CUT #${r.cutNo} ${type} @ ${fmt(place)} — ${framing.note} · cam ${fmt(framing.cam)}${cost} | prev: ${prev} | trigger: ${trigger}${r.job ? ` | job ${r.job}` : ''}`);
    // The sweep decision, always — the "why do I see canopy" line: how many candidates cleared + the best.
    if (framing.search) narrate('summary', r.stage, `  sweep: ${framing.search}`);
    crewLog.event(r.stage, 'cut', {
      no: r.cutNo, kind: type, why, at: p3(place), cam: p3(framing.cam),
      from: p3(fromCam), held, absorbed: absorbedBefore,
      ms: framing.solveMs, rays: framing.rays || 0, job: r.job || null,
    });
    r.lastHoldWhy = null;   // a cut ends whatever hold reason was standing — the next one is news again
  }

  // ── WHAT IT SCANNED AND HOW IT CHOSE, AS FACTS ──────────────────────────────────────────────────
  // Posted for EVERY seek, including the ones that end in no movement at all. A camera that holds still
  // for two minutes is making a decision every second, and a record that only writes down the cuts says
  // nothing about the ninety-nine times it looked and stayed — which is exactly the half a reader needs
  // to tell "the terrain offered nothing better" from "the seeker stopped running".
  const p3 = p => (p ? `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})` : null);
  function recordSeek(r, f) {
    if (!f) return;
    const w = f.sweep || {};
    crewLog.event(r.stage, 'scan', {
      at: p3(f.subjectAt), open: w.fieldRays, roomy: w.roomy, max: w.maxRange,
      ms: w.fieldMs, rays: f.rays || 0,
    });
    crewLog.event(r.stage, 'site', {
      mode: f.kind, verdict: w.verdict,
      airbox: w.airRejects, lensbox: w.lensRejects, relaxed: w.relaxed ? 'yes' : null,
      az: Math.round(f.bearingDeg), el: w.el, d: w.usable,
      room: f.room != null ? Math.round(f.room * 10) / 10 : null,
      score: f.coneScore != null ? Math.round(f.coneScore * 100) : null,
      // subject: was the BOT itself visible from the chosen vantage — the field that says whether this
      // siting produced a watchable shot. `score` alone cannot: it measures the frame around the bot.
      subject: w.subject == null ? null : (w.subject ? 'yes' : 'no'),
      by: w.blockedBy || null,
      depth: w.depth != null ? w.depth : null,
    });
  }

  // THE SCOUT'S OWN LINE TO THE BOT — the measurement's own health, not the picture's.
  //
  // Every figure the seeker reports is derived from rays the SCOUT fires, and the scout is a separate
  // client parked above the subject. If its own line to the bot is broken, the field it casts is still
  // returned and still looks like data — that is the shape of failure worth catching, because nothing
  // downstream can tell a measured "no clear vantage" from a measurement taken through a roof.
  //
  // DISTINCT FROM THE `sight` EVENT, which watches the CAMERA's line and is what drives a
  // `sightline_lost` cut. That one asks "is the footage still good"; this asks "was the answer
  // trustworthy". Both are needed and they fail independently.
  //
  // REUSES coneClear AT 1×1 rather than adding a raycast primitive: a single centre ray with the same
  // range cap, the same blocker set and the same unloaded-column handling as every other measurement here
  // (Law 16 — one implementation of "can this point see that point"). Posted on a CHANGE of state only,
  // like a hold: the answer is re-derived every second and the fact worth recording is that it moved.
  async function recordScoutLos(r, sc, subjectAt) {
    if (!sc) return;
    const eye = sc.selfPos ? sc.selfPos() : null;
    if (!eye) return;
    const line = await sc.coneClear(eye, subjectAt, { gridH: 1, gridV: 1 });
    // `known:false` is not "blocked" — it is the scout unable to answer (a column not streamed). Recorded
    // as its own state rather than folded into either verdict, because calling it blocked would invent a
    // blocker and calling it clear would vouch for a line nobody looked down (Law 25).
    const state = !line.known ? 'unknown' : (line.centerClear ? 'clear' : 'blocked');
    if (r.lastLosState === state) return;
    r.lastLosState = state;
    crewLog.event(r.stage, 'los', {
      state,
      by: state === 'blocked' ? (line.blockedBy || 'unknown') : null,
      from: p3(eye), to: p3(subjectAt),
    });
  }

  // A hold reason repeats at the seek rate — once a second for as long as the world stays the same — so
  // it is posted on a CHANGE of reason only, exactly as battle_stations posts a declined engagement. The
  // fact worth recording is that the answer changed, not that the same answer was reached again.
  function recordHold(r, why, fields) {
    if (r.lastHoldWhy === why) return;
    r.lastHoldWhy = why;
    crewLog.event(r.stage, 'hold', Object.assign({ why }, fields || {}));
  }

  // The bot's freshest position (scout's smooth read, else the RCON poll).
  const botNow = r => (scout && scout.entityPos(r.bot)) || r.botPos;

  // chooseSubject: what this shot frames. We AIM AT THE BOT in EVERY case (the Architect's rule — pre-staging
  // on a spot and guessing when the bot walks in was too fiddly and left the camera staring at empty coords;
  // pointing at the bot guarantees it's on screen, and the shot re-cuts when the bot leaves frame or maxHold
  // elapses). The objective no longer sets the AIM — it only biases camera POSITION (the approach side, so the
  // bot walks toward the lens) and picks the shot SIZE:
  //   wide   — bot idle above ground (no announcement for idleDroughtMs): a high, wide establishing landscape.
  //   travel — a leg longer than travelCutMinDist: the camera is solved around the DESTINATION and the bot
  //            walks INTO the lens; held unbroken until it arrives (never cut mid-travel).
  //   bot    — the default: a normal-distance follow, aimed at the bot.
  // Returns { mode, subject:botPos } or null when there's no bot to film yet.
  function chooseSubject(r) {
    const O = CFG.frame.objective;
    const bp = botNow(r);
    if (!bp) return null;
    const idle = Date.now() - r.lastEventMs > O.idleDroughtMs;
    // Wide only makes sense ABOVE ground — underground it's a see-through wall of rock, so an idle bot down
    // there gets a normal close tracking shot instead.
    if (idle && bp.y >= CFG.frame.undergroundY) return { mode: 'wide', subject: bp };
    // A leg longer than travelCutMinDist is a DESTINATION shot: the camera waits at the far end and the bot
    // walks into the lens, held for the whole traverse. Gated on the gimbal, because with a frozen aim the
    // camera would stare at empty ground until the bot arrived — the shot only exists because aim is live.
    // CEILINGED at travelStageMaxDist: past that the bot is outside the gimbal's entity range for most of the
    // walk, the gimbal has no target and holds its last aim, and the result is a motionless shot of empty
    // ground for a minute (measured 2026-07-21 on a 160-block dispatch — read as the camera freezing). A leg
    // that long is filmed by FOLLOWING the bot; staging resumes once it is close enough to be seen arriving.
    const legDist = r.objective ? dist3d(bp, r.objective) : 0;
    if (r.objective && !idle && legDist > O.travelCutMinDist && legDist <= O.travelStageMaxDist) {
      return { mode: 'travel', subject: bp };
    }
    return { mode: 'bot', subject: bp };
  }

  // framePick: build the locked framing for the current subject (always the bot). Picks the per-mode seeker
  // params (distance / angle bias), hands solveView the approach side (camera sits ahead of the bot's path, so
  // it walks toward the lens) and the last bearing (30-degree rule), times the solve. Every shot except the
  // idle WIDE follows — holdTick cuts when the bot leaves frame. Always returns a framing (solveView guarantees).
  async function framePick(r, pickOpts) {
    const sub = chooseSubject(r);
    if (!sub) return null;
    const bp = botNow(r);
    // Approach side: the walk direction bot→objective. Camera scores toward it → sits ahead of the bot on its
    // path, so the bot walks toward the lens. Skipped when the bot is at (or has no) objective — nothing to lead.
    let approachDir = null;
    if (r.objective && bp && (sub.mode === 'bot' || sub.mode === 'travel')) {
      const v = { x: r.objective.x - bp.x, z: r.objective.z - bp.z };
      if (Math.hypot(v.x, v.z) >= 1) approachDir = norm2d(v);
    }
    // THE DESTINATION SHOT: for a travel leg the camera is solved around the OBJECTIVE, not the walking bot,
    // so it is already standing where the bot is headed. The gimbal then tracks the bot in from wherever it is.
    // Falls back to framing the bot without a live gimbal — a frozen aim parked at the destination would hold
    // an empty field for the entire walk, which is worse than the problem it set out to fix.
    const framedOn = (sub.mode === 'travel' && gimbalLive(r) && r.objective) ? r.objective : sub.subject;
    // STEP ONE: stand the eyes over what is about to be scanned, and only then take the handle. The order is
    // the whole point — `usableScout()` reports unavailable during a park, so reading it first would hand the
    // seeker a null and produce the blind shot this exists to prevent. Note it parks over `framedOn` and not
    // over the bot: on a travel leg the seeker solves around the OBJECTIVE, which is where the camera will
    // stand and therefore which chunks it needs, and that can be a long way from the walking subject.
    await parkScoutOver(framedOn, ` — scanning for ${r.bot}`);
    const sc = usableScout();
    const underground = framedOn.y < CFG.frame.undergroundY;
    // The bot's own claimed job — the second enclosure signal. It is an announcement the construct already
    // makes, not a guess about the terrain, and it is only ever read TOGETHER with a starved field.
    const miningJob = (CFG.frame.enclosed.jobPrefixes || []).some(p => r.job && r.job.includes(p));
    await recordScoutLos(r, sc, framedOn);
    const t0 = Date.now();
    const framing = await solveView(framedOn, sc, {
      ...modeParams(sub.mode), label: sub.mode.toUpperCase(),
      lastBearingDeg: r.lastBearingDeg, underground, miningJob, approachDir,
      forceFirstPerson: pickOpts && pickOpts.forceFirstPerson });
    framing.solveMs = Date.now() - t0;
    framing.mode = sub.mode;
    framing.noFollow = sub.mode === 'wide';   // idle establishing hold; every other shot follows the bot
    // RECORDED HERE AND NOT AT THE CUT, because most seeks do not end in one. The motivated re-seek runs
    // about once a second for the whole length of a hold, and it is a real decision each time: the world
    // was measured and the standing shot won. Recording only the seeks that moved the camera would leave a
    // reader unable to tell a director that keeps choosing to stay from one whose seeker has stopped.
    recordSeek(r, framing);
    return framing;
  }

  async function onEvent(r, ev, line) {
    r.lastEventMs = Date.now();
    if (ev.kind === 'job') { r.job = ev.job; return; }
    if (ev.kind === 'beacon') { if (ev.at) r.botPos = ev.at; return; }
    if (ev.kind === 'legcost') { r.legCost = ev.cost; return; }   // navigator cost for the current leg
    if (!ev.at) return;
    const trigger = (line.match(/\[([A-Z][A-Z_]+)\]/) || [, '?'])[1];

    // Every located announcement (goTo destination, or a place/site the bot works at) sets the objective —
    // the sole location marker (Architect: "it's literally always going to the spot of locomotion"). A
    // genuinely new objective resets the leg cost until NAVIGATOR reports the fresh one.
    if (!r.objective || dist3d(ev.at, r.objective) > CFG.frame.absorbRadius) r.legCost = null;
    r.objective = ev.at;

    if (r.shot && dist3d(ev.at, r.shot.at) <= CFG.frame.absorbRadius) {
      r.absorbed++;
      watcher.buffer.record(r.stage, `absorb ${trigger} ${fmt(ev.at)} d=${dist3d(ev.at, r.shot.at).toFixed(1)} — in frame`);
      recordHold(r, 'absorbed', { on: trigger, d: dist3d(ev.at, r.shot.at).toFixed(1), n: r.absorbed });
      return;
    }
    if (r.shot && Date.now() - r.shot.tCut < CFG.timing.minHoldMs) {
      watcher.buffer.record(r.stage, `suppress ${trigger} ${fmt(ev.at)} — min hold`);
      recordHold(r, 'min_hold', { on: trigger, age: Math.round((Date.now() - r.shot.tCut) / 1000) });
      return;
    }
    await cut(r, await framePick(r), trigger, 'announcement');
  }

  // ── ONE LINE PER RIG PER PASS, NOT ONE LINE PER FACT ────────────────────────────────────────────
  // A single decision here is three facts — what was scanned, what was chosen, what happened — and posting
  // each as its own trace line spreads one decision across three timestamps a reader has to reassemble.
  // `crew_log.event` buffers and `flush` drains every buffered tag onto one line apiece, so the pass
  // boundary is where it belongs: both of this file's loops are passes, and both end with a flush.
  //
  // FLUSHED OUTSIDE THE RIG LOOP, deliberately. `flush` drains EVERY tag, so calling it per rig would post
  // the other rigs' half-built lines early and split their decisions in exactly the way this exists to
  // prevent. It is idempotent and safe to over-call — an empty buffer posts nothing.
  async function logTick() {
    for (const r of rigs) {
      for (const line of r.tail.poll()) {
        const ev = extractEvent(line);
        if (ev) await onEvent(r, ev, line);
      }
    }
    crewLog.flush();
  }

  // holdTick: every shot is now a LOCKED tripod (first-person tracking was removed — it re-tp'd every
  // tick and was dizzying). This only re-asserts the frozen position+aim on a heartbeat (so a nudge/
  // drift snaps back) and decides WHEN to cut — never nudges the camera between cuts. A camera thus
  // moves at most once per minHold (5s); nothing here moves it more often.
  async function holdTick() {
    if (!rcon) return;
    const now = Date.now();
    for (const r of rigs) {
      if (!r.ready || !r.shot) continue;

      const pos = r.shot.framing.cam;
      // THE HEARTBEAT RE-ASSERTS WHATEVER THIS SHOT IS MADE OF, and for a first-person shot that is a
      // BINDING rather than a position. Teleporting here would drag the camera off a moving bot four times
      // a minute; `pos` is a stale eye position the moment the bot takes a step. The drop this heartbeat
      // exists to survive (respawn, chunk churn) breaks a /spectate binding just as readily as it breaks a
      // tp, so the shape of the repair is the same — only the command differs.
      if (now - r.lastSentMs > CFG.hold.heartbeatMs) {
        if (r.shot.firstPerson) await rcon.command(`spectate ${r.bot} ${r.cam}`);
        else await sendCam(r, pos, r.shot.aim);
        r.lastSentMs = now;
      }

      const bp = botNow(r);

      // A FIRST-PERSON SHOT CANNOT SPOIL, and every spoil test below would read it as spoiled anyway. The
      // camera is inside the subject's head: the sightline to the subject has zero length, the cone would
      // be cast from a point the subject occupies, and the frame-exit angle is measured against a frozen
      // aim that first person does not have. All three would fire constantly and cut on nothing.
      //
      // It stays ACQUIRED for the same reason — `acquired` means "the subject has arrived in frame", and in
      // first person it never wasn't. That is not bookkeeping: the motivated re-seek below is gated on it,
      // and the re-seek is the ONLY way out of first person. This shot is a stopgap for a bot with no room
      // around it, so it must be hunting for a real vantage the entire time it holds, and betterShot yields
      // to any real candidate (see its note). The mandatory reposition is the backstop if the seek finds none.
      r.shot.acquired = true;

      // Travel → arrival: a travel shot is a WIDE follow of a far-walking bot; once it reaches the objective,
      // re-cut to a normal (closer) tracking shot to catch it working. Past minHold only.
      if (r.shot.mode === 'travel' && r.objective && bp
          && dist3d(bp, r.objective) <= CFG.frame.objective.arrivalRadius
          && now - r.shot.tCut >= CFG.timing.minHoldMs) {
        await cut(r, await framePick(r), 'arrival — bot reached objective', 'arrival');
        continue;
      }

      // Mandatory reposition: cap how long ANY shot holds. Even a dead-centered subject (or a bad
      // canopy shot) gets a fresh angle after maxHold — bounds canopy-staring, feeds curation.
      // A TRAVEL shot is EXEMPT from the reposition timer — it ends on ARRIVAL (handled just above), because
      // the whole point is one unbroken shot of the journey: "its not good for the bot to cut mid travel and
      // only view the bot for a few seconds." travelMaxHoldMs is a stuck-bot safety valve, not a rhythm.
      const holdCap = r.shot.mode === 'travel' ? CFG.frame.objective.travelMaxHoldMs : CFG.timing.maxHoldMs;
      if (now - r.shot.tCut >= holdCap) {
        await cut(r, await framePick(r),
          `mandatory reposition (${Math.round((now - r.shot.tCut) / 1000)}s)`, 'max_hold');
        continue;
      }

      // ── SUBJECT LOST: the fast cut, and the only one that does not wait on a timer ────────────────
      // The gimbal is parked at the lens and walks its own sightline twice a second (camera_gimbal's header
      // has why that client and not the scout). Everything else in this loop is a RHYTHM — minimum holds,
      // reposition caps, a 5s frame re-check — and rhythms are correct for questions of taste. This is not
      // one: a shot whose subject has gone behind a trunk stopped being footage at that instant, and every
      // further second is leaves. So it ignores minHold and honours only `blockedMinHoldMs`, which is a
      // rate limit against a re-cut that also lands blocked, not a hold to wait out.
      //
      // IT SITS ABOVE THE noFollow GUARD ON PURPOSE. A wide idle establishing shot holds without chasing —
      // but an establishing shot of foliage establishes nothing, so it is exactly as dead as a tracking one.
      //
      // TWO EXEMPTIONS, both of which would otherwise make this fire constantly and correctly-by-its-own-
      // lights while destroying the shot:
      //   · a TRAVEL leg still in progress — the camera is standing at the DESTINATION and the bot is walking
      //     in from far away, so "hidden" is the normal state of the leg rather than a spoiled frame. This is
      //     the same defect the 5s cone check produced (22 identical cuts in 67s, measured 2026-07-21); at
      //     2 Hz it would simply produce it faster.
      //   · a SEE-THROUGH tripod — a spectator renders through rock, so a blocked line down there is not a
      //     blocked picture and the reading means nothing.
      // THE GIMBAL'S VERDICT IS RECORDED WHERE IT IS READ, ON A FLIP ONLY. It is polled at the hold
      // loop's rate and is the same answer for seconds at a time; what a reader needs is the moment the
      // answer CHANGED, because that instant is the cause of the cut two lines below. Written from here
      // rather than from camera_gimbal for the reason every meter in this fleet is silent: the gimbal owns
      // the measurement, the file that acts on it owns the voice (Invariant D).
      const gOcc = gimbalLive(r) && bp ? gimbals.occlusion(r.bot) : { known: false };
      const sight = !gOcc.known ? 'unknown' : (gOcc.clear ? 'clear' : 'blocked');
      if (sight !== r.lastSight) {
        r.lastSight = sight;
        crewLog.event(r.stage, 'sight', { state: sight, by: gOcc.blockedBy || null });
      }
      if (gOcc.known && !gOcc.clear && !r.shot.seeThrough
          && !(r.shot.mode === 'travel' && r.objective
               && dist3d(bp, r.objective) > CFG.frame.objective.arrivalRadius)
          && now - r.shot.tCut >= CFG.hold.blockedMinHoldMs) {
        // THE THRASH GUARD. A shot that went blocked almost as soon as it was set is a bad MOMENT, not a
        // bad vantage: the bot is moving, and re-seeking hands back another placement the same trunk will
        // eat a second later. Measured from when the BLOCK began, not from when this cut fires, because
        // `blockedMinHoldMs` delays the cut and timing it off the cut would shrink the window to the sliver
        // between the two numbers. Full reasoning at `hold.thrashWindowMs` in camera_configure.
        const blockedAt = now - (gOcc.blockedMs || 0);
        const thrashing = !r.shot.firstPerson && blockedAt - r.shot.tCut < CFG.hold.thrashWindowMs;
        if (thrashing) {
          r.firstPersonUntil = now + CFG.hold.thrashFirstPersonMs;
          await cut(r, await framePick(r, { forceFirstPerson:
              `thrash guard — blocked ${((blockedAt - r.shot.tCut) / 1000).toFixed(1)}s after the cut` }),
            `shot died on arrival — blocked by ${gOcc.blockedBy || 'terrain'} within ` +
            `${(CFG.hold.thrashWindowMs / 1000).toFixed(0)}s of the cut`,
            'thrash_guard');
          continue;
        }
        await cut(r, await framePick(r),
          `subject lost — sightline blocked by ${gOcc.blockedBy || 'terrain'} for ${(gOcc.blockedMs / 1000).toFixed(1)}s`,
          'sightline_lost');
        continue;
      }

      // THE GUARD'S HOLD. Nothing re-seeks while first person is serving out its window — that window IS
      // the remedy, and a re-seek inside it would hand back the placement the guard just refused. It is
      // placed after the sight recording so the trace still shows the line coming back, and before every
      // cut trigger below so all of them are covered by one gate rather than each carrying its own copy.
      if (r.firstPersonUntil && now < r.firstPersonUntil) {
        recordHold(r, 'thrash_hold', { left: Math.round((r.firstPersonUntil - now) / 1000) });
        continue;
      }

      // The idle WIDE establishing shot doesn't chase — it holds until the next event or the reposition.
      // Every other shot follows the bot (frame-exit below re-cuts when it walks off).
      if (r.shot.noFollow) continue;

      if (!bp) continue;

      // Motivated re-seek (the SEEKER hunting mid-hold): past minHold, re-solve ~1×/s and CUT only if a
      // materially better, ≥30°-different vantage exists (betterShot). This — not the maxHold timer — is the
      // Architect's "switch when we have a better shot." Throttled so it costs one field cast per second, not
      // one per 4 Hz tick. The frame-exit test below still cuts sooner when the bot walks off entirely.
      // RE-CHECK OCCLUSION DURING THE HOLD. The cone runs once, at the cut — and with holds now 30s the
      // world moves underneath it: "the bot moved behind a tree and was perfectly blocked after moving a
      // little bit." A shot that was clean when taken is not clean forever, so re-test and cut away when it
      // spoils. This applies to TRAVEL shots too (a bot walking a long leg passes behind plenty), which is
      // why it sits ABOVE the travel guard below — the no-mid-travel-cut rule must not outrank "the subject
      // is now invisible". Skipped on a see-through shot, where a spectator sees through rock anyway.
      //
      // NOT DURING AN UNARRIVED TRAVEL SHOT, though — that was a real defect, and the reasoning above is
      // exactly what produced it. A destination shot is framed on the OBJECTIVE while the bot is still walking
      // in from far away, so "the subject is hidden" is the NORMAL state of the leg, not a spoiled frame: the
      // check fired every 5s, the re-solve returned the same destination, and the trace filled with identical
      // cuts (measured 2026-07-21, 22 in a row). Occlusion becomes meaningful again the moment the bot
      // arrives, and arrival re-cuts to a tracking shot anyway.
      const travelling = r.shot.mode === 'travel' && r.objective && bp
        && dist3d(bp, r.objective) > CFG.frame.objective.arrivalRadius;
      if (bp && !r.shot.seeThrough && !r.shot.firstPerson && !travelling
          && now - (r.shot.lastOcclMs || r.shot.tCut) >= CFG.hold.occlusionCheckMs
          && now - r.shot.tCut >= CFG.timing.minHoldMs) {
        r.shot.lastOcclMs = now;
        const scO = usableScout();
        if (scO) {
          const C = CFG.frame.cone;
          const cone = await scO.coneClear(pos, subjAim(bp), {
            gridH: C.gridH, gridV: C.gridV, fovDeg: C.fovDeg, aspect: C.aspect,
            frameFraction: C.frameFraction, visualBlockers: VISUAL_BLOCKERS,
            minHalfExtent: C.minHalfExtent, maxHalfExtent: C.maxHalfExtent,
          });
          if (cone.known && (!cone.centerClear || cone.score < CFG.hold.reoccludeScore)) {
            await cut(r, await framePick(r),
              `shot spoiled — ${!cone.centerClear ? `subject hidden behind ${cone.blockedBy || 'terrain'}` : `frame fell to ${Math.round(cone.score * 100)}%`}`,
              'frame_spoiled');
            continue;
          }
        }
      }

      // NOT during a travel shot: re-seeking mid-journey would move the camera off the destination and
      // reintroduce the mid-travel cut this shot exists to remove.
      if (r.shot.mode !== 'travel' && r.shot.acquired && now - r.shot.tCut >= CFG.timing.minHoldMs
          && now - (r.shot.lastSeekMs || 0) >= 1000) {
        r.shot.lastSeekMs = now;
        const cand = await framePick(r);
        if (!betterShot(cand, r.shot.framing)) {
          recordHold(r, 'no_better', {
            score: cand && cand.coneScore != null ? Math.round(cand.coneScore * 100) : null,
            room: cand && cand.room != null ? Math.round(cand.room) : null,
          });
        }
        if (betterShot(cand, r.shot.framing)) {
          await cut(r, cand, `better vantage (${Math.round(cand.coneScore * 100)}% / ${cand.room.toFixed(0)}b room)`, 'better_vantage');
          continue;
        }
      }

      if (r.shot.firstPerson) continue;   // no frame to exit — see the note at the top of this loop
      const far = dist3d(pos, bp) > CFG.hold.maxSubjectDist;   // walked away to a speck
      // With a live gimbal the frame-exit ANGLE test is meaningless AND harmful: the aim is no longer frozen,
      // so measuring the bot against the CUT-TIME aim reports "left frame" for a bot the gimbal is holding
      // perfectly — and every such report becomes a cut. This is exactly the machinery the design note said
      // continuous aim deletes. Distance still ends a shot: no aim rescues a bot that has walked to a speck.
      const off = gimbalLive(r) ? 0 : aimOffset(r.shot.aim, pos, subjAim(bp));
      const inFrame = off <= CFG.hold.frameExitDeg && !far;
      if (inFrame) { r.shot.acquired = true; r.exitSince = 0; continue; }
      if (!r.shot.acquired) continue;                        // subject still walking in — don't chase
      if (!r.exitSince) { r.exitSince = now; continue; }     // just left — start the grace clock
      if (now - r.exitSince >= CFG.hold.exitGraceMs && now - r.shot.tCut >= CFG.timing.minHoldMs) {
        const why = far ? `subject too far (${dist3d(pos, bp).toFixed(0)} blocks)` : `subject left frame (${off.toFixed(0)}°)`;
        await cut(r, await framePick(r), why, far ? 'too_far' : 'frame_exit');
      }
    }
    crewLog.flush();
  }

  const POS_RE = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/;

  // NO FLOATING NAMES IN THE SHOT. Every player in the world carries a nametag rendered above its head,
  // and it is drawn by the client into the very frame OBS captures — so it is not a HUD element that can
  // be hidden per window, it is part of the picture. A scoreboard team with `nametagVisibility never` is
  // the only server-side switch for it, which is why this lives here: the rig is the one thing in the
  // stack holding an RCON connection.
  //
  // EVERY player, not just the film crew. The bots are the subjects — their names are the ones actually
  // in frame — and the spectators (cameras, gimbals, scout) show their tags to each other, so a camera
  // filming a bot can catch a second camera's name floating behind it.
  //
  // ASSERTED EVERY RUN RATHER THAN SET ONCE BY HAND, and NOT torn down at the end. A team persists in the
  // world's scoreboard data, so this is idempotent and self-healing rather than incremental — the same
  // shape as the `op` grant below, and for the same reason (Invariant B: re-assert, never trust a
  // remembered grant). It is a property of the world, not an artifact of the run, so Law 8's reap does
  // not reach it; a run that deleted the team would be re-creating it on every start for no gain.
  //
  // The pass counter is a bound, not a schedule: `@a` resolves at execution time, so a client that joins
  // late needs another pass to be caught. It stops one pass after the crew is complete — by then every
  // client this run will ever have is standing — and the ceiling only matters on a run that never
  // completes a crew, where it stops this from issuing a command per second forever.
  async function hideNametags() {
    if (filmTeamPasses > FILM_TEAM_MAX_PASSES) return;
    if (!filmTeamCreated) {
      await rcon.command(`team add ${FILM_TEAM}`);           // already-exists answers, never throws
      await rcon.command(`team modify ${FILM_TEAM} nametagVisibility never`);
      filmTeamCreated = true;
      narrate('summary', 'camera_rig',
        `nametags off — team '${FILM_TEAM}' set to nametagVisibility never, and every player joined to it. ` +
        `Names are drawn into the frame by the client, so this is the only way they stay out of the footage.`);
    }
    await rcon.command(`team join ${FILM_TEAM} @a`);
    filmTeamPasses = crewReadyPublished ? FILM_TEAM_MAX_PASSES + 1 : filmTeamPasses + 1;
  }

  async function slowTick() {
    if (!rcon) { await link(); return; }
    await hideNametags();

    // Arm + anchor the scout: spectator (never falls/dies/shows) parked high above the action so it
    // stays within view-distance and is never in a shot.
    //
    // ONE OWNER OF THE SCOUT'S POSITION, and it is this function (Invariant D). Two modes want the scout
    // in two places — framing wants it over the fleet's midpoint, the witness wants it over whichever bot
    // is in a fight — and letting each teleport it would give one camera two writers, which is the same
    // fault as two writers of one state. So the witness RECOMMENDS a target and this decides: a live
    // fight is a more specific answer than a midpoint, so it wins when there is one.
    if (scout && scout.isReady()) {
      if (!scoutArmed) { await rcon.command(`gamemode spectator ${CFG.scout.username}`); scoutArmed = true; }
      const hot = witness ? witness.anchorTarget() : null;
      const ps = rigs.map(r => r.botPos).filter(Boolean);
      let target = null, why = '';
      if (hot) { target = { x: Math.round(hot.x), z: Math.round(hot.z), y: hot.y }; why = ` — following ${hot.bot}'s fight (${hot.from})`; }
      // THE CENTROID PARK IS NOW THE WITNESS-ONLY FALLBACK. With framing live, parkScoutOver stands the
      // scout over each subject as it is scanned, and a centroid re-anchor would drag it straight back off
      // that column — two writers moving one client, which is the shape that produces a scout parked where
      // nobody is (Law 16: one owner). A witness-only run has no seeker to do the standing, so it keeps the
      // centroid: better to cover the middle of the action than to follow nothing.
      else if (!FRAMING && ps.length) {
        target = { x: Math.round(ps.reduce((s, p) => s + p.x, 0) / ps.length),
                   z: Math.round(ps.reduce((s, p) => s + p.z, 0) / ps.length) };
        why = ' — covering the action, out of frame.';
      }
      if (target && (!scoutAnchor || Math.hypot(target.x - scoutAnchor.x, target.z - scoutAnchor.z) > CFG.scout.reanchorDist)) {
        // Overhead when there is a body to be overhead OF (a fight has one), the old fixed ceiling only for
        // the centroid — which is a point in space with no y to be relative to.
        const y = target.y != null ? Math.round(target.y + CFG.scout.parkRise) : CFG.scout.height;
        await rcon.command(`tp ${CFG.scout.username} ${target.x} ${y} ${target.z}`);
        scoutAnchor = { x: target.x, z: target.z }; scoutSettleUntil = Date.now() + CFG.scout.settleMs;
        narrate('summary', 'scout', `re-anchored above (${target.x},${target.z}) @ y=${y}${why}`);
      }
    }

    // The Architect's eye and any other free camera: three commands, once, then never again. Deliberately
    // outside the `rigs` loop and outside the FRAMING gate — this is a seat, not a shot, so it is owed
    // its spectator flag even on a run that places no cameras at all.
    //
    // OPERATOR IS PART OF ARMING, and that is what separates this seat from every other client here. The
    // rig grants three CAPABILITIES and then issues no instruction: spectator so the seat cannot fall,
    // die, or block a mob; night vision so a night flight is usable; and operator so the human flying it
    // can act — teleport to a bot he has lost sight of, change the time, summon something to watch a bot
    // meet, or put himself in creative. Every other client here is DIRECTED (told where to be); this one
    // is EQUIPPED (given what it needs and then left alone), and the difference is the whole point of the
    // seat. Without op the chat this camera now keeps would answer every command with a refusal.
    //
    // NOT A LAW 19 EXEMPTION. That law binds what the CONSTRUCT permits itself in a shared world; this is
    // a human's own client being given a human operator's rights on his own server. Nothing the construct
    // does routes through this seat — the rig never commands it again after these three lines.
    //
    // ISSUED EVERY RUN, not once by hand: `op` persists in the server's ops.json, so this is idempotent
    // and self-healing rather than incremental. A camera whose op was lost to a server reinstall or a
    // reset ops.json re-arms on the next run instead of failing silently at the moment it is needed most
    // (Invariant B — re-assert, never trust a remembered grant).
    for (const name of FREE_CAMS) {
      if (!rcon) return;
      if (freeCamArmed.has(name)) continue;
      const res = await rcon.command(`data get entity ${name} Pos`);
      if (!POS_RE.test(res)) continue;                 // not logged in yet — try again next pass
      await rcon.command(`gamemode spectator ${name}`);
      await rcon.command(`effect give ${name} minecraft:night_vision infinite 0 true`);
      await rcon.command(`op ${name}`);
      freeCamArmed.add(name);
      narrate('summary', 'camera_rig',
        `${name} online — spectator + night vision + OPERATOR, and NOT directed: this rig sends it ` +
        `nothing else. Fly it yourself; chat is on, so /tp /time /gamemode /summon are all yours.`);
    }

    // PRESENT-ONLY: one read each, and nothing else, ever. This is the whole of what the rig does for a
    // seat a human plays — it answers "has this client finished joining" and then leaves it alone.
    for (const name of PRESENT_PLAYERS) {
      if (!rcon) return;
      if (presentConfirmed.has(name)) continue;
      const res = await rcon.command(`data get entity ${name} Pos`);
      if (!POS_RE.test(res)) continue;                 // not logged in yet — try again next pass
      presentConfirmed.add(name);
      narrate('summary', 'camera_rig',
        `${name} standing in the world — confirmed only. This rig sends it NOTHING: it is not a lens, ` +
        `it is a seat, and it stays in whatever gamemode the server gave it.`);
    }

    for (const r of rigs) {
      if (!rcon) return;
      // The bot's position is polled in BOTH modes — the witness needs it to point the eyes at a bot the
      // scout cannot see, which is the only case its nose exists for. Everything else below is the film
      // crew: cameras, gimbals, the startup pin.
      if (!FRAMING) {
        const posRes = await rcon.command(`data get entity ${r.bot} Pos`);
        const pm = posRes.match(POS_RE);
        if (pm) r.botPos = { x: +pm[1], y: +pm[2], z: +pm[3] };
        continue;
      }
      if (!r.ready) {
        const camRes = await rcon.command(`data get entity ${r.cam} Pos`);
        if (POS_RE.test(camRes)) {
          await rcon.command(`gamemode spectator ${r.cam}`);
          await rcon.command(`effect give ${r.cam} minecraft:night_vision infinite 0 true`);
          r.ready = true;
          narrate('summary', r.stage, `${r.cam} online — spectator + night vision, filming ${r.bot}'s announcements.`);
        }
      }

      // Bind the gimbal: spectator first (so it never falls, dies, or contributes anything but a rotation),
      // then lock the camera's view onto it. From here the camera is never teleported again — the rig moves
      // the GIMBAL and the aim rides along, interpolated by this very /spectate.
      if (r.ready && gimbals && gimbals.isReady(r.bot) && !r.gimbalBound) {
        const gname = gimbals.nameFor(r.bot);
        const gRes = await rcon.command(`data get entity ${gname} Pos`);
        if (POS_RE.test(gRes)) {                       // only bind once the gimbal has really spawned
          await rcon.command(`gamemode spectator ${gname}`);
          await rcon.command(`spectate ${gname} ${r.cam}`);
          r.gimbalBound = true;
          narrate('summary', r.stage,
            `${r.cam} → spectating ${gname}: aim is now CONTINUOUS (dead zone ${CFG.gimbal.deadzoneYawDeg}°/${CFG.gimbal.deadzonePitchDeg}°, ease ${CFG.gimbal.easePerTick}/tick, snap-on-cut). Frozen-aim drift is gone.`);
        }
      }
      const res = await rcon.command(`data get entity ${r.bot} Pos`);
      const m = res.match(POS_RE);
      if (m) r.botPos = { x: +m[1], y: +m[2], z: +m[3] };

      // Startup pin: never leave a camera at its logout spot. Once online with no shot, frame whatever
      // the subject brain picks (no objective yet → the bot's current spot; one sample, not a follow).
      if (r.ready && !r.shot && r.botPos) {
        await cut(r, await framePick(r), 'startup pin — no announcement yet', 'startup');
      }
      if (r.botPos && Date.now() - r.lastEventMs > CFG.timing.droughtMs) {
        r.lastEventMs = Date.now();
        narrate('warn', r.stage, `no recognizable announcement from ${r.bot} in ${CFG.timing.droughtMs / 60000}m — log formats may have drifted past the parser.`);
      }
    }

    publishCrewReady();
  }

  // THE ONE PLACE THAT KNOWS THE FILM CREW IS REALLY IN THE WORLD, published so a machine can wait on it.
  //
  // Launching a game client and having a game client standing in the world are different facts separated
  // by tens of seconds of loading. The launcher owns only the first — it returns the moment the process
  // starts — so anything that gated on the launcher returning was gating on nothing. This rig already
  // holds the second fact as a side effect of arming: a camera is armed only after `data get entity` came
  // back with a position, which the server answers only for a client that has finished joining. So
  // readiness is not computed here, it is REPORTED here (Law 25 — the true result, not a proxy for it).
  //
  // WHY A FILE AND NOT A SECOND POLL IN THE WAITER: the alternative is the waiter opening its own RCON
  // connection and asking the same question, which is one capability with two implementations (Law 16).
  // The rig is the owner; a consumer reads the owner's published state (Law 6).
  //
  // WRITE-ONLY HERE (Law 9): this unit writes this file and never deletes it. The consumer that clears
  // it before a raise is the one that waits on it, so neither unit does both to the same file.
  // PRESENT-ONLY CLIENTS COUNT TOWARDS THE CREW, and that is the reason they are passed here at all.
  // The waiter's whole question is "may OBS bind now", and a host window still on a loading screen is
  // exactly the case that must answer no. A run whose ONLY client is the host seat (a let's play that
  // has not hired anybody yet) therefore has a real crew to publish rather than an empty one.
  function publishCrewReady() {
    if (crewReadyPublished) return;
    const expected = (FRAMING ? rigs.map(r => r.cam) : []).concat(FREE_CAMS).concat(PRESENT_PLAYERS);
    if (!expected.length) return;
    const armed = new Set([...freeCamArmed, ...presentConfirmed, ...rigs.filter(r => r.ready).map(r => r.cam)]);
    if (!expected.every(name => armed.has(name))) return;
    fs.writeFileSync(READY_FILE, JSON.stringify({ ready: true, cams: expected, at: new Date().toISOString() }, null, 2));
    crewReadyPublished = true;
    narrate('summary', 'camera_rig',
      `crew ready — ${expected.length} client(s) confirmed standing in the world (${expected.join(', ')}). ` +
      `Published to ${path.basename(READY_FILE)}; whatever is waiting to start the fleet may proceed.`);
  }

  narrate('summary', 'camera_rig',
    `up in ${[FRAMING ? 'FRAMING' : null, WITNESS ? 'WITNESS' : null].filter(Boolean).join(' + ')} mode. ` +
    'Decisions → watcher_camera_rig.json');
  if (FRAMING) {
    for (const r of rigs) {
      try {
        const n = (JSON.parse(fs.readFileSync(r.tail.file, 'utf8')).story || []).length;
        narrate('summary', r.stage, `story file ${path.basename(r.tail.file)} found (${n} lines of history — skipped; filming from now).`);
      } catch (_) {
        narrate('warn', r.stage, `story file ${path.basename(r.tail.file)} missing/unreadable — no announcements from ${r.bot} until its process runs.`);
      }
    }
  }
  const launcherLog = new LauncherLog(LAUNCH_LOG_DIR);
  if (LAUNCH_LOG_DIR && FRAMING) narrate('summary', 'launcher', `digesting Prism launch logs from ${LAUNCH_LOG_DIR}`);
  narrate('summary', 'scout', scout ? `scout enabled (${CFG.scout.username}) — ray loops yield every ${CFG.scout.scanSliceMs || 8}ms and stamp their own deaf spans.` : 'scout disabled — blind default framing (approach-side placement only).');

  watcher.timer.start('film_session');
  await link();
  // slowTick runs in BOTH modes — it owns the rcon relink, the bot position poll and the scout's anchor,
  // and the witness depends on all three. Every other timer is the film crew's.
  // ONE TICK OF EACH AT A TIME. These are async bodies on a fixed interval, so a slow pass used to overlap
  // the next one — tolerable while a solve was tens of milliseconds, and not tolerable now that framePick can
  // hold the pass open for a scout park. Two overlapping holdTicks both see the same pre-cut state and can
  // both decide to cut, which is a double teleport and two CUT lines for one decision. The guard SKIPS
  // rather than queues: a dropped 250 ms tick costs one poll, a queued one builds a backlog that replays
  // stale decisions against a world that has moved.
  const guard = (name, fn) => {
    let running = false;
    return () => {
      if (running) return;
      running = true;
      Promise.resolve().then(fn).catch(e => narrate('warn', 'camera_rig', `${name}: ${e.message}`))
        .finally(() => { running = false; });
    };
  };
  setInterval(guard('slow tick', slowTick), CFG.timing.posPollMs);
  if (FRAMING) {
    setInterval(guard('log tick', logTick), CFG.timing.logPollMs);
    setInterval(guard('hold tick', holdTick), Math.round(1000 / CFG.hold.checkHz));
    setInterval(() => { try { digestLauncherLogs(launcherLog); } catch (e) { narrate('warn', 'launcher', `digest: ${e.message}`); } }, 5000);
  }

  process.on('SIGINT', () => {
    if (FRAMING) for (const r of rigs) {
      narrate('summary', r.stage, `session end — ${r.cutNo} cuts, last shot ${r.shot ? `${r.shot.type} @ ${fmt(r.shot.at)}` : 'none'}.`);
      crewLog.event(r.stage, 'session', { state: 'end', cuts: r.cutNo, shot: r.shot ? r.shot.type : 'none' });
    }
    // The one quantity no event can carry: a raycast makes the client deaf while it runs, and the cost of
    // that is true of the casts that reported nothing as much as of the ones that did. It is an aggregate
    // for the same reason the crew seats keep theirs — it is a fact about the ticks that emitted nothing.
    if (scout && scout.blindStats) {
      const b = scout.blindStats();
      crewLog.event('scout', 'blind', { spans: b.spans, ms: b.blockedMs });
    }
    crewLog.flush();   // the last pass is never left in the buffer (Law 8: nothing outlives the run that raised it)
    // The witness closes BEFORE the scout: it reads the scout's blind-span totals into its trailer, and
    // it has to terminate any fight still open (Law 8 — an unterminated start row makes the reader see a
    // fight running past the end of the file).
    if (witness) {
      const s = witness.stats();
      witness.close();
      narrate('summary', 'witness',
        `session end — ${s.engagements} engagement rows, ${s.samples} samples, ${s.observed} server events, ` +
        `${s.nose} nose readings, ${s.dropped} unseen ticks${s.capped ? ', RECORD TRUNCATED (cap hit)' : ''}.`);
    }
    if (scout) scout.end();
    if (gimbals) gimbals.endAll();   // Law 8: every client this run raised, this run closes.
    watcher.timer.stop('film_session');
    watcher.flushNow();
    process.exit(0);
  });
}

function reportCrash(kind, e) {
  try {
    narrate('error', 'camera_rig',
      `${kind}: ${(e && e.stack) || e} — the director is DOWN; cameras hold their last position. Fix and restart start_cameras.ps1.`);
    watcher.flushNow();
  } catch (_) { console.error(e); }
  process.exit(1);
}

if (require.main === module) {
  process.on('uncaughtException', e => reportCrash('uncaught exception', e));
  process.on('unhandledRejection', e => reportCrash('unhandled rejection', e));
  main().catch(e => reportCrash('startup failure', e));
}

// The director's brain, exposed for dry-run testing against recorded story files.
module.exports = { extractEvent, StoryTail, solveView, modeParams, betterShot, aimAt, aimOffset };
