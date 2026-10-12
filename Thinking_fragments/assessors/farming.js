// assessors/farming — thin dispatch to farm_manager; farming_integrity owns the verdict. See assessor_registry.

'use strict';

const farmingIntegrity = require('@perception/farming_integrity');
const requestedWork = require('@thinking/requested_work');
const inventoryLens = require('@kernel/inventory_lens');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const watcher = require('@kernel/watcher');
const { getBotInventory, homeChest } = require('@utils/fragment_utils');
const { TAG, supplyJob, deliverScope } = require('@thinking/assessors/shared');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
    FARM_STRUCTURE,
} = require('@thinking/architect_config');
// ── SECTION 4b — Farming (dispatched to farm_manager) ──
// Thin by design: farming_integrity owns the whole verdict, including the seed/structure/hoe MATERIALS
// gate, the same as mining and building integrity, so this only reads scanCluster.
//
// ONE job, not one per plot: the plots sit in a tight cluster well out from base, and a job per
// instance forced the fleet to re-travel the full distance for each one. LOCATE is absent (Law 16 —
// one pathway) — the foreman sites every center before any body spawns, so an unlocated plot doesn't
// count here. scope:'local' — each bot feeds itself; no peer can claim it.
//

async function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    // Posts when the cluster has actionable work AND at least one actionable plot's materials are
    // ready — farming_integrity.scanCluster's GENEROUS gate: harvest needs nothing and planting runs
    // until seeds run out, so a seed shortage never freezes the whole field. `where` = the cluster
    // anchor (the dispatcher's proximity/claim reference). NO conference_room_key: the manager loops
    // every FARM_ROOM_KEY itself, so the magnet only carries "there is a farm visit to make".
    // ── THE FIELD STOPS WHEN THE ASKED-FOR WHEAT IS IN THE CHESTS ────────────────────────────────
    // The stop only applies when a wheat stock row exists to ask for it — a homesteader's standing
    // table carries none, so a homesteader farms unconditionally; a contractor's owner-request rows
    // can carry one, and the field stands down on reaching it. `activeStockRows` already carries the
    // species difference, so no separate branch is needed here (Law 27 — settle it where the fact is).
    //
    // THE FIGURE IS THE ONE THE SUPPLY ASSESSOR STANDS DOWN ON, read from the lens, not counted again.
    // A raw chest count is strictly larger and would stop the field while the crew was still short
    // (Law 16: one number for one question; Law 25: no false met).
    //
    // NOTHING IS "TURNED OFF" — the field simply parks. Standing wheat is not spoilage: mature cells
    // the crew declines to cut are the buffer, and raising the number resumes the visit with the crop
    // already grown. The stop is a missing job, not a flag anything has to clear.
    const wheatRow = requestedWork.activeStockRows()
      .find(r => r.item === 'wheat' && r.holder === 'storage' && typeof r.deficit_below === 'number');
    if (wheatRow && inventoryLens.forChestRequest('wheat') >= wheatRow.deficit_below) return { jobs };

    const cluster = await farmingIntegrity.scanCluster(bot);

    // EVERY FARM JOB IS STAMPED WITH THE FARM — tend, dirt and seeds alike. The stamp sets the job's RANK,
    // at the farm's position in `STRUCTURE_PRIORITY` (job_ranking's measureSiteRank), and refuses nothing:
    // farm work is always posted and always claimable, just served after the structures ranked ahead of it
    // while any of their work is on the board. `built` is the farm's own verdict.
    if (cluster.located && cluster.any_actionable && cluster.materials_ready) {
        jobs.push({ id: 'farm_tend#cluster', type: 'farm', what: 'farm_tend', where: cluster.anchor,
            job_type: JOB_TYPE.farm_tend, structure: FARM_STRUCTURE, scope: 'shared', claimed_by: null });
    }

    // ── THE FARM'S DIRT ORDER ──────────────────────────────────────────────────
    // A tine row is built from pocket dirt. When the seeds can plant rows the pocket cannot lay, gather
    // exactly that gap INTO THE POCKET — the same shape as a build's bootstrap gather
    // (assessors/building), since the bot carries it straight to the water and never banks it. A chest
    // that holds dirt is drawn first (supply_manager withdraws for a pocket order before it digs). It is
    // posted even while no row is actionable — dirt is what makes one so.
    if (cluster.located && cluster.dirt_gap > 0) {
        const held = countInInventory('dirt', getBotInventory());
        jobs.push(supplyJob({
            id: 'farm_supply_dirt', what: 'dirt', need: cluster.dirt_gap, where: null,
            job_type: JOB_TYPE.farm_supply_dirt, structure: FARM_STRUCTURE, claimed_by: null,
            hold_goal: held + cluster.dirt_gap, at_destination: held,
            // Pocket-destination, so the goal is what the body carries plus what the field wants. Named
            // apart because they answer to different owners.
            parts: [
                { who: 'bot:pocket_carried_dirt', amount: held },
                { who: `blueprint:${FARM_STRUCTURE}`, amount: cluster.dirt_gap },
            ],
            category: 'resource', scope: 'local',
        }));
    }

    // ── THE FARM'S SEED ORDER ──────────────────────────────────────────────────
    // Built into the farm's own request, so it asks for exactly the seeds the field needs — not routed
    // through the general request system. Delivered to the home chest the tend visit pulls from, the
    // headframe order's shape (assessors/building). Raw, so `local`: while the field wants seeds, every
    // idle bot may go out for them. `at_destination` is what the fleet already reaches — spoken for by
    // this same field.
    if (cluster.located && cluster.seed_gap > 0) {
        const chest = homeChest();
        if (chest) {
            jobs.push(supplyJob({
                id: 'farm_supply_seeds', what: 'wheat_seeds', need: cluster.seed_gap,
                where: chest.station.pos, station_id: chest.id, destination: 'storage',
                job_type: JOB_TYPE.farm_supply_seeds, structure: FARM_STRUCTURE, claimed_by: null,
                hold_goal: cluster.seed_gap, at_destination: cluster.seeds_reachable,
                // One asker, delivered to a chest, so no pocket term: the field's own seed shortfall.
                parts: [{ who: `blueprint:${FARM_STRUCTURE}_seeds`, amount: cluster.seed_gap }],
                category: 'resource', action: 'deliver', scope: deliverScope('wheat_seeds'),
            }));
        } else {
            watcher.summary(TAG, `farm wants ${cluster.seed_gap} seeds but no home chest is registered to deliver them to — no seed order.`);
        }
    }
    return { jobs, built: { [FARM_STRUCTURE]: cluster.built === true } };
}

module.exports = { name: 'farming', assess };
