// assessors/building — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const buildingIntegrity = require('@perception/building_integrity');
const hq = require('@kernel/corporate_headquarters');
const inventoryLens = require('@kernel/inventory_lens');
const watcher = require('@kernel/watcher');
const { blocksCompletion } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { getBotInventory } = require('@utils/fragment_utils');
const { homeChest } = require('@utils/fragment_utils');
const { remainingRawForBuild } = require('@utils/calculators/build_material_calculator');
const { underground_items: UNDERGROUND_ITEMS } = require('@utils/fragment_utils');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    BUILDING_REQUIREMENTS,
    TYPE_COORDINATES,
    TYPE_BLUEPRINT_PASTED,
    TYPE_STRUCTURE_COMPLETE,
    OPTIONAL_BUILD_MATERIALS,
} = require('@thinking/architect_config');

const { TAG, deliverScope, supplyJob } = require('@thinking/assessors/shared');
// ── SECTION 2 — Building (evaluates SECOND, Law 18) — pullNeeded + build job for first unsatisfied req ──
function assess() {
    const jobs = [];
    let pullNeeded = {};
    const surfaceNeeded = {};   // raw:totalPocketTarget — surface mats the build is short (logs)
    const bot = global.bot;

    // NOT the config table directly: a contractor walks only the rows a human has asked for, so it
    // builds nothing unbidden while running this identical ladder when it is asked (requested_work).
    const sorted = [...require('@thinking/requested_work').activeBuildingRequirements()]
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    let firstUnsatisfied = null;
    let materialsGated = false;
    // ── FULL MATERIALS OR NO JOB — materialsGated = post NO build job; a partial-materials route is
    // deliberately absent. The stall a partial route would address (anchor short one chain's material
    // freezing a stocked fleet) is answered in the BLUEPRINT instead: headframe shell (anchors 0-2) needs
    // only wood+dirt; stone sits in anchor 3 past the nightfall deadline. A partial pass does real damage:
    // preconstruction withdraws and crafts against a shortfall, abandoning mid-stage and overbuilding
    // low-priority pieces while the structure itself stays materially short.
    let buildAnchorIndex = null;   // which anchor the structure job builds (per-anchor gating)

    // Condition gate: `condition`-tagged requirement invisible until it holds; unknown token → default
    // stopped (Law 13). No live tokens today (the one past user was scrapped); gate stays for the next one.
    const conditionMet = (cond) => {
        if (!cond) return true;
        return false;   // unknown condition → default stopped
    };

    for (const req of sorted) {
        if (!conditionMet(req.condition)) continue;
        let satisfied = false;

        if (req.type === TYPE_COORDINATES) {
            const sb = hq.readBuildingChair(req.field, 'set_buildspot');
            satisfied = typeof sb?.build_center === 'object'
                     && sb.build_center !== null
                     && typeof sb.build_center.x === 'number';

        } else if (req.type === TYPE_BLUEPRINT_PASTED) {
            const bp = hq.readBuildingChair(req.field, 'blueprint_paster');
            satisfied = typeof bp === 'object' && bp !== null;

        } else if (req.type === TYPE_STRUCTURE_COMPLETE) {
            const bp = hq.readBuildingChair(req.field, 'blueprint_paster');
            if (typeof bp !== 'object' || bp === null) {
                satisfied = false;
            } else if (!bot || !bot.blockAt) {
                satisfied = false;
            } else {
                {
                    const bpName = req.blueprint_name || req.field;
                    const result = buildingIntegrity.scan(bot, bpName, req.field);
                    satisfied = result.all_complete === true;

                    if (!satisfied && firstUnsatisfied === null) {
                        // Gate on the NEXT incomplete anchor, never the whole build — whole-build gating can
                        // deadlock when the total material need across all anchors exceeds the supply cap
                        // even though each anchor is individually affordable. "Next" excludes optional-only
                        // anchors (torches), matching build_executor's anchorHasRequired — no disagreement.
                        // ONE credited pool (pocket + build-pool chests), built once, reused by gate and
                        // shortfall order — the SAME set preconstruction withdraws and building_manager
                        // credits (Law 16); three pools = ordering materials the build already has.
                        const pool = inventoryLens.buildPool(bpName);
                        const isAvailable = (item) => countInInventory(item, pool);

                        const hasAnchors = Array.isArray(result.anchor_status) && result.anchor_status.length > 0;
                        // "Next" = anchor still owing work that BLOCKS completion (blocksCompletion, Law 16):
                        // a dig, a required block, or an optional block (torch) the pool NOW holds — an
                        // unmakeable torch doesn't gate (shell builds without it); once on hand it becomes
                        // required, placed not orphaned (last-headframe-torch bug: optional-only anchor
                        // treated as permanently done).
                        // `unloaded_count`: an unsensed anchor owes NO steps, so the search would skip it —
                        // with ALL anchors unsensed this could mark the structure satisfied without the bot
                        // ever having come close enough to see it. Unsensed keeps it live → bot goes to
                        // look → chunk loads → real scan (Invariant B).
                        const nextAnchor = hasAnchors ? result.anchor_status.find(a =>
                            a.dig_count > 0 || a.unloaded_count > 0 ||
                            Object.entries(a.materials_needed).some(([k, c]) => c > 0 && blocksCompletion(k, c, OPTIONAL_BUILD_MATERIALS, isAvailable))
                        ) : null;
                        buildAnchorIndex = nextAnchor ? nextAnchor.anchor_index : null;

                        // Optional-only remainder doesn't gate: no anchor owing REQUIRED work = buildable
                        // work done. A lingering no_attach_point place step keeps all_complete false with
                        // nothing buildable — mark satisfied so planning moves on (twin of
                        // building_manager's replan gate).
                        if (hasAnchors && !nextAnchor) satisfied = true;

                        // materials_NEEDED (remaining voxels); remainingRawForBuild credits held
                        // INTERMEDIATES (32 planks offset a chest/door's planks), which raw
                        // materials_missing can't. Anchorless legacy blueprints → whole-build need.
                        const mm = hasAnchors
                            ? (nextAnchor ? (nextAnchor.materials_needed || {}) : {})
                            : (result.materials_needed || {});
                        // Optional materials don't gate — placed when available.
                        const remaining = Object.fromEntries(
                            Object.entries(mm).filter(([k, c]) => typeof c === 'number' && c > 0 && !OPTIONAL_BUILD_MATERIALS.has(k))
                        );

                        if (Object.keys(remaining).length > 0) {
                            // shortRaw IS the build's standing ORDER: true raw shortfall after crediting the
                            // one `pool` above — SAME calc preconstruction/building_manager use, so gate,
                            // order, withdraw agree (Law 16). Pool-scoped (not world-wide) so logs in an
                            // unreachable chest can't greenlight a build — the pool chests ARE what
                            // preconstruction reaches. Re-derived fresh each sweep (Invariant B).
                            // Underground → mining; surface → storage order (posted after the loop).
                            const shortRaw = remainingRawForBuild(remaining, pool);
                            if (Object.keys(shortRaw).length > 0) {
                                materialsGated = true;
                                for (const [raw, count] of Object.entries(shortRaw)) {
                                    if (UNDERGROUND_ITEMS.has(raw)) pullNeeded[raw] = count;
                                    else surfaceNeeded[raw] = count;   // deliver-amount = the gap (shortRaw)
                                }
                                // Route annotation (Law 6 — the split above is invisible otherwise).
                                const routeOf = (k) => UNDERGROUND_ITEMS.has(k) ? '→mine' : '→chest#1';
                                const shortList = Object.entries(shortRaw).map(([k, v]) =>
                                    `${k}:${v} [${routeOf(k)}]`).join(', ');
                                watcher.summary(TAG, `"${bpName}" anchor ${buildAnchorIndex} gated ` +
                                    `— order (short): ${shortList}`);
                            }
                        }
                    }
                }
            }
        }

        if (!satisfied && firstUnsatisfied === null) {
            firstUnsatisfied = req;
        }
    }

    // Coordinates/paster steps owned by the startup batch lock_all_buildspots (Law 16 — one pathway) —
    // locks every center in one pass. So this posts ONLY the STRUCTURE build: a coords/paster
    // firstUnsatisfied means base_layout (higher priority) is already on it; post nothing.
    if (firstUnsatisfied && !materialsGated && firstUnsatisfied.type === TYPE_STRUCTURE_COMPLETE) {
        const bc = hq.readBuildingChair(firstUnsatisfied.field, 'set_buildspot')?.build_center || null;

        // Distinct job_id per anchor → two bots build two anchors at once via existing Phase-3 claims.
        const withAnchor = buildAnchorIndex != null;
        // 'shared' — ONE structure per building; the magnet dedups WHO builds it.
        jobs.push({
            id:   `build_${firstUnsatisfied.execute_key || firstUnsatisfied.field}${withAnchor ? `_anchor_${buildAnchorIndex}` : ''}`,
            type: 'build',
            what: firstUnsatisfied.execute_key || firstUnsatisfied.field,
            where: bc,
            // Per-building rank: a requirement may name its own JOB_TYPE key (how the headframe
            // outranks other structures); unnamed → default tier.
            job_type: JOB_TYPE[firstUnsatisfied.job_type] ?? JOB_TYPE.building_structure,
            claimed_by: null,
            step: firstUnsatisfied.type,
            scope: 'shared',
            ...(withAnchor ? { anchor_index: buildAnchorIndex } : {}),
        });
    }

    // Build-material ORDER: surface-raw shortfall → headframe chest as a restock-DELIVER job
    // (reuses supply_manager Steps 0/1 → delivery_executor). scope via deliverScope — raw='local', every
    // idle bot fills at once. Ranked one step BELOW its own build: a bot holding materials builds;
    // chest-fill runs only when pocket+chest fall short. Gate/order/withdraw read one pool → a partial fill
    // flips the build actionable and this stops posting — one pool, no lock.
    // DYNAMIC vs STANDING: standing STOCK rows (`logs: keep 50`) never finish; this is computed fresh per
    // sweep and stops when the gap closes. A dynamic order tied to the same rank as a standing shelf-level
    // row can lose ties to it even though it is the more urgent of the two — `supply_job_type` on the
    // requirement lifts this one above that; unnamed keeps the old standing rank.
    // BOOTSTRAP: before the storage chest exists (the early frame ERECTS it) gather to POCKET via the
    // old build_supply path (P4/local) — a build can't gate on a chest it hasn't built. Both rows state a
    // POCKET LEVEL (see THE QUANTITY CONTRACT) but compute it differently on purpose: the deliver row
    // ignores what the pocket already holds, because the pocket is not fulfillment for a storage row; the
    // bootstrap row delivers INTO the pocket and so counts it.
    const poolChest = homeChest();
    const supplyJobType = JOB_TYPE[firstUnsatisfied?.supply_job_type] ?? JOB_TYPE.resource_chest_restock;
    const postedOrders = [];   // for the confirmation log — the dynamic request must be visible (Law 6)
    for (const [raw, gap] of Object.entries(surfaceNeeded)) {
        if (gap <= 0) continue;
        // The order is a SEPARATE job from its build: building_structure is night-gated but this defaults
        // to resource_chest_restock (not gated) — fleet could gather at night for a wall unplaceable until
        // dawn. Headframe's order is exempt by job type (building_headframe_supply) — the point of that exemption.
        if (poolChest) {
            jobs.push(supplyJob({
                id: `build_chest_${raw}`, what: raw, need: gap,
                where: poolChest.station.pos,
                // `homeChest()` hands back { id, station } and this job used only the position, so the
                // key had to be rebuilt downstream from coordinates — and the rebuild lost the owner half
                // `station_registry.stationKey` appends, abandoning every delivery (fixed 2026-09-10; see
                // `supply_manager._dispatchDelivery`). Carry the key that was already in hand.
                station_id: poolChest.id,
                destination: 'headframe',
                job_type: supplyJobType,
                claimed_by: null,
                hold_goal: gap, at_destination: 0,
                // surfaceNeeded is raw today → 'local'; predicate called anyway so a future craftable moves
                // scope with it — hardcoded 'local' would silently authorise duplicate crafts (Law 25).
                category: 'resource', action: 'deliver', scope: deliverScope(raw),
            }));
            postedOrders.push(`build_chest_${raw} deliver ${gap}→headframe#1`);
        } else {
            jobs.push(supplyJob({
                id: `build_supply_${raw}`, what: raw, need: gap,
                where: null,
                job_type: JOB_TYPE.resource_baseline,
                claimed_by: null,
                hold_goal: countInInventory(raw, getBotInventory()) + gap,
                at_destination: countInInventory(raw, getBotInventory()),
                category: 'resource', scope: 'local',
            }));
            postedOrders.push(`build_supply_${raw} gather ${gap}→pocket (bootstrap)`);
        }
    }
    // Confirms the dynamic build-order fired (Law 6) — board render can't tell it from standing restocks.
    if (postedOrders.length) {
        watcher.summary(TAG, `↳ dynamic build-order posted: ${postedOrders.join(' | ')}`);
    }

    // THE BUILD LAYER'S CLAIM, DECLARED SO THE LAYERS ABOVE CAN SUBTRACT IT. The storage chest sits
    // one layer up and may not count material this build has already spoken for, so the claim has to
    // leave this assessor rather than stay implicit in the jobs it posted. Both routes are the same
    // claim wearing different delivery addresses — a surface gap fills from the chest, an underground
    // one from the mine — and the layer above is short by the sum either way.
    // It is the SHORTFALL, not the requirement: material the build already holds is in `everything`
    // and would be subtracted twice if the whole requirement were filed here.
    const buildClaim = { ...pullNeeded, ...surfaceNeeded };

    return { jobs, pullNeeded, buildClaim };
}

module.exports = { name: 'building', assess };
