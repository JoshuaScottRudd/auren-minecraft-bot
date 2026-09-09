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
const { remainingRawForBuild, blocksCompletion } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const { OPTIONAL_BUILD_MATERIALS } = require('@thinking/architect_config');

const TAG = 'building_manager';

// anchorRawShortfall — the raw materials the claimed anchor is still short, crediting the bot's
// pocket + THIS building's own staging chests. This is the SAME gate `assessors/building` runs
// before ever posting the build job (shared remainingRawForBuild calc — Law 16); replayed here at
// DISPATCH time because the pocket is fluid between planning and dispatch (the bot burns planks
// pillaring as it moves), so a job greenlit a cycle ago can arrive materials-short. Returns a
// { raw: count } shortfall map — empty when the anchor is fully staged and may be dispatched.
//
// ── SHORT MEANS UNBUILDABLE, AND THAT IS THE WHOLE GATE ─────────────────────────────────────────────
// A part-load route once released an anchor whenever it could do SOMETHING, walking a bot out to place
// what little it had. It was made unnecessary by separating anchors that mix material types from ones
// that don't, so an anchor's owed materials are now homogeneous and "full materials before dispatch"
// is a coherent gate again — mixed-type anchors no longer freeze a fleet stocked in only one type
// behind a chain that hasn't delivered. Partial dispatch's real cost was structural, not incidental: a
// part-load withdraw-craft-abandon cycle mid-stage burns materials on byproducts the blueprint never
// asked for. This gate and job_board's both say NO on any shortfall, so they cannot disagree and there
// is no post → bounce → post spin to defend against (Law 16 — one rule, one answer).
function anchorRawShortfall(integrity, anchorIndex, blueprintName) {
    const st = anchorIndex != null ? integrity?.anchor_status?.[anchorIndex] : null;
    const mNeeded = st ? st.materials_needed : (integrity?.materials_needed || {});
    const remaining = Object.fromEntries(
        Object.entries(mNeeded || {}).filter(([k, c]) => typeof c === 'number' && c > 0 && !OPTIONAL_BUILD_MATERIALS.has(k))
    );
    // No material owed (a dig-only anchor, or one fully placed) — nothing to be short of, so it goes.
    if (Object.keys(remaining).length === 0) return {};

    // Credit the one pool: pocket + the build pool chests (own chests ∪ headframe chest — the
    // shared base pool). buildPoolChestCounts is the SAME set job_board's gate credits and preconstruction
    // withdraws from (Law 16), so a chest-less build (tree farm) is gated against the headframe chest
    // it actually draws from, not an empty own-chest set.
    return remainingRawForBuild(remaining, inventoryLens.buildPool(blueprintName));
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPES — maps job_board `what` keys → execution fragments.
//
// LOCATING is no longer here: the lazy per-blueprint find route (a `find_buildingspot` recipe per
// blueprint) is RETIRED as a redundant pathway (Law 16) — lock_all_buildspots locates and
// locks every base build_center in one startup pass. building_manager now owns only the STRUCTURE build:
// each `<blueprint>_execute` key dispatches preconstruction against the already-locked center. Keys match
// BUILDING_REQUIREMENTS execute_key exactly (field == recipe-key == blueprint).
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
};

// ─────────────────────────────────────────────────────────────────────────────

// Release back to recursive_judge after all build passes. NO dumpExcess here: offloading is a single
// job_board job (inventory_dump), fired only when the pocket is nearly full — a second offload route
// here would be a redundant pathway (Law 16). Keeping build byproducts in pocket between passes is
// fine — even preferable, since the next pass has the materials on hand rather than re-gathering.
function _release(signalBus, reason) {
    watcher.summary(TAG, `Releasing: ${reason}`);
    routeToJudge(signalBus, TAG, { readable: `${TAG}: ${reason}` });
}

module.exports = {
    receive: watcher.track(TAG, async function (signalType, payload) {
        if (signalType !== TAG) return;
        const signalBus = require('@kernel/signal_bus');

        const botId = process.env.BOT_ID || 'default';
        const magnet = hq.readBoardroomChair(botId, {})?.magnet;

        if (!magnet || !magnet.what) {
            _release(signalBus, 'no active magnet');
            return;
        }

        const jobKey = magnet.what;
        const recipe = RECIPES[jobKey];

        if (!recipe) {
            _release(signalBus, `no recipe for '${jobKey}'`);
            return;
        }

        // De-confliction note: WHICH bot runs this job is settled upstream by the
        // magnet under the planning token (task identity — see the taxonomy in
        // overseer_brain.js), and an established buildspot is fleet-shared via the
        // building_conference broadcast, so a peer adopts the home instead of
        // finding a duplicate. No arbiter claim belongs here — a buildspot is a
        // task outcome, not a physical object being contested.

        // For build jobs: verify structure still needs work before dispatching.
        // Without this gate, a completed structure causes an infinite loop:
        // preconstruction → build_executor reports all_complete → recursive_judge →
        // back here → magnet still says execute → re-dispatch → loop.
        if (recipe.fragment === 'preconstruction') {
            const integrity = buildingIntegrity.scan(
                global.bot, recipe.blueprint_name, recipe.blueprint_name, { quiet: true });
            if (integrity?.all_complete) {
                _release(signalBus,
                    `'${jobKey}' structure already complete — nothing to build`);
                return;
            }

            // Per-anchor replan gate. In gated mode the magnet names ONE anchor. Once that anchor no
            // longer owes work that BLOCKS completion, a build pass can't advance it — but the structure
            // isn't done (another anchor still owes work). Re-dispatching the same anchor just churns
            // (build_executor → blocked_remainder → judge → here → repeat) until the 3-strike forces
            // job_board. Release NOW so job_board re-picks the next anchor. This MUST use the identical
            // blocksCompletion rule (and the identical pool) as job_board's nextAnchor (Law 16) — if this
            // gate treated the torch anchor as "no work" while job_board posted it, the two would desync:
            // job_board posts → this bounces → job_board re-posts → spin, never a placed torch.
            if (magnet.anchor_index != null) {
                const st = integrity?.anchor_status?.[magnet.anchor_index];
                const pool = inventoryLens.buildPool(recipe.blueprint_name);
                const isAvailable = (item) => countInInventory(item, pool);
                // `unloaded_count` is here for the same reason it is in job_board's nextAnchor, and MUST
                // stay in lockstep with it (the Law 16 desync this comment already warns about): an
                // unsensed anchor owes no steps, so without the clause this gate calls it finished and
                // releases while job_board — which now keeps it live — immediately re-posts it.
                const owesWork = !!st && (st.dig_count > 0 || st.unloaded_count > 0 ||
                    Object.entries(st.materials_needed).some(([k, c]) => c > 0 && blocksCompletion(k, c, OPTIONAL_BUILD_MATERIALS, isAvailable)));
                if (!owesWork) {
                    _release(signalBus,
                        `'${jobKey}' anchor ${magnet.anchor_index} has no gating work left — replanning for the next anchor`);
                    return;
                }
            }

            // Materials-staging gate: do NOT dispatch preconstruction for an
            // anchor whose raw materials aren't actually staged. Before this gate, a job greenlit while
            // materials looked sufficient but arriving short (fluid pocket) sent preconstruction into a
            // soft-fail that building_manager re-dispatched on the same anchor — a rapid 3x spin that
            // recursive_judge eventually broke by replanning, but only after tripping the trace flags.
            // Releasing to job_board HERE lets assessors/building re-gate (same calc, Law 16), see the
            // shortfall, and post the supply job that gathers it — one clean handoff, no spin.
            const shortfall = anchorRawShortfall(integrity, magnet.anchor_index, recipe.blueprint_name);
            if (Object.keys(shortfall).length > 0) {
                const shortList = Object.entries(shortfall).map(([k, v]) => `${k}:${v}`).join(', ');
                _release(signalBus,
                    `'${jobKey}' anchor ${magnet.anchor_index ?? 'whole'} not materials-staged ` +
                    `(short ${shortList}) — replanning so job_board posts the supply job`);
                return;
            }
        }

        const next = {
            ...payload,
            manager:        TAG,
            blueprint_name: recipe.blueprint_name,
            readable:       `${TAG}: ${jobKey} → ${recipe.fragment} (${recipe.blueprint_name})`,
        };
        if (magnet.anchor_index != null) next.anchor_index = magnet.anchor_index;

        watcher.summary(TAG, `Dispatching ${recipe.fragment} for '${jobKey}'`);
        routeSignal(signalBus, TAG, recipe.fragment, next);
    }),
};
