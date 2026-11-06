// assessors/tree_farm — one chest job that takes the banked farm saplings out to the tree farm while a cell of it is
// open and the band below TREE_FARM.saturation. See assessor_registry.

'use strict';

const { JOB_TYPE } = require('@thinking/architect_config');

// assess — posts ONE shared `sapling_plant` job while the home band is below its saturation with an open cell (the
// integrity keeper's `tree_farm` verdict, read through sapling_planter.openCell) and the fleet's
// chests hold a farm sapling. A chest job: the chests push it out rather than ask for it, and the executor re-reads the
// chests and the farm at run time (Invariant B), so the job carries only what posted it.
async function assess() {
    const jobs = [];
    const planter = require('@api/sapling_planter');
    const saplings = planter.farmSaplings();
    if (!saplings.length) return { jobs };
    const bot = global.bot;
    if (!bot || !bot.world || !bot.entity) return { jobs };
    const farm = planter.zone();
    if (!farm || !farm.cells.length) return { jobs };
    const inventoryLens = require('@kernel/inventory_lens');
    const banked = Object.fromEntries(saplings.map(n => [n, inventoryLens.inChests(n)]));
    const total = Object.values(banked).reduce((n, c) => n + c, 0);
    if (total <= 0) return { jobs };
    const open = planter.openCell(bot, farm);
    if (!open) return { jobs };
    const chest = require('@utils/fragment_utils').homeChest();
    if (!chest) return { jobs };

    jobs.push({
        id: 'sapling_plant', type: 'plant', what: 'saplings',
        where: chest.station.pos, station_id: chest.id,
        why: `home band cell (${open.x},${open.z}) open ${open.gap} out from home, below its saturation, ${total} farm sapling(s) banked`,
        job_type: JOB_TYPE.sapling_plant, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'tree_farm', assess };
