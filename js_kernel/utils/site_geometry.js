// site_geometry — the site-scan SYSTEM, extracted from find_buildingspot.
//
// WHAT THE SYSTEM IS, stated once so both callers stay honest to it. `find_buildingspot` established a
// shape that turns out to be general, and it is three parts, not one:
//
//   1. A COLUMN READ      — where is the ground at (x,z), and what is above it.
//   2. A FOOTPRINT TEST   — does a box of a given size fit here: flat enough, clear overhead, no hazard.
//   3. AN EXPANDING RING  — sweep outward from an origin, nearest-first, so the first match IS the
//                           closest match, bounded by the loaded frontier and never by a constant.
//
// Only the FOOTPRINT TEST'S QUESTION changes between callers. That is the whole insight:
//
//   find_buildingspot asks — "is this an ideal place for THIS BLUEPRINT? flat enough to contain it, on
//                             the surface, free of hazards, no lava or water in the way?"
//   the arena asks        — "can I DROP A BODY here? a 3×3 floor with 3 clear above it, real ground and
//                             not a canopy, nowhere it drowns, not a 1×2 pocket it cannot move in?"
//
// Same three parts, different predicate. So the parts live here and each caller supplies its own
// predicate, instead of one caller reimplementing the parts around a different question — which is what
// the first draft of the arena did, and it is why this file exists.
//
// ── THE READER SEAM ─────────────────────────────────────────────────────────────────────────────────
// Nothing here touches a bot, a signal bus, the watcher, or an @-alias. Every world read goes through
//     reader = { blockAt(x, y, z) → { name, boundingBox } | null }
// which is why one module can serve a fragment INSIDE the construct and an observer tool OUTSIDE it
// without either dragging the other across the boundary. Each caller builds its own two-line adapter
// (a mineflayer bot wants a Vec3; the camera scout takes a plain object), so this file needs no
// dependency at all — not even vec3.
//
// null from blockAt means UNLOADED, and it is never air (Law 23). Every function here refuses to answer
// rather than guess across a chunk nobody has looked at: the failure class this guards is reading
// "empty because we didn't look" as "empty", and it is the one that silently sites a build in a void.

'use strict';

// ── Block vocabulary ────────────────────────────────────────────────────────────────────────────────
// Suffix matches where the game's own naming allows it: every wood type ends `_log`/`_leaves`, and a
// hardcoded list of twelve wood types is a list that ages every time a biome is added.

const AIR = new Set(['air', 'cave_air', 'void_air']);
const WATER = new Set(['water', 'bubble_column']);
const LAVA = new Set(['lava']);

// CLEARABLE — the ONE authority on "what may sit above a floor without being the floor": air, the
// vegetation a preconstruction pass removes for free (trees/logs/leaves, forest-floor flora, crops,
// snow), and nothing else. Anything NOT here is solid terrain — grass_block/dirt/stone/gravel/sand at
// height is a real slope or mountain wall.
//
// Lives here rather than in building_site_overlays because that module reaches the watcher and
// @perception, so an observer tool cannot import it — and the arena needs this exact set, not a
// similar one. building_site_overlays re-exports it, so every existing consumer is unchanged and
// there is still exactly one definition (Law 16).
//
// Live-tuned: the 1.21.5 "Spring to Life" flora (leaf_litter/wildflowers/bush/dry-grass) is in here
// because a birch_forest floor is carpeted with it and would otherwise be wrongly read as non-clearable
// terrain.
const CLEARABLE = new Set([
  'air', 'cave_air', 'void_air',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'stripped_oak_log', 'stripped_spruce_log', 'stripped_birch_log', 'stripped_jungle_log', 'stripped_acacia_log', 'stripped_dark_oak_log',
  'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
  'azalea_leaves', 'flowering_azalea_leaves',
  // giant mushrooms — present in dark forest, fully clearable like trees
  'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem',
  'brown_mushroom', 'red_mushroom',
  'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern',
  // decorative ground plants — a farm site sits in a forest, so the canopy AND the forest-floor flora it
  // grows over must not reject the site (preconstruction clears them). These are non-solid clearable
  // plants, NOT terrain — grass_block/dirt at height stay non-clearable (real slope). wildflowers/bush/
  // leaf_litter/dry-grass are the 1.21.5 "Spring to Life" flora the birch_forest floor is carpeted with.
  'leaf_litter', 'wildflowers', 'pink_petals', 'bush', 'firefly_bush', 'cactus_flower',
  'short_dry_grass', 'tall_dry_grass',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'sunflower', 'lilac', 'rose_bush', 'peony',
  'dead_bush', 'vine', 'hanging_roots', 'spore_blossom',
  'azalea', 'flowering_azalea',
  'bamboo', 'sugar_cane',
  'snow', 'moss_carpet',
  'wheat', 'carrots', 'potatoes', 'beetroots',
]);

const STONE_FAMILY = new Set([
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'cobblestone', 'gravel',
  'blackstone', 'basalt', 'dripstone_block', 'packed_ice', 'blue_ice', 'ice', 'snow_block', 'powder_snow',
]);

const isAir = n => AIR.has(n);
const isWater = n => WATER.has(n);
const isLava = n => LAVA.has(n);
const isLeaves = n => n.endsWith('_leaves');
const isLog = n => n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem') || n.endsWith('_hyphae');
const isCanopy = n => isLeaves(n) || isLog(n);
const isStone = n => STONE_FAMILY.has(n) || n.endsWith('_ore') || n.startsWith('polished_');

// isGround: is this block terrain — the thing a build floor rests on, or a body stands on?
//
// EXACTLY find_buildingspot's long-standing test, moved and not re-decided: solid bounding box, and not
// in CLEARABLE. Air/water/lava are named explicitly for a reader, not for the logic — all three are
// boundingBox 'empty', so the last line already excluded them.
//
// The canopy SUFFIX rule (`_log`/`_leaves`/…, which would also catch wood types CLEARABLE predates,
// e.g. pale_oak) deliberately does NOT live here. It is the arena's own requirement for a body being
// dropped, not a claim about what terrain is, and putting it here would silently retune where the live
// fleet sites its base as a side effect of building a test bench. It is applied in evaluateOpenBox
// instead, by the caller that actually asked for it.
function isGround(block) {
  if (!block || !block.name) return false;
  const n = block.name;
  if (isAir(n) || isWater(n) || isLava(n)) return false;
  if (CLEARABLE.has(n)) return false;
  return block.boundingBox === 'block';
}

// isPassable: can a body OCCUPY this cell? Air and ground cover yes; water yes as a cell (a body fits),
// which is why drowning is checked separately by whoever cares — occupancy and survivability are two
// different questions and fusing them would make a river crossing unrepresentable.
function isPassable(block) {
  if (!block) return false;                     // unloaded is not passable (Law 23)
  const n = block.name;
  if (isAir(n) || isWater(n)) return true;
  if (CLEARABLE.has(n)) return true;
  return block.boundingBox === 'empty';
}

// ── Part 1: the column read ─────────────────────────────────────────────────────────────────────────

const SCAN_UP = 40;
const SCAN_DOWN = 24;

// surfaceY — the TOPMOST ground in the column: find_buildingspot's question, unchanged. A surface
// building sits on the sky-facing surface, so "topmost" is exactly right there.
// Returns { y, name } or null (unloaded, or no ground in the window).
function surfaceY(reader, x, z, refY, scanUp = SCAN_UP, scanDown = SCAN_DOWN) {
  for (let y = refY + scanUp; y >= refY - scanDown; y--) {
    const b = reader.blockAt(x, y, z);
    if (b === null) return null;
    if (isGround(b)) return { y, name: b.name };
  }
  return null;
}

// floorNearest — the floor NEAREST THE OBSERVER'S OWN LEVEL: the arena's question, and a different one.
//
// A floor is a solid cell with something non-solid directly above it. A column can hold several — a cave
// has its floor AND the upper surface of its roof; an overhang has the ledge and the ground beneath.
//
// WRONG TURN, and it is the obvious one: reusing surfaceY here. Topmost-first reads a cave's ROOF as the
// ground every single time, so a cave spawn box is never found and the one terrain that most stresses a
// retreat calculation is silently absent from every sweep. Both answers are correct — they are answers
// to different questions, and only the distance-to-observer tiebreak tells them apart, which is what
// finding an open area on the surface OR an open area in a cave needs.
// Returns { y, name } or null.
function floorNearest(reader, x, z, refY, scanUp = SCAN_UP, scanDown = SCAN_DOWN) {
  const top = refY + scanUp, bottom = refY - scanDown;
  let best = null, bestGap = Infinity;
  let above = reader.blockAt(x, top, z);
  if (above === null) return null;
  for (let y = top - 1; y >= bottom; y--) {
    const b = reader.blockAt(x, y, z);
    if (b === null) return null;
    if (isGround(b) && !isGround(above)) {
      const gap = Math.abs(y - refY);
      if (gap < bestGap) { bestGap = gap; best = { y, name: b.name }; }
    }
    above = b;
  }
  return best;
}

// columnAbove — what sits over a floor, to `height` cells. The raw material for every "is it safe to be
// here" question, kept separate from the judgement so a caller decides what disqualifies it.
function columnAbove(reader, x, z, floorY, height) {
  const cells = [];
  for (let dy = 1; dy <= height; dy++) {
    const b = reader.blockAt(x, floorY + dy, z);
    if (b === null) return null;
    cells.push(b);
  }
  return cells;
}

// ── Part 2: the footprint test ──────────────────────────────────────────────────────────────────────

// REJECTION reasons, enumerated so every caller's post-mortem speaks one vocabulary and a reader never
// has to decode a free-text string (find_buildingspot's REJECTION_LABELS convention, generalised).
const REASON = {
  UNLOADED: 'chunk_unloaded',
  NO_FLOOR: 'no_floor',
  TOO_UNEVEN: 'too_uneven',
  UNSTEPPABLE: 'unsteppable',
  OVERHEAD_BLOCKED: 'overhead_blocked',
  HAZARD: 'hazard',
  SUBMERGED: 'submerged',
};

const REASON_LABELS = {
  [REASON.UNLOADED]: 'chunk unloaded',
  [REASON.NO_FLOOR]: 'no floor in range',
  [REASON.TOO_UNEVEN]: 'ground too uneven',
  [REASON.UNSTEPPABLE]: 'a cliff inside the box (adjacent cells too far apart to step)',
  [REASON.OVERHEAD_BLOCKED]: 'not enough clear space above',
  [REASON.HAZARD]: 'lava in the box',
  [REASON.SUBMERGED]: 'water in the box (would drown)',
};

// FLATNESS — the two ways of asking "is this ground level enough to stand and move on", and they are
// different QUESTIONS, not a strict and a lax setting of one.
//
//   SPAN     — the whole footprint fits inside a band of maxVariance blocks (max − min ≤ cap). A GLOBAL
//              test: it says nothing about which cells are adjacent, because it does not need to — a
//              1-block band makes every pair steppable by construction.
//   STEPWISE — the footprint is centre-relative (every cell within ±maxVariance of the CENTRE) and every
//              pair of TOUCHING cells is within one step. A LOCAL test, and the two clauses are not
//              redundant: the centre bound caps the total relief at 2, the adjacency bound is what stops
//              those two extremes from touching. Dropping either admits terrain a body cannot cross.
//
// Adjacency counts DIAGONALS. A diagonal neighbour is a legal move, so a diagonal 2-block drop is as
// impassable as an orthogonal one, and 4-adjacency would certify a checkerboard of +1 and −1 as flat.
const FLATNESS = { SPAN: 'span', STEPWISE: 'stepwise' };

// The four half-neighbours: walking these from every cell visits each unordered 8-adjacent pair exactly
// once, so no pair is compared twice.
const ADJACENT_HALF = [[1, 0], [0, 1], [1, 1], [1, -1]];

// evaluateOpenBox — THE ARENA'S PREDICATE: a spawn location must drop a body onto ground, not a canopy,
// not somewhere it drowns, and not into a cramped pocket with no movement possibilities — a full
// size×size floor with height clearance above it.
//
// Every clause is a check below, in that order, and the order is deliberate: cheapest first, and the
// reason returned is the FIRST thing wrong, which is the most informative one to report.
//
//   onto ground        → floorNearest per cell, isGround (excludes canopy by construction)
//   not a canopy       → isGround
//   not drowning       → no water anywhere in the box
//   movement possible  → the full size×size floor AND height clear above it. This is what rules out the
//                        1×2 pocket: a cramped cave fails on the footprint, not on a separate test.
//   on the surface OR in a cave → sky is NOT required. floorNearest finds either.
//
// ── `occupancy` — WHICH OF THE TWO QUESTIONS THIS CALL IS ASKING (2026-09-10) ────────────────────────
// 'clearable' (default)  can a body stand here ONCE THE CREW HAS CLEARED THE CANOPY — the BUILD SITE
//                        question. Leaves and logs overhead are room the build will make, so
//                        `isPassable` counts them as passable and that is correct here.
// 'as-is'                can a body stand here RIGHT NOW, with nothing cleared first — the BODY
//                        PLACEMENT question. Nothing clears a leaf before a body is teleported into it.
//
// THE TWO ARE NOT INTERCHANGEABLE AND CONFLATING THEM COST A RUN. `standingSpotNear` placed a body at
// (-6,63,-3) with `oak_leaves` at head height on 2026-09-10: the headroom clause read `isPassable`,
// `CLEARABLE` contains `oak_leaves`, so the cell passed. A* then expanded ZERO nodes from that start on
// every one of 150 attempts — near goals and far alike — because a body needs two clear cells and the
// head cell was solid. The bot never moved from spawn, the tree feller found no reachable tree among 82
// it could plainly SEE, and the judge killed the signal at 1m21s. `architect_bugsquashing.md` §14.
//
// 'as-is' DELEGATES TO `pathfinding_utils.isBlockPassable` RATHER THAN DEFINING A SECOND ANSWER — that
// is the whole point (Law 16). It is exported for exactly this reuse, and its own export comment names
// the hazard: a copied membership set drifts silently, and a copy that disagrees about passability
// "plans routes through walls". Here the disagreement placed a body somewhere no route could start.
//
// opts: { size=3, height=3, maxVariance=1, flatness='span', maxStep=1, refY, occupancy='clearable' }
// Returns { valid, spawnY, floorY, reason, detail, sky, floorNames }.
function evaluateOpenBox(reader, cx, cz, refY, opts = {}) {
  const size = opts.size || 3;
  const height = opts.height || 3;
  // Required at call time rather than at module scope: this file is loaded by the workshop's benches and
  // by the arena, and pathfinding_utils pulls the movement stack in behind it.
  const clearFor = opts.occupancy === 'as-is'
    ? require('@utils/pathfinding_utils').isBlockPassable
    : isPassable;
  const maxVariance = opts.maxVariance != null ? opts.maxVariance : 1;
  const flatness = opts.flatness || FLATNESS.SPAN;
  const maxStep = opts.maxStep != null ? opts.maxStep : 1;
  const half = Math.floor(size / 2);

  let minY = Infinity, maxY = -Infinity, centerFloor = null;
  const floors = [];
  const floorNames = {};

  for (let dx = -half; dx <= half; dx++) {
    for (let dz = -half; dz <= half; dz++) {
      const x = cx + dx, z = cz + dz;
      const f = floorNearest(reader, x, z, refY);
      if (f === null) {
        // Unloaded and "no floor within 64 blocks" are different failures and must not share a reason:
        // the first resolves itself when chunks stream in, the second never does.
        const probe = reader.blockAt(x, refY, z);
        return { valid: false, reason: probe === null ? REASON.UNLOADED : REASON.NO_FLOOR, detail: `at (${x},${z})` };
      }
      // "not a canopy" — the arena's own clause, applied here rather than inside isGround so the live
      // fleet's siting is untouched by it. CLEARABLE already drops the enumerated logs and leaves; this
      // suffix test additionally catches wood types that list predates (pale_oak arrived in 1.21.4), and
      // it matters more here than for a build: a build FLATTENS its canopy, a dropped body falls through
      // it. Cheap to be stricter on the side where being wrong is a bad test result.
      if (isCanopy(f.name)) {
        return { valid: false, reason: REASON.NO_FLOOR, detail: `canopy (${f.name}) at (${x},${z})` };
      }
      floors.push({ x, z, dx, dz, y: f.y });
      floorNames[f.name] = (floorNames[f.name] || 0) + 1;
      if (f.y < minY) minY = f.y;
      if (f.y > maxY) maxY = f.y;
      if (dx === 0 && dz === 0) centerFloor = f.y;
    }
  }

  // Flatness. A body is dropped at the CENTRE, so the centre's floor is the spawn height; the flatness
  // rule is what guarantees the surrounding cells are usable movement room rather than a wall the body is
  // pressed against. Natural ground is never perfectly level and demanding that finds nothing — the two
  // modes differ only in HOW MUCH unevenness is still movement room (see FLATNESS above).
  const uneven = flatness === FLATNESS.STEPWISE
    ? checkStepwise(floors, centerFloor, maxVariance, maxStep, size)
    : (maxY - minY > maxVariance
      ? { reason: REASON.TOO_UNEVEN, detail: `Δ${maxY - minY} over ${size}×${size} (cap Δ${maxVariance})` }
      : null);
  if (uneven) return { valid: false, ...uneven, variance: maxY - minY };

  // Headroom, hazard and drowning, over EVERY floor cell — from that cell's OWN floor up to the highest
  // floor's clearance ceiling (maxY + height), so the box is clear both above the tallest cell and inside
  // the step over a lower one.
  //
  // Measuring from maxY alone left the cells BETWEEN a low floor and maxY unexamined. floorNearest
  // guarantees only that the cell above a floor is non-GROUND — which lava and water both satisfy — so
  // even at a span of 1 a lava sheet sitting directly on a low cell was never looked at, and STEPWISE's
  // span of 2 widens that to two cells. The shape that found it: a staircase whose low step carries lava
  // at head height, valid under the old measurement. Per-cell is strictly stricter.
  let sky = true;
  for (const cell of floors) {
    const above = columnAbove(reader, cell.x, cell.z, cell.y, maxY + height - cell.y);
    if (above === null) return { valid: false, reason: REASON.UNLOADED, detail: `above (${cell.x},${cell.z})` };
    for (let i = 0; i < above.length; i++) {
      const b = above[i];
      if (isLava(b.name)) return { valid: false, reason: REASON.HAZARD, detail: `lava at (${cell.x},${cell.y + i + 1},${cell.z})` };
      if (isWater(b.name)) return { valid: false, reason: REASON.SUBMERGED, detail: `water at (${cell.x},${cell.y + i + 1},${cell.z})` };
      if (!clearFor(b)) return { valid: false, reason: REASON.OVERHEAD_BLOCKED, detail: `${b.name} at (${cell.x},${cell.y + i + 1},${cell.z})` };
    }
    // Lava directly beneath a floor cell disqualifies too: a body standing on a one-block crust over
    // lava is standing on a hazard, and the crust is exactly what a fight breaks.
    const below = reader.blockAt(cell.x, cell.y - 1, cell.z);
    if (below && isLava(below.name)) return { valid: false, reason: REASON.HAZARD, detail: `lava under (${cell.x},${cell.z})` };
    if (sky && !hasSkyAccess(reader, cell.x, cell.z, maxY + height)) sky = false;
  }

  return {
    valid: true,
    floorY: maxY,
    spawnY: centerFloor + 1,          // where a body's feet go — the summon/tp coordinate
    center: { x: cx, y: centerFloor + 1, z: cz },
    variance: maxY - minY,
    sky, floorNames,
  };
}

// checkStepwise — the loosened floor test, as two separate clauses. Returns a rejection or null.
//
//   the centre bound    — every cell's floor is within maxVariance of the centre floor
//   the adjacency bound — no two touching cells differ by more than maxStep (can't step a bigger gap)
//
// They reject DIFFERENTLY on purpose, and the reasons are distinct in REASON so a survey's rejection
// histogram says which of the two the terrain actually failed: TOO_UNEVEN means the ground rises or falls
// away from the centre faster than a body can follow, UNSTEPPABLE means the relief is within budget but
// arranged as a cliff. Fusing them into one "uneven" count would hide the fact that most natural terrain
// fails the first and almost none fails the second — the number that decides whether this mode is worth
// keeping (Law 6: the reason a decision was made must be recoverable).
function checkStepwise(floors, centerFloor, maxVariance, maxStep, size) {
  for (const c of floors) {
    if (Math.abs(c.y - centerFloor) > maxVariance) {
      return {
        reason: REASON.TOO_UNEVEN,
        detail: `(${c.x},${c.z}) is ${c.y - centerFloor > 0 ? '+' : ''}${c.y - centerFloor} from the centre floor over ${size}×${size} (cap ±${maxVariance})`,
      };
    }
  }
  const at = new Map(floors.map(c => [`${c.dx},${c.dz}`, c]));
  for (const c of floors) {
    for (const [ax, az] of ADJACENT_HALF) {
      const n = at.get(`${c.dx + ax},${c.dz + az}`);
      if (!n) continue;
      if (Math.abs(n.y - c.y) > maxStep) {
        return {
          reason: REASON.UNSTEPPABLE,
          detail: `(${c.x},${c.z})@y${c.y} touches (${n.x},${n.z})@y${n.y} — Δ${Math.abs(n.y - c.y)}, cannot step (max ${maxStep})`,
        };
      }
    }
  }
  return null;
}

// hasSkyAccess — is this column open to the sky above `fromY`? Not a validity gate (a cave box is
// explicitly legal); it is how a found box gets LABELLED surface-vs-cave for the report.
function hasSkyAccess(reader, x, z, fromY, scanUp = SCAN_UP) {
  for (let y = fromY + 1; y <= fromY + scanUp; y++) {
    const b = reader.blockAt(x, y, z);
    if (b === null) return false;
    if (isGround(b)) return false;
  }
  return true;
}

// ── Part 3: the expanding ring ──────────────────────────────────────────────────────────────────────

// enumerateRing — the (x,z) cells on the perimeter of a square annulus at Chebyshev radius r, stepping
// by `step`. Walking r = 0, step, 2·step… visits the world nearest-first, so the FIRST valid cell found
// is the closest one. Corners are emitted once (the vertical edges skip the rows the horizontal ones
// already covered). Transcribed from find_buildingspot, which is now a caller rather than an owner.
function enumerateRing(cx, cz, r, step) {
  if (r === 0) return [{ x: cx, z: cz }];
  const cells = [];
  for (let dx = -r; dx <= r; dx += step) { cells.push({ x: cx + dx, z: cz - r }, { x: cx + dx, z: cz + r }); }
  for (let dz = -r + step; dz <= r - step; dz += step) { cells.push({ x: cx - r, z: cz + dz }, { x: cx + r, z: cz + dz }); }
  return cells;
}

const UNLOADED_RING_STOP = 2;   // consecutive all-unloaded rings ⇒ the loaded frontier

// ringScan — the sweep, with the caller's predicate injected.
//
// Two terminators, both self-sizing, exactly as find_buildingspot established them:
//   • settled — the ring radius reached the best match's distance, so no unscanned cell can be nearer
//               (the Dijkstra pop-the-nearest guarantee);
//   • frontier — UNLOADED_RING_STOP whole rings were entirely unloaded: past the edge of what the
//                server has streamed in, nothing left to see without moving. The loaded area is finite,
//                so this always arrives on a no-match sweep and it is the sole terminator.
//
// `maxRadius` is a caller-supplied SAFETY stop, defaulted off (Infinity) so it cannot quietly become a
// fixed numeric cap on the search radius. When a caller sets one it is reported in the result, so a
// bounded sweep can never be mistaken for an exhausted one (Law 25).
//
// opts: { origin:{x,z}, step, minRadius, maxRadius, pace, all }
//   all=false (default) — return the single nearest match
//   all=true            — collect every match, letting the caller pick (the arena wants EVERY opponent
//                          box in a distance band, not just the closest)
//   minRadius           — skip the inner rings entirely rather than evaluating and discarding them. The
//                          arena's second question is "at 10–15 blocks", and a footprint test is the
//                          expensive part of a sweep — filtering after paying for it would cost the
//                          whole inner disc for nothing.
async function ringScan(reader, opts, evaluate) {
  const { origin, step = 2, minRadius = 0, maxRadius = Infinity, pace, all = false, accept } = opts;
  const rejections = {};
  const matches = [];
  let best = null, checked = 0, reachedRadius = 0, consecutiveUnloaded = 0;

  // Start on a ring boundary at or below minRadius so the band's inner edge is never clipped by the
  // stride: a cell at exactly minRadius must be reachable.
  const startR = minRadius > 0 ? Math.max(0, Math.floor(minRadius / step) * step) : 0;
  for (let r = startR; r <= maxRadius; r += step) {
    let ringAllUnloaded = true;
    for (const { x, z } of enumerateRing(origin.x, origin.z, r, step)) {
      checked++;
      if (pace) await pace();

      // Awaited so a caller's predicate may itself be a paced sweep. The arena needs exactly that: its
      // anchor test is "is there an open box here AND a partner box with a sightline", and the partner
      // half is a second ringScan. A synchronous-only predicate would force that composition to be
      // rebuilt outside this function, which is the copy this module exists to prevent.
      const res = await evaluate(x, z);
      if (res && res.reason !== REASON.UNLOADED) ringAllUnloaded = false;

      if (!res || !res.valid) {
        const reason = (res && res.reason) || REASON.UNLOADED;
        rejections[reason] = (rejections[reason] || 0) + 1;
        continue;
      }
      const distance = Math.hypot(x - origin.x, z - origin.z);
      // `accept` is a second, distance-aware gate the footprint test cannot express — the arena uses it
      // to demand an opponent box at a particular range with a particular sightline. Kept separate from
      // `evaluate` so the cheap geometry runs first and the expensive raycast only ever sees a box that
      // already exists.
      if (accept && !accept({ x, z, distance, result: res })) { rejections.rejected_by_caller = (rejections.rejected_by_caller || 0) + 1; continue; }

      const match = { x, z, distance, result: res };
      if (all) matches.push(match);
      else if (!best || distance < best.distance) best = match;
    }
    reachedRadius = r;
    if (!all && best && r >= best.distance) break;              // settled — nothing farther can beat it
    consecutiveUnloaded = (r > 0 && ringAllUnloaded) ? consecutiveUnloaded + 1 : 0;
    if (consecutiveUnloaded >= UNLOADED_RING_STOP) break;       // loaded frontier
  }

  return {
    found: all ? matches.length > 0 : !!best,
    best, matches, checked, reachedRadius, rejections,
    bounded: Number.isFinite(maxRadius) ? maxRadius : null,
  };
}

// formatRejections — one sorted, human-labelled clause list, zero-count reasons dropped. Shaped by what
// actually happened this sweep rather than a fixed enumeration (find_buildingspot's own convention).
function formatRejections(rejections) {
  const entries = Object.entries(rejections)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${REASON_LABELS[reason] || reason.replace(/_/g, ' ')}`);
  return entries.length ? entries.join('; ') : 'none';
}

// ── WHERE CAN ONE BODY STAND, NEAR HERE? ────────────────────────────────────────────────────────────
//
// THE ASK (Architect 2026-09-10): *"the architect needs to be teleported to a valid standing spot…
// the foreman shouldnt spawn the bot if there is no valid teleport spot available next to the human. the
// whole thing should be refused before a bot is even spawned."*
//
// Two callers, one question, so one function (Law 16). The desk asks it about the PERSON'S cell before it
// launches anything; the test harness asks it about its faux person's cell before it stands them up. Both
// were about to grow their own version, and two versions of "can a body stand here" is exactly how a
// refusal and a placement end up disagreeing about the same ground.
//
// IT IS `evaluateOpenBox` AT BODY SCALE AND NOTHING ELSE — `size: 1, height: 2` is one column, two cells
// of headroom, which is a player. Every clause that makes the box test worth trusting comes free and is
// NOT restated here: no canopy to fall through, no lava above or beneath, no water to drown in, no
// blocked overhead, a real floor rather than an unloaded chunk. The 3×3 base-siting call and this one are
// the same code reading the same world with different dials, which is the property that lets the desk's
// refusal and the body's arrival mean the same thing.
//
// FLATNESS IS IRRELEVANT AT SIZE 1 and is left at its default deliberately rather than passed: one column
// has no unevenness to measure, so naming a flatness here would be a dial with no effect — and a dial
// with no effect is read by the next person as a dial that matters.
//
// ORIGIN FIRST, THEN OUTWARD. `ringScan` starts at radius 0, so a person standing on perfectly good
// ground gets their own cell back and nothing moves. The search only widens when where they stand will
// not hold a body, and `maxRadius` bounds how far "next to the human" is allowed to mean — a spot 40
// blocks away is not next to them, and returning one would be the drift this refusal exists to prevent.
//
// THE SHORTFALL IS NAMED, NEVER GUESSED AT (Law 25 / Law 13). A failure returns `why` built from the
// sweep's own rejection tally — "12 submerged; 4 no floor" — because "no valid spot" is unactionable and
// "you are standing in water" tells a person to walk up the beach. `radius` is the asker's number and
// travels in; this function does not own how close is close enough.
// ── EVERY CALLER OF THIS FUNCTION IS PLACING A BODY, SO IT ASKS THE BODY QUESTION (2026-09-10) ───────
// Both of them — `proxy_human.standOnGround` and the desk's crew placement in `foreman.js` — teleport a
// body to the cell this returns, and neither clears anything first. So `occupancy: 'as-is'` is not an
// option this function offers its callers; it is what this function MEANS, and it is set here so no
// caller can forget it (Law 16 — the guarantee cannot be left to the accident of who passes what).
// See `evaluateOpenBox`'s `occupancy` note for the run this cost.
async function standingSpotNear(reader, origin, { radius = 8, step = 1 } = {}) {
  const scan = await ringScan(reader, { origin, step, maxRadius: radius },
    (x, z) => evaluateOpenBox(reader, x, z, origin.y, { size: 1, height: 2, occupancy: 'as-is' }));
  if (!scan.found) {
    return {
      found: false, cell: null, distance: null, scan,
      why: `no cell within ${radius} block(s) of (${origin.x},${origin.y},${origin.z}) will hold a `
        + `standing body — ${formatRejections(scan.rejections)} across ${scan.checked} cell(s) checked`,
    };
  }
  const m = scan.best;
  return {
    found: true,
    cell: { x: m.x, y: m.result.spawnY, z: m.z },
    distance: m.distance,
    scan,
    why: null,
  };
}

module.exports = {
  CLEARABLE, REASON, REASON_LABELS, FLATNESS, SCAN_UP, SCAN_DOWN,
  isAir, isWater, isLava, isCanopy, isStone, isGround, isPassable,
  surfaceY, floorNearest, columnAbove, hasSkyAccess,
  evaluateOpenBox, enumerateRing, ringScan, formatRejections,
  standingSpotNear,
};
