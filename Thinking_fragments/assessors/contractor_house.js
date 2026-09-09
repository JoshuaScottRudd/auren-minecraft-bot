// assessors/contractor_house — the shelter and kit a contractor builds for itself.
//
// WHY THIS IS ITS OWN ASSESSOR AND NOT A ROW IN BUILDING_REQUIREMENTS. That table is walked as ONE
// ordered list and posts only its FIRST unsatisfied requirement, so it can carry exactly one building's
// worth of live work for the whole fleet. Both placements of this building inside it are broken, and in
// opposite directions:
//   - BELOW the headframe: the headframe's structure step stays unsatisfied for a long time and is
//     therefore always the first unsatisfied one, so the list never reaches this building at all. The
//     job posted instead sits in the `blueprint` band, which the contractor's magnet passes over — a
//     contractor would idle forever beside a house it is never offered.
//   - ABOVE the headframe: this building becomes the first unsatisfied requirement for EVERY body,
//     and a reader whose magnet does not attract it takes nothing while the list refuses to advance
//     past it — the headframe would never post.
// A single first-unsatisfied cursor cannot express "two buildings, different readers". A second
// assessor can, because the board assembles every assessor's jobs and the MAGNET decides who may hold
// each one — which is the design's own answer (one board, filtered at the reader). The farm is the
// standing precedent: it is a building with its own assessor for the same structural reason.
//
// THIS FILE COMPUTES NOTHING OF ITS OWN. The integrity scan, the pool, the shortfall walk and the
// supply-job constructor are the same ones the other build path calls (Law 16) — what is written here
// is only WHICH building is being asked about and WHERE its shortfall is routed.
//
// SINGLE-ANCHOR, AND THAT IS WHY THIS STAYS SHORT. The multi-anchor deadline machinery in the other
// build assessor exists because one blueprint's shell must stand before nightfall while its interior
// waits on ore. This blueprint declares one anchor, so there is no anchor to choose between and no
// per-anchor gate to state; the "next blocking anchor" walk below is kept anyway because it is what
// decides that only OPTIONAL work remains, which is a different question from "is it complete".

'use strict';

const buildingIntegrity = require('@perception/building_integrity');
const inventoryLens = require('@kernel/inventory_lens');
const watcher = require('@kernel/watcher');
const { blocksCompletion, remainingRawForBuild } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const {
    getBotInventory,
    readBuildCenter,
    underground_items: UNDERGROUND_ITEMS,
} = require('@utils/fragment_utils');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    TYPE_STRUCTURE_COMPLETE,
    OPTIONAL_BUILD_MATERIALS,
} = require('@thinking/architect_config');

const { TAG, supplyJob } = require('@thinking/assessors/shared');

// The blueprint name IS the conference-room key. A building with one instance has no reason to hold two
// names, and the pair only diverges where a blueprint is instanced (the farm's `#N` keys).
const BLUEPRINT = 'contractor_house';

function assess() {
    const jobs = [];
    const bot = global.bot;
    if (!bot || !bot.blockAt) return { jobs };

    // SITING IS NOT THIS ASSESSOR'S WORK AND MUST NOT BECOME IT. The base-layout batch locks every
    // build_center in one pass, and it is the only thing holding the whole layout's non-overlap picture
    // at once — a locate call from here would see the locked buildings but not the ones that batch is
    // still surveying. Unsited is therefore an ordinary early state, not a fault: ask, and post nothing.
    const center = readBuildCenter(BLUEPRINT);
    if (!center) return { jobs };

    const result = buildingIntegrity.scan(bot, BLUEPRINT, BLUEPRINT);
    if (result.all_complete === true) return { jobs };

    // ONE credited pool for the gate and the order alike — the same set preconstruction withdraws from
    // (Law 16). Three pools would order material the build is already standing on.
    const pool = inventoryLens.buildPool(BLUEPRINT);
    const isAvailable = (item) => countInInventory(item, pool);

    // The next anchor owing work that BLOCKS completion. An optional material (a torch) the pool does
    // not hold does not block: the shell stands without it and it is placed once it exists. `unloaded_count`
    // keeps an unsensed anchor live so the bot goes and looks rather than believing a scan it never took
    // (Invariant B).
    const anchors = Array.isArray(result.anchor_status) ? result.anchor_status : [];
    const nextAnchor = anchors.find(a =>
        a.dig_count > 0 || a.unloaded_count > 0 ||
        Object.entries(a.materials_needed || {}).some(([k, c]) =>
            c > 0 && blocksCompletion(k, c, OPTIONAL_BUILD_MATERIALS, isAvailable))
    ) || null;

    // Anchors exist and none of them blocks: every remaining voxel is optional, so the buildable work is
    // done even though the scan will keep reporting incomplete. Posting here would spin.
    if (anchors.length > 0 && !nextAnchor) return { jobs };

    const materialsNeeded = nextAnchor ? (nextAnchor.materials_needed || {}) : (result.materials_needed || {});
    const remaining = Object.fromEntries(
        Object.entries(materialsNeeded).filter(([k, c]) =>
            typeof c === 'number' && c > 0 && !OPTIONAL_BUILD_MATERIALS.has(k))
    );
    const shortRaw = Object.keys(remaining).length > 0 ? remainingRawForBuild(remaining, pool) : {};

    // ── SHORT OF MATERIAL — ORDER IT, POST NO BUILD ────────────────────────────────────────────────
    // Full materials or no build job. A part-load dispatch walks a body out to place what little it holds
    // and burns the rest on byproducts the blueprint never asked for, and the manager runs this same
    // shortfall again at dispatch time — so both would have to agree anyway (Law 16).
    if (Object.keys(shortRaw).length > 0) {
        const pullNeeded = {};
        const inventory = getBotInventory();
        const ordered = [];
        for (const [raw, gap] of Object.entries(shortRaw)) {
            if (gap <= 0) continue;
            // THE SPLIT IS BY WHO CAN PRODUCE IT, NOT BY WHERE IT IS ORDERED FROM. An underground
            // material has no producer a lone body on the surface can reach, so a gather job for one is
            // a job that can only be refused — it belongs to the descent, which reads the pull list.
            if (UNDERGROUND_ITEMS.has(raw)) { pullNeeded[raw] = gap; ordered.push(`${raw}:${gap} [→mine]`); continue; }
            // GATHERED TO THE POCKET, NEVER DELIVERED TO A CHEST, and that is the difference between this
            // building and the fleet's estate. The body that builds this is the body that lives in it, and
            // a contractor is not guaranteed a shared chest to stage material through — a delivery order
            // would route its own shelter's material into storage it may not be able to reach back into.
            jobs.push(supplyJob({
                id: `contractor_house_supply_${raw}`, what: raw, need: gap,
                where: null,
                job_type: JOB_TYPE.resource_baseline,
                claimed_by: null,
                hold_goal: countInInventory(raw, inventory) + gap,
                at_destination: countInInventory(raw, inventory),
                category: 'resource', scope: 'local',
            }));
            ordered.push(`${raw}:${gap} [→pocket]`);
        }
        // A silent shortfall reads exactly like a building nobody wanted (Law 6): the board shows no build
        // job and nothing says why. One line with the split named is the whole difference.
        watcher.summary(TAG, `"${BLUEPRINT}" anchor ${nextAnchor ? nextAnchor.anchor_index : 0} gated ` +
            `— order (short): ${ordered.join(', ')}`);
        // buildClaim: material this build has spoken for, so the storage layer above does not count it
        // twice. It is the SHORTFALL and not the requirement — what the build already holds is in the pool.
        return { jobs, pullNeeded, buildClaim: { ...pullNeeded, ...shortRaw } };
    }

    // ── FULLY STAGED — POST THE BUILD ──────────────────────────────────────────────────────────────
    // 'shared': one house, so one owner (Invariant D). The magnet dedups WHICH body takes it.
    jobs.push({
        id: `build_contractor_house_execute${nextAnchor ? `_anchor_${nextAnchor.anchor_index}` : ''}`,
        type: 'build',
        what: 'contractor_house_execute',
        where: center,
        job_type: JOB_TYPE.building_contractor_house,
        claimed_by: null,
        step: TYPE_STRUCTURE_COMPLETE,
        scope: 'shared',
        ...(nextAnchor ? { anchor_index: nextAnchor.anchor_index } : {}),
    });
    return { jobs };
}

module.exports = { name: 'contractor_house', assess };
