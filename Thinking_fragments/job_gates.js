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
//
// CRAFTING AND BUILDING MAY BE HELD IN ANY WAY; GATHERING NEVER IS. With the material on hand, the order a craft
// or a building is done in costs nothing, and a held craft or build leaves its bodies free for the gathering every
// order still files (the mining pull, the surface gathers), so no body idles in front of work it could do. A gate
// that would stop a gather, or stop an order filing its pull, breaks this: among equal gathers the leanest is
// chosen (job_ranking, the dispatcher's level), and buildings are ranked.

'use strict';

const {
    underground_items: UNDERGROUND_ITEMS,
    farm_items: FARM_ITEMS,
    furnace_chain_items: FURNACE_CHAIN_ITEMS,
    hunt_items: HUNT_ITEMS,
    substitutes_for: SUBSTITUTES_FOR,
    group_to_item: GROUP_TO_ITEM,
} = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const inventoryLens = require('@kernel/inventory_lens');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const stationRegistry = require('@perception/station_registry');
const { isNightTime, isDuskTime, JOB_TYPE, JOB_CATEGORY_OF, SPAWN_PROOFING } = require('@thinking/architect_config');
const { requirementTree } = require('@utils/calculators/build_material_calculator');

// THE NIGHT-APPROVED JOBS. From dusk (architect_config.isDuskTime) no job kind is offered or kept unless it is named
// here; every kind absent from this table waits for dawn (Law 13, default-stopped). Membership is authored by hand, never derived. Each
// approved kind says where its work happens:
//   'survival'     the body's own survival, at any hour and anywhere
//   'underground'  in the mine, below the lit shaft
//   'home'         at the home's stations, inside the headframe
//   'lit'          at the job's `where`, approved only while that point is inside a fully lit painted torch
//                  network (lighting_integrity.litAtNight)
//   'guard'        beside a worker on tandem work, or at home waiting for one (guard_manager)
//   'mine_light'   torches underground only: approved while the light plan holds a mine torch (the shaft's and the
//                  branches') or a basement cell's, and a visit from dusk places only those (lighting_manager)
// Any other approved kind never gathers outdoors from dusk: obtainableGate holds any order whose roots need it.
const NIGHT_APPROVED_JOBS = new Map([
    ['respawn_recover',           'survival'],
    ['leave_current',             'survival'],
    ['eat_food',                  'survival'],
    ['mining_dig_shaft',          'underground'],
    ['mining_dig_cell',           'underground'],
    ['mining_obsidian',           'underground'],
    ['light_network',             'mine_light'],
    ['tandem_guard',              'guard'],
    ['crafting_tool_bootstrap',   'home'],
    ['crafting_weapon',           'home'],
    ['crafting_defense',          'home'],
    ['crafting_tool',             'home'],
    ['crafting_flat',             'home'],
    ['chest_housekeeping',        'home'],
    ['home_stations',             'home'],
    ['furnace_collect',           'home'],
    ['furnace_load',              'home'],
    ['compost_feed',              'home'],
    ['building_headframe',        'home'],
    ['farm_tend',                'lit'],
    ['shear_animal',              'lit'],
    ['cull_animal',               'lit'],
    ['breed_animal',              'lit'],
    ['dye_animal',                'lit'],
    ['shepherd_pen',              'lit'],
    ['ground_salvage',            'lit'],
    ['building_structure',        'lit'],
    ['building_structure_supply', 'lit'],
    ['site_supply',               'lit'],
]);
const NIGHT_REACHES = new Set(['survival', 'underground', 'home', 'lit', 'mine_light', 'guard']);
// A name no job carries would approve nothing and hide the author's intent (Law 13).
for (const [job, reach] of NIGHT_APPROVED_JOBS) {
    if (JOB_TYPE[job] === undefined) {
        throw new Error(`CODING VIOLATION (Law 13): NIGHT_APPROVED_JOBS names "${job}", which is not a job type in JOB_TYPES. The approval would never match.`);
    }
    if (!NIGHT_REACHES.has(reach)) {
        throw new Error(`CODING VIOLATION (Law 13): NIGHT_APPROVED_JOBS gives "${job}" the reach '${reach}'; a reach is one of ${[...NIGHT_REACHES].join(', ')}.`);
    }
}

// Whether a job may reach outside for material right now: by day only. The harvest is gated, the build is not.
function mayGatherOutdoors() {
    return !isNightTime() && !isDuskTime();
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
function rootsStillNeeded(job, forBot = null) {
    return inventoryLens.rootsNeededFleetWide(job.what, job.need, job.at_destination, { forBot });
}
function describeRoots(short) {
    return Object.entries(short).map(([root, need]) => `${need}x ${root}`).join(', ');
}

// ── THE GATES ─────────────────────────────────────────────────────────────────────────────────────
// Each takes (job, ctx) — ctx = { inventory, allStations, pullNeeded, built, allJobs } — and returns
// null, a reason string, or { why, detail, shortOf }. A job with no `gates` block answers only the gates
// that read the job itself.

// NIGHT — at dusk and after, holds every job kind NIGHT_APPROVED_JOBS does not name, so none is started that would
// be out at night. Two guards act on a job already claimed:
//   dusk   duskStop below, asked by a manager at its own iteration boundary (the next pledge, the next unit of
//          work): the body finishes what it is doing, stops there and goes home
//   night  nightRecall below, asked on every inline combat check: the body drops the job where it stands and goes
//          home to its idle spot (battle_stations)
// The dispatch table's own order is the daytime preference; this gate only removes rows.
// A species that does not fear the night is never held here. A 'lit' kind is let through only while its site
// lies inside a torch network with no torch left to place: no hostile spawns on that ground. Tandem work (tandemWork), the
// spawn proofing's trips with the felling round each post, is let through while a guard's duty is heard on the combat road,
// and recalled when it lapses. Duty is stood only with a weapon and a shield (combat_board.guardKitted).
function tandemWork(job) {
    return !!job && job.job_type === JOB_TYPE.building_structure && job.structure === SPAWN_PROOFING;
}

function nightGate(job) {
    const night = isNightTime();
    if (!night && !isDuskTime()) return null;
    if (!require('@kernel/bot_mandate').fearsTheNight()) return null;
    const why = night ? 'not night-approved' : 'dusk: not night-approved';
    const reach = NIGHT_APPROVED_JOBS.get(job.job_type);
    if (tandemWork(job) && require('@api/combat_board').tandemSeatOpen()) return null;
    if (!reach) return { why, detail: job.job_type, shortOf: [] };
    if (reach === 'mine_light') {
        const planned = require('@perception/lighting_integrity').getState()?.placements || [];
        return planned.some(p => p.paint === 'mine' || p.paint === 'basement') ? null : { why, detail: `${job.job_type} has no mine or basement torch planned`, shortOf: [] };
    }
    if (reach !== 'lit') return null;
    const lit = require('@perception/lighting_integrity').litAtNight(job);
    return lit.ok ? null : { why, detail: `${job.job_type} needs lit ground: ${lit.reason}`, shortOf: [] };
}

// Which site a body prefers is a rank (architect_config.STRUCTURE_PRIORITY via job_ranking, Law 27);
// material dependencies are priced by the shortfall order. Neither is a gate.

// TANDEM — a guard's seat waits while the board posts no tandem work for it to stand by.
function tandemGate(job, ctx) {
    if (job.job_type !== JOB_TYPE.tandem_guard) return null;
    if ((ctx.allJobs || []).filter(tandemWork).length < (job.seat || 1)) return { why: 'no tandem work posted to guard', detail: job.job_type, shortOf: [] };
    return require('@api/combat_board').guardSeatOpen(job.seat || 1) ? null : { why: 'a peer on duty holds this guard seat', detail: job.job_type, shortOf: [] };
}

// STATION — the work needs a PLACED station, and the station registry is the authority on what stands.
function stationGate(job, ctx) {
    const need = job.gates?.requires_station;
    if (!need) return null;
    const present = Object.values(ctx.allStations || {}).some(s => s && s.type === need);
    // Names the station so the board shows what the hold waits on; a build releases it.
    return present ? null : { why: 'work needs a placed station', detail: need, shortOf: [need] };
}

// BODY — every block a structure still owes holds a body up (assessors/building stamps it), and a dig never takes
// the last block under a body (dig_authority), so no builder could take a step. Held until the body moves.
function bodyGate(job) {
    const held = job.gates?.held_by_bodies;
    if (!held) return null;
    return { why: 'every block it still owes holds a body up', detail: `${held.bodies.join(',')} on ${held.cells.join(' ')}`, shortOf: [] };
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
const TOOLED_ROOTS = new Set(UNDERGROUND_ITEMS);
const SHEARED_ROOT = /_leaves$/;
function toolGate(job, ctx) {
    // The fleet's shears are banked between uses (assessors/ranching): a pair carried or in the chests is in reach, and
    // the leaf gather takes it from there while one of the leaf seats is open (harvest_executor: one seat per leaf
    // pair). No pair in reach, or every leaf pair out with a peer, and the leaf order is not offered at all.
    if (job.type === SUPPLY && job.need > 0) {
        // A delivery of leaves to another chest is cut, never withdrawn (supply_manager never moves an order's own
        // target chest to chest), so the leaves in storage do not stand in for the shears.
        const cut = job.destination && SHEARED_ROOT.test(String(job.what || '')) ? [job.what] : [];
        const needsShears = [...new Set([...cut, ...Object.keys(rootsStillNeeded(job)).filter(root => SHEARED_ROOT.test(root))])];
        if (needsShears.length) {
            const carried = countInInventory('shears', ctx.inventory);
            const banked = require('@perception/chest_ledger').unclaimedOf(['shears']);
            if (carried === 0 && !(banked > 0)) {
                return {
                    why: 'the root is cut with shears and none are carried or banked',
                    detail: `${needsShears.join(', ')} — needs shears (0 carried, 0 banked unclaimed)`,
                    shortOf: ['shears'],
                };
            }
            const open = require('@action/harvest_executor').leafSeatsOpen();
            if (open === 0) {
                const pairs = require('@thinking/architect_config').LEAF_PAIRS;
                return {
                    why: 'every leaf pair of shears is out with a peer cutting leaves',
                    detail: `${needsShears.join(', ')} — 0 of ${pairs} leaf seats open (${carried} carried, ${banked} banked unclaimed)`,
                    shortOf: [],
                };
            }
        }
    }
    const { hasPickaxe, canEnterMine, mineLightReady } = require('@action/mining_manager.js');   // lazy: cycle-safe, matches assessors/mining
    // AN ORE TRIP IS TAKEN WITH A STONE PICKAXE OR BETTER: a strip cell on wood passes every
    // iron, copper and lapis ore it meets. The shaft is dug with wood.
    const oreTrip = job.type === MINING && (job.what === 'dig_cell');
    if (oreTrip && require('@thinking/assessors/shared').stoneOrBetter('pickaxe', ctx.inventory) === 0) {
        return { why: 'an ore trip is taken with a stone pickaxe or better', detail: 'no stone pickaxe or better carried', shortOf: ['stone_pickaxe'] };
    }
    // A mining job is entered with the pocket's full pickaxe level; every other tooled job needs one.
    if (job.type === MINING) {
        const entry = canEnterMine(global.bot);
        if (!entry.ok) return { why: 'the mine is entered with a full set of pickaxes', detail: entry.reason, shortOf: ['pickaxe'] };
        // A crew that lights its ground digs the mine lit: the trip's torches are had before it goes down.
        const light = mineLightReady(global.bot, job);
        if (light.fuelShort > 0) require('@action/lighting_manager').noteFuelWait(light.crafts);
        return light.ok ? null : { why: 'the mine is dug lit and the trip\'s torches cannot be had', detail: light.reason, shortOf: ['torch'] };
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
    // A mob or pen product ordered for itself (wool a pen shears, leather a cull banks, string a fight drops) is never
    // gathered by supply_manager: with none reachable the order waits for its producer.
    // A delivery of what a crew producer hands over (wool a shearer banks, leather a cull banks: producer_hooks
    // `yields`) is that producer's own work, as the smelter's is: supply_manager never withdraws a delivery's own
    // item from storage, so stock in the chests is the part already delivered and no source for the rest.
    if (job.destination && require('@kernel/producer_hooks').yieldedByProducer(want))
        return { why: 'its producer banks this into storage itself', detail: want, shortOf: [want] };
    if (HUNT_ITEMS.has(want) && reachable(want) <= 0)
        return { why: 'the item itself comes off a living thing and none is reachable', detail: want, shortOf: [want] };

    // An ingredient storage keeps back (calculators/ingredient_keep: the pen's wheat, all the cane under THE CANE HOLD)
    // is spent only past the keep.
    const { ingredientKeep } = require('@utils/calculators/ingredient_keep');
    const kept = shortOfAnyIngredient(job.what, null, ing => (ingredientKeep(ing) ? reachable(ing) - ingredientKeep(ing) : Infinity));
    if (kept) return { why: 'ingredient is kept back and none lies past the keep', detail: kept, shortOf: [kept] };
    const grown = shortOfAnyIngredient(job.what, FARM_ITEMS, reachable);
    if (grown) return { why: 'ingredient is farm-grown and none is reachable', detail: grown, shortOf: [grown] };
    const smelted = shortOfAnyIngredient(job.what, FURNACE_CHAIN_ITEMS, reachable);
    if (smelted) return { why: 'ingredient comes off the furnace chain and none is reachable', detail: smelted, shortOf: [smelted] };
    // A mob drop (bone for bone meal) is never gathered by supply_manager, so with none reachable the craft waits; the
    // bone_meal row's other source is the composter (assessors/compost's forest run).
    const hunted = shortOfAnyIngredient(job.what, HUNT_ITEMS, reachable);
    if (hunted) return { why: 'ingredient is a mob drop and none is reachable', detail: hunted, shortOf: [hunted] };
    // A mob drop deeper in the chain (gray dye → white dye → bone meal → bone): the fleet-wide walk nets every level
    // the chests hold (the bone meal), so a root still short here is one no withdrawal at any level covers.
    const huntedRoot = Object.keys(rootsStillNeeded(job)).find(root => HUNT_ITEMS.has(root) && reachable(root) <= 0);
    if (huntedRoot) return { why: 'a root of the chain is a mob drop and none is reachable at any level', detail: huntedRoot, shortOf: [huntedRoot] };
    // A CRAFT TAKES A SMELTED INGREDIENT FROM THE CHESTS ONLY (the shield's and the iron pickaxe's iron, a building's
    // shears): supply_manager withdraws a furnace product and never gathers it, so a peer's pocket or a loaded furnace
    // is no source for this body's craft. The figure is supply_manager Step 4a's: this pocket plus the chests, less
    // every peer's claim on them (Law 16), so the gate never admits a craft whose ingredient the fulfiller will not take.
    {
        const { getBotInventory } = require('@utils/fragment_utils');
        const forMe = one => countInInventory(one, getBotInventory())
            + Math.max(0, inventoryLens.inChests(one) - chestLedger.claimedByOthers(one));
        const inChestsForMe = ing => [ing, ...(SUBSTITUTES_FOR[ing] || [])].reduce((n, one) => n + forMe(one), 0);
        const banked = shortOfAnyIngredient(job.what, null, ing => (craftingRegistry.smeltInputsFor(ing) ? inChestsForMe(ing) : Infinity));
        if (banked) return { why: 'a craft ingredient comes off the furnace and too little is in the chests', detail: banked, shortOf: [banked] };
    }
    return null;
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

// KIT FIRST — the crew's iron kit (the bucket, then every body's shield and iron pickaxe) is made before a building
// is given any of its material: a building's order made of a kit material is held while the kit still owes that
// material (requested_work.kitOwed). The bucket is the chest band's and the kit the bot band's, so neither is held
// here. GATHERING IS NEVER HELD: runs after `underground`, so a building's order short of ore still pulls the mine
// for it, and only the banked material the kit owes is kept from the building's delivery.
const KIT_YIELDS = new Set(['blueprint']);
function kitFirstGate(job, ctx) {
    if (job.type !== SUPPLY || !(job.need > 0) || !KIT_YIELDS.has(JOB_CATEGORY_OF[job.job_type])) return null;
    if (!ctx.kitOwed) ctx.kitOwed = require('@thinking/requested_work').kitOwed();
    const tree = requirementTree(job.what, 1, {});
    const owed = Object.keys(ctx.kitOwed).filter(material => ctx.kitOwed[material] > 0 && tree[material] > 0);
    return owed.length
        ? {
            why: 'the crew kit takes this material first',
            detail: owed.map(material => `${ctx.kitOwed[material]}x ${material} owed to the kit`).join(', '),
            shortOf: owed,
        }
        : null;
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
function obtainableGate(job, ctx, forBot = null) {
    if (job.type !== SUPPLY) return null;          // mining/canopy verbs have no recipe to walk
    if (!(job.need > 0)) return null;
    if (mayGatherOutdoors()) return null;
    if (!require('@kernel/bot_mandate').fearsTheNight()) return null;   // a builder's routes never close at dusk
    // An order net of the pool (job_ranking's `net_of_pool`) asks only for what the pool lacks, so nothing in
    // the pool can fill it: its whole figure is a gather, and the stock it was netted of releases nothing.
    const short = job.net_of_pool ? { [job.what]: job.need } : rootsStillNeeded(job, forBot);
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
//   - `kit_first` after `underground`: it holds a delivery of banked material, never the gathering of it.
//   - `obtainable` last: the deepest walk and the least specific verdict.
const GATES = [
    ['night',       nightGate],
    ['tandem',      tandemGate],
    ['station',     stationGate],
    ['body',        bodyGate],
    ['craft_station', craftStationGate],
    ['tool',        toolGate],
    ['chain',       chainGate],
    ['passive',     passiveGate],
    ['after_fulfilled', afterFulfilledGate],
    ['underground', undergroundGate],
    ['kit_first',   kitFirstGate],
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

// nightRecall(job) → the night hold the board would put on this claimed job now (nightGate, or obtainableGate for
// an order whose roots need an outdoor gather), or null. Read off the body's magnet by battle_stations' inline check.
// Both guards below ask of this body's own claimed job, so its own chest claims and pocket count as the job's material
// (inventory_lens.rootsNeededFleetWide forBot): a craft whose material it already took is never sent home short of it.
const SELF = () => process.env.BOT_ID || 'default';
function nightRecall(job) {
    if (!isNightTime() || !job || !job.job_type) return null;
    return nightGate(job) || obtainableGate(job, null, SELF());
}

// duskStop(job) → the hold the board would put on this claimed job now, at dusk or at night, or null. Asked by a
// manager between one unit of its work and the next, never mid-unit: a hold ends the claim there.
function duskStop(job) {
    if ((!isDuskTime() && !isNightTime()) || !job || !job.job_type) return null;
    return nightGate(job) || obtainableGate(job, null, SELF());
}
// duskStopClaimed() → duskStop for the job this body has claimed (its magnet), for a loop that does not carry it.
function duskStopClaimed() {
    if (!isDuskTime() && !isNightTime()) return null;
    return duskStop(require('@kernel/corporate_headquarters').readBoardroomChair(process.env.BOT_ID || 'default', {})?.magnet);
}

module.exports = {
    applyGates,
    declarationFor,
    nightRecall,
    duskStop,
    duskStopClaimed,
    // assessors/survey asks it before taking seats from the strip mine, so a night-held survey takes none.
    nightGate,
    // commander asks it each sweep: a body on this work declines while a guard is on duty.
    tandemWork,
    // supply_manager asks it again when an admitted order finds its chain root short, to tell a stale read from a gap.
    chainGate,
};
