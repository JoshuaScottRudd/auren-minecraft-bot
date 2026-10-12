// api: craft_handler
// purpose: Law 15 API — craftItems(bot, targetItem, quantity, payload) resolves a
//          target item into an ordered dependency sequence (blueprint expansion),
//          then executes each step: ensure a station exists, craft until the step's
//          target is met, return result.
//          Called directly by craft_executor and available to any fragment that
//          needs on-demand crafting. No signal-bus entry point.
//
// Holds no dig verb and no place verb: it crafts at the crew's one table, the home blueprint's.
//
// NESTED API (Law 15): calls the locomotion API (goTo) to reach distant stations; a locomotion
// abandonment (arrived=false) is an environmental failure that abandons the caller to recursive_judge.
//
// invariants:
//  - Resolution expands a target item into dependency-ordered steps via crafting_blueprints.json; group
//    items (logs, planks) resolve to the best-inventory variant; a visited set prevents cycles.
//  - TARGET-BASED, ABSOLUTE SEMANTICS (Law 10): every step's `target` is the desired total inventory
//    count after the step, not a delta.
//  - Only the LAST step's item/target decides overall success; a coding violation throws (Law 13);
//    an environmental failure (crafting_failed) triggers caller abandonment.
//  - Success returns { success, metrics, finalItem, finalCount, requiredFinal, sequenceLength }.
//  - THREE OUTCOMES, NOT TWO: a craft that runs out of an ingredient part way through is a PARTIAL,
//    always kept and returned, carrying `success: false, partial: true` with the true counts (Law 25).

'use strict';

const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const { group_to_item: OBJECT_GROUPS, BLOCK_REACH } = require('@utils/fragment_utils');
const { routeToJudge } = require('@utils/signal_utils');
// Entered through combatCheckpoint, never battleStations directly: one process-wide 500 ms clock
// shared with the dig and drive primitives, with an engaging/escaping bypass so combat's own arms
// cannot re-enter it.
const { combatCheckpoint } = require('@api/battle_stations');
const stationRegistry = require('@perception/station_registry');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const locomotion = require('@locomotion/locomotion_dispatcher');

const portableJudge = require('@kernel/portable_judge');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'craft_handler';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Deferred phase notes (Law 5: accumulate-then-post). Buffers per-step detail across one craftItems()
// call — resolution, craft deltas, station placement — for one consolidated summary at phase end.
// Module-level state is safe here: Law 4 guarantees only one craft runs at a time. `null` means no
// phase is open, and note() then posts immediately so a stray call is never lost.
let _phaseNotes = null;
function note(msg) {
  if (_phaseNotes) _phaseNotes.push(msg);
  else watcher.summary(TAG, msg);
}

const FINAL_OUTPUT_CONSTRAINTS = {
  ladder: { maxTotal: 64 }
};

// The settle after a craft click, before the pocket is read back.
const AFTER_CRAFT_SLEEP_MS = 200;
// Scan reach only — the radius the nearby-station scan sweeps. USING a station is a cell
// (locomotion.goToStationStance's blueprint anchor), not a distance, and this constant does not govern that.
const STATION_REACH = BLOCK_REACH;

// ---------------------------------------------------------------------------
// SECTION 1 — Helpers
// ---------------------------------------------------------------------------

function effectiveTarget(step) {
  const base = Math.max(0, Number(step.target) || 0);
  const constraint = FINAL_OUTPUT_CONSTRAINTS[step.item];
  if (constraint && Number.isFinite(constraint.maxTotal)) {
    return Math.min(base, constraint.maxTotal);
  }
  return base;
}

// ---------------------------------------------------------------------------
// SECTION 2 — Blueprint resolution
// ---------------------------------------------------------------------------

const PLANK_DERIVED_GROUPS = new Set(['stairs', 'door', 'fence', 'slab', 'trapdoor', 'fence_gate', 'sign', 'button', 'wood']);

const WOOD_VARIANTS = {
  oak_planks: 'oak',
  birch_planks: 'birch',
  spruce_planks: 'spruce',
  jungle_planks: 'jungle',
  acacia_planks: 'acacia',
  dark_oak_planks: 'dark_oak'
};

// Results the game crafts from the `coals` tag (coal OR charcoal). The recipe data mineflayer reads
// expands that tag unevenly — campfire carries 43 coal variants and 1 charcoal — so a pocket holding
// charcoal and oak logs matches no recipe the server would accept. Each coal variant of these results
// gets its charcoal twin, once per recipe table.
const COALS_TAG_RESULTS = ['campfire', 'fire_charge', 'torch', 'soul_torch', 'copper_torch'];
const _coalsFilled = new WeakSet();

function fillCoalsTag(bot) {
  const mcData = bot.registry;
  if (_coalsFilled.has(mcData.recipes)) return;
  _coalsFilled.add(mcData.recipes);
  const coal = mcData.itemsByName.coal.id;
  const charcoal = mcData.itemsByName.charcoal.id;
  const swap = (i) => (i === coal ? charcoal : (i && typeof i === 'object' && i.id === coal ? { ...i, id: charcoal } : i));
  for (const name of COALS_TAG_RESULTS) {
    const item = mcData.itemsByName[name];
    const list = item ? mcData.recipes[item.id] : null;
    if (!Array.isArray(list)) continue;
    const seen = new Set(list.map(r => JSON.stringify(r)));
    for (const r of list.slice()) {
      const twin = {
        ...r,
        ...(r.inShape ? { inShape: r.inShape.map(row => row.map(swap)) } : {}),
        ...(r.ingredients ? { ingredients: r.ingredients.map(swap) } : {}),
      };
      const key = JSON.stringify(twin);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(twin);
    }
  }
}

function resolveGroupItem(bot, groupName) {
  const group = OBJECT_GROUPS[groupName];
  if (!group) return groupName;

  const mcData = require('minecraft-data')(bot.version);
  let bestItem = group[0];
  let maxCount = -1;

  for (const item of group) {
    const itemId = mcData.itemsByName[item]?.id;
    const count = itemId != null ? bot.inventory.count(itemId) : 0;
    if (count > maxCount) {
      maxCount = count;
      bestItem = item;
    }
  }

  // Plank variant follows the log supply, not the most-held plank: picks the plank whose log the bot
  // holds the most of, and falls back to the most-held plank only when it holds no logs at all.
  if (groupName === 'planks') {
    const logGroup = OBJECT_GROUPS['logs'];
    let bestPlank = null, bestLogs = 0;
    for (const logName of logGroup) {
      const logId = mcData.itemsByName[logName]?.id;
      const logCount = logId != null ? bot.inventory.count(logId) : 0;
      if (logCount <= bestLogs) continue;
      const plankName = logName.replace(/_log$/, '_planks').replace(/^stripped_/, '');
      if (group.includes(plankName)) { bestLogs = logCount; bestPlank = plankName; }
    }
    if (bestPlank) return bestPlank;   // any logs on hand → craft the species we can actually produce
    return bestItem;                   // no logs at all → use whatever planks we already hold
  }

  // Groups whose variant follows the bot's plank species (birch_planks → birch_fence), never the
  // most-held member (Law 16). Membership rule: any group whose members are `<species>_<group>` for
  // the plank species belongs in PLANK_DERIVED_GROUPS; a group missing from this set resolves to
  // group[0] instead and fails only live, with no load-time check yet.
  if (PLANK_DERIVED_GROUPS.has(groupName)) {
    const plankItem = resolveGroupItem(bot, 'planks');
    const variantName = plankItem.replace(/_planks$/, `_${groupName}`);
    if (group.includes(variantName)) return variantName;
  }

  return bestItem;
}

function resolveToolVariant(itemName, plankItem) {
  const prefix = WOOD_VARIANTS[plankItem];
  if (!prefix) return itemName;
  if (itemName.startsWith(prefix)) return itemName;
  return `${prefix}_${itemName}`;
}

function extractStation(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.station || obj.station_type || obj.stationType || null;
}

// ── A RECIPE TREE IS A GRAPH, NOT A TREE, AND THE DIFFERENCE IS A DIAMOND ──────────────────────────
// Two branches of one recipe can reach the same intermediate (e.g. a barrel needs planks directly and
// via slabs). Demand accumulates across branches via three maps: `path` (items on the stack now, the
// cycle guard), `demand` (total required per item across every branch), and `sent` (what each
// parent→child edge has already contributed, so a re-walk adds only the delta). Demand only rises and
// the graph is finite, so the re-walk terminates; inventory is read against the accumulated total.
function resolveBlueprintRecursive(bot, targetItem, allBlueprints, resolved = [], path = new Set(), variantState = {}, targetCount = 1, demand = new Map(), sent = new Map()) {
  // Cycle guard: an item already on the stack refuses immediately (Law 13). Merely having been seen
  // before does not refuse it — that is what lets demand accumulate across diamond branches.
  if (path.has(targetItem)) return;

  // Parents' demands add; a visit asking no more than the prior total contributes nothing and stops,
  // which is what makes the re-walk converge.
  const priorDemand = demand.get(targetItem) || 0;
  const total = priorDemand + Math.max(0, targetCount);
  if (total <= priorDemand) return;
  demand.set(targetItem, total);
  path.add(targetItem);
  _resolveOne(bot, targetItem, allBlueprints, resolved, path, variantState, total, demand, sent);
  // Leaves the stack without forgetting the item: `demand` keeps the total for a later branch to add to.
  // No try/finally — a throw here is a Law 13 violation that aborts the whole plan, and `path` is local
  // to that plan and dies with it; every catch in this fleet goes through external_library_guard instead.
  path.delete(targetItem);
}

// One step per item, carrying the accumulated total: raising an existing step's target delivers
// accumulated demand to the executor as a single number (Law 16).
function _raiseOrPush(resolved, step) {
  const existing = resolved.find(s => s.item === step.item);
  if (existing) { existing.target = Math.max(existing.target, step.target); return; }
  resolved.push(step);
}

function _resolveOne(bot, targetItem, allBlueprints, resolved, path, variantState, targetCount, demand, sent) {

  let blueprint = allBlueprints[targetItem];
  if (!blueprint) {
    const groupAlias = Object.entries(OBJECT_GROUPS).find(([_, items]) => items.includes(targetItem))?.[0];
    if (groupAlias) {
      blueprint = allBlueprints[groupAlias];
    }
  }

  if (!blueprint) {
    return;
  }

  const sequence = blueprint.sequence ?? [];
  const ingredientsMap = (blueprint.ingredients && typeof blueprint.ingredients === 'object') ? blueprint.ingredients : {};

  for (const step of sequence) {
    if (!step || typeof step.item !== 'string') {
      watcher.warn(TAG, `Blueprint step is invalid or missing item: ${JSON.stringify(step)}`);
      continue;
    }

    const stepItem = step.item;
    const originalGroup = OBJECT_GROUPS[stepItem] ? stepItem : null;
    const resolvedItem = originalGroup ? resolveGroupItem(bot, stepItem) : stepItem;
    const makesPerOp = Number.isFinite(step.makes) ? Math.max(1, step.makes) : 1;

    if (typeof resolvedItem !== 'string' || !Number.isFinite(makesPerOp)) {
      watcher.warn(TAG, `Skipping invalid step: item=${resolvedItem}, makes_per=${makesPerOp}`);
      continue;
    }

    if (originalGroup === 'planks') {
      variantState.lastPlank = resolvedItem;
    }

    const mcDataRes = require('minecraft-data')(bot.version);
    const resItemData = mcDataRes.itemsByName[resolvedItem];
    const currentHave = resItemData ? bot.inventory.count(resItemData.id) : 0;
    const deficit = Math.max(0, targetCount - currentHave);
    const opsNeeded = deficit > 0 ? Math.max(1, Math.ceil(deficit / makesPerOp)) : 0;

    const fromItems = Array.isArray(step.from) ? step.from : [step.from];
    for (const dep of fromItems.filter(Boolean)) {
      const depResolvedName = OBJECT_GROUPS[dep] ? resolveGroupItem(bot, dep) : dep;
      let ingredientKey = dep;
      if (!(ingredientKey in ingredientsMap)) {
        const groupKey = Object.entries(OBJECT_GROUPS).find(([_g, items]) => items.includes(depResolvedName))?.[0];
        if (groupKey && (groupKey in ingredientsMap)) ingredientKey = groupKey;
      }
      const perOpNeed = Number.isFinite(ingredientsMap[ingredientKey]) ? ingredientsMap[ingredientKey] : 1;
      // Tracks each parent→child edge's own total, not the child's: two different parents may both
      // order the same ingredient and their contributions sum (Law 7). A re-walk sends only the delta
      // above what this edge already asked for.
      const edgeKey = `${targetItem}→${depResolvedName}`;
      const edgeWants = perOpNeed * opsNeeded;
      const alreadySent = sent.get(edgeKey) || 0;
      const delta = edgeWants - alreadySent;
      if (delta > 0) {
        sent.set(edgeKey, edgeWants);
        resolveBlueprintRecursive(bot, depResolvedName, allBlueprints, resolved, path, variantState, delta, demand, sent);
      }
    }

    let station = extractStation(step) || extractStation(blueprint);
    if (!station && Array.isArray(blueprint.requires)) {
      const knownStations = ['crafting_table', 'furnace'];
      station = blueprint.requires.find(r => knownStations.includes(r));
    }

    _raiseOrPush(resolved, {
      item: resolvedItem,
      target: targetCount,
      makes_per: makesPerOp,
      ...(originalGroup && { from: originalGroup, group_resolved_as: resolvedItem }),
      ...(station && { station })
    });
  }

  if (!sequence.length) {
    const isWoodenTool = /^wooden_(pickaxe|axe|shovel|sword|hoe)$/.test(targetItem);
    const finalItem = (
      isWoodenTool && variantState.lastPlank
        ? resolveToolVariant(targetItem, variantState.lastPlank)
        : targetItem
    );
    let station = null;
    const blueprintForFinal = allBlueprints[finalItem] || allBlueprints[targetItem];
    station = extractStation(blueprintForFinal);
    if (!station && Array.isArray(blueprintForFinal?.requires)) {
      const knownStations = ['crafting_table', 'furnace'];
      station = blueprintForFinal.requires.find(r => knownStations.includes(r));
    }
    _raiseOrPush(resolved, { item: finalItem, target: targetCount, makes_per: 1, ...(station && { station }) });
  }
}

const _aliasSaid = new Set();
function resolveBlueprint(bot, targetItem, quantity = 1) {
  // Reads the registry's boot-time snapshot, so an in-place file edit cannot crash a plan mid-run; an
  // edit is reported at warn level. No catch and no `{}` fallback (Law 13): an unreadable recipe book
  // must throw, never read downstream as this item is uncraftable.
  const blueprintData = craftingRegistry.getRecipes();

  let actualTarget = targetItem;
  const directMatch = blueprintData[targetItem];
  if (!directMatch) {
    const alias = Object.entries(OBJECT_GROUPS).find(([_, list]) => list.includes(targetItem))?.[0];
    if (alias) {
      // Said once per item: every later resolve of the same item takes the same alias.
      if (!_aliasSaid.has(targetItem)) {
        _aliasSaid.add(targetItem);
        watcher.summary(TAG, `Falling back to group alias for "${targetItem}" — "${alias}"`);
      }
      actualTarget = alias;
    } else {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): Cannot resolve target item: ${targetItem}`);
    }
  }

  const resolvedSequence = [];
  resolveBlueprintRecursive(bot, actualTarget, blueprintData, resolvedSequence, new Set(), {}, quantity);

  const filtered = resolvedSequence.filter(step => step && step.item && step.target != null);
  for (const s of filtered) {
    if (!Number.isFinite(s.target)) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): Invalid step schema for item ${s.item}; requires numeric target`);
    }
  }
  if (filtered.length === 0) throw new Error(`[${TAG}] CODING VIOLATION (Law 13): No valid steps in resolved sequence for ${targetItem}`);

  return { steps: filtered };
}

// ---------------------------------------------------------------------------
// SECTION 3 — Station management
// ---------------------------------------------------------------------------

async function tryScanNearbyStation(bot, stationType) {
  await combatCheckpoint(bot, 'craft');

  const entry = stationRegistry.findStation(stationType);
  if (entry && entry.pos) {
    const pos = new Vec3(entry.pos.x, entry.pos.y, entry.pos.z);
    let block = bot.blockAt(pos);
    // A registered station reading null here may mean its chunk isn't loaded ("far"), not that it's
    // gone ("stale") — walk to it first, then re-verify. Uses goToStationStance, never a bare
    // coordinate, since a bare coordinate is a stand-here order the navigator may dig out to make
    // occupiable, destroying the station being reused; the walk always runs and its result is read.
    const nav = await locomotion.goToStationStance({ x: pos.x, y: pos.y, z: pos.z });
    if (!nav.arrived) {
      watcher.warn(TAG, `registered ${stationType} at ${pos} is not usable from here (${nav.reason}) — `
        + `falling through to a local scan, then to placing one.`);
    } else {
      // Re-read AFTER arriving: the row said a station is here, and the world is what confirms it.
      // goToStationStance has already faced the block, so there is no lookAt to repeat here.
      block = bot.blockAt(pos);
      if (block && block.name === stationType) return block;
      watcher.warn(TAG, `Registry says ${stationType} at ${pos} but world has "${block?.name || 'null'}" after navigation — stale`);
    }
  }

  const botPos = bot.entity.position.floored();
  const R = Math.ceil(STATION_REACH);
  let best = null;
  let bestDist = Infinity;
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        const pos = botPos.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (block && block.name === stationType) {
          const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
          if (dist < bestDist) { best = block; bestDist = dist; }
        }
      }
    }
  }

  if (best) {
    await bot.lookAt(best.position.offset(0.5, 0.5, 0.5));
    return best;
  }

  return null;
}

// THE CREW HAS ONE TABLE, AND IT IS THE HOME BLUEPRINT'S. This file never sets a table down: a craft that needs
// one walks to the registered table (tryScanNearbyStation), which the home blueprint's own build places. With
// none standing yet the step soft-fails, and job_gates.craftStationGate holds the job until it stands.

// Smelting is not synchronous and not here — it belongs to the async furnace_executor load-and-leave
// chain (Law 16). This file crafts at a crafting_table only; a furnace step defers to that chain — see
// the `stationType === 'furnace'` branch in craftWithSequence.

// ---------------------------------------------------------------------------
// SECTION 5 — Execution engine
// ---------------------------------------------------------------------------

// Sweeps residue out of the player crafting area — the cursor, the result slot (0), the 2x2 grid
// (1-4) — back into main inventory. mineflayer's bot.craft can desync and leave output on the cursor or
// in a grid slot, where bot.inventory.count() cannot see it and the server ejects it on disconnect.
// Cursor clears first, since putAway needs a free cursor. Idempotent and near-free when already clean.
async function clearCraftingResidue(bot) {
  const win = bot.inventory;                      // player window: slot 0 = result, 1-4 = 2x2 grid
  if (!win || !Array.isArray(win.slots)) return;
  if (win.selectedItem) {
    const empty = typeof win.firstEmptyInventorySlot === 'function' ? win.firstEmptyInventorySlot() : null;
    if (empty != null) await guardExternal(TAG, 'clickWindow to clear the crafting cursor', () => bot.clickWindow(empty, 0, 0));
  }
  for (const s of [0, 1, 2, 3, 4]) {
    if (win.slots[s]) await guardExternal(TAG, `putAway crafting slot ${s}`, () => bot.putAway(s));
  }
}

// The true count of an item broken out by where it sits: bot.inventory.count() sees only main+hotbar,
// but a fresh craft can leave output in the result slot, the grid, or on the cursor. Completion is
// verified against `total` so stranded output still counts as made (same slot layout as
// clearCraftingResidue, Law 16).
function locateCraftedItem(bot, itemId) {
  const win = bot.inventory;
  const inv = win ? win.count(itemId) : 0;
  let cursor = 0, result = 0, grid = 0;
  const sel = win && win.selectedItem;
  if (sel && sel.type === itemId) cursor = sel.count;
  if (win && Array.isArray(win.slots)) {
    if (win.slots[0] && win.slots[0].type === itemId) result = win.slots[0].count;
    for (const s of [1, 2, 3, 4]) {
      const it = win.slots[s];
      if (it && it.type === itemId) grid += it.count;
    }
  }
  return { inv, cursor, result, grid, total: inv + cursor + result + grid };
}

// ── CAN THE OUTPUT LAND AT ALL? (Law 13 — prove it is safe to act, do not act and find out) ─────────
// A full pocket makes bot.craft consume an ingredient with nowhere for the output to land, silently.
// The test is not `emptySlotCount() > 0` alone — a craft can also land by topping up a stack with room
// — so it checks no empty slot AND no room in any existing stack. Fails open (Law 23): an unreadable
// free count is not evidence of a full one.
function outputHasNowhereToLand(bot, itemId) {
  const inv = bot && bot.inventory;
  if (!inv || typeof inv.emptySlotCount !== 'function' || typeof inv.items !== 'function') return false;
  if (inv.emptySlotCount() > 0) return false;
  // Resolved here, matching this file's other three sites: `mcData` is a per-function local keyed on
  // `bot.version`, never a module constant, so a helper that wants it asks for it the same way (Law 16
  // — one way to reach minecraft-data in this file).
  const mcData = require('minecraft-data')(bot.version);
  const stackSize = (mcData.items[itemId] && mcData.items[itemId].stackSize) || 64;
  const roomInStacks = inv.items()
    .filter(i => i && i.type === itemId)
    .reduce((n, i) => n + Math.max(0, stackSize - i.count), 0);
  return roomInStacks <= 0;
}

// `ctx` is the batch's shared workspace, created once per batch by newCraftContext(), not once per
// order, so a second order finds the table already in `ctx.stationContext` and reuses it without a
// walk, place or verify. The table outlives the batch too — see THE TABLE IS NOT TAKEN BACK UP above.
function newCraftContext() {
  return {
    stationContext: new Map(),
    placedStations: [],
    // No smelt counters here (Law 16, Law 25): smelting is furnace_executor's one pathway, and this
    // file never runs a furnace, so a counter for that verb belongs to the unit that owns it.
    metrics: { crafts_ok: 0, crafts_fail: 0, stations_placed: 0, stations_reused: 0 },
  };
}

async function craftWithSequence(bot, sequence, ctx) {
  if (!ctx || !(ctx.stationContext instanceof Map) || !Array.isArray(ctx.placedStations) || !ctx.metrics) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): craftWithSequence needs the batch context from newCraftContext(). Got: ${JSON.stringify(ctx)}`);
  }
  const mcData = require('minecraft-data')(bot.version);
  const { stationContext, placedStations, metrics } = ctx;
  let aborted = false;

  async function ensureStation(type) {
    await combatCheckpoint(bot, 'craft');
    // ── THE CACHED STATION IS RE-SENSED, NOT TRUSTED (Invariant B) ────────────────────────────────
    // Combat can move the body between orders in the same batch, so a cached block may not still be
    // there or in reach. Two cheap reads settle it; on a miss the entry drops and the normal
    // scan/place path runs.
    if (stationContext.has(type)) {
      const cached = stationContext.get(type).block;
      const still = cached ? bot.blockAt(cached.position) : null;
      if (still && still.name === type && bot.entity.position.distanceTo(cached.position) <= STATION_REACH + 1) {
        return still;
      }
      note(`${type} in context is stale (${still ? 'out of reach' : 'gone'}) — re-acquiring`);
      stationContext.delete(type);
      // Drop its ledger row too. Left in, cleanup would later walk to a remembered position holding
      // something else and dig THAT — the ledger must not outlive the belief it was written from.
      for (let i = placedStations.length - 1; i >= 0; i--) {
        if (placedStations[i].type === type && placedStations[i].block === cached) placedStations.splice(i, 1);
      }
    }

    // Furnaces are furnace_executor's alone (Law 16). A furnace-output intermediate must already be
    // in inventory from an earlier sweep; if it isn't, the dependent step soft-fails to replan and
    // job_board posts the furnace load. ensureStation never places a furnace; it returns null for that type.
    if (type === 'furnace') return null;

    let block = await tryScanNearbyStation(bot, type);
    const cleanup = false;
    if (block) {
      // One question: did the body get somewhere it can use this? goToStationStance answers it for the
      // blueprint's anchor by measuring reach directly.
      const nav = await locomotion.goToStationStance({ x: block.position.x, y: block.position.y, z: block.position.z });
      if (!nav.arrived) {
        watcher.warn(TAG, `${type} at ${block.position} could not be reached to use (${nav.reason}).`);
        block = null;
      } else {
        const fresh = bot.blockAt(block.position);
        if (!fresh || fresh.name !== type) {
          watcher.warn(TAG, `${type} at ${block.position} gone after navigation`);
          block = null;
        } else {
          block = fresh;
        }
      }
    }
    if (block) {
      metrics.stations_reused++;
      stationContext.set(type, { block, cleanup });
      placedStations.push({ type, block, cleanup });
      return block;
    }

    // No usable home table: the caller soft-fails to recursive_judge (Law 13/15) and the board holds the
    // craft until the home blueprint's table stands.
    watcher.warn(TAG, `No usable ${type} at home — soft-fail to replan`);
    return null;
  }

  // Start from a clean crafting area so residue a prior op stranded (cursor/grid) can't corrupt
  // this sequence's counts or drop on a later disconnect.
  await clearCraftingResidue(bot);
  fillCoalsTag(bot);

  for (const step of sequence) {
    await combatCheckpoint(bot, 'craft');
    const stationType = step.station || null;
    const itemData = mcData.itemsByName[step.item];
    if (!itemData) {
      watcher.warn(TAG, `Item data not found for ${step.item}`);
      continue;
    }
    const itemId = itemData.id;
    const target = effectiveTarget(step);
    const current = locateCraftedItem(bot, itemId).total;
    if (current >= target) {
      continue;
    }

    if (stationType === 'furnace') {
      // Smelting is out of the synchronous craft path (Law 16); the item must already be in inventory
      // from a prior furnace sweep. Leaving the step unmet here soft-fails the craft and job_board
      // posts a furnace load — a deferral, not a smelting failure.
      watcher.summary(TAG, `${step.item} needs smelting — deferred to the furnace chain (not smelted synchronously)`);
      continue;
    }

    let craftingStation = null;
    let recipes = bot.recipesFor(itemId, null, null, null);
    if (!recipes || recipes.length === 0) {
      craftingStation = await ensureStation('crafting_table');
      await sleep(100);
      recipes = bot.recipesFor(itemId, null, null, craftingStation);
    }
    if (!recipes || recipes.length === 0) {
      // `recipesFor` filters by what the bot holds, so an empty list is ambiguous between a missing
      // recipe and a materials shortage. `recipesAll` ignores inventory and separates them: an existing
      // but unfillable recipe is a shortage, a nonexistent one is a bad blueprint or item name. Reported,
      // not thrown — the caller's final-count check owns the soft-fail (Law 13, Law 25).
      const known = bot.recipesAll(itemId, null, craftingStation);
      watcher.warn(TAG, (known && known.length > 0)
        ? `Cannot craft ${step.item} — the recipe exists but the ingredients are not in inventory`
        : `No recipe exists for ${step.item}${craftingStation ? ' even with a crafting table' : ''} — check the item name/blueprint`);
      continue;
    }
    const craftStart = locateCraftedItem(bot, itemId).total;
    while (locateCraftedItem(bot, itemId).total < target) {
      await combatCheckpoint(bot, 'craft');
      // Re-fetched every batch, not captured once: recipesFor returns only what the bot can craft with
      // what it holds right now, so this tracks a scarce input draining across batches. An empty list
      // mid-run is an ordinary shortage, not a craft failure — the step stays unmet and soft-fails to
      // replan.
      const batchRecipes = bot.recipesFor(itemId, null, null, craftingStation);
      if (!batchRecipes || batchRecipes.length === 0) {
        note(`${step.item}: ran out of ingredients at ${locateCraftedItem(bot, itemId).total}/${target} — restock needed (deferring to replan)`);
        break;
      }
      const recipe = batchRecipes[0];

      // Checked before the craft, not after — see outputHasNowhereToLand. Reported as a room shortage,
      // distinct from a craft failure since the two need opposite responses; a retry here costs
      // another log (Law 25).
      if (outputHasNowhereToLand(bot, itemId)) {
        const held = locateCraftedItem(bot, itemId).total;

        // ── FULL POCKET AND NOWHERE TO DUMP IS A WEDGE, SAID LOUDLY AND NEVER THROWN ──────────────
        // A deadlock: emptying the pocket needs a chest, getting one needs crafting, and crafting needs
        // a free slot it has none of. Not a coding violation: an ordinary chest loss or an early run
        // with no chest yet both build this honestly. The craft is refused, so ingredients are never
        // consumed into an output with nowhere to land (Law 25). With a chest registered the state is
        // recoverable and reported as a room shortage.
        const chests = require('@perception/station_registry').findChests();
        if (!chests.length) {
          const why = `cannot craft ${step.item}: the pocket is FULL (0 empty slots, no partial ${step.item} stack with room) `
            + `and there is NO CHEST REGISTERED to dump into, so the output would have nowhere to land — and a chest cannot be `
            + `crafted to fix it for the same reason. NOT crafting: bot.craft would consume the ingredients and lose the result. `
            + `This clears as soon as a chest exists (the headframe carries one at anchor 0) or the pocket is emptied by hand. `
            + `If a chest was registered before, check whether it was broken.`;
          watcher.warn(TAG, why);
          note(`${step.item}: pocket full and no chest registered — needs a chest or a manual dump, not another craft attempt`);
          // Same exit the recoverable branch below uses: the function's tail already reports what the
          // batch made, so a separate return shape here would be a second contract for one outcome (Law 16).
          break;
        }

        watcher.warn(TAG, `no room to craft ${step.item}: the pocket is FULL (0 empty slots, no partial ` +
          `${step.item} stack with space) and holds ${held}/${target}, but ${chests.length} chest(s) are ` +
          `registered — so this is recoverable. NOT crafting: bot.craft would consume the ingredients and ` +
          `the output would have nowhere to land, which is a silent loss of material. This is a shortage ` +
          `of ROOM, not a crafting fault; the pocket has to be dumped before this order can progress.`);
        note(`${step.item}: pocket full at ${held}/${target} — needs offloading, not another craft attempt`);
        break;
      }

      const beforeCraft = locateCraftedItem(bot, itemId).total;
      // One line per craft attempt capturing the station, window type and duration. Emitted directly,
      // not through the note buffer, since rising craft_ms across a run is a connection/tick-degradation
      // signal that a buffered line would hide.
      const stationDesc = craftingStation
        ? `table@(${craftingStation.position.x},${craftingStation.position.y},${craftingStation.position.z})`
        : '2x2-inventory';
      const winBefore = bot.currentWindow ? bot.currentWindow.type : 'none';
      const craftT0 = Date.now();
      // The item book reads what the recipe took and what it gave off the pocket itself.
      const book = require('@kernel/item_book');
      await book.open();
      const crafted = await guardExternal(TAG, `bot.craft ${step.item} @ ${stationDesc}`, async () => {
        await bot.craft(recipe, 1, craftingStation);
        await sleep(AFTER_CRAFT_SLEEP_MS);
      });
      await book.close('craft', 'crafting');
      if (!crafted.ok) {
        watcher.warn(TAG, `WINDOW craft ${step.item} @ ${stationDesc} — bot.craft FAILED after ${Date.now() - craftT0}ms (win ${winBefore}→${bot.currentWindow ? bot.currentWindow.type : 'closed'})`);
        metrics.crafts_fail++;
        break;
      }
      metrics.crafts_ok++;
      watcher.summary(TAG, `WINDOW craft ${step.item} @ ${stationDesc} — bot.craft OK in ${Date.now() - craftT0}ms (win ${winBefore}→${bot.currentWindow ? bot.currentWindow.type : 'closed'})`);
      // Reclaims crafted output into main inventory so nothing ejects on disconnect. Completion is
      // verified against locateCraftedItem().total, never main-inventory count alone, so a craft whose
      // output landed off-inventory is not mistaken for a no-op and re-crafted forever.
      await clearCraftingResidue(bot);
      await book.close('craft', 'crafting');
      const loc = locateCraftedItem(bot, itemId);
      const afterCraft = loc.total;
      const stranded = loc.cursor + loc.result + loc.grid;
      if (stranded > 0) {
        watcher.warn(TAG, `craft output stranded off main-inventory: ${step.item} total=${loc.total}/${target} split[inv=${loc.inv} cursor=${loc.cursor} result=${loc.result} grid=${loc.grid}] — counted as made; clearCraftingResidue did not fully stow it (recurring craft-output bug, inspect here).`);
      }
      // No-op safety net (Law 13): the total across all locations did not rise, so the output genuinely
      // never materialized, distinct from merely landing off-inventory. Breaks on the first no-op so the
      // loop cannot burn ingredients pass after pass; the step stays unmet and soft-fails to replan.
      if (afterCraft <= beforeCraft) {
        const free = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : '?';
        const ing = Array.isArray(recipe.delta)
          ? recipe.delta.map(d => `${mcData.items[d.id]?.name || d.id}:${bot.inventory.count(d.id)}(${d.count})`).join(' ')
          : 'n/a';
        watcher.warn(TAG, `craft no-op: ${step.item} total did not rise (${beforeCraft}→${afterCraft}/${target}) though bot.craft resolved — split[inv=${loc.inv} cursor=${loc.cursor} result=${loc.result} grid=${loc.grid}], free_slots=${free}, table=${craftingStation ? 'yes' : 'no'}, delta[have(Δ)]=${ing}. Output never materialized (not mere stranding) — breaking to replan instead of spinning to a strict kill.`);
        metrics.crafts_fail++;
        break;
      }
      const pjCraft = await portableJudge.checkpoint(TAG, `craft ${step.item}: ${afterCraft}/${target}`, 'forgiving');
      if (pjCraft === false) return { success: false, reason: 'portable_judge_escalated', have: afterCraft, target };
    }
    const craftEnd = locateCraftedItem(bot, itemId).total;
    if (craftEnd > craftStart) {
      note(`${step.item} craft ${craftStart}→${craftEnd}/${target} (+${craftEnd - craftStart})`);
    }
  }

  // Final sweep: guarantee the crafting area is empty when we hand control back, so a disconnect
  // mid-loop or any residue from the last step can never eject items on exit.
  await clearCraftingResidue(bot);

  portableJudge.done(TAG);

  const finalStep = sequence[sequence.length - 1];
  if (!finalStep) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): resolved sequence has no steps — resolveBlueprint should have rejected this`);
  }
  const finalItemData = mcData.itemsByName[finalStep.item];
  if (!finalItemData) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): final step item "${finalStep.item}" is not a recognized minecraft-data item — bad blueprint entry`);
  }
  const requiredFinal = effectiveTarget(finalStep);
  // Counts the final item everywhere, same reason as the loop: if the final sweep above did not fully
  // stow the last batch, main-inventory count alone would under-report a craft that actually succeeded.
  const finalLoc = locateCraftedItem(bot, finalItemData.id);
  const finalCount = finalLoc.total;
  const success = finalCount >= requiredFinal;
  return { success, placedStations, metrics, aborted, finalItem: finalStep.item, finalCount, requiredFinal };
}

// ---------------------------------------------------------------------------
// SECTION 6 — Caller abandonment (Law 15)
// ---------------------------------------------------------------------------

function _abandon(reason) {
  watcher.warn(TAG, `Abandoning caller — ${reason}`);
  routeToJudge(TAG, { result: TAG, success: false, readable: `${TAG}: ${reason}` });
}

// ---------------------------------------------------------------------------
// SECTION 7 — Public API
// ---------------------------------------------------------------------------

// ── THE ORDER BOOK IS THE UNIT OF WORK, NOT THE ORDER ───────────────────────────────────────────────
// craftBatch is the one implementation (Law 16); craftItems is a one-order book on top of it, so a
// single-item and a five-item caller run the same machine. Shared across the batch: the crafting table,
// the phase-note buffer, the running counters. Not shared: resolution — each order is expanded by
// resolveBlueprint on its own, against inventory as it stands at that moment, since a step's `target` is
// an absolute total and concatenating sequences would let a shared ingredient skip as already satisfied
// after an earlier order's consumer ate it. The ordering problem this leaves (consumers before the
// intermediates they eat) belongs to the caller — preconstruction sorts its list for that reason.
//
// A failed order does not end the batch; the loop records the verdict and moves on. The one exception
// is a portable-judge escalation, which stops the whole book.
async function craftBatch(bot, orders, payload) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): craftBatch needs a non-empty order list. Got: ${JSON.stringify(orders)}`);
  }
  for (const o of orders) {
    if (!o || typeof o.item !== 'string' || !Number.isFinite(o.quantity) || o.quantity < 1) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): every craftBatch order needs {item:string, quantity:>=1}. Got: ${JSON.stringify(o)}`);
    }
  }

  // A POCKET WITH NO EMPTY SLOT BANKS ITS SURPLUS FIRST, before any table is walked to: a craft lands its
  // output in a free slot, so a full pocket would refuse every order in the batch. The bank is the mine
  // trip's own (inventory_swapper.dumpExcess, Law 16), and it runs only where a chest stands.
  if (bot.inventory.emptySlotCount() === 0 && require('@perception/station_registry').findChests().length > 0) {
    const banked = await require('@api/inventory_swapper').dumpExcess(bot);
    if (banked?.abandoned) return undefined;   // abandoned to the judge (Law 15) — this line is dead
    watcher.summary(TAG, `POCKET FULL before crafting ${orders.map(o => o.item).join(', ')} — banked ${banked?.dumped || 0} item(s); ${bot.inventory.emptySlotCount()} slot(s) free now`);
  }

  // Open the deferred phase buffer ONCE for the whole batch — all per-step detail (resolution,
  // craft deltas, station place/cleanup) accumulates here and posts as ONE summary below (Law 5).
  _phaseNotes = [];

  const mcDataEntry = require('minecraft-data')(bot.version);
  const ctx = newCraftContext();
  const results = [];
  let escalated = false;

  for (const order of orders) {
    const targetItem = order.item;
    const quantity = order.quantity;

    // Snapshot inventory at this order's entry so its `made` count describes this order, not the batch
    // — an earlier order may have produced or consumed the very item this one is about to weigh.
    const entryItemData = mcDataEntry.itemsByName[targetItem];
    const invAtEntry = entryItemData ? bot.inventory.count(entryItemData.id) : -1;

    // Resolve the target into an ordered dependency sequence (sense+plan)
    const sequence = resolveBlueprint(bot, targetItem, quantity).steps;

    // Counters are cumulative across the batch, so an order's own contribution is a DIFFERENCE, never
    // the running total (Law 25 — a number reported per-order must have been measured per-order).
    const before = { ...ctx.metrics };

    // Execute (act) — on the shared context, so the station survives into the next order
    const result = await craftWithSequence(bot, sequence, ctx);

    if (result.reason === 'portable_judge_escalated') {
      // The judge stopped this body. Record it honestly and stop the book; cleanup still runs below,
      // so the table does not get abandoned on the ground.
      results.push({
        item: targetItem, quantity, success: false, partial: false, made: 0,
        shortfall: quantity, finalItem: targetItem, finalCount: result.have ?? 0,
        requiredFinal: result.target ?? quantity, sequenceLength: sequence.length,
        progressTag: `${targetItem} have=${result.have ?? 0}/${result.target ?? quantity}`,
        reason: 'portable_judge_escalated',
        metrics: { crafts_ok: 0, crafts_fail: 0, stations_placed: 0, stations_reused: 0 },
        resolved: sequence.map(s => `${s.item}:${s.target}`).join(', '),
      });
      escalated = true;
      break;
    }

    const { success, finalItem, finalCount, requiredFinal } = result;
    const made = invAtEntry >= 0 ? finalCount - invAtEntry : finalCount;
    const orderMetrics = {
      crafts_ok: ctx.metrics.crafts_ok - before.crafts_ok,
      crafts_fail: ctx.metrics.crafts_fail - before.crafts_fail,
      stations_placed: ctx.metrics.stations_placed - before.stations_placed,
      stations_reused: ctx.metrics.stations_reused - before.stations_reused,
    };
    results.push({
      item: targetItem,
      quantity,
      success,
      // ── SHORT OF THE ORDER, BUT SOMETHING WAS MADE ────────────────────────────────────────────
      // A craft that runs out of an ingredient half way is the normal end of a pull chain, not a
      // failure. `success` stays false and `partial` carries the true counts; only the book declines
      // to fail over a shortfall.
      partial: !success && made > 0,
      made,
      shortfall: requiredFinal - finalCount,
      metrics: orderMetrics,
      finalItem,
      finalCount,
      requiredFinal,
      sequenceLength: sequence.length,
      progressTag: `${finalItem} have=${finalCount}/${requiredFinal}`,
      invAtEntry,
      resolved: sequence.map(s => `${s.item}:${s.target}`).join(', '),
    });
  }

  // NOTHING IS TAKEN BACK UP HERE — the table is permanent, and the reasoning lives above
  // `newCraftContext`.

  const notes = _phaseNotes || [];
  _phaseNotes = null;
  const detail = notes.length ? notes.join(' · ') : 'no work';

  // A batch succeeds if every order made something. An order that produced nothing is still a failure;
  // one that produced less than asked for is carried forward. `all_filled` below says whether the
  // numbers were actually met.
  const met = (r) => r.success || r.partial;
  const batchSuccess = !escalated && results.length === orders.length && results.every(met);
  const shortList = results.filter(r => !met(r))
    .map(r => `${r.item} ${r.finalCount}/${r.requiredFinal}`).join(', ');
  const bookLine = results.map(r => {
    if (r.success) return `${r.item} x${r.quantity} ✓`;
    if (r.partial) return `${r.item} x${r.quantity} partial +${r.made} short ${r.shortfall}`;
    return `${r.item} x${r.quantity} FAILED ${r.finalCount}/${r.requiredFinal}`;
  }).join(' | ');

  // One consolidated summary for the whole craft phase (Law 5). `tables` says whether the shared
  // station actually held — one place for a five-order book, not five.
  watcher.summary(TAG,
    `craft book ${results.length}/${orders.length} order(s) — ${bookLine} | ` +
    `tables placed=${ctx.metrics.stations_placed} reused=${ctx.metrics.stations_reused} | ` +
    `crafts ok=${ctx.metrics.crafts_ok} fail=${ctx.metrics.crafts_fail} | ${detail}`);

  if (!batchSuccess) {
    // Environmental failure — caller abandonment (Law 15). The summary above already posted, so the
    // failure stays diagnosable after the abandon.
    const reason = escalated
      ? `crafting_failed portable_judge_escalated after ${results.length}/${orders.length} order(s)`
      : `crafting_failed ${shortList || 'unknown'} crafts_ok=${ctx.metrics.crafts_ok} crafts_fail=${ctx.metrics.crafts_fail}`;
    _abandon(reason);
    return;
  }

  // `success` means every order produced something, so it can be true over a book with a short order.
  // `all_filled` says whether every order actually met its number — separated so a reader of `success`
  // alone cannot mistake "filled" for "accepted as short" (Law 25). Per-order truth is always in `results`.
  return {
    success: true,
    all_filled: results.every(r => r.success),
    results,
    metrics: ctx.metrics,
    orders: orders.length,
  };
}

// The single-order front door: a batch of one resolves, executes and reports identically to before,
// keeping every existing caller's exact return shape including `undefined` on abandonment (Law 16).
async function craftItems(bot, targetItem, quantity, payload) {
  const qty = Math.max(1, Number(quantity) || 1);
  const batch = await craftBatch(bot, [{ item: targetItem, quantity: qty }], payload);
  if (!batch) return;                       // abandoned to the judge — this line is dead
  const r = batch.results[0];
  if (r.success) {
    return {
      success: true,
      metrics: r.metrics,
      finalItem: r.finalItem,
      finalCount: r.finalCount,
      requiredFinal: r.requiredFinal,
      sequenceLength: r.sequenceLength,
      progressTag: r.progressTag,
    };
  }
  // A SHORT ORDER, and the caller gets the true counts. craftBatch abandons only when an order produced
  // nothing at all, so reaching this line means something was made.
  return {
    success: false,
    partial: true,
    made: r.made,
    shortfall: r.shortfall,
    metrics: r.metrics,
    finalItem: r.finalItem,
    finalCount: r.finalCount,
    requiredFinal: r.requiredFinal,
    sequenceLength: r.sequenceLength,
    progressTag: r.progressTag,
  };
}

module.exports = { craftItems, craftBatch, PLANK_DERIVED_GROUPS, resolveGroupItem };
