// locomotion_course — the drill ground. Sites a COURSE the terrain already contains, puts the body at
// its start, asks locomotion to walk it, and reads back how the body actually moved.
//
// A course is a route whose A* edge sequence matches a named drill (sprint_jump, flat_run, …), sited by
// the same siting seams lanista uses for a fight pair, then walked and read back off the world. lanista
// sites a PAIR for a sightline; this sites a ROUTE for a move sequence — a sibling file, not a flag on
// lanista, since the two ask different questions of the siting step.
//
// Reused whole (Law 16): arena_sites.findBotSpawn/findOpponentSpawns for the start and finish boxes;
// @utils/pathfinding_utils, the construct's own A*, so a sited course matches what the bot itself would
// plan; camera_scout for the world read; rcon_link for the console; fleet_control.js `move` for the leg,
// which teleports, verifies the landing, and sends the verb; combat_recorder as the instrument. The one
// new piece here is the edge-sequence gate, below.
//
// The virtual half (siting) is pure world reads and needs no fleet (`--dry`). The live half (the leg) is
// read off the world, never predicted — this file records where the body was, not where it should be
// (Law 26).
//
// It measures one body on one server at whatever latency the day supplies (Law 25): a stop count is a
// fact about this run, not a constant, and a course the terrain cannot host says nothing about whether
// A*'s route was the right one — only that the edge labels match what the body then did.
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
// A course is a predicate over an edge sequence, matched against A*'s own route, not a terrain shape,
// so a new drill is a new row here and composes with whatever ground the world supplies.
//
//   require   — contiguous sub-sequences, ANY of which satisfies the drill.
//   occurrences — how many times a required sub-sequence must appear.
//   forbid    — edge types that disqualify a route outright; defaults to CARVE_AND_SWIM.
//   minSteps/maxSteps — route length bounds, in edges.
const CARVE_AND_SWIM = ['dig_through', 'dig_down', 'bridge', 'pillar', 'dig_stair_up', 'dig_stair_down', 'swim'];

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
  lookahead: [3],           // lookahead depths to run; several run the A/B over one sited course
  repeat: 1,                // legs per depth
  arrivalTolerance: 2.0,    // blocks — the observer's arrival radius (the verb's own tolerance is 1.5)
  legTimeoutMs: 45000,
  settleMs: 1200,           // pause after a leg, before the next teleport
  maxRadius: 64,            // search radius for the start box
  candidateCap: 60,         // band cells probed before giving up on this course
  reachMaxNodes: 20000,     // node budget for the route search
};

// ── WHAT THE OBSERVER ACTUALLY RECEIVES ─────────────────────────────────────────────────────────────
// The scout sees another player only through move packets. Three fields look like measurements but are
// not, and are read as null here, never as a false zero (Law 25):
//
//   bot.v        always {0,0,0} for an observed player — mineflayer fills it only from an explicit
//                velocity packet, never from ordinary walking.
//   bot.ground   always true for an observed player — never updated, so a jump counter built on it
//                cannot distinguish a jump from a body that never left the ground.
//   sample rate  the recorder samples at 20 Hz against a ~10 Hz server move rate, so roughly half the
//                samples repeat the previous position.
//
// The lens works on PACKET FRAMES — samples where the position actually changed — not on raw samples:
// Minecraft sends no move packet for a body that is not moving, so a gap in the packet series IS the
// stop, with nothing inferred from a speed threshold.
const STOP_MIN_MS = 300;    // gap length, in ms, that counts as a stop
const SPEED_WINDOW_MS = 250; // packet-frame window a per-sample speed is averaged over

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
// Pure function, kept apart from every world read so it stays unit-testable.
// Returns { ok, why, found }; `why` names the first failing clause so a siting sweep can report a
// refusal histogram instead of a bare pass/fail count.
function matchCourse(edgeTypes, course) {
  const forbid = new Set(course.forbid || CARVE_AND_SWIM);
  const bad = edgeTypes.find(e => forbid.has(e));
  if (bad) return { ok: false, why: `forbidden_edge:${bad}`, found: 0 };
  const minSteps = course.minSteps || 1;
  const maxSteps = course.maxSteps || Infinity;
  if (edgeTypes.length < minSteps) return { ok: false, why: 'too_short', found: 0 };
  if (edgeTypes.length > maxSteps) return { ok: false, why: 'too_long', found: 0 };

  const want = course.occurrences || 1;
  // Matches counted non-overlapping: the cursor jumps past each hit before scanning for the next.
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
// Same adapter and three-verdict shape as lanista's reachabilityFor, plus the edge sequence that gate
// discards (Law 16). Converts feet-cell boxes to the floor cells the pathfinder is indexed on, once, at
// the only place that knows both conventions.
function routerFor(scout, maxNodes) {
  const adapter = {
    blockAt: pos => scout.blockAt({ x: pos.x, y: pos.y, z: pos.z }),
    inventory: { items: () => [] },     // observer carries nothing; placing edges disabled
  };
  return {
    async route(fromFeet, toFeet) {
      const start = { x: fromFeet.x, y: fromFeet.y - 1, z: fromFeet.z };
      const goalFloor = new Vec3(toFeet.x, toFeet.y - 1, toFeet.z);
      if (adapter.blockAt(new Vec3(start.x, start.y, start.z)) === null) return { known: false, why: 'start_unloaded' };
      if (adapter.blockAt(goalFloor) === null) return { known: false, why: 'goal_unloaded' };
      const res = await pathfinding.computeAStar(adapter, start, { type: 'position', pos: goalFloor }, {
        // same predicate lanista's reachability gate asks — adapter is a read-only stub (Law 16)
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
// Finds the start box (Q1), sweeps candidate finishes (Q2), and returns the closest one whose route
// matches the drill — nearest-first and first-match, so a re-run on the same origin is reproducible.
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
    // unknown stays distinct from unreachable — a budget-exhausted search proved nothing (Law 23).
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
// Shells out to fleet_control's `move`, which teleports the body to A, verifies the landing, and sends
// the verb (Law 16). Resolves when the verb is SENT, not when the bot arrives (Law 25); arrival is
// observed separately, below, off the world.
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

// The only pass/fail verdict, read off the world, not the bot's own trace (Law 26).
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
// Reduces combat_recorder's stream into locomotion numbers; combat numbers are `trace_monitor --combat`'s
// job over the bot's own journal (Law 16).
//
// Stops-per-cell is the headline number; mean speed is a consequence of it and reported second. Every
// value here is computed from what the server sent, never predicted or compared against a model — a
// lens, not an alarm.
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

    // A gap in the packet series is the stop — exact, not thresholded: no move packet means no motion.
    const gap = cur.t - prev.t;
    if (gap >= STOP_MIN_MS) stops.push({ from: prev.t, to: cur.t, ms: gap, at: prev.bot.p });

    // Ascents, not jumps — onGround is dead for an observed player. Records whether the body was moving
    // when it started to rise: in stride, versus from rest.
    if (dy > 0.3 && (prev.bot.p.y - pkts[Math.max(0, i - 2)].bot.p.y) <= 0.3) {
      // Entry speed reads zero when a stop-length gap precedes the rise, not the stale pre-stop speed.
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
    // Median inter-packet gap (Law 6) — also the floor on how short a stop can be measured.
    medianGapMs: gapSorted[Math.floor(gapSorted.length / 2)] || null,
    elapsedMs, travelled: round2(travelled), rise: round2(rise), drop: round2(drop),
    meanBps: round2(elapsedMs > 0 ? travelled / (elapsedMs / 1000) : 0),
    p50Bps: round2(pct(0.5)), p95Bps: round2(pct(0.95)), maxBps: round2(sorted[sorted.length - 1]),
    stops: stops.length, stoppedMs, stoppedPct: round1(elapsedMs > 0 ? (stoppedMs / elapsedMs) * 100 : 0),
    longestStopMs: stops.reduce((a, s) => Math.max(a, s.ms), 0),
    ascents: ascents.length,
    // Ascents begun below walking pace — the body reached the step, stopped, then rose.
    standingAscents: ascents.filter(a => a.bps < 1.5).length,
    ascentEntryBps: ascents.map(a => a.bps),
    // Named dead, never reported as zero (Law 25) — unavailable for an observed player.
    jumps: null, airbornePct: null, unavailable: ['onGround', 'velocity'],
  };
}

// ── The runner ──────────────────────────────────────────────────────────────────────────────────────
// An arm is a named settings combination, not just a lookahead depth — `la3` and `la3np` differ by
// exactly one flag, so a difference between them is attributable evidence.
async function runLeg(ctx, site, arm, index) {
  const { scout, bot } = ctx;
  const { lookahead, prejump, name: armName } = arm;
  const label = `${ctx.courseName}-${armName}-${index}`;
  const recorder = createRecorder({ scout, runId: makeRunId(label), botName: bot, label });
  // Recorder's own clock zero — the measurement window below is stated on the same clock it samples on.
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
    // Window opens at the dispatch mark, not the recorder's first sample — excludes the teleport and
    // the verb's own flight, which are bench latency, not the body's movement.
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

  // Reports the A/B as a delta, never a verdict — this file's job ends at making arms comparable (Law 24).
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
  // Arm spelling: `<depth>` or `<depth>np` (no prejump), e.g. `--arms=1,3,3np`; `--lookahead=` is the
  // plain-depth alias.
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
      // A course the terrain cannot host is a terrain result, not a failure — reported with its refusal
      // histogram (Law 25).
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
