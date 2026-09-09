// assessors/furnace — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const inventoryLens = require('@kernel/inventory_lens');
const hq = require('@kernel/corporate_headquarters');
const stationRegistry = require('@perception/station_registry');
const watcher = require('@kernel/watcher');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { isSmeltComplete } = require('@utils/calculators/smelt_calculator');
const {
    underground_items: UNDERGROUND_ITEMS,
    group_to_item: GROUP_TO_ITEM,
    substitutes_for: SUBSTITUTES_FOR,
} = require('@utils/fragment_utils');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    STOCK_THRESHOLDS,
    FUEL_PREFERENCES,
} = require('@thinking/architect_config');

const { TAG, furnaceInput, supplyJob } = require('@thinking/assessors/shared');
// ── SECTION 3.5 — Furnace (async load-and-leave, Phase 3) ──
// Bot never waits out a cook. Two one-shot jobs (load, collect); REGISTERED furnaces only, and every
// registered furnace belongs to a placed blueprint that also carries a chest — a furnace is half of a
// two-part fitting, never a block a bot sets down beside itself (furnace_executor's header carries the
// full argument). The on-disk `smelt` state IS the reservation (Law 6, crash-safe): free = no started_at,
// two sweeps can't double-load, crash mid-cook loses nothing. Collect gate reads the same started_at via
// the pure cook-time calculator — it prices the TRIP, never whether the food is done; window re-checked
// on arrival (Law 13).
function _heldFuel(inventory) {
    for (const pref of FUEL_PREFERENCES) {
        if (countInInventory(pref, inventory) > 0) return pref;
    }
    return null;
}

// In-flight smelt MUST credit toward "have" when loading: the chest fills only on COLLECT (10s/item), so
// between load and collect it reads 0 — uncredited, every sweep loads ANOTHER furnace (10 furnaces → 10
// batches overfilling one 20-charcoal goal). One batch satisfies the order.
function _inFlightSmelt(item, allStations) {
    let n = 0;
    for (const [, e] of Object.entries(allStations)) {
        if (!e || e.type !== 'furnace') continue;
        const s = e.smelt;
        if (s && s.started_at && s.order === item) n += (s.qty || 0);
    }
    return n;
}
// ONE ANSWER TO "WHAT IS SHORT" (Law 16). Returns the FIRST fillable order in table order (the row the
// old single-site loop broke on) together with the underground pulls the unfillable rows above it asked
// for.
// A RECIPE NAMES A CONCRETE ITEM; THE SUPPLY CHAIN GATHERS A GROUP. `furnaceInput('charcoal')` reads the
// recipe and returns `oak_log`, while every gather job the fleet posts for wood says `logs` — so a request
// written in the recipe's vocabulary asks for a token no stock row carries, and the gather that would fill
// it never happens. This is the same group/item seam job_ranking crosses in the other direction (it
// expands a shortfall's group to match a concrete producer); here the request is folded up to the group.
// Falls through to the item itself when it belongs to no group, which is correct for raw_iron and coal.
function _requestToken(item) {
    for (const [group, members] of Object.entries(GROUP_TO_ITEM)) {
        if (Array.isArray(members) && members.includes(item)) return group;
    }
    return item;
}

// A FURNACE BATCH IS ALL-OR-NOTHING, AND THAT IS THE DIFFERENCE BETWEEN A FURNACE AND A CRAFTING TABLE.
// A partial craft at a table costs one extra call; a partial SMELT costs a whole station cycle — walk to
// the furnace with the input, load it, come back when the cook is done, collect, bank the surplus — and
// that cycle is paid per batch, not per item. So a batch of one costs the same trips as a batch of ten
// and yields a tenth of it.
//
// The clamp this replaces was `Math.min(deficit, inputAvail)`, which spent exactly that full cycle on one
// charcoal whenever one log happened to be reachable. What replaces it: smelt the WHOLE deficit or none of
// it, and when the input is short, post a sized request for the input and wait for it (Architect ruling —
// the request is dynamic, computed from the shortfall, not a standing shelf level).
//
// A SHORT ROW NO LONGER DIES SILENTLY. The old surface branch dropped an unfillable deficit with no job
// and no verdict, which is how a dead smelt chain reads as "it just never comes up" rather than as a
// fault — the header of that branch said so and had no route to fix it. Underground inputs convert to a
// mining pull; surface inputs now convert to `inputShort`, which `assess` posts as a gather job. Every
// shortfall now leaves this function as either an order, a pull, or a request (Law 25).
// ── A LIVE ORDER IS A SMELT REQUEST, EXACTLY AS A STOCK ROW IS ───────────────────────────────────────
// The second source, and the one that makes this a process rather than a schedule. A stock row says
// "always have this much on the shelf"; a live order says "I am short of this much RIGHT NOW, for
// something". Both are demand and both size a cook, but only the row could ever reach this function —
// so a bot that needed three charcoal for its own torches had no way to ask for three, and the only
// charcoal request in the fleet was a shelf's request for ten. It borrowed the shelf's errand, ran it at
// the shelf's size, and delivered to the shelf; its own pocket ended empty and its torches were never
// made. Demand that is derived cannot be expressed as a row, so the row was standing in for it badly.
//
// SHAPED AS A ROW SO THE BODY BELOW IS UNCHANGED (Law 16): a demand candidate and a row candidate differ
// only in where the number came from, and every rule after that — in-flight credit, whole-batch-or-none,
// underground pull vs surface request — must apply identically or there are two smelt policies.
//
// `deficit_below` FROM DEMAND IS THE WANT ITSELF, AND THE BODY NETS STOCK OFF IT. The board publishes
// `materials_wanted` GROSS — its own note says so and says every consumer nets it — so what arrives here
// is the whole requirement of the live orders, with no credit for what the fleet already holds.
//
// THE WRONG TURN, NAMED, BECAUSE IT LOOKS LIKE THE CAREFUL ONE: setting the floor to `have + wanted`
// makes the body's `deficit_below - have` cancel `have` and cook the full want whatever is on the shelf.
// That is right only if the want arrived already netted, and it does not. Twelve torches want three
// charcoal; a fleet holding one coal then cooks three instead of two, and the mined coal is paid for
// again in logs and station time. Coal is spendable wherever charcoal is (`substitutes_for`), so stock
// of either is stock against this want.
//
// The floor is the want. `have` is measured below (fleet-wide, plus what is already mid-cook) and
// subtracted once, which is the only subtraction there should be.
//
// MEASURED FLEET-WIDE, NEVER ON THE POCKET, and that is what keeps one furnace serving two bots. Charcoal
// a peer banked already answers the order — the asker withdraws it — so posting a cook for material that
// exists would burn logs to duplicate stock the fleet is holding. It is also what makes the emptier's
// dump the handover: bank it, and the next sweep sees the demand already met.
// A SUBSTITUTE COUNTS AS STOCK HERE, WHICH IS WHAT MAKES THE ORDER SHRINK INSTEAD OF THE ERRAND CHANGE
// (see `substitutes_for` in fragment_utils for why the table exists at all, and why the one table is
// shared rather than copied per reader). Twelve torches want three units; one coal on the shelf leaves
// two to cook. Without the sum the fleet cooks three and pays for the already-mined coal a second time in
// logs and station time.
function _demandRows(wanted) {
    const rows = [];
    for (const [token, count] of Object.entries(wanted || {})) {
        if (!(count > 0)) continue;
        const item = _smeltableFor(token);
        if (!item) continue;
        let have = inventoryLens.reachableByFleet(token);
        for (const alt of (SUBSTITUTES_FOR[item] || [])) have += inventoryLens.reachableByFleet(alt);
        rows.push({ item, deficit_below: count, holder: 'storage', _fromDemand: true, _have: have });
    }
    return rows;
}

// _fleetWanted() → { token: count } summed across EVERY bot's boardroom chair, this bot's included.
//
// THE FURNACE IS A SHARED PRODUCER, SO ITS ORDER IS THE FLEET'S TOTAL. Two bots each wanting twelve
// torches want six charcoal between them, and one cook should make all six — sizing a batch off one bot's
// demand lights the furnace twice for half a load each, wasting the fuel and the station's time, and the
// station is the scarce thing here. Every bot writes only its own chair (Invariant D) and the whole chair
// rides the ordinary broadcast, so summing the chairs is the demand read with no second sync channel.
//
// GROSS TOTAL, NETTED BY THE CALLER. Two bots wanting three charcoal each are two real needs, not a
// double-count of one: netting belongs where what-is-already-covered is known (Law 25 — the criterion is
// the asker's). A chair with no demand field contributes nothing, which is correct for a bot that has not
// swept yet and is not a defaulted field.
function _fleetWanted() {
    const total = {};
    for (const chair of Object.values(hq.getFullBoardroom({}) || {})) {
        for (const [token, count] of Object.entries(chair?.materials_wanted || {})) {
            if (count > 0) total[token] = (total[token] || 0) + count;
        }
    }
    return total;
}

// A recipe may ask for a GROUP while only one member of it is smeltable, so a demand read literally names
// a token no furnace can produce. Resolves to the first member with a furnace recipe —
// the same group-then-member resolution the recipe walks use, asked here because a demand arrives in the
// recipe's vocabulary rather than the world's.
function _smeltableFor(token) {
    if (furnaceInput(token)) return token;
    for (const member of (GROUP_TO_ITEM[token] || [])) {
        if (furnaceInput(member)) return member;
    }
    return null;
}

function _smeltDemand(inventory, allStations, buildClaim, wanted) {
    const pulls = {};
    const inputShort = {};
    for (const stock of [...STOCK_THRESHOLDS, ..._demandRows(wanted)]) {
        if (stock.deficit_below == null) continue;
        const input = furnaceInput(stock.item);
        if (!input) continue;                                   // not furnace-produced
        // storage -> the chest system; bot -> pocket; either way ADD in-flight (see _inFlightSmelt).
        const isStorage = stock.holder === 'storage';
        // System-wide: a storage row asks whether the FLEET is short, never whether one chest is — there
        // is no per-chest question left to ask. Bot rows still measure the pocket: the bot layer is the
        // bottom one, and a chest full of charcoal must send a bot to fetch it rather than report the bot
        // already stocked.
        // A storage row is the storage LAYER, so it subtracts the layers beneath it (inventory_lens'
        // forChestRequest): charcoal a build has already ordered is not charcoal storage can spend.
        // A demand row already measured itself fleet-wide (see _demandRows) and carries the figure, so
        // re-measuring it here through a holder branch it does not belong to would answer a different
        // question with the same name (Law 7).
        const have = (stock._fromDemand
            ? stock._have
            : isStorage
                ? inventoryLens.forChestRequest(stock.item, buildClaim)
                : countInInventory(stock.item, inventory))
            + _inFlightSmelt(stock.item, allStations);
        if (have >= stock.deficit_below) continue;
        const deficit = stock.deficit_below - have;
        const inputAvail = inventoryLens.reachableByFleet(input);
        // SHORT OF A WHOLE BATCH IS TREATED EXACTLY LIKE HAVING NONE, because for a station whose cost is
        // paid per cycle those two states buy the same thing: a trip that does not finish the order. An
        // underground input (raw_iron) converts to a mining pull; a surface input converts to a sized
        // request for the remainder, which is the route that did not exist before.
        if (inputAvail < deficit) {
            if (UNDERGROUND_ITEMS.has(input)) pulls[input] = Math.max(pulls[input] || 0, deficit);
            else {
                const token = _requestToken(input);
                inputShort[token] = Math.max(inputShort[token] || 0, deficit - inputAvail);
            }
            continue;
        }
        // The whole deficit, never a fraction of it. The executor still re-bounds this against what it
        // ends up holding, so this stays an upper bound rather than a promise.
        return { order: { item: stock.item, input, qty: deficit }, pulls, inputShort };
    }
    return { order: null, pulls, inputShort };
}

function assess({ inventory, buildClaim }) {
    const jobs = [];
    const pullNeeded = {};
    const allStations = stationRegistry.getStations();
    const furnaces = Object.entries(allStations).filter(([, e]) => e && e.type === 'furnace');

    // EVERY FURNACE IS A BUILDING'S FURNACE NOW, so there is no field/blueprint ordering left to state.
    // The field furnace and its collect-time recovery are deleted: a furnace on open ground has no chest
    // coupled to it, so its batch could never be handed to the peer that asked for it (furnace_executor's
    // header carries the coupling in full, and its Law 13 assertion enforces it).

    // COLLECT — any furnace whose recorded batch is cooked (calculator over the on-disk start).
    for (const [id, entry] of furnaces) {
        const st = entry.smelt;
        if (!st || !st.started_at || !st.order) continue;
        if (isSmeltComplete(st.started_at, st.order, st.qty || 1)) {
            jobs.push({
                id: `furnace_collect_${id}`, type: 'furnace', what: st.order,
                where: entry.pos, station_id: id, order: st.order, batch_quantity: st.qty || 1,
                job_type: JOB_TYPE.furnace_collect,
                claimed_by: null, action: 'collect', scope: 'shared',
            });
        }
    }

    const freeFurnace = furnaces.find(([, e]) => !e.smelt || !e.smelt.started_at);

    // A load posts only once a preferred fuel is on hand, so a logs-only state never reaches the
    // executor.
    //
    // THE FUEL CHECK NO LONGER DOUBLES AS A FURNACE CHECK, and that coupling was a Law 25 silence. It
    // read the fuel only when a furnace was already free or carried, so the state "there is a real
    // smelt order and no furnace anywhere" fell out of this function with no job, no verdict and no
    // line in the trace — a shortfall answered with nothing, which a reader cannot tell apart from a
    // chain nobody ever asked for. The verdict below is what puts that state into the record now.
    const fuelPref = _heldFuel(inventory);
    // THE DEMAND IS MEASURED WHETHER OR NOT FUEL IS HELD, and only the LOAD/PLACE jobs below wait on fuel.
    // Measuring it inside the fuel branch made the input request unreachable in the one state that needs
    // it most: a bot short of logs is short of plank fuel too, so the request that would fetch the logs
    // was gated behind having already fetched them.
    // LAST SWEEP'S WANT, DELIBERATELY, AND IT IS NOT STALE STATE. The board writes this at the END of a
    // sweep, after the gates, so the only demand available while assessors run is the previous one — and
    // that is the correct input rather than a compromise: a want is a standing condition that survives a
    // sweep (an order short of charcoal is still short a second later), and the smelt it sizes is checked
    // against fleet stock measured FRESH at the moment of use (Invariant B — the number that could have
    // moved is re-sensed; the one that could not is read). Asking the board to publish demand mid-sweep
    // would make the assessors depend on their own output one pass round.
    const wanted = _fleetWanted();
    const demand = _smeltDemand(inventory, allStations, buildClaim, wanted);
    Object.assign(pullNeeded, demand.pulls);

    // THE DYNAMIC INPUT REQUEST — a gather sized to the batch's shortfall, into the POCKET, in the bot
    // band (`resource_baseline`). Dynamic rather than a standing shelf level: it is computed fresh from
    // this sweep's deficit and stops posting the moment the gap closes, exactly as the build's own
    // material order does (assessors/building's bootstrap branch is the shape this mirrors, Law 16).
    for (const [item, gap] of Object.entries(demand.inputShort)) {
        if (gap <= 0) continue;
        const held = countInInventory(item, inventory);
        jobs.push(supplyJob({
            id: `smelt_supply_${item}`, what: item, need: gap,
            where: null,
            job_type: JOB_TYPE.resource_baseline,
            claimed_by: null,
            hold_goal: held + gap,
            at_destination: held,
            category: 'resource', scope: 'local',
        }));
    }
    if (demand.inputShort && Object.keys(demand.inputShort).length) {
        watcher.summary(TAG, `↳ dynamic smelt-input request posted: `
            + Object.entries(demand.inputShort).map(([i, g]) => `${g}x ${i}`).join(' | ')
            + ' — a partial furnace batch costs a whole station cycle, so the batch waits for its input');
    }

    if (fuelPref) {
        if (demand.order && freeFurnace) {
            const [freeId, freeEntry] = freeFurnace;
            jobs.push({
                id: `furnace_load_${freeId}`, type: 'furnace', what: demand.order.item,
                where: freeEntry.pos, station_id: freeId,
                order: demand.order.item, input: demand.order.input, fuel: fuelPref,
                batch_quantity: demand.order.qty,
                job_type: JOB_TYPE.furnace_load,
                claimed_by: null, action: 'load', scope: 'shared',
            });
        } else if (demand.order) {
            // NO FREE FURNACE, AND NO JOB THIS ASSESSOR CAN POST TO MAKE ONE — the state that used to
            // post a `place` job out of the pocket. The pocket furnace is gone: the only furnace this
            // fleet uses stands in a placed blueprint that also carries a chest, because a batch is
            // sized for the WHOLE fleet and the emptier must be able to bank a peer's share somewhere
            // (furnace_executor's header carries the coupling; its Law 13 assertion enforces it). A
            // furnace on open ground has no chest beside it, so every batch it cooked would be
            // unshareable by construction.
            //
            // A VERDICT AND NOT A JOB, DELIBERATELY. The route to a standing furnace already exists and
            // belongs to somebody else — the headframe's own anchor 0 orders it as build material, and
            // assessors/building posts that. A second job here asking for the same block would be the
            // redundant pathway Law 16 refuses, and it is the pathway that would put a furnace somewhere
            // no chest is. But the SHORTFALL still has to reach the record (Law 25): a real smelt order
            // that nothing can act on must be legible as a wait on a named thing, never as an absence.
            watcher.summary(TAG, `↳ smelt order held: ${demand.order.qty}x ${demand.order.item} `
                + `— ${furnaces.length === 0
                    ? 'NO furnace stands in the fleet; the base blueprint\'s own furnace is the only route to one (there is no pocket furnace)'
                    : `all ${furnaces.length} registered furnace(s) are mid-cook`}`);
        }
    }

    return { jobs, pullNeeded };
}

module.exports = { name: 'furnace', assess };
