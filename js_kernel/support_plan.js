// support_plan — for every block of a downloaded plan, what holds it up while it is being placed.
//
// ── NOTHING IS PLACED IN MID-AIR ────────────────────────────────────────────────────────────────────────
// Survival and creative obey one rule: a block goes in by clicking a face of a block already standing. A
// blueprint is a FINISHED building, so it can hold a block whose only neighbour on an allowed face goes in
// LATER in the fleet's order — a lantern hung under a beam in the cube above, a stair whose only support
// is a neighbouring column's wall — or a block whose builder stood a helper there and took it away.
//
// ── WHAT THIS MODULE ANSWERS ────────────────────────────────────────────────────────────────────────────
// For each voxel, from the plan alone: is a face it may attach to GUARANTEED to stand before it is placed
// (an earlier cell of its own cube, a lower cube of its own column, ground outside the box)? When it is
// not, the helpers that make it placeable, in the order to try them:
//   pull  — the support cell is itself a plain block of the plan: place it first, early, from this stand.
//   temp  — the support cell is air in the plan: stand a filler block there, place, dig the filler out.
// A block that falls off when its support goes (a lantern, a torch, a door) takes no temp. A voxel with no
// helper is a block the plan asks for that no survival player can place, and is counted as such.
//
// THIS LIST PRICES; IT DOES NOT PLACE. The cube's price reads it to carry a neighbour's block
// (downloaded_build.cubeMaterials). How a block actually gets its face is decided off the world, at the
// stand, by one search (build_column_executor.escalate), which may stand that block or trash.

'use strict';

const { familyOf } = require('@utils/movement/facing_aim');
const { cubeCells } = require('@kernel/blueprint_anchor_calculator');

const VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const SIX = ['down', 'up', 'north', 'south', 'east', 'west'];

// Families whose block drops the moment the block it hangs on is removed: these take a permanent support.
const HANGS = new Set(['lantern', 'standing_torch', 'wall_mounted', 'standing_rotation', 'door']);
// Plain (stateless) blocks that sit only on the block below and drop without it.
const SITS = /(_carpet|_pressure_plate|^rail$|_rail$|^torch$|^redstone_wire$)/;

const key = (x, y, z) => `${x},${y},${z}`;

// The faces a voxel may be clicked onto, as normals: the support is at voxel - normal. Null for a cell
// that is never placed on its own (a door's upper half, a bed's head).
function normalsOf(name, state) {
    const s = state || {};
    const fam = familyOf(name);
    if (!fam) return SITS.test(name) ? ['up'] : SIX;
    if (fam.family === 'door' && s.half === 'upper') return null;
    if (fam.family === 'bed' && s.part === 'head') return null;
    if (fam.family === 'slab' && s.type === 'double') return SIX;
    return [...new Set(fam.options(s, name).map(o => o.normal))];
}

// supportCells(cell, name, state) → the cells a block at `cell` may be clicked onto, one per allowed face, or
// null for a cell that is never placed on its own.
function supportCells(cell, name, state) {
  const normals = normalsOf(name, state);
  return normals && normals.map(n => { const d = VEC[n]; return [cell[0] - d[0], cell[1] - d[1], cell[2] - d[2]]; });
}

function hangs(name, state) {
    const fam = familyOf(name);
    if (!fam) return SITS.test(name);
    if (fam.family === 'face_attached') return name !== 'grindstone';
    return HANGS.has(fam.family);
}

// computeSupports(plan, isFull) → { helpers: Map(anchorIndex → Map(cellKey → [helper…])), counts, stranded }
//   isFull(blockName) → true when the block offers a full face to click (minecraft-data boundingBox 'block').
function computeSupports(plan, isFull) {
    const dims = plan.dimensions;
    const voxelAt = new Map();      // cell → { v, anchor, order }
    const shaft = new Set();
    for (const col of plan.columns) shaft.add(`${col.stand[0]},${col.stand[1]}`);
    for (const a of plan.anchors) {
        const byCell = new Map(a.voxels.map(v => [key(v[0], v[1], v[2]), v]));
        cubeCells(a, dims).forEach(([x, y, z], order) => {
            const v = byCell.get(key(x, y, z));
            if (v) voxelAt.set(key(x, y, z), { v, anchor: a, order });
        });
    }
    const inBox = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < dims.w && y < dims.h && z < dims.l;
    const inShaft = (x, z) => shaft.has(`${x},${z}`);

    const helpers = new Map();
    const counts = { placeable: 0, pull: 0, temp: 0, stranded: 0 };
    const stranded = [];
    for (const [cell, me] of voxelAt) {
        const [x, y, z, name, state] = me.v;
        if (inShaft(x, z)) continue;                                   // the shaft is restored top-down by the descent
        const normals = normalsOf(name, state);
        if (!normals) continue;
        const supports = normals.map(n => { const d = VEC[n]; return [x - d[0], y - d[1], z - d[2]]; });

        // Guaranteed: a full block of my own cube placed before me, a lower cube of my column, or ground.
        const before = supports.some(([sx, sy, sz]) => {
            if (!inBox(sx, sy, sz)) return true;
            const s = voxelAt.get(key(sx, sy, sz));
            if (!s || !isFull(s.v[3]) || inShaft(sx, sz)) return false;
            if (s.anchor === me.anchor) return s.order < me.order;
            return s.anchor.column === me.anchor.column && s.anchor.layer < me.anchor.layer;
        });
        if (before) { counts.placeable++; continue; }

        const list = [];
        for (const [sx, sy, sz] of supports) {
            if (inShaft(sx, sz)) continue;
            const s = voxelAt.get(key(sx, sy, sz));
            if (s && isFull(s.v[3])) list.push({ kind: 'pull', at: [sx, sy, sz], v: s.v });
        }
        if (!hangs(name, state)) {
            for (const [sx, sy, sz] of supports) {
                if (inShaft(sx, sz) || voxelAt.has(key(sx, sy, sz))) continue;
                list.push({ kind: 'temp', at: [sx, sy, sz] });
            }
        }
        if (!list.length) {
            counts.stranded++;
            stranded.push(`${name}@(${x},${y},${z})`);
            continue;
        }
        counts[list[0].kind]++;
        if (!helpers.has(me.anchor.index)) helpers.set(me.anchor.index, new Map());
        helpers.get(me.anchor.index).set(cell, list);
    }
    return { helpers, counts, stranded };
}

// sitsOnly(name) — a block with no facing family that is placed on the block below and nowhere else (a
// pressure plate, a carpet, a rail): the one question a caller holding only a block's name may ask.
function sitsOnly(name) {
    return !familyOf(name) && SITS.test(name);
}

module.exports = { computeSupports, normalsOf, hangs, supportCells, sitsOnly };
