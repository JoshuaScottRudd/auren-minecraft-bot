// assessors/tandem — the guard's seat of the tandem. See assessor_registry.

'use strict';

const { JOB_TYPE, TANDEM_PAIRS, isNightTime, isDuskTime } = require('@thinking/architect_config');
const lightingIntegrity = require('@perception/lighting_integrity');

// assess — posts TANDEM_PAIRS `tandem_guard` seats from dusk while the base's spawn proofing has a torch not standing, to a body
// carrying a weapon and a shield. job_gates.tandemGate holds a seat past the proofing's posted trips, and one a peer's duty fills.
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.entity || (!isNightTime() && !isDuskTime())) return { jobs };
    if (!require('@kernel/bot_mandate').fearsTheNight()) return { jobs };
    const light = lightingIntegrity.baseLight();
    if (!light) return { jobs };
    const base = require('@kernel/keeper_verdicts').get('light')?.base;
    if (base && base.standing === light.torches.length && base.torches === light.torches.length) return { jobs };
    if (!require('@api/combat_board').guardKitted(bot)) return { jobs };
    const r = light.rect;
    for (let seat = 1; seat <= TANDEM_PAIRS; seat++) {
        jobs.push({
            id: `tandem_guard_${seat}`, type: 'guard', what: 'tandem_guard', seat,
            where: { x: Math.floor((r.minX + r.maxX) / 2), y: Math.floor(bot.entity.position.y), z: Math.floor((r.minZ + r.maxZ) / 2) },
            job_type: JOB_TYPE.tandem_guard, scope: 'shared', claimed_by: null,
        });
    }
    return { jobs };
}

module.exports = { name: 'tandem', assess };
