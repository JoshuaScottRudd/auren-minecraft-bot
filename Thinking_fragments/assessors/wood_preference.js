// assessors/wood_preference — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    ACCEPTABLE_BIOMES,
} = require('@thinking/architect_config');

const { currentBiome } = require('@thinking/assessors/shared');
// ── SECTION 4b — Wood preference (startup one-shot → set_wood_preference) ──
// Posted high-priority on a fresh run while unset, the same shape as locking the blueprint locations, and
// once set it is done forever. One bot counts species around the base, publishes the most abundant; later
// log scans SORT by it (never filter — fragment header). "Done" asked of the performer via
// woodPreferenceSet() — same re-post-forever rule as assessors/base_layout. scope:'shared' — mutates fleet
// state, one owner (Law 4); the shared claim is the dedup mechanism. Biome-gated like base_layout:
// deciding in a biome the fleet will leave publishes a species that isn't where building happens —
// remembered state whose world left (Invariant B).
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    const { woodPreferenceSet } = require('@action/set_wood_preference');
    if (woodPreferenceSet()) return { jobs };

    const biome = currentBiome();
    if (!biome || !ACCEPTABLE_BIOMES.has(biome)) return { jobs };

    jobs.push({
        id: 'set_wood_preference', type: 'wood_preference', what: 'set_wood_preference',
        where: null,
        job_type: JOB_TYPE.wood_preference_lock,
        claimed_by: null, scope: 'shared',
    });
    return { jobs };
}

module.exports = { name: 'wood_preference', assess };
