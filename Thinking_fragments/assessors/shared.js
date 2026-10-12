// assessors/shared.js — what more than one assessor asks, and the one constructor every supply job is
// built through. Admission rule: a thing belongs here only if two or more assessors read it; everything
// else stays with its one caller. TAG stays 'job_board' — the watcher trace, monitors, and every saved
// run key off this string (Law 25).

'use strict';

const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { guardExternalSync } = require('@utils/external_library_guard');
const { isRawMaterial } = require('@utils/calculators/build_material_calculator');
// supplyJob derives every supply job's gate declaration from the row it is filling — job_gates owns the
// mapping, and this is the require that makes the constructor's one call resolve.
const { declarationFor } = require('@thinking/job_gates');

// Central config tables, imported never restated (Law 16 — one source).
const {
    STOCK_THRESHOLDS,
} = require('@thinking/architect_config');
const TAG = 'job_board';

// ── RAW GATHER = 'local', CRAFTING = 'shared' ──
// Raw materials get 'local' scope so an idle gatherer is never locked out of a shortage; crafted items
// stay 'shared' since a duplicate craft wastes rare inputs.
function deliverScope(item) {
    return isRawMaterial(item) ? 'local' : 'shared';
}

// Tool family → highest makeable tier. "Makeable" = pocket-presence of the tier material AND a real
// recipe (Law 16). Extends automatically as crafting_blueprints.json grows.
const CRAFTABLE_ITEMS = new Set(
    Object.keys(craftingRegistry.getRecipes()).map(k => k.toLowerCase())
);
// TIER_ORDER — the one tool-material ranking (Law 16): names what resolveCraftTier's if-chain encodes so
// the UPGRADE test has no second, drifting "better". Rank -1 = family absent.
const TIER_ORDER = ['wooden', 'stone', 'copper', 'iron', 'diamond'];
const tierRank = (item) => TIER_ORDER.indexOf(String(item).split('_')[0]);

// min_tier validated here because TIER_ORDER lives here (Law 16); load-time, so preflight catches it.
for (const row of STOCK_THRESHOLDS) {
    // max_tier — the BEST tier a row may craft. Checked the same way as min_tier.
    if (row.max_tier != null && (!TIER_ORDER.includes(row.max_tier) || row.kind !== 'tool')) {
        throw new Error(`[assessors/shared] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' declares `
            + `max_tier '${row.max_tier}', which must be one of ${TIER_ORDER.join('/')} on a kind:'tool' row.`);
    }
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

// Best owned tier, read off item NAMES — not countInInventory, which is group-aware and answers "how
// many swords", not "which tier".
// stoneOrBetter(family, inventory) → how many tools of the family at stone tier or above are held.
function stoneOrBetter(family, inventory) {
    let n = 0;
    for (const [name, count] of Object.entries(inventory || {})) {
        if (count && name.endsWith(`_${family}`) && tierRank(name) >= tierRank('stone')) n += count;
    }
    return n;
}

// ── WHICH TOOL A BODY GETS WHEN ITS POCKET IS SHORT ─────────────────────────────────────────────────
// kitTier(row, inventory) → the concrete tool, the first of the row's `tiers` it can have, or null when it can
// have none (the body works with what it holds):
//   'stone'  — when the shelf holds one (supply_manager's ladder takes it off the shelf before crafting), or
//              when cobblestone for one (3) is in the pocket or the chests (the body crafts it);
//   'wooden' — always: planks come off the surface.
// A row without `tiers` makes the best tier its own min/max allow (resolveCraftTier).
function kitTier(row, inventory) {
    if (!Array.isArray(row.tiers)) return resolveCraftTier(row.item, inventory, row.min_tier, row.max_tier);
    for (const tier of row.tiers) {
        if (tier === 'wooden') return `wooden_${row.item}`;
        if (tier === 'copper') {
            const copper = `copper_${row.item}`;
            const lens = require('@kernel/inventory_lens');
            if (lens.inChests(copper) > 0) return copper;
            if (countInInventory('copper_ingot', inventory) + lens.inChests('copper_ingot') >= 3) return copper;
        }
        if (tier === 'stone') {
            const stone = `stone_${row.item}`;
            const lens = require('@kernel/inventory_lens');
            if (lens.inChests(stone) > 0) return stone;
            if (countInInventory('cobblestone', inventory) + lens.inChests('cobblestone') >= 3) return stone;
        }
    }
    return null;
}

// noteShelfShort(item, onShelf, wanted, what) — a body wanted `wanted` of a shelf tool and the shelf held
// `onShelf`. Said once each time the shelf goes short for this body, and again when it is stocked.
const _shelfShort = new Set();
function noteShelfShort(item, onShelf, wanted, what) {
    const watcher = require('@kernel/watcher');
    if (onShelf >= wanted) {
        if (_shelfShort.delete(item)) watcher.summary('tool_shelf', `SHELF STOCKED ${item} on_shelf=${onShelf}`);
        return;
    }
    if (_shelfShort.has(item)) return;
    _shelfShort.add(item);
    watcher.summary('tool_shelf', `SHELF SHORT ${item} on_shelf=${onShelf} wanted=${wanted} took=${what}`);
}

function bestOwnedTierRank(family, inventory) {
    let best = -1;
    for (const [name, count] of Object.entries(inventory || {})) {
        if (!count || !name.endsWith(`_${family}`)) continue;
        const rank = tierRank(name);
        if (rank > best) best = rank;
    }
    return best;
}

// `floor` = row's min_tier: the worst acceptable tier — a named-but-unaffordable tier posts as a
// shortfall, never a fallback to a wooden craft. `ceiling` = row's max_tier: the best tier this
// family may be made in, whatever the pocket could afford.
function resolveCraftTier(family, inventory, floor, ceiling = null) {
    const ceilingRank = ceiling ? tierRank(ceiling) : Infinity;
    const canMake = (tier) => CRAFTABLE_ITEMS.has(`${tier}_${family}`) && TIER_ORDER.indexOf(tier) <= ceilingRank;
    const floorRank = floor ? tierRank(floor) : -1;
    const atOrAbove = (tier) => TIER_ORDER.indexOf(tier) >= floorRank;
    if (canMake('diamond') && countInInventory('diamond', inventory) >= 3)       return `diamond_${family}`;
    if (canMake('iron')    && countInInventory('iron_ingot', inventory) >= 3)    return `iron_${family}`;
    if (canMake('copper')  && countInInventory('copper_ingot', inventory) >= 3)  return `copper_${family}`;
    if (canMake('stone')   && countInInventory('cobblestone', inventory) >= 3)   return `stone_${family}`;
    if (atOrAbove('wooden')) return `wooden_${family}`;
    // Below floor, nothing better makeable: name the floor — a shortfall to route, not a reason to make
    // the forbidden thing.
    return `${floor}_${family}`;
}

// ── THE WHOLE KIT'S RAW BILL, IN ONE PLACE, SO IT CAN BE FETCHED IN ONE TRIP ─────────────────────
// Bills every active bot-held stock row's raw cost against an empty pocket, nets the body's own
// inventory once, and only for rows this body itself must fetch (`holder: 'bot'`, `mode: 'active'`,
// `deficit_below > 0`).
function kitRawShortfall(inventory) {
    const { craftShortfall } = require('@utils/calculators/build_material_calculator');
    const rows = require('@thinking/requested_work').activeStockRows()
        .filter(r => r.holder === 'bot' && r.mode === 'active' && r.deficit_below > 0);
    const EMPTY = [];
    const bill = {};
    for (const row of rows) {
        const item = row.kind === 'tool' ? kitTier(row, inventory) : row.item;
        if (!item) continue;
        // Against an EMPTY pocket — the row's full cost, so the sum is a bill, not an overlap.
        for (const [raw, need] of Object.entries(craftShortfall(item, row.deficit_below, EMPTY))) {
            bill[raw] = (bill[raw] || 0) + need;
        }
    }
    // Netted once, at the end. `countInInventory` is group-aware, so logs held as `birch_log` answer a
    // `logs` line of the bill the same way the craft will spend them.
    const short = {};
    for (const [raw, need] of Object.entries(bill)) {
        const held = countInInventory(raw, inventory);
        if (need > held) short[raw] = need - held;
    }
    return short;
}

// Smelt input token if the recipe needs a furnace (charcoal←logs, iron_ingot←raw_iron), else null.
// Shared by assessors/supply and assessors/furnace (Law 16).
function furnaceInput(outputItem) {
    const bp = craftingRegistry.tryGetRecipe(outputItem);
    if (!bp || !Array.isArray(bp.requires) || !bp.requires.includes('furnace') || !bp.ingredients) return null;
    return Object.keys(bp.ingredients)[0] || null;
}

// ── THE NIGHT'S SECOND HALF ──
// Night legality (only chest-to-chest activity, crafting, or mining after dusk) is checked before a job
// is built, by `obtainableGate` in job_gates — not by a later step gate.

// ── `stock` IS A CONSTRUCTOR INPUT, NOT A PAYLOAD FIELD ──────────────────────────────────────────
// A posting site hands over the ROW it is filling; the constructor derives the gate declaration from it
// (job_gates.declarationFor). The row itself never enters the payload — it is config, not a bus field
// (Law 10).
// ── EVERY QUANTITY SHOWS ITS WORK, AND NO TOTAL CROSSES A CATEGORY ───────────
// `parts` is a list of `{ who, amount }`, one entry per asker, summing exactly to `hold_goal`. `who` is
// "<band>:<asker>" (e.g. "bot:kit", "blueprint:laydown_yard", "chest:shelf").
function _validateParts(fields) {
    const { parts, hold_goal: goal, id, what } = fields;
    const where = `id=${id} what=${what}`;
    if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error('[assessors/shared] CODING VIOLATION (Law 13): a supply job must declare `parts` — '
            + 'who is asking and for how much, one entry per asker, adding up to `hold_goal`. See THE '
            + `QUANTITY CONTRACT above. Got ${where} hold_goal=${goal} parts=${JSON.stringify(parts)}`);
    }
    let sum = 0;
    for (const p of parts) {
        if (!p || typeof p.who !== 'string' || !p.who.includes(':')) {
            throw new Error('[assessors/shared] CODING VIOLATION (Law 13): every `parts` entry needs a `who` '
                + 'of the form "<band>:<asker>" (e.g. "bot:kit", "blueprint:laydown_yard", "chest:shelf") — '
                + `the band alone cannot be chased back to a requirement. Got ${where} part=${JSON.stringify(p)}`);
        }
        if (!Number.isFinite(p.amount) || p.amount < 0) {
            throw new Error('[assessors/shared] CODING VIOLATION (Law 13): every `parts` entry needs a '
                + `finite non-negative \`amount\`. Got ${where} part=${JSON.stringify(p)}`);
        }
        sum += p.amount;
    }
    if (sum !== goal) {
        throw new Error('[assessors/shared] CODING VIOLATION (Law 13): `parts` must account for `hold_goal` '
            + `EXACTLY — a total whose terms do not add up is the untraceable number this contract exists `
            + `to abolish. Got ${where} hold_goal=${goal} parts sum to ${sum}: ${JSON.stringify(parts)}`);
    }
}

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
    _validateParts(fields);
    const { stock, mode_override, ...payload } = fields;
    // `what` is passed alongside the row because one of the three gate blocks derives from the recipe,
    // not the row (see declarationFor).
    const gates = declarationFor(stock, mode_override, payload.what);
    return gates ? { ...payload, type: SUPPLY, gates } : { ...payload, type: SUPPLY };
}

// currentBiome — bot's biome name (lowercased, namespace stripped) or null. Read straight off the bot
// (perception, Law 1 exempt). One definition (Law 16): every assessor asking "buildable yet" reads this.
function currentBiome() {
    const bot = global.bot;
    if (!bot || !bot.entity || typeof bot.world?.getBiome !== 'function') return null;
    const pos = bot.entity.position.floored();
    const biome = guardExternalSync(TAG, `getBiome at (${pos.x},${pos.y},${pos.z})`, () => bot.world.getBiome(pos));
    // null on refusal reads the same as an unloaded column; both callers treat "unknown biome" as
    // not-yet-buildable.
    if (!biome.ok || biome.value == null) return null;
    const name = bot.registry?.biomes?.[biome.value]?.name || '';
    return name.replace('minecraft:', '').toLowerCase() || null;
}


// ── A SITE'S TREES COME DOWN BEFORE ITS BUILD — every blueprint, one job ──────────
// downloaded_build, building, and mining all post the same felling job, `site_trees_<structure>`,
// carrying their own box to canopy_clear_executor. A locked blueprint's own solid voxel is never a tree.
const SITE_TREE_LOG = /(.*_)?log$/;   // tree_feller's own definition of a trunk

// ── THE REGION IS THE BLUEPRINT'S OWN FOOTPRINT, AND NOTHING MORE ────────────
// The clear region is a box, not a radius — exactly the footprint's own offsets at the blueprint's
// actual rotation (`footprintExtent`), never padded beyond it.
// How far outside the footprint the tree pass reaches — zero, the one place this size is decided.
const TREE_MARGIN = 0;
function siteTreeBox(blueprintName) {
    const building = require('@kernel/blueprint_registry').getBuilding(blueprintName, TAG);
    const e = require('@perception/blueprint_survey').footprintExtent(building);
    const m = TREE_MARGIN;
    return { min_dx: e.min_dx - m, max_dx: e.max_dx + m, min_dz: e.min_dz - m, max_dz: e.max_dz + m };
}
// A box from a downloaded plan's own dimensions, for the one caller with a plan instead of a registered
// blueprint. Same shape: offsets from the transpose origin.
function planTreeBox(dims) {
    const m = TREE_MARGIN;
    const hx = Math.floor(dims.w / 2), hz = Math.floor(dims.l / 2);
    return { min_dx: -hx - m, max_dx: (dims.w - 1 - hx) + m, min_dz: -hz - m, max_dz: (dims.l - 1 - hz) + m };
}
const boxReach = (box) => Math.max(Math.abs(box.min_dx), box.max_dx, Math.abs(box.min_dz), box.max_dz);
const inBox = (box, centre, p) => (p.x - centre.x) >= box.min_dx && (p.x - centre.x) <= box.max_dx
    && (p.z - centre.z) >= box.min_dz && (p.z - centre.z) <= box.max_dz;
// ── A SITE'S CENSUS IS IN TREES, NOT LOG BLOCKS ──────────────────────────
// Counts trunks by base block (`@perception/trunk_bases`), the same test tree_feller uses to claim one,
// so the census and the claim agree (Law 16).
const SITE_TREE_SCAN_CAP = 512;   // roughly 64-100 trees on a forest — sized for a 20-body fleet
async function standingSiteTrees(bot, centre, box) {
    const Vec3 = require('vec3');
    const scan = guardExternalSync(TAG, `site trees around (${centre.x},${centre.z})`, () =>
        bot.findBlocks({
            point: new Vec3(centre.x, centre.y, centre.z),
            matching: (b) => !!(b && b.name && SITE_TREE_LOG.test(b.name)),
            // The Euclidean sweep must reach the box's far CORNER, which is its own diagonal.
            maxDistance: Math.ceil(Math.hypot(Math.max(Math.abs(box.min_dx), box.max_dx),
                                              Math.max(Math.abs(box.min_dz), box.max_dz))) + 2,
            count: SITE_TREE_SCAN_CAP,
        }));
    // A refused sweep is NOT a measurement of "clear" — it returns null, which the phase reads as
    // "ask again next sweep" and never as "done" (Invariant B). An empty array is a real clear site.
    if (!scan.ok) return null;
    const built = require('@perception/blueprint_survey').getAllProtectedBlocks() || new Set();
    const inSite = (scan.value || []).filter(p => !built.has(`${p.x},${p.y},${p.z}`) && inBox(box, centre, p));
    // `collapseToTrunkBases` is the feller's own target test, so a phase can never be sized off trees no
    // executor would accept (Law 16).
    const { collapseToTrunkBases, readerForBot } = require('@perception/trunk_bases');
    return (await collapseToTrunkBases(readerForBot(bot), inSite.map(p => {
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
        return { name: b?.name, position: { x: p.x, y: p.y, z: p.z } };
    }).filter(b => b.name))).map(b => b.position);
}

// ── TREE CLEARING IS A CONSTRUCTION PHASE, NOT A STANDING NO-TREE RULE ────────
// Once a site scans clear, the phase latches permanently on the building chair — a later decorative
// tree inside the footprint does not reopen it. The chair is shared board-wide.
const TREES_CHAIR = 'site_trees_done';
function siteTreePhaseDone(structure) {
    const hq = require('@kernel/corporate_headquarters');
    return !!(hq.readBuildingChair(structure, TREES_CHAIR, null) || {}).done;
}
function closeSiteTreePhase(structure, centre, box) {
    const hq = require('@kernel/corporate_headquarters');
    hq.writeBuildingChair(structure, TREES_CHAIR, {
        done: true, closed_at: Date.now(),
        centre: { x: centre.x, y: centre.y, z: centre.z }, box,
    });
}

// ── WHERE A BODY LOOKS FOR LOGS FIRST ────
// Reads the TREES_CHAIR latch as a preference signal — an open (not-yet-proved-clear) site is where a
// log-seeking body tries first, before falling through to open gathering (Law 16). Named structures come
// from `STRUCTURE_PRIORITY` plus `SHAFT_HEAD`, read as a set — the list's order belongs to job_ranking.
function openTreeSites() {
    const hq = require('@kernel/corporate_headquarters');
    const cfg = require('@thinking/architect_config');
    const mandate = require('@kernel/bot_mandate');
    const species = mandate.currentMode();
    const names = [...new Set([...(cfg.STRUCTURE_PRIORITY[species] || []), cfg.SHAFT_HEAD[species]].filter(Boolean))];
    const out = [];
    for (const name of names) {
        if (siteTreePhaseDone(name)) continue;                       // proved clear — nothing to prefer
        const spot = hq.readBuildingChair(name, 'set_buildspot', null);
        const centre = spot?.transpose_origin;
        if (!centre || typeof centre.x !== 'number') continue;       // not sited yet — no ground to name
        // Two ways to a box: the loaded plan is asked first (a downloaded building has no registered
        // blueprint); `tryGetBuilding` (not `getBuilding`) answers for the rest, since an unregistered
        // name here is ordinary, not a Law 13 violation.
        let box = null;
        const planRegistry = require('@kernel/downloaded_plan_registry');
        if (planRegistry.isLoaded() && planRegistry.getPlan()?.name === name) {
            box = planTreeBox(planRegistry.getPlan().dimensions);
        } else if (require('@kernel/blueprint_registry').tryGetBuilding(name)) {
            box = siteTreeBox(name);
        }
        if (!box) continue;
        out.push({ structure: name, centre, box });
    }
    return out;
}

// treeWorkersAndClaims: this site's capacity, counting both locked trunks and bodies en route — a body
// walking to a tree is spoken for just as surely as one already swinging at it. Read-only — asking the
// foreman would grant a claim, not merely report one: trunks come from `active_claims`, bodies from
// `magnet`, both already in this bot's broadcast boardroom cache.
function treeWorkersAndClaims(standing, structure) {
    const hq = require('@kernel/corporate_headquarters');
    const wanted = new Set(standing.map(p => `tree:${p.x},${p.y},${p.z}`));
    const selfId = process.env.BOT_ID || 'default';
    let claims = 0, workers = 0;
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
        for (const key of Object.keys(chair?.active_claims || {})) if (wanted.has(key)) claims++;
        // This body does not count itself: it is asking whether there is room for IT.
        if (botId === selfId) continue;
        const m = chair?.magnet;
        if (m && m.what === 'clear_trees' && m.structure === structure) workers++;
    }
    return { claims, workers, taken: claims + workers };
}

// freeSiteTrees: the standing trunks this body could be granted — the ones outside every column a peer
// holds, read off the peers' own `active_claims` by the footprint the foreman grants by (Law 16).
function freeSiteTrees(standing) {
    const hq = require('@kernel/corporate_headquarters');
    const { TREE_KEY_PREFIX, parseTreeFootprint, inFootprint } = require('@utils/tree_footprint');
    const selfId = process.env.BOT_ID || 'default';
    const held = [];
    for (const [botId, chair] of Object.entries(hq.getFullBoardroom({}) || {})) {
        if (botId === selfId) continue;
        for (const key of Object.keys(chair?.active_claims || {})) {
            const f = key.startsWith(TREE_KEY_PREFIX) ? parseTreeFootprint(key) : null;
            if (f) held.push(f);
        }
    }
    return standing.filter(p => !held.some(f => inFootprint(f, p)));
}

// siteTreesJob — one call that decides the whole tree phase for a blueprint, returning an ARRAY of seat
// jobs (empty when there is nothing to post); every caller spreads it into its own list. Each seat
// carries its own id, so the dispatcher grants one body per id and multiple bodies work a site at once.
// PHASE_TAG, not TAG: this ladder is SOFT (watcher.SOFT_STAGES), narrating every decision including
// deciding to do nothing.
const PHASE_TAG = 'job_board_phase';
// The region in one readable token, so every line below states the ground it is talking about.
const boxLabel = (b) => `${b.max_dx - b.min_dx + 1}x${b.max_dz - b.min_dz + 1}`;
async function siteTreesJob(structure, centre, box) {
    const { JOB_TYPE } = require('@thinking/architect_config');
    const watcher = require('@kernel/watcher');
    const bot = global.bot;
    if (!bot || !bot.findBlocks) return [];                // no body to scan with — not a decision
    if (siteTreePhaseDone(structure)) {
        watcher.summary(PHASE_TAG, `trees/${structure}: phase CLOSED — no scan, no job (decoration is not a job).`);
        return [];
    }

    const standing = await standingSiteTrees(bot, centre, box);
    if (standing === null) {
        watcher.summary(PHASE_TAG, `trees/${structure}: scan REFUSED over ${boxLabel(box)} — deciding nothing, asking again next sweep.`);
        return [];
    }
    if (standing.length === 0) {
        // ── A LATCH MAY ONLY CLOSE ON A SCAN THAT COULD HAVE SEEN SOMETHING ──────────────────────────
        // `bot.findBlocks` searches loaded chunks only, so an unvisited site reads empty the same as a
        // cleared one. Sampling the centre and four corners tests whether the site was actually observed
        // before the latch may close (Invariant B).
        const probes = [[0, 0], [box.min_dx, box.min_dz], [box.min_dx, box.max_dz], [box.max_dx, box.min_dz], [box.max_dx, box.max_dz]];
        const observed = probes.every(([dx, dz]) =>
            !!bot.blockAt(new (require('vec3'))(centre.x + dx, centre.y, centre.z + dz))?.name);
        if (!observed) {
            watcher.summary(PHASE_TAG, `trees/${structure}: 0 trunk(s) found but the site is NOT LOADED at `
                + `${boxLabel(box)} — refusing to close the phase on a scan that could not have seen one.`);
            return [];
        }
        closeSiteTreePhase(structure, centre, box);
        watcher.summary(PHASE_TAG, `trees/${structure}: 0 trunk(s) standing in ${boxLabel(box)} at `
            + `(${centre.x},${centre.z}), site loaded — PHASE CLOSED, permanently. Anchors may start.`);
        return [];
    }

    // ── ONE SEAT PER STANDING TREE, BECAUSE ONE ID IS ONE BOT ────────────────
    // Posts one seat per standing tree, capped at the roster size, since the dispatcher grants one body
    // per job id. A seat is an admission, not an assignment — which trunk a body fells is the foreman's
    // call, not the board's (Invariant D). `treeWorkersAndClaims` is read here only for the trace line.
    // Seats are counted off the trunks this body could be granted: a trunk inside a peer's column is that
    // peer's, and a seat on it is a walk to a claim the foreman refuses.
    const { claims, workers } = treeWorkersAndClaims(standing, structure);
    const free = freeSiteTrees(standing);
    const seats = Math.min(free.length, Object.keys(require('@thinking/architect_config').BOT_SENIORITY).length);
    watcher.summary(PHASE_TAG, `trees/${structure}: ${standing.length} tree(s) in ${boxLabel(box)}, `
        + `${free.length} outside every peer's column, `
        + `${claims} claimed + ${workers} peer(s) working → posting ${seats} seat(s); `
        + `the dispatcher hands out the ones no peer holds.`);
    return Array.from({ length: seats }, (_, i) => ({
        id: `site_trees_${structure}_${i}`, type: 'canopy', what: 'clear_trees', where: centre, box,
        structure, job_type: JOB_TYPE.site_clear_trees, scope: 'shared', claimed_by: null,
        why: `seat ${i + 1} of ${seats} on ${standing.length} standing trunk(s) (${claims} claimed, ${workers} peer(s) working)`,
    }));
}

module.exports = {
    TAG,
    PHASE_TAG,
    siteTreeBox,
    planTreeBox,
    boxReach,
    inBox,
    standingSiteTrees,
    freeSiteTrees,
    siteTreePhaseDone,
    openTreeSites,
    siteTreesJob,
    deliverScope,
    SUPPLY,
    supplyJob,
    furnaceInput,
    kitRawShortfall,
    resolveCraftTier,
    kitTier,
    noteShelfShort,
    bestOwnedTierRank,
    stoneOrBetter,
    tierRank,
    TIER_ORDER,
    currentBiome,
};
