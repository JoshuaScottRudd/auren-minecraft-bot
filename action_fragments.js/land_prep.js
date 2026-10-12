// fragment: land_prep (action / farming) — bulk-supplies a cluster visit ONCE before farm_manager's
// tend loop.
//
// Law 15 API `prepare(bot, {seeds, boneMeal})`: the manager calls it directly, then loops the
// farm_executor.tendPlot API over the actionable plots. Gets THREE things for the WHOLE cluster in one
// shot, so the bot never travels back to resupply between plots:
//   1. HOE       — equipped if owned; else pulled from a chest; else crafted.
//   2. SEEDS     — up to `seeds`, asked for by name; the selector answers WHERE. Best-effort — gated on
//                  the accessible pool so an empty pool never abandons.
//   3. BONE MEAL — up to `boneMeal` (the growing-plot count), pulled from a chest so the executor's
//                  pocket-reading applier has something to apply.
//
// Seeds and bone meal name no chest: land_prep asks for an ITEM and lets inventory_swapper's selector
// find WHERE. job_board gates dispatch on accessibleMaterialPool (every chest), so the puller must search
// that same pool or the two can disagree and dispatch a job the puller cannot fulfill (Law 16 — job_board
// says IF, the swapper says WHERE, land_prep just asks).
//
// invariants:
//  - craftItems / retrieveItems are Law 15 APIs: on ABANDON they originate their OWN signal to
//    recursive_judge. prepare returns FALSE on such an abandon so the manager STOPS (a signal is already
//    in flight — never route a second, Law 4); it returns TRUE when the visit may proceed.
//  - A HOE that cannot be obtained ABANDONS (returns false): nothing in the visit tills without one.
//    SEEDS do NOT — the cluster can be dispatched for harvest alone, so the seed pull is gated on the
//    CHESTS actually holding some (the pool minus the pocket — the only source retrieveItems can pull);
//    a blind retrieval would abandon the whole visit over a harvest-only job or a pocket-only seed supply.
//    A {success:false} seed retrieve (chest emptied by a peer) leaves those plots to re-post
//    (skip-and-continue); the manager owns the visit's verdict.

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

function pocketCounts(bot) {
  const c = {};
  for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count;
  return c;
}

// Pull the raw materials a set of finished goods needs, crediting what the pocket already holds. A short
// or absent stock is not fatal here: craftItems downstream abandons if it is genuinely short, which
// re-plans into a gather (Law 13 environmental). Returns false only when a retrieve API abandoned; the
// caller then stops (Law 4).
async function pullRawFrom(bot, needMap) {
  const raw = remainingRawForBuild(needMap, pocketCounts(bot));
  for (const [item, count] of Object.entries(raw)) {
    if (count <= 0) continue;
    if (!await inventorySwapper.retrieveItems(bot, item, count)) return false;
  }
  return true;
}

// prepare(bot, { seeds, boneMeal }) → bulk-supply the whole cluster visit ONCE, then return control to
// the manager (Law 15 API — no onward route). Returns TRUE when the visit may proceed, FALSE when an API
// abandoned to the judge, so the manager stops with no second signal routed (Law 4).
async function prepare(bot, { seeds = 0, boneMeal = 0 } = {}) {
  if (!bot?.entity?.position) {
    throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before land_prep.prepare ran.`);
  }

  // ── 1. HOE ─────────────────────────────────────────────────────────
  // Names a chest: "no hoe anywhere" routes to the craft branch here, and the retrieve-vs-craft decision
  // needs to know whether one exists — a route question, not a second answer to job_board's possible/not.
  //
  // EVERY REGISTERED CHEST IS SEARCHED — the same pool the gate one step earlier counts a hoe in
  // (Law 16, Law 25). Storage is one pool.
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
  // retrieveItems pulls from CHESTS only, so the count here is the pool MINUS the pocket, not the full
  // pool: a single seed harvested from grass sits in the pocket, and counting the full pool would pass a
  // gate the bulk pull then cannot satisfy from any chest, abandoning every cycle until the judge halts
  // it (Law 13 — the seed exists, just in the pocket; Law 16 — gate and puller read the same source).
  const pocketSeeds = countInInventory('wheat_seeds', pocketCounts(bot));
  const want = seeds - pocketSeeds;
  const chestSeeds = inventoryLens.inChests('wheat_seeds');
  if (want > 0 && chestSeeds > 0) {
    const got = await inventorySwapper.retrieveItems(bot, 'wheat_seeds', Math.min(want, chestSeeds));
    if (!got) return false;              // a chest existed at gate time but is gone now → already abandoned (Law 15/4)
    if (got.success) watcher.summary(TAG, `Pulled ${got.transferred} wheat_seeds from chest ${got.station_id}.`);
    // {success:false} = the chest opened empty (a peer beat us to it). NOT an abandon and NOT fatal: the
    // plots that wanted seeds simply skip planting this visit and stay actionable to re-post next cycle
    // (skip-and-continue); the manager owns the visit's verdict.
  }

  // NO FENCE STEP: the plot is sited dynamically along a waterbank and enclosed by nothing, so no
  // blueprint emits a fence voxel and no caller can compute a non-zero need. The plot's blocks are priced
  // from the live survey by farming_integrity and pulled as ordinary build material; an enclosure would
  // arrive as survey steps like every other voxel, needing no dedicated step here.

  // ── 3. BONE MEAL ──────────────────────────────────────────────────
  // Same best-effort shape as seeds above, for the same reason: `retrieveItems` pulls from chests, so
  // the count here is pool-minus-pocket.
  //
  // farm_executor's applier reads the POCKET (`bot.inventory.items()`), while farming_integrity's
  // `bonemeal` phase posts on the accessible POOL — pocket plus every chest. Bone meal is banked in a
  // chest, so this pull keeps the job from posting on chest stock the bot cannot yet apply, walking to a
  // field it cannot treat, and re-posting forever — a job that is always available and never does
  // anything (Law 25).
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
