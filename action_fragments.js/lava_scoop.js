// lava_scoop — one body's trip for obsidian from lava open to the sky: empty buckets filled at the nearest sector the
// survey book holds lava in, carried to natural water near it, each poured on dry ground beside a water source, where it
// sets at once, and the block mined with the diamond pickaxe. A lava bucket makes one block.
//
// THE CAST CELL IS SHALLOW WATER WITH A FLOOR, BESIDE A BANK. A natural source has no dry cell beside it, its shore is level with
// it, so the bucket is poured into the water itself: the pour replaces that cell, water stands beside it, and it sets at once.
// The block has ground under it, so its drop is not lost, and the water runs back into the cell for the next pour. The body
// stands on the bank one cell away, its feet one above the pour; a pour that does not set is scooped back.

'use strict';

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { performDig } = require('@utils/movement/dig_authority');
const book = require('@perception/survey_book');
const { SECTOR_SCAN } = require('@thinking/architect_config');
const { isAirName, solid, lavaBeside, SIDES } = require('@action/obsidian_pour');
const { use, fillBuckets } = require('@action/lava_portal');

const TAG = 'LAVA_SCOOP';
const POOL_READ = 8;      // blocks round the seen lava its sources and stands are read in
const REACH = 4;          // a source this far from the stand's feet can be dipped
const SET_MS = 400;       // a poured source has set
const WATER_LOOKED_AT = 32;
const GRAVEL_TRIES = 40;   // one gravel in ten drops flint
const CRAFT_SETTLE_MS = 2000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const bodyFits = (bot, floor) => solid(bot.blockAt(floor)) && [1, 2].every(dy => isAirName(bot.blockAt(floor.offset(0, dy, 0))?.name));

// sourcesNear(bot, at) -> the lava sources with open space over them round `at`.
function sourcesNear(bot, at) {
    const out = [];
    for (let y = at.y - 2; y <= at.y + 2; y++) {
        for (let x = at.x - POOL_READ; x <= at.x + POOL_READ; x++) {
            for (let z = at.z - POOL_READ; z <= at.z + POOL_READ; z++) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && b.name === 'lava' && b.metadata === 0 && isAirName(bot.blockAt(b.position.offset(0, 1, 0))?.name)) out.push(b.position);
            }
        }
    }
    return out;
}

// dipStand(bot, sources) -> { floor, reach[] }: the dry floor with the most sources in reach, nearest the body among equals,
// no lava beside the body.
function dipStand(bot, sources) {
    if (!sources.length) return null;
    const from = bot.entity.position, a = sources[0];
    let best = null;
    for (let y = a.y - 1; y <= a.y + 2; y++) {
        for (let x = a.x - POOL_READ - REACH; x <= a.x + POOL_READ + REACH; x++) {
            for (let z = a.z - POOL_READ - REACH; z <= a.z + POOL_READ + REACH; z++) {
                const floor = new Vec3(x, y, z), feet = floor.offset(0, 1, 0);
                if (!bodyFits(bot, floor) || lavaBeside(bot, feet) || lavaBeside(bot, feet.offset(0, 1, 0))) continue;
                const reach = sources.filter(s => s.distanceTo(feet) <= REACH);
                if (!reach.length) continue;
                const d = feet.distanceTo(from);
                if (!best || reach.length > best.reach.length || (reach.length === best.reach.length && d < best.d)) best = { floor, reach, d };
            }
        }
    }
    return best;
}

// scoop(bot, want) -> lava buckets in the pack, walking the sectors that hold lava nearest first until the pack is full.
// A body at the spot that finds nothing to dip takes the spot off the page, so it is not offered again.
async function scoop(bot, want) {
    const { walkToward } = require('@api/sector_finder');
    for (const { sector, at: seen } of book.surfaceLava(bot.entity.position)) {
        if (countOf(bot, 'lava_bucket') >= want || countOf(bot, 'bucket') === 0) break;
        await walkToward(bot, seen);
        for (;;) {
            const need = want - countOf(bot, 'lava_bucket');
            if (need <= 0 || countOf(bot, 'bucket') === 0) break;
            const spot = dipStand(bot, sourcesNear(bot, new Vec3(seen.x, seen.y, seen.z)));
            if (!spot) {
                watcher.summary(TAG, `lava at (${seen.x},${seen.y},${seen.z}), sector ${sector}: no stand with a source in reach; off the page.`);
                book.closeSurfaceLava(sector);
                break;
            }
            const nav = await locomotion.goToStand({ x: spot.floor.x, y: spot.floor.y, z: spot.floor.z });
            if (!nav || nav.arrived === false) { watcher.summary(TAG, `stand (${spot.floor.x},${spot.floor.y},${spot.floor.z}) not reached.`); break; }
            const before = countOf(bot, 'lava_bucket');
            const after = await fillBuckets(bot, spot.reach.slice(0, need));
            if (after === before) { watcher.summary(TAG, `dips from (${spot.floor.x},${spot.floor.y},${spot.floor.z}) filled nothing.`); break; }
        }
    }
    return countOf(bot, 'lava_bucket');
}

// castSpot(bot) -> { cell, floor } nearest the body: a water cell with a solid floor, and a bank beside it level with its surface.
async function castSpot(bot) {
    const waters = await require('@perception/sector_scan').exposedAround(bot, bot.entity.position, SECTOR_SCAN.radius, 'water', WATER_LOOKED_AT);
    for (const w of waters) {
        const cell = new Vec3(w.x, w.y, w.z);
        if (!solid(bot.blockAt(cell.offset(0, -1, 0))) || !isAirName(bot.blockAt(cell.offset(0, 1, 0))?.name)) continue;
        for (const [dx, dz] of SIDES) {
            const floor = cell.offset(dx, 0, dz);
            if (!bodyFits(bot, floor) || lavaBeside(bot, floor.offset(0, 1, 0))) continue;
            return { cell, floor };
        }
    }
    return null;
}

// castAll(bot, spot) -> blocks taken: a pour, the block it sets to, mined and collected, until the pack holds no lava.
async function castAll(bot, { cell, floor }) {
    const { collectNearby } = require('@api/drop_collector');
    let took = 0;
    while (countOf(bot, 'lava_bucket') > 0) {
        const nav = await locomotion.goToStand({ x: floor.x, y: floor.y, z: floor.z });
        if (!nav || nav.arrived === false) { watcher.summary(TAG, `cast stand (${floor.x},${floor.y},${floor.z}) not reached.`); return took; }
        // The server's ray for a lava bucket passes through water and lands on the floor's top.
        await use(bot, 'lava_bucket', cell.offset(0.5, 0.02, 0.5));
        await sleep(SET_MS);
        const set = bot.blockAt(cell);
        if (set?.name !== 'obsidian') {
            watcher.warn(TAG, `pour at (${cell.x},${cell.y},${cell.z}) reads ${set?.name}, not obsidian.`);
            if (/lava/.test(set?.name || '')) await use(bot, 'bucket', cell.offset(0.5, 0.8, 0.5));
            return took;
        }
        if (!(await performDig(bot, cell, set, TAG, { waterCell: true }))) { watcher.warn(TAG, `obsidian at (${cell.x},${cell.y},${cell.z}) could not be mined.`); return took; }
        await collectNearby(bot);
        await sleep(SET_MS);
        took++;
    }
    return took;
}

// obsidianTrip(bot, want) -> { readable, produced }: buckets drawn, lava scooped, cast at water, mined. What it does not cast
// is carried home by the next dump.
async function obsidianTrip(bot, want) {
    // Lava a trip carried home is used first, then empty buckets.
    const lens = require('@kernel/inventory_lens'), swapper = require('@api/inventory_swapper');
    for (const item of ['lava_bucket', 'bucket']) {
        const pocket = countOf(bot, 'bucket') + countOf(bot, 'lava_bucket');
        const draw = Math.min(lens.inChests(item), Math.max(0, want - pocket));
        if (draw > 0) await swapper.retrieveItems(bot, item, draw);
    }
    const before = countOf(bot, 'obsidian');
    const scooped = await scoop(bot, want);
    if (scooped === 0) return { readable: 'obsidian: no lava scooped', produced: false };
    const spot = await castSpot(bot);
    if (!spot) return { readable: `obsidian: ${scooped} lava bucket(s) and no dry bank beside water in reach; carried home`, produced: false };
    const took = await castAll(bot, spot);
    watcher.summary(TAG, `LAVA_TRIP scooped=${scooped} cast_at=${spot.cell.x},${spot.cell.y},${spot.cell.z} took=${took} held=${countOf(bot, 'obsidian')}`);
    return { readable: `obsidian: ${scooped} lava bucket(s) scooped, ${countOf(bot, 'obsidian') - before} block(s) in the pack`, produced: took > 0 };
}

// ensureFlintAndSteel(bot) -> whether the pack holds one: the chests', or crafted from an ingot and flint. Flint comes from the
// chests or from gravel open to the sky near the body, dug until one drops.
async function ensureFlintAndSteel(bot) {
    const lens = require('@kernel/inventory_lens'), swapper = require('@api/inventory_swapper');
    if (countOf(bot, 'flint_and_steel') > 0) return true;
    if (lens.inChests('flint_and_steel') > 0) await swapper.retrieveItems(bot, 'flint_and_steel', 1);
    if (countOf(bot, 'flint_and_steel') > 0) return true;
    if (countOf(bot, 'flint') === 0 && lens.inChests('flint') > 0) await swapper.retrieveItems(bot, 'flint', 1);
    if (countOf(bot, 'flint') === 0) {
        const { collectNearby } = require('@api/drop_collector');
        const gravel = await require('@perception/sector_scan').exposedAround(bot, bot.entity.position, SECTOR_SCAN.radius, 'gravel', GRAVEL_TRIES);
        for (const g of gravel) {
            if (countOf(bot, 'flint') > 0) break;
            const nav = await locomotion.goTo({ x: g.x, y: g.y, z: g.z, leg: 'work', purpose: 'gravel' });
            if (!nav || nav.arrived === false) continue;
            const p = new Vec3(g.x, g.y, g.z), b = bot.blockAt(p);
            if (b?.name === 'gravel' && await performDig(bot, p, b, TAG)) await collectNearby(bot);
        }
        watcher.summary(TAG, `flint from gravel: ${gravel.length} gravel in sight, ${countOf(bot, 'flint')} flint held.`);
    }
    if (countOf(bot, 'flint') === 0) return false;
    if (countOf(bot, 'iron_ingot') === 0 && lens.inChests('iron_ingot') > 0) await swapper.retrieveItems(bot, 'iron_ingot', 1);
    if (countOf(bot, 'iron_ingot') === 0) return false;
    const id = bot.registry.itemsByName.flint_and_steel.id;
    const recipe = bot.recipesFor(id, null, 1, null)[0];
    if (!recipe) return false;
    await require('@utils/external_library_guard').guardExternal(TAG, 'craft flint_and_steel', () => bot.craft(recipe, 1, null));
    // The server's inventory update follows the craft's return.
    for (let waited = 0; waited < CRAFT_SETTLE_MS && countOf(bot, 'flint_and_steel') === 0; waited += 100) await sleep(100);
    return countOf(bot, 'flint_and_steel') > 0;
}

// portalTrip(bot) -> { readable, produced }: the frame cells still open are counted, lava scooped for as many as the crew's
// buckets carry with one left for water, and cast from the mould's stand. The board offers the job again until the frame is
// whole; a whole frame is lit. Turn 0 only: the frame's low corner is the blueprint's (1,1,1).
async function portalTrip(bot) {
    const { PORTAL_MOULD } = require('@thinking/architect_config');
    const { frameCells, cast, ignite } = require('@action/lava_portal');
    const origin = require('@utils/fragment_utils').readTransposeOrigin(PORTAL_MOULD);
    if (!origin) return { readable: 'portal: the mould is not sited', produced: false };
    const o = new Vec3(origin.x + 1, origin.y + 1, origin.z + 1);
    const open = () => frameCells(o).flatMap(c => c.cells).filter(c => bot.blockAt(c)?.name !== 'obsidian').length;
    const stand = { x: o.x + 2, y: o.y, z: o.z + 2 };
    const reach = async () => { const nav = await locomotion.goToStand(stand); return !!nav && nav.arrived !== false; };
    if (!(await reach())) return { readable: 'portal: the mould stand could not be reached', produced: false };
    if (open() > 0) {
        const lens = require('@kernel/inventory_lens'), swapper = require('@api/inventory_swapper');
        if (!(await require('@action/land_prep').fillBucket(bot, 1))) return { readable: 'portal: no water bucket could be filled', produced: false };
        for (const item of ['lava_bucket', 'bucket']) {
            const draw = Math.min(lens.inChests(item), Math.max(0, open() - countOf(bot, 'bucket') - countOf(bot, 'lava_bucket')));
            if (draw > 0) await swapper.retrieveItems(bot, item, draw);
        }
        const scooped = await scoop(bot, Math.min(open(), countOf(bot, 'bucket') + countOf(bot, 'lava_bucket')));
        if (scooped === 0) return { readable: 'portal: no lava scooped', produced: false };
        if (!(await reach())) return { readable: `portal: ${scooped} lava bucket(s) and the mould stand not reached`, produced: false };
        const r = await cast(bot, o);
        watcher.summary(TAG, `PORTAL_TRIP scooped=${scooped} obsidian=${r.obsidian}/${r.cells} failed=${r.failed.length}${r.failed.length ? ` ${r.failed[0]}` : ''}`);
        if (open() > 0) return { readable: `portal: frame ${r.obsidian} of ${r.cells} cells`, produced: true };
    }
    if (!(await ensureFlintAndSteel(bot))) return { readable: 'portal: the frame stands and no flint and steel could be made', produced: false };
    if (!(await reach())) return { readable: 'portal: the mould stand not reached with the flint', produced: false };
    const lit = await ignite(bot, o);
    watcher.summary(TAG, `PORTAL_TRIP lit=${lit}`);
    if (lit !== 'nether_portal') return { readable: `portal: the frame stands; the opening reads ${lit}`, produced: false };
    book.notePortalLit();
    return { readable: 'portal: lit', produced: true };
}

module.exports = { obsidianTrip, portalTrip, scoop };
