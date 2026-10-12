// module: movement/terrain_predicates — the one answer to "may the body be here".
// Walkability, hazards, clearance, floor type, sightline, and the arithmetic helpers under them. A
// leaf: reads the world, returns a verdict. The bottom of this folder's DAG (Law 16) — other movement
// modules price terrain off these same predicates, never a second copy.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { WORLD_DEPTH_FLOOR_Y } = require('@thinking/architect_config');
const { STATION_TYPES } = require('@utils/fragment_utils');

// ── THE DEPTH FLOOR (one predicate, Law 16) ─────────────────────────────────────────────────────
// The constant lives in architect_config; the question lives here, so the route search, dig authority
// and drop sweep agree on which cells exist. Takes a bare Y so a caller can ask before fetching a block.
function belowDepthFloor(y) {
  return WORLD_DEPTH_FLOOR_Y !== null && Math.floor(y) < WORLD_DEPTH_FLOOR_Y;
}

// ── SECTION 2: Terrain Predicates ──
// Single source of truth for walkability, hazards, clearance and floor type (Law 16).

// Module scope so isWalkableSurface never rebuilds this set per call.
const NON_STANDABLE_SURFACES = new Set([
  'air','cave_air','void_air',
  'water','flowing_water','lava','flowing_lava','bubble_column',
  'nether_portal','end_portal','end_gateway',
  'fire','soul_fire','campfire','soul_campfire',
  'cactus','sweet_berry_bush','magma_block',
  'cobweb','powder_snow',
]);

// ── OPEN-TOPPED CONTAINERS ARE NOT FLOORS ────────────────────────────────────────────────────────────
// A composter or cauldron reports as solid, but is a BIN: an interior floor walled by an open top too
// tall to auto-step over. Derived from the block's own collision shapes, not a name list, so it covers
// any block of this shape without upkeep. Measures the CENTRE column — what the feet land on — not the
// rim isFullHeightFloor uses, which is why that predicate passes a composter and this one does not.
const STEP_HEIGHT = 0.6;   // vanilla auto-step; above this the body must jump

// Memoised per state (see isOpenTopContainer), since isWalkableSurface asks this on every candidate cell.
const _binByState = new Map();

// `centre` is the highest collision under the body's middle — where it rests; `rim` is the highest
// collision anywhere in the cell — what it must clear to leave. A bin supports low and walls high.
//
// centre > 0 excludes doors and trapdoors: a door's slab leaves an empty centre column, which would
// otherwise read as a bottomless bin instead of the wall it is.
function _binFromShapes(shapes) {
  if (!Array.isArray(shapes) || shapes.length === 0) return false;
  let rim = 0;
  let centre = 0;
  for (const s of shapes) {
    if (s[4] > rim) rim = s[4];
    // Does this piece sit under the body's middle? (x0 ≤ 0.5 ≤ x1 and z0 ≤ 0.5 ≤ z1)
    if (s[0] <= 0.5 && s[3] >= 0.5 && s[2] <= 0.5 && s[5] >= 0.5 && s[4] > centre) centre = s[4];
  }
  return centre > 0 && (rim - centre) > STEP_HEIGHT;
}

// Keyed on the state id, not the block type: collision geometry is a per-state property (snow by
// layer count, a trapdoor by open/closed), so a type-keyed memo could let one state answer for others.
function isOpenTopContainer(block) {
  const key = block.stateId !== undefined ? block.stateId : block.type;
  const hit = _binByState.get(key);
  if (hit !== undefined) return hit;
  const verdict = _binFromShapes(block.shapes);
  _binByState.set(key, verdict);
  return verdict;
}

// Asserts the rule against known shapes at load time — the check lives here, not as a second list in
// NON_STANDABLE_SURFACES (Law 16). Shapes are copied from prismarine-registry, not hand-drawn.
// oak_door and hopper are the two near-misses a plausible simplification of the rule gets wrong.
for (const [name, shapes, mustBeBin] of [
  // interior floor 0.125, four walls to y=1.0 → a 0.875 step out
  ['composter', [[0, 0, 0, 1, 0.125, 1], [0, 0.125, 0, 0.125, 1, 1], [0.125, 0.125, 0, 1, 1, 0.125],
    [0.125, 0.125, 0.875, 1, 1, 1], [0.875, 0.125, 0.125, 1, 1, 0.875]], true],
  // interior floor 0.25 → a 0.75 step out, over the auto-step
  ['cauldron', [[0, 0, 0, 0.125, 1, 0.25], [0, 0, 0.75, 0.125, 1, 1], [0.125, 0, 0, 0.25, 1, 0.125],
    [0.125, 0, 0.875, 0.25, 1, 1], [0.75, 0, 0, 1, 1, 0.125], [0.75, 0, 0.875, 1, 1, 1],
    [0.875, 0, 0.125, 1, 1, 0.25], [0.875, 0, 0.75, 1, 1, 0.875], [0, 0.1875, 0.25, 1, 0.25, 0.75],
    [0.125, 0.1875, 0.125, 0.875, 0.25, 0.25], [0.125, 0.1875, 0.75, 0.875, 0.25, 0.875],
    [0.25, 0.1875, 0, 0.75, 1, 0.125], [0.25, 0.1875, 0.875, 0.75, 1, 1],
    [0, 0.25, 0.25, 0.125, 1, 0.75], [0.875, 0.25, 0.25, 1, 1, 0.75]], true],
  // walls to 1.0 like a composter, but its funnel floor sits at 0.6875 → a 0.3125 step, under the
  // auto-step
  ['hopper', [[0.375, 0, 0.375, 0.625, 0.6875, 0.625], [0.25, 0.25, 0.25, 0.375, 0.6875, 0.75],
    [0.375, 0.25, 0.25, 0.75, 0.6875, 0.375], [0.375, 0.25, 0.625, 0.75, 0.6875, 0.75],
    [0.625, 0.25, 0.375, 0.75, 0.6875, 0.625], [0, 0.625, 0, 0.25, 0.6875, 1],
    [0.25, 0.625, 0, 1, 0.6875, 0.25], [0.25, 0.625, 0.75, 1, 0.6875, 1], [0.75, 0.625, 0.25, 1, 0.6875, 0.75],
    [0, 0.6875, 0, 0.125, 1, 1], [0.125, 0.6875, 0, 1, 1, 0.125], [0.125, 0.6875, 0.875, 1, 1, 1],
    [0.875, 0.6875, 0.125, 1, 1, 0.875]], false],
  // rim 1.0, empty centre column — the shape the support clause exists to exclude
  ['oak_door', [[0, 0, 0, 0.1875, 1, 1]], false],
  ['chest', [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]], false],
  ['oak_planks', [[0, 0, 0, 1, 1, 1]], false],
]) {
  if (_binFromShapes(shapes) !== mustBeBin) {
    throw new Error(`[terrain_predicates] CODING VIOLATION (Law 13): the open-top-container rule now reads `
      + `'${name}' as ${mustBeBin ? 'safe to stand in' : 'a trap'}, which is backwards. A composter and a `
      + `cauldron are bins a body falls into and cannot step out of — the surface under its middle sits `
      + `more than ${STEP_HEIGHT} (the vanilla auto-step) below the cell's rim. A hopper, a door, a chest `
      + `and a full block are not. If STEP_HEIGHT, the support clause or the centre-column arithmetic `
      + `changed, this is the claim that change broke.`);
  }
}

// ctx may carry { bot } for ladder-adjacency evaluation.
function isWalkableSurface(block, ctx) {
  if (!block) return false;
  const name = block.name;
  if (!name) return false;
  if (block.boundingBox === 'empty') return false;
  if (NON_STANDABLE_SURFACES.has(name)) return false;
  // Fences, fence gates and walls collide to 1.5 blocks — a half-block perch the 1-block grid cannot
  // model — so they read as non-standable and A* routes around them, never over.
  if (/_fence$/.test(name) || /_fence_gate$/.test(name) || /_wall$/.test(name)) return false;
  if (isOpenTopContainer(block)) return false;
  // A leaf is never a floor: it decays once its tree is cut and a passing body punches it as foliage,
  // so ground that can leave on its own is kept out of every route (Law 17).
  if (require('@utils/movement/leaf_authority').isLeafBlock(block)) return false;
  return true;
}

// ── A STATION'S TOP IS NOT A PARKING SPOT ────────────────────────────────────────────────────────────
// Kept out of isWalkableSurface: safe to CROSS but a route must never TERMINATE on one (Invariant D).
// Gates ENDPOINTS only — the goal test and the partial-result pick in the route search — and reads
// canonical STATION_TYPES, never a second list (Law 16).

// Takes the FLOOR block — the cell the body stands ON, not the cell it occupies.
function isStationFloor(block) {
  return !!(block && block.name && STATION_TYPES.has(block.name));
}

// Conservative (Law 13): a missing/null block reads as unsafe, never safe-by-default.
const UNSAFE_SURFACE_SET = new Set([
  'water','flowing_water','lava','flowing_lava','bubble_column',
  'fire','soul_fire','campfire','soul_campfire','magma_block',
  'nether_portal','end_portal','end_gateway',
  'cactus','sweet_berry_bush','cobweb','powder_snow'
]);

function isNotSafeSurface(block) {
  if (!block) return true;
  const name = block.name;
  if (!name) return true;
  return UNSAFE_SURFACE_SET.has(name);
}

// A WALL CELL BESIDE THE BODY harms it when it flows, burns or catches across the face between them. A
// campfire and a magma block harm only what stands on them, so beside the body they are a wall like any other.
const HARMS_ONLY_FROM_ABOVE = new Set(['campfire', 'soul_campfire', 'magma_block']);
function isHazardBeside(block) {
  return isNotSafeSurface(block) && !(block && HARMS_ONLY_FROM_ABOVE.has(block.name));
}

// getClearance: are `levels` blocks above passable (non-colliding, non-hazard)?
function getClearance(bot, block, levels = 3) {
  const PASS_THROUGH = new Set([
    'air','cave_air','void_air',
    'grass','short_grass','tall_grass','fern','large_fern','dead_bush','seagrass','kelp','kelp_plant',
    'oak_sapling','birch_sapling','spruce_sapling','jungle_sapling','acacia_sapling','dark_oak_sapling','mangrove_propagule','cherry_sapling',
    'vine','torch'
  ]);
  const HAZARD_EMPTY = new Set([
    'water','flowing_water','lava','flowing_lava','bubble_column',
    'fire','soul_fire','campfire','soul_campfire',
    'cobweb','powder_snow'
  ]);
  const { isPhantom } = require('@utils/movement/leaf_authority');
  for (let i = 1; i <= levels; i++) {
    const above = bot.blockAt(block.position.offset(0, i, 0));
    if (!above) return false;
    if (PASS_THROUGH.has(above.name)) continue;
    if (above.boundingBox === 'empty' && !HAZARD_EMPTY.has(above.name)) continue;
    // A phantom leaf is not an obstruction: the body removes it on contact, so it's excluded from
    // PASS_THROUGH. A blueprint's own leaf is not a phantom and still returns false here.
    if (isPhantom(bot, above)) continue;
    return false;
  }
  return true;
}

// classifyFloor: 'jumpable' = 3 air above, 'walkable' = 2, null = neither/unsafe.
function classifyFloor(bot, block, ctx) {
  if (!block || !isWalkableSurface(block, ctx)) return null;
  if (getClearance(bot, block, 3)) return 'jumpable';
  if (getClearance(bot, block, 2)) return 'walkable';
  return null;
}
// ── SECTION 8: Environment Safety Predicates ──

// Confirmed-clear sightline: true only for a segment this bot actually sensed and found clear. False
// is the single "not confirmed" answer (blocked or never sensed) — every caller's next move is the same.
//
// Gated on both endpoints being in a loaded chunk (Invariant B): raycast treats an unloaded cell as
// clear too, so this refuses before that lie happens. Bad arguments throw (Law 13); no catch.
function hasLineOfSight(bot, fromPos, toPos, maxDist) {
  if (!fromPos || !toPos) {
    throw new Error('[movement_utils] CODING VIOLATION: hasLineOfSight requires fromPos and toPos. Check caller.');
  }
  if (!Number.isFinite(maxDist)) {
    // NaN/undefined would make every raycast distance comparison false and a miss report as "clear".
    throw new Error(`[movement_utils] CODING VIOLATION: hasLineOfSight requires a finite maxDist, got ${maxDist}. Check caller.`);
  }

  // blockAt is null exactly when the chunk is absent — the case raycast would silently treat as air.
  if (bot.blockAt(fromPos) === null || bot.blockAt(toPos) === null) {
    watcher.warn('terrain_predicates',
      `hasLineOfSight (${fromPos.x},${fromPos.y},${fromPos.z})->(${toPos.x},${toPos.y},${toPos.z}): endpoint in an UNLOADED chunk — not confirmed.`);
    return false;
  }

  const start = fromPos.offset(0, 1.5, 0);
  const dir = toPos.plus(new Vec3(0.5, 0.5, 0.5)).minus(start);
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (len === 0) return true;
  const norm = new Vec3(dir.x / len, dir.y / len, dir.z / len);
  const range = Math.min(maxDist + 1, 20);
  return !bot.world.raycast(start, norm, range);
}

// ── THE EYE, MATCHED TO THE MOB'S OWN RAY ──────────────────────────
// Java's mob sight test casts eye-to-eye; using the same two endpoints gets the same answer the mob's
// own ray gets, so the bot cannot be shot by something it believes it cannot see — as long as both
// endpoints are the real eye height.
//
// Reads the library's value when it has one (Law 23); models it only for mobs minecraft-data carries
// no eye height for. The load-time check below catches a transcription slip in that modelled table.
// 0.85 is Java's own fallback ratio, so an unlisted mob is modelled the same way Java models one.
const EYE_HEIGHT_RATIO = 0.85;
const DEFAULT_BODY_HEIGHT = 1.8;
// Java overrides the ratio with fixed constants for these mobs.
const EYE_HEIGHT = {
  player: 1.62,
  zombie: 1.74, zombie_villager: 1.74, husk: 1.74, drowned: 1.74,
  skeleton: 1.74, stray: 1.74, bogged: 1.74,
  spider: 0.65, cave_spider: 0.45,
  enderman: 2.55,
};
function eyePos(entity) {
  // Library's value first — mineflayer sets eyeHeight on players, never mobs (Law 23).
  if (Number.isFinite(entity.eyeHeight) && entity.eyeHeight > 0) {
    return entity.position.offset(0, entity.eyeHeight, 0);
  }
  const named = EYE_HEIGHT[entity.name];
  if (Number.isFinite(named)) return entity.position.offset(0, named, 0);
  const h = Number.isFinite(entity.height) && entity.height > 0 ? entity.height : DEFAULT_BODY_HEIGHT;
  return entity.position.offset(0, h * EYE_HEIGHT_RATIO, 0);
}

// hasEntityLineOfSight — sightline between two BODIES (live eye positions), a different question from
// hasLineOfSight's block-to-block check and not served by it. Endpoints are unfloored: flooring one
// moves the ray into a cell corner or a foot block instead of the two heads in question.
//
// Exposes the block the last cast stopped on via lastSightlineBlock, so a decline can be told apart
// from a genuine miss (Law 25); read it immediately after the call — a stale read is a different mob.
let _lastBlock = null;
function lastSightlineBlock() { return _lastBlock; }

function hasEntityLineOfSight(bot, entity, maxDist) {
  if (!bot || !bot.entity || !entity || !entity.position) {
    throw new Error('[terrain_predicates] CODING VIOLATION: hasEntityLineOfSight requires a bot body and an entity. Check caller.');
  }
  if (!Number.isFinite(maxDist)) {
    throw new Error(`[terrain_predicates] CODING VIOLATION: hasEntityLineOfSight requires a finite maxDist, got ${maxDist}. Check caller.`);
  }

  const start = eyePos(bot.entity);
  const end = eyePos(entity);
  _lastBlock = null;

  // Same gate as hasLineOfSight: an unloaded endpoint must never answer "confirmed clear".
  if (bot.blockAt(start) === null || bot.blockAt(end) === null) {
    watcher.warn('terrain_predicates',
      `hasEntityLineOfSight -> entity ${entity.id}: endpoint in an UNLOADED chunk — not confirmed.`);
    _lastBlock = { name: 'unloaded_chunk', pos: null, dist: null, dy: null };
    return false;
  }

  const dir = end.minus(start);
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (len === 0) return true;
  const norm = new Vec3(dir.x / len, dir.y / len, dir.z / len);
  // Stop the ray AT the far body, never past it: a wall behind the mob is not between us.
  const hit = bot.world.raycast(start, norm, Math.min(len, maxDist + 1, 20));
  if (!hit) return true;
  // `dy` tells a mob-in-a-ravine blocker (ground) apart from a real wall at eye level.
  _lastBlock = {
    name: hit.name || 'unknown',
    pos: hit.position ? [hit.position.x, hit.position.y, hit.position.z] : null,
    dist: hit.position ? Math.round(start.distanceTo(hit.position) * 100) / 100 : null,
    dy: hit.position ? Math.round((hit.position.y - start.y) * 10) / 10 : null,
  };
  return false;
}

// ── SECTION 9: Approach Calculator ──
// Pure delta math: turns two block positions into an ordered step list (Z, then X, then Y; no
// diagonals). Entries { type:'horizontal'|'pillar_up'|'descend', dx, dz }; the caller dispatches each.

function calculateApproach(botPos, targetPos) {
  const steps = [];
  const dz = targetPos.z - botPos.z;
  const dx = targetPos.x - botPos.x;
  const dy = targetPos.y - botPos.y;
  const zSign = Math.sign(dz);
  for (let i = 0; i < Math.abs(dz); i++) {
    steps.push({ type: 'horizontal', dx: 0, dz: zSign });
  }
  const xSign = Math.sign(dx);
  for (let i = 0; i < Math.abs(dx); i++) {
    steps.push({ type: 'horizontal', dx: xSign, dz: 0 });
  }
  if (dy > 0) {
    for (let i = 0; i < dy; i++) steps.push({ type: 'pillar_up' });
  } else if (dy < 0) {
    for (let i = 0; i < Math.abs(dy); i++) steps.push({ type: 'descend' });
  }
  return steps;
}
function isAir(name) {
  return name === null || name === undefined || name === 'air' || name === 'cave_air' || name === 'void_air';
}

function dist3(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

module.exports = {
  isWalkableSurface,
  isOpenTopContainer,
  isStationFloor,
  isNotSafeSurface,
  isHazardBeside,
  getClearance,
  classifyFloor,
  hasLineOfSight,
  hasEntityLineOfSight,
  lastSightlineBlock,
  // No production caller outside this file; kept for tools/raycast_crucible.js to measure live.
  eyePos, EYE_HEIGHT, EYE_HEIGHT_RATIO,
  calculateApproach,
  isAir,
  dist3,
  belowDepthFloor,
};
