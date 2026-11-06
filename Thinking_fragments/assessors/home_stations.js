// assessor: home_stations (the authored home's fixtures)
// purpose: THE HOME'S FIXTURES JOIN THE POOL. The column pass builds a cube with no window opened, so a barrel or
//          furnace it placed is a block and no station. Once the home stands and opens to walking
//          (downloaded_plan_registry.standing), one shared job registers them, a stand at a time, until none is left.
//          The pass and the reading of what is left are home_stations_executor's.

'use strict';

const { JOB_TYPE } = require('@thinking/architect_config');

function assess() {
    const jobs = [];
    if (!global.bot) return { jobs };
    const left = require('@action/home_stations_executor').unregistered();
    if (!left.length) return { jobs };
    jobs.push({
        id: 'home_stations', type: 'home_stations', what: 'home_stations',
        where: left[0].pos,
        why: `${left.length} fixture(s) of the standing home not yet registered`,
        job_type: JOB_TYPE.home_stations, scope: 'shared', claimed_by: null,
    });
    return { jobs };
}

module.exports = { name: 'home_stations', assess };
