// module: driver — the crew's lower body. Owns WSAD/sprint everywhere a fight is open; reads the
// commander's board and the gunner's yaw; writes no yaw, sends no attack, derives no monster data.
// contract: start(bot)/stop(bot) attach/detach a physicsTick handler, one synchronous decision per tick
// (never awaits). engage()/disengage() bracket a wave. Only seat that may write forward/back/left/right/
// sprint/jump.
//
// One universal tactic (Law 16): close on the closest aggroed monster and hold the 2.9-1.9 band, except
// a swelling creeper, which is backed off from. Retreat direction is a scored search over candidate
// steps (SECTION 4b), not a vector sum. Sprint is a knockback/closing tool, not a travel speed.

'use strict';

const Vec3 = require('vec3');
const crewBoard = require('@api/crew_board');
const combatUtils = require('@utils/combat_utils');
const { headingKeys } = require('@utils/movement/motion_primitives');
// The band below is derived from this reach; not copied locally (Law 16).
const { BOT_STRIKE_REACH, BOT_WIDTH } = require('@utils/combat_utils');
const { classifyFloor } = require('@utils/movement/terrain_predicates');
const watcher = require('@kernel/watcher');
const crewLog = require('@api/crew_log');

const writeBoard = crewBoard.claimPen('driver');

const TAG = 'driver';

// ── SECTION 1: The numbers ─────────────────────────────────────────────────

// In the band the bot is within its own 3.0 b reach (BOT_STRIKE_REACH) and outside the mob's ~1.43 b,
// so every cooldown lands a hit.
const BAND_INNER = 1.9;
const BAND_OUTER = 2.9;

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

const NO_KEYS = { forward: false, back: false, left: false, right: false };

// Trace filter: a line is emitted only when the mode differs from last tick's (Invariant B).
let saidMode = null;
let saidOn = null;      // control mob when saidMode was posted, so a mob switch counts as a change
let saidSprint = false;

function _blankStats() {
  return {
    ticks: 0, engagedTicks: 0, noTarget: 0,
    sprintTicks: 0, pressedTicks: 0,
    sprintAskedLastTick: 0, sprintHeld: 0, speedPeak: 0, sprintBlockedByShield: 0,
    standoffTicks: 0, standoffErrSum: 0,
    // inBandTicks = fraction of the fight in striking distance; worstBreach = deepest incursion.
    errSum: 0, errTicks: 0, worstBreach: 0, inBandTicks: 0,
    speedGotSum: 0, speedTicks: 0,
    // Kept apart from band error: unreachable-from-ground is a terrain fact, not a steering fault.
    verticalGapTicks: 0, verticalGapSum: 0,
    // The ask is this seat's whole half of the protocol; the gunner serves it (Law 25).
    terrainAskTicks: 0, terrainAskDig: 0, terrainAskPlace: 0, terrainRefusedTicks: 0,
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
  if (rise >= BAND_OUTER) {
    // Still closes at flat zero even with an empty shadow; BOT_WIDTH marks "beneath it".
    if (d > BOT_WIDTH) return { mode: 'approach', setpoint: 0, error: -d, dy };
    // Reported, not acted on: closing the rest needs a climb/pillar/route this seat does not own.
    return { mode: 'vertical_gap', setpoint: null, error: 0, verticalOnly: true, dy };
  }
  const outer = Math.sqrt(BAND_OUTER * BAND_OUTER - dy * dy);
  // Inside BAND_INNER of rise, the inner shadow opens to the bot's own column.
  const inner = rise >= BAND_INNER ? 0 : Math.sqrt(BAND_INNER * BAND_INNER - dy * dy);

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

function terrainWant(bot, self, order, dy, heading) {
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
// over).
function controlMob(board) {
  const swelling = board.swelling || [];
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
  stats.ticks++;

  const self = bot.entity && bot.entity.position;
  if (!self) return;                                        // dead or mid-respawn: nothing to drive

  const board = crewBoard.readCommander();
  const { mob, swelling } = controlMob(board);

  if (!mob) {
    stats.noTarget++;
    release(bot);
    announceMode('no_target', null, null, null);
    writeBoard({ mode: 'no_target', setpoint: null, error: null, keys: null, sprint: false, targetId: null, terrainRequest: null, at: Date.now() });
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

  const order = bandOrder({ horizontal, dy, distance, swelling, standoff });

  // Two accumulators: standoff errs against SWELL_CLEAR, the band against BAND_INNER/OUTER, so one
  // doesn't print as the other (Law 25).
  if (order.mode === 'approach' || order.mode === 'retreat' || order.mode === 'hold' || order.mode === 'vertical_gap') {
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

  // Backing off is whole-field (nine-candidate search); closing is one-mob, since anything else is
  // further by construction. moving is full press or none.
  const moving = order.mode !== 'hold' && order.mode !== 'vertical_gap'
    && order.mode !== 'no_target' && !order.mode.endsWith('_clear');
  let heading = null;
  let stepInfo = null;
  if (moving && order.mode !== 'approach') {
    // Away from the whole press, not just the control mob.
    stepInfo = chooseStep(bot, board.active);
    if (stepInfo && stepInfo.controls) heading = { x: stepInfo.controls.dx, z: stepInfo.controls.dz };
    else if (stepInfo && stepInfo.stood) heading = null;     // standing scored best: it is an answer
  } else if (moving) {
    heading = { x: mobPos.x - self.x, z: mobPos.z - self.z };
  }

  // ── SPRINT ─────────────────────────────────────────────────────────────────
  // Knockback/closing tool: arms on brawler approach and kiter-closing ticks, never at rest (Law 19).
  // SPRINT_RELEASE_B releases one tick clear of the arm's reach so the flag drops before a swing resolves.
  const SPRINT_RELEASE_B = 3.3;
  const shoves = order.mode === 'approach' && combatUtils.combatTactic(mob.name) === 'BRAWLER';
  const closing = order.mode === 'approach' && distance > SPRINT_RELEASE_B;

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
  const wantSprint = press && (shoves || closing) && !guarding;
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
      why: wantSprint ? 'knockback' : (guarding ? 'guarding' : (!shoves ? 'not_brawler' : 'no_press')),
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
  if (jumpTicks > 0) {
    jumpTicks--;
    if (jumpTicks === 0) bot.setControlState('jump', false);
  } else if (stallTicks >= STALL_TICKS) {
    let jumped = false;
    // setControlState asserts only on our own bad literal, never the world's, so the press is unguarded.
    bot.setControlState('jump', true); jumpTicks = JUMP_TICKS; jumped = true;
    stallTicks = 0;
    stallJumps++;
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
  const want = terrainWant(bot, self, order, dy, heading);
  if (want) {
    stats.terrainAskTicks++;
    if (want.kind === 'dig') stats.terrainAskDig++; else stats.terrainAskPlace++;
    // Read, never assumed (Law 1, Law 23).
    const ans = crewBoard.readGunner().terrainStatus;
    if (ans && ans.state === 'refused') stats.terrainRefusedTicks++;
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
    sprint: press,
    // Step search verdict posted, not re-derived.
    stepGain: stepInfo ? stepInfo.gain : null,
    stepBlocked: stepInfo ? stepInfo.blocked : null,
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
  standoff = null;
  // Cleared so a new wave's first line isn't suppressed by the last mode (Invariant B).
  saidMode = null;
  saidOn = null;
  saidSprint = false;
  engaged = true;
}

function disengage(bot) {
  if (!engaged) return;
  engaged = false;
  if (bot) release(bot);
}

// One aggregated line per wave (Law 5 — no per-tick logging in this seat).
function report() {
  if (!stats) return;
  // Silence would read as nothing to report when the feet never got a target (Law 25).
  if (!stats.errTicks) {
    if (stats.ticks) {
      watcher.warn(TAG,
        `🚗 Driver: ${stats.ticks} tick(s) engaged and NOT ONE of them had a target — ` +
        `${stats.noTarget} tick(s) read an empty board. The feet sat out this entire fight. The commander ` +
        `owns which mob is on the board (aggro + sightline); this seat only reads it.`);
    }
    return;
  }
  const meanErr = stats.errSum / stats.errTicks;
  const inBand = (100 * stats.inBandTicks) / stats.errTicks;
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
    `${stats.sprintBlockedByShield ? `, and the shield held sprint down on ${stats.sprintBlockedByShield} tick(s)` : ''}.` +
    `${stats.standoffTicks ? ` Standoff (counted apart from the band): ${stats.standoffTicks} tick(s), mean error ${(stats.standoffErrSum/stats.standoffTicks).toFixed(2)}b.` : ''}`);

  // Separate from the summary: an unwinnable-from-ground fight is a terrain fact, not a steering fault.
  if (stats.terrainAskTicks) {
    watcher.summary(TAG,
      `🚗 asked the gunner for terrain on ${stats.terrainAskTicks} tick(s) — ${stats.terrainAskDig} dig, ` +
      `${stats.terrainAskPlace} pillar; the yaw was spoken for on ${stats.terrainRefusedTicks} of them. ` +
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
  // Bench exports: both pure, both where this seat can be wrong arithmetically.
  bandOrder, chooseStep,
  BAND_INNER, BAND_OUTER, SWELL_CLEAR, WALK_SPEED, SPRINT_SPEED,
};
