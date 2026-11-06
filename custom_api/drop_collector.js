// fragment: drop_collector
// purpose: Law 15 API — collectNearby(bot) picks up the drops the body can WALK to in a few blocks, one at
//          a time, until none is left or the sweep's clock runs out. Every caller shares it: a felled tree,
//          a tunnel segment, a build pass, a seed patch, a fight's spoils.
// invariants:
//  - Throws only on a coding violation (missing bot) — Law 13. Every other outcome is a normal
//    `success: true` return.
//  - A PICKUP WALKS AND DOES NOTHING ELSE: the route is searched with no dig, no place and no drop off a
//    ledge, and walked the same way (walk_only). The one exception is the CHASE: a high-value drop no walk
//    reaches may be reached by a route with a few digs and places (CHASE below).
//  - A ROUTE ENDS BESIDE THE DROP: on any stand the item is picked up from (PICKUP_STANDS).
//  - ONE CRITERION, ONE CLOCK: a drop is collected when that walking route is at most MAX_WALK_BLOCKS long;
//    the sweep ends at SWEEP_TIMEOUT_MS. Three kinds of drop are left where they lie (leftWhereItLies).
//  - The route is priced by the search the navigator walks with (priceRouteTo, Law 16).
//  - Movement is delegated to locomotion_dispatcher.goTo (Law 15), which owns its own abandonment clause.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');
// Entered through combatCheckpoint, never battleStations directly — the shared 500 ms clock also
// carried by the dig and drive primitives.
const { combatCheckpoint } = require('@api/battle_stations');
const { computeAStar } = require('@utils/pathfinding_utils');
const { hasSkyAccess } = require('@utils/site_geometry');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { isNightTime } = require('@thinking/architect_config');
const { belowDepthFloor } = require('@utils/movement/terrain_predicates');

// Adapter across site_geometry's reader seam, memoized per bot. `needs:['type']` keeps it on the
// per-number fast path, since hasSkyAccess only needs isPassable.
const _readers = new WeakMap();
const readerFor = (bot) => {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
};

// ── THE DROPS A WALK CAN REACH AND THE BODY STILL LEAVES ─────────────────────────────────────────────
// Three, each a fact the route search cannot see. A drop in the waste pit is trash the fleet threw away.
// A drop under open sky after dusk is a surface errand inside another job's loop, invisible to the job
// board's own night gates (Law 17); a species that fears no night picks up at any hour. A drop below the
// depth floor lies in a layer that is not part of the world (architect_config).
const NIGHT_SKY_SCAN_UP = 24;
function leftWhereItLies(bot, pos) {
  if (require('@api/waste_pit').holds(pos)) return 'in_pit';
  if (belowDepthFloor(pos.y)) return 'below_depth_floor';
  if (isNightTime() && require('@kernel/bot_mandate').fearsTheNight()
    && hasSkyAccess(readerFor(bot), Math.floor(pos.x), Math.floor(pos.z), Math.floor(pos.y), NIGHT_SKY_SCAN_UP)) return 'night_open_sky';
  return null;
}

// How far one event's drops scatter — the radius `ground_drop_scanner` offers a body its own drops within.
const CLUMP_RADIUS = 4;
// The pickup's one criterion: the longest walk, in blocks stepped, a drop is worth. A block is broken from
// at most reach away and its item hops about a block, so the work's own drops are a few steps off.
const MAX_WALK_BLOCKS = 8;
// The sweep's clock. A ceiling, not a duration: the loop ends the moment nothing collectable remains.
const SWEEP_TIMEOUT_MS = 10000;
// Per-candidate slice of that clock for the route search, so one drop cannot spend the whole sweep. A pass that
// selected nothing and left a high-value drop unpriced (its searches ran out of their slice) runs again with the slice four times longer,
// up to PRICE_SLICE_MAX_MS: an underground graph is wider than open ground's, and ending the sweep there left the work's
// own drops on the floor as if no route existed.
const PRICE_SLICE_MS = 25;
const PRICE_SLICE_MAX_MS = 1600;

// priceRouteTo(bot, pos, deadlineMs, walkOnly) → { reachable, cost, steps, straightLine, complete } — the one
// route price (Law 16), shared by this fragment and ground salvage's worth test. `steps` is the blocks walked.
// `complete:true` is a proof no route exists; `complete:false` means the clock stopped the search.
// `toPickUp`: the route ends on any stand whose body takes the item at `pos` (PICKUP_STANDS), not on its cell, and
// the result carries that `stand` (the feet cell). A drop in the hole a dug wall block leaves lies in a cell no
// body can stand in, and is still picked up from beside it.
// `fromPos`: the route is priced from there instead of from the body (herd_executor's string of animals, priced
// animal to animal).
async function priceRouteTo(bot, pos, deadlineMs, walkOnly = false, toPickUp = false, fromPos = null) {
  // Must obey computeAStar's contract: `startPos` is the floor (block stood on), `goal` is
  // `{type:'position'|'multi'|'los'}`. The y-1 matches how navigator derives a floor from a target.
  const origin = fromPos ? new Vec3(fromPos.x, fromPos.y, fromPos.z) : bot.entity.position;
  const from = origin.floored().offset(0, -1, 0);
  // The cell the item lies in is its position floored: an item rests near its cell's middle, and rounding would name
  // the cell beside it half the time (in a one-wide tunnel, the wall), so the walk ended out of pickup range.
  const at = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  const straight = origin.distanceTo(at);
  // The same protected voxels and closed boxes the navigator walks under, so a route priced here is a
  // route the walk will be given.
  const navigator = require('@locomotion/navigator');
  const goal = toPickUp
    ? { type: 'multi', positions: [...PICKUP_STANDS.map(([dx, dy, dz]) => at.offset(dx, dy - 1, dz)), ...waterStands(bot, at)] }
    : { type: 'position', pos: at.offset(0, -1, 0) };
  const res = await computeAStar(bot, from, goal,
    { ...(deadlineMs ? { deadlineMs } : {}), owner: 'price_drop', allowWorldAlteration: !walkOnly,
      protectedBlocks: navigator.loadProtectedBlocks(bot), closedBoxes: navigator.loadClosedBoxes(goal) });
  if (!res || res.partial || !Array.isArray(res.path) || res.path.length === 0) {
    return { reachable: false, cost: Infinity, steps: Infinity, straightLine: straight, complete: !!(res && res.complete) };
  }
  const end = res.path[res.path.length - 1].pos;
  return { reachable: true, cost: res.cost, steps: res.path.length, straightLine: straight, complete: !!res.complete,
    stand: { x: end.x, y: end.y + 1, z: end.z },
    digs: res.path.filter(s => DIG_EDGES.has(s.edgeType)).length,
    places: res.path.filter(s => PLACE_EDGES.has(s.edgeType)).length };
}

// ── THE CHASE: A HIGH-VALUE DROP IS WORTH A DIG OR A PLACE ──────────────────────────────────────────
// Ore, coal and what the ore makes (architect_config.SURVEY_ORE_ITEM) is high value: a drop of it no walk reaches is
// chased along a route that may dig and place, inside CHASE for the whole route: no longer than MAX_WALK_BLOCKS,
// at most `digs` dig moves and `places` place moves (the pathfinder's EDGE CATALOG). Every other drop is taken only
// where a walk reaches it. The walk to a chased drop is searched again by the navigator with the same costs.
const CHASE = Object.freeze({ digs: 2, places: 2 });
const CHASE_SLICE_FACTOR = 4;   // the chase route's slice against the walk's: a dig route searches a wider graph
const DIG_EDGES = new Set(['dig_through', 'dig_down', 'dig_stair_down', 'dig_stair_up']);
const PLACE_EDGES = new Set(['bridge', 'pillar', 'water_bank_out']);
const highValue = (name) => require('@thinking/architect_config').SURVEY_ORE_ITEM.test(name);
const withinChase = (p) => p.steps <= MAX_WALK_BLOCKS && p.digs <= CHASE.digs && p.places <= CHASE.places;

// THE STANDS A BODY PICKS AN ITEM UP FROM, as feet offsets from the item's cell: Minecraft takes an item whose box
// meets the body's box grown by one block across and half a block up and down, so a body takes an item lying in any
// cell beside its own (corners too) whose floor is level with its feet or up to two blocks above them.
const PICKUP_STANDS = [];
for (let dy = -2; dy <= 0; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) PICKUP_STANDS.push([dx, dy, dz]);

// AN ITEM AFLOAT is taken from the water too: it floats at the top of its water cell, so it is in reach of a body standing
// on a bank block beside the cell (feet one above the water) and of a body swimming in the cell or one beside it. Both
// are the cells level with the item's (a swim node is its water cell, a walk node its floor block), offered only where
// the item's cell holds water; the route reaches a swim node through still water only (pathfinding_utils.isStillWater).
function waterStands(bot, at) {
  if (bot.blockAt(at)?.name !== 'water') return [];
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(at.offset(dx, 0, dz));
  return out;
}

// Classifies an entity as a dropped item by name, type and metadata heuristics.
function isDroppedItemEntity(e) {
  if (!e) return false;
  const nameFields = [e.name, e.displayName, e.type, e.kind].filter(Boolean).map(v => String(v).toLowerCase());
  const combined = nameFields.join('|');
  const metaHasItem = Array.isArray(e.metadata) && e.metadata.some(m => m && (typeof m.itemId === 'number' || typeof m.itemCount === 'number' || (m.item && (typeof m.item.id === 'number' || typeof m.item.count === 'number' || typeof m.item.name === 'string'))));
  if (combined.includes('item')) return true;
  // entityType 2 is the item-entity code; e.objectType is deprecated and unused here.
  if (e.entityType === 2) return true;
  // Fallback: explicit displayName check for pure 'Item'
  if (typeof e.displayName === 'string' && e.displayName.toLowerCase() === 'item') return true;
  return metaHasItem;
}

function extractDroppedItemInfo(bot, entity) {
  let id, count, name;
  const md = entity?.metadata;
  if (Array.isArray(md)) {
    for (const m of md) {
      if (!m) continue;
      if (typeof m.itemId === 'number') id = m.itemId;
      if (typeof m.itemCount === 'number') count = m.itemCount;
      if (m.item && typeof m.item === 'object') {
        if (typeof m.item.id === 'number') id = m.item.id;
        if (typeof m.item.count === 'number') count = m.item.count;
        if (typeof m.item.name === 'string') name = m.item.name;
      }
    }
  }
  if (typeof name === 'string' && name.includes(':')) name = name.split(':').pop();
  // Unguarded: every read below is optional-chained off the loaded registry, a plain data object with
  // no call that can throw; the `unknown_item` fallback below covers a lookup that finds nothing.
  if (!name && typeof id === 'number') {
    const reg = bot?.registry || {};
    const itemRec = reg.itemsById ? reg.itemsById[id] : undefined;
    if (itemRec?.name) name = itemRec.name;
    if (!name && reg.itemsArray && Array.isArray(reg.itemsArray)) {
      const found = reg.itemsArray.find(r => r && r.id === id);
      if (found?.name) name = found.name;
    }
    if (!name && reg.blocksById) {
      const blockRec = reg.blocksById[id];
      if (blockRec?.name) name = blockRec.name;
    }
  }
  if (!name) name = 'unknown_item';
  if (typeof count !== 'number' || count <= 0) count = 1;
  return { id, name, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// collectNearby — Law 15 API. Takes the nearest drop whose walking route is at most MAX_WALK_BLOCKS, walks
// onto it via locomotion_dispatcher.goTo (Minecraft picks up what the body walks over), then re-senses from
// scratch (Invariant B). Repeats until the sweep's clock runs out or nothing collectable remains. Returns a
// summary; the only failure mode is a thrown coding-violation error (Law 13).
// ─────────────────────────────────────────────────────────────────────────────
async function collectNearby(bot) {
  bot = bot || global.bot;
  const walkOnly = true;
  if (!bot?.entity?.position) {
    throw new Error('[drop_collector] CODING VIOLATION: collectNearby called with no bot loaded.');
  }

  const dispatcher = require('@locomotion/locomotion_dispatcher');

  let pickedCount = 0;
  let outcome = null;
  const seenIds = new Set();          // every drop a short walk could have reached, by straight line
  const skippedIds = new Set();       // walked to, still out of pickup range
  const unreachableIds = new Set();   // a COMPLETE search proved no walking route
  const longWalkIds = new Set();      // a walking route exists and is longer than MAX_WALK_BLOCKS
  const leftIds = new Map();          // drop id → why it is left where it lies (leftWhereItLies)
  const startWindow = Date.now();
  const timedOut = () => Date.now() - startWindow >= SWEEP_TIMEOUT_MS;
  let slice = PRICE_SLICE_MS;

  while (!timedOut()) {
    await combatCheckpoint(bot, 'collect');

    // Re-sensed every pass (Invariant B), by the fleet's ring search (@utils/ring_scan), nearest first. A drop
    // farther off in a straight line than the walk allows cannot have a route inside it, so it is never priced.
    const here = bot.entity.position;
    const nearby = require('@utils/ring_scan').entitiesNearest(bot, { reach: MAX_WALK_BLOCKS,
      match: e => isDroppedItemEntity(e) && here.distanceTo(e.position) <= MAX_WALK_BLOCKS
        && !skippedIds.has(e.id) && !unreachableIds.has(e.id) && !longWalkIds.has(e.id) })
      .map(r => r.entity)
      // Unguarded: a defect in the predicate must travel, never read as "ground is clear" (Law 25, Law 13).
      .filter(e => {
        const why = leftWhereItLies(bot, e.position);
        if (why) leftIds.set(e.id, why);
        return !why;
      })
      .map(e => {
        const info = extractDroppedItemInfo(bot, e);
        seenIds.add(e.id);
        return { id: e.id, type: info.name, count: info.count,
          pos: new Vec3(Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)) };
      });

    if (nearby.length === 0) { outcome = 'no_drops'; break; }

    let selected = null;
    let unpriced = 0;   // high-value drops whose searches all ran out of their slice this pass
    for (const cand of nearby) {
      const remaining = SWEEP_TIMEOUT_MS - (Date.now() - startWindow);
      if (remaining <= 0) break;
      let priced = await priceRouteTo(bot, cand.pos, Math.min(remaining, slice), walkOnly, true);
      if (priced.reachable && priced.steps <= MAX_WALK_BLOCKS) { selected = { item: cand, priced }; break; }
      // A high-value drop no walk reaches is chased: a route that may dig and place, inside the chase budget.
      if (highValue(cand.type)) {
        const chased = await priceRouteTo(bot, cand.pos, Math.min(SWEEP_TIMEOUT_MS - (Date.now() - startWindow), slice * CHASE_SLICE_FACTOR), false, true);
        if (chased.reachable && withinChase(chased)) { selected = { item: cand, priced: chased, chase: true }; break; }
        // The chase route decides a high-value drop: it is left only once the chase is answered too.
        priced = chased;
      }
      if (priced.reachable) longWalkIds.add(cand.id);
      // Only a complete search proves a drop unreachable; an incomplete one just ran out of clock.
      else if (priced.complete) unreachableIds.add(cand.id);
      else if (highValue(cand.type)) unpriced++;
    }
    if (!selected && unpriced > 0 && slice < PRICE_SLICE_MAX_MS && !timedOut()) { slice *= 4; continue; }
    if (!selected) {
      // Running out of clock asserts nothing about the ground; the two demand opposite readings (Law 25).
      outcome = timedOut() ? 'timed_out' : 'no_route_to_drops';
      break;
    }

    const d = selected.item;
    // Logged ahead of locomotion's own trace so the walk that follows has a stated reason.
    watcher.summary('drop_collector', selected.chase
      ? `🏃 go chase ${d.type}×${d.count || 1} at (${d.pos.x}, ${d.pos.y}, ${d.pos.z}) `
        + `route=${selected.priced.steps} block(s) digs=${selected.priced.digs} places=${selected.priced.places} — sending locomotion request.`
      : `👁️ Spotted ${d.type}×${d.count || 1} at (${d.pos.x}, ${d.pos.y}, ${d.pos.z}) `
        + `walk=${selected.priced.steps} block(s) — sending locomotion request to walk to it.`);

    // Walk to the stand the route ends on, the drop's own block or one beside it, so Minecraft's pickup radius
    // does the rest. If goTo cannot get there it abandons (Law 15, nested API) and this call never resolves.
    const s = selected.priced.stand;
    await dispatcher.goTo({ x: s.x, y: s.y, z: s.z, walk_only: walkOnly && !selected.chase, leg: 'work' });

    const stillThere = Object.values(bot.entities || {}).find(e => e && e.id === d.id);
    if (!stillThere) {
      pickedCount += 1;
      watcher.summary('drop_collector', `🧲 Picked up ${d.type}`);
      continue;
    }
    // Arrived and still out of pickup range: left, so the same goal is never requested twice in one sweep. In
    // range is the pickup box (PICKUP_STANDS): within 1.3 across on each axis, and up to 2.3 above the feet.
    const p = stillThere.position, b = bot.entity.position;
    const inRange = p && Math.abs(p.x - b.x) <= 1.3 && Math.abs(p.z - b.z) <= 1.3 && p.y - b.y >= -0.75 && p.y - b.y <= 2.3;
    if (!inRange) { skippedIds.add(d.id); continue; }
    watcher.summary('drop_collector', `⌛ Arrived but ${d.type} still present — rescanning.`);
  }

  if (!outcome) outcome = 'timed_out';
  const totalFound = seenIds.size;
  if (outcome === 'no_drops' && totalFound > 0 && pickedCount >= totalFound) outcome = 'complete';

  // Disjoint accounting (Law 5/6): picked + out_of_reach + no_route + long_walk + left == total_found.
  const summary = {
    success: true,
    result: outcome,
    total_found: totalFound,
    picked_up: pickedCount,
    out_of_reach: skippedIds.size,
    no_route: unreachableIds.size,
    long_walk: longWalkIds.size,
    left: Math.max(totalFound - pickedCount - skippedIds.size - unreachableIds.size - longWalkIds.size, 0),
  };
  const leftBy = {};
  for (const why of leftIds.values()) leftBy[why] = (leftBy[why] || 0) + 1;
  summary.left_where_it_lies = leftBy;
  watcher.summary('drop_collector',
    `drop_collector: ${summary.result} picked=${summary.picked_up}/${summary.total_found}` +
    ` (out_of_reach=${summary.out_of_reach}, no_route=${summary.no_route}, long_walk=${summary.long_walk}, left=${summary.left})` +
    ` max_walk=${MAX_WALK_BLOCKS}` +
    Object.entries(leftBy).map(([why, n]) => ` +${why}=${n}`).join(''));
  return summary;
}

module.exports = {
  collectNearby,
  // Exported so a pen's sweep (cull_executor.sweepPen) counts drops by the same test this fragment collects by (Law 16).
  isDroppedItemEntity,
  // Exported so ground salvage prices its haul with the same search this fragment approaches with (Law 16).
  priceRouteTo,
  // Exported so `ground_drop_scanner` sizes its offer radius off the same scatter distance (Law 16).
  CLUMP_RADIUS,
};
