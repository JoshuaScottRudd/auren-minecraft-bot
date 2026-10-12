// assessors/furnace — cold/loading/collecting jobs for the fleet's shared smelt stations. See assessor_registry.

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
    homeChest,
} = require('@utils/fragment_utils');

// Tunables imported from architect_config, never restated (Law 16 — one source).
const {
    JOB_TYPE,
    FUEL_PREFERENCES,
} = require('@thinking/architect_config');

const { TAG, furnaceInput, supplyJob, deliverScope } = require('@thinking/assessors/shared');
// ── SECTION 3.5 — Furnace (async load-and-leave, Phase 3) ──
// Two one-shot jobs, load and collect, for REGISTERED furnaces only — each belongs to a placed
// blueprint that also carries a chest (furnace_executor). `smelt.started_at` on disk IS the
// reservation (Law 6): unset means free, so two sweeps can't double-load and a crash loses nothing.
function _heldFuel(inventory) {
    for (const pref of FUEL_PREFERENCES) {
        if (countInInventory(pref, inventory) > 0) return pref;
    }
    return null;
}

// Sums the item's already-started, not-yet-collected batches across every furnace — credited toward
// "have" so a load pass doesn't re-order a batch that's still cooking.
function _inFlightSmelt(item, allStations) {
    let n = 0;
    for (const [, e] of Object.entries(allStations)) {
        if (!e || e.type !== 'furnace') continue;
        const s = e.smelt;
        if (s && s.started_at && s.order === item) n += (s.qty || 0);
    }
    return n;
}

// A furnace batch is all-or-nothing: a partial smelt still pays the full station cycle (walk, load,
// wait, collect, bank), so a short input converts to a pull (underground) or a dynamic request
// (surface), never a fractional smelt — every shortfall leaves this function as an order, a pull,
// or a request (Law 25).
// ── A LIVE ORDER IS A SMELT REQUEST, EXACTLY AS A STOCK ROW IS ──
// Shapes each fleet-wanted token into a row like a stock row (item, deficit_below, holder) so in-flight
// credit, whole-batch-or-none, and pull-vs-request apply identically below (Law 16); `have` nets fleet
// stock of the item and its substitutes against the raw (gross) want.
function _demandRows(wanted, owedInFull = {}) {
    const rows = [];
    // Owed in full first: the asker already counted the fleet's stock of this very item, substitutes left
    // out, so the whole figure is still to be made and only a batch already cooking comes off it.
    for (const [token, count] of Object.entries(owedInFull)) {
        if (!(count > 0)) continue;
        const item = _smeltableFor(token);
        if (item) rows.push({ item, deficit_below: count, holder: 'storage', _fromDemand: true, _have: 0 });
    }
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

// The fleet's want per token is the LARGEST any chair publishes (Invariant D), gross and unnetted. Every
// body sweeps the same fleet orders (a building's window, the shelf) and publishes them whole, so each
// chair already carries the fleet's figure; adding the chairs together counts one order once per body.
function _fleetWanted(field = 'materials_wanted') {
    const total = {};
    for (const chair of Object.values(hq.getFullBoardroom({}) || {})) {
        for (const [token, count] of Object.entries(chair?.[field] || {})) {
            if (count > 0) total[token] = Math.max(total[token] || 0, count);
        }
    }
    return total;
}

// Resolves a demand token (may name a group) to the first member with a furnace recipe — the same
// group-then-member resolution the recipe walks use.
function _smeltableFor(token) {
    if (furnaceInput(token)) return token;
    for (const member of (GROUP_TO_ITEM[token] || [])) {
        if (furnaceInput(member)) return member;
    }
    return null;
}

// The fleet's units of what a furnace may be loaded with to make `output`: the recipe's `inputs` list
// (smeltInputsFor), the same list furnace_executor fetches and loads from.
function _smeltableInput(output) {
    return inventoryLens.reachableByFleet(require('@kernel/crafting_blueprint_registry').smeltInputsFor(output));
}

const ALWAYS_SMELTED = ['iron_ingot', 'copper_ingot', 'gold_ingot'];
function _smeltDemand(inventory, allStations, buildClaim, wanted, owed) {
    const pulls = {};
    const inputShort = {};
    // Every smelt the fleet can start now, one per item, in table order: whole deficits first, then the
    // partial batches the input on hand can fill. Each is offered its own furnaces.
    const whole = [];
    const partials = [];
    const ordered = new Set();
    for (const stock of [...require('@thinking/requested_work').activeStockRows(), ..._demandRows(wanted, owed)]) {
        if (stock.deficit_below == null || ordered.has(stock.item)) continue;
        const input = furnaceInput(stock.item);
        if (!input) continue;                                   // not furnace-produced
        // storage rows measure fleet-wide chest stock (nets layers beneath, forChestRequest); bot rows
        // measure the pocket, the bottom layer. A demand row skips both — it already carries its own
        // fleet-wide figure (Law 7). Either way, in-flight batches (_inFlightSmelt) credit on top.
        const isStorage = stock.holder === 'storage';
        const have = (stock._fromDemand
            ? stock._have
            : isStorage
                ? inventoryLens.forChestRequest(stock.item, buildClaim)
                : countInInventory(stock.item, inventory))
            + _inFlightSmelt(stock.item, allStations);
        if (have >= stock.deficit_below) continue;
        const deficit = stock.deficit_below - have;
        const inputAvail = _smeltableInput(stock.item);
        // ── A SHORT INPUT SPLITS ACROSS FEWER FURNACES, NEVER STALLS THE ORDER ──
        // A partial input fills fewer furnaces fully, never one partially (the pledge rule, Law 25);
        // the shortfall still posts as a pull or request. furnace_executor re-bounds qty against what's
        // actually on hand, so a short batch is already a legal outcome there.
        if (inputAvail < deficit) {
            if (require('@utils/fragment_utils').isUnderground(input)) {
                // The mine is asked for the shortfall only, and what is already up cooks now.
                pulls[input] = Math.max(pulls[input] || 0, deficit - inputAvail);
                if (inputAvail > 0) { partials.push({ item: stock.item, input, qty: inputAvail }); ordered.add(stock.item); }
            } else {
                // Requested exactly as the recipe names it: the book already writes wood as `logs`, and a
                // member folded into the first group holding it lands in a classification (sand in
                // pillar_block) that no gather can fill.
                const token = input;
                const short = deficit - inputAvail;
                // Carries `for` (what wanted it) alongside the amount — a bare token loses the fact that
                // decides the request's band, and the job below needs a real asker to name, not a category.
                const prev = inputShort[token];
                if (!prev || short > prev.amount) inputShort[token] = { amount: short, for: stock.item };
                // A finishable batch outranks a partial one regardless of table order.
                if (inputAvail > 0) { partials.push({ item: stock.item, input, qty: inputAvail }); ordered.add(stock.item); }
            }
            continue;
        }
        // The whole deficit, never a fraction of it. The executor still re-bounds this against what it
        // ends up holding, so this stays an upper bound, not a guarantee.
        whole.push({ item: stock.item, input, qty: deficit });
        ordered.add(stock.item);
    }
    // ── RAW ORE IS ALWAYS SMELTED ──
    // Every unit of raw ore the fleet can reach is ordered into a furnace whether or not anything asked for
    // the ingot: an ingot is the only form ore is used in, and it is the form the chests keep. An order the
    // loop above already made for the ingot is raised to the ore on hand.
    for (const ingot of ALWAYS_SMELTED) {
        const input = furnaceInput(ingot);
        const avail = input ? _smeltableInput(ingot) : 0;
        if (!(avail > 0)) continue;
        const made = [...whole, ...partials].find(o => o.item === ingot);
        if (made) made.qty = Math.max(made.qty, avail);
        else whole.push({ item: ingot, input, qty: avail });
    }
    return { orders: [...whole, ...partials], pulls, inputShort };
}

// _assignFurnaces(orders, free, stackOf) → [{ order, stations, share }]. Every order first gets the furnaces its
// whole stacks need, smallest order first; furnaces left over then go round the orders one at a time, so a small
// order cooks faster across several furnaces. No furnace is loaded past one stack.
function _assignFurnaces(orders, free, stackOf) {
    // SMALLEST ORDER FIRST: a few ingots are cooked and out, where a standing stone order would take every
    // furnace that frees, sweep after sweep.
    const plan = [...orders].sort((a, b) => a.qty - b.qty).map(order => ({ order, stations: 0 }));
    let left = free;
    for (const p of plan) {
        const take = Math.min(left, Math.ceil(p.order.qty / stackOf(p.order.item)));
        p.stations += take;
        left -= take;
    }
    let grew = true;
    while (left > 0 && grew) {
        grew = false;
        for (const p of plan) {
            if (left > 0 && p.stations > 0 && p.stations < p.order.qty) { p.stations++; left--; grew = true; }
        }
    }
    return plan.filter(p => p.stations > 0)
        .map(p => ({ ...p, share: Math.min(stackOf(p.order.item), Math.ceil(p.order.qty / p.stations)) }));
}

function assess({ inventory, buildClaim }) {
    const jobs = [];
    const pullNeeded = {};
    const allStations = stationRegistry.getStations();
    const furnaces = Object.entries(allStations).filter(([, e]) => e && e.type === 'furnace');

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

    // ── EVERY COLD FURNACE IS A SEAT ──
    // One job per cold furnace, id'd by the furnace itself (`furnace_load_<id>`) with `scope: 'shared'`
    // giving each exactly one owner — the lane/tree-seat model (Law 16: where the work is already named,
    // the name is the lock).
    const freeFurnaces = furnaces.filter(([, e]) => !e.smelt || !e.smelt.started_at);

    // A load posts once fuel is banked (the loader fetches it) or a preferred fuel is in this pocket.
    // Demand is measured independently of fuel below, so a smelt order with no furnace anywhere still
    // reaches a verdict (Law 25) and never falls out silently.
    const banked = require('@action/furnace_executor').bankedFuel();
    const fuelPref = banked ? banked.pref : _heldFuel(inventory);
    // Demand is measured whether or not fuel is held — only the load job below waits on fuel, so a
    // logs-short bot can still be asked to fetch its own fuel. Reads last sweep's want (the board
    // publishes after the gates), checked against fleet stock measured fresh here (Invariant B).
    const wanted = _fleetWanted();
    const owed = _fleetWanted('materials_wanted_net');
    const demand = _smeltDemand(inventory, allStations, buildClaim, wanted, owed);
    Object.assign(pullNeeded, demand.pulls);

    // ── THE DYNAMIC INPUT REQUEST — THE BUILDING'S LOGS, NOT THE BODY'S ──
    // Posts the smelt's short input as a building bill, not a bot baseline (Law 16, same shape as
    // assessors/building's own bill): with a pool chest, one delivery order for the fleet total; with
    // none yet, falls back to the pocket sum as the bootstrap case.
    const poolChest = homeChest();
    const postedInput = [];
    const { tripYieldFor } = require('@utils/calculators/yield_pledge_calculator');
    // The building a demand-driven smelt serves: a builder's downloaded building is the one structure
    // publishing a window order, and its name places the input among that building's own gathers (job_ranking's
    // site walk). A stock-row smelt names no structure and ranks as site-less shelf work.
    const demandSite = require('@thinking/assessors/downloaded_build').buildName();
    const buildLevel = require('@thinking/assessors/downloaded_build').familyLevel;
    const demandItems = new Set(_demandRows(wanted).map(r => r.item));
    const { absentNearby } = require('@action/harvest_executor');
    const absent = [];
    for (const [item, short] of Object.entries(demand.inputShort)) {
        if (short.amount <= 0) continue;
        // A gather the whole loaded world just came back empty for is not re-offered until the note
        // expires; the smelt it feeds waits, and every other order carries on.
        if (absentNearby(item)) { absent.push(item); continue; }
        // A gathered input is ordered in whole pledges (sand for glass): every seat is one full trip, and the
        // surplus waits in the pool for the next smelt.
        const unit = tripYieldFor(item);
        const gap = unit ? Math.ceil(short.amount / unit) * unit : short.amount;
        // The asker named in full: the smelt this wood is for, which is itself a building's torch stock.
        const asker = `blueprint:smelt_${short.for}`;
        const structure = (demandSite && demandItems.has(short.for)) ? demandSite : undefined;
        if (poolChest) {
            jobs.push(supplyJob({
                id: `smelt_supply_${item}`, what: item, need: gap, structure,
                where: poolChest.station.pos,
                station_id: poolChest.id,
                destination: 'storage',
                job_type: JOB_TYPE.smelt_input_supply,
                claimed_by: null,
                // Pool delivery: the body's pocket isn't part of the figure, so one asker, one number.
                hold_goal: gap, at_destination: 0,
                parts: [{ who: asker, amount: gap }],
                // Called dynamically, not hardcoded, so a future craftable input moves scope with it.
                category: 'resource', action: 'deliver', scope: deliverScope(item),
                // A building's smelt input is chosen among that building's gathers by the same figure they state.
                ...(structure && Number.isFinite(buildLevel(item)) ? { level: buildLevel(item) } : {}),
            }));
            postedInput.push(`${gap}x ${item} for ${short.for} → pool chest`);
        } else {
            const held = countInInventory(item, inventory);
            jobs.push(supplyJob({
                id: `smelt_supply_${item}`, what: item, need: gap,
                where: null,
                job_type: JOB_TYPE.smelt_input_supply,
                claimed_by: null,
                // Pocket fallback: held + gap, both terms named so the total stays traceable (Law 29).
                hold_goal: held + gap,
                at_destination: held,
                parts: [
                    { who: `bot:pocket_carried_${item}`, amount: held },
                    { who: asker, amount: gap },
                ],
                category: 'resource', scope: 'local',
            }));
            postedInput.push(`${gap}x ${item} for ${short.for} → pocket (no chest yet)`);
        }
    }
    if (postedInput.length) {
        watcher.summary(TAG, `↳ dynamic smelt-input request posted: ${postedInput.join(' | ')}`
            + ' — a partial furnace batch costs a whole station cycle, so the batch waits for its input');
    }
    if (absent.length) {
        watcher.summary(TAG, `↳ smelt input not ordered: ${absent.join(', ')} — the loaded world held none on the last deep scan`);
    }

    if (fuelPref) {
        if (demand.orders.length && freeFurnaces.length > 0) {
            // Each order takes the furnaces _assignFurnaces gives it, one stack at most per load — an upper bound
            // the executor re-bounds against what the body actually carries. `_inFlightSmelt` shrinks next
            // sweep's orders as furnaces catch, so nothing tracks what was handed out.
            const itemsByName = require('minecraft-data')(require('@thinking/architect_config').SERVER_MINECRAFT_VERSION).itemsByName;
            const stackOf = item => itemsByName[item]?.stackSize || 64;
            let next = 0;
            for (const { order, stations, share } of _assignFurnaces(demand.orders, freeFurnaces.length, stackOf)) {
                for (const [freeId, freeEntry] of freeFurnaces.slice(next, next + stations)) {
                    jobs.push({
                        id: `furnace_load_${freeId}`, type: 'furnace', what: order.item,
                        where: freeEntry.pos, station_id: freeId,
                        order: order.item, input: order.input, fuel: fuelPref,
                        batch_quantity: share,
                        job_type: JOB_TYPE.furnace_load,
                        claimed_by: null, action: 'load', scope: 'shared',
                    });
                }
                next += stations;
                watcher.summary(TAG, `↳ ${order.qty}x ${order.item} on ${stations} of ${freeFurnaces.length} cold furnace(s) — ${share} each`);
            }
        } else if (demand.orders.length) {
            // No free furnace, and no job here can make one — every furnace this fleet uses stands in a
            // placed blueprint with a chest (assessors/building posts that route; Law 16). Posts a
            // verdict so a real order with nothing to act on it still reaches the record (Law 25).
            watcher.summary(TAG, `↳ smelt order held: ${demand.orders.map(o => `${o.qty}x ${o.item}`).join(', ')} `
                + `— ${furnaces.length === 0
                    ? 'NO furnace stands in the fleet; the base blueprint\'s own furnace is the only route to one (there is no pocket furnace)'
                    : `all ${furnaces.length} registered furnace(s) are mid-cook`}`);
        }
    }

    // A smelt's mined input ranks with what wanted the smelt — the same place its gathered input is posted.
    return { jobs, pullNeeded, pullAsker: { job_type: JOB_TYPE.smelt_input_supply,
        structure: require('@thinking/assessors/downloaded_build').buildName() } };
}

module.exports = { name: 'furnace', assess };
