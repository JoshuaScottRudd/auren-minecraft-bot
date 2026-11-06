// assessor: current — TEMPORARY, until a body swims a current as a priced move.
//
// A GATE on the whole board, beside respawn: a body in running water may plan one thing, getting out of it, and
// nothing else. "If it needs to make a plan while in flowing water then the only plan it can make is to get out of
// flowing water." While underwater_swimming.inCurrent reads the body carried, the board posts leave_current alone;
// the current reflex (underwater_swimming) holds the controls, and current_manager waits for it or swims ashore. The
// definition of "in a current" is imported from that unit, not restated (Law 16). scope:'local': no peer can take this
// body out of the water.

'use strict';

function assess() {
    const bot = global.bot;
    if (!bot || !require('@locomotion/underwater_swimming').inCurrent(bot)) return { jobs: [] };
    const { JOB_TYPE } = require('@thinking/architect_config');
    return {
        jobs: [{
            id: 'leave_current', type: 'current', what: 'leave',
            where: null,
            job_type: JOB_TYPE.leave_current,
            claimed_by: null, scope: 'local',
        }],
    };
}

module.exports = { name: 'current', assess };
