// fragment: harvest_executor
// purpose: Signal-bus entry point for all surface gathering. Picks trees vs. blocks from the
// objective, scans via surface_filter, approaches via locomotion, then delegates to tree_feller
// (logs) or runs an in-place punch loop (everything else). Ground — dirt and grass — is punched under
// ground_shave's rule, a layer at a time from a claimed tile. Routes the result to recursive_judge.
// Locomotion abandonment on an unreachable target routes to recursive_judge (Law 15); scan and
// quantity shortfalls route as soft failures (Law 13).

const watcher = require('@kernel/watcher');
const { equipBestToolForBlock, hasLineOfSightToBlock, readTransposeOrigin,
        harvestKeepoutBoxes, isInsideBlueprintKeepout, group_to_item } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly, sharing its 500 ms process-wide
// clock with the dig and drive primitives.
const { combatCheckpoint } = require('@api/battle_stations');
const { performDig } = require('@utils/movement/dig_authority');
const { opensOntoWater } = require('@utils/pathfinding_utils');
const { collectNearby } = require('@api/drop_collector.js');
const treeFeller = require('@api/tree_feller');
const seedPicker = require('@api/seed_picker');
const groundShave = require('@api/ground_shave');
const { HEADFRAME_SAFE_RADIUS } = require('@thinking/architect_config');

// Chebyshev half-extent around every locked transpose_origin where opportunistic resource gathering
// is banned (building/tending stay allowed); separate from HEADFRAME_SAFE_RADIUS, which gates combat.
const HARVEST_KEEPOUT_RADIUS = 8;
// The scan targets gathered as GROUND: shaved a layer at a time from a claimed tile (ground_shave).
const SHAVED_GROUND = new Set(['dirt', 'grass_block']);
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const portableJudge = require('@kernel/portable_judge');
const Vec3 = require('vec3');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'harvest_executor';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PUNCH_CONFIG = {
  maxScanAttempts: 20,
  collectionPause: 300,
  hardLoopCap: 50,
  reach: 4.5,
  collectEveryNDigs: 5
};

// -- Drop-off after every gather ------------------------------------------
// Every gather ends at the headframe with its haul banked, on success or failure alike — a pocket
// haul is one death from being lost. No headframe yet -> skip, not fail (Law 13). dumpExcess owns
// WHAT is kept and its own locomotion abandonment (Law 15); this decides only WHEN (Law 16). Body
// lives in inventory_swapper.dropOffHaul, shared with craft_executor.

// â”€â”€ Routing helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The drop-off runs BEFORE routeToJudge, since routeToJudge dispatches and anything awaited after it
// races the judge's next dispatch. One attach point here covers all three gather paths (Law 16).
async function routeResult(payload, success, readable) {
  // abandoned: the drop-off already routed to the judge (Law 15); avoids routing a second time (Law 4).
  // A gather that took something has more to take from where the body stands, so the drop-off may wait
  // for a haul that fits the walk home; a gather that took nothing goes home with what it has.
  const drop = await require('@api/inventory_swapper').dropOffHaul(global.bot, { still_gathering: success });
  if (drop?.abandoned) return;
  // Real delivery clears the stall history, so concessions separated by progress never read as
  // consecutive (portable_judge's done() restarts the count).
  if (success) portableJudge.done(TAG);
  const capsule = payload.harvest_executor || (payload.harvest_executor = {});
  capsule.success = success;
  capsule.readable = readable;
  payload.readable = readable;
  routeToJudge(TAG, { ...payload });
}

// A DELIVERY ORDER ENDS AT ITS STATION. A gather for one that can take no more goes back to supply_manager
// marked `gather_dry`, which delivers whatever of the order the pocket holds. → true when it was handed back.
function handBackDelivery(payload, reason) {
  const hq = require('@kernel/corporate_headquarters');
  const magnet = hq.readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  if (!magnet || magnet.action !== 'deliver' || !magnet.station_id) return false;
  const capsule = payload.harvest_executor || (payload.harvest_executor = {});
  capsule.success = false;
  capsule.readable = `${TAG}: fail ${reason}`;
  routeSignal(TAG, 'supply_manager', { ...payload, executor: TAG, gather_dry: reason, readable: `${TAG}: ${reason} → supply_manager delivers what is held` });
  return true;
}

const TREE_MISS_CHANCES = 3;
const outward = require('@api/outward_sections');
const OUTWARD_WALK_LIMIT = 200;   // section walks one order may make; above the sections inside outward.MAX_RINGS

async function routeFail(payload, reason) {
  watcher.warn(TAG, reason);
  if (handBackDelivery(payload, reason)) return;
  return routeResult(payload, false, `${TAG}: fail ${reason}`);
}

// Concede to idle instead of soft-failing to the judge, when a harvest is futile from here (Law 13:
// no retry on a deterministic, zero-progress outcome). idle_park clears the magnet, moves the bot
// clear and arms the heartbeat for a peer or later relocation. Bounded by portable_judge, forgiving
// mode (Law 16); an escalation there has already routed to recursive_judge, so this must not route
// again (Law 4).
// ── A MATERIAL THE LOADED WORLD DOES NOT HOLD ────────────────────────────────────────────────────────
// A punch-path miss that the ring search (the whole loaded frontier) confirms is written in THIS body's
// memory, so its own assessor stops posting the material while the note is fresh. It expires on its
// own, since a body that moves loads new ground.
const ABSENT_FLAG = 'surface_absent';
const ABSENT_FOR_MS = 5 * 60 * 1000;
function markAbsent(item) {
  const hq = require('@kernel/corporate_headquarters');
  const notes = hq.readConfRoomFlag('exploration_confrence_room', ABSENT_FLAG, {}) || {};
  notes[item] = Date.now();
  hq.writeConfRoomFlag('exploration_confrence_room', ABSENT_FLAG, notes);
}
// absentNearby(item) — true while a fresh deep scan found none of it anywhere loaded.
function absentNearby(item) {
  const hq = require('@kernel/corporate_headquarters');
  const at = (hq.readConfRoomFlag('exploration_confrence_room', ABSENT_FLAG, {}) || {})[item];
  return Number.isFinite(at) && Date.now() - at < ABSENT_FOR_MS;
}

async function routeIdle(payload, reason) {
  if (handBackDelivery(payload, reason)) return;
  const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
  if (verdict === false) return;   // portable_judge routed â€” the loop is being broken upstream
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} â†’ idle_park` });
}

// -- Log source ladder ------------------------------------------------------
// When logs are needed: fell wild trees inside the base camera zone first, then outside it, decided
// fresh at harvest time from live world state (Invariant B). Three rungs, nearest first within each
// (Law 16 / Law 22 gate 2): open blueprint-site trees (assessors/shared.openTreeSites), wild trees
// inside the base canopy zone (no replant), then wild trees outside it. No headframe center yet ->
// rung 1 fells the nearest wild tree unscoped; rung 2 never runs. Returns the first fell, or the
// last rung's failure (carrying .position for the caller's spent-tree memory).
function _canopyCenter() {
  return readTransposeOrigin(require('@kernel/bot_mandate').homeBlueprint());   // the crew's alpha structure
}

async function fellLogLadder(bot, excludeTrees) {
  const center = _canopyCenter();
  const zone = (mode) => center ? { mode, center: { x: center.x, z: center.z }, radius: HEADFRAME_SAFE_RADIUS } : null;

  // Rung 0: every blueprint site that still has trees, before any wild one — a trunk there must come
  // down for the build anyway, so felling it here discharges two jobs in one trip. Reads the phase
  // latch (assessors/shared.openTreeSites) (Law 16); nearest site first.
  const sites = require('@thinking/assessors/shared').openTreeSites();
  if (sites.length) {
    const p = bot.entity?.position;
    const near = (s) => (p ? (s.centre.x - p.x) ** 2 + (s.centre.z - p.z) ** 2 : 0);
    for (const site of [...sites].sort((a, b) => near(a) - near(b))) {
      // canopyZone takes a centre and a Chebyshev radius; reach is the box's own extent, over-covering
      // a non-square footprint's short side (acceptable here — this rung only decides where to look first).
      const reach = Math.max(Math.abs(site.box.min_dx), site.box.max_dx,
                             Math.abs(site.box.min_dz), site.box.max_dz);
      const hit = await treeFeller.fell(bot, null, {
        excludeTrees, preferNear: site.centre,
        canopyZone: { mode: 'inside', center: { x: site.centre.x, z: site.centre.z }, radius: reach },
      });
      if (hit && hit.success) return hit;
    }
  }

  // Inside the base, clear from the headframe outward (preferNear=center) so the camera zone opens up
  // first; outside (rung 2) stays bot-nearest. No center yet -> preferNear null -> bot-nearest.
  //
  // Felling carries no species preference, same as canopy_clear_executor; downloaded_plan_registry
  // .siteWood() and set_wood_preference separately decide what a blueprint is built from (Law 16).
  const inside = await treeFeller.fell(bot, null, { excludeTrees, canopyZone: zone('inside'), preferNear: center });
  if (inside && inside.success) return inside;

  return await treeFeller.fell(bot, null, { excludeTrees, canopyZone: zone('outside') });
}

// â”€â”€ Punch-path helpers (from block_puncher) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function squaredDistance(a, origin) {
  return (a.x - origin.x) ** 2 + (a.y - origin.y) ** 2 + (a.z - origin.z) ** 2;
}

async function digBlock(bot, block, label) {
  const bestTool = await equipBestToolForBlock(bot, block, TAG);
  if (!bestTool) {
    await guardExternal(TAG, 'unequip hand', () => bot.unequip('hand'));
  }
  // Unguarded: performDig reports on the next line. equip:'none' keeps the hand
  // set above; performDig re-equipping would change what the block drops (Law 16).
  const dug = await performDig(bot, block.position, block, TAG, { equip: 'none' });
  if (!dug) {
    watcher.summary(TAG, `Not dug: ${label || block.name} at (${block.position.x},${block.position.y},${block.position.z}) — not counting it as gathered.`);
    return false;
  }
  watcher.summary(TAG, `Dug ${label || block.name}`);
  await sleep(100);
  return true;
}

// Maps a source-block name to the inventory item(s) it yields when different: stoneâ†’cobblestone,
// grass_blockâ†’dirt. Seeds are gathered by seed_picker, not this punch path (Law 16).
function getInventoryItemNamesForBlock(blockName) {
  const map = { stone: ['cobblestone'], grass_block: ['dirt'] };
  return map[blockName] || [blockName];
}

function countCollected(bot, targets) {
  const allTargetItems = targets.flatMap(getInventoryItemNamesForBlock);
  return bot.inventory.items()
    .filter(i => allTargetItems.includes(i.name))
    .reduce((sum, item) => sum + item.count, 0);
}

// â”€â”€ Punch path: scan, approach, dig in place â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function executePunchPath(bot, payload, requestedTargets, orderQuantity) {
  // Broaden rarely-exposed requests to the exposed block that yields the same item: cobblestone->stone,
  // dirt->grass_block+dirt. getInventoryItemNamesForBlock credits the yield back to the request.
  const scanTargets = requestedTargets.flatMap(t =>
    t === 'cobblestone' ? ['stone'] :
    t === 'dirt'        ? ['grass_block', 'dirt'] : [t]);
  // Keep-out: never gather inside the base. Owned here and handed to the scan as a parameter, since
  // the same scan node also serves mining/feller and building/tending must work inside the base.
  // Handed in as a parameter so a common block's budget cannot exhaust entirely inside the keep-out
  // (Law 25).
  const keepout = harvestKeepoutBoxes(HARVEST_KEEPOUT_RADIUS);
  // Ground is shaved a layer at a time from a tile this body holds (ground_shave); every other material
  // is punched where it stands.
  const ground = scanTargets.some(t => SHAVED_GROUND.has(t))
    ? groundShave.open(bot, { keepout, blocks: scanTargets }) : null;
  const surfaceFilter = require('@perception/surface_filter');
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const filter = {
    type: 'object_group_or_direct',
    targets: scanTargets,
    // A block with water beside or above it is one performDig refuses, so it is no candidate.
    exclude: pos => isInsideBlueprintKeepout(pos, keepout) || (ground !== null && !ground.offers(pos))
      || opensOntoWater(bot, pos.x, pos.y, pos.z),
  };

  let objectiveBlocks = null;   // set by the first ring that holds any of the material
  let startingCount = 0;
  let targetTotal = 0;
  let digAttempts = 0;
  let scanCycles = 0;
  let scanMsTotal = 0;   // cumulative melee-cube sweep time across all cycles â€” reported at completion
  let pickedUpTotal = 0; // drops swept mid-run + at completion
  // Cells whose dig did not take this errand, so a refused cell isn't re-picked as nearest each cycle.
  const failedHere = new Set();
  const scanRadius = 4;
  const done = () => objectiveBlocks !== null && countCollected(bot, objectiveBlocks) >= targetTotal;

  // The in-place punch loop of one visit: every block of the material within reach of where the body stands.
  const punchHere = async () => {
  let visitDigs = 0;
  let visitCycles = 0;
  while (!done() && visitDigs < PUNCH_CONFIG.maxScanAttempts) {
    await combatCheckpoint(bot, 'harvest');
    scanCycles++;
    if (++visitCycles >= PUNCH_CONFIG.hardLoopCap) {
      watcher.warn(TAG, `Hard loop cap ${PUNCH_CONFIG.hardLoopCap} reached; aborting.`);
      break;
    }

    // Scan a small cube around the bot for target blocks
    const scanOrigin = bot.entity.position.offset(0, 1.5, 0);
    const feet = bot.entity.position.floored();   // re-sensed each cycle; the underfoot cell moves with the bot
    const cubeStart = Date.now();
    const targets = [];
    for (let dx = -scanRadius; dx <= scanRadius; dx++) {
      for (let dy = -scanRadius; dy <= scanRadius; dy++) {
        for (let dz = -scanRadius; dz <= scanRadius; dz++) {
          const bx = Math.floor(scanOrigin.x) + dx, by = Math.floor(scanOrigin.y) + dy, bz = Math.floor(scanOrigin.z) + dz;
          const distSq = (bx + 0.5 - scanOrigin.x) ** 2 + (by + 0.5 - scanOrigin.y) ** 2 + (bz + 0.5 - scanOrigin.z) ** 2;
          if (distSq > scanRadius * scanRadius) continue;
          // Same keep-out as the district scan, since this loop finds targets by raw world read near
          // the bot.
          if (isInsideBlueprintKeepout({ x: bx, z: bz }, keepout)) continue;
          // Never the block underfoot; excluded here since this loop has no anchor/stand. Re-scanned
          // and picked up on a later cycle once the bot has moved off it.
          if (bx === feet.x && by === feet.y - 1 && bz === feet.z) continue;
          if (failedHere.has(`${bx},${by},${bz}`)) continue;
          // Ground: the layer the feet rest on and the ground above it, shaveable blocks only.
          if (ground && (by < feet.y - 1 || !ground.offers({ x: bx, y: by, z: bz }))) continue;
          const b = bot.blockAt(new Vec3(bx, by, bz));
          if (b && objectiveBlocks.includes(b.name) && !opensOntoWater(bot, bx, by, bz)) {
            targets.push({ x: bx, y: by, z: bz, type: b.name });
          }
        }
      }
    }
    scanMsTotal += Date.now() - cubeStart;

    if (targets.length === 0) {
      // The layer within reach is spent: a ground errand walks on to the next of it.
      if (ground && await ground.moveOn(failedHere)) continue;
      watcher.summary(TAG, 'No targets found in melee range — halting.');
      break;
    }

    const origin = bot.entity.position;
    let pool;
    if (ground) {
      // Highest first, so a rise is levelled before the layer under it is touched.
      pool = targets.sort((a, b) => (b.y - a.y) || (squaredDistance(a, origin) - squaredDistance(b, origin)));
    } else {
      // Nearest ring first, top-down inside the ring: every block in a 1-block ring is within a step of
      // the others, so top-down keeps terrain flat instead of carving spires. Prefer at-or-above feet.
      const ringOf = t => Math.floor(Math.sqrt(squaredDistance(t, origin)));
      const nearRingThenTopDown = (a, b) =>
        (ringOf(a) - ringOf(b)) || (b.y - a.y) || (squaredDistance(a, origin) - squaredDistance(b, origin));
      const aboveOrLevel = targets.filter(t => t.y >= origin.y);
      pool = aboveOrLevel.length > 0 ? aboveOrLevel : targets;
      pool.sort(nearRingThenTopDown);
    }
    const target = pool[0];
    const pos = new Vec3(target.x, target.y, target.z);
    // A block in a tile this body does not hold yet is dug once the tile is claimed.
    if (ground && !(await ground.hold(target.x, target.z))) {
      failedHere.add(`${target.x},${target.y},${target.z}`);
      continue;
    }

    // Obstruction clearing: if the bot's own head/feet block blocks LOS, dig it first
    if (!hasLineOfSightToBlock(bot, pos, PUNCH_CONFIG.reach)) {
      const feetPos = bot.entity.position.floored();
      const headPos = feetPos.offset(0, 1, 0);
      const headBlock = bot.blockAt(new Vec3(headPos.x, headPos.y, headPos.z));
      const headSolid = headBlock && headBlock.boundingBox !== 'empty' && headBlock.name !== 'air';
      const feetBlock = bot.blockAt(new Vec3(feetPos.x, feetPos.y, feetPos.z));
      const feetSolid = feetBlock && feetBlock.boundingBox !== 'empty' && feetBlock.name !== 'air';
      const obstructionPos = headSolid ? headPos : (feetSolid ? feetPos : null);
      if (obstructionPos) {
        const obstructionBlock = bot.blockAt(new Vec3(obstructionPos.x, obstructionPos.y, obstructionPos.z));
        if (obstructionBlock && obstructionBlock.name !== 'air') {
          // A refused obstruction leaves this target unreachable from here for the rest of the errand.
          if (!(await digBlock(bot, obstructionBlock, `obstruction ${obstructionBlock.name}`))) failedHere.add(`${target.x},${target.y},${target.z}`);
          continue;
        }
      }
    }

    // Only the aim is a boundary; everything under it is ours and reports. A refused aim skips this
    // target.
    if (!(await guardExternal(TAG, `lookAt harvest target (${pos.x},${pos.y},${pos.z})`, () => bot.lookAt(pos.offset(0.5, 0.5, 0.5)))).ok) {
      failedHere.add(`${target.x},${target.y},${target.z}`);
      continue;
    }
    {
      let block = bot.blockAt(pos);

      // If scanner gave an air cell, shift down to the solid support block. Ground never shifts: the
      // block under a shaveable one is the layer beneath.
      if (!ground && (!block || block.name === 'air')) {
        const belowPos = pos.offset(0, -1, 0);
        block = bot.blockAt(belowPos);
        if (block && objectiveBlocks.includes(block.name)) {
          watcher.summary(TAG, `Mapped air target to support at (${belowPos.x},${belowPos.y},${belowPos.z}) -> ${block.name}`);
        }
      }

      if (block && objectiveBlocks.includes(block.name)) {
        const dugOk = await digBlock(bot, block);
        if (dugOk) { digAttempts++; visitDigs++; }
        else failedHere.add(`${block.position.x},${block.position.y},${block.position.z}`);

        await sleep(PUNCH_CONFIG.collectionPause);

        // Sweep drops every N digs through collectNearby, which walks by the navigator: a drop that did
        // not land within pickup range is fetched on a planned route, never by pressing forward blind
        // toward a hole the dig just opened. The completion test counts inventory, so uncollected drops
        // read as un-dug (Law 25).
        if (digAttempts > 0 && digAttempts % PUNCH_CONFIG.collectEveryNDigs === 0) {
          const midRun = await collectNearby(bot);
          pickedUpTotal += midRun.picked_up;
          watcher.summary(TAG, `Mid-run collection pass after ${digAttempts} dig(s): ${midRun.picked_up} drop(s) collected`);
        }

        if (countCollected(bot, objectiveBlocks) >= targetTotal) break;
      } else {
        watcher.summary(TAG, `Target not present or not diggable:${block ? block.name : 'null'} at (${pos.x},${pos.y},${pos.z})`);
      }
    }
  }
  };

  // ── THE SEARCH: ONE RING, EVERY BLOCK OF IT, THEN THE NEXT ─────────────────────────────────────────
  // surface_filter's rings, 16 blocks wide, open outward from where the errand began — the tree search's
  // own rings. A ring's blocks are offered to the navigator whole; the body gathers where it arrives, and
  // what is left of the ring is offered again until the ring is spent or cannot be reached. Then the next
  // ring. The errand ends when the order is in the pocket or the last loaded ring has been through this.
  const rings = surfaceFilter.openRings(bot, filter);
  let material = null;     // a group scan commits to the one block its first ring holds most of
  let seen = 0;            // blocks of the material the rings held
  let visits = 0;          // arrivals
  let unreached = 0;       // blocks in a ring left because no route reached them
  let refusedTiles = null; // the last ground refusal, for the idle line
  let tileWorked = false;  // ground: one tile is one errand
  for (let ring = await rings.next(); ring; ring = (done() || tileWorked) ? null : await rings.next()) {
    let left = ring.objectives.filter(o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number'));
    if (!material) material = surfaceFilter.dominantMatch(left).resolved;
    if (!ground) left = left.filter(o => o.name === material);
    if (!left.length) continue;
    seen += left.length;
    if (objectiveBlocks === null) {
      // Ground takes every block of its scan: the layer under grass is dirt, and both yield the same item.
      objectiveBlocks = ground ? scanTargets : [material];
      startingCount = countCollected(bot, objectiveBlocks);
      targetTotal = startingCount + orderQuantity;
      watcher.summary(TAG, `Incremental gather: have ${startingCount}, need +${orderQuantity} -> target ${targetTotal}`);
    }
    while (left.length && !done()) {
      surfaceFilter.offer(bot, filter, left, material, `ring ${ring.index}, ${ring.inner}-${ring.outer} blocks out, ${left.length} offered`);
      if (ground) {
        // Ground is claimed by the tile before the walk, so two bodies never converge on one patch.
        const taken = await ground.claimAndReach(left);
        if (!taken.ok) { refusedTiles = taken; break; }
      } else {
        const approach = await dispatcher.goTo({ candidates_ref: 'surface_filter', candidates_count: left.length, candidates_kind: material });
        // arrived=false only after locomotion exhausts its retry budget: nothing left in this ring is reachable.
        if (!approach || !approach.arrived) { unreached += left.length; break; }
      }
      visits++;
      watcher.summary(TAG, `Arrived near '${material}' in ring ${ring.index} — beginning in-place gathering.`);
      await punchHere();
      // A ground tile is worked to its end through ground.moveOn, and that tile is the errand.
      if (ground) { tileWorked = true; break; }
      const at = bot.entity.position;
      const before = left.length;
      left = left.filter(o => {
        const p = o.position;
        if (failedHere.has(`${p.x},${p.y},${p.z}`) || squaredDistance(p, at) <= scanRadius * scanRadius) return false;
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
        return !!b && b.name === material;
      });
      if (left.length === before) break;
    }
  }
  const ringCost = rings.cost();
  watcher.summary(TAG, `ring_search material=${material || scanTargets.join('|')} rings=${ringCost.rings} sections=${ringCost.read} scan_ms=${ringCost.ms} `
    + `seen=${seen} visits=${visits} unreached=${unreached} got=${objectiveBlocks ? countCollected(bot, objectiveBlocks) - startingCount : 0} of=${orderQuantity}`);

  if (seen === 0) {
    // Every loaded ring was read and the keep-out applied inside the read, so an empty result is a real finding.
    for (const t of requestedTargets) markAbsent(t);
    return routeIdle(payload, `no '${scanTargets.join(', ')}' anywhere in the loaded world outside the `
      + `${HARVEST_KEEPOUT_RADIUS}b base keep-out — noted fleet-wide for ${ABSENT_FOR_MS / 60000} min`);
  }
  if (visits === 0) {
    return routeIdle(payload, refusedTiles
      ? `no ground tile taken in any ring — last ring: ${refusedTiles.tiles} tile(s) offered, ${refusedTiles.peerHeld} held by a peer, ${refusedTiles.unreachable} unreachable — deferring gather`
      : `${seen} '${material}' seen in ${ringCost.rings} ring(s), none reachable — deferring gather`);
  }

  const finalCount = countCollected(bot, objectiveBlocks);
  const capsule = payload.harvest_executor || (payload.harvest_executor = {});
  capsule.metrics = { dig_ok: digAttempts, scan_cycles: scanCycles, scan_ms: scanMsTotal, start: startingCount, target: targetTotal, end: finalCount, picked_up: pickedUpTotal };
  if (ground) capsule.metrics.ground_moves = ground.moves();

  // ── A short trip is a trip, not a failure ──────────────────────────────
  // targetTotal is an aspiration (supply_manager rounds gathers up to whole pledges); `full`, `short`
  // and `nothing` are distinguished and named (Law 25) — only `nothing` (no blocks moved) is a
  // failure. Whether the ORDER is finished is decided by supply_manager's Step 1 against `hold_goal`.
  if (finalCount > startingCount) {
    const dropResult = await collectNearby(bot);
    pickedUpTotal += dropResult.picked_up;
    capsule.metrics.picked_up = pickedUpTotal;
    watcher.summary(TAG, `drops: ${dropResult.picked_up} collected (${pickedUpTotal} across the run)`);
    capsule.drop_collector = dropResult;
    if (ground) ground.release();   // the digging is over; the tile opens before the walk home
    const short = finalCount < targetTotal;
    capsule.metrics.short = short;
    await routeResult(payload, true,
      `${TAG}: ${short ? 'short' : 'full'} collected ${finalCount}/${targetTotal} digs=${digAttempts} `
      + `in ${scanCycles} cycle(s), cube-scan ${scanMsTotal}ms`
      + (short ? ` — the district gave what it had; carrying ${finalCount - startingCount} forward` : ''));
  } else {
    if (ground) ground.release();
    await routeResult(payload, false, `${TAG}: fail collected_nothing ${finalCount}/${targetTotal} digs=${digAttempts} in ${scanCycles} cycle(s), cube-scan ${scanMsTotal}ms`);
  }
}

// â”€â”€ Main receive handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = {
  absentNearby,
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) return routeFail(payload, 'no_bot');

    const requestedTargets = [].concat(payload.objective || []).filter(Boolean);
    if (!requestedTargets.length) {
      throw new Error(`[${TAG}] CODING VIOLATION: payload.objective is missing or empty.`);
    }

    const orderQuantity = payload.quantity || 1;
    // A one-species log order is still a tree: the punch path would chip the reachable trunk base and
    // leave the rest hanging, so it routes to the tree path, which fells whole trees.
    const isLogs = /logs$/i.test(requestedTargets[0]) || (group_to_item.logs || []).includes(requestedTargets[0]);
    const isSeeds = requestedTargets[0] === 'wheat_seeds';

    if (isSeeds) {
      // â”€â”€ Seed path: delegate to seed_picker API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // wheat_seeds is a probabilistic drop from punching grass; seed_picker owns the
      // punch-many/collect/recount loop, not this generic block scan.
      // `banked` sums across the manager<->judge retry loop on the payload capsule; the pocket count
      // alone can repeat across real gains and read to recursive_judge as a stalled loop (Law 25).
      watcher.summary(TAG, `Seed path: picking ${orderQuantity}x wheat_seeds`);
      const result = await seedPicker.pick(bot, { quantity: orderQuantity });
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      capsule.collected = result?.collected ?? 0;
      capsule.total = result?.total ?? 0;
      capsule.banked = (capsule.banked || 0) + capsule.collected;
      if (!result || !result.success) {
        // No grass reachable and nothing gathered -> futile from here; parks here (Law 13).
        const futile = (result?.reason === 'no_grass' || result?.reason === 'unreachable') && capsule.collected === 0;
        if (futile) return routeIdle(payload, `no grass reachable (${result.reason}) â€” deferring seed gather`);
        return routeFail(payload, `seed_pick_short collected=${capsule.collected} banked=${capsule.banked} pocket=${capsule.total}`);
      }
      await routeResult(payload, true,
        `${TAG}: picked ${capsule.collected} wheat_seeds this pass, ${capsule.banked} banked on this order (pocket ${capsule.total})`);

    } else if (isLogs) {
      // â”€â”€ Tree path: delegate to tree_feller API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Spent-tree memory: a tree reached but not felled (bad stance) comes back with a position and
      // no mined blocks. `failed_trees` rides the payload capsule across the retry loop but resets on
      // a fresh job_board dispatch, giving it another shot once the world re-plans (Law 12).
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      let excludeTrees = Array.isArray(capsule.failed_trees) ? capsule.failed_trees : [];
      watcher.summary(TAG, `Tree path: gathering ${orderQuantity}x ${requestedTargets[0]}${excludeTrees.length ? ` (skipping ${excludeTrees.length} spent)` : ''}`);
      // Priority ladder (wild-inside â†’ farm â†’ wild-outside), not a bare nearest-tree fell â€” see fellLogLadder.
      // A TREE WITH NOTHING TO CUT AT ITS TRUNK IS PASSED AND THE NEXT ONE TRIED, TREE_MISS_CHANCES times in
      // one trip; the last miss is the trip's result.
      let result = await fellLogLadder(bot, excludeTrees);
      for (let miss = 1; result && !result.success && result.reason === 'no_blocks_mined' && result.position && miss < TREE_MISS_CHANCES; miss++) {
        const p = result.position;
        watcher.summary(TAG, `TREE_MISSED chance=${miss} of=${TREE_MISS_CHANCES} tree=(${p.x},${p.y},${p.z}) species=${result.species} — nothing to cut at the trunk; trying the next tree`);
        excludeTrees = [...excludeTrees, `tree:${p.x},${p.y},${p.z}`];
        capsule.failed_trees = excludeTrees;
        result = await fellLogLadder(bot, excludeTrees);
      }

      // NO TREE WHERE THE BODY STANDS: it walks to the middle of the next section still open for wood and
      // searches once from there, until a tree is felled or every section is counted out (outward_sections).
      const noTree = r => r && !r.success && (r.reason === 'no_trees_found' || r.reason === 'no_reachable_free_tree');
      for (let walks = 0; noTree(result); walks++) {
        const step = walks < OUTWARD_WALK_LIMIT ? await outward.advance(bot, 'wood') : { exhausted: true, reason: 'walk_limit' };
        if (step.exhausted) {
          for (const t of requestedTargets) markAbsent(t);
          watcher.warn(TAG, `WOOD_ABSENT ${requestedTargets.join(',')} reason=${step.reason} walks=${walks} — no section within ${outward.MAX_RINGS} rings of home is open for wood`);
          return routeIdle(payload, `no tree in any section within ${outward.MAX_RINGS} rings of home (${step.reason})`);
        }
        if (step.search) result = await fellLogLadder(bot, excludeTrees);
      }

      if (!result || !result.success) {
        if (result?.position && ['x', 'y', 'z'].every(k => typeof result.position[k] === 'number')) {
          const key = `tree:${result.position.x},${result.position.y},${result.position.z}`;
          if (!excludeTrees.includes(key)) capsule.failed_trees = [...excludeTrees, key];
        }
        // ── A peer holding every tree is a replan, not a failure ─────────────
        // all_trees_claimed is tree_feller's verdict that trunks are spoken for, not gone, so the body
        // parks to pick other work instead (Law 25) — twin of canopy_clear_executor's fell concede.
        if (result?.reason === 'all_trees_claimed') {
          return routeIdle(payload, 'every reachable tree is claimed by a peer — surplus here, replanning');
        }
        return routeFail(payload, result?.reason || 'fell_failed');
      }

      capsule.drop_collector = result.drops;

      // THE HARVEST ENDS WITH A REPLANT: a crew with a tree farm plants its primary sapling in the farm
      // cells near where it stands (sapling_planter owns who, where and how many).
      await require('@api/sapling_planter').plantAfterHarvest(bot);

      // Trunk-base coord keeps consecutive same-species/height fells from reading as a stalled loop (Law 12).
      const at = result.position ? ` @${result.position.x},${result.position.y},${result.position.z}` : '';
      await routeResult(payload, true, `${TAG}: felled ${result.species}${at}, mined ${result.minedCount}`);

    } else {
      // â”€â”€ Punch path: scan, approach, dig in place â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      watcher.summary(TAG, `Punch path: gathering ${orderQuantity}x ${requestedTargets[0]}`);
      await executePunchPath(bot, payload, requestedTargets, orderQuantity);
    }
  })
};
