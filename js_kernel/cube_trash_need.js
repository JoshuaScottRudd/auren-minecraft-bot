// cube_trash_need — the most trash one cube trip ever has standing at once, found by building the cube the way the
// trip does, at plan time.
//
// A cube trip places every block a standing face already serves, then stands the cheapest chain of trash that gives
// the next block its face (cube_trash_path), round after round, and takes all of its trash back out at the end. So
// the trash a trip has to carry is the most it has standing at one moment: the PEAK of that walk, not one block
// for every empty cell of the cube. This module walks it once per cube over the plan alone (Law 0: it reads no
// world) and the planner writes the answer into each anchor as `trash`.
//
// ── THE WORLD IT ASSUMES IS THE WORST THE TRIP CAN MEET ─────────────────────────────────────────────────
// Ground stands under the box; every cube of the layers below is built; no cube beside it on its own layer is,
// so no neighbour's block offers a face. Stand shafts are open. A block a producer still awaits is air
// (producer_hooks), a block that hangs is placed by its own pass and stands no trash here (support_plan.hangs).
//
// ── THE RULES IT PLACES BY ARE THE TRIP'S ───────────────────────────────────────────────────────────────
// A plain block goes in on any solid face; a block with a state goes in by a click on one of its click cells
// (facing_aim.clickCells). A path is priced as build_column_executor prices it, over the cube's own empty cells and
// the cells two out from it, within reach of the stand's eye. A plan block placed where trash stands takes it out.
// What it does not see is a placement the server refuses: the trip answers that by closing the cell and walking
// another path, and the price the assessor builds on this figure carries a margin for it.

'use strict';

const Vec3 = require('vec3');
const { trashPath } = require('@kernel/cube_trash_path');
const { hangs } = require('@kernel/support_plan');
const { awaits } = require('@kernel/producer_hooks');
const aim = require('@utils/movement/facing_aim');
const { BLOCK_REACH } = require('@utils/fragment_utils');

const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const NEIGHBOUR_MARGIN = 2;
const EYE_HEIGHT = 1.62;
// build_column_executor's path prices, by what the cell is for.
const PRICE = { own: 0, ownState: 5, plan: 1, trash: 3, neighbour: 6 };
const k = (x, y, z) => `${x},${y},${z}`;

// trashNeeds(plan) → Map(anchor index → the peak trash its trip stands), for every anchor of the plan.
function trashNeeds(plan) {
    const { w, h, l } = plan.dimensions;
    const cube = plan.anchor_summary.cube;
    const shafts = new Set(plan.columns.map(c => `${c.stand[0]},${c.stand[1]}`));
    const voxelAt = new Map();
    for (const a of plan.anchors) for (const v of a.voxels) if (!awaits(v[3])) voxelAt.set(k(v[0], v[1], v[2]), { v, layer: a.layer });
    const inBox = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < w && y < h && z < l;
    const out = new Map();
    for (const anchor of plan.anchors) out.set(anchor.index, peakOf(anchor));
    return out;

    function peakOf(anchor) {
        const solid = new Set();
        for (let x = -1; x <= w; x++) for (let z = -1; z <= l; z++) if (!shafts.has(`${x},${z}`)) solid.add(k(x, -1, z));
        for (const [key, { layer }] of voxelAt) {
            if (layer >= anchor.layer) continue;
            const [x, , z] = key.split(',').map(Number);
            if (!shafts.has(`${x},${z}`)) solid.add(key);
        }
        const [mx, my, mz] = anchor.cube_min;
        const eye = { x: anchor.stand[0] + 0.5, y: anchor.stand[1] + EYE_HEIGHT, z: anchor.stand[2] + 0.5 };
        const reach = (c) => Math.hypot(Math.max(c.x - eye.x, 0, eye.x - c.x - 1), Math.max(c.y - eye.y, 0, eye.y - c.y - 1),
            Math.max(c.z - eye.z, 0, eye.z - c.z - 1)) <= BLOCK_REACH;
        const own = [];
        for (let x = mx; x < mx + cube; x++) for (let y = my; y < my + cube; y++) for (let z = mz; z < mz + cube; z++) {
            if (inBox(x, y, z) && !(x === anchor.stand[0] && z === anchor.stand[2])) own.push({ x, y, z });
        }
        const ownKeys = new Set(own.map(c => k(c.x, c.y, c.z)));
        const beside = [];
        for (let x = mx - NEIGHBOUR_MARGIN; x < mx + cube + NEIGHBOUR_MARGIN; x++) {
            for (let y = my - NEIGHBOUR_MARGIN; y < my + cube + NEIGHBOUR_MARGIN; y++) {
                for (let z = mz - NEIGHBOUR_MARGIN; z < mz + cube + NEIGHBOUR_MARGIN; z++) {
                    if (inBox(x, y, z) && !ownKeys.has(k(x, y, z)) && !shafts.has(`${x},${z}`)) beside.push({ x, y, z });
                }
            }
        }
        const besideKeys = new Set(beside.map(c => k(c.x, c.y, c.z)));
        const open = [];
        for (const c of own) {
            const at = voxelAt.get(k(c.x, c.y, c.z));
            if (!at) continue;
            const state = at.v[4] && Object.keys(at.v[4]).length ? at.v[4] : null;
            if (hangs(at.v[3], state || {})) continue;
            // A bed's head is not a placement of its own: it comes with the foot (facing_aim).
            if (/_bed$/.test(at.v[3]) && state && state.part === 'head') continue;
            open.push({ ...c, name: at.v[3], state });
        }
        const view = { blockAt: (q) => { const s = solid.has(k(q.x, q.y, q.z)); return { name: s ? 'stone' : 'air', boundingBox: s ? 'block' : 'empty', getProperties: () => ({}) }; } };
        const clicksOf = (o) => (o.state && aim.familyOf(o.name) && !aim.unplaceableReason(o.name, o.state))
            ? aim.clickCells(view, new Vec3(o.x, o.y, o.z), o.name, o.state).map(c => ({ x: c.x, y: c.y, z: c.z }))
            : null;
        const attaches = (c) => SIX.some(([dx, dy, dz]) => solid.has(k(c.x + dx, c.y + dy, c.z + dz)));
        const ready = (o) => { const cl = clicksOf(o); return cl ? cl.some(c => solid.has(k(c.x, c.y, c.z))) : attaches(o); };
        const standing = (o) => solid.has(k(o.x, o.y, o.z));
        const ownerOf = (c) => open.find(o => o.x === c.x && o.y === c.y && o.z === c.z && !standing(o));
        const temps = new Set();
        let peak = 0;
        const place = (c) => { const key = k(c.x, c.y, c.z); temps.delete(key); solid.add(key); };
        for (let round = 0; round <= 2 * own.length + open.length; round++) {
            for (let grew = true; grew;) {
                grew = false;
                for (const o of open) if (!standing(o) && ready(o)) { place(o); grew = true; }
            }
            const left = open.filter(o => !standing(o));
            if (!left.length) break;
            const field = new Map();
            for (const c of [...own, ...beside]) if (!solid.has(k(c.x, c.y, c.z)) && reach(c)) field.set(k(c.x, c.y, c.z), c);
            let next = null;
            for (const o of left) {
                const starts = (clicksOf(o) || [o]).filter(c => field.has(k(c.x, c.y, c.z)));
                if (!starts.length) continue;
                const priceOf = (c) => {
                    if (c.x === o.x && c.y === o.y && c.z === o.z) return o.state ? PRICE.ownState : PRICE.own;
                    if (besideKeys.has(k(c.x, c.y, c.z))) return PRICE.neighbour;
                    const owner = ownerOf(c);
                    return owner && !owner.state ? PRICE.plan : PRICE.trash;
                };
                const p = trashPath({ starts, field, costOf: priceOf, attachesNow: attaches });
                if (p && (!next || p.cost < next.p.cost)) next = { o, p };
            }
            if (!next) break;
            for (const c of next.p.cells) {
                if (!next.o.state && c.x === next.o.x && c.y === next.o.y && c.z === next.o.z) continue;
                const key = k(c.x, c.y, c.z);
                if (solid.has(key)) continue;
                const owner = ownerOf(c);
                if (owner && !owner.state && attaches(c)) { place(c); continue; }
                solid.add(key);
                temps.add(key);
                peak = Math.max(peak, temps.size);
            }
        }
        return peak;
    }
}

module.exports = { trashNeeds };
