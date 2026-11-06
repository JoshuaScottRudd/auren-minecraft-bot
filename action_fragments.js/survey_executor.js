// fragment: survey_executor — does a survey job: scans a sector from its centre, or fetches stone.
//
// ── THE JOBS (job.what) ─────────────────────────────────────────────────────────────────────────
//   sector     walk out to the sector's centre, stand as near it as there is dry ground inside the square, and
//              scan from there (sector_finder.scanOne). A body that cannot stand anywhere in the square
//              writes the sector's page with no stand, so the frontier opens past it and nobody is sent again.
//   sector_tour  one seat scans the sectors round home one after another without coming home (sector_finder.tour).
//   surface_stone  stone open to the sky (not under water) for tools and stations while the shaft is dug: the
//              body's own look, then the fleet's one escalation (sector_finder: a book sector holding stone, then a
//              frontier sector's scan).
//   stone_pierce  the alpha structure's stone while the mine is shut: one column under the base dug straight down to a
//              run of stone and sealed behind the body (custom_api/stone_pierce). A trip that cannot go down (no sealing
//              stock, no column) takes the stone open to the sky instead.
//
// The walk out is sector_finder.walkToward's.
//
// Every job ends by dropping the pocket off and handing back to the judge, as salvage does.

'use strict';

const watcher = require('@kernel/watcher');
const { routeToJudge } = require('@utils/signal_utils');
const sectorScan = require('@perception/sector_scan');
const finder = require('@api/sector_finder');

const TAG = 'survey_executor';

// mineTargets(bot, targets, match, want, held): dig the blocks the look listed, nearest first, while each still
// matches, until the pocket holds `want` more than it did (`held()` counts what the trip brings back: a drop left
// lying is not brought back). Never the block under the body's feet, never one the fleet built or a closed box holds.
//
// A VEIN IS CHASED BLOCK BY BLOCK: every matching block a dig uncovers is next, wherever it lies. Each dig is followed
// by a collect, then the next dig. A block out of reach is walked to: the body stands on dry ground beside it, or on
// the nearest cell from which it is in reach, and a block with no such cell, or one the walk does not reach, is passed.
//
// Each block is claimed before it is dug with a resource claim (`dig:x,y,z`, the 5x5x5 cube around it,
// @utils/resource_footprint), held while the body digs inside it and released when it moves on: one body to a patch.
async function mineTargets(bot, targets, match, want, held) {
    const Vec3 = require('vec3');
    const { performDig, bobbing } = require('@utils/movement/dig_authority');
    const { collectNearby } = require('@api/drop_collector.js');
    const { isFluid, isGravityBlock } = require('@utils/gravity_utils');
    const { BLOCK_REACH } = require('@utils/fragment_utils');
    const { reachFromStand, standInReachOf } = require('@api/anchored_repair');
    const { keepsDigging } = require('@action/mining_manager.js');
    const locomotion = require('@locomotion/locomotion_dispatcher');
    const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const { surfaceAt } = require('@perception/ground_line');
    const navigator = require('@locomotion/navigator');
    const owned = navigator.loadProtectedBlocks(bot) || new Set();
    const boxes = navigator.loadClosedBoxes(null);
    const boxed = (p) => boxes.some(b => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z);
    // Stone within the gather keep-out of the base is never taken, vein-chased or not (architect_config.GATHER_KEEPOUT).
    const banned = require('@utils/fragment_utils').gatherBanned();
    let dug = 0, passed = 0;
    const passedBy = {};
    const pass = (reason) => { passed++; passedBy[reason] = (passedBy[reason] || 0) + 1; };
    const why = (p) => {
        const b = bot.blockAt(p);
        if (!b || !match(b.name)) return 'gone';
        if (owned.has(`${p.x},${p.y},${p.z}`) || boxed(p)) return 'built';
        if (banned(p)) return 'base';
        const feet = bot.entity.position.floored();
        if (p.x === feet.x && p.z === feet.z && p.y < feet.y) return 'underfoot';
        if (SIX.some(([dx, dy, dz]) => { const n = bot.blockAt(p.offset(dx, dy, dz)); return !!n && isFluid(n.name); })) return 'fluid';
        const up = bot.blockAt(p.offset(0, 1, 0));
        if (up && isGravityBlock(up.name)) return 'gravity';
        if (!bot.inventory.items().some(i => b.canHarvest(i.type))) return 'tool';
        return null;
    };
    const queue = targets.map(t => ({ block: new Vec3(t.block.x, t.block.y, t.block.z), sky: !!t.sky }));
    // Dry ground beside a sky-open block, from which it is in reach. Never inside a closed box (no route enters
    // one), and never a stand a walk this trip already failed to reach: neighbouring blocks share stands, and a
    // second walk to the same unreachable cell is the identical goal the portable judge kills as a stall.
    const unreached = new Set();
    const besideStand = (p) => {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const s = surfaceAt(bot, p.x + dx, p.z + dz);
            if (!s || s.wet) continue;
            const stand = { x: p.x + dx, y: s.y, z: p.z + dz };
            if (boxed(stand) || unreached.has(`${stand.x},${stand.y},${stand.z}`)) continue;
            if (reachFromStand(bot, new Vec3(stand.x, stand.y, stand.z), p) <= BLOCK_REACH) return stand;
        }
        return null;
    };
    const start = held();
    const taken = () => held() - start;
    const { claimFirst, releaseTarget } = require('@utils/target_claims');
    const { boxOfKey, contains } = require('@utils/resource_footprint');
    let ground = null;   // { keys, box } — the patch this trip holds now
    // claim(p) → a release once the block is dug or passed, or null when a peer holds its patch.
    const claim = async (p) => {
        if (!(ground && contains(ground.box, p))) {
            if (ground) { releaseTarget(ground.keys); ground = null; }
            const walk = await claimFirst([p], { keyOf: c => `dig:${c.x},${c.y},${c.z}` });
            if (!walk.pick) return null;
            ground = { keys: walk.keys, box: boxOfKey(walk.key) };
        }
        return () => {};
    };
    // Why the loop ended, said in the trip's line: its want met, its targets worked through, the trip's bound
    // (keepsDigging: the last pickaxe, or carrying the first order's smelt), or a full pocket.
    let ended = null;
    while (queue.length && taken() < want) {
        const bound = keepsDigging(bot);
        if (!bound.ok) { ended = bound.reason; break; }
        // The dusk stop: between one block and the next, a claim the board would now hold ends the trip with what it has.
        const dusk = require('@thinking/job_gates').duskStopClaimed();
        if (dusk) {
            const why = typeof dusk === 'string' ? dusk : `${dusk.why}: ${dusk.detail}`;
            watcher.summary(TAG, `DUSK_STOP job=survey/stone why=${why} after=${dug} block(s) — no further block; home`);
            ended = `dusk stop (${why})`;
            break;
        }
        if (bot.inventory.emptySlotCount() === 0) { ended = 'pocket full'; break; }
        const t = queue.shift();
        const no = why(t.block);
        if (no) { pass(no); continue; }
        const release = await claim(t.block);
        if (!release) { pass('claimed'); continue; }
        const feet = bot.entity.position.floored();
        let stand = t.sky ? besideStand(t.block) : null;
        // A BODY AFLOAT DIGS NOTHING (dig_authority.bobbing): a target in reach of the water is still walked to from
        // dry ground, as tree_feller and ground_shave walk theirs.
        const afloat = bobbing(bot);
        if (!stand && (afloat || reachFromStand(bot, feet, t.block) > BLOCK_REACH)) stand = standInReachOf(bot, t.block);
        if (!stand && afloat) { release(); pass('afloat'); continue; }
        if (!stand && reachFromStand(bot, feet, t.block) > BLOCK_REACH) { release(); pass('no_stand'); continue; }
        if (stand && (boxed(stand) || unreached.has(`${stand.x},${stand.y},${stand.z}`))) { release(); pass('not_reached'); continue; }
        if (stand && !(feet.x === stand.x && feet.y === stand.y && feet.z === stand.z)) {
            const went = await locomotion.goTo({ ...stand, exact: true, leg: 'work', purpose: 'survey' });
            if (!went.arrived) { unreached.add(`${stand.x},${stand.y},${stand.z}`); release(); pass('not_reached'); continue; }
        }
        if (bobbing(bot)) { release(); pass('afloat'); continue; }
        if (reachFromStand(bot, bot.entity.position.floored(), t.block) > BLOCK_REACH) { release(); pass('reach'); continue; }
        if (!(await performDig(bot, t.block, bot.blockAt(t.block), TAG))) { release(); pass('dig_refused'); continue; }
        release();
        dug++;
        // What the dig uncovered is seen now: every match beside it is next, wherever it lies.
        for (const [dx, dy, dz] of SIX) {
            const n = t.block.offset(dx, dy, dz);
            if (!why(n)) queue.unshift({ block: n });
        }
        await collectNearby(bot);
    }
    await collectNearby(bot);
    if (ground) releaseTarget(ground.keys);
    const why_passed = Object.entries(passedBy).map(([k, n]) => `${k}=${n}`).join(' ') || 'none';
    if (!ended) ended = taken() >= want ? 'want met' : 'targets worked through';
    return { dug, passed, why_passed, taken: taken(), left: queue.length, ended };
}
const pocketCount = (bot, isItem) => () => bot.inventory.items().filter(i => isItem(i.name)).reduce((n, i) => n + i.count, 0);

// ── STONE OPEN TO THE SKY ────────────────────────────────────────────────────────────────────────────
// A pledge of stone is sought by the fleet's one escalation (sector_finder): the body's own look (LOCAL_STONE_RADIUS
// around it), then each book sector holding stone, looked at from its stand, until the pledge is whole. A look that
// takes none asks the finder again, which counts the miss and moves on. With no page left the finder scans the next
// frontier sector and the trip ends there, so the next trip has somewhere new to go.
const LOCAL_STONE_RADIUS = 48;
const STONE_TARGETS = 96;
const isStone = (name) => name === 'stone';
const BOOK_LOOKS = 4;   // book sectors one stone trip looks at before it ends
async function surfaceStone(bot, job) {
    const Vec3 = require('vec3');
    const here = bot.entity.position.clone();
    const sky = (list) => list.map(p => ({ block: new Vec3(p.x, p.y, p.z), sky: true }));
    const held = pocketCount(bot, name => name === 'cobblestone');
    const start = held();
    const taken = () => held() - start;
    const worked = [];
    const categories = finder.categoriesFor({ blocks: ['stone'] });
    const tally = () => `${taken()} cobblestone of a ${job.want} pledge taken${taken() < job.want ? ' (short)' : ''} — ${worked.join('; ') || 'none open to the sky around it'}`;
    let from = 'around it';
    let targets = sky(await sectorScan.exposedAround(bot, here, LOCAL_STONE_RADIUS, 'stone', STONE_TARGETS));
    for (let looks = 0; looks <= BOOK_LOOKS; looks++) {
        if (targets.length) {
            const r = await mineTargets(bot, targets, isStone, job.want - taken(), held);
            worked.push(`${from}: ${r.taken} taken, dug ${r.dug}, passed ${r.passed} (${r.why_passed})`);
            if (taken() >= job.want || r.taken > 0) break;
        }
        const step = await finder.escalate(bot, { item: 'cobblestone', categories });
        if (step.none) return { readable: `stone: ${tally()}; nowhere left to look (${step.reason})`, produced: taken() > 0 };
        from = `sector ${step.sector}`;
        targets = sky(await sectorScan.exposedAround(bot, bot.entity.position, LOCAL_STONE_RADIUS, 'stone', STONE_TARGETS));
    }
    return { readable: `stone: ${tally()}`, produced: taken() > 0 };
}

module.exports = {

    receive: watcher.track(TAG, async (signalType, payload = {}) => {
        if (signalType !== TAG) return;
        const bot = global.bot;
        if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before a survey job ran.`);
        const job = payload.job || {};
        const home = require('@thinking/assessors/survey').home();
        if (!home) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): survey job ${job.id} ran with no home sited; the board posts none before.`);

        // Every trip says what it produced (accounting_lens): a look writes a page whatever it found; a trip for
        // material produced when its pocket came back with some.
        const finish = async ({ readable, produced }) => {
            watcher.summary(TAG, readable);
            watcher.summary(TAG, `JOB_RESULT produced=${produced}`);
            const capsule = payload[TAG] || (payload[TAG] = {});
            capsule.readable = readable;
            const drop = await require('@api/inventory_swapper').dropOffHaul(bot);
            if (drop?.abandoned) return;
            return routeToJudge(TAG, { ...payload, readable });
        };

        if (job.what === 'sector') {
            // The same sector claim an empty-handed stone trip takes before it scans (surfaceStone), so the two never
            // scan one sector together.
            const { claimFirst, releaseTarget } = require('@utils/target_claims');
            const walk = await claimFirst([job.sector], { keyOf: s => `sector:${s}` });
            if (!walk.pick) return finish({ readable: `sector ${job.sector} is already being scanned by a peer`, produced: false });
            const scanned = await finder.scanOne(bot, job.sector);
            releaseTarget(walk.keys);
            return finish({ readable: scanned, produced: true });
        }
        if (job.what === 'sector_tour') {
            const r = await finder.tour(bot, job.rings);
            return finish({ readable: `sector tour: ${r.scanned} sector(s) scanned; ${r.ended}`, produced: r.scanned > 0 });
        }
        if (job.what === 'portal_cast') return finish(await require('@action/lava_scoop').portalTrip(bot));
        if (job.what === 'lava_obsidian') return finish(await require('@action/lava_scoop').obsidianTrip(bot, job.want));
        if (job.what === 'surface_stone') return finish(await surfaceStone(bot, job));
        if (job.what === 'stone_pierce') {
            const capsule = payload[TAG] || (payload[TAG] = {});
            const r = await require('@api/stone_pierce').pierce(bot, job.want, capsule.spent_columns || []);
            if (r.abandoned) return;   // the bank's transfer already routed to the judge (Law 15)
            capsule.spent_columns = r.spent;
            if (!r.refused) return finish({ readable: r.readable, produced: r.gained > 0 });
            const sky = await surfaceStone(bot, job);
            return finish({ readable: `pierce refused (${r.refused}); ${sky.readable}`, produced: sky.produced });
        }
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): survey job ${job.id} names what='${job.what}'; the survey does sector, sector_tour, surface_stone and stone_pierce.`);
    }),
};
