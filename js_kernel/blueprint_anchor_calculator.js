// js_kernel/blueprint_anchor_calculator.js — splits a DOWNLOADED blueprint into 5×5×5 anchor cubes, stacked into
// columns, each column worked from one stand column entered from the basement beneath. Pure: voxels in, a plan out.
//
// ── WHY CUBES IN COLUMNS, AND WHY A COLUMN IS ONE CONTINUOUS PASS (Architect 2026-09-16/17) ──────────────
// *"for downloadable blueprints, the only access into the building is from the bottom. so any door or open are is
// off limits, it should be like a big giant bedrock structure with the only openings are at the bottom underneath
// it. this prevents the bots from digging any block thats placed"* — and — *"an anchor caclulator that splits each
// part into a 5 by 5 cube stacked horizontally and vertically."*
// A bot enters a column from the basement through its STAND COLUMN, rises on CHEAP FILLER (dirt — Architect
// 2026-09-17: *"it will still pillar and dig down with cheap blocks like dirt in the interrum"*) through the stand
// column's cells, and at each cube places every cell of that cube from one stand. On the way DOWN it digs the
// filler under its feet and places the stand column's true blueprint block above its head, so it leaves the column
// exactly as the blueprint shows and never digs a block that is part of the building. Every visit starts at the
// column's x,z and pillars to the anchor's y — the bot never travels inside the building.
// That descent is why cubes in one column are SERIAL and the column is sealed ONCE: were cube 1's stand cells
// restored before cube 2 was built, the bot in cube 2 could only leave by digging through cube 1's finished cells —
// the place/dig/re-place loop the bottom-only rule exists to remove. So a cube is a claim and a progress unit; the
// stand column stays filler until the column's top cube is done; one descent seals it. Two bots never share a
// column at once; any number work different columns. Parallelism is the number of COLUMNS.
// Empty cubes below a column's top are still anchors (with no voxels): the pass must rise through them.
//
// ── THE STAND ───────────────────────────────────────────────────────────────────────────────────────
// One stand column per column of cubes, chosen inside the blueprint's box, nearest the cell's centre first. A
// column cell is refused as a stand column when any of its blueprint blocks cannot be restored on the descent: a
// block that needs a block BELOW it (on the descent the cell below is the bot's head, and air), a block that falls,
// or a two-block piece (door, bed, tall plant). The feet stand on the cube's second layer, so the eye is 2.62 above
// the cube's base and every cell of a 5×5×5 cube is inside BLOCK_REACH from the centre column.
//
// ── THE GRID OFFSET ─────────────────────────────────────────────────────────────────────────────────
// Cubes start at blueprint layer 0 — the basement fixes the bottom, so there is no vertical offset. Horizontally all
// 25 offsets are tried and ranked: fewest columns (fewest passes to seal), then fewest columns with no usable stand
// column, then fewest two-cell pieces split across cubes, then fewest cubes.
// A double chest split across cubes is ordered, not refused: the right half is placed first as a single chest and
// the left half joins it (facing_aim's chest rule), so the left half's anchor lists the right half's anchor in
// `after`. A door or bed split across cubes needs no order (the second half comes with the first) and is counted.

'use strict';

const CUBE = 5;
const STAND_FEET_LAYER = 1;           // within the cube; eye = base + 1 + 1.62
const EYE_HEIGHT = 1.62;
const NEEDS_BELOW_OR_FALLS = /(_carpet|_pressure_plate|^torch$|^rail$|_rail$|_door$|_bed$|flower_pot|^potted_|_sign$|^lantern$|^soul_lantern$|_button$|^anvil$|^chipped_anvil$|^damaged_anvil$|^sand$|^red_sand$|^gravel$|_concrete_powder$|^scaffolding$|^redstone_wire$|^repeater$|^comparator$|^snow$|^tall_grass$|^large_fern$|_sapling$|^campfire$|^soul_campfire$)/;
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };

// standable — a column cell whose every blueprint block can be restored overhead on the descent.
// A button, lantern or campfire refuses only when it rests on the floor (face=floor / hanging=false).
function restorableOverhead(block, state) {
  const s = state || {};
  if (/_button$/.test(block)) return s.face !== 'floor';
  if (block === 'lantern' || block === 'soul_lantern') return s.hanging === 'true';
  return !NEEDS_BELOW_OR_FALLS.test(block);
}

// pairs — two-cell pieces: [first cell, second cell, kind]. For a chest the first is the half placed first.
function pairsOf(voxels) {
  const at = new Map(voxels.map(v => [`${v[0]},${v[1]},${v[2]}`, v]));
  const out = [];
  for (const v of voxels) {
    const s = v[4] || {};
    if (/_door$/.test(v[3]) && s.half === 'lower') out.push([v, [v[0], v[1] + 1, v[2]], 'door']);
    if (/_bed$/.test(v[3]) && s.part === 'foot' && DIRS[s.facing]) out.push([v, [v[0] + DIRS[s.facing][0], v[1], v[2] + DIRS[s.facing][1]], 'bed']);
    if (/chest$/.test(v[3]) && s.type === 'left' && DIRS[s.facing]) {
      const d = DIRS[CW[s.facing]];
      const partner = at.get(`${v[0] + d[0]},${v[1]},${v[2] + d[1]}`);
      if (partner) out.push([partner, v, 'chest']);
    }
  }
  return out;
}

function nearestPointDistance(eye, x, y, z) {
  const c = (e, lo) => Math.max(lo, Math.min(e, lo + 1));
  return Math.hypot(eye[0] - c(eye[0], x), eye[1] - c(eye[1], y), eye[2] - c(eye[2], z));
}

// layoutAt — the whole plan for one horizontal offset.
function layoutAt(voxels, dims, ox, oz) {
  const cubeOf = v => [Math.floor((v[0] + ox) / CUBE), Math.floor(v[1] / CUBE), Math.floor((v[2] + oz) / CUBE)];
  const columns = new Map();
  for (const v of voxels) {
    const [cx, cy, cz] = cubeOf(v);
    const key = `${cx},${cz}`;
    if (!columns.has(key)) columns.set(key, { cx, cz, top: -1, cells: new Map() });
    const col = columns.get(key);
    col.top = Math.max(col.top, cy);
    const cell = `${v[0]},${v[2]}`;
    if (!col.cells.has(cell)) col.cells.set(cell, []);
    col.cells.get(cell).push(v);
  }
  let noStand = 0;
  for (const col of columns.values()) {
    const x0 = col.cx * CUBE - ox, z0 = col.cz * CUBE - oz;
    const centre = [x0 + 2, z0 + 2];
    const candidates = [];
    for (let x = x0; x < x0 + CUBE; x++) {
      for (let z = z0; z < z0 + CUBE; z++) {
        if (x < 0 || z < 0 || x >= dims.w || z >= dims.l) continue;
        candidates.push([x, z, Math.hypot(x - centre[0], z - centre[1])]);
      }
    }
    candidates.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
    const ok = candidates.find(([x, z]) => (col.cells.get(`${x},${z}`) || []).every(v => restorableOverhead(v[3], v[4])));
    col.stand = ok ? [ok[0], ok[1]] : null;
    col.box = { x0, z0 };
    if (!ok) noStand++;
  }
  const pairs = pairsOf(voxels);
  const split = pairs.filter(([a, b]) => cubeOf(a).join() !== cubeOf(b).join());
  const cubes = [...columns.values()].reduce((n, c) => n + c.top + 1, 0);
  return { ox, oz, columns, noStand, pairs, split, cubes, cubeOf };
}

// computeAnchors(voxels, dims) → { offset, anchors, summary }
//   voxels  [x,y,z,block,state?] in the blueprint's min-corner frame, already through the material rule
//   dims    { w, h, l }
function computeAnchors(voxels, dims) {
  const { BLOCK_REACH } = require('@utils/fragment_utils');
  const tried = [];
  for (let ox = 0; ox < CUBE; ox++) for (let oz = 0; oz < CUBE; oz++) tried.push(layoutAt(voxels, dims, ox, oz));
  tried.sort((a, b) => a.columns.size - b.columns.size || a.noStand - b.noStand || a.split.length - b.split.length || a.cubes - b.cubes);
  const best = tried[0];

  const byCube = new Map();
  for (const v of voxels) {
    const k = best.cubeOf(v).join();
    if (!byCube.has(k)) byCube.set(k, []);
    byCube.get(k).push(v);
  }
  const cols = [...best.columns.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  const anchors = [];
  const indexOf = new Map();
  cols.forEach((col, ci) => {
    for (let cy = 0; cy <= col.top; cy++) {
      const cubeVoxels = byCube.get(`${col.cx},${cy},${col.cz}`) || [];
      const anchor = {
        index: anchors.length,
        column: ci,
        layer: cy,
        cube_min: [col.box.x0, cy * CUBE, col.box.z0],
        stand: col.stand ? [col.stand[0], cy * CUBE + STAND_FEET_LAYER, col.stand[1]] : null,
        after: [],
        reach_max: 0,
        voxels: cubeVoxels,
      };
      if (anchor.stand) {
        const eye = [anchor.stand[0] + 0.5, anchor.stand[1] + EYE_HEIGHT, anchor.stand[2] + 0.5];
        for (const v of cubeVoxels) {
          if (v[0] === anchor.stand[0] && v[2] === anchor.stand[2]) continue;   // the stand column is restored on the descent
          anchor.reach_max = Math.max(anchor.reach_max, nearestPointDistance(eye, v[0], v[1], v[2]));
        }
        anchor.reach_max = Math.round(anchor.reach_max * 100) / 100;
      }
      indexOf.set(`${col.cx},${cy},${col.cz}`, anchor.index);
      anchors.push(anchor);
    }
  });
  for (const [first, second, kind] of best.split) {
    if (kind !== 'chest') continue;
    const a = indexOf.get(best.cubeOf(first).join()), b = indexOf.get(best.cubeOf(second).join());
    if (!anchors[b].after.includes(a)) anchors[b].after.push(a);
  }

  // THE DESCENT (Architect 2026-09-17): *"it doesent close up after itself until all anchors in that verticle slice
  // is done… so pillar up but dont build that x,z with the correct block until hte last pass… on the way down it
  // places the correct blocks… so the bot needs to have those blocks in the pocket."* One list per column, top to
  // bottom, of the blueprint's own blocks in the stand column — placed above the bot's head as it digs the filler
  // out from under its feet. `pocket` is what that costs in inventory: the slots a bot must carry before it starts.
  const columns = cols.map((col, ci) => {
    const stand = col.stand;
    const stack = stand ? (col.cells.get(`${stand[0]},${stand[1]}`) || []).slice().sort((a, b) => b[1] - a[1]) : [];
    const pocket = {};
    for (const v of stack) pocket[v[3]] = (pocket[v[3]] || 0) + 1;
    return {
      column: ci,
      stand: stand ? [stand[0], stand[1]] : null,
      cube_column: [col.cx, col.cz],
      top_layer: col.top,
      anchors: anchors.filter(a => a.column === ci).map(a => a.index),
      filler_height: (col.top + 1) * CUBE,
      descent: stack,
      pocket,
    };
  });
  const descentSizes = columns.map(c => c.descent.length).sort((x, y) => x - y);
  const pocketSlots = columns.map(c => Object.keys(c.pocket).length);

  const counts = anchors.map(a => a.voxels.length).sort((x, y) => x - y);
  const splitKinds = {};
  for (const [, , kind] of best.split) splitKinds[kind] = (splitKinds[kind] || 0) + 1;
  const summary = {
    cube: CUBE,
    offset: { x: best.ox, z: best.oz },
    offsets_tried: tried.map(t => ({ x: t.ox, z: t.oz, columns: t.columns.size, no_stand: t.noStand, split_pairs: t.split.length, cubes: t.cubes })),
    columns: best.columns.size,
    anchors: anchors.length,
    empty_anchors: anchors.filter(a => a.voxels.length === 0).length,
    cube_layers: Math.max(...anchors.map(a => a.layer)) + 1,
    voxels_per_anchor: { min: counts[0], median: counts[counts.length >> 1], max: counts[counts.length - 1] },
    anchors_with_5_or_fewer: counts.filter(n => n > 0 && n <= 5).length,
    columns_without_a_stand: best.noStand,
    stands_off_centre: cols.filter(c => c.stand && (c.stand[0] !== c.box.x0 + 2 || c.stand[1] !== c.box.z0 + 2)).length,
    two_cell_pieces: best.pairs.length,
    split_across_cubes: splitKinds,
    ordered_chest_pairs: anchors.reduce((n, a) => n + a.after.length, 0),
    reach_limit: BLOCK_REACH,
    reach_max: Math.max(...anchors.map(a => a.reach_max)),
    anchors_beyond_reach: anchors.filter(a => a.reach_max > BLOCK_REACH).length,
    filler_height_max: Math.max(...columns.map(c => c.filler_height)),
    descent_blocks: { total: descentSizes.reduce((s, n) => s + n, 0), median: descentSizes[descentSizes.length >> 1], max: descentSizes[descentSizes.length - 1] },
    pocket_slots_max: Math.max(...pocketSlots),
  };
  return { anchors, columns, summary };
}

module.exports = { computeAnchors, restorableOverhead, CUBE };
