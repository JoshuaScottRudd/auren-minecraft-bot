// fragment: waste_pit
// purpose: the one route for a pocket's trash (Law 16). The pit is a building (architect_config.WASTE_PIT,
//          the `waste_pit` blueprint): the foreman sites it beside the yard and the crew builds it on the
//          building ladder. It takes what no chest should hold — the wooden pickaxes a stone set replaced,
//          gravel, flint and the stone variants nothing builds with — and the world despawns it five minutes
//          later. The pit is a trench two blocks long; a body stands on the pad cell at one end of it and
//          throws along it. Until the pit stands, trash is banked. The trench is a closed box to the route planner (navigator.loadClosedBoxes), so no
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
    // A hole column is one whose pad-level cell is air; the trench is those columns, end to end in a line.
    const col = v => `${v[0]},${v[2]}`;
    const holeCols = new Set(voxels.filter(v => v[1] === 0 && v[3] === 'air').map(col));
    const holes = voxels.filter(v => v[1] <= 0 && holeCols.has(col(v))).map(at).sort((a, b) => b.y - a.y);
    const pad = voxels.filter(v => v[1] === 0 && !holeCols.has(col(v))).map(at);
    const open = voxels.filter(v => v[1] > 0 && !holeCols.has(col(v))).map(at);
    const span = k => ({ min: Math.min(...holes.map(c => c[k])), max: Math.max(...holes.map(c => c[k])) });
    const sx = span('x'), sy = span('y'), sz = span('z');
    // The two pad cells in line with the trench, one past each end of it.
    const along = sx.max - sx.min >= sz.max - sz.min ? 'x' : 'z';
    const endCell = far => pad.find(c => (along === 'x' ? c.z === sz.min && c.x === (far ? sx.max + 1 : sx.min - 1)
        : c.x === sx.min && c.z === (far ? sz.max + 1 : sz.min - 1)));
    const ends = [endCell(false), endCell(true)];
    if (ends.some(e => !e)) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): the ${WASTE_PIT.structure} blueprint has no pad cell at each end of its trench — a thrower stands in line with the trench.`);
    }
    const blockCentre = c => new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5);
    return {
        holes,                                              // every cell of the pit, top-down
        pad,                                                // the floor blocks round the trench
        open,                                               // the air the pad keeps over it
        // The two blocks a thrower stands ON, each with its aim: the middle of the block under the far stand,
        // which is the trench's far wall at pad level.
        rims: [{ stand: ends[0], aim: blockCentre(ends[1]) }, { stand: ends[1], aim: blockCentre(ends[0]) }],
        padTop: o.y + 1,
        box: { min: { x: sx.min, y: sy.min, z: sz.min }, max: { x: sx.max, y: sy.max, z: sz.max } },
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

// chestKeeps — WHAT A CHEST HOLDS: everything but what is made to order (architect_config.madeToOrder: a
// tool or a torch, made for the body that needs it). A crafted good left over — a pane craft makes sixteen,
// a stair craft four — is banked, and the next trip takes it finished before it crafts from raw
// (column_preparation STEP 1). A crafted good never goes to the pit; one found there is a fault the pit's
// whitelist reports.
function chestKeeps(item) {
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('waste_disposal')) return true;
    return !require('@thinking/architect_config').madeToOrder(item);
}

// ── A MADE-TO-ORDER THING IS KEPT UP TO WHAT THE BUILDING STILL ASKS FOR ────────────────────────────────
// A torch the building places is banked for the trip that places it; past that order it is pitted.

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

// How many more of a made good this body may bank: what the building still asks for past what the chests hold.
function _madeGoodRoom(item) {
    return Math.max(0, madeGoodOrdered(item) - _madeInChests(item));
}

// What in this pocket is trash, as {item: count}. A listed item is trash past what its pocket row keeps
// and what the held order still wants (inventory_swapper.computeExcess); a wooden pickaxe is trash once
// the body holds the pickaxe row's stone set, so it goes in the moment the stone ones are taken.
function trashIn(bot) {
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('waste_disposal')) return {};
    const { WASTE_PIT } = require('@thinking/architect_config');
    const STOCK_THRESHOLDS = require('@thinking/requested_work').activeStockRows();
    const tossedSaplings = require('@api/sapling_planter').tossedSaplings();
    const inv = {};
    for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
    const swapper = require('@api/inventory_swapper');
    const excess = swapper.computeExcess(inv, require('@thinking/job_board.js').INVENTORY_WHITELIST, swapper.heldOrderDemand());
    const trash = {};
    // A crew that replants keeps its primary sapling (sapling_planter.pocketRow); every other sapling, and
    // the primary past that keep, is trash.
    for (const item of [...WASTE_PIT.items, ...tossedSaplings]) {
        if (item === 'wooden_pickaxe') continue;
        if (excess[item] > 0) trash[item] = excess[item];
    }
    // WHAT A CHEST DOES NOT KEEP IS TRASH past what the pocket's own row keeps, less what the building still
    // asks for (_madeGoodRoom).
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

// ── WHAT THE PIT AUTHORIZES: A STRICT WHITELIST ────────────────────────────────────────────────────────
// The pit's own list (WASTE_PIT.items), the saplings a replanting crew does not keep, dirt, and the wooden
// tool each stone-tiered tool row replaces. Every body that throws reads the pit afterwards and names any
// other item lying there by its entity id: a crafted good is banked, never thrown, so one found there is a fault.
function pitAuthorized(item) {
    const { WASTE_PIT } = require('@thinking/architect_config');
    if (WASTE_PIT.items.includes(item)) return true;
    if (require('@api/sapling_planter').tossedSaplings().includes(item)) return true;
    if (item === require('@utils/trash').STAND_IN) return true;
    return require('@thinking/requested_work').activeStockRows().some(r => r.holder === 'bot' && r.kind === 'tool'
        && Array.isArray(r.tiers) && r.tiers.includes('wooden') && r.tiers.includes('stone') && item === `wooden_${r.item}`);
}

// EACH UNAUTHORIZED ITEM IS REPORTED ONCE, BY THE FIRST BODY TO FIND IT: the foreman spends one
// 'pit_report:' key per item entity, so a peer that finds the same item is refused and stays quiet. A body
// with no foreman is the whole fleet, and the items it has itself reported are the count.
const _reportedHere = new Set();
async function _firstToReport(entityId, item) {
    const key = `pit_report:${entityId}:${item}`;
    if (_reportedHere.has(key)) return false;
    _reportedHere.add(key);
    const link = require('@kernel/foreman_link');
    const grant = await link.requestClaim(key);
    if (!grant.granted) return false;
    link.releaseClaim(key);   // out of this body's chair; the foreman keeps it spent
    return true;
}

// Reads every item lying in the pit from the rim and reports, once for the crew, each one the pit does not
// authorize, by its entity id. Returns how many this body reported.
async function _inspectPit(bot) {
    const found = Object.values(bot.entities || {})
        .map(e => ({ e, it: typeof e?.getDroppedItem === 'function' ? e.getDroppedItem() : null }))
        .filter(({ e, it }) => it && e.position && holds(e.position) && !pitAuthorized(it.name));
    const reported = [];
    for (const { e, it } of found) {
        if (await _firstToReport(e.id, it.name)) reported.push(`${it.name}x${it.count} (entity ${e.id})`);
    }
    if (reported.length) {
        watcher.warn(TAG, `WASTE PIT UNAUTHORIZED ITEM — ${reported.join(', ')} lie in the pit, which does not authorize them; reported once for the crew.`);
    }
    return reported.length;
}

// What of the pit does not stand yet, read off the world, or null when it is whole: the trench open to its
// floor, the pad's blocks in place, the air over the pad clear. A cell this body cannot see is not
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
    for (const end of g.rims.slice().sort((a, b) => a.stand.distanceTo(here) - b.stand.distanceTo(here))) {
        const r = end.stand;
        nav = await goToStand(r, { purpose: 'waste_pit' });
        if (nav && nav.arrived && !onRim(r)) nav = await goToStand(r, { purpose: 'waste_pit' });
        if (nav && nav.arrived && onRim(r)) { rim = end; break; }
    }
    if (!rim) {
        const f = bot.entity.position.floored();
        watcher.warn(TAG, `WASTE PIT not reached — neither end of the trench (${g.box.min.x},${g.box.min.z})…(${g.box.max.x},${g.box.max.z}) was stood on (${nav?.arrived ? `the walk ended at (${f.x},${f.y},${f.z})` : nav?.reason || 'unreachable'}); the trash is banked instead.`);
        return { tossed: 0, items: [], reason: 'rim unreachable' };
    }
    const unbuilt = _notBuilt(bot, g);
    if (unbuilt) {
        watcher.summary(TAG, `WASTE PIT not built yet — ${unbuilt}; the trash is banked instead.`);
        return { tossed: 0, items: [], reason: 'pit not built' };
    }

    const book = require('@kernel/item_book');
    const held = name => bot.inventory.items().reduce((s, it) => s + (it.name === name ? it.count : 0), 0);
    const items = [];
    let missed = 0;
    // EVERYTHING IS THROWN, THEN THE THROWS ARE WATCHED TOGETHER: the head is put on the trench once, each kind
    // leaves the pocket with its own watch already listening, and the watches run to rest side by side.
    const wanted = Object.entries(trash).filter(([name]) => bot.registry.itemsByName[name]?.id != null);
    if (!wanted.length) return { tossed: 0, items: [] };
    if (!await _pointAtPit(bot, rim.aim)) {
        watcher.warn(TAG, `WASTE PIT throw withheld — the head is not on the trench's far wall after ${LOOK_TRIES} look(s); ${wanted.map(([name, count]) => `${name}x${count}`).join(', ')} stays in the pocket.`);
        return { tossed: 0, items: [], reason: 'head not on the trench' };
    }
    await book.open();
    const thrown = [];
    for (const [name, count] of wanted) {
        const before = held(name);
        const watch = _watchThrow(bot, name);
        await guardExternal(TAG, `toss ${count} ${name}`, () => bot.toss(bot.registry.itemsByName[name].id, null, count));
        thrown.push({ name, before, following: watch.followToRest(g) });
    }
    const rested = await Promise.all(thrown.map(t => t.following));
    await book.close('toss', 'pit');
    for (const [i, { name, before }] of thrown.entries()) {
        const stacks = rested[i];
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
    // Made-to-order things are named apart: the only made things the pit takes.
    const made = items.filter(i => !chestKeeps(i.item));
    watcher.summary(TAG, `WASTE PIT tossed ${n} item(s): ${items.map(i => `${i.item}x${i.tossed}`).join(', ') || 'none'}. `
        + `Made goods among them: ${made.map(i => `${i.item}x${i.tossed}`).join(', ') || 'none'}. In the pit ${n - missed}, outside it ${missed}.`);
    await _inspectPit(bot);
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
const LOOK_SETTLE_TICKS = 4;      // ticks between the look at the hole and the toss
const LOOK_TRIES = 3;
const LOOK_TOLERANCE = 0.06;      // radians the head may sit off the aim, yaw or pitch
// THE AIM IS A BLOCK, NOT AN ANGLE: the middle of the block under the far end's stand, three blocks along
// the trench and below the pad's top. A stack leaves the head at 0.3 blocks a tick along the look with 0.1
// a tick of lift added and falls short of where the head points, so it comes down into the two open
// cells between the thrower and that block.
const THROW_APPEAR_MS = 700;     // how long after the toss a new stack may still appear
const THROW_POLL_MS = 100;
const THROW_REST_MS = 1600;
const THROW_FOLLOW_MS = 7000;
const THROW_OWN_COLUMN = 0.6;     // blocks, horizontally, from the thrower to a stack's first position
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Points the head at the trench's far wall and reads it back. A forced look goes to the server on the next
// physics tick and the toss flies where the server has the head pointing, so the ticks are waited out and
// the head's own yaw and pitch are compared with the aim before anything leaves the pocket.
async function _pointAtPit(bot, aim) {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    const dx = aim.x - eye.x, dz = aim.z - eye.z;
    const reach = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(aim.y - eye.y, reach);
    const off = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    for (let i = 0; i < LOOK_TRIES; i++) {
        await guardExternal(TAG, 'lookAt the pit', async () => { await bot.lookAt(aim, true); await bot.waitForTicks(LOOK_SETTLE_TICKS); });
        if (off(bot.entity.yaw, wantYaw) <= LOOK_TOLERANCE && off(bot.entity.pitch, wantPitch) <= LOOK_TOLERANCE) return true;
    }
    return false;
}

function _inPitAtRest(g, p) {
    const x = Math.floor(p.x), z = Math.floor(p.z);
    return x >= g.box.min.x && x <= g.box.max.x && z >= g.box.min.z && z <= g.box.max.z && p.y < g.padTop;
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

module.exports = { geometry, closedBox, holds, stands, trashIn, discardTrash, chestKeeps, madeGoodOrdered, pitAuthorized };
