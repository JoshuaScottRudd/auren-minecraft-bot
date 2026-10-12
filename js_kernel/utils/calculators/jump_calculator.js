/*
============================================================
jump_calculator.js (Jump and Fall Arithmetic)
============================================================
INDEX
1. The Arc ........................ jumpArc(), fallArc()
2. Clearance ...................... jumpClearanceTicks()
3. Trigger ........................ jumpTriggerPlan(), jumpSpeedBand()
4. Descent ........................ descentLandingDistance()
5. Module Exports

Pure and stateless — no bot, no world, no logging. Holds vertical motion arithmetic, kept separate from
the combat arithmetic in calculator_utils.

THE ONE INTEGRATION OF JAVA'S JUMP: the single source of this arc's tick counts (Law 16). Anything
wanting a jump tick count reads it off jumpArc() and does not write its own.
============================================================
*/

'use strict';

// ============================================================
// 1. The Arc
// ============================================================

const JUMP_INITIAL_VELOCITY = 0.42;    // LivingEntity jump impulse, blocks/tick, no Jump Boost
const PLAYER_GRAVITY = 0.08;
const PLAYER_AIR_DRAG = 0.98;
const BODY_HALF_WIDTH = 0.3;           // hitbox is 0.6 wide; the LEADING edge is what must clear
// A step is "cleared" only with this much daylight, so a position read that is a hair optimistic cannot
// certify a jump that scrapes the face.
const JUMP_CLEARANCE_MARGIN = 0.02;
// A body cannot stand closer to a face than its half-width, so a leading edge at zero IS contact. This
// keeps float noise from reading as "not there yet" and deadlocking a standing jump.
const JUMP_FACE_EPS = 0.05;

// jumpArc(maxTicks) → [0, riseAfterTick1, …]. Order is Java's: position takes the CURRENT velocity, then
// gravity and drag apply for the next tick. Reversing those two shifts every number by a tick.
function jumpArc(maxTicks = 16) {
  const arc = [0];
  let vy = JUMP_INITIAL_VELOCITY, y = 0;
  for (let t = 1; t <= maxTicks; t++) {
    y += vy;
    arc.push(y);
    vy = (vy - PLAYER_GRAVITY) * PLAYER_AIR_DRAG;
  }
  return arc;
}

// fallArc(maxTicks) → positive depths for a body that walks off an edge. Same integrator, zero impulse —
// a descent is not a separate model.
function fallArc(maxTicks = 16) {
  const arc = [0];
  let vy = 0, y = 0;
  for (let t = 1; t <= maxTicks; t++) {
    y += vy;
    arc.push(-y);
    vy = (vy - PLAYER_GRAVITY) * PLAYER_AIR_DRAG;
  }
  return arc;
}

const JUMP_ARC = jumpArc(16);
const JUMP_APEX_TICK = JUMP_ARC.reduce((best, v, i) => (v > JUMP_ARC[best] ? i : best), 0);   // 6

// ============================================================
// 2. Clearance
// ============================================================

// jumpClearanceTicks(stepHeight) → { first, last, apex, ticks } | null. The ticks during which the body
// is above the step. Everything below is this window read through a speed. null = no jump clears it.
function jumpClearanceTicks(stepHeight, opts = {}) {
  const need = (typeof stepHeight === 'number' && Number.isFinite(stepHeight) ? stepHeight : 1)
    + (opts.margin != null ? opts.margin : JUMP_CLEARANCE_MARGIN);
  let first = -1, last = -1;
  for (let t = 1; t < JUMP_ARC.length; t++) {
    if (JUMP_ARC[t] < need) continue;
    if (first < 0) first = t;
    last = t;
  }
  if (first < 0) return null;
  return { first, last, apex: JUMP_APEX_TICK, ticks: last - first + 1 };
}

// ============================================================
// 3. Trigger
// ============================================================

// jumpSpeedBand(faceDistance, stepHeight) → { minBps, maxBps } | null — the speeds at which a jump
// pressed RIGHT NOW still clears. Braking raises the tick count to the face, walking the body back into
// the window from the too-fast side; this is what says whether braking is ever needed at all.
function jumpSpeedBand(faceDistance, stepHeight, opts = {}) {
  const window = jumpClearanceTicks(stepHeight, opts);
  if (!window) return null;
  const lead = faceDistance - BODY_HALF_WIDTH;
  if (!(lead > 0)) return { minBps: 0, maxBps: Infinity };   // at the face: no speed clears or fails it
  return { minBps: 20 * lead / window.last, maxBps: 20 * lead / window.first };
}

// jumpTriggerPlan(faceDistance, speedBps, stepHeight) → the whole decision for one poll.
//   faceDistance — body POSITION to the vertical plane of the step's near face. Not to the cell centre.
//   Rise and distance are read off the SAME cell, or the two disagree and the jump fires at the wrong point.
//
// Apex over the face is the robust choice: it sits at tick 6 of a 4..8 window, and poll granularity and
// control latency both eat the LATE side, which has the slack.
function jumpTriggerPlan(faceDistance, speedBps, stepHeight, opts = {}) {
  const window = jumpClearanceTicks(stepHeight, opts);
  if (!window) return { jumpNow: false, willClear: false, reason: 'step_too_tall' };
  if (typeof faceDistance !== 'number' || !Number.isFinite(faceDistance)) {
    return { jumpNow: false, willClear: false, reason: 'no_distance' };
  }
  const bps = typeof speedBps === 'number' && Number.isFinite(speedBps) && speedBps > 0 ? speedBps : 0;
  const vTick = bps / 20;
  const lead = faceDistance - BODY_HALF_WIDTH;
  const band = jumpSpeedBand(faceDistance, stepHeight, opts);

  const ideal = BODY_HALF_WIDTH + vTick * window.apex;
  const min = BODY_HALF_WIDTH + vTick * window.first;
  const max = BODY_HALF_WIDTH + vTick * window.last;
  const ticksToFace = lead > 0 ? (vTick > 0 ? lead / vTick : Infinity) : 0;

  // Pressed against the step, jumping is still correct, though slower; this reports honestly (Law 25).
  if (!(lead > JUMP_FACE_EPS)) {
    return { jumpNow: true, willClear: true, ticksToFace: 0, ideal, min, max, band, tooFast: false, tooSlow: false, reason: 'at_face' };
  }
  const tooFast = ticksToFace < window.first;
  const tooSlow = ticksToFace > window.last;
  const jumpNow = lead <= Math.max(vTick * window.apex, JUMP_FACE_EPS);
  return {
    jumpNow,
    willClear: jumpNow && !tooFast && !tooSlow,
    ticksToFace, ideal, min, max, band, tooFast, tooSlow,
    reason: !jumpNow ? 'too_far' : (tooFast ? 'would_clip_face' : (tooSlow ? 'would_land_short' : 'clears')),
  };
}

// ============================================================
// 4. Descent
// ============================================================

// descentLandingDistance(speedBps, dropHeight) → { ticks, blocks } past the edge. Nothing is pressed, so
// the body always clears what it stepped off at any normal walking pace; this gives a descent lookahead
// an exact number.
function descentLandingDistance(speedBps, dropHeight = 1) {
  const arc = fallArc(16);
  let ticks = -1;
  for (let t = 1; t < arc.length; t++) { if (arc[t] >= dropHeight) { ticks = t; break; } }
  if (ticks < 0) return { ticks: null, blocks: null };
  const bps = typeof speedBps === 'number' && Number.isFinite(speedBps) && speedBps > 0 ? speedBps : 0;
  return { ticks, blocks: (bps / 20) * ticks };
}

// ============================================================
// 5. Module Exports
// ============================================================
module.exports = {
  jumpArc,
  fallArc,
  jumpClearanceTicks,
  jumpSpeedBand,
  jumpTriggerPlan,
  descentLandingDistance,
  JUMP_APEX_TICK,
  BODY_HALF_WIDTH,
  JUMP_CLEARANCE_MARGIN,
};
