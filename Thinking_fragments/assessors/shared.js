// assessors/shared.js — what more than one assessor asks, and the one constructor every supply job
// is built through.
//
// THE ADMISSION RULE, because a shared module with no rule becomes the drawer everything is put in:
// a thing belongs here only if TWO OR MORE assessors read it, or if it is a guarantee that must not be
// re-implemented per assessor. Everything used by exactly one assessor lives in that assessor's own
// file, beside the only code that asks it. `_hasBotRowFor` (supply), `_heldFuel` and `_inFlightSmelt`
// (furnace), `_treeInClearRadius` (canopy) all stayed put for that reason — moving them here would put
// distance between a helper and its one caller and would invite a second caller that should not exist.
//
// THE UNDERSCORES ARE GONE FROM THE NAMES THAT CROSSED THE FILE BOUNDARY. In job_board a leading `_`
// meant "private to this file", and these were. They are a module's exported surface now, so the mark
// would be a lie about their reach — the one rename in this split, and it is mechanical.
//
// TAG IS 'job_board' AND MUST STAY 'job_board'. Every line these helpers and the assessors log carries
// it, and the watcher trace, the monitors and every saved run key off that string. Splitting one file
// into fifteen must not split its voice into fifteen — a reader following a sweep would have to know
// the new file layout to follow a log they could previously read straight through, and every recorded
// run would stop matching the live one (Law 25).

'use strict';

const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { guardExternalSync } = require('@utils/external_library_guard');
const { isRawMaterial } = require('@utils/calculators/build_material_calculator');
// supplyJob derives every supply job's gate declaration from the row it is filling — job_gates owns the
// mapping, and this is the require that makes the constructor's one call resolve.
const { declarationFor } = require('@thinking/job_gates');

// Architect-owned tables, imported never restated (Law 16 — one source).
const {
    STOCK_THRESHOLDS,
} = require('@thinking/architect_config');
const TAG = 'job_board';

// ── RAW GATHER = 'local', CRAFTING = 'shared' ──
// Split = COST OF DUPLICATION: two bots on one 25-log order → spare logs in a chest; two on a 20-plank
// order → 10 logs burned for planks nobody asked for (rare mats — iron — gone for good). Lock kept
// exactly where duplication destroys, dropped where it doesn't. A shared lock on raw gather leaves a
// legitimate second gatherer with nothing to claim, so it falls through to an unrelated task while the
// shortage it should be filling waits. Law 4 UNTOUCHED (one signal per bot); this drops only the
// one-owner-per-TASK lock. Dispatcher already implements both scopes
// (`j.scope === 'local' || !claimed.has(j.id)`) — marking change, not a mechanism (Law 22 gate 2).
function deliverScope(item) {
    return isRawMaterial(item) ? 'local' : 'shared';
}

// Tool family → highest makeable tier. "Makeable" = pocket-presence of the tier material (underground mats
// only arrive by mining — the honest signal) AND a real recipe (Law 16 — recipe-less dispatch crashes
// supply_manager). Wood floor (logs always surface) → never dead-ends. Only wood/stone recipes exist today
// → caps at stone; extends automatically via crafting_blueprints.json. _undergroundGate re-checks amounts.
const CRAFTABLE_ITEMS = new Set(
    Object.keys(craftingRegistry.getRecipes()).map(k => k.toLowerCase())
);
// TIER_ORDER — the one tool-material ranking (Law 16): names what resolveCraftTier's if-chain encodes so
// the UPGRADE test has no second, drifting "better". Rank -1 = family absent.
const TIER_ORDER = ['wooden', 'stone', 'iron', 'diamond'];
const tierRank = (item) => TIER_ORDER.indexOf(String(item).split('_')[0]);

// min_tier validated HERE because TIER_ORDER is here (Law 16). Unchecked, a typo ranks -1 = "no floor" —
// sword row silently back to wooden. Load-time, so preflight catches it.
for (const row of STOCK_THRESHOLDS) {
    if (row.min_tier == null) continue;
    if (!TIER_ORDER.includes(row.min_tier)) {
        throw new Error(`[assessors/shared] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' declares `
            + `min_tier '${row.min_tier}', which is not one of ${TIER_ORDER.join('/')}.`);
    }
    if (row.kind !== 'tool') {
        throw new Error(`[assessors/shared] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' declares `
            + `min_tier but is not kind:'tool' — only a tool family resolves a tier.`);
    }
}

// Best owned tier, read off item NAMES — not countInInventory, which is group-aware and answers "how many
// swords", the question that hid this fault originally.
function bestOwnedTierRank(family, inventory) {
    let best = -1;
    for (const [name, count] of Object.entries(inventory || {})) {
        if (!count || !name.endsWith(`_${family}`)) continue;
        const rank = tierRank(name);
        if (rank > best) best = rank;
    }
    return best;
}

// `floor` = row's min_tier: WORST ACCEPTABLE tier, not best makeable — the resolver may name a tier the
// bot cannot currently afford. That IS the no-wooden-tool mechanism, and the PICKAXE is the only family
// left without a floor: everything else must wait for stone rather than spend a craft on a tool the
// first shaft replaces. Unaffordable ≠ dead end — the named-but-unaffordable tier posts as a SHORTFALL,
// and its missing cobblestone reaches stone_prospect_executor through supply_manager's producer split.
// So the row means "wait for stone", never "make wood now", and the waiting is bounded by one shaft.
// WRONG TURN (don't re-take): a `gate:` on the row — read only by assessors/supply's bot-holder branch, ignored
// by the storage branch (bread row's note in architect_config), so the spare-sword row would
// still fill the chest with wooden swords. Both branches call THIS — one rule covers both (Law 16).
function resolveCraftTier(family, inventory, floor) {
    const canMake = (tier) => CRAFTABLE_ITEMS.has(`${tier}_${family}`);
    const floorRank = floor ? tierRank(floor) : -1;
    const atOrAbove = (tier) => TIER_ORDER.indexOf(tier) >= floorRank;
    if (canMake('diamond') && countInInventory('diamond', inventory) >= 3)     return `diamond_${family}`;
    if (canMake('iron')    && countInInventory('iron_ingot', inventory) >= 3)  return `iron_${family}`;
    if (canMake('stone')   && countInInventory('cobblestone', inventory) >= 3) return `stone_${family}`;
    if (atOrAbove('wooden')) return `wooden_${family}`;
    // Below floor, nothing better makeable: name the floor — a shortfall to route, not a reason to make
    // the forbidden thing.
    return `${floor}_${family}`;
}

// Smelt input token if the recipe needs a furnace (charcoal←logs, iron_ingot←raw_iron), else null. Shared
// by assessors/supply (SKIP furnace items — async chain, not sync craft) and assessors/furnace (Law 16).
function furnaceInput(outputItem) {
    const bp = craftingRegistry.tryGetRecipe(outputItem);
    if (!bp || !Array.isArray(bp.requires) || !bp.requires.includes('furnace') || !bp.ingredients) return null;
    return Object.keys(bp.ingredients)[0] || null;
}

// ── THE NIGHT'S SECOND HALF — bots must stay productive at night without leaving the headframe: only
// chest-to-chest activity, crafting, or mining is legal after dusk. The board asks the step gate's
// question one moment earlier — CAN THIS ORDER BE FILLED WITHOUT LEAVING — because a step gate alone
// KILLS: supply_manager's refusal releases the job, the board re-posts it unchanged, the same bot
// re-claims it, and five identical outcomes trip the sentry-kill. That test is `obtainableGate` in
// job_gates now, along with every other reason a built job may be refused.

// ── `stock` IS A CONSTRUCTOR INPUT, NOT A PAYLOAD FIELD ──────────────────────────────────────────
// A posting site hands over the ROW it is filling and the constructor derives the gate declaration from
// it (job_gates.declarationFor), so the four sites cannot disagree about which gates their job answers
// to. Writing the declaration at each site instead would rebuild, one layer up, the exact triplication
// the gate module was made to end — the same gate spelled four times, drifting apart the first time one
// of them is edited. The row itself never enters the payload: it is config, and a job that carried it
// would be shipping a mutable table reference through the bus (Law 10 — no implicit fields).
const SUPPLY = 'supply';
function supplyJob(fields) {
    for (const field of ['need', 'hold_goal', 'at_destination']) {
        if (!Number.isFinite(fields[field]) || fields[field] < 0) {
            throw new Error(`[assessors/shared] CODING VIOLATION (Law 13): a supply job must declare \`${field}\` `
                + '— see THE QUANTITY CONTRACT above for what each of the three means and why none of '
                + `them is derivable from the others. Got id=${fields.id} what=${fields.what} `
                + `${field}=${fields[field]}`);
        }
    }
    const { stock, mode_override, ...payload } = fields;
    // `what` as well as the row, because one of the three blocks is derived from the RECIPE rather than
    // from the row — see declarationFor. Passing the item here is what keeps that derivation in the one
    // constructor instead of at each posting site.
    const gates = declarationFor(stock, mode_override, payload.what);
    return gates ? { ...payload, type: SUPPLY, gates } : { ...payload, type: SUPPLY };
}

// currentBiome — bot's biome name (lowercased, namespace stripped) or null. Read straight off the bot
// (perception, Law 1 exempt) — more reliable than bot_state.json (CWD-dependent). One definition (Law 16):
// assessors/exploration and assessors/base_layout both read it, so they can't disagree on "buildable yet".
function currentBiome() {
    const bot = global.bot;
    if (!bot || !bot.entity || typeof bot.world?.getBiome !== 'function') return null;
    const pos = bot.entity.position.floored();
    const biome = guardExternalSync(TAG, `getBiome at (${pos.x},${pos.y},${pos.z})`, () => bot.world.getBiome(pos));
    // null on refusal is the SAME reading as an unloaded column already gives, and both callers treat
    // "unknown biome" as not-yet-buildable — a bot that cannot name where it stands does not site a base.
    if (!biome.ok || biome.value == null) return null;
    const name = bot.registry?.biomes?.[biome.value]?.name || '';
    return name.replace('minecraft:', '').toLowerCase() || null;
}


module.exports = {
    TAG,
    deliverScope,
    SUPPLY,
    supplyJob,
    furnaceInput,
    resolveCraftTier,
    bestOwnedTierRank,
    tierRank,
    TIER_ORDER,
    currentBiome,
};
