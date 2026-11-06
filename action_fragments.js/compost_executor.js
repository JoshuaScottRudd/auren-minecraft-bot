// fragment: compost_executor — feed compostables into a composter and collect the bone meal it yields.
// The bone meal is picked up off the bin before the visit ends and banked with the drop-off (_collectBoneMeal).
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
// Each sapling or leaf litter has a 30% chance to raise the level by one, an apple 65%; seven levels make one bone meal.
//
// Only items in COMPOST_INPUTS that no standing stock row still wants are fed (`surplusCompostable`).

'use strict';

const watcher = require('@kernel/watcher');
const { groupToAllItems, readTransposeOrigin, sleep } = require('@utils/fragment_utils');
const { routeToJudge } = require('@utils/signal_utils');
const TAG = 'compost_executor';

// Opt-in list: only these item groups are fed to a composter. An apple raises the level 65% of the time, a sapling or
// leaf litter 30%. Wheat seeds (30%) are not on it: they are composted only past the stack storage keeps for planting,
// and only once the first wheat field is sown (SEED, seedSurplus below).
const COMPOST_INPUTS = ['saplings', 'compostables', 'apple'];
const LEAF_LITTER = 'leaf_litter';
const SEED = 'wheat_seeds';

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
  if (!isCompostable(itemName)) return false;
  for (const row of require('@thinking/requested_work').activeStockRows()) {
    if (row.deficit_below == null) continue;
    const members = groupToAllItems(row.item);
    if (row.item === itemName || (Array.isArray(members) && members.includes(itemName))) return false;
  }
  return true;
}

// bankedCompostables() → [{ name, count }] of surplus compostables sitting in the fleet's chests, by
// concrete item name — what one compost job withdraws. Asked of the inventory lens (Invariant B). Of a flower,
// storage keeps what the wool still owed will be dyed with (flock_colors.flowersKept: one flower per animal a color
// asks for), and of a farm sapling the tree farm's bank (sapling_planter.bankKept): only what lies past it is compost.
function bankedCompostables() {
  const inventoryLens = require('@kernel/inventory_lens');
  const { DYE_STOCK } = require('@thinking/architect_config');
  const flowers = require('@api/flock_colors').flowersKept();
  const banked = [];
  for (const token of COMPOST_INPUTS) {
    const members = groupToAllItems(token);
    for (const name of (Array.isArray(members) && members.length ? members : [token])) {
      if (!surplusCompostable(name)) continue;
      const kept = DYE_STOCK.flowers.includes(name) ? (flowers[name] || 0) : require('@api/sapling_planter').bankKept(name);
      const count = inventoryLens.inChests(name) - kept;
      if (count > 0) banked.push({ name, count });
    }
  }
  const seeds = seedSurplus(inventoryLens.inChests(SEED));
  if (seeds > 0) banked.push({ name: SEED, count: seeds });
  return banked;
}

// seedSurplus(chestSeeds, pocketSeeds = 0) → the wheat seeds past the stack storage keeps (COMPOST_SEED_KEEP), counting
// what the chests hold first; 0 until the first wheat field is sown (farming_integrity.firstFieldSown), since until then
// every seed is the field's.
function seedSurplus(chestSeeds, pocketSeeds = 0) {
  if (!require('@perception/farming_integrity').firstFieldSown()) return 0;
  const { COMPOST_SEED_KEEP } = require('@thinking/architect_config');
  return Math.max(0, chestSeeds + pocketSeeds - COMPOST_SEED_KEEP);
}

// compostSurplusSeeds(bot, excess) → the seeds fed. THE HARVEST'S SEEDS GO STRAIGHT TO THE BIN: a body banking its haul
// (inventory_swapper.dumpExcess) feeds the composter the seeds of `excess` (what it would bank) that storage's stack does
// not need, so they never take a chest slot. A bin held by a peer or not yet built leaves them to be banked, and the
// compost batch takes them from the chests (bankedCompostables).
async function compostSurplusSeeds(bot, excess) {
  const count = Math.min(excess, seedSurplus(require('@kernel/inventory_lens').inChests(SEED), excess));
  if (count <= 0) return 0;
  const r = await feedFromPocket(bot, [{ name: SEED, count }]);
  return r.fed || 0;
}

// compostLeafLitter(bot, count) → the leaf litter fed. LEAF LITTER NEVER TAKES A CHEST SLOT: every deposit
// (inventory_swapper._depositPlanned) brings it here. A bin held by a peer or not yet built leaves it in the pocket for
// the next drop-off.
async function compostLeafLitter(bot, count) {
  if (count <= 0) return 0;
  const r = await feedFromPocket(bot, [{ name: LEAF_LITTER, count }]);
  return r.fed || 0;
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
// the home first. Searches the world directly — the block is its own record, not a registry entry — by the
// fleet's ring search (@utils/ring_scan) outward from the home, within COMPOST_BAND of its height.
const COMPOST_BAND = 16;
async function findComposters(bot) {
  const centre = readTransposeOrigin(_home());
  if (!centre || typeof centre.x !== 'number') return [];
  const { found } = await require('@utils/ring_scan').nearestBlocks(bot, {
    names: ['composter'], center: centre, reach: COMPOST_SEARCH_RADIUS,
    band: { low: centre.y - COMPOST_BAND, high: centre.y + COMPOST_BAND },
    source: 'compost_executor.bins',
  }, 8);
  const Vec3 = require('vec3');
  return found.map((o) => bot.blockAt(new Vec3(o.position.x, o.position.y, o.position.z))).filter(Boolean);
}

// findComposter(bot) → the nearest placed composter to the crew's home, or null.
async function findComposter(bot) { return (await findComposters(bot))[0] || null; }

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

// ── THE BONE MEAL COMES OUT OF THE TOP, ONTO THE GROUND ─────────────────────────────────────────────────
// Emptying a full composter does not hand the bone meal over: the block throws it out of its top as an item,
// which the game will not let a body pick up for half a second and which can roll off the bin. A harvest is
// only bone meal in the crew's hands once the pocket holds it, so the visit waits at the bin for it
// (PICKUP_WAIT_MS) and then walks onto whatever is still lying there (drop_collector) before it lets the bin go.
const PICKUP_WAIT_MS = 1500;
const _boneMealHeld = (bot) => bot.inventory.items().filter(i => i && i.name === 'bone_meal').reduce((n, i) => n + i.count, 0);

// _collectBoneMeal(bot, heldBefore, harvested) → how many of the harvested bone meal reached the pocket.
async function _collectBoneMeal(bot, heldBefore, harvested) {
  const gained = () => _boneMealHeld(bot) - heldBefore;
  const until = Date.now() + PICKUP_WAIT_MS;
  while (gained() < harvested && Date.now() < until) await sleep(SETTLE_MS);
  if (gained() < harvested) await require('@api/drop_collector').collectNearby(bot);
  return Math.max(0, gained());
}

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

  const bins = await findComposters(bot);
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

  const boneBefore = _boneMealHeld(bot);
  const r = await _feedLoop(bot, block, want);
  const collected = r.harvested ? await _collectBoneMeal(bot, boneBefore, r.harvested) : 0;
  release('composter visit done');
  // States what the block did, not what was attempted (Law 25) — at a 30% rate, zero level gain from a
  // full feed is an honest, ordinary outcome.
  watcher.summary(TAG, `${TAG}: fed ${r.fed} item(s) into the composter`
    + `${r.harvested ? `, harvested ${r.harvested} bone_meal and picked up ${collected}${collected < r.harvested ? ` (${r.harvested - collected} left on the ground)` : ''}` : ''}, `
    + `level ${r.before} → ${r.after}`
    + `${r.blocked ? ' (stopped early — the composter stopped responding)' : ''}`
    + ` after ${waitedSec}s waiting to get in.`);
  return { ok: true, fed: r.fed, harvested: r.harvested, collected, blocked: r.blocked, reason: null };
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

  if (!(await findComposters(bot)).length) { _route(false, 'no composter standing to feed'); return; }

  // The seeds this body already carried are not the batch's: only the ones it withdraws are fed.
  const seedsCarried = bot.inventory.items().filter(i => i.name === SEED).reduce((n, i) => n + i.count, 0);
  for (const { name, count } of bankedCompostables()) {
    const got = await retrieveItems(bot, name, count);
    if (got === undefined) return;
  }

  const held = {};
  for (const it of bot.inventory.items()) {
    if (surplusCompostable(it.name)) held[it.name] = (held[it.name] || 0) + it.count;
  }
  const seedsWithdrawn = bot.inventory.items().filter(i => i.name === SEED).reduce((n, i) => n + i.count, 0) - seedsCarried;
  if (seedsWithdrawn > 0) held[SEED] = seedsWithdrawn;
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
  _route(!!r.ok, r.ok ? `fed ${r.fed} compostable(s), harvested ${r.harvested} bone_meal, banked ${r.collected || 0}` : `fed nothing — ${r.reason}`,
    { fed: r.fed, harvested: r.harvested, collected: r.collected || 0 });
}

module.exports = {
  receive: watcher.track(TAG, receive),
  composterLevel,
  isCompostable,
  bankedCompostables,
  compostSurplusSeeds,
  compostLeafLitter,
  LEAF_LITTER,
  findComposter,
};
