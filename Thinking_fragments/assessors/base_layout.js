// assessors/base_layout — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const { baseLayoutComplete } = require('@action/lock_all_buildspots');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    ACCEPTABLE_BIOMES,
} = require('@thinking/architect_config');

const { currentBiome } = require('@thinking/assessors/shared');
// ── SECTION 4a — Base-layout lock (startup one-shot → lock_all_buildspots) ──
// "Done" asked of the batch via baseLayoutComplete(), never re-derived: a gate computing its own done can
// demand more than the performer delivers and re-post forever. Whole-base one-pass lock is deliberate: a
// bad seed surfaces early, not mid-build. Biome-gated: seek_biome (P0) moves the bot somewhere buildable
// first; without it a peer in a bad biome hard-stops the layout. Ranked just under home_base to WIN the
// locate race vs lazy per-blueprint finds. scope:'shared' — mutates shared HQ, one owner (Law 4). That the
// gate goes quiet on a SHORT field is UNGUARDED — no bench currently exercises this claim (`tools/README.md`),
// so a regression here would go uncaught.
function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    if (baseLayoutComplete()) return { jobs };

    // THE BIOME GATE IS THE FARM'S, SO IT BINDS THE SPECIES THAT PLANTS ONE. ACCEPTABLE_BIOMES exists
    // because the wheat field needs water and plantable soil, and a homesteader in a bad biome is moved
    // by seek_biome before it lays anything out. A contractor sites one building — flat clear ground —
    // on a cell its owner chose to stand on, so the same gate would strand it beside a human whose home
    // is in a desert: it would refuse to site the house, idle forever, and never say why the biome of a
    // farm it will never plant was the reason (Law 6).
    if (!require('@kernel/bot_mandate').isContractor()) {
        const biome = currentBiome();
        if (!biome || !ACCEPTABLE_BIOMES.has(biome)) return { jobs };
    }

    jobs.push({
        id: 'lock_base_layout', type: 'base_layout', what: 'lock_base_layout',
        where: null,
        job_type: JOB_TYPE.base_layout_lock,
        claimed_by: null, scope: 'shared',
    });
    return { jobs };
}

module.exports = { name: 'base_layout', assess };
