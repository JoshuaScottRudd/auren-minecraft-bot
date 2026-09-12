// util: wheat_plot_scanner (farm siting)
// purpose: THE siting authority for the phase-1 ad-hoc wheat field. Given the live bot's voxels, it
//          returns up to N (crop, stand) plots that are hydratable, stand-pairable, LAND-REACHABLE,
//          and mutually PENALTY-FREE, cut from the BIGGEST plot cluster in the loaded area. lock_all_buildspots locks each returned plot as one `wheat_plot_pair`
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
//   THE FARM PLANE IS PINNED TO seaY, AND THE PLOT IS TERRAFORMED TO REACH IT — DIG, THEN PLACE, EXACTLY THE
//   WAY A BUILDING IS BUILT (Architect 2026-09-11, the settled answer after two rejected ones): *"i would
//   like the plot to be usable as is without digging because that would mean i would need seperate logic
//   handing digging. but it seems to be a problem? if it is then just terraform the plot instead. whenever it
//   goes to where it needs, it digs first then places. just like building. i think thats simple. make it that
//   way… no buckets."*
//   WHY THE PIN CANNOT BE TRADED AWAY: the hydration rule above reaches a crop at the source's level or one
//   BELOW, never one above. The lattice puts the walkway — never a crop — against the water, so inland is
//   always the crop side; and on a bank that rises inland, a crop left on the higher ground is a crop the
//   river can never reach. seaY is therefore not a preference, it is the only level a natural source waters.
//   THE COLUMN RULE, and it is the same one for a crop cell and for a stand (`plotColumn`): the cell AT seaY
//   must already be solid, and the PLOT_HEADROOM cells above it must each be air already or CLEARABLE —
//   diggable, and not a fluid. At most ONE of them may be a full solid block, and only the first: one layer of
//   terrain comes off a bank, never two. Nothing below seaY is ever touched.
//   THERE IS NO SEPARATE DIGGING LOGIC, WHICH IS THE POINT. Every cell this rule clears is one the plot's own
//   blueprint already owns: `wheat_plot_pair` declares the two cells over its stand and the cell over its crop
//   as `air`, so blueprint_survey digs whatever fills them like any other build; the crop's `growing` slot is
//   freed by the field phase's existing `clear` action; and the crop cell itself is a declared `dirt` voxel,
//   so it is dug and re-placed as it always was. This module only decides WHERE — it transforms nothing.
//   WHAT STAYS EXCLUDED, and the list stops there: two solid layers above seaY is a TERRACE or a hillside, and
//   cutting into it leaves a pit rather than a bank. A fluid touching any cell being cleared is refused
//   (`wouldFlow`) — opening a hole beside water floods the plot, and a flooded cell is far harder to place
//   into than an empty one. And nothing is ever dug BELOW seaY: the pre-v3 code allowed it and the bot cut a
//   trench down to the sub-bank solid, carving a CHANNEL beside the river.
//   A PLANT ON THE BANK IS CLEARED LIKE ANYTHING ELSE (Architect 2026-09-11: *"yes filter out leaf litter"*).
//   It used to be its own refusal, `covered`, and on a 1.21.5 forest shore that was the single largest one —
//   346 columns of `leaf_litter` in a probe of 675 usable. Litter is a diggable, non-solid decoration sitting
//   on ground that is already at the waterline, so every one of those columns is a HYDRATED plot once the
//   blueprint's own air voxel is honoured. Nothing about it needed a special case; it needed the refusal to
//   stop being one.
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
//   THE BIGGEST CLUSTER, THEN UP TO target FROM IT: every water body in the loaded area is read first, the
//   plots group into clusters, and the field is cut from the biggest one wherever it lies (see scanWheatPlots).
//
// THE STAND IS COPLANAR WITH THE CROP, and structurally so: both cells are at seaY, one cardinal step apart,
// so the tuple gap is exactly 1 and `maxTupleGap` re-derives that off the finished field rather than
// asserting it. This is also what keeps ONE plot blueprint enough. A fixed blueprint can only be ROTATED
// about the vertical axis (blueprint_survey.rotateOffsetY) — it cannot express a per-instance vertical offset
// between its `stand_ground` and `dirt` voxels — and with the plane pinned to seaY it never has to.
//
// A STEPPED TUPLE WAS BUILT AND WITHDRAWN THE SAME DAY, and the reason it lost is worth one paragraph so
// nobody rebuilds it. It let the walkway sit a block off its crop (`standAt`), which needed two extra
// geometries (`wheat_plot_pair_up`/`_down`) keyed off `crop.y - stand.y`. It worked and it measured well on
// shape — 28/32 plots in 3 rows against 18 in one — but every crop it won sat on the HIGH side of the step,
// which the hydration rule cannot reach, so the whole field came out dry. Terraforming to seaY gets the same
// coplanarity by lowering the ground instead of raising the crop, and keeps the water. The cost of the step
// was never the geometry; it was that the step puts the crop on the wrong side of the waterline.
//
// Where a world falls short of `target` — counted no_stand (the walkway column cannot be made to carry a
// body) or waterLocked (it can, but only water reaches it) — the open fallback (dig a stance beside the
// water-locked cell) is the intended remedy, not relaxing the pin.
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

const Vec3 = require('vec3');
const { makeVoxelScan } = require('@utils/voxel_scan_throttle');
const { getBiomeName } = require('@perception/biome_scanner');        // the one biome read (Law 16)
const { isFluid } = require('@utils/gravity_utils');                  // the one fluid set (Law 16)
const { FARM_WATER_BIOMES, FARM_BLUEPRINT_NAME } = require('@thinking/architect_config');

// ── TUNABLES — the forks retuned at the table (Law 21) ────────────────────────────────
const HYDRATION_RADIUS = 4;   // MC farmland hydrates from water within 4 in x/z (square). 4 = the game rule.
const PLANTABLE_ABOVE = new Set(['air', 'cave_air', 'void_air']); // crop room / head-room must be genuine air.
const TARGET = 32;            // 2 farms' worth. Up to 32 plots, all from the biggest cluster.
// (OVERCOLLECT, PLOTS_PER_CANDIDATE and CLUSTER_GAP removed 2026-09-11. All three served one early exit —
//  "is this river enough, or flood the next one?" — and there is no early exit now: every body in the loaded
//  area is flooded before anything is chosen. See scanWheatPlots for the ruling and the run that forced it.)
// (LATTICE_SAMPLE removed with the sampled fit — the lattice is now scored by the size of the
//  biggest contiguous PLOT cluster, which a sample cannot measure: sampling the candidates tells you how many
//  plots fit, not whether they sit together, and "how many" was exactly the wrong question. Live cost of the
//  full 8-lattice fit was measured at a fraction of the shoreline flood, so there is nothing to sample for.)
const ROW_MESH_GAP = 2;       // crop-row spacing under the penalty rule — the tightest honest 'same mesh' test.
const DEFAULT_SEA_Y = 62;     // rivers/oceans sit here (fixed-sea-level world generation).
const PLOT_HEADROOM = 2;      // cells above seaY the plot owns and must end up clear. TWO, and it is the
                              // blueprint's own number, not a tunable: over a CROP they are the wheat's cell
                              // and the air above it; over a STAND they are the body. Both are declared by
                              // `wheat_plot_pair`, so this is the height the build already clears.
const TERRAIN_LAYERS = 1;     // how many of those cells may be a FULL SOLID BLOCK — one layer of bank comes
                              // off, never two. Two is a terrace or a hillside, and cutting into one leaves a
                              // pit rather than a bank (see WHAT STAYS EXCLUDED in the header).
const MAX_RADIUS = 160;       // the sweep's reach from the bot. The server streams view-distance 10 chunks around
                              // a player (~160 blocks), so this is the loaded area's own edge, not a budget.
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

// plotColumn — THE ONE COLUMN RULE, and it answers for a crop cell and for a stand alike (Law 16). Both need
// exactly the same thing of a column: a solid block AT seaY, and the PLOT_HEADROOM cells above it ending up
// clear. Over a crop those two cells are the wheat and the air above it; over a stand they are the body. The
// blueprint declares both, so anything occupying them is dug by the ordinary build pathway — this function
// only decides whether that dig is one the fleet should make.
//
//   candidate — the column is already clear above seaY; nothing to terraform
//   terraform — it is not, but everything in the way can be taken out: each cell diggable, no fluid on it,
//               and at most TERRAIN_LAYERS of it a full solid block (and only as the first cell)
// Every other answer names the ONE thing that refused the column, so a short field reads back to its cause
// instead of being guessed at (Law 6):
//   buried    — a second solid layer above seaY: a terrace or a hillside, not a bank
//   wouldFlow — a fluid sits on, above, or beside a cell that would be cleared; opening it floods the plot
//   notSolid  — the seaY cell itself is not a full block (air where the ground dips, a plant rooted lower)
//   unloaded  — not streamed in
// null = water, a body's own cell and not a bank at all.
//
// THE FLUID CHECK IS THE SAME REACH pathfinding_utils prices a dig by (FLOW_NEIGHBORS): the four cardinals and
// the cell above, never below, because liquid does not flow upward. An unsensed neighbour refuses the column
// rather than being guessed dry (Invariant B).
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
    // A full block is terrain. One layer of it comes off, and only as the FIRST cell — a solid block higher
    // up with air under it is an overhang, which is the same cut into a hillside by another name.
    if (c.boundingBox === 'block' && d > TERRAIN_LAYERS) return { kind: 'buried', by: c.name };
    // Nothing may pour into the space this cut leaves: the four sides, and whatever sits on top of it.
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

// usableColumn — the two verdicts that mean "a plot cell can be here", named once so the callers that only
// care whether a column is usable do not each re-list them (Law 29: one topic, one list).
const usableColumn = (v) => !!v && (v.kind === 'candidate' || v.kind === 'terraform');

// standable — a body fits on this block NOW, with nothing cleared first. NOT the stand test any more (that is
// plotColumn, which permits the build to clear the head-room): this is the narrower "could a body be here as
// the world stands", and its one caller is the land-approach check, where the question is about ground the
// fleet is NOT going to build on.
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

// hydrated — will this crop cell's farmland be WET? The vanilla rule (FarmBlock.isNearWater) sweeps
// pos.offset(-4,0,-4) to pos.offset(4,1,4), so it needs a source within HYDRATION_RADIUS in x/z AND at the
// farmland's own Y or ONE ABOVE it. Every body this scan floods sits at seaY and every crop cell is AT seaY,
// so both halves are proved by construction and this should return true for every plot in every field. It is
// here to be CHECKED rather than assumed (Law 25): `dryPlots` above zero in a report means the seaY pin has
// broken somewhere, and that is worth a line in the trace rather than a silently slow farm.
function hydrated(crop, seaY) { return seaY >= crop.y && seaY <= crop.y + 1; }

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
// LAND MEANS LAND, NOT CLEARED LAND, and getting that wrong is what this comment is here to prevent. The
// question is "is there a shore on that side, or only water" — so a neighbour counts when it is a usable
// COLUMN (plotColumn: solid at this level with head-room that the build can clear) as well as when a body
// already fits on it. Testing only `standable` would have called a leaf-littered shore an island: the litter
// is not air, so every neighbour fails the narrow test, and the whole bank reads as water-locked at exactly
// the moment those columns became plots. A neighbour ONE BLOCK UP also counts — a shore is a staircase of
// single blocks and a body walks up one unaided; two or more is a wall, and climbing it is a build.
function hasLandApproach(scan, sx, sy, sz, isCrop) {
  for (const [dx, dz] of CARDINALS) {
    const nx = sx + dx, nz = sz + dz;
    if (isCrop(nx, nz)) continue;                              // a crop is farmland, never a walkway
    if (usableColumn(plotColumn(scan, nx, sy, nz))) return true;   // shore at this level, clear or clearable
    if (standable(scan, nx, sy + 1, nz)) return true;              // or a step up the body can walk down from
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
// shoreline. Exact for the coplanar sets this module produces (every cell at seaY). Two callers, one gap
// (ROW_MESH_GAP): the lattice's choice of the biggest cluster (biggestMesh), and the finished field's
// piece-count (clusterReport) — one mesh rule for choosing and for reporting (Law 16).
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

// biggestMesh — group one lattice's runs into CLUSTERS by the mesh rule and return the biggest, by plot count.
// Size is the whole ranking; distance from the origin only breaks a tie in size. Ruled 2026-09-11: *"i dont
// want closest or anything if it finds 20 in a cluster and 2 in another one then 2 in another one that closer
// then it should walk to the 20 cluster and scan again."* A run is contiguous along one stripe, so it never
// straddles two clusters and a cluster is exactly a set of whole runs.
function biggestMesh(runs, origin) {
  const runOf = new Map();
  for (const run of runs) for (const p of run) runOf.set(p.crop.key, run);
  const meshes = unionPatches(runs.flat().map(p => p.crop), ROW_MESH_GAP).map(cells => ({
    runs: [...new Set(cells.map(c => runOf.get(c.key)))],
    plots: cells.length,
    dist: cells.reduce((m, c) => Math.min(m, planarDist(origin, c.x, c.z)), Infinity),
  }));
  meshes.sort((a, b) => b.plots - a.plots || a.dist - b.dist);
  return { runs: meshes[0].runs, plots: meshes[0].plots, sizes: meshes.map(m => m.plots) };
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
    // The walkway column, judged by the SAME rule as the crop (plotColumn) at the SAME level — a stand is a
    // solid block at seaY with head-room the build can clear, exactly like a crop cell. Coplanar by
    // construction, so the tuple is one cardinal step and nothing more.
    const sv = plotColumn(scan, c.x - offX, c.y, c.z - offZ);
    if (!usableColumn(sv)) { tally.noStand++; continue; }
    const s = { x: c.x - offX, y: c.y, z: c.z - offZ, key: `${c.x - offX},${c.y},${c.z - offZ}`, terraform: sv.kind === 'terraform' };
    if (!hasLandApproach(scan, s.x, s.y, s.z, isCropStripe)) { tally.waterLocked++; continue; }
    plots.push({ crop: c, stand: s });
  }
  return plots;
}

// buildRuns — split a lattice's plots into maximal CONTIGUOUS runs along each crop stripe, discarding any run
// shorter than MIN_RUN. `axis` indexes the stripes, so a run advances along the other axis. This is the unit
// the field is assembled from; see MINIMUM RUN in the header block for why a run and not a plot.
//
// CONTIGUOUS MEANS COPLANAR TOO, and that is load-bearing now a crop may sit at seaY or seaY+1. A run that
// stepped up a block would belong to BOTH of the planes `unionPatches` groups by, so its plots would be
// counted in two clusters and `biggestMesh` would choose one that does not exist. Requiring the same Y is also
// what a run IS — one unbroken walkable row on one plane — so the guard states the definition rather than
// patching a symptom, and it is what keeps a locked field on ONE plane instead of straddling both.
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
      if (list[i].crop[rowAxis] === list[i - 1].crop[rowAxis] + 1 && list[i].crop.y === list[i - 1].crop.y) cur.push(list[i]);
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

// chooseLattice — all 8 (axis, parity, dir) combinations. Each lattice's field is cut from ITS OWN biggest
// cluster (biggestMesh), and only then are the lattices compared, by the field each yields: filling the farm
// first, then density. The cut stays inside one cluster — a smaller cluster never tops up a short one, which is
// what put run eight's 10 plots in 2 pieces.
function chooseLattice(scan, pool, waterDir, target, origin) {
  let best = null;
  for (const { axis, dir } of LATTICES) {
    for (const parity of [0, 1]) {
      const tally = { offStripe: 0, noWater: 0, wrongFacing: 0, noStand: 0, waterLocked: 0 };
      const plots = buildPlots(scan, pool, waterDir, { axis, parity, dir }, tally);
      if (!plots.length) continue;
      const runs = buildRuns(plots, axis, MIN_RUN);
      if (!runs.length) continue;
      const mesh = biggestMesh(runs, origin);
      const cluster = tightestRunSet(mesh.runs, target, origin, MIN_RUN);
      if (!cluster) continue;
      const cand = { lattice: { axis, parity, dir }, plots, runs, mesh, cluster, tally };
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

// topNames — a name → count tally as its four biggest [name, count] pairs, for a report line.
const topNames = (tally) => [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4);

// emptyScan — the no-water telemetry shape (keeps the return contract stable for lock_all_buildspots/bench).
function emptyScan(scan, t0, ringCellsSeen, scanRadius, loadedFrontier, otherWater, otherBiomes) {
  return {
    field: [], keptTotal: 0, poolSize: 0, candidates: 0, noStand: 0, waterLocked: 0, penaltyRejects: 0,
    distinctStands: 0, waterCells: 0, bodiesFound: 0, bodySizes: [], ringCellsSeen, cellsRead: scan.stats.reads, reachedTarget: false,
    clusterSizes: [], otherWater, otherBiomes, farmY: null, hydratedPlots: 0, dryPlots: 0, maxTupleGap: null,
    terraformedCrops: 0, terraformedStands: 0,
    bank: { candidate: 0, terraform: 0, wouldFlow: 0, buried: 0, notSolid: 0, unloaded: 0 }, refusedBy: [],
    scanRadius, loadedFrontier, elapsedMs: Date.now() - t0, penaltyFree: true, noCropIsStand: true, clustering: null, clusters: null,
    // Must mirror the real return's shape exactly (Law 10): the no-water path feeds the same log line and the
    // same bench readers, and a missing key here surfaces as `undefined` in a report rather than as an error.
    axis: null, stripeParity: null, standDir: null, offStripe: 0, wrongFacing: 0,
    plotsAvailable: 0, runsAvailable: 0, runsUsed: 0, minRun: MIN_RUN,
    clusterArea: 0, clusterSpan: 0, density: 0, meshCount: 0,
  };
}

// scanWheatPlots — the WHOLE-AREA river/ocean shoreline scan (v4, 2026-09-11). Ruled: *"the bot needs to keep
// scanning until it found all the plots. it should never stop scanning at the first lake."* — then, sharper:
// *"find river or ocean, find the bank, scan along the bank and get the plots… water biome only, bank only,
// cluster only."* Three phases:
//   1. SWEEP — square rings out from `origin` (the bot) to maxRadius or the loaded frontier, every ring, with
//      no early exit. Each sea-level water source in a FARM_WATER_BIOMES biome, not already flooded, starts a
//      new body. Sea-level water of any other biome is a lake or pond: counted (`otherWater`), never flooded.
//   2. FLOOD + COLLECT — BFS each body to exhaustion at seaY. A water cell with a cardinal neighbour that is
//      not sea water is SHORE, and only a shore cell opens the 9×9 hydration box. That is exact, not a sample:
//      a bank cell within 4 of some water cell is within 4 of a shore cell — walk the monotone cardinal path
//      from that water toward the bank, and the last water cell on it has a dry cardinal neighbour and sits no
//      farther from the bank — so an ocean's interior costs 4 reads a cell instead of 81. Every box cell gets a
//      verdict (plotColumn) and the verdicts are TALLIED, so a short field says which rule emptied it.
//      Stand-pairing is not done here: under the stripe lattice a cell's stand is a consequence of the field
//      axis, which is not known until PHASE 3.
//   3. LATTICE → RUNS → BIGGEST CLUSTER → CUT. Each of the 8 lattices groups its runs into clusters by the mesh
//      rule, and its field is cut from its own biggest cluster — never topped up from a smaller one. Distance
//      from the bot does not rank a cluster; it breaks a tie in size and nothing more.
// WHY v2 GAVE WAY. v2 ring-searched out from the origin, flooded the FIRST body it met, and flooded another
// only when the caller handed it river/ocean biome seeds — which a lake inside a forest never has. Run eight
// (2026-09-11) surveyed three times in its first 13 s and flooded 173, 21 and 67 water cells: three different
// lakes, each merely the first one its rings reached as chunks streamed in. The 173-cell lake was never looked
// at again, and the field that locked was 10 plots in 2 pieces off the 67-cell one.
// ONE PASS, NO SECOND LOOK (v4): *"that way it can find what it needs the first time instead of walk anc
// check again"*. The caller waits for the loaded area to arrive and calls this once; the field is the
// biggest river/ocean cluster in view, however far from the bot it lies.
// Every farm is pinned to seaY. Returns { field:[{crop,stand}], … }.
// `combatGate: false` is for a body with no fleet behind it (wheat_site_probe) — the pacer then yields the tick
// without asking battle_stations, which a lone probe has not loaded (voxel_scan_throttle's own option).
async function scanWheatPlots(bot0, { origin, target = TARGET, seaY = DEFAULT_SEA_Y, maxRadius = MAX_RADIUS, combatGate = true } = {}) {
  // THE FRONT DOOR: every scan goes through the throttled voxel reader and declares what it needs. Two
  // needs declared here, and both are honestly type-derivable: the crop/stand tests
  // read name + boundingBox, and the shoreline test reads water SOURCE-ness — which is part of the block
  // state, not of the position (see voxel_reader's TYPE_DERIVABLE note). So this whole scan runs off the
  // number table. A rule that needs light ADDS IT TO `needs` — the reader drops to the full read and says
  // so on `.fast` rather than answer wrongly from the table. The biome is read elsewhere by design: through
  // biome_scanner.getBiomeName, the fleet's one biome read, so the table path is kept for every block.
  const scan = makeVoxelScan(bot0, { needs: ['type', 'water'], source: 'wheat_scan', combatGate });
  const pace = scan.pace;
  const t0 = Date.now();
  const isSeaWater = (x, z) => scan.isWaterSource(x, seaY, z);   // one probe height — rivers/oceans sit at seaY (the seaY+1 probe was dropped)
  const outside = (x, z) => Math.abs(x - origin.x) > maxRadius || Math.abs(z - origin.z) > maxRadius;
  // RIVER OR OCEAN AND NOTHING ELSE — read at the water cell itself, so a river that runs into a forest lake
  // stops being "this body" at the biome's edge.
  const isFarmWater = (x, z) => FARM_WATER_BIOMES.has(getBiomeName(bot0, x, seaY, z));

  // SHARED accumulators — one pool across every body, so PHASE 3 sees every bank in the loaded area as one
  // candidate set and a far lake's bank competes with a near one's on equal footing.
  const waterSeen = new Map();     // "x,z" → id of the body that flooded it (nearestWaterDelta reads it as a set)
  const seenCell = new Set();      // box cells already judged — hydration boxes overlap, within a body and across
  const pool = [];                 // candidate crop cells
  const bodies = [];               // { id, waterCells }
  // `candidate` is a column already clear above seaY; `terraform` is one the build clears first. They sum to
  // the usable pool, and are kept apart so the report says how much ground a field actually moves.
  const bank = { candidate: 0, terraform: 0, wouldFlow: 0, buried: 0, notSolid: 0, unloaded: 0 };
  const refusedBy = new Map();     // what refused a column, by block name — the actionable half of a short field
  let ringCellsSeen = 0, sweepRadius = 0, hitFrontier = false, ringsUnloaded = 0, otherWater = 0;
  const otherBiomes = new Map();   // the biome of each skipped sea-level water cell, by name — what the rule refused

  // ── PHASE 2, called from the sweep below: one body, flooded to EXHAUSTION. No cap but the reach: the
  //    flood never leaves the maxRadius square, and that square is the loaded area, so it is bounded by what
  //    is there to read. (WATER_CAP removed with the early exit — it capped an ocean at the cost of every lake
  //    beyond it, which is the first-lake fault at a larger scale.) ──
  const flood = async (sx, sz) => {
    const body = { id: bodies.length, waterCells: 0 };
    bodies.push(body);
    waterSeen.set(`${sx},${sz}`, body.id);
    const stack = [{ x: sx, z: sz }];            // order is irrelevant to an exhaustive flood; pop is O(1)
    while (stack.length) {
      const w = stack.pop();
      body.waterCells++;
      let shore = false;
      for (const [dx, dz] of CARDINALS) {        // follow the shoreline: connected river/ocean water only
        const wx = w.x + dx, wz = w.z + dz, wk = `${wx},${wz}`;
        if (waterSeen.has(wk) || outside(wx, wz)) continue;
        if (isSeaWater(wx, wz)) {
          // Water of another biome — the lake a river runs into — is neither this body nor a bank.
          if (isFarmWater(wx, wz)) { waterSeen.set(wk, body.id); stack.push({ x: wx, z: wz }); }
          continue;
        }
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
          // What refused the column, by block name — the line that says WHICH plant or WHICH terrain is
          // costing the field, rather than leaving a count nobody can act on (Law 6).
          if (v.by) refusedBy.set(v.by, (refusedBy.get(v.by) || 0) + 1);
          if (usableColumn(v)) {
            // Every crop sits at seaY. `terraform` records that the build has a block to take off this one
            // first, so the finished field can say how much ground it will move without re-reading it.
            pool.push({ x: nx, y: seaY, z: nz, key: `${nx},${seaY},${nz}`, terraform: v.kind === 'terraform' });
          }
          await pace();
        }
      }
    }
  };

  // ── PHASE 1: SWEEP — every ring out to the edge. No early exit: the biggest cluster can only be chosen from
  //    a picture that holds every candidate, and a stop at "enough" is a stop at whichever lake came first. ──
  for (let r = 0; r <= maxRadius; r++) {
    let ringLoadedAny = false;
    for (const [x, z] of ringCells(origin.x, origin.z, r)) {
      ringCellsSeen++;
      if (scan.blockAt(x, seaY, z)) ringLoadedAny = true;
      if (!waterSeen.has(`${x},${z}`) && isSeaWater(x, z)) {
        const biome = getBiomeName(bot0, x, seaY, z);
        if (FARM_WATER_BIOMES.has(biome)) await flood(x, z);
        else { otherWater++; otherBiomes.set(biome, (otherBiomes.get(biome) || 0) + 1); }
      }
      await pace();
    }
    sweepRadius = r;
    if (r > 0 && !ringLoadedAny) { if (++ringsUnloaded >= UNLOADED_RING_STOP) { hitFrontier = true; break; } }
    else ringsUnloaded = 0;
  }
  if (!bodies.length) return emptyScan(scan, t0, ringCellsSeen, sweepRadius, hitFrontier, otherWater, topNames(otherBiomes));

  // ── PHASE 3: LATTICE → RUNS → BIGGEST CLUSTER → CUT. The lattice fixes the stripe phase and the one rotation;
  //    runs are the unit selected (MIN_RUN contiguous crops); the field is the tightest set of runs inside the
  //    biggest cluster. ──
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
    // Every cluster the chosen lattice formed, biggest first — the field came from the first.
    clusterSizes: chosen ? chosen.mesh.sizes : [],
    // HOW MUCH GROUND THIS FIELD MOVES — the cost of the terraform ruling, counted rather than assumed. A
    // cell is `terraform` when the build has one block to take off it before the plot exists; the rest were
    // already clear.
    terraformedCrops: field.filter(p => p.crop.terraform).length,
    terraformedStands: field.filter(p => p.stand.terraform).length,
    // THE PIN, RE-DERIVED RATHER THAN ASSERTED (Law 25). Every crop is at seaY by construction, so `farmY`
    // should read seaY and `dryPlots` zero on every run — they are here to CATCH it if that ever stops being
    // true, not to describe a choice. Dry farmland still grows wheat, about a third as fast.
    farmY: field.length ? field[0].crop.y : null,
    hydratedPlots: field.filter(p => hydrated(p.crop, seaY)).length,
    dryPlots: field.filter(p => !hydrated(p.crop, seaY)).length,
    // His tuple rule, re-derived off the finished field rather than asserted: stand and crop are one cardinal
    // step apart at one Y, so this reads 1 on every plot (null on an empty field).
    maxTupleGap: field.length ? Math.max(...field.map(p => dist3(p.stand, p.crop))) : null,
    // Why each bank column did or did not become a plot cell (plotColumn), and which blocks did the refusing.
    bank, refusedBy: [...refusedBy].sort((a, b) => b[1] - a[1]).slice(0, 4),
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
    waterCells: bodies.reduce((a, b) => a + b.waterCells, 0),
    bodiesFound: bodies.length, bodySizes: bodies.map(b => b.waterCells).sort((a, b) => b - a),
    ringCellsSeen, cellsRead: scan.stats.reads, reachedTarget: field.length >= target,
    scanRadius: sweepRadius, loadedFrontier: hitFrontier, otherWater, otherBiomes: topNames(otherBiomes), elapsedMs: Date.now() - t0,
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
  // ROW_MESH_GAP (2), not a looser gap like the retired CLUSTER_GAP (3): 2 is exactly the crop-row spacing the penalty rule forces, so it
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

// plotRotation — the quarterTurns a plot instance needs so its dirt/crop voxel (blueprint-local +x from the
// stand_ground anchor at the origin) lands on THIS plot's crop. build_center is the STAND; the crop sits one
// cardinal step away in x/z. rotateOffsetY(1,0,q) maps local +x to:
//   q0 → (+1,0) E   q1 → (0,-1) N   q2 → (-1,0) W   q3 → (0,+1) S   (blueprint_survey.rotateOffsetY convention)
// so the direction stand→crop selects q. Under the row-locked lattice every plot in one field shares a single
// stand→crop direction, so this returns the SAME q for the whole field — that uniformity IS the locked rows.
//
// Y IS NOT ROTATED AND IS NOT READ HERE, and with the farm plane pinned to seaY it never needs to be: the
// stand and its crop are the same level by construction, which is exactly what one fixed blueprint can
// express. A stepped tuple would have needed a second GEOMETRY rather than a second rotation — see the
// withdrawn design in the header.
// Throws on a non-cardinal/degenerate horizontal offset — a coding violation, because buildPlots only ever
// emits a unit cardinal step in x/z (Law 13: never default a bad rotation).
function plotRotation(stand, crop) {
  const dx = crop.x - stand.x, dz = crop.z - stand.z;
  if (dx === 1 && dz === 0) return 0;
  if (dx === 0 && dz === -1) return 1;
  if (dx === -1 && dz === 0) return 2;
  if (dx === 0 && dz === 1) return 3;
  throw new Error(`[wheat_plot_scanner] CODING VIOLATION: stand→crop offset (${dx},${dz}) is not a unit cardinal — the lattice's one-step walkway offset should guarantee it. Plot stand (${stand.x},${stand.y},${stand.z}) crop (${crop.x},${crop.y},${crop.z}).`);
}


// ── THE LOADED AREA MUST HAVE ARRIVED BEFORE ANYTHING IS JUDGED FROM IT (2026-09-11) ──────────────
// Here rather than in lock_all_buildspots since wheat_site_probe became its second caller: one wait, two
// callers (Law 16). The scan reads the area exactly once (v4), so a caller waits until it has ARRIVED.
//
// ARRIVED MEANS EVERY COLUMN IN VIEW IS HERE, AND "STOPPED GROWING" WAS MEASURED NOT TO MEAN THAT. The first
// version waited for four seconds with no new column. Measured the same day on fresh ground, one body landed
// at (-103,62): 9 columns at 5 s, 65 at 11 s and still 65 at 14 s, 85 at 18 s and 20 s, then climbing to 473
// at 56 s. The server pauses while it GENERATES terrain, and a four-second pause read as "arrived": the
// probe scanned 61 and 72 columns, and run eleven's crew scanned 141 at 11 s — a third of the area, which is
// why v3 walked. So the measure is now a fact the server states at login, its view distance, and the wait
// ends when every column within (viewDistance − 1) chunks of the body is loaded. That disc sits inside every
// shape a server sends (square or round), so it cannot be met early, and it holds for any server's setting.
const SETTLE_POLL_MS = 1000;
const SETTLE_MAX_MS = 120000;    // measured 56 s on fresh ground; past this the shortfall is reported, not waited on
async function loadedAreaSettled(bot) {
  const t0 = Date.now();
  const vd = bot.game.serverViewDistance;
  if (!Number.isInteger(vd) || vd < 2) {
    throw new Error(`[wheat_plot_scanner] CODING VIOLATION (Law 13): the server's view distance was not announced ` +
      `(bot.game.serverViewDistance=${vd}), so there is no way to know when the loaded area has arrived.`);
  }
  const r = vd - 1;
  const disc = [];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (dx * dx + dz * dz <= r * r) disc.push([dx, dz]);
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
  return `${FARM_BLUEPRINT_NAME}: waited ${s.secs}s for the loaded area to arrive — the ${s.disc} columns within ` +
    `${s.viewDistance - 1} chunks of the body (server view distance ${s.viewDistance}), ${s.columns} columns in all` +
    `${s.settled ? '' : `; ${s.missing} STILL missing at the ${SETTLE_MAX_MS / 1000}s cap (scanned anyway)`}.`;
}

// describeScan — the scan's account of itself, one line per question a field raises. The ONE formatter
// (Law 16): the base-layout survey and wheat_site_probe print the same words from the same numbers, so what
// the probe says is what a crew's trace would have said.
function describeScan(scan, target) {
  const b = scan.bank;
  const bodies = `${scan.bodiesFound} river/ocean ${scan.bodiesFound === 1 ? 'body' : 'bodies'}` +
    (scan.bodySizes.length ? ` of ${scan.bodySizes.slice(0, 6).join(', ')}${scan.bodySizes.length > 6 ? ', …' : ''} cells` : '') +
    ` (${scan.otherWater} sea-level water cells in other biomes not considered` +
    `${scan.otherBiomes.length ? ` — ${scan.otherBiomes.map(([n, c]) => `${n}×${c}`).join(', ')}` : ''})`;
  // THE WHY-SO-FEW LINE: every cell beside the water, and the one rule that kept each from being a crop.
  const bankLine = `      ↳ bank columns beside water: ${b.candidate + b.terraform} usable ` +
    `(${b.candidate} already clear, ${b.terraform} one block to take off); refused: ` +
    `${b.buried} solid two blocks up (a terrace, not a bank), ${b.wouldFlow} where the cut would let water in, ` +
    `${b.notSolid} not solid at the waterline, ${b.unloaded} not loaded` +
    `${scan.refusedBy.length ? ` — the blocks doing the refusing: ${scan.refusedBy.map(([n, c]) => `${n}×${c}`).join(', ')}` : ''}.`;
  if (!scan.field.length) {
    return `${FARM_BLUEPRINT_NAME}: 0 plots (scan ${(scan.elapsedMs / 1000).toFixed(1)}s, swept to radius ${scan.scanRadius}, ${bodies}; ` +
      `${scan.candidates} bank candidates, no_stand ${scan.noStand}, water_locked ${scan.waterLocked}).\n` + bankLine;
  }
  const cl = scan.clusters;
  return [
    `${FARM_BLUEPRINT_NAME}: FOUND ${scan.field.length}/${target} plots (scan ${(scan.elapsedMs / 1000).toFixed(1)}s, swept to radius ${scan.scanRadius}, ` +
      `${bodies}, ${scan.penaltyFree ? 'all penalty-free' : '⚠ PENALTY PRESENT'}, ${scan.distinctStands} stands, ${scan.waterCells} water-body cells, pool ${scan.poolSize}).`,
    // The density line is the one to read when a field looks wrong. `density` is plots per block of the
    // cluster's own footprint — the top siting criterion, reported as a number rather than implied.
    `      ↳ lattice axis ${scan.axis}, parity ${scan.stripeParity}, stand ${scan.standDir > 0 ? '+' : '-'} (water side); ` +
      `${scan.runsUsed} run(s) of ≥${scan.minRun} from ${scan.runsAvailable} legal (${scan.plotsAvailable} plots); ` +
      `DENSITY ${scan.density} plots/block² in ${scan.clusterArea}b² (span ${scan.clusterSpan}b), ${scan.meshCount} piece(s).`,
    `      ↳ clusters under that lattice, biggest first: ${scan.clusterSizes.slice(0, 8).join(', ')}${scan.clusterSizes.length > 8 ? ', …' : ''} plots — the field is cut from the first.`,
    // THE PIN AND WHAT IT COSTS TO HOLD IT. Every crop is at seaY, so every crop is watered — printed
    // because it is re-derived from the plots rather than asserted (Law 25), and a `dry` above zero would
    // mean the pin had broken. The terraform counts are the ground this field will actually move.
    `      ↳ crops on plane y=${scan.farmY} — ${scan.hydratedPlots} watered by the river, ${scan.dryPlots} dry` +
      `${scan.dryPlots ? ' ⚠ THE seaY PIN HAS BROKEN — a crop off the waterline cannot be watered' : ''}` +
      `; stand↔crop gap ${scan.maxTupleGap}; the build takes a block off ${scan.terraformedCrops} crop cell(s) ` +
      `and ${scan.terraformedStands} stand(s) first, the way it digs any other build.`,
    bankLine,
    // A mesh is reported by its REACH (rows × longest row), not just its bbox — how far the row pattern runs
    // unbroken along one bank is the useful measure of a cluster, which a bounding box cannot show.
    cl && `      ↳ ${cl.count} mesh(es): ` +
      cl.clusters.map(c => `${c.size} plots in ${c.rows} row(s), longest ${c.longestRow} @${c.distFromOrigin.toFixed(0)}b from bot (${c.bbox.dx}×${c.bbox.dz})`).join(', ') +
      (cl.count > 1 ? `; meshes ${cl.interClusterMinGap.toFixed(0)}–${cl.interClusterMaxGap.toFixed(0)}b apart.` : '.'),
    scan.field.length < target &&
      `      ↳ SHORT ${target - scan.field.length} (idle, not a stop): no_stand=${scan.noStand}, water_locked=${scan.waterLocked}, off_stripe=${scan.offStripe} (walkway, not a reject).`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  scanWheatPlots,
  plotRotation,
  loadedAreaSettled,
  settleLine,
  describeScan,
  SETTLE_MAX_MS,
  // exported for the bench self-check (direct unit-test of the MC rule) and any live sanity re-check:
  growthPenalized,
  verifyNoPenalty,
  TARGET,
  DEFAULT_SEA_Y,
};
