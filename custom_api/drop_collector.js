// fragment: drop_collector
// purpose: Law 15 API — collectNearby(bot) scans for nearby dropped items and walks to
//          each one via the locomotion ladder (recursive goTo) until the global time
//          window is exhausted or no (visible) drops remain. Called directly by
//          block_puncher, build_executor, mining_executor and tree_harvester right
//          after they finish digging/placing — there is no signal-bus entry point.
// invariants:
//  - collectNearby only throws on a coding violation (missing bot) — Law 13. Every other
//    outcome (no drops, none reachable, time exhausted, emergency abort) is a normal
//    `success: true` return. drop_collector never reports a "failure" to
//    recursive_judge — not being in the right spot to collect something is not an error.
//  - A PRICED ROUTE, not a raycast, decides whether a drop is approachable (see below).
//  - Movement is delegated to locomotion_dispatcher.goTo (recursive use of the
//    locomotion ladder, Law 15) instead of native bot.setControlState.
//
// ── WHY THE RAYCAST IS GONE ─────────────────────────────────────────────────────────────────
// The old gate asked "can I SEE it", and then handed the drop to a walker that has to GET to
// it. Those are different questions and they disagree in both directions, each with its own
// cost. A drop across a two-block ravine is in plain sight and is a long walk down and back
// up — accepted, then paid for. A drop one step around a doorway has no clear line at all —
// refused, though it was a second away. Sight was only ever standing in for reachability
// because reachability was expensive; it stopped being expensive once the search lost its
// node cap and the voxel reader made the reads cheap.
//
// So the gate is now the pathfinder's own verdict, which is the same instrument that will do
// the walking — one question, asked once, by the thing that has to answer for it (Law 16).
// `cost` is the route's true price, so this also produces the number the retrieval economics
// need; priceRouteTo is exported for exactly that reuse rather than copied there.
//
// UNCAPPED BY COST, AND BOUNDED BY TIME INSTEAD — the whole shape of this fragment. There is no
// distance leash and no cost ceiling: a route's PRICE and a route's DISTANCE are both guesses about
// difficulty, while the search's own clock measures it directly. An easy drop resolves in single-digit
// milliseconds whether it is four blocks away or forty; a hard one does not resolve at all, at any
// distance. So two clocks bound everything — PRICE_SLICE_MS per candidate and
// GLOBAL_COLLECTION_WINDOW_MS for the sweep — and difficulty is read off the instrument that has to
// answer for it rather than predicted from geometry.
//
// NESTED API (Law 15): drop_collector is an API that calls the locomotion API (goTo).
// The locomotion API already owns the abandonment clause — if it can't reach a target it
// gives up after retrying and starts a fresh chain at recursive_judge on its own, so the
// awaited goTo simply never resolves. drop_collector therefore adds NO timeout/retry of
// its own; the inner API's clause covers the whole nest.

const watcher = require('@kernel/watcher');
const Vec3 = require('vec3');
// Entered through combatCheckpoint, never battleStations directly. One process-wide 500 ms clock,
// shared with the dig and drive primitives that carry the same gate, plus the engaging/escaping
// bypass so combat's own arms cannot re-enter it. The whole reasoning is in its header; a call a
// primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { computeAStar } = require('@utils/pathfinding_utils');
const { hasSkyAccess } = require('@utils/site_geometry');
const { makeVoxelReader } = require('@utils/voxel_reader');
const { isNightTime } = require('@thinking/architect_config');
const { belowDepthFloor } = require('@utils/movement/terrain_predicates');

// The adapter across site_geometry's reader seam, memoized per bot — the same shape and the same reason
// find_buildingspot's carries (site_geometry takes no dependency at all, so each caller supplies its own
// blockAt). `needs:['type']` keeps it on the per-number fast path: hasSkyAccess asks only isPassable,
// which is a function of the block's number alone.
const _readers = new WeakMap();
const readerFor = (bot) => {
  let r = _readers.get(bot);
  if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
  return r;
};

// THERE IS NO DISTANCE LEASH — deliberately, and it is the one thing a successor is most likely to
// re-add. A box around the bot answers "is this drop close?" when the only question that matters is
// "is this drop EASY?", and the two come apart in both directions: a drop four blocks away on the far
// side of a sealed wall is unreachable, and a drop thirty blocks away down an open corridor is a
// straight walk. A radius rejects the second and admits the first — precisely backwards. The clock
// gets it right in both cases for free, because terrain difficulty is what a search SPENDS.
//
// What replaces it, and why nothing is unbounded: candidates are sorted nearest-first from the bot's
// LIVE position each pass, so the sweep always works outward from where the body actually is; each
// candidate gets at most PRICE_SLICE_MS to prove itself; and the whole sweep dies at
// GLOBAL_COLLECTION_WINDOW_MS. The far drop is not forbidden, it is simply never reached before the
// clock runs out — which is the correct outcome rather than an enforced one.

// How close two drops must be for a route proved to one to count as proved for the other. 4 blocks
// horizontally covers the two shapes this exists for — a felled tree's logs and a death pile's heap —
// both of which land inside a few blocks of one point. VERTICAL is tighter (2) because a drop one storey
// up or down is a different reachability problem even when it is directly overhead: the horizontal
// neighbour shares the floor the route ended on, the vertical one does not.
const CLUMP_RADIUS = 4;
const CLUMP_VERTICAL_RADIUS = 2;
// Total time budget before this fragment returns control, and — with the distance leash gone — THE
// ONLY THING BOUNDING HOW FAR THE BOT CAN GET FROM WHERE IT STARTED. That second job is why the
// number cannot simply be raised to collect more: a sweep's reach is whatever the body can walk in
// this much time, so the window IS the leash, expressed in the unit that actually limits it.
//
// It is a CEILING, not a duration: the loop breaks the moment nothing eligible remains, so clear
// ground costs one scan and the budget is only ever spent where drops are genuinely still on the
// floor. A sweep that ends on the clock with items left reports `time_window_exhausted` and a
// non-zero `left`, which is the row that says the ceiling is binding rather than the ground being
// clean.
const GLOBAL_COLLECTION_WINDOW_MS = 10000;
// Per-candidate slice of that window, and THE EFFORT GATE — the one number that decides what this
// fragment is for. It is deliberately set BELOW the slowest route the pathfinder can actually solve,
// and a successor reading that as a bug will "fix" it straight back into the behaviour it was chosen
// to remove. Collection is opportunistic tidying that runs inside somebody else's job; a drop is
// worth having only while it is CHEAP. So the gate does not ask "can this be reached" — it asks "can
// this be reached EASILY", and a walkable-but-expensive drop is declined on purpose.
//
// SIZED FROM MEASURED SEARCHES ACROSS EVERY OWNER, not from this fragment alone: route-search time
// is set by terrain, not by distance, and the whole fleet's distribution is the same shape — a heavy
// majority resolving in low single-digit milliseconds, a thin tail of hard ones, then a cliff into
// searches that never resolve at all. This slice sits at the top of the easy band, a few multiples
// above the typical resolve and well under the hard tail.
//
// WHAT IT COSTS, stated so nobody rediscovers it as a defect: routes in that tail get declined, and
// the decline is a CLOCK verdict, not a terrain one. The distinction is already load-bearing below —
// `unreachableIds` only bans on a COMPLETE search, and at this slice a no-route disproof essentially
// never completes, so nothing is permanently banned and every declined drop is simply re-offered next
// pass. A tight slice is affordable precisely because it is cheap to be wrong: the same 32-member
// pile that could once eat an entire window now costs a fraction of one to decline outright.
//
// NARROWS THE PERMANENT BAN, knowingly. `unreachableIds` only admits a drop on a COMPLETE search, and
// completeness is cheap in exactly one shape — a walled-in drop whose frontier runs dry in a few nodes —
// and unaffordable in every other, because disproving a route in open terrain means exhausting the loaded
// region. So the slice keeps the ban that actually fires (the sealed pocket) and forfeits one that never
// finishes anyway. Re-pricing a bad drop next sweep costs the slice; the alternative was adjudicating
// nothing at all.
const PRICE_SLICE_MS = 25;

// A drop perched on tree canopy is a Law 17 trap: leaves are walk-ONTO-able but not reliably
// traversable, so a bot that climbs a tree for a loose sapling/apple strands itself on the canopy
// and then livelocks every later goTo. Leaving a stray item is far cheaper than stranding the bot,
// and the leash already leaves drops by design. isCanopyDrop disqualifies a drop on EITHER signal:
// its stand cell is perched >CANOPY_RISE_MAX above the ground collection started on, OR that cell
// sits on/in leaves. groundY = the bot's y when collection began (a cheap, correct "local ground"
// proxy — right after a fell/build the bot is standing on the ground).
const CANOPY_RISE_MAX = 1;                 // blocks above local ground before a drop counts as "perched"
function isCanopyDrop(bot, pos, groundY) {
  if (Math.round(pos.y) - Math.round(groundY) > CANOPY_RISE_MAX) return true;
  const nameAt = (dy) => {
    const b = bot.blockAt(new Vec3(Math.round(pos.x), Math.round(pos.y) + dy, Math.round(pos.z)));
    return b && b.name ? b.name : '';
  };
  return nameAt(-1).includes('leaves') || nameAt(0).includes('leaves');
}

// ── A DROP UNDER OPEN SKY IS NOT COLLECTED AT NIGHT ─────────────────────────────────────────────────
// Night restricts bots to chest-to-chest activity, crafting, and mining — nothing outside the
// headframe after dusk. That rule has to be enforced separately here because collecting a drop is
// neither a job the board dispatches nor a step a job's rank list can blacklist: it is an
// opportunistic errand that runs INSIDE another job's loop, with its own route to the surface,
// invisible to both the job board and a step-level gate.
//
// THE TEST IS SKY ACCESS, NEVER A BLANKET NIGHT BAN. Banning collection at night outright would
// forbid a bot picking up the cobblestone it just mined, which is most of what it collects
// underground. `hasSkyAccess` is site_geometry's existing predicate for exactly this question (it
// labels a survey box surface-vs-cave) and it is on the reader's type-derivable fast path, so the
// column read costs a table lookup per cell and only runs after dusk at all.
//
// WHY skyLight IS OBSERVED BUT NOT THE GATE. `makeVoxelReader(bot, {needs:['skyLight']})` serves it
// honestly and refuses to fake it from the type table. It is arguably the BETTER signal: it measures
// how much sky actually reaches a cell, so it reads a winding shaft as dark where geometry can call
// it open. Two reasons it is not the gate yet: asking for it drops the reader off the fast path for
// every cell, and nothing in this fleet has ever consumed the field, so that it is populated here is
// a CLAIM, not a fact (Law 23). So the gate runs on geometry and the verdict line carries the
// skyLight the block reported beside it — real trace over time says whether the two agree, and the
// swap becomes evidence-backed instead of plausible.
const NIGHT_SKY_SCAN_UP = 24;   // shorter than site_geometry's 40: a drop 24 clear cells under sky is out.
function isNightSurfaceDrop(bot, pos) {
  if (!isNightTime()) return false;
  const x = Math.round(pos.x), y = Math.round(pos.y), z = Math.round(pos.z);
  return hasSkyAccess(readerFor(bot), x, z, y, NIGHT_SKY_SCAN_UP);
}

// The observation half of the note above — never a decision, only evidence. A block with no light data
// reports null rather than 0, because "dark" and "unknown" are opposite conclusions (Law 25).
function skyLightAt(bot, pos) {
  const b = bot.blockAt(new Vec3(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)));
  return b && Number.isFinite(b.skyLight) ? b.skyLight : null;
}

// A drop resting inside FINISHED WORK is left where it lies — same shape and same verdict as
// isCanopyDrop above, for a different reason.
//
// A bare coordinate is a STAND-HERE order (craft_handler's header records the original reasoning),
// so goTo must make the drop's cell occupiable. If that cell or the floor under it is a protected
// voxel, the only plan that reaches it DIGS THE BUILD OUT — and A* prices a protected dig at
// PROTECTED_VOXEL_DETOUR_BUDGET with no total-cost cap, so it must first disprove every cheaper route before it will
// return one, which for a dig inside a large build can run the search to exhaustion before the plan
// finally comes back digging the bot into its own headframe to stand on one dropped item.
//
// Nothing here re-prices anything: the protection was always in the cost model, and the defect was
// making the one cell it forbids into the GOAL, where its cost is PAID instead of AVOIDED. Skipping
// at the scan restores the keep-out on the one route that bypassed it. The header's own rule decides
// what to do about the item — leaving a stray item is far cheaper, and the leash already leaves
// drops by design.
//
// THE WRONG TURN, so a successor does not spend a round on it: `require_los: true` is what fixed the
// identical fault for the crafting station, and it is NOT the fix here. LOS makes the bot stand
// BESIDE the target, which is right for a block you reach out and touch and wrong for a drop —
// pickup happens by walking ONTO the item, so an LOS approach would arrive and collect nothing.
function isReservedDrop(protectedKeys, pos) {
  if (!protectedKeys) return false;   // pre-lock there is genuinely nothing built to protect
  const x = Math.round(pos.x), y = Math.round(pos.y), z = Math.round(pos.z);
  // Both cells, because the approach needs both: the bot OCCUPIES the item's cell and STANDS ON the
  // one below it (priceRouteTo derives that same floor with the same y-1).
  return protectedKeys.has(`${x},${y},${z}`) || protectedKeys.has(`${x},${y - 1},${z}`);
}

// priceRouteTo(bot, pos, deadlineMs) → { reachable, cost, straightLine, complete } — the ONE route price
// (Law 16), shared by this fragment's approach gate and by death-pile retrieval's worth test.
//
// `reachable:false` carries a real distinction the caller must not flatten. `complete:true` means the
// frontier emptied — a PROOF that no route exists in the world the bot can see. `complete:false` means a
// clock stopped the search, which supports only "nothing cheaper than what was proven", never
// "unreachable" (pathfinding_utils records that four-way verdict table at its census). A caller that bans
// a target on an incomplete search bans a place it never finished looking for.
async function priceRouteTo(bot, pos, deadlineMs) {
  // BOTH ARGUMENTS MUST OBEY computeAStar's CONTRACT: `startPos = the FLOOR (block stood ON)` and
  // `goal = {type:'position'|'multi'|'los'}`. Passing the bot's raw feet vector and a bare Vec3 (no
  // `.type`) makes `heuristic()` and `goalReached()` fall through all three branches inside the search
  // — an h of 0 turns A* into an undirected Dijkstra flood, and a goal test that is never true means
  // the search cannot succeed, only run until the frontier or the clock dies. Under that fault
  // `reachable:true` is unreturnable — every drop prices unreachable regardless of the real terrain —
  // and since death-pile retrieval's worth test shares this same price function, the same fault
  // silently zeroes out death-pile recovery too.
  //
  // The y-1 matches how navigator derives a floor from a target: an item rests ON a block, so round(y) is
  // the AIR cell it occupies and the cell to stand on is one below.
  const from = bot.entity.position.floored().offset(0, -1, 0);
  const goalFloor = new Vec3(Math.round(pos.x), Math.round(pos.y) - 1, Math.round(pos.z));
  const straight = bot.entity.position.distanceTo(new Vec3(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)));
  const res = await computeAStar(bot, from, { type: 'position', pos: goalFloor },
    deadlineMs ? { deadlineMs, owner: 'price_drop' } : { owner: 'price_drop' });
  if (!res || res.partial || !Array.isArray(res.path) || res.path.length === 0) {
    return { reachable: false, cost: Infinity, straightLine: straight, complete: !!(res && res.complete) };
  }
  return { reachable: true, cost: res.cost, straightLine: straight, complete: !!res.complete };
}

// Heuristic classifier & info extraction (ported / adapted from entity_detector for accuracy)
function isDroppedItemEntity(e) {
  if (!e) return false;
  const nameFields = [e.name, e.displayName, e.type, e.kind].filter(Boolean).map(v => String(v).toLowerCase());
  const combined = nameFields.join('|');
  const metaHasItem = Array.isArray(e.metadata) && e.metadata.some(m => m && (typeof m.itemId === 'number' || typeof m.itemCount === 'number' || (m.item && (typeof m.item.id === 'number' || typeof m.item.count === 'number' || typeof m.item.name === 'string'))));
  if (combined.includes('item')) return true;
  // Avoid deprecated e.objectType access (was triggering prismarine-entity warning)
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
  // Unguarded: every step below is an optional-chained read off the loaded registry, a plain data object
  // — there is no call here that can throw, and the `unknown_item` fallback beneath already covers a
  // lookup that finds nothing.
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
// collectNearby — Law 15 API. Scans for dropped items, prices a route to the nearest one, and calls
// locomotion_dispatcher.goTo to walk onto it (Minecraft auto-picks-up items the bot walks over), then
// RESCANS FROM SCRATCH. One item at a time with fresh sensing between each (Invariant B), never a
// route planned across a list — the world moves while the bot walks. Repeats until the global time
// window is exhausted, nothing collectable remains, or nothing remaining can be priced. Returns a
// summary object; never returns success:false — the only failure mode is a thrown coding-violation
// error (Law 13).
// ─────────────────────────────────────────────────────────────────────────────
async function collectNearby(bot) {
  bot = bot || global.bot;
  if (!bot?.entity?.position) {
    throw new Error('[drop_collector] CODING VIOLATION: collectNearby called with no bot loaded.');
  }

  const dispatcher = require('@locomotion/locomotion_dispatcher');

  // LOCAL GROUND, latched at the start of the sweep — the canopy gate's only reference and this
  // vector's only remaining job (the collection box it used to anchor is gone; see the header).
  // It must NOT track the live body: the gate asks "is this drop perched above the floor I am
  // working on", and re-reading it as the bot climbs would raise the reference every time the bot
  // got higher, loosening the gate exactly as the bot approaches the trap it exists to prevent
  // (Law 17). Latched once, it stays the floor collection began on.
  const origin = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };

  let initialFound = null;
  let pickedCount = 0;
  let maxSeen = 0;
  let outcome = null;
  const skippedIds = new Set();       // approached, couldn't close the final ~1 block
  const unreachableIds = new Set();   // a COMPLETE search proved no route — see the selection loop
  const canopyIds = new Set();        // drops left on canopy/perch — tracked so the skip is inspectable (Law 5)
  const reservedIds = new Set();      // drops lying inside finished work — see isReservedDrop
  const nightIds = new Set();         // drops under open sky after dusk — see isNightSurfaceDrop
  const deepIds = new Set();          // drops below the depth floor — that layer is not part of the world
  const clumpApproved = new Set();    // drops riding on a neighbour's proven route — see CLUMP ADMISSION
  const startWindow = Date.now();
  let iteration = 0;
  let clumpPickups = 0;               // how many approaches the admission bought without a search

  while (Date.now() - startWindow < GLOBAL_COLLECTION_WINDOW_MS) {
    iteration++;
    await combatCheckpoint(bot, 'collect');

    // Re-sensed every iteration rather than once per sweep (Invariant B): a peer places blocks while
    // this bot walks, so the set that was true at the top of the window is not the set that decides
    // the next approach. Cheap enough to pay for relative to the cost a stale answer would buy across
    // a full route search.
    const protectedKeys = require('@locomotion/navigator').loadProtectedBlocks(bot);

    // Scan environment directly from bot.entities (no perception layer) for item entities within radius
    const allEntities = Object.values(bot.entities || {});
    const drops = allEntities.filter(e => isDroppedItemEntity(e) && !skippedIds.has(e.id) && !unreachableIds.has(e.id));
    // Unguarded: every predicate below is ours. `catch → false` dropped the entity out of `nearby` with
    // no id recorded in any skip set, so a broken predicate read as "the ground is clear" and the whole
    // sweep closed `no_drops` on a measurement nobody took (Law 25). A defect must travel (Law 13).
    const nearby = drops.filter(e => {
      const pos = e.position || e.entity?.position;
      if (!pos) return false;
      if (belowDepthFloor(pos.y)) { deepIds.add(e.id); return false; }              // below the depth floor — that layer does not exist (architect_config)
      if (isCanopyDrop(bot, pos, origin.y)) { canopyIds.add(e.id); return false; }  // don't climb a tree for a loose drop (Law 17)
      if (isReservedDrop(protectedKeys, pos)) { reservedIds.add(e.id); return false; }  // don't dig the build out for one dirt
      if (isNightSurfaceDrop(bot, pos)) {                                              // don't leave the shaft after dusk (Law 17)
        if (!nightIds.has(e.id)) {
          nightIds.add(e.id);
          const sky = skyLightAt(bot, pos);
          watcher.summary('drop_collector', `🌙 drop at (${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}) is under open sky — leaving it until dawn`
            + ` [skyLight=${sky === null ? 'unreported' : sky}]`);
        }
        return false;
      }
      return true;
    }).map(e => {
      const info = extractDroppedItemInfo(bot, e);
      return { id: e.id, type: info.name, count: info.count, x: e.position.x, y: e.position.y, z: e.position.z };
    });

    if (nearby.length === 0) {
      outcome = 'no_drops';
      break;
    }
    if (initialFound === null) initialFound = nearby.length;
    if (nearby.length > maxSeen) maxSeen = nearby.length;

    // Nearest-first FROM THE LIVE BODY, then take the first drop that has a ROUTE. Two decisions here,
    // and both are load-bearing now that nothing else bounds the candidate set:
    //
    // Sorted from `bot.entity.position` rather than the sweep's start point, so the ordering follows the
    // body as it walks. That is what makes an unbounded candidate list behave: the sweep is always
    // working outward from where it actually is, so the near work is always adjudicated first and the
    // far work is what the clock never reaches.
    //
    // FIRST ROUTE WINS, never the cheapest of all candidates. Pricing every drop to pick a winner buys a
    // tie-break nobody can measure and pays a full search per drop for it — and each of those searches is
    // billed against the same window the walking has to come out of.
    const current = bot.entity.position;
    nearby.sort((a, b) => {
      const da = current.distanceTo(new Vec3(Math.round(a.x), Math.round(a.y), Math.round(a.z)));
      const db = current.distanceTo(new Vec3(Math.round(b.x), Math.round(b.y), Math.round(b.z)));
      return da - db;
    });
    // ── CLUMP ADMISSION ────────────────────────────────────────────────────────────────────────────
    // A route proved to ONE drop is a route proved to every drop standing beside it, so the clump is
    // admitted on that one search instead of paying a fresh A* per member. WHY it matters at all: a
    // felled tree or a death pile lands as one heap of many entities, and pricing each of them
    // separately against a shared budget can burn the whole window on a couple of searches and report
    // a terrain verdict (`no_route_to_drops`) for what was actually a clock failure, collecting nothing.
    //
    // The admission is deliberately a SEARCH skip, not a walk skip: the bot still calls goTo for each
    // member (that is how Minecraft picks an item up), but goTo over a few already-proven blocks is
    // the cheap case next to a fresh A* search. So the saving is the pricing, which is where the whole
    // budget was going.
    //
    // WHY A RADIUS AND NOT "THE WHOLE SCAN": inheriting a proof across the entire candidate set would
    // re-import the bug this replaces from the other side — a drop across a ravine is NOT reachable
    // because a distant one was. This radius is small enough that its members share terrain by
    // construction, which is the only thing that makes an inherited proof true rather than assumed.
    const clumpOf = (cand) => nearby.filter(o =>
      o.id !== cand.id &&
      Math.abs(o.x - cand.x) <= CLUMP_RADIUS &&
      Math.abs(o.z - cand.z) <= CLUMP_RADIUS &&
      Math.abs(o.y - cand.y) <= CLUMP_VERTICAL_RADIUS);

    let selected = null;
    // The nearest candidate riding on an earlier proof skips pricing entirely — this is the branch that
    // turns a 64-log heap into one search instead of 64.
    if (clumpApproved.has(nearby[0].id)) {
      const c = nearby[0];
      clumpPickups++;
      selected = { item: c, pos: new Vec3(Math.round(c.x), Math.round(c.y), Math.round(c.z)), priced: null };
    }
    for (const cand of (selected ? [] : nearby)) {
      const remaining = GLOBAL_COLLECTION_WINDOW_MS - (Date.now() - startWindow);
      if (remaining <= 0) break;
      const pos = new Vec3(Math.round(cand.x), Math.round(cand.y), Math.round(cand.z));
      // ONE CANDIDATE MAY NOT SPEND THE WHOLE WINDOW. Handing `remaining` to the first candidate looks
      // like generosity and is actually a cap of ONE: a route that EXISTS is found fast, while a route
      // that does not exist cannot be disproved until the frontier runs dry across the loaded region —
      // far past any budget this fragment will ever hold. Without a slice, an unreachable candidate #1
      // consumes the whole window and the sweep ends having adjudicated a single drop, reporting a
      // budget-exhausted outcome while every other candidate goes unlooked-at. Slicing turns one
      // guaranteed-useless verdict into several real ones, and it is what lets the clump admission
      // above ever fire — it is downstream of a reachable proof, and no proof was arriving without it.
      const priced = await priceRouteTo(bot, pos, Math.min(remaining, PRICE_SLICE_MS));
      if (priced.reachable) {
        selected = { item: cand, pos, priced };
        for (const o of clumpOf(cand)) clumpApproved.add(o.id);
        break;
      }
      // Only a COMPLETE search proves a drop unreachable; an incomplete one just ran out of clock, and
      // banning on it would blacklist a drop the bot could walk to. Skip permanently on proof, retry on
      // the next pass otherwise.
      if (priced.complete) {
        unreachableIds.add(cand.id);
        // Its neighbours inherit the DISPROOF for the same reason they inherit the proof — otherwise an
        // unreachable heap costs one full search per member before the window dies.
        for (const o of clumpOf(cand)) { unreachableIds.add(o.id); clumpApproved.delete(o.id); }
      }
    }
    if (!selected) {
      // NAME THE EXIT THAT WAS ACTUALLY TAKEN (Law 25). `no_route_to_drops` asserts terrain; running out
      // of clock before adjudicating anything asserts nothing about the world, and the two demand
      // opposite responses — one is a walled-off bot, the other is a budget too small for the pathfinder.
      outcome = (Date.now() - startWindow) >= GLOBAL_COLLECTION_WINDOW_MS ? 'pricing_budget_exhausted'
                                                                         : 'no_route_to_drops';
      break;
    }

    const d = selected.item;
    const targetPos = selected.pos;
    // story (not action) so this shows up in the trace ahead of locomotion's own logs —
    // otherwise goTo's movement appears with no explanation of why the bot started walking.
    watcher.summary('drop_collector', `👁️ Spotted ${d.type}×${d.count || 1} at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)}) `
      + (selected.priced
          ? `route=${selected.priced.cost.toFixed(1)} straight=${selected.priced.straightLine.toFixed(1)}`
          : 'route=inherited from a clump neighbour (no search)')
      + ' — sending locomotion request to walk to it.');

    // Walk onto the drop's block so Minecraft's pickup radius does the rest. If goTo
    // can't get there it abandons (see nested-API note in the header) — never resolves.
    await dispatcher.goTo({ x: targetPos.x, y: targetPos.y, z: targetPos.z });

    const stillThere = Object.values(bot.entities || {}).find(e => e && e.id === d.id);
    if (!stillThere) {
      pickedCount += 1;
      watcher.summary('drop_collector', `🧲 Picked up ${d.type}`);
      continue;
    }
    const postDist = stillThere.position
        ? bot.entity.position.distanceTo(stillThere.position)
        : Infinity;
    if (postDist > 1.2) {
      // Arrived-but-still-out-of-reach is NORMAL self-recovering behaviour (the drop settled
      // behind a lip, or a peer nudged it): we just skip it and move on. Law 5 says warn is for
      // genuinely degraded ops, not routine troubleshooting — so this is folded into the final
      // summary's `skipped` count (skippedIds.size), never a per-drop warn.
      skippedIds.add(d.id);
      continue;
    }
    watcher.summary('drop_collector', `⌛ Arrived but ${d.type} still present — rescanning.`);
  }

  const totalFound = initialFound ?? maxSeen ?? 0;
  if (!outcome) outcome = (pickedCount >= totalFound && totalFound > 0) ? 'complete' : 'time_window_exhausted';

  // Disjoint accounting (Law 5/6 — the old `not_picked` was one opaque count that also OVERLAPPED
  // `skipped`, so `not=11 skipped=3` read as either 11-or-14). Every within-leash, non-canopy drop SEEN
  // (total_found) falls in exactly ONE bucket, and the two failure buckets are kept apart because they
  // demand opposite responses: out_of_reach means the walk WORKED and the last metre didn't (nothing to
  // fix), no_route means the search proved there is no way there at all (a terrain problem worth seeing).
  // Folding them into one number is what would hide a bot walled off from its own drops. canopy is a
  // separate class — disqualified before any approach, so it never entered total_found.
  // picked + out_of_reach + no_route + left == total_found.
  const outOfReach = skippedIds.size;
  const noRoute = unreachableIds.size;
  const left = Math.max(totalFound - pickedCount - outOfReach - noRoute, 0);
  const summary = {
    success: true,
    result: outcome,
    total_found: totalFound,
    picked_up: pickedCount,
    out_of_reach: outOfReach,
    no_route: noRoute,
    left,
    canopy_skipped: canopyIds.size,
    reserved_skipped: reservedIds.size,
    night_skipped: nightIds.size,
    deep_skipped: deepIds.size,
    clump_pickups: clumpPickups,
  };
  watcher.summary('drop_collector',
    `drop_collector: ${summary.result} picked=${summary.picked_up}/${summary.total_found}` +
    ` (out_of_reach=${summary.out_of_reach}, no_route=${summary.no_route}, left=${summary.left})` +
    `${summary.canopy_skipped ? ` +canopy=${summary.canopy_skipped}(off-leash foliage)` : ''}` +
    // Named separately from canopy because it means something different to whoever reads it: a
    // non-zero here is items accumulating INSIDE the build, not out in the trees. If that number
    // grows run over run the answer is a sweep after the shell is sealed, not a change here.
    `${summary.reserved_skipped ? ` +reserved=${summary.reserved_skipped}(inside finished work)` : ''}` +
    // The number that says whether the night gate is COSTING anything. A large count is not a fault —
    // it is a hazardous surface errand being declined — but a large count that persists past dawn
    // would mean isNightTime is stuck, and only this row would show it.
    `${summary.night_skipped ? ` +night=${summary.night_skipped}(under open sky until dawn)` : ''}` +
    // Reported because it is the one number that says whether the clump admission is EARNING its
    // complexity: pickups that cost no search. A run where this stays 0 while picked>1 means drops are
    // arriving scattered and the radius is wrong for this world, not that the feature is idle.
    `${summary.clump_pickups ? ` +clump=${summary.clump_pickups}(approached on a neighbour's route)` : ''}`);
  return summary;
}

module.exports = {
  collectNearby,
  // Exported so death-pile retrieval prices its haul with the SAME search this fragment approaches with
  // (Law 16) — a second route price would let the job that decides to go and the API that does the going
  // disagree about whether the pile was ever reachable.
  priceRouteTo,
};
