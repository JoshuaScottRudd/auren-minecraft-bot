// fragment: waste_pit
// purpose: the one route for a pocket's trash (Law 16). The pit is a building (architect_config.WASTE_PIT,
//          the `waste_pit` blueprint): the foreman sites it beside the yard and the crew builds it on the
//          building ladder. It takes what no chest should hold — the wooden pickaxes a stone set replaced,
//          gravel, flint and the stone variants nothing builds with — and the world despawns it five minutes
//          later. A body stands on a pad cell beside the hole and throws. Until the pit stands, trash is
//          banked. The pit's column is a closed box to the route planner (navigator.loadClosedBoxes), so no
//          body walks into it and picks the trash back up.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'waste_pit';

// The pit's world geometry, read off its blueprint at its locked site, or null while it has no site. The
// blueprint's origin is the hole at pad level: the hole is its column of `air`, the pad is the floor round it.
function geometry() {
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('waste_disposal')) return null;
    const { WASTE_PIT } = require('@thinking/architect_config');
    const o = require('@utils/fragment_utils').readTransposeOrigin(WASTE_PIT.structure);
    if (!o) return null;
    const building = require('@kernel/blueprint_registry').getBuilding(WASTE_PIT.structure, TAG);
    const voxels = require('@kernel/site_chairs').collectAllVoxels(building);
    const at = v => new Vec3(o.x + v[0], o.y + v[1], o.z + v[2]);
    const holes = voxels.filter(v => v[0] === 0 && v[2] === 0).map(at).sort((a, b) => b.y - a.y);
    const pad = voxels.filter(v => v[1] === 0 && (v[0] !== 0 || v[2] !== 0)).map(at);
    const open = voxels.filter(v => v[1] > 0 && (v[0] !== 0 || v[2] !== 0)).map(at);
    return {
        holes,                                              // every cell of the pit, top-down
        pad,                                                // the eight floor blocks round the hole
        open,                                               // the air the pad keeps over it
        rims: pad.filter(c => c.x === o.x || c.z === o.z),  // the four a thrower stands ON, each sharing a side with the hole
        aim: new Vec3(o.x + 0.5, o.y + 1, o.z + 0.5),
        box: { min: { x: o.x, y: holes[holes.length - 1].y, z: o.z }, max: { x: o.x, y: holes[0].y, z: o.z } },
    };
}

// The pit's column as a box the route planner may not enter, or null before the yard is sited.
function closedBox() {
    const g = geometry();
    return g ? g.box : null;
}

// holds(pos) — true when a drop at `pos` lies in the pit's column at or below its top: thrown away, so no
// collector or salvage job may ever offer it back.
function holds(pos) {
    const b = closedBox();
    if (!b || !pos) return false;
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    return x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && y <= b.max.y;
}

// chestKeeps — WHAT A CHEST HOLDS: what is taken out of the world, what a furnace, a farm or a hunt makes of
// it, and what the shelf has a standing order for. The rest is made by a body from those, for the job in its
// hands, and is used there: a tool, a torch, a plank, a stair. One of those left over goes to the pit.
function chestKeeps(item) {
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('waste_disposal')) return true;
    const { madeToOrder } = require('@thinking/architect_config');
    if (madeToOrder(item)) return false;
    if (require('@thinking/requested_work').activeStockRows().some(r => r.holder === 'storage' && r.item === item)) return true;
    const { isRawMaterial, isChainOwned } = require('@utils/calculators/build_material_calculator');
    if (isRawMaterial(item) || isChainOwned(item)) return true;
    return !require('@kernel/crafting_blueprint_registry').recipeForToken(item);
}

// ── A MADE GOOD IS STORED ONLY AFTER A CUBE TRIP THAT DID NOT GET BUILT ─────────────────────────────────
// A trip that built its cube pits what it made and did not place, so the chests stay clear. A trip that
// crafted and did not build banks those blocks, up to what the building still asks for, and the next trip
// for that cube takes them finished. The state is this body's last cube trip (Law 9: module-level).
let _cubeTripUnbuilt = false;
function cubeTripUnbuilt() { _cubeTripUnbuilt = true; }
function cubeTripBuilt() { _cubeTripUnbuilt = false; }

// How many of one made good the fleet's chests hold now.
function _madeInChests(item) {
    let n = 0;
    for (const chest of require('@perception/station_registry').findChests()) {
        for (const it of (Array.isArray(chest.items) ? chest.items : [])) if (it.name === item) n += it.count || 0;
    }
    return n;
}

// madeGoodOrdered(item) → how many of a made good the building's last whole reading still asks for; 0 before
// any reading, so an unread building stores nothing.
function madeGoodOrdered(item) {
    return require('@thinking/assessors/downloaded_build').stillOrdered(item) || 0;
}

// How many more of a made good this body may bank: none after a built trip, and after an unbuilt one what the
// building still asks for past what the chests already hold.
function _madeGoodRoom(item) {
    if (!_cubeTripUnbuilt) return 0;
    return Math.max(0, madeGoodOrdered(item) - _madeInChests(item));
}

// What in this pocket is trash, as {item: count}. A listed item is trash past what its pocket row keeps
// and what the held order still wants (inventory_swapper.computeExcess); a wooden pickaxe is trash once
// the body holds the pickaxe row's stone set, so it goes in the moment the stone ones are taken.
function trashIn(bot) {
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('waste_disposal')) return {};
    const { WASTE_PIT } = require('@thinking/architect_config');
    const STOCK_THRESHOLDS = require('@thinking/requested_work').activeStockRows();
    const inv = {};
    for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
    const swapper = require('@api/inventory_swapper');
    const excess = swapper.computeExcess(inv, require('@thinking/job_board.js').INVENTORY_WHITELIST, swapper.heldOrderDemand());
    const trash = {};
    for (const item of WASTE_PIT.items) {
        if (item === 'wooden_pickaxe') continue;
        if (excess[item] > 0) trash[item] = excess[item];
    }
    // WHAT A CHEST DOES NOT KEEP IS TRASH past what the pocket's own row keeps, less the made goods an unbuilt
    // cube trip may bank (_madeGoodRoom).
    for (const [item, n] of Object.entries(excess)) {
        if (n <= 0 || chestKeeps(item)) continue;
        const over = n - _madeGoodRoom(item);
        if (over > 0) trash[item] = over;
    }
    // DIRT PAST WHAT THE BUILDING ASKS IS TRASH: the chests already hold the building's dirt, so the pocket's goes in the pit.
    const dirt = require('@utils/trash');
    if (excess[dirt.STAND_IN] > 0 && dirt.dirtIsSurplus()) trash[dirt.STAND_IN] = excess[dirt.STAND_IN];
    const row = STOCK_THRESHOLDS.find(r => r.item === 'pickaxe' && r.holder === 'bot');
    const stone = require('@thinking/assessors/shared').stoneOrBetter('pickaxe', inv);
    if (inv.wooden_pickaxe > 0 && row && row.stone_level && stone >= row.stone_level) trash.wooden_pickaxe = inv.wooden_pickaxe;
    return trash;
}

// What of the pit does not stand yet, read off the world, or null when it is whole: the hole open to its
// floor, the pad's eight blocks in place, the air over the pad clear. A cell this body cannot see is not
// judged. Building it is the building ladder's work (assessors/building, the `waste_pit` blueprint).
function _notBuilt(bot, g) {
    const solid = c => { const b = bot.blockAt(c); return b ? b.boundingBox === 'block' : null; };
    const hole = g.holes.find(c => solid(c) === true);
    if (hole) return `the hole is not dug at (${hole.x},${hole.y},${hole.z})`;
    const floor = g.pad.find(c => solid(c) === false);
    if (floor) return `the pad has no floor at (${floor.x},${floor.y},${floor.z})`;
    const over = g.open.find(c => solid(c) === true);
    if (over) return `the pad is not clear at (${over.x},${over.y},${over.z})`;
    return null;
}

// stands(bot) — is the pit sited, wholly in this body's sight, and built? The question a fragment asks before it
// takes trash in hand for the pit.
function stands(bot) {
    const g = geometry();
    if (!g || !bot || !bot.blockAt) return false;
    if ([...g.holes, ...g.pad, ...g.open].some(c => !bot.blockAt(c))) return false;
    return _notBuilt(bot, g) === null;
}

// discardTrash — walks to a rim of the built pit and throws in everything trashIn names. Returns
// { tossed, items } — tossed 0 and a reason when there is no pit to use, in which case the caller banks the
// pocket as it always has.
async function discardTrash(bot) {
    bot = bot || global.bot;
    if (!bot?.entity?.position) return { tossed: 0, items: [], reason: 'no body' };
    const trash = trashIn(bot);
    if (Object.keys(trash).length === 0) return { tossed: 0, items: [] };
    const g = geometry();
    if (!g) return { tossed: 0, items: [], reason: 'no pit sited' };
    const early = _notBuilt(bot, g);
    if (early) {
        watcher.summary(TAG, `WASTE PIT not built yet — ${early}; the trash is banked instead.`);
        return { tossed: 0, items: [], reason: 'pit not built' };
    }

    // THE THROW IS MADE FROM A RIM CELL AND NOWHERE ELSE: the nearest rim the body can reach, and its feet are
    // read on that cell before anything is thrown.
    const here = bot.entity.position;
    const onRim = r => { const f = bot.entity.position.floored(); return f.x === r.x && f.z === r.z; };
    const goToStand = require('@locomotion/locomotion_dispatcher').goToStand;
    let rim = null, nav = null;
    for (const r of g.rims.slice().sort((a, b) => a.distanceTo(here) - b.distanceTo(here))) {
        nav = await goToStand(r, { purpose: 'waste_pit' });
        if (nav && nav.arrived && !onRim(r)) nav = await goToStand(r, { purpose: 'waste_pit' });
        if (nav && nav.arrived && onRim(r)) { rim = r; break; }
    }
    if (!rim) {
        const f = bot.entity.position.floored();
        watcher.warn(TAG, `WASTE PIT not reached — no rim of the hole (${g.box.min.x},${g.box.min.z}) was stood on (${nav?.arrived ? `the walk ended at (${f.x},${f.y},${f.z})` : nav?.reason || 'unreachable'}); the trash is banked instead.`);
        return { tossed: 0, items: [], reason: 'rim unreachable' };
    }
    const unbuilt = _notBuilt(bot, g);
    if (unbuilt) {
        watcher.summary(TAG, `WASTE PIT not built yet — ${unbuilt}; the trash is banked instead.`);
        return { tossed: 0, items: [], reason: 'pit not built' };
    }

    // A forced look goes to the server on the next physics tick, and the toss flies where the server has the
    // head pointing: the ticks are waited out before anything leaves the pocket.
    await guardExternal(TAG, 'lookAt the pit', async () => { await bot.lookAt(g.aim, true); await bot.waitForTicks(LOOK_SETTLE_TICKS); });
    const book = require('@kernel/item_book');
    const held = name => bot.inventory.items().reduce((s, it) => s + (it.name === name ? it.count : 0), 0);
    const items = [];
    let missed = 0;
    for (const [name, count] of Object.entries(trash)) {
        const type = bot.registry.itemsByName[name]?.id;
        if (type == null) continue;
        await book.open();
        const before = held(name);
        const watch = _watchThrow(bot, name);
        await guardExternal(TAG, `toss ${count} ${name}`, () => bot.toss(type, null, count));
        const stacks = await watch.followToRest(g);
        await book.close('toss', 'pit');
        const left = before - held(name);
        if (left <= 0) continue;
        items.push({ item: name, tossed: left });
        const seen = stacks.reduce((s, r) => s + r.count, 0);
        for (const r of stacks) {
            book.report({ k: 'th', e: r.id, i: name, n: r.count, rest: r.rest, in_pit: r.inPit, end: r.end });
            if (r.mergedInto != null) book.report({ k: 'al', from: r.id, to: r.mergedInto });
            if (!r.inPit) {
                missed += r.count;
                watcher.warn(TAG, `WASTE PIT MISS — ${name}x${r.count} (entity ${r.id}) ${r.end} at (${r.rest.join(',')}), outside the pit (${g.box.min.x},${g.box.min.z})…(${g.box.max.x},${g.box.max.z}).`);
            }
        }
        if (seen < left) {
            missed += left - seen;
            book.report({ k: 'th', e: null, i: name, n: left - seen, rest: null, in_pit: false, end: 'not_seen' });
            watcher.warn(TAG, `WASTE PIT THROW NOT SEEN — ${name}x${left - seen} left the pocket and no thrown stack was seen for it.`);
        }
    }
    book.flush();
    const n = items.reduce((s, i) => s + i.tossed, 0);
    // Made goods are named apart: a made thing left over after a built trip is pitted by design.
    const made = items.filter(i => !chestKeeps(i.item));
    watcher.summary(TAG, `WASTE PIT tossed ${n} item(s): ${items.map(i => `${i.item}x${i.tossed}`).join(', ') || 'none'}. `
        + `Made goods among them: ${made.map(i => `${i.item}x${i.tossed}`).join(', ') || 'none'}. In the pit ${n - missed}, outside it ${missed}.`);
    return { tossed: n, items };
}

// ── Throw accountability: each thrown stack is followed by its entity id until it stops. ──
// A toss leaves the pocket as several small stacks, each with its own id, appearing at the thrower's own
// eye column — which is what tells them from a peer's throw at the next rim. Each is counted once, at the
// moment the server first describes it; siblings then merge in the air and the survivors fall on.
//   in the pit      it stops inside the pit's column below the rim, or vanishes inside that column
//                   (it joined the pile beneath it)
//   merged_in_flight it vanished before reaching the column: it joined a sibling, and takes that
//                   sibling's verdict
// The server reports a dropped stack's position about once a second, so stopped is a position
// unchanged for THROW_REST_MS.
const LOOK_SETTLE_TICKS = 4;      // ticks between the look at the hole and the first toss
const THROW_APPEAR_MS = 700;     // how long after the toss a new stack may still appear
const THROW_POLL_MS = 100;
const THROW_REST_MS = 1600;
const THROW_FOLLOW_MS = 7000;
const THROW_OWN_COLUMN = 0.6;     // blocks, horizontally, from the thrower to a stack's first position
const sleep = ms => new Promise(r => setTimeout(r, ms));

function _inPitAtRest(g, p) {
    const x = Math.floor(p.x), z = Math.floor(p.z);
    return x >= g.box.min.x && x <= g.box.max.x && z >= g.box.min.z && z <= g.box.max.z && p.y < g.rims[0].y + 1;
}

function _watchThrow(bot, name) {
    const rows = new Map();   // entity id → row, in the order first described
    const onDescribed = (e) => {
        if (!e || !e.position || rows.has(e.id)) return;
        const it = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null;
        if (!it || it.name !== name) return;
        const me = bot.entity.position;
        if (Math.hypot(e.position.x - me.x, e.position.z - me.z) > THROW_OWN_COLUMN) return;
        rows.set(e.id, { e, id: e.id, count: it.count, last: e.position.clone(), stillSince: Date.now(), end: null });
    };
    bot.on('itemDrop', onDescribed);

    async function followToRest(g) {
        await sleep(THROW_APPEAR_MS);
        bot.removeListener('itemDrop', onDescribed);
        const all = [...rows.values()];
        const until = Date.now() + THROW_FOLLOW_MS;
        while (Date.now() < until && all.some(r => !r.end)) {
            await sleep(THROW_POLL_MS);
            for (const r of all) {
                if (r.end) continue;
                const p = r.e.position;   // the entity object keeps its last position after it is gone
                if (bot.entities[r.id] !== r.e) { r.end = 'vanished'; r.last = p.clone(); continue; }
                if (p.distanceTo(r.last) >= 0.03) { r.last = p.clone(); r.stillSince = Date.now(); }
                else if (Date.now() - r.stillSince >= THROW_REST_MS) r.end = 'rested';
            }
        }
        for (const r of all) {
            r.end = r.end || 'still_moving';
            r.inPit = r.end === 'rested' ? _inPitAtRest(g, r.last) : r.end === 'vanished' ? holds(r.last) : false;
        }
        // A stack that vanished short of the column joined a sibling of the same toss.
        const landed = all.filter(r => r.end === 'rested' || r.inPit);
        for (const r of all) {
            if (r.end !== 'vanished' || r.inPit || !landed.length) continue;
            r.end = 'merged_in_flight';
            r.inPit = landed.every(o => o.inPit);
            r.mergedInto = landed[0].id;
        }
        return all.map(r => ({ id: r.id, count: r.count, rest: [Math.floor(r.last.x), Math.floor(r.last.y), Math.floor(r.last.z)],
            inPit: r.inPit, end: r.end, mergedInto: r.mergedInto == null ? null : r.mergedInto }));
    }
    return { followToRest };
}

module.exports = { geometry, closedBox, holds, stands, trashIn, discardTrash, chestKeeps, cubeTripUnbuilt, cubeTripBuilt, madeGoodOrdered };
