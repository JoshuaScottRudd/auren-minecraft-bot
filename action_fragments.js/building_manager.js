// building_manager.js
// Load-bearing manager. Reads the build job from the bot's magnet,
// dispatches to the correct executor, loops via recursive_judge stamp
// until the structure is complete.
//
// RECIPES maps job keys to executor fragments. The job's `what` field
// (from job_board) is the recipe key.

'use strict';

const watcher          = require('@kernel/watcher');
const hq               = require('@kernel/corporate_headquarters');
const buildingIntegrity = require('@perception/building_integrity');
const inventoryLens = require('@kernel/inventory_lens');
const { affordableNow } = require('@utils/calculators/build_material_calculator');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const jobExclusions = require('@thinking/job_exclusions');

const TAG = 'building_manager';

// anchorBuildableNow — what the claimed anchor can build from the pool right now, as { item: count },
// crediting the bot's pocket plus the build pool chests (inventoryLens.buildPool, the pool the assessor
// gates on and preconstruction withdraws from). It is a load, not a gate: an empty answer means "stage
// nothing", and the executor reports what it actually finds; whether the job may run is asked exactly
// once, in assessors/building. The map travels to preconstruction as `buildable`, which stages exactly
// that load and no more.
//
// Narrows to the claimed anchor's lowest course still owing blocks (job_board's nextAnchor picks the
// anchor), or its placeable cells on a pledge-approved plan (blueprint_registry.isPledgeApproved), then
// asks the same affordability question building_integrity and assessors/building already ask, so all
// three agree on what "can build" means (Law 16). The whole-anchor bill still sizes the shortfall order;
// only the build itself is coursed.
function anchorBuildableNow(integrity, anchorIndex, blueprintName, excluded) {
    const st = anchorIndex != null ? integrity?.anchor_status?.[anchorIndex] : null;
    const pledged = require('@kernel/blueprint_registry').isPledgeApproved(blueprintName);
    const mNeeded = st
        ? (pledged ? st.materials_needed_placeable : st.materials_needed_lowest_y)
        : (integrity?.materials_needed || {});
    const remaining = Object.fromEntries(
        Object.entries(mNeeded || {}).filter(([k, c]) => typeof c === 'number' && c > 0 && !jobExclusions.excludes(excluded, k))
    );
    return affordableNow(remaining, inventoryLens.buildPool(blueprintName), require('@perception/station_registry').stationUsable);
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPES — maps job_board `what` keys to execution fragments. lock_all_buildspots locates and locks
// every base transpose_origin at startup; building_manager owns only the structure build, dispatching
// preconstruction against the already-locked center. Keys match BUILDING_REQUIREMENTS execute_key
// exactly (field == recipe-key == blueprint).
// ─────────────────────────────────────────────────────────────────────────────
const RECIPES = {
    headframe_execute: {
        fragment:       'preconstruction',
        blueprint_name: 'headframe',
    },
    contractor_house_execute: {
        fragment:       'preconstruction',
        blueprint_name: 'contractor_house',
    },
    laydown_yard_execute: {
        fragment:       'preconstruction',
        blueprint_name: 'laydown_yard',
    },
    waste_pit_execute: {
        fragment:       'preconstruction',
        blueprint_name: 'waste_pit',
    },
};

// ─────────────────────────────────────────────────────────────────────────────

// Release back to recursive_judge after all build passes. No dumpExcess here: offloading is a single
// job_board job (inventory_dump), fired only when the pocket is nearly full (Law 16: one offload route).
// Keeping build byproducts in pocket between passes is fine: the next pass has the materials on hand.
function _release(reason) {
    watcher.summary(TAG, `Releasing: ${reason}`);
    routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

module.exports = {
    receive: watcher.track(TAG, async function (signalType, payload) {
        if (signalType !== TAG) return;

        const botId = process.env.BOT_ID || 'default';
        const magnet = hq.readBoardroomChair(botId, {})?.magnet;

        if (!magnet || !magnet.what) {
            _release('no active magnet');
            return;
        }

        const jobKey = magnet.what;
        const recipe = RECIPES[jobKey];

        if (!recipe) {
            _release(`no recipe for '${jobKey}'`);
            return;
        }

        // De-confliction note: WHICH bot runs this job is settled upstream by the
        // magnet under the planning token (task identity — see the taxonomy in
        // foreman_brain.js), and an established buildspot is fleet-shared via the
        // building_conference broadcast, so a peer adopts the home instead of
        // finding a duplicate. No arbiter claim belongs here — a buildspot is a
        // task outcome, not a physical object being contested.

        // job_board is the one place that decides whether a build may run (Law 16: accountability is not
        // split between two verifiers). This manager turns a job key into a dispatch; it still computes
        // `buildable`, but only as the LOAD preconstruction stages, never as a verdict on whether the job
        // should run. If the pool moved since planning, the honest report is what the executor finds after
        // trying. If a posted build cannot proceed, job_board is what gets fixed.
        // A pledge pass that found every cell held or none payable has finished this body's part of the
        // job; the board, not another pass, decides what it does next.
        const lastPass = payload?.executor === 'build_executor' ? payload?.build_executor?.result : null;
        // A pass that found the structure complete (a peer placed the last block) ends the job outright.
        if (lastPass === 'all_complete') {
            _release(`${jobKey} — the structure is complete; handing back to the board`);
            return;
        }
        if (typeof lastPass === 'string' && /^(no_payable_cell|cells_held_by_peers)\(/.test(lastPass)) {
            const m = payload.build_executor.metrics || {};
            _release(`${jobKey} — ${lastPass} after placing ${m.place_ok || 0} and digging ${m.dig_ok || 0}; `
                + `this body's pledge is spent, handing back to the board`);
            return;
        }

        let buildable = null;   // preconstruction's load, not a gate
        if (recipe.fragment === 'preconstruction') {
            const integrity = await buildingIntegrity.scan(
                global.bot, recipe.blueprint_name, recipe.blueprint_name, { quiet: true });

            buildable = anchorBuildableNow(integrity, magnet.anchor_index, recipe.blueprint_name, magnet.excluded);
        }

        const next = {
            ...payload,
            manager:        TAG,
            blueprint_name: recipe.blueprint_name,
            readable:       `${TAG}: ${jobKey} → ${recipe.fragment} (${recipe.blueprint_name})`,
        };
        if (magnet.anchor_index != null) next.anchor_index = magnet.anchor_index;
        if (buildable) next.buildable = buildable;
        // THE EXCLUSION LIST TRAVELS WITH THE WORK, off the magnet the dispatcher froze it onto. This
        // manager does not decide it and does not announce it — it hands the board's answer to the
        // executor that will act on it, which is the whole of its part in the arrangement.
        if (magnet.excluded) next.excluded = magnet.excluded;

        watcher.summary(TAG, `Dispatching ${recipe.fragment} for '${jobKey}'`);
        routeSignal(TAG, recipe.fragment, next);
    }),
};
