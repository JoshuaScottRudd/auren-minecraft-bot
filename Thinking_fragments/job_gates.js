// job_gates — every reason a fully built job may be held back from the board, in one place (Law 16).
//
// A gate asks one question about a finished job: may it be offered to a bot right now. Every posting
// branch passes through applyGates, so no job reaches the board ungated.
//
// Each gate returns null to let a job through, or a verdict naming what holds it (Law 6):
//   why      the clause every job held by this gate shares
//   detail   the part particular to this job
//   shortOf  the items whose arrival would release it — a record of who waits on what, never a lever
//
// Gates judge a correctly built job. Deciding WHICH assessor builds a row is ownership routing and lives
// with the assessors.

'use strict';

const {
    underground_items: UNDERGROUND_ITEMS,
    farm_items: FARM_ITEMS,
    furnace_chain_items: FURNACE_CHAIN_ITEMS,
    substitutes_for: SUBSTITUTES_FOR,
    group_to_item: GROUP_TO_ITEM,
    stone_prospect_items: STONE_PROSPECT_ITEMS,
} = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const inventoryLens = require('@kernel/inventory_lens');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const stationRegistry = require('@perception/station_registry');
const { isNightTime, JOB_TYPE, STONE_PROSPECT } = require('@thinking/architect_config');

// Job kinds whose work happens on open ground and waits for dawn. Membership is by WHERE the work
// happens, not what it is about.
const DAYLIGHT_ONLY_JOBS = new Set([
    'resource_baseline',        // surface gathering for a build
    'resource_standing_stock',  // surface gathering for a standing shelf level
    'farm_supply_seeds',        // punching grass on open ground
    'farm_supply_dirt',         // digging soil on open ground
    'farm_tend',
    'clear_canopy',
    'clear_ground',             // digging debris off open ground
    'ground_salvage',          // outdoor walk to a drop
    'building_structure',       // every build except the headframe, whose deadline exempts it
    'building_contractor_house',
    'light_base',               // torching the yard
]);
// A name no job carries would leave the night gate silently open (Law 13).
for (const job of DAYLIGHT_ONLY_JOBS) {
    if (JOB_TYPE[job] === undefined) {
        throw new Error(`CODING VIOLATION (Law 13): DAYLIGHT_ONLY_JOBS names "${job}", which is not a job type in JOB_TYPES. The night gate would never match it.`);
    }
}

// Keyed on the job's kind (`job_type`) — the one field that identifies what the work is.
function isDaylightOnlyJob(job) {
    return DAYLIGHT_ONLY_JOBS.has(job.job_type);
}

// Job kinds that may still gather outdoors after dusk. Gathering is a step inside many job kinds, so the
// board predicts it by walking each order to its roots (obtainableGate). The headframe keeps its night
// exemption at this step too, so its supply can finish at night.
const NIGHT_GATHER_EXEMPT_JOBS = new Set([
    'building_headframe_supply',
]);
for (const job of NIGHT_GATHER_EXEMPT_JOBS) {
    if (JOB_TYPE[job] === undefined) {
        throw new Error(`CODING VIOLATION (Law 13): NIGHT_GATHER_EXEMPT_JOBS names "${job}", which is not a job type in JOB_TYPES. The exemption would never match.`);
    }
}

// Whether this job may reach outside for material right now. An unknown kind answers no at night
// (Law 13, default-stopped).
function mayGatherOutdoors(job) {
    if (!isNightTime()) return true;
    return NIGHT_GATHER_EXEMPT_JOBS.has(job.job_type);
}

// The recipe-reading gates bind supply jobs; mining jobs answer the tool gate as well.
const SUPPLY = 'supply';
const MINING = 'mine';

// ── THE DECLARATION A JOB CARRIES ─────────────────────────────────────────────────────────────────
// Built once, in job_board's supplyJob constructor, from the stock row behind the job:
//   requires_station          a placed station this work needs (stock `requires_station`)
//   requires_craft_stations   workbenches the recipe needs, derived from the recipe itself
//   mode                      'active' | 'passive' (stock `mode`)
//   after_fulfilled           another item whose request must close before this one is offered
//
// `modeOverride` lets a tool row's spare rung run passive while its bootstrap rung keeps the row's mode:
// a spare is insurance bought from material already in hand.
//
// The recipe walk stops at any ingredient already held (HELD_ENOUGH), matching the fulfiller's own
// decomposition, so a station is required only when the fleet still has to make the ingredient behind
// it (Law 16, Law 25). supply_manager's assertion uses the same predicate.
const HELD_ENOUGH = (ingredient, quantity) => inventoryLens.spendableForCraft(ingredient) >= quantity;

function declarationFor(stock, modeOverride = null, item = null) {
    const craftStations = item ? [...craftingRegistry.stationsRequiredFor(item, HELD_ENOUGH)] : [];
    if (!stock) return craftStations.length ? { requires_craft_stations: craftStations } : undefined;
    return {
        requires_station: stock.requires_station,
        requires_craft_stations: craftStations,
        mode: modeOverride || stock.mode,
        after_fulfilled: stock.after_fulfilled,
    };
}

// ── THE SHORTFALL PREDICATE ───────────────────────────────────────────────────────────────────────
// Returns the first ingredient of `item`'s recipe below what ONE craft costs — the threshold at which
// this gate and the fulfiller agree. Every stock count comes from inventory_lens (Law 16).
//
// Scope is the craft route only; whether a finished item can instead be withdrawn is the caller's
// question. `onlyClass` limits which ingredients are checked. `countIngredient` defaults to the pocket,
// because a crafter consumes from its hand; a caller widens it only for chain products (charcoal, wheat),
// which the fulfiller withdraws from storage.
function shortOfAnyIngredient(item, onlyClass = null, countIngredient = null) {
    // recipeForToken resolves variant names (spruce_trapdoor → trapdoor) to their recipe.
    const recipe = craftingRegistry.recipeForToken(item);
    if (!recipe || !recipe.ingredients) return null;    // no recipe → nothing to be short OF
    const count = countIngredient || (ing => inventoryLens.spendableForCraft(ing));
    for (const ing of Object.keys(recipe.ingredients)) {
        if (onlyClass && !onlyClass.has(ing.trim().toLowerCase())) continue;
        if (count(ing) < (recipe.ingredients[ing] || 1)) return ing;
    }
    return null;
}

// ── THE WALK-BACK ─────────────────────────────────────────────────────────────────────────────────
// The board is the only party that refuses an order; the fulfiller attempts whatever it is handed. So
// the root-reading gates walk each order to the same leaves the fulfiller will reach (Law 16).
function rootsStillNeeded(job) {
    return inventoryLens.rootsNeededFleetWide(job.what, job.need, job.at_destination);
}
function describeRoots(short) {
    return Object.entries(short).map(([root, need]) => `${need}x ${root}`).join(', ');
}

// ── THE GATES ─────────────────────────────────────────────────────────────────────────────────────
// Each takes (job, ctx) — ctx = { inventory, allStations, pullNeeded, built, allJobs } — and returns
// null, a reason string, or { why, detail, shortOf }. A job with no `gates` block answers only the gates
// that read the job itself.

// NIGHT — holds outdoor job kinds after dusk. A posting gate only: a claimed job runs to completion
// (Law 4). The dispatch table's own order is the daytime preference; this gate only removes rows.
// A species that does not fear the night is never held here.
function nightGate(job) {
    if (!isNightTime()) return null;
    if (!require('@kernel/bot_mandate').fearsTheNight()) return null;
    return isDaylightOnlyJob(job) ? 'outdoor verb after dusk' : null;
}

// Which site a body prefers is a rank (architect_config.STRUCTURE_PRIORITY via job_ranking, Law 27);
// material dependencies are priced by the shortfall order. Neither is a gate.

// STATION — the work needs a PLACED station, and the station registry is the authority on what stands.
function stationGate(job, ctx) {
    const need = job.gates?.requires_station;
    if (!need) return null;
    const present = Object.values(ctx.allStations || {}).some(s => s && s.type === need);
    // Names the station so the board shows what the hold waits on; a build releases it.
    return present ? null : { why: 'work needs a placed station', detail: need, shortOf: [need] };
}

// CRAFT STATION — the recipe needs a workbench that does not stand yet. Reads
// station_registry.stationUsable, the same test the fulfiller asserts on (Law 16). A shortfall with a
// producer is held and named, so the loop judge never sees it as an impossibility.
function craftStationGate(job) {
    const needed = job.gates?.requires_craft_stations;
    if (!Array.isArray(needed) || !needed.length) return null;
    const missing = needed.filter(station => !stationRegistry.stationUsable(station));
    if (!missing.length) return null;
    return {
        why: 'the recipe needs a workbench that does not stand yet',
        detail: missing.join(','),
        shortOf: missing,
    };
}

// TOOL — obtaining one of this order's roots needs a tool the bot does not carry: a pickaxe for rock,
// shears for leaves. Without the tool the gather returns nothing at all. Uses mining_manager.hasPickaxe,
// the same predicate the mining manager releases on (Law 16, Law 25). Mining jobs answer this gate too.
const TOOLED_ROOTS = new Set([...STONE_PROSPECT_ITEMS, ...UNDERGROUND_ITEMS]);
const SHEARED_ROOT = /_leaves$/;
function toolGate(job, ctx) {
    if (job.type === SUPPLY && job.need > 0 && countInInventory('shears', ctx.inventory) === 0) {
        const needsShears = Object.keys(rootsStillNeeded(job)).filter(root => SHEARED_ROOT.test(root));
        if (needsShears.length) {
            return {
                why: 'the root is cut with shears and none are carried',
                detail: `${needsShears.join(', ')} — needs shears`,
                shortOf: ['shears'],
            };
        }
    }
    const { hasPickaxe, canEnterMine } = require('@action/mining_manager.js');   // lazy: cycle-safe, matches assessors/mining
    // A mining job is entered with the pocket's full pickaxe level; every other tooled job needs one.
    if (job.type === MINING) {
        const entry = canEnterMine(global.bot);
        return entry.ok ? null : { why: 'the mine is entered with a full set of pickaxes', detail: entry.reason, shortOf: ['pickaxe'] };
    }
    if (hasPickaxe(global.bot).ok) return null;
    if (job.type !== SUPPLY || !(job.need > 0)) return null;
    const needsTool = Object.keys(rootsStillNeeded(job)).filter(root => TOOLED_ROOTS.has(root));
    return needsTool.length
        ? {
            why: 'the root needs a pickaxe to obtain and none is carried',
            detail: `${needsTool.join(', ')} — needs pickaxe`,
            shortOf: ['pickaxe'],
        }
        : null;
}

// FILLER — a surface-stone dig seals its column behind itself on the climb, so the bot must carry
// `filler_reserve` spendable blocks to get back out. Reads the live pocket (Invariant B). Names planks as
// the release because planks are the one member of the reserve the fleet can be asked for (Law 25).
function fillerGate(job, ctx) {
    if (job.type !== SUPPLY || !(job.need > 0)) return null;
    const wantsRock = Object.keys(rootsStillNeeded(job)).some(root => require('@utils/fragment_utils').isProspected(root));
    if (!wantsRock) return null;

    const spendable = new Set(GROUP_TO_ITEM.scaffold_spendable);
    let held = 0;
    for (const it of (global.bot?.inventory?.items?.() || [])) {
        if (it && it.count > 0 && spendable.has(it.name)) held += it.count;
    }
    return held >= STONE_PROSPECT.filler_reserve ? null : {
        why: 'the descent has no sealing material to climb back out on',
        detail: `${held}/${STONE_PROSPECT.filler_reserve} spendable blocks in hand`,
        shortOf: ['planks'],
    };
}

// CHAIN — holds a supply job whose item or ingredient comes only from another running chain: grown
// (wheat) or smelted (charcoal), with none reachable. A running chain's shortfall is pipeline latency, so
// the job waits for its producer and files no mining pull. The target is checked before its ingredients,
// because a group token has no recipe of its own. A partial supply passes: "none reachable" is the
// threshold, so work that can make progress is offered.
function chainGate(job) {
    if (job.type !== SUPPLY) return null;
    // Reachable stock is pocket plus chests, less every peer's claim, plus any substitute (coal for
    // charcoal) — the same figure supply_manager Step 4a withdraws against, so the board and the
    // fulfiller agree (Law 16).
    const chestLedger = require('@perception/chest_ledger');
    const reachable = ing => {
        const net = one => Math.max(0, inventoryLens.reachableByFleet(one) - chestLedger.claimedByOthers(one));
        let n = net(ing);
        for (const alt of (SUBSTITUTES_FOR[ing] || [])) n += net(alt);
        return n;
    };

    const want = String(job.what || '').trim().toLowerCase();
    if (FARM_ITEMS.has(want) && reachable(want) <= 0)
        return { why: 'the item itself is farm-grown and none is reachable', detail: want, shortOf: [want] };
    // A delivery of a smelted item into storage is the smelter's own work: its collect banks the batch where the
    // order is going. Held, the order still counts as demand, which is what sizes the smelt.
    if (FURNACE_CHAIN_ITEMS.has(want) && job.destination)
        return { why: 'the smelter delivers this into storage itself', detail: want, shortOf: [want] };
    if (FURNACE_CHAIN_ITEMS.has(want) && reachable(want) <= 0)
        return { why: 'the item itself comes off the furnace chain and none is reachable', detail: want, shortOf: [want] };

    const grown = shortOfAnyIngredient(job.what, FARM_ITEMS, reachable);
    if (grown) return { why: 'ingredient is farm-grown and none is reachable', detail: grown, shortOf: [grown] };
    const smelted = shortOfAnyIngredient(job.what, FURNACE_CHAIN_ITEMS, reachable);
    return smelted
        ? { why: 'ingredient comes off the furnace chain and none is reachable', detail: smelted, shortOf: [smelted] }
        : null;
}

// PASSIVE — a passive row is filled only from what already exists and never opens a chain. Two routes
// fill it: withdrawing the finished item from storage, or crafting it from ingredients on hand. The
// withdrawal check mirrors the fulfiller's own conditions exactly — no destination, and the concrete item
// name the board resolved — so the gate opens only for a withdrawal the fulfiller will perform.
function passiveGate(job) {
    if (job.type !== SUPPLY || job.gates?.mode !== 'passive') return null;
    if (!job.destination && inventoryLens.inChests(job.what) > 0) return null;
    const short = shortOfAnyIngredient(job.what);
    return short ? { why: 'passive row — ingredient not already on hand', detail: short, shortOf: [short] } : null;
}

// AFTER-FULFILLED — holds a row while the request it names (`after_fulfilled` in STOCK_THRESHOLDS) is
// still open. The evidence is this sweep's own posted work, so the gate agrees with the row it waits on
// (Law 16, Law 25). Runs before `underground`, so a held row files no mining pull.
function afterFulfilledGate(job, ctx) {
    const waitFor = job.gates?.after_fulfilled;
    if (!waitFor) return null;
    const wanted = new Set([waitFor, ...(GROUP_TO_ITEM[waitFor] || [])]);
    const open = (ctx.allJobs || []).some(other => other !== job
        && other.type === SUPPLY
        && other.need > 0
        && wanted.has(other.what));
    return open
        ? {
            why: `waits until ${waitFor} is fulfilled`,
            detail: `${waitFor} still requested this sweep`,
            shortOf: [waitFor],
        }
        : null;
}

// UNDERGROUND — the order needs a root the surface cannot supply. The one gate with a side effect: it
// writes the shortfall into ctx.pullNeeded, so the mining pull knows what the surface is waiting for.
// A mining pull means the fleet does not have this, measured on the same pocket-plus-chests pool as
// every other gate.
function undergroundGate(job, ctx) {
    // Supply only: a mining job's own `what` is underground material, and gating it would feed its own pull.
    if (job.type !== SUPPLY || !(job.need > 0)) return null;
    // The shortfall is already net of everything held at every level, so its counts are the pull.
    const short = rootsStillNeeded(job);
    const gatedOn = [];
    for (const [root, need] of Object.entries(short)) {
        // Per species (fragment_utils.isUnderground): a builder's stone is mined, so its stone shortfall routes here too.
        if (!require('@utils/fragment_utils').isUnderground(root)) continue;
        ctx.pullNeeded[root] = Math.max(ctx.pullNeeded[root] || 0, need);
        // Who asked travels with the amount: a tunnel seat takes the position of the order that pulled it.
        ctx.pullAskers.push({ item: root, need, job_type: job.job_type, structure: job.structure || null });
        gatedOn.push(root);
    }
    return gatedOn.length
        ? { why: 'underground root short — routed to the mining pull', detail: gatedOn.join(', '), shortOf: gatedOn }
        : null;
}

// OBTAINABLE — holds an order whose remaining roots need an outdoor gather while that route is shut.
// The fleet's one night check on gathering; the fulfiller attempts whatever it is handed (Invariant D).
// Clears as soon as material arrives from the mine or a peer's deposit.
function obtainableGate(job) {
    if (job.type !== SUPPLY) return null;          // mining/canopy verbs have no recipe to walk
    if (!(job.need > 0)) return null;
    if (mayGatherOutdoors(job)) return null;
    if (!require('@kernel/bot_mandate').fearsTheNight()) return null;   // a builder's routes never close at dusk
    const short = rootsStillNeeded(job);
    // Names the roots, so the reader sees what arriving material would release the order.
    return Object.keys(short).length
        ? { why: 'no gather route open until dawn', detail: describeRoots(short), shortOf: Object.keys(short) }
        : null;
}

// ── THE ORDER ─────────────────────────────────────────────────────────────────────────────────────
// First match wins, so the order decides which reason a held job is reported under. Cheapest and most
// absolute first, then the recipe walks, then the one that writes a mining pull. Load-bearing positions:
//   - `tool` before `chain` and `underground`: a rock order with no pickaxe is reported as needing the
//     tool, and files no pull for stone it cannot mine.
//   - `craft_station` ahead of every recipe walk: a craft with no workbench is held for the workbench.
//   - `chain` before `underground`: a root another chain produces never becomes a mining pull.
//   - `passive` and `after_fulfilled` before `underground`: a held or passive row never commissions a descent.
//   - `obtainable` last: the deepest walk and the least specific verdict.
const GATES = [
    ['night',       nightGate],
    ['station',     stationGate],
    ['craft_station', craftStationGate],
    ['tool',        toolGate],
    ['filler',      fillerGate],
    ['chain',       chainGate],
    ['passive',     passiveGate],
    ['after_fulfilled', afterFulfilledGate],
    ['underground', undergroundGate],
    ['obtainable',  obtainableGate],
];

// Returns { posted, held }; each held entry carries { job, gate, why, detail, shortOf, reason }, with
// `reason` the flat one-string rendering. Every job lands in exactly one of the two lists (Law 6).
function applyGates(jobs, ctx) {
    // The sweep's own job list, for gates that ask whether another request is still open.
    ctx = { ...ctx, allJobs: jobs };
    const posted = [];
    const held = [];
    for (const job of jobs) {
        let stopped = null;
        for (const [name, gate] of GATES) {
            const verdict = gate(job, ctx);
            if (!verdict) continue;
            // Normalises string and object verdicts into one shape (Law 10).
            const why = typeof verdict === 'string' ? verdict : verdict.why;
            const detail = typeof verdict === 'string' ? null : verdict.detail;
            const shortOf = typeof verdict === 'string' ? [] : (verdict.shortOf || []);
            stopped = { gate: name, why, detail, shortOf, reason: detail ? `${why} (${detail})` : why };
            break;
        }
        if (stopped) held.push({ job, ...stopped });
        else posted.push(job);
    }
    return { posted, held };
}

module.exports = {
    applyGates,
    declarationFor,
};
