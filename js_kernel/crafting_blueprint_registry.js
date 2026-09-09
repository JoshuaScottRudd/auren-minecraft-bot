// js_kernel/crafting_blueprint_registry.js
// The ONE route to crafting_blueprints.json (Law 16). Every fragment that needs a recipe asks here;
// nothing else opens the file. Before this there were five independent routes to it — two live
// fs.readFileSync sites (craft_handler.resolveBlueprint, supply_manager._loadBlueprints) and three
// bare require()s — so the same document was reachable four different ways with four different
// failure modes.
//
// The snapshot/hash/drift-warn mechanism lives in @kernel/snapshot_registry and is shared with
// blueprint_registry — read the WHY there. This file owns only the recipe-document shape and accessors.
//
// WHY THIS FILE EXISTS. building_blueprints.json got the snapshot treatment first; the same crash was
// still live here — the two readFileSync sites re-read the file on every craft plan and every supply
// plan, and Law 13 correctly makes an unreadable declared file a throw. Deleting the file to upload a
// new version crashes the next craft. Fixing one file and leaving its twin armed is fixing the
// incident, not the fault.
//
// A NOTE ON THE require() ROUTES. Node caches a required JSON file, so those three were already
// effectively boot snapshots and never crashed. They were still worth converting: a snapshot nobody
// declared is a snapshot nobody can see. Going through the registry means an edit to this file is now
// REPORTED at warn level like any other, instead of silently having no effect — which is the same
// unverified-belief failure the hash exists to defeat (Law 26).

'use strict';

const { createSnapshotRegistry } = require('@kernel/snapshot_registry');
const { group_to_item } = require('@utils/fragment_utils');

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
// WHY IT LIVES WITH THE DATA AND IS DERIVED RATHER THAN AUTHORED: the answer is already written in
// every recipe's `requires`, so a hand-kept list of "rows that need a table" would be a second copy of
// the recipe document, stale from the first recipe change and reporting nothing while it is wrong. Two
// consumers ask this question — the gate that decides whether a supply job may be offered, and the
// fulfiller that asserts one was never offered unstationed — and they must get the SAME answer or the
// gate holds work the fulfiller would have done, or worse, passes work it then crashes on (Law 16: one
// implementation; Law 25: the gate and the fulfiller measuring one world).
//
// THE TREE, NOT THE TOP RECIPE, AND THAT IS THE LOAD-BEARING PART. A caller asking only the top recipe
// gets a gate whose reach is shorter than the walk the fulfiller performs, and the gap is exactly where
// an unstationed craft slips through: `furnace` needs a table and so does the `stone_axe` two steps
// above it. Matching the fulfiller's own recursion is what makes the assertion downstream provable
// rather than hopeful.
//
// `inventory` IS NOT A STATION — it is the recipes' word for "no station, 2x2 in the pocket", the
// default case, and admitting it would gate every plank craft on a station that cannot exist.

// A RECIPE NAMES A GROUP; ONLY THE GROUP'S MEMBERS CARRY RECIPES. `tryGetRecipe` answers about the exact
// token, which is right for a lookup and wrong for a WALK: a recipe asks for `planks`, no recipe is filed
// under `planks`, and a walk that stops there never learns the log conversion is in the tree. Every
// consumer that walks the recipe graph needs this resolution, so it lives once beside the data rather than
// as a private copy per walker — two walkers already disagreed at a group token and the disagreement was
// invisible from either side (Law 16).
//
// FIRST MEMBER CARRYING A RECIPE WINS, matching the group's own preference order, so the member this walk
// prices is the member a spend would actually consume.
function recipeForToken(token) {
  const item = String(token).trim().toLowerCase();
  const direct = registry.data()[item];
  if (direct) return direct;
  const members = group_to_item[item];
  if (!Array.isArray(members)) return null;
  for (const member of members) {
    const viaMember = registry.data()[member];
    if (viaMember && viaMember.ingredients) return viaMember;
  }
  return null;
}

const NO_STATION = 'inventory';
// `haveEnough(ingredient, quantity)` STOPS THE WALK AT WHAT IS ALREADY HELD, and passing it is what makes
// this answer "which stations does the work STILL need" instead of "which stations does this recipe tree
// mention". An ingredient already in hand will never be crafted, so the station its branch names is not a
// requirement of anything that is going to happen. A torch is a 2x2 craft whose `charcoal` branch names a
// furnace: walked unconditionally, a bot holding charcoal is refused a torch over a furnace it has no
// reason to visit; walked with the predicate, the branch is skipped and the torch is a 2x2 craft again.
//
// EVERY CALLER MUST PASS THE SAME PREDICATE OR NONE OF THEM MAY (Law 16). Two callers ask this question —
// the gate that decides whether to post the job, and the fulfiller's Law 13 assertion that the gate did
// its job. If they disagree about the reach of the walk, the wider one throws on precisely the work the
// narrower one just cleared, which is a crash manufactured by the disagreement rather than by any fault
// in the work. Omitting it walks the whole tree, which is correct only for a caller asking about the
// recipe in the abstract, with no pocket in the question.
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

module.exports = { getRecipes, tryGetRecipe, recipeForToken, stationsRequiredFor };
