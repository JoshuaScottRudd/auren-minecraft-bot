// job_gates — every reason a fully-built job may be DISQUALIFIED before it is posted, in one place.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────────
// A gate is not part of building a job. It is a question asked ABOUT a finished job: may this be
// offered to a bot right now. Those are different acts with different owners, and merging them is what
// produced the fault this file removes — the same gate written once per posting branch, drifting apart.
//
// The night gate already carried the argument, written for itself alone: "ONE filter over the assembled
// list, never a check inside each assessor: the assessors would each grow their own copy of the same
// clock read, which is the redundancy Law 16 refuses." Every other gate was exactly the scattered copies
// that comment refuses — the material gate existed three times, the station gate twice, the underground
// gate four times. job_board's own commentary records the drift as it was discovered piecemeal ("treat
// any bot-branch guard absent from this branch as a live defect, not a design choice"), which is a file
// asking to be given this module. Under the old shape a new posting branch was born ungated and looked
// correct; here a job cannot reach the board without passing every gate, because there is one road.
//
// ── TWO PROPERTIES A GATE MUST HAVE ───────────────────────────────────────────────────────────────
// 1. IT RUNS AT THE END, over a job that already exists. A gate that fires mid-assembly saves the work
//    of building a job — a few objects of config arithmetic — and pays for it by having nothing to
//    report, because the thing it rejected was never made. Building first and rejecting after costs
//    nothing measurable and makes every refusal nameable.
// 2. IT SAYS WHAT IT HELD AND WHY (Law 6). A silent filter looks identical whether it is working or
//    dead. Every gate here returns a REASON rather than a boolean, so the board can print the verdict
//    beside the job that earned it.
//
//    THE REASON IS SPLIT IN TWO, and the split is what makes the board's report readable rather than a
//    wall. A gate holding six jobs holds them for ONE cause with six particulars, so it returns
//    `{ why, detail }`: `why` is the clause every job it held shares, `detail` is the part that differs.
//    Printed flat, the shared clause repeats once per job and the eye cannot find the particular in it —
//    which is how a board holding eleven jobs reads as a loop rather than as a system waiting for dawn.
//    A gate whose reason has no per-job part may still return a bare string; applyGates normalises both.
//
// 3. IT NAMES WHAT WOULD RELEASE THE JOB, IN ITEMS, WHEN IT KNOWS (`shortOf`). `detail` is prose for a
//    reader; `shortOf` is the same fact as a list a machine can act on. A held job IS a job waiting on
//    something, and these verdicts are the fleet's only record of who is waiting for what — a record,
//    not a lever: nothing reorders work off it (see job_ranking's deleted-promotion note; borrowing
//    another band's row to serve a held job is exactly what that deletion forbids).
//    Every gate that already computes an item states it — the prose and the list are derived from the
//    same value at the same moment, so they cannot come to disagree (Law 25). A gate holding a job for a
//    reason that is not an item (the clock) omits it, which is not a gap: nothing produces daylight.
//
// ── WHAT IS NOT A GATE, AND MUST NEVER MOVE HERE ──────────────────────────────────────────────────
// Ownership routing reads like a gate and is not one. "This row belongs to assessors/furnace, not to
// assessors/supply" (`furnaceInput`) and "this chest row already has a bot row, stand down"
// (`_hasBotRowFor`) both decide WHO assesses a row, not whether a built job may be offered. Moving them
// here would post a job and then reject it in every sweep, which is a loop wearing a filter's clothes.
// The test: does it disqualify a job that was correctly built, or does it prevent the wrong assessor
// from building one? Only the first belongs here.

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
const { isNightTime, isDaylightOnlyJob, mayGatherOutdoors, STONE_PROSPECT } = require('@thinking/architect_config');

// The four recipe-reading gates bind SUPPLY jobs only. A mining, farming or canopy verb has no stock row,
// no recipe and no `need` in the same sense, so asking them these questions produces answers about the
// wrong thing (see undergroundGate for the case where that answer is actively harmful).
const SUPPLY = 'supply';
// Mining verbs are exempt from the recipe-reading gates but NOT from the tool gate — see toolGate.
const MINING = 'mine';

// ── THE DECLARATION A JOB CARRIES ─────────────────────────────────────────────────────────────────
// Built ONCE, in job_board's supplyJob constructor, from the stock row the job came from — never
// hand-written per posting branch, because per-branch construction is exactly the duplication this file
// was made to end. A job with no stock row behind it carries no block and answers only the gates that
// read the job itself.
//   requires_station          a PLACED station this work needs (stock `requires_station`)
//   mode                      'active' | 'passive' (stock `mode`)
//   after_fulfilled           another item whose request must be closed before this one may be
//                             offered (stock `after_fulfilled`) — the row names it, never this module
//
// THE MODE OVERRIDE EXISTS FOR ONE STRUCTURAL REASON, not as a convenience hatch. A tool row is TWO
// rungs behind one `deficit_below`: the bootstrap (the bot holds zero of the family) and the spare/upgrade. Those
// rungs already dispatch at different ranks because they are different asks — the first axe is a
// discount on every log the fleet will ever cut, the second is insurance against a future break — and
// they differ in REACH for the same reason. A row declares the mode of its bootstrap; a spare is
// insurance, and insurance bought from material already in hand is the definition of passive.
//
// Without this, a row's single `mode: 'active'` reaches BOTH rungs, and a spare wooden axe opens a log
// gather ahead of a structure with a nightfall deadline — the exact cost the bot category sitting above
// the build was supposed to be protected from. The override is the only one, it is named at its one call
// site, and any second use of it should be read as a row that wants splitting instead.
// `requires_craft_stations` IS DERIVED FROM THE RECIPE, NOT FROM THE ROW, and that is the whole reason
// it is a third source alongside the two above. The requirement belongs to neither: not to the stock row
// (a row does not know a pickaxe is 3x3) and not to the posting site (which would be a hand-kept list of
// which rows need a table, stale the first time a recipe changes and green while it is wrong). The recipe
// document already states it, so the constructor asks it — the recipe walk below reads it.
//
// THE WALK STOPS AT WHAT IS ALREADY HELD (`HELD_ENOUGH`), and that is the whole of this requirement being
// a question about the work rather than about the recipe. A station is needed only if the fleet still has
// to MAKE the ingredient behind it; an ingredient already in the pocket needs none, because the step that
// would have used one is not going to run. Walked unconditionally, a torch — a 2x2 craft — inherits the
// furnace its `charcoal` branch names, and a bot holding charcoal is refused a torch over a furnace it has no
// reason to visit. Law 16 is what the predicate restores rather than loosens: the fulfiller's own
// decomposition stops at the first ingredient it holds, so an unconditional walk here is a SECOND
// definition of one question, and it refuses work the fulfiller was ready to do (Law 25 — the gate's
// criterion has to be the performer's). supply_manager's Law 13 assertion passes the SAME predicate; if
// the two ever diverge, the wider one throws on exactly what the narrower one cleared.
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

// ── SHARED MEASUREMENT — DELETED, AND ITS ABSENCE IS THE POINT ────────────────────────────────────
// `chestsTotal` and `totalAvailable` lived here and were this module's own pool builders. They are gone
// because inventory_lens now owns every "how much is there" question, and leaving a second door open is
// the exact fault the lens was built to close (Law 16). Their old header argued for one implementation
// with two entry points; the lens is that argument carried one scope further out — one implementation
// for the whole fleet, and the entry points are named for the VERB the answer is spent on rather than
// for the pool they happen to read.
//
// Do NOT reintroduce a local counter here "just for the gates". A gate that measures its own pool is how
// this file and its fulfiller came to disagree about the word `have` three separate times.

// ── THE SHORTFALL PREDICATE — ONE TEST, TWO CONFIGURATIONS ────────────────────────────────────────
// "Is any ingredient of this craft below what ONE craft costs, measured where a CRAFT can spend it."
//
// THIS WAS TWO FUNCTIONS AND THEY WERE THE SAME FUNCTION. The farm-chain gate asked it about one
// hardcoded ingredient class; the passive-mode check asked it about every ingredient. Two bodies, one
// question, so a fix to the arithmetic in one silently did not reach the other — and the arithmetic is
// the subtle part (see the per-craft note below). The class filter is now a parameter, which is the
// whole of the difference that ever existed between them.
//
// PER-CRAFT, NOT PER-BATCH, AND THIS IS NOT A ROUNDING CHOICE. Testing `> 0` opens the gate on one stray
// unit while the fulfiller needs three, so the order posts, soft-fails, re-posts unchanged, and five
// identical outcomes kill the signal — the gate defers the sentry-kill instead of preventing it. Testing
// the FULL batch is wrong in the other direction: it holds a craft the fleet could genuinely start, so
// "cannot reach" silently becomes "will not act". One craft's cost is the only threshold where the gate
// and the fulfiller agree about the same world.
// THE POOL IS THE CRAFT POOL — THE POCKET — AND THAT IS THE WHOLE CORRECTION (Architect 2026-08-15).
// This measured pocket+chests and killed a 73-minute run: six bones sat in a chest, so the gate
// read bone_meal as affordable and posted the order; the fulfiller crafts from its HAND, reported
// `bone=0`, released, and the board re-posted unchanged until the sentry fired. An ingredient in a chest
// is not an ingredient a crafter can reach — supply_manager's only withdrawal step is guarded by
// `if (!magnet.destination)` AND pulls the FINISHED item, never an ingredient, so for this case no code
// path exists at all. Asked through inventory_lens so the constraint is carried by the function's NAME
// rather than by this paragraph: `spendableForCraft` cannot quietly become the wider pool the way a bare
// `accessibleMaterialPool()` call did.
//
// SCOPE, and it is deliberately narrow: this predicate models the CRAFT route only. A local job whose
// FINISHED item already sits in a chest is satisfiable by withdrawal with no craft at all, and asking
// this about such a job returns a true answer to the wrong question. Handling that is not this
// function's job and must not be added here — the caller decides whether the craft route is even the
// one in question (see passiveGate's withdrawal branch), because "is a craft affordable" and "is this
// row fillable" are different questions and folding them produces a predicate neither caller can trust.
// `countIngredient` is THE POCKET BY DEFAULT, and a caller overrides it only where the fulfiller has a
// withdrawal path for that ingredient. Exactly one class qualifies: a CHAIN PRODUCT (charcoal,
// wheat). supply_manager treats those as LEAVES obtained by withdrawing from their storage chest —
// they have no synchronous craft and no gather — so for them, and only them, "in a chest" is reachable.
// Everything else keeps the pocket, because a crafter consumes from its hand.
function shortOfAnyIngredient(item, onlyClass = null, countIngredient = null) {
    const recipe = craftingRegistry.tryGetRecipe(item);
    if (!recipe || !recipe.ingredients) return null;    // no recipe → nothing to be short OF
    const count = countIngredient || (ing => inventoryLens.spendableForCraft(ing));
    for (const ing of Object.keys(recipe.ingredients)) {
        if (onlyClass && !onlyClass.has(ing.trim().toLowerCase())) continue;
        if (count(ing) < (recipe.ingredients[ing] || 1)) return ing;
    }
    return null;
}

// ── THE WALK-BACK, ONE COPY, TWO READINGS ─────────────────────────────────────────────────────────
// Both root-reading gates below call `craftShortfall` (build_material_calculator) and differ ONLY in
// which roots they care about and what they do with the answer: `underground` looks for roots the
// surface cannot supply and converts them into a mining pull; `obtainable` looks for any root at all
// while the gathering route is shut. Two questions, one walk.
//
// WHY THE BOARD MUST WALK THE WHOLE CHAIN, not just the top recipe (Architect, this round): the board is
// the ONLY party allowed to refuse. supply_manager accomplishes whatever it is handed — it decomposes,
// crafts, and goes out for what is missing without a second opinion — so an order the board posts is an
// order that WILL be attempted. Predicting one level down and hoping is what produced the loop: the
// board cleared a pickaxe, the fulfiller decomposed it, hit logs, and the two disagreed forever. The
// board's walk must reach the same leaves the fulfiller will reach, because there is no longer anything
// downstream to catch it (Law 16 — one gate, and this is it).
function rootsStillNeeded(job) {
    return inventoryLens.rootsNeededFleetWide(job.what, job.need, job.at_destination);
}
function describeRoots(short) {
    return Object.entries(short).map(([root, need]) => `${need}x ${root}`).join(', ');
}

// ── THE GATES ─────────────────────────────────────────────────────────────────────────────────────
// Each takes (job, ctx) and returns a REASON STRING to disqualify, or null to let the job through.
// ctx = { inventory, allStations, pullNeeded }.
//
// A job declares what the gates should ask about in `job.gates` (see job_board's supplyJob). A job with
// no `gates` block is subject only to the gates that read the job itself — night and obtainability —
// which is correct: a mining or canopy verb has no stock row behind it and no recipe to walk.

// NIGHT — the verb itself is outdoor work and the sun is down. A POSTING gate, never a preemption: a
// job already claimed runs to completion (Law 4 — one live signal, and nightfall must not reach in and
// cancel it), so a bot caught out at dusk finishes and comes home; it is simply offered nothing else
// outdoors until dawn.
//
// THE DAYTIME-PREFERENCE HALF IS DROPPED, NOT MISSING. Making a daylight job outrank every non-daylight
// job during the day would put clear_canopy above respawn_recover and eat_food, sending a starving bot
// to prune trees. Ruled out on that ground — do not reintroduce it as an obvious improvement. The
// dispatch table's own order IS the preference; this only ever removes rows from it.
function nightGate(job) {
    if (!isNightTime()) return null;
    return isDaylightOnlyJob(job) ? 'outdoor verb after dusk' : null;
}

// STATION — the work needs a PLACED station, and the registry is the authority rather than the pocket.
// A held station item is not the same thing: a throwaway furnace has no registry entry to hold a smelt
// order, so early game must neither attempt the craft nor carve a station to satisfy one.
function stationGate(job, ctx) {
    const need = job.gates?.requires_station;
    if (!need) return null;
    const present = Object.values(ctx.allStations || {}).some(s => s && s.type === need);
    // The station ITEM is what would release this job, and naming it here is what puts that on the board
    // where a reader can see what the hold is for. A placed station is the one shortfall on this list
    // that is satisfied by a BUILD rather than by material arriving.
    return present ? null : { why: 'work needs a placed station', detail: need, shortOf: [need] };
}

// `stationItemGate` IS DELETED, and the `requires_station_item` block with it. It asked whether the
// POCKET held a station the job would set down in a field — the mirror of stationGate's "does one
// STAND". Nothing sets a station down in a field any more: a furnace is only ever a voxel in a placed
// blueprint, so the one job that carried the block is gone and a gate no job declares is a route with
// no traffic (Law 16). Do not restore it to gate a pocket-placed station; that would be re-opening the
// design, not repairing the wiring. `stationGate` still asks the registry question, which is the one
// that survived.

// CRAFT STATION — the recipe needs a workbench this bot cannot reach, so the craft cannot be attempted.
//
// THE SECOND STATION QUESTION, AND IT IS NOT `stationGate`. That one asks whether a station STANDS; a
// craft is satisfied EITHER by one standing or by one in the pocket, because the crafter walks to a
// standing table or places its own and takes it back. Asking only the registry holds a bot carrying the
// answer; asking only the pocket sends it to make a second table beside one already standing. The union is `stationUsable`, and it is read from station_registry rather than restated here
// so this gate and the fulfiller's assertion cannot come to disagree (Law 16) — the fulfiller THROWS on
// what this gate lets through, so a disagreement here is a crash there rather than a missed hold.
//
// NAMING THE STATION IN `shortOf` IS THE REPORT, not a diagnostic nicety: it is what makes a held tool
// job legible as "waiting on a table" rather than as an unexplained absence from the board. It does not
// reorder anything — band order is authored and nothing moves a job out of its band (see job_ranking's
// deleted-promotion note) — so the table is reached because it sits in a band of its own, not because
// something waiting on it lifted it. The config's own note on `crafting_station` refuses a rank relation
// for the same reason: an order can only ever make the table LIKELY first.
//
// THE WRONG TURN, BECAUSE IT IS THE PLAUSIBLE ONE: letting the job through and having the fulfiller
// report "cannot fulfill" reads as a dead end to the loop judge, which kills the signal after five
// identical outcomes — while the table job sits claimable one row below on the same board. A shortfall
// that has a producer must be HELD and named, never released as an impossibility.
function craftStationGate(job, ctx) {
    const needed = job.gates?.requires_craft_stations;
    if (!Array.isArray(needed) || !needed.length) return null;
    const missing = needed.filter(station => !stationRegistry.stationUsable(station, ctx.inventory));
    if (!missing.length) return null;
    return {
        why: 'the recipe needs a workbench that is neither standing nor in the pocket',
        detail: missing.join(','),
        shortOf: missing,
    };
}

// MATERIAL — DELETED 2026-08-15, AND NOTHING REPLACES IT. It held a batch threshold from the stock row:
// wait until enough fuel exists to make a full run, rather than making one set and posting again. The
// Architect struck the whole idea: "no gating materials at all, stuff needs to be used." A partial order
// is the CRAFTER's to compute and report — make what is affordable, state the true shortfall (Law 25) —
// never the board's to prevent by refusing to post work the fleet could partly do.
//
// The withholding was also self-defeating in a way no reader could see from the trace. A threshold sized
// above the restock floor means the fuel that WOULD satisfy the floor sits unspendable, so the number can
// come to rest one unit under the bar and stay there: the gate holds material back, nothing consumes it,
// nothing triggers more, and a row that is one short reads exactly like a row that is broken. Material
// that exists is meant to be used, and the pull chain only runs when something spends.
//
// The stock fields behind it (`gate`, `gate_min`) are gone from config with it, so the declaration a job
// carries no longer has a `requires`/`requires_min` to answer. Re-adding either is re-adding this gate.

// CHAIN — an ingredient that arrives ONLY from another chain's producer: grown (wheat) or smelted
// (charcoal). Binds regardless of the row's mode, because this is a physical
// impossibility rather than a policy: no wild scan finds wheat and none finds charcoal, so an active row
// cannot reach for either. Without it a bread restock at wheat 0 — or a torch restock at fuel 0 —
// re-posts, re-claims, and trips the sentry-kill.
//
// WHY THIS HOLDS AND THE UNDERGROUND GATE PULLS, WHICH IS THE WHOLE DISTINCTION THE FLEET SORTS ON:
// a root belongs to a chain that is ALREADY RUNNING and is fed by material the surface provides (logs
// for the smelter, a tilled plot for the field), so the wait is pipeline latency and the correct action
// is to file nothing and let the producer produce. An underground root has no producer until a shaft is
// dug, so its shortfall must commission one. Filing a mining pull for a chain root is what makes the
// torch chain circular: class the torch's fuel root underground and a bot short of light asks for a
// DESCENT — and the descent is itself gated on light. Naming the right door is what breaks the circle.
//
// HUNT ROOTS (string, bone) DELIBERATELY ABSENT. Their one consumer is a passive row, and the passive
// gate below reports it under a reason that tells the reader more ("not already on hand" names the
// row's own policy; "another chain owns it" would bury that). Adding them changes no behaviour and
// costs a diagnostic — put them here only if an ACTIVE row ever takes a mob drop as an ingredient.
// THIS GATE COUNTS THE WHOLE REACHABLE POOL — CHESTS INCLUDED — AND THE CONDITION FOR THAT IS NAMED HERE,
// because it is legal only while the fulfiller can genuinely reach chest stock for this ingredient. It
// can: the fulfiller withdraws a needed material from a chest before it will go out and harvest one
// (its Step 4a), so a chain product banked by one bot is spendable by another. That is what makes a
// SHARED producer work — whoever empties the furnace is usually not whoever asked for the output, so the
// emptier banks it and the asker withdraws it, with the chest as the handover.
//
// COUNTING ONLY THE POCKET IS THE FAILURE THIS AVOIDS, and it is not a mild one: it refuses an order the
// fleet can already fill, forever, because the material sits one chest away and nothing in the loop ever
// moves it into a pocket. A bot standing beside twelve charcoal, told it could not reach any.
//
// THE CONDITION THAT MAKES IT SAFE, so a future reader can check it rather than trust it: a chain product
// has a WITHDRAWAL PATH by construction — it is smelted or grown into storage and taken out from there —
// while an ordinary craft ingredient has none. Counting chests for an ordinary ingredient killed a
// 73-minute run: bones in a chest read as affordable, the fulfiller crafted from its hand, found none,
// released, and the board re-posted until the sentry fired. So `shortOfAnyIngredient`'s DEFAULT stays the
// pocket and only these two calls widen it. Widening the shared predicate re-opens that loop.
//
// IF THE WITHDRAWAL PATH IS EVER REMOVED, THIS MUST NARROW WITH IT — the two are one decision. It was
// narrowed to the pocket for exactly one day on the belief that no ingredient withdrawal existed; the
// belief was wrong, but the coupling it named is real.
// TOOL — obtaining one of this order's roots needs a tool the fleet does not hold. Rock is the only case
// today: punching stone yields nothing at all, so the gather returns empty rather than short, five
// identical times, into a judge kill. The bot is not slow without a pickaxe; it is incapable.
//
// WHY THIS IS A GATE AND NOT AN ASSESSOR CHECK. Until now the only thing keeping a pickaxe-less bot off a
// cobblestone order was the position of `crafting_tool_bootstrap` in the `bot` band's array — the stage
// rule covers the ordinary case (a pickaxe is a `craft`, stone is a `gather`, craft outranks gather), but
// with no logs on hand the pickaxe order ALSO measures `gather`, the two tie, and the array breaks the tie.
// An accidental, undocumented protection resting on the order lines are typed in a config file. This
// states it once, where the other equipment questions are asked, and names the pickaxe as what releases it.
//
// THE SAME PREDICATE THE MINING MANAGER RELEASES ON, deliberately: a board that offers work the fulfiller
// declines is a claim/release loop the judge eventually kills, so the two must answer "may this bot mine"
// from one place (Law 16, Law 25 — one world, one verdict).
//
// MINING VERBS PASS THROUGH THIS GATE TOO, which is why it does not take the SUPPLY-only bound its
// neighbours do. `assessors/mining` used to hold its own silent copy of this test; a gate that reports the
// reason replaces it, because a job held for an unstated reason is indistinguishable from a job nobody
// wanted (Invariant C).
const TOOLED_ROOTS = new Set([...STONE_PROSPECT_ITEMS, ...UNDERGROUND_ITEMS]);
function toolGate(job, ctx) {
    const { hasPickaxe } = require('@action/mining_manager.js');   // lazy: cycle-safe, matches assessors/mining
    if (hasPickaxe(global.bot).ok) return null;

    if (job.type === MINING) {
        return { why: 'no pickaxe in the pocket', detail: 'pickaxe', shortOf: ['pickaxe'] };
    }
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

// A HOLE NEEDS A WAY BACK OUT, AND THAT IS A FACT ABOUT THE POCKET, NOT ABOUT THE TABLE. Surface stone
// comes from stone_prospect, which digs a column and seals it behind itself on the climb — one placeable
// block per block dug. A bot that descends without `filler_reserve` spendable blocks in hand concedes at
// the bottom, the judge replans, the board is unchanged, and the same order is claimed again: a spin that
// presents as a stalled executor while the cause is two tables away.
//
// THIS REPLACES A LOAD-TIME ORDERING ASSERTION (architect_config, deleted with the tiebreak) that said no
// stone-consuming job type may be LISTED above the planks supplier in the bot band. That rule could only
// be stated as a claim about array position, it could not name what it protected, and — the part no
// ordering rule could ever fix — a table cannot sense a pocket, so it was silent for a bot that had the
// planks row satisfied at post time and lost the planks before it descended (Invariant B).
//
// SHORT OF `planks`, NOT OF "filler". Soil and sediment count toward the reserve and neither is sought, so
// naming the family would name something no job can produce; planks are the one member the fleet can be
// asked for, so the verdict names something the fleet could actually go and get (Law 25).
function fillerGate(job, ctx) {
    if (job.type !== SUPPLY || !(job.need > 0)) return null;
    const wantsRock = Object.keys(rootsStillNeeded(job)).some(root => STONE_PROSPECT_ITEMS.has(root));
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

// THE TARGET IS ASKED ABOUT BEFORE ITS INGREDIENTS, AND SKIPPING THAT HALF HALTS BOTS.
// `shortOfAnyIngredient` opens with "no recipe → nothing to be short OF", which is the right answer to
// the question it was written for and the wrong one here: every member of these two sets is a GROUP
// token, and a group token has no blueprint BY CONSTRUCTION. So a job whose target IS the chain product
// walks through a gate built to hold exactly that job, while a job that merely names it as an ingredient
// is held — one gate, two answers, and the same item on both sides of it (Law 16).
//
// The failure is not a stall, it is a halt. Nothing downstream can absorb it: the board is the only
// party allowed to refuse (see the walk-back note above), so an order it clears WILL be attempted, and
// the fulfiller's only honest reply is that it is waiting on a chain. Repeated to the judge's
// identical-outcome ceiling, that kills the signal and parks the planner — while the job that would
// PRODUCE the material sits unclaimed on the same board. The producer jobs are safe from this check
// because they are posted under a furnace/farm verb, not as a SUPPLY row, and this gate binds SUPPLY only.
//
// "None is reachable" is the gate's own threshold and is deliberately not tightened to the job's `need`:
// a partial supply is a job that can make progress, and holding it would refuse work the fleet can do.
function chainGate(job) {
    if (job.type !== SUPPLY) return null;
    // A SUBSTITUTE IS STOCK EVEN THOUGH IT IS NOT THE NAMED ITEM. A recipe names the member the fleet can
    // MAKE (charcoal), because that is the one an order can be routed to; the discovered member (coal) can
    // be spent in its place but can never be ordered, so it has no business in the recipe and every
    // business in this count. Reading the named item alone holds a torch craft from a bot standing on
    // three coal — a hold nothing in the loop can ever clear, since no chain produces coal on demand.
    // Applied at `reachable` rather than at each call site so the target-side checks and the ingredient
    // walk below cannot drift apart about whether the same bot is short (Law 16).
    const reachable = ing => {
        let n = inventoryLens.reachableByFleet(ing);
        for (const alt of (SUBSTITUTES_FOR[ing] || [])) n += inventoryLens.reachableByFleet(alt);
        return n;
    };

    const want = String(job.what || '').trim().toLowerCase();
    if (FARM_ITEMS.has(want) && reachable(want) <= 0)
        return { why: 'the item itself is farm-grown and none is reachable', detail: want, shortOf: [want] };
    if (FURNACE_CHAIN_ITEMS.has(want) && reachable(want) <= 0)
        return { why: 'the item itself comes off the furnace chain and none is reachable', detail: want, shortOf: [want] };

    const grown = shortOfAnyIngredient(job.what, FARM_ITEMS, reachable);
    if (grown) return { why: 'ingredient is farm-grown and none is reachable', detail: grown, shortOf: [grown] };
    const smelted = shortOfAnyIngredient(job.what, FURNACE_CHAIN_ITEMS, reachable);
    return smelted
        ? { why: 'ingredient comes off the furnace chain and none is reachable', detail: smelted, shortOf: [smelted] }
        : null;
}

// PASSIVE — the row is filled from what already exists and never opens a chain of its own
// (architect_config `mode`). Mode is intrinsic and permanent; a row is active-gated or passive-gated and
// an opening gate never promotes it. This gate is where "passive" becomes a behaviour instead of a word.
//
// STORAGE IS A ROUTE, NOT AN INGREDIENT — the withdrawal branch below, and the reason the ingredient test
// is not the whole gate. Asking only "can I craft this" answers ONE of the two ways a passive row gets
// filled, and then refuses the row on the strength of the other one being unavailable. A finished item
// already sitting in a chest satisfies the row by a TRIP, with no craft and no chain opened — which is
// what passive means, not a loosening of it.
//
// THE FAILURE THIS CLOSES is not a slow fill, it is a DEADLOCK, and it lands hardest exactly when it
// matters most: a bot that respawns with an empty pocket cannot craft anything at all, so the ingredient
// test refuses every passive row it owns — including the weapon row whose spare is stocked in a chest for
// this precise case. Nothing downstream rescues it, because the fulfiller's withdrawal step runs only
// AFTER dispatch and the gate is what prevents the dispatch. The bot then walks back out unarmed.
// Architecturally it is two owners of one decision (Invariant D): the fulfiller owns the fill ladder
// (withdraw → craft → gather) and this gate was ruling the whole ladder impossible from the last rung.
//
// GATED ON EXACTLY WHAT THE FULFILLER WILL ASK FOR, which is why both conditions are narrow:
//   - `!job.destination` mirrors the fulfiller's own `if (!magnet.destination)` guard. A row WITH a
//     destination is a chest-to-chest restock that deliberately routes through harvest instead, so
//     opening the gate for one would promise a withdrawal that never happens.
//   - `job.what` is the CONCRETE item, not the family. The board resolves a tool row to one tier and the
//     fulfiller withdraws that exact name, so asking the family here would open the gate on a chest
//     holding a DIFFERENT tier and hand the fulfiller an order it cannot fill — the gate and the
//     fulfiller disagreeing about the same world, which is the fault this module exists to end.
// KNOWN AND ACCEPTED, so it is not rediscovered as a bug: a chest holding a BETTER tier than the one the
// pocket can craft still reads as empty here, and the row stays held. That is the safe direction (Law 13,
// default-stopped) — a held row is reported and re-asked next sweep; a posted unfillable one kills the
// signal. Widening it means teaching the board to post the tier that is IN the chest, which is a change
// to what the job is, not to what this gate reads.
function passiveGate(job) {
    if (job.type !== SUPPLY || job.gates?.mode !== 'passive') return null;
    if (!job.destination && inventoryLens.inChests(job.what) > 0) return null;
    const short = shortOfAnyIngredient(job.what);
    return short ? { why: 'passive row — ingredient not already on hand', detail: short, shortOf: [short] } : null;
}

// UNDERGROUND — the craft decomposes to a root the bot lacks and cannot reach on the surface.
// THE ONLY GATE WITH A SIDE EFFECT, and it is the reason it must not be reordered casually: it converts
// the shortfall into a mining PULL rather than dropping it, so the descent knows what the surface work
// was waiting for. Ordered AFTER the passive gate on purpose — a pull is acquisition, and a passive row
// may not cause acquisition of any kind; reversed, a passive sword would quietly commission a descent
// for its own cobblestone.
// AFTER-FULFILLED — this row's request may not be offered while another named request is still open.
// The row declares what it waits on (`after_fulfilled` in STOCK_THRESHOLDS); nothing here names an item,
// so adding a second waiting row is a config edit rather than a code edit.
//
// WHY A GATE AND NOT A RANK. "Iron last" is a real ordering need with no rank that expresses it: iron sits
// in the `chest` band, ties with the chest's own logs request, and the tie was broken by array position —
// the accidental mechanism this system is removing. A gate states the condition once, in the row that has
// it, and reports itself when it holds.
//
// THE EVIDENCE IS THIS SWEEP'S OWN POSTED WORK, not a re-measured stock level. A logs request still on the
// board IS logs being unfulfilled, stated by the assessor that owns that row — so this gate cannot come to
// disagree with the row it is waiting on, which a second measurement here certainly would (Law 16, Law 25).
//
// IT MUST RUN BEFORE `underground`, and that ordering is the whole point rather than a preference. Iron's
// root is raw_iron; `undergroundGate` converts a short underground root into a mining pull as a SIDE
// EFFECT. Ordered after it, a gated iron row would still commission the descent it was being held back
// from, and the hold would be a label on a bot already underground.
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

function undergroundGate(job, ctx) {
    // SUPPLY ONLY, and this is a correctness bound rather than an optimisation: a mining job's own `what`
    // IS an underground material, so an unbounded gate would hold every mining job and route a pull for
    // the very thing that job was dispatched to fetch — a loop that feeds itself.
    if (job.type !== SUPPLY || !(job.need > 0)) return null;
    // The shortfall is already NET of everything on hand at every level, so its counts ARE the pull —
    // the older shape decomposed to raw and subtracted inventory afterwards, which could not see a held
    // intermediate and commissioned a descent for material the bot was carrying in plank form.
    //
    // MEASURED AGAINST THE SAME POOL AS EVERY OTHER GATE (pocket + chests), and the mismatch it replaces
    // is what kept one pull alive for a whole run. This gate used to read the POCKET only while the
    // passive and material gates read pocket+chests, so a row could pass "already on hand" against a
    // chest and then be held here against an empty pocket — commissioning a descent for material
    // the fleet was already storing. Paired with a keep of zero on that material it cannot converge: the
    // bot mines it, the next dump banks all of it, the pocket reads zero again, and the pull re-arms
    // every sweep. A mining pull must mean "the fleet does not have this", never "this bot is not
    // carrying it" — the fulfiller withdraws from a chest without going anywhere near the mine.
    const short = rootsStillNeeded(job);
    const gatedOn = [];
    for (const [root, need] of Object.entries(short)) {
        if (!UNDERGROUND_ITEMS.has(root)) continue;
        ctx.pullNeeded[root] = Math.max(ctx.pullNeeded[root] || 0, need);
        gatedOn.push(root);
    }
    return gatedOn.length
        ? { why: 'underground root short — routed to the mining pull', detail: gatedOn.join(', '), shortOf: gatedOn }
        : null;
}

// OBTAINABLE — finishing this order would require going out for something, and the outdoor route is
// shut. By DAY mayGatherOutdoors is true for every rank, so this reduces to "gathering is available" and
// holds nothing; the gate only bites when a route the order depends on is actually closed.
//
// THIS IS THE ONLY NIGHT GATE ON A GATHER, and that is a structural commitment, not a tidy-up. There was
// a second one inside supply_manager, refusing the gather at the door and releasing the job — which meant
// the board could post an order the fulfiller would then decline, forever, five times, into a judge kill.
// Two parties owning one decision is the fault (Invariant D); the fulfiller now accomplishes whatever it
// is handed, so a mistake here sends a bot outside at night rather than looping — a bounded cost with a
// rank-1 recovery, against an unbounded one. Do not "restore safety" by adding a check downstream.
//
// Distinct from the night gate above: that one holds jobs whose VERB is outdoor, this holds orders whose
// MATERIAL is unreachable, and they clear differently — a blacklisted verb waits for dawn and nothing
// else changes it, while an unobtainable order clears the moment material lands from the mine or a
// peer's deposit.
function obtainableGate(job) {
    if (job.type !== SUPPLY) return null;          // mining/canopy verbs have no recipe to walk
    if (!(job.need > 0)) return null;
    if (mayGatherOutdoors(job)) return null;
    const short = rootsStillNeeded(job);
    // Named roots rather than "unreachable": the reason line is the only place a held order explains
    // itself, and "needs 1x logs" tells the reader what arriving material would release it.
    return Object.keys(short).length
        ? { why: 'no gather route open until dawn', detail: describeRoots(short), shortOf: Object.keys(short) }
        : null;
}

// ── THE ORDER, AND WHY IT IS THE ORDER ────────────────────────────────────────────────────────────
// First match wins, so this decides which REASON a held job is reported under, and one of the five
// carries a side effect. Cheapest and most absolute first (a clock read, a registry lookup), then the
// recipe walks, then the one that mutates. The two rules that are load-bearing rather than tidy:
//   - `underground` runs after `passive`, so a passive row never commissions a mining pull.
//   - `chain` runs BEFORE `underground`, so a root another chain already produces is never converted
//     into a mining pull. Reversed, a torch short of fuel would commission a descent — and the descent
//     is gated on torches, which is a circle no later gate can open.
//   - `tool` runs before `chain` and `underground`, so a rock order with no pickaxe is reported as
//     needing the TOOL rather than as needing the rock. Reversed, `underground` would file a mining pull
//     for stone the bot cannot mine — commissioning the descent that the missing pickaxe forbids.
//   - `craft_station` sits with the other two station questions and ahead of every recipe walk: a craft
//     that has no workbench cannot proceed however its materials read, so reporting it as short of an
//     ingredient would name a shortfall that is not the one holding it.
//   - `obtainable` runs last because it is the deepest walk and the least specific verdict; anything
//     with a namable cause should be reported under that cause instead.
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

// Returns { posted, held } — each held entry carries { job, gate, why, detail, shortOf, reason }.
// `reason` is the flat rendering, kept so any caller wanting one string does not re-join the halves
// itself; `shortOf` is the machine-readable half job_ranking reads to find who is waiting on what.
// NOTHING IS DROPPED SILENTLY: a job either reaches `posted` or appears in `held` with the name of what
// stopped it. That is the property the mid-assembly `continue`s could not have (Law 6), and it is why
// this returns both halves rather than the surviving list.
function applyGates(jobs, ctx) {
    // The sweep's own job list, so a gate may ask whether another request is still open. Attached here
    // rather than threaded through every caller: applyGates already holds the list, and a gate reading it
    // is reading a decision this sweep already made rather than re-measuring the world (Law 6).
    ctx = { ...ctx, allJobs: jobs };
    const posted = [];
    const held = [];
    for (const job of jobs) {
        let stopped = null;
        for (const [name, gate] of GATES) {
            const verdict = gate(job, ctx);
            if (!verdict) continue;
            // Normalised here, once, so no gate has to remember which shape it chose and no reader has
            // to handle both (Law 10 — one message contract, not two).
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
