// fragment: compost_executor — feed compostables into a composter, and take the bone meal out.
//
// A LIBRARY, NOT A SIGNAL TARGET. One entry point: `feedFromPocket(bot, want)`, a Law 15 API called by
// inventory_swapper.dumpExcess. It has no `receive`, no registry entry, and nothing on the job board — the
// same conversion land_prep and farm_executor got. Both verbs of the block live inside one visit.
//
// ── WHY IT IS ALL ONE VISIT, AND WHY NEITHER HALF IS A JOB ────────────────────────────────────────────
// Dump access places items directly into the compost bin, and if there is none it simply holds the
// material in the bot. Filling and emptying the bin are one operation, not two: if placing items fills
// the bin partway through, the executor takes the bone meal out and continues — collecting compost is
// part of using the compost bin, not a separate errand.
//
// The old shape had the composter as a STORAGE with an errand at each end: the dump filed a sapling in a
// chest, a `compost_load` job pulled it back out and carried it to the block, and a `compost_collect`
// job later went to empty the block. Three moves for one item, and the errands were ranked at the bottom of
// a board the fleet never emptied, sitting unclaimed for long stretches while both bots ran at high
// occupancy. **A waste-disposal errand that must compete for a bot will always lose, so it stopped being
// an errand.**
//
// EMPTYING IS NOT A SEPARATE TRIP because a full block is not a separate situation — it is what a feed run
// into. The bot is standing at the block with the lock in hand; harvesting is one right-click with an empty
// hand; a job to send someone back for it later is a whole dispatch to repeat a move already available for
// free. So `_feedLoop` harvests whenever the level blocks it, and sweeps once more at the end of the visit
// so a run that fills the bin with its last item never walks away from the bone meal it just made.
// `compost_load`, `compost_collect`, `compost_manager` and `COMPOST_MIN_INPUT` all died with those errands
// (Law 16 — the route they served no longer exists).
//
// THE ONE CASE THIS GIVES UP, recorded so a successor does not "fix" it by reintroducing the job: a bin
// left at level 8 waits for the next bot that arrives holding compostables, because there is no longer
// anything that visits the block empty-handed. That is acceptable — the fleet dumps constantly, so the
// wait is a cycle or two, and the errand that would have shortened it demonstrably went unclaimed anyway.
//
// ── IT IS NOT A CONTAINER, AND THAT DECIDES THE WHOLE INTERACTION ───────────────────────────────────
// A composter takes no inventory-window interaction: placing and removing are both right-clicks, not
// pick/drop through an open window. So every transfer here is activateBlock, one item per
// click, and the HELD ITEM is what selects between the two verbs — a right-click holding a compostable
// feeds, the same right-click with an empty hand harvests. That is why an `unequip` precedes every
// harvest: skipping it does not throw, it silently feeds a full block instead, and the level never moves.
//
// The obvious alternative was to model it on the furnace — register it in station_registry, track its
// progress in HQ. station_registry validates every registration against an OPENED WINDOW, and there is no
// window; but the deeper reason is that a furnace needs HQ state because its progress is INVISIBLE unless
// opened, while a composter publishes its fill level 0–8 as a blockstate readable from across the room.
// Nothing to remember, and remembering it would be strictly worse (Invariant B, with the unusual luxury
// that fresh state is also the cheaper read). Every question this fragment asks, it asks the block.
//
// ── THE ARITHMETIC, STATED PLAINLY SO NOBODY RE-DERIVES IT OPTIMISTICALLY ───────────────────────────
// Each compostable has a 30% chance to raise the level by one; seven levels make one bone meal. So it is
// ~23 items in per bone meal out, and one bone meal is one growth stage of one plant. It is a real
// accelerant on waste the fleet was accumulating anyway, and it is not a food revolution — bones off
// skeletons are the volume source, which is now the `bone_meal` row's craft route rather than a
// promise. The ratio is accepted as adequate for a passive, background conversion.
//
// ── WHAT IT REFUSES TO COMPOST ──────────────────────────────────────────────────────────────────────
// Only items in COMPOST_INPUTS, and only what dumpExcess has already ruled SURPLUS. Feeding a composter
// the wheat_seeds the farm is short of would convert a planting into a 30%-chance-of-one-eighth of a bone
// meal, which is a loss in every world — so the keep question is asked ONCE, by the one calculation that
// owns it, and this fragment never re-derives it (Law 16). The dump also offers a wanting STORAGE the
// item before this ever sees it, which is what makes "anything above 32 goes to the compost bin"
// expressible: the chest takes its number first, and only the overflow arrives here.

'use strict';

const watcher = require('@kernel/watcher');
const { groupToAllItems, readBuildCenter, sleep } = require('@utils/fragment_utils');
const {
  COMPOST_INPUTS,
  COMPOST_SEARCH_RADIUS,
  COMPOSTER_READY_LEVEL,
} = require('@thinking/architect_config');

const TAG = 'compost_executor';

// How long a bot waits in line at the composter before giving up and keeping its material. Shorter than
// the chest queue's two minutes on purpose: a chest queue blocks a job that cannot proceed without the
// chest, while this one blocks a DUMP whose material is welcome to ride along another cycle. Waiting out
// a crashed holder to shed a sapling is the worse trade.
const COMPOST_LOCK_TIMEOUT_MS = 30000;

// composterLevel(block) → 0-8, or null if it is not a composter. Same probe chain as getWheatAge: the
// modern property first, raw metadata as the fallback for older block shapes. The name check lives INSIDE
// the reader for the reason getWheatAge's header records — a caller that has to remember to check the name
// first is a guard that will eventually be forgotten.
function composterLevel(block) {
  if (!block || block.name !== 'composter') return null;
  if (typeof block.getProperties === 'function') {
    const props = block.getProperties();
    if (props && props.level !== undefined) return parseInt(props.level, 10);
  }
  if (typeof block.metadata === 'number') return block.metadata;
  return null;
}

// isCompostable(itemName) → is this concrete item name a member of an opt-in COMPOST_INPUTS group?
// The tokens are GROUPS ('saplings') and a pocket holds concrete names ('oak_sapling'), so the membership
// test has to expand the group — matching the token against the name directly finds nothing and silently
// composts none of it. countInInventory is the fleet's one group-aware counter and this is its predicate
// half (Law 16 — never a second matching rule).
//
// REPLACED `spareCompostables`, which measured the pocket against a `holder:'bot'` keep row and was the
// blocker on "anything above 32 goes to the compost bin": seeds keep their number on a CHEST row, so the
// bot-row lookup found nothing, defaulted the keep to zero, and would have composted the fleet's whole
// reserve. dumpExcess already owns the one surplus calculation the fleet honours; asking it instead of
// re-deriving a second one is what makes the overflow rule expressible at all.
function isCompostable(itemName) {
  if (!itemName) return false;
  for (const token of COMPOST_INPUTS) {
    if (token === itemName) return true;
    const members = groupToAllItems(token);
    if (Array.isArray(members) && members.includes(itemName)) return true;
  }
  return false;
}

// The composter's lock id. Deliberately the same `x|y|z` shape station_registry mints for a chest, and
// fed to the SAME lock primitives — reusing the chest queue logic rather than standing up a second lock
// system (Law 16). Nothing about lockChest/getLockHolder/waitUntilChestFree requires the id to name a
// registered station — the lock is a string on the holder's magnet, so a block with no window locks
// exactly as well as a chest with one, and clearMagnet() releases it at job end for free (Law 8: no
// orphan).
function composterLockId(block) {
  const p = block.position;
  return `${p.x}|${p.y}|${p.z}`;
}

// findComposter(bot) → the nearest placed composter within COMPOST_SEARCH_RADIUS of the headframe, or null.
// Searched in the WORLD rather than looked up in a registry, for the reason in the header: the block is its
// own record. Anchored to the headframe so a bot deep in the shaft does not find one it happens to pass.
function findComposter(bot) {
  const centre = readBuildCenter('headframe');
  if (!centre || typeof centre.x !== 'number') return null;
  // Vec3, not the plain {x,y,z} readBuildCenter returns: mineflayer calls `.floored()` on `point`, so a
  // bare object throws a TypeError from inside findBlocks — which surfaces as a signal dying OUTSIDE the
  // judge, killing the bot on the first planning sweep. Same conversion job_board and surface_filter do
  // at their own findBlock call sites.
  const Vec3 = require('vec3');
  const found = bot.findBlock({
    matching: (b) => b && b.name === 'composter',
    point: new Vec3(centre.x, centre.y, centre.z),
    maxDistance: COMPOST_SEARCH_RADIUS,
  });
  return found || null;
}

// WHY a null findComposter is reported as "not built yet" and not as "there is none": the headframe
// blueprint DECLARES a composter, and the reason string has to say which of those two worlds we are in.
// They call for opposite responses — a missing declaration is a blueprint defect for the Architect, an
// unbuilt voxel is the build order working as designed and needs nothing from anyone.
//
// The build order is the whole explanation, and it is deliberate (see `anchor_order_note` in
// building_blueprints.json): anchors 0-2 are the shell and carry the first two CHESTS, because a fleet
// needs somewhere to share resources before nightfall; the composter is on anchor 3 with the other
// stations, below that deadline, because station voxels depend on a mining chain that must not be allowed
// to hold up walls. So on a fresh world there is a window — minutes, not seconds — in which a bot can
// deposit to a chest and has nowhere to put a compostable, even though the two stand a few blocks apart
// in the finished base. Holding the material through that window is correct and is what dumpExcess does.
// It is self-resolving and happens once per world; a `composter_not_built_yet` line climbing after the
// base is finished is the signal worth chasing, and it reads differently from this one.
//
// Derived from the blueprint rather than asserted, so moving the composter to another anchor — or out of
// the blueprint entirely — changes this answer without anyone remembering to edit it (Law 25: the verdict
// tracks the thing it reports on).
function composterDeclaredAtAnchor() {
  const { tryGetBuilding } = require('@kernel/blueprint_registry');
  const { collectAllVoxels } = require('@perception/blueprint_survey');
  const building = tryGetBuilding('headframe');
  if (!building) return null;
  for (const v of collectAllVoxels(building)) {
    if (Array.isArray(v.raw) && v.raw[3] === 'composter') return v.anchor_index;
  }
  return null;
}

async function reach(bot, block) {
  const locomotion = require('@locomotion/locomotion_dispatcher');
  // The composter is a blueprint voxel (headframe anchor 3, contractor_house anchor 0), so its stance is
  // authored: goToStationAnchor stands the body on the owning anchor. A bare coordinate would order the
  // navigator to stand INSIDE the block and it would dig the composter out to comply; a raycast or radius
  // goal would let it work the bin from outside the wall. No distance shortcut — one stance, always.
  await locomotion.goToStationAnchor({ x: block.position.x, y: block.position.y, z: block.position.z });
  const fresh = bot.blockAt(block.position);
  return !!(fresh && fresh.name === 'composter');
}

// ── THE LEVEL DOES NOT ANSWER ON THE SAME TICK IT IS ASKED ────────────────────────────────────────────
// `bot.blockAt` reads the CLIENT's world model, and that model only changes when the server's block-update
// packet arrives. A re-sense fired immediately after activateBlock therefore returns the level from BEFORE
// the click — reliably, not occasionally.
//
// A loop that trusts that stale read can report a harvest as missed when it did not: the block filled,
// the harvest clicked, the bone meal came out, and a read of the stale level sees 8 unmoved — aborting the
// visit and reporting a false zero (Law 25) even though the world did everything right. Worse than the
// false report: a loop that cannot see level 8 keeps feeding a FULL composter, which silently refuses
// every item — the waste this fragment's header warns of.
//
// SETTLE_MS is farm_executor's 100ms, reused rather than re-derived — it is the fleet's already-paid answer
// to this exact trap on the hoe (`await sleep(100)` then `blockAt(...)?.name !== 'farmland'`). Do not
// "optimise" it away: an attempt is not an outcome, and without the settle there is nothing to read but
// the intent.
const SETTLE_MS = 100;

// _harvest(bot, block) → true if a bone meal actually came out.
// Empty hand is the harvest verb. The unequip is the whole difference between harvesting and doing
// nothing: right-clicking with a compostable still held feeds a full block instead, which the server
// silently ignores and a caller reads as a stuck level.
//
// RE-SENSE, never trust the packet. activateBlock cannot fail loudly — mineflayer sends it and the server
// may silently drop it (farm_executor's header records the same trap for the hoe). A level that did NOT
// fall is the only evidence the harvest missed.
async function _harvest(bot, block) {
  await bot.unequip('hand');
  await bot.activateBlock(block);
  await sleep(SETTLE_MS);
  const after = composterLevel(bot.blockAt(block.position));
  return after != null && after < COMPOSTER_READY_LEVEL;
}

// ── THE VISIT — the one place items go into a composter, and the one place they come out ───────────
// THE VISIT EMPTIES THE POCKET, harvesting mid-way as often as it takes: the bot places items in the
// composter, removes the bone meal when it fills, and keeps placing until the pocket is empty. A full
// composter refuses further items SILENTLY, so a loop that merely stopped at level 8 would carry the rest
// home and need another whole trip to shed it. Harvesting is a right-click with an empty hand and costs
// one tick, so it belongs INSIDE the visit.
//
// THE TAIL SWEEP IS THE OTHER HALF and it is why no collect job exists: mid-loop harvesting only fires
// when a full block BLOCKS a feed, so a visit whose last item tops the bin off — say twenty items in with
// fifteen filling it — would leave the bone meal sitting there, and the bot is still standing at the block
// holding the lock, so the sweep is one more click rather than a dispatch.
//
// `want` is [{ name, count }] of CONCRETE item names — activateBlock feeds one real item at a time, so a
// group token would have nothing to equip.
async function _feedLoop(bot, block, want) {
  const before = composterLevel(block);
  let fed = 0, harvested = 0, blocked = false;

  for (const entry of want) {
    for (let n = 0; n < entry.count; n++) {
      let live = bot.blockAt(block.position);
      let level = composterLevel(live);
      if (level == null) { blocked = true; break; }

      if (level >= COMPOSTER_READY_LEVEL) {
        // Continuing to feed a block still reading 8 is the silent no-op loop this check exists to end.
        if (!(await _harvest(bot, live))) { blocked = true; break; }
        harvested++;
        live = bot.blockAt(block.position);
      }

      const item = bot.inventory.items().find((i) => i && i.name === entry.name);
      if (!item) break;
      await bot.equip(item, 'hand');
      await bot.activateBlock(live);
      // The settle is what makes the NEXT iteration's level read mean anything. Without it the loop runs
      // blind and feeds straight through level 8 into a block that is refusing every item.
      await sleep(SETTLE_MS);
      fed++;
    }
    if (blocked) break;
  }

  // The tail sweep. A block that did not respond to a harvest mid-loop will not respond now, so `blocked`
  // skips it rather than spending a second failed click on the way out.
  if (!blocked) {
    const live = bot.blockAt(block.position);
    if (composterLevel(live) === COMPOSTER_READY_LEVEL && await _harvest(bot, live)) harvested++;
  }

  await sleep(SETTLE_MS);
  const after = composterLevel(bot.blockAt(block.position));
  return { fed, harvested, blocked, before, after };
}

// feedFromPocket(bot, want) → a Law 15 API for inventory_swapper.dumpExcess. Returns a result, NEVER
// routes a signal and NEVER abandons its caller: the dump is called at the end of half a dozen executors
// and a signal fired from in here would land in whichever one happened to be running (Law 4). Every
// failure is reported back and the material stays in the pocket rather than being discarded or retried
// from in here.
//
// The lock/queue below is the chest queue, reused verbatim through the shared primitives: check the
// holder, walk there and wait at the block (so travel is paid while the peer works), then acquire and
// re-sense. Without it two bots right-click the same block on the same tick and both read a level the
// other just moved — the composter has no window to serialise them the way a chest does, so it is the ONE
// station where the lock is the only thing standing between the fleet and a miscounted level.
async function feedFromPocket(bot, want) {
  if (!Array.isArray(want) || !want.length) return { ok: true, fed: 0, harvested: 0, reason: 'nothing_to_feed' };

  let block = findComposter(bot);
  if (!block) {
    const anchor = composterDeclaredAtAnchor();
    return anchor == null
      ? { ok: false, fed: 0, harvested: 0, reason: 'no_composter_in_blueprint' }
      : { ok: false, fed: 0, harvested: 0, reason: 'composter_not_built_yet', anchor };
  }

  const stationRegistry = require('@perception/station_registry');
  const { waitUntilChestFree } = require('@utils/chest_lock_utils');
  const lockId = composterLockId(block);
  const deadline = Date.now() + COMPOST_LOCK_TIMEOUT_MS;

  // Walk there BEFORE waiting, same as _queueAtChest: the queue is served at the block, so the travel is
  // paid during the peer's turn rather than after it.
  while (stationRegistry.getLockHolder(lockId)) {
    const holder = stationRegistry.getLockHolder(lockId);
    watcher.summary(TAG, `${TAG}: composter ${lockId} is in use by ${holder} — moving there to queue for release.`);
    if (!(await reach(bot, block))) return { ok: false, fed: 0, harvested: 0, reason: 'cannot_reach_locked_composter' };
    const wait = await waitUntilChestFree(lockId, { timeoutMs: deadline - Date.now() });
    if (!wait.released) return { ok: false, fed: 0, harvested: 0, reason: `timeout_queueing_for_composter_held_by_${wait.holder || 'unknown'}` };
    watcher.summary(TAG, `${TAG}: composter ${lockId} released after ${Math.round(wait.waitedMs / 1000)}s in queue — proceeding.`);
    if (Date.now() > deadline) return { ok: false, fed: 0, harvested: 0, reason: 'timeout_queueing_for_composter' };
  }

  // First-come wins and a rival is never preempted, so a simultaneous double-grab makes BOTH back off.
  // Reporting that as a plain failure is correct here rather than retrying: the caller holds the material
  // and the next dump tries again, which is the retry — a loop in here would be a second one (Law 16).
  if (!stationRegistry.acquireChestLock(lockId)) {
    return { ok: false, fed: 0, harvested: 0, reason: 'composter_lock_lost_to_peer' };
  }

  if (!(await reach(bot, block))) return { ok: false, fed: 0, harvested: 0, reason: 'composter_gone_on_arrival' };
  block = bot.blockAt(block.position);
  if (composterLevel(block) == null) return { ok: false, fed: 0, harvested: 0, reason: 'composter_gone_on_arrival' };

  const r = await _feedLoop(bot, block, want);
  // The verdict states what the WORLD did, not what was attempted (Law 25). Feeding 12 items for zero
  // levels is an honest and entirely normal outcome at a 30% rate; reporting it as a level gain because
  // the items left the pocket would make every future compost verdict unreadable.
  watcher.summary(TAG, `${TAG}: fed ${r.fed} item(s) into the composter${r.harvested ? `, harvested ${r.harvested} bone_meal` : ''}, `
    + `level ${r.before} → ${r.after}`
    + `${r.blocked ? ' (stopped early — the composter stopped responding)' : ''}`);
  return { ok: true, fed: r.fed, harvested: r.harvested, blocked: r.blocked, reason: null };
}

module.exports = {
  composterLevel,
  isCompostable,
  feedFromPocket,
  findComposter,
};
