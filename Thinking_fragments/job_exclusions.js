// job_exclusions — the one item a job may be posted without, decided in one place and read everywhere
// else (Law 16).
//
// A material is excluded when the fleet cannot obtain it at all right now: the pool holds none of it and
// its only door is shut. The set is measured fresh every sweep, so an excluded entry deletes itself the
// moment the material becomes reachable, with no state to clear.
//
// This file decides and says nothing. Every entry carries its own `why`; the reader that acts on an
// exclusion states it in its own trace line at the point it matters (Law 16 — one owner, readers
// announce).
//
// ── WHAT COUNTS AS UNAVAILABLE ──────────────────────────────────────────────────────────────────────
// A material is unavailable when the pool holds none of it and the mine is its only door. Almost every
// door is always open — the surface supplies logs, dirt and ground fill, a farm grows wheat, a table
// turns planks into a barrel. The mine is the one door that can be shut: a builder's stone comes from a
// shaft behind the laydown yard, which is behind the furnaces, which are behind the stone.
//
//   stone_prospect_items   cobblestone and furnace_material, whose door is decided per species by
//                          architect_config.STONE_SOURCE — shut for a builder, open for a homesteader's
//                          prospect dig.
//   isUnderground          the catalogue of materials the surface never provides.
//   a GROUP that isGatherable  `structural_fill` and `natural_block` are catalogued underground and are
//                          ground fill the surface always supplies, so their door stays open. A bare ore
//                          (`coal`, `iron_ingot`) is not a group and its door does not.
//
// ── A CHAIN PRODUCT IS UNAVAILABLE WHEN ITS STATION DOES NOT STAND ──────────────────────────────────
// A torch is `stick + charcoal`; charcoal is `logs` at a furnace. No furnace stands at the start of a
// builder's run and none can be built without stone, so charcoal has no producer and the torch is
// unavailable. `isChainOwned` is the same predicate supply_manager's `_isChainProduct` uses, so the
// exclusion and the supply cascade agree on who owns a material (Law 16).
//
// ── NOT A PRIORITY LIST ──────────────────────────────────────────────────────────────────────────────
// This file answers "may this be skipped", never "what comes first". When stone arrives the excluded
// voxels simply stop being skippable; STRUCTURE_PRIORITY (job_ranking) is what sends a body at the
// resulting shortfall. Nothing here orders anything.

'use strict';

const {
  group_to_item,
  isUnderground,
  stone_prospect_items,
  accessibleMaterialPool,
} = require('@utils/fragment_utils');
const { countInInventory } = require('@utils/calculators/inventory_calculator');
const { isGatherable, isChainOwned } = require('@utils/calculators/build_material_calculator');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const stationRegistry = require('@perception/station_registry');

// A material's only door is the mine once the prospect, underground and ground-fill checks above all
// close it — see the header for what each clause tests.
function mineIsTheOnlyDoor(material) {
  // The prospect pair first, because `isUnderground` is already the species answer for them and the
  // ground-fill clause below would give the wrong one (they are a group and they are gatherable).
  if (stone_prospect_items.has(material)) return isUnderground(material);
  if (!isUnderground(material)) return false;
  return !(group_to_item[material] && isGatherable(material));
}

// WHICH STATION A CHAIN PRODUCT WAITS ON. Only the furnace is derivable from the recipe book; a farm or a
// hunt has no station row, and a material neither of those produces is not chain-owned. A chain whose
// station cannot be named counts as waiting, not available.
function _chainStationStands(material) {
  const recipe = craftingRegistry.recipeForToken(material);
  const station = recipe && Array.isArray(recipe.requires)
    ? recipe.requires.find(r => r === 'furnace')
    : null;
  if (!station) return false;
  return stationRegistry.getStationTypes().has(station);
}

// _unavailable — can the fleet obtain this token AT ALL right now?
//
// `seen` is a cycle guard and nothing more: the recipe book has diamonds in it (a barrel reaches planks
// by two routes) and a walk without one would not terminate on a book that ever gains a cycle. A token
// already being walked answers "not by this route", which lets the other route decide.
function _unavailable(token, pool, seen) {
  if (countInInventory(token, pool, group_to_item) > 0) return null;   // in hand or in a chest — available
  if (mineIsTheOnlyDoor(token)) return 'the mine is its only source and the fleet has none';
  if (isGatherable(token)) return null;                                 // the world supplies it
  if (isChainOwned(token)) {
    return _chainStationStands(token) ? null : 'the station that makes it does not stand yet';
  }
  const recipe = craftingRegistry.recipeForToken(token);
  if (!recipe || !recipe.ingredients) return null;   // no recipe and not mine-only — nothing says it is out of reach
  if (seen.has(token)) return null;
  seen.add(token);
  for (const raw of Object.keys(recipe.ingredients)) {
    const ing = String(raw).trim().toLowerCase();
    const why = _unavailable(ing, pool, seen);
    if (why) {
      seen.delete(token);
      return `it needs ${ing}, and ${why}`;
    }
  }
  seen.delete(token);
  return null;
}

// THE CANDIDATE SET IS THE TORCH, AND NOTHING ELSE. Every other material's absence delays a job, and a
// delayed job costs nothing because other work exists — `affordableNow` offers no unbuildable voxel, the
// shortfall posts as an order, and the site rank sends the body elsewhere in the same sweep. A torch's
// absence is different: `mining_integrity` diffs a segment against the blueprint, an unlit segment never
// diffs clean, so the shaft cannot advance past it — a completion measured inside the work itself, which
// a rank (`STRUCTURE_PRIORITY`) cannot reach.
//
// THE TEST FOR ADDING ANOTHER TOKEN HERE: does the shortfall only delay a job, or does it change what
// counts as FINISHED? Delay is a gate's business. Finished belongs here.
function _candidateTokens() {
  return new Set(['torch']);
}

// current() → { items: { token: why }, at } — THE LIST, AS OF RIGHT NOW.
//
// Called once per board sweep. It reads the pool once and asks the walk of each candidate, so two tokens
// short of the same material always get the same answer.
function current() {
  const pool = accessibleMaterialPool();
  const items = {};
  for (const token of _candidateTokens()) {
    const why = _unavailable(token, pool, new Set());
    if (why) items[token] = why;
  }
  return { items, at: new Date().toISOString() };
}

// excludes(list, token) — the one way a reader asks whether a token is excluded (Law 16). An absent list
// reads as nothing excluded, deliberately: an unknown list must never silently skip a voxel.
function excludes(list, token) {
  if (!list || !list.items || !token) return false;
  return Object.prototype.hasOwnProperty.call(list.items, token);
}

// why(list, token) — the reason, for the reader's own line. Empty string when it is not excluded.
function why(list, token) {
  return excludes(list, token) ? list.items[token] : '';
}

// names(list) → the excluded tokens, for a reader stating the whole set once.
function names(list) {
  return (list && list.items) ? Object.keys(list.items) : [];
}

module.exports = { current, excludes, why, names, mineIsTheOnlyDoor };
