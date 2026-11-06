// obsidian_pour — one body's trip to a lava pool the tunnels logged (survey_book.noteLava): water poured so it runs out
// over the pool's top, the water taken back, and the obsidian it made mined with the diamond pickaxe. mining_manager
// carries the body here and home; this owns only the work at the pool.
//
// THE FEET STAND ONE ABOVE THE LAVA. The stand's floor is level with the pool's top, so no cell a body opens lies beside
// lava and nothing flows. Water poured on the next cell toward the pool (the lip) runs over the edge onto the lava, and
// a lava source water touches turns to obsidian.
//
// OBSIDIAN OVER LAVA IS LEFT. A block mined there drops into the lava and burns, so only a block with a solid floor is
// taken. A deep pool gives its edge and no more; a row closes when a pass finds nothing left to take.

'use strict';

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');
const { performDig } = require('@utils/movement/dig_authority');
const { guardExternal } = require('@utils/external_library_guard');
const surveyBook = require('@perception/survey_book');

const TAG = 'OBSIDIAN_POUR';
const SEARCH = 6;        // blocks round the logged cell the pool's top is read in
const SPREAD = 8;        // blocks round the lip the poured obsidian is read in
const SET_MS = 4000;     // water has run out over the pool
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isAirName = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
const isLava = (b) => !!b && /lava/.test(b.name);
const isFluidName = (b) => !!b && /lava|water|bubble_column/.test(b.name);
const solid = (b) => !!b && !isAirName(b.name) && !isFluidName(b) && b.boundingBox === 'block';

// lavaBeside(bot, p) → whether lava stands on any side of, over or under this cell.
function lavaBeside(bot, p) {
    const round = [...SIDES.map(([dx, dz]) => p.offset(dx, 0, dz)), p.offset(0, 1, 0), p.offset(0, -1, 0)];
    return round.some(c => isLava(bot.blockAt(c)));
}

// findStand(bot, at) → { lava, lip, stand } nearest this body: `lava` a source on the pool's top, `lip` the open-able cell
// beside the space over it, level with the feet, `stand` the cell behind the lip. Every cell a body opens has no lava
// beside it but the lip's own edge cell below, and both floors are solid and level with the pool's top. Null with none.
function findStand(bot, at) {
    const found = [];
    for (let y = at.y - SEARCH; y <= at.y + SEARCH; y++) {
        for (let x = at.x - SEARCH; x <= at.x + SEARCH; x++) {
            for (let z = at.z - SEARCH; z <= at.z + SEARCH; z++) {
                const lava = bot.blockAt(new Vec3(x, y, z));
                if (!lava || lava.name !== 'lava' || lava.metadata !== 0) continue;
                const over = bot.blockAt(lava.position.offset(0, 1, 0));
                if (!over || isFluidName(over)) continue;
                for (const [dx, dz] of SIDES) {
                    const lip = new Vec3(x + dx, y + 1, z + dz), stand = new Vec3(x + 2 * dx, y + 1, z + 2 * dz);
                    const cells = [lip, lip.offset(0, 1, 0), stand, stand.offset(0, 1, 0)];
                    if (cells.some(c => { const b = bot.blockAt(c); return !b || isFluidName(b) || lavaBeside(bot, c); })) continue;
                    if (!solid(bot.blockAt(lip.offset(0, -1, 0))) || !solid(bot.blockAt(stand.offset(0, -1, 0)))) continue;
                    found.push({ lava: lava.position, lip, stand });
                }
            }
        }
    }
    const from = bot.entity.position;
    found.sort((a, b) => a.stand.distanceTo(from) - b.stand.distanceTo(from));
    return found[0] || null;
}

// open(bot, cell) → whether this cell is air, dug if it was rock.
async function open(bot, cell) {
    const b = bot.blockAt(cell);
    if (!b) return false;
    if (isAirName(b.name)) return true;
    return performDig(bot, cell, b, TAG);
}

// takeWaterBack(bot, lip) — the empty bucket dipped in the source on the lip, so the crew keeps its water and the tunnel dries.
async function takeWaterBack(bot, lip) {
    const bucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (!bucket) return false;
    const done = await guardExternal(TAG, `dip at (${lip.x},${lip.y},${lip.z})`, async () => {
        await bot.equip(bucket, 'hand');
        await bot.lookAt(lip.offset(0.5, 0.2, 0.5), true);
        bot.activateItem();
    });
    await sleep(500);
    return !!done.ok && bot.inventory.items().some(i => i.name === 'water_bucket');
}

// mineWhatItMade(bot, lip) → how many blocks came out: obsidian with a solid floor round the lip, nearest first.
async function mineWhatItMade(bot, lip) {
    let took = 0;
    const passed = new Set();   // a block no stand reaches is passed, and the rest are still taken
    for (;;) {
        const cells = [];
        for (let y = lip.y - 2; y <= lip.y; y++) {
            for (let x = lip.x - SPREAD; x <= lip.x + SPREAD; x++) {
                for (let z = lip.z - SPREAD; z <= lip.z + SPREAD; z++) {
                    const p = new Vec3(x, y, z), b = bot.blockAt(p);
                    if (b && b.name === 'obsidian' && !passed.has(p.toString()) && solid(bot.blockAt(p.offset(0, -1, 0))) && !lavaBeside(bot, p)) cells.push(b);
                }
            }
        }
        if (!cells.length) return took;
        const from = bot.entity.position;
        cells.sort((a, b) => a.position.distanceTo(from) - b.position.distanceTo(from));
        const b = cells[0], p = b.position;
        // THE BODY STANDS BESIDE THE BLOCK, NEVER ON IT: a block under the feet is refused by the dig authority.
        const floor = SIDES.map(([dx, dz]) => p.offset(dx, 0, dz)).find(c => solid(bot.blockAt(c)) && isAirName(bot.blockAt(c.offset(0, 1, 0))?.name) && isAirName(bot.blockAt(c.offset(0, 2, 0))?.name));
        const nav = floor ? await locomotion.goToStand({ x: floor.x, y: floor.y, z: floor.z }) : null;
        if (!nav || nav.arrived === false || !(await performDig(bot, p, bot.blockAt(p), TAG))) {
            watcher.summary(TAG, `obsidian at (${p.x},${p.y},${p.z}) could not be taken; passed.`);
            passed.add(p.toString());
            continue;
        }
        took++;
    }
}

// workPool(bot) → what the trip did, in words for the release. A pool with no stand, or nothing left to take, is closed.
async function workPool(bot) {
    const pool = surveyBook.openLava(bot.entity.position)[0];
    if (!pool) return 'no pool is logged';
    // The pool is read from where the trip stands: a tunnel's ground is in the columns the shaft loads.
    if (!bot.blockAt(new Vec3(pool.at.x, pool.at.y, pool.at.z))) return `pool at (${pool.at.x},${pool.at.y},${pool.at.z}) is not loaded from here`;
    const spot = findStand(bot, pool.at);
    if (!spot) {
        surveyBook.closeLava(pool.key, 'no stand a body can pour from');
        return `pool at (${pool.at.x},${pool.at.y},${pool.at.z}) has no stand to pour from; closed`;
    }
    const { lava, lip, stand } = spot;
    watcher.summary(TAG, `pool (${lava.x},${lava.y},${lava.z}): standing at (${stand.x},${stand.y},${stand.z}), feet one above the lava, pouring on the lip (${lip.x},${lip.y},${lip.z}).`);
    const at = await locomotion.goToStand({ x: stand.x, y: stand.y - 1, z: stand.z });
    if (!at || at.arrived === false) return `stand (${stand.x},${stand.y},${stand.z}) could not be reached`;
    if (!(await open(bot, lip.offset(0, 1, 0))) || !(await open(bot, lip))) return `lip (${lip.x},${lip.y},${lip.z}) could not be opened`;
    if (!(await require('@action/farm_executor').pourWater(bot, lip))) return `pour on the lip (${lip.x},${lip.y},${lip.z}) refused`;
    await sleep(SET_MS);
    const back = await takeWaterBack(bot, lip);
    if (!back) watcher.warn(TAG, `the water on the lip (${lip.x},${lip.y},${lip.z}) was not taken back.`);
    await sleep(SET_MS);
    const took = await mineWhatItMade(bot, lip);
    watcher.summary(TAG, `pool (${lava.x},${lava.y},${lava.z}): ${took} obsidian taken, water ${back ? 'taken back' : 'left on the lip'}.`);
    if (took === 0) surveyBook.closeLava(pool.key, 'a pour left nothing to take');
    return `${took} obsidian taken from the pool at (${lava.x},${lava.y},${lava.z})`;
}

module.exports = { workPool, isAirName, solid, lavaBeside, SIDES };
