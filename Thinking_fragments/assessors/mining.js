// assessors/mining — posts the mineshaft's setup and dig jobs onto the board. See assessor_registry.

'use strict';

const miningCellGraph = require('@perception/mining_cell_graph');
const miningIntegrity = require('@perception/mining_integrity');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');

// The SHAFT's site stamp: job_ranking places it second in STRUCTURE_PRIORITY (yard → mineshaft → castle).
// A tunnel seat carries its asker's site, never this one.
const MINE_STRUCTURE = 'mineshaft';

const hq = require('@kernel/corporate_headquarters');
const inventoryLens = require('@kernel/inventory_lens');
const { smeltInputsFor } = require('@kernel/crafting_blueprint_registry');

// The pull entries a cell answers: the stone a cell's walls are cut from, under every name a building's
// order reaches the mine by.
const CELL_STONE = new Set([
    ...require('@utils/fragment_utils').stone_prospect_items,
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
function openCells(bot) {
    const held = require('@kernel/foreman_link').peerClaimKeys();
    const keyOf = c => (miningCellGraph.isStrip(c) ? miningCellGraph.lineKey(c) : `cell:${c.id}`);
    const heldIds = new Set(Object.values(miningCellGraph.readCells()).filter(c => held.has(keyOf(c))).map(c => c.id));
    if (!miningCellGraph.selectNextCell(bot, heldIds)) return 0;
    const tunnels = new Set(), free = new Set();
    for (const c of Object.values(miningCellGraph.readCells())) {
        if (c.complete || c.blocked) continue;
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
function noteMineRequest(pull, stoneShort, seats, open, groups) {
    const asked = Object.entries(pull).filter(([, n]) => n > 0).map(([item, n]) => `${item}:${n}`).join(',') || 'none';
    const by = groups.map(g => `${g.band}/${g.structure || 'no_site'}:${g.seats}`).join(',') || 'none';
    const key = `${seats}|${Object.keys(pull).filter(item => pull[item] > 0).join(',')}|${by}`;
    if (key === _mineRequest) return;
    _mineRequest = key;
    require('@kernel/watcher').summary(require('@thinking/assessors/shared').TAG,
        `MINE_REQUEST stone_short=${stoneShort} seats=${seats} open_units=${open} unit_yield=${cellYield()} asked=${asked} by=${by}`);
}

// ── THE TUNNEL IS PULLED, NEVER RANKED ──────────────────────────────────────────────────────────────
// seatGroups(askers) → [{ job_type, structure, band, stone, ore, seats }], one per asking position, in
// board order. Every underground item on the pull opens seats: stone by what one unit yields; anything
// else is an ore the tunnel uncovers a block at a time, so it opens a seat per ore still in the ground
// (a smelted item's need less the ore the fleet holds) and the open tunnel ends are the cap. With nothing asked there are no groups and no tunnel is dug.
// What one body in a mine seat is counted as bringing back, in blocks, when the crew is balanced: a
// pocket stack. A seat states no quantity of its own, so this is the figure peers add for each seat taken.
const MINE_SEAT_YIELD = 64;

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
        const g = { job_type: JOB_TYPE.site_supply, structure: site, band: JOB_CATEGORY_OF[JOB_TYPE.site_supply], stone: 0, ore: 0, level: 1 };
        // Every name the bill reaches the cell's stone by is one material here: its holdings are credited to
        // whichever name is counted first, so the names are levelled as one sum. Each ore is its own.
        const stone = { need: 0, have: 0 };
        for (const [root, row] of Object.entries(balance)) {
            if (CELL_STONE.has(root)) { stone.need += row.need; stone.have += row.have; g.stone = Math.max(g.stone, row.short); continue; }
            if (!(row.short > 0) || !isUnderground(root)) continue;
            g.ore = Math.max(g.ore, row.short);
            if (row.have / row.need < g.level) { g.level = row.have / row.need; g.level_need = row.need; }
        }
        if (g.stone > 0 && stone.have / stone.need < g.level) { g.level = stone.have / stone.need; g.level_need = stone.need; }
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
        if (!byPlace.has(place)) byPlace.set(place, { job_type: a.job_type, structure: a.structure || null, band: JOB_CATEGORY_OF[a.job_type], stone: 0, ore: 0 });
        const g = byPlace.get(place);
        if (CELL_STONE.has(a.item)) { g.stone = Math.max(g.stone, a.need); continue; }
        // THE MINE'S PART OF A SMELTED ITEM ENDS AT THE ORE: an ingot short is the tunnel's only for the ore
        // the fleet does not hold yet; the ore above ground is the furnace's to finish.
        const inputs = smeltInputsFor(a.item);
        const ore = inputs ? Math.max(0, a.need - inventoryLens.reachableByFleet(inputs)) : a.need;
        g.ore = Math.max(g.ore, ore);
    }
    return [...byPlace.values()]
        .filter(g => g.stone > 0 || g.ore > 0)
        .map(g => ({ ...g, seats: Math.max(Math.ceil(g.stone / cellYield()), g.ore) }))
        // BOARD ORDER IS BAND, THEN SITE (job_ranking.selectBand): the open cells go to the yard's ask before the
        // castle's, as every other yard job does. By band alone the castle, counted first, took them all.
        .sort((a, b) => (CATEGORY_INDEX[a.band] - CATEGORY_INDEX[b.band])
            || (siteRank(a) - siteRank(b)));
}
const siteRank = (g) => require('@thinking/job_ranking').measureSiteRank({ structure: g.structure });

// ── SECTION 1 — Mining (evaluates FIRST, Law 18; no deps on other assessments) ──
async function assess({ excluded } = {}) {
    const jobs = [];
    // `built` is the map every structure assessor reports into (job_board's built gate, the built-change announcement); starts false, set only where the scan below runs (Law 23).
    let shaftBuilt = false;

    const site        = require('@perception/mining_blueprinter').shaftChair();   // the headframe's, or a builder's own mineshaft
    const shaftCenter = site?.transpose_origin || null;

    // Gates on the predicate mining_manager releases on (Law 16): site located, staircase locked; the 10s idle heartbeat re-checks until then.
    if (!site?.transpose_origin || !site?.staircase) return { jobs, built: { [MINE_STRUCTURE]: shaftBuilt } };

    // Standalone shaft's mouth is a site; trees over it fell first via shared.siteTreesJob, region one staircase copy plus the top joint's leaf margin — runs before the light gate since felling needs no torch.
    if (require('@perception/mining_blueprinter').shaftStructure() !== 'headframe' && global.bot?.findBlocks) {
        const { siteTreeBox, siteTreePhaseDone, siteTreesJob } = require('@thinking/assessors/shared');
        const box = siteTreeBox('architect_staircase_final');
        // Held on the PHASE, not the scan: an all-claimed mouth is still being felled (shared.siteTreesJob).
        if (!siteTreePhaseDone(MINE_STRUCTURE)) {
            const treesSeats = await siteTreesJob(MINE_STRUCTURE, site.transpose_origin, box);
            jobs.push(...treesSeats);   // an ARRAY of seats now — one per standing trunk, capped at the roster
            if (!siteTreePhaseDone(MINE_STRUCTURE)) return { jobs, built: { [MINE_STRUCTURE]: shaftBuilt } };
        }
    }

    // No light gate: torches are placed in passing (mining_integrity.scanSegment), so mining posts whether or
    // not the fleet holds any.

    // Site is guaranteed present past the gate above, so scan integrity directly (no re-guard).
    let shaftComplete = false;
    let maintenanceNeeded = false;
    const bot = global.bot;
    // No guard around an integrity scan, here or below: these nodes absorb their own failures, so an
    // escaping throw is a defect (Law 13, Law 25).
    if (bot && bot.blockAt) {
        const integrity = miningIntegrity.scan(bot, excluded);
        // shaft_excavated (not damage-gated) drives the cell-mining switch — cobble flows during repairs; maintenance_needed is a finished segment damaged (permanent, like building_integrity).
        shaftComplete = !!integrity.shaft_excavated;
        maintenanceNeeded = !!integrity.maintenance_needed;
        // Same two facts as the phase switch above (excavated, no damage outstanding), so built and moved-to-cells verdicts can never disagree (Law 16).
        shaftBuilt = shaftComplete && !maintenanceNeeded;
    }

    // One way to mine, two sequential phases: `shaftComplete` picks the phase at posting, no downstream
    // arbiter (Law 16). ONE BODY OWNS THE SHAFT: one shared job, and the body that claims it works the staircase
    // segment by segment, top down, each whole segment — lane, both walls, ceiling — until it settles.
    if (!shaftComplete || maintenanceNeeded) {
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
    if (shaftComplete && bot && bot.blockAt) {
        const pull = hq.readConfRoomFlag('job_board_room', 'materials_needed_pull', {}) || {};
        const askers = hq.readConfRoomFlag('job_board_room', 'materials_needed_pull_askers', []) || [];
        const groups = seatGroups(askers);
        const wanted = groups.reduce((n, g) => n + g.seats, 0);
        const open = wanted > 0 ? openCells(bot) : 0;
        let k = 0;
        for (const g of groups) {
            for (let s = 0; s < g.seats && k < open; s++, k++) {
                jobs.push({
                    id: `mine_dig_cell_${k}`, type: 'mine', what: 'dig_cell',
                    where: shaftCenter,
                    job_type: JOB_TYPE.mining_dig_cell,
                    // The seat's place on the board is its asker's (job_ranking.orderSweep reads pulled_by).
                    pulled_by: { job_type: g.job_type, structure: g.structure },
                    structure: g.structure || undefined,
                    // How full the material the seat is dug for is; the dispatcher chooses among equals by it.
                    ...(Number.isFinite(g.level) ? { level: g.level } : {}),
                    // The shelf that level is read off, and what one seat is counted as bringing to it.
                    ...(g.level_key && g.level_need > 0 ? { level_key: g.level_key, level_need: g.level_need, seat_yield: MINE_SEAT_YIELD } : {}),
                    claimed_by: null, scope: 'shared',
                });
            }
        }
        noteMineRequest(pull, Math.max(0, ...groups.map(g => g.stone)), k, open, groups);
    }
    // No `mine_<item>` job: the need steers mining via job_board_room.materials_needed_pull, which
    // mining_executor reads for deficiencyMet and the surface-early test; never read back here (Law 16).

    return { jobs, built: { [MINE_STRUCTURE]: shaftBuilt } };
}

module.exports = { name: 'mining', assess };
