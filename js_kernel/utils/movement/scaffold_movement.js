// module: movement/scaffold_movement — the moves that BUILD in order to travel.
// Pillar up, bridge a gap, place at the jump apex, fill a water column, drop to a base level. Split
// from the walking layer because these are the only movement verbs that CONSUME inventory and alter
// the world, which is a different failure surface entirely: a walk that fails leaves the world as it
// found it, and a pillar that fails leaves a half-tower and a lighter inventory.
//
// It sits above dig_authority and motion_primitives and is depended on by nobody in this folder —
// so a change here cannot reach the walker, which is exactly the isolation the split buys.

'use strict';

const Vec3 = require('vec3');
const { performPlace } = require('@utils/movement/place_authority');
const watcher = require('@kernel/watcher');
const { isFluid } = require('@utils/gravity_utils');
const { sleep, isNonFullBlock, isPunchThroughDebris, STATION_TYPES, group_to_item, BLOCK_REACH } = require('@utils/fragment_utils');
const { performDig } = require('@utils/movement/dig_authority');
const { jumpTap, microCenter, waitUntilSettled } = require('@utils/movement/motion_primitives');
const { BRIDGE_PREFS, pillarConfig } = require('@utils/movement/movement_config');
const { isNotSafeSurface } = require('@utils/movement/terrain_predicates');
const { guardExternal, guardExternalSync, withCleanup } = require('@utils/external_library_guard');

// ── SECTION 6: Vertical Movement ──

function selectPillarItem(bot, opts) {
  const items = (bot?.inventory?.items?.() || []).filter(i => i?.count > 0);
  if (!items.length) return null;
  if (opts?.candidateItemNames && Array.isArray(opts.candidateItemNames)) {
    for (const name of opts.candidateItemNames) {
      const found = items.find(it => it.name === name);
      if (found) return found;
    }
    return null;
  }
  if (typeof opts?.selectPredicate === 'function') {
    return items.find(opts.selectPredicate) || null;
  }
  for (const name of pillarConfig.defaultPriority) {
    const found = items.find(it => it.name === name);
    if (found) return found;
  }
  return null;
}
const APEX_RISE_EPS = 0.03;          // a real upward push, not tick noise (provisional, tuned live)
const APEX_POLL_MS = 20;

// The face point generic_place.js computes for this (referenceBlock, faceVector). Aiming HERE is what
// makes forceLook:'ignore' safe — the rotation already matches what the place would have looked at.
function apexAimPoint(referenceBlock, faceVector) {
  return referenceBlock.position.offset(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5);
}

// placeAtApex — place onto referenceBlock's face at the crest of each rise until the target cell holds
// a solid or the window elapses. `minRiseAboveY` gates on the body actually clearing the target cell,
// so a weak bob that never lifts high enough is a real "couldn't rise" miss rather than a block fired
// into the bot's own legs. Returns { placed, crests, reason, error }.
async function placeAtApex(bot, referenceBlock, faceVector, opts = {}) {
  // Hard throw, not a soft miss: _genericPlace is the mineflayer internal this whole helper is built
  // on (place_block.js uses the same one). If a version bump removes it, every apex place would
  // silently degrade to place_rejected and read as a physics problem — a coding violation wearing an
  // environmental failure's clothes (Law 13).
  if (typeof bot._genericPlace !== 'function') {
    throw new Error('[movement_utils] CODING VIOLATION: bot._genericPlace missing — mineflayer place internals changed.');
  }
  const timeoutMs = opts.timeoutMs || 1500;
  const minRiseAboveY = opts.minRiseAboveY ?? null;
  const aimPoint = apexAimPoint(referenceBlock, faceVector);
  const targetPos = referenceBlock.position.plus(faceVector);
  const settled = () => {
    const b = bot.blockAt(targetPos);
    return !!(b && b.boundingBox === 'block');
  };
  if (settled()) return { placed: true, crests: 0, reason: 'already_solid', error: null };

  let rose = false, crests = 0, lastErr = null, done = false;
  // Re-aim every tick BEFORE updatePosition sends this tick's rotation, so the forced look rides out
  // with the same packet as the apex position. Forced look returns without awaiting a slew.
  const onTick = () => { bot.lookAt(aimPoint, true).catch(() => {}); };
  const onMove = () => {
    if (done) return;
    if (settled()) { done = true; return; }
    const e = bot.entity;
    const vy = e?.velocity?.y ?? 0;
    if (vy > APEX_RISE_EPS) { rose = true; return; }              // confirmed a real upward push first
    if (!rose || vy > 0) return;
    if (minRiseAboveY != null && !(e?.position && e.position.y >= minRiseAboveY)) { rose = false; return; }
    rose = false;                                                 // one shot per crest; re-arm on the next rise
    crests++;
    // Fire-and-forget: awaiting here would reintroduce the latency this whole helper exists to remove.
    guardExternalSync('scaffold_movement', 'genericPlace at apex',
      () => bot._genericPlace(referenceBlock, faceVector, { forceLook: 'ignore', swingArm: 'right' }).catch(e2 => { lastErr = e2; }));
  };
  bot.on('physicsTick', onTick);
  bot.on('move', onMove);
  await withCleanup('scaffold_movement', 'apex place watch', async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !done && !settled()) await sleep(APEX_POLL_MS);
  }, () => {
    bot.removeListener('physicsTick', onTick);
    bot.removeListener('move', onMove);
  });
  const placed = settled();
  return { placed, crests, reason: placed ? undefined : (crests === 0 ? 'no_crest' : 'place_rejected'), error: lastErr };
}

// Retry budget for recoverable failures (mistimed jump, transient place miss, headroom hiccup).
// Baked into the utility, not the callers, so every user retries identically without duplication.
const PILLAR_MAX_ATTEMPTS = 3;

// pillarStep: rise one block by placing a support underfoot mid-jump; retries internally.
// Returns { success, reason, placedPosition, itemName, newY, oldY }.
async function pillarStep(bot, opts = {}) {
  if (!bot || !bot.entity || !bot.entity.position) return { success: false, reason: 'no_bot', placedPosition: null, itemName: null, newY: NaN, oldY: NaN };
  const maxAttempts = Math.max(1, opts.maxAttempts || PILLAR_MAX_ATTEMPTS);
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await _pillarAttempt(bot, opts);
    if (last.success) {
      if (attempt > 1) watcher.warn('scaffold_movement', `pillarStep recovered on attempt ${attempt}/${maxAttempts} (${last.itemName})`);
      return last;
    }
    // Deterministic failures a retry cannot fix — stop now and let the caller decide.
    if (last.reason === 'no_item' || last.reason === 'no_solid_support' || last.reason === 'equip_fail') return last;
    // Recoverable: retry. _pillarAttempt re-settles and re-centers at the top of every attempt,
    // so all that's needed here is a short delay between tries.
    if (attempt < maxAttempts) {
      watcher.warn('scaffold_movement', `pillarStep attempt ${attempt}/${maxAttempts} failed (${last.reason}) — retrying`);
      await sleep(150);
    }
  }
  // Exhausted every retry without rising — surface it loudly so a pillar stall is never silent.
  if (last && !last.success) {
    watcher.warn('scaffold_movement', `pillarStep timed out — failed after ${maxAttempts} attempt(s), last reason=${last.reason}`);
  }
  return last;
}

// bobbingInWater: a STABLE read of "the bot is in a water column", used instead of a lone
// bot.entity.isInWater sample — that flag flickers false at the top of a bob (the body momentarily
// clears the surface), and that stale-false is what drove the land settle gate into a `not_settled`
// failure in the live trace. The block at the feet or just below being fluid is stable across the
// whole bob cycle, so it is the honest signal.
function bobbingInWater(bot, feet) {
  const f = feet || bot.entity.position.floored();
  const at = bot.blockAt(new Vec3(f.x, f.y, f.z));
  const below = bot.blockAt(new Vec3(f.x, f.y - 1, f.z));
  if (isFluid(at && at.name) || isFluid(below && below.name)) return true;
  return !!(bot.entity && bot.entity.isInWater);
}

// fillWaterColumnBelow: while bobbing at the surface, raise a support column from the nearest solid
// WITHIN REACH below the feet up to feet-1, so the apex place-at-feet can stand the bot OUT of the
// water. The bot never sinks — survival stays intact; the "sink to pillar from any height" mode is
// deliberately deferred (Architect 2026-07-18). It reaches DOWN and places on the top face of the
// highest solid, one block per bob, walking the column upward. One block is almost never enough
// (water is usually 2–4 deep), which is the whole point. Reach-bounded: no solid within
// floor(BLOCK_REACH) below → 'too_deep' (a shallow riverbank fills; a deep channel needs the sink
// mode). Returns 'ready' (a solid now sits at feet-1) | 'too_deep'.
async function fillWaterColumnBelow(bot, item, opts = {}) {
  const maxDown = Math.max(1, Math.floor(BLOCK_REACH));   // ~4 blocks of downward reach
  const deadline = Date.now() + (opts.timeoutMs || 4500);
  const solid = (b) => !!(b && b.boundingBox !== 'empty' && !isFluid(b.name) && !STATION_TYPES.has(b.name));
  // Jump is held for the whole fill, not just the final stand-out. Two reasons, both about the apex:
  // it rides the body high so the lower cells are clear of the hitbox, and — the operative one — a
  // free-floating bob barely crosses APEX_RISE_EPS, so without the jump push there is often no crest
  // for placeAtApex to fire on at all. Released in the finally so an early return can't leave it stuck.
  bot.setControlState('jump', true);
  const early = await withCleanup('scaffold_movement', 'pillar fill', async () => {
    while (Date.now() < deadline) {
      const feet = bot.entity.position.floored();
      if (solid(bot.blockAt(new Vec3(feet.x, feet.y - 1, feet.z)))) return 'ready';   // support already at feet-1
      // Highest solid within reach below feet-1 → the column top to place the next block onto.
      let support = null;
      for (let d = 2; d <= maxDown; d++) {
        const b = bot.blockAt(new Vec3(feet.x, feet.y - d, feet.z));
        if (solid(b)) { support = b; break; }
      }
      if (!support) return 'too_deep';
      // Re-equip each loop: a bob can drop hand focus. microCenter is ours and bobbing rarely centres
      // exactly, which is a RESULT it reports, not a throw — so neither call is guarded.
      await guardExternal('scaffold_movement', `equip ${item.name}`, () => bot.equip(item, 'hand'));
      await microCenter(bot, { eps: 0.12 });
      // Same crest discipline as the stand-out place — this fill was the other half of the "timer
      // based or random" symptom (a bare sleep(140) loop firing placeBlock wherever the bob happened
      // to be). The body must clear the cell it is filling: target is support.y+1, so the feet must
      // sit at or above support.y+2.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await placeAtApex(bot, support, new Vec3(0, 1, 0), {
        timeoutMs: Math.min(remaining, 1200),
        minRiseAboveY: support.position.y + 2
      });
    }
  }, () => bot.setControlState('jump', false));
  if (early) return early;
  const f = bot.entity.position.floored();
  return solid(bot.blockAt(new Vec3(f.x, f.y - 1, f.z))) ? 'ready' : 'too_deep';
}

// One pillar attempt (no retry). pillarStep() wraps this in the retry loop above.
async function _pillarAttempt(bot, opts = {}) {
  const cfg = { ...pillarConfig, ...opts };
  // In water the body BOBS — it is never onGround, so waitUntilSettled (which requires onGround) would
  // spin to not_settled and pillaring could never run underwater at all. Bobbing IS the working state
  // here, and the vertical timing is handled by the apex loop below (place at the top of a bob), so the
  // land settle gate is skipped. Placing while bobbing is deliberately allowed (Architect 2026-07-18);
  // only DIGGING while bobbing is banned, enforced in performDig. A support block must still sit within
  // reach below the feet — deep water has none and falls through to no_solid_support (the honest "the
  // riverbank isn't shallow enough" outcome), which the caller escalates.
  const inWater = bobbingInWater(bot);
  if (!inWater) {
    // Gate 1 — don't start while moving/falling (see SETTLE_TIMEOUT_MS: the dominant stall).
    const settled = await waitUntilSettled(bot, opts);
    if (!settled) {
      const v = bot.entity?.velocity || { x: 0, y: 0, z: 0 };
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      watcher.warn('scaffold_movement', `pillarStep fail reason=not_settled — bot still moving (onGround=${bot.entity?.onGround} speed=${speed.toFixed(3)})`);
      const oldY0 = Math.floor((bot.entity?.position?.y) ?? NaN);
      return { success: false, reason: 'not_settled', placedPosition: null, itemName: null, newY: oldY0, oldY: oldY0 };
    }
  }
  // Gate 2 — center first: an off-center bot floors into a neighbour cell and pillars the wrong
  // column. This microCenter is for correct cell detection; the second one (pre-jump) is for
  // placement precision.
  await microCenter(bot, { eps: 0.08 });
  let startFeet = bot.entity.position.floored();
  let oldY = Math.floor(startFeet.y);
  let support = bot.blockAt(new Vec3(startFeet.x, startFeet.y - 1, startFeet.z));
  // Non-full blocks (stairs, slabs) can't reliably support the jump-place — dig them so the bot
  // settles onto a full block. Never dig stations: registered infrastructure with game state.
  if (support && isNonFullBlock(support.name) && !STATION_TYPES.has(support.name)
      && support.name !== 'air' && support.name !== 'cave_air' && support.name !== 'void_air') {
    if (!await performDig(bot, support.position, support, 'scaffold_movement')) {
      watcher.warn('scaffold_movement', `pillarStep pre-dig failed on ${support.name}`);
    }
    await sleep(200);
    startFeet = bot.entity.position.floored();
    oldY = Math.floor(startFeet.y);
    support = bot.blockAt(new Vec3(startFeet.x, startFeet.y - 1, startFeet.z));
  }
  // Water bob-pillar (Architect 2026-07-18): a bobbing bot with no solid at feet-1 first raises a
  // support column DOWN to the nearest solid within reach; the apex place-at-feet below then stands it
  // OUT of the water. One block is almost never enough (water is 2–4 deep) — fill as far as reach
  // allows, one block per bob, never sinking (survival intact; sink-to-any-depth is the deferred
  // mode). Too deep to reach a floor → no_solid_support, which pillarStep treats as terminal (no retry).
  if (inWater && !(support && support.boundingBox !== 'empty' && !STATION_TYPES.has(support.name))) {
    const fillItem = selectPillarItem(bot, opts);
    if (!fillItem) {
      watcher.warn('scaffold_movement', `pillarStep fail reason=no_item — no placeable block to fill water column`);
      return { success: false, reason: 'no_item', placedPosition: null, itemName: null, newY: oldY, oldY };
    }
    const filled = await fillWaterColumnBelow(bot, fillItem);
    if (filled !== 'ready') {
      watcher.warn('scaffold_movement', `pillarStep fail reason=no_solid_support — water deeper than reach (${Math.max(1, Math.floor(BLOCK_REACH))}) below feet at (${startFeet.x},${startFeet.y},${startFeet.z})`);
      return { success: false, reason: 'no_solid_support', placedPosition: null, itemName: fillItem.name, newY: oldY, oldY };
    }
    startFeet = bot.entity.position.floored();
    oldY = Math.floor(startFeet.y);
    support = bot.blockAt(new Vec3(startFeet.x, startFeet.y - 1, startFeet.z));
  }
  if (!support || support.boundingBox === 'empty' || STATION_TYPES.has(support.name)) {
    watcher.warn('scaffold_movement', `pillarStep fail reason=no_solid_support support=${support?.name || 'null'} at (${startFeet.x},${startFeet.y - 1},${startFeet.z})`);
    return { success: false, reason: 'no_solid_support', placedPosition: null, itemName: null, newY: oldY, oldY };
  }
  const item = selectPillarItem(bot, opts);
  if (!item) {
    watcher.warn('scaffold_movement', `pillarStep fail reason=no_item — no placeable block in inventory`);
    return { success: false, reason: 'no_item', placedPosition: null, itemName: null, newY: oldY, oldY };
  }
  // Feet-cell clear: a non-full block in the FEET cell (short_grass, fern, flower, snow layer…) is
  // exactly where the pillar block must place. A bot cannot place onto/through a non-full block, and
  // the placed-check below reads its name!=='air' as a phantom success — so the support never lands
  // and the bot never rises (the short_grass stall). Sweep ONLY the feet cell, and ONLY here, so the
  // headroom is untouched and wall torches (used heavily) are never mined. Stations excluded.
  //
  // TWO ARMS, and the second exists because the first is a hand-kept list (Architect 2026-08-03: "if its
  // something that gets destroyed in one punch like grass or flower or non wheat plant then add to the
  // primitive pillarstep a quick check and punch to get rid of it"). `wildflowers` shipped in 1.21 and is
  // the same kind of thing as `leaf_litter`, which IS named — so the sweep never fired and TessaBot burned
  // ~30 warnings failing to rise out of a flower patch (`place_fail … crests=1 apex=place_rejected
  // support=grass_block feet=wildflowers`: it jumped, it cleared the cell, and the server refused the
  // block because a flower was still standing in it). isPunchThroughDebris asks the BLOCK instead of the
  // list — empty collision box and hardness 0 — so the next decorative plant needs no edit here. Its own
  // keep-list spares light, crops and wiring; see fragment_utils.
  const feetBlock = bot.blockAt(new Vec3(startFeet.x, startFeet.y, startFeet.z));
  const feetIsListed = feetBlock && isNonFullBlock(feetBlock.name) && !STATION_TYPES.has(feetBlock.name)
      && feetBlock.name !== 'air' && feetBlock.name !== 'cave_air' && feetBlock.name !== 'void_air';
  if (feetIsListed || isPunchThroughDebris(feetBlock)) {
    if (!await performDig(bot, feetBlock.position, feetBlock, 'scaffold_movement')) {
      watcher.warn('scaffold_movement', `pillarStep feet-clear failed on ${feetBlock.name} at (${startFeet.x},${startFeet.y},${startFeet.z})`);
    }
    await sleep(100);
  }

  // Clear y+1/y+2 before jumping — room to rise and land. ONLY solid obstructions are dug; non-full
  // blocks overhead (torches especially) are deliberately left in place.
  for (const offY of [1, 2]) {
    const clearPos = new Vec3(startFeet.x, startFeet.y + offY, startFeet.z);
    const clearBlock = bot.blockAt(clearPos);
    if (clearBlock && clearBlock.boundingBox !== 'empty') {
      if (!await performDig(bot, clearBlock.position, clearBlock, 'scaffold_movement')) {
        watcher.warn('scaffold_movement', `pillarStep fail reason=headroom_blocked_y+${offY} block=${clearBlock.name} at (${clearPos.x},${clearPos.y},${clearPos.z})`);
        return { success: false, reason: `headroom_blocked_y+${offY}`, placedPosition: null, itemName: item.name, newY: oldY, oldY };
      }
      await sleep(150);
    }
  }
  const equipped = await guardExternal('scaffold_movement', `equip ${item.name}`, () => bot.equip(item, 'hand'));
  if (!equipped.ok) return { success: false, reason: 'equip_fail', error: equipped.reason, placedPosition: null, itemName: item.name, newY: oldY, oldY };
  // Re-center: placing under the feet needs precise alignment. microCenter is ours; a throw is a defect.
  await microCenter(bot, { eps: 0.08 });
  // Place the support at the APEX of the rise, not a fixed fraction of the jump hold. On land that is
  // the top of the jump; in water it is the top of a buoyancy bob (there is no onGround, so a fixed
  // timer never aligned — the old midPoint = jumpMs*0.55 guess). placeAtApex owns the whole crest →
  // packet path, including re-firing on the NEXT crest after a miss (Architect 2026-07-18: "if the
  // block isn't placed in that window, check if the bot moved up and retry immediately"); in water
  // several crests fall inside one hold, on land a miss falls through to pillarStep's outer retry loop.
  // The target-cell check lives inside it and tests boundingBox === 'block', not name !== 'air': the
  // feet cell in water holds a 'water' block, and a bare non-air test reads that as "already placed"
  // — the phantom that made the underwater stall silent. WATER THRESHOLDS ARE PROVISIONAL — tuned to
  // the live standard test.
  const clearOfCellY = startFeet.y + (inWater ? 0.22 : 0.42);   // feet must clear the cell before a block lands in it
  const holdMs = inWater
    ? Math.max(1600, (cfg.jumpHoldMs || pillarConfig.jumpHoldMs || 320) + 1300)   // room for several bobs
    : Math.max(360, cfg.jumpHoldMs || pillarConfig.jumpHoldMs || 320);
  bot.setControlState('jump', true);
  const apex = await placeAtApex(bot, support, new Vec3(0, 1, 0), { timeoutMs: holdMs, minRiseAboveY: clearOfCellY });
  bot.setControlState('jump', false);
  const placed = apex.placed;
  const placeErr = apex.error;
  const crests = apex.crests;
  await sleep(cfg.postJumpSettleMs || 120);
  const finalFeet = bot.entity.position.floored();
  const newY = Math.floor(finalFeet.y);
  const placedBlock = bot.blockAt(new Vec3(startFeet.x, startFeet.y, startFeet.z));
  // boundingBox === 'block', not name !== 'air': in water the feet cell reads 'water' (non-air) and
  // would certify a placed support that never landed — a false success flag (Law 25) that, paired with
  // the loop guard above, let the attempt report done while the bot never rose. Only a full solid here
  // is a real pillar block (water/plants are non-air but non-block).
  const blockPlaced = placedBlock && placedBlock.boundingBox === 'block';
  const heightGained = newY > oldY;
  const success = blockPlaced || heightGained;
  const reason = success ? undefined : (placed ? 'no_height_gain' : 'place_fail');
  if (!success && cfg.debug) {
    const supportNow = bot.blockAt(new Vec3(startFeet.x, startFeet.y - 1, startFeet.z));
    const feetNow = bot.blockAt(startFeet);
    // crests is the discriminator the old trace lacked: 0 crests = the body never rose clear of the
    // cell (a bob/headroom problem); crests>0 with no block = the server rejected every apex packet
    // (an aim/reach/timing problem). Without it, both read as a bare place_fail.
    watcher.warn('scaffold_movement', `pillarStep fail reason=${reason} item=${item.name} oldY=${oldY} newY=${newY} crests=${crests} apex=${apex.reason || 'placed'} support=${supportNow?.name || 'null'} feet=${feetNow?.name || 'null'} placeErr=${placeErr?.message || 'none'}`);
  }
  return { success, placedPosition: blockPlaced ? placedBlock.position.clone() : null, itemName: item.name, reason, newY, oldY };
}

// (tryControlledDescent removed 2026-07-14 — descent is now owned solely by locomotion's exact-goTo,
//  which digs straight down with the hardened dig_down/no-fall model. One descent authority, Law 16.)

async function tryPillarAscent(bot) {
  const feet = bot.entity.position.floored();
  // READ pillarConfig, do not re-derive it. This asked group_to_item the same question movement_config
  // already answers, which is a second route to one value (Law 16) and drifted the moment the pillar and
  // bridge orders stopped being the same list — this copy would still have been laying bridge material.
  const PILLAR_BLOCK_PREFS = pillarConfig.defaultPriority;
  for (const offY of [1, 2]) {
    const blkPos = new Vec3(feet.x, feet.y + offY, feet.z);
    const blk = bot.blockAt(blkPos);
    // performDig reports rather than throws, so the guards that stood over these digs could only fire on
    // a defect while the false return — the actual failure — went unread (Law 25).
    if (blk && blk.name !== 'air') {
      if (!await performDig(bot, blk.position, blk, 'scaffold_movement')) {
        watcher.warn('scaffold_movement', `ascent_head_clear_fail y+${offY} ${blk.name}`);
      }
      await sleep(100);
    }
  }
  const result = await pillarStep(bot, { candidateItemNames: PILLAR_BLOCK_PREFS, debug: true });
  if (result && result.success) {
    await sleep(80);
    return true;
  }
  watcher.warn('scaffold_movement', `pillar_ascent_fail reason=${result?.reason || 'unknown'}`);
  return false;
}

// ── SECTION 7: Horizontal Movement and Gap Bridging ──

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE VOXEL TRANSITION (Architect 2026-08-01)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// "so we have edges with no transitions then we need to add transitions and a state machine that
//  interpolates? but were not moving a humanoid body... its still deterministic button presses. you can
//  only press jump or not press jump... so we can smooth between the 2… so im thinking that we smooth
//  between voxels instead of transition between actions? right now we need to reach the center of the
//  voxel, then can do the next one. we need to add a voxel transition where it doesent need to reach the
//  exact center of every voxel and can prejump when the speed is correct?"
//
// HIS CORRECTION IS THE DESIGN, and it is worth stating because the animation-blending analogy leads
// somewhere wrong: there is nothing to interpolate. A control state is a boolean on a 50 ms tick, so the
// only thing a "transition" can mean here is WHEN the boolean flips relative to a boundary the body is
// about to cross. The smoothing is in the ARRIVAL PREDICATE, not in the actuator.
//
// So there are exactly two changes, and both are subtractions:
//   1. AN INTERMEDIATE CELL IS ARRIVED AT WHEN IT IS ENTERED, not when its centre is reached. The
//      centre requirement is what forces the body to bleed off speed into a cell it is only passing
//      through. The FINAL cell keeps the strict test — building, mining and placing all need the exact
//      stand cell, and relaxing that would break them silently.
//   2. THE JUMP FIRES BEFORE THE BOUNDARY, at a distance computed from the body's MEASURED horizontal
//      speed. Java's jump clears one block of rise about four ticks in, so the boundary has to be
//      v × ~0.2 s ahead: 0.86 blocks walking, 1.12 sprinting. Pressing jump on arrival — which is what
//      the per-cell movers do — means the rise happens after the body is already against the step.
//
// WHY IT IS ONE FUNCTION AND NOT A SECOND MOVER (Law 16): driveRun with a single cell and strictFinal
// is the old per-cell step exactly. The lookahead depth is a number, not a mode, so "careful walking"
// and "sprinting parkour" are the same code at two settings and cannot drift apart. Anything that wants
// the old behaviour asks for a run of one.
//
// WHAT THIS CANNOT PROVE ABOUT ITSELF: whether the body actually crosses the ground is a world
// transformation, not a decision — the bench cannot answer it and neither can this comment. The
// arithmetic below (which cell, when to press) is testable headless; the crossing needs the arena, and
// `runfleet move <from> <to>` is the harness for it.

// No jump constants here. They were a local pair (JUMP_RISE_TICKS = 4, distance = speed × 200 ms)
// carrying a false claim about which tick clears a block, and the third hand-derived copy of an arc
// nobody had written down (Law 16). calculators/jump_calculator owns it now.
async function tryBridgeStep(bot, dx, dz) {
  const items = bot.inventory?.items?.() || [];
  const item = BRIDGE_PREFS.map(name => items.find(i => i.name === name && i.count > 0)).find(Boolean) || null;
  if (!item) return { success: false, reason: 'no_blocks' };
  const feet = bot.entity.position.floored();
  const curSupportPos = new Vec3(feet.x, feet.y - 1, feet.z);
  const ref = bot.blockAt(curSupportPos);
  if (!ref || ref.boundingBox === 'empty') return { success: false, reason: 'no_ref_support' };
  const targetSupportPos = new Vec3(feet.x + dx, feet.y - 1, feet.z + dz);
  const targetSupport = bot.blockAt(targetSupportPos);
  if (targetSupport && targetSupport.boundingBox !== 'empty' && !isNotSafeSurface(targetSupport)) {
    return { success: true, already: true };
  }
  // microCenter is OURS — a throw from it is an Auren bug, and swallowing it here hid that forever
  // while bridging carried on off-center (r33). Let it surface (Law 13). The outer catch that used to
  // wrap this whole function and answer 'bridge_exception' put that swallow back a level up.
  // microCenter stays HERE and ahead of the place: the body must be on the block's centre line before it
  // reaches out, which is a property of THIS bridge step rather than of placing in general — and an
  // authority that moved a body would be doing a second verb (Law 0).
  await microCenter(bot, { eps: 0.08 });
  // The one place route (Law 16) owns equip, the spawn-protection gate, the combat checkpoint, the sneak
  // and its guaranteed release, the aim and the click. sneak: true rather than 'auto' — the crouch holds
  // the body on the block it bridges FROM, a fact about the move rather than about the anchor.
  //
  // A refused bridge is a fall rather than a wasted click, which is why refusing it before the body
  // commits to the step matters more here than anywhere else the same gate fires.
  const placed = await performPlace(bot, new Vec3(feet.x + dx, feet.y - 1, feet.z + dz), ref, new Vec3(dx, 0, dz), item.name, 'scaffold_movement', { sneak: true });
  return placed.ok ? { success: true } : { success: false, reason: placed.reason || 'place_fail' };
}

// stepHorizontal: move exactly one cardinal block — the caller owns direction and sequence.
// optFloorBlock: preferred item to lay as floor over a gap (e.g. a blueprint-aware block);
// falls back to bridge prefs if absent or not in inventory.
// ── SECTION 10: Multi-Block Navigation Helpers ──

async function verticalAdjustToBase(bot, baseFeetY) {
  let guard = 64;
  while (guard-- > 0) {
    const curY = Math.floor(bot.entity.position.y);
    if (curY === baseFeetY) return true;
    if (curY > baseFeetY) {
      const belowPos = bot.entity.position.floored().offset(0, -1, 0);
      const below = bot.blockAt(belowPos);
      if (below && below.name !== 'air') {
        await performDig(bot, below.position, below, 'scaffold_movement');
        await sleep(100);
      } else {
        await sleep(120);
      }
    } else {
      const beforeY = curY;
      await jumpTap(bot, 420);
      await sleep(140);
      if (Math.floor(bot.entity.position.y) <= beforeY) {
        const res = await pillarStep(bot, { debug: true });
        if (!res.success) return false;
        await sleep(120);
      }
    }
  }
  return Math.floor(bot.entity.position.y) === baseFeetY;
}

module.exports = {
  pillarStep,
  tryPillarAscent,
  tryBridgeStep,
  verticalAdjustToBase,
};
