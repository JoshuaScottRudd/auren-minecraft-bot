// assessors/survey — the survey's jobs: the home sector's scan, and a furnace's stone while the shaft is dug: pierced
// from one column under the base for the alpha structure, open to the sky for every other building. Ore is the strip mine's alone (assessors/mining). See assessor_registry.

'use strict';

const { JOB_TYPE, SURVEY_CATEGORIES, SECTOR_SCAN } = require('@thinking/architect_config');
const book = require('@perception/survey_book');
const { PLEDGE_BLOCK } = require('@utils/calculators/yield_pledge_calculator');

// ── HOME ─────────────────────────────────────────────────────────────────────────────────────────────
// Home is the alpha structure's site (architect_config ALPHA_STRUCTURE): the base the grid of sectors is centred on, its
// sector 0,0 (survey_book.gridOrigin). Sectors open outward from it, each beside one already scanned (survey_book.frontier).
function home() {
    return require('@utils/fragment_utils').readTransposeOrigin(require('@kernel/bot_mandate').homeBlueprint());
}
// The mine's site, where the surface stone trips start: the shaft the stone is pierced under.
function shaftHome() {
    const site = require('@perception/mining_blueprinter').shaftChair();
    return site && site.transpose_origin ? site.transpose_origin : null;
}

// A sector a peer is scanning already (its `sector:` claim, taken by survey_executor before any scan) is not offered:
// the trip would end at the claim with nothing done, and the board would offer it again on the next sweep.
const peerScanning = sector => require('@kernel/foreman_link').peerClaimKeys().has(`sector:${sector}`);

// A sector's centre is not yet read when the job is posted, so its height is stated as home's.
function sectorJob(sector, at) {
    const centre = book.sectorCentre(sector);
    return {
        id: `survey_sector_${sector}`, type: 'survey', what: 'sector', sector,
        where: { x: centre.x, y: at.y, z: centre.z },
        job_type: JOB_TYPE.survey_sector,
        claimed_by: null, scope: 'shared',
    };
}

// Whether a pickaxe this body carries can harvest the blocks of `category`: a stone trip is offered only to a body
// that can take stone. A reserved pickaxe counts only for a block no lower tier takes (fragment_utils.RESERVED_TOOLS).
function canHarvest(bot, category) {
    const row = SURVEY_CATEGORIES.find(c => c.category === category);
    const blocks = row ? bot.registry.blocksArray.filter(b => row.pattern.test(b.name)) : [];
    if (!blocks.length) return false;
    const { RESERVED_TOOLS, onlyReservedTakes } = require('@utils/fragment_utils');
    const items = bot.inventory.items();
    return blocks.some(b => !b.harvestTools || items.some(i => b.harvestTools[i.type]
        && (!RESERVED_TOOLS.includes(i.name) || onlyReservedTakes(bot, b, i))));
}

// ── FURNACE STONE WHILE THE SHAFT IS DUG ─────────────────────────────────────────────────────────────
// stoneJobs(bot, groups) -> jobs. Until the shaft is finished only its digger cuts stone underground, so while a
// body holds the shaft job, or while the mine is shut to this body for want of the trip's torches (a lighting
// crew digs lit: mining_manager.mineLightReady), the stone a furnace is made of (`furnace_material`) is fetched
// from stone open to the sky: one seat per pledge (PLEDGE_BLOCK) short, each bringing back a whole pledge. Only the furnace's
// while the mine is open: a building's own stone comes from the mine, and while it is shut the surface brings that
// too (the group's `stone`, the larger of the two figures). A stone tool waits for cobblestone to be in the fleet's hands
// (assessors/shared.kitTier), so what a trip brings past the furnace's need goes to tools. A surface-stone body
// looks around itself first, then at a sector the book holds stone in, and with none anywhere scans the
// next frontier sector (survey_executor), so a body short of stone always has somewhere to go. A shaft nobody
// holds is left to be taken: these seats would outrank it on the board.
//
// THE ALPHA STRUCTURE'S STONE IS PIERCED (STONE_PIERCE): its seats are stone_pierce trips, one column under the base dug
// straight down to a run of stone, because the alpha structure is what opens the mine and its stone cannot wait on
// open ground the base may not have.
function stoneJobs(bot, groups) {
    const at = shaftHome();
    if (!at || !bot || !bot.inventory || !canHarvest(bot, 'stone')) return [];
    const { nightGate } = require('@thinking/job_gates');
    const probe = stoneJob({ job_type: JOB_TYPE.survey_stone }, 0, at);
    if (nightGate(probe)) return [];
    const hq = require('@kernel/corporate_headquarters');
    const shaftHeld = Object.values(hq.getFullBoardroom({})).some(chair => chair?.magnet?.job_id === 'mine_dig_shaft');
    const mineShut = !require('@action/mining_manager.js').mineLightReady(bot).ok;
    if (!shaftHeld && !mineShut) return [];
    const jobs = [];
    for (const g of groups) {
        // A shut mine brings no stone at all, so the surface brings the building's own stone too.
        const seats = Math.ceil((mineShut ? Math.max(g.furnace || 0, g.stone || 0) : (g.furnace || 0)) / PLEDGE_BLOCK);
        const pierced = g.structure && g.structure === require('@thinking/architect_config').ALPHA_STRUCTURE[require('@kernel/bot_mandate').currentMode()];
        for (let k = 0; k < seats; k++) jobs.push(stoneJob(g, k, at, pierced ? 'stone_pierce' : 'surface_stone'));
    }
    return jobs;
}
// toolStoneJobs(bot) → this body's own stone_pierce trip while it holds no stone pickaxe and the chests hold neither one nor the
// cobblestone for one: the mine turns away a body with no stone pickaxe, so its first stone cannot come from there. Ranked with the body's
// kit. Not before the home stands, whose stone comes first (assessors/shared.homeStands). Outside, so held at dusk and night.
function toolStoneJobs(bot) {
    const at = shaftHome();
    if (!at || !bot || !bot.inventory || !canHarvest(bot, 'stone')) return [];
    const shared = require('@thinking/assessors/shared');
    if (!shared.homeStands()) return [];
    const inventory = require('@utils/fragment_utils').getBotInventory() || {};
    if (shared.stoneOrBetter('pickaxe', inventory) > 0) return [];
    const lens = require('@kernel/inventory_lens');
    const { requirementTree } = require('@utils/calculators/build_material_calculator');
    const cost = requirementTree('stone_pickaxe', 1, {}).cobblestone || 0;
    if (lens.inChests('stone_pickaxe') > 0 || lens.inChests('cobblestone') + (inventory.cobblestone || 0) >= cost) return [];
    const job = stoneJob({ job_type: JOB_TYPE.crafting_tool, band: 'bot' }, 0, at, 'stone_pierce');
    if (require('@thinking/job_gates').nightGate(job)) return [];
    return [{ ...job, id: `survey_pierce_tools_${process.env.BOT_ID || 'default'}` }];
}
function stoneJob(g, k, at, what = 'surface_stone') {
    return {
        id: `survey_${what === 'stone_pierce' ? 'pierce' : 'stone'}_${g.band || 'none'}_${g.structure || 'none'}_${k}`, type: 'survey', what, want: PLEDGE_BLOCK,
        where: at, job_type: JOB_TYPE.survey_stone,
        ...(g.job_type && g.job_type !== JOB_TYPE.survey_stone ? { pulled_by: { job_type: g.job_type, structure: g.structure } } : {}),
        claimed_by: null, scope: 'shared',
    };
}

// ── THE HOME SECTOR ──────────────────────────────────────────────────────────────────────────────────
// Scanned as soon as home is sited, whatever is asked for, and holding up nothing: it is the first page the
// rings open from.
async function assess({ inventory }) {
    const at = home();
    if (!at) return { jobs: [] };
    const sector = book.sectorOf(at);
    if (peerScanning(sector)) return { jobs: [] };
    if (!book.sectorPage(sector)) return { jobs: [sectorJob(sector, at)] };
    return { jobs: [...portalJobs(at, inventory), ...tourJobs(at, inventory)] };
}

// ── THE PORTAL ──────────────────────────────────────────────────────────────────────────────────────
// One seat, once the mould stands and until the frame is lit: two buckets to hand (lava and water), and lava in the book or banked.
function portalJobs(at, inventory) {
    const { PORTAL_MOULD } = require('@thinking/architect_config');
    if (book.portalLit()) return [];
    const chair = require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {}) || {};
    if (!chair.built || chair.built[PORTAL_MOULD] !== true) return [];
    const lens = require('@kernel/inventory_lens');
    const buckets = ['bucket', 'water_bucket', 'lava_bucket'].reduce((n, b) => n + (inventory[b] || 0) + lens.inChests(b), 0);
    if (buckets < 2 || !(book.surfaceLava(at).length || lens.inChests('lava_bucket') > 0)) return [];
    return [{ id: 'survey_portal_cast', type: 'survey', what: 'portal_cast', where: at, job_type: JOB_TYPE.survey_portal, claimed_by: null, scope: 'shared' }];
}

// ── THE SECTOR TOUR ──────────────────────────────────────────────────────────────────────────────────
// One seat, carrying nothing it needs: it scans every sector within SECTOR_SCAN.tour_rings of home in one walk
// (sector_finder.tour), so what the crew later asks for is already in the book. It is offered once this body holds its
// kit (shared.kitDone): an empty bot band only says none of the kit's rows can be worked yet. Night holds it, since it is not night-approved, and it is offered again in the morning.
function tourJobs(at, inventory) {
    const rings = SECTOR_SCAN.tour_rings;
    if (!require('./shared').kitDone(inventory)) return [];
    if (!book.frontier(at).some(s => book.ringOf(s, at) <= rings)) return [];
    return [{
        id: 'survey_sector_tour', type: 'survey', what: 'sector_tour', rings,
        where: at, job_type: JOB_TYPE.survey_tour,
        claimed_by: null, scope: 'shared',
    }];
}

module.exports = { name: 'survey', assess, stoneJobs, toolStoneJobs, home };
