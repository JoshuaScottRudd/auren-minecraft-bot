/*
build_material_calculator.js — a build's material need, walked back to raw and netted against the bag.

Pure and stateless. Recipes come from @kernel/crafting_blueprint_registry, the one route to
crafting_blueprints.json (boot snapshot, drift-warned, never a live read).
*/

'use strict';

const { countInInventory, craftsAffordable } = require('@utils/calculators/inventory_calculator');

const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const { hunt_items, farm_items, furnace_chain_items, group_to_item, substitutes_for } = require('@utils/fragment_utils');

// A token is raw when the recipe book has no recipe for it, via `recipeForToken` (which also resolves
// the group seam).
function isRawMaterial(token) {
  return !craftingRegistry.recipeForToken(token);
}

// Whether a surface scan could ever find this token: a group answers true once ANY member exists, not
// all. Lives beside isRawMaterial so the two predicates cannot disagree (Law 16).
function isGatherable(token) {
  if (isRawMaterial(token)) return true;
  const members = group_to_item[token];
  return Array.isArray(members) && members.some(isRawMaterial);
}

// A material whose only real source is another chain (hunt, farm, furnace); the walks below treat it as
// a leaf. Same union supply_manager's _isChainProduct names (Law 16).
function isChainOwned(token) {
  if (hunt_items.has(token) || farm_items.has(token) || furnace_chain_items.has(token)) return true;
  const recipe = craftingRegistry.recipeForToken(token);
  return !!(recipe && Array.isArray(recipe.requires) && recipe.requires.includes('furnace'));
}

// blueprintToRawMaterials(materialsNeeded) → { rawItem: count }. Partial batches round UP.
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

// Depth limit guards a circular recipe; past it, the item is returned undecomposed.
function decomposeToRaw(item, quantity, depth = 0) {
  if (depth > 10) return { [item]: quantity };

  const recipe = craftingRegistry.recipeForToken(item);
  if (!recipe || !recipe.ingredients || isChainOwned(item)) {
    return { [item]: quantity };
  }

  const makes = recipe.sequence && recipe.sequence.length > 0
    ? recipe.sequence[recipe.sequence.length - 1].makes || 1
    : 1;

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
// Decomposes the need to raw and nets each raw against inventory, except held intermediates
// (planks/sticks), which credit against their own block need first — so held planks fill a planks-block
// need but are never subtracted from a raw log-block need.

// Wood intermediates net unconditionally, despite being group tokens: a held plank offsetting a plank
// block is the one safe overlap. Every other token nets only via `_itemLevelNettable`.
const NET_INTERMEDIATES = new Set(['planks', 'stick']);

// A finished item on hand nets against its own requirement first, the same first rung every other asker
// checks (stock → craft → gather), computed per build (Law 16).
//
// Group tokens share concrete members (`structural_fill` accepts planks AND logs); crediting a held item
// against two tokens that both accept it would double-spend it, so only a material claimed by exactly
// one requirement in this build nets here.
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
    // A chain-owned item (smelted, hunted, farmed) is its own leaf below, where the holdings are taken off
    // it; netting it here as well would take the same holdings off twice.
    if (nettable.has(item) && !isChainOwned(item)) {
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

// remainingRawInSpecies(materialsNeeded, invCounts, wood) → { rawItem: countStillNeeded }
//
// Same question as remainingRawForBuild, for a build whose wood must be one named species. The recipe
// book files wood under group tokens, so this pulls other-species logs and planks out of the pool first,
// sums the two log roots (`logs`, `<wood>_log`), and subtracts held species logs once.
function remainingRawInSpecies(materialsNeeded, invCounts, wood) {
  if (!wood) throw new Error('remainingRawInSpecies: a species is required — the caller is asking the species question without one.');
  const speciesLog = `${wood}_log`;
  const speciesPlanks = `${wood}_planks`;
  const logs = new Set(group_to_item.logs || []);
  const planks = new Set(group_to_item.planks || []);
  const inv = {};
  let heldSpeciesLogs = 0;
  for (const [item, n] of Object.entries(invCounts || {})) {
    if (logs.has(item)) { if (item === speciesLog) heldSpeciesLogs += n; continue; }
    if (planks.has(item) && item !== speciesPlanks) continue;
    inv[item] = n;
  }
  const short = remainingRawForBuild(materialsNeeded, inv);
  const logNeed = (short.logs || 0) + (short[speciesLog] || 0) - heldSpeciesLogs;
  delete short.logs;
  delete short[speciesLog];
  if (logNeed > 0) short[speciesLog] = logNeed;
  return short;
}

// ── ONE MATERIAL IN EVERY STATE: WHAT A BUILD NEEDS OF IT AGAINST WHAT THE FLEET HOLDS OF IT ─────────────
// familyBalance(materialsNeeded, holdings) → { root: { need, have, raw, smelted, crafted, short } }, every
// figure in units of the ROOT — the thing taken out of the world (raw_iron, cobblestone, logs).
//
// `need` is the bill walked back through every recipe, the furnace's included, to its roots. `have` is every
// held item on that walk — the root itself, what was smelted from it, what was crafted from that — turned
// back into root units at its recipe's ratio and split by the state it is held in. An item counts up to the
// amount the bill passes through it, so a held tool the build has no use for is not the build's material.
// Need rounds up a batch at every level and have does not, so the balance errs toward gathering.
const LOG_ITEMS = new Set(group_to_item.logs || []);
// Every log is one family: the recipe book files wood under the group token.
function familyRoot(item) {
  return LOG_ITEMS.has(item) ? 'logs' : item;
}

function _walkToRoot(item, quantity, roots, gross, exact, depth = 0) {
  const token = familyRoot(item);
  if (gross) gross[token] = (gross[token] || 0) + quantity;
  const recipe = craftingRegistry.recipeForToken(token);
  if (depth > 10 || !recipe || !recipe.ingredients || hunt_items.has(token) || farm_items.has(token)) {
    roots[token] = (roots[token] || 0) + quantity;
    return;
  }
  const makes = recipe.sequence && recipe.sequence.length > 0
    ? recipe.sequence[recipe.sequence.length - 1].makes || 1
    : 1;
  const batches = exact ? quantity / makes : Math.ceil(quantity / makes);
  for (const [ingredient, n] of Object.entries(recipe.ingredients)) {
    _walkToRoot(ingredient, n * batches, roots, gross, exact, depth + 1);
  }
}

function familyBalance(materialsNeeded, holdings) {
  const need = {};
  const gross = {};   // item on the walk → how much of it the bill passes through
  for (const [item, count] of Object.entries(materialsNeeded || {})) {
    if (typeof count === 'number' && count > 0) _walkToRoot(item, count, need, gross, false);
  }
  const balance = {};
  for (const [root, n] of Object.entries(need)) balance[root] = { need: n, have: 0, raw: 0, smelted: 0, crafted: 0, short: 0 };

  // One budget, concrete items before group tokens, so a held plank is credited once.
  const budget = { ...(holdings || {}) };
  const tokens = Object.keys(gross).sort((a, b) => (group_to_item[a] ? 1 : 0) - (group_to_item[b] ? 1 : 0));
  for (const token of tokens) {
    const use = Math.min(countInInventory(token, budget), gross[token]);
    if (!(use > 0)) continue;
    debitFromBudget(budget, token, use);
    const recipe = craftingRegistry.recipeForToken(token);
    const state = balance[token] ? 'raw'
      : (recipe && Array.isArray(recipe.requires) && recipe.requires.includes('furnace')) ? 'smelted' : 'crafted';
    const roots = {};
    _walkToRoot(token, use, roots, null, true);
    for (const [root, n] of Object.entries(roots)) {
      if (!balance[root]) continue;
      balance[root].have += n;
      balance[root][state] += n;
    }
  }
  for (const row of Object.values(balance)) {
    for (const k of ['have', 'raw', 'smelted', 'crafted']) row[k] = Math.floor(row[k]);
    row.short = Math.max(0, row.need - row.have);
  }
  return balance;
}

// craftShortfall(item, quantity, poolCounts, reservedOfItem) → { rootItem: countStillNeeded }
//
// Walks an order back the way the fulfiller will, spending what is on hand at every level against one
// shared budget, so siblings sharing a root aren't each tested against the full pool. Allocation is
// greedy, in recipe-declaration order: a false HOLD, never a false CLEAR (Law 13).
//
// Nets intermediates against the craft chain (a held plank becomes a stick), unlike remainingRawForBuild,
// which nets them only against their own block need.
const CRAFT_WALK_MAX_DEPTH = 10;   // circular-recipe guard, same bound and reason as decomposeToRaw
function craftShortfall(item, quantity, poolCounts, reservedOfItem = 0) {
  const budget = { ...(poolCounts || {}) };
  // Units already staged at the destination sit in the pool but are spoken for.
  if (reservedOfItem > 0) debitFromBudget(budget, item, reservedOfItem);
  const shortfall = {};
  spendAgainstBudget(item, quantity, budget, shortfall, 0);
  return shortfall;
}

// Mirrors countInInventory's group resolution on the way OUT: a group token draws from its members in
// preference order, so spending 3 'planks' actually removes 3 oak_planks from the budget.
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

// The craft-side debit: units come off a group in any mixture, but crafts come off one variant at a
// time, in whole multiples of a craft's cost. Returns the units actually spent.
function debitCraftsFromBudget(budget, token, perCraft, crafts) {
  const members = group_to_item[token];
  const keys = Array.isArray(members) ? members : [token];
  let left = crafts;
  let spent = 0;
  for (const key of keys) {
    if (left <= 0) break;
    const take = Math.min(Math.floor((budget[key] || 0) / perCraft), left);
    if (take > 0) { budget[key] -= take * perCraft; spent += take * perCraft; left -= take; }
  }
  return spent;
}

// Group resolution lives in the registry's `recipeForToken`, so the walks agree which recipe produces a
// token (Law 16); the group token stays the shortfall key when this leafs, since a downstream gather can
// only fill the group. `shortfall` collects LEAVES the world must supply; `wanted` collects every node
// still to obtain, intermediates included. A substitute (`substitutes_for`) is spent first.
//
// `perCraft` makes the walk species-aware: the top call omits it; each recursive call passes the
// ingredient's per-craft cost, so a craft is only ever spent in one species (`craftsAffordable`).
function spendAgainstBudget(item, quantity, budget, shortfall, depth, wanted, perCraft = 0) {
  let spent = 0;
  if (perCraft > 0) {
    const crafts = Math.min(craftsAffordable(item, perCraft, budget), Math.floor(quantity / perCraft));
    if (crafts > 0) { spent = debitCraftsFromBudget(budget, item, perCraft, crafts); }
  } else {
    spent = Math.min(countInInventory(item, budget), quantity);
    if (spent > 0) debitFromBudget(budget, item, spent);
  }
  for (const alt of (substitutes_for[item] || [])) {
    // A substitute is a concrete item and obeys the same rule: it is spendable in whole crafts.
    let take = Math.min(budget[alt] || 0, quantity - spent);
    if (perCraft > 0) take = Math.floor(take / perCraft) * perCraft;
    if (take > 0) { budget[alt] -= take; spent += take; }
  }
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
    spendAgainstBudget(ingredient, per * batches, budget, shortfall, depth + 1, wanted, per);
  }
}

// Every material an order still has to obtain, at every level, net of the pool — every node still to
// reach, not just what the world must supply. The dumper and the smelter read this, since a demand
// naming only its roots misses the middle of its own chain.
function requirementTree(item, quantity, poolCounts, reservedOfItem = 0) {
  const budget = { ...(poolCounts || {}) };
  if (reservedOfItem > 0) debitFromBudget(budget, item, reservedOfItem);
  const wanted = {};
  spendAgainstBudget(item, quantity, budget, {}, 0, wanted);
  return wanted;
}

// The one definition of whether a still-needed block counts as outstanding work that gates a build/shaft
// from reporting complete. A required block always gates; an optional block gates only while unavailable
// in the credited pool.
//
// Every completion gate — job_board, building_manager, preconstruction, mining_integrity — calls this, so
// they cannot drift apart (Law 16). `count` = cell's remaining need; `availableCount` = pool's holding.
function blocksCompletion(item, count, optionalSet, availableCount) {
  if (!optionalSet || !optionalSet.has(item)) return true;   // required (or no optional set) — always outstanding
  return availableCount(item) >= count;                      // optional — outstanding only when placeable now
}

// waitsOnStation(item, holdings, stationUsable) → true when making `item` from `holdings` needs a station
// that `stationUsable` says does not stand. An ingredient already held in full is not walked, so a held
// finished item waits on nothing. The one station question for every build gate and for preconstruction.
function waitsOnStation(item, holdings, stationUsable) {
  if (!stationUsable) return false;
  if (countInInventory(item, holdings || {}) > 0) return false;
  const haveEnough = (ingredient, quantity) => countInInventory(ingredient, holdings || {}) >= quantity;
  return [...craftingRegistry.stationsRequiredFor(item, haveEnough)].some(s => !stationUsable(s));
}

// affordableNow(materialsNeeded, pool, stationUsable) → { item: count } — the part of a build the pool can pay for
// right now, as a load the pool can fully cover. The one question for all three gates —
// assessors/building, building_manager, preconstruction (Law 16).
//
// Each item is taken at the largest count the pool still covers after the items before it (binary search,
// via remainingRawForBuild), so items sharing planks are netted as the crafts will actually consume them.
//
// An item whose craft needs a station that does not stand yet is not payable, however full the pool is:
// preconstruction cannot make it, so a gate that counted it would post a seat the body then fills with
// nothing. `stationUsable` is station_registry's verdict, passed in so this file stays pure.
function affordableNow(materialsNeeded, pool, stationUsable) {
  const plan = {};
  for (const [item, count] of Object.entries(materialsNeeded || {})) {
    if (typeof count !== 'number' || count <= 0) continue;
    if (waitsOnStation(item, pool, stationUsable)) continue;
    let lo = 0, hi = count;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Object.keys(remainingRawForBuild({ ...plan, [item]: mid }, pool)).length === 0) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0) plan[item] = lo;
  }
  return plan;
}

module.exports = {
  isRawMaterial,
  isGatherable,
  isChainOwned,
  // Exported for `chest_ledger.lessClaims`, which spends a live claim out of a pool map by the same rule
  // a recipe's ingredient does — group token draws from its members in preference order (Law 16).
  debitFromBudget,
  blueprintToRawMaterials,
  remainingRawForBuild,
  remainingRawInSpecies,
  familyBalance,
  familyRoot,
  craftShortfall,
  requirementTree,
  blocksCompletion,
  waitsOnStation,
  affordableNow,
};
