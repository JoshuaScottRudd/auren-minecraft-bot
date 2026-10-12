// module: inventory_lens
// purpose: THE ONE PLACE ANYTHING ASKS WHERE A MATERIAL IS AND HOW MUCH OF IT EXISTS. One question,
//   one answer, one door — nothing assembles a material pool of its own and nothing counts a chest itself.
//
// ── WHAT EACH FIGURE IS FOR ────────────────────────────────────────────────
// The right pool to count is not a property of the caller, the item, or the situation — it is a
// property of THE VERB THE ANSWER WILL BE SPENT ON. Nothing here is named for a place: `where()`
// returns no `total`, and every figure is named for what it may be used FOR:
//     spendableForCraft   the POCKET — a craft consumes from the hand and cannot reach a chest
//     reachableByFleet    pocket + every registered chest — a bot can WALK to a chest
//     inBuildPool         the build layer — its credited chests and the pocket, less the bot's claim
//     forChestRequest     the storage layer — everything, less the bot's claim and the build's
//
// ── `locations` NAMES WHERE THE ANSWER CAME FROM ───────────────────────────────────────────────────
// An answer that carries its locations makes a stock-vs-reachability mismatch self-describing on its
// first line (Law 6, and Law 25: a true figure that misleads about the situation is still a failed
// report).
//
// ── ONE DOOR TO THE EXISTING PRIMITIVES (Law 16) ───────────────────────────────────────────────────
// Every figure delegates to fragment_utils' pool builders and inventory_calculator's group-aware
// counter; the arithmetic stays where it lives, and this module is the one door that asks which
// question determines the answer.
//
// ── THE TRANSLATOR IN FRONT OF HQ (Law 26) ─────────────────────────────────────────────────────────
// The chest side comes from station_registry, which reads corporate_headquarters — so this module is to
// HQ what trace_monitor is to the watcher trace: the one reader standing between a record and everything
// that depends on it. The POCKET is read live from the body, not from HQ (Invariant B): it changes
// faster than a record can hold.

'use strict';

const { countInInventory } = require('@utils/calculators/inventory_calculator');
const {
    getBotInventory,
    accessibleMaterialPool,
    buildPoolChestCounts,
    chestItemCounts,
} = require('@utils/fragment_utils');

// ── THE ONE QUESTION ──────────────────────────────────────────────────────────────────────────────
// where(item) → the full answer. Every other export is a named reader of one of its figures, kept
// because a caller that needs a single number should not have to remember which field, and because a
// named call site greps better than a field access.
//
// `inventory` is optional: most callers are mid-chain and already hold the snapshot their decision was
// made against, and passing it avoids a second read of the body disagreeing with the first.
//
// Accepts a list meaning "any of these will do" — a torch burns coal or charcoal, a wall takes any
// structural_fill member. Summed here so the group-token rule (one allowance across members, never one
// each) is applied once, in the one place that knows the semantics.
function where(item, inventory = null) {
    const items = Array.isArray(item) ? item : [item];
    const label = items.join('|');
    const pocketCounts = inventory || getBotInventory();
    const fleetPool = accessibleMaterialPool();

    let pocket = 0;
    let fleet = 0;
    for (const one of items) {
        pocket += countInInventory(one, pocketCounts);
        fleet += countInInventory(one, fleetPool);
    }
    const chests = Math.max(0, fleet - pocket);

    const locations = [];
    if (pocket > 0) locations.push({ kind: 'pocket', count: pocket, label: 'pocket' });
    const stationRegistry = require('@perception/station_registry');
    for (const entry of Object.values(stationRegistry.getStations() || {})) {
        if (!stationRegistry.isStorage(entry)) continue;
        const chestCounts = chestItemCounts(entry);
        let count = 0;
        for (const one of items) count += countInInventory(one, chestCounts);
        if (count <= 0) continue;
        const p = entry.pos || {};
        locations.push({
            kind: 'chest',
            count,
            blueprint: entry.blueprint || null,
            pos: entry.pos || null,
            label: `chest${entry.blueprint ? ` ${entry.blueprint}` : ''} (${p.x},${p.y},${p.z})`,
        });
    }
    const item_ = label;

    // The readable is written for the WORST case first, because that is the one nobody catches: stock
    // exists, the craft still cannot happen, and every count in the log is honest.
    const readable = (pocket === 0 && chests > 0)
        ? `${item_}: 0 in pocket, ${chests} in chests [${locations.map(l => l.label).join(', ')}]`
          + ' — reachable by a TRIP, NOT by a craft'
        : `${item_}: ${pocket} pocket + ${chests} chests`;

    // No `total` field: a neutral number invites counting the wrong pool.
    return { item: item_, pocket, chests, spendableForCraft: pocket, reachableByFleet: fleet, locations, readable };
}

// ── NAMED READERS ─────────────────────────────────────────────────────────────────────────────────
// Crafting consumes from the hand: an ordinary ingredient sitting in a chest is not one a crafter can
// use — supply_manager crafts from its own inventory — so a gate counting it posts an order no fulfiller
// can fill.
//
// A CHAIN PRODUCT (charcoal, wheat) is a LEAF to supply_manager, obtained only by withdrawing from the
// storage chest its chain stocks. For that class the reachable pool is the right question, and
// `reachableByFleet` below is the reader job_gates' chainGate calls explicitly.
//
// Not delegated to where(): this reads the pocket alone, where() also walks every registered station to
// build its locations. This is the hottest path in the gates (once per candidate job per sweep), so the
// cheap question stays cheap. Same semantics, same any-of list handling — only the station walk is
// skipped.
function spendableForCraft(item, inventory = null) {
    const counts = inventory || getBotInventory();
    const items = Array.isArray(item) ? item : [item];
    let total = 0;
    for (const one of items) total += countInInventory(one, counts);
    return total;
}

// Answers whether the fleet can reach material anywhere — the right question for deciding whether to
// send someone (a gather trip, a mining descent), not whether a craft can start.
function reachableByFleet(item) {
    const pool = accessibleMaterialPool();
    const items = Array.isArray(item) ? item : [item];
    let total = 0;
    for (const one of items) total += countInInventory(one, pool);
    return total;
}

// EVERYTHING THE FLEET HOLDS, WHEREVER IT IS — the question "how much of this material exists above ground",
// asked by a balance of need against holdings (build_material_calculator.familyBalance). This body's pocket
// and every registered chest, every peer's pocket as its chair last stated it, and every batch a furnace was
// loaded with and has not been emptied of, counted as what it is becoming. A map, because the balance spends
// it across a whole recipe tree.
function fleetHoldings() {
    const pool = { ...accessibleMaterialPool() };
    const add = (name, count) => { if (name && count > 0) pool[name] = (pool[name] || 0) + count; };
    const hq = require('@kernel/corporate_headquarters');
    const me = process.env.BOT_ID || 'default';
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
        if (botId === me || !chair || !chair.inventory) continue;
        for (const [name, count] of Object.entries(chair.inventory)) add(name, count);
    }
    for (const entry of Object.values(require('@perception/station_registry').getStations() || {})) {
        const s = entry && entry.type === 'furnace' ? entry.smelt : null;
        if (s && s.started_at && s.order) add(s.order, s.qty || 0);
    }
    return pool;
}

// Chests only: a SOURCING question, whether this is already banked somewhere so nobody needs to fetch
// more. The pocket is excluded because the asker is standing in it: material in the assessing bot's own
// hands is not material sitting in a chest waiting to be fetched. `forChestRequest` below answers the
// storage layer's stock level, which subtracts claims.
function inChests(item) {
    return Math.max(0, reachableByFleet(item) - spendableForCraft(item));
}

// ── THE LAYERS, AND THE ONE SUBTRACTION THAT SEPARATES THEM ───────────────────────────────────────
// Bottom to top: BOT (the pocket) → BUILDING → STORAGE. Each layer's available stock
// is everything, minus the CLAIMS of every layer beneath it. Nothing is physically segregated: the same
// block in the same chest is counted for one layer and not for another, and which it is depends on
// claim, never on location.
//
// THE ASYMMETRY IS THE WHOLE RULE. A lower layer may be fed by a higher one — a storage chest funds a
// build, material staged for a build funds a pocket craft — but a higher layer may never count a lower
// layer's claim toward its own requirement. So a build that needs a furnace while the bot carries one
// crafts a second, and a storage row's stock level is never vouched for by the pocket or by material the
// build has already spoken for.
//
// COUNTING IS NOT SOURCING. These figures answer what counts toward a layer's requirement, not where a
// fulfiller reaches: the bot's own stock rows are still measured on the POCKET (a chest full of torches
// does not satisfy a bot that has none — it must make the bot go and fetch them), and a craft still
// consumes from the hand.
//
// A CLAIM, NOT A LOCATION, is what survives TRANSIT. Material withdrawn for a build sits in the pocket
// at the instant the build spends it, and `everything` does not change when a block moves, so
// subtracting a claim leaves every layer's figure unmoved by transit. The pocket's claim is its declared
// reserve; pocket stock above that reserve is in transit and belongs to whichever layer withdrew it.
//
// THE BOT'S CLAIM IS THE KEEP RESERVE, READ THROUGH THE ONE KEEP-MATH THAT ALREADY EXISTS.
// `computeExcess` is the single dump-threshold math (Law 16) and returns exactly the wanted figure:
// everything ABOVE the bot's allowance, which is everything the bot layer does not claim. It is also
// group-token correct — 'tools' and 'planks' hold ONE allowance across their concrete members.
//
// A ROW IS NOT THE ONLY WAY TO CLAIM SOMETHING. The keep-math also takes the bot's HELD ORDER, so a
// material with no row at all is still claimed while an order in hand is waiting on it. This keeps the
// figure equal to the dumper's (`heldOrderDemand` is the one home for reading demand); blind to demand,
// this lens would report material as free that its holder will not release. No row AND no order still
// means fully excess: nothing claims it.
// Both are lazily required upward: inventory_swapper reaches for job_board's whitelist the same way, and
// a top-level require from here would close the cycle (job_board → assessors → this file).
// THE CLAIM IS MEASURED ON THE POCKET AND SUBTRACTED FROM THE TOTAL — never measured on the total.
// `dump_threshold` is an allowance against the BODY, so running the keep-math over a pool that includes
// chests would let the allowance swallow chest stock the bot never had. A reserve larger than a bot can
// carry is legal in the config and must stay harmless here.
// So the claim is what the bot ACTUALLY HOLDS, capped at its allowance — held capped at the dump
// threshold, expressed as held-minus-excess so the group-token distribution stays in the one math that
// owns it. Transit is unaffected: 30 cobblestone against a threshold of 20 still claims 20 and leaves 10
// to whichever layer withdrew them.
function reservedByBot(inventory = null) {
    const { INVENTORY_WHITELIST } = require('@thinking/job_board.js');
    const { computeExcess, heldOrderDemand } = require('@api/inventory_swapper');
    const pocket = inventory || getBotInventory();
    const excess = computeExcess(pocket, INVENTORY_WHITELIST, heldOrderDemand());
    const reserved = {};
    for (const [name, held] of Object.entries(pocket)) {
        const free = excess[name] || 0;
        if (held > free) reserved[name] = held - free;
    }
    return reserved;
}

// WHAT THE FLEET HOLDS THAT A BUILDING CAN BE HANDED — fleetHoldings less what every pocket keeps for its own
// body (each pocket row's allowance). A building's order is delivered to the chests, so material a body keeps
// in its pocket for itself is no part of what the order already has. Peers' pockets are read off their chairs.
function deliverableHoldings() {
    const { INVENTORY_WHITELIST } = require('@thinking/job_board.js');
    const { computeExcess } = require('@api/inventory_swapper');
    const hq = require('@kernel/corporate_headquarters');
    const me = process.env.BOT_ID || 'default';
    let pool = lessClaim(fleetHoldings(), reservedByBot());
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
        if (botId === me || !chair || !chair.inventory) continue;
        const excess = computeExcess(chair.inventory, INVENTORY_WHITELIST, {});
        const kept = {};
        for (const [name, held] of Object.entries(chair.inventory)) {
            const free = excess[name] || 0;
            if (held > free) kept[name] = held - free;
        }
        pool = lessClaim(pool, kept);
    }
    return pool;
}

// Subtract a claim map from a pool map, never below zero. Separate from the claim itself because the same
// subtraction serves both layers and each files a different claim against the same total.
function lessClaim(pool, claim) {
    if (!claim) return pool;
    const out = { ...pool };
    for (const [name, n] of Object.entries(claim)) {
        if (out[name]) out[name] = Math.max(0, out[name] - n);
    }
    return out;
}

// Pocket plus the chests this blueprint is credited (its own, plus the shared headframe chests),
// less the bot layer's claim. Gate, posted order and withdraw all credit the same set — fragment_utils
// owns that set; this is its one caller-facing question. The chest set is the credited one because it is
// also the set preconstruction withdraws from: widening the count without widening the reach would open
// a gate onto material no fulfiller can go and get.
function inBuildPool(item, blueprint, inventory = null) {
    return countInInventory(item, buildPool(blueprint, inventory));
}

// ── THE BUILD POOL AS A MAP ─────────────────────────────────────────────────────────────────────────
// Everything else here returns a figure, because a figure cannot be counted against the wrong set. This
// returns the set itself, for the callers that genuinely need it: a build's remaining-material walk
// consumes the whole map (it spends a shared budget across an ingredient tree), and a per-item lens call
// inside that loop would re-walk every station once per ingredient. Gate, dispatch gate and withdrawer
// must credit the same set (Law 16); this is the one definition.
// THE CHESTS ARE COUNTED LESS WHAT OTHER BODIES HAVE CLAIMED OUT OF THEM (chest_ledger): a cube trip claims its
// whole bill before it takes anything, so material a peer is about to withdraw is in nobody else's pool.
function buildPool(blueprint, inventory = null) {
    const pool = { ...(inventory || getBotInventory()) };
    const free = require('@perception/chest_ledger').lessClaims(buildPoolChestCounts(blueprint), process.env.BOT_ID || 'default');
    for (const [name, count] of Object.entries(free)) {
        pool[name] = (pool[name] || 0) + count;
    }
    return lessClaim(pool, reservedByBot(inventory));
}

// The STORAGE layer: everything, less the bot's claim, less the build's. `buildClaim` is the
// live outstanding build request — dynamic, recomputed every sweep by the building assessor, which runs
// ahead of supply in the evaluate order precisely so a claim can travel forward (Law 18: a planner that
// acts last announces first). Absent claim map = nothing is spoken for, which is the correct reading
// before any build is gated and not a defaulted field.
//
// A GROUP TOKEN SUMS ITS CLAIM ACROSS MEMBERS, for the same reason the allowance is shared: asking for
// 'logs' and subtracting only the claim filed against 'oak_log' would leave a build's birch order
// invisible to storage's level.
function forChestRequest(item, buildClaim = null) {
    // Two subtractions, two shapes, and the difference is not incidental. The bot's reserve is keyed by
    // the CONCRETE items the body holds, so it comes off the pool name by name. The build's claim is
    // filed in whatever the blueprint asked for — a group token like `logs` as readily as `oak_log` — so
    // it is subtracted through the group-aware counter instead; matching it by name would leave a claim
    // on `logs` invisible against a pool holding birch.
    const pool = lessClaim(accessibleMaterialPool(), reservedByBot());
    const items = Array.isArray(item) ? item : [item];
    let have = 0;
    let claimed = 0;
    for (const one of items) {
        have += countInInventory(one, pool);
        if (buildClaim) claimed += countInInventory(one, buildClaim);
    }
    return Math.max(0, have - claimed);
}

// ── THE POOL THE BOARD PRICES AN ORDER AGAINST IS THE FREE POOL, NEVER THE FULL ONE ───────────────
// `accessibleMaterialPool` is pocket plus every barrel's raw contents. Priced against that, the board
// would count material another body has already committed to and walked for, then post a second order
// against the same stack.
//
// `chest_ledger` answers exactly this: the claim is what makes it ONE number that both read — realized
// stock, less what is already spoken for. This is that subtraction, at the one question the board asks.
//
// CLAIMS ONLY, NOT PEERS' POCKETS. This does not narrow the pool to what one body can reach — a gather
// trip or a mining descent can reach a barrel, so banked material must still not be re-commissioned. It
// removes exactly what a peer has SPOKEN FOR, the one part of the barrel that is unavailable to the
// next job.
// ── AND THE BODY'S OWN KIT IS NOT FLEET MATERIAL EITHER ───────────────────────────────────────────
// `reservedByBot` is the fleet's one definition of what this body holds that it is not going to give
// up — the allowance the dump job leaves alone. `forChestRequest` one layer up already subtracts it;
// this walk must too, or the board can credit a body's own kit against an order to put a matching item
// on the shelf.
//
// The two subtractions are different facts and both are needed: a CLAIM is material a peer is walking
// for, a RESERVE is material this body is keeping. Either one left in makes the board offer work the
// fulfiller cannot do.
function rootsNeededFleetWide(item, quantity, alreadyAtDestination = 0) {
    const { craftShortfall } = require('@utils/calculators/build_material_calculator');
    const chestLedger = require('@perception/chest_ledger');
    const free = lessClaim(chestLedger.lessClaims(accessibleMaterialPool()), reservedByBot());
    return craftShortfall(item, quantity, free, alreadyAtDestination);
}

module.exports = {
    where,
    spendableForCraft,
    reachableByFleet,
    fleetHoldings,
    deliverableHoldings,
    inChests,
    inBuildPool,
    buildPool,
    reservedByBot,
    forChestRequest,
    rootsNeededFleetWide,
};
