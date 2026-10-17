// fragment: compost_executor — feed compostables into a composter and collect the bone meal it yields.
//
// THE COMPOST JOB. Every body banks its compostables in the fleet's barrels like
// any other surplus (inventory_swapper.dumpExcess). When COMPOST_BATCH_MIN of them sit banked,
// assessors/compost posts one shared `compost_feed` chest-band job and `receive` below runs it: withdraw
// the whole banked batch, feed it in one visit, bank the bone meal. One walk per batch, not one per body.
//
// Filling and emptying the composter is one visit, not two errands: `_feedLoop` harvests mid-loop
// whenever a full block blocks a feed, and sweeps once more at the end so a visit that fills the bin
// with its last item still collects the bone meal it made.
//
// A composter takes no inventory-window interaction — every transfer is a right-click via activateBlock,
// and the HELD ITEM selects the verb: holding a compostable feeds, an empty hand harvests. `unequip`
// always precedes a harvest click, since a held compostable would feed a full block instead of emptying it.
//
// The composter publishes its fill level 0-8 as a readable blockstate, so nothing about it is tracked in
// HQ or station_registry beyond the transfer lock (Invariant B — every question here asks the block).
//
// Each compostable has a 30% chance to raise the level by one; seven levels make one bone meal.
//
// Only items in COMPOST_INPUTS that no standing stock row still wants are fed (`surplusCompostable`).

'use strict';

const watcher = require('@kernel/watcher');
const { groupToAllItems, readTransposeOrigin, sleep } = require('@utils/fragment_utils');
const { routeToJudge } = require('@utils/signal_utils');
const TAG = 'compost_executor';

// Opt-in list: only these item groups are fed to a composter. `wheat_seeds` is deliberately excluded —
// reserved for planting.
const COMPOST_INPUTS = ['saplings', 'leaf_litter'];

// How far from a blueprint centre this looks for a placed composter.
const COMPOST_SEARCH_RADIUS = 24;

// Full fill level of a composter; yields exactly one bone meal.
const COMPOSTER_READY_LEVEL = 8;

// composterLevel(block) → the block's fill level 0-8, or null if it is not a composter. Reads the modern
// property first, falling back to raw metadata for older block shapes (same probe chain as getWheatAge).
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
// The tokens are GROUPS ('saplings') and a pocket holds concrete names ('oak_sapling'), so membership
// expands the group via groupToAllItems, the fleet's one group-aware matcher (Law 16).
function isCompostable(itemName) {
  if (!itemName) return false;
  for (const token of COMPOST_INPUTS) {
    if (token === itemName) return true;
    const members = groupToAllItems(token);
    if (Array.isArray(members) && members.includes(itemName)) return true;
  }
  return false;
}

// surplusCompostable(itemName) → compostable AND no standing stock row still wants it (a still-wanted
// sapling is stock arriving late, not waste). Reads the crew's selected stock rows (Law 16).
function surplusCompostable(itemName) {
  if (!require('@thinking/requested_work').activeWorkRequirements().includes('compost')) return false;
  if (!isCompostable(itemName)) return false;
  for (const row of require('@thinking/requested_work').activeStockRows()) {
    if (row.deficit_below == null) continue;
    const members = groupToAllItems(row.item);
    if (row.item === itemName || (Array.isArray(members) && members.includes(itemName))) return false;
  }
  return true;
}

// bankedCompostables() → [{ name, count }] of surplus compostables sitting in the fleet's chests, by
// concrete item name — what one compost job withdraws. Asked of the inventory lens (Invariant B).
function bankedCompostables() {
  const inventoryLens = require('@kernel/inventory_lens');
  const banked = [];
  for (const token of COMPOST_INPUTS) {
    const members = groupToAllItems(token);
    for (const name of (Array.isArray(members) && members.length ? members : [token])) {
      if (!surplusCompostable(name)) continue;
      const count = inventoryLens.inChests(name);
      if (count > 0) banked.push({ name, count });
    }
  }
  return banked;
}

// The composter's lock id — the same `x|y|z` shape station_registry mints for a chest, fed to the same
// lock primitives (Law 16), so a block with no window queues exactly like one with a window.
function composterLockId(block) {
  const p = block.position;
  return `${p.x}|${p.y}|${p.z}`;
}

// The crew's home structure owns its composter (headframe for a homesteader, laydown_yard for a builder).
function _home() { return require('@kernel/bot_mandate').homeBlueprint(); }

// findComposters(bot) → every placed composter within COMPOST_SEARCH_RADIUS of the crew's home, nearest
// the home first. Searches the world directly — the block is its own record, not a registry entry.
function findComposters(bot) {
  const centre = readTransposeOrigin(_home());
  if (!centre || typeof centre.x !== 'number') return [];
  // Vec3, not the plain {x,y,z} readTransposeOrigin returns: mineflayer calls `.floored()` on `point`,
  // and a bare object throws a TypeError from inside findBlocks. Same conversion job_board and
  // surface_filter use at their own findBlock call sites.
  const Vec3 = require('vec3');
  return bot.findBlocks({
    matching: (b) => b && b.name === 'composter',
    point: new Vec3(centre.x, centre.y, centre.z),
    maxDistance: COMPOST_SEARCH_RADIUS,
    count: 8,
  }).map((p) => bot.blockAt(p)).filter(Boolean);
}

// findComposter(bot) → the nearest placed composter to the crew's home, or null.
function findComposter(bot) { return findComposters(bot)[0] || null; }

// composterDeclaredAtAnchor() → the anchor index where the home blueprint declares a composter, or
// null if it declares none — distinguishing a build not yet reached from a blueprint that never named
// one, findComposter's two failure reasons. Derived from the blueprint, not asserted, so it tracks the
// blueprint if the anchor moves (Law 25).
function composterDeclaredAtAnchor() {
  const { tryGetBuilding } = require('@kernel/blueprint_registry');
  const { collectAllVoxels } = require('@perception/blueprint_survey');
  const building = tryGetBuilding(_home());
  if (!building) return null;
  for (const v of collectAllVoxels(building)) {
    if (Array.isArray(v.raw) && v.raw[3] === 'composter') return v.anchor_index;
  }
  return null;
}

async function reach(bot, block) {
  const locomotion = require('@locomotion/locomotion_dispatcher');
  // The composter is a blueprint voxel, so its stance is authored: goToStationStance stands the body on
  // the owning anchor. Arrival and "still a composter" are separate questions — one asked of the
  // navigator, one asked of the world.
  const nav = await locomotion.goToStationStance({ x: block.position.x, y: block.position.y, z: block.position.z });
  if (!nav.arrived) {
    watcher.warn(TAG, `composter at (${block.position.x},${block.position.y},${block.position.z}) could not be `
      + `reached (${nav.reason}) — nothing is fed this visit and the material stays in the pocket.`);
    return false;
  }
  const fresh = bot.blockAt(block.position);
  return !!(fresh && fresh.name === 'composter');
}

// ── THE LEVEL DOES NOT ANSWER ON THE SAME TICK IT IS ASKED ────────────────────────────────────────────
// `bot.blockAt` reads the CLIENT's world model, which only changes when the server's block-update packet
// arrives — a read fired immediately after activateBlock returns the level from before the click. A
// settle before every level read is what makes that read mean anything (same trap farm_executor's
// SETTLE_MS covers for the hoe).
const SETTLE_MS = 100;

// _harvest(bot, block) → true if a bone meal actually came out. Empty hand is the harvest verb; a
// compostable still held would feed the block instead. Re-senses after the click since activateBlock
// cannot fail loudly — a level that did not fall is the only evidence the harvest missed.
async function _harvest(bot, block) {
  await bot.unequip('hand');
  await bot.activateBlock(block);
  await sleep(SETTLE_MS);
  const after = composterLevel(bot.blockAt(block.position));
  return after != null && after < COMPOSTER_READY_LEVEL;
}

// ── THE VISIT — the one place items go into a composter, and the one place they come out ───────────
// Empties the pocket, harvesting mid-visit whenever a full block blocks a feed, then sweeps once more at
// the end so a visit whose last item tops off the bin still collects the bone meal.
//
// `want` is [{ name, count }] of CONCRETE item names — activateBlock feeds one real item at a time.
async function _feedLoop(bot, block, want) {
  const before = composterLevel(block);
  let fed = 0, harvested = 0, blocked = false;
  const book = require('@kernel/item_book');

  for (const entry of want) {
    for (let n = 0; n < entry.count; n++) {
      let live = bot.blockAt(block.position);
      let level = composterLevel(live);
      if (level == null) { blocked = true; break; }

      if (level >= COMPOSTER_READY_LEVEL) {
        // A block reading 8 is harvested before the next feed, never fed into.
        if (!(await _harvest(bot, live))) { blocked = true; break; }
        harvested++;
        live = bot.blockAt(block.position);
      }

      const item = bot.inventory.items().find((i) => i && i.name === entry.name);
      if (!item) break;
      // One feed is one act to the item book: the loop outlasts the book's idle reading.
      await book.open();
      await bot.equip(item, 'hand');
      await bot.activateBlock(live);
      // Lets the next iteration's level read reflect this click.
      await sleep(SETTLE_MS);
      await book.close('compost', 'composter');
      fed++;
    }
    if (blocked) break;
  }

  // Tail sweep — skipped when already blocked, since an unresponsive block will not respond now either.
  if (!blocked) {
    const live = bot.blockAt(block.position);
    if (composterLevel(live) === COMPOSTER_READY_LEVEL && await _harvest(bot, live)) harvested++;
  }

  await sleep(SETTLE_MS);
  const after = composterLevel(bot.blockAt(block.position));
  return { fed, harvested, blocked, before, after };
}

// feedFromPocket(bot, want) → the one visit, called by receive below. Returns a result and never routes a
// signal or retries on its own (Law 4) — failure is reported back and the material stays in the pocket.
//
// Reuses the chest queue's lock primitives verbatim: the composter has no window to serialise concurrent
// bots the way a chest does, so the lock is what keeps two right-clicks on the same tick from reading a
// level the other just moved.
// ── EVERY VISIT STATES ITS WAIT ──────────────────────────────────────────────────────────────────────
// Walk-and-queue time from the decision to feed until the body stands at the bin with the lock, stated on
// the visit's one line in the chest writer's own words ("after Ns waiting to get in"), including a visit
// that gave up — a wait that ended in nothing is still time the fleet paid.
const _waited = (since) => ((Date.now() - since) / 1000).toFixed(1);
function _gaveUp(since, result) {
  watcher.summary(TAG, `${TAG}: fed 0 item(s) — gave up (${result.reason}) after ${_waited(since)}s waiting to get in.`);
  return result;
}

async function feedFromPocket(bot, want) {
  if (!Array.isArray(want) || !want.length) return { ok: true, fed: 0, harvested: 0, reason: 'nothing_to_feed' };

  const bins = findComposters(bot);
  if (!bins.length) {
    const anchor = composterDeclaredAtAnchor();
    return anchor == null
      ? { ok: false, fed: 0, harvested: 0, reason: 'no_composter_in_blueprint' }
      : { ok: false, fed: 0, harvested: 0, reason: 'composter_not_built_yet', anchor };
  }

  const since = Date.now();
  const stationRegistry = require('@perception/station_registry');

  // A BUSY BIN IS NOT QUEUED FOR. The body takes the first bin no peer holds; when every bin is held,
  // compostables ride along to the next drop-off at no cost and the body goes back to work.
  let block = bins.find((b) => !stationRegistry.getLockHolder(composterLockId(b))) || null;
  if (!block) {
    const holders = bins.map((b) => stationRegistry.getLockHolder(composterLockId(b))).join('+');
    return _gaveUp(since, { ok: false, fed: 0, harvested: 0, reason: `composter_busy_with_${holders}` });
  }
  const lockId = composterLockId(block);

  // A lost race is reported as failure, not retried here — the caller's next dump is the retry (Law 16).
  if (!stationRegistry.acquireChestLock(lockId)) {
    return _gaveUp(since, { ok: false, fed: 0, harvested: 0, reason: 'composter_lock_lost_to_peer' });
  }

  // The lock is held from here to the end of the visit and dropped on every exit (station_registry.unlockChest).
  const release = (why) => stationRegistry.unlockChest(lockId, undefined, why);
  if (!(await reach(bot, block))) { release('composter unreachable'); return _gaveUp(since, { ok: false, fed: 0, harvested: 0, reason: 'composter_gone_on_arrival' }); }
  block = bot.blockAt(block.position);
  if (composterLevel(block) == null) { release('composter gone'); return _gaveUp(since, { ok: false, fed: 0, harvested: 0, reason: 'composter_gone_on_arrival' }); }
  const waitedSec = _waited(since);

  const r = await _feedLoop(bot, block, want);
  release('composter visit done');
  // States what the block did, not what was attempted (Law 25) — at a 30% rate, zero level gain from a
  // full feed is an honest, ordinary outcome.
  watcher.summary(TAG, `${TAG}: fed ${r.fed} item(s) into the composter${r.harvested ? `, harvested ${r.harvested} bone_meal` : ''}, `
    + `level ${r.before} → ${r.after}`
    + `${r.blocked ? ' (stopped early — the composter stopped responding)' : ''}`
    + ` after ${waitedSec}s waiting to get in.`);
  return { ok: true, fed: r.fed, harvested: r.harvested, blocked: r.blocked, reason: null };
}

function _route(success, reason, extra = {}) {
  routeToJudge(TAG, { readable: `${TAG}: ${reason}`, [TAG]: { success, ...extra } });
}

// ── THE COMPOST JOB: barrels → composter → barrels ───────────────────────────────────────────────────
// Withdraw every banked compostable, feed them in one visit, then bank the bone meal and anything the bin
// would not take. retrieveItems routes its own abandon (undefined) and dropOffHaul flags one (`abandoned`);
// either way this returns without routing again (Law 4).
async function receive(signalType) {
  if (signalType !== TAG) return;
  const bot = global.bot;
  const { retrieveItems, dropOffHaul } = require('@api/inventory_swapper');

  if (!findComposters(bot).length) { _route(false, 'no composter standing to feed'); return; }

  for (const { name, count } of bankedCompostables()) {
    const got = await retrieveItems(bot, name, count);
    if (got === undefined) return;
  }

  const held = {};
  for (const it of bot.inventory.items()) {
    if (surplusCompostable(it.name)) held[it.name] = (held[it.name] || 0) + it.count;
  }
  // A crew that replants keeps its primary sapling's pocket stack: only what it holds past that is fed.
  for (const keep of require('@api/sapling_planter').pocketRow()) {
    if (!(keep.item in held)) continue;
    held[keep.item] -= keep.dump_threshold;
    if (held[keep.item] <= 0) delete held[keep.item];
  }
  const want = Object.entries(held).map(([name, count]) => ({ name, count }));
  if (!want.length) { _route(false, 'no compostable reached the pocket — a peer withdrew the batch first'); return; }

  const r = await feedFromPocket(bot, want);
  const drop = await dropOffHaul(bot);
  if (drop?.abandoned) return;
  _route(!!r.ok, r.ok ? `fed ${r.fed} compostable(s), harvested ${r.harvested} bone_meal` : `fed nothing — ${r.reason}`,
    { fed: r.fed, harvested: r.harvested });
}

module.exports = {
  receive: watcher.track(TAG, receive),
  composterLevel,
  isCompostable,
  bankedCompostables,
  findComposter,
};
