// fragment: land_prep (action / farming)
// purpose: Bulk-supply the cluster visit ONCE before farm_manager's tend loop.
//          Law 15 API `prepare(bot, {seeds, boneMeal})` — the manager calls it directly, then loops the
//          farm_executor.tendPlot API over the actionable plots. land_prep no longer routes onward: the old
//          signal `receive` → farm_executor hop is retired (Law 16 — the manager sequences the visit now).
//          It gets THREE things for the WHOLE cluster in one shot, so the bot never travels back to
//          resupply between plots:
//            1. HOE   — equipped if owned; else pulled from a headframe chest (a prior cycle's
//                       dumpExcess left it there); else crafted. Never carried between jobs.
//            2. SEEDS — up to `seeds` (the plantable-plot count), asked for by name; the selector answers
//                       WHERE. Best-effort — gated on the accessible pool so an empty pool never abandons.
//            3. BONE MEAL — up to `boneMeal` (the growing-plot count), pulled from a chest so the
//                       executor's pocket-reading applier has something to apply.
//
// WHY seeds/bone meal name no chest: land_prep asks for an ITEM and lets inventory_swapper's
// selector find it, rather than naming the headframe chest and pre-checking that one snapshot
// first. Naming a chest makes two fragments answer "is this possible" two different ways:
// farming_integrity gates dispatch on accessibleMaterialPool (every chest), while a storage row-only
// pre-check can read empty when the pool holds plenty elsewhere. The two answers can disagree,
// dispatching a job the puller then can't fulfill and stalling the bot until the judge intervenes.
// One question, one owner: job_board says IF, the swapper says WHERE, land_prep just asks.
//
// The pre-check was not gratuitous — it was the toll for naming a chest: inventory_swapper throws
// on a caller that names a station whose snapshot lacks the item. Stop naming the chest and the
// toll disappears: no claim, nothing to pre-check, and the selector's own no-target abandon
// (Law 15) becomes reachable.
//
// TWO WRONG TURNS, both plausible, both already taken and rejected:
//  - Narrowing farming_integrity's pool to a single chest so the gate agrees. This inverts it: the
//    gate would refuse a farm job while usable seeds sit two chests over, sending the fleet to
//    harvest what it already owns. The pool was never the arbitrary half.
//  - Teaching land_prep to loop chests itself. That rebuilds _selectRetrieveTarget, which
//    inventory_swapper already owns (Law 16), and re-splits the "where" answer in two.
//
// Scope note: asking by item means the selector may serve these from ANY registered chest, not
// headframe chests specifically (today every chest IS headframe, so this is a no-op). That is the
// point — accessibleMaterialPool, which gates the dispatch, counts every chest too, so gate and
// puller cannot drift apart again. Scoping either one is now a single question with a single owner.
//
// invariants:
//  - craftItems / retrieveItems are Law 15 APIs: on ABANDON they originate their OWN signal to
//    recursive_judge. prepare returns FALSE on such an abandon so the manager STOPS (a signal is already
//    in flight — never route a second, Law 4); it returns TRUE when the visit may proceed.
//  - A HOE that cannot be obtained ABANDONS (returns false): nothing in the visit tills without one.
//    SEEDS do NOT — the cluster can be dispatched for harvest alone, so the seed pull is gated on the
//    CHESTS actually holding some (the pool minus the pocket — the only source retrieveItems can pull);
//    a blind retrieval would abandon the whole visit over a harvest-only job OR a pocket-only seed supply.
//    A {success:false} seed retrieve (chest emptied by a peer) is no longer routed onward: the manager
//    owns the visit's verdict now, so a missed seed just leaves those plots to re-post (skip-and-continue).

'use strict';

const watcher = require('@kernel/watcher');
const stationRegistry = require('@perception/station_registry');
const inventorySwapper = require('@api/inventory_swapper');
const { craftItems } = require('@api/craft_handler');
const { group_to_item, chestItemCounts } = require('@utils/fragment_utils');
const inventoryLens = require('@kernel/inventory_lens');
const { remainingRawForBuild } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'land_prep';
const HEADFRAME = 'headframe';

function pocketCounts(bot) {
  const c = {};
  for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count;
  return c;
}

// Pull the raw materials a set of finished goods needs, crediting what the pocket already holds.
// A short or absent stock is deliberately NOT fatal here: craftItems downstream abandons if it is
// genuinely short, which re-plans into a gather (Law 13 environmental). Returns false only when a
// retrieve API abandoned — the caller must then stop rather than route a second signal (Law 4).
async function pullRawFrom(bot, needMap) {
  const raw = remainingRawForBuild(needMap, pocketCounts(bot));
  for (const [item, count] of Object.entries(raw)) {
    if (count <= 0) continue;
    if (!await inventorySwapper.retrieveItems(bot, item, count)) return false;
  }
  return true;
}

// prepare(bot, { seeds, boneMeal }) → bulk-supply the whole cluster visit ONCE, then return control to the
// manager (Law 15 API — no onward route). Returns TRUE when the visit may proceed, FALSE when an API
// abandoned to the judge (Law 15) so the manager stops rather than routing a second signal (Law 4).
async function prepare(bot, { seeds = 0, boneMeal = 0 } = {}) {
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before land_prep.prepare ran.`);
  }

  // ── 1. HOE ─────────────────────────────────────────────────────────
  // Names a chest rather than asking the selector blind, because "no hoe anywhere" is not a failure
  // here — it is the craft branch, and a blind ask would abandon instead of crafting. The
  // retrieve-vs-craft decision needs to know whether one exists, which is a route question, not
  // a second answer to job_board's possible/not.
  //
  // EVERY REGISTERED CHEST IS SEARCHED. This used to filter on a chest role, so a hoe sitting in a
  // chest wearing the other tag was invisible and a second one got crafted beside it — the gate one
  // step earlier counts a hoe in ANY chest, and a puller that reads a narrower set than its gate
  // disagrees with the verdict that dispatched it (Law 16, Law 25). Storage is one pool.
  const ownsHoe = bot.inventory.items().some(i => group_to_item.hoe.includes(i.name));
  if (!ownsHoe) {
    let pulled = false;
    for (const chest of stationRegistry.findChests()) {
      const stock = chestItemCounts(chest);
      const hoeName = group_to_item.hoe.find(h => (stock[h] || 0) > 0);
      if (hoeName) {
        if (!await inventorySwapper.retrieveItems(bot, hoeName, 1, chest.id)) return false;
        pulled = true;
        watcher.summary(TAG, `Retrieved ${hoeName} from chest ${chest.id}.`);
        break;
      }
    }
    if (!pulled) {
      if (!await pullRawFrom(bot, { wooden_hoe: 1 })) return false;
      const r = await craftItems(bot, 'wooden_hoe', 1);
      if (!r || !r.success) return false;    // craft abandoned to recursive_judge
      watcher.summary(TAG, 'Crafted a wooden_hoe.');
    }
  }
  // Equip whatever hoe we now hold, so the tend loop starts hoe-in-hand ("made and equipped").
  const hoeItem = bot.inventory.items().find(i => group_to_item.hoe.includes(i.name));
  if (hoeItem) await guardExternal(TAG, 'equip hoe', () => bot.equip(hoeItem, 'hand'));

  // ── 2. SEEDS (best-effort; gated on CHEST stock so a pocket-only supply never abandons) ──
  // retrieveItems pulls from CHESTS only, so the gate must count CHEST-retrievable seeds — the pool
  // MINUS the pocket, not the full pool. Counting the full pool can strand a bot: a single seed
  // harvested from grass sits in the pocket, accessibleMaterialPool counts it, the gate passes, and
  // the bulk pull then demands the shortfall from chests holding none — inventory_swapper abandons
  // every cycle until the judge halts it. Same fault as the chest-naming issue above, new door
  // (pocket-vs-chest instead of one-chest-vs-every-chest): the gate must count the SAME source the
  // puller pulls from (Law 16), or a step declared best-effort abandons the whole visit over a
  // non-fault (Law 13 — the seed exists, just in the pocket). WHY this only bites once the bulk pull
  // is involved: the old per-plot path passed seeds=1 → want=0 → the gate's `want>0` was false and
  // the retrieve never ran; the cluster's bulk pull (seeds=plantable count) is what first drives
  // want>0 with no chest source.
  const pocketSeeds = countInInventory('wheat_seeds', pocketCounts(bot));
  const want = seeds - pocketSeeds;
  const chestSeeds = inventoryLens.inChests('wheat_seeds');
  if (want > 0 && chestSeeds > 0) {
    const got = await inventorySwapper.retrieveItems(bot, 'wheat_seeds', Math.min(want, chestSeeds));
    if (!got) return false;              // a chest existed at gate time but is gone now → already abandoned (Law 15/4)
    if (got.success) watcher.summary(TAG, `Pulled ${got.transferred} wheat_seeds from chest ${got.station_id}.`);
    // {success:false} = the chest opened empty (a peer beat us to it). NOT an abandon and NOT fatal: the
    // plots that wanted seeds simply skip planting this visit and stay actionable to re-post next cycle
    // (skip-and-continue). Nothing routed, so — unlike the old single-farm path — this no longer owes the
    // judge an outcome: the manager (not this API) owns the visit's verdict now.
  }

  // THE FENCE STEP IS DELETED. It crafted a perimeter to a `fenceNeed` the manager could only ever pass
  // as 0: the plot is sited dynamically along a waterbank and enclosed by nothing, so no blueprint emits a
  // fence voxel and no caller can compute a non-zero need. A branch whose condition no state reaches is
  // not a spare capability, it is a second route to "supply this plot" that never runs and cannot be
  // observed failing (Law 16). The plot's blocks are priced from the live survey by farming_integrity and
  // pulled as ordinary build material; if an enclosure is ever designed it arrives as survey steps like
  // every other voxel, needing no dedicated step here.

  // ── 3. BONE MEAL ──────────────────────────────────────────────────
  // Same best-effort shape as seeds above, and for the same reason: gate on what the PULLER can
  // actually reach. `retrieveItems` pulls from chests, so the gate counts pool-minus-pocket —
  // counting the full pool is the same fault described above (a single item in the pocket passes a
  // gate whose pull then demands from empty chests, abandoning every cycle until the judge halts it).
  //
  // WHY THIS STEP EXISTS AT ALL: farm_executor's applier reads the POCKET (`bot.inventory.items()`), while
  // farming_integrity's new `bonemeal` phase posts on the accessible POOL — pocket plus every chest. Bone
  // meal comes off a composter and is banked in the headframe chest, so without this pull the job
  // would post on chest stock, walk the bot to a field it cannot treat, and re-post forever: a job that is
  // always available and never does anything, which is worse than no job (Law 25).
  if (boneMeal > 0) {
    const pocketBone = countInInventory('bone_meal', pocketCounts(bot));
    const wantBone = boneMeal - pocketBone;
    const chestBone = inventoryLens.inChests('bone_meal');
    if (wantBone > 0 && chestBone > 0) {
      const got = await inventorySwapper.retrieveItems(bot, 'bone_meal', Math.min(wantBone, chestBone));
      if (!got) return false;   // a chest existed at gate time and is gone now → already abandoned (Law 15/4)
      if (got.success) watcher.summary(TAG, `Pulled ${got.transferred} bone_meal from chest ${got.station_id}.`);
      // {success:false} = a peer emptied it first. Not fatal and not an abandon: the growing plots simply
      // go untreated this visit and re-post next cycle, exactly as a seedless plant plot does.
    }
  }

  watcher.summary(TAG, `prepped hoe/seeds(want ${want > 0 ? want : 0})/bone_meal(${boneMeal}) → manager tend loop`);
  return true;
}

module.exports = { prepare };
