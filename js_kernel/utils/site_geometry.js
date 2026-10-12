// site_geometry — the site-scan system shared by find_buildingspot and the arena: a column read, a
// footprint test (per caller's own predicate), and an expanding ring sweep (nearest match first).
//
// World reads go through reader = { blockAt(x, y, z) → { name, boundingBox } | null }, so this file has
// no bot/vec3 dependency; each caller adapts its own reader. null means UNLOADED, never air (Law 23) —
// every function here refuses to answer for an unseen chunk.

'use strict';

// ── Block vocabulary ────────────────────────────────────────────────────────────────────────────────
// Wood-type membership matches by suffix (`_log`/`_leaves`), so a new biome's wood needs no update here.

const AIR = new Set(['air', 'cave_air', 'void_air']);
const WATER = new Set(['water', 'bubble_column']);
const LAVA = new Set(['lava']);

// CLEARABLE — what may sit above a floor without counting as the floor: air, and vegetation a
// preconstruction pass clears for free. Anything else is solid terrain.
//
// building_site_overlays re-exports this set (Law 16); it lives here because that module reaches the
// watcher and @perception, which an observer tool cannot import.
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
  // forest-floor flora — clutter, not floor
  'leaf_litter', 'wildflowers', 'pink_petals', 'bush', 'firefly_bush', 'cactus_flower',
  'short_dry_grass', 'tall_dry_grass',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'sunflower', 'lilac', 'rose_bush', 'peony',
  'dead_bush', 'vine', 'hanging_roots', 'spore_blossom',
  // full-block box on the trunk; without it a pod reads as ground
  'cocoa',
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

// isGround — is this block terrain: a solid bounding box, and not in CLEARABLE. Canopy is excluded only
// in evaluateOpenBox (the arena's own requirement), so it cannot retune where the live fleet sites its base.
function isGround(block) {
  if (!block || !block.name) return false;
  const n = block.name;
  if (isAir(n) || isWater(n) || isLava(n)) return false;
  if (CLEARABLE.has(n)) return false;
  return block.boundingBox === 'block';
}

// isPassable — can a body occupy this cell? Water counts as passable; drowning is a separate check owned by the caller.
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

// surfaceY — the topmost ground in a column, for a surface build. Returns { y, name } or null (unloaded,
// or no ground in the scan window).
function surfaceY(reader, x, z, refY, scanUp = SCAN_UP, scanDown = SCAN_DOWN) {
  for (let y = refY + scanUp; y >= refY - scanDown; y--) {
    const b = reader.blockAt(x, y, z);
    if (b === null) return null;
    if (isGround(b)) return { y, name: b.name };
  }
  return null;
}

// floorNearest — the floor nearest the observer's own level: a column can hold several (a cave's roof
// and its true floor), and topmost-first would read the roof as ground, missing every cave spawn.
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

// columnAbove — the blocks over a floor, to `height` cells; raw material for a caller's own safety check.
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

// REASON — enumerated rejection codes so every caller's post-mortem speaks one vocabulary.
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

// FLATNESS — two different flatness questions, not a strict/lax pair.
//   SPAN     — the whole footprint fits within a maxVariance band (global).
//   STEPWISE — every cell within maxVariance of the centre AND every touching pair within maxStep of
//              each other (local; diagonals count, since a diagonal neighbour is a legal move).
const FLATNESS = { SPAN: 'span', STEPWISE: 'stepwise' };

// the four half-neighbours: visits each unordered 8-adjacent pair exactly once
const ADJACENT_HALF = [[1, 0], [0, 1], [1, 1], [1, -1]];

// evaluateOpenBox — the arena's predicate: does a size×size floor exist here, flat enough, ground rather
// than canopy, dry, with `height` clearance above. Checks run cheapest-first; the returned reason is the
// first one that failed.
//
// `occupancy`: 'clearable' (default) — can stand once the canopy is cleared (build-site question).
//              'as-is' — can stand right now, nothing cleared (body-placement question); delegates to
//              `pathfinding_utils.isBlockPassable`, the one passability membership set (Law 16).
//
// opts: { size=3, height=3, maxVariance=1, flatness='span', maxStep=1, refY, occupancy='clearable' }
// Returns { valid, spawnY, floorY, reason, detail, sky, floorNames }.
function evaluateOpenBox(reader, cx, cz, refY, opts = {}) {
  const size = opts.size || 3;
  const height = opts.height || 3;
  // loaded lazily: benches that use this file don't all want the movement stack pulled in behind it
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
        // unloaded resolves itself as chunks stream in; "no floor" never does — different reasons
        const probe = reader.blockAt(x, refY, z);
        return { valid: false, reason: probe === null ? REASON.UNLOADED : REASON.NO_FLOOR, detail: `at (${x},${z})` };
      }
      // the arena's own "not a canopy" clause, catching wood-type suffixes CLEARABLE predates
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

  // a body drops at the centre; flatness guarantees the surrounding cells are movement room, not a wall
  const uneven = flatness === FLATNESS.STEPWISE
    ? checkStepwise(floors, centerFloor, maxVariance, maxStep, size)
    : (maxY - minY > maxVariance
      ? { reason: REASON.TOO_UNEVEN, detail: `Δ${maxY - minY} over ${size}×${size} (cap Δ${maxVariance})` }
      : null);
  if (uneven) return { valid: false, ...uneven, variance: maxY - minY };

  // headroom/hazard/drowning, checked per floor cell up to the highest floor's clearance ceiling — a low
  // cell's headroom is checked directly, not inferred from the tallest cell alone
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
    // a one-block crust over lava is still standing on a hazard
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

// checkStepwise — the loosened floor test: the centre bound (every cell within maxVariance of the centre)
// and the adjacency bound (no touching pair differs by more than maxStep), returned as distinct reasons.
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

// hasSkyAccess — is this column open to the sky above `fromY`? Not a validity gate; labels a found box surface-vs-cave.
function hasSkyAccess(reader, x, z, fromY, scanUp = SCAN_UP) {
  for (let y = fromY + 1; y <= fromY + scanUp; y++) {
    const b = reader.blockAt(x, y, z);
    if (b === null) return false;
    if (isGround(b)) return false;
  }
  return true;
}

// ── Part 3: the expanding ring ──────────────────────────────────────────────────────────────────────

// enumerateRing — the (x,z) cells on a square annulus's perimeter at radius r; nearest-first when walked
// r=0, step, 2·step… Corners emitted once.
function enumerateRing(cx, cz, r, step) {
  if (r === 0) return [{ x: cx, z: cz }];
  const cells = [];
  for (let dx = -r; dx <= r; dx += step) { cells.push({ x: cx + dx, z: cz - r }, { x: cx + dx, z: cz + r }); }
  for (let dz = -r + step; dz <= r - step; dz += step) { cells.push({ x: cx - r, z: cz + dz }, { x: cx + r, z: cz + dz }); }
  return cells;
}

const UNLOADED_RING_STOP = 2;   // consecutive all-unloaded rings ⇒ the loaded frontier

// ringScan — the sweep, with the caller's predicate injected.
// Two terminators: settled (ring radius reached the best match's distance) or frontier
// (UNLOADED_RING_STOP consecutive rings entirely unloaded).
// `maxRadius` is a caller-supplied safety stop, off by default (Infinity), reported when bounded (Law 25).
// opts: { origin:{x,z}, step, minRadius, maxRadius, pace, all }
//   all=false (default) — nearest match only; all=true — every match
//   minRadius           — inner rings are skipped, not evaluated and discarded
async function ringScan(reader, opts, evaluate) {
  const { origin, step = 2, minRadius = 0, maxRadius = Infinity, pace, all = false, accept } = opts;
  const rejections = {};
  const matches = [];
  let best = null, checked = 0, reachedRadius = 0, consecutiveUnloaded = 0;

  // start on a ring boundary at or below minRadius so the band's inner edge is never clipped by the stride
  const startR = minRadius > 0 ? Math.max(0, Math.floor(minRadius / step) * step) : 0;
  for (let r = startR; r <= maxRadius; r += step) {
    let ringAllUnloaded = true;
    for (const { x, z } of enumerateRing(origin.x, origin.z, r, step)) {
      checked++;
      if (pace) await pace();

      // awaited so the predicate may itself be a paced sweep (the arena nests ringScan as its partner-box test)
      const res = await evaluate(x, z);
      if (res && res.reason !== REASON.UNLOADED) ringAllUnloaded = false;

      if (!res || !res.valid) {
        const reason = (res && res.reason) || REASON.UNLOADED;
        rejections[reason] = (rejections[reason] || 0) + 1;
        continue;
      }
      const distance = Math.hypot(x - origin.x, z - origin.z);
      // `accept` is a distance-aware gate `evaluate` can't express, run only after the cheap geometry passes
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

// formatRejections — one sorted, human-labelled clause list; zero-count reasons dropped.
function formatRejections(rejections) {
  const entries = Object.entries(rejections)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${REASON_LABELS[reason] || reason.replace(/_/g, ' ')}`);
  return entries.length ? entries.join('; ') : 'none';
}

// ── where can one body stand, near here? ────────────────────────────────────────────────────────────
// standingSpotNear — the desk's crew placement and the test harness's faux-person placement both need
// this, so it is one function serving both (Law 16).
//
// It is `evaluateOpenBox` at body scale (size 1, height 2); flatness stays at default since one column
// has no unevenness to measure. Every caller teleports a body here without clearing anything first, so
// `occupancy` is fixed to 'as-is' (Law 16).
//
// `ringScan` starts at radius 0, so good ground under the origin is returned as-is; `maxRadius` bounds
// how far "near" means. A failure names its shortfall from the sweep's rejection tally (Law 25 / Law 13).
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
