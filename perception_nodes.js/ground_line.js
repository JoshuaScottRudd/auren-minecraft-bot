// fragment: ground_line (perception)
// purpose: Reads a square of loaded ground once and answers the questions sector_scan asks of it: what kind of
//          block sits at a cell, where each column's ground line is, and whether that line is a liquid (Law 16).
// invariants:
//  - The ground line of a column is its highest block that is neither passable nor vegetation. Leaves, logs and
//    the like stand on the ground and never roof it; a column whose line is water or lava is wet.
//  - Passable here means an empty collision box that is not a liquid: the cells a body walks through.
//  - A column outside the loaded world has no line (minY - 1), never a guessed one (Law 23).
//  - Blocks above the line that belong to a survey category (logs, cactus, sugar cane) are kept as `above`, the
//    open-sky growth a sector scan reports.
//  - The descent of every column is paced between rows, so the body's loop keeps its turns.
//  - An area lives only inside the function handed to withArea; its reader is released when that returns (Law 8).

'use strict';

const { makeVoxelScan } = require('@utils/execution_yield');
const { withCleanup } = require('@utils/external_library_guard');
const { SURVEY_CATEGORIES } = require('@thinking/architect_config');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const NATURAL = /^(stone|deepslate|tuff|granite|diorite|andesite|calcite|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|gravel|sand|red_sand|sandstone|red_sandstone|clay|.*terracotta|dripstone_block|moss_block|snow_block|packed_ice|ice|blue_ice|obsidian|bedrock|.*_ore|smooth_basalt|basalt|amethyst_block|budding_amethyst)$/;
const VEGETATION = /(_leaves|_log|_wood|_stem|_hyphae|mushroom_block|bamboo|cactus|vine|_roots)$/;

function categoryOf(name) {
    for (const c of SURVEY_CATEGORIES) if (c.pattern.test(name)) return c.category;
    return null;
}

// What a state id is, for these classifiers: a fact about Minecraft, cached per registry.
const _kinds = new WeakMap();
function kindTable(bot) {
    let info = _kinds.get(bot.registry);
    if (!info) { info = []; _kinds.set(bot.registry, info); }
    const byState = bot.registry.blocksByStateId;
    return (s) => {
        let k = info[s];
        if (k !== undefined) return k;
        const b = byState[s];
        const name = b ? b.name : `state_${s}`;
        const liquid = LIQUID.has(name);
        k = { name, pass: !!b && b.boundingBox === 'empty' && !liquid, liquid,
              natural: NATURAL.test(name), veg: VEGETATION.test(name), category: categoryOf(name),
              air: name === 'air' || name === 'cave_air' || name === 'void_air' };
        info[s] = k;
        return k;
    };
}

function worldHeight(bot) {
    const minY = bot.game && bot.game.minY, height = bot.game && bot.game.height;
    if (!Number.isInteger(minY) || !Number.isInteger(height)) {
        throw new Error(`[ground_line] CODING VIOLATION (Law 13): the world's height was not announced `
            + `(bot.game.minY=${minY}, bot.game.height=${height}), so no column can be read top to bottom.`);
    }
    return { minY, maxY: minY + height };
}

// surfaceAt(bot, x, z) -> { y, wet } for one loaded column: y is the cell above its ground line, where a body
// stands; wet when that line is water or lava. Null where the column is not loaded.
function surfaceAt(bot, x, z) {
    const { minY, maxY } = worldHeight(bot);
    const reader = require('@utils/voxel_reader').makeVoxelReader(bot, { needs: ['type'] });
    const kindOf = kindTable(bot);
    return require('@utils/external_library_guard').withCleanupSync('ground_line', 'read one column', () => {
        for (let y = maxY - 1; y >= minY; y--) {
            const s = reader.stateIdAt(x, y, z);
            if (s < 0) return null;
            const k = kindOf(s);
            if (k.pass || k.veg) continue;
            return { y: y + 1, wet: k.liquid };
        }
        return null;
    }, () => reader.dispose());
}

// withArea(bot, center, radius, fn, opts) -> fn(area). `center` is a world cell; the square is radius blocks each
// way. opts.combatGate false for a body with no fight in it (the foreman's desk), as makeVoxelScan takes it.
// standNear(bot, x, z, reach) -> the nearest dry surface cell to (x, z) within `reach`, ring by ring, or null.
function standNear(bot, x, z, reach) {
    for (let r = 0; r <= reach; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const s = surfaceAt(bot, x + dx, z + dz);
            if (s && !s.wet) return { x: x + dx, y: s.y, z: z + dz };
        }
    }
    return null;
}

async function withArea(bot, center, radius, fn, opts = {}) {
    const scan = makeVoxelScan(bot, { needs: ['type'], source: 'ground_line', combatGate: opts.combatGate });
    return withCleanup('ground_line', 'read the ground', async () => fn(await readArea(bot, scan, center, radius)), () => scan.dispose());
}

async function readArea(bot, scan, center, radius) {
    const { minY, maxY } = worldHeight(bot);
    const kindOf = kindTable(bot);
    const NONE = null;
    const cx = Math.floor(center.x), cz = Math.floor(center.z);
    const W = 2 * radius + 1, ox = cx - radius, oz = cz - radius;
    // The kind of block at a cell, or null where the world is not loaded.
    const at = (x, y, z) => {
        if (y < minY || y >= maxY) return NONE;
        const s = scan.stateIdAt(x, y, z);
        return s < 0 ? NONE : kindOf(s);
    };
    const inside = (x, z) => x >= ox && x < ox + W && z >= oz && z < oz + W;
    const ci = (x, z) => (z - oz) * W + (x - ox);
    const ground = new Int16Array(W * W).fill(minY - 1);
    const wet = new Uint8Array(W * W);
    const above = [];

    for (let x = ox; x < ox + W; x++) {
        for (let z = oz; z < oz + W; z++) {
            if (scan.stateIdAt(x, minY, z) < 0) continue;
            for (let y = maxY - 1; y >= minY; y--) {
                const k = at(x, y, z);
                if (!k) break;   // unloaded between rows: the column keeps no line
                if (k.pass || k.veg) {
                    if (k.category && !k.air) above.push({ x, y, z, category: k.category });
                    continue;
                }
                ground[ci(x, z)] = y;
                if (k.liquid) wet[ci(x, z)] = 1;
                break;
            }
        }
        await scan.pace();
    }

    return {
        center: { x: cx, z: cz }, radius, W, ox, oz, minY, maxY, above,
        at, inside,
        groundAt: (x, z) => inside(x, z) ? ground[ci(x, z)] : minY - 1,
        wetAt: (x, z) => inside(x, z) && wet[ci(x, z)] === 1,
        // Passable: a body may stand in it. Unloaded is never passable.
        pass: (x, y, z) => { const k = at(x, y, z); return !!k && k.pass; },
        pace: () => scan.pace(),
        // A whole cell index for sets over the square, the cells one block past its edge included.
        key: (x, y, z) => ((y - minY) * (W + 2) + (z - oz + 1)) * (W + 2) + (x - ox + 1),
    };
}

// lines(bot) -> { groundAt(x, z), pass(x, y, z), minY, dispose() }: the same ground lines as an area, over no square,
// each column read once and only when asked; for a ring search whose cells are not known before it reads them.
// The caller disposes it (Law 8).
function lines(bot) {
    const { minY, maxY } = worldHeight(bot);
    const reader = require('@utils/voxel_reader').makeVoxelReader(bot, { needs: ['type'] });
    const kindOf = kindTable(bot);
    const at = (x, y, z) => {
        if (y < minY || y >= maxY) return null;
        const s = reader.stateIdAt(x, y, z);
        return s < 0 ? null : kindOf(s);
    };
    const memo = new Map();
    return {
        minY,
        groundAt(x, z) {
            const key = `${x},${z}`;
            const held = memo.get(key);
            if (held !== undefined) return held;
            let g = minY - 1;
            for (let y = maxY - 1; y >= minY; y--) {
                const k = at(x, y, z);
                if (!k) break;   // unloaded between rows: the column keeps no line
                if (k.pass || k.veg) continue;
                g = y;
                break;
            }
            memo.set(key, g);
            return g;
        },
        pass: (x, y, z) => { const k = at(x, y, z); return !!k && k.pass; },
        dispose: () => reader.dispose(),
    };
}

module.exports = { withArea, surfaceAt, standNear, categoryOf, lines };
