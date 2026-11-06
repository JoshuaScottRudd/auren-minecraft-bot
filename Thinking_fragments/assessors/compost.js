// assessors/compost — one batch job that empties the banked compostables into the composter, and the forest run that
// gathers them while the bone_meal row is short and the first wheat field is not yet sown. See assessor_registry.

'use strict';

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
    COMPOST_BATCH_MIN,
    COMPOST_RUN_ITEM,
} = require('@thinking/architect_config');
const { supplyJob } = require('@thinking/assessors/shared');

// assess — posts ONE shared `compost_feed` job when COMPOST_BATCH_MIN surplus compostables sit in the
// fleet's chests and a composter stands to take them. Every body banks its
// compostables like any other surplus, so the walk to the bin is paid once per batch by one body. A chest
// job: it ranks above the building's bill, and the executor re-reads the chests and the bin at run time
// (Invariant B), so the job carries only the count that posted it.
async function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.world) return { jobs };

    const compost = require('@action/compost_executor');
    const banked = compost.bankedCompostables().reduce((n, b) => n + b.count, 0);
    const bin = await compost.findComposter(bot);
    if (!bin) return { jobs };
    const run = forestRun(banked);
    if (run) jobs.push(run);
    if (banked < COMPOST_BATCH_MIN) return { jobs };

    jobs.push({
        id: 'compost_feed', type: 'compost', what: 'compostables',
        where: { x: bin.position.x, y: bin.position.y, z: bin.position.z },
        why: `${banked} compostable(s) banked, batch at ${COMPOST_BATCH_MIN}`,
        job_type: JOB_TYPE.compost_feed, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

// forestRun(banked) → one supply job for compostables, or null. Posted while the bone_meal stock row is under its
// level, no bone is reachable to craft it from, and the chests hold less than a composter batch: one body (pledge_unit
// = need) walks out, picks compostables off the ground (supply_manager's harvest punch path) and banks them, and
// compost_feed turns the batch into bone meal. Raw, so delivered to the home chest, its leaf litter going straight to the
// bin at the deposit; posted only with a bin standing, and not while the storage chests have no room for it, since the
// run ends in a deposit the pool refuses.
// THE RUN ASKS FOR ANY COMPOSTABLE, WHERE THE GROUND IS THICKEST: the punch path walks first to the book page that saw
// the most compostable blocks (architect_config COMPOST_DENSITY, sector_finder.densest), scanning the frontier until
// one is that thick, and takes every compostable there. Flowers are taken too: compost_feed keeps of each only what
// the wool still owed will be dyed with (flock_colors.flowersKept) and composts the rest.
// A BOOTSTRAP ONLY (architect_config COMPOST_SEED_KEEP): once the first wheat field is sown no forest run is posted, and
// the harvest's surplus seeds are the composter's feed.
function forestRun(banked) {
    if (require('@perception/farming_integrity').firstFieldSown()) return null;
    const row = require('@thinking/requested_work').activeStockRows().find(r => r.item === 'bone_meal' && r.holder === 'storage');
    if (!row) return null;
    const inventoryLens = require('@kernel/inventory_lens');
    if (inventoryLens.forChestRequest('bone_meal') >= row.deficit_below) return null;
    if (inventoryLens.reachableByFleet('bone') > 0) return null;
    const need = COMPOST_BATCH_MIN - banked;
    if (need <= 0) return null;
    if (require('@api/inventory_swapper').roomFor(COMPOST_RUN_ITEM, need) <= 0) return null;
    const chest = require('@utils/fragment_utils').homeChest();
    if (!chest) return null;
    return supplyJob({
        id: 'compost_gather', what: COMPOST_RUN_ITEM, need, pledge_unit: need,
        where: chest.station.pos, station_id: chest.id, destination: 'storage',
        job_type: JOB_TYPE.compost_gather, claimed_by: null,
        hold_goal: need, at_destination: banked,
        parts: [{ who: 'chest:bone_meal', amount: need }],
        // 'shared', not deliverScope's 'local' for a raw item: the run is one body's, whatever the board's pledge count.
        category: 'resource', action: 'deliver', scope: 'shared',
    });
}

module.exports = { name: 'compost', assess };
