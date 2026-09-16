// util: wheat_plot_scanner (farm siting)
// purpose: THE siting authority for the phase-1 ad-hoc wheat field. Given a bot's voxels, it returns up to N
//          (crop, stand) plots that are hydrated, stand-paired, LAND-REACHABLE and mutually PENALTY-FREE, cut
//          from the BIGGEST plot cluster in the loaded area first. lock_all_buildspots locks each returned plot
//          as one `wheat_plot_pair` blueprint instance; find_buildingspot does NOT site these — its per-spot fit
//          knows nothing of the hydration Y-rule or the cross-plot penalty graph, which are the entire point
//          (Law 16: one siting pathway for this field, and it is this one).
//
// ── THE MODEL: A PLOT IS A TUPLE, AND THE FIELD IS BUILT IN LAYERS ──────────────────────────────────────
// A plot is a CROP cell (the seed spot) and a STAND cell (where the body stands to work it), one cardinal step
// apart at the same height. Reuse is ASYMMETRIC:
//   • a STAND may serve several crops — a walkway between two rows serves both;
//   • a CROP belongs to one plot, and a stand is never a crop nor a crop a stand — farmland under a body is
//     trampled back to dirt, so the two sets are disjoint.
// The field is built in four layers, each reading only what the one before it produced:
//   1. WATER — every sea-level water source in the loaded area, flooded body by body.
//   2. LAND  — every column within HYDRATION_RADIUS of a shore, judged by the one column rule (plotColumn).
//   3. TUPLES — each usable column, nearest the water first, becomes a crop if a stand can be paired with it and
//      the PENALTY OVERLAY admits it (see tupleLayer for the order and the tests).
//   4. CUT   — the plots group into clusters; the field is cut from the biggest, topped up from the next.
//
// ── WHY TUPLES AND NOT A FIELD-WIDE STRIPE PATTERN ──────────────────────────────────────────────────────
// The previous layout fixed ONE stripe axis, parity and stand side for the whole loaded area, then kept only the
// columns that happened to agree with it, in contiguous runs of four. Every bank that faced another way, every
// cell on the walkway parity, and every run shorter than four was discarded — the pattern was chosen once and
// the terrain had to fit it, so most usable bank columns in any real loaded area never became plots. The overlay
// decides per column, so a winding bank keeps every stretch whatever it faces, and penalty-freedom is CHECKED rather
// than produced by stripe spacing (verifyNoPenalty re-derives it off the finished field).
// The cost, named: single plots may stand alone, so a field fragments more easily. The CUT is what holds
// cohesion — biggest cluster first, and within a cluster the plots nearest its own centre.
//
// ── HYDRATION Y-RULE, AND WHY THE FARM PLANE IS PINNED TO seaY ──────────────────────────────────────────
// Vanilla farmland (FarmBlock.isNearWater) is wet when water sits within 4 in x/z AND at the farmland's own Y or
// ONE ABOVE — never below. So a sea-level source waters a crop at seaY and nothing higher. Every crop is AT seaY,
// and a bank that rises inland is terraformed down to it rather than farmed dry.
// THE COLUMN RULE (plotColumn) answers for a crop and a stand alike: the cell AT seaY must already be solid, and
// the PLOT_HEADROOM cells above it must each be air already or CLEARABLE — diggable, not a fluid, and at most one
// full solid block, as the first cell. Nothing below seaY is ever touched. Every cell it clears is one the plot's
// own blueprint already owns — `wheat_plot_pair` declares the cells over its stand and over its crop as `air` —
// so the ordinary build digs them; this module only decides WHERE.
// WHAT STAYS EXCLUDED, and the list stops there: two solid layers above seaY (a terrace — cutting it leaves a
// pit), a fluid touching any cell being cleared (`wouldFlow`), and anything below seaY (the pre-v3 code allowed
// it and cut a channel beside the river).
// A PLANT ON THE BANK is cleared like any other diggable: leaf litter, grass and flowers are the crop cell's own
// `air` voxel, so a littered shore is a hydrated plot, not a refusal.
//
// ── THE DIG-BESIDE-WATER RULE, AND WHY SOIL IS EXEMPT ───────────────────────────────────────────────────
// The crop cell is a `dirt` voxel. Where the ground already IS soil (the blueprint's dirt group — grass, dirt,
// podzol, coarse dirt, farmland) the field phase tills it where it lies: no dig, so no hole for water to enter,
// and such a crop may sit right against the water. Any other ground (sand, gravel, stone, clay) is DUG and
// re-placed as dirt, and a hole opened beside water floods before the dirt goes in — so that crop may not touch
// water on any side. That is the safety property itself, tested directly. The old layout enforced it by a proxy
// (the walkway always between the crop and the water), which also refused every soil crop on the waterline.
//
// ── MAX-GROWTH SPACING ──────────────────────────────────────────────────────────────────────────────────
// A crop grows at half speed if, within its 3×3, any DIAGONAL holds the same crop, or BOTH the E/W and the N/S
// axis do (CropBlock.getGrowthSpeed). The overlay admits a crop only if adding it penalises neither itself nor a
// crop already chosen. Crops interact only within one Y layer, and every crop is at seaY.
//
// ── REACHABILITY ────────────────────────────────────────────────────────────────────────────────────────
// A stand that passes the column rule is dry to stand ON — it is not proven WALKABLE-TO. A lone block at the
// waterline is an island the navigator can only wade to, and the farm manager then re-picks it forever. So a
// stand also needs a LAND APPROACH (hasLandApproach): a cardinal neighbour that is land and not a crop. A ONE-HOP
// test, not a pathfind. Because crops are admitted one at a time, a new crop is also refused when it would take
// the LAST approach of a stand already chosen (`strands`).
//
// A STEPPED TUPLE WAS BUILT AND WITHDRAWN: letting a stand sit a block off its crop needed two extra blueprint
// geometries, and every crop it won sat on the HIGH side of the step, which the hydration rule cannot reach — the
// whole field came out dry. Terraforming to seaY gets coplanarity by lowering the ground instead.
//
// Reuse, not invention (Law 16): every voxel question — reads, water-source and pacing — goes through the one
// front door, @utils/voxel_scan_throttle.makeVoxelScan. Pure decision over READ voxels — it never transforms the
// world. The bot handed in need only satisfy the reader and expose `world.getColumns()` (the loaded area); a
// connected mineflayer bot does, and so does a loaded voxel snapshot (Auren_Workshop/tools/voxel_snapshot_store).

'use strict';

const Vec3 = require('vec3');
const { makeVoxelScan } = require('@utils/voxel_scan_throttle');
const { isFluid } = require('@utils/gravity_utils');                  // the one fluid set (Law 16)
const { group_to_item } = require('@utils/fragment_utils');
const { FARM_BLUEPRINT_NAME } = require('@thinking/architect_config');

// ── TUNABLES — the forks retuned at the table (Law 21) ────────────────────────────────
const HYDRATION_RADIUS = 4;   // MC farmland hydrates from water within 4 in x/z (square). 4 = the game rule.
const PLANTABLE_ABOVE = new Set(['air', 'cave_air', 'void_air']); // crop room / head-room must be genuine air.
const TARGET = 32;            // 2 farms' worth. Up to 32 plots, biggest cluster first.
const ROW_MESH_GAP = 2;       // two crops within 2 blocks share a cluster: the widest gap one walkway leaves.
const DEFAULT_SEA_Y = 62;     // sea-level water sits here — rivers, oceans, and any lake at that level.
const PLOT_HEADROOM = 2;      // cells above seaY the plot owns and must end up clear — the blueprint's own number:
                              // over a CROP the wheat and the air above it, over a STAND the body.
const TERRAIN_LAYERS = 1;     // how many of those cells may be a FULL SOLID BLOCK — one layer of bank comes off,
                              // never two (a terrace; see WHAT STAYS EXCLUDED).
const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// The ground a crop is TILLED on rather than dug out: the members the blueprint's `dirt` voxel accepts as they
// stand. Read from the group itself, so a member added there is tillable here with no second edit (Law 16).
const TILLED_IN_PLACE = new Set(group_to_item.dirt);

function planarDist(o, x, z) { const dx = x - o.x, dz = z - o.z; return Math.sqrt(dx * dx + dz * dz); }
function dist3(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

// plotColumn — THE ONE COLUMN RULE, for a crop cell and a stand alike (Law 16): a solid block AT seaY, and the
// PLOT_HEADROOM cells above it ending up clear.
//   candidate — already clear above seaY
//   terraform — not, but everything in the way can come out: diggable, no fluid on it, at most TERRAIN_LAYERS of
//               it a full solid block and only as the first cell
// Every other answer names the ONE thing that refused the column (Law 6):
//   buried    — a second solid layer above seaY: a terrace, not a bank
//   wouldFlow — a fluid sits on, above, or beside a cell that would be cleared
//   notSolid  — the seaY cell itself is not a full block
//   unloaded  — not streamed in
// null = water: a body's own cell, not a bank.
// THE FLUID CHECK IS THE REACH pathfinding_utils prices a dig by (FLOW_NEIGHBORS): the four cardinals and the
// cell above, never below — liquid does not flow upward. An unsensed neighbour refuses (Invariant B).
function plotColumn(scan, x, seaY, z) {
  const base = scan.blockAt(x, seaY, z);
  if (!base) return { kind: 'unloaded' };
  if (base.name === 'water') return null;
  if (base.boundingBox !== 'block') return { kind: 'notSolid' };
  let cuts = 0;
  for (let d = 1; d <= PLOT_HEADROOM; d++) {
    const c = scan.blockAt(x, seaY + d, z);
    if (!c) return { kind: 'unloaded' };
    if (PLANTABLE_ABOVE.has(c.name)) continue;                       // already clear
    if (isFluid(c.name)) return { kind: 'wouldFlow', by: c.name };   // water standing in the plot's own volume
    if (!c.diggable) return { kind: 'buried', by: c.name };
    // A full block is terrain. One layer comes off, and only as the FIRST cell — a solid block higher up with
    // air under it is an overhang, the same cut into a hillside by another name.
    if (c.boundingBox === 'block' && d > TERRAIN_LAYERS) return { kind: 'buried', by: c.name };
    const over = scan.blockAt(x, seaY + d + 1, z);
    if (!over) return { kind: 'unloaded' };
    if (isFluid(over.name)) return { kind: 'wouldFlow', by: over.name };
    for (const [dx, dz] of CARDINALS) {
      const side = scan.blockAt(x + dx, seaY + d, z + dz);
      if (!side) return { kind: 'unloaded' };
      if (isFluid(side.name)) return { kind: 'wouldFlow', by: side.name };
    }
    cuts++;
  }
  return cuts ? { kind: 'terraform', cuts } : { kind: 'candidate' };
}

// usableColumn — the two verdicts that mean "a plot cell can be here", named once (Law 29).
const usableColumn = (v) => !!v && (v.kind === 'candidate' || v.kind === 'terraform');

// standable — a body fits on this block NOW, nothing cleared first. Its one caller is the land-approach check,
// which asks about ground the fleet is NOT going to build on.
function standable(scan, x, y, z) {
  const base = scan.blockAt(x, y, z);
  if (!base || base.boundingBox !== 'block') return false;
  const h1 = scan.blockAt(x, y + 1, z);
  const h2 = scan.blockAt(x, y + 2, z);
  return !!h1 && !!h2 && PLANTABLE_ABOVE.has(h1.name) && PLANTABLE_ABOVE.has(h2.name);
}

// growthPenalized — MC crop rule at (x,z) given a same-layer occupancy predicate `has`.
function growthPenalized(x, z, has) {
  const diag = has(x - 1, z - 1) || has(x - 1, z + 1) || has(x + 1, z - 1) || has(x + 1, z + 1);
  const ns = has(x, z - 1) || has(x, z + 1);
  const ew = has(x - 1, z) || has(x + 1, z);
  return diag || (ns && ew);
}

// verifyNoPenalty — independent re-check of a finished field (Law 25: the penaltyFree flag is earned).
function verifyNoPenalty(cells) {
  const byY = new Map();
  for (const c of cells) { if (!byY.has(c.y)) byY.set(c.y, new Set()); byY.get(c.y).add(`${c.x},${c.z}`); }
  return cells.every(c => { const layer = byY.get(c.y); return !growthPenalized(c.x, c.z, (x, z) => layer.has(`${x},${z}`)); });
}

// hydrated — will this crop's farmland be WET (the Y half of the vanilla rule; the x/z half holds because every
// crop comes out of a hydration box). True for every plot by construction — here to be CHECKED (Law 25): `dryPlots`
// above zero means the seaY pin has broken.
function hydrated(crop, seaY) { return seaY >= crop.y && seaY <= crop.y + 1; }

// hasLandApproach — is this stand REACHABLE on foot, or a water island? ≥1 cardinal neighbour that is not a crop
// and is LAND: a usable column at this level (clear or clearable — a littered shore is land, not water), or a
// block a body stands on one step up. `isCrop(x,z)` names the crops the answer must route around.
function hasLandApproach(scan, sx, sy, sz, isCrop) {
  for (const [dx, dz] of CARDINALS) {
    const nx = sx + dx, nz = sz + dz;
    if (isCrop(nx, nz)) continue;                                  // a crop is farmland, never a walkway
    if (usableColumn(plotColumn(scan, nx, sy, nz))) return true;   // shore at this level, clear or clearable
    if (standable(scan, nx, sy + 1, nz)) return true;              // or a step up the body can walk down from
  }
  return false;
}

// unionPatches — single-link grouping of coplanar cells within `gap`. Grid flood-fill, not O(n²) pairwise —
// the pool runs to thousands of cells over a whole loaded area. Two callers, one gap (ROW_MESH_GAP): the cut's
// clusters and the finished field's piece count — one mesh rule for choosing and for reporting (Law 16).
function unionPatches(cells, gap) {
  const byKey = new Map();
  for (const c of cells) byKey.set(`${c.x},${c.y},${c.z}`, c);
  const g = Math.floor(gap);
  const window = [];
  for (let dx = -g; dx <= g; dx++) for (let dz = -g; dz <= g; dz++) {
    if ((dx || dz) && dx * dx + dz * dz <= gap * gap) window.push([dx, dz]);
  }
  const seen = new Set(), out = [];
  for (const start of cells) {
    const k0 = `${start.x},${start.y},${start.z}`;
    if (seen.has(k0)) continue;
    seen.add(k0);
    const group = [], stack = [start];
    while (stack.length) {
      const q = stack.pop();
      group.push(q);
      for (const [dx, dz] of window) {
        const nk = `${q.x + dx},${q.y},${q.z + dz}`;
        if (!seen.has(nk) && byKey.has(nk)) { seen.add(nk); stack.push(byKey.get(nk)); }
      }
    }
    out.push(group);
  }
  return out;
}

// nearestWaterDelta — offset to the closest flooded water cell, read from the SET the flood built (no block
// reads). It is what gives "nearest the water first" and "toward the water" a meaning on a bank that bends.
function nearestWaterDelta(waterSet, x, z, maxR) {
  let best = null, bestD = Infinity;
  for (let dx = -maxR; dx <= maxR; dx++) {
    for (let dz = -maxR; dz <= maxR; dz++) {
      const d = dx * dx + dz * dz;
      if (d >= bestD || !waterSet.has(`${x + dx},${z + dz}`)) continue;
      bestD = d; best = { dx, dz };
    }
  }
  return best;
}

// touchesWater — would a hole dug in this cell have water beside it? The four cardinals at the cell's own level;
// an unsensed side counts as wet (Invariant B — an unread neighbour is not a dry one).
function touchesWater(scan, x, y, z) {
  for (const [dx, dz] of CARDINALS) {
    const b = scan.blockAt(x + dx, y, z + dz);
    if (!b || isFluid(b.name)) return true;
  }
  return false;
}

// tupleLayer — LAYER 3: the pool becomes plots, one column at a time.
// ORDER: nearest the water first (Chebyshev ring to the nearest water cell), then x, then z. Nearest first is
// what makes a bank's first row the crops rather than the walkway: the waterline row claims its crops before the
// row behind it is asked, and the row behind becomes their shared walkway. The x/z tie-break walks a straight
// bank end to end, so a row fills contiguously and deterministically.
// A COLUMN BECOMES A CROP when all of these hold, tested in this order and tallied by the first that fails:
//   onStand        — it is not already a chosen stand
//   digBesideWater — it touches water only if its ground is TILLED_IN_PLACE (see the header's dig rule)
//   penalty        — adding it penalises neither itself nor a chosen crop
//   noStand / waterLocked — a cardinal neighbour at seaY passes the column rule (else noStand) and has a land
//                    approach with this crop counted as farmland (else waterLocked). Preference: a stand already
//                    chosen (a shared walkway), then the side toward the water, then the side away from it, then
//                    along the bank — away before along, so a waterline crop leaves its row-mates free to be crops.
//   strands        — it is not the last land approach of a stand already chosen
async function tupleLayer(scan, pool, waterSeen, pace) {
  const tally = { onStand: 0, digBesideWater: 0, penalty: 0, noStand: 0, waterLocked: 0, strands: 0 };
  const crops = new Map();          // "x,z" → plot
  const stands = new Map();         // "x,z" → stand cell
  const plots = [];
  const order = [];
  for (const c of pool) {
    const near = nearestWaterDelta(waterSeen, c.x, c.z, HYDRATION_RADIUS);
    if (near) order.push({ c, near, ring: Math.max(Math.abs(near.dx), Math.abs(near.dz)) });
    await pace();
  }
  order.sort((a, b) => a.ring - b.ring || a.c.x - b.c.x || a.c.z - b.c.z);
  const sideRank = (dot) => (dot > 0 ? 0 : dot < 0 ? 1 : 2);

  for (const { c, near } of order) {
    await pace();
    const key = `${c.x},${c.z}`;
    if (stands.has(key)) { tally.onStand++; continue; }
    const wet = touchesWater(scan, c.x, c.y, c.z);
    if (wet && !c.tilledInPlace) { tally.digBesideWater++; continue; }
    const withMe = (x, z) => (x === c.x && z === c.z) || crops.has(`${x},${z}`);
    let penalised = growthPenalized(c.x, c.z, withMe);
    for (let dx = -1; dx <= 1 && !penalised; dx++) for (let dz = -1; dz <= 1 && !penalised; dz++) {
      if ((dx || dz) && crops.has(`${c.x + dx},${c.z + dz}`) && growthPenalized(c.x + dx, c.z + dz, withMe)) penalised = true;
    }
    if (penalised) { tally.penalty++; continue; }

    const sides = CARDINALS
      .map(([ox, oz]) => ({ x: c.x + ox, z: c.z + oz, key: `${c.x + ox},${c.z + oz}`, dot: ox * near.dx + oz * near.dz }))
      .sort((a, b) => (stands.has(b.key) - stands.has(a.key)) || sideRank(a.dot) - sideRank(b.dot));
    let stand = null, sawColumn = false;
    for (const s of sides) {
      if (crops.has(s.key)) continue;
      if (stands.has(s.key)) {
        if (hasLandApproach(scan, s.x, c.y, s.z, withMe)) { stand = stands.get(s.key); break; }
        sawColumn = true; continue;
      }
      const sv = plotColumn(scan, s.x, c.y, s.z);
      if (!usableColumn(sv)) continue;
      sawColumn = true;
      if (!hasLandApproach(scan, s.x, c.y, s.z, withMe)) continue;
      stand = { x: s.x, y: c.y, z: s.z, key: `${s.x},${c.y},${s.z}`, terraform: sv.kind === 'terraform' };
      break;
    }
    if (!stand) { sawColumn ? tally.waterLocked++ : tally.noStand++; continue; }

    let strands = false;
    for (const [ox, oz] of CARDINALS) {
      const nk = `${c.x + ox},${c.z + oz}`;
      if (!stands.has(nk) || stands.get(nk) === stand) continue;
      if (!hasLandApproach(scan, c.x + ox, c.y, c.z + oz, withMe)) { strands = true; break; }
    }
    if (strands) { tally.strands++; continue; }

    const plot = { crop: c, stand, besideWater: wet };
    crops.set(key, plot);
    stands.set(`${stand.x},${stand.z}`, stand);
    plots.push(plot);
  }
  return { plots, tally };
}

// cutField — LAYER 4: biggest cluster first, topped up from the next biggest while short. A cluster larger than
// what is still needed gives the plots nearest its own centre — the densest part of it, and a subset that keeps
// every property the whole set had: removing a crop never creates a growth penalty and never takes a stand's
// approach away. Distance from the origin only breaks a tie in cluster size.
function cutField(plots, target, origin) {
  const byCrop = new Map(plots.map(p => [p.crop.key, p]));
  const meshes = unionPatches(plots.map(p => p.crop), ROW_MESH_GAP)
    .map(cells => ({ plots: cells.map(c => byCrop.get(c.key)), dist: Math.min(...cells.map(c => planarDist(origin, c.x, c.z))) }))
    .sort((a, b) => b.plots.length - a.plots.length || a.dist - b.dist);
  const field = [];
  let used = 0;
  for (const mesh of meshes) {
    const need = target - field.length;
    if (need <= 0) break;
    used++;
    if (mesh.plots.length <= need) { field.push(...mesh.plots); continue; }
    const cx = mesh.plots.reduce((s, p) => s + p.crop.x, 0) / mesh.plots.length;
    const cz = mesh.plots.reduce((s, p) => s + p.crop.z, 0) / mesh.plots.length;
    const d = (p) => (p.crop.x - cx) ** 2 + (p.crop.z - cz) ** 2;
    field.push(...mesh.plots.slice().sort((a, b) => d(a) - d(b) || a.crop.x - b.crop.x || a.crop.z - b.crop.z).slice(0, need));
  }
  return { field, clusterSizes: meshes.map(m => m.plots.length), clustersUsed: used };
}

// emptyScan — the no-water return. Must mirror the real return's shape exactly (Law 10): it feeds the same log
// line and the same bench readers, and a missing key surfaces as `undefined` in a report rather than an error.
function emptyScan(scan, t0, columnsSwept) {
  return {
    field: [], keptTotal: 0, poolSize: 0, candidates: 0, plotsAvailable: 0,
    onStand: 0, digBesideWater: 0, penaltyRejects: 0, noStand: 0, waterLocked: 0, strands: 0,
    distinctStands: 0, sharedStands: 0, besideWater: 0, waterCells: 0, bodiesFound: 0, bodySizes: [],
    columnsSwept, cellsRead: scan.stats.reads, reachedTarget: false,
    clusterSizes: [], clustersUsed: 0, farmY: null, hydratedPlots: 0, dryPlots: 0, maxTupleGap: null,
    terraformedCrops: 0, terraformedStands: 0,
    bank: { candidate: 0, terraform: 0, wouldFlow: 0, buried: 0, notSolid: 0, unloaded: 0 }, refusedBy: [],
    elapsedMs: Date.now() - t0, penaltyFree: true, noCropIsStand: true, clustering: null, clusters: null, meshCount: 0,
  };
}

// scanWheatPlots — the WHOLE-AREA sea-level scan (v6). No early exit anywhere: the biggest cluster can only be
// chosen from a picture that holds every candidate, and a stop at "enough" is a stop at whichever lake came first.
//   1. SWEEP + FLOOD — every column of every chunk loaded when the scan starts; each sea-level water source not
//      already flooded starts a body, flooded to exhaustion at seaY. The loaded area is the bound — an unloaded
//      cell is not water — so no radius is imposed on top of it. (A fixed square around the body did that before
//      and dropped banks in view: the server's view reaches past a square's edges and the body is rarely at the
//      view's centre by the time the scan runs.)
//      ANY sea-level water, whatever its biome: a river's biome is narrower than its water, so the edge water
//      carries the land's biome and a biome-gated flood stops a cell short of every bank.
//   2. LAND — a water cell with a cardinal neighbour that is not sea water is SHORE, and only a shore cell opens
//      the 9×9 hydration box. Exact, not a sample: a bank cell within 4 of some water is within 4 of a shore cell
//      (walk the monotone cardinal path from that water toward the bank; its last water cell has a dry neighbour
//      and sits no farther away), so an ocean's interior costs 4 reads a cell instead of 81.
//   3. TUPLES (tupleLayer)   4. CUT (cutField).
// Every crop is pinned to seaY. Returns { field:[{crop,stand,besideWater}], … }. `target: Infinity` returns every
// plot in the loaded area. `combatGate: false` is for a reader with no fleet behind it (the benches).
async function scanWheatPlots(bot0, { origin, target = TARGET, seaY = DEFAULT_SEA_Y, combatGate = true } = {}) {
  if (typeof bot0?.world?.getColumns !== 'function') {
    throw new Error('[wheat_plot_scanner] CODING VIOLATION (Law 13): the scan reads the whole loaded area, and this ' +
      'bot exposes no world.getColumns() to say what that area is. Hand it a connected mineflayer bot or a loaded voxel snapshot.');
  }
  // THE FRONT DOOR: both needs declared here are type-derivable — name + boundingBox for the column rule, and
  // water SOURCE-ness, which is part of the block state (voxel_reader's TYPE_DERIVABLE note) — so the whole scan
  // runs off the number table.
  const scan = makeVoxelScan(bot0, { needs: ['type', 'water'], source: 'wheat_scan', combatGate });
  const pace = scan.pace;
  const t0 = Date.now();
  const isSeaWater = (x, z) => scan.isWaterSource(x, seaY, z);

  const waterSeen = new Map();     // "x,z" → id of the body that flooded it
  const seenCell = new Set();      // box cells already judged — hydration boxes overlap
  const pool = [];                 // usable crop columns
  const bodies = [];               // { id, waterCells }
  const bank = { candidate: 0, terraform: 0, wouldFlow: 0, buried: 0, notSolid: 0, unloaded: 0 };
  const refusedBy = new Map();     // what refused a column, by block name — the actionable half of a short field

  const flood = async (sx, sz) => {
    const body = { id: bodies.length, waterCells: 0 };
    bodies.push(body);
    waterSeen.set(`${sx},${sz}`, body.id);
    const stack = [{ x: sx, z: sz }];
    while (stack.length) {
      const w = stack.pop();
      body.waterCells++;
      let shore = false;
      for (const [dx, dz] of CARDINALS) {
        const wx = w.x + dx, wz = w.z + dz, wk = `${wx},${wz}`;
        if (waterSeen.has(wk)) continue;
        if (isSeaWater(wx, wz)) { waterSeen.set(wk, body.id); stack.push({ x: wx, z: wz }); continue; }
        shore = true;
      }
      await pace();
      if (!shore) continue;
      for (let nx = w.x - HYDRATION_RADIUS; nx <= w.x + HYDRATION_RADIUS; nx++) {
        for (let nz = w.z - HYDRATION_RADIUS; nz <= w.z + HYDRATION_RADIUS; nz++) {
          const k = `${nx},${nz}`;
          if (seenCell.has(k)) continue;
          seenCell.add(k);
          const v = plotColumn(scan, nx, seaY, nz);
          if (!v) continue;                      // water: a body's own cell, not a bank
          bank[v.kind]++;
          if (v.by) refusedBy.set(v.by, (refusedBy.get(v.by) || 0) + 1);
          if (usableColumn(v)) {
            pool.push({
              x: nx, y: seaY, z: nz, key: `${nx},${seaY},${nz}`, terraform: v.kind === 'terraform',
              tilledInPlace: TILLED_IN_PLACE.has(scan.blockAt(nx, seaY, nz).name),
            });
          }
          await pace();
        }
      }
    }
  };

  // ── LAYER 1: every loaded column, nearest chunk first so body ids read outward from the origin. ──
  const columns = bot0.world.getColumns()
    .map(({ chunkX, chunkZ }) => ({ cx: Number(chunkX), cz: Number(chunkZ) }))
    .sort((a, b) => planarDist(origin, a.cx * 16 + 8, a.cz * 16 + 8) - planarDist(origin, b.cx * 16 + 8, b.cz * 16 + 8));
  for (const { cx, cz } of columns) {
    for (let dx = 0; dx < 16; dx++) {
      for (let dz = 0; dz < 16; dz++) {
        const x = cx * 16 + dx, z = cz * 16 + dz;
        if (!waterSeen.has(`${x},${z}`) && isSeaWater(x, z)) await flood(x, z);
      }
      await pace();
    }
  }
  if (!bodies.length) return emptyScan(scan, t0, columns.length);

  // ── LAYERS 3 and 4 ──
  const { plots, tally } = await tupleLayer(scan, pool, waterSeen, pace);
  const { field, clusterSizes, clustersUsed } = cutField(plots, target, origin);

  const cropKeys = new Set(field.map(p => p.crop.key));
  const distinctStands = new Set(field.map(p => p.stand.key)).size;
  return {
    field, keptTotal: field.length, poolSize: pool.length, candidates: pool.length,
    plotsAvailable: plots.length,
    onStand: tally.onStand, digBesideWater: tally.digBesideWater, penaltyRejects: tally.penalty,
    noStand: tally.noStand, waterLocked: tally.waterLocked, strands: tally.strands,
    // Every cluster the tuples formed, biggest first — the field was cut from the first `clustersUsed`.
    clusterSizes, clustersUsed,
    // HOW MUCH GROUND THIS FIELD MOVES — the cost of the terraform ruling, counted rather than assumed.
    terraformedCrops: field.filter(p => p.crop.terraform).length,
    terraformedStands: new Set(field.filter(p => p.stand.terraform).map(p => p.stand.key)).size,
    // THE PIN, RE-DERIVED RATHER THAN ASSERTED (Law 25): `farmY` reads seaY and `dryPlots` zero on every run.
    farmY: field.length ? field[0].crop.y : null,
    hydratedPlots: field.filter(p => hydrated(p.crop, seaY)).length,
    dryPlots: field.filter(p => !hydrated(p.crop, seaY)).length,
    // The tuple rule re-derived off the finished field: one cardinal step at one Y, so 1 on every plot.
    maxTupleGap: field.length ? Math.max(...field.map(p => dist3(p.stand, p.crop))) : null,
    // Crops on soil right against the water — tilled where they lie, never dug (the dig-beside-water rule).
    besideWater: field.filter(p => p.besideWater).length,
    bank, refusedBy: [...refusedBy].sort((a, b) => b[1] - a[1]).slice(0, 4),
    meshCount: field.length ? unionPatches(field.map(p => p.crop), ROW_MESH_GAP).length : 0,
    distinctStands, sharedStands: field.length - distinctStands,
    waterCells: bodies.reduce((a, b) => a + b.waterCells, 0),
    bodiesFound: bodies.length, bodySizes: bodies.map(b => b.waterCells).sort((a, b) => b - a),
    columnsSwept: columns.length, cellsRead: scan.stats.reads, reachedTarget: field.length >= target,
    elapsedMs: Date.now() - t0,
    penaltyFree: verifyNoPenalty(field.map(p => p.crop)),
    noCropIsStand: field.every(p => !cropKeys.has(p.stand.key)),
    clustering: field.length ? clustering(field.map(p => p.crop)) : null,
    clusters: field.length ? clusterReport(field, origin) : null,
  };
}

// clustering — "how close together are the tiles?" bbox footprint + nearest-neighbour spacing + adjacency.
function clustering(tiles) {
  const xs = tiles.map(t => t.x), ys = tiles.map(t => t.y), zs = tiles.map(t => t.z);
  const bbox = { dx: Math.max(...xs) - Math.min(...xs) + 1, dy: Math.max(...ys) - Math.min(...ys) + 1, dz: Math.max(...zs) - Math.min(...zs) + 1 };
  let nnSum = 0, nnMax = 0, adjacent = 0;
  for (let i = 0; i < tiles.length; i++) {
    let nn = Infinity;
    for (let j = 0; j < tiles.length; j++) { if (i === j) continue; const d = dist3(tiles[i], tiles[j]); if (d < nn) nn = d; }
    nnSum += nn; nnMax = Math.max(nnMax, nn); if (nn <= Math.SQRT2 + 0.01) adjacent++;
  }
  return { bbox, nnMean: nnSum / tiles.length, nnMax, adjacentFrac: adjacent / tiles.length };
}

// clusterReport — the field can land as ONE continuous mesh or several; the plot COUNT hides which. It re-derives
// the meshes of the finished field by the SAME mesh rule that cut it (Law 16, Law 6 — a report grouping by another
// rule would describe a field nobody considered) and measures each: size, footprint, rows, nearest distance to
// the origin, and how far the meshes sit from one another. `rows` counts distinct lines along whichever axis has
// fewer — how far the pattern reaches, which a bounding box cannot show.
function clusterReport(field, origin) {
  const bodies = unionPatches(field.map(p => p.crop), ROW_MESH_GAP);
  const clusters = bodies.map(cells => {
    const xs = cells.map(c => c.x), zs = cells.map(c => c.z);
    const perX = new Map(), perZ = new Map();
    for (const c of cells) {
      perX.set(c.x, (perX.get(c.x) || 0) + 1);
      perZ.set(c.z, (perZ.get(c.z) || 0) + 1);
    }
    const lines = perX.size <= perZ.size ? perX : perZ;
    return {
      size: cells.length,
      bbox: { dx: Math.max(...xs) - Math.min(...xs) + 1, dz: Math.max(...zs) - Math.min(...zs) + 1 },
      rows: lines.size,
      longestRow: Math.max(...lines.values()),
      centroid: { x: Math.round(xs.reduce((a, b) => a + b, 0) / cells.length), z: Math.round(zs.reduce((a, b) => a + b, 0) / cells.length) },
      distFromOrigin: Math.min(...cells.map(c => planarDist(origin, c.x, c.z))),
    };
  }).sort((a, b) => a.distFromOrigin - b.distFromOrigin);
  let minGap = Infinity, maxGap = 0;
  for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
    let m = Infinity;
    for (const p of bodies[a]) for (const q of bodies[b]) m = Math.min(m, dist3(p, q));
    minGap = Math.min(minGap, m); maxGap = Math.max(maxGap, m);
  }
  return {
    count: clusters.length, clusters,
    interClusterMinGap: bodies.length > 1 ? minGap : null,
    interClusterMaxGap: bodies.length > 1 ? maxGap : null,
  };
}

// plotRotation — the quarterTurns a plot instance needs so its dirt/crop voxel (blueprint-local +x from the
// stand_ground anchor at the origin) lands on THIS plot's crop. build_center is the STAND; the crop sits one
// cardinal step away. rotateOffsetY(1,0,q) maps local +x to:
//   q0 → (+1,0) E   q1 → (0,-1) N   q2 → (-1,0) W   q3 → (0,+1) S   (blueprint_survey.rotateOffsetY convention)
// Chosen PER PLOT: a tuple's stand may lie on any side of its crop. Y is not rotated — stand and crop share seaY,
// which is the offset the fixed blueprint already carries.
// Throws on a non-cardinal offset — a coding violation, since tupleLayer only pairs cardinal neighbours (Law 13).
function plotRotation(stand, crop) {
  const dx = crop.x - stand.x, dz = crop.z - stand.z;
  if (dx === 1 && dz === 0) return 0;
  if (dx === 0 && dz === -1) return 1;
  if (dx === -1 && dz === 0) return 2;
  if (dx === 0 && dz === 1) return 3;
  throw new Error(`[wheat_plot_scanner] CODING VIOLATION: stand→crop offset (${dx},${dz}) is not a unit cardinal — tupleLayer pairs only cardinal neighbours. Plot stand (${stand.x},${stand.y},${stand.z}) crop (${crop.x},${crop.y},${crop.z}).`);
}


// ── THE LOADED AREA MUST HAVE ARRIVED BEFORE ANYTHING IS JUDGED FROM IT ──────────────────────────────────
// Here rather than in lock_all_buildspots since wheat_site_probe became its second caller: one wait, two callers
// (Law 16). ARRIVED MEANS EVERY COLUMN IN VIEW IS HERE — "stopped growing" was measured not to mean that: the
// server pauses while it GENERATES terrain, and a four-second quiet once read a third of the area as all of it.
// So the wait ends when every chunk of the server's view around the body is loaded (inServerView). An inner disc
// was used before on the argument that it sits inside every shape a server sends; it does, and that is why it
// ended the wait with a quarter of the view still streaming — the scan then read only what had come.
// inServerView — the vanilla server's membership test for a player's view (ChunkTrackingView.isWithinDistance
// with its neighbour margin on): each axis distance less 2, floored at 0, squared and summed, strictly under
// viewDistance². Measured against a connected client at view distance 10: 473 chunks held once settled, every
// one inside this shape and none outside it. A server that sends a smaller view meets the cap and says so.
function inServerView(cx, cz, viewDistance, x, z) {
  const dx = Math.max(0, Math.abs(x - cx) - 2), dz = Math.max(0, Math.abs(z - cz) - 2);
  return dx * dx + dz * dz < viewDistance * viewDistance;
}
const SETTLE_POLL_MS = 1000;
const SETTLE_MAX_MS = 120000;    // past this the shortfall is reported, not waited on
async function loadedAreaSettled(bot) {
  const t0 = Date.now();
  const vd = bot.game.serverViewDistance;
  if (!Number.isInteger(vd) || vd < 2) {
    throw new Error(`[wheat_plot_scanner] CODING VIOLATION (Law 13): the server's view distance was not announced ` +
      `(bot.game.serverViewDistance=${vd}), so there is no way to know when the loaded area has arrived.`);
  }
  const r = vd + 2;
  const disc = [];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (inServerView(0, 0, vd, dx, dz)) disc.push([dx, dz]);
  const missing = () => {
    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    return disc.filter(([dx, dz]) => !bot.world.getColumnAt(new Vec3((cx + dx) * 16, 0, (cz + dz) * 16))).length;
  };
  let left = missing();
  while (left > 0 && Date.now() - t0 < SETTLE_MAX_MS) {
    await new Promise(res => setTimeout(res, SETTLE_POLL_MS));
    left = missing();
  }
  return {
    columns: bot.world.getColumns().length, secs: ((Date.now() - t0) / 1000).toFixed(0),
    settled: left === 0, missing: left, disc: disc.length, viewDistance: vd,
  };
}
function settleLine(s) {
  return `${FARM_BLUEPRINT_NAME}: waited ${s.secs}s for the loaded area to arrive — the ${s.disc} chunks of the ` +
    `server's view around the body (view distance ${s.viewDistance}), ${s.columns} chunks held in all` +
    `${s.settled ? '' : `; ${s.missing} STILL missing at the ${SETTLE_MAX_MS / 1000}s cap (scanned anyway)`}.`;
}

// describeScan — the scan's account of itself, one line per question a field raises. The ONE formatter (Law 16):
// the base-layout survey, wheat_site_probe and wheat_ab_test print the same words from the same numbers.
function describeScan(scan, target) {
  const b = scan.bank;
  const goal = Number.isFinite(target) ? `/${target}` : ' (every plot in view)';
  const bodies = `${scan.bodiesFound} sea-level water ${scan.bodiesFound === 1 ? 'body' : 'bodies'}` +
    (scan.bodySizes.length ? ` of ${scan.bodySizes.slice(0, 6).join(', ')}${scan.bodySizes.length > 6 ? ', …' : ''} cells` : '');
  const bankLine = `      ↳ bank columns beside water: ${b.candidate + b.terraform} usable ` +
    `(${b.candidate} already clear, ${b.terraform} one block to take off); refused: ` +
    `${b.buried} solid two blocks up (a terrace, not a bank), ${b.wouldFlow} where the cut would let water in, ` +
    `${b.notSolid} not solid at the waterline, ${b.unloaded} not loaded` +
    `${scan.refusedBy.length ? ` — the blocks doing the refusing: ${scan.refusedBy.map(([n, c]) => `${n}×${c}`).join(', ')}` : ''}.`;
  const tupleLine = `      ↳ tuples: ${scan.poolSize} usable columns → ${scan.plotsAvailable} plots; not a crop because ` +
    `${scan.onStand} already a stand, ${scan.digBesideWater} would be dug out beside water (not soil), ` +
    `${scan.penaltyRejects} growth penalty, ${scan.noStand} no stand column beside it, ${scan.waterLocked} stand only reachable ` +
    `through water, ${scan.strands} would cut off a stand's last way in.`;
  if (!scan.field.length) {
    return `${FARM_BLUEPRINT_NAME}: 0 plots (scan ${(scan.elapsedMs / 1000).toFixed(1)}s over ${scan.columnsSwept} chunks, ${bodies}).\n` +
      tupleLine + '\n' + bankLine;
  }
  const cl = scan.clusters;
  return [
    `${FARM_BLUEPRINT_NAME}: FOUND ${scan.field.length}${goal} plots (scan ${(scan.elapsedMs / 1000).toFixed(1)}s over ${scan.columnsSwept} chunks, ` +
      `${bodies}, ${scan.penaltyFree ? 'all penalty-free' : '⚠ PENALTY PRESENT'}, ${scan.distinctStands} stands serve them, ${scan.waterCells} water-body cells).`,
    tupleLine,
    `      ↳ clusters, biggest first: ${scan.clusterSizes.slice(0, 8).join(', ')}${scan.clusterSizes.length > 8 ? `, … (${scan.clusterSizes.length} in all)` : ''} plots — the field is cut from the first ${scan.clustersUsed}.`,
    `      ↳ crops on plane y=${scan.farmY} — ${scan.hydratedPlots} watered, ${scan.dryPlots} dry` +
      `${scan.dryPlots ? ' ⚠ THE seaY PIN HAS BROKEN — a crop off the waterline cannot be watered' : ''}` +
      `; stand↔crop gap ${scan.maxTupleGap}; ${scan.besideWater} crop(s) on soil against the water, tilled where they lie; ` +
      `the build takes a block off ${scan.terraformedCrops} crop cell(s) and ${scan.terraformedStands} stand(s) first.`,
    bankLine,
    cl && `      ↳ ${cl.count} mesh(es): ` +
      cl.clusters.slice(0, 12).map(c => `${c.size} plots in ${c.rows} row(s), longest ${c.longestRow} @${c.distFromOrigin.toFixed(0)}b (${c.bbox.dx}×${c.bbox.dz})`).join(', ') +
      (cl.count > 12 ? `, …` : '') +
      (cl.count > 1 ? `; meshes ${cl.interClusterMinGap.toFixed(0)}–${cl.interClusterMaxGap.toFixed(0)}b apart.` : '.'),
    Number.isFinite(target) && scan.field.length < target &&
      `      ↳ SHORT ${target - scan.field.length} (idle, not a stop) — the tuple line above says which rule held each column back.`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  scanWheatPlots,
  plotRotation,
  loadedAreaSettled,
  inServerView,
  settleLine,
  describeScan,
  SETTLE_MAX_MS,
  // exported for a live sanity re-check of the MC rule and for benches that extend the overlay:
  growthPenalized,
  verifyNoPenalty,
  plotColumn,
  usableColumn,
  hasLandApproach,
  TARGET,
  DEFAULT_SEA_Y,
};
