// shared primitive: anchored_repair
// purpose: The ONE stationary anchor-build routine shared by build_executor and
//          mining_executor (Law 16 / D3 — one repair primitive under two separate
//          executors). Given a stand position and a set of integrity-diff steps, the
//          bot stands ONCE at the anchor and digs ALL reachable targets (top-down),
//          then places ALL reachable targets (bottom-up) — every voxel of a cell-sized
//          volume is within the 4.5 reach radius, so no pillaring/vantage movement is
//          needed. Enclosed corners (an air pocket whose six faces are all solid, no
//          raycastable face) place via the non-raycast findAttachable path (a "cheat
//          place"). Valid on a vanilla server with no anti-cheat / no LOS enforcement.
//
// WHY this is a shared primitive and not two copies:
//   Building and mining are SEPARATE executors serving different purposes (building finds
//   a fresh spot; mining procedurally extends a descent + collects ore). But the mechanism
//   by which each turns a blueprint+integrity diff into repaired blocks is IDENTICAL:
//   stand at an anchor, dig-all then place-all within reach, cheat the enclosed corners.
//   That identical mechanism lives here ONCE. Each executor keeps its own domain logic
//   (item resolution, stations, ore/gravity, descent bookkeeping) and injects the two
//   per-block mechanics that legitimately differ — digOne and placeOne — as callbacks.
//
// CONTRACT — repairAtAnchor(bot, job, ops):
//   job = { stand:{x,y,z}, steps:[integrity steps], label:string }
//     - stand is the FEET cell the bot occupies (anchor floor block Y + 1).
//     - steps are already grouped for THIS anchor by the caller (build_executor groups by
//       blueprint anchor_index; mining groups by nearest-anchor reach). The primitive does
//       not re-group — it digs/places exactly what it is handed, gating each on live reach.
//   ops = {
//     digOne(step) -> Promise<bool>            // executor's per-block dig (mining adds the
//                                              //   gravity-column repeat-mine; building is plain)
//     placeOne(step, ev) -> 'already'|'skipped'|true|false   // executor's per-block place
//                                              //   (consumes ev.pos/anchor/face/underFeet)
//     resolveItem(type) -> name|null           // does the bot hold a block satisfying `type`?
//     isOptional(type) -> bool                 // may this place defer when unheld (torches)?
//     stationTypes: Set<string>                // types needing a non-station attach face
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
// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { stepHorizontal } = require('@utils/movement/drive');
const { microCenter } = require('@utils/movement/motion_primitives');
const { isAir, dist3, classifyFloor } = require('@utils/movement/terrain_predicates');

const STEP_WAIT_MS = 200;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// A place step is equip + lookAt + placeBlock (+ one clearing dig). All of that should land well
// under a second; anything at or past this is a penalised dig or a stalled placeBlock, and is called
// out by name in the phase summary rather than averaged away.
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

// Solid-neighbor check — no raycast. If any of the 6 neighbors is a solid full block,
// that face qualifies as a placeBlock reference. Raycasts false-negative when the bot is
// close or the ray clips a block edge; solid-neighbor is deterministic. Interactable
// blocks (chests/doors) are a last-resort fallback — placing against them can open a UI.
function findAttachable(bot, pos) {
  let interactableFallback = null;
  for (const { d, face } of ATTACH_DIRS) {
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

// describeNeighborhood — the six face-neighbours of a voxel, by name, in ATTACH_DIRS order.
// The ONE owner (Law 16) of "what is around this block": evaluatePlacement built this string
// inline for its no_attach_point branch, and mining_executor's placeOne needs the same answer to
// explain a refused place (Architect 2026-07-15: "upgrade it to state what is currently in the spot
// its trying to place and whats around it"). Fixed order so two dumps from different passes diff by
// eye. Names only — a caller wanting attach geometry calls findAttachable, which decides it.
function describeNeighborhood(bot, pos) {
  return ATTACH_DIRS.map(({ d }) => {
    const nb = bot.blockAt(pos.plus(d));
    return `${d.x},${d.y},${d.z}:${nb && !isAir(nb.name) ? nb.name : 'air'}`;
  }).join(' ');
}

// A target air voxel whose six face-neighbours are ALL solid is a diagonal corner an
// ordinary player could not place (no exposed face to raycast). Placing it via
// findAttachable + bot.placeBlock(ref, face) is a cheat placement — counted so the
// Architect can watch it on the live run.
function isEnclosedCorner(bot, pos) {
  for (const { d } of ATTACH_DIRS) {
    const nb = bot.blockAt(pos.plus(d));
    if (!nb || isAir(nb.name)) return false;
  }
  return true;
}

// botOccupiesCell — does the bot's bounding box currently overlap the unit cell at pos?
// A normal bot.placeBlock into a cell the bot stands in never fires blockUpdate and times
// out after 5s (the server refuses to place a block inside the player). evaluatePlacement
// classifies the footing by the KNOWN stand cell at EVAL time, but after the dig phase
// removes the bot's own floor/footing block the bot FALLS into the target cell — so by
// PLACE time it occupies a cell that was not the stand cell at eval time. This live AABB
// check catches that at place time → route to the under-feet (pillarStep) path.
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

// standEye — the bot's eye position when microCentered on the stand block. Every dig/place is
// preceded by a microCenter onto the stand, so the bot IS at the block's X/Z center; reach
// measured from here is DETERMINISTIC (independent of live drift), which is what makes an
// out-of-reach target a coding fault rather than a positioning accident (see assertReachable).
function standEye(bot, stand) {
  return { x: stand.x + 0.5, y: stand.y + (bot.entity.height || 1.8) * EYE_FACTOR, z: stand.z + 0.5 };
}

// nearestFaceDist — distance from an eye point to the NEAREST point of the unit cube at pos.
// This is how the vanilla server range-checks a block interaction: eye → the clicked point on
// the block's SURFACE, not eye → block center. Measuring to the center under-reports reach by
// up to ~0.5 (half a block) and wrongly rejects blocks the server would accept — packet-send
// placement skips the line-of-sight raycast but NOT this distance check.
function nearestFaceDist(eye, pos) {
  const nx = Math.max(pos.x, Math.min(eye.x, pos.x + 1));
  const ny = Math.max(pos.y, Math.min(eye.y, pos.y + 1));
  const nz = Math.max(pos.z, Math.min(eye.z, pos.z + 1));
  return Math.sqrt((eye.x - nx) ** 2 + (eye.y - ny) ** 2 + (eye.z - nz) ** 2);
}

// reachFromStand — deterministic server-accurate reach from the microCentered stand block to a
// target voxel. ONE metric (Law 16), shared by the mining anchor-assignment and the in-loop
// reach gate below. pos may be a Vec3 or a plain {x,y,z}.
function reachFromStand(bot, stand, pos) {
  return nearestFaceDist(standEye(bot, stand), pos);
}

// assertReachable — Law 13 reach gate. The bot microCenters onto the stand block before every
// dig and place, so it is deterministically at the block center; reach from there is a pure
// function of the blueprint/anchor geometry. A target beyond BLOCK_REACH from the stand-block
// eye is therefore NOT a positioning accident a retry could fix — it is an anchor/blueprint
// COVERAGE fault (a voxel assigned to an anchor that cannot reach it). Per Law 13 that is a
// coding violation: throw immediately rather than soft-skip and limp on leaving a hole. (Every
// current anchored blueprint clears this: worst face-reach headframe 3.66, chest 3.37, cell
// 2.67, staircase 4.14 — so this only ever fires on a genuine future coverage regression.)
// The staircase figure is the live one: re-measured through reachFromStand itself after the
// staircase box was filled solid, so it already covers the filled shell's far corners.
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

// evaluatePlacement — generic placement geometry (no executor domain knowledge). Decides
// whether the target is the bot's own footing (under-feet → pillarStep in the executor's
// placeOne), out of reach, too close, or reachable with a solid attach face. `stand` is the
// KNOWN anchor feet cell so the footing block classifies deterministically regardless of
// the bot's momentary drift between eval and place.
function evaluatePlacement(bot, step, stand) {
  const pos = new Vec3(step.place.x, step.place.y, step.place.z);
  const feet = bot.entity.position.floored();

  const atStand = stand && pos.x === stand.x && pos.y === stand.y && pos.z === stand.z;
  if (atStand || (pos.x === feet.x && pos.y === feet.y && pos.z === feet.z)) {
    return { ok: true, pos, underFeet: true };
  }

  // out_of_range is a LIVE drift check (server reach from the bot's actual eye, nearest-face) —
  // its only job is to trigger a re-anchor when the bot has drifted off the stand; the
  // deterministic assertReachable (from the stand center) already threw on any true coverage
  // fault before this runs. too_close stays a CENTER measurement (it guards the lookAt aim
  // angle, which degrades when the block center is almost under the eye, not when a face is near).
  const eye = { x: bot.entity.position.x, y: bot.entity.position.y + (bot.entity.height || 1.8) * EYE_FACTOR, z: bot.entity.position.z };
  if (nearestFaceDist(eye, pos) > BLOCK_REACH) return { ok: false, reason: 'out_of_range', pos };
  const centerD = dist3({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }, eye);
  if (centerD < MIN_PLACEMENT_DIST) return { ok: false, reason: 'too_close', pos };

  const attach = findAttachable(bot, pos);
  if (!attach) return { ok: false, reason: 'no_attach_point', pos, neighbors: describeNeighborhood(bot, pos) };

  return { ok: true, pos, anchor: attach.anchor, face: attach.face, underFeet: false };
}

// resolveStandableAnchor — given a plot/anchor FLOOR cell (the block the bot stands ON to service the
// plot), return a standable stand to work FROM: the anchor's own feet if that floor is standable, else
// the nearest standable cell within reach of the anchor. This is "search for a standable anchor within
// the placement radius, then build/tend from there" (Architect 2026-07-18) — the fix for a plot whose
// baked stand block was lost to dynamic water (a decomposed wheat_plot_pair tuple: if the block the bot
// should stand on is now water, it cannot stand on it to rebuild it, so it stands on a dry lip nearby
// and places the missing block from the side/apex). Returns { floor, feet, alternate } or null when
// NOTHING standable reaches the plot (a truly stranded plot — the caller marks it non-actionable rather
// than livelock: bot bobs → escape → re-dispatch → bob …, the halt this fixes). Reuses the scanner's
// own standability predicate (classifyFloor: solid walkable floor + clear feet/head) and reachFromStand
// (Law 16 — one standability metric, one reach metric). A wheat_plot_pair is one anchor + an adjacent
// crop, so a cell within BLOCK_REACH of the anchor reaches the whole plot; the small ring reflects that.
function resolveStandableAnchor(bot, anchorFloor, opts = {}) {
  const reach = opts.reach || BLOCK_REACH;
  const af = new Vec3(anchorFloor.x, anchorFloor.y, anchorFloor.z);
  const standableAt = (fx, fy, fz) => !!classifyFloor(bot, bot.blockAt(new Vec3(fx, fy, fz)));
  const feetOf = (fx, fy, fz) => ({ x: fx, y: fy + 1, z: fz });
  // Primary: the anchor's own floor. If it is still standable nothing moved — work from it.
  if (standableAt(af.x, af.y, af.z)) {
    return { floor: { x: af.x, y: af.y, z: af.z }, feet: feetOf(af.x, af.y, af.z), alternate: false };
  }
  // Fallback: nearest standable floor in an expanding ring (±1 in Y for a stepped bank) whose feet-eye
  // still reaches the anchor cell — the dry lip beside the water-damaged plot.
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

// findStandableNeighbor — a cardinal cell beside the stand the bot can stand on: solid full-block
// support below, air at feet + head. Returns { dx, dz } or null. Used to step OFF the anchor so the
// footing block underneath can be modified without the bot standing on it (see sidestepFooting).
function findStandableNeighbor(bot, stand) {
  for (const { dx, dz } of [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }]) {
    const support = bot.blockAt(new Vec3(stand.x + dx, stand.y - 1, stand.z + dz));
    const feet    = bot.blockAt(new Vec3(stand.x + dx, stand.y,     stand.z + dz));
    const head    = bot.blockAt(new Vec3(stand.x + dx, stand.y + 1, stand.z + dz));
    if (support && support.boundingBox === 'block'
        && (!feet || isAir(feet.name)) && (!head || isAir(head.name))) {
      return { dx, dz };
    }
  }
  return null;
}

// sidestepFooting — do the work on the block the bot stands on (the footing at stand.y-1) WITHOUT the old
// fall-and-pillar dance. The footing must exist continuously (it is what holds the bot up), so a
// naive dig-all/place-all split drops the bot into the cell and pillarSteps it back — the "it fell
// off the anchor" bug. Instead: step to a solid neighbor, dig the old footing + place the new one
// FROM THE SIDE (the bot no longer occupies the cell, so evaluatePlacement sees a normal side attach,
// not under-feet), then step back onto the fresh footing. Movement is stepHorizontal (one cardinal
// block, no goTo) so it never reaches the locomotion judge. Returns { handled, digOk, ... }; handled
// is false when no neighbor exists to stand on — the caller then DEFERS the footing (never falls).
// Handles a REPLACE (dig+place), a bare PLACE, or a bare DIG; the step-back is conditional on the
// footing actually being there afterwards, which is what makes the bare-dig case safe.
async function sidestepFooting(bot, stand, footingDig, footingPlace, ops) {
  const { digOne, placeOne } = ops;
  const nb = findStandableNeighbor(bot, stand);
  if (!nb) return { handled: false };

  await microCenter(bot);
  if (!await stepHorizontal(bot, nb.dx, nb.dz)) return { handled: false };
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

  // Return onto the footing ONLY IF IT STILL EXISTS — re-sensed, never assumed (Law 23). With a replace
  // this is a formality (the place just rebuilt it). With a BARE footing dig there is now a hole, and the
  // old unconditional step-back would have walked the bot straight into the drop it stepped aside to
  // avoid — turning the safety manoeuvre into the fall. Staying aside is the correct end state: the caller
  // re-runs ensureAtAnchor on the next phase and locomotion re-approaches from wherever the bot actually is.
  const footingCell = new Vec3(stand.x, stand.y - 1, stand.z);
  const footingNow = bot.blockAt(footingCell);
  const footingSolid = !!(footingNow && footingNow.boundingBox === 'block');
  if (footingSolid) {
    await stepHorizontal(bot, -nb.dx, -nb.dz);
    await microCenter(bot);
  }
  return { handled: true, digOk, digFail, placeOk, placeFail, steppedBack: footingSolid };
}

// repairAtAnchor — the shared stationary dig-all/place-all routine. See file header for
// the full contract. Mirrors build_executor's proven innerBuildStationary loop exactly;
// the per-block mechanics (digOne/placeOne) and item policy (resolveItem/isOptional) are
// injected so mining and building share the control flow without merging their domains.
async function repairAtAnchor(bot, job, ops) {
  const { stand, steps, label } = job;
  const { digOne, placeOne, resolveItem, isOptional, stationTypes, tag } = ops;
  const maxPlaceAttempts = ops.maxPlaceAttempts || 3;

  let digOk = 0, digFail = 0, placeOk = 0, placeFail = 0, alreadyOk = 0;
  let cheatPlaced = 0, deferred = 0, underFeetOk = 0, materialShort = 0, skipped = 0;
  let placeMsTotal = 0, slowestPlaceMs = 0, slowestPlaceAt = null, slowPlaces = 0;
  const digFailPositions = [];
  const placeFailPositions = [];
  const deferReasons = {};
  // material_short is its OWN bucket, never folded into `deferred` — a REQUIRED block the bot doesn't
  // hold. A defer waits on a support a later pass places (retrying helps); a material short won't heal
  // by retrying (a fresh block won't appear), so the caller must RELEASE for resupply instead of
  // spinning the same doomed pass. Conflating the two masked build_executor's anchor-abandon guard and
  // let a dirt-out build spin until the strict judge killed it (Architect 2026-07-13, the halt this fixes).
  const shortMaterials = {};

  // Footing = the block the bot stands on (stand.y-1). When the blueprint REPLACES it (a place step
  // there, optionally paired with a dig step), doing that in the bulk pass drops the bot into the cell
  // and pillarSteps it back — the fall the caller wants gone. If ops.footingSidestep is set (build
  // opts in; mining does not, so its descent model is untouched), pull those steps OUT of the bulk
  // loops and handle them atomically via sidestepFooting AFTER the rest of the cell is built (the bot
  // keeps standing on the old footing meanwhile). Only a REPLACE (footingPlace present) is diverted; a
  // bare footing dig with no replacement stays in the bulk pass (genuine floor removal, left as-is).
  //
  // A BARE FOOTING DIG (dig with no replacement) IS ALSO DIVERTED, as of 2026-07-21 — it used to stay in
  // the bulk pass as "genuine floor removal, left as-is", which is the hole the Architect hit: the bot mined
  // the block it was standing on. Under the opt-in it is now stepped aside for like any other footing work,
  // and deferred if there is nowhere to step. Callers that legitimately dig their own floor — the mining
  // descent, locomotion's dig-down — simply never set `footingSidestep`, so their model is untouched; that
  // opt-in is what keeps this from becoming a global ban on digging downward (Law 16: one behaviour, chosen
  // by the caller that owns the domain, not a second dig pathway).
  const footingSidestep = !!ops.footingSidestep;
  const atFooting = (s) => s.place.x === stand.x && s.place.y === stand.y - 1 && s.place.z === stand.z;
  const footingPlace = footingSidestep ? (steps.find(s => s.action === 'place' && atFooting(s)) || null) : null;
  const footingDig   = footingSidestep ? (steps.find(s => s.action === 'dig' && atFooting(s)) || null) : null;
  const isFootingStep = (s) => footingSidestep && (footingPlace || footingDig) && atFooting(s);

  watcher.buffer.open(tag);
  await combatCheckpoint(bot, 'repair');

  async function ensureAtAnchor() {
    const feet = bot.entity.position.floored();
    // Stand DIRECTLY on the anchor — the exact stand cell (anchor block Y+1), never a block off.
    // Reach here is measured deterministically from the microCentered stand block, so even a
    // 1-block offset puts the far voxels of a cell-sized volume out of reach (Architect: "it cant
    // reach everything if its a block off"). goTo exact-mode lands the FEET on the cell rather than
    // within 1.5, so once arrived feet === stand and this skips goTo on every later phase of the
    // pass — it never re-issues an identical goTo (the thing that tripped the strict locomotion
    // guard back when goTo could only arrive within tolerance and the offset persisted). A genuine
    // can't-stay-on-the-anchor loop DOES re-fire goTo and is still correctly caught as a stall.
    if (feet.x !== stand.x || feet.y !== stand.y || feet.z !== stand.z) {
      await locomotion.goTo({ x: stand.x, y: stand.y, z: stand.z, exact: true });
    }
    await microCenter(bot);
  }
  // ── Dig ALL (top-down). Cheat-dig: reach-distance gate only, no LOS — the server
  // accepts breaking an occluded block (proven by shaft mining). Reach is asserted from the
  // microCentered stand block (deterministic): an unreachable dig target is a coverage fault
  // → Law 13 throw (assertReachable), never a soft skip that would leave rock in the walkway.
  await ensureAtAnchor();
  const digSteps = steps.filter(s => s.action === 'dig' && !isFootingStep(s)).sort((a, b) => b.place.y - a.place.y);
  for (const s of digSteps) {
    const pos = new Vec3(s.place.x, s.place.y, s.place.z);
    const reach = assertReachable(bot, stand, pos, 'dig', label);
    await combatCheckpoint(bot, 'repair');
    const had = bot.blockAt(pos);
    watcher.buffer.record(tag, `dig (${pos.x},${pos.y},${pos.z}) ${had?.name || '?'} reach=${reach.toFixed(2)} (want ${normalizeBlockName(s.type)})`);
    if (await digOne(s)) { digOk++; watcher.buffer.record(tag, `  → cleared`); }
    else { digFail++; digFailPositions.push(`(${pos.x},${pos.y},${pos.z})`); watcher.buffer.record(tag, `  → FAILED`); watcher.warn(tag, `Dig failed at (${pos.x},${pos.y},${pos.z}) type=${s.type}`); }
  }
  const digFailStr = digFailPositions.length ? ` | failed: ${digFailPositions.join(' ')}` : '';
  watcher.summary(tag, `${label} dig: cleared ${digOk}, failed ${digFail} (of ${digSteps.length})${digFailStr}`);

  // ── Place ALL (bottom-up so each course has a placed reference below). findAttachable
  // picks a solid neighbour and bot.placeBlock(ref, face) places against it with no raycast
  // — the corner cheat is intrinsic here.
  await ensureAtAnchor();
  const placeSteps = steps.filter(s => s.action === 'place' && !isFootingStep(s)).sort((a, b) => a.place.y - b.place.y);
  for (const s of placeSteps) {
    await combatCheckpoint(bot, 'repair');
    const dt = normalizeBlockName(s.type);
    const pos = new Vec3(s.place.x, s.place.y, s.place.z);
    // Deterministic reach gate (Law 13): unreachable from the microCentered stand = coverage
    // fault → throw. A footing block (at/under the stand) is always within reach, so this never
    // fires on the under-feet path; only a genuinely too-far voxel trips it.
    assertReachable(bot, stand, pos, 'place', label);

    let outcome = null;        // 'ok' | 'already' | 'skipped' | 'defer' | 'fail'
    let lastReason = null;
    let wasUnderFeet = false, wasCorner = false;

    for (let attempt = 1; attempt <= maxPlaceAttempts; attempt++) {
      const ev = evaluatePlacement(bot, s, stand);

      if (!ev.ok) {
        lastReason = ev.reason || '?';
        // out_of_range on a stationary cell-sized build almost always means the bot drifted
        // or fell one block off the anchor — re-anchor and retry before deferring.
        // no_attach_point/too_close are genuine "wait for a neighbour" defers.
        if (ev.reason === 'out_of_range' && attempt < maxPlaceAttempts) {
          watcher.buffer.record(tag, `out_of_range (${pos.x},${pos.y},${pos.z}) — re-anchoring (attempt ${attempt}/${maxPlaceAttempts})`);
          await ensureAtAnchor();
          continue;
        }
        outcome = 'defer';
        watcher.buffer.record(tag, `defer (${pos.x},${pos.y},${pos.z}) ${dt}: ${lastReason}${ev.neighbors ? ` [nbrs ${ev.neighbors}]` : ''}`);
        break;
      }

      // Runtime under-feet re-check: if the bot's body now occupies the target cell (it dug
      // its own footing/floor and fell into it since eval time), force the under-feet path —
      // a normal placeBlock here would time out. The executor's placeOne pillarSteps, which
      // settles the bot before placing.
      if (!ev.underFeet && botOccupiesCell(bot, pos)) {
        ev.underFeet = true;
        watcher.buffer.record(tag, `runtime under-feet: bot occupies (${pos.x},${pos.y},${pos.z}) → pillarStep`);
      }
      wasUnderFeet = ev.underFeet;
      wasCorner = isEnclosedCorner(bot, pos);

      // ── A STATION WITH NOTHING BUT STATIONS TO LEAN ON IS A DEFER, NOT A CRASH ────────────────────
      // This threw as a Law 13 coding violation until 2026-09-01, on the theory that only a bad
      // BLUEPRINT could produce a station whose every solid neighbour is another station. The first
      // live run after it was written disproved that outright, and the Architect called it from the
      // trace: *"it legitimatley made a placing mistake and didnt put a plank down then couldnt put a
      // furnace on top of it and then it crashed. thats an enviormental problem so remove that code 13
      // violation and let it retry."*
      //
      // He is right, and the reason is worth keeping because the same mistake is easy to make again:
      // **the check measured the WORLD and returned a verdict about the DESIGN.** The headframe authors
      // planks directly under that furnace — the blueprint is sound. What was missing was a block the
      // build had not laid yet, or had failed to lay, which is the definition of a transient. A halt
      // there converts one unplaced plank into a dead fleet, and it takes the whole run down with it
      // (Law 13's own line: environmental failure defers, only a contradiction throws).
      //
      // So it defers with the neighbour list on the record, joining the `no_attach_point` family, and
      // the build comes back to it once something non-station is standing beside it.
      if (stationTypes && stationTypes.has(dt)) {
        let hasNonStationNeighbor = false;
        const solidNeighbors = [];
        for (const { d } of ATTACH_DIRS) {
          const nb = bot.blockAt(pos.plus(d));
          if (nb && !isAir(nb.name)) {
            solidNeighbors.push(nb.name);
            if (!stationTypes.has(nb.name)) hasNonStationNeighbor = true;
          }
        }
        if (solidNeighbors.length > 0 && !hasNonStationNeighbor) {
          lastReason = `station_needs_non_station_face [${solidNeighbors.join(',')}]`;
          outcome = 'defer';
          watcher.buffer.record(tag, `defer (${pos.x},${pos.y},${pos.z}) ${dt}: ${lastReason} — waiting for a non-station neighbour`);
          break;
        }
      }

      if (!resolveItem(dt)) {
        if (isOptional(dt)) { outcome = 'skipped'; break; }
        // REQUIRED block not held. Its own outcome (not a defer): a fresh unit won't appear on retry, so
        // the caller releases for resupply rather than re-running the pass. Recorded to the buffer, not
        // warned — with the pool model a required-short mid-build (dual-role dirt burned pillaring) is an
        // expected transient the supply loop refills, not a gate failure. build_executor warns once on release.
        lastReason = 'material_short';
        watcher.buffer.record(tag, `material_short (${pos.x},${pos.y},${pos.z}) ${dt}: required block not in inventory`);
        outcome = 'material_short'; break;
      }

      const cls = wasUnderFeet ? 'footing/pillar' : (wasCorner ? 'corner-cheat' : 'normal');
      const refStr = ev.anchor ? `${ev.anchor.name}@(${ev.anchor.position.x},${ev.anchor.position.y},${ev.anchor.position.z}) face(${ev.face.x},${ev.face.y},${ev.face.z})` : 'n/a';
      watcher.buffer.record(tag, `place (${pos.x},${pos.y},${pos.z}) ${dt} [${cls}] ref=${refStr} attempt ${attempt}/${maxPlaceAttempts}`);
      const tPlace = Date.now();
      const result = await placeOne(s, ev);
      // Per-step wall clock. placeOne's cost is bounded by its own dig+placeBlock, so a step running
      // for seconds means the underlying dig is being penalised (server-side dig speed: head-in-water
      // and off-ground each multiply dig time 5x, 25x together) — invisible before, because every
      // record in this loop is buffered and a clean run never dumps the buffer. A whole phase could
      // burn minutes and report only "placed 19, failed 0" (observed live: 19 places / 5m10s of
      // total silence, farm anchor 0, 2026-07-15). Track the worst offender and the total so the
      // phase summary can never again hide its own duration (Law 5/6).
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
      // An under-feet placement pillared the bot up one block — return to the anchor stand
      // position so remaining steps measure reach correctly (never keep building displaced).
      if (wasUnderFeet) { underFeetOk++; await ensureAtAnchor(); }
      watcher.buffer.record(tag, `  → placed${wasCorner ? ' (corner cheat)' : ''}${wasUnderFeet ? ' (footing pillar)' : ''}`);
    } else if (outcome === 'already') {
      alreadyOk++; watcher.buffer.record(tag, `  → already correct`);
    } else if (outcome === 'skipped') {
      // An optional step whose material is not held. A first-class terminal outcome, NOT a no-op: the
      // caller needs a nonzero count to tell "skipped an optional" from "did nothing", else an
      // optional-only anchor loops zero-progress into a portable_judge strict-kill. Distinct from
      // material_short (required → resupply): an optional is provisioned independently and never gates.
      // UNREACHABLE while OPTIONAL_BUILD_MATERIALS is empty — kept because the branch is what makes the
      // set's emptiness a policy the config owns rather than a shape this file cannot express.
      skipped++; watcher.buffer.record(tag, `  → skipped (optional, not in inventory)`);
    } else if (outcome === 'material_short') {
      materialShort++;
      shortMaterials[dt] = (shortMaterials[dt] || 0) + 1;
      watcher.buffer.record(tag, `  → material short`);
    } else if (outcome === 'defer') {
      deferReasons[lastReason || '?'] = (deferReasons[lastReason || '?'] || 0) + 1;
      deferred++;
    } else {
      placeFail++; placeFailPositions.push(`(${pos.x},${pos.y},${pos.z})${dt}`);
      watcher.buffer.record(tag, `  → FAILED`);
    }
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
      // No neighbor to stand on right now — DEFER rather than fall. A later pass (more of the cell
      // built) usually opens a neighbor; if never, the anchor's stuck logic takes over.
      deferred++;
      deferReasons['footing_no_sidestep'] = (deferReasons['footing_no_sidestep'] || 0) + 1;
      await ensureAtAnchor();
      watcher.buffer.record(tag, `footing (${fp.x},${fp.y},${fp.z}) deferred — no standable neighbor to sidestep to (avoids the drop)`);
    }
  }

  const cheatStr = cheatPlaced > 0 ? ` (${cheatPlaced} corner cheat-placed)` : '';
  const footStr = underFeetOk > 0 ? `, footing ${underFeetOk}` : '';
  const deferStr = Object.keys(deferReasons).length ? ` | deferred: ${Object.entries(deferReasons).map(([r, c]) => `${c}×${r}`).join(', ')}` : '';
  const shortStr = materialShort > 0 ? ` | material_short: ${Object.entries(shortMaterials).map(([m, c]) => `${c}×${m}`).join(', ')}` : '';
  const failStr = placeFailPositions.length ? ` | failed: ${placeFailPositions.join(' ')}` : '';
  const timeStr = ` | ${(placeMsTotal / 1000).toFixed(1)}s`;
  const slowStr = slowPlaces > 0
    ? ` (${slowPlaces} slow ≥${SLOW_PLACE_MS / 1000}s, worst ${(slowestPlaceMs / 1000).toFixed(1)}s ${slowestPlaceAt})`
    : '';
  watcher.summary(tag, `${label} place: placed ${placeOk}${cheatStr}${footStr}, failed ${placeFail}, already ${alreadyOk}, deferred ${deferred} (of ${placeSteps.length})${timeStr}${slowStr}${deferStr}${shortStr}${failStr}`);
  // A phase that spent most of its wall clock inside slow steps is degraded even though every step
  // "succeeded" — the failure mode has no failure count, so it must warn on duration or stay invisible.
  if (slowPlaces > 0 && placeMsTotal >= SLOW_PLACE_MS * 2) {
    watcher.warn(tag, `${label} place ran ${(placeMsTotal / 1000).toFixed(1)}s for ${placeSteps.length} step(s) — ${slowPlaces} step(s) ≥${SLOW_PLACE_MS / 1000}s, worst ${(slowestPlaceMs / 1000).toFixed(1)}s at ${slowestPlaceAt}. Dig-speed penalty (head in water / off ground = 5x each, 25x together) or a stalled placeBlock.`);
  }

  return {
    dig_ok: digOk, dig_fail: digFail, place_ok: placeOk, place_fail: placeFail,
    already_ok: alreadyOk, deferred, cheat_placed: cheatPlaced, under_feet_ok: underFeetOk,
    material_short: materialShort, short_materials: shortMaterials, skipped,
    place_ms_total: placeMsTotal, slowest_place_ms: slowestPlaceMs, slow_places: slowPlaces,
    dig_fail_positions: digFailPositions, place_fail_positions: placeFailPositions, defer_reasons: deferReasons,
  };
}

module.exports = { repairAtAnchor, evaluatePlacement, findAttachable, describeNeighborhood, isEnclosedCorner, botOccupiesCell, reachFromStand, nearestFaceDist, resolveStandableAnchor, findStandableNeighbor, ATTACH_DIRS, isInteractable };
