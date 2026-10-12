// assessors/lighting — base-lighting counterpart to assessors/farming. See assessor_registry.

'use strict';

const torchIntegrity = require('@perception/torch_integrity');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');
// assess — the base-lighting counterpart to assessors/farming. Posts ONE `light_base` job when
// torch_integrity reports dark surface cells in the headframe safe square AND the bot holds torches to
// fix them. Gates exactly like farming: whether there is work and whether materials are ready both live
// in the integrity node (which logs its own silence); this only reads the verdict. The job carries only
// `where` (the base center), not the dark-cell list — the dispatcher magnet copies a fixed field set a
// cell array wouldn't survive, and a stale list would violate Invariant B. The executor re-scans for
// fresh dark cells at run time, exactly as farm_executor re-derives its till/plant/harvest work from
// live state.
function assess() {
    const jobs = [];
    // UNHOOKED: the autonomous torch-lighting system is disabled wholesale. In-world it placed torches
    // with no coherence — no block-awareness of whether a torch already sat there or whether a cell was
    // inside a build footprint, so torches piled up everywhere and rogue torches landed on blueprint
    // voxels. Light-level detection is meaningless while placement is incoherent. Returning no jobs here
    // makes the whole downstream dormant (torch_integrity.scan, the `light_base` job, the dispatcher
    // route to torch_executor) without deleting it — the single off-switch to flip back on once the
    // system is redesigned. Everything below is preserved for that.
    return { jobs };

    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    const ti = torchIntegrity.scan(bot);

    if (!ti.located) return { jobs };              // no base yet — nothing to guard (node logs it)
    if (ti.dark_count === 0) return { jobs };      // base fully lit — no work
    if (!ti.materials_ready) return { jobs };      // no torches on hand — node already logged the gate

    jobs.push({ id: 'light_base', type: 'light', what: 'light_base', where: ti.center,
        job_type: JOB_TYPE.light_base, scope: 'shared', claimed_by: null });
    return { jobs };
}

module.exports = { name: 'lighting', assess };
