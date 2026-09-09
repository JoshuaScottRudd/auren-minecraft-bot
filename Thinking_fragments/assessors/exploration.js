// assessors/exploration — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const hq = require('@kernel/corporate_headquarters');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    ACCEPTABLE_BIOMES,
} = require('@thinking/architect_config');

const { currentBiome } = require('@thinking/assessors/shared');
// ── SECTION 4 — Exploration (evaluates LAST, dispatches FIRST at P0; Law 18) ──
// Posts seek_biome only when the bot is in an unbuildable biome with no home yet; once home is set,
// it's done. Home-base priority lives in assessors/building (the headframe coordinates step is lifted there).
function assess() {
    const jobs = [];

    const sb = hq.readBuildingChair('headframe', 'set_buildspot');
    const homeSet = typeof sb?.build_center === 'object'
                 && sb?.build_center !== null
                 && typeof sb?.build_center?.x === 'number';

    if (homeSet) return { jobs };

    const biome = currentBiome();
    const biomeAcceptable = biome !== null && ACCEPTABLE_BIOMES.has(biome);

    if (!biomeAcceptable) {
        jobs.push({
            id: 'explore_seek_biome', type: 'explore', what: 'seek_biome',
            where: null,
            job_type: JOB_TYPE.exploration_seek_biome,
            claimed_by: null,
            category: 'exploration', scope: 'local',
        });
    }

    return { jobs };
}

module.exports = { name: 'exploration', assess };
