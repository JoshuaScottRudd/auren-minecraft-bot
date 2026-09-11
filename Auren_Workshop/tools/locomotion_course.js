// locomotion_course — the drill ground. Sites a COURSE the terrain already contains, puts the body at
// its start, asks locomotion to walk it, and reads back how the body actually moved.
//
// ── WHAT IT IS FOR (Architect 2026-08-01) ───────────────────────────────────────────────────────────
// "so lanista is aware of the pathfinding between 2 locations and can place 2 locations within raycast…
//  can we make a locomotion tester that uses the same lanista system? so it finds 2 locations at
//  distances we desire, skips raycast because we arent pitting entities against each other… then
//  pathfind to see the edges and. we can set the edge requirements.. so for example to test sprint jump,
//  we say 2 flat moves then one jump move required so bot can reach full speed before jumping… it will
//  use the exact same pathfinding as the bot so how it will work is that it will find a result, pick it,
//  teleport bot to point a and then command to go to point b and monitor the bots movement and give us
//  data."
//
// ── WHY IT IS A SIBLING OF lanista AND NOT A FLAG ON IT ─────────────────────────────────────────────
// Same shape, different verb, and the difference is which question the SITING asks. lanista sites a
// PAIR — two boxes that can reach each other AND see each other — because a fight needs a sightline.
// This sites a ROUTE — two boxes whose path between them contains a named sequence of moves — because a
// locomotion test needs the moves under test to actually occur. The raycast is not merely skipped here,
// it is meaningless: nothing is being pitted against anything.
//
// Threading that through lanista would put a `mode: 'locomotion'` branch through its siting and its
// summon path — a second lane inside a file whose whole point is that it has one verb. Two verbs, two
// files, one set of shared seams underneath. (lanista was cut down to that one verb on 2026-08-06; this
// file inherited combat_recorder from it and is now the recorder's only caller.)
//
// ── WHAT IS REUSED, AND WHY EACH (Law 16 — none of this is re-implemented here) ─────────────────────
//   arena_sites.findBotSpawn / findOpponentSpawns — Q1 and Q2, unchanged. "A place a body fits" is the
//                       same question for a walker as for a fighter, so it is the same code.
//   @utils/pathfinding_utils — the CONSTRUCT'S OWN A*, imported not transcribed. The whole premise is
//                       "the exact same pathfinding as the bot"; a second pathfinder here would site
//                       courses whose edges the bot then plans differently, and every result would be
//                       measuring the disagreement instead of the movement.
//   camera_scout      — the world model and the position feed (the fleet's one read-only observer).
//   js_kernel/utils/rcon_link — the server console.
//   fleet_control.js `move` — the leg itself. It already teleports, VERIFIES the landing, and dispatches
//                       the verb; re-writing that here would be a second way to start a walk, and the
//                       two would drift the first time only one got a fix.
//   combat_recorder   — the instrument. The bot emits nothing new for this bench either.
//
// The only genuinely new thing in this file is the EDGE-SEQUENCE GATE, because no existing code asks
// "does the route between these two cells contain two flat moves followed by a step up".
//
// ── WHERE THE VIRTUAL HALF ENDS AND THE LIVE HALF BEGINS ────────────────────────────────────────────
// Everything before the teleport is a decision over authored world reads: which cells, which route,
// whether its edges match the drill. That half needs no fleet at all (`--dry`). Everything after is the
// body crossing real ground, and it is READ, never computed — this file never predicts where the bot
// should be, only records where it was (Law 26: author the inputs, read the outputs; a bench that
// modelled the walk would be grading its own paper).
//
// ── WHAT IT CANNOT PROVE (Law 25) ───────────────────────────────────────────────────────────────────
// It measures ONE body on ONE server at whatever latency the day supplies. A stop count is a fact about
// this run, not a constant. It cannot say a route is impossible — only that this attempt did not finish.
// And it says nothing about whether the bot SHOULD have taken that route: the route is A*'s, and A* is
// under test here only in the sense that its edge labels must match what the body then does.
//
// Usage:
//   node locomotion_course.js --list
//   node locomotion_course.js --course=sprint_jump --dry            # site only, no fleet needed
//   node locomotion_course.js --course=sprint_jump --bot=AurenBot
//   node locomotion_course.js --course=sprint_jump --lookahead=1,3 --repeat=2   # the A/B
//   node locomotion_course.js --course=flat_run --origin=-8,65,16 --min=20 --max=40
// Exit codes: 0 the course ran · 2 no leg arrived · 1 could not run (no scout / no rcon / no course).

'use strict';
require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/locomotion_course.js');

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

// Before the scout require — it needs mineflayer, and the module home differs per workstation.
const paths = require('../workshop_paths');
paths.bootstrapModules();

const rconLink = require(paths.bot('js_kernel/utils/rcon_link'));
const arena = require('./arena_sites');
const pathfinding = require('@utils/pathfinding_utils');   // the @-alias space is booted by arena_sites
const Vec3 = require('vec3');
const { createRecorder, makeRunId, ARENA_LOG_DIR } = require('./combat_recorder');
const { createScout } = require('../camera/camera_scout');

// ── THE DRILL TABLE — every course the bench knows, in one place ────────────────────────────────────
//
// "then be able to dynamically set what kinds of moves we want to test."
//
// A course is a PREDICATE OVER AN EDGE SEQUENCE, never a description of terrain. That distinction is
// what makes it dynamic: adding a drill is adding a row here, and it composes with any ground the world
// happens to have, because the sequence is matched against A*'s own route rather than against a shape
// somebody had to find first.
//
//   require   — contiguous sub-sequences, ANY of which satisfies the drill. Contiguous on purpose: the
//               Architect's sprint-jump needs the two flat moves IMMEDIATELY before the step up, because
//               their whole job is letting the body reach speed. A "contains these somewhere" test would
//               accept a route that walks, turns a corner, stops at a wall, and then steps up.
//   occurrences — how many times it must appear. More occurrences is a longer drill, not a stricter one.
//   forbid    — edge types that disqualify a route outright. Every carve edge is forbidden by default:
//               a route that digs is a route whose timing measures a pickaxe, not a walk.
//   minSteps/maxSteps — route length in edges. The floor keeps a "course" from being three cells long;
//               the ceiling keeps one run from being a cross-country expedition nobody can read.
const CARVE_AND_SWIM = ['dig_through', 'dig_down', 'bridge', 'pillar', 'dig_climb_up', 'dig_climb_down', 'swim'];

const COURSES = {
  sprint_jump: {
    why: 'two flat moves to reach speed, then a step up — the Architect\'s prejump case, and the one the creeper retreat needs',
    require: [['walk', 'walk', 'climb_up']],
    occurrences: 1,
    minDistance: 8, maxDistance: 24, minSteps: 5, maxSteps: 40,
  },
  flat_run: {
    why: 'six unbroken flat cells — the baseline. Any stop measured here is pure seam, with no terrain to blame',
    require: [['walk', 'walk', 'walk', 'walk', 'walk', 'walk']],
    occurrences: 1,
    minDistance: 12, maxDistance: 40, minSteps: 8, maxSteps: 60,
  },
  staircase_up: {
    why: 'consecutive ascents — where the old mover re-centred on every tread',
    require: [['climb_up', 'climb_up']],
    occurrences: 2,
    minDistance: 6, maxDistance: 24, minSteps: 4, maxSteps: 40,
  },
  staircase_down: {
    why: 'consecutive descents — the other half of "moved back to the center of the block to make sure it reaches it"',
    require: [['climb_down', 'climb_down']],
    occurrences: 2,
    minDistance: 6, maxDistance: 24, minSteps: 4, maxSteps: 40,
  },
  rolling: {
    why: 'up then flat then down, twice — mixed terrain, where a lookahead has the most to gain and the most to break on',
    require: [['climb_up', 'walk', 'climb_down'], ['climb_down', 'walk', 'climb_up']],
    occurrences: 2,
    minDistance: 10, maxDistance: 40, minSteps: 8, maxSteps: 60,
  },
};

// ── THE RUN CARD — everything a run varies by, at the top ───────────────────────────────────────────
const RUN = {
  course: 'sprint_jump',
  lookahead: [3],           // the fleet default; several depths run the A/B over the SAME sited course
  repeat: 1,                // legs per depth. Latency is noisy; one leg is an anecdote
  arrivalTolerance: 2.0,    // blocks. The verb's own goal tolerance is 1.5; this is the observer's
  legTimeoutMs: 45000,
  settleMs: 1200,           // after a leg, before the next teleport — let the body come to rest
  maxRadius: 64,            // how far the siting sweep may look for the start box
  candidateCap: 60,         // how many band cells to pathfind before giving up on this course
  reachMaxNodes: 20000,     // the LIVE navigator's budget is 200000; a course is short, this is generous
};

// ── WHAT THE OBSERVER ACTUALLY RECEIVES, and what that forces (first live run, 2026-08-01) ──────────
//
// The scout sees another player ONLY through move packets, and three fields that look like measurements
// are not. All three were read as measurements by the first version of this lens, and all three produced
// well-formed falsehoods — the class of mistake no form check catches (Law 26) and the class Law 25 bars
// outright from an outcome signal:
//
//   bot.v        ALWAYS {0,0,0}. mineflayer fills an entity's velocity only from an explicit
//                entity-velocity packet (knockback, explosions); ordinary walking never writes it. Read
//                as speed, it reported a leg at max 0.00 b/s while that leg travelled 11.36 blocks.
//   bot.ground   ALWAYS true. Never updated for an observed player, so every jump counter built on it
//                returned 0 — indistinguishable in the output from a body that genuinely never jumped.
//                Those fields are now reported as null, never as zero.
//   sample rate  The recorder samples at 20 Hz; the server moves a player at about 10. So half the
//                frames repeat the previous position, and a per-sample speed reads 0, 2×, 0, 2× on a
//                body walking a perfectly steady line: 98.2% of the first leg was reported "stopped".
//
// So the lens works on PACKET FRAMES — samples where the position actually changed — not on samples.
// That removes the alias structurally instead of smoothing it away, and it makes the stop detector
// exact rather than thresholded: Minecraft sends no move packet for a body that is not moving, so a gap
// in the packet series IS the stop. Nothing is inferred from a speed dipping under a number somebody
// picked.
const STOP_MIN_MS = 300;    // 3× the ~100 ms cadence — below this a gap is network jitter, not a stop
const SPEED_WINDOW_MS = 250; // over packet frames, so this spans real arrivals rather than sampling phase

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const opt = (f, d) => {
  const hit = argv.find(a => a.startsWith(`--${f}=`));
  return hit === undefined ? d : hit.slice(f.length + 3);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = p => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
const log = (stage, msg) => console.log(`[${stage.toUpperCase()}] ${msg}`);
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const round2 = n => (n == null ? null : Math.round(n * 100) / 100);

// ── The edge-sequence gate — the one new predicate in this file ─────────────────────────────────────
//
// Pure, and separated from every world read on purpose: it is the only piece here worth a unit test, and
// a function that takes a bot cannot have one.
//
// Returns { ok, why, found } — `why` names the FIRST failing clause rather than a boolean, because the
// interesting output of a siting sweep is the histogram of refusals ("47 routes, 41 too short, 6 with no
// step-up"), and a bare false cannot produce one.
function matchCourse(edgeTypes, course) {
  const forbid = new Set(course.forbid || CARVE_AND_SWIM);
  const bad = edgeTypes.find(e => forbid.has(e));
  if (bad) return { ok: false, why: `forbidden_edge:${bad}`, found: 0 };
  const minSteps = course.minSteps || 1;
  const maxSteps = course.maxSteps || Infinity;
  if (edgeTypes.length < minSteps) return { ok: false, why: 'too_short', found: 0 };
  if (edgeTypes.length > maxSteps) return { ok: false, why: 'too_long', found: 0 };

  const want = course.occurrences || 1;
  // Occurrences are counted NON-OVERLAPPING: after a match the cursor jumps past it. Overlapping counts
  // would let ['walk','walk','walk'] satisfy "two runs of walk,walk", which is one run of three cells and
  // not the two separate accelerations the drill is asking for.
  let found = 0;
  for (let i = 0; i < edgeTypes.length;) {
    const hit = (course.require || []).find(seq =>
      seq.length <= edgeTypes.length - i && seq.every((e, k) => edgeTypes[i + k] === e));
    if (hit) { found++; i += hit.length; } else { i++; }
  }
  if (found < want) return { ok: false, why: `pattern_absent(${found}/${want})`, found };
  return { ok: true, why: null, found };
}

// ── The route seam ──────────────────────────────────────────────────────────────────────────────────
//
// lanista's reachabilityFor answers "can it get there". This needs the same search but keeps the EDGE
// SEQUENCE, which that one discards. Same adapter, same three-verdict honesty, one extra field — kept
// here rather than widened over there because lanista's gate is a siting criterion whose callers do not
// want a route, and handing every one of them a path array would be a wider contract for one consumer.
//
// FLOOR CELLS: the pathfinder is indexed on the block stood ON, and a box's `y` is the feet cell. The -1
// is applied here, once, at the only place that knows both conventions.
function routerFor(scout, maxNodes) {
  const adapter = {
    blockAt: pos => scout.blockAt({ x: pos.x, y: pos.y, z: pos.z }),
    inventory: { items: () => [] },     // an observer carries nothing, and the placing edges are disabled
  };
  return {
    async route(fromFeet, toFeet) {
      const start = { x: fromFeet.x, y: fromFeet.y - 1, z: fromFeet.z };
      const goalFloor = new Vec3(toFeet.x, toFeet.y - 1, toFeet.z);
      if (adapter.blockAt(new Vec3(start.x, start.y, start.z)) === null) return { known: false, why: 'start_unloaded' };
      if (adapter.blockAt(goalFloor) === null) return { known: false, why: 'goal_unloaded' };
      const res = await pathfinding.computeAStar(adapter, start, { type: 'position', pos: goalFloor }, {
        // Same reason as lanista's reachability gate: `adapter` is a read-only stub, not a body. See the pacer's
        // combat-gate header in voxel_scan_throttle.
        allowWorldAlteration: false, maxNodes, combatGate: false,
      });
      if (res && !res.partial) {
        return { known: true, reachable: true, cost: round2(res.cost), edgeTypes: res.path.map(s => s.edgeType), path: res.path };
      }
      if (res && res.partial) {
        if (res.nodesVisited >= res.maxNodes) return { known: false, why: 'budget_exhausted' };
        return { known: true, reachable: false, why: 'region_explored' };
      }
      return { known: false, why: 'no_progress_from_start' };
    },
  };
}

// ── The siting sweep (the VIRTUAL half) ─────────────────────────────────────────────────────────────
//
// Q1 for the start, Q2 for the candidate finishes, then the route gate on each in nearest-first order.
// Nearest-first plus first-match means the chosen course is the CLOSEST one that satisfies the drill,
// which is what makes a re-run on the same origin reproducible.
async function siteCourse(scout, origin, course, opts = {}) {
  const reader = arena.readerFromScout(scout);
  const cache = arena.createSiteCache();
  const router = routerFor(scout, opts.reachMaxNodes || RUN.reachMaxNodes);
  const pace = () => new Promise(r => setImmediate(r));

  log('site', `looking for a start box near ${fmt(origin)}…`);
  const startSpot = await arena.findBotSpawn(reader, origin, { cache, pace, maxRadius: opts.maxRadius || RUN.maxRadius });
  if (!startSpot.found) return { found: false, stage: 'start', reason: startSpot.reason };
  const A = startSpot.box;

  const minDistance = opts.minDistance || course.minDistance;
  const maxDistance = opts.maxDistance || course.maxDistance;
  log('site', `start ${fmt(A)}; sweeping ${minDistance}-${maxDistance}b for a finish whose ROUTE matches '${opts.name}'…`);
  const band = await arena.findOpponentSpawns(reader, A, { cache, pace, minDistance, maxDistance });

  const rejects = new Map();
  const note = why => rejects.set(why, (rejects.get(why) || 0) + 1);
  const ordered = band.boxes.slice().sort((a, b) => a.distance - b.distance);
  const cap = opts.candidateCap || RUN.candidateCap;
  let probed = 0;

  for (const B of ordered) {
    if (probed >= cap) { note('candidate_cap'); break; }
    probed++;
    const r = await router.route(A, B);
    // Three verdicts, and unknown is never folded into unreachable: a search that ran out of budget
    // proved nothing, and retiring ground for being far away would silently narrow every drill (Law 23).
    if (!r.known) { note(`unknown:${r.why}`); continue; }
    if (!r.reachable) { note('unreachable'); continue; }
    const m = matchCourse(r.edgeTypes, course);
    if (!m.ok) { note(m.why.replace(/\(.*\)/, '')); continue; }
    return {
      found: true, A, B,
      distance: round1(B.distance), cost: r.cost,
      edgeTypes: r.edgeTypes, matches: m.found,
      histogram: edgeHistogram(r.edgeTypes),
      probed, offered: ordered.length, rejects: [...rejects.entries()].sort((x, y) => y[1] - x[1]),
    };
  }
  return {
    found: false, stage: 'route', A,
    probed, offered: ordered.length, rejects: [...rejects.entries()].sort((x, y) => y[1] - x[1]),
  };
}

function edgeHistogram(edgeTypes) {
  const by = {};
  for (const e of edgeTypes) by[e] = (by[e] || 0) + 1;
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ');
}

// ── The leg (the LIVE half) ─────────────────────────────────────────────────────────────────────────
//
// dispatchMove shells out to fleet_control's `move`, which already teleports the body to A, VERIFIES it
// landed (an RCON tp that silently missed would otherwise read as a mysteriously long walk), and sends
// the verb. Reused whole rather than re-implemented: a second way to start a walk is a second thing to
// keep in sync, and this one is already the operator's documented route.
//
// It returns when the VERB IS SENT, never when the bot arrives — Law 25 applies to the child too, and
// its own header says so. Arrival is this file's to observe, below, off the world.
function dispatchMove({ from, to, lookahead, prejump, bot }) {
  const script = paths.workshop('fleet_control.js');
  const args = [script, 'move',
    `--from=${from.x},${from.y},${from.z}`,
    `--to=${to.x},${to.y},${to.z}`,
    `--lookahead=${lookahead}`,
    `--prejump=${prejump === false ? 'off' : 'on'}`,
    `--bot=${bot}`];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: paths.REPO_ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ ok: code === 0, code, out: out.trim() }));
    child.on('error', e => resolve({ ok: false, code: -1, out: String(e.message) }));
  });
}

// observeArrival — the only verdict, and it is read off the world rather than off the bot's trace. A
// trace-derived arrival would let the construct's account of itself decide whether the construct passed
// (Law 26), and the whole reason this bench exists is that the account and the body can disagree.
async function observeArrival(scout, botName, to, timeoutMs, tolerance) {
  const until = Date.now() + timeoutMs;
  let best = Infinity, lastSeen = null;
  while (Date.now() < until) {
    const p = scout.entityPos(botName);
    if (p) {
      lastSeen = p;
      const d = Math.hypot(p.x - (to.x + 0.5), p.y - to.y, p.z - (to.z + 0.5));
      if (d < best) best = d;
      if (d <= tolerance) return { arrived: true, elapsedMs: timeoutMs - (until - Date.now()), gap: round2(d), best: round2(best), at: p };
    }
    await sleep(100);
  }
  return { arrived: false, elapsedMs: timeoutMs, gap: lastSeen ? round2(Math.hypot(lastSeen.x - to.x - 0.5, lastSeen.y - to.y, lastSeen.z - to.z - 0.5)) : null, best: round2(best), at: lastSeen };
}

// ── The lens ────────────────────────────────────────────────────────────────────────────────────────
//
// The reducer over combat_recorder's stream — and since 2026-08-06 the ONLY one, because combat_monitor
// was deleted with the observer stack and lanista was simplified to a tool that records nothing. What
// follows was written when there were two; it still names the split correctly, and the half this file
// does not do is now done by `trace_monitor --combat` over the bot's own journal. It answers "what were
// the combat numbers" — strike distance, cadence, knockback. It cannot answer "how many times did the
// body come to a full stop crossing this ground", and a locomotion block bolted into it would be a
// second lane inside a tool whose discipline is combat triage.
//
// THE HEADLINE NUMBER IS STOPS, and that is not an arbitrary choice — it is the Architect's complaint
// stated as a measurement: "right now the bot go to edge of block. stops, then jump moves forward." A
// stop is what the voxel-transition layer exists to remove, so stops-per-cell is the one number the A/B
// turns on. Mean speed is a consequence of it and is reported second for that reason.
//
// Everything here is computed from what the server sent. Nothing is predicted, and no value is compared
// against a model — this is a lens, not an alarm (calibration, in combat_monitor's vocabulary). A
// threshold invented before the first reading would be a guess wearing an alarm's authority.
async function reduceLeg(file, window) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const samples = [];
  let malformed = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch (_) { malformed++; continue; }
    if (rec.k !== 's' || !rec.bot || !rec.bot.p) continue;
    if (window && (rec.t < window.from || rec.t > window.to)) continue;
    samples.push(rec);
  }
  if (samples.length < 2) return { samples: samples.length, malformed, empty: true };

  // ── the packet series: samples where the body actually moved ──
  const pkts = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const a = pkts[pkts.length - 1].bot.p, b = samples[i].bot.p;
    if (Math.hypot(b.x - a.x, b.z - a.z, b.y - a.y) > 1e-6) pkts.push(samples[i]);
  }
  const elapsedMs = samples[samples.length - 1].t - samples[0].t;
  if (pkts.length < 3) {
    return { samples: samples.length, malformed, elapsedMs, packets: pkts.length, empty: true, why: 'body never moved' };
  }

  const speedAt = (i) => {
    let j = i;
    while (j > 0 && pkts[i].t - pkts[j].t < SPEED_WINDOW_MS) j--;
    const dt = pkts[i].t - pkts[j].t;
    if (dt <= 0) return null;
    const a = pkts[j].bot.p, b = pkts[i].bot.p;
    return (Math.hypot(b.x - a.x, b.z - a.z) / dt) * 1000;
  };

  const speeds = [], stops = [], ascents = [];
  let travelled = 0, rise = 0, drop = 0;
  const gaps = [];

  for (let i = 1; i < pkts.length; i++) {
    const prev = pkts[i - 1], cur = pkts[i];
    const dy = cur.bot.p.y - prev.bot.p.y;
    travelled += Math.hypot(cur.bot.p.x - prev.bot.p.x, cur.bot.p.z - prev.bot.p.z);
    if (dy > 0.01) rise += dy; else if (dy < -0.01) drop += -dy;
    gaps.push(cur.t - prev.t);

    const v = speedAt(i);
    if (v !== null) speeds.push(v);

    // A GAP IN THE PACKET SERIES IS THE STOP. Exact, not thresholded: the server sends no move packet
    // for a body that is not moving, so the absence IS the measurement. This replaced a speed-under-a-
    // number test, which could not tell a stopped body from the sampling phase.
    const gap = cur.t - prev.t;
    if (gap >= STOP_MIN_MS) stops.push({ from: prev.t, to: cur.t, ms: gap, at: prev.bot.p });

    // ASCENTS, not jumps. `onGround` is dead for an observed player, so a takeoff cannot be seen — but
    // the thing the prejump claim is actually about can: when the body started rising, was it MOVING?
    // A rise begun at walking pace is a step taken in stride; a rise begun from rest is the old
    // behaviour, arrived-stopped-hopped. That is the same distinction without the unavailable field.
    if (dy > 0.3 && (prev.bot.p.y - pkts[Math.max(0, i - 2)].bot.p.y) <= 0.3) {
      // Entry speed is ZERO when a stop-length gap sits immediately before the rise, never the stale
      // speed from before that gap. Without this the body walks in at 5.6 b/s, stands at the step for
      // 600 ms, rises — and the ascent is credited with the 5.6 it had before it stopped, which is the
      // seam being scored as its own opposite.
      const atRest = (cur.t - prev.t) >= STOP_MIN_MS;
      ascents.push({ t: cur.t, bps: atRest ? 0 : round2(speedAt(i - 1) || 0), at: cur.bot.p });
    }
  }

  const sorted = speeds.slice().sort((a, b) => a - b);
  const pct = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null);
  const stoppedMs = stops.reduce((a, s) => a + s.ms, 0);
  const gapSorted = gaps.slice().sort((a, b) => a - b);

  return {
    samples: samples.length, malformed, packets: pkts.length,
    // The instrument's own resolution, reported rather than hidden (Law 6): if the packet cadence
    // collapses, every number below is measured over fewer arrivals and the reader is owed that. ~100 ms
    // is normal. It is also the floor on what a stop can be — this lens cannot see one shorter.
    medianGapMs: gapSorted[Math.floor(gapSorted.length / 2)] || null,
    elapsedMs, travelled: round2(travelled), rise: round2(rise), drop: round2(drop),
    meanBps: round2(elapsedMs > 0 ? travelled / (elapsedMs / 1000) : 0),
    p50Bps: round2(pct(0.5)), p95Bps: round2(pct(0.95)), maxBps: round2(sorted[sorted.length - 1]),
    stops: stops.length, stoppedMs, stoppedPct: round1(elapsedMs > 0 ? (stoppedMs / elapsedMs) * 100 : 0),
    longestStopMs: stops.reduce((a, s) => Math.max(a, s.ms), 0),
    ascents: ascents.length,
    // An ascent begun below walking pace is the seam: the body reached the step, stopped, then rose.
    standingAscents: ascents.filter(a => a.bps < 1.5).length,
    ascentEntryBps: ascents.map(a => a.bps),
    // Named dead rather than reported as zero. A 0 here would be indistinguishable from a real
    // measurement of a body that never left the ground (Law 25).
    jumps: null, airbornePct: null, unavailable: ['onGround', 'velocity'],
  };
}

// ── The runner ──────────────────────────────────────────────────────────────────────────────────────

// An ARM is a named settings combination, not just a depth: fusing cells and jumping early are two
// independent changes and the first A/B could not attribute a slow leg to either. `la3` and `la3np`
// differ by exactly one flag, which is what makes the difference between them evidence.
async function runLeg(ctx, site, arm, index) {
  const { scout, bot } = ctx;
  const { lookahead, prejump, name: armName } = arm;
  const label = `${ctx.courseName}-${armName}-${index}`;
  const recorder = createRecorder({ scout, runId: makeRunId(label), botName: bot, label });
  // The recorder stamps every sample in ms since IT started, so the window below must be measured on the
  // same clock. Taken here rather than derived from Date.now() at dispatch: a few ms of drift would be
  // harmless, but a clock the reducer cannot reproduce is the kind of thing that quietly shifts a window
  // by a second the day something slow gets added between the two.
  const recorderT0 = Date.now();
  let dispatchT = null;
  try {
    recorder.mark('course_leg_start', {
      course: ctx.courseName, lookahead, prejump, arm: armName, index,
      from: site.A, to: site.B, edgeTypes: site.edgeTypes,
    });
    const sent = await dispatchMove({ from: site.A, to: site.B, lookahead, prejump, bot });
    dispatchT = Date.now() - recorderT0;
    if (!sent.ok) {
      recorder.mark('course_leg_dispatch_failed', { out: sent.out });
      return { arm: armName, lookahead, prejump, index, dispatched: false, out: sent.out };
    }
    recorder.mark('course_leg_dispatched', { afterMs: dispatchT });

    const arrival = await observeArrival(scout, bot, site.B, RUN.legTimeoutMs, RUN.arrivalTolerance);
    recorder.mark('course_leg_end', arrival);
    // The measurement window opens at the DISPATCH mark, not at the recorder's first sample: everything
    // before it is the teleport and the verb's flight, which are the bench's own latency and not the
    // bot's movement. Attributing them to locomotion would flatter or damn it for the harness's cost.
    const window = { from: dispatchT, to: dispatchT + arrival.elapsedMs };
    recorder.close();
    const metrics = await reduceLeg(recorder.file, window);
    return { arm: armName, lookahead, prejump, index, dispatched: true, arrival, metrics, file: recorder.file, dispatchMs: dispatchT };
  } finally {
    recorder.close();   // idempotent; the finally is the Law 8 guarantee, not the normal path
  }
}

function renderLegs(legs, site, courseName) {
  const line = '─'.repeat(96);
  console.log(`\n${line}`);
  console.log(`  COURSE '${courseName}'  ${fmt(site.A)} → ${fmt(site.B)}   ${site.distance}b straight, ${site.edgeTypes.length} edges`);
  console.log(`  route: ${site.histogram}   (drill matched ${site.matches}×)`);
  console.log(`  edges: ${site.edgeTypes.join(' ')}`);
  console.log(line);
  const head = ['arm', 'run', 'arrived', 'ms', 'travel', 'mean', 'p50', 'p95', 'STOPS', 'stop ms', '%stop', 'asc', 'standing', 'gap'];
  const w = [6, 4, 8, 7, 7, 6, 6, 6, 6, 8, 6, 5, 9, 5];
  const row = c => c.map((v, i) => String(v == null ? '-' : v).padStart(w[i])).join(' ');
  console.log(row(head));
  for (const l of legs) {
    if (!l.dispatched) { console.log(row([l.arm, l.index, 'DISPATCH FAILED'])); continue; }
    const m = l.metrics || {};
    console.log(row([l.arm, l.index, l.arrival.arrived ? 'yes' : 'NO',
      m.elapsedMs, m.travelled, m.meanBps, m.p50Bps, m.p95Bps,
      m.stops, m.stoppedMs, m.stoppedPct, m.ascents, m.standingAscents, m.medianGapMs]));
  }
  console.log(line);
  console.log('  asc/standing = ascents, and how many began below walking pace (the seam). gap = median ms');
  console.log('  between move packets, which is the resolution floor: no stop shorter than it is visible.');
  console.log('  onGround and velocity are DEAD for an observed player — no jump or airborne figure exists.');

  // The A/B, and it is stated as a DELTA rather than a verdict. Which depth is better is the Architect's
  // reading of these numbers; this file's job ends at making them comparable (Law 24 — the report lands
  // on a recommendation, and the recommendation is in the scratchpad, not printed as a pass/fail here).
  const depths = [...new Set(legs.filter(l => l.dispatched && l.metrics && !l.metrics.empty).map(l => l.arm))];
  if (depths.length > 1) {
    console.log('  A/B — same course, same body, one setting apart:');
    for (const d of depths) {
      const mine = legs.filter(l => l.arm === d && l.metrics && !l.metrics.empty).map(l => l.metrics);
      const avg = k => round2(mine.reduce((a, m) => a + (m[k] || 0), 0) / mine.length);
      console.log(`    ${String(d).padEnd(6)}: ${mine.length} leg(s) — ${avg('elapsedMs')}ms, ${avg('stops')} stops, ` +
        `${avg('meanBps')} b/s mean, ${avg('standingAscents')}/${avg('ascents')} ascents from rest`);
    }
    console.log('  (Read stops first. Mean speed is a consequence of stopping, not an independent number.)');
  }
  console.log(`  raw: ${path.relative(process.cwd(), ARENA_LOG_DIR)}\n`);
}

async function main() {
  if (has('list')) {
    console.log('\nCourses:');
    for (const [k, c] of Object.entries(COURSES)) {
      console.log(`  ${k.padEnd(16)} ${c.require.map(s => s.join('+')).join('  OR  ')}  ×${c.occurrences}`);
      console.log(`  ${''.padEnd(16)} ${c.why}`);
    }
    console.log('');
    return 0;
  }

  const courseName = opt('course', RUN.course);
  const course = COURSES[courseName];
  if (!course) {
    console.error(`locomotion_course: unknown course '${courseName}'. Try --list.`);
    return 1;
  }
  const botName = opt('bot', 'AurenBot');
  // An arm is `<depth>` or `<depth>np` (no prejump). `--arms=1,3,3np` is the three-way that separates
  // the two changes; `--lookahead=` is kept as the plain-depth spelling.
  const armSpec = opt('arms', null) || opt('lookahead', RUN.lookahead.join(','));
  const arms = String(armSpec).split(',').map((tok) => {
    const t = tok.trim();
    const np = /np$/i.test(t);
    const la = Math.max(1, Math.min(8, parseInt(t, 10) || 1));
    return { name: `la${la}${np ? 'np' : ''}`, lookahead: la, prejump: !np };
  });
  const repeat = Math.max(1, parseInt(opt('repeat', String(RUN.repeat)), 10) || 1);
  const dry = has('dry');

  const props = rconLink.readServerProperties();
  const scout = createScout({
    host: 'localhost', port: Number(props['server-port']) || 25565,
    version: props['version'] || undefined, username: 'Course_Scout',
    log: (lvl, m) => log('scout', `${lvl}: ${m}`),
  });
  if (!scout.available) { console.error(`locomotion_course: no scout — ${scout.reason}`); return 1; }

  try {
    log('scout', 'connecting…');
    const ready = await (async () => {
      const until = Date.now() + 30000;
      while (Date.now() < until) { if (scout.isReady()) return true; await sleep(500); }
      return false;
    })();
    if (!ready) { console.error('locomotion_course: scout never became ready (server up? chunks loaded?).'); return 1; }

    const originArg = opt('origin', null);
    const origin = originArg
      ? (() => { const p = originArg.split(',').map(Number); return { x: Math.floor(p[0]), y: Math.floor(p[1]), z: Math.floor(p[2]) }; })()
      : (() => { const p = scout.selfPos(); return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null; })();
    if (!origin) { console.error('locomotion_course: no origin — pass --origin=x,y,z.'); return 1; }

    const site = await siteCourse(scout, origin, course, {
      name: courseName,
      minDistance: opt('min', null) ? Number(opt('min')) : undefined,
      maxDistance: opt('max', null) ? Number(opt('max')) : undefined,
      maxRadius: Number(opt('radius', String(RUN.maxRadius))),
    });

    if (!site.found) {
      // A course the terrain cannot host is a TERRAIN result, not a failure. Reported with its refusal
      // histogram so "this ground has no step-ups" is distinguishable from "the search ran out of budget"
      // (Law 25 — a shortfall is carried forward honestly, never dressed as a result).
      log('site', `no '${courseName}' course here. Stage: ${site.stage}.`);
      if (site.rejects) {
        log('site', `probed ${site.probed}/${site.offered} candidates — ${site.rejects.map(([w, n]) => `${w}×${n}`).join(', ')}`);
      } else if (site.reason) {
        log('site', `no start box: ${site.reason}`);
      }
      return 2;
    }

    log('site', `FOUND: ${fmt(site.A)} → ${fmt(site.B)}, ${site.distance}b, ${site.edgeTypes.length} edges (${site.histogram}).`);
    log('site', `probed ${site.probed}/${site.offered} candidates; refusals ${site.rejects.map(([w, n]) => `${w}×${n}`).join(', ') || 'none'}.`);
    if (dry) {
      console.log(`\n  edges: ${site.edgeTypes.join(' ')}\n`);
      log('dry', 'siting only — no body was moved. Drop --dry to run the leg.');
      return 0;
    }

    const ctx = { scout, bot: botName, courseName };
    const legs = [];
    for (const arm of arms) {
      for (let i = 1; i <= repeat; i++) {
        log('leg', `${arm.name} (lookahead ${arm.lookahead}, prejump ${arm.prejump ? 'on' : 'off'}), run ${i}/${repeat} — dispatching…`);
        const leg = await runLeg(ctx, site, arm, i);
        legs.push(leg);
        log('leg', leg.dispatched
          ? `${leg.arrival.arrived ? 'arrived' : 'DID NOT ARRIVE'} — ${leg.metrics.elapsedMs}ms, ${leg.metrics.stops || 0} stop(s), ${leg.metrics.meanBps || '?'} b/s.`
          : `dispatch failed — ${leg.out}`);
        await sleep(RUN.settleMs);
      }
    }
    renderLegs(legs, site, courseName);
    return legs.some(l => l.dispatched && l.arrival.arrived) ? 0 : 2;
  } finally {
    scout.end();          // Law 8: the lifecycle this file opened terminates with it. No zombie client.
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch((e) => {
    console.error(`locomotion_course: ${e && e.stack ? e.stack : String(e)}`);
    process.exit(1);
  });
}

module.exports = { matchCourse, reduceLeg, edgeHistogram, COURSES, CARVE_AND_SWIM };
