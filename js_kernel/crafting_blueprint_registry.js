// js_kernel/crafting_blueprint_registry.js
// The ONE route to crafting_blueprints.json (Law 16). Every fragment that needs a recipe asks here;
// nothing else opens the file.
//
// The snapshot/hash/drift-warn mechanism lives in @kernel/snapshot_registry and is shared with
// blueprint_registry — read the WHY there. This file owns only the recipe-document shape and accessors.

'use strict';

const { createSnapshotRegistry } = require('@kernel/snapshot_registry');
const { group_to_item, GATHERED_GROUPS } = require('@utils/fragment_utils');

const CRAFTING_BLUEPRINTS_PATH = require.resolve('@kernel/crafting_blueprints.json');

const registry = createSnapshotRegistry({
  filePath: CRAFTING_BLUEPRINTS_PATH,
  fileName: 'crafting_blueprints.json',
  tag: 'crafting_blueprint_registry',
  // A flat map of item name → recipe. An array or an empty object is not a recipe book, and reaching
  // the run with one means every craft resolves to "uncraftable" — a confident wrong answer, which is
  // exactly what the boot-time form catch is for.
  validate: (parsed) => {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'is not an object map of item → recipe';
    }
    if (Object.keys(parsed).length === 0) return 'contains no recipes';
    // Every smelt names the items a furnace may be loaded with (`inputs`): the whitelist smeltInputsFor serves.
    for (const [item, r] of Object.entries(parsed)) {
      if (!Array.isArray(r?.requires) || !r.requires.includes('furnace')) continue;
      if (!Array.isArray(r.inputs) || r.inputs.length === 0) return `furnace recipe "${item}" names no \`inputs\` list`;
    }
    return null;
  },
});

// ── Accessors — the only way in ───────────────────────────────────────────────────────────────────

// The whole recipe document. Callers that iterate or index it themselves use this.
function getRecipes() {
  return registry.data();
}

// Absence-tolerant lookup, for callers whose whole job is to ask whether a thing is craftable at all
// (craft_handler falls through to the OBJECT_GROUPS alias before it is willing to call it a violation).
function tryGetRecipe(itemName) {
  return registry.data()[itemName] || null;
}

// WHICH STATIONS MAKING THIS ITEM NEEDS — down the recipe tree, not just the top recipe, and stopping
// wherever the caller's `haveEnough` predicate says the ingredient is already in hand (see the note above
// the function).
//
// DERIVED FROM THE DATA, NOT HAND-KEPT: the answer is already written in every recipe's `requires`, so a
// separate list of "rows that need a table" would be a second copy of the recipe document, going stale on
// the first recipe change. Two consumers ask this question — the gate that decides whether a supply job
// may be offered, and the fulfiller that asserts one was never offered unstationed — and they must get
// the SAME answer, or the gate holds work the fulfiller would have done, or passes work it then crashes
// on (Law 16: one implementation; Law 25: the gate and the fulfiller measuring one world).
//
// THE TREE, NOT THE TOP RECIPE, IS THE LOAD-BEARING PART. A caller asking only the top recipe gets a gate
// whose reach is shorter than the walk the fulfiller performs, and the gap is exactly where an
// unstationed craft slips through: `furnace` needs a table and so does the `stone_axe` two steps above
// it. Matching the fulfiller's own recursion is what makes the assertion downstream provable.
//
// `inventory` names no station — it is the recipes' word for a bare 2x2 craft in the pocket, the default
// case, and admitting it would gate every plank craft on a station that cannot exist.

// A RECIPE NAMES A GROUP; ONLY THE GROUP'S MEMBERS CARRY RECIPES. `tryGetRecipe` answers about the exact
// token, which is right for a lookup and wrong for a WALK: a recipe asks for `planks`, no recipe is filed
// under `planks`, and a walk that stops there never learns the log conversion is in the tree. Every
// consumer that walks the recipe graph needs this resolution, so it lives once beside the data, shared by
// every walker (Law 16).
//
// FIRST MEMBER CARRYING A RECIPE WINS, matching the group's own preference order, so the member this walk
// prices is the member a spend would actually consume.
//
// ── AND THE SAME SEAM RUNS THE OTHER WAY: A MEMBER WHOSE RECIPE IS FILED UNDER ITS GROUP ────────────
// `spruce_trapdoor` carries no recipe of its own; `trapdoor` does, because one recipe serves every
// species and the species is chosen at craft time from the planks the bot holds. A walk that asks about
// the member and stops at "no recipe" calls a CRAFTED item RAW, so the fleet posts a gather for a block
// no scan can find and no dig can produce. The fleet's own blueprints stay in group vocabulary (`planks`,
// `door`); a DOWNLOADED blueprint is written in concrete block names, so every wood shape in one arrives
// under a member name.
//
// A GROUP ONLY ANSWERS IF ITS OWN NAME CARRIES A RECIPE. Most groups are classifications, not recipes
// (`structural_fill`, `scaffold_block`, `natural_block` all contain planks), and returning the first
// group that merely CONTAINS the token would answer with whichever classification happened to be typed
// first. Requiring the recipe is what makes the answer about production.
//
// DIRECT FIRST, ALWAYS. `stone` is both a recipe key and the name of the natural-rock scan group, and
// those are different questions about the same word (Law 7); the direct hit settles it before the group
// map is consulted at all.
function recipeForToken(token) {
  const item = String(token).trim().toLowerCase();
  const direct = registry.data()[item];
  if (direct) return direct;
  // ── A GROUP THE WORLD SUPPLIES HAS NO RECIPE, WHATEVER ONE MEMBER'S ENTRY SAYS ─────────────────
  // Asked AFTER the direct lookup so an authored entry under the group's own name still wins — a
  // deliberate statement about the whole set. `fragment_utils.GATHERED_GROUPS` names which groups these are.
  if (GATHERED_GROUPS.has(item)) return null;
  const members = group_to_item[item];
  if (Array.isArray(members)) {
    for (const member of members) {
      const viaMember = registry.data()[member];
      if (viaMember && viaMember.ingredients) return viaMember;
    }
    return null;
  }
  for (const [group, list] of Object.entries(group_to_item)) {
    if (!Array.isArray(list) || !list.includes(item)) continue;
    const viaGroup = registry.data()[group];
    if (viaGroup && viaGroup.ingredients) return viaGroup;
  }
  return null;
}

const NO_STATION = 'inventory';
// `haveEnough(ingredient, quantity)` STOPS THE WALK AT WHAT IS ALREADY HELD, so this answers which
// stations the work STILL needs, not every station the recipe tree mentions. An ingredient already in
// hand will never be crafted, so the station its branch names is not a requirement of anything that is
// going to happen. A torch is a 2x2 craft whose `charcoal` branch names a furnace: walked unconditionally,
// a bot holding charcoal is refused a torch over a furnace it has no reason to visit; walked with the
// predicate, the branch is skipped and the torch is a 2x2 craft again.
//
// EVERY CALLER MUST PASS THE SAME PREDICATE OR NONE OF THEM MAY (Law 16). Two callers ask this question —
// the gate that decides whether to post the job, and the fulfiller's Law 13 assertion that the gate did
// its job. If they disagree about the reach of the walk, the wider one throws on precisely the work the
// narrower one just cleared. Omitting the predicate walks the whole tree, correct only for a caller asking
// about the recipe in the abstract, with no pocket in the question.
function stationsRequiredFor(itemName, haveEnough, _seen) {
  if (!_seen) _seen = new Set();
  const stations = new Set();
  const item = String(itemName).trim().toLowerCase();
  if (_seen.has(item)) return stations;   // a recipe cycle is the loader's fault, not this walk's
  _seen.add(item);

  const recipe = recipeForToken(item);
  if (!recipe) return stations;           // a leaf: gathered, smelted or unknown — no craft, no station

  for (const required of (recipe.requires || [])) {
    const station = String(required).trim().toLowerCase();
    if (station && station !== NO_STATION) stations.add(station);
  }
  for (const rawIngredient of Object.keys(recipe.ingredients || {})) {
    const ingredient = String(rawIngredient).trim().toLowerCase();
    if (haveEnough && haveEnough(ingredient, recipe.ingredients[rawIngredient] || 1)) continue;
    for (const deeper of stationsRequiredFor(ingredient, haveEnough, _seen)) stations.add(deeper);
  }
  return stations;
}

// THE ITEMS A FURNACE MAY BE LOADED WITH TO MAKE `output` — the recipe's own `inputs` list, and nothing
// else. Counting, fetching and loading a smelt all read this list. null when `output` is not smelted.
function smeltInputsFor(output) {
  const r = tryGetRecipe(output);
  return (r && Array.isArray(r.requires) && r.requires.includes('furnace')) ? r.inputs : null;
}

module.exports = { getRecipes, tryGetRecipe, recipeForToken, stationsRequiredFor, smeltInputsFor };
