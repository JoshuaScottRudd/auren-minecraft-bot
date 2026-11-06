// fragment: land_prep (action / farming) — bulk-supplies a cluster visit ONCE before farm_manager's
// tend loop.
//
// Law 15 API `prepare(bot, {seeds, boneMeal, water})`: the manager calls it directly, then loops the
// farm_executor.tendPlot API over the actionable plots. Gets THREE things for the WHOLE cluster in one
// shot, so the bot never travels back to resupply between plots:
//   1. HOE       — equipped if owned; else pulled from a chest; else crafted.
//   2. SEEDS     — up to `seeds`, asked for by name; the selector answers WHERE. Best-effort — gated on
//                  the accessible pool so an empty pool never abandons.
//   3. BONE MEAL — up to `boneMeal` (the growing-plot count), pulled from a chest so the executor's
//                  pocket-reading applier has something to apply.
//   4. WATER     — when `water` cells wait to be poured, a water bucket: the crew's bucket pulled from a
//                  chest and filled at an open water source found by THE WATER SEARCH (fillBucket).
//                  Best-effort, like seeds.
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
const locomotion = require('@locomotion/locomotion_dispatcher');
const finder = require('@api/sector_finder');

const TAG = 'land_prep';
// Book sectors one fill looks from before it gives up, as animal_finder's seek.
const WATER_WALK_LIMIT = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// openWaterSource(bot) → the pool's nearest refilling cell (wellOf), else the nearest water source a bucket can be
// filled at in the body's loaded area, found by the fleet's ring search (@utils/ring_scan) outward from the body: a
// source block (level 0) with air over it, one a body can stand beside and dip into from above, at sea level (below).
// null when no loaded ring holds one.
// A SOURCE THE BUCKET CAME UP EMPTY AT IS PASSED: the nearest cell is otherwise picked again on every visit and the
// field is never watered. Passed by this body for DIP_PASS_MS, keyed by cell.
// A SOURCE A SCOOP CAME UP EMPTY AT IS BANNED for the rest of the run (Infinity), with a warning naming what stood
// there, so the cell is investigated from the record afterwards rather than tried again.
const DIP_PASS_MS = 600000;
const _dipPassed = new Map();
const dipKey = (p) => `${p.x},${p.y},${p.z}`;
const dipPassed = (p) => (_dipPassed.get(dipKey(p)) || 0) > Date.now();
// fieldWater(bot) → 'x,y,z' of every water cell the crew's fields declare. A field's own water is not dipped where the dip
// leaves the cell dry: the bucket filled there is poured straight back into it, and the field it was filled for stays dry.
function fieldWater(bot) {
  const { farmField } = require('@perception/farming_integrity');
  const { getFarmlandCells } = require('@perception/farmland_site');
  const { readTransposeOrigin } = require('@utils/fragment_utils');
  const own = new Set();
  for (const key of farmField().keys) {
    if (!readTransposeOrigin(key)) continue;
    for (const c of getFarmlandCells(bot, key).waterCells) own.add(`${c.x},${c.y},${c.z}`);
  }
  return own;
}

// ── THE POOL: WATER THAT REFILLS AS IT IS TAKEN ──
// Water with source water on two sides over solid ground becomes a source itself. So each cell of the crew's water pool
// (architect_config FARM_FIELD.pool: two by two, two pours) refills the moment a bucket takes it, and every pour after
// the pool's own is filled there instead of at water far off. Only the pool is dipped: a field's water is its own.
// poolWater(bot) → 'x,y,z' of the pool's water cells, empty before it is sited.
function poolWater(bot) {
  const { FARM_FIELD } = require('@thinking/architect_config');
  const { readTransposeOrigin } = require('@utils/fragment_utils');
  if (!readTransposeOrigin(FARM_FIELD.pool)) return new Set();
  return new Set(require('@perception/farmland_site').getFarmlandCells(bot, FARM_FIELD.pool).waterCells.map(c => `${c.x},${c.y},${c.z}`));
}
// wellOf(bot, cells) → the nearest pool cell `cells` holds that refills (a source with two source sides, air over it and
// solid ground under it), shaped as openWaterSource returns it, or null while the pool is not poured.
const FOUR = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function wellOf(bot, cells) {
  const Vec3 = require('vec3');
  const { isWaterSource } = require('@utils/gravity_utils');
  const at = bot.entity.position;
  let best = null;
  for (const key of cells) {
    const [x, y, z] = key.split(',').map(Number);
    const p = new Vec3(x, y, z);
    if (dipPassed(p) || !isWaterSource(bot, x, y, z) || bot.blockAt(p.offset(0, 1, 0))?.name !== 'air') continue;
    if (FOUR.filter(([dx, dz]) => isWaterSource(bot, x + dx, y, z + dz)).length < 2) continue;
    if (bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') continue;
    const d = at.distanceTo(p);
    if (!best || d < best.d) best = { d, position: p };
  }
  return best ? { name: 'water', position: best.position } : null;
}

// WATER IS TAKEN FROM THE POOL FIRST (wellOf); with the pool not poured yet, AT SEA LEVEL ONLY, where rivers and oceans
// lie: a source whose top is the sea's surface
// (architect_config.SEA_LEVEL - 1), touching air above it, and open to the sky by the book's own rule (ground_line: a
// wet column's line is the water itself). An aquifer pocket can sit at the same height with air in its cave above it;
// it lies under its column's ground, reached only by digging down into it and left as a pit the body may not walk out of.
async function openWaterSource(bot) {
  const surface = require('@thinking/architect_config').SEA_LEVEL - 1;
  const own = fieldWater(bot);
  const well = wellOf(bot, poolWater(bot));
  if (well) return well;
  const lines = require('@perception/ground_line').lines(bot);
  const { found } = await require('@utils/external_library_guard').withCleanup(TAG, 'look for open water', () =>
    require('@utils/ring_scan').nearestBlocks(bot, {
      names: ['water'],
      band: { low: surface, high: surface },
      accept: (r, p) => r.isWaterSource(p.x, p.y, p.z) && r.blockAt(p.x, p.y + 1, p.z)?.name === 'air' && !dipPassed(p)
        && !own.has(`${p.x},${p.y},${p.z}`) && lines.groundAt(p.x, p.z) <= p.y,
      source: 'land_prep.water',
    }, 1), () => lines.dispose());
  if (!found.length) return null;
  const p = found[0].position;
  return { name: 'water', position: new (require('vec3'))(p.x, p.y, p.z) };
}

// THE WATER SEARCH, the fleet's one escalation (sector_finder) after the body's whole loaded area found none:
//   1. the book: the nearest sector whose page records water open to the sky, walked to its stand and searched from
//      there; a miss turns the page or passes it, and the next is tried (at most WATER_WALK_LIMIT);
//   2. no page: the body scans the next frontier sector and the fill ends there, the pour waiting for a later visit.
// waterAfield(bot) → the source found from a book stand, or null.
async function waterAfield(bot) {
  for (let walks = 0; walks < WATER_WALK_LIMIT; walks++) {
    const step = await finder.escalate(bot, { item: 'water', categories: finder.categoriesFor({ blocks: ['water'] }) });
    if (!step.moved) {
      watcher.warn(TAG, `WATER_ABSENT reason=${step.reason} walks=${walks} — no open water source where the body stood or in the book`);
      return null;
    }
    const source = await openWaterSource(bot);
    const at = source ? `has a source at (${source.position.x},${source.position.y},${source.position.z})` : 'searched from its stand, no open source';
    watcher.summary(TAG, `water search: book sector ${step.sector} ${at}.`);
    if (source) return source;
  }
  watcher.warn(TAG, `WATER_ABSENT reason=walk_limit walks=${WATER_WALK_LIMIT}`);
  return null;
}

// fillBucket(bot, want) → true once the pocket holds a water bucket, filling up to `want` of them: ONE TENDER CARRIES
// EVERY BUCKET THE CREW HAS (the kit keeps two), so a visit with more than one cell to pour fills them all in one trip to
// the water and pours them one after another. Water buckets banked in a chest (pours that did not happen) are taken as
// they are; then the pocket's empty buckets, and the crew's from the chests, are taken to an open water source found by
// THE WATER SEARCH and filled there. False (with the reason said) when no water bucket could be had; the pour then
// waits for a later visit. null when a chest pull abandoned to the judge (Law 4: the caller stops).
async function fillBucket(bot, want = 1) {
  const count = (name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  if (count('water_bucket') >= want) return true;
  const banked = Math.min(inventoryLens.inChests('water_bucket'), want - count('water_bucket'));
  if (banked > 0) {
    const got = await inventorySwapper.retrieveItems(bot, 'water_bucket', banked);
    if (!got) return null;
    if (got.success) watcher.summary(TAG, `Pulled ${banked} filled water bucket(s) from chest ${got.station_id}.`);
    if (count('water_bucket') >= want) return true;
  }
  const empties = Math.min(inventoryLens.inChests('bucket'), want - count('water_bucket') - count('bucket'));
  if (empties > 0) {
    const got = await inventorySwapper.retrieveItems(bot, 'bucket', empties);
    if (!got) return null;
    if (got.success) watcher.summary(TAG, `Pulled ${empties} bucket(s) from chest ${got.station_id} to fill.`);
  }
  if (count('bucket') === 0) {
    if (count('water_bucket') > 0) return true;
    watcher.summary(TAG, 'water to pour but no bucket in the pocket or the chests — the pour waits.');
    return false;
  }
  for (let tries = 1; tries <= DIP_TRIES && count('bucket') > 0 && count('water_bucket') < want;) {
    const source = await openWaterSource(bot) || await waterAfield(bot);
    if (!source) {
      watcher.summary(TAG, 'water to pour but the water search is spent — the pour waits.');
      break;
    }
    const p = source.position;
    const nav = await locomotion.goTo({ x: p.x, y: p.y, z: p.z, require_los: true, leg: 'work' });
    // THE BUCKET IS USED ONLY ON A DIP THAT CAN TAKE: the source's surface in reach of the eye, and nothing but air
    // between them — the server's fill follows the look to the first source it meets. Otherwise nothing is clicked
    // and the source is passed (dipPassed), and the next one is tried.
    const refused = !nav || nav.arrived === false ? `not reached (${nav?.reason || 'no route'})` : dipBlocked(bot, p);
    if (refused) {
      _dipPassed.set(dipKey(p), Date.now() + DIP_PASS_MS);
      watcher.summary(TAG, `DIP_REFUSED source=(${p.x},${p.y},${p.z}) try=${tries}/${DIP_TRIES} reason=${refused} — passed for ${DIP_PASS_MS / 60000} min; no bucket used.`);
      tries++;
      continue;
    }
    // One cell refills (the pool) and is dipped again for the next bucket; a source that does not is left for the next.
    while (count('bucket') > 0 && count('water_bucket') < want) {
      const before = count('water_bucket');
      const seen = dipScene(bot, p);
      const bucket = bot.inventory.items().find(i => i.name === 'bucket');
      await guardExternal(TAG, `equip/lookAt/fill at (${p.x},${p.y},${p.z})`, async () => {
        await bot.equip(bucket, 'hand');
        await bot.lookAt(dipPoint(p), true);
        bot.activateItem();
      });
      await sleep(300);
      if (count('water_bucket') > before) {
        watcher.summary(TAG, `Filled a water bucket at (${p.x},${p.y},${p.z}) (${count('water_bucket')} of ${want}).`);
        await sleep(300);   // the cell refills before the next dip
        if (!require('@utils/gravity_utils').isWaterSource(bot, p.x, p.y, p.z)) break;
        continue;
      }
      // THE EMPTY DIP IS DESCRIBED, not explained: the scene at the click and after it, and whether the water bucket
      // came late (a slow server, not a missed dip).
      await sleep(1000);
      const late = count('water_bucket') > before;
      _dipPassed.set(dipKey(p), Infinity);
      watcher.warn(TAG, `DIP_BANNED source=(${p.x},${p.y},${p.z}) try=${tries}/${DIP_TRIES} reason=came_up_empty eye_distance=${eyeOf(bot).distanceTo(dipPoint(p)).toFixed(1)} `
        + `at_click=[${seen}] after=[${dipScene(bot, p)}] late_fill=${late ? 1 : 0} — banned for the rest of the run.`);
      tries++;
      break;
    }
  }
  if (count('water_bucket') > 0) return true;
  watcher.summary(TAG, `water to pour but ${DIP_TRIES} source(s) in a row would not fill the bucket — the pour waits.`);
  return false;
}

// dipScene(bot, p) → what stands round a dip, for the record: the source cell (its name and water level), the cell over
// it, the body's feet and head cells, what the cursor's ray meets (a solid block only), and the item in hand.
function dipScene(bot, p) {
  const { waterLevel } = require('@utils/gravity_utils');
  const name = (v) => bot.blockAt(v)?.name || 'unloaded';
  const feet = bot.entity.position.floored();
  const cursor = bot.blockAtCursor ? bot.blockAtCursor(6) : null;
  return `source=${name(p)}:${waterLevel(bot, p.x, p.y, p.z) ?? '-'} over=${name(p.offset(0, 1, 0))} feet=${name(feet)} head=${name(feet.offset(0, 1, 0))} `
    + `cursor=${cursor ? `${cursor.name}@${cursor.position.x},${cursor.position.y},${cursor.position.z}` : 'none'} held=${bot.heldItem?.name || 'hand'}`;
}

// dipBlocked(bot, p) → why a bucket dipped from where the body stands would not reach the source at p, or null. The look
// goes to the source's surface; every cell the line crosses before it must be open air, since a solid block stops the
// click and other water is filled first.
const DIP_TRIES = 3;
const DIP_STEP = 0.1;
const eyeOf = (bot) => bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
const dipPoint = (p) => p.offset(0.5, 0.85, 0.5);
function dipBlocked(bot, p) {
  const { BLOCK_REACH } = require('@utils/fragment_utils');
  const eye = eyeOf(bot), to = dipPoint(p);
  const d = eye.distanceTo(to);
  if (d > BLOCK_REACH) return `out_of_reach eye_distance=${d.toFixed(1)}`;
  const dir = to.minus(eye).scaled(1 / d);
  for (let t = 0; t < d; t += DIP_STEP) {
    const c = eye.plus(dir.scaled(t)).floored();
    if (c.x === p.x && c.y === p.y && c.z === p.z) return null;
    const b = bot.blockAt(c);
    if (!b) return `unloaded_cell (${c.x},${c.y},${c.z})`;
    if (b.name.includes('water')) return `water_before_the_source at (${c.x},${c.y},${c.z})`;
    if (b.boundingBox !== 'empty') return `line_blocked_by ${b.name} at (${c.x},${c.y},${c.z})`;
  }
  return null;
}

// prepare(bot, { seeds, boneMeal, water }) → bulk-supply the whole cluster visit ONCE, then return control
// to the manager (Law 15 API — no onward route). Returns TRUE when the visit may proceed, FALSE when an API
// abandoned to the judge, so the manager stops with no second signal routed (Law 4).
async function prepare(bot, { seeds = {}, boneMeal = 0, water = 0 } = {}) {
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
  // `seeds` is { seed item: count }, one entry per crop the visit sows (wheat seeds, sugar cane).
  const wants = [];
  for (const [seed, count] of Object.entries(seeds)) {
    const pocketSeeds = countInInventory(seed, pocketCounts(bot));
    const want = count - pocketSeeds;
    if (want > 0) wants.push(`${seed} ${want}`);
    const chestSeeds = inventoryLens.inChests(seed);
    if (want > 0 && chestSeeds > 0) {
      const got = await inventorySwapper.retrieveItems(bot, seed, Math.min(want, chestSeeds));
      if (!got) return false;              // a chest existed at gate time but is gone now → already abandoned (Law 15/4)
      if (got.success) watcher.summary(TAG, `Pulled ${got.transferred} ${seed} from chest ${got.station_id}.`);
      // {success:false} = the chest opened empty (a peer beat us to it). NOT an abandon and NOT fatal: the
      // plots that wanted seeds simply skip planting this visit and stay actionable to re-post next cycle
      // (skip-and-continue); the manager owns the visit's verdict.
    }
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
    // The bone meal kept for white dye stays in storage (architect_config.DYE_STOCK); the field takes what lies past it.
    const chestBone = inventoryLens.inChests('bone_meal') - require('@thinking/architect_config').DYE_STOCK.bone_meal;
    if (wantBone > 0 && chestBone > 0) {
      const got = await inventorySwapper.retrieveItems(bot, 'bone_meal', Math.min(wantBone, chestBone));
      if (!got) return false;   // a chest existed at gate time and is gone now → already abandoned (Law 15/4)
      if (got.success) watcher.summary(TAG, `Pulled ${got.transferred} bone_meal from chest ${got.station_id}.`);
      // {success:false} = a peer emptied it first. Not fatal and not an abandon: the growing plots simply
      // go untreated this visit and re-post next cycle, exactly as a seedless plant plot does.
    }
  }

  // ── 4. WATER ──────────────────────────────────────────────────────
  // Best-effort like seeds: without a filled bucket the water cell is left for a later visit and the rest of
  // the field is still tended.
  let filled = null;
  if (water > 0) {
    filled = await fillBucket(bot, water);
    if (filled === null) return false;   // a chest existed at gate time and is gone now → already abandoned (Law 15/4)
  }

  watcher.summary(TAG, `prepped hoe/seeds(want ${wants.join(', ') || 'none'})/bone_meal(${boneMeal})`
    + (water > 0 ? `/water(${filled ? 'bucket filled' : 'no bucket filled'})` : '') + ' → manager tend loop');
  return true;
}

module.exports = { prepare, openWaterSource, fillBucket };
