// assessors/canopy — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const Vec3 = require('vec3');
const { guardExternalSync } = require('@utils/external_library_guard');
const { readBuildCenter } = require('@utils/fragment_utils');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    TREE_CLEAR_RADIUS,
    CANOPY_CLEAR_BLUEPRINTS,
} = require('@thinking/architect_config');

const { TAG } = require('@thinking/assessors/shared');
// ── SECTION 4d — Proactive canopy clearing (its own assessment, dispatched to canopy_clear_executor) ──
// Camera-framing upkeep, distinct from log SUPPLY (harvest_executor's ladder).
// For each OPTED-IN surface blueprint (CANOPY_CLEAR_BLUEPRINTS) whose build_center is located, post ONE
// lowest-priority `clear_canopy` job while a wild tree still stands within TREE_CLEAR_RADIUS of the
// center — and NOTHING once the ring is clear, so it never busy-loops. The gate uses the SAME square
// (Chebyshev radius) the executor's canopyZone fells inside, so a posted job always has a tree the fell
// can actually target. The job carries only `where` (the immutable center) — the executor re-derives
// everything else at run time (Invariant B). The tree farm is not in the opt-in list (it grows the
// trees), and mining/underground has no entry (it needs no clearing).
const CANOPY_LOG_RE = /(.*_)?log$/;   // same "what is a tree log" definition tree_feller uses (Law 16)
function _treeInClearRadius(bot, center) {
    const scan = guardExternalSync(TAG, `canopy findBlocks around (${center.x},${center.z})`, () =>
        bot.findBlocks({
            point: new Vec3(center.x, center.y, center.z),
            matching: (b) => !!(b && b.name && CANOPY_LOG_RE.test(b.name)),
            // Euclidean sweep must reach the Chebyshev SQUARE's corners (r·√2 ≈ 1.41r), not just its
            // edges — else the gate reports "clear" while corner trees still stand and clear_canopy stops
            // posting early. The old fixed `+ 8` slack silently assumed a small radius (held at r=16:
            // 16·√2≈22.6<24) and broke when TREE_CLEAR_RADIUS grew to 64 (64·√2≈90.5>72). Derive from r
            // so it scales with any radius. Count raised for the ~1.6× wider area.
            maxDistance: Math.ceil(TREE_CLEAR_RADIUS * Math.SQRT2) + 2,
            count: 64,
        }));
    // A refused sweep posts NO job, which is the safe direction here and self-healing: posting on an
    // unconfirmed tree sends the bot on a trip to fell nothing, while a skipped post is re-evaluated
    // from scratch on the next sweep (Invariant B). It is not a measurement of "clear" — no caller
    // records it as one; the gate is re-asked every pass.
    if (!scan.ok) return false;
    // Narrow the Euclidean sweep to the executor's Chebyshev square so the gate and the fell agree.
    return (scan.value || []).some(p => Math.max(Math.abs(p.x - center.x), Math.abs(p.z - center.z)) <= TREE_CLEAR_RADIUS);
}

function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.findBlocks || !bot.blockAt) return { jobs };

    for (const blueprint of CANOPY_CLEAR_BLUEPRINTS) {
        const center = readBuildCenter(blueprint);
        if (!center) continue;                              // not sited yet — nothing to clear around
        if (!_treeInClearRadius(bot, center)) continue;     // ring already clear — post nothing
        jobs.push({ id: `clear_canopy_${blueprint}`, type: 'canopy', what: 'clear_trees', where: center,
            job_type: JOB_TYPE.clear_canopy, scope: 'shared', claimed_by: null });
    }
    return { jobs };
}

module.exports = { name: 'canopy', assess };
