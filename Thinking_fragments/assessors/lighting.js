// assessors/lighting — the mine's torch visit job. See assessor_registry.

'use strict';

const lightingIntegrity = require('@perception/lighting_integrity');
const { JOB_TYPE } = require('@thinking/architect_config');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { getBotInventory } = require('@utils/fragment_utils');

// assess — posts ONE `light_network` job while the dug shaft is missing a torch a visit can place, or a basement cell
// owes one its digger left (a tunnel past its reach, a torch knocked out), and the body holds a torch or can make every
// torch the visit owes (lighting_manager crafts them whole). The base's torches
// are its spawn proofing's voxels, built and repaired with it; the tunnels' are their digger's. Whether the crew lights at
// all is the integrity node's verdict (it logs its own silence); this only reads it.
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.world) return { jobs };
    const plan = lightingIntegrity.scan(bot);
    if (!plan.located || plan.placements.length === 0) return { jobs };
    if (countInInventory('torch', getBotInventory() || {}) === 0) {
        const lighting = require('@action/lighting_manager');
        const can = lighting.canMakeTorches(bot, plan.placements.length);
        if (!can.ok) {
            if (can.fuelShort > 0) lighting.noteFuelWait(can.crafts);
            return { jobs };
        }
    }
    const at = plan.placements[0].source;
    jobs.push({ id: 'light_network', type: 'light', what: 'light_network', where: { x: at.x, y: at.y, z: at.z },
        job_type: JOB_TYPE.light_network, scope: 'shared', claimed_by: null });
    return { jobs };
}

module.exports = { name: 'lighting', assess };
