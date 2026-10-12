// fragment: drop_collector
// purpose: Law 15 API — collectNearby(bot) picks up the drops the body can WALK to in a few blocks, one at
//          a time, until none is left or the sweep's clock runs out. Every caller shares it: a felled tree,
//          a tunnel segment, a build pass, a seed patch, a fight's spoils.
// invariants:
//  - Throws only on a coding violation (missing bot) — Law 13. Every other outcome is a normal
//    `success: true` return.
//  - A PICKUP WALKS AND DOES NOTHING ELSE: the route is searched with no dig, no place and no drop off a
//    ledge, and walked the same way (walk_only).
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
    && hasSkyAccess(readerFor(bot), Math.round(pos.x), Math.round(pos.z), Math.round(pos.y), NIGHT_SKY_SCAN_UP)) return 'night_open_sky';
  return null;
}

// How far one event's drops scatter — the radius `ground_drop_scanner` offers a body its own drops within.
const CLUMP_RADIUS = 4;
// The pickup's one criterion: the longest walk, in blocks stepped, a drop is worth. A block is broken from
// at most reach away and its item hops about a block, so the work's own drops are a few steps off.
const MAX_WALK_BLOCKS = 8;
// The sweep's clock. A ceiling, not a duration: the loop ends the moment nothing collectable remains.
const SWEEP_TIMEOUT_MS = 10000;
// Per-candidate slice of that clock for the route search, so one drop cannot spend the whole sweep.
const PRICE_SLICE_MS = 25;

// priceRouteTo(bot, pos, deadlineMs, walkOnly) → { reachable, cost, steps, straightLine, complete } — the one
// route price (Law 16), shared by this fragment and ground salvage's worth test. `steps` is the blocks walked.
// `complete:true` is a proof no route exists; `complete:false` means the clock stopped the search.
async function priceRouteTo(bot, pos, deadlineMs, walkOnly = false) {
  // Must obey computeAStar's contract: `startPos` is the floor (block stood on), `goal` is
  // `{type:'position'|'multi'|'los'}`. The y-1 matches how navigator derives a floor from a target.
  const from = bot.entity.position.floored().offset(0, -1, 0);
  const goalFloor = new Vec3(Math.round(pos.x), Math.round(pos.y) - 1, Math.round(pos.z));
  const straight = bot.entity.position.distanceTo(new Vec3(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)));
  // The same protected voxels and closed boxes the navigator walks under, so a route priced here is a
  // route the walk will be given.
  const navigator = require('@locomotion/navigator');
  const goal = { type: 'position', pos: goalFloor };
  const res = await computeAStar(bot, from, goal,
    { ...(deadlineMs ? { deadlineMs } : {}), owner: 'price_drop', allowWorldAlteration: !walkOnly,
      protectedBlocks: navigator.loadProtectedBlocks(bot), closedBoxes: navigator.loadClosedBoxes(goal) });
  if (!res || res.partial || !Array.isArray(res.path) || res.path.length === 0) {
    return { reachable: false, cost: Infinity, steps: Infinity, straightLine: straight, complete: !!(res && res.complete) };
  }
  return { reachable: true, cost: res.cost, steps: res.path.length, straightLine: straight, complete: !!res.complete };
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

  while (!timedOut()) {
    await combatCheckpoint(bot, 'collect');

    // Re-sensed every pass (Invariant B). A drop farther off in a straight line than the walk allows cannot
    // have a route inside it, so it is never priced.
    const here = bot.entity.position;
    const nearby = Object.values(bot.entities || {})
      .filter(e => isDroppedItemEntity(e) && e.position && here.distanceTo(e.position) <= MAX_WALK_BLOCKS
        && !skippedIds.has(e.id) && !unreachableIds.has(e.id) && !longWalkIds.has(e.id))
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
          pos: new Vec3(Math.round(e.position.x), Math.round(e.position.y), Math.round(e.position.z)) };
      })
      .sort((a, b) => here.distanceTo(a.pos) - here.distanceTo(b.pos));

    if (nearby.length === 0) { outcome = 'no_drops'; break; }

    let selected = null;
    for (const cand of nearby) {
      const remaining = SWEEP_TIMEOUT_MS - (Date.now() - startWindow);
      if (remaining <= 0) break;
      const priced = await priceRouteTo(bot, cand.pos, Math.min(remaining, PRICE_SLICE_MS), walkOnly);
      if (priced.reachable && priced.steps <= MAX_WALK_BLOCKS) { selected = { item: cand, priced }; break; }
      if (priced.reachable) longWalkIds.add(cand.id);
      // Only a complete search proves a drop unreachable; an incomplete one just ran out of clock.
      else if (priced.complete) unreachableIds.add(cand.id);
    }
    if (!selected) {
      // Running out of clock asserts nothing about the ground; the two demand opposite readings (Law 25).
      outcome = timedOut() ? 'timed_out' : 'no_route_to_drops';
      break;
    }

    const d = selected.item;
    // Logged ahead of locomotion's own trace so the walk that follows has a stated reason.
    watcher.summary('drop_collector', `👁️ Spotted ${d.type}×${d.count || 1} at (${d.pos.x}, ${d.pos.y}, ${d.pos.z}) `
      + `walk=${selected.priced.steps} block(s) — sending locomotion request to walk to it.`);

    // Walk onto the drop's block so Minecraft's pickup radius does the rest. If goTo cannot get there it
    // abandons (Law 15, nested API) and this call never resolves.
    await dispatcher.goTo({ x: d.pos.x, y: d.pos.y, z: d.pos.z, walk_only: walkOnly, leg: 'work' });

    const stillThere = Object.values(bot.entities || {}).find(e => e && e.id === d.id);
    if (!stillThere) {
      pickedCount += 1;
      watcher.summary('drop_collector', `🧲 Picked up ${d.type}`);
      continue;
    }
    // Arrived and still out of pickup range: left, so the same goal is never requested twice in one sweep.
    const postDist = stillThere.position ? bot.entity.position.distanceTo(stillThere.position) : Infinity;
    if (postDist > 1.2) { skippedIds.add(d.id); continue; }
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
  // Exported so ground salvage prices its haul with the same search this fragment approaches with (Law 16).
  priceRouteTo,
  // Exported so `ground_drop_scanner` sizes its offer radius off the same scatter distance (Law 16).
  CLUMP_RADIUS,
};
