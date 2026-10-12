// module: movement/drive — the continuous walker: holds forward, watches the body cross cells, and
// decides when to press jump. The layer the lookahead runs through and the only one that reads the
// jump arc; senses and presses buttons only, the arc arithmetic lives in calculators/jump_calculator
// (Law 16).

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
const RUN_STRICT_EPS = 0.4;      // the final cell's centre tolerance
const RUN_STALL_MS = 400;
const RUN_MIN_PROGRESS = 0.05;

// horizontalSpeed(bot) → blocks per second, read from the body's own sensed velocity, not assumed, so
// a slowed or hasted bot still gets a correct prejump distance (Invariant B).
function horizontalSpeed(bot) {
  const v = bot && bot.entity && bot.entity.velocity;
  if (!v) return 0;
  return Math.hypot(v.x, v.z) * 20;   // b/tick → b/s
}

// riseAhead(p, cells, idx) → { height, faceDistance } | null — the step the body is about to meet and
// how far its near face is, read off the SAME cell (jumpTriggerPlan carries the full account). The
// `- 0.5` assumes a face met head-on; a diagonal approach reports a longer lead than true, and
// jumpTriggerPlan certifies `willClear` from this same number — so the bearing is emitted per press,
// letting trace_monitor split outcomes by approach angle instead of trusting the verdict blind (Law 26).
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
// falls away instead of rising. Read for the sprint decision only; nothing is pressed for a descent.
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

// One extra tick of travel: releases sprint the poll before the jump, ahead of the forward impulse
// that lands on the jump tick.
const SPRINT_RELEASE_MARGIN = 0.3;

// ── SPRINT AND THE JUMP STEP ────────────────────────────────────────────────
// Sprint runs on the flat, releases before a step, and re-presses on landing — jumpTriggerPlan reads
// sensed speed but not Java's sprint-jump forward impulse, so it cannot certify a sprinting jump
// clears (Law 26; Law 22 gate 2). `outOfBand` counts presses the arithmetic predicts will not clear.

// driveRun(bot, cells, opts) → { arrived, crossed, reason, prejumps, outOfBand, sprintDrops }.
//
// Walks a run of ALREADY-WALKABLE feet cells without releasing `forward` between them. It does not
// carve, place, or bridge — a blocked cell ends the run and hands back to the caller, whose edge
// primitives own that work (Law 0: this verb is "walk this run", nothing else).
//
// opts.strictFinal (default true) — the last cell must be stood on properly, centre and grounded.
// opts.keepMoving (default false) — leave `forward` pressed on return, for a caller chaining runs.
// opts.prejump (default false) — gates the lookahead jump timing behind an explicit opt-in (Law 13).
// opts.sprint (default false) — this function owns the sprint control for the run (see above).
// opts.stallMs (default RUN_STALL_MS) — zero-progress tolerance before the run gives up; `null` waives
//   the stall verdict, for a caller whose step legitimately makes no ground while it works — the guard
//   otherwise assumes zero progress is wrong, which is false for a shut door until the survival reflex
//   opens it. `timeoutMs` still bounds the run regardless.
async function driveRun(bot, cells, opts = {}) {
  const r2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
  const nothing = (reason, crossed) => ({ arrived: false, crossed, reason, prejumps: 0, outOfBand: 0, sprintDrops: 0, ms: 0, dist: 0, path: 0, spd: 0, peak: 0, sprintMs: 0, stuckMs: 0, jumps: [] });
  if (!Array.isArray(cells) || !cells.length) return nothing('empty_run', 0);
  const strictFinal = opts.strictFinal !== false;
  const timeoutMs = opts.timeoutMs || Math.max(1500, cells.length * 900);
  // `undefined` takes the default; `null` is the explicit waiver — distinguished so omission cannot
  // accidentally waive the guard.
  const stallMs = opts.stallMs === undefined ? RUN_STALL_MS : opts.stallMs;
  const t0 = Date.now();
  let idx = 0, prejumps = 0, jumpHeld = false, outOfBand = 0, sprintDrops = 0;
  // Starts null so the first pass always writes the control instead of assuming prior state (Invariant B).
  let sprintHeld = null;
  let lastProgressPos = bot.entity.position.clone();
  let lastProgressAt = Date.now();

  // ── LOCOMOTION TELEMETRY ──────────────────────────────────────────────────────
  // Emitted, never acted on. Sampled here, not by the caller, since only this layer polls the body
  // mid-leg; per-leg facts go to the journal and the monitor differences consecutive rows (Law 16).
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
  // throw out of the leg. An early `out(...)` verdict returns through it and is handed back below;
  // falling out of the loop means the leg arrived.
  const early = await withCleanup('drive', 'run leg', async () => {
    while (idx < cells.length) {
      if (Date.now() - t0 > timeoutMs) return out('timeout');
      // ── THE COMBAT CHECKPOINT ────────────────────────────────────────────────
      // The one unbounded span callers cannot cover from outside, since a run crosses several cells
      // inside one caller poll; ordered after the timeout so a body out of time stops walking before it
      // is offered a fight. `before` releases every control this function holds — jump, forward,
      // sprint — because a real threat lets battleStations abandon this caller (Law 15) without
      // resolving, so this function's own `finally` never runs. Unlike a dig checkpoint (safe by
      // construction), this site is made safe here instead of found; anything held later must be
      // released here too.
      await require('@api/battle_stations').combatCheckpoint(bot, 'drive', {
        before: () => {
          // Unguarded: setControlState asserts only on a bad control name or a non-boolean state, both of
          // which are our own defect (Law 13).
          if (jumpHeld) { bot.setControlState('jump', false); jumpHeld = false; }
          bot.setControlState('forward', false);
          if (opts.sprint && sprintHeld) {
            bot.setControlState('sprint', false);
            // Closes the sprint interval before the re-press below can overwrite `sprintSince`.
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
      // The floor ahead is re-read every pass: the run was checked when it started, and a peer digging
      // the ground can take a floor while the body is on its way to it. A run whose next floor has gone
      // stops here, and the caller replans from where the body stands.
      const floorAhead = bot.blockAt(target.offset(0, -1, 0));
      if (!floorAhead || floorAhead.boundingBox === 'empty') return out('floor_gone');
      const cx = target.x + 0.5, cz = target.z + 0.5;
      const dx = cx - p.x, dz = cz - p.z, dy = target.y - p.y;
      const flat = Math.hypot(dx, dz);

      // Steering every pass instead of once per cell: a run bends between cells, and a body aimed at
      // the cell it left drifts wide of the next boundary at speed.
      await guardExternal('drive', 'look toward target', () => bot.look(Math.atan2(-dx, -dz), 0, true));

      // ── the arrival predicate, and the whole point of this function ──
      // A cell below the body is entered by LANDING on it. Counting it from above hands the steering to
      // the next cell while the body is still a step up, so it crosses the step's corner in the air
      // and drops two.
      const landedOn = bot.entity.onGround && p.floored().equals(target);
      const entered = dy < -0.5
        ? landedOn
        : (p.floored().equals(target) || (flat <= 0.5 + RUN_ENTER_EPS && Math.abs(dy) < 1.2));
      // settled requires ground contact — a body passing through the target Y mid-arc without landing
      // would otherwise report arrival and then fall back to a lower cell.
      const settled = bot.entity.onGround
        && (p.floored().equals(target) || (flat <= RUN_STRICT_EPS && Math.abs(dy) < 0.6));
      if (isLast ? (strictFinal ? settled : entered) : entered) {
        idx++;
        lastProgressAt = Date.now();
        continue;
      }

      // ── the prejump ──
      // Aimed at the NEXT cell's rise when there is one, otherwise this cell's — the lookahead the
      // whole design turns on. No brake: the trigger fires at lead ≤ v×6, the window opens at lead ≥
      // v×4, so any position too fast to clear has already had the jump pressed (Law 16).
      const speed = horizontalSpeed(bot);
      if (speed > peak) peak = speed;
      const rise = riseAhead(p, cells, idx);
      // Consulted only when there is no rise — a cell cannot both climb and drop.
      const drop = rise ? null : dropAhead(p, cells, idx);
      let wantSprint = !!opts.sprint;

      if (rise) {
        const plan = jumpTriggerPlan(rise.faceDistance, speed, rise.height);
        let shouldJump;
        if (opts.prejump) {
          shouldJump = plan.jumpNow;
          if (shouldJump && !jumpHeld) {
            prejumps++;
            // Counts presses the arithmetic itself predicts will not clear — measured directly rather
            // than inferred from a stall.
            if (!plan.willClear) outOfBand++;
            // Records the full press — step, speed, window, verdict, bearing — so a fault can be traced
            // to which input was wrong, not just that one occurred (Law 25).
            if (jumps.length < 16) jumps.push({
              h: r2(rise.height), face: r2(rise.faceDistance), spd: r2(speed),
              ticks: r2(plan.ticksToFace), min: r2(plan.min), max: r2(plan.max),
              will: !!plan.willClear, why: plan.reason,
              deg: approachBearing(p, rise.cell), y: r2(p.y),
            });
          }
        } else {
          shouldJump = dy > 0.5;    // the A/B baseline: press jump on arrival
        }
        // Inside the clearance window's outer edge, the sprint impulse must be gone before the press;
        // plan.max is absent when no jump clears the step at all, and there is nothing to release for.
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
        // A descent presses nothing but is still a sprint decision — landing beyond the last validated
        // cell is unchecked ground, which Law 17 forbids, so sprint comes off once the edge is within
        // the body's flight distance.
        if (drop) {
          const land = descentLandingDistance(speed, drop.height);
          if (land.blocks != null && drop.edgeDistance <= land.blocks) wantSprint = false;
        }
      }

      if (opts.sprint && wantSprint !== sprintHeld) {
        bot.setControlState('sprint', wantSprint);
        if (sprintHeld === true && !wantSprint) sprintDrops++;
        // Clocked on the control, not the speed — a body commanded to sprint that fails to accelerate
        // should read as held-but-slow, not not-sprinting.
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
        // Reported even below the stall threshold — RUN_STALL_MS cannot fire inside a combat leg since
        // that leg's own clock is also 400ms and wins first, so stuckMs carries the evidence out either
        // way (the ARM owns escalation; see rush.js).
        stuckMs = Date.now() - lastProgressAt;
        // Still measured under a waiver — only the verdict is waived, so a slow door stays readable.
        if (stallMs != null && stuckMs > stallMs) return out('stalled');
      }
      await sleep(RUN_POLL_MS);
    }
  }, () => {
    if (jumpHeld) bot.setControlState('jump', false);
    // keepMoving governs sprint the same as forward — a chaining caller keeps the ramp, a finished
    // caller stops the body.
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
// Splits a typed-edge path into runs that may be walked continuously and edges that may not, kept
// separate from crossing so the lookahead decision can be tested headless.
//
// Only walk/step/stair fuse; anything that alters the world (bridge, pillar, dig) stays its own
// segment, since those primitives place or dig before stepping and a moving body would build under
// itself. `maxRun` is the lookahead depth.
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

// driveFlatToCell(bot, next, opts) — single-cell step for flat ground, digging through any obstacle it
// stalls against instead of ending the step.
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

// stepHorizontal(bot, dx, dz, optFloorBlock) — one horizontal cell, clearing obstacles and bridging a
// gap with a placed block where the ground does not carry across.
async function stepHorizontal(bot, dx, dz, optFloorBlock) {
  const TIMEOUT_MS = 1500;
  const POLL_MS = 50;

  const feet = bot.entity.position.floored();
  const target = new Vec3(feet.x + dx, feet.y, feet.z + dz);

  // Clear foot + head obstacles at the target cell.
  for (const offY of [0, 1]) {
    const blk = bot.blockAt(target.offset(0, offY, 0));
    if (blk && blk.boundingBox !== 'empty') {
      // performDig reports failure instead of throwing (false = cell not cleared); a refused dig ends
      // the step (Law 25).
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
    // The one place route (Law 16) owns equip, the spawn-protection gate, combat checkpoint, sneak,
    // aim and click; sneak: true holds the body on the block it bridges from. A refused bridge is
    // dangerous, not wasteful — the body would step onto a floor the client drew and the server never
    // laid, and fall.
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
