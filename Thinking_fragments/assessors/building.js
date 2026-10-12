// assessors/building — the STRUCTURE assessor: build job for the first unsatisfied requirement, plus
// the material pull it creates. See assessor_registry.

'use strict';

const buildingIntegrity = require('@perception/building_integrity');
const blueprintRegistry = require('@kernel/blueprint_registry');
const hq = require('@kernel/corporate_headquarters');
const inventoryLens = require('@kernel/inventory_lens');
const watcher = require('@kernel/watcher');
const { blocksCompletion } = require('@utils/calculators/build_material_calculator');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { getBotInventory } = require('@utils/fragment_utils');
const { homeChest } = require('@utils/fragment_utils');
const { remainingRawForBuild, affordableNow } = require('@utils/calculators/build_material_calculator');
const { stationUsable } = require('@perception/station_registry');

// peerPrepUnits(roomKey, anchorIndex) → { item: units } — the crafted units of this anchor a peer holds
// the `prep:` claim for (preconstruction's key), read from the broadcast boardroom the way the tree
// census reads `tree:` claims. This body's own claims are not counted: the question is room for IT.
function peerPrepUnits(roomKey, anchorIndex) {
    const prefix = `prep:${roomKey}:${anchorIndex}:`;
    const selfId = process.env.BOT_ID || 'default';
    const units = {};
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
        if (botId === selfId) continue;
        for (const key of Object.keys(chair?.active_claims || {})) {
            if (!key.startsWith(prefix)) continue;
            const type = key.slice(prefix.length).split(':')[0];
            units[type] = (units[type] || 0) + 1;
        }
    }
    return units;
}
const { isUnderground } = require('@utils/fragment_utils');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
    BUILDING_REQUIREMENTS,
    TYPE_COORDINATES,
    TYPE_BLUEPRINT_PASTED,
    TYPE_STRUCTURE_COMPLETE,
} = require('@thinking/architect_config');

const { TAG, deliverScope, supplyJob, siteTreeBox, siteTreePhaseDone, siteTreesJob } = require('@thinking/assessors/shared');
const jobExclusions = require('@thinking/job_exclusions');
// Each structure's verdict as this body last read it with the whole structure in sight (field → built).
const _lastSeenBuilt = new Map();
// ── SECTION 2 — Building (evaluates SECOND, Law 18) — pullNeeded + build job for first unsatisfied req ──
async function assess({ excluded } = {}) {
    // The set every completeness test below is measured against: what the board says the fleet
    // cannot get, handed down from job_board's per-sweep measurement. An absent list means nothing
    // is excluded — the safe reading.
    const optional = new Set(jobExclusions.names(excluded));
    const jobs = [];
    let pullNeeded = {};
    const surfaceNeeded = {};   // raw:totalPocketTarget — surface mats the build is short (logs)
    const bot = global.bot;

    // Reads requested_work, not the config table directly: a contractor builds only rows asked for,
    // running this same ladder once asked.
    const sorted = [...require('@thinking/requested_work').activeBuildingRequirements()]
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    let firstUnsatisfied = null;
    let materialsGated = false;
    // ── BUILD IF ANYTHING CAN BE BUILT, ON THE LOWEST UNFINISHED ANCHOR ──────────
    // materialsGated = post NO build job — set only when the lowest unfinished anchor has nothing the
    // pool can pay for and nothing to dig. Short of some materials but able to place others, the build
    // job posts and the shortfall order posts beside it: one bot places what the pool holds, the rest
    // fetch the remainder. Anchor 2 never posts before anchor 1 owes nothing — `nextAnchor` is the
    // FIRST owing anchor. Safety of the part-load: build_material_calculator.affordableNow.
    let buildAnchorIndex = null;   // which anchor the structure job builds (per-anchor gating)
    // ── HOW MANY BODIES THIS BUILD CAN HOLD, ON A PLEDGE-APPROVED PLAN ─────────
    // Null on every blueprint without a labelled plan, and the job posts as it always does. On a
    // labelled plan it is the count of cells whose support already stands — one pledge seat each
    // (see placeableNow).
    let buildPledgeSeats = null;
    // Each structure's own built verdict, keyed by its field, read by job_board's built-change announcement
    // and by the built gate. Only the STRUCTURE_COMPLETE rung speaks for "built"; siting and pasting are
    // rungs on the way there.
    const built = {};

    // Condition gate: a `condition`-tagged requirement stays invisible until it holds; an unknown token
    // defaults to stopped (Law 13). No live tokens currently use it; the gate stays ready for the next one.
    const conditionMet = (cond) => {
        if (!cond) return true;
        return false;   // unknown condition → default stopped
    };

    for (const req of sorted) {
        if (!conditionMet(req.condition)) continue;
        let satisfied = false;

        if (req.type === TYPE_COORDINATES) {
            const sb = hq.readBuildingChair(req.field, 'set_buildspot');
            satisfied = typeof sb?.transpose_origin === 'object'
                     && sb.transpose_origin !== null
                     && typeof sb.transpose_origin.x === 'number';

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
                    const result = await buildingIntegrity.scan(bot, bpName, req.field);
                    // A structure this body cannot see whole is not judged: its verdict stays the one this
                    // body last read with the structure in sight, and no build job is offered for it. One
                    // never seen built holds the ladder there, posting nothing.
                    if (result.unseen) {
                        built[req.field] = _lastSeenBuilt.get(req.field) === true;
                        if (built[req.field]) continue;
                        break;
                    }
                    satisfied = result.all_complete === true;
                    _lastSeenBuilt.set(req.field, satisfied);

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
                        // "Next" = an anchor still owing work that BLOCKS completion (blocksCompletion,
                        // Law 16): a dig, a required block, or an optional block (torch) the pool NOW
                        // holds. An unmakeable torch doesn't gate — the shell builds without it — but once
                        // affordable it becomes required and placed, not orphaned.
                        // `unloaded_count`: an unsensed anchor owes NO steps, so the search would skip it —
                        // with ALL anchors unsensed this could mark the structure satisfied without the bot
                        // ever having come close enough to see it. Unsensed keeps it live → bot goes to
                        // look → chunk loads → real scan (Invariant B).
                        const nextAnchor = hasAnchors ? result.anchor_status.find(a =>
                            a.dig_count > 0 || a.unloaded_count > 0 ||
                            Object.entries(a.materials_needed).some(([k, c]) => c > 0 && blocksCompletion(k, c, optional, isAvailable))
                        ) : null;
                        buildAnchorIndex = nextAnchor ? nextAnchor.anchor_index : null;
                        // ── A PLEDGE-APPROVED PLAN POSTS ONE SEAT PER PLACEABLE CELL ──
                        // The label is the blueprint's, read through the one accessor that owns it, so the
                        // board, the manager and the executor cannot disagree about which plans this covers.
                        // Counted here, where `nextAnchor` is already in scope.
                        //
                        // ── AND THE SEAT COUNT IS CAPPED BY WHAT THE POOL CAN PAY FOR ────────────────
                        // A cell nobody can pay for is not a pledge anybody may claim. Uncapped, the board
                        // would advertise seats the pool cannot back, sending bodies to the yard to report
                        // pocket_short and replan. `affordableNow` is the SAME answer the build gate below
                        // and building_manager's staging read, off the same pool, so the seat count cannot
                        // promise work the dispatch would then refuse (Law 16).
                        // A crafted unit a peer already holds the `prep:` claim for is on its way; it is
                        // no seat for another body, which would find every unit taken and walk out empty.
                        const peerHeld = nextAnchor && blueprintRegistry.isPledgeApproved(bpName)
                            ? peerPrepUnits(req.field, nextAnchor.anchor_index) : {};
                        const lessPeerHeld = (bill) => Object.fromEntries(Object.entries(bill || {})
                            .map(([k, c]) => [k, typeof c === 'number' ? c - (peerHeld[k] || 0) : c]));
                        if (nextAnchor && blueprintRegistry.isPledgeApproved(bpName)) {
                            const placeableBill = Object.fromEntries(
                                Object.entries(lessPeerHeld(nextAnchor.materials_needed_placeable))
                                    .filter(([k, c]) => typeof c === 'number' && c > 0 && !optional.has(k))
                            );
                            const payable = Object.values(affordableNow(placeableBill, pool, stationUsable)).reduce((n, c) => n + c, 0);
                            // Digs cost nothing to claim, so they are seats in their own right.
                            buildPledgeSeats = Math.min(nextAnchor.placeable_now || 0, payable) + (nextAnchor.dig_count || 0);
                        }

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
                            Object.entries(mm).filter(([k, c]) => typeof c === 'number' && c > 0 && !optional.has(k))
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
                                // Something to do on this anchor anyway? A dig, an unsensed voxel to go and
                                // look at, or any block the pool can pay for in full (affordableNow — the
                                // same answer building_manager and preconstruction act on).
                                // ── THE BUILD QUESTION IS ASKED OF THE LOWEST COURSE ────
                                // `nextAnchor` is already the lowest owing anchor; `materials_needed_lowest_y`
                                // is that anchor's lowest course that still owes blocks. Asking affordability
                                // of the whole anchor would post a job the manager then refuses, because
                                // building_manager.anchorBuildableNow asks the coursed question — the two
                                // gates must ask ONE question (Law 16). The ORDER below stays sized against
                                // the whole anchor: coursing the fetch would cost a round trip per layer, and
                                // the order is not what places a block.
                                // ── AND ON A PLEDGE-APPROVED PLAN IT IS ASKED OF THE PLACEABLE CELLS ──────
                                // The course is the conservative approximation of the per-cell placement
                                // rule — right about every cell it admits, silent about ones a layer up whose
                                // own support already stands. Swapping the CUT keeps the Law 16 agreement
                                // intact: building_manager.anchorBuildableNow reads the same field off the
                                // same label, so the two gates still ask one question.
                                const cut = buildPledgeSeats !== null
                                    ? lessPeerHeld(nextAnchor?.materials_needed_placeable)
                                    : nextAnchor?.materials_needed_lowest_y;
                                const coursed = Object.fromEntries(
                                    Object.entries(cut || {})
                                        .filter(([k, c]) => typeof c === 'number' && c > 0 && !optional.has(k))
                                );
                                const canBuild = !!nextAnchor && (nextAnchor.dig_count > 0 || nextAnchor.unloaded_count > 0
                                    || Object.keys(affordableNow(coursed, pool, stationUsable)).length > 0);
                                if (!canBuild) materialsGated = true;
                                for (const [raw, count] of Object.entries(shortRaw)) {
                                    if (isUnderground(raw)) pullNeeded[raw] = count;
                                    else surfaceNeeded[raw] = count;   // deliver-amount = the gap (shortRaw)
                                }
                                // Route annotation (Law 6 — the split above is invisible otherwise).
                                const routeOf = (k) => isUnderground(k) ? '→mine' : '→chest#1';
                                const shortList = Object.entries(shortRaw).map(([k, v]) =>
                                    `${k}:${v} [${routeOf(k)}]`).join(', ');
                                watcher.summary(TAG, `"${bpName}" anchor ${buildAnchorIndex} ` +
                                    `${canBuild ? 'building what the pool holds' : 'gated'} — order (short): ${shortList}`);
                            }
                        }
                    }
                }
            }
        }

        if (req.type === TYPE_STRUCTURE_COMPLETE) built[req.field] = satisfied;
        if (!satisfied && firstUnsatisfied === null) {
            firstUnsatisfied = req;
        }
    }

    // Coordinates/paster steps are the FOREMAN'S (Law 16 — one pathway): it sites the whole base before
    // any body exists, and `start_injector` records the handed site and refuses to start a body without
    // one — so this posts ONLY the STRUCTURE build. A coords/paster firstUnsatisfied means this body has
    // no base, which the start gate already refused, so nothing posts here.
    // TREES FIRST (assessors/shared siteTreesJob — the same felling job the castle posts): while a trunk stands on
    // the structure's footprint plus the leaf margin, the felling job posts in the build's place. Materials gate
    // only the build, so the felling runs while the order below fills.
    const treeSite = (firstUnsatisfied && firstUnsatisfied.type === TYPE_STRUCTURE_COMPLETE && bot && bot.findBlocks)
        ? hq.readBuildingChair(firstUnsatisfied.field, 'set_buildspot')?.transpose_origin || null : null;
    const treeBox = treeSite
        ? siteTreeBox(firstUnsatisfied.blueprint_name || firstUnsatisfied.field)
        : null;
    // The build waits on the PHASE, not on the scan: an all-claimed site posts no new job but is still
    // being felled, so the build must not start over a feller's head (see shared.siteTreesJob).
    let treesStanding = false;
    if (treeSite && !siteTreePhaseDone(firstUnsatisfied.field)) {
        const treesSeats = await siteTreesJob(firstUnsatisfied.field, treeSite, treeBox);
        jobs.push(...treesSeats);   // an ARRAY of seats now — one per standing trunk, capped at the roster
        // Re-read AFTER the call: siteTreesJob is what closes the phase when it finds the site clear, so
        // asking before it would hold the build for one needless sweep on the sweep that finishes felling.
        treesStanding = !siteTreePhaseDone(firstUnsatisfied.field);
    }

    if (firstUnsatisfied && !materialsGated && !treesStanding && firstUnsatisfied.type === TYPE_STRUCTURE_COMPLETE) {
        const bc = hq.readBuildingChair(firstUnsatisfied.field, 'set_buildspot')?.transpose_origin || null;

        // Distinct job_id per anchor → two bots build two anchors at once via existing Phase-3 claims.
        const withAnchor = buildAnchorIndex != null;
        // ── ONE STRUCTURE, ONE BUILDER — UNLESS THE PLAN SAYS OTHERWISE ────────
        // 'shared' dedups WHO builds a structure — a body pillaring up inside a 5×5×5 cube digs its own
        // footing, and a second body in that cube stands on a block about to be mined from under it.
        //
        // A PLEDGE-APPROVED PLAN IS 'local' FOR THE SAME REASON `mine_dig_cell` IS: exclusivity moves
        // DOWN a level, from the job to the cell. The foreman's `cell:` claim gives each voxel exactly
        // one owner, so the magnet stops standing in for it, and many bodies holding the same magnet
        // are many bodies placing many different blocks. 'shared' here would make the seats below a lie
        // — the board advertising more than the dispatcher would admit.
        //
        // `need` IS CELLS AND `pledge_unit` IS ONE, which is what makes a seat a cell. Stated on the JOB,
        // since it is a fact about this order, not a property of any material — see the pledge note in
        // yield_pledge_calculator for why that is one system.
        const pledged = buildPledgeSeats !== null && buildPledgeSeats > 0;
        jobs.push({
            id:   `build_${firstUnsatisfied.execute_key || firstUnsatisfied.field}${withAnchor ? `_anchor_${buildAnchorIndex}` : ''}`,
            type: 'build',
            what: firstUnsatisfied.execute_key || firstUnsatisfied.field,
            where: bc,
            ...(pledged ? { need: buildPledgeSeats, pledge_unit: 1 } : {}),
            // Per-building rank: a requirement may name its own JOB_TYPE key (how the headframe
            // outranks other structures); unnamed → default tier.
            job_type: JOB_TYPE[firstUnsatisfied.job_type] ?? JOB_TYPE.building_structure,
            claimed_by: null,
            step: firstUnsatisfied.type,
            structure: firstUnsatisfied.field,
            scope: pledged ? 'local' : 'shared',
            ...(withAnchor ? { anchor_index: buildAnchorIndex } : {}),
        });
    }

    // Build-material ORDER: surface-raw shortfall → headframe chest as a restock-DELIVER job (reuses
    // supply_manager Steps 0/1 → delivery_executor). scope via deliverScope — raw='local', every idle
    // bot fills at once. Ranked one step BELOW its own build: a bot holding materials builds; chest-fill
    // runs only when pocket+chest fall short. Gate/order/withdraw read one pool, so a partial fill flips
    // the build actionable and this stops posting.
    // DYNAMIC vs STANDING: standing STOCK rows (`logs: keep 50`) never finish; this is computed fresh per
    // sweep and stops when the gap closes. A dynamic order at the same rank as a standing shelf-level row
    // can lose ties to it despite being the more urgent of the two — `supply_job_type` on the requirement
    // lifts this one above that; unnamed keeps the standing rank.
    // BOOTSTRAP: before the storage chest exists (the early frame erects it), gather goes to POCKET via
    // build_supply (P4/local) — a build can't gate on a chest it hasn't built. Both rows state a POCKET
    // LEVEL (see THE QUANTITY CONTRACT) but compute it differently: the deliver row ignores what the
    // pocket already holds, since the pocket is not fulfillment for a storage row; the bootstrap row
    // delivers INTO the pocket and so counts it.
    const poolChest = homeChest();
    // TWO DEFAULTS, BECAUSE THEY ARE TWO DIFFERENT ORDERS. A chest order restocks the fleet's shelf and
    // defaults to the chest band; a bootstrap order is the structure's own bill going into the builder's
    // pocket before any chest exists, and defaults to the blueprint band beside the build it serves.
    // A declared `supply_job_type` on the requirement still overrides both (the headframe does).
    const supplyJobType      = JOB_TYPE[firstUnsatisfied?.supply_job_type] ?? JOB_TYPE.resource_chest_restock;
    const bootstrapJobType   = JOB_TYPE[firstUnsatisfied?.supply_job_type] ?? JOB_TYPE.building_structure_supply;
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
                // Carries `station_id` from `homeChest()` directly: rebuilding the key downstream from
                // coordinates alone loses the owner half `station_registry.stationKey` appends, which
                // abandons the delivery (see `supply_manager._dispatchDelivery`).
                station_id: poolChest.id,
                // destination names this crew's own home, read from the mandate so the label always
                // matches whatever structure the crew actually raises (Law 16, same as downloaded_build.js).
                destination: require('@kernel/bot_mandate').homeBlueprint(),
                structure: firstUnsatisfied.field,
                job_type: supplyJobType,
                claimed_by: null,
                hold_goal: gap, at_destination: 0,
                // ONE ASKER: the building. Delivering into a chest, so the body's own pocket is not part
                // of the figure and the breakdown has a single term.
                parts: [{ who: `blueprint:${firstUnsatisfied.field}`, amount: gap }],
                // surfaceNeeded is raw today → 'local'; predicate called anyway so a future craftable moves
                // scope with it — hardcoded 'local' would silently authorise duplicate crafts (Law 25).
                category: 'resource', action: 'deliver', scope: deliverScope(raw),
            }));
            postedOrders.push(`build_chest_${raw} deliver ${gap}→${require('@kernel/bot_mandate').homeBlueprint()}#1`);
        } else {
            jobs.push(supplyJob({
                id: `build_supply_${raw}`, what: raw, need: gap,
                where: null,
                structure: firstUnsatisfied.field,
                // ── THE BILL RANKS WITH THE BUILD, NOT WITH THE BODY ────────
                // WHERE a material is delivered is a routing detail; WHO is asking for it is the band,
                // and the asker here is the blueprint either way, so this honours the requirement's own
                // `supply_job_type`, same as the chest branch above. The bot band is the body's own kit
                // and is meant to EMPTY; a build's bill does not finish, so pouring it into the bot band
                // would starve the blueprint band beneath it — build → craft → gather is a ladder for
                // ONE asker, and a body cannot "build" with a blueprint's stone.
                job_type: bootstrapJobType,
                claimed_by: null,
                hold_goal: countInInventory(raw, getBotInventory()) + gap,
                at_destination: countInInventory(raw, getBotInventory()),
                // ── THE SUM THAT CROSSES A CATEGORY, NAMED IN THE OPEN ──
                // `hold_goal` here is the body's CURRENT POCKET plus the BUILDING's remaining gap — two
                // different kinds of number: a fact about one body, and a requirement of a structure the
                // whole fleet shares. The sum is kept, since the destination is the POCKET and "how much
                // must I be holding when this is done" genuinely means what I hold now plus what the
                // build still wants. Both terms travel with it to the board and the judge (`parts`), so a
                // reader can see which half is the building's — e.g.
                // `80 = bot:pocket_carried 33 + blueprint:laydown_yard 47`.
                parts: [
                    { who: `bot:pocket_carried_${raw}`, amount: countInInventory(raw, getBotInventory()) },
                    { who: `blueprint:${firstUnsatisfied.field}`, amount: gap },
                ],
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
    // one layer up and may not count material this build has already spoken for, so the claim is
    // declared here, not folded silently into the jobs it posted. Both routes are the same claim
    // wearing different delivery addresses — a surface gap fills from the chest, an underground one
    // from the mine — and the layer above is short by the sum either way.
    // It is the SHORTFALL, not the requirement: material the build already holds is in `everything`
    // and would be subtracted twice if the whole requirement were filed here.
    const buildClaim = { ...pullNeeded, ...surfaceNeeded };

    // The pull's asker is this structure's own bill (job_board places the tunnel seat where that bill stands).
    const pullAsker = { job_type: JOB_TYPE[firstUnsatisfied?.supply_job_type] ?? JOB_TYPE.building_structure_supply,
        structure: firstUnsatisfied?.field || null };
    return { jobs, pullNeeded, pullAsker, buildClaim, built };
}

module.exports = { name: 'building', assess };
