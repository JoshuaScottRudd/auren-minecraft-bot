// module: pathfinding_utils — the floor graph for ground and water-surface navigation.
// Free underwater movement belongs to underwater_pathfinding, with its own three-dimensional graph.
//
// Non-obvious contracts:
//  - Pure graph body; the timing wrapper admits expensive work through the foreman's computation gate.
//  - Operates on FLOOR-block positions — y is the block stood ON, not the feet cell.
//  - The parent map stores { parentKey, edgeType } per step so the executor knows HOW to cross each
//    cell, not just WHERE. There is no fall edge. Goals are always exact (position/multi/los).
//  - Out of budget → returns the closest explored node with partial:true, incremental SPA progress.
//  - ASYNC + THROTTLED: cedes a macrotask every ~tick via execution_yield (Law 16); every caller awaits it.

const Vec3 = require('vec3');
const { BLOCK_REACH, STATION_TYPES } = require('@utils/fragment_utils');
const { isWalkableSurface, isOpenTopContainer, isStationFloor, belowDepthFloor } = require('@utils/movement/terrain_predicates');
const { makeExecutionPacer } = require('@utils/execution_yield');
const { guardExternalSync } = require('@utils/external_library_guard');
const memoryWorkspace = require('@utils/memory_workspace');
const { MinHeap } = require('@utils/min_heap');

// Interaction geometry — each value encodes a failure mode, not a preference.
const MIN_PLACEMENT_DIST = 0.5;  // closer: lookAt angle too steep, placeBlock/anchor clicks misfire
const LOS_MAX_Y_GAP = 2;         // steeper feet→target: placement fails even when the raycast passes
const LOS_REFINE_BUDGET = 30;    // extra nodes explored after a valid vantage, to find a closer one
// No free-fall edge: every descent is reversible — climb_down, a straight dug staircase to the goal's
// level (dig_stair_down, STAIR LINES below), or a vertical dig_down. Jumping off a ledge is disallowed
// (Law 17 — a move with no return route is not legal).
//
// ── STAIR LINES: THE DIAGONAL MOVE IS ONE WHOLE SECTION OF STAIRCASE ─────────────────────────────────────
// A dug descent or ascent is ONE move: a straight run, one block over and one down (or up) per step, to
// a level the goal stands on. There is no one-step dig stair, so nothing turns mid-descent. Each step
// clears THREE cells — feet, head, and the headroom climb_up needs to walk it back up, so it is two-way
// from the moment it is dug. Priced under dig_down's per-block cost, so a whole stair wins wherever it
// fits; where it does not (bedrock, hazard, closed box) dig_down and pillar remain.

// ── Movement cost: four tiers + the per-edge catalog ─────────────────────────
// A* sums edge costs; cheapest route wins, so a walk-around beats altering the world unless none exists.
// All tiers are finite. COST_LOW/HIGH/PLACE approximate real EFFORT; the *_DETOUR_BUDGET constants
// below are PREFERENCE — how many extra walk-steps avoiding a move is worth.
const COST_LOW   = 1.0;     // free traversal — cross the world unchanged
const COST_HIGH  = 15.0;    // dig one block / swim
const COST_PLACE = 25.0;    // place a block (pillar, bridge) — consumes inventory, costs more than digging
const COST_WATER_EXIT = 3.0;     // walk out of water onto a bank level with it — the cheapest way out of water there is
const COST_STAIR_STEP = 10.0;    // one step of a dug staircase — under dig_down's per-block cost (STAIR LINES)
const MAX_STAIR_RUN = 48;        // longest staircase one edge may be; deeper stairs to the bound, then other edges
// FLAT GROUND IS PREFERRED: a step up an existing tread, or down one, costs a little more than a flat step, so of two
// routes of near length the flatter wins and a hill is climbed only for a real saving. A preference, never a ban.
const COST_CLIMB_UP = 1.5;
const COST_CLIMB_DOWN = 1.2;
// PROTECTED_VOXEL_DETOUR_BUDGET — a POLICY number: extra walk-steps the bot spends to spare a blueprint
// or station voxel, added to the remaining walk. Also sets the search's flood radius (A* must rule out
// every cheaper route before accepting a priced edge).
const PROTECTED_VOXEL_DETOUR_BUDGET = 50.0;

// ── Flow creation: a dig that opens a face onto a liquid ─────────────────────
// Breaking a block touching water or lava lets it pour into the opened space. A dig onto water is
// no edge (opensOntoWater — the bot never makes a flow trap); a dig onto lava is priced at the
// model's ceiling.
const LAVA_FLOW_DETOUR_BUDGET = PROTECTED_VOXEL_DETOUR_BUDGET;      // onto lava — the ceiling, by reference

// ── One search, goal-focused ─────────────────────────────────────────────────
// A single A* frontier (f = g + W*h) serves every goal. W = 1.0: straight-line distance is always
// admissible, so the returned route is provably the cheapest that exists (NO NODE BUDGET below).
const HEURISTIC_WEIGHT = 1.0;
//
// EDGE CATALOG — every edgeType the pathfinder emits, its walker (navigator.js), and its cost. This is
// the single inspection point for what edges exist and what they cost; keep it in sync on a retune.
//   walk            COST_LOW  (1)      bridgeLevelStep   one flat cell
//   climb_up        COST_CLIMB_UP(1.5) stairUpStep       step up an existing +1 tread
//   climb_down      COST_CLIMB_DOWN(1.2) stairDownStep   step down an existing -1 floor (diagonal); where the
//                                                        head's crossing cell holds a block it is one dig_stair_down step
//   door            COST_LOW  (1)      stepToFeet        walk through a wooden door
//   swim            COST_HIGH (15)     swimStep          enter / traverse water
//   water_exit      COST_WATER_EXIT(3) swimStep          WATER TO LAND: onto a solid block level with the surface cell,
//                                                        feet and head cells above it clear. The first way out of water.
//   water_bank_out  COST_PLACE+COST_WATER_EXIT+COST_LOW(29)  waterBankOutStep   WATER TO LAND BY PLACING, onto a bank one
//                                                        block over the water: a block set in the surface cell beside the
//                                                        body, against the bank; out onto it; one step up. The second way out.
//   water_step_up   2*COST_PLACE+COST_WATER_EXIT(53)  waterStepUpStep  WATER UP BY PLACING, out of one block of water with
//                                                        no bank to climb: a block set in the shallow water cell beside the body
//                                                        (solid ground under it), out onto it, one pillar up. The third way out.
//   * a dig from water costs WATER_DIG_STANDING (5x) standing in it and WATER_DIG_AFLOAT (25x) afloat; no edge steps UP
//     from a water node without placing. Dug stair lines are never offered from water.
//   dig_through     COST_HIGH (15)     digThroughStep    dig a same-Y wall, step in
//   dig_down        COST_HIGH (15)     digDownStep       dig the floor, drop 1
//   dig_stair_down  COST_STAIR_STEP(10)/step  stairDownStep  ONE straight dug stair to the goal's level (STAIR LINES)
//   dig_stair_up    COST_STAIR_STEP(10)/step  stairUpStep    the same, upward; treads must exist
//   bridge          COST_PLACE(25)     bridgeLevelStep   place a block over a gap, cross
//   pillar          COST_PLACE(25)     pillarUpStep      place underfoot + rise — the ONLY straight-up move
//   * a cell inside one of opts.closedBoxes is not in the graph at all — see CLOSED BOXES in the search body.
//   * a leaf is never a floor: no edge lands on one (terrain_predicates.isWalkableSurface).
//   * any edge that digs or covers a PROTECTED / station voxel is charged PROTECTED_VOXEL_DETOUR_BUDGET.
//   * any edge that DIGS is additionally floor-priced by flowPrice() (LAVA_FLOW_DETOUR_BUDGET), by
//     Math.max against the base, never a sum; an edge whose dig opens onto water is not offered.

// The name test lives in `leaf_authority`, asked here, not duplicated (Law 16). The voxel reader's
// flag table reads it per block state, and the dig-down edge reads it to bring a body out of a canopy.
function isLeafFloor(block) {
  return require('@utils/movement/leaf_authority').isLeafBlock(block);
}

// Digging a station costs PROTECTED_VOXEL_DETOUR_BUDGET; WHICH blocks are stations is fragment_utils.STATION_TYPES (Law 16).
const keyOf = (p) => `${p.x},${p.y},${p.z}`;
const straightLine = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// The 4 cardinals — the neighbor set every move edge (walk, climb, swim, dig) scans.
const CARDINAL = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

// ── computeAStar — the pathfinder. ──
// bot — mineflayer bot. startPos — Vec3/{x,y,z}, the bot's FLOOR position (block stood ON).
// goal — { type:'position', pos } | { type:'multi', positions:[…] } | { type:'los', targetPos }.
// opts — { maxNodes?, blacklist?, movePenalties?, protectedBlocks?, spareBuilds?, closedBoxes?, trace?, deadlineMs?, owner?, sense?, planningGate? }.
// sense() supplies fresh world-dependent options after workspace admission.
// Returns { path:[{key,pos,edgeType}], target, cost, partial, residual, provenBound, complete }, or
// null when no path exists.

// Water: swimmable, not walkable. Also in HAZARD_BLOCKS so no walk/climb edge routes through a
// submerged column (the bot can't walk underwater); swim edges carry all water traversal instead.
const WATER_BLOCKS = new Set(['water', 'flowing_water']);

function isWaterBlock(block) { return block && WATER_BLOCKS.has(block.name); }

// isStillWater — a water SOURCE (level 0), the only water a body swims. Flowing water (level 1-15)
// carries a body like a current, so it is a hazard kept out of every route, the same as lava.
function isStillWater(bot, x, y, z) { return require('@utils/gravity_utils').isWaterSource(bot, x, y, z); }

// RUNNING_WATER_DETOUR_BUDGET — the PREFERENCE price of entering a running-water cell, by swim or wade: a route
// through running water is taken only when every way round it is longer than this many steps. Equal to the
// protected-voxel budget, so it does not widen the search's flood radius.
const RUNNING_WATER_DETOUR_BUDGET = PROTECTED_VOXEL_DETOUR_BUDGET;

// ── TEMPORARY, until a body swims a current and the route prices it as a risky move ─────────────────────────────────
// No route ENTERS running water: the swim and wade edges into it are refused, and so is a landing beside running water
// that pours over a drop deeper than FALL_SCAN_DOWN (a ravine's lip, where the current carries a body over the edge). A
// body already in running water still routes out of it by every edge. This is the cheap form, to be replaced, not kept.
const RUNNING_WATER_ENTERED = false;
function isRunningWaterCell(bot, x, y, z) {
  return isWaterBlock(bot.blockAt(new Vec3(x, y, z))) && !isStillWater(bot, x, y, z);
}
// inRunningWater(bot, x, y, z, ownWater) — does the body of the node with floor (x,y,z) stand or float in running water?
function inRunningWater(bot, x, y, z, ownWater) {
  if (isRunningWaterCell(bot, x, y, z)) return true;
  for (const k of ownWater) { const [wx, wy, wz] = k.split(',').map(Number); if (!isStillWater(bot, wx, wy, wz)) return true; }
  return false;
}
// besideCurrentOverDrop(bot, x, y, z) — is the stand on floor (x,y,z) beside running water, at its floor or feet, that
// leads within CURRENT_REACH cells (through running water, sideways or down) to running water with no solid block within
// FALL_SCAN_DOWN under it? Water under it is no floor: it may be a falling column. The water beside a lip may stand on
// ground of its own and still carry a body into the column it feeds.
const CURRENT_REACH = 4;
function overDrop(bot, wx, wy, wz) {
  for (let d = 1; d <= FALL_SCAN_DOWN; d++) {
    const b = bot.blockAt(new Vec3(wx, wy - d, wz));
    if (b && b.boundingBox === 'block') return false;
  }
  return true;
}
function besideCurrentOverDrop(bot, x, y, z) {
  const seen = new Set();
  let ring = [];
  for (const [dx, , dz] of CARDINAL) {
    for (const wy of [y, y + 1]) {
      const k = `${x + dx},${wy},${z + dz}`;
      if (!seen.has(k) && isRunningWaterCell(bot, x + dx, wy, z + dz)) { seen.add(k); ring.push([x + dx, wy, z + dz]); }
    }
  }
  for (let step = 0; ring.length && step <= CURRENT_REACH; step++) {
    const next = [];
    for (const [wx, wy, wz] of ring) {
      if (overDrop(bot, wx, wy, wz)) return true;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        const k = `${wx + dx},${wy + dy},${wz + dz}`;
        if (seen.has(k) || !isRunningWaterCell(bot, wx + dx, wy + dy, wz + dz)) continue;
        seen.add(k); next.push([wx + dx, wy + dy, wz + dz]);
      }
    }
    ring = next;
  }
  return false;
}

// wadeable — a floor a body stands on in running water: a full, safe floor; running water (not a source, not a
// falling column) in the feet cell; a head cell the body passes and no water in it.
function wadeable(bot, floorBlock) {
  if (!floorBlock || !isFloorSafe(floorBlock) || !isFullHeightFloor(floorBlock)) return false;
  const p = floorBlock.position;
  const feet = bot.blockAt(p.offset(0, 1, 0));
  if (!isWaterBlock(feet)) return false;
  const level = require('@utils/gravity_utils').waterLevel(bot, p.x, p.y + 1, p.z);
  if (level === null || level === 0 || level >= 8) return false;
  const head = bot.blockAt(p.offset(0, 2, 0));
  return !!head && !isWaterBlock(head) && isBlockPassable(head);
}

// Wooden doors — openable by hand (activateBlock). Iron doors excluded: they need redstone.
const DOOR_BLOCKS = new Set([
  'oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
  'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door',
]);

function isDoorBlock(block) { return block && DOOR_BLOCKS.has(block.name); }

// ── THE AIRLOCK — an iron door worked by a button, optionally with one fence gate in line ───────────
// A gate counts only in line with an iron door, so a pen's or a stall's gate is never a route. The whole
// passage is one edge, from a stand on one side to the floor on the other: a chamber's carpet would read as
// a floor one cell higher than the doorway, and no body should plan to stop between two barriers.
const AIRLOCK_SPAN = 4;   // cells searched along the line: the door, the chamber, the gate

function isFenceGate(block) { return !!block && block.name.endsWith('_fence_gate'); }
function isAirlockChamber(bot, x, y, z) {
  const foot = bot.blockAt(new Vec3(x, y + 1, z));
  const head = bot.blockAt(new Vec3(x, y + 2, z));
  return !!foot && !!head && isBlockPassable(head) && (foot.name.endsWith('_carpet') || isBlockPassable(foot));
}

// The door's button on the body's side (side = the unit step from the door toward the body), or null. A button
// beside the door counts by the way it faces, one in front of the door by where it is. Read from the world
// itself: the search's fast view carries no block properties.
function airlockButton(bot, door, side) {
  const hits = [];
  for (const half of [0, 1]) {
    for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const at = new Vec3(door.x + ox, door.y + half + oy, door.z + oz);
      const block = bot.world?.getBlock?.(at);
      if (!block || !block.name.endsWith('_button')) continue;
      const along = ox * side.x + oz * side.z;
      if (along < 0) continue;
      if (along === 0) {
        const facing = block.getProperties?.().facing;
        const out = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[facing];
        if (!out || out[0] * side.x + out[1] * side.z <= 0) continue;
      }
      hits.push(at);
    }
  }
  return hits[0] || null;
}

// Reads an airlock ahead of a stand on floor (cx,cy,cz) along (dx,dz): { barriers, chamber, far }, or null.
// barriers are in walking order; a body standing inside the chamber has one barrier ahead, and the door may
// then be behind it. Every door barrier has a button on the near side.
function readAirlock(bot, cx, cy, cz, dx, dz) {
  const at = (i, up) => bot.blockAt(new Vec3(cx + dx * i, cy + up, cz + dz * i));
  const isIronDoor = (i) => at(i, 1)?.name === 'iron_door' && at(i, 2)?.name === 'iron_door';
  const barriers = [], chamber = [];
  let i = 1;
  for (; i <= AIRLOCK_SPAN; i++) {
    const x = cx + dx * i, z = cz + dz * i;
    if (isIronDoor(i)) {
      if (barriers.some(b => b.kind === 'door')) return null;
      barriers.push({ kind: 'door', pos: new Vec3(x, cy + 1, z) });
    } else if (isFenceGate(at(i, 1)) && isBlockPassable(at(i, 2))) {
      if (barriers.some(b => b.kind === 'gate')) return null;
      barriers.push({ kind: 'gate', pos: new Vec3(x, cy + 1, z) });
    } else if (!isAirlockChamber(bot, x, cy, z)) {
      break;
    } else {
      chamber.push(new Vec3(x, cy + 1, z));
    }
  }
  if (!barriers.length) return null;
  const last = barriers[barriers.length - 1].pos;
  const lastAt = Math.abs(last.x - cx) + Math.abs(last.z - cz);
  if (!barriers.some(b => b.kind === 'door')) {
    // A gate alone is an airlock only from inside the chamber, with the door straight behind the body.
    let behind = false;
    for (let b = 1; b <= AIRLOCK_SPAN && !behind; b++) {
      if (bot.blockAt(new Vec3(cx - dx * b, cy + 1, cz - dz * b))?.name === 'iron_door') behind = true;
      else if (!isAirlockChamber(bot, cx - dx * b, cy, cz - dz * b)) break;
    }
    if (!behind) return null;
  }
  for (const b of barriers) {
    if (b.kind !== 'door') continue;
    b.button = airlockButton(bot, b.pos, { x: -dx, z: -dz });
    if (!b.button) return null;
  }
  const far = new Vec3(cx + dx * (lastAt + 1), cy, cz + dz * (lastAt + 1));
  return { barriers, chamber: chamber.filter(c => Math.abs(c.x - cx) + Math.abs(c.z - cz) < lastAt), far };
}

// findWaterSurface: from a water block, climb to the surface Y, or null if capped by solid (no swim node).
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

// Never passable. Water forces swim edges; the rest are Law 17 hazards the planner routes around.
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

// Mirrors getClearance in movement/terrain_predicates, on a raw block (no relative offset). A phantom
// leaf is passable overhead and is no floor underfoot (isWalkableSurface) — clearance and footing are
// two separate questions, asked of the same block.
function isBlockPassable(block) {
  if (!block) return false;
  if (PASSABLE_BLOCKS.has(block.name)) return true;
  if (HAZARD_BLOCKS.has(block.name)) return false;
  if (block.boundingBox === 'empty') return true;
  // Reads global.bot, not a threaded parameter: called from A*'s innermost loop through call sites with
  // no bot in scope. A worldless caller (lanista, a bench) has no global and gets `false`.
  return global.bot ? require('@utils/movement/leaf_authority').isPhantom(global.bot, block) : false;
}

function isBlockSolid(block) {
  if (!block) return false;
  return block.boundingBox !== 'empty' && block.name !== 'air';
}

// Blocks that fall when their support is removed — digging one OVERHEAD drops it on the bot's head
// (Law 17). Excluded as ceiling for the upward pillar / dig_stair_up edges.
const FALLING_BLOCKS = new Set([
  'sand', 'red_sand', 'gravel',
  'anvil', 'chipped_anvil', 'damaged_anvil',
  'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder',
  'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder',
  'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder',
  'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder',
  'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder', 'black_concrete_powder',
]);

// isLooseTread: a gravity block resting on nothing solid. It holds only until a block update next to
// it, and a stair step digs beside its tread, so a stair never lands on one.
function isLooseTread(bot, tread) {
  return FALLING_BLOCKS.has(tread.name) && !isBlockSolid(bot.blockAt(tread.position.offset(0, -1, 0)));
}

// isCeilingDiggable: safe to dig a block sitting ABOVE the bot — solid, diggable, not a hazard or a
// gravity block. Gates the upward dig edges only; a sideways dig has no such risk.
function isCeilingDiggable(block) {
  if (!isBlockSolid(block)) return false;
  if (!block.diggable) return false;
  if (HAZARD_BLOCKS.has(block.name)) return false;
  if (FALLING_BLOCKS.has(block.name)) return false;
  return true;
}

// Lava, named apart from HAZARD_BLOCKS: that set answers whether the body may enter a cell; this one
// answers how bad it is to open a face onto it.
const LAVA_BLOCKS = new Set(['lava', 'flowing_lava']);

// The cells a liquid can reach a newly-broken block from: the four cardinals and the one ABOVE, never
// BELOW — liquid does not flow upward.
const FLOW_NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

// opensOntoWater — true when breaking the cell at (x,y,z) would let water flow into it: water on one
// of its FLOW_NEIGHBORS. The one predicate for "a dig here creates flow" — A* reads it through
// flowPrice and dig_authority.performDig reads it directly, so a planned dig and an executed dig
// answer the same question (Law 16).
//
// The cell broken is not the only cell opened. Sand or gravel resting on it falls into the gap, and the
// cells that column LEAVES at its top are open too, so each of those is asked the same question. The
// column falls as far as the first solid block under the broken cell.
const FALL_SCAN_DOWN = 8;
// WATER IS HELD BY MORE THAN WATER: a riverbed's seagrass and kelp, a bubble column and any waterlogged block stand in
// a water source, and the water flows the moment the block under or beside them opens (the plant pops off its
// broken floor and leaves its source behind). Answered once per block state.
const HOLDS_WATER = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
const _holdsWater = new Map();
function holdsWater(b) {
  if (WATER_BLOCKS.has(b.name) || HOLDS_WATER.has(b.name)) return true;
  let held = _holdsWater.get(b.stateId);
  if (held === undefined) {
    held = typeof b.getProperties === 'function' && b.getProperties().waterlogged === true;
    _holdsWater.set(b.stateId, held);
  }
  return held;
}
// THE BODY'S OWN WATER IS NOT NEW WATER: `own` (bodyWater) names the water cells the body already stands in. A dig
// that opens onto them lets in nothing the body is not already in, so they are passed over; any other water is not.
function touchesWater(bot, x, y, z, own = null) {
  for (const [dx, dy, dz] of FLOW_NEIGHBORS) {
    if (own && own.has(`${x + dx},${y + dy},${z + dz}`)) continue;
    const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
    if (b && holdsWater(b)) return true;
  }
  return false;
}
function opensOntoWater(bot, x, y, z, own = null) {
  if (touchesWater(bot, x, y, z, own)) return true;
  let top = y;
  for (;;) {
    const b = bot.blockAt(new Vec3(x, top + 1, z));
    if (!b || !FALLING_BLOCKS.has(b.name)) break;
    top++;
  }
  if (top === y) return false;
  let drop = 1;
  for (; drop <= FALL_SCAN_DOWN; drop++) {
    const b = bot.blockAt(new Vec3(x, y - drop, z));
    if (b && b.boundingBox === 'block') break;
  }
  for (let cy = top; cy > top - drop && cy > y; cy--) if (touchesWater(bot, x, cy, z, own)) return true;
  return false;
}

// bodyWater(bot, x, y, z) → 'x,y,z' of the water cells a body whose feet cell is (x,y,z) stands in: below its feet,
// at its feet and at its head. Empty for a dry body.
function bodyWater(bot, x, y, z) {
  const own = new Set();
  for (let dy = -1; dy <= 1; dy++) {
    const b = bot.blockAt(new Vec3(x, y + dy, z));
    if (b && holdsWater(b)) own.add(`${x},${y + dy},${z}`);
  }
  return own;
}

// A DIG FROM WATER IS PRICED AT THE GAME'S OWN TIMES, NOT BANNED: a block breaks five times slower with the head in
// water (no aqua affinity), and five times slower again off the ground. A body standing in water digs at
// WATER_DIG_STANDING times the dry price, a body afloat at WATER_DIG_AFLOAT, so a dig from water is the last way out,
// taken only where no walk, swim or placed block reaches.
const WATER_DIG_STANDING = 5;
const WATER_DIG_AFLOAT = 25;

// flowPrice — the floor price for a dig, given the [x,y,z] cells the edge actually BREAKS: 0 for a
// dry dig, the lava ceiling for a dig that opens onto lava, and null for a dig that opens onto water,
// which is no edge at all (performDig refuses it, so A* never offers it).
function flowPrice(bot, cells, own = null) {
  for (const [x, y, z] of cells) if (opensOntoWater(bot, x, y, z, own)) return null;
  for (const [x, y, z] of cells) {
    for (const [dx, dy, dz] of FLOW_NEIGHBORS) {
      const b = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
      if (b && LAVA_BLOCKS.has(b.name)) return LAVA_FLOW_DETOUR_BUDGET;   // ceiling — nothing can outrank it
    }
  }
  return 0;
}

// Placeable as a pillar/bridge block — reads scaffold_block, the gravity-filtered exposure, so a bridge
// is never planned over a block that falls from under it (Law 13), from the one canonical list (Law 16).
// No `|| []`: an absent group is a coding violation (Law 13, Law 26).
const SCAFFOLD_BLOCKS = new Set(
  require('@utils/fragment_utils').group_to_item.scaffold_block
);
function isScaffoldBlock(name) { return SCAFFOLD_BLOCKS.has(name); }

// isFloorSafe: is this block a standable floor for A*? Delegates to isWalkableSurface, the one
// walkability definition the step executor also uses (Law 16).
function isFloorSafe(block) {
  return isWalkableSurface(block);
}

// isFullHeightFloor: does the floor's collision top reach y=1.0? Partial-height blocks (chest, slab,
// bed) report boundingBox='block' but sit below y+1, which climb_up cannot tolerate; gates climb_up only.
function isFullHeightFloor(block) {
  if (!block || !block.shapes || block.shapes.length === 0) return true;
  let maxY = 0;
  for (const shape of block.shapes) { if (shape[4] > maxY) maxY = shape[4]; }
  return maxY >= 1.0;
}

// classifyFloorInline: terrain_predicates.classifyFloor via bot.blockAt. 'jumpable' = 3 air above,
// 'walkable' = 2 air, null = blocked/unsafe. `_classifyFloorAt` is the live path against a real world
// (armed by _fastVoxelView); the block path below is the only path a worldless caller has (lanista, the
// virtual playground) — it answers identically by derivation: isFloorSafe IS isWalkableSurface.
function classifyFloorInline(bot, floorBlock) {
  if (!floorBlock) return null;
  if (bot._classifyFloorAt) {
    const p = floorBlock.position;
    return bot._classifyFloorAt(p.x, p.y, p.z, floorBlock.stateId);  // caller already read this cell
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

// endsOnStation — the last gate every goal type passes through: a route may cross a station but may not
// rest on one (terrain_predicates.isStationFloor). Run only after a goal type's own cheap test, since
// this is a world read and goalReached runs on every popped node.
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
    // Two proximity gates before LOS matters: close enough, and at a usable height — without them A*
    // accepts a vantage whose raycast passes but whose interaction angle is too steep to place/dig.
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
  // THERE IS NO 'near' GOAL TYPE. A station is approached through its blueprint ANCHOR — one authored
  // cell, always the same (Law 19) — via `locomotion.goToStationStance`, which resolves the owning
  // anchor and uses the ordinary exact-position goal.
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

// _fastVoxelView — swaps this search's world reads onto the per-state-id table; every `bot.blockAt`
// call is unchanged, only what it resolves to moves. Object.create keeps `world`, `entity` and
// `inventory` resolving to the real bot. Returns the bot unchanged when there is no `world` to read
// state ids from, so a worldless caller (lanista, a bench) searches the world it asked about (Law 25).
// One reader per bot, not per search (Law 8), held in a WeakMap so it is collected with the bot.
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
  // A body's own search reads its floors from the body's labels (voxel_labels), the same verdict kept current; a
  // reader handed in by the caller answers for itself.
  view._classifyFloorAt = readerOverride ? reader.classifyFloorAt : require('@utils/voxel_labels').labelsFor(bot).floorAt;
  return view;
}

// ── THE SEARCH CENSUS — what each pathfind costs, posted where a trace reader can see it ────────────
// Accumulates cost per search, drained and posted by the caller. Watcher-free (like `trace`) so it can
// run from the benches and the virtual playground too — one aggregated line per unit of work (Law 5).
// Module-level state is safe because a decision-maker holds one `global.bot` (Law 4).
// KEYED BY OWNER (Invariant D): any fragment may search, so a tally billed to the last drainer would mix
// different callers' deadlines. `opts.owner` names the true owner; untagged is its own bucket (Law 13).
const UNATTRIBUTED_SEARCH_OWNER = 'unattributed';
const _blankTally = () => ({ searches: 0, totalMs: 0, maxMs: 0, nodes: 0, partial: 0, timedOut: 0, failed: 0, incomplete: 0, workspaceWaitMs: 0, activeMs: 0, resourceLimited: 0 });
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
// The timing wrapper is the ONLY way in, so no call site can escape the census (Law 25).
// ── pathStillWalkable — re-verify a plan instead of re-planning it ──────────────────────────────────
// Answers whether the route being walked is still legal, for the cells not yet walked, via the same
// classifyFloorInline over the same per-bot reader the search used (Invariant B — re-senses; never trusts
// a timer). Checks STILL-VALID, never STILL-OPTIMAL. Only edges needing standable ground are
// checked; a dig/bridge/pillar step is going to change its destination, so that is caught by the
// executor and priced through movePenalties instead.
const VERIFIABLE_EDGES = new Set(['walk', 'climb_up', 'climb_down', 'door', 'airlock', 'jump_out']);
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
  const liveStart = bot.entity?.position;
  const startsAtBody = liveStart && startPos.x === Math.floor(liveStart.x)
    && startPos.z === Math.floor(liveStart.z) && startPos.y === Math.floor(liveStart.y) - 1;
  let activeAt = t0;
  const search = () => {
    activeAt = Date.now();
    // A queued body can move under physics; a route from its body starts at the newly sensed floor.
    const current = bot.entity?.position;
    const from = startsAtBody && current ? new Vec3(Math.floor(current.x), Math.floor(current.y) - 1, Math.floor(current.z)) : startPos;
    const sensedOpts = opts.sense ? { ...opts, ...opts.sense() } : opts;
    return memoryWorkspace.withTemporaryMemory(track => _computeAStarBody(bot, from, goal, sensedOpts, track));
  };
  // opts.planningGate === false: a fight's search, bounded by its own short deadline, never waits in the fleet's
  // planning line behind another body's plan (the combat driver's route). Its heap growth is still bounded below.
  const res = opts.planningGate === false ? await search() : await require('@kernel/foreman_link').withComputationWorkspace(search);
  const ms = Date.now() - t0;
  const owner = opts.owner || UNATTRIBUTED_SEARCH_OWNER;
  let tally = _census.get(owner);
  if (!tally) { tally = _blankTally(); _census.set(owner, tally); }
  tally.searches++;
  tally.totalMs += ms;
  tally.workspaceWaitMs += activeAt - t0;
  tally.activeMs += ms - (activeAt - t0);
  if (ms > tally.maxMs) tally.maxMs = ms;
  if (res) {
    tally.nodes += res.nodesVisited;
    if (res.partial) tally.partial++;
    if (res.timedOut) tally.timedOut++;
    // Paired with `partial` to carry the full verdict (Law 25): partial+complete is a proven no-route,
    // partial+INCOMPLETE reads only as nothing cheaper than provenBound, never as unreachable.
    if (!res.complete) tally.incomplete++;
    if (res.resourceLimited) tally.resourceLimited++;
  } else {
    tally.failed++;
  }
  return res;
}

async function _computeAStarBody(bot, startPos, goal, opts = {}, track) {
  const heapAtStart = process.memoryUsage().heapUsed;
  const boundedMemory = memoryWorkspace.enabled();
  let resourceLimited = false;
  bot = _fastVoxelView(bot, opts.voxelReader);
  const start = new Vec3(Math.floor(startPos.x), Math.floor(startPos.y), Math.floor(startPos.z));
  const startKey = keyOf(start);

  // ── NO NODE BUDGET ─────────────────────────────────────────────────────────────────────────────────
  // No maxNodes, no default one — a guessed distance→nodes cap emits a false "unreachable" for ground
  // the bot could walk to (Law 25). What terminates instead: the goal pops; the heap empties (genuinely
  // no route); or opts.deadlineMs (timedOut + provenBound). `maxNodes` survives only as a bench opt-in.
  const maxNodes = opts.maxNodes || Infinity;

  // The shared cooperative pacer (Law 16): runs a burst for up to one tick, then cedes a macrotask so
  // physics, the tick and peer bots get a slice. `bot` arms the pacer's combat gate against a long blind
  // window; opts.combatGate === false turns it off for a search with no live body behind it.
  const pace = makeExecutionPacer(opts.combatGate === false ? {} : { bot, source: 'locomotion' });

  // `blacklist` DELETES cells from the graph — a hard rule a caller will not cross whatever the price.
  // Combat's retreat is the only user: a cell toward the threat must never be routed through.
  const blacklist = opts.blacklist || null;

  // Read once per search, not per node — the answer cannot change mid-search.
  const depthFloorArmed = !belowDepthFloor(start.y);

  // `movePenalties` ("x,y,z|edgeType" -> extra cost) CHARGES a cell instead of deleting it, so a finite
  // charge is a last resort, never unreachable. Keyed by the MOVE, not the cell: a failed step is a fact
  // about a move ("bridging into X failed"), not a claim about the cell (Law 23).
  const movePenalties = opts.movePenalties || null;
  // Charged once per key per search; charging once keeps the pop loop terminating.
  const penaltyCharged = movePenalties ? new Set() : null;

  // Active blueprint voxels ("x,y,z" keys), charged PROTECTED_VOXEL_DETOUR_BUDGET to dig — finite, so a
  // trapped bot can still break out.
  const protectedBlocks = opts.protectedBlocks || null;
  // SPARE BUILDS — a route no move of which may dig or cover a protected voxel: the charge becomes a refusal.
  // For a walk that has no business in any build (a herder chasing or leading an animal), where an
  // unreached goal is an answer and a cut build is a fault another fragment then trips on.
  const spareBuilds = opts.spareBuilds === true;

  // Optional (label, message) sink — keeps this module watcher-free. Null = silent.
  const trace = opts.trace || null;

  // WORLD-ALTERING EDGES ON/OFF, for a reachability criterion where no move may dig or place. Default
  // TRUE; false deletes all six dig/place edges at GENERATION time (restricted before the search, not
  // filtered after, or A* would report "unreachable" for ground reachable by a plain walk).
  const allowWorldAlteration = opts.allowWorldAlteration !== false;
  // Split DIG vs PLACE for the combat navigator: a retreat allows pillar/bridge but not digging (too
  // slow for the fuse). Each defaults to the flag above.
  const allowDig   = opts.allowDig   !== undefined ? !!opts.allowDig   : allowWorldAlteration;
  const allowPlace = opts.allowPlace !== undefined ? !!opts.allowPlace : allowWorldAlteration;
  // The two STRAIGHT-UP-AND-DOWN moves, each off on its own for a route an animal is led along: a dug
  // shaft drops the follower into a hole it cannot leave, and a pillar leaves it below. Every other dig
  // and place edge stays. Each defaults to its family's flag.
  const allowDigDown = allowDig && opts.allowDigDown !== false;
  const allowPillar  = allowPlace && opts.allowPillar !== false;
  // A fight's prices: a dug block and a placed block scaled from the navigator's own (driver's FIGHT_*_SCALE).
  const digScale = opts.digScale > 0 ? opts.digScale : 1;
  const placeScale = opts.placeScale > 0 ? opts.placeScale : 1;

  // ── CLOSED BOXES: GROUND THE ROUTE MAY NOT ENTER ────────────────────────────────────────────────────
  // `opts.closedBoxes` ([{min, max}]) is every box closed to this body: a downloaded building once its
  // trees are down, and the ground a working peer holds a claim over. Each is closed to ENTRY: a goal
  // inside one is refused before the search, and a node inside one is deleted at the pop unless the
  // route reached it without ever leaving that box — so a body standing inside when it closed walks out,
  // and the column the body starts in stays open as its stand shaft. `held` answers one bit per box.
  const MAX_CLOSED_BOXES = 30;   // one bit each in a 32-bit mask
  const boxes = (opts.closedBoxes || []).slice(0, MAX_CLOSED_BOXES);
  const inBox = (b, x, y, z) => x >= b.min.x && x <= b.max.x && y >= b.min.y && y <= b.max.y
    && z >= b.min.z && z <= b.max.z;
  let startMask = 0;
  boxes.forEach((b, i) => { if ([0, 1, 2].some(d => inBox(b, start.x, start.y + d, start.z))) startMask |= (1 << i); });
  const held = (x, y, z) => {
    let mask = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (!inBox(boxes[i], x, y, z)) continue;
      if ((startMask & (1 << i)) && x === start.x && z === start.z) continue;
      mask |= (1 << i);
    }
    return mask;
  };
  const closed = boxes.length ? (x, y, z) => held(x, y, z) !== 0 : () => false;
  const nodeHeld = (p) => held(p.x, p.y, p.z) | held(p.x, p.y + 1, p.z) | held(p.x, p.y + 2, p.z);
  const inRun = new Map([[startKey, startMask]]);
  if (boxes.length && goal && goal.type === 'position' && nodeHeld(goal.pos) !== 0) {
    if (trace) trace('pathfinding', `A* REFUSED: goal (${goal.pos.x},${goal.pos.y + 1},${goal.pos.z}) is inside a closed box.`);
    return null;
  }

  // THE SPAWN SQUARE IS NOT A TERM IN THIS SEARCH — `spawn_protection.maskWorldReads` makes every cell
  // inside it read as bedrock, so no dig/bridge/pillar edge is ever generated there.

  // WALL-CLOCK DEADLINE. maxNodes alone cannot express "plan in ~0.25s" — node cost varies with chunk
  // load. On expiry, breaks into the same partial reconstruction as an exhausted heap (Law 25).
  const deadlineAt = opts.deadlineMs > 0 ? Date.now() + opts.deadlineMs : 0;
  let timedOut = false;

  // THE GOAL IS A TYPED MESSAGE (Law 10, Law 13). An unrecognized type makes heuristic() return 0 and
  // goalReached() return undefined — a silent flood reported as no route (Law 26). Thrown, never
  // defaulted: a caller that did not say which goal it meant has a bug (Law 13).
  if (!goal || (goal.type !== 'position' && goal.type !== 'multi' && goal.type !== 'los')) {
    throw new Error(`[pathfinding] CODING VIOLATION: goal must be {type:'position'|'multi'|'los'}, got ${goal && goal.type !== undefined ? `type='${goal.type}'` : require('util').inspect(goal)}. An untyped goal silently makes the heuristic 0 and the goal test never-true, so the search reports a false 'no route'.`);
  }

  // THE LEVELS A STAIR LINE ENDS ON (STAIR LINES). 'los' stands the feet at the target's own height;
  // 'multi' offers its distinct floors, nearest first, bounded to four.
  const stairLevels = goal.type === 'position' ? [goal.pos.y]
    : goal.type === 'los' ? [Math.floor(goal.targetPos.y) - 1]
    : [...new Set(goal.positions.map(p => p.y))].sort((a, b) => Math.abs(a - start.y) - Math.abs(b - start.y)).slice(0, 4);

  // stairLine — the whole staircase from floor (x0,y0,z0), `k` steps in cardinal (dx,dz), one block over
  // and one down/up per step. Returns { cost, steps:[Vec3 floor], protectedVoxel, flowCharge } or null
  // the moment any step cannot be taken. Down: tread solid safe ground, three cells above open/diggable.
  // Up: tread already solid full-height (dug, never built). A step with nothing to dig costs its floor.
  const stairLine = (x0, y0, z0, dx, dz, vy, k, edgeType) => {
    const steps = [];
    let cost = 0, owned = false, flow = 0;
    for (let i = 1; i <= k; i++) {
      const fx = x0 + i * dx, fy = y0 + i * vy, fz = z0 + i * dz;
      if (depthFloorArmed && belowDepthFloor(fy)) return null;
      const tread = bot.blockAt(new Vec3(fx, fy, fz));
      if (!tread || !isBlockSolid(tread) || !isFloorSafe(tread) || HAZARD_BLOCKS.has(tread.name)) return null;
      if (isLooseTread(bot, tread)) return null;
      if (vy > 0 && !isFullHeightFloor(tread)) return null;
      // The cells this step opens. Down: over the new tread. Up: the origin's ceiling, then feet and head.
      const cells = vy < 0
        ? [[fx, fy + 1, fz], [fx, fy + 2, fz], [fx, fy + 3, fz]]
        : [[fx - dx, fy + 2, fz - dz], [fx, fy + 1, fz], [fx, fy + 2, fz]];
      if (closed(fx, fy, fz)) return null;
      const dug = [];
      let stepOwned = false;
      for (const [x, y, z] of cells) {
        if (closed(x, y, z)) return null;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (isBlockPassable(b)) continue;
        const diggable = vy < 0
          ? (isBlockSolid(b) && b.diggable && !HAZARD_BLOCKS.has(b.name))
          : isCeilingDiggable(b);
        if (!diggable) return null;
        dug.push([x, y, z]);
        if ((protectedBlocks && protectedBlocks.has(`${x},${y},${z}`)) || STATION_TYPES.has(b.name)) stepOwned = true;
      }
      if (stepOwned && spareBuilds) return null;
      if (stepOwned) owned = true;
      const stepFlow = dug.length ? flowPrice(bot, dug) : 0;
      if (stepFlow === null) return null;
      if (stepFlow > flow) flow = stepFlow;
      const base = dug.length === 0 ? COST_LOW : (stepOwned ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_STAIR_STEP);
      cost += Math.max(base, stepFlow);
      if (movePenalties) cost += movePenalties.get(`${fx},${fy},${fz}|${edgeType}`) || 0;
      steps.push(new Vec3(fx, fy, fz));
    }
    return { cost, steps, protectedVoxel: owned, flowCharge: flow };
  };

  // Single frontier for every goal. A build anchor hanging in open air gets its footing built by the
  // SAME search — bridging the final gap is simply the cheapest route once no walk reaches it.
  const fScore = (g, h) => g + HEURISTIC_WEIGHT * h;

  if (trace) trace('pathfinding', `A* START: floor (${start.x},${start.y},${start.z}) → goal type=${goal.type} ${goal.type === 'los' ? `target (${goal.targetPos.x},${goal.targetPos.y},${goal.targetPos.z})` : goal.type === 'position' ? `pos (${goal.pos.x},${goal.pos.y},${goal.pos.z})` : `${goal.positions?.length || 0} candidates`} budget=${maxNodes}`);

  const parent = new Map();   // key → { parentKey, edgeType }
  const gCost = new Map();     // key → g-score
  const visited = new Set();
  // besideCurrentOverDrop per landing, once per search: a landing is a neighbour of up to four nodes.
  const lips = new Map();
  const wade = !!opts.wade, lipCharged = new Set();
  const lipAt = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (!lips.has(k)) lips.set(k, besideCurrentOverDrop(bot, x, y, z));
    return lips.get(k);
  };
  const heap = new MinHeap();
  // THE BLOCKS A ROUTE PLACES ARE COUNTED AGAINST THE BLOCKS CARRIED. A bridge or pillar edge is offered only
  // while the route to the node has placed fewer than the body carries: a route that needs more is no route
  // for this body, which would otherwise lay its last block and stand on it in open air with no move left.
  // Set at the pop, when the node's parent is final; a dig along the way is not counted as fuel gained.
  const fuel = allowPlace ? bot.inventory.items().reduce((n, i) => n + (i.count > 0 && isScaffoldBlock(i.name) ? i.count : 0), 0) : 0;
  const placedOnRoute = new Map([[startKey, 0]]);
  // A workspace handed off mid-search (memory_workspace.leave: stand-down, socket close) clears these
  // collections while the search waits at its pacer; the search ends there, unproven, on its next step.
  let abandoned = false;
  track(() => {
    abandoned = true;
    parent.clear(); gCost.clear(); visited.clear(); inRun.clear(); heap.data.length = 0;
    if (penaltyCharged) penaltyCharged.clear();
    placedOnRoute.clear();
  });

  gCost.set(startKey, 0);
  heap.push({ pos: start, key: startKey, g: 0, f: fScore(0, heuristic(start, goal)) });

  // ── THE ONE PLACE A WALK EDGE MUST BE JUMPED ────────────────────────────────────────────────────────
  // The body starts INSIDE an open-top container (a composter, a cauldron) — the rim rises over the
  // auto-step, so a plain walk stalls; the first move is re-typed 'jump_out'. Scoped to the START node
  // only: no downstream node can have a bin under its feet (isOpenTopContainer blocks routing onto one).
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

  // LOS refinement: after the first valid vantage, search LOS_REFINE_BUDGET more nodes for a closer one
  // — first hits sit at the edge of reach, one more step often halves that.
  let bestLOSKey = null;
  let bestLOSPos = null;
  let bestLOSDist = Infinity;
  let losFoundAtNode = -1;

  while (heap.size > 0 && nodesVisited < maxNodes) {
    await pace();   // cheap clock-check per node; cedes a real macrotask only at each ~1-tick slice boundary
    if (abandoned) return { path: [], target: start, cost: 0, nodesVisited, maxNodes, partial: true, residual: bestPartialH, timedOut, resourceLimited, abandoned, provenBound, complete: false };
    // Checked after pace(), which is where the wall clock actually advances.
    if (deadlineAt && Date.now() >= deadlineAt) { timedOut = true; break; }
    // Measured growth is a cooperative bound, sampled between nodes; a partial result is never a no-route proof.
    if (boundedMemory && nodesVisited % 128 === 0) {
      const growthBytes = memoryWorkspace.budget().growthBytes;
      if (process.memoryUsage().heapUsed - heapAtStart > growthBytes) {
        resourceLimited = true;
        if (trace) trace('pathfinding', `A* RESOURCE LIMIT: temporary heap growth exceeded ${growthBytes} bytes after ${nodesVisited} nodes; search incomplete.`);
        break;
      }
    }
    const current = heap.pop();
    if (visited.has(current.key)) continue;
    // ── A STAIR LINE IS PRICED WHEN IT IS REACHED, NOT WHEN IT IS OFFERED ────────────────────────────
    // Reading a whole line costs four cells a step, ~30x an ordinary edge — too costly at every offer.
    // Pushed at its DUG price, read only when it pops; a line that cannot be dug whole is dropped.
    if (current.stairOffer) {
      const o = current.stairOffer;
      const line = stairLine(o.x0, o.y0, o.z0, o.dx, o.dz, o.vy, o.k, o.edgeType);
      if (!line) continue;
      const ng = o.g0 + line.cost;
      if (gCost.has(current.key) && gCost.get(current.key) <= ng) continue;
      gCost.set(current.key, ng);
      parent.set(current.key, { parentKey: o.fromKey, edgeType: o.edgeType, line: line.steps, protectedVoxel: line.protectedVoxel, flowCharge: line.flowCharge });
      heap.push({ pos: current.pos, key: current.key, g: ng, f: fScore(ng, heuristic(current.pos, goal)) });
      continue;
    }
    if (blacklist && blacklist.has(current.key)) { visited.add(current.key); continue; }
    // THE CLOSED BOXES (see their note above): inside one only on a route that has not left it since the start.
    if (boxes.length && current.key !== startKey) {
      const inside = nodeHeld(current.pos);
      if (inside !== 0) {
        const from = parent.get(current.key);
        const stayed = from ? (inRun.get(from.parentKey) || 0) : 0;
        if ((inside & ~stayed) !== 0) { visited.add(current.key); continue; }
        inRun.set(current.key, inside & stayed);
      }
    }
    // THE DEPTH FLOOR (architect_config WORLD_DEPTH_FLOOR_Y) deletes every cell below it from the graph
    // at the pop, a hard rule like `blacklist`. Suspended when the body starts below the floor, so a bot
    // that fell into the layer can still route back out — the floor bars descent, not return.
    if (depthFloorArmed && belowDepthFloor(current.pos.y)) { visited.add(current.key); continue; }
    // TEMPORARY (RUNNING_WATER_ENTERED): no route stands beside a current that runs to a drop, whatever edge reached the
    // stand (walk, climb, pillar, dug stair, bridge alike). Deleted at the pop, as the depth floor is. The start is exempt,
    // and so is a node already in running water: a body there routes out.
    // A search that WADES (opts.wade), the caller's last resort, prices a dry lip instead: a lip is where a body STOOD
    // and was taken; crossed in one step on dry ground it is not in the water, which pushes only a body in it. Paid once
    // (RUNNING_WATER_DETOUR_BUDGET, the re-push the move penalties use below), never a route's end (partial or goal).
    // A lip in the water, a current that runs to a drop, is deleted in every search but a body's own way out of it.
    let lipCrossed = false;
    if (!RUNNING_WATER_ENTERED && current.key !== startKey) {
      const { x: lx, y: ly, z: lz } = current.pos;
      if (lipAt(lx, ly, lz)) {
        const wet = inRunningWater(bot, lx, ly, lz, bodyWater(bot, lx, ly + 1, lz));
        if (wade ? wet : !wet) { visited.add(current.key); continue; }
        if (wade) {
          lipCrossed = true;
          if (!lipCharged.has(current.key)) {
            lipCharged.add(current.key);
            const pg = current.g + RUNNING_WATER_DETOUR_BUDGET;
            gCost.set(current.key, pg);
            heap.push({ pos: current.pos, key: current.key, g: pg, f: fScore(pg, heuristic(current.pos, goal)) });
            continue;
          }
        }
      }
    }
    // min_y floor: reject nodes whose feet would sink below the caller's working height.
    if (goal.min_y != null && current.pos.y < goal.min_y - 1) { visited.add(current.key); continue; }
    // max_y ceiling: reject nodes whose feet would rise above the caller's working height, so a walk
    // under a structure stays under it. Open to a body that starts above it, which comes down.
    if (goal.max_y != null && start.y <= goal.max_y - 1 && current.pos.y > goal.max_y - 1) { visited.add(current.key); continue; }

    // Charged here, not at the twelve push sites: A* pops in nondecreasing f, so re-pushing with g
    // raised by P delays it exactly as paying P on entry would. Not marked visited — it comes back
    // around and is expanded again.
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
    if (current.key !== startKey) {
      const via = parent.get(current.key);
      placedOnRoute.set(current.key, (placedOnRoute.get(via.parentKey) || 0) + (via.edgeType === 'bridge' || via.edgeType === 'pillar' ? 1 : via.edgeType === 'water_step_up' ? 2 : 0));
    }
    const fuelLeft = fuel - placedOnRoute.get(current.key);
    // The proven cost frontier: every route cheaper than this is ruled out, since the heap pops in
    // nondecreasing f and the heuristic is admissible at W=1.0 (sound only at that weight).
    provenBound = current.f;

    const h = heuristic(current.pos, goal);
    // The partial is a route the body walks and stops on, so it answers to the same station rule as the
    // goal. Skipped WITHOUT lowering bestPartialH, or the station would lock out every cell behind it.
    if (h < bestPartialH && !lipCrossed && !endsOnStation(bot, current.pos, null)) {
      if (trace && (bestPartialKey === startKey || h < bestPartialH - 1)) trace('pathfinding', `A* progress: node#${nodesVisited} (${current.pos.x},${current.pos.y + 1},${current.pos.z}) h=${h.toFixed(1)} (was ${bestPartialH.toFixed(1)})`);
      bestPartialH = h;
      bestPartialKey = current.key;
      bestPartialPos = current.pos;
    }

    // Trace only near the goal (within 6 blocks) to keep the log readable; opts.traceAll traces every node, for a
    // search too small to flood the log (the navigator's post-mortem of a body walled in).
    const nearGoal = h < 6 || !!opts.traceAll;
    if (!lipCrossed && goalReached(bot, current.pos, goal, nearGoal ? trace : null)) {
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

    // --- Edge generation: check all movement types at this node ---

    // From a water node, outgoing walk/climb edges are re-typed 'swim' so the executor uses
    // swimStep (no digging, correct underwater Y model).
    const curNodeBlock = bot.blockAt(new Vec3(cx, cy, cz));
    // A NODE A PILLAR REACHED STANDS ON THE BLOCK THE PILLAR PLACED, whatever the world holds there now: the bob-pillar
    // sets its block in the water cell, so the body stands dry on it and pillars on up from it like any dry pillar.
    // Read off the world, that floor is still water, and a body in a cave pool under an open shaft reads afloat at the
    // surface, where neither pillar applies (dry wants a dry floor, bob wants water in the cell above).
    const fromWater = isWaterBlock(curNodeBlock) && parent.get(current.key)?.edgeType !== 'pillar';
    // A body on a solid floor with water over both its feet and its head cell is afloat to dig_authority
    // (bobbing), which makes no dig there. No dig edge leaves such a node; it walks or swims out.
    const submerged = !fromWater && isWaterBlock(bot.blockAt(new Vec3(cx, cy + 1, cz))) && isWaterBlock(bot.blockAt(new Vec3(cx, cy + 2, cz)));
    // The water this node's body stands in, and what a dig from here costs over a dry one (WATER_DIG_*).
    const ownWater = bodyWater(bot, cx, cy + 1, cz);
    const wetDig = fromWater ? WATER_DIG_AFLOAT : ownWater.size ? WATER_DIG_STANDING : 1;
    // TEMPORARY (RUNNING_WATER_ENTERED): a node already in running water may go anywhere; any other enters none, except
    // in a search that wades (opts.wade), the caller's last resort, where it enters at RUNNING_WATER_DETOUR_BUDGET.
    const mayEnterRunning = RUNNING_WATER_ENTERED || wade || inRunningWater(bot, cx, cy, cz, ownWater);

    // ── THE BODY MUST BE ABLE TO JUMP FROM WHERE IT IS, NOT ONLY LAND WHERE IT IS GOING ──────────────
    // A +1 step needs a free cell above the head at the ORIGIN (cy+3), not only clearance at the
    // destination — read via the `jumpable`/`walkable` distinction from classifyFloorInline (Law 16).
    const originJumpable = isBlockPassable(bot.blockAt(new Vec3(cx, cy + 3, cz)));

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
      // --- Walk edge (same Y) ---
      const walkFloorPos = new Vec3(nx, cy, nz);
      const walkFloor = bot.blockAt(walkFloorPos);
      const lip = !mayEnterRunning && lipAt(nx, cy, nz);
      const walkClass = !lip && classifyFloorInline(bot, walkFloor);
      if (walkClass) {
        const wk = keyOf(walkFloorPos);
        if (!visited.has(wk)) {
          const ng = currentG + (fromWater ? COST_WATER_EXIT : COST_LOW);
          if (!gCost.has(wk) || ng < gCost.get(wk)) {
            gCost.set(wk, ng);
            parent.set(wk, { parentKey: current.key, edgeType: fromWater ? 'water_exit' : (startInsideBin && current.key === startKey ? 'jump_out' : 'walk') });
            heap.push({ pos: walkFloorPos, key: wk, g: ng, f: fScore(ng, heuristic(walkFloorPos, goal)) });
          }
        }
      } else if (!lip && mayEnterRunning && !fromWater && wadeable(bot, walkFloor)) {
        // --- Wade edge (same Y): onto a floor with running water in its feet cell and a dry head ---
        // A body walks through running water ankle- or knee-deep, carried a little by it, so it is a move;
        // priced RUNNING_WATER_DETOUR_BUDGET so a route wades only when no dry or still way serves. A body
        // already standing in it leaves by the ordinary walk edges, which cost nothing extra.
        const wk = keyOf(walkFloorPos);
        if (!visited.has(wk)) {
          const ng = currentG + COST_LOW + RUNNING_WATER_DETOUR_BUDGET;
          if (!gCost.has(wk) || ng < gCost.get(wk)) {
            gCost.set(wk, ng);
            parent.set(wk, { parentKey: current.key, edgeType: 'wade' });
            heap.push({ pos: walkFloorPos, key: wk, g: ng, f: fScore(ng, heuristic(walkFloorPos, goal)) });
          }
        }
      }

      // --- Stair up edge (+1Y) ---
      // isFullHeightFloor rejects partial-height blocks (chests, slabs) — see its note.
      const upFloorPos = new Vec3(nx, cy + 1, nz);
      const upFloor = bot.blockAt(upFloorPos);
      // The lip test holds on every landing, a step up or down as much as a walk.
      const upClass = !(!mayEnterRunning && lipAt(nx, cy + 1, nz)) && classifyFloorInline(bot, upFloor);
      // originJumpable is the third term and the one that was missing — see its note above.
      // FROM WATER THERE IS NO STEP UP. A water node's `pos` is the surface cell the body floats IN, so a
      // floor one above it is a block and a half over the body's feet. That bank is left by
      // water_bank_out, below, which makes a bank level with the water first.
      if (upClass && isFullHeightFloor(upFloor) && originJumpable && !fromWater) {
        const uk = keyOf(upFloorPos);
        if (!visited.has(uk)) {
          const ng = currentG + COST_CLIMB_UP;
          if (!gCost.has(uk) || ng < gCost.get(uk)) {
            gCost.set(uk, ng);
            parent.set(uk, { parentKey: current.key, edgeType: 'climb_up' });
            heap.push({ pos: upFloorPos, key: uk, g: ng, f: fScore(ng, heuristic(upFloorPos, goal)) });
          }
        }
      }
      // --- water_bank_out: WATER TO LAND BY PLACING, where the bank stands one block over the water ---
      // The neighbour (nx,cy,nz) is the surface water cell beside the body. A block placed IN it, against
      // the bank block that stands level with the water, is a bank level with the water: the body leaves the
      // water onto it as water_exit does, and from there the bank's top is one ordinary step up. The edge
      // lands on that top, so it is one move with one destination. Offered from the surface cell only.
      if (fromWater && allowPlace && !isWaterBlock(bot.blockAt(new Vec3(cx, cy + 1, cz)))
        && isStillWater(bot, nx, cy, nz)
        && isBlockPassable(bot.blockAt(new Vec3(nx, cy + 1, nz))) && !isWaterBlock(bot.blockAt(new Vec3(nx, cy + 1, nz)))
        && isBlockPassable(bot.blockAt(new Vec3(nx, cy + 2, nz))) && isBlockPassable(bot.blockAt(new Vec3(nx, cy + 3, nz)))) {
        for (const [ex, , ez] of CARDINAL) {
          const bx = nx + ex, bz = nz + ez;
          if (bx === cx && bz === cz) continue;
          const bankSide = bot.blockAt(new Vec3(bx, cy, bz));          // the block the placed one is set against
          const bankTop = bot.blockAt(new Vec3(bx, cy + 1, bz));       // the floor the move ends on
          if (!isBlockSolid(bankSide) || HAZARD_BLOCKS.has(bankSide.name)) continue;
          if (!classifyFloorInline(bot, bankTop) || !isFullHeightFloor(bankTop)) continue;
          const topPos = new Vec3(bx, cy + 1, bz);
          const tk = keyOf(topPos);
          if (visited.has(tk)) continue;
          if (!bot.inventory.items().some(i => i.count > 0 && isScaffoldBlock(i.name))) break;
          const ng = currentG + COST_PLACE + COST_WATER_EXIT + COST_LOW;
          if (!gCost.has(tk) || ng < gCost.get(tk)) {
            gCost.set(tk, ng);
            parent.set(tk, { parentKey: current.key, edgeType: 'water_bank_out' });
            heap.push({ pos: topPos, key: tk, g: ng, f: fScore(ng, heuristic(topPos, goal)) });
          }
        }
      }

      // --- water_step_up: OUT OF SHALLOW WATER BY PLACING, where no bank stands to climb ---
      // A body afloat in water rises too little to set a block in its own cell, so the block goes in the shallow
      // water cell beside it: solid ground under that cell, the body climbs onto the block, and pillars once from it.
      // The move lands a block over the water, a cell no swim reaches, so it is one move with one destination.
      if (fromWater && allowPlace && allowPillar && fuelLeft >= 2 && !isWaterBlock(bot.blockAt(new Vec3(cx, cy + 1, cz)))
        && isWaterBlock(bot.blockAt(new Vec3(nx, cy, nz)))) {
        const under = bot.blockAt(new Vec3(nx, cy - 1, nz));
        const s1 = bot.blockAt(new Vec3(nx, cy + 1, nz));
        const s2 = bot.blockAt(new Vec3(nx, cy + 2, nz));
        const s3 = bot.blockAt(new Vec3(nx, cy + 3, nz));
        const upPos = new Vec3(nx, cy + 1, nz);
        const uk = keyOf(upPos);
        if (isBlockSolid(under) && !HAZARD_BLOCKS.has(under.name)
          && isBlockPassable(s1) && !isWaterBlock(s1) && isBlockPassable(s2) && !isWaterBlock(s2)
          && (isBlockPassable(s3) || isCeilingDiggable(s3)) && !visited.has(uk)) {
          const ng = currentG + 2 * COST_PLACE + COST_WATER_EXIT;
          if (!gCost.has(uk) || ng < gCost.get(uk)) {
            gCost.set(uk, ng);
            parent.set(uk, { parentKey: current.key, edgeType: 'water_step_up' });
            heap.push({ pos: upPos, key: uk, g: ng, f: fScore(ng, heuristic(upPos, goal)) });
          }
        }
      }

      // --- Stair down edge (-1Y) ---
      const downFloorPos = new Vec3(nx, cy - 1, nz);
      const downFloor = bot.blockAt(downFloorPos);
      const downClass = !(!mayEnterRunning && lipAt(nx, cy - 1, nz)) && classifyFloorInline(bot, downFloor);
      // The body crosses into the lower column at the height it stands, so its head passes through the
      // cell over the landing's own head (nx, cy+2). 'jumpable' says that cell is open and the step is a
      // walk. Where it holds a block the walker opens it, so the search reads it as every dug cell is
      // read: closed ground is no edge, a protected voxel is charged, and the step is a dug stair step.
      if (downClass) {
        const dk = keyOf(downFloorPos);
        const headDug = downClass !== 'jumpable' && !fromWater;
        const over = headDug ? bot.blockAt(new Vec3(nx, cy + 2, nz)) : null;
        const headFlow = headDug ? flowPrice(bot, [[nx, cy + 2, nz]], ownWater) : 0;
        const offered = !(headDug && isLooseTread(bot, downFloor)) && (!headDug || allowDig && !closed(nx, cy + 2, nz) && headFlow !== null
          && isBlockSolid(over) && over.diggable && !HAZARD_BLOCKS.has(over.name));
        if (offered && !visited.has(dk)) {
          const headOwned = headDug && ((protectedBlocks && protectedBlocks.has(`${nx},${cy + 2},${nz}`)) || STATION_TYPES.has(over.name));
          const ng = currentG + (headDug ? Math.max(headOwned ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_STAIR_STEP * wetDig * digScale, headFlow) : (fromWater ? COST_LOW : COST_CLIMB_DOWN));
          if (!(headOwned && spareBuilds) && (!gCost.has(dk) || ng < gCost.get(dk))) {
            gCost.set(dk, ng);
            parent.set(dk, headDug
              ? { parentKey: current.key, edgeType: 'dig_stair_down', protectedVoxel: !!headOwned, flowCharge: headFlow }
              : { parentKey: current.key, edgeType: fromWater ? 'swim' : 'climb_down' });
            heap.push({ pos: downFloorPos, key: dk, g: ng, f: fScore(ng, heuristic(downFloorPos, goal)) });
          }
        }
      } else if (mayEnterRunning && !fromWater && wadeable(bot, downFloor) && isBlockPassable(bot.blockAt(new Vec3(nx, cy + 2, nz)))) {
        // --- Wade down (-1Y): a step down into running water, the head passing the open cell over the landing ---
        // Priced as the level wade is; walked as a stair step down.
        const dk = keyOf(downFloorPos);
        if (!visited.has(dk)) {
          const ng = currentG + COST_LOW + RUNNING_WATER_DETOUR_BUDGET;
          if (!gCost.has(dk) || ng < gCost.get(dk)) {
            gCost.set(dk, ng);
            parent.set(dk, { parentKey: current.key, edgeType: 'wade_down' });
            heap.push({ pos: downFloorPos, key: dk, g: ng, f: fScore(ng, heuristic(downFloorPos, goal)) });
          }
        }
      }

      // --- Dug stair LINES (STAIR LINES in the header) — one whole section to a level the goal stands on ---
      // The offer carries the optimistic price; the line is priced again, and read, when it pops (below).
      if (allowDig && !fromWater && !submerged) {
        for (const level of stairLevels) {
          const rise = level - cy;
          const k = Math.abs(rise);
          if (k === 0 || k > MAX_STAIR_RUN) continue;
          const vy = rise > 0 ? 1 : -1;
          const landing = new Vec3(cx + k * dx, level, cz + k * dz);
          const lk = keyOf(landing);
          if (visited.has(lk)) continue;
          const g0 = currentG;
          // Offered at the DUG price; a partly-open line reads cheaper when it pops and re-enters at that
          // lower cost. Pricing the offer at COST_LOW instead would pop nearly every offer on the flood.
          const ng = g0 + k * COST_STAIR_STEP;
          if (gCost.has(lk) && gCost.get(lk) <= ng) continue;
          heap.push({ pos: landing, key: lk, g: ng, f: fScore(ng, heuristic(landing, goal)),
            stairOffer: { x0: cx, y0: cy, z0: cz, dx, dz, vy, k, g0, fromKey: current.key, edgeType: vy > 0 ? 'dig_stair_up' : 'dig_stair_down' } });
        }
      }

      // Edge summary for the first 3 expansions so traces show why A* can/can't move.
      if (trace && nodesVisited <= 3) {
        const edges = [];
        if (walkClass) edges.push(`walk(${walkClass})`);
        // Printed with the reason it was refused, because "no climb_up" and "no climb_up because the
        // ceiling is 1 block too low" are the same line to a reader and different faults (Law 25).
        if (upClass) edges.push(originJumpable ? 'climb_up' : 'climb_up:BLOCKED(origin not jumpable)');
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
      // A straight drop off a ledge is never planned (irreversible, no return without pillaring). A
      // ledge is descended by climb_down, one straight dig_stair_down, or a vertical dig_down instead.

      // --- Door edge (same Y, through a closed wooden door) ---
      // Doors have a solid bbox so walk edges skip them. Destination is the floor past the door, so the
      // bot never halts inside it. COST_LOW keeps A* opening doors over digging around them.
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

      // --- Airlock edge (same Y, through an iron door worked by its button) ---
      // One edge across door, chamber and gate. Priced per cell walked, and above a wooden door for the work.
      if (!fromWater) {
        const lockFoot = bot.blockAt(new Vec3(nx, cy + 1, nz));
        if (lockFoot && (lockFoot.name === 'iron_door' || isFenceGate(lockFoot) || lockFoot.name.endsWith('_carpet'))) {
          const lock = readAirlock(bot, cx, cy, cz, dx, dz);
          if (lock && classifyFloorInline(bot, bot.blockAt(lock.far))) {
            const lockKey = keyOf(lock.far);
            if (!visited.has(lockKey)) {
              const ng = currentG + COST_LOW * (Math.abs(lock.far.x - cx) + Math.abs(lock.far.z - cz) + 2);
              if (!gCost.has(lockKey) || ng < gCost.get(lockKey)) {
                gCost.set(lockKey, ng);
                parent.set(lockKey, { parentKey: current.key, edgeType: 'airlock' });
                heap.push({ pos: lock.far, key: lockKey, g: ng, f: fScore(ng, heuristic(lock.far, goal)) });
              }
            }
          }
        }
      }

      // --- Dig-through edge (same Y, through a wall) ---
      // Neighbor has a standable floor (support after digging) + diggable foot/head: dig one column,
      // step in. A* chains these across thick walls. From water, priced by wetDig.
      if (allowDig && !walkClass && !upClass) {
        const dtFloor = bot.blockAt(new Vec3(nx, cy, nz));
        const dtFoot  = bot.blockAt(new Vec3(nx, cy + 1, nz));
        const dtHead  = bot.blockAt(new Vec3(nx, cy + 2, nz));
        if (isBlockSolid(dtFloor) && isFloorSafe(dtFloor) && !HAZARD_BLOCKS.has(dtFloor.name)
            && dtFoot && isBlockSolid(dtFoot) && dtFoot.diggable && dtFoot.name !== 'iron_door' && !isFenceGate(dtFoot)
            && dtHead && (isBlockPassable(dtHead) || (isBlockSolid(dtHead) && dtHead.diggable))) {
          const dtPos = new Vec3(nx, cy, nz);
          const dtk = keyOf(dtPos);
          const dtFlow = flowPrice(bot, (isBlockSolid(dtHead) && dtHead.diggable) ? [[nx, cy + 1, nz], [nx, cy + 2, nz]] : [[nx, cy + 1, nz]], ownWater);
          if (!visited.has(dtk) && dtFlow !== null) {
            const headDug = isBlockSolid(dtHead) && dtHead.diggable;
            const footOwned = (protectedBlocks && protectedBlocks.has(`${nx},${cy + 1},${nz}`)) || STATION_TYPES.has(dtFoot.name);
            const headOwned = headDug && (((protectedBlocks && protectedBlocks.has(`${nx},${cy + 2},${nz}`))) || STATION_TYPES.has(dtHead.name));
            const ng = currentG + Math.max((footOwned || headOwned) ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_HIGH * wetDig * digScale, dtFlow);
            if (!((footOwned || headOwned) && spareBuilds) && (!gCost.has(dtk) || ng < gCost.get(dtk))) {
              gCost.set(dtk, ng);
              parent.set(dtk, { parentKey: current.key, edgeType: 'dig_through', protectedVoxel: !!(footOwned || headOwned), flowCharge: dtFlow });
              heap.push({ pos: dtPos, key: dtk, g: ng, f: fScore(ng, heuristic(dtPos, goal)) });
            }
          }
        }
      }

      // --- Bridge edge (same Y, floor not solid) ---
      // Complement of dig_through: place a block over a non-solid gap (air, lava) to make a floor.
      // Water excluded (the bot swims it instead) and blocked from water nodes. A* chains gaps.
      if (allowPlace && !walkClass && !fromWater) {
        const brFloor = bot.blockAt(new Vec3(nx, cy, nz));
        if (brFloor && !isBlockSolid(brFloor) && !isWaterBlock(brFloor)) {
          const hasBlocks = fuelLeft > 0;
          if (hasBlocks) {
            const brPos = new Vec3(nx, cy, nz);
            const brk = keyOf(brPos);
            if (!visited.has(brk)) {
              const ng = currentG + COST_PLACE * placeScale; // place a block over the gap
              if (!gCost.has(brk) || ng < gCost.get(brk)) {
                gCost.set(brk, ng);
                parent.set(brk, { parentKey: current.key, edgeType: 'bridge' });
                heap.push({ pos: brPos, key: brk, g: ng, f: fScore(ng, heuristic(brPos, goal)) });
              }
              if (trace && nearGoal) trace('pathfinding', `  BRIDGE (${cx},${cy},${cz})→(${nx},${cy},${nz}) over ${brFloor.name} cost +${COST_PLACE}`);
            }
          } else if (trace && nearGoal) {
            trace('pathfinding', `  bridge SKIP (${cx},${cy},${cz})→(${nx},${cy},${nz}): no construction block left on this route (${fuel} carried)`);
          }
        }
      }

      // --- Swim edge (horizontal water entry / traversal) ---
      // Enter adjacent water at cy/cy±1, or continue water→water. Water→land is water_exit and
      // water_bank_out, above. No fall-into-water edge either —
      // a ledge is descended by stair/dig_down, never a drop. Still water is swum at COST_HIGH: the entered
      // cell and the surface cell both sources (isStillWater). Running water is swum too, so a body in it
      // has a way through and out, priced RUNNING_WATER_DETOUR_BUDGET more: a route takes it only when no
      // still water or dry ground serves.
      {
        for (const checkY of [cy, cy + 1, cy - 1]) {
          const checkBlock = bot.blockAt(new Vec3(nx, checkY, nz));
          if (isWaterBlock(checkBlock)) {
            const surfY = findWaterSurface(bot, nx, checkY, nz);
            if (surfY !== null) {
              const still = isStillWater(bot, nx, checkY, nz) && isStillWater(bot, nx, surfY, nz);
              const swimPos = new Vec3(nx, surfY, nz);
              const sk = keyOf(swimPos);
              if (!visited.has(sk) && (still || mayEnterRunning)) {
                const ng = currentG + COST_HIGH + (still ? 0 : RUNNING_WATER_DETOUR_BUDGET); // swim
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
    // Dig the floor, drop onto the block below (solid, standable), priced by flowPrice() like every
    // other dig; a floor that opens onto water is no edge. A body standing on a leaf comes down through
    // the canopy by this edge: from a leaf floor the landing may be a leaf too.
    // A body standing in water digs down at wetDig; a body afloat has no floor of its own to dig.
    if (allowDigDown && !fromWater) {
      const curFloorBlock = bot.blockAt(new Vec3(cx, cy, cz));
      const belowBlock = bot.blockAt(new Vec3(cx, cy - 1, cz));
      if (curFloorBlock && curFloorBlock.diggable
          && belowBlock && isBlockSolid(belowBlock) && !HAZARD_BLOCKS.has(belowBlock.name)
          && (isFloorSafe(belowBlock) || (isLeafFloor(curFloorBlock) && isLeafFloor(belowBlock)))) {
        const ddPos = new Vec3(cx, cy - 1, cz);
        const ddk = keyOf(ddPos);
        // Both the floor cell and the feet cell above it are offered to flowPrice: the bot drops
        // through the feet cell too, so liquid there pours straight down the hole.
        const ddFlow = flowPrice(bot, [[cx, cy, cz], [cx, cy + 1, cz]], ownWater);
        if (!visited.has(ddk) && ddFlow !== null) {
          const floorOwned = (protectedBlocks && protectedBlocks.has(`${cx},${cy},${cz}`)) || STATION_TYPES.has(curFloorBlock.name);
          const ng = currentG + Math.max(floorOwned ? PROTECTED_VOXEL_DETOUR_BUDGET : COST_HIGH * wetDig * digScale, ddFlow);
          if (!(floorOwned && spareBuilds) && (!gCost.has(ddk) || ng < gCost.get(ddk))) {
            gCost.set(ddk, ng);
            parent.set(ddk, { parentKey: current.key, edgeType: 'dig_down', protectedVoxel: !!floorOwned, flowCharge: ddFlow });
            heap.push({ pos: ddPos, key: ddk, g: ng, f: fScore(ng, heuristic(ddPos, goal)) });
          }
        }
      }
    }

    // --- Pillar edge (same XZ, +1Y) — the ONE straight-up move ---
    // pillarStep places a block underfoot mid-jump and rises. Charged COST_PLACE, pricier than a dug
    // stair step, so A* chimneys up only when no whole stair fits. A protected ceiling is charged
    // PROTECTED_VOXEL_DETOUR_BUDGET instead (Law 16). DRY pillar: solid-floored node, place cell
    // passable. WATER bob-pillar: place cell floods, a solid floor within BLOCK_REACH below — bobs and
    // fills the column down, then stands out.
    if (allowPillar) {
      const pillarDest = new Vec3(cx, cy + 1, cz);
      const pk = keyOf(pillarDest);
      if (!visited.has(pk)) {
        const p1 = bot.blockAt(new Vec3(cx, cy + 1, cz));   // feet / place cell
        const p2 = bot.blockAt(new Vec3(cx, cy + 2, cz));   // head cell
        const p3 = bot.blockAt(new Vec3(cx, cy + 3, cz));   // ceiling / jump-peak
        const shaftOk = (b) => isBlockPassable(b) || isCeilingDiggable(b);
        const overWater = isWaterBlock(p1) && isStillWater(bot, cx, cy + 1, cz);
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
        const hasBlocks = fuelLeft > 0;
        const pDug = [];
        if (isBlockSolid(p1)) pDug.push([cx, cy + 1, cz]);
        if (isBlockSolid(p2)) pDug.push([cx, cy + 2, cz]);
        if (isBlockSolid(p3)) pDug.push([cx, cy + 3, cz]);
        const pFlow = flowPrice(bot, pDug);
        if (clear && hasBlocks && pFlow !== null) {
          const ceilingOwned = protectedBlocks && (protectedBlocks.has(`${cx},${cy + 2},${cz}`) || protectedBlocks.has(`${cx},${cy + 3},${cz}`));
          // Water-pillar carries a bob surcharge (COST_PLACE + COST_HIGH) over a dry pillar, reserved for
          // getting out where nothing dry reaches. pillarUpStep BREAKS the shaft as it rises, so it is a
          // dig edge too and carries the same flow price; the bob-pillar's own water (p1) is not charged.
          const pillarCost = Math.max(ceilingOwned ? PROTECTED_VOXEL_DETOUR_BUDGET : (overWater ? COST_PLACE + COST_HIGH : COST_PLACE * placeScale), pFlow);
          const ng = currentG + pillarCost;
          if (!(ceilingOwned && spareBuilds) && (!gCost.has(pk) || ng < gCost.get(pk))) {
            gCost.set(pk, ng);
            parent.set(pk, { parentKey: current.key, edgeType: 'pillar', protectedVoxel: !!ceilingOwned, flowCharge: pFlow });
            heap.push({ pos: pillarDest, key: pk, g: ng, f: fScore(ng, heuristic(pillarDest, goal)) });
          }
          if (trace && nearGoal) trace('pathfinding', `  PILLAR${overWater ? ' (water/bob)' : ''} (${cx},${cy},${cz})→+1Y cost +${ceilingOwned ? PROTECTED_VOXEL_DETOUR_BUDGET + ' (protected ceiling)' : pillarCost}`);
        } else if (trace && nearGoal) {
          // The "why didn't it pillar" answer: which gate deleted the straight-up edge.
          trace('pathfinding', `  pillar SKIP (${cx},${cy},${cz}): ${!hasBlocks ? `no construction block left on this route (${fuel} carried; bridge edge off too)` : (overWater && !waterFloorInReach) ? `water: no solid floor within reach (${Math.max(1, Math.floor(BLOCK_REACH))}) below` : pFlow === null && clear ? `a dug cell opens onto water (${pDug.map(c => c.join(',')).join(' ')})` : `shaft blocked p1=${p1 && p1.name} p2=${p2 && p2.name} p3=${p3 && p3.name}`}`);
        }
      }
    }
  }

  // Loop ended with a valid vantage recorded but the refine-break never fired — use it.
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
    if (resourceLimited) return { path: [], target: start, cost: 0, nodesVisited, maxNodes, partial: true, residual: bestPartialH, timedOut, resourceLimited, provenBound, complete: false };
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

  // `flowCharge` rides the step as a NUMBER (0, FLOW_DETOUR_BUDGET or LAVA_FLOW_DETOUR_BUDGET) so a
  // reader learns which liquid the route commits to opening without re-reading a changed world.
  // `protectedVoxel` rides the step because cutting the build is a decision the caller must hear about,
  // announced only where a charged edge survives into the route, never at every charge site (Law 16).
  // A stair line is one edge to the search and k steps to the walker, unrolled here into one
  // path entry per step so a failed step is charged to its own cell.
  const path = [];
  let cur = endKey;
  while (cur && cur !== startKey) {
    const entry = parent.get(cur);
    if (!entry) break;
    const [px, py, pz] = cur.split(',').map(Number);
    const cells = entry.line || [new Vec3(px, py, pz)];
    for (let j = cells.length - 1; j >= 0; j--) {
      path.push({ key: keyOf(cells[j]), pos: cells[j], edgeType: entry.edgeType, protectedVoxel: !!entry.protectedVoxel, flowCharge: entry.flowCharge || 0 });
    }
    cur = entry.parentKey;
  }
  if (cur !== startKey) return null;
  path.reverse();

  // Residual: endpoint's remaining distance to goal; the caller judges if a partial is acceptable.
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
    resourceLimited,
    // `complete` true means the frontier ran dry (a proven "no route"); false means a budget or clock
    // stopped it, and `provenBound` is the honest claim: nothing cheaper than this exists (Law 25).
    provenBound,
    complete: !timedOut && !resourceLimited && nodesVisited < maxNodes,
  };
}

module.exports = {
  keyOf, straightLine,
  COST_LOW, COST_HIGH, COST_PLACE, COST_STAIR_STEP, PROTECTED_VOXEL_DETOUR_BUDGET,
  DOOR_BLOCKS, isDoorBlock, readAirlock, airlockButton,
  MIN_PLACEMENT_DIST,
  LAVA_FLOW_DETOUR_BUDGET, opensOntoWater, bodyWater,
  computeAStar, drainSearchCensus, pathStillWalkable, MinHeap,
  isScaffoldBlock,   // exported so the navigator's give-up post-mortem counts pillar/bridge fuel from the one definition (Law 16)
  // EXPORT-ONLY, no behaviour change. tools/voxel_classifier_prototype derives its per-state-id table
  // by CALLING these, never by copying PASSABLE_BLOCKS/HAZARD_BLOCKS into a second list (Law 16).
  isBlockPassable, isBlockSolid, isFullHeightFloor, isLeafFloor,
  // classifyFloorInline is the single definition of a standable dry cell. Exported so the water-escape
  // gate reuses it, never re-deriving shore detection (Law 16).
  classifyFloorInline,
  // TEMPORARY with RUNNING_WATER_ENTERED: the lip test, so the current reflex (underwater_swimming) takes a body standing
  // in a current that pours over a drop by the same definition the search refuses that landing by (Law 16).
  besideCurrentOverDrop,
};
