// assessors/furnace — cold/loading/collecting jobs for the fleet's shared smelt stations. See assessor_registry.

'use strict';

const inventoryLens = require('@kernel/inventory_lens');
const hq = require('@kernel/corporate_headquarters');
const stationRegistry = require('@perception/station_registry');
const watcher = require('@kernel/watcher');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { smeltCookedBy } = require('@utils/calculators/smelt_calculator');
const { charcoalFor } = require('@utils/calculators/fuel_calculator');
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

// A short input is cooked as far as it goes, and the rest converts to a pull (underground) or a dynamic
// request (surface) — every shortfall leaves this function as an order, a pull, or a request (Law 25).
// ── A LIVE ORDER IS A SMELT REQUEST, EXACTLY AS A STOCK ROW IS ──
// Shapes each fleet-wanted token into a row like a stock row (item, deficit_below, holder) so in-flight
// credit, the batch on hand, and pull-vs-request apply identically below (Law 16); `have` nets fleet
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

// The fleet's figure for a body's own want: every chair's added together, since each body asks for itself.
function _fleetSummed(field) {
    const total = {};
    for (const chair of Object.values(hq.getFullBoardroom({}) || {})) {
        for (const [token, count] of Object.entries(chair?.[field] || {})) {
            if (count > 0) total[token] = (total[token] || 0) + count;
        }
    }
    return total;
}

// ── THE DOWNLOADED BUILDING IS SMELTED FOR A LAYER AT A TIME ────────────────────────────────────────
// The building's share of the fleet's want is the whole building (job_board publishes it apart); it is taken out
// and the building's layer target (downloaded_build.smeltPlan) is put in its place, walked through the recipe
// book the same way job_board walks every order. Gathering is untouched: the mine and the gathers still work for
// the whole building.
function _byLayer(wanted, owed, plan) {
    if (!plan) return { wanted, owed };
    const { requirementTree } = require('@utils/calculators/build_material_calculator');
    const castle = _fleetWanted('materials_wanted_castle');
    const castleNet = _fleetWanted('materials_wanted_castle_net');
    const w = { ...wanted };
    const o = { ...owed };
    for (const [token, n] of Object.entries(castle)) w[token] = Math.max(0, (w[token] || 0) - n);
    for (const [token, n] of Object.entries(castleNet)) o[token] = Math.max(0, (o[token] || 0) - n);
    for (const [raw, n] of Object.entries(plan.target)) {
        for (const [token, m] of Object.entries(requirementTree(raw, n, {}))) w[token] = (w[token] || 0) + m;
    }
    return { wanted: w, owed: o };
}

// ── WHAT A SMELT LEAVES IN THE CHESTS ───────────────────────────────────────────────────────────────
// keep(inputs) → the units of a furnace input no smelt may take: what the building's stocked layers are counted
// on (smeltPlan.reserve), the stack kept for tools and furnaces (smeltPlan.floor), and what a stone tool would
// cost every body that has none (supply.stoneToolBill). `inputs` is one name or the input's every member; a tool
// token speaking for any of them is kept once, never once per member (charcoal takes 27 woods, so a group token
// counted per member holds back many times its own figure).
function _keeper(plan) {
    const tools = _fleetSummed('materials_wanted_tools');
    const reserve = plan ? plan.reserve : {};
    const floor = (plan && plan.floor) || {};
    return (inputs) => {
        const names = Array.isArray(inputs) ? inputs : [inputs];
        let n = names.reduce((k, name) => k + (reserve[name] || 0) + (floor[name] || 0), 0);
        for (const [token, count] of Object.entries(tools)) {
            if (names.some(name => token === name || (GROUP_TO_ITEM[token] || []).includes(name))) n += count;
        }
        return n;
    };
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
// Less what other bodies have claimed in the chests: the withdrawal door hands over none of that, so a
// load posted on it would be refused at the chest. Less what a smelt leaves in the chests (`keep`, _keeper).
function _smeltableInput(output, keep) {
    const inputs = require('@kernel/crafting_blueprint_registry').smeltInputsFor(output);
    const ledger = require('@perception/chest_ledger');
    const names = Array.isArray(inputs) ? inputs : [inputs];
    const claimed = ledger.claimedByOthers(names) + keep(names);
    return Math.max(0, inventoryLens.reachableByFleet(inputs) - claimed);
}

// ── A FURNACE NEVER WAITS FOR A FULL STACK ──────────────────────────────────────────────────────────
// batchOf(order, input) → how much of an order the furnaces take now: all of it the input on hand covers. A small
// batch costs a station cycle for few items, but a cold furnace beside input it could cook makes nothing at all,
// and everything downstream (charcoal, torches, the mine) waits on it; the rest is cooked as its input arrives.
function batchOf(order, input) {
    return Math.min(order, input);
}

// ── THE CHARCOAL ROW CARRIES THE BUILDING'S FUEL ────────────────────────────────────────────────────
// _buildingSmelts(wanted, owed) → the items the fleet's orders still need out of a furnace, every one: the whole
// building (stone, smooth stone, iron for bars and trapdoors, glass), not the layer the furnaces work on now, each
// step of a chain counted (smooth stone wants its stone smelted first). Fuel orders are left out: charcoalFor
// already pays for the charcoal's own cooking. Each item counted once, at the larger of its two orders.
function _buildingSmelts(wanted, owed) {
    const left = {};
    for (const row of _demandRows(wanted, owed)) {
        if (FUEL_PREFERENCES.includes(row.item)) continue;
        left[row.item] = Math.max(left[row.item] || 0, row.deficit_below - row._have);
    }
    return Object.values(left).reduce((n, k) => n + Math.max(0, k), 0);
}

const BASE_STOCKED_INGOTS = ['iron_ingot', 'copper_ingot', 'gold_ingot'];
const INGOT_BASE_STACKS = 2;
function _smeltDemand(inventory, allStations, buildClaim, wanted, owed, keep, homeStands, buildingFuel = 0) {
    const stackSizes = require('minecraft-data')(require('@thinking/architect_config').SERVER_MINECRAFT_VERSION).itemsByName;
    const stackOf = item => stackSizes[item]?.stackSize || 64;
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
        if (input === 'cobblestone' && !homeStands) continue;   // no stone is smelted before the crew's home stands: every block is the home's
        // storage rows measure fleet-wide chest stock (nets layers beneath, forChestRequest); bot rows
        // measure the pocket, the bottom layer. A demand row skips both — it already carries its own
        // fleet-wide figure (Law 7). Either way, in-flight batches (_inFlightSmelt) credit on top.
        // A storage row counts its substitutes in the chests as its own (coal on the charcoal row).
        const isStorage = stock.holder === 'storage';
        const have = (stock._fromDemand
            ? stock._have
            : isStorage
                ? [stock.item, ...(SUBSTITUTES_FOR[stock.item] || [])].reduce((n, i) => n + inventoryLens.forChestRequest(i, buildClaim), 0)
                : countInInventory(stock.item, inventory))
            + _inFlightSmelt(stock.item, allStations);
        // The chests' charcoal row stands on top of the building's fuel (_buildingSmelts): its level is the standing
        // shelf plus the charcoal every smelt still owed burns. Coal the mine turns up counts toward it as charcoal.
        const level = stock.item === 'charcoal' && !stock._fromDemand ? stock.deficit_below + buildingFuel : stock.deficit_below;
        if (have >= level) continue;
        const deficit = level - have;
        const inputAvail = _smeltableInput(stock.item, keep);
        const qty = batchOf(deficit, inputAvail);
        // ── A SHORT INPUT COOKS WHAT IT HAS, NEVER STALLS THE ORDER ──
        // What is on hand is loaded now and the shortfall posts as a pull or request. furnace_executor
        // re-bounds qty against what's actually on hand, so a short batch is already a legal outcome there.
        if (inputAvail < deficit) {
            if (require('@utils/fragment_utils').isUnderground(input)) {
                // The mine is asked for the shortfall only, and what is already up cooks now.
                pulls[input] = Math.max(pulls[input] || 0, deficit - inputAvail);
                if (qty > 0) { partials.push({ item: stock.item, input, qty }); ordered.add(stock.item); }
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
                if (qty > 0) { partials.push({ item: stock.item, input, qty }); ordered.add(stock.item); }
            }
            continue;
        }
        // The whole deficit. The executor still
        // re-bounds this against what it ends up holding, so this stays an upper bound, not a guarantee.
        if (qty > 0) { whole.push({ item: stock.item, input, qty }); ordered.add(stock.item); }
    }
    // ── A COLD FURNACE COOKS CHARCOAL WITH NOBODY ASKING ──
    // With logs to spare and the chests under the row's fill_to, charcoal is made ahead of any order, however few.
    // A large load holds nothing back from the torches: a furnace is emptied mid-cook for a body waiting on fuel.
    // It asks for no logs and comes after every asked order.
    const charcoalRow = require('@thinking/requested_work').activeStockRows().find(r => r.item === 'charcoal');
    if (charcoalRow && !ordered.has('charcoal')) {
        const spare = _smeltableInput('charcoal', keep);
        const have = ['charcoal', ...(SUBSTITUTES_FOR.charcoal || [])].reduce((n, i) => n + inventoryLens.forChestRequest(i, buildClaim), 0) + _inFlightSmelt('charcoal', allStations);
        const room = charcoalRow.fill_to - have;
        if (room > 0 && spare > 0) {
            whole.push({ item: 'charcoal', input: furnaceInput('charcoal'), qty: batchOf(room, spare), standing: true });
        }
    }
    // ── EVERY INGOT HAS A STANDING BASE OF INGOT_BASE_STACKS ──
    // With nothing asking, ore is smelted until the fleet holds that base of the ingot, cooking batches
    // counted; an order larger than the base is made in full by the loop above. Ore past both stays ore in
    // the chests, so a furnace is never given to an ingot nothing wants while another order waits.
    for (const ingot of BASE_STOCKED_INGOTS) {
        const input = furnaceInput(ingot);
        const avail = input ? _smeltableInput(ingot, keep) : 0;
        if (!(avail > 0)) continue;
        const base = INGOT_BASE_STACKS * stackOf(ingot);
        const toBase = batchOf(base - inventoryLens.reachableByFleet(ingot) - _inFlightSmelt(ingot, allStations), avail);
        if (!(toBase > 0)) continue;
        const made = [...whole, ...partials].find(o => o.item === ingot);
        if (made) made.qty = Math.max(made.qty, toBase);
        else whole.push({ item: ingot, input, qty: toBase, standing: true });
    }
    return { orders: [...whole, ...partials], pulls, inputShort };
}

// _assignFurnaces(orders, free, stackOf) → [{ order, stations, share }]. Every order gets one furnace per stack
// it holds, smallest order first, each loaded with up to a stack: a furnace pays the same walk, load and collect
// for five items as for sixty-four, so an order is not split thinner than it must be. An order under one stack
// takes one furnace and its own figure, however few.
function _assignFurnaces(orders, free, stackOf) {
    // FUEL FIRST: an order for a fuel takes its furnaces before any other, since every other load burns it.
    // THEN SMALLEST ORDER FIRST: a few ingots are cooked and out, where a standing stone order would take
    // every furnace that frees, sweep after sweep.
    const fuelFirst = o => (FUEL_PREFERENCES.includes(o.item) ? 0 : 1);
    // EVERY ORDER GETS A FURNACE BEFORE ANY ORDER GETS A SECOND. A standing base (`standing`, nothing asked for it) comes
    // after every asked order.
    const plan = [...orders].sort((a, b) => (a.standing ? 1 : 0) - (b.standing ? 1 : 0) || fuelFirst(a) - fuelFirst(b) || a.qty - b.qty).map(order => ({ order, stations: 0, share: 0 }));
    let left = free;
    for (const p of plan) if (left > 0) { p.stations = 1; left--; }
    for (const p of plan) {
        if (!p.stations) continue;
        p.share = Math.min(stackOf(p.order.item), p.order.qty);
        p.stations += Math.min(left, Math.ceil(p.order.qty / p.share) - 1);
        left -= p.stations - 1;
    }
    return plan.filter(p => p.stations > 0);
}

// ── A COOKING FURNACE IS TOPPED UP BEFORE A COLD ONE IS LIT ─────────────────────────────────────────
// _topUps(orders, furnaces, collecting, stackOf, fuel, jobs) → the orders' remainder. Input that arrives while its order cooks goes into
// that furnace with its fuel, up to a stack counting all its uncollected output, so an order keeps one furnace. No batch waits
// to qualify: with nothing of the order cooking, or no room, the remainder lights a cold furnace at once. A furnace up for
// collecting has its one job already, and a load of another input cannot share its slot. A top-up is posted to a body that can
// reach both what goes in: the slot's input, and the slot's kind of fuel, planks being reached through logs.
function _topUps(orders, furnaces, collecting, stackOf, fuel, inventory, jobs) {
    const ledger = require('@perception/chest_ledger');
    const reach = name => countInInventory(name, inventory) + ledger.unclaimedOf([name]);
    const left = [];
    for (const order of orders) {
        let qty = order.qty;
        for (const [id, e] of furnaces) {
            const st = e.smelt;
            if (qty <= 0 || !st || !st.started_at || st.order !== order.item || collecting.has(id)) continue;
            const slotFuel = st.fuel || fuel;
            if (!(reach(st.input) > 0) || !(reach(slotFuel) + (/_planks$/.test(slotFuel) ? reach(slotFuel.replace(/_planks$/, '_log')) : 0) > 0)) continue;
            const room = stackOf(order.item) - (st.qty || 1);
            if (room <= 0) continue;
            const add = Math.min(qty, room);
            jobs.push({
                id: `furnace_${id}`, type: 'furnace', what: order.item,
                where: e.pos, station_id: id,
                order: order.item, input: st.input, fuel: slotFuel,
                batch_quantity: add,
                job_type: JOB_TYPE.furnace_load,
                claimed_by: null, action: 'topup', scope: 'shared',
            });
            watcher.summary(TAG, `↳ ${add}x ${order.item} tops up furnace ${id}`);
            qty -= add;
        }
        if (qty > 0) left.push({ ...order, qty });
    }
    return left;
}

function assess({ inventory, buildClaim, built }) {
    const jobs = [];
    const pullNeeded = {};
    const allStations = stationRegistry.getStations();
    const furnaces = Object.entries(allStations).filter(([, e]) => e && e.type === 'furnace');

    // ── ONE CLAIM ON A FURNACE, ONE ACT AT A TIME ──
    // Every furnace posts at most one job, under one id (`furnace_<id>`): the id is the lock, so a claimed furnace is invisible to
    // every other body until its holder is done. Its state names the act: no batch, load; cooking, top up; fully cooked, empty.
    // Collect takes all the output and banks what its holder has no use for; the executor restarts the clock on what is
    // still cooking, and the next body may claim it when the clock says so.
    // COLLECT posts when the whole batch is cooked, or for a body held back for torch fuel (lighting_manager.noteFuelWait) when
    // this one furnace's clock and the chests cover all that body waits on. Under that, nobody walks.
    const wantedFuel = require('@action/lighting_manager').fuelWaited();
    const bankedFuel = wantedFuel ? require('@perception/chest_ledger').unclaimedOf(['coal', 'charcoal']) + ['coal', 'charcoal'].reduce((n, f) => n + countInInventory(f, inventory), 0) : 0;
    const collecting = new Set();
    for (const [id, entry] of furnaces) {
        const st = entry.smelt;
        if (!st || !st.started_at || !st.order) continue;
        const qty = st.qty || 1;
        const cooked = smeltCookedBy(st.started_at, st.order, qty);
        const coversWaiter = wantedFuel > 0 && FUEL_PREFERENCES.includes(st.order) && cooked > 0 && bankedFuel + cooked >= wantedFuel;
        if (cooked >= qty || coversWaiter) {
            collecting.add(id);
            jobs.push({
                id: `furnace_${id}`, type: 'furnace', what: st.order,
                where: entry.pos, station_id: id, order: st.order, batch_quantity: cooked,
                job_type: JOB_TYPE.furnace_collect,
                claimed_by: null, action: 'collect', scope: 'shared',
            });
        }
    }

    // ── EVERY COLD FURNACE IS A SEAT ──
    // One job per cold furnace, id'd by the furnace itself (`furnace_<id>`) with `scope: 'shared'`
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
    const smeltPlan = require('@thinking/assessors/downloaded_build').smeltPlan();
    const whole = { wanted: _fleetWanted(), owed: _fleetWanted('materials_wanted_net') };
    const { wanted, owed } = _byLayer(whole.wanted, whole.owed, smeltPlan);
    const demand = _smeltDemand(inventory, allStations, buildClaim, wanted, owed, _keeper(smeltPlan),
        built[require('@kernel/bot_mandate').homeBlueprint()] === true, charcoalFor(_buildingSmelts(whole.wanted, whole.owed)));
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
                // The gap is already short of the input the fleet can spare (_smeltableInput), so the order says it
                // is net of the pool: job_ranking stamps it a gather, never a build measured against that stock.
                id: `smelt_supply_${item}`, what: item, need: gap, structure, net_of_pool: true,
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
                id: `smelt_supply_${item}`, what: item, need: gap, net_of_pool: true,
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
            + ' — what input is on hand cooks now; this is the rest');
    }
    if (absent.length) {
        watcher.summary(TAG, `↳ smelt input not ordered: ${absent.join(', ')} — the loaded world held none on the last deep scan`);
    }

    if (fuelPref) {
        if (demand.orders.length && (freeFurnaces.length > 0 || furnaces.some(([id, e]) => e.smelt?.started_at && !collecting.has(id)))) {
            // Each order takes the furnaces _assignFurnaces gives it, one stack at most per load — an upper bound
            // the executor re-bounds against what the body actually carries. `_inFlightSmelt` shrinks next
            // sweep's orders as furnaces catch, so nothing tracks what was handed out.
            const itemsByName = require('minecraft-data')(require('@thinking/architect_config').SERVER_MINECRAFT_VERSION).itemsByName;
            const stackOf = item => itemsByName[item]?.stackSize || 64;
            let next = 0;
            for (const { order, stations, share } of _assignFurnaces(_topUps(demand.orders, furnaces, collecting, stackOf, fuelPref, inventory, jobs), freeFurnaces.length, stackOf)) {
                for (const [freeId, freeEntry] of freeFurnaces.slice(next, next + stations)) {
                    jobs.push({
                        id: `furnace_${freeId}`, type: 'furnace', what: order.item,
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
