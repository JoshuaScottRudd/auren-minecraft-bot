// assessors/supply — builds refill jobs for stock rows under their deficit threshold (Law 18, evaluated third).

'use strict';

const inventoryLens = require('@kernel/inventory_lens');
const stationRegistry = require('@perception/station_registry');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { isRawMaterial } = require('@utils/calculators/build_material_calculator');

const {
    JOB_TYPE,
    JOB_CATEGORY_OF,   // names the asker band in a supply job's `parts` breakdown (Law 16)
} = require('@thinking/architect_config');

const { deliverScope, supplyJob, furnaceInput, resolveCraftTier, kitTier, noteShelfShort, bestOwnedTierRank, tierRank, stoneOrBetter } = require('@thinking/assessors/shared');
// ── SECTION 3 — Supply (evaluates THIRD, Law 18) ── one loop over STOCK_THRESHOLDS (Law 16): stock below
// `deficit_below` posts one refill job; holder decides destination, item nature decides source.

// A `storage` row counts material anywhere in the chest system: units of `good` in every chest, pocket
// excluded, group-aware; `_totalAvailable` adds the pocket back for gates that want both.

// True when a holder:'bot' row already owns this item (exact match, backs the pocket-stand-in's stand-
// down below); a concrete tool tier also matches its family's bot row, via TIER_ORDER.
function _hasBotRowFor(item) {
    const rows = require('@thinking/requested_work').activeStockRows();
    if (rows.some(s => s.holder === 'bot' && s.item === item)) return true;
    const { TIER_ORDER } = require('@thinking/assessors/shared');
    const cut = String(item).indexOf('_');
    if (cut < 0) return false;
    const tier = String(item).slice(0, cut);
    const family = String(item).slice(cut + 1);
    if (!TIER_ORDER.includes(tier)) return false;
    return rows.some(s => s.holder === 'bot' && s.kind === 'tool' && s.item === family);
}

function assess({ inventory, buildClaim }) {
    const jobs       = [];
    const pullNeeded = {};
    const allStations = stationRegistry.getStations();

    // Contractor and homesteader rows share this one loop, row shape and job set (requested_work).
    for (const stock of require('@thinking/requested_work').activeStockRows()) {
        if (stock.deficit_below == null) continue;   // passive keep — no refill job

        // ── Storage holder (shared-pool restock) ─────────────────────────
        if (stock.holder === 'storage') {
            // Furnace-produced goods belong to assessors/furnace — craft_handler can't smelt (Law 16).
            if (furnaceInput(stock.item)) continue;

            // Any registered chest is the destination (inventory_lens.forChestRequest sums every chest);
            // the row's own registry key is carried forward here, not rebuilt from `.pos` later, since
            // `station_registry.stationKey` appends the owner and a coordinate alone can't rebuild it.
            const chestRow = Object.entries(allStations).find(([, e]) => stationRegistry.isStorage(e)) || null;
            const chestId = chestRow ? chestRow[0] : null;
            const chestEntry = chestRow ? chestRow[1] : null;

            // ── No chest yet → the pocket stands in, reusing the same order logic (Law 16); a holder:'bot'
            // row for the same good wins the item so orders don't stack. ──
            if (!chestEntry) {
                if (_hasBotRowFor(stock.item)) continue;
                const pocketHave = countInInventory(stock.item, inventory);
                if (pocketHave >= stock.deficit_below) continue;
                const pocketWant = stock.kind === 'tool'
                    ? resolveCraftTier(stock.item, inventory, stock.min_tier, stock.max_tier) : stock.item;
                // Default resource_standing_stock — every row here is holder:'storage', so the asker is
                // always the shelf (`parts` below names it `chest:shelf_*`); job_type: opts out per-row.
                const pocketJobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.resource_standing_stock;
                jobs.push(supplyJob({
                    id: `resource_pocket_${stock.item}`,
                    stock,
                    what: pocketWant, need: stock.deficit_below - pocketHave,
                    where: null,
                    // Gathers to `deficit_below` only (surplus belongs in a chest, not a pocket); shares
                    // standing-stock rank with its chest-holder twin so it can't outrank a build order.
                    job_type: pocketJobType,
                    claimed_by: null,
                    hold_goal: stock.deficit_below, at_destination: pocketHave,
                    // Asker is still the shelf this row belongs to, not the body carrying it (Law 29).
                    parts: [{ who: `chest:shelf_${stock.item}`, amount: stock.deficit_below }],
                    category: 'resource', scope: 'local',
                }));
                continue;
            }

            // System-wide, not `chestEntry`-only: `forChestRequest` nets out the bot's declared reserve
            // and material a build has already claimed, so a mid-delivery bot can't duplicate its order.
            const chestCount = inventoryLens.forChestRequest(stock.item, buildClaim);
            if (chestCount < stock.deficit_below) {
                // A gated good is held back downstream by job_gates, not here. A tool family row posts a
                // concrete tier via the same resolver bots use for their own kit (Law 16).
                const want = stock.kind === 'tool' ? resolveCraftTier(stock.item, inventory, stock.min_tier, stock.max_tier) : stock.item;

                // The min_tier floor above keeps this off underground material (Law 13); chestCount is
                // excluded from the floor so a dry chest can't vouch for a night surface gather.
                const restockJobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.resource_chest_restock;
                jobs.push(supplyJob({
                    id: `resource_storage_${stock.item}`,
                    stock,
                    what: want, need: (stock.fill_to ?? stock.deficit_below) - chestCount,
                    where: chestEntry.pos,
                    station_id: chestId,   // the chest's registry key, carried, not rebuilt from `where`
                    destination: 'storage',   // the layer, not a place — pocket vs. chest, read downstream
                    // Only a good no build consumes may be lifted above building_structure.
                    job_type: restockJobType,
                    claimed_by: null,
                    hold_goal: (stock.fill_to ?? stock.deficit_below) - chestCount,   // refills to fill_to (else deficit_below); dump_threshold is never a goal
                    at_destination: chestCount,
                    parts: [{ who: `chest:shelf_${stock.item}`, amount: (stock.fill_to ?? stock.deficit_below) - chestCount }],
                    // Standing restock rows are mixed (gathered and crafted) — a blanket 'local' would let
                    // two bots duplicate a craft.
                    category: 'resource', action: 'deliver', scope: deliverScope(want),
                }));
            }
            continue;
        }

        // ── Bot holder ────────────────────────────────────────────────────

        // Tool family: refill the deficit at the highest tier the bot can make.
        if (stock.kind === 'tool') {
            const familyHave = countInInventory(stock.item, inventory);
            const tierItem = kitTier(stock, inventory);
            // Two shortfalls: familyHave (group-aware count) and tier (can the bot MAKE better than it holds,
            // judged by the row's own craft tier); either posts a job. The tool it gets is kitTier's: a shelf
            // stone tool first, a crafted stone one second, the row's own tier third.
            const upgrade = bestOwnedTierRank(stock.item, inventory)
                < tierRank(resolveCraftTier(stock.item, inventory, stock.min_tier, stock.max_tier));
            if (familyHave >= stock.deficit_below && !upgrade) continue;
            if (stock.stone_level && stoneOrBetter(stock.item, inventory) >= stock.stone_level) continue;
            const shelfRow = require('@thinking/requested_work').activeStockRows().find(r => r.holder === 'storage' && r.item === `stone_${stock.item}`);
            if (shelfRow) noteShelfShort(shelfRow.item, inventoryLens.inChests(shelfRow.item), 1, tierItem || 'nothing');
            // None of the row's tiers can be had now: the body works with what it holds.
            if (!tierItem) continue;

            // Bootstrap (familyHave===0) multiplies everything after; a spare/upgrade is insurance and can
            // wait — both share a category, differing only in reach via mode_override below.
            const bootstrap = familyHave === 0;
            const toolJobType = JOB_TYPE[stock.job_type]
                ?? (bootstrap ? JOB_TYPE.crafting_tool_bootstrap : JOB_TYPE.crafting_tool);

            // One tool at bootstrap rank, never the whole deficit; the spare waits at crafting_tool.
            const deficit = (familyHave >= stock.deficit_below || bootstrap) ? 1 : stock.deficit_below - familyHave;
            const tierHave = countInInventory(tierItem, inventory);
            jobs.push(supplyJob({
                id: `supply_tool_${stock.item}`, stock, what: tierItem, need: deficit,
                // Spare rung is passive unless the row names its spare_mode, so a spare can't gather ahead of
                // a build; bootstrap uses the row's own mode.
                mode_override: bootstrap ? null : (stock.spare_mode || 'passive'),
                where: null,
                job_type: toolJobType,   // job_type: override honored here too (Law 16 — one mechanism, everywhere)
                claimed_by: null,
                hold_goal: tierHave + deficit, at_destination: tierHave,
                parts: [
                    { who: `bot:kit_${stock.item}_held`, amount: tierHave },
                    { who: `bot:kit_${stock.item}_short`, amount: deficit },
                ],
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
        // Standing, not dynamic: every row here is a shelf level that never finishes, so it ranks as a
        // chest-category type and never starves a small, finite build shortfall at the same rank.
        if (!craftable) { jobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.resource_standing_stock; category = 'resource'; }
        else            { jobType = JOB_TYPE[stock.job_type] ?? JOB_TYPE.crafting_flat; category = 'crafting'; }

        // Every row restocks to `deficit_below`; `dump_threshold` is only the surplus line, never a target.
        const gatherGoal = stock.deficit_below;
        jobs.push(supplyJob({
            id: `supply_${stock.item}`, stock, what: stock.item, need: gatherGoal - have,
            where: null,
            job_type: jobType,
            claimed_by: null,
            hold_goal: gatherGoal, at_destination: have, category, scope: 'local',
            parts: [{ who: `${JOB_CATEGORY_OF[jobType] || 'bot'}:row_${stock.item}`, amount: gatherGoal }],
        }));
    }

    return { jobs, pullNeeded };
}

module.exports = { name: 'supply', assess };
