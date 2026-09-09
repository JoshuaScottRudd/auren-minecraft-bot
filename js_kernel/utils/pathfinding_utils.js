// module: pathfinding_utils — A* pathfinder, one algorithm for all locomotion callers.
//
// Non-obvious contracts:
//  - Pure graph algorithm: no watcher, no signal_bus, no file I/O (Law 15 utility).
//  - Operates on FLOOR-block positions — y is the block stood ON, not the feet cell. Every edge
//    and goal check assumes this; mixing in a feet-Y coordinate silently corrupts the search.
//  - The parent map stores { parentKey, edgeType } per step so the executor knows HOW to cross
//    each cell (walk/climb/door/dig/bridge/swim/pillar), not just WHERE. There is no fall edge.
//  - Goals are always exact (position / multi / los) — locomotion never decides "close enough".
//  - Out of budget → returns the closest explored node with partial:true, so the SPA loop makes
//    incremental progress on long-range goals that have no proximity target.
//  - ASYNC + THROTTLED (Architect 2026-07-19): computeAStar is async and cedes a macrotask every ~one
//    server tick via the shared voxel_scan_throttle pacer — the SAME pacer the heavy scanners use
//    (Law 16, one pacer). WHY: the old flat 1500-node cap existed only to stop a long search freezing
//    the tick; it made the search return a distance-greedy PARTIAL before it could find the real
//    (longer, all-walkable) route down the mine staircase, so a deep cell dispatched the bot to carve
//    a diagonal shortcut that dead-ends at the room ceiling above its floor stand (live: TessaBot cell
//    62|13|-10, 64m48s, astar_no_path 6.4 short). Throttling instead of capping lets the budget go
//    effectively uncapped (a runaway backstop only) while NEVER blocking the shared world longer than a
//    tick — the Architect's ratio: a search that takes longer but never stalls the run beats a fast one
//    that does. Every caller therefore awaits it.

const Vec3 = require('vec3');
const { BLOCK_REACH, STATION_TYPES } = require('@utils/fragment_utils');
const { isWalkableSurface, isOpenTopContainer, isStationFloor, belowDepthFloor } = require('@utils/movement/terrain_predicates');
const { makeScanThrottle } = require('@utils/voxel_scan_throttle');
const { guardExternalSync } = require('@utils/external_library_guard');

// Interaction geometry — each value encodes a failure mode, not a preference.
const MIN_PLACEMENT_DIST = 0.5;  // closer: lookAt angle too steep, placeBlock/anchor clicks misfire
const LOS_MAX_Y_GAP = 2;         // steeper feet→target: placement fails even when the raycast passes
const LOS_REFINE_BUDGET = 30;    // extra nodes explored after a valid vantage to find a closer one (else it stops at 2.8 when 1.0 is one step away)
// No free-fall edge: the pathfinder never plans a straight drop. Every descent is a reversible
// one-block move — a diagonal stair (climb_down / dig_climb_down) where there is lateral room, or a
// vertical dig_down (one block, landing hazard-checked) where there is not. Jumping off a ledge and
// baritone-style parkour are disallowed outright (Architect 2026-07-14; Law 17 self-preservation +
// the reversibility invariant — a move with no return route is not a legal descent).

// ── Movement cost: four tiers + the per-edge catalog ─────────────────────────
// A* sums edge costs; cheapest route wins. The spread exists so altering/slogging through the world
// LOSES to a walk-around unless none exists. All finite — even PROTECTED_VOXEL_DETOUR_BUDGET is a number, not a ban, so an
// entombed bot can still carve out. Tune these tiers; there are no others.
//
// THREE MEASUREMENTS AND TWO POLICIES, and the split is the thing to keep straight. COST_LOW/HIGH/PLACE
// approximate real EFFORT. PROTECTED_VOXEL_DETOUR_BUDGET and FLOW_*_DETOUR_BUDGET below are DETOUR
// BUDGETS: nothing about the move is intrinsically harder, we simply prefer it not happen, and the
// number says how many extra walk-steps that preference is worth.
const COST_LOW   = 1.0;     // free traversal — cross the world unchanged
const COST_HIGH  = 15.0;    // dig one block / swim — ~15 walk-steps, so any shorter detour wins
const COST_PLACE = 25.0;    // place a block (pillar up, bridge a gap) — consumes inventory and commits a
                            //   permanent structure, so it costs MORE than digging; A* prefers a dig-stair
                            //   (COST_HIGH) or a walk-around over pillaring/bridging.
// PROTECTED_VOXEL_DETOUR_BUDGET — deliberately NOT named COST_*, because it is not the same kind of
// number as the three above and treating it as one is what mis-set it. COST_LOW/HIGH/PLACE approximate
// real EFFORT: a dig genuinely costs about fifteen walk-steps of time, so those are measurements. This is
// a POLICY: how many EXTRA steps — beyond the direct route — the bot should walk to spare one blueprint
// or station voxel. Nothing about digging a protected block is intrinsically expensive; we simply prefer
// it not happen.
//
// READ AS A DETOUR BUDGET, NEVER AS A JOURNEY CEILING, and the difference is not pedantry. A* sums edges
// over a WHOLE route, so a protected dig is added to whatever walking remains after it — it never
// replaces the journey. A 260-step walk across open ground therefore never "exceeds" this and never
// triggers a dig: the cut-through route would cost this budget PLUS the same 260 steps. The dig can only
// win where it is a genuine shortcut, and then only when the detour it saves is longer than this number.
//
// WHY 50 AND NOT THE 250 IT WAS: the number's real cost is not what it buys, it is what the search must
// spend to REJECT it. A* returns the cheapest route, so before it may accept an edge priced N it must
// rule out every route cheaper than N — expanding every cell within N walk-steps. At 250 that meant
// sweeping a 250-step radius, blind, every time a goal sat behind the build. Measured on the 2026-08-15
// soak: three routes of four to seven steps each examined ~310,000 cells and stood the body still for
// ~9s, while two genuine 200-step walks examined a third as many. Expansion tracks PRICE, not distance,
// so this constant sets a flood radius as surely as it sets a preference. 50 still refuses the cut
// wherever any walk-around under fifty extra steps exists, which is every ordinary perimeter, at a
// twenty-fifth of the search area.
const PROTECTED_VOXEL_DETOUR_BUDGET = 50.0;

// ── Flow creation: a dig that opens a face onto a liquid ─────────────────────
// Breaking a block that touches water or lava lets the liquid pour into the space just opened. The
// hole dug to pass through fills behind the body (or ahead of it): a water flow washes the bot off
// its route and re-floods the same cell on every retry, which is the classic way a digging bot gets
// stuck; a lava flow kills it. mineflayer-pathfinder carries the same rule as dontCreateFlow and
// treats it as a hard BAN — the move simply does not exist.
//
// A BAN IS WRONG HERE (Architect 2026-08-18, ruled at the table while porting the rule in). Auren digs
// to ESCAPE as often as to travel, so deleting the move would strand a bot whose only way out of a
// flooded shaft is through the wet wall — the same argument that makes PROTECTED_VOXEL_DETOUR_BUDGET a
// number and not a prohibition. So: a price, and one the search can always choose to pay.
//
// TWO TIERS, because the two liquids are not the same failure. A water flow is a nuisance — the route
// is lost and the bot re-plans wet. A lava breach is fatal (Law 17), so it is priced at the model's
// CEILING and therefore loses to every other move the cost table can express.
//
// WHY LAVA IS NOT PRICED HIGHER, since "lethal" invites a large number. Two reasons and both bind.
// (a) A cost sets a search FLOOD RADIUS (see PROTECTED_VOXEL_DETOUR_BUDGET above): before A* may accept
// an edge priced N it must rule out every route cheaper than N, so a "safely enormous" lava number
// re-creates the ~310,000-cell sweep the old 250 caused. (b) PROTECTED_VOXEL_DETOUR_BUDGET is documented
// — here and at the navigator's penalty ladder — as the most the fleet will ever pay for one edge, and a
// tier above it would be a second cost model beside the one this header describes (Law 16). Lava sits AT
// the ceiling rather than above it, which is why these are combined with Math.max at the charge sites
// and never added: no edge may leave this file priced above the ceiling.
const FLOW_DETOUR_BUDGET = 30.0;                                    // dig opens a face onto water
const LAVA_FLOW_DETOUR_BUDGET = PROTECTED_VOXEL_DETOUR_BUDGET;      // onto lava — the ceiling, BY REFERENCE so it cannot drift above it

// ── One search, goal-focused ─────────────────────────────────────────────────
// A single A* frontier (f = g + W*h) serves EVERY goal - a walk across town and a build anchor
// hanging in open air are the same search. Cost governs the ROUTE: a bridge/pillar costs 25x a walk,
// so a walk-around is always chosen when one exists; the build only happens where it is genuinely the
// cheapest (often only) route, the last gap into an air anchor.
//
// W = 1.0 (Architect 2026-08-04, ruled at the table). The heuristic is straight-line distance, which
// can never overestimate real travel, so at W=1.0 it is ADMISSIBLE and the returned route is PROVABLY
// the cheapest one that exists. That is the entire reason for the value: the Architect requires a
// binary answer - "this is the only way" or "I have the best way" - and a weighted search can deliver
// neither. At the previous W=1.5 the route was merely bounded at 1.5x optimal: it could be half again
// longer than the best route with nothing in the system able to tell.
//
// WHAT W>1 WAS GUARDING, because it was not arbitrary and removing it moves the failure, not deletes
// it. Weighting focused expansion at the goal so a distant or air-suspended cell was REACHED instead
// of the frontier flooding the cheap flat field and exhausting its budget short of the target (the
// failure a separate greedy "delivery" mode had been bolted on to paper over - deleted since, Law 16).
// At W=1.0 every search explores strictly more, so the guard that now fails first is the NODE BUDGET:
// an exhausted budget returns `partial: true`, and a partial cannot support "the only way" either.
// Optimality and completeness are two separate fixes and only the first is made here - if partial
// rates climb on air-anchor searches, MAX_NODES is the dial, never this constant.
const HEURISTIC_WEIGHT = 1.0;
//
// EDGE CATALOG — every edgeType the pathfinder emits, its walker (navigator.js), and its cost. This is
// the single inspection point for "what edges exist and what do they cost"; keep it in sync on a retune.
//   walk            COST_LOW  (1)      bridgeLevelStep   one flat cell            (leaf floor → COST_HIGH)
//   climb_up        COST_LOW  (1)      stairUpStep       step up an existing +1 tread
//   climb_down      COST_LOW  (1)      stairDownStep     step down an existing -1 floor (diagonal)
//   door            COST_LOW  (1)      stepToFeet        walk through a wooden door
//   swim            COST_HIGH (15)     swimStep          enter / traverse water
//   dig_through     COST_HIGH (15)     digThroughStep    dig a same-Y wall, step in
//   dig_down        COST_HIGH (15)     digDownStep       dig the floor, drop 1
//   dig_climb_up    COST_HIGH (15)     stairUpStep       dig a blocked +1 stair — the preferred ASCENT
//   dig_climb_down  COST_HIGH (15)     stairDownStep     dig a blocked -1 stair
//   bridge          COST_PLACE(25)     bridgeLevelStep   place a block over a gap, cross
//   pillar          COST_PLACE(25)     pillarUpStep      place underfoot + rise — the ONLY straight-up
//                                                        move (digs a plain ceiling as it goes)
//   * any edge that digs or covers a PROTECTED / station voxel is charged PROTECTED_VOXEL_DETOUR_BUDGET instead of its base.
//   * any edge that DIGS is additionally floor-priced by flowPrice() when a broken face would open water
//     (FLOW_DETOUR_BUDGET) or lava (LAVA_FLOW_DETOUR_BUDGET). Math.max against the base, never a sum — the
//     edge is charged its worst applicable tier and never more than the ceiling.

// Standing ON tree leaves is legal (mineflayer rests a body on a leaf block) but a trap: the canopy
// is walk-ONTO-able yet not reliably traversable, so a bot A* routes onto it strands and livelocks
// (both bots died this way). Leaves are NOT a Law-17 hazard (those are excluded from A* entirely) —
// they're passable-but-costly: a leaf-FLOOR step is charged COST_HIGH so A* detours up to ~15
// walk-steps around a canopy, yet still crosses one if nothing else reaches (finite — one cost
// model, no separate leaf-ban pathway, Law 16). floorMoveCost is the single place the base per-step
// cost is decided, so every move edge (walk/climb) agrees on what a leaf floor costs.
function isLeafFloor(block) {
  return !!(block && typeof block.name === 'string' && block.name.endsWith('leaves'));
}
function floorMoveCost(floorBlock) {
  return isLeafFloor(floorBlock) ? COST_HIGH : COST_LOW;
}

// Digging a station costs PROTECTED_VOXEL_DETOUR_BUDGET (same tier as blueprint voxels) — the PRICE is
// this file's to set; WHICH BLOCKS are stations is not. That membership was a second list here until it
// had drifted six blocks apart from the canonical one (fragment_utils.STATION_TYPES carries the full
// account). A cost table asking someone else "is this a station" is the shape that cannot drift.
const keyOf = (p) => `${p.x},${p.y},${p.z}`;
const straightLine = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// The 4 cardinals — the neighbor set every move edge (walk, climb, swim, dig) scans.
const CARDINAL = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

// ── Binary min-heap: frontier ordered by f-score (g + heuristic). ──
// A*'s speed edge over Dijkstra evaporates with an O(n) linear-scan frontier, so it needs a heap.
class MinHeap {
  constructor() { this.data = []; }
  get size() { return this.data.length; }
  push(node) {
    this.data.push(node);
    this._bubbleUp(this.data.length - 1);
  }
  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) { this.data[0] = last; this._sinkDown(0); }
    return top;
  }
  _bubbleUp(i) {
    const d = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (d[i].f >= d[parent].f) break;
      [d[i], d[parent]] = [d[parent], d[i]];
      i = parent;
    }
  }
  _sinkDown(i) {
    const d = this.data;
    const n = d.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && d[l].f < d[smallest].f) smallest = l;
      if (r < n && d[r].f < d[smallest].f) smallest = r;
      if (smallest === i) break;
      [d[i], d[smallest]] = [d[smallest], d[i]];
      i = smallest;
    }
  }
}

// ── computeAStar — the pathfinder. ──
// Params:
//   bot      — mineflayer bot (inline bot.blockAt queries)
//   startPos — Vec3/{x,y,z}, the bot's FLOOR position (block stood ON)
//   goal     — { type:'position', pos } | { type:'multi', positions:[…] } | { type:'los', targetPos }
//   opts     — { maxNodes?, blacklist?, movePenalties?, protectedBlocks?, trace?, deadlineMs?, owner? }
// Returns { path:[{key,pos,edgeType}], target, cost, partial, residual, provenBound, complete },
// or null when no path exists.

// Water: swimmable, not walkable. Also in HAZARD_BLOCKS so no walk/climb edge routes through a
// submerged column (the bot can't walk underwater); swim edges carry all water traversal instead.
const WATER_BLOCKS = new Set(['water', 'flowing_water']);

function isWaterBlock(block) { return block && WATER_BLOCKS.has(block.name); }

// Wooden doors — openable by hand (activateBlock). Iron doors excluded: they need redstone.
const DOOR_BLOCKS = new Set([
  'oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
  'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door',
]);

function isDoorBlock(block) { return block && DOOR_BLOCKS.has(block.name); }

// findWaterSurface: from a water block, climb to the surface Y (topmost water with air above for
// the head), or null if the column is capped by solid — underwater with no way up, so no swim node.
function findWaterSurface(bot, x, y, z) {
  let surfY = y;
  for (let i = 1; i <= 12; i++) {
    const above = bot.blockAt(new Vec3(x, surfY + 1, z));
    if (above && WATER_BLOCKS.has(above.name)) surfY++;
    else break;
  }
  const headSpace = bot.blockAt(new Vec3(x, surfY + 1, z));
  if (!headSpace || !isBlockPassable(headSpace)) return null;
  return surfY;
}

// Never passable, never a walkable floor. Water forces swim edges (not walk); the rest are
// Law 17 hazards the planner must route around, not through.
const HAZARD_BLOCKS = new Set([
  'water', 'flowing_water', 'bubble_column',
  'lava', 'flowing_lava',
  'fire', 'soul_fire', 'campfire', 'soul_campfire',
  'cactus', 'sweet_berry_bush', 'magma_block',
  'cobweb', 'powder_snow',
  'nether_portal', 'end_portal', 'end_gateway',
]);

// Non-colliding, non-hazard — the body passes through these.
const PASSABLE_BLOCKS = new Set([
  'air', 'cave_air', 'void_air',
  'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'seagrass', 'kelp', 'kelp_plant',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'mangrove_propagule', 'cherry_sapling',
  'vine', 'torch', 'wall_torch', 'redstone_torch', 'redstone_wall_torch',
  'snow',
]);

// Mirrors getClearance in movement/terrain_predicates, but on a raw block (no relative offset).
function isBlockPassable(block) {
  if (!block) return false;
  if (PASSABLE_BLOCKS.has(block.name)) return true;
  if (HAZARD_BLOCKS.has(block.name)) return false;
  return block.boundingBox === 'empty';
}

function isBlockSolid(block) {
  if (!block) return false;
  return block.boundingBox !== 'empty' && block.name !== 'air';
}

// Blocks that fall when their support is removed — digging one directly OVERHEAD drops it onto the
// bot's head (Law 17 suffocation). Excluded as ceiling for the upward pillar / dig_climb_up edges;
// horizontal dig_through is unaffected (nothing drops sideways).
const FALLING_BLOCKS = new Set([
  'sand', 'red_sand', 'gravel',
  'anvil', 'chipped_anvil', 'damaged_anvil',
  'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder',
  'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder',
  'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder',
  'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder',
  'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder', 'black_concrete_powder',
]);

// isCeilingDiggable: safe to dig a block sitting ABOVE the bot. Solid + diggable, and neither a
// hazard (water/lava would flood the shaft) nor a gravity block (drops on the head). The upward dig
// edges gate their overhead cells on this; a sideways dig has no such risk so it doesn't apply.
function isCeilingDiggable(block) {
  if (!isBlockSolid(block)) return false;
  if (!block.diggable) return false;
  if (HAZARD_BLOCKS.has(block.name)) return false;
  if (FALLING_BLOCKS.has(block.name)) return false;
  return true;
}

// Lava, named apart from HAZARD_BLOCKS on purpose. That set answers "may the body ENTER this", one
// answer for every hazard; this one answers "how bad is opening a face onto it", where lava's answer
// differs from water's. Same two block names, two different questions, so two sets rather than one set
// asked a question it was not built to answer.
const LAVA_BLOCKS = new Set(['lava', 'flowing_lava']);

// The cells a liquid can reach a newly-broken block from: the four cardinals and the one ABOVE. Never
// BELOW — liquid does not flow upward, so a pool under the floor cannot enter the space above it. This
// is exactly mineflayer-pathfinder's neighbour set for the same rule; the omission is deliberate there
// too, and copying it without the reason is how it would get "fixed" back to six.
const FLOW_NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

// flowPrice — the floor price for a dig that would open a liquid into the space it clears, or 0.
//
// `cells` is the list of [x,y,z] the edge actually BREAKS. A cell that is already passable is not being
// opened and contributes nothing, so callers pass only the solid ones — which also keeps this off the
// hot path for the common all-clear edge.
//
// Returns the WORST tier across all of them, not the sum: a two-block dig is priced by its most
// dangerous face. Summing would let a wide-but-shallow breach out-price a lava wall, and would also
// climb above the cost ceiling, which nothing in the model is allowed to do.
//
// THE ONE PLACE THE RULE LIVES (Law 16). Every dig edge in this file calls it, so travel routes, combat
// retreats and escape digs inherit the same price by construction rather than by five agreeing copies —
// which is what this file already was: dig_down carried a water-only HARD BAN of its own and the other
// four dig edges carried nothing, so the bot would refuse to sink one shaft beside a pond and then
// happily tunnel sideways into the same pond one cell over.
//
// A null (unloaded) neighbour is NOT charged, which is the one place this parts company with Law 13's
// read-the-unknown-as-unsafe. A price is not a safety gate: the dig gates above already refuse a cell
// they cannot read, and charging for unloaded chunks would make every dig at a chunk border expensive
// for a reason that has nothing to do with liquid.
function flowPrice(bot, cells) {
  let worst = 0;
  for (const [x, y, z] of cells) {
    for (const [dx, dy, dz] of FLOW_NEIGHBORS) {
      const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
      if (!b) continue;
      if (LAVA_BLOCKS.has(b.name)) return LAVA_FLOW_DETOUR_BUDGET;   // ceiling — nothing can outrank it
      if (WATER_BLOCKS.has(b.name)) worst = FLOW_DETOUR_BUDGET;
    }
  }
  return worst;
}

// Placeable as a pillar/bridge block — membership only. It reads scaffold_block, the gravity-FILTERED
// exposure, which is a deliberate under-count of what a pillar can lay: this set gates bridge decisions
// too, and "the bot holds sand, so it can bridge" plans a crossing that falls out from under it. The
// wrong answer this way costs a detour; the other way costs the walker (Law 13).
// This was a hand-maintained copy: "what is a placeable block" was defined in FIVE places (here,
// group_to_item, navigator's BUILD_PREFS, and a FILL_PREFERENCE in each of mining_executor and
// farm_executor), and only one read the canonical table. A planner list that drifts from the executor
// list plans routes the walker cannot lay.
// No `|| []` — an absent group is a coding violation here, and an empty set makes isScaffoldBlock answer
// "no scaffolding" for every block in the game: a well-formed falsehood the pillar/bridge fuel checks
// would act on without ever failing loudly (Law 13, Law 26).
const SCAFFOLD_BLOCKS = new Set(
  require('@utils/fragment_utils').group_to_item.scaffold_block
);
function isScaffoldBlock(name) { return SCAFFOLD_BLOCKS.has(name); }

// isFloorSafe: is this block a standable floor for A*? Delegates to terrain_predicates.isWalkableSurface
// — the ONE walkability definition the STEP EXECUTOR also uses (Law 16). They MUST agree: this copy
// used to only reject hazards + empty-bbox blocks, so it accepted fences/gates/walls (boundingBox
// 'block') as floors. Those collide to 1.5 blocks — an off-grid half-perch the 1-block navigator
// can't hold — so A* planned routes ONTO the fence line, the walker bumped and drifted, and the bot
// "slid to the entrance after a few retries" (the farm-perimeter fence stalls). Sharing the predicate
// makes the planner route AROUND fences the executor already refuses to stand on.
function isFloorSafe(block) {
  return isWalkableSurface(block);
}

// isFullHeightFloor: does the floor's collision top reach y=1.0? Partial-height blocks (chest
// 0.875, slab 0.5, bed, enchant table) report boundingBox='block' but their surface sits below
// y+1. Walk edges tolerate it; climb_up does NOT — A* assumes feet at floorY+1 but the bot lands
// at floorY+surface, flooring to a lower Y. So this gates climb_up edges only.
function isFullHeightFloor(block) {
  if (!block || !block.shapes || block.shapes.length === 0) return true;
  let maxY = 0;
  for (const shape of block.shapes) { if (shape[4] > maxY) maxY = shape[4]; }
  return maxY >= 1.0;
}

// classifyFloorInline: terrain_predicates.classifyFloor via bot.blockAt (no offset needed).
// 'jumpable' = 3 air above (room to jump onto), 'walkable' = 2 air, null = blocked/unsafe.
//
// THE FLAGS PATH (`_classifyFloorAt`) IS THE LIVE ONE whenever the search runs against a real world:
// _fastVoxelView arms it from the shipped reader. The block path below is NOT a fallback in the Law 16
// sense — it is the only path a worldless caller has (lanista's four-field adapter, the virtual
// playground), where there are no state ids to read flags from. Two implementations of one verdict is a
// real hazard, so they are pinned equal by test rather than by discipline:
// It must answer identically, and it does by derivation rather than by transcription: isFloorSafe IS
// terrain_predicates.isWalkableSurface, and the clearance test IS isBlockPassable — the same two
// predicates the flag table calls to build its WALKABLE and PASSABLE bits.
function classifyFloorInline(bot, floorBlock) {
  if (!floorBlock) return null;
  if (bot._classifyFloorAt) {
    const p = floorBlock.position;
    // The floor's state id is handed over because the caller ALREADY read this cell to obtain
    // floorBlock. Without it the flags path re-reads the floor and costs one extra read per call —
    // enough to make it read MORE than the block path it replaces (measured, before this argument).
    return bot._classifyFloorAt(p.x, p.y, p.z, floorBlock.stateId);
  }
  if (!isFloorSafe(floorBlock)) return null;
  const pos = floorBlock.position;
  let clear3 = true;
  for (let i = 1; i <= 3; i++) {
    const above = bot.blockAt(pos.offset(0, i, 0));
    if (!isBlockPassable(above)) { clear3 = false; break; }
  }
  if (clear3) return 'jumpable';
  let clear2 = true;
  for (let i = 1; i <= 2; i++) {
    const above = bot.blockAt(pos.offset(0, i, 0));
    if (!isBlockPassable(above)) { clear2 = false; break; }
  }
  if (clear2) return 'walkable';
  return null;
}

// heuristic: admissible cost-to-goal estimate. Euclidean never overestimates real travel (can't
// cut through walls, so actual ≥ straight-line) — that admissibility is what keeps A* optimal.
// Multi-goal returns the nearest candidate's distance.
function heuristic(pos, goal) {
  if (goal.type === 'position') {
    return straightLine(pos, goal.pos);
  }
  if (goal.type === 'multi') {
    let min = Infinity;
    for (const g of goal.positions) {
      const d = straightLine(pos, g);
      if (d < min) min = d;
    }
    return min;
  }
  if (goal.type === 'los') {
    return straightLine(pos, goal.targetPos);
  }
  return 0;
}

// endsOnStation — the last gate every goal type passes through: a route may cross a station, but it may
// not come to rest on one (terrain_predicates.isStationFloor carries the reasoning).
//
// Ordered AFTER each goal type's own cheap test on purpose. This is a world read, and goalReached runs on
// every popped node — hundreds of thousands in one search — so it may only run on a cell that has already
// answered "this is the goal". Placed before the LOS raycast for the same reason: a Set lookup is the
// cheaper of the two disqualifiers, so it should be the one that fires first.
//
// A node is a FLOOR cell (goals are built at target y-1), so this reads the node's own block: the body
// stands on it.
function endsOnStation(bot, nodePos, trace) {
  const floor = bot.blockAt(nodePos);
  if (!isStationFloor(floor)) return false;
  if (trace) trace('pathfinding', `A* goal REJECTED (${nodePos.x},${nodePos.y},${nodePos.z}): floor is ${floor.name} — a path may not end on a station.`);
  return true;
}

// goalReached: does this node satisfy the goal? position/multi = exact floor match; los = the
// two proximity gates below plus a clearing raycast. Every branch additionally refuses to end on a
// station (endsOnStation above).
function goalReached(bot, nodePos, goal, trace) {
  if (goal.type === 'position') {
    if (keyOf(nodePos) !== keyOf(goal.pos)) return false;
    return !endsOnStation(bot, nodePos, trace);
  }
  if (goal.type === 'multi') {
    const nk = keyOf(nodePos);
    let matched = false;
    for (const g of goal.positions) {
      if (nk === keyOf(g)) { matched = true; break; }
    }
    if (!matched) return false;
    return !endsOnStation(bot, nodePos, trace);
  }
  if (goal.type === 'los') {
    // Two proximity gates before LOS matters — the bot must be close enough AND
    // at a usable height. Without these, A* accepts vantage points where the
    // raycast passes but the interaction angle is too steep to actually place/dig.
    const feetY = nodePos.y + 1;
    const dx = goal.targetPos.x - nodePos.x;
    const dy = goal.targetPos.y - feetY;
    const dz = goal.targetPos.z - nodePos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > BLOCK_REACH) return false;
    if (dist < MIN_PLACEMENT_DIST) return false;
    if (Math.abs(dy) > LOS_MAX_Y_GAP) return false;
    if (goal.required_side) {
      const sdx = nodePos.x - Math.floor(goal.targetPos.x);
      const sdz = nodePos.z - Math.floor(goal.targetPos.z);
      if (sdx === 0 && sdz === 0) return false;
      const dominant = Math.abs(sdx) > Math.abs(sdz)
        ? (sdx > 0 ? 'east' : 'west')
        : (sdz > 0 ? 'south' : 'north');
      if (dominant !== goal.required_side) return false;
    }
    if (endsOnStation(bot, nodePos, trace)) return false;
    return checkLOS(bot, nodePos, goal.targetPos, trace);
  }
  // A 'near' GOAL TYPE LIVED HERE FOR ONE DAY, and its deletion is the record of a design that was
  // right about the bug and wrong about the answer. It asked "stand within N blocks of this block", with
  // no raycast — built 2026-08-31 to fix a station-use loop, deleted the same day when the Architect
  // ruled the stand must be the blueprint's own ANCHOR instead: *"the anchor is a designated building
  // point and is a pre approved location to stand and reach every block within its domain so reuse it
  // instead of making some non deterministic way to stand."* A radius admits many cells and the search
  // picks whichever is cheapest, which is a different cell on a different approach — including one
  // OUTSIDE the building, reaching a chest through a wall. The anchor is one cell, authored, the same
  // every time (Law 19). Station approach is now `locomotion.goToStationAnchor`, which resolves the
  // owning anchor and uses the ordinary exact-position goal; nothing needs a radius goal.
  return false;
}

// checkLOS: raycast from simulated eye height to the target. Solid targets aim at center; air
// targets aim at an adjacent solid face (you interact with the face, not the empty cell).
const LOS_MAX_REACH = BLOCK_REACH;
const LOS_FACE_DIRS = [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];

function checkLOS(bot, floorPos, targetPos, trace) {
  const EYE_H = bot.entity.height * 0.9;
  const eyeOrigin = new Vec3(floorPos.x + 0.5, floorPos.y + 1 + EYE_H, floorPos.z + 0.5);

  const targetBlock = bot.blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z));
  const targetIsAir = !targetBlock || targetBlock.name === 'air' || targetBlock.boundingBox === 'empty';

  const rayCandidates = targetIsAir
    ? LOS_FACE_DIRS.flatMap(([dx, dy, dz]) => {
        const nx = targetPos.x + dx, ny = targetPos.y + dy, nz = targetPos.z + dz;
        const nb = bot.blockAt(new Vec3(nx, ny, nz));
        if (!nb || nb.name === 'air' || nb.boundingBox === 'empty') return [];
        return [{ point: new Vec3(nx + 0.5 - dx * 0.5, ny + 0.5 - dy * 0.5, nz + 0.5 - dz * 0.5), bx: nx, by: ny, bz: nz }];
      })
    : [{ point: new Vec3(targetPos.x + 0.5, targetPos.y + 0.5, targetPos.z + 0.5),
         bx: Math.floor(targetPos.x), by: Math.floor(targetPos.y), bz: Math.floor(targetPos.z) }];

  if (rayCandidates.length === 0) {
    if (trace) trace('pathfinding', `checkLOS FAIL from floor (${floorPos.x},${floorPos.y},${floorPos.z}): target (${targetPos.x},${targetPos.y},${targetPos.z}) is ${targetIsAir ? 'air' : targetBlock.name} — 0 ray candidates (no solid neighbors).`);
    return false;
  }

  for (const { point, bx, by, bz } of rayCandidates) {
    const d = eyeOrigin.distanceTo(point);
    if (d > LOS_MAX_REACH) {
      if (trace) trace('pathfinding', `checkLOS ray skip: eye (${eyeOrigin.x.toFixed(1)},${eyeOrigin.y.toFixed(1)},${eyeOrigin.z.toFixed(1)}) → face (${bx},${by},${bz}) dist=${d.toFixed(1)} > ${LOS_MAX_REACH}`);
      continue;
    }
    const dir = point.minus(eyeOrigin).normalize();
    const cast = guardExternalSync('pathfinding', `raycast to face (${bx},${by},${bz})`, () => bot.world.raycast(eyeOrigin, dir, LOS_MAX_REACH));
    if (!cast.ok) continue;   // a ray that could not be traced is not a ray that missed — try the next
    const hit = cast.value;
    if (hit && hit.position.x === bx && hit.position.y === by && hit.position.z === bz) return true;
    if (trace) trace('pathfinding', `checkLOS ray miss: eye (${eyeOrigin.x.toFixed(1)},${eyeOrigin.y.toFixed(1)},${eyeOrigin.z.toFixed(1)}) → face (${bx},${by},${bz}) dist=${d.toFixed(1)} — hit ${hit ? `(${hit.position.x},${hit.position.y},${hit.position.z}) ${hit.block?.name || '?'}` : 'nothing'}`);
  }
  if (trace) trace('pathfinding', `checkLOS FAIL from floor (${floorPos.x},${floorPos.y},${floorPos.z}): ${rayCandidates.length} ray(s), none reached target (${targetPos.x},${targetPos.y},${targetPos.z}).`);
  return false;
}

// _fastVoxelView — swap this search's world reads onto the per-state-id table (Architect 2026-08-04,
// approved after the live A/B). Every `bot.blockAt` below is unchanged; only what it resolves to moves.
//
// WHY A SHADOWED VIEW AND NOT ~50 EDITED CALL SITES: the search's logic must stay byte-identical, because
// the evidence for this change is that it produces THE SAME ROUTE faster (routes identical cell-by-cell
// and edge-by-edge in 10/10 live trials, at equal read counts — tools/astar_ab_bench). Rewriting fifty
// reads would put that identity at risk for no gain. Object.create keeps `world`, `entity` and
// `inventory` resolving to the real bot, so checkLOS's raycast and the place edges are untouched.
//
// WHAT IT BUYS: 36,548 ms -> 15,522 ms on a 200k-node search (19.1 million reads for one route). The
// win is not skipped work — it is that `name`/`boundingBox` are functions of the block's number, so they
// are computed once per number instead of rebuilt into a fresh ~20-field description on every read.
//
// RETURNS THE BOT UNCHANGED when there is no `world` to read state ids from. That is not a defensive
// nicety: lanista and the benches pass a four-field adapter with a `blockAt` and nothing else, and
// silently ignoring their reader would search a different world than the caller asked about (Law 25).
//
// `readerOverride` (opts.voxelReader) is a MEASUREMENT SEAM, not a feature: it lets an A/B bench run a
// candidate reader through this exact search instead of forking it, which is the only way a timing and a
// route-identity check can be about the reader alone. No production caller passes one.
//
// ONE READER PER BOT, NOT ONE PER SEARCH (Law 8). The reader registers chunkColumnLoad/chunkColumnUnload
// listeners to drop its held column, so building one per computeAStar call would pile listeners onto
// bot.world for the life of the process — Node warns at 11 and the leak is silent before that. The
// WeakMap holds it against the bot so it is collected WITH the bot and never needs an explicit dispose;
// this is the same holder pattern surface_filter already uses, reused rather than re-invented (Law 22
// gate 2). Keyed on the bot because the held column is per-bot state: two bots sharing one reader would
// thrash the memo against each other.
const _readerForBot = new WeakMap();
function _fastVoxelView(bot, readerOverride) {
  if (!bot || typeof bot.world?.getColumnAt !== 'function') return bot;
  const { makeVoxelReader } = require('@utils/voxel_reader');
  let reader = readerOverride;
  if (!reader) {
    reader = _readerForBot.get(bot);
    if (!reader) { reader = makeVoxelReader(bot, { needs: ['type'] }); _readerForBot.set(bot, reader); }
  }
  if (!reader.fast) return bot;
  const view = Object.create(bot);
  view.blockAt = pos => reader.blockAt(pos.x, pos.y, pos.z);
  view._classifyFloorAt = reader.classifyFloorAt;
  return view;
}

// ── THE SEARCH CENSUS (Architect 2026-08-04: "calculate the time each pathfinding takes and post it
// for watcher tracer to look at") ───────────────────────────────────────────────────────────────────
// What one search cost, accumulated here and POSTED BY THE CALLER. This module stays watcher-free on
// purpose (same reason `trace` is an injected sink): a util that talks to the watcher cannot be run by
// the benches or the virtual playground, which is where the search's evidence comes from.
//
// WHY AN ACCUMULATOR AND NOT A LINE PER SEARCH. One navigation runs the search many times — plan, then
// re-plan on every floor recovery, blacklist retry and stream refresh (navigator has seven call sites).
// A summary per search would bury the trace in exactly the per-step noise Law 5 deleted; one aggregated
// line per unit of work is the level Law 5 names as the primary channel.
//
// SAFE AS MODULE STATE because a decision-maker is one process holding one `global.bot`, and Law 4 gives
// it one active signal: whatever accumulates between two drains belongs to the one owner that was
// running. A second bot in-process would need this keyed per bot — it is not, deliberately, because
// that is not the deployment and a per-bot map would imply it is.
//
// ── WHY IT IS KEYED BY OWNER (Invariant D — one owner per state) ────────────────────────────────────
// One active signal does NOT mean one caller: this module is a util, and any fragment holding the signal
// may search. The navigator drains and posts the result as its own trip's cost, so every search another
// caller made between two navigations was billed to a navigation that never made it. That is not a small
// blur — the two callers search under DIFFERENT deadlines, so the drained totals reported a timeout count
// that no single deadline could reconcile against the drained time, and the aggregate could not say which
// number was lying (neither was; the mix was). Keying by owner is what makes both numbers true at once,
// and it is why a caller passes `opts.owner`: a search's owner is the one fact this module cannot sense
// for itself.
// Untagged is a NAMED bucket, not a defaulted field (Law 13): the benches and the virtual playground call
// this directly and are correct systems, so "no owner declared" is a real category rather than a bug —
// but it is never silently folded into a caller's bill.
const UNATTRIBUTED_SEARCH_OWNER = 'unattributed';
const _blankTally = () => ({ searches: 0, totalMs: 0, maxMs: 0, nodes: 0, partial: 0, timedOut: 0, failed: 0, incomplete: 0 });
const _census = new Map();   // owner → tally
function drainSearchCensus() {
  const total = _blankTally();
  const byOwner = {};
  for (const [owner, t] of _census) {
    byOwner[owner] = { ...t };
    // maxMs is a MAXIMUM: summing two owners' worst searches invents a single search that never ran,
    // and it is the number a deadline decision is read from.
    for (const k of Object.keys(total)) { if (k !== 'maxMs') total[k] += t[k]; }
    if (t.maxMs > total.maxMs) total.maxMs = t.maxMs;
  }
  _census.clear();
  return { ...total, byOwner };
}
// The timing wrapper is the ONLY way in (the body below is not exported), so no call site can be added
// that escapes the census — the alternative, recording at each of the body's four return points, is one
// forgotten `return` away from an undercount that reads as a speedup (Law 25).
// ── pathStillWalkable — re-verify a plan instead of re-planning it ──────────────────────────────────
// Answers "is the route I am walking still legal?" for the cells not yet walked. Lives here rather than
// in the navigator because it must agree with the search by DERIVATION, not by transcription: it calls
// the same classifyFloorInline over the same per-bot reader the search itself used, so a verdict here
// cannot drift from the verdict that planned the route. A second, separately-written walkability test
// would not throw when it disagreed — it would quietly re-plan a fine path, or walk a broken one.
//
// WHY IT EXISTS (Architect 2026-08-04): the navigator re-planned every 2s or 20 steps unconditionally.
// Measured: one healthy 97-second walk ran 27 searches for 23.3s — over half the fleet's entire
// pathfinding bill for a ten-minute run — and reported no partials, no timeouts and no lost routes.
// Every one of those searches re-answered a question already answered correctly. Verification is ~4
// reads per remaining cell against ~1.4 million for a replan, and it is also the more correct instrument:
// a timer is remembered state that fires whether or not the world moved, while this re-senses (Invariant
// B). Known and accepted limit: it checks STILL-VALID, never STILL-OPTIMAL — a shortcut opening mid-walk
// goes unnoticed, which is the exact re-optimisation the cadence was paying for and the Architect ruled
// not worth it.
//
// Only the edges that need standable ground are checked. A dig/bridge/pillar step is *going* to change
// the world at its destination, so "not walkable yet" is its normal state, not a fault — verifying those
// would invalidate every carve plan on its first step. Their failures are caught by the executor and
// priced through movePenalties instead.
const VERIFIABLE_EDGES = new Set(['walk', 'climb_up', 'climb_down', 'door', 'jump_out']);
function pathStillWalkable(bot, path, fromIdx) {
  if (!Array.isArray(path)) return false;
  const view = _fastVoxelView(bot);
  for (let i = fromIdx; i < path.length; i++) {
    const step = path[i];
    if (!VERIFIABLE_EDGES.has(step.edgeType)) continue;
    if (!classifyFloorInline(view, view.blockAt(step.pos))) return false;
  }
  return true;
}

async function computeAStar(bot, startPos, goal, opts = {}) {
  const t0 = Date.now();
  const res = await _computeAStarBody(bot, startPos, goal, opts);
  const ms = Date.now() - t0;
  const owner = opts.owner || UNATTRIBUTED_SEARCH_OWNER;
  let tally = _census.get(owner);
  if (!tally) { tally = _blankTally(); _census.set(owner, tally); }
  tally.searches++;
  tally.totalMs += ms;
  if (ms > tally.maxMs) tally.maxMs = ms;
  if (res) {
    tally.nodes += res.nodesVisited;
    if (res.partial) tally.partial++;
    if (res.timedOut) tally.timedOut++;
    // Counted separately from `partial` because the pair is what carries the verdict, and only one of
    // the four combinations is a lie waiting to happen:
    //   found + complete    — the optimal route, proven.
    //   partial + complete  — the frontier ran dry: genuinely no route in the world the bot can see.
    //   partial + INCOMPLETE— a budget or clock cut the search off. This one must never be read as
    //                         "unreachable"; all it supports is "nothing cheaper than provenBound".
    // Tracking it makes the difference countable instead of a thing a reader has to know (Law 25).
    if (!res.complete) tally.incomplete++;
  } else {
    tally.failed++;
  }
  return res;
}

async function _computeAStarBody(bot, startPos, goal, opts = {}) {
  bot = _fastVoxelView(bot, opts.voxelReader);
  const start = new Vec3(Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z));
  const startKey = keyOf(start);

  // ── NO NODE BUDGET (Architect 2026-08-04: "im always against the budget cap… remove the cap") ──────
  // There is no maxNodes and no default one. A count of nodes is a measure of EFFORT SPENT, and the only
  // question worth bounding is COVERAGE — and no formula can convert one to the other, because the number
  // of cells inside a radius is a property of the terrain (open plain vs cave system differ by an order of
  // magnitude at the same distance), not of the radius. So every distance→nodes rule was a guess, and a
  // guess that ran out emitted "unreachable" for a place the bot could walk to. That is a false verdict,
  // and a false verdict outranks a slow one (Law 25).
  //
  // WHAT TERMINATES INSTEAD — three, and none of them invented:
  //   1. the goal pops        → the optimal route, proven. The normal exit; 31 ms median, live.
  //   2. the HEAP EMPTIES     → every reachable cell examined. Guaranteed to arrive, because an unloaded
  //      column yields no block and therefore no edge, so the frontier physically cannot cross the edge of
  //      the loaded region. "No route" then means it, rather than "I stopped counting".
  //   3. opts.deadlineMs      → a bound the WORLD imposed (a creeper fuse; how long a body may stand
  //      still), not one the search invented about itself. Reports timedOut + provenBound, never a false
  //      unreachable. No caller is given one by default.
  // Underneath all three: the pacer cedes a macrotask every ~tick, so an uncapped search cannot freeze the
  // shared world however long it runs — voxel_scan_throttle's own header names that as its purpose
  // ("throttling is what makes an UNCAPPED whole-loaded-area search safe"), and arms a combat gate so a
  // long search is not a blind window. This search is uncapped BECAUSE that pacer exists.
  //
  // `maxNodes` survives ONLY as an opt-in for a caller with a real reason (a bench pinning a comparison).
  // Infinity is the default and no production caller sets it; if one ever does, it owes a WHY here.
  const maxNodes = opts.maxNodes || Infinity;

  // The shared cooperative pacer (Law 16): run a burst for up to one tick, then cede a macrotask so
  // this bot's physics, the server tick, and every peer bot get a slice before the search resumes.
  // `bot` arms the pacer's combat gate: a long route search is the single biggest blind window a bot
  // has (5502ms measured on one hop, 2026-08-03), and it used to hold that window with no threat check
  // in it at all. opts.combatGate === false turns it off for a search with no live body behind it — the
  // arena's reachability criterion computes routes it never walks, and a gate there would abandon a
  // measurement to the judge.
  const pace = makeScanThrottle(opts.combatGate === false ? {} : { bot, source: 'locomotion' });

  // ── TWO WAYS TO DISPREFER A CELL, and they are NOT interchangeable ──────────────────────────────
  // `blacklist` DELETES cells from the graph. Legitimate for exactly one thing: a caller's hard rule
  // about where it will not go, whatever the price. Combat's retreat search is the only user — a cell
  // that moves the bot TOWARD the threat must never be routed through, and a finite charge would let a
  // cheap approach win the very trade the tactic exists to refuse.
  const blacklist = opts.blacklist || null;

  // Read ONCE per search rather than per node: the answer cannot change mid-search (the start cell is
  // fixed), and re-deriving it inside the pop loop would price a config read into every one of tens of
  // thousands of nodes. See the pop-loop rejection below for what it does.
  const depthFloorArmed = !belowDepthFloor(start.y);

  // `movePenalties` ("x,y,z|edgeType" -> extra cost) CHARGES instead of deleting. This is what a *failed
  // step* gets, and the distinction is not cosmetic — deleting a cell can delete the only route to it,
  // INCLUDING THE GOAL. That is a live defect, not a hypothetical: a final step stumbled, the navigator
  // banned its destination, and the destination was the goal — so the re-plan was asked to prove something
  // false and spent the whole search doing it while the bot walked to that exact cell one second later. A
  // finite charge cannot make anything unreachable; it makes it a last resort. Same idiom the cost model
  // already uses twice: leaf floors at COST_HIGH, blueprint voxels at PROTECTED_VOXEL_DETOUR_BUDGET — finite, never forbidden,
  // so an entombed bot can still carve out.
  //
  // KEYED BY THE MOVE, NOT BY THE CELL, and the difference is what the walker actually observed. A failed
  // step reports "bridging into X did not work" — a fact about a MOVE. Charging the cell instead widens
  // that into "X is a bad place", which is a claim nothing measured (Law 23): the bot then avoids arriving
  // at X by every other means too, including a plain walk in from another side that would have succeeded.
  // The cell-shaped key was inherited from the hard ban this replaced — the ban had to name a cell because
  // deletion has nowhere else to land — and the target was never re-asked when the ban became a charge.
  const movePenalties = opts.movePenalties || null;
  // Charged once per key per search. A cheaper route discovered to the same move after the charge lands
  // gets in uncharged, which under-prices it slightly — accepted, because the penalty's job is "prefer
  // another way", not to be an exact cost. Bounding it to once is what keeps the pop loop terminating.
  const penaltyCharged = movePenalties ? new Set() : null;

  // Active blueprint voxels ("x,y,z" keys). Digging one costs PROTECTED_VOXEL_DETOUR_BUDGET — near-forbidden but
  // finite, so a trapped bot can still break out (no entombment).
  const protectedBlocks = opts.protectedBlocks || null;

  // Optional (label, message) sink — keeps this module watcher-free while callers can still see
  // inside the search. Null = silent.
  const trace = opts.trace || null;

  // WORLD-ALTERING EDGES ON/OFF (Architect 2026-07-31, for the arena's reachability criterion:
  // "pillar step and any move that requires digging or placing blocks is not allowed").
  //
  // Default TRUE, so the live fleet's every search is bit-identical to before — locomotion NEEDS these
  // edges (a buried bot digs out; a build anchor in open air is bridged to). False deletes all six at
  // GENERATION time: dig_climb_up, dig_climb_down, dig_through, dig_down, bridge, pillar. What survives
  // is walk / climb_up / climb_down / door / swim — every move that leaves the world as it found it.
  //
  // WRONG TURN, and it is the tempting one: run the search normally and reject the result if its path
  // contains an altering edge. That is unsound. A* returns the CHEAPEST route, so a dig (COST_HIGH) can
  // win over a legal 30-step walk-around, and post-filtering would then report "unreachable" for a place
  // the body could plainly walk to. The edge set has to be restricted before the search, not after it.
  const allowWorldAlteration = opts.allowWorldAlteration !== false;
  // SPLIT INTO DIG vs PLACE (Architect 2026-08-01, for the combat navigator: "no digging but pillaring
  // is allowed. digging takes too long"). The single boolean above could only say all-six or none, and
  // a tactical retreat needs exactly the middle: keep pillar/bridge (a placement is one jump), delete
  // every dig (breaking a block costs seconds the fuse does not have). Each defaults to the old flag,
  // so every existing caller — which passes neither — searches bit-identically to before.
  const allowDig   = opts.allowDig   !== undefined ? !!opts.allowDig   : allowWorldAlteration;
  const allowPlace = opts.allowPlace !== undefined ? !!opts.allowPlace : allowWorldAlteration;

  // ── THE SPAWN-PROTECTED SQUARE SUPPRESSES THE ALTERING EDGES, PER CELL ───────────────────────────
  // The two flags above are search-wide; this is the same suppression applied cell by cell. Inside the
  // square the server refuses breaks and placements, so a route that digs or bridges through it is a
  // route the body cannot walk — and it must be removed at GENERATION time for exactly the reason the
  // allowDig note above gives: A* returns the CHEAPEST route, so a dig through spawn wins against a
  // legal walk-around, and rejecting the path afterwards would report "unreachable" for a place the
  // body could plainly walk to.
  //
  // A PRICE WOULD NOT DO, AND THAT IS THE WHOLE POINT. Every other rule about protected ground in this
  // file is a COST — a blueprint voxel is PROTECTED_VOXEL_DETOUR_BUDGET, a station the same tier —
  // because those are things the fleet OWNS and may spend against when nothing cheaper exists. A cost
  // is payable, so a search with no cheaper detour buys the block; here the purchase cannot complete,
  // because the world will not sell. Refusing the edge is the only form that matches the fact.
  //
  // WALKING THROUGH SPAWN STAYS LEGAL, and no cell is deleted from the graph. Spawn protection governs
  // CHANGING blocks, not standing on them, so this is deliberately unlike the depth floor's pop-loop
  // deletion below: a bot may cross the square, stand in it, fight in it and collect drops in it. Only
  // the six world-altering edges stop existing there.
  //
  // Hoisted once per search and compared inline — the same reason the depth floor is read once above:
  // this is asked hundreds of thousands of times in one pass, and a module lookup per node would price
  // a keep-out check into every one of them. Null when the rule is off or the world spawn is not known
  // yet, and every comparison below short-circuits on that, so a search runs bit-identically to before.
  const spawnBox = require('@perception/spawn_protection').spawnProtectionBox(bot);
  const inSpawnBox = spawnBox
    ? (x, z) => Math.max(Math.abs(x - spawnBox.centerX), Math.abs(z - spawnBox.centerZ)) <= spawnBox.radius
    : null;

  // WALL-CLOCK DEADLINE (Architect 2026-08-01: "it must plan that route in about 0.25 seconds and give
  // partial if it cant"). maxNodes alone cannot express this — node cost varies with how much of the
  // chunk is loaded, so the same budget is 40 ms in open air and 400 ms through a cave mouth, and a
  // caller inside a 1350 ms creeper fuse needs the CLOCK bounded, not the node count. On expiry the
  // loop breaks into the partial reconstruction that already exists below, so a deadline hit returns
  // real progress toward the goal rather than null (Law 25: a truthful short result, never a false
  // failure). `timedOut` is reported so the caller can tell "the world has no route" from "I did not
  // look long enough" — two different next moves.
  const deadlineAt = opts.deadlineMs > 0 ? Date.now() + opts.deadlineMs : 0;
  let timedOut = false;

  // THE GOAL IS A TYPED MESSAGE AND AN UNTYPED ONE IS A CODING VIOLATION (Law 10, Law 13 — added
  // 2026-08-06 after it cost two runs). Both readers of `goal` — heuristic() and goalReached() — end with
  // an unguarded fall-through: an unrecognized type makes the first return 0 and the second return
  // undefined. That pair is the worst possible silent failure this search can have, because neither looks
  // like an error from outside: h=0 is a legal heuristic (it just turns A* into an undirected Dijkstra
  // flood) and a goal test that is never true is indistinguishable from genuinely unreachable terrain. The
  // search then runs to exhaustion and reports "no route" — a WELL-FORMED FALSEHOOD (Law 26), which every
  // caller faithfully believed. drop_collector passed a bare Vec3 here for the life of the fragment; the
  // measured cost was 0 items collected across every run ever recorded, 0 of 598 items recovered from 10
  // deaths, and 36-54% of fleet wall-clock spent inside floods that could not have succeeded.
  //
  // Throwing is the fix rather than defaulting a type: a caller that did not say which goal it meant has a
  // bug, and guessing one for it reinstates exactly the silence this replaces (Law 13 — prove safe to
  // continue, never soft-handle a malformed payload).
  if (!goal || (goal.type !== 'position' && goal.type !== 'multi' && goal.type !== 'los')) {
    throw new Error(`[pathfinding] CODING VIOLATION: goal must be {type:'position'|'multi'|'los'}, got ${goal && goal.type !== undefined ? `type='${goal.type}'` : require('util').inspect(goal)}. An untyped goal silently makes the heuristic 0 and the goal test never-true, so the search reports a false 'no route'.`);
  }

  // Single frontier for every goal (see HEURISTIC_WEIGHT). f = g + W*h: cost accumulates in g, so the
  // route obeys the cost tiers - a walk-around beats a bridge whenever a walk exists. An exact caller
  // that pins a cell hanging in open air (a build anchor above its own shaft) gets its footing built by
  // the SAME search: bridging that final gap is simply the cheapest route once no walk reaches it.
  const fScore = (g, h) => g + HEURISTIC_WEIGHT * h;

  if (trace) trace('pathfinding', `A* START: floor (${start.x},${start.y},${start.z}) → goal type=${goal.type} ${goal.type === 'los' ? `target (${goal.targetPos.x},${goal.targetPos.y},${goal.targetPos.z})` : goal.type === 'position' ? `pos (${goal.pos.x},${goal.pos.y},${goal.pos.z})` : `${goal.positions?.length || 0} candidates`} budget=${maxNodes}`);

  const parent = new Map();   // key → { parentKey, edgeType }
  const gCost = new Map();     // key → g-score
  const visited = new Set();
  const heap = new MinHeap();

  gCost.set(startKey, 0);
  heap.push({ pos: start, key: startKey, g: 0, f: fScore(0, heuristic(start, goal)) });

  // ── THE ONE PLACE A WALK EDGE MUST BE JUMPED ────────────────────────────────────────────────────────
  // The body is standing INSIDE an open-top container (a composter, a cauldron) — its feet cell is the bin
  // itself, so the floor node beneath is the block the bin sits on and every outgoing edge looks like
  // ordinary flat ground. It is not: the rim rises a full block from the bin's inner floor, well over the
  // 0.6 auto-step, so a plain walk presses `forward` into a wall until the stall guard calls no_progress.
  //
  // Scoped to the START node deliberately, and it is the only cell that can ever need this: with
  // isOpenTopContainer wired into isWalkableSurface the search will not route ONTO a bin, so no node
  // downstream of the start can have a bin under its feet. A bot only gets in one by falling in.
  const startFeetBlock = bot.blockAt(new Vec3(start.x, start.y + 1, start.z));
  const startInsideBin = !!(startFeetBlock && isOpenTopContainer(startFeetBlock));
  if (startInsideBin && trace) trace('pathfinding', `A* START is INSIDE '${startFeetBlock.name}' at (${start.x},${start.y + 1},${start.z}) — first move re-typed 'jump_out'.`);

  let nodesVisited = 0;
  let provenBound = 0;
  let reachedKey = null;
  let reachedPos = null;

  // Closest-to-goal explored node; becomes the partial result if the budget runs out.
  let bestPartialKey = startKey;
  let bestPartialPos = start;
  let bestPartialH = heuristic(start, goal);

  // LOS refinement: after the first valid vantage, search LOS_REFINE_BUDGET more nodes for a closer
  // one. First hits sit at the edge of reach (~3 blocks); one more step often halves that, so the
  // bot walks up and digs several blocks in a line instead of repositioning for each.
  let bestLOSKey = null;
  let bestLOSPos = null;
  let bestLOSDist = Infinity;
  let losFoundAtNode = -1;

  while (heap.size > 0 && nodesVisited < maxNodes) {
    await pace();   // cheap clock-check per node; cedes a real macrotask only at each ~1-tick slice boundary
    // Checked AFTER pace() rather than before: pace() is where the wall clock actually advances (it cedes
    // a macrotask at each slice boundary), so testing first would let a whole slice overrun the deadline.
    if (deadlineAt && Date.now() >= deadlineAt) { timedOut = true; break; }
    const current = heap.pop();
    if (visited.has(current.key)) continue;
    if (blacklist && blacklist.has(current.key)) { visited.add(current.key); continue; }
    // THE DEPTH FLOOR (architect_config WORLD_DEPTH_FLOOR_Y). Deletes every cell below the floor from
    // the graph, exactly as `blacklist` does and for the same reason — this is a hard rule about where
    // the fleet will not go, whatever the price, so a finite charge is wrong here: a cheap dig down
    // would still win against an expensive walk-around, which is the trade the floor exists to refuse.
    //
    // AT THE POP, not at the twelve push sites: a node below the floor may be pushed but is never
    // expanded, so no edge is ever generated OUT of it and the region is unreachable through it. One
    // edit where the other graph-level rejections already sit, instead of twelve chances to miss one.
    //
    // SUSPENDED WHEN THE BODY STARTS BELOW THE FLOOR. Applying it then would delete the start node on
    // the first pop, empty the heap, and report "unreachable" for every goal in the world — a bot that
    // fell into the layer could never route out of it again. The floor bars descent, not return.
    if (depthFloorArmed && belowDepthFloor(current.pos.y)) { visited.add(current.key); continue; }
    // min_y floor: reject nodes that would put feet (floorY+1) below the caller's working height,
    // so the bot walks horizontally at level instead of sinking through lower ground.
    if (goal.min_y != null && current.pos.y < goal.min_y - 1) { visited.add(current.key); continue; }

    // Charge the penalty HERE rather than at each of the twelve push sites, and the two are equivalent:
    // A* pops in nondecreasing f, so re-pushing a node with g raised by P delays it by exactly what
    // paying P on entry would have cost. One edit where the old hard ban sat, instead of twelve chances
    // to charge one edge wrong. Not marked visited — it must come back around and be expanded.
    //
    // The move-shaped key is available here WITHOUT moving the charge to those twelve sites: `parent`
    // already records which edge reached this node, so the pop knows both halves of the key. That is the
    // whole reason the charge can stay at one site while addressing a move — a cell entered by walk and
    // the same cell entered by bridge arrive with different parent edges and are priced separately.
    if (penaltyCharged) {
      const arrivedBy = parent.get(current.key);
      const moveKey = arrivedBy ? `${current.key}|${arrivedBy.edgeType}` : null;
      if (moveKey && !penaltyCharged.has(moveKey)) {
        const extra = movePenalties.get(moveKey);
        if (extra > 0) {
          penaltyCharged.add(moveKey);
          const pg = current.g + extra;
          gCost.set(current.key, pg);
          heap.push({ pos: current.pos, key: current.key, g: pg, f: fScore(pg, heuristic(current.pos, goal)) });
          continue;
        }
      }
    }

    visited.add(current.key);
    nodesVisited++;
    // The proven cost frontier: every route cheaper than this has been ruled out, because the heap pops
    // in nondecreasing f and the heuristic is admissible at W=1.0. This is what lets a short result say
    // "no route under 87 exists" instead of the false "unreachable" a node count can only imply
    // (Law 25). Sound ONLY at W=1.0 — a weighted search's f-order proves nothing.
    provenBound = current.f;

    const h = heuristic(current.pos, goal);
    // The partial is returned as a route the body walks and then STOPS on, so it is an endpoint and answers
    // to the same rule as the goal — gating only goalReached would leave the station stance reachable
    // through every timed-out search, which is the common case near a cluttered base.
    // Skipped WITHOUT lowering bestPartialH: recording the station's h would lock out every legal cell
    // behind it, turning one refused stance into no partial at all.
    if (h < bestPartialH && !endsOnStation(bot, current.pos, null)) {
      if (trace && (bestPartialKey === startKey || h < bestPartialH - 1)) trace('pathfinding', `A* progress: node#${nodesVisited} (${current.pos.x},${current.pos.y + 1},${current.pos.z}) h=${h.toFixed(1)} (was ${bestPartialH.toFixed(1)})`);
      bestPartialH = h;
      bestPartialKey = current.key;
      bestPartialPos = current.pos;
    }

    // Trace only near the goal (within 6 blocks) to keep the log readable.
    const nearGoal = h < 6;
    if (goalReached(bot, current.pos, goal, nearGoal ? trace : null)) {
      if (goal.type === 'los') {
        const d = straightLine(current.pos, goal.targetPos);
        if (d < bestLOSDist) {
          bestLOSKey = current.key;
          bestLOSPos = current.pos;
          bestLOSDist = d;
        }
        if (losFoundAtNode < 0) losFoundAtNode = nodesVisited;
        if (nodesVisited - losFoundAtNode >= LOS_REFINE_BUDGET) {
          reachedKey = bestLOSKey;
          reachedPos = bestLOSPos;
          break;
        }
      } else {
        reachedKey = current.key;
        reachedPos = current.pos;
        break;
      }
    }

    // LOS refinement budget exhausted — no closer LOS position found in the extra nodes.
    if (bestLOSKey && nodesVisited - losFoundAtNode >= LOS_REFINE_BUDGET) {
      reachedKey = bestLOSKey;
      reachedPos = bestLOSPos;
      break;
    }

    const cx = current.pos.x, cy = current.pos.y, cz = current.pos.z;
    const currentG = gCost.get(current.key);

    // Whether THIS column may be altered — the two edges that dig or place at the bot's own XZ
    // (dig_down, pillar). Computed once per pop rather than at those two sites so the pair cannot drift
    // apart in which column they think they are changing.
    const mayAlterHere = !inSpawnBox || !inSpawnBox(cx, cz);

    // --- Edge generation: check all movement types at this node ---

    // From a water node, outgoing walk/climb edges are re-typed 'swim' so the executor uses
    // swimStep (no digging, correct underwater Y model).
    const curNodeBlock = bot.blockAt(new Vec3(cx, cy, cz));
    const fromWater = isWaterBlock(curNodeBlock);

    if (trace && nodesVisited <= 3) {
      const floorBlock = bot.blockAt(new Vec3(cx, cy, cz));
      const feetBlock = bot.blockAt(new Vec3(cx, cy + 1, cz));
      const headBlock = bot.blockAt(new Vec3(cx, cy + 2, cz));
      trace('pathfinding', `EXPAND node#${nodesVisited} floor=(${cx},${cy},${cz}) block=${floorBlock ? floorBlock.name + '(' + floorBlock.boundingBox + ')' : 'null'} feet=${feetBlock ? feetBlock.name : 'null'} head=${headBlock ? headBlock.name : 'null'} water=${fromWater}`);
      for (const [ddx, , ddz] of CARDINAL) {
        const nnx = cx + ddx, nnz = cz + ddz;
        const wf = bot.blockAt(new Vec3(nnx, cy, nnz));
        const wf1 = bot.blockAt(new Vec3(nnx, cy + 1, nnz));
        const wf2 = bot.blockAt(new Vec3(nnx, cy + 2, nnz));
        const wf3 = bot.blockAt(new Vec3(nnx, cy + 3, nnz));
        const dLabel = ddx === 1 ? 'E' : ddx === -1 ? 'W' : ddz === 1 ? 'S' : 'N';
        trace('pathfinding', `  ${dLabel} floor=${wf ? wf.name + '(' + wf.boundingBox + ')' : 'null'} +1=${wf1?.name || 'null'} +2=${wf2?.name || 'null'} +3=${wf3?.name || 'null'}`);
      }
    }
    const DIRS = ['east','west','south','north'];
    let dirIdx = 0;
    for (const [dx, , dz] of CARDINAL) {
      const nx = cx + dx, nz = cz + dz;
      const dirName = DIRS[dirIdx++];
      // Whether the NEIGHBOUR column may be altered — the four edges that dig or place there
      // (dig_climb_up, dig_climb_down, dig_through, bridge). Read off the neighbour rather than the
      // current cell because that is the column whose blocks the edge actually changes: a bot standing
      // one block outside the square digging inward is still digging inside it.
      const mayAlterThere = !inSpawnBox || !inSpawnBox(nx, nz);

      // --- Walk edge (same Y) ---
      const walkFloorPos = new Vec3(nx, cy, nz);
      const walkFloor = bot.blockAt(walkFloorPos);
      const walkClass = classifyFloorInline(bot, walkFloor);
      if (walkClass) {
        const wk = keyOf(walkFloorPos);
        if (!visited.has(wk)) {
          const ng = currentG + floorMoveCost(walkFloor);
          if (!gCost.has(wk) || ng < gCost.get(wk)) {
            gCost.set(wk, ng);
            parent.set(wk, { parentKey: current.key, edgeType: fromWater ? 'swim' : (startInsideBin && current.key === startKey ? 'jump_out' : 'walk') });
            heap.push({ pos: walkFloorPos, key: wk, g: ng, f: fScore(ng, heuristic(walkFloorPos, goal)) });
          }
        }
      }

      // --- Stair up edge (+1Y) ---
      // isFullHeightFloor rejects partial-height blocks (chests, slabs) — see its note.
      const upFloorPos = new Vec3(nx, cy + 1, nz);
      const upFloor = bot.blockAt(upFloorPos);
      const upClass = classifyFloorInline(bot, upFloor);
      if (upClass && isFullHeightFloor(upFloor)) {
        const uk = keyOf(upFloorPos);
        if (!visited.has(uk)) {
          const ng = currentG + floorMoveCost(upFloor);
          if (!gCost.has(uk) || ng < gCost.get(uk)) {
            gCost.set(uk, ng);
            parent.set(uk, { parentKey: current.key, edgeType: fromWater ? 'swim' : 'climb_up' });
            heap.push({ pos: upFloorPos, key: uk, g: ng, f: fScore(ng, heuristic(upFloorPos, goal)) });
          }
        }
      }

      // --- Stair down edge (-1Y) ---
      const downFloorPos = new Vec3(nx, cy - 1, nz);
      const downFloor = bot.blockAt(downFloorPos);
      const downClass = classifyFloorInline(bot, downFloor);
      if (downClass) {
        const dk = keyOf(downFloorPos);
        if (!visited.has(dk)) {
          const ng = currentG + floorMoveCost(downFloor);
          if (!gCost.has(dk) || ng < gCost.get(dk)) {
            gCost.set(dk, ng);
            parent.set(dk, { parentKey: current.key, edgeType: fromWater ? 'swim' : 'climb_down' });
            heap.push({ pos: downFloorPos, key: dk, g: ng, f: fScore(ng, heuristic(downFloorPos, goal)) });
          }
        }
      }

      // --- Dig-assisted stair-UP edge (+1Y, staircase mined into a wall) ---
      // climb_up fires only when the cells above the tread are already clear. When the tread itself
      // is solid full-height ground but a diggable wall caps it, this edge digs the headroom and
      // stairs up — one of the two ascent primitives that let a buried bot climb toward the surface
      // (goal usually above) instead of boring a flat COST_HIGH tunnel across (Architect 2026-07-11).
      // COST_HIGH so a clear walk-around/climb always wins; reuses stairUpStep, which already digs
      // the obstructing foot/head blocks. Overhead cells are ceiling-checked (no flood, no gravity).
      if (allowDig && mayAlterThere && !upClass && !fromWater && isBlockSolid(upFloor) && isFloorSafe(upFloor) && isFullHeightFloor(upFloor)) {
        const curHead = bot.blockAt(new Vec3(cx, cy + 3, cz));   // clearance above the current head, to rise
        const upFoot  = bot.blockAt(new Vec3(nx, cy + 2, nz));   // cell the feet enter after stepping up
        const upHead  = bot.blockAt(new Vec3(nx, cy + 3, nz));   // cell the head enters — overhead of the tread
        const okOverhead = (b) => isBlockPassable(b) || isCeilingDiggable(b);
        if (okOverhead(curHead) && okOverhead(upFoot) && okOverhead(upHead)) {
          const uk = keyOf(upFloorPos);
          if (!visited.has(uk)) {
            const owned = [[cx, cy + 3, cz], [nx, cy + 2, nz], [nx, cy + 3, nz]]
              .some(([x, y, z]) => (protectedBlocks && protectedBlocks.has(`${x},${y},${z}`)));
            // Only the SOLID overhead cells are broken; the passable ones are already open (flowPrice).
            const upDug = [];
            if (isBlockSolid(curHead)) upDug.push([cx, cy + 3, cz]);
            if (isBlockSolid(upFoot))  upDug.push([nx, cy + 2, nz]);
            if (isBlockSolid(upHead))  upDug.push([nx, cy + 3, nz]);
            const upFlow = flowPrice(bot, upDug);
            const ng = currentG + Math.max(owned ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_HIGH, upFlow);
            if (!gCost.has(uk) || ng < gCost.get(uk)) {
              gCost.set(uk, ng);
              parent.set(uk, { parentKey: current.key, edgeType: 'dig_climb_up', protectedVoxel: owned, flowCharge: upFlow });
              heap.push({ pos: upFloorPos, key: uk, g: ng, f: fScore(ng, heuristic(upFloorPos, goal)) });
            }
          }
        }
      }

      // --- Dig-assisted stair-DOWN edge (-1Y, descent mined through a wall) ---
      // Mirror of dig_climb_up: the landing one down-and-over is solid, but a diggable wall blocks
      // the step into it. Dig foot+head and stair down. Sideways-and-down dig, so no gravity guard
      // (nothing lands on the head as the bot moves away/below). Reuses stairDownStep. COST_HIGH.
      if (allowDig && mayAlterThere && !downClass && !fromWater && isBlockSolid(downFloor) && isFloorSafe(downFloor)) {
        const dnFoot = bot.blockAt(new Vec3(nx, cy, nz));        // new feet cell
        const dnHead = bot.blockAt(new Vec3(nx, cy + 1, nz));    // new head cell
        const okDig = (b) => isBlockPassable(b) || (isBlockSolid(b) && b.diggable && !HAZARD_BLOCKS.has(b.name));
        if (okDig(dnFoot) && okDig(dnHead)) {
          const dk = keyOf(downFloorPos);
          if (!visited.has(dk)) {
            const owned = [[nx, cy, nz], [nx, cy + 1, nz]]
              .some(([x, y, z]) => (protectedBlocks && protectedBlocks.has(`${x},${y},${z}`)));
            const dnDug = [];
            if (isBlockSolid(dnFoot)) dnDug.push([nx, cy, nz]);
            if (isBlockSolid(dnHead)) dnDug.push([nx, cy + 1, nz]);
            const dnFlow = flowPrice(bot, dnDug);
            const ng = currentG + Math.max(owned ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_HIGH, dnFlow);
            if (!gCost.has(dk) || ng < gCost.get(dk)) {
              gCost.set(dk, ng);
              parent.set(dk, { parentKey: current.key, edgeType: 'dig_climb_down', protectedVoxel: owned, flowCharge: dnFlow });
              heap.push({ pos: downFloorPos, key: dk, g: ng, f: fScore(ng, heuristic(downFloorPos, goal)) });
            }
          }
        }
      }

      // Edge summary for the first 3 expansions so traces show why A* can/can't move.
      if (trace && nodesVisited <= 3) {
        const edges = [];
        if (walkClass) edges.push(`walk(${walkClass})`);
        if (upClass) edges.push('climb_up');
        if (downClass) edges.push(`climb_down(floor=${downFloor?.name})`);
        if (!walkClass && !upClass && !downClass) {
          const wfName = walkFloor ? `${walkFloor.name}(bbox=${walkFloor.boundingBox})` : 'null';
          const ufName = upFloor ? `${upFloor.name}(bbox=${upFloor.boundingBox})` : 'null';
          const dfName = downFloor ? `${downFloor.name}(bbox=${downFloor.boundingBox})` : 'null';
          // Check clearance above each floor to show WHY classifyFloor returned null
          const clearAboveWalk = walkFloor ? [1,2].map(i => { const b = bot.blockAt(walkFloorPos.offset(0,i,0)); return b ? b.name : 'null'; }).join(',') : '?';
          edges.push(`BLOCKED walk_floor=${wfName} up_floor=${ufName} down_floor=${dfName} walk_clearance=[${clearAboveWalk}]`);
        }
        trace('pathfinding', `  node#${nodesVisited} (${cx},${cy + 1},${cz}) ${dirName}: ${edges.join(' | ')}`);
      }

      // --- No fall edge ---
      // A straight drop off a ledge is never planned (Architect 2026-07-14): it is a multi-block,
      // irreversible move (no return route without pillaring) — parkour, disallowed. A ledge is
      // descended by a diagonal stair (climb_down / dig_climb_down carve one below-and-over) or, with
      // no lateral room, a vertical dig_down — both one block at a time and reversible.

      // --- Door edge (same Y, through a closed wooden door) ---
      // Doors have a solid bbox so walk edges skip them. Destination is the floor 2 cells out
      // (past the door) so the bot never halts inside the door block. COST_LOW (walk tier) so
      // A* opens doors rather than digging around them.
      if (!walkClass && !fromWater) {
        const doorFoot = bot.blockAt(new Vec3(nx, cy + 1, nz));
        const doorHead = bot.blockAt(new Vec3(nx, cy + 2, nz));
        if (isDoorBlock(doorFoot) && isDoorBlock(doorHead)) {
          const farX = nx + dx, farZ = nz + dz;
          const farFloor = bot.blockAt(new Vec3(farX, cy, farZ));
          const farClass = classifyFloorInline(bot, farFloor);
          if (farClass) {
            const farPos = new Vec3(farX, cy, farZ);
            const fark = keyOf(farPos);
            if (!visited.has(fark)) {
              const ng = currentG + COST_LOW;
              if (!gCost.has(fark) || ng < gCost.get(fark)) {
                gCost.set(fark, ng);
                parent.set(fark, { parentKey: current.key, edgeType: 'door' });
                heap.push({ pos: farPos, key: fark, g: ng, f: fScore(ng, heuristic(farPos, goal)) });
              }
            }
          }
        }
      }

      // --- Dig-through edge (same Y, through a wall) ---
      // Neighbor has a solid floor (support after digging) + diggable foot/head: dig one column,
      // step in. A* chains these across thick walls. Blocked from water — digging while swimming
      // is far too slow and unreliable.
      if (allowDig && mayAlterThere && !walkClass && !upClass && !fromWater) {
        const dtFloor = bot.blockAt(new Vec3(nx, cy, nz));
        const dtFoot  = bot.blockAt(new Vec3(nx, cy + 1, nz));
        const dtHead  = bot.blockAt(new Vec3(nx, cy + 2, nz));
        if (isBlockSolid(dtFloor) && !HAZARD_BLOCKS.has(dtFloor.name)
            && dtFoot && isBlockSolid(dtFoot) && dtFoot.diggable
            && dtHead && (isBlockPassable(dtHead) || (isBlockSolid(dtHead) && dtHead.diggable))) {
          const dtPos = new Vec3(nx, cy, nz);
          const dtk = keyOf(dtPos);
          if (!visited.has(dtk)) {
            // PROTECTED_VOXEL_DETOUR_BUDGET if either dug block belongs to a blueprint/station (don't chew structures),
            // else COST_HIGH for the dig itself.
            const headDug = isBlockSolid(dtHead) && dtHead.diggable;
            const footOwned = (protectedBlocks && protectedBlocks.has(`${nx},${cy + 1},${nz}`)) || STATION_TYPES.has(dtFoot.name);
            const headOwned = headDug && (((protectedBlocks && protectedBlocks.has(`${nx},${cy + 2},${nz}`))) || STATION_TYPES.has(dtHead.name));
            // The sideways bore is the edge that most often opens a pond or a lava lake into a corridor,
            // and it is the one that carried no flow rule at all before 2026-08-18.
            const dtDug = [[nx, cy + 1, nz]];
            if (headDug) dtDug.push([nx, cy + 2, nz]);
            const dtFlow = flowPrice(bot, dtDug);
            const ng = currentG + Math.max((footOwned || headOwned) ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_HIGH, dtFlow);
            if (!gCost.has(dtk) || ng < gCost.get(dtk)) {
              gCost.set(dtk, ng);
              parent.set(dtk, { parentKey: current.key, edgeType: 'dig_through', protectedVoxel: !!(footOwned || headOwned), flowCharge: dtFlow });
              heap.push({ pos: dtPos, key: dtk, g: ng, f: fScore(ng, heuristic(dtPos, goal)) });
            }
          }
        }
      }

      // --- Bridge edge (same Y, floor not solid) ---
      // Complement of dig_through: place a block over a non-solid gap (air, lava) to make a floor.
      // Lava-safe — the placed block covers the hazard. Water excluded (bot swims it, doesn't fill
      // it) and blocked from water nodes (placement while swimming is unreliable). A* chains gaps.
      if (allowPlace && mayAlterThere && !walkClass && !fromWater) {
        const brFloor = bot.blockAt(new Vec3(nx, cy, nz));
        if (brFloor && !isBlockSolid(brFloor) && !isWaterBlock(brFloor)) {
          const hasBlocks = bot.inventory.items().some(i => i.count > 0 && isScaffoldBlock(i.name));
          if (hasBlocks) {
            const brPos = new Vec3(nx, cy, nz);
            const brk = keyOf(brPos);
            if (!visited.has(brk)) {
              const ng = currentG + COST_PLACE; // place a block over the gap
              if (!gCost.has(brk) || ng < gCost.get(brk)) {
                gCost.set(brk, ng);
                parent.set(brk, { parentKey: current.key, edgeType: 'bridge' });
                heap.push({ pos: brPos, key: brk, g: ng, f: fScore(ng, heuristic(brPos, goal)) });
              }
              if (trace && nearGoal) trace('pathfinding', `  BRIDGE (${cx},${cy},${cz})→(${nx},${cy},${nz}) over ${brFloor.name} cost +${COST_PLACE}`);
            }
          } else if (trace && nearGoal) {
            trace('pathfinding', `  bridge SKIP (${cx},${cy},${cz})→(${nx},${cy},${nz}): NO construction blocks in inventory`);
          }
        }
      }

      // --- Swim edge (horizontal water entry / traversal) ---
      // Enter adjacent water at cy/cy±1, or continue water→water. Water→land EXIT isn't here —
      // walk/climb edges cover it (they gate on the destination floor, not the source). Fall-INTO-water
      // is gone with the fall edge (Architect 2026-07-14): dropping off a ledge into water is still a
      // jump-off, disallowed even though water negates the damage — the bot descends by stair/dig_down.
      {
        // Water in the neighbor column at cy / cy+1 / cy-1.
        for (const checkY of [cy, cy + 1, cy - 1]) {
          const checkBlock = bot.blockAt(new Vec3(nx, checkY, nz));
          if (isWaterBlock(checkBlock)) {
            const surfY = findWaterSurface(bot, nx, checkY, nz);
            if (surfY !== null) {
              const swimPos = new Vec3(nx, surfY, nz);
              const sk = keyOf(swimPos);
              if (!visited.has(sk)) {
                const ng = currentG + COST_HIGH; // swim
                if (!gCost.has(sk) || ng < gCost.get(sk)) {
                  gCost.set(sk, ng);
                  parent.set(sk, { parentKey: current.key, edgeType: 'swim' });
                  heap.push({ pos: swimPos, key: sk, g: ng, f: fScore(ng, heuristic(swimPos, goal)) });
                }
              }
            }
            break;
          }
        }
      }
    }

    // --- Dig-down edge (same XZ, -1Y) ---
    // Dig the floor, drop onto the block below (which must be solid and safe). Blocked from water nodes.
    // Adjacent liquid used to DELETE this edge outright — the file's one flow rule, water-only, on this
    // one edge. It is now flowPrice()'d like every other dig (Architect 2026-08-18): the ban meant a bot
    // in a pit ringed by water had no down move at all, and a bot that must go down to live should pay
    // rather than be refused. It now also sees lava, which the ban never did.
    if (allowDig && mayAlterHere && !fromWater) {
      const curFloorBlock = bot.blockAt(new Vec3(cx, cy, cz));
      const belowBlock = bot.blockAt(new Vec3(cx, cy - 1, cz));
      if (curFloorBlock && curFloorBlock.diggable
          && belowBlock && isBlockSolid(belowBlock) && !HAZARD_BLOCKS.has(belowBlock.name)) {
        const ddPos = new Vec3(cx, cy - 1, cz);
        const ddk = keyOf(ddPos);
        if (!visited.has(ddk)) {
          // PROTECTED_VOXEL_DETOUR_BUDGET if the floor belongs to a blueprint/station, else COST_HIGH for the dig.
          const floorOwned = (protectedBlocks && protectedBlocks.has(`${cx},${cy},${cz}`)) || STATION_TYPES.has(curFloorBlock.name);
          // The shaft opened is the floor cell AND the feet cell above it: the bot drops out of the feet
          // cell, so liquid reaching it pours straight down the hole it just made. Offering both to
          // flowPrice keeps the old ban's full sensing reach (cardinals at both levels) as a price.
          const ddFlow = flowPrice(bot, [[cx, cy, cz], [cx, cy + 1, cz]]);
          const ng = currentG + Math.max(floorOwned ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_HIGH, ddFlow);
          if (!gCost.has(ddk) || ng < gCost.get(ddk)) {
            gCost.set(ddk, ng);
            parent.set(ddk, { parentKey: current.key, edgeType: 'dig_down', protectedVoxel: !!floorOwned, flowCharge: ddFlow });
            heap.push({ pos: ddPos, key: ddk, g: ng, f: fScore(ng, heuristic(ddPos, goal)) });
          }
        }
      }
    }

    // --- Pillar edge (same XZ, +1Y) — the ONE straight-up move ---
    // pillarStep places a block underfoot mid-jump and rises; there is no "dig up and float" move
    // (digging opens space, it does not lift the body). One executor (pillarUpStep). Charged COST_PLACE
    // (the placement tier, 50) — pricier than a dig-stair (dig_climb_up, COST_HIGH 25), so A* prefers to
    // build a walkable diagonal staircase (a permanent two-way pathway) and only chimneys straight up
    // when that is genuinely shorter or nothing else reaches. A ceiling that belongs to a blueprint or
    // station is PROTECTED_VOXEL_DETOUR_BUDGET instead — the build owns its blocks (Law 16). Feet/head cells may read solid
    // against the STATIC world for a mid-shaft node (they are the shaft the prior pillar carves at
    // runtime); pillarStep clears both overhead before placing, so diggable there is allowed and the
    // shaft chains up through thick overburden. Hazard/gravity ceilings excluded (isCeilingDiggable).
    // DRY pillar: only from a solid-floored node (!fromWater), place cell passable. WATER bob-pillar
    // (Architect 2026-07-18): the place cell p1 floods AND a solid floor sits within BLOCK_REACH below —
    // the bot bobs and fills the column DOWN to it (never sinking; sink-to-any-depth is the deferred
    // mode), then stands out. This fires from a bobbing/water node too (fromWater is fine) as long as
    // that reachable floor exists; deeper than reach → no edge. "Needs a face to place against"
    // (Architect): the face is a solid within reach below — one block down is almost never enough, so
    // the scan looks the full BLOCK_REACH down, matching the executor's fill. p2/p3 keep plain shaftOk.
    if (allowPlace && mayAlterHere) {
      const pillarDest = new Vec3(cx, cy + 1, cz);
      const pk = keyOf(pillarDest);
      if (!visited.has(pk)) {
        const p1 = bot.blockAt(new Vec3(cx, cy + 1, cz));   // feet / place cell
        const p2 = bot.blockAt(new Vec3(cx, cy + 2, cz));   // head cell
        const p3 = bot.blockAt(new Vec3(cx, cy + 3, cz));   // ceiling / jump-peak
        const shaftOk = (b) => isBlockPassable(b) || isCeilingDiggable(b);
        const overWater = isWaterBlock(p1);
        let waterFloorInReach = false;
        if (overWater) {
          const maxDown = Math.max(1, Math.floor(BLOCK_REACH));
          for (let d = 0; d < maxDown; d++) {
            const b = bot.blockAt(new Vec3(cx, cy - d, cz));
            if (isBlockSolid(b) && !HAZARD_BLOCKS.has(b.name)) { waterFloorInReach = true; break; }
          }
        }
        const dryOk = !fromWater && shaftOk(p1);
        const clear = (dryOk || (overWater && waterFloorInReach)) && shaftOk(p2) && shaftOk(p3);
        const hasBlocks = bot.inventory.items().some(i => i.count > 0 && isScaffoldBlock(i.name));
        if (clear && hasBlocks) {
          const ceilingOwned = protectedBlocks && (protectedBlocks.has(`${cx},${cy + 2},${cz}`) || protectedBlocks.has(`${cx},${cy + 3},${cz}`));
          // Water-pillar carries a bob surcharge (COST_PLACE + COST_HIGH) over a dry pillar: bobbing and
          // filling down is slower and less certain than a grounded jump-place, so A* prefers any dry
          // route and a swim (COST_HIGH) to CROSS water, reserving the bob-pillar for getting OUT/UP
          // where nothing dry reaches.
          // pillarUpStep BREAKS whatever solid sits in the shaft as it rises, so the pillar is a dig edge
          // too and carries the same flow price. The bob-pillar's own water (p1) is not charged: it is
          // below the cells being broken and liquid does not flow up.
          const pDug = [];
          if (isBlockSolid(p1)) pDug.push([cx, cy + 1, cz]);
          if (isBlockSolid(p2)) pDug.push([cx, cy + 2, cz]);
          if (isBlockSolid(p3)) pDug.push([cx, cy + 3, cz]);
          const pFlow = flowPrice(bot, pDug);
          const pillarCost = Math.max(ceilingOwned ? PROTECTED_VOXEL_DETOUR_BUDGET : (overWater ? COST_PLACE + COST_HIGH : COST_PLACE), pFlow);
          const ng = currentG + pillarCost;
          if (!gCost.has(pk) || ng < gCost.get(pk)) {
            gCost.set(pk, ng);
            parent.set(pk, { parentKey: current.key, edgeType: 'pillar', protectedVoxel: !!ceilingOwned, flowCharge: pFlow });
            heap.push({ pos: pillarDest, key: pk, g: ng, f: fScore(ng, heuristic(pillarDest, goal)) });
          }
          if (trace && nearGoal) trace('pathfinding', `  PILLAR${overWater ? ' (water/bob)' : ''} (${cx},${cy},${cz})→+1Y cost +${ceilingOwned ? PROTECTED_VOXEL_DETOUR_BUDGET + ' (protected ceiling)' : pillarCost}`);
        } else if (trace && nearGoal) {
          // The "why didn't it pillar" answer: which gate deleted the straight-up edge.
          trace('pathfinding', `  pillar SKIP (${cx},${cy},${cz}): ${!hasBlocks ? 'NO construction blocks in inventory (bridge edge disabled too)' : (overWater && !waterFloorInReach) ? `water: no solid floor within reach (${Math.max(1, Math.floor(BLOCK_REACH))}) below` : `shaft blocked p1=${p1 && p1.name} p2=${p2 && p2.name} p3=${p3 && p3.name}`}`);
        }
      }
    }
  }

  // Loop ended with a valid vantage recorded but the refine-break never fired (fewer than
  // LOS_REFINE_BUDGET extra nodes existed) — use it.
  if (!reachedKey && bestLOSKey) {
    reachedKey = bestLOSKey;
    reachedPos = bestLOSPos;
  }

  // --- Path reconstruction ---
  // Reached → full path; not reached → partial path to the closest node (incremental SPA progress).
  const isPartial = !reachedKey;
  const endKey = reachedKey || bestPartialKey;
  const endPos = reachedPos || bestPartialPos;

  if (endKey === startKey) {
    // Goal satisfied at the start node (e.g. bot already has LOS). Empty path = "already there";
    // null = "no progress possible" — callers branch on the difference.
    if (reachedKey) {
      if (trace) trace('pathfinding', `A* ALREADY AT GOAL: start node (${start.x},${start.y + 1},${start.z}) satisfies goal directly. Returning empty path.`);
      return { path: [], target: reachedPos, cost: 0, nodesVisited, maxNodes, partial: false, residual: 0, timedOut, provenBound, complete: true };
    }
    if (trace) {
      const reason = nodesVisited >= maxNodes ? `budget exhausted (${nodesVisited}/${maxNodes} nodes)` : `heap empty after ${nodesVisited} nodes`;
      trace('pathfinding', `A* FAIL: best partial = start node (no progress possible). ${reason}. Start=(${start.x},${start.y + 1},${start.z}), goal h=${bestPartialH.toFixed(1)}. Heap had ${heap.size} remaining entries.`);
    }
    return null;
  }

  // `flowCharge` rides the step for the same reason and is a NUMBER, not a flag: 0, FLOW_DETOUR_BUDGET or
  // LAVA_FLOW_DETOUR_BUDGET, so the reader learns WHICH liquid the route commits to opening without
  // re-reading the world (by the time anyone reads the trace, the dig has already changed it — Invariant B
  // cuts the other way here, which is exactly why the price is carried rather than recomputed).
  //
  // `protectedVoxel` rides the step because CUTTING THE BUILD IS A DECISION SOMEBODY MUST HEAR ABOUT, and
  // only the search knows it was made. A* considers a protected edge on nearly every base-adjacent search
  // and discards almost all of them, so announcing at the charge site would cry wolf continuously; the
  // commitment happens here, when a charged edge survives into the returned route. Re-deriving it in the
  // caller was the alternative and it is a second implementation of edge geometry (which cells a
  // dig_climb_up actually breaks is known here and nowhere else) — Law 16.
  const path = [];
  let cur = endKey;
  while (cur && cur !== startKey) {
    const entry = parent.get(cur);
    if (!entry) break;
    const [px, py, pz] = cur.split(',').map(Number);
    path.push({ key: cur, pos: new Vec3(px, py, pz), edgeType: entry.edgeType, protectedVoxel: !!entry.protectedVoxel, flowCharge: entry.flowCharge || 0 });
    cur = entry.parentKey;
  }
  if (cur !== startKey) return null;
  path.reverse();

  // Residual: endpoint's remaining distance to goal — the caller judges whether the partial
  // progress is acceptable; locomotion only reports it.
  const residual = isPartial ? bestPartialH : 0;

  return {
    path,
    target: endPos,
    cost: gCost.get(endKey),
    nodesVisited,
    maxNodes,
    partial: isPartial,
    residual,
    timedOut,
    // What the search PROVED, as distinct from what it spent. `complete` true means the frontier ran dry
    // — every reachable cell was examined, so "no route" is a fact rather than a shortfall. False means
    // a budget or a clock stopped it, and then `provenBound` is the honest claim: nothing cheaper than
    // this exists. A caller that only reads `partial` learns it got less than it asked for; these two say
    // exactly how much less, which is what turns a give-up into a resumable answer (Law 25).
    provenBound,
    complete: !timedOut && nodesVisited < maxNodes,
  };
}

module.exports = {
  keyOf, straightLine,
  COST_LOW, COST_HIGH, COST_PLACE, PROTECTED_VOXEL_DETOUR_BUDGET,
  DOOR_BLOCKS, isDoorBlock,
  MIN_PLACEMENT_DIST,
  FLOW_DETOUR_BUDGET, LAVA_FLOW_DETOUR_BUDGET,
  computeAStar, drainSearchCensus, pathStillWalkable, MinHeap,
  isScaffoldBlock,   // exported so the navigator's give-up post-mortem counts pillar/bridge fuel from the one definition (Law 16)
  // EXPORT-ONLY, no behaviour change (2026-08-04). tools/voxel_classifier_prototype builds a
  // per-state-id table of these same verdicts and must derive it by CALLING these, never by copying
  // PASSABLE_BLOCKS/HAZARD_BLOCKS into a second list. A copied membership set is the exact failure
  // this file's own SCAFFOLD_BLOCKS comment records — "what is a placeable block" defined in five
  // places, only one of them canonical — and here the drift would be silent and structural: a
  // classifier that disagrees about passability plans routes through walls.
  isBlockPassable, isBlockSolid, isFullHeightFloor, isLeafFloor,
  // classifyFloorInline is the single definition of "is this a standable dry cell"
  // (safe floor + clear feet/head; water-feet fail because water isn't passable). Exported
  // so the water-escape gate reuses it instead of re-deriving shore detection (Law 16).
  classifyFloorInline,
};
