// fragment: harvest_executor
// purpose: Single signal-bus entry point for all surface gathering. Determines
//          whether the target is trees or blocks, scans via surface_filter, approaches
//          via locomotion, then either delegates to tree_feller API (logs) or runs an
//          in-place punch loop (everything else). Routes result to recursive_judge.
//
// Replaces tree_harvester + block_puncher as separate fragments â€” one fragment,
// two gathering strategies selected by the objective type.
//
// FLOW:
//   supply_manager --> harvest_executor
//     if objective matches logs:
//       1. await tree_feller.fell(bot, null, { excludeTrees })   // no replant â€” felling is canopy-clearing
//       2. Route success/fail to recursive_judge
//     if objective is anything else:
//       1. surface_filter.scan() -> exposed-block candidates (Law 1 perception)
//       2. await locomotion.goTo({candidates_ref}) -> drive to nearest reachable
//       3. In-place punch loop: scan melee cube, dig closest, repeat until quantity met
//       4. Route success/fail to recursive_judge
//
// FAILURE/ABANDONMENT: if locomotion cannot reach any target, goTo abandons to
// recursive_judge (Law 15) and this invocation dies. Scan failures and quantity
// shortfalls route soft failures to recursive_judge (Law 13 environmental path).

const watcher = require('@kernel/watcher');
const { equipBestToolForBlock, hasLineOfSightToBlock, readBuildCenter,
        harvestKeepoutBoxes, isInsideBlueprintKeepout } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly. One process-wide 500 ms clock,
// shared with the dig and drive primitives that carry the same gate, plus the engaging/escaping bypass
// so combat's own arms cannot re-enter it. The whole reasoning is in its header; a call a primitive
// already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { performDig } = require('@utils/movement/dig_authority');
const { collectNearby } = require('@api/drop_collector.js');
const treeFeller = require('@api/tree_feller');
const seedPicker = require('@api/seed_picker');
const { HEADFRAME_SAFE_RADIUS, HARVEST_KEEPOUT_RADIUS } = require('@thinking/architect_config');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const portableJudge = require('@kernel/portable_judge');
const Vec3 = require('vec3');
const { guardExternal, withCleanup } = require('@utils/external_library_guard');

const TAG = 'harvest_executor';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PUNCH_CONFIG = {
  forwardTapDuration: 150,
  maxScanAttempts: 20,
  collectionPause: 300,
  hardLoopCap: 50,
  reach: 4.5,
  collectEveryNDigs: 5
};

// -- Drop-off after every gather ------------------------------------------
// EVERY gather request ends at the headframe with its haul in a chest, unconditionally. No worth
// calculation, no fullness threshold, no distance ramp -- those decided WHETHER to go, and the answer
// is now always yes. This applies to the GATHER paths only; mining prices its round trip against
// throughput instead, since a bot deep in a shaft surfacing for one item is a different trade.
//
// A pocket is the least safe place in the world to keep a material: a gather that ends far from home
// holding an unbanked haul is one death away from losing the whole trip, so the round trip is the
// cheaper side of that trade.
//
// SUCCESS AND FAILURE ALIKE. A short gather still put items in the pocket, and those are exactly what
// dies with the bot -- dropping off only on success would protect the runs that needed it least.
//
// NO HEADFRAME -> SKIP, not fail. Before the build spot is locked there is nowhere to put anything, and
// a gather during that window must still complete: this is an environmental absence, not a coding
// violation (Law 13).
//
// dumpExcess owns WHAT is kept (INVENTORY_WHITELIST, read from job_board) and its own locomotion
// abandonment (Law 15). This function decides only WHEN -- that separation is why nothing here reads a
// keep-list of its own (Law 16: one whitelist, one owner).
// The body lives in inventory_swapper.dropOffHaul, shared with craft_executor as a second caller: the
// headframe carve-out and the report are one decision, and a second copy of it is the redundancy Law 16
// refuses. Everything above still holds -- it is the WHY for THIS call site, which is why it stayed
// here rather than travelling with the body.

// â”€â”€ Routing helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ROUTING IS THE SEAM THE DROP-OFF HANGS ON, and it has to happen BEFORE routeToJudge rather than after:
// routeToJudge dispatches, so anything awaited past it races the judge's next dispatch. One attach point
// here covers all three gather paths (seed, tree, punch) â€” the alternative was three call sites of the
// same call, which is the redundancy Law 16 exists to refuse.
async function routeResult(payload, success, readable) {
  const signalBus = require('@kernel/signal_bus');
  // `abandoned` = the drop-off already routed a signal to the judge (Law 15), so this line is dead and
  // must not route a second one (Law 4). Returning here is the abandonment, not a swallowed error.
  const drop = await require('@api/inventory_swapper').dropOffHaul(global.bot);
  if (drop?.abandoned) return;
  // A harvest that actually delivered clears the stall history: the concessions before it were
  // separated by real progress, so they were never a loop. Without this, three futile gathers spread
  // across an hour of productive work would eventually add up to a false escalation â€” portable_judge
  // detects CONSECUTIVE identical summaries, and only done() marks where "consecutive" restarts.
  if (success) portableJudge.done(TAG);
  const capsule = payload.harvest_executor || (payload.harvest_executor = {});
  capsule.success = success;
  capsule.readable = readable;
  payload.readable = readable;
  routeToJudge(signalBus, TAG, { ...payload });
}

async function routeFail(payload, reason) {
  watcher.warn(TAG, reason);
  return routeResult(payload, false, `${TAG}: fail ${reason}`);
}

// Concede to idle instead of soft-failing to the judge. Used when a harvest is FUTILE from the bot's
// current location (nothing to gather, retrying here can only repeat) â€” re-dispatching the identical
// gather 5Ã— would trip the judge's false INFINITE-LOOP kill (Law 13: retry is not warranted when the
// outcome is deterministic and zero-progress). idle_park moves the bot clear and arms the 10s
// heartbeat, so a peer or a later relocation resolves the need. Clear the magnet first (this bot is
// no longer on the job), mirroring dispatcher._goIdle / recursive_judge's kill path.
//
// IT IS JUDGED, because conceding is exactly where the judge was removed. This path routes AROUND
// recursive_judge on purpose (see above), and Law 11 admits no loop without exactly one judge -- so
// bypassing the fleet judge means bringing a judge WITH it, not doing without. Without it, a bot stuck
// on the same unsatisfiable job would sit re-claimed every dispatcher cycle indefinitely, never moving
// and never escalating.
//
// portable_judge is the established detector for exactly this shape â€” an executor emitting an
// identical zero-progress summary across iterations â€” and is already how build_executor and
// mining_executor are bounded (Law 16: one stall detector, not a second one invented here).
// FORGIVING, not strict: the correct first response to "this gather is futile HERE" is a fresh plan
// cycle (go do one of the other jobs on the board), which is precisely forgiving mode; its own
// retry counter escalates to a strict kill if replanning keeps landing back here. So a repeat is
// bounded at 3 identical concessions, then bounded again â€” never unbounded.
//
// NOTE FOR THE NEXT READER, because the instinct is to put the guard in surface_filter: it cannot go
// there. A perception node makes no decisions and routes no signals (Law 1/Law 3) â€” it reports what
// is out there and has no idea whether its caller is looping. The loop belongs to this verb, so the
// judge belongs to this verb.
//
// Returns after checkpoint: when portable_judge escalates it has ALREADY routed to recursive_judge,
// so this must not also route to idle_park â€” two signals in one scope is a Law 4 violation.
async function routeIdle(payload, reason) {
  const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
  if (verdict === false) return;   // portable_judge routed â€” the loop is being broken upstream
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  const signalBus = require('@kernel/signal_bus');
  routeSignal(signalBus, TAG, 'idle_park', { readable: `${TAG}: ${reason} â†’ idle_park` });
}

// -- Log source ladder ------------------------------------------------------
// When logs are needed, fell wild trees INSIDE the base camera zone first, then OUTSIDE it. The whole
// priority ladder is HERE -- not scattered across job_board arbitration -- because it is one decision
// made afresh at harvest time from live world state (Invariant B), exactly the moment logs are needed.
// Two rungs, each reusing ONE existing pathway (Law 16 / Law 22 gate 2):
//   1. wild INSIDE the base canopy zone -- clearing base trees near the cameras is free value, so it is
//      the first place logs come from (and no replant keeps the base clearing permanently).
//   2. wild OUTSIDE the zone -- farther walk, last resort, never re-touches the cleared base.
// A cultivated tree-farm rung is deliberately absent: with wild trees abundant, no cultivated stand
// needs to exist to draw down.
// No headframe center located yet -> canopyZone is null and rung 1 fells the nearest wild tree unscoped
// (pre-base behavior, unchanged); rung 2 never runs because rung 1 already succeeded. Returns the first
// rung that fells a tree, else the last rung's failure (carrying .position for the caller's spent-tree
// memory).
function _canopyCenter() {
  return readBuildCenter('headframe');
}

async function fellLogLadder(bot, excludeTrees) {
  const center = _canopyCenter();
  const zone = (mode) => center ? { mode, center: { x: center.x, z: center.z }, radius: HEADFRAME_SAFE_RADIUS } : null;

  // Inside the base, clear from the headframe OUTWARD (preferNear=center) so the camera zone opens up
  // around the build first. Outside supply (rung 2) stays bot-nearest -- those trees are off-camera, so
  // the shortest walk wins there. No center yet -> preferNear null -> bot-nearest.
  //
  // preferWood on BOTH rungs: this ladder IS the construction verb -- it only ever runs because
  // something asked for logs -- so both rungs order by the preferred species before distance. It is an
  // ordering, not a filter: a rung that finds only other species still fells them.
  // canopy_clear_executor deliberately does NOT pass it, which is where the two verbs part -- clearing
  // mines every tree in the zone regardless of species, construction wants the abundant species first.
  const inside = await treeFeller.fell(bot, null, { excludeTrees, canopyZone: zone('inside'), preferNear: center, preferWood: true });
  if (inside && inside.success) return inside;

  return await treeFeller.fell(bot, null, { excludeTrees, canopyZone: zone('outside'), preferWood: true });
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
  // Unguarded: performDig REPORTS, and its report is read on the very next line — the catch could only
  // fire on a defect, and it answered with the same `false` a refused dig uses, so the two were
  // indistinguishable in the census.
  //
  // equip:'none' — the hand was set above (best tool, or deliberately BARE when no tool fits);
  // letting performDig re-equip would change what the block drops (Law 16: one dig route, but the
  // hand policy stays with the caller that owns the drop).
  const dug = await performDig(bot, block.position, block, TAG, { equip: 'none' });
  if (!dug) {
    watcher.warn(TAG, `Dig did not take on ${label || block.name} at (${block.position.x},${block.position.y},${block.position.z}) — break unaccepted; not counting it as gathered.`);
    return false;
  }
  watcher.summary(TAG, `Dug ${label || block.name}`);
  await sleep(100);
  return true;
}

// Some blocks yield a different item than their own name: stoneâ†’cobblestone, grass_blockâ†’dirt (dug
// without silk touch). Map a source-block name to the inventory item(s) it yields; identity for
// everything else. (Seeds are gathered by seed_picker, not this punch path â€” Law 16.)
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

// DELETED 2026-08-15: `randomQuarterTurnAndNudge(bot)` — an unstick that turned a random quarter and
// pressed forward 120 ms. No caller. Beyond being dead, it was the wrong shape for this species: a random
// heading is manufactured human variance, and unsticking is a sensed question with a deterministic answer
// (Law 19 — the Inefficient Mimic). A real unstick reads the ground and picks a cell.

// â”€â”€ Punch path: scan, approach, dig in place â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function executePunchPath(bot, payload, requestedTargets, orderQuantity) {
  // Some requested blocks are rarely exposed on the surface â€” broaden to the exposed block that yields
  // the same item: cobblestoneâ†’stone, dirtâ†’grass_block (the grassy surface block drops dirt when dug;
  // exposed dirt is kept too). getInventoryItemNamesForBlock credits the yield back to the request.
  const scanTargets = requestedTargets.flatMap(t =>
    t === 'cobblestone' ? ['stone'] :
    t === 'dirt'        ? ['grass_block', 'dirt'] : [t]);
  // KEEP-OUT: never gather inside the base. The ban is on this VERB, not on perception (the same scan
  // node serves mining and the feller, and building/tending must still work inside the base) -- so the
  // RULE is owned here and handed to the scan as a parameter, rather than being built into the node.
  //
  // IT IS HANDED IN, NOT APPLIED AFTERWARD, and that ordering is the whole fix. Filtering the RESULT
  // would be a guaranteed empty answer: findBlocks spends its 100-block budget on the NEAREST matches,
  // and for a common block like grass that budget can exhaust within a few blocks -- entirely inside a
  // keep-out centred on the bot, so every candidate the scan could return would already be banned.
  // Asking the scan to skip these cells instead makes it walk outward until it has 100 blocks this verb
  // can actually harvest (Law 25: the answer now matches the question asked).
  const keepout = harvestKeepoutBoxes(HARVEST_KEEPOUT_RADIUS);
  const surfaceFilter = require('@perception/surface_filter');
  // Unguarded: the surface filter is ours. `scan_error` routed a harvest that found nothing, which the
  // judge treats as a depleted area rather than a broken sensor (Law 13).
  const scanResult = surfaceFilter.scan(bot, {
    type: 'object_group_or_direct',
    targets: scanTargets,
    exclude: pos => isInsideBlueprintKeepout(pos, keepout),
    // ENOUGH: this verb needs a HANDFUL OF REACHABLE CANDIDATES, not a survey — the set exists so the
    // locomotion ladder has alternatives when the nearest one turns out to be unreachable, and three
    // alternatives buy essentially all of that. Saying so is worth ~10 SECONDS PER SCAN, measured on
    // the live server 2026-09-04: the scan's rings cost 48:~200ms, 112:~1.5s, 256:~10.5s, and the full
    // horizon bought exactly ONE extra tree (5 -> 6). Without this number the node falls back to its
    // survey default, pays the 10.5s ring every time, and — because this verb re-scans on a ~10s cadence
    // — becomes a permanently busy loop. That single line was most of the fleet's startup cost.
    //
    // IT BELONGS HERE, NOT IN THE NODE. `set_wood_preference` calls the same scan wanting a CENSUS
    // (it counts trunks per species to pick one), and an early stop would corrupt its answer. Only the
    // caller knows what enough means (Law 25 — the asker owns the criterion).
    enough: 3,
  });
  const candidates = (scanResult?.objectives || []).filter(
    o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number')
  );
  if (!candidates.length) {
    // With the keep-out applied INSIDE the query, an empty result is now a real finding â€” the district
    // holds none of this outside the base â€” rather than an artifact of where the budget ran out.
    watcher.warn(TAG, `No '${scanTargets.join(', ')}' found outside the ${HARVEST_KEEPOUT_RADIUS}b base keep-out within district scan.`);
    return routeFail(payload, `not_found_in_district ${scanTargets.join(',')}`);
  }
  watcher.summary(TAG, `Scanned surroundings: ${candidates.length} '${scanResult.summary.target}' candidate(s) found outside the ${HARVEST_KEEPOUT_RADIUS}b base keep-out.`);

  // Approach via locomotion â€” hand the whole candidate set to the ladder.
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const approach = await dispatcher.goTo({
    candidates_ref: 'surface_filter',
    candidates_count: candidates.length,
    candidates_kind: scanResult.summary.target
  });
  // goTo returns arrived=false only AFTER locomotion exhausts its retry budget on a deterministic
  // dead-end (locomotion_judge give_up) -- the candidates are unreachable FROM HERE, not transiently
  // blocked. Re-dispatching the identical scan+approach can only repeat it, and 5x identical trips the
  // recursive_judge's false INFINITE-LOOP kill -- the same shape as a bot marooned on a dug-out column
  // it cannot leave without bridging blocks it doesn't carry. Concede to idle like the seed path
  // (Law 13: no retry when the outcome is deterministic and zero-progress) so a peer or a later
  // relocation resolves the remaining need instead of the bot spinning into a halt.
  if (!approach || !approach.arrived) return routeIdle(payload, 'targets unreachable from here â€” deferring gather');
  watcher.summary(TAG, `Arrived near '${scanResult.summary.target}' â€” beginning in-place gathering.`);

  // In-place punch loop
  const objectiveBlocks = [scanResult.summary.target].filter(Boolean);
  const startingCount = countCollected(bot, objectiveBlocks);
  const targetTotal = startingCount + orderQuantity;
  let digAttempts = 0;
  let scanCycles = 0;
  let scanMsTotal = 0;   // cumulative melee-cube sweep time across all cycles â€” reported at completion
  let pickedUpTotal = 0; // drops swept mid-run + at completion

  watcher.summary(TAG, `Incremental gather: have ${startingCount}, need +${orderQuantity} -> target ${targetTotal}`);

  while (countCollected(bot, objectiveBlocks) < targetTotal && digAttempts < PUNCH_CONFIG.maxScanAttempts) {
    await combatCheckpoint(bot, 'harvest');
    scanCycles++;
    if (scanCycles >= PUNCH_CONFIG.hardLoopCap) {
      watcher.warn(TAG, `Hard loop cap ${PUNCH_CONFIG.hardLoopCap} reached; aborting.`);
      break;
    }

    // Scan a small cube around the bot for target blocks
    const scanRadius = 4;
    const scanOrigin = bot.entity.position.offset(0, 1.5, 0);
    const feet = bot.entity.position.floored();   // re-sensed each cycle; the underfoot cell moves with the bot
    const cubeStart = Date.now();
    let targets = [];
    for (let dx = -scanRadius; dx <= scanRadius; dx++) {
      for (let dy = -scanRadius; dy <= scanRadius; dy++) {
        for (let dz = -scanRadius; dz <= scanRadius; dz++) {
          const bx = Math.floor(scanOrigin.x) + dx, by = Math.floor(scanOrigin.y) + dy, bz = Math.floor(scanOrigin.z) + dz;
          const distSq = (bx + 0.5 - scanOrigin.x) ** 2 + (by + 0.5 - scanOrigin.y) ** 2 + (bz + 0.5 - scanOrigin.z) ** 2;
          if (distSq > scanRadius * scanRadius) continue;
          // The melee cube needs the SAME keep-out as the district scan: this loop finds its own targets
          // by raw world read, so a bot that walked to a legal candidate on the base's edge would happily
          // chew inward across the boundary from here. Two gates, one rule.
          if (isInsideBlueprintKeepout({ x: bx, z: bz }, keepout)) continue;
          // Never the block underfoot. The build/farm path gets this from anchored_repair's sidestep;
          // this loop has no anchor and no stand, so the cell is simply excluded -- it re-scans every
          // cycle from a re-sensed position, so a block skipped while standing on it is picked up on a
          // later cycle from beside it, at no cost.
          if (bx === feet.x && by === feet.y - 1 && bz === feet.z) continue;
          const b = bot.blockAt(new Vec3(bx, by, bz));
          if (b && objectiveBlocks.includes(b.name)) {
            targets.push({ x: bx, y: by, z: bz, type: b.name });
          }
        }
      }
    }
    scanMsTotal += Date.now() - cubeStart;

    if (targets.length === 0) {
      watcher.warn(TAG, 'No targets found in melee range â€” halting.');
      break;
    }

    // Nearest ring first, top-down inside the ring.
    // Two criteria that would fight as a plain two-key sort are reconciled by quantizing distance into
    // 1-block rings: the bot finishes the work beside it before walking out, and WITHIN what it can
    // reach it still peels the highest block first. Raw distance as the primary key was rejected -- it
    // eats a column out from under the bot and leaves standing spires, the same unreachable-column shape
    // the goTo abandonment above guards against. Rings preserve that guarantee because every block in a
    // ring is within a step of every other, so top-down inside it keeps the local terrain flat. Still
    // prefer at-or-above feet; the below-feet fallback orders the same way for the same reason.
    const origin = bot.entity.position;
    const ringOf = t => Math.floor(Math.sqrt(squaredDistance(t, origin)));
    const nearRingThenTopDown = (a, b) =>
      (ringOf(a) - ringOf(b)) || (b.y - a.y) || (squaredDistance(a, origin) - squaredDistance(b, origin));
    const aboveOrLevel = targets.filter(t => t.y >= origin.y);
    const pool = aboveOrLevel.length > 0 ? aboveOrLevel : targets;
    pool.sort(nearRingThenTopDown);
    const target = pool[0];
    const pos = new Vec3(target.x, target.y, target.z);

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
          await digBlock(bot, obstructionBlock, `obstruction ${obstructionBlock.name}`);
          continue;
        }
      }
    }

    // Only the aim is a boundary; everything under it is ours and reports. A refused aim skips this
    // target rather than digging at whatever the body happened to be facing.
    if (!(await guardExternal(TAG, `lookAt harvest target (${pos.x},${pos.y},${pos.z})`, () => bot.lookAt(pos.offset(0.5, 0.5, 0.5)))).ok) continue;
    {
      let block = bot.blockAt(pos);

      // If scanner gave an air cell, shift down to the solid support block
      if (!block || block.name === 'air') {
        const belowPos = pos.offset(0, -1, 0);
        block = bot.blockAt(belowPos);
        if (block && objectiveBlocks.includes(block.name)) {
          watcher.summary(TAG, `Mapped air target to support at (${belowPos.x},${belowPos.y},${belowPos.z}) -> ${block.name}`);
        }
      }

      if (block && objectiveBlocks.includes(block.name)) {
        const dugOk = await digBlock(bot, block);
        if (dugOk) digAttempts++;

        bot.setControlState('forward', true);
        await sleep(PUNCH_CONFIG.forwardTapDuration);
        bot.setControlState('forward', false);

        await sleep(PUNCH_CONFIG.collectionPause);

        // Sweep drops every N digs, not only at the end. The forward tap above only picks up what
        // happens to land under the bot's own hitbox; the rest sits where it fell and the loop walks
        // away from it. Since the completion test counts INVENTORY, uncollected drops read as un-dug
        // blocks -- the bot keeps digging past the order and can exhaust maxScanAttempts while the
        // shortfall is lying on the ground behind it. Mid-run sweeps make the count reflect what was
        // actually gathered (Law 25: the verdict measures sensed reality).
        if (digAttempts > 0 && digAttempts % PUNCH_CONFIG.collectEveryNDigs === 0) {
          const midRun = await collectNearby(bot);
          pickedUpTotal += midRun.picked_up;
          watcher.summary(TAG, `Mid-run collection pass after ${digAttempts} dig(s): ${midRun.picked_up} drop(s) collected`);
        }

        if (countCollected(bot, objectiveBlocks) >= targetTotal) break;
      } else {
        watcher.warn(TAG, `Target not present or not diggable: ${block ? block.name : 'null'} at (${pos.x},${pos.y},${pos.z})`);
      }
    }
  }

  const finalCount = countCollected(bot, objectiveBlocks);
  const capsule = payload.harvest_executor || (payload.harvest_executor = {});
  capsule.metrics = { dig_ok: digAttempts, scan_cycles: scanCycles, scan_ms: scanMsTotal, start: startingCount, target: targetTotal, end: finalCount, picked_up: pickedUpTotal };

  if (finalCount >= targetTotal) {
    const dropResult = await collectNearby(bot);
    pickedUpTotal += dropResult.picked_up;
    capsule.metrics.picked_up = pickedUpTotal;
    watcher.summary(TAG, `drops: ${dropResult.picked_up} collected (${pickedUpTotal} across the run)`);
    capsule.drop_collector = dropResult;
    await routeResult(payload, true, `${TAG}: success collected ${finalCount}/${targetTotal} digs=${digAttempts} in ${scanCycles} cycle(s), cube-scan ${scanMsTotal}ms`);
  } else {
    await routeResult(payload, false, `${TAG}: fail not_enough ${finalCount}/${targetTotal} digs=${digAttempts} in ${scanCycles} cycle(s), cube-scan ${scanMsTotal}ms`);
  }
}

// â”€â”€ Main receive handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = {
  receive: watcher.track(TAG, async (signalType, payload = {}) => {
    if (signalType !== TAG) return;

    const bot = global.bot;
    if (!bot?.entity?.position) return routeFail(payload, 'no_bot');

    const requestedTargets = [].concat(payload.objective || []).filter(Boolean);
    if (!requestedTargets.length) {
      throw new Error(`[${TAG}] CODING VIOLATION: payload.objective is missing or empty.`);
    }

    const orderQuantity = payload.quantity || 1;
    const isLogs = /logs$/i.test(requestedTargets[0]);
    const isSeeds = requestedTargets[0] === 'wheat_seeds';

    if (isSeeds) {
      // â”€â”€ Seed path: delegate to seed_picker API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // wheat_seeds is a probabilistic drop from punching grass, not a block the generic
      // punch path can scan for â€” seed_picker owns the punch-many/collect/recount loop.
      //
      // THE READABLE CARRIES A CUMULATIVE COUNT, AND THE POCKET COUNT IS NOT IT. Ending the readable
      // with the POST-PICK INVENTORY count does not make consecutive picks non-identical: seeds are
      // deposited between dispatches, so pick 3 -> total 3 -> deposit -> pick 3 -> total 3 emits the
      // same bytes three times over three REAL gains, and recursive_judge reads a stalled loop and kills
      // a signal that was working. A count that resets cannot answer "did the gap shrink" -- which is
      // the only question the judge asks of this string (Law 25: true against the ASKER's criteria, and
      // the judge is the asker). `banked` sums across the manager<->judge retry loop on the payload
      // capsule, so it differs if and only if seeds were actually gained: real progress always reads as
      // progress, and a genuinely stalled pick (collected 0 each time) still emits identical bytes and
      // is still correctly killed.
      watcher.summary(TAG, `Seed path: picking ${orderQuantity}x wheat_seeds`);
      const result = await seedPicker.pick(bot, { quantity: orderQuantity });
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      capsule.collected = result?.collected ?? 0;
      capsule.total = result?.total ?? 0;
      capsule.banked = (capsule.banked || 0) + capsule.collected;
      if (!result || !result.success) {
        // No grass reachable AND nothing gathered -> futile from here (the bot is underground / in a
        // grassless district). Park instead of re-dispatching: an identical zero-progress gather 5x is
        // the same false-kill shape recursive_judge falls into on any stalled loop. A partial pick
        // (collected>0, reason 'short') still soft-fails normally so a later pass gathers the remainder.
        const futile = (result?.reason === 'no_grass' || result?.reason === 'unreachable') && capsule.collected === 0;
        if (futile) return routeIdle(payload, `no grass reachable (${result.reason}) â€” deferring seed gather`);
        return routeFail(payload, `seed_pick_short collected=${capsule.collected} banked=${capsule.banked} pocket=${capsule.total}`);
      }
      await routeResult(payload, true,
        `${TAG}: picked ${capsule.collected} wheat_seeds this pass, ${capsule.banked} banked on this order (pocket ${capsule.total})`);

    } else if (isLogs) {
      // â”€â”€ Tree path: delegate to tree_feller API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Spent-tree memory: a tree the bot reached but could NOT fell (it landed at a bad
      // stance -- an LOS vantage a few blocks short, or a block off in Y -- so the felling
      // scan never saw the trunk) comes back with a position and no mined blocks. Without
      // memory the next re-dispatch re-selects that same nearest trunk and stalls on it,
      // repeating a fell attempt that is deterministically doomed from that stance. The list
      // rides the payload capsule so it survives the manager<->judge retry loop but resets on
      // a fresh job_board dispatch (Law 12 -- a new chain re-plans from current world state,
      // giving a bad-stance tree another shot rather than banning it forever). No judge memory
      // needed.
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      const excludeTrees = Array.isArray(capsule.failed_trees) ? capsule.failed_trees : [];
      watcher.summary(TAG, `Tree path: gathering ${orderQuantity}x ${requestedTargets[0]}${excludeTrees.length ? ` (skipping ${excludeTrees.length} spent)` : ''}`);
      // Priority ladder (wild-inside â†’ farm â†’ wild-outside), not a bare nearest-tree fell â€” see fellLogLadder.
      const result = await fellLogLadder(bot, excludeTrees);

      if (!result || !result.success) {
        if (result?.position && ['x', 'y', 'z'].every(k => typeof result.position[k] === 'number')) {
          const key = `tree:${result.position.x},${result.position.y},${result.position.z}`;
          if (!excludeTrees.includes(key)) capsule.failed_trees = [...excludeTrees, key];
        }
        return routeFail(payload, result?.reason || 'fell_failed');
      }

      capsule.drop_collector = result.drops;

      // Include the trunk-base coord: consecutive fells of same species+height are otherwise
      // byte-identical readables, and the recursive_judge counts identical readables as a stalled
      // loop (Law 12) â€” five same-height trees in a row = false INFINITE LOOP kill. The base coord
      // makes each fell unique so genuine progress never reads as repetition.
      const at = result.position ? ` @${result.position.x},${result.position.y},${result.position.z}` : '';
      await routeResult(payload, true, `${TAG}: felled ${result.species}${at}, mined ${result.minedCount}`);

    } else {
      // â”€â”€ Punch path: scan, approach, dig in place â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      watcher.summary(TAG, `Punch path: gathering ${orderQuantity}x ${requestedTargets[0]}`);
      await executePunchPath(bot, payload, requestedTargets, orderQuantity);
    }
  })
};
