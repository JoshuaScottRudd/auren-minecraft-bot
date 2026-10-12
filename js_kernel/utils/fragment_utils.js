
/*
fragment_utils.js (Kernel Utility Spine) — pure, stateless utilities for perception/action fragments.
No logging, signaling, emotes. Strict tool-class selection only (axe/pickaxe/shovel/shears), no registry fallback.
Sections: 1 sleep · 3 environment · 4 resource groups · 5 tool selection · 6 block name normalization ·
7 surface classification · 8 wheat stage · exports at bottom.
*/

const Vec3 = require('vec3');
// Top-level require, not per-call — no cycle (watcher pulls only fs/path + lazy foreman_link).
const watcher = require('@kernel/watcher');

// ── Core small utilities (pure, stateless) ───────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


// ── Group Normalization (pure, SINGLE SOURCE OF TRUTH) ───────────────────────────────────────────
// group_to_item is the ONLY group/variant table; edit it only, selectors adapt. groupToReference
// picks the most-held member per opts.prefer 'inventory'|'scan'|'combined' (default).

// ── PROVENANCE: two disjoint lists, "who put this block here" ────────────────────────────────────
// Natural blocks are the site-selection floor; constructed blocks govern mining/build integrity.
// Callers default by direction (Law 13): navigation → CONSTRUCTED, site selection → not floor.
const ROCK     = ['stone','deepslate','tuff','granite','diorite','andesite','calcite','dripstone_block'];
const SOIL     = ['dirt','coarse_dirt','rooted_dirt','grass_block','podzol','mycelium','clay','mud'];
const SEDIMENT = ['gravel','sand','red_sand','sandstone','red_sandstone','terracotta'];
const EXOTIC   = ['netherrack','basalt','blackstone','soul_sand','soul_soil','end_stone',
                  'ice','packed_ice','blue_ice','snow_block','obsidian','moss_block'];
// Natural terrain that burns the body standing on it — held apart from EXOTIC so no placement order can ever offer it (Law 17).
const HAZARD_NATURAL = ['magma_block'];
const MASONRY  = ['cobblestone','cobbled_deepslate','stone_bricks','bricks','mossy_cobblestone','smooth_stone'];
const PLANKS   = ['oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks',
                  'mangrove_planks','cherry_planks','bamboo_planks','crimson_planks','warped_planks'];
const TIMBER   = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log'];

// SOIL is the site-selection floor; SEDIMENT is filtered out of every PLACE order below (Law 17 — gravity).
const natural_block = [...ROCK, ...SOIL, ...SEDIMENT, ...EXOTIC, ...HAZARD_NATURAL];

// What the bot places where it builds. Ore is absent — mining digs ore from walls and reseals
// (mining_integrity D9), so an ore cell is scheduled work, not a wall.
const constructed_block = [...MASONRY, ...PLANKS, ...TIMBER];

// Gravity blocks read from their ONE definition (Law 16).
const { GRAVITY_BLOCKS } = require('@utils/gravity_utils');
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');
const _placeable = (name) => !GRAVITY_BLOCKS.has(name);

// THROWAWAY PLACEMENT ORDER, two exposures in group_to_item below. PLANKS LEAD: the plank is the fleet's
// trash block (utils/trash splits a held log into planks before a step picks). Soil and sediment stand in
// while the pocket holds no plank; a whole log goes after them; masonry/rock sit last (need a pickaxe both
// ways). The SCAFFOLD_SPENDABLE/SCAFFOLD_LAST_RESORT seam splits a shortfall with nothing queued to spend
// from one the fleet is already mining for (Law 25).
const SCAFFOLD_SPENDABLE = [...PLANKS, ...SOIL, ...SEDIMENT, ...TIMBER];
const SCAFFOLD_LAST_RESORT = [...MASONRY, ...ROCK, ...EXOTIC];
const SCAFFOLD_ORDER = [...SCAFFOLD_SPENDABLE, ...SCAFFOLD_LAST_RESORT];

const group_to_item = {
  logs: [
    'oak_log','birch_log','spruce_log','dark_oak_log','acacia_log','jungle_log',
    'stripped_oak_log','stripped_birch_log'
  ],
  planks: [
    'oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks'
  ],
  stairs: [
    'oak_stairs','birch_stairs','spruce_stairs','jungle_stairs','acacia_stairs','dark_oak_stairs'
  ],
  // Plank-derived (like stairs/door/fence), for the composter's 7-slab recipe. `slab` is not a
  // minecraft-data item on its own — craft_handler resolves it via this group (Law 13).
  slab: [
    'oak_slab','birch_slab','spruce_slab','jungle_slab','acacia_slab','dark_oak_slab'
  ],
  door: [
    'oak_door','birch_door','spruce_door','jungle_door','acacia_door','dark_oak_door'
  ],
  // ── THE REST OF THE PLANK-DERIVED FAMILY ──────────────────────────────────────────────────────
  // None of these tokens is a minecraft-data item; craft_handler's PLANK_DERIVED_GROUPS resolves
  // each to the species of the held planks. `button` is wood only — stone_button has its own recipe.
  trapdoor: [
    'oak_trapdoor','birch_trapdoor','spruce_trapdoor','jungle_trapdoor','acacia_trapdoor','dark_oak_trapdoor'
  ],
  fence_gate: [
    'oak_fence_gate','birch_fence_gate','spruce_fence_gate','jungle_fence_gate','acacia_fence_gate','dark_oak_fence_gate'
  ],
  sign: [
    'oak_sign','birch_sign','spruce_sign','jungle_sign','acacia_sign','dark_oak_sign'
  ],
  button: [
    'oak_button','birch_button','spruce_button','jungle_button','acacia_button','dark_oak_button'
  ],
  // The bark-on-all-six-sides block, not the material word: placeable, crafted from four logs.
  wood: [
    'oak_wood','birch_wood','spruce_wood','jungle_wood','acacia_wood','dark_oak_wood'
  ],
  // Natural terrain variants only; excludes cobblestone (a drop product) so scans/gathers never
  // target player-placed cobblestone.
  stone: [
    'stone','andesite','diorite','granite'
  ],
  // structural_fill — what may satisfy a blueprint wall/base voxel (Law 16): a union, since natural
  // stone in a wall cell is a finished wall. Order: cobblestone, planks, logs, natural fill last.
  structural_fill: [...MASONRY, ...PLANKS, ...TIMBER, ...SOIL, ...ROCK, ...EXOTIC, ...SEDIMENT]
    .filter(_placeable),

  // pillar_block — what a PILLAR may place; the only list admitting gravity blocks, each supported
  // by the one placed beneath it the instant it exists (Law 17).
  pillar_block: [...SCAFFOLD_ORDER],

  // scaffold_spendable — the prefix of the order, for whether the bot holds enough to get back out (Law 16).
  scaffold_spendable: [...SCAFFOLD_SPENDABLE],

  // scaffold_block — what a BRIDGE may place, gravity-filtered: a bridge block sits on air, so sand
  // or gravel would drop out mid-crossing (Law 17). Read by pathfinding's isScaffoldBlock (Law 13).
  scaffold_block: SCAFFOLD_ORDER.filter(_placeable),

  // Provenance lists exposed as groups so every caller reads them from here (Law 16); not placement tokens.
  natural_block,
  constructed_block,
  dirt: [
    'dirt','coarse_dirt','podzol', 'farmland', 'grass_block'
  ],
  // The only blocks vanilla's furnace recipe accepts as its 8-item ingredient. Index 0 = fallback.
  furnace_material: [
    'cobblestone','blackstone','cobbled_deepslate'
  ],
  // No `coals` group: coal is DISCOVERED and charcoal is MADE, so recipes name `charcoal` only,
  // and coal is counted separately via substitutes_for (`fuel`/FUEL_PREFERENCES bars charcoal).
  // Per-class tool families, LOWEST tier first. Copper sits between stone and iron (1.21.9).
  pickaxe: [
    'wooden_pickaxe','stone_pickaxe','copper_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe'
  ],
  axe: [
    'wooden_axe','stone_axe','copper_axe','iron_axe','diamond_axe','netherite_axe'
  ],
  // The digging tool — a stock row keeps one pocketed, capped at stone (architect_config max_tier).
  shovel: [
    'wooden_shovel','stone_shovel','copper_shovel','iron_shovel','diamond_shovel','netherite_shovel'
  ],
  // Weapon family, not a work tool — tool-family machinery already maintains one at best-makeable tier per family (Law 22).
  sword: [
    'wooden_sword','stone_sword','copper_sword','iron_sword','diamond_sword','netherite_sword'
  ],
  hoe: [
    'wooden_hoe','stone_hoe','copper_hoe','iron_hoe','diamond_hoe','netherite_hoe'
  ],
  // Dump-keep aggregate: dumpExcess keeps these pocketed, all else is excess (hoes absent — land_prep cycles one).
  tools: [
    'wooden_pickaxe','stone_pickaxe','copper_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe',
    'wooden_axe','stone_axe','copper_axe','iron_axe','diamond_axe','netherite_axe',
    'wooden_shovel','stone_shovel','copper_shovel','iron_shovel','diamond_shovel','netherite_shovel',
    'wooden_sword','stone_sword','copper_sword','iron_sword','diamond_sword','netherite_sword',
    'shears','flint_and_steel','fishing_rod','shield','bow','crossbow'
  ],
  // Any fence variant satisfies a blueprint 'fence' voxel; resolved like 'planks' by building_integrity/placeOne.
  fence: [
    'oak_fence','spruce_fence','birch_fence','jungle_fence','acacia_fence','dark_oak_fence',
    'mangrove_fence','cherry_fence','bamboo_fence','crimson_fence','warped_fence'
  ],
  food: [
    'apple','bread','cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton',
    'cooked_rabbit','cooked_salmon','cooked_cod','baked_potato','golden_apple',
    'beetroot','carrot','melon_slice','sweet_berries','dried_kelp'
  ],
  saplings: [
    'oak_sapling','birch_sapling','spruce_sapling','dark_oak_sapling','acacia_sapling','jungle_sapling'
  ]
};

// ── GROUND_FILL_VOXEL_TYPES — the voxel types a FLAT LOT ALREADY SATISFIES ───────────────────────
// A blueprint cell declaring one of these names a requirement, never a manufactured block — the
// cell is finished the moment the site is chosen. Draws the carpentry-versus-ground split so every
// reader of build progress draws it the same way (Law 16).
const GROUND_FILL_VOXEL_TYPES = new Set([
    'structural_fill',   // the STRUCTURAL token — natural stone already standing in a wall is a finished wall
    'natural_block',     // the ground itself
    'dirt',              // the same requirement under a concrete name
]);

// ── GATHERED_GROUPS — GROUP TOKENS THE WORLD ITSELF SUPPLIES, SO NO RECIPE IS FILED FOR THEM ─────
// `recipeForToken` resolves a group via whichever member has a recipe, which misanswers `natural_block`
// (`stone` is a furnace product); naming the token here makes the book answer with no recipe, routing to
// a gather. Membership is narrower than any-member-lacks-a-recipe: `pickaxe` has recipe-less tiers that
// are not gatherable, and `structural_fill` routes through `underground_items`.
const GATHERED_GROUPS = new Set([
    'natural_block',
]);

// ── STONE_PROSPECT_ITEMS — the stone a bot fetches for itself, one column at a time ──────────────
// Not in underground_items: cobblestone has its own producer, stone_prospect_executor.
// `furnace_material` is here too since the furnace recipe asks for that token, not `cobblestone` directly.
const stone_prospect_items = new Set([
    'cobblestone', 'furnace_material',
]);

// isUnderground(item) / isProspected(item) — the question every routing site asks, per species. A
// species mining its stone (architect_config.STONE_SOURCE) moves prospect items underground.
function _stoneIsMined() {
  const source = require('@thinking/architect_config').STONE_SOURCE[require('@kernel/bot_mandate').currentMode()];
  if (source === 'mine_after_furnace') return require('@perception/station_registry').getStationTypes().has('furnace');
  return source === 'mine';
}
function isUnderground(item) { return underground_items.has(item) || (stone_prospect_items.has(item) && _stoneIsMined()); }
function isProspected(item) { return stone_prospect_items.has(item) && !_stoneIsMined(); }

// ── UNDERGROUND_ITEMS — materials the surface can never provide ──────────────────────────────────
// The single classification; building_planner and resource_planner both import it (Law 16). Ore
// family covers every pipeline stage (ore → raw drop → ingot). Membership is a claim that no
// reachable producer exists; a material that gets one (as cobblestone did) must leave this set.
const underground_items = new Set([
    // Stone family; `stone`/`smooth_stone`/`stone_bricks` are absent — each has a producer.
    'bricks', 'mossy_cobblestone',
    'andesite', 'diorite', 'granite', 'structural_fill',
    'blackstone', 'cobbled_deepslate',
    // Ores / raw drops / ingots
    'iron_ore', 'deepslate_iron_ore', 'raw_iron', 'iron_ingot',
    'coal', 'coal_ore', 'deepslate_coal_ore',
    'copper_ore', 'deepslate_copper_ore', 'raw_copper', 'copper_ingot',
    'gold_ore', 'deepslate_gold_ore', 'raw_gold', 'gold_ingot',
    'redstone', 'redstone_ore', 'deepslate_redstone_ore',
    'lapis_lazuli', 'lapis_ore', 'deepslate_lapis_ore',
    'diamond', 'diamond_ore', 'deepslate_diamond_ore',
    'emerald', 'emerald_ore', 'deepslate_emerald_ore',
]);

// ── FARM_ITEMS — crops that exist ONLY because the farm chain grew them ──────────────────────────
// Sibling of underground_items. Never give wheat a furnace recipe — the farm is its furnace.
const farm_items = new Set([
    'wheat',
]);

// ── FURNACE_CHAIN_ITEMS — what only the smelter can produce ──────────────────────────────────────
// Fourth sibling of the naming-the-door sets (prospect / farm / hunt): gates hold an order until
// the furnace delivers. Concrete items only — what the smelter is the ONLY route to. `stone` and
// `smooth_stone` are here because digging stone drops cobblestone; `glass`, `brick` and `terracotta`
// because a downloaded building's bill names them (sand, clay_ball and clay smelted).
const furnace_chain_items = new Set([
    'charcoal',
    'stone',
    'smooth_stone',
    'glass',
    'brick',
    'terracotta',
]);

// ── SUBSTITUTES_FOR — counted as stock, never ordered ────────────────────────────────────────────
// Coal and charcoal are interchangeable at the moment of USE, not ACQUISITION: stock of any VALUE
// answers a shortfall of KEY, but the shortfall is still ordered as KEY. Coal shrinks a charcoal
// order and is never itself ordered, gathered or gated (Law 16).
const substitutes_for = { charcoal: ['coal'] };

// ── HUNT_ITEMS — materials off a LIVING thing; no block scan can find them ───────────────────────
// Third sibling on the surface-punch-must-never-dispatch axis (shaft/field/hunt).
// string — hostile drop, collected via battle_stations into a chest.
// bone — skeleton drop, consumed by bone_meal; marks its shortfall as a gather leaf.
// Stops build_material_calculator's decomposition walk at a craftable whose leaf is a mob drop.
const hunt_items = new Set([
    'string',
    'bone',
]);

// item → group reverse table intentionally omitted (see SINGLE SOURCE OF TRUTH above).

/**
 * groupToReference(group, opts?) → { item, count, counts, source, fallback } | null
 * Most-held group member from evidence; ties break by group order; all-zero → index 0 with
 * fallback:true. opts: inventory (Mineflayer inventory or [{name,count}]), scanList ([{name}], each
 * occurrence = 1), scanCounts ({name:count}), prefer 'inventory'|'scan'|'combined' (default).
 */
function groupToReference(group, opts = {}){
  if(!group || typeof group !== 'string') return null;
  const members = group_to_item[group];
  if(!Array.isArray(members) || members.length === 0) return null;

  const prefer = opts.prefer || 'combined';
  const counts = Object.create(null);
  for(const m of members) counts[m] = 0;

  if(opts.inventory){
    const invItems = Array.isArray(opts.inventory.items) ? opts.inventory.items() : (Array.isArray(opts.inventory) ? opts.inventory : []);
    for(const it of invItems){
      if(it && counts.hasOwnProperty(it.name)) counts[it.name] += (it.count || 1);
    }
  }
  const invSnapshot = members.reduce((o,m)=>{ o[m]=counts[m]; return o; }, {});

  if(prefer === 'scan'){
    for(const m of members) counts[m] = 0;
  }

  if(opts.scanList){
    for(const blk of opts.scanList){
      const name = blk && blk.name;
      if(name && counts.hasOwnProperty(name)) counts[name] += 1;
    }
  }
  if(opts.scanCounts){
    for(const [name, c] of Object.entries(opts.scanCounts)){
      if(counts.hasOwnProperty(name)) counts[name] += c;
    }
  }
  const scanSnapshot = members.reduce((o,m)=>{ o[m]= (prefer==='scan'? counts[m] : ( (opts.scanList||opts.scanCounts)? (counts[m]-invSnapshot[m]) : 0)); return o; }, {});

  if(prefer === 'inventory'){
    for(const m of members) counts[m] = invSnapshot[m];
  }

  let best = members[0];
  let bestCount = counts[best];
  for(const m of members){
    const c = counts[m];
    if(c > bestCount){ best = m; bestCount = c; }
  }
  const source = (bestCount > 0)
    ? (counts[best] === invSnapshot[best] && scanSnapshot[best] === 0 ? 'inventory'
      : (counts[best] === scanSnapshot[best] && invSnapshot[best] === 0 ? 'scan' : 'combined'))
    : 'fallback';

  return { item: best, count: bestCount, counts, source, fallback: bestCount===0 };
}

// Expose all items for a group (avoids fragments rebuilding the mapping)
function groupToAllItems(group){
  const list = group_to_item[group];
  return Array.isArray(list) ? list.slice() : [];
}

// ── Environment queries ──────────────────────────────────────────────────────────────────────────
// isWalkableSurface, isNotSafeSurface, getClearance, classifyFloor are in @utils/movement/terrain_predicates.

// BLOCK_REACH — the single shared interaction distance (placement, digging, chest interaction, LOS).
const BLOCK_REACH = 4.5;

// No station-use distance constant here: the stance for opening a station is the blueprint's
// anchor (`locomotion.goToStationStance`), not a radius that could pick a cell outside the building (Law 16).

// True iff blockPos (and nothing closer) is the first thing the raycast hits — shared by
// build_executor (placement) and block_puncher (obstruction detection).
function hasLineOfSightToBlock(bot, blockPos, maxDist) {
  const eye = bot.entity.position.offset(0, (bot.entity.height || 1.62) * 0.9, 0);
  const target = new Vec3(blockPos.x + 0.5, blockPos.y + 0.5, blockPos.z + 0.5);
  const dir = target.minus(eye);
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (len === 0) return true;
  const norm = new Vec3(dir.x / len, dir.y / len, dir.z / len);
  // Only the raycast is a boundary — our own arithmetic above must throw, not be read as "allow it".
  const cast = guardExternalSync('fragment_utils', `raycast LOS to (${blockPos.x},${blockPos.y},${blockPos.z})`,
    () => bot.world.raycast(eye, norm, Math.min(maxDist + 1, 8)));
  if (!cast.ok) return true;   // no ray was traced — the caller's own reach checks stay in force
  const hit = cast.value;
  if (!hit) return false;
  return hit.position.x === blockPos.x && hit.position.y === blockPos.y && hit.position.z === blockPos.z;
}

// ── Tool selection helpers (shared across mining/navigation fragments) ───────────────────────────
const TOOL_TIER_PRIORITY = ['netherite','diamond','iron','copper','stone','wood','gold'];
const TOOL_CLASS_KEYWORDS = ['pickaxe','axe','shovel','hoe','shears'];

function classifyTool(itemName){
  if(!itemName) return null;
  for(const cls of TOOL_CLASS_KEYWORDS){ if(itemName.includes(cls)) return cls; }
  return null;
}

function tierIndex(name){
  if(!name) return TOOL_TIER_PRIORITY.length;
  const idx = TOOL_TIER_PRIORITY.findIndex(t => name.includes(t));
  return idx === -1 ? TOOL_TIER_PRIORITY.length : idx;
}

// Tool class is read from the game (block.material), never guessed from the block's name — no
// station is named for what it is made of, so a name regex misses many and unequips to bare hands
// against pickaxe-gated blocks (Law 26). A tier-gated block with no `mineable/` marker resolves to
// pickaxe; overrides are checked first so cobweb's sword/shears harvestTools isn't misread by that.
// leaves/wool/cobweb override to shears, which drops the block, overriding the data's hoe/none reading (Law 16).
const MATERIAL_TOOL_OVERRIDES = Object.freeze({ leaves: 'shears', wool: 'shears', coweb: 'shears' });

function heuristicPreferredClass(block){
  if(!block || !block.material) return null;
  // Materials compose with ';' (`leaves;mineable/hoe`); overrides are checked across all parts first.
  const parts = String(block.material).split(';');
  for(const p of parts){ if(MATERIAL_TOOL_OVERRIDES[p]) return MATERIAL_TOOL_OVERRIDES[p]; }
  for(const p of parts){
    const m = /^mineable\/(\w+)$/.exec(p);
    if(m) return m[1];
  }
  if(block.harvestTools) return 'pickaxe';   // every tier-gated block resolves to pickaxe here
  return null;
}

// Can this tool actually harvest (drop) the block? harvestTools = {itemId:true} for tier-gated
// blocks; undefined = any tool. Wooden pickaxe on iron ore mines air, which "lowest tier first" must respect.
function _canHarvest(block, item){
  if(!block) return false;
  const ht = block.harvestTools;
  if(!ht) return true;                 // no tier requirement — any tool drops it
  return item != null && !!ht[item.type];
}

function getBestToolForBlock(bot, block){
  if(!bot || !block || !bot.inventory) return null;
  const prefClass = heuristicPreferredClass(block);
  const bName = block.name || 'unknown_block';
  if(!prefClass) return null; // unclassified -> hand
  const tools = bot.inventory.items().filter(i => classifyTool(i.name) === prefClass);
  if(tools.length === 0){
    return null;
  }
  // Consume lowest tier first, more-worn within a tier. Among tools that can harvest, lowest
  // adequate tier; if none is adequate, the highest tier is used, not bare hands.
  const byLowestTierMostWorn = (a,b)=> {
    const t = tierIndex(b.name) - tierIndex(a.name);   // higher tierIndex = lower tier → first
    if(t !== 0) return t;
    return (b.durabilityUsed || 0) - (a.durabilityUsed || 0);
  };
  const adequate = tools.filter(i => _canHarvest(block, i));
  if(adequate.length > 0){
    adequate.sort(byLowestTierMostWorn);
    return adequate[0];
  }
  tools.sort((a,b)=> {
    const t = tierIndex(a.name) - tierIndex(b.name);   // lower tierIndex = higher tier → first
    if(t !== 0) return t;
    return (b.durabilityUsed || 0) - (a.durabilityUsed || 0);
  });
  return tools[0];
}

// No outer catch here — that would wrap our own code, so a classification bug would silently
// become "no tool available" instead of throwing (Law 13). Only the two mineflayer calls are guarded.
async function equipBestToolForBlock(bot, block, scope='tool_helper'){
  const best = getBestToolForBlock(bot, block);
  if(!best){
    await guardExternal(scope, 'unequip before a bare-handed dig', () => bot.unequip('hand'));
    return null;
  }
  if(bot.heldItem && bot.heldItem.name === best.name) return best;
  if(!(await guardExternal(scope, `equip ${best.name}`, () => bot.equip(best, 'hand'))).ok) return null;
  return best;
}

// ── 6. Block Name Normalization ──────────────────────────────────────────────────────────────────
// Minecraft renames some blocks by placement surface (wall torch vs torch). Maps world-reported
// name → canonical blueprint token; use on bot.blockAt() results, not on already-canonical tokens.

const BLOCK_NAME_ALIASES = {
  wall_torch: 'torch',
  soul_wall_torch: 'soul_torch',
  redstone_wall_torch: 'redstone_torch',
};

function normalizeBlockName(name) {
  return BLOCK_NAME_ALIASES[name] || name;
}

// ── 7. Block Surface Classification ──────────────────────────────────────────────────────────────

// STATION_TYPES — the one definition of what counts as a station (Law 16): never dig one, always price
// a detour around one, registration/validation, the voxel reader's STATION flag.
// Full-cube stations (furnace, crafting table) sit alongside partials like the chest.
const STATION_TYPES = new Set([
  'chest', 'trapped_chest', 'barrel',
  'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'hopper',
  'brewing_stand', 'anvil', 'stonecutter',
  'enchanting_table', 'lectern', 'grindstone',
  'cartography_table', 'loom', 'bell',
  'composter',
  'smithing_table', 'fletching_table',
  'dispenser', 'dropper',
]);

// No station→tool completeness check is needed: `heuristicPreferredClass` reads each block's own
// `material`, so a station added above is classified on arrival (Law 27).

// WINDOWLESS_STATIONS — stations with no inventory window; the registration path cannot see them
// and must not try, or build_executor digs one up as a mis-placement (a composter publishes fill
// 0–8 as blockstate instead — Invariant B).
const WINDOWLESS_STATIONS = new Set([
  'composter',
]);

// NON_FULL_BLOCK_NAMES — non-full-cube blocks SAFE for movement primitives to dig. Stations excluded — see STATION_TYPES.
const NON_FULL_BLOCK_NAMES = new Set([
  'leaf_litter',
  'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush',
  'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower', 'pitcher_plant',
  'brown_mushroom', 'red_mushroom',
  'sugar_cane', 'bamboo', 'vine', 'lily_pad',
  'sweet_berry_bush', 'cobweb', 'snow',
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
  'redstone_torch', 'redstone_wall_torch',
  'lantern', 'soul_lantern', 'copper_lantern',
  'lever', 'tripwire', 'tripwire_hook', 'redstone_wire',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'flower_pot',
]);

// ── PUNCH-THROUGH DEBRIS ──────────────────────────────────────────────────────────────────────────
// Movement primitives (pillarStep etc.) punch through natural one-hit debris so a pillar attempt does
// not fail on it — a property test below, not a name list. Excludes light, crops and wiring/
// stations a punch would wrongly destroy (each is somebody's placed state).
const PUNCH_THROUGH_KEEP = new Set([
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
  'lantern', 'soul_lantern', 'copper_lantern',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem',
  'attached_melon_stem', 'attached_pumpkin_stem', 'torchflower_crop', 'pitcher_crop', 'nether_wart',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'lever', 'tripwire', 'tripwire_hook', 'redstone_wire', 'repeater', 'comparator',
  'flower_pot', 'end_rod', 'chain', 'iron_chain', 'copper_chain',
]);

// Takes the BLOCK, not its name — a name goes stale. hardness 0 = one bare-handed punch.
function isPunchThroughDebris(block) {
  if (!block || !block.name) return false;
  if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return false;
  if (block.boundingBox !== 'empty') return false;
  if (block.hardness !== 0) return false;          // undefined hardness fails this too — unknown is not zero
  if (block.diggable === false) return false;
  if (PUNCH_THROUGH_KEEP.has(block.name)) return false;
  if (STATION_TYPES.has(block.name)) return false;
  return true;
}

// True for any non-full-cube block (diggable or station) — the full classification regardless of dig safety.
function isNonFullBlock(name) {
  if (!name) return true;
  if (NON_FULL_BLOCK_NAMES.has(name)) return true;
  if (STATION_TYPES.has(name)) return true;
  if (/_stairs$/.test(name)) return true;
  if (/_slab$/.test(name)) return true;
  if (/_door$/.test(name)) return true;
  if (/_trapdoor$/.test(name)) return true;
  if (/_fence$/.test(name)) return true;
  if (/_fence_gate$/.test(name)) return true;
  if (/_wall$/.test(name)) return true;
  if (/_button$/.test(name)) return true;
  if (/_pressure_plate$/.test(name)) return true;
  if (/_carpet$/.test(name)) return true;
  if (/_sign$/.test(name)) return true;
  if (/_wall_sign$/.test(name)) return true;
  if (/_hanging_sign$/.test(name)) return true;
  if (/_banner$/.test(name)) return true;
  if (/_sapling$/.test(name)) return true;
  if (/_candle$/.test(name)) return true;
  if (/_bed$/.test(name)) return true;
  if (/_head$/.test(name)) return true;
  if (/_skull$/.test(name)) return true;
  return false;
}

// Flat { item_name: count } from the live bot. Direct perception call (Law 1 exception).
function getBotInventory() {
  const bot = global.bot;
  if (!bot) return {};
  const inv = {};
  for (const item of bot.inventory.items()) {
    inv[item.name] = (inv[item.name] || 0) + item.count;
  }
  return inv;
}

// ── Material accounting primitives (pocket + chest counting) ─────────────────────────────────────
// One shared counter family (Law 16). normalizeItemName is the ITEM canonicalizer (namespace
// strip); block-face renames are normalizeBlockName's separate concern.

function normalizeItemName(name) {
  return String(name || '').replace('minecraft:', '').toLowerCase().trim();
}

// { normName: count } for ONE station's items array — caller decides which stations to include.
function chestItemCounts(station) {
  const counts = {};
  if (!station || !Array.isArray(station.items)) return counts;
  for (const it of station.items) {
    if (!it || !it.name || !(it.count > 0)) continue;
    const n = normalizeItemName(it.name);
    counts[n] = (counts[n] || 0) + it.count;
  }
  return counts;
}

// Pocket plus every registered chest — the single definition of "everything the fleet can reach
// right now"; farming and tree-farm integrity gate material needs on it.
function accessibleMaterialPool() {
  const pool = {};
  const add = (name, count) => {
    if (!name || !count) return;
    const n = normalizeItemName(name);
    pool[n] = (pool[n] || 0) + count;
  };
  for (const [name, count] of Object.entries(getBotInventory() || {})) add(name, count);
  const stationRegistry = require('@perception/station_registry');
  for (const e of Object.values(stationRegistry.getStations() || {})) {
    if (!stationRegistry.isStorage(e) || !Array.isArray(e.items)) continue;
    for (const it of e.items) if (it) add(it.name, it.count);
  }
  return pool;
}

// True iff a registered headframe chest exists — the gate farming/tree-farm integrity check before posting a job.
function hasHomeChest() {
  const stationRegistry = require('@perception/station_registry');
  return Object.values(stationRegistry.getStations() || {}).some(s =>
    stationRegistry.isStorage(s) && s.blueprint === require('@kernel/bot_mandate').homeBlueprint());
}

// homeChest — this crew's own chest as { id, station } | null. The shared build-material pool
// every build posts to and withdraws from; blueprint name comes from the mandate (Law 16).
function homeChest() {
  const stationRegistry = require('@perception/station_registry');
  const home = require('@kernel/bot_mandate').homeBlueprint();
  for (const [id, s] of Object.entries(stationRegistry.getStations() || {})) {
    if (stationRegistry.isStorage(s) && s.blueprint === home) return { id, station: s };
  }
  return null;
}

// The chests a build's material pool draws from: every chest of this blueprint plus the headframe
// chest (shared base pool) — the one definition of the build pool's chest side (Law 16).
function buildPoolChests(blueprint) {
  const stationRegistry = require('@perception/station_registry');
  const out = [];
  const seen = new Set();
  for (const [id, s] of Object.entries(stationRegistry.getStations() || {})) {
    if (!stationRegistry.isStorage(s)) continue;
    const isOwn = s.blueprint === blueprint;
    // Every headframe chest is in the pool (the crew's alpha structure).
    const isPool = s.blueprint === require('@kernel/bot_mandate').homeBlueprint();
    if ((!isOwn && !isPool) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, station: s });
  }
  return out;
}

// Chest side of the one-pool credit; callers add the bot's pocket for the full pool.
function buildPoolChestCounts(blueprint) {
  const counts = {};
  for (const { station } of buildPoolChests(blueprint)) {
    for (const [n, c] of Object.entries(chestItemCounts(station))) counts[n] = (counts[n] || 0) + c;
  }
  return counts;
}

// The locked {x,y,z} transpose origin for a blueprint, or null before set_buildspot locks one — the
// single reader of where a build is sited (Law 16).
function readTransposeOrigin(blueprintName) {
  const hq = require('@kernel/corporate_headquarters');
  const spot = hq.readBuildingChair(blueprintName, 'set_buildspot');
  return (spot?.transpose_origin && typeof spot.transpose_origin.x === 'number') ? spot.transpose_origin : null;
}

// Inflated XZ boxes no opportunistic gathering may dig inside, built on
// find_buildingspot.getExistingFootprints (Law 16).
function harvestKeepoutBoxes(radius) {
  const { getExistingFootprints } = require('@action/find_buildingspot');
  return getExistingFootprints(radius);
}

// The one gate for "do not harvest here" — gathering is opportunistic and terrain-blind, and near a
// riverbank base the densest free dirt is the farm itself. Y ignored on purpose: boxes are XZ, a 2-D question.
function isInsideBlueprintKeepout(pos, boxes) {
  if (!boxes || !boxes.length) return false;
  for (const b of boxes) {
    if (pos.x >= b.minX && pos.x <= b.maxX && pos.z >= b.minZ && pos.z <= b.maxZ) return true;
  }
  return false;
}

// ── 8. Crop Growth Stage Classification ──────────────────────────────────────────────────────────
// Wheat only — other crops are rare finds, not deterministic to plan around. Growth lives in the
// "age" blockstate (0-7), 7 = mature/harvestable.

// Age of a WHEAT block, or null. The name check matters: without it, the metadata fallback would
// read a carrot/potato at age 7 as ripe wheat (Law 16).
function getWheatAge(block) {
  if (!block || block.name !== 'wheat') return null;
  if (typeof block.getProperties === 'function') {
    const props = guardExternalSync('fragment_utils', 'block.getProperties() for wheat age', () => block.getProperties());
    if (props.ok && props.value && props.value.age !== undefined) return parseInt(props.value.age, 10);
  }
  // A plain property read on an object we already hold — nothing to guard.
  if (typeof block.metadata === 'number') return block.metadata;
  return null;
}

// isWheatMature — the harvest-ready stage. Every other age (0-6) is "planted".
function isWheatMature(block) {
  return getWheatAge(block) === 7;
}

// The two stages the farming loop distinguishes: 'growing' (planted) and 'harvest' (ripe). Not a
// group_to_item entry — wheat is one name whose stage is blockstate, which a name list can't separate.
const crop_growth_stage = {
  growing: {
    block: 'wheat',
    isStage: (b) => { const a = getWheatAge(b); return a !== null && a < 7; },
  },
  harvest: {
    block: 'wheat',
    isStage: isWheatMature,
  },
};

// ── Exports ──────────────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Core utils
  sleep,
  // Environment / perception helpers
  hasLineOfSightToBlock,
  // Group / inventory helpers
  groupToReference, groupToAllItems, group_to_item, GROUND_FILL_VOXEL_TYPES, GATHERED_GROUPS, underground_items, stone_prospect_items, isUnderground, isProspected, stoneIsMined: _stoneIsMined, furnace_chain_items, substitutes_for, farm_items, hunt_items,
  getBotInventory,
  // Material accounting primitives (pocket + chest counting)
  normalizeItemName, chestItemCounts, accessibleMaterialPool, hasHomeChest,
  homeChest, buildPoolChests, buildPoolChestCounts, readTransposeOrigin,
  harvestKeepoutBoxes, isInsideBlueprintKeepout,
  // Tool selection
  getBestToolForBlock, equipBestToolForBlock,
  // Block name normalization
  normalizeBlockName, BLOCK_NAME_ALIASES,
  // Block surface classification
  isNonFullBlock, NON_FULL_BLOCK_NAMES, STATION_TYPES, WINDOWLESS_STATIONS, isPunchThroughDebris, PUNCH_THROUGH_KEEP,
  // Crop growth stage classification
  getWheatAge, isWheatMature, crop_growth_stage,
  // Shared constants
  BLOCK_REACH,

};
