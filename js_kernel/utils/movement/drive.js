// module: movement/drive — the continuous walker: hold forward, watch the body cross cells, decide
// when to press jump. This is the layer the lookahead runs through and the only one that reads the
// jump arc.
//
// It senses and presses buttons; the arithmetic lives in calculators/jump_calculator, in one
// integration. Do not re-derive a tick count here — three hand-derived copies of that arc is what
// caused the regression the calculator was written to end.

'use strict';

const Vec3 = require('vec3');
const { performPlace } = require('@utils/movement/place_authority');
const watcher = require('@kernel/watcher');
const { jumpTriggerPlan, descentLandingDistance } = require('@utils/calculators/jump_calculator');
const { sleep } = require('@utils/fragment_utils');
const { performDig } = require('@utils/movement/dig_authority');
const { BRIDGE_PREFS } = require('@utils/movement/movement_config');
const { isNotSafeSurface } = require('@utils/movement/terrain_predicates');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');

const RUN_POLL_MS = 50;
const RUN_ENTER_EPS = 0.28;      // how far past a boundary counts as ENTERED, in blocks
const RUN_STRICT_EPS = 0.4;      // the final cell's centre tolerance — matches the old per-cell test
const RUN_STALL_MS = 400;
const RUN_MIN_PROGRESS = 0.05;

// horizontalSpeed(bot) → blocks per second, from the body's own velocity. Sensed, never assumed: the
// prejump distance is wrong for a bot that is slowed (soul sand, cobweb, water) or hasted, and those are
// exactly the cases where jumping early would put it in a wall (Invariant B).
function horizontalSpeed(bot) {
  const v = bot && bot.entity && bot.entity.velocity;
  if (!v) return 0;
  return Math.hypot(v.x, v.z) * 20;   // b/tick → b/s
}

// riseAhead(p, cells, idx) → { height, faceDistance } | null — WHICH step the body is about to meet and
// how far its near FACE is. The old prejump read the rise from cells[idx+1] but measured the distance to
// cells[idx], triggering a step one cell ahead a full block early; rise and distance must come off the
// SAME cell (jumpTriggerPlan carries the full account).
// ── THE 0.5 IS AN AXIS-ALIGNED ASSUMPTION, AND IT IS UNDER SUSPICION (Architect 2026-08-06) ─────────
// "we should have calculators jump diagonally up at the correct speed but im not sure if that works."
//
// `- 0.5` treats the step as a face met head-on. Met corner-first it is ~0.707 away, and the body's own
// half-width toward a corner is 0.3·√2 = 0.424 rather than 0.3 — so at 45° the reported lead is ~0.33 b
// longer than the true one, which is ~1.2 ticks at sprint against a jump window only 5 ticks wide.
//
// THE PART THAT MATTERS, and the reason a bare `outOfBand` count will never find it: jumpTriggerPlan
// computes `willClear` FROM THIS SAME NUMBER, so it certifies its own bad input. Swept across poll phase
// at 45° and 5.61 b/s, 3 of 20 phases put the leading edge inside the face while the arc is still below
// the step — and the plan reports `clears` for all 20. The remaining 17 sit at 4.0–4.8 ticks against a
// window that opens at 4, i.e. riding the edge, where an axial approach sits mid-window.
//
// NOT CORRECTED HERE, deliberately. The arithmetic above is a prediction; what settles it is whether real
// diagonal presses fail more than real axial ones, which is why the bearing is emitted per press and
// trace_monitor splits the OUTCOME (re-jumps, stuck-at-level) by it — never the verdict, which is blind
// (Law 26: the model does not grade its own paper). The 0.5 is also CORRECT for the axial case, which is
// most presses, so a blind swap to 0.707 would trade a suspected fault for a certain one.
function riseAhead(p, cells, idx) {
  const here = cells[idx];
  const dyHere = here.y - p.y;
  if (dyHere > 0.5) {
    const flat = Math.hypot((here.x + 0.5) - p.x, (here.z + 0.5) - p.z);
    return { height: dyHere, faceDistance: Math.max(0, flat - 0.5), cell: here };
  }
  const next = cells[idx + 1];
  if (!next) return null;
  const dyNext = next.y - p.y;
  if (!(dyNext > 0.5)) return null;
  const flatNext = Math.hypot((next.x + 0.5) - p.x, (next.z + 0.5) - p.z);
  return { height: dyNext, faceDistance: Math.max(0, flatNext - 0.5), cell: next };
}

// approachBearing(p, cell) → 0..45 degrees off the nearest axis. 0 = met square on a face, 45 = met at a
// corner. The one number that tells a diagonal jump from an axial one after the fact.
function approachBearing(p, cell) {
  const ax = Math.abs((cell.x + 0.5) - p.x);
  const az = Math.abs((cell.z + 0.5) - p.z);
  const lo = Math.min(ax, az), hi = Math.max(ax, az);
  if (hi <= 1e-6) return 0;
  return Math.round(Math.atan2(lo, hi) * 180 / Math.PI);
}

// dropAhead(p, cells, idx) → { height, edgeDistance } | null — the mirror of riseAhead, for ground that
// falls away instead of rising. Read for the SPRINT decision only; nothing is pressed for a descent,
// because walking off an edge needs no input.
function dropAhead(p, cells, idx) {
  const here = cells[idx];
  const dyHere = here.y - p.y;
  if (dyHere < -0.5) {
    const flat = Math.hypot((here.x + 0.5) - p.x, (here.z + 0.5) - p.z);
    return { height: -dyHere, edgeDistance: Math.max(0, flat - 0.5) };
  }
  const next = cells[idx + 1];
  if (!next) return null;
  const dyNext = next.y - p.y;
  if (!(dyNext < -0.5)) return null;
  const flatNext = Math.hypot((next.x + 0.5) - p.x, (next.z + 0.5) - p.z);
  return { height: -dyNext, edgeDistance: Math.max(0, flatNext - 0.5) };
}

// One extra tick of travel, so the sprint is released the poll BEFORE the jump rather than in the same
// one. The impulse is applied on the tick the jump is pressed, so a release racing it in the same poll
// is a race this does not need to run.
const SPRINT_RELEASE_MARGIN = 0.3;

// ── WHY THE SPRINT LETS GO OF THE GROUND IT IS ABOUT TO LEAVE (Architect 2026-08-01) ────────────────
// "we would have to expand the jumping calculators to account for sprint jumps or sprinting has to stop
//  when ascending and decending… so sprint on horizontal only then walk to jump? your choice on which is
//  more optimal."
//
// Chosen: sprint on the flat, release for the step, re-press on landing. The reason is not that sprint
// jumps are slow — it is WHICH ARITHMETIC IS BEING TRUSTED. jumpTriggerPlan is already speed-aware: it
// reads the body's SENSED speed every poll (horizontalSpeed below), so any CONSTANT pace, sprint
// included, triggers correctly. What it does not model is Java's sprint-jump FORWARD IMPULSE — roughly
// +0.2 b/tick along the facing on the jump tick, decaying through the arc. That impulse is not a tuning
// detail; it decides the outcome. Integrating it out: a sprinting body covers ~1.83 blocks in the first
// four air ticks against the model's ~1.12, so it meets the step face around tick 3.6 while the arc does
// not clear a full block until tick 4. It clips, by about two centimetres.
//
// Two centimetres is exactly the margin that says DO NOT TRUST THE MODEL: the air-drag and air-control
// constants behind that 1.83 are ones this project has never measured, so the arithmetic cannot say
// which side of the face the body lands on — only that it is at the boundary. Expanding the calculator
// would mean shipping an unverified physics model into the fastest, most stall-prone path, where being
// wrong costs a clipped face plus a 400 ms stall detection plus a re-plan (Law 26 — a model must not
// certify its own output; Law 22 gate 2 — reuse the established system rather than invent one).
//
// The cost of the other choice is small and BOUNDED, which is what settles it: the release fires at
// jumpTriggerPlan's own outer window edge (~2.54 blocks out at sprint), so the most it can ever cost is
// that stretch walked instead of sprinted — 589 ms against 453 ms, i.e. under 136 ms per step climbed,
// and less in practice because the body coasts down rather than dropping to walking pace at once. One or
// two steps in a 15-block arena rush is a fifth of a second. A single clipped face costs more than that
// in stall detection alone (RUN_STALL_MS is 400).
//
// It is measured, not assumed: `outOfBand` counts every jump pressed that the arithmetic says will NOT
// clear. A run that reports zero is the evidence this reasoning was right; a run that reports many is
// the evidence it was not, and the number arrives without anyone having to ask for it (Law 25).

// driveRun(bot, cells, opts) → { arrived, crossed, reason, prejumps, outOfBand, sprintDrops }.
//
// Walks a run of ALREADY-WALKABLE feet cells without releasing `forward` between them. It does not
// carve, place, or bridge — a cell that turns out to be blocked ends the run and hands back to the
// caller, whose edge primitives own that work (Law 0: this verb is "walk this run", nothing else).
//
// opts.strictFinal (default true) — the last cell must be stood on properly, centre and grounded.
// opts.keepMoving (default false) — leave `forward` pressed on return, for a caller chaining runs.
// opts.prejump (default FALSE) — off by default on purpose (Law 13): with it off and a single cell,
//   this function is the old per-cell step exactly, so adopting it changes nothing until a caller asks
//   for the new behaviour. That is what makes the live A/B one argument instead of one branch.
// opts.sprint (default FALSE) — hand this function the SPRINT control for the run. See the header block
//   above for why it cannot stay with the caller.
// opts.stallMs (default RUN_STALL_MS) — how long zero progress is tolerated before the run gives up.
//   Pass `null` to WAIVE the stall verdict entirely, for the one caller whose step legitimately makes no
//   ground while it works.
//
// ── WHY A WAIVER EXISTS AT ALL, AND WHY IT IS NOT A DEFAULT (Architect 2026-09-11) ─────────────────
// The stall guard assumes zero progress means something is wrong. That holds for every edge type but
// one: a DOOR. A shut door has a solid bounding box, so a body walking into it makes exactly no ground
// until the survival reflex opens it — zero progress is that step's normal working state, not its
// failure. Before the walkers were consolidated (c7ee49a, 2026-08-01) the door step ran its own loop
// with no progress check and simply pushed for its full 3,000 ms, which is the budget the reflex's
// server round-trip needs; the consolidation silently cut that to 400 ms and the door has been snagging
// ever since (bugsquashing §20.1). The waiver restores the old patience for that ONE caller without
// giving it to the rest, because everywhere else the guard is what stops a wedged body burning its
// whole timeout. The run is still bounded — `timeoutMs` always applies.
async function driveRun(bot, cells, opts = {}) {
  const r2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
  const nothing = (reason, crossed) => ({ arrived: false, crossed, reason, prejumps: 0, outOfBand: 0, sprintDrops: 0, ms: 0, dist: 0, path: 0, spd: 0, peak: 0, sprintMs: 0, stuckMs: 0, jumps: [] });
  if (!Array.isArray(cells) || !cells.length) return nothing('empty_run', 0);
  const strictFinal = opts.strictFinal !== false;
  const timeoutMs = opts.timeoutMs || Math.max(1500, cells.length * 900);
  // `undefined` means "not asked for" and takes the default; `null` is the explicit waiver. They are
  // distinguished rather than collapsed, so a caller cannot waive the guard by forgetting the option.
  const stallMs = opts.stallMs === undefined ? RUN_STALL_MS : opts.stallMs;
  const t0 = Date.now();
  let idx = 0, prejumps = 0, jumpHeld = false, outOfBand = 0, sprintDrops = 0;
  // Starts null rather than false so the first pass always writes the control, instead of assuming the
  // body arrived in whatever state this function would have left it in (Invariant B).
  let sprintHeld = null;
  let lastProgressPos = bot.entity.position.clone();
  let lastProgressAt = Date.now();

  // ── LOCOMOTION TELEMETRY ────────────────────────────────────────────────────────────────────────────
  // Emitted, never acted on: this function's decisions are unchanged by anything below. It is here rather
  // than in the caller because only this layer polls the body mid-leg — a caller sampling before and after
  // sees a chord and reads a curve as a slower straight line (that error is exactly what made the first
  // CHASE speed verdict unsound, 2026-08-05).
  //
  // What it does NOT compute: "jumped again without gaining height". A combat leg is 400 ms and a jump arc
  // is ~600, so the takeoff and the landing fall in DIFFERENT calls — no single leg can see the pattern.
  // The per-leg facts (y at press, y at end, grounded, presses) go to the journal and the monitor
  // differences consecutive rows, the same way it already reconstructs chase speed (Law 16: one reducer,
  // extended — not a second one built beside it).
  const p0 = bot.entity.position.clone();
  let lastSample = p0.clone();
  let pathLen = 0, peak = 0, sprintMs = 0, sprintSince = 0, stuckMs = 0;
  const jumps = [];

  const tel = (reason) => {
    const ms = Date.now() - t0;
    const pNow = (bot.entity && bot.entity.position) || lastSample;
    if (sprintSince) sprintMs += Date.now() - sprintSince;
    return {
      reason, ms,
      dist: r2(Math.hypot(pNow.x - p0.x, pNow.z - p0.z)),
      path: r2(pathLen),
      spd: ms > 0 ? r2(pathLen / (ms / 1000)) : 0,
      peak: r2(peak),
      sprintMs, stuckMs,
      y0: r2(p0.y), y1: r2(pNow.y),
      ground: !!(bot.entity && bot.entity.onGround),
      jumps,
    };
  };
  const out = (reason) => ({ arrived: false, crossed: idx, reason, prejumps, outOfBand, sprintDrops, ...tel(reason) });

  bot.setControlState('forward', true);

  // withCleanup, not a guard: the releases below must run on every exit — arrival, timeout, stall, or a
  // throw out of the leg — and nothing here is caught. An early `out(...)` verdict returns through it and
  // is handed back below; falling out of the loop means the leg arrived.
  const early = await withCleanup('drive', 'run leg', async () => {
    while (idx < cells.length) {
      if (Date.now() - t0 > timeoutMs) return out('timeout');
      // ── THE COMBAT CHECKPOINT (Architect 2026-08-08) ────────────────────────────────────────────────
      // The leg is the other unbounded span, and it is the one the callers cannot cover: navigator polls
      // at the top of a STEP and a run crosses several cells inside one. Self-paced at 500 ms and
      // self-bypassing while battle_stations holds the body, so combat's own rush and retreat legs — which
      // come through this exact function — do not re-enter the gate that raised them.
      //
      // ORDERED AFTER THE TIMEOUT AND BEFORE THE POSITION READ so the leg's own bounds still win: a body
      // whose time is up stops being a walk before it is offered a fight.
      //
      // `before` RELEASES EVERY CONTROL THIS FUNCTION HOLDS, and the promise semantics are why. On a real
      // threat battleStations abandons this caller (Law 15) and never resolves — so the `finally` at the
      // bottom of this function NEVER RUNS, and every key it would have released stays down for the whole
      // fight. That finally releases three things, not one: `jump`, `forward` and `sprint`. `jumpHeld` and
      // `sprintHeld` persist ACROSS iterations, so a body that pressed jump on the previous cell arrives
      // at this checkpoint still holding it — which is exactly the case a `forward`-only release missed
      // (found 2026-08-08 answering the Architect's "how wont it cause the 2 signals at a time error": it
      // is not a signal fault, it is a Law 8 one — a lifecycle's controls outliving the lifecycle).
      //
      // THIS IS THE ONE CALL SITE THAT IS NOT A NATURALLY SAFE POINT. A dig checkpoint is safe by
      // construction (nothing is in flight — see performDig); a walking body is mid-verb with keys down,
      // so the point is MADE safe here rather than found. Anything this function starts holding later must
      // be released here too, or the fight inherits it.
      //
      // The release happens on the polling pass only (twice a second), and the loop re-presses below and
      // re-decides jump/sprint from the flags on the same iteration — so a leg that meets nothing loses a
      // tick of press and keeps its ramp.
      await require('@api/battle_stations').combatCheckpoint(bot, 'drive', {
        before: () => {
          // Unguarded: setControlState asserts only on a bad control name or a non-boolean state, both of
          // which are our own defect (Law 13).
          if (jumpHeld) { bot.setControlState('jump', false); jumpHeld = false; }
          bot.setControlState('forward', false);
          if (opts.sprint && sprintHeld) {
            bot.setControlState('sprint', false);
            // Close the sprint accounting rather than orphaning `sprintSince`: the loop re-presses on
            // this same pass and would overwrite it, silently dropping the interval it had accrued.
            if (sprintSince) { sprintMs += Date.now() - sprintSince; sprintSince = 0; }
            sprintHeld = false;
          }
        },
      });
      // setControlState asserts on an invalid control name or a non-boolean state and can fail no other
      // way, so its only throw is a coding violation on our side — the one class a guard must never
      // swallow (Law 13). Every argument at the control sites in this file is a literal and a boolean.
      bot.setControlState('forward', true);
      const p = bot.entity && bot.entity.position;
      if (!p) return out('no_body');
      pathLen += Math.hypot(p.x - lastSample.x, p.z - lastSample.z);
      lastSample = p.clone();
      const target = cells[idx];
      const isLast = idx === cells.length - 1;
      const cx = target.x + 0.5, cz = target.z + 0.5;
      const dx = cx - p.x, dz = cz - p.z, dy = target.y - p.y;
      const flat = Math.hypot(dx, dz);

      // Steering every pass rather than once per cell: a run bends between cells, and a body aimed at
      // the cell it left drifts wide of the next boundary at speed.
      await guardExternal('drive', 'look toward target', () => bot.look(Math.atan2(-dx, -dz), 0, true));

      // ── the arrival predicate, and the whole point of this function ──
      const entered = p.floored().equals(target)
        || (flat <= 0.5 + RUN_ENTER_EPS && Math.abs(dy) < 1.2);
      // The strict test is the OLD per-cell one verbatim, floored-equals included: arrival requires
      // ground contact, because a body passing through the target Y mid-arc reports success and then
      // falls back to a lower cell.
      const settled = bot.entity.onGround
        && (p.floored().equals(target) || (flat <= RUN_STRICT_EPS && Math.abs(dy) < 0.6));
      if (isLast ? (strictFinal ? settled : entered) : entered) {
        idx++;
        lastProgressAt = Date.now();
        continue;
      }

      // ── the prejump ──
      // Aimed at the NEXT cell's rise when there is one, otherwise this cell's. A run reads one cell
      // further than it is walking, which is the lookahead the whole design turns on.
      // NO BRAKE HERE, and the Architect asked for one ("we could even tap forward to slow down if the
      // jump would hit the face of the block"). It is not omitted, it is impossible: the trigger fires at
      // lead ≤ v×6 and the window opens at lead ≥ v×4, so every position where the body is too fast to
      // clear is a position where the jump has ALREADY been pressed. A branch reading "too fast and not
      // yet jumping" can never be true, and shipping it would be a dial that cannot fire (Law 16). The
      // one case a brake would serve — a step discovered after the body is already inside the window —
      // is a lookahead failure, and the fix for it is to see the step earlier, not to slow down at it.
      const speed = horizontalSpeed(bot);
      if (speed > peak) peak = speed;
      const rise = riseAhead(p, cells, idx);
      // Only consulted when there is no rise: a cell that both climbs and drops cannot exist, and asking
      // for the drop first would let a step-down two cells out veto the sprint through a step-up.
      const drop = rise ? null : dropAhead(p, cells, idx);
      let wantSprint = !!opts.sprint;

      if (rise) {
        const plan = jumpTriggerPlan(rise.faceDistance, speed, rise.height);
        let shouldJump;
        if (opts.prejump) {
          shouldJump = plan.jumpNow;
          if (shouldJump && !jumpHeld) {
            prejumps++;
            // The verdict the trigger already computes and this function used to discard. A press the
            // arithmetic says will clip the face or land short is the one thing that would prove the
            // sprint ruling above wrong, so it is counted rather than inferred from a stall.
            if (!plan.willClear) outOfBand++;
            // The whole press, recorded — the step, the sensed speed, the window it was aimed at, the
            // verdict, and the bearing it was met on. A tally of failures cannot say WHICH input was
            // wrong; these five can (Law 25: the number arrives without anyone having to ask).
            if (jumps.length < 16) jumps.push({
              h: r2(rise.height), face: r2(rise.faceDistance), spd: r2(speed),
              ticks: r2(plan.ticksToFace), min: r2(plan.min), max: r2(plan.max),
              will: !!plan.willClear, why: plan.reason,
              deg: approachBearing(p, rise.cell), y: r2(p.y),
            });
          }
        } else {
          shouldJump = dy > 0.5;    // the A/B baseline: press jump on arrival, exactly as before
        }
        // Inside the clearance window's outer edge — the sprint impulse must be gone before the press.
        // plan.max is absent when no jump clears the step at all (`step_too_tall`), and there is nothing
        // to release for in that case: the run is about to stall on a wall, not take a step.
        if (typeof plan.max === 'number' && rise.faceDistance <= plan.max + SPRINT_RELEASE_MARGIN) wantSprint = false;
        if (shouldJump !== jumpHeld) {
          bot.setControlState('jump', shouldJump);
          jumpHeld = shouldJump;
        }
      } else {
        if (jumpHeld) {
          bot.setControlState('jump', false);
          jumpHeld = false;
        }
        // A descent presses nothing, but it is still a sprint decision: a body that runs off a one-block
        // edge at 5.61 b/s lands 1.68 blocks out against 1.30 at walking pace, and the extra third of a
        // block is past the last cell this run validated. Landing on ground nothing checked is the
        // predictable self-injury Law 17 forbids, so the sprint comes off while the edge is inside the
        // distance the body would fly.
        if (drop) {
          const land = descentLandingDistance(speed, drop.height);
          if (land.blocks != null && drop.edgeDistance <= land.blocks) wantSprint = false;
        }
      }

      if (opts.sprint && wantSprint !== sprintHeld) {
        bot.setControlState('sprint', wantSprint);
        if (sprintHeld === true && !wantSprint) sprintDrops++;
        // Clocked on the CONTROL, not on the speed: what is being asked is "was sprint commanded", so a
        // body that is commanded to sprint and does not accelerate reads as held-but-slow, which is the
        // finding. Deriving it from velocity would hide exactly that case.
        if (wantSprint) sprintSince = Date.now();
        else if (sprintSince) { sprintMs += Date.now() - sprintSince; sprintSince = 0; }
        sprintHeld = wantSprint;
      }

      // Stall: no carving here, just an honest stop. The caller re-plans, which is cheaper and correct
      // (Law 12 — a fresh dispatch from current world state beats a rescue attempt mid-run).
      if (p.distanceTo(lastProgressPos) >= RUN_MIN_PROGRESS) {
        lastProgressPos = p.clone();
        lastProgressAt = Date.now();
      } else {
        // Reported even when it never reaches the threshold. RUN_STALL_MS (400) cannot fire inside a
        // combat leg because the leg's own clock is also 400 and wins — so the stall verdict is absent
        // exactly where the Architect reported the symptom. stuckMs carries the evidence out regardless
        // of which clock expires first, and the ARM owns the escalation (see rush.js).
        stuckMs = Date.now() - lastProgressAt;
        // stuckMs is still MEASURED under a waiver — the telemetry is the evidence either way, and a
        // door that takes 900 ms to open should be readable afterwards. Only the verdict is waived.
        if (stallMs != null && stuckMs > stallMs) return out('stalled');
      }
      await sleep(RUN_POLL_MS);
    }
  }, () => {
    if (jumpHeld) bot.setControlState('jump', false);
    // keepMoving governs the sprint exactly as it governs `forward`, and for the same reason: a caller
    // chaining legs wants the acceleration ramp kept, and a caller that is done wants the body stopped.
    // Releasing sprint unconditionally here would spend that ramp on every pass of an engagement loop.
    if (!opts.keepMoving) {
      bot.setControlState('forward', false);
      if (opts.sprint) bot.setControlState('sprint', false);
    }
  });
  if (early) return early;
  return { arrived: true, crossed: cells.length, reason: 'arrived', prejumps, outOfBand, sprintDrops, ...tel('arrived') };
}

// planRunSegments(path, opts) → [{ kind, edges }]. PURE — no bot, no world.
//
// Splits a typed-edge path into the runs that may be walked continuously and the edges that may not.
// This is the lookahead, and it is a separate pure function precisely so the DECISION (what fuses) can
// be tested headless while the CROSSING (whether the body makes it) is left to the arena.
//
// Only `walk` fuses today, plus step-up/step-down that need no carving. Everything that alters the
// world — bridge, pillar, dig — is its own segment and runs exactly as it does now: those primitives
// place and dig BEFORE stepping, so a body still moving through them would be building underneath
// itself. `maxRun` is the lookahead depth, and maxRun 1 reproduces the current behaviour edge for edge.
const RUNNABLE_EDGES = new Set(['walk', 'step', 'stair_up', 'stair_down']);

function planRunSegments(path, opts = {}) {
  const maxRun = Math.max(1, opts.maxRun || 1);
  const segments = [];
  let run = null;
  for (const edge of Array.isArray(path) ? path : []) {
    const kind = edge && (edge.kind || edge.type || 'walk');
    if (RUNNABLE_EDGES.has(kind) && run && run.edges.length < maxRun) { run.edges.push(edge); continue; }
    if (RUNNABLE_EDGES.has(kind)) { run = { kind: 'run', edges: [edge] }; segments.push(run); continue; }
    run = null;
    segments.push({ kind, edges: [edge] });
  }
  return segments;
}

async function driveFlatToCell(bot, next, opts = {}) {
  const TIMEOUT_MS = opts.timeoutMs || 1400;
  const STALL_WINDOW_MS = opts.stallWindowMs || 300;
  const MIN_PROGRESS = opts.minProgress || 0.05;
  const REACH_EPS = opts.reachEps || 0.35;
  const startTime = Date.now();
  let lastProgressPos = bot.entity.position.clone();
  let lastProgressTime = Date.now();
  await guardExternal('drive', 'lookAt next cell', () => bot.lookAt(next.offset(0.5, 0.2, 0.5), true));
  bot.setControlState('forward', true);
  bot.setControlState('sneak', false);
  let arrived = false;
  await withCleanup('drive', 'step to next cell', async () => {
    while (Date.now() - startTime < TIMEOUT_MS) {
      const pos = bot.entity.position;
      const dx = (next.x + 0.5) - pos.x;
      const dz = (next.z + 0.5) - pos.z;
      const dy = next.y - pos.y;
      const distSq = dx * dx + dz * dz + dy * dy;
      if (Math.sqrt(distSq) <= REACH_EPS || pos.floored().equals(next)) { arrived = true; break; }
      await guardExternal('drive', 'look toward next cell', () => bot.look(Math.atan2(-dx, -dz), 0, true));
      const prog = pos.distanceTo(lastProgressPos);
      if (prog >= MIN_PROGRESS) { lastProgressPos = pos.clone(); lastProgressTime = Date.now(); }
      else if (Date.now() - lastProgressTime > STALL_WINDOW_MS) {
        const footBlock = bot.blockAt(next);
        if (footBlock && footBlock.name !== 'air') {
          await performDig(bot, footBlock.position, footBlock, 'drive');
          await sleep(80);
        }
        const headBlock = bot.blockAt(next.offset(0, 1, 0));
        if (headBlock && headBlock.name !== 'air') {
          await performDig(bot, headBlock.position, headBlock, 'drive');
          await sleep(80);
        }
        lastProgressTime = Date.now();
      }
      await sleep(50);
    }
  }, () => { bot.setControlState('forward', false); });
  return arrived;
}

async function stepHorizontal(bot, dx, dz, optFloorBlock) {
  const TIMEOUT_MS = 1500;
  const POLL_MS = 50;

  const feet = bot.entity.position.floored();
  const target = new Vec3(feet.x + dx, feet.y, feet.z + dz);

  // Clear foot + head obstacles at the target cell.
  for (const offY of [0, 1]) {
    const blk = bot.blockAt(target.offset(0, offY, 0));
    if (blk && blk.boundingBox !== 'empty') {
      // performDig REPORTS rather than throws (its contract: false = cell not cleared), so the guard that
      // stood here could only fire on a defect — and it hid the real failure, because the return value
      // was never read. A refused dig now ends the step, which is what the guard was written to do and
      // never did (Law 25).
      if (!await performDig(bot, blk.position, blk, 'drive')) return false;
      await sleep(100);
    }
  }

  // Gap ahead: lay a floor block (caller's preferred item first, then bridge prefs).
  const floorPos = new Vec3(target.x, target.y - 1, target.z);
  const floorBlock = bot.blockAt(floorPos);
  if (!floorBlock || floorBlock.boundingBox === 'empty' || isNotSafeSurface(floorBlock)) {
    const items = bot.inventory?.items?.() || [];
    let bridgeItem = null;
    if (optFloorBlock) {
      bridgeItem = items.find(i => i.name === optFloorBlock && i.count > 0) || null;
    }
    if (!bridgeItem) {
      for (const name of BRIDGE_PREFS) {
        bridgeItem = items.find(i => i.name === name && i.count > 0);
        if (bridgeItem) break;
      }
    }

    if (!bridgeItem) {
      watcher.warn('drive', `stepHorizontal fail: no floor block for gap at (${floorPos.x},${floorPos.y},${floorPos.z})`);
      return false;
    }

    // Sneak-place against the current support so the block lands in the gap, not underfoot.
    const curSupport = bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z));
    if (!curSupport || curSupport.boundingBox === 'empty') {
      watcher.warn('drive', `stepHorizontal fail: no current support to place floor against`);
      return false;
    }
    // The one place route (Law 16) owns equip, the spawn-protection gate, the combat checkpoint, the
    // sneak and its guaranteed release, the aim and the click. sneak: true rather than 'auto' — the
    // crouch holds the body on the block it bridges FROM, which is a fact about the move rather than
    // about the anchor.
    //
    // A refused bridge is the one placement where a phantom is dangerous rather than merely wasteful:
    // the body would step onto a floor the client drew and the server never laid, and fall.
    const placed = await performPlace(bot, new Vec3(target.x, feet.y - 1, target.z), curSupport, new Vec3(dx, 0, dz), bridgeItem.name, 'drive', { sneak: true, settleMs: 100 });
    if (!placed.ok) {
      watcher.warn('drive', `bridge floor not laid toward (${target.x},${target.z}) — ${placed.reason}`);
      return false;
    }
  }

  // Walk into the target cell.
  await guardExternal('drive', 'lookAt step target', () => bot.lookAt(target.offset(0.5, 0.2, 0.5), true));
  bot.setControlState('forward', true);
  const startTime = Date.now();
  let arrived = false;
  await withCleanup('drive', 'step horizontal', async () => {
    while (Date.now() - startTime < TIMEOUT_MS) {
      const pos = bot.entity.position;
      if (pos.floored().x === target.x && pos.floored().z === target.z && bot.entity.onGround) {
        arrived = true;
        break;
      }
      await guardExternal('drive', 'look toward step target', () => bot.look(Math.atan2(-(target.x + 0.5 - pos.x), -(target.z + 0.5 - pos.z)), 0, true));
      await sleep(POLL_MS);
    }
  }, () => { bot.setControlState('forward', false); });

  if (!arrived) watcher.warn('drive', `stepHorizontal ⛔ timeout (${feet.x},${feet.z})->(${target.x},${target.z})`);
  return arrived;
}

module.exports = {
  horizontalSpeed,
  riseAhead,
  dropAhead,
  driveRun,
  SPRINT_RELEASE_MARGIN,
  planRunSegments,
  driveFlatToCell,
  stepHorizontal,
};
