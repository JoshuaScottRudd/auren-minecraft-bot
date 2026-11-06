// module: driver — the crew's lower body. Owns WSAD/sprint everywhere a fight is open; reads the
// commander's board and the gunner's yaw; writes no yaw, sends no attack, derives no monster data.
// contract: start(bot)/stop(bot) attach/detach a physicsTick handler, one synchronous decision per tick
// (never awaits). engage()/disengage() bracket a wave. Only seat that may write forward/back/left/right/
// sprint/jump.
//
// One universal tactic (Law 16): close on the closest aggroed monster and hold the 2.9-1.9 band, except
// a swelling creeper, which a body without a shield backs off from. Retreat direction is a scored search over candidate
// steps (SECTION 4b), not a vector sum. Sprint is a knockback/closing tool, not a travel speed.
//
// The approach rides the navigator's pathfinder (SECTION 4c): the same search and guards, with digging dear and placing cheap.
// What differs from regular navigation is the two-stage search and the facing rule: the gunner faces the mob and these keys move the
// body under that facing. An aggroed mob is closed on and dispatched; only self_preservation runs from one.

'use strict';

const Vec3 = require('vec3');
const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { headingKeys } = require('@utils/movement/motion_primitives');
// The band below is derived from this reach; not copied locally (Law 16).
const { BOT_STRIKE_REACH, BOT_WIDTH } = require('@utils/combat_utils');
const { classifyFloor, eyePos, eyeLineHit } = require('@utils/movement/terrain_predicates');
const { computeAStar } = require('@utils/pathfinding_utils');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
// MOB_AGGRO_RANGE lists the skeleton family: the mobs that shoot from where they stand.
const { MOB_AGGRO_RANGE } = require('@thinking/architect_config');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

const writeBoard = crewBoard.claimPen('driver');

const TAG = 'driver';

// ── SECTION 1: The numbers ─────────────────────────────────────────────────

// In the band the bot is within its own 3.0 b reach (BOT_STRIKE_REACH) and outside the mob's ~1.43 b,
// so every cooldown lands a hit.
const BAND_INNER = 1.9;
const BAND_OUTER = 2.9;
// The inner edge against a melee mob: outside a zombie's reach (about 2b centre to centre), inside the arm's.
const MELEE_BAND_INNER = 2.3;
// ── THE HIT-AND-BACK: A BODY WITH NO SHIELD ───────────────────────────────────────────────────────────
// With nothing to block, every melee blow that lands is paid in full, and a slow weapon (a wooden axe, 1.25 s)
// recharges slower than a zombie attacks (1 s), so standing in reach trades blows. While the weapon is more than
// KITE_LEAD_MS from charged, a melee mob is held at KITE_INNER..KITE_OUTER, outside its own reach; inside the lead
// the ordinary band returns, the body closes at sprint and the knockback swing throws the mob back out.
const KITE_INNER = 3.3;
const KITE_OUTER = 3.8;
const KITE_LEAD_MS = 250;

// CreeperSwellGoal only unwinds past 7.0 b strictly, so 7.5 clears it with margin.
const SWELL_CLEAR = 7.5;

// Vanilla ground speeds, b/s; report context only.
const WALK_SPEED = 4.317;
const SPRINT_SPEED = 5.612;

// Stall-jump tap: auto-step covers 0.6 b, so this only fires on a full block or fence.
const STALL_EPS = 0.02;        // per-tick travel below this is the body not moving
const STALL_TICKS = 6;         // ~300 ms of pressing a key and going nowhere
const JUMP_TICKS = 4;          // ~200 ms of jump held: long enough to leave the ground

// ── SECTION 2: State ───────────────────────────────────────────────────────

// Module-level, cleared on every engage() so a tally does not outlive its fight (Law 25).
let attached = false;
let engaged = false;
let stats = null;
let tickHandler = null;

let sprintArmed = false;
// The body's own travel between ticks, distinct from distance-to-mob.
let lastPos = null;
let stallTicks = 0;
let jumpTicks = 0;
// Consecutive stall-jumps with no travel between them — feeds the dig ask (terrainWant).
let stallJumps = 0;
// Peer-yield standoff (see bandOrder), set and cleared by battle_stations.
let standoff = null;

// ── RECENTER: A FRIEND IN THE SWEEP ──────────────────────────────────────────────────────────────
// The gunner withholds a sword swing that would sweep a player (gunner board `sweepFriend`). The feet then back
// away from the mob RECENTER_BLOCKS past where they stood, drawing it off the friend, and the band resumes when
// that distance is reached or RECENTER_MAX_MS has passed (a mob that follows keeps the gap).
const RECENTER_BLOCKS = 3;
const RECENTER_MAX_MS = 3000;
let recenter = null;   // { setpoint, at, friend } while backing off

const NO_KEYS = { forward: false, back: false, left: false, right: false };

// Trace filter: a line is emitted only when the mode differs from last tick's (Invariant B).
let saidMode = null;
let saidOn = null;      // control mob when saidMode was posted, so a mob switch counts as a change
let saidSprint = false;

function _blankStats() {
  return {
    ticks: 0, engagedTicks: 0, noTarget: 0,
    sprintTicks: 0, pressedTicks: 0,
    sprintAskedLastTick: 0, sprintHeld: 0, speedPeak: 0, sprintBlockedByShield: 0, knockbackTicks: 0, flankTicks: 0, gatherTicks: 0, gathers: 0, primedTicks: 0, kiteTicks: 0, fleeTicks: 0, wallHoldTicks: 0,
    standoffTicks: 0, standoffErrSum: 0,
    recenters: 0,
    // inBandTicks = fraction of the fight in striking distance; worstBreach = deepest incursion.
    errSum: 0, errTicks: 0, worstBreach: 0, inBandTicks: 0,
    speedGotSum: 0, speedTicks: 0,
    // Kept apart from band error: unreachable-from-ground is a terrain fact, not a steering fault.
    verticalGapTicks: 0, verticalGapSum: 0,
    // The ask is this seat's whole half of the protocol; the gunner serves it (Law 25).
    terrainAskTicks: 0, terrainAskDig: 0, terrainAskPlace: 0, terrainAskBridge: 0, terrainRefusedTicks: 0,
    // The route searches (SECTION 4c): found, none (proven or out of thinking time), and the slowest think.
    routeSearches: 0, routeFound: 0, routeNone: 0, routeTimedOut: 0, routeOffEdge: 0, thinkMsMax: 0,
    gaveUp: 0, stuck: 0, routeHops: 0, routeJoined: 0,
  };
}

// ── SECTION 3: The decision — pure, no bot, no world ───────────────────────

// bandOrder({ horizontal, dy, distance, swelling, standoff }) → { mode, setpoint, error }. Pure
// function; error is signed distance outside the band (positive too close, negative too far, 0 inside).
//
// The band's edges are 3-D reach facts, but the feet only move flat (Law 10); dy projects them onto the
// floor as sqrt(edge² − dy²), collapsing to 1.9–2.9 at dy = 0. vertical_gap means the projected band is
// empty — a feet verdict, not an engagement one (the engagement itself is decided elsewhere by raycast).
function bandOrder(opts = {}) {
  // dy defaults to 0: a caller with only a flat distance reads the unprojected band (Law 13).
  const d = Number.isFinite(opts.horizontal) ? opts.horizontal : opts.distance;
  const dy = Number.isFinite(opts.dy) ? opts.dy : 0;
  if (!Number.isFinite(d)) return { mode: 'no_target', setpoint: null, error: null };

  // A standoff (swell or peer yield) outranks the band — one branch, same meaning, different setter.
  const standoff = opts.swelling ? SWELL_CLEAR : (Number.isFinite(opts.standoff) ? opts.standoff : null);
  if (standoff !== null) {
    const mode = opts.swelling ? 'swell' : 'standoff';
    const err = standoff - d;
    if (err > 0) return { mode: `${mode}_flee`, setpoint: standoff, error: err };
    // Released only by whoever set it, never by arriving.
    return { mode: `${mode}_clear`, setpoint: standoff, error: 0 };
  }

  // Checked before the edges: an empty shadow has no floor position to name.
  const rise = Math.abs(dy);
  const outerEdge = Number.isFinite(opts.outer) ? opts.outer : BAND_OUTER;
  if (rise >= outerEdge) {
    // Still closes at flat zero even with an empty shadow; BOT_WIDTH marks "beneath it".
    if (d > BOT_WIDTH) return { mode: 'approach', setpoint: 0, error: -d, dy };
    // Reported, not acted on: closing the rest needs a climb/pillar/route this seat does not own.
    return { mode: 'vertical_gap', setpoint: null, error: 0, verticalOnly: true, dy };
  }
  const outer = Math.sqrt(outerEdge * outerEdge - dy * dy);
  // Inside BAND_INNER of rise, the inner shadow opens to the bot's own column.
  const innerEdge = Number.isFinite(opts.inner) ? opts.inner : BAND_INNER;
  const inner = rise >= innerEdge ? 0 : Math.sqrt(innerEdge * innerEdge - dy * dy);

  if (d > outer) return { mode: 'approach', setpoint: outer, error: outer - d };
  if (d < inner) return { mode: 'retreat', setpoint: inner, error: inner - d };
  return { mode: 'hold', setpoint: null, error: 0 };
}

// ── SECTION 4b: The retreat direction — nine candidates, scored by their worst mob ──

// Eight headings plus standing still; deterministic order for reproducible ties (Invariant C).
const HEADING_STEPS = 8;
// Scoring lookahead: how far the body would get in roughly one correction; re-scored every tick.
const STEP_BLOCKS = 0.65;

// chooseStep(bot, hostiles) → best-scoring candidate of nine (eight headings + standing), or null with
// no hostiles. Score = minimum gap to any hostile, so a candidate is worth its worst one.
function chooseStep(bot, hostiles) {
  const self = bot && bot.entity && bot.entity.position;
  if (!self) return null;

  const points = (hostiles || [])
    .map((h) => (h && h.entity && h.entity.position) || (h && h.position) || null)
    .filter(Boolean);
  if (!points.length) return null;

  const minGapAt = (p) => {
    let m = Infinity;
    for (const q of points) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < m) m = d;
    }
    return m;
  };

  // Away vector from the whole press, not just the control mob, so backing off one doesn't walk into
  // the others.
  let cx = 0, cz = 0;
  for (const q of points) { cx += q.x; cz += q.z; }
  cx /= points.length; cz /= points.length;
  const ax = self.x - cx, az = self.z - cz;
  const alen = Math.hypot(ax, az);
  // Falls back to a fixed axis when a mob stands on the bot, so the result is never null.
  const away = alen > 1e-6 ? { x: ax / alen, z: az / alen } : { x: 1, z: 0 };

  const here = minGapAt(self);
  const candidates = [{
    label: 'stand', controls: null, offAxisRad: 0, walkable: true, score: here,
  }];

  for (let i = 0; i < HEADING_STEPS; i++) {
    const theta = (i * 2 * Math.PI) / HEADING_STEPS;
    const dx = away.x * Math.cos(theta) - away.z * Math.sin(theta);
    const dz = away.x * Math.sin(theta) + away.z * Math.cos(theta);
    const p = { x: self.x + dx * STEP_BLOCKS, y: self.y, z: self.z + dz * STEP_BLOCKS };
    // classifyFloor is the fleet's one floor predicate; unguarded since blockAt answers null, not a throw.
    const stand = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const walkable = !!classifyFloor(bot, bot.blockAt(stand.offset(0, -1, 0)));
    candidates.push({
      label: `h${i}`, controls: { dx, dz },
      offAxisRad: Math.min(theta, 2 * Math.PI - theta),
      walkable,
      score: minGapAt(p),
    });
  }

  // Unwalkable candidates rank last but stay listed, so a boxed-in bot still returns a ranked answer.
  const best = candidates.slice().sort((a, b) => {
    if (a.walkable !== b.walkable) return a.walkable ? -1 : 1;
    if (Math.abs(b.score - a.score) > 1e-6) return b.score - a.score;
    return a.offAxisRad - b.offAxisRad;
  })[0];

  return {
    controls: best.controls, label: best.label,
    score: best.score, gain: best.score - here, here,
    blocked: candidates.filter((c) => !c.walkable).length,
    stood: best.label === 'stand',
    candidates,
  };
}

// ── SECTION 4e: THE RUN — a body fleeing for its life (self_preservation) ─────────────────────────────────────
// FLEE_HEADINGS headings round the body, each walked ahead in FLEE_PROBE_B steps to FLEE_LOOK_B: a step is open when
// a floor stands level, a tread up or a tread down with two open cells over it, so a trunk or a wall ends the
// heading where it stands. A heading is valued by the gap its last open step keeps from the nearest mob, plus a pull
// toward the goal (the nearest peer, or home), plus FLEE_KEEP_B for the heading run last tick, so the run does not
// turn at every tree. A mob standing between the body and the goal turns the run sideways round it, never through
// it. Sprinted, facing the run (gunner), with no guard to stop the sprint.
//
// A BODY IN WATER SWIMS THE RUN: open water has no floor for a heading to stand on, so when no heading is open and the
// body is in water it swims straight away from the mobs, pulled toward the goal, with jump held to keep it up. A
// swimming body that found no floored heading pressed nothing while a drowned closed from 11.6 b to 5.8 b below it.
//
// A HEADING THE BODY STALLS ON IS BARRED for FLEE_BAR_MS, so the run turns to the next open one: the keep bonus held a
// body pressing one heading into an obstacle the probe read open (a base's pens and walls) for 9 s while a trident
// drowned walked back from 33 b to 14 b and threw twice.
const FLEE_GOAL_PULL = 0.5;   // b of gap a heading straight at the goal is worth
const FLEE_HEADINGS = 16;
const FLEE_PROBE_B = 0.8;
const FLEE_LOOK_B = 8;       // b ahead each heading is walked; 4 b let a forest run make 3.0 b/s of a 5.6 b/s sprint
const FLEE_KEEP_B = 0.4;
const FLEE_BAR_MS = 1500;
const FLEE_BAR_DOT = 0.95;    // a heading this close to a barred one is barred with it
let lastFlee = null;
let fleeBarred = [];          // [{ x, z, until }]
// barFleeHeading() — the run stalled: the heading it was pressing is barred.
function barFleeHeading(now) {
  if (!lastFlee) return;
  fleeBarred.push({ x: lastFlee.x, z: lastFlee.z, until: now + FLEE_BAR_MS });
  lastFlee = null;
}
function fleeStep(bot, hostiles, goal) {
  const self = bot.entity.position;
  const points = (hostiles || []).map((h) => h && h.entity && h.entity.position).filter(Boolean);
  if (!points.length) return null;
  const gapAt = (x, z) => Math.min(...points.map((q) => Math.hypot(x - q.x, z - q.z)));
  let g = null;
  if (goal) {
    const gx = goal.x - self.x, gz = goal.z - self.z, gl = Math.hypot(gx, gz);
    if (gl > 2) g = { x: gx / gl, z: gz / gl };
  }
  const open = (c) => { const b = bot.blockAt(c); return !b || b.boundingBox !== 'block'; };
  const now = Date.now();
  fleeBarred = fleeBarred.filter((b) => b.until > now);
  let best = null;
  for (let i = 0; i < FLEE_HEADINGS; i++) {
    const a = (i * 2 * Math.PI) / FLEE_HEADINGS;
    const hx = Math.cos(a), hz = Math.sin(a);
    if (fleeBarred.some((b) => hx * b.x + hz * b.z > FLEE_BAR_DOT)) continue;
    let y = Math.floor(self.y), reach = 0, climb = false;
    for (let s = FLEE_PROBE_B; s <= FLEE_LOOK_B + 1e-6; s += FLEE_PROBE_B) {
      const fx = Math.floor(self.x + hx * s), fz = Math.floor(self.z + hz * s);
      const dy = [0, 1, -1].find((k) => classifyFloor(bot, bot.blockAt(new Vec3(fx, y + k - 1, fz)))
        && open(new Vec3(fx, y + k, fz)) && open(new Vec3(fx, y + k + 1, fz)));
      if (dy === undefined) break;
      if (dy === 1 && reach === 0) climb = true;
      y += dy;
      reach = s;
    }
    if (reach === 0) continue;
    const v = gapAt(self.x + hx * reach, self.z + hz * reach) - gapAt(self.x, self.z)
      + (g ? FLEE_GOAL_PULL * (hx * g.x + hz * g.z) : 0)
      + (lastFlee && hx * lastFlee.x + hz * lastFlee.z > 0.95 ? FLEE_KEEP_B : 0);
    if (!best || v > best.v) best = { v, h: { x: hx, z: hz, climb } };
  }
  if (!best && bot.entity.isInWater) {
    let ax = 0, az = 0;
    for (const q of points) {
      const dx = self.x - q.x, dz = self.z - q.z, d = Math.hypot(dx, dz) || 1;
      ax += dx / d; az += dz / d;
    }
    if (g) { ax += FLEE_GOAL_PULL * g.x; az += FLEE_GOAL_PULL * g.z; }
    const al = Math.hypot(ax, az);
    if (al > 1e-6) best = { v: 0, h: { x: ax / al, z: az / al, climb: false, swim: true } };
  }
  lastFlee = best ? best.h : null;
  return best ? best.h : null;
}

// ── SECTION 4d: THE GATHER — backing out of a surround so every mob comes from the front ─────────────────────
// A shield covers the half in front of the facing, and the guard covers a 160° window of the hot mobs (gunner
// GUARD_COVER_RAD); a mob outside it, beside or behind the body, lands its blow. So when the mobs within
// GATHER_RANGE_B stand spread over more than GATHER_ENTER_DEG around the body, the feet walk toward the middle of
// the widest empty gap between them, facing them all the while: every chaser then follows from one side. The gather
// holds until they close to GATHER_EXIT_DEG, so it does not flip at the threshold.
const GATHER_RANGE_B = 6;
const GATHER_ENTER_DEG = 80;
const GATHER_EXIT_DEG = 45;
const GATHER_PROBE_B = 1.0;     // how far ahead a heading's floor and feet cell are checked

// spreadOf(self, mobs) → { arcDeg, gapMid } for the bearings of `mobs` around `self`, or null with fewer than two:
// arcDeg is the smallest arc covering them all, gapMid the bearing (radians, atan2(z, x)) of the middle of the widest
// empty gap between them.
function spreadOf(self, mobs) {
  const angles = mobs.map((p) => Math.atan2(p.z - self.z, p.x - self.x)).sort((a, b) => a - b);
  if (angles.length < 2) return null;
  let gap = -1, from = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
    if (next - angles[i] > gap) { gap = next - angles[i]; from = angles[i]; }
  }
  return { arcDeg: (2 * Math.PI - gap) * 180 / Math.PI, gapMid: from + gap / 2, gapRad: gap };
}

// gatherHeading(bot, spread) → a unit {x, z} toward the gap's middle, or the nearest walkable heading inside the
// gap (steps of 30°), or null when none is walkable. A tread up needs the jump the stall tap gives.
function gatherHeading(bot, spread) {
  const self = bot.entity.position;
  const half = spread.gapRad / 2;
  for (const off of [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57]) {
    if (Math.abs(off) >= half) continue;
    const a = spread.gapMid + off;
    const h = { x: Math.cos(a), z: Math.sin(a) };
    const feet = new Vec3(Math.floor(self.x + h.x * GATHER_PROBE_B), Math.floor(self.y), Math.floor(self.z + h.z * GATHER_PROBE_B));
    // Level, a tread up or a tread down: a floor the body can stand on with two open cells above it.
    const open = (c) => { const b = bot.blockAt(c); return !b || b.boundingBox !== 'block'; };
    const stands = [0, 1, -1].some((dy) => classifyFloor(bot, bot.blockAt(feet.offset(0, dy - 1, 0)))
      && open(feet.offset(0, dy, 0)) && open(feet.offset(0, dy + 1, 0)));
    if (!stands) continue;
    return h;
  }
  return null;
}

// ── SECTION 4c: The route — a short hop walked while a long plan is searched past its end ──────────
// computeAStar under the navigator's own guards (navigator.freshSearchState), never through a build (spareBuilds). COMBAT_THINK_MS
// is the short search: out of thinking time, its closest explored cell is a hop the body walks at once. While it walks, a search of
// LONG_THINK_MS starts from the hop's end; if the body has not passed that cell when it answers, the two are joined. The search
// runs from battle_stations' pass loop (think), never from the tick; the tick follows the latest route cell by cell under the
// gunner's facing, and asks the gunner for each dig and block the route's edges need (edgeWant).
const COMBAT_THINK_MS = 300;
const LONG_THINK_MS = 2000;
// The edges a fight walks and works: the walking moves and the moves edgeWant can ask for. A door, a swim or a wade needs a verb this
// seat does not own, so a route stops short of one.
const COMBAT_EDGES = new Set(['walk', 'climb_up', 'climb_down', 'jump_out', 'dig_through', 'dig_stair_down', 'dig_down', 'pillar', 'bridge']);
// A fight's prices: a dug block is dear, since it spends time under fire and opens the ground; a placed block is cheap.
const FIGHT_DIG_SCALE = 5;
const FIGHT_PLACE_SCALE = 0.4;
// The band goal: floor cells within this many cells of the mob's column, a level either side of its floor.
const BAND_GOAL_CELLS = 2;
// A route is searched again when the mob has moved this far from the cell it was searched toward, when the body is
// this far off its next cell, when it has run out, or when it is this old.
const REPLAN_DRIFT_B = 1.5;
const OFF_ROUTE_B = 1.5;
const ROUTE_MAX_AGE_MS = 2000;
// A route cell is reached inside this flat distance of its centre; a climb is jumped inside CLIMB_JUMP_B of it.
const ARRIVE_B = 0.4;
// THE FLANK: how far past the shooter the walk ends, how near that point counts as there, and the goal's cell reach.
const FLANK_PAST_B = 3;
const FLANK_ARRIVE_B = 1;
const FLANK_GOAL_REACH = 1.2;
const CLIMB_JUMP_B = 1.3;

// ── A BODY THAT STOPS GETTING THERE IS A NAVIGATION FAULT, NOT A MOB'S ───────────────────────────────
// With every move legal, every block can be dug and every gap filled, so a route always exists and no mob is out of reach. A body that has
// neither gained on its mob nor moved for STUCK_MS says so as a fault and raycasts to the mob: the first block on the ray is dug, and a
// clear ray is walked straight at it. The one mob it leaves: one above it, with no block in the pocket to pillar on.
const STUCK_MS = 3000;
const GAIN_B = 1;
const STUCK_RAY_B = 32;
const STUCK_DIG_REACH = 4.5;
const ABOVE_B = 1.5;

let route = null;   // { purpose: 'approach'|'flank', mobId, goalAt, path, idx, at, offRoute, longFrom }
let chase = null;   // { mobId, name, nearest, gainedAt, bodyAt, stuck, ray, gaveUp, close }
let longSearching = false;
let lastMode = null;     // the tick's last order mode, read by think()
let lastMobId = null;
// The flank's walk-to point while one is open (THE FLANK), read by think(); null otherwise.
let flankPoint = null;
let gather = null;   // { since, arcDeg } while backing out of a surround (THE GATHER)

// Only cells whose centre lies within BAND_GOAL_REACH of the mob across the ground: a body on one is inside the band
// even with the mob a level off, so a route that has run out never leaves the body short of it.
const BAND_GOAL_REACH = 2.2;
function bandGoal(mobPos, reach = BAND_GOAL_REACH) {
  const mx = Math.floor(mobPos.x), my = Math.floor(mobPos.y) - 1, mz = Math.floor(mobPos.z);
  const positions = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -BAND_GOAL_CELLS; dx <= BAND_GOAL_CELLS; dx++) {
      for (let dz = -BAND_GOAL_CELLS; dz <= BAND_GOAL_CELLS; dz++) {
        if (Math.hypot(mx + dx + 0.5 - mobPos.x, mz + dz + 0.5 - mobPos.z) > reach) continue;
        positions.push(new Vec3(mx + dx, my + dy, mz + dz));
      }
    }
  }
  return { type: 'multi', positions };
}

// searchRoute(bot, goal, opts) → { path, partial }, or null when no cell can be walked toward it. `works`: the search may dig and place
// at a fight's prices. `from`: where the search starts, the body's floor when omitted. A path stops short of its first edge outside
// COMBAT_EDGES.
async function searchRoute(bot, goal, { works = false, from = null, deadlineMs = COMBAT_THINK_MS } = {}) {
  const self = bot.entity && bot.entity.position;
  if (!self) return null;
  const navigator = require('@locomotion/navigator');
  const t0 = Date.now();
  const res = await computeAStar(bot, from || self.floored().offset(0, -1, 0), goal, {
    sense: () => navigator.freshSearchState(bot, goal), deadlineMs, owner: 'combat',
    allowWorldAlteration: works, spareBuilds: true, digScale: FIGHT_DIG_SCALE, placeScale: FIGHT_PLACE_SCALE, combatGate: false, planningGate: false,
  });
  const ms = Date.now() - t0;
  stats.routeSearches++;
  if (ms > stats.thinkMsMax) stats.thinkMsMax = ms;
  if (res && res.timedOut) stats.routeTimedOut++;
  const all = res && res.path ? res.path : [];
  const offEdge = all.findIndex((s) => !COMBAT_EDGES.has(s.edgeType));
  if (offEdge >= 0) stats.routeOffEdge++;
  const path = offEdge >= 0 ? all.slice(0, offEdge) : all;
  if (!path.length) { stats.routeNone++; return null; }
  const partial = !!res.partial || offEdge >= 0;
  if (partial) stats.routeHops++; else stats.routeFound++;
  return { path, partial };
}

// planPast(bot, mob, hop) — the long search, from the end of the hop being walked. Not awaited: the body walks while it thinks.
function planPast(bot, mob, hop) {
  if (longSearching) return;
  const end = hop.path[hop.path.length - 1].pos;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  hop.longFrom = key(end);
  longSearching = true;
  searchRoute(bot, bandGoal(mob.entity.position), { works: true, from: end, deadlineMs: LONG_THINK_MS }).then((long) => {
    longSearching = false;
    if (!engaged || !long || route !== hop) return;
    const at = hop.path.findIndex((s) => key(s.pos) === hop.longFrom);
    if (at < hop.idx) return;
    const rest = long.path.filter((s) => key(s.pos) !== hop.longFrom);
    hop.path = hop.path.slice(0, at + 1).concat(rest);
    hop.longFrom = null;
    hop.at = Date.now();
    stats.routeJoined++;
    crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'joined', cells: hop.path.length });
  }, (e) => {
    longSearching = false;
    crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'long_threw', why: e && e.message });
  });
}

function routeStale(mob, purpose, now) {
  if (!route || route.purpose !== purpose || route.mobId !== mob.id) return true;
  if (route.offRoute || route.idx >= route.path.length) return true;
  // A hop whose long plan is still thinking is walked out: a new search now would throw that plan away.
  if (route.longFrom && longSearching) return false;
  if (now - route.at > ROUTE_MAX_AGE_MS) return true;
  const p = mob.entity.position;
  return Math.hypot(p.x - route.goalAt.x, p.y - route.goalAt.y, p.z - route.goalAt.z) > REPLAN_DRIFT_B;
}

// routeHeading(self) → { x, z, climb } toward the route's next cell, or null when there is no route left to walk.
function routeHeading(self) {
  if (!route) return null;
  const path = route.path;
  while (route.idx < path.length) {
    const n = path[route.idx].pos;
    if (Math.hypot(n.x + 0.5 - self.x, n.z + 0.5 - self.z) < ARRIVE_B && Math.abs(self.y - (n.y + 1)) < 0.75) route.idx++;
    else break;
  }
  if (route.idx >= path.length) return null;
  const n = path[route.idx].pos;
  const x = n.x + 0.5 - self.x, z = n.z + 0.5 - self.z;
  const flat = Math.hypot(x, z);
  if (flat > OFF_ROUTE_B) route.offRoute = true;
  return { x, z, climb: n.y + 1 > self.y + 0.5 && flat < CLIMB_JUMP_B };
}

function carriesBlock(bot) {
  const items = bot.inventory.items();
  return BRIDGE_PREFS.some((name) => items.some((i) => i.name === name && i.count > 0));
}

// edgeWant(bot, self) → the dig or block the route's next edge needs before the body can take it, or null. Digs come first, nearest
// the body first; a pillar then rises, a bridge then lays its floor.
function edgeWant(bot, self) {
  if (!route || route.purpose !== 'approach' || route.idx >= route.path.length) return null;
  const { pos: n, edgeType } = route.path[route.idx];
  const feet = self.floored();
  const solid = (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z));
    return !!b && b.boundingBox === 'block';
  };
  let cells = [];
  if (edgeType === 'dig_through') cells = [[n.x, n.y + 1, n.z], [n.x, n.y + 2, n.z]];
  else if (edgeType === 'dig_stair_down') for (let y = feet.y + 1; y > n.y; y--) cells.push([n.x, y, n.z]);
  else if (edgeType === 'dig_down') cells = [[feet.x, feet.y - 1, feet.z]];
  else if (edgeType === 'pillar') cells = [[feet.x, feet.y + 2, feet.z], [feet.x, feet.y + 3, feet.z]];
  for (const [x, y, z] of cells) {
    if (!solid(x, y, z)) continue;
    const at = { x, y, z };
    if (isProtected(bot, at)) { route.offRoute = true; return null; }
    return { kind: 'dig', at, why: `route_${edgeType}`, refused: false };
  }
  if (edgeType === 'pillar') return { kind: 'place', at: { x: feet.x, y: feet.y, z: feet.z }, why: 'route_pillar', refused: false };
  if (edgeType === 'bridge' && !solid(n.x, n.y, n.z)) return { kind: 'bridge', at: { x: n.x, y: n.y, z: n.z }, why: 'route_bridge', refused: false };
  return null;
}

// noteGain(bot, mob, now) — reads whether this approach is getting there, and raycasts when it is not.
function noteGain(bot, mob, now) {
  const self = bot.entity.position;
  const d = mob.entity.position.distanceTo(self);
  if (!chase || chase.mobId !== mob.id) chase = { mobId: mob.id, name: mob.name, nearest: d, gainedAt: now, bodyAt: self.clone(), stuck: false, ray: null, gaveUp: false, close: false };
  // A mob at the band is being fought, not chased: the dead-wait clock answers for that fight.
  chase.close = d <= BAND_OUTER + GAIN_B;
  const moved = chase.bodyAt.distanceTo(self) >= GAIN_B;
  if (chase.close || moved || d <= chase.nearest - GAIN_B) {
    chase.nearest = Math.min(d, chase.nearest);
    chase.gainedAt = now;
    chase.bodyAt = self.clone();
    chase.stuck = false;
    chase.ray = null;
    return;
  }
  if (now - chase.gainedAt < STUCK_MS) return;
  const hit = eyeLineHit(bot, eyePos(bot.entity), eyePos(mob.entity), STUCK_RAY_B);
  chase.ray = hit && hit.position ? { x: hit.position.x, y: hit.position.y, z: hit.position.z, name: hit.name } : null;
  if (!chase.stuck) {
    chase.stuck = true;
    stats.stuck++;
    crewLog.event(TAG, 'stuck', { subject: `${mob.name}#${mob.id}`, d: d.toFixed(2), route: route ? route.path.length - route.idx : 0, ray: chase.ray ? `${chase.ray.name}@${chase.ray.x},${chase.ray.y},${chase.ray.z}` : 'clear', blocks: carriesBlock(bot) });
  }
  if (!chase.gaveUp && mob.entity.position.y - self.y > ABOVE_B && !carriesBlock(bot)) {
    chase.gaveUp = true;
    stats.gaveUp++;
    crewLog.event(TAG, 'gave_up', { subject: `${mob.name}#${mob.id}`, d: d.toFixed(2), why: 'no_pillar_material' });
  }
}

// stuckWant(bot, self) → the dig of the first block on a stuck body's ray to its mob, once in reach; or null.
function stuckWant(bot, self) {
  if (!chase || !chase.stuck || !chase.ray) return null;
  const at = { x: chase.ray.x, y: chase.ray.y, z: chase.ray.z };
  if (Math.hypot(at.x + 0.5 - self.x, at.y + 0.5 - self.y, at.z + 0.5 - self.z) > STUCK_DIG_REACH || isProtected(bot, at)) return null;
  return { kind: 'dig', at, why: 'stuck_ray', refused: false };
}

// think(bot) — the route decision, awaited once per battle_stations pass. Runs at most one search; the tick keeps
// walking the last route while it does.
async function think(bot) {
  if (!engaged || !stats) return;
  const self = bot.entity && bot.entity.position;
  if (!self) return;
  const board = crewBoard.readCommander();
  const mob = (board.active || []).find((h) => h.id === lastMobId) || null;
  if (!mob || !mob.entity || !mob.entity.position) return;
  const now = Date.now();

  // Only an approach is a chase: a body backing off, flanking or running is on no clock.
  if (lastMode === 'approach') noteGain(bot, mob, now);
  else if (chase) { chase.gainedAt = now; chase.stuck = false; chase.ray = null; }
  if (lastMode === 'flank' && flankPoint) {
    if (!routeStale(mob, 'flank', now)) return;
    const goalAt = mob.entity.position.clone();
    const found = await searchRoute(bot, bandGoal(flankPoint, FLANK_GOAL_REACH));
    if (!engaged) return;
    const path = found && !found.partial ? found.path : null;
    route = path ? { purpose: 'flank', mobId: mob.id, goalAt, path, idx: 0, at: Date.now(), offRoute: false } : null;
    crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: path ? 'found' : 'none', purpose: 'flank', cells: path ? path.length : 0 });
    return;
  }
  if (lastMode !== 'approach' || !routeStale(mob, 'approach', now)) return;
  const found = await searchRoute(bot, bandGoal(mob.entity.position), { works: true });
  if (!engaged) return;
  if (found) {
    if (!route || route.mobId !== mob.id) crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: found.partial ? 'hop' : 'found', cells: found.path.length });
    route = { purpose: 'approach', mobId: mob.id, goalAt: mob.entity.position.clone(), path: found.path, idx: 0, at: Date.now(), offRoute: false, longFrom: null };
    if (found.partial) planPast(bot, mob, route);
    return;
  }
  route = null;
  crewLog.event(TAG, 'route', { subject: `${mob.name}#${mob.id}`, state: 'none' });
}

// chaseVerdict() → { mobId, state, why } for the mob this fight is closing on, or null. 'chasing' is the fight still open; 'gave_up' ends it.
function chaseVerdict() {
  return chase ? { mobId: chase.mobId, state: chase.gaveUp ? 'gave_up' : chase.close ? 'close' : 'chasing', why: chase.gaveUp ? 'no_pillar_material' : null } : null;
}

// endChase(id) — battle_stations retired the mob; the chase and its route go with it.
function endChase(id) {
  if (chase && chase.mobId === id) chase = null;
  if (route && route.mobId === id) route = null;
}

// This seat never writes yaw (Invariant D), so a dig/place need is asked of the gunner (serveTerrain) as
// a want, republished each tick it holds and null the instant it doesn't (silence is withdrawal,
// Invariant B). Per-tick, not a route: vertical_gap above/below asks place/dig; a stalled press asks dig
// only after a second stall-jump confirms a wall, not a kerb.
const STALL_JUMPS_BEFORE_DIG = 2;

// A want re-derived from a moving heading names a different cell every tick and never lets a dig
// finish, so the cell is latched when first asked for and re-published unchanged while its own reason
// holds (a mode change or the cell going to air clears it).
let wantLatch = null;

function latchHolds(bot, order, dy) {
  const L = wantLatch;
  if (!L) return false;
  if (L.kind === 'place') return order.mode === 'vertical_gap' && dy > 0;
  const b = bot.blockAt(new Vec3(L.at.x, L.at.y, L.at.z));
  if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return false;
  return L.why === 'target_below'
    ? (order.mode === 'vertical_gap' && dy < 0)
    : stallJumps >= STALL_JUMPS_BEFORE_DIG;
}

// navigator.loadProtectedBlocks is the one inspection point for what the bot refuses to dig (Law 16);
// the gate belongs on the ask, not the gunner's serve. Required lazily to avoid a require cycle with
// battle_stations and to skip building the Set on ticks with no want.
function isProtected(bot, cell) {
  const { loadProtectedBlocks } = require('@locomotion/navigator');
  const set = loadProtectedBlocks(bot);
  return !!set && set.has(`${cell.x},${cell.y},${cell.z}`);
}

function terrainWant(bot, self, order, dy, heading, mob) {
  // The route's own edge outranks every other ask.
  const edge = order.mode === 'approach' ? edgeWant(bot, self) : null;
  if (edge) {
    wantLatch = null;
    stallJumps = 0;
    return edge;
  }
  const ray = order.mode === 'approach' && chase && chase.mobId === mob.id ? stuckWant(bot, self) : null;
  if (ray) {
    wantLatch = null;
    return ray;
  }
  // A refusal is latched too and re-validated by the same test, so it expires only when a fresh answer
  // could differ.
  if (latchHolds(bot, order, dy)) return wantLatch.refused ? null : wantLatch;
  wantLatch = null;
  const feet = self.floored();
  if (order.mode === 'vertical_gap') {
    if (dy > 0) {
      wantLatch = { kind: 'place', at: { x: feet.x, y: feet.y, z: feet.z }, why: 'target_above', refused: false };
      return wantLatch.refused ? null : wantLatch;
    }
    const floor = { x: feet.x, y: feet.y - 1, z: feet.z };
    wantLatch = { kind: 'dig', at: floor, why: 'target_below', refused: isProtected(bot, floor) };
    return wantLatch.refused ? null : wantLatch;
  }
  if (stallJumps < STALL_JUMPS_BEFORE_DIG || !heading) return null;
  // A body walking a route that stalls is searched a new route from where it stands, as the navigator would; it
  // never digs a way the route did not ask for (SECTION 4c).
  if (order.mode === 'approach' && route && route.mobId === mob.id) {
    route.offRoute = true;
    stallJumps = 0;
    return null;
  }
  // Feet level first, then head, so the ask targets what's actually blocking; air at both asks nothing
  // (Law 25).
  const len = Math.hypot(heading.x, heading.z) || 1;
  const ahead = feet.offset(Math.round(heading.x / len), 0, Math.round(heading.z / len));
  for (const cell of [ahead, ahead.offset(0, 1, 0)]) {
    const b = bot.blockAt(cell);
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      // A protected cell is no ask at all — the next cell of a protected wall is protected too.
      wantLatch = { kind: 'dig', at: { x: cell.x, y: cell.y, z: cell.z }, why: 'stalled_against_it',
        refused: isProtected(bot, cell) };
      return wantLatch.refused ? null : wantLatch;
    }
  }
  return null;
}

// ── SECTION 5: The tick ────────────────────────────────────────────────────

// The mob this seat controls on, which can differ from the gunner's target (a swelling creeper takes
// over). A body with a shield in its off-hand tanks the blast behind it (gunner's swell guard), so for it a swelling
// creeper is held in the band like any other mob, never backed off from.
function controlMob(board, shielded) {
  // An open flank is walked against its shooter, whatever stands nearer: the melee mob is being led, not fought.
  if (board.flank && board.focus && board.focus.id === board.flank.shooterId) {
    const melee = (board.active || []).find((h) => h.id === board.flank.meleeId) || null;
    return { mob: board.focus, swelling: false, melee };
  }
  const swelling = shielded ? [] : (board.swelling || []);
  if (swelling.length) {
    // active is already nearest-first (commander sorts once).
    const creeper = (board.active || []).find((h) => swelling.includes(h.id));
    if (creeper) return { mob: creeper, swelling: true };
  }
  // Band held against the nearest mob, independent of the gunner's target; swell still outranks it
  // (Law 17).
  const nearestAny = (board.active || [])[0] || null;
  if (nearestAny && nearestAny.distance < BAND_INNER) {
    return { mob: nearestAny, swelling: false };
  }

  // `focus` answers the arm's question and is null while drawing; feet fall back to `closest`.
  const stand = board.focus || board.closest;
  return stand ? { mob: stand, swelling: false } : { mob: null, swelling: false };
}

// One trace line when the feet's answer changes; a control-mob switch counts as a change too.
function announceMode(mode, distance, setpoint, mob, horizontal, dy) {
  const on = mob ? mob.id : null;
  if (mode === saidMode && on === saidOn) return;
  saidMode = mode;
  saidOn = on;
  crewLog.event(TAG, 'mode', {
    subject: mob ? crewLog.subject(mob.entity) : null,
    to: mode,
    d: distance === null || distance === undefined ? null : distance.toFixed(2),
    // Rides with the mode: `approach` reads differently flat vs vertical.
    across: Number.isFinite(horizontal) ? horizontal.toFixed(2) : null,
    up: Number.isFinite(dy) ? dy.toFixed(2) : null,
    setpoint: setpoint === null || setpoint === undefined ? null : setpoint,
  });
}

// Unguarded: setControlState only asserts on our own bad literal, never mid-tick state.
function release(bot) {
  for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false);
  if (sprintArmed) { bot.setControlState('sprint', false); sprintArmed = false; }
  if (jumpTicks > 0) { bot.setControlState('jump', false); jumpTicks = 0; }
  // Lives here, not the tick's latch, since this is where the key actually drops.
  if (saidSprint) {
    saidSprint = false;
    crewLog.event(TAG, 'sprint', { state: 'off', why: 'released' });
  }
  stallTicks = 0;
  stallJumps = 0;
  wantLatch = null;
  // lastPos does not carry across an engagement boundary.
  lastPos = null;
}

function onPhysicsTick(bot) {
  if (!engaged) return;
  // The water survival owner holds the controls until the interrupted engagement ends.
  if (require('@locomotion/underwater_swimming').survivalHasControl(bot)) return;
  stats.ticks++;

  const self = bot.entity && bot.entity.position;
  if (!self) return;                                        // dead or mid-respawn: nothing to drive

  const board = crewBoard.readCommander();
  // A body carrying a block answers a swell with the gunner's blast wall, so it stands like a shielded one.
  const { mob, swelling, melee } = controlMob(board, combatUtils.holdsShield(bot) || carriesBlock(bot));
  const survival = crewBoard.readSurvival();

  if (!mob) {
    stats.noTarget++;
    release(bot);
    announceMode('no_target', null, null, null);
    writeBoard({ mode: 'no_target', setpoint: null, error: null, keys: null, sprint: false, sprinting: false, targetId: null, terrainRequest: null, at: Date.now() });
    return;                                                 // release() above dropped both carried samples
  }

  // Read fresh, not the board's cached distance: this seat corrects sub-block (Invariant B).
  const mobPos = mob.entity && mob.entity.position;
  if (!mobPos) { release(bot); return; }                    // body left the table between sweep and now
  const distance = Math.hypot(self.x - mobPos.x, self.y - mobPos.y, self.z - mobPos.z);
  // horizontal is what the feet can change; dy is why they sometimes cannot.
  const horizontal = Math.hypot(self.x - mobPos.x, self.z - mobPos.z);
  const dy = mobPos.y - self.y;

  // Read-back before this tick writes (Law 23); peak speed distinguishes a real sprint from dilution.
  if (sprintArmed) {
    stats.sprintAskedLastTick++;
    // A plain property read on mineflayer's own state object — optional chaining is the whole guard.
    if (bot.controlState?.sprint === true) stats.sprintHeld++;
  }

  const now = Date.now();
  const friend = crewBoard.readGunner().sweepFriend;
  if (!recenter && friend) {
    recenter = { setpoint: horizontal + RECENTER_BLOCKS, at: now, friend: friend.name };
    stats.recenters++;
    crewLog.event(TAG, 'recenter', { subject: crewLog.subject(mob.entity), friend: friend.name, from: horizontal.toFixed(2), setpoint: recenter.setpoint.toFixed(2) });
  }
  // A melee mob is held at MELEE_BAND_INNER, outside its own reach, so the knockback swing lands before its blow can.
  const meleeMob = combatUtils.combatTactic(mob.name, mob.entity) === 'BRAWLER' && !(mob.name in MOB_AGGRO_RANGE);
  // THE HIT-AND-BACK: no shield, a melee mob, and the weapon still recharging.
  const readyInMs = crewBoard.readGunner().readyInMs;
  const kite = meleeMob && !combatUtils.holdsShield(bot) && Number.isFinite(readyInMs) && readyInMs > KITE_LEAD_MS;
  if (kite) stats.kiteTicks++;
  let order = bandOrder({ horizontal, dy, distance, swelling, standoff: recenter ? recenter.setpoint : standoff,
    inner: kite ? KITE_INNER : meleeMob ? MELEE_BAND_INNER : BAND_INNER, outer: kite ? KITE_OUTER : BAND_OUTER });
  // ── THE FLANK ──────────────────────────────────────────────────────────────
  // Walk to FLANK_PAST_B beyond the shooter on the side away from the melee mob. From there the shooter stands
  // between the body and the chasing melee mob, so both come from the front; the commander closes the flank once
  // they share a side, and the band takes over. Arrived early, the band holds against the shooter meanwhile.
  flankPoint = null;
  if (melee && melee.entity && melee.entity.position) {
    const mp = melee.entity.position;
    const ux = mobPos.x - mp.x, uz = mobPos.z - mp.z;
    const len = Math.hypot(ux, uz);
    if (len > 0) {
      const point = new Vec3(mobPos.x + ux / len * FLANK_PAST_B, mobPos.y, mobPos.z + uz / len * FLANK_PAST_B);
      if (Math.hypot(point.x - self.x, point.z - self.z) > FLANK_ARRIVE_B) {
        flankPoint = point;
        order = { mode: 'flank', setpoint: null, error: 0 };
        stats.flankTicks++;
      }
    }
  }
  // ── THE GATHER ─────────────────────────────────────────────────────────────
  // A swelling creeper or an open flank keeps its own walk.
  let gatherStep = null;
  if (order.mode !== 'flank' && !swelling) {
    const near = (board.active || []).filter((h) => h.distance <= GATHER_RANGE_B && h.entity && h.entity.position)
      .map((h) => h.entity.position);
    const spread = spreadOf(self, near);
    const wide = spread && spread.arcDeg >= (gather ? GATHER_EXIT_DEG : GATHER_ENTER_DEG);
    gatherStep = wide ? gatherHeading(bot, spread) : null;
    if (gatherStep && !gather) {
      gather = { since: now, arcDeg: spread.arcDeg };
      stats.gathers++;
      crewLog.event(TAG, 'gather', { state: 'open', arc: Math.round(spread.arcDeg), mobs: near.length });
    } else if (!gatherStep && gather) {
      crewLog.event(TAG, 'gather', { state: 'closed', arc: spread ? Math.round(spread.arcDeg) : null, held: `${now - gather.since}ms`,
        why: wide ? 'no_walkable_heading' : 'gathered' });
      gather = null;
    }
    if (gatherStep) { order = { mode: 'gather', setpoint: null, error: 0 }; stats.gatherTicks++; }
  } else if (gather) {
    crewLog.event(TAG, 'gather', { state: 'closed', held: `${now - gather.since}ms`, why: swelling ? 'swelling' : 'flank' });
    gather = null;
  }
  if (recenter && (order.mode.endsWith('_clear') || now - recenter.at >= RECENTER_MAX_MS)) recenter = null;
  // THE RUN outranks every walk of the fight: the body's life before the mob (Law 17).
  const fleeing = survival.fleeing === true;
  if (fleeing) { order = { mode: 'flee', setpoint: null, error: 0 }; stats.fleeTicks++; }
  // BEHIND THE BLAST WALL THE BODY STANDS STILL (gunner, THE BLAST WALL): a step off the creeper's line walks the body
  // out from behind its block. Outranks the run: no body outruns a fuse.
  const wallNow = crewBoard.readGunner().wall;
  if (wallNow && (wallNow.state === 'placing' || wallNow.state === 'set')) {
    order = { mode: 'wall_hold', setpoint: null, error: 0 };
    stats.wallHoldTicks++;
  }

  // Two accumulators: standoff errs against SWELL_CLEAR, the band against BAND_INNER/OUTER, so one
  // doesn't print as the other (Law 25).
  if (order.mode === 'flank' || order.mode === 'gather' || order.mode === 'flee' || order.mode === 'wall_hold') {
    // The flank and the gather walk to a heading, not a band: they add to neither error accumulator.
  } else if (order.mode === 'approach' || order.mode === 'retreat' || order.mode === 'hold' || order.mode === 'vertical_gap') {
    stats.errTicks++;
    stats.errSum += order.error;
    if (order.error > stats.worstBreach) stats.worstBreach = order.error;
  } else {
    stats.standoffTicks++;
    stats.standoffErrSum += order.error;
  }
  // Scored against the flat gap the band actually holds, not the 3-D total.
  if (horizontal >= BAND_INNER && horizontal <= BAND_OUTER) stats.inBandTicks++;
  // Counted apart so the report can say specifically that a fight was unwinnable from the ground.
  if (order.mode === 'vertical_gap') { stats.verticalGapTicks++; stats.verticalGapSum += Math.abs(dy); }
  announceMode(order.mode, distance, order.setpoint, mob, horizontal, dy);
  lastMode = order.mode;
  lastMobId = mob.id;
  // Backing off is whole-field (nine-candidate search); closing is one-mob, since anything else is
  // further by construction. moving is full press or none.
  const moving = order.mode !== 'hold' && order.mode !== 'vertical_gap' && order.mode !== 'wall_hold'
    && order.mode !== 'no_target' && !order.mode.endsWith('_clear');
  let heading = null;
  let stepInfo = null;
  let climb = false;
  let swim = false;
  if (moving && order.mode === 'flee') {
    const run = fleeStep(bot, board.active, survival.goal);
    if (run) { heading = { x: run.x, z: run.z }; climb = run.climb; swim = !!run.swim; }
  } else if (moving && order.mode === 'gather') {
    heading = gatherStep;
  } else if (moving && order.mode === 'flank') {
    // Walked only on a route, like the approach: no route yet is standing while think() searches.
    const step = route && route.mobId === mob.id && route.purpose === 'flank' ? routeHeading(self) : null;
    if (step) { heading = { x: step.x, z: step.z }; climb = step.climb; }
  } else if (moving && order.mode !== 'approach') {
    // Away from the whole press, not just the control mob.
    stepInfo = chooseStep(bot, board.active);
    if (stepInfo && stepInfo.controls) heading = { x: stepInfo.controls.dx, z: stepInfo.controls.dz };
    else if (stepInfo && stepInfo.stood) heading = null;     // standing scored best: it is an answer
  } else if (moving) {
    // The approach walks only a route (SECTION 4c). No route for this mob yet is standing still while think() searches: never a
    // straight press at the mob. An edge still owing a dig or a block is worked from where the body stands.
    const step = route && route.mobId === mob.id && route.purpose === 'approach' ? routeHeading(self) : null;
    if (step && !edgeWant(bot, self)) { heading = { x: step.x, z: step.z }; climb = step.climb; }
    // A stuck body walks the ray itself, up to the block it has to dig.
    if (chase && chase.mobId === mob.id && chase.stuck && !stuckWant(bot, self) && !edgeWant(bot, self)) heading = { x: mob.entity.position.x - self.x, z: mob.entity.position.z - self.z };
  }

  // ── THE KNOCKBACK SWING ────────────────────────────────────────────────────
  // A melee mob is hit with a sprint swing, so the blow throws it back out of its own reach and it never lands one.
  // The gunner lowers the shield and publishes `knockback` with the mob's id, holding the swing; this seat presses
  // toward the mob and arms sprint, and publishes `sprinting`, so the server holds the sprint before the attack
  // packet. Read off the gunner's board, never called across (Law 1).
  const gunnerBoard = crewBoard.readGunner();
  const knockback = gunnerBoard.knockback != null && gunnerBoard.knockback === mob.id && gunnerBoard.shield !== true;
  if (knockback) {
    heading = { x: mob.entity.position.x - self.x, z: mob.entity.position.z - self.z };
    climb = false;
    stats.knockbackTicks++;
  }

  // ── SPRINT ─────────────────────────────────────────────────────────────────
  // Knockback/closing tool: arms on brawler approach and kiter-closing ticks, never at rest (Law 19).
  // SPRINT_RELEASE_B releases one tick clear of the arm's reach so the flag drops before a swing resolves.
  const SPRINT_RELEASE_B = 3.3;
  const shoves = order.mode === 'approach' && combatUtils.combatTactic(mob.name, mob.entity) === 'BRAWLER';
  const closing = (order.mode === 'approach' && distance > SPRINT_RELEASE_B)
    || order.mode === 'flank';

  // A press is a press — no fraction, no dither. `heading` null is the only stop.
  const press = heading !== null;

  // Yaw read raw from the body, not the board — this seat never writes yaw (Law 21).
  const keys = press && heading ? headingKeys(heading, bot.entity.yaw) : NO_KEYS;

  // Unguarded, same reason as release(): the only throw setControlState has is our own bad literal.
  for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, keys[k]);

  // Re-armed, not set, because the server clears sprint after an attack while mineflayer's flag stays
  // true (Law 19); shield exclusion is read off the gunner's published guard, not reached for (Law 1).
  const guarding = crewBoard.readGunner().shield === true;
  if (guarding) stats.sprintBlockedByShield++;
  // SPRINT PRIMED BEHIND THE SHIELD: the server's knockback bonus reads only the sprint flag at the attack, so with a
  // melee mob within PRIME_B the flag is held up while the guard is, and the gunner's knockback swing lowers the shield
  // and strikes in one tick, with no wait for sprint during which the mob could land its blow.
  const PRIME_B = 3.5;
  const primed = guarding && (board.active || []).some((h) => h.distance <= PRIME_B
    && combatUtils.combatTactic(h.name, h.entity) === 'BRAWLER' && !(h.name in MOB_AGGRO_RANGE));
  if (primed) stats.primedTicks++;
  const wantSprint = knockback || primed || (press && (shoves || closing || fleeing) && !guarding);
  if (wantSprint) {
    combatUtils.armSprint(bot);
    sprintArmed = true;
    stats.sprintTicks++;
  } else if (sprintArmed) {
    combatUtils.releaseSprint(bot);
    sprintArmed = false;
  }
  // Announced with its stop reason since guard/not-brawler/no-press want different repairs.
  if (wantSprint !== saidSprint) {
    saidSprint = wantSprint;
    crewLog.event(TAG, 'sprint', {
      state: wantSprint ? 'on' : 'off',
      why: knockback ? 'knockback_swing' : primed ? 'primed' : wantSprint && fleeing ? 'flee' : wantSprint ? 'knockback' : (guarding ? 'guarding' : (!shoves ? 'not_brawler' : 'no_press')),
    });
  }
  if (press) stats.pressedTicks++;

  // ── THE STALL TAP ──────────────────────────────────────────────────────────
  const travelled = lastPos ? Math.hypot(self.x - lastPos.x, self.z - lastPos.z) : null;
  if (travelled !== null) {
    // Sampled only on ticks the body was asked to move (Law 25).
    if (press) {
      stats.speedTicks++;
      const bps = travelled * 20;
      stats.speedGotSum += bps;
      if (bps > stats.speedPeak) stats.speedPeak = bps;
    }
    if (press && travelled < STALL_EPS) stallTicks++; else { stallTicks = 0; stallJumps = 0; }
  }
  // A swum run holds jump, re-armed each tick it swims, and released by the countdown once it stops.
  if (swim && press) { bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; }
  // THE HEAD KEPT UP IN WATER: a body that fights standing in water two deep has its eyes under, and nothing else holds
  // it up (underwater_swimming is only the breath override, taken at low air, and it ends the wave). Jump is held while
  // the eye is under, as the navigator's swim step holds it, so the fight is fought breathing.
  else if (bot.entity.isInWater && require('@locomotion/underwater_swimming').submerged(bot)) { bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; }
  if (jumpTicks > 0) {
    jumpTicks--;
    if (jumpTicks === 0) bot.setControlState('jump', false);
  } else if (climb && press && bot.entity.onGround) {
    // The route's next cell is a tread up: jumped as the body reaches it, not after a stall.
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS;
  } else if (stallTicks >= STALL_TICKS) {
    let jumped = false;
    // setControlState asserts only on our own bad literal, never the world's, so the press is unguarded.
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; jumped = true;
    stallTicks = 0;
    stallJumps++;
    if (order.mode === 'flee') barFleeHeading(Date.now());
    // A stall event carries its cause (mode + keys) and whether the jump tap was tried.
    crewLog.event(TAG, 'stall', {
      subject: crewLog.subject(mob.entity), mode: order.mode, d: distance.toFixed(2),
      keys: Object.keys(keys).filter((k) => keys[k]).join('+') || 'none',
      jump: jumped ? 'yes' : 'no',
    });
  }
  lastPos = { x: self.x, z: self.z };
  stats.engagedTicks++;

  // Counted before the write so the tally and the published want can never disagree.
  const want = terrainWant(bot, self, order, dy, heading, mob);
  if (want) {
    stats.terrainAskTicks++;
    if (want.kind === 'dig') stats.terrainAskDig++; else if (want.kind === 'bridge') stats.terrainAskBridge++; else stats.terrainAskPlace++;
    // Read, never assumed (Law 1, Law 23).
    const ans = crewBoard.readGunner().terrainStatus;
    if (ans && ans.state === 'refused') stats.terrainRefusedTicks++;
    // A block the gunner could not set ends that route: the next search reads the world as it stands.
    if (want.kind !== 'dig' && ans && ans.state === 'failed' && route) route.offRoute = true;
  }

  writeBoard({
    mode: order.mode,
    setpoint: order.setpoint,
    error: order.error,
    // Recomputed from this tick's state, never carried (level-triggered; a stale want cannot survive).
    terrainRequest: want,
    distance,
    targetId: mob.id,
    swelling,
    keys: press ? keys : null,
    // The flat unit heading pressed this tick; the gunner turns a running body along it (THE RUN).
    heading: press && heading ? { x: heading.x, z: heading.z } : null,
    sprint: press,
    // Sprint armed this tick: the gunner holds a knockback swing until it reads true (THE KNOCKBACK SWING).
    sprinting: wantSprint,
    // Step search verdict posted, not re-derived.
    stepGain: stepInfo ? stepInfo.gain : null,
    stepBlocked: stepInfo ? stepInfo.blocked : null,
    // The route being walked and the chase verdict (SECTION 4c), for any reader.
    route: route ? { purpose: route.purpose, mobId: route.mobId, cells: route.path.length, idx: route.idx } : null,
    chase: chaseVerdict(),
    at: Date.now(),
  });
}

// ── SECTION 6: Public API ──────────────────────────────────────────────────

// Handler held so stop() removes exactly its own; three seats share physicsTick.
function start(bot) {
  if (attached) return;
  stats = _blankStats();
  tickHandler = () => onPhysicsTick(bot);
  bot.on('physicsTick', tickHandler);
  attached = true;
}

function stop(bot) {
  if (!attached || !tickHandler) return;
  // removeListener is EventEmitter bookkeeping and cannot fail; a throw here would mean no bot (Law 13).
  (bot || global.bot).removeListener('physicsTick', tickHandler);
  tickHandler = null;
  attached = false;
  engaged = false;
}

// engage()/disengage() bracket a wave; release() runs on the way out (Law 8).
function engage() {
  if (engaged) return;
  stats = _blankStats();
  lastPos = null;
  stallTicks = 0;
  stallJumps = 0;
  wantLatch = null;
  recenter = null;
  standoff = null;
  route = null;
  chase = null;
  lastMode = null;
  lastMobId = null;
  flankPoint = null;
  gather = null;
  // Cleared so a new wave's first line isn't suppressed by the last mode (Invariant B).
  saidMode = null;
  saidOn = null;
  saidSprint = false;
  engaged = true;
}

function disengage(bot) {
  if (!engaged) return;
  engaged = false;
  recenter = null;
  route = null;
  chase = null;
  gather = null;
  if (bot) release(bot);
}

// One aggregated line per wave (Law 5 — no per-tick logging in this seat).
function report() {
  if (!stats) return;
  // Silence would read as nothing to report when the feet never got a target (Law 25). A run or a stand behind a
  // blast wall had one: neither adds to the band's error.
  if (!stats.errTicks && !stats.fleeTicks && !stats.wallHoldTicks) {
    if (stats.ticks) {
      watcher.warn(TAG,
        `🚗 Driver: ${stats.ticks} tick(s) engaged and NOT ONE of them had a target — ` +
        `${stats.noTarget} tick(s) read an empty board. The feet sat out this entire fight. The commander ` +
        `owns which mob is on the board (aggro + sightline); this seat only reads it.`);
    }
    return;
  }
  const meanErr = stats.errTicks ? stats.errSum / stats.errTicks : 0;
  const inBand = stats.errTicks ? (100 * stats.inBandTicks) / stats.errTicks : 0;
  const got = stats.speedTicks ? stats.speedGotSum / stats.speedTicks : 0;
  // These numbers are measured on ticks that emitted nothing to the event stream.
  watcher.summary(TAG,
    `🚗 Driver: ${stats.errTicks} tick(s) on a target. Mean error ${meanErr >= 0 ? '+' : ''}${meanErr.toFixed(2)}b ` +
    `outside the band (positive = too close, 0 = in it), worst breach ${stats.worstBreach.toFixed(2)}b, ` +
    `${inBand.toFixed(0)}% of ticks inside ${BAND_INNER}–${BAND_OUTER}b. ` +
    `Body achieved ${got.toFixed(2)}b/s while moving (a sprint is ${SPRINT_SPEED}) over ${stats.pressedTicks} pressed tick(s). ` +
    // Sprint as a fraction of the press is the policy itself; the read-back is the only proof it fired
    // (Law 23).
    `Sprint (knockback only — brawler approaches): armed on ${stats.sprintTicks} of ${stats.pressedTicks} pressed tick(s), ` +
    `still set on the next tick ${stats.sprintHeld}/${stats.sprintAskedLastTick}, ` +
    `peak ${stats.speedPeak.toFixed(2)}b/s against a ${SPRINT_SPEED} sprint and a ${WALK_SPEED} walk` +
    `${stats.sprintBlockedByShield ? `, and the shield held sprint down on ${stats.sprintBlockedByShield} tick(s)` : ''}` +
    `${stats.knockbackTicks ? `; sprinted into the gunner's knockback swing on ${stats.knockbackTicks} tick(s)` : ''}` +
    `${stats.flankTicks ? `; walked a flank past the shooter on ${stats.flankTicks} tick(s)` : ''}` +
    `${stats.gatherTicks ? `; backed out of a surround ${stats.gathers} time(s) over ${stats.gatherTicks} tick(s)` : ''}` +
    `${stats.kiteTicks ? `; held a melee mob out of reach while the weapon recharged on ${stats.kiteTicks} tick(s)` : ''}` +
    `${stats.fleeTicks ? `; ran for its life on ${stats.fleeTicks} tick(s)` : ''}` +
    `${stats.wallHoldTicks ? `; stood behind a blast wall on ${stats.wallHoldTicks} tick(s)` : ''}.` +
    `${stats.standoffTicks ? ` Standoff (counted apart from the band): ${stats.standoffTicks} tick(s), mean error ${(stats.standoffErrSum/stats.standoffTicks).toFixed(2)}b.` : ''}` +
    `${stats.recenters ? ` Recentered off a friend in the sweep: ${stats.recenters} time(s).` : ''}`);

  if (stats.routeSearches) {
    watcher.summary(TAG,
      `🚗 Route: ${stats.routeSearches} search(es) on the navigator's pathfinder with ${COMBAT_THINK_MS}ms to think — ` +
      `${stats.routeFound} found, ${stats.routeNone} none (${stats.routeTimedOut} out of thinking time, ` +
      `${stats.routeOffEdge} only through a door, swim or wade); slowest think ${stats.thinkMsMax}ms.` +
      `${stats.routeHops ? ` ${stats.routeHops} hop(s) walked on a partial search, ${stats.routeJoined} joined to a long plan.` : ''}${stats.stuck ? ` ${stats.stuck} navigation fault(s): stuck ${STUCK_MS}ms, raycast to the mob.` : ''}${stats.gaveUp ? ` ${stats.gaveUp} mob(s) left for no pillar material.` : ''}`);
  }
  // Separate from the summary: an unwinnable-from-ground fight is a terrain fact, not a steering fault.
  if (stats.terrainAskTicks) {
    watcher.summary(TAG,
      `🚗 asked the gunner for terrain on ${stats.terrainAskTicks} tick(s) — ${stats.terrainAskDig} dig, ` +
      `${stats.terrainAskPlace} pillar, ${stats.terrainAskBridge} bridge; the yaw was spoken for on ${stats.terrainRefusedTicks} of them. ` +
      `This seat never digs: it publishes a want and the gunner serves it or does not (see its own line).`);
  }
  if (stats.verticalGapTicks) {
    const meanRise = stats.verticalGapSum / stats.verticalGapTicks;
    watcher.warn(TAG,
      `🚗 UNWINNABLE FROM THE GROUND — ${stats.verticalGapTicks} of ${stats.errTicks} tick(s) had the feet correctly ` +
      `placed with the mob still out of the arm's ${BOT_STRIKE_REACH}b, mean ${meanRise.toFixed(2)}b of rise between them. ` +
      `The band is held across the ground because that is the only axis the feet move on, so this separation is ` +
      `not a steering fault and no key closes it — it needs a verb that changes the body's height. ` +
      `The engagement was never dropped: admitting a mob is the commander's (aggro + sightline), and this seat only ` +
      `reports that it has done all a pair of feet can.`);
  }
}

// The one thing another seat may write here — a setpoint, not a command (Invariant D).
function setStandoff(range) {
  standoff = Number.isFinite(range) ? range : null;
}

function state() {
  return { attached, engaged, stats: stats ? { ...stats } : null };
}

module.exports = {
  start, stop, engage, disengage, report, state, setStandoff,
  // The route seat's async half, awaited by battle_stations' pass, and its verdict (SECTION 4c).
  think, chaseVerdict, endChase,
  // Bench exports: both pure, both where this seat can be wrong arithmetically.
  bandOrder, chooseStep,
  // Bench export for the route: the goal.
  bandGoal,
  BAND_INNER, BAND_OUTER, SWELL_CLEAR, WALK_SPEED, SPRINT_SPEED, COMBAT_THINK_MS,
};
