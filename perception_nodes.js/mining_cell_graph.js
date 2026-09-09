// perception node: mining_cell_graph
//
// PURPOSE (Law 14): owns the whole fractal-cell lifecycle in one place (Law 16) —
//   the cell counterpart to mining_blueprinter + mining_integrity:
//     - GEOMETRY: where cells sit (4-apart, shared walls), free 4-directional growth
//       fenced only by the staircase-collision guard, and how a staircase side-attach
//       seeds each floor's prime cell.
//     - SCAN (scanCell): is this 5×5×5 + 7×7 margin safe to carve? Binary safety —
//       fluids and gravel→fluid conduits only (cave voids are fine), unloaded → defer.
//     - GENERATION (generateCell): place the underground_cell blueprint at an anchor.
//     - PERSISTENCE: the registered cells live in HQ mining_confrence_room (Law 6).
//     - SELECTION (selectNextCell): the lowest-ring buildable incomplete cell, ringed
//       out of each floor's prime (even multi-floor fan; multibot-safe via excludeIds).
//
//   WHY a separate module (not folded into mining_integrity): cells are SELECTED by
//   ring distance from each floor's prime (D6), a different ordering than the shaft's
//   depth-major priority. Keeping cells out of mining_integrity.scan() lets that node
//   answer exactly one question ("is the shaft done?") while this node owns cell
//   selection and per-cell diffing (via mining_integrity.scanSegmentSteps).
//
// Multibot is designed-for but out of scope: the HQ record already carries id +
// complete, so per-anchor claiming bolts on later (Law: shaped for the future, built
// for now).

const { Vec3 } = require('vec3');
const watcher  = require('@kernel/watcher');
const hq       = require('@kernel/corporate_headquarters');
const { placeVoxelsAt, makeSegmentId, generateStaircase, loadBuildings, staircaseSideAttaches } = require('@perception/mining_blueprinter');
const { followGravityColumn, isFluid, isGravityBlock } = require('@utils/gravity_utils');

const CELL_BLUEPRINT_NAME = 'underground_cell';

// ── Geometry constants ───────────────────────────────────────────────────────
const CELL_SPACING  = 4;   // center-to-center; cells share a single wall (4 apart, not 5)
const CELL_HALF     = 2;   // 5×5×5 cube → half-extent 2
const CELL_Y_MIN    = 0;   // anchor.y is the floor; cell spans anchor.y .. anchor.y+4
const CELL_Y_MAX    = 4;
const GRAVITY_MARGIN = 1;  // 5×5 cell + 1 ring per side = 7×7 gravity/fluid margin (D8)
// The hazard scan also reaches this many blocks BELOW the floor. A bot descends toward a cell
// along the shaft-side approach, and water sitting just under the floor floods the instant the
// floor is pierced — that water sits outside a floor-and-up-only box, so scanning only at/above
// the floor could report a cell safe and still flood the staircase. Matches the 7×7 side ring, so
// the scanned volume is the cell + margin "below and around" the approach, not just at/above the floor.
const APPROACH_DEPTH = 3;

// World direction unit vectors. Convention: north=-z, south=+z, east=+x, west=-x.
const DIR_VEC = {
  north: { x: 0, z: -1 }, south: { x: 0, z: 1 },
  east:  { x: 1, z: 0 },  west:  { x: -1, z: 0 },
};
const CARDINALS = ['north', 'south', 'east', 'west'];

// A cell floored here brackets the iron peak (y≈16): a 5-tall cell (floor..floor+4) at 14
// spans body 14..18. Prime floor per site; the below/above floors fall out as every-other
// staircase copy (6 apart) bracketing it.
const STRADDLE_FLOOR_Y = 14;

const ROOM        = 'mining_confrence_room';
const CELLS_FLAG  = 'cells';

function isAirName(name) {
  return name === null || name === undefined || name === 'air' || name === 'cave_air' || name === 'void_air';
}

// DELETED 2026-08-15: `cellId(anchor)` — a one-line alias for `makeSegmentId`. No caller. A second name
// for one function is a second route to it (Law 16), and an alias is the cheapest kind to leave lying
// around: it costs nothing to keep and silently doubles the vocabulary a successor has to learn.

// ── HQ persistence (Phase 2.1) ───────────────────────────────────────────────
// Cells live as a map keyed by id ("x|y|z"). Each record: { id, anchor:{x,y,z},
// complete:bool, fan:'north'|'south'|'east'|'west', blocked?:haltReason }.
function readCells() {
  const cells = hq.readConfRoomFlag(ROOM, CELLS_FLAG, {});
  return (cells && typeof cells === 'object' && !Array.isArray(cells)) ? cells : {};
}
function writeCells(cells) { hq.writeConfRoomFlag(ROOM, CELLS_FLAG, cells); }
function getCell(id) { return readCells()[id] || null; }
function markCellComplete(id) {
  const cells = readCells();
  // Clear the remaining tracker on completion so a later MAINTENANCE re-pass (damage found in
  // an already-complete cell) starts its shrink/stuck comparison from a clean slate (∞), not a
  // stale growth-era count that could false-flag the first repair pass as stuck.
  if (cells[id]) { cells[id].complete = true; delete cells[id].remaining; writeCells(cells); }
}
// markCellBlocked — record a hazard verdict on an already-registered cell so selection
// skips it permanently (it is not re-scanned every pass). Used when a fresh scanCell at
// dispatch time reveals a hazard that wasn't present (or wasn't loaded) at registration.
function markCellBlocked(id, reason) {
  const cells = readCells();
  if (cells[id]) { cells[id].blocked = reason; writeCells(cells); }
}

// recordCellRemaining — stamp a cell's latest post-pass diff count and return the PREVIOUS
// one. This is the shaft's built-when-clean model applied to cells: completion is decided by
// the integrity DIFF (0 steps left = done), and a cell that re-passes without the count
// shrinking is stuck (a voxel no reachable stand can carve — Law 13), NOT complete. The old
// "no progress ⇒ complete" heuristic conflated "already carved" with "couldn't reach it" and
// so registered un-carved cells complete. First call sees Infinity → the first pass always
// counts as shrinking, so a fresh cell is never blocked on pass one.
function recordCellRemaining(id, remaining) {
  const cells = readCells();
  const prev = cells[id] ? (cells[id].remaining ?? Infinity) : Infinity;
  if (cells[id]) { cells[id].remaining = remaining; writeCells(cells); }
  return prev;
}

// getDeepestSegmentMarkers — seed one prime cell per iron-band floor off the staircase's
// side attaches (C/D). Floors are DERIVED from the locked descent, never hardcoded: the
// staircase's 3-Y side-attach steps land at a phase that depends on surface Y, so pick the
// dug copy whose cell floor best straddles the iron peak (STRADDLE_FLOOR_Y) as prime, then
// take every-other copy bracketing it (6 apart → non-overlapping 5-tall cells) as the
// below/straddle/above floors. Each floor emits two markers (its C south seed + D north seed),
// each that floor's ring origin (prime) — registerNeighbors grows the rest.
//
// Progressive lighting (Law 13): a floor is seeded ONLY once its staircase copy is dug (built
// registry). Seeding a floor whose copy is still solid rock would register a cell walled in on
// all sides — not "unloaded", so it would path toward it and fail. job_board only posts dig_cell
// once the whole descent is excavated, so in practice all target floors light together.
function getDeepestSegmentMarkers() {
  // NO GUARD ON THE STAIRCASE GENERATOR, HERE OR BELOW IN THIS FILE. It is ours, and answering `[]` on a
  // throw reads downstream as "no floors to seed" — the cell graph then grows nothing and reports a
  // quiet, plausible nothing for the rest of the run (Law 13; Law 25 — a default is not a measurement).
  const plan = generateStaircase();
  const sideAttaches = staircaseSideAttaches();
  const segments = plan.staircase_segments || [];
  if (!segments.length || !sideAttaches.length) return [];

  const built = hq.readConfRoomFlag(ROOM, 'built_segments', {}) || {};
  const attachYOffset = sideAttaches[0].rel[1];           // side attaches share y = −2 (cell floor)
  const floorY = (seg) => seg.world_position.y + attachYOffset;

  // Prime = copy whose cell floor is nearest the straddle floor (geometric anchor across ALL
  // copies; the built gate below decides which of the bracketing floors actually emit).
  let primeIdx = -1, best = Infinity;
  segments.forEach((seg, i) => {
    const d = Math.abs(floorY(seg) - STRADDLE_FLOOR_Y);
    if (d < best) { best = d; primeIdx = i; }
  });
  const floorIdxs = [primeIdx - 2, primeIdx, primeIdx + 2].filter(i => i >= 0 && i < segments.length);

  const markers = [];
  for (const i of floorIdxs) {
    const seg = segments[i];
    if (!built[seg.id]) continue;
    const o = seg.world_position;
    for (const s of sideAttaches) {
      markers.push({ world: [o.x + s.rel[0], o.y + s.rel[1], o.z + s.rel[2]], outward: s.outward });
    }
  }
  return markers;
}

// staircaseDeclarations — every world voxel the staircase claims, mapped to the TYPE(s) it
// claims there ("x,y,z" → ['structural_fill', ...]). Types, not bare keys: overlapsStaircase
// has to tell "shares a wall" from "grows into the shaft", and only the declared type separates
// them. An array per key because staircase segments overlap each other, so one voxel can carry
// two segments' opinions.
// Empty on any generation failure (no lock yet) → guard is a no-op, which is correct pre-lock,
// but it is NOT silent (Law 16: no `catch (_) {}`); a guard that quietly passes everything is
// how an unbuildable cell gets registered as buildable with nothing on disk to say why.
function staircaseDeclarations() {
  const map = new Map();
  const plan = generateStaircase();
  for (const seg of plan.staircase_segments) {
    for (const v of seg.voxels) {
      const k = `${v[0]},${v[1]},${v[2]}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(v[3]);
    }
  }
  return map;
}

// Does a cell at `anchor` CONTRADICT the staircase?
//
// Not "do they intersect" — they are DESIGNED to intersect. The side-attach marker sits IN the
// staircase's wall plane, so a correctly-seeded cell shares that whole wall, and the staircase
// blueprint carries a door-sized hole in it exactly where the cell's door lands. Sharing a wall
// is the design — "equal attaching on all sides", same as two adjacent cells at CELL_SPACING.
//
// The real fault is a DISAGREEMENT: one blueprint wants air where the other wants solid. That is
// a cell body grown into the shaft, and it is unbuildable — whoever passes last wins and the other
// re-flags it forever. So the predicate is contradiction, not intersection.
//
// The wrong turn to avoid: keying on intersection instead of contradiction. A shared wall IS an
// intersection, so that predicate blackballs every correctly-seeded cell and leaves zero
// buildable cells even though seeding is working correctly.
function overlapsStaircase(anchor, stairDecls) {
  if (!stairDecls || stairDecls.size === 0) return false;
  for (const v of generateCell(anchor).voxels) {
    const stairTypes = stairDecls.get(`${v[0]},${v[1]},${v[2]}`);
    if (!stairTypes) continue;                       // staircase has no opinion → cell owns it alone
    const all = [v[3], ...stairTypes];
    if (all.some(isAirName) && all.some(t => !isAirName(t))) return true;
  }
  return false;
}

// ── scanCell (Phase 3) ───────────────────────────────────────────────────────
// Walk the 5×5×5 cell plus a 7×7 gravity/fluid margin and decide whether it is safe to
// carve. Safety is BINARY: the only hard rejects are a fluid anywhere
// in the footprint (lava/water) or a gravel-to-fluid conduit (D13). Cave voids are FINE —
// a cell bordering open air just builds its walls into it (more blocks, still safe), so
// there is no void threshold. An unloaded chunk → defer (Law 13 environmental, NOT a
// reject). Small wall breaches are resealed by mining_integrity's wall_breach fill (Law 16,
// one pathway), so picket_voxels is intentionally always empty.
function scanCell(bot, anchor) {
  const gMargin = CELL_HALF + GRAVITY_MARGIN; // 3 → 7×7

  // ── THE SPAWN-PROTECTED SQUARE ───────────────────────────────────────────────────────────────────
  // A HARD REJECT, alongside fluid and the gravity conduit, and for the same reason those two are hard:
  // the cell cannot be carved at all. Every block of the 5×5×5 body would have to be broken, and inside
  // the square none of them can be — so this is not a cell that is expensive or awkward, it is a cell
  // that does not exist for this fleet.
  //
  // NOT a 'defer' like `unloaded`. An unloaded chunk is a fact about what the client has streamed in and
  // resolves by waiting; this resolves by never. Marking it deferred would put the cell back in the
  // graph every sweep and re-scan it forever (Law 13 — the two categories have different answers).
  //
  // THE CELL BODY ONLY, not the gravity/fluid margin: the margin exists to sense what could flow or fall
  // INTO the carve, and sensing costs the world nothing. Only cells that get broken are gated.
  {
    const { firstSpawnProtectedCell } = require('@perception/spawn_protection');
    const body = [];
    for (let dx = -CELL_HALF; dx <= CELL_HALF; dx++) {
      for (let dz = -CELL_HALF; dz <= CELL_HALF; dz++) body.push({ x: anchor.x + dx, z: anchor.z + dz });
    }
    if (firstSpawnProtectedCell(bot, body)) {
      return { safe: false, halt_reason: 'spawn_protected', picket_voxels: [] };
    }
  }

  // From APPROACH_DEPTH below the floor up through the cell ceiling: water/lava under or around
  // the descent floods the carve, so it is scanned even though it sits outside the cell body.
  for (let dy = CELL_Y_MIN - APPROACH_DEPTH; dy <= CELL_Y_MAX; dy++) {
    for (let dx = -gMargin; dx <= gMargin; dx++) {
      for (let dz = -gMargin; dz <= gMargin; dz++) {
        const x = anchor.x + dx, y = anchor.y + dy, z = anchor.z + dz;
        // blockAt answers null for an unloaded column, which is the halt below — nothing to guard.
        const block = bot.blockAt(new Vec3(x, y, z));

        if (!block) {
          return { safe: false, halt_reason: 'unloaded', picket_voxels: [] };
        }
        if (isFluid(block.name)) {
          const reason = /lava/.test(block.name) ? 'lava' : 'water';
          return { safe: false, halt_reason: reason, picket_voxels: [] };
        }
        if (isGravityBlock(block.name) && followGravityColumn(bot, x, y, z) === 'CONDUIT') {
          return { safe: false, halt_reason: 'gravity_fluid_conduit', picket_voxels: [] };
        }
      }
    }
  }

  return { safe: true, halt_reason: 'none', picket_voxels: [] };
}

// ── generateCell (Phase 4) ───────────────────────────────────────────────────
// Place the underground_cell blueprint at a world anchor and return a segment object
// shaped like a shaft segment so mining_integrity.scanSegmentSteps + mining_executor's
// cell path consume it identically (Law 10 typed contract). Stale-data guard (D11):
// regenerating a cell that HQ already marks complete means corrupt/stale state — throw
// with the flush_system hint (Law 13 coding violation).
function generateCell(anchor) {
  const id = makeSegmentId(anchor);
  // NOTE: regenerating a COMPLETE cell is legitimate now — cell maintenance (the twin of
  // mining_integrity re-diffing built_segments) re-generates a finished cell's blueprint to
  // re-diff it against the world for damage. generateCell is pure computation (placeVoxelsAt is
  // arithmetic, touches no blocks), so this is side-effect-free. The old "complete ⇒ throw" stale-
  // state guard was written before maintenance existed and would now block the repair path.

  const buildings = loadBuildings();
  const cell = buildings[CELL_BLUEPRINT_NAME];
  if (!cell) {
    throw new Error(`[mining_cell_graph] CODING VIOLATION: blueprint "${CELL_BLUEPRINT_NAME}" not found in building_blueprints.json.`);
  }
  const placed = placeVoxelsAt(cell, anchor);
  return {
    id,
    type: 'cell',
    world_position: { x: anchor.x, y: anchor.y, z: anchor.z },
    anchors: [{ x: anchor.x, y: anchor.y, z: anchor.z }],
    voxel_count: placed.voxels.length,
    voxels: placed.voxels,
    summary: `cell ${id} @ (${anchor.x},${anchor.y},${anchor.z})`,
  };
}

// getProtectedBlocks — every SOLID voxel of every REGISTERED cell, as "x,y,z" world keys. The cell
// twin of mining_integrity.getProtectedBlocks() (staircase) and building_integrity's (buildings);
// the navigator merges all three. mining_cell_graph is the owner because it is the only module that
// knows a cell exists — cells are registered per-anchor in HQ, never listed in the staircase plan.
//
// WHY this exists: without it, mining_integrity.getProtectedBlocks() only walks the staircase
// segments — zero cells — so every cell wall is invisible to A*, which then prices digging through
// one as a cheap detour instead of a hard wall. The navigator carves a doorway through the cell
// wall on its way to the anchor, mining_executor re-seals it, and the cycle repeats forever.
// Nothing lied. mining_integrity said "wall", locomotion said "cheap doorway", both correctly — one
// voxel, two owners (Invariant D / Law 16). That is also why no judge could ever have caught it: a
// livelock built entirely out of true statements.
//
// Registered ⇒ protected, complete or not — the same rule the staircase already uses (all
// segments are protected whether dug yet or not). A planned-but-uncarved cell's walls are untouched
// rock, so protecting them costs a stricter route, never a wrong one; PROTECTED_VOXEL_DETOUR_BUDGET is finite, so a
// trapped bot still breaks out. generateCell is pure arithmetic and may throw only on a missing
// blueprint (Law 13 coding violation) — that is left to throw, and the navigator names the source in
// its warn rather than swallowing it into "nothing is protected".
function getProtectedBlocks() {
  const set = new Set();
  for (const rec of Object.values(readCells())) {
    if (!rec || !rec.anchor) continue;
    for (const v of generateCell(rec.anchor).voxels) {
      if (v[3] === 'air') continue;
      set.add(`${v[0]},${v[1]},${v[2]}`);
    }
  }
  return set.size > 0 ? set : null;
}

// ── Door verification (Phase 2.3) ────────────────────────────────────────────
// The shaft wall should be open (air) at the marker's door (marker.y+1 / +2) so the
// first cell connects to the shaft. Soft check: warn if it isn't — the cell carves its
// own door regardless, so this is diagnostic, not a gate.
function verifyShaftDoor(bot, markerWorld) {
  const [mx, my, mz] = markerWorld;
  const a = bot.blockAt(new Vec3(mx, my + 1, mz));
  const b = bot.blockAt(new Vec3(mx, my + 2, mz));
  if (a && b && !isAirName(a.name) && !isAirName(b.name)) {
    watcher.warn('mining_cell_graph', `Shaft door at (${mx},${my + 1}..${my + 2},${mz}) is not open (${a.name}/${b.name}) — first cell will carve its own opening.`);
  }
}

// ── Registration helpers ─────────────────────────────────────────────────────
// Scan an anchor and register a cell record if it isn't known yet. Returns the record,
// or null when the chunk is unloaded (defer — re-register on a later pass). Blocked
// cells are LEFT registered (with a `blocked` reason) so selection skips them and they
// are not re-scanned every pass (D6). A cell whose footprint hits the staircase is blocked
// 'staircase' up front (no world read needed) — this is the guard that replaced the CCW
// quadrant rule (Law 16). stairDecls is precomputed once by the caller and threaded in so a
// registration wave doesn't rebuild the staircase prism per anchor.
// `prime` is the origin this cell fans out from — the floor's staircase-segment prime cell.
// A seed IS its own prime (default param), and every neighbour inherits its parent's prime
// through registerNeighbors, so a whole fan shares one origin. Selection rings out of it
// (byRingFromPrime) — that is what makes growth an even fan from the prime instead of a line
// toward the shaft head.
function registerCellAt(bot, anchor, fan, stairDecls, prime = anchor) {
  const cells = readCells();
  const id = makeSegmentId(anchor);
  if (cells[id]) return cells[id];

  const primeXYZ = { x: prime.x, y: prime.y, z: prime.z };
  const stair = stairDecls || staircaseDeclarations();
  if (overlapsStaircase(anchor, stair)) {
    const record = { id, anchor: { x: anchor.x, y: anchor.y, z: anchor.z }, complete: false, fan, prime: primeXYZ, blocked: 'staircase' };
    cells[id] = record;
    writeCells(cells);
    return record;
  }

  const scan = scanCell(bot, anchor);
  if (scan.halt_reason === 'unloaded') return null;

  const record = { id, anchor: { x: anchor.x, y: anchor.y, z: anchor.z }, complete: false, fan, prime: primeXYZ };
  if (!scan.safe) record.blocked = scan.halt_reason;
  cells[id] = record;
  writeCells(cells);
  return record;
}

// seedCells (Phase 2.3) — register each floor's prime cell off its staircase side-attach
// marker. anchor = marker.world + CELL_HALF along outward, at marker.y (the cell floor).
//
// CELL_HALF, not CELL_SPACING. The marker is not a cell — it is a floor block sitting IN the
// staircase's wall plane, so the distance from it to the center of the cell that SHARES that wall
// is a half-extent (2), not the cell-to-cell pitch (4). registerNeighbors below is the caller that
// legitimately steps CELL_SPACING, because there both ends really are cell centers.
//
// The wrong turn to avoid: CELL_SPACING here. It reads right — 4 is "one cell over" — but it
// parks every cell one block off the shaft, leaving a gap of raw stone that NO blueprint declares
// between the staircase's door hole and the cell's door hole, so nothing ever carves it. Symptom
// to recognise: seeds register fine, scan safe, and the cell is still walled off from the shaft
// it hangs on.
function seedCells(bot) {
  const markers = getDeepestSegmentMarkers();
  const stairDecls = staircaseDeclarations();
  let seeded = 0;
  const scanStart = Date.now();   // each registerCellAt runs the ~392-voxel scanCell — report the sweep cost
  for (const m of markers) {
    const dir = DIR_VEC[m.outward];
    if (!dir) { watcher.warn('mining_cell_graph', `marker has unknown outward "${m.outward}" — skipped.`); continue; }
    const mw = m.world; // [x,y,z]
    verifyShaftDoor(bot, mw);
    const anchor = { x: mw[0] + dir.x * CELL_HALF, y: mw[1], z: mw[2] + dir.z * CELL_HALF };
    const rec = registerCellAt(bot, anchor, m.outward, stairDecls);
    if (rec && !rec.blocked) seeded++;
  }
  watcher.summary('mining_cell_graph', `Seeded ${markers.length} staircase side-attach marker(s); ${seeded} buildable seed cell(s) in ${Date.now() - scanStart}ms.`);
  return seeded;
}

// registerNeighbors (Phase 2.4) — on a cell's completion, register its buildable neighbours
// in ALL 4 cardinals (the ring frontier). The parent is already registered/complete so
// registerCellAt returns it unchanged (naturally skipped → the effective 3 outward
// directions). Growth toward the staircase is stopped by the staircase-collision guard in
// registerCellAt, not by a direction restriction (Law 16). Neighbours inherit the parent's
// fan (a tiebreak label) AND its prime (the ring origin they fan out from).
// Returns the count newly registered.
function registerNeighbors(bot, cellRecord) {
  const stairDecls = staircaseDeclarations();
  let added = 0;
  for (const d of CARDINALS) {
    const dir = DIR_VEC[d];
    const nAnchor = {
      x: cellRecord.anchor.x + dir.x * CELL_SPACING,
      y: cellRecord.anchor.y,
      z: cellRecord.anchor.z + dir.z * CELL_SPACING,
    };
    const before = !!getCell(makeSegmentId(nAnchor));
    // Inherit the parent's prime so the whole fan rings out of one origin (defensive fallback
    // to the parent's own anchor for any pre-migration record that predates the prime field).
    const rec = registerCellAt(bot, nAnchor, cellRecord.fan, stairDecls, cellRecord.prime || cellRecord.anchor);
    if (rec && !before && !rec.blocked) added++;
  }
  return added;
}

// byRingFromPrime — the even-fan ordering. Cost is the RING index out of each cell's own prime
// (Euclidean XZ / CELL_SPACING), NOT distance to the shaft head. Nearest ring first, so growth
// fills concentric rings around every floor's prime rather than marching in one direction toward
// the descent's top corner (the old byNearestToShaft bug — one far reference point + a fixed fan
// tiebreak collapsed the fan to a line). Because a prime's completion registers ALL of its ring-1
// neighbours at once, nearest-ring selection drains each fully-registered ring before advancing —
// so the lazy (completion-gated) frontier still yields clean rings with no eager pre-expansion.
//
// Ties resolve deterministically (Law 19): ring → fan → floor Y → X → Z. The ring is the PRIMARY
// key across ALL floors, so ring 1 fills on every floor before ring 2 — the multi-floor even fan.
// Shared by growth + maintenance. Multibot falls out for free: each bot takes the lowest-ring cell
// not held by a peer (excludeIds), so N bots spread across the ring frontier and across floors.
const FAN_TIEBREAK = { north: 0, east: 1, south: 2, west: 3 };
function ringFromPrime(c) {
  const p = c.prime || c.anchor;   // defensive: pre-migration records fan from their own anchor
  return Math.hypot(c.anchor.x - p.x, c.anchor.z - p.z) / CELL_SPACING;
}
function byRingFromPrime() {
  return (a, b) => {
    const ra = ringFromPrime(a), rb = ringFromPrime(b);
    if (Math.abs(ra - rb) > 0.01) return ra - rb;
    const fa = FAN_TIEBREAK[a.fan] ?? 9, fb = FAN_TIEBREAK[b.fan] ?? 9;
    if (fa !== fb) return fa - fb;
    if (a.anchor.y !== b.anchor.y) return a.anchor.y - b.anchor.y;
    if (a.anchor.x !== b.anchor.x) return a.anchor.x - b.anchor.x;
    return a.anchor.z - b.anchor.z;
  };
}

// selectMaintenanceCell — the cell twin of mining_integrity re-diffing built_segments: walk the
// COMPLETE cells (lowest-ring first) and re-diff each against the world; return the first that is
// DAMAGED (dirty diff), tagged maintenance:true, else null. This reuses mining_integrity's exact
// tactic and diff (scanSegmentSteps) — no new integrity code. Runs FIRST every selection (see
// selectNextCell): the bot can graze a finished cell's wall while carving the next one, so the
// built path is repaired before the frontier extends (Law 17). Cost is a 125-block re-diff per
// complete cell each sweep — the same all-built-each-scan cost the shaft pays. (Tunable later:
// round-robin one cell/sweep if the completed field grows large enough that it bites.)
function selectMaintenanceCell(bot, excludeIds = null) {
  if (!bot || !bot.blockAt) return null;
  const miningIntegrity = require('@perception/mining_integrity');
  const cells = readCells();
  const complete = Object.values(cells).filter(
    c => c.complete && !c.blocked && !(excludeIds && excludeIds.has(c.id))
  );
  complete.sort(byRingFromPrime());
  for (const c of complete) {
    // Unguarded: the diff is ours and reports an unloaded read as a step-less result, so `continue` on a
    // throw meant "this cell needs no maintenance" — a completed cell silently exempted from repair for
    // the rest of the run.
    const diff = miningIntegrity.scanSegmentSteps(bot, generateCell(c.anchor));
    if (diff && Array.isArray(diff.steps) && diff.steps.length > 0) {
      return { ...c, maintenance: true };
    }
  }
  return null;
}

// selectNextCell — MAINTENANCE first (re-diff complete cells; repair any damaged one), then
// GROWTH (lowest-ring incomplete cell — the even fan out of each prime). Returns the record tagged
// { maintenance:true|false } or null when there is no cell work of either kind. Seeds the fans on
// first call. excludeIds skips cells a peer currently holds. Maintain-before-grow (the shaft's own
// order, Law 17): the bot grazes a finished cell's walls while carving the next one, so the built
// path must be kept intact as the field expands — repair first, extend second.
function selectNextCell(bot, excludeIds = null) {
  let cells = readCells();
  if (Object.keys(cells).length === 0) {
    seedCells(bot);
    cells = readCells();
  }
  // Keep the path intact before extending it.
  const maint = selectMaintenanceCell(bot, excludeIds);
  if (maint) return maint;

  const growth = Object.values(cells).filter(
    c => !c.complete && !c.blocked && !(excludeIds && excludeIds.has(c.id))
  );
  if (growth.length === 0) return null;
  growth.sort(byRingFromPrime());
  return { ...growth[0], maintenance: false };
}

// hasBuildableCell — gate for job_board (Phase 5.1): is there ANY actionable cell (growth OR
// maintenance)? Seeds on first call so the gate opens right after the shaft completes. When the
// field is complete AND undamaged this returns false, so the board stops posting dig_cell (no
// busy-loop); a later grief that dirties a cell flips it back true and a repair pass is posted.
function hasBuildableCell(bot) {
  return selectNextCell(bot) !== null;
}

module.exports = {
  // constants + pure ordering (exported for inspection/tests)
  CELL_SPACING, CELL_HALF, DIR_VEC, ringFromPrime, byRingFromPrime,
  // persistence
  readCells, getCell, markCellComplete, markCellBlocked, recordCellRemaining,
  // geometry / scan / generation
  scanCell, generateCell, getDeepestSegmentMarkers,
  // the seed/blueprint-collision rule, exported so a probe can drive the REAL predicate offline
  // instead of a hand-copy of it (Law 6). A copied predicate is what lets a seeding offset and its
  // guard disagree unnoticed: both can be "verified", neither against the other.
  staircaseDeclarations, overlapsStaircase,
  // graph operations
  seedCells, registerNeighbors, selectNextCell, selectMaintenanceCell, hasBuildableCell,
  getProtectedBlocks,
};
