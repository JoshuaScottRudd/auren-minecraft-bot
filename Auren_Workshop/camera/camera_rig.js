// Auren_Workshop/camera/camera_rig.js
// Event-driven spectator camera director — a read-only observer outside the construct (Law 19: films
// the shared world, never acts in it). Every knob lives in camera_configure.js.
// The camera always aims at the bot; the objective sets shot SIZE and travel-leg camera position only.
// Every shot resolves through one solver, solveView (Law 16): senses open sightlines via
// castVisibilityField, places candidates at real openings, scores them, confirms with the 117-ray cone.
// Position locks at the cut; aim belongs to camera_gimbal.js, a headless client the camera /spectate's.
// The director re-seeks ~1×/s mid-hold (betterShot) and re-tests occlusion on hold.occlusionCheckMs.
// The see-through shot is a second camera for enclosed/underground filming — see camera_configure's
// SEE-THROUGH section.
// Collaborators: Watcher story files (objective = goTo destination; navigator cost = leg length) ·
// camera_scout.js (cone raycast, smooth bot positions) · Prism spectators (cameras, RCON tp).
// Diagnostics: BOT_ID=camera_rig → fleet_logs/traces/watcher_camera_rig.jsonl (monitoring/camera_lens
// reads it).

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/camera/camera_rig.js');

const paths = require('../workshop_paths');
// Registers NODE_PATH aliases before any bot require.
paths.registerAliases();

process.env.BOT_ID = process.env.BOT_ID || 'camera_rig';   // must precede the watcher require
const watcher = require(paths.bot('js_kernel/watcher.js'));

// crew_log: the fleet's `VERB key=value` trace grammar (Law 16, Law 26) — this file's decisions use it too.
const crewLog = require(paths.bot('custom_api/crew_log.js'));
const CFG = require('./camera_configure.js');
const { SERVER_ENDPOINT, SERVER_MINECRAFT_VERSION } = require(paths.bot('Thinking_fragments/architect_config.js'));
const { createScout } = require('./camera_scout.js');
const { createGimbals } = require('./camera_gimbal.js');
const { createWitness } = require('./combat_witness.js');

const fs = require('fs');
const path = require('path');

// Blocks a raycast passes through but a viewer cannot see past (sugar cane, tall grass, ferns, vines).
const VISUAL_BLOCKERS = new Set(CFG.frame.visualBlockers || []);

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const { BOT_SENIORITY } = require(paths.bot('Thinking_fragments/architect_config.js'));
// An empty --bots is a legitimate answer: a contractor run can have no crew yet.
const BOTS = opt('bots', Object.keys(BOT_SENIORITY).join(',')).split(',').map(s => s.trim()).filter(Boolean);
const CAMS = opt('cams', BOTS.map(b => `Cam_${b}`).join(',')).split(',').map(s => s.trim()).filter(Boolean);
const LAUNCH_LOG_DIR = opt('launchlogs', '').replace(/^['"]|['"]$/g, '');
if (CAMS.length !== BOTS.length) {
  console.error('camera_rig: --cams must list one camera name per bot.');
  process.exit(1);
}

// Free cameras: spectator + night vision only, never cut/teleported/gimbal-bound. Human-flown.
const FREE_CAMS = opt('freecams', '').split(',').map(s => s.trim()).filter(Boolean);
// Seats a person flies that start from a declared spot rather than the base (camera_configure).
const FIXED_SPOTS = (CFG.architect && CFG.architect.fixed) || {};
// Game rules turned off while cameras are up: command echoes in chat, admin commands in the log, and the
// locator bar on the HUD.
const CAMERA_GAMERULES_OFF = ['send_command_feedback', 'log_admin_commands', 'locator_bar'];

// Present-only clients (e.g. the host seat): confirmed standing via `data get entity`, never armed or
// directed. Carries in-world player names, unlike the window names in the other two lists.
const PRESENT_PLAYERS = opt('presentplayers', '').split(',').map(s => s.trim()).filter(Boolean);

// mode.framing defaults OFF (Law 13); --framing=on/off overrides camera_configure.js's setting.
const FRAMING_ARG = opt('framing', null);

function narrate(level, stage, message) {
  const icon = level === 'warn' ? '⚠️ ' : level === 'error' ? '❌ ' : '';
  console.log(`${icon}[${stage.toUpperCase()}] ${message}`);
  watcher[level](stage, message);
}

// RCON protocol: js_kernel/utils/rcon_link, shared by every caller (Law 16).
const { readServerProperties, open: rconConnect } = require(paths.bot('js_kernel/utils/rcon_link'));

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────
const dist3d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = p => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
const shortAngle = a => ((a + 180) % 360 + 360) % 360 - 180;

// aimAt: yaw/pitch looking from cam toward target. MC: yaw 0 faces +Z, +pitch down.
function aimAt(cam, target) {
  const lx = target.x - cam.x, ly = target.y - cam.y, lz = target.z - cam.z;
  const len = Math.hypot(lx, ly, lz) || 1;
  return { yaw: -Math.atan2(lx, lz) * 180 / Math.PI, pitch: -Math.asin(ly / len) * 180 / Math.PI };
}
// subjAim: the frozen-shot aim point (aimRise above the feet), shared by the cut and the frame-exit test.
const subjAim = p => ({ x: p.x, y: p.y + CFG.frame.bot.aimRise, z: p.z });

// aimOffset: degrees a point sits off the frozen aim — the frame-exit test.
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
// Frames the bot: senses open directions via castVisibilityField, ranks them, and confirms the chosen
// candidate against the 117-ray cone. Falls back to FIRST-PERSON when no direction offers room.
// opts: { preferredDist, maxRange, approachDir, lastBearingDeg, underground, miningJob, label }.
// Returns { cam, aim, subjectAt, kind, bearingDeg, coneScore, room, note, search, rays }.
async function solveView(subject, sc, opts) {
  const W = CFG.frame.weights, F = CFG.frame.field, B = CFG.frame.bot;
  const pref = opts.preferredDist;
  const aimPt = { x: subject.x, y: subject.y + B.aimRise, z: subject.z };
  // THE CAMERA LADDER: camHeight is the bottom rung (bot eye level); field.elevs are the rungs above it.
  // `cam` below is a LENS position throughout; sendCam converts to feet for the teleport.
  const eyePt = { x: subject.x, y: subject.y + CFG.frame.camHeight, z: subject.z };
  // `usable` casts one margin past the shot ceiling so the ceiling itself stays reachable.
  const maxRange = (opts.maxRange || pref) + F.margin;
  // `note`/`search` mirror the seek as trace fields for monitoring/camera_lens. Every branch sets `verdict`.
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

  // THE SEE-THROUGH SHOT: fixed distance/rise tripod for enclosed filming, aimed down at the bot. See
  // camera_configure's SEE-THROUGH section.
  const seeThroughShot = (why) => {
    const E = CFG.frame.enclosed;
    const d = dir2d(blindAz);
    const cam = { x: subject.x + d.x * E.distance, y: subject.y + E.rise, z: subject.z + d.z * E.distance };
    const f = mk(cam, blindAz * 180 / Math.PI, E.distance, 1, `see-through d${E.distance} h${E.rise}`, why, 0);
    sweep.verdict = 'see_through';
    // No cone is run: a spectator renders through rock, so block-occupancy tests would read "blocked"
    // through a clear picture (Law 26). Records the subject's depth against `undergroundY` instead.
    sweep.subject = true;   // it is seen through the rock — that is the premise of this branch
    sweep.depth = Math.round(subject.y);
    f.seeThrough = true;
    return f;
  };

  // THE FIRST-PERSON SHOT: the camera /spectate's the BOT itself when no direction offers room to place
  // a lens. No gimbal, no occlusion test — the aim is the bot's own head.
  const firstPersonShot = (why) => {
    const cam = { x: subject.x, y: subject.y + CFG.frame.camHeight, z: subject.z };
    const f = mk(cam, opts.lastBearingDeg || 0, 0, 1, 'first person — no room for a camera', why, 0);
    sweep.verdict = 'first_person';
    f.firstPerson = true;
    return f;
  };

  // A forced first-person request is routed through this same branch (Law 16).
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
  // rungOf: F.elevs index = height rank (config can re-space rungs freely).
  const rungOf = elevDeg => { const i = F.elevs.indexOf(elevDeg); return i < 0 ? 0 : i; };
  // ── THE SEEK: rank rays, take the first that clears the boxes ──────────────────────────────
  // roomyDirs counts usable directions before any box-test rejection — "no candidates" vs "no room"
  // are different verdicts (first person fires only on the latter).
  let roomyDirs = 0;
  for (const r of field.rays) if (Math.min(pref, r.clearDist - F.margin) >= F.minUsable) roomyDirs++;
  sweep.roomy = roomyDirs;

  // A mining job with a starved field is SEE-THROUGH (underground): a spectator renders through rock,
  // so there is no "too tight to fit".
  if (opts.miningJob && !roomyDirs) {
    return seeThroughShot(`enclosed: mining job + no room in any dir — treated as rock`);
  }

  // No usable direction above ground → first person.
  if (!roomyDirs) return firstPersonShot(`no direction offers ${F.minUsable}b of ${field.rays.length} rays`);

  // Ordered FARTHEST first (reach), then LOWEST rung to break ties (leaf canopy sits above a bot).
  // Reach bucketed to the half block to avoid float-noise ties.
  const bucket = u => Math.round(u * 2) / 2;
  let ordered = [...field.rays].sort((a, b) =>
    (bucket(b.clearDist) - bucket(a.clearDist)) || (rungOf(a.elev) - rungOf(b.elev)));

  // 30-degree rule: consecutive shots differ by ≥minBearingChangeDeg or a cut reads as a nudge.
  // Relaxes (and records it) when no direction offers a fresh bearing.
  let bearingRelaxed = false;
  if (opts.lastBearingDeg != null) {
    const differing = ordered.filter(r => angDiffDeg(r.az, opts.lastBearingDeg) >= W.minBearingChangeDeg);
    if (differing.length) ordered = differing; else bearingRelaxed = true;
    sweep.relaxed = bearingRelaxed;
  }

  // First direction whose lens cell clears two tests: the AIR BOX (clearance for a rotating gimbal on
  // any bearing) and the LENS BOX (a clear tube over the near field). `margin` must exceed `airBox` for
  // either to pass at all — see camera_configure's margin note.
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

  // Nothing cleared the boxes → take the furthest-reaching direction anyway and RECORD the failure (Law 25).
  const forced = !chosen;
  if (forced) { const ray = ordered[0]; chosen = { ray, cam: lensAt(ray, setback(ray)), usable: setback(ray) }; }
  sweep.verdict = forced ? 'forced' : 'clear';

  // Records whether the lens can see the bot (`centerClear`) — after the choice, never gating it.
  const seen = await sc.coneClear(chosen.cam, aimPt, { gridH: 1, gridV: 1, visualBlockers: VISUAL_BLOCKERS });
  rays += 1;
  sweep.subject = seen.known ? !!seen.centerClear : null;
  sweep.blockedBy = seen.known && !seen.centerClear ? (seen.blockedBy || null) : null;
  sweep.el = Math.round(chosen.ray.elev || 0);
  sweep.usable = Math.round(chosen.usable * 10) / 10;
  // coneScore: subject visibility for betterShot's mid-hold ranking (1 seen, 0 hidden; unknown = 1).
  const coneScore = sweep.subject === false ? 0 : 1;
  const bearingDeg = chosen.ray.az;    // castVisibilityField reports az in DEGREES already
  return mk(chosen.cam, bearingDeg, chosen.ray.clearDist, coneScore,
    `az${Math.round(bearingDeg)}° el${sweep.el}° d${chosen.usable.toFixed(1)} h${(chosen.cam.y - subject.y).toFixed(1)} ` +
    `(${forced ? 'FORCED — nothing cleared the boxes' : 'clear'}, ${chosen.ray.clearDist.toFixed(0)}b room` +
    `${sweep.subject === false ? `, SUBJECT HIDDEN behind ${sweep.blockedBy || 'terrain'}` : ''})`,
    // Arity: mk(cam, bearingDeg, room, coneScore, note, search, rays) — seven args.
    `${roomyDirs} roomy dirs of ${field.rays.length} rays (rejected: airbox ${airRejects}, lensbox ${frontRejects})` +
    `${bearingRelaxed ? ' · 30° RELAXED' : ''} · ${forced ? 'none cleared' : 'cleared'}`, rays);
}

// Per-mode seeker params (distance, angle bias), clamped to frame.maxShotDist.
function modeParams(mode) {
  const Wd = CFG.frame.wide, O = CFG.frame.objective, W = CFG.frame.weights;
  const cap = CFG.frame.maxShotDist;
  const clamp = p => ({ ...p, preferredDist: Math.min(p.preferredDist, cap), maxRange: Math.min(p.maxRange, cap) });
  if (mode === 'wide')   return clamp({ preferredDist: Wd.distance, maxRange: Wd.distance });
  if (mode === 'travel') return clamp({ preferredDist: O.travelDistance, maxRange: O.travelDistance });
  return clamp({ preferredDist: W.preferredDist, maxRange: W.preferredDist });
}

// betterShot: worth cutting to mid-hold? Requires a real ≥30°-different bearing AND either a cleaner
// frame (+seek.improve) or more room (+seek.minRoomGain) without losing clarity.
function betterShot(cand, cur) {
  if (!cand || !cur) return false;
  const W = CFG.frame.weights, K = CFG.frame.seek;
  // First person yields to any real camera immediately — it is a stopgap, not a vantage to protect.
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
  if (sys === 'FOREMAN_LINK' && line.includes('Online at')) {
    return { kind: 'cut', type: 'OPENING', at: xyz(line.match(PAREN)) };
  }
  if ((sys === 'SET_BUILDSPOT' && line.includes('transpose_origin'))
      || ((sys === 'SET_BUILDSPOT' || sys === 'CORPORATE_HEADQUARTERS') && line.includes('uild center'))) {
    return { kind: 'cut', type: 'SITE', at: xyz(line.match(PAREN)) };
  }
  if (sys === 'LOCOMOTION_DISPATCHER' && line.includes('goTo')) {
    return { kind: 'journey', at: xyz(line.match(/goTo\s*\S*\s*\((-?\d+),(-?\d+),(-?\d+)\)/)) };
  }
  // NAVIGATOR: A* cost for the current leg, read to pick travel-shot vs staged-objective.
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

// StoryTail: polls one bot's watcher_<Bot>.jsonl; a SHRINK (restart) replays from the new top.
// Append-only file — a mid-write read catches only the last line, recovered next poll.
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

  // FRAMING places/cuts cameras; WITNESS records fights. Share one scout + rcon link. Both default off (Law 8).
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

  // Cameras already armed to spectator — server-side and persistent, so armed once per run.
  const freeCamArmed = new Set();

  // Present-only clients already confirmed standing.
  const presentConfirmed = new Set();

  // Published once, when every expected client is confirmed in the world. See publishCrewReady().
  const READY_FILE = paths.bot('js_kernel', 'camera_rig_ready.json');
  let crewReadyPublished = false;

  // Nametags: hidden via a scoreboard team (see hideNametags).
  const FILM_TEAM = 'auren_no_nametags';
  const FILM_TEAM_MAX_PASSES = 300;
  let filmTeamCreated = false;
  let filmTeamPasses = 0;

  let scout = null;
  let scoutArmed = false;
  let scoutAnchor = null;
  let scoutSettleUntil = 0;
  // One scout client answers both framing (where to stand) and witness (what happened) — Law 16.
  // Framing with no bot camera has no shot to place, so a crew of human-flown seats raises no scout.
  if (CFG.scout.enable && ((FRAMING && BOTS.length > 0) || WITNESS)) {
    scout = createScout({
      host: SERVER_ENDPOINT.host, port: SERVER_ENDPOINT.port, version: SERVER_MINECRAFT_VERSION, username: CFG.scout.username,
      scanSliceMs: CFG.scout.scanSliceMs,
      // Posted immediately from the client's socket callbacks, not buffered with this file's passes.
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

  // parkScoutOver: stands the eyes over the subject before every scan (a loaded chunk is a full column,
  // so only the horizontal position matters). Waits by reading the subject's own cell, not a fixed clock
  // (Law 23). A live fight (witness's hot anchor) owns the scout and is not interrupted (Law 16).
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
    // Records why a scan went blind, if the chunks never streamed in.
    crewLog.event('scout', 'park', {
      at: `(${target.x},${target.y},${target.z})`, loaded: loaded ? 'yes' : 'no', ms: waited,
    });
  }

  // Gimbal per bot owns the aim (camera_gimbal.js); missing gimbal falls back to a frozen-aim tripod.
  let gimbals = null;
  if (CFG.gimbal.enable && FRAMING) {
    gimbals = createGimbals({
      bots: BOTS, host: SERVER_ENDPOINT.host, port: SERVER_ENDPOINT.port, version: SERVER_MINECRAFT_VERSION, cfg: CFG.gimbal,
      // Same blocker list the seeker places on (Law 16) — one definition of "blocked" for both.
      visualBlockers: VISUAL_BLOCKERS,
      log: msg => narrate('summary', 'gimbal', msg),
    });
    if (gimbals.available === false) {
      narrate('warn', 'gimbal', `mineflayer gimbal unavailable (${gimbals.reason}) — falling back to FROZEN-AIM tripod shots (a traversing bot will drift out of frame).`);
      crewLog.post('gimbal', 'link', { state: 'absent', why: gimbals.reason });
      gimbals = null;
    }
  }
  // gimbalDetached: the see-through shot's deliberate release, treated identically to a missing gimbal (Law 16).
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

  // The witness: records the server's account of fights. Borrows the rcon link through an adapter
  // (rcon is reassigned on relink).
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
      // World rules for filming, by their 26.1 names (snake_case). `locator_bar` is the HUD strip of
      // coloured player dots along the bottom of every client's screen, which is in every frame a camera
      // films while it is on. Each reply is read back: a rule the server does not know answers with an
      // error rather than a change, and that is reported rather than assumed set (Law 23).
      for (const rule of CAMERA_GAMERULES_OFF) {
        const said = (await rcon.command(`gamerule ${rule} false`)) || '';
        if (!/now set to/i.test(said)) narrate('warn', 'camera_rig', `gamerule ${rule} was not set: the server said "${said.trim()}".`);
      }
      narrate('summary', 'camera_rig',
        `rcon up · ${BOTS.map((b, i) => `${b}→${CAMS[i]}`).join(' · ')} · absorb=${CFG.frame.absorbRadius} min_hold=${CFG.timing.minHoldMs / 1000}s field≈${CFG.frame.field.azSteps * CFG.frame.field.elevs.length} rays/seek margin=${CFG.frame.field.margin}>airbox=${CFG.frame.field.airBox} spoil-cone=${CFG.frame.cone.gridH}×${CFG.frame.cone.gridV}`);
    } catch (e) {
      if (!announcedDown) { console.log(`waiting for the server (rcon: ${e.message})...`); announcedDown = true; }
    }
    linking = false;
  }

  // sendCam: with a live gimbal, teleports the GIMBAL only (aim rides the /spectate); without one, sends
  // position+aim in one tp (frozen tripod). `pos` is a LENS position; feetY converts to the teleport's
  // feet-anchored coordinate.
  const feetY = y => y - CFG.frame.eyeHeight;
  const sendCam = (r, pos, aim) => {
    if (gimbalLive(r)) {
      return rcon.command(`tp ${gimbals.nameFor(r.bot)} ${pos.x.toFixed(1)} ${feetY(pos.y).toFixed(1)} ${pos.z.toFixed(1)}`);
    }
    return rcon.command(`tp ${r.cam} ${pos.x.toFixed(1)} ${feetY(pos.y).toFixed(1)} ${pos.z.toFixed(1)} ${aim.yaw.toFixed(1)} ${aim.pitch.toFixed(1)}`);
  };

  // cut: the only moment a camera moves — one tp into a frozen framing, held until frame-exit or
  // maxHold. `trigger` is the trace sentence; `why` is its token for the lens (Law 26 — not derived
  // from the sentence).
  async function cut(r, framing, trigger, why) {
    const place = framing.subjectAt;
    const type = framing.kind;
    // A same-spot re-tp is not a cut: the hold clock restarts instead of firing again. Compared
    // per-mode (bot/free/gimbal), since a first-person `cam` (the bot's eye) can sit within
    // sameShotDist of any tripod.
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
    // Hands the aim over at the cut. Three modes, as a state machine:
    //   gimbal — the normal shot: the gimbal owns the aim and the camera rides it
    //   free   — the see-through tripod: released, aimed directly by tp
    //   bot    — first person: the camera IS the bot's eyes, and there is nothing to aim or place
    if (gimbals && r.gimbalBound) {
      const want = framing.firstPerson ? 'bot' : (framing.seeThrough ? 'free' : 'gimbal');
      if (want !== (r.specMode || 'gimbal')) {
        // Bare `/spectate` releases the console (the sender), not the camera — `execute as <cam>` is required.
        if (want === 'free') await rcon.command(`execute as ${r.cam} run spectate`);
        else if (want === 'bot') await rcon.command(`spectate ${r.bot} ${r.cam}`);
        else await rcon.command(`spectate ${gimbals.nameFor(r.bot)} ${r.cam}`);
        r.specMode = want;
        r.gimbalDetached = (want !== 'gimbal');   // everything downstream still keys off gimbalLive()
      }
    }
    // First person is a binding, not a position — nothing is teleported.
    if (!framing.firstPerson) await sendCam(r, framing.cam, r.shot.aim);
    // Gimbal snaps to the new aim at the cut.
    if (gimbalLive(r) && !framing.firstPerson) gimbals.snap(r.bot);
    // Re-asserts the /spectate binding every cut (it can drop on respawn/chunk churn).
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

  // Posted for every seek, including ones that hold still — a camera holding still is still deciding.
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
      // subject: was the bot visible from the chosen vantage (score alone measures the frame, not this).
      subject: w.subject == null ? null : (w.subject ? 'yes' : 'no'),
      by: w.blockedBy || null,
      depth: w.depth != null ? w.depth : null,
    });
  }

  // recordScoutLos: the SCOUT's own line to the bot — the measurement's health, distinct from `sight`
  // (which watches the CAMERA's line). Reuses coneClear at 1×1 (Law 16). Posted on state change only.
  async function recordScoutLos(r, sc, subjectAt) {
    if (!sc) return;
    const eye = sc.selfPos ? sc.selfPos() : null;
    if (!eye) return;
    const line = await sc.coneClear(eye, subjectAt, { gridH: 1, gridV: 1 });
    // known:false = scout can't answer (unstreamed column) — distinct from blocked (Law 25).
    const state = !line.known ? 'unknown' : (line.centerClear ? 'clear' : 'blocked');
    if (r.lastLosState === state) return;
    r.lastLosState = state;
    crewLog.event(r.stage, 'los', {
      state,
      by: state === 'blocked' ? (line.blockedBy || 'unknown') : null,
      from: p3(eye), to: p3(subjectAt),
    });
  }

  // Posted on a change of reason only — repeats at the seek rate otherwise.
  function recordHold(r, why, fields) {
    if (r.lastHoldWhy === why) return;
    r.lastHoldWhy = why;
    crewLog.event(r.stage, 'hold', Object.assign({ why }, fields || {}));
  }

  // The bot's freshest position (scout's smooth read, else the RCON poll).
  const botNow = r => (scout && scout.entityPos(r.bot)) || r.botPos;

  // chooseSubject: what this shot frames — always the bot itself. The objective biases camera POSITION
  // (approach side) and shot SIZE only, never the aim.
  //   wide   — bot idle above ground: high, wide establishing shot.
  //   travel — leg > travelCutMinDist: camera waits at the DESTINATION, bot walks in, held to arrival.
  //   bot    — default normal-distance follow.
  // Returns { mode, subject:botPos } or null when there's no bot to film yet.
  function chooseSubject(r) {
    const O = CFG.frame.objective;
    const bp = botNow(r);
    if (!bp) return null;
    const idle = Date.now() - r.lastEventMs > O.idleDroughtMs;
    // Wide only applies above ground; underground gets a normal tracking shot.
    if (idle && bp.y >= CFG.frame.undergroundY) return { mode: 'wide', subject: bp };
    // Destination shot gated on the gimbal (needs live aim) and ceilinged at travelStageMaxDist (the
    // gimbal loses the bot past its entity range); longer legs are filmed by following instead.
    const legDist = r.objective ? dist3d(bp, r.objective) : 0;
    if (r.objective && !idle && legDist > O.travelCutMinDist && legDist <= O.travelStageMaxDist) {
      return { mode: 'travel', subject: bp };
    }
    return { mode: 'bot', subject: bp };
  }

  // framePick: builds the locked framing for the current subject via the per-mode seeker params and the
  // approach side/last bearing. Always returns a framing (solveView guarantees it).
  async function framePick(r, pickOpts) {
    const sub = chooseSubject(r);
    if (!sub) return null;
    const bp = botNow(r);
    // Approach side: camera scores toward the bot's walk direction so the bot walks into the lens.
    let approachDir = null;
    if (r.objective && bp && (sub.mode === 'bot' || sub.mode === 'travel')) {
      const v = { x: r.objective.x - bp.x, z: r.objective.z - bp.z };
      if (Math.hypot(v.x, v.z) >= 1) approachDir = norm2d(v);
    }
    // Travel leg with a live gimbal solves around the OBJECTIVE, not the walking bot.
    const framedOn = (sub.mode === 'travel' && gimbalLive(r) && r.objective) ? r.objective : sub.subject;
    // Parks the scout over `framedOn` (destination on a travel leg) before scanning.
    await parkScoutOver(framedOn, ` — scanning for ${r.bot}`);
    const sc = usableScout();
    const underground = framedOn.y < CFG.frame.undergroundY;
    // The bot's own claimed job — the second enclosure signal, read only with a starved field.
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
    // Recorded here, not at the cut — most seeks end in no movement and are still real decisions.
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

    // Every located announcement sets the objective, the sole location marker.
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

  // logTick: one crew_log line per rig per pass, not per fact — `flush` drains the buffer at the pass
  // boundary. Flushed outside the rig loop so one rig's flush doesn't split another's still-buffering line.
  async function logTick() {
    for (const r of rigs) {
      for (const line of r.tail.poll()) {
        const ev = extractEvent(line);
        if (ev) await onEvent(r, ev, line);
      }
    }
    crewLog.flush();
  }

  // holdTick: every shot is a locked tripod — re-asserts position/aim on a heartbeat, decides WHEN to cut.
  async function holdTick() {
    if (!rcon) return;
    const now = Date.now();
    for (const r of rigs) {
      if (!r.ready || !r.shot) continue;

      const pos = r.shot.framing.cam;
      // Heartbeat re-asserts the shot: a position tp for a tripod, a /spectate re-bind for first person.
      if (now - r.lastSentMs > CFG.hold.heartbeatMs) {
        if (r.shot.firstPerson) await rcon.command(`spectate ${r.bot} ${r.cam}`);
        else await sendCam(r, pos, r.shot.aim);
        r.lastSentMs = now;
      }

      const bp = botNow(r);

      // First person cannot spoil (no sightline to test) and stays ACQUIRED so the motivated re-seek
      // below — its only way out — keeps hunting for a real vantage every pass.
      r.shot.acquired = true;

      // Travel shot re-cuts to a closer tracking shot on arrival at the objective.
      if (r.shot.mode === 'travel' && r.objective && bp
          && dist3d(bp, r.objective) <= CFG.frame.objective.arrivalRadius
          && now - r.shot.tCut >= CFG.timing.minHoldMs) {
        await cut(r, await framePick(r), 'arrival — bot reached objective', 'arrival');
        continue;
      }

      // Caps how long any shot holds; a TRAVEL shot is exempt (ends on arrival instead — see above).
      // travelMaxHoldMs is a stuck-bot safety valve.
      const holdCap = r.shot.mode === 'travel' ? CFG.frame.objective.travelMaxHoldMs : CFG.timing.maxHoldMs;
      if (now - r.shot.tCut >= holdCap) {
        await cut(r, await framePick(r),
          `mandatory reposition (${Math.round((now - r.shot.tCut) / 1000)}s)`, 'max_hold');
        continue;
      }

      // ── SUBJECT LOST: the one fast cut, ignoring minHold — rate-limited by blockedMinHoldMs instead.
      // Exempt: an unarrived TRAVEL leg (hidden is normal there) and a SEE-THROUGH tripod (renders
      // through rock). Gimbal occlusion is recorded on a flip only (Invariant D: gimbal measures, rig speaks).
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
        // Thrash guard: a shot blocked almost immediately goes first person instead of re-seeking into
        // the same obstruction. Timed from when the block began (see hold.thrashWindowMs in camera_configure).
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

      // No re-seek while the thrash guard's first-person window is running.
      if (r.firstPersonUntil && now < r.firstPersonUntil) {
        recordHold(r, 'thrash_hold', { left: Math.round((r.firstPersonUntil - now) / 1000) });
        continue;
      }

      // Idle WIDE shot holds without chasing; every other shot follows the bot.
      if (r.shot.noFollow) continue;

      if (!bp) continue;

      // Re-checks occlusion mid-hold (the cut-time cone verdict can go stale), skipped on a see-through
      // shot or an unarrived travel leg, where "hidden" is the normal state of the leg.
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

      // Skipped mid-travel: re-seeking would move the camera off the destination.
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
      // A live gimbal skips the frame-exit angle test (aim is unfrozen); distance still ends a shot.
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

  // Nametags are drawn into the frame by the client, so the fix is a scoreboard team
  // (`nametagVisibility never`), asserted every run (idempotent, Invariant B) and joined by @a —
  // including the spectators, so one camera doesn't catch another's name floating behind a bot.
  // Pass counter stops one pass after the crew completes.
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

    // Arms the scout to spectator, parked above the action. One owner of its position (Invariant D):
    // the witness's hot anchor (a live fight) outranks the framing midpoint when both want it.
    if (scout && scout.isReady()) {
      if (!scoutArmed) { await rcon.command(`gamemode spectator ${CFG.scout.username}`); scoutArmed = true; }
      const hot = witness ? witness.anchorTarget() : null;
      const ps = rigs.map(r => r.botPos).filter(Boolean);
      let target = null, why = '';
      if (hot) { target = { x: Math.round(hot.x), z: Math.round(hot.z), y: hot.y }; why = ` — following ${hot.bot}'s fight (${hot.from})`; }
      // Centroid park is the witness-only fallback; framing live parks over each subject instead (Law 16).
      else if (!FRAMING && ps.length) {
        target = { x: Math.round(ps.reduce((s, p) => s + p.x, 0) / ps.length),
                   z: Math.round(ps.reduce((s, p) => s + p.z, 0) / ps.length) };
        why = ' — covering the action, out of frame.';
      }
      if (target && (!scoutAnchor || Math.hypot(target.x - scoutAnchor.x, target.z - scoutAnchor.z) > CFG.scout.reanchorDist)) {
        // Overhead relative to the fight's own y; the centroid case has none, so a fixed height instead.
        const y = target.y != null ? Math.round(target.y + CFG.scout.parkRise) : CFG.scout.height;
        await rcon.command(`tp ${CFG.scout.username} ${target.x} ${y} ${target.z}`);
        scoutAnchor = { x: target.x, z: target.z }; scoutSettleUntil = Date.now() + CFG.scout.settleMs;
        narrate('summary', 'scout', `re-anchored above (${target.x},${target.z}) @ y=${y}${why}`);
      }
    }

    // Human-flown free camera: armed once (spectator + night vision + operator) and never directed.
    // Not a Law 19 exemption: a human's own client on his own server.
    // `op` is reasserted every run (idempotent, Invariant B).
    for (const name of FREE_CAMS) {
      if (!rcon) return;
      if (freeCamArmed.has(name)) continue;
      const res = await rcon.command(`data get entity ${name} Pos`);
      if (!POS_RE.test(res)) continue;                 // not logged in yet — try again next pass
      await rcon.command(`gamemode spectator ${name}`);
      await rcon.command(`effect give ${name} minecraft:night_vision infinite 0 true`);
      await rcon.command(`op ${name}`);
      // A seat with a declared spot is put there once, here, and nothing moves it after.
      const spot = FIXED_SPOTS[name];
      if (spot) {
        await rcon.command(`tp ${name} ${spot.pos.join(' ')} ${spot.rotation.join(' ')}`);
        narrate('summary', 'camera_rig', `${name} put at its fixed spot (${spot.pos.map(v => v.toFixed(2)).join(',')}) facing ${spot.rotation.map(v => v.toFixed(1)).join('/')}.`);
      }
      freeCamArmed.add(name);
      narrate('summary', 'camera_rig',
        `${name} online — spectator + night vision + OPERATOR, and NOT directed: this rig sends it ` +
        `nothing else. Fly it yourself; chat is on, so /tp /time /gamemode /summon are all yours.`);
    }

    // Present-only: one confirmation read, then left alone entirely.
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
      // Bot position polled in both modes — the witness needs it when the scout can't see a bot.
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

      // Binds the gimbal: spectator first, then /spectate-locks the camera onto it.
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

      // Startup pin: frames whatever chooseSubject picks so a camera never sits at its logout spot.
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

  // The one place that knows the film crew is really standing in the world — reported, not computed, as
  // a side effect of arming (Law 25). Published to a file, the contract with the waiter (Law 16);
  // write-only here (Law 9). Present-only clients count toward the crew, since a host window on a
  // loading screen must also gate OBS.
  function publishCrewReady() {
    if (crewReadyPublished) return;
    const expected = (FRAMING ? rigs.map(r => r.cam) : []).concat(FREE_CAMS).concat(PRESENT_PLAYERS);
    if (!expected.length) return;
    const armed = new Set([...freeCamArmed, ...presentConfirmed, ...rigs.filter(r => r.ready).map(r => r.cam)]);
    if (!expected.every(name => armed.has(name))) return;
    // `free` names the seats a person flies, so a reader placing that person need not know the seat's name;
    // `fixed` names the ones this rig already put at their own spot, which no reader places at the base.
    fs.writeFileSync(READY_FILE, JSON.stringify({ ready: true, cams: expected, free: FREE_CAMS,
      fixed: FREE_CAMS.filter(n => FIXED_SPOTS[n]), at: new Date().toISOString() }, null, 2));
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
  // slowTick owns the rcon relink, bot poll and scout anchor for both modes.
  // Guard skips an overlapping tick: two holdTicks must never both cut off the same pre-cut state.
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
    // Aggregate: how long the scout's raycasts made it deaf, across the whole run.
    if (scout && scout.blindStats) {
      const b = scout.blindStats();
      crewLog.event('scout', 'blind', { spans: b.spans, ms: b.blockedMs });
    }
    crewLog.flush();   // the last pass is never left in the buffer (Law 8: nothing outlives the run that raised it)
    // Witness closes before the scout (reads its blind-span totals) and terminates any open fight (Law 8).
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
