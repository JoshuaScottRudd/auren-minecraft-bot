/*
build_material_calculator.js — a build's material need, walked back to raw and netted against the bag.

Pure and stateless. Recipes come from @kernel/crafting_blueprint_registry, the one route to
crafting_blueprints.json (boot snapshot, drift-warned, never a live read).
*/

'use strict';

const { countInInventory } = require('@utils/calculators/inventory_calculator');

const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const { hunt_items, farm_items, furnace_chain_items, group_to_item } = require('@utils/fragment_utils');

// Absence from the recipe book IS the definition of raw — there is no separate raw-material list to keep
// in sync with it.
function isRawMaterial(token) {
  return !craftingRegistry.tryGetRecipe(token);
}

// isChainOwned — a material that HAS a recipe but which the asking bot cannot produce, because another
// chain is its only real source. To any walk below, such an item is a LEAF: the answer to "what must I
// obtain" is the item itself, never its ingredients.
//
// WHY the recipe book alone cannot answer this: some materials (e.g. string) have no gather path — they
// drop off hostiles rather than being minable/farmable — so a walk that decomposes past such a craft
// posts an order for the raw token, supply_manager finds no recipe and no chest stock, and
// harvest_executor scans the surface for a block that cannot exist.
//
// THE FURNACE IS THE SAME SHAPE AND FAILS WORSE. Smelting is not crafting: it is asynchronous and
// happens at a station the fulfiller may not be standing at, so no step a fulfiller can take converts
// the input into the output. Walking THROUGH a smelt therefore produces an answer no step can act on —
// an order for torches dissolves into logs, the bot gathers logs, and it is no closer than before while
// the charcoal it actually needs sits in a chest unasked-for. Stopping at the smelt output makes the
// walk honest: the fulfiller withdraws it if the fleet has it, and otherwise reports it short, which is
// what raises the smelt order that produces it. The chain still reaches logs — one link further along,
// posted by whoever owns that link.
//
// The predicate is the same union supply_manager's _isChainProduct names, so the build gate and the
// supply cascade cannot disagree about who owns a material (Law 16). Three chains are named as sets
// (hunt, farm, the furnace's group tokens); the fourth clause is derived from the recipe book itself, so
// a smelt added later is covered without an edit here.
function isChainOwned(token) {
  if (hunt_items.has(token) || farm_items.has(token) || furnace_chain_items.has(token)) return true;
  const recipe = craftingRegistry.tryGetRecipe(token);
  return !!(recipe && Array.isArray(recipe.requires) && recipe.requires.includes('furnace'));
}

// blueprintToRawMaterials(materialsNeeded) → { rawItem: count }. Partial batches round UP, so a need of
// 6 planks costs 2 logs and wastes 2 — under-rounding would greenlight a build that stalls mid-place.
function blueprintToRawMaterials(materialsNeeded) {
  if (!materialsNeeded || typeof materialsNeeded !== 'object') return {};

  const rawTotals = {};

  for (const [item, count] of Object.entries(materialsNeeded)) {
    if (typeof count !== 'number' || count <= 0) continue;
    const decomposed = decomposeToRaw(item, count);
    for (const [raw, rawCount] of Object.entries(decomposed)) {
      rawTotals[raw] = (rawTotals[raw] || 0) + rawCount;
    }
  }

  return rawTotals;
}

// The depth limit guards a CIRCULAR recipe definition, which is a data bug rather than a legal input —
// it bottoms out returning the item undecomposed rather than throwing, so one bad recipe cannot take
// down every build gate that calls this.
function decomposeToRaw(item, quantity, depth = 0) {
  if (depth > 10) return { [item]: quantity };

  const recipe = craftingRegistry.tryGetRecipe(item);
  if (!recipe || !recipe.ingredients || isChainOwned(item)) {
    return { [item]: quantity };
  }

  const makes = recipe.sequence && recipe.sequence.length > 0
    ? recipe.sequence[recipe.sequence.length - 1].makes || 1
    : 1;

  // How many batches of this recipe do we need to produce `quantity` items?
  const batches = Math.ceil(quantity / makes);

  const rawTotals = {};
  for (const [ingredient, ingredientCount] of Object.entries(recipe.ingredients)) {
    const totalIngredient = ingredientCount * batches;
    const decomposed = decomposeToRaw(ingredient, totalIngredient, depth + 1);
    for (const [raw, rawCount] of Object.entries(decomposed)) {
      rawTotals[raw] = (rawTotals[raw] || 0) + rawCount;
    }
  }

  return rawTotals;
}

// remainingRawForBuild(materialsNeeded, invCounts) → { rawItem: countStillNeeded }
//
// The raw materials still to OBTAIN to build `materialsNeeded`, given what the bot
// already holds. Decompose the whole need to raw, check each raw independently against
// inventory, with ONE correction: held intermediates (planks/sticks) are credited
// against their OWN block need at the item level FIRST, then the still-missing blocks
// are decomposed to raw. That lets "40 logs + 32 planks" satisfy a build that needs
// those planks, without pretending held planks can fill a raw LOG-block voxel.
//
// WHY item-level netting rather than decomposing everything to one raw `logs` bucket
// and subtracting a held-plank→log conversion credit from it: a build can need BOTH
// placed planks and placed logs from the same recipe tree, so a single combined bucket
// mixes plank-sourced logs with direct-log-block logs. Crediting held planks against
// that combined bucket is wrong on two counts — a held plank can never BECOME a placed
// log, and a per-conversion ceil() rounding applied to a mixed bucket over-credits
// rather than rounding each requirement separately. Netting each intermediate 1:1
// against its own block count before decomposition avoids both: a held plank offsets
// exactly one plank block and is never subtracted from a raw log need.
//
// The wood intermediates are netted UNCONDITIONALLY — they are the case this started as, and they are
// netted despite being group tokens because a held plank offsetting a plank block is the one overlap
// whose direction is known safe. Every other token earns item-level netting only by passing the
// exclusivity test in `_itemLevelNettable` below; the reasoning for both halves lives there.
const NET_INTERMEDIATES = new Set(['planks', 'stick']);

// A FINISHED ITEM ON HAND IS THE FIRST RUNG OF THE LADDER, AND THE BUILD USED TO SKIP IT.
//
// Every other asker in the fleet asks the same three questions in the same order: is it available,
// can it be crafted, must it be gathered. A stock row measures the FINISHED good and hands the deficit to
// supply_manager, which then runs chest → craft → gather. The build alone decomposed everything to raw
// first, so a furnace already in the pool could not answer a furnace-shaped hole: the walk went straight
// past it to `furnace_material: 8` and bought a whole prospect shaft's worth of cobblestone to make a
// second one. That is not a different policy, it is the first rung missing — the same divergence that
// makes the three request systems read as three systems instead of one (Law 16).
//
// WHY THE SET IS COMPUTED PER BUILD RATHER THAN LISTED. A hardcoded roster of "finished items" is the
// legacy shape this replaces: it ages the day a blueprint uses a material nobody listed, and it reports
// a correct-looking order the whole time it is wrong. The rule is derived from the requirement set in
// front of it, so a new material is covered the moment a blueprint asks for one.
//
// THE OVERLAP GUARD IS THE LOAD-BEARING PART, and it is why this cannot simply net everything. Group
// tokens share concrete members — `structural_fill` accepts planks AND logs — so crediting a held item
// against two tokens that both accept it spends the same block twice and greenlights a build that then
// stalls mid-place. Three exclusions, each for its own reason:
//   - a GROUP token: it is a set, so another token can overlap it; the raw walk handles it as before.
//   - a RAW token: the raw walk below already checks it against the pool, so netting it here would be
//     the same credit taken twice.
//   - a token another requirement can also be satisfied by: the double-spend above, detected rather
//     than assumed.
// What survives is a concrete, craftable material that exactly one requirement in this build can use —
// where "I already have one" is unambiguous.
function _itemLevelNettable(materialsNeeded) {
  const tokens = Object.keys(materialsNeeded);
  const claimants = new Map();   // concrete item → how many of this build's tokens accept it
  for (const token of tokens) {
    for (const member of (group_to_item[token] || [token])) {
      claimants.set(member, (claimants.get(member) || 0) + 1);
    }
  }
  const nettable = new Set(NET_INTERMEDIATES);
  for (const token of tokens) {
    if (nettable.has(token)) continue;
    if (group_to_item[token]) continue;
    if (isRawMaterial(token)) continue;
    if ((claimants.get(token) || 0) > 1) continue;
    nettable.add(token);
  }
  return nettable;
}

function remainingRawForBuild(materialsNeeded, invCounts) {
  if (!materialsNeeded || typeof materialsNeeded !== 'object') return {};
  const inv = invCounts || {};
  const nettable = _itemLevelNettable(materialsNeeded);

  // Credit held intermediates and finished goods against their own block need before decomposing.
  const net = {};
  for (const [item, count] of Object.entries(materialsNeeded)) {
    if (typeof count !== 'number' || count <= 0) continue;
    if (nettable.has(item)) {
      const still = Math.max(0, count - countInInventory(item, inv));
      if (still > 0) net[item] = still;
    } else {
      net[item] = count;   // decomposed & checked against full inventory independently
    }
  }

  const rawNeeded = blueprintToRawMaterials(net);
  const result = {};
  for (const [raw, count] of Object.entries(rawNeeded)) {
    const have = countInInventory(raw, inv);
    if (count - have > 0) result[raw] = count - have;
  }
  return result;
}

// craftShortfall(item, quantity, poolCounts, reservedOfItem) → { rootItem: countStillNeeded }
//
// "Walk this order back the way the fulfiller will, spending what is on hand at EVERY level, and return
// only what would still have to be obtained from the world." An empty result means the order can be
// finished from stock alone; a non-empty one names exactly what the fulfiller will go outside (or
// underground) for, so a caller can decide whether that route is open right now.
//
// THE BUDGET IS THE WHOLE POINT, and its absence is a live defect this replaces. A walk that tests each
// ingredient independently against the FULL pool lets siblings spend the same units twice: a wooden
// pickaxe is 3 planks plus 2 sticks, sticks are made FROM planks, so its true cost is 5 planks — but two
// independent tests ask "4 >= 3?" and "4 >= 2?" and both say yes. Such a walk's real predicate is "does
// the largest single branch fit", not "does the recipe fit", and every order it clears on a
// half-affordable pool is dispatched, half-completed, and re-posted unchanged until a judge kills it.
// One mutable budget threaded through the recursion is the fix, because it is the only version of this
// walk that models the thing that actually happens: crafting the sticks SPENDS the planks.
//
// ALLOCATION IS GREEDY, in recipe-declaration order, and the direction of that error is the safe one. A
// branch taken early may consume a shared root a later branch had no substitute for, producing a
// shortfall a cleverer allocator would not — a false HOLD, never a false CLEAR (Law 13 default-stopped).
// A solver is not warranted: no live recipe has two branches competing for one scarce root.
//
// DISTINCT FROM remainingRawForBuild ABOVE, which must NOT be reused here. That one answers a question
// about PLACED VOXELS, where a held plank can never become a placed log and crediting it across the tree
// would greenlight an impossible build — so it nets intermediates only against their own block need. In a
// CRAFT chain the opposite is true: a held plank genuinely does become a stick, and refusing to credit it
// holds orders the pool can fill. Same recursion, opposite netting rule, because the two callers mean
// different things by "have it". Merging them breaks whichever one loses.
const CRAFT_WALK_MAX_DEPTH = 10;   // circular-recipe guard, same bound and reason as decomposeToRaw
function craftShortfall(item, quantity, poolCounts, reservedOfItem = 0) {
  const budget = { ...(poolCounts || {}) };
  // Units of the ordered item already staged at the destination sit in the pool but are spoken for.
  // Counting them as spendable stock reports an order affordable that has nothing left to build with.
  if (reservedOfItem > 0) debitFromBudget(budget, item, reservedOfItem);
  const shortfall = {};
  spendAgainstBudget(item, quantity, budget, shortfall, 0);
  return shortfall;
}

// Mirrors countInInventory's group resolution on the way OUT: a group token draws from its members in
// preference order, so spending 3 'planks' actually removes 3 oak_planks from the budget. Without the
// matching debit the budget is read through the group map and written through none of it, and the
// double-spend this module exists to prevent returns by a side door.
function debitFromBudget(budget, token, amount) {
  const members = group_to_item[token];
  const keys = Array.isArray(members) ? members : [token];
  let left = amount;
  for (const key of keys) {
    if (left <= 0) break;
    const take = Math.min(budget[key] || 0, left);
    if (take > 0) { budget[key] -= take; left -= take; }
  }
}

// GROUP RESOLUTION ON THE WALKING SIDE lives in the registry as `recipeForToken`, not here. A recipe asks
// for `planks`, which appears nowhere in the recipe book, so a walk using `tryGetRecipe` called the group
// raw and answered "obtain 4 planks" — a token no gather job can fill — hiding the log conversion that is
// the only thing producing it. The group map was consulted on the SPENDING side
// (countInInventory, debitFromBudget) and not on the walking side.
//
// It resolves in the registry rather than in each walker because THREE walks needed it and each would
// have carried its own copy: this one, `stationsRequiredFor`, and the private copy supply_manager used to
// keep. The registry owns the recipe document, so "which recipe produces this token" is its question
// (Law 16).
//
// The group token, never the resolved member, stays the shortfall key when this still leafs: a request
// written in a member's name asks for a token no stock row carries (the seam assessors/furnace documents
// in the other direction), so the group is what a downstream gather can actually fill.
// `wanted` IS THE SECOND OUTPUT OF THE SAME WALK, and it is optional because only one caller needs it.
// `shortfall` collects LEAVES — what the world must supply. `wanted` collects EVERY NODE the walk still
// has to obtain, intermediates included, because "is anybody waiting on charcoal" is a question about a
// node the leaf answer has already dissolved into logs. Two walks would answer it, and they would drift
// (Law 16): the leaf walk and the node walk must agree about batch sizes and about what the pool already
// covers, or the fleet keeps material nothing is waiting for and dumps material something is.
function spendAgainstBudget(item, quantity, budget, shortfall, depth, wanted) {
  const spent = Math.min(countInInventory(item, budget), quantity);
  if (spent > 0) debitFromBudget(budget, item, spent);
  const still = quantity - spent;
  if (still <= 0) return;

  if (wanted) wanted[item] = (wanted[item] || 0) + still;

  const recipe = craftingRegistry.recipeForToken(item);
  // A leaf is anything the bot cannot craft its way to: no recipe, another chain's product
  // (isChainOwned), or a depth bound. Leaves are what the world must supply, so they are the answer.
  if (depth >= CRAFT_WALK_MAX_DEPTH || !recipe || !recipe.ingredients || isChainOwned(item)) {
    shortfall[item] = (shortfall[item] || 0) + still;
    return;
  }
  const makes = recipe.sequence && recipe.sequence.length > 0
    ? recipe.sequence[recipe.sequence.length - 1].makes || 1
    : 1;
  const batches = Math.ceil(still / makes);
  for (const [ingredient, per] of Object.entries(recipe.ingredients)) {
    spendAgainstBudget(ingredient, per * batches, budget, shortfall, depth + 1, wanted);
  }
}

// EVERY MATERIAL AN ORDER STILL HAS TO OBTAIN, at every level of its recipe — the answer to "is anybody
// waiting on this?" rather than "what must the world supply?". Net of the pool, so a material already in
// hand is not reported as wanted: an order that can be filled from stock wants nothing.
//
// WHY AN ORDER'S INTERMEDIATES ARE THE POINT. The leaf walk answers "go and get" and reports only the
// ends of the chain; asked "may I throw this away", it would report nobody wanting planks while three
// orders were waiting on them — so the fleet banks them and has to fetch them back. A demand that names
// only its roots cannot protect the middle of its own chain, and the middle is where the dumper and the
// smelter both read.
function requirementTree(item, quantity, poolCounts, reservedOfItem = 0) {
  const budget = { ...(poolCounts || {}) };
  if (reservedOfItem > 0) debitFromBudget(budget, item, reservedOfItem);
  const wanted = {};
  spendAgainstBudget(item, quantity, budget, {}, 0, wanted);
  return wanted;
}

// blocksCompletion — the ONE definition of "does this still-needed block count as OUTSTANDING work
// that must gate a build/shaft from reporting complete?" A REQUIRED block always gates. An OPTIONAL
// block gates ONLY when the item is on hand in the credited pool: optional-and-available becomes
// required (it gets placed, never silently skipped), while optional-and-absent does NOT gate.
// BOTH OPTIONAL SETS ARE CURRENTLY EMPTY, so every block is required today, and the empty set is the
// intended state rather than a gap: an optional entry holds a build open forever without ever blocking
// it, and an unlit shell that reports itself done is what sends bots outdoors after dusk under an
// exemption that only exists because the shell is unfinished. This function stays because the DISTINCTION
// is what the gates share; a set earns an entry only for material the fleet genuinely cannot obtain at
// all. Every completion
// gate calls THIS — job_board's nextAnchor, building_manager's owesRequired, preconstruction's
// withdrawal, mining_integrity's deferrableOnly — so they cannot drift apart (Law 16): separate inline
// copies of this condition can silently disagree about whether an optional item is done, leaving one
// gate satisfied while a dependent step downstream is never dispatched. `count` = how many the cell
// still needs; `availableCount(item)` = how many the credited pool (pocket + chests, or inventory for
// mining) holds.
function blocksCompletion(item, count, optionalSet, availableCount) {
  if (!optionalSet || !optionalSet.has(item)) return true;   // required (or no optional set) — always outstanding
  return availableCount(item) >= count;                      // optional — outstanding only when placeable now
}

// DELETED: `anchorPlaceableNow` and its load-time proof. It answered "can this anchor advance one voxel
// RIGHT NOW", which only had a consumer while a shortfall could still dispatch a partial build; with
// partial-anchor dispatch removed, both callers (job_board's gate and building_manager's) say NO on any
// shortfall again and the question has no asker. Left as a note rather than silence because the function
// looks obviously useful and will be re-invented by anyone who reads the two gates and thinks they need
// a shared condition — they do not; the condition is `shortfall is empty`, which each computes from the
// one `remainingRawForBuild` below (Law 16).

module.exports = {
  isRawMaterial,
  isChainOwned,
  blueprintToRawMaterials,
  remainingRawForBuild,
  craftShortfall,
  requirementTree,
  blocksCompletion,
};
