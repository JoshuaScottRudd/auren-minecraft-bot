// assessors/farming — thin dispatch to farm_manager; farming_integrity owns the verdict. See assessor_registry.

'use strict';

const farmingIntegrity = require('@perception/farming_integrity');
const requestedWork = require('@thinking/requested_work');
const inventoryLens = require('@kernel/inventory_lens');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const watcher = require('@kernel/watcher');
const { getBotInventory, homeChest } = require('@utils/fragment_utils');
const { TAG, supplyJob, deliverScope, siteTreeBox, siteTreePhaseDone, siteTreesJob } = require('@thinking/assessors/shared');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const { JOB_TYPE, WILD_CANE } = require('@thinking/architect_config');
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
    const field = farmingIntegrity.farmField();
    const FARM_STRUCTURE = field.structure;

    // Posts when the cluster has actionable work AND at least one actionable plot's materials are
    // ready — farming_integrity.scanCluster's GENEROUS gate: harvest needs nothing and planting runs
    // until seeds run out, so a seed shortage never freezes the whole field. `where` = the cluster
    // anchor (the dispatcher's proximity/claim reference). NO conference_room_key: the manager loops
    // every FARM_ROOM_KEY itself, so the magnet only carries "there is a farm visit to make".
    // ── THE FIELD STOPS WHEN THE ASKED-FOR WHEAT IS IN THE CHESTS ────────────────────────────────
    // The stop only applies when a wheat stock row exists to ask for it — a standing table that carries
    // none farms unconditionally.
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

    // TREES FIRST (assessors/shared siteTreesJob — the felling job every site posts): the field is sited over trees
    // (utils/surface_site), so while a tree stands on it or within SURFACE_TREE_MARGIN the felling posts in the
    // tend's place. The seed and dirt orders below still post: felling needs neither.
    // Each of the field's sites (the wheat field, the cane field) is cleared of its own trees.
    let treesStanding = false;
    for (const key of field.keys) {
        const origin = require('@kernel/corporate_headquarters').readBuildingChair(key, 'set_buildspot')?.transpose_origin || null;
        if (origin && typeof origin.x === 'number' && !siteTreePhaseDone(key)) {
            jobs.push(...await siteTreesJob(key, origin, siteTreeBox(key === FARM_STRUCTURE ? field.design : key, origin)));
            treesStanding = treesStanding || !siteTreePhaseDone(key);
        }
    }

    const cluster = await farmingIntegrity.scanCluster(bot);

    // EVERY FARM JOB IS STAMPED WITH THE FARM — tend, dirt and seeds alike. The stamp sets the job's RANK,
    // at the farm's position in `STRUCTURE_PRIORITY` (job_ranking's measureSiteRank), and refuses nothing:
    // farm work is always posted and always claimable, just served after the structures ranked ahead of it
    // while any of their work is on the board. `built` is the farm's own verdict.
    // ONE FARMER PER CROP: a tend for the wheat fields and one for the cane fields, each one seat (`crop`, the seed, is
    // the plots farm_manager tends). The water pool is the wheat farmer's, the first crop sited.
    if (!treesStanding && cluster.located) {
        for (const crop of new Set(cluster.actionable_plots.filter(p => p.materials_ready).map(farmingIntegrity.tendCrop))) {
            jobs.push({ id: `farm_tend#${crop}`, type: 'farm', what: 'farm_tend', where: cluster.anchor, crop,
                job_type: JOB_TYPE.farm_tend, structure: FARM_STRUCTURE, scope: 'shared', claimed_by: null });
        }
    }

    // ── THE FARM'S DIRT ORDER ──────────────────────────────────────────────────
    // A row is built from pocket dirt. When the seeds can plant rows the pocket cannot lay, gather
    // exactly that gap INTO THE POCKET — the same shape as a build's bootstrap gather
    // (assessors/building), since the bot carries it straight to the water and never banks it. A chest
    // that holds dirt is drawn first (supply_manager withdraws for a pocket order before it digs). It is
    // posted even while no row is actionable — dirt is what makes one so.
    if (cluster.located && cluster.dirt_gap > 0) {
        const held = countInInventory('dirt', getBotInventory());
        jobs.push(supplyJob({
            id: 'farm_supply_dirt', what: 'dirt', need: cluster.dirt_gap, where: null,
            job_type: JOB_TYPE.farm_supply_dirt, structure: FARM_STRUCTURE, claimed_by: null,
            // ONE BODY CARRIES THE WHOLE ORDER: the dirt is laid from the pocket that gathered it, and a field lays one
            // row at a time (one farm_tend seat per crop). Split into trip-sized pledges, up to seven bodies each
            // gathered the field's dirt into its own pocket, and every pocket but the farmer's banked it to the pit.
            pledge_unit: cluster.dirt_gap,
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
    // this same field. One order per seed item: the wheat field sows wheat seeds, the cane fields sugar cane.
    // WILD CANE (architect_config WILD_CANE) is ONE body's errand, for the first cane field only: while its unsown slots
    // are more than the cane the fleet reaches (seed_gap), the order is one seat whose pledge is that gap, at most
    // WILD_CANE.pledge. Once the first field can be planted no wild cane is gathered: the fields grow the rest.
    const seedGaps = { ...(cluster.located ? cluster.seed_gap : {}) };
    if (seedGaps.sugar_cane > 0) seedGaps.sugar_cane = Math.min(seedGaps.sugar_cane, WILD_CANE.pledge);
    for (const [seed, gap] of Object.entries(seedGaps)) {
        if (gap <= 0) continue;
        const oneSeat = seed === 'sugar_cane' ? { pledge_unit: gap } : {};
        const chest = homeChest();
        if (chest) {
            jobs.push(supplyJob({
                id: seed === 'wheat_seeds' ? 'farm_supply_seeds' : `farm_supply_${seed}`, what: seed, need: gap,
                where: chest.station.pos, station_id: chest.id, destination: 'storage',
                job_type: JOB_TYPE.farm_supply_seeds, structure: FARM_STRUCTURE, claimed_by: null,
                hold_goal: gap, at_destination: cluster.seeds_reachable[seed],
                // One asker, delivered to a chest, so no pocket term: the field's own seed shortfall.
                parts: [{ who: `blueprint:${FARM_STRUCTURE}_${seed}`, amount: gap }],
                category: 'resource', action: 'deliver', scope: deliverScope(seed), ...oneSeat,
            }));
        } else {
            watcher.summary(TAG, `farm wants ${gap} ${seed} but no home chest is registered to deliver them to — no seed order.`);
        }
    }
    return { jobs, built: { [FARM_STRUCTURE]: cluster.built === true } };
}

module.exports = { name: 'farming', assess };
