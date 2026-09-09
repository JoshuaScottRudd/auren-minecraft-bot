// api: craft_handler
// purpose: Law 15 API — craftItems(bot, targetItem, quantity, payload) resolves a
//          target item into an ordered dependency sequence (blueprint expansion),
//          then executes each step: ensure a station exists, craft until the step's
//          target is met, return result.
//          Called directly by craft_executor (and available to any fragment that
//          needs on-demand crafting). No signal-bus entry point.
//
// THIS FILE BREAKS NOTHING. It places crafting tables and never takes one back up
// (Architect 2026-09-07 — see THE TABLE IS NOT TAKEN BACK UP, below), so it holds no
// dig verb at all and imports none. A craft that needs a cell cleared is asking the
// wrong unit; the answer is a different placement spot, which is what the placement
// search already returns.
//
// NESTED API (Law 15): craft_handler calls the locomotion API (goTo) to reach
// distant stations. Locomotion owns its own abandonment clause — if it can't
// reach the station it returns arrived=false. craft_handler treats that as an
// environmental failure and abandons the caller (Law 15 caller abandonment),
// originating a fresh signal to recursive_judge.
//
// invariants:
//  - Resolution expands a target item into dependency-ordered steps using
//    crafting_blueprints.json. Group items (logs, planks) are resolved to the
//    best-inventory variant. Recursive dependency unfolding uses a visited set
//    to prevent cycles.
//  - TARGET-BASED, ABSOLUTE SEMANTICS (Law 10): every step's `target` is the
//    DESIRED TOTAL inventory count AFTER this step — not a delta. The loop is
//    "craft/smelt one operation, then check inventory.count(item) >= target."
//  - Only the LAST step's item/target decides overall success.
//  - Coding violations (unresolvable items, empty sequence, no-op dispatch)
//    throw immediately (Law 13).
//  - Environmental failure (crafting_failed) triggers caller abandonment.
//  - Success returns { success, metrics, finalItem, finalCount, requiredFinal,
//    sequenceLength } to the caller.
//  - THREE OUTCOMES, NOT TWO. A craft that runs out of an ingredient part way
//    through is a PARTIAL, and it is the ordinary end of a pull chain rather
//    than a fault — material is never withheld from a craft that can spend it.
//    Whether a short delivery counts is the CALLER's to declare, never this
//    module's to assume, so a partial is only returned to a caller that asked
//    for one with `{ allowPartial: true }`; everyone else keeps the
//    all-or-nothing abandonment unchanged. The partial return carries
//    `success: false, partial: true` with the true counts — a shortfall never
//    wears a success flag (Law 25).

'use strict';

const path = require('path');
const { Vec3 } = require('vec3');
const watcher = require('@kernel/watcher');
const { group_to_item: OBJECT_GROUPS, BLOCK_REACH, hasLineOfSightToBlock } = require('@utils/fragment_utils');
const { routeToJudge } = require('@utils/signal_utils');
// Entered through combatCheckpoint, never battleStations directly (Architect 2026-08-08: "remove it
// from the callers"). One process-wide 500 ms clock, shared with the dig and drive primitives that now
// carry the same gate, plus the engaging/escaping bypass so combat's own arms cannot re-enter it. The
// whole reasoning is in its header; a call a primitive already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const { performPlace } = require('@utils/movement/place_authority');
const { classifyFloor } = require('@utils/movement/terrain_predicates');
const stationRegistry = require('@perception/station_registry');
const craftingRegistry = require('@kernel/crafting_blueprint_registry');
const locomotion = require('@locomotion/locomotion_dispatcher');

const portableJudge = require('@kernel/portable_judge');
const { guardExternal, guardExternalSync } = require('@utils/external_library_guard');

const TAG = 'craft_handler';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Deferred phase notes (Law 5: accumulate-then-post). A single craftItems() call
// used to emit ~6 summary lines (request, resolution JSON, per-step craft delta,
// station place/cleanup, final result) — and several crafts fire back-to-back, so
// the console flooded. Instead we push each piece of per-step detail into this
// buffer and post ONE consolidated summary when the whole phase completes. Nothing
// is removed — every count/coordinate the old lines carried is folded into that one
// line. Module-level temporary state is safe here: Law 4 guarantees only one craft
// runs at a time. `null` means no phase is open, in which case note() falls back to
// an immediate summary so a stray call is never silently dropped.
let _phaseNotes = null;
function note(msg) {
  if (_phaseNotes) _phaseNotes.push(msg);
  else watcher.summary(TAG, msg);
}

const FINAL_OUTPUT_CONSTRAINTS = {
  ladder: { maxTotal: 64 }
};

// A LOCAL PLACE TIMEOUT USED TO LIVE HERE (1500 ms, raced against bot.placeBlock) AND IT IS GONE. Two
// reasons, and the second is why its loss is a repair rather than a regression:
//   · It was a SECOND bound on a call that already has one. mineflayer's placeBlock waits on the real
//     server blockUpdate with its own 5000 ms timeout and REJECTS when it does not come, so the race was
//     two bounds on one call — and two bounds can only disagree (Law 16).
//   · Promise.race CANCELS NOTHING. The block_place packet is already on the wire when the local timer
//     fires, so "timed out" never meant "the placement failed", only "we stopped waiting". The station
//     could still land at the abandoned spot while the retry placed a second one somewhere else.
// WHAT IT COSTS, stated because it is real: a spot the server never answers for now occupies the full
// 5 s rather than 1.5 s before the next spot is tried, so a pathological run of refusals is slower.
// The common failures are unaffected — an unholdable item or a server revert throws immediately — and
// the loudest former cause of a no-answer cell (a placement inside spawn protection) is now refused
// before the packet is ever sent.
const AFTER_PLACE_SLEEP_MS = 200;
const POST_PLACE_SUCCESS_MS = 300;
// 4.5 — PLACEMENT and SCAN reach only: anywhere inside this is placed in situ, and it is the radius the
// nearby-station scan sweeps. It is NOT how close a bot must stand to USE a station: using one means
// standing on the blueprint anchor that owns it (locomotion.goToStationAnchor), which is a cell rather
// than a distance. This number now answers only "can I click to PLACE here" and "how far out shall I look
// for a table I could reuse".
const STATION_REACH = BLOCK_REACH;
const PLACE_SCAN_MAX = 32;           // outward ring-expansion cap for finding a place spot
const MAX_PLACE_ATTEMPTS = 16;       // Law-13 safety valve (distinct reachable spots tried), not the primary exit

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

const PLANK_DERIVED_GROUPS = new Set(['stairs', 'door', 'fence', 'slab']);

const WOOD_VARIANTS = {
  oak_planks: 'oak',
  birch_planks: 'birch',
  spruce_planks: 'spruce',
  jungle_planks: 'jungle',
  acacia_planks: 'acacia',
  dark_oak_planks: 'dark_oak'
};

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

  // planks follow the LOG SUPPLY, not the most-held plank (Architect 2026-07-18, "prefer craftable").
  // WHY: this used to return the most-held plank and only derive from logs when the bot held ZERO planks
  // (`maxCount <= 0`). A bot holding a few oak_planks but only birch_log then picked oak — a species it
  // cannot replenish (no oak_log) — and craft_handler looped on "No recipe found for oak_planks" until the
  // judge killed it (live standard test, TessaBot, round 50a). The variant a bot can PRODUCE is set by its
  // logs, so the log supply is the primary signal: pick the plank whose log the bot has the most of, and
  // fall back to the most-held plank only when it has no logs at all. Same Law 16 the 'fence' fix restored
  // (the group definition follows what you can make; oak was a wrong default) — applied to the plank itself.
  // Accepted trade-off (the ruling): a few already-held planks of another species may be stranded.
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

  // Groups whose variant follows the bot's plank species (birch_planks → birch_fence), not the
  // most-held member. Without 'fence' here a bot with zero fences falls to group[0]=oak_fence and
  // craft_handler tries to make oak_fence from birch_planks → "no recipe" halt in every non-oak
  // biome (Law 16: the 'fence' group is the definition; oak was a wrong second route).
  //
  // 'slab' joined 2026-08-05 and cost a soak to find: the composter's ingredient shipped with a group
  // but not a membership here, so a birch-biome bot resolved oak_slab and warned "No recipe found for
  // oak_slab" every pass — the composter simply never got built, with no error to wake anyone. THE
  // RULE, so the next group does not repeat it: any group whose members are `<species>_<group>` for the
  // plank species belongs here. Exported at module scope for a registry bench retired 2026-08-10
  // (`tools/README.md`); deriving this set from group_to_item and failing on a missing member is owed as
  // a load-time throw in the crafting registry. Until then a missing member is only noticed live.
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

function resolveBlueprintRecursive(bot, targetItem, allBlueprints, resolved = [], visited = new Set(), variantState = {}, targetCount = 1) {
  if (visited.has(targetItem)) return;
  visited.add(targetItem);

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
    // Unguarded: every call here is ours. A dropped dependency does not fail the plan — it produces a
    // plan that is SHORT one ingredient and looks complete, so the shortage surfaces much later as a
    // craft that cannot find its input, with nothing linking it back to the resolution that skipped it.
    for (const dep of fromItems.filter(Boolean)) {
      const depResolvedName = OBJECT_GROUPS[dep] ? resolveGroupItem(bot, dep) : dep;
      let ingredientKey = dep;
      if (!(ingredientKey in ingredientsMap)) {
        const groupKey = Object.entries(OBJECT_GROUPS).find(([_g, items]) => items.includes(depResolvedName))?.[0];
        if (groupKey && (groupKey in ingredientsMap)) ingredientKey = groupKey;
      }
      const perOpNeed = Number.isFinite(ingredientsMap[ingredientKey]) ? ingredientsMap[ingredientKey] : 1;
      const depTargetCount = perOpNeed * opsNeeded;

      resolveBlueprintRecursive(bot, depResolvedName, allBlueprints, resolved, visited, variantState, depTargetCount);
    }

    let station = extractStation(step) || extractStation(blueprint);
    if (!station && Array.isArray(blueprint.requires)) {
      const knownStations = ['crafting_table', 'furnace'];
      station = blueprint.requires.find(r => knownStations.includes(r));
    }

    resolved.push({
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
    resolved.push({ item: finalItem, target: targetCount, makes_per: 1, ...(station && { station }) });
  }
}

function resolveBlueprint(bot, targetItem, quantity = 1) {
  // Registry, not a live read. The old fs.readFileSync here ran on EVERY craft plan, and Law 13
  // correctly makes an unreadable declared file a throw — so deleting the file to upload a new one
  // (how the Architect actually edits it) killed the bot at the next craft. The registry snapshots at
  // boot, so that window is unobservable, and an edit is reported at warn level instead of silently
  // taking effect mid-run. Still no catch and still no `{}` fallback (r33/F7): that fallback turned an
  // unreadable recipe book into the confident world-claim "no recipes exist", which reads downstream as
  // "this item is uncraftable" rather than "we failed to read the book".
  const blueprintData = craftingRegistry.getRecipes();

  let actualTarget = targetItem;
  const directMatch = blueprintData[targetItem];
  if (!directMatch) {
    const alias = Object.entries(OBJECT_GROUPS).find(([_, list]) => list.includes(targetItem))?.[0];
    if (alias) {
      watcher.warn(TAG, `Falling back to group alias for "${targetItem}" — "${alias}"`);
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
    // Reuse-before-place (Architect): a registered station across the map reads as
    // null here because its chunk isn't loaded — that's "far", not "stale". Walk to
    // it FIRST, then re-verify; only a loaded-but-wrong block is truly stale. This is
    // what let the 2 Jul run ignore its own registered table and carve a throwaway.
    // NOT A BARE COORDINATE. A bare coordinate is a STAND-HERE order: the navigator must make that cell
    // occupiable, so it digs the station out for the feet and the block above for the head — destroying
    // the very station this function exists to reuse. That is not a hypothetical: on 2026-07-20 the
    // headframe's crafting_table(11,71,-20) and furnace(11,72,-20) vanished together, in pairs, three
    // times in one run ("gone after navigation"), the build executor re-placed them, and the building
    // never closed past 162/163. Same run, same cause: every 30-70s SLOW-NAV tripwire had goal
    // (11,71,-20) — a protected voxel A* had to price at the full detour budget, forcing an exhaustive
    // sweep of everything cheaper (136k-200k nodes at ANY hop length).
    //
    // THE STANCE IS THE BLUEPRINT'S ANCHOR (2026-08-31). Two searched stances came before it and both
    // were the same mistake: a raycast vantage, then a radius — each returns whichever acceptable cell is
    // cheapest from wherever the body is, and cheapest from outside a building is a cell outside the
    // wall. goToStationAnchor stands the body on the cell the blueprint already nominates for reaching
    // these voxels. `no_anchor` is not an error to recover from here: the registry entry named a station
    // no locked blueprint claims, so it falls through to the local scan below and, failing that, to a
    // fresh table — which is the correct answer for the one station that legitimately has no anchor.
    if (!block || block.name !== stationType) {
      await locomotion.goToStationAnchor({ x: pos.x, y: pos.y, z: pos.z });
      block = bot.blockAt(pos);
    }
    if (block && block.name === stationType) {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
      return block;
    }
    watcher.warn(TAG, `Registry says ${stationType} at ${pos} but world has "${block?.name || 'null'}" after navigation — stale`);
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

// scanPlaceRing: the floor cells on the square SHELL at Chebyshev radius `r` from the
// bot (max(|dx|,|dz|)===r) on which a station can sit — a safe walkable/jumpable surface
// (classifyFloor, single source of truth) whose cell ABOVE (where the station block lands)
// is air. The bot's own column is r=0, never scanned, so a station is never placed in the
// feet/head cell. Shell-only so the caller can expand OUTWARD cheaply (O(r) per ring) and
// stop at the first ring that yields a spot. Nearest first within the ring.
function scanPlaceRing(bot, r) {
  const bx = Math.floor(bot.entity.position.x);
  const by = Math.floor(bot.entity.position.y);
  const bz = Math.floor(bot.entity.position.z);
  const spots = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // shell only
      for (let dy = -2; dy <= 2; dy++) {
        const fx = bx + dx, fy = by + dy, fz = bz + dz;
        const floor = bot.blockAt(new Vec3(fx, fy, fz));
        if (!floor || floor.boundingBox !== 'block') continue;
        if (!classifyFloor(bot, floor)) continue;   // safe surface + clearance above
        // Spawn protection refuses the placement silently, so a spot inside the square would be
        // accepted here, walked to, clicked, and reported placed while nothing appeared — and the
        // caller would then hunt a station that does not exist. Dropped at the SCAN, which is the ring
        // expansion's own vocabulary for "not a spot": the search simply steps outward to the next
        // ring, and a bot standing at spawn ends up placing its table just outside the square instead
        // of failing sixteen attempts in a row.
        if (require('@perception/spawn_protection').isSpawnProtected(bot, fx, fz)) continue;
        spots.push({ x: fx, y: fy, z: fz, dist: Math.hypot(dx, dy, dz) });
      }
    }
  }
  spots.sort((a, b) => a.dist - b.dist);
  return spots;
}

// The station lands on the TOP face of a floor cell; these gate whether the bot can ACTUALLY place it
// from where it stands right now. This is the check the old scan lacked — it accepted any solid+air-above
// cell and left bot.placeBlock to fail on occluded/out-of-reach ones, timing out 16× without ever moving.
function faceCenter(floorVec) { return floorVec.offset(0.5, 1.0, 0.5); }
function withinPlaceReach(bot, floorVec) {
  return bot.entity.position.distanceTo(faceCenter(floorVec)) <= STATION_REACH;
}
function canPlaceFrom(bot, floorVec) {
  return withinPlaceReach(bot, floorVec) && hasLineOfSightToBlock(bot, floorVec, STATION_REACH);
}

// standingFeetFor: a feet-cell the bot can occupy ADJACENT to floorVec to place on it — the nearest
// horizontal neighbour that is itself a safe standing surface, so the bot stands BESIDE the station cell,
// never in it. This is what makes relocation deterministic: locomotion is handed a concrete "stand here,
// next to the open spot", not a direction to wander. null if the spot has no standable neighbour.
function standingFeetFor(bot, floorVec) {
  let best = null, bestDist = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const nb = bot.blockAt(new Vec3(floorVec.x + dx, floorVec.y + dy, floorVec.z + dz));
        if (!nb || nb.boundingBox !== 'block' || !classifyFloor(bot, nb)) continue;
        const feet = new Vec3(nb.position.x, nb.position.y + 1, nb.position.z);
        const d = bot.entity.position.distanceTo(feet);
        if (d < bestDist) { best = feet; bestDist = d; }
      }
    }
  }
  return best;
}

// A STATION FOR THE POCKET MAY NOT BE SET DOWN IN OR AGAINST BUILT WORK. This route places only the
// bot's own field stations — a blueprint's stations are placed by the build itself, from its own step
// list, and never come through here — so a station landing among protected voxels is a private
// convenience squatting in shared work: it cooks inside the shell while the walls go up around it, the
// build's own step then wants a cell an unrelated block occupies, and the only route back to the cell it
// stands on runs through a protected voxel, which A* prices at the full detour budget. Adjacency and not
// merely occupancy, because a station flush against a wall is still standing in the build's working
// volume; the six FACE neighbours are what physically contacts the station block, and a diagonal shares
// no face to press against.
//
// PROTECTED VOXELS ARE READ, NEVER RESTATED — `navigator.loadProtectedBlocks` is the single inspection
// point for "what does the bot refuse to chew through" (Law 16), and a second copy of that question here
// would go out of date the first time an integrity node joins its list.
//
// ── AND THE GROUND A BUILDING HAS ONLY CLAIMED, WHICH THE PROTECTED SET DELIBERATELY DOES NOT COVER ──
// A field table is PERMANENT now (see placeStation), so the question this gate has to answer got larger:
// not "would placing here damage finished work" but "will this block ever be in a builder's way". The
// protected set answers the first — it is diffed against the world on purpose, because pricing unbuilt
// terrain as protected once turned a 2-block hop into a 140,315-node search. A locked-but-unbuilt
// footprint is therefore invisible to it, and a table set down inside one stands there until the builder
// arrives and has to break it — which is exactly the digging that was just removed.
//
// So the two sets are read separately and unioned HERE, at the one caller that needs both. Merging them
// upstream would put planned cells back into A*'s pricing and reinstate that regression silently.
const STATION_TOUCH_OFFSETS = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function stationCellClear(excludedKeys, floorVec) {
  if (!excludedKeys) return true;   // pre-lock there is genuinely nothing built or claimed
  // The station lands on the TOP face, so the cell it occupies is one above the floor cell — and the
  // floor cell it rests on is that cell's [0,-1,0] neighbour, so "sitting on a protected block" is
  // already one of the seven and needs no separate test.
  const sx = floorVec.x, sy = floorVec.y + 1, sz = floorVec.z;
  for (const [dx, dy, dz] of STATION_TOUCH_OFFSETS) {
    if (excludedKeys.has(`${sx + dx},${sy + dy},${sz + dz}`)) return false;
  }
  return true;
}

// The union the gate above reads: what is BUILT (never damage it) plus what is CLAIMED (never stand in
// the way of it). Built once per placement, like the protected read it extends — both walk several
// perception nodes, which is a per-placement cost and not a per-ring one.
function stationExclusionKeys(bot) {
  const set = new Set();
  // Required lazily — navigator pulls in battle_stations, which this file also imports, so a top-level
  // require would close the cycle.
  const built = require('@locomotion/navigator').loadProtectedBlocks(bot);
  if (built) for (const k of built) set.add(k);
  const claimed = require('@perception/building_integrity').getAllFootprintCells();
  if (claimed) for (const k of claimed) set.add(k);
  return set.size > 0 ? set : null;
}

// nearestPlaceableCell (Architect design): PICK the spot, don't try-and-guess. Expand rings outward and
// return the NEAREST cell the bot can place on from where it stands (in reach + clear line of sight) — no
// move needed. If nothing in reach is clear, return the nearest genuine open spot that HAS a standable
// neighbour, tagged needsMove, so the caller walks the bot to that exact neighbour and places — "here's
// the closest open spot outside my reach, go stand by it", never a random step-away-and-retry. null only
// if nothing placeable exists within PLACE_SCAN_MAX (a sealed void — caller treats it as replan).
//
// THE PROTECTED-VOXEL GATE BELONGS ON THE ASK, NOT THE SERVE: the selection stops WANTING a cell in or
// against built work, rather than the placer discovering after the fact that it took one. The Set is
// passed in, never read here — building it walks three perception nodes, which is a once-per-placement
// cost, not a once-per-ring one.
function nearestPlaceableCell(bot, tried, excludedKeys) {
  let moveCand = null;
  for (let r = 1; r <= PLACE_SCAN_MAX; r++) {
    for (const s of scanPlaceRing(bot, r)) {
      const key = `${s.x}|${s.y}|${s.z}`;
      if (tried.has(key)) continue;
      if (!stationCellClear(excludedKeys, s)) continue;
      const floorVec = new Vec3(s.x, s.y, s.z);
      if (canPlaceFrom(bot, floorVec)) return { floorVec, key, needsMove: false };
      if (!moveCand) {
        const stand = standingFeetFor(bot, floorVec);
        if (stand) moveCand = { floorVec, key, needsMove: true, stand };
      }
    }
  }
  return moveCand;
}

// tryPlaceOn: equip, aim at the floor cell's top face, place, verify. Returns the placed
// block or null (obstructed / block changed under us). Non-throwing — a failed attempt just
// means "try another spot".
async function tryPlaceOn(bot, stationType, floorPos) {
  const item = bot.inventory.items().find(i => i.name === stationType);
  if (!item) return null;
  const floorBlock = bot.blockAt(floorPos);
  if (!floorBlock || floorBlock.boundingBox !== 'block') return null;
  // The one place route (Law 16) owns equip, the spawn-protection gate, the combat checkpoint, the aim
  // and the click. It carries NO timeout of its own and needs none: mineflayer's placeBlock already
  // waits on a real server block update with a 5 s bound and REJECTS if it does not arrive — which is
  // exactly what the local placeWithTimeout race that used to stand here was duplicating (Law 16: two
  // bounds on one call can only disagree).
  const attempt = await performPlace(bot, floorPos.offset(0, 1, 0), floorBlock, new Vec3(0, 1, 0), stationType, TAG, { settleMs: AFTER_PLACE_SLEEP_MS });
  if (!attempt.ok) return null;
  // The verdict is the world, not the call: a place the server silently dropped returns just like one
  // it accepted, so the only honest answer is what is standing there (Invariant B).
  const placed = bot.blockAt(floorPos.offset(0, 1, 0));
  if (placed?.name === stationType) {
    note(`placed ${stationType}@(${floorPos.x},${floorPos.y + 1},${floorPos.z})`);
    await sleep(POST_PLACE_SUCCESS_MS);
    return placed;
  }
  watcher.warn(TAG, `place verify failed for ${stationType}@(${floorPos.x},${floorPos.y + 1},${floorPos.z}) — got "${placed?.name || 'air'}"`);
  return null;
}

// placeStation (Architect design): find the nearest spot the bot can ACTUALLY place on and place there;
// if none is in reach with a clear line of sight, walk to the standing cell beside the nearest open spot
// and place — a deterministic "pick the spot, go stand by it, place", NOT the old "retry the same
// occluded cluster in place, or step away and guess". Locomotion is the ONE thing that may abandon this
// call (arrived=false = it genuinely cannot reach the chosen spot, Law 15). MAX_PLACE_ATTEMPTS is only a
// Law-13 valve — with reach+LOS selection a place resolves in one or two attempts; 16 distinct visible,
// reachable spots all failing to place means something is truly wrong → human inspection, not a spin.
// Cells in or against built work are excluded from the selection entirely — see stationCellClear.
async function placeStation(bot, stationType) {
  await combatCheckpoint(bot, 'craft');
  if (!bot.inventory.items().find(i => i.name === stationType)) {
    watcher.warn(TAG, `No ${stationType} item in inventory to place`);
    return null;
  }

  const tried = new Set();
  // Read ONCE for the whole placement, never once per ring or per attempt: each read walks every
  // PROTECTED_SOURCE and every locked conference-room chair. Nothing this loop does builds, destroys or
  // sites anything, so a second read would answer the same question at a higher price.
  const excludedKeys = stationExclusionKeys(bot);
  for (let attempt = 0; attempt < MAX_PLACE_ATTEMPTS; attempt++) {
    await combatCheckpoint(bot, 'craft');

    const cell = nearestPlaceableCell(bot, tried, excludedKeys);
    if (!cell) {
      watcher.warn(TAG, `No placeable cell within ${PLACE_SCAN_MAX} blocks for ${stationType} clear of built work and claimed footprints — replan`);
      return null;
    }
    tried.add(cell.key);

    if (cell.needsMove) {
      // Deterministic relocation: go stand at the specific cell beside the chosen open spot, then place.
      const nav = await locomotion.goTo({ x: cell.stand.x, y: cell.stand.y, z: cell.stand.z });
      if (!nav || nav.arrived === false) {
        watcher.warn(TAG, `locomotion could not reach stance (${cell.stand.x},${cell.stand.y},${cell.stand.z}) beside ${stationType} spot — abandoning place (Law 15)`);
        return null;
      }
      // We stood right next to it; place only if it's now genuinely reachable+visible. If a mid-move
      // world change spoiled it, fall through to the next-nearest spot instead of forcing a timeout.
      if (!canPlaceFrom(bot, cell.floorVec)) continue;
    }

    const placed = await tryPlaceOn(bot, stationType, cell.floorVec);
    if (placed) { await registerFieldStation(bot, placed); return placed; }
    // Placement failed at a spot we could see and reach — mark tried, take the next-nearest.
  }

  watcher.warn(TAG, `exhausted ${MAX_PLACE_ATTEMPTS} place attempts for ${stationType} — replan`);
  return null;
}

// ── A STATION SET DOWN IS A STATION THAT STAYS, SO IT GOES ON THE RECORD ─────────────────────────────
// Architect 2026-09-07: *"placing a crafting table is a permanent thing. it registers it and everything.
// and any bot can use it after."* Before this, the table was placed, used and dug back up inside one
// craft book, so it never existed as far as the fleet was concerned and a row for it would have been a
// lie one minute later. A permanent block is a fact about the world, and Invariant C says a fact the
// fleet depends on is recorded where the fleet can read it.
//
// WHAT THE ROW ACTUALLY BUYS, since "so other bots can find it" is only half true: a field station has
// no blueprint, therefore no authored stance, therefore nothing can WALK to it (resolveVoxelAnchor
// answers null by design and callers must not improvise a stance). What the row does buy is the pocket
// credit — assessors/supply counts registered blueprint-less stations as stock the fleet already holds,
// so the board stops ordering a replacement table for one that is standing in a field. Without the row,
// every placement would post a fresh craft.
//
// NULL blueprint IS THE MEANING, NOT AN OMISSION: the tag is what separates a building's own station
// from one set down beside a body, and both the pocket credit and findStation's preference read it.
//
// A REFUSED REGISTRATION IS NOT A FAILED CRAFT, and this is the one place that differs from
// build_executor's identical-looking call. There, a station that will not register is a Law 13 crash,
// because preconstruction crafted exactly one chest and the build cannot proceed without it. Here the
// block is standing and usable whatever the registry says — the craft this table was placed for runs
// either way — so an unregistered table costs one redundant craft order later, and stopping the fleet
// over it would trade a real loss for a bookkeeping one (Law 25: report the shortfall, do not inflate it).
async function registerFieldStation(bot, block) {
  const diag = {};
  const win = await stationRegistry.openProofWindow(bot, block, diag);
  const result = stationRegistry.registerStation(block.position, block.name, win, null);
  if (win) {
    guardExternalSync(TAG, 'closeWindow after field registration', () => bot.closeWindow(win));
    await sleep(AFTER_PLACE_SLEEP_MS);
  }
  if (!result.ok) {
    watcher.warn(TAG, `${block.name}@(${block.position.x},${block.position.y},${block.position.z}) is standing but did not register (${result.reason}) — `
      + `it stays where it is and is usable; the cost is that the board may order a replacement it does not need. ${JSON.stringify(diag)}`);
  }
}

// THE TABLE IS NOT TAKEN BACK UP. `cleanupPlacedStations` stood here and was the whole of this file's
// station lifecycle: place a table, craft on it, dig it up, collect the drop. It is DELETED, on the
// Architect's ruling of 2026-09-07 — *"placing a crafting table is a permanent thing… i want to remove
// drop and dig logic and leave every crafting table as permanent and registered for other bots to use."*
//
// IT WAS NEVER A GENERAL CLEANUP, and knowing that is what makes the deletion safe rather than partial:
// the only station this route ever places is a crafting table, because ensureStation returns null for a
// furnace before any placement is attempted (smelting is furnace_executor's one pathway). So the ledger
// entry, the `cleanup` flag, the pickaxe equip and the dig were four pieces of machinery serving one
// block type, and removing the behaviour for that block type removes all of them. What remains of
// `placedStations` is a per-batch list of what this book set down, kept for the stale-cache eviction in
// ensureStation and for the `tables placed=` count.
//
// WHAT REPLACES IT IS THE REGISTRY ROW (registerFieldStation, above): the table stops being a private
// throwaway and becomes a fact the fleet holds, which is why it may be left standing at all.
//
// THE SAFETY NET IF ONE LANDS BADLY IS ALREADY BUILT AND STAYS: `crafting_table` is the single member of
// dig_authority's BREAKABLE_STATIONS, so a build that finds one in a cell its blueprint wants can clear
// it — that exemption was made for exactly this case and is now load-bearing rather than a convenience.
// The placement search avoids locked footprints up front (stationExclusionKeys), so the net should not be
// needed; both are kept because the search cannot see a site locked AFTER the table went down.

// SECTION 4 (smelting) removed: smelting is no longer synchronous here. It moved to the
// async furnace_executor load-and-leave chain (Law 16 — one pathway). craft_handler now only
// crafts at a crafting_table; a furnace step (charcoal/iron_ingot) is deferred to that chain
// (see the `stationType === 'furnace'` branch in craftWithSequence).

// ---------------------------------------------------------------------------
// SECTION 5 — Execution engine
// ---------------------------------------------------------------------------

// Sweep any residue out of the PLAYER crafting area — the cursor (selectedItem), the result slot
// (0), and the 2x2 grid (slots 1-4) — back into the main inventory. WHY this is mandatory:
// mineflayer's bot.craft collects the crafted item with a putAway/click sequence (craft.js
// grabResult) that can desync and leave the result on the CURSOR or in a grid slot.
// bot.inventory.count() counts only main+hotbar, so stranded output reads as 0 — the craft loop
// then sees no progress and spins until the portable judge escalates to a strict kill — and worse,
// the server EJECTS cursor/grid contents on disconnect (the "bot dropped a pile of planks on exit"
// the Architect saw). Reclaiming after every craft keeps the count honest and leaves nothing to
// drop; running it before is cheap insurance against residue a prior craft left. The cursor is
// cleared FIRST because putAway needs a free cursor to pick a slot up. Idempotent and near-free
// when the area is already clean; every step is wrapped so a stray click never fails the craft.
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

// locateCraftedItem — the TRUE count of an item, broken out by WHERE it sits. bot.inventory.count()
// sees only main+hotbar; a fresh craft can leave its output in the RESULT slot (0), the 2x2 grid
// (1-4), or on the CURSOR (selectedItem) — invisible to count(). That blind spot is the recurring
// "craft output not counted" bug (Architect): the torch lands in-hand/output, count() reads 0, the
// loop concludes it made nothing and re-crafts forever, burning ingredients until the judge halts.
// Completion is now verified against `total` (every location), so a stranded output still counts as
// made; the per-location split feeds the watcher so we can finally SEE where an output went — is it
// stranded (recoverable, sweep didn't stow it) or truly absent (grid-craft desync / real shortage).
// Same slot layout clearCraftingResidue already commits to (Law 16: one definition of that layout).
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

// THE STATION OUTLIVES THE ORDER, AND NOW THE BOOK AS WELL. `ctx` is the batch's shared workspace — the
// station context, the placed-station ledger and the metric counters — created ONCE per batch by
// `newCraftContext()`, not once per order: an order that arrives second finds the table already in
// `ctx.stationContext` and `ensureStation` returns it without a walk, a place or a verify.
//
// THE SECOND HALF ARRIVED 2026-09-07 AND IS WHAT MADE THE FIRST FULLY PAY. A table now stays standing
// when the book ends, so the batch context is no longer the outer boundary of a table's life — the world
// is. The next book re-finds it through the registry or the local scan and places nothing at all.
//
// THE ORIGINAL SHAPE AND WHY IT WAS WASTEFUL, since a reader may be tempted back toward it: two
// mechanisms, each correct alone, cancelled each other. `stationContext` lived for exactly one call, and
// a cleanup pass faithfully dug the table back up at the end of that call — so the next order's reuse
// scan found nothing, every time, by construction. Measured on `contractor_house`: anchor 0 has five
// craftable types and paid five full place-and-dig cycles to produce nine blocks. The cleanup pass is
// now deleted outright rather than merely deferred — see THE TABLE IS NOT TAKEN BACK UP above.
function newCraftContext() {
  return {
    stationContext: new Map(),
    placedStations: [],
    // NO SMELT COUNTERS HERE (Law 16, Law 25). Smelting has exactly one pathway and it is
    // furnace_executor's; this file defers a smeltable ingredient to the furnace chain and never
    // runs a furnace itself. A `smelt_ok` field on this object could therefore only ever report a
    // hardcoded 0 — an outcome signal whose reader cannot tell a constant from a measurement, and
    // one that reads as "no smelting happened" when it means "smelting is not this unit's verb."
    // A counter for a verb the unit does not own belongs to the unit that owns it, or nowhere.
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
    // The context now spans a whole order book instead of one order, and the checkpoint immediately
    // above is the reason that matters: combat can take the body over between orders and put it down
    // somewhere else entirely. A cached block that is no longer there, or no longer in arm's reach,
    // would be handed to `bot.craft` as the station and fail as a window timeout — a symptom several
    // steps removed from its cause. Two cheap reads settle it; on a miss the entry is dropped and the
    // normal scan/place path runs, which is exactly what would have happened before the cache existed.
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

    // Furnaces are handled entirely by furnace_executor now (Law 16 — smelting has ONE pathway,
    // the async load-and-leave chain). craft_handler never provides a furnace: any furnace-output
    // intermediate (charcoal, iron_ingot) must already be in inventory — produced by the furnace
    // chain on an earlier sweep — before a dependent craft runs here. If it isn't, the dependent
    // step's target check fails and the craft soft-fails to replan; job_board then posts the
    // furnace load. This is why ensureStation returns null for furnace instead of placing one.
    if (type === 'furnace') return null;

    let block = await tryScanNearbyStation(bot, type);
    let cleanup = false;
    if (block) {
      // THE BOOTSTRAP TABLE IS THE ONE STATION WITH NO ANCHOR, and the Architect named it himself when he
      // made the anchor the stance: *"since all chests and furnaces operate off of blueprints, with the
      // only exception being a temporary crafting table to boostrap the bot."* A table a bot sets down
      // beside itself and takes back has no blueprint and therefore no authored stand — so when
      // goToStationAnchor answers `no_anchor` NOTHING MOVES and the block is used where it stands, which
      // is legitimate precisely because a throwaway is within arm's reach by definition (placeStation
      // puts it on an adjacent cell, and the scan that found it swept only STATION_REACH). Any OTHER
      // reason — a real anchor this body could not reach — drops the block and lets the caller place its
      // own, rather than working a blueprint station from a stance nobody approved.
      const nav = await locomotion.goToStationAnchor({ x: block.position.x, y: block.position.y, z: block.position.z });
      if (!nav.arrived && nav.reason !== 'no_anchor') {
        watcher.warn(TAG, `${type} at ${block.position} has an anchor this body could not reach (${nav.reason}) — placing its own instead.`);
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

    block = await placeStation(bot, type);
    if (block) {
      cleanup = true;
      metrics.stations_placed++;
      stationContext.set(type, { block, cleanup });
      placedStations.push({ type, block, cleanup });
      return block;
    }

    // No reuse, no clear adjacent cell to place on. The old path here carved two
    // blocks out of the world by yaw-snap and placed blind — the 2 Jul run's #1
    // fragility (craft abandonment after "clearing space 2 blocks ahead"). Law 17
    // (no self-injury) + Architect: never dig to make room. Return null and let the
    // caller soft-fail to recursive_judge (Law 13/15) for a fresh plan from a spot
    // that has room.
    watcher.warn(TAG, `No station and no place spot for ${type} — soft-fail to replan`);
    return null;
  }

  // Start from a clean crafting area so residue a prior op stranded (cursor/grid) can't corrupt
  // this sequence's counts or drop on a later disconnect.
  await clearCraftingResidue(bot);

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
      // Smelting moved OUT of the synchronous craft path (Law 16 — one pathway: the async
      // furnace_executor load-and-leave chain). craft_handler can't produce a furnace output
      // here; the item must already be in inventory (a prior sweep's furnace collect). It
      // isn't (current < target above), so leave this step unmet — the final-count check
      // soft-fails the craft, and job_board posts a furnace load to make it. Nothing is counted
      // as a smelting failure here because nothing was attempted; this is a deferral, not a loss.
      watcher.warn(TAG, `${step.item} needs smelting — deferred to the furnace chain (not smelted synchronously)`);
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
      // NAME THE REAL CAUSE (Architect 2026-08-13). `recipesFor` filters by what the bot HOLDS, so an
      // empty list has two completely different meanings and this line used to report both as "no
      // recipe found" — which sent the 2026-08-12 furnace diagnosis chasing a missing recipe when the
      // fleet simply had no cobblestone. `recipesAll` ignores inventory, so it separates them: a recipe
      // that exists but cannot be filled is a MATERIALS shortage (environmental, restock and retry),
      // and a recipe that does not exist at all is a bad blueprint or a bad item name (a coding
      // violation the reader must not have to guess at). Reported, not thrown, because the caller's
      // final-count check already owns the soft-fail (Law 13, Law 25 — the verdict must be true).
      const known = bot.recipesAll(itemId, null, craftingStation);
      watcher.warn(TAG, (known && known.length > 0)
        ? `Cannot craft ${step.item} — the recipe exists but the ingredients are not in inventory`
        : `No recipe exists for ${step.item}${craftingStation ? ' even with a crafting table' : ''} — check the item name/blueprint`);
      continue;
    }
    const craftStart = locateCraftedItem(bot, itemId).total;
    while (locateCraftedItem(bot, itemId).total < target) {
      await combatCheckpoint(bot, 'craft');
      // Re-fetch the recipe EVERY batch (not captured once): recipesFor only returns a recipe the
      // bot can craft with what it holds RIGHT NOW, so this tracks a scarce input draining across
      // batches and picks whichever fuel (coal OR charcoal) is on hand this pass. An empty list mid-
      // run means the ingredients ran out — a normal shortage (charcoal is an async furnace output),
      // NOT a craft failure. Break cleanly: the step stays unmet, the final-count check soft-fails to
      // replan, and job_board restocks. This was the torch bug — the old code captured recipes[0]
      // once, then bot.craft threw 'missing ingredient' on the batch after charcoal hit 0, logging a
      // scary warn + a crafts_fail for what was really "made +4, need more charcoal" (Architect audit,
      // 2026-07-04).
      const batchRecipes = bot.recipesFor(itemId, null, null, craftingStation);
      if (!batchRecipes || batchRecipes.length === 0) {
        note(`${step.item}: ran out of ingredients at ${locateCraftedItem(bot, itemId).total}/${target} — restock needed (deferring to replan)`);
        break;
      }
      const recipe = batchRecipes[0];
      const beforeCraft = locateCraftedItem(bot, itemId).total;
      // Station-window instrumentation (Architect, long-run kill hunt): one dense line per craft
      // capturing exactly what the crafting window did — the station used, the open window's type,
      // how long bot.craft took, and on failure WHICH mineflayer event timed out (updateSlot:0 =
      // the server never sent the result-slot update). Emitted per-attempt (NOT via the note buffer)
      // on purpose: rising craft_ms across a run is the fingerprint of connection/tick degradation
      // vs. a one-off desync — the exact thing the trace couldn't show when the judge killed the bot.
      const stationDesc = craftingStation
        ? `table@(${craftingStation.position.x},${craftingStation.position.y},${craftingStation.position.z})`
        : '2x2-inventory';
      const winBefore = bot.currentWindow ? bot.currentWindow.type : 'none';
      const craftT0 = Date.now();
      const crafted = await guardExternal(TAG, `bot.craft ${step.item} @ ${stationDesc}`, async () => {
        await bot.craft(recipe, 1, craftingStation);
        await sleep(AFTER_PLACE_SLEEP_MS);
      });
      if (!crafted.ok) {
        watcher.warn(TAG, `WINDOW craft ${step.item} @ ${stationDesc} — bot.craft FAILED after ${Date.now() - craftT0}ms (win ${winBefore}→${bot.currentWindow ? bot.currentWindow.type : 'closed'})`);
        metrics.crafts_fail++;
        break;
      }
      metrics.crafts_ok++;
      watcher.summary(TAG, `WINDOW craft ${step.item} @ ${stationDesc} — bot.craft OK in ${Date.now() - craftT0}ms (win ${winBefore}→${bot.currentWindow ? bot.currentWindow.type : 'closed'})`);
      // Reclaim the crafted output from the cursor/grid/result slot into main inventory so nothing
      // ejects on disconnect and the item is actually usable by later fragments. Completion, though,
      // is now verified against locateCraftedItem().total — every place the output can land — NOT
      // main-inventory count alone. WHY this split matters: the recurring torch stall was a craft
      // whose 4 outputs sat in the result slot / on the cursor; count() read 0, the loop thought it
      // made nothing and re-crafted forever. Counting the total makes progress honest even on the
      // pass BEFORE the sweep stows the output; the watcher line below reveals whether the sweep is
      // failing (stranded>0 persistently) so we can inspect this closely (Architect: recurring bug).
      await clearCraftingResidue(bot);
      const loc = locateCraftedItem(bot, itemId);
      const afterCraft = loc.total;
      const stranded = loc.cursor + loc.result + loc.grid;
      if (stranded > 0) {
        watcher.warn(TAG, `craft output stranded off main-inventory: ${step.item} total=${loc.total}/${target} split[inv=${loc.inv} cursor=${loc.cursor} result=${loc.result} grid=${loc.grid}] — counted as made; clearCraftingResidue did not fully stow it (recurring craft-output bug, inspect here).`);
      }
      // No-op safety net (Law 13). The TOTAL (all locations) did not rise while ingredients drained —
      // so the output genuinely never materialized (missing recipe result, full inventory, or a craft
      // desync that destroyed it), not a mere off-inventory stranding, which the total now sees.
      // Unchecked, the loop would re-craft and burn ingredients each pass until the portable judge
      // escalates forgiving→STRICT and kills the signal. Break on the FIRST no-op: the step stays
      // unmet, the final-count check soft-fails to a normal replan, and we log the WHY (Law 14).
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
  // Count the final item everywhere (same reason as the loop): the final sweep above SHOULD have
  // stowed the last batch, but if it didn't, main-inventory count alone would under-report a craft
  // that actually succeeded and soft-fail a completed job. The total is the honest verdict; a lingering
  // stranded>0 already warned above so the residue failure is on the record either way.
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
  const signalBus = require('@kernel/signal_bus');
  routeToJudge(signalBus, TAG, { result: TAG, success: false, readable: `${TAG}: ${reason}` });
}

// ---------------------------------------------------------------------------
// SECTION 7 — Public API
// ---------------------------------------------------------------------------

// ── THE ORDER BOOK IS THE UNIT OF WORK, NOT THE ORDER ───────────────────────────────────────────────
// `craftBatch` is the one implementation (Law 16) and `craftItems` is a one-line order book on top of
// it, so a single-item caller and a five-item caller run the identical machine. That is what makes the
// saving arrive for everyone rather than for whichever fragment happened to be rewritten: the batching
// lives in crafting, not in the caller.
//
// WHAT IS SHARED AND WHAT IS NOT. Shared across the batch: the crafting table (one walk, one place, one
// dig), the phase-note buffer, and the running counters. NOT shared: resolution. Each order is expanded
// by `resolveBlueprint` on its own, against inventory as it stands at that moment, and executed on its
// own sequence.
//
// **Resolution is deliberately NOT merged, and this is the part a later reader will want to "improve".**
// A step's `target` is an ABSOLUTE desired total, not a delta (see this file's invariants). Merging two
// orders that share an ingredient therefore cannot be done by concatenating their sequences and letting
// the `current >= target` skip fire: two orders each needing four planks produce `planks:4` twice, the
// second is skipped as already satisfied, and the first order's consumer has meanwhile eaten them — so
// the second consumer starves with a plan that read as complete. Nor can the resolver simply share its
// `visited` set across targets, which would drop the shared ingredient from the second plan entirely.
// Resolving per order and re-reading inventory each time is what keeps the absolute semantics honest.
// The ORDERING problem that creates (make the consumers before the base intermediates they eat) belongs
// to the caller who knows what it is staging — preconstruction sorts its list for exactly that reason.
//
// EVERY ORDER GETS ITS TURN. A failed order does not end the batch — *"it should attempt to craft
// everything on the list it can craft"* — so the loop records the verdict and moves on. The single
// exception is a portable-judge escalation, which is the judge saying this body has stopped making
// progress at all; continuing past it would be arguing with the referee.
async function craftBatch(bot, orders, payload, { allowPartial = false } = {}) {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error(`[${TAG}] CODING VIOLATION (Law 13): craftBatch needs a non-empty order list. Got: ${JSON.stringify(orders)}`);
  }
  for (const o of orders) {
    if (!o || typeof o.item !== 'string' || !Number.isFinite(o.quantity) || o.quantity < 1) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): every craftBatch order needs {item:string, quantity:>=1}. Got: ${JSON.stringify(o)}`);
    }
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

    // Snapshot inventory at THIS order's entry so its no-op guard and its `made` count describe this
    // order and not the batch. Taken per order rather than once up front precisely because an earlier
    // order may have produced the very item (or consumed the ingredient) this one is about to weigh.
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
      // Material is never withheld from a craft that can use it, so a craft that runs out of an
      // ingredient half way is the NORMAL end of a pull chain rather than a failure: two charcoal
      // against an order for thirty-two torches means eight torches and an honest shortfall, not
      // nothing.
      //
      // WHO DECIDES WHETHER THAT IS ENOUGH IS THE WHOLE POINT (Law 25 — the asker owns the criterion,
      // the performer owns reporting it truthfully). This function cannot know: a supply row is
      // topping a bot up and a short delivery is real progress it keeps, while preconstruction stages
      // an anchor all-or-nothing because a part-load makes it craft against itself and abandon
      // mid-stage. So the bar arrives WITH the request as `allowPartial`, and every caller that does
      // not pass it keeps the all-or-nothing outcome unchanged. Defaulting it on would silently relax
      // two callers whose criterion is stricter — criteria-usurpation wearing the mask of a fix.
      //
      // NO SUCCESS FLAG ON A SHORTFALL: `success` stays false and `partial` carries the true counts.
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

  // NOTHING IS TAKEN BACK UP HERE. A cleanup pass stood at this line and returned the book's table to
  // the pocket; the table is permanent now and the pass is deleted — the reasoning is where it used to
  // live, above `newCraftContext`.

  const notes = _phaseNotes || [];
  _phaseNotes = null;
  const detail = notes.length ? notes.join(' · ') : 'no work';

  // A batch succeeds only if every order in it did. A caller that accepts partials gets the same
  // relaxation it always did, now applied to the book: every order either met its target or made
  // something toward it.
  const met = (r) => r.success || (allowPartial && r.partial);
  const batchSuccess = !escalated && results.length === orders.length && results.every(met);
  const shortList = results.filter(r => !met(r))
    .map(r => `${r.item} ${r.finalCount}/${r.requiredFinal}`).join(', ');
  const bookLine = results.map(r => {
    if (r.success) return `${r.item} x${r.quantity} ✓`;
    if (r.partial) return `${r.item} x${r.quantity} partial +${r.made} short ${r.shortfall}`;
    return `${r.item} x${r.quantity} FAILED ${r.finalCount}/${r.requiredFinal}`;
  }).join(' | ');

  // ONE consolidated summary for the whole craft phase (Law 5). `tables` is the number that says
  // whether the shared station actually held: one place for a five-order book is the win; five is the
  // old behaviour leaking back through some path that drops the context.
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

  // `success` is measured against the CALLER'S criterion (`allowPartial`), so it can be true over a
  // book that contains a short order. `all_filled` is criterion-free and says whether every order
  // actually met its number — the two are separated because a reader that only ever sees `success`
  // would have no way to tell "filled" from "accepted as short" (Law 25). Per-order truth is in
  // `results`, always.
  return {
    success: true,
    all_filled: results.every(r => r.success),
    results,
    metrics: ctx.metrics,
    orders: orders.length,
  };
}

// The single-order front door, unchanged in contract. Every existing caller keeps its exact return
// shape — including the `undefined` on abandonment and the `partial` object — because a batch of one
// resolves, executes and reports identically to the way it always did (Law 16: one implementation, and
// this is the thin one).
async function craftItems(bot, targetItem, quantity, payload, { allowPartial = false } = {}) {
  const qty = Math.max(1, Number(quantity) || 1);
  const batch = await craftBatch(bot, [{ item: targetItem, quantity: qty }], payload, { allowPartial });
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
  // Reached only with allowPartial — craftBatch abandons on anything else.
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

module.exports = { craftItems, craftBatch, placeStation, PLANK_DERIVED_GROUPS, resolveGroupItem };
