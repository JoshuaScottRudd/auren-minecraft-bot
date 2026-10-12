'use strict';
// requestable_catalogue — what a human may ask the fleet for, computed from the fleet's own tables so the
// answer moves as the fleet's abilities do. An item is requestable iff its whole decomposition (the
// recipe graph) terminates in things the fleet can obtain (the chain tables in fragment_utils). An
// unclassified leaf is treated as unobtainable (Law 13, default-stopped); `unclassifiedLeaves()` reports it.
const {
  group_to_item, underground_items, stone_prospect_items, farm_items, furnace_chain_items, hunt_items,
  normalizeItemName,
} = require('@utils/fragment_utils');
const { getRecipes, recipeForToken } = require('@kernel/crafting_blueprint_registry');

// The one authored fact in this file: what the fleet can take straight out of the world. Everything else
// is derived — the other tables mark materials their own guard chain owns, not what is obtainable. Kept
// to raw materials only, and kept narrow: default-stopped (Law 13).
const WORLD_OBTAINABLE = new Set([
  // Felled by the canopy chain; obtainable but not askable by name (see familyOnlyMap below).
  'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log',
  // Broken straight out of the ground by the surface and shaft loops.
  'dirt', 'sand', 'gravel', 'cobblestone', 'stone', 'clay_ball', 'flint',
]);

// The crew never goes to deepslate. underground_items lists these as a guard, not a capability manifest,
// so obtainableRoots() subtracts them explicitly. A predicate, since this is a property of a whole layer.
function isDeepslate(name) {
  return name === 'cobbled_deepslate' || name.startsWith('deepslate_');
}

// No ore yet: no fragment mines it, so nothing here (or above it) is obtainable. Temporary — deleted once
// a mining fragment lands. `coal` goes with the ores; the torch survives via `charcoal`, smelted from logs.
const NO_ORE_YET = new Set([
  'coal', 'coal_ore',
  'iron_ore', 'raw_iron', 'iron_ingot',
  'copper_ore', 'raw_copper', 'copper_ingot',
  'gold_ore', 'raw_gold', 'gold_ingot',
  'redstone', 'redstone_ore',
  'lapis_lazuli', 'lapis_ore',
  'diamond', 'diamond_ore',
  'emerald', 'emerald_ore',
]);

// Logs are asked for as a family, never by species — the canopy chain fells whatever wood is nearby.
// Species stay obtainable (above, closing `planks`/`torch`) but are subtracted from what a person may
// say; `logs` is the form that works. Stone follows the same rule for the same reason: the shaft and
// surface loops break whatever rock is in front of them, so only `stone`/`cobblestone` stay askable.
const STONE_ASK = 'stone';

// item → the family token to ask for instead, empty for anything askable by its own name. A map rather
// than a set, so the refusal can name the right word (Law 24).
function familyOnlyMap() {
  const out = new Map();
  for (const member of (group_to_item.logs || [])) out.set(normalizeItemName(member), 'logs');
  for (const member of (group_to_item[STONE_ASK] || [])) {
    const name = normalizeItemName(member);
    if (name !== STONE_ASK) out.set(name, STONE_ASK);
  }
  for (const name of ['blackstone', 'mossy_cobblestone']) out.set(normalizeItemName(name), STONE_ASK);
  return out;
}

// What the fleet can obtain at all: the raw materials plus what the named producing chains deliver.
// hunt_items is excluded at the caller — the one such set whose owning chain does not exist.
function obtainableRoots() {
  const roots = new Set();
  for (const item of WORLD_OBTAINABLE) roots.add(normalizeItemName(item));
  for (const set of [underground_items, stone_prospect_items, farm_items, furnace_chain_items]) {
    for (const item of set) roots.add(normalizeItemName(item));
  }
  // Subtracted after the chain sets are read, since those sets are guards owned elsewhere (see isDeepslate).
  for (const name of [...roots]) if (isDeepslate(name) || NO_ORE_YET.has(name)) roots.delete(name);
  return roots;
}

// What no fragment can reach: hunt_items marks mob drops no block scan can find.
function unreachableLeaves() {
  const out = new Set();
  for (const item of hunt_items) out.add(normalizeItemName(item));
  return out;
}

// Walk one item's decomposition. Returns null when it closes, or the leaf that stopped it. A group token
// (e.g. `logs`) resolves when any member does. `seen` tracks the path so a graph cycle terminates.
function blockingLeaf(item, roots, unreachable, seen = new Set()) {
  const name = normalizeItemName(item);
  if (unreachable.has(name)) return name;
  if (roots.has(name)) return null;
  if (seen.has(name)) return null;          // already proven on this path, or cycling
  seen.add(name);

  const members = group_to_item[name];
  if (Array.isArray(members) && members.length > 0) {
    let lastBlock = null;
    for (const member of members) {
      const block = blockingLeaf(member, roots, unreachable, new Set(seen));
      if (!block) return null;              // one member suffices for the whole token
      lastBlock = block;
    }
    // Fall through so a group that also names a recipe (planks is both) is priced by that recipe.
    const groupRecipe = recipeForToken(name);
    if (!groupRecipe) return members.includes(lastBlock) ? name : lastBlock;  // name the group (Law 25)
  }

  const recipe = recipeForToken(name);
  if (!recipe || !recipe.ingredients) return name;   // no chain, no recipe → the walk stops here

  for (const ingredient of Object.keys(recipe.ingredients)) {
    const block = blockingLeaf(ingredient, roots, unreachable, new Set(seen));
    if (block) return block;
  }
  return null;
}

// isRequestable(item) → { ok: true } | { ok: false, blockedBy }, naming the leaf that stopped the walk
// (Law 24). A structure has no recipe, so admitting one only asserts the fleet knows how to build it.
function isBlueprint(name) {
  return Boolean(require('@kernel/blueprint_registry').tryGetBuilding(normalizeItemName(name)));
}

// Whether a person may ask for a known structure is separate from isBlueprint: most attach to another
// and cannot be raised alone. Authored as REQUESTABLE_STRUCTURES, never re-derived (Law 16).
function isRequestableStructure(name) {
  const { REQUESTABLE_STRUCTURES } = require('@thinking/architect_config');
  return REQUESTABLE_STRUCTURES.includes(normalizeItemName(name));
}

// Two authored tables describing one structure must agree — a name offered with no requirement rows
// behind it would be filed and never complete. Checked at load so it cannot be skipped (Law 13).
(function assertWhitelistIsBuildable() {
  const { REQUESTABLE_STRUCTURES, BUILDING_REQUIREMENTS } = require('@thinking/architect_config');
  const withLadders = new Set(BUILDING_REQUIREMENTS.map(req => req.field));
  const promised = REQUESTABLE_STRUCTURES.filter(name => !withLadders.has(name));
  if (promised.length > 0) {
    throw new Error(`[requestable_catalogue] CODING VIOLATION: REQUESTABLE_STRUCTURES offers `
      + `${promised.join(', ')} to people, and BUILDING_REQUIREMENTS has no rows for it. A person can ask `
      + `for it, it will be filed and broadcast, and no assessor will ever walk it — the request stays at `
      + `"not started" forever with nothing reporting a fault. Either add the requirement ladder or take `
      + `the name off the whitelist.`);
  }
})();

function isRequestable(item) {
  // A refused structure carries no `blockedBy`: no walk ran, so nothing stopped it (Law 25).
  if (isBlueprint(item)) return isRequestableStructure(item) ? { ok: true } : { ok: false };
  // A species refusal carries `askInstead` — the fleet can get the logs, just not that form (Law 24).
  const name = normalizeItemName(item);
  const askInstead = familyOnlyMap().get(name);
  if (askInstead) return { ok: false, askInstead };
  const roots = obtainableRoots();
  const blocked = blockingLeaf(name, roots, unreachableLeaves());
  return blocked ? { ok: false, blockedBy: blocked } : { ok: true };
}

// requestableItems() → the whole catalogue, sorted, computed on every call: a cached catalogue would be
// a stale fact about a fleet that changes underneath it (Invariant B).
function requestableItems() {
  const roots = obtainableRoots();
  const unreachable = unreachableLeaves();
  const out = new Set();
  for (const root of roots) if (!unreachable.has(root)) out.add(root);
  for (const name of Object.keys(getRecipes())) {
    if (!blockingLeaf(name, roots, unreachable)) out.add(normalizeItemName(name));
  }
  // Species come back out, having closed the walk; `logs` stays as the form a person says.
  for (const name of familyOnlyMap().keys()) out.delete(name);
  // Structures come from the whitelist, not the registry — most attach and cannot be raised alone (Law 25).
  for (const name of require('@thinking/architect_config').REQUESTABLE_STRUCTURES) {
    out.add(normalizeItemName(name));
  }
  return [...out].sort();
}

// unclassifiedLeaves() → leaves that stop a walk while being neither obtainable nor known-unreachable:
// items a recipe needs that no table claims, so everything above them is currently refused.
function unclassifiedLeaves() {
  const roots = obtainableRoots();
  const unreachable = unreachableLeaves();
  const out = new Set();
  for (const name of Object.keys(getRecipes())) {
    const block = blockingLeaf(name, roots, unreachable);
    if (block && !unreachable.has(block)) out.add(block);
  }
  return [...out].sort();
}

// isBlueprint is exported so a caller can ask which measure (stage vs chest count) answers a request.
// unreachableLeaves is exported so the desk can tell "no route" from "not a word" (Law 25).
module.exports = { isRequestable, isBlueprint, requestableItems, unclassifiedLeaves, unreachableLeaves, obtainableRoots };
