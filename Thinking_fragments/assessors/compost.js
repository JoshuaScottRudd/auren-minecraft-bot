// assessors/compost — one batch job that empties the banked compostables into the composter. See
// assessor_registry.

'use strict';

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
    COMPOST_BATCH_MIN,
} = require('@thinking/architect_config');

// assess — posts ONE shared `compost_feed` job when COMPOST_BATCH_MIN surplus compostables sit in the
// fleet's chests and a composter stands to take them. Every body banks its
// compostables like any other surplus, so the walk to the bin is paid once per batch by one body. A chest
// job: it ranks above the building's bill, and the executor re-reads the chests and the bin at run time
// (Invariant B), so the job carries only the count that posted it.
function assess() {
    const jobs = [];
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('compost')) return { jobs };
    const bot = global.bot;
    if (!bot || !bot.findBlocks) return { jobs };

    const compost = require('@action/compost_executor');
    const banked = compost.bankedCompostables().reduce((n, b) => n + b.count, 0);
    if (banked < COMPOST_BATCH_MIN) return { jobs };
    const bin = compost.findComposter(bot);
    if (!bin) return { jobs };

    jobs.push({
        id: 'compost_feed', type: 'compost', what: 'compostables',
        where: { x: bin.position.x, y: bin.position.y, z: bin.position.z },
        why: `${banked} compostable(s) banked, batch at ${COMPOST_BATCH_MIN}`,
        job_type: JOB_TYPE.compost_feed, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'compost', assess };
