// fragment: harvest_executor
// purpose: Signal-bus entry point for all surface gathering. Picks trees vs. blocks from the
// objective, scans via surface_filter, approaches via locomotion, then delegates to tree_feller
// (logs) or runs an in-place punch loop (everything else). Ground — dirt and grass — is punched under
// ground_shave's rule, a layer at a time from a claimed tile. Routes the result to recursive_judge.
// Locomotion abandonment on an unreachable target routes to recursive_judge (Law 15); scan and
// quantity shortfalls route as soft failures (Law 13).

const watcher = require('@kernel/watcher');
const { equipBestToolForBlock, hasLineOfSightToBlock, readTransposeOrigin,
        harvestKeepoutBoxes, isInsideBlueprintKeepout, isNaturalGround, beyondGatherReach, group_to_item } = require('@utils/fragment_utils');
// Entered through combatCheckpoint, never battleStations directly, sharing its 500 ms process-wide
// clock with the dig and drive primitives.
const { combatCheckpoint } = require('@api/battle_stations');
const { performDig } = require('@utils/movement/dig_authority');
const { opensOntoWater } = require('@utils/pathfinding_utils');
const { collectNearby } = require('@api/drop_collector.js');
const treeFeller = require('@api/tree_feller');
const seedPicker = require('@api/seed_picker');
const groundShave = require('@api/ground_shave');

// Chebyshev reach past every sited footprint where gathering a plant is banned (building/tending stay allowed);
// natural ground keeps architect_config.GATHER_KEEPOUT instead. Separate from HEADFRAME_SAFE_RADIUS, which gates combat.
const HARVEST_KEEPOUT_RADIUS = 8;
const { GATHER_KEEPOUT } = require('@thinking/architect_config');
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
// ── THE LEAF PAIR IS BORROWED AND RETURNED ───────────────────────────────────────────────────────────────
// The fleet keeps LEAF_PAIRS pairs of shears for leaves and a pair for the pen (assessors/downloaded_build, ranching),
// all banked. A leaf cut holds one leaf seat per pair (claim `shears_seat:leaves:<i>`) for the whole cut, takes a pair
// from the chest, and puts it back before the cut routes its result: every way out of a gather runs through
// routeResult or routeIdle, so the pair goes back there, before anything is routed (the judge's next dispatch would
// race a later deposit). leafSeatsOpen is the same count read off the peers' claims, so the board offers a leaf
// order only to a body that can hold a pair (job_gates.toolGate, Law 16).
const LEAF_SEAT_PREFIX = 'shears_seat:leaves:';
const leafSeats = () => Array.from({ length: require('@thinking/architect_config').LEAF_PAIRS }, (_, i) => `${LEAF_SEAT_PREFIX}${i}`);
let _leafSeat = null;
const shearsHeld = bot => bot.inventory.items().filter(it => it.name === 'shears').reduce((n, it) => n + it.count, 0);
function leafSeatsOpen() {
  const peers = require('@kernel/foreman_link').peerClaimKeys();
  return leafSeats().filter(k => !peers.has(k)).length;
}
// borrowLeafShears(bot) → 'ok' | 'seats_held' (every leaf pair is out with a peer) | 'none_banked' | 'abandoned'
async function borrowLeafShears(bot) {
  const targetClaims = require('@utils/target_claims');
  const seat = (await targetClaims.claimFirst(leafSeats(), { keyOf: k => k })).key;
  if (!seat) return 'seats_held';
  if (shearsHeld(bot) === 0) {
    if (await require('@api/inventory_swapper').retrieveItems(bot, 'shears', 1) === undefined) { targetClaims.releaseTarget(seat); return 'abandoned'; }
    if (shearsHeld(bot) === 0) { targetClaims.releaseTarget(seat); return 'none_banked'; }
  }
  _leafSeat = seat;
  watcher.summary(TAG, `SHEARS borrowed for the leaf cut (${seat})`);
  return 'ok';
}
async function returnLeafShears(bot) {
  if (!_leafSeat) return;
  const seat = _leafSeat;
  _leafSeat = null;
  const n = shearsHeld(bot);
  const r = n ? await require('@api/inventory_swapper').depositItems(bot, 'shears', n) : null;
  if (n && !r) watcher.warn(TAG, `SHEARS the leaf pair could not be put back (${n} carried)`);
  else watcher.summary(TAG, `SHEARS returned after the leaf cut (${r ? r.transferred : 0}, ${seat})`);
  require('@utils/target_claims').releaseTarget(seat);
}

async function routeResult(payload, success, readable) {
  await returnLeafShears(global.bot);
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

// ── A FOREST RUN IS COUNTED IN PUNCHES ──────────────────────────────────────────────────────────────
// Compostables for the composter (assessors/compost, architect_config COMPOST_RUN_ITEM) are gathered in rounds: one round
// punches no more than COMPOST_PUNCH_MAX blocks. A walk is not counted, since reaching loaded ground can take a while.
// Past the gather reach of home the run stays out for further rounds while its trip owes work for its walk (STAY_OUT
// below); otherwise it delivers what it has and ends. Every other punch order runs to its order.
const COMPOST_PUNCH_MAX = 50;
function compostRun() {
  const magnet = require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet;
  return !!magnet && magnet.what === require('@thinking/architect_config').COMPOST_RUN_ITEM;
}
function punchCapOf() { return compostRun() ? COMPOST_PUNCH_MAX : Infinity; }

const TREE_MISS_CHANCES = 3;
const finder = require('@api/sector_finder');
const FINDER_LOOKS = 12;   // book sectors one trip looks from before it ends; each miss turns or passes a page

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
  await returnLeafShears(global.bot);
  if (handBackDelivery(payload, reason)) return;
  const verdict = await portableJudge.checkpoint(TAG, `idle: ${reason}`, 'forgiving');
  if (verdict === false) return;   // portable_judge routed â€” the loop is being broken upstream
  watcher.summary(TAG, reason);
  require('@thinking/dispatcher.js').clearMagnet();
  routeSignal(TAG, 'idle_park', { readable: `${TAG}: ${reason} â†’ idle_park` });
}

// -- Log source ladder ------------------------------------------------------
// When logs are needed, the tree felled is the one NEAREST THE YARD, whatever its species, decided fresh at
// harvest time from live world state (Invariant B). Two rungs: open blueprint-site trees first
// (assessors/shared.openTreeSites), which must come down for the build anyway, then the nearest tree to the
// crew's home structure. Felling nearest the yard clears the ground round the base as the wood is gathered, and
// only the build's two woods are replanted, one where each tree stood outside the keep-out (sapling_planter), so no
// clearing job is needed and the forest round the yard turns to the build's wood over time. An order is paid by the logs it names; the other species' logs
// are banked with them. No home sited yet -> the nearest tree to the body. Returns the first fell, or the last
// rung's failure (carrying .position for the caller's spent-tree memory).
function _yardCenter() {
  return readTransposeOrigin(require('@kernel/bot_mandate').homeBlueprint());   // the crew's alpha structure
}

// ── WHILE THE EXECUTOR HOLDS THE JOB ON ITS GROUND, A WALK IS WORK ─────────────────────────────────────────
// The walking share counts only the walk out to the ground and the walk home. A gather of this claim that already
// worked its ground (capsule.on_ground: a felled tree, a punched patch; it rides the payload across the claim's
// gathers and resets with a fresh dispatch), or a stay-out round past the first, walks on as the `work` leg.
const onGround = payload => !!payload.harvest_executor?.on_ground || payload.stay_out_round > 1;

// `species`: the log species the order names, or null for any log (tree_feller opts.species). `leg`: tree_feller opts.leg.
async function fellLogLadder(bot, excludeTrees, species = null, leg = undefined) {
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
        excludeTrees, species, leg, preferNear: site.centre,
        canopyZone: { mode: 'inside', center: { x: site.centre.x, z: site.centre.z }, radius: reach },
      });
      if (hit && hit.success) return hit;
    }
  }

  // Rung 1: the nearest tree to the yard.
  return await treeFeller.fell(bot, null, { excludeTrees, species, leg, preferNear: _yardCenter() });
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
  // A cocoa pod is the block `cocoa`; it drops cocoa_beans.
  const map = { stone: ['cobblestone'], grass_block: ['dirt'], cocoa: ['cocoa_beans'] };
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
  // A COMPOST RUN GOES TO THICK GROUND FIRST (sector_finder.densest), not to the nearest block: the book page that saw
  // the most compostable blocks together, COMPOST_DENSITY.min or more. With none that thick it scans the next frontier
  // sector and asks the book again, so the run widens the book one sector at a time until a forest floor or a flower
  // field is on it. It gathers where it then stands, thick ground or not. Once per claim.
  const everyMember = compostRun();
  if (everyMember && !payload.finder_looks && !payload.dense_looked && !finder.atStand(bot)) {
    const { COMPOST_DENSITY } = require('@thinking/architect_config');
    const ask = { item: requestedTargets[0], min: COMPOST_DENSITY.min,
      categories: finder.categoriesFor({ blocks: group_to_item[requestedTargets[0]] || requestedTargets }).filter(c => !c.startsWith('biome:')) };
    const step = await finder.densest(bot, ask);
    if (step.scanned) await finder.densest(bot, { ...ask, scan: false });
    return executePunchPath(bot, { ...payload, dense_looked: true }, requestedTargets, orderQuantity);
  }
  // A compost run takes every compostable its rings hold; any other group scan commits to its first ring's most.
  const members = everyMember ? (group_to_item[requestedTargets[0]] || requestedTargets) : null;
  // Broaden rarely-exposed requests to the exposed block that yields the same item: cobblestone->stone,
  // dirt->grass_block+dirt. getInventoryItemNamesForBlock credits the yield back to the request.
  const scanTargets = requestedTargets.flatMap(t =>
    t === 'cobblestone' ? ['stone'] :
    t === 'dirt'        ? ['grass_block', 'dirt'] :
    t === 'cocoa_beans' ? ['cocoa'] : [t]);
  // Keep-out: never gather inside the base. Owned here and handed to the scan as a parameter, since
  // the same scan node also serves mining/feller and building/tending must work inside the base.
  // Handed in as a parameter so a common block's budget cannot exhaust entirely inside the keep-out
  // (Law 25).
  // Natural ground (dirt, sand, stone and the like) is taken no nearer than GATHER_KEEPOUT; a plant no nearer than
  // HARVEST_KEEPOUT_RADIUS.
  const keepoutRadius = scanTargets.some(isNaturalGround) ? GATHER_KEEPOUT : HARVEST_KEEPOUT_RADIUS;
  const keepout = harvestKeepoutBoxes(keepoutRadius);
  // GATHER_REACH bounds the look round home; from a book sector's stand (sector_finder) the look reaches all its ground.
  // So does a compost run staying out past its first round, wherever the round before it ended.
  const tooFar = finder.atStand(bot) || payload.stay_out_round > 1 ? () => false : beyondGatherReach();
  // Ground is shaved a layer at a time from a tile this body holds (ground_shave); every other material
  // is punched where it stands.
  const ground = scanTargets.some(t => SHAVED_GROUND.has(t))
    ? groundShave.open(bot, { keepout, blocks: scanTargets }) : null;
  const surfaceFilter = require('@perception/surface_filter');
  const dispatcher = require('@locomotion/locomotion_dispatcher');
  const filter = {
    type: 'object_group_or_direct',
    targets: scanTargets,
    // A block with water beside or above it is one performDig refuses, so it is no candidate; nor is one past
    // GATHER_REACH of home (beyondGatherReach).
    exclude: pos => isInsideBlueprintKeepout(pos, keepout) || tooFar(pos) || (ground !== null && !ground.offers(pos))
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
  const digCap = punchCapOf();
  // ── A TIMED TRIP: WILD CANE (architect_config WILD_CANE) ──
  // The trip's clock starts at its first gather call and rides the payload through every look again. Time cutting is
  // work (punchHere); every other second, the walk to the first cane and between patches and every finder walk, is
  // walking. Before each walk past the first patch the walking share is read, and above WILD_CANE.walk_share the trip
  // ends and delivers what it holds. A full pledge in the pocket ends it too (the order's hold goal).
  const timed = requestedTargets[0] === 'sugar_cane';
  const clock = timed ? (payload.trip_clock || (payload.trip_clock = { started: Date.now(), worked: 0, visits: 0 })) : null;
  const walkShare = () => {
    const spent = Date.now() - clock.started;
    return spent > 0 ? (spent - clock.worked) / spent : 1;
  };
  const tooMuchWalking = () => timed && clock.visits > 0 && walkShare() > require('@thinking/architect_config').WILD_CANE.walk_share;
  let walkCapped = false;
  const capped = () => digAttempts >= digCap;
  const done = () => capped() || (objectiveBlocks !== null && countCollected(bot, objectiveBlocks) >= targetTotal);

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

      // WILD CANE IS CUT WHOLE: at its bottom block, so every block over it drops with it and each punch of the trip's
      // bounded few takes a whole plant (WILD_CANE).
      while (block && block.name === 'sugar_cane' && bot.blockAt(block.position.offset(0, -1, 0))?.name === 'sugar_cane') {
        block = bot.blockAt(block.position.offset(0, -1, 0));
      }

      if (block && objectiveBlocks.includes(block.name)) {
        const dugOk = await digBlock(bot, block);
        if (dugOk) { digAttempts++; visitDigs++; }
        else failedHere.add(`${block.position.x},${block.position.y},${block.position.z}`).add(`${target.x},${target.y},${target.z}`);

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
  let material = null;     // a group scan commits to the one block its first ring holds most of (a compost run: all)
  const takes = name => (members ? members.includes(name) : name === material);
  let seen = 0;            // blocks of the material the rings held
  let visits = 0;          // arrivals
  let unreached = 0;       // blocks in a ring left because no route reached them
  let refusedTiles = null; // the last ground refusal, for the idle line
  let tileWorked = false;  // ground: one tile is one errand
  let arrivedShort = null; // the last arrival with no offered block in reach: { d, at, near }
  for (let ring = await rings.next(); ring; ring = (done() || tileWorked || walkCapped) ? null : await rings.next()) {
    let left = ring.objectives.filter(o => o && o.position && ['x', 'y', 'z'].every(k => typeof o.position[k] === 'number'));
    if (!material) material = members ? requestedTargets[0] : surfaceFilter.dominantMatch(left).resolved;
    if (!ground) left = left.filter(o => takes(o.name));
    if (!left.length) continue;
    seen += left.length;
    if (objectiveBlocks === null) {
      // Ground takes every block of its scan: the layer under grass is dirt, and both yield the same item.
      objectiveBlocks = ground ? scanTargets : (members || [material]);
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
        // A HARVEST IS WORK, NOT WALKING: once the body stands on its ground (a book page's stand, past its first patch,
        // or out from an earlier gather of this claim), moving from patch to patch is the `work` leg the walking share
        // leaves out. The walk out to the ground and the walk home stay travel (onGround).
        if (tooMuchWalking()) { walkCapped = true; break; }
        const harvesting = visits > 0 || finder.atStand(bot) || onGround(payload);
        const approach = await dispatcher.goTo({ candidates_ref: 'surface_filter', candidates_count: left.length, candidates_kind: material, ...(harvesting ? { leg: 'work' } : {}) });
        // arrived=false only after locomotion exhausts its retry budget: nothing left in this ring is reachable.
        if (!approach || !approach.arrived) { unreached += left.length; break; }
      }
      visits++;
      watcher.summary(TAG, `Arrived near '${material}' in ring ${ring.index} — beginning in-place gathering.`);
      const digsBefore = digAttempts;
      const workFrom = Date.now();
      await punchHere();
      if (timed) { clock.worked += Date.now() - workFrom; clock.visits++; }
      // AN ARRIVAL THAT REACHED NOTHING IS NAMED: locomotion said arrived, yet no offered block stands within reach.
      // The distance to the nearest one goes on the record and on the readout, so a walk that stopped short is
      // charged to the walk, not read as ground with nothing on it.
      if (!ground && digAttempts === digsBefore && left.length) {
        const here = bot.entity.position;
        const near = left.reduce((b, o) => (squaredDistance(o.position, here) < squaredDistance(b.position, here) ? o : b));
        const d = Math.sqrt(squaredDistance(near.position, here));
        if (d > scanRadius) {
          const f = here.floored(), p = near.position;
          arrivedShort = { d: Math.round(d), at: `(${f.x},${f.y},${f.z})`, near: `(${p.x},${p.y},${p.z})` };
          watcher.warn(TAG, `ARRIVED SHORT — locomotion reported arrival at ${arrivedShort.at}, ${arrivedShort.d} blocks from the nearest offered '${material}' at ${arrivedShort.near}; nothing within ${scanRadius} blocks to gather.`);
        }
      }
      // A ground tile is worked to its end through ground.moveOn, and that tile is the errand.
      if (ground) { tileWorked = true; break; }
      const at = bot.entity.position;
      const before = left.length;
      left = left.filter(o => {
        const p = o.position;
        if (failedHere.has(`${p.x},${p.y},${p.z}`) || squaredDistance(p, at) <= scanRadius * scanRadius) return false;
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
        return !!b && takes(b.name);
      });
      if (left.length === before) break;
    }
  }
  if (walkCapped) {
    const got = objectiveBlocks ? countCollected(bot, objectiveBlocks) - startingCount : 0;
    if (got > 0) await collectNearby(bot);
    return routeIdle(payload, `WALK_SHARE ${Math.round(walkShare() * 100)}% of ${Math.round((Date.now() - clock.started) / 1000)}s over ${Math.round(require('@thinking/architect_config').WILD_CANE.walk_share * 100)}% — the trip ends with ${got} ${requestedTargets[0]} gathered`);
  }
  const ringCost = rings.cost();
  watcher.summary(TAG, `ring_search material=${material || scanTargets.join('|')} rings=${ringCost.rings} sections=${ringCost.read} scan_ms=${ringCost.ms} `
    + `seen=${seen} visits=${visits} unreached=${unreached} got=${objectiveBlocks ? countCollected(bot, objectiveBlocks) - startingCount : 0} of=${orderQuantity}`);

  // A compost run staying out whose later round gathers nothing brings home what the rounds before it gathered.
  const round = payload.stay_out_round || 1;
  const carryHome = (why) => {
    if (ground) ground.release();
    return routeResult(payload, true, `${TAG}: stay-out round ${round} ${why} — bringing home the ${payload.stay_out_carried} the earlier round(s) gathered`);
  };
  if (round > 1 && (seen === 0 || visits === 0)) return carryHome(seen === 0 ? 'saw none here' : 'reached none here');

  if (seen === 0) {
    // NONE WHERE THE BODY STANDS: the fleet's one escalation (sector_finder), asked by the blocks a group token
    // (compostables) names, since the survey records blocks, never groups. A book sector that records it: the body
    // stands at its page's stand and looks again (at most FINDER_LOOKS in one trip). No page: the body scans frontier
    // sectors, reading the book after each, up to the claim's SECTOR_SCAN.finder_scans; past them the claim ends with the
    // finder's warning. Nowhere left: it is noted absent for ABSENT_FOR_MS.
    if (ground) ground.release();
    if (tooMuchWalking()) return routeIdle(payload, `WALK_SHARE ${Math.round(walkShare() * 100)}% — none left in reach and the trip has walked its share; it ends`);
    const looks = (payload.finder_looks || 0) + 1;
    const step = looks <= FINDER_LOOKS
      ? await finder.escalate(bot, { item: requestedTargets[0], categories: finder.categoriesFor({ blocks: scanTargets.flatMap(t => group_to_item[t] || [t]), item: requestedTargets[0] }) })
      : { none: true, reason: 'look_limit' };
    if (step.moved) return executePunchPath(bot, { ...payload, finder_looks: looks }, requestedTargets, orderQuantity);
    if (step.reason === 'scans_spent') return routeIdle(payload, `${require('@thinking/architect_config').SECTOR_SCAN.finder_scans} sector scans could not find '${scanTargets.join(', ')}' — the claim ends`);
    for (const t of requestedTargets) markAbsent(t);
    return routeIdle(payload, `no '${scanTargets.join(', ')}' in the loaded world outside the ${keepoutRadius}b base keep-out, and nowhere `
      + `left to look (${step.reason}) — noted fleet-wide for ${ABSENT_FOR_MS / 60000} min`);
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
    capsule.on_ground = true;   // worked its ground: the claim's next gather walks on as work (onGround)
    const dropResult = await collectNearby(bot);
    pickedUpTotal += dropResult.picked_up;
    capsule.metrics.picked_up = pickedUpTotal;
    watcher.summary(TAG, `drops: ${dropResult.picked_up} collected (${pickedUpTotal} across the run)`);
    capsule.drop_collector = dropResult;
    if (ground) ground.release();   // the digging is over; the tile opens before the walk home
    // A COMPOST RUN STAYS OUT AS LONG AS IT WALKED: past the gather reach of home, a round that ends while the trip
    // still owes work for its walk (yield_pledge_calculator.tripSize: the walk out and the walk home against the work,
    // to the walking limit the run is judged on) runs again where it stands. Its harvesting is the work leg, so only
    // the walks out and home are walking. It turns home once the work has paid the walk, once a round no longer pays
    // the debt down (staysOut), or with no free slot: the trip is bounded by its own walk. And never past the order's
    // need (the magnet's shortfall at the claim): a round asks only for what is still wanted, and none once it is met.
    const gathered = finalCount - startingCount;
    const carried = (payload.stay_out_carried || 0) + gathered;
    const magnet = members ? require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet : null;
    if (magnet && magnet.station_id && beyondGatherReach()(bot.entity.position)) {
      const trip = require('@utils/calculators/yield_pledge_calculator').tripSize(bot, magnet, 'stay_out');
      const wanted = magnet.need > 0 ? magnet.need - carried : 0;
      const stays = trip.stays && wanted > 0 && bot.inventory.emptySlotCount() > 0;
      watcher.summary(TAG, `STAY_OUT round=${round} item=${requestedTargets[0]} gathered=${gathered} carried=${carried} need=${magnet.need} walk=${trip.walk} walk_s=${trip.walk_s} `
        + `elapsed_s=${trip.elapsed_s} walked_s=${trip.walked_s} owed_s=${trip.owed_s} free_slots=${bot.inventory.emptySlotCount()} stays=${stays ? 1 : 0}`);
      if (stays) return executePunchPath(bot, { ...payload, stay_out_round: round + 1, stay_out_carried: carried, dense_looked: true }, requestedTargets, Math.min(orderQuantity, wanted));
    }
    const short = finalCount < targetTotal;
    capsule.metrics.short = short;
    // A claim whose punches are spent ends here: what it gathered is delivered and the order is posted again.
    if (capped()) return routeIdle(payload, `punch cap: ${digAttempts} of ${digCap} punches spent, ${finalCount - startingCount} gathered — the claim ends`);
    await routeResult(payload, true,
      `${TAG}: ${short ? 'short' : 'full'} collected ${finalCount}/${targetTotal} digs=${digAttempts} `
      + `in ${scanCycles} cycle(s), cube-scan ${scanMsTotal}ms`
      + (short ? ` — the district gave what it had; carrying ${finalCount - startingCount} forward` : ''));
  } else if (round > 1) {
    await carryHome('gathered none');
  } else {
    if (ground) ground.release();
    await routeResult(payload, false, `${TAG}: fail collected_nothing ${finalCount}/${targetTotal} digs=${digAttempts} in ${scanCycles} cycle(s), cube-scan ${scanMsTotal}ms`
      + (arrivedShort ? ` — arrived ${arrivedShort.d} blocks short of the nearest offered at ${arrivedShort.near}, from ${arrivedShort.at}` : ''));
  }
}

// â”€â”€ Main receive handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = {
  absentNearby, leafSeatsOpen,
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
    const isInk = requestedTargets[0] === 'ink_sac';

    if (isInk) {
      // ── Ink path: squid_hunt ─────────────────────────────────────────────────
      // An ink sac is a squid's drop: the body finds a squid (sector_finder past its own sight), floats in the water
      // over it and dives for the ink (ink_diver, one borrowed breath a dive). Ink counts only from the pocket.
      const trip = await require('@api/squid_hunt').huntInk(bot, orderQuantity);
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      capsule.ink = { got: trip.got, dives: trip.dives, ended: trip.ended };
      if (trip.got > 0) return routeResult(payload, true, `${TAG}: ink trip brought ${trip.got} of ${orderQuantity} ink_sac in ${trip.dives} dive(s), ended ${trip.ended}`);
      if (/^no_squid:scanned:/.test(trip.ended)) return routeIdle(payload, `no squid where the body stood or in the book — ${trip.ended.slice('no_squid:'.length)} for it; the claim ends`);
      if (/^no_squid:/.test(trip.ended)) {
        markAbsent('ink_sac');
        return routeIdle(payload, `no squid to dive for and nowhere left to look (${trip.ended}) — noted fleet-wide for ${ABSENT_FOR_MS / 60000} min`);
      }
      return routeIdle(payload, `ink trip brought none in ${trip.dives} dive(s), ended ${trip.ended}`);

    } else if (isSeeds) {
      // â”€â”€ Seed path: delegate to seed_picker API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // wheat_seeds is a probabilistic drop from punching grass; seed_picker owns the
      // punch-many/collect/recount loop, not this generic block scan.
      // `banked` sums across the manager<->judge retry loop on the payload capsule; the pocket count
      // alone can repeat across real gains and read to recursive_judge as a stalled loop (Law 25).
      // ONE CLAIM, ONE PICK: at most seedPicker.MAX_SEEDS_PER_CLAIM seeds in at most MAX_GRASS_PUNCHES punches, then
      // the claim ends with what it picked delivered; the order is posted again for the rest.
      const want = Math.min(orderQuantity, seedPicker.MAX_SEEDS_PER_CLAIM);
      watcher.summary(TAG, `Seed path: picking ${want}x wheat_seeds of ${orderQuantity} ordered`);
      const result = await seedPicker.pick(bot, { quantity: want });
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      capsule.collected = result?.collected ?? 0;
      capsule.total = result?.total ?? 0;
      capsule.banked = (capsule.banked || 0) + capsule.collected;
      if (!result || !result.success) {
        // No grass reachable and nothing gathered -> futile from here; parks here (Law 13).
        const futile = (result?.reason === 'no_grass' || result?.reason === 'unreachable') && capsule.collected === 0;
        if (futile) return routeIdle(payload, `no grass reachable (${result.reason}) â€” deferring seed gather`);
      }
      return routeIdle(payload, `seed claim done: picked ${capsule.collected} wheat_seeds in ${result?.punches ?? '?'} punch(es) `
        + `(at most ${seedPicker.MAX_SEEDS_PER_CLAIM} seeds in ${seedPicker.MAX_GRASS_PUNCHES} punches a claim), pocket ${capsule.total} — the claim ends`);

    } else if (isLogs) {
      // â”€â”€ Tree path: delegate to tree_feller API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Spent-tree memory: a tree reached but not felled (bad stance) comes back with a position and
      // no mined blocks. `failed_trees` rides the payload capsule across the retry loop but resets on
      // a fresh job_board dispatch, giving it another shot once the world re-plans (Law 12).
      const capsule = payload.harvest_executor || (payload.harvest_executor = {});
      let excludeTrees = Array.isArray(capsule.failed_trees) ? capsule.failed_trees : [];
      // An order naming one log species fells that species only (tree_feller opts.species); a logs order, any tree.
      const species = (group_to_item.logs || []).includes(requestedTargets[0]) ? requestedTargets[0] : null;
      watcher.summary(TAG, `Tree path: gathering ${orderQuantity}x ${requestedTargets[0]}${excludeTrees.length ? ` (skipping ${excludeTrees.length} spent)` : ''}`);
      // Site trees, then the nearest tree to the yard — see fellLogLadder.
      // A TREE WITH NOTHING TO CUT AT ITS TRUNK IS PASSED AND THE NEXT ONE TRIED, TREE_MISS_CHANCES times in
      // one trip; the last miss is the trip's result.
      let result = await fellLogLadder(bot, excludeTrees, species, onGround(payload) ? 'work' : undefined);
      for (let miss = 1; result && !result.success && result.reason === 'no_blocks_mined' && result.position && miss < TREE_MISS_CHANCES; miss++) {
        const p = result.position;
        watcher.summary(TAG, `TREE_MISSED chance=${miss} of=${TREE_MISS_CHANCES} tree=(${p.x},${p.y},${p.z}) species=${result.species} — nothing to cut at the trunk; trying the next tree`);
        excludeTrees = [...excludeTrees, `tree:${p.x},${p.y},${p.z}`];
        capsule.failed_trees = excludeTrees;
        result = await fellLogLadder(bot, excludeTrees, species, 'work');
      }

      // NO FREE TREE WHERE THE BODY STANDS: none seen, none reachable, or every one in the loaded ground held by
      // a peer. The fleet's one escalation (sector_finder): the body stands at a book sector recording logs and
      // searches again from there; with no page left it scans the next frontier sector and the claim ends there.
      const noTree = r => r && !r.success
        && (r.reason === 'no_trees_found' || r.reason === 'no_reachable_free_tree' || r.reason === 'all_trees_claimed');
      const woods = requestedTargets.flatMap(t => (t.endsWith('_log') ? [t] : (group_to_item.logs || [])));
      const categories = finder.categoriesFor({ blocks: woods });
      // A sector whose trees were all held is passed without counting it empty, and never counts toward wood being absent.
      let heldAny = false;
      for (let looks = 0; noTree(result); looks++) {
        const held = result.reason === 'all_trees_claimed';
        heldAny = heldAny || held;
        const step = looks < FINDER_LOOKS ? await finder.escalate(bot, { item: requestedTargets[0], categories, held }) : { none: true, reason: 'look_limit' };
        if (step.moved) { result = await fellLogLadder(bot, excludeTrees, species, 'work'); continue; }
        if (step.reason === 'scans_spent') return routeIdle(payload, `${require('@thinking/architect_config').SECTOR_SCAN.finder_scans} sector scans could not find a free tree — the claim ends`);
        if (heldAny) return routeIdle(payload, `every tree looked at is held by a peer and nowhere is left to look (${step.reason}) — surplus here, replanning`);
        for (const t of requestedTargets) markAbsent(t);
        watcher.warn(TAG, `WOOD_ABSENT ${requestedTargets.join(',')} reason=${step.reason} looks=${looks} — no free tree where the body stood, in the book or the frontier`);
        return routeIdle(payload, `no tree to fell and nowhere left to look (${step.reason})`);
      }

      if (!result || !result.success) {
        if (result?.position && ['x', 'y', 'z'].every(k => typeof result.position[k] === 'number')) {
          const key = `tree:${result.position.x},${result.position.y},${result.position.z}`;
          if (!excludeTrees.includes(key)) capsule.failed_trees = [...excludeTrees, key];
        }
        return routeFail(payload, result?.reason || 'fell_failed');
      }

      capsule.drop_collector = result.drops;
      capsule.on_ground = true;   // out on its ground: the next tree of this claim is walked as work (onGround)

      // EACH FELLING REPLANTS ITS OWN TREE: outside the keep-out the harvester plants one farm sapling where the tree
      // stood (sapling_planter.plantWhereFelled), so the forest it takes from is kept and never thickened. What else it
      // carries rides home to be banked; the home band is planted by the chest job.
      await require('@api/sapling_planter').plantWhereFelled(bot, result);

      // Trunk-base coord keeps consecutive same-species/height fells from reading as a stalled loop (Law 12).
      const at = result.position ? ` @${result.position.x},${result.position.y},${result.position.z}` : '';
      await routeResult(payload, true, `${TAG}: felled ${result.species}${at}, mined ${result.minedCount}`);

    } else {
      // â”€â”€ Punch path: scan, approach, dig in place â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Leaves broken without shears drop no leaves: a punch for them would dig forever and gather nothing.
      // job_gates.toolGate holds such an order from a body with no shears in reach (Law 16). The leaf pair is borrowed
      // for the cut and returned with its result (borrowLeafShears, returnLeafShears).
      if (requestedTargets.some(t => /_leaves$/.test(t))) {
        const borrowed = await borrowLeafShears(bot);
        if (borrowed === 'abandoned') return;   // the withdraw abandoned to the judge
        // Both refusals are a peer winning the same pair in the instant after the board offered it; the gate reads
        // the taken seat and the emptied chest on the next offer, so the claim ends with the count it saw.
        const pairs = require('@thinking/architect_config').LEAF_PAIRS;
        if (borrowed === 'seats_held') return routeIdle(payload, `all ${pairs} leaf pairs of shears are out with peers cutting leaves (0 of ${pairs} leaf seats open); the claim ends`);
        if (borrowed === 'none_banked') return routeIdle(payload, `a leaf seat was free but the chests hold 0 shears unclaimed (${leafSeatsOpen()} of ${pairs} leaf seats open to peers); the claim ends`);
      }
      watcher.summary(TAG, `Punch path: gathering ${orderQuantity}x ${requestedTargets[0]}`);
      await executePunchPath(bot, payload, requestedTargets, orderQuantity);
    }
  })
};
