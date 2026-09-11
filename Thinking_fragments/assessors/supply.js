// assessors/supply — lifted verbatim out of job_board 2026-08-26. See assessor_registry.

'use strict';

const inventoryLens = require('@kernel/inventory_lens');
const stationRegistry = require('@perception/station_registry');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { isRawMaterial } = require('@utils/calculators/build_material_calculator');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    JOB_TYPE,
    STOCK_THRESHOLDS,
} = require('@thinking/architect_config');

const { deliverScope, supplyJob, furnaceInput, resolveCraftTier, bestOwnedTierRank, tierRank } = require('@thinking/assessors/shared');
// ── SECTION 3 — Supply (evaluates THIRD, Law 18) ──
// One loop over STOCK_THRESHOLDS (Law 16): stock below `deficit_below` posts one refill-to-`dump_threshold`. Holder decides
// destination; item nature decides source; supply_manager runs the chest→craft→harvest cascade.
// No `deficit_below` = passive keep.
// THE CRAFTING TABLE IS THE ONLY POCKET STATION LEFT. The furnace left this set with its stock row: a
// cook is sized for the whole fleet and its output must be bankable in a chest, so a furnace only ever
// stands in a placed blueprint that also carries one (station_registry's POCKET_PLACEABLE_STATIONS is
// the same split, asked from the craft side). A furnace in a pocket now is build material in transit.
const STATION_ITEMS = new Set(['crafting_table']);

// ── THE FIELD-STATION CREDIT IS DELETED, AND ITS PREMISE IS WHAT EXPIRED ────────────────────────────
// `_deployedFieldStations(type)` counted registered blueprint-less stations toward the pocket row, so a
// station a bot had set down read as stock the fleet still held rather than as stock it was missing. That
// was true while a field station was a LOAN — placed for one craft book and dug back up at the end of it.
//
// It stopped being true on 2026-09-07: *"placing a crafting table is a permanent thing… i want to remove
// drop and dig logic."* Committed stock that cannot come back is SPENT, not held, so the credit became a
// permanent overstatement — one table set down anywhere in the world and the row reads satisfied forever.
//
// WHAT THAT WOULD HAVE COST, precisely: the bot never crafts a second table, walks somewhere the first one
// is out of reach (a field table has no anchor, so nothing can path to it), finds no table and no table in
// its pocket, and `placeStation` soft-fails to replan on a shortage the board says does not exist.
//
// AND THE ARGUMENT THAT BUILT IT LEFT BEFORE THE CREDIT DID. It was written for the FURNACE — *"a furnace
// costs eight cobblestone, which is a whole prospect shaft"* — and the furnace has since moved out of this
// set entirely (see STATION_ITEMS above). What remained was a saving of four planks, bought at the price
// of a stall. A bot now simply keeps a table in its pocket, which is the cheapest craft it makes.
//
// STATION_ITEMS ITSELF STAYS: it still decides the job TYPE for a station row (crafting_station rank), and
// that reading was never the credit.

// DELETED 2026-08-15: `_anyChestHas(item, allStations)` — "does ANY registered chest hold ≥1 of this?".
// No caller, and superseded in kind by the standing-threshold rule directly below, which counts material
// across the whole chest system rather than asking a presence question per chest. A presence-any test
// kept beside a count-across test is two answers to one question (Law 16).

// ── A STANDING THRESHOLD MEASURES THE STORAGE SYSTEM, NOT A PLACE ──────────
// A `storage` row asking for a stock level counts material reachable anywhere in the chest system. This
// measurement is what the `holder: 'storage'` name now states outright, and it is why the chest ROLES
// could be deleted rather than merely renamed: the address on a row never decided whether the fleet was
// short, only where a delivery walked.
//
// Units of `good` in EVERY chest, pocket excluded. Group-aware. The pocket is excluded because a pocket is
// not fulfillment for a chest order — two ledgers spending one pile is a livelock; `_totalAvailable` adds
// it back for the gates that legitimately want both.
//
// WHY THIS IS A LAW 16 REPAIR AND NOT A NEW POLICY: the build path ALREADY counts every chest —
// `accessibleMaterialPool` and `buildPoolChests` were widened for this exact reason (the chest system is
// wherever the material actually is). The standing-stock path kept
// counting ONE named chest, so the codebase held two different answers to "how much do we have", and the
// stock path's answer was the one that posted gather orders for material the fleet was already holding
// nearby.

// Does a holder:'bot' row already own this item? Backs the pocket-stand-in's stand-down. Group-aware NOT
// wanted: exact token match — looser would let 'logs' stand down behind an unrelated plank row.
function _hasBotRowFor(item) {
    return STOCK_THRESHOLDS.some(s => s.holder === 'bot' && s.item === item);
}

function assess({ inventory, buildClaim }) {
    const jobs       = [];
    const pullNeeded = {};
    const allStations = stationRegistry.getStations();

    // A contractor's rows are generated from what a person asked for; a homesteader's are the config
    // table whole. Same loop, same row shape, same jobs (requested_work).
    for (const stock of require('@thinking/requested_work').activeStockRows()) {
        if (stock.deficit_below == null) continue;   // passive keep — no refill job

        // ── Storage holder (shared-pool restock) ─────────────────────────
        if (stock.holder === 'storage') {
            // Furnace-produced (iron_ingot, charcoal): no synchronous route (craft_handler can't smelt) —
            // belongs to assessors/furnace, like the bot-holder branch. Without this skip an understocked
            // smelt output soft-fails every pass → judge kill even with no furnace in the world. Law 16.
            if (furnaceInput(stock.item)) continue;

            // ANY CHEST IS THE DESTINATION, because the request is a fleet-wide figure and material
            // answering it counts wherever it lands (inventory_lens.forChestRequest sums every chest).
            // This used to resolve the row's named chest by blueprint-and-number with a role match as
            // fallback. Both are deleted: a chest is a chest. What is left is the only question the
            // resolution ever really answered — is there anywhere to put this yet? — and the first
            // registered chest answers it, so a delivery that walks to the nearest one is not walking
            // past a "wrong" chest.
            // `entries`, NOT `values` — THE KEY IS THE DELIVERABLE HALF (fixed 2026-09-10). This read
            // dropped the registry key on the floor and passed only `.pos` downstream, so the one thing
            // that could open the chest had to be REBUILT from coordinates further down the chain. It was
            // rebuilt wrong for eleven days: `station_registry.stationKey` appends the owner
            // (`25|65|-1|homesteader`) and the rebuild produced `25|65|-1`, which matches no row. Every
            // storage delivery abandoned. A key is minted in exactly one place (Law 16); anything that
            // needs it carries it.
            const chestRow = Object.entries(allStations).find(([, e]) => e && e.type === 'chest') || null;
            const chestId = chestRow ? chestRow[0] : null;
            const chestEntry = chestRow ? chestRow[1] : null;

            // ── NO CHEST YET → THE POCKET STANDS IN — the bot's own inventory stands in for shared
            // storage until a chest exists, then transfers there like normal, reusing the same order logic
            // instead of building a separate one. ──
            // THE HOLE THIS CLOSES: with no bot-held row for a chest-destined good, the only standing order
            // for that good lives on a chest that itself needs the good to exist. A plain `continue` on a
            // missing chest silently un-orders it — nothing gathers the material needed to build the thing
            // that asks for it.
            // NOT A SECOND SYSTEM: order/thresholds/resolver unchanged; only DESTINATION moves pocket→chest
            // when the chest appears (same shape as §2's build_supply bootstrap; Law 16 — one pathway, two
            // destinations). A BOT ROW WINS THE ITEM: with a holder:'bot' row for the same good this stands
            // down, else the orders stack (storage wants 2 + bot row wants 2 → bot hunts 4 swords).
            if (!chestEntry) {
                if (_hasBotRowFor(stock.item)) continue;
                const pocketHave = countInInventory(stock.item, inventory);
                if (pocketHave >= stock.deficit_below) continue;
                const pocketWant = stock.kind === 'tool'
                    ? resolveCraftTier(stock.item, inventory, stock.min_tier) : stock.item;
                const pocketJobType = JOB_TYPE[stock.job_type]
                    ?? (isRawMaterial(stock.item) ? JOB_TYPE.resource_standing_stock : JOB_TYPE.resource_baseline);
                // Both fallback defaults are already night-gated types; check is live only for a row that
                // opted out via `job_type:` — the case a type-blacklist can't see, hence asked per-job.
                jobs.push(supplyJob({
                    id: `resource_pocket_${stock.item}`,
                    stock,
                    what: pocketWant, need: stock.deficit_below - pocketHave,
                    where: null,
                    // Gathers to `deficit_below`, which is now the only target any row has. A pocket on
                    // hard difficulty loses surplus to the next death ("prevent the bot from carrying
                    // anything really"), and a chest is where surplus SHOULD sit.
                    // STANDING rank: this pocket-stand-in row must share the standing-stock rank with its
                    // chest-holder twin, not resource_baseline — otherwise a large standing shelf-level
                    // target here competes evenly with (and can starve) a small, more urgent build order at
                    // the same nominal priority. Moving only the chest-holder twin to resource_standing_stock
                    // changes nothing, because this branch is exactly the one that runs before any chest
                    // registers — precisely when the shell is being built. A rank split applied to one of two
                    // twins is not a split.
                    // Raw only: tools/crafts here keep resource_baseline — the standing tier would put a
                    // bot's own axe below the mineshaft.
                    job_type: pocketJobType,
                    claimed_by: null,
                    hold_goal: stock.deficit_below, at_destination: pocketHave,
                    category: 'resource', scope: 'local',
                }));
                continue;
            }

            // SYSTEM-WIDE, not `chestEntry`-only (see _chestsTotal). `chestEntry` only says a chest EXISTS
            // to walk to; it does not decide whether the fleet is short and does not own the delivery.
            //
            // THE STORAGE LAYER SITS ON TOP, SO IT SUBTRACTS BOTH LAYERS BENEATH IT. Its stock
            // level is not vouched for by the bot's own reserve, nor by material a build has already
            // spoken for: filling a chest with stone the shell is about to consume reports a request met
            // that will be empty again before anyone withdraws from it. The bot's claim is its declared
            // reserve rather than its whole pocket, so stock in transit above that reserve still counts —
            // that is what stops a bot mid-delivery from posting a duplicate order for what it is already
            // carrying, without letting its own kit vouch for the fleet.
            const chestCount = inventoryLens.forChestRequest(stock.item, buildClaim);
            if (chestCount < stock.deficit_below) {
                // ── `gate` GUARD, NOW READ ON THIS BRANCH TOO — a gated good (bone_meal without bone)
                // posting here with no bone on hand produces a stuck craft with no root material, re-posts
                // unchanged, and five identical outcomes kill the signal. The pocket branch ran this same
                // check the whole time; this branch had not. Before a gated good was recognized as needing
                // a mob-drop root, the posting fell through to a SURFACE GATHER for that drop — wrong,
                // wandering, slow enough to look like work, which is what hid the missing guard.
                // ── A TOOL-FAMILY STORAGE POSTS A CONCRETE TIER, NEVER THE FAMILY — 'sword' is a family
                // — the group-aware chest count reads it, but nothing downstream crafts/delivers a "sword";
                // an item-less `what` soft-fails every dispatch and loops (the charcoal lesson). Same
                // resolver as bot-held tools (Law 16 — highest makeable tier, the same rule the bots use for
                // their own tools). Resolved against the ASSESSING bot's pocket — whoever posts crafts it;
                // a better-stocked peer posts a better tier next sweep.
                const want = stock.kind === 'tool' ? resolveCraftTier(stock.item, inventory, stock.min_tier) : stock.item;

                // UNDERGROUND GUARD here fixes a live crash: a min_tier of 'stone' can resolve to
                // stone_sword with no cobblestone on hand → supply_manager dispatched to GATHER cobblestone
                // underground → a Law 13 throw, because a surface supply job may not depend on an
                // underground material. Before a tier floor existed this was accidentally safe (wooden_sword
                // roots in surface logs) — the floor made the asymmetry reachable. Treat any bot-branch
                // guard absent from this branch (the `gate` guard above was the other one found this way) as
                // a live defect, not a design choice.
                // default resource_chest_restock is rightly NOT night-blacklisted (a walk to a chest is a
                // legal night verb), but with storage dry the job falls through to a surface gather at
                // night — the hazard _confirmedObtainable exists to prevent. chestCount excluded so
                // storage's own stock can't vouch for the order.
                const restockJobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.resource_chest_restock;
                jobs.push(supplyJob({
                    id: `resource_storage_${stock.item}`,
                    stock,
                    what: want, need: stock.deficit_below - chestCount,
                    where: chestEntry.pos,
                    // THE CHEST'S OWN REGISTRY KEY, carried rather than rebuilt from `where` (see the
                    // `Object.entries` note above). `where` answers "walk to roughly here"; this answers
                    // "open exactly this row", and the two are not interchangeable because the row key
                    // carries the owner and a coordinate cannot. Same shape the furnace assessor already
                    // posts (`station_id: id`).
                    station_id: chestId,
                    // The LAYER, not a place. `destination` is read downstream only as "this order ends in
                    // a chest rather than a pocket" (supply_manager's pocket-is-not-fulfilment rule, and
                    // job_gates' held-stock check); naming a blueprint here implied a routing decision no
                    // part of the system makes any more.
                    destination: 'storage',
                    // Per-row override, default shared restock tier. GUARDRAIL: only a good NO build
                    // consumes may be lifted above building_structure — lifting a build input (logs/
                    // iron_ingot) would make the bot fill the chest before building the thing that
                    // input feeds. wheat_seeds opts in via job_type:'supply_seeds' (feeds farm PLANT,
                    // starves no build).
                    job_type: restockJobType,
                    claimed_by: null,
                    // SEEK TO `deficit_below`. It is the level that must be sought and the only target in
                    // the table; `dump_threshold` states when surplus must LEAVE and is never a goal.
                    // Targeting the dump line instead overshoots the ask every cycle, hauling far more
                    // than necessary and churning material through storage for nothing. Crafted rows
                    // are NOT exempt: an exemption here sizes a batch off the dump line, so an order for
                    // a few items opens a production run of many.
                    hold_goal: stock.deficit_below - chestCount,
                    at_destination: chestCount,
                    // Standing restock rows are MIXED (logs/wheat_seeds gathered, planks/torch made) — the
                    // one place a blanket 'local' would let two bots duplicate a craft.
                    category: 'resource', action: 'deliver', scope: deliverScope(want),
                }));
            }
            continue;
        }

        // ── Bot holder ────────────────────────────────────────────────────

        // Tool family: refill the deficit at the highest tier the bot can make.
        if (stock.kind === 'tool') {
            const familyHave = countInInventory(stock.item, inventory);
            const tierItem = resolveCraftTier(stock.item, inventory, stock.min_tier);
            // COUNT vs TIER: two separate shortfalls; count alone can't answer both. familyHave is
            // group-aware, so ONE wooden sword satisfies the deficit forever, and a resolver that only runs on
            // an EMPTY pocket gives a replacement path with no upgrade path — a bot can sit on ample
            // tier-up material and a low-tier tool forever, because the count never returns to zero. Tier
            // test asks "is what I could MAKE better than what I HOLD"; either shortfall posts. deficit
            // stays count-based (an upgrade needs one item). Reuses resolveCraftTier + TIER_ORDER — no
            // second "better" (Law 16).
            const upgrade = bestOwnedTierRank(stock.item, inventory) < tierRank(tierItem);
            if (familyHave >= stock.deficit_below && !upgrade) continue;

            // ── BOOTSTRAP vs MAINTENANCE — same shortfall, two urgencies. ZERO of a family is a MULTIPLIER
            // on everything after (an axe roughly halves felling time, a large share of early work) at a
            // small material cost. A spare/upgrade is insurance and can wait. THE TWO TYPES NO LONGER
            // DIFFER IN ORDER — they share a category and measure at the same stage — they differ in REACH,
            // through the mode_override below, which is the distinction that was always doing the work.
            // Test is `familyHave === 0`, NOT `< deficit_below` — not a rounding: the pickaxe deficit is 2, so `<` would put the
            // SPARE in the bootstrap band too and double front-of-run wood on a tool nothing uses yet.
            // Explicit `job_type:` still wins both.
            const bootstrap = familyHave === 0;
            const toolJobType = JOB_TYPE[stock.job_type]
                ?? (bootstrap ? JOB_TYPE.crafting_tool_bootstrap : JOB_TYPE.crafting_tool);

            // ONE tool at bootstrap rank, never the pair: the pickaxe deficit is 2, so a plain `deficit_below - familyHave` put
            // BOTH axes in the top band — the exact double-spend the split avoids. At one axe the row
            // re-posts non-bootstrap; the spare waits at crafting_tool, under the headframe.
            const deficit = (familyHave >= stock.deficit_below || bootstrap) ? 1 : stock.deficit_below - familyHave;
            const tierHave = countInInventory(tierItem, inventory);
            jobs.push(supplyJob({
                id: `supply_tool_${stock.item}`, stock, what: tierItem, need: deficit,
                // THE SPARE RUNG IS PASSIVE WHATEVER THE ROW SAYS (job_gates.declarationFor). The row's
                // own mode governs the BOOTSTRAP — the first axe must reach out and fell a tree, because
                // nothing else in the run is worth more per log. A spare is insurance against a future
                // break, and NO POSITION can express "want this promptly, but never at the cost of opening
                // a gather chain": the bot category sits above the build at every stage, so an active spare
                // would send a bot for wood in front of a shell that has to stand before nightfall. Mode is
                // the only axis that says it, which is why these rungs stopped being two ranks and stayed
                // two modes.
                mode_override: bootstrap ? null : 'passive',
                where: null,
                // `job_type:` override honored HERE too — without it, tool rows share one rank in table
                // order (pickaxe, axe, sword), so the primary weapon is made last and a bot can meet the
                // first hostile still holding only an axe. One override mechanism on every branch (Law 16).
                job_type: toolJobType,
                claimed_by: null,
                hold_goal: tierHave + deficit, at_destination: tierHave,
                category: 'crafting', scope: 'local',
            }));
            continue;
        }

        const have = countInInventory(stock.item, inventory);
        if (have >= stock.deficit_below) continue;

        // Furnace-produced → owned by assessors/furnace; a sync craft job would soft-fail and loop (Law 16).
        if (furnaceInput(stock.item)) continue;

        const craftable = !isRawMaterial(stock.item);

        let jobType, category;
        // Override honored on raw gathers AND crafts (shield → crafting_defense). STANDING, NOT DYNAMIC:
        // every row here is a shelf-level that never finishes. Giving a standing shelf-level order the same
        // job type as a small, finite build shortfall lets the shelf win the tie and starve the build,
        // because the shelf's appetite never runs out while the build's does. resource_standing_stock is a
        // CHEST-category type, so a build's need outranks a shelf's at every stage rather than at one
        // authored adjacency. DYNAMIC side untouched and must stay: build_chest_<raw> takes
        // supply_job_type, bootstrap build_supply_<raw> keeps resource_baseline — computed fresh, stopping
        // when the gap closes, so they may outrank the build they feed without starving it.
        if (!craftable)                        { jobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.resource_standing_stock; category = 'resource'; }
        // The station branch reads the override like both of its siblings. It used to DISCARD it — the one
        // branch of three that did — which made the furnace unsortable: every STATION_ITEMS row got
        // `crafting_station` whatever it declared, so a smelter was categorised as the body's own kit. A
        // row's declared job type is the only place that can be expressed, so a branch that drops it
        // silently overrules the config it reads (Law 16 — one override mechanism, honored everywhere).
        else if (STATION_ITEMS.has(stock.item)){ jobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.crafting_station;  category = 'crafting'; }
        else                                   { jobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.crafting_flat; category = 'crafting'; }

        // EVERY row restocks to `deficit_below` — raw and crafted alike. `dump_threshold` is only the
        // surplus-tolerance line, so targeting it overshoots the actual ask; a bigger need posts its own
        // job. Craft granularity may land above the target (one torch craft yields four) and that is not
        // overshoot — nothing is dumped until the dump line, which is the whole reason the two numbers
        // are separate.
        const gatherGoal = stock.deficit_below;
        jobs.push(supplyJob({
            id: `supply_${stock.item}`, stock, what: stock.item, need: gatherGoal - have,
            where: null,
            job_type: jobType,
            claimed_by: null,
            hold_goal: gatherGoal, at_destination: have, category, scope: 'local',
        }));
    }

    return { jobs, pullNeeded };
}

module.exports = { name: 'supply', assess };
