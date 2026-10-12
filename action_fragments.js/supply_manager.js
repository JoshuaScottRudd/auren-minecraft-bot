// supply_manager.js
// Receives a supply job, derives the next step from world state, dispatches one executor. Loops via
// recursive_judge until the job is done.
//
// Priority tree (one step per cycle):
//   1. Have the target item? Chest destination + harvestable raw → harvest first; else → deliver.
//      No destination → release, complete.
//   2. Can craft it now? → craft_executor
//   3. Can craft an intermediate? → craft_executor
//   4. Need raw materials? → tree_harvester / block_puncher
//   5. Need a different biome? → biome_seeker
//   6. Nothing possible → release (coding violation, Law 13)
//
// Steps 2-3: _planOneCraftStep. Steps 4-5: build_material_calculator.craftShortfall.

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { group_to_item: ROOT_GROUPS, getBotInventory, isUnderground, isProspected, furnace_chain_items, farm_items, hunt_items, normalizeItemName, chestItemCounts, substitutes_for: SUBSTITUTES_FOR } = require('@utils/fragment_utils');
const { countInInventory, craftsAffordable, heldByVariant } = require('@utils/calculators/inventory_calculator');
const inventoryLens = require('@kernel/inventory_lens');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const stationRegistry = require('@perception/station_registry');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const { craftShortfall, isGatherable } = require('@utils/calculators/build_material_calculator');

const TAG = 'supply_manager';

// Executors whose return means the bot holds stock it made for this request — the only stock a storage
// delivery may pay out of; membership is earned by producing.
const PRODUCER_EXECUTORS = new Set(['harvest_executor', 'craft_executor', 'furnace_executor', 'mining_executor', 'stone_prospect_executor']);
// No station name set here: the recipes' own `requires` names every station, and
// `crafting_blueprint_registry.stationsRequiredFor` reads it directly (Law 16).
const CRAFTING_GROUPS = ['logs', 'planks', 'stairs', 'door', 'stone'];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Blueprint + inventory helpers
// ─────────────────────────────────────────────────────────────────────────────

// Reads the registry, not the blueprints file live (Law 13).
function _loadBlueprints() {
    const raw = craftingRegistry.getRecipes();
    const byItem = {};
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [name, data] of Object.entries(raw)) {
            if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
            byItem[name.trim().toLowerCase()] = { item: name, ...data };
        }
    }
    return byItem;
}

function _resolveGroupAlias(name) {
    for (const alias of CRAFTING_GROUPS) {
        if (ROOT_GROUPS[alias] && ROOT_GROUPS[alias].includes(name)) return alias;
    }
    return name;
}

function _getInventoryCount(item, inventory) {
    const alias = _resolveGroupAlias(item);
    return countInInventory(alias, inventory, ROOT_GROUPS);
}

// How many crafts this pocket can run of `perCraft`, measured in crafts, where `_getInventoryCount` is
// the unit count (Law 16: mixed-species stock affords fewer crafts than its unit total).
function _craftsAffordable(item, perCraft, inventory) {
    const alias = _resolveGroupAlias(item);
    return craftsAffordable(alias, perCraft, inventory, ROOT_GROUPS);
}

function _readInventory() {
    const totals = {};
    for (const [name, count] of Object.entries(getBotInventory())) {
        const norm = normalizeItemName(name);
        totals[norm] = (totals[norm] || 0) + count;
    }
    return totals;
}

// Aggregates every storage chest into one totals object, shaped like _readInventory.
function _readChestInventory() {
    const totals = {};
    for (const entry of Object.values(stationRegistry.getStations())) {
        if (!require('@perception/station_registry').isStorage(entry)) continue;
        for (const [n, c] of Object.entries(chestItemCounts(entry))) totals[n] = (totals[n] || 0) + c;
    }
    return totals;
}

// No buffer→requester courier: storage restocks only by creation, never by chest→chest movement
// (Law 25, Law 16).

function _getMakes(bp, item) {
    const seq = Array.isArray(bp.sequence) ? bp.sequence : [];
    const step = seq.find(s => s && s.item === item);
    return (step && typeof step.makes === 'number' && step.makes > 0) ? step.makes : 1;
}

// Station availability comes from `stationRegistry.stationUsable`, the same predicate job_gates asks
// (Law 16, Law 25).

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Root material analysis
// ─────────────────────────────────────────────────────────────────────────────

// The recipe walk belongs to `build_material_calculator.craftShortfall` (Law 16). A furnace product
// (charcoal, iron_ingot) is a leaf: withdrawn if held, else reported short to raise a smelt order.
function _isFurnaceProduct(item, byItem) {
    const bp = byItem[item];
    return !!(bp && Array.isArray(bp.requires) && bp.requires.includes('furnace'));
}

// A material only another chain produces — the furnace, the farm, or a mob (hunt_items) — so this
// manager must never try to GATHER it.
function _isChainProduct(item, byItem) {
    return _isFurnaceProduct(item, byItem) || furnace_chain_items.has(item)
        || farm_items.has(item) || hunt_items.has(item);
}

// Whether this manager can raise `item`'s supply itself. False for the furnace, the farm, or the mine
// (underground_items) — wider than _isChainProduct, which the gather loop uses instead (Law 16).
function _isExternallySupplied(item, byItem) {
    return _isChainProduct(item, byItem) || isUnderground(item);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Craft step planning
// Walks the ingredient tree to the single deepest-first item+quantity to dispatch this cycle; null
// when an ingredient lacks a blueprint or a required station is missing.
// ─────────────────────────────────────────────────────────────────────────────

function _planOneCraftStep(topItem, topHave, topTarget, byItem, inventory, _visiting) {
    if (!_visiting) _visiting = new Set();
    if (_visiting.has(topItem)) return null;

    const bp = byItem[topItem];
    if (!bp || !bp.ingredients) return null;
    // A smelted item is never a craft step: the furnace chain makes it, and this manager only withdraws it.
    if (_isFurnaceProduct(topItem, byItem)) return null;

    // No station check here (Law 16) — reachability is asserted once, at the dispatch boundary above.
    const shortfall = Math.max(topTarget - topHave, 0);
    if (shortfall <= 0) return null;
    const craftsNeeded = Math.max(1, Math.ceil(shortfall / _getMakes(bp, topItem)));

    for (const [rawIng, perCraft] of Object.entries(bp.ingredients)) {
        const ing = rawIng.trim().toLowerCase();
        // Coal substitutes for charcoal (`substitutes_for`) and counts toward affordability here.
        let ingCrafts = _craftsAffordable(ing, perCraft, inventory);
        for (const alt of (SUBSTITUTES_FOR[ing] || [])) ingCrafts += _craftsAffordable(alt, perCraft, inventory);
        const ingNeeded = perCraft * craftsNeeded;
        if (ingCrafts < craftsNeeded) {
            // A short ingredient that affords one craft is a partial batch, dispatched now (Law 11).
            // Planner and `craftShortfall` share `perCraft` (Law 16).
            if (ingCrafts >= 1) continue;
            // Nothing affords even one craft — belongs to Step 4/4a's withdrawal, not this planner.
            if (_isExternallySupplied(ing, byItem)) return null;
            const ingBp = byItem[ing];
            if (!ingBp || !ingBp.ingredients) return null;

            // One craft's worth of EVERY sub-ingredient, the same threshold job_gates uses (Law 16,
            // Law 25).
            const oneCraftAffordable = Object.entries(ingBp.ingredients).every(([sub, perSub]) =>
                _craftsAffordable(sub.trim().toLowerCase(), perSub, inventory) >= 1
            );
            if (oneCraftAffordable) {
                return { item: ing, quantity: ingNeeded, have: _getInventoryCount(ing, inventory) };
            }
            // Recurse to the leaf-most affordable step; null bottoms out to Step 4's gather.
            _visiting.add(topItem);
            const deeper = _planOneCraftStep(ing, _getInventoryCount(ing, inventory), ingNeeded, byItem, inventory, _visiting);
            _visiting.delete(topItem);
            return deeper;
        }
    }


    return { item: topItem, quantity: topTarget, have: topHave };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Inventory snapshot helper
// Compact string of every ingredient and sub-ingredient with its current count, e.g. for
// stone_pickaxe: "cobblestone=19 stick=2 planks=0 logs=186"
// ─────────────────────────────────────────────────────────────────────────────

// A zero must distinguish absent from merely out of reach (Law 25) — inventory_lens supplies the
// chest half.
function _invSnapshot(topItem, byItem, inventory) {
    const items = new Set();
    const walk = (item) => {
        const bp = byItem[item];
        if (!bp || !bp.ingredients) return;
        for (const rawIng of Object.keys(bp.ingredients)) {
            const ing = rawIng.trim().toLowerCase();
            if (items.has(ing)) continue;
            items.add(ing);
            walk(ing);
        }
    };
    walk(topItem);
    // Prints the species split, not a single total, since per-craft cost varies by species.
    const render = (name) => {
        const rows = heldByVariant(_resolveGroupAlias(name), inventory, ROOT_GROUPS);
        const held = rows.reduce((sum, r) => sum + r.count, 0);
        if (held === 0) {
            const banked = inventoryLens.inChests(name);
            return banked > 0 ? `${name}=0(+${banked} chest)` : `${name}=0`;
        }
        if (rows.length === 1) return `${name}=${held}`;
        return `${name}=${held}(${rows.map(r => `${r.item} ${r.count}`).join(', ')})`;
    };
    if (items.size === 0) return render(topItem);
    return [...items].map(render).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Executor dispatch helpers (no watcher — summary covers it)
// ─────────────────────────────────────────────────────────────────────────────

function _dispatchCraft(payload, step) {
    routeSignal(TAG, 'craft_executor', {
        ...payload,
        manager:   TAG,
        objective: step.item,
        quantity:  step.quantity,
        readable:  `${TAG}: craft ${step.quantity}x ${step.item} (have ${step.have})`,
    });
}

// A claim is worked a pledge at a time, bounded by PLEDGES_PER_CLAIM. A pledge is worked until it is whole:
// the body goes out again for the rest of it, and a gather that finds nothing ends the job through the
// executor's own verdict. State lives on the magnet (Law 6).
const PLEDGES_PER_CLAIM = 3;

// Whether this body's trip for a delivery order has paid for its walk, from the walk calculator
// (yield_pledge_calculator.walkOwed): the flat distance from where it stands (at the material) to the
// order's station, at its own measured pace, against the walking and the working its own clock holds for the
// order. → { walk, walk_s, elapsed_s, walked_s, owed_s, measured, stays }.
function _tripSize(magnet) {
    const yieldPledge = require('@utils/calculators/yield_pledge_calculator');
    const bot = global.bot;
    const at = bot.entity.position;
    const [sx, , sz] = String(magnet.station_id).split('|').map(Number);
    if (!Number.isFinite(sx) || !Number.isFinite(sz)) {
        throw new Error(`[supply_manager] CODING VIOLATION (Law 13): station_id "${magnet.station_id}" does not begin with x|y|z, `
            + 'so the walk back to it cannot be measured.');
    }
    const walk = Math.round(Math.hypot(at.x - sx, at.z - sz));
    const span = require('@kernel/bot_minutes').snapshot().open_span;
    const owed = yieldPledge.walkOwed(walk, require('@locomotion/locomotion_dispatcher').walkPace(), span);
    return { walk, ...owed, stays: yieldPledge.staysOut(span, owed, 'pledge') };
}

// Peers' live pledges against this order, read through the dispatcher (Law 16).
function _peerPledgedAgainst(botId, jobId, need) {
    if (!jobId || !(need > 0)) return 0;
    const { peerPledges } = require('@thinking/dispatcher.js');
    return require('@utils/calculators/yield_pledge_calculator')
        .pledgedAgainst({ id: jobId, type: 'supply', what: 'x', need }, peerPledges(botId));
}

// Whether a pledge is still open, per `BAND_POLICY.goal`:
//   fleet      need minus every peer's pledge minus this body's own.
//   bot        whether the whole kit still owes the material.
//   any other  the order's own need.
function _anotherPledgeOpen(botId, magnet, rootItem, inventory, taken) {
    const { BAND_POLICY } = require('@thinking/architect_config');
    const PLEDGE = require('@utils/calculators/yield_pledge_calculator').PLEDGE_BLOCK;
    const goal = BAND_POLICY[magnet.asker] ? BAND_POLICY[magnet.asker].goal : null;
    if (goal === 'fleet') {
        const need = magnet.need;
        if (!(need > 0)) return { open: true, why: 'the order carries no total to divide' };
        const mine = taken * PLEDGE;
        const open = need - _peerPledgedAgainst(botId, magnet.job_id, need) - mine;
        return open >= 1
            ? { open: true,  why: `${open} of ${need} still unpledged` }
            : { open: false, why: `the rest of ${magnet.job_id} is pledged by peers (I hold ${mine} of ${need})` };
    }
    if (magnet.asker === 'bot') {
        const owed = require('@thinking/assessors/shared').kitRawShortfall(inventory)[rootItem] || 0;
        return owed > 0
            ? { open: true,  why: `the kit still owes ${owed}x ${rootItem}` }
            : { open: false, why: `the kit owes no more ${rootItem}` };
    }
    return { open: true, why: `${magnet.job_id} is this body's own work and is still short` };
}

// The gate every gather dispatch passes through. Returns the size of the next trip, or null when the
// claim is finished and released. Pledge state lives on three magnet fields (Law 6): pledge_root,
// pledge_start, pledges_taken.
function _nextTrip(botId, boardroom, magnet, root, inventory, note, payload) {
    const PLEDGE = require('@utils/calculators/yield_pledge_calculator').PLEDGE_BLOCK;
    const held = _getInventoryCount(root.item, inventory);
    if (magnet.pledge_start == null || magnet.pledge_root !== root.item) {
        magnet.pledge_root = root.item;
        magnet.pledge_start = held;
        magnet.pledges_taken = 1;
    }
    const taken = magnet.pledges_taken || 1;
    const got = Math.max(0, held - magnet.pledge_start);

    // A DELIVERY STAYS OUT UNTIL ITS TRIP HAS PAID FOR ITS WALK, THEN BANKS EVERYTHING. The walk calculator is
    // read where the body stands each time a pledge comes whole; a pocket with no free slot banks whatever is
    // owed. The deposit ends the claim (the deliver return releases it), and it carries everything of the
    // material the body holds.
    const delivers = magnet.action === 'deliver' && magnet.station_id && root.item === magnet.what;
    const bank = (why) => {
        watcher.summary(TAG, `${note} | ${why} — banking ${held} at ${magnet.station_id}`);
        _dispatchDelivery(payload, { ...magnet, hold_goal: held });
        return null;
    };
    if (got >= PLEDGE && delivers) {
        const valve = _tripSize(magnet);
        const owes = valve.stays;
        const freeSlots = global.bot.inventory.emptySlotCount();
        watcher.summary('trip_size', `trip_size at=pledge item=${root.item} walk=${valve.walk} walk_s=${valve.walk_s} elapsed_s=${valve.elapsed_s} walked_s=${valve.walked_s} owed_s=${valve.owed_s} taken=${taken} held=${held} free_slots=${freeSlots} stays_out=${owes && freeSlots > 0 ? 1 : 0} pace=${valve.measured ? 'measured' : 'unmeasured'}`);
        if (freeSlots === 0) return bank(`the pocket has no free slot after ${taken} pledge(s) of ${root.item}`);
        if (!owes) return bank(`${taken} pledge(s) of ${root.item} whole after ${valve.elapsed_s}s on this trip, ${valve.walked_s}s of it walking, ${valve.walk_s}s walk home (${valve.walk} blocks), ${valve.owed_s}s of work still owed`);
        magnet.pledges_taken = taken + 1;
        magnet.pledge_start = held;
        if (magnet.pledge && Number.isFinite(magnet.pledge.amount)) {
            magnet.pledge = { ...magnet.pledge, amount: (taken + 1) * PLEDGE };
        }
        watcher.summary(TAG, `${note} | pledge ${taken} of ${root.item} whole — staying out for the next: ${valve.owed_s}s still owed for a ${valve.walk_s}s walk home (${valve.walk} blocks)`);
    } else if (got >= PLEDGE) {
        // Pledge is whole; take another only if the order is open and this claim is under its cap.
        if (taken >= PLEDGES_PER_CLAIM) {
            watcher.summary(TAG, `${note} | ${taken} pledges of ${root.item} carried on this claim — a claim's worth; releasing the rest to the board`);
            _releaseJob(`carried ${taken} pledges (${taken * PLEDGE}x ${root.item}) on one claim of ${magnet.job_id} — the rest stays claimable`);
            return null;
        }
        const next = _anotherPledgeOpen(botId, magnet, root.item, inventory, taken);
        if (!next.open) {
            watcher.summary(TAG, `${note} | pledge ${taken} of ${root.item} complete and no more to take — ${next.why}`);
            _releaseJob(`pledge ${taken} complete for ${root.item}; ${next.why}`);
            return null;
        }
        magnet.pledges_taken = taken + 1;
        magnet.pledge_start = held;
        // Keeps the magnet's pledge amount current so peers subtract the right number (Law 16).
        if (magnet.pledge && Number.isFinite(magnet.pledge.amount)) {
            magnet.pledge = { ...magnet.pledge, amount: (taken + 1) * PLEDGE };
        }
        watcher.summary(TAG, `${note} | pledge ${taken} of ${root.item} complete (${got}) — taking pledge ${taken + 1} without replanning: ${next.why}`);
    }

    boardroom.magnet = magnet;
    hq.writeBoardroomChair(botId, boardroom);
    // The trip is the REST of the current pledge, never the order.
    return Math.max(1, PLEDGE - Math.max(0, held - magnet.pledge_start));
}

// The one door out of the base; does not decide whether to walk through it — job_board is the fleet's
// one night gate (Invariant D). `trip` is sized by `_nextTrip`; omitted on the chest-race recovery
// below, which takes one plain pledge.
function _dispatchGather(payload, root, magnet, trip = null) {
    if (trip == null) trip = require('@utils/calculators/yield_pledge_calculator').PLEDGE_BLOCK;
    if (isUnderground(root.item)) {
        // A classification that moved is not a board bug: `isUnderground` can flip mid-order under
        // `STONE_SOURCE: 'mine_after_furnace'`. The magnet carries the routing as it stood at the
        // claim: different now → release for a replan; same → coding violation.
        if (magnet && magnet.stone_is_mined != null
            && magnet.stone_is_mined !== require('@utils/fragment_utils').stoneIsMined()) {
            watcher.summary(TAG,
                `"${root.item}" was a surface gather when this order was claimed and is a mine pull now — `
                + `the fleet's stone routing changed mid-order (a furnace registered). Releasing for a `
                + `replan rather than treating a moved classification as a board fault. `
                + `Inventory has ${root.have} of ${root.need} needed.`);
            _releaseJob(`stone routing changed mid-order for ${root.item}`);
            return;
        }
        // A plain `mine` builder never flips routing, so an empty chest here is ordinary (a peer took
        // the stack) unless the item is on job_board's exclusion list, in which case nothing can ever
        // deliver it — release for the first case, throw for the second (Law 13).
        const jobExclusions = require('@thinking/job_exclusions');
        if (magnet && magnet.excluded && !jobExclusions.excludes(magnet.excluded, root.item)) {
            watcher.summary(TAG,
                `"${root.item}" is a mine pull and the board did NOT exclude it, so the fleet could reach `
                + `it when this order was claimed — the stock moved before this body opened the chest `
                + `(a peer took it). Releasing for a replan rather than calling a timing state a board `
                + `fault. Inventory has ${root.have} of ${root.need} needed.`);
            _releaseJob(`${root.item} was reachable at the claim and is gone now`);
            return;
        }
        throw new Error(
            `[supply_manager] CODING VIOLATION (Law 13): dispatched to gather ` +
            `"${root.item}" which is underground. job_board should have gated ` +
            `this tier until the bot had enough materials. ` +
            `Inventory has ${root.have} of ${root.need} needed.`
        );
    }
    // A made thing is not a found thing — no fallback, no release, a coding violation (Law 13). Asked
    // through `isGatherable`, never `isRawMaterial` — the any rule across a group's members, so a mixed
    // group (`natural_block`, `structural_fill`) still gathers on its raw members (Law 16).
    if (!isGatherable(root.item)) {
        throw new Error(
            `[supply_manager] CODING VIOLATION (Law 13): dispatched to gather ` +
            `"${root.item}", which is MADE and not found — it has a recipe (and, if it names a group, ` +
            `every member of that group has one), so no surface scan can ever return it and the gather ` +
            `can only come back empty. Whatever planned this owed a craft step, not a gather. ` +
            `Inventory has ${root.have} of ${root.need} needed.`
        );
    }
    // One door, two producers, chosen by what the material is: stone's producer is a mined column, not
    // harvest_executor's surface scan (Law 16). `trip`, sized by `_nextTrip`, is carried to the
    // producer — never the order's `need`, which Step 1 tracks upstream.
    const why = ` (a pledge of this order; it wants ${root.need} in total)`;

    if (isProspected(root.item)) {
        routeSignal(TAG, 'stone_prospect_executor', {
            ...payload,
            manager:   TAG,
            objective: [root.item],
            quantity:  trip,
            readable:  `${TAG}: prospect ${trip}x ${root.item}${why}`,
        });
        return;
    }
    routeSignal(TAG, 'harvest_executor', {
        ...payload,
        manager:   TAG,
        objective: [root.item],
        quantity:  trip,
        readable:  `${TAG}: gather ${trip}x ${root.item}${why}`,
    });
}

// The one way a storage miss may become a gather (Law 13: a chest emptying mid-walk is environmental).
//   UNDERGROUND      RELEASE — only the board may authorize going underground.
//   CHAIN PRODUCT     RELEASE — an ordinary timing state, not a gating bug.
//   MADE, NOT FOUND   THE CRAFT RUNG — a craftable's world does not change between sweeps.
function _fallBackToHarvest(payload, item, amount, note) {
    if (isUnderground(item)) {
        _releaseJob(`${note} — "${item}" is underground and only job_board may authorize that trip; returning to the board to replan`);
        return;
    }
    if (_isChainProduct(item, _loadBlueprints())) {
        _releaseJob(`${note} — "${item}" comes from another chain (furnace, farm or a mob drop) and no scan can find it; `
            + 'returning to the board so this body takes other work while that chain delivers');
        return;
    }
    // A made item's recovery is the craft rung, never the gather rung — the ladder is withdraw → craft
    // → gather (Law 16). The streak ceiling below shares the withdrawal continuation's judge (Law 11).
    if (!isGatherable(item)) {
        // `chest_empty_for` stands the withdrawal rung down for this one re-entry (see the guard at Step 3).
        _continueLadder({ ...payload, chest_empty_for: item },
            `${note} — "${item}" is made, not found; the chest is proved empty for it, `
            + 'so the ladder re-enters with that rung stood down');
        return;
    }
    _dispatchGather(payload, { item, need: amount, have: 0 });
}

// Re-enters this manager's own `receive` under the one ceiling that judges the loop (Law 11).
function _continueLadder(payload, note) {
    const botId = process.env.BOT_ID || 'default';
    const boardroom = hq.readBoardroomChair(botId, {});
    const magnet = boardroom?.magnet;
    const streak = (magnet?.withdraw_streak || 0) + 1;
    if (!magnet || streak > MAX_WITHDRAW_STREAK) {
        _releaseJob(`${note} (${streak - 1} ladder pass(es) in a row — replan)`);
        return;
    }
    magnet.withdraw_streak = streak;
    boardroom.magnet = magnet;
    hq.writeBoardroomChair(botId, boardroom);
    watcher.summary(TAG, `${note} — continuing the job (pass ${streak}/${MAX_WITHDRAW_STREAK})`);
    module.exports.receive(TAG, { ...payload, from: `${TAG}:ladder`, executor: 'inventory_swapper' });
}

// Consecutive-withdraw ceiling — the judge for the continuation loop (Law 11). Four covers the deepest
// real chain; state lives on the magnet (Law 6).
const MAX_WITHDRAW_STREAK = 4;

// Pulls a material from a storage chest instead of harvesting it (Law 15 API call); retrieveItems owns
// its own Law 4 abandonment. Continues the job here, not by returning to the board (Invariant B, Law 1,
// Law 12).
async function _withdrawFromChest(payload, item, amount) {
    const inventorySwapper = require('@api/inventory_swapper');
    const chestLedger = require('@perception/chest_ledger');
    const bot = global.bot;
    const result = await inventorySwapper.retrieveItems(bot, item, amount);
    // The claim is released on every outcome, including failure, so peers price against freed stock.
    chestLedger.release(null, result === undefined ? 'withdraw abandoned'
        : (!result.success || result.transferred <= 0) ? 'withdraw moved nothing'
        : `withdrew ${result.transferred}x ${item}`);

    if (result === undefined) {
        // Unreachable / open-failed — retrieveItems already abandoned to
        // recursive_judge. Do nothing more.
        return;
    }
    if (!result.success || result.transferred <= 0) {
        // Chest emptied between scan and withdrawal — recover through the one door
        // that may open here (see _fallBackToHarvest).
        watcher.warn(TAG, `withdraw moved nothing for ${item} — falling back to harvest`);
        _fallBackToHarvest(payload, item, amount, 'withdraw moved nothing');
        return;
    }
    // Shares the ceiling in _continueLadder (Law 11, Law 16). `chest_empty_for` is cleared here — a
    // successful withdrawal contradicts it.
    _continueLadder({ ...payload, chest_empty_for: null },
        `withdrew ${result.transferred}x ${item} from storage`);
}

// The station key is carried, never rebuilt — `station_registry.stationKey` includes the owner, which
// a coordinate alone cannot (Law 13, Law 16).
function _dispatchDelivery(payload, magnet) {
    const stationId = magnet.station_id;
    if (!stationId) {
        throw new Error(`[${TAG}] CODING VIOLATION (Law 13): a deliver magnet for "${magnet.what}" carries no `
            + `station_id, so there is no chest row to open. The assessor that posted this job must carry the `
            + `chest's registry key (see supply.js's storage row), and \`dispatcher._claimJob\`'s magnet field `
            + `whitelist must list station_id. Do NOT rebuild it from \`where\` — the key carries an owner `
            + `and a coordinate does not.`);
    }
    routeSignal(TAG, 'delivery_executor', {
        ...payload,
        manager:    TAG,
        objective:  magnet.what,
        quantity:   magnet.hold_goal,
        station_id: stationId,
        readable:   `${TAG}: deliver ${magnet.hold_goal}x ${magnet.what} to ${magnet.destination} (${stationId})`,
    });
}

function _dispatchExplore(payload) {
    routeSignal(TAG, 'exploration_executor', {
        ...payload,
        manager:  TAG,
        readable: `${TAG}: seeking suitable biome`,
    });
}

// Release back to recursive_judge; dumping goes through inventory_dump only (Law 16).
function _releaseJob(reason) {
    routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Main receive handler
// Fresh dispatch (payload.job) or executor return (payload.executor): read the magnet, derive the next
// step, dispatch. One watcher.summary per decision cycle (Law 16).
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    receive: watcher.track(TAG, function (signalType, payload) {
        if (signalType !== TAG) return;
        const from = payload?.from || 'unknown';

        const botId = process.env.BOT_ID || 'default';
        const boardroom = hq.readBoardroomChair(botId, {});
        const magnet = boardroom?.magnet;

        if (!magnet || !magnet.what) {
            watcher.summary(TAG, `from=${from} | no active magnet | RELEASE`);
            _releaseJob('no active magnet — nothing to do');
            return;
        }

        // Pledge count carries across non-gather returns — cleared only by a new claim or different
        // root (see `_nextTrip`).
        const targetItem = magnet.what;
        const holdGoal = magnet.hold_goal || 1;

        // ── Deliver return: delivery_executor finished a chest deposit ──
        if (magnet.action === 'deliver' && payload.executor === 'delivery_executor') {
            // The carried key, not a rebuilt one (see `_dispatchDelivery`).
            watcher.summary(TAG, `${targetItem} (${holdGoal}) from=${from} | deliver complete to ${magnet.destination} (${magnet.station_id}) | RELEASE`);
            _releaseJob(`deliver done for ${targetItem}`);
            return;
        }

        const inventory = _readInventory();
        const byItem = _loadBlueprints();
        const have = _getInventoryCount(targetItem, inventory);

        // ── Dry gather on a delivery order: what the pocket holds of it goes to the station ──
        // harvest_executor.handBackDelivery marks the return. The deliver return above releases the claim.
        // A pocket holding none of it has nothing to deliver: the claim is released and the board is read again.
        if (payload.gather_dry) {
            const { gather_dry: why, ...rest } = payload;
            if (have > 0) {
                watcher.summary(TAG, `${targetItem} from=${from} | GATHER_DRY ${why} held=${have} — delivering ${have} to ${magnet.station_id}`);
                _dispatchDelivery(rest, { ...magnet, hold_goal: have });
                return;
            }
            watcher.summary(TAG, `${targetItem} from=${from} | GATHER_DRY ${why} held=0 — nothing to deliver | RELEASE`);
            _releaseJob(`gather for ${targetItem} found nothing and the pocket holds none (${why})`);
            return;
        }
        const snap = _invSnapshot(targetItem, byItem, inventory);

        // A storage request is fulfilled by CREATION (harvest or craft), never the bot's own kit
        // (Law 16). Producer executors are the way through — their return is stock MADE for this
        // request, not the kit.
        const pocketBlocked = !!(magnet.destination && magnet.where) && !PRODUCER_EXECUTORS.has(payload.executor);

        if (pocketBlocked && have >= holdGoal) {
            const isHarvestableRoot = !isUnderground(targetItem) && !byItem[targetItem];
            if (isHarvestableRoot) {
                const root = { item: targetItem, need: holdGoal, have };
                const trip = _nextTrip(botId, boardroom, magnet, root, inventory, `${targetItem} (have ${have}/${holdGoal})`, payload);
                if (trip === null) return;
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → harvest first (chest supply from trees, not inventory) | ${snap}`);
                _dispatchGather(payload, root, magnet, trip);
                return;
            }
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | pocket is NOT fulfillment for a storage request — creating fresh | ${snap}`);
            // No return: falls past Step 1 into the craft path, the ruling's second legal source.
        }

        // Reserve is a RAISED GOAL (`holdGoal + reserved`), holding `have` back untouchable. Reserve is
        // the pocket's whole count (Law 22 gate 2).
        const reserved = pocketBlocked ? have : 0;
        const haveSpendable = have - reserved;
        const creationGoal = holdGoal + reserved;

        // Precondition: every workbench this item's recipe tree needs is reachable — a coding violation,
        // not an environmental one (Law 13), since job_gates' craft_station gate already asked this. The
        // predicate must match job_gates.HELD_ENOUGH (Law 16, Law 25).
        const heldEnough = (ingredient, quantity) => inventoryLens.spendableForCraft(ingredient) >= quantity;
        const unreachableStations = [...craftingRegistry.stationsRequiredFor(targetItem, heldEnough)]
            .filter(station => !stationRegistry.stationUsable(station));
        // A station that vanished after the claim is the world, not the gate. The magnet carries station
        // reachability as it stood at the claim: absent now but usable then → release; absent then too →
        // still a coding violation.
        const hadStations = Array.isArray(magnet?.stations_at_claim) ? magnet.stations_at_claim : null;
        const vanished = hadStations && unreachableStations.filter(s => hadStations.includes(s));
        if (unreachableStations.length && haveSpendable < holdGoal && vanished && vanished.length === unreachableStations.length) {
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | [${unreachableStations.join(', ')}] `
                + `was usable when this job was claimed and is gone now — releasing for a replan rather than `
                + `reporting a moved world as a gate fault | ${snap}`);
            _releaseJob(`${unreachableStations.join(', ')} vanished after the claim for ${targetItem}`);
            return;
        }
        if (unreachableStations.length && haveSpendable < holdGoal) {
            throw new Error(`[${TAG}] CODING VIOLATION (Law 13): dispatched "${targetItem}" `
                + `(have ${have}/${holdGoal}) whose remaining recipe tree needs [${unreachableStations.join(', ')}], `
                + `and none of those is standing or in the pocket. job_gates.craftStationGate exists to hold `
                + `this job and name the station in \`shortOf\` so the board can report what it is waiting on — `
                + `a job reaching this fulfiller unstationed means that gate did not cover it. `
                + `Fix the gate, not this call.`);
        }

        // ── Step 1: Do I already have enough? ────────────────────────────
        if (haveSpendable >= holdGoal) {
            if (magnet.destination && magnet.where) {
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | COMPLETE → deliver to ${magnet.destination} (${magnet.station_id})`);
                _dispatchDelivery(payload, magnet);
                return;
            }
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | COMPLETE | RELEASE`);
            _releaseJob(`completed ${targetItem} (have ${have}/${holdGoal})`);
            return;
        }

        // ── Step 1.5: Can I pull the finished item straight from a chest? ─
        // Storage is the primary source, local supply only (Law 15); _withdrawFromChest continues the
        // job, not releasing it. A failed withdrawal is carried as `chest_empty_for`, standing this rung
        // down for one re-entry (Invariant B).
        const chestProvedEmpty = payload?.chest_empty_for === targetItem;
        if (!magnet.destination && !chestProvedEmpty) {
            const deficit = holdGoal - have;
            const chestLedger = require('@perception/chest_ledger');
            const available = chestLedger.availablePool(targetItem);
            const pull = Math.min(available, deficit);
            // A trip to the barrel has a floor size (MIN_PARTIAL_WITHDRAW), except when the trip finishes
            // the need. Declining falls through to craft and then gather (Law 16).
            const MIN_PARTIAL_WITHDRAW = 4;
            const worthTheWalk = pull >= deficit || pull >= MIN_PARTIAL_WITHDRAW;
            if (deficit > 0 && available > 0 && worthTheWalk) {
                // The barrel that HOLDS it, not the first in the map (`claimsAt` keys on the station).
                const station = chestLedger.stationHolding(targetItem);
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → withdraw ${pull}x ${targetItem} from chest (${available} unclaimed, harvest covers any remainder) | ${snap}`);
                // Claim before walking, so every later body subtracts it (released by
                // `_withdrawFromChest` / `clearMagnet`).
                if (station) chestLedger.claim(station, [{ item: targetItem, amount: pull }]);
                _withdrawFromChest(payload, targetItem, pull);
                return;
            }
            // Names which of two reasons a trip was declined — claims eating the pool vs. too small to
            // be worth taking (Invariant C, Law 25).
            if (deficit > 0 && _getInventoryCount(targetItem, _readChestInventory()) > 0) {
                const why = (available > 0 && !worthTheWalk)
                    ? `${targetItem}: only ${pull} unclaimed and I need ${deficit} — too small a trip `
                      + `(floor ${MIN_PARTIAL_WITHDRAW}); gathering the rest instead`
                    // Falls back to the first station only when nothing is free.
                    : chestLedger.worthTheTrip(
                        chestLedger.stationHolding(targetItem) || chestLedger.poolStations()[0],
                        targetItem, deficit).why;
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → NOT walking to the barrel: ${why} | ${snap}`);
            }
        }

        // ── Step 2-3: Can I craft it (or an intermediate)? ───────────────
        const craftStep = _planOneCraftStep(targetItem, have, creationGoal, byItem, inventory);
        if (craftStep) {
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → craft ${craftStep.quantity}x ${craftStep.item} (have ${craftStep.have}) | ${snap}`);
            _dispatchCraft(payload, craftStep);
            return;
        }

        // ── Step 4: Need raw materials? ──────────────────────────────────
        // Aimed at creationGoal (Law 16 — must match the craft path's target). Walk belongs to the
        // calculator (Law 16); `need` is already net of the pool.
        const missingRoots = Object.entries(craftShortfall(targetItem, creationGoal, inventory))
            .map(([item, need]) => ({ item, need, have: _getInventoryCount(item, inventory) }));
        if (missingRoots.length > 0) {
            // Step 4a: pull ingredients from a chest before harvesting a raw root.
            // ── A chest-destination job may withdraw an INGREDIENT, never its own TARGET ──
            // Test is `source !== targetItem`: a root that IS the target stays refused (the shuffle); an
            // INPUT the craft consumes is production.
            {
                const chestLedger = require('@perception/chest_ledger');
                // Every storage station, read once for the whole walk.
                const chestInv = _readChestInventory();
                // Named root first, then its substitutes (`substitutes_for`).
                for (const root of missingRoots) {
                    const shortfall = root.need;
                    if (shortfall <= 0) continue;
                    // The shuffle guard, at the only level it is true at.
                    if (magnet.destination && root.item === targetItem) continue;
                    for (const source of [root.item, ...(SUBSTITUTES_FOR[root.item] || [])]) {
                        if (magnet.destination && source === targetItem) continue;
                        // Same fresh fact as Step 3's guard — one item, one pass.
                        if (payload?.chest_empty_for === source) continue;
                        // The door that files a claim has to honour one, subtracting only its own count
                        // (not `availablePool`, whose station set differs from the gate's — Law 16).
                        const inChest = Math.max(0, _getInventoryCount(source, chestInv) - chestLedger.claimedByOthers(source));
                        if (inChest <= 0) continue;
                        const pull = Math.min(inChest, shortfall);
                        // An ingredient is claimed the same way a target is — every craft chain comes
                        // through here. A chest-destination job claims here too: an INPUT the craft
                        // destroys, not the shuffle Step 3 refuses. Released by `_withdrawFromChest` /
                        // `clearMagnet`.
                        const station = chestLedger.stationHolding(source);
                        watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → withdraw ${pull}x ${source} from chest for ${root.item} (chest has ${inChest}, harvest covers any remainder) | ${snap}`);
                        if (station) chestLedger.claim(station, [{ item: source, amount: pull }]);
                        _withdrawFromChest(payload, source, pull);
                        return;
                    }
                }
            }

            const seen = new Set();
            for (const root of missingRoots) {
                if (seen.has(root.item)) continue;
                seen.add(root.item);
                // Never harvest a chain product — reaches the bot by withdrawal only (Step 4a). Skipped,
                // not thrown (an ordinary timing state), falling through to Step 6.
                if (_isChainProduct(root.item, byItem)) continue;
                const trip = _nextTrip(botId, boardroom, magnet, root, inventory, `${targetItem} (have ${have}/${holdGoal})`, payload);
                if (trip === null) return;
                const allRoots = missingRoots.map(r => `${r.item}:${r.need}`).join(',');
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → gather ${trip}x ${root.item} of ${root.need} still wanted (have ${root.have}) | roots=[${allRoots}] | ${snap}`);
                _dispatchGather(payload, root, magnet, trip);
                return;
            }
        }

        // ── Step 5: Need a different biome? ──────────────────────────────
        // A chain product has no recipe either but is not absent — this guard gives one answer to "can I
        // raise this material" alongside Step 4 (Law 16). Falls through to Step 6 → AWAITING CHAIN
        // (Law 25).
        const bp = byItem[targetItem];
        if (!bp && have < holdGoal && !_isChainProduct(targetItem, byItem)) {
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | no blueprint → EXPLORE | ${snap}`);
            _dispatchExplore(payload);
            return;
        }

        // ── Step 6: Nothing possible — a coding violation, not an outcome ────────────
        // A found loop is guarded at its site (Law 13, Law 22), not left for recursive_judge. The board
        // is the only party permitted to refuse an order (Law 16), so reaching here means that
        // certificate was false.
        const rootNames = missingRoots.map(r => r.item).join(',');
        const awaiting = missingRoots.length > 0 && missingRoots.every(r => _isChainProduct(r.item, byItem));

        // A claim that spent the last of a chain product releases the remainder to the board (Law 25,
        // Law 12) — chainGate admits on one craft's cost, and this is that partial-batch design working.
        if (awaiting && payload.executor) {
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | AWAITING CHAIN [${rootNames}] — this claim spent every reachable unit | RELEASE remainder to the board | ${snap}`);
            _releaseJob(`partial ${targetItem} (have ${have}/${holdGoal}) — the remainder waits on [${rootNames}] from its chain`);
            return;
        }

        throw new Error(
            `[${TAG}] CODING VIOLATION: dispatched an order this fragment cannot fill, for ${targetItem} `
            + `(have ${have}/${holdGoal}, from=${from}, roots=[${rootNames}]). `
            + (awaiting
                ? `Every missing root is produced by another chain (smelt/grow/hunt), so no gather can `
                  + `obtain it and this bot can only wait. THE CHAIN GATE SHOULD HAVE HELD THIS ORDER — `
                  + `check job_gates.chainGate covers BOTH the job's own target and its ingredients for `
                  + `every member of FARM_ITEMS / FURNACE_CHAIN_ITEMS.`
                : `No craftable step and no gatherable root. THE BOARD'S REQUIREMENT WALK DID NOT REACH `
                  + `THE SAME LEAVES THIS FULFILLER REACHED — the board must walk the whole chain, not `
                  + `the top recipe, because nothing downstream is allowed to refuse what it clears.`)
            + ` Snapshot: ${snap}`
        );
    }),
};
