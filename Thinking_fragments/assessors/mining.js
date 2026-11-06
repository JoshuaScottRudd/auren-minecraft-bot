// assessors/mining — posts the two shafts' setup and dig jobs onto the board. See assessor_registry.

'use strict';

const miningCellGraph = require('@perception/mining_cell_graph');
const miningIntegrity = require('@perception/mining_integrity');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE, DEEP_ORES, DEEP_SEAT_FACTOR,
} = require('@thinking/architect_config');

// The SHAFT's site stamp: job_ranking places it where each crew's STRUCTURE_PRIORITY lists 'shallow_shaft'.
// A tunnel seat carries its asker's site, never this one.
const MINE_STRUCTURE = 'shallow_shaft';
// The deep shaft's stamp. No crew lists it: it ranks as a support by its job (support_structure), and has no site of its
// own, being the rest of the shallow shaft's descent (mining_blueprinter.generateStaircase).
const DEEP_STRUCTURE = 'deep_shaft';

const hq = require('@kernel/corporate_headquarters');
const inventoryLens = require('@kernel/inventory_lens');
const { smeltInputsFor } = require('@kernel/crafting_blueprint_registry');

// The pull entries a cell answers: the stone a cell's walls are cut from, under every name a building's
// order reaches the mine by.
const CELL_STONE = new Set([
    ...require('@utils/fragment_utils').stone_items,
    'structural_fill', 'andesite', 'diorite', 'granite', 'cobbled_deepslate',
]);

// Blocks one new unit of the mine's layout digs out (mining_cell_graph.unitYield: a cell, or a strip segment).
let _cellYield = null;
function cellYield() {
    if (_cellYield === null) _cellYield = miningCellGraph.unitYield();
    return _cellYield;
}

// Cells a body can be sent to now: damaged finished cells plus the unfinished frontier. Seeds the field
// first (selectNextCell), so the count is taken the sweep the shaft completes.
//
// ONE BODY, ONE TUNNEL (mining_manager): a strip segment is worked under its line's claim, so what a body
// can be sent to is a TUNNEL, and the count is tunnels with an open unit — never units. A tunnel a working
// peer holds still counts as a seat, the one that peer sits in. With every tunnel held, the selection lights
// the next floor up, so a body that wants to mine has a tunnel; none is posted only at the top of the staircase.
function openCells(bot, deepY = null) {
    const held = require('@kernel/foreman_link').peerClaimKeys();
    const keyOf = c => (miningCellGraph.isStrip(c) ? miningCellGraph.lineKey(c) : `cell:${c.id}`);
    const heldIds = new Set(Object.values(miningCellGraph.readCells()).filter(c => held.has(keyOf(c))).map(c => c.id));
    if (!miningCellGraph.selectNextCell(bot, heldIds, deepY)) return 0;
    const inSeatBand = miningCellGraph.inBand(deepY);
    const tunnels = new Set(), free = new Set();
    for (const c of Object.values(miningCellGraph.readCells())) {
        if (c.complete || c.blocked || !inSeatBand(c)) continue;
        const key = keyOf(c);
        tunnels.add(key);
        if (!held.has(key)) free.add(key);
    }
    if (tunnels.size === 0) return 1;
    return free.size ? tunnels.size : 0;
}
// ── WHAT THE SURFACE ASKED THE MINE FOR ─────────────────────────────────────────────────────────────
// The request that sized the seats, said whenever the seat count or the asked-for items change: the stone
// short, the seats it opened, the units open to dig, and every item on the pull (accounting_lens MINE_REQUEST).
let _mineRequest = null;
// Each short ore's seats and the blocks dug per ore found that sized them: ore_seats=iron:14@24,...
function oreSeatsSaid(groups) {
    const dug = require('@perception/survey_book').digYield();
    const out = [];
    for (const g of groups) for (const [category, short] of Object.entries(g.oreShort || {})) {
        const per = Math.round((dug.blocks + cellYield() * ORE_YIELD_PRIOR) / ((dug.found[category] || 0) + ORE_YIELD_PRIOR));
        out.push(`${category}:${oreSeats(category, short)}@${per}`);
    }
    return out.join(',') || 'none';
}
function noteMineRequest(pull, stoneShort, seats, open, groups) {
    const asked = Object.entries(pull).filter(([, n]) => n > 0).map(([item, n]) => `${item}:${n}`).join(',') || 'none';
    const by = groups.map(g => `${g.band}/${g.structure || 'no_site'}:${g.seats}`).join(',') || 'none';
    const key = `${seats}|${Object.keys(pull).filter(item => pull[item] > 0).join(',')}|${by}`;
    if (key === _mineRequest) return;
    _mineRequest = key;
    require('@kernel/watcher').summary(require('@thinking/assessors/shared').TAG,
        `MINE_REQUEST stone_short=${stoneShort} seats=${seats} open_units=${open} unit_yield=${cellYield()} asked=${asked} by=${by} ore_seats=${oreSeatsSaid(groups)}`);
}

// ── THE TUNNEL IS PULLED, NEVER RANKED ──────────────────────────────────────────────────────────────
// seatGroups(askers) → [{ job_type, structure, band, stone, ore, seats }], one per asking position, in
// board order. Every underground item on the pull opens seats: stone one per pledge (PLEDGE_BLOCK); anything
// else is an ore the tunnel uncovers a block at a time, so it opens a seat per ore still in the ground
// (a smelted item's need less the ore the fleet holds) and the open tunnel ends are the cap. With nothing asked there are no groups and no tunnel is dug.
// What one body in a mine seat is counted as bringing back, in blocks, when the crew is balanced: a
// pocket stack. A seat states no quantity of its own, so this is the figure peers add for each seat taken.
const MINE_SEAT_YIELD = 64;
const { PLEDGE_BLOCK } = require('@utils/calculators/yield_pledge_calculator');

function seatGroups(askers) {
    const { JOB_CATEGORY_OF, CATEGORY_INDEX } = require('@thinking/architect_config');
    const { isUnderground } = require('@utils/fragment_utils');
    const byPlace = new Map();
    // THE DOWNLOADED BUILDING ASKS BY ITS WHOLE BALANCE: what the mine owes it is each underground material's
    // short across the whole building, counted in every state the fleet holds it in (downloaded_build
    // castleBalance) — so the tunnel is asked once, for all of it, and is done when the ore is out. The
    // seats carry how full the emptiest of those materials is, the level the dispatcher chooses by.
    const castle = require('@thinking/assessors/downloaded_build');
    const balance = castle.castleBalance();
    const site = balance ? castle.buildName() : null;
    if (site) {
        const g = { job_type: JOB_TYPE.site_supply, structure: site, band: JOB_CATEGORY_OF[JOB_TYPE.site_supply], stone: 0, ore: 0, ores: new Set(), oreShort: {}, level: 1 };
        // Every name the bill reaches the cell's stone by is one material here: its holdings are credited to
        // whichever name is counted first, so the names are levelled as one sum. Each ore is its own.
        const stone = { need: 0, have: 0 };
        for (const [root, row] of Object.entries(balance)) {
            if (CELL_STONE.has(root)) { stone.need += row.need; stone.have += row.have; g.stone = Math.max(g.stone, row.short); continue; }
            if (!(row.short > 0) || !isUnderground(root)) continue;
            g.ore = Math.max(g.ore, row.short);
            // Each ore category the group is short of.
            const category = categoryOf(root);
            shortOf(g, category, row.short);
            if (category) g.ores.add(category);
            if (row.have / row.need < g.level) { g.level = row.have / row.need; g.level_need = row.need; g.level_by = 'ore'; }
        }
        if (g.stone > 0 && stone.have / stone.need < g.level) { g.level = stone.have / stone.need; g.level_need = stone.need; g.level_by = 'stone'; }
        g.level_key = `mine:${site}`;
        byPlace.set(`${g.band}|${site}`, g);
    }
    for (const a of askers) {
        if (!a || !(a.need > 0) || !(CELL_STONE.has(a.item) || isUnderground(a.item))) continue;
        // THE BUILDING'S OWN STONE ASK STANDS BESIDE ITS BALANCE. The balance counts stone in every state the
        // fleet holds it in, and smelted stone does not turn back into cobblestone: a trip short of the raw
        // block is short of it whatever the furnaces hold, and only a cell brings it.
        if (site && a.structure === site) {
            if (CELL_STONE.has(a.item)) { const g = byPlace.get(`${JOB_CATEGORY_OF[JOB_TYPE.site_supply]}|${site}`); g.stone = Math.max(g.stone, a.need); }
            continue;
        }
        // One group per board position (band and site): an ingot order and the furnace's ore order for the
        // same building are one need, and take the larger figure, never the sum.
        const place = `${JOB_CATEGORY_OF[a.job_type]}|${a.structure || ''}`;
        if (!byPlace.has(place)) byPlace.set(place, { job_type: a.job_type, structure: a.structure || null, band: JOB_CATEGORY_OF[a.job_type], stone: 0, furnace: 0, ore: 0, ores: new Set(), oreShort: {} });
        const g = byPlace.get(place);
        if (a.item === 'furnace_material') g.furnace = Math.max(g.furnace, a.need);
        if (CELL_STONE.has(a.item)) { g.stone = Math.max(g.stone, a.need); continue; }
        // THE MINE'S PART OF A SMELTED ITEM ENDS AT THE ORE: an ingot short is the tunnel's only for the ore
        // the fleet does not hold yet; the ore above ground is the furnace's to finish.
        const inputs = smeltInputsFor(a.item);
        const ore = inputs ? Math.max(0, a.need - inventoryLens.reachableByFleet(inputs)) : a.need;
        g.ore = Math.max(g.ore, ore);
        if (ore > 0 && categoryOf(a.item)) g.ores.add(categoryOf(a.item));
        if (ore > 0) shortOf(g, categoryOf(a.item), ore);
    }
    return [...byPlace.values()]
        .filter(g => g.stone > 0 || g.ore > 0)
        .map(g => ({ ...g, seats: digSeats(g) }))
        // BOARD ORDER IS BAND, THEN SITE (job_ranking.selectBand): the open cells go to the yard's ask before the
        // castle's, as every other yard job does. By band alone the castle, counted first, took them all.
        .sort((a, b) => (CATEGORY_INDEX[a.band] - CATEGORY_INDEX[b.band])
            || (siteRank(a) - siteRank(b)));
}
const { oreCategoryOf } = require('@perception/survey_book');
// Obsidian is a whole block and no ore name; it is its own category.
const categoryOf = (item) => oreCategoryOf(item) || (DEEP_ORES[item] ? item : null);
// EACH ORE IS SHORT ON ITS OWN: `oreShort` holds every ore category's short (UNCATEGORISED for an underground item
// the survey names no category for), the larger figure where two asks name one ore.
const UNCATEGORISED = '_';
function shortOf(g, category, short) {
    const k = category || UNCATEGORISED;
    g.oreShort[k] = Math.max(g.oreShort[k] || 0, short);
}
// ── AN ORE'S SEATS ARE SIZED BY WHAT THE GROUND TURNS UP ────────────────────────────────────────────────
// A seat digs one unit of tunnel, and a unit holds an ore only as often as the ground does: the fleet's tunnel
// passes say how many blocks they dug per ore block of each category they uncovered (survey_book.digYield), so an
// ore short of n opens the units n of it takes to find. The count starts from ORE_YIELD_PRIOR ore found in one unit,
// the seat a block the mine began with, and every pass moves it toward the ground's own. An ore the survey names no
// category for keeps the seat a block.
const ORE_YIELD_PRIOR = 1;
function oreSeats(category, short) {
    if (category === UNCATEGORISED) return short;
    const dug = require('@perception/survey_book').digYield();
    const blocksPerOre = (dug.blocks + cellYield() * ORE_YIELD_PRIOR) / ((dug.found[category] || 0) + ORE_YIELD_PRIOR);
    return Math.ceil(short * blocksPerOre / cellYield());
}
// A group's shallow seats: its stone's, or the units its most wanted shallow ore takes to find. A deep ore opens none here.
const digSeats = (g) => Math.max(Math.ceil(g.stone / PLEDGE_BLOCK), ...Object.entries(g.oreShort).filter(([category]) => !DEEP_ORES[category]).map(([category, short]) => oreSeats(category, short)));
// ── THE DEEP SHAFT'S GATE ───────────────────────────────────────────────────────────────────────────────
// deepAsks(g) → the deep ores this group is short of whose tool the fleet holds, each { ore, y, seats }. Nothing else opens
// the deep shaft: no ask, no shaft; an ask with no such tool opens no seat anywhere.
const surfaceLavaKnown = () => require('@perception/survey_book').surfaceLava({ x: 0, z: 0 }).length > 0;
function deepAsks(g) {
    // NO DEEPSLATE WITHOUT AN OBSIDIAN ORDER: the diamond for its pickaxe is the one reason to go down.
    const pullNow = require('@kernel/corporate_headquarters').readConfRoomFlag('job_board_room', 'materials_needed_pull', {}) || {};
    if (!(pullNow.obsidian > 0)) return [];
    const held = inventoryLens.fleetHoldings();
    return Object.entries(g.oreShort)
        .filter(([category]) => DEEP_ORES[category] && (held[DEEP_ORES[category].tool] || 0) > 0)
        // OBSIDIAN IS MADE AT A POOL: the tunnels are dug for it only until one has turned from lava.
        .filter(([category]) => category !== 'obsidian' || !(require('@perception/survey_book').openLava().length || surfaceLavaKnown()))
        .map(([category, short]) => ({ ore: category, y: DEEP_ORES[category].y, seats: oreSeats(category, short) * DEEP_SEAT_FACTOR }));
}
// MINE STONE IS WORKED A PLEDGE AT A TIME, AS A GATHER IS (supply_manager._nextTrip). Each whole PLEDGE_BLOCK of stone a body carries is
// its guarantee (magnet.mine_guarantee), already counted in the fleet's holdings; its pledge is that plus one more. A peer's
// outstanding stone is its pledge less its guarantee. stoneOpen(botId, magnet) → { open, why }: whether another pledge is left of the
// order this seat was pulled for. An ore the order is still short of holds the seat open: a tunnel cannot say what it will uncover.
function stoneOpen(botId, magnet) {
    const hq = require('@kernel/corporate_headquarters');
    const askers = hq.readConfRoomFlag('job_board_room', 'materials_needed_pull_askers', []) || [];
    const g = seatGroups(askers).find(x => (x.structure || null) === (magnet.structure || null));
    if (!g) return { open: false, why: 'the order is met' };
    if (g.ore > 0) return { open: true, why: `${g.ore} ore still short` };
    let outstanding = 0;
    for (const [peer, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
        const m = chair && chair.magnet;
        if (peer === botId || !m || m.mine_guarantee == null || !m.pledge) continue;
        outstanding += Math.max(0, m.pledge.amount - m.mine_guarantee);
    }
    const open = g.stone - outstanding;
    return open >= 1 ? { open: true, why: `${open} of ${g.stone} stone unpledged` } : { open: false, why: `${g.stone} stone short is pledged by peers` };
}
// A DEEP TRIP SIGNS OUT AN IRON PICKAXE: the seats open are the crew's pickaxes in the chests and this body's own, so the
// crew's iron sets how many go deep (mining_manager.takeIronPick).
const ironPicksOnHand = (bot) => inventoryLens.inChests('iron_pickaxe') + bot.inventory.items().filter(i => i.name === 'iron_pickaxe').length;
let _noRouteSaid = false;
// One mine seat for the group, with what its dispatcher reads.
const mineSeat = (id, g, extra = {}) => ({
    id, type: 'mine', what: 'dig_cell',
    where: require('@perception/mining_blueprinter').shaftChair().transpose_origin,
    job_type: JOB_TYPE.mining_dig_cell,
    // The seat's place on the board is its asker's (job_ranking.orderSweep reads pulled_by).
    pulled_by: { job_type: g.job_type, structure: g.structure },
    structure: g.structure || undefined,
    // How full the material the seat is dug for is; the dispatcher chooses among equals by it.
    ...(Number.isFinite(g.level) ? { level: g.level } : {}),
    // The shelf that level is read off, and what one seat is counted as bringing to it.
    // A seat is counted as bringing its stone only where stone is the emptiest material: an ore the
    // tunnel finds is unknown until it comes back, so a seat dug for an ore promises none of it, and
    // the ore's level stays where the ore in hand puts it while every open seat is offered.
    ...(g.level_key && g.level_need > 0 ? { level_key: g.level_key, level_need: g.level_need, ...(g.level_by === 'stone' ? { seat_yield: MINE_SEAT_YIELD } : {}) } : {}),
    claimed_by: null, scope: 'shared',
    ...extra,
});
const siteRank = (g) => require('@thinking/job_ranking').measureSiteRank({ structure: g.structure });

// ── SECTION 1 — Mining (evaluates FIRST, Law 18; no deps on other assessments) ──
async function assess({ excluded } = {}) {
    const jobs = [];
    // `built` is the map every structure assessor reports into (job_board's built gate, the built-change announcement); starts false, set only where the scan below runs (Law 23).
    let shaftBuilt = false;

    const site        = require('@perception/mining_blueprinter').shaftChair();   // the headframe's, or a builder's own shallow shaft
    const shaftCenter = site?.transpose_origin || null;

    // Gates on the predicate mining_manager releases on (Law 16): site located, staircase locked; the 10s idle heartbeat re-checks until then.
    if (!site?.transpose_origin || !site?.staircase) return { jobs, built: { [MINE_STRUCTURE]: shaftBuilt } };

    // Standalone shaft's mouth is a site; trees over it fell first via shared.siteTreesJob, region one staircase copy plus the top joint's leaf margin — runs before the light gate since felling needs no torch.
    if (require('@perception/mining_blueprinter').shaftStructure() !== 'headframe' && global.bot?.findBlocks) {
        const { siteTreeBox, siteTreePhaseDone, siteTreesJob } = require('@thinking/assessors/shared');
        const box = siteTreeBox('architect_staircase_final', site.transpose_origin);
        // Held on the PHASE, not the scan: an all-claimed mouth is still being felled (shared.siteTreesJob).
        if (!siteTreePhaseDone(MINE_STRUCTURE)) {
            const treesSeats = await siteTreesJob(MINE_STRUCTURE, site.transpose_origin, box);
            jobs.push(...treesSeats);   // an ARRAY of seats now — one per standing trunk, capped at the roster
            if (!siteTreePhaseDone(MINE_STRUCTURE)) return { jobs, built: { [MINE_STRUCTURE]: shaftBuilt } };
        }
    }

    // The light gate is the board's (job_gates.toolGate, mining_manager.mineLightReady): a crew that lights its
    // ground digs the mine lit, its digger placing the torches as it digs (mining_integrity.scanSegment), so its
    // mine jobs wait for the trip's torches. Mining posts either way.

    // Site is guaranteed present past the gate above, so scan integrity directly (no re-guard).
    let shaftComplete = false;
    let maintenanceNeeded = false;
    let deepComplete = false;
    let deepJob = false;
    const bot = global.bot;

    const pull = hq.readConfRoomFlag('job_board_room', 'materials_needed_pull', {}) || {};
    const askers = hq.readConfRoomFlag('job_board_room', 'materials_needed_pull_askers', []) || [];
    const groups = bot ? seatGroups(askers) : [];
    // THE GATE OPENS BEFORE THE SCAN READS IT. A site with no route says so once: the ask waits, and the fleet goes on.
    const deepAsked = groups.some(g => deepAsks(g).length > 0);
    const deepOpen = deepAsked && !!site.staircase.deep;
    if (deepAsked && !deepOpen && !_noRouteSaid) {
        _noRouteSaid = true;
        require('@kernel/watcher').warn(require('@thinking/assessors/shared').TAG, `a deep material is asked for and this site has no route for the deep shaft (${site.transpose_origin.x},${site.transpose_origin.z}); that material will not be mined.`);
    }
    miningIntegrity.setDeepOpen(deepOpen);
    if (deepOpen) require('@utils/movement/terrain_predicates').openDepthFloor();
    // No guard around an integrity scan, here or below: these nodes absorb their own failures, so an
    // escaping throw is a defect (Law 13, Law 25).
    if (bot && bot.blockAt) {
        const integrity = miningIntegrity.scan(bot, excluded);
        // shaft_excavated (not damage-gated) drives the cell-mining switch — cobble flows during repairs; maintenance_needed is a finished segment damaged (permanent, like building_integrity).
        shaftComplete = !!integrity.shaft_excavated;
        maintenanceNeeded = !!integrity.maintenance_needed;
        // Same two facts as the phase switch above (excavated, no damage outstanding), so built and moved-to-cells verdicts can never disagree (Law 16).
        shaftBuilt = shaftComplete && !maintenanceNeeded;
        deepComplete = !!integrity.deep_excavated;
        // The first piece owed is the deep shaft's: the shallow shaft stands whole, and the job is the support structure.
        deepJob = deepOpen && shaftComplete && (integrity.first_incomplete ? integrity.first_incomplete.part === 'deep' : !deepComplete);
        if (deepJob || (integrity.first_incomplete && integrity.first_incomplete.part === 'deep')) shaftBuilt = shaftComplete;
    }

    // One way to mine, two sequential phases: `shaftComplete` picks the phase at posting, no downstream
    // arbiter (Law 16). ONE BODY OWNS THE SHAFT: one shared job, and the body that claims it works the staircase
    // segment by segment, top down, each whole segment — lane, both walls, ceiling — until it settles.
    // THE DEEP SHAFT IS THE SAME JOB WITH ONE SEAT, a support structure: it ranks ahead of the crew's build.
    if (deepJob && ironPicksOnHand(bot) > 0) {
        jobs.push({
            id: 'mine_dig_deep_shaft', type: 'mine', what: 'dig_shaft',
            where: shaftCenter,
            job_type: JOB_TYPE.mining_dig_shaft, structure: DEEP_STRUCTURE, support_structure: true,
            claimed_by: null, scope: 'shared',
        });
    } else if (!deepJob && (!shaftComplete || maintenanceNeeded)) {
        jobs.push({
            id: 'mine_dig_shaft', type: 'mine', what: 'dig_shaft',
            where: shaftCenter,
            job_type: JOB_TYPE.mining_dig_shaft, structure: MINE_STRUCTURE,
            claimed_by: null, scope: 'shared',
        });
    }

    // ── CELLS ARE DUG FOR A BUILDING'S STONE, ONE SEAT PER CELL THE NEED WILL EMPTY ──────────────────
    // The shaft is required mining; a cell is as-needed mining. The need is the stone the surface is
    // waiting on — the mining pull the gates wrote last sweep — and it sizes the seats: one per cell that
    // stone takes to dig, capped by the cells open to dig, so the crew on the stone grows as the cell
    // field does and stops when the stone is in. Each seat is its own `shared` job (one owner per seat); the `cell:<id>` claim still gives each cell one owner (Law 4).
    // ── ORE IS THE STRIP MINE'S ─────────────────────────────────────────────────────────────────────
    // Every ore short is dug from the strip mine's cells; nothing is sent into caves for it.
    // STONE IN ORDER: the strip mine once the shaft is finished; until then the shaft, and a furnace's stone from
    // stone open to the sky for bodies the shaft does not hold, or while the mine waits for torches
    // (assessors/survey.stoneJobs).
    const mineLit = !bot || !bot.inventory || require('@action/mining_manager.js').mineLightReady(bot).ok;
    if (!shaftComplete || !mineLit) jobs.push(...require('@thinking/assessors/survey').stoneJobs(bot, groups));
    if (bot) jobs.push(...require('@thinking/assessors/survey').toolStoneJobs(bot));
    if (shaftComplete && bot && bot.blockAt) {
        const wanted = groups.reduce((n, g) => n + digSeats(g), 0);
        const open = wanted > 0 ? openCells(bot) : 0;
        let k = 0;
        for (const g of groups) {
            for (let s = 0; s < digSeats(g) && k < open; s++, k++) {
                jobs.push(mineSeat(`mine_dig_cell_${k}`, g));
            }
        }
        // DEEP SEATS OPEN WITH THE BRANCHES: once the deep shaft stands, each ask's seats on its own ore's floors,
        // to as many tunnels as stand open there.
        if (deepOpen && deepComplete) {
            groups.forEach((g, gi) => {
                for (const ask of deepAsks(g)) {
                    const open = Math.min(openCells(bot, ask.y), ironPicksOnHand(bot));
                    for (let s = 0; s < ask.seats && s < open; s++) jobs.push(mineSeat(`mine_dig_deep_${gi}_${ask.ore}_${s}`, g, { deep_y: ask.y }));
                }
            });
        }
        noteMineRequest(pull, Math.max(0, ...groups.map(g => g.stone)), k, open, groups);
    }
    // ── OBSIDIAN IS POURED, ONE BODY AT ONE POOL ────────────────────────────────────────────────────────
    // Asked for, a pool logged, and this body carrying the diamond pickaxe that takes what the pour makes.
    const obsidianShort = Math.max(0, ...groups.map(g => g.oreShort.obsidian || 0));
    const surfaceObsidian = obsidianShort > 0 && !!bot && !!bot.entity && surfaceLavaKnown()
        && bot.inventory.items().some(i => i.name === DEEP_ORES.obsidian.tool)
        && (bot.inventory.items().some(i => i.name === 'bucket' || i.name === 'lava_bucket') || inventoryLens.inChests('bucket') > 0);
    // The surface comes first: this body carrying the diamond pickaxe, a bucket to hand, a sector with lava in the book.
    if (surfaceObsidian) {
        jobs.push({
            id: 'survey_lava_obsidian', type: 'survey', what: 'lava_obsidian', want: obsidianShort,
            where: shaftCenter, job_type: JOB_TYPE.survey_lava,
            claimed_by: null, scope: 'shared',
        });
    }
    if (!surfaceObsidian && deepComplete && bot && bot.entity && groups.some(g => g.oreShort.obsidian > 0)
        && bot.inventory.items().some(i => i.name === DEEP_ORES.obsidian.tool)
        // A bucket this body can lay hands on: one signed out to a peer is no pour.
        && (bot.inventory.items().some(i => i.name === 'bucket' || i.name === 'water_bucket') || inventoryLens.inChests('bucket') + inventoryLens.inChests('water_bucket') > 0)
        && require('@perception/survey_book').openLava(bot.entity.position).length) {
        jobs.push({
            id: 'mine_pour_obsidian', type: 'mine', what: 'pour_obsidian',
            where: shaftCenter,
            job_type: JOB_TYPE.mining_obsidian,
            claimed_by: null, scope: 'shared',
        });
    }
    // No `mine_<item>` job: the need steers mining via job_board_room.materials_needed_pull, which
    // mining_executor reads for deficiencyMet and the surface-early test; never read back here (Law 16).

    return { jobs, built: { [MINE_STRUCTURE]: shaftBuilt } };
}

module.exports = { name: 'mining', assess, MINE_STRUCTURE, DEEP_STRUCTURE, stoneOpen, CELL_STONE };
