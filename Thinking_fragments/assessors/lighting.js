// assessors/lighting — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const torchIntegrity = require('@perception/torch_integrity');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');
// assess — the base-lighting counterpart to assessors/farming (combat refurbish §1b). Posts ONE
// `light_base` job when torch_integrity reports dark surface cells in the headframe safe square AND the
// bot holds torches to fix them. Gates exactly like farming: the "is there work / do we have materials"
// decision lives in the integrity node (which logs its own silence), job_board only reads the verdict.
// The job carries only `where` (the base center) — NOT the dark-cell list: the dispatcher magnet copies
// a fixed field set that a cell array wouldn't survive, and passing a stale list would violate Invariant
// B. The executor re-scans for fresh dark cells at run time, exactly as farm_executor re-derives its
// till/plant/harvest work from live state.
function assess() {
    const jobs = [];
    // UNHOOKED: the autonomous torch-lighting system is disabled wholesale. In-world it placed torches
    // with no coherence — no block-awareness of where a torch already sat or whether a cell was inside a
    // build footprint, so torches piled up everywhere and rogue torches landed on blueprint voxels
    // (`torch:should_be_air` conflicts that stalled a headframe build_executor). Light-level detection is
    // meaningless while placement is incoherent. Returning no jobs here makes the whole downstream dormant
    // (torch_integrity.scan, the `light_base` job, the dispatcher route to torch_executor) without deleting
    // it — this is the single off-switch to flip back on once the system is redesigned. Everything below
    // is preserved for that rethink.
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
