// module: inventory_lens
// purpose: THE ONE PLACE ANYTHING ASKS WHERE A MATERIAL IS AND HOW MUCH OF IT EXISTS. One question,
//   one answer, one door — nothing assembles a material pool of its own and nothing counts a chest itself.
//
// ── WHY THIS EXISTS (Architect 2026-08-15) ────────────────────────────────────────────────────────
// The counting primitives were never wrong. What was wrong is that every caller had to CHOOSE which
// pool to count — pocket, chests, pocket+chests, or a build's credited subset — and choosing wrong is
// SILENT. Three separate multi-hour losses were one mistake wearing three costumes:
//     cobblestone 0/4   measured the POCKET            should have measured pocket + chests
//     one-plank craft   measured PRESENCE (`> 0`)      should have measured affordability
//     bone_meal kill    measured POCKET + CHESTS       should have measured the pocket
// The third correction is the OPPOSITE of the first, and that asymmetry is the whole argument for this
// module. "Make both sides agree" does not say WHICH side is right. The right pool is not a property of
// the caller, the item, or the situation — it is a property of THE VERB THE ANSWER WILL BE SPENT ON.
//
// ── THE RULE THAT MAKES THE BUG CLASS UNREACHABLE ─────────────────────────────────────────────────
// Nothing here is named for a place, and that is deliberate down to the field names of the answer.
// `where()` returns no `total`. There is no neutral number to reach for, because reaching for the
// neutral number IS the bug: a caller that wanted "how much is there" got a true count it could not
// spend. Every figure the answer carries is named for what it may be used FOR:
//     spendableForCraft   the POCKET — a craft consumes from the hand and cannot reach a chest
//     reachableByFleet    pocket + every registered chest — a bot can WALK to a chest
//     inBuildPool         the build layer — its credited chests and the pocket, less the bot's claim
//     forChestRequest     the storage layer — everything, less the bot's claim and the build's
// A function or field named for a place can be read from the wrong context and look correct. One named
// for a verb argues back: `spendableForCraft` refuses to count a chest, and that refusal IS the fix for
// the bone_meal kill rather than a comment asking a future reader to be careful.
//
// ── `locations` IS THE NEW CAPABILITY, NOT DECORATION ─────────────────────────────────────────────
// None of the call sites this replaces could answer "where is it". That is exactly the question whose
// absence cost a 73-minute run: supply_manager logged `bone=0` once a second for twenty minutes while
// six bones sat in the chest, and the number was TRUE — no amount of reading it could reveal the
// fault. An answer that carries its locations makes the same failure self-describing on its first line
// (Law 6, and Law 25: a true figure that misleads about the situation is still a failed report).
//
// ── THIS IS AN INTERFACE, NOT A SECOND IMPLEMENTATION (Law 16) ────────────────────────────────────
// Every figure delegates to the existing primitives (fragment_utils' pool builders, inventory_calculator's
// group-aware counter). Re-implementing the arithmetic here would create the second route this module
// exists to abolish. The mechanism stays where it lives; what is new is that there is one door to it and
// the door asks the question that determines the answer.
//
// ── LAW 26: THIS IS THE TRANSLATOR, HQ IS THE RECORD ──────────────────────────────────────────────
// The chest side comes from station_registry, which reads corporate_headquarters — so this module is to
// HQ what trace_monitor is to the watcher trace: the one reader standing between a record and everything
// that depends on it. A consumer wired straight to raw chest arrays is the illegal joint. The POCKET is
// deliberately NOT from HQ: it is read live from the body (Invariant B — it changes faster than any
// record can hold, and it is the one number a stale read gets fatally wrong).

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
// `inventory` is optional and it is not a convenience: most callers are mid-chain and already hold the
// snapshot their decision was made against. Re-reading the body here would answer a DIFFERENT instant
// than the rest of their reasoning — which is precisely the fault behind the one-plank craft, where two
// reads of the same pocket disagreed. Passing what you already hold is the correct call.
// ACCEPTS A LIST, AND THE LIST MEANS "ANY OF THESE WILL DO" — the fuel question, not a convenience.
// A torch burns coal OR charcoal; a wall takes any structural_fill member. Asked one item at a time, a
// caller has to sum the answers itself, and summing an any-of is where a per-member threshold gets
// applied to a shared allowance by accident (the group-token rule: one allowance ACROSS members, never
// one each). One call, one figure, one place that knows the semantics.
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
        if (!entry || entry.type !== 'chest') continue;
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

    // NO `total` FIELD, ON PURPOSE — see the header. A neutral number is the thing every one of these
    // bugs reached for.
    return { item: item_, pocket, chests, spendableForCraft: pocket, reachableByFleet: fleet, locations, readable };
}

// ── NAMED READERS ─────────────────────────────────────────────────────────────────────────────────
// CRAFTING CONSUMES FROM THE HAND. An ordinary ingredient sitting in a chest is not one a crafter can
// use — supply_manager crafts from its own inventory — so a gate counting it posts an order no fulfiller
// can fill, which the board re-posts unchanged until the sentry kills the signal.
//
// ONE CLASS IS EXEMPT AND IT IS NOT A LOOPHOLE: a CHAIN PRODUCT (charcoal, wheat) is a LEAF to
// supply_manager, obtained by withdrawing from the storage chest its chain stocks — it has no
// synchronous craft and no gather, so the withdrawal is the only way it is ever obtained. For that class
// the reachable pool is the correct question and `reachableByFleet` below is the reader; job_gates'
// chainGate is the one caller, and it passes that reader explicitly rather than widening this one.
// Do not fold the exemption in here: this function's narrowness is what a caller relies on when it wants
// the hand, and the two questions have different right answers for the same item.
// NOT delegated to where(): this reads the pocket alone, and where() walks every registered station to
// build its locations. This is the hottest path in the gates (once per candidate job per sweep), so the
// cheap question stays cheap. Same semantics, same any-of list handling — only the station walk is
// skipped, and a pocket answer never needed one.
function spendableForCraft(item, inventory = null) {
    const counts = inventory || getBotInventory();
    const items = Array.isArray(item) ? item : [item];
    let total = 0;
    for (const one of items) total += countInInventory(one, counts);
    return total;
}

// "Does this exist anywhere the fleet can get to it" — the right question for deciding whether to SEND
// SOMEONE (a gather trip, a mining descent). The wrong question for deciding whether a craft can start.
function reachableByFleet(item) {
    const pool = accessibleMaterialPool();
    const items = Array.isArray(item) ? item : [item];
    let total = 0;
    for (const one of items) total += countInInventory(one, pool);
    return total;
}

// Chests only — "is this already banked somewhere, so nobody needs to go and get more". A SOURCING
// question, and the pocket is excluded because the asker is standing in it: material in the assessing
// bot's own hands is not material sitting in a chest waiting to be fetched.
// NOT the storage layer's stock level, which was this function's other reader until the layers were
// separated — that question subtracts CLAIMS rather than a location and is `forChestRequest` below.
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
// COUNTING IS NOT SOURCING, AND CONFLATING THEM IS THE TRAP. These figures answer "what counts toward
// this layer's requirement". They do not say where a fulfiller reaches: the bot's own stock rows are
// still measured on the POCKET (a chest full of torches must not satisfy a bot that has none — it must
// make the bot go and fetch them), and a craft still consumes from the hand. The layers change what is
// counted as done, not what is reachable.
//
// WHY A CLAIM AND NOT A LOCATION — this is what makes the whole scheme survive TRANSIT. Material
// withdrawn for a build sits in the pocket at the instant the build spends it, so a rule phrased as
// "the build may not count the pocket" blinds every build to the material it just withdrew. `everything`
// does not change when a block moves, so subtracting a claim from it leaves every layer's figure
// unmoved by transit. The pocket's claim is its declared reserve; pocket stock above that reserve is
// in transit and belongs to whichever layer withdrew it.
//
// THE BOT'S CLAIM IS THE KEEP RESERVE, READ THROUGH THE ONE KEEP-MATH THAT ALREADY EXISTS.
// `computeExcess` is the single dump-threshold math (Law 16) and it already returns exactly the wanted figure:
// everything ABOVE the bot's allowance, which is everything the bot layer does not claim. It is also
// group-token correct — 'tools' and 'planks' hold ONE allowance across their concrete members, and a
// per-member subtraction here would reserve that allowance several times over.
//
// A ROW IS NOT THE ONLY WAY TO CLAIM SOMETHING. The keep-math also takes the bot's HELD ORDER, so a
// material with no row at all is still claimed while an order in hand is waiting on it. Passing the
// demand here is not an extra refinement — it is what keeps this figure equal to the dumper's, and the
// two answer one fact from opposite sides ("does the bot claim this?" / "may I bank this?"). Blind to
// demand, this lens would report material as free that its holder will not release, and a second bot's
// order would clear its gate against stock its fulfiller can never spend — a claim/release loop, which
// is why the demand read has exactly one home (`heldOrderDemand`). No row AND no order still means fully
// excess, which remains the right answer: nothing claims it.
// Both are lazily required and required upward on purpose — inventory_swapper already reaches for
// job_board's whitelist the same way, and a top-level require from here would close the cycle
// (job_board → assessors → this file).
// THE CLAIM IS MEASURED ON THE POCKET AND SUBTRACTED FROM THE TOTAL — never measured on the total.
// `dump_threshold` is an allowance against the BODY ("do not dump this"), so running the keep-math over a pool that
// includes chests lets the allowance swallow chest stock the bot never had: `tools: dump_threshold 99` reserved
// fourteen swords sitting in a storage chest, storage's level read 0 with the chest visibly full,
// and the fleet crafted a fifteenth every sweep. A reserve larger than a bot can carry is legal in the
// config and must stay harmless here.
// So the claim is what the bot ACTUALLY HOLDS, capped at its allowance — held capped at the dump
// threshold, expressed as held-minus-excess so the group-token distribution stays in the one math that
// owns it. Transit is unaffected, which the whole scheme rests on: 30 cobblestone against a threshold of 20 still
// claims 20 and leaves 10 to whichever layer withdrew them.
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
// less the bot layer's claim. Gate, posted order and withdraw all credit the same set, so a
// build's shortfall cannot be computed three ways — fragment_utils owns that set; this is its one
// caller-facing question. The chest set stays the credited one rather than every chest in the world
// because it is also the set preconstruction actually withdraws from: widening the count without
// widening the reach would open a gate onto material no fulfiller can go and get.
function inBuildPool(item, blueprint, inventory = null) {
    return countInInventory(item, buildPool(blueprint, inventory));
}

// ── THE WALK-BACK, ASKED AS A QUESTION RATHER THAN HANDED A POOL ──────────────────────────────────
// craftShortfall needs the whole pool map, not a count, so its callers used to build one themselves —
// `rootsStillNeeded(job, accessibleMaterialPool())`. That is the choice this module exists to remove,
// just spelled with a bigger argument: the pool travels in, and nothing at the call site says why THAT
// pool. Asked here it is settled once. FLEET-WIDE is correct for both root gates because both are
// deciding whether to SEND SOMEONE — a mining descent or a gather trip can reach a chest, so material
// already banked must not be re-commissioned (that exact mistake is the cobblestone 0/4 loop).
// Deliberately NOT offered against the craft pool: a root walk answers "what must the world still give
// us", which is never a question about one body's hands.
// ── THE BUILD POOL AS A MAP, AND WHY THIS ONE IS ALLOWED TO HAND OUT A POOL ───────────────────────
// Everything else here returns a figure, because a figure cannot be counted against the wrong set. This
// returns the set itself, for the callers that genuinely need it: a build's remaining-material walk
// consumes the whole map (it spends a shared budget across an ingredient tree), and a per-item lens call
// inside that loop would re-walk every station once per ingredient.
//
// It is still the fix rather than a hole in it. The three sites that needed this each wrote the identical
// four lines — pocket, spread the build-pool chest counts over it, close over it as `isAvailable` — and
// the comments above all three already say they MUST agree (gate, dispatch gate, and withdrawer credit
// the same set or the build orders material it is standing on). Three hand-written copies of a rule that
// says "these must never disagree" is the Law 16 shape exactly. One definition, three readers.
function buildPool(blueprint, inventory = null) {
    const pool = { ...(inventory || getBotInventory()) };
    for (const [name, count] of Object.entries(buildPoolChestCounts(blueprint))) {
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

function rootsNeededFleetWide(item, quantity, alreadyAtDestination = 0) {
    const { craftShortfall } = require('@utils/calculators/build_material_calculator');
    return craftShortfall(item, quantity, accessibleMaterialPool(), alreadyAtDestination);
}

module.exports = {
    where,
    spendableForCraft,
    reachableByFleet,
    inChests,
    inBuildPool,
    buildPool,
    forChestRequest,
    rootsNeededFleetWide,
};
