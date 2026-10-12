// assessor: housekeeping (the fleet's chests)
// purpose: POST ONE HOUSEKEEPING PASS WHEN THE CHESTS NEED ONE. Two things call for it: the chests' slots are
//          CHEST_HOUSEKEEPING.full_share taken and some item sits in more stacks than it needs, or a chest
//          holds an item the waste pit takes. One job, one body (`scope: 'shared'`, one id); the pass itself is
//          chest_housekeeping_executor's, and so is the reading of what there is to do (`plan`).

'use strict';

const { JOB_TYPE, CHEST_HOUSEKEEPING } = require('@thinking/architect_config');

function assess() {
    const jobs = [];
    if (!require('@thinking/requested_work').activeWorkRequirements().includes('chest_housekeeping')) return { jobs };
    if (!global.bot) return { jobs };
    const state = require('@action/chest_housekeeping_executor').plan();
    const trash = state.takes.filter(t => t.why === 'trash').length;
    const crowded = state.share >= CHEST_HOUSEKEEPING.full_share;
    const due = state.takes.filter(t => t.why === 'trash' || crowded);
    if (!due.length) return { jobs };
    jobs.push({
        id: 'chest_housekeeping', type: 'housekeeping', what: 'chest_slots',
        where: due[0].pos,
        why: `${state.used} of ${state.slots} chest slot(s) taken, ${due.length} take(s) to make (${trash} of trash)`,
        job_type: JOB_TYPE.chest_housekeeping, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'housekeeping', assess };
