// shared primitive: anchored_repair
// The ONE stationary anchor-build routine shared by build_executor and mining_executor (Law 16):
// given a stand and integrity-diff steps, the bot stands ONCE, digs ALL reachable targets
// top-down, then places ALL reachable targets bottom-up (every voxel of a cell-sized volume is
// within the 4.5 reach radius). Enclosed corners place via the non-raycast findAttachable path
// (a "cheat place"). Valid on a vanilla server with no anti-cheat / no LOS.
//
// CONTRACT — repairAtAnchor(bot, job, ops):
//   job = { stand:{x,y,z}, steps:[integrity steps], label:string, digOrder?:'nearest_column' }  // stand = the FEET cell
//     (anchor floor block Y + 1); steps are already grouped for THIS anchor by the caller.
//   ops = {
//     digOne(step) -> Promise<bool>            // executor's per-block dig
//     placeOne(step, ev) -> 'already'|'skipped'|true|false   // executor's per-block place (ev has pos/anchor/face/underFeet)
//     resolveItem(type) -> name|null           // does the bot hold a block satisfying `type`?
//     isOptional(type) -> bool                 // may this place defer when unheld (torches)?
//     tag: string                              // watcher scope of the calling executor
//     maxPlaceAttempts: number
//   }
//   returns { dig_ok, dig_fail, place_ok, place_fail, already_ok, deferred, cheat_placed,
//             under_feet_ok, dig_fail_positions, place_fail_positions, defer_reasons }

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');

const { normalizeBlockName, BLOCK_REACH } = require('@utils/fragment_utils');
const { MIN_PLACEMENT_DIST } = require('@utils/pathfinding_utils');
// One process-wide 500 ms clock, shared with the dig and drive primitives; the engaging/escaping
// bypass keeps combat's own arms from re-entering it.
const { combatCheckpoint } = require('@api/battle_stations');
const { stepHorizontal } = require('@utils/movement/drive');
const { microCenter } = require('@utils/movement/motion_primitives');
const { isAir, dist3, classifyFloor } = require('@utils/movement/terrain_predicates');

const STEP_WAIT_MS = 200;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// A place step is equip + lookAt + placeBlock (+ one clearing dig), normally well under a second;
// at or past this it is a penalised dig or a stalled placeBlock, named in the phase summary.
const SLOW_PLACE_MS = 2000;

// EYE_FACTOR — vanilla eye height as a fraction of entity height (eye = feet + height*0.9).
const EYE_FACTOR = 0.9;

const INTERACTABLE_NAMES = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'anvil', 'stonecutter',
  'hopper', 'brewing_stand', 'cartography_table', 'loom', 'enchanting_table', 'lectern', 'grindstone', 'bell'
]);
function isInteractable(name) {
  return INTERACTABLE_NAMES.has(name)
    || /_door$/.test(name)
    || /_trapdoor$/.test(name)
    || /_fence_gate$/.test(name);
}

const ATTACH_DIRS = [
  { d: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { d: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
  { d: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { d: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { d: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { d: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
];

// findAttachable — the nearest solid full-block neighbor of pos to place against (no raycast).
// Interactable blocks (chests/doors) are a last-resort fallback (placing against them opens a UI).
// blockName, when given, limits the faces to the ones that block stands on: a block that only sits
// (a pressure plate, a carpet, a rail — support_plan.sitsOnly) is clicked onto the block below or not at
// all, since the server refuses it on a side face.
function findAttachable(bot, pos, blockName = null) {
  let interactableFallback = null;
  const sitsOnly = !!blockName && require('@kernel/support_plan').sitsOnly(blockName);
  for (const { d, face } of ATTACH_DIRS) {
    if (sitsOnly && d.y !== -1) continue;
    const neighborPos = pos.plus(d);
    const block = bot.blockAt(neighborPos);
    if (!block || isAir(block.name)) continue;
    if (block.boundingBox !== 'block') continue;
    if (isInteractable(block.name)) {
      if (!interactableFallback) interactableFallback = { anchor: block, face };
      continue;
    }
    return { anchor: block, face };
  }
  return interactableFallback;
}

// describeNeighborhood — the six face-neighbours of pos, by name, in ATTACH_DIRS order; the one
// owner (Law 16) of what is around this block, used by callers explaining a refused place.
function describeNeighborhood(bot, pos) {
  return ATTACH_DIRS.map(({ d }) => {
    const nb = bot.blockAt(pos.plus(d));
    return `${d.x},${d.y},${d.z}:${nb && !isAir(nb.name) ? nb.name : 'air'}`;
  }).join(' ');
}

// A target air voxel whose six face-neighbours are ALL solid is a diagonal corner with no
// exposed face to raycast; placing it via findAttachable is a cheat placement, counted for
// visibility on the live run.
function isEnclosedCorner(bot, pos) {
  for (const { d } of ATTACH_DIRS) {
    const nb = bot.blockAt(pos.plus(d));
    if (!nb || isAir(nb.name)) return false;
  }
  return true;
}

// botOccupiesCell — does the bot's bounding box currently overlap the unit cell at pos? A
// placeBlock into an occupied cell never fires blockUpdate and times out; this catches that at
// place time and routes to the under-feet (pillarStep) path.
function botOccupiesCell(bot, pos) {
  const e = bot && bot.entity;
  if (!e || !e.position) return false;
  const p = e.position;
  const hw = (e.width || 0.6) / 2 + 1e-3;
  const h = (e.height || 1.8);
  return (p.x + hw) > pos.x && (p.x - hw) < (pos.x + 1) &&
         (p.y + h)  > pos.y && (p.y)      < (pos.y + 1) &&
         (p.z + hw) > pos.z && (p.z - hw) < (pos.z + 1);
}

// standEye — the bot's eye position when microCentered on the stand block; every dig/place
// microCenters first, so reach measured from here is deterministic (see assertReachable).
function standEye(bot, stand) {
  return { x: stand.x + 0.5, y: stand.y + (bot.entity.height || 1.8) * EYE_FACTOR, z: stand.z + 0.5 };
}

// nearestFaceDist — distance from an eye point to the nearest point of the unit cube at pos,
// matching how the server range-checks a block interaction (eye to surface, not eye to center).
function nearestFaceDist(eye, pos) {
  const nx = Math.max(pos.x, Math.min(eye.x, pos.x + 1));
  const ny = Math.max(pos.y, Math.min(eye.y, pos.y + 1));
  const nz = Math.max(pos.z, Math.min(eye.z, pos.z + 1));
  return Math.sqrt((eye.x - nx) ** 2 + (eye.y - ny) ** 2 + (eye.z - nz) ** 2);
}

// reachFromStand — deterministic server-accurate reach from the microCentered stand block to a
// target voxel; the one reach metric (Law 16) shared by mining anchor-assignment and the in-loop
// reach gate below. pos may be a Vec3 or a plain {x,y,z}.
function reachFromStand(bot, stand, pos) {
  return nearestFaceDist(standEye(bot, stand), pos);
}

// assertReachable — Law 13 reach gate. Reach from the microCentered stand is deterministic, so a
// target beyond BLOCK_REACH is an anchor/blueprint coverage fault, and the gate raises on it.
function assertReachable(bot, stand, pos, kind, label) {
  const d = reachFromStand(bot, stand, pos);
  if (d > BLOCK_REACH) {
    throw new Error(
      `[anchored_repair] CODING VIOLATION (Law 13): ${kind} target (${pos.x},${pos.y},${pos.z}) is ${d.toFixed(2)} ` +
      `from the stand-block eye at ${label} — beyond BLOCK_REACH (${BLOCK_REACH}). The bot microCenters onto the ` +
      `stand before every dig/place, so reach is deterministic: a voxel out of reach from the anchor center is an ` +
      `anchor/blueprint coverage fault, not a positioning accident. Fix the anchor layout so every assigned voxel is reachable.`
    );
  }
  return d;
}

// evaluatePlacement — generic placement geometry (no executor domain knowledge): decides whether
// the target is the bot's own footing (under-feet → pillarStep in placeOne), out of reach, too
// close, or reachable with a solid attach face. `stand` classifies footing deterministically.
function evaluatePlacement(bot, step, stand) {
  const pos = new Vec3(step.place.x, step.place.y, step.place.z);
  const feet = bot.entity.position.floored();

  const atStand = stand && pos.x === stand.x && pos.y === stand.y && pos.z === stand.z;
  if (atStand || (pos.x === feet.x && pos.y === feet.y && pos.z === feet.z)) {
    return { ok: true, pos, underFeet: true };
  }

  // out_of_range is a live drift check from the bot's actual eye (nearest-face), triggering a
  // re-anchor when the bot has drifted off the stand. too_close is a center measurement — it
  // guards the lookAt aim angle.
  const eye = { x: bot.entity.position.x, y: bot.entity.position.y + (bot.entity.height || 1.8) * EYE_FACTOR, z: bot.entity.position.z };
  if (nearestFaceDist(eye, pos) > BLOCK_REACH) return { ok: false, reason: 'out_of_range', pos };
  const centerD = dist3({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }, eye);
  if (centerD < MIN_PLACEMENT_DIST) return { ok: false, reason: 'too_close', pos };

  const attach = findAttachable(bot, pos, step.type || null);
  if (!attach) return { ok: false, reason: 'no_attach_point', pos, neighbors: describeNeighborhood(bot, pos) };

  return { ok: true, pos, anchor: attach.anchor, face: attach.face, underFeet: false };
}

// resolveStandableAnchor — given a plot/anchor FLOOR cell, returns a standable stand to work
// from: the anchor's own feet if standable, else the nearest standable cell within reach.
// Returns { floor, feet, alternate } or null when nothing standable reaches the plot. Reuses
// classifyFloor and reachFromStand (Law 16 — one standability metric, one reach metric).
// opts.fallback === false restricts to the anchor's own floor or nothing, for a blueprint whose
// anchors are built by each other (wheat_tine_row: a missing stand means the row behind hasn't
// laid it yet).
function resolveStandableAnchor(bot, anchorFloor, opts = {}) {
  const reach = opts.reach || BLOCK_REACH;
  const af = new Vec3(anchorFloor.x, anchorFloor.y, anchorFloor.z);
  const standableAt = (fx, fy, fz) => !!classifyFloor(bot, bot.blockAt(new Vec3(fx, fy, fz)));
  const feetOf = (fx, fy, fz) => ({ x: fx, y: fy + 1, z: fz });
  // Primary: the anchor's own floor. If it is still standable nothing moved — work from it.
  if (standableAt(af.x, af.y, af.z)) {
    return { floor: { x: af.x, y: af.y, z: af.z }, feet: feetOf(af.x, af.y, af.z), alternate: false };
  }
  if (opts.fallback === false) return null;
  // Fallback: nearest standable floor in an expanding ring (±1 in Y for a stepped bank) whose
  // feet-eye still reaches the anchor cell.
  for (let r = 1; r <= 2; r++) {
    let best = null, bestD = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // ring perimeter only
        for (const dy of [0, 1, -1]) {
          const fx = af.x + dx, fy = af.y + dy, fz = af.z + dz;
          if (!standableAt(fx, fy, fz)) continue;
          const feet = feetOf(fx, fy, fz);
          if (reachFromStand(bot, feet, af) > reach) continue;      // must reach the plot from here
          const d = dx * dx + dz * dz + Math.abs(dy);
          if (d < bestD) { bestD = d; best = { floor: { x: fx, y: fy, z: fz }, feet, alternate: true }; }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// findStandableNeighbor — a cardinal cell beside stand with solid support below and air at
// feet/head. Returns { dx, dz } or null: a cell to step off the anchor onto, so its footing can
// be modified without the bot standing on it.
// The same level is asked first; on a staircase the cells beside the stand are one step up and one step
// down, so those are asked next and come back with `dy`.
function findStandableNeighbor(bot, stand) {
  for (const dy of [0, 1, -1]) {
    for (const { dx, dz } of [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]) {
      const support = bot.blockAt(new Vec3(stand.x + dx, stand.y + dy - 1, stand.z + dz));
      const feet    = bot.blockAt(new Vec3(stand.x + dx, stand.y + dy,     stand.z + dz));
      const head    = bot.blockAt(new Vec3(stand.x + dx, stand.y + dy + 1, stand.z + dz));
      if (support && support.boundingBox === 'block'
          && (!feet || isAir(feet.name)) && (!head || isAir(head.name))) {
        return { dx, dz, dy };
      }
    }
  }
  return null;
}

// sidestepFooting — replaces the block the bot stands on (footing at stand.y-1) without dropping
// the bot into the cell: step to a solid neighbor, dig/place the footing from the side (a normal
// side attach, not under-feet), then step back onto it if it now exists. Movement is
// stepHorizontal (one cardinal block, no goTo) so it never reaches the locomotion judge. Returns
// { handled, digOk, ... }; handled is false when no neighbor exists — the caller then defers.
async function sidestepFooting(bot, stand, footingDig, footingPlace, ops) {
  const { digOne, placeOne } = ops;
  const nb = findStandableNeighbor(bot, stand);
  if (!nb) return { handled: false };

  // One cardinal block on the level is a plain step; a step up or down a stair is a walk of one cell.
  const aside = { x: stand.x + nb.dx, y: stand.y + nb.dy, z: stand.z + nb.dz };
  const walk = async (to) => !!(await locomotion.goTo({ x: to.x, y: to.y, z: to.z, exact: true, leg: 'work' }))?.arrived;
  await microCenter(bot);
  if (!(nb.dy ? await walk(aside) : await stepHorizontal(bot, nb.dx, nb.dz))) return { handled: false };
  await microCenter(bot);

  let digOk = 0, digFail = 0, placeOk = 0, placeFail = 0;
  if (footingDig) { if (await digOne(footingDig)) digOk++; else digFail++; }
  if (footingPlace) {
    const ev = evaluatePlacement(bot, footingPlace, stand);   // bot is aside now → normal side place
    if (ev.ok) {
      const r = await placeOne(footingPlace, ev);
      if (r === true) placeOk++;
      else if (r !== 'already' && r !== 'skipped') placeFail++;
    } else {
      placeFail++;
    }
  }

  // Return onto the footing only if it still exists — re-sensed, never assumed (Law 23); staying
  // aside otherwise is the correct end state, and the caller re-runs ensureAtAnchor next phase.
  const footingCell = new Vec3(stand.x, stand.y - 1, stand.z);
  const footingNow = bot.blockAt(footingCell);
  const footingSolid = !!(footingNow && footingNow.boundingBox === 'block');
  if (footingSolid) {
    if (nb.dy) await walk(stand); else await stepHorizontal(bot, -nb.dx, -nb.dz);
    await microCenter(bot);
  }
  return { handled: true, digOk, digFail, placeOk, placeFail, steppedBack: footingSolid };
}

// repairAtAnchor — the shared stationary dig-all/place-all routine (see file header for the
// contract). Per-block mechanics (digOne/placeOne) and item policy (resolveItem/isOptional) are
// injected so mining and building share the control flow without merging their domains.
async function repairAtAnchor(bot, job, ops) {
  const { stand, steps, label } = job;
  const { digOne, placeOne, resolveItem, isOptional, tag } = ops;
  const maxPlaceAttempts = ops.maxPlaceAttempts || 3;

  let digOk = 0, digFail = 0, placeOk = 0, placeFail = 0, alreadyOk = 0;
  let cheatPlaced = 0, deferred = 0, underFeetOk = 0, pocketShort = 0, skipped = 0;
  let placeMsTotal = 0, slowestPlaceMs = 0, slowestPlaceAt = null, slowPlaces = 0;
  const digFailPositions = [];
  const placeFailPositions = [];
  const deferReasons = {};
  // pocket_short is its own bucket, never folded into `deferred` — a required block this body
  // does not hold; unlike a defer it will not heal by retrying, so the caller releases for resupply.
  const shortMaterials = {};

  // Footing = the block the bot stands on (stand.y-1). Replacing it in the bulk pass drops the
  // bot into the cell, so when ops.footingSidestep is set those steps are pulled out and handled
  // atomically via sidestepFooting after the rest of the cell is built. Callers that legitimately
  // dig their own floor (mining descent, locomotion's dig-down) leave it unset (Law 16: one
  // behaviour, chosen by the caller that owns the domain).
  const footingSidestep = !!ops.footingSidestep;
  const atFooting = (s) => s.place.x === stand.x && s.place.y === stand.y - 1 && s.place.z === stand.z;
  const footingPlace = footingSidestep ? (steps.find(s => s.action === 'place' && atFooting(s)) || null) : null;
  const footingDig   = footingSidestep ? (steps.find(s => s.action === 'dig' && atFooting(s)) || null) : null;
  const isFootingStep = (s) => footingSidestep && (footingPlace || footingDig) && atFooting(s);

  watcher.buffer.open(tag);
  await combatCheckpoint(bot, 'repair');

  // A STAND THE BODY CANNOT GET TO IS WORKED TOWARD FROM WHERE THE BODY STANDS. A stand hanging in a cave has
  // no floor to walk onto until this job's own blocks are placed. The walk is tried once; when it does not
  // arrive, `from` becomes the cell the body stopped in and every step is measured from there: a step in
  // reach is worked, a step out of reach is deferred, and the caller's next pass walks further on the floor
  // this pass laid.
  let from = stand;
  let offStand = false;
  const outOfReach = (pos) => offStand && reachFromStand(bot, from, pos) > BLOCK_REACH;
  async function ensureAtAnchor() {
    const feet = bot.entity.position.floored();
    // Stand directly on the anchor cell (never a block off) — reach from the microCentered stand
    // is deterministic, so a 1-block offset puts far voxels out of reach.
    if (!offStand && (feet.x !== stand.x || feet.y !== stand.y || feet.z !== stand.z)) {
      // A stand with nothing under it is never walked onto: the body goes to the nearest floor that reaches it
      // (resolveStandableAnchor), or stays where it is when there is none.
      const floor = { x: stand.x, y: stand.y - 1, z: stand.z };
      const under = bot.blockAt(new Vec3(floor.x, floor.y, floor.z));
      const near = under && under.boundingBox === 'block' ? { feet: stand, alternate: false } : resolveStandableAnchor(bot, floor);
      // With no floor to aim at, a body still far off walks toward the stand as far as the route goes (the
      // navigator stops where the ground does); a body already close works from where it is.
      const far = Math.hypot(feet.x - stand.x, feet.y - stand.y, feet.z - stand.z) > 2 * BLOCK_REACH;
      const to = near ? near.feet : far ? stand : null;
      const went = to ? await locomotion.goTo({ x: to.x, y: to.y, z: to.z, exact: true, leg: 'work' }) : null;
      const now = bot.entity.position.floored();
      if (now.x !== stand.x || now.y !== stand.y || now.z !== stand.z) {
        offStand = true;
        from = { x: now.x, y: now.y, z: now.z };
        watcher.summary(tag, `STAND_UNREACHED ${label} stand=(${stand.x},${stand.y},${stand.z}) working_from=(${from.x},${from.y},${from.z}) `
          + `reason=${!to ? 'no floor under the stand and none near it' : !near || near.alternate ? 'no floor under the stand' : (went?.reason || 'none given')}`);
      }
    }
    await microCenter(bot);
  }
  // ── Dig ALL (top-down). Cheat-dig: reach-distance gate only, no LOS. Reach is asserted from
  // the microCentered stand; an unreachable target is a coverage fault → Law 13 throw.
  await ensureAtAnchor();
  // `digOrder: 'nearest_column'` (a tunnel advancing): the column nearest the stand first, head then feet, so
  // the body opens the block in front of it before the one behind it. Otherwise top-down, row by row.
  const flat = (p) => Math.abs(p.x - stand.x) + Math.abs(p.z - stand.z);
  const byOrder = job.digOrder === 'nearest_column'
    ? (a, b) => (flat(a.place) - flat(b.place)) || (b.place.y - a.place.y)
    : (a, b) => b.place.y - a.place.y;
  const digSteps = steps.filter(s => s.action === 'dig' && !isFootingStep(s)).sort(byOrder);
  for (const s of digSteps) {
    const pos = new Vec3(s.place.x, s.place.y, s.place.z);
    if (outOfReach(pos)) { deferred++; deferReasons.off_stand = (deferReasons.off_stand || 0) + 1; continue; }
    const reach = assertReachable(bot, from, pos, 'dig', label);
    await combatCheckpoint(bot, 'repair');
    const had = bot.blockAt(pos);
    watcher.buffer.record(tag, `dig (${pos.x},${pos.y},${pos.z}) ${had?.name || '?'} reach=${reach.toFixed(2)} (want ${normalizeBlockName(s.type)})`);
    if (await digOne(s)) { digOk++; watcher.buffer.record(tag, `  → cleared`); }
    else { digFail++; digFailPositions.push(`(${pos.x},${pos.y},${pos.z})`); watcher.buffer.record(tag, `  → FAILED`); }
  }
  const digFailStr = digFailPositions.length ? ` | failed: ${digFailPositions.join(' ')}` : '';
  watcher.summary(tag, `${label} dig: cleared ${digOk}, failed ${digFail} (of ${digSteps.length})${digFailStr}`);

  // ── Place ALL (bottom-up so each course has a placed reference below). findAttachable picks a
  // solid neighbour and bot.placeBlock(ref, face) places against it with no raycast.
  await ensureAtAnchor();
  const placeSteps = steps.filter(s => s.action === 'place' && !isFootingStep(s)).sort((a, b) => a.place.y - b.place.y);
  for (const s of placeSteps) {
    await combatCheckpoint(bot, 'repair');
    const dt = normalizeBlockName(s.type);
    const pos = new Vec3(s.place.x, s.place.y, s.place.z);
    // Deterministic reach gate (Law 13): unreachable from the microCentered stand is a coverage
    // fault → throw. A footing block is always within reach, so this never fires on that path.
    if (outOfReach(pos)) { deferred++; deferReasons.off_stand = (deferReasons.off_stand || 0) + 1; continue; }
    assertReachable(bot, from, pos, 'place', label);

    let outcome = null;        // 'ok' | 'already' | 'skipped' | 'defer' | 'fail'
    let lastReason = null;
    let wasUnderFeet = false, wasCorner = false;
    // The caller's own preparation of this step (a builder stands up a block's support first), and its cleanup
    // once the step is tallied, whatever the outcome.
    if (ops.beforePlace) await ops.beforePlace(s);

    for (let attempt = 1; attempt <= maxPlaceAttempts; attempt++) {
      const ev = evaluatePlacement(bot, s, from);

      if (!ev.ok) {
        lastReason = ev.reason || '?';
        // out_of_range means the bot drifted off the anchor — re-anchor and retry before
        // deferring. no_attach_point/too_close are genuine "wait for a neighbour" defers.
        if (ev.reason === 'out_of_range' && attempt < maxPlaceAttempts) {
          watcher.buffer.record(tag, `out_of_range (${pos.x},${pos.y},${pos.z}) — re-anchoring (attempt ${attempt}/${maxPlaceAttempts})`);
          await ensureAtAnchor();
          continue;
        }
        outcome = 'defer';
        watcher.buffer.record(tag, `defer (${pos.x},${pos.y},${pos.z}) ${dt}: ${lastReason}${ev.neighbors ? ` [nbrs ${ev.neighbors}]` : ''}`);
        break;
      }

      // Runtime under-feet re-check: if the bot now occupies the target cell (fell in since eval
      // time), force the under-feet path so placeOne pillarSteps before placing.
      if (!ev.underFeet && botOccupiesCell(bot, pos)) {
        ev.underFeet = true;
        watcher.buffer.record(tag, `runtime under-feet: bot occupies (${pos.x},${pos.y},${pos.z}) → pillarStep`);
      }
      wasUnderFeet = ev.underFeet;
      wasCorner = isEnclosedCorner(bot, pos);

      // A station whose every reachable neighbour is another station still defers (no_attach_point):
      // an unplaced neighbour is an environmental transient, not a blueprint fault.

      if (!resolveItem(dt)) {
        if (isOptional(dt)) { outcome = 'skipped'; break; }
        // Required block not held — its own outcome, not a defer: it won't appear on retry, so
        // the caller releases for resupply instead of re-running the pass.
        lastReason = 'pocket_short';
        watcher.buffer.record(tag, `pocket_short (${pos.x},${pos.y},${pos.z}) ${dt}: required block not in inventory`);
        outcome = 'pocket_short'; break;
      }

      const cls = wasUnderFeet ? 'footing/pillar' : (wasCorner ? 'corner-cheat' : 'normal');
      const refStr = ev.anchor ? `${ev.anchor.name}@(${ev.anchor.position.x},${ev.anchor.position.y},${ev.anchor.position.z}) face(${ev.face.x},${ev.face.y},${ev.face.z})` : 'n/a';
      watcher.buffer.record(tag, `place (${pos.x},${pos.y},${pos.z}) ${dt} [${cls}] ref=${refStr} attempt ${attempt}/${maxPlaceAttempts}`);
      const tPlace = Date.now();
      const result = await placeOne(s, ev);
      // Per-step wall clock: a step running for seconds means the underlying dig is penalised
      // (head-in-water / off-ground dig-speed multipliers). Tracked so the phase summary can
      // never hide its own duration (Law 5/6).
      const stepMs = Date.now() - tPlace;
      placeMsTotal += stepMs;
      if (stepMs > slowestPlaceMs) { slowestPlaceMs = stepMs; slowestPlaceAt = `${dt}@(${pos.x},${pos.y},${pos.z}) [${cls}]`; }
      if (stepMs >= SLOW_PLACE_MS) slowPlaces++;

      if (result === 'already') { outcome = 'already'; break; }
      if (result === 'skipped') { outcome = 'skipped'; break; }
      if (result === true) { outcome = 'ok'; break; }

      // Hard place failure — retry. A failed NORMAL place usually means the bot was standing
      // in the cell (footing) and timed out; the next attempt's under-feet re-check pillarSteps.
      lastReason = 'place_failed';
      if (attempt < maxPlaceAttempts) await sleep(STEP_WAIT_MS);
      else outcome = 'fail';
    }

    // ── Tally once per step ──────────────────────────────────────────────
    if (outcome === 'ok') {
      placeOk++;
      if (wasCorner) cheatPlaced++;
      // An under-feet placement pillared the bot up one block — return to the stand so
      // remaining steps measure reach correctly.
      if (wasUnderFeet) { underFeetOk++; await ensureAtAnchor(); }
      watcher.buffer.record(tag, `  → placed${wasCorner ? ' (corner cheat)' : ''}${wasUnderFeet ? ' (footing pillar)' : ''}`);
    } else if (outcome === 'already') {
      alreadyOk++; watcher.buffer.record(tag, `  → already correct`);
    } else if (outcome === 'skipped') {
      // Optional step whose material is not held — a first-class terminal outcome, not a no-op:
      // the caller needs a nonzero count to tell "skipped an optional" from "did nothing", else an
      // optional-only anchor loops zero-progress into a strict-kill.
      skipped++; watcher.buffer.record(tag, `  → skipped (optional, not in inventory)`);
    } else if (outcome === 'pocket_short') {
      pocketShort++;
      shortMaterials[dt] = (shortMaterials[dt] || 0) + 1;
      watcher.buffer.record(tag, `  → material short`);
    } else if (outcome === 'defer') {
      deferReasons[lastReason || '?'] = (deferReasons[lastReason || '?'] || 0) + 1;
      deferred++;
    } else {
      placeFail++; placeFailPositions.push(`(${pos.x},${pos.y},${pos.z})${dt}${s.failReason ? `[${s.failReason}]` : ''}`);
      watcher.buffer.record(tag, `  → FAILED${s.failReason ? `: ${s.failReason}` : ''}`);
    }
    if (ops.afterPlace) await ops.afterPlace(s);
  }
  // ── Footing REPLACE (sidestep): after the rest of the cell is built, swap the block the bot has
  // been standing on — step aside, dig+place it from the side, step back. No fall (see sidestepFooting).
  if (footingPlace || footingDig) {
    const fp = (footingPlace || footingDig).place;
    const res = await sidestepFooting(bot, stand, footingDig, footingPlace, ops);
    if (res.handled) {
      digOk += res.digOk; digFail += res.digFail; placeOk += res.placeOk; placeFail += res.placeFail;
      if (res.digFail)   digFailPositions.push(`(${fp.x},${fp.y},${fp.z})`);
      if (res.placeFail) placeFailPositions.push(`(${fp.x},${fp.y},${fp.z})${normalizeBlockName(footingPlace.type)}`);
      watcher.buffer.record(tag, `footing (${fp.x},${fp.y},${fp.z}) replaced by sidestep: dig ${res.digOk}/${res.digOk + res.digFail}, place ${res.placeOk}/${res.placeOk + res.placeFail}`);
    } else {
      // No neighbor to stand on right now, so the footing swap defers.
      deferred++;
      deferReasons['footing_no_sidestep'] = (deferReasons['footing_no_sidestep'] || 0) + 1;
      await ensureAtAnchor();
      watcher.buffer.record(tag, `footing (${fp.x},${fp.y},${fp.z}) deferred — no standable neighbor to sidestep to (avoids the drop)`);
    }
  }

  const cheatStr = cheatPlaced > 0 ? ` (${cheatPlaced} corner cheat-placed)` : '';
  const footStr = underFeetOk > 0 ? `, footing ${underFeetOk}` : '';
  const deferStr = Object.keys(deferReasons).length ? ` | deferred: ${Object.entries(deferReasons).map(([r, c]) => `${c}×${r}`).join(', ')}` : '';
  const shortStr = pocketShort > 0 ? ` | pocket_short: ${Object.entries(shortMaterials).map(([m, c]) => `${c}×${m}`).join(', ')}` : '';
  const failStr = placeFailPositions.length ? ` | failed: ${placeFailPositions.join(' ')}` : '';
  const timeStr = ` | ${(placeMsTotal / 1000).toFixed(1)}s`;
  const slowStr = slowPlaces > 0
    ? ` (${slowPlaces} slow ≥${SLOW_PLACE_MS / 1000}s, worst ${(slowestPlaceMs / 1000).toFixed(1)}s ${slowestPlaceAt})`
    : '';
  watcher.summary(tag, `${label} place: placed ${placeOk}${cheatStr}${footStr}, failed ${placeFail}, already ${alreadyOk}, deferred ${deferred} (of ${placeSteps.length})${timeStr}${slowStr}${deferStr}${shortStr}${failStr}`);
  // A phase spent mostly in slow steps is degraded even though every step "succeeded" — warn on
  // duration since that failure mode has no failure count.
  if (slowPlaces > 0 && placeMsTotal >= SLOW_PLACE_MS * 2) {
    watcher.warn(tag, `${label} place ran ${(placeMsTotal / 1000).toFixed(1)}s for ${placeSteps.length} step(s) — ${slowPlaces} step(s) ≥${SLOW_PLACE_MS / 1000}s, worst ${(slowestPlaceMs / 1000).toFixed(1)}s at ${slowestPlaceAt}. Dig-speed penalty (head in water / off ground = 5x each, 25x together) or a stalled placeBlock.`);
  }

  return {
    dig_ok: digOk, dig_fail: digFail, place_ok: placeOk, place_fail: placeFail,
    already_ok: alreadyOk, deferred, cheat_placed: cheatPlaced, under_feet_ok: underFeetOk,
    pocket_short: pocketShort, short_materials: shortMaterials, skipped,
    place_ms_total: placeMsTotal, slowest_place_ms: slowestPlaceMs, slow_places: slowPlaces,
    dig_fail_positions: digFailPositions, place_fail_positions: placeFailPositions, defer_reasons: deferReasons,
  };
}

// ── A VOXEL SET IS WORKED UNTIL IT SETTLES ────────────────────────────────────────────────────────────
// One cycle is: read the world (`rescan` → the steps still owed), dig every dig step, place every place step
// (`work`). Cycles repeat so what a dig sets loose — gravel dropping into a cleared cell, the empty slot it
// left in the ceiling or wall — is dug and sealed before the caller moves on. The loop ends on exactly one of:
//   clean      the rescan owes nothing;
//   no_moves   a cycle dug and placed nothing (what is left is deferred, short or refused);
//   repeat     the rescan owes a step set already worked this settle — the world undid the work;
//   cycle_cap  SETTLE_MAX_CYCLES cycles ran.
// It never routes a signal: it returns, and the caller routes once (Law 4).
const SETTLE_MAX_CYCLES = 6;

async function settle({ rescan, work, label, tag }) {
  const totals = { dig_ok: 0, dig_fail: 0, place_ok: 0, place_fail: 0, deferred: 0, cheat_placed: 0, skipped: 0, pocket_short: 0, short_materials: {} };
  const worked = new Set();
  let cycles = 0, stop = null, steps = rescan();
  while (true) {
    if (steps.length === 0) { stop = 'clean'; break; }
    const sig = steps.map(s => `${s.action}:${s.place.x},${s.place.y},${s.place.z}:${s.type}`).sort().join('|');
    if (worked.has(sig)) { stop = 'repeat'; break; }
    if (cycles >= SETTLE_MAX_CYCLES) { stop = 'cycle_cap'; break; }
    worked.add(sig);
    cycles++;
    const r = await work(steps, cycles);
    for (const k of ['dig_ok', 'dig_fail', 'place_ok', 'place_fail', 'deferred', 'cheat_placed', 'skipped']) totals[k] += r[k] || 0;
    // A shortfall is a standing state, not a count of events: each cycle re-reads the same missing blocks,
    // so the settle reports the last cycle's shortfall, never their sum.
    totals.pocket_short = r.pocket_short || 0;
    totals.short_materials = { ...(r.short_materials || {}) };
    const moved = (r.dig_ok || 0) + (r.place_ok || 0);
    steps = rescan();
    if (moved === 0 && steps.length > 0) { stop = 'no_moves'; break; }
  }
  watcher.summary(tag, `${label} settle: ${stop} after ${cycles} cycle(s) — dug ${totals.dig_ok}, placed ${totals.place_ok}, ${steps.length} step(s) left`);
  return { ...totals, cycles, stop, remaining: steps.length, remaining_steps: steps };
}

module.exports = { settle, SETTLE_MAX_CYCLES, repairAtAnchor, evaluatePlacement, findAttachable, describeNeighborhood, isEnclosedCorner, botOccupiesCell, reachFromStand, standEye, nearestFaceDist, resolveStandableAnchor, findStandableNeighbor, ATTACH_DIRS, isInteractable };
