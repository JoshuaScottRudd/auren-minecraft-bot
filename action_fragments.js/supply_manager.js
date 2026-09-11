// supply_manager.js
// Load-bearing manager. Receives a supply job from the dispatcher,
// derives the next step from current world state, dispatches one executor.
// Loops via recursive_judge (Phase 2 stamp routing) until the job is done.
//
// Priority tree (one step per cycle):
//   1. Have the target item?
//      a. Job has a chest destination:
//         - If item is a harvestable raw material (not underground, no recipe)
//           AND not returning from harvest → dispatch harvest first (no inventory shortcut)
//         - Otherwise → dispatch delivery_executor to deposit
//      b. No destination → job complete (release)
//   2. Can craft it now? → dispatch craft_executor
//   3. Can craft an intermediate? → dispatch craft_executor for that
//   4. Need raw materials? → dispatch tree_harvester / block_puncher
//   5. Need a different biome? → dispatch biome_seeker
//   6. Nothing possible → release job (signal recursive_judge from self)
//
// Steps 2-3 are handled by _planOneCraftStep (ported from crafting_planner).
// Steps 4-5 walk the recipe with @utils/calculators/build_material_calculator.craftShortfall.

'use strict';

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const { group_to_item: ROOT_GROUPS, getBotInventory, underground_items, stone_prospect_items, furnace_chain_items, farm_items, hunt_items, normalizeItemName, chestItemCounts } = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const inventoryLens = require('@kernel/inventory_lens');
const { routeToJudge, routeSignal } = require('@utils/signal_utils');
const stationRegistry = require('@perception/station_registry');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const { craftShortfall } = require('@utils/calculators/build_material_calculator');

const TAG = 'supply_manager';

// The executors whose return means the bot is holding stock it MADE for the request in hand, rather
// than the kit it walked in with. Membership is the ONLY way a storage delivery may be paid out of
// the pocket — see the pocket-eligibility block in the run handler for the full rule and the livelock
// it ends.
//
// `delivery_executor` is deliberately absent: a delivery returning is the job FINISHING, and admitting
// it here would re-open the completed request against whatever is left in the pocket — the same race
// one step later. Membership is earned by PRODUCING goods, never by moving them.
const PRODUCER_EXECUTORS = new Set(['harvest_executor', 'craft_executor', 'furnace_executor', 'mining_executor', 'stone_prospect_executor']);
// STATION_TYPES lived here and is gone with the planner's station filter: the recipes' own `requires`
// already names every station, so a hand-kept set of station names was a second copy of that field
// (Law 16). `crafting_blueprint_registry.stationsRequiredFor` reads the recipes directly.
const STORAGE_TYPES = new Set(['chest', 'trapped_chest', 'barrel']);
const CRAFTING_GROUPS = ['logs', 'planks', 'stairs', 'door', 'stone'];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Blueprint + inventory helpers (ported from crafting_planner)
// ─────────────────────────────────────────────────────────────────────────────

// Registry, not a live read. The old fs.readFileSync here ran on every supply plan, so deleting the
// file to upload a new one crashed the bot at the next plan (Law 13 makes an unreadable declared file a
// throw, correctly — the defect was re-reading at all). Still NO CATCH and no `{}` fallback: that
// fallback would turn an unreadable blueprints file into the silent world-claim "no recipes exist",
// and the supply planner would then plan as though nothing is craftable — a wrong answer wearing a
// confident face.
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

function _readInventory() {
    const totals = {};
    for (const [name, count] of Object.entries(getBotInventory())) {
        const norm = normalizeItemName(name);
        totals[norm] = (totals[norm] || 0) + count;
    }
    return totals;
}

// Aggregate the contents of every storage chest into one totals object, the same
// shape as _readInventory. This lets the storage chests and the bot's pockets be
// reasoned about as a single inventory: a raw material already sitting in a chest
// can be pulled instead of harvested. Chopping a tree while hundreds of logs sit
// in storage is pure waste.
function _readChestInventory() {
    const totals = {};
    for (const entry of Object.values(stationRegistry.getStations())) {
        if (!entry || !STORAGE_TYPES.has(entry.type)) continue;
        for (const [n, c] of Object.entries(chestItemCounts(entry))) totals[n] = (totals[n] || 0) + c;
    }
    return totals;
}

// `_readBufferInventory` IS DELETED with the buffer→requester courier it fed (Step 0 below, and the
// second attempt inside the pocket-is-not-fulfilment branch). A `storage` request is measured across
// EVERY chest, so a chest→chest move leaves the figure that opened the job unchanged: the courier would
// report a delivery, the shortfall would re-post identically, and the fleet would shuffle one stack
// between two chests forever (Law 25, Law 16 — the full argument is at the deleted `transferBetweenChests`
// in inventory_swapper). What restocks storage now is what always really did: create the material, or
// carry in what a producing verb made.

function _getMakes(bp, item) {
    const seq = Array.isArray(bp.sequence) ? bp.sequence : [];
    const step = seq.find(s => s && s.item === item);
    return (step && typeof step.makes === 'number' && step.makes > 0) ? step.makes : 1;
}

// _stationAvailable lived here and is now `stationRegistry.stationUsable` — the same union (a station
// stands OR one is in the pocket), moved to the module that owns the standing half. It had to move
// because job_gates asks the identical question one step earlier, and a copy on each side of that
// boundary is a copy that drifts: the gate would then hold work this fulfiller would have done, or pass
// work it now THROWS on (Law 16, and Law 25 — one world, one verdict).

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Root material analysis
// ─────────────────────────────────────────────────────────────────────────────

// _computeRootSet and _findMissingRoots lived here and are gone: two private copies of the recipe walk
// that `@utils/calculators/build_material_calculator.craftShortfall` already owns (Law 16). One had no
// caller at all; the other disagreed with the calculator at a group token — it stopped walking AT the
// group and answered with a token no gather job can fill, while the calculator resolves a group to its
// producible member and keeps walking to a real root. A fulfiller that decomposes differently from the
// board that gated it turns one bug into a difference of opinion between two files.
//
// A furnace product (charcoal, iron_ingot) has a blueprint, but its recipe needs a furnace —
// craft_handler can't smelt, so it is NOT synchronously craftable. Treat it as a LEAF: obtained by
// withdrawing whatever the fleet already holds, and otherwise reported short — which is what raises the
// smelt order that produces it (`assessors/furnace`). Decomposing it as a normal craftable instead walks
// the recipe back to logs and tries to "craft" charcoal from logs, which dead-ends: no step a fulfiller
// can take performs a smelt. This is the fractal pattern: torch → withdraw or await charcoal + make
// sticks (from planks from logs).
function _isFurnaceProduct(item, byItem) {
    const bp = byItem[item];
    return !!(bp && Array.isArray(bp.requires) && bp.requires.includes('furnace'));
}

// The generalization of the above: a material this manager must never try to GATHER, because some
// other chain is the only thing that produces it. Two chains qualify today — the furnace (charcoal,
// iron_ingot) and the farm (wheat) — and they behave identically from here: treat it as a leaf, skip
// it in the gather loop, and let a short batch craft with what's on hand rather than stalling.
//
// WHY the two are one predicate: an unmarked chain product's shortfall becomes a gather,
// harvest_executor scans for a material that cannot exist on the surface, and recursive_judge halts
// the bot on repeated identical not-found failures. Marking it via _isFurnaceProduct would require
// inventing a furnace recipe for a farm product — see farm_items in fragment_utils for why that is the
// wrong turn. The chain differs; the protection does not.
//
// hunt_items (string, bone) is the third chain: a mob drop no block scan can find, so it is a leaf to
// the whole supply cascade and the gather loop must never be sent after one.
function _isChainProduct(item, byItem) {
    return _isFurnaceProduct(item, byItem) || furnace_chain_items.has(item)
        || farm_items.has(item) || hunt_items.has(item);
}

// Can this manager raise the supply of `item` by itself — craft it here, or gather it off the surface?
// No, when another chain owns it: the furnace (charcoal), the farm (wheat), or the mine (everything in
// underground_items). Strictly wider than _isChainProduct, and the two are NOT interchangeable — they
// answer different questions, so they guard different sites:
//   _planOneCraftStep  -> "is waiting for a full batch pointless?"  Use THIS one. Nothing this manager
//                         does will produce the missing input, so take the partial batch now.
//   the gather loop    -> "skip, or throw?"  Use _isChainProduct. A chain product missing is an ordinary
//                         timing state (mid-smelt, mid-grow) -> skip. An underground root reaching a
//                         GATHER is a job_board gating bug -> _dispatchGather throws, and must keep
//                         throwing. Widening that site instead would make the throw dead code and delete
//                         the diagnostic (Law 16).
//
// THE GROUP-SHAPED HOLE THIS GUARDS, stated once because it recurs for every group token: a recipe can
// ask for a GROUP while the classification marker sits on an ITEM, so an item-level check answers false
// for the very thing the chain owns, the craft planner dead-ends on a short ingredient, and
// _dispatchGather throws a CODING VIOLATION on a bot standing next to the material. The wider guard is
// what keeps the next group token added to a recipe — which arrives unlisted — a partial batch instead
// of a crash.
function _isExternallySupplied(item, byItem) {
    return _isChainProduct(item, byItem) || underground_items.has(item);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Craft step planning (ported from crafting_planner Section 8.7)
//
// Given a target item and its goal, walks the ingredient tree recursively
// to find the single deepest-first item+quantity to dispatch this cycle:
//   - If all ingredients are on hand → dispatch the target itself
//   - If an ingredient is short AND has a blueprint → recurse into it
//   - If an ingredient is short with no blueprint → return null (need gathering)
//   - If a required station is missing → return null
// ─────────────────────────────────────────────────────────────────────────────

function _planOneCraftStep(topItem, topHave, topTarget, byItem, inventory, _visiting) {
    if (!_visiting) _visiting = new Set();
    if (_visiting.has(topItem)) return null;

    const bp = byItem[topItem];
    if (!bp || !bp.ingredients) return null;

    // THE STATION CHECK THAT WAS HERE IS GONE, AND ITS ABSENCE IS LOAD-BEARING (Law 16). It filtered any
    // recipe whose workbench was out of reach, returning the same `null` a nonexistent recipe returns —
    // so "blocked on a table" and "impossible" arrived at Step 6 as one value and were reported as the
    // second. The question is now asked once, at the dispatch boundary above, as an assertion: every
    // station in this tree is reachable or nothing got this far. Re-adding a check here would restore the
    // silent null the assertion exists to make unreachable.
    const shortfall = Math.max(topTarget - topHave, 0);
    if (shortfall <= 0) return null;
    const craftsNeeded = Math.max(1, Math.ceil(shortfall / _getMakes(bp, topItem)));

    for (const [rawIng, perCraft] of Object.entries(bp.ingredients)) {
        const ing = rawIng.trim().toLowerCase();
        const ingHave = _getInventoryCount(ing, inventory);
        const ingNeeded = perCraft * craftsNeeded;
        if (ingHave < ingNeeded) {
            // A chain-product ingredient (charcoal from the furnace, wheat from the farm) isn't
            // synch-craftable and isn't gatherable — it's withdrawn from a chest once its own chain
            // delivers. Bail so Step 4/4a withdraws it ONLY when we can't even make ONE craft with
            // what's on hand. If there's enough for ≥1 craft, fall through and dispatch the craft NOW
            // as a PARTIAL batch: craft_handler crafts until the scarce input drains, stops cleanly,
            // and a later cycle tops up from that chain for the remainder. Bailing on a full-batch
            // shortfall would stall the bot holding a producible surplus while storage was
            // still empty mid-chain — zero progress where progress was available, then a judge halt
            // (Law 11: the loop must shrink the gap). This is also what lets a partial batch of a
            // scarce chain-product ingredient still produce finished goods instead of demanding the
            // full amount up front.
            if (_isExternallySupplied(ing, byItem)) {
                if (ingHave < perCraft) return null;
                continue;
            }
            const ingBp = byItem[ing];
            if (!ingBp || !ingBp.ingredients) return null;

            // ONE CRAFT'S WORTH OF EVERY SUB-INGREDIENT, never "any of any". This tested `> 0` on a
            // single sub-ingredient, which is a PRESENCE test standing in for an AFFORDABILITY test, and
            // the two differ exactly where it costs most: one plank makes `hasAnySub` true and cannot
            // make a stick, because a stick craft costs two. The step was then dispatched, craft_handler
            // decomposed it properly, found nothing it could do, and reported the identical failure until
            // the judge killed the signal — the plan was a well-formed falsehood, valid in shape and
            // impossible in fact (Law 25). Same threshold the board's gates use: one craft's cost is the
            // only line where the planner and the fulfiller are talking about the same world.
            const oneCraftAffordable = Object.entries(ingBp.ingredients).every(([sub, perSub]) =>
                _getInventoryCount(sub.trim().toLowerCase(), inventory) >= perSub
            );
            if (oneCraftAffordable) {
                return { item: ing, quantity: ingNeeded, have: ingHave };
            }
            // Cannot afford even one craft of the intermediate — recurse deeper to find the leaf-most
            // step that IS affordable (planks from logs), and return null when the walk bottoms out on a
            // raw material. Null is what routes the job to Step 4's gather, which is the correct answer
            // when the chain's root is simply not on hand.
            _visiting.add(topItem);
            const deeper = _planOneCraftStep(ing, ingHave, ingNeeded, byItem, inventory, _visiting);
            _visiting.delete(topItem);
            return deeper;
        }
    }


    return { item: topItem, quantity: topTarget, have: topHave };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Inventory snapshot helper
//
// Walks the ingredient tree for a target item and returns a compact string
// showing every ingredient and sub-ingredient with its current inventory count.
// e.g. for stone_pickaxe: "cobblestone=19 stick=2 planks=0 logs=186"
// ─────────────────────────────────────────────────────────────────────────────

// A ZERO HERE MUST SAY WHETHER THE MATERIAL IS ABSENT OR MERELY OUT OF REACH, and that distinction is
// the difference between a fleet that is genuinely short and one standing next to what it needs. This
// line printed `bone=0` once a second for twenty minutes while six bones sat in a chest, and no
// amount of reading it could have revealed that — the number was true and the conclusion it invited was
// false (Law 25: a true log line that misleads about the situation is still a failed report).
// inventory_lens is asked for the chest half; a count of zero that has stock elsewhere renders as
// `bone=0(+6 chest, unreachable by craft)`, which names the fault instead of describing the symptom.
function _invSnapshot(topItem, byItem, inventory) {
    const items = new Map();
    const walk = (item) => {
        const bp = byItem[item];
        if (!bp || !bp.ingredients) return;
        for (const rawIng of Object.keys(bp.ingredients)) {
            const ing = rawIng.trim().toLowerCase();
            if (items.has(ing)) continue;
            items.set(ing, _getInventoryCount(ing, inventory));
            walk(ing);
        }
    };
    walk(topItem);
    const render = (name, count) => {
        if (count > 0) return `${name}=${count}`;
        const banked = inventoryLens.inChests(name);
        return banked > 0 ? `${name}=0(+${banked} chest, unreachable by craft)` : `${name}=0`;
    };
    if (items.size === 0) return render(topItem, _getInventoryCount(topItem, inventory));
    return [...items.entries()].map(([k, v]) => render(k, v)).join(' ');
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

// Consecutive-harvest ceiling. tree_feller fells exactly ONE tree per invocation;
// toward a large log goal (e.g. 64) the manager would otherwise re-dispatch it for
// minutes straight, tunnel-visioning on wood while nothing else re-evaluates — the
// build gate, the peer's stock, shifting priorities. recursive_judge can't catch it:
// each trip's readable varies ("mined 57" / "mined 55", or a different column's
// coordinates), so its identical-outcome counter never trips. So the manager caps
// itself: after MAX_GATHER_STREAK trips in a row it releases to recursive_judge →
// job_board (managers route there, judge:296) for a fresh sense-plan. The next sweep
// re-dispatches if still short, but now behind a fresh planning-token turn with current
// world state. The streak lives on the magnet (Law 6, inspectable); the dispatcher
// rebuilds the magnet on each claim, so a genuinely new job — or a re-dispatch after
// this release — starts the count at zero.
//
// THE CAP COUNTS TRIPS, NOT TREES, AND THAT IS WHAT MAKES IT WORK FOR BOTH PRODUCERS.
// `_dispatchGather` routes to exactly two executors — the tree feller and the stone
// prospect — and the runaway is the same shape whichever one answers: a bounded haul
// per trip, a shortfall that outlasts it, and a unique readable every time so no
// downstream judge can see the repetition. A shaft yields nine cobblestone the same way
// a tree yields a variable pile of logs; three of either is where the bot owes the
// planner a fresh look.
const MAX_GATHER_STREAK = 3;

// The two producers `_dispatchGather` can route to. A RETURN from anything else (a
// craft, a deliver, a withdraw) is what breaks the streak, because the count means
// "consecutive gather trips" — so the set has to name every gather producer or a
// second one silently resets the first's count and the cap never fires for either.
const GATHER_EXECUTORS = new Set(['harvest_executor', 'stone_prospect_executor']);

// Returns true if the cap was reached and a replan-release was issued (caller returns
// immediately). Otherwise records one more trip on the streak and lets the caller gather.
function _gatherCapReached(botId, boardroom, magnet, note) {
    const streak = magnet.gather_streak || 0;
    if (streak >= MAX_GATHER_STREAK) {
        watcher.summary(TAG, `${note} | gathered ${streak}x in a row — yielding to brain for replan`);
        _releaseJob(`gathered ${streak}x in a row for ${magnet.what} (still short of ${magnet.hold_goal}) — replan`);
        return true;
    }
    magnet.gather_streak = streak + 1;
    boardroom.magnet = magnet;
    hq.writeBoardroomChair(botId, boardroom);
    return false;
}

// THE ONE DOOR OUT OF THE BASE — and it does not decide whether to walk through it.
//
// THERE IS NO NIGHT CHECK HERE, DELIBERATELY (Architect, this round: "there is only one night gate and
// that's job_board"). One lived here, refusing the gather and releasing the job back to the judge. It was
// a SECOND owner of one decision (Invariant D), and the two owners disagreed: the board cleared an order
// on a walk that only looked one level down, the fulfiller decomposed it for real, reached a root it was
// then forbidden to fetch, and released — so the board re-posted the identical order every sweep until
// five identical outcomes killed the signal. A gate that cannot stop the order being re-made does not
// prevent the trip, it only converts it into a loop.
//
// The fix is upstream, not stricter here: the board now walks the whole chain to its leaves
// (craftShortfall) and refuses an order whose roots need a shut route. This manager's contract is to
// ACCOMPLISH what it is handed. Do not reintroduce a refusal at this door — a board mistake then costs
// one night trip and a possible death, which is bounded and has a rank-1 recovery, where the loop it
// replaces is unbounded.
function _dispatchGather(payload, root) {
    if (underground_items.has(root.item)) {
        throw new Error(
            `[supply_manager] CODING VIOLATION (Law 13): dispatched to gather ` +
            `"${root.item}" which is underground. job_board should have gated ` +
            `this tier until the bot had enough materials. ` +
            `Inventory has ${root.have} of ${root.need} needed.`
        );
    }
    // ONE DOOR, TWO PRODUCERS — chosen by what the material IS, which is the split this manager's own
    // header already states ("holder decides destination; item nature decides source"). Stone has a
    // producer a lone bot can run (one column, dug and sealed), and it is not the surface scan: felling
    // and punching cannot yield rock, so sending cobblestone to harvest_executor would post a gather
    // that can only ever come back empty, five times, into a judge kill. This is a second DESTINATION,
    // never a second route — the decomposition, the shortfall, and the gate above are all shared
    // (Law 16). See fragment_utils.stone_prospect_items for what belongs on this side.
    if (stone_prospect_items.has(root.item)) {
        routeSignal(TAG, 'stone_prospect_executor', {
            ...payload,
            manager:   TAG,
            objective: [root.item],
            quantity:  root.need,
            readable:  `${TAG}: prospect ${root.need}x ${root.item}`,
        });
        return;
    }
    routeSignal(TAG, 'harvest_executor', {
        ...payload,
        manager:   TAG,
        objective: [root.item],
        quantity:  root.need,
        readable:  `${TAG}: gather ${root.need}x ${root.item}`,
    });
}

// THE ONE WAY A STORAGE MISS MAY BECOME A GATHER — and for an underground root it may not.
//
// A chest that empties between the station-registry snapshot and the withdrawal is an ENVIRONMENTAL
// failure (Law 13): a peer legitimately took the last stack while this bot walked. But the recovery
// both storage paths reached for mints a gather order out of thin air — an order the board never
// walked, never gated, and would have refused. When the root is an underground item that order lands
// straight on _dispatchGather's throw, and because the fallback runs inside an async executor return
// rather than under the judge, the throw surfaces as an unhandled rejection and takes the bot down.
// So a real environmental race was being converted into a fatal coding-violation report about a
// decision nobody made.
//
// The throw is CORRECT and stays: only the board may authorize a trip underground, and a manager
// minting one behind its back is exactly the violation it names. What was wrong is reaching the throw
// at all. Releasing hands the shortfall back to the one party that owns the decision, which re-posts
// through the gate that either clears the trip or ranks something else first — the environmental
// failure travels, and nothing is invented on the way (Law 13, Law 25: report the shortfall, never
// substitute a route around it).
function _fallBackToHarvest(payload, item, amount, note) {
    if (underground_items.has(item)) {
        _releaseJob(`${note} — "${item}" is underground and only job_board may authorize that trip; returning to the board to replan`);
        return;
    }
    _dispatchGather(payload, { item, need: amount, have: 0 });
}

// Consecutive-withdraw ceiling — THE JUDGE FOR THE CONTINUATION LOOP BELOW (Law 11: every loop needs
// exactly one judge, and re-entering our own receive is a loop even though nothing is routed).
//
// The loop terminates on its own arithmetic — the continuation only runs when `transferred > 0`, so each
// pass moves at least one item chest→pocket and both counts are finite. This ceiling exists because that
// argument rests on `_readChestInventory` REFLECTING the withdrawal, and it reads a station-registry
// snapshot rather than the chest: a registry entry that goes stale would offer the same items forever and
// spin the ladder with nothing to show. Four covers the deepest real chain (a craft whose two roots both
// sit in storage, plus slack); past that the job goes back to recursive_judge, which is the pathway that
// already owns a step that will not converge. Lives on the magnet like gather_streak (Law 6, inspectable)
// and resets for free: the dispatcher rebuilds the magnet on every claim.
const MAX_WITHDRAW_STREAK = 4;

// Pull a raw material (or the finished item) from a storage chest instead of
// harvesting it. A storage chest and the bot's pockets are one inventory (Law 15
// API call). inventory_swapper.retrieveItems owns its own caller-abandonment: if the
// chest is unreachable it routes a fresh signal to recursive_judge itself and returns
// undefined — we must NOT route again (Law 4: one signal).
//
// ON THE HAPPY PATH THE JOB CONTINUES HERE; IT DOES NOT GO BACK TO THE BOARD. A job that needs
// something should run through the whole chain in one claim — gather, craft, dump excess, then release
// to recursive_judge — rather than dropping back to the board after each intermediate step.
//
// A withdraw was the ONE step in this manager that broke that. Gather and craft both stamp `manager: TAG`
// on the routed payload, so recursive_judge sends the executor's report straight back here (its
// stampedManager branch) and the whole job already ran inside ONE claim — the chain holds for those two.
// A withdraw has no executor to stamp, so it reached the judge as a bare manager signal, the judge read
// that as the manager RELEASING, and the claim was dropped mid-job.
//
// THAT is the gap the dump walked into: inventory_dump outranks every supply job, so the instant a
// withdrawn material landed in the pocket and the claim went back on the board, the bot was re-dispatched
// to dump the very thing it had just fetched — alternating withdraw and dump until the judge killed the
// signal. The wrong turn: this was very nearly fixed by giving `logs` a keep-amount so the withdrawn
// stack stopped counting as excess. That would have hidden this one instance behind a threshold and
// left every other material free to reopen it.
//
// Calling our own receive is the continuation. It re-reads the chair and RE-SENSES the inventory
// (Invariant B — the pocket is exactly what just changed), then runs the same ladder the next dispatch
// would have run, minus the trip through the board that loses the claim. Not a Law 1 violation: a
// fragment calling ITSELF is not action-to-action messaging, and no signal is routed, so no second signal
// exists (Law 4) and no chain is re-entered (Law 12). watcher.track holds no per-call state, so the trace
// nests the continuation under the step that caused it.
async function _withdrawFromChest(payload, item, amount) {
    const inventorySwapper = require('@api/inventory_swapper');
    const bot = global.bot;
    const result = await inventorySwapper.retrieveItems(bot, item, amount);

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
    const botId = process.env.BOT_ID || 'default';
    const boardroom = hq.readBoardroomChair(botId, {});
    const magnet = boardroom?.magnet;
    const streak = (magnet?.withdraw_streak || 0) + 1;

    if (!magnet || streak > MAX_WITHDRAW_STREAK) {
        _releaseJob(`withdrew ${result.transferred}x ${item} from storage (${streak - 1} withdraws in a row — replan)`);
        return;
    }

    magnet.withdraw_streak = streak;
    boardroom.magnet = magnet;
    hq.writeBoardroomChair(botId, boardroom);

    watcher.summary(TAG, `withdrew ${result.transferred}x ${item} from storage — continuing the job (withdraw ${streak}/${MAX_WITHDRAW_STREAK})`);
    module.exports.receive(TAG, { ...payload, from: `${TAG}:withdraw`, executor: 'inventory_swapper' });
}

// `_transferBufferToRequester` IS DELETED. It was the manager's half of the chest→chest courier: a
// storage shortfall was "filled" by moving the material out of one chest and into another. A storage
// figure sums every chest, so that move cannot change it — the job released reporting a delivery, the
// deficit re-posted unchanged, and the pair would run forever (Law 25: an outcome signal that cannot be
// true; Law 16: a route that cannot produce its own outcome). A storage deficit closes only by material
// entering the fleet.

// ── THE STATION KEY IS CARRIED, NEVER REBUILT (fixed 2026-09-10) ────────────────────────────────────
// This line used to be `const stationId = `${magnet.where.x}|${magnet.where.y}|${magnet.where.z}``, and
// that rebuild was WRONG from 2026-08-30 onward — the day `station_registry.stationKey` began appending
// the owner to the voxel (`25|65|-1|homesteader`, the keycard change). A coordinate cannot carry an
// owner, so the rebuilt key matched no row, `inventory_swapper` found no target, and EVERY storage
// delivery abandoned with `no_deposit_target_for_<item>` and re-posted forever.
//
// It took eleven days to see because reaching this line needs a chest BUILT and a storage row in
// deficit, and no run got that far — the runs in between died on the freeze, the planks loop and the
// craft regression. The first clean run found it in eight minutes.
//
// A KEY IS MINTED IN ONE PLACE (Law 16). The chest's key now travels: assessor → job → magnet
// whitelist → here. A missing one is a WIRING fault, not a world state, so it throws rather than
// improvising a key that would fail the same silent way (Law 13).
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

// Release back to recursive_judge. NO dumpExcess here anymore: offloading is a single job_board
// job now (inventory_dump), fired only when the pocket is nearly full. This also removes the old
// dump=false special-casing — the withdraw path used it to avoid re-dumping just-pulled material,
// but with no release-time dump at all there is nothing to special-case (Law 16 — one dump pathway).
function _releaseJob(reason) {
    routeToJudge(TAG, { readable: `${TAG}: ${reason}` });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Main receive handler
//
// Called in two contexts:
//   a) Fresh dispatch from dispatcher (payload.job exists)
//   b) Returning from an executor via recursive_judge (payload.executor exists)
// Both cases: read the magnet, derive the next step, dispatch.
// One watcher.summary per decision cycle (Law 16).
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

        // Break the gather streak the moment a NON-GATHER executor returns: the "in a row"
        // count is about consecutive gather trips, so a craft/deliver/withdraw in between
        // resets it (see MAX_GATHER_STREAK).
        //
        // TESTED AGAINST THE SET, NOT AGAINST ONE NAME. Naming a single producer here means
        // every other one counts as an interruption: a returning stone prospect zeroed the
        // count, so shaft-return-shaft-return held the streak at one forever and the cap
        // could never fire for stone — and a shaft between two fells reset the tree count
        // the same way. A cap defeated by the existence of a second producer is not a cap.
        if (payload.executor && !GATHER_EXECUTORS.has(payload.executor) && magnet.gather_streak) {
            magnet.gather_streak = 0;
            boardroom.magnet = magnet;
            hq.writeBoardroomChair(botId, boardroom);
        }

        const targetItem = magnet.what;
        const holdGoal = magnet.hold_goal || 1;

        // ── Deliver return: delivery_executor finished a chest deposit ──
        if (magnet.action === 'deliver' && payload.executor === 'delivery_executor') {
            // The carried key, not a rebuilt one — a trace that prints an id no row has is what let the
            // delivery bug hide: the line looked exactly right (see `_dispatchDelivery`'s note).
            watcher.summary(TAG, `${targetItem} (${holdGoal}) from=${from} | deliver complete to ${magnet.destination} (${magnet.station_id}) | RELEASE`);
            _releaseJob(`deliver done for ${targetItem}`);
            return;
        }

        const inventory = _readInventory();
        const byItem = _loadBlueprints();
        const have = _getInventoryCount(targetItem, inventory);
        const snap = _invSnapshot(targetItem, byItem, inventory);

        // A "Step 0" once stood here: a chest-destination job whose material already sat in another chest
        // was released by couriering it across instead of producing anything. Deleted with the courier —
        // storage is measured across every chest, so the move could not shrink the deficit that opened
        // the job (Law 25, Law 16; see the deleted `_transferBufferToRequester` above).

        // ── IS THE POCKET EVEN ELIGIBLE? ──────────────────────────────────────────────────────────
        // A storage request is fulfilled by CREATION — harvest or craft. The bot's own inventory is not a
        // second source: it cannot use its resting kit as fulfillment for a request, because the kit and
        // the creation path are two different systems and they cannot race over the same goods.
        //
        // Decided ONCE, above Step 1, because it changes what Step 1 even means. The old guard lived
        // inside Step 1 and covered HARVESTABLE ROOTS only: a crafted item has a blueprint, so the test
        // was false for it and the delivery was paid straight out of the pocket. That is the livelock this
        // guard closes: two jobs for one item racing over the same stock — the storage job reading
        // `have >= goal` and depositing the bot's kit, the local kit job then reading the pocket as short
        // and withdrawing the very same items back, forever. Neither job was wrong alone; they were
        // spending one pile of goods against two ledgers.
        //
        // The rule is about the DESTINATION being a chest, never about the kind of item — so the item
        // test widened rather than a second guard being added beside it (Law 16). A `wooden_sword`
        // special case would have left every other craftable holding the same race.
        //
        // The producer executors are the way through: returning from a harvest or a craft, the bot holds
        // stock it MADE for this request, which is raw creation and not the kit. Withdrawing raw
        // materials from a chest in order to craft is explicitly allowed by the ruling and is untouched —
        // that happens on the craft path below.
        const pocketBlocked = !!(magnet.destination && magnet.where) && !PRODUCER_EXECUTORS.has(payload.executor);

        if (pocketBlocked && have >= holdGoal) {
            const isHarvestableRoot = !underground_items.has(targetItem) && !byItem[targetItem];
            if (isHarvestableRoot) {
                if (_gatherCapReached(botId, boardroom, magnet, `${targetItem} (have ${have}/${holdGoal})`)) return;
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → harvest first (chest supply from trees, not inventory) | ${snap}`);
                _dispatchGather(payload, { item: targetItem, need: holdGoal, have });
                return;
            }
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | pocket is NOT fulfillment for a storage request — creating fresh | ${snap}`);
            // No return: falls past Step 1 into the craft path, the ruling's second legal source.
        }

        // ── RESERVED vs. SPENDABLE, and why the TARGET moves rather than the HAVE ────────────────────
        // The first cut of this fix zeroed the spendable count and left the goal at `holdGoal`, which
        // dispatched `craft 2x wooden_sword` while the bot already held 2. craft_executor re-derives its
        // own quantity from real inventory, so it did nothing, reported SUCCESS, and its own name on the
        // return payload then unblocked the pocket — the kit went into the chest anyway, one step later.
        // A guard that is satisfied by a no-op is not a guard.
        //
        // So the reserve is expressed as a RAISED GOAL instead: hold `have` back as untouchable and aim
        // creation at `holdGoal + reserved`, which is real work the executor cannot no-op through.
        // Coming back with a surplus, the bot delivers the goal amount and keeps the rest of its kit —
        // it either sees the extra sitting in a chest or creates it from scratch. The reserve is
        // the pocket's whole count rather than a configured minimum, because nothing in the fleet
        // declares a kit size and inventing that registry is a design act for the table, not a fix
        // (Law 22 gate 2).
        const reserved = pocketBlocked ? have : 0;
        const haveSpendable = have - reserved;
        const creationGoal = holdGoal + reserved;

        // ── PRECONDITION: EVERY WORKBENCH THIS ITEM'S RECIPE TREE NEEDS IS REACHABLE ─────
        // A CODING VIOLATION, NOT AN ENVIRONMENTAL ONE, AND THE DISTINCTION IS THE WHOLE POINT. By the
        // time a job is dispatched here it has passed job_gates' craft_station gate, which asks this
        // exact question through the same `stationUsable`. So a job arriving unstationed means the gate
        // did not run, did not cover this row, or disagreed with this call — all bugs in the wiring, none
        // of them a state the world can produce (Law 13's test: could this happen in a correctly-written
        // system in a normal world? No).
        //
        // WHY A THROW AND NOT A SOFT-FAIL, WHICH IS WHAT THIS REPLACED: the planner used to filter
        // unstationed recipes out silently, so a craftable item came back indistinguishable from an
        // impossible one and this manager released the job reporting "no craftable step or gatherable
        // root" — a false statement (Law 25) that the loop judge reads as a dead end and kills the signal
        // over, while the job that would place a table sits claimable on the same board. A second,
        // gentler handler here would be a redundant route doing the gate's job (Law 16): by the time the
        // dispatch arrives it is too late to repair anything, because the repair is a POSTING decision
        // and posting is upstream. Crash and name the row instead — the stack says which gate leaked.
        // THE PREDICATE IS NOT OPTIONAL AND MUST MATCH job_gates.HELD_ENOUGH. The walk stops at an
        // ingredient already in hand, because that branch will never be crafted and its station is not a
        // requirement of anything that will happen. Asserting over the WHOLE tree while the gate clears
        // the remaining one throws on precisely the work the gate just approved — a crash manufactured by
        // the two disagreeing about reach rather than by any fault in the job (Law 16).
        const heldEnough = (ingredient, quantity) => inventoryLens.spendableForCraft(ingredient) >= quantity;
        const unreachableStations = [...craftingRegistry.stationsRequiredFor(targetItem, heldEnough)]
            .filter(station => !stationRegistry.stationUsable(station, inventory));
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
        // Storage is the PRIMARY source: a resource the bot needs
        // for its own inventory may already sit in storage (harvested/bought/crafted-
        // overshoot). Withdraw it before harvesting — the bot only harvests for itself
        // when NO chest holds the item. Take whatever is there
        // (min(inChest,deficit)); a later sweep harvests only the remainder once the
        // chests are dry. Local (no-destination) supply only: storage RESTOCK
        // (has a destination) still routes through harvest, else chest→pocket→chest just
        // shuffles storage. _withdrawFromChest owns its own Law 15 abandonment, and CONTINUES the job
        // rather than releasing — which is what keeps a withdrawn material out of the dump job's reach
        // (see the withdraw↔dump oscillation written up there). This used to lean on job_board's
        // min/keep hysteresis for that instead; a stock row with no restock floor removed the guard
        // silently, and the run died. The claim, not the threshold, is what protects the material now.
        if (!magnet.destination) {
            const deficit = holdGoal - have;
            const inChest = _getInventoryCount(targetItem, _readChestInventory());
            if (deficit > 0 && inChest > 0) {
                const pull = Math.min(inChest, deficit);
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → withdraw ${pull}x ${targetItem} from chest (chest has ${inChest}, harvest covers any remainder) | ${snap}`);
                _withdrawFromChest(payload, targetItem, pull);
                return;
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
        // AIMED AT creationGoal, THE SAME TARGET THE CRAFT PATH USES. This read `holdGoal`, and the
        // mismatch is invisible until the pocket is reserved: a storage job on a bot already carrying
        // the goods has `have >= holdGoal`, so this walk found a shortfall of zero and returned NO roots
        // while the craft path — correctly aiming at holdGoal + reserved — was still trying to produce
        // two more. Craft says "make two", gather says "nothing is missing", the step is neither, and the
        // job releases and re-dispatches unchanged into a judge kill. The reserved-goal reasoning above
        // is one decision; both consumers of it must read the same number or it is two (Law 16).
        // THE WALK IS THE CALCULATOR'S, NOT THIS MANAGER'S (Law 16). This manager kept a private copy of
        // the recipe walk, and the two answered the same question differently: the calculator resolves a
        // group token to its producible member and keeps walking to a real root, while the copy stopped AT
        // the group and answered a token no gather job can fill. One rule, one implementation; the fulfiller
        // and the board that gated it now decompose identically or the disagreement is a bug in one place
        // rather than a difference of opinion between two.
        //
        // `need` IS ALREADY NET of everything the pool holds — the calculator spends the budget as it
        // walks. `have` rides along for the reason line only, and subtracting it from `need` would debit
        // the same stock twice.
        const missingRoots = Object.entries(craftShortfall(targetItem, creationGoal, inventory))
            .map(([item, need]) => ({ item, need, have: _getInventoryCount(item, inventory) }));
        if (missingRoots.length > 0) {
            // Step 4a: pull from a chest before harvesting a raw root. Chests
            // + pockets are one inventory — if storage holds ANY of a needed
            // raw material, withdraw it instead of chopping a tree — harvest only when no
            // chest holds it. Take whatever is there
            // (min(inChest,shortfall)); a later sweep harvests the remainder once chests
            // are dry. Skip for chest-destination jobs: storage restock must come from
            // harvest, else chest→pocket→chest just shuffles storage.
            if (!magnet.destination) {
                const chestInv = _readChestInventory();
                for (const root of missingRoots) {
                    const shortfall = root.need;
                    if (shortfall <= 0) continue;
                    const inChest = _getInventoryCount(root.item, chestInv);
                    if (inChest > 0) {
                        const pull = Math.min(inChest, shortfall);
                        watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → withdraw ${pull}x ${root.item} from chest (chest has ${inChest}, harvest covers any remainder) | ${snap}`);
                        _withdrawFromChest(payload, root.item, pull);
                        return;
                    }
                }
            }

            const seen = new Set();
            for (const root of missingRoots) {
                if (seen.has(root.item)) continue;
                seen.add(root.item);
                // Never harvest a chain product: it isn't gatherable. charcoal is smelted by the
                // furnace chain into storage; wheat is grown and reaped by the farm chain
                // (farming_integrity's plant → grow → harvest). Either way it reaches the bot by
                // withdrawal (Step 4a, when present), never by a scan. If it isn't in a chest yet,
                // skip it here; a later sweep withdraws it once that chain delivers.
                //
                // Skipping — not throwing like underground_items does — because a chain product going
                // missing is an ordinary timing state (mid-smelt, mid-grow), not a job_board gating
                // bug. The loop falls through to Step 6 STUCK → release, and the bot picks up other
                // work while the chain runs. Without this distinction, a chain product's shortfall
                // would reach harvest_executor's wild-punch path and halt the bot on repeated identical
                // scans for a crop that only its own chain can make.
                if (_isChainProduct(root.item, byItem)) continue;
                if (_gatherCapReached(botId, boardroom, magnet, `${targetItem} (have ${have}/${holdGoal})`)) return;
                const allRoots = missingRoots.map(r => `${r.item}:${r.need}`).join(',');
                watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | → gather ${root.need}x ${root.item} (have ${root.have}) | roots=[${allRoots}] | ${snap}`);
                _dispatchGather(payload, root);
                return;
            }
        }

        // ── Step 5: Need a different biome? ──────────────────────────────
        //
        // "NO BLUEPRINT" IS NOT THE SAME QUESTION AS "NOT IN THIS BIOME", AND ONLY THE SECOND ONE EXPLORES.
        // A chain product has no recipe either — it is produced by a smelt, a grow or a hunt, not by a
        // craft — so the recipe table alone cannot tell a genuinely-absent material apart from one that is
        // merely not made yet. Sent to the biome seeker, a chain product has no biome that satisfies it:
        // the seeker keeps re-choosing between the nearest candidates, the outcome never changes, and the
        // judge kills the signal on the oscillation. Step 4 already refuses to GATHER a chain product for
        // exactly this reason; this guard is that same answer at the EXPLORE exit, so the manager gives one
        // answer to "can I raise this material" instead of two that disagree (Law 16). Falling through to
        // Step 6 is the point: it renders AWAITING CHAIN, which is the true verdict (Law 25) — the material
        // is coming from another job, and exploring claims a journey would supply what no journey holds.
        const bp = byItem[targetItem];
        if (!bp && have < holdGoal && !_isChainProduct(targetItem, byItem)) {
            watcher.summary(TAG, `${targetItem} (have ${have}/${holdGoal}) from=${from} | no blueprint → EXPLORE | ${snap}`);
            _dispatchExplore(payload);
            return;
        }

        // ── Step 6: Nothing possible — AND THAT IS A CODING VIOLATION, NOT AN OUTCOME ────────────
        //
        // A FOUND LOOP IS GUARDED AT ITS SITE; THE JUDGE IS FOR NOVEL ONES. recursive_judge detects a
        // repeated identical outcome — it is the instrument that DISCOVERS a loop nobody predicted. Once
        // a loop has been diagnosed, leaving the judge to re-find it every time trades a precise message
        // for a generic one: the kill line can only say "five identical outcomes", five cycles after the
        // fault, naming the fragment that reported the symptom instead of the gate that caused it. The
        // throw below fires on the FIRST occurrence and names the cause, so the same defect costs one
        // clear stop rather than five wasted claims and a planner halt (Law 13 — a coding violation
        // throws immediately; Law 22 — the judge's memory is the record, and a guarded loop is a loop
        // that stops being rediscovered).
        //
        // WHY THIS IS A BUG AND NEVER THE WORLD, which is Law 13's own test. The board is the ONLY party
        // permitted to refuse an order — job_gates' walk-back note states it, and it is why nothing
        // downstream re-checks a claim (Law 16: one gate, and that is it). So a job arriving here has
        // already been certified fillable by the only party that judges fillability, and reaching this
        // line means the certificate was false: either the chain gate failed to hold an order whose
        // material only another chain can produce, or the board's requirement walk did not reach the same
        // leaves this fulfiller reaches. Both are gate defects. Neither is a state a correct system
        // produces in a normal world, so soft-failing to the judge would hide a broken gate behind
        // ordinary timing noise.
        //
        // THE TWO ROOT CLASSES ARE KEPT APART IN THE MESSAGE, not because they differ in severity — both
        // throw — but because they name DIFFERENT gates, and the message's whole value is pointing at the
        // one that let this through.
        const rootNames = missingRoots.map(r => r.item).join(',');
        const awaiting = missingRoots.length > 0 && missingRoots.every(r => _isChainProduct(r.item, byItem));
        throw new Error(
            `[${TAG}] CODING VIOLATION: dispatched an order this fragment cannot fill, for ${targetItem} `
            + `(have ${have}/${holdGoal}, from=${from}, roots=[${rootNames}]). `
            + (awaiting
                ? `Every missing root is produced by another chain (smelt/grow/hunt), so no gather can `
                  + `obtain it and this bot can only wait. THE CHAIN GATE SHOULD HAVE HELD THIS ORDER — `
                  + `check job_gates.chainGate covers BOTH the job's own target and its ingredients for `
                  + `every member of FARM_ITEMS / FURNACE_CHAIN_ITEMS. A gate hole here used to surface `
                  + `five cycles later as a judge kill on supply_manager, which named the wrong fragment.`
                : `No craftable step and no gatherable root. THE BOARD'S REQUIREMENT WALK DID NOT REACH `
                  + `THE SAME LEAVES THIS FULFILLER REACHED — the board must walk the whole chain, not `
                  + `the top recipe, because nothing downstream is allowed to refuse what it clears.`)
            + ` Snapshot: ${snap}`
        );
    }),
};
