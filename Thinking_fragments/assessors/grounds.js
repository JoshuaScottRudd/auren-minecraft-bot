// assessors/grounds — keeps a downloaded building's grounds clear. See assessor_registry.
//
// ── THE GROUNDS ARE A RING, AND THE FOOTPRINT IS NOT IN IT ────────────────────────────────────────────
// The ring is the building's own box grown by GROUNDS_MARGIN on every side, with the footprint cut out:
// inside the footprint the column builder owns every cell, and the plan itself carries logs and leaves
// that are the building, not debris. Two kinds of busywork are posted over the ring, both standing:
//   clear_canopy — every tree in the ring, felled by the canopy executor off the same trunk census the
//                  site phase uses (shared.standingSiteTrees). A fallen log rests on ground, so the census
//                  counts it as a trunk and the feller takes the whole connected log with it.
//   clear_ground — the leaf debris and grass tufts, one seat per tile of the ring that holds any, dug by
//                  clear_ground_executor off `debrisIn` below.

'use strict';

const { makeVoxelReader } = require('@utils/voxel_reader');
const { makeExecutionPacer } = require('@utils/execution_yield');
const { JOB_TYPE, GROUNDS_MARGIN, BOT_SENIORITY } = require('@thinking/architect_config');
const { TAG, planTreeBox, inBox, standingSiteTrees } = require('@thinking/assessors/shared');
const { LEAF_RE, LOG_RE } = require('@perception/trunk_bases');

// Loose ground cover: dug by hand in one swing or near it, and nothing a building places.
const DEBRIS_PLANTS = new Set([
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'bush', 'firefly_bush', 'dead_bush',
    'short_dry_grass', 'tall_dry_grass', 'leaf_litter',
]);
// The band around the site's ground floor that is grounds; below it is cave, above it canopy.
const GROUND_BAND = { below: 6, above: 10 };
// One seat's ground: a square tile of the ring, so a body clears one patch and the next body the next.
const TILE = 16;
const DEBRIS_SCAN_CAP = 2048;
// A scan is reused across sweeps this long — the ring is ~100 blocks across and every body sweeps.
const SCAN_REUSE_MS = 15000;

// A cell the executor could not clear stays refused while its memory lasts, so the board stops offering
// ground nobody can reach (Law 8: module memory, bounded by the sweep on write).
const REFUSAL_MS = 5 * 60 * 1000;
const _refused = new Map();
function refuseCell(p, now = Date.now()) {
    _refused.set(`${p.x},${p.y},${p.z}`, now);
    for (const [k, at] of _refused) if (now - at > REFUSAL_MS) _refused.delete(k);
}
function _isRefused(p, now) {
    const at = _refused.get(`${p.x},${p.y},${p.z}`);
    return at !== undefined && now - at <= REFUSAL_MS;
}

// What a block kind is to the grounds, decided once per kind: a loose plant, a leaf, ground a leaf pile
// can rest on, or none of those.
const KIND = { NONE: 0, PLANT: 1, LEAF: 2, GROUND: 3 };
const _kindOf = new Map();
const _readers = new WeakMap();
function _readerFor(bot) {
    let r = _readers.get(bot);
    if (!r) { r = makeVoxelReader(bot, { needs: ['type'] }); _readers.set(bot, r); }
    return r;
}
function _kindAt(reader, x, y, z) {
    const state = reader.stateIdAt(x, y, z);
    if (state < 0) return KIND.NONE;
    let kind = _kindOf.get(state);
    if (kind !== undefined) return kind;
    const b = reader.blockAt(x, y, z);
    if (!b || !b.name) kind = KIND.NONE;
    else if (DEBRIS_PLANTS.has(b.name)) kind = KIND.PLANT;
    else if (LEAF_RE.test(b.name)) kind = KIND.LEAF;
    else kind = b.boundingBox === 'block' && !LOG_RE.test(b.name) ? KIND.GROUND : KIND.NONE;
    _kindOf.set(state, kind);
    return kind;
}

// debrisIn(bot, centre, box, hole) → [{x,y,z}] every debris cell inside `box` (offsets from `centre`), not
// inside `hole`, within the ground band, not refused, up to DEBRIS_SCAN_CAP. The one reading of "debris
// here" for the board and the executor both (Law 16). It reads the box column by column and gives the
// body's other work a turn between columns. A leaf is debris only when it rests on the ground (a shrub or
// a leaf pile); a leaf with air under it is canopy and decays by itself once its tree is felled.
async function debrisIn(bot, centre, box, hole) {
    const reader = _readerFor(bot);
    const pace = makeExecutionPacer();
    const now = Date.now();
    const out = [];
    const yMin = centre.y - GROUND_BAND.below, yMax = centre.y + GROUND_BAND.above;
    for (let x = centre.x + box.min_dx; x <= centre.x + box.max_dx; x++) {
        for (let z = centre.z + box.min_dz; z <= centre.z + box.max_dz; z++) {
            if (hole && inBox(hole, centre, { x, y: centre.y, z })) continue;
            await pace();
            for (let y = yMin; y <= yMax; y++) {
                const kind = _kindAt(reader, x, y, z);
                if (kind !== KIND.PLANT && kind !== KIND.LEAF) continue;
                if (kind === KIND.LEAF && _kindAt(reader, x, y - 1, z) !== KIND.GROUND) continue;
                const p = { x, y, z };
                if (_isRefused(p, now)) continue;
                out.push(p);
                if (out.length >= DEBRIS_SCAN_CAP) return out;
            }
        }
    }
    return out;
}

// The ring's outer box and its footprint hole, both as offsets from the transpose origin.
function groundsOf(plan) {
    const hole = planTreeBox(plan.dimensions);
    const m = GROUNDS_MARGIN;
    return { hole, box: { min_dx: hole.min_dx - m, max_dx: hole.max_dx + m, min_dz: hole.min_dz - m, max_dz: hole.max_dz + m } };
}

let _cache = null;   // { key, at, trees, debris }
async function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.findBlocks || !bot.blockAt) return { jobs };
    const build = require('@thinking/assessors/downloaded_build');
    const structure = build.buildName();
    const row = structure && build.sitedRow(structure);
    const planRegistry = require('@kernel/downloaded_plan_registry');
    const plan = row && planRegistry.isLoaded() ? planRegistry.getPlan() : null;
    if (!plan) return { jobs };

    const centre = row.transpose_origin;
    const { box, hole } = groundsOf(plan);
    const key = `${structure}@${centre.x},${centre.y},${centre.z}`;
    const now = Date.now();
    if (!_cache || _cache.key !== key || now - _cache.at > SCAN_REUSE_MS) {
        const standing = await standingSiteTrees(bot, centre, box);
        _cache = {
            key, at: now,
            trees: standing && standing.filter(p => !inBox(hole, centre, p)),
            debris: await debrisIn(bot, centre, box, hole),
        };
    }
    const roster = Object.keys(BOT_SENIORITY).length;

    // One seat per standing trunk in the ring, capped at the roster: one id is one body, and which trunk a
    // body fells is the executor's pick off the same census.
    const trees = _cache.trees || [];
    const treeSeats = Math.min(trees.length, roster);
    for (let i = 0; i < treeSeats; i++) {
        jobs.push({ id: `grounds_trees_${structure}_${i}`, type: 'canopy', what: 'clear_trees', where: centre,
            box, hole, structure, job_type: JOB_TYPE.clear_canopy, scope: 'shared', claimed_by: null,
            why: `seat ${i + 1} of ${treeSeats} on ${trees.length} trunk(s) in the grounds of ${structure}` });
    }

    // One seat per tile that holds debris, nearest the building first.
    const tiles = new Map();
    for (const p of _cache.debris || []) {
        const tx = Math.floor((p.x - centre.x - box.min_dx) / TILE);
        const tz = Math.floor((p.z - centre.z - box.min_dz) / TILE);
        const t = tiles.get(`${tx},${tz}`) || { tx, tz, cells: [] };
        t.cells.push(p);
        tiles.set(`${tx},${tz}`, t);
    }
    const tileBox = (t) => ({
        min_dx: box.min_dx + t.tx * TILE, max_dx: Math.min(box.max_dx, box.min_dx + t.tx * TILE + TILE - 1),
        min_dz: box.min_dz + t.tz * TILE, max_dz: Math.min(box.max_dz, box.min_dz + t.tz * TILE + TILE - 1),
    });
    const away = (t) => Math.max(Math.abs(t.cells[0].x - centre.x), Math.abs(t.cells[0].z - centre.z));
    const ordered = [...tiles.values()].sort((a, b) => away(a) - away(b)).slice(0, roster);
    for (const t of ordered) {
        jobs.push({ id: `grounds_debris_${structure}_${t.tx}_${t.tz}`, type: 'clear_ground', what: 'clear_debris',
            where: centre, box: tileBox(t), hole, structure, job_type: JOB_TYPE.clear_ground, scope: 'shared',
            claimed_by: null, why: `${t.cells.length} debris block(s) in tile ${t.tx},${t.tz} of ${structure}'s grounds` });
    }
    return { jobs };
}

module.exports = { name: 'grounds', assess, debrisIn, refuseCell };
