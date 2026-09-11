// util: wheat_plot_scanner (farm siting)
// purpose: THE siting authority for the phase-1 ad-hoc wheat field. Given the live bot's voxels, it
//          returns the nearest N (crop, stand) plots that are hydratable, stand-pairable, LAND-REACHABLE,
//          and mutually PENALTY-FREE, then stops. lock_all_buildspots locks each returned plot as one `wheat_plot_pair`
//          blueprint instance; find_buildingspot does NOT site these — its local per-spot fit knows nothing
//          of the hydration Y-rule or the cross-plot penalty graph, which are the entire point (Law 16: one
//          siting pathway for this field, and it is this one). Promoted OUT of a bench probe into this
//          module so the fleet runs it directly, in place of the retired Tier 1 scenario whose subject the
//          live fleet now exercises every run.
//
// THE MODEL — a plot's structure:
//   A plot is a TUPLE — a CROP cell and a STAND cell (mini-anchor). Reuse is ASYMMETRIC:
//     • a STAND cell may be SHARED by several crops (a walkway serving a row);
//     • a STAND cell may NEVER be a CROP, and a CROP never a stand (you can't stand on farmland — a jump
//       trashes the till). So cropCells is exclusive; standCells is shareable; the two sets are disjoint.
//   NEITHER cell has to be dirt/grass: the bot stands on the anchor and DIGS + PLACES DIRT on the crop cell.
//   A crop cell is any solid block with air above; an anchor is any solid block with head-room.
//
//   REACHABILITY: passing `standable` proves a stand is dry to STAND ON — it does NOT prove the
//   bot can WALK there. A lone solid block at the waterline (water/air on every side) is standable yet an
//   ISLAND: the navigator wades toward it, battle_stations abandons the visit to reach land, and the manager
//   re-picks the same nearest plot forever. So a fresh stand ALSO needs a LAND APPROACH — ≥1 coplanar
//   cardinal neighbour that is itself standable land and is not a crop (crops become farmland — the bot never
//   walks onto one). One dry walkable neighbour = a land side to approach from; zero = a water island, reject
//   (telemetry: waterLocked). This is the per-tile twin of the blueprint farm's land-ROOTED anchor chain:
//   both refuse a stand the bot could only reach by wading. NOTE it is a ONE-HOP local check, not a pathfind —
//   it kills the isolated-island case cheaply; a full reach oracle would be a new system (Law 22 gate 2).
//
//   HYDRATION Y-RULE: MC hydrates farmland at Y only from a water SOURCE within HYDRATION_RADIUS in x/z AND
//   at Y or Y+1 — never below. So a source at wy serves a crop at wy or wy-1 only.
//
//   FARM Y IS PINNED TO seaY. Every farm sits COPLANAR with the water surface at seaY
//   (62) — the farmland block level with the river/ocean, the wheat one above. WHY the pin: the earlier code
//   also accepted a farmland at wy-1 (one BELOW the source) and water at seaY-1, so near a bank it would site
//   a tile a block under the waterline — the bot then dug a trench down to that sub-bank solid, carving a
//   CHANNEL beside the river. Dropped. A farm is now sited ONLY where a solid
//   block already sits AT seaY with air above (a flat bank lip / beach), hydrated by a source at seaY or
//   seaY+1 within the radius. Trade: grassy banks (grass at seaY+1, its seaY cell buried under the grass, no
//   air above) yield no farm cell — only flat water-level shores qualify — so a lean world reaches fewer than
//   `target`; that is the intended cost of "every farm at exactly seaY", and the shortfall idles unfilled
//   instances (the open no_stand/terraform fallback is the remedy, not un-pinning this).
//
//   MAX-GROWTH SPACING: a crop grows at HALF speed if — within its 3×3 — any of the 4 DIAGONALS holds
//   the same crop, OR BOTH the E/W axis AND the N/S axis hold the same crop. To keep every wheat at full
//   speed the chosen set must be mutually penalty-free. Crops interact ONLY within the same crop-Y layer
//   (the crop sits at farmY+1), so the 3×3 rule is applied per-farmY using (x,z).
//
//   THE STRIPE LATTICE — the layout, and WHY it replaced greedy acceptance.
//   The old model vetted each bank cell for penalty-freedom AS THE WATER BFS REACHED IT, so the layout was
//   an accident of traversal order, and each crop's stand was whichever cardinal `pickAnchor` happened to
//   like — so stand→crop directions came out mixed across one field, an irregular bank measuring all
//   FOUR rotations in one field. Both faults are the same missing decision: nothing ever chose a FIELD AXIS.
//   The lattice chooses one. Going inland from the shore the stripes alternate — WALKWAY, crop, walkway, crop
//   — with the walkway stripe against the water:
//       ~ ~ ~ ~ ~ ~     <- river
//       S S S S S S     <- walkway / stands   (stripe parity 1-p)
//       C C C C C C     <- crops              (stripe parity p)
//       S S S S S S     <- walkway / stands
//       C C C C C C     <- crops
//   Two guarantees fall out, neither of them searched for:
//     • PENALTY-FREE. Crop stripes are 2 apart, so two crops can never be diagonal (needs a 1-stripe offset)
//       and never occupy both axes. Only the along-stripe neighbour is ever occupied — the one arrangement MC
//       leaves at full growth. Nothing in the selection has to check this.
//     • ONE ROTATION. Every crop takes its stand from the same side, so `plotRotation` returns a single value
//       for the whole field.
//   MEASURED, so a successor does not re-derive an optimistic version: this did NOT increase plot density —
//   the old greedy gate was already finding a striped packing on any regular bank; what the lattice fixed is
//   the mixed rotation and the scatter, not the yield.
//   The axis, stripe parity, and stand side are chosen ONCE (best of 8) and applied to every plot.
//
//   STOP AT target: take the tightest set of runs holding `target` plots and exit.
//
// THE STAND IS COPLANAR WITH THE CROP, and now structurally so. These plots lock as `wheat_plot_pair`
// blueprint INSTANCES, and a single fixed blueprint can only be ROTATED about the vertical axis
// (blueprint_survey.rotateOffsetY) — it cannot express a per-instance vertical offset between its
// structural_fill (stand) and dirt (crop) voxels. The old code enforced this with a STAND_DY=[0] search
// constraint; the lattice simply never generates a non-coplanar stand, so the constraint is no longer a
// tunable that could be widened by mistake. Where a world falls short of `target` — counted no_stand (the
// locked stand cell isn't standable) or waterLocked (standable but islanded) — the open fallback
// (dig a stance beside the water-locked cell) is the intended remedy, not relaxing this back.
//
// Reuse, not invention (Law 16): every voxel question — reads, water-source, and pacing — goes through
// the one front door, @utils/voxel_scan_throttle.makeVoxelScan, with this scan's needs declared. The ring
// geometry, tuple reservation, and penalty gate are local.
//
// Pure decision over READ voxels — never transforms the world (Law 22 scope: it operates ON the siting
// record, joins no build pathway). The bot handed in need only satisfy what the reader asks of it: a live
// mineflayer bot exposes a chunk store and gets the fast number-table path, while a bench/virtual bot that
// only answers blockAt gets the full-read path automatically and returns identical plots — one module
// serves production and test, and neither had to be told which it was talking to.

'use strict';

const { makeVoxelScan } = require('@utils/voxel_scan_throttle');

// ── TUNABLES — the forks retuned at the table (Law 21) ────────────────────────────────
const HYDRATION_RADIUS = 4;   // MC farmland hydrates from water within 4 in x/z (square). 4 = the game rule.
const PLANTABLE_ABOVE = new Set(['air', 'cave_air', 'void_air']); // crop room / head-room must be genuine air.
const TARGET = 32;            // 2 farms' worth. Nearest 32 stand-paired crops, then exit.
const OVERCOLLECT = 3;        // collect OVERCOLLECT×target CANDIDATE CELLS before clustering. NOTE what a
                              // candidate is now: a raw hydratable bank cell (gate 1 only). Under the old greedy
                              // model a pooled cell was an already-vetted plot, so 2× meant 64 buildable plots;
                              // under the stripe lattice only the on-stripe half can become crops, so 3×32 = 96
                              // candidates yields roughly 40 plots before stand-vetting. THIS IS THE DIAL if live
                              // fields come up short of target — the yield consequence is measured, retune at the table.
const PLOTS_PER_CANDIDATE = 0.5;  // the stripe lattice's structural yield — half of any bank is walkway. Used
                              // ONLY to judge "can this river host the farm, or should I try the next one";
                              // it is a lower bound on a clean bank, so a rough bank just re-seeds sooner.
// (LATTICE_SAMPLE removed with the sampled fit — the lattice is now scored by the size of the
//  biggest contiguous PLOT cluster, which a sample cannot measure: sampling the candidates tells you how many
//  plots fit, not whether they sit together, and "how many" was exactly the wrong question. Live cost of the
//  full 8-lattice fit was measured at a fraction of the shoreline flood, so there is nothing to sample for.)
const CLUSTER_GAP = 3;        // raw-CANDIDATE grouping only (the "is this river worth continuing?" proxy). NOT
                              // the farm's cluster rule — see MESH below; a euclidean gap was what let a
                              // "cluster" hop a narrow river and count both banks as one.
const ROW_MESH_GAP = 2;       // crop-row spacing under the penalty rule — the tightest honest 'same mesh' test.
const DEFAULT_SEA_Y = 62;     // rivers/oceans sit here (fixed-sea-level world generation).
const MAX_RADIUS = 160;       // backstop only; stop-at-target + the loaded frontier end the scan first.
const UNLOADED_RING_STOP = 2; // consecutive all-unloaded rings ⇒ loaded frontier reached.
const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// (countingBot removed — the read tally moved INTO the reader. The Proxy existed to count
//  blockAt calls including those inside isWaterSource; the scan now asks its water question through the
//  same reader as everything else, so `scan.stats.reads` counts every read by construction and there is
//  nothing left for a Proxy to wrap. That also removed a per-read Proxy trap from the hot loop.)

function* ringCells(cx, cz, r) {              // square-ring perimeter at Chebyshev radius r, nearest-first
  if (r === 0) { yield [cx, cz]; return; }
  for (let x = cx - r; x <= cx + r; x++) { yield [x, cz - r]; yield [x, cz + r]; }
  for (let z = cz - r + 1; z <= cz + r - 1; z++) { yield [cx - r, z]; yield [cx + r, z]; }
}
function planarDist(o, x, z) { const dx = x - o.x, dz = z - o.z; return Math.sqrt(dx * dx + dz * dz); }
function dist3(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

// solidWithAirAbove — a CROP cell: any solid block (bot digs it + places dirt) with crop room above.
function solidWithAirAbove(scan, x, y, z) {
  const here = scan.blockAt(x, y, z);
  if (!here || here.boundingBox !== 'block') return false;
  const above = scan.blockAt(x, y + 1, z);
  return !!above && PLANTABLE_ABOVE.has(above.name);
}

// standable — an ANCHOR: any solid block with two air cells above (the bot's body fits).
function standable(scan, x, y, z) {
  const base = scan.blockAt(x, y, z);
  if (!base || base.boundingBox !== 'block') return false;
  const h1 = scan.blockAt(x, y + 1, z);
  const h2 = scan.blockAt(x, y + 2, z);
  return !!h1 && !!h2 && PLANTABLE_ABOVE.has(h1.name) && PLANTABLE_ABOVE.has(h2.name);
}

// growthPenalized — MC crop rule at (x,z) given a same-layer occupancy predicate `has`.
//   penalty if any of the 4 diagonals is the same crop, OR both axes (N/S and E/W) carry the same crop.
function growthPenalized(x, z, has) {
  const diag = has(x - 1, z - 1) || has(x - 1, z + 1) || has(x + 1, z - 1) || has(x + 1, z + 1);
  const ns = has(x, z - 1) || has(x, z + 1);
  const ew = has(x - 1, z) || has(x + 1, z);
  return diag || (ns && ew);
}

// (keepsFullGrowth removed — it was the greedy per-cell spacing gate the stripe lattice makes
//  unnecessary: a lattice row is penalty-free by construction, so there is nothing left to reject. Kept as
//  a note because its absence is the surprising part: `growthPenalized` still exists and is still the rule,
//  it is now ENFORCED BY THE LAYOUT and only VERIFIED after the fact by verifyNoPenalty.)

// verifyNoPenalty — independent check of a finished field (used by the self-check and a live sanity print).
function verifyNoPenalty(cells) {
  const byY = new Map();
  for (const c of cells) { if (!byY.has(c.y)) byY.set(c.y, new Set()); byY.get(c.y).add(`${c.x},${c.z}`); }
  return cells.every(c => { const layer = byY.get(c.y); return !growthPenalized(c.x, c.z, (x, z) => layer.has(`${x},${z}`)); });
}

// hasLandApproach — is this stand REACHABLE on foot, or a water island? See the REACHABILITY note in the
// header. A stand needs ≥1 coplanar cardinal neighbour the bot could stand on (standable land) that is NOT a
// crop cell — crops become farmland the bot may never walk onto, so they are not a walkway. Other walkway
// cells count (a shared walkway is a valid approach); water/air neighbours do not (not standable). One dry
// walkable neighbour ⇒ a land side to approach from; zero ⇒ an island the navigator can only reach by wading
// (the water-wading loop this rejects). Under the lattice the approach normally comes along the walkway stripe. ONE hop only — not
// a transitive pathfind; that would be a new system (Law 22 gate 2). Up to 4 standable probes, bounded.
// `isCrop(x,z)` is the LATTICE predicate, not a set of committed cells: under the stripe model every cell on
// a crop stripe is farmland (or will be), so the walkway test must exclude the whole stripe rather than only
// the crops chosen so far. That is strictly more conservative than the old committed-set test and removes the
// order dependence — the answer no longer depends on how far the scan had got when it asked.
function hasLandApproach(scan, sx, sy, sz, isCrop) {
  for (const [dx, dz] of CARDINALS) {
    const nx = sx + dx, nz = sz + dz;
    if (isCrop(nx, nz)) continue;                        // a crop is farmland, never a walkway
    if (standable(scan, nx, sy, nz)) return true;        // a dry, walkable land cell beside the stand
  }
  return false;
}

// ── INDEPENDENT PLOTS ON A WATER-SIDE-ANCHORED LATTICE ───────────────────────────
// Each plot stands independently rather than as a locked row, with the stand block always against the water,
// every plot sharing one rotation, and selection ranked by closest cluster first — density and closeness
// outrank raw distance from base.
//
// THE ANCHOR-AGAINST-WATER RULE is a SAFETY rule, not an aesthetic one, and it is the reason this geometry is
// not negotiable: a crop cell is dug and re-placed by the bot, so a crop directly beside a water source is one
// mistake away from flooding its own hole — and a flooded cell is far harder to re-place into than an empty
// one. Putting the walkway between the water and every crop means the cell the bot digs never touches water.
//
// THE DIAGONAL WORRY RESOLVES ITSELF — this is why crops need no per-cell penalty search. Alternating inland
// from the shore (anchor, crop, anchor, crop) puts every CROP stripe exactly 2 apart, so two crops can never be
// diagonal (that needs a 1-stripe offset) and can never occupy both axes; only the along-stripe neighbour is
// ever occupied, the one arrangement MC leaves at full growth. Penalty-freedom is a property of the stripe
// parity, not of anything the selection does.
//
// ROTATION IS GLOBAL, so every plot is identical: the lattice fixes one (axis, parity, dir) for the whole
// field, and a cell whose local bank does not agree with it simply is not a plot. That is also what keeps the
// field on ONE side of one bank without a side-detection test.
//
// MINIMUM RUN — this is the part a successor is most likely to undo, so the evidence is here. Dropping the
// run requirement and selecting individual plots by tightest BOUNDING BOX looked equivalent and measured
// worse: the field fragmented into far more disconnected pieces at an unchanged span. Density-inside-a-bbox
// and CONTINUITY are different objectives, and a sparse scatter can score well on the first while failing the
// second — a small bbox says the plots are near each other, not that they adjoin. Requiring a contiguous run
// forces the selection into genuinely dense stretches of bank, which measurably improves cohesion.
//
// THE MODES ARE GONE (Law 16). Three arms — parallel, perpendicular, adaptive — existed to compare layout
// strategies and are deleted now that it is settled: `adaptive` (stand on either side per plot) doubled the
// legal plot count and produced a byte-identical farm, so its extra rotation bought nothing; `perpendicular`
// was denser but put the CROP against the water, which is the flooding failure this geometry exists to
// prevent. One capability, one implementation, and the surviving one is the flood-safe one.
const MIN_RUN = 4;
const LATTICES = [
  { axis: 'x', dir: 1 }, { axis: 'x', dir: -1 },
  { axis: 'z', dir: 1 }, { axis: 'z', dir: -1 },
];
const parityOf = (v) => ((v % 2) + 2) % 2;      // JS % is signed; stripes must not flip across 0

// unionPatches — single-link grouping of coplanar cells: two share a group when they sit within `gap`. Grid
// flood-fill, not O(n²) pairwise — the candidate pool runs to thousands of cells once the scan surveys a whole
// shoreline. Exact for the coplanar sets this module produces (every cell at seaY). Two callers, two gaps: the
// coarse "is this river worth continuing" check on raw candidates (CLUSTER_GAP), and the finished field's
// piece-count (ROW_MESH_GAP).
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

// biggestPatchCells — largest contiguous run of raw candidates, for the multi-body "is this river enough?"
// test. A coarse proxy on CANDIDATES: it only has to answer whether re-seeding at another river is worth the
// flood, and running the full lattice search per body to decide that would cost more than the flood it avoids.
function biggestPatchCells(cells) {
  let best = 0;
  for (const p of unionPatches(cells, CLUSTER_GAP)) if (p.length > best) best = p.length;
  return best;
}

// nearestWaterDelta — offset to the closest flooded water cell, read from the SET the flood already built (no
// block reads). This is what lets "against the water" and "inland" mean something on a river that bends.
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

// buildPlots — every plot this lattice yields. `waterDir` is precomputed per cell (once for all 8 lattices)
// because nearestWaterDelta is the one expensive non-block-read in the pass and does not depend on the lattice.
function buildPlots(scan, pool, waterDir, { axis, parity, dir }, tally) {
  const plots = [];
  const isCropStripe = (x, z) => parityOf(axis === 'x' ? x : z) === parity;
  for (const c of pool) {
    if (!isCropStripe(c.x, c.z)) { tally.offStripe++; continue; }
    const near = waterDir.get(c.key);
    if (!near) { tally.noWater++; continue; }
    // The stand→crop offset this lattice imposes, and the direction the water lies in.
    const offX = axis === 'x' ? dir : 0, offZ = axis === 'x' ? 0 : dir;
    // THE TEST IS THE SAFETY PROPERTY ITSELF: does stepping from the crop to its stand move TOWARD the water?
    // Nothing more. An earlier version demanded the lattice axis equal the local bank NORMAL axis — a
    // stricter proxy that happens to imply the rule, and it cost most of the field: on a winding river only
    // the stretches facing one exact cardinal survived, scattering the rest of the candidates into many small
    // pieces. Substituting a tighter criterion than the one asked for is its own fault (Law 25); the dot
    // product is the asked-for rule, and it admits every bank orientation that genuinely puts the walkway
    // between the crop and the river.
    if ((-offX) * near.dx + (-offZ) * near.dz <= 0) { tally.wrongFacing++; continue; }
    const s = { x: c.x - offX, y: c.y, z: c.z - offZ, key: `${c.x - offX},${c.y},${c.z - offZ}` };
    if (!standable(scan, s.x, s.y, s.z)) { tally.noStand++; continue; }
    if (!hasLandApproach(scan, s.x, s.y, s.z, isCropStripe)) { tally.waterLocked++; continue; }
    plots.push({ crop: c, stand: s });
  }
  return plots;
}

// buildRuns — split a lattice's plots into maximal CONTIGUOUS runs along each crop stripe, discarding any run
// shorter than MIN_RUN. `axis` indexes the stripes, so a run advances along the other axis. This is the unit
// the field is assembled from; see MINIMUM RUN in the header block for why a run and not a plot.
function buildRuns(plots, axis, minRun) {
  const rowAxis = axis === 'x' ? 'z' : 'x';
  const byStripe = new Map();
  for (const p of plots) {
    const s = p.crop[axis];
    if (!byStripe.has(s)) byStripe.set(s, []);
    byStripe.get(s).push(p);
  }
  const runs = [];
  for (const list of byStripe.values()) {
    list.sort((a, b) => a.crop[rowAxis] - b.crop[rowAxis]);
    let cur = [list[0]];
    for (let i = 1; i < list.length; i++) {
      if (list[i].crop[rowAxis] === list[i - 1].crop[rowAxis] + 1) cur.push(list[i]);
      else { if (cur.length >= minRun) runs.push(cur); cur = [list[i]]; }
    }
    if (cur.length >= minRun) runs.push(cur);
  }
  return runs;
}

// tightestRunSet — the runs that together hold `target` plots and sit closest together. The ranking:
// density first (smallest bounding box = most plots per area), then closeness (smallest span), then distance
// from base LAST — the base follows the farm rather than the farm compromising for it, since other buildings
// are sited relative to the wheat cluster. Every run is tried as the seed and the nearest runs accumulated;
// exhaustive over runs (a few dozen), where a heuristic seed previously produced a visibly worse layout.
function tightestRunSet(runs, target, origin, minRun) {
  const centre = (run) => {
    let sx = 0, sz = 0;
    for (const p of run) { sx += p.crop.x; sz += p.crop.z; }
    return { x: sx / run.length, z: sz / run.length };
  };
  const centres = new Map(runs.map(r => [r, centre(r)]));
  let best = null;
  for (const seed of runs) {
    const ordered = runs.slice().sort((a, b) => d2(centres.get(a), centres.get(seed)) - d2(centres.get(b), centres.get(seed)));
    const sel = [];
    let total = 0;
    for (const r of ordered) {
      if (total >= target) break;
      sel.push(r.slice()); total += r.length;
    }
    // Trim the overshoot one plot at a time off the LONGEST run, and off whichever END of it sits further
    // from the set's centre — so trimming eats the outer edge of the field and never opens a hole in it.
    // A run is never trimmed below minRun; that is the whole constraint, so the overshoot is dropped by
    // removing the farthest run instead when nothing has slack left.
    while (total > target) {
      const c = centre(sel.flat());
      const idx = sel.reduce((b, r, i) => (r.length > sel[b].length ? i : b), 0);
      if (sel[idx].length <= minRun) {
        const far = sel.reduce((b, r, i) => (d2(centre(r), c) > d2(centre(sel[b]), c) ? i : b), 0);
        total -= sel[far].length; sel.splice(far, 1);
        continue;
      }
      const run = sel[idx];
      const dropHead = d2(run[0].crop, c) > d2(run[run.length - 1].crop, c);
      if (dropHead) run.shift(); else run.pop();
      total--;
    }
    const set = sel.flat();
    if (!set.length) continue;
    const area = bboxArea(set), span = spanOf(set);
    const dist = Math.min(...set.map(p => planarDist(origin, p.crop.x, p.crop.z)));
    const beats = !best
      || set.length > best.set.length                      // filling the farm outranks tightness
      || (set.length === best.set.length && (area < best.area
          || (area === best.area && (span < best.span || (span === best.span && dist < best.dist)))));
    if (beats) best = { set, area, span, dist, runs: sel.length };
  }
  return best;
}

function bboxArea(plots) {
  const xs = plots.map(p => p.crop.x), zs = plots.map(p => p.crop.z);
  return (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...zs) - Math.min(...zs) + 1);
}

function spanOf(plots) {
  let m = 0;
  for (let i = 0; i < plots.length; i++) for (let j = i + 1; j < plots.length; j++) {
    m = Math.max(m, d2(plots[i].crop, plots[j].crop));
  }
  return Math.round(Math.sqrt(m));
}

function d2(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }

// chooseLattice — all 8 (axis, parity, dir) combinations, scored by the tightest cluster each can produce.
// One rule at both levels (Law 16): the lattice that wins is the one that yields the densest farm, not the
// one that yields the most plots — a live scan previously exposed "most plots" as the wrong question.
function chooseLattice(scan, pool, waterDir, target, origin) {
  let best = null;
  for (const { axis, dir } of LATTICES) {
    for (const parity of [0, 1]) {
      const tally = { offStripe: 0, noWater: 0, wrongFacing: 0, noStand: 0, waterLocked: 0 };
      const plots = buildPlots(scan, pool, waterDir, { axis, parity, dir }, tally);
      if (!plots.length) continue;
      const runs = buildRuns(plots, axis, MIN_RUN);
      if (!runs.length) continue;
      const cluster = tightestRunSet(runs, target, origin, MIN_RUN);
      if (!cluster) continue;
      const cand = { lattice: { axis, parity, dir }, plots, runs, cluster, tally };
      const beats = !best
        || cand.cluster.set.length > best.cluster.set.length      // filling the farm outranks tightness
        || (cand.cluster.set.length === best.cluster.set.length
            && (cand.cluster.area < best.cluster.area
                || (cand.cluster.area === best.cluster.area && cand.cluster.span < best.cluster.span)));
      if (beats) best = cand;
    }
  }
  return best;
}

// emptyScan — the no-water telemetry shape (keeps the return contract stable for lock_all_buildspots/bench).
function emptyScan(scan, t0, ringCellsSeen, scanRadius, loadedFrontier) {
  return {
    field: [], keptTotal: 0, poolSize: 0, candidates: 0, noStand: 0, waterLocked: 0, penaltyRejects: 0,
    distinctStands: 0, waterCells: 0, bodiesUsed: 0, bodyExhausted: true, ringCellsSeen, cellsRead: scan.stats.reads, reachedTarget: false,
    scanRadius, loadedFrontier, elapsedMs: Date.now() - t0, penaltyFree: true, noCropIsStand: true, clustering: null, clusters: null,
    // Must mirror the real return's shape exactly (Law 10): the no-water path feeds the same log line and the
    // same bench readers, and a missing key here surfaces as `undefined` in a report rather than as an error.
    axis: null, stripeParity: null, standDir: null, offStripe: 0, wrongFacing: 0,
    plotsAvailable: 0, runsAvailable: 0, runsUsed: 0, minRun: MIN_RUN,
    clusterArea: 0, clusterSpan: 0, density: 0, meshCount: 0, unloadedShore: 0,
  };
}

// scanWheatPlots — SHORELINE scan (v2). The old scan radiated square rings from spawn,
// hit BOTH banks at the same radius, and took the first `target` — splitting the field across the water. v2:
//   1. SEED — bounded ring search from a candidate point, STOP at the first water source NOT already flooded
//      (the caller seeds `origin` at the nearest river/ocean biome via biome_scanner, so this lands on water
//      fast; the bench passes the bot cell and the seed search finds the authored water — the scanner stays
//      biome-agnostic, so it is testable headless).
//   2. FLOOD + COLLECT — BFS the connected water body (4-neighbour) at seaY and collect each hydratable bank
//      cell that is solid with air above. Stand-pairing is NO LONGER done here (it once was):
//      under the stripe lattice a cell's stand is a consequence of the field axis, which is not known until
//      the patch is chosen, so pairing at collection time would have to guess the axis and would bias the
//      candidate set toward whichever one it guessed. Over-collect to OVERCOLLECT×target candidates.
//   MULTI-BODY (Stage 2): pick the closest river/ocean, go from there, and when it runs
//      out of candidates pick another river/ocean candidate. Steps 1–2 run as a LOOP over ordered candidate
//      seed points (`opts.seeds`, nearest-first from the caller's biome patches): flood the nearest body into
//      the pool to exhaustion; if the river still cannot host the farm, re-seed at the next candidate and keep
//      accumulating into the SAME candidate pool. The pool is shared across bodies so PHASE 3 sees every
//      body's banks as one candidate set and can pick the biggest patch wherever it lies — a second river's
//      bank competes with the first's on equal footing. No `seeds` (bench / no biome data) → the
//      list is just `[origin]`, exactly the pre-Stage-2 single-body behaviour. The multi-body flood lives HERE,
//      not in a caller loop, because only here is the one consistent pool/penalty state (Law 16).
//   3. PATCH + LATTICE + CUT — the LAST calc before deciding; the pool up to here is just there to sort into clusters.
//      Group the candidates into contiguous PATCHES, take the BIGGEST one, fit all 8 stripe lattices to it and
//      lock the best-yielding, then cut `target` plots from that patch's dense middle. If the biggest patch
//      cannot fill `target`, the remainder comes from the next-NEAREST patch under the SAME locked lattice,
//      and the field is flagged `multiPatchFill` — fed bots are chosen over a strictly single cluster, but
//      the split is made explicit in telemetry instead of accidental.
//      Biggest-first replaced tightest-first: a tightest-bbox seed can settle on a small, sparse cluster
//      instead of the field's genuinely densest stretch.
//      Cross-patch penalty is impossible by construction — patches are >CLUSTER_GAP (3) apart and the MC rule
//      reaches √2, so two patches can never interact. That is why the lattice can be fitted per-patch.
//      A field short of `target` is surfaced with WHY (poolSize, bodyExhausted, tallies), never silently
//      accepted — the bots need all `target` plots to eat.
// Every farm is pinned to seaY. Returns { field:[{crop,stand}], … }.
async function scanWheatPlots(bot0, { origin, target = TARGET, seaY = DEFAULT_SEA_Y, maxRadius = MAX_RADIUS, seeds = null } = {}) {
  // THE FRONT DOOR: every scan goes through the throttled voxel reader and declares what it needs. Two
  // needs declared here, and both are honestly type-derivable: the crop/stand tests
  // read name + boundingBox, and the shoreline test reads water SOURCE-ness — which is part of the block
  // state, not of the position (see voxel_reader's TYPE_DERIVABLE note). So this whole scan runs off the
  // number table. If a future rule here ever needs light or biome, ADD IT TO `needs` — the reader will
  // drop to the full read and say so on `.fast`, rather than answer it wrongly from the table.
  const scan = makeVoxelScan(bot0, { needs: ['type', 'water'], source: 'wheat_scan' });
  const pace = scan.pace;
  const t0 = Date.now();
  const isSeaWater = (x, z) => scan.isWaterSource(x, seaY, z);   // one probe height — rivers/oceans sit at seaY (the seaY+1 probe was dropped)

  // SHARED accumulators — persist ACROSS bodies so the candidate set is ONE consistent pool no matter how
  // many rivers the field spans (Stage 2). Penalty-freedom is no longer accumulated here: the lattice
  // guarantees it per-patch, and patches cannot interact (see PHASE 3).
  const poolTarget = Math.max(target, target * OVERCOLLECT);
  const waterSeen = new Set();                                  // every water cell any body flooded — a later seed skips it
  const seenCell = new Set();                                   // bank cells already seen (dedup overlapping hydration boxes, across bodies)
  const pool = [];                                              // candidate cells: solid, air above, hydratable
  let waterCells = 0;
  let ringCellsSeen = 0, lastSeedRadius = 0, hitFrontier = false, bodiesUsed = 0, enoughFound = false;
  let unloadedShore = 0;                                        // flood neighbours not streamed in yet (see PHASE 2)
  const WATER_CAP = Math.max(4096, poolTarget * 128);          // runaway backstop across ALL bodies

  // Candidate seed points, nearest-first. Default (bench / no biome data): just origin — the ring search finds
  // the one nearest body, exactly the pre-Stage-2 single-body path. Stage 2: the caller hands the ordered
  // river/ocean biome-patch seeds, so the flood jumps body→body until the pool fills or the candidates run out.
  const seedPoints = (seeds && seeds.length) ? seeds : [origin];

  for (const from of seedPoints) {
    // Move to another river only when this one cannot host the farm. TWO conditions, both required:
    // the OVERCOLLECT floor on raw candidates, AND a patch big enough to actually hold
    // `target` plots — the floor alone is satisfiable by scattered rubble that sites nothing.
    // PLOTS_PER_CANDIDATE is the stripe lattice's structural yield: half the cells are walkway.
    if (pool.length >= poolTarget && biggestPatchCells(pool) * PLOTS_PER_CANDIDATE >= target) { enoughFound = true; break; }

    // ── PHASE 1: SEED — nearest water source to `from` that is NOT already flooded (ring search, stop at first). ──
    let seed = null, ringsUnloaded = 0, seedRadius = 0;
    for (let r = 0; r <= maxRadius && !seed; r++) {
      let ringLoadedAny = false;
      for (const [x, z] of ringCells(from.x, from.z, r)) {
        ringCellsSeen++;
        if (scan.blockAt(x, seaY, z)) ringLoadedAny = true;
        if (isSeaWater(x, z) && !waterSeen.has(`${x},${z}`)) { seed = { x, z }; break; }
        await pace();
      }
      seedRadius = r;
      if (!seed) {
        if (r > 0 && !ringLoadedAny) { if (++ringsUnloaded >= UNLOADED_RING_STOP) { hitFrontier = true; break; } }
        else ringsUnloaded = 0;
      }
    }
    lastSeedRadius = Math.max(lastSeedRadius, seedRadius);
    if (!seed) continue;                                        // this candidate found no fresh water — try the next patch
    bodiesUsed++;

    // ── PHASE 2: FLOOD + COLLECT this body into the SHARED candidate pool. BFS the connected water body and
    //    keep every bank cell that is solid with air above — a diggable, hydratable crop candidate. Stand
    //    pairing moved OUT to PHASE 3 with the lattice (a cell's stand is determined by the field axis, which
    //    isn't known yet). Bounded: WATER_CAP caps an open ocean across all bodies, maxRadius caps reach.
    //    `maxRadius` is measured from `origin` (the base ref), so a far body stays bounded to the loaded disc.
    waterSeen.add(`${seed.x},${seed.z}`);
    const queue = [seed];
    // No pool cap in this condition: the body is flooded to EXHAUSTION so the patch
    // comparison in PHASE 3 sees the whole shoreline. Stopping at a pool size made the scan pick the biggest
    // patch *in the first window it happened to fill*, on an irregular bank — you cannot expand the biggest
    // section past where you stopped looking. Affordable now only because vetting left collection: 2 block
    // reads per candidate, down from the pre-lattice per-cell vetting cost.
    while (queue.length && waterCells < WATER_CAP) {
      const w = queue.shift();
      waterCells++;
      for (let nx = w.x - HYDRATION_RADIUS; nx <= w.x + HYDRATION_RADIUS; nx++) {
        for (let nz = w.z - HYDRATION_RADIUS; nz <= w.z + HYDRATION_RADIUS; nz++) {
          const k = `${nx},${seaY},${nz}`;
          if (!seenCell.has(k)) {
            seenCell.add(k);
            if (solidWithAirAbove(scan, nx, seaY, nz)) pool.push({ x: nx, y: seaY, z: nz, key: k });
          }
          await pace();
        }
      }
      for (const [dx, dz] of CARDINALS) {                        // follow the shoreline: connected water only
        const wx = w.x + dx, wz = w.z + dz, wk = `${wx},${wz}`;
        if (waterSeen.has(wk)) continue;
        if (Math.abs(wx - origin.x) > maxRadius || Math.abs(wz - origin.z) > maxRadius) continue;
        if (isSeaWater(wx, wz)) { waterSeen.add(wk); queue.push({ x: wx, z: wz }); }
        // A NEIGHBOUR THAT IS NOT WATER BECAUSE IT IS NOT HERE YET is counted, never taken for shore. An
        // unloaded cell reads as "not water", so a lake cut off by the streaming edge floods as a small one:
        // run seven (2026-09-11) saw 23 cells of a lake the same scan found 67 of, 26s later.
        else if (!scan.blockAt(wx, seaY, wz)) unloadedShore++;
        await pace();
      }
    }
  }
  const seedRadius = lastSeedRadius;
  if (bodiesUsed === 0) return emptyScan(scan, t0, ringCellsSeen, seedRadius, hitFrontier);
  // Every body is now flooded to exhaustion, so this no longer means "the pool didn't fill" — it means the
  // seed list ran out before any river could host the farm, i.e. poolSize IS the world's true yield and a
  // short field is the world's fault, not the scan's budget.
  const bodyExhausted = !enoughFound;

  // ── PHASE 3: LATTICE → RUNS → TIGHTEST SET. The lattice fixes the stripe phase and the one rotation; runs
  //    are the unit selected (MIN_RUN contiguous crops); the tightest set of runs is the farm. ──
  // Water direction is computed ONCE per candidate and reused across all 8 lattices — it is the only
  // expensive non-block-read in the pass and it does not depend on the lattice.
  const waterDir = new Map();
  for (const c of pool) { waterDir.set(c.key, nearestWaterDelta(waterSeen, c.x, c.z, HYDRATION_RADIUS)); await pace(); }
  const chosen = pool.length ? chooseLattice(scan, pool, waterDir, target, origin) : null;
  const lattice = chosen?.lattice ?? null;
  const tally = chosen?.tally ?? { offStripe: 0, noWater: 0, wrongFacing: 0, noStand: 0, waterLocked: 0 };
  const field = chosen ? chosen.cluster.set : [];

  const cropKeys = new Set(field.map(p => p.crop.key));
  const distinctStands = new Set(field.map(p => p.stand.key)).size;
  return {
    field, keptTotal: field.length, poolSize: pool.length, candidates: pool.length,
    plotsAvailable: chosen ? chosen.plots.length : 0,
    runsAvailable: chosen ? chosen.runs.length : 0,
    runsUsed: chosen ? chosen.cluster.runs : 0, minRun: MIN_RUN,
    // Density is the top ranking criterion, so it is reported as a number, not implied by a bbox: how
    // much of the cluster's own footprint the farm actually occupies.
    clusterArea: chosen ? chosen.cluster.area : 0,
    clusterSpan: chosen ? chosen.cluster.span : 0,
    density: chosen && chosen.cluster.area ? +(field.length / chosen.cluster.area).toFixed(3) : 0,
    offStripe: tally.offStripe, wrongFacing: tally.wrongFacing, noStand: tally.noStand,
    waterLocked: tally.waterLocked, penaltyRejects: 0,
    axis: lattice?.axis ?? null, stripeParity: lattice?.parity ?? null, standDir: lattice?.dir ?? null,
    // How many separate pieces the finished field landed in — the cohesion number that matters most for a
    // usable farm, and the one to watch when building.
    meshCount: field.length ? unionPatches(field.map(p => p.crop), ROW_MESH_GAP).length : 0,
    distinctStands,
    waterCells, bodiesUsed, bodyExhausted, ringCellsSeen, cellsRead: scan.stats.reads, reachedTarget: field.length >= target,
    scanRadius: seedRadius, loadedFrontier: hitFrontier, unloadedShore, elapsedMs: Date.now() - t0,
    // Penalty-freedom is CHECKED per placement now (no global parity to guarantee it), so this is the
    // independent re-derivation that the checking actually held (Law 25 — the flag has to be earned).
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

// clusterReport — the field can land as ONE continuous mesh or several broken ones; the plot COUNT hides which.
// It re-derives the MESHES of the finished field and measures each — size, footprint, longest unbroken row, and
// nearest distance to the base — plus how far the meshes sit from one another.
//
// It groups by the SAME mesh rule that chose the field, not by a euclidean gap (Law 16, and Law 6 — a report
// that grouped by a different rule would describe a field nobody considered). That is not cosmetic: the old
// gap-based report would have called two banks across a narrow river "one cluster" and shown a clean count for
// a field the mesh rule considers split.
//
// `rows` is the number that actually matters for judging a field — how far the pattern reaches — where bbox only
// says how much ground it covers. A 32-plot mesh of 4 long rows and one of 16 stubby pairs have similar
// bboxes and are not remotely the same field.
function clusterReport(field, origin) {
  // ROW_MESH_GAP (2), not CLUSTER_GAP (3): 2 is exactly the crop-row spacing the penalty rule forces, so it
  // joins rows that share a walkway and nothing looser. The old 3 could bridge a gap wider than the pattern
  // itself, which is how a "cluster" used to hop a narrow river.
  const bodies = unionPatches(field.map(p => p.crop), ROW_MESH_GAP);
  const byCrop = new Map(field.map(p => [p.crop.key, p]));
  const clusters = bodies.map(cells => {
    const plots = cells.map(c => byCrop.get(c.key));
    const xs = cells.map(c => c.x), zs = cells.map(c => c.z);
    // Rows are counted per axis-line, whichever axis the rows of this mesh actually run along.
    const perX = new Map(), perZ = new Map();
    for (const c of cells) {
      perX.set(c.x, (perX.get(c.x) || 0) + 1);
      perZ.set(c.z, (perZ.get(c.z) || 0) + 1);
    }
    const lines = perX.size <= perZ.size ? perX : perZ;   // fewer distinct lines = the along-row direction
    return {
      size: plots.length,
      bbox: { dx: Math.max(...xs) - Math.min(...xs) + 1, dz: Math.max(...zs) - Math.min(...zs) + 1 },
      rows: lines.size,
      longestRow: Math.max(...lines.values()),
      centroid: { x: Math.round(xs.reduce((a, b) => a + b, 0) / cells.length), z: Math.round(zs.reduce((a, b) => a + b, 0) / cells.length) },
      distFromOrigin: Math.min(...cells.map(c => planarDist(origin, c.x, c.z))),   // nearest plot → the bot's base origin
    };
  }).sort((a, b) => a.distFromOrigin - b.distFromOrigin);
  let minGap = Infinity, maxGap = 0;                                          // nearest crop-to-crop across each mesh pair
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

// plotRotation — the quarterTurns a `wheat_plot_pair` instance needs so its dirt/crop voxel (blueprint-local
// +x from the structural_fill anchor at the origin) lands on THIS plot's crop. build_center is the STAND;
// the crop sits one cardinal step away at the same y. rotateOffsetY(1,0,q) maps local +x to:
//   q0 → (+1,0) E   q1 → (0,-1) N   q2 → (-1,0) W   q3 → (0,+1) S   (blueprint_survey.rotateOffsetY convention)
// so the direction stand→crop selects q. Under the row-locked lattice every plot in one field shares a single
// stand→crop direction, so this returns the SAME q for the whole field — that uniformity IS the locked rows.
// Throws on a non-cardinal/degenerate offset — a coding violation, because standOf only ever emits a unit
// cardinal step at the same y (Law 13: never default a bad rotation).
function plotRotation(stand, crop) {
  const dx = crop.x - stand.x, dz = crop.z - stand.z;
  if (dx === 1 && dz === 0) return 0;
  if (dx === 0 && dz === -1) return 1;
  if (dx === -1 && dz === 0) return 2;
  if (dx === 0 && dz === 1) return 3;
  throw new Error(`[wheat_plot_scanner] CODING VIOLATION: stand→crop offset (${dx},${dz}) is not a unit cardinal — STAND_DY=[0] should guarantee it. Plot stand (${stand.x},${stand.y},${stand.z}) crop (${crop.x},${crop.y},${crop.z}).`);
}

module.exports = {
  scanWheatPlots,
  plotRotation,
  // exported for the bench self-check (direct unit-test of the MC rule) and any live sanity re-check:
  growthPenalized,
  verifyNoPenalty,
  TARGET,
  DEFAULT_SEA_Y,
};
