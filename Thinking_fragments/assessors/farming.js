// assessors/farming — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const farmingIntegrity = require('@perception/farming_integrity');
const requestedWork = require('@thinking/requested_work');
const inventoryLens = require('@kernel/inventory_lens');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
} = require('@thinking/architect_config');
// ── SECTION 4b — Farming (its own assessment, dispatched to farm_manager) ──
// Thin by design: farming_integrity owns the whole verdict including the seed/structure/hoe MATERIALS gate,
// just like mining and building integrity, so this only reads scanCluster.
//
// ONE job, not one per plot: the plots sit in a tight cluster well out from base, and a job per instance
// made the fleet re-travel the full distance for each plot. LOCATE is absent (Law 16 — one pathway) —
// base_layout locks every center at startup, so unlocated plots simply don't count here. scope:'local' —
// each bot feeds itself; no peer can claim it.
//

function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    // ONE cluster job, not one per plot. The wheat plots are serviced as one committed visit by
    // farm_manager's tend loop — posting one independent job per plot made the fleet re-travel the full
    // distance for each plot instead of tending the whole field in one visit. Post when the cluster has
    // actionable work AND at least one
    // actionable plot's materials are ready — farming_integrity.scanCluster's GENEROUS gate: harvest needs
    // nothing and planting runs until seeds run out, so a seed shortage never freezes the whole field. `where`
    // = the cluster anchor (the dispatcher's proximity/claim reference). NO conference_room_key: the manager
    // loops every FARM_ROOM_KEY itself, so the magnet only carries "there is a farm visit to make". scanCluster
    // owns the whole verdict, so this stays thin exactly like the per-instance version it replaces (Law 16).
        // ── THE FIELD STOPS WHEN THE ASKED-FOR WHEAT IS IN THE CHESTS ────────────────────────────────
    // This assessor was supply-blind: it posted a tend visit whenever the field had actionable work, so a
    // crew farmed forever regardless of whether anything wanted wheat. That is right for a homesteader
    // and wrong for a crew working to a person's number (Architect 2026-08-31: *"they request wheat...
    // the bots will create a standard size farm of 32 and then continue gathering wheat until they reach
    // the desired amount and then will stop harvesting so they dont overfill a chest"*).
    //
    // ONE RULE, NO SPECIES BRANCH, and that is what makes it safe. `activeStockRows` already IS the
    // species difference — a homesteader gets the config's standing table, a contractor gets its owner's
    // request rows. The config declares NO storage row for wheat (only `holder:'bot', dump_threshold:0`),
    // so a homesteader finds no target here, is not gated, and farms exactly as before. A contractor
    // asked for 64 wheat finds a target and stands down on reaching it. A species check would have said
    // the same thing while being able to disagree with the rows (Law 27 — settle it where the fact is).
    //
    // THE FIGURE IS THE ONE THE SUPPLY ASSESSOR STANDS DOWN ON, read from the lens rather than counted
    // again. A raw chest count is the tempting substitute and is strictly larger — it would stop the
    // field while the crew was still short (Law 16: one number for one question; Law 25: no false met).
    //
    // NOTHING IS "TURNED OFF" — the field simply parks. Standing wheat is not spoilage: mature cells the
    // crew declines to cut are the buffer, and raising the number resumes the visit with the crop already
    // grown. That is why the stop is a missing job rather than a flag anything has to clear.
    const wheatRow = requestedWork.activeStockRows()
      .find(r => r.item === 'wheat' && r.holder === 'storage' && typeof r.deficit_below === 'number');
    if (wheatRow && inventoryLens.forChestRequest('wheat') >= wheatRow.deficit_below) return { jobs };

    const cluster = farmingIntegrity.scanCluster(bot);

    if (cluster.located && cluster.any_actionable && cluster.materials_ready) {
        jobs.push({ id: 'farm_tend#cluster', type: 'farm', what: 'farm_tend', where: cluster.anchor,
            job_type: JOB_TYPE.farm_tend, scope: 'shared', claimed_by: null });
    }
    return { jobs };
}

module.exports = { name: 'farming', assess };
