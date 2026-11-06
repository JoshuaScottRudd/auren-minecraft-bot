// lava_portal â€” one body casts a nether portal frame in place from lava buckets, no diamond pickaxe: the mould's back wall
// gives each frame cell a face to pour on, one water bucket runs down in front of the cells a column at a time, and a lava
// source poured where water touches it sets to obsidian at once. Nothing dispatches it yet, and the mould stands before it
// is called. The cast takes the lava the pack holds and may be called again: a cell already obsidian is passed.
//
// THE MOULD, for origin (x,y,z), the frame's low corner, in the plane z, front toward +z. Y is the floor the frame stands on.
//   back wall   x..x+3, y..y+4, z-1      the face every lava pour lands on
//   cap         x..x+3, y+5,    z+1      the underside each water pour lands on, so a source hangs at y+4 in front of the frame
//   lid         x..x+3, y+4,    z+2      a settled source spreads sideways over the stand; this row holds it off the body
//   tub         a kerb and end walls at height y round the row z+1
//   stand       on the kerb at (x+2, y+1, z+2); a higher stand looks into the lid instead of under it: every frame cell and every cap face is within reach of this one spot
//
// A SOURCE WITH AIR BELOW FALLS STRAIGHT AND DOES NOT SPREAD SIDEWAYS, so each frame column gets its own pour; taking the
// water back between columns keeps the crew to one water bucket.

'use strict';

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'LAVA_PORTAL';
const WATER_RUN_MS = 1500;   // the poured column has reached the tub
const SET_MS = 400;          // the poured lava has set
const DRAIN_MS = 2500;       // a taken-back column has run dry

const OPENING_DRY_MS = 20000;   // the last column has run out of the frame's opening

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const openingDry = (bot, o) => [1, 2].every(dx => [1, 2, 3].every(dy => /air/.test(bot.blockAt(new Vec3(o.x + dx, o.y + dy, o.z))?.name || '')));

// frameCells(origin) â†’ the ten frame cells, grouped by the column whose water sets them.
function frameCells(o) {
    const at = (dx, dy) => new Vec3(o.x + dx, o.y + dy, o.z);
    return [
        { dx: 0, cells: [at(0, 1), at(0, 2), at(0, 3)] },
        { dx: 1, cells: [at(1, 0), at(1, 4)] },
        { dx: 2, cells: [at(2, 0), at(2, 4)] },
        { dx: 3, cells: [at(3, 1), at(3, 2), at(3, 3)] },
    ];
}

// use(bot, itemName, aim) â†’ whether the held item was used along a look at `aim`. The server casts the ray from this look.
async function use(bot, itemName, aim) {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) return false;
    const done = await guardExternal(TAG, `${itemName} at (${aim.x},${aim.y},${aim.z})`, async () => {
        await bot.equip(item, 'hand');
        await bot.lookAt(aim, true);
        await sleep(100);
        bot.activateItem();
    });
    return !!done.ok;
}

// fillBuckets(bot, sources) â†’ how many lava buckets are in the pack after dipping an empty bucket in each source.
async function fillBuckets(bot, sources) {
    for (const s of sources) {
        await use(bot, 'bucket', s.offset(0.5, 0.8, 0.5));
        await sleep(300);
    }
    return bot.inventory.items().filter(i => i.name === 'lava_bucket').reduce((n, i) => n + i.count, 0);
}

// cast(bot, origin) â†’ { obsidian, cells, failed[] }, read back off the world. The body stands on the mould's stand.
async function cast(bot, origin) {
    const failed = [];
    let obsidian = 0, cells = 0;
    const lavaHeld = () => bot.inventory.items().some(i => i.name === 'lava_bucket');
    const isSet = (c) => bot.blockAt(c)?.name === 'obsidian';
    for (const { dx, cells: column } of frameCells(origin)) {
        cells += column.length;
        obsidian += column.filter(isSet).length;
        if (column.every(isSet) || !lavaHeld()) continue;
        const source = new Vec3(origin.x + dx, origin.y + 4, origin.z + 1);
        if (!(await use(bot, 'water_bucket', source.offset(0.5, 0.98, 0.5)))) {
            failed.push(`no water bucket for column ${dx}`);
            continue;
        }
        await sleep(WATER_RUN_MS);
        if (bot.blockAt(source)?.name !== 'water') failed.push(`water did not land at (${source.x},${source.y},${source.z})`);
        for (const cell of column) {
            if (isSet(cell) || !lavaHeld()) continue;
            await use(bot, 'lava_bucket', cell.offset(0.5, 0.5, 0.02));
            await sleep(SET_MS);
            const set = bot.blockAt(cell)?.name;
            if (set === 'obsidian') obsidian++;
            else failed.push(`(${cell.x},${cell.y},${cell.z}) reads ${set}`);
        }
        await use(bot, 'bucket', source.offset(0.5, 0.5, 0.5));
        await sleep(DRAIN_MS);
        if (!bot.inventory.items().some(i => i.name === 'water_bucket')) failed.push(`water of column ${dx} was not taken back`);
    }
    watcher.summary(TAG, `cast at (${origin.x},${origin.y},${origin.z}): ${obsidian} of ${cells} cells obsidian.`);
    return { obsidian, cells, failed };
}

// ignite(bot, origin) â†’ the name of the block now standing in the frame's opening.
async function ignite(bot, origin) {
    const floor = new Vec3(origin.x + 1, origin.y, origin.z);
    const flint = bot.inventory.items().find(i => i.name === 'flint_and_steel');
    if (!flint) return null;
    // Water still running through the opening puts the fire out.
    for (let waited = 0; waited < OPENING_DRY_MS && !openingDry(bot, origin); waited += 500) await sleep(500);
    if (!openingDry(bot, origin)) return bot.blockAt(floor.offset(0, 1, 0))?.name;
    const lit = await guardExternal(TAG, `flint on (${floor.x},${floor.y},${floor.z})`, async () => {
        await bot.equip(flint, 'hand');
        await bot.lookAt(floor.offset(0.5, 1, 0.5), true);
        await bot.activateBlock(bot.blockAt(floor), new Vec3(0, 1, 0));
    });
    if (!lit.ok) return null;
    await sleep(800);
    return bot.blockAt(floor.offset(0, 1, 0))?.name;
}

module.exports = { frameCells, use, fillBuckets, cast, ignite };
