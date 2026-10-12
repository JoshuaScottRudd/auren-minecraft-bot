// perception node: mining_cell_graph
//
// Owns the whole fractal-cell lifecycle in one place (Law 16) — the cell counterpart to
// mining_blueprinter + mining_integrity:
//   - GEOMETRY: where cells sit (4-apart, shared walls), how a staircase side-attach seeds each floor's
//     two prime cells, and the two fans that grow from them — each in the three directions facing away
//     from the other (registerNeighbors), fenced along the staircase by the staircase-collision guard.
//   - SCAN (scanCell): is this 5×5×5 + 7×7 margin safe to carve? Binary safety — fluids and
//     gravel→fluid conduits only, unloaded → defer. Off the spine, a cell cut into a cave is blocked.
//   - GENERATION (generateCell): place the underground_cell blueprint at an anchor.
//   - PERSISTENCE: the registered cells live in HQ mining_confrence_room (Law 6).
//   - SELECTION (selectNextCell): the buildable incomplete cell on the lowest floor, nearest that
//     floor's prime (a fan per floor; multibot-safe via excludeIds), and the next floor up when none is open.
//
// A separate module from mining_integrity because cells are selected by ring distance from each
// floor's prime (D6), a different ordering than the shaft's depth-major priority. Keeping cells out of
// mining_integrity.scan() lets that node answer exactly one question ("is the shaft done?") while this
// node owns cell selection and per-cell diffing (via mining_integrity.scanSegmentSteps).
//
// Multibot is designed-for but out of scope: the HQ record already carries id + complete, so
// per-anchor claiming bolts on later.

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
// The hazard scan also reaches this many blocks below the floor. A bot descends toward a cell along
// the shaft-side approach, and water sitting just under the floor floods the instant the floor is
// pierced — that water sits outside a floor-and-up-only box, so scanning only at/above the floor could
// report a cell safe and still flood the staircase. Matches the 7×7 side ring, so the scanned volume
// covers the cell plus a margin below and around the approach, not just at/above the floor.
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
// shrinking is stuck (a voxel no reachable stand can carve — Law 13), NOT complete. First call
// sees Infinity → the first pass always counts as shrinking, so a fresh cell is never blocked
// on pass one.
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
function getDeepestSegmentMarkers(heldIds = null) {
  // NO GUARD ON THE STAIRCASE GENERATOR, HERE OR BELOW IN THIS FILE. It is ours, and answering `[]` on a
  // throw reads downstream as "no floors to seed" — the cell graph then grows nothing and reports a
  // quiet, plausible nothing for the rest of the run (Law 13; Law 25 — a default is not a measurement).
  const plan = generateStaircase();
  const sideAttaches = staircaseSideAttaches();
  const segments = plan.staircase_segments || [];
  if (!segments.length || !sideAttaches.length) return [];

  // The registry is this body's own; a shaft a peer dug is known from the world, through the integrity
  // scan's verdict, so every body seeds every floor once the descent is excavated.
  const built = hq.readConfRoomFlag(ROOM, 'built_segments', {}) || {};
  const excavated = !!require('@perception/mining_integrity').getState()?.shaft_excavated;
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

  // A BODY THAT WANTS TO MINE IS ALWAYS GIVEN SOMETHING TO MINE. When every unit on every floor lit so far is
  // dug, blocked or held by a peer (heldIds), the next floor up is lit — the staircase copy two above the
  // highest one, its attaches either side of the shaft — and the trunks start over from there; and so on up
  // to the top of the staircase. A floor whose trunks cannot run out opens no branches, so it fills and the
  // floor above it opens.
  const cells = Object.values(readCells()).filter(c => c && c.anchor);
  const spent = (i) => {
    const on = cells.filter(c => c.anchor.y === floorY(segments[i]));
    return on.length > 0 && on.every(c => c.complete || c.blocked || (heldIds && heldIds.has(c.id)));
  };
  const up = segments.length > 1 && segments[0].world_position.y > segments[segments.length - 1].world_position.y ? -2 : 2;
  let top = floorIdxs.reduce((a, b) => (floorY(segments[a]) >= floorY(segments[b]) ? a : b), floorIdxs[0]);
  while (floorIdxs.length && floorIdxs.every(spent)) {
    const next = top + up;
    if (next < 0 || next >= segments.length) break;
    floorIdxs.push(next);
    top = next;
  }

  const markers = [];
  for (const i of floorIdxs) {
    const seg = segments[i];
    if (!built[seg.id] && !excavated) continue;
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

// Does a cell at `anchor` contradict the staircase?
//
// A correctly-seeded cell is designed to intersect the staircase: the side-attach marker sits in the
// staircase's wall plane, so the cell shares that whole wall, and the staircase blueprint carries a
// door-sized hole in it exactly where the cell's door lands. Sharing a wall is the design — the same
// equal-attaching relationship as two adjacent cells at CELL_SPACING.
//
// The fault this predicate catches is a disagreement: one blueprint wants air where the other wants
// solid. That is a cell body grown into the shaft, and it is unbuildable — whoever writes last wins
// and the other re-flags it forever. The predicate is contradiction, not intersection.
function overlapsStaircase(anchor, stairDecls, shape = null) {
  if (!stairDecls || stairDecls.size === 0) return false;
  for (const v of generateCell(anchor, shape).voxels) {
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
// in the footprint (lava/water) or a gravel-to-fluid conduit (D13). Cave voids are SAFE — a
// cell bordering open air builds its walls into it; whether an optional cell is WORTH that is
// decided at registration (the spine rule above), not here. An unloaded chunk → defer (Law 13 environmental, NOT a
// reject). Small wall breaches are resealed by mining_integrity's wall_breach fill (Law 16,
// one pathway), so picket_voxels is intentionally always empty.
function scanCell(bot, anchor, shape = null) {
  const gMargin = CELL_HALF + GRAVITY_MARGIN; // 3 → 7×7
  // A strip segment's box is its own voxels plus GRAVITY_MARGIN round them, from APPROACH_DEPTH below its floor.
  let box = { x0: anchor.x - gMargin, x1: anchor.x + gMargin, z0: anchor.z - gMargin, z1: anchor.z + gMargin,
    y0: anchor.y + CELL_Y_MIN - APPROACH_DEPTH, y1: anchor.y + CELL_Y_MAX };
  if (isStrip(shape)) {
    const vs = stripVoxels({ ...shape, anchor });
    box = { x0: Math.min(...vs.map(v => v[0])) - GRAVITY_MARGIN, x1: Math.max(...vs.map(v => v[0])) + GRAVITY_MARGIN,
      z0: Math.min(...vs.map(v => v[2])) - GRAVITY_MARGIN, z1: Math.max(...vs.map(v => v[2])) + GRAVITY_MARGIN,
      y0: anchor.y - APPROACH_DEPTH, y1: anchor.y + 3 + GRAVITY_MARGIN };
  }

  // From APPROACH_DEPTH below the floor up through the cell ceiling: water/lava under or around
  // the descent floods the carve, so it is scanned even though it sits outside the cell body.
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      for (let z = box.z0; z <= box.z1; z++) {
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

  // A strip stops where its tunnel would bring sand or gravel down on the body: a falling block in the ceiling over
  // the tunnel, or one in the tunnel itself with another falling block resting on it.
  if (isStrip(shape)) {
    for (const v of stripVoxels({ ...shape, anchor })) {
      if (v[3] !== 'air' || v[1] !== anchor.y + 1) continue;
      const at = (dy) => bot.blockAt(new Vec3(v[0], anchor.y + dy, v[2]));
      const fall = (dy) => { const b = at(dy); return !!b && isGravityBlock(b.name); };
      if (fall(3) || (fall(1) && fall(2)) || (fall(2) && fall(3))) return { safe: false, halt_reason: 'gravity_overhead', picket_voxels: [] };
    }
  }

  return { safe: true, halt_reason: 'none', picket_voxels: [] };
}

// ── generateCell (Phase 4) ───────────────────────────────────────────────────
// Place the underground_cell blueprint at a world anchor and return a segment object
// shaped like a shaft segment so mining_integrity.scanSegmentSteps + mining_executor's
// cell path consume it identically (Law 10 typed contract). Regenerating a complete cell is
// legitimate: cell maintenance (the twin of mining_integrity re-diffing built_segments)
// re-generates a finished cell's blueprint to re-diff it against the world for damage.
// generateCell is pure computation (placeVoxelsAt is arithmetic, touches no blocks), so this
// is side-effect-free.
function generateCell(anchor, shape = null) {
  const id = makeSegmentId(anchor);
  if (isStrip(shape)) {
    const voxels = stripVoxels({ ...shape, anchor });
    return {
      id, type: 'cell',
      world_position: { x: anchor.x, y: anchor.y, z: anchor.z },
      anchors: [{ x: anchor.x, y: anchor.y, z: anchor.z }],
      voxel_count: voxels.length, voxels,
      summary: `${shape.kind} ${id} ${shape.dir} @ (${anchor.x},${anchor.y},${anchor.z})`,
    };
  }
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

// ── THE STRIP LAYOUT (architect_config.MINE_LAYOUT 'strip') ─────────────────────────────────────────
// The same graph, a different unit: a SEGMENT of 1-wide, 2-tall tunnel, STRIP_SEG blocks long, dug from one
// stand at its near end (the last cell of the segment before it, so every voxel is in reach). Each floor's two
// staircase side-attaches seed a TRUNK running straight out (the fan's direction); every BRANCH_EVERY blocks
// along the trunk (two blocks of rock between) a BRANCH runs out each side, perpendicular. A trunk segment
// declares its own branch openings, so a branch never contradicts the trunk wall it opens through.
// Record shape: { kind: 'trunk'|'branch', dir, k0 } — dir is the way the segment digs, k0 (trunk only) is how
// many trunk blocks lie before it. The fan picks where a trip STARTS (the cells' own selection, nearest the
// floor's prime first); from there the trip keeps to that one line (lineContinuation) until its pickaxes run out
// or the line ends at a cave, a hazard or the staircase.
const STRIP_SEG = 4;
const BRANCH_EVERY = 3;
const SIDES_OF = { north: ['east', 'west'], south: ['east', 'west'], east: ['north', 'south'], west: ['north', 'south'] };
function isStrip(shape) { return !!shape && (shape.kind === 'trunk' || shape.kind === 'branch'); }
function stripLayout() { return require('@thinking/architect_config').MINE_LAYOUT === 'strip'; }

// stripVoxels(rec) → the segment's voxels: tunnel air over a floor, under a ceiling, between two walls, and at
// a trunk's branch openings the opening cell itself (air, floored and roofed) in place of the wall.
function stripVoxels(rec) {
  const d = DIR_VEC[rec.dir];
  const a = rec.anchor;
  const sides = SIDES_OF[rec.dir].map(n => DIR_VEC[n]);
  const out = [];
  const put = (x, y, z, t) => out.push([x, y, z, t]);
  for (let i = 1; i <= STRIP_SEG; i++) {
    const x = a.x + d.x * i, z = a.z + d.z * i;
    put(x, a.y, z, 'structural_fill'); put(x, a.y + 1, z, 'air'); put(x, a.y + 2, z, 'air'); put(x, a.y + 3, z, 'structural_fill');
    const opening = rec.kind === 'trunk' && (rec.k0 + i) % BRANCH_EVERY === 0;
    for (const s of sides) {
      const sx = x + s.x, sz = z + s.z;
      if (opening) {
        put(sx, a.y, sz, 'structural_fill'); put(sx, a.y + 1, sz, 'air'); put(sx, a.y + 2, sz, 'air'); put(sx, a.y + 3, sz, 'structural_fill');
      } else {
        put(sx, a.y + 1, sz, 'structural_fill'); put(sx, a.y + 2, sz, 'structural_fill');
      }
    }
  }
  return out;
}

// stripNeighbours(rec) → the segments a finished segment opens: a trunk its next segment and a branch on each
// side at every opening it cut; a branch its next segment.
function stripNeighbours(rec) {
  const d = DIR_VEC[rec.dir];
  const a = rec.anchor;
  const next = { anchor: { x: a.x + d.x * STRIP_SEG, y: a.y, z: a.z + d.z * STRIP_SEG }, shape: { kind: rec.kind, dir: rec.dir, k0: (rec.k0 || 0) + STRIP_SEG, origin: rec.origin || a } };
  if (rec.kind === 'branch') return [next];
  const out = [next];
  for (let i = 1; i <= STRIP_SEG; i++) {
    if ((rec.k0 + i) % BRANCH_EVERY !== 0) continue;
    for (const side of SIDES_OF[rec.dir]) {
      const s = DIR_VEC[side];
      out.push({ anchor: { x: a.x + d.x * i + s.x, y: a.y, z: a.z + d.z * i + s.z }, shape: { kind: 'branch', dir: side, k0: 0 } });
    }
  }
  return out;
}

// caveAir(bot, anchor, shape) → the open blocks round a strip segment that no tunnel of the mine planned: a box two
// blocks out from the segment's voxels on every side. A tunnel driven into a large cave stops there (STRIP_CAVE_AIR),
// because it can no longer be walled, and a body standing at its end has open ground to fall into.
const STRIP_CAVE_AIR = 40;
function caveAir(bot, anchor, shape) {
  const vs = stripVoxels({ ...shape, anchor });
  const planned = new Set(vs.filter(v => v[3] === 'air').map(v => `${v[0]},${v[1]},${v[2]}`));
  for (const rec of Object.values(readCells())) {
    if (!rec || !rec.anchor || !isStrip(rec)) continue;
    for (const v of stripVoxels(rec)) if (v[3] === 'air') planned.add(`${v[0]},${v[1]},${v[2]}`);
    planned.add(`${rec.anchor.x},${rec.anchor.y + 1},${rec.anchor.z}`); planned.add(`${rec.anchor.x},${rec.anchor.y + 2},${rec.anchor.z}`);
  }
  const xs = vs.map(v => v[0]), zs = vs.map(v => v[2]);
  let open = 0;
  for (let x = Math.min(...xs) - 2; x <= Math.max(...xs) + 2; x++) {
    for (let z = Math.min(...zs) - 2; z <= Math.max(...zs) + 2; z++) {
      for (let y = anchor.y - 1; y <= anchor.y + 5; y++) {
        if (planned.has(`${x},${y},${z}`)) continue;
        const b = bot.blockAt(new Vec3(x, y, z));
        if (b && isAirName(b.name)) open++;
      }
    }
  }
  return open;
}

// lineContinuation(rec) → the registered record of the segment that carries rec's own line straight on (same kind,
// same direction), or null when none is registered. A trip keeps to one line: the fan picks where it starts.
// lineKey(rec) → the arbiter key of the tunnel rec belongs to: its origin segment, kind and direction.
function lineKey(rec) {
  return `line:${makeSegmentId(rec.origin || rec.anchor)}|${rec.kind}|${rec.dir}`;
}
// wayOut(rec) → the anchors a body leaves rec's tunnel by, nearest first: a branch's mouth (the trunk block its
// first segment opens from), then the origin of the trunk that mouth lies on, which is the foot of the shaft's
// stairs. A trunk gives its own origin. Walked in reverse, the same points are the way in.
function wayOut(rec) {
  if (!isStrip(rec)) return [];
  const o = rec.origin || rec.anchor;
  if (rec.kind === 'trunk') return [{ x: o.x, y: o.y, z: o.z }];
  const d = DIR_VEC[rec.dir];
  const mouth = { x: o.x - d.x, y: o.y, z: o.z - d.z };
  const out = [mouth];
  for (const c of Object.values(readCells())) {
    if (!c || c.kind !== 'trunk' || !c.anchor) continue;
    const t = c.origin || c.anchor, td = DIR_VEC[c.dir];
    const onLine = mouth.y === t.y && (td.x !== 0
      ? mouth.z === t.z && (mouth.x - t.x) * td.x >= 0
      : mouth.x === t.x && (mouth.z - t.z) * td.z >= 0);
    if (onLine) { out.push({ x: t.x, y: t.y, z: t.z }); break; }
  }
  return out;
}
function lineContinuation(rec) {
  if (!isStrip(rec)) return null;
  return getCell(makeSegmentId(stripNeighbours(rec)[0].anchor));
}

// unitYield() → the blocks one new unit of the current layout digs out (its air voxels).
function unitYield() {
  const shape = stripLayout() ? { kind: 'branch', dir: 'east', k0: 0 } : null;
  return generateCell({ x: 0, y: 0, z: 0 }, shape).voxels.filter(v => v[3] === 'air').length;
}

// cellWorkBox — the ground a body making this cell closes to its peers (foreman_link.closeClaimedArea):
// the room and the floor and ceiling over it. The four side walls stay outside the box, because a
// neighbouring cell shares each one and its maker works that wall too. A strip segment's box is its tunnel.
function cellWorkBox(anchor, shape = null) {
  if (isStrip(shape)) {
    const d = DIR_VEC[shape.dir];
    const xs = [anchor.x + d.x, anchor.x + d.x * STRIP_SEG], zs = [anchor.z + d.z, anchor.z + d.z * STRIP_SEG];
    return {
      min: { x: Math.min(...xs), y: anchor.y + 1, z: Math.min(...zs) },
      max: { x: Math.max(...xs), y: anchor.y + 2, z: Math.max(...zs) },
    };
  }
  const room = CELL_HALF - 1;
  return {
    min: { x: anchor.x - room, y: anchor.y + CELL_Y_MIN, z: anchor.z - room },
    max: { x: anchor.x + room, y: anchor.y + CELL_Y_MAX, z: anchor.z + room },
  };
}

// getProtectedBlocks — every SOLID voxel of every REGISTERED cell, as "x,y,z" world keys. The cell
// twin of mining_integrity.getProtectedBlocks() (staircase) and building_integrity's (buildings);
// the navigator merges all three. mining_cell_graph is the owner because it is the only module that
// knows a cell exists — cells are registered per-anchor in HQ, never listed in the staircase plan.
// Without it, every cell wall is invisible to A*, which prices digging through one as a cheap
// detour instead of a hard wall (Invariant D / Law 16: one voxel, two owners must agree).
//
// Registered ⇒ protected, complete or not — the same rule the staircase already uses (all
// segments are protected whether dug yet or not). A planned-but-uncarved cell's walls are untouched
// rock, so protecting them costs a stricter route, never a wrong one; PROTECTED_VOXEL_DETOUR_BUDGET is
// finite, so a trapped bot still breaks out. generateCell is pure arithmetic and may throw only on a
// missing blueprint (Law 13 coding violation) — that is left to throw, and the navigator names the
// source in its warn; nothing here swallows it into silence.
function getProtectedBlocks() {
  const set = new Set();
  for (const rec of Object.values(readCells())) {
    if (!rec || !rec.anchor) continue;
    for (const v of generateCell(rec.anchor, rec).voxels) {
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
// Said once per door per body: the door reads the same on every later sweep until a cell carves it.
const _doorSaid = new Set();
function verifyShaftDoor(bot, markerWorld) {
  const [mx, my, mz] = markerWorld;
  const a = bot.blockAt(new Vec3(mx, my + 1, mz));
  const b = bot.blockAt(new Vec3(mx, my + 2, mz));
  const key = `${mx},${my},${mz}`;
  if (a && b && !isAirName(a.name) && !isAirName(b.name) && !_doorSaid.has(key)) {
    _doorSaid.add(key);
    watcher.summary('mining_cell_graph', `Shaft door at (${mx},${my + 1}..${my + 2},${mz}) is not open (${a.name}/${b.name}) — first cell will carve its own opening.`);
  }
}

// ── The spine and the optional cells ─────────────────────────────────────────
// A floor's SPINE is the straight line of cells running from its prime directly away from the
// shaft (the prime's fan direction). Spine cells are always built, cave or not, so every floor has
// an unbounded corridor to grow from and a body is never boxed in. Every other cell is optional: one
// cut into a cave (more than CAVE_WALL_SHARE of its wall voxels already open) is blocked 'cave' and
// never grown from, because walling a cave spends the material the cell exists to produce.
const CAVE_WALL_SHARE = 0.25;
function onSpine(anchor, fan, prime) {
  const dir = DIR_VEC[fan];
  if (!dir) return false;
  if (dir.x === 0) return anchor.x === prime.x && (anchor.z - prime.z) * dir.z >= 0;
  return anchor.z === prime.z && (anchor.x - prime.x) * dir.x >= 0;
}
// wallBreachCount — how many of the cell's solid blueprint voxels are air in the world now.
function wallBreachCount(bot, anchor, shape = null) {
  let walls = 0, open = 0;
  for (const v of generateCell(anchor, shape).voxels) {
    if (isAirName(v[3])) continue;
    walls++;
    const b = bot.blockAt(new Vec3(v[0], v[1], v[2]));
    if (b && isAirName(b.name)) open++;
  }
  return { walls, open };
}

// ── Registration helpers ─────────────────────────────────────────────────────
// Scan an anchor and register a cell record if it isn't known yet. Returns the record,
// or null when the chunk is unloaded (defer — re-register on a later pass). Blocked
// cells are LEFT registered (with a `blocked` reason) so selection skips them and they
// are not re-scanned every pass (D6). A cell whose footprint hits the staircase is blocked
// 'staircase' up front, with no world read needed (Law 16). stairDecls is precomputed once
// by the caller and threaded in so a registration wave doesn't rebuild the staircase prism
// per anchor.
// `prime` is the origin this cell fans out from — the floor's staircase-segment prime cell.
// A seed IS its own prime (default param), and every neighbour inherits its parent's prime
// through registerNeighbors, so a whole fan shares one origin. Selection rings out of it
// (byRingFromPrime), which makes growth an even fan spreading out from the prime.
function registerCellAt(bot, anchor, fan, stairDecls, prime = anchor, shape = null) {
  const cells = readCells();
  const id = makeSegmentId(anchor);
  if (cells[id]) return cells[id];

  const primeXYZ = { x: prime.x, y: prime.y, z: prime.z };
  const shapeFields = isStrip(shape) ? { kind: shape.kind, dir: shape.dir, k0: shape.k0 || 0, origin: shape.origin || { x: anchor.x, y: anchor.y, z: anchor.z } } : {};
  const stair = stairDecls || staircaseDeclarations();
  if (overlapsStaircase(anchor, stair, shape)) {
    const record = { id, anchor: { x: anchor.x, y: anchor.y, z: anchor.z }, complete: false, fan, prime: primeXYZ, ...shapeFields, blocked: 'staircase' };
    cells[id] = record;
    writeCells(cells);
    return record;
  }

  const scan = scanCell(bot, anchor, shape);
  if (scan.halt_reason === 'unloaded') return null;

  const record = { id, anchor: { x: anchor.x, y: anchor.y, z: anchor.z }, complete: false, fan, prime: primeXYZ, ...shapeFields };
  if (!scan.safe) record.blocked = scan.halt_reason;
  else if (isStrip(shape)) {
    const open = caveAir(bot, anchor, shape);
    if (open > STRIP_CAVE_AIR) record.blocked = `cave (${open} open blocks round the tunnel)`;
  } else if (!onSpine(anchor, fan, primeXYZ)) {
    const breach = wallBreachCount(bot, anchor, shape);
    if (breach.open > breach.walls * CAVE_WALL_SHARE) record.blocked = `cave (${breach.open} of ${breach.walls} wall voxels open)`;
  }
  if (record.blocked && isStrip(shape)) watcher.summary('mining_cell_graph', `STRIP BLOCKED ${shape.kind} ${shape.dir} ${id}: ${record.blocked}`);
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
function seedCells(bot, heldIds = null) {
  const markers = getDeepestSegmentMarkers(heldIds);
  const stairDecls = staircaseDeclarations();
  let seeded = 0;
  const scanStart = Date.now();   // each registerCellAt runs the ~392-voxel scanCell — report the sweep cost
  for (const m of markers) {
    const dir = DIR_VEC[m.outward];
    if (!dir) { watcher.warn('mining_cell_graph', `marker has unknown outward "${m.outward}" — skipped.`); continue; }
    const mw = m.world; // [x,y,z]
    verifyShaftDoor(bot, mw);
    // A strip's trunk is stood on from the staircase door itself: the marker is its first stand.
    const strip = stripLayout();
    const anchor = strip ? { x: mw[0], y: mw[1], z: mw[2] } : { x: mw[0] + dir.x * CELL_HALF, y: mw[1], z: mw[2] + dir.z * CELL_HALF };
    const rec = registerCellAt(bot, anchor, m.outward, stairDecls, anchor, strip ? { kind: 'trunk', dir: m.outward, k0: 0 } : null);
    if (rec && !rec.blocked) seeded++;
  }
  watcher.summary('mining_cell_graph', `Seeded ${markers.length} staircase side-attach marker(s); ${seeded} buildable seed cell(s) in ${Date.now() - scanStart}ms.`);
  return seeded;
}

// registerNeighbors (Phase 2.4) — on a cell's completion, register its buildable neighbours
// in the THREE directions its fan may grow: every cardinal except the one pointing back at the
// floor's other fan. A floor's two fans are seeded either side of the staircase, facing apart
// (north/south, or east/west), so a north fan grows north, east and west, a south fan south, east
// and west, and the two never meet — their seeds are 6 apart on a 4-block spacing, so cells from
// both would sit 2 apart and overlap. Growth along the staircase is stopped by the
// staircase-collision guard in registerCellAt. Neighbours inherit the parent's fan AND its prime
// (the ring origin they fan out from). Returns the count newly registered.
const FAN_FORBIDS = { north: 'south', south: 'north', east: 'west', west: 'east' };
function registerNeighbors(bot, cellRecord) {
  const forbidden = FAN_FORBIDS[cellRecord.fan];
  if (!forbidden) {
    throw new Error(`[mining_cell_graph] CODING VIOLATION (Law 13): cell ${cellRecord.id} carries fan `
      + `"${cellRecord.fan}" — every cell inherits its seed's fan, one of ${Object.keys(FAN_FORBIDS).join('/')}.`);
  }
  const stairDecls = staircaseDeclarations();
  let added = 0;
  if (isStrip(cellRecord)) {
    for (const n of stripNeighbours(cellRecord)) {
      const before = !!getCell(makeSegmentId(n.anchor));
      const rec = registerCellAt(bot, n.anchor, cellRecord.fan, stairDecls, cellRecord.prime || cellRecord.anchor, n.shape);
      if (rec && !before && !rec.blocked) added++;
    }
    return added;
  }
  for (const d of CARDINALS) {
    if (d === forbidden) continue;
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
// fills concentric rings around every floor's prime. Because a prime's completion registers ALL of
// its ring-1 neighbours at once, nearest-ring selection drains each fully-registered ring before
// advancing — so the lazy (completion-gated) frontier still yields clean rings with no eager
// pre-expansion.
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

// lowestThenNearest — the order growth is picked in: the lowest floor first, and on a floor the unit nearest
// its prime, which is the unit nearest the shaft. Each floor fills as a fan out of the shaft before a body
// is sent to the floor above it.
function lowestThenNearest() {
  const ring = byRingFromPrime();
  return (a, b) => (a.anchor.y - b.anchor.y) || ring(a, b);
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
    // Unguarded: the diff is ours and reports an unloaded read as a step-less result, so a throw here
    // means the cell genuinely could not be diffed — never swallowed as no maintenance needed, which
    // would silently exempt a completed cell from repair for the rest of the run.
    const diff = miningIntegrity.scanSegmentSteps(bot, generateCell(c.anchor, c));
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
  const found = nextGrowth(bot, excludeIds);
  if (found) return found;
  // Nothing open to this body on the floors lit so far: light the next floor up (getDeepestSegmentMarkers) and
  // look again. A floor already registered seeds nothing new, so with the top of the staircase reached this ends.
  const lit = getDeepestSegmentMarkers(excludeIds).length;
  if (lit === _litMarkers) return null;
  _litMarkers = lit;
  const before = Object.keys(readCells()).length;
  seedCells(bot, excludeIds);
  if (Object.keys(readCells()).length === before) return null;
  watcher.summary('mining_cell_graph', `NEXT FLOOR UP lit — ${Object.keys(readCells()).length - before} new unit(s) registered.`);
  return selectNextCell(bot, excludeIds);
}

let _litMarkers = 0;   // the markers seeded last time the lit floors ran out

// nextGrowth — the nearest open unit of the floors already lit, or null.
function nextGrowth(bot, excludeIds = null) {

  // Each body keeps its own register of the field, so a unit a peer already dug reads as open here. The world
  // settles it: a unit whose diff is fully sensed and clean (scanSegmentSteps → null) is marked complete and grows
  // its neighbours from where this body stands, so no body walks out to dig what is already dug.
  const miningIntegrity = require('@perception/mining_integrity');
  let caughtUp = 0;
  for (let i = 0; i < CATCH_UP_MAX; i++) {
    const growth = Object.values(readCells()).filter(
      c => !c.complete && !c.blocked && !(excludeIds && excludeIds.has(c.id))
    );
    if (growth.length === 0) break;
    growth.sort(lowestThenNearest());
    const c = growth[0];
    if (i === CATCH_UP_MAX - 1 || !bot || !bot.blockAt || miningIntegrity.scanSegmentSteps(bot, generateCell(c.anchor, c)) !== null) {
      if (caughtUp) watcher.summary('mining_cell_graph', `CAUGHT UP ${caughtUp} unit(s) a peer already dug — next open unit ${c.id}.`);
      return { ...c, maintenance: false };
    }
    markCellComplete(c.id);
    registerNeighbors(bot, { ...c, complete: true });
    caughtUp++;
  }
  if (caughtUp) watcher.summary('mining_cell_graph', `CAUGHT UP ${caughtUp} unit(s) a peer already dug — no open unit left in sight.`);
  return null;
}
const CATCH_UP_MAX = 64;

// hasBuildableCell — gate for job_board (Phase 5.1): is there ANY actionable cell (growth OR
// maintenance)? Seeds on first call so the gate opens right after the shaft completes. When the
// field is complete AND undamaged this returns false, so the board stops posting dig_cell (no
// busy-loop); a later grief that dirties a cell flips it back true and a repair pass is posted.
// When every open unit this body knows is held by a peer, the mine is full for it: the board stops offering it a
// mining job for PEERS_HOLD_ALL_MS rather than posting one it can only turn down.
const PEERS_HOLD_ALL_MS = 30000;
let _allHeldUntil = 0;
function noteAllHeldByPeers() { _allHeldUntil = Date.now() + PEERS_HOLD_ALL_MS; }
function hasBuildableCell(bot) {
  if (Date.now() < _allHeldUntil) return false;
  return selectNextCell(bot) !== null;
}

module.exports = {
  // constants + pure ordering (exported for inspection/tests)
  CELL_SPACING, CELL_HALF, DIR_VEC, ringFromPrime, byRingFromPrime,
  // persistence
  readCells, getCell, markCellComplete, markCellBlocked, recordCellRemaining,
  // geometry / scan / generation
  scanCell, generateCell, cellWorkBox, getDeepestSegmentMarkers, isStrip, unitYield, lineContinuation, lineKey, wayOut, caveAir, STRIP_SEG, BRANCH_EVERY, STRIP_CAVE_AIR,
  // the seed/blueprint-collision rule, exported so a probe can drive the REAL predicate offline
  // instead of a hand-copy of it (Law 6). A copied predicate is what lets a seeding offset and its
  // guard disagree unnoticed: both can be "verified", neither against the other.
  staircaseDeclarations, overlapsStaircase,
  // graph operations
  seedCells, registerNeighbors, selectNextCell, selectMaintenanceCell, hasBuildableCell, noteAllHeldByPeers,
  getProtectedBlocks,
};
