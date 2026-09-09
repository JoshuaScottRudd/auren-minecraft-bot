// module: movement/terrain_predicates — the ONE answer to "may the body be here".
// Walkability, hazards, clearance, floor type, sightline, and the two arithmetic helpers everything
// else leans on. A leaf: it reads the world and returns a verdict, and presses nothing.
//
// It is the bottom of this folder's DAG on purpose. district_scanner, bot_state and pathfinding_utils
// all price terrain off these same predicates, so a second copy anywhere would let the planner and the
// body disagree about which cells exist (Law 16) — and that disagreement surfaces as a bot walking a
// route it cannot actually take.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { WORLD_DEPTH_FLOOR_Y } = require('@thinking/architect_config');
const { STATION_TYPES } = require('@utils/fragment_utils');

// ── THE DEPTH FLOOR (one predicate, Law 16) ─────────────────────────────────────────────────────
// The number lives in architect_config; the QUESTION lives here, because this module is already the
// one answer to "may the body be here" and a floor is that question with a constant in it. Three
// consumers ask it — the route search, the dig authority, the drop sweep — and a second copy of the
// comparison would let them disagree about which cells exist, which is exactly the planner/body split
// this file's header exists to prevent.
//
// Takes a bare Y so a caller can ask about a cell it has not fetched a block for (the search asks per
// node, before any world read). Floors the input: an entity Y is a float and the floor is a cell line.
function belowDepthFloor(y) {
  return WORLD_DEPTH_FLOOR_Y !== null && Math.floor(y) < WORLD_DEPTH_FLOOR_Y;
}

// ── SECTION 2: Terrain Predicates ──
// Single source of truth for walkability, hazards, clearance, and floor type — shared by
// district_scanner, bot_state, path_finder, and all movement logic (Law 16).

// HOISTED OUT OF isWalkableSurface (2026-08-04, measured). This set used to be built INSIDE the
// function, so every call allocated a fresh 20-string Set and threw it away. isWalkableSurface is the
// single most-asked question in the fleet — 531,975 calls inside ONE A* search — and the rebuild alone
// measured 16.2% of that search's total time (0.77us per call, 104x the cost of the lookup it exists to
// serve). Module scope is the only correct home: the list is a constant, and a constant rebuilt per call
// is pure waste that scales with how hard the bot is thinking.
// Behaviour is bit-identical — same names, same membership, same answers.
const NON_STANDABLE_SURFACES = new Set([
  'air','cave_air','void_air',
  'water','flowing_water','lava','flowing_lava','bubble_column',
  'nether_portal','end_portal','end_gateway',
  'fire','soul_fire','campfire','soul_campfire',
  'cactus','sweet_berry_bush','magma_block',
  'cobweb','powder_snow',
]);

// ── OPEN-TOPPED CONTAINERS ARE NOT FLOORS ────────────────────────────────────────────────────────────
// A composter reports boundingBox 'block', exactly as a plank does, and its collision reaches y=1.0 — so
// every predicate in this fleet read it as a solid floor. It is a BIN: an interior floor at 0.125 and four
// walls 0.125 thick around an OPEN TOP. Two consequences, both measured from the registry's own shapes
// rather than assumed:
//   - a 0.6-wide body cannot rest on a 0.125 rim, so "standing on" one always means falling INSIDE it;
//   - from that interior floor the rim is a 0.875 step, against a 0.6 auto-step — the body cannot walk out.
// A* then plans a plain walk from a cell the body physically cannot leave, and re-plans it until the stall
// guard fires. Cost: a bot sat in the compost bin pushing at its wall for six minutes while the trace read
// "headframe access unreachable" (2026-08-14).
//
// DERIVED, NOT LISTED, and that is the whole point. This file's fence rule is the same defect — a perch
// the 1-block grid cannot model — and it is a name regex that only ever grew when something got stuck.
// The shape data already knows; a rule that reads it covers cauldron today and anything of that shape
// later, with nobody maintaining a list.
//
// THE MEASUREMENT IS THE CENTRE COLUMN, not the highest point. What holds a body up is the collision
// under its middle, so a shape that does not span the centre (a bin's walls) supports nothing. That is
// also exactly why isFullHeightFloor — which takes the MAXIMUM top — passes a composter: it measures the
// rim. Same data, different question, and only the centre answers "what will the feet land on".
const STEP_HEIGHT = 0.6;   // vanilla auto-step; above this the body must jump, and A* walk edges never do

// Memoised per block TYPE because isWalkableSurface is the most-asked question in the fleet — 531,975
// calls inside one A* search — and this file already hoists its constants for that reason. The shapes of
// a type never change, so the arithmetic runs once and every later call is one Map lookup.
const _binByState = new Map();

// TWO conditions, and the second is what makes the first mean anything.
//
// `centre` is the highest collision surface UNDER THE BODY'S MIDDLE — where a body inside this cell would
// actually come to rest. `rim` is the highest collision surface anywhere in the cell — what it must clear
// to leave. A bin is a cell that supports the body low and walls it high.
//
// centre > 0 IS NOT A FORMALITY. Without it the rule catches every door, trapdoor and ladder in the game:
// a door's collision is one full-height slab against a wall (`[0,0,0,0.1875,1,1]`), so rim is 1.0 and the
// centre column is empty, and rim-minus-nothing looks exactly like an infinitely deep pit. It is the
// opposite — a partial WALL. A body never rests in that cell at all; it stands on the block below and this
// predicate is not the question being asked. Measured against the whole 1.21.5 block table: with the
// support clause, five block families answer true (composter and the four cauldrons) and nothing else;
// without it, fifty-four do, including every door and every trapdoor.
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

// Keyed on the STATE id, not the block type, because collision geometry is a property of the STATE: one
// type's states can differ in shape (snow by layer count, a trapdoor by open/closed). A type-keyed memo
// would let the first state seen answer for states it never measured.
function isOpenTopContainer(block) {
  const key = block.stateId !== undefined ? block.stateId : block.type;
  const hit = _binByState.get(key);
  if (hit !== undefined) return hit;
  const verdict = _binFromShapes(block.shapes);
  _binByState.set(key, verdict);
  return verdict;
}

// THE BLOCKS THIS WAS WRITTEN FOR, PINNED — as an assertion rather than as names in NON_STANDABLE_SURFACES
// above. Listing them there would work and would be the redundant pathway Law 16 forbids: two mechanisms
// answering "is a composter standable", free to disagree after an edit, with the list silently covering
// for a rule that had stopped working. An assertion cannot do the rule's job for it — it can only fail
// loudly when the rule stops doing it — so the derived rule stays the ONE answer.
//
// Runs at module load, so `preflight` fires it on every change for free (tools/README: a
// guarantee's permanent home is a throw in the module that owns the data, never a test file). Literal
// geometry rather than a live registry: the claim under test is the ARITHMETIC, and a registry dependency
// in the fleet's hottest leaf module would risk every bot's startup to check it. Every array below is
// COPIED FROM prismarine-registry 1.21.5, never hand-drawn — an invented shape tests the fiction it was
// drawn from, which is a well-formed falsehood wearing a pass (Law 26). oak_door and hopper are here as
// the two near-misses that a plausible simplification of the rule gets wrong in each direction.
for (const [name, shapes, mustBeBin] of [
  // interior floor 0.125, four walls to y=1.0 → a 0.875 step out
  ['composter', [[0, 0, 0, 1, 0.125, 1], [0, 0.125, 0, 0.125, 1, 1], [0.125, 0.125, 0, 1, 1, 0.125],
    [0.125, 0.125, 0.875, 1, 1, 1], [0.875, 0.125, 0.125, 1, 1, 0.875]], true],
  // interior floor 0.25 → a 0.75 step out; also over the auto-step, also inescapable
  ['cauldron', [[0, 0, 0, 0.125, 1, 0.25], [0, 0, 0.75, 0.125, 1, 1], [0.125, 0, 0, 0.25, 1, 0.125],
    [0.125, 0, 0.875, 0.25, 1, 1], [0.75, 0, 0, 1, 1, 0.125], [0.75, 0, 0.875, 1, 1, 1],
    [0.875, 0, 0.125, 1, 1, 0.25], [0.875, 0, 0.75, 1, 1, 0.875], [0, 0.1875, 0.25, 1, 0.25, 0.75],
    [0.125, 0.1875, 0.125, 0.875, 0.25, 0.25], [0.125, 0.1875, 0.75, 0.875, 0.25, 0.875],
    [0.25, 0.1875, 0, 0.75, 1, 0.125], [0.25, 0.1875, 0.875, 0.75, 1, 1],
    [0, 0.25, 0.25, 0.125, 1, 0.75], [0.875, 0.25, 0.25, 1, 1, 0.75]], true],
  // walls to 1.0 like a composter, but its funnel holds the body at 0.6875 → a 0.3125 step, under the
  // auto-step. The body walks out unaided, so a rule keyed on "has walls" instead of on the step is wrong.
  ['hopper', [[0.375, 0, 0.375, 0.625, 0.6875, 0.625], [0.25, 0.25, 0.25, 0.375, 0.6875, 0.75],
    [0.375, 0.25, 0.25, 0.75, 0.6875, 0.375], [0.375, 0.25, 0.625, 0.75, 0.6875, 0.75],
    [0.625, 0.25, 0.375, 0.75, 0.6875, 0.625], [0, 0.625, 0, 0.25, 0.6875, 1],
    [0.25, 0.625, 0, 1, 0.6875, 0.25], [0.25, 0.625, 0.75, 1, 0.6875, 1], [0.75, 0.625, 0.25, 1, 0.6875, 0.75],
    [0, 0.6875, 0, 0.125, 1, 1], [0.125, 0.6875, 0, 1, 1, 0.125], [0.125, 0.6875, 0.875, 1, 1, 1],
    [0.875, 0.6875, 0.125, 1, 1, 0.875]], false],
  // rim 1.0 and an empty centre column — the shape that breaks the rule without its support clause
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
  // Tall non-full blocks (fence, fence gate, wall) collide to 1.5 blocks, so their top is a
  // half-block perch the 1-block-grid navigator cannot model: it plans the bot ONTO the fence, the
  // bot floats off-grid, and every microCenter there burns to max_iters (never reaches an exact
  // cell center on a fence's narrow top). Novel once the farm perimeter introduced fences — treat
  // them as non-standable so A* routes AROUND them, never over (Architect 2026-07-10).
  if (/_fence$/.test(name) || /_fence_gate$/.test(name) || /_wall$/.test(name)) return false;
  if (isOpenTopContainer(block)) return false;
  return true;
}

// ── A STATION'S TOP IS NOT A PARKING SPOT ────────────────────────────────────────────────────────────
// DELIBERATELY NOT PART OF isWalkableSurface, and the separation is the whole design. A station is a
// solid, safe block to CROSS — folding it into walkability would route the fleet around its own base
// furniture and can wall off a doorway a chest happens to stand beside, which is a navigation defect
// traded for a stance defect. What must never happen is a route TERMINATING on one: a body parked on a
// chest is standing on the lid it or a peer has to open next (Invariant D — the station's access
// belongs to the station's user, not to whoever stopped walking there).
//
// So this predicate gates ENDPOINTS only. Its callers are the goal test and the partial-result pick in
// the route search — the two places a path decides where the body comes to rest.
//
// Reads the canonical STATION_TYPES rather than a second list (Law 16): one definition of "what is a
// station", already shared with the dig guards that must never break one.
//
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
  for (let i = 1; i <= levels; i++) {
    const above = bot.blockAt(block.position.offset(0, i, 0));
    if (!above) return false;
    if (PASS_THROUGH.has(above.name)) continue;
    if (above.boundingBox === 'empty' && !HAZARD_EMPTY.has(above.name)) continue;
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

// DEAD CODE (verified r33): defined and exported, ZERO callers repo-wide. Flagged for the Architect's
// deletion call (Law 16) rather than deleted in a catch sweep. The fail-open catch is fixed meanwhile
// so a future revival inherits the right default — it used to `catch (_) { return false }`, turning an
// exception into "no hazard" and inverting Law 13 (default stopped) / Law 17 (self-preservation).
// blockAt returning null for an unloaded cell already reads as unsafe via isNotSafeSurface, so the
// only real throw here is a missing entity: answer SURROUNDED and let the caller stop.
function isSurroundedByUnsafeAtFeet(bot) {
  if (!bot?.entity?.position) {
    watcher.warn('terrain_predicates', 'isSurroundedByUnsafeAtFeet: no bot entity (dead/despawned?) — answering SURROUNDED (fail closed).');
    return true;
  }
  const feet = bot.entity.position.floored();
  const n = bot.blockAt(new Vec3(feet.x, feet.y, feet.z - 1));
  const s = bot.blockAt(new Vec3(feet.x, feet.y, feet.z + 1));
  const w = bot.blockAt(new Vec3(feet.x - 1, feet.y, feet.z));
  const e = bot.blockAt(new Vec3(feet.x + 1, feet.y, feet.z));
  return isNotSafeSurface(n) && isNotSafeSurface(s) && isNotSafeSurface(w) && isNotSafeSurface(e);
}

// ONE contract, read ONE way (r34, Architect's ruling — "works one way and callers read from it one
// way"): returns true ONLY for sight CONFIRMED clear through space this bot has actually sensed.
// false is the single "did not confirm" answer and deliberately does not distinguish its two causes
// (a block is in the way / the space was never sensed) — every caller's next move is identical either
// way, and a boolean that tried to carry "unknown" as a third state is what produced the old mess.
// Bad arguments throw (Law 13). There is no catch, no fallback, and no error-default to argue about.
//
// The r33 "caller conflict" was a phantom, and this is the correction (Law 23 — the note it replaced
// was the construct's own claim, and it was wrong). That note said canStrike/drop_collector want FALSE
// on error while threat_scanner wants TRUE, and left the tie for the Architect. But it never checked
// whether the error it was defaulting for exists: prismarine's raycast path (worldsync.js:40-63,
// iterators.js) contains ZERO throw statements. Nothing environmental can throw here, so no caller
// ever reaches an error-default and there was nothing to disagree about. All three read true as
// "there is sight → act" and always did — threat_scanner:91 (`aggroed = inRange && hasLineOfSight`),
// drop_collector:170 (true → select the drop), canStrike:907 (true → swing).
//
// What the catch was hiding is the real defect. raycast walks `getBlock(pos)` and does `if (block)`,
// and getBlock returns NULL for an unloaded chunk — so an unsensed cell is silently STEPPED OVER and
// the ray continues, returning null = "clear". Unsensed space does not throw; it reports as thin air
// (Invariant B — remembered/absent state answering as fresh). Guarding the call never touched that;
// the guard caught an impossible exception while the lie walked straight through it. So the chunk gate
// below is the actual fix and the try/catch is simply gone: a raycast throw could now only be a
// TypeError from malformed args, i.e. our bug, which must fly (Law 13).
//
// Third sighting of the missing chunk-presence gate — after digBounded (r31) and getBiomeName (r33).
// Gated per-call here rather than by extracting the shared primitive, because that primitive is a
// design act and belongs at the Architect's table (Law 22 gate 2), not inside an optimization pass.
//
// Endpoint-gated, not whole-ray: a mid-ray unloaded chunk between two loaded endpoints ≤20 blocks
// apart is not reachable in practice (chunks are 16-wide columns), and catching it would mean walking
// the ray ourselves and abandoning raycast. Stated so the limit is known rather than assumed away.
function hasLineOfSight(bot, fromPos, toPos, maxDist) {
  if (!fromPos || !toPos) {
    throw new Error('[movement_utils] CODING VIOLATION: hasLineOfSight requires fromPos and toPos. Check caller.');
  }
  if (!Number.isFinite(maxDist)) {
    // NaN/undefined would flow into Math.min → RaycastIterator's maxDistance, where every comparison
    // is false, the walk ends immediately and the miss reports as "clear" — a silent true.
    throw new Error(`[movement_utils] CODING VIOLATION: hasLineOfSight requires a finite maxDist, got ${maxDist}. Check caller.`);
  }

  // Invariant B gate: refuse to answer "confirmed clear" across space never sensed. blockAt is null
  // exactly when the chunk is absent — the case raycast would silently treat as air.
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

// ── THE EYE, AND WHY IT MUST BE THE MOB'S OWN NUMBER (Architect 2026-08-03) ──────────────────────────
// "if the monsters use a proper raycast for aggro then were just tracing the line back the same way the
//  monster does and so the bot should know when aggro happens if it raycasts the same way monsters do."
//
// That is exactly right, and it is what makes this predicate correct rather than merely conservative.
// Java's mob sight test casts from the SEER's eye to the TARGET's eye, and a segment is a segment — cast
// it from either end and it crosses the same blocks. So a bot whose ray uses the same two endpoints the
// skeleton's ray uses gets the SAME ANSWER the skeleton got, every time. Sight becomes symmetric and the
// bot cannot be shot by something it believes it cannot see.
//
// It stops being symmetric the moment an endpoint is approximated, and both were. The old note called
// 0.85 "at the LOW end of that spread ... deliberate", reasoning that a low ray stays inside the body.
// That reasoning is sound for *hitting a body* and wrong for *matching a mob's ray*: too low is not safe
// here, it is simply a DIFFERENT LINE from the one the mob cast, and near-grazing terrain is where a few
// centimetres flips MISS into HIT. The bot's own eye was 1.53 against Java's 1.62 — 9 cm — and mineflayer
// had the real value on the entity the whole time (`PLAYER_EYEHEIGHT`, entities.js:9).
//
// So: READ it when the library knows it (Law 23 — never model what can be sensed), model it when the
// library does not. minecraft-data carries `height` and `width` for every mob and no eye height at all,
// so the table below is the modelled half and it is the half that can be wrong. A wrong entry does not
// crash: it silently returns the bot to disagreeing with the mob, which is this exact defect wearing a
// new number. Each WAS pinned in a bench retired 2026-08-10 (`tools/README.md`); what is owed in its place
// is a load-time throw here — every eye positive and below its own body height, which catches a
// transcription slip without pretending to know Java's numbers better than Java does.
//
// 0.85 stays as the fallback because it is JAVA'S OWN default (`Entity.getEyeHeight` → height · 0.85);
// an unlisted mob is therefore modelled by the same rule Java uses for an unlisted mob, not by a guess.
const EYE_HEIGHT_RATIO = 0.85;
const DEFAULT_BODY_HEIGHT = 1.8;
// Java overrides the default for these. Values are the constants, not ratios, because that is how Java
// states them — deriving a ratio and re-multiplying would reintroduce the rounding this fixes.
const EYE_HEIGHT = {
  player: 1.62,
  // The whole zombie and skeleton family share 1.74 despite differing total heights, which is precisely
  // why a single ratio cannot serve: 1.74/1.99 and 1.74/1.95 are not the same number.
  zombie: 1.74, zombie_villager: 1.74, husk: 1.74, drowned: 1.74,
  skeleton: 1.74, stray: 1.74, bogged: 1.74,
  // The spider sits far below the default ratio (0.65 of a 0.9 body = 0.72), and it is the mob most
  // likely to be on the other side of a lip in the ground, where the error decides the answer.
  spider: 0.65, cave_spider: 0.45,
  enderman: 2.55,
};
function eyePos(entity) {
  // The library's own value first, and only the bot has one — mineflayer sets `eyeHeight` on players
  // and never on mobs. Sensed beats modelled (Law 23).
  if (Number.isFinite(entity.eyeHeight) && entity.eyeHeight > 0) {
    return entity.position.offset(0, entity.eyeHeight, 0);
  }
  const named = EYE_HEIGHT[entity.name];
  if (Number.isFinite(named)) return entity.position.offset(0, named, 0);
  const h = Number.isFinite(entity.height) && entity.height > 0 ? entity.height : DEFAULT_BODY_HEIGHT;
  return entity.position.offset(0, h * EYE_HEIGHT_RATIO, 0);
}

// hasEntityLineOfSight — the sightline between two BODIES, which is a different question from the one
// hasLineOfSight above answers and must not be served by it.
//
// ── THE MEASUREMENT THAT FORCED THE SPLIT (2026-08-02) ───────────────────────────────────────────────
// threat_scanner's aggro qualifier used the block-space call: `hasLineOfSight(bot, botPos.floored(),
// mobPos.floored(), AGGRO_RANGE)`. Flooring moves the ray's start to the bot's cell CORNER (a point four
// blocks share) and its end to the centre of the mob's FOOT block — so the true question "can these two
// heads see each other" was answered by a steep ray from a block boundary into an ankle. In arena run
// 2026-08-02_01-12 that predicate declined 31 consecutive passes while a skeleton stood 2.0–3.3 blocks
// away, drew its bow ten times and killed the bot over 30 seconds without the counter ever engaging.
// The failure gets WORSE as the mob closes, which is the opposite of what an obstruction does, and it is
// invisible in a trace because "no threat found" and "no threat present" log identically. Third sighting
// of the same defect (combat_movement r-2026-08-01 removed it from the STRIKE; it survived here).
//
// WRONG TURN, already taken: deleting the raycast instead of correcting it. The qualifier is what stops
// the bot charging a mob through a wall, and the Architect ruled on 2026-08-01 that the raycast confirms
// aggro and nothing else. The defect was never that the question was asked — only that a different one
// was answered (Law 25).
//
// Endpoints are the entities' LIVE positions, unfloored. Both are real bodies the world already tracks,
// so there is nothing to round; rounding was the bug.
// ── WHY THE BLOCKER IS KEPT, AND WHY IT COSTS NOTHING (Architect 2026-08-03) ─────────────────────────
// This predicate returns a BOOLEAN, and on the 2026-08-03 run a false from it was the whole story of a
// death: battle_stations declined to engage 79 times with `why: 'no_sightline'` and there was no way to
// tell a correct decline (the mob really was behind a hill) from the third recurrence of the flooring
// defect above. "no_sightline" names the verdict and hides the evidence, which is the same silence in a
// new place (Law 25) — a reader cannot check a raycast it cannot see the result of.
//
// The raycast ALREADY computed the answer: it returns the block it stopped on and this function threw
// that away to make a boolean. Keeping it is free — no second cast, no extra work (Law 16: one pathway;
// this is the same cast reporting more of what it found, not a parallel one). Module-level with a reader
// rather than a changed return type, the same shape combat_utils' swing clock uses: per-process
// transient state, one owner, inspectable and not writable from outside (Law 9, Law 6).
//
// Read it IMMEDIATELY after the call that produced it. It describes the last cast this process made and
// nothing else — a stale read is a lie about a different mob.
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

  // Same Invariant B gate as above: never answer "confirmed clear" across space that was never sensed.
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
  // `dy` is on the record because the failure it exposes is VERTICAL and reads as ordinary otherwise: a
  // skeleton 8 blocks below in a ravine is 8.4b away and fully "in range", and the ray into it leaves
  // through the floor the bot is standing on. A blocker one block down at 1b is that geometry; a blocker
  // 6b out at eye level is a real wall. The bare name cannot tell those apart.
  _lastBlock = {
    name: hit.name || 'unknown',
    pos: hit.position ? [hit.position.x, hit.position.y, hit.position.z] : null,
    dist: hit.position ? Math.round(start.distanceTo(hit.position) * 100) / 100 : null,
    dy: hit.position ? Math.round((hit.position.y - start.y) * 10) / 10 : null,
  };
  return false;
}

// ── SECTION 9: Approach Calculator ──
// Pure delta math, world-agnostic: turns two block positions into an ordered step list
// (Z then X then Y, no diagonals). Entries { type:'horizontal'|'pillar_up'|'descend', dx, dz };
// the caller dispatches each to its primitive.

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
  getClearance,
  classifyFloor,
  isSurroundedByUnsafeAtFeet,
  hasLineOfSight,
  hasEntityLineOfSight,
  lastSightlineBlock,
  // Exported for a bench retired 2026-08-10 and for nothing else — no production caller outside this file,
  // and no consumer at all now. Kept because `tools/raycast_crucible.js` measures these against the live
  // server, which is the stronger check the retired bench could not make.
  eyePos, EYE_HEIGHT, EYE_HEIGHT_RATIO,
  calculateApproach,
  isAir,
  dist3,
  belowDepthFloor,
};
