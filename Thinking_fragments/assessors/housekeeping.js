// assessor: housekeeping (the fleet's chests)
// purpose: THE CHESTS' CLEAN-OUT. Once CHEST_HOUSEKEEPING.full_share of every chest slot is taken, whatever those slots
//          hold, one shared job is posted pass after pass until clean_to is reached or nothing is left to take. The
//          pass itself is chest_housekeeping_executor's, and so is the reading of what there is to do (`plan`). A
//          clean-out that ends short of clean_to names what holds the slots: those are the items no rule may throw.

'use strict';

const watcher = require('@kernel/watcher');
const { JOB_TYPE, CHEST_HOUSEKEEPING } = require('@thinking/architect_config');

const TAG = 'housekeeping';
let _cleaning = false;
let _lastSaid = null;

function assess() {
    const jobs = [];
    if (!global.bot) return { jobs };
    const state = require('@action/chest_housekeeping_executor').plan();
    if (state.share >= CHEST_HOUSEKEEPING.full_share) _cleaning = true;
    if (_cleaning && (state.share <= CHEST_HOUSEKEEPING.clean_to || !state.takes.length)) {
        _cleaning = false;
        if (state.share > CHEST_HOUSEKEEPING.clean_to) {
            const top = [...state.holders].sort((a, b) => b[1] - a[1]).slice(0, 5);
            const names = top.map(([item]) => item).join(',');
            if (names !== _lastSaid) watcher.warn(TAG, `CLEAN-OUT ENDED SHORT — ${state.used} of ${state.slots} chest slot(s) taken, nothing left to take; most slots: ${top.map(([item, n]) => `${item}=${n}`).join(' ')}`);
            _lastSaid = names;
        }
    }
    if (!_cleaning) return { jobs };
    jobs.push({
        id: 'chest_housekeeping', type: 'housekeeping', what: 'chest_slots',
        where: state.takes[0].pos,
        why: `${state.used} of ${state.slots} chest slot(s) taken, ${state.takes.length} take(s) to make (${state.takes.filter(t => t.why === 'trash').length} of trash)`,
        job_type: JOB_TYPE.chest_housekeeping, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'housekeeping', assess };
