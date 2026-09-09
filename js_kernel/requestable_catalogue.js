'use strict';
// requestable_catalogue — WHAT A HUMAN MAY ASK THE FLEET FOR, computed rather than listed.
//
// A human says `request 30 torches`. Before that becomes work, something has to answer whether the
// fleet can get a torch at all — and the answer must never be a hand-kept list. A list is an ANCHOR: it
// is written against the capabilities existing the day it is written, it reports "legal" unchanged
// while the fleet gains and loses abilities around it, and the first sign it is wrong is a bot sent
// after something no fragment can produce. What is computed from the fleet's own tables moves when the
// fleet moves.
//
// ── THE CLOSURE ──────────────────────────────────────────────────────────────────────────────────
// An item is requestable iff its whole decomposition terminates in things the fleet can obtain. The
// recipe graph supplies the decomposition; the chain tables in fragment_utils supply the terminals. So
// `logs` is the zero-step case, `torch` walks two levels to logs and coal, `headframe` walks further,
// and all three are the same question asked to different depths. That is why the human needs no verb
// per category: the categories are depths of one walk, and the walk is the machine's to do.
//
// ── EXCLUSION IS A CONSEQUENCE, NEVER A RULE ─────────────────────────────────────────────────────
// Nothing here blacklists leather. Leather is absent because no recipe reaches it and no chain produces
// it, which is a fact about the fleet rather than an opinion about the item (Law 27 — constitute what a
// requestable thing IS; do not police a list of forbidden ones). The day a fragment learns to shear a
// sheep, wool arrives on its own and there is no list to remember to edit.
//
// ── THE UNKNOWN LEAF REFUSES ─────────────────────────────────────────────────────────────────────
// The fleet has tables saying which CHAIN owns an item; it has none saying what it can OBTAIN, and the
// two are not the same question. So a leaf this file cannot classify is treated as unobtainable and
// everything above it is refused (Law 13, default-stopped): the burden is on a leaf to prove the fleet
// can reach it, never on the catalogue to prove it cannot. That makes the set start conservative and
// grow as roots are named — the failure mode is "a human is told no about something we could have got",
// which they can raise, rather than "a crew is sent after a mob drop", which strands a bot silently.
// `unclassifiedLeaves()` is the visible form of that debt; it is a report, not a gap to paper over.
const {
  group_to_item, underground_items, stone_prospect_items, farm_items, furnace_chain_items, hunt_items,
  normalizeItemName,
} = require('@utils/fragment_utils');
const { getRecipes, recipeForToken } = require('@kernel/crafting_blueprint_registry');

// ── THE ONE AUTHORED FACT IN THIS FILE, AND THE ONLY PLACE TO REVIEW ─────────────────────────────
// WHAT THE FLEET CAN TAKE STRAIGHT OUT OF THE WORLD. Everything else here is derived; this is stated,
// because nothing in the repo states it and the derivation has to stand on something.
//
// WHY NO EXISTING TABLE SERVES. underground_items, farm_items, furnace_chain_items and hunt_items look
// like a capability manifest and are the opposite: each names materials the plain surface-gather loop
// must NOT be sent after, because some other chain owns them. They are exceptions carved out of a
// default, so the default — ordinary blocks a scan can find and a bot can break — is exactly what they
// never mention. Wood is absent from all four for that reason, and a roots set built from them refuses
// planks, which is how this was found. Membership there also does not imply reachability: hunt_items
// names a chain that produces nothing.
//
// SMALL ON PURPOSE, AND IT IS NOT THE ANCHOR THE HEADER WARNS ABOUT. The forbidden list is a list of
// REQUESTABLE ITEMS — it would need an entry per craftable thing and would rot on every recipe change.
// This is a list of RAW MATERIALS, which changes only when the fleet gains a way to obtain a new kind
// of matter. Everything above it stays computed, so one entry here can admit a whole family of crafted
// items and no entry here names a craftable thing.
//
// KEPT NARROW BY DESIGN. An item wrongly present here sends a crew after something it cannot get; an
// item wrongly absent tells a human "no" about something the fleet could have fetched, which they will
// say so about. Default-stopped (Law 13): when unsure, leave it out.
const WORLD_OBTAINABLE = new Set([
  // Felled by the canopy chain. Stripped variants are deliberately absent — stripping is an axe
  // operation on a placed log, not something a tree yields.
  // OBTAINABLE, BUT NOT ASKABLE BY NAME — see FAMILY_ONLY below. They stay here because everything
  // above them closes through them; what a person may SAY is a different question.
  'oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log',
  // Broken straight out of the ground by the surface and shaft loops.
  'dirt', 'sand', 'gravel', 'cobblestone', 'stone', 'clay_ball', 'flint',
]);

// ── THE CREW NEVER GOES TO DEEPSLATE (Architect 2026-09-06) ──────────────────────────────────────
//   *"it cannot deliver deepslate redstone ore. the bot does not go to deepslate at all."*
//
// THIS IS A CORRECTION TO A DERIVATION, NOT A BLACKLIST, and the distinction is the whole reason it is
// legitimate here. `obtainableRoots()` reads the chain sets for "the one thing they truly assert: that
// some subsystem makes their members". For deepslate that assertion is FALSE. Those names are in
// `underground_items` for the set's actual purpose — marking materials the surface scan must never be
// dispatched after — and the header of that very set says it is "not a capability list". The catalogue
// was reading a guard as a manifest, and deepslate is where the two disagree.
//
// So the names stay in `underground_items` (the guard still wants them) and are subtracted here. The
// ordinary ores are untouched: `iron_ore` remains obtainable, so `raw_iron` and everything above it
// still closes — only the deepslate variant, which the crew would have to descend for, is gone.
//
// A PREDICATE RATHER THAN A LIST, because this is a property of a whole layer of the world and a list
// would need a new entry every time Mojang adds a deepslate variant — which is exactly the anchor this
// file's header warns about. The day the crew learns to descend, this function is deleted and nothing
// else changes.
function isDeepslate(name) {
  return name === 'cobbled_deepslate' || name.startsWith('deepslate_');
}

// ── NO ORE AT ALL, YET (Architect 2026-09-06) ────────────────────────────────────────────────────
//   *"right now no ore is allowed right now because i havent made logic for bots to dig for ore yet.
//    so remove all ore, anything derived from stone or wood is ok."*
//
// SAME CORRECTION AS DEEPSLATE, ONE LAYER WIDER. `underground_items` is a guard set, not a capability
// manifest, and `obtainableRoots()` reads it as one. Deepslate was where that first showed; ore is the
// rest of it. No fragment digs for ore, so nothing here is obtainable, so nothing above it is either —
// and until this turn the desk would have accepted `request 20 iron_ingot` and filed work no crew could
// ever do.
//
// EXPLICITLY TEMPORARY, and written to be deleted rather than maintained. "yet" is his word: the day a
// mining fragment lands, this set goes and the ores return on their own, along with everything they
// unlock — no recipe, no page and no test needs touching, because everything above them is computed.
// That is the property worth protecting here, and it is why this is a set of RAW MATERIALS and never a
// list of the crafted things they block.
//
// THE STONE FAMILY IS UNTOUCHED and shares the same set: `stone`, `cobblestone`, `andesite`, `diorite`,
// `granite`, `blackstone`, `smooth_stone`, `stone_bricks`, `bricks`, `mossy_cobblestone`,
// `structural_fill`. Those are broken out of ordinary ground by the surface and shaft loops, which is
// what "anything derived from stone is ok" means.
//
// `coal` GOES WITH THE ORES AND THE TORCH SURVIVES. Coal is mined from coal ore, so it fails his rule.
// It would be an alarming removal — a torch is how a bot sees — except that the `coals` group was
// deleted earlier and the torch recipe now names `charcoal` specifically, which the furnace makes from
// logs. Wood-derived, so it stays, and so does every torch.
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

// ── LOGS ARE ASKED FOR AS A FAMILY, NEVER BY SPECIES (Architect 2026-09-06) ──────────────────────
//   *"you can only request logs and the bots just gather the most common logs in the area. you cant
//    request specific logs. so foremen request 20 logs is the only possible."*
//
// The same shape as REQUESTABLE_STRUCTURES further down, and for the same reason: KNOWING HOW TO GET A
// THING IS NOT THE SAME AS BEING ASKABLE FOR IT. The canopy chain walks to whatever wood is abundant
// nearby and fells that. It cannot be pointed at a species, so `request 20 oak_log` is a promise the
// crew cannot keep in a birch forest — it either returns the wrong wood or nothing.
//
// The species therefore stay OBTAINABLE (above) so `logs`, `planks`, `stick`, `torch` and everything
// else keeps closing through them, and are subtracted from what a person may SAY. `logs` itself is
// untouched and is the form that works.
//
// AUTHORED, BECAUSE NO TABLE HOLDS IT. Nothing in the fleet records "the gatherer cannot target a
// species" — it is a fact about how the canopy chain picks a tree, and it is stated here for the same
// reason REQUESTABLE_STRUCTURES is stated rather than derived (Law 16: one answer, and it is the
// Architect's). Derived from `group_to_item.logs` rather than retyped, so a species added to the family
// is covered without anyone remembering this exists.
// ── STONE IS ASKED FOR AS STONE, NOT BY KIND (Architect 2026-09-06) ─────────────────────────────
//   *"the bot normally excepts stone instead of specific types of stone. so you ask for stone or
//    cobblestone and the bot will get you stone stuff."*
//
// The same fact as logs, one material over: the shaft and surface loops break whatever rock is in front
// of them. Andesite, diorite and granite are already declared members of `group_to_item.stone`, so they
// are DERIVED from it rather than retyped — a kind added to that group becomes unaskable for free.
// `stone` itself is removed from the derived set, because it is the word to say.
//
// `blackstone` and `mossy_cobblestone` are named, because they belong to no group that says "stone" and
// there is nothing to derive them from. That is the honest cost of the rule and it is two entries.
//
// `cobblestone` stays askable — his sentence names it as the second word that works.
//
// WHAT STAYS: everything MADE out of stone. `stone_bricks`, `smooth_stone`, `slab`, `stairs`, `bricks`
// and the stone tools are crafted or smelted at a station from whatever rock the crew brought back, so
// they can be promised by name exactly as `planks` can. That is the same line drawn for wood — the
// gather is generic, the product is specific.
const STONE_ASK = 'stone';

/**
 * item → the family token to ask for instead. Empty for anything askable by its own name.
 *
 * ONE MAP RATHER THAN A SET, so the refusal can name the RIGHT word. A single "ask for the family"
 * message that had to guess between `logs` and `stone` would be the un-guiding refusal this whole
 * mechanism exists to avoid (Law 24).
 */
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

// WHAT THE FLEET CAN OBTAIN AT ALL — the authored raw materials, plus what the named producing chains
// deliver. The chain sets ARE read here, for the one thing they truly assert: that some subsystem makes
// their members. hunt_items is excluded at the caller, because it is the one such set whose owning chain
// does not exist.
function obtainableRoots() {
  const roots = new Set();
  for (const item of WORLD_OBTAINABLE) roots.add(normalizeItemName(item));
  for (const set of [underground_items, stone_prospect_items, farm_items, furnace_chain_items]) {
    for (const item of set) roots.add(normalizeItemName(item));
  }
  // The crew does not descend that far — see isDeepslate. Subtracted AFTER the chain sets are read
  // rather than by editing them, because those sets are guards owned by the supply cascade and this is
  // a statement about reach, not about which chain owns a block.
  for (const name of [...roots]) if (isDeepslate(name) || NO_ORE_YET.has(name)) roots.delete(name);
  return roots;
}

// WHAT NO FRAGMENT CAN REACH. hunt_items is not a capability list — it is the supply cascade's marker
// for a mob drop no block scan can find, kept so the gather loop is never sent after one. Read here for
// exactly that meaning: a decomposition arriving at string or bone has arrived somewhere the fleet
// cannot follow, whatever the recipe says.
function unreachableLeaves() {
  const out = new Set();
  for (const item of hunt_items) out.add(normalizeItemName(item));
  return out;
}

// Walk one item's decomposition. Returns null when it closes, or the leaf that stopped it.
//
// A GROUP TOKEN IS RESOLVED, NOT REFUSED. Recipes name `logs` and `furnace_material` where several
// concrete blocks would serve, so a token is obtainable when ANY member is — refusing the token because
// its first member is missing would deny an item the fleet can plainly make.
//
// `seen` carries the walk's own path so a recipe graph containing a cycle terminates. A cycle is not a
// defect to throw on here: this file is asked about arbitrary items and must answer, not crash.
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
    // Every member blocked. Falling through rather than returning lets a group that ALSO names a recipe
    // (planks is both) be priced by that recipe instead of failing on its members.
    const groupRecipe = recipeForToken(name);
    // NAMES THE GROUP, NOT THE LAST MEMBER TRIED. Reporting `stripped_birch_log` for an unreachable
    // `logs` sends a reader after the wrong fact — the member is arbitrary (whichever the loop ended on)
    // while the group is the real answer: no member of it is obtainable (Law 25 — the verdict has to be
    // true against the question asked, and the question was about the token).
    if (!groupRecipe) return members.includes(lastBlock) ? name : lastBlock;
  }

  const recipe = recipeForToken(name);
  if (!recipe || !recipe.ingredients) return name;   // no chain, no recipe → the walk stops here

  for (const ingredient of Object.keys(recipe.ingredients)) {
    const block = blockingLeaf(ingredient, roots, unreachable, new Set(seen));
    if (block) return block;
  }
  return null;
}

// isRequestable(item) → { ok: true } | { ok: false, blockedBy }
//
// The refusal NAMES THE LEAF rather than saying no. A human told "no" learns nothing and asks again; a
// human told the walk stopped at `string` learns what the fleet cannot do and stops asking for the
// whole family of things above it (Law 24 — the report carries the decision, not just the verdict).
// A STRUCTURE IS A SECOND NAMESPACE, and forgetting it is what made `request 1 headframe` refuse. The
// recipe graph answers "can this ITEM be made"; a building is not an item and has no recipe — it is a
// blueprint the build pipeline pastes and raises. Both are legitimate things for a person to ask for and
// they are the same request to them, so both are answered here rather than by a second gate the desk
// would have to know to consult (Law 16).
//
// MATERIALS ARE NOT WALKED FOR A STRUCTURE, deliberately. A blueprint's shortfall becomes ordinary stock
// deficits, and every one of those passes back through this same catalogue on its own way to a job — so
// walking them here would be the second check on one fact. What is asserted by admitting a blueprint is
// only that the fleet knows how to build it.
function isBlueprint(name) {
  return Boolean(require('@kernel/blueprint_registry').tryGetBuilding(normalizeItemName(name)));
}

// ── KNOWING THE SHAPE IS NOT THE SAME AS BEING ASKABLE FOR ───────────────────────────────────────────
// `isBlueprint` answers the NAMESPACE question — is this row measured by a stage or by a chest count —
// and every structure in the registry answers yes to it. Whether a PERSON may ask for one is a different
// fact: most structures are attached (a mineshaft joins a headframe in a specific way), so raising one
// alone is not a thing the crew can be asked to do. That fact is derivable from no table here, so it is
// authored as REQUESTABLE_STRUCTURES and read — never re-derived (Law 16: one answer, and it is the
// Architect's).
//
// THE GATE IS HERE RATHER THAN AT THE DESK, and that placement is Law 27's referee test answered. It ran
// as a check at the foreman for one round: a person asked for a real blueprint, the desk consulted a
// second list and refused. That works and it is a regulation standing where a constitution was available —
// the property can be settled by DEFINING what "requestable" means, at which point the desk's check has
// nothing left to catch and every other consumer inherits the same answer for free. A referee whose
// conflict can be defined away is a symptom of the definition, and the repair is upstream.
function isRequestableStructure(name) {
  const { REQUESTABLE_STRUCTURES } = require('@thinking/architect_config');
  return REQUESTABLE_STRUCTURES.includes(normalizeItemName(name));
}

// TWO AUTHORED TABLES DESCRIBING ONE STRUCTURE MUST AGREE, and the disagreement is silent in the direction
// that hurts: a name offered to people with no requirement rows behind it is accepted, filed, broadcast,
// adopted by every crew member and then walked past by every assessor forever, while the read-back
// truthfully reports "not started" because it never will be. Nothing throws and nothing warns, so the
// check is made at load where it cannot be skipped (Law 13 — a mismatch between two hand-written tables is
// a coding violation, not an environmental one; preflight loads this file, so this runs free on
// every change to either table).
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
  // A REFUSED STRUCTURE CARRIES NO `blockedBy`, and its absence is the honest answer rather than a gap.
  // That field names the LEAF that stopped a recipe walk — the material the fleet has no route to. Nothing
  // stopped a walk here; no walk was made, because the structure is simply not offered. Filling the field
  // with the structure's own name would report a missing material that does not exist, and `null` would
  // assert that a walk ran and found nothing blocking. A caller that needs to tell this refusal from a
  // material one asks `isBlueprint` — the two are different questions and stay two calls (Law 25).
  if (isBlueprint(item)) return isRequestableStructure(item) ? { ok: true } : { ok: false };
  // A SPECIES REFUSAL CARRIES `askInstead`, because "no" is the wrong answer here and would be read as
  // "the fleet has no wood". The crew can absolutely get this person their logs; they named the one form
  // that cannot be honoured. The desk has the family token to hand them (Law 24 — the report carries the
  // decision, and the decision here is "say it this way instead").
  const name = normalizeItemName(item);
  const askInstead = familyOnlyMap().get(name);
  if (askInstead) return { ok: false, askInstead };
  const roots = obtainableRoots();
  const blocked = blockingLeaf(name, roots, unreachableLeaves());
  return blocked ? { ok: false, blockedBy: blocked } : { ok: true };
}

// requestableItems() → the whole catalogue, sorted. THE ANSWER TO "what can I ask for", and it is
// computed on every call rather than cached: a cached catalogue is a remembered fact about a fleet that
// changes underneath it (Invariant B), and the walk is cheap against a recipe document of this size.
function requestableItems() {
  const roots = obtainableRoots();
  const unreachable = unreachableLeaves();
  const out = new Set();
  for (const root of roots) if (!unreachable.has(root)) out.add(root);
  for (const name of Object.keys(getRecipes())) {
    if (!blockingLeaf(name, roots, unreachable)) out.add(normalizeItemName(name));
  }
  // The species come OUT again, having done their job of closing the walk. `logs` stays and is the form
  // a person says. This is the one place the catalogue's answer differs from the walk's, and it differs
  // in the safe direction: a name is withheld that the crew cannot honour, rather than offered.
  for (const name of familyOnlyMap().keys()) out.delete(name);
  // THE STRUCTURES COME FROM THE WHITELIST, NOT THE REGISTRY. The registry holds every shape the builder
  // can paste, and pasting is not the question a person is asking — most of those attach to another
  // structure and cannot be raised alone. Listing them all offered eight buildings a crew could raise one
  // of, and a name a person picks out of the only place that says what is accepted, then gets refused for,
  // leaves them nowhere to look (Law 25).
  for (const name of require('@thinking/architect_config').REQUESTABLE_STRUCTURES) {
    out.add(normalizeItemName(name));
  }
  // (The registry walk that used to stand here is deleted, not disabled — see isRequestableStructure. It
  // read the wrong table for this question, and keeping it beside the whitelist would be two answers to
  // one thing, drifting apart at the first structure added to either (Law 16).)
  return [...out].sort();
}

// unclassifiedLeaves() → leaves that stop a walk while being neither obtainable nor known-unreachable.
// THE HONEST DEBT, reported rather than resolved: each one is an item some recipe needs and no table
// claims, so everything above it is currently refused. Not a failure of this file — a fact about which
// capabilities the fleet has never written down.
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

// isBlueprint is exported because a request's NAMESPACE decides which of the crew's two measures answers
// it: a structure is not a countable good and can never be satisfied by a chest, so anything asking "how
// far along is this" must first ask which kind of thing it is holding (see requested_work).
// unreachableLeaves is exported so the DESK can tell two refusals apart, and that distinction is a Law 25
// one rather than a convenience. `string` is a word the fleet knows and has no route to; `logdsf` is not a
// word at all. Answering both with "that is not something i take" sends the first person away rewriting a
// word that was already right. Used for exact membership only — the desk asks "is this a name the fleet
// has an opinion about", never "what is this close to".
module.exports = { isRequestable, isBlueprint, requestableItems, unclassifiedLeaves, unreachableLeaves, obtainableRoots };
