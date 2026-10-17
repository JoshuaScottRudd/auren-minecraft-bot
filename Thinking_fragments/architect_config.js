// architect_config — every tunable that shapes fleet behaviour, in one place. Pure data: no logic, no
// side effects. Edit a number to change what the bot does.

'use strict';

// Y below which the world does not exist for the fleet: unroutable, undiggable, no drops. null = off.
// A body already below it is exempt from the floor.
const WORLD_DEPTH_FLOOR_Y = 0;

// Half-width of the Chebyshev square around WORLD SPAWN where no block may be broken or placed. 0 = off.
// fleet_control writes this into server.properties as `spawn-protection`, so one value authors both sides.
const SPAWN_PROTECTION_RADIUS = 16;

// How far from WORLD SPAWN a person must stand before a crew is fetched to them. Chebyshev, same shape.
const PERSON_CLEAR_OF_SPAWN = 50;

// The protocol the fleet speaks and the block registry it answers questions from. The ceiling is the
// newest version minecraft-protocol and mineflayer both carry, NOT Mojang's newest release; preflight's
// "Version ceiling" pass reads both libraries and tells you when this stops being the answer.
const SERVER_MINECRAFT_VERSION = process.env.AUREN_MINECRAFT_VERSION || '26.1';

// Where a body connects. Re-exported from foreman_config, which is the page a stranger edits.
const SERVER_ENDPOINT = require('../foreman_config');

// Fleet pecking order for peer tiebreaks — lower = elder. THIS TABLE IS THE ROSTER: fleet_control and the
// camera launcher both derive their bot list from these keys, so adding a bot is one edit here.
const BOT_SENIORITY = {
    AurenBot: 1,
    TessaBot: 2,
    IrisBot:  3,
    VesperBot: 4,
    KoaBot: 5,
    NicoBot: 6,
    EmberBot: 7,
    LumiBot: 8,
    PascalBot: 9,
    FaroBot: 10,
    RemiBot: 11,
    DanteBot: 12,
    LyraBot: 13,
    NevinBot: 14,
    VedaBot: 15,
    CorinBot: 16,
    MarnoBot: 17,
    XylarBot: 18,
    ThalonBot: 19,
    ZarekBot: 20,
};

// ── THE JOB-TYPE TABLE ────────────────────────────────────────────────────────────────────────────
// Row: { key, stage, standing }. BAND ORDER IS AUTHORED HERE — selectBand returns the first non-empty band.
//   preconditions — survival and one-time locks; every member declares stage null.
//   bot           — the BODY on its own behalf.
//   contractor    — species-exclusive, filtered by the magnet on category.
//   blueprint     — a building's bill; every declared stage is a PLACEMENT.
//   chest         — shelf levels; finishable members first.
//   busywork      — STANDING work only.
const JOB_TYPES = [
    ['preconditions', [
        { key: 'respawn_recover',        stage: null },
        { key: 'eat_food',               stage: null },
        { key: 'wood_preference_lock',   stage: null },
        { key: 'ground_salvage',         stage: null },
    ]],

    ['bot', [
        // No bootstrap barrel row: the barrel is a BLUEPRINT row, placed where the foreman sited it.
        'resource_pillaring_stock',
        'crafting_tool_bootstrap',
        'resource_baseline',
        'crafting_weapon',
        'crafting_defense',
        'crafting_tool',
        'crafting_flat',
    ]],

    // Species-exclusive by the magnet, which filters on category and nothing finer. Below `bot` so a
    // contractor equips itself first; above `blueprint` so its shelter outranks an estate it never works.
    ['contractor', [
        { key: 'building_contractor_house', stage: 'build' },
        // The house's bill ranks with the house, not the bot band (routing vs. band).
        'building_contractor_house_supply',
    ]],

    // ── CHEST OUTRANKS BLUEPRINT: bot, chest, building ────────────────────────────────────────────
    // The shelf is the fleet's TOOL SHOP; no member here may be `standing` (the load-time guard enforces it).
    ['chest', [
        // The chests' own upkeep, first in the band: every other chest job needs a free slot to finish in.
        { key: 'chest_housekeeping',     stage: 'craft' },
        { key: 'furnace_collect',        stage: 'craft' },
        { key: 'furnace_load',           stage: 'craft' },
        // Banked compostables into the composter, one batch per COMPOST_BATCH_MIN (assessors/compost).
        { key: 'compost_feed',           stage: 'craft' },
        'resource_standing_stock',
        'resource_chest_restock',
    ]],

    ['blueprint', [
        { key: 'building_headframe',        stage: 'build' },
        'building_headframe_supply',
        'building_structure_supply',
        // A downloaded building's ladder (assessors/downloaded_build): trees, then anchors bottom-up.
        // Blueprint band because they BLOCK a structure; the camera does the same felling from busywork.
        { key: 'site_clear_trees',          stage: 'gather' },
        { key: 'site_column',               stage: 'build' },
        'site_supply',
        'farm_supply_seeds',
        'farm_supply_dirt',
        { key: 'farm_tend',                 stage: 'build' },
        { key: 'building_structure',        stage: 'build' },
        { key: 'light_base',                stage: 'build' },
        { key: 'mining_dig_shaft',          stage: 'gather' },
        // A tunnel seat is pulled, never ranked: it is posted only while an order is short of something
        // underground, and job_ranking places it at that order's band and site (`pulled_by`). This row
        // only makes the key known; its band here decides nothing.
        { key: 'mining_dig_cell',           stage: 'gather' },
        // ── THE FURNACE'S INPUT RANKS WITH WHAT WANTED THE SMELT ──────────────────────────────────
        // The charcoal is the building's, a fleet total — not a per-body bot-band row.
        'smelt_input_supply',
    ]],

    ['busywork', [
        { key: 'clear_canopy',    stage: 'gather', standing: true },
        { key: 'clear_ground',    stage: 'gather', standing: true },
    ]],
];

// Index IS the order — the only place the ladder's direction exists.
const STAGES = Object.freeze(['build', 'craft', 'gather']);
const STAGE_INDEX = Object.freeze(Object.fromEntries(STAGES.map((s, i) => [s, i])));

// JOB_TYPE maps a key to ITSELF, never a number, so a misspelt member gets a load-time throw.
const JOB_TYPE = {};
const JOB_CATEGORY_OF = {};   // key → the asker it serves; authored, and nothing moves a job out of it
const JOB_STAGE_OF = {};      // key → declared stage; ABSENT means "measure it"; null means pre-band
const JOB_STANDING = new Set();
const CATEGORY_NAMES = Object.freeze(JOB_TYPES.map(([category]) => category));
const PRE_BAND = CATEGORY_NAMES[0];
const CATEGORY_INDEX = Object.freeze(Object.fromEntries(CATEGORY_NAMES.map((c, i) => [c, i])));
// The pre-band's members are an ORDERED LIST OF BANDS: a dead bot must respawn before it eats.
const PRE_BAND_MEMBERS = Object.freeze(JOB_TYPES[0][1].map(m => (typeof m === 'string' ? m : m.key)));

// ── WHAT A BAND MEANS ONCE THE ORDER IS DECIDED ───────────────────────────────────────────────────
// `level_against` — the shelf the among-equals tie-break (dispatcher) levels against. Chest and
// blueprint level against the shelf (fleet totals); every other band levels against the pocket.
// `goal` — whether this order's number is the fleet's or this body's:
//   'fleet'     a total (shelf level, building's bill) — a pledge against it is true.
//   'per_body'  each body's own (kit, hunger, death) — no pledge is read.
const BAND_POLICY = Object.freeze({
    preconditions: { level_against: 'pocket',             goal: 'per_body' },
    bot:           { level_against: 'pocket',             goal: 'per_body' },
    contractor:    { level_against: 'pocket',             goal: 'per_body' },
    chest:         { level_against: 'storage',            goal: 'fleet' },
    blueprint:     { level_against: 'pocket_and_storage', goal: 'fleet' },
    busywork:      { level_against: 'pocket',             goal: 'per_body' },
});
const BAND_GOALS = Object.freeze(['fleet', 'per_body']);

// Every band must have a policy naming a real band (Law 13).
for (const band of CATEGORY_NAMES) {
    if (!BAND_POLICY[band]) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): band '${band}' is in JOB_TYPES but has `
            + `no BAND_POLICY entry. Every band must declare which shelf its tie-break levels against.`);
    }
}
for (const band of Object.keys(BAND_POLICY)) {
    if (!CATEGORY_NAMES.includes(band)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): BAND_POLICY names '${band}', which is `
            + `not a band in JOB_TYPES (${CATEGORY_NAMES.join(' | ')}). A policy for a band that does not `
            + `exist governs nothing and reads as if it did.`);
    }
    if (!BAND_GOALS.includes(BAND_POLICY[band].goal)) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): BAND_POLICY['${band}'].goal is `
            + `${JSON.stringify(BAND_POLICY[band].goal)}, which must be one of ${BAND_GOALS.join(' | ')}. `
            + `Undeclared, the pledge mechanism would have to guess whether this band's quantities are `
            + `fleet totals or per-body ones, and guessing wrong on 'per_body' sends bodies out bare.`);
    }
}

// No tiebreak beyond (band, rung) is computed here — equal jobs are picked at random; dependencies are gates.
for (const [category, members] of JOB_TYPES) {
    for (const member of members) {
        const key    = typeof member === 'string' ? member : member.key;
        const stage  = typeof member === 'string' ? undefined : member.stage;
        const stands = typeof member === 'string' ? false : member.standing === true;
        if (JOB_TYPE[key] !== undefined) {
            throw new Error(`CODING VIOLATION (Law 13): JOB_TYPES lists "${key}" twice — one job type, one identity (Law 16).`);
        }
        if (stage !== undefined && stage !== null && !STAGES.includes(stage)) {
            throw new Error(`CODING VIOLATION (Law 13): JOB_TYPES member "${key}" declares stage '${stage}', `
                + `which is not one of ${STAGES.join('/')}.`);
        }
        if (category === PRE_BAND && stage !== null) {
            throw new Error(`CODING VIOLATION (Law 13): pre-band member "${key}" must declare \`stage: null\` — `
                + 'the pre-band ranks conditions of being able to serve any asker, and a stage is meaningless for work that produces nothing.');
        }
        if (category !== PRE_BAND && stage === null) {
            throw new Error(`CODING VIOLATION (Law 13): "${key}" is in category '${category}' and declares \`stage: null\`, `
                + 'which only the pre-band may do. Give it a stage, or omit `stage` to have the board measure it.');
        }
        JOB_TYPE[key]        = key;
        JOB_CATEGORY_OF[key] = category;
        if (stage !== undefined) JOB_STAGE_OF[key] = stage;
        if (stands) JOB_STANDING.add(key);
    }
}

// THE STANDING/FINISHABLE RULE, in one throw.
const _standingCategoryFloor = Math.min(
    ...[...JOB_STANDING].map(key => CATEGORY_INDEX[JOB_CATEGORY_OF[key]])
);
for (const key of Object.keys(JOB_TYPE)) {
    if (JOB_STANDING.has(key) || JOB_CATEGORY_OF[key] === PRE_BAND) continue;
    if (CATEGORY_INDEX[JOB_CATEGORY_OF[key]] > _standingCategoryFloor) {
        throw new Error(`CODING VIOLATION (Law 13): finishable job type "${key}" sits in category `
            + `'${JOB_CATEGORY_OF[key]}', below the highest category holding standing work `
            + `('${CATEGORY_NAMES[_standingCategoryFloor]}'). A standing order never stops posting, so this job `
            + 'is unreachable at every stage rather than merely patient — move it up, or declare it `standing: true`.');
    }
}
// NO SLOT ARITHMETIC, NO COMPOSED INTEGER, NO DECODER.

// ── DAY / NIGHT GATING ─────────────────────────────────────────────────────────────────────────────
// Vanilla clock: 0 = dawn, 12000 = dusk, 24000 = next dawn; the gate closes at dusk.
const NIGHT_STARTS_AT = 12000;
const NIGHT_ENDS_AT   = 23000;

// PEACEFUL HAS NO NIGHT — no monsters, so no night gate and the bodies keep working.
function isPeacefulWorld() {
    const d = global.bot && global.bot.game ? global.bot.game.difficulty : null;
    return d === 'peaceful';
}

function isNightTime() {
    const tod = global.bot && global.bot.time ? global.bot.time.timeOfDay : null;
    if (tod == null) return false;
    if (isPeacefulWorld()) return false;
    return tod >= NIGHT_STARTS_AT && tod < NIGHT_ENDS_AT;
}


// Build steps in order (order field = priority); tokens shared with job_board's assessors/building.
const TYPE_COORDINATES        = 'coordinates';
const TYPE_BLUEPRINT_PASTED   = 'blueprint_pasted';
const TYPE_STRUCTURE_COMPLETE = 'structure_complete';

// A `condition` token gates a requirement until it holds (job_board.conditionMet).
const BUILDING_REQUIREMENTS = [
    { field: 'headframe', type: TYPE_COORDINATES,        order: 0 },
    { field: 'headframe', type: TYPE_BLUEPRINT_PASTED,   order: 1 },
    { field: 'headframe', type: TYPE_STRUCTURE_COMPLETE, order: 2, execute_key: 'headframe_execute',
      job_type: 'building_headframe', supply_job_type: 'building_headframe_supply' },
    // The builder's waste pit (WASTE_PIT below), sited by the foreman beside the yard. Built first: it is
    // digging only and needs no material, and the yard waits on stations that have to be crafted.
    { field: 'waste_pit', type: TYPE_COORDINATES,        order: 0 },
    { field: 'waste_pit', type: TYPE_BLUEPRINT_PASTED,   order: 1 },
    { field: 'waste_pit', type: TYPE_STRUCTURE_COMPLETE, order: 2, execute_key: 'waste_pit_execute' },
    // The builder's alpha structure (ALPHA_STRUCTURE below), sited by the foreman beside the downloaded building.
    { field: 'laydown_yard', type: TYPE_COORDINATES,        order: 3 },
    { field: 'laydown_yard', type: TYPE_BLUEPRINT_PASTED,   order: 4 },
    { field: 'laydown_yard', type: TYPE_STRUCTURE_COMPLETE, order: 5, execute_key: 'laydown_yard_execute' },
];

// ── WHICH STRUCTURES A PERSON MAY ASK FOR: AN AUTHORED WHITELIST ─────────────────────────────────────
// The one list of buildings a human can request by name.
const REQUESTABLE_STRUCTURES = ['headframe'];

// Every stock the fleet maintains, in bot pockets or in shared storage. Fields:
//   item              what is held (an item name or an object-group name)
//   holder            'bot' | 'storage' — which layer holds it, never which chest
//   deficit_below     restock when held drops under this; absent = hold-only
//   fill_to           a storage row's restock fills back up to this; absent = deficit_below
//   dump_threshold    how much survives a dump; required on every row
//   mode              'active' (shortfall drives acquisition) | 'passive' (filled from what exists)
//   kind: 'tool'      the row names a tool FAMILY; min_tier / max_tier bound the tier made
//   spare_mode        a tool row's mode for the tools past the first; absent = 'passive'
//   stone_level       a tool row is satisfied by this many stone-or-better tools in place of deficit_below
//   job_type          post under this job type instead of the branch default
//   crews             which species carry it; absent = all
//   after_fulfilled   do not order until the named row is satisfied
// Each requirement belongs to one category; its crews determine every generated stock row and upkeep verb.
const REQUIREMENT_CATEGORIES = {
  shared: {
    crews: ['homesteader', 'contractor', 'builder'],
    work: [],
    stock: [
    // ── A TOOL ROW NAMES THE TIERS IT ACCEPTS, IN ORDER (`tiers`) ─────────────────────────────────────
    // A body short of a tool walks the row's `tiers` and takes the first it can have (assessors/shared.kitTier):
    //   'copper' — crafted when three copper ingots are held or banked. No row takes it: a building's copper is
    //              its own, and the mine's pickaxes had spent more copper than the castle was short;
    //   'stone'  — crafted when cobblestone is held or banked;
    //   'wooden' — crafted from planks.
    // A row whose tiers it can have none of posts nothing, and the body works with what it holds — for the
    // shovel that is its fists. `countInInventory` counts the family. `max_tier` still bounds what an UPGRADE
    // may craft. The mine is entered with the pickaxe row's `deficit_below` in the pocket
    // (mining_manager.canEnterMine), and the body digs the set down to MINING_LAST_PICKAXE before surfacing.
    { item: 'pickaxe',        holder: 'bot', kind: 'tool', tiers: ['stone', 'wooden'], deficit_below: 3, dump_threshold: 3, max_tier: 'wooden', mode: 'active', spare_mode: 'active', stone_level: 3 },
    { item: 'axe',            holder: 'bot', kind: 'tool', tiers: ['stone', 'wooden'], deficit_below: 2, dump_threshold: 2, max_tier: 'wooden', mode: 'active' },
    { item: 'tools',          holder: 'bot', dump_threshold: 99 },
    // NO TABLE IN A POCKET: every craft that needs one is made at the home blueprint's table.
    // TORCHES ARE CRAFTED FOR THE TRIP THAT PLACES THEM (mining_manager.takeMiningLight); a pocket keeps
    // what a craft made over the trip's need, up to this many.
    { item: 'torch',          holder: 'bot', dump_threshold: 32 },
    // PLANKS STAY IN THE POCKET: they are the fleet's throwaway block (utils/trash), spent by every pillar,
    // bridge and cube trip, so a body keeps what it holds — four stacks, the planks of one stack of logs —
    // and the next trip draws that much less from the chests. `deficit_below` is the walking reserve a cube
    // trip is priced to arrive with (assessors/downloaded_build.trashOf).
    { item: 'planks',        holder: 'bot', deficit_below: 12, dump_threshold: 256, job_type: 'resource_pillaring_stock', mode: 'active' },
    // STICKS FLOAT IN THE POCKET, NEVER IN A CHEST: a body keeps one stack for the crafts that need them
    // (leaves drop most of them, planks make the rest when a craft asks) and the waste pit takes the rest.
    { item: 'stick',          holder: 'bot', dump_threshold: 64 },
    // Unpledged dirt is banked; a builder discards it once the building and standby are supplied.
    { item: 'dirt',           holder: 'bot', dump_threshold: 0 },
    // A passive keep, never an errand — a deficit_below here would require a shaft pierce.
    { item: 'cobblestone',    holder: 'bot', dump_threshold: 20 },
    { item: 'raw_iron',       holder: 'bot', dump_threshold: 0 },
    { item: 'wheat',          holder: 'bot', dump_threshold: 0 },
    { item: 'saplings',       holder: 'bot', dump_threshold: 0 },

    // ── THE CHESTS HOLD MATERIAL; A TOOL OR A TORCH IS MADE WHEN A BODY NEEDS ONE ───────────────────
    // A tool takes a whole chest slot and a stack of cobblestone in that slot makes twenty of them, so the
    // chests keep the cobblestone, sticks and coal and the body short of a tool crafts it at the yard it was
    // walking to anyway (assessors/shared.kitTier). MADE_TO_ORDER below is the list; waste_pit and the chest
    // housekeeping both read it.
    { item: 'bread',         holder: 'storage', deficit_below: 8, dump_threshold: 8, mode: 'active' },
    // Three stacks of charcoal stand by: it is the fuel after coal and the building's own material, and ten
    // furnaces loaded by the full stack burn eighty of it a round.
    { item: 'charcoal',      holder: 'storage', deficit_below: 192, fill_to: 256, dump_threshold: 256, mode: 'active' },
    ],
  },
  homestead: {
    crews: ['homesteader', 'contractor'],
    work: [],
    stock: [
      // Outdoor survival crews carry weapons; the passive shield uses material already available.
      { item: 'sword', holder: 'bot', kind: 'tool', tiers: ['stone', 'wooden'], deficit_below: 1, dump_threshold: 1, max_tier: 'wooden', job_type: 'crafting_weapon', mode: 'active' },
      { item: 'shield', holder: 'bot', deficit_below: 1, dump_threshold: 1, job_type: 'crafting_defense', mode: 'passive' },
    ],
  },
  builder: {
    crews: ['builder'],
    // No compost: a builder's saplings and leaf litter go to the waste pit (WASTE_PIT.items, sapling_planter).
    work: ['waste_disposal', 'chest_housekeeping'],
    stock: [
      // A stone shovel speeds the builder's excavation without ordering a wooden shovel.
      { item: 'shovel', holder: 'bot', kind: 'tool', tiers: ['stone'], deficit_below: 2, dump_threshold: 2, max_tier: 'stone', mode: 'active' },
    ],
  },
};
const STOCK_THRESHOLDS = Object.values(REQUIREMENT_CATEGORIES)
    .flatMap(category => category.stock.map(row => ({ ...row, crews: category.crews })));

// MADE_TO_ORDER — what is crafted for the body that needs it and never stored: every tool, and torches. One
// past what a pocket's own row keeps goes to the waste pit, from a pocket or from a chest.
function madeToOrder(item) {
    return item === 'torch' || require('@utils/fragment_utils').group_to_item.tools.includes(item);
}

// Load-time integrity (Law 13) — preflight loads every fragment, so this runs on every change.
for (const row of STOCK_THRESHOLDS) {
    // The holder is the LAYER, and only two exist.
    if (row.holder !== 'bot' && row.holder !== 'storage') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `has holder ${JSON.stringify(row.holder)}. The only holders are 'bot' (the pocket) and 'storage' `
            + `(the fleet's chest system as one pool). A request is fleet-wide and is never addressed to a `
            + `named chest, and there are no chest roles — see the holder note above this table.`);
    }
    if (row.fill_to != null && (row.holder !== 'storage' || !(row.fill_to >= row.deficit_below))) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' has fill_to `
            + `${row.fill_to}; fill_to is a storage row's refill level and is at least its deficit_below (${row.deficit_below}).`);
    }
    if ('role' in row) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `still declares a chest 'role'. Roles ('requester'/'buffer') are deleted: buffer goes into any `
            + `chest and a request is filled from any chest.`);
    }
    if ('target' in row) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `still uses a removed field name. 'target' became 'keep', which became 'dump_threshold'.`);
    }
    if (typeof row.dump_threshold !== 'number') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `has no numeric 'dump_threshold'. Every stock must declare how much survives a dump.`);
    }
    // A mode is required wherever deficit_below is declared — undeclared, it would fall back silently.
    if (row.deficit_below != null && row.mode !== 'active' && row.mode !== 'passive') {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares deficit_below ${row.deficit_below} but mode '${row.mode}'. Every restocked row must declare `
            + `mode: 'active' (the shortfall drives acquisition) or 'passive' (it is filled from what `
            + `already exists). Gating is an overlay on top of either, never a third mode.`);
    }
    if (row.job_type != null && JOB_TYPE[row.job_type] === undefined) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares job_type '${row.job_type}', which is not a job type in JOB_TYPES. `
            + `The row would post under its branch's default instead, silently.`);
    }
    // The inverse: a mode with no deficit_below governs a shortfall that is never computed.
    if (row.deficit_below == null && row.mode !== undefined) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares mode '${row.mode}' but no 'deficit_below'. A hold-only row has no shortfall to answer for.`);
    }
}

// ── Canopy clearing (camera framing) ──
// Proactive tree-clear around opted-in surface blueprints; the default only — an asker may name its own radius.
const TREE_CLEAR_RADIUS = 64;
// How far past a downloaded building's footprint its grounds are kept clear: every tree and fallen log
// felled, and leaf debris and grass tufts dug, in a ring this many blocks wide (assessors/grounds).
const GROUNDS_MARGIN = 20;

// Biomes the bot will settle and build in. Outside this set, exploration seeks a new biome first.
// No big-tree biome is admitted — bars `jungle` variants and `dark_forest` (always a 2×2 big tree).
const ACCEPTABLE_BIOMES = new Set([
    'plains', 'sunflower_plains', 'forest', 'birch_forest',
    'flower_forest', 'old_growth_birch_forest',
]);

// WHERE A PERSON HAS TO BE STANDING FOR A CREW TO BE WORTH RAISING.
const SEA_LEVEL = 63;
// Below the column's own topmost ground by more than this = underground (a cave, a mine, a ravine).
const HUMAN_SURFACE_SLACK = 4;
// Above SEA_LEVEL by more than this = a peak.
const HUMAN_MAX_ABOVE_SEA = 20;

// No water-biome list — a wheat field is sited against any sea-level water.

// ── COPPER STANDS IN FOR IRON WHERE THE GAME MAKES THE SAME BLOCK OF IT ──────────────────────────────
// A downloaded building's block named on the left is built as the block on the right (downloaded_plan_registry
// blockOf), so iron is spent only on the blocks that have no copper form.
const COPPER_FOR_IRON = Object.freeze({ iron_bars: 'copper_bars', iron_chain: 'copper_chain', lantern: 'copper_lantern' });

// Fuel preference order (first one held is used); logs excluded — worth 4x a plank.
// Coal first, charcoal second; planks burn only when a body holds neither and the chests hold neither.
const FUEL_PREFERENCES = ['coal', 'charcoal', 'planks'];

// ── COMPOST → BONE MEAL ────────────────────────────────────────────────────────────────────────────
// Waste (leaf litter, saplings) into bone meal; `leaf_litter` is the compostable block.
const BONE_MEAL_MAX_CROP_STAGE = 6;
// Banked compostables that post the `compost_feed` job: one body empties them all into the composter in
// one visit, so the walk is paid once per hundred items.
const COMPOST_BATCH_MIN = 100;

// ── CHEST HOUSEKEEPING (assessors/housekeeping, chest_housekeeping_executor) ─────────────────────────
// A pass is posted once this share of every chest slot is taken and an item sits in more stacks than it
// needs. One body makes at most this many stack moves, then the board is read again.
const CHEST_HOUSEKEEPING = Object.freeze({ full_share: 0.75, moves_per_pass: 15 });

// A mining trip is bounded by TOOLS, never by a count of cells: the body carries the pickaxe row's set
// and keeps taking cells while it holds more than MINING_LAST_PICKAXE, so the last one is reserved for
// finishing the cell in hand before the walk up (mining_manager). MINING_PASSES_PER_DISPATCH bounds
// the RE-PASSES on ONE cell or shaft segment that keeps shrinking without coming clean.
const MINING_LAST_PICKAXE = 1;
const MINING_PASSES_PER_DISPATCH = 3;

// ── THE WASTE PIT (custom_api/waste_pit) — WHERE A POCKET'S TRASH GOES INSTEAD OF A CHEST ─────────────
// The pit is the `structure` blueprint (building_blueprints.json): a 4×3 pad with a trench two blocks long
// down its middle, sited by the foreman beside the yard (WASTE_PIT_SITING) and built by the crew. A body
// stands on the pad cell at one end of the trench and tosses along it at the far wall; an item resting
// on the pit floor is under the thrower's feet, past the reach of a player's pickup box, and despawns on
// its own after five minutes.
// `items` is what the pit takes, and only past what the pocket's own row keeps; a wooden pickaxe is
// taken once the body holds the pickaxe row's stone set, which is the exchange of wood for stone.
const WASTE_PIT = Object.freeze({
    structure: 'waste_pit',
    items: Object.freeze(['wooden_pickaxe', 'gravel', 'flint', 'diorite', 'granite', 'andesite', 'tuff',
        'calcite', 'smooth_basalt', 'lapis_lazuli', 'apple', 'egg', 'amethyst_block', 'amethyst_shard',
        'red_mushroom', 'brown_mushroom', 'white_wool', 'mutton', 'leaf_litter', 'stick']),
});

// ── THE MINE'S UNIT: 'cell' (5×5×5 rooms) OR 'strip' (1×2 trunk and branches) — mining_cell_graph ──────────
// Both grow as a fan from each floor's staircase side-attaches, nearest the prime first. A strip body mines
// the ore it uncovers in the tunnel's walls (mining_executor.mineVeins). AUREN_MINE_LAYOUT picks one for a
// run, so the two can be run side by side on the same code.
const MINE_LAYOUTS = ['cell', 'strip'];
const MINE_LAYOUT = process.env.AUREN_MINE_LAYOUT || 'strip';
if (!MINE_LAYOUTS.includes(MINE_LAYOUT)) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): AUREN_MINE_LAYOUT is "${MINE_LAYOUT}"; it is one of ${MINE_LAYOUTS.join(', ')}.`);
}

// ── THE STONE PROSPECT — a shaft dug for its own material, not for a mine ─────────────────────────
// Needs a surveyed site before it can post, same as the other two digs.
const STONE_PROSPECT = {
    stone_run: 9,            // uninterrupted `stone` blocks the column must hold — THE GATE
    max_overburden: 6,       // non-stone ground above the run before the column is refused
    min_radius: 2,           // never open a shaft in the cell the bot is standing on
    max_radius: 24,          // outer edge of the search; past this the walk costs more than a deeper hole
    scan_batch: 64,          // columns probed before the scanner stops to ask "did anything fit?"
    max_batches: 4,          // batches before the sweep concedes and the caller replans
    min_fits: 12,             // floor on the ranked candidate list, not a target the world must meet
    scan_up: 16,             // search window above the bot's feet, for a column upslope of it
    scan_down: 24,           // and below, for one downslope
    max_approaches: 8,       // ranked columns claimed-and-approached before conceding — a bounded walk
    filler_reserve: 12,      // placeable non-stone blocks required in hand before the descent begins
};

// Two numbers in two tables that must agree — checked at load, not trusted to a comment.
const _plankFloor = STOCK_THRESHOLDS.find(r => r.item === 'planks' && r.holder === 'bot');
if (!_plankFloor || _plankFloor.deficit_below < STONE_PROSPECT.filler_reserve) {
    throw new Error(`[architect_config] CODING VIOLATION (Law 13): the bot's planks floor `
        + `(min ${_plankFloor ? _plankFloor.deficit_below : 'ROW MISSING'}) is below STONE_PROSPECT.filler_reserve `
        + `(${STONE_PROSPECT.filler_reserve}). The prospect would refuse to descend for want of sealing `
        + `material while the row that supplies it reads satisfied, and every stone job would stall.`);
}

// ── NOTHING IN THE BODY'S OWN KIT MAY REQUIRE STONE (STANDING) ───────────────────────────────────
// A kit requiring stone requires a shaft, which requires a pickaxe, which is itself a kit row —
// checked by walking the row's own recipe decomposition (`build_material_calculator`, Law 16).
// Scoped to `holder: 'bot'`, `mode: 'active'` rows with a `deficit_below` — the ones that drive a trip.
{
    const { isProspected, isUnderground } = require('@utils/fragment_utils');
    const { blueprintToRawMaterials } = require('@utils/calculators/build_material_calculator');
    const STONE_TIERS = ['stone', 'copper', 'iron', 'diamond', 'netherite'];
    for (const row of STOCK_THRESHOLDS) {
        if (row.holder !== 'bot' || row.mode !== 'active' || !(row.deficit_below > 0)) continue;
        if (row.min_tier && STONE_TIERS.includes(row.min_tier)) {
            throw new Error(`[architect_config] CODING VIOLATION (Law 13): the bot-kit row '${row.item}' `
                + `declares min_tier '${row.min_tier}', so the body cannot equip itself without cobblestone — `
                + `and cobblestone is a shaft, which is a pickaxe, which is another row of this same kit. `
                + `The body's own kit is made of wood only; a stone tier is the SHELF's order `
                + `(holder: 'storage'), which the family count then satisfies for free.`);
        }
        // A tool row names a FAMILY, which has no recipe of its own — ask the tier the body makes from nothing,
        // its wooden one. A row whose tiers hold no wooden is offered only once stone already exists
        // (shared.kitTier), so it never sends a body digging for its own tool.
        if (row.kind === 'tool' && Array.isArray(row.tiers) && !row.tiers.includes('wooden')) continue;
        const token = row.kind === 'tool' ? `${row.max_tier || 'wooden'}_${row.item}` : row.item;
        for (const raw of Object.keys(blueprintToRawMaterials({ [token]: row.deficit_below }))) {
            if (!isProspected(raw) && !isUnderground(raw)) continue;
            throw new Error(`[architect_config] CODING VIOLATION (Law 13): the bot-kit row '${row.item}' `
                + `decomposes to '${raw}', which is reached only by digging — a pickaxe and a shaft. The `
                + `bot band sits above every other band and must empty before any of them is reached, so a `
                + `kit row that needs stone waits on a pickaxe that is waiting on this row. Put the order `
                + `on the shelf (holder: 'storage') or in a build's bill, or make the row passive if the `
                + `body should merely keep what it finds.`);
        }
    }
}

// ── Combat / engagement tunables ──
// "Inside base" = within this many blocks of the headframe's transpose_origin; engage on aggro outside it.
const HEADFRAME_SAFE_RADIUS = 32;

// The farm runs as N instances under per-instance conference-room keys; this is the KEY PREFIX those
// keys are built from — it is NOT a blueprint, and getBuilding() will not resolve it.
const FARM_BLUEPRINT_NAME = 'wheat_tine_row';

// Four rows, one per direction, chosen by name; no blueprint rotation, so direction is a choice of
// blueprint made once at lock time from the stand-to-crop offset.
const FARM_ROW_BLUEPRINTS = {
    '1,0':  'wheat_tine_row_east',
    '0,-1': 'wheat_tine_row_north',
    '-1,0': 'wheat_tine_row_west',
    '0,1':  'wheat_tine_row_south',
};
// The design every row shares: four blocks, two cropped. All four blueprints hold the same counts
// (Law 16) — a reader asking what one row costs names this one.
const FARM_ROW_DESIGN = 'wheat_tine_row_east';
const FARM_PLOT_COUNT = 32;
const FARM_PLOTS_PER_ROW = 2;
if (FARM_PLOT_COUNT % FARM_PLOTS_PER_ROW !== 0) {
    throw new Error(`CODING VIOLATION (Law 13): FARM_PLOT_COUNT ${FARM_PLOT_COUNT} is not whole tine rows of ${FARM_PLOTS_PER_ROW} plots.`);
}
const FARM_ROOM_KEYS = Array.from({ length: FARM_PLOT_COUNT / FARM_PLOTS_PER_ROW }, (_, i) =>
    i === 0 ? FARM_BLUEPRINT_NAME : `${FARM_BLUEPRINT_NAME}#${i}`);
// The whole field's name as ONE structure — what STRUCTURE_PRIORITY lists and every farm job is stamped with.
const FARM_STRUCTURE = 'wheat_farm';

// ── A STRUCTURE NAME IS NOT ALWAYS A ROOM KEY, AND THE FARM IS THE CASE THAT PROVES IT ──────────────
// STRUCTURE names (STRUCTURE_PRIORITY) and ROOM KEYS (site[].roomKey) coincide except for the farm,
// ONE structure realized by sixteen instances — `wheat_farm` is never a room key (Law 16, Invariant D).
function roomKeysForStructure(structure) {
    if (typeof structure !== 'string' || !structure) {
        throw new Error(`CODING VIOLATION (Law 13): roomKeysForStructure needs a structure name, got ${JSON.stringify(structure)}.`);
    }
    return structure === FARM_STRUCTURE ? [...FARM_ROOM_KEYS] : [structure];
}

// A hostile is "aggroed" iff within AGGRO_RANGE blocks and has clear line-of-sight to the bot.
const AGGRO_RANGE     = 15;
const DISENGAGE_RANGE = 20;

// ── PER-SPECIES AGGRO RANGE ────────────────────────────────────────────────────────────────────────
// Only the skeleton family is listed; every other mob falls back to AGGRO_RANGE.
const MOB_AGGRO_RANGE = {
    skeleton: 18,
    stray: 18,
    bogged: 18,
    wither_skeleton: 18,
};
const MAX_AGGRO_RANGE = Object.values(MOB_AGGRO_RANGE).reduce((m, v) => Math.max(m, v), AGGRO_RANGE);

// ── THE GATE IS A CYLINDER, NOT A SPHERE ───────────────────────────────────────────────────────────
// Horizontal aggro range and vertical range are independent budgets.
const AGGRO_VERTICAL_RANGE = 8;
const MAX_CAST_RANGE = Math.hypot(MAX_AGGRO_RANGE, AGGRO_VERTICAL_RANGE);
// Measured against the diagonal, not the radius — the farthest a mob can be and still be aggroed.
if (DISENGAGE_RANGE <= MAX_CAST_RANGE) {
    throw new Error(`[architect_config] DISENGAGE_RANGE ${DISENGAGE_RANGE} must exceed the aggro cylinder's ` +
        `diagonal ${MAX_CAST_RANGE.toFixed(2)} (widest radius ${MAX_AGGRO_RANGE} × vertical ${AGGRO_VERTICAL_RANGE})`);
}

// The horizontal radius this species is honoured at — the one route for the table lookup (Law 16).
function aggroRangeFor(name) {
    if (!name) return AGGRO_RANGE;
    return MOB_AGGRO_RANGE[String(name).toLowerCase()] || AGGRO_RANGE;
}

// The cylinder's diagonal, rounded up so the predicate never truncates one voxel short.
function aggroCastRange(name) {
    return Math.ceil(Math.hypot(aggroRangeFor(name), AGGRO_VERTICAL_RANGE));
}

// THE ONE ROUTE for the gate itself (Law 16). Plain {x,y,z} so benches and monitors can ask the bot's
// own question without dragging prismarine into a reader (Law 26).
function withinAggroRange(self, pos, name) {
    if (!self || !pos) return false;
    if (Math.abs(pos.y - self.y) > AGGRO_VERTICAL_RANGE) return false;
    return Math.hypot(pos.x - self.x, pos.z - self.z) <= aggroRangeFor(name);
}
const TORCH_LIGHT_FLOOR = 3;

// Hunger / eating (Law 17 self-preservation). Minecraft food is 0–20.
const HUNGER_EAT_THRESHOLD      = 18;
const HUNGER_MUST_EAT_THRESHOLD = 0;
const HUNGER_FULL               = 20;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTROL PROGRAM — the two species, the sign claim, and the one-line order grammar
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// FOREMAN — the in-game desk.
const FOREMAN_CHANNELS = Object.freeze({ OPEN_CHAT: 'open_chat', WHISPER: 'whisper' });
const FOREMAN_CHANNEL = FOREMAN_CHANNELS.OPEN_CHAT;

// The word that makes a line addressed to the foreman; everything else is ignored without comment.
const FOREMAN_PREFIX = 'foreman';

// The foreman's own player name; NOT in BOT_SENIORITY — the roster is bots, the foreman is staff.
const FOREMAN_NAME = 'Foreman';

// BOT_MODES — the mandate vocabulary. A bot is one of these AT BIRTH and never changes.
//   homesteader — answers to nobody, started from the TERMINAL.
const BOT_MODES = Object.freeze({ HOMESTEADER: 'homesteader', CONTRACTOR: 'contractor', BUILDER: 'builder' });
// ── THE ALPHA STRUCTURE: ONE PER SPECIES, AND THE SPECIES DECIDES IT ─────────────────────────────────────────────
// The one structure a body of each species must raise before any other. Read with STRUCTURE_PRIORITY below.
const ALPHA_STRUCTURE = Object.freeze({
    [BOT_MODES.HOMESTEADER]: 'headframe',
    [BOT_MODES.CONTRACTOR]:  'contractor_house',
    [BOT_MODES.BUILDER]:     'laydown_yard',
});
// ── WHERE A SPECIES' MINESHAFT HANGS FROM ────────────────────────────────────────────────────────────────────────
// Where a species gets its first stone: its own prospect shaft, or a mine opened after the furnace.
const STONE_SOURCE = Object.freeze({
    [BOT_MODES.HOMESTEADER]: 'prospect',
    [BOT_MODES.CONTRACTOR]:  'prospect',
    // ── A BUILDER DOES NOT PIERCE ───────────────────────────────────────────────────────────────────
    // `mine`, not `mine_after_furnace` — a stone shortfall reaches the board's mining pull directly.
    [BOT_MODES.BUILDER]:     'mine',
});
const SHAFT_HEAD = Object.freeze({
    [BOT_MODES.HOMESTEADER]: 'headframe',
    [BOT_MODES.CONTRACTOR]:  'headframe',
    [BOT_MODES.BUILDER]:     'mineshaft',
});
// A STOCK ROW'S `crews` names species; a misspelt one would silently hand the row to nobody.
for (const row of STOCK_THRESHOLDS) {
    if (row.crews != null && (!Array.isArray(row.crews) || row.crews.some(c => !Object.values(BOT_MODES).includes(c)))) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS row '${row.item}' `
            + `declares crews ${JSON.stringify(row.crews)}; each must be one of ${Object.values(BOT_MODES).join(', ')}.`);
    }
}
// One row per item per crew: two rows for the same item/holder are legal only when their crews
// don't meet — otherwise one crew would post two orders under one job id.
for (const mode of Object.values(BOT_MODES)) {
    const seen = new Set();
    for (const row of STOCK_THRESHOLDS) {
        if (row.crews && !row.crews.includes(mode)) continue;
        const key = `${row.holder}:${row.item}`;
        if (seen.has(key)) {
            throw new Error(`[architect_config] CODING VIOLATION (Law 13): STOCK_THRESHOLDS has two '${row.item}' rows `
                + `(holder ${row.holder}) that both reach the ${mode} crew. Scope them with disjoint 'crews'.`);
        }
        seen.add(key);
    }
}

// The mode stamped on a terminal launch, stated here as the one declared value — bot_mandate throws on
// an ABSENT mode (Law 13).
const TERMINAL_SPAWN_MODE = BOT_MODES.HOMESTEADER;

// ── WHAT A BUILDER BUILDS, AND THE NUMBERS ITS SITE IS FOUND WITH ──────────────────────────────────
// w/l/below/blocks ARE THE PLAN'S OWN NUMBERS, checked against it at downloaded_plan_registry.load.
const BUILDER_BUILDS = Object.freeze({
    overgrown_survival_castle: Object.freeze({
        name: 'overgrown_survival_castle', w: 41, l: 53, below: 7, ring: 8, blocks: 25103, maxTolerance: 3,
    }),
});

// Where the builder's laydown yard may go, relative to the building it serves: as near as the ground allows, outside
// the building's ring (BUILDER_BUILDS ring — the strip round its pit that bodies dig their stairs down through) and
// never closer than min_gap, all measured footprint edge to footprint edge. Every castle trip starts and ends at the
// yard, so its distance is paid on every trip. A site alert_gap or more away is alerted (watcher.warn
// 'YARD ALERT'). search_to is the farthest gap looked at.
const YARD_SITING = Object.freeze({ min_gap: 5, alert_gap: 25, search_to: 63, rise: 2, scrape_max: 2, fill_max: 1 });

// Where the builder's waste pit may go, relative to the yard: the nearest spot min_gap or more from the yard's
// footprint, outside the building's ring, its pad within ±rise of the yard floor. Every trip's leftovers are
// carried from the yard to the pit, so the nearest level spot wins. fill_max is 0: the pad is cut, never filled,
// so the pit is built with no material.
const WASTE_PIT_SITING = Object.freeze({ min_gap: 2, search_to: 24, rise: 1, scrape_max: 2, fill_max: 0 });

// ── THE TREE FARM (custom_api/sapling_planter) — A CREW REPLANTS BESIDE ITS HOME STRUCTURE ────────────────
// A species with a row here plants saplings when a tree harvest ends; a species with no row plants nothing
// and handles saplings as its stock rows say. The farm is the ground past `yard_clear` from the home
// structure (ALPHA_STRUCTURE) on the three sides that do not face `away_from`, so the layers read
// `away_from`, home, clear ground, farm. Planting at the end of a tree harvest is the one way a sapling is planted.
//   away_from   the structure the farm keeps the home between itself and
//   keep        primary saplings a pocket keeps; the primary is the sapling of the fleet's wood (the wood
//               the build is made of); every other sapling, and the primary past this, goes to the waste pit
//   yard_clear  blocks round the home's footprint that hold no sapling; every sapling stands farther out
//   building_gap  nearest a sapling stands to any other building's footprint, in blocks
//   spacing     blocks, centre to centre, between a sapling and any other sapling or trunk
//   search      how far from where the harvest ended a planting cell is looked for; none inside it, none planted
//   plantings   the most saplings one harvest plants
const TREE_FARM = Object.freeze({
    [BOT_MODES.BUILDER]: Object.freeze({
        away_from: require('../foreman_config').builder.build,
        keep: 64, yard_clear: 15, building_gap: 2, spacing: 4, search: 20, plantings: 5,
    }),
});
for (const [mode, row] of Object.entries(TREE_FARM)) {
    for (const k of ['keep', 'yard_clear', 'building_gap', 'spacing', 'search', 'plantings']) {
        if (!Number.isInteger(row[k]) || row[k] < 0) {
            throw new Error(`[architect_config] CODING VIOLATION (Law 13): TREE_FARM.${mode}.${k} is ${row[k]}; it is a whole number of zero or more.`);
        }
    }
    if (typeof row.away_from !== 'string' || !row.away_from || row.spacing < 1) {
        throw new Error(`[architect_config] CODING VIOLATION (Law 13): TREE_FARM.${mode} needs an away_from structure and a spacing of at least 1.`);
    }
}

// Where the builder's mineshaft may go: its whole diagonal run keeps min_gap from the castle, the yard and the pit.
const SHAFT_SITING = Object.freeze({ min_gap: 15 });

// ── A FROZEN SERVER ENDS THE RUN (js_kernel/server_pulse) ─────────────────────────────────────────────
// The server sends its time once a second from its tick loop. warn_ms of silence is said; the end is
// timeout_crash's one limit, and it ends the whole run. self_ms: a body whose own once-a-second check arrives this late was itself frozen.
const SERVER_SILENCE = Object.freeze({ warn_ms: 5000, self_ms: 2000 });

// ── STRUCTURE PRIORITY: WHICH SITE'S WORK IS PREFERRED, NEVER WHICH SITE MAY START ─────────────────
// Read by `job_ranking` as a third coordinate inside the blueprint band (Law 27); nothing here refuses a job.
const STRUCTURE_PRIORITY = Object.freeze({
    [BOT_MODES.HOMESTEADER]: Object.freeze([ALPHA_STRUCTURE[BOT_MODES.HOMESTEADER], FARM_STRUCTURE]),
    [BOT_MODES.CONTRACTOR]:  Object.freeze([ALPHA_STRUCTURE[BOT_MODES.CONTRACTOR]]),
    // Priority order: laydown yard, waste pit, mining, castle.
    [BOT_MODES.BUILDER]: Object.freeze([
        ALPHA_STRUCTURE[BOT_MODES.BUILDER],
        WASTE_PIT.structure,
        'mineshaft',
        require('../foreman_config').builder.build,
    ]),
});
// ── THE HEADFRAME CLOCK: DAWN TO DUSK ───────────────────────────────────────────────────────────────────────────
// The shell must stand before dusk, so the grade bands are wall-clock seconds from the crew starting work.
const HEADFRAME_CLOCK = Object.freeze({
    structure: 'headframe',
    green_within_sec: 690,   // 11m 30s
    ok_within_sec: 720,      // 12m
    alert_from_sec: 780,     // 13m
    why: 'dawn to dusk — the alpha structure every other building waits on, and the crew\'s shelter for the first night (Law 17)',
    // WHAT STOPS THE CLOCK: the shell, not the last anchor.
    graded_anchor: 2,
});
if (!(HEADFRAME_CLOCK.green_within_sec < HEADFRAME_CLOCK.ok_within_sec && HEADFRAME_CLOCK.ok_within_sec < HEADFRAME_CLOCK.alert_from_sec)) {
    throw new Error('CODING VIOLATION (Law 13): HEADFRAME_CLOCK bands must rise — green < ok < alert.');
}
if (!Number.isInteger(HEADFRAME_CLOCK.graded_anchor) || HEADFRAME_CLOCK.graded_anchor < 0) {
    throw new Error(`CODING VIOLATION (Law 13): HEADFRAME_CLOCK.graded_anchor must be a whole anchor index, got ${HEADFRAME_CLOCK.graded_anchor}.`);
}

for (const mode of Object.values(BOT_MODES)) {
    const order = STRUCTURE_PRIORITY[mode];
    if (!Array.isArray(order) || order.length === 0 || new Set(order).size !== order.length) {
        throw new Error(`CODING VIOLATION (Law 13): STRUCTURE_PRIORITY for species '${mode}' must be a non-empty list of distinct structure names.`);
    }
}
for (const mode of Object.values(BOT_MODES)) {
    if (typeof ALPHA_STRUCTURE[mode] !== 'string' || STRUCTURE_PRIORITY[mode][0] !== ALPHA_STRUCTURE[mode]) {
        throw new Error(`CODING VIOLATION (Law 13): species '${mode}' has alpha structure '${ALPHA_STRUCTURE[mode]}', which must `
            + `name a structure and open its STRUCTURE_PRIORITY (got ${JSON.stringify(STRUCTURE_PRIORITY[mode])}).`);
    }
}
{
    const builderBuild = STRUCTURE_PRIORITY[BOT_MODES.BUILDER][STRUCTURE_PRIORITY[BOT_MODES.BUILDER].length - 1];
    if (!BUILDER_BUILDS[builderBuild]) {
        throw new Error(`CODING VIOLATION (Law 13): foreman_config.builder.build is '${builderBuild}', which is not a building the fleet knows. `
            + `Known: ${Object.keys(BUILDER_BUILDS).map(v => `'${v}'`).join(' | ')} (architect_config.BUILDER_BUILDS).`);
    }
}


// The short word a human says, and the item it means.
const ORDER_ALIASES = Object.freeze({
    cobble:  'cobblestone',
    stone:   'stone',
    plank:   'oak_planks',
    oak_log: 'oak_log',
    log:     'oak_log',
    iron:    'iron_ingot',
    gold:    'gold_ingot',
    coal:    'coal',
    torch:   'torch',
    glass:   'glass',
    dirt:    'dirt',
    sand:    'sand',
    wheat:   'wheat',
    bread:   'bread',
    stick:   'stick',
});

// THE GUARANTEE'S HOME IS HERE, not in a test file (the one-test rule).
for (const alias of Object.keys(ORDER_ALIASES)) {
    if (alias !== alias.toLowerCase()) {
        throw new Error(`CODING VIOLATION (Law 13): order alias "${alias}" is not lowercase — a human's words are compared lowercased, so a capital here is a word no human can ever match.`);
    }
}

module.exports = {
    WORLD_DEPTH_FLOOR_Y,
    SPAWN_PROTECTION_RADIUS,
    PERSON_CLEAR_OF_SPAWN,
    SERVER_MINECRAFT_VERSION,
    SERVER_ENDPOINT,
    BOT_SENIORITY,
    FOREMAN_CHANNELS,
    FOREMAN_CHANNEL,
    FOREMAN_PREFIX,
    FOREMAN_NAME,
    BOT_MODES,
    STRUCTURE_PRIORITY,
    BUILDER_BUILDS,
    ALPHA_STRUCTURE,
    SHAFT_HEAD,
    STONE_SOURCE,
    YARD_SITING,
    WASTE_PIT_SITING,
    TREE_FARM,
    SHAFT_SITING,
    SERVER_SILENCE,
    HEADFRAME_CLOCK,
    JOB_TYPE,
    JOB_CATEGORY_OF,
    JOB_STAGE_OF,
    CATEGORY_NAMES,
    CATEGORY_INDEX,
    BAND_POLICY,
    PRE_BAND,
    PRE_BAND_MEMBERS,
    STAGES,
    STAGE_INDEX,
    BONE_MEAL_MAX_CROP_STAGE,
    COMPOST_BATCH_MIN,
    CHEST_HOUSEKEEPING,
    madeToOrder,
    MINING_LAST_PICKAXE,
    WASTE_PIT,
    MINE_LAYOUT,
    MINING_PASSES_PER_DISPATCH,
    STONE_PROSPECT,
    isNightTime,
    isPeacefulWorld,
    TREE_CLEAR_RADIUS,
    GROUNDS_MARGIN,
    HEADFRAME_SAFE_RADIUS,
    FARM_BLUEPRINT_NAME,
    FARM_ROW_BLUEPRINTS,
    FARM_ROW_DESIGN,
    FARM_PLOT_COUNT,
    FARM_ROOM_KEYS,
    FARM_STRUCTURE,
    roomKeysForStructure,
    AGGRO_RANGE,
    MOB_AGGRO_RANGE,
    AGGRO_VERTICAL_RANGE,
    aggroRangeFor,
    aggroCastRange,
    withinAggroRange,
    DISENGAGE_RANGE,
    TORCH_LIGHT_FLOOR,
    HUNGER_EAT_THRESHOLD,
    HUNGER_MUST_EAT_THRESHOLD,
    HUNGER_FULL,
    TYPE_COORDINATES,
    TYPE_BLUEPRINT_PASTED,
    TYPE_STRUCTURE_COMPLETE,
    BUILDING_REQUIREMENTS,
    REQUESTABLE_STRUCTURES,
    STOCK_THRESHOLDS,
    REQUIREMENT_CATEGORIES,
    ACCEPTABLE_BIOMES,
    SEA_LEVEL,
    HUMAN_SURFACE_SLACK,
    HUMAN_MAX_ABOVE_SEA,
    FUEL_PREFERENCES,
    COPPER_FOR_IRON,
};
